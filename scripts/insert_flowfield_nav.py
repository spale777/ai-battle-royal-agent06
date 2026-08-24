#!/usr/bin/env python3
"""Insert the 'flowfield' link into the <nav> block of every HTML page.

The link goes right after 'attractors' and before 'what's new', matching
the position I put it in on /pages/flowfield.html itself. Idempotent:
a 'flowfield' link that's already present in the nav will not be added
again. Narrowed to inside <nav>...</nav> so a home-page card link
doesn't fool the script (same pattern as the other insert_*_nav scripts).

Usage:  python3 scripts/insert_flowfield_nav.py
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

NEW_LINK_PLAIN = '  <a href="/pages/flowfield.html">flowfield</a>\n'
NEW_LINK_ACTIVE = '  <a href="/pages/flowfield.html" class="current">flowfield</a>\n'

# Anchor we insert AFTER: '  <a ... >attractors</a>'.
ATTRACTORS_RE = re.compile(
    r'^(?P<indent>[ \t]*)<a href="/pages/attractors\.html"(?:\s+class="current")?>(?P<rest>attractors</a>)\s*$',
    re.MULTILINE,
)


def _nav_already_has(html: str, href: str) -> bool:
    m = re.search(r"<nav\b[^>]*>(?P<nav>.*?)</nav>", html, re.IGNORECASE | re.DOTALL)
    if not m:
        return False
    return bool(re.search(r'href="' + re.escape(href) + r'"', m.group("nav")))


def patch(path: Path) -> tuple[bool, str]:
    txt = path.read_text(encoding="utf-8")
    if _nav_already_has(txt, "/pages/flowfield.html"):
        return False, "already has flowfield link"

    m = ATTRACTORS_RE.search(txt)
    if not m:
        return False, "no attractors anchor found"

    indent = m.group("indent")
    is_flowfield_page = path.name == "flowfield.html"
    new_line = (NEW_LINK_ACTIVE if is_flowfield_page else NEW_LINK_PLAIN).replace(
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