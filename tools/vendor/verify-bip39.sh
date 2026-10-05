#!/usr/bin/env bash
# verify-bip39.sh — prove Web/bip39.js is esbuild's output over the npm release
# of @scure/bip39 2.4.0 and its one dependency, and nothing else.
#
#     bash tools/vendor/verify-bip39.sh                 # registry + rebuild + compare
#     bash tools/vendor/verify-bip39.sh --from-source   # also rebuild every bundled file from git
#     KEEP=1 bash tools/vendor/verify-bip39.sh          # keep the work directory
#
# The same shape as verify-cashu-ts.sh. Web/bip39.js holds the seed code: mnemonic
# generation, validation, the PBKDF2 that turns words into a seed, and the English
# wordlist. The inputs are pinned by version and sha512 in
# tools/vendor/bip39/package-lock.json.
#
# Needs node, npm, curl, openssl, shasum and (for --from-source) git. Network:
# registry.npmjs.org, and github.com for --from-source. Writes only to a mktemp
# directory. Exits 0 only if every step passes.
set -euo pipefail

FROM_SOURCE=0
for a in "$@"; do
  case "$a" in
    --from-source) FROM_SOURCE=1 ;;
    *) echo "usage: $0 [--from-source]"; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
LOCKDIR="$HERE/bip39"
ROOT="$(cd "$HERE/../.." && pwd)"
SHIPPED="$ROOT/Web/bip39.js"

BIP39_VERSION="2.4.0"
EXPECTED_SHA256="6a32952398760a90536a33a836e533273251ec3ef334de8bb2ec0c1993a4dc92"
REGISTRY="https://registry.npmjs.org"
PACKAGES="@scure/bip39 @noble/hashes esbuild"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-bip39.XXXXXX")"
if [ "${KEEP:-0}" = "1" ]; then
  echo "work directory kept: $WORK"
else
  trap 'rm -rf "$WORK"' EXIT
fi

fail=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }
step() { printf '\n==> %s\n' "$*"; }

lock_field() {  # lock_field <package> <field>  — read from tools/vendor/bip39/package-lock.json
  node -e '
    const l = require(process.argv[1]);
    const e = l.packages["node_modules/" + process.argv[2]] || {};
    process.stdout.write(String(e[process.argv[3]] ?? ""));
  ' "$LOCKDIR/package-lock.json" "$1" "$2"
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

step "2. the @scure/bip39 tarball, hashed here rather than by npm"
TGZ="$WORK/bip39-$BIP39_VERSION.tgz"
curl -fsSL -o "$TGZ" "$REGISTRY/@scure/bip39/-/bip39-$BIP39_VERSION.tgz"
got="sha512-$(openssl dgst -sha512 -binary "$TGZ" | base64 | tr -d '\n')"
want="$(lock_field @scure/bip39 integrity)"
if [ "$got" = "$want" ]; then ok "sha512 of the downloaded tarball matches"; else bad "tarball $got, lockfile $want"; fi

step "3. install exactly the lockfile (npm ci verifies every tarball's sha512)"
mkdir -p "$WORK/build"
cp "$LOCKDIR/package.json" "$LOCKDIR/package-lock.json" "$WORK/build/"
( cd "$WORK/build" && npm ci --ignore-scripts --no-audit --no-fund --registry "$REGISTRY" >/dev/null )
( cd "$WORK/build" && npm ls --all 2>/dev/null | grep -v 'UNMET OPTIONAL' | sed 's/^/        /' )

step "4. rebuild with esbuild 0.25.0, the recipe in tools/rebuild-vendor.sh"
cd "$WORK/build"
# the entry names the four functions and the wordlist the wallet uses; a
# tree-shaking bundler leaves the other upstream exports out
cat > bip39-entry.js <<'JS'
export {
  generateMnemonic,
  mnemonicToSeed,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39';
export { wordlist } from '@scure/bip39/wordlists/english.js';
JS
./node_modules/.bin/esbuild --version | sed 's/^/        esbuild /'
ESBUILD_FLAGS="--bundle --format=iife --global-name=FoxyBip39 --platform=browser --target=es2020 --minify"
echo "        flags   $ESBUILD_FLAGS"
# shellcheck disable=SC2086
./node_modules/.bin/esbuild bip39-entry.js $ESBUILD_FLAGS --outfile=bip39.js --log-level=warning

step "5. compare"
built="$(shasum -a 256 bip39.js | cut -d' ' -f1)"
shipped="$(shasum -a 256 "$SHIPPED" | cut -d' ' -f1)"
printf '        entry    %s\n' "$(shasum -a 256 bip39-entry.js | cut -d' ' -f1)"
printf '        built    %s  %s bytes\n' "$built" "$(wc -c < bip39.js | tr -d ' ')"
printf '        shipped  %s  %s bytes\n' "$shipped" "$(wc -c < "$SHIPPED" | tr -d ' ')"
if [ "$built" = "$shipped" ]; then ok "Web/bip39.js is byte-for-byte identical to the rebuild"; else bad "Web/bip39.js differs from the rebuild"; fi
if [ "$shipped" = "$EXPECTED_SHA256" ]; then ok "and matches the hash pinned in Web/VENDOR.md"; else bad "Web/bip39.js is not the hash pinned in Web/VENDOR.md"; fi

step "6. the rebuilt bundle loads, and its wordlist is the npm package's"
node -e '
  const fs = require("fs");
  const B = new Function(fs.readFileSync(process.argv[1], "utf8") + "; return FoxyBip39;")();
  const need = ["generateMnemonic", "mnemonicToSeed", "mnemonicToSeedSync", "validateMnemonic", "wordlist"];
  const missing = need.filter((n) => typeof B[n] === "undefined");
  if (missing.length) { console.log("  FAIL  missing " + missing.join(", ")); process.exit(1); }
  const { wordlist } = require(process.argv[2]);
  if (JSON.stringify(B.wordlist) !== JSON.stringify(wordlist) || wordlist.length !== 2048) {
    console.log("  FAIL  the bundle wordlist is not @scure/bip39/wordlists/english.js"); process.exit(1);
  }
  const m = B.generateMnemonic(B.wordlist, 128);
  if (!B.validateMnemonic(m, B.wordlist)) { console.log("  FAIL  a generated mnemonic does not validate"); process.exit(1); }
  console.log("  ok    exports " + Object.keys(B).sort().join(", ") + "; wordlist 2048 words, same as the package");
' "$WORK/build/bip39.js" "$WORK/build/node_modules/@scure/bip39/wordlists/english.js" || fail=$((fail + 1))

if [ "$FROM_SOURCE" = "1" ]; then
  # Steps 1-6 trust that what npm serves was built from the public source. This
  # rebuilds every file esbuild read from its git tag with that repo's own
  # lockfile and compares byte for byte. The file list comes from esbuild's
  # metafile, so nothing it read is skipped.
  step "7. every bundled file, rebuilt from its git tag"
  # shellcheck disable=SC2086
  ./node_modules/.bin/esbuild bip39-entry.js $ESBUILD_FLAGS \
    --outfile=/dev/null --metafile=meta.json --log-level=error
  node -e '
    const m = require(process.argv[1]);
    const byPkg = {};
    for (const f of Object.keys(m.inputs).filter((f) => f !== "bip39-entry.js")) {
      const [, pkg, rel] = f.match(/^node_modules\/(@[^/]+\/[^/]+)\/(.+)$/) || [];
      if (!pkg) { console.log("UNEXPECTED " + f); process.exitCode = 1; continue; }
      (byPkg[pkg] ||= []).push(rel);
    }
    for (const [p, rels] of Object.entries(byPkg)) console.log(p + " " + rels.join(" "));
  ' "$WORK/build/meta.json" > "$WORK/inputs.txt" || bad "esbuild read a file outside node_modules/@scope/pkg"
  while read -r pkg rels; do
    case "$pkg" in
      @scure/bip39)  repo="https://github.com/paulmillr/scure-bip39.git";  tag="2.4.0" ;;
      @noble/hashes) repo="https://github.com/paulmillr/noble-hashes.git"; tag="2.4.0" ;;
      *) bad "$pkg is bundled but has no source recipe here"; continue ;;
    esac
    dir="$WORK/src-${pkg//\//-}"
    printf '        %s  %s@%s  (npm ci, npm run build)\n' "$pkg" "${repo#https://github.com/}" "$tag"
    git clone -q --depth 1 --branch "$tag" "$repo" "$dir" </dev/null 2>/dev/null || { bad "$pkg: clone failed"; continue; }
    printf '        commit %s\n' "$(git -C "$dir" rev-parse HEAD)"
    ( cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund </dev/null >/dev/null 2>&1 && CI=true npm run build </dev/null >/dev/null 2>&1 ) \
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
  echo "VERIFIED: Web/bip39.js = esbuild 0.25.0 over @scure/bip39@$BIP39_VERSION and @noble/hashes@2.4.0"
else
  echo "$fail problem(s)"
fi
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
