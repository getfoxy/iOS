# STORAGE.md — every key, what it holds, what survives

The wallet keeps things in four places. Nothing is on a server.

- **The iOS keychain** — the seed, Orbot's access key and the hosts the person
  allowed.
- **WKWebView `localStorage`**, under a `foxy.` prefix — proofs, history and
  everything else below.
- **Files in the app container** — the install marker, Tor's state, and the
  NUT-13 counters (`foxy-counters.json`).
- **`UserDefaults`** — which Tor transport last connected (`foxy.tor.transport`
  and its `.since`), how the seed is kept (`foxy.seed.protection`), two
  one-time flags (`foxy.seedMigrate.closed`, `foxy.counters.imported`), and
  Debug-build test switches. Nothing about money.

The third column is the one that matters: **whether the seed brings it back.**
Twelve words regenerate proofs derived from them; they do not regenerate
anything else.

## The keychain

| item | holds | seed restores it | sensitive |
|---|---|---|---|
| `foxy.seed.v2` | the twelve words once Face ID is on, readable only with Face ID or the device passcode (`.userPresence`) | — it *is* the seed | **the wallet** |
| `foxy.seed.v1` | the twelve words, readable by Foxy without asking: only the phone's own lock guards them. A new install keeps its seed here until Face ID is turned on, and a phone with no passcode keeps it here; turning Face ID on moves it into `foxy.seed.v2` and deletes this item, and turning it off moves it back | — it *is* the seed | **the wallet** |
| `foxy.orbot.token` | the key Orbot issued to Foxy | no | lets an app use Orbot's bypass |
| `foxy.hosts.approved` | the hosts the person allowed Foxy to contact, beyond the default mints (JSON list) | no | which mints and payment domains you use |
| `foxy.hosts.carried` | the hosts a wallet already used, carried over once and each approved exactly (JSON list; an earlier version stored `yes` and put them into `foxy.hosts.approved`) | no | which mints and payment domains you use |
| `foxy.seed.v2.held` | a note that a seed was put in `foxy.seed.v2`, so a phone whose passcode was removed does not make a new one | no | no |

All of them are generic-password items under service `io.getfoxi.foxy`,
accessible `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`: unreadable while the
phone is locked, never moved to another device or to iCloud Keychain. The seed
item behind Face ID also needs the person (`.userPresence`).

## localStorage

**Versions.** `foxy.schema` counts the storage migrations this device has
been through (`SCHEMA_STEPS` at the top of `build/wallet/00-header-and-mint-errors.js`):

1. `flash.*` keys renamed to `foxy.*`.
2. The removed P2PK scheme's `foxy.p2pk.refundn` deleted.

They run in order at launch, before anything else reads storage. The number
moves past a step only once it has finished, and each step is idempotent. A
shipped step is never edited; a change to storage is a new step.

Storage stamped with a higher number than the build knows was written by a
newer Foxy. It is left as it is: no step runs, the wallet's writes are
refused, and no mint is contacted, so an older build installed over a newer
one cannot rewrite it.

Three moves are not steps, because they need more than storage at launch. All
are idempotent. The single proof pile moves under the first mint that
connects. Words an older install kept in localStorage go to the phone once it
answers, and so do its counters (below, "Migration").

| key | holds | seed restores it | sensitive |
|---|---|---|---|
| `foxy.schema` | how many storage versions this device has been through — a number | no | no |
| `foxy.seed.v1` | an older install's twelve words, normally absent — see below | — | **the wallet**, when present |
| `foxy.seed.v1.toPhone` | `{ at, answer }`: what the phone said to those words (`seedMigrate`): `migrated`, `same`, `different`, `invalid` or `closed` | no | no |
| `foxy.cashu.proofs.<mint>` | proofs at that mint — the balance | yes, for proofs derived from the seed, if the mint supports NUT-13 and the app knows the mint | **the money** |
| `foxy.cashu.proofs.<mint>@<unit>` | proofs at that mint in a unit other than sats (usd, eur…), in that unit — usd and eur in cents | yes, for proofs derived from the seed, if the mint lists that unit's keysets | **the money** |
| `foxy.cashu.proofs` | the single pile from before proofs were kept per mint; moved under the first mint that connects | as above | **the money** |
| `foxy.cashu.imported` | secrets of proofs that arrived by import, pruned to proofs still held | no — and without it imported proofs look rebuildable (below) | which proofs are foreign |
| `foxy.counter.v1` | a stale copy: per keyset, the counters an older build kept. The counters are the phone's (`foxy-counters.json`, below); this went to the phone once (`countersImport`) and is never written again | the phone's counters, yes — adopting a restore sets each to at least the last one the mint signed | no |
| `foxy.counter.v1.sentToPhone` | `{ at, sent }`: the text of `foxy.counter.v1` the phone has, so it is not sent again; a copy that changed since is. A stamp that holds only a time, from an older version, is sent once more | no | no |
| `foxy.counter.v1.replaced.<time>` | the counters of a seed an older build replaced by restoring different words, set aside for manual recovery; nothing reads it back, and nothing writes it now (the phone sets counters aside itself) | no | no |
| `foxy.cashu.mint` | the mint currently in use | no — a fresh install uses `mint.minibits.cash/Bitcoin` | which mint you use |
| `foxy.cashu.mints` | every mint this device has connected to | no — and a restore only looks at mints the app knows | which mints you use |
| `foxy.cashu.mints.used` | the same, never pruned: switching back to one does not scan the seed there | no | which mints you use |
| `foxy.cashu.mint.nodes` | each mint's Lightning node key, read from invoices it made, to tell its own invoices | no | which mints you use |
| `foxy.cashu.token.watch` | tokens watched until redeemed: fingerprints (Ys), amount, mint, when the watch began, whether the token was made with no swap, a day's deadline; never the token | no | that you sent a token, and its amount |
| `foxy.cashu.quotes` | invoices issued, not yet claimed (50 at most); the invoice's payment hash (`payHash`), which goes onto the history entry when it is claimed; for a signed quote (NUT-20), the one-time key the mint wants the claim signed with; once a claim has been attempted, the counter ranges it reserved (`outputs`, `outputsMint`) | no | amounts; **a paid, signed quote is claimable only with its key** |
| `foxy.cashu.quotes.old` | unpaid invoices pushed past the 50-invoice list (500 at most); the sweep asks about 25 a pass, least recently checked first, and drops one only on the mint's answer. Carries `outputs` like the list | no | amounts |
| `foxy.cashu.melting` | proofs handed to a melt still routing, the invoice, the counter ranges reserved for its change, the split's input fee (`splitFee`), and the lightning address it was fetched for, if any. Holds written before the ranges were kept have `counters` instead — the snapshot taken just before the melt — from which the melt's one change range is worked out | no — the mint settles it on the next connect or resume | **money in flight**; the address says who you paid |
| `foxy.cashu.swaps` | swaps whose answer has not arrived: per swap its kind (`receive`, `reclaim`, `import`, `send`, `split`), mint, unit, time, the incoming amount, `freeInputs` when the piece was checked unspent as the Tor window closed and left in the pile, the counter ranges its outputs were reserved at (50 at most), and what those outputs must add up to before any is added — for a receive, reclaim or import the amount less its input fee (`expect`); for a send or split the pile proofs it was handed (`inputs`: secret, amount, keyset id, no signature), which the mint is asked about. Written as the counters are reserved, before the request; cleared on the answer, on a refusal, or once `recoverSwaps` has restored ranges that match; kept, with a log line, when they do not | the proofs, yes — this is what lets them come back without one | no signatures, so nothing spendable; for a send or split the input secrets, which name those proofs to the mint as the pile already does; amounts and which mint |
| `foxy.cashu.quarantine` | proofs the mint called spent that cannot be re-derived; entries in another unit carry `unit` and go back to that unit's pile | no — they are here *because* they cannot be | **possibly money** |
| `foxy.cashu.outtoken` | the last token made, not yet handed over; `swapped` if it took a swap to make, `reminded` once the launch note about it was shown | no | **bearer money** |
| `foxy.cashu.move` | a transfer between mints, mid-flight, with the destination quote's NUT-20 key if it has one, and the counter ranges a claim of it reserved (`outputs`, `outputsMint`) until that claim is saved | no | amounts; **money until claimed** |
| `foxy.cashu.onchain` | addresses the mint made for this wallet to be paid into, each with the quote's NUT-20 key the claim must be signed with, what the mint has already issued against it, and the counter ranges a claim reserved (`outputs`, `outputsMint`). Kept while inside the watch window (seven days), trimmed by age and never by position — the key goes with the record, and a payment to an address whose record is gone is claimable only by a seed restore | no | amounts, addresses; **money until claimed** |
| `foxy.cashu.onchain.out` | a payout on chain, mid-flight: the quote, the address, the amount, the split's input fee, and the proofs handed to the melt until the mint says what became of them. Written before the melt and cleared only on PAID; records still holding proofs are never trimmed | no | amounts, addresses; **money until settled** |
| `foxy.cashu.reserves` | what each mint held back as a routing reserve the last time it was asked, so a send can be sized before asking again | no | which mints you use |
| `foxy.cashu.carry` | payments taken at a payer's mint, to be brought home (20 jobs at most): per job its id, the home mint, the mint it was taken at, the amount, its state (`asked`, `arrived`, `paid`, `moving`, `refunding`), the request, the key the payer sent for anything going back, and the quote of the walk home. No proofs: the money is in the pile at the other mint and the job says where it is going. Written before the visit and cleared when the money is home or sent back | no — the money is at a mint the person did not choose until the job finishes | amounts and mints; **money in flight** |
| `foxy.cashu.atrisk` | ecash the payer made for a payment the receiver refused, with nothing sent back, which went into the payer's pile again flagged because another phone has seen it: per payment its pieces' secrets, amount, when, request, mint and the reason. The flag is written first and must land; the pieces themselves are in `foxy.cashu.proofs.<mint>` until they are swapped or the refund comes (`MONEY.md` §15) | the proofs, yes; the flag, no | amounts, mints; **money another phone has seen** |
| `foxy.change.seen` | fingerprints of the pieces of change that came back over the tap link, the last 100, so a later scan of that same change is known for a duplicate by its pieces (`changeSeenNote`, `dropScannedTwice`) | no | no |
| `foxy.intro.seen` | the day the fox's film was played: it plays on the first launch after install and no other. `foxy.intro.day`, from when it played once a day, counts as having seen it | no | no |
| `foxy.cashu.taken` | a fingerprint, the amount and the time of each token this phone has swapped in, so that the same ecash offered to it again is said to be already here (`noteTaken`, `mineIfTaken`). No secret is in it. Two hundred entries, thirty days | | |
| `foxy.cashu.held` | per swap id, `{mint, unit, proofs}`: the inputs of a swap whose answer never came, taken out of the pile until the mint says whether the swap was made; put back if it was not | no | **bearer money until settled** |
| `foxy.cashu.topupfees` | per mint, the input fees (sats) that change-pool top-up swaps cost when no history row could carry them, so the books still add up | no | which mints you use |
| `foxy.cashu.mint.cache` | per mint (5 at most), its info and keysets as last fetched, with the time, so a phone with no route can rebuild a wallet without a request | no | which mints you use |
| `foxy.price.last` | `{rate, at}`: the last bitcoin price the phone was told and when, so a relaunch with no route still has one; always shown with its age and never treated as current | no | no |
| `foxy.req.unclaimed` | **ecash that has arrived and is not swapped in yet**, per payment request: the token, its amount, and when it landed. A payment locked to this phone is written here before anything is attempted with it, and cleared only once it is really in the wallet. Everything after that write can fail and the money is still findable; before it, nothing could — a payment went missing that way once, while a delayed redeem sat in a `setTimeout`. The redeem now runs the moment the payment lands, so what is usually here is a swap that failed and is waiting for the next connect. `balanceSats` counts what is here, because it is money: locked to a key only this phone holds | no — these are bearer proofs, and the lock key below is what opens them | **bearer money** |
| `foxy.req.lockkeys` | per payment request, `{i, pub}`: the index the phone derived its P2PK lock key at (NUT-13's path, `SEED-HANDLING.md`) and the public key that went into the request. **No private key** — that comes from the phone (`p2pkKey`) when there is ecash to open, and the public key is compared with the row's before it is used. Rows from an earlier version are `{key, at}`, a random private key, and go on working for ever: a random key has no index to convert it to, so there is no migration step and there cannot be one. The lock is found by the lock itself as well as by request id, and when no row names it the phone walks the path — which is how a payment that arrived can be claimed on another device from the twelve words alone | no | the index and public half only; the money is opened by the seed |
| `foxy.req.lockpool` | lock keys the phone derived ahead of time, `[{i, pub}]`, because `paymentRequest` is synchronous and cannot wait for it. A request takes one off the front; an empty pool means the request goes out **unlocked**, never with a random key | no | no |
| `foxy.req.open` | the payment requests open on this phone, per request id `{sats, mint, at, purpose}`, kept an hour so a reload does not make the phone forget a request it issued while the key that opens its ecash is stored | no | which mint you receive at |
| `foxy.req.handedon` | the secrets of proofs this phone has handed on from an unclaimed payment (200 at most), so one payment is never handed to two people; a write that fails is an error, not ignored | no | no |
| `foxy.tap.auto` | `on` or `off`: AUTO TAP TO PAY, whether an invoice screen arms itself for tap to pay. Absent means on | no | no |
| `foxy.tap.paid` | the offers this phone has paid by tap in the last day (30 at most), so an offer paid is not paid again by a second tap | no | that you paid, and which offer |
| `foxy.rail.default` | which network a receive screen opens on — LIGHTNING unless the person has picked otherwise | no | no |
| `foxy.secure.choice` | how the wallet is protected, written beside the phone's own answer (`chooseProtection`); the phone's answer is the one that decides | no | no |
| `foxy.secure.asked` | when the SECURE FOXY card was shown (once, after money first arrived) | no | no |
| `foxy.split.pending` | a bill being collected from several people | no | amounts, names |
| `foxy.cashu.log` | transaction history (500 entries at most). A Lightning send carries the preimage the mint gave (`preimage`), where it gave one; a Lightning receive carries its invoice's payment hash (`payHash`) | no | full activity |
| `foxy.cashu.audit` | what payments consumed and produced, newest first, 500 at most. **The last 100 in full** (and never more than a megabyte in full): amount, secret, signature, keyset. **The 400 before them as receipts**: when, where, how much, the payment's id, the counts, and the public value of each piece that left (`ys`), with no secret in them. Every send keeps those public values from the start. A sent token's proofs are dropped once it is claimed, except a token locked to one key (`lockedTo`): its pieces stay, and once the mint says they are spent the signature they were spent with is kept beside them (`spent`), until the person deletes that receipt on the payment's screen. All of it goes with the history | no | **live change, and an unclaimed sent token's proofs**; who was paid, for a locked payment's receipt |
| `foxy.txmeta` | notes on payments, and each ecash send's token (300 entries at most). Once the mint reports it claimed the text moves from `token` to `kept` (and a receiver's change for a payer to `changeToken`), so SHOW QR and SHARE TOKEN still work; kept copies are trimmed oldest first past 1.5 MB, an unclaimed `token` never. The notes go with the history | no | whatever they wrote; **bearer money** until redeemed |
| `foxy.contacts` | saved names and Lightning addresses (50 at most) | no | who you pay |
| `foxy.myaddr` | the user's own Lightning address, if set | no | identity |
| `foxy.backed.up` | the seed has been written down and verified | no | no |
| `foxy.pin.v1` | the PIN's salt, round count (120,000) and iterated SHA-256 hash — never the PIN | no | guessable offline; see `THREAT-MODEL.md` §7 |
| `foxy.pin.tries` | wrong PINs since the last right one, and when the last miss was | no | no |
| `foxy.pin.bio` | written by older versions only: whether a face might stand in for the PIN. Read by nothing now (the menu's USE FACE ID decides), and removed the next time a PIN is set or removed | no | no |
| `foxy.custody.told` | mints whose "the mint holds your bitcoin" card has been shown | no | which mints you use |
| `foxy.mint.health` | per mint: when it last answered, and consecutive failures with the first and latest time. A failure counts only while Tor is up and something else answered over it in the last three minutes | no | which mints you use, and when |
| `foxy.nopasscode.off` | THIS IPHONE HAS NO PASSCODE turned off with DON'T SHOW AGAIN | no | no |
| `foxy.backup.asked` | when BACK UP YOUR BITCOIN was last raised, so it is raised once in a day | no | no |
| `foxy.flashcard.owed` | ecash made for a card and not yet written onto it, as tokens locked to that card's key (a top-up cut short, change owed to a card that has been let go, the pieces of a payment the mint refused, money moved for a card). Only the card can spend them, and this is the only copy until a tap writes them | no | **yes**: the tokens; which card and mint |
| `foxy.flashcard.taken` | pieces a card has signed for that the mint has not swapped yet, as tokens. The card marks them spent and will not sign again, so this is the only copy of the right to spend them until the swap lands | no | **yes**: the tokens |
| `foxy.flashcard.cards` | the cards this phone loaded as recoverable: each card's key, and for each piece its amount, its date and whether it was still there at the last read. Read to list them and to take a lost card's money back after its date. Not written for a cash card | no | which cards you loaded, and how much |
| `foxy.flashcard.checked` | per card (twenty at most): when the mint last said every piece on it was good, and which pieces that was about. Only read to say "verified 2 hours ago" on a phone with no connection | no | which cards this phone has read |
| `foxy.flashcard.logseen` | per card this phone owns: the four counts it last read from the card's own log (taps, sats signed for, refusals, marked runs), and when. Only read to say what the log has gained since this phone last looked | no | which cards this phone has read, and how much each had signed for by then |
| `foxy.mint.spread` | when A LOT AT ONE MINT was last shown, and whether it was turned off | no | no |

*Removed:* `foxyTheme` (light or dark) was listed here. Nothing in the current
code reads or writes it; the theme is held in the app's state. `foxy.mint.motd`
held, per mint, the last NUT-06 message of the day shown; Foxy no longer reads
a mint's `motd` or draws it, so nothing writes the key now. An older install
may still hold it, and nothing reads it.

**`foxy.seed.v1` in localStorage.** The seed is the phone's, and the page
never writes words anywhere. A copy here exists only on an install from before
the keychain, or one whose keychain once refused a new seed. At
boot it goes to the phone once (`seedMigrate`), and is removed when the phone
says it has those words (written, or the same seed already saved). When the
phone holds a different seed, says the words are not a seed ("bad request"), or
no longer takes words from the page ("no migration here"), the copy is left
exactly as it is for a person to decide about, and the phone's seed is the
wallet's. On any other error it is kept and sent again at the next launch.

With no native side (a desktop browser) there is no seed at all, and the wallet
refuses to connect.

**`foxy.cashu.imported` matters more than it looks.** Reconcile and restore
decide from it whether a proof can be rebuilt from the seed. A proof not on
the list is treated as rebuildable: when the mint calls it spent, reconcile
deletes it rather than quarantining it, and an overwriting restore may drop it.
If the list is lost, imported proofs lose that protection.

**The counters, if lost without a restore.** They are the
phone's `foxy-counters.json` (below). A file that cannot be read hands nothing
out. A file that is gone makes the next mint, swap or receive reuse counters
the mint has already seen. The mint refuses — in
Nutshell's words or CDK's (MONEY.md §1) — and Foxy moves the counter of the
keyset the outputs are made on by 10, 50, then 100, trying again after each.
One session moves a keyset's counter 160 at most (`SKIP_BUDGET`), so a long
history can take several sessions to get past. A restore of typed words walks
from zero. A restore of this wallet's own seed is served only up to 1,000 past the
phone's counter, and each adoption moves that counter on, so on a lost file a
long history takes more than one scan (`SEED-HANDLING.md`, "The counters").

**A write that fails** (storage full). Writes of the proofs,
a held melt and the quarantine throw instead of being ignored; history and notes
still ignore a failure. A counter the phone could not reserve stops its request
before it goes out, so no counter is handed out twice. A pile
that could not be written after the mint answered keeps the record that brings
it back (`foxy.cashu.swaps`, `foxy.cashu.melting`, an invoice's `outputs`), and
the next connect or resume files the proofs once a write lands. `MONEY.md`,
"Storage the money paths touch", has the details.

## Files and settings outside the web store

| what | where | in backups | at rest |
|---|---|---|---|
| the install marker | `Application Support/foxy.install` | **included**, on purpose | `completeFileProtection` |
| Tor's state | `Application Support/tor` | excluded | directory mode 0700 |
| the NUT-13 counters: per keyset the next counter, `{keysetId: next}`, one entry per derivation path (a `00` keyset's under the first id stored for its index), 256 keysets at most | `Application Support/foxy-counters.json` | excluded, set again after every write | `completeUntilFirstUserAuthentication` |
| the counters of a seed replaced or wiped, kept for manual recovery; nothing reads them | `Application Support/foxy-counters.replaced.<unix time>.json` | excluded | as above |
| the next index a payment request's lock key is derived at (NUT-13's P2PK path, `{"next": n}`) | `Application Support/foxy-p2pk.json` | excluded, set again after every write | `completeUntilFirstUserAuthentication` |
| the same, for a seed replaced or wiped; nothing reads it | `Application Support/foxy-p2pk.replaced.<unix time>.json` | excluded | as above |
| the staged page and scripts | `Library/Caches/web/` | — | code only, no wallet data |
| the last run's diary: the lines a bug report rests on, redacted, saved as it goes and read back and deleted at the next launch (`FieldLog`) | `Library/Caches/foxy-lastrun.log` | excluded | `completeUnlessOpen` |
| last Tor transport that worked, and how long a bridge is remembered (`foxy.tor.transport`, `.since`) | `UserDefaults` | — | — |
| how the seed is kept, `device` or `none` (`foxy.seed.protection`, `SEED-HANDLING.md`); absent means `device` | `UserDefaults` | — | — |
| whether `seedMigrate` may still write words from the page (`foxy.seedMigrate.closed`, `SeedMigrationWindow`); closed, it still compares them with a saved seed | `UserDefaults` | — | — |
| whether the page's counters were imported (`foxy.counters.imported`): `countersImport` answers once per install | `UserDefaults` | — | — |

**`foxy-counters.json`** (`Foxy/Keychain/CounterStore.swift`; the only
counters). This file decides which counters are handed
out: the page's `foxy.counter.v1` comes across once (`countersImport`), each
keyset at the larger of the two, cut to the keyset version's last counter,
except where the phone had no seed and made a new one at that boot: counters
with no seed belonged to a seed that is gone. The phone answers `countersImport`
once per install and records it in UserDefaults, `foxy.counters.imported`; a
second import is "counters were already imported". An install that has never had the file, new or from before it existed, starts
with no counters; reading writes nothing, and the first write makes the folder
and the file.

It is keyed by keyset id, with one entry per derivation path: NUT-13 derives a `00` keyset from `id mod (2^31 − 1)`, so an entry for a
`00` keyset is keyed by the first id stored for that index, and every other id
with the same index reads and moves that entry. A `01` keyset is keyed by its
id. A file written before, with two ids of one index, is merged at the larger
value when it is read, and written back merged with the next change. At most
256 keysets are kept ("too many keysets"). Every change is written whole to a
temporary file in the same folder, flushed to the disk with `F_FULLFSYNC`, and
renamed over the file before a range is handed out, so a power loss leaves the
old file or the new one and never an older one. A counter is never
lowered, and moves up only a little at a time (`SEED-HANDLING.md`, the bridge's
seed actions). A file that cannot be read stops every reservation rather than
starting again from zero. It is not secret, and the seed restores it as it
restores `foxy.counter.v1`. The counters belong to the seed in use: when that
seed is replaced, deleted or wiped, the file is renamed to
`foxy-counters.replaced.<unix time>.json` and the next reservation starts from
an empty file. A new seed made where counters exist with no seed also sets them
aside.

**`foxy-p2pk.json`**. `{"next": n}`: the next
index a payment request's lock key is derived at, on NUT-13's P2PK path
(`Foxy/Keychain/P2PK.swift`, `SEED-HANDLING.md`). Written the same way — whole,
flushed, renamed, before the keys it records are answered — and set aside under
the same stamp as the counters when the seed changes, because under a new seed
every index gives a different key.

It is a **file of its own and not an entry in `foxy-counters.json`**, and that
is deliberate: `CounterStore.parse` refuses the whole counter file when a key is
not a keyset id, because dropping an entry it did not understand would take that
keyset's counter back to zero. An older Foxy installed over this one would find
a `"p2pk"` key there, refuse the file, and hand out no counter at all — a wallet
that cannot make an output. A file it has never heard of it simply does not
open. A file that is there and cannot be read stops every lock key rather than
starting again from zero, for the same reason the counters do: a request whose
lock this phone cannot open destroys whatever is paid to it. Keys this build
does not know are left alone rather than refused — `next` is the only value that
must not go backwards, and it is the one that is read.

## How it is protected

The review found that nothing excluded the web store from backups and that no
file protection was set anywhere in the project. A copy of the seed left the
phone on every backup.

Both are now set explicitly on every launch, on `Library/WebKit` and
everything under it, before the web view is built (`protectWebStore()` in
`FoxyWebView.swift`):

- **excluded from iCloud and iTunes backups** (`isExcludedFromBackup`)
- **file protection `completeUnlessOpen`** — unreadable while the device is
  locked, except across a lock that happens with the file already open

Confirmed on device by the log line at launch:

    [foxy] web store excluded from backups, protection completeUnlessOpen

The page's old `seedRead` and `seedWrite`, which the rules below once
described, no longer exist; native reads and writes the seed itself
(`SEED-HANDLING.md`), and the page asks only `seedStatus` and `seedCreate` at
boot. The rules still hold of native.

The seed is in the keychain, and the rules for reading and writing it are:

- **A failed read is not "no seed".** The keychain answers found, absent, or
  failed. A failed read is asked again after one second and after three. If
  it still fails, nothing is generated and connecting to a mint refuses, with a
  message naming the keychain.
- **A saved seed is never replaced unasked.** `seedCreate` and `seedMigrate`
  never replace a saved seed; only adopting typed words does, after a yes to
  "Replace this wallet's seed?". Nothing is written when the keychain cannot be read, and every
  write is read back.
- **The seed exists before the first proof.** It is made on the phone
  (`seedCreate`) once the keychain has answered that it holds none, at first
  launch, and at the latest when the wallet first connects to a mint. A wallet is
  never built with random secrets.

**Still true, and the reason a PIN is in scope:** the proofs are in the web
store, not the keychain. They do not leave the phone and are unreadable while
it is locked, but anyone with the unlocked device and forensic tooling can read
them. The PIN gates the app; it encrypts nothing.

## Backups, reinstall and restore

Keychain items outlive app deletion. At launch, before the page is loaded,
`forgetSeedIfReinstalled()` looks for the install marker. With no marker, both
seed items (`foxy.seed.v2`, behind Face ID, and the older `foxy.seed.v1`) with
the note `foxy.seed.v2.held`, the approved hosts (`foxy.hosts.approved`, `foxy.hosts.carried`) and the Orbot key
(`foxy.orbot.token`) are deleted, and the marker is written. Deleting reads
nothing, so it asks for no Face ID.

- **A reinstall** removes the marker with the app, so the old seed is removed.
  Restore with the old words brings the balance back.
- **A backup restored to the same phone** brings back the marker and the seed,
  so the seed is kept. The proofs are not in the backup; restore with the words
  finds them.
- **A backup restored to a different phone** brings the marker but not the
  seed.
- **The counter file** goes with the app on a reinstall and is not in backups, so
  a restore of the words, not the file, brings the counters back.

The marker is included in backups on purpose. When it was excluded, a
same-phone restore looked like a reinstall: the seed came back, the marker did
not, and the seed was deleted with the proofs already gone. An existing marker
is moved back into backups on launch.

**Not yet tested on a real phone.** `DEVICE-TESTS.md` §7.

## Migration

Keys were `flash.*` in early versions. `SCHEMA_STEPS` step 1 (above) moves any
`flash.*` key to `foxy.*` before anything reads storage, once, and is
idempotent.

**Onto the phone** (`nativeReady` in
`build/wallet/03-seed-counters-logs.js`). Once per page load, at boot (after
the PIN, before any mint work) and before any connect, restore or reservation,
in this order:

1. Words in `foxy.seed.v1` go to the phone with `seedMigrate`, first, so a phone
   with no seed takes them rather than making a new one. The answers are above
   ("`foxy.seed.v1` in localStorage"); `foxy.seed.v1.toPhone` records a final
   one. A fresh install, with nothing here, never asks.
2. `seedStatus`, and `seedCreate` only when the phone has no seed. If words here
   did not reach the phone because of an error and it has no seed, nothing is
   made and connect refuses until they do.
3. `foxy.counter.v1` goes to the phone with `countersImport`, once per text of
   it (`foxy.counter.v1.sentToPhone`), and is never written again. The phone
   takes one import per install (`foxy.counters.imported`) and answers any later
   one "counters were already imported".

**The keychain and the counter file across the move.** The keychain items
(`foxy.seed.v1`, `foxy.seed.v2`, `foxy.seed.v2.held`) are read as they are;
nothing native is converted. `foxy-counters.json` starts empty and takes the
page's counters in step 3. `seedMigrate` answers only in its one-time window, on
an install that had page storage before this launch (`SeedMigrationWindow`).
`DEVICE-TESTS.md` §15 checks a funded wallet across the move.

## What a wipe removes

`wipeDevice()` asks the phone first (`seedWipe`): after iOS's Delete alert it
deletes the seed, sets `foxy-counters.json` aside, drops any typed words held
natively and makes a new seed on the phone. Only then does the page delete every
`foxy.*` key in localStorage: proofs at every mint, the stale counters, quotes,
held melts, quarantine, the out-token, history, audit trail, notes, contacts,
the mint list, the PIN and its count, the backed-up flag, any older install's
words and the migration stamps. A No in the alert erases nothing. The app then
connects to the default mint. There is no undo. If the old words
were not written down, the money is gone.

A wipe leaves `foxy.orbot.token` in the keychain, the install marker and Tor's
state.
