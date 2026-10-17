# The source-interface seam

The wallet answers money questions through one **source** at a time. Today the
only kind is Cashu and the only source is the connected mint, so a source's id
**is** that mint's URL, byte for byte. This document is the seam's ledger: the
contract, the rule for which spelling of "current mint" a read uses, and the
sites that were deliberately left alone.

## The contract

`build/wallet/09-source.js` defines it as a `MoneySource` typedef (twelve verbs:
`info · balance · invoice · watchInvoice · payQuote · pay · sendEcash ·
receiveEcash · onchainAddress · onchainQuote · onchainPay · recover`) and
`cashuSource`, the one adapter. The adapter holds no state: each verb calls the
wallet's own method, resolved at call time, with its words and its error paths;
`sourceId()` reads the live connection. `FoxyWallet.sourceId()` and
`FoxyWallet.source()` live in `10-connection.js`.

Nothing about a stored key, a dedupe key, a record field, a label, `connect`'s
lifecycle, or the persisted mint (`'foxy.cashu.mint'`) changes. `mintUrl` — the
getter — stays.

## The rule

For any read of current-mint state, ask what the value *means*:

- **Identity, scope, key, label** — the value means "the current source":
  spell it `sourceId()` / `W.sourceId()`.
- **Inside a money verb's body** — the read binds the operation to the
  connected mint: unchanged; the verb bodies *are* the adapter's
  implementation.
- **A mint URL as data** — a visit and its restore, a crossing, a carry, a
  token's or payment request's payload, a card, a per-mint cache or health
  record, connect's lifecycle (bind, remember, rollback): keep `mintUrl`.
  Those sites juggle *a specific Cashu mint*, possibly not the current one.

## Moved to `sourceId()` (32 sites)

Wallet (18): `01-storage-and-piles.js:256,357`, `02-dleq-lock-holds-imports.js:81,162,240`,
`03-seed-counters-logs.js:1639,1688`, `07-request-delivery.js:497,533,822,1228,1245`,
`11-routing.js:197`, `12-reading-and-price.js:14,15,42`, `14-moving-between-mints.js:5`,
`20-helpers.js:2296`.

App (14): `06-wallet-boot-and-restore.js:499`, `07-history-tokens-mints.js:1339`,
`09-melt-paste-switch.js:31,372`, `11-mint-risk.js:94`, `12-receive.js:52,127,157,178`,
`16-history-lists.js:282`, `17-split-bill-and-copy.js:382`, `26b-onchain.js:18,19,35`.

Every one of these computed its string from the same `mintUrl` at the same
moment; the substitution reads the same bytes.

## Left alone on purpose

- **`get mintUrl()`** — the getter stays; the flows above use it.
- **All verb bodies** — `invoice`, `watch`, `sweepQuotes`, `sweepMelts`, `pay`,
  the on-chain trio, `sendToken`/`receiveToken`, `scanSeed`: they are the
  implementation the adapter delegates to.
- **`connect()` internals** — canonicalisation, cache path, bind, rollback,
  `remember:false`, the `'foxy.cashu.mint'` write.
- **Visit/restore and crossing clusters** — `26d-tap.js`, `26a-transfer.js`,
  `26f-flashcard.js`, `04-lost-answers.js` carriers, `14-moving`'s move/carry
  verbs: these hold *two* mints at once by design; there is no "current source"
  reading of them.
- **Per-mint records** — `foxy.mint.health`, `foxy.mint.spread`, node probes,
  mint caches: keyed by mint URL as data.
- **`defaultMint`, `saved()`, `mints()`, `mintUsedBefore()`**, and
  `wipeDevice`'s `mintUrl = ''` reset.
- **Cashu-ts's own** `w.mint.mintUrl` (`01-storage:356`, `19-bill-split:854`) —
  that is the library's property, not the closure's.
- `state.mintReturn` is a screen-navigation marker (`'history'`), not a mint
  URL. Never touch it.

## Enforcement

`tests/source-interface.js` (in `tools/check-all.sh`) pins: the seam's presence,
`sourceId()` byte-identity with `mintUrl`, the `cashu` kind, all twelve verbs,
and a verb through the source answering the wallet's own number.
