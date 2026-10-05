#!/bin/sh
# build-iptproxy.sh — IPtProxy (obfs4 and Snowflake for Tor), built from source.
#
#     sh tools/build-iptproxy.sh           build Vendor/IPtProxy.xcframework
#     sh tools/build-iptproxy.sh --check   build twice and say whether they match
#
# Bridges run inside Foxy, next to the wallet. The prebuilt IPtProxy from
# CocoaPods is a binary nobody here can check, which is the property
# Web/VENDOR.md and tools/rebuild-vendor.sh exist to establish for the page's
# libraries. So it is built here from pinned sources, and what ships is what
# this script produced.
#
# Needs Go 1.25 or later ("brew install go"), git and Xcode.

set -eu

IPTPROXY_COMMIT=d25ce337c619b5f70ca2cf460f441b2a39a58aa6   # IPtProxy 5.5 (Lyrebird, Snowflake 2.14.1)
DNSTT_COMMIT=f1b9b97a269f83bad41d2ceef291b4d2c161cd11      # the dnstt build.sh pins
MOBILE_VERSION=v0.0.0-20260908204917-8b95e45f8d3e          # gomobile and gobind, not @latest

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/Vendor/IPtProxy.xcframework"
SUMS="$ROOT/Vendor/IPtProxy.sha256"

for tool in go git xcrun; do
  command -v "$tool" >/dev/null 2>&1 || { echo "--- $tool is required"; exit 1; }
done

# The same paths on every run. gomobile compiles C in a temporary folder and
# that folder's name ends up inside the objects, and ar records timestamps, so
# two builds from identical sources differed until both were pinned.
WORK="${TMPDIR:-/tmp}/foxy-iptproxy-work"

build_into() {
  dest=$1
  work="$WORK"
  rm -rf "$work"; mkdir -p "$work/tmp"
  export GOBIN="$work/bin" GOPRIVATE=gitlab.torproject.org GOTOOLCHAIN=local
  export TMPDIR="$work/tmp" ZERO_AR_DATE=1 SOURCE_DATE_EPOCH=0
  export CGO_CFLAGS="-g0 -O2 -ffile-prefix-map=$work=/iptproxy -fdebug-prefix-map=$work=/iptproxy"
  PATH="$GOBIN:$PATH"; export PATH

  git clone -q https://github.com/tladesignz/IPtProxy.git "$work/IPtProxy"
  git -C "$work/IPtProxy" checkout -q "$IPTPROXY_COMMIT"
  git clone -q https://github.com/tladesignz/dnstt.git "$work/IPtProxy/dnstt"
  git -C "$work/IPtProxy/dnstt" checkout -q "$DNSTT_COMMIT"

  go install "golang.org/x/mobile/cmd/gomobile@$MOBILE_VERSION" "golang.org/x/mobile/cmd/gobind@$MOBILE_VERSION"
  gomobile init

  rm -rf "$dest"
  ( cd "$work/IPtProxy/IPtProxy.go" &&
    MACOSX_DEPLOYMENT_TARGET=11.0 gomobile bind -target=ios,iossimulator \
      -ldflags="-s -w -checklinkname=0 -buildid=" -trimpath -tags=netcgo \
      -iosversion=15.0 -o "$dest" )
  rm -rf "$work"
}

sums() {
  ( cd "$1" && find . -type f -path '*.framework/IPtProxy' | LC_ALL=C sort | xargs shasum -a 256 )
}

if [ "${1:-}" = "--check" ]; then
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/foxy-iptproxy-check.XXXXXX")
  build_into "$tmp/a/IPtProxy.xcframework"
  build_into "$tmp/b/IPtProxy.xcframework"
  sums "$tmp/a/IPtProxy.xcframework" > "$tmp/a.sum"
  sums "$tmp/b/IPtProxy.xcframework" > "$tmp/b.sum"
  cat "$tmp/a.sum"
  if cmp -s "$tmp/a.sum" "$tmp/b.sum"; then echo "IDENTICAL"; else echo "DIFFERENT"; diff "$tmp/a.sum" "$tmp/b.sum" || true; fi
  rm -rf "$tmp"
  exit 0
fi

build_into "$OUT"
sums "$OUT" > "$SUMS"
echo "--- built $OUT"
cat "$SUMS"
