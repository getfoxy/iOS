#!/usr/bin/env bash
# verify-cashu-ts.sh — prove Web/cashu-ts.js is esbuild's output over the npm
# release of @cashu/cashu-ts 4.11.0 and its pinned dependencies, and nothing else.
#
#     bash tools/vendor/verify-cashu-ts.sh            # registry + rebuild + compare
#     bash tools/vendor/verify-cashu-ts.sh --no-git   # skip the github.com lockfile cross-check
#     bash tools/vendor/verify-cashu-ts.sh --from-source
#                         # also rebuild every bundled file from its git tag (slow: ~5 min)
#     KEEP=1 bash tools/vendor/verify-cashu-ts.sh     # keep the work directory
#
# Needs node, npm, curl, openssl, shasum and (unless --no-git) git. Network:
# registry.npmjs.org, and github.com for the upstream lockfile. Writes only to
# a mktemp directory. See tools/vendor/README.md for what each step proves.
#
# Exits 0 only if every step passes.
set -euo pipefail

NO_GIT=0
FROM_SOURCE=0
for a in "$@"; do
  case "$a" in
    --no-git) NO_GIT=1 ;;
    --from-source) FROM_SOURCE=1 ;;
    *) echo "usage: $0 [--no-git] [--from-source]"; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SHIPPED="$ROOT/Web/cashu-ts.js"

CASHU_VERSION="4.11.0"
UPSTREAM_REPO="https://github.com/cashubtc/cashu-ts.git"
UPSTREAM_TAG="v4.11.0"
UPSTREAM_COMMIT="05f80b726f5f3786418adf38427627fabcafc7d0"
EXPECTED_SHA256="34c1bdabdbb6440ce8d9b18291b95ac8515ec54737d8e17a12e0d43451553d2e"
REGISTRY="https://registry.npmjs.org"

# The runtime inputs of the bundle. esbuild is a build tool, not bundled code,
# but its version decides the output bytes, so it is held to the same checks.
PACKAGES="@cashu/cashu-ts @noble/curves @noble/hashes @scure/base @scure/bip32 esbuild"
BUNDLED="@noble/curves @noble/hashes @scure/base @scure/bip32"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-cashu-ts.XXXXXX")"
if [ "${KEEP:-0}" = "1" ]; then
  echo "work directory kept: $WORK"
else
  trap 'rm -rf "$WORK"' EXIT
fi

fail=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }
step() { printf '\n==> %s\n' "$*"; }

lock_field() {  # lock_field <package> <field>  — read from tools/vendor/package-lock.json
  node -e '
    const l = require(process.argv[1]);
    const e = l.packages["node_modules/" + process.argv[2]] || {};
    process.stdout.write(String(e[process.argv[3]] ?? ""));
  ' "$HERE/package-lock.json" "$1" "$2"
}

step "1. the lockfile agrees with the npm registry"
for p in $PACKAGES; do
  v="$(lock_field "$p" version)"
  li="$(lock_field "$p" integrity)"
  ri="$(npm view "$p@$v" dist.integrity --registry "$REGISTRY" 2>/dev/null || true)"
  if [ -n "$li" ] && [ "$li" = "$ri" ]; then
    ok "$p@$v  ${li:0:30}…"
  else
    bad "$p@$v  lockfile ${li:-<none>}  registry ${ri:-<none>}"
  fi
done

step "2. the cashu-ts tarball, hashed here rather than by npm"
TGZ="$WORK/cashu-ts-$CASHU_VERSION.tgz"
curl -fsSL -o "$TGZ" "$REGISTRY/@cashu/cashu-ts/-/cashu-ts-$CASHU_VERSION.tgz"
got="sha512-$(openssl dgst -sha512 -binary "$TGZ" | base64 | tr -d '\n')"
want="$(lock_field @cashu/cashu-ts integrity)"
if [ "$got" = "$want" ]; then ok "sha512 of the downloaded tarball matches"; else bad "tarball $got, lockfile $want"; fi

if [ "$NO_GIT" = "0" ]; then
  step "3. the dependency versions are the ones cashu-ts's own release lockfile pins"
  git clone -q --depth 1 --branch "$UPSTREAM_TAG" --no-checkout "$UPSTREAM_REPO" "$WORK/upstream" 2>/dev/null
  commit="$(git -C "$WORK/upstream" rev-parse HEAD)"
  if [ "$commit" = "$UPSTREAM_COMMIT" ]; then ok "tag $UPSTREAM_TAG is commit ${commit:0:12}"; else bad "tag $UPSTREAM_TAG is $commit, expected $UPSTREAM_COMMIT"; fi
  git -C "$WORK/upstream" show HEAD:package-lock.json > "$WORK/upstream-lock.json"
  for p in $BUNDLED; do
    node -e '
      const [ours, theirs, p] = process.argv.slice(1);
      const a = require(ours).packages["node_modules/" + p];
      const b = require(theirs).packages["node_modules/" + p];
      if (!a || !b || a.version !== b.version || a.integrity !== b.integrity) {
        console.log("  FAIL  " + p + "  ours " + (a && a.version) + "  upstream " + (b && b.version));
        process.exit(1);
      }
      console.log("  ok    " + p + "@" + a.version + "  same version and integrity as upstream");
    ' "$HERE/package-lock.json" "$WORK/upstream-lock.json" "$p" || fail=$((fail + 1))
  done
else
  step "3. skipped (--no-git)"
fi

step "4. install exactly the lockfile (npm ci verifies every tarball's sha512)"
mkdir -p "$WORK/build"
cp "$HERE/package.json" "$HERE/package-lock.json" "$WORK/build/"
( cd "$WORK/build" && npm ci --ignore-scripts --no-audit --no-fund --registry "$REGISTRY" >/dev/null )
( cd "$WORK/build" && npm ls --all 2>/dev/null | grep -v 'UNMET OPTIONAL' | sed 's/^/        /' )

step "5. rebuild with esbuild 0.25.0, the recipe in tools/rebuild-vendor.sh"
cd "$WORK/build"
printf "export * from '@cashu/cashu-ts';\n" > cashu-entry.js
./node_modules/.bin/esbuild --version | sed 's/^/        esbuild /'
./node_modules/.bin/esbuild cashu-entry.js \
  --bundle --format=iife --global-name=CashuTS \
  --platform=browser --target=es2020 --minify \
  --outfile=cashu-ts.js --log-level=warning

step "6. compare"
built="$(shasum -a 256 cashu-ts.js | cut -d' ' -f1)"
shipped="$(shasum -a 256 "$SHIPPED" | cut -d' ' -f1)"
printf '        built    %s  %s bytes\n' "$built" "$(wc -c < cashu-ts.js | tr -d ' ')"
printf '        shipped  %s  %s bytes\n' "$shipped" "$(wc -c < "$SHIPPED" | tr -d ' ')"
if [ "$built" = "$shipped" ]; then ok "Web/cashu-ts.js is byte-for-byte identical to the rebuild"; else bad "Web/cashu-ts.js differs from the rebuild"; fi
if [ "$shipped" = "$EXPECTED_SHA256" ]; then ok "and matches the hash pinned in Web/VENDOR.md"; else bad "Web/cashu-ts.js is not the hash pinned in Web/VENDOR.md"; fi

step "7. the rebuilt bundle loads and exposes what the wallet uses"
node -e '
  const C = new Function(require("fs").readFileSync(process.argv[1], "utf8") + "; return CashuTS;")();
  const need = ["Wallet", "Mint", "getDecodedToken", "getEncodedToken"];
  const missing = need.filter((n) => typeof C[n] === "undefined");
  if (missing.length) { console.log("  FAIL  missing " + missing.join(", ")); process.exit(1); }
  console.log("  ok    " + Object.keys(C).length + " exports, including " + need.join(", "));
' "$WORK/build/cashu-ts.js" || fail=$((fail + 1))

if [ "$FROM_SOURCE" = "1" ]; then
  # Steps 1-7 trust that what npm serves was built from the public source.
  # This removes that trust: every file esbuild read is rebuilt from its git
  # tag with that repo's own lockfile and compared byte for byte. The list of
  # files comes from esbuild's metafile, so nothing it read is skipped.
  step "8. every bundled file, rebuilt from its git tag"
  ./node_modules/.bin/esbuild cashu-entry.js \
    --bundle --format=iife --global-name=CashuTS \
    --platform=browser --target=es2020 --minify \
    --outfile=/dev/null --metafile=meta.json --log-level=error
  node -e '
    const m = require(process.argv[1]);
    const files = Object.keys(m.inputs).filter((f) => f !== "cashu-entry.js");
    const byPkg = {};
    for (const f of files) {
      const [, pkg, rel] = f.match(/^node_modules\/(@[^/]+\/[^/]+)\/(.+)$/) || [];
      if (!pkg) { console.log("UNEXPECTED " + f); process.exitCode = 1; continue; }
      (byPkg[pkg] ||= []).push(rel);
    }
    for (const [p, rels] of Object.entries(byPkg)) console.log(p + " " + rels.join(" "));
  ' "$WORK/build/meta.json" > "$WORK/inputs.txt" || bad "esbuild read a file outside node_modules/@scope/pkg"
  while read -r pkg rels; do
    case "$pkg" in
      @cashu/cashu-ts) repo="https://github.com/cashubtc/cashu-ts.git"; tag="$UPSTREAM_TAG"; build="npm run compile" ;;
      @noble/curves)   repo="https://github.com/paulmillr/noble-curves.git"; tag="2.4.0"; build="npm run build" ;;
      @noble/hashes)   repo="https://github.com/paulmillr/noble-hashes.git"; tag="2.4.0"; build="npm run build" ;;
      @scure/base)     repo="https://github.com/paulmillr/scure-base.git";   tag="2.4.0"; build="npm run build" ;;
      @scure/bip32)    repo="https://github.com/paulmillr/scure-bip32.git";  tag="2.4.0"; build="npm run build" ;;
      *) bad "$pkg is bundled but has no source recipe here"; continue ;;
    esac
    dir="$WORK/src-${pkg//\//-}"
    printf '        %s  %s@%s  (%s)\n' "$pkg" "${repo#https://github.com/}" "$tag" "$build"
    git clone -q --depth 1 --branch "$tag" "$repo" "$dir" </dev/null 2>/dev/null || { bad "$pkg: clone failed"; continue; }
    ( cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund </dev/null >/dev/null 2>&1 && CI=true $build </dev/null >/dev/null 2>&1 ) \
      || { bad "$pkg: build failed"; continue; }
    for rel in $rels; do
      if cmp -s "$WORK/build/node_modules/$pkg/$rel" "$dir/$rel"; then
        ok "$pkg/$rel"
      else
        bad "$pkg/$rel differs from the build of $tag"
      fi
    done
  done < "$WORK/inputs.txt"
fi

echo
if [ "$fail" = "0" ]; then
  echo "VERIFIED: Web/cashu-ts.js = esbuild 0.25.0 over @cashu/cashu-ts@$CASHU_VERSION and its pinned dependencies"
else
  echo "$fail problem(s)"
fi
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
