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
import secrets
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

# Reading / linkroll: curated links the agent finds with its own web searches,
# with one-line takes. Lives in data/reading.json (tracked in git), loaded
# once on startup, re-read from disk on each request so the file is the
# source of truth and edits deploy with a restart.
READING_PATH = PROJECT_ROOT / "data" / "reading.json"
READING_MAX_ENTRIES = 200
READING_MAX_TAKE = 280

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

# Guessing game (1..100). Player submits guesses; server says higher/lower.
# Sessions are persisted to disk so a page reload and a server restart
# don't lose game state. Cap of GUESSING_MAX_SESSIONS evicts the oldest
# non-active sessions on the next create call.
GUESSING_PATH = LOG_DIR / "guessing.json"
GUESSING_MAX_SESSIONS = 5000
GUESSING_MIN = 1
GUESSING_MAX = 100
GUESSING_BUDGET = 7  # number of guesses per game (binary search max ~7)

_guessing_lock = threading.Lock()
_guessing_state: dict = {
    "sessions": {},   # uuid -> {secret, history, status, created, last_t}
    "loaded": False,
}

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


def shared_recent(limit: int | str = 10) -> dict:
    """Return the N most recent paint events from the shared canvas.

    Walks logs/shared.json under _shared_lock (same path the dispatcher
    uses) so two concurrent POSTs don't tear the read. Newest first by
    `t`, with `version` desc as a tie-break so two events with the same
    timestamp still arrive in deterministic order. Each row carries:

        x, y, v     — paint coordinates + value (always 1 for paints; the
                      canvas is paint-only — clearing a pixel never
                      happens in practice because shared_post only
                      appends)
        t           — unix second of the paint
        t_iso       — human-readable UTC stamp for the row
        age_seconds — age relative to `now_unix` passed in (so the caller
                      controls "now"; the default below uses time.time())

    Bad input: clamp limit to 1..50, default 10; non-int (e.g. ?limit=foo)
    falls back to 10. The full event log is still at /api/shared; this
    endpoint is a cheap top-N view that doesn't ship the whole history
    over the wire on every refresh.
    """
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = 10
    n = max(1, min(50, n))
    now_unix = int(time.time())
    load_shared_state()
    with _shared_lock:
        events = list(_shared_state["events"])
        version = _shared_state["version"]
        w = SHARED_WIDTH
        h = SHARED_HEIGHT
    # Newest first. Sort by t desc, then break ties on insertion order
    # (which the version number reflects because version monotonically
    # increments per append).
    ordered = sorted(events, key=lambda e: -(int(e.get("t", 0))))
    top = ordered[:n]
    rows = []
    for e in top:
        try:
            x = int(e.get("x"))
            y = int(e.get("y"))
            t = int(e.get("t", 0))
        except (TypeError, ValueError):
            continue
        v = 1 if int(e.get("v", 0)) else 0
        if not (0 <= x < w and 0 <= y < h):
            continue
        rows.append({
            "x": x,
            "y": y,
            "v": v,
            "t": t,
            "t_iso": _iso_local(t),
            "age_seconds": max(0, now_unix - t),
        })
    # Unique painted cells (post-dedupe — a cell painted twice counts
    # once). Used by /now so the card can say "N cells painted" instead
    # of just "N events".
    unique_cells = set()
    for e in events:
        try:
            unique_cells.add((int(e["x"]), int(e["y"])))
        except (KeyError, TypeError, ValueError):
            continue
    return {
        "limit": n,
        "rows": rows,
        "total_events": len(events),
        "unique_cells_painted": len(unique_cells),
        "version": version,
        "now_unix": now_unix,
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


def wall_summary(days: int = 7) -> dict:
    """Roll up wall entries by UTC day.

    Returns a small dict intended for the /api/wall/summary endpoint and
    the /now snapshot. Keys:

      - total         : total entries currently stored
      - today_count   : entries on the current UTC day (the rollover happens
                        at 00:00 UTC; we deliberately don't pin to local time
                        because the server has no notion of visitor time)
      - today_day_key : YYYY-MM-DD for "today"
      - since_unix    : unix seconds for the start of the UTC day
      - last          : the most recent entry (or None)
      - by_day        : list of {day, count, last_message?, last_name?,
                        last_t?} for the last `days` days, oldest first

    Rollup is cheap (entries are few; bounded by WALL_MAX_ENTRIES) so we
    recompute on every call rather than caching.
    """
    load_wall_state()
    # Clamp the window hard so a malformed caller can't request a million
    # days. Upper cap leaves room for "give me a year of buckets" while
    # still being bounded.
    days = max(1, min(int(days or 1), 365))
    now = int(time.time())
    today_key = _day_key_utc(now)
    # UTC midnight for today, as a unix second.
    today_midnight = now - (now % 86400)

    with _wall_lock:
        entries = list(_wall_state["entries"])

    # Per-day bucketing, oldest first.
    counts: dict[str, int] = {}
    last_per_day: dict[str, dict] = {}
    today_count = 0
    for e in entries:
        t = int(e.get("t") or 0)
        if t <= 0:
            continue
        key = _day_key_utc(t)
        counts[key] = counts.get(key, 0) + 1
        # "last" per day = the entry with the largest t. Walk entries in
        # insertion order (oldest first), so overwrite only when strictly
        # newer — this gives the last entry per day.
        prev = last_per_day.get(key)
        if prev is None or t > int(prev.get("t") or 0):
            last_per_day[key] = {
                "name": e.get("name", "anonymous"),
                "message": e.get("message", ""),
                "t": t,
            }
        if t >= today_midnight:
            today_count += 1

    # Build a continuous window of `days` days ending today, so the chart
    # always has the same shape even on quiet days.
    by_day = []
    for offset in range(days - 1, -1, -1):
        day_ts = today_midnight - offset * 86400
        key = _day_key_utc(day_ts)
        last = last_per_day.get(key)
        item = {"day": key, "count": counts.get(key, 0)}
        if last is not None:
            item["last_name"] = last.get("name", "anonymous")
            item["last_message"] = last.get("message", "")
            item["last_t"] = last.get("t")
        by_day.append(item)

    last_entry = entries[-1] if entries else None
    last_payload = None
    if last_entry:
        last_payload = {
            "name": last_entry.get("name", "anonymous"),
            "message": last_entry.get("message", ""),
            "t": int(last_entry.get("t") or 0),
        }

    return {
        "total": len(entries),
        "today_count": today_count,
        "today_day_key": today_key,
        "since_unix": today_midnight,
        "days": days,
        "by_day": by_day,
        "last": last_payload,
    }


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


# ---------- Guessing game ----------------------------------------------------
# A small 1..100 binary-search game. Each visitor gets a session UUID, a
# fresh secret in [GUESSING_MIN, GUESSING_MAX], and a budget of
# GUESSING_BUDGET guesses. The server holds the secret and replies with
# "higher" / "lower" / "correct" / "repeat" / "out" (no guesses left) /
# "done" (game already over). Sessions persist across page reloads and
# server restarts via logs/guessing.json.


def _is_valid_session_id(sid: str) -> bool:
    """Reject anything that isn't a plain lowercase 32-hex-char UUID token."""
    if not isinstance(sid, str) or len(sid) != 32:
        return False
    return all(c in "0123456789abcdef" for c in sid)


def _guessing_random_int(lo: int, hi: int) -> int:
    """Inclusive [lo, hi] uniform int, cryptographically sane for our purposes."""
    return secrets.randbelow(hi - lo + 1) + lo


def _mulberry32(seed: int) -> int:
    """Tiny deterministic 32-bit PRNG.

    Not cryptographic — the daily mode's number is meant to be the same
    for everyone on the same day, so the whole point is that it's NOT
    unpredictable. mulberry32 gives us a stable, well-distributed
    sequence from a 32-bit integer seed. Returns an unsigned 32-bit int.
    """
    s = seed & 0xFFFFFFFF
    s = (s + 0x6D2B79F5) & 0xFFFFFFFF
    t = s
    t = (((t >> 15) & 0xFFFFFFFF) + t) & 0xFFFFFFFF
    t = (t ^ ((t << 7) & 0xFFFFFFFF)) & 0xFFFFFFFF
    t = (((t >> 14) & 0xFFFFFFFF) + t) & 0xFFFFFFFF
    t = (t ^ ((t << 17) & 0xFFFFFFFF)) & 0xFFFFFFFF
    t = (((t >> 13) & 0xFFFFFFFF) + t) & 0xFFFFFFFF
    return t & 0xFFFFFFFF


def _day_key_utc(ts: int | None = None) -> str:
    """Return 'YYYY-MM-DD' for the UTC date of the given epoch second."""
    if ts is None:
        ts = int(time.time())
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def _daily_secret_for(day_key: str) -> int:
    """Deterministic [1, 100] secret for a given UTC date string.

    The seed is the day's number-of-days-since-2020-01-01. We hash it
    with a stable 32-bit mixing step (a small xor-shift) before handing
    it to mulberry32 so two consecutive days aren't obviously adjacent.
    try/except on the strptime keeps us safe from a bad input; the
    fallback just uses today's date.
    """
    try:
        y, mo, da = day_key.split("-")
        # Days since 2020-01-01. We just want a stable integer per day;
        # exact leap-year handling below is good enough for 2020..2100.
        # (Real Julian day numbers aren't needed.)
        y = int(y); mo = int(mo); da = int(da)
        # Month lengths for non-leap years; leap extension inline.
        days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        leap = (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0))
        if leap:
            days_in_month[1] = 29
        # Total days since 2020-01-01
        days = 0
        for yy in range(2020, y):
            days += 366 if (yy % 4 == 0 and (yy % 100 != 0 or yy % 400 == 0)) else 365
        for mm in range(1, mo):
            days += days_in_month[mm - 1]
        days += da - 1
    except Exception:
        days = int(time.time() // 86400)
    # Mix the seed so adjacent days don't sit next to each other in the
    # mulberry32 sequence. A 32-bit xor-shift on the day count is fine.
    mixed = (days * 0x9E3779B1) & 0xFFFFFFFF
    r = _mulberry32(mixed)
    return GUESSING_MIN + (r % (GUESSING_MAX - GUESSING_MIN + 1))


def load_guessing_state() -> None:
    """Load persisted guessing sessions from disk if not already loaded."""
    with _guessing_lock:
        if _guessing_state["loaded"]:
            return
        if GUESSING_PATH.exists():
            try:
                raw = GUESSING_PATH.read_text(encoding="utf-8")
                obj = json.loads(raw)
                if isinstance(obj, dict) and isinstance(obj.get("sessions"), dict):
                    cleaned: dict = {}
                    for sid, sess in obj["sessions"].items():
                        if not _is_valid_session_id(sid) or not isinstance(sess, dict):
                            continue
                        try:
                            secret = int(sess.get("secret"))
                            history = sess.get("history") or []
                            status = sess.get("status") or "active"
                            created = int(sess.get("created") or 0)
                            last_t = int(sess.get("last_t") or created)
                        except (TypeError, ValueError):
                            continue
                        if not (GUESSING_MIN <= secret <= GUESSING_MAX):
                            continue
                        if status not in ("active", "won", "lost", "abandoned"):
                            status = "active"
                        # Drop the live history of solved games on cold load —
                        # they expose no advantage, and we don't reveal the
                        # secret anyway.
                        if status != "active":
                            history = []
                        sane_history = []
                        for h in history:
                            if not isinstance(h, (list, tuple)) or len(h) != 2:
                                continue
                            try:
                                g = int(h[0])
                                hint = str(h[1])
                            except (TypeError, ValueError):
                                continue
                            if not (GUESSING_MIN <= g <= GUESSING_MAX):
                                continue
                            if hint not in ("higher", "lower", "correct"):
                                continue
                            sane_history.append([g, hint])
                        # Preserve the new fields if present; default
                        # older sessions to mode=random.
                        smode = str(sess.get("mode") or "random")
                        if smode not in ("random", "daily"):
                            smode = "random"
                        sday = str(sess.get("day_key") or "")
                        # A daily session without a day_key is broken;
                        # synthesise one from the created timestamp so
                        # the rest of the session stays usable.
                        if smode == "daily" and not sday:
                            sday = _day_key_utc(created)
                        cleaned[sid] = {
                            "secret": secret,
                            "history": sane_history,
                            "status": status,
                            "created": created,
                            "last_t": last_t,
                            "mode": smode,
                            "day_key": sday,
                        }
                    _guessing_state["sessions"] = cleaned
            except (OSError, json.JSONDecodeError, ValueError):
                pass
        _guessing_state["loaded"] = True


def save_guessing_state() -> None:
    """Persist sessions. Caller must hold _guessing_lock."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = GUESSING_PATH.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps({"sessions": _guessing_state["sessions"]}, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(tmp, GUESSING_PATH)
    except OSError:
        pass


def _guessing_prune_locked() -> None:
    """Caller must hold _guessing_lock. Drop finished games first, then
    oldest inactive games if we are still over the cap."""
    sessions = _guessing_state["sessions"]
    # Trim any obviously broken entries first (no real need, but cheap).
    if len(sessions) <= GUESSING_MAX_SESSIONS:
        return
    # Drop finished sessions (won / lost / abandoned) first — they're
    # purely historical and the live page doesn't need them.
    finished = [sid for sid, s in sessions.items() if s.get("status") != "active"]
    for sid in sorted(finished, key=lambda k: sessions[k].get("last_t", 0)):
        if len(sessions) <= GUESSING_MAX_SESSIONS:
            break
        sessions.pop(sid, None)
    if len(sessions) <= GUESSING_MAX_SESSIONS:
        return
    # If we're still over, drop oldest active sessions.
    for sid in sorted(sessions, key=lambda k: sessions[k].get("last_t", 0)):
        if len(sessions) <= GUESSING_MAX_SESSIONS:
            break
        sessions.pop(sid, None)


def guessing_create(mode: str = "") -> tuple[int, dict]:
    """Start a new game. Returns (http_status, payload).

    Two modes:
      - mode == "" or "random" (default): fresh crypto-random secret,
        independent per session. The original behavior.
      - mode == "daily": a deterministic secret derived from today's
        UTC date (YYYY-MM-DD). Everyone who opens a daily game on the
        same day gets the same number; on the next UTC day the number
        changes. The mode and day_key are persisted on the session so
        reloads stay sticky even if the date flips while you play.
    """
    load_guessing_state()
    mode = (mode or "").lower().strip()
    if mode not in ("", "random", "daily"):
        mode = ""
    daily = (mode == "daily")
    day_key = _day_key_utc() if daily else ""
    now = int(time.time())
    while True:
        sid = secrets.token_hex(16)
        with _guessing_lock:
            if sid not in _guessing_state["sessions"]:
                if daily:
                    secret = _daily_secret_for(day_key)
                else:
                    secret = _guessing_random_int(GUESSING_MIN, GUESSING_MAX)
                _guessing_state["sessions"][sid] = {
                    "secret": secret,
                    "history": [],
                    "status": "active",
                    "created": now,
                    "last_t": now,
                    "mode": "daily" if daily else "random",
                    "day_key": day_key,
                }
                _guessing_prune_locked()
                save_guessing_state()
                break
    payload = {
        "ok": True,
        "session": sid,
        "range": [GUESSING_MIN, GUESSING_MAX],
        "budget": GUESSING_BUDGET,
        "guesses_left": GUESSING_BUDGET,
        "history": [],
        "status": "active",
        "created": now,
        "mode": "daily" if daily else "random",
    }
    if daily:
        payload["day_key"] = day_key
    return 200, payload


def guessing_state(sid: str) -> tuple[int, dict]:
    """Read-only view of a session. Never reveals the secret on 'active'."""
    load_guessing_state()
    if not _is_valid_session_id(sid):
        return 400, {"ok": False, "error": "bad session id"}
    with _guessing_lock:
        sess = _guessing_state["sessions"].get(sid)
        if not sess:
            return 404, {"ok": False, "error": "no such session"}
        guesses_used = len(sess["history"])
        guesses_left = GUESSING_BUDGET - guesses_used
        if sess["status"] == "active" and guesses_left < 0:
            guesses_left = 0
        # Surface mode + day_key so the client can label daily games.
        mode = sess.get("mode") or "random"
        payload = {
            "ok": True,
            "session": sid,
            "range": [GUESSING_MIN, GUESSING_MAX],
            "budget": GUESSING_BUDGET,
            "guesses_used": guesses_used,
            "guesses_left": guesses_left,
            "history": list(sess["history"]),
            "status": sess["status"],
            "mode": mode,
        }
        if mode == "daily":
            payload["day_key"] = sess.get("day_key") or _day_key_utc()
        return 200, payload


def guessing_guess(sid: str, raw_guess) -> tuple[int, dict]:
    """Submit a guess for an existing session. Returns (status, payload).

    Outcome strings surfaced to the client:
      "higher"   — secret is bigger than your guess
      "lower"    — secret is smaller than your guess
      "correct"  — game won, secret revealed
      "out"      — budget exhausted, secret revealed, status -> lost
      "repeat"   — you've already guessed this number
      "done"     — game is no longer accepting guesses
    """
    load_guessing_state()
    if not _is_valid_session_id(sid):
        return 400, {"ok": False, "error": "bad session id"}
    try:
        guess = int(raw_guess)
    except (TypeError, ValueError):
        return 400, {"ok": False, "error": "guess must be an integer"}
    if not (GUESSING_MIN <= guess <= GUESSING_MAX):
        return 400, {
            "ok": False,
            "error": f"guess must be in [{GUESSING_MIN}, {GUESSING_MAX}]",
        }
    now = int(time.time())
    with _guessing_lock:
        sess = _guessing_state["sessions"].get(sid)
        if not sess:
            return 404, {"ok": False, "error": "no such session"}
        if sess["status"] != "active":
            return 200, {
                "ok": True,
                "session": sid,
                "outcome": "done",
                "status": sess["status"],
                "secret": sess["secret"],
                "guesses_used": len(sess["history"]),
                "guesses_left": 0,
                "history": list(sess["history"]),
                "range": [GUESSING_MIN, GUESSING_MAX],
                "budget": GUESSING_BUDGET,
            }
        # Already guessed?
        for g, _h in sess["history"]:
            if g == guess:
                guesses_used = len(sess["history"])
                guesses_left = max(0, GUESSING_BUDGET - guesses_used)
                return 200, {
                    "ok": True,
                    "session": sid,
                    "outcome": "repeat",
                    "guess": guess,
                    "guesses_used": guesses_used,
                    "guesses_left": guesses_left,
                    "history": list(sess["history"]),
                    "range": [GUESSING_MIN, GUESSING_MAX],
                    "budget": GUESSING_BUDGET,
                }
        # Determine outcome.
        secret = sess["secret"]
        if guess < secret:
            outcome = "higher"
        elif guess > secret:
            outcome = "lower"
        else:
            outcome = "correct"
        sess["history"].append([guess, outcome])
        sess["last_t"] = now
        guesses_used = len(sess["history"])
        guesses_left = GUESSING_BUDGET - guesses_used
        if outcome == "correct":
            sess["status"] = "won"
            guesses_left = GUESSING_BUDGET - guesses_used
        elif guesses_left < 0:
            # Belt and braces: actually impossible since we just added one,
            # but keep the invariant tight.
            guesses_left = 0
        payload = {
            "ok": True,
            "session": sid,
            "outcome": outcome,
            "guess": guess,
            "guesses_used": guesses_used,
            "guesses_left": guesses_left,
            "history": list(sess["history"]),
            "range": [GUESSING_MIN, GUESSING_MAX],
            "budget": GUESSING_BUDGET,
            "status": sess["status"],
        }
        if sess["status"] == "active" and guesses_used >= GUESSING_BUDGET:
            # Burn the last guess — if it wasn't already correct, the
            # game is now over and the player has lost.
            if outcome != "correct":
                sess["status"] = "lost"
                payload["outcome"] = "out"
                payload["status"] = "lost"
                payload["guesses_left"] = 0
        # Reveal the secret only when the game is decided.
        if sess["status"] != "active":
            payload["secret"] = secret
        _guessing_prune_locked()
        save_guessing_state()
        return 200, payload


def guessing_abandon(sid: str) -> tuple[int, dict]:
    """Mark a session abandoned (so prune won't try to keep it forever)."""
    load_guessing_state()
    if not _is_valid_session_id(sid):
        return 400, {"ok": False, "error": "bad session id"}
    now = int(time.time())
    with _guessing_lock:
        sess = _guessing_state["sessions"].get(sid)
        if not sess:
            return 404, {"ok": False, "error": "no such session"}
        if sess["status"] == "active":
            sess["status"] = "abandoned"
            sess["last_t"] = now
            save_guessing_state()
        return 200, {
            "ok": True,
            "session": sid,
            "status": sess["status"],
            "secret": sess["secret"],
            "history": list(sess["history"]),
            "budget": GUESSING_BUDGET,
        }


def guessing_daily_info() -> tuple[int, dict]:
    """Read-only metadata about today's daily puzzle.

    Returns the day_key, range, and budget — but NOT the secret. This is
    safe to expose: it's how a sharer says "did you get today's puzzle?"
    without giving the answer away. Use POST /api/guessing?mode=daily to
    actually start playing.

    A small `prev_day_key` / `next_day_key` is included for symmetry
    (neighbours on the calendar), but neither of those numbers is
    leaked by this endpoint either.

    Also surfaces `seconds_until_rollover` and `rollover_at_iso` so a
    client can render a HH:MM:SS countdown to the next daily puzzle
    without an extra round-trip to `/api/now`.
    """
    day_key = _day_key_utc()
    now = int(time.time())
    # Build neighbouring day_keys via UTC arithmetic — strptime +
    # timedelta keeps us clear of month/year edge cases.
    try:
        from datetime import datetime, timedelta, timezone
        today = datetime.strptime(day_key, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        prev_key = (today - timedelta(days=1)).strftime("%Y-%m-%d")
        next_key = (today + timedelta(days=1)).strftime("%Y-%m-%d")
    except Exception:
        prev_key = ""
        next_key = ""
    return 200, {
        "ok": True,
        "mode": "daily",
        "day_key": day_key,
        "range": [GUESSING_MIN, GUESSING_MAX],
        "budget": GUESSING_BUDGET,
        "start_url": "/api/guessing?mode=daily",
        "play_url": "/pages/guessing.html",
        "prev_day_key": prev_key,
        "next_day_key": next_key,
        "seconds_until_rollover": _seconds_until_utc_midnight(now),
        "rollover_at_iso": _iso_local(_next_utc_midnight_unix(now)),
    }


# Archive default: a month of daily puzzles. Clamp is shared with wall_summary.
DAILY_ARCHIVE_DEFAULT = 30
DAILY_ARCHIVE_MAX = 365


def daily_archive(days: int = DAILY_ARCHIVE_DEFAULT) -> dict:
    """Past daily puzzles with their secret (when safe) and aggregate stats.

    The secret is **strictly** for past days. Even for a past day, we only
    reveal the secret if no daily session for that day_key is still active
    on the server — so a visitor mid-attempt on yesterday's puzzle cannot
    have it stolen by hitting this endpoint. Today is never returned: use
    /api/guessing/daily (which never includes the secret) instead.

    Stats come from logs/guessing.json: per-day counts of active / won /
    lost / abandoned daily sessions. Sessions older than the cutoff window
    are not considered; that's fine, the cap is purely a safety bound.

    `range` and `budget` mirror what /api/guessing/daily emits, so a
    client can render a row without a second fetch.
    """
    # Clamp days first; bad input (negative, >MAX, "foo") all fall through
    # to the default — same shape as wall_summary.
    try:
        n = int(days)
    except (TypeError, ValueError):
        n = DAILY_ARCHIVE_DEFAULT
    n = max(1, min(DAILY_ARCHIVE_MAX, n))

    today_key = _day_key_utc()

    # Walk backwards day-by-day, skipping today. We can't reuse
    # wall_summary's day-key math because we need to keep a stable
    # iteration order (oldest first) and skip today specifically.
    from datetime import datetime, timedelta, timezone
    today_midnight = datetime.strptime(today_key, "%Y-%m-%d").replace(
        tzinfo=timezone.utc
    )

    # Aggregate session statuses per day_key from the on-disk log. Load
    # once (it's small) and bucket by day_key + status.
    counts: dict[str, dict[str, int]] = {}
    active_days: set[str] = set()
    try:
        load_guessing_state()
        with _guessing_lock:
            sessions = _guessing_state.get("sessions") or {}
        for sess in sessions.values():
            if sess.get("mode") != "daily":
                continue
            d = str(sess.get("day_key") or "")
            if not d:
                continue
            bucket = counts.setdefault(d, {"active": 0, "won": 0, "lost": 0, "abandoned": 0})
            status = sess.get("status") or "active"
            if status not in bucket:
                status = "active"
            bucket[status] += 1
            if status == "active":
                active_days.add(d)
    except Exception:
        # Treat any read failure as "no data" — the page is still useful
        # even if logs are missing or corrupt.
        counts = {}

    rows = []
    for offset in range(1, n + 1):  # 1..n days ago, inclusive of yesterday
        day_dt = today_midnight - timedelta(days=offset)
        day_key = day_dt.strftime("%Y-%m-%d")
        bucket = counts.get(day_key, {"active": 0, "won": 0, "lost": 0, "abandoned": 0})
        # The secret reveal rule: a day is "safe" iff no active daily
        # session exists for that day. A daily session is normally bound
        # to the day it was created on, so a still-active daily session
        # for a past day is either a forgotten attempt or a bot — either
        # way we keep the secret hidden until it's wrapped up.
        reveal = day_key not in active_days
        row = {
            "day": day_key,
            "range": [GUESSING_MIN, GUESSING_MAX],
            "budget": GUESSING_BUDGET,
            "stats": {
                "active": bucket["active"],
                "won": bucket["won"],
                "lost": bucket["lost"],
                "abandoned": bucket["abandoned"],
                "total": sum(bucket.values()),
            },
            "secret_revealed": reveal,
        }
        if reveal:
            row["secret"] = _daily_secret_for(day_key)
        rows.append(row)

    return {
        "ok": True,
        "today": today_key,
        "range": [GUESSING_MIN, GUESSING_MAX],
        "budget": GUESSING_BUDGET,
        "days": n,
        "earliest": rows[0]["day"] if rows else "",
        "latest": rows[-1]["day"] if rows else "",
        "rows": rows,
    }


def guessing_stats() -> dict:
    """Lifetime + per-day stats over all guessing sessions in logs/guessing.json.

    Reads the same log that guessing_create/guess/abandon write to. The
    log is bounded by GUESSING_MAX_SESSIONS (~5000), but in practice
    stays far below that.

    For each mode (random / daily), surfaces:
      lifetime: total, won, lost, abandoned, active,
                win_rate_pct (won / max(1, won+lost) * 100 rounded),
                won_with_full_history (count of `won` sessions whose
                    history survived cold-load — these are the only
                    sessions whose guess count we know precisely)
      today (UTC): same breakdown for sessions created today UTC.

    Skips sessions whose `secret` is outside [GUESSING_MIN..GUESSING_MAX]
    (defensive against junk entries that might land in the log on
    cold-load). Sessions missing the `mode` key are treated as `random`
    — the original mode before the daily variant shipped — so they
    still show up in the random column, not in daily's.

    Cold-load caveat: load_guessing_state() drops the history array of
    finished games (won / lost / abandoned). That means we can never
    recover the exact guess count for sessions that finished before
    the server last restarted. We surface this as `won_with_full_history`
    so a reader knows how many won games actually have a reliable
    guess count. Sessions won during the current process do show up
    there.

    Returns:
      {
        "ok": True,
        "today_day_key": "YYYY-MM-DD",
        "range": [lo, hi],
        "budget": 7,
        "modes": {
          "random": {"lifetime": {...}, "today": {...}},
          "daily":  {"lifetime": {...}, "today": {...}},
        },
      }
    """
    today_key = _day_key_utc()

    # Default bucket shape — every mode gets one even if no sessions.
    def blank_bucket():
        return {"active": 0, "won": 0, "lost": 0, "abandoned": 0,
                "total": 0, "won_with_full_history": 0}

    def win_rate(b):
        decided = b["won"] + b["lost"]
        if decided == 0:
            return None
        return round((b["won"] / decided) * 100, 1)

    out = {
        "random": {"lifetime": blank_bucket(), "today": blank_bucket()},
        "daily":  {"lifetime": blank_bucket(), "today": blank_bucket()},
    }

    try:
        load_guessing_state()
        with _guessing_lock:
            sessions = list(_guessing_state.get("sessions", {}).values())
    except Exception:
        sessions = []

    for sess in sessions:
        try:
            secret = int(sess.get("secret"))
            status = str(sess.get("status") or "active")
            created = int(sess.get("created") or 0)
        except (TypeError, ValueError):
            continue
        if not (GUESSING_MIN <= secret <= GUESSING_MAX):
            continue
        if status not in ("active", "won", "lost", "abandoned"):
            status = "active"
        mode_raw = sess.get("mode") or "random"
        mode = mode_raw if mode_raw in ("random", "daily") else "random"
        history = sess.get("history") or []
        # Record in lifetime bucket.
        out[mode]["lifetime"]["total"] += 1
        out[mode]["lifetime"][status] = out[mode]["lifetime"].get(status, 0) + 1
        if status == "won" and history:
            out[mode]["lifetime"]["won_with_full_history"] += 1
        # Today bucket: created today UTC counts. Cold-load has created
        # because that's a top-line field that is never stripped.
        try:
            created_key = _day_key_utc(created)
        except Exception:
            created_key = ""
        if created_key == today_key:
            out[mode]["today"]["total"] += 1
            out[mode]["today"][status] = out[mode]["today"].get(status, 0) + 1
            if status == "won" and history:
                out[mode]["today"]["won_with_full_history"] += 1

    # Win rate for each (mode, window). None means "no decided games yet"
    # (don't divide by zero); the JSON surface carries it as null so a
    # client can render "—".
    for mode in ("random", "daily"):
        wr_life = win_rate(out[mode]["lifetime"])
        wr_today = win_rate(out[mode]["today"])
        out[mode]["lifetime"]["win_rate_pct"] = wr_life  # type: ignore[assignment]
        out[mode]["today"]["win_rate_pct"] = wr_today  # type: ignore[assignment]
    return {
        "ok": True,
        "today_day_key": today_key,
        "range": [GUESSING_MIN, GUESSING_MAX],
        "budget": GUESSING_BUDGET,
        "modes": out,
    }


GUESSING_RECENT_DEFAULT = 10
GUESSING_RECENT_MAX = 50


def guessing_recent(limit: int = GUESSING_RECENT_DEFAULT) -> dict:
    """Return the N most recently *finished* guessing games, newest first.

    Complements /api/guessing/stats (the aggregate leaderboard) with an
    individual-game view. Excludes active sessions — only won, lost, and
    abandoned games appear. Each row exposes:

      sid               session id (truncated to 8 chars in the response
                        so visitors can identify "the same game" without
                        leaking the full token)
      mode              "random" | "daily"
      day_key           day_key for daily games, "" for random games
      status            "won" | "lost" | "abandoned"
      secret            the secret for the game; revealed because the
                        game is over (matches /api/daily/archive's
                        reveal rule — finished games expose their
                        secret; active games do not)
      created           unix seconds the session was created
      last_t            unix seconds of the last guess / abandon action
      duration_seconds  max(0, last_t - created)

    Defensive:
      - clamp(1, 50), default 10
      - bad input (?limit=foo) falls back to 10
      - skips sessions with status="active" and any session missing
        a parseable secret/created/last_t (junk from cold-load)
      - sessions that *finished during the current process* still
        have their history, but the cold-load path strips history from
        finished games to avoid leaking partial guess sequences, so
        we don't surface `guesses_used` — we surface `last_t - created`
        instead, which is observable across both in-process and
        cold-loaded finishes
    """
    # Clamp + bad-input fallback.
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = GUESSING_RECENT_DEFAULT
    if n < 1:
        n = 1
    if n > GUESSING_RECENT_MAX:
        n = GUESSING_RECENT_MAX

    try:
        load_guessing_state()
        with _guessing_lock:
            sessions = list(_guessing_state.get("sessions", {}).items())
    except Exception:
        sessions = []

    finished = []
    for sid_full, sess in sessions:
        if not isinstance(sess, dict):
            continue
        status = str(sess.get("status") or "")
        if status not in ("won", "lost", "abandoned"):
            continue
        try:
            secret = int(sess.get("secret"))
            created = int(sess.get("created") or 0)
            last_t = int(sess.get("last_t") or created)
            sid_str = str(sid_full or "")
        except (TypeError, ValueError):
            continue
        if not (GUESSING_MIN <= secret <= GUESSING_MAX):
            continue
        mode = str(sess.get("mode") or "random")
        if mode not in ("random", "daily"):
            mode = "random"
        finished.append({
            "sid": sid_str[:8],
            "sid_full": sid_str,
            "mode": mode,
            "day_key": str(sess.get("day_key") or "") if mode == "daily" else "",
            "status": status,
            "secret": secret,
            "created": created,
            "last_t": last_t,
            "duration_seconds": max(0, last_t - created),
        })

    # Newest first by last_t (the timestamp of the finishing action),
    # tie-broken by created desc so two finishes in the same second
    # are deterministically ordered.
    finished.sort(key=lambda r: (r["last_t"], r["created"]), reverse=True)

    rows = finished[:n]
    return {
        "ok": True,
        "limit": n,
        "count": len(rows),
        "rows": rows,
        # A small surface about the *source* the rows came from. The
        # log is bounded by GUESSING_MAX_SESSIONS=5000 so cold-loaded
        # finished games can drop their history but never their
        # existence.
        "total_finished_known": len(finished),
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


def pageviews_summary(days: int = 7) -> dict:
    """Roll up pageviews by UTC day.

    Same shape as wall_summary: a continuous `days`-long window ending
    today (oldest first), one bucket per day, plus a small today_count.

    Bucketing uses UTC midnight, not the visitor's local clock, so the
    numbers don't shift based on who's looking. Same convention as
    wall_summary and daily_archive.

    Returns:
      {
        "total": int,           # all pageviews in the on-disk log
        "today_count": int,     # pageviews on the current UTC day
        "today_day_key": str,   # YYYY-MM-DD for today
        "yesterday_day_key": str,  # YYYY-MM-DD for the day before today
        "since_unix": int,      # unix seconds for start of today UTC
        "days": int,            # clamp(1, 365) value used for by_day
        "by_day": [             # oldest first; today is the last entry
          {"day": str, "count": int, "unique_paths": int,
           "top_path": str?, "top_path_hits": int?},
          ...
        ],
        "by_path_today": {path: hits},     # per-path counts for today UTC
        "by_path_yesterday": {path: hits}, # per-path counts for yesterday UTC
      }

    `top_path` / `top_path_hits` make tooltips useful on a strip widget
    without needing a second fetch — same trick as wall_summary's
    last_message / last_name. The `by_path_today` + `by_path_yesterday`
    maps are sparse surfaces for the trending widget (`today - yesterday`
    delta) and are only included when the caller asked for at least 2
    days (`days >= 2`); they cost no extra work because we already walk
    the access log.
    """
    rows = read_pageviews()
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 7
    days = max(1, min(days, 365))
    now = int(time.time())
    today_key = _day_key_utc(now)
    today_midnight = now - (now % 86400)
    yesterday_midnight = today_midnight - 86400
    yesterday_key = _day_key_utc(yesterday_midnight)

    # Per-day bucketing. We track hits + unique paths + a top path so
    # the strip widget can hover on each cell.
    counts: dict[str, int] = {}
    path_counts: dict[str, dict[str, int]] = {}
    today_count = 0
    yesterday_count = 0
    for r in rows:
        ts = r.get("ts")
        if ts is None:
            continue
        key = _day_key_utc(ts)
        counts[key] = counts.get(key, 0) + 1
        bucket = path_counts.setdefault(key, {})
        p = r.get("path") or ""
        bucket[p] = bucket.get(p, 0) + 1
        if ts >= today_midnight:
            today_count += 1
        elif ts >= yesterday_midnight:
            yesterday_count += 1

    by_day = []
    for offset in range(days - 1, -1, -1):
        day_ts = today_midnight - offset * 86400
        key = _day_key_utc(day_ts)
        c = counts.get(key, 0)
        per_path = path_counts.get(key, {})
        unique = len(per_path)
        item = {"day": key, "count": c, "unique_paths": unique}
        if per_path:
            top_path = max(per_path.items(), key=lambda kv: (kv[1], kv[0]))
            item["top_path"] = top_path[0]
            item["top_path_hits"] = top_path[1]
        by_day.append(item)

    out = {
        "total": len(rows),
        "today_count": today_count,
        "today_day_key": today_key,
        "yesterday_day_key": yesterday_key,
        "since_unix": today_midnight,
        "days": days,
        "by_day": by_day,
    }
    # Sparse surfaces — only surface per-path maps for today + yesterday
    # when the caller asked for at least 2 days. The trending widget
    # uses these to compute "today - yesterday" deltas per path. Storing
    # the whole `path_counts` map would be wasteful (weeks of buckets);
    # today + yesterday are the only ones the trending widget needs.
    if days >= 2:
        out["by_path_today"] = dict(path_counts.get(today_key, {}))
        out["by_path_yesterday"] = dict(path_counts.get(yesterday_key, {}))
    return out


def trending_paths(top: int = 6) -> dict:
    """Per-path hit-count deltas between today and yesterday.

    Reads `pageviews_summary(2)` and computes `today_hits - yesterday_hits`
    per path, then returns the top-N paths ranked by absolute delta
    (descending). Equal-absolute deltas break ties on the path's name
    so the result is stable across requests.

    Used by:
      - GET /api/pageviews/trending (top N from ?top=M)
      - now_snapshot() (top 5 inline for the /now "Trending pages" card)

    Returns:
      {
        "today_day_key": str,
        "yesterday_day_key": str,
        "top": int,                    # clamp(1, 20) value used
        "rows": [
          {"path": str, "today": int, "yesterday": int,
           "delta": int, "direction": "up"|"down"|"flat"|"new"|"gone"},
          ...
        ],
        "today_unique": int,           # how many distinct paths hit today
        "yesterday_unique": int,       # how many distinct paths hit yesterday
      }

    Notes on the directions:
      - "flat"  : delta == 0  (the path was hot both days, no movement)
      - "up"    : delta > 0   (more hits today than yesterday, both > 0)
      - "down"  : delta < 0   (fewer hits today than yesterday, both > 0)
      - "new"   : yesterday == 0 and today > 0  (path is new today)
      - "gone"  : today == 0 and yesterday > 0   (path dropped to zero today)

    "new" and "gone" are surfaced distinctly because they're a different
    story than just "grew" / "shrank" — they're new arrivals and quiet
    departures. A flat path with both counts > 0 is intentionally
    included before "gone" rows in the abs(delta)-sort so that real
    movers aren't crowded out.

    Empty-state: when either day has no pageviews in the access log
    (a brand-new site, or a day skipped entirely), `rows` is `[]` and
    `top` is still echoed so callers can render a graceful empty.
    """
    try:
        top = int(top)
    except (TypeError, ValueError):
        top = 6
    top = max(1, min(top, 20))

    sum_ = pageviews_summary(days=2)
    by_today = sum_.get("by_path_today", {}) or {}
    by_yest = sum_.get("by_path_yesterday", {}) or {}

    # Union of paths seen on either day. A path only on one side
    # naturally gets a delta (new or gone) without needing a special
    # union pass.
    all_paths = set(by_today.keys()) | set(by_yest.keys())
    rows = []
    for p in all_paths:
        try:
            t = int(by_today.get(p, 0))
            y = int(by_yest.get(p, 0))
        except (TypeError, ValueError):
            continue
        delta = t - y
        if delta > 0 and y == 0:
            direction = "new"
        elif delta < 0 and t == 0:
            direction = "gone"
        elif delta > 0:
            direction = "up"
        elif delta < 0:
            direction = "down"
        else:
            direction = "flat"
        rows.append({
            "path": p,
            "today": t,
            "yesterday": y,
            "delta": delta,
            "direction": direction,
        })

    # Sort by absolute delta desc so the biggest movers surface first.
    # Tie-break: hot paths (delta != 0) before flat (delta == 0), then
    # alphabetically by path so the sort is stable across requests.
    rows.sort(key=lambda r: (
        -abs(int(r.get("delta") or 0)),
        0 if int(r.get("delta") or 0) != 0 else 1,
        r.get("path") or "",
    ))

    # Slice to `top`. If we have fewer than `top` rows, that's fine —
    # a brand-new site may have only one path, and the empty list still
    # tells the caller everything they need to know.
    return {
        "today_day_key": sum_.get("today_day_key"),
        "yesterday_day_key": sum_.get("yesterday_day_key"),
        "top": top,
        "rows": rows[:top],
        "today_unique": len(by_today),
        "yesterday_unique": len(by_yest),
    }


def visitors_summary(days: int = 7) -> dict:
    """Roll up visitor-counter samples by UTC day.

    Each sample in logs/stats.jsonl is a one-line JSON record shaped like
    {"t": <unix>, "v": <visit counter value or null>}, written once every
    time we refresh the public visitor counter. There can be dozens per
    hour on a quiet site, so the file grows quickly — keep the rollup
    bounded by STATS_LOG_MAX_LINES.

    Each day bucket carries:
      - latest_v    : the most recent v seen on that UTC day (the closest
                      thing we have to "what was the counter at the end
                      of the day")
      - peak_v      : the largest v seen on that UTC day
      - peak_at_unix: unix second of the peak sample
      - sample_count: how many samples landed in this bucket

    Bucketing uses UTC midnight, not the visitor's local clock, so the
    numbers don't shift based on who's looking — same convention as
    wall_summary, pageviews_summary, and daily_archive.

    Returns:
      {
        "samples": int,                # total samples in the on-disk log
        "today_day_key": str,          # YYYY-MM-DD for today
        "today_latest_v": int|None,    # latest v on today's UTC day
        "today_peak_v": int|None,      # peak v on today's UTC day
        "today_peak_at_unix": int|0,   # unix of today's peak sample
        "today_change_vs_yesterday": int|None,
        "since_unix": int,             # unix seconds for start of today UTC
        "days": int,                   # clamp(1, 365) value used for by_day
        "by_day": [                    # oldest first; today is the last entry
          {"day": str, "latest_v": int|None, "peak_v": int|None,
           "peak_at_unix": int|0, "sample_count": int},
          ...
        ],
      }

    Reads logs/stats.jsonl on every call (capped at STATS_LOG_MAX_LINES),
    so it's cheap and side-effect-free — same shape as the other summary
    helpers.
    """
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 7
    days = max(1, min(days, 365))

    rows: list = []
    try:
        with STATS_LOG.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    s = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(s, dict):
                    continue
                t = s.get("t")
                if isinstance(t, int):
                    rows.append(s)
    except OSError:
        rows = []

    now = int(time.time())
    today_key = _day_key_utc(now)
    today_midnight = now - (now % 86400)

    # Per-day bucketing. We track latest-by-t (insertion order is t-ordered
    # because we always append, so the last write wins for the same t)
    # and peak-by-v.
    latest_per_day: dict[str, dict] = {}
    peak_per_day: dict[str, dict] = {}
    count_per_day: dict[str, int] = {}
    today_latest_v = None
    today_latest_t = 0
    today_peak_v = None
    today_peak_t = 0

    for s in rows:
        t = s.get("t")
        v = s.get("v")
        key = _day_key_utc(t)
        count_per_day[key] = count_per_day.get(key, 0) + 1
        # Latest wins by t (insertion order on disk is t-ordered, but be
        # defensive against out-of-order writes).
        prev_latest = latest_per_day.get(key)
        if prev_latest is None or t > int(prev_latest.get("t") or 0):
            latest_per_day[key] = {"t": t, "v": v}
        # Peak wins by v (only over non-null v — a null v means the
        # counter was unreachable at that sample, so don't let it "win"
        # the peak comparison).
        if v is not None:
            prev_peak = peak_per_day.get(key)
            if prev_peak is None or v > int(prev_peak.get("v") or 0):
                peak_per_day[key] = {"t": t, "v": v}
        if t >= today_midnight:
            if t > today_latest_t:
                today_latest_t = t
                today_latest_v = v
            if v is not None and (today_peak_v is None or v > today_peak_v):
                today_peak_v = v
                today_peak_t = t

    by_day = []
    for offset in range(days - 1, -1, -1):
        day_ts = today_midnight - offset * 86400
        key = _day_key_utc(day_ts)
        latest = latest_per_day.get(key)
        peak = peak_per_day.get(key)
        item = {
            "day": key,
            "sample_count": count_per_day.get(key, 0),
        }
        if latest is not None:
            item["latest_v"] = latest.get("v")
        if peak is not None:
            item["peak_v"] = peak.get("v")
            item["peak_at_unix"] = int(peak.get("t") or 0)
        by_day.append(item)

    # Change vs yesterday's latest: positive = today's latest is higher.
    # Yesterday is the second-to-last bucket in the by_day list (when
    # days >= 2); None if yesterday had no samples.
    today_change = None
    if len(by_day) >= 2:
        y = by_day[-2]
        today_v = latest_per_day.get(today_key, {}).get("v")
        y_v = y.get("latest_v")
        if today_v is not None and y_v is not None:
            today_change = int(today_v) - int(y_v)

    return {
        "samples": len(rows),
        "today_day_key": today_key,
        "today_latest_v": today_latest_v,
        "today_peak_v": today_peak_v,
        "today_peak_at_unix": today_peak_t,
        "today_change_vs_yesterday": today_change,
        "since_unix": today_midnight,
        "days": days,
        "by_day": by_day,
    }


def visitors_hourly(days: int = 7) -> dict:
    """Roll up visitor-counter samples by UTC hour-of-day.

    Where visitors_summary() buckets by UTC day, this function buckets by
    hour-of-day (0..23 UTC), repeated across `days` consecutive UTC days.
    Each (day, hour) cell carries its peak concurrent visitor count (v)
    and sample count; per-hour-of-day aggregates are then derived by
    averaging (and max-ing) across the days.

    Use case: "what time of day is this site busiest?" The peak concurrent
    visitor counter can move up and down a lot within a single day, so
    aggregating the *peak per hour* (not the average) is the right shape —
    we want to know the worst-case occupancy in each hour, not the steady
    state. The site has very few concurrent visitors on a quiet day, so
    the chart naturally highlights whichever hour saw the most activity
    across the window.

    Bucketing uses UTC midnight, not the visitor's local clock. If a
    future feature wants local-time bucketing, it has to be opt-in (the
    visitor can pass their own offset) so three visitors don't see three
    different "today" values — same caveat as visitors_summary().

    Args:
      days: clamp 1..30 (default 7). Wider windows dilute today's signal
            against an older low-traffic baseline, so the cap is tighter
            than visitors_summary's 365.

    Returns:
      {
        "since_unix": int,            # unix seconds for start of today UTC
        "days": int,                  # clamp(1, 30) value used
        "day_keys": [str, ...],       # YYYY-MM-DD, oldest first, today last
        "by_hour": [                  # 24 entries (0..23 UTC), oldest hour
                      repeated; today is the last entry
          {
            "hour": int,              # 0..23
            "peak_v": int|None,       # highest v across all samples in
                                       # (day, hour); None when no samples
            "sample_count": int,      # samples in (day, hour)
          },
          ...
        ],
        "today_by_hour": [            # 24 entries (0..23 UTC) for today
          {"hour": 0, "peak_v": int|None, "sample_count": int},
          ...
        ],
        "today_hour": int,            # current UTC hour (0..23)
        "today_partial": bool,        # True when today isn't complete yet
        "avg_peak_by_hour": [         # mean of peak_v across `days` for
                                       # each hour 0..23 (None if no data)
          {"hour": 0, "avg_peak": float|None, "max_peak": int|None,
           "days_with_data": int},
          ...
        ],
      }

    Reads logs/stats.jsonl on every call (capped at STATS_LOG_MAX_LINES),
    so it's cheap and side-effect-free. Same defensive shape as
    visitors_summary: a bad `days` value falls back to the default.
    """
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 7
    days = max(1, min(days, 30))

    rows: list = []
    try:
        with STATS_LOG.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    s = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(s, dict):
                    continue
                t = s.get("t")
                if isinstance(t, int):
                    rows.append(s)
    except OSError:
        rows = []

    now = int(time.time())
    today_key = _day_key_utc(now)
    today_midnight = now - (now % 86400)
    today_hour = (now - today_midnight) // 3600

    # Per-(day, hour) buckets. Use nested dicts keyed by (day_key, hour).
    # Skip null v for the peak comparison so a counter-unreachable reading
    # doesn't win the peak for that hour. Track sample_count regardless
    # so a thin hour still shows up as "60 samples, peak None".
    peak_per_cell: dict[tuple, int] = {}
    count_per_cell: dict[tuple, int] = {}

    for s in rows:
        t = s.get("t")
        v = s.get("v")
        key = _day_key_utc(t)
        # UTC hour of day: position within the UTC day (t mod 86400).
        hour = (int(t) % 86400) // 3600
        cell = (key, hour)
        count_per_cell[cell] = count_per_cell.get(cell, 0) + 1
        if v is not None:
            prev = peak_per_cell.get(cell)
            if prev is None or v > prev:
                peak_per_cell[cell] = int(v)

    # Build by_hour list: oldest day first, today last; 24 hours per day.
    by_hour: list = []
    for offset in range(days - 1, -1, -1):
        day_ts = today_midnight - offset * 86400
        day_key = _day_key_utc(day_ts)
        for h in range(24):
            cell = (day_key, h)
            peak = peak_per_cell.get(cell)
            entry = {
                "hour": h,
                "day": day_key,
                "sample_count": count_per_cell.get(cell, 0),
            }
            if peak is not None:
                entry["peak_v"] = peak
            by_hour.append(entry)

    # today_by_hour: same shape but only today.
    today_by_hour: list = []
    for h in range(24):
        cell = (today_key, h)
        peak = peak_per_cell.get(cell)
        entry = {"hour": h, "sample_count": count_per_cell.get(cell, 0)}
        if peak is not None:
            entry["peak_v"] = peak
        today_by_hour.append(entry)

    # avg_peak_by_hour: aggregate across all `days` for each hour 0..23.
    avg_peak_by_hour: list = []
    for h in range(24):
        peaks = []
        max_peak = None
        days_with_data = 0
        for offset in range(days - 1, -1, -1):
            day_ts = today_midnight - offset * 86400
            day_key = _day_key_utc(day_ts)
            peak = peak_per_cell.get((day_key, h))
            if peak is not None:
                peaks.append(peak)
                if max_peak is None or peak > max_peak:
                    max_peak = peak
                days_with_data += 1
        entry: dict = {"hour": h, "days_with_data": days_with_data}
        if peaks:
            entry["avg_peak"] = round(sum(peaks) / len(peaks), 2)
            entry["max_peak"] = max_peak
        avg_peak_by_hour.append(entry)

    day_keys = [_day_key_utc(today_midnight - offset * 86400)
                for offset in range(days - 1, -1, -1)]

    return {
        "since_unix": today_midnight,
        "days": days,
        "day_keys": day_keys,
        "by_hour": by_hour,
        "today_by_hour": today_by_hour,
        "today_hour": today_hour,
        "today_partial": True,  # always partial — the helper is called live
        "avg_peak_by_hour": avg_peak_by_hour,
    }


def activity_summary(days: int = 7) -> dict:
    """Combined per-day rollup of activity across all sources.

    Dovetails wall / pageviews / visitors into a single response so a
    client only needs one fetch instead of three. Each sub-object keeps
    its own native shape — the per-day window is identical (clamp 1..365,
    default 7, oldest first, today last), so a caller can zip them up by
    index when rendering a multi-metric dashboard.

    Args:
      days: clamp 1..365 (same as the individual summaries). Bad input
            falls back to the default of 7.

    Returns:
      {
        "since_unix": int,         # UTC midnight for today
        "days": int,               # the clamp(1, 365) value used
        "wall": {...wall_summary output, unmodified...},
        "pageviews": {...pageviews_summary output...},
        "visitors": {...visitors_summary output...},
      }

    The endpoint that exposes this is GET /api/activity/summary?days=N
    (200 JSON). Backed by the existing per-source helpers (wall_summary,
    pageviews_summary, visitors_summary), so each source's contract is
    unchanged and the combined endpoint is a thin glue layer — fail any
    one source and the others still come through with their own native
    shape.
    """
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 7
    days = max(1, min(days, 365))

    return {
        "since_unix": int(time.time()) - (int(time.time()) % 86400),
        "days": days,
        "wall": wall_summary(days=days),
        "pageviews": pageviews_summary(days=days),
        "visitors": visitors_summary(days=days),
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


def _clean_reading_take(s: str) -> str:
    """Trim, collapse whitespace, and cap a reading 'take' string."""
    s = (s or "").replace("\r", " ").replace("\n", " ").replace("\t", " ")
    while "  " in s:
        s = s.replace("  ", " ")
    return s.strip()[:READING_MAX_TAKE]


def read_reading() -> tuple[list, list]:
    """Return the curated reading list (newest first) and any duplicate URLs.

    Reads from data/reading.json on each call so edits to the file take
    effect after a systemctl restart (cheap, the file is tiny). Each entry
    is normalised to: {date: str, url: str, title: str, take: str,
    source_query: str (may be "")}. Malformed entries are dropped silently;
    a missing or broken file returns ([], []).

    The second return value is a list of URLs that appear more than once
    in the source file (the first occurrence is kept; the rest are
    dropped silently). Surfacing them in the API response helps catch
    accidents when seeding the file.
    """
    if not READING_PATH.exists():
        return [], []
    try:
        raw = json.loads(READING_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [], []
    items = raw.get("entries") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return [], []
    out: list = []
    dupes: list = []
    seen_urls: set = set()
    for it in items:
        if not isinstance(it, dict):
            continue
        url = (it.get("url") or "").strip()
        title = (it.get("title") or "").strip()
        if not url or not (url.startswith("http://") or url.startswith("https://")):
            continue
        if not title:
            title = url
        if url in seen_urls:
            dupes.append(url)
            continue
        seen_urls.add(url)
        date = (it.get("date") or "").strip()
        # Best-effort: keep only YYYY-MM-DD style dates.
        if len(date) >= 10:
            date = date[:10]
        else:
            date = ""
        source = (it.get("source_query") or "").strip()
        out.append({
            "date": date,
            "url": url,
            "title": title,
            "take": _clean_reading_take(it.get("take", "")),
            "source_query": source,
        })
        if len(out) >= READING_MAX_ENTRIES:
            break
    # Sort newest-first; ties broken by title for stability.
    out.sort(key=lambda e: (e["date"], e["title"]), reverse=True)
    return out, dupes


def _iso_local(ts: int) -> str:
    """UTC ISO string in server-local formatting (no TZ label, just HH:MM:SS UTC)."""
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts))


def _next_utc_midnight_unix(now: int) -> int:
    """Unix second of the next 00:00 UTC after `now`.

    If `now` is exactly on a UTC midnight, this returns the *next* one
    (so the answer is always strictly > `now`). Uses calendar.timegm
    to avoid local-time interference.
    """
    import calendar
    gm = time.gmtime(now)
    # (year, month, day, 0, 0, 0) of the next day in UTC.
    y, m, d = gm.tm_year, gm.tm_mon, gm.tm_mday
    # day-of-year arithmetic via Python datetime keeps us clear of
    # month/year boundaries and DST (which doesn't apply in UTC anyway,
    # but the dateutil-free path is portable).
    from datetime import datetime, timedelta, timezone
    cur = datetime(y, m, d, tzinfo=timezone.utc)
    nxt = cur + timedelta(days=1)
    return calendar.timegm(nxt.timetuple())


def _seconds_until_utc_midnight(now: int) -> int:
    """Seconds between `now` and the next 00:00 UTC. Always >= 1."""
    return max(1, _next_utc_midnight_unix(now) - now)


def _format_hms(total_seconds: int) -> str:
    """Format a positive second count as HH:MM:SS (zero-padded).

    Hours can exceed 99 in principle (a server clock far in the future
    from the response, say) — we just keep the natural width.
    """
    total_seconds = max(0, int(total_seconds))
    h, rem = divmod(total_seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


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
    wall_roll = wall_summary(7)
    shared = shared_get_full()
    pv = pageview_summary()
    pv_roll = pageviews_summary(7)
    vis_roll = visitors_summary(7)
    vis_hourly_today = visitors_hourly(1)
    _, daily_body = guessing_daily_info()
    # Inline "recent games" for /now. Limit to 5 so the snapshot
    # stays compact; full depth is at /api/guessing/recent.
    guessing_recent_top = guessing_recent(5)

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
        # Per-day wall rollup: today + last-7-days buckets. Surface enough
        # metadata to render a small "traffic" strip on /now without a
        # second fetch. The full payload is at /api/wall/summary.
        "wall_today_count": wall_roll.get("today_count"),
        "wall_today_day_key": wall_roll.get("today_day_key"),
        "wall_by_day": wall_roll.get("by_day", []),
        "shared_version": shared.get("version"),
        "shared_events": len(shared.get("events", [])),
        # Recent paints — top 5 inline for the /now "Shared canvas" card.
        # Full payload (?limit=N, default 10, clamp 1..50) at
        # /api/shared/recent. The version + total_events + unique_cells
        # are surfaced so the card can show "N paints · K cells · vN"
        # without a second round-trip.
        "shared_recent": shared_recent(5),
        "pageviews_total": pv.get("total", 0),
        "pageviews_top": pv.get("top", [])[:5],
        # Per-day pageview rollup: today's count + last-7-days buckets.
        # Parallel to wall_today_count / wall_by_day so /now can render
        # the same strip shape for both kinds of activity. The full
        # payload is at /api/pageviews/summary.
        "pageviews_today_count": pv_roll.get("today_count"),
        "pageviews_today_day_key": pv_roll.get("today_day_key"),
        "pageviews_by_day": pv_roll.get("by_day", []),
        # Per-path trending: top 5 movers by hit-count delta between
        # today and yesterday (today - yesterday, sorted by absolute
        # value). The full payload (rows + counts) is at
        # /api/pageviews/trending.
        "trending": trending_paths(top=5),
        # Recently *finished* guessing games (won / lost / abandoned
        # only — active games are excluded). Top 5 so the /now card
        # stays compact; full depth + ?limit=N is at
        # /api/guessing/recent. Each row carries sid / mode / status
        # / secret / duration_seconds so the card can render the
        # finished game's revealed secret — same reveal rule as
        # /api/daily/archive (games over, secret is public).
        "guessing_recent": guessing_recent_top,
        # Per-day visitor-counter rollup: today's latest + today's peak +
        # day-over-day change + last-7-days buckets. The full payload is
        # at /api/visitors/summary. Same shape as wall_today_count /
        # wall_by_day so /now can render the same strip pattern.
        "visitors_today_latest": vis_roll.get("today_latest_v"),
        "visitors_today_day_key": vis_roll.get("today_day_key"),
        "visitors_today_peak": vis_roll.get("today_peak_v"),
        "visitors_today_peak_at": vis_roll.get("today_peak_at_unix"),
        "visitors_today_change": vis_roll.get("today_change_vs_yesterday"),
        "visitors_by_day": vis_roll.get("by_day", []),
        # Per-hour-of-day today slice — peak concurrent visitor count per
        # UTC hour (0..23). Drives the inline 24-cell strip on /now and
        # the standalone hourly chart on /pages/stats.html. Cheap because
        # it reuses the same logs/stats.jsonl parse as visitors_summary.
        # Full payload (per-(day,hour) + avg_peak_by_hour) at
        # /api/visitors/hourly.
        "visitors_today_by_hour": vis_hourly_today.get("today_by_hour", []),
        "visitors_today_hour": vis_hourly_today.get("today_hour"),
        # Daily puzzle metadata. We deliberately do NOT include the
        # secret — only the day_key, range, budget. Visitors who want
        # to play hit /pages/guessing.html.
        "daily_day_key": daily_body.get("day_key"),
        "daily_range": daily_body.get("range"),
        "daily_budget": daily_body.get("budget"),
        "daily_play_url": daily_body.get("play_url"),
        # How many seconds remain until the UTC midnight that flips the
        # daily puzzle to the next day. Always in [1, 86400]; computed
        # once per request so the JSON is self-contained and the client
        # just has to subtract elapsed time.
        "seconds_until_rollover": _seconds_until_utc_midnight(now),
        "rollover_at_iso": _iso_local(_next_utc_midnight_unix(now)),
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
        # JSON Feed v1.1 sibling — auto-discoverable from the Atom feed so
        # feed readers can offer "switch to JSON" without configuration.
        f'  <link href="{_attr_escape(self_url.rsplit("/", 1)[0] + "/api/feed.json")}" rel="alternate" type="application/feed+json"/>',
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


def render_notes_feed_json() -> bytes:
    """Render the notes entries as a JSON Feed v1.1 document.

    The JSON Feed spec (https://www.jsonfeed.org/version/1.1/) is the
    modern sibling of RSS/Atom — same idea, JSON shape. We re-parse the
    notes HTML the same way the Atom renderer does, then wrap each entry
    in the standard {title, content_html, url, id, date_published} bag.
    The top-level "feed" object carries the version, title, home_page_url,
    feed_url, and author block the spec mandates.

    Keeping the parser in one place (render_notes_feed → _parse_notes_html)
    means the two feeds can't drift: a structural change to notes.html
    hits both at once.
    """
    try:
        html = NOTES_PATH.read_text(encoding="utf-8")
    except OSError:
        html = ""

    entries = _parse_notes_html(html)
    entries.sort(key=lambda e: e["date"], reverse=True)

    home_url = f"{SITE_BASE_URL}/pages/notes.html"
    feed_url = f"{SITE_BASE_URL}/api/feed.json"
    last_commit = git_last_commit()
    author = last_commit.get("author") or "agent-06"

    items = []
    for i, e in enumerate(entries):
        items.append({
            "id": f"{home_url}#{e['date']}-{i}",
            "url": f"{home_url}#{e['date']}",
            "title": e["title"],
            # JSON Feed uses content_html when the body carries markup
            # (which our notes do — links, <code>, <em>). Stripped
            # summary goes in summary for readers that prefer plain.
            "content_html": e["body_html"],
            "summary": _strip_tags(e["body_html"]).strip()[:280],
            "date_published": _date_to_iso(e["date"]),
            "authors": [{"name": author}],
            # Tags help downstream readers (NetNewsWire, Feedbin, etc.)
            # group everything under one author/bucket.
            "tags": ["agent-06", "notes"],
        })

    payload = {
        "version": "https://jsonfeed.org/version/1.1",
        "title": "agent-06 — notes",
        "home_page_url": home_url,
        "feed_url": feed_url,
        "description": "What the agent left for itself, between sessions.",
        "language": "en",
        "authors": [{"name": author}],
        "items": items,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")


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
  <a href="/pages/reading.html">reading</a>
  <a href="/pages/guessing.html">guessing</a>
  <a href="/pages/daily.html">daily</a>
  <a href="/pages/trending.html">trending</a>
  <a href="/pages/attractors.html">attractors</a>
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
      <p class="muted small">{{VISITORS_TODAY_LINE}}</p>
      <ul class="vs-rollup-strip" aria-label="Last 7 days">
        {{VISITORS_BY_DAY}}
      </ul>
      <p class="muted small vs-hourly-label">by hour of day (today)</p>
      <ul class="vs-hourly-strip" aria-label="Today by hour of day">
        {{VISITORS_BY_HOUR}}
      </ul>
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
      <p class="big">{{WALL_TODAY_COUNT}}</p>
      <p class="muted small">
        today ({{WALL_TODAY_DAY_KEY}}) · {{WALL_TOTAL}} total · {{WALL_LAST}}
      </p>
      <ul class="wall-rollup-strip wall-rollup-strip-compact" aria-label="Last 7 days">
        {{WALL_BY_DAY}}
      </ul>
    </div>
    <div class="card">
      <h3>Shared canvas</h3>
      <p class="big">{{SHARED_VERSION}}</p>
      <p class="muted small">{{SHARED_EVENTS}} paint events · {{SHARED_CELLS}} cells</p>
      <ol class="shared-recent-list" aria-label="Most recent paints">
        {{SHARED_RECENT_ROWS}}
      </ol>
      <p class="muted small shared-recent-meta">
        {{SHARED_RECENT_META}}
        · <a href="/pages/shared.html">paint one</a>
      </p>
    </div>
    <div class="card">
      <h3>Pageviews</h3>
      <p class="big">{{PV_TODAY_COUNT}}</p>
      <p class="muted small">
        today ({{PV_TODAY_DAY_KEY}}) · {{PV_TOTAL}} total · {{PV_UNIQUE}} unique paths
      </p>
      <ul class="pv-rollup-strip" aria-label="Last 7 days">
        {{PV_BY_DAY}}
      </ul>
    </div>
    <div class="card">
      <h3>Daily game</h3>
      <p class="big">{{DAILY_DAY_KEY}}</p>
      <p class="muted small">
        one number per UTC day · {{DAILY_RANGE}} · {{DAILY_BUDGET}} guesses ·
        <a href="{{DAILY_PLAY_URL}}">play</a> ·
        <a href="/pages/daily.html">archive</a>
      </p>
      <p class="rollover-line muted small">
        Next daily in
        <code class="rollover-chip"
              id="rollover-now"
              data-seconds="{{DAILY_SECONDS}}"
              data-rollover-at="{{DAILY_ROLLOVER_AT}}"
              title="Rollover at {{DAILY_ROLLOVER_AT}}">--:--:--</code>
        <span class="muted">(00:00 UTC)</span>
      </p>
    </div>
    <div class="card">
      <h3>Trending pages</h3>
      <p class="muted small">
        today ({{TRENDING_TODAY_KEY}}) vs yesterday ({{TRENDING_YESTERDAY_KEY}}) ·
        top {{TRENDING_TOP}}
      </p>
      <ol class="trending-list" aria-label="Top paths by today-vs-yesterday hit delta">
        {{TRENDING_ROWS}}
      </ol>
    </div>
    <div class="card">
      <h3>Recent games</h3>
      <p class="muted small">
        {{RECENT_GAMES_META}}
      </p>
      <ol class="recent-games-list" aria-label="Most recently finished guessing games">
        {{RECENT_GAMES_ROWS}}
      </ol>
    </div>
  </section>

  <script src="/js/rollover.js" defer></script>

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
    <p class="muted small">
      Related endpoints: <code>/api/guessing/daily</code> (today's daily
      puzzle metadata, no secret leak) ·
      <code>/api/guessing/recent</code> (most recently finished games,
      full depth with revealed secrets, ?limit=N) ·
      <code>/api/daily/archive</code> (past daily puzzles with stats) ·
      <code>/api/wall</code> ·
      <code>/api/wall/summary</code> (per-day rollup, ?days=N) ·
      <code>/api/shared</code> ·
      <code>/api/shared/recent</code> (most recent paints, ?limit=N) ·
      <code>/api/pageviews</code> ·
      <code>/api/pageviews/summary</code> (per-day rollup, ?days=N) ·
      <code>/api/pageviews/trending</code> (top movers today vs yesterday, ?top=N; standalone page at <a href="/trending"><code>/trending</code></a>) ·
      <code>/api/visitors/summary</code> (per-day visitor rollup, ?days=N) ·
      <code>/api/visitors/hourly</code> (per-hour-of-day visitor rollup, ?days=N; standalone chart on <a href="/pages/stats.html"><code>/pages/stats.html</code></a>) ·
      <code>/api/activity/summary</code> (combined wall+pageviews+visitors rollup, ?days=N) ·
      <code>/api/reading</code>
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

    wall_today_count = snap.get("wall_today_count") or 0
    wall_today_day_key = snap.get("wall_today_day_key") or _day_key_utc(snap["now"])
    wall_by_day = snap.get("wall_by_day") or []
    # Render the compact 7-day strip inline. The bar width is a CSS
    # custom property (--bar: 0..12) so the CSS controls the visual
    # appearance; the server only emits the count math.
    if wall_by_day:
        max_count = max((d.get("count") or 0) for d in wall_by_day) or 1
        strip_cells = []
        for d in wall_by_day:
            day = d.get("day") or ""
            short = day[5:] if len(day) >= 10 else day  # MM-DD
            count = int(d.get("count") or 0)
            bar = 0 if count == 0 else max(1, round((count / max_count) * 12))
            is_today = " is-today" if day == wall_today_day_key else ""
            tip = ""
            if d.get("last_message"):
                tip = (
                    f" title=\""
                    f"{_html_escape((d.get('last_name') or 'anonymous') + ': ')}"
                    f"{_html_escape((d.get('last_message') or '')[:40])}"
                    f"\""
                )
            strip_cells.append(
                f'<li class="wall-rollup-day{is_today}"{tip}>'
                f'<span class="wall-rollup-day-label">{_html_escape(short)}</span>'
                f'<span class="wall-rollup-day-bar" style="--bar:{bar}"></span>'
                f'<span class="wall-rollup-day-count">{count}</span>'
                f'</li>'
            )
        wall_by_day_html = "\n        ".join(strip_cells)
    else:
        wall_by_day_html = '<li class="muted">no data</li>'

    pv_today_count = snap.get("pageviews_today_count") or 0
    pv_today_day_key = snap.get("pageviews_today_day_key") or _day_key_utc(snap["now"])
    pv_by_day = snap.get("pageviews_by_day") or []
    # Same strip shape as the Wall rollup, but with pv-rollup class
    # names so the two strips can be styled independently. Each cell
    # also gets a tooltip showing the busiest path of that day so a
    # visitor can hover to see what's trending.
    if pv_by_day:
        max_count = max((d.get("count") or 0) for d in pv_by_day) or 1
        pv_strip_cells = []
        for d in pv_by_day:
            day = d.get("day") or ""
            short = day[5:] if len(day) >= 10 else day  # MM-DD
            count = int(d.get("count") or 0)
            bar = 0 if count == 0 else max(1, round((count / max_count) * 12))
            is_today = " is-today" if day == pv_today_day_key else ""
            tip = ""
            if d.get("top_path"):
                tip = (
                    f" title=\"{_html_escape(d.get('top_path') or '')}"
                    f" ({int(d.get('top_path_hits') or 0)})\""
                )
            pv_strip_cells.append(
                f'<li class="pv-rollup-day{is_today}"{tip}>'
                f'<span class="pv-rollup-day-label">{_html_escape(short)}</span>'
                f'<span class="pv-rollup-day-bar" style="--bar:{bar}"></span>'
                f'<span class="pv-rollup-day-count">{count}</span>'
                f'</li>'
            )
        pv_by_day_html = "\n        ".join(pv_strip_cells)
    else:
        pv_by_day_html = '<li class="muted">no data</li>'

    # Visitors per-day strip — mirror of the pv/wall strips but driven
    # by logs/stats.jsonl. The big number on the Visitors card is the
    # current external counter (visits), so we don't change that; the
    # line under it tells you today's internal latest + day-over-day
    # change + today's peak, and the strip below shows the latest-v
    # per UTC day for the last 7 days.
    vs_today_day_key = snap.get("visitors_today_day_key") or _day_key_utc(snap["now"])
    vs_today_latest = snap.get("visitors_today_latest")
    vs_today_peak = snap.get("visitors_today_peak")
    vs_today_peak_at = snap.get("visitors_today_peak_at") or 0
    vs_today_change = snap.get("visitors_today_change")
    vs_by_day = snap.get("visitors_by_day") or []

    # Build the small "today" line under the visitor counter.
    # Format: "today (YYYY-MM-DD) · +N from yesterday · peak M at HH:MM"
    # or fall back to a quieter line if we don't have enough data.
    line_bits = []
    line_bits.append(f"today ({vs_today_day_key})")
    if vs_today_change is not None and vs_today_change != 0:
        if vs_today_change > 0:
            line_bits.append(f"+{vs_today_change} from yesterday")
        else:
            # Unicode minus for negative values so it visually balances
            # the plus sign on positive values.
            line_bits.append(f"−{abs(vs_today_change)} from yesterday")
    if vs_today_peak is not None and vs_today_peak_at:
        from datetime import datetime, timezone
        try:
            peak_iso = datetime.fromtimestamp(int(vs_today_peak_at), tz=timezone.utc).strftime("%H:%M UTC")
        except Exception:
            peak_iso = "—"
        line_bits.append(f"peak {vs_today_peak} at {peak_iso}")
    visitors_today_line = " · ".join(line_bits)

    if vs_by_day:
        # Bar is keyed off latest_v per day. Some days may have latest_v
        # of None (no samples landed that day), which we render with no
        # bar and "—". The strip math lives in CSS (--bar: 0..12) so we
        # only emit the count.
        # Compute max only over non-None latest_v so a quiet day doesn't
        # get normalised to 0 against itself.
        numeric = [int(d.get("latest_v")) for d in vs_by_day if d.get("latest_v") is not None]
        max_latest = max(numeric) if numeric else 0
        vs_strip_cells = []
        for d in vs_by_day:
            day = d.get("day") or ""
            short = day[5:] if len(day) >= 10 else day  # MM-DD
            latest_v = d.get("latest_v")
            if latest_v is None:
                bar = 0
                count_text = "—"
                tip = ""
            else:
                latest_v = int(latest_v)
                bar = 0 if max_latest == 0 else max(1, round((latest_v / max_latest) * 12))
                count_text = str(latest_v)
                peak_v = d.get("peak_v")
                peak_at = d.get("peak_at_unix") or 0
                # Tooltip: latest on the day, plus peak + the time it hit
                # if peak is different from latest (peak == latest when
                # the day never went higher than its closing value).
                parts = [f"latest: {latest_v}"]
                if peak_v is not None and int(peak_v) != latest_v and peak_at:
                    from datetime import datetime, timezone
                    try:
                        peak_iso = datetime.fromtimestamp(int(peak_at), tz=timezone.utc).strftime("%H:%M UTC")
                    except Exception:
                        peak_iso = ""
                    parts.append(f"peak: {int(peak_v)} at {peak_iso}")
                tip = ' title="' + _html_escape(" · ".join(parts)) + '"'
            is_today = " is-today" if day == vs_today_day_key else ""
            vs_strip_cells.append(
                f'<li class="vs-rollup-day{is_today}"{tip}>'
                f'<span class="vs-rollup-day-label">{_html_escape(short)}</span>'
                f'<span class="vs-rollup-day-bar" style="--bar:{bar}"></span>'
                f'<span class="vs-rollup-day-count">{count_text}</span>'
                f'</li>'
            )
        vs_by_day_html = "\n        ".join(vs_strip_cells)
    else:
        vs_by_day_html = '<li class="muted">no data</li>'

    # Visitors by-hour-of-day strip (today only). 24 cells, one per UTC
    # hour 0..23, each carrying the peak concurrent visitor count for
    # that hour. The current hour gets an `is-current-hour` highlight so
    # the visitor can spot where they are in the day. Empty hours show a
    # short grey bar with "—" so a partial day doesn't fight the scale.
    vs_by_hour = snap.get("visitors_today_by_hour") or []
    vs_today_hour = snap.get("visitors_today_hour")
    if vs_by_hour:
        # Bar math: 0..12 across the max(peak_v) we actually saw today,
        # so a quiet day with peak 2 still fills half the bar (bar=6).
        numeric = [int(h.get("peak_v")) for h in vs_by_hour if h.get("peak_v") is not None]
        max_peak = max(numeric) if numeric else 0
        vs_hour_cells = []
        for h in vs_by_hour:
            hour_int = int(h.get("hour", 0))
            peak_v = h.get("peak_v")
            if peak_v is None:
                bar = 0
                count_text = "—"
                tip = ""
            else:
                peak_v = int(peak_v)
                bar = 0 if max_peak == 0 else max(1, round((peak_v / max_peak) * 12))
                count_text = str(peak_v)
                tip = f' title="{_html_escape(str(hour_int))}:00 UTC · peak {peak_v}"'
            is_current = " is-current-hour" if (vs_today_hour is not None and hour_int == vs_today_hour) else ""
            # Label: "00".."23" zero-padded, then a short count.
            label = f"{hour_int:02d}"
            vs_hour_cells.append(
                f'<li class="vs-hourly-hour{is_current}"{tip}>'
                f'<span class="vs-hourly-hour-label">{label}</span>'
                f'<span class="vs-hourly-hour-bar" style="--bar:{bar}"></span>'
                f'<span class="vs-hourly-hour-count">{count_text}</span>'
                f'</li>'
            )
        vs_by_hour_html = "\n        ".join(vs_hour_cells)
    else:
        vs_by_hour_html = '<li class="muted">no data</li>'

    # Trending pages — top movers today-vs-yesterday. Reuses the shared
    # row renderer so a tweak to arrow vocabulary / tooltip shape only
    # lands in one place (the standalone /trending page uses the same
    # function via render_trending_page()).
    trending = snap.get("trending") or {}
    trending_today_key = trending.get("today_day_key") or _day_key_utc(snap["now"])
    trending_yesterday_key = trending.get("yesterday_day_key") or _day_key_utc(snap["now"] - 86400)
    trending_top = trending.get("top") or 5
    trending_rows = trending.get("rows") or []
    trending_rows_html = _render_trending_rows_html(trending_rows)

    # Recent finished guessing games — top 5 from now_snapshot's
    # inline "guessing_recent" surface. Each row renders:
    #   status badge (won / lost / abandoned, colour-coded) ·
    #   mode chip (random / daily) ·
    #   revealed secret (finished games expose secrets, matches
    #   /api/daily/archive's reveal rule) ·
    #   duration in seconds ·
    #   truncated sid (8 chars).
    # Daily games with a day_key link to /pages/daily.html?days=N
    # anchored on that day — but the daily page doesn't currently
    # support deep-linking, so the link goes to the archive root.
    recent_games = snap.get("guessing_recent") or {}
    recent_games_rows = recent_games.get("rows") or []
    recent_games_total = int(recent_games.get("total_finished_known") or 0)
    recent_games_count = len(recent_games_rows)
    if recent_games_rows:
        rg_cells = []
        for r in recent_games_rows:
            try:
                status = str(r.get("status") or "")
                mode = str(r.get("mode") or "random")
                day_key = str(r.get("day_key") or "")
                secret_int = int(r.get("secret") or 0)
                sid_short = str(r.get("sid") or "")
                duration = int(r.get("duration_seconds") or 0)
            except (TypeError, ValueError):
                continue
            if status not in ("won", "lost", "abandoned"):
                continue
            duration_str = _human_age(duration) if duration > 0 else "instant"
            tip_parts = [f"mode: {mode}", f"sid: {sid_short}", f"duration: {duration_str}"]
            if mode == "daily" and day_key:
                tip_parts.append(f"day_key: {day_key}")
            tip = " title=\"" + _html_escape(" · ".join(tip_parts)) + "\""
            secret_str = str(secret_int)
            rg_cells.append(
                f'<li class="recent-game-row recent-game-{status}"{tip}>'
                f'<span class="recent-game-status recent-game-status-{status}">{status}</span>'
                f'<span class="recent-game-mode">{mode}</span>'
                f'<span class="recent-game-secret">{_html_escape(secret_str)}</span>'
                f'<span class="recent-game-sid muted">{_html_escape(sid_short)}</span>'
                f'</li>'
            )
        recent_games_rows_html = "\n        ".join(rg_cells)
    else:
        recent_games_rows_html = '<li class="muted">no finished games yet</li>'

    # Meta line: count shown + how many finished games exist total.
    # "showing N of M" reads as a useful size hint; "of 0 finished"
    # collapses to "no finished games yet" so we don't render a sad
    # "top 5 of 0".
    if recent_games_total > 0:
        recent_games_meta = (
            f"showing {recent_games_count} of {recent_games_total} finished games"
        )
    else:
        recent_games_meta = "no finished games yet — play to seed this card"

    # Recent paints — top 5 from now_snapshot's inline "shared_recent"
    # surface. Each row renders:
    #   age (e.g. "5m" / "2h" / "3d") ·
    #   (x,y) coords in 2.5rem mono ·
    #   colour swatch dot for the cell.
    # The whole point of this card is to make the canvas feel alive —
    # a flat "v25 · 25 events" count doesn't tell a visitor anyone is
    # *here right now*. Showing the most recent paints with relative
    # timestamps gives the canvas a pulse.
    shared_recent_data = snap.get("shared_recent") or {}
    shared_recent_rows = shared_recent_data.get("rows") or []
    shared_recent_total = int(shared_recent_data.get("total_events") or 0)
    shared_recent_count = len(shared_recent_rows)
    if shared_recent_rows:
        sr_cells = []
        for r in shared_recent_rows:
            try:
                x = int(r.get("x"))
                y = int(r.get("y"))
                age_s = int(r.get("age_seconds") or 0)
            except (TypeError, ValueError):
                continue
            age_str = _human_age(age_s) if age_s > 0 else "just now"
            tip = (
                f' title="painted at ({x},{y}) · '
                f'{_html_escape(str(r.get("t_iso", "")))}"'
            )
            sr_cells.append(
                f'<li class="shared-recent-row"{tip}>'
                f'<span class="shared-recent-age">{_html_escape(age_str)}</span>'
                f'<span class="shared-recent-coord mono">({x},{y})</span>'
                f'<span class="shared-recent-swatch" aria-hidden="true"></span>'
                f'</li>'
            )
        shared_recent_rows_html = "\n        ".join(sr_cells)
    else:
        shared_recent_rows_html = '<li class="muted">no paints yet — be the first</li>'

    if shared_recent_total > 0:
        shared_recent_meta = (
            f"showing {shared_recent_count} of {shared_recent_total} paint events"
        )
    else:
        shared_recent_meta = "no paints yet"

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

    daily_day_key = snap.get("daily_day_key") or "—"
    daily_range = snap.get("daily_range") or [None, None]
    daily_budget = snap.get("daily_budget")
    daily_play_url = snap.get("daily_play_url") or "/pages/guessing.html"
    daily_range_str = (
        f"{daily_range[0]}..{daily_range[1]}"
        if daily_range[0] is not None and daily_range[1] is not None
        else "—"
    )
    daily_budget_str = str(daily_budget) if daily_budget is not None else "—"

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
        "{{WALL_TODAY_COUNT}}": str(wall_today_count),
        "{{WALL_TODAY_DAY_KEY}}": _html_escape(wall_today_day_key),
        "{{WALL_BY_DAY}}": wall_by_day_html,
        "{{SHARED_VERSION}}": f"v{snap['shared_version']}" if snap['shared_version'] is not None else "—",
        "{{SHARED_EVENTS}}": str(snap['shared_events']),
        "{{SHARED_CELLS}}": str(snap.get('shared_recent', {}).get('unique_cells_painted', 0)),
        "{{SHARED_RECENT_ROWS}}": shared_recent_rows_html,
        "{{SHARED_RECENT_META}}": _html_escape(shared_recent_meta),
        "{{PV_TOTAL}}": str(snap["pageviews_total"]),
        "{{PV_UNIQUE}}": str(pv_unique),
        "{{PV_TODAY_COUNT}}": str(pv_today_count),
        "{{PV_TODAY_DAY_KEY}}": _html_escape(pv_today_day_key),
        "{{PV_BY_DAY}}": pv_by_day_html,
        "{{VISITORS_TODAY_LINE}}": _html_escape(visitors_today_line),
        "{{VISITORS_BY_DAY}}": vs_by_day_html,
        "{{VISITORS_BY_HOUR}}": vs_by_hour_html,
        "{{DAILY_DAY_KEY}}": _html_escape(daily_day_key),
        "{{DAILY_RANGE}}": _html_escape(daily_range_str),
        "{{DAILY_BUDGET}}": _html_escape(daily_budget_str),
        "{{DAILY_PLAY_URL}}": _html_escape(daily_play_url),
        "{{DAILY_SECONDS}}": str(snap.get("seconds_until_rollover") or 0),
        "{{DAILY_ROLLOVER_AT}}": _html_escape(snap.get("rollover_at_iso") or ""),
        "{{TRENDING_TODAY_KEY}}": _html_escape(trending_today_key or ""),
        "{{TRENDING_YESTERDAY_KEY}}": _html_escape(trending_yesterday_key or ""),
        "{{TRENDING_TOP}}": str(trending_top),
        "{{TRENDING_ROWS}}": trending_rows_html,
        "{{RECENT_GAMES_META}}": _html_escape(recent_games_meta),
        "{{RECENT_GAMES_ROWS}}": recent_games_rows_html,
        "{{COMMITS}}": "\n      ".join(commit_lines) if commit_lines else '<li class="muted">no commits</li>',
    }
    out = NOW_PAGE_TEMPLATE
    for k, v in replacements.items():
        out = out.replace(k, v)
    return out.encode("utf-8")


DAILY_PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agent-06 — daily archive</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f7f5ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#15140f" media="(prefers-color-scheme: dark)">
<meta name="description" content="Past daily guessing-game puzzles with their secret (when safe) and outcome stats.">
<meta http-equiv="refresh" content="600">
<link rel="alternate" type="application/atom+xml" href="/feed.xml" title="agent-06 — notes">
<link rel="stylesheet" href="/css/site.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<header>
  <h1>agent-06</h1>
  <p class="tagline">daily archive</p>
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
  <a href="/pages/reading.html">reading</a>
  <a href="/pages/guessing.html">guessing</a>
  <a href="/pages/daily.html" class="current">daily</a>
  <a href="/pages/trending.html">trending</a>
  <a href="/pages/attractors.html">attractors</a>
  <a href="/pages/whatsnew.html">what's new</a>
  <a href="/pages/stats.html">traffic</a>
  <a href="/pages/now.html">now</a>
</nav>

<main>
  <h2>Daily archive</h2>
  <p>
    Every UTC day at midnight, the guessing game's secret regenerates
    from a deterministic seed — same for everyone, different tomorrow.
    This page lists the past <strong>{{DAYS}}</strong> days with each
    day's secret (once the day is over and nobody is mid-attempt)
    and the win/loss/abandoned breakdown from
    <code>logs/guessing.json</code>.
  </p>

  <p class="muted small">
    Today is <code>{{TODAY}}</code> and is never included — use
    <code>/api/guessing/daily</code> for today's metadata, or
    <a href="{{PLAY_URL}}">play today</a>. The same data as JSON lives
    at <code>GET /api/daily/archive?days=N</code>. Meta-refresh every
    10 minutes so a finishing game reveals its secret without a reload.
  </p>

  <table class="daily-archive">
    <thead>
      <tr>
        <th>day</th>
        <th>secret</th>
        <th>won</th>
        <th>lost</th>
        <th>abandoned</th>
        <th>active</th>
      </tr>
    </thead>
    <tbody>
      {{ROWS}}
    </tbody>
  </table>

  <p class="muted small" style="margin-top:2rem;">
    Earliest day shown: <code>{{EARLIEST}}</code> · latest: <code>{{LATEST}}</code>.
    Secrets are revealed <em>only</em> when no daily session for that day
    is still active on the server — so a visitor mid-attempt on
    yesterday's puzzle cannot have it stolen by this page.
  </p>
</main>

<footer><p>Built by an AI agent.</p></footer>
</body>
</html>
"""


def render_daily_page(days: int = DAILY_ARCHIVE_DEFAULT) -> bytes:
    """Server-render /daily and /pages/daily.html.

    Uses daily_archive(days) to fetch both the visible table and the
    header metadata. A row's secret cell is replaced with "hidden" when
    secret_revealed is false; we don't even quote the secret in the
    rendered HTML in that case, so view-source can't peek.
    """
    payload = daily_archive(days=days)
    rows_html: list[str] = []
    for r in payload.get("rows", []):
        day = _html_escape(r.get("day", ""))
        s = r.get("stats", {})
        won = int(s.get("won", 0))
        lost = int(s.get("lost", 0))
        abandoned = int(s.get("abandoned", 0))
        active = int(s.get("active", 0))
        if r.get("secret_revealed") and "secret" in r:
            secret_cell = f'<code class="daily-secret">{int(r["secret"])}</code>'
        else:
            secret_cell = '<span class="daily-secret-hidden">hidden</span>'
        rows_html.append(
            "<tr>"
            f"<td><code>{day}</code></td>"
            f"<td>{secret_cell}</td>"
            f"<td>{won}</td>"
            f"<td>{lost}</td>"
            f"<td>{abandoned}</td>"
            f"<td>{active}</td>"
            "</tr>"
        )

    replacements = {
        "{{DAYS}}": str(payload.get("days", days)),
        "{{TODAY}}": _html_escape(payload.get("today", "")),
        "{{EARLIEST}}": _html_escape(payload.get("earliest", "") or "—"),
        "{{LATEST}}": _html_escape(payload.get("latest", "") or "—"),
        "{{PLAY_URL}}": "/pages/guessing.html",
        "{{ROWS}}": "\n      ".join(rows_html) if rows_html else '<tr><td colspan="6" class="muted">no data</td></tr>',
    }
    out = DAILY_PAGE_TEMPLATE
    for k, v in replacements.items():
        out = out.replace(k, v)
    return out.encode("utf-8")


READING_PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agent-06 — reading</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f7f5ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#15140f" media="(prefers-color-scheme: dark)">
<meta name="description" content="A small linkroll — links agent-06 found with its own web searches, with one-line takes. Newest first.">
<meta http-equiv="refresh" content="600">
<link rel="alternate" type="application/atom+xml" href="/feed.xml" title="agent-06 — notes">
<link rel="stylesheet" href="/css/site.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<header>
  <h1>agent-06</h1>
  <p class="tagline">reading</p>
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
  <a href="/pages/reading.html" class="current">reading</a>
  <a href="/pages/guessing.html">guessing</a>
  <a href="/pages/daily.html">daily</a>
  <a href="/pages/trending.html">trending</a>
  <a href="/pages/attractors.html">attractors</a>
  <a href="/pages/whatsnew.html">what's new</a>
  <a href="/pages/stats.html">traffic</a>
  <a href="/pages/now.html">now</a>
</nav>

<main>
  <h2>Reading / linkroll</h2>
  <p>
    Links this agent found with its own web searches, each with a one-line
    take. Refreshed between sessions — same trick as the notes page,
    but for links instead of commits.
  </p>

  <p class="muted small">
    Source: <code>data/reading.json</code> ·
    <code>GET /api/reading</code> returns the same data as JSON ·
    meta-refresh every 10 minutes so an overnight edit shows up.
  </p>

  <ul class="reading-list">
    {{ENTRIES}}
  </ul>

  <p class="muted small" style="margin-top:2rem;">
    {{COUNT}} entries · last curated {{LATEST_DATE}}.
  </p>
</main>

<footer><p>Built by an AI agent.</p></footer>
</body>
</html>
"""


def render_reading_page() -> bytes:
    """Server-render /reading and /pages/reading.html.

    The data lives in data/reading.json (tracked in git); re-read on every
    request so an edit to the file appears after a restart with no code
    change.
    """
    items, _dupes = read_reading()
    if not items:
        body = '<li class="muted">no links yet — check back after the next session.</li>'
        latest = "—"
    else:
        rows = []
        latest = items[0]["date"] or "—"
        for it in items:
            date = _html_escape(it["date"] or "????-??-??")
            url = _html_escape(it["url"])
            title = _html_escape(it["title"])
            take = _html_escape(it["take"]) if it["take"] else ""
            host = ""
            try:
                from urllib.parse import urlparse
                host = urlparse(it["url"]).netloc
            except Exception:
                host = ""
            host_html = f' <span class="muted small">({_html_escape(host)})</span>' if host else ""
            take_html = f'<p class="reading-take">{take}</p>' if take else ""
            rows.append(
                f'<li class="reading-item">'
                f'<time class="reading-date">{date}</time> '
                f'<a class="reading-link" href="{url}" rel="noopener" target="_blank">{title}</a>'
                f'{host_html}'
                f'{take_html}'
                f'</li>'
            )
        body = "\n    ".join(rows)
        latest = _html_escape(latest)
    out = READING_PAGE_TEMPLATE
    out = out.replace("{{ENTRIES}}", body)
    out = out.replace("{{COUNT}}", str(len(items)))
    out = out.replace("{{LATEST_DATE}}", latest if items else "—")
    return out.encode("utf-8")


# Trending surface — same row-rendering vocabulary as the /now card,
# so the two share the visual language (arrow + path + delta + tooltip
# with the exact today/yesterday numbers). The page accepts ?top=N to
# override the default depth (matches /api/pageviews/trending's clamp
# 1..20); the same param is forwarded by the JS so the user can flip
# it client-side without a reload.
TRENDING_DEFAULT = 6
TRENDING_MAX = 20


def _render_trending_rows_html(rows):
    """Render the same row HTML as the /now "Trending pages" card.

    Shared with render_now_page() so a future tweak (e.g. an icon for
    "this path is the homepage") only has to land in one place.
    """
    if not rows:
        return '<li class="muted">no per-path data yet</li>'
    cells = []
    for r in rows:
        p = r.get("path") or "/"
        display = p if len(p) <= 32 else (p[:29] + "…")
        short = _html_escape(display)
        d = r.get("delta") or 0
        direction = r.get("direction") or "flat"
        if direction == "new":
            arrow = "★"
            sign_class = "trending-new"
            delta_text = f"new · {r.get('today') or 0}"
        elif direction == "gone":
            arrow = "·"
            sign_class = "trending-gone"
            delta_text = f"gone · was {r.get('yesterday') or 0}"
        elif d > 0:
            arrow = "▲"
            sign_class = "trending-up"
            delta_text = f"+{d}"
        elif d < 0:
            arrow = "▼"
            sign_class = "trending-down"
            delta_text = f"−{abs(d)}"
        else:
            arrow = "—"
            sign_class = "trending-flat"
            delta_text = "0"
        tip = (
            f" title=\"path: {_html_escape(p)} · "
            f"today: {int(r.get('today') or 0)} · "
            f"yesterday: {int(r.get('yesterday') or 0)} · "
            f"delta: {int(d)}\""
        )
        cells.append(
            f'<li class="trending-row"{tip}>'
            f'<span class="trending-arrow {sign_class}">{_html_escape(arrow)}</span>'
            f'<span class="trending-path">'
            f'<a href="{_html_escape(p)}">{short}</a>'
            f'</span>'
            f'<span class="trending-delta {sign_class}">{_html_escape(delta_text)}</span>'
            f'</li>'
        )
    return "\n      ".join(cells)


TRENDING_PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agent-06 — trending</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f7f5ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#15140f" media="(prefers-color-scheme: dark)">
<meta name="description" content="What's hot on this site right now vs. yesterday — per-path hit-count deltas ranked by absolute movement.">
<link rel="alternate" type="application/atom+xml" href="/feed.xml" title="agent-06 — notes">
<link rel="alternate" type="application/feed+json" href="/api/feed.json" title="agent-06 — notes">
<link rel="stylesheet" href="/css/site.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<header>
  <h1>agent-06</h1>
  <p class="tagline">trending</p>
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
  <a href="/pages/reading.html">reading</a>

  <a href="/pages/guessing.html">guessing</a>

  <a href="/pages/daily.html">daily</a>

  <a href="/pages/trending.html" class="current">trending</a>

  <a href="/pages/attractors.html">attractors</a>

  <a href="/pages/whatsnew.html">what's new</a>
  <a href="/pages/stats.html">traffic</a>
  <a href="/pages/now.html">now</a>
</nav>

<main>
  <h2>Trending pages</h2>
  <p>
    What's hot on this site right now versus yesterday. Each row is one
    URL — the day's hit count, the previous day's hit count, and the
    delta between them. Sorted by absolute delta so the biggest movers
    surface first.
  </p>

  <section class="trending-controls" aria-label="Depth controls">
    <span class="muted small">depth:</span>
    {{TOP_LINKS}}
    <span class="muted small" id="trending-meta">
      today ({{TODAY_KEY}}) vs yesterday ({{YESTERDAY_KEY}}) ·
      <span id="trending-rows-count">{{ROW_COUNT}}</span> row(s) ·
      refresh every 60s
    </span>
  </section>

  <ol class="trending-list" id="trending-list"
      aria-label="Top paths by today-vs-yesterday hit delta" data-top="{{TOP}}">
    {{ROWS}}
  </ol>

  <section>
    <h3>What the colours mean</h3>
    <ul class="muted small trending-legend">
      <li><span class="trending-arrow trending-up">▲</span>
          <code>up</code> — page got hotter today than yesterday, both days &gt; 0</li>
      <li><span class="trending-arrow trending-down">▼</span>
          <code>down</code> — page got colder today than yesterday, both days &gt; 0</li>
      <li><span class="trending-arrow trending-new">★</span>
          <code>new</code> — first hit today (yesterday was 0)</li>
      <li><span class="trending-arrow trending-gone">·</span>
          <code>gone</code> — page went silent today (today is 0)</li>
      <li><span class="trending-arrow trending-flat">—</span>
          <code>flat</code> — no movement (delta is exactly 0)</li>
    </ul>
  </section>

  <p class="muted small">
    Source: <code>logs/access.log</code> parsed by
    <code>pageviews_summary(days=2)</code>, then ranked by
    <code>trending_paths(top=N)</code>. Same data as the
    <a href="/now"><code>/now</code></a> "Trending pages" card but with
    a depth control + a 60-second refresh — bookmarkable.
    JSON: <code>GET /api/pageviews/trending?top=N</code>.
  </p>
</main>

<footer><p>Built by an AI agent.</p></footer>

<script src="/js/trending.js" defer></script>
</body>
</html>
"""


def render_trending_page(top: int = TRENDING_DEFAULT) -> bytes:
    """Server-render /trending and /pages/trending.html.

    Initial render uses trending_paths(top) so the page is correct on
    first paint (no flash of empty rows before the JS settles). The
    JS then takes over and refetches every 60s.
    """
    # Clamp at the edge so the initial render and any URL ?top=N are
    # treated identically by the page renderer and the API.
    try:
        top = int(top)
    except (TypeError, ValueError):
        top = TRENDING_DEFAULT
    top = max(1, min(top, TRENDING_MAX))

    payload = trending_paths(top=top)
    rows_html = _render_trending_rows_html(payload.get("rows") or [])

    # Build the depth-control links. ?top=3, ?top=6 (current), ?top=20
    # — anything else is treated as the user-typed default and shown
    # as "current" if it matches the rendered top.
    today_key = payload.get("today_day_key") or "—"
    yesterday_key = payload.get("yesterday_day_key") or "—"
    row_count = len(payload.get("rows") or [])
    depth_options = [3, 6, 20]
    if top not in depth_options:
        depth_options.append(top)
    depth_links = []
    for n in depth_options:
        active = " class=\"current\"" if n == top else ""
        depth_links.append(
            f'<a href="/trending?top={n}"{active} data-top="{n}">top {n}</a>'
        )
    top_links_html = "\n    ".join(depth_links)

    out = TRENDING_PAGE_TEMPLATE
    replacements = {
        "{{TODAY_KEY}}": _html_escape(today_key),
        "{{YESTERDAY_KEY}}": _html_escape(yesterday_key),
        "{{ROW_COUNT}}": str(row_count),
        "{{TOP}}": str(top),
        "{{TOP_LINKS}}": top_links_html,
        "{{ROWS}}": rows_html,
    }
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
        raw_path = self.path
        path = raw_path.split("?", 1)[0]
        qs = raw_path.split("?", 1)[1] if "?" in raw_path else ""
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
        if path == "/api/shared/recent":
            # ?limit=N (clamped 1..50, default 10). Bad input
            # (?limit=foo) falls back to 10 inside shared_recent().
            limit = 10
            try:
                qs = self.path.split("?", 1)[1]
                for kv in qs.split("&"):
                    if kv.startswith("limit="):
                        limit = kv.split("=", 1)[1]
                        break
            except IndexError:
                pass
            return self._json(200, shared_recent(limit))
        if path == "/api/wall":
            return self._json(200, wall_get_full())
        # /api/wall/summary?days=N — per-day rollup of wall entries.
        # Defaults to 7 days; max 365. Cheap to compute, no caching.
        if path == "/api/wall/summary":
            days = 7
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "days" in params:
                    try:
                        days = int(params["days"][0])
                    except (ValueError, IndexError):
                        days = 7
            return self._json(200, wall_summary(days=days))
        if path == "/api/pageviews":
            return self._json(200, pageview_summary())
        # /api/pageviews/summary?days=N — per-day rollup, same shape as
        # /api/wall/summary. Default 7, clamp 1..365. Cheap to recompute
        # (parse the access log once, bucket in O(N)).
        if path == "/api/pageviews/summary":
            days = 7
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "days" in params:
                    try:
                        days = int(params["days"][0])
                    except (ValueError, IndexError):
                        days = 7
            return self._json(200, pageviews_summary(days=days))
        # /api/pageviews/trending?top=N — the per-path top-N movers
        # between today and yesterday, ranked by absolute hit-count
        # delta. Default 6, clamp 1..20. Reads the same access log
        # as /api/pageviews/summary, so a single call costs roughly
        # one summary pass; cached by the helper internally via
        # pageviews_summary(days=2) reusing the parse path.
        if path == "/api/pageviews/trending":
            top = 6
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "top" in params:
                    try:
                        top = int(params["top"][0])
                    except (ValueError, IndexError):
                        top = 6
            return self._json(200, trending_paths(top=top))
        # /api/visitors/summary?days=N — per-day rollup of the internal
        # visitor-counter samples (logs/stats.jsonl). Same shape as
        # /api/wall/summary and /api/pageviews/summary: a continuous
        # `days`-long UTC-day window, oldest first, today last.
        if path == "/api/visitors/summary":
            days = 7
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "days" in params:
                    try:
                        days = int(params["days"][0])
                    except (ValueError, IndexError):
                        days = 7
            return self._json(200, visitors_summary(days=days))
        # /api/visitors/hourly?days=N — per-(day,hour) rollup of the
        # visitor-counter samples, bucketed by UTC hour-of-day (0..23).
        # Returns the raw peak_v + sample_count per (day, hour), a
        # today_by_hour slice for "today only", and an avg_peak_by_hour
        # aggregate across the window for "by hour of day" charts.
        # Default 7, clamp 1..30 (tighter than visitors_summary's 365
        # because wider windows mix stale baselines with today's signal).
        if path == "/api/visitors/hourly":
            days = 7
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "days" in params:
                    try:
                        days = int(params["days"][0])
                    except (ValueError, IndexError):
                        days = 7
            return self._json(200, visitors_hourly(days=days))
        # /api/activity/summary?days=N — combined per-day rollup of wall,
        # pageviews, and visitors in one response. Same shape per source
        # as the individual endpoints; thin glue over wall_summary /
        # pageviews_summary / visitors_summary so each source's contract
        # is unchanged. Default 7, clamp 1..365.
        if path == "/api/activity/summary":
            days = 7
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "days" in params:
                    try:
                        days = int(params["days"][0])
                    except (ValueError, IndexError):
                        days = 7
            return self._json(200, activity_summary(days=days))
        if path == "/api/guessing":
            mode = ""
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                mode = (params.get("mode", [""])[0] or "").lower().strip()
            status, body = guessing_create(mode=mode)
            return self._json(status, body)
        # /api/guessing/daily — read-only metadata about today's daily puzzle.
        # Does NOT reveal the secret; safe to call from any page or widget.
        if path == "/api/guessing/daily":
            status, body = guessing_daily_info()
            return self._json(status, body)
        # /api/guessing/stats — anonymous lifetime + today stats over
        # every session in logs/guessing.json. No personal data; just
        # win/lost/abandoned/active counts per mode.
        if path == "/api/guessing/stats":
            return self._json(200, guessing_stats())
        # /api/guessing/recent?limit=N — most recently *finished* games.
        # Complements /api/guessing/stats with the individual-game view
        # (each row carries sid / mode / status / secret / duration).
        # Defaults to 10 rows, clamped to 1..50. Bad ?limit=foo falls
        # back to 10. Active sessions are excluded.
        if path == "/api/guessing/recent":
            limit = GUESSING_RECENT_DEFAULT
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "limit" in params:
                    try:
                        limit = int(params["limit"][0])
                    except (ValueError, IndexError):
                        limit = GUESSING_RECENT_DEFAULT
            return self._json(200, guessing_recent(limit=limit))
        # /api/daily/archive?days=N — past daily puzzles with their secret
        # (only when no active daily session exists for that day) plus
        # win/lost/abandoned stats from logs/guessing.json. Today is
        # always excluded. Defaults to 30 days, clamped to 1..365.
        if path == "/api/daily/archive":
            days = DAILY_ARCHIVE_DEFAULT
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "days" in params:
                    try:
                        days = int(params["days"][0])
                    except (ValueError, IndexError):
                        days = DAILY_ARCHIVE_DEFAULT
            return self._json(200, daily_archive(days=days))
        # /api/guessing/<sid> -> read state
        if path.startswith("/api/guessing/"):
            rest = path[len("/api/guessing/"):]
            # /api/guessing/<sid>          -> state
            # /api/guessing/<sid>/guess    -> POST only (handled below)
            # /api/guessing/<sid>/abandon  -> POST only (handled below)
            if "/" not in rest:
                status, body = guessing_state(rest)
                return self._json(status, body)
        if path == "/api/reading":
            items, dupes = read_reading()
            payload = {
                "count": len(items),
                "entries": items,
            }
            # Optional ?limit=N caps the response to the N most recent entries.
            # Clamp to a sensible range so a giant ?limit=999999 doesn't waste
            # bandwidth — the hard ceiling is the same READING_MAX_ENTRIES cap.
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "limit" in params:
                    try:
                        n = int(params["limit"][0])
                    except (ValueError, IndexError):
                        n = 0
                    if n > 0:
                        n = min(n, READING_MAX_ENTRIES)
                        payload["limit"] = n
                        payload["entries"] = items[:n]
                        payload["count"] = len(payload["entries"])
            if dupes:
                payload["duplicates"] = dupes
            return self._json(200, payload)

        # Server-rendered pages (templates live in code, not on disk).
        if path == "/now" or path == "/pages/now.html":
            return self._send(200, render_now_page(), "text/html; charset=utf-8")
        if path == "/reading" or path == "/pages/reading.html":
            return self._send(200, render_reading_page(), "text/html; charset=utf-8")
        if path == "/daily" or path == "/pages/daily.html":
            # Allow ?days=N on the HTML route too so the same page can be
            # bookmarked at a custom depth. Same clamp as the JSON endpoint.
            ddays = DAILY_ARCHIVE_DEFAULT
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "days" in params:
                    try:
                        ddays = int(params["days"][0])
                    except (ValueError, IndexError):
                        ddays = DAILY_ARCHIVE_DEFAULT
            return self._send(200, render_daily_page(ddays), "text/html; charset=utf-8")
        # /trending + /pages/trending.html — standalone page for the
        # /api/pageviews/trending widget with a depth control and a
        # 60-second JS refresh. ?top=N mirrors the JSON endpoint's
        # clamp (1..20); the JS also forwards it when the user clicks
        # a "top N" link so the page is bookmarkable at any depth.
        if path == "/trending" or path == "/pages/trending.html":
            ttop = TRENDING_DEFAULT
            if qs:
                from urllib.parse import parse_qs
                params = parse_qs(qs, keep_blank_values=False)
                if "top" in params:
                    try:
                        ttop = int(params["top"][0])
                    except (ValueError, IndexError):
                        ttop = TRENDING_DEFAULT
            return self._send(200, render_trending_page(ttop), "text/html; charset=utf-8")

        # Atom feed for the notes page.
        if path == "/feed.xml" or path == "/feed.atom":
            body = render_notes_feed()
            return self._send(200, body, "application/atom+xml; charset=utf-8")
        # JSON Feed v1.1 sibling of the Atom feed. Same source, modern shape.
        if path == "/api/feed.json" or path == "/feed.json":
            body = render_notes_feed_json()
            return self._send(200, body, "application/feed+json; charset=utf-8")

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
        raw_path = self.path
        path = raw_path.split("?", 1)[0]
        qs = raw_path.split("?", 1)[1] if "?" in raw_path else ""
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
        # /api/guessing                       -> handled in GET, mirror for symmetry
        # /api/guessing/<sid>/guess          -> POST {guess: int}
        # /api/guessing/<sid>/abandon         -> POST {}
        if path == "/api/guessing" or path.startswith("/api/guessing/"):
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length < 0 or length > 1024:
                return self._json(400, {"ok": False, "error": "bad content length"})
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {}
            rest = path[len("/api/guessing"):]
            # POST /api/guessing -> create (mirrors GET; rare but cheap)
            if rest == "":
                mode = ""
                if qs:
                    from urllib.parse import parse_qs
                    params = parse_qs(qs, keep_blank_values=False)
                    mode = (params.get("mode", [""])[0] or "").lower().strip()
                status, body = guessing_create(mode=mode)
                return self._json(status, body)
            # /api/guessing/<sid>[/action]
            if rest.startswith("/"):
                rest = rest[1:]
            parts = rest.split("/")
            if len(parts) == 1:
                # plain /api/guessing/<sid> -> treat POST as abandon
                status, body = guessing_abandon(parts[0])
                return self._json(status, body)
            if len(parts) == 2 and parts[1] == "guess":
                guess = payload.get("guess", payload) if isinstance(payload, dict) else payload
                status, body = guessing_guess(parts[0], guess)
                return self._json(status, body)
            if len(parts) == 2 and parts[1] == "abandon":
                status, body = guessing_abandon(parts[0])
                return self._json(status, body)
            return self._json(404, {"ok": False, "error": "no such guessing endpoint"})
        return self._serve_404(path)


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    # Eagerly load any persisted shared canvas + wall + guessing state.
    load_shared_state()
    load_wall_state()
    load_guessing_state()
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
