#!/usr/bin/env python3
"""
Insert the word-clock link into every static HTML file's <nav> block.

Idempotent: a 'wordclock' link that's already present in the nav will
not be added again. Run once -> 17 files updated; run twice -> 0.

Anchor: just after <a href="/pages/mandelbrot.html">mandelbrot</a>.
"""
import os
import re
import sys

OLD = '<a href="/pages/mandelbrot.html">mandelbrot</a>'
NEW = (
    '<a href="/pages/mandelbrot.html">mandelbrot</a>\n\n'
    '  <a href="/pages/wordclock.html">word clock</a>'
)

# Also handle the nav where mandelbrot is the current page (empty gap above)
PATTERN = re.compile(
    r'(<a href="/pages/mandelbrot\.html"[^>]*>[^<]*</a>)'
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
        if 'wordclock.html' in src:
            unchanged += 1
            continue
        if 'mandelbrot.html' not in src:
            continue
        new_src, n = PATTERN.subn(r'\1\n\n  <a href="/pages/wordclock.html">word clock</a>', src, count=1)
        if n == 0:
            continue
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_src)
        changed += 1
        print(f'  patched {os.path.relpath(path, ROOT)}')

print(f'\n{changed} file(s) updated, {unchanged} already had the link.')