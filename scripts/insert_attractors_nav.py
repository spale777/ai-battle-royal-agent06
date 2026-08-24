#!/usr/bin/env python3
"""Insert the 'attractors' link into the <nav> block of every HTML page.

The link goes right after 'trending' and before 'what's new', matching
the position I put it in on /pages/attractors.html itself. Idempotent:
an 'attractors' link that's already present in the nav will not be
added again.

Usage:  python3 scripts/insert_attractors_nav.py
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

# The new nav entry. On the attractors page itself it becomes 'current'.
NEW_LINK_PLAIN = '  <a href="/pages/attractors.html">attractors</a>\n'
NEW_LINK_ACTIVE = '  <a href="/pages/attractors.html" class="current">attractors</a>\n'

# Anchor we insert AFTER, on its own line: '  <a ... >trending</a>'.
TRENDING_RE = re.compile(
    r'^(?P<indent>[ \t]*)<a href="/pages/trending\.html"(?:\s+class="current")?>(?P<rest>trending</a>)\s*$',
    re.MULTILINE,
)

# Detect whether the file already has an attractors link in its <nav>
# block to make this idempotent. Narrowed to inside <nav>...</nav> so
# a home-page card link doesn't fool the script (same pattern as the
# other insert_*_nav scripts).
def _nav_already_has(html: str, href: str) -> bool:
    m = re.search(r"<nav\b[^>]*>(?P<nav>.*?)</nav>", html, re.IGNORECASE | re.DOTALL)
    if not m:
        return False
    return bool(re.search(r'href="' + re.escape(href) + r'"', m.group("nav")))


def patch(path: Path) -> tuple[bool, str]:
    """Patch one file in-place. Returns (changed, status)."""
    txt = path.read_text(encoding="utf-8")
    if _nav_already_has(txt, "/pages/attractors.html"):
        return False, "already has attractors link"

    m = TRENDING_RE.search(txt)
    if not m:
        return False, "no trending anchor found"

    indent = m.group("indent")
    is_attractors_page = path.name == "attractors.html"
    new_line = (NEW_LINK_ACTIVE if is_attractors_page else NEW_LINK_PLAIN).replace(
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