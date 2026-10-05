#!/usr/bin/env bash
# test-cashu-ts-bundle.sh — run cashu-ts v4.11.0's own node unit tests, first
# against its TypeScript source (the control), then against Foxy's shipped
# Web/cashu-ts.js.
#
#     bash tools/vendor/test-cashu-ts-bundle.sh
#     KEEP=1 bash tools/vendor/test-cashu-ts-bundle.sh   # keep the checkout
#
# Needs node (tested with 24.14.0), npm, git. Network: github.com and the npm
# registry (about 400 dev dependencies). Runs no integration tests and needs
# no mint and no browser download. See tools/vendor/README.md for how to read
# the second result.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# pwd -P: on macOS mktemp returns /var/..., vitest reports /private/var/...
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/test-cashu-ts.XXXXXX")" && pwd -P)"
if [ "${KEEP:-0}" = "1" ]; then echo "work directory kept: $WORK"; else trap 'rm -rf "$WORK"' EXIT; fi

echo "==> clone cashu-ts v4.11.0 and npm ci (its own lockfile)"
git clone -q --depth 1 --branch v4.11.0 https://github.com/cashubtc/cashu-ts.git "$WORK/cashu-ts" 2>/dev/null || exit 1
cd "$WORK/cashu-ts"
echo "        commit $(git rev-parse HEAD)"
CI=true npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || { echo "npm ci failed"; exit 1; }

echo
echo "==> control: the node project against src/"
npx vitest run --project node 2>&1 | grep -E '^\s+(Test Files|Tests)\s'

echo
echo "==> the same tests against Web/cashu-ts.js"
cp "$HERE/vitest.bundle.config.mjs" .
FOXY_BUNDLE="$ROOT/Web/cashu-ts.js" BUNDLE_REPORT="$WORK/bundle-report.json" \
  npx vitest run --config vitest.bundle.config.mjs --reporter=json --outputFile="$WORK/bundle-results.json" >/dev/null 2>&1
node "$HERE/summarize-bundle-tests.js" "$WORK/cashu-ts" "$WORK/bundle-results.json" "$WORK/bundle-report.json" \
  > "$WORK/summary.txt"
rc=$?
grep -v '^A-FILE ' "$WORK/summary.txt"

echo
echo "==> group A alone: must pass with no file from src/ loaded at all"
grep '^A-FILE ' "$WORK/summary.txt" | cut -d' ' -f2 > "$WORK/a-files.txt"
if [ ! -s "$WORK/a-files.txt" ]; then echo "        no group A files found — refusing to report"; exit 1; fi
FOXY_BUNDLE="$ROOT/Web/cashu-ts.js" BUNDLE_REPORT="$WORK/bundle-report-a.json" \
  xargs npx vitest run --config vitest.bundle.config.mjs < "$WORK/a-files.txt" 2>&1 | grep -E '^\s+(Test Files|Tests)\s'
loaded="$(node -e 'console.log((require(process.argv[1]).__src_modules_loaded__ || []).length)' "$WORK/bundle-report-a.json")"
echo "        src/ modules loaded: $loaded"
[ "$loaded" = "0" ] || rc=1
exit $rc
