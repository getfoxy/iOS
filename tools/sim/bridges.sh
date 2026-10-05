#!/bin/sh
# bridges.sh — Snowflake, obfs4, and the automatic fallback, in the simulator.
# Samples Foxy's sockets while it connects and classifies every remote address:
# Tor relay, obfs4 bridge, or other. About 15 minutes.
. "$(dirname "$0")/common.sh"
need_app
xcrun simctl install "$UDID" "$APP" && echo "installed"
bridge_ips
relay_ips
echo "relay addresses known: $(wc -l < "$OUT/relays-now.txt")"

run() {
  label=$1; secs=$2; shift 2
  L="$OUT/br-$label.log"; P="$OUT/br-$label.peers"; : > "$L"; : > "$P"
  echo "=== $label ($*) at $(date +%T)"
  old=$(pgrep -n -f "$UDID/.*Foxy.app/Foxy")
  ( xcrun simctl launch --console-pty --terminate-running-process "$UDID" io.getfoxi.foxy -FoxyBridgeTest YES "$@" > "$L" 2>&1 & )
  # the previous Foxy must be gone before sampling, or its sockets are counted
  for i in $(seq 1 20); do [ -n "$old" ] && kill -0 "$old" 2>/dev/null || break; sleep 0.5; done
  start=$(date +%s); up=0
  while [ $(( $(date +%s) - start )) -lt $secs ]; do
    pid=$(pgrep -n -f "$UDID/.*Foxy.app/Foxy")
    [ -n "$pid" ] && lsof -nP -a -p "$pid" -i 2>/dev/null | awk '/->/ {split($9,a,"->"); print $8, a[2]}' >> "$P"
    if [ $up -eq 0 ] && grep -q "circuit established" "$L"; then
      up=$(( $(date +%s) - start )); secs=$(( up + 45 ))
    fi
    sleep 1
  done
  pkill -9 -f "simctl launch --console-pty" 2>/dev/null
  grep -aE "tor: (starting through|.*did not connect|.*giving it longer|circuit established|could not connect|.*would not start|settings refused|going past Orbot|no Orbot bypass)|Closing no-longer-configured|\[resume\] after circuit" "$L" | cut -c1-170
  [ $up -gt 0 ] && echo "  circuit up after ${up}s" || echo "  NO CIRCUIT within ${secs}s"
  python3 - "$P" "$OUT/relays-now.txt" "$OUT/obfs4-ips.txt" <<'EOF'
import sys, collections
relays = set(open(sys.argv[2]).read().split()); obfs4 = set(open(sys.argv[3]).read().split())
seen = {}
for line in open(sys.argv[1]):
    parts = line.split()
    if len(parts) != 2: continue
    proto, remote = parts
    ip = remote.rsplit(':', 1)[0].strip('[]')
    if ip in ('127.0.0.1', '::1'): continue
    seen[(proto, remote)] = 'obfs4 bridge' if ip in obfs4 else 'Tor relay' if ip in relays else 'other'
print('  direct connections from Foxy:', dict(collections.Counter(seen.values())) or 'none sampled')
for (proto, remote), cls in sorted(seen.items(), key=lambda x: (x[1], x[0])):
    if cls != 'Tor relay': print('   ', cls, proto, remote)
EOF
}

run snowflake 240 -FoxyForceTransport snowflake
run obfs4 180 -FoxyForceTransport obfs4
run fallback 300 -FoxyForceTransport direct -FoxyDirectPatience 1
run reset-direct 90 -FoxyForceTransport direct
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
echo "done $(date +%T)"
