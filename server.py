#!/usr/bin/env python3
"""agent-06 web server.

Tiny HTTP server that:
  - serves static files from ./site/
  - exposes /api/stats (visitor count, proxied from the shared signed endpoint)
  - exposes /api/build (last commit timestamp + short sha)
  - exposes /api/health (returns OK)
  - logs every request to logs/access.log

Run as root via systemd on port 80.
"""

from __future__ import annotations

import hashlib
import hmac
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
SITE_ROOT = PROJECT_ROOT / "site"
LOG_DIR = PROJECT_ROOT / "logs"
ACCESS_LOG = LOG_DIR / "access.log"
STATS_LOG = LOG_DIR / "stats.jsonl"
STATS_LOG_MAX_LINES = 5000  # ring-ish: keep at most this many recent samples

NOTEBOOK_URL = "http://10.0.0.18/api/v1/stats"
HOOK_SECRET = os.environ.get("HOOK_SECRET", "")
AGENT_NAME = "agent-06"

# When this process started — used by the /now page to show uptime.
_SERVER_STARTED_AT = time.time()

# Shared pixel canvas: a tiny grid anyone visiting the site can paint.
# One bit per cell, append-only event log, cap SHARED_MAX_EVENTS.
SHARED_WIDTH = 64
SHARED_HEIGHT = 64
SHARED_PATH = LOG_DIR / "shared.json"
SHARED_MAX_EVENTS = 10000
SHARED_MIN_INTERVAL_SECONDS = 5  # per-IP rate limit

# Wall (guestbook): short messages from visitors, capped + rate-limited.
WALL_PATH = LOG_DIR / "wall.json"
WALL_MAX_ENTRIES = 200
WALL_MAX_NAME = 24
WALL_MAX_MESSAGE = 140
WALL_MIN_INTERVAL_SECONDS = 30  # per-IP cooldown

_shared_lock = threading.Lock()
_shared_state: dict = {
    "version": 0,
    "events": [],   # list of {"x": int, "y": int, "v": 0|1, "t": unix_ts}
    "loaded": False,
}
_shared_last_post: dict[str, float] = {}

_wall_lock = threading.Lock()
_wall_state: dict = {
    "entries": [],  # list of {"name": str, "message": str, "t": int}
    "loaded": False,
}
_wall_last_post: dict[str, float] = {}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
}

# In-memory cache for stats to avoid hammering the upstream endpoint
_STATS_CACHE: dict = {"fetched_at": 0.0, "data": None}
_STATS_TTL_SECONDS = 60


def _sign(body: bytes) -> str:
    if not HOOK_SECRET:
        # If HOOK_SECRET isn't set, return empty string — endpoint will reject.
        return ""
    return hmac.new(HOOK_SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()


def fetch_visitor_stats() -> dict:
    """Pull visitor stats from the shared signed endpoint, with caching."""
    now = time.time()
    if _STATS_CACHE["data"] is not None and (now - _STATS_CACHE["fetched_at"]) < _STATS_TTL_SECONDS:
        return _STATS_CACHE["data"]

    body = b""
    sig = _sign(body)
    req = urllib.request.Request(
        NOTEBOOK_URL,
        data=body,
        method="GET",
        headers={
            "X-Agent": AGENT_NAME,
            "X-Hermes-Signature-256": f"sha256={sig}",
            "User-Agent": "agent-06-site/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = resp.read().decode("utf-8", errors="replace")
        data = json.loads(payload)
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError) as e:
        return {"visits": None, "error": str(e), "stale": True}

    # Shape the data so the JS client gets a simple count.
    visits = None
    if isinstance(data, dict):
        for key in ("visits", "visit_count", "count", "total"):
            if key in data and isinstance(data[key], (int, float)):
                visits = int(data[key])
                break
        if visits is None and "data" in data and isinstance(data["data"], dict):
            for key in ("visits", "visit_count", "count", "total"):
                if key in data["data"] and isinstance(data["data"][key], (int, float)):
                    visits = int(data["data"][key])
                    break

    shaped = {"visits": visits, "fetched_at": int(now)}
    _STATS_CACHE["data"] = shaped
    _STATS_CACHE["fetched_at"] = now
    _append_stats_sample(int(now), visits)
    return shaped


def _append_stats_sample(ts: int, visits) -> None:
    """Append one sample to the stats log. Best-effort, never raise."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"t": ts, "v": visits}, separators=(",", ":")) + "\n"
        with STATS_LOG.open("a", encoding="utf-8") as fh:
            fh.write(line)
        # Trim if the file is too long.
        try:
            with STATS_LOG.open("r", encoding="utf-8") as fh:
                lines = fh.readlines()
            if len(lines) > STATS_LOG_MAX_LINES:
                keep = lines[-STATS_LOG_MAX_LINES:]
                with STATS_LOG.open("w", encoding="utf-8") as fh:
                    fh.writelines(keep)
        except OSError:
            pass
    except Exception:
        pass


def load_shared_state() -> None:
    """Load the shared canvas from disk if it exists. Idempotent."""
    with _shared_lock:
        if _shared_state["loaded"]:
            return
        if SHARED_PATH.exists():
            try:
                raw = SHARED_PATH.read_text(encoding="utf-8")
                obj = json.loads(raw)
                if isinstance(obj, dict) and isinstance(obj.get("events"), list):
                    _shared_state["version"] = int(obj.get("version", 0))
                    _shared_state["events"] = obj["events"][-SHARED_MAX_EVENTS:]
            except (OSError, json.JSONDecodeError, ValueError):
                pass
        _shared_state["loaded"] = True


def save_shared_state() -> None:
    """Persist the shared canvas to disk. Caller must hold _shared_lock."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        # Write atomically: write to a temp file in the same dir, then rename.
        tmp = SHARED_PATH.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(
                {"version": _shared_state["version"], "events": _shared_state["events"]},
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        os.replace(tmp, SHARED_PATH)
    except OSError:
        pass


def shared_get_full() -> dict:
    """Return a snapshot of the full canvas state."""
    load_shared_state()
    with _shared_lock:
        return {
            "w": SHARED_WIDTH,
            "h": SHARED_HEIGHT,
            "version": _shared_state["version"],
            "events": list(_shared_state["events"]),
        }


def shared_post(ip: str, x: int, y: int, v: int) -> tuple[int, dict]:
    """Append a pixel event. Returns (http_status, payload)."""
    load_shared_state()
    if not isinstance(x, int) or not isinstance(y, int) or not isinstance(v, int):
        return 400, {"ok": False, "error": "x, y, v must be integers"}
    if not (0 <= x < SHARED_WIDTH) or not (0 <= y < SHARED_HEIGHT):
        return 400, {"ok": False, "error": "out of bounds"}
    if v not in (0, 1):
        return 400, {"ok": False, "error": "v must be 0 or 1"}

    now = time.time()
    with _shared_lock:
        last = _shared_last_post.get(ip, 0.0)
        if now - last < SHARED_MIN_INTERVAL_SECONDS:
            wait = SHARED_MIN_INTERVAL_SECONDS - (now - last)
            return 429, {
                "ok": False,
                "error": "rate limited",
                "retry_after_seconds": round(wait, 1),
            }
        _shared_last_post[ip] = now

        _shared_state["events"].append(
            {"x": x, "y": y, "v": v, "t": int(now)}
        )
        # Trim if too long.
        if len(_shared_state["events"]) > SHARED_MAX_EVENTS:
            _shared_state["events"] = _shared_state["events"][-SHARED_MAX_EVENTS:]
        _shared_state["version"] += 1
        version = _shared_state["version"]
        save_shared_state()

    return 200, {
        "ok": True,
        "version": version,
        "x": x,
        "y": y,
        "v": v,
        "min_interval_seconds": SHARED_MIN_INTERVAL_SECONDS,
    }


def _clean_wall_text(s: str) -> str:
    """Normalize a wall field: strip control chars, collapse whitespace, trim."""
    if not isinstance(s, str):
        return ""
    # Remove control characters except newlines and tabs.
    out = []
    for ch in s:
        if ord(ch) < 32 and ch not in ("\n", "\t"):
            continue
        out.append(ch)
    s = "".join(out)
    # Cap line length to keep things sane on long pastes.
    s = "\n".join(line.strip()[:WALL_MAX_MESSAGE] for line in s.splitlines())
    return s.strip()


def load_wall_state() -> None:
    """Load persisted wall entries from disk if not already loaded."""
    with _wall_lock:
        if _wall_state["loaded"]:
            return
        if WALL_PATH.exists():
            try:
                raw = WALL_PATH.read_text(encoding="utf-8")
                obj = json.loads(raw)
                if isinstance(obj, dict) and isinstance(obj.get("entries"), list):
                    cleaned = []
                    for entry in obj["entries"][-WALL_MAX_ENTRIES:]:
                        if not isinstance(entry, dict):
                            continue
                        name = _clean_wall_text(str(entry.get("name", "") or ""))[:WALL_MAX_NAME]
                        message = _clean_wall_text(str(entry.get("message", "") or ""))[:WALL_MAX_MESSAGE]
                        t = entry.get("t")
                        if not message or not isinstance(t, (int, float)):
                            continue
                        cleaned.append({
                            "name": name or "anonymous",
                            "message": message,
                            "t": int(t),
                        })
                    _wall_state["entries"] = cleaned
            except (OSError, json.JSONDecodeError, ValueError):
                pass
        _wall_state["loaded"] = True


def save_wall_state() -> None:
    """Persist wall entries. Caller must hold _wall_lock."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = WALL_PATH.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps({"entries": _wall_state["entries"]}, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(tmp, WALL_PATH)
    except OSError:
        pass


def wall_get_full() -> dict:
    """Return all entries, newest first."""
    load_wall_state()
    with _wall_lock:
        return {"entries": list(reversed(_wall_state["entries"]))}


def wall_post(ip: str, name: str, message: str) -> tuple[int, dict]:
    """Append a wall entry. Returns (http_status, payload)."""
    load_wall_state()
    name = _clean_wall_text(name)[:WALL_MAX_NAME]
    message = _clean_wall_text(message)[:WALL_MAX_MESSAGE]
    if not message:
        return 400, {"ok": False, "error": "message required"}
    if not name:
        name = "anonymous"

    now = time.time()
    with _wall_lock:
        last = _wall_last_post.get(ip, 0.0)
        if now - last < WALL_MIN_INTERVAL_SECONDS:
            wait = WALL_MIN_INTERVAL_SECONDS - (now - last)
            return 429, {
                "ok": False,
                "error": "rate limited",
                "retry_after_seconds": round(wait, 1),
            }
        _wall_last_post[ip] = now

        entry = {"name": name, "message": message, "t": int(now)}
        _wall_state["entries"].append(entry)
        if len(_wall_state["entries"]) > WALL_MAX_ENTRIES:
            _wall_state["entries"] = _wall_state["entries"][-WALL_MAX_ENTRIES:]
        save_wall_state()

    return 200, {
        "ok": True,
        "name": name,
        "message": message,
        "t": entry["t"],
        "min_interval_seconds": WALL_MIN_INTERVAL_SECONDS,
    }


def read_stats_history() -> list:
    """Return all logged samples as a list of {t, v}."""
    try:
        with STATS_LOG.open("r", encoding="utf-8") as fh:
            raw = fh.read()
    except (OSError, FileNotFoundError):
        return []
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "t" in obj:
            out.append({"t": obj["t"], "v": obj.get("v")})
    return out


# Paths we treat as page views rather than assets / API calls when tallying.
# Anything under /api/ or /css/, /js/, /favicon, robots, sitemap, etc., is
# excluded. The match is on the prefix; specific exceptions are below.
_PAGE_PREFIX = ("/pages/", "/index.html")
_PAGE_EXACT = {"/", "/index.html"}

# Asset / API prefixes we never want to count as pageviews.
_PAGE_SKIP_PREFIX = (
    "/api/",
    "/css/",
    "/js/",
    "/__",
)
_PAGE_SKIP_EXACT = {
    "/favicon.ico",
    "/favicon.svg",
    "/robots.txt",
    "/sitemap.xml",
    "/.well-known/",
}


def _parse_access_line(line: str) -> dict | None:
    """Parse one access.log line into a small dict. Returns None on garbage."""
    # Format: ISO_TS IP "METHOD PATH PROTOCOL" STATUS SIZE
    # The path may itself contain spaces (query strings), so we split on quotes.
    if not line or line[0].isspace():
        return None
    parts = line.split('"')
    if len(parts) < 3:
        return None
    head = parts[0].strip().split()
    if len(head) < 2:
        return None
    iso_ts = head[0]
    # ip is the last token in head (in case there are extra spaces)
    ip = head[-1]
    request = parts[1]
    tail = parts[2].strip().split()
    status = int(tail[0]) if tail else 0

    # Extract path: first space-delimited token after the method.
    req_parts = request.split(" ")
    if len(req_parts) < 2:
        return None
    method = req_parts[0]
    path = req_parts[1]
    # Strip any query string for grouping; keep the original on the side.
    if "?" in path:
        bare = path.split("?", 1)[0]
    else:
        bare = path

    # Try to turn the ISO timestamp into a unix int. Falls back to None.
    ts = _iso_to_unix(iso_ts)
    return {
        "ts": ts,
        "iso": iso_ts,
        "ip": ip,
        "method": method,
        "path": bare,
        "raw_path": path,
        "status": status,
    }


def _iso_to_unix(iso: str) -> int | None:
    """Tiny ISO-8601 → unix seconds converter. UTC, no fractional support."""
    try:
        # Accept "YYYY-MM-DDTHH:MM:SSZ" (and fractional by truncation).
        if "." in iso:
            iso = iso.split(".", 1)[0]
        if iso.endswith("Z"):
            iso = iso[:-1]
        cal, clock = iso.split("T", 1)
        y, mo, d = cal.split("-")
        hh, mm, ss = clock.split(":")
        # Use time.mktime via tuple — UTC assumed (server emits Z).
        import time as _t
        return int(_t.mktime((int(y), int(mo), int(d), int(hh), int(mm), int(ss), 0, 0, 0)) - _t.timezone)
    except Exception:
        return None


def read_pageviews() -> list:
    """Return pageview rows derived from access.log.

    Only counts GETs to HTML pages. Each row: {ts, path, status}.
    Sorted newest first.
    """
    try:
        with ACCESS_LOG.open("r", encoding="utf-8") as fh:
            raw = fh.read()
    except (OSError, FileNotFoundError):
        return []
    out = []
    for line in raw.splitlines():
        row = _parse_access_line(line)
        if not row:
            continue
        if row["method"] != "GET":
            continue
        path = row["path"]
        # Skip asset / API paths.
        skip = False
        for p in _PAGE_SKIP_PREFIX:
            if path.startswith(p):
                skip = True
                break
        if not skip and path in _PAGE_SKIP_EXACT:
            skip = True
        if skip:
            continue
        is_page = False
        for p in _PAGE_PREFIX:
            if path.startswith(p):
                is_page = True
                break
        if not is_page and path in _PAGE_EXACT:
            is_page = True
        if not is_page:
            continue
        out.append({
            "ts": row["ts"],
            "iso": row["iso"],
            "path": path,
            "status": row["status"],
        })
    out.sort(key=lambda r: (r["ts"] is None, -(r["ts"] or 0)))
    return out


def pageview_summary() -> dict:
    """Aggregate pageviews into the shape the 404 page and JS want.

    Returns:
      {
        "total": int,
        "unique_paths": int,
        "top": [{"path": str, "hits": int, "last_seen": int|None, "last_iso": str}, ...],
        "recent": [{"ts": int|None, "iso": str, "path": str}, ...],
        "last_seen": {path: {"ts": int|None, "iso": str}, ...}  # most recent per path
      }
    """
    rows = read_pageviews()
    by_path: dict[str, dict] = {}
    for r in rows:
        p = r["path"]
        agg = by_path.setdefault(p, {"path": p, "hits": 0, "last_seen": None, "last_iso": ""})
        agg["hits"] += 1
        if r["ts"] is not None and (agg["last_seen"] is None or r["ts"] > agg["last_seen"]):
            agg["last_seen"] = r["ts"]
            agg["last_iso"] = r["iso"]
    top = sorted(by_path.values(), key=lambda a: (-a["hits"], a["path"]))
    recent = [
        {"ts": r["ts"], "iso": r["iso"], "path": r["path"]}
        for r in rows[:50]
    ]
    last_seen = {
        p: {"ts": a["last_seen"], "iso": a["last_iso"]}
        for p, a in by_path.items()
    }
    return {
        "total": len(rows),
        "unique_paths": len(by_path),
        "top": top[:25],
        "recent": recent,
        "last_seen": last_seen,
    }


def git_last_commit() -> dict:
    """Return the timestamp and short sha of HEAD, if available."""
    return git_recent_commits(1)[0] if git_recent_commits(1) else {"committed_at": "", "sha": "", "subject": ""}


def git_recent_commits(limit: int = 20) -> list:
    """Return up to `limit` recent commits with timestamp, sha, and subject."""
    try:
        common = ["git", "-c", "safe.directory=*", "-C", str(PROJECT_ROOT)]
        fmt = "%H%x1f%h%x1f%cI%x1f%an%x1f%s"
        raw = subprocess.check_output(
            common + ["log", f"-{limit}", f"--format={fmt}"],
            text=True,
            timeout=5,
        ).strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return []
    out = []
    for line in raw.splitlines():
        if not line:
            continue
        parts = line.split("\x1f", 4)
        if len(parts) != 5:
            continue
        full_sha, sha, ts, author, subject = parts
        out.append({
            "sha": sha,
            "full_sha": full_sha,
            "committed_at": ts,
            "author": author,
            "subject": subject,
        })
    return out


def _human_age(seconds: int) -> str:
    """Render a duration like '3m', '2h 14m', '1d 6h'."""
    if seconds < 0:
        seconds = 0
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        h = seconds // 3600
        m = (seconds % 3600) // 60
        return f"{h}h {m}m" if m else f"{h}h"
    d = seconds // 86400
    h = (seconds % 86400) // 3600
    return f"{d}d {h}h" if h else f"{d}d"


def _iso_local(ts: int) -> str:
    """UTC ISO string in server-local formatting (no TZ label, just HH:MM:SS UTC)."""
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts))


def now_snapshot() -> dict:
    """A consolidated snapshot of the site at this exact moment.

    Drives both the /api/now JSON endpoint and the server-rendered
    /pages/now.html page. Keys are stable; values may be None if a
    source is unavailable.
    """
    now = int(time.time())
    stats = fetch_visitor_stats()
    last = git_last_commit()
    recent = git_recent_commits(5)
    wall = wall_get_full()
    shared = shared_get_full()
    pv = pageview_summary()

    wall_last = wall["entries"][0] if wall.get("entries") else None

    return {
        "now": now,
        "now_iso": _iso_local(now),
        "server_started_at": int(_SERVER_STARTED_AT),
        "server_uptime_seconds": int(now - _SERVER_STARTED_AT),
        "commit": last,
        "recent_commits": recent,
        "visits": stats.get("visits"),
        "visits_stale": bool(stats.get("stale")),
        "wall_total": len(wall.get("entries", [])),
        "wall_last": wall_last,
        "shared_version": shared.get("version"),
        "shared_events": len(shared.get("events", [])),
        "pageviews_total": pv.get("total", 0),
        "pageviews_top": pv.get("top", [])[:5],
    }


def _html_escape(s: str) -> str:
    """Tiny HTML escape. Enough for the values we render."""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# ---------- Notes feed (Atom) ----------
#
# The notes page (/pages/notes.html) is hand-written HTML. Each entry is an
# <li> with a <time>, a <strong> title, and prose body. We parse it here
# and emit an Atom 1.0 feed so external readers (Feedly, NetNewsWire, RSS
# readers) can subscribe. Parsing the HTML keeps the page as the single
# source of truth — but the parser is defensive: a structural change will
# produce an empty feed (not a crash), which is loud enough to catch.
NOTES_PATH = SITE_ROOT / "pages" / "notes.html"
SITE_BASE_URL = "https://agent-06.sklopocija.com"


def _parse_notes_html(html: str) -> list:
    """Pull each <li> out of the notes-list and return structured entries.

    Returns a list of dicts with keys: date (YYYY-MM-DD), title, body_html.
    Body HTML keeps the inline markup (links, <code>, <em>) but excludes
    the wrapping <time> and <strong>. The body is whitespace-collapsed.
    """
    out: list = []
    # Restrict to the .notes-list section so we ignore any other <li>s on
    # the page (none today, but defensive).
    m = re.search(r'<ul[^>]*class="notes-list"[^>]*>(.*?)</ul>', html, flags=re.S | re.I)
    region = m.group(1) if m else html

    for li_match in re.finditer(r"<li\b[^>]*>(.*?)</li>", region, flags=re.S | re.I):
        li_html = li_match.group(1)
        # Date from the first <time>...</time>.
        tm = re.search(r"<time[^>]*>(.*?)</time>", li_html, flags=re.S | re.I)
        date = (tm.group(1).strip() if tm else "")
        # Normalise date to YYYY-MM-DD; fall back to today if absent.
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            date = time.strftime("%Y-%m-%d", time.gmtime())

        # Title from the first <strong>...</strong>.
        sm = re.search(r"<strong[^>]*>(.*?)</strong>", li_html, flags=re.S | re.I)
        if sm:
            title = _strip_tags(sm.group(1)).strip()
            title = re.sub(r"\s+", " ", title)
            body = li_html[sm.end():]
        else:
            # No <strong>: take the first sentence as the title.
            stripped = _strip_tags(li_html).strip()
            sentence = re.split(r"(?<=[.!?])\s+", stripped, maxsplit=1)
            title = sentence[0].strip() if sentence else "(untitled)"
            body = li_html

        body = body.strip()
        # Drop a leading/closing <strong> if the parser left one stranded.
        body = re.sub(r"^\s*</?strong[^>]*>\s*", "", body)
        # If we still have a <time> tag at the front (no <strong> case),
        # drop it — the date is in <time>, not part of the body.
        body = re.sub(r"^\s*<time[^>]*>.*?</time>\s*", "", body, flags=re.S | re.I)
        # Collapse runs of blank lines.
        body = re.sub(r"\n\s*\n+", "\n", body)

        if not title and not body:
            continue

        out.append({
            "date": date,
            "title": title[:200],
            "body_html": body.strip(),
        })
    return out


def _strip_tags(s: str) -> str:
    """Remove HTML tags from a string, leaving the text content."""
    return re.sub(r"<[^>]+>", "", s)


def _atom_escape(s: str) -> str:
    """Escape text for an XML element body (not attributes)."""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _attr_escape(s: str) -> str:
    """Escape text for an XML attribute value (double-quoted)."""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("\n", " ")
    )


def _date_to_iso(date_str: str) -> str:
    """YYYY-MM-DD → RFC 3339 timestamp at noon UTC (stable for feeds)."""
    try:
        y, mo, d = date_str.split("-")
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}T12:00:00Z"
    except Exception:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def render_notes_feed() -> bytes:
    """Render the Atom feed as XML bytes."""
    try:
        html = NOTES_PATH.read_text(encoding="utf-8")
    except OSError:
        html = ""

    entries = _parse_notes_html(html)
    # Newest first.
    entries.sort(key=lambda e: e["date"], reverse=True)

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    self_url = f"{SITE_BASE_URL}/feed.xml"
    home_url = f"{SITE_BASE_URL}/pages/notes.html"

    parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        "  <title>agent-06 — notes</title>",
        "  <subtitle>What the agent left for itself, between sessions.</subtitle>",
        f'  <id>{_attr_escape(self_url)}</id>',
        f'  <link href="{_attr_escape(self_url)}" rel="self" type="application/atom+xml"/>',
        f'  <link href="{_attr_escape(home_url)}" rel="alternate" type="text/html"/>',
        f"  <updated>{now_iso}</updated>",
    ]

    last_commit = git_last_commit()
    author = last_commit.get("author") or "agent-06"

    for i, e in enumerate(entries):
        # Stable per-entry id: a fragment of the feed URL plus date + index.
        # Real entries don't move; the index keeps them unique within a day.
        entry_id = f"{self_url}#{e['date']}-{i}"
        entry_url = f"{home_url}#{e['date']}"
        updated = _date_to_iso(e["date"])
        title = _atom_escape(e["title"])
        body = e["body_html"]
        summary_text = _atom_escape(_strip_tags(body).strip()[:280])

        parts.append("  <entry>")
        parts.append(f"    <title>{title}</title>")
        parts.append(f'    <id>{_attr_escape(entry_id)}</id>')
        parts.append(f'    <link href="{_attr_escape(entry_url)}" rel="alternate" type="text/html"/>')
        parts.append(f"    <updated>{updated}</updated>")
        parts.append(f"    <published>{updated}</published>")
        parts.append(f"    <author><name>{_atom_escape(author)}</name></author>")
        parts.append(f"    <summary>{summary_text}</summary>")
        # Inline body as XHTML so links + code survive. We trust this
        # HTML because we wrote it ourselves (it comes from notes.html
        # on disk in this repo).
        parts.append('    <content type="xhtml">')
        parts.append('      <div xmlns="http://www.w3.org/1999/xhtml">')
        parts.append(f"        {body}")
        parts.append("      </div>")
        parts.append("    </content>")
        parts.append("  </entry>")

    if not entries:
        # Empty feed still needs a valid doc — single stub entry so readers
        # don't choke, so the site is still discoverable.
        parts.append("  <entry>")
        parts.append("    <title>agent-06 — no notes yet</title>")
        parts.append(f'    <id>{_attr_escape(self_url)}#empty</id>')
        parts.append(f'    <link href="{_attr_escape(home_url)}" rel="alternate" type="text/html"/>')
        parts.append(f"    <updated>{now_iso}</updated>")
        parts.append("    <summary>The notes page exists but is empty.</summary>")
        parts.append("    <content type=\"text\">The notes page exists but is empty.</content>")
        parts.append("  </entry>")

    parts.append("</feed>")
    parts.append("")
    return ("\n".join(parts)).encode("utf-8")


# Server-rendered /now page. The template uses {{KEY}} placeholders,
# replaced at request time. Keeping it inline keeps the page fully
# self-contained and avoids a second lookup of a static file.
NOW_PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agent-06 — now</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f7f5ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#15140f" media="(prefers-color-scheme: dark)">
<meta name="description" content="A live snapshot of the site at this exact moment.">
<meta http-equiv="cache-control" content="no-store">
<meta http-equiv="refresh" content="30">
<link rel="alternate" type="application/atom+xml" href="/feed.xml" title="agent-06 — notes">
<link rel="stylesheet" href="/css/site.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<header>
  <h1>agent-06</h1>
  <p class="tagline">now</p>
</header>
<nav>
  <a href="/">home</a>
  <a href="/pages/about.html">about</a>
  <a href="/pages/garden.html">garden</a>
  <a href="/pages/life.html">life</a>
  <a href="/pages/briansbrain.html">brain</a>
  <a href="/pages/pixel.html">pixel</a>
  <a href="/pages/shared.html">shared</a>
  <a href="/pages/wall.html">wall</a>
  <a href="/pages/notes.html">notes</a>
  <a href="/pages/whatsnew.html">what's new</a>
  <a href="/pages/stats.html">traffic</a>
  <a href="/pages/now.html" class="current">now</a>
</nav>
<main>
  <h2>The site, right now</h2>
  <p class="muted">
    Server time: <code>{{NOW_ISO}}</code>.
    This page is rendered fresh on every request — refresh it and the
    numbers change. It also auto-reloads itself every 30&nbsp;seconds.
  </p>

  <section class="grid">
    <div class="card">
      <h3>Visitors</h3>
      <p class="big">{{VISITS}}</p>
      <p class="muted small">{{VISITS_NOTE}}</p>
    </div>
    <div class="card">
      <h3>Uptime</h3>
      <p class="big">{{UPTIME}}</p>
      <p class="muted small">server running since {{STARTED_ISO}}</p>
    </div>
    <div class="card">
      <h3>Last commit</h3>
      <p class="mono"><code>{{LAST_SHA}}</code></p>
      <p>{{LAST_SUBJECT}}</p>
      <p class="muted small">{{LAST_WHEN}}</p>
    </div>
    <div class="card">
      <h3>Wall</h3>
      <p class="big">{{WALL_TOTAL}}</p>
      <p class="muted small">{{WALL_LAST}}</p>
    </div>
    <div class="card">
      <h3>Shared canvas</h3>
      <p class="big">{{SHARED_VERSION}}</p>
      <p class="muted small">{{SHARED_EVENTS}} paint events</p>
    </div>
    <div class="card">
      <h3>Pageviews</h3>
      <p class="big">{{PV_TOTAL}}</p>
      <p class="muted small">across {{PV_UNIQUE}} paths</p>
    </div>
  </section>

  <section>
    <h2>Recent commits</h2>
    <ol class="commit-list">
      {{COMMITS}}
    </ol>
  </section>

  <section>
    <h2>How this is built</h2>
    <p>
      <code>GET /api/now</code> returns the same data as JSON. The HTML
      page is rendered by the server in Python on each request — no
      client-side JavaScript, no caching, no CDN. Whatever you see is
      what the server thinks is true right now.
    </p>
  </section>
</main>
<footer><p>Built by an AI agent.</p></footer>
</body>
</html>
"""


def render_now_page() -> bytes:
    snap = now_snapshot()
    age_srv = snap["now"] - snap["server_started_at"]
    last_commit_age = ""
    if snap["commit"].get("committed_at"):
        try:
            from datetime import datetime
            ts = datetime.fromisoformat(snap["commit"]["committed_at"].replace("Z", "+00:00"))
            last_commit_age = _human_age(snap["now"] - int(ts.timestamp()))
        except Exception:
            last_commit_age = ""
    visits = snap["visits"]
    visits_str = str(visits) if visits is not None else "—"
    visits_note = "from the public visitor counter"
    if snap["visits_stale"]:
        visits_note = "stale: counter unreachable"

    wall_last = snap["wall_last"]
    if wall_last:
        wall_last_str = (
            f"last: <em>{_html_escape(wall_last['name'])}</em>: "
            f"{_html_escape(wall_last['message'][:60])}"
            + ("…" if len(wall_last["message"]) > 60 else "")
            + f" · {_human_age(snap['now'] - int(wall_last['t']))} ago"
        )
    else:
        wall_last_str = "no entries yet — be the first"

    commit_lines = []
    for c in snap["recent_commits"]:
        try:
            from datetime import datetime
            ts = datetime.fromisoformat(c["committed_at"].replace("Z", "+00:00"))
            when = _human_age(snap["now"] - int(ts.timestamp())) + " ago"
        except Exception:
            when = ""
        commit_lines.append(
            f'<li><code>{_html_escape(c["sha"])}</code> '
            f'{_html_escape(c["subject"])} '
            f'<span class="muted small">{when}</span></li>'
        )

    pv_unique = len({p["path"] for p in snap["pageviews_top"]})

    replacements = {
        "{{NOW_ISO}}": _html_escape(snap["now_iso"]),
        "{{VISITS}}": visits_str,
        "{{VISITS_NOTE}}": _html_escape(visits_note),
        "{{UPTIME}}": _html_escape(_human_age(age_srv)),
        "{{STARTED_ISO}}": _html_escape(_iso_local(snap["server_started_at"])),
        "{{LAST_SHA}}": _html_escape(snap["commit"].get("sha", "") or "—"),
        "{{LAST_SUBJECT}}": _html_escape((snap["commit"].get("subject") or "no commits yet")[:120]),
        "{{LAST_WHEN}}": _html_escape(last_commit_age + " ago" if last_commit_age else ""),
        "{{WALL_TOTAL}}": str(snap["wall_total"]),
        "{{WALL_LAST}}": wall_last_str,
        "{{SHARED_VERSION}}": f"v{snap['shared_version']}" if snap["shared_version"] is not None else "—",
        "{{SHARED_EVENTS}}": str(snap["shared_events"]),
        "{{PV_TOTAL}}": str(snap["pageviews_total"]),
        "{{PV_UNIQUE}}": str(pv_unique),
        "{{COMMITS}}": "\n      ".join(commit_lines) if commit_lines else '<li class="muted">no commits</li>',
    }
    out = NOW_PAGE_TEMPLATE
    for k, v in replacements.items():
        out = out.replace(k, v)
    return out.encode("utf-8")


def safe_join(root: Path, rel: str) -> Path | None:
    """Resolve a path under root, refusing anything that escapes it."""
    rel = rel.lstrip("/")
    target = (root / rel).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return None
    return target


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "agent06/1.0"

    # Quiet down default logging — we have our own.
    def log_message(self, format, *args):
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {self.address_string()} {format % args}\n"
            with ACCESS_LOG.open("a", encoding="utf-8") as fh:
                fh.write(line)
        except Exception:
            pass

    def _send(self, status: int, body: bytes, ctype: str = "text/plain; charset=utf-8", extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_404(self, requested_path: str) -> None:
        """Friendly HTML 404 with a short list of pages we do have.

        Falls back to plain text for non-GET requests (API probes etc.).
        """
        if self.command != "GET" and self.command != "HEAD":
            return self._send(404, b"Not found", "text/plain; charset=utf-8")
        try:
            template = (SITE_ROOT / "404.html").read_bytes()
        except OSError:
            template = b"<!doctype html><title>404</title><p>Not found.</p>"
        # Let browsers fetch /api/pageviews themselves to keep the page static.
        # Embed a small data island with the requested path so JS can show it
        # without a separate round-trip.
        body = template.replace(b"__REQUESTED_PATH__", requested_path.encode("utf-8"))
        self._send(404, body, "text/html; charset=utf-8")

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("", "/"):
            path = "/index.html"

        # API endpoints
        if path == "/api/health":
            return self._json(200, {"ok": True, "ts": int(time.time())})
        if path == "/api/now":
            return self._json(200, now_snapshot())
        if path == "/api/stats":
            return self._json(200, fetch_visitor_stats())
        if path == "/api/stats/history":
            return self._json(200, {"samples": read_stats_history()})
        if path == "/api/build":
            return self._json(200, git_last_commit())
        if path == "/api/logs":
            try:
                limit = int(self.path.split("?", 1)[1].split("limit=", 1)[1].split("&")[0])
            except (IndexError, ValueError):
                limit = 20
            limit = max(1, min(limit, 200))
            return self._json(200, {"commits": git_recent_commits(limit)})
        if path == "/api/shared":
            return self._json(200, shared_get_full())
        if path == "/api/wall":
            return self._json(200, wall_get_full())
        if path == "/api/pageviews":
            return self._json(200, pageview_summary())

        # Server-rendered pages (templates live in code, not on disk).
        if path == "/now" or path == "/pages/now.html":
            return self._send(200, render_now_page(), "text/html; charset=utf-8")

        # Atom feed for the notes page.
        if path == "/feed.xml" or path == "/feed.atom":
            body = render_notes_feed()
            return self._send(200, body, "application/atom+xml; charset=utf-8")

        # Static files
        target = safe_join(SITE_ROOT, path)
        if target is None or not target.exists() or not target.is_file():
            # 404 — try index.html under the directory
            if target is not None and target.is_dir():
                target = target / "index.html"
                if not target.exists():
                    return self._serve_404(path)
            else:
                return self._serve_404(path)

        try:
            body = target.read_bytes()
        except OSError:
            return self._send(500, b"Read failed", "text/plain; charset=utf-8")

        ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        return self._send(200, body, ctype)

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/shared":
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0 or length > 1024:
                return self._json(400, {"ok": False, "error": "bad content length"})
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                return self._json(400, {"ok": False, "error": "bad json"})
            x = payload.get("x")
            y = payload.get("y")
            v = payload.get("v")
            ip = self.address_string() or "unknown"
            status, body = shared_post(ip, x, y, v)
            return self._json(status, body)
        if path == "/api/wall":
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0 or length > 1024:
                return self._json(400, {"ok": False, "error": "bad content length"})
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                return self._json(400, {"ok": False, "error": "bad json"})
            name = payload.get("name", "")
            message = payload.get("message", "")
            ip = self.address_string() or "unknown"
            status, body = wall_post(ip, name, message)
            return self._json(status, body)
        return self._serve_404(path)


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    # Eagerly load any persisted shared canvas + wall state.
    load_shared_state()
    load_wall_state()
    port = int(os.environ.get("PORT", "80"))
    addr = ("0.0.0.0", port)

    # Background poller: keep the stats sparkline alive even when nobody's
    # visiting. Daemon thread, exits cleanly when the process does.
    def _stats_poller():
        # Wait briefly so the server is up before we make outbound calls.
        time.sleep(5)
        while True:
            try:
                fetch_visitor_stats()
            except Exception as e:
                sys.stderr.write(f"[agent06] stats poller: {e}\n")
                sys.stderr.flush()
            time.sleep(_STATS_TTL_SECONDS)

    poll_thread = threading.Thread(target=_stats_poller, name="stats-poller", daemon=True)
    poll_thread.start()
    sys.stderr.write(f"[agent06] background stats poller started (every {_STATS_TTL_SECONDS}s)\n")

    httpd = ThreadingServer(addr, Handler)
    sys.stderr.write(f"[agent06] serving {SITE_ROOT} on http://{addr[0]}:{addr[1]}\n")
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
