#!/usr/bin/env bash
# rebuild-vendor.sh — rebuild the vendored libraries, so they can be checked.
#
#     bash tools/rebuild-vendor.sh
#
#     bash tools/rebuild-vendor.sh --adopt
#
# To CHECK what ships, use tools/vendor/verify-cashu-ts.sh and
# tools/vendor/verify-bip39.sh instead. They build with the same flags as this
# script, but from lockfiles pinned by sha512 (tools/vendor/package-lock.json,
# tools/vendor/bip39/package-lock.json). This script installs by version only,
# so a registry change could reach it. Both matched byte for byte when compared.
# qrcode.js is checked by tools/vendor/verify-qrcode.sh.
#
# THE PROBLEM THIS ADDRESSES
#
# Web/cashu-ts.js, Web/bip39.js and Web/qrcode.js are not npm artifacts. Each
# is an esbuild bundle wrapped in a global, built on someone's laptop, and the
# command that produced it was never written down. Web/VENDOR.md identifies
# what is inside them by content — every string and export of
# @cashu/cashu-ts@4.11.0 is present, the BIP-39 wordlist matches upstream word
# for word — but identification is not verification. Nobody can prove those
# files contain ONLY upstream code.
#
# This script is the missing recipe. It pins the inputs, builds them the same
# way every time, and diffs the result against what ships. Verification stops
# being an argument and becomes a command.
#
# HONEST LIMITS
#
# The original build commands are lost, so these are reconstructed from the
# shape of the output: the global names, the tree-shaking visible in bip39,
# and the bundled dependencies visible in cashu-ts. A first run will very
# likely NOT match byte-for-byte — esbuild version, minify settings and target
# all change the output.
#
# That is still worth having. A diff that is small and explainable (different
# esbuild version, different banner) is evidence. A diff that contains code
# nobody recognises is the thing this exists to find.
#
# --adopt CLOSES IT THE OTHER WAY
#
# Reverse-engineering flags to match a build whose recipe was lost is guesswork
# with no end: the gap sat at 0.5% for cashu-ts and 4.4% for bip39, and every
# candidate flag set is a guess about what someone typed once.
#
# --adopt inverts the problem. It copies what this script builds into Web/,
# replacing the bundles nobody can account for with bundles this file's own
# recipe produces. After that, reproducibility is true by construction: run the
# script again on any machine and it matches, because the recipe and the
# artifact came from the same place.
#
# Costs of doing that, plainly: the shipped code changes, so everything that
# touches money must be re-tested. And the new files are only as trustworthy as
# npm and the pinned versions — which is the same trust as before, but now
# stated rather than inherited from a laptop.
#
# Requires node and npx. Writes to /tmp, never to Web/.

# Errors are not hidden. An earlier version sent every command's output to
# /dev/null, so when esbuild failed the script simply stopped after "installing
# pinned inputs" with no reason given. A build-verification tool that fails
# quietly is worse than none.
set -uo pipefail

ADOPT=0
if [ "${1:-}" = "--adopt" ]; then ADOPT=1; fi

CASHU_VERSION="4.11.0"
BIP39_VERSION="2.4.0"
ESBUILD_VERSION="0.25.0"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "building in $WORK"
cd "$WORK"
npm init -y >/dev/null

echo "==> installing pinned inputs (this takes a minute)"
npm install \
  "@cashu/cashu-ts@${CASHU_VERSION}" \
  "@scure/bip39@${BIP39_VERSION}" \
  "esbuild@${ESBUILD_VERSION}" 2>&1 | tail -3

# ---- cashu-ts, as the global CashuTS -------------------------------------

cat > cashu-entry.js <<'JS'
export * from '@cashu/cashu-ts';
JS

echo
echo "==> bundling cashu-ts"
npx esbuild cashu-entry.js \
  --bundle --format=iife --global-name=CashuTS \
  --platform=browser --target=es2020 --minify \
  --outfile=cashu-ts.js

# ---- bip39, as the global FoxyBip39, tree-shaken to what the wallet uses --
#
# The shipped bundle exports four of the seven upstream functions:
# generateMnemonic, mnemonicToSeed, mnemonicToSeedSync, validateMnemonic,
# plus the English wordlist. The other three are absent, which is what a
# tree-shaking bundler does with an entry point that names only these.

cat > bip39-entry.js <<'JS'
export {
  generateMnemonic,
  mnemonicToSeed,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39';
export { wordlist } from '@scure/bip39/wordlists/english.js';
JS

echo
echo "==> bundling bip39"
npx esbuild bip39-entry.js \
  --bundle --format=iife --global-name=FoxyBip39 \
  --platform=browser --target=es2020 --minify \
  --outfile=bip39.js

# The wordlist subpath needs its .js extension: @scure/bip39's exports map
# lists "./wordlists/english.js" and nothing resolves without it.

# ---- the comparison ------------------------------------------------------

echo
echo "==> comparing against what ships"
for f in cashu-ts.js bip39.js; do
  if [ ! -f "$ROOT/Web/$f" ]; then
    echo "  $f: not in Web/, skipping"
    continue
  fi
  built=$(wc -c < "$f" | tr -d ' ')
  shipped=$(wc -c < "$ROOT/Web/$f" | tr -d ' ')
  bh=$(shasum -a 256 "$f" | cut -d' ' -f1)
  sh=$(shasum -a 256 "$ROOT/Web/$f" | cut -d' ' -f1)
  printf '  %-14s built %9s  shipped %9s  ' "$f" "$built" "$shipped"
  if [ "$bh" = "$sh" ]; then
    echo "IDENTICAL"
  else
    echo "differ"
    echo "      built   $bh"
    echo "      shipped $sh"
    echo "      diff:   diff <(node -e \"console.log(require('fs').readFileSync('$WORK/$f','utf8'))\") \\"
    echo "                   <(node -e \"console.log(require('fs').readFileSync('$ROOT/Web/$f','utf8'))\")"
  fi
done

echo
echo "qrcode.js is not built here — it is the Kazuhiko Arase library, a single"
echo "file with no build step. It is identified in Web/VENDOR.md by content and"
echo "touches no key material."
if [ "$ADOPT" = "1" ]; then
  echo
  echo "==> adopting: replacing Web/ with what this script built"
  echo
  echo "    The bundles in Web/ were built by a command nobody recorded, so no"
  echo "    rebuild can be expected to match them. Replacing them with this"
  echo "    script's output makes the recipe and the artifact the same thing."
  echo
  for f in cashu-ts.js bip39.js; do
    if [ ! -f "$f" ]; then
      echo "    $f was not built — refusing to adopt an incomplete set"
      exit 1
    fi
    # a bundle that lost its global is a bundle nothing can use
    if ! grep -q "CashuTS\|FoxyBip39" "$f"; then
      echo "    $f has no global name — refusing"
      exit 1
    fi
  done

  # the checks that matter, before anything is overwritten
  if ! node -e "
    const fs = require('fs');
    const C = new Function(fs.readFileSync('$WORK/cashu-ts.js','utf8') + '; return CashuTS;')();
    for (const n of ['Wallet', 'Mint', 'getDecodedToken', 'getEncodedToken']) {
      if (typeof C[n] === 'undefined') throw new Error('cashu-ts is missing ' + n);
    }
    console.log('    cashu-ts exports Wallet, Mint, getDecodedToken, getEncodedToken');
  "; then
    echo "    a bundle does not load, or is missing an export — refusing"
    exit 1
  fi

  # the BIP-39 wordlist is the one thing here that a wrong build would ruin
  # silently: a seed derived from a different list restores to nothing
  # esbuild's iife declares `var FoxyBip39 = ...` inside the bundle's own
  # scope — it does not attach to globalThis — so the name has to be returned
  # rather than read off an object. Getting this wrong made the check fail on
  # a bundle that was perfectly good.
  if ! node -e "
    const fs = require('fs');
    const B = new Function(fs.readFileSync('$WORK/bip39.js','utf8') + '; return FoxyBip39;')();
    const wl = B.wordlist;
    if (!Array.isArray(wl) || wl.length !== 2048) throw new Error('wordlist is not 2048 words');
    if (wl[0] !== 'abandon' || wl[2047] !== 'zoo') throw new Error('wordlist does not match BIP-39');
    const m = B.generateMnemonic(wl, 128);
    if (m.split(' ').length !== 12) throw new Error('generateMnemonic did not return 12 words');
    if (!B.validateMnemonic(m, wl)) throw new Error('a generated mnemonic does not validate');
    console.log('    wordlist 2048 words abandon..zoo; a generated mnemonic validates');
  "; then
    echo "    the wordlist check failed — refusing"
    exit 1
  fi

  for f in cashu-ts.js bip39.js; do
    cp "$ROOT/Web/$f" "$ROOT/Web/$f.was" 2>/dev/null || true
    cp "$f" "$ROOT/Web/$f"
    echo "    $f  $(shasum -a 256 "$ROOT/Web/$f" | cut -d' ' -f1)"
  done

  echo
  echo "    The previous files are beside them as .was — delete those once you"
  echo "    are satisfied, or restore them with git checkout Web/."
  echo
  echo "    NOW: record the new hashes in Web/VENDOR.md, run"
  echo "    python3 tools/verify-vendor.py, and re-test everything that moves"
  echo "    money. The shipped code has changed."
else
  echo
  echo "Run again with --adopt to replace Web/ with what this script built."
  echo "That makes the recipe and the artifact the same thing, so every later"
  echo "rebuild matches — rather than chasing flags to reproduce a build whose"
  echo "command was lost."
fi
