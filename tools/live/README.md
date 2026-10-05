# tools/live

## Live tests

Foxy's wallet (`Web/foxy-wallet.js` on the bundled cashu-ts) in jsdom with a mocked native
bridge, against real mints on this Mac. The bridge is the mocked phone (`tests/harness.js`'s
`nativePhone`): it keeps each wallet's seed and counters and derives their NUT-13 secrets, and
words from another wallet are typed on it (`seedEnter`) and restored by their candidate. The
page never has the words; every script ends with the phone's counts and fails if a page asked
for them. The phone keeps native's rules (`NATIVE_RULES` in `tests/harness.js`, as native keeps
them): `00` counters shared by derivation index,
counter moves capped at 100 past next or a served restore range, one counter import, candidates
kept after an adopt, and the migration window's rules. A script also fails if the phone refused
a counter move as "too far ahead" (`tooFarAhead` in the counts). Fake money only, with one
exception: the `real-*` scenarios of `offline-cross-scenarios.js` spend real sats at real mints
when started with `FOXY_LIVE_REAL=1`, and `production.md` has the rules for them. Otherwise the
mints are local Docker mints with fake Lightning (or testnut for the older scripts).

```sh
sh tools/live/local-mint.sh up          # CDK 0.18.1 https://127.0.0.1:8443, Nutshell 0.21.0 https://127.0.0.1:8444
sh tools/live/pending-mint.sh up        # Nutshell whose melts stay PENDING, https://127.0.0.1:8445
export NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1
node tools/live/flows.js all            # mint (NUT-20), swap fees, send/receive, pay, pending melt, import, restore
node tools/live/paste-flows.js cdk      # a token there and back, two pastes at once, a request carrying its amount
node tools/live/p2pk.js all             # NUT-11: canLock, a locked send, the mint enforcing it, the shapes
                                        # Foxy refuses, the locktime boundary, a lost answer; FOXY_P2PK_ONLY=3,5
node tools/live/cross-wallet-restore.js all   # Foxy words <-> Nutshell CLI (cdk-cli via CDK_CLI_RESTORE_CMD)
node tools/live/onchain.js              # NUT-30: limits, an address, a payout quoted, paid and followed to PAID
node tools/live/faults.js all           # fault proxy scenarios; FOXY_FAULTS_SLOW=0 skips >60 s cases,
                                        # FOXY_FAULTS_ONLY=a2,d1 runs only those sections
node tools/live/faults.js onchain       # section (f) alone, against testnut (no Docker mint needed);
                                        # a second argument names another fake-money mint
node tools/live/cross-mint.js           # paying somebody at another mint, both directions:
                                        # the payer moving the money there, and the receiver
                                        # carrying it home for a payer with no route
node tools/live/cross-mint-faults.js    # the connection dying at each step of a crossing, and
                                        # what the person has to do next — nothing, mostly
node tools/live/amount-coercion.js      # no money path reaches an Amount through Number()
                                        # or arithmetic, which cashu-ts v5 turns into a throw
node tools/live/restart-melt.js         # the CDK container restarted under a melt in flight
sh tools/live/pending-mint.sh down; sh tools/live/local-mint.sh down

CDK_MAX_ARRAY=25 sh tools/live/local-mint.sh up   # a CDK with a small NUT-06 cap
node tools/live/array-cap.js            # Foxy's own chunking against that cap

sh tools/live/mint-pair.sh up           # two CDK mints set up like the phones' own: macadamia-like
                                        # (0.18.1, 150 ppk) https://127.0.0.1:8473 and minibits-like
                                        # (0.17.7, no fee) https://127.0.0.1:8474
node tools/live/tap-scenarios.js        # a tap between two phones on the rail the app would pick, each
                                        # side online and offline, then with the connection cut and the
                                        # app killed part-way; `same`, `cross` or `faults` runs one part,
                                        # FOXY_TAP_ONLY=F3,F11 one fault, FOXY_TAP_DEBUG=1 says what each
                                        # wallet said
sh tools/live/mint-pair.sh down
```

| file | what |
|---|---|
| `cross-mint.js` | a request at a mint this wallet does not use, against CDK and Nutshell at once. The payer with the route quotes the move, melts, claims and pays from the far end; the payer without one is quoted the way home by the receiver, which takes the payment at the payer's mint, swaps it in and melts it back. Both hold the same rule: the receiver gets the figure it named and the payer carries every fee. The two messages the phones use to agree it (M10/M11) ride Bluetooth and are not here |
| `cross-mint-faults.js` | the same crossing with a fault proxy in front of both mints: the quote lost, the melt's answer lost, the app killed in the window between the melt and the claim, the claim's answer lost, the payment's own swap lost, the receiver's way home lost, and a change swap lost. Each names what is stuck (nothing, so far) and what the person must do |
| `amount-coercion.js` | walks mint, swap out, swap in, melt and a two-mint transfer with cashu-ts's deprecation recorded, and fails on any hit. `meltFee` was reaching an Amount through `Number()` on every melt — a warning today and a throw the day v5 lands, in the middle of a melt |
| `harness.js` | boots Foxy in jsdom on a mocked phone (seed, counters, `mintRequest` over fetch), records mint refusals, warnings, `onMintTrouble`/`onClaimTrouble`, request counts; `restoreWords` and `scanFresh` restore words through the phone, `counters`/`setCounters` read and move its counters |
| `used-counters.js` | swap, receive and claim on counters the mint has already signed (the phone's counters put back), then a restore |
| `units.js` | sats and usd under one seed at a Nutshell with a usd keyset (see its header) |
| `testnut-restore.js` | the same end to end at a testnut mint |
| `flows.js` | end-to-end steps per mint, OK/FAIL, exit 1 on failure |
| `p2pk.js` | the lock on every payment request (NUT-11) against a mint that checks signatures: `canLock` driven from a rewritten `/v1/info`, a real `sendToken({ lockTo })` the mint signs, the same proofs refused to no key and to the wrong key, claimed by `receiveToken`, the adversarial shapes as **real** proofs the mint would honour, the locktime boundary, and a locked send's lost answer recovered through `mint.restore({ outputs })` |
| `onchain.js` | NUT-30 end to end: what the mint does per direction, an address to be paid into (a quote, not an invoice), and a payout quoted, paid and followed from PENDING to PAID |
| `cross-wallet-restore.js` | Foxy's words restored by Nutshell's `cashu` CLI, and a CLI wallet's words restored in Foxy |
| `nutshell-cli.sh` | the `cashu` CLI from the nutshell image: `sh nutshell-cli.sh <dir> http://host.docker.internal:3338 <args>` |
| `tls-proxy.js` | HTTPS in front of a local mint: Foxy talks only to https or `.onion` mints, and a mint in Docker speaks plain http. A self-signed certificate (made by `local-mint.sh`), trusted through `NODE_EXTRA_CA_CERTS` |
| `mint-survey.py` | how a real mint behaves when asked what Foxy asks first (`/v1/info`, and a quote for an invoice that is never paid), over a running Foxy's Tor SOCKS port, with the median of several rounds and the spread |
| `production.md` | the rules for real mints with real money, and what real mints showed |
| `fault-proxy.js` | HTTPS proxy with per-path faults (drop before/after, status, hang, delay, JSON rewrite); in-process API or `/__fault` control endpoint. `target` is a local port or, for a mint elsewhere, a URL or `{ host, port, protocol }` |
| `faults.js` | (a) swap/claim answer lost, (b) melt answer lost, (c) quote-check 500s, (d) broken DLEQ, (e) slow answers, (f) on chain (NUT-30) |
| `array-cap.js` | a mint advertising a small NUT-06 `max_array_length`: the sent-token watch's `/v1/checkstate` and the restore walk's `/v1/restore` chunked by it (needs `CDK_MAX_ARRAY`) |
| `mint-pair.sh` | two CDK mints at the versions and input fees of mint.macadamia.cash and mint.minibits.cash, as read from their `/v1/info` and `/v1/keysets` |
| `tap-scenarios.js` | a tap to pay between two pages over a model of the link: same mint and across mints, each side with and without a route, and seventeen faults (a request that never left, an answer that was lost, the app killed at that moment). Asks four things each time: did the receiver get what it asked, what did it cost, is anything left in between, do both phones' entries add up — and asks the mint whether what each phone shows is still spendable. It passes whole |
| `offline-cross-scenarios.js` | a second two-phone suite, on the same mint pair, over what `tap-scenarios.js` leaves out: crossings into the mint that charges, a lost phone restored from its words on either side, replays to an offline receiver, an offline phone paying out of ecash locked to itself, crossings cut and then repeated, amounts at the edge of a balance, a mint that only one side can reach. `node tools/live/offline-cross-scenarios.js [id …]`. It also covers a payment that cannot be brought home going back to the payer (`carry-refund`, `carry-refund-code`), a way home that costs more than was paid for (`carry-short`), a refused payment taken back by itself, including a receiver that says no and redeems it anyway (`take-back`), a cheat's payment with every proof named twice (`dup-proof`), and two long sittings with no connection (`soak-rx`: forty locked payments taken, a kill, a payment out of them, one reconnection; `soak-payer`: thirty payments). The `real-*` scenarios of the same file run only against real mints (`production.md`). It passes whole; what it found is in `MONEY.md` §14 |
| `restart-melt.js` | the CDK container killed under a melt in flight: the hold survives, the age gate holds it, `sweepMelts` settles it, balance = restore |
| `cdk-cli-restore.sh`, `cdk-cli/Dockerfile` | CDK's wallet CLI, built from its v0.18.0 tag, restoring a seed for `cross-wallet-restore.js` |
| `pending-mint.sh` | the extra Nutshell with `FAKEWALLET_PAY_INVOICE_STATE=PENDING` |

Notes:
- `faults.js onchain` is its own run and needs no Docker mint: the fault proxy points at a mint
  that speaks NUT-30 with fake money — `https://testnut.cashu.space` by default, any fake-money
  mint as the second argument — and only section (f) runs. Keep `FOXY_LIVE_LOCAL=1` on the
  command: what the wallet dials is still the proxy on 127.0.0.1, and the mint itself is checked
  by `fakeMoneyOnly`. It is someone else's machine, so the section makes a handful of payments
  and no retry loops. The local `cdk-mintd` on a fake wallet backend also advertises NUT-30
  (`onchain` under NUT-4 and NUT-5, quotes and pays instantly on a regtest chain), which makes
  `node tools/live/faults.js onchain http://127.0.0.1:3338` a fast way to run the section while
  changing it.
- `p2pk.js` is the only script here that builds blinded outputs by hand. It has to: a mint cannot
  see what it signs, so it will sign an output whose NUT-10 secret is any shape at all — including
  the ones cashu-ts refuses to *build* (`normalizeP2PKOptions` rejects `n_sigs` above the key count,
  `additionalTags` rejects reserved keys). That is what makes section 5 an experiment on real money
  rather than a guard test: the proofs it hands Foxy are proofs the mint would honour. Its witnesses
  are hand-rolled for the same reason — `signP2PKProofs` asks `assertSignerAuthorised` first and
  quietly leaves a proof unsigned when the key is not one the secret names, so a "wrong key" attempt
  through the library reaches the mint carrying no witness at all. The witness travels as a JSON
  *string*; handed an object, cdk-mintd answers 422 "data did not match any variant of untagged enum
  Witness". Its fault proxy listens on 8456 (CDK) and 8457 (Nutshell), clear of `faults.js`.
- The two mints part company on the locktime boundary, and `p2pk.js` section 6 maps it with five
  sets of real proofs at one locktime: **CDK 0.18.1 refuses an unsigned spend at `now == locktime`
  and Nutshell 0.21.0 accepts it**, with both clocks agreeing to the second. Merged NUT-11 puts the
  boundary on the locked side, so CDK follows the text and Nutshell (like cashu-ts's
  `getP2PKExpectedWitnessPubkeys`) treats it as expired. Foxy is on neither side — `hasLocktime`
  refuses any locked proof carrying a locktime, and Foxy asks for none — so the section prints the
  divergence loudly and does not fail on it. What it does fail on is a mint that let an unsigned
  spend through *before* the locktime, or never let it expire.
- CDK's fake wallet takes a melt's outcome from the paid invoice's description, so the pending
  melt at CDK pays an invoice issued by the Nutshell mint with
  `{"pay_invoice_state":"PENDING","check_payment_state":"PENDING","pay_err":false,"check_err":false}`.
- An older CDK, 0.17.5, refuses cashu-ts's first NUT-20 signature (20008) and accepts its retry:
  every signed claim there takes two requests. Nutshell's `cashu invoice` never finishes against CDK for the same
  reason (20008 in a loop), so the reverse restore at CDK funds the CLI with a token instead.
- No official `cdk-cli` image exists. Build one from CDK's v0.18.0 tag (the Dockerfile checks the
  tag's commit), then point the cross-wallet test at `cdk-cli-restore.sh`:
  `docker build -t foxy-cdk-cli:0.18.0 tools/live/cdk-cli` and
  `CDK_CLI_RESTORE_CMD="sh tools/live/cdk-cli-restore.sh" node tools/live/cross-wallet-restore.js all`.
  Without `CDK_CLI_RESTORE_CMD` the comparison is skipped (the command gets `WORDS`, `MINT`, `DIR`
  and must print `<n> sat`).
- The pins are not cashu-ts's own pair: `local-mint.sh` starts `cashubtc/mintd:0.18.1` and
  `cashubtc/nutshell:0.21.0`, not the 0.17.5/0.20.3 that cashu-ts's Makefile pinned at v4.10.1. Both of the things Foxy most needed live coverage of exist only past that pair —
  NUT-06 `max_array_length`, which CDK 0.18 and Nutshell 0.21 are the first to advertise, and
  CDK 0.17.6/0.17.7's changed melt saga recovery. The old pair still works:
  `CDK_IMAGE=cashubtc/mintd:0.17.5 NUT_IMAGE=cashubtc/nutshell:0.20.3 sh tools/live/local-mint.sh up`.
- Other mint versions: `CDK_IMAGE=cashubtc/mintd:0.18.0 NUT_IMAGE=cashubtc/nutshell:0.19.2 sh
  tools/live/local-mint.sh up`. The reports no longer need those variables to name the right
  version — a suite asks each mint's `/v1/info` for it (`H.mintNames()`) and only falls back to the
  image tag, marked as such, for a mint that did not answer. cdk-mintd 0.18 keeps its settings in
  its database and will not start from the environment alone; for any image other than 0.17
  `local-mint.sh` writes `build/live-tls/cdk-mintd.toml` and runs `cdk-mintd config init --new-mint`
  first. That init only takes on an unconfigured database, so it is allowed to fail and the mint
  starts anyway — which is what lets `docker restart foxy-cdk` bring the same mint back.
- `CDK_MAX_ARRAY=25 sh tools/live/local-mint.sh up` adds `[limits] max_inputs`/`max_outputs` to the
  CDK config, and the mint then advertises `max_array_length = 25`. `array-cap.js` needs it; nothing
  else does, and the cap is low enough that a token of more proofs than the cap cannot be received
  at that mint in one go (the mint counts the token's proofs as inputs), which the script shows.
- `restart-melt.js` restarts the container through Docker's own socket rather than the `docker` CLI:
  the CLI takes longer to start than the mint takes to answer a melt, so a CLI `docker restart`
  always landed after the payment had finished and never during one.
- `NUT_IMAGE` also picks the Nutshell CLI. Nutshell's wallet before 0.20.0 derives version `01`
  keysets (CDK's) with BIP-32 instead of NUT-13's HMAC-SHA256, so with an older `NUT_IMAGE` the
  CLI steps at CDK in `cross-wallet-restore.js` find 0 sat. That is the CLI, not Foxy: `cdk-cli`
  and Foxy agree there (CASHU-CONFORMANCE.md, "Moving words between wallets").
- `cdk-cli-reverse.js`: a wallet `cdk-cli` made (24 words) restored in Foxy, then spent. The
  mocked phone takes the 24 words; the real phone's screen takes twelve.
- `CDK_CLI_RESTORE_CMD` is a shell command in an environment variable; where a sandbox will not
  pass one, set it in a small node launcher that `require`s the script (set
  `NODE_EXTRA_CA_CERTS` on the command line: node reads it only at start).
- The CLI's wallet directories go to the system temp dir; containers reach the mints at
  `host.docker.internal`.
