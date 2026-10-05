#!/usr/bin/env python3
"""
check-assets.py — which files in Web/ does anything actually load?

Written after getting this wrong by hand. foxy-sheet.webp and foxy-splash.jpg
were deleted as unreferenced because the check only looked in index.html — but
the sheet is loaded by foxy-send-progress.js and the splash by
foxy-vpn-gate.js, and both regressed on device: no fox behind the Tor gate, no
animation during a send.

So this searches every text file in Web/, not one of them, and prints who
references what.

    python3 tools/check-assets.py

A file with no referrers is a candidate for removal, not a certainty: Swift can
load an asset by name from the bundle without any web file mentioning it. Check
Foxy/**/*.swift before deleting anything this flags.
"""

import os, re, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(HERE, 'Web')
SWIFT = os.path.join(HERE, 'Foxy')

TEXT = ('.js', '.html', '.css', '.json', '.md')

assets = sorted(f for f in os.listdir(WEB)
                if os.path.isfile(os.path.join(WEB, f)))

sources = {}
for f in assets:
    if f.endswith(TEXT):
        sources[f] = open(os.path.join(WEB, f), encoding='utf8', errors='replace').read()

swift = ''
if os.path.isdir(SWIFT):
    for d, _, names in sorted(os.walk(SWIFT)):
        for f in sorted(names):
            if f.endswith('.swift'):
                swift += open(os.path.join(d, f), encoding='utf8', errors='replace').read()

orphans = []
for a in assets:
    # index.html is the build output; .md files are documentation, not assets
    if a == 'index.html' or a.endswith('.md'):
        continue
    refs = [s for s, text in sources.items() if s != a and a in text]
    stem = os.path.splitext(a)[0]
    in_swift = a in swift or stem in swift
    size = os.path.getsize(os.path.join(WEB, a))
    where = ', '.join(refs) if refs else ''
    if in_swift:
        where = (where + ', ' if where else '') + 'Foxy/**/*.swift'
    print('%-24s %10s  %s' % (a, format(size, ','), where or 'NO REFERRERS'))
    if not where:
        orphans.append(a)

print()
if orphans:
    print('%d with no referrer: %s' % (len(orphans), ', '.join(orphans)))
    print('Check the Swift bundle before deleting — assets can be loaded by name.')
else:
    print('every asset in Web/ has a referrer')
sys.exit(0)
