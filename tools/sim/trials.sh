#!/bin/sh
# Does Tor actually carry requests after it says it has a circuit?
# Each trial: launch Foxy with the given flags, wait for "circuit established",
# then curl through Foxy's SocksPort (the simulator shares the Mac's loopback)
# every 5s for 90s, and count Foxy's own price requests after ready.
# Usage: sh tools/sim/trials.sh TAG label:flags [label:flags ...]
#   e.g. sh tools/sim/trials.sh check fallback:-FoxyForceTransport,direct,-FoxyDirectPatience,1
. "$(dirname "$0")/common.sh"
TAG=$1; shift
need_app
xcrun simctl install "$UDID" "$APP" && echo "installed ($TAG)"

for spec in "$@"; do
  label=${spec%%:*}; flags=$(echo "${spec#*:}" | tr ',' ' ')
  L="$OUT/ft-$TAG-$label.log"; : > "$L"
  echo "=== $TAG $label ($flags) at $(date +%T)"
  xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
  while pgrep -f "$UDID/.*Foxy.app/Foxy" >/dev/null; do sleep 0.5; done
  t0=$(date +%s)
  # shellcheck disable=SC2086
  ( xcrun simctl launch --console-pty "$UDID" io.getfoxi.foxy $flags > "$L" 2>&1 & )
  up=0
  while [ $(( $(date +%s) - t0 )) -lt 240 ]; do
    grep -aq "circuit established" "$L" && { up=$(( $(date +%s) - t0 )); break; }
    sleep 1
  done
  grep -aE "tor: (starting|.*did not connect|.*giving it longer|could not connect|settings refused|retrying)" "$L" | sed 's/^.*Foxy\[[0-9:]*\] //' | cut -c1-120
  if [ $up -eq 0 ]; then echo "  NO CIRCUIT in 240s"; pkill -9 -f "simctl launch --console-pty"; continue; fi
  echo "  circuit after ${up}s; probing every 5s for 90s"
  ok=0; fail=0; first=""; line=""
  port=$(grep -ao "SOCKS on 127.0.0.1:[0-9]*" "$L" | tail -1 | cut -d: -f2)   # Tor chooses it now
  echo "  Foxy's SOCKS port: ${port:-unknown}"
  end=$(( $(date +%s) + 90 ))
  while [ $(date +%s) -lt $end ]; do
    s=$(date +%s)
    if curl -s -m 15 --socks5-hostname 127.0.0.1:${port:-9} https://check.torproject.org/api/ip | grep -q '"IsTor":true'; then
      ok=$((ok+1)); line="$line+"; [ -z "$first" ] && first=$(( s - t0 - up ))
    else
      fail=$((fail+1)); line="$line."
    fi
    left=$(( 5 - ($(date +%s) - s) )); [ $left -gt 0 ] && sleep $left
  done
  echo "  probes: $ok ok, $fail failed  [$line]  first ok ${first:-never}s after circuit"
  # Foxy's own requests (price feeds, mint) from the ready line on: what the person sees
  awk '/circuit established/ {on=1} on && /\[foxy\] price [0-9]/ {ok++} on && /price source failed/ {bad++}
       /waiting for directory info|directory info (complete|incomplete)|fetching directory info/ {print "  " substr($0, index($0, "[foxy]"))}
       END {printf "  in-app after ready: price ok %d, price source failures %d\n", ok, bad}' "$L"
  echo "  tor warnings: $(grep -ac '\[warn\]' "$L"), hop-1 failures: $(grep -ac 'Failed to find node for hop #1' "$L"), missing guard descriptors: $(grep -ac 'missing descriptors' "$L")"
  pkill -9 -f "simctl launch --console-pty" 2>/dev/null
done
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
echo "done $TAG $(date +%T)"
