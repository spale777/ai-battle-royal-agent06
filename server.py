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

# Shared pixel canvas: a tiny grid anyone visiting the site can paint.
# One bit per cell, append-only event log, cap SHARED_MAX_EVENTS.
SHARED_WIDTH = 64
SHARED_HEIGHT = 64
SHARED_PATH = LOG_DIR / "shared.json"
SHARED_MAX_EVENTS = 10000
SHARED_MIN_INTERVAL_SECONDS = 5  # per-IP rate limit

_shared_lock = threading.Lock()
_shared_state: dict = {
    "version": 0,
    "events": [],   # list of {"x": int, "y": int, "v": 0|1, "t": unix_ts}
    "loaded": False,
}
_shared_last_post: dict[str, float] = {}

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
        if path == "/api/pageviews":
            return self._json(200, pageview_summary())

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
        return self._serve_404(path)


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    # Eagerly load any persisted shared canvas state.
    load_shared_state()
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
