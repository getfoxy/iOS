#!/usr/bin/env python3
"""
unpack-index.py — take the app apart so it can be read.

index.html is an 872KB file whose entire logic lives as a JSON-encoded string
inside <script type="__bundler/template">, and inside THAT string is another
script tag holding the app class. Nothing about it is reviewable: no stable
line numbers, no meaningful diff, and every edit has to go through a
decode-patch-encode cycle.

This splits out the two pieces worth reading:

    build/foxy-app.js     the app class          ~478KB of plain JavaScript
                          (the source is build/app/*.js now: the next pack joins the
                          parts over this file, so copy any change into the parts)
    build/markup.html     the screens            ~402KB of plain markup

Everything else in the page, the shell, is committed source
(build/shell: the head with the loader and policy, the manifest's files, and
page.json), and pack-index.py builds the page from those. This no longer writes
a shell snapshot: the page is not the shell's source.

Run from the repo root:

    python3 tools/unpack-index.py
"""

import json, os, re, sys

INDEX = 'Web/index.html'
APP = 'build/foxy-app.js'
MARKUP = 'build/markup.html'

MARKER = '<!--FOXY_APP_SCRIPT-->'

h = open(INDEX, newline='').read()

open_tag = '<script type="__bundler/template">'
i = h.index(open_tag) + len(open_tag)
j = h.index('</script>', i)
template = json.loads(h[i:j].strip())

# the inner script holding the class
m = re.search(r'<script type="text/x-dc"[^>]*>', template)
if not m:
    sys.exit('no text/x-dc script found — nothing to unpack')
end = template.index('</script>', m.end())

app = template[m.end():end]
markup = template[:m.start()] + MARKER + template[end + len('</script>'):]

os.makedirs('build', exist_ok=True)
open(APP, 'w', newline='').write(app)
open(MARKUP, 'w', newline='').write(markup)

print('app    %9s bytes -> %s' % (format(len(app), ','), APP))
print('markup %9s bytes -> %s' % (format(len(markup), ','), MARKUP))
