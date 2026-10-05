#!/usr/bin/env python3
"""
update-bridges.py — refresh Foxy's built-in obfs4 and Snowflake bridge lines.

Foxy ships the Tor Project's built-in bridges in Foxy/Tor/Bridges.swift, between
the BUILT-IN BRIDGES markers. Bridges move and certificates change, so a list
left alone goes stale and the fallback that exists for censored networks stops
working there. This fetches the current list from the Tor Project's Moat
service — the source Tor Browser uses — and replaces the lines.

    python3 tools/update-bridges.py            # show what would change
    python3 tools/update-bridges.py --write    # rewrite the Swift lines and date
    python3 tools/update-bridges.py --socks 127.0.0.1:9050 [--write]

Fetching tells bridges.torproject.org that this machine asked for the built-in
bridge list, which is public. --socks sends the request through a Tor SOCKS
port instead, which needs curl.

Smoke check 19 reports how old the lines are.
"""

import argparse, datetime, json, re, subprocess, sys, urllib.request

SWIFT = 'Foxy/Tor/Bridges.swift'
URL = 'https://bridges.torproject.org/moat/circumvention/builtin'
BEGIN = '    // BEGIN BUILT-IN BRIDGES'
END = '    // END BUILT-IN BRIDGES'


def fetch(socks):
    """The Moat builtin list: {"obfs4": [...], "snowflake": [...], ...}."""
    body = b'{}'
    headers = ['Content-Type: application/vnd.api+json']
    if socks:
        out = subprocess.run(['curl', '-s', '-m', '60', '--socks5-hostname', socks,
                              '-X', 'POST', '-H', headers[0], '--data', '{}', URL],
                             capture_output=True)
        if out.returncode:
            sys.exit('curl through %s failed: %s' % (socks, out.stderr.decode()[:200]))
        raw = out.stdout
    else:
        req = urllib.request.Request(URL, data=body, method='POST',
                                     headers={'Content-Type': 'application/vnd.api+json'})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
    try:
        data = json.loads(raw)
    except ValueError:
        sys.exit('the answer was not JSON: %r' % raw[:200])
    lines = {k: [l.strip() for l in v if isinstance(l, str) and l.strip()]
             for k, v in data.items() if isinstance(v, list)}
    for kind in ('obfs4', 'snowflake'):
        if not lines.get(kind):
            sys.exit('no %s bridges in the answer; keys were %s' % (kind, sorted(data)))
        for line in lines[kind]:
            if not line.startswith(kind + ' '):
                sys.exit('unexpected %s line: %r' % (kind, line[:80]))
            if '"' in line or '\\' in line:
                sys.exit('refusing a line with quotes or backslashes: %r' % line[:80])
    return lines


def block(lines, today):
    def arr(name, items):
        body = ''.join('        "%s",\n' % l for l in items)
        return '    static let %s = [\n%s    ]\n' % (name, body)
    return (BEGIN + ' — tools/update-bridges.py, fetched %s from %s\n' % (today, URL)
            + arr('obfs4Lines', lines['obfs4']) + '\n'
            + arr('snowflakeLines', lines['snowflake'])
            + END + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--socks')
    a = ap.parse_args()

    src = open(SWIFT, encoding='utf-8', newline='').read()
    i = src.find(BEGIN)
    j = src.find(END, i)
    if i < 0 or j < 0:
        sys.exit('markers not found in %s' % SWIFT)
    j = src.index('\n', j) + 1
    current = src[i:j]
    have = {k: re.findall(r'"(%s [^"]+)"' % k, current) for k in ('obfs4', 'snowflake')}

    fresh = fetch(a.socks)
    for kind in ('obfs4', 'snowflake'):
        old, new = set(have[kind]), set(fresh[kind])
        print('%-9s %d now, %d published: %d unchanged, %d removed, %d added'
              % (kind, len(old), len(new), len(old & new), len(old - new), len(new - old)))
        for l in sorted(old - new): print('  - ' + l[:100])
        for l in sorted(new - old): print('  + ' + l[:100])

    if not a.write:
        print('\n(dry run — --write to apply)')
        return
    # Lines already here keep their place; new ones go at the end. The service
    # does not return a fixed order, and a refresh that only reshuffled would
    # otherwise rewrite every line.
    for kind in ('obfs4', 'snowflake'):
        published = set(fresh[kind])
        fresh[kind] = [l for l in have[kind] if l in published] + \
                      [l for l in fresh[kind] if l not in set(have[kind])]
    today = datetime.date.today().isoformat()
    out = src[:i] + block(fresh, today) + src[j:]
    open(SWIFT, 'w', encoding='utf-8', newline='').write(out)
    print('\nwrote %s (fetched %s)' % (SWIFT, today))


if __name__ == '__main__':
    main()
