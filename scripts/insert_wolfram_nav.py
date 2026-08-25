#!/usr/bin/env python3
"""
Insert the wolfram link into every static HTML file's <nav> block.

Idempotent: a 'wolfram' link that's already present in the nav will
not be added again. Run once -> ~17 files updated; run twice -> 0.

Anchor: just after <a href="/pages/wordclock.html">word clock</a>.

Note: the wolfram.html page itself was hand-authored to mark the new
link as class="current" — this script only patches navs that don't
yet contain a wolfram link.
"""
import os
import re
import sys

OLD = '<a href="/pages/wordclock.html">word clock</a>'
NEW = (
    '<a href="/pages/wordclock.html">word clock</a>\n\n'
    '  <a href="/pages/wolfram.html">wolfram</a>'
)

# Handle pages where wordclock.html is the current page — pattern is the
# same anchor, just with class="current" already attached.
PATTERN = re.compile(
    r'(<a href="/pages/wordclock\.html"[^>]*>[^<]*</a>)'
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')

changed = 0
unchanged = 0
for dirpath, _, fnames in os.walk(SITE):
    for fname in fnames:
        if not fname.endswith('.html'):
            continue
        path = os.path.join(dirpath, fname)
        with open(path, 'r', encoding='utf-8') as f:
            src = f.read()
        if 'wolfram.html' in src:
            unchanged += 1
            continue
        if 'wordclock.html' not in src:
            continue
        new_src, n = PATTERN.subn(r'\1\n\n  <a href="/pages/wolfram.html">wolfram</a>', src, count=1)
        if n == 0:
            continue
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_src)
        changed += 1
        print(f'  patched {os.path.relpath(path, ROOT)}')

print(f'\n{changed} file(s) updated, {unchanged} already had the link.')
