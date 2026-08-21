#!/usr/bin/env python3
"""Insert the 'daily' link into the <nav> block of every HTML page.

The link goes right after 'guessing' and before 'what's new', matching
the position I put it in on /pages/daily.html itself. Idempotent: a
'daily' link that's already present in the nav will not be added again.

Usage:  python3 scripts/insert_daily_nav.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = (
    [ROOT / "site" / "index.html"]
    + sorted((ROOT / "site" / "pages").glob("*.html"))
    + [ROOT / "site" / "404.html"]
)

# The new nav entry. On the daily page itself it becomes 'current'.
NEW_LINK_PLAIN = '  <a href="/pages/daily.html">daily</a>\n'
NEW_LINK_ACTIVE = '  <a href="/pages/daily.html" class="current">daily</a>\n'

# Anchor we insert AFTER, on its own line: '  <a ... >guessing</a>'.
GUESSING_RE = re.compile(
    r'^(?P<indent>[ \t]*)<a href="/pages/guessing\.html"(?:\s+class="current")?>(?P<rest>guessing</a>)\s*$',
    re.MULTILINE,
)

# Detect whether the file already has a daily link to make this idempotent.
ALREADY_HAS_RE = re.compile(r'href="/pages/daily\.html"')


def patch(path: Path) -> tuple[bool, str]:
    """Patch one file in-place. Returns (changed, status)."""
    txt = path.read_text(encoding="utf-8")
    if ALREADY_HAS_RE.search(txt):
        return False, "already has daily link"

    m = GUESSING_RE.search(txt)
    if not m:
        return False, "no guessing anchor found"

    indent = m.group("indent")
    is_daily_page = path.name == "daily.html"
    new_line = (NEW_LINK_ACTIVE if is_daily_page else NEW_LINK_PLAIN).replace(
        "  ", indent
    )
    insertion = m.end()
    new_txt = txt[:insertion] + "\n" + new_line + txt[insertion:]
    path.write_text(new_txt, encoding="utf-8")
    return True, "inserted"


def main() -> int:
    n_changed = 0
    for p in PAGES:
        ok, status = patch(p)
        flag = "*" if ok else " "
        print(f"{flag} {p.relative_to(ROOT)} — {status}")
        if ok:
            n_changed += 1
    print(f"\n{n_changed} file(s) updated, {len(PAGES) - n_changed} unchanged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())