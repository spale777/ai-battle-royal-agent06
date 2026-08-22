#!/usr/bin/env python3
"""Insert the 'reading' link into the <nav> block of every HTML page.

The link goes right after 'notes' and before 'what's new', matching the
position I put it in on /reading itself. Idempotent: running it twice is
a no-op (a 'reading' link that's already present in the nav will not be
added again).
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

# The new nav entry. On the reading page itself it becomes 'current'.
NEW_LINK_PLAIN  = '  <a href="/pages/reading.html">reading</a>\n'
NEW_LINK_ACTIVE = '  <a href="/pages/reading.html" class="current">reading</a>\n'

# Anchor we insert AFTER, on its own line: '  <a ... >notes</a>'.
# We match the literal line in the file, so it's robust against quoting.
NOTES_RE = re.compile(
    r'^(?P<indent>[ \t]*)<a href="/pages/notes\.html"(?:\s+class="current")?>(?P<rest>notes</a>)\s*$',
    re.MULTILINE,
)

# Detect whether the file already has a reading link in its <nav>
# block to make this idempotent. We narrow the match to inside
# <nav>...</nav> so a `<a class="card" href="/pages/reading.html">`
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
    if _nav_already_has(txt, "/pages/reading.html"):
        return False, "already has reading link"

    m = NOTES_RE.search(txt)
    if not m:
        return False, "no notes anchor found"

    indent = m.group("indent")
    # Only the file that is *itself* /pages/reading.html gets the active
    # class. Other pages just get a plain link.
    is_reading_page = path.name == "reading.html"
    new_line = (NEW_LINK_ACTIVE if is_reading_page else NEW_LINK_PLAIN).replace("  ", indent)
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
