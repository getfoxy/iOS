#!/usr/bin/env bash
# verify-tor.sh — Tor as Foxy ships it, checked from public sources.
#
#     bash tools/vendor/verify-tor.sh             the sources, the patch, the header fixer and the wrapper
#     bash tools/vendor/verify-tor.sh --rebuild   and a rebuild, compared with Vendor/Tor.sha256
#
# Tor's C library is not the Tor.framework maintainer's
# prebuilt release: tools/build-tor.sh builds it here, into Vendor/TorPod. This
# checks the chain behind that build:
#   1. every source (tor, OpenSSL, libevent, xz) is the commit pinned in
#      build-tor.sh, and its tag carries a valid signature from the pinned key
#   2. Tor.framework's tag v409.11.2 is commit 727f628a, and at that commit its
#      mmap-cache.patch, fix_includes.pl and Objective-C wrapper (Tor/Classes)
#      are the files in Vendor/TorPod, byte for byte
#   3. with --rebuild: Tor built again here is byte for byte the tor.xcframework
#      Vendor/Tor.sha256 records. That holds with the Xcode and autotools the
#      file names; a different Xcode is expected to differ. Tens of minutes.
#
# Needs git, gpg, and for --rebuild what build-tor.sh needs. Network: the four
# source remotes and github.com. Writes to temporary folders; with --rebuild,
# build-tor.sh also builds in the fixed folders /private/tmp/foxy-tor-build and
# /private/tmp/foxy-autotools, and writes build/tor-logs in the repo (and
# build/tor-rebuilt when the rebuild differs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POD="$ROOT/Vendor/TorPod"
TAG=v409.11.2
TAG_COMMIT=727f628a15dd1bd83e0e171deb0aba7ab18be09e
fail=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }

echo "==> 1. the sources"
bash "$ROOT/tools/build-tor.sh" --sources || fail=$((fail + 1))

echo
echo "==> 2. Tor.framework $TAG: the patch, the header fixer and the wrapper"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-tor.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" https://github.com/iCepa/Tor.framework.git "$WORK/tfw"
head="$(git -C "$WORK/tfw" rev-parse HEAD)"
if [ "$head" = "$TAG_COMMIT" ]; then ok "tag $TAG is commit ${TAG_COMMIT:0:12}"; else bad "tag $TAG is $head, expected $TAG_COMMIT"; fi
cmp -s "$WORK/tfw/Tor/mmap-cache.patch" "$POD/mmap-cache.patch" && ok "mmap-cache.patch" || bad "mmap-cache.patch differs"
cmp -s "$WORK/tfw/fix_includes.pl" "$POD/fix_includes.pl" && ok "fix_includes.pl" || bad "fix_includes.pl differs"
theirs="$(cd "$WORK/tfw" && find Tor/Classes/Core Tor/Classes/CTor -type f | LC_ALL=C sort)"
ours="$(cd "$POD" && find Tor -type f | LC_ALL=C sort)"
if [ "$theirs" != "$ours" ]; then
  bad "Vendor/TorPod/Tor does not hold exactly the tag's Tor/Classes/Core and CTor"
else
  n=0
  while IFS= read -r f; do
    cmp -s "$WORK/tfw/$f" "$POD/$f" || { bad "$f differs"; }
    n=$((n + 1))
  done <<<"$ours"
  ok "the Objective-C wrapper, $n files, is the tag's"
fi

if [ "${1:-}" = "--rebuild" ]; then
  echo
  echo "==> 3. a rebuild, compared with Vendor/Tor.sha256"
  out="$(bash "$ROOT/tools/build-tor.sh" --verify 2>&1)" || true
  printf '%s\n' "$out" | tail -6
  printf '%s\n' "$out" | grep -q '^VERIFIED' && ok "the rebuild is the recorded build" || bad "the rebuild is not the recorded build"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "VERIFIED: Tor's sources are signed and pinned, and Vendor/TorPod holds Tor.framework $TAG's patch, header fixer and wrapper"
else
  echo "FAILED: $fail check(s)"
  exit 1
fi
