#!/usr/bin/env python3
"""
verify-vendor.py — check the vendored libraries are what Web/VENDOR.md says.

    python3 tools/verify-vendor.py                     offline
    python3 tools/verify-vendor.py --network           and each library against its public release
    python3 tools/verify-vendor.py --deep              and rebuilt from source where a script can
    python3 tools/verify-vendor.py --deep --tor-rebuild --iptproxy   and Tor and IPtProxy rebuilt

Offline, none of which needs the network:

  the SHA-256 and size of each file
  that each bundle still declares the global the app expects
  that the BIP-39 English wordlist is unchanged, word for word
  the fonts, images and icons that ship, and the files only tests use
  (tools/acorn, tests/reference/dc-runtime.js), each by size and SHA-256

What each network mode proves is in AUDIT.md's table and Web/VENDOR.md:

  --network      verify-cashu-ts.sh, verify-bip39.sh, verify-qrcode.sh,
                 verify-react.sh, verify-tor.sh and verify-secp256k1.sh, each
                 without flags: npm or git against the shipped bytes, the bundles
                 rebuilt from npm tarballs, Tor's sources and signatures,
                 libsecp256k1's signed tag against Vendor/secp256k1 file by file
  --deep         the same, with verify-cashu-ts.sh --from-source,
                 verify-bip39.sh --from-source and verify-react.sh --rebuild:
                 every bundled file rebuilt from its git tag, React and
                 ReactDOM from React's signed tag. qrcode.js has no build to
                 rerun. Implies --network.
  --tor-rebuild  verify-tor.sh --rebuild: Tor rebuilt and compared with
                 Vendor/Tor.sha256. Separate, because it takes hours and only
                 matches with the recorded Xcode (26.3, 17C529); tor.yml runs it
  --iptproxy     verify-iptproxy.sh: two Go builds against Vendor/IPtProxy.sha256

The wordlist check is the one that matters. A substituted or reordered wordlist
produces seeds that pass every validation and are not the seeds the user wrote
down. It is compared against a hash of the canonical 2048 words rather than
against a copy shipped alongside it, so tampering with both would not help.

Exits non-zero on any mismatch.
"""

import hashlib, re, sys, os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(HERE, 'Web')

EXPECTED = {
    'cashu-ts.js': (270256,
                    '34c1bdabdbb6440ce8d9b18291b95ac8515ec54737d8e17a12e0d43451553d2e',
                    'var CashuTS='),
    'bip39.js': (30942,
                 '6a32952398760a90536a33a836e533273251ec3ef334de8bb2ec0c1993a4dc92',
                 'var FoxyBip39='),
    'qrcode.js': (56694,
                  '79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c',
                  'QR Code Generator'),
}

# sha256 of the 2048 canonical BIP-39 English words, joined by newlines
WORDLIST_SHA = '187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae'

# Fonts, images and icons that ship, and third-party files only the tests use.
# They carry no code the wallet runs, but each is pinned, so a swapped file is a
# visible change; Web/VENDOR.md ("Fonts, images and icons") says what each is,
# where it came from and under what licence (audit finding A1). The shell's
# assets are also pinned, decoded from the page, by tools/verify-shipped.sh.
# A binary in Web/ or build/shell/assets that is not listed here fails.
ASSETS = {
    'Web/satsymbol.woff2':      (396,     'eb0caa7147f0269e63d43201b3a5242ab178a21b09ee5e9c8b5fef595a48e460'),
    'Web/snow-fur.jpg':         (67431,   'cebafa00a3787400f265c5b427f4219a24dd8edbcfff7ab40c11fd81a4e7b22d'),
    'Web/risk-grain.jpg':       (131515,  '3798d85f020e99b2d5b8306324d7636d0fcf51548fcada742ccb0b92bc96eab5'),
    'Web/foxy-intro.mp4':       (976087,  '2c3ef790193cc6dd179f2fed3c4707fe140d2d863208ec1bc353eb3439e6025c'),
    'Web/foxy-intro-last.png':  (71955,   '137a597ceaad06f1e22817d037b390973e38e03b5869b08f625d8949cedcd725'),
    'Web/foxy-splash-still.png': (61988,  'd21b711786d81aa20cb79b3aa823178230eb66b71fceb7478da12c6af6626144'),
    'Web/foxy-sheet.webp':      (1751366, 'fb38cb859810c60efda24f7f1e4ce3c49b321fcd85dc13fcd3cafd2d1b4c10a9'),
    'Web/foxy-fur.webp':        (65776,   'b9a1c1e11785c5a45a58e6098418e16ee01afaefadc1b3e109ecf3a6e26d4684'),
    'Web/gd-cashapp.jpg':    (7489, '5a5a80358e280999bdb2bf3337c806669a9c04198756024efa819cac38a56b56'),
    'Web/gd-strike.jpg':     (7889, 'b74180a13af2ab7c9d010a7390c25f90ad7579bb8945353582b402f012a668b0'),
    'Web/gd-river.jpg':      (11207, 'abb80efc41313717d7136e66cbbda99255d09f71bf8f01dbc88c7401937bedee'),
    'Web/gd-flash.jpg':      (8530, 'e07ffc030a1dc9cebbadc668c9ad3e89bf6c88d358deb563f9ed9e0b67db7cfb'),
    'Web/foxy-rider.webp':      (1413094, '794795b5a020057774e85d1eb80c8ba25944b609beeae3eb5da0f6e540f0c2ec'),
    'build/shell/assets/font-94600041.woff2': (33672, 'd2909123a6a8ed2f928055f002c32f63ee93496b470c1a344873f955111fca53'),
    'build/shell/assets/font-ad30d34a.woff2': (15556, 'df4fca18912e29202b16286ab514798de8357c416b5e1f2dd31703994bec7a78'),
    'build/shell/assets/font-ccd2d25b.woff2': (20184, '8330490a01c60c196eae00b823de8102275aaa5862e7b76a7af21b8745338928'),
    'build/shell/assets/font-ef48d7d8.woff2': (10228, 'f153aa07c1b16fbb12391c2512860c97819a0a9fd014f338b2b3f12496479d13'),
    'build/shell/assets/icon-bolt.svg':       (1647,  '9c84c033a7279c6688c675d114c600873d8c59936674b0e3813e77b87fdd9fde'),
    'build/shell/assets/icon-0e7a9336.svg':   (1639,  '6c38e984fed9b05103a0319727fbdb39584d78d7f92456ee9fc2af07c84b4d98'),
    # test-only: the design-tool runtime render-parity.js compares against
    'tests/reference/dc-runtime.js':          (68278, '7d5ae886f08efc2dc5da41b682607a60b180710bcf61e594ce4dfcd67c76355d'),
    # test-only: acorn 8.18.0 (MIT), which tools/check-undefined.js parses the app with.
    # The package's own README.md and CHANGELOG.md are not kept here: nothing reads them.
    'tools/acorn/LICENSE':          (1099,   '76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7'),
    'tools/acorn/bin/acorn':        (60,     '4c3eb6f1d8932790dbff043839f8ee7686bc614a59ef577e96fed618a4a4b1b8'),
    'tools/acorn/dist/acorn.d.mts': (22462,  'df8107deaf41869871690db7306f87b587e59660d659b1fbb64a7a30cea7cf36'),
    'tools/acorn/dist/acorn.d.ts':  (22462,  'df8107deaf41869871690db7306f87b587e59660d659b1fbb64a7a30cea7cf36'),
    'tools/acorn/dist/acorn.js':    (245232, 'fc3ed7b81e58464715d0291402892f22c3d86ea75302645a330390f85d8015c9'),
    'tools/acorn/dist/acorn.mjs':   (233301, '953573b8fdab71599749ea5f2b33d3e760c2116178f9423ee7458dbe39d59453'),
    'tools/acorn/dist/bin.js':      (3329,   'fffd9df1d9158c4580068ad17c3176c34fe46f59021b8cd5780454994764dc30'),
    'tools/acorn/package.json':     (1067,   '5c1ed7259579a7899b303f514b0194adcb9fe474fc7d136a84c6a45f10eefc84'),
}
BINARY = ('.webp', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf')

fail = 0

args = sys.argv[1:]
unknown = [a for a in args if a not in ('--network', '--deep', '--tor-rebuild', '--iptproxy')]
if unknown:
    sys.exit('usage: python3 tools/verify-vendor.py [--network] [--deep] [--tor-rebuild] [--iptproxy]; unknown: %s'
             % ' '.join(unknown))

bad_assets = []
for rel, (size, digest) in sorted(ASSETS.items()):
    path = os.path.join(HERE, rel)
    raw = open(path, 'rb').read() if os.path.isfile(path) else None
    if raw is None or len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
        bad_assets.append('%s (%s)' % (rel, 'missing' if raw is None else '%d bytes, sha256 %s' % (len(raw), hashlib.sha256(raw).hexdigest()[:16])))
unlisted = []
for folder in ('Web', os.path.join('build', 'shell', 'assets')):
    for n in sorted(os.listdir(os.path.join(HERE, folder))):
        if n.lower().endswith(BINARY) and os.path.join(folder, n) not in ASSETS:
            unlisted.append(os.path.join(folder, n))
for d, _, names in os.walk(os.path.join(HERE, 'tools', 'acorn')):
    for n in names:
        rel = os.path.relpath(os.path.join(d, n), HERE)
        if rel not in ASSETS and n != '.DS_Store':
            unlisted.append(rel)
if bad_assets or unlisted:
    for b in bad_assets:
        print('FAIL asset %s differs from its pin' % b)
    for u in unlisted:
        print('FAIL asset %s is not pinned in tools/verify-vendor.py (nor described in Web/VENDOR.md)' % u)
    fail += len(bad_assets) + len(unlisted)
else:
    print('ok   assets         %d fonts, images, icons and test-only files pinned' % len(ASSETS))

for name, (size, digest, marker) in sorted(EXPECTED.items()):
    path = os.path.join(WEB, name)
    if not os.path.exists(path):
        print('MISSING  %s' % name)
        fail += 1
        continue
    raw = open(path, 'rb').read()
    got = hashlib.sha256(raw).hexdigest()
    text = raw.decode('utf8', 'replace')
    ok = True
    if len(raw) != size:
        print('SIZE     %s: %d, expected %d' % (name, len(raw), size))
        ok = False
    if got != digest:
        print('SHA256   %s:' % name)
        print('           got      %s' % got)
        print('           expected %s' % digest)
        ok = False
    if marker not in text:
        print('GLOBAL   %s: expected to declare %r' % (name, marker))
        ok = False
    print('%-4s %-14s %s' % ('ok' if ok else 'FAIL', name, got[:32]))
    fail += 0 if ok else 1

# the wordlist, word for word
bip = os.path.join(WEB, 'bip39.js')
if os.path.exists(bip):
    text = open(bip, encoding='utf8', errors='replace').read()
    m = re.search(r'abandon.{0,200000}?zoo', text, re.S)
    words = re.findall(r'[a-z]{3,8}', m.group(0)) if m else []
    got = hashlib.sha256('\n'.join(words).encode()).hexdigest()
    if len(words) != 2048 or got != WORDLIST_SHA:
        print('FAIL wordlist: %d words, sha %s' % (len(words), got[:32]))
        print('     expected 2048 words, sha %s' % WORDLIST_SHA[:32])
        fail += 1
    else:
        print('ok   wordlist       2048 words, %s' % got[:32])

# cashu-ts provenance, offline part. tools/vendor/verify-cashu-ts.sh rebuilds
# Web/cashu-ts.js byte for byte from the inputs pinned in
# tools/vendor/package-lock.json. Here, without the network: the lockfile still
# pins exactly those inputs, and the bundle's license footer names only the
# packages it is supposed to contain. The rebuild itself is opt-in: --network.
CASHU_LOCK = {
    '@cashu/cashu-ts': ('4.11.0', 'sha512-euNst5ZZCCAYDpIs9qXm0CElJYgvUargsODu+WvlI7SiRCVjTEPOIoeSsdBuEfj30qYfyufBopEDipVzS0d22Q=='),
    '@noble/curves':   ('2.4.0',  'sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew=='),
    '@noble/hashes':   ('2.4.0',  'sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA=='),
    '@scure/base':     ('2.4.0',  'sha512-thZ1TuJwFwBblOhgsjDKvvGirBxNp+wSvY/DR6tJBJOTDhdAAcHJ8Vbr2eFnqaxeca4+t0i9KBf+uHYGWwZORg=='),
    '@scure/bip32':    ('2.4.0',  'sha512-i3DS0CptAocyvqE4n3SUkpzeQK4vJMFwWLofTwRiiKo2aWojBOfyMCgfKw9HVpO6fSY5AK86sHS/Uzn8kK9Few=='),
    'esbuild':         ('0.25.0', 'sha512-BXq5mqc8ltbaN34cDqWuYKyNhX8D/Z0J1xdtdQ8UcIIIyJyz+ZMKUt58tF3SrZ85jcfN/PZYhjR5uDQAYNVbuw=='),
}
# the module paths esbuild writes into the bundle's legal-comment footer
CASHU_LEGAL = ['@noble/curves/abstract/curve.js', '@noble/curves/abstract/der.js',
               '@noble/curves/abstract/modular.js', '@noble/curves/abstract/weierstrass.js',
               '@noble/curves/secp256k1.js', '@noble/curves/utils.js',
               '@scure/base/index.js', '@scure/bip32/index.js']

import json
lockpath = os.path.join(HERE, 'tools', 'vendor', 'package-lock.json')
if not os.path.exists(lockpath):
    print('FAIL tools/vendor/package-lock.json is missing')
    fail += 1
else:
    pk = json.load(open(lockpath)).get('packages', {})
    runtime = sorted(k[len('node_modules/'):] for k in pk
                     if k.startswith('node_modules/') and not k.startswith('node_modules/@esbuild/'))
    bad = [n for n, (v, i) in CASHU_LOCK.items()
           if pk.get('node_modules/' + n, {}).get('version') != v
           or pk.get('node_modules/' + n, {}).get('integrity') != i]
    if bad or runtime != sorted(CASHU_LOCK):
        print('FAIL cashu-ts lock  pins changed: %s; packages %s' % (', '.join(bad) or '-', runtime))
        fail += 1
    else:
        print('ok   cashu-ts lock  %d inputs pinned, integrity unchanged' % len(runtime))

cashu = os.path.join(WEB, 'cashu-ts.js')
if os.path.exists(cashu):
    text = open(cashu, encoding='utf8', errors='replace').read()
    tail = text[text.rfind('})();') + 5:]
    legal = sorted(set(re.findall(r'^(@[\w.-]+/[\w./-]+\.js):$', tail, re.M)))
    if legal != sorted(CASHU_LEGAL):
        print('FAIL cashu-ts footer names %s' % legal)
        fail += 1
    else:
        print('ok   cashu-ts footer %d legal comments, all @noble/@scure' % len(legal))

# bip39 provenance, offline part. tools/vendor/verify-bip39.sh rebuilds
# Web/bip39.js byte for byte from tools/vendor/bip39/package-lock.json; here,
# the lockfile still pins exactly these inputs.
BIP39_LOCK = {
    '@scure/bip39':  ('2.4.0',  'sha512-82dxFbZUYboyOf0AXiydsQrFQ5Q4h9mX+O2UkE91ROYmsc0BKMGZLwDmy96Jpa2+vrtoxomjUhy1RPIgH/r2nA=='),
    '@noble/hashes': ('2.4.0',  'sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA=='),
    'esbuild':       ('0.25.0', 'sha512-BXq5mqc8ltbaN34cDqWuYKyNhX8D/Z0J1xdtdQ8UcIIIyJyz+ZMKUt58tF3SrZ85jcfN/PZYhjR5uDQAYNVbuw=='),
}
bip_lock = os.path.join(HERE, 'tools', 'vendor', 'bip39', 'package-lock.json')
if not os.path.exists(bip_lock):
    print('FAIL tools/vendor/bip39/package-lock.json is missing')
    fail += 1
else:
    pk = json.load(open(bip_lock)).get('packages', {})
    runtime = sorted(k[len('node_modules/'):] for k in pk
                     if k.startswith('node_modules/') and not k.startswith('node_modules/@esbuild/'))
    bad = [n for n, (v, i) in BIP39_LOCK.items()
           if pk.get('node_modules/' + n, {}).get('version') != v
           or pk.get('node_modules/' + n, {}).get('integrity') != i]
    if bad or runtime != sorted(BIP39_LOCK):
        print('FAIL bip39 lock     pins changed: %s; packages %s' % (', '.join(bad) or '-', runtime))
        fail += 1
    else:
        print('ok   bip39 lock     %d inputs pinned, integrity unchanged' % len(runtime))

# qrcode.js has no build of its own here: it is dist/qrcode.js from the npm
# release qrcode-generator@2.0.4, unmodified. The hash in EXPECTED above is
# that file's; tools/vendor/verify-qrcode.sh downloads the release and compares.

# --network runs the scripts that check each library against its public
# release. --deep passes each script its source-rebuild flag, which --network
# alone does not (audit finding A5): without it, cashu-ts and bip39 are
# rebuilt from npm tarballs, not from git, and React is compared with npm, not
# rebuilt. Tor's rebuild (--tor-rebuild) and IPtProxy's (--iptproxy) are
# separate: hours, and a Go toolchain.
DEEP = '--deep' in args
if '--network' in args or DEEP or '--tor-rebuild' in args or '--iptproxy' in args:
    import subprocess
    scripts = [
        ('verify-cashu-ts.sh', ['--from-source'] if DEEP else []),
        ('verify-bip39.sh',    ['--from-source'] if DEEP else []),
        ('verify-qrcode.sh',   []),                     # no build to rerun: upstream commits dist/qrcode.js
        ('verify-react.sh',    ['--rebuild'] if DEEP else []),
        ('verify-tor.sh',      ['--rebuild'] if '--tor-rebuild' in args else []),
        ('verify-secp256k1.sh', []),                    # compiled from source: the tag's files are the check
    ]
    if '--iptproxy' in args:
        scripts.append(('verify-iptproxy.sh', []))
    mode = '--deep' if DEEP else '--network'
    for s, flags in scripts:
        print('\n%s: tools/vendor/%s\n' % (mode, ' '.join([s] + flags)))
        rc = subprocess.call(['bash', os.path.join(HERE, 'tools', 'vendor', s)] + flags)
        if rc != 0:
            print('FAIL %s exited %d' % (' '.join([s] + flags), rc))
            fail += 1
    print()

# the scripts embedded in index.html — the runtime above all
EMBEDDED = {
    # the renderer: checked against build/foxy-render.js, filled in below
    '64b433ba-e6ef-4c0b-9d49-9dacd943871b': ('renderer', None),
    '8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047': ('react 18.3.1',
        'd949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd'),
    '93c76fbd-259d-463c-a60d-5ed97ad7e690': ('react-dom 18.3.1',
        '35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d'),
}
# The renderer: Foxy's own source, packed into the old runtime's manifest slot.
# Not pinned to a constant — it is reviewed as a normal file — but the copy
# packed into index.html must be exactly build/foxy-render.js.
RENDERER = os.path.join(os.path.dirname(WEB), 'build', 'foxy-render.js')
RENDERER_UUID = '64b433ba-e6ef-4c0b-9d49-9dacd943871b'
renderer_sha = None
if os.path.exists(RENDERER):
    renderer_sha = hashlib.sha256(open(RENDERER, 'rb').read()).hexdigest()
    print('ok   renderer file  %s (build/foxy-render.js)' % renderer_sha[:32])
else:
    print('FAIL build/foxy-render.js is missing')
    fail += 1

idx = os.path.join(WEB, 'index.html')
if os.path.exists(idx):
    import json, base64, gzip
    h = open(idx, encoding='utf8', errors='replace').read()
    tag = '<script type="__bundler/manifest">'
    try:
        a = h.index(tag) + len(tag)
        b = h.index('</script>', a)
        man = json.loads(h[a:b].strip())
    except ValueError:
        man = {}
    for uuid, (label, digest) in EMBEDDED.items():
        entry = man.get(uuid)
        if not entry:
            print('MISSING  %s (%s) not in the manifest' % (label, uuid[:8]))
            fail += 1
            continue
        raw = base64.b64decode(entry.get('data', ''))
        if entry.get('compressed'):
            raw = gzip.decompress(raw)
        got = hashlib.sha256(raw).hexdigest()
        if digest is None:            # the renderer: whatever build/foxy-render.js is
            digest = renderer_sha
        if got != digest:
            print('SHA256   %s: got %s' % (label, got[:32]))
            fail += 1
        else:
            print('ok   %-14s %s' % (label, got[:32]))
    extra = [k for k in man if k not in EMBEDDED
             and man[k].get('mime') == 'text/javascript']
    if extra:
        print('NOTE %d embedded script(s) not on the list: %s'
              % (len(extra), ', '.join(k[:8] for k in extra)))

print()
print('%d problem(s)' % fail if fail else 'all vendored libraries verified')
sys.exit(1 if fail else 0)
