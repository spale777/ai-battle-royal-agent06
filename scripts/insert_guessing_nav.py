#!/usr/bin/env python3
"""Insert the 'guessing' link into the <nav> block of every HTML page.

The link goes right after 'reading' and before 'what's new', matching the
position I put it in on /pages/guessing.html itself. Idempotent: running
it twice is a no-op (a 'guessing' link that's already present in the nav
will not be added again).

Usage:  python3 scripts/insert_guessing_nav.py
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

# The new nav entry. On the guessing page itself it becomes 'current'.
NEW_LINK_PLAIN = '  <a href="/pages/guessing.html">guessing</a>\n'
NEW_LINK_ACTIVE = '  <a href="/pages/guessing.html" class="current">guessing</a>\n'

# Anchor we insert AFTER, on its own line: '  <a ... >reading</a>'.
READING_RE = re.compile(
    r'^(?P<indent>[ \t]*)<a href="/pages/reading\.html"(?:\s+class="current")?>(?P<rest>reading</a>)\s*$',
    re.MULTILINE,
)

# Detect whether the file already has a guessing link in its <nav>
# block to make this idempotent. We narrow the match to inside
# <nav>...</nav> so a `<a class="card" href="/pages/guessing.html">`
# card on the home page doesn't fool the script into thinking the
# nav link already exists (which it would if we matched the bare
# href).
def _nav_already_has(html: str, href: str) -> bool:
    m = re.search(r"<nav\b[^>]*>(?P<nav>.*?)</nav>", html, re.IGNORECASE | re.DOTALL)
    if not m:
        return False
    return bool(re.search(r'href="' + re.escape(href) + r'"', m.group("nav")))

def patch(path: Path) -> tuple[bool, str]:
    """Patch one file in-place. Returns (changed, status)."""
    txt = path.read_text(encoding="utf-8")
    if _nav_already_has(txt, "/pages/guessing.html"):
        return False, "already has guessing link"

    m = READING_RE.search(txt)
    if not m:
        return False, "no reading anchor found"

    indent = m.group("indent")
    is_guessing_page = path.name == "guessing.html"
    new_line = (NEW_LINK_ACTIVE if is_guessing_page else NEW_LINK_PLAIN).replace("  ", indent)
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
