#!/bin/sh
# check-all.sh — every check that needs no simulator and no network.
#
#   sh tools/check-all.sh
#
# Smoke, the wallet unit tests, the interleavings, the Tor gate scenarios,
# the seed backup's logic, the NUT-13 vectors and the other spec vectors (tests/vectors),
# and the native seed's Swift tests on this Mac (tools/nativetests: NUT-13,
# BIP-39, the counters and every seed action, no simulator). Without swift they
# say SKIP; FOXY_NATIVE_TESTS=skip skips them where another job runs them.
# Stops at the first failure. Simulator tests are in tools/sim; the live
# test-mint run is tools/live.
#
# It writes no tracked file. Smoke packs the page into a temporary folder and
# compares what it made with Web/index.html, the joined files and the part
# READMEs in the tree; python3 tools/pack-index.py is what writes them (audit
# finding A8). A smoke check that could not look (IPtProxy or Tor not built
# here, as on CI) says SKIP, and smoke's last lines count them.
#
# Each step's exit status decides, not its last line. Piping a step through
# `tail` used to hide it: a test that crashed printed a stack trace's last line
# and this still ended "all checks pass".
cd "$(dirname "$0")/.." || exit 1

# check NAME LINES COMMAND... — run it, show its last LINES lines, stop if it failed
check() {
  name="$1"; lines="$2"; shift 2
  printf '\n== %s\n' "$name"
  log="$(mktemp)"
  "$@" > "$log" 2>/dev/null
  code=$?
  if [ "$code" -ne 0 ]; then
    grep -E "^(FAIL|THREW|WATCHDOG)|Error" "$log" | head -20
    tail -3 "$log"
    rm -f "$log"
    printf '\n%s FAILED (exit %s)\n' "$name" "$code"
    exit 1
  fi
  tail -"$lines" "$log"
  rm -f "$log"
}

# the tests print the warnings they provoke on purpose to stderr; stdout and the
# exit status carry the verdict
# the joined wallet and app class, and the part READMEs, against their parts
check "joined sources" 1 python3 tools/join-sources.py --check
# from a clean git export of HEAD: the three generated files regenerate byte for
# byte (under a second). It checks the commit, not uncommitted edits.
check "shipped files"  1 sh tools/verify-shipped.sh
check "smoke"          3 python3 tools/smoke.py
check "types"          1 node node_modules/typescript/bin/tsc -p tests/types --pretty false --listEmittedFiles
check "app types"      1 node node_modules/typescript/bin/tsc -p tests/types/tsconfig.app.json --pretty false --listEmittedFiles
check "type-check finds" 1 node tests/type-check-finds.js
check "wallet tests"   1 node tests/run.js
check "other units"    1 node tests/units.js
check "interleavings"  1 node tests/interleave.js
check "bridge matrix"  1 node tests/bridge-matrix.js
check "gate scenarios" 1 node tests/gate-scenarios.js
check "home first"     1 node tests/home-first.js
check "two doors"      1 node tests/two-doors.js
check "scan twice"     1 node tests/scan-twice.js
check "change twin"    1 node tests/change-twin.js
check "address kept"   1 node tests/onchain-address-kept.js
check "lock key kept"  1 node tests/lock-key-kept.js
check "lock pool seed" 1 node tests/lock-pool-seed.js
check "refund after kill" 1 node tests/refund-after-kill.js
check "split doors"    1 node tests/split-doors.js
check "p2pk round trip" 1 node tests/p2pk-round-trip.js
check "offline accept" 1 node tests/offline-accept.js
check "net of fee"     1 node tests/net-of-fee.js
check "offline connect" 1 node tests/offline-connect.js
check "offline both"   1 node tests/offline-both.js
check "change leg"     1 node tests/change-leg.js
check "spend offline"  1 node tests/spend-offline.js
check "change recovery" 1 node tests/change-recovery.js
check "audit"          1 node tests/audit.js
check "waiting screens" 1 node tests/waiting-screens.js
check "send fee check" 1 node tests/send-fee-check.js
check "held swap"      1 node tests/held-swap.js
check "kept token"     1 node tests/kept-token.js
check "price terms"    1 node tests/price-terms.js
check "hand-over rules" 1 node tests/handover-rules.js
check "forward locked" 1 node tests/forward-locked.js
check "offline ui"     1 node tests/offline-ui.js
check "locked send lost" 1 node tests/locked-send-lost.js
check "crossings"      1 node tests/crossings.js
check "away claim"     1 node tests/away-claim.js
check "carry cards"    1 node tests/carry-cards.js
check "offline hostile" 1 node tests/offline-hostile.js
check "counter refusal" 1 node tests/counter-refusal.js
check "onchain keypad" 1 node tests/onchain-keypad.js
check "mint busy"      1 node tests/mint-busy.js
check "backup logic"   1 node tests/backup-logic.js
check "card logic"     1 node tests/cards-logic.js
check "pin pad"        1 node tests/pin-pad.js
check "flashcard vectors" 1 node tests/flashcard-vectors.js
check "flashcard model" 1 node tests/flashcard-model.js
check "flashcard clock" 1 node tests/flashcard-clock.js
check "flashcard no pin" 1 node tests/flashcard-nopin.js
check "flashcard change" 1 node tests/flashcard-change.js
check "flashcard owed change" 1 node tests/flashcard-owed.js
check "flashcard setup" 1 node tests/flashcard-setup.js
check "flashcard owner key" 1 node tests/flashcard-owner-vectors.js
check "flashcard money" 1 node tests/flashcard-money.js
check "flashcard one signature" 1 node tests/flashcard-sigall.js
check "flashcard stale lift" 1 node tests/flashcard-stale-lift.js
check "flashcard take back" 1 node tests/flashcard-takeback.js
check "flashcard screens" 1 node tests/flashcard-screens.js
check "flashcard long ids" 1 node tests/flashcard-long-ids.js
check "flashcard switch" 1 node tests/flashcard-switch.js
check "flashcard fewer" 1 node tests/flashcard-fewer.js
check "flashcard release" 1 node tests/flashcard-release.js
check "switch guard"   1 node tests/switch-guard.js
check "transfer quote"  1 node tests/transfer-quote.js
check "on-chain flow"  1 node tests/onchain-flow.js
check "on-chain faults"  1 node tests/onchain-faults.js
check "on-chain watch"  1 node tests/onchain-watch.js
check "on-chain receipt" 1 node tests/onchain-receipt.js
check "watcher re-arms" 1 node tests/watch-rearm.js
check "wallet watch loops" 1 node tests/watch-loop.js
check "address vectors" 1 node tests/address-vectors.js
check "inbox payments"  1 node tests/inbox-payment.js
check "pay this mint"   1 node tests/pay-this-mint.js
check "animated QR"     1 node tests/animated-qr.js
check "receive QR"      1 node tests/receive-qr.js
check "QR readable"     1 node tests/qr-readable.js
check "receive fits"    1 node tests/receive-fits.js
check "tor banner"      1 node tests/tor-banner.js
check "screen log"      1 node tests/screen-log.js
check "claim guards"    1 node tests/claim-guards.js
check "screen lock"     1 node tests/screen-lock.js
check "deep links"      1 node tests/deep-links.js
check "amount entry"    1 node tests/amount-entry.js
check "token watch"     1 node tests/token-watch-speed.js
check "array cap"       1 node tests/array-cap.js
check "mint health"    1 node tests/mint-health.js
check "rider lines"    1 node tests/rider-lines.js
check "rider tap"      1 node tests/rider-tap.js
check "tap offer"      1 node tests/tap-offer.js
check "tap shake"      1 node tests/tap-shake.js
check "tap nearby"     1 node tests/tap-nearby.js
check "tap held"       1 node tests/tap-held.js
check "tap settle"     1 node tests/tap-settle.js
check "tap paid"       1 node tests/tap-paid.js
check "history notes"  1 node tests/history-notes.js
check "cross online"   1 node tests/cross-mint-online-only.js
check "settle quiet"   1 node tests/settle-quiet.js
check "retry/re-arm"   1 node tests/retry-and-rearm.js
check "onion fallback" 1 node tests/onion-fallback.js
check "amountless"     1 node tests/amountless-invoice.js
check "render parity"  1 node tests/render-parity.js
check "render snapshots" 1 node tests/render-snapshots.js
check "seed on the phone, screens" 1 node tests/native-seed-app.js
check "NUT-13 vectors" 1 node tests/nut13-vectors.js
check "spec vectors"   1 node tests/nut-vectors.js
check "fuzz"           1 node tests/fuzz-parsers.js
# XCTest reports on stderr, which check leaves out: keep its count and any error
native_tests() {
  out="$(swift test --package-path tools/nativetests 2>&1)"
  code=$?
  printf '%s\n' "$out" | grep -E "error:|Executed [0-9]+ tests" | tail -20
  return $code
}
if [ "${FOXY_NATIVE_TESTS:-}" = "skip" ]; then
  printf '\n== native Swift tests\nSKIP: FOXY_NATIVE_TESTS=skip (another job runs swift test --package-path tools/nativetests)\n'
elif command -v swift >/dev/null 2>&1; then
  check "native Swift tests" 1 native_tests
else
  printf '\n== native Swift tests\nSKIP: swift is not installed here, so NUT13.swift, BIP39.swift and the counter rules were not tested\n'
fi
printf '\nall checks pass\n'
