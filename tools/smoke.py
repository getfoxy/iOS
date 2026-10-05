#!/usr/bin/env python3
"""
smoke.py — everything that can be checked without a phone, in one run.

    python3 tools/smoke.py

Run it before every build. It exits non-zero on the first class of problem
that would have shipped a broken wallet, and it was written after a day in
which three regressions reached the phone that a check like this would have
stopped at the desk:

  - two images deleted as "unreferenced" because only index.html was searched,
    when foxy-send-progress.js and the gate script loaded them
  - a live binding swallowed because it shared a line with a dead one
  - a method call left pointing at a method that had been removed

WHAT IT CHECKS

  1. build/ and Web/index.html agree — pack, in a temporary folder, reproduces
     index.html, the joined files and the part READMEs exactly; nothing in the
     tree is written
  2. the app class parses as JavaScript
  3. every {{ binding }} the markup renders is defined in the app
  4. every this.method() call has a method behind it
  5. every animation: reference has a @keyframes definition
  6. every file the JS or markup loads exists in Web/  <- the one that bit
  7. every file in Web/ is loaded by something
  8. div and sc-if balance is at the export's known baseline
  9. the fork's vocabulary is gone
 10. the crypto vectors pass
 11. the vendored libraries match their hashes
 14. nothing in the page opens a mint WebSocket
 15. the vendored IPtProxy is the reproducible build its checksums name
     (SKIP, counted in the summary, where it is not built)
 18. Tor: the Podfile, the podspec, the pod's other files and the wrapper are
     pinned; the built tor.xcframework is Vendor/Tor.sha256's (SKIP if not built)
 22. nothing outside #if DEBUG uses a symbol only a Debug build defines
 23. Tor control commands claim only their own replies
 24. the seed needs Face ID or the passcode, and is read once per page
 25. a host Foxy has not used needs an Allow in an iOS alert
 31. libsecp256k1 is the vendored v0.8.0, called only for BIP-32; the native
     secrets (counterReserve, counterReserveAt, restoreSecrets) are Debug-only and
     forget their seed with the page, unlock and foreground; seedSecrets is gone
 32. the native seed, stage 2: every stage-2 action is behind the switch, the
     words never reach the page, the wordlist is the page's and pinned, the
     counter file is atomic, protected and out of backups, seed changes ask the
     iOS alerts and set the counters aside, and the seed screens hide the words
 35. a Release build says nothing: native print is a no-op outside DEBUG, the
     page's console.log/warn/info/debug are replaced, and the mirror that used
     to walk around both installs only where FOXY_DEBUG is set
 36. the web inspector attaches to Debug builds only
 37. a payment posted to another phone opens one socket, to Tor's SOCKS port,
     and refuses everything else
 38. the only WebSocket the app opens is wss on Tor's session, nil without Tor
 39. the Nostr gift wrap is published through that socket and nothing else
 40. the onion inbox listens on 127.0.0.1 behind a random path, holds its size
     caps, and closes its address with its listener
 41. the app hashes the page it staged, by the same rule tools/page-hash.py
     follows, and hands it to the drawer to show

It cannot render the page. A screen that mounts but draws nothing still needs
a phone, and tools/foxy-walk.js in the Safari console is the tool for that.

Runs from the repo root. Needs node for checks 2 and 10.
"""

import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(HERE)

APP = 'build/foxy-app.js'
MARKUP = 'build/markup.html'
INDEX = 'Web/index.html'

problems = []
skipped = []


def fail(msg):
    problems.append(msg)
    print('FAIL ' + msg)


def ok(msg):
    print('ok   ' + msg)


def skip(number, msg):
    """A check that could not look at what it checks here. Not a pass: counted
    and named in the summary, so a run where nothing was built cannot read as
    one where everything matched (audit finding A8)."""
    skipped.append(number)
    print('SKIP ' + msg)


app = open(APP, newline='').read()
markup = open(MARKUP, newline='').read()
index = open(INDEX, newline='').read()

# 1. round trip --------------------------------------------------------
# The page is packed from committed sources only (build/app, build/markup.html,
# build/foxy-render.js, build/shell); nothing is unpacked from index.html first.
#
# It packs into a temporary folder holding a copy of those sources and the two
# scripts, never into the working tree: smoke and check-all change no tracked
# file (audit finding A8). What it makes there must be byte for byte the
# files in the tree, so a part edited without running python3
# tools/pack-index.py fails here instead of being quietly repacked. The
# generated files are not copied in, so a pack that wrote nothing cannot pass.
import shutil, tempfile
GENERATED = ['Web/index.html', 'Web/foxy-wallet.js', 'build/foxy-app.js',
             'build/app/README.md', 'build/wallet/README.md']
with tempfile.TemporaryDirectory(prefix='foxy-smoke-pack.') as tmp:
    for d in ('tools', 'Web', 'build'):
        os.makedirs(os.path.join(tmp, d))
    for f in ('tools/pack-index.py', 'tools/join-sources.py', 'build/markup.html', 'build/foxy-render.js'):
        shutil.copy2(f, os.path.join(tmp, f))
    for d in ('build/app', 'build/wallet', 'build/shell'):
        shutil.copytree(d, os.path.join(tmp, d))
    for g in GENERATED:
        if os.path.exists(os.path.join(tmp, g)):
            os.remove(os.path.join(tmp, g))
    r = subprocess.run([sys.executable, 'tools/pack-index.py'], cwd=tmp, capture_output=True, text=True)
    if r.returncode != 0:
        fail('pack-index.py failed: ' + (r.stdout + r.stderr).strip()[-200:])
    elif 'warning' in r.stdout:
        fail('pack warns: ' + r.stdout.split('warning:')[1].split('\n')[0].strip())
    else:
        def _same(g):
            a, b = os.path.join(tmp, g), g
            return os.path.exists(a) and os.path.exists(b) and open(a, 'rb').read() == open(b, 'rb').read()
        differ = [g for g in GENERATED if not _same(g)]
        if differ:
            fail('packing the sources does not make the files in the tree: %s (run python3 tools/pack-index.py)'
                 % ', '.join(differ))
        else:
            ok('pack, in a temporary folder, makes index.html, the joined files and the part READMEs byte for byte')
index = open(INDEX, newline='').read()

# 2. parse --------------------------------------------------------------
r = subprocess.run(['node', '-e',
    "new Function('DCLogic','StreamableLogic','React',require('fs').readFileSync(process.argv[1],'utf8'))",
    APP], capture_output=True, text=True)
if r.returncode:
    fail('foxy-app.js does not parse: ' + r.stderr.strip().split('\n')[0][:120])
else:
    ok('foxy-app.js parses')

# 2b. every identifier resolves --------------------------------------------
# The parse check cannot see a binding that reads a local which was removed:
# the file is valid JavaScript and every render throws ReferenceError. This
# happened once. A real parser with scope tracking catches it.
r = subprocess.run(['node', 'tools/check-undefined.js'], capture_output=True, text=True)
if r.returncode:
    fail('undefined identifiers: ' + ', '.join(
        l.split()[1] for l in r.stdout.split('\n') if l.startswith('UNDEFINED'))[:200])
else:
    ok('every identifier resolves')

# 3. bindings -----------------------------------------------------------
refs = sorted(set(re.findall(r'\{\{ ([a-zA-Z_][a-zA-Z0-9_]*)', markup)))
missing = [n for n in refs if not re.search(r'\b' + re.escape(n) + r'\b', app)]
if missing:
    fail('markup renders %d binding(s) the app never defines: %s' % (len(missing), ', '.join(missing[:8])))
else:
    ok('%d markup bindings all defined' % len(refs))

# 4. method calls ---------------------------------------------------------
calls = set(re.findall(r'this\.([a-zA-Z][a-zA-Z0-9_]*)\(', app))
defs = set(re.findall(r'\n  ([a-zA-Z_][a-zA-Z0-9_]*)\(', app))
inherited = {'setState', 'forceUpdate'}
dangling = sorted(c for c in calls if c not in defs and c not in inherited)
if dangling:
    fail('this.x() with no method: ' + ', '.join(dangling))
else:
    ok('%d method calls all resolve' % len(calls))

# 5. animations --------------------------------------------------------
defined = set(re.findall(r'@keyframes ([A-Za-z][A-Za-z0-9_-]*)', markup + index))
used = set(re.findall(r'animation:([A-Za-z][A-Za-z0-9_-]*)', markup + app)) - {'none'}
orphan = sorted(u for u in used if u not in defined)
if orphan:
    fail('animations with no @keyframes: ' + ', '.join(orphan))
else:
    ok('%d animations all defined' % len(used))

# 6 and 7. assets ------------------------------------------------------
web = sorted(f for f in os.listdir('Web') if os.path.isfile(os.path.join('Web', f)))
texts = {f: open(os.path.join('Web', f), encoding='utf8', errors='replace').read()
         for f in web if f.endswith(('.js', '.html', '.css'))}
# every Swift file, in Foxy/ and its subfolders (Tor/, Network/, Bridge/, ...)
swift_files = sorted(os.path.join(d, f) for d, _, names in os.walk('Foxy')
                     for f in names if f.endswith('.swift'))
swift = ''.join(open(p, encoding='utf8', errors='replace').read() for p in swift_files)

# A file counts as loaded only where the code actually loads it: a src or href
# attribute, a CSS url(), or a bare quoted filename. Matching every
# "something.js" in the text also matched fragments of CDN URLs and comments.
LOAD = re.compile(r'''(?:src=|href=|url\(|['"])\s*['"]?([A-Za-z0-9_-]+\.(?:webp|jpg|jpeg|png|woff2|woff|js|css|svg))['"\)]''')
loaded = set()
for src in texts.values():
    loaded |= set(LOAD.findall(src))
absent = sorted(l for l in loaded if l not in web and l != 'index.html')
if absent:
    fail('referenced but not in Web/: ' + ', '.join(absent))
else:
    ok('every referenced file exists in Web/')

unloaded = []
for f in web:
    if f == 'index.html' or f.endswith('.md'):
        continue
    stem = os.path.splitext(f)[0]
    if not any(f in t for n, t in texts.items() if n != f) and f not in swift and stem not in swift:
        unloaded.append(f)
if unloaded:
    fail('in Web/ but nothing loads it: ' + ', '.join(unloaded))
else:
    ok('every file in Web/ is loaded by something')

# 8. balance -------------------------------------------------------------
# 0 since the stray </div> after the restore screen was removed;
# it had pushed the blocked screen and fourteen overlays out of the theme.
d = markup.count('<div') - markup.count('</div>')
if d != 0:
    fail('div balance is %d, baseline is 0' % d)
elif markup.count('<sc-if') != markup.count('</sc-if>'):
    fail('sc-if tags unbalanced')
else:
    ok('markup balance at baseline')

# 9. vocabulary -----------------------------------------------------------
words = ['kyc', 'plaid', 'fygaro', 'jkName', 'cardHub', 'bizVals', 'leaflet',
         'cartocdn', 'nomoreinflation', '/Users/', 'getflash']
# Words that are themselves not for publishing (a name, a handle): one per
# line in tools/smoke-private.txt, which is not in the repository. Absent, the
# list above is the whole check.
try:
    with open(os.path.join(HERE, 'tools', 'smoke-private.txt'), encoding='utf8') as _private:
        words += [w.strip() for w in _private if w.strip() and not w.startswith('#')]
except OSError:
    pass
# the packed index is base64 soup — "kyc" turns up inside image data — so the
# sources are what get searched, plus the shell's text outside the manifest
shell_text = re.sub(r'<script type="__bundler/manifest">.*?</script>', '', index, flags=re.S)
hits = {w: len(re.findall(re.escape(w), app + markup + shell_text, re.I)) for w in words}
# Flash is listed on the GET DOLLARS screen by choice:
# its web address there is the one allowed mention, once, and no other
hits['getflash'] -= min(hits['getflash'], len(re.findall(r"url: 'getflash\.io'", app + markup + shell_text)))
# the specific claim, not the domain: "your lightning address" beside a handle
for phrase in ['YOUR LIGHTNING ADDRESS', 'YOUR USERNAME / LNURL', "lightningAddress:"]:
    if phrase in app + markup:
        hits[phrase] = 1
hits = {w: n for w, n in hits.items() if n}
if hits:
    fail('fork vocabulary present: ' + ', '.join('%s x%d' % kv for kv in hits.items()))
else:
    ok('no fork vocabulary')

# 9b. the receive-address residue -------------------------------------------
# walletofsatoshi.com is allowed on the send paths — a chip that appends the
# domain to a recipient being typed is a deliberate shortcut for the wallet
# most of these users hold. It is NOT allowed anywhere that presents an
# address as the user's own: that is what the audit found, a custodial service
# with no relationship to this project shown to people as where to be paid.
#
# The test is the words around it, not the domain itself.
bad = []
for m in re.finditer(r'walletofsatoshi', app + markup, re.I):
    near = (app + markup)[max(0, m.start() - 220):m.start()].upper()
    if any(w in near for w in ['YOUR LIGHTNING ADDRESS', 'YOUR USERNAME',
                               'LNURL', 'lightningAddress']):
        bad.append(near[-60:])
if bad:
    fail('walletofsatoshi presented as the user\'s own address: ' + ' | '.join(bad[:2]))
else:
    ok('walletofsatoshi appears only on send paths')

# 10. crypto ------------------------------------------------------------
r = subprocess.run(['node', 'tools/foxy-crypto-vectors.js'], capture_output=True, text=True)
if r.returncode:
    fail('crypto vectors: ' + (r.stdout.strip().split('\n')[-1] if r.stdout else r.stderr[:100]))
else:
    ok('crypto vectors: ' + r.stdout.strip().split('\n')[-1])

# 11. vendor ---------------------------------------------------------------
r = subprocess.run([sys.executable, 'tools/verify-vendor.py'], capture_output=True, text=True)
if r.returncode:
    fail('vendor: ' + r.stdout.strip().split('\n')[-1])
else:
    ok('vendored libraries verified')

# 12. the proof lock cannot deadlock ---------------------------------------
#
# Nine functions run one at a time through withProofs(). The lock is not
# reentrant, so if any of them called another the second would wait for a lock
# the first already holds, and the wallet would stop — silently, on a money
# path, with no error to look at.
#
# That none of them does was checked by hand and written in a comment, which is
# the kind of claim that rots the first time someone adds a call. This checks
# it on every build instead.
wallet_src = open('Web/foxy-wallet.js', newline='').read()
m = re.search(r"\[('claimQuote'[^\]]+)\]\.forEach", wallet_src, re.S)
if not m:
    fail('proof lock: could not find the list of locked functions')
else:
    locked = re.findall(r"'([a-zA-Z]+)'", m.group(1))
    offenders = []
    for name in locked:
        # the function as defined on the public surface, up to the next member
        d = re.search(r'\n    ' + name + r': function[^\n]*\n(.*?)\n    [a-zA-Z_]+:',
                      wallet_src, re.S)
        if not d:
            continue
        body = d.group(1)
        for other in locked:
            if other == name:
                continue
            # FoxyWallet.other(...) or this.other(...) — a call through the
            # wrapped surface, which is the one that would block
            if re.search(r'(FoxyWallet|this)\.' + other + r'\s*\(', body):
                offenders.append('%s calls %s' % (name, other))
    if offenders:
        fail('proof lock: a locked function calls another — ' + '; '.join(offenders))
    else:
        ok('proof lock: %d functions, none calls another' % len(locked))

# 13. every cashu-ts Wallet is built the same way --------------------------
#
# With embedded Tor on, newWallet() is what makes a mint call go over the
# bridge instead of the page's fetch. Four of five constructions once missed
# it, and a packet capture found the result: a seed scan opened TLS to a mint
# in the clear while the wallet was connected over Tor. A sixth construction
# must not be able to miss it quietly.
# Count constructions inside newWallet() against those outside it, rather than
# against a fixed number — the helper legitimately grew from two to four when
# the Mint branch was added, and a fixed count made that a false failure.
if 'function newWallet(' not in wallet_src:
    ok('cashu-ts wallets: no newWallet() helper in this build')
else:
    start = wallet_src.index('function newWallet(')
    depth, i = 0, wallet_src.index('{', start)
    while i < len(wallet_src):
        if wallet_src[i] == '{':
            depth += 1
        elif wallet_src[i] == '}':
            depth -= 1
            if depth == 0:
                break
        i += 1
    body = wallet_src[start:i]
    rest = wallet_src[:start] + wallet_src[i:]
    outside = len(re.findall(r'new window\.CashuTS\.(Wallet|Mint)\(', rest))
    inside = len(re.findall(r'new window\.CashuTS\.(Wallet|Mint)\(', body))
    if outside:
        fail('cashu-ts wallets: %d construction(s) outside newWallet() — '
             'those bypass the Tor routing' % outside)
    else:
        built = len(re.findall(r'newWallet\(', rest))
        ok('cashu-ts wallets: %d call sites, %d constructions, all inside newWallet()'
           % (built, inside))

# 14. no socket to the mint -------------------------------------------------
#
# A WebSocket from the page cannot be routed through the native side, so it
# resolves and connects in the clear whatever the app believes about Tor. The
# NUT-17 subscription is what leaked a mint's hostname in capture 4, after
# every fetch had been routed. countersReserved is local, not a subscription.
page_js = {f: open(os.path.join('Web', f), encoding='utf8', errors='replace').read()
           for f in ('foxy-wallet.js', 'foxy-tor-gate.js', 'foxy-send-progress.js')
           if os.path.exists(os.path.join('Web', f))}
page_js[APP] = app
sockets = []
for name, src in page_js.items():
    for pat in (r'new\s+WebSocket\b', r'\.on\.(?!countersReserved\b)[a-zA-Z]+\(',
                r'\b(?:mintQuoteUpdates|meltQuoteUpdates|proofStateUpdates|connectWebSocket)\b'):
        for m in re.finditer(pat, src):
            sockets.append('%s: %s' % (name, m.group(0)))
if sockets:
    fail('a socket the native side cannot route: ' + ', '.join(sockets[:4]))
else:
    ok('no mint WebSocket in the page')

# 15. the vendored IPtProxy is the one tools/build-iptproxy.sh produces ----------
#
# Bridges run in the wallet's process, so the framework has to be the build
# anyone can reproduce from the pinned sources, not whatever happens to be on
# disk. The checksums are committed; the framework is not.
xcf = 'Vendor/IPtProxy.xcframework'
sumfile = 'Vendor/IPtProxy.sha256'
if not os.path.isdir(xcf):
    skip('15', 'IPtProxy is not built here, so it was not compared with Vendor/IPtProxy.sha256 (sh tools/build-iptproxy.sh)')
elif not os.path.exists(sumfile):
    fail('Vendor/IPtProxy.xcframework present but Vendor/IPtProxy.sha256 missing')
else:
    import hashlib
    want = {}
    for line in open(sumfile):
        parts = line.split()
        if len(parts) == 2: want[parts[1].lstrip('./')] = parts[0]
    bad = []
    for rel, digest in want.items():
        path = os.path.join(xcf, rel)
        got = hashlib.sha256(open(path, 'rb').read()).hexdigest() if os.path.exists(path) else 'missing'
        if got != digest: bad.append(rel.split('/')[0])
    if bad or not want:
        fail('IPtProxy does not match its checksums: ' + (', '.join(bad) or 'no checksums'))
    else:
        ok('IPtProxy matches its reproducible checksums (%d slices)' % len(want))

# 16. the page runs no script it did not ship ---------------------------------
#
# Any HTML that reached the page — a bug, one day, somewhere — would run as
# script under 'unsafe-inline', and 'unsafe-eval' lets any string run. With
# neither, the only inline script is the loader, allowed by its hash, and the
# app arrives as blob scripts the loader makes. The hash is recomputed by
# pack-index.py; this confirms what shipped matches.
import hashlib, base64
csp_m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', index)
script_src = ''
if csp_m:
    for part in csp_m.group(1).split(';'):
        if part.strip().startswith('script-src'):
            script_src = part.strip()
loaders = re.findall(r'<script>(.*?)</script>', index[:index.find('<script type="__bundler/manifest">')], re.S)
if not csp_m or not script_src:
    fail('no script-src in the page policy')
elif "'unsafe-inline'" in script_src or "'unsafe-eval'" in script_src:
    fail('script-src still allows inline or eval: ' + script_src)
elif len(loaders) != 1:
    fail('expected one inline loader script before the manifest, found %d' % len(loaders))
else:
    want = "'sha256-" + base64.b64encode(hashlib.sha256(loaders[0].encode('utf-8')).digest()).decode() + "'"
    if want not in script_src:
        fail('the loader hash in the policy does not match the loader — the page would not start')
    else:
        # the runtime compiles the app only through the loader's factory now
        import gzip
        mi = index.find('<script type="__bundler/manifest">') + len('<script type="__bundler/manifest">')
        manifest = json.loads(index[mi:index.find('</script>', mi)])
        runtime = ''
        for entry in manifest.values():
            if 'javascript' not in entry.get('mime', ''):
                continue
            raw = base64.b64decode(entry['data'])
            text = (gzip.decompress(raw) if entry.get('compressed') else raw).decode('utf-8', 'replace')
            if 'function evalDcLogic(' in text:
                runtime = text
        body = runtime[runtime.find('function evalDcLogic('):]
        body = body[:body.find('\n  }\n') + 4]
        if not runtime:
            fail('the design runtime is not in the manifest')
        elif 'new Function' in body or '__foxyComponentFactory' not in body:
            fail("the runtime's evalDcLogic still compiles text instead of calling the loader's factory")
        elif '__foxyComponentFactory' not in loaders[0]:
            fail("the loader does not deliver the app as a factory script")
        else:
            ok('page policy: no inline or eval script; loader allowed by its hash; app loaded without eval')

# 17. requests that cannot reach Tor fail --------------------------------------
#
# ProxyConfiguration with allowFailover false is what makes a request that
# cannot reach Tor fail rather than go out without it, and it exists from iOS 17.
# The older proxy dictionary promises no such thing, so it must not come back,
# and the app must not install where only it would work.
target_m = re.search(r'deploymentTarget:\s*(?:#[^\n]*\n\s*)*iOS:\s*"?([0-9.]+)', open('project.yml').read())
pod_m = re.search(r"platform :ios, '([0-9.]+)'", open('Podfile').read())
swift_src = ''.join(open(p, encoding='utf8').read() for p in swift_files)
dict_proxy = re.findall(r'\.connectionProxyDictionary\s*=', swift_src)
if not target_m or float(target_m.group(1)) < 17:
    fail('project.yml deployment target is below iOS 17: ' + (target_m.group(1) if target_m else 'not found'))
elif not pod_m or float(pod_m.group(1)) < 17:
    fail('Podfile platform is below iOS 17: ' + (pod_m.group(1) if pod_m else 'not found'))
elif dict_proxy:
    fail('connectionProxyDictionary is set again: a proxy that may fail over around Tor')
elif 'allowFailover = false' not in swift_src:
    fail('the Tor session no longer sets allowFailover = false')
else:
    ok('iOS 17 minimum; the Tor session cannot fail over around Tor')

# 17b. the leaks closed after the IP review stay closed ---------------
#
# Each of these is a line that removing, in a tidy-up, would quietly reopen a
# way for the phone's IP address to get out around Tor.
wv_src = open(os.path.join('Foxy', 'FoxyWebView.swift')).read()
needs = [
    ("'RTCPeerConnection'" in wv_src and 'forMainFrameOnly: false' in wv_src,
     'WebRTC is no longer removed from every frame (its STUN traffic goes around Tor)'),
    ('allowsLinkPreview = false' in wv_src, 'link previews are back on the web view'),
    ('-webkit-touch-callout:none' in wv_src, 'the long-press callout and selection menu are back'),
    ('c.options["SafeSocks"] = "1"' in swift_src, 'Tor no longer refuses requests that arrive as bare IP addresses (SafeSocks)'),
    ('c.options["ClientRejectInternalAddresses"] = "1"' in swift_src, 'Tor no longer refuses internal addresses explicitly'),
    ('cfg.httpAdditionalHeaders = Route.genericHeaders' in swift_src, 'the Tor session sends the default user agent (names Foxy and its iOS version)'),
    ('Route.urlProblem(url)' in swift_src and 'return hostProblem(url)' in swift_src,
     'mint requests no longer refuse IP literals, LAN names and .onion without Tor'),
    ('static let order: [TorTransport] = [.direct, .obfs4, .snowflake]' in swift_src, 'Snowflake is tried before obfs4 again'),
    ('bridgeMemory' in swift_src, 'a remembered bridge no longer expires'),
]
broken = [msg for good, msg in needs if not good]
if broken:
    for msg in broken:
        fail(msg)
else:
    ok('IP review protections in place: no WebRTC, no previews or selection menu, SafeSocks, generic headers, host checks, obfs4 before Snowflake')

# 17d. redirects meet the same rules as the first URL ----------------------------
#
# A mint URL is checked before the request, but a redirect is a new request to
# a URL the server chose. Unprotected, a hostile mint could have sent the phone
# to http://192.168.1.1/. Every URLSession Foxy makes carries Route.redirectGuard,
# which cancels a redirect failing Route.redirectProblem; and the scheme test is
# https, or http to an .onion — never "any scheme if the host ends in .onion".
bridge_src = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge.swift')).read()
route_src = open(os.path.join('Foxy', 'Network', 'Route.swift')).read()
made = re.findall(r'URLSession\((configuration:[^\n]*)\)', swift_src)
unguarded = [m for m in made if 'delegate: Route.redirectGuard' not in m and 'delegate: redirectGuard' not in m]
guard_cls = re.search(r'class RedirectGuard\b[^{]*URLSessionTaskDelegate[^{]*\{(.*?)\n\}', route_src, re.S)
url_fn = re.search(r'static func urlProblem\(_ url: URL\) -> String\? \{(.*?)\n    \}', route_src, re.S)
loose_onion = [m.group(0) for src in (swift_src,) for m in re.finditer(
    r'\|\|\s*(?:url|\w+)\.host[^\n]*hasSuffix\("\.onion"\)', src)]
needs = [
    (made and not unguarded,
     'a URLSession is made without Route.redirectGuard, so its redirects go unchecked: ' + '; '.join(unguarded)[:160]),
    ('URLSession.shared' not in swift_src, 'URLSession.shared is used: it follows redirects unchecked'),
    (re.search(r'func socksSession\(circuit: String\? = nil\) -> URLSession \{.*?return URLSession\(configuration: cfg, delegate: Route\.redirectGuard', swift_src, re.S),
     'the Tor session is not made with Route.redirectGuard'),
    ('delegate: redirectGuard' in route_src, "Route's open session is not made with its redirectGuard"),
    (guard_cls and 'willPerformHTTPRedirection' in guard_cls.group(1)
     and re.search(r'if let problem = Route\.redirectProblem\([^{]*\{[^}]*completionHandler\(nil\)\s*return\s*\}', guard_cls.group(1)),
     'RedirectGuard no longer cancels redirects that fail Route.redirectProblem'),
    (re.search(r'static func redirectProblem\([^)]*\) -> String\? \{[^}]*urlProblem\(target\)', route_src),
     'Route.redirectProblem no longer applies urlProblem to the redirect target'),
    (url_fn and 'scheme == "https" || (scheme == "http" && host.hasSuffix(".onion"))' in url_fn.group(1)
     and 'hostProblem(url)' in url_fn.group(1),
     'Route.urlProblem no longer means https, or http to an .onion, and a host that passes hostProblem'),
    ('Route.urlProblem(url)' in bridge_src, 'mintRequest no longer checks its URL with Route.urlProblem'),
    (not loose_onion, 'a scheme test accepts any scheme when the host ends in .onion: ' + ', '.join(loose_onion)[:160]),
]
broken = [msg for good, msg in needs if not good]
if broken:
    for msg in broken:
        fail(msg)
else:
    ok('%d URLSession(s), all with the redirect guard; mint URLs are https or http to .onion' % len(made))

def swift_code(text):
    """Swift without its comment lines, so a comment naming an old call does not count."""
    return '\n'.join(l for l in text.splitlines() if not l.lstrip().startswith(('//', '*', '/*')))

# 17e. a session made for one request is let go ----------------------------------
#
# Route.session() made a URLSession through Tor for every request — each price
# source, chart load and mint request — and nothing invalidated one, so each
# stayed with its delegate and connection pool for as long as the app ran.
# Requests now start through Route.start: Tor's session is still made per
# request, with the SOCKS port as it is then, and Route.startOnce invalidates it
# once its task has started. The open connection's one session is never
# invalidated, or every later unprotected request would fail.
code_all = swift_code(swift_src)
once_fn = re.search(r'static func startOnce\([^{]*\{(.*?)\n    \}', route_src, re.S)
socks_uses = [l.strip() for l in code_all.splitlines()
              if 'socksSession(' in l and 'func socksSession(' not in l
              and 'startOnce(TorService.socksSession(' not in l
              # Route.startSocket: one session for one relay socket, invalidated by its caller
              and 'let session = TorService.socksSession(circuit: circuit)' not in l]
task_files = sorted(p for p in swift_files
                    if '.dataTask(' in swift_code(open(p, encoding='utf8').read()) and not p.endswith('Route.swift'))
needs = [
    ('Route.session()' not in code_all and 'func session()' not in swift_code(route_src),
     'Route.session() is back: a session handed out with nothing to invalidate it'),
    (once_fn and re.search(r'\.dataTask\(.*?\.resume\(\).*?session\.finishTasksAndInvalidate\(\)', once_fn.group(1), re.S),
     'Route.startOnce no longer invalidates its session once the task has started'),
    (not socks_uses, "Tor's per-request session is used other than through Route.startOnce: " + '; '.join(socks_uses)[:160]),
    (not task_files, 'a data task is made outside Route.swift, where its session may never be invalidated: ' + ', '.join(task_files)),
    (not re.search(r'clearSession\.(finishTasksAndInvalidate|invalidateAndCancel)', code_all),
     "the open connection's shared session is invalidated: every later unprotected request would fail"),
]
broken = [msg for good, msg in needs if not good]
if broken:
    for msg in broken:
        fail(msg)
else:
    ok("each request's Tor session is invalidated once its task starts; the open session is kept")

# 17f. the share sheet fetches no link preview -------------------------------------
#
# Handed a bare string, UIActivityViewController looks for a link in it and
# LinkPresentation fetches a preview from the share sheet's process, outside
# Tor. FoxyBridge shares a ShareText, which supplies its own LPLinkMetadata with
# a title and no URL, and gives every activity plain text.
share_fn = re.search(r'private func presentShare\(.*?\n    \}', bridge_src, re.S)
share_cls = re.search(r'class ShareText\b[^{]*UIActivityItemSource[^{]*\{(.*?)\n\}', bridge_src, re.S)
meta_fn = share_cls and re.search(r'func activityViewControllerLinkMetadata\([^{]*\{(.*?)\n    \}', share_cls.group(1), re.S)
needs = [
    (share_fn and 'UIActivityViewController(activityItems: [ShareText(' in share_fn.group(0),
     'the share sheet is handed something other than ShareText: iOS can fetch a link preview outside Tor'),
    (meta_fn and 'LPLinkMetadata()' in meta_fn.group(1)
     and not re.search(r'\.(url|originalURL|iconProvider|imageProvider|videoProvider|remoteVideoURL)\s*=', meta_fn.group(1)),
     'ShareText no longer supplies LPLinkMetadata without a URL, so the share sheet can fetch a preview'),
    (share_cls and 'itemForActivityType' in share_cls.group(1) and 'URL(' not in share_cls.group(1),
     'ShareText hands an activity something other than plain text'),
    ('LPMetadataProvider' not in code_all, 'LPMetadataProvider is used: it fetches pages outside Tor'),
    (len(re.findall(r'UIActivityViewController\(activityItems:', code_all)) == 1,
     'a share sheet is presented somewhere other than presentShare'),
]
broken = [msg for good, msg in needs if not good]
if broken:
    for msg in broken:
        fail(msg)
else:
    ok('the share sheet gets its preview header from Foxy, with no URL to fetch, and plain text')

# 17c. the app switcher shows no wallet, and no third-party keyboard reads it -----
#
# iOS photographs the screen as Foxy leaves the foreground: a cover over the
# window keeps a balance or the twelve words out of that picture. And a
# keyboard extension with full access sees every key, the restore words and
# the PIN among them, so Foxy refuses them app-wide.
app_swift = open(os.path.join('Foxy', 'FoxyApp.swift')).read()
cover_fn = re.search(r'@objc private func coverScreen\(\) \{(.*?)\n    \}', wv_src, re.S)
adaptor = re.search(r'@UIApplicationDelegateAdaptor\((\w+)\.self\)', app_swift)
delegate = adaptor and re.search(r'class ' + adaptor.group(1) + r'\b[^{]*UIApplicationDelegate[^{]*\{(.*?)\n\}', swift_src, re.S)
needs = [
    # resigning active covers the screen; the one exception is iOS's paste prompt, which Foxy asked for
    (re.search(r'#selector\(resigningActive\),\s*name: UIApplication\.willResignActiveNotification', wv_src)
     and re.search(r'@objc private func resigningActive\(\) \{\s*if FoxyBridge\.pastePromptExpected \{[^}]*return\s*\}\s*coverScreen\(\)\s*\}', wv_src),
     'the app-switcher cover is no longer put up when Foxy resigns active'),
    (re.search(r'func appEnteredBackground\(\) \{[^}]*coverScreen\(\)', wv_src),
     'the app-switcher cover is no longer put up on entering the background'),
    (re.search(r'#selector\(appEnteredBackground\),\s*name: UIApplication\.didEnterBackgroundNotification', wv_src),
     'entering the background is no longer observed'),
    (cover_fn and 'addSubview(image)' in cover_fn.group(1) and 'view.window' in cover_fn.group(1),
     'the app-switcher cover no longer goes over the window'),
    (re.search(r'func appBecameActive\(\) \{[^}]*removeCover\(\)', wv_src),
     'the app-switcher cover is never taken down on return'),
    (delegate and re.search(r'shouldAllowExtensionPointIdentifier[^{]*\{\s*extensionPointIdentifier != \.keyboard\s*\}', delegate.group(1)),
     'third-party keyboards are no longer refused (application(_:shouldAllowExtensionPointIdentifier:) in the app delegate)'),
]
broken = [msg for good, msg in needs if not good]
if broken:
    for msg in broken:
        fail(msg)
else:
    ok('app-switcher cover over the window on resign and background; third-party keyboards refused')

# 18. Tor is the build recorded, from signed sources --------------------------
#
# Tor runs inside the wallet's process. Its C library is built by
# tools/build-tor.sh from commit-pinned, signature-checked sources into
# Vendor/TorPod, and CocoaPods takes the pod from there: nothing prebuilt is
# downloaded. This checks that the Podfile still points there, that the podspec
# fetches nothing, that the Objective-C wrapper is the one recorded, and, where
# the library has been built, that it is byte for byte the build recorded in
# Vendor/Tor.sha256 (the same listing build-tor.sh hashes).
import hashlib
torsum = 'Vendor/Tor.sha256'
torpod = os.path.join('Vendor', 'TorPod')
torfw = os.path.join(torpod, 'tor.xcframework')
problems18 = []
def sha18(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()
podfile18 = open('Podfile').read() if os.path.exists('Podfile') else ''
podspec18_path = os.path.join(torpod, 'Tor.podspec')
podspec18 = open(podspec18_path).read() if os.path.exists(podspec18_path) else ''
if "pod 'Tor', :path => 'Vendor/TorPod'" not in podfile18:
    problems18.append('the Podfile no longer takes Tor from Vendor/TorPod')
# The Podfile's code, its comments and blank lines left out, is pinned: another
# pod, a script phase, a plugin or a change to the post_install hook (Ruby that
# pod install runs) has to be a deliberate change to this pin (audit
# finding T6). Looking for a few strings let all of those through.
PODFILE_CODE_SHA256 = '78f6e779fa8d490c70a3c98594b0bbc4cb90ff7100f83eb74ea2133f36f6247a'   # FoxyTests target (inherit! :search_paths) added
podcode18 = ''.join(l.rstrip() + '\n' for l in podfile18.splitlines() if l.strip() and not l.lstrip().startswith('#'))
if hashlib.sha256(podcode18.encode()).hexdigest() != PODFILE_CODE_SHA256:
    problems18.append('the Podfile is not the pinned one (comments aside): review the change, then update PODFILE_CODE_SHA256 in tools/smoke.py')
if os.path.exists('Podfile.lock'):
    lock18 = open('Podfile.lock').read()
    pods18 = re.findall(r'^  - "?([^\s"(]+)', lock18.split('DEPENDENCIES:')[0], re.M)
    if not pods18 or any(p != 'Tor' and not p.startswith('Tor/') for p in pods18):
        problems18.append('Podfile.lock installs a pod other than Tor: ' + ', '.join(sorted(set(pods18))))
if not podspec18 or re.search(r'\.prepare_command\s*=', podspec18) or "vendored_frameworks = 'tor.xcframework'" not in podspec18:
    problems18.append('Vendor/TorPod/Tor.podspec downloads something, or no longer uses the tor.xcframework built here')
if os.path.exists('Podfile.lock') and 'Tor (from `Vendor/TorPod`)' not in open('Podfile.lock').read():
    problems18.append('Podfile.lock does not take Tor from Vendor/TorPod (pod install)')
if not os.path.exists(torsum):
    problems18.append('Vendor/Tor.sha256 is missing (bash tools/build-tor.sh)')
else:
    want18 = {}
    for line in open(torsum).read().splitlines():
        parts = line.split()
        if len(parts) == 2 and not line.startswith('#'):
            want18[parts[1]] = parts[0]
    wrapper = {k: v for k, v in want18.items() if k.startswith('Tor/')}
    if not wrapper:
        problems18.append('Vendor/Tor.sha256 lists no Objective-C wrapper files')
    for rel, digest in sorted(wrapper.items()):
        path = os.path.join(torpod, rel)
        if not os.path.exists(path) or sha18(path) != digest:
            problems18.append(rel + ' differs from Vendor/Tor.sha256')
    for d, _, names in os.walk(os.path.join(torpod, 'Tor')):
        for n in names:
            rel = os.path.relpath(os.path.join(d, n), torpod)
            if rel not in wrapper:
                problems18.append(rel + ' is not listed in Vendor/Tor.sha256')
    # the rest of the pod: its podspec and licence, the patch and header fixer
    # build-tor.sh uses, and the keys the sources must be signed with. Every file
    # in Vendor/TorPod outside Tor/ and the built tor.xcframework is listed.
    podrest = {k: v for k, v in want18.items() if not k.startswith(('Tor/', 'tor.xcframework'))}
    for need in ('Tor.podspec', 'LICENSE', 'mmap-cache.patch', 'fix_includes.pl'):
        if need not in podrest:
            problems18.append('Vendor/Tor.sha256 does not list Vendor/TorPod/' + need)
    for rel, digest in sorted(podrest.items()):
        path = os.path.join(torpod, rel)
        if not os.path.exists(path) or sha18(path) != digest:
            problems18.append('Vendor/TorPod/' + rel + ' differs from Vendor/Tor.sha256')
    for d, dirs, names in os.walk(torpod):
        rel_d = os.path.relpath(d, torpod)
        if rel_d == '.':
            dirs[:] = [x for x in dirs if x not in ('Tor', 'tor.xcframework')]
        for n in names:
            rel = os.path.normpath(os.path.join(rel_d, n))
            if n != '.DS_Store' and rel not in podrest:
                problems18.append('Vendor/TorPod/' + rel + ' is not listed in Vendor/Tor.sha256')
    if 'tor.xcframework' not in want18:
        problems18.append('Vendor/Tor.sha256 records no tor.xcframework build')
    elif os.path.isdir(torfw):
        rows = []
        for d, dirs, files in os.walk(torfw):
            for n in dirs + files:
                path = os.path.join(d, n)
                rel = os.path.relpath(path, torfw)
                if os.path.islink(path):
                    rows.append((rel, 'link %s -> %s' % (rel, os.readlink(path))))
                elif os.path.isfile(path):
                    rows.append((rel, '%s %s' % (sha18(path), rel)))
        listing = ''.join(row + '\n' for _, row in sorted(rows, key=lambda r: ('./' + r[0]).encode()))
        if hashlib.sha256(listing.encode()).hexdigest() != want18['tor.xcframework']:
            problems18.append('Vendor/TorPod/tor.xcframework is not the build Vendor/Tor.sha256 records')
if problems18:
    fail('Tor: ' + '; '.join(problems18))
elif not os.path.isdir(torfw):
    ok('Tor comes from Vendor/TorPod: the Podfile, podspec, licence, patch, header fixer, keys and wrapper are the ones pinned')
    skip('18', 'tor.xcframework is not built here, so it was not compared with Vendor/Tor.sha256 (bash tools/build-tor.sh)')
else:
    ok('Tor is the build Vendor/Tor.sha256 records, from signed sources; the Podfile, podspec, patch, keys and wrapper are the ones pinned')

# 19. the built-in bridges have a date ----------------------------------------
#
# Bridges move and certificates change, so the obfs4 and Snowflake lines go
# stale. tools/update-bridges.py refreshes them between these markers and stamps
# the date. A missing marker fails; an old date only says so, because an old
# list still works where direct Tor does.
import datetime
qr = open('Foxy/Tor/Bridges.swift').read()
bm = re.search(r'// BEGIN BUILT-IN BRIDGES\b[^\n]*?(\d{4}-\d{2}-\d{2})', qr)
if not bm or '// END BUILT-IN BRIDGES' not in qr:
    fail('the BUILT-IN BRIDGES markers are missing from Foxy/Tor/Bridges.swift')
else:
    age = (datetime.date.today() - datetime.date.fromisoformat(bm.group(1))).days
    if age > 180:
        ok('built-in bridges are %d days old — run python3 tools/update-bridges.py' % age)
    else:
        ok('built-in bridges fetched %s (%d days ago)' % (bm.group(1), age))

# 20. no method of the app class is defined twice -----------------------------
#
# A class keeps the last definition of a name, silently. componentWillUnmount
# was written twice, and the first — which removed every listener and cleared
# most timers — never ran.
app_src = open('build/foxy-app.js', encoding='utf-8').read()
cls_at = app_src.find('class Component extends DCLogic {')
names = re.findall(r'^  (?:async\s+|static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$', app_src[cls_at:], re.M)
names = [n for n in names if n not in ('if', 'for', 'while', 'switch', 'catch', 'function')]
dupes = sorted({n for n in names if names.count(n) > 1})
if cls_at < 0:
    fail('could not find the app class in build/foxy-app.js')
elif dupes:
    fail('methods defined twice in the app class (only the last one runs): ' + ', '.join(dupes))
else:
    ok('app class: %d methods, none defined twice' % len(names))

# 21. the App Store privacy manifest is bundled --------------------------------
#
# App Store Connect rejects an upload whose code calls a "required reason" API
# that PrivacyInfo.xcprivacy gives no reason for. The Swift is grepped for each
# category. Tor.framework and the static IPtProxy call stat/fstat/lstat and
# mach_absolute_time (nm -u), and neither ships a manifest of its own, so those
# two categories are needed whatever the Swift does. Foxy tracks nothing.
import plistlib
manifest_path = os.path.join('Foxy', 'PrivacyInfo.xcprivacy')
api_greps = {
    'NSPrivacyAccessedAPICategoryUserDefaults': r'\bUserDefaults\b',
    'NSPrivacyAccessedAPICategoryFileTimestamp': r'\b(?:creationDate|contentModificationDate|fileModificationDate|modificationDate|attributesOfItem)\w*\b',
    'NSPrivacyAccessedAPICategorySystemBootTime': r'\b(?:systemUptime|mach_absolute_time)\b',
    'NSPrivacyAccessedAPICategoryDiskSpace': r'\b(?:volumeAvailableCapacity\w*|volumeTotalCapacity\w*|systemFreeSize|systemSize|statfs|statvfs)\b',
    'NSPrivacyAccessedAPICategoryActiveKeyboards': r'\bactiveInputModes\b',
}
framework_needs = {'NSPrivacyAccessedAPICategoryFileTimestamp', 'NSPrivacyAccessedAPICategorySystemBootTime'}
if not os.path.exists(manifest_path):
    fail('Foxy/PrivacyInfo.xcprivacy is missing: App Store uploads are rejected without it')
else:
    try:
        manifest = plistlib.load(open(manifest_path, 'rb'))
    except Exception as e:
        manifest = None
        fail('Foxy/PrivacyInfo.xcprivacy is not a valid plist: %s' % e)
    if manifest is not None:
        declared = {}
        for entry in manifest.get('NSPrivacyAccessedAPITypes', []):
            declared[entry.get('NSPrivacyAccessedAPIType')] = entry.get('NSPrivacyAccessedAPITypeReasons') or []
        used = {cat for cat, pat in api_greps.items() if re.search(pat, swift_src)} | framework_needs
        missing = sorted(cat for cat in used if not declared.get(cat))
        pbx = os.path.join('Foxy.xcodeproj', 'project.pbxproj')
        if manifest.get('NSPrivacyTracking') is not False or manifest.get('NSPrivacyTrackingDomains'):
            fail('the privacy manifest declares tracking (NSPrivacyTracking must be false, no tracking domains)')
        elif manifest.get('NSPrivacyCollectedDataTypes'):
            fail('the privacy manifest declares collected data: Foxy collects none')
        elif missing:
            fail('required-reason APIs with no reason in the privacy manifest: ' + ', '.join(c.replace('NSPrivacyAccessedAPICategory', '') for c in missing))
        elif os.path.exists(pbx) and 'PrivacyInfo.xcprivacy in Resources' not in open(pbx).read():
            fail('Foxy.xcodeproj does not copy PrivacyInfo.xcprivacy into the app (run xcodegen generate)')
        else:
            ok('privacy manifest: no tracking, nothing collected, reasons for ' + ', '.join(sorted(c.replace('NSPrivacyAccessedAPICategory', '') for c in declared)))

# ---- 22. nothing outside #if DEBUG uses what only a Debug build defines -----
# The WebRTC blocker was declared inside #if DEBUG and used in every build: Debug
# compiled, Release did not, and the one guard against a WebRTC IP leak would
# have been missing from any Release build that did. Static members declared in
# a DEBUG-only region must not be named outside one.
def blank_comments(text):
    """The text with its comments turned to spaces, newlines kept.

    Offsets and line numbers match the original exactly, so the spans from
    debug_regions and the line a problem is reported on stay right.

    Check 22 read names in comments as uses. `/// TorController.connect() can
    report failure while having succeeded` - a doc comment at TorService.swift:26
    - was reported as a Release build that would not compile. A comment cannot
    break a build. It was the second such collision in a day, after a member
    named `current`, so this fixes the class rather than renaming past it.

    String literals are stepped over, never blanked, and that is the part that
    matters. The `//` in "https://..." is not a comment. And a use written inside
    \\(...) interpolation is a real use: blanking strings would hide it, which is
    the dangerous direction for this check - it would pass a Release build that
    does not compile.
    """
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        if text.startswith('"""', i):                     # multi-line string: step over
            end = text.find('"""', i + 3)
            i = n if end < 0 else end + 3
        elif text[i] == '"':                              # one-line string: step over
            j = i + 1
            while j < n and text[j] not in '"\n':
                j += 2 if text[j] == '\\' else 1
            i = j + 1
        elif text.startswith('//', i):                    # line comment: blank to end of line
            end = text.find('\n', i)
            end = n if end < 0 else end
            for k in range(i, end):
                out[k] = ' '
            i = end
        elif text.startswith('/*', i):                    # block comment: blank, keep newlines
            end = text.find('*/', i + 2)
            end = n if end < 0 else end + 2
            for k in range(i, end):
                if out[k] != '\n':
                    out[k] = ' '
            i = end
        else:
            i += 1
    return ''.join(out)

def debug_only_condition(rest):
    """Does this #if condition hold ONLY in a Debug build?

    `rest == 'DEBUG'` was an exact match, so `#if DEBUG && canImport(Tor)` —
    which ResumeDiagnostics.swift is — counted as no region at all. That is the
    wrong answer twice over: a Debug-only symbol used there was reported as used
    in Release (a false alarm), and, worse, anything DECLARED there was filed as
    a Release symbol, so a genuine Release-compile break inside such a region
    would have been missed.

    With `&&` every conjunct is required, so DEBUG being one of them is enough.
    With `||` it is not: the other side can hold in a Release build, so a
    condition containing one is never treated as Debug-only.
    """
    if '||' in rest:
        return False
    return any(part.strip() == 'DEBUG' for part in rest.split('&&'))

def debug_regions(text):
    """(start, end) spans of #if DEBUG bodies, #else branches excluded."""
    spans, stack = [], []
    for m in re.finditer(r'^[ \t]*#(if|elseif|else|endif)\b(.*)$', text, re.M):
        kind, rest = m.group(1), m.group(2).strip()
        if kind == 'if':
            stack.append([debug_only_condition(rest), m.end()])
        elif kind in ('else', 'elseif') and stack:
            top = stack[-1]
            if top[0]:
                spans.append((top[1], m.start()))
            top[0], top[1] = False, m.end()
        elif kind == 'endif' and stack:
            top = stack.pop()
            if top[0]:
                spans.append((top[1], m.start()))
    return spans

debug_only, outside_uses = {}, []
for path in swift_files:
    text = open(path, encoding='utf8').read()
    spans = debug_regions(text)
    inside = lambda i: any(a <= i < b for a, b in spans)
    # A declaration in a comment is not one either: a commented-out `static func
    # check` in Release code would otherwise exempt `check` from this check.
    code = blank_comments(text)
    for m in re.finditer(r'\bstatic\s+(?:let|var|func)\s+(\w+)', code):
        if inside(m.start()):
            debug_only.setdefault(m.group(1), set()).add(path)
        else:
            debug_only.setdefault('__release__', set()).add(m.group(1))
release_names = debug_only.pop('__release__', set())
for name in [n for n in debug_only if n not in release_names]:
    for path in swift_files:
        text = open(path, encoding='utf8').read()
        spans = debug_regions(text)
        for m in re.finditer(r'(?:\bSelf|\b[A-Z]\w*)\.' + re.escape(name) + r'\b', blank_comments(text)):
            if not any(a <= m.start() < b for a, b in spans):
                outside_uses.append('%s:%d %s' % (path, text.count('\n', 0, m.start()) + 1, m.group(0)))
wv_text = open(os.path.join('Foxy', 'FoxyWebView.swift'), encoding='utf8').read()
wv_decl = re.search(r'static let noWebRTC\b', wv_text)
if outside_uses:
    fail('used outside #if DEBUG but defined only inside it (a Release build will not compile): ' + ', '.join(outside_uses))
elif not wv_decl or any(a <= wv_decl.start() < b for a, b in debug_regions(wv_text)):
    fail('the WebRTC blocker (noWebRTC) is missing or Debug-only: Release builds would leak the IP through WebRTC')
else:
    ok('nothing Debug-only is used outside #if DEBUG; the WebRTC blocker is in every build')

# ---- 23. Tor control commands claim only their own replies --------------------
# Tor.framework offers each control reply to the newest command first, and its
# helpers take replies that are not theirs: setConfForKey claims any 250,
# getInfoForKeys drops out on a mismatch, getCircuits blocks the control queue
# for a second per call. After a reconnect through obfs4 the SOCKS port read
# lost its reply and waited for good. TorService sends every command through
# control(), which recognises its own reply and has a deadline.
tor_src = open(os.path.join('Foxy', 'Tor', 'TorService.swift'), encoding='utf8').read()
tor_code = '\n'.join(l for l in tor_src.splitlines() if not l.lstrip().startswith(('//', '*', '/*')))
stealers = re.findall(r'\.(getInfoForKeys|setConfForKey|setConfs|getCircuits)\s*[({]', tor_code)
raw_sends = [m.start() for m in re.finditer(r'\.sendCommand\(', tor_code)]
if stealers:
    fail('TorService calls Tor.framework helpers that take other commands\' replies: ' + ', '.join(sorted(set(stealers))) + ' — use control(), setConf() or getInfo()')
elif len(raw_sends) != 1 or 'private static func control(' not in tor_src:
    fail('TorService sends control commands outside control() (%d sendCommand calls)' % len(raw_sends))
elif 'static func setUp(' not in tor_src or 'forCircuitEstablished' not in tor_src or 'verifyCircuit' in tor_src:
    fail("a set-up no longer waits on Tor's own circuit announcement, after its network was off")
else:
    ok("Tor control commands claim only their own replies; a set-up waits on Tor's own circuit announcement")

# ---- 24. the seed is behind Face ID or the passcode, and never reaches the page
# Tor runs in the wallet's process. Code that got in through a Tor bug could read
# a keychain item Foxy may read, silently; the seed's item needs the person for
# every read (.userPresence), and a Face ID unlock of Foxy covers the read after
# it. Until stage 4 the page read the words once per page load (seedRead); now no
# action hands them over, and every seed write goes through SeedVault off the
# main queue.
store = open(os.path.join('Foxy', 'Keychain', 'SeedStore.swift'), encoding='utf8').read()
bridge = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge.swift'), encoding='utf8').read()
host = open(os.path.join('Foxy', 'FoxyWebView.swift'), encoding='utf8').read()

def bridge_handler(src, action):
    """The body of the function FoxyBridge's action table runs for `action`, or
    None. The bridge was once one switch (audit A6); each action is
    now a function, named in FoxyBridge.handlers."""
    named = re.search(r'\n\s*"' + re.escape(action) + r'": FoxyBridge\.(\w+),', src)
    if not named:
        return None
    fn = re.search(r'func ' + named.group(1) + r'\(id: String, body: \[String: Any\]\) \{(.*?)\n    \}\n', src, re.S)
    return fn.group(1) if fn else None

native24 = open(os.path.join('Foxy', 'Bridge', 'NativeSeedBridge.swift'), encoding='utf8').read()
problems24 = []
if '.userPresence' not in store or 'kSecAttrAccessControl' not in store:
    problems24.append('the seed item no longer needs Face ID or the passcode (.userPresence)')
for action24 in ('seedRead', 'seedWrite', 'seedDelete'):
    if re.search(r'\n\s*"' + action24 + r'": ', bridge) or \
            re.search(r'func handle' + action24[0].upper() + action24[1:] + r'\(', bridge + native24):
        problems24.append(action24 + ' is back in the bridge: the words would cross it')
if re.search(r'func readForPage\(|handedToPage', store):
    problems24.append('SeedVault can hand the words to the page again')
actions24 = open(os.path.join('Foxy', 'Keychain', 'SeedActions.swift'), encoding='utf8').read()

def action_body(src, name):
    """The body of `static func name(` in SeedActions.swift, or ''. Since the
    review each seed and counter action's work after its input check
    is there, run by its bridge handler on seedQueue with SeedEnvironment.live,
    so tests can run it with a stub vault."""
    m = re.search(r'\n    static func ' + re.escape(name) + r'\((.*?)\n    \}\n', src, re.S)
    return m.group(1) if m else ''

live24 = re.search(r'static let live = SeedEnvironment\((.*?)defaults: \.standard[,)]', actions24, re.S)
live24 = live24.group(1) if live24 else ''
if 'SeedVault.write(words, replace: replace, keepCandidate: keep, confirmReplace: confirm)' not in live24 \
        or 'savedSeed: { SeedVault.seedForSecrets() }' not in live24 or 'delete: { SeedVault.delete() }' not in live24:
    problems24.append("the seed actions' live environment does not read, write and delete through SeedVault")
# with no passcode, go ahead on the alert and warn
if 'passcodeSet: { SeedVault.passcodeSet })' not in actions24:
    problems24.append("the seed actions' live environment no longer tells the page when the phone has no passcode")
for action24, fn24, writes24 in (('seedCreate', 'create', 'env.write(words, false, nil'),
                                 ('seedMigrate', 'migrate', 'env.write(words, false, nil'),
                                 ('seedAdopt', 'adopt', 'env.write(words, true, candidate')):
    body24 = bridge_handler(bridge + native24, action24) or ''
    if 'SeedActions.' + fn24 + '(' not in body24 or '.live' not in body24 or 'seedQueue.async' not in body24 \
            or writes24 not in action_body(actions24, fn24):
        problems24.append(action24 + ' does not write through SeedVault off the main queue')
# review L2: an unlock covers the one read after it, never the words screen, and goes on background
screen24 = re.search(r'static func wordsForScreen\(\) -> Answer \{(.*?)\n    \}', store, re.S)
take24 = re.search(r'static func takeUnlock\(forScreen: Bool, now: Date = Date\(\)\) -> LAContext\? \{(.*?)\n    \}', store, re.S)
covers24 = re.search(r'static func unlockCovers\(notedAt: Date, now: Date, forScreen: Bool\) -> Bool \{(.*?)\n    \}', store, re.S)
context24 = re.search(r'private static func context\((.*?)\n    \}', store, re.S)
forget24 = re.search(r'static func forgetNativeSeed\(keepingCandidate kept: String\?\) \{(.*?)\n    \}', store, re.S)
if not screen24 or 'forScreen: true' not in screen24.group(1):
    problems24.append('the words screen can read through an earlier Face ID unlock')
if not take24 or not (0 <= take24.group(1).find('unlock = nil') < take24.group(1).find('guard ')):
    problems24.append('a Face ID unlock covers more than the one read after it')
if not covers24 or '!forScreen' not in covers24.group(1) or 'unlockSeconds' not in covers24.group(1):
    problems24.append("the unlock's rule no longer refuses the words screen or a stale unlock")
if not context24 or 'takeUnlock(forScreen: forScreen)' not in context24.group(1) or 'u.context' in context24.group(1):
    problems24.append('a keychain read takes the unlock other than through takeUnlock')
if not forget24 or 'unlock = nil' not in forget24.group(1):
    problems24.append('the unlock outlives the background, the page and a seed write')
if 'SeedVault.noteUnlock(ctx)' not in bridge:
    problems24.append('a Face ID unlock no longer covers the seed read after it')
if re.search(r'SeedStore\.(read|load)\(key: SeedStore\.mnemonicKey\)', bridge):
    problems24.append('FoxyBridge reads the seed around SeedVault')
if 'SeedVault.pageWillLoad()' not in host.split('func loadStaged', 1)[-1][:600]:
    problems24.append('loading the page no longer resets the once-a-page seed read')
if problems24:
    fail('seed protection: ' + '; '.join(problems24))
else:
    ok('the seed needs Face ID or the passcode, no action hands the words to the page, seed writes go through SeedVault, and an unlock covers one read and never the words screen')

# ---- 25. a host Foxy has not used needs an Allow that iOS draws ---------------
# A script in the page could send what the page holds, the seed included, to an
# address of its own through mintRequest. The first request to a host that is not
# approved shows an iOS alert; approvals live in the keychain, not UserDefaults,
# and the carry-over of hosts a wallet already used happens once.
bridge25 = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge.swift'), encoding='utf8').read()
route25 = open(os.path.join('Foxy', 'Network', 'Route.swift'), encoding='utf8').read()
mint_case = bridge_handler(bridge25, 'mintRequest')
prompts25 = open(os.path.join('Foxy', 'Bridge', 'NativePrompts.swift'), encoding='utf8').read() \
    if os.path.exists(os.path.join('Foxy', 'Bridge', 'NativePrompts.swift')) else ''
approvals25 = route25.split('enum HostApprovals', 1)[-1] if 'enum HostApprovals' in route25 else ''
problems25 = []
if not mint_case or bridge_handler(bridge25, 'hostsKnown') is None:
    problems25.append('the mintRequest or hostsKnown handler is missing')
else:
    body = mint_case
    if 'HostApprovals.isApproved(host)' not in body or 'HostApprovals.ask(' not in body:
        problems25.append('mintRequest no longer asks before a host it has not used')
    elif 'sendMintRequest(' in body and body.index('HostApprovals.isApproved(host)') > body.index('sendMintRequest('):
        problems25.append('mintRequest sends before checking the host')
    if 'Route.start(' in body:
        problems25.append('mintRequest starts a request outside sendMintRequest')
# the Allow alert is drawn by iOS: HostApprovals asks through NativePrompts, which presents a UIAlertController
if not approvals25 or 'NativePrompts.ask(' not in approvals25.split('private static func next(', 1)[-1] \
        or not re.search(r'static func alert\(.*?UIAlertController\(', prompts25, re.S):
    problems25.append('HostApprovals or its iOS alert is gone')
if 'UserDefaults' in route25.split('enum HostApprovals', 1)[-1]:
    problems25.append('approved hosts are kept in UserDefaults, which goes into backups')
if 'carriedKey) == nil' not in route25 and 'guard case .absent = SeedStore.read(key: carriedKey)' not in route25:
    problems25.append('the carry-over of known hosts is no longer once only')
if problems25:
    fail('host approvals: ' + '; '.join(problems25))
else:
    ok('a host Foxy has not used needs an Allow in an iOS alert; approvals in the keychain')

# ---- 26. Tor is off the network while Foxy is in the background ---------------
# iOS breaks a suspended app's sockets. Tor woke with them broken and connected to
# its guards again, and the return's reconnect closed those attempts; Tor counts
# each as that guard failing, and a failed primary guard waits ten minutes. So a
# return sat at 44% while a fresh launch connected at once. Tor's network goes off
# as Foxy leaves, under a background task, and every return sets it up again.
host26 = open(os.path.join('Foxy', 'FoxyWebView.swift'), encoding='utf8').read()
leaving = re.search(r'func appEnteredBackground\(\)(.*?)\n    }\n', host26, re.S)
parking = re.search(r'static func backgrounded\((.*?)\n    }\n', tor_src, re.S)
returning = re.search(r'static func resumed\(away: TimeInterval\)(.*?)\n    }\n', tor_src, re.S)
problems26 = []
if not leaving or 'torBackgrounded' not in leaving.group(1) or 'beginBackgroundTask' not in leaving.group(1):
    problems26.append('going to the background no longer takes Tor off the network under a background task')
if not parking or '"DisableNetwork=1"' not in parking.group(1):
    problems26.append("TorService.backgrounded no longer switches Tor's network off")
if not returning or 'setUp(' not in returning.group(1):
    problems26.append('a return no longer sets up a private connection')
if problems26:
    fail('Tor in the background: ' + '; '.join(problems26))
else:
    ok('Tor is off the network while Foxy is in the background; every return sets up a private connection')

# ---- 27. the screen lock's Face ID contract, across the bridge ---------------
#
# The rule this check is held to, so that the next person does not put it back
# the way it was: where a thing can be tested by RUNNING it, it is tested by
# running it, in tests/screen-lock.js, and smoke.py does not also assert the
# source text that implements it. What belongs here is what no jsdom test can
# see — agreement between two files that cannot import each other (a Swift
# constant and a JS string), invariants about the shipped generated files, and
# guards with no runtime surface.
#
# So these are now in tests/screen-lock.js, which mounts the real pinLock in
# jsdom and asserts what it DOES, and they are deliberately not here:
#   - the lock stands on screenLocked (a PIN or a face), not on a PIN alone —
#     pinLock used to open with `if (!W.pinIsSet()) return`, so a phone with
#     Face ID on and no PIN had no lock at all;
#   - the overlay is drawn at z-index 2147483647, above the seed and verify
#     screens (2147483550), the delete prompts (2147483600) and the Tor gate;
#   - everything marked data-foxy-close-on-lock is closed, and closed even
#     when the lock is already up — the twelve words, or DELETE, used to show
#     over FOXY IS LOCKED after a trip to the background;
#   - the BACKUP sheet and both delete prompts are among what closes;
#   - a face standing alone is asked for with the phone's passcode allowed, an
#     "unavailable" answer opens the wallet rather than stranding the money,
#     and no dead keypad is drawn when there is no PIN to type.
# Add a behaviour there, not a string match here.
#
# What stays is the other half of that last one, which is in Swift. The page
# asks for a face with `passcode: true|false` in the biometric message;
# FoxyBridge turns that into an LAPolicy. The two files cannot import each
# other, so a renamed key or a flipped mapping would leave the page asking as
# before while the lock over the whole wallet quietly became biometrics-only —
# and then a face that will not scan means the money cannot be reached at all.
wallet27 = open(os.path.join('Web', 'foxy-wallet.js'), encoding='utf8').read()
bridge27 = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge.swift'), encoding='utf8').read()
ask27 = re.search(r'biometric: function \(reason, passcode\) \{(.*?)\n    \},', wallet27, re.S)
hand27 = re.search(r'private func handleBiometric\(id: String, body: \[String: Any\]\) \{(.*?)\n    \}\n',
                   bridge27, re.S)
problems27 = []
if not ask27 or "action: 'biometric'" not in ask27.group(1) or 'passcode: !!passcode' not in ask27.group(1):
    problems27.append('the page no longer says, in the biometric message, whether the phone passcode may stand in')
if not hand27:
    problems27.append('FoxyBridge no longer handles biometric')
else:
    body27 = hand27.group(1)
    if 'body["passcode"] as? Bool' not in body27:
        problems27.append('the native side no longer reads the passcode the page asks for: '
                          'the two sides of one message have drifted apart')
    if 'passcode ? .deviceOwnerAuthentication\n' not in body27 \
            or ': .deviceOwnerAuthenticationWithBiometrics' not in body27:
        problems27.append('passcode true is no longer LAPolicy .deviceOwnerAuthentication and false '
                          '.deviceOwnerAuthenticationWithBiometrics, so a face that will not scan '
                          'can lock the wallet for good')
    if 'text: "unavailable"' not in body27:
        problems27.append('a phone that can check neither face nor passcode is no longer answered '
                          '"unavailable", which is the answer the lock opens on')
if problems27:
    fail('PIN lock: ' + '; '.join(problems27))
else:
    ok('the page asks for a face with the phone passcode allowed or not, and FoxyBridge maps that to '
       'the matching LAPolicy; what the lock does is tests/screen-lock.js')

# ---- 28. a reinstall removes the seed behind Face ID too ----------------------
# Keychain items outlive the app. Once the seed moved to foxy.seed.v2, a reinstall
# that deleted only foxy.seed.v1 offered the previous installation's words.
host28 = open(os.path.join('Foxy', 'FoxyWebView.swift'), encoding='utf8').read()
forget28 = re.search(r'static func forgetSeedIfReinstalled\(\)(.*?)\n    }\n', host28, re.S)
problems28 = []
if not forget28:
    problems28.append('forgetSeedIfReinstalled is gone')
else:
    body28 = forget28.group(1)
    for key in ('SeedStore.protectedKey', 'SeedStore.mnemonicKey', 'HostApprovals.storeKey', 'HostApprovals.carriedKey', 'OrbotLink.tokenKey'):
        if key not in body28:
            problems28.append('a reinstall no longer deletes ' + key)
    if 'SeedStore.has(key: SeedStore.protectedKey)' in body28 or 'SeedStore.load(key: SeedStore.protectedKey)' in body28:
        problems28.append('the reinstall check reads the Face ID item, which asks for Face ID')
if problems28:
    fail('reinstall: ' + '; '.join(problems28))
else:
    ok('a reinstall deletes both seed items, the approved hosts and the Orbot key, reading nothing')

# ---- 29. the seed changes only with a yes iOS draws; proofs and literals ------
# A page script could delete the seed with no approval and write one it knew, or
# replace it inside the 30 seconds a Face ID unlock covers, with prompt text it
# wrote itself. Mints could leave signature proofs out, and 0x7f.1 passed the
# host check as a name.
bridge29 = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge.swift'), encoding='utf8').read()
store29 = open(os.path.join('Foxy', 'Keychain', 'SeedStore.swift'), encoding='utf8').read()
route29 = open(os.path.join('Foxy', 'Network', 'Route.swift'), encoding='utf8').read()
wallet29 = open(os.path.join('Web', 'foxy-wallet.js'), encoding='utf8').read()
native29 = open(os.path.join('Foxy', 'Bridge', 'NativeSeedBridge.swift'), encoding='utf8').read()
# since stage 4 the seed is deleted by seedWipe and replaced by seedAdopt
delete29 = bridge_handler(bridge29 + native29, 'seedWipe')
write29 = bridge_handler(bridge29 + native29, 'seedAdopt') or ''
wait29 = re.search(r'(?:private )?func confirmSeedChangeAndWait\((.*?)\n    \}\n', bridge29, re.S)
problems29 = []
if not delete29 or 'confirmSeedChange(' not in delete29:
    problems29.append('deleting the seed no longer needs a yes in an iOS alert')
# seedAdopt's thread waits for the same alert, through confirmSeedChangeAndWait
if 'confirmReplace()' not in store29 or not (
        'confirmSeedChange(' in write29
        or ('confirmSeedChangeAndWait(' in write29 and wait29 and 'confirmSeedChange(' in wait29.group(1))):
    problems29.append('replacing a different saved seed no longer needs a yes in an iOS alert')
if not re.search(r'NativePrompts\.ask\(', re.split(r'(?:private )?func confirmSeedChange\(', bridge29, maxsplit=1)[-1].split('\n    }\n', 1)[0]):
    problems29.append('the seed alerts no longer wait in the one queue of native alerts (audit finding I3)')
if 'body["reason"] as? String ?? "Unlock Foxy"' in bridge29:
    problems29.append('the page writes the Face ID prompt again')
if wallet29.count('requireSigDleq: true') < 2:
    problems29.append('seeded wallets no longer require signature proofs (DLEQ) from NUT-12 mints')
if 'inet_aton(' not in route29:
    problems29.append('an IPv4 literal in a short or hex form passes the host check again')
if 'agree: agree' not in bridge29 or 'W.agreedRate' not in open(os.path.join('build', 'app', '03-send.js'), encoding='utf8').read():
    problems29.append('a payment typed in dollars no longer needs a price two sources agree on')
# seedMigrate moves words the page still holds only where no seed is saved:
# never with replace, never asking, and never a write where a seed was found
migrate29 = bridge_handler(bridge29 + native29, 'seedMigrate') or ''
actions29 = open(os.path.join('Foxy', 'Keychain', 'SeedActions.swift'), encoding='utf8').read()
window29 = open(os.path.join('Foxy', 'Keychain', 'SeedMigrationWindow.swift'), encoding='utf8').read()
run29 = action_body(actions29, 'migrate')
decide29 = action_body(actions29, 'decideMigration')
if 'SeedActions.migrate(phrase, env: .live)' not in migrate29 or 'replace: true' in migrate29 + run29 + decide29 \
        or 'confirmSeedChange' in migrate29 or 'beginSeedChange(id: id)' not in migrate29 \
        or 'env.write(words, false, nil, { false })' not in run29:
    problems29.append('seedMigrate could replace a saved seed, or ask to')
# the words are checked first, with the window open or closed (review M4)
if not (0 <= migrate29.find('Self.seedMigrateCheck(') < migrate29.find('beginSeedChange(id: id)')):
    problems29.append('seedMigrate no longer checks the words before anything else')
# ...and written only in its one-time window, where no seed is saved; closed, a
# saved seed is still compared, and only no seed at all is "no migration here"
step29 = re.search(r'static func step\(open: Bool, saved: Saved\) -> Step \{(.*?)\n    \}', window29, re.S)
if not step29 or 'case .absent: return open ? .write : .answer(.refused(noMigration))' not in step29.group(1) \
        or step29.group(1).count('.write') != 1 \
        or 'case .found(let same): return .answer(same ? .same : .different)' not in step29.group(1) \
        or 'static let noMigration = "no migration here"' not in window29:
    problems29.append('seedMigrate writes where a seed was already found, or outside its one-time window')
if 'SeedMigrationWindow.step(open: windowOpen' not in decide29 or 'write(' in decide29.split('case .write:', 1)[0] \
        or 'windowOpen: env.migrationWindowOpen()' not in run29 or 'migrationWindowOpen: { SeedMigrationWindow.isOpen }' not in actions29:
    problems29.append('seedMigrate writes other than where the window step allows')
# closed by an answer about the words, never by an error; and by a seed made on the phone
closes29 = re.search(r'static func closes\(after outcome: Outcome\) -> Bool \{(.*?)\n    \}', window29, re.S)
if not closes29 or 'case .migrated, .same, .different: return true' not in closes29.group(1) \
        or 'case .refused: return false' not in closes29.group(1) or 'SeedMigrationWindow.closes(after: outcome)' not in run29:
    problems29.append('the seedMigrate window closes on an error, or not on an answer')
create29 = action_body(actions29, 'create')
host29 = open(os.path.join('Foxy', 'FoxyWebView.swift'), encoding='utf8').read()
if 'env.closeMigrationWindow(' not in create29 or 'closeMigrationWindow: { SeedMigrationWindow.close($0) }' not in actions29:
    problems29.append('making a seed no longer closes the seedMigrate window')
# review M8: after the Replace alert's yes, Face ID or the passcode; its warning names the lure
if not (0 <= write29.find('confirmSeedChangeAndWait(') < write29.find('SeedVault.deviceOwnerApproves(')):
    problems29.append('replacing the seed no longer asks for Face ID or the passcode after the yes')
owner29 = re.search(r'static func deviceOwnerApproves\(reason: String\) -> Bool \{(.*?)\n    \}\n', store29, re.S)
if not owner29 or 'evaluatePolicy(.deviceOwnerAuthentication' not in owner29.group(1) or 'timedOut' not in owner29.group(1):
    problems29.append('deviceOwnerApproves does not ask iOS for Face ID or the passcode, with a time limit')
if 'static let replaceSeedMessage = "Only replace it with words you wrote down yourself. Whoever gave you these words can take everything this wallet receives."' not in bridge29:
    problems29.append('the Replace alert no longer warns that whoever gave the words can take what the wallet receives')
adopt29 = action_body(actions29, 'adopt')
if 'declined = !yes' not in adopt29 or 'if declined { return .refuse("Nothing was changed.") }' not in adopt29:
    problems29.append('a cancelled Replace, Face ID or passcode no longer answers "Nothing was changed."')
if 'SeedMigrationWindow.noteLaunch()' not in host29.split('private func load()', 1)[-1][:400]:
    problems29.append('the seedMigrate window is not decided before the page first loads')
if problems29:
    fail('seed, proofs and literals: ' + '; '.join(problems29))
else:
    ok('the seed is deleted or replaced only with a yes in an iOS alert, a replace with Face ID or the passcode too; seedMigrate writes only in its window and compares after; DLEQ required; no IPv4 literal passes')

# ---- 30. a first connection that stops receiving data is started again -------
# On a new install Tor downloads the whole relay directory, and a download from
# a slow relay hung: on a phone the launch screen sat at 30% for more than 30
# seconds, while killing and reopening the app got it moving. Foxy now nudges
# Tor after five seconds in which it read nothing, once data had arrived, on
# direct Tor only (Tor does not count bytes to 127.0.0.1: a bridge or Orbot).
tor30 = open(os.path.join('Foxy', 'Tor', 'TorService.swift'), encoding='utf8').read()
tick30 = re.search(r'private static func stallTick\(\)(.*?)\n    }\n', tor30, re.S)
control30 = tor30.split('private static func connectControl()', 1)[-1].split('private static func readControlPort', 1)[0]
problems30 = []
if 'static let stallAfter: TimeInterval = 5' not in tor30:
    problems30.append('the stall watch no longer waits 5 seconds without data')
nudge30 = tor30.split('private static func nudge()', 1)[-1].split('private static func stallReset', 1)[0]
if nudge30.count('guard gen == setUpGen, !parked') < 2:
    problems30.append('a nudge in flight can switch a parked Tor back on (audit finding T3)')
if 'watchForStall()' not in control30:
    problems30.append('the stall watch is never started')
if not tick30:
    problems30.append('stallTick is gone')
else:
    body30 = tick30.group(1)
    for needle, why in (('"traffic/read"', "it no longer reads Tor's byte count"),
                        ('nudge()', 'it no longer nudges Tor'),
                        ('transport == .direct', 'it watches bridges too, whose bytes Tor does not count'),
                        ('orbotBypass == nil', "it watches Tor past Orbot, whose bytes Tor does not count"),
                        ('!everUp', 'it acts after a circuit is up, not only while connecting'),
                        ('stallSawData', 'it can nudge before any data arrived, restarting a slow first handshake')):
        if needle not in body30:
            problems30.append(why)
if problems30:
    fail('first-connection stall: ' + '; '.join(problems30))
else:
    ok("a direct connection not yet up that reads nothing for 5 seconds after data arrived is nudged, and never while parked")

# ---- 30b. control authentication cannot hang for good ------------------------
# On a phone the reply to AUTHENTICATE never reached its callback. `authenticating`
# was cleared only there, and connectControl, setUp, RETRY and the deadline all
# check it first, so Foxy sat on CONNECTING TO TOR until it was killed, logging
# nothing. Authentication now has a deadline: the link is dropped and another
# connected, three at most, then CANNOT CONNECT with its RETRY. A reply from a
# link given up on is ignored, or a dead link could become the controller.
auth30b = tor30.split('private static func connectControl()', 1)[-1].split('private static func readControlPort', 1)[0]
timeout30b = auth30b.split('private static func authenticationTimedOut', 1)[-1]
problems30b = []
if not re.search(r'static let authenticationPatience: TimeInterval = \d+', tor30):
    problems30b.append('there is no authentication deadline')
if 'authenticationTimedOut(gen, ctrl)' not in auth30b:
    problems30b.append('connectControl no longer arms the deadline for each link')
if auth30b.count('guard gen == authGen else { return }') < 2:
    problems30b.append('a late answer from a link given up on can still become the controller')
for needle, why in (('authGen += 1', 'the link given up on is not retired'),
                    ('authenticating = false', 'a timed-out link leaves authenticating set, which blocks every way back'),
                    ('closeLink(ctrl)', 'the link given up on is left connected'),
                    ('fail()', 'it retries for ever instead of showing CANNOT CONNECT')):
    if needle not in timeout30b:
        problems30b.append(why)
if problems30b:
    fail('control authentication: ' + '; '.join(problems30b))
else:
    ok('control authentication has a deadline: an unanswered link is dropped and another tried, three at most, then CANNOT CONNECT; a late reply is ignored')

# ---- 30c. RESTART TOR: nobody has to kill Foxy to get Tor moving -------------
# The connecting screen had no button, and RETRY came only after every transport
# had timed out. RETRY ran start(), which with a controller re-ran the set-up on
# that same link and with an authentication hanging did nothing. Now the
# connecting screen offers RESTART TOR once its percentage stands still, and it
# and RETRY both drop the link, any authentication in flight, and set up again
# on a new link. A Tor thread that has exited is reported as `stopped`, and the
# page says to reopen Foxy instead of offering a button that cannot work.
# -FoxyTorStall auth reproduces the hang on a phone, and must never ship.
bridge30c = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge.swift'), encoding='utf8').read()
gate30c = open(os.path.join('Web', 'foxy-tor-gate.js'), encoding='utf8').read()
retry30c = bridge30c.split('func handleTorRetry', 1)[-1].split('\n    }\n', 1)[0]
restart30c = tor30.split('static func restart(', 1)[-1].split('\n    }\n', 1)[0]
problems30c = []
if 'TorService.restart(' not in retry30c:
    problems30c.append('RETRY and RESTART TOR no longer run TorService.restart')
for needle, why in (('if stopped', 'a Tor thread that has exited is not told apart'),
                    ('closeLink(old)', 'the old control link is kept, and a link that answers nothing looks alive'),
                    ('authenticating = false', 'an authentication in flight still blocks the restart'),
                    ('authGen += 1', "the given-up authentication's late reply could become the controller"),
                    ('setUpPending = true', 'the new link is not set up once it authenticates'),
                    ('connectControl()', 'no new control link is connected')):
    if needle not in restart30c:
        problems30c.append('restart: ' + why)
if '"stopped"' not in tor30:
    problems30c.append('TorService.state never says "stopped"')
if "p.tor === 'stuck'" not in gate30c or "'RESTART TOR'" not in gate30c:
    problems30c.append("the connecting screen no longer offers RESTART TOR on the native side's stuck")
if re.search(r'restartAfterMs|lastMove', gate30c):
    problems30c.append('the page decides stuck from its own timer again: a percentage stands still on a slow network while Tor downloads')
transport30c = open(os.path.join('Foxy', 'Tor', 'TorTransport.swift'), encoding='utf8').read()
for needle, why in (('static let wedgedAfter: TimeInterval = 10', 'no control link is not offered after 10 seconds'),
                    ('static let silentAfter: TimeInterval = 30', 'a silent link is not offered after 30 seconds'),
                    ('if !hasLink', 'a wedged link and a slow one are no longer told apart'),
                    ('static let silentAfterSnowflake: TimeInterval = 120', 'Snowflake is offered RESTART TOR before two minutes of silence: a working one went 70s without an event')):
    if needle not in transport30c:
        problems30c.append('TorStuck: ' + why)
for needle, why in (('noteLife()                        // bytes from relays', 'bytes arriving no longer count as progress, so a slow download looks stuck'),
                    ('noteLife()                        // an event, even at the same percentage', "Tor's events no longer count as progress"),
                    ('keepClock = true', 'a restart starts the fallback clock again, so taps can hold Foxy on one transport'),
                    ('snowflake: transport == .snowflake', 'TorService no longer tells TorStuck the transport is Snowflake'),
                    ('if clockKeptFor != gen { armDeadline() }', "the set-up a restart asks for resets the fallback clock")):
    if needle not in tor30:
        problems30c.append(why)
if 'firstSetup' not in tor30 or 'cached-microdesc-consensus' not in tor30:
    problems30c.append('TorService no longer tells a first setup from a saved relay list')
# 30d. The wallet decides whether a failed claim spends one of CLAIM_TRIES_MAX
# by recognising the refusals that mean nothing was ever sent. One of them is
# the native side's, so the two copies of that sentence have to stay identical:
# drift and a never-sent claim silently starts costing a try again, which is
# how ten badly-timed wakes file a paid invoice as given up.
route30d = open(os.path.join('Foxy', 'Network', 'Route.swift'), encoding='utf8').read()
said30d = re.search(r'static let refusal = "([^"]+)"', route30d)
if not said30d:
    problems30c.append('Route.refusal is no longer a plain string the wallet can be held to')
elif ("'" + said30d.group(1) + "',") not in wallet29:
    problems30c.append('Route.refusal and the wallet\'s NEVER_SENT list have drifted apart')
# 30e. The Nostr transport a payment request also names, and the two things
# about it that are not negotiable: the key is made per request and never comes
# from the seed, and Nostr is listed BEFORE the onion. cashu.me pays the first
# transport it recognises, so the order is what decides whether a browser
# wallet reaches something or swaps the ecash and then finds it cannot deliver
# (tools/live/production.md).
inbox30e = open(os.path.join('Foxy', 'Nostr', 'NostrInbox.swift'), encoding='utf8').read()
if 'NostrCrypto.newKey()' not in inbox30e:
    problems30c.append('the Nostr inbox no longer makes its own key')
for bad30e in ('seedBytes', 'SeedStore', 'bridgeSeed', 'mnemonic'):
    if bad30e in inbox30e:
        problems30c.append('the Nostr inbox reaches for the seed (%s); its key must be per request' % bad30e)
nostr30e = wallet29.find("type: CT.PaymentRequestTransportType.NOSTR")
post30e = wallet29.find("type: CT.PaymentRequestTransportType.POST")
if nostr30e < 0 or post30e < 0:
    problems30c.append('a payment request no longer offers both a Nostr key and an onion')
elif nostr30e > post30e:
    problems30c.append('a payment request offers the onion before Nostr, which loses a browser wallet its money')
if 'static func nprofile(pubkey:' not in open(os.path.join('Foxy', 'Nostr', 'NostrEvent.swift'), encoding='utf8').read():
    problems30c.append('nothing writes the nprofile a request names')

for needle30d, why30d in (
        ('var NEVER_SENT = [', 'the wallet no longer lists the refusals that sent nothing'),
        ('function neverSent(e)', 'nothing decides whether a failed claim asked the mint anything'),
        ('var free = neverSent(e);', 'every failed claim spends one of CLAIM_TRIES_MAX again'),
        ("e.noCounters = true;", 'a claim with no circuit no longer says it reserved nothing')):
    if needle30d not in wallet29:
        problems30c.append(why30d)
# The launch screen's number is a pace, not a measurement:
# 0 to 99 over paceMs on every arrival, waiting there until the launch is
# genuinely through, and only then 100. What is checked is that pacing, and
# that nothing can show 100 before finish() says so.
# The top is 90 while the launch is still working and 100 when everything was
# already through before the fox had finished — the launch that used to seal
# and fade under the intro, unseen.
#
# `ending`, not `torDone`, is what lifts the top to 100: torDone was set on one
# launch and never cleared, so every later gate counted to 100 and finished
# itself with Tor still connecting — the person landed on a home screen with no
# connection, and the next thing Tor said raised the gate again. It is now read once, and only while Tor is genuinely through.
# The quick part stops at 80 rather than 90 when a tunnel is up: Orbot takes
# minutes where a direct connect takes seconds, so more of the bar is left for
# the part that creeps, and a number still arriving reads as working where one
# parked at 90 reads as stuck.
if not re.search(r'paceMs:\s*2000', gate30c) or not re.search(r'waitMs:\s*1000', gate30c) \
        or "ending ? 100 : ((pv && pv.vpn) ? 80 : 90)" not in gate30c \
        or 'paced >= top' not in gate30c or 'paced >= 99' not in gate30c:
    problems30c.append('the launch number no longer paces 0 to 90 (80 on a tunnel) '
                       'and then a point a second to 99')
if 'var ending = torDone && through(state());' not in gate30c \
        or 'if (torDone && !ending) torDone = false;' not in gate30c \
        or 'if (ending) { torDone = false;' not in gate30c:
    problems30c.append('torDone can go on finishing the gate after the launch that set it')
if not re.search(r'function finish\(\) \{\s*\n\s*if \(sealing\) return;\s*\n(?:.*\n)*?\s*if \(!through\(state\(\)\)\) \{', gate30c):
    problems30c.append('finish() will seal the gate while Tor is still connecting')
# and a finish that lands while the intro is up is kept rather than spent there
if 'if (intro) { torDone = true; return; }' not in gate30c:
    problems30c.append('a launch that is through before the fox has gone seals the screen under him again')
if 'paced = 100;' not in gate30c or gate30c.count('paced = 100;') != 1:
    problems30c.append('100% is reached somewhere other than the end of the launch')
if "'TOR STOPPED'" not in gate30c:
    problems30c.append('a stopped Tor has no screen')
spans30c = debug_regions(tor30)
stray30c = [tor30.count('\n', 0, m.start()) + 1 for m in re.finditer(r'stallAuthUntilRestart', tor30)
            if not any(a <= m.start() < b for a, b in spans30c)]
if stray30c:
    problems30c.append('-FoxyTorStall is outside #if DEBUG at TorService.swift:' + ','.join(map(str, stray30c)))
if problems30c:
    fail('RESTART TOR: ' + '; '.join(problems30c))
else:
    ok('RESTART TOR shows only when stuck - no control link for 10s, or nothing arriving for 30s (60s uncounted, 120s on Snowflake) - never while data arrives; it and RETRY set up on a new link and keep the fallback clock; a stopped Tor says reopen Foxy; -FoxyTorStall is Debug-only')

# ---- 30d. closing a control link never stops Tor -----------------------------
# TorController.disconnect() sends SIGNAL SHUTDOWN (TORController.m). Tor runs
# once per app, so a disconnect is TOR STOPPED until Foxy is reopened. On a
# phone the authentication deadline and RESTART TOR both called it, and
# the set-up's reconnect had since it was written. A link is closed with QUIT
# (TorService.closeLink); nothing in the app may call disconnect().
disconnects30d = []
for path30d in swift_files:
    code30d = blank_comments(open(path30d, encoding='utf8').read())
    for m30d in re.finditer(r'\.disconnect\(\)', code30d):
        disconnects30d.append('%s:%d' % (path30d, code30d.count('\n', 0, m30d.start()) + 1))
if disconnects30d:
    fail('a control link is closed with disconnect(), which sends Tor SIGNAL SHUTDOWN and stops it for good: '
         + ', '.join(disconnects30d) + ' (use TorService.closeLink)')
elif 'private static func closeLink(' not in tor30 or '"QUIT"' not in tor30:
    fail('TorService.closeLink no longer closes a link with QUIT')
else:
    ok('no control link is closed with disconnect(), which would shut Tor down; links are closed with QUIT')

# ---- 30e. a control listener iOS reclaimed is opened again by Tor ------------
# iOS reclaims every socket of a suspended app, TCP, Unix and socket pairs alike,
# and only root may exempt one. After a 10-second return the control
# listener refused while Tor ran, and nothing in Foxy could reach Tor: every
# command goes through that listener. A SIGHUP reaches Tor's handler, which
# reloads the torrc named with -f and opens a ControlSocket at a new path; checked against Tor
# 0.4.9.12 on a Mac (two recoveries, the older socket closed each time). The
# handler is checked first, since an unhandled SIGHUP ends the app, and a stale
# torrc is removed at launch, before Tor would read it.
rec30e = tor30.split('private static func recoverControlListener()', 1)[-1].split('private static func recoveryTorrc', 1)[0]
launch30e = tor30.split('private static func launch()', 1)[-1].split('let t = TorThread(configuration: c)', 1)[0]
problems30e = []
for needle, why in (('guard sighupReachesTor()', 'SIGHUP is sent without checking a handler is installed, which would end Foxy'),
                    ('ControlSocket ', 'the torrc no longer names a control socket'),
                    ('controlSockets += 1', 'the socket path is reused, so a socket reclaimed again would match and not be replaced'),
                    ('0o700', 'the socket directory is not private, and Tor refuses one that is not'),
                    ('kill(getpid(), SIGHUP)', 'Tor is not asked to reload'),
                    ('setUpPending = true', 'the set-up does not run after the reload reset the network and transport'),
                    ('controlUnreachable = true', 'a failed recovery leaves RESTART TOR looping instead of saying to reopen Foxy')):
    if needle not in rec30e:
        problems30e.append(why)
if 'recoverControlListener()' not in tor30.split('private static func connectControl()', 1)[-1].split('private static func authenticationTimedOut', 1)[0]:
    problems30e.append('a refused control link does not start the recovery')
if 'removeItem(at: recoveryTorrc(dir))' not in launch30e:
    problems30e.append('a torrc left by a recovery would be read when Tor starts')
if 'c.arguments.add("-f")' not in launch30e:
    problems30e.append("Tor is not given a torrc path it can reload from; its default, ~/.torrc, is in the container root, which iOS does not let an app write")
if not re.search(r'static var stopped: Bool \{[^}]*controlUnreachable', tor30):
    problems30e.append('an unreachable Tor is not reported as stopped')
stray30e = [tor30.count('\n', 0, m.start()) + 1 for m in re.finditer(r'stallListenerOnce', tor30)
            if not any(a <= m.start() < b for a, b in spans30c)]
if stray30e:
    problems30e.append('-FoxyTorStall listener is outside #if DEBUG at TorService.swift:' + ','.join(map(str, stray30e)))
if problems30e:
    fail('control listener recovery: ' + '; '.join(problems30e))
else:
    ok('a refused control listener is reopened by Tor: SIGHUP, after checking a handler, with a torrc naming a new private control socket; the set-up runs again; a failure says reopen Foxy')

# ---- 31. NUT-13 secrets natively: libsecp256k1 as pinned, seedSecrets fenced ---
# The seedSecrets prototype derives the page's NUT-13 secrets in Swift. Its
# elliptic-curve step is libsecp256k1 from the signed v0.8.0 tag, committed as
# source: every file must be the one Vendor/secp256k1.sha256 lists, with nothing
# beside them, and Swift may call only what BIP-32 needs. The actions that derive
# (counterReserve, counterReserveAt, restoreSecrets) answer in every build since
# stage 4, with no switch; they read the seed through SeedVault off the main
# queue, never name the words, and the seed they keep goes with the page, the
# unlock and the foreground.
import hashlib
problems31 = []
secp31 = os.path.join('Vendor', 'secp256k1')
sum31 = os.path.join('Vendor', 'secp256k1.sha256')
if not os.path.isdir(secp31) or not os.path.exists(sum31):
    problems31.append('Vendor/secp256k1 or Vendor/secp256k1.sha256 is missing')
else:
    text31 = open(sum31, encoding='utf8').read()
    want31, lines31 = {}, []
    for line in text31.splitlines():
        parts = line.split()
        if len(parts) == 2 and not line.startswith('#'):
            want31[parts[1]] = parts[0]
            lines31.append(line + '\n')
    listing31 = re.search(r'^# listing: ([0-9a-f]{64})', text31, re.M)
    if not listing31 or hashlib.sha256(''.join(lines31).encode()).hexdigest() != listing31.group(1):
        problems31.append("Vendor/secp256k1.sha256's lines are not the listing its header records")
    if 'commit     6e2c8bc4ecdc6e71dbe7a368f360d8d453ce435d' not in text31:
        problems31.append('Vendor/secp256k1.sha256 no longer names the v0.8.0 commit')
    have31 = {}
    for d, _, names in os.walk(secp31):
        for n in names:
            if n != '.DS_Store':
                path31 = os.path.join(d, n)
                have31[os.path.relpath(path31, secp31)] = hashlib.sha256(open(path31, 'rb').read()).hexdigest()
    for rel, digest in sorted(want31.items()):
        if rel not in have31:
            problems31.append('Vendor/secp256k1/' + rel + ' is missing')
        elif have31[rel] != digest:
            problems31.append('Vendor/secp256k1/' + rel + ' differs from Vendor/secp256k1.sha256')
    for rel in sorted(set(have31) - set(want31)):
        problems31.append('Vendor/secp256k1/' + rel + ' is not listed in Vendor/secp256k1.sha256')
yml31 = open('project.yml', encoding='utf8').read()
if sorted(set(re.findall(r'path: (Vendor/secp256k1/\S+)', yml31))) != [
        'Vendor/secp256k1/src/precomputed_ecmult.c', 'Vendor/secp256k1/src/precomputed_ecmult_gen.c',
        'Vendor/secp256k1/src/secp256k1.c']:
    problems31.append('project.yml compiles something other than libsecp256k1 and its two tables')
# The three modules Foxy/Nostr needs, and no others: ecdh for the shared point
# NIP-44 hashes, extrakeys and schnorrsig for BIP-340, which signs a Nostr event.
if sorted(set(re.findall(r'-DENABLE_MODULE_(\w+)=1', yml31))) != ['ECDH', 'EXTRAKEYS', 'SCHNORRSIG']:
    problems31.append('project.yml turns on libsecp256k1 modules other than ecdh, extrakeys and schnorrsig')
allowed31 = {'secp256k1_ec_pubkey_create', 'secp256k1_ec_pubkey_serialize', 'secp256k1_ec_seckey_tweak_add',
             'secp256k1_ec_seckey_verify', 'secp256k1_context_create', 'secp256k1_context_randomize',
             'secp256k1_context_destroy'}
# what Foxy/Nostr may call as well: the shared point, the keypair, and BIP-340
nostr31 = {'secp256k1_ecdh', 'secp256k1_ec_pubkey_parse', 'secp256k1_keypair_create',
           'secp256k1_keypair_xonly_pub', 'secp256k1_xonly_pubkey_serialize', 'secp256k1_xonly_pubkey_parse',
           'secp256k1_schnorrsig_sign32', 'secp256k1_schnorrsig_verify'}
NOSTR_DIR = os.path.join('Foxy', 'Nostr')
for path31 in swift_files:
    text = open(path31, encoding='utf8').read()
    calls = set(re.findall(r'\b(secp256k1_\w+)\s*\(', text)) - {'secp256k1_pubkey', 'secp256k1_keypair',
                                                                  'secp256k1_xonly_pubkey', 'secp256k1_ecdh_hash_function'}
    may = allowed31 | (nostr31 if path31.startswith(NOSTR_DIR) else set())
    if calls - may:
        problems31.append(path31 + ' calls libsecp256k1 beyond what it may: ' + ', '.join(sorted(calls - may)))
importers31 = [p for p in swift_files if re.search(r'^\s*import CSecp256k1\b', open(p, encoding='utf8').read(), re.M)]
if [p for p in importers31 if p != os.path.join('Foxy', 'Keychain', 'NUT13.swift') and not p.startswith(NOSTR_DIR)]:
    problems31.append('libsecp256k1 is imported outside Foxy/Keychain/NUT13.swift and Foxy/Nostr: '
                      + ', '.join(importers31))
bridge31 = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge.swift'), encoding='utf8').read()
host31 = open(os.path.join('Foxy', 'FoxyWebView.swift'), encoding='utf8').read()
store31 = open(os.path.join('Foxy', 'Keychain', 'SeedStore.swift'), encoding='utf8').read()
native31 = open(os.path.join('Foxy', 'Bridge', 'NativeSeedBridge.swift'), encoding='utf8').read()
both31 = bridge31 + native31
# stage 2 replaced seedSecrets, which answered any range, with ranges reserved first or inside a restore window
if re.search(r'\n\s*"seedSecrets": FoxyBridge\.', bridge31):
    problems31.append('seedSecrets is still in the action table')
actions31 = open(os.path.join('Foxy', 'Keychain', 'SeedActions.swift'), encoding='utf8').read()
read31 = re.search(r'static func readSavedSeed\(_ env: SeedEnvironment\) throws -> NUT13\.Seed \{(.*?)\n    \}', actions31, re.S)
if not read31 or 'env.savedSeed()' not in read31.group(1) or 'savedSeed: { SeedVault.seedForSecrets() }' not in actions31:
    problems31.append('the native secrets no longer read the seed through SeedVault')
queue31 = re.search(r'private func onSeedQueue\(id: String, (.*?)\n    \}\n', native31, re.S)
if not queue31 or 'Self.seedQueue.async' not in queue31.group(1) or 'action(.live)' not in queue31.group(1):
    problems31.append("the seed actions no longer run on seedQueue with the app's environment")
for action31 in ('counterReserve', 'counterReserveAt', 'restoreSecrets'):
    body31 = bridge_handler(both31, action31)
    if not body31:
        problems31.append(action31 + ' has no handler function in FoxyBridge.handlers')
        continue
    if 'nativeSecretsEnabled' in body31 or 'notEnabled' in body31:
        problems31.append(action31 + ' is behind a switch again; it answers in every build')
    fn31 = action_body(actions31, action31)
    if 'onSeedQueue(id: id) { SeedActions.' + action31 + '(request, env: $0) }' not in body31 or 'readSavedSeed(env)' not in fn31:
        problems31.append(action31 + ' does not read the seed through SeedVault off the main queue')
    if re.search(r'\bwords\b|mnemonic|phrase', body31 + fn31):
        problems31.append(action31 + ' handles the words itself')
# review H1: a 00 keyset's counters, and typed words' windows, by derivation path
nut31 = open(os.path.join('Foxy', 'Keychain', 'NUT13.swift'), encoding='utf8').read()
rules31 = open(os.path.join('Foxy', 'Keychain', 'CounterRules.swift'), encoding='utf8').read()
counters31 = open(os.path.join('Foxy', 'Keychain', 'CounterStore.swift'), encoding='utf8').read()
cands31 = open(os.path.join('Foxy', 'Keychain', 'SeedCandidates.swift'), encoding='utf8').read()
derive31 = re.search(r'static func derive\(seed: Seed, (.*?)\n    \}\n', nut31, re.S)
index31 = re.search(r'static func derivationIndex\(_ keysetId: String\) -> UInt32\? \{(.*?)\n    \}', nut31, re.S)
if not derive31 or 'guard let keysetInt = derivationIndex(keysetId)' not in derive31.group(1) or '0x7FFF_FFFF)' in derive31.group(1) \
        or not index31 or 'number % 0x7FFF_FFFF' not in index31.group(1):
    problems31.append('the derivation no longer takes its index from NUT13.derivationIndex, which the counters are kept by')
if 'case 0: return NUT13.derivationIndex(keysetId).map { "00:\\($0)" }' not in rules31:
    problems31.append("a 00 keyset's counter is no longer kept by its derivation index")
for fn31 in ('func next(', 'func reserve(_ keysetId: String, version: UInt8, count:', 'func advance(', 'private func key('):
    part31 = counters31.split(fn31, 1)[1].split('\n    }\n', 1)[0] if fn31 in counters31 else ''
    if 'CounterRules.storedKey(' not in part31:
        problems31.append('CounterStore ' + fn31 + ' keys a counter by the id text, not its derivation path')
if 'let merged = CounterRules.merged(parsed)' not in counters31:
    problems31.append('a counter file with two ids of one path is not merged when it is read')
serve31 = cands31.split('func serve(', 1)[-1].split('\n    }\n', 1)[0]
if 'CounterRules.slot(keysetId)' not in serve31 or 'candidate.served[slot]' not in serve31:
    problems31.append("typed words' restore window is kept by the id text, not the derivation path")
if 'env.counters.noteServed(' not in action_body(actions31, 'restoreSecrets'):
    problems31.append('a restore no longer notes what it served, which counterAdvance is capped by')
# review I2: the keys, HMAC outputs and tweaks on the way to a secret are wiped
child31 = re.search(r'static func child\((.*?)\n    \}\n', nut31, re.S)
master31 = re.search(r'static func master\((.*?)\n    \}\n', nut31, re.S)
if not child31 or 'wipe(&mac)' not in child31.group(1) or 'wipe(&tweak)' not in child31.group(1) or 'wipe(&data)' not in child31.group(1) \
        or 'data.reserveCapacity(37)' not in child31.group(1) or not master31 or 'wipe(&mac)' not in master31.group(1) \
        or not derive31 or 'parent.wipe()' not in derive31.group(1) or 'base.wipe()' not in derive31.group(1):
    problems31.append('the derived BIP-32 keys, HMAC outputs and tweaks are no longer wiped')
# review M9: tools/nativetests tests this code, with libsecp256k1 built as the app builds it
pkg31_path = os.path.join('tools', 'nativetests', 'Package.swift')
pkg31 = open(pkg31_path, encoding='utf8').read() if os.path.exists(pkg31_path) else ''
yml_flags31 = set(re.findall(r'-D(\w+=\w+)', yml31))
pkg_flags31 = set('%s=%s' % d for d in re.findall(r'\.define\("(\w+)", to: "(\w+)"\)', pkg31))
if not pkg31 or not yml_flags31 or yml_flags31 != pkg_flags31 or '"-O2"' not in pkg31:
    problems31.append('tools/nativetests compiles libsecp256k1 with other defines than project.yml')
for link31, target31 in ((('tools', 'nativetests', 'Sources', 'CSecp256k1', 'src'), os.path.join('Vendor', 'secp256k1', 'src')),
                         (('tools', 'nativetests', 'Sources', 'CSecp256k1', 'include'), os.path.join('Vendor', 'secp256k1', 'include')),
                         (('tools', 'nativetests', 'Sources', 'Foxy'), os.path.join('Foxy', 'Keychain')),
                         (('tools', 'nativetests', 'Tests', 'FoxyTests'), 'FoxyTests')):
    p31 = os.path.join(*link31)
    if not os.path.islink(p31) or os.path.realpath(p31) != os.path.realpath(target31):
        problems31.append(p31 + ' is not a link to ' + target31 + ': the tests would not test what ships')
if re.search(r'nativeSecretsEnabled|"FoxyNativeSecrets"', both31 + host31):
    problems31.append('a switch still decides whether the native seed answers')
if 'foxyNativeSecrets' in host31:
    problems31.append('the page is still told whether native secrets are on, a flag it no longer reads')
if 'SeedVault.forgetNativeSeed()' not in bridge31.split('func pageGone()', 1)[-1][:400]:
    problems31.append('the seed kept for the native secrets outlives the page')
if 'SeedVault.forgetNativeSeed()' not in host31.split('func appEnteredBackground()', 1)[-1][:400]:
    problems31.append('the seed kept for the native secrets stays while Foxy is in the background')
forget31 = re.search(r'static func forgetUnlock\(\) \{(.*?)\n    \}', store31, re.S)
if not forget31 or 'nativeSeed = nil' not in forget31.group(1):
    problems31.append('forgetting the unlock keeps the seed the native secrets use')
if problems31:
    fail('native NUT-13: ' + '; '.join(problems31))
else:
    ok('libsecp256k1 is the signed v0.8.0 as listed, built alike in tools/nativetests; the native secrets answer with no switch, read through SeedVault, keep 00 counters by derivation index, wipe derived keys, and their seed goes with the page, unlock and foreground')

# ---- 32. the seed on the phone (stages 2 and 4): the words stay there ---------
# The page never receives the words and native owns the counters, in every build.
# Each seed action has its handler, answers only its agreed reply, and is behind
# no switch; the page's seedRead, seedWrite and seedDelete are gone. The wordlist that
# makes and checks words is the one in Web/bip39.js, pinned by its SHA-256. The
# counter file is written atomically, protected, out of backups and never
# lowered. Replacing or wiping the seed asks the iOS alerts the page's seedWrite
# and seedDelete asked, and sets the counters aside only after the keychain
# has changed. The restore window and the candidate limits are the agreed ones,
# and typed words go wherever the kept seed goes. The seed screens hide the words
# from a recording, warn after a screenshot, keep the keyboard from changing a
# word, come one at a time, and close with the page and the foreground.
import hashlib as hashlib32
problems32 = []
def read32(*parts):
    return open(os.path.join(*parts), encoding='utf8').read()
bridge32 = read32('Foxy', 'Bridge', 'FoxyBridge.swift')
native32 = read32('Foxy', 'Bridge', 'NativeSeedBridge.swift')
screens32 = read32('Foxy', 'Bridge', 'SeedScreens.swift')
vault32 = read32('Foxy', 'Keychain', 'SeedStore.swift')
counters32 = read32('Foxy', 'Keychain', 'CounterStore.swift')
bip32 = read32('Foxy', 'Keychain', 'BIP39.swift')
cands32 = read32('Foxy', 'Keychain', 'SeedCandidates.swift')
acts32 = read32('Foxy', 'Keychain', 'SeedActions.swift')
rules32 = read32('Foxy', 'Keychain', 'CounterRules.swift')
host32 = read32('Foxy', 'FoxyWebView.swift')
both32 = bridge32 + native32
actions32 = ['seedStatus', 'seedCreate', 'seedMigrate', 'countersImport', 'counterReserve', 'counterReserveAt', 'counterAdvance',
             'counterSnapshot', 'restoreSecrets', 'seedShow', 'seedEnter', 'seedAdopt', 'seedCandidateForget', 'seedWipe',
             # what stands in front of the seed, and the move between the two (SECURE FOXY)
             'seedProtection', 'seedProtect',
             # the keys a payment request locks ecash to, at NUT-13's P2PK path
             'p2pkReserve', 'p2pkPubkeys', 'p2pkKey']
declared32 = re.search(r'static let nativeSeedActions: Set<String> = \[(.*?)\]', native32, re.S)
if not declared32 or sorted(re.findall(r'"(\w+)"', declared32.group(1))) != sorted(actions32):
    problems32.append('nativeSeedActions is not the nineteen seed actions')
dispatch32 = re.search(r'static func dispatch\(_ message: Any\) -> Dispatch \{(.*?)\n    \}', bridge32, re.S)
if not dispatch32 or 'guard let handler = handlers[action] else { return .unknown(action: action, id: id) }' not in dispatch32.group(1):
    problems32.append('dispatch no longer refuses an action that is not in the table')
elif 'nativeSeedActions' in dispatch32.group(1) or 'case refused' in bridge32:
    problems32.append('dispatch refuses the seed actions again; they answer in every build')
for action32 in actions32:
    body32 = bridge_handler(both32, action32)
    if not body32:
        problems32.append(action32 + ' has no handler function in FoxyBridge.handlers')
    elif 'nativeSecretsEnabled' in body32 or 'notEnabled' in body32:
        problems32.append(action32 + ' is behind a switch again')
# every answer a stage-2 action gives the page is its agreed JSON, an error, or nothing
for m in re.finditer(r'(?:resolve|endSeedChange)\(id: id, text: (.*?), error:', native32):
    arg32 = m.group(1).strip()
    if not (arg32 in ('nil', 'made.text', 'reply.text')
            or arg32.startswith(('Self.json(', 'Self.countersReply(', 'NUT13.reply(',
                                 'P2PK.pubkeysReply(', 'P2PK.keyReply('))):
        problems32.append('a seed action answers the page with ' + arg32)
    elif re.search(r'\bwords\b|phrase|\btext\b|found', arg32) and arg32 not in ('made.text', 'reply.text'):
        problems32.append('a seed action may answer the page with the words: ' + arg32)
# ...and every reply the actions make (SeedActions.swift): agreed JSON, NUT13.reply,
# or a fixed message, with no words, candidate or seed named in it (review
# L12; SeedActionsTests runs them all with a stub vault)
for line32 in acts32.splitlines():
    if 'func answer(' in line32 or 'func refuse(' in line32:
        continue
    for kind32, arg32 in re.findall(r'\.(answer|refuse)\((.*)$', line32):
        code32 = re.sub(r'"(?:[^"\\]|\\.)*"', '""', arg32) + ' ' + ' '.join(re.findall(r'\\\((\w+)\)', arg32))
        if arg32.startswith('let '):
            continue  # a pattern (case .answer(let outcome)), not a reply
        if kind32 == 'answer' and not arg32.startswith(('json(', 'countersReply(', 'NUT13.reply(',
                                                        'P2PK.pubkeysReply(', 'P2PK.keyReply(')):
            problems32.append('a seed action answers the page with ' + arg32.strip())
        elif re.search(r'\b(words|phrase|typed|mnemonic|seed|saved|served|candidate)\b', code32):
            problems32.append('a seed action may answer the page with the words or the seed: ' + arg32.strip())
if acts32.count('SeedReply(text:') != 2:
    problems32.append('a seed action builds a reply other than through answer or refuse')
# seedMigrate's reply is only one of its three agreed objects
reply32 = action_body(acts32, 'migrateReply')
if sorted(re.findall(r'return \.(?:answer|refuse)\((json\(\[.*?\]\)|why)\)', reply32)) != sorted(
        ['json(["migrated": true])', 'json(["migrated": false, "same": true])', 'json(["migrated": false, "different": true])', 'why']):
    problems32.append('seedMigrate answers something other than migrated, same or different')
# the page's own word actions are gone, with the switch-era refusals
for action32 in ('seedRead', 'seedWrite', 'seedDelete'):
    if bridge_handler(both32, action32) is not None or re.search(r'\n\s*"' + action32 + r'": ', bridge32):
        problems32.append(action32 + ' is in the action table: the page would handle the words')
if re.search(r'wordsRefusal|wordsStayOnPhone|"not enabled"', both32):
    problems32.append('the switch-era refusals are still in the bridge')
# the wordlist
list32 = re.search(r'Object\.freeze\(`(abandon\n[a-z\n]*?\nzoo)`', open(os.path.join('Web', 'bip39.js'), encoding='utf8').read())
txt32_path = os.path.join('Foxy', 'Keychain', 'bip39-english.txt')
txt32 = open(txt32_path, 'rb').read() if os.path.exists(txt32_path) else b''
if not list32 or txt32 != (list32.group(1) + '\n').encode():
    problems32.append('Foxy/Keychain/bip39-english.txt is not the wordlist in Web/bip39.js')
pinned32 = re.search(r'static let englishSHA256 = "([0-9a-f]{64})"', bip32)
if not pinned32 or hashlib32.sha256(txt32).hexdigest() != pinned32.group(1):
    problems32.append("BIP39.englishSHA256 is not bip39-english.txt's SHA-256")
if not re.search(r'static func wordlist\(_ data: Data\) -> \[String\]\? \{\s*guard NUT13\.hex\(Array\(SHA256\.hash\(data: data\)\)\) == englishSHA256', bip32) \
        or 'guard let list = wordlist(data)' not in bip32:
    problems32.append('the wordlist is used without its SHA-256 checked at load')
generate32 = re.search(r'static func generate\(wordlist: \[String\]\) throws -> String \{(.*?)\n    \}', bip32, re.S)
if not generate32 or 'SecRandomCopyBytes(kSecRandomDefault' not in generate32.group(1) or 'repeating: 0, count: 16' not in generate32.group(1):
    problems32.append('a new seed is no longer 128 bits from SecRandomCopyBytes')
# the counter file, and the lock-key index beside it: both through one writer
save32 = re.search(r'private func save\(_ c: \[String: UInt64\]\) throws \{(.*?)\n    \}\n', counters32, re.S)
savedP32 = re.search(r'private func saveP2PK\(_ next: UInt64\) throws \{(.*?)\n    \}\n', counters32, re.S)
atomic32 = re.search(r'private func write\(_ object: \[String: NSNumber\], to url: URL\) throws \{(.*?)\n    \}\n', counters32, re.S)
flush32 = re.search(r'static func flush\(_ url: URL\) throws \{(.*?)\n    \}\n', counters32, re.S)
saved32 = save32.group(1) if save32 else ''
savedp32 = savedP32.group(1) if savedP32 else ''
written32 = atomic32.group(1) if atomic32 else ''
# review L6: a temporary file beside it, flushed with F_FULLFSYNC, then renamed over it
if '.completeFileProtectionUntilFirstUserAuthentication' not in written32 or 'isExcludedFromBackup = true' not in written32 \
        or 'let temporary = directory.appendingPathComponent(' not in written32 \
        or not (0 <= written32.find('data.write(to: temporary') < written32.find('try Self.flush(temporary)')
                < written32.find('rename(temporary.path, url.path)')) \
        or not flush32 or 'fcntl(fd, F_FULLFSYNC)' not in flush32.group(1):
    problems32.append('the counter file is not written to a flushed temporary file and renamed, protected until first unlock and out of backups')
# and neither changes in memory before its file has
if not (0 <= saved32.find('try write(') < saved32.find('counters = c')):
    problems32.append('the counters change in memory before the file has')
if not (0 <= savedp32.find('try write(') < savedp32.find('p2pkStored = next')):
    problems32.append('the lock-key index changes in memory before its file has')
if 'static let fileName = "foxy-counters.json"' not in counters32 or '"foxy-counters.replaced.\\(stamp).json"' not in counters32:
    problems32.append('the counter file or its moved-aside name changed')
if 'static let p2pkFileName = "foxy-p2pk.json"' not in counters32 or '"foxy-p2pk.replaced.\\(stamp).json"' not in counters32:
    problems32.append('the lock-key index file or its moved-aside name changed')
# a new seed's lock keys start from zero, so the index goes aside with the counters
aside32 = counters32.split('func moveAside()', 1)[-1].split('\n    }\n', 1)[0]
if 'p2pkURL' not in aside32 or 'replacedP2PKURL' not in aside32:
    problems32.append('moveAside leaves the lock-key index behind when the seed changes')

# ---- the keys a payment request locks ecash to (P2PK.swift) ----------------
#
# NUT-13's path, m/129373'/10'/0'/0'/{index}. Three things about it can be
# broken silently, and each of them is money:
#   - a hardened last level gives a wallet consistent with itself and with no
#     other implementation, so the ecash opens here and nowhere else;
#   - the parent chain code crossing the bridge gives the page, and anything in
#     it, every index there will ever be;
#   - a private key answered for any index on demand is a bridge action that
#     hands out key material with nothing in front of it.
p2pk32 = read32('Foxy', 'Keychain', 'P2PK.swift')
for need32 in ('static let purpose: UInt32 = 129373', 'static let account: UInt32 = 10',
               'for level in [purpose, account, 0, 0] as [UInt32] {',
               'try NUT13.child(parent, level | 0x8000_0000, ctx)'):
    if need32 not in p2pk32:
        problems32.append('P2PK.swift no longer walks m/129373\'/10\'/0\'/0\': ' + need32)
derive32 = p2pk32.split('static func derive(', 1)[-1].split('\n    }\n', 1)[0]
if 'try NUT13.child(parent, UInt32(index), ctx, publicKey: point)' not in derive32:
    problems32.append('the lock key\'s last level is not a normal BIP-32 child, which no other wallet would match')
if not (0 <= derive32.find('NUT13.wipe(&child.chain)') < derive32.find('return Pair(')):
    problems32.append('a lock key is returned with its chain code, which gives the parent and every other index')
if 'chain' in p2pk32.split('static func keyReply(', 1)[-1].split('\n    }\n', 1)[0]:
    problems32.append('p2pkKey answers with a chain code')
key32 = action_body(acts32, 'p2pkKey')
if not (0 <= key32.find('P2PK.keyAllowed(') < key32.find('readSavedSeed(env)')):
    problems32.append('p2pkKey asks for the seed before refusing an index outside the window')
if 'RestoreWindow.beyond' not in p2pk32:
    problems32.append('the lock-key window is no longer the restore window\'s own 1000')
reserve32 = action_body(acts32, 'p2pkReserve')
if not (0 <= reserve32.find('counters.p2pkReserve(count: count)') < reserve32.find('P2PK.publicKeys(')):
    problems32.append('p2pkReserve derives lock keys before the index that records them is written')
pubs32 = p2pk32.split('static func publicKeys(', 1)[-1].split('\n    }\n', 1)[0]
if 'pairs[i].wipe()' not in pubs32:
    problems32.append('p2pkReserve and p2pkPubkeys keep the private halves they did not ask for')
for fn32 in ('func importMax(', 'func raise('):
    body32 = counters32.split(fn32, 1)[-1].split('\n    }\n', 1)[0]
    if 'max(c[k] ?? 0' not in body32:
        problems32.append('CounterStore.' + fn32[5:-1] + ' could lower a counter')
advance32 = counters32.split('func advance(', 1)[-1].split('\n    }\n', 1)[0]
if 'guard value > current else { return current }' not in advance32:
    problems32.append('CounterStore.advance could lower a counter')
# review M1 and L9: moves capped, the import once, at most 256 keysets
if 'CounterRules.advance(current: current, next: value, highest: served[slot] ?? 0, version: version) == .allowed' not in advance32:
    problems32.append('counterAdvance is not capped at 100 past the counter or at what a restore served')
at32 = counters32.split('func reserve(_ keysetId: String, version: UInt8, at start: UInt64', 1)[-1].split('\n    }\n', 1)[0]
if 'CounterRules.reserveAt(current: current, start: start) == .allowed' not in at32:
    problems32.append('counterReserveAt is not capped at 100 past the counter')
reserveat32 = action_body(acts32, 'counterReserveAt')
if not (0 <= reserveat32.find('CounterRules.reserveAt(') < reserveat32.find('readSavedSeed(env)')):
    problems32.append('counterReserveAt asks for the seed before refusing a start too far ahead')
for need32 in ('static let reach: UInt64 = 100', 'static let mostKeysets = 256', 'version == 0 ? 1 << 31 : 1 << 53',
               'guard next <= ceiling(version: version) else { return .tooFarAhead }',
               'return overflow || next <= max(near, highest) ? .allowed : .tooFarAhead',
               'return overflow || start <= near ? .allowed : .tooFarAhead'):
    if need32 not in rules32:
        problems32.append('CounterRules.swift no longer has ' + need32)
for need32 in ('static let importedKey = "foxy.counters.imported"',
               'guard !defaults.bool(forKey: Self.importedKey) else { throw Failure.alreadyImported }',
               'case .tooFarAhead: return "too far ahead"', 'case .alreadyImported: return "counters were already imported"',
               'case .tooManyKeysets: return "too many keysets"',
               'guard c[k] != nil || c.count < CounterRules.mostKeysets else { throw Failure.tooManyKeysets }',
               'CounterRules.capped(value, version: version)'):
    if need32 not in counters32:
        problems32.append('CounterStore.swift no longer has ' + need32)
if 'env.counters.importOnce(' not in action_body(acts32, 'countersImport'):
    problems32.append('countersImport answers more than once per install')
# seed changes
adopt32 = bridge_handler(both32, 'seedAdopt') or ''
adoptfn32 = action_body(acts32, 'adopt')
for need32 in ('beginSeedChange(id: id)', 'confirmSeedChangeAndWait(', 'Self.replaceSeedTitle', 'SeedActions.adopt(candidate, env: .live)'):
    if need32 not in adopt32:
        problems32.append('seedAdopt no longer has ' + need32)
for need32 in ('env.write(words, true, candidate)', 'env.counters.moveAside()', 'sameBytes(as:', 'env.counters.raise(served)'):
    if need32 not in adoptfn32:
        problems32.append('SeedActions.adopt no longer has ' + need32)
if not (0 <= adoptfn32.find('env.write(') < adoptfn32.find('env.counters.moveAside()')):
    problems32.append('seedAdopt sets the counters aside before the keychain has the new words')
# review M2: typed words raise the counters to where they were served, the saved seed's own words too
same32 = adoptfn32.split('where saved.sameBytes(as: typed):', 1)[-1].split('case .found, .absent:', 1)[0]
if 'env.counters.raise(served)' not in same32 or adoptfn32.count('env.counters.raise(served)') != 2 \
        or adoptfn32.rfind('env.counters.raise(served)') < adoptfn32.find('env.counters.moveAside()'):
    problems32.append('typed words served past the counters do not raise them when adopted or found to be the saved seed')
# M6: the adopted candidate is kept through its own write
if 'candidates.forget(' in adoptfn32 or 'forgetNativeSeed(keepingCandidate: keepCandidate)' not in vault32:
    problems32.append('seedAdopt drops the candidate whose scans may still be running')
# M7: after any write attempt the kept seed goes and a problem is read again; the screens hear of a change
write32 = re.search(r'static func write\(_ words: String, replace: Bool, (.*?)\n    \}\n', vault32, re.S)
w32 = write32.group(1) if write32 else ''
if not (0 <= w32.find('let attempt = ') < w32.find('forgetNativeSeed(keepingCandidate: keepCandidate)')
        < w32.find('writeOutcome(problem: attempt')) or 'if problem == nil { noteSeedChanged() }' not in w32:
    problems32.append('a seed write keeps the old seed after a failed read-back, or does not tell the screens')
if 'static let seedChanged = Notification.Name("FoxySeedChanged")' not in vault32 \
        or 'NotificationCenter.default.post(name: seedChanged' not in vault32:
    problems32.append('FoxySeedChanged is not posted')
# L5: a wipe moves nothing until the seed is checked gone
wipe32 = bridge_handler(both32, 'seedWipe') or ''
wipefn32 = action_body(acts32, 'wipe')
delete32 = re.search(r'static func delete\(\) -> Bool \{(.*?)\n    \}\n', vault32, re.S)
for need32 in ('beginSeedChange(id: id)', 'confirmSeedChange(title: Self.deleteSeedTitle', 'guard yes else',
               'SeedVault.deviceOwnerApproves(reason: Self.deleteSeedReason)', 'SeedActions.wipe(.live)'):
    if need32 not in wipe32:
        problems32.append('seedWipe no longer has ' + need32)
if not (0 <= wipe32.find('SeedVault.deviceOwnerApproves(reason: Self.deleteSeedReason)') < wipe32.find('SeedActions.wipe(.live)')):
    problems32.append('seedWipe deletes before Face ID or the passcode approves (by design)')
if not (0 <= wipe32.find('guard yes else') < wipe32.find('SeedActions.wipe(.live)')):
    problems32.append('seedWipe deletes before the yes')
if not (0 <= wipefn32.find('guard env.delete() else { return .refuse("the seed could not be deleted") }')
        < wipefn32.find('env.counters.moveAside()') < wipefn32.find('create(env)')):
    problems32.append('a wipe sets the counters aside or makes a seed before the old seed is checked gone')
if not delete32 or 'seedGone(deleted: deleted, stillThere: left)' not in delete32.group(1) or 'SeedStore.exists(key:' not in delete32.group(1):
    problems32.append('SeedVault.delete does not check that the seed is gone')
if 'static let replaceSeedTitle = "Replace this wallet\'s seed?"' not in bridge32 or \
        'static let deleteSeedTitle = "Delete this wallet\'s seed?"' not in bridge32:
    problems32.append("the seed alerts' titles changed")
create32 = action_body(acts32, 'create')
if 'case .found: return .refuse("a seed already exists")' not in create32 or 'env.write(words, false, nil, { false })' not in create32:
    problems32.append('seedCreate could write over a saved seed')
# the restore window and typed words
restore32 = action_body(acts32, 'restoreSecrets')
if 'RestoreWindow.savedSeedAllowed(' not in restore32 or 'env.candidates.serve(' not in restore32:
    problems32.append('restoreSecrets no longer keeps to the restore window')
for need32 in ('static let beyond: UInt64 = 1000', 'static let candidateCap: UInt64 = 20_000', 'static let most = 2'):
    if need32 not in cands32:
        problems32.append('SeedCandidates.swift no longer has ' + need32)
for fn32, need32 in (('forgetUnlock()', 'SeedCandidates.shared.forgetAll()'), ('pageWillLoad()', 'SeedCandidates.shared.forgetAll()'),
                     ('forgetNativeSeed()', 'forgetNativeSeed(keepingCandidate: nil)'),
                     ('forgetNativeSeed(keepingCandidate kept: String?)', 'SeedCandidates.shared.forgetAll(except: kept)')):
    body32 = re.search(r'static func ' + re.escape(fn32) + r' \{(.*?)\n    \}', vault32, re.S)
    if not body32 or need32 not in body32.group(1):
        problems32.append('typed words outlive SeedVault.' + fn32)
if 'held = held.filter { $0.key == kept }' not in cands32:
    problems32.append('SeedCandidates.forgetAll keeps more than the candidate just adopted')
# the screens
for need32 in ('Hidden while the screen is recorded or shared', 'UITraitSceneCaptureState', 'userDidTakeScreenshotNotification',
               'THAT SCREENSHOT SHOWS YOUR SEED', 'TAP TO REVEAL', 'autocapitalizationType = .none', 'autocorrectionType = .no',
               'spellCheckingType = .no', 'NativePrompts.shared.isShowing', 'isModalInPresentation = true'):
    if need32 not in screens32:
        problems32.append('SeedScreens.swift no longer has ' + need32)
for action32 in ('seedShow', 'seedEnter'):
    body32 = bridge_handler(both32, action32) or ''
    if 'SeedScreens.queue.enqueue' not in body32 or 'SeedScreens.present(' not in body32:
        problems32.append(action32 + ' does not wait its turn in the seed screen queue')
if 'SeedScreens.closeAll()' not in host32.split('func appEnteredBackground()', 1)[-1][:700]:
    problems32.append('a seed screen stays up while Foxy is in the background')
if 'SeedScreens.closeAll()' not in bridge32.split('func pageGone()', 1)[-1][:600]:
    problems32.append('a seed screen outlives the page')
if problems32:
    fail('native seed, stage 2: ' + '; '.join(problems32))
else:
    ok("the seed actions answer no words and the page's word actions are gone; the wordlist is pinned; counters are flushed and renamed, protected, never lowered and capped; seed changes ask iOS, raise typed words' counters and set old ones aside; wipes check the delete; the screens hide the words")

# ---- 33. the seed on the phone is in every build (stage 4) --------------------
# There is no switch. A Release build has the seed actions, the screens, the
# counter file and the wordlist: none of their code is under #if, the action
# table is not, and project.yml leaves no source out. The self-tests that drive
# them from the page (-FoxySeedSelfTest, -FoxySeedScreenTest) stay Debug-only.
problems33 = []
for rel33 in (('Foxy', 'Bridge', 'NativeSeedBridge.swift'), ('Foxy', 'Bridge', 'SeedScreens.swift'),
              ('Foxy', 'Keychain', 'CounterStore.swift'), ('Foxy', 'Keychain', 'SeedCandidates.swift'),
              ('Foxy', 'Keychain', 'BIP39.swift'), ('Foxy', 'Keychain', 'NUT13.swift'), ('Foxy', 'Keychain', 'SeedStore.swift'),
              ('Foxy', 'Keychain', 'SeedActions.swift'), ('Foxy', 'Keychain', 'CounterRules.swift'),
              ('Foxy', 'Keychain', 'SeedMigrationWindow.swift')):
    if re.search(r'^[ \t]*#if\b', read32(*rel33), re.M):
        problems33.append(os.path.join(*rel33) + ' has code under #if; the seed must build the same in Release')
debug33 = debug_regions(bridge32)
table33 = bridge32.find('static let handlers: [String: Handler] = [')
if table33 < 0 or any(a <= table33 < b for a, b in debug33):
    problems33.append('the action table is missing or inside #if DEBUG')
for action33 in actions32:
    at33 = re.search(r'\n\s*"' + action33 + r'": FoxyBridge\.', bridge32)
    if not at33 or any(a <= at33.start() < b for a, b in debug33):
        problems33.append(action33 + ' is not in the action table of every build')
if re.search(r'^\s*(excludes|EXCLUDED_SOURCE_FILE_NAMES|INCLUDED_SOURCE_FILE_NAMES)\b', open('project.yml', encoding='utf8').read(), re.M):
    problems33.append('project.yml leaves sources out of a build')
if not os.path.exists(os.path.join('Foxy', 'Keychain', 'bip39-english.txt')):
    problems33.append('the wordlist is not in Foxy/, which every build bundles')
for key33 in ('"FoxySeedSelfTest"', '"FoxySeedScreenTest"'):
    at33 = host32.find(key33)
    if at33 < 0 or not any(a <= at33 < b for a, b in debug_regions(host32)):
        problems33.append(key33 + ' is missing or outside #if DEBUG')
if re.search(r'FoxyNativeSecrets|foxyNativeSecrets|nativeSecretsEnabled', host32 + both32 + vault32 + counters32 + screens32 + acts32):
    problems33.append('the stage-2 switch is still named in the app')
# review M9: the same code is tested on every push, on a Mac with no simulator
pkg33_path = os.path.join('tools', 'nativetests', 'Package.swift')
pkg33 = read32(pkg33_path) if os.path.exists(pkg33_path) else ''
for test33 in ('NUT13Tests.swift', 'BIP39Tests.swift', 'CounterStoreTests.swift', 'CounterRulesTests.swift',
               'SeedMigrationWindowTests.swift', 'SeedVaultTests.swift', 'SeedActionsTests.swift'):
    if '"' + test33 + '"' not in pkg33 or not os.path.exists(os.path.join('FoxyTests', test33)):
        problems33.append('tools/nativetests does not run FoxyTests/' + test33)
checkall33 = read32('tools', 'check-all.sh')
if not re.search(r'^\s*check "native Swift tests" \d+ native_tests$', checkall33, re.M) \
        or not re.search(r'^\s*out="\$\(swift test --package-path tools/nativetests 2>&1\)"$', checkall33, re.M) \
        or 'return $code' not in checkall33:
    problems33.append('tools/check-all.sh does not run the native Swift tests')
if not re.search(r'^\s*- run: swift test --package-path tools/nativetests$', read32('.github', 'workflows', 'checks.yml'), re.M):
    problems33.append("GitHub's checks do not run the native Swift tests")
if problems33:
    fail('the seed in every build: ' + '; '.join(problems33))
else:
    ok('the seed actions, screens, counter file and wordlist are in every build with no switch; the self-tests are Debug-only; the Swift seed tests run on every push without the simulator')

# ---- 34. the seed screens after the review ------------------------------------
# While the screen is recorded or shared, no seed screen shows a word: the words
# and the quiz's slots and tiles are in SecretBoxes, both behind TAP TO REVEAL,
# and the restore screen ends editing, disables its cells and empties and hides
# its suggestion bar (M3). A paste of words Foxy put on the pasteboard is refused
# there, a pasted phrase is cleared, and the cells offer no copy, cut or share
# (M8, L7). The clipboard and the paste control never hand the page a seed
# phrase (L7). The screens come one at a time, are cancelled with closeAll and on
# a seed change, read the words on seedQueue (L1, L4), draw their tiles from
# SecRandomCopyBytes (L3), and are sheets under a native bar (L8).
problems34 = []
def body34(src, signature):
    """The braces of the declaration that starts with `signature`, or ''."""
    at = src.find(signature)
    start = src.find('{', at) if at >= 0 else -1
    if start < 0:
        return ''
    depth = 0
    for i in range(start, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return src[start:i + 1]
    return ''
paste34_path = os.path.join('Foxy', 'Bridge', 'SeedPasteboard.swift')
paste34 = read32(paste34_path) if os.path.exists(paste34_path) else ''
enter34 = screens32.split('final class SeedEnterController', 1)[-1]
def need34(where, text, needs, what):
    missing = [n for n in needs if n not in text]
    if missing:
        problems34.append(what + ' (' + where + ' lacks ' + ', '.join(missing) + ')')
# capture: all three screens
need34('SeedScreenController', screens32, ['registerForTraitChanges([UITraitSceneCaptureState.self])'],
       'a seed screen does not follow the capture state')
need34('viewWillAppear', body34(screens32, 'override func viewWillAppear('), ['captureChanged()'],
       'a seed screen does not check the capture state as it appears')
need34('buildWords', body34(screens32, 'private func buildWords()'),
       ['let box = secretBox()', 'box.content.addSubview(grid)', 'SeedStyle.veil(over: grid, in: box.content)'],
       'the words are not hidden while captured and before the reveal')
need34('buildQuiz', body34(screens32, 'private func buildQuiz()'),
       ['let tilesBox = secretBox()', 'let slotsBox = secretBox()', 'SeedStyle.veil(over: tiles, in: tilesBox.content)'],
       'the quiz is not hidden while captured and before the reveal')
need34('drawQuiz', body34(screens32, 'private func drawQuiz()'), ['guard revealed else'],
       'the quiz draws its words before the reveal')
need34('SeedEnterController.viewDidLoad', body34(enter34, 'override func viewDidLoad()'), ['let box = secretBox()'],
       'the restore cells are not hidden while captured')
need34('SeedEnterController.captureChanged', body34(enter34, 'override func captureChanged()'),
       ['capture.set(FoxyBridge.screenCaptured(self))', 'if step.endEditing', 'view.endEditing(true)', 'resignFirstResponder()',
        '.isEnabled = capture.fieldsEnabled', 'bar.isHidden = !capture.suggestionsShown'],
       'the restore screen keeps editing while captured')
need34('SeedEntry.Capture', body34(screens32, 'struct Capture: Equatable'),
       ['return Step(endEditing: now)', 'guard suggestionsShown, let typed else { return [] }'],
       'the capture rule no longer ends editing and empties the bar')
need34('SeedEnterController.refresh', body34(enter34, 'private func refresh()'), ['bar.show(capture.suggestions('],
       'the suggestion bar is filled without the capture rule')
if 'becomeFirstResponder' in body34(enter34, 'override func captureChanged()'):
    problems34.append('the restore screen refocuses a cell when capture changes')
for guard34, where34 in (('guard !capture.captured else { return false }', 'shouldChangeCharactersIn'),
                         ('!capture.captured', 'textFieldShouldBeginEditing'), ('guard !capture.captured, let i = focused', 'pick')):
    if guard34 not in enter34:
        problems34.append('the restore screen takes ' + where34 + ' while captured')
# the paste refusal, and what a cell offers
need34('SeedField.paste', body34(enter34, 'override func paste(_ sender: Any?)'), ['guard shouldPaste?() ?? true else { return }'],
       'a cell pastes without asking where the words came from')
need34('SeedField.paste(itemProviders:)', body34(enter34, 'override func paste(itemProviders:'), ['guard shouldPaste?() ?? true else { return }'],
       'a cell pastes item providers without asking')
need34('SeedEnterController.cell', body34(enter34, 'private func cell('),
       ['let field = SeedField()', 'field.shouldPaste = {', 'textDragInteraction?.isEnabled = false', 'field.textDropDelegate = self'],
       'the restore cells are not SeedFields that ask before a paste')
need34('pasteAllowed', body34(enter34, 'private func pasteAllowed()'),
       ['SeedPasteboard.paste(changeCount: count, lastFoxyWrite: SeedPasteboard.lastFoxyWrite)', 'pasteNotice = SeedPasteboard.refusal', 'return false'],
       'a paste of words Foxy copied is not refused')
need34('SeedPasteboard', paste34,
       ['changeCount == lastFoxyWrite ? .refuse : .allow',
        '"These words were copied inside Foxy. Type or paste words you wrote down yourself."',
        'filled > 1 && countNow == countAtPaste', 'UIPasteboard.changedNotification'],
       'the pasteboard rules changed')
need34('handleCopy', body34(bridge32, 'private func handleCopy('), ['SeedPasteboard.foxyWrote()'],
       "Foxy's own copy is not recorded")
if 'SeedPasteboard.watch()' not in host32:
    problems34.append('the web view\'s own copies are not watched from launch')
need34('SeedField.canPerformAction', body34(enter34, 'override func canPerformAction('),
       ['Self.allowedActions.contains(action) && super.canPerformAction'], 'a cell offers copy, cut or share')
allowed34 = re.search(r'static let allowedActions: Set<Selector> = \[(.*?)\]', enter34, re.S)
allowed34 = allowed34.group(1) if allowed34 else ''
if re.search(r'\b(copy|cut|share)\b', allowed34) or 'paste(_:)' not in allowed34:
    problems34.append('a cell allows ' + allowed34.replace('\n', ' '))
if 'SeedPasteboard.clear()' not in body34(enter34, 'func textField(_ textField: UITextField, shouldChangeCharactersIn'):
    problems34.append('a pasted phrase is left on the pasteboard')
# the clipboard phrase filter
need34('SeedPasteboard.forPage', body34(paste34, 'static func forPage('),
       ['holdsSeedPhrase(text, wordlist: wordlist)', 'return ""'], 'the page can be handed a seed phrase')
need34('SeedPasteboard.holdsSeedPhrase', body34(paste34, 'static func holdsSeedPhrase('),
       ['[12, 15, 18, 21, 24]', 'BIP39.isValid(', 'SeedEntry.parts(text)'], 'the phrase check changed')
need34('readClipboard', body34(bridge32, 'private func readClipboard('),
       ['let text = SeedPasteboard.forPage(UIPasteboard.general.string ?? "", from: "clipboard")', 'resolve(id: id, text: text, error: nil)'],
       'the clipboard action hands the page a phrase')
need34('startPasteControl', body34(bridge32, 'private func startPasteControl('),
       ['let given = SeedPasteboard.forPage(text, from: "paste control")', '_pasted(\\(Self.literalStatic(given)))'],
       'the paste control hands the page a phrase')
# one screen at a time, cancelled, and read on seedQueue
for action34 in ('seedShow', 'seedEnter'):
    need34(action34, bridge_handler(both32, action34) or '',
           ['SeedScreens.watchSeedChanges()', 'guard !SeedScreens.queue.busy else', 'error: SeedScreens.busyRefusal', 'SeedScreens.queue.enqueue(onCancel:'],
           action34 + ' is not refused while a seed screen is queued or open')
need34('seedShow', bridge_handler(both32, 'seedShow') or '',
       ['SeedScreens.showPause.refuses(at: Date())', 'SeedScreens.showPause.start(at: Date())', 'Self.seedQueue.async',
        'SeedScreens.queue.generation == turn'],
       'seedShow can loop Face ID prompts, reads off seedQueue, or shows a cancelled screen')
need34('closeAll', body34(screens32, 'static func closeAll()'), ['queue.cancelAll()', 'current?.close()'],
       'closeAll leaves queued screens')
need34('watchSeedChanges', body34(screens32, 'static func watchSeedChanges()'), ['Notification.Name("FoxySeedChanged")', 'closeAll()'],
       'a seed change leaves a seed screen open')
# the quiz, and the look
need34('SeedQuiz.systemRandom', body34(screens32, 'static func systemRandom('), ['SecRandomCopyBytes(kSecRandomDefault'],
       'the quiz order is not drawn from SecRandomCopyBytes')
if 'utf16' in body34(screens32, 'static func scramble('):
    problems34.append('the quiz order is made from the words again')
need34('SeedScreenController', screens32,
       ['modalPresentationStyle = .pageSheet', 'prefersGrabberVisible = true', 'UIBlurEffect(style: .systemChromeMaterial)',
        'UIImage(systemName: "lock.shield"', 'static let nativeBarText = "On this iPhone · not the web page"',
        'lockBar.bottomAnchor', 'UIImpactFeedbackGenerator('],
       'the seed screens lost their native sheet and bar')
if 'modalPresentationStyle = .fullScreen' in screens32:
    problems34.append('a seed screen is full screen again')
if problems34:
    fail('the seed screens (review): ' + '; '.join(problems34))
else:
    ok('no seed screen shows a word while captured, and the restore screen stops editing and empties its bar; a paste of words Foxy copied is refused and a pasted phrase cleared; the page is never handed a phrase from the clipboard; one screen at a time, in a sheet under a native bar')

# ---- 35. a Release build says nothing ----------------------------------------
#
# The logs name mint hosts, balances, Tor exit IPs and clipboard prefixes, so a
# Release build silences all three layers that can write them: native print, the
# page's console, and the page's own mirror of it into the native log. Each was
# added after the last one was found going around it — the mirror posted every
# line to a log that prints in all builds, which is the app walking around its
# own guard (the review's finding 16).
#
# tools/sim/release-silence.sh proves it on a simulator, by launching a Release
# build with every Debug flag and counting what it printed; that runs by hand and
# needs a Mac. This is the static half, on every push: the code that does the
# silencing is still there and still behind the right fence.
silence = []

print_swift = os.path.join('Foxy', 'Debug', 'Print.swift')
if not os.path.exists(print_swift):
    silence.append('Foxy/Debug/Print.swift is gone: native print is no longer silenced in Release')
else:
    text35 = open(print_swift, encoding='utf8').read()
    # This file is `#if !DEBUG` (the no-op) / `#else` (the NSLog one) / `#endif`,
    # so check 22's debug_regions is the wrong tool: it records #if DEBUG bodies
    # and drops #else branches, which is every line that matters here. Split on
    # the fence instead.
    fence = re.search(r'^[ \t]*#if\s+!DEBUG[ \t]*$(.*?)^[ \t]*#else[ \t]*$(.*?)^[ \t]*#endif[ \t]*$',
                      text35, re.M | re.S)
    if not fence:
        silence.append('Print.swift is no longer #if !DEBUG / #else: its Release no-op cannot be read')
    else:
        release_half, debug_half = fence.group(1), fence.group(2)
        # The Release half writes to FieldLog and to nothing else.
        #
        # FieldLog is memory on the phone, redacted on the way in, and gets out
        # only when the person taps COPY on the LOGS screen. That is not what
        # "a Release build says nothing" was ever about: what must not happen
        # is a line reaching the system log, where anything on the phone can
        # read it, or a file, which is copied to a Mac and pasted into a chat.
        body35 = re.search(r'func print\([^)]*\)\s*\{(.*?)\n\}', release_half, re.S)
        inside35 = body35.group(1) if body35 else ''
        if not body35:
            silence.append('Print.swift has no print() in its !DEBUG half at all')
        elif 'FieldLog.write' not in inside35:
            silence.append('Print.swift no longer feeds FieldLog in its !DEBUG half: '
                           'the ERRORS and LOGS screens would be empty on a shipped build')
        elif re.sub(r'FieldLog\.write\([^\n]*\)', '', inside35).strip():
            silence.append('Print.swift does something other than FieldLog.write in its !DEBUG half: '
                           'a Release build may be logging again')
        if 'NSLog' in release_half:
            silence.append('Print.swift calls NSLog in its !DEBUG half: a Release build would log')
        if 'NSLog' not in debug_half:
            silence.append('Print.swift no longer puts its NSLog in the DEBUG half')
        # The file log is reached from the Debug half and nowhere else. A line in
        # the system log is gone when the phone is; a line in a file is copied to
        # a Mac and pasted into a chat, so a Release build must not write one.
        if 'DebugLog' in release_half:
            silence.append('Print.swift writes to DebugLog in its !DEBUG half: a Release build would keep a log file')
        if 'DebugLog' not in debug_half:
            silence.append('Print.swift no longer writes to DebugLog: tools/pull-device-log.sh would pull nothing')
        # A shipped build's only record, and the person's only way out of it.
        field35 = read32('Foxy', 'Debug', 'FieldLog.swift')
        if 'static func begin()' not in field35 or 'CFBundleVersion' not in field35:
            silence.append('FieldLog no longer writes a launch banner: a report from a shipped build '
                           'could not say which build it came from')
        cap35 = re.search(r'static let capacity = (\d+)', field35)
        if not cap35 or int(cap35.group(1)) < 2000:
            silence.append('FieldLog holds fewer than 2000 lines: a tap session fills the ring and '
                           'pushes out whatever said what went wrong')
        keep35 = re.search(r'keepCapacity = (\d+)', field35)
        if not keep35 or int(keep35.group(1)) < 300:
            silence.append('the diary that survives a relaunch holds fewer than 300 lines, and a '
                           'force-quit is exactly what a person does after a problem')
        # and it can be got off the phone: a clipboard is not a way to hand over a session
        flog35 = read32('build', 'app', '26c-field-log.js')
        if 'shareFieldLog()' not in flog35:
            silence.append('the log screen has no share: COPY ALL puts a session on the clipboard '
                           'and a shipped build has no other record')

# and the file logger itself, whole, behind one fence
debug_log = os.path.join('Foxy', 'Debug', 'DebugLog.swift')
if not os.path.exists(debug_log):
    silence.append('Foxy/Debug/DebugLog.swift is gone: tools/pull-device-log.sh has nothing to pull')
else:
    text_dl = open(debug_log, encoding='utf8').read()
    if not re.search(r'^#if DEBUG[ \t]*$', text_dl, re.M):
        silence.append('DebugLog.swift is not fenced with #if DEBUG: a Release build would write a log file')
    elif '#endif' not in text_dl:
        silence.append('DebugLog.swift never closes its #if DEBUG')
    else:
        after = text_dl.rsplit('#endif', 1)[1]
        stray = [l for l in after.split('\n') if l.strip() and not l.strip().startswith('//')]
        if stray:
            silence.append('DebugLog.swift has code after its #endif, so it is in Release builds: ' + stray[0].strip())

wv35 = open(os.path.join('Foxy', 'FoxyWebView.swift'), encoding='utf8').read()
spans_wv = debug_regions(wv35)
inside_debug = lambda i: any(a <= i < b for a, b in spans_wv)
for name in ('console.log = noop', 'console.warn = noop', 'console.info = noop', 'console.debug = noop'):
    at = wv35.find(name)
    if at < 0:
        silence.append('the page\'s %s is gone: a Release build would keep that console' % name.split(' ')[0])
    elif inside_debug(at):
        silence.append('%s is injected inside #if DEBUG: it silences the wrong build' % name.split(' ')[0])
flag = wv35.find('window.FOXY_DEBUG = true')
if flag < 0:
    silence.append('window.FOXY_DEBUG is never set: the page cannot tell which build it is in')
elif not inside_debug(flag):
    silence.append('window.FOXY_DEBUG is set outside #if DEBUG: a Release build would mirror its console')

# The page's own mirror runs in every build now, and that is deliberate: a
# mirrored line becomes a native print, and a native print in a Release build
# reaches FieldLog and nothing else (Print.swift, above). What still must not
# happen is the page posting its lines anywhere but through that one door.
mirror = app[app.find('mirrorConsole('):app.find('_installMirror(')] if 'mirrorConsole(' in app else ''
install = app[app.find('_installMirror('):app.find('_installMirror(') + 1400] if '_installMirror(' in app else ''
if not mirror:
    silence.append('the app class no longer has mirrorConsole()')
if not install:
    silence.append('the app class no longer has _installMirror()')
elif "action: 'log'" not in install:
    silence.append('_installMirror no longer posts through the log action: '
                   'the page may be reaching the system log another way')

if silence:
    fail('a Release build would say something: ' + '; '.join(silence))
else:
    ok('Release: native print is a no-op, the page\'s console.log/warn/info/debug are replaced, '
       'the mirror installs only where FOXY_DEBUG is set, and the file log is Debug-only')


# ---- 35b. every diagnostic reaches the file, not only the system log --------
#
# A test whose verdict IS an NSLog line - the seed screens (§14), the network
# block, the keychain rules, the seed self-test - could only ever be read in
# Console.app while it ran. When the log file arrived, those were precisely the
# lines missing from it, and tools/pull-device-log.sh shipped with a section
# grepping for [seedscreentest] that could never fill: the one test the tool was
# built for could not be judged from its own output.
#
# DebugLog.both writes both places. Nothing else may call NSLog. This is not a
# Release-silence check - an NSLog inside #if DEBUG leaks nothing - it is the
# check that evidence a phone test rests on actually lands in the file.
bare_nslog = []
for dirpath, _dirs, filenames in os.walk('Foxy'):
    for filename in sorted(filenames):
        if not filename.endswith('.swift') or filename in ('Print.swift', 'DebugLog.swift'):
            continue
        path35b = os.path.join(dirpath, filename)
        with open(path35b, encoding='utf8') as handle:
            for number, line35b in enumerate(handle, 1):
                if 'NSLog(' in line35b and not line35b.strip().startswith('//'):
                    bare_nslog.append('%s:%d' % (path35b, number))
if bare_nslog:
    fail('these call NSLog directly, so the line reaches Console.app but never the log a test is '
         'pulled from; use DebugLog.both(tag, message): ' + ', '.join(bare_nslog))
else:
    ok('every diagnostic goes through print or DebugLog.both, so a pulled log holds what a test is judged on')


# ---- 36. the web inspector is Debug-only ------------------------------------
#
# webView.isInspectable = true lets Safari's Web Inspector attach to the running
# app and run any script in the page — the whole bridge, the clipboard, the seed
# actions. In a Debug build that is the tool you develop with. Shipped, it would
# hand a script in the page to anyone with the unlocked phone and a Mac, without
# needing an exploit at all.
#
# It is fenced with #if DEBUG today. Check 22 catches a Debug-only *symbol* used
# outside DEBUG; nothing caught a Debug-only *capability* that someone unfences.
inspect = []
for path in swift_files:
    text36 = open(path, encoding='utf8').read()
    if 'isInspectable' not in text36:
        continue
    spans36 = debug_regions(text36)
    for m in re.finditer(r'\bisInspectable\s*=\s*(\w+)', text36):
        line36 = text36.count('\n', 0, m.start()) + 1
        if m.group(1) == 'false':
            continue                      # turning it off needs no fence
        if not any(a <= m.start() < b for a, b in spans36):
            inspect.append('%s:%d sets isInspectable = %s outside #if DEBUG' % (path, line36, m.group(1)))
if inspect:
    fail('the web inspector would attach to a Release build: ' + '; '.join(inspect))
else:
    ok('the web inspector attaches to Debug builds only')


# ---- 36b. nothing that moves money is answered from a cache ------------------
#
# A mint's info, keysets and keys are fetched again by every wallet object that
# talks to that mint, and a job builds several — nine and a half seconds of one
# move between mints went on re-learning two mints Foxy had just learned (seen
# in a device log). Those three answers are now kept for five minutes.
#
# What is checked here is the shape of that cache rather than its speed: it
# takes GETs only, of those three paths only, and it is read before the request
# is made and written only on a 2xx. A swap, a melt, a checkstate or a quote
# served from memory would be a wallet spending against keys the mint may no
# longer hold — or worse, believing a payment happened because it remembered
# the answer to one.
wallet36b = read32('build', 'wallet', '01-storage-and-piles.js')
native36b = read32('build', 'wallet', '22-screen-lock.js')
problems36b = []
if "KEY_PATH = /" not in wallet36b or r"\/v1\/(info|keysets|keys)" not in wallet36b:
    problems36b.append('the cache no longer names the three paths it is for')
guard36b = re.search(r'function cacheableKeyUrl\(method, url, circuit\) \{(.*?)\n  \}', wallet36b, re.S)
if not guard36b or "!== 'GET'" not in guard36b.group(1) or "return ''" not in guard36b.group(1):
    problems36b.append('the cache no longer refuses anything that is not a GET')
# The circuit is part of the key, so a question asked on a fresh circuit is
# never answered by what another circuit said. Without this the marking check
# (checkKeysetsElsewhere) compares an answer with itself and can never fail.
if not guard36b or "String(circuit" not in guard36b.group(1):
    problems36b.append('a remembered answer is no longer tied to the circuit that fetched it')
if 'KEY_TTL_MS = 300000' not in wallet36b:
    problems36b.append('the five minute limit on a remembered keyset is gone')
if 'localStorage' in (re.search(r'var keyBodies.*?function reserveBand', wallet36b, re.S) or
                      type('x', (), {'group': lambda *a: ''})()).group(0):
    problems36b.append('a mint key cache that outlives the launch: it is meant to be memory only')
ask36b = re.search(r'nativeRequest: function \(opts\) \{(.*?)\n    \},', native36b, re.S)
body36b = ask36b.group(1) if ask36b else ''
if 'cacheableKeyUrl(o.method, o.endpoint, o.foxyCircuit)' not in body36b:
    problems36b.append('nativeRequest no longer decides what may be cached from the method, the url and the circuit')
succ36b = re.search(r'if \(code >= 200 && code < 300\) \{(.*?)\n          return parsed;', body36b, re.S)
good36b = succ36b.group(1) if succ36b else ''
if 'if (keyUrl) rememberKeyBody' not in good36b or body36b.count('rememberKeyBody') != 1:
    problems36b.append('an answer is remembered other than on a 2xx')
# NUT-01: "hex strings of compressed public keys", and the spec ships two
# keysets it says a wallet should reject. cashu-ts takes both — Keyset.verify()
# hashes the key strings to check the id and never asks whether the bytes are a
# point on the curve — so Foxy asks here, on the one path every mint answer
# crosses, and before the answer is cached. Both halves: the shape, because an
# uncompressed key is a real point in a form NUT-01 does not allow, and the
# curve, because a well-shaped string need not be a point at all.
if not re.search(r'mintKeysProblem\(parsed\)[\s\S]{0,240}rememberKeyBody', good36b):
    problems36b.append('a mint\'s keys are no longer checked before they are believed')
if 'KEY_HEX = /^0[23][0-9a-f]{64}$/' not in wallet36b:
    problems36b.append('the compressed-key shape NUT-01 asks for is no longer checked')
if 'pointFromHex' not in wallet36b:
    problems36b.append('a mint key is no longer checked for being a point on the curve')
for problem in problems36b:
    fail('MINT KEYS: ' + problem)
if not problems36b:
    ok('a mint\'s keys are remembered for five minutes, per circuit; nothing that moves money is')

# ---- 37. a payment to another phone leaves through Tor's SOCKS port ----------
#
# OnionPost is a SOCKS5 client written by hand, because App Transport Security
# refuses plain http and plain http is what an onion address speaks. Nothing in
# URLSession's machinery is between it and the socket, so the two things that
# keep it on Tor are in this file and nowhere else: the guard that refuses
# unless Tor is running with a SOCKS port, and the fact that the only socket it
# opens is to that port on 127.0.0.1. A "fall back to a direct connection when
# Tor is down" here would resolve an onion name in the phone's DNS resolver
# and post a payment in the clear.
post_path = os.path.join('Foxy', 'Network', 'OnionPost.swift')
if not os.path.exists(post_path):
    fail('Foxy/Network/OnionPost.swift is gone: the check that a payment to another phone goes through Tor has nothing to read')
else:
    post_code = swift_code(open(post_path, encoding='utf8').read())
    post_guards = re.findall(r'guard\b(.*?)else\s*\{(.*?)\}', post_code, re.S)
    tor_guard = [(cond, body) for cond, body in post_guards
                 if 'TorService.isRunning' in cond and 'TorService.socksPort' in cond]
    onion_guard = [(cond, body) for cond, body in post_guards if 'OnionAddress.isHost' in cond]
    # every socket this file opens, and the port name each is given
    conn_lines = re.findall(r'NWConnection\(([^\n]*)', post_code)
    off_socks = []
    for args in conn_lines:
        port = re.search(r'port:\s*([A-Za-z_][A-Za-z0-9_.]*)', args)
        bound = port and re.search(r'let\s+' + re.escape(port.group(1))
                                   + r'\s*=\s*NWEndpoint\.Port\(rawValue:\s*TorService\.socksPort', post_code)
        if '"127.0.0.1"' not in args or not bound:
            off_socks.append(args.strip()[:80])
    # the half compiled when the Tor module is not there at all
    no_tor_half = re.search(r'#else(.*?)#endif', post_code, re.S)
    needs = [
        (tor_guard, 'OnionPost no longer refuses unless Tor is running with a SOCKS port '
                    '(the TorService.isRunning + TorService.socksPort guard is gone)'),
        (tor_guard and all('.noTor' in body for _cond, body in tor_guard),
         'the Tor guard in OnionPost no longer fails with .noTor: a payment could go out some other way'),
        (onion_guard and all('.notOnion' in body for _cond, body in onion_guard),
         'OnionPost no longer refuses a host that is not an onion address (OnionAddress.isHost)'),
        (conn_lines and not off_socks,
         'OnionPost opens a connection that is not Tor\'s SOCKS port on 127.0.0.1: ' + '; '.join(off_socks)[:160]),
        ('URLSession' not in post_code,
         'OnionPost makes a URLSession: a payment to an onion address must go through the SOCKS client, not around it'),
        (no_tor_half and '.noTor' in no_tor_half.group(1) and 'NWConnection' not in no_tor_half.group(1),
         'built without the Tor module, OnionPost no longer refuses outright: its #else half opens something'),
    ]
    broken = [msg for good, msg in needs if not good]
    if broken:
        for msg in broken:
            fail(msg)
    else:
        ok('a payment posted to another phone goes to Tor\'s SOCKS port on 127.0.0.1 and nowhere else: '
           'an onion address only, and no Tor means no payment')


# ---- 38. the one WebSocket Foxy opens is wss, through Tor ---------------------
#
# Route.startSocket is the only place a WebSocket is made natively (check 14
# keeps them out of the page). It publishes a NIP-59 gift wrap to a relay, and
# a socket is long-lived: one made outside Tor's SOCKS session would carry this
# phone's address to the relay for as long as the payment took. ws:// would
# hand the relay the wrap in the clear as well.
socket_fn = re.search(r'static func startSocket\(.*?\n    \}', swift_code(route_src), re.S)
socket_body = socket_fn.group(0) if socket_fn else ''
socket_guards = re.findall(r'guard\b(.*?)else\s*\{(.*?)\}', socket_body, re.S)
tasks_made = [p for p in swift_files if '.webSocketTask(' in swift_code(open(p, encoding='utf8').read())]
needs = [
    (socket_fn, 'Route.startSocket is gone: whatever opens a WebSocket now is not checked here'),
    (any('"wss"' in cond for cond, _body in socket_guards),
     'Route.startSocket no longer insists on wss: a relay socket could go out as ws, unencrypted'),
    (any('TorService.isRunning' in cond and 'nil' in body for cond, body in socket_guards),
     'Route.startSocket no longer returns nil when Tor is not running: a socket would open around Tor'),
    (re.search(r'TorService\.socksSession\(circuit:', socket_body),
     'Route.startSocket no longer makes its task on TorService.socksSession, so the socket bypasses Tor'),
    (re.search(r'#else\s*\n\s*return nil\s*\n\s*#endif', socket_body),
     'built without the Tor module, Route.startSocket no longer returns nil'),
    (tasks_made == [os.path.join('Foxy', 'Network', 'Route.swift')],
     'a WebSocket task is made outside Route.startSocket, where nothing puts it on Tor: ' + ', '.join(tasks_made)),
]
broken = [msg for good, msg in needs if not good]
if broken:
    for msg in broken:
        fail(msg)
else:
    ok('the only WebSocket the app opens is wss, on Tor\'s SOCKS session, and nil while Tor is not running')


# ---- 39. the Nostr gift wrap is published through that socket and no other ----
#
# NostrDelivery hands a relay an encrypted payment addressed to the receiver.
# The relay must learn nothing else — least of all where this phone is — so it
# has no session, no socket and no request of its own: it asks Route.startSocket
# for one, and takes nil for an answer.
nostr_path = os.path.join('Foxy', 'Nostr', 'NostrDelivery.swift')
if not os.path.exists(nostr_path):
    fail('Foxy/Nostr/NostrDelivery.swift is gone: the check that a gift wrap is published over Tor has nothing to read')
else:
    nostr_code = swift_code(open(nostr_path, encoding='utf8').read())
    relays_fn = re.search(r'static func relays\(.*?\n    \}', nostr_code, re.S)
    named = re.findall(r'"([a-z]+://[^"]*)"', nostr_code)
    needs = [
        (re.search(r'Route\.startSocket\(', nostr_code),
         'NostrDelivery no longer publishes through Route.startSocket, the one socket that goes over Tor'),
        (re.search(r'guard let \w+ = Route\.startSocket\(.*?\)\s*else', nostr_code, re.S),
         'NostrDelivery no longer stops when Route.startSocket returns nil: it would go on without Tor'),
        ('URLSession(' not in nostr_code,
         'NostrDelivery makes a URLSession of its own: it would reach a relay outside Tor'),
        ('.webSocketTask(' not in nostr_code and 'NWConnection' not in nostr_code and '.dataTask(' not in nostr_code,
         'NostrDelivery opens a connection of its own instead of asking Route.startSocket for one'),
        ('ws://' not in nostr_code, 'NostrDelivery names a ws:// relay: the wrap would go to it unencrypted'),
        (relays_fn and 'url.scheme == "wss"' in relays_fn.group(0),
         'NostrDelivery.relays no longer keeps only wss relays, so a request could name ws:// or http://'),
        (named and all(n.startswith('wss://') for n in named),
         'a relay Foxy falls back to is not wss: ' + ', '.join(n for n in named if not n.startswith('wss://'))[:120]),
    ]
    broken = [msg for good, msg in needs if not good]
    if broken:
        for msg in broken:
            fail(msg)
    else:
        ok('the Nostr gift wrap goes out only through Route.startSocket, to wss relays: no session, socket or '
           'ws:// of its own')


# ---- 40. the inbox listens on loopback, behind a secret path, and is closed ---
#
# OnionInbox is the only thing in Foxy that listens. Tor forwards the onion's
# port 80 to it, so it binds to 127.0.0.1 and nothing off the phone can reach
# it directly; every other app on the phone can reach a loopback port, though,
# which is why the path carries 128 random bits and anything else is answered
# 404 before a byte of body is read. The caps keep a payer from spending this
# phone's memory, and close() must take the address down with the listener, or
# an address for a request that is gone stays published.
inbox_path = os.path.join('Foxy', 'Network', 'OnionInbox.swift')
if not os.path.exists(inbox_path):
    fail('Foxy/Network/OnionInbox.swift is gone: the check on what Foxy listens to has nothing to read')
else:
    inbox_src = open(inbox_path, encoding='utf8').read()
    inbox_code = swift_code(inbox_src)
    close_fn = re.search(r'func close\(\) \{(.*?)\n    \}', inbox_code, re.S)
    parse_fn = re.search(r'static func parse\(.*?\n    \}', inbox_code, re.S)
    parse_body = parse_fn.group(0) if parse_fn else ''
    listeners = re.findall(r'NWListener\(([^\n]*)', inbox_code)

    def size(name):
        m = re.search(r'let ' + name + r'\s*=\s*([0-9 *+]+)', inbox_code)
        try:
            return eval(m.group(1), {'__builtins__': {}}, {}) if m else None
        except Exception:
            return None
    payment_cap, head_cap = size('largestPayment'), size('largestHead')
    needs = [
        (re.search(r'requiredLocalEndpoint\s*=\s*\.hostPort\(host:\s*"127\.0\.0\.1"', inbox_code),
         'the inbox no longer binds to 127.0.0.1 with params.requiredLocalEndpoint: it would listen on the network'),
        (listeners and all('params' in args for args in listeners),
         'the inbox listener is made without those parameters: ' + '; '.join(listeners)[:120]),
        (re.search(r'path\s*=\s*"/"\s*\+\s*MintCircuit\.label\(', inbox_code),
         'the inbox path is no longer MintCircuit.label: any app on the phone could reach it by port alone'),
        (re.search(r'SecRandomCopyBytes', route_src) and re.search(r'static func label\(', route_src),
         'MintCircuit.label no longer draws random bytes, so the inbox path could be guessed'),
        (re.search(r'==\s*path\s*else\s*\{\s*return \.refuse\(404\)', parse_body),
         'a request that does not carry the secret path is no longer answered 404 unread'),
        (re.search(r'largestHead:\s*Self\.largestHead', inbox_code)
         and re.search(r'largestBody:\s*Self\.largestPayment', inbox_code),
         'the inbox no longer hands its size caps to HTTPRequestHead.parse'),
        (re.search(r'>\s*largestHead[^\n]*\.refuse\(413\)', parse_body) and re.search(r'<=\s*largestHead', parse_body),
         'HTTPRequestHead.parse no longer refuses a head larger than largestHead, whole or still arriving'),
        (re.search(r'<=\s*largestBody[^\n]*\.refuse\(413\)', parse_body),
         'HTTPRequestHead.parse no longer refuses a body larger than largestPayment'),
        (payment_cap and head_cap and payment_cap <= 1024 * 1024 and head_cap <= 64 * 1024,
         'the inbox size caps are gone or no longer small: largestPayment %s, largestHead %s'
         % (payment_cap, head_cap)),
        (close_fn and 'removeOnion' in close_fn.group(1),
         'close() no longer takes the onion address down: an address for a request that is over stays published'),
        (close_fn and re.search(r'listener\??\.cancel\(\)', close_fn.group(1)),
         'close() no longer cancels the listener: the port stays open after the request is gone'),
        # and it goes when Foxy does: Tor leaves the network in the background,
        # so an address that cannot be served must not stay published, pointing
        # at a listener iOS may have taken away
        (re.search(r'closeInboxForBackground\(\)', swift_code(open(os.path.join(
            'Foxy', 'FoxyWebView.swift'), encoding='utf8').read())),
         'the app no longer ends the onion address when it goes to the background'),
        # the body alone: `inbox?.close()` appears in handleInboxClose too, and a
        # window big enough to reach it would pass however this one was written
        (re.search(r'inbox\?\.close\(\)', (re.search(
            r'func closeInboxForBackground\(\).*?(?=\n    (?:@objc )?(?:private )?func )',
            swift_code(open(os.path.join('Foxy', 'Bridge', 'FoxyBridge+Delivery.swift'),
                            encoding='utf8').read()), re.S) or re.match('', '')).group(0)),
         'closeInboxForBackground no longer closes the inbox'),
        ('inboxWake' in open(os.path.join('build', 'app', '12-receive.js'), encoding='utf8').read(),
         'the page no longer forgets the address it was given when Foxy comes back'),
    ]
    broken = [msg for good, msg in needs if not good]
    if broken:
        for msg in broken:
            fail(msg)
    else:
        ok('the inbox listens on 127.0.0.1 behind a random path, refuses anything past its caps unread, '
           'and closing it ends both the address and the listener')

# ---- 40b. the spare address costs no more privacy than the one it replaces ----
#
# An address is kept warm so a payer finds it first time instead of retrying
# while Tor publishes it. That is only free of privacy cost while three things
# hold: every address is a fresh key Tor never hands back, so none of them is an
# identity; handing one out replaces it, so two payers never share one; and
# leaving the foreground takes the spare down with the rest, so this phone is
# not quietly listening while it is in someone's pocket.
deliv_path = os.path.join('Foxy', 'Bridge', 'FoxyBridge+Delivery.swift')
tor_path = os.path.join('Foxy', 'Tor', 'TorService.swift')
if not (os.path.exists(deliv_path) and os.path.exists(tor_path)):
    fail('the delivery or Tor source is gone: the check on the warm address has nothing to read')
else:
    deliv = swift_code(open(deliv_path, encoding='utf8').read())
    torsrc = swift_code(open(tor_path, encoding='utf8').read())
    warm = re.search(r'func warmSpare\(\) \{(.*?)\n    \}', deliv, re.S)
    openfn = re.search(r'func handleInboxOpen\(id: String, body: \[String: Any\]\) \{(.*?)\n    \}', deliv, re.S)
    bg = re.search(r'func closeInboxForBackground\(\) \{(.*?)\n    \}', deliv, re.S)
    closefn = re.search(r'func handleInboxClose\(id: String, body: \[String: Any\]\) \{(.*?)\n    \}', deliv, re.S)
    post = re.search(r'func handleOnionPost\(id: String, body: \[String: Any\]\) \{(.*?)\n    \}', deliv, re.S)
    deliv_js = open(os.path.join('build', 'wallet', '07-request-delivery.js'), encoding='utf8').read()
    needs = [
        (warm is not None, 'warmSpare is gone: nothing opens an address before it is wanted'),
        (bool(warm) and 'TorService.isRunning' in warm.group(1),
         'an address is warmed without checking Tor is up'),
        (bool(openfn) and 'spareInbox = nil' in openfn.group(1),
         'the warm address is handed out without being given up, so two payers could share one'),
        (bool(openfn) and 'warmSpare()' in openfn.group(1),
         'handing out the warm address does not start the next one'),
        (bool(bg) and 'spareInbox?.close()' in bg.group(1) and 'spareInbox = nil' in bg.group(1),
         'the spare address outlives the foreground: the phone would listen while it is away'),
        ('NEW:ED25519-V3' in torsrc and 'DiscardPK' in torsrc,
         'an onion address is no longer a fresh key Tor keeps to itself (NEW:ED25519-V3, DiscardPK)'),
        ('ONION_RETRY_MS = 1500' in deliv_js,
         'the retry on an address that is not published yet is no longer 1.5s'),
        # A payment can be on the wire towards an address the screen has
        # finished with — the tap that falls back to the onion is exactly that.
        # Closed at once, the payer's Tor spends its own 120-second ceiling
        # discovering a service whose descriptor is still cached where it was
        # published (120893 ms, then 130714 ms).
        # So a used address retires rather than closing, and the hold ends it.
        (bool(closefn) and 'retiringInboxes.append(going)' in closefn.group(1),
         'an address the screen is done with is destroyed at once, so a payment '
         'already on its way to it spends two minutes failing'),
        (bool(closefn) and 'asyncAfter' in closefn.group(1) and 'going.close()' in closefn.group(1),
         'a retired address is never closed, so this phone listens for ever'),
        (bool(closefn) and 'warmSpare()' in closefn.group(1),
         'closing does not start the next address, so the next screen waits on Tor'),
        (bool(bg) and 'retiringInboxes.forEach { $0.close() }' in bg.group(1)
         and 'retiringInboxes.removeAll()' in bg.group(1),
         'a retired address outlives the foreground: the phone would listen while it is away'),
        # The budget bounds the attempt, not only the gap between attempts.
        # OnionPost's own default is 120 s, which is Tor's SocksTimeout.
        ('ONION_REACH_MS = 30000' in deliv_js,
         'the whole budget for reaching an onion is no longer 30s'),
        ('timeout: left' in deliv_js,
         'an attempt is no longer bounded by what is left of the budget, so one '
         'attempt can outlast the budget entirely'),
        (bool(post) and 'timeout: ceiling' in post.group(1),
         'the phone no longer takes a ceiling from the page for a single post'),
        # Tor maps every onion-side failure onto SOCKS reply 4, so a descriptor
        # that was never published cannot be told from one that is stale.
        ('ExtendedErrors' in torsrc,
         'Tor is no longer asked for extended SOCKS errors, so every onion '
         'failure reads the same in the log'),
    ]
    broken = [msg for good, msg in needs if not good]
    if broken:
        for msg in broken:
            fail('WARM ADDRESS: ' + msg)
    else:
        ok('an address is published before it is wanted, given to one payer only, and gone when Foxy is')

# ---- 40c. an amount from cashu-ts is never coerced numerically ---------------
#
# cashu-ts 4.11.0 backs amounts with `Amount`, a BigInt wrapper whose
# `Symbol.toPrimitive` warns "implicit numeric coercion is deprecated" and
# **throws in cashu-ts v5**. The warning turned up once per payment.
# Fifty sites in the wallet were coercing one.
#
# They all go through `satsOf` now, which asks for `toNumber()` first and falls
# back to the string form - neither of which is deprecated - and answers 0
# rather than NaN, because a NaN loose in an amount is a silent wrong total.
# What is checked here is that nothing has gone back to `Number(x.amount)`:
# that is the shape that breaks, and it breaks on a bump, far from the edit.
wallet40c = ''
for f in sorted(os.listdir(os.path.join('build', 'wallet'))):
    if f.endswith('.js'):
        wallet40c += read32('build', 'wallet', f) + '\n'
sats40c = re.search(r'function satsOf\(value\) \{(.*?)\n  \}', wallet40c, re.S)
coerced40c = re.findall(r'Number\((?!String\()[A-Za-z_$][A-Za-z0-9_$.\[\]]*\.'
                        r'(?:amount|fee_reserve|feeReserve|min_amount|max_amount|input_fee_ppk)\b',
                        wallet40c)
problems40c = []
if not sats40c or 'toNumber' not in sats40c.group(1):
    problems40c.append('satsOf no longer prefers toNumber(), the one cashu-ts names as the replacement')
if not sats40c or 'isFinite' not in sats40c.group(1):
    problems40c.append('satsOf can answer NaN again: a NaN in an amount is a silent wrong total')
if coerced40c:
    problems40c.append('an amount is coerced with Number() again, which throws in cashu-ts v5: '
                       + ', '.join(sorted(set(coerced40c))[:3]))
for problem in problems40c:
    fail('AMOUNTS: ' + problem)
if not problems40c:
    ok('an amount from cashu-ts is read through satsOf, never coerced with Number()')

# ---- 41. the page tells you which page it is ---------------------------------
#
# verify-shipped.sh and verify-vendor.py both look at the repository. The one
# thing that reaches the user's hand is the number the drawer shows: the app
# hashes the files it staged and `python3 tools/page-hash.py` prints the same
# string from the tree. Each link is one line of code, and each would be easy to
# lose in a tidy-up — a hash computed but never told to the page, a footer
# dropped from the drawer as decoration, a rule that drifted on one side only —
# and losing any of them leaves a number on the screen that proves nothing, or
# no number at all, with nothing else failing.
wv41 = swift_code(open(os.path.join('Foxy', 'FoxyWebView.swift'), encoding='utf8').read())
stage41 = re.search(r'func stageWebFiles\(\).*?\n    \}', wv41, re.S)
stage41 = stage41.group(0) if stage41 else ''
hash41 = re.search(r'static func manifestHash\(of dir: URL\) -> String \{.*?\n    \}', wv41, re.S)
hash41 = hash41.group(0) if hash41 else ''
load41 = re.search(r'private func load\(\) \{.*?\n    \}', wv41, re.S)
load41 = load41.group(0) if load41 else ''
tool41 = os.path.join('tools', 'page-hash.py')
vals41 = open(os.path.join('build', 'app', '21-render-values.js'), encoding='utf8').read()
needs = [
    (hash41, 'FoxyWebView.manifestHash is gone: nothing on the phone hashes the page it is running'),
    # it must hash the folder it just staged, not the bundle it copied from: a
    # hash of the source would match the tool while the staged page differed
    (re.search(r'Self\.manifestHash\(of: dir\)', stage41),
     'stageWebFiles no longer hashes the folder it staged, so the number would not cover what the web view loads'),
    (re.search(r'Self\.pageHash\s*=', stage41) and 'page hash' in stage41,
     'the page hash is no longer kept or logged at staging'),
    # the rule, on the Swift side: dot files out, sorted by name as bytes, the
    # line shasum prints. tools/page-hash.py follows the same rule in prose;
    # if either side drifts the two numbers stop meaning the same thing.
    (re.search(r'hasPrefix\("\."\)', hash41) and re.search(r'lexicographicallyPrecedes', hash41)
     and re.search(r'\\\(digest\)  \\\(name\)', hash41),
     'the manifest rule changed in Swift (dot files left out, sorted by name as bytes, "<sha256>  <name>" per line): '
     'tools/page-hash.py would print a different number'),
    (re.search(r'guard !lines\.isEmpty else \{ return "" \}', hash41),
     'an unreadable or empty staged folder now produces a real-looking hash of nothing'),
    # and the page has to be told, before its own script runs
    (re.search(r'__foxyPageHash', load41) and re.search(r'injectionTime: \.atDocumentStart', load41),
     'the page is no longer told its hash at document start: the drawer would have nothing to show'),
    ('__foxyPageHash' in vals41 and 'pageHash' in vals41,
     '21-render-values.js no longer reads window.__foxyPageHash'),
    ('{{ pageHash }}' in markup, 'the drawer no longer shows the page hash'),
    (os.path.exists(tool41), 'tools/page-hash.py is gone: nothing prints the number to compare with'),
]
broken = [msg for good, msg in needs if not good]
if broken:
    for msg in broken:
        fail(msg)
else:
    ok('the staged page is hashed, logged and handed to the drawer; tools/page-hash.py is there to compare with')


# ---- 42. tap to pay: the two sides of the bridge agree on the words ---------
#
# The native side answers tapPayStart with JSON and the wallet reads it. When
# the offer grew a payment-request half, the answer's key was renamed from
# `invoice` to `payload` on the Swift side and the check in the wallet was
# left reading the old name — so every tap reached "payload received and nonce
# accepted" and was thrown away one line later with "Nothing usable came over
# Bluetooth". Nothing failed: the action still existed, the matrix still
# matched, the tests still passed, and tap to pay simply stopped working.
tap42 = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge+Tap.swift'), encoding='utf8').read()
wal42 = open(os.path.join('build', 'wallet', '21-native-bridges.js'), encoding='utf8').read()
if tap42 and wal42:
    answers42 = set(re.findall(r'\\"([a-z]+)\\":" \+ Self\.literalStatic', tap42))
    asks42 = set(re.findall(r'got\.([a-z]+)', wal42))
    sends42 = set(re.findall(r"bridgeAsk\('tapReceiveStart', \{ ([a-z]+):", wal42))
    takes42 = set(re.findall(r'body\["([a-z]+)"\] as\? String', tap42))
    bad42 = []
    if not answers42 <= asks42:
        bad42.append('the native side answers tapPayStart with %s and the wallet reads %s'
                     % (sorted(answers42), sorted(asks42)))
    if not sends42 <= takes42:
        bad42.append('the wallet sends tapReceiveStart %s and the native side reads %s'
                     % (sorted(sends42), sorted(takes42)))
    if bad42:
        for m in bad42:
            fail(m)
    else:
        ok('tap to pay: both sides of the bridge use the same words (%s)'
           % ', '.join(sorted(answers42 | sends42)))

# ---- 43. tap to pay: nothing goes on the air that was not asked to --------
#
# The receiver advertises and the payer listens (TapLink.swift's header has the
# argument). Which side is on the air has been both ways round, and either is
# defensible; what is not is a phone that goes on the air without being told
# to. A peripheral hands whoever connects everything iOS serves — battery
# level, model, very likely its owner's name — so the rule is the same however
# the roles sit: advertising happens on a press, for one payment, and stops.
#
# That is the clause that rots. It rotted once the other way round, when the
# page armed the payer from home as well and Foxy open on the home screen was
# a broadcast. Now the receive screen is the one that could
# do it — an invoice is up for minutes at a time — so what is checked is that
# `advertise()` cannot run unarmed, that only the button arms it, and that the
# listening side has no way to advertise at all.
tap43 = open(os.path.join('Foxy', 'Bluetooth', 'TapLink.swift'), encoding='utf8').read()
recv43 = tap43[tap43.index('final class TapReceiver'):tap43.index('final class TapPayer')]
pay43 = tap43[tap43.index('final class TapPayer'):]
bad43 = []
# the listening side cannot go on the air at all
if 'CBPeripheralManager' in pay43:
    bad43.append('the paying phone has a peripheral manager: it can go on the air')
if 'startAdvertising' in pay43:
    bad43.append('the paying phone advertises')
# and the advertising side only on a press
if not re.search(r'private func advertise\(\) \{\s*\n\s*guard armed,', recv43):
    bad43.append('the receiver advertises without being armed')
if 'func arm()' not in recv43:
    bad43.append('there is no way to arm the receiver')
# one payer per payment, and off the air the moment one is really there
if 'talkingTo == nil || talkingTo == central.identifier' not in recv43:
    bad43.append('a second phone can join a handshake already under way')
if 'insufficientAuthorization' not in recv43:
    bad43.append('writes from a phone that is not the one talking are not refused')
sub43 = re.search(r'didSubscribeTo characteristic: CBCharacteristic\) \{(.*?)\n    \}', recv43, re.S)
if not sub43 or 'stopAdvertising' not in sub43.group(1):
    bad43.append('the receiver stays on the air after a payer has subscribed, so a second '
                 'phone can still find it')
# a payment is refused for being a second payment, never for a clock that is
# running: M9 starts the same clock before any money has come, and a receiver
# that had agreed a price dropped the payment unread
pay_case43 = re.search(r'case \.payment\(let text\):(.*?)onPaid\(text\)', recv43, re.S)
if not pay_case43 or not re.search(r'guard !resultSent, !paymentHeard else', pay_case43.group(1)) \
        or re.search(r'guard[^\n]*resultTimer == nil', pay_case43.group(1)):
    bad43.append('a payment is turned away while the asking clock runs, so one that '
                 'follows an agreed price never reaches the page')
# one receiver is one payment's worth of radio: its UUID and keys are settled
# once, so pressing TAP again has to build another
if 'var takenOne: Bool' not in recv43:
    bad43.append('nothing says a receiver has had its payer, so TAP would re-arm the same UUID')
# and it means the offer went out, not that the keys agreed: arming before the
# QR is ready puts the offer *after* the handshake, so `linked` there retired
# the very receiver the offer was for
if not re.search(r'var takenOne: Bool \{ offerSent \}', recv43):
    bad43.append('a receiver counts as spent before it has handed over an offer, so an offer '
                 'that follows the handshake retires the link it was meant for')
# a link opened before the verdict must stay silent until the verdict: the
# subscribe is the first thing the receiver can hear, and it goes through speak()
if 'setNotifyValue' in pay43:
    for m in re.finditer(r'setNotifyValue', pay43):
        head = pay43[:m.start()]
        fn = head.rfind('private func ')
        # the handshake's door only from speak(); the third door, which carries
        # nothing and only says "a payer is near", only from announce()
        if fn < 0 or not (pay43[fn:fn + 40].startswith('private func speak(')
                          or pay43[fn:fn + 40].startswith('private func announce(')):
            bad43.append('the payer subscribes from somewhere other than speak(), '
                         'so a warm link could talk before the verdict')
            break
# `warm()`'s own guard, not any `target == nil` anywhere in the file: the one
# in `didDiscover` was removed because it starved the
# advertisement pool the verdict is taken on, and this check happily accepted
# that one in its place.
warm43 = re.search(r'private func warm\(at now: TimeInterval\) \{(.*?)\n    \}', pay43, re.S)
if not warm43 or 'target == nil' not in warm43.group(1):
    bad43.append('the warm link can be opened over one that already exists')
# and the pool keeps being fed while one is open, or the verdict has only the
# link's own readings to go on and a phone held against another is refused
disc43 = re.search(r'func centralManager\(_ c: CBCentralManager, didDiscover(.*?)\n    \}', pay43, re.S)
if disc43 and 'guard target == nil' in disc43.group(1):
    bad43.append('advertisements stop being recorded once a link is warm, so the verdict '
                 'loses the scale it was calibrated on')
# a payment on the wire outlives the screen that was showing it
if 'var busy: Bool' not in recv43 or 'func stop(whenIdle' not in recv43:
    bad43.append('the listen can be ended while a payment is still crossing')
tap43bridge = open(os.path.join('Foxy', 'Bridge', 'FoxyBridge+Tap.swift'), encoding='utf8').read()
# that one handler's own body, not everything after it
m43 = re.search(r'func handleTapReceiveStop\(.*?\n    \}', tap43bridge, re.S)
if not m43 or 'stop {' not in m43.group(0):
    bad43.append('tapReceiveStop drops the receiver without asking whether a payment is crossing')
if 'r.busy' not in tap43bridge:
    bad43.append('pressing TAP again would tear down a payment still crossing')
# and the page goes on the air only from the button
tap43page = open(os.path.join('build', 'app', '26d-tap.js'), encoding='utf8').read()
if 'const armed = !!(asking && s.tapArmed);' not in tap43page:
    bad43.append('the page advertises from something other than the TAP button')
# exactly one door, and the branch it sits in is the armed one
calls43 = [m.start() for m in re.finditer(r'W\.tapReceive\(', tap43page)]
if len(calls43) != 1:
    bad43.append('the page has %d ways to put an offer on the air; there is meant to be one'
                 % len(calls43))
else:
    # and it sits inside the armed branch, not merely near it
    armed43 = re.search(r'\n    if \(advertise && [^\n]*\{(.*?)\n    \} else', tap43page, re.S)
    if not armed43 or 'W.tapReceive(' not in armed43.group(1):
        bad43.append('the page puts an offer on the air outside the `advertise` branch')
if bad43:
    for m in bad43:
        fail(m)
else:
    ok('tap to pay: the paying phone only listens, and the receiver is on the air only when TAP is pressed')

print()
if skipped:
    # said on its own line, just above the verdict, so check-all's last three lines show it
    print('%d check(s) skipped, not passed (%s): what they compare is not built here'
          % (len(skipped), ', '.join(skipped)))
if problems:
    print('%d problem(s) — do not build' % len(problems))
    sys.exit(1)
print('clean — build it' + (' (%d skipped)' % len(skipped) if skipped else ''))
