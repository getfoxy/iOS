# common.sh — sourced by the simulator scripts in tools/sim.
#
#   ROOT   the repository
#   HERE   tools/sim
#   OUT    where logs and captures go: $FOXY_SIM_OUT, or build/sim-out (gitignored)
#   UDID   the simulator: $FOXY_SIM_UDID, else a booted one, else the first iPhone
#   need_app        sets APP to a signed Debug build (tools/sim-build.sh), unless
#                   $FOXY_APP already names one
#   bridge_ips      writes $OUT/obfs4-ips.txt from the built-in bridge lines
#   relay_ips       writes $OUT/relays-now.txt from the app's cached consensus
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${FOXY_SIM_OUT:-$ROOT/build/sim-out}"
mkdir -p "$OUT"
UDID="${FOXY_SIM_UDID:-$(xcrun simctl list devices booted | grep -oE '[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}' | head -1)}"
[ -n "$UDID" ] || UDID="$(xcrun simctl list devices available | grep -m1 'iPhone' | grep -oE '[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}')"
[ -n "$UDID" ] || { echo "no simulator found; set FOXY_SIM_UDID"; exit 1; }
xcrun simctl boot "$UDID" 2>/dev/null; xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1

need_app() {
  if [ -n "$FOXY_APP" ]; then APP="$FOXY_APP"; return; fi
  APP="$(cd "$ROOT" && sh tools/sim-build.sh "$ROOT/build/sim-dd" | tail -1)"
  [ -d "$APP" ] || { echo "build failed: see $ROOT/build/sim-dd.log"; exit 1; }
}

bridge_ips() {
  grep -oE '"obfs4 [0-9.]+' "$ROOT/Foxy/Tor/Bridges.swift" | awk '{print $2}' | sort -u > "$OUT/obfs4-ips.txt"
}

relay_ips() {
  C="$(xcrun simctl get_app_container "$UDID" io.getfoxi.foxy data 2>/dev/null)"
  CONS="$C/Library/Application Support/tor/cached-microdesc-consensus"
  if [ -f "$CONS" ]; then
    awk '$1=="r"{print $6}' "$CONS" | sort -u > "$OUT/relays-now.txt"
  else
    : > "$OUT/relays-now.txt"
    echo "(no cached consensus yet: launch Foxy once so relays can be told from other hosts)"
  fi
}
