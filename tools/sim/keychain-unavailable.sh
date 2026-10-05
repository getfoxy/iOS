#!/bin/sh
# keychain-unavailable.sh — the seed when the keychain never answers. The unsigned simulator build cannot use the
# keychain (-34018), so every read fails: exactly the case that used to end with
# a generated seed and a keychain write. Expect: retries, a refusal naming the
# keychain, and no seed generated or written.
# unsigned on purpose: this is the build whose keychain calls all fail
. "$(dirname "$0")/common.sh"
(cd "$ROOT" && xcodebuild -workspace Foxy.xcworkspace -scheme Foxy -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath "$ROOT/build/sim-dd-unsigned" CODE_SIGNING_ALLOWED=NO ENABLE_USER_SCRIPT_SANDBOXING=NO build > "$OUT/build-unsigned.log" 2>&1)
grep -q "BUILD SUCCEEDED" "$OUT/build-unsigned.log" || { grep -E "error:" "$OUT/build-unsigned.log" | sort -u | head; exit 1; }
APP="$ROOT/build/sim-dd-unsigned/Build/Products/Debug-iphonesimulator/Foxy.app"

xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null
xcrun simctl uninstall "$UDID" io.getfoxi.foxy 2>/dev/null       # a fresh install: no web store, no marker
xcrun simctl install "$UDID" "$APP" && echo "installed fresh"
L="$OUT/seed-sim.log"; : > "$L"
( xcrun simctl launch --console-pty "$UDID" io.getfoxi.foxy -FoxyForceTransport direct > "$L" 2>&1 & )
sleep 90
pkill -9 -f "simctl launch --console-pty" 2>/dev/null
xcrun simctl terminate "$UDID" io.getfoxi.foxy 2>/dev/null

echo "--- seed lines"
grep -aE "keychain|seed|circuit established|connect failed|still starting" "$L" | sed 's/^.*Foxy\[[0-9:]*\] //' | cut -c1-200 | head -30
echo "--- verdict"
echo "keychain reads attempted:      $(grep -ac 'keychain read failed for foxy.seed.v1' "$L")"
echo "retries announced:             $(grep -ac 'did not answer, asking again' "$L")"
echo "connect refusals (keychain):   $(grep -ac 'could not read this wallet' "$L")"
echo "seeds generated (want 0):      $(grep -ac 'a new seed was generated' "$L")"
echo "keychain writes tried (want 0): $(grep -ac 'keychain save failed for foxy.seed.v1\|seed written to the keychain' "$L")"
