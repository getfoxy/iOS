#!/bin/sh
# release-silence.sh — a Release build says nothing and ignores Debug flags.
# Builds Release (signed to run locally), launches it with every DEBUG launch
# argument, and counts what it printed: expect 0 lines. Then finds Tor by its
# listening ports and sends one request through it: expect "IsTor":true.
# About 3 minutes.
. "$(dirname "$0")/common.sh"
APP="$(cd "$ROOT" && CONFIG=Release sh tools/sim-build.sh "$ROOT/build/sim-dd-release" | tail -1)"
[ -d "$APP" ] || { echo "release build failed: see $ROOT/build/sim-dd-release.log"; exit 1; }
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
while pgrep -f "$UDID/.*Foxy.app/Foxy" >/dev/null; do sleep 0.5; done
xcrun simctl install "$UDID" "$APP" && echo installed
L="$OUT/release-silence.log"; : > "$L"
( xcrun simctl launch --console-pty "$UDID" io.getfoxi.foxy -FoxyKeychainTest YES -FoxyBridgeTest YES -FoxyNetBlockTest YES -FoxyForceTransport snowflake -FoxyDirectPatience 1 > "$L" 2>&1 & )
sleep 75
pid=$(pgrep -n -f "$UDID/.*Foxy.app/Foxy")
echo "printed: $(wc -l < "$L" | tr -d ' ') lines (want 0)"
cut -c1-150 "$L" | head -5
for port in $(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {split($9,a,":"); print a[2]}'); do
  r=$(curl -s -m 20 --socks5-hostname 127.0.0.1:$port https://check.torproject.org/api/ip 2>/dev/null)
  echo "  port $port: ${r:-no SOCKS answer}"
done
pkill -9 -f "simctl launch --console-pty" 2>/dev/null
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
