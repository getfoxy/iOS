#!/usr/bin/env python3
"""
pack-index.py — put the app back together.

Joins build/app/*.js into build/foxy-app.js and build/wallet/*.js into
Web/foxy-wallet.js (tools/join-sources.py), then writes Web/index.html from
files that are all committed:

    build/foxy-app.js           the app class, joined from build/app
    build/markup.html           the screens
    build/shell/head.html       the page head: its policy, the loader script and
                                the bundler's data blocks, with the manifest left
                                out (__FOXY_MANIFEST__) and the loader's hash left
                                to compute (__FOXY_LOADER_HASH__)
    build/shell/manifest.json   the embedded assets, in order: id, type, whether
                                it is gzipped, and the file it is made from
    build/shell/assets/         those files: React, ReactDOM, icons, an image and
                                fonts. The renderer's entry names
                                build/foxy-render.js
    build/shell/page.json       the app script's opening tag, its marker in the
                                markup, and the page's last line

This is the build step: edit the parts like normal files, run this, install the
result.

The shell used to come from build/shell.json, a gitignored snapshot
unpacked from Web/index.html itself, so the loader, the page policy and the
embedded assets had no source apart from the page they were packed into. They
are ordinary files now, and a gzipped asset is packed the same way every time
(level 9, no name, no time), so Web/index.html is exactly what these files make.

foxy-app.js lives in build/ and not in Web/ on purpose. project.yml bundles all
of Web/ into the app, so a copy there shipped to the phone — 479KB that nothing
loads, because pack has already baked the class into index.html. Two copies of
the app logic in one bundle is also a question an auditor should not have to
ask.

    python3 tools/pack-index.py

It verifies what it wrote — the template decodes, the app class parses, and the
div balance is unchanged — and refuses to leave a broken file behind.
"""

import base64, gzip, hashlib, io, json, os, re, shutil, sys

INDEX = 'Web/index.html'
APP = 'build/foxy-app.js'
MARKUP = 'build/markup.html'
HEAD = 'build/shell/head.html'
MANIFEST = 'build/shell/manifest.json'
ASSETS = 'build/shell/assets'
PAGE = 'build/shell/page.json'

# The wallet and the app class are kept in parts (build/wallet, build/app);
# join them first, so the page and the shipped wallet are built from the parts.
import subprocess as _sp
_j = _sp.run([sys.executable, 'tools/join-sources.py'], capture_output=True, text=True)
if _j.returncode:
    sys.exit('join-sources.py failed: ' + (_j.stdout + _j.stderr).strip())
if _j.stdout.strip():
    print(_j.stdout.strip())

page = json.load(open(PAGE))
head = open(HEAD, encoding='utf-8', newline='').read()
entries = json.load(open(MANIFEST))
app = open(APP, newline='').read()
markup = open(MARKUP, newline='').read()

if page['marker'] not in markup:
    sys.exit('marker missing from markup.html — cannot place the app script')

template = markup.replace(page['marker'], page['open'] + app + '</script>')

# Every div closed, exactly. The export shipped with one stray </div> (after the
# restore screen), which the HTML parser used to close the themed wrapper early:
# the blocked screen and fourteen overlays rendered outside it, without the
# theme or accent. Since removed; a balance other than 0 is a broken edit.
delta = template.count('<div') - template.count('</div>')
if delta != 0:
    sys.exit('div balance is %d, expected 0 — refusing to write' % delta)
if template.count('<sc-if') != template.count('</sc-if>'):
    sys.exit('sc-if tags are unbalanced — refusing to write')

# Every asset file is in the manifest and every manifest entry has its file, so
# an asset cannot ship unlisted or be listed and missing.
listed = set()
for e in entries:
    if set(e) != {'uuid', 'mime', 'compressed', 'file'}:
        sys.exit('manifest entry %s must have exactly uuid, mime, compressed and file' % e.get('uuid'))
    if not os.path.isfile(e['file']):
        sys.exit('manifest entry %s names %s, which does not exist' % (e['uuid'][:8], e['file']))
    listed.add(os.path.normpath(e['file']))
for name in sorted(os.listdir(ASSETS)):
    if os.path.normpath(os.path.join(ASSETS, name)) not in listed:
        sys.exit('%s/%s is not in %s — list it or remove it' % (ASSETS, name, MANIFEST))
if len({e['uuid'] for e in entries}) != len(entries):
    sys.exit('a uuid appears twice in ' + MANIFEST)

# An asset nothing names is dead weight in every install: say so. A warning,
# because an asset can be addressed in ways this cannot see.
_loader_text = head.replace('__FOXY_MANIFEST__', '') + page['tail']
_orphans = [e['uuid'] for e in entries if e['uuid'] not in template and e['uuid'] not in _loader_text]
if _orphans:
    print('warning: %d asset(s) in %s that nothing names: %s' % (len(_orphans), MANIFEST, ', '.join(u[:8] for u in _orphans)))

# The page's policy allows one inline script: this loader, by its hash.
#
# Computed here on every pack, so an edit to the loader cannot leave a stale
# hash behind — a stale hash is a page that does not start.
inline = [m for m in re.finditer(r'<script>(.*?)</script>', head, re.S)]
if len(inline) != 1:
    sys.exit('expected exactly one inline script (the loader) in the shell head, found %d' % len(inline))
loader = inline[0].group(1).replace('\r\n', '\n').replace('\r', '\n')   # as the HTML parser sees it
digest = "'sha256-" + base64.b64encode(hashlib.sha256(loader.encode('utf-8')).digest()).decode() + "'"
csp = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', head)
if not csp:
    sys.exit('no Content-Security-Policy meta in the shell head')
policy = csp.group(1)
slots = re.findall(r"'__FOXY_LOADER_HASH__'", policy)
if len(slots) != 1 or re.search(r"'sha256-", policy):
    sys.exit("the policy in %s needs exactly one '__FOXY_LOADER_HASH__' slot and no written hash" % HEAD)
if re.search(r"script-src[^;]*'unsafe-(inline|eval)'", policy):
    sys.exit("script-src allows 'unsafe-inline' or 'unsafe-eval' — refusing to write")
policy = policy.replace(slots[0], digest)
head = head[:csp.start(1)] + policy + head[csp.end(1):]

# The manifest, from its files. A gzipped entry is packed with no name and no
# time at level 9, so the same file always packs to the same bytes; the loader
# decompresses with DecompressionStream, which takes any valid gzip.
# tools/verify-vendor.py and tools/verify-shipped.sh check each decoded entry.
def gz(data):
    buf = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=buf, mtime=0, compresslevel=9) as f:
        f.write(data)
    return buf.getvalue()

man = {}
for e in entries:
    data = open(e['file'], 'rb').read()
    man[e['uuid']] = {
        'mime': e['mime'],
        'compressed': bool(e['compressed']),
        'data': base64.b64encode(gz(data) if e['compressed'] else data).decode(),
    }
if head.count('__FOXY_MANIFEST__') != 1:
    sys.exit('%s needs the __FOXY_MANIFEST__ placeholder exactly once' % HEAD)
head = head.replace('__FOXY_MANIFEST__', json.dumps(man, separators=(',', ':')))

out = head + "\n" + json.dumps(template).replace('</', '<\\/') + "\n" + page['tail']

# write to a temp file and prove it decodes before replacing anything
open(INDEX + '.tmp', 'w', newline='').write(out)
h = open(INDEX + '.tmp', newline='').read()
i = h.index('<script type="__bundler/template">') + len('<script type="__bundler/template">')
j = h.index('</script>', i)
back = json.loads(h[i:j].strip())
if back != template:
    sys.exit('round trip failed — the written file does not decode to what we packed')

shutil.move(INDEX + '.tmp', INDEX)
print('wrote %s (%s bytes)' % (INDEX, format(len(out), ',')))
