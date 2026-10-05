#!/bin/sh
# keychain.sh — the seed and the keychain rules on a signed simulator build.
# Three launches with -FoxyKeychainTest YES: a fresh install (seed made and
# saved), a relaunch (the same seed read back, none made), and a reinstall (the
# old seed removed, a new one made). Every [keychaintest] line should be PASS.
# About 2 minutes.
. "$(dirname "$0")/common.sh"
need_app
run() {
  L="$OUT/keychain-$1.log"; : > "$L"
  xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
  while pgrep -f "$UDID/.*Foxy.app/Foxy" >/dev/null; do sleep 0.5; done
  ( xcrun simctl launch --console-pty "$UDID" io.getfoxi.foxy -FoxyKeychainTest YES -FoxyForceTransport direct > "$L" 2>&1 & )
  sleep 30
  pkill -9 -f "simctl launch --console-pty" 2>/dev/null
  echo "=== $1"
  grep -aE "\[keychaintest\]|install marker|previous installation|a new seed was generated|seed written to the keychain|keychain read failed|seed write refused" "$L" | sed 's/^.*Foxy\[[0-9:]*\] //' | cut -c1-140
}
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
xcrun simctl uninstall "$UDID" io.getfoxi.foxy 2>/dev/null
xcrun simctl install "$UDID" "$APP"
run fresh
run relaunch
xcrun simctl uninstall "$UDID" io.getfoxi.foxy
xcrun simctl install "$UDID" "$APP"
run reinstall
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
echo "FAIL lines: $(cat "$OUT"/keychain-*.log | grep -ac '\[keychaintest\] FAIL')"
