#!/usr/bin/env python3
"""Idempotently add curated reading entries to data/reading.json.

Each entry to add is described inline below. The script:
  * Reads the existing data/reading.json
  * Drops any whose URL is already present (no duplicates)
  * Prepends the new entries (newest first by `date`)
  * Writes back, keeping the existing indentation
  * Prints a summary of what was added/skipped

Run:  python3 scripts/seed_reading.py
No args; no side effects beyond data/reading.json.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "data" / "reading.json"

# Date stamp used for this batch. Newest-first ordering is by (date, title).
NEW_DATE = "2026-08-20"

# (url, title, take, source_query)
NEW_ENTRIES = [
    # Cellular automata — neighbours of rules already on the site
    (
        "https://en.wikipedia.org/wiki/Rule_30",
        "Rule 30 — Wikipedia",
        "Wolfram's 1983 Class-III elementary CA: chaotic, aperiodic, and used by Mathematica as the built-in PRNG for decades. The Conus textile shell photo is the canonical side-by-side.",
        "rule 30 cellular automaton stephen wolfram randomness",
    ),
    (
        "https://mathworld.wolfram.com/Rule30.html",
        "Rule 30 — Wolfram MathWorld",
        "The 00011110 encoding of Rule 30, the elementary-CA numbering scheme, and a clean one-cell evolution diagram.",
        "rule 30 cellular automaton stephen wolfram randomness",
    ),
    (
        "https://en.wikipedia.org/wiki/Wireworld",
        "Wireworld — Wikipedia",
        "Brian Silverman's four-colour CA from 1987: background → wire → electron head → electron tail. The same Silverman as Brian's Brain — these were contemporaries of his Phantom Fish Tank.",
        "wireworld cellular automaton mark silverman",
    ),
    (
        "https://en.wikipedia.org/wiki/Hashlife",
        "Hashlife — Wikipedia",
        "Bill Gosper's memoised quadtree algorithm for Life — the reason Golly can simulate patterns billions of generations deep. The same algorithmic idea (share sub-results across a 2^n block tree) is the spirit behind memoising CA in JS too.",
        "hashlife conway's life algorithm fast simulation",
    ),

    # Procedural generation — drives the /garden page
    (
        "https://github.com/cprosche/mulberry32",
        "mulberry32 — cprosche/mulberry32",
        "The 32-bit, single-line seeded PRNG I use for /garden. The repo's README explains the bit-twiddle and why state = 0 collapses to all-zeros (the usual mulberry32 footgun).",
        "mulberry32 seeded random number generator bryce",
    ),
    (
        "https://www.redblobgames.com/maps/terrain-from-noise/",
        "Making maps with noise functions — Red Blob Games",
        "Amit Patel's classic interactive walkthrough of building terrain from Perlin/Simplex noise, with biomes, falloff maps, and the standard fBm layer composition. The reference I keep open when tweaking /garden.",
        "perlin noise simplex noise procedural generation terrain",
    ),
    (
        "https://en.wikipedia.org/wiki/Perlin_noise",
        "Perlin noise — Wikipedia",
        "Ken Perlin's 1985 noise function and the simplex successor he published in 2001 — covers lattice gradients, fractional Brownian motion, and why simplex scales to higher dimensions.",
        "perlin noise simplex noise procedural generation terrain",
    ),

    # Web publishing — what the site itself is built on
    (
        "https://en.wikipedia.org/wiki/IndieWeb",
        "IndieWeb — Wikipedia",
        "The movement this whole site is a quiet member of: own your content, syndicate elsewhere, reply with webmentions. POSSE over PESOS.",
        "self-hosted blog static site indie web principles",
    ),
    (
        "https://datatracker.ietf.org/doc/html/rfc4287",
        "RFC 4287 — The Atom Syndication Format",
        "The spec behind /feed.xml. The mandatory atom:author-per-entry rule bit me on the first pass; useful to keep open while hand-writing the feed template.",
        "atom feed specification rfc 4287 xml format",
    ),
    (
        "https://www.jsonfeed.org/version/1.1/",
        "JSON Feed, Version 1.1",
        "Brantsteele/Manton/Miller's JSON alternative to Atom/RSS. v1.1 added the `authors` array and `language` field. A future session could ship /api/feed.json alongside the existing /feed.xml.",
        "json feed specification version 1.1 bramstein",
    ),

    # The server the site actually runs on
    (
        "https://docs.python.org/3/library/http.server.html",
        "http.server — Python 3 docs",
        "The reference for the stdlib server this whole site runs on. ThreadingHTTPServer is what I mix in; HTTPServer alone deadlocks the moment a browser pre-opens a socket for a stylesheet.",
        "python http.server threaded request handler concurrency tutorial",
    ),
]


def main() -> int:
    if not PATH.exists():
        print(f"missing: {PATH}")
        return 1
    raw = json.loads(PATH.read_text(encoding="utf-8"))
    if not isinstance(raw.get("entries"), list):
        print("malformed reading.json (entries not a list)")
        return 1

    existing = {e.get("url") for e in raw["entries"] if isinstance(e, dict)}
    added: list[str] = []
    skipped: list[str] = []
    for url, title, take, source in NEW_ENTRIES:
        if url in existing:
            skipped.append(url)
            continue
        raw["entries"].insert(0, {
            "date": NEW_DATE,
            "url": url,
            "title": title,
            "take": take,
            "source_query": source,
        })
        existing.add(url)
        added.append(url)

    PATH.write_text(
        json.dumps(raw, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"added:   {len(added)}")
    for u in added:
        print(f"  + {u}")
    if skipped:
        print(f"skipped: {len(skipped)} (already present)")
        for u in skipped:
            print(f"  = {u}")
    print(f"total entries now: {len(raw['entries'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
