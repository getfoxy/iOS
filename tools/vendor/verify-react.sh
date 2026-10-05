#!/usr/bin/env bash
# verify-react.sh — the React and ReactDOM embedded in Web/index.html are the npm
# releases' UMD production files, byte for byte.
#
#     bash tools/vendor/verify-react.sh             # against npm
#     bash tools/vendor/verify-react.sh --rebuild   # and rebuilt from React's signed tag
#
# Web/index.html carries React and ReactDOM as gzipped base64 in its
# __bundler/manifest, not as files. This decodes those two entries, downloads
# react@18.3.1 and react-dom@18.3.1 from the npm registry, checks each tarball's
# sha512 against the registry's dist.integrity and against the value pinned
# below (computed here with openssl, not by npm), and compares the decoded
# bytes with umd/react.production.min.js and umd/react-dom.production.min.js.
#
# --rebuild then builds both files from React's source and compares them with the
# embedded bytes, so the chain no longer stops at "what npm publishes":
#   - Node 14.17.6, the version React's .nvmrc names, from nodejs.org: its
#     SHASUMS256.txt is signed by a Node release key (keys/node-release-myles-
#     borins.asc, from github.com/nodejs/release-keys; expired since, valid when
#     it signed) and the tarball's hash is pinned here too. Apple silicon runs
#     the Intel build under Rosetta; Linux x64 uses its own.
#   - yarn 1.22.22 from npm, at its pinned sha512.
#   - React's tag v18.3.1, which must be commit f1338f80, whose SSH signature
#     must verify against Andrew Clark's signing key (keys/react-andrew-
#     clark.allowed_signers, from api.github.com/users/acdlite/ssh_signing_keys).
#     npm lists another gitHead (a87edf62, on main, where the publish ran); the
#     built files name f1338f8080 themselves.
#   - yarn install --frozen-lockfile, then React's own release script,
#     build-all-release-channels.js, for the two UMD production bundles. It
#     stamps a version from the commit's short hash and date, so git abbreviates
#     to 10 characters, as in React's CI clone, and the date is read in UTC.
#   - oss-stable-semver/{react,react-dom}/umd/*.production.min.js, byte for byte
#     against the embedded copies. ReactDOM as published calls itself
#     18.3.1-next-f1338f8080-20240426; the rebuild does too.
# Checked on macOS (Java 25) with both files identical; React's CI
# used Java 17, and Closure Compiler's output did not change.
#
# Needs node, curl, openssl, shasum, tar and python3. --rebuild also needs git
# (2.34 or later, for SSH signatures), gpg, java, about a gigabyte of disk and a
# few minutes; on Apple silicon, Rosetta. Network: registry.npmjs.org, and for
# --rebuild nodejs.org, github.com and registry.yarnpkg.com. Writes only to a
# mktemp directory. Exits 0 only if every step passes.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REGISTRY="https://registry.npmjs.org"
VERSION="18.3.1"
REBUILD=0
case "${1:-}" in
  "") ;;
  --rebuild) REBUILD=1 ;;
  *) echo "usage: bash tools/vendor/verify-react.sh [--rebuild]"; exit 2 ;;
esac

# --rebuild pins
NODE_VERSION="14.17.6"
NODE_SIGNER="C4F0DFFF4E8C1A8236409D08E73BC641CC11F4C8"   # Myles Borins, Node release key
NODE_SHA_DARWIN_X64="e3e4c02240d74fb1dc8a514daa62e5de04f7eaee0bcbca06a366ece73a52ad88"
NODE_SHA_LINUX_X64="19e376214450e93e58687198070b4ab46e42357032ec65f23a7e35b0e86ad6e2"
YARN_VERSION="1.22.22"
YARN_SRI="sha512-prL3kGtyG7o9Z9Sv8IPfBNrWTDmXB4Qbes8A9rEzt6wkJV8mUvoirjU0Mp3GGAU06Y0XQyA3/2/RQFVuK7MTfg=="
REACT_TAG="v18.3.1"
REACT_COMMIT="f1338f8080abd1386454a10bbf93d67bfe37ce85"
REACT_SIGNER="git@andrewclark.io"

# package  manifest uuid  file in the tarball  tarball sha512  file sha256
ROWS="react 8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047 umd/react.production.min.js sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ== d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd
react-dom 93c76fbd-259d-463c-a60d-5ed97ad7e690 umd/react-dom.production.min.js sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw== 35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-react.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }
step() { printf '\n==> %s\n' "$*"; }

step "1. decode the two scripts from Web/index.html's manifest"
python3 - "$ROOT/Web/index.html" "$WORK" <<'PY'
import base64, gzip, json, sys
h = open(sys.argv[1], encoding='utf-8', newline='').read()
tag = '<script type="__bundler/manifest">'
a = h.index(tag) + len(tag)
man = json.loads(h[a:h.index('</script>', a)].strip())
for uuid in ('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047', '93c76fbd-259d-463c-a60d-5ed97ad7e690'):
    e = man[uuid]
    raw = base64.b64decode(e['data'])
    if e.get('compressed'):
        raw = gzip.decompress(raw)
    open('%s/%s.embedded.js' % (sys.argv[2], uuid), 'wb').write(raw)
    print('        %s  %d bytes' % (uuid[:8], len(raw)))
PY

while read -r pkg uuid file sri sha; do
  step "2. $pkg@$VERSION"
  ri="$(npm view "$pkg@$VERSION" dist.integrity --registry "$REGISTRY" 2>/dev/null || true)"
  if [ "$ri" = "$sri" ]; then ok "registry dist.integrity is the pinned sha512"; else bad "registry ${ri:-<none>}, pinned $sri"; fi
  tgz="$WORK/$pkg.tgz"
  curl -fsSL -o "$tgz" "$REGISTRY/$pkg/-/$pkg-$VERSION.tgz"
  got="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 | tr -d '\n')"
  if [ "$got" = "$sri" ]; then ok "sha512 of the downloaded tarball matches (openssl)"; else bad "tarball $got"; fi
  mkdir -p "$WORK/$pkg"
  tar -xzf "$tgz" -C "$WORK/$pkg"
  npm_sha="$(shasum -a 256 "$WORK/$pkg/package/$file" | cut -d' ' -f1)"
  emb_sha="$(shasum -a 256 "$WORK/$uuid.embedded.js" | cut -d' ' -f1)"
  printf '        npm       %s  %s\n' "$npm_sha" "package/$file"
  printf '        embedded  %s  manifest %s\n' "$emb_sha" "${uuid:0:8}"
  if cmp -s "$WORK/$pkg/package/$file" "$WORK/$uuid.embedded.js"; then
    ok "the embedded copy is byte-for-byte the npm file"
  else
    bad "the embedded copy differs from the npm file"
  fi
  if [ "$emb_sha" = "$sha" ]; then ok "and is the hash pinned in tools/verify-vendor.py"; else bad "not the pinned hash $sha"; fi
done <<EOF
$ROWS
EOF

if [ "$REBUILD" = "1" ]; then
  RB="$WORK/rebuild"; mkdir -p "$RB"
  step "3. Node $NODE_VERSION, from a signed checksum list"
  case "$(uname -s)-$(uname -m)" in
    Darwin-*)     node_os="darwin-x64"; node_sha="$NODE_SHA_DARWIN_X64" ;;   # Rosetta on Apple silicon
    Linux-x86_64) node_os="linux-x64";  node_sha="$NODE_SHA_LINUX_X64" ;;
    *) bad "no pinned Node $NODE_VERSION build for $(uname -sm)"; node_os="" ;;
  esac
  if [ -n "$node_os" ]; then
    base="https://nodejs.org/dist/v$NODE_VERSION"
    curl -fsSL -o "$RB/SHASUMS256.txt.asc" "$base/SHASUMS256.txt.asc"
    # a short path: gpg-agent's socket lives here, and macOS caps socket paths
    # near 104 characters, which a home under $TMPDIR/verify-react.XXXXXX passed
    gpghome="$(mktemp -d /tmp/foxy-gpg.XXXXXX)"
    trap 'rm -rf "$WORK" "${gpghome:-}"' EXIT
    export GNUPGHOME="$gpghome"
    gpg --quiet --import "$HERE/keys/node-release-myles-borins.asc" 2>/dev/null || true   # the signature check below decides
    status="$(gpg --status-fd 1 --verify "$RB/SHASUMS256.txt.asc" 2>/dev/null || true)"
    primary="$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $12 }')"
    if [ "$primary" = "$NODE_SIGNER" ] && printf '%s\n' "$status" | grep -qE '^\[GNUPG:\] (GOODSIG|EXPKEYSIG) '; then
      ok "SHASUMS256.txt is signed by the pinned Node release key (${NODE_SIGNER:0:16}…)"
    else
      bad "SHASUMS256.txt is not signed by the pinned Node release key"
    fi
    listed="$(gpg --decrypt "$RB/SHASUMS256.txt.asc" 2>/dev/null | awk -v f="node-v$NODE_VERSION-$node_os.tar.gz" '$2 == f { print $1 }')"
    gpgconf --kill gpg-agent 2>/dev/null || true
    unset GNUPGHOME
    if [ "$listed" = "$node_sha" ]; then ok "the signed list gives node-v$NODE_VERSION-$node_os the pinned sha256"; else bad "signed list ${listed:-<none>}, pinned $node_sha"; fi
    curl -fsSL -o "$RB/node.tar.gz" "$base/node-v$NODE_VERSION-$node_os.tar.gz"
    if [ "$(shasum -a 256 "$RB/node.tar.gz" | cut -d' ' -f1)" = "$node_sha" ]; then ok "the downloaded tarball has it"; else bad "the downloaded Node tarball does not match"; fi
    tar -xzf "$RB/node.tar.gz" -C "$RB"
    NODEBIN="$RB/node-v$NODE_VERSION-$node_os/bin"
  fi

  step "4. yarn $YARN_VERSION"
  curl -fsSL -o "$RB/yarn.tgz" "$REGISTRY/yarn/-/yarn-$YARN_VERSION.tgz"
  got="sha512-$(openssl dgst -sha512 -binary "$RB/yarn.tgz" | base64 | tr -d '\n')"
  if [ "$got" = "$YARN_SRI" ]; then ok "sha512 of the tarball is the pinned one"; else bad "yarn tarball $got"; fi
  mkdir -p "$RB/yarn" && tar -xzf "$RB/yarn.tgz" -C "$RB/yarn"

  step "5. React $REACT_TAG, a signed commit"
  git clone -q -c advice.detachedHead=false --depth 1 --branch "$REACT_TAG" https://github.com/facebook/react.git "$RB/react"
  head="$(git -C "$RB/react" rev-parse HEAD)"
  if [ "$head" = "$REACT_COMMIT" ]; then ok "$REACT_TAG is commit ${REACT_COMMIT:0:12}"; else bad "$REACT_TAG is $head, pinned $REACT_COMMIT"; fi
  sig="$(git -C "$RB/react" -c gpg.ssh.allowedSignersFile="$HERE/keys/react-andrew-clark.allowed_signers" verify-commit HEAD 2>&1 || true)"
  if printf '%s\n' "$sig" | grep -q "^Good \"git\" signature for $REACT_SIGNER "; then
    ok "its SSH signature is good, from $REACT_SIGNER's pinned key"
  else
    bad "its signature does not verify against the pinned key: $(printf '%s' "$sig" | head -1)"
  fi

  if [ "$fail" = "0" ]; then
    step "6. yarn install --frozen-lockfile, then React's release build"
    # Node 14 and the system's tools only; Closure Compiler needs java
    PATH="$NODEBIN:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH TZ=UTC
    if ! java -version >/dev/null 2>&1; then bad "no java runtime, which React's Closure Compiler needs"; fi
    printf '        node %s, %s\n' "$(node --version)" "$(java -version 2>&1 | head -1)"
    ( cd "$RB/react" && node "$RB/yarn/package/bin/yarn.js" install --frozen-lockfile --non-interactive ) > "$RB/install.log" 2>&1 \
      && ok "dependencies installed from React's yarn.lock" || { tail -15 "$RB/install.log"; bad "yarn install failed"; }
    git -C "$RB/react" config core.abbrev 10
    ( cd "$RB/react" && node ./scripts/rollup/build-all-release-channels.js react/index,react-dom/index --type=UMD_PROD ) > "$RB/build.log" 2>&1 \
      && ok "build-all-release-channels.js react/index,react-dom/index --type=UMD_PROD" || { tail -15 "$RB/build.log"; bad "React's release build failed"; }

    step "7. the rebuilt files against the embedded copies"
    while read -r pkg uuid file sri sha; do
      built="$RB/react/build/oss-stable-semver/$pkg/$file"
      printf '        rebuilt   %s  %s\n' "$( [ -f "$built" ] && shasum -a 256 "$built" | cut -d' ' -f1 || echo '<missing>')" "oss-stable-semver/$pkg/$file"
      if [ -f "$built" ] && cmp -s "$built" "$WORK/$uuid.embedded.js"; then
        ok "$pkg: the rebuild is byte-for-byte the embedded copy"
      else
        bad "$pkg: the rebuild differs from the embedded copy"
      fi
    done <<EOF
$ROWS
EOF
  fi
fi

echo
if [ "$fail" = "0" ] && [ "$REBUILD" = "1" ]; then
  echo "VERIFIED: the React and ReactDOM in Web/index.html are react@$VERSION and react-dom@$VERSION from npm, and React's release build of its signed tag $REACT_TAG makes them byte for byte"
elif [ "$fail" = "0" ]; then
  echo "VERIFIED: the React and ReactDOM in Web/index.html are react@$VERSION and react-dom@$VERSION from npm, byte for byte"
else
  echo "$fail problem(s)"
fi
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
