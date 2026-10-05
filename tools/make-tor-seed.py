#!/usr/bin/env python3
"""Build the relay directory Foxy ships with.

    python3 tools/make-tor-seed.py <tor data directory> <output .xz>

Tor's first run downloads the microdescriptor of every relay in the consensus
before it can build a circuit: 9,000-odd of them, and on a phone that was 37
of the 45 seconds between launch and the first circuit (bootstrap 50% to
75%). A copy of that directory in the app
bundle turns those seconds into the handful it takes to fetch what has changed
since the copy was made.

What goes in is only what the current consensus lists, so nothing is shipped
that Tor would throw away: each entry is read back out of a data directory a
real Tor bootstrapped, its SHA-256 digest is computed the way Tor computes it,
and it is kept only if the signed consensus names that digest.

Nothing here is trusted by the app. Tor verifies every microdescriptor against
the digest in the consensus, and the consensus against the directory
authorities' keys compiled into Tor itself. A seed that is stale, corrupt or
tampered with is discarded and Tor fetches as it does today.
"""
import base64
import hashlib
import os
import re
import subprocess
import sys


def entries(path):
    """Each (annotation, body) in one of Tor's microdescriptor files."""
    if not os.path.exists(path):
        return
    raw = open(path, 'rb').read()
    parts = re.split(rb'(?m)^(@last-listed[^\n]*\n)', raw)
    for i in range(1, len(parts) - 1, 2):
        yield parts[i], parts[i + 1]


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip())
        return 2
    data, out = argv[1], argv[2]

    consensus = os.path.join(data, 'cached-microdesc-consensus')
    if not os.path.exists(consensus):
        print('no cached-microdesc-consensus in ' + data + ': let Tor finish bootstrapping first')
        return 1
    wanted = set(re.findall(rb'(?m)^m (\S+)', open(consensus, 'rb').read()))
    if not wanted:
        print('that consensus lists no microdescriptors')
        return 1

    # the live file and its journal: an entry can be in either
    keep = {}
    seen = 0
    for name in ('cached-microdescs', 'cached-microdescs.new'):
        for annotation, body in entries(os.path.join(data, name)):
            seen += 1
            digest = base64.b64encode(hashlib.sha256(body).digest()).rstrip(b'=')
            if digest in wanted and digest not in keep:
                keep[digest] = annotation + body

    if len(keep) < len(wanted) * 0.9:
        print('only %d of %d microdescriptors are on disk — let Tor finish loading them'
              % (len(keep), len(wanted)))
        return 1

    plain = b''.join(keep.values())
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    # -9 for the smallest bundle; the phone decodes it once, on a first run.
    # Apple's Compression framework reads this container as COMPRESSION_LZMA.
    packed = subprocess.run(['xz', '-9', '-c'], input=plain, stdout=subprocess.PIPE, check=True).stdout
    with open(out, 'wb') as f:
        f.write(packed)

    print('consensus lists %d, on disk %d, shipped %d (%.1f%% of the consensus)'
          % (len(wanted), seen, len(keep), 100.0 * len(keep) / len(wanted)))
    print('%.1f MB of directory, %.2f MB in the bundle' % (len(plain) / 1e6, len(packed) / 1e6))
    print('written to ' + out)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
