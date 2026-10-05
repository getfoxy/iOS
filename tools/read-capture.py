#!/usr/bin/env python3
"""
read-capture.py — what did the phone talk to?

    python3 tools/read-capture.py /tmp/foxy-blocked.pcap

Reads a tcpdump capture of the phone's traffic and lists every hostname it
looked up and every server it opened a TLS connection to, then says which of
them should not be there.

See NETWORK-TEST.md for how to take the captures. The one that matters is the
one recorded while the gate is blocking: nothing belonging to a mint or a
price feed should appear in it.

Needs only tcpdump, which macOS has. No Wireshark, no Python packages.
"""

import re
import subprocess
import sys
import os

# Hosts that are Foxy's business, and what each is for.
KNOWN = {
    'mint.minibits.cash': 'mint',
    'mint.coinos.io': 'mint',
    'mint.westernbtc.com': 'mint',
    'mint.macadamia.cash': 'mint',
    'api.kraken.com': 'price',
    # mempool is asked at its onion now, which a capture cannot show. Clearnet
    # mempool.space is no longer a source, so seeing it here is a finding.
    'api.coinbase.com': 'price',
    'api.gemini.com': 'price',
    'www.bitstamp.net': 'price',
    'blockchain.info': 'price',
    'check.torproject.org': 'the gate\'s own Tor probe',
    'apps.apple.com': 'the App Store link for Orbot',
    'orbot.app': 'the Orbot universal link',
}


def run(args):
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=300)
        return out.stdout + out.stderr
    except FileNotFoundError:
        print('tcpdump not found. It ships with macOS; on Linux, install it.')
        sys.exit(1)


def hostnames(path):
    """Every name the phone looked up, and every name in a TLS handshake."""
    names = set()

    # DNS questions
    dns = run(['tcpdump', '-r', path, '-n', '-t', 'port 53'])
    for m in re.finditer(r'\b([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})\.?\s*\(', dns):
        names.add(m.group(1).lower().rstrip('.'))
    for m in re.finditer(r'A\??\s+([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})', dns):
        names.add(m.group(1).lower().rstrip('.'))

    # TLS server names, which appear in the clear in the handshake.
    #
    # This scans payload bytes, so encrypted traffic throws up things that
    # look like domains and are not — a Tor capture produced "y9....me" and
    # "old.qz.me". A name has to survive being a plausible hostname before it
    # is reported, or the tool cries wolf on exactly the captures that matter.
    tls = run(['tcpdump', '-r', path, '-n', '-A', '-s', '0', 'tcp port 443'])
    tls += run(['tcpdump', '-r', path, '-n', '-A', '-s', '0', 'ip6 and tcp port 443'])
    for m in re.finditer(r'([a-z0-9][a-z0-9.-]{3,}\.(?:com|org|net|io|cash|space|info|me|app))',
                         tls, re.I):
        n = m.group(1).lower()
        if plausible(n):
            names.add(n)

    return names


def plausible(name):
    """Could this be a real hostname, or is it encrypted bytes that rhyme?"""
    if '..' in name or name.startswith('.') or name.startswith('-'):
        return False
    labels = name.split('.')
    if len(labels) < 2 or any(not l for l in labels):
        return False
    for l in labels[:-1]:
        if len(l) > 63 or not re.match(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?$', l):
            return False
        # random bytes rarely spell anything: a label with no vowel and no
        # digit, longer than four characters, is almost certainly noise
        if len(l) > 4 and not re.search(r'[aeiou0-9]', l):
            return False
    return True


def peers(path):
    """Every address the phone exchanged packets with, most talkative first.

    Both families. A phone sharing a Mac's connection often prefers IPv6, and
    an earlier version of this counted only IPv4 — which would have reported a
    clean capture while every real connection went unseen.
    """
    counts = {}

    out4 = run(['tcpdump', '-r', path, '-n', '-t', 'ip'])
    for line in out4.split('\n'):
        m = re.search(r'>\s+(\d+\.\d+\.\d+\.\d+)\.(\d+):', line)
        if not m:
            continue
        ip = m.group(1)
        if ip.startswith(('192.168.', '10.', '172.16.', '224.', '239.')):
            continue
        counts[ip] = counts.get(ip, 0) + 1

    out6 = run(['tcpdump', '-r', path, '-n', '-t', 'ip6'])
    for line in out6.split('\n'):
        m = re.search(r'>\s+([0-9a-f:]+)\.(\d+):', line)
        if not m:
            continue
        ip = m.group(1)
        # link-local, multicast and the Mac's own shared prefix are not the internet
        if ip.startswith(('fe80:', 'ff0', '::1')):
            continue
        counts[ip] = counts.get(ip, 0) + 1

    return sorted(counts.items(), key=lambda kv: -kv[1])


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print('no such capture:', path)
        sys.exit(1)

    print('reading', path)
    names = hostnames(path)
    ips = peers(path)

    mints = sorted(n for n in names if KNOWN.get(n) == 'mint')
    prices = sorted(n for n in names if KNOWN.get(n) == 'price')
    expected = sorted(n for n in names if n in KNOWN and KNOWN[n] not in ('mint', 'price'))
    others = sorted(n for n in names if n not in KNOWN)

    print()
    print('HOSTNAMES SEEN')
    if mints:
        print('  mints:        ' + ', '.join(mints))
    if prices:
        print('  price feeds:  ' + ', '.join(prices))
    for n in expected:
        print('  %-14s%s' % ('', n + '  (' + KNOWN[n] + ')'))
    for n in others[:15]:
        print('  %-14s%s' % ('', n))
    if len(others) > 15:
        print('  %-14s… and %d more' % ('', len(others) - 15))
    if not names:
        print('  (none — either the capture is empty or nothing left the phone)')

    print()
    print('BUSIEST PEERS')
    if ips and not (mints or prices) and ips[0][1] > 50:
        print('  (a Tor capture usually shows a handful of relays here, carrying')
        print('   everything; that is what a working tunnel looks like)')
    for ip, n in ips[:8]:
        print('  %-40s %d packets' % (ip, n))
    if not ips:
        print('  (none)')

    print()
    if mints or prices:
        print('MINT OR PRICE TRAFFIC IS PRESENT.')
        print()
        print('  In a capture taken while the gate was OPEN and on Tor, this is')
        print('  wrong: those names should be resolved inside the tunnel, not on')
        print('  the wire. Seeing them means the request did not go through Tor.')
        print()
        print('  In a capture taken while the gate was BLOCKING, this is a')
        print('  fail-open — the thing batches 2 and 7 were meant to close.')
        print()
        print('  Either way, note which host and what you were doing.')
    else:
        print('NO MINT OR PRICE TRAFFIC IN THE CLEAR.')
        print()
        print('  Nothing belonging to a mint or a price feed left the phone by')
        print('  name. In a blocking capture that is the result you want. In a')
        print('  Tor capture it means the tunnel carried it, which is also right.')
        if 'check.torproject.org' in names:
            print()
            print('  check.torproject.org is present, which is expected: it is the')
            print('  gate\'s own probe and is how it learns whether Tor is up.')

    print()
    print('This reads names off the wire. It cannot see inside the tunnel, which')
    print('is the point — anything visible here was not protected by one.')


if __name__ == '__main__':
    main()
