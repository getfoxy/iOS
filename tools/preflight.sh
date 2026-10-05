#!/bin/sh
# preflight.sh - everything that can be checked on this Mac, then the install.
#
#   sh tools/preflight.sh            # every layer, then build and install
#   sh tools/preflight.sh --no-live  # skip the Docker mints (no Docker, or in a hurry)
#   sh tools/preflight.sh --check    # check only; never touch a phone
#
# Three layers, in the order that fails fastest:
#
#   1. tools/check-all.sh    the wallet and the app against fake mints, in Node
#   2. tools/unit-tests.sh   the native half, in the simulator
#   3. tools/live/*          the wallet against two REAL mint implementations
#                            (CDK and Nutshell in Docker, fake Lightning), and
#                            against a fault proxy that kills the connection
#                            part way through a payment
#
# Layer 3 is the one that has caught what the others cannot. Stub mints have
# whatever fee schedule the test says they have; a real one has its own, and a
# cross-mint payment padded a sat too little failed AFTER the Lightning payment
# had gone through. No amount of stubbing finds that.
#
# Nothing is installed unless every layer passed. That is the whole point: the
# phone is where a bug costs a test round, and this is the last place
# it is free.
set -eu
cd "$(dirname "$0")/.." || exit 1

LIVE=1
INSTALL=1
for a in "$@"; do
  case "$a" in
    --no-live) LIVE=0 ;;
    --check)   INSTALL=0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

FAILED=''
step() {
  name="$1"; shift
  printf '\n=== %s\n' "$name"
  if "$@"; then
    printf 'PASS  %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
    FAILED="$FAILED
  $name"
  fi
}

# ---- 1. the Node suites --------------------------------------------------
step "check-all (wallet, app, snapshots, fuzz)" sh tools/check-all.sh

# ---- 2. the native half --------------------------------------------------
step "unit tests (simulator)" sh tools/unit-tests.sh

# ---- 3. two real mints ---------------------------------------------------
if [ "$LIVE" = 1 ]; then
  if docker info >/dev/null 2>&1; then
    printf '\n=== bringing up CDK and Nutshell\n'
    sh tools/live/local-mint.sh up
    # flows.js section 5 needs a Nutshell whose melts stay PENDING, which is its
    # own container on its own port
    sh tools/live/pending-mint.sh up
    NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem
    FOXY_LIVE_LOCAL=1
    export NODE_EXTRA_CA_CERTS FOXY_LIVE_LOCAL
    step "live: money paths at both mints"      node tools/live/flows.js all
    step "live: tokens there and back"          node tools/live/paste-flows.js cdk
    step "live: NUT-11 locks"                   node tools/live/p2pk.js all
    step "live: paying across mints"            node tools/live/cross-mint.js
    step "live: the connection dying mid-pay"   node tools/live/cross-mint-faults.js
    step "live: no Amount coerced on any path" node tools/live/amount-coercion.js
    printf '\n=== taking the mints down\n'
    sh tools/live/pending-mint.sh down || true
    sh tools/live/local-mint.sh down || true
  else
    printf '\nSKIP  the live mints: Docker is not running\n'
    FAILED="$FAILED
  live mints SKIPPED (Docker not running) - run with Docker, or --no-live to accept that"
  fi
fi

if [ -n "$FAILED" ]; then
  printf '\n----------------------------------------\nNOT READY TO INSTALL:%s\n' "$FAILED"
  exit 1
fi

printf '\n----------------------------------------\nevery layer passed\n'
[ "$INSTALL" = 1 ] || exit 0

# ---- and only now, the phones -------------------------------------------
printf '\n=== building for the phone\n'
xcodebuild -workspace Foxy.xcworkspace -scheme Foxy -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build/device-dd \
  ENABLE_DEBUG_DYLIB=NO -quiet build
APP=build/device-dd/Build/Products/Debug-iphoneos/Foxy.app

# every paired phone that is actually here, named by what it is
xcrun devicectl list devices 2>/dev/null \
  | grep 'available (paired)' \
  | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
  | while read -r udid; do
      if xcrun devicectl device install app --device "$udid" "$APP" >/dev/null 2>&1; then
        printf 'installed on %s\n' "$udid"
      else
        printf 'COULD NOT install on %s (unplugged?)\n' "$udid"
      fi
    done
