#!/bin/sh
# unit-tests.sh — Foxy's Swift unit tests (FoxyTests) on the iOS Simulator.
#
#   sh tools/unit-tests.sh [derived-data-dir]
#
# Route's URL, host and redirect rules and host approvals (carried hosts matched
# exactly), the answer cap through the real session delegate, the bridge's
# action table and input checks, the queue every native alert waits in, and
# SeedVault's read and write rules. About a minute once built.
#
# The tests run inside a Debug Foxy.app. Hosting them, it touches no keychain,
# starts no Tor and loads no page (WebHostController.hostingUnitTests), so they
# need no network and change nothing a simulator wallet holds; installing the
# test build does replace the Foxy.app on that simulator.
#
# Needs what tools/sim-build.sh needs, in that order: xcodegen generate, bash
# tools/build-tor.sh (once), pod install. Uses $FOXY_SIM_UDID, else a booted
# iPhone simulator, else the first available one. Like sim-build.sh it builds
# arm64 only, since Tor has no x86_64 simulator slice, and builds clean when
# Xcode's copy of Tor is not Vendor/TorPod's. Exits non-zero when a test fails.
set -e
cd "$(dirname "$0")/.."
DD="${1:-build/test-dd}"
ID='[0-9A-F]\{8\}-\([0-9A-F]\{4\}-\)\{3\}[0-9A-F]\{12\}'
UDID="${FOXY_SIM_UDID:-$(xcrun simctl list devices booted | grep iPhone | grep -o "$ID" | head -1)}"
[ -n "$UDID" ] || UDID="$(xcrun simctl list devices available | grep -m1 iPhone | grep -o "$ID")"
[ -n "$UDID" ] || { echo "no iPhone simulator found; set FOXY_SIM_UDID" >&2; exit 1; }
# A test file newer than the generated project is a test that will not run.
# Foxy.xcodeproj is xcodegen's and is not in the repository, so a file added
# since the last `xcodegen generate` is invisible to Xcode: the suite still
# passes, with the new tests simply absent. That has happened —
# NativeRulesTests and NativeRulesBridgeTests were written after the
# project was generated, and 164 tests passed without either of them. Fail
# loudly instead.
#
# By name, not by date. Comparing modification times also failed on an edit to
# a test file the project already had, and the way past it - regenerating the
# project - blanks the signing team. What matters is a file the project does
# not list, and the same for Foxy's own sources.
PBX="Foxy.xcodeproj/project.pbxproj"
if [ -f "$PBX" ]; then
  missing=""
  for f in $(find FoxyTests Foxy -name '*.swift' 2>/dev/null); do
    grep -q "path = $(basename "$f");\|/\* $(basename "$f") \*/" "$PBX" || missing="$missing $f"
  done
  if [ -n "$missing" ]; then
    echo "these files are not in $PBX, so Xcode would not build them:" >&2
    printf '  %s\n' $missing >&2
    echo "run: xcodegen generate && LANG=en_US.UTF-8 pod install" >&2
    exit 1
  fi
fi

cached="$DD/Build/Products/Debug-iphonesimulator/XCFrameworkIntermediates/Tor/CTor/tor.framework/tor"
ours="Vendor/TorPod/tor.xcframework/ios-arm64-simulator/tor.framework/Versions/A/tor"
if [ -f "$cached" ] && ! cmp -s "$cached" "$ours"; then
  echo "the Tor in $DD is not Vendor/TorPod's: building clean" >&2
  rm -rf "$DD"
fi
mkdir -p "$(dirname "$DD")"
if xcodebuild -workspace Foxy.xcworkspace -scheme Foxy -configuration Debug \
     -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$DD" \
     ARCHS=arm64 \
     CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
     DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
     ENABLE_USER_SCRIPT_SANDBOXING=NO test > "$DD.log" 2>&1; then
  grep -E "^Test Suite 'All tests' (passed|failed)|Executed [0-9]+ tests?, with" "$DD.log" | tail -2
  echo "unit tests pass"
else
  grep -E "error:|: error|failed \(|Failing tests|^\s+-\[|\*\* TEST" "$DD.log" | head -40
  echo "unit tests FAILED: see $DD.log" >&2
  exit 1
fi
