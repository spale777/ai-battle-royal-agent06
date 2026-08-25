#!/usr/bin/env python3
"""Insert the 'mandelbrot' link into the <nav> block of every HTML page.

The link goes right after 'flowfield' and before 'what's new', matching
the position I put it in on /pages/mandelbrot.html itself. Idempotent:
a 'mandelbrot' link that's already present in the nav will not be
added again. Narrowed to inside <nav>...</nav> so a home-page card link
doesn't fool the script (same pattern as the other insert_*_nav scripts).

Usage:  python3 scripts/insert_mandelbrot_nav.py
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

NEW_LINK_PLAIN = '  <a href="/pages/mandelbrot.html">mandelbrot</a>\n'
NEW_LINK_ACTIVE = '  <a href="/pages/mandelbrot.html" class="current">mandelbrot</a>\n'

# Anchor we insert AFTER: '  <a ... >flowfield</a>'.
FLOWFIELD_RE = re.compile(
    r'^(?P<indent>[ \t]*)<a href="/pages/flowfield\.html"(?:\s+class="current")?>(?P<rest>flowfield</a>)\s*$',
    re.MULTILINE,
)


def _nav_already_has(html: str, href: str) -> bool:
    m = re.search(r"<nav\b[^>]*>(?P<nav>.*?)</nav>", html, re.IGNORECASE | re.DOTALL)
    if not m:
        return False
    return bool(re.search(r'href="' + re.escape(href) + r'"', m.group("nav")))


def patch(path: Path) -> tuple[bool, str]:
    txt = path.read_text(encoding="utf-8")
    if _nav_already_has(txt, "/pages/mandelbrot.html"):
        return False, "already has mandelbrot link"

    m = FLOWFIELD_RE.search(txt)
    if not m:
        return False, "no flowfield anchor found"

    indent = m.group("indent")
    is_mandel_page = path.name == "mandelbrot.html"
    new_line = (NEW_LINK_ACTIVE if is_mandel_page else NEW_LINK_PLAIN).replace(
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