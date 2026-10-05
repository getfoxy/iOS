# REVIEW.md — the front door for a reviewer

For whoever audits Foxy next. Three things: a reading order, a table of the
claims this code makes with the test that proves each, and the vocabulary.
Nothing here is a design document; those are listed at the end.

One rule before anything else. **The comments describe intent; test them.**
A comment on the offline receive path once said a payment's DLEQ "verifies
against the cached keyset". No code on that path did, and 5,000 forged sats
were shown as paid in the harness. The bug was found by writing a test, not by
reading. Treat every claim below the same way, and treat an AI
reviewer's reading of a comment as a claim to check, never as a check.

## How to run everything

```bash
python3 tools/join-sources.py && python3 tools/pack-index.py   # the page, from build/
sh tools/check-all.sh        # smoke, the type checks, 76 node suites, and 113 native Swift tests
sh tools/unit-tests.sh       # 382 Xcode tests (the 113 above are among them)
sh tools/live/local-mint.sh up && export NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1
node tools/live/flows.js all && node tools/live/p2pk.js all && node tools/live/faults.js all
```

The suites in `tests/` are read by name in `tools/check-all.sh`. Every one
prints `ok` or `FAIL` per check and exits non-zero on a failure.

## Reading order

Read the wallet in numbered order; each file's header says what it holds.
The stops that matter, with the test that pins each:

| Stop | Where | What it is | Pinned by |
|---|---|---|---|
| 1 | `THREAT-MODEL.md` §1, §4, §5 | what runs where, how Tor is used, what the mint is trusted with | — |
| 2 | `build/wallet/00-header-and-mint-errors.js` | mint errors, the lock helpers (`lockedTo`, `spendableBy`, `onlyLockedTo`), fee arithmetic | `tests/p2pk-round-trip.js`, `tests/nut-vectors.js` |
| 3 | `build/wallet/01-storage-and-piles.js` | where proofs live on disk, `setProofs` | `tests/run.js` |
| 4 | `build/wallet/02-dleq-lock-holds-imports.js` | DLEQ audit (`dleqAudit`, `mintSigned`), imports, the proof lock | `tests/run.js` ("a proof whose DLEQ fails…") |
| 5 | `build/wallet/03-seed-counters-logs.js` | NUT-13 counters, the history log, per-job circuits (`onCircuit`) | `FoxyTests/NUT13Tests.swift`, `CounterRulesTests.swift` |
| 6 | `build/wallet/07-request-delivery.js` | NUT-18 requests: `readPayment`, `changeBack`, lock keys, onion and nostr delivery | `tests/offline-accept.js`, `tests/net-of-fee.js`, `tests/change-leg.js` |
| 7 | `build/wallet/19-bill-split.js` | `sendToken`, `receiveToken`, `forwardLocked`, the offline rules | `tests/offline-accept.js`, `tests/offline-both.js`, `tests/spend-offline.js`, `tests/forward-locked.js` |
| 8 | `build/wallet/20-helpers.js` | `_requestPaid` (a payment arriving), `claimUnclaimed`, `payRequest` | `tests/offline-accept.js`, `tests/tap-settle.js` |
| 9 | `Foxy/Keychain/SeedStore.swift` | where the seed lives and what stands in front of it | `FoxyTests/SeedVaultTests.swift`, `NativeSeedTests.swift` |
| 10 | `Foxy/Bridge/FoxyBridge.swift` | every action the page can ask of the phone, in one table | `FoxyTests/BridgeTests.swift`, `tests/bridge-matrix.js` |
| 11 | `Foxy/Network/Route.swift`, `Foxy/Tor/TorService.swift` | fail-closed routing, Tor's lifecycle | `FoxyTests/RouteTests.swift`, `tests/gate-scenarios.js` |
| 12 | `Foxy/Bluetooth/TapLink.swift`, `TapSession.swift`, `TapProtocol.swift` | tap to pay: who advertises, the handshake, the messages | `FoxyTests/TapSessionTests.swift`, `TapProtocolTests.swift`, `TapCryptoTests.swift` |

Then `build/app/26d-tap.js` and `build/app/07-history-tokens-mints.js` for
how the screens drive the wallet, with `tests/tap-offer.js`, `tests/tap-held.js`
and `tests/tap-shake.js`.

`Web/index.html`, `Web/foxy-wallet.js` and `build/foxy-app.js` are
generated. Review the sources in `build/`, and check the generated files match
them: `python3 tools/smoke.py` does (check 1).

## Claims, and what proves each

Each row is a sentence the code or its comments assert. The last column is
where to look to see it is true, and the way to see it is false. Where the
proof is "read the code", say so in the review; that row is weaker than the
others.

| # | Claim | Where it is made | Proof |
|---|---|---|---|
| 1 | The twelve words never reach the page; the phone derives every secret | `SEED-HANDLING.md`, `NativeSeedBridge.swift` | `tests/run.js` counts `wordsAsked` and `pageSeedDerivations` on the mocked phone and fails on any; every `tools/live/*.js` script ends with the same counts |
| 2 | Every network request goes through Foxy's own Tor, and nothing leaves when Tor is down | `THREAT-MODEL.md` §4, `Route.swift` | `FoxyTests/RouteTests.swift` (`testAnOnionNeedsTor`, hosts Foxy will not ask for); `tests/gate-scenarios.js` for the screen that says so; `tests/bridge-matrix.js` row `mintRequest` |
| 3 | The bridge exposes exactly the actions `THREAT-MODEL.md` lists, each gated as the table says | `THREAT-MODEL.md` §1 | `FoxyTests/BridgeTests.swift` (count and set equality), `tests/bridge-matrix.js` (each gate token found in the handler's body) |
| 4 | Ecash is money only when the mint's DLEQ verifies; a locked payment offline is final only then | `02-dleq-lock-holds-imports.js:mintSigned`, `20-helpers.js:_requestPaid` | `tests/offline-accept.js` "ecash nobody signed": forged with no DLEQ, with a wrong DLEQ, online and offline, delivered and scanned |
| 5 | Offline, unlocked ecash is never taken as paid | `19-bill-split.js:receiveToken`, `20-helpers.js:_requestPaid` | `tests/offline-accept.js`, `tests/offline-both.js` (the trust card path is off; see `07-request-delivery.js` "Off, for now") |
| 6 | A token already claimed, shown again offline, is refused | `19-bill-split.js:receiveToken` | `tests/offline-accept.js` (the replay block: "shown again as a code with no route, it is refused", and nothing is counted) |
| 7 | A payment for a request covers the amount net of the mint's input fee | `07-request-delivery.js:readPayment` | `tests/net-of-fee.js` |
| 8 | A lock of ours with a time lock is taken only where the swap follows at once and the time is a day or more away | `00-header-and-mint-errors.js:onlyLockedTo` | `tests/p2pk-round-trip.js` (far-off accepted online, refused offline, an hour away refused), `tests/nut-vectors.js` NUT-11 shapes |
| 9 | Counters never go backwards; restore walks NUT-13 batches of 100 and stops after 1,000 empty counters (ten batches) | `03-seed-counters-logs.js`, `13-restore.js` | `FoxyTests/NUT13Tests.swift`, `CounterRulesTests.swift`, `CounterRangeCheckTests.swift`; `tools/live/flows.js` step 7 and `cross-wallet-restore.js` against real mints and Nutshell's CLI |
| 10 | Stored and imported proofs whose DLEQ fails are reported, and an import with a broken DLEQ is refused before the mint is asked | `02-dleq-lock-holds-imports.js:checkIssued` | `tests/run.js` "a proof whose DLEQ fails is kept, and the mint is reported"; `tools/live/flows.js` step 6 |
| 11 | Tor is built from signed sources and the shipped binary matches the recorded hash | `TOOLCHAIN.md`, `Vendor/Tor.sha256` | `tools/smoke.py` check 18; `bash tools/build-tor.sh` on a clean checkout, with the toolchain in `TOOLCHAIN.md`, rebuilds it byte for byte (repeat it) |
| 12 | The tap receiver advertises a random service UUID and nothing else; the payer sends nothing until the handshake | `TAP-TO-PAY.md`, `TapLink.swift` | `FoxyTests/TapSessionTests.swift`, `TapProtocolTests.swift`; measured with a scanner on a third phone (`DEVICE-TESTS.md` §22b): one service per tap with characteristics derived from it, nothing readable, nothing named |
| 13 | Notifications carry no amounts | `FoxyBridge.swift:notify` | `tests/bridge-matrix.js` row `notify` (kinds + throttle) |
| 14 | An onion inbox is one address per request, with a key Tor makes and discards | `OnionInbox.swift` | `FoxyTests/OnionHTTPTests.swift`, `tests/bridge-matrix.js` row `inboxOpen` |
| 15 | A new wallet's seed starts with nothing in front of it; an existing one keeps its guard | `FoxyWebView.swift` (the install marker), `SeedStore.swift` | `FoxyTests/SeedVaultTests.swift` for the modes; the first-run branch is **read the code** |
| 16 | The page cannot read the clipboard, the camera or the keychain except through gated actions | `THREAT-MODEL.md` §7 | `tests/bridge-matrix.js`; `Foxy/FoxyWebView.swift` (the web view's configuration) is **read the code** |
| 17 | Change for an over-payment goes back locked to the payer's key, and is never unlocked | `07-request-delivery.js:changeBack`, `19-bill-split.js:changeForScanned` | `tests/change-leg.js`, `tests/offline-both.js`; `tests/run.js` "a token that paid over and named a key…" |
| 18 | Handed-on locked ecash cannot be handed on twice by the same phone | `19-bill-split.js:forwardLocked`, `07-request-delivery.js:rememberHandedOn` | `tests/forward-locked.js`; note the list is capped at 200 (`07-request-delivery.js`) — a weakness, stated |
| 19 | A receive or a locked send shapes its own swap to fill the change pool — sixty pieces at most, six of a size, within the mint's `max_array_length` — and a locked send spends one large piece, never the small ones | `MONEY.md` §13, `05-paying-this-mint.js:shapeOutputs`, `19-bill-split.js` (`oneIn`) | `tests/run.js` ("fills the small tiers in that one swap", "takes one large piece in", the 1,000 ppk variant, "no more outputs than it takes"); live `tools/live/array-cap.js`, `p2pk.js` §7–8 |
| 20 | A top-up swap runs only with Foxy put away, starts none after twelve seconds, and the phone keeps Tor up twenty seconds for it | `MONEY.md` §13, `07-history-tokens-mints.js:putAway`, `FoxyWebView.swift:appEnteredBackground` | `tests/watch-rearm.js` (the put-away checks), `tests/kept-token.js`, `FoxyTests/BridgeTests.swift` (`movesMoney`) |
| 21 | A piece left spendable at the Tor close is settled on the next connection with its outputs in and the input out, never both counted | `04-lost-answers.js:holdInputs`/`dropInputsOf`, `15-receiving.js:recoverSwaps`, `22-screen-lock.js:recoveringSats` | `tests/held-swap.js` (the free-input case) |
| 22 | A claimed token's text is kept for showing, never offered for reclaim, and never trimmed while unclaimed | `20-helpers.js:forgetClaimedToken`, `04-lost-answers.js:trimKeptTokens` | `tests/kept-token.js` |
| 23 | The payer finishes writing "I kept the change" (M8) before it lets the link go | `TapLink.swift:stop` (`closingAfterWrites`) | `tests/kept-token.js` pin; the phones' diaries say "the receiver was told the change was kept" / "the payer kept the change" |
| 24 | STOP WAITING drops a send that has not begun and leaves nothing behind; one that has begun is left to finish | `02-dleq-lock-holds-imports.js:giveUpWaiting` | `tests/kept-token.js`; probed in an audit |
| 25 | The money paths pass against real mints: CDK 0.18.1 and Nutshell 0.21.0, including the fault, cap and cross-restore suites | `tools/live/README.md`, `CASHU-CONFORMANCE.md` | `sh tools/live/local-mint.sh up` then the suites listed there, which run against those versions by default |
| 26 | A locked payment the app was killed in the middle of is rebuilt on the next launch from its written-down outputs, its pieces held out of the balance until the mint has answered, and its record given up only when the mint says those pieces are unspent | `MONEY.md` §14, `04-lost-answers.js:holdUnanswered`/`finishLockedSend`/`writeLockedSend`, `15-receiving.js:recoverSwaps` | `tests/locked-send-lost.js` (the four killed cases); live, `tools/live/tap-scenarios.js` F3 and F3b |
| 27 | Change goes back less what it costs to make and to take, the receiver keeps exactly what it asked, and an overpayment too small to return makes no change and leaves nobody waiting | `MONEY.md` §14, `07-request-delivery.js:changeFor`/`changeBack`, `19-bill-split.js:changeForScanned` and the `dust` branch of `sendToken`, `04-lost-answers.js:settleChangeMade` | `tests/change-leg.js` cases 5 and 6; live, `tap-scenarios.js` 2b |
| 28 | A payment taken at another mint to be carried home is received as the fewest pieces, so the way home costs what the quote allowed | `MONEY.md` §14, `19-bill-split.js:receiveToken` (`opts.plain`), `20-helpers.js:_requestPaid` | `tests/run.js` "a payment only passing through a mint"; live, `tap-scenarios.js` 6, F16, F17 |
| 29 | At a mint that charges, every fee is on an entry and both phones' entries add up to what they hold, checked against the mint | `MONEY.md` §14 | `tools/live/tap-scenarios.js`, every check |
| 30 | A receiver that refuses a payment keeps nothing of it, and one that does not yet know says so (409, which the phone passes on and the payer reads as unconfirmed) rather than refusing | `MONEY.md` §14, `20-helpers.js:_requestPaid` (the plain branch) | `tests/change-leg.js` case 7; live, `tap-scenarios.js` F10 and F10b |
| 31 | A melt held at another mint is settled, change and all, without the phone going there; one whose change cannot be restored stays held | `MONEY.md` §14, `15-receiving.js:sweepMelts`/`_sweepMeltsOnce` | `tests/run.js` "a held melt at another mint…", "a paid held melt whose change cannot be restored yet stays held"; live, `tap-scenarios.js` F17 |
| 32 | With no route, locked ecash is taken only for a request still open on this phone: one already claimed, or already answered offline, is refused | `MONEY.md` §14, `07-request-delivery.js:lockRowFor`/`markLockTaken`/`dropLockKeysByPub`, `19-bill-split.js:receiveToken` | `tests/offline-accept.js` (the replay block); `tools/live/offline-cross-scenarios.js` `replay-off`, `replay-claimed` |
| 33 | A second crossing never loses the first: the notes are a list, each is finished from wherever the phone is, and none is left for a melt that never went | `MONEY.md` §14, `04-lost-answers.js:moveNotes`/`awayWallet`/`dropMoveNoteFor`, `14-moving-between-mints.js:moveRun`/`finishMove` | `tests/crossings.js` 1–3; live `carry-twice`, `move-cut`, `move-twice`, `carry-drop` |
| 34 | Paying out of several locked payments strikes none of them off until the token that carries them is written down | `19-bill-split.js:forwardLocked` (`defer`), `sendToken` | `tests/forward-locked.js`, `tests/kept-token.js`; live `fwd-kill`, `fwd-refuse`, `fwd-cut` |
| 35 | An overpaying tap token names the key for its change, so change comes back when the token is shown as a code | `20-helpers.js:payRequest` (`changeKey`), `19-bill-split.js:sendToken` | `tests/change-leg.js` 1; live `over-cut` |
| 36 | The quote for a crossing and the payment itself do one sum, at a mint that charges as well; a refusal offers an amount the quote then allows | `04-lost-answers.js:meltNeed`, `16-sending.js:pay`, `14-moving-between-mints.js:transferQuote`, `20-helpers.js:stuckAtMint` | `tests/crossings.js` 4; live `edge-ln`, `edge-move`, `edge-carry` |
| 37 | A visit to another mint is never saved as the phone's own, and a payment taken there is brought home by itself after a kill, a lost route or a late claim; when the way home costs more than was paid for, the person is asked | `MONEY.md` §14, `04-lost-answers.js` (carry job), `14-moving-between-mints.js:carryBegin`/`carryHome`/`carryResume` | `tests/crossings.js` 5; live `carry-drop`, `carry-wake`, `one-side-b`, `carry-short` |
| 38 | A payment that cannot be brought home goes back to the payer, locked to the payer, over the link or as a code; the receiver's entry stops saying it was received and the receiver cannot spend it | `MONEY.md` §14, `04-lost-answers.js:carryBack` | `tests/crossings.js` 5; live `carry-refund`, `carry-refund-code`, `carry-short` |
| 39 | Plain ecash a receiver refused is swapped back into the payer's wallet on its next connection, once; if the receiver redeemed it after saying no, the entry says paid | `MONEY.md` §14, `20-helpers.js:takeBackRefused` | `tests/crossings.js` 6; live `take-back` |
| 40 | After a crossing's payment is made and its claim is not, the payer is told the sats left, and a second tap pays from what is already at their mint | `26d-tap.js:crossFailed`/`tapPayFromThere` | `tests/kept-token.js`; live `move-cut`, `move-twice`, `move-fail` |
| 41 | A piece of ecash named twice in a payment, a scanned token or change is refused, not counted twice | `MONEY.md` §14, `00-header-and-mint-errors.js:repeatedProof`, `07-request-delivery.js:readPayment`/`checkChange`, `19-bill-split.js:receiveToken` | `tests/offline-hostile.js` A, B; live `dup-proof` |
| 42 | The amount on the cross-mint fee screen is the amount PAY sends: the receiver's request must be for the figure it quoted, at this phone's mint; a request answering a dollar price must be for the sats offered | `26d-tap.js:tapStuckAtMint`/`tapQuoteTheirDollars` | `tests/offline-hostile.js` C, `tests/price-terms.js` |
| 43 | An offline payer covers the receiver's fee on every piece in the token, locked or loose | `05-paying-this-mint.js:exactPieces`/`coverPieces`/`exactWithLocked`, `19-bill-split.js:sendToken` | `tests/crossings.js` 7; live `soak-payer` (30 of 30) |
| 44 | A refused payment is taken back whatever it is made of, including ecash locked to this phone and signed on | `20-helpers.js:takeBackToken`/`takeBackRefused`, `07-history-tokens-mints.js:reclaimFromTx` | live `soak-payer` (no token left on an entry) |
| 45 | A long sitting with no connection holds: forty locked payments taken, a kill part-way, a payment out of them, all claimed on reconnecting, and both phones' entries add up | `MONEY.md` §14 | live `soak-rx`, `soak-payer` |
| 46 | Before any ecash crosses a tap, the payer asks and the receiver answers whether it could take it; a "no" costs nothing and nothing is sent | `MONEY.md` §15, `21-native-bridges.js:askFirst`, `07-request-delivery.js:answerIntent` | `tests/counter-refusal.js` A |
| 47 | A receiver that can reach the mint and refuses sends the payment back as new ecash locked to the payer; the payer checks the lock and the amount before counting it | `07-request-delivery.js:refundRefused`/`checkRefund`/`afterRefusal` | `tests/counter-refusal.js` B, C |
| 48 | A refusal with no locked refund inside 10 seconds is HIGH RISK: the pieces go back into the balance flagged and ringed red, stay spendable, and are swapped for fresh ones on the first connection; if the receiver redeemed them the entry says so | `07-request-delivery.js:atRiskAdd`, `20-helpers.js:settleAtRisk` | `tests/crossings.js` 6, `tests/change-leg.js`; live, `tools/live/tap-scenarios.js` F10b |
| 48a | A payer with a route does not wait for its next connection: the refused pieces are swapped at once, and it is told they are safe, or that they were redeemed | `07-request-delivery.js:afterRefusal` | `tests/counter-refusal.js` D |
| 48b | Pieces found redeemed after a refusal may be the refund being made: the record is kept so a late refund still settles the entry | `20-helpers.js:_settleAtRiskOnce` (`entomb`) | `tests/counter-refusal.js` D |
| 49 | An online payer of another mint waits up to 5 seconds for the receiver's Lightning invoice before falling back to a move and ecash | `26d-tap.js:tapAwaitInvoice` | `tests/carry-cards.js` |
| 50 | The on-chain keypad opens in dollars and refuses more than the balance before the mint is asked for a fee | `26b-onchain.js:payOnchain`/`ocNext`, `21-render-values.js:renderContext` | `tests/onchain-keypad.js` |
| 51 | The camera is never live over the connection screen | `15-paid-wake-keyboard.js:syncPreview`, `Web/foxy-tor-gate.js` (`foxy-gate-up`) | `tests/pay-this-mint.js` |
| 52 | A request a mint turns away as too many (429) is asked once more on a circuit of its own; turned away again, the person is told nothing was done and to try in a minute | `22-screen-lock.js:nativeRequest` | `tests/mint-busy.js` A |
| 53 | An unpaid invoice is dropped past the expiry it was made with, at a mint whose later answers no longer give one (Nutshell 0.20) | `15-receiving.js:sweepQuotes` | `tests/mint-busy.js` B |
| 54 | A payer that paid a tap's invoice over Lightning tells the receiver over the link; the receiver believes nothing and asks its mint at once, then every second for twenty seconds | `TAP-TO-PAY.md`, `26d-tap.js:tapSayPaid`/`tapPaidNotice`, `15-receiving.js:watchKick` | `tests/tap-paid.js` 3, 4 |
| 55 | An offer this phone has already paid by tap is said to be ALREADY PAID and is not paid again, for a day and across a relaunch | `26d-tap.js:tapWasPaid`/`tapMarkPaid` | `tests/tap-paid.js` 1 |
| 56 | The payer does not listen for five seconds after a payment by tap | `26d-tap.js:syncTap` | `tests/tap-paid.js` 2 |
| 57 | Hurrying an invoice's watch never starts a second chain of questions | `15-receiving.js:watch` (`asking`) | `tests/tap-paid.js` 4 |
| 58 | History says when by the phone's clock: the time, and past twenty-four hours the date (MM/DD) and the time; a note is the card's title and can be added or changed from the detail screen | `16-history-lists.js:txLabel`, `08-mint-entry-and-notes.js:editTxNote` | `tests/history-notes.js` |
| 59 | A tap between two mints is paid only when both phones are online; otherwise nothing is asked of any mint and both phones show OFFLINE & DIFFERENT MINT, naming the two mints (`OFFLINE_CROSS` is the switch) | `TAP-TO-PAY.md`, `26d-tap.js:tapOfflineCross`/`offlineCrossCard` | `tests/cross-mint-online-only.js` 1, 2 |
| 60 | An invoice that arrives late is not sent into a question in flight, and a payer waiting on an answer does not read one as a refusal | `26d-tap.js:syncTap`, `tapStuckAtMint`, `tapQuoteTheirDollars` | `tests/cross-mint-online-only.js` 3, 4 |
| 61 | One payment to be carried home has one job: asked twice, the paid one is the one walked; a job with nothing paid to it is forgotten and moves nothing; a payment that cannot come home or go back is said once | `04-lost-answers.js:carryStep`/`carryBack`, `14-moving-between-mints.js:carryHome`, `26d-tap.js:tapCarryHome` | `tests/crossings.js` 5 |
| 62 | The balance on screen counts what is waiting at that mint and at no other | `07-request-delivery.js:unclaimedSats`, `12-reading-and-price.js:balanceSats` | `tests/crossings.js` 8 |
| 63 | An invoice is asked about, and claimed, only at the mint that made it | `15-receiving.js:watch` (`madeAt`), `_claimOnce` | `tests/crossings.js` 8 |
| 64 | A Lightning address or LNURL is paid only when the invoice it resolves to is for exactly the amount asked, to the millisat (`msatOf`), and for the description it sent (LUD-06). Compared in rounded sats, an address server could return up to half a sat more than asked and be paid | `16-sending.js:payLnurl`, `20-helpers.js:msatOf` | `tests/run.js` "a lightning address invoice must match the amount asked for to the millisat" |

Rows 15 and 16 are the ones to spend time on: they are the weakest proofs of
the strongest claims. Row 12 was one of them until §22b was run.

## Vocabulary

Foxy's own words, each defined where it first appears in the code. One line
each here.

| Word | Meaning |
|---|---|
| **piece** | one proof: an amount, a secret, the mint's signature |
| **pile** | this phone's spendable proofs at one mint (`01-storage-and-piles.js`) |
| **request** | a NUT-18 payment request Foxy made; `openRequests` is the ones still waiting |
| **lock key** | a P2PK key derived from the seed for one request; the **lock pool** is the keys made ahead (`primeLocks`) |
| **locked to us** | every proof spendable by one of our keys and nobody else (`onlyLockedTo`) |
| **held** | a payment locked to us whose DLEQ verifies: counted before the mint has swapped it |
| **unclaimed** | payments that arrived and are not yet swapped in; the balance counts them |
| **at risk / trusted** | unlocked ecash a person chose to take offline; the mint may later say it was spent (the path is off) |
| **claim** | swapping an unclaimed payment in at the mint (`claimUnclaimed`) |
| **forward / hand on** | an offline payer signing ecash locked to it and giving it to somebody else (`forwardLocked`) |
| **cover** | paying with pieces that add up to more than asked, the difference coming back as change |
| **change leg** | the receiver making the over-payment's difference locked to the payer and handing it back (M7/M8) |
| **carry home** | an online receiver taking a payment at the payer's mint and melting it to its own |
| **stuck at mint** | an offline payer whose money is at a mint the receiver does not use |
| **crossing** | paying somebody at another mint by moving the money there first |
| **tidy / small change** | the swap that keeps small pieces on hand so amounts can be made exactly (`tidyChange`) |
| **proof lock** | the mutex around anything that reads and writes the pile (`99-proof-lock-and-export.js`) |
| **swap guard** | the on-disk record of a swap's outputs, so a lost answer is recoverable (`04-lost-answers.js`) |
| **job / circuit** | one Tor circuit per piece of work (`onCircuit`), so a mint cannot join two requests by their route |
| **the gate** | the launch screen that holds the app until Tor is up or the person chooses offline (`Web/foxy-tor-gate.js`) |
| **tap** | a payment between two phones over Bluetooth; **M1–M12** are its messages (`TapSession.swift`) |
| **offer** | what the receiver hands a payer on a tap: an invoice, a request, or both |
| **code** | the four digits both phones show once a tap's keys are agreed |
| **the diary / field log** | the on-device log, pulled with `tools/pull-device-log.sh`; names mints and amounts |
| **the phone** | in tests, the mocked native side that holds the seed (`tests/harness.js:nativePhone`) |
| **the fake mint** | `tests/harness.js:fakeMint`: signs, verifies, charges fees on request, and fails on demand |

## The documents

`THREAT-MODEL.md` (what is defended against), `MONEY.md` (how money moves),
`SEED-HANDLING.md`, `STORAGE.md`, `CASHU-CONFORMANCE.md` (against the NUTs),
`MINT-PRIVACY.md` (what a mint learns), `TAP-TO-PAY.md`, `TOOLCHAIN.md`,
`DEVICE-TESTS.md` (what only a phone can prove), `AUDIT.md` (a map of where to
look and how to check each claim). `build/README.md` says how the page is
built.
