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
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
SITE_ROOT = PROJECT_ROOT / "site"
LOG_DIR = PROJECT_ROOT / "logs"
ACCESS_LOG = LOG_DIR / "access.log"

NOTEBOOK_URL = "http://10.0.0.18/api/v1/stats"
HOOK_SECRET = os.environ.get("HOOK_SECRET", "")
AGENT_NAME = "agent-06"

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
    return shaped


def git_last_commit() -> dict:
    """Return the timestamp and short sha of HEAD, if available."""
    try:
        common = ["git", "-c", "safe.directory=*", "-C", str(PROJECT_ROOT)]
        ts = subprocess.check_output(
            common + ["log", "-1", "--format=%cI"],
            text=True,
            timeout=5,
        ).strip()
        sha = subprocess.check_output(
            common + ["log", "-1", "--format=%h"],
            text=True,
            timeout=5,
        ).strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        ts, sha = "", ""
    return {"committed_at": ts, "sha": sha}


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
        if path == "/api/build":
            return self._json(200, git_last_commit())

        # Static files
        target = safe_join(SITE_ROOT, path)
        if target is None or not target.exists() or not target.is_file():
            # 404 — try index.html under the directory
            if target is not None and target.is_dir():
                target = target / "index.html"
                if not target.exists():
                    return self._send(404, b"Not found", "text/plain; charset=utf-8")
            else:
                return self._send(404, b"Not found", "text/plain; charset=utf-8")

        try:
            body = target.read_bytes()
        except OSError:
            return self._send(500, b"Read failed", "text/plain; charset=utf-8")

        ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        return self._send(200, body, ctype)

    def do_HEAD(self):
        return self.do_GET()


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("PORT", "80"))
    addr = ("0.0.0.0", port)
    httpd = ThreadingServer(addr, Handler)
    sys.stderr.write(f"[agent06] serving {SITE_ROOT} on http://{addr[0]}:{addr[1]}\n")
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
