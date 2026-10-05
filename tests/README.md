# tests

```
npm ci                                   # jsdom and typescript, pinned in package-lock.json
node tests/run.js
```

`sh tools/check-all.sh` runs these with smoke and the other offline checks, and
is the list of what runs: this file describes some of the suites, not all. It
writes no tracked file: smoke packs the page into a temporary folder and
compares, and `python3 tools/pack-index.py` is what regenerates
`Web/foxy-wallet.js` and `Web/index.html` after a part changes. Smoke checks
15 and 18 say SKIP, counted in its summary, where IPtProxy or Tor is not built
(always, on CI): a SKIP is not a pass.

Third-party files that only tests use are pinned by size and SHA-256 in
`python3 tools/verify-vendor.py` (and so in every `check-all`):
`tools/acorn/` (acorn 8.18.0, MIT, for `tools/check-undefined.js`) and
`tests/reference/dc-runtime.js` (the old design-tool runtime, for
`render-parity.js`). No test uses a font file of its own. `Web/VENDOR.md`,
"Fonts, images and icons", says what they are.

These test `Web/foxy-wallet.js` (joined from `build/wallet/`) directly — no
framework, no build step, no restructuring.

## What is here

**`harness.js`** loads the wallet in jsdom with the globals it expects, and can
stub enough of cashu-ts to get through `connect()` — most of the wallet's
surface is unreachable until `mintUrl` is set, and only `connect()` sets it.
Its native side is **`nativePhone`**, a mock of the phone that keeps the seed,
the words and the counters and answers the whole "seed on the phone" contract
(`build/wallet/03-seed-counters-logs.js`): every wallet test runs on it, since
the wallet has no other seed path and refuses to connect without a bridge. On a
stubbed cashu-ts its secrets are stand-ins; with the real one (`loadReal`) they
are NUT-13's. Its rules and its words for each refusal come from
`fixtures/native-rules.json`, the only copy of them: the mock answers by it, and
the Swift that ships is compared with it (below), so neither side can change
alone. They are, as native keeps them:

- `00` keysets share counters by derivation index (id mod 2³¹ − 1), keyed by
  the first id stored;
- a counter moves at most 100 past next (`counterReserveAt`, `counterAdvance`),
  or to a range `restoreSecrets` served this session (`counterAdvance`), and
  never past 2³¹ on a `00` keyset: "too far ahead";
- `countersImport` once per install ("counters were already imported"), 256
  keysets at most, and no seed needed for it, a count-0 peek, `counterAdvance` or
  `counterSnapshot`;
- two candidates at most; kept after `seedAdopt`, which raises counters to 1000
  short of what they were served; dropped by `phone.background()` and by a page loaded again;
- `seedMigrate` compares with a saved seed whether its window is open or not, and
  only an answer about the words, `seedStatus` finding a seed, `seedCreate` or an
  adopt close the window; an error never does;
- one seed screen at a time ("a seed screen is already open"), none within 10
  seconds of a cancelled Face ID (`hooks.unlock`), and an open one closed by a
  seed change.

`phone.refusals` lists every refusal, and the live harness counts "too far
ahead" and fails on one. The same mock is `tools/live/harness.js`'s phone.
The mock tests each rule ("phone mock: …" in `run.js`); the rules come from the
contract, not from Swift, and `FoxyTests` is where native itself is checked.

**`p2pk-round-trip.js`** runs a payment request's lock end to end with the real
cashu-ts and the harness's mint: the lock goes into the request, a token is made
against it, and only the right key opens it — with every NUT-11 shape that names
this phone *and* somebody else refused. It also runs the half
the derived key exists for: the key comes from the seed at NUT-13's P2PK path,
so a token whose row is gone still opens, and one made on one phone opens on
another that has only the twelve words. The path is derived a second time in
`harness.js`, from node's own crypto and sharing no code with the Swift, and
`FoxyTests/P2PKTests.swift` checks that second implementation's BIP-32 against
the standard's published vector 1 — so the chain is the spec, then two
implementations that agree.

**`tap-offer.js`** and **`tap-settle.js`** are the two halves of tap to pay that
run without a radio. The first lifts `syncTap` out of the built app and asks
what goes on the air and when: that nothing advertises from home, that a
receive screen arms itself (or, with AUTO TAP TO PAY off, says nothing until TAP
is pressed), that the payer listens from home and from SEND and nowhere else,
that a screen armed before its invoice exists goes on the air with nothing and
sends the offer when it arrives, and that none of it tears down a link a
payment is crossing.
The second asks what the payer does with the receiver's last word, and what
`requestDelivered` forgets on the strength of it.

Both carry a rule rather than a call where they can. `tap-offer.js` reads the
tap source and fails if any `sendPhase` test is written as a truthiness check
instead of naming a phase — three separate bugs in one afternoon came from that
one habit, because a *finished* send leaves `'settled'` behind.

**`onion-fallback.js`** covers the other way a payment reaches a phone: an
address the screen has finished with keeps answering for ninety seconds, because
a payment can be crossing to it, and every posting attempt is bounded by what is
left of a thirty-second budget. Both numbers came from a measurement — a tap
whose link dropped took about two minutes and delivered nothing, against an
address destroyed 1.6 s after the screen changed.

**`amountless-invoice.js`** is about a Lightning invoice that names no amount:
that it reads as an invoice rather than rubbish, that an amount is asked for
rather than the invoice refused, that a mint which cannot pay one is named
before anything moves, and that an amount offered beside an invoice which
already carries its own is refused — the invoice is what the payee signed.

**`bridge-matrix.js`** holds THREAT-MODEL.md §1's table of what each bridge
action needs to the Swift that implements it. It reads both of the page's doors:
`bridgeAsk(` and `nativeJson(`, which is how the seed, counter and lock-key
actions are asked for. Reading only the first left nineteen actions outside the
one check that looks from the page outwards, so a typo in any of their names
would have reached the phone as an unknown action and been invisible here.
`FoxyTests/BridgeTests.swift`
already asserts the action table is exactly the documented list; this asserts
what stands in front of each action — the route check, the seed queue, the
one-change lock, the alerts, the screen queue, the presenter, the throttle, the
paste rectangle's limits. Both directions: a row claiming a gate its handler
does not have (the table flattering the code) and a handler with a gate no row
mentions (the table falling behind) both fail. It reads the sources as text, as
`BridgeTests` does with the document, because a Swift version would need
`FoxyBridge`, which the test package cannot build — so it would run only on the
simulator, where CI never reaches it. It prints what it does not check: each
action's own argument checks, and Face ID, which `SeedVault` enforces on the
read.

**`fixtures/native-rules.json`** is the native seed's rules and refusals, held
once. They used to be written twice — in the Swift that ships and again in the
mock above — and kept in step by hand, which is drift nobody sees: the page goes
on passing against a mock that no longer describes the phone. Two Swift tests
compare the file with the Swift. `FoxyTests/NativeRulesTests.swift` covers what
`Foxy/Keychain` owns and runs in `tools/nativetests` and on the simulator;
`FoxyTests/NativeRulesBridgeTests.swift` covers what `Foxy/Bridge` owns — the
batch limit, the pause after a cancelled read, the screens' refusals — and runs
only on the simulator (`sh tools/unit-tests.sh`), since the Swift package builds
`Foxy/Keychain` alone. The file's `asserted` map says which side checks what, and
`where` names the Swift each value mirrors. Where the Swift names a symbol the
test compares it; where the words are written inline, the test asserts the
literal is still in the file `where` names. Changing a value on one side fails:
that is checked both ways, for a number and for a refusal.

**`invariants.js`** holds two relationships that must be true after any
operation:

- **the ledger balances** — sum the history and you get the change in balance.
  Four of the sixteen bugs found in the first round of testing would have
  failed this on the operation that introduced them, including history showing an amount where
  the balance had moved by amount-plus-fee.
- **a secret never carries two signatures** — borrowed from nutshell's
  `ProofBox`. The same secret with a different `C` means something rebuilt a
  proof rather than carrying it, and the amounts can still add up while that is
  true, so the ledger check cannot see it.

**The books, in `harness.js`.** Every page `loadReal` makes is asked one more
question as its suite ends, whatever the suite was about: do its history
entries still account for the ecash it holds, one mint at a time, to the sat?
It is the sum the history screen's card does (ADDS UP, DOES NOT ADD UP). A
test asks whether the thing it is about happened; this asks whether anything
else did, in every suite that drives the real wallet. What is compared is the
change since the page was made, and a page with money on its way is not
judged. A test that puts ecash in or takes it out behind the wallet's back
says so (`rebook(ctx)` after the step, or `noBooks(ctx, why)`). Its first run
found entries filed under whichever mint the phone was on at that moment
instead of the mint the money moved at, change still called owed on a payment
that had been taken whole, a refund written over change that had already come
back, and a piece let go as too small to claim that left its payment written
a sat short. `FOXY_BOOKS=0` turns it off.

**`interleave.js`** runs the money operations against each other and against
failures, in schedules nobody wrote by hand: a funded wallet on the page as it
ships, then pairs of the operations the proof lock wraps, started together so
they must queue, with a fault or a refused write armed part-way. After each step
it checks both invariants above, that the proof lock was never held twice
(`proofLockDepth()`), and that a rejection is one the wallet means — a refused
write carries `storageFull`, a lost answer says so. Faults use the vocabulary of
`tools/live/fault-proxy.js` (`drop-after`, `status`, `delay-after`) so a failure
here and one against a real mint read the same. A failing schedule prints its
seed, and `--seed N` replays it exactly.

Where the wallet is correctly left as the only actor it can no longer account
for — a refused write that loses a quote's record, or a swap the seed put back —
the ledger check is turned off for that round and the schedule says so, because
a check that quietly stops checking reads like a passing one. The proof box and
the lock are still asserted there. Removing the lock's serialisation makes it
fail, which is how it is known to work.

**`run.js`** is the suite: 234 tests, among them the one-time move of an older
install onto the phone (words migrated, the same, different, refused and sent
again, past the phone's window; counters sent once and never written after;
a fresh install with nothing to move), a cancelled Face ID followed by a launch
that compares, another seed's counters never imported, three mints scanned with
the words adopted mid-scan and the phone dropping them, no new words while
money is settling, legacy keysets, the used-output skip of 10, 50 and 100, and
a check that no flow met the phone's cap on counter moves.

**`fuzz-parsers.js`** feeds the wallet's readers of untrusted text (invoices,
LNURLs, mint addresses, payment requests, tokens) mutated spec vectors, random
text, and input valid in form but hostile in content, from a fixed seed, and
checks what must always hold. Its first run found five readers answering
wrongly: an invoice amount of Infinity, addresses read differently from a URL
parser, payment requests listing mints that were not text, and token totals
past 2^53. All five were fixed.

**`types/`** is the type check of `Web/foxy-wallet.js`:
`node node_modules/typescript/bin/tsc -p tests/types`, with TypeScript 6.0.3
pinned in the root `package-lock.json`. It emits nothing. `strictNullChecks` is
on; `noImplicitAny` is off until the file is annotated far enough to pass it.
`types/tsconfig.app.json` is the same check of `build/foxy-app.js`, the app class
and its render functions, against `types/app.d.ts`, with `noImplicitAny` and
`strictNullChecks` both off for now; its first run found an address field that
turned autocorrect on and a tap that threw, which **`type-check-finds.js`** keeps
fixed.

## Whether the tests ask enough

A suite that passes says the code does what the tests ask, not that they ask
enough. `tools/mutate.js` makes one small change to `Web/foxy-wallet.js` at a
time (a `<` to `<=`, an `&&` to `||`, a condition to `true`, a block emptied),
runs the wallet's suites against it in a copy of the tree, and writes down
whether any of them failed. A change nothing notices is a gap in the tests or
code that does nothing.

    node tools/mutate.js --baseline                      # how long each suite takes, and which fail unchanged
    node tools/mutate.js --sample 100 --only 'paying|sending|receiving'
    node tools/mutate.js --ids FILE --suites run,crossings   # the same changes again, after a test was written

It is not part of `tools/check-all.sh`: a hundred changes take the better part
of an hour. The first sample of the parts that move money made 474 changes,
of which 232 were caught, 237 were not and 5 could not be run. The gaps that
mattered were closed one at a time, each new test shown to do its job by
making the same change again (`--ids`): 69 changes nothing had noticed are
caught now, and 6 were shown to make no difference. A named suite that fails
with nothing changed stops the run, since it would call every change caught.
An id is an offset into the wallet as it was, so a list of them is good only
until the wallet is next edited.

## What these cannot do

**The mint is a stub.** It answers; it does not decide. Fee arithmetic, the
melt state machine and what a real mint returns under load were all found by
moving real sats. `tools/live/README.md` runs the money paths against real mint
software (CDK and Nutshell in Docker, with fake Lightning), and
`tools/live/production.md` has the rules for real mints.

**Little that is native.** These tests run a model of iOS: the keychain, the
clipboard, biometrics, backup exclusion and process death are modelled, and the
bug is usually in the model. The native code has its own tests: `FoxyTests`
(`sh tools/unit-tests.sh`, on the simulator), the part of them that needs no
simulator in `tools/nativetests` (`swift test --package-path
tools/nativetests`, run by `tools/check-all.sh`), the simulator scripts in
`tools/sim`, and the phone checklist in `DEVICE-TESTS.md`.

**Little about the screen.** `build/foxy-app.js` is a 17,814-line class that
cannot be instantiated outside its runtime. `render-parity.js` renders every
screen and popup of the real class, as a static preview with no wallet;
`render-snapshots.js` renders 211 views — those, each screen in representative
states against a stand-in wallet, and the cards and dialogs built in plain DOM —
and compares each view's markup byte for byte, and a hash of what `renderVals()`
returned, with `snapshots/render/` (`--update` rewrites them after an intended
change; a view keeps its file's number when others are added or removed);
`native-seed-app.js` renders the real class too, and checks that BACKUP,
verify, RESTORE, the new-mint sweep and the wipe ask the phone
(`showSeedNative`, `enterSeedNative`, candidates) and never the words, and that
the page has no word grid, quiz or cells left; `backup-logic.js` lifts the
backup's methods out and checks no words, demo or real, are left in the page;
and `cards-logic.js`, `switch-guard.js` and `tap-offer.js` lift single methods
out of it (the cards queue, the mint-switch guard, what goes on the air) and run
them against stand-ins. A decision inside a handler that none of these lifts
out has no automated coverage. The way in is to extract such decisions — the
error classifier, fee and total arithmetic, screen routing, state resets — as
pure functions and test those.

## The invariant worth understanding

The ledger check is not an example. An example asserts what you expected; this
asserts a relationship, and fails on things nobody thought to check.

It is a *test-time* invariant rather than a runtime one, because the balance can
legitimately change with no history entry: proofs spent in another wallet are
dropped by reconcile, and that is correct. It holds while this wallet is the
only actor — a condition a test controls and an app cannot.
