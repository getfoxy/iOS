#!/usr/bin/env bash
# verify-qrcode.sh — Web/qrcode.js is dist/qrcode.js of the npm release
# qrcode-generator@2.0.4 (Kazuhiko Arase), byte for byte, and the same file is
# committed at that release's git tag.
#
#     bash tools/vendor/verify-qrcode.sh
#
# Web/qrcode.js has no build step of Foxy's: it is the library's own
# distribution file, used as it comes. Its header names "QR Code Generator for
# JavaScript, Copyright (c) 2009 Kazuhiko Arase, MIT"; that library is published
# on npm as qrcode-generator. Of the package's 24 releases, dist/qrcode.js (or
# qrcode.js before 1.5.1) is 56,694 bytes in 1.4.4 through 2.0.4, and only
# 2.0.4's hashes to the shipped file.
#
# Checks:
#   1. the registry's dist.integrity for qrcode-generator@2.0.4 is the sha512
#      pinned below, and the downloaded tarball hashes to it (openssl)
#   2. package/dist/qrcode.js in that tarball is byte-for-byte Web/qrcode.js
#   3. the tarball's gitHead is the commit tag js2.0.4 names, and js/dist/qrcode.js
#      at that commit on github.com is the same bytes
#
# Not checked: js/dist/qrcode.js is committed to the upstream repo as a file,
# and this does not regenerate it from anything. The library touches no key
# material; it draws invoices and tokens as QR codes.
#
# Needs curl, openssl, shasum, tar, npm and git. Network: registry.npmjs.org,
# github.com, raw.githubusercontent.com. Writes only to a mktemp directory.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SHIPPED="$ROOT/Web/qrcode.js"

PKG="qrcode-generator"
VERSION="2.0.4"
INTEGRITY="sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g=="
TAG="js2.0.4"
COMMIT="83b7e8fe3fddd3b0368dbafd6ce56995bd25e3c8"
UPSTREAM="kazuhikoarase/qrcode-generator"
EXPECTED_SHA256="79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c"
REGISTRY="https://registry.npmjs.org"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-qrcode.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }
step() { printf '\n==> %s\n' "$*"; }

step "1. the npm release"
ri="$(npm view "$PKG@$VERSION" dist.integrity --registry "$REGISTRY" 2>/dev/null || true)"
if [ "$ri" = "$INTEGRITY" ]; then ok "registry dist.integrity is the pinned sha512"; else bad "registry ${ri:-<none>}, pinned $INTEGRITY"; fi
curl -fsSL -o "$WORK/pkg.tgz" "$REGISTRY/$PKG/-/$PKG-$VERSION.tgz"
got="sha512-$(openssl dgst -sha512 -binary "$WORK/pkg.tgz" | base64 | tr -d '\n')"
if [ "$got" = "$INTEGRITY" ]; then ok "sha512 of the downloaded tarball matches (openssl)"; else bad "tarball $got"; fi
tar -xzf "$WORK/pkg.tgz" -C "$WORK"

step "2. compare with Web/qrcode.js"
npm_sha="$(shasum -a 256 "$WORK/package/dist/qrcode.js" | cut -d' ' -f1)"
shipped="$(shasum -a 256 "$SHIPPED" | cut -d' ' -f1)"
printf '        npm      %s  %s bytes  package/dist/qrcode.js\n' "$npm_sha" "$(wc -c < "$WORK/package/dist/qrcode.js" | tr -d ' ')"
printf '        shipped  %s  %s bytes  Web/qrcode.js\n' "$shipped" "$(wc -c < "$SHIPPED" | tr -d ' ')"
if cmp -s "$WORK/package/dist/qrcode.js" "$SHIPPED"; then ok "Web/qrcode.js is byte-for-byte the npm file"; else bad "Web/qrcode.js differs from $PKG@$VERSION dist/qrcode.js"; fi
if [ "$shipped" = "$EXPECTED_SHA256" ]; then ok "and matches the hash pinned in Web/VENDOR.md"; else bad "Web/qrcode.js is not the hash pinned in Web/VENDOR.md"; fi

step "3. the same file at the git tag"
head="$(npm view "$PKG@$VERSION" gitHead --registry "$REGISTRY" 2>/dev/null || true)"
tag="$(git ls-remote "https://github.com/$UPSTREAM.git" "refs/tags/$TAG" | cut -f1)"
if [ "$head" = "$COMMIT" ] && [ "$tag" = "$COMMIT" ]; then
  ok "npm gitHead and tag $TAG are both commit ${COMMIT:0:12}"
else
  bad "npm gitHead ${head:-<none>}, tag $TAG ${tag:-<none>}, expected $COMMIT"
fi
curl -fsSL -o "$WORK/git-qrcode.js" "https://raw.githubusercontent.com/$UPSTREAM/$COMMIT/js/dist/qrcode.js"
if cmp -s "$WORK/git-qrcode.js" "$SHIPPED"; then ok "js/dist/qrcode.js at ${COMMIT:0:12} is the same bytes"; else bad "js/dist/qrcode.js at $COMMIT differs"; fi

echo
if [ "$fail" = "0" ]; then
  echo "VERIFIED: Web/qrcode.js = $PKG@$VERSION dist/qrcode.js, unmodified, as committed at tag $TAG"
else
  echo "$fail problem(s)"
fi
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
