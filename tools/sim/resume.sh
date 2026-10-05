#!/bin/sh
# resume.sh — coming back from the background: a 70-second trip, after which
# a private connection is set up as at launch.
#
# expect: "off the network while Foxy is in the background", "wake: …s in the
#         background", "tor: setting up a private connection (back after …s)",
#         "tor: circuit established"
#
# FOXY_RESUME_BRIDGE=obfs4 (or snowflake) adds a second trial on that transport.
# About 4 minutes, 8 with a bridge.
. "$(dirname "$0")/common.sh"
need_app
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
while pgrep -f "$UDID/.*Foxy.app/Foxy" >/dev/null; do sleep 0.5; done
xcrun simctl install "$UDID" "$APP" && echo installed
trial() {
  label=$1; via=$2; shift 2
  L="$OUT/resume-$label.log"; : > "$L"
  xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
  while pgrep -f "$UDID/.*Foxy.app/Foxy" >/dev/null; do sleep 0.5; done
  ( xcrun simctl launch --console-pty "$UDID" io.getfoxi.foxy -FoxyForceTransport "$via" "$@" > "$L" 2>&1 & )
  t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 240 ]; do grep -aq "circuit established" "$L" && break; sleep 1; done
  sleep 25
  mark=$(wc -l < "$L")
  echo "=== $label: to the background at $(date +%T)"
  xcrun simctl launch "$UDID" com.apple.Preferences > /dev/null 2>&1
  sleep 70
  echo "    back at $(date +%T)"
  xcrun simctl launch "$UDID" io.getfoxi.foxy > /dev/null 2>&1
  sleep 60
  tail -n +$((mark + 1)) "$L" | grep -aE "\[foxy\] wake:|tor gate:|tor: off the network|tor guards|tor: setting up|control link is not answering|tor: circuit established|did not connect after|\[foxy\] price [0-9]" \
    | sed 's/^.*Foxy\[[0-9:]*\] //' | cut -c1-150 | head -20
  echo "    Tor Bug: lines: $(grep -ac '\[warn\] Bug:' "$L")"
  pkill -9 -f "simctl launch --console-pty" 2>/dev/null
}
trial normal direct
[ -n "$FOXY_RESUME_BRIDGE" ] && trial "$FOXY_RESUME_BRIDGE" "$FOXY_RESUME_BRIDGE"
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
echo "done $(date +%T)"
