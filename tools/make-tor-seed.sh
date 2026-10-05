#!/bin/sh
# Refresh the relay directory Foxy ships with (Foxy/TorSeed/tor-microdescs.xz).
#
#     sh tools/make-tor-seed.sh [simulator udid]
#
# Harvested from Foxy's own Tor rather than from anywhere else: run the app in
# the simulator, let it reach a circuit, then take the directory it downloaded.
# The bytes are the ones Tor itself verified against the signed consensus.
#
# Do this before a release. The older the seed, the more a first run has to
# fetch to catch up — it never becomes wrong, only less of a head start.
set -e
cd "$(dirname "$0")/.."

UDID="${1:-$(xcrun simctl list devices booted -j | python3 -c '
import json,sys
d=json.load(sys.stdin)["devices"]
for rs in d.values():
    for x in rs:
        if x.get("state")=="Booted": print(x["udid"]); break
')}"
[ -n "$UDID" ] || { echo "no booted simulator: boot one and run Foxy until it reaches a circuit"; exit 1; }

CONTAINER=$(xcrun simctl get_app_container "$UDID" io.getfoxi.foxy data 2>/dev/null) \
  || { echo "Foxy is not installed on $UDID (sh tools/sim-build.sh first)"; exit 1; }

DATA="$CONTAINER/Library/Application Support/tor"
[ -d "$DATA" ] || { echo "no Tor data directory yet — launch Foxy and wait for a circuit"; exit 1; }

python3 tools/make-tor-seed.py "$DATA" Foxy/TorSeed/tor-microdescs.xz
date -u +"made %Y-%m-%d from a Foxy simulator run" > Foxy/TorSeed/made-at.txt
cat Foxy/TorSeed/made-at.txt
