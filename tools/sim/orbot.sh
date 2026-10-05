#!/bin/sh
# Simulator test of Orbot mode: a fake Orbot API (15182) reports a bypass port,
# served by a logging SOCKS5 proxy. Foxy's Tor must reach relays/bridges only
# through that proxy, and fall back to direct when Orbot goes away.
# The simulator shares the Mac's loopback, so a fake Orbot on the Mac is seen by
# the app. The Mac must have no VPN running: Foxy now believes Orbot only with one,
# so without a VPN this shows the fake being ignored instead. About 6 minutes.
. "$(dirname "$0")/common.sh"
BYPASS=19050
need_app
xcrun simctl install "$UDID" "$APP" && echo "installed"
bridge_ips
relay_ips

start_orbot() {
  python3 "$HERE/socks-log.py" $BYPASS "$OUT/orbot-socks.log" & SOCKS_PID=$!
  python3 "$HERE/fake-orbot.py" $BYPASS "$OUT/orbot-api.log" & API_PID=$!
  sleep 1
}
stop_orbot() { kill $API_PID $SOCKS_PID 2>/dev/null; wait $API_PID $SOCKS_PID 2>/dev/null; }

# sample Foxy's non-loopback sockets into $P for $1 seconds
sample() {
  s_end=$(( $(date +%s) + $1 ))
  while [ $(date +%s) -lt $s_end ]; do
    pid=$(pgrep -n -f "$UDID/.*Foxy.app/Foxy")
    [ -n "$pid" ] && lsof -nP -a -p "$pid" -i 2>/dev/null | awk '/->/ {split($9,a,"->"); print $8, a[2]}' >> "$P"
    sleep 1
  done
}

classify() {  # $1 peers file, $2 label
  python3 - "$1" "$OUT/relays-now.txt" "$OUT/obfs4-ips.txt" "$2" <<'EOF'
import sys, collections
relays = set(open(sys.argv[2]).read().split()); obfs4 = set(open(sys.argv[3]).read().split())
seen = {}
for line in open(sys.argv[1]):
    parts = line.split()
    if len(parts) != 2: continue
    ip = parts[1].rsplit(':', 1)[0].strip('[]')
    if ip in ('127.0.0.1', '::1'): continue
    seen[parts[1]] = 'obfs4 bridge' if ip in obfs4 else 'Tor relay' if ip in relays else 'other'
print('  %s — Foxy direct connections:' % sys.argv[4], dict(collections.Counter(seen.values())) or 'NONE')
for remote, cls in sorted(seen.items()):
    if cls != 'Tor relay': print('     ', cls, remote)
EOF
}

proxied() {  # summarise CONNECTs in the socks log since line $1
  tail -n +$1 "$OUT/orbot-socks.log" | python3 - "$OUT/relays-now.txt" "$OUT/obfs4-ips.txt" <<'EOF'
import sys, collections
relays = set(open(sys.argv[1]).read().split()); obfs4 = set(open(sys.argv[2]).read().split())
c = collections.Counter(); other = set()
for line in sys.stdin:
    f = line.split()
    if len(f) < 3 or f[1] not in ('CONNECT', 'FAILED'): continue
    ip = f[2].rsplit(':', 1)[0].strip('[]')
    cls = 'obfs4 bridge' if ip in obfs4 else 'Tor relay' if ip in relays else 'other'
    c[f[1] + ' ' + cls] += 1
    if cls == 'other': other.add(f[2])
print('  through the bypass proxy:', dict(c) or 'NOTHING')
for o in sorted(other): print('      other', o)
EOF
}

launch() {  # $1 label, rest = args
  label=$1; shift
  L="$OUT/orbot-$label.log"; : > "$L"
  old=$(pgrep -n -f "$UDID/.*Foxy.app/Foxy")
  ( xcrun simctl launch --console-pty --terminate-running-process "$UDID" io.getfoxi.foxy -FoxyBridgeTest YES "$@" > "$L" 2>&1 & )
  for i in $(seq 1 20); do [ -n "$old" ] && kill -0 "$old" 2>/dev/null || break; sleep 0.5; done
}
wait_for() {  # $1 pattern, $2 seconds; sets P samples meanwhile
  w_end=$(( $(date +%s) + $2 )); t0=$(date +%s)
  while [ $(date +%s) -lt $w_end ]; do
    grep -aqE "$1" "$L" && { echo "  '$1' after $(( $(date +%s) - t0 ))s"; return 0; }
    sample 1
  done
  echo "  '$1' NOT SEEN within $2s"; return 1
}
show() { grep -aE "orbot:|tor: (starting|going past|no Orbot|settings refused|circuit established|circuit lost|could not connect|.*did not connect)|request through Tor" "$L" | sed 's/^.*Foxy\[[0-9:]*\] //' | cut -c1-160; }

: > "$OUT/orbot-socks.log"; : > "$OUT/orbot-api.log"

echo "=== 1. Orbot running at launch, direct Tor ($(date +%T))"
start_orbot
mark=$(( $(wc -l < "$OUT/orbot-socks.log") + 1 ))
P="$OUT/orbot-1.peers"; : > "$P"
launch direct -FoxyForceTransport direct
wait_for "request through Tor" 150; sample 15
show; proxied $mark; classify "$P" "with Orbot"
echo "  fake Orbot API calls: $(wc -l < "$OUT/orbot-api.log")"

echo "=== 2. Orbot stops mid-session ($(date +%T))"
stop_orbot
P="$OUT/orbot-2.peers"; : > "$P"
wait_for "no Orbot bypass" 40
sample 60
show | tail -6; classify "$P" "after Orbot stopped"
port=$(grep -ao "SOCKS on 127.0.0.1:[0-9]*" "$L" | tail -1 | cut -d: -f2)
echo "  SocksPort ${port:-unknown} still answering: $(nc -z 127.0.0.1 ${port:-9} && echo yes || echo no)"

echo "=== 3. Orbot running at launch, obfs4 ($(date +%T))"
start_orbot
mark=$(( $(wc -l < "$OUT/orbot-socks.log") + 1 ))
P="$OUT/orbot-3.peers"; : > "$P"
launch obfs4 -FoxyForceTransport obfs4
wait_for "request through Tor" 180; sample 15
show; proxied $mark; classify "$P" "obfs4 with Orbot"
stop_orbot

pkill -9 -f "simctl launch --console-pty" 2>/dev/null
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
echo "done $(date +%T)"
