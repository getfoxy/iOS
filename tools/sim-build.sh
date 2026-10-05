#!/bin/sh
# Build Foxy for the iOS Simulator, signed to run locally, so the simulator's
# keychain works.
#
# Unsigned simulator builds (CODE_SIGNING_ALLOWED=NO) get -34018 from every
# keychain call. That only ever tests the path where the keychain fails: the
# seed is never saved, and the refusal to overwrite a saved seed can never be
# reached. Signed like this, the keychain behaves as on a phone.
#
#   sh tools/sim-build.sh [derived-data-dir]
#   CONFIG=Release sh tools/sim-build.sh [derived-data-dir]
#
# Prints the path of the built Foxy.app on its last line. Run xcodegen generate
# bash tools/build-tor.sh (once) and then pod install first, in that order. The entitlements path is absolute:
# a setting given here applies to every target, and the Tor pod resolves a
# relative one against Pods/.
set -e
cd "$(dirname "$0")/.."
DD="${1:-build/sim-dd}"
CONFIG="${CONFIG:-Debug}"
# Xcode keeps its own copy of tor.xcframework under XCFrameworkIntermediates and
# did not refresh it when the pod moved to Vendor/TorPod: a simulator app linked
# the old prebuilt Tor 0.4.9.11 while Vendor/TorPod held the build from source.
# Deleting only that copy left a build that no longer linked, so when the copy is
# not the framework in Vendor/TorPod the whole folder goes and the build is clean.
# Tor is built for arm64 simulators only (tools/build-tor.sh), so the app is too:
# a generic destination would also build x86_64 and find no Tor slice to link.
cached="$DD/Build/Products/$CONFIG-iphonesimulator/XCFrameworkIntermediates/Tor/CTor/tor.framework/tor"
ours="Vendor/TorPod/tor.xcframework/ios-arm64-simulator/tor.framework/Versions/A/tor"
if [ -f "$cached" ] && ! cmp -s "$cached" "$ours"; then
  echo "the Tor in $DD is not Vendor/TorPod's: building clean" >&2
  rm -rf "$DD"
fi
xcodebuild -workspace Foxy.xcworkspace -scheme Foxy -configuration "$CONFIG" \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DD" \
  ARCHS=arm64 \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
  CODE_SIGN_ENTITLEMENTS="$PWD/tools/simulator.entitlements" \
  ENABLE_USER_SCRIPT_SANDBOXING=NO build > "$DD.log" 2>&1 || { tail -20 "$DD.log"; exit 1; }
APP="$DD/Build/Products/$CONFIG-iphonesimulator/Foxy.app"
# Which page this build carries, recorded with the build.
#
# The app prints the same number at launch, over the files it staged, and shows
# its first twelve characters at the foot of the menu drawer. Saying it here
# means a build and the app it produced can be told apart from any other without
# a phone in hand. On stderr: the last line of stdout is the app's path, and
# tools/sim and tools/live read it.
python3 tools/page-hash.py --dir "$APP/Web" >&2 || true
echo "$APP"
