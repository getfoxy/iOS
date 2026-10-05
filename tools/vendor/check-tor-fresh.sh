#!/bin/sh
# check-tor-fresh.sh — are Tor and the libraries it is built with the newest
# releases of their series?
#
#     sh tools/vendor/check-tor-fresh.sh
#
# Tor runs inside the wallet's process. A memory bug in it that a relay or a
# bridge can reach is a way into the process that holds the seed, and Tor's and
# OpenSSL's security fixes arrive as new releases. Foxy was once found
# five releases behind (Tor 0.4.9.6 while 0.4.9.11 had shipped), with
# client-reachable out-of-bounds reads and use-after-frees fixed in between.
# Nothing had said so.
#
# Tor is built here from the tags pinned in tools/build-tor.sh. This lists each
# source's tags and fails if a newer stable release of the same series exists:
# tor 0.4.9.x, OpenSSL 3.6.x, libevent 2.1.x, xz 5.8.x. Network: those four git
# remotes. Not part of the offline check-all; the weekly CI vendor job runs it.
# After moving a pin: bash tools/build-tor.sh --sources, then bash tools/build-tor.sh.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
python3 - "$ROOT/tools/build-tor.sh" <<'PY'
import re, subprocess, sys
text = open(sys.argv[1]).read()
block = text.split('SOURCES="', 1)[1].split('"', 1)[0]
shapes = {
    'xz': r'v(\d+)\.(\d+)\.(\d+)',
    'openssl': r'openssl-(\d+)\.(\d+)\.(\d+)',
    'libevent': r'release-(\d+)\.(\d+)\.(\d+)-stable',
    'tor': r'tor-(\d+)\.(\d+)\.(\d+)\.(\d+)',
}
failed = 0
for line in block.strip().splitlines():
    name, url, tag = line.split()[:3]
    shape = re.compile('^' + shapes[name] + '$')
    pinned = tuple(int(x) for x in shape.match(tag).groups())
    out = subprocess.run(['git', 'ls-remote', '--tags', '--refs', url], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        print('FAIL  %s: could not list tags at %s' % (name, url)); failed += 1; continue
    series = []
    for ref in out.stdout.split():
        m = shape.match(ref.rsplit('/', 1)[-1])
        if m:
            v = tuple(int(x) for x in m.groups())
            if v[:-1] == pinned[:-1]:
                series.append((v, ref.rsplit('/', 1)[-1]))
    if not series:
        # a renamed tag scheme or a moved remote used to print "newest of its series"
        print('FAIL  %s: no tag at %s is shaped like %s; check the remote and the pattern' % (name, url, tag)); failed += 1; continue
    newest = max(series)[1]
    if series and max(series)[0] > pinned:
        print('FAIL  %s %s is pinned; %s is released. Read its notes for security fixes and update.' % (name, tag, newest))
        failed += 1
    else:
        print('ok    %s %s is the newest of its series' % (name, tag))
sys.exit(1 if failed else 0)
PY
