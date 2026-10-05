#!/bin/sh
# verify-iptproxy.sh — rebuild IPtProxy twice from its pinned sources and compare
# both builds with what Vendor/IPtProxy.sha256 records.
#
#     sh tools/vendor/verify-iptproxy.sh
#
# tools/build-iptproxy.sh --check only says whether two builds on this machine
# agree with each other. This runs it and also compares the result with the
# committed checksums, which is the claim that matters: the binary the app links
# is what these sources make, on a machine other than the one that recorded it.
#
# Needs what build-iptproxy.sh needs: Go 1.25 or later, git and Xcode. Network:
# github.com, the Go module proxy, and gitlab.torproject.org (GOPRIVATE, for
# Lyrebird and Snowflake). Two full builds, several minutes. Writes to
# $TMPDIR/foxy-iptproxy-work and a mktemp directory, never to Vendor/.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SUMS="$ROOT/Vendor/IPtProxy.sha256"
LOG=$(mktemp "${TMPDIR:-/tmp}/verify-iptproxy.XXXXXX")
trap 'rm -f "$LOG" "$LOG.sums"' EXIT

go version
sh "$ROOT/tools/build-iptproxy.sh" --check > "$LOG" 2>&1 || { tail -20 "$LOG"; echo "build-iptproxy.sh --check failed"; exit 1; }

grep -E '^[0-9a-f]{64}  \./' "$LOG" > "$LOG.sums" || true
fail=0
if grep -qx IDENTICAL "$LOG"; then
  echo "  ok    two builds are byte-identical"
else
  echo "  FAIL  two builds differ:"; grep -A5 DIFFERENT "$LOG"; fail=1
fi
if cmp -s "$LOG.sums" "$SUMS"; then
  echo "  ok    and both equal Vendor/IPtProxy.sha256:"
  sed 's/^/          /' "$SUMS"
else
  echo "  FAIL  the build does not match Vendor/IPtProxy.sha256"
  echo "        built:";     sed 's/^/          /' "$LOG.sums"
  echo "        committed:"; sed 's/^/          /' "$SUMS"
  fail=1
fi

echo
if [ "$fail" = 0 ]; then
  echo "VERIFIED: IPtProxy rebuilds from the pinned commits to the binaries Vendor/IPtProxy.sha256 records"
else
  echo "IPtProxy does not reproduce"
fi
exit "$fail"
