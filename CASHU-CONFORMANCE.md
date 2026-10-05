# CASHU-CONFORMANCE.md — which NUTs Foxy follows, where, and where it differs

Written for someone who knows the Cashu protocol and has not read Foxy's code.
It names the file and function for each NUT, the tests behind it, and every
place Foxy chooses differently from Nutshell's wallet, CDK's wallet or cashu-ts.

The phone keeps the seed and the counters and derives every secret, and the
page has no other path. Compared against:

| Reference | Version |
|---|---|
| NUT specs | `cashubtc/nuts` 38d243a for the text; the test vectors in `tests/vectors/` are from `3bc8b6d5b160` (`tests/vectors/README.md`) |
| cashu-ts (bundled as `Web/cashu-ts.js`) | 4.11.0 |
| Nutshell | 6e77e85 (wallet code); mint 0.21.0 in the live tests |
| CDK | ca1dd83 (wallet code); `cdk-mintd` 0.18.1 in the live tests |

Paths below are in `build/wallet/`, which is joined into `Web/foxy-wallet.js`,
unless they start with another folder.

---

## How the wallet is put together

- **cashu-ts does the protocol.** Hashing to the curve, blinding, unblinding,
  DLEQ checks, keyset loading, coin selection, fees, token encoding and
  decoding, payment request decoding and NUT-20 signing are all cashu-ts
  4.11.0. The bundle is rebuilt byte for byte from cashu-ts's git
  tag (`bash tools/vendor/verify-cashu-ts.sh --from-source`). Foxy does not
  reimplement any of it.
- **The phone does NUT-13.** Swift makes the twelve words and derives every
  output's secret and blinding factor (`Foxy/Keychain/NUT13.swift`), for the
  counters it has just reserved or a restore has asked for. cashu-ts builds the
  blinded outputs from what the phone sent, through Foxy's own
  `OutputDataCreator` (`nativeOutputCreator` in `03-seed-counters-logs.js`):
  every cashu-ts wallet is built on a placeholder seed, the creator refuses any
  other, and it makes no output from the placeholder. The page never has the
  words.
- **Foxy does the state.** It stores proofs (the phone stores the counters), decides when to
  retry, holds proofs during a payment, recovers answers that were lost, and
  adopts what a restore finds. That is where Foxy's own decisions are, and
  where most of this document is.
- **Every mint request goes through the native side.** cashu-ts is given a
  request function (`22-screen-lock.js`, despite the file's
  name) that sends each call to Swift, which carries it over Foxy's own Tor or
  refuses it. The page itself has no network access. This is why there are
  no WebSockets (NUT-17). It is also why mint errors are rebuilt as cashu-ts's
  own `MintOperationError`: cashu-ts reads the error code to decide on its
  NUT-20 fallback.

Wallet options (`unitWallet` in `03-seed-counters-logs.js`, `connect` in `11-routing.js`):

```js
{ bip39seed: placeholderSeed(), secretsPolicy: 'deterministic',
  counterSource: sharedCounters, unit, requireSigDleq: true,
  outputDataCreator /* set by newWallet: the phone's secrets */ }
```

There are no random secrets. Every output comes from the seed and a counter.
All wallet objects share one counter source, the phone, which reserves a range
and answers its secrets in one reply, never hands out a used range and never
moves a counter down. With no native bridge (a browser) the wallet refuses to
connect.

---

## NUT by NUT

Status:
- **Yes** — implemented.
- **Partial** — part of the NUT is used.
- **Refused** — recognised and turned down on purpose.
- **No** — not implemented.

| NUT | Title | Status | Where | Tests |
|---|---|---|---|---|
| 00 | Notation, terminology | Yes | cashu-ts. Sends `cashuB` (v4) only: `getEncodedToken` in `19-bill-split.js` and `02-dleq-lock-holds-imports.js`. Receives v3 and v4. | `tests/nut-vectors.js`: hash_to_curve, blinding, v3 and v4 tokens, malformed and padded v3 |
| 01 | Mint public keys | Yes | `w.loadMint()` in `connect` (`11-routing.js`), 30 s limit. Foxy checks the keys itself — compressed shape and on the curve — before any mint answer is believed or cached (`mintKeysProblem`, `01-storage-and-piles.js`), because cashu-ts's own `Keyset.verify()` takes the two keysets NUT-01 says to reject | `nut-vectors.js` NUT-01, all four vector keysets; live `flows.js` |
| 02 | Keysets and fees | Yes | cashu-ts fee calculation. Sends use `includeFees: true` (`16-sending.js`, `19-bill-split.js`), so the sender pays the receiver's input fee. | `nut-vectors.js` (keyset ids); live `flows.js` step 2 with `input_fee_ppk` 100 |
| 03 | Swap | Yes | `sendToken` and `receiveToken` (`19-bill-split.js`). Both run inside `swapGuard`, which records the output counters before the request goes out. | `run.js` "a received token whose swap answer was lost…" and related tests; live `faults.js` (a), (e5) |
| 04 | Mint | Yes | `invoice`, `watch`/`claim`, `sweepQuotes` (`15-receiving.js`) | `run.js` claim and ISSUED tests; live `flows.js` step 1 |
| 05 | Melt | Yes | `pay` (`16-sending.js`). Proofs are held in `foxy.cashu.melting` before the melt, and `sweepMelts` (`15-receiving.js`) settles held melts from the quote state. The `payment_preimage` the mint gives is kept on the payment's history entry (`preimageOf`), from the melt's own answer or from the quote when a held melt is settled; only 32 bytes of hex is taken for one. | `run.js` melt PAID/UNPAID/PENDING tests; live `flows.js` steps 4–5, `faults.js` (b), (e) |
| 06 | Mint info | Yes | reads NUT-20 support. It does not refuse a mint that leaves NUT-07 or NUT-09 out. `motd` is read by nothing: a mint's message of the day was once drawn on a card, and the field is now ignored, so no prose a mint writes reaches the screen. | — |
| 07 | Proof state check | Yes | for a payment locked to one key, the `witness` the mint returns for its spent pieces is read, checked against each piece with cashu-ts (`isP2PKSpendAuthorised`) and kept as the payment's receipt (`lockedReceipt`, `20-helpers.js`); also used by `reconcile` (`17-backup.js`), `scanSeed`, `importProofs`, `sweepMelts`, putting quarantined proofs back, and by `receiveToken` and `reclaimToken` before they swap (`refuseSpent`, `00-header-and-mint-errors.js`): `SPENT` or `PENDING` refuses the token with no counter reserved, and a check that fails swaps as before. | `run.js` import and quarantine tests, and the "W5" tests (a spent token refused before the swap, a pending one refused, a failed check still receives) |
| 08 | Lightning fee return | Yes | blank outputs from cashu-ts. If the melt's answer is lost, the change is rebuilt from the counters it reserved (`recoverMeltChange`). | `run.js` "a melt found PAID later gets its change back…"; live `faults.js` (e3), (e4) |
| 09 | Restore signatures | Yes | cashu-ts `w.restore` for one batch; Foxy runs the loop (`walkKeyset`, `13-restore.js`) | `run.js` restore batch tests; live `flows.js` step 7, `cross-wallet-restore.js`, `used-counters.js` |
| 10 | Spending conditions | Partial | Read, and made for one case. A locked secret is refused before the mint is asked (`lockedProofs`, `00-header-and-mint-errors.js`) unless this phone holds the key it names | `run.js` "a token locked to a key is refused before the mint is asked", "a locked token is refused when the key kept is for another lock"; `nut-vectors.js` NUT-11 vectors |
| 11 | P2PK | Partial | For payment requests only (below). Foxy uses a fresh key per request, asks payers to lock to it, and claims what comes back. An ordinary send still carries no lock, and the old custom P2PK scheme is gone. **The key is derived from the seed, not random**: NUT-13's P2PK path, `m/129373'/10'/0'/0'/{index}`, walked by the phone (`Foxy/Keychain/P2PK.swift`) with a **non-hardened** last level, as CDK's `crates/cdk/src/wallet/p2pk.rs` does. Foxy still builds no NUT-11 witness itself — cashu-ts signs, given the key | `tests/p2pk-round-trip.js` end to end, including a token opened on another device from the twelve words alone; `FoxyTests/P2PKTests.swift` against BIP-32's own vector and a second implementation in `tests/harness.js`; `nut-vectors.js` NUT-11: the spec's own vectors, both SIG_ALL message constructions, and Foxy's receiver run over every one of them; live `p2pk.js` against CDK 0.18.1 and Nutshell 0.21.0; `run.js` "the custom P2PK scheme is gone", "a token Foxy sends carries no lock", "a token half locked to us is refused whole, not half claimed" |
| 12 | DLEQ | Yes | `requireSigDleq: true`. Foxy's own `dleqAudit`/`checkIssued` (`02-dleq-lock-holds-imports.js`) runs on stored and imported proofs, and on restored ones (`scanSeed` audits, `adoptScan` reports). | `nut-vectors.js`; `run.js` DLEQ tests, "W7 restored proofs whose DLEQ fails…"; live `faults.js` (d) |
| 13 | Deterministic secrets | Yes | The phone makes 12 words (128 bits, `Foxy/Keychain/BIP39.swift`) and derives each secret and blinding factor (`Foxy/Keychain/NUT13.swift`): BIP-32 for `00` keysets, HMAC-SHA256 for `01`. The page asks for reserved ranges (`counterReserve`, `counterReserveAt`) or restore ranges (`restoreSecrets`), and cashu-ts builds the outputs from them through Foxy's `OutputDataCreator`. **Legacy base64 keyset ids** (from before NUT-02's versioned ids) **are not derived**: cashu-ts could, the phone does not. No output is made on one, and a restore marks such a keyset partial at once and names it (`walkKeyset`, `13-restore.js`). | `FoxyTests/NUT13Tests.swift`: the spec's vectors and 856 answers from the bundled cashu-ts. `tests/nut13-vectors.js`: cashu-ts's derivation, which the mocked phone uses, both keyset versions. `tests/run.js` "seed on the phone: … make NUT-13's outputs for the words", both keyset versions, and "L11 a legacy base64 keyset is marked partial at once" |
| 14 | HTLC | Refused | as NUT-10 | as NUT-10 |
| 15 | Partial multi-path payments | No | — | — |
| 16 | Animated QR codes | Yes | a token too dense for one code is shown as a loop of frames in Uniform Resources form (`ur:bytes/…`), made in `build/wallet/06-animated-qr.js` to be, character for character, the frames cashu.me's library makes, and read back by `Foxy/Scanner/AnimatedQR.swift` | `tests/animated-qr.js`, `FoxyTests/AnimatedQRTests.swift` |
| 17 | WebSockets | No | Foxy polls instead (`watch` in `15-receiving.js`): every 2 s for the first 2 min, every 10 s up to 15 min, then every 30 s. | `run.js` |
| 18 | Payment requests | Partial | `decodeRequest` (`18-seed-phrase.js`) through cashu-ts, then `openRequest` (`build/app/07-history-tokens-mints.js`). See below. | `nut-vectors.js` NUT-18 vectors; `tests/fuzz-parsers.js` |
| 19 | Cached responses | No | Foxy records outputs before the request and recovers from counters instead; see below. Measured: CDK 0.17.5 advertises it (`ttl` 60 s, over `/v1/swap`, `/v1/mint/bolt11`, `/v1/melt/bolt11` and the bolt12, onchain and paypal pairs); Nutshell 0.20.3 and 0.18.2 do not | — |
| 20 | Signature on mint quote | Yes | `quoteLock` (`00-header-and-mint-errors.js`): a fresh random key per quote, stored with the quote, used only when the mint advertises NUT-20. Measured over Tor at the Minibits mint: it refuses cashu-ts's amended signature with 20008 and takes the legacy message, so every claim there is two requests over Tor — cashu-ts's own fallback, with the same blinded outputs both times, so nothing is issued twice | `nut-vectors.js` NUT-20 signing; `run.js` NUT-20 tests; live `flows.js` step 1 |
| 21 | Clear authentication | No | a mint that requires it cannot be used | — |
| 22 | Blind authentication | No | `auth` keysets are skipped by restore (`13-restore.js`) | — |
| 23 | BOLT11 | Yes | the only payment method used | live `flows.js` |
| 24 | HTTP 402 | No | — | — |
| 25 | BOLT12 | Refused | `lno1…` is recognised (`20-helpers.js`); the app says mints cannot pay it yet (`build/app/12-receive.js`) | — |
| 26 | Bech32m payment requests | Partial | cashu-ts's decoder reads `creqB` as well as `creqA`; handled as NUT-18 | `nut-vectors.js`: the spec's 17 request pairs through cashu-ts's decoder and through Foxy's own reader |
| 27 | Nostr mint backup | No | — | — |
| 28 | P2BK | No | — | — |
| 29 | Batched minting | No | — | — |
| 30 | On-chain | Yes | `16a-onchain.js` through cashu-ts's NUT-30 calls: an address to be paid into (`onchainAddress`, a NUT-20 signed quote), claimed once the mint's confirmations are in (`onchainClaim`), and a payout quoted with the mint's fee options and followed to `PAID` (`onchainQuote`, `onchainPay`, `onchainFollow`). Offered only where the mint's info says so, per direction. | `address-vectors.js`; `tests/fuzz-parsers.js` |

**On-chain (NUT-30):**
- The mint decides. `onchainLimits` reads `/v1/info` for the `onchain` method
  under NUT-4 and NUT-5 separately, so a mint that takes on-chain payments but
  will not make them offers the network on the receive screen and not in send.
- **An address is not an invoice.** It carries no amount, it can be paid any
  number of times, and this mint gives it no expiry. So the amount typed is
  only a BIP-21 hint on the QR, what is watched is the *quote* rather than a
  payment, and Foxy keeps its own watch window (seven days) over the addresses
  it made.
- **Under the mint's floor the money is gone**, not refused: the spec says a
  payment below `min_amount` does not count towards the quote and cannot be
  recovered. Foxy will not offer the network for an amount below it, and the
  screen says the floor and the confirmations in plain words.
- A payout is not done when it leaves. The mint answers `PENDING` when it takes
  the ecash and `PAID` only once the transaction confirms, so history holds it
  amber until `onchainFollow` sees `PAID`. The melt quote is what is asked —
  never the proofs' state, which says nothing about a chain transaction.
- Claims run one at a time: every claim reserves counters, and two at once
  would derive the same secrets.
- Addresses are checked here before the mint sees them, by their own checksum
  (bech32/bech32m per BIP-173 and BIP-350, base58 by the double-SHA-256), and
  mainnet only. `tests/address-vectors.js` holds that reader to the BIPs' own
  valid and invalid vectors.

**Payment requests (NUT-18/26):**
- Foxy's own requests carry a `post` transport whose target is an onion address
  on the phone, open only while the request is on screen
  (`Foxy/Network/OnionInbox.swift`). Another Foxy pays it straight over Tor;
  wallets that cannot reach `.onion` cannot, and fall back to the token.
- Paying a request, Foxy delivers over a `post` transport to an onion address,
  or over nostr (NIP-17 gift wrap, keys made for that payment, published to the
  relays the `nprofile` names) — `Foxy/Nostr`. Anything else is marked
  `deliverable: false`, and the app offers to make a token at the mint the
  request names, for the person to hand over.
- The payment is NUT-18's `{id, mint, unit, proofs}` (plus Foxy's optional
  `changeTo` and `overpaid`, which other wallets ignore), with DLEQ where the
  proofs carry it. The amount is checked net of the mint's input fee, as NUT-18
  says: at least what was asked, and any over-payment is change owed back.
- Requests for units other than sat are refused.
- A mint this device has never used gets a warning card first; connecting to
  it is a separate tap. Only string mint URLs are kept from a request.

**P2PK on a payment request (NUT-10/11):**
- A request Foxy makes carries a fresh secp256k1 public key in its `nut10`
  field (`{kind: 'P2PK', data, tags}`, the 8th `PaymentRequest` argument). One
  key per request, never shared between two.
- **The key is the seed's**, at NUT-13's P2PK path
  `m/129373'/10'/0'/0'/{index}` — purpose 129373, account 10, and a
  **non-hardened** `{index}`, as CDK derives it
  (`crates/cdk/src/wallet/p2pk.rs`, `P2PK_PURPOSE`, `P2PK_ACCOUNT`). cashu-ts
  has this only on its v5 line and Foxy bundles 4.11.0, so the phone walks it
  (`Foxy/Keychain/P2PK.swift`). Before, the key was random: nothing in the
  twelve words could rebuild it, so ecash locked to one on a phone that was lost
  was money nobody could ever move. `foxy.req.lockkeys` now keeps `{i, pub}` and
  no private key; rows written before hold a random key and go on working for
  ever, because there is nothing to convert them to. Neither CDK nor Foxy ever
  expires or prunes a lock key.
- What that does **not** do: a restore cannot find ecash locked to these keys.
  Those proofs were minted by the payer, from the payer's blinding factors, so
  NUT-09's restore never sees them. What it does is open a token already in
  hand, on any device, from the words — `p2pkPubkeys` walks the path and the
  page matches the lock the token carries, so the index need not be known.
- Only where the mint advertises NUT-11. Without it the request goes out
  unlocked, exactly as before, rather than asking for something the mint cannot
  enforce.
- A payer on that mint swaps before sending so every proof carries the lock.
  Ecash taken off the air, or off a relay, is then worthless to anyone but the
  phone that asked for it — which is what makes handing it straight over a
  Bluetooth link safe (`TAP-TO-PAY.md`).
- Claiming: a locked token is refused unless this phone holds the key. Only
  the locked proofs have to be ours — an offline payer's token
  is plain pieces beside locked ones — and a token with some locked proofs that
  are not ours is refused whole. A locktime on a lock of ours is accepted only
  where the swap follows at once and the time is a day or more away; kept
  offline, or handed on, any locktime is refused, in words that say when. The
  key is found by the lock as well as by request id, so a payment that arrived
  and was never claimed can be pasted in long after the request is forgotten.
- Two questions, not one. `onlyLockedTo` asks cashu-ts who can open the proof
  (`getP2PKExpectedWitnessPubkeys` — the tags decide, not the `data` field) and
  then asks whether the condition can be met at all
  (`verifyP2PKSpendingConditions`). Being the only key that can sign is not the
  same as being able to spend: `["n_sigs","2"]` beside one key wants two
  signatures from it, which NUT-11 calls malformed, and `SIG_ALL` wants the
  whole transaction signed, which Foxy has no path for. Both name this phone
  and nobody else, so the first question passes and the money is unspendable —
  found by reading how Nutshell and CDK decide the same thing.
- Foxy sets no locktime and no refund key, so a mint that never accepts the
  claim strands the ecash. That is the trade for a lock the payer cannot take
  back, and it is why the token is written down before anything is attempted
  with it (`MONEY.md` §11).
- **Checked against real mint software**, not only the harness: `tools/live/p2pk.js`
  runs the whole path — NUT-11 advertised and read, a locked send the mint
  signs, the mint refusing that send without a witness and with the wrong key,
  Foxy claiming it with the right one, and a lost swap answer rebuilt by
  `restoreLocked` — against CDK 0.18.1 and Nutshell 0.21.0. Every shape Foxy
  refuses was *minted for real* by both (a mint cannot see what it signs), and
  both mints then let the party Foxy warned about spend it: a key of ours beside
  the payer's went to the payer, an expired locktime with no refund went to
  anyone, an HTLC naming us went to whoever had the preimage. Foxy's refusal is
  the only thing standing between the user and them.
- **One divergence between mints, which Foxy is immune to.** At exactly
  `now == locktime`, CDK 0.18.1 refuses an unsigned spend and Nutshell 0.21.0
  allows it; merged NUT-11 puts that instant on the locked side, so CDK follows
  the text. cashu-ts reports "expired" there too. Foxy asks for no locktime and
  refuses a proof locked to it that carries one (`hasLocktime`), except where
  the swap follows at once and the locktime is a day or more away
  (`LOCKTIME_MARGIN_S`), so its answer is the same on both — the live suite
  prints the divergence rather than failing on it.

---

## Counters

Counters are the phone's: per keyset in `foxy-counters.json`, written before a
range is handed out and never lowered (`STORAGE.md`). An older install's
`foxy.counter.v1` went to the phone once, at boot, and is never written again.
The seed itself is in the iOS Keychain.

**Outputs already signed.** A mint may refuse a request because it has seen
the outputs before. Foxy treats these codes as that refusal
(`USED_OUTPUT_CODES`, `00-header-and-mint-errors.js`):

| Code | Meaning |
|---|---|
| 10002 | Nutshell before 0.19, "outputs have already been signed before" |
| 11003 | Nutshell, "outputs already signed" |
| 11004 | Nutshell, "outputs are pending" |
| 11008 | CDK, "Duplicate outputs" |
| 20006 | CDK on a claim only, "Invoice already paid or pending", while the quote still reads `PAID` (`mintSaysPaidOrPending`). On a melt the same words can mean the invoice really was paid, so they are not treated as used outputs there. |

When one comes back:
- The counters move on by 10, then 50, then 100, and the request is tried once
  more after each move (`COUNTER_SKIPS`).
- A keyset may skip at most 160 counters per session (`SKIP_BUDGET`);
  after that the error is shown. The limit keeps a gap well under the 1,000
  empty counters (10 batches of 100) at which a restore stops, so ecash made
  after a skip is still found.
- **The budget is per session, and nothing bounds the total across sessions.**
  `skipsLeft` is in memory, so every page load starts again at 160. One session
  cannot open a gap a restore will not cross; several can, but only if they skip
  back to back with nothing signed in between — a skip that then succeeds puts
  signatures in the range and breaks the run of empty counters, and only an
  unbroken run of 1,000 stops a scan. The case to watch is a keyset that fails,
  skips its whole budget, and is met again in the next session still failing.
  Nothing detects that today; a counter far past what any restore found is what
  it would look like.
- Skipping loses nothing: a restore walks every counter from 0, so it still
  finds anything signed in a skipped range (within the restore window below).
- Why: before this, one used range (after a restore set a counter too low)
  failed every swap at that mint until something else moved the counter. That
  was seen on a device against a CDK mint.

| Wallet | On used outputs |
|---|---|
| Foxy | skips 10 / 50 / 100, retries, 160 per keyset per session |
| cashu.me | moves the counters on and retries (as described in Foxy's source; cashu.me not re-read for this document) |
| Nutshell wallet | no automatic skip found in `cashu/wallet/` |
| CDK wallet | returns `BlindedMessageAlreadySigned` to the caller (`wallet/swap/mod.rs`, and its test) |

**Every counter is reserved before its request goes out**, and the reservation
is recorded with the operation:
- `swapGuard` for swaps;
- the claim's outputs for mints;
- the change outputs for melts.

If an answer is lost after the mint acted, Foxy rebuilds exactly those outputs
with NUT-09 (`recoverSwaps`, `recoverIssued`, `recoverMeltChange`), checked
against the amount the operation should have produced. This does the job
NUT-19's cached responses would, without needing the mint to support NUT-19.

**Why not use NUT-19 where it is offered.** Of the mints
Foxy is tested against, only CDK 0.17.5 advertises it, with `ttl` 60 s; Nutshell
0.20.3 and the public testnut (0.18.2) do not. A 60-second cache answers "did my
request land?" only if the wallet can ask again inside the minute, and Foxy's
requests go over its own Tor, where a lost answer usually means a circuit died
and the reconnect takes longer than that. The counter record has no expiry: the
range is on disk and is rebuilt whenever the wallet next reaches the mint, an
hour or a day later. So NUT-19 would be a second recovery path covering a subset
of the cases the first one already covers, on a minority of the mints, with a
new way for the two to disagree — and the counters are reserved and written
before the request either way, so it would not save them.

Worth revisiting if mints ship materially longer TTLs, or if a mint Foxy uses
supports NUT-19 and not NUT-09 restore.

---

## Restore

`scanSeed` (`13-restore.js`) only reads. `adoptScan` writes.
`MONEY.md` §6 has the full rules.

| | Foxy | NUT-13 text | CDK wallet | Nutshell wallet | cashu-ts `batchRestore` |
|---|---|---|---|---|---|
| Batch | 100 | 100 | 100 (`NUT13Options::DEFAULT_BATCH_SIZE`) | 25 | mint's max array length |
| Stop after | 10 empty batches in a row (`RESTORE_GAP`, 1,000 counters) | 3 empty batches | 3 (`DEFAULT_MAX_GAP`) | 2 empty batches | `ceil(1,000 / batch)` empty batches |
| Starts at | counter 0 | counter 0 | — | the stored counter | argument, default 0 |
| Keysets | every keyset of every unit, auth excluded | — | not compared | not compared | the one named |
| A batch that fails | 3 tries, 45 s each; then the keyset ends and the row is marked partial | — | — | — | throws |
| How far | this wallet's own seed: up to 1,000 past the phone's next counter; typed words: from 0, 1,000 past what was served, 20,000 a keyset | — | — | — | — |
| Keysets | `00` and `01` only; a legacy base64 keyset is marked partial at once | — | — | — | any cashu-ts derives |

Foxy chose its own retry and partial rules because it restores over Tor. There,
one slow answer used to cost a whole keyset. Its gap is wider than NUT-13's
three batches because a swap that shapes its own outputs can burn sixty counters
at a go.

**Restore windows.** The phone serves secrets for a restore without moving a
counter (`restoreSecrets`), and only so far, so a script in the page cannot
collect the secrets of counters far ahead of the wallet and wait for what they
later receive:
- **This wallet's own seed** (the new-mint sweep, a rescan): up to 1,000 counters
  past the phone's next one, ten empty batches of 100. The walk stops
  there, and a keyset that reaches it without ten empty batches is marked
  partial; adopting the row moves the counter, and the next scan looks further.
- **Words typed into RESTORE** (a candidate the phone holds): from 0, each
  request at most 1,000 past the furthest range already served, and 20,000
  counters a keyset.
- **A lost answer's recorded ranges** are below the phone's next counter, so
  always inside the window.
- **Counter moves are capped too**: the phone
  moves a counter at most 100 past its next one, or to the end of a range
  `restoreSecrets` served this session. The used-output skip (10, 50, 100) moves
  from the phone's next counter, and adopting a scan peeks each keyset's counter
  first; a mint that answers after words were adopted, further on than 100, is
  followed in steps, each to the end of a restore range of this wallet's seed
  the phone serves first. A `00` keyset's counters are its derivation index's
  (id mod 2³¹ − 1), whatever id names it.
- **An adopted candidate stays on the phone** until the page forgets it, which it
  does only once every scan using it has ended. The phone still drops every
  candidate when Foxy goes to the background or the page loads again; a batch
  refused then ("unknown candidate") is restored with this wallet's own seed,
  which the adopted words are, inside its window, instead of marking the row
  partial.

What is adopted:
- **Only `UNSPENT` proofs.** Before, anything not `SPENT` was kept,
  so `PENDING` proofs were counted as balance.
- **Not proofs already spoken for** (`spokenForSecrets`,
  `04-lost-answers.js`): proofs held by a melt still routing, proofs in
  quarantine, and proofs inside a token the person has sent that is still on
  file. Until someone redeems that token, the restore leaves its proofs out of
  the balance.
- **Counters only move forward.** Each keyset takes the higher of its stored
  counter and one past the last counter the mint signed.
- **Different words go to the phone first** (`seedAdopt`), which asks the
  person to confirm. Only after that are the old counters set aside (by the
  phone) and the new ones and their proofs written. Declining changes nothing.
  Adopted, or found to be the saved seed, each counter rises to what the words
  were served. New words are refused while a melt is held or a lost swap is
  being recovered (`foxy.cashu.melting`, `foxy.cashu.swaps`): neither record
  names its seed. The wallet's own words are let through.

Proven against other wallets on local mints (results below):
- Foxy's words restored in Nutshell's `cashu` CLI and in `cdk-cli` give the same
  total.
- The CLIs' words restored in Foxy give the same total.
- The restored proofs spend with no counter skips.

---

## Payments and holds

**Melt** (`pay` in `16-sending.js`; `MONEY.md` §2):
1. The inputs are written to `foxy.cashu.melting` before the request goes out.
2. Only `PAID` is final.
3. `PENDING` keeps the hold.
4. If the melt request fails, the quote state decides:
   - `PAID` is filed as a payment and the change is recovered;
   - `FAILED` gives the proofs back;
   - `UNPAID` gives them back only if the mint itself refused the melt (a 4xx
     or a coded error). After a timeout or a lost connection the request may
     still be on its way, so `UNPAID` keeps the hold.
5. `sweepMelts` gives back a hold at least two minutes old whose quote reads
   `UNPAID`, or `PENDING` with every input `UNSPENT`. The hold is written
   before the melt goes out, and the native request limit is 60 s, so nothing
   can still be in flight by then.

**Mint quotes** (`MONEY.md` §1):
- The claim runs while polling. `sweepQuotes` runs on connect and on resume.
- An expired `UNPAID` quote is dropped.
- An `ISSUED` quote with recorded outputs is restored from them.
- After 3 refusals (a 4xx or a coded error, `mintRefused` in
  `04-lost-answers.js`) the automatic claim stops; the app offers one
  manual TRY AGAIN (`retryRefusedClaim`). A refused claim used to be
  retried on every connect and used up counters each time.
- A quote whose signatures fail their DLEQ check is never retried.

**NUT-20 and CDK 0.17.5.**
- cashu-ts 4.11.0 signs the amended message (nuts#375) first. On a `20008` it
  retries once with the legacy message (`Wallet.ts`, in cashu-ts's mint-quote
  signing).
- CDK 0.17.5, and Nutshell 0.18 mints such as testnut, refuse
  the amended signature with 20008 and accept the legacy one. So every signed
  claim at those mints takes two requests.
- Newer code accepts both. CDK at ca1dd83 (0.18.0) checks the amended
  message and falls back to the legacy one (`crates/cashu/src/nuts/nut20.rs`,
  `verify_signature`), and so does Nutshell at 6e77e85 (`nut20.py`,
  `verify_mint_quote`). The double request is therefore a CDK 0.17.5 issue.
  CDK 0.18 **was** run live: the earlier-versions table below records `flows.js` 18 OK, `faults.js` 112 OK, `used-counters.js` 6 OK and `cdk-cli-reverse.js` 6 OK against CDK 0.18.0, and the current tables run CDK 0.18.1.
- The retry happens inside one cashu-ts call. Foxy records a refusal only when
  that call finally throws, so the first 20008 does not count toward the limit
  of 3.
- Seen in the live tests: every signed claim at CDK succeeded (`flows.js`
  step 1, `faults.js` (a2)).
- Also seen: Nutshell's `cashu invoice` never finishes against CDK 0.17.5,
  looping on 20008.

---

## Units

- Any unit matching `^[a-z0-9]{1,16}$` (`unitOf`, `01-storage-and-piles.js`)
  gets its own proof store per mint. A usd token goes into the usd store and is
  never added to sats.
- The app sends only sats: tokens, Lightning and payment requests.
- Restore walks non-sat keysets too.
- Test: `tests/units.js`, and live `units.js` against a Nutshell mint with a
  usd keyset.

---

## Moving words between wallets

- **Nutshell's wallet before 0.20.0 derives version `01` keysets the old way.**
  NUT-13 derives secrets for a version `01` keyset with HMAC-SHA256. Nutshell's
  wallet used BIP-32 for every keyset until 0.20.0, where `secrets.py` first
  switches on the keyset version; Foxy (cashu-ts), CDK's wallet and Nutshell
  0.20 follow the spec.
  - CDK 0.17.5 and 0.18.0 mints issue version `01` keysets. At those mints, words
    moved between Foxy and a Nutshell wallet older than 0.20.0 restore nothing,
    in either direction.
  - Nutshell mints issue version `00` keysets (testnut, 0.18.2, `00b4cd27…`),
    where both derivations agree, so moving words works there with any version.
  - Seen live: Nutshell 0.19.2's `cashu restore` found 0 sat at CDK
    0.18.0 for Foxy's words, where `cdk-cli` 0.18.0 and Foxy each found 223.
- **Word count.** Foxy's phone makes 12 words, and its restore screen (the
  phone's `seedEnter`) takes exactly 12. `cdk-cli` makes 24. The wallet
  restores a 24-word seed given to the mocked phone (`cdk-cli-reverse.js`), but
  the app has no way to enter one.

## Output shaping and the change pool

cashu-ts's `getKeepAmounts` aims at three of each denomination. Foxy aims at
twelve of each of 1–128 sats and eight of each larger power of two, and has
the swap a payment or a receipt makes anyway choose its outputs to fill that
(`shapeOutputs`): every tier below target, smallest first, sixty pieces at
most, six of a size, within the mint's `max_array_length`. A locked send puts
one large piece in rather than letting cashu-ts select, so the small pieces
survive. A separate top-up swap runs only with the app in the background.
Mints saw nothing new in this — a swap with sixty outputs is ordinary — but
two things follow for an implementer: a refused shaped swap burns sixty
counters, so the restore gap is 1,000; and `max_array_length` has to be
honoured on outputs as well as inputs, which the live `array-cap` suite
checks at a CDK mint started with `CDK_MAX_ARRAY=25`.

## What an implementer might do differently, and Foxy's reasons

1. **Polling, not WebSockets.** A WebSocket cannot be carried over Foxy's
   native Tor.
2. **Automatic counter skips** on 10002/11003/11004/11008, with a limit per
   session. Nutshell and CDK wallets leave this to the caller.
3. **Restore retries and partial results.** Built for slow Tor circuits.
4. **Restore leaves out proofs in unredeemed sent tokens and held melts.**
   Other wallets restore every unspent proof.
5. **No NUT-19.** Outputs are recorded before each request and rebuilt from
   counters when an answer is lost. Mint-independent, and with no TTL to beat:
   CDK's cache lasts 60 s, which a Tor reconnect often outlives ("Counters").
6. **Locked ecash is refused unless this phone holds the key**, and accepted
   only when cashu-ts says that key is the only one that can open it. Keys are
   held for payment requests alone (`foxy.req.lockkeys`), one per request.
7. **The sender pays the receiver's swap fee** (`includeFees: true`).
8. **The DLEQ proof is required only when the mint advertises NUT-12**, and an
   import without one is accepted. This matches cashu-ts and Nutshell.

---

## Reading order for `build/wallet/`

1. `00-header-and-mint-errors.js`: storage keys, how mint errors are sorted,
   used-output codes, counter skips, locked proofs, NUT-20 quote keys.
2. `01-storage-and-piles.js`: how proofs are stored per mint and unit.
3. `03-seed-counters-logs.js`: the seed on the phone — the bridge contract,
   the one-time move of an older install onto the phone, the secrets cache and
   the `OutputDataCreator`, the shared counter source, wallet options.
4. `11-routing.js`: `connect`.
5. `15-receiving.js`: `invoice`, `watch`, claim, `sweepQuotes`, `sweepMelts`.
6. `16-sending.js`: `pay`.
7. `19-bill-split.js`: `receiveToken`, `sendToken`, `importProofs`.
8. `04-lost-answers.js` and `02-dleq-lock-holds-imports.js`: `swapGuard`,
   recovery, DLEQ checks, holds, quarantine.
9. `13-restore.js`: `scanSeed`, `adoptScan`.
10. `17-backup.js`: `reconcile`.
11. `22-screen-lock.js`: the request function that goes over
    the bridge.

`MONEY.md` describes every money path in the same order, with what is written
at each step and what an app kill at that point costs.

---

## Live test results

Foxy's wallet (`Web/foxy-wallet.js` on the bundled cashu-ts), run in jsdom
against local Docker mints with fake Lightning. The native bridge is mocked
with `fetch`, so these requests do not go over Tor. How to run them:
`tools/live/README.md`. Mint versions below are the ones the mints reported
themselves (`H.mintNames()` reads `/v1/info`), not the image tags; the name
falls back to the tag only for a mint that did not answer, and says so.

### The current pair: CDK 0.18.1 and Nutshell 0.21.0

`tools/live/local-mint.sh` starts `cashubtc/mintd:0.18.1` and
`cashubtc/nutshell:0.21.0`. They are not the pair cashu-ts's own Makefile pins,
`cashubtc/mintd:0.17.5` and `cashubtc/nutshell:0.20.3`, because the two mint
behaviours Foxy most needed live coverage of exist only past it:

- **NUT-06 `max_array_length`.** CDK 0.18 and Nutshell 0.21 are the first to
  advertise it. cashu-ts chunks its own `/v1/checkstate` and `batchRestore` by
  it; Foxy has two paths that do not go through cashu-ts and chunk by it
  themselves (`mintArrayCap` / `inChunks`), and neither had been exercised
  against a mint that set the cap low enough to bite.
- **CDK 0.17.6/0.17.7's changed melt saga recovery**, which is the one part of a
  mint restart a wallet can see.

The old pair still runs: `CDK_IMAGE=cashubtc/mintd:0.17.5
NUT_IMAGE=cashubtc/nutshell:0.20.3 sh tools/live/local-mint.sh up`.

Every suite's phone report was clean throughout: `refused 0`, `tooFarAhead 0`,
`wordsAsked 0`, `pageSeedDerivations 0`. Foxy needed no change to work against
either mint version.

| Suite | What it does | CDK 0.18.1 | Nutshell 0.21.0 |
|---|---|---|---|
| `flows.js all` | NUT-20 mint with the unsigned claim refused; swap and send with `input_fee_ppk` 100; receive and double receive; pay at the same mint and at the other (fee reserve, change); a melt left `PENDING`; importing a token and a JSON backup (a repeat and a broken DLEQ refused); restore in a fresh wallet, which then spends | 9 OK | 9 OK |
| `faults.js all` | a fault proxy between wallet and mint: (a) a swap answer lost, (a2) a claim answer lost after `ISSUED`, (a3/a3b) a receive answer lost, (a4) a split before a melt lost, (b) a melt answer lost, (c) quote checks answering 500, (d) signatures with a broken DLEQ, (e) slow answers up to 70 s | 56 OK | 56 OK |
| `paste-flows.js` | a token there and back, two pastes at once, a request carrying its amount | 11 OK | 11 OK |
| `used-counters.js` | swap, receive and claim on counters the mint has already signed, then a restore | 3 OK; the mint answered 11008 on the swaps and 20006 on the claim, Foxy skipped 10 each time; restore 216 = balance 201 + tokens 9 + 6 | 3 OK; 11003 on both, skipped 10; restore 216 matches |
| `cross-wallet-restore.js all` | Foxy's words restored by Nutshell's `cashu` CLI and by `cdk-cli` 0.18.0, with and without an outstanding token; the CLI's words restored in Foxy, then spent | 6 OK | 6 OK |
| `cdk-cli-reverse.js all` | a `cdk-cli` wallet's 24 words restored in Foxy, then spent | 3 OK: 192 = 192, spent with no skips | 3 OK: 192 = 192 |
| `array-cap.js` | Foxy's own chunking against a CDK started with `CDK_MAX_ARRAY=25` | 6 OK | — (needs the CDK cap) |
| `restart-melt.js` | the CDK container restarted under a melt | 6 OK | — (restarts the CDK container) |
| `onchain.js` | NUT-30 against the local `cdk-mintd`'s regtest chain | 23 of 23 | — (Nutshell offers no on-chain method) |
| `faults.js onchain` | the on-chain fault section, pointed at the local `cdk-mintd` rather than testnut | 41 OK | — |
| `units.js` | sats and usd under one seed, at a second Nutshell 0.21.0 whose `MINT_DERIVATION_PATH_LIST` carries a usd path: restore into separate stores, receive usd, refuse a usd receive twice, reconcile, refuse sending usd, restore again | — | 12 OK |

- **`flows.js` step 5 runs at both mints.** At CDK the melt is left `PENDING` by
  an invoice description, at Nutshell by a third mint, the pending-mode Nutshell
  from `pending-mint.sh` (pinned to 0.21.0 to match).
- **Restore figures**: `flows.js` restored A 277 + 11 outstanding = 288 and B
  80 = 80 at both mints; `cross-wallet-restore.js` 224 with a token out, 223
  without, at both, with `cdk-cli` 0.18.0 agreeing at 223 and the Nutshell CLI at
  224/223; the CLI's own words restored in Foxy at 149 (CDK) and 255 (Nutshell).
- **After the change-pool rework** (below) every suite in `tools/live/README.md`
  ran again against this pair, with the PENDING-melt Nutshell and a CDK started
  with `CDK_MAX_ARRAY=25`, including the fault proxy's slow cases (112 checks).
  All green, after three fixes the suites themselves found: a one-piece locked
  send written without the untouched pile (and doubled after a restored answer),
  shaped outputs over a mint's array cap, and a swap rule asking for more inputs
  than the cap.
- **Nutshell 0.21.0 and CDK 0.18 moved the NUT-04/05 `description` flag** from
  the top level of a method into a nested `options` object. cashu-ts accepts
  either spelling and Foxy never reads the flag; it reads `min_amount`,
  `max_amount` and, for on-chain, `options.confirmations`, which was nested
  already.
- **NUT-08 blank change outputs** as cashu-ts builds them are accepted
  (`flows.js` 4b pays with a fee reserve and gets change back, and `faults.js` e3
  and e4 recover change from counters). Nutshell 0.21's new error code 12002, for
  an inactive output keyset, has never come up, since nothing in these suites
  asks a mint to sign on an inactive keyset. `mintRefused` would treat it as a
  definite refusal, which is the right answer for it, but that is reasoning and
  not a result.

### The NUT-06 cap actually chunking (`array-cap.js`)

Foxy's chunking had no live coverage until a mint could advertise a small cap,
because every mint the suites ran against advertised 1000 or nothing, and a token
never had more proofs than that. `local-mint.sh` takes `CDK_MAX_ARRAY`, which
writes `[limits] max_inputs` and `max_outputs` into the CDK config; the mint then
advertises `max_array_length = min(max_inputs, max_outputs)`. At
`CDK_MAX_ARRAY=25`:

| Check | What the run showed |
|---|---|
| the mint advertises the cap, and cashu-ts reads it | `/v1/info` `max_array_length` 25; a cashu-ts `Wallet` loaded from it reports `maxArrayLength` 25 |
| a token with more proofs than the cap | 34 proofs, made from held single-sat pieces with no swap (`exactPieces`) |
| the sent-token watch chunks `/v1/checkstate` | **34 Ys in 2 requests of 25 + 9**, every Y sent exactly once, watch reads `waiting` |
| the same request unchunked is refused | the 34 Ys in one POST: `400 {"code":11014,"detail":"Maximum inputs exceeded: 34 provided, max 25"}`; 25 Ys: `200` |
| the restore walk chunks `/v1/restore` | **5 batches of 25**, balance 6 + token 34 = 40 restored, scan not partial |
| the watch sees the redemption | reads `claimed` from the same 25 + 9 chunks |

That fourth row is the point of the script: without the chunking the watch's
request is refused outright, and a refused watch reads `waiting` for ever on a
token that has in fact been redeemed. The restore's is worse: a refused batch
ends the walk, which for a restore means ecash that is there and is not found.

**Known, and not fixed: a low `max_array_length` caps inputs too, and Foxy can
exceed it.** NUT-06's `max_array_length` is one number for both directions (CDK
computes it as `min(max_inputs, max_outputs)`), so a mint that sets it low also
caps how many proofs may go **into** a swap. Foxy keeps small pieces on hand on
purpose (`tidyChange`), so a wallet holding many of them at such a mint can:

- build a token of more proofs than the cap, which the receiver's swap then
  refuses whole: `Maximum inputs exceeded: 34 provided, max 25`;
- and fail to send at all once the pieces are that small, because the swap
  branch's inputs are the same proofs.

`tools/live/array-cap.js` shows both against a CDK mint advertising 25. The
obvious fix, refusing an over-cap set in `exactPieces` so `sendToken` falls
through to the swap, only moved the refusal: the swap sends those same proofs as
inputs, and the mint refuses 35 of them just as readily. The real fix is to
consolidate small pieces first, in chunks under the cap, before either path can
run, which is a change to the send path and not worth rushing for a case no mint
Foxy is tested against currently produces. CDK and Nutshell both default to
1000, and every suite except `array-cap.js` runs against that default. What Foxy
does honour today is the **output** side, which is what the cap was advertised
for: the restore walk and the sent-token watch both chunk by it (`mintArrayCap`,
`inChunks`).

### A mint restarted under a melt (`restart-melt.js`)

`faults.js` (b1)/(b2) drop a melt's *answer* with the proxy while the mint stays
up and keeps its quote. Losing the mint itself is different, and CDK
0.17.6/0.17.7 changed exactly the part of it a wallet can see. The script sends a
melt and kills the CDK container under it, through Docker's own socket with
`t=0`, because the `docker` CLI takes longer to start than the mint takes to
answer a melt, so a CLI `docker restart` always landed *after* the payment and
never during one. Over several runs:

| | |
|---|---|
| Foxy's immediate answer | `pay` threw its pending error, **52 sat held**, balance fell by the hold plus the 1-sat split fee, and the melt was never retried |
| the mint, on the way back up | CDK 0.18.1's melt saga recovery decided **two different ways from the same kill**: `melt rollback committed … quote_state_reset_to_unpaid=true proofs_recovered=true`, and on another run `recovery cannot prove payment failure; quote and proofs remain pending payment_status=UNKNOWN` |
| the age gate | with the quote reading UNPAID (or PENDING) and the hold seconds old, `sweepMelts` **left it held**: correct, because the mint never answered this wallet, so UNPAID is not proof the melt never landed |
| past two minutes, rolled-back quote | `sweepMelts` gave the 52 sat back; balance 299, restore 299, and the balance spends |
| past two minutes, quote stuck PENDING | `sweepMelts` **kept holding**, because the mint's own `/v1/checkstate` said it still holds the inputs; the PENDING branch gives ecash back only when every input reads UNSPENT |
| the ledger | in every run the balance equalled what a restore from the words found |

Both mint outcomes are the mint's to choose and the script reports which branch
it took rather than pinning one. The stuck-PENDING branch is the one worth
keeping an eye on: the ecash stays held indefinitely because the mint will not
say either way, which is the safe answer but not a comfortable one, and it is
the state a person would eventually see as money missing from their balance.

### Earlier mint versions

The same suites, run against three pairs of mints with `cdk-cli` built from
CDK's v0.18.0 tag. Counts are for both mints of a pair together.

| Suite | CDK 0.17.5 + Nutshell 0.20.3 | CDK 0.18.0 + Nutshell 0.19.2 | CDK 0.18.0 + Nutshell 0.18.2 |
|---|---|---|---|
| `flows.js` | 18 OK | 18 OK | 18 OK |
| `faults.js` | 112 OK | 112 OK | 112 OK |
| `used-counters.js`, both mints | 6 OK | 6 OK | 6 OK |
| `units.js` (Nutshell with usd) | 12 OK | 12 OK | 12 OK |
| `cdk-cli-reverse.js`: a `cdk-cli` wallet's 24 words restored in Foxy, then spent | 6 OK | 6 OK | 6 OK |
| `cross-wallet-restore.js`: Foxy's own restore, and `cdk-cli` restoring Foxy's words (223 = 223) | all OK | all OK | all OK |
| `cross-wallet-restore.js`: Nutshell's CLI, both directions | all OK | OK at Nutshell, FAIL at CDK | OK at Nutshell, FAIL at CDK |

- **Nutshell 0.19.2's and 0.18.2's CLI at CDK** found 0 sat for Foxy's words,
  where Foxy and `cdk-cli` each found 223, and Foxy found nothing under the CLI's
  own words there. Both CLIs predate Nutshell's HMAC-SHA256 derivation for
  version `01` keysets ("Moving words between wallets", above). At their own
  Nutshell mints, whose keysets are version `00`, both matched Foxy in both
  directions (223, and 255 restored and spent). The 0.18 CLI has no `-y` option;
  `nutshell-cli.sh` leaves it out for that version.
- **The public test mint** (`nofee.testnut.cashu.space`, Nutshell 0.18.2), run
  with `testnut-restore.js`: first-connect seed, a NUT-20 signed invoice claimed
  (100), a 21-sat token sent, and a restore that found 90, the balance of 69 plus
  the token. Its payment to its own invoice stayed `PENDING` with the ecash held.

### Not covered

- **Public mints.** `tools/live/testnut-restore.js` is not part of a routine run,
  and `faults.js onchain` is pointed at the local `cdk-mintd` rather than at
  `testnut.cashu.space`. Everything in the current tables is a local, fake-money
  Docker mint.
- **Nutshell with a small `max_array_length`.** Nutshell 0.21 advertises the
  field but the local image was not given a low cap; only CDK's cap was
  exercised. Foxy reads the number and does not care which mint sent it, but
  that is reasoning, not a result.
- **The Tor path**, which is covered separately on a phone (`DEVICE-TESTS.md`,
  `NETWORK-TEST.md`). These suites reach the mints with `fetch` through a mocked
  bridge.
- **CDK with a non-sat unit.**
