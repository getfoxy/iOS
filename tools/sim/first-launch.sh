#!/bin/sh
# first-launch.sh — a new install's first connection, several times over.
#
# Each trial deletes Foxy, installs it and launches it, so Tor starts with no
# directory and has to download all of it. Per trial: seconds until "circuit
# established", how many times the stall watch nudged Tor ("no data for 5s"),
# and whether direct Tor gave up for a bridge.
#
# expect: every trial connects, well inside direct's 45 seconds
#
# FOXY_FIRST_TRIALS=N (default 4). Up to 2 minutes a trial.
. "$(dirname "$0")/common.sh"
need_app
n=${FOXY_FIRST_TRIALS:-4}
i=1
while [ "$i" -le "$n" ]; do
  L="$OUT/first-launch-$i.log"; : > "$L"
  xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
  while pgrep -f "$UDID/.*Foxy.app/Foxy" >/dev/null; do sleep 0.5; done
  xcrun simctl uninstall "$UDID" io.getfoxi.foxy 2>/dev/null
  xcrun simctl install "$UDID" "$APP"
  ( xcrun simctl launch --console-pty "$UDID" io.getfoxi.foxy -FoxyForceTransport direct > "$L" 2>&1 & )
  t0=$(date +%s); took=""
  while [ $(( $(date +%s) - t0 )) -lt 120 ]; do
    if grep -aq "tor: circuit established" "$L"; then took=$(( $(date +%s) - t0 )); break; fi
    sleep 1
  done
  pkill -9 -f "simctl launch --console-pty" 2>/dev/null
  if [ -n "$took" ]; then result="connected in ${took}s"; else result="no circuit in 120s"; fi
  echo "trial $i: $result, $(grep -ac 'tor: no data for' "$L") nudge(s), $(grep -ac 'did not connect after' "$L") transport switch(es)"
  grep -aE 'tor: no data for|did not connect after' "$L" | sed 's/^.*Foxy\[[0-9:]*\] //' | cut -c1-110 | sed 's/^/    /'
  i=$((i + 1))
done
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
echo "logs: $OUT/first-launch-*.log"
