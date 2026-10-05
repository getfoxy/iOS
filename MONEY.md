# MONEY.md — every path where value moves

For the security review. Each section is one operation: what it does, what is
written to storage and when, and what happens if the app is killed at each
step. Written from `Web/foxy-wallet.js` (kept in parts in `build/wallet/`), by
function name. Where an earlier version of this file described a design that
has since changed, the old description is kept and labelled, with what replaced
it.

The one fact to hold throughout: **the proofs in localStorage are the money.**
There is no server-side balance. The mint records which secrets have been
spent; the wallet holds the secrets. Losing the local copy of an unspent proof
loses the money unless the seed can regenerate it (see §6). The seed itself
and the counters are the phone's, kept by the native side (the keychain and
`foxy-counters.json`), never in localStorage (`STORAGE.md`, `SEED-HANDLING.md`).

---

## Storage the money paths touch

| key | holds |
|---|---|
| `foxy.cashu.proofs.<mint>` | the proofs — the balance at that mint |
| `foxy.cashu.proofs.<mint>@<unit>` | the balance at that mint in another unit (usd, eur), never counted as sats |
| `foxy.counter.v1` | a stale copy: per keyset, the counters an older build kept here. The counters are the phone's (`foxy-counters.json`, `STORAGE.md`). This is sent to the phone once at boot (`countersImport`, the higher per keyset) and never written again, so an older build installed over this one finds counters behind the phone's, never zero; nothing else reads it |
| `foxy.seed.v1` | an older install's words, normally absent: sent to the phone once at boot (`seedMigrate`) and removed once it has them; left untouched when the phone holds a different seed or no longer takes words (`STORAGE.md`) |
| `foxy.cashu.imported` | secrets of proofs that arrived by import, so nothing treats them as rebuildable |
| `foxy.cashu.quotes` | invoices issued, not yet claimed |
| `foxy.cashu.melting` | proofs handed to a melt whose outcome is not yet known |
| `foxy.cashu.swaps` | output counter ranges of swaps whose answer has not arrived |
| `foxy.cashu.quarantine` | proofs the mint called spent that the seed cannot rebuild |
| `foxy.cashu.outtoken` | the last token made, not yet marked handed over |
| `foxy.cashu.move` | a transfer between mints, mid-flight |
| `foxy.cashu.onchain` | addresses this wallet asked the mint for, and what it has already claimed against each |
| `foxy.cashu.onchain.out` | an on-chain payout mid-flight, holding the proofs handed to it until the mint says what became of them |
| `foxy.cashu.held` | the inputs of a swap whose answer never came, out of the pile until the mint says whether it was made (`holdInputs`, `releaseHeld`) |
| `foxy.cashu.carry` | a payment taken at the payer's mint, to be brought home: its job, from the visit to the walk home or the refund (§14) |
| `foxy.cashu.atrisk` | ecash a receiver refused that is in the pile again, flagged (§15) |
| `foxy.cashu.topupfees` | per mint, the input fees of top-up swaps that no history row carries (§13) |
| `foxy.cashu.mint.cache` | each mint's keysets and info, so a phone with no route can still hold a wallet |
| `foxy.req.unclaimed` | ecash that arrived for a payment request and is not swapped in yet: bearer money, written before anything is attempted with it (§11) |
| `foxy.req.lockkeys` | the P2PK key this phone put in each request — what opens the ecash above |
| `foxy.split.pending` | a bill being collected from several people |
| `foxy.cashu.log` | local history; the mint keeps none |
| `foxy.cashu.audit` | what the last 30 payments consumed and produced |
| `foxy.txmeta` | notes on payments — and, for an ecash send, the token itself |

Every write is `localStorage.setItem`, synchronous from the page's side.
"Written" below means the call has returned. This document treats that as
durable; when WebKit actually puts the value on disk happens outside the page
and has not been measured.

**A write that does not land is an error.** With
WebKit's store full, `setItem` throws, and that used to be swallowed: a swap the
mint had made wrote its outputs nowhere, and a counter that did not advance was
handed out again. Proofs (`setProofs`), a melt's hold (`holdMelt`), a
restore's piles and reconcile's quarantine now throw (`mustSave`, with
`storageFull` on the error). Counters are the phone's: a reservation it refuses
(its counter file could not be written, the seed could not be read) stops its
request before it is sent (`unsent`), as a counter that could not be stored did
when the page kept them. A pile that cannot be written
after the mint answered leaves the record that brings its proofs back — the
swap's in `foxy.cashu.swaps`, the held melt, the invoice's `outputs` — because
each is now cleared only after the pile is written, and the next connect or
resume acts on it once a write lands. History, notes and the audit trail still
ignore a failed write. So do the records themselves where cashu-ts reports the
reservation (a swap record, a hold's or an invoice's output ranges): they are
written from its event and cannot stop the request, and an answer lost while
one of them failed to land is left to a seed restore, as before.

**Every read-then-write of the proofs runs one at a time.** Eighteen functions —
`claimQuote`, `claim`, `pay`, `reconcile`, `reclaimToken`, `receiveToken`,
`sendToken`, `importProofs`, `adoptScan`, `_sweepMeltsOnce` (the walk inside
`sweepMelts`), `recoverIssued`, `_recoverSwapsOnce` (the walk inside
`recoverSwaps`), `_settleAtRiskOnce`, `unquarantine`, `tidyChange`,
`onchainPay`, `onchainClaim`, `onchainFollow` — are wrapped in one promise
chain (`withProofs`). A call that arrives while another is running
waits for it, then reads the list it wrote. §5 has why. `sweepMelts` is in it
because it gave proofs back outside the chain, so it could do so while a
payment was spending the same pile. `recoverIssued` and `recoverSwaps` are in it
for the same reason (below). So are the three on-chain paths: they read
the pile, wait on the mint for as long as a chain transaction takes, then write
it back, and outside the chain a payout's split could save its older copy over
ecash that had arrived meanwhile (`tests/onchain-faults.js`). `adoptScan`
resolves once it has written; the app's three restore screens wait for it
before reading the balance or connecting.

**An answer the mint gave and the wallet never heard.** A claim
and every swap record, as cashu-ts reserves them, the counter ranges of their
outputs (`watchReserved`): a claim on its invoice record (`outputs`), a swap in
`foxy.cashu.swaps`. A mint refusal (a 4xx, a coded error, used outputs, invalid
signatures) takes that attempt's ranges off, since a used-counter refusal names
counters another operation owns. With no answer, those ranges and no others are
restored (NUT-09); only proofs the mint calls `UNSPENT` and nothing here holds
are added, so a recovery run twice adds nothing. A claim's are added only from
a range whose proofs add up to the invoice amount. A swap's are added only when
they add up to what that swap would have made: a
receive, reclaim or import records `expect`, the incoming proofs less the
mint's input fee on them; a send or split records the pile proofs it was
handed (`inputs`: secret, amount, keyset — no signature), and at recovery the
ones the mint calls `SPENT` less their fee are the expectation. All the unspent
proofs must match it exactly, or exactly one recorded range must; otherwise
nothing is added, the record stays and the log says why. Before, there was no
amount check, and a record that also pointed at another operation's range —
two answers lost in a row, a refusal not recognised as one — added whatever
unspent proofs sat there, such as a token already handed over. A record with no
expectation (written before these were kept) adds nothing. Recovered proofs are
filed with `addProofs`, never marked imported: they come from this seed.
Found by `tools/live/faults.js`
(a) and (a2) at CDK and Nutshell: a claim whose answer was dropped left the
quote `ISSUED` and the next sweep dropped it as claimed; a swap whose answer
was dropped left its inputs spent and its outputs nowhere. Both were reachable
only by a full seed restore that nothing prompted.

**Each reads and writes its own mint's pile.** Proofs are stored per mint
(`foxy.cashu.proofs.<mint>`). Every function above names the pile of the mint
its own wallet object talks to, taken when it starts. They used to
write to whichever mint was connected at the moment of writing, so switching
mints while a claim or payment waited on the mint filed one mint's proofs under
another's key, or replaced that pile.

**Every mint request goes through the native side**, which sends it over
Foxy's embedded Tor or refuses it, unless the person chose to continue
unprotected for this session (`THREAT-MODEL.md` §4). The money paths below
call `assertRoute()` or `need()` first, so they refuse before building a
request when the route is closed.

**Every proof the mint issues is checked for a DLEQ (NUT-12)** as it is
stored. One that fails is kept and reported, not discarded: the mint may still
honour it. A token received from someone else is checked before the swap and
refused if a DLEQ it carries fails. A proof with no DLEQ is accepted.

---

## 1. Receive over Lightning — `invoice()` → `watch()` → `claim()`

1. Ask the mint for a mint quote — the mint's record of "this invoice, once
   paid, may be turned into this much ecash". When the mint offers NUT-20 the
   quote is signed: Foxy makes a fresh random key for it, and the mint will
   release the ecash only to a request signed with that key. **Write** the quote
   to `foxy.cashu.quotes`, with its key in the same write, stamped with the mint
   that issued it. The list keeps 50; older ones move to
   `foxy.cashu.quotes.old` (500), which the sweep still checks.
2. Show the invoice. Poll the quote (no WebSocket: a socket from the page
   cannot be routed through Tor).
3. When paid, ask the mint to issue proofs, signed with the quote's key if it
   has one. The counters for the outputs are
   reserved on the phone (`counterReserve`, which writes its counter file and
   answers the range's secrets in the same reply) before the request goes out.
   On success **write** the proofs to `foxy.cashu.proofs.<mint>`, remove the
   quote, log the receipt.

**If killed after 1:** the quote is on disk. `sweepQuotes()` runs on connect
and on resume, asks the mint about each quote it issued, and claims anything
paid. Nothing lost.

**If killed during 3, or the answer is lost, after the mint issued proofs but
before the write:** the mint has marked the quote issued; the proofs exist only
in the dead process or the dropped response. As cashu-ts reserves the claim's
counters, their ranges are **written** to the invoice's record (`outputs`),
before the request goes out. A successful claim removes the record in the same
tick it saves the proofs. So a record the mint reports `ISSUED` is a claim whose
answer never arrived: `recoverIssued()` — from the sweep, or the invoice
screen's watch — asks the mint the quote's state, restores exactly those ranges,
keeps the range whose signed proofs add up to the invoice amount, adds what the
mint calls `UNSPENT` and nothing here holds to that mint's pile, logs the
receipt, and drops the record, in one tick. An attempt the mint refused (used
counters) is taken off the record as it fails. A record with no ranges — from
before they were kept — is dropped as it always was, with a console note; a seed
restore finds its proofs. A mint switch's claim (`claimQuote`) writes its ranges
to `foxy.cashu.move`, and `finishMove()` recovers a destination quote found
`ISSUED` the same way.

*Superseded:* "A quote the mint reports `ISSUED` is dropped", and "a seed restore
regenerates them; the restore is not automatic". Seen with
`tools/live/faults.js` (a2) at CDK and Nutshell: the answer to a
claim dropped after the mint issued, the watch stopped on `ISSUED`, the sweep
dropped the invoice, and the 50 sats came back only from a restore of the words.

**Used counters.** If the mint refuses because it has already seen outputs at
those counters, the counters move on by 10 and the request is made again; then
by 50, then by 100, before giving up — 160 at most, inside the 1,000 empty
counters a restore walks past. Mints say it differently, and all of these count
(`onceMoreIfSigned`, `alreadySigned`):
- Nutshell before 0.19: 10002, "outputs have already been signed before"
- Nutshell now: 11003 "outputs already signed", 11004 "outputs are pending"
- CDK: 11008 "Duplicate outputs" on a swap — its database refuses a blinded
  message it already holds
- CDK on a claim: 20006 "Invoice already paid or pending" — counted only while
  the mint still reports the quote PAID, and never on a melt, where the same
  words can mean the invoice really was paid.

Only the first wording was once known. At a CDK mint (Minibits
moved to CDK) a wallet whose counters were behind failed every swap with
"duplicate outputs", and a paid invoice never claimed: the sweep's claim failed
with 20006 and the error was swallowed. The sweep now logs why a claim failed.
The mint refused the whole request each time, so nothing changed there.

Checked against local mints — CDK 0.17.5 and Nutshell 0.20.3, the images
cashu-ts's own tests pinned then (the suites now default to CDK 0.18.1 and
Nutshell 0.21.0) — with `tools/live/used-counters.js`, which moves
a wallet's counters back behind outputs the mint has signed before a swap, a
receive and a signed claim. CDK answered 11008 "Duplicate outputs" on both swaps
and 20006 "Invoice already paid or pending" on the claim; Nutshell answered
11003 "outputs already signed" on all three. Each got through after Foxy moved
the counters on, and a restore from the words found exactly the balance plus the
unclaimed tokens. The wallet from before the fix failed all three at
CDK with the same errors the phone showed.

**Paid, not collected, is said.** When the claim for a paid invoice fails —
from the invoice screen's watch or the background sweep — the reason, the
number of tries and since when are written on the invoice's record
(`unclaimed`), the app shows PAID, NOT COLLECTED YET with the amount, mint and
reason, once a session per invoice, and `stuckInvoices()` lists them. A check
that could not reach the mint about an unpaid invoice is not counted.

**A claim the mint keeps refusing is left alone.** Once a
mint has refused an invoice's claim three times (`unclaimed.refused`), the
background sweep (`sweepQuotes`) stops asking. Each claim reserves new counters
and a refusal signs none, so asking on every connect and return opened a gap
wider than a restore looks across. The app's card offers one more try
(`retryRefusedClaim`), which starts the count over.

**Invalid signatures are not retried.** A mint response whose DLEQ fails is
refused by cashu-ts before anything is stored. Foxy reports it once per mint and
operation (THIS MINT SENT INVALID SIGNATURES, no retry button); an invoice whose
claim met it is marked and never asked for again — not by the watch, the sweep
or a manual claim.

**Mint errors keep their code over the bridge.** `nativeRequest` throws the
errors cashu-ts throws itself — a `MintOperationError` with the mint's code for
a coded 400, an `HttpResponseError` otherwise. It used to throw a plain `Error`,
so every decision cashu-ts makes by code went blind. On testnut (Nutshell
0.18.2) that meant every signed quote failed "Signature for mint request
invalid": cashu-ts signs the amended NUT-20 message and falls back to the legacy
one only on code 20008. Checked live: signed invoices claimed, a
token sent, a melt paid, restored from the words.

---

## 2. Send over Lightning — `pay()`

Current design:

1. Get a melt quote (amount + fee reserve), with a 30-second deadline.
2. Split the local proofs into exactly what the melt needs and the rest
   (`w.send`, which may swap at the mint; retried on used counters, §1).
3. **Write** the rest to `foxy.cashu.proofs.<mint>`, and in the same tick
   **write** the proofs to be spent to `foxy.cashu.melting`, keyed by quote,
   with the amount, fee reserve, invoice and mint. A payment to a lightning
   address also records the address, lowercased.
4. Send the melt, raced against a 90-second deadline. As cashu-ts reserves the
   counters for the melt's change outputs, their ranges are **written** to the
   hold (`outputs`).
5. Read the answer:
   - `PAID`: drop the hold, **write** any change proofs, log the payment and
     its audit record. The fee logged is what the payment cost beyond its
     amount: the proofs the melt spent, plus the split's input fee (written on
     the hold as `splitFee`), less the change kept. It used to be the
     fee reserve less the change, which left out the input fee (NUT-02) on the
     melt's own proofs and on the split — about 2 sats low on a live mint.
     `sweepMelts` logs a `PAID` hold the same way.
   - `PENDING`, or an answer with no state: leave the hold. The screen says
     the payment may still be going through.
   - `UNPAID` / `FAILED`: drop the hold, **write** the proofs back.
   - An error: the mint is asked the quote's state (`checkMeltQuoteBolt11`,
     20-second limit). `FAILED` drops the hold and gives the proofs back.
     `UNPAID` does the same only if the mint itself refused the melt (a 4xx or
     a coded error, `mintRefused`). If the melt timed out or lost its
     connection, `UNPAID` leaves the hold: the request may still be on its way,
     and a retry could pay twice. `PAID` is filed as a
     payment, change included; anything else — no answer, `PENDING` — leaves
     the hold. The app shows PAYMENT PENDING, with
     no retry. It will not pay an invoice that is already held, or a lightning
     address with a held payment, and it starts no second send while one is
     still running. The app's 150-second backstop ends the wait, not the
     payment, so it shows PAYMENT PENDING too.
   - `PENDING` after the mint *refused* the melt: the held proofs' states
     are asked (NUT-07). All `UNSPENT` means the mint never took them, and they
     come back. Seen on testnut: a refused melt's quote stayed
     `PENDING` for good while restore found its inputs unspent. A melt that
     never answered, or timed out, stays held.

A Lightning address or LNURL (`payLnurl`) resolves to an invoice through the
native side, then runs `pay()`. The invoice must be for exactly the amount
asked, to the millisat (`msatOf`), and one with no amount is refused. It was
once compared in rounded sats, so an address server could return up to half a
sat more than asked and be paid.

`sweepMelts()` runs on connect and on resume. For each held melt belonging to
the connected mint it asks the mint: `PAID` files it as a payment (change
added without duplicates; change that comes back as blind signatures is
restored from the hold's recorded `outputs` ranges and nothing else), `FAILED`
gives the proofs back, and so does a hold at least two minutes old whose quote
is `UNPAID`, or `PENDING` with every input `UNSPENT`. Anything else is left for
the next pass. The PAYMENT PENDING screen also runs the sweep 30 and 150
seconds after it opens.

The change is restored from the recorded ranges, not from "where the counters
stood at the hold to where they stand now". That span also covered any token
sent after the hold, and a token not yet claimed came back as UNSPENT change:
ecash already given away, counted again.

A hold written before `outputs` was kept has `counters`, the snapshot taken
right after the split and immediately before `meltProofsBolt11`. Its change
used to restore nothing. The one range the melt reserved is now worked out from
what cashu-ts's `prepareMelt` does (checked at 4.10.1 and 4.10.2): when the inputs exceed the quote
amount it makes `max(bitlength(over − 1), 1)` NUT-08 blank outputs (that is,
`ceil(log2(over))`, at least one), `over` being the inputs less the amount, on
the wallet's bound keyset (pay passes no keyset id), reserved right after the
snapshot. So exactly that many counters from `counters[keyset]`, on that keyset
only (`recoverLegacyChange`). Accepted only when every held input is on that
keyset, the snapshot has a counter for it, and what comes back — `UNSPENT`,
held nowhere — adds up to no more than the fee reserve. Anything else is logged
and left for a seed restore; the hold still settles.

Change, from the melt's answer or restored, is filed with `addOwnProofs`, not
`addNewProofs`. The latter marks proofs imported, and reconcile
sets an imported proof aside when the mint calls it spent instead of removing
it: this wallet's own change, spent later, sat in the quarantine as if nothing
could rebuild it. Change from a wallet connected without the seed (random
secrets) is still marked.

**If killed during 2, or the split's answer is lost:** a swap at the mint may
have happened. Its output ranges are **written** to `foxy.cashu.swaps` as they
are reserved, before the request. A refusal clears the record. With no answer
the ranges are restored at once; if the mint signed them, the outputs go back in
the pile, the inputs the mint now calls `SPENT` come out (seed-derived ones;
imported ones are left for reconcile), and the payment fails with nothing paid.
If the mint cannot be asked yet, `recoverSwaps()` does the same on the next
connect or resume; a record whose ranges hold no signatures after two minutes
is dropped, as a swap the mint never made. On an answer the pile and the hold
are written first and the record is cleared after them: a pile
that cannot be written throws with the record still there, and a hold that
cannot be written sends no melt and puts the proofs back in the pile. Once both
are written every output is held somewhere, so the record could add nothing.
*Superseded:* "on an answer the record is cleared before the pile is written" —
a pile write that failed then left the outputs nowhere. *Superseded:* "a
restore rebuilds them; the next reconcile removes the inputs" — nothing ran
that restore.

**If killed between 3 and 5:** the hold is on disk. The next launch asks the
mint. The remaining window is between two adjacent `localStorage` writes.

## 3. Send as ecash — `sendToken()`

1. Split local proofs into the token amount and the rest. A token made this way
   is plain — Foxy's own earlier P2PK scheme was removed — and the one place
   a lock is put on ecash leaving this wallet is paying a payment request that
   asked for one (`lockTo`, §11 and §12). Locking means a swap, so the fast
   path where exact change goes straight over is given up for it. Retried on
   used counters (§1).
2. **Write** the rest to `foxy.cashu.proofs.<mint>`. Encode the send proofs as
   a token and **write** it to `foxy.cashu.outtoken`. Nothing is awaited
   between these two writes.
3. Log the send as settled, **write** an audit record (the token's proofs as
   inputs, the kept change as outputs), and **write** the token into
   `foxy.txmeta` under the send's entry, so it can be handed over again.
4. Show it. A watch (`watchTokenClaim`) asks the mint whether the token's
   proofs are spent, by their fingerprints alone, on one circuit used for
   nothing else: about once a second while the token's screen is open, then on
   a slowing ladder for up to a day. It is not asked as a sweep at launch: there
   the app only says, once per token, that a token may not have been claimed.

**If killed during 1, or the swap's answer is lost:** as §2 step 2 — the
swap's output ranges are in `foxy.cashu.swaps`, restored at once or by
`recoverSwaps()`, and the spent inputs leave the pile. No token was made, so the
send fails and the whole value is back in the balance. On an answer the rest is
written to the pile, then the record is cleared, and only then is the token made,
so a token's proofs can never later be restored as balance
(the bug fixed earlier for melt change). A pile that cannot be written throws
before any token exists, with the record still there, and `recoverSwaps()`
brings the whole value back. *Superseded:* the record was cleared before the
pile was written, and a pile write that failed left the swap's outputs nowhere.
Found with `tools/live/faults.js` (a): a `sendToken` whose swap answer was
dropped left the balance showing spent inputs until reconcile, and the value
only in a seed restore.

**If killed after 2:** the token is on disk. `lastToken()` offers it again.
The money is in the token, which is in storage.

*Superseded:* this file used to describe a gap between writing the rest and
writing the token, with the send proofs in memory only. In the current code
the two writes are adjacent, with nothing awaited between them.

**The token is bearer money, and it is stored in three places.** Anyone who
reads storage can redeem it until the recipient does:

- `foxy.cashu.outtoken` — until handed over and cleared. It holds only the
  last token; a second send replaces the first there.
- `foxy.txmeta` — kept with the history entry, up to 300 entries, so it can be
  handed over again.
- `foxy.cashu.audit` — the token's proofs as the audit record's inputs, up to
  30 records.

**Once claimed, the text goes.** When the token screen sees the
token claimed, `forgetClaimedToken(token)` drops it from its note, its proofs
from its audit record, and the last-token record if it is that one, asking the
mint nothing more. Amount, time and mint stay in the history. *Superseded:*
`forgetClaimedTokens()` asked the connected mint about every sent
token still held as text on every connect. From the sender's own exit, and
answered by the receiver's redemption, that told the mint who paid whom; a token
not watched to its claim now keeps its text until history is cleared. **Clearing history** empties the
notes and the audit trail too; if a sent token is not yet claimed (or cannot be
checked from here), the app says UNCLAIMED ECASH and clears only on CLEAR
ANYWAY, since twelve words can still restore it.

---

## 4. Receive as ecash — `receiveToken()`

1. Decode the token. Refuse if the route is closed (`assertRoute`). If the
   token is from another mint, connect to that mint — which also makes it the
   saved mint.
2. Check any DLEQ the token carries; refuse the token if one fails.
3. Ask the mint the proofs' state (NUT-07, `refuseSpent`). Any `SPENT` refuses
   the token as already spent, and any `PENDING` as being spent, before a
   counter is reserved. Before, a spent token was swapped
   straight away, and each refusal left counters the mint never signed — a
   wider gap for a restore to look across. A check that fails (no answer, a
   timeout) is not a refusal: the swap goes ahead as before and the mint
   decides. `reclaimToken` does the same.
4. **Swap** at the mint: hand over the token's proofs, receive fresh proofs
   derived from this wallet's seed and counters (on "already signed", the
   counter moves on by 10, 50, then 100, with a try after each; §1).
5. **Write** the fresh proofs and log the receipt. A pile that cannot be
   written throws, and the swap's record stays for `recoverSwaps()`.

**Why the swap is not optional:** until step 4 the sender still holds the same
secrets and could redeem first. `receiveToken` will not file a token it has
not swapped, which is why there is no offline receive.

**If killed during 4, or the answer is lost:** either the mint swapped or it
did not (the original token is still valid and can be pasted again). The swap's
output ranges are **written** to `foxy.cashu.swaps` before the request. With no
answer they are restored at once, and if the mint signed them the receive
completes from the restored proofs as if the answer had come; otherwise
`recoverSwaps()` restores them on the next connect or resume, files them in the
token's unit and logs the receipt. `reclaimToken` and each batch of
`importProofs` are guarded the same way. *Superseded:* "the fresh proofs are
regenerable from seed and counters" — true, but only a full seed restore that
nothing prompted did it.

**`importProofs()`**, the restore-from-backup path, swaps at the mint. Proofs
already held are skipped; a DLEQ that fails against the mint's keys refuses the
import before the mint is asked; the rest are swapped (`receive`), so the mint
checks every signature and what is filed is this wallet's own, recoverable from
the seed. Proofs the mint calls spent are left out rather than refusing the
whole backup; the rest go in batches of 100. Locked proofs (a NUT-10 spending
condition such as P2PK) are left out too: Foxy holds no key for them, and a
token that is all locked is refused before the mint is asked, in receive and
reclaim as well. A mint that refuses, or no mint connected,
imports nothing (a refusal after earlier batches keeps those and says so).
Proofs were once filed as they came, and a crafted backup showed any
balance it liked: a mint reports a secret it has never seen as unspent.

---

**Another unit.** A usd or eur token is read in its own unit: `tokenInfo`
gives `unit` and `amount`, and `sats` is null. A wallet of that unit, on
this seed and the shared counters, swaps it. The proofs are written to
`foxy.cashu.proofs.<mint>@<unit>`, and the log records `unit`, `amount` and
`sats: 0`. Sending, reclaiming or importing another unit is refused.

## 5. Reconcile — `reconcile()`, and spent ecash found by a payment

Asks the mint the state of every proof held at the connected mint. **Writes**
the survivors back if any were spent.

**Nothing in the app calls it any more.** It ran about a second
after the wallet connected at boot, on pull-to-refresh and on return from the
background, and each run sent the fingerprint (Y) of every proof held in one
request. The same fingerprints arriving each time let the mint recognise this
wallet over any Tor exit, and work out its balance after the fact as those
proofs were spent (MINT-PRIVACY.md). It stays in the wallet, tested, for a
check a person asks for knowing what it tells the mint.

**Spent ecash is now found by the payment that picks it.** `sendToken` and
`pay` swap first; a refusal for spent inputs (code 11001, "already spent")
asks the mint about exactly the proofs that swap sent, on the same circuit
(`dropSpentInputs`). The mint has just seen each of them, so the question tells
it nothing. The SPENT ones leave the pile by the rules below (dropped if the
seed rebuilds them, quarantined if not), `onSpentElsewhere` tells the app, which
says so, and the proof lock makes the payment again from what is left, at most
three times and only while each try removed something
(99-proof-lock-and-export.js). Until a payment picks it, ecash spent elsewhere
still counts in the balance. `tests/run.js`: "a payment that picks ecash spent
elsewhere asks about only what it sent, and takes that out of the balance".

What follows describes `reconcile()` itself, and the rules `dropSpentInputs`
shares with it.

- It can only *remove*. It never adds. A proof the wallet has forgotten is
  invisible to it.
- A drop means money left — most likely spent from a copy of the same proofs
  in another wallet, or a send this wallet did not record. The app shows it as
  a payment sent, unless the app was expecting its own spend.
- If the mint is unreachable it changes nothing.

Verified on a device: the whole pile exported to another wallet and spent from
there; reconcile reported the balance falling to 0 with every proof dropped.

**Single-flight.** Reconcile runs through the same chain as the other
functions that touch proofs (top of this file).

This was once documented here as a double-report nuisance. The review read it
correctly as silent money corruption: reconcile's overwrite, built from a
snapshot taken before another write landed, either deleted change that had
just arrived or resurrected proofs that had just been spent. No user action
required — launch and resume fired it on their own. **Replaced by** the proof
chain.

**It does not delete what the seed cannot rebuild.** A spent proof this wallet
minted is dropped, because a restore re-derives it. A spent proof whose secret
is on `foxy.cashu.imported` is moved to `foxy.cashu.quarantine` instead —
inspectable, and restorable with `unquarantine()` if the mint was wrong or
lying. Each entry records its mint (`{ mint, proof }`), `unquarantine()`
returns each proof to that mint's pile, and after a reconcile the app shows ECASH SET ASIDE with PUT
IT BACK. Putting back runs in the proof lock and asks the mint first: only
proofs it now calls `UNSPENT` return, the rest stay marked confirmed-spent and
are not offered again (keeping their unit), and another mint's entries wait
until that mint is connected. An older entry with no mint is looked at only
when its proof's keyset is one the connected mint issues; otherwise it stays set
aside and is reported as `unknown`, because where it came from cannot be told.
Such entries used to be checked against whichever mint was connected
— which calls a secret it has never seen `UNSPENT` — so another mint's proof
could be filed here as money. The imported list is pruned against every mint's pile, held melts and
the quarantine — pruned against the connected mint alone, it forgot imports
held at other mints.

*Superseded:* the first quarantine decided from the secret's shape (64 hex
characters meant derived). A proof imported from another NUT-13 wallet has the
same shape and was classed as rebuildable when it could never be. **Replaced
by** the imported list, written when the proof arrives.

**A limit:** "a restore re-derives it" assumes the mint answers the restore
honestly. A restore also asks the mint which proofs are spent, so a mint that
lies to reconcile can lie to the restore too.

The connected mint's other-unit piles are checked in the same request and
judged pile by pile. The sat figures count sats only; the other units are
reported under `units`.

---

## 6. Restore from seed — `scanSeed()` then `adoptScan()`

**The seed and its words are the phone's** (`SEED-HANDLING.md`). The page never has the words. Every restore's secrets come
from the phone (`restoreSecrets`), which moves no counter while a scan runs.
Words typed into RESTORE are typed on the phone (`seedEnter`), which answers a
candidate: an id for the words it holds.

**`scanSeed(target, mints)` reads only.** `target` is `null` for this wallet's
own seed, or `{ candidate }` for words typed on the phone; words given as text
are refused. For each mint, for every keyset of every unit the mint lists
(blind-auth excluded), each unit with a wallet of that unit, it walks counters
from zero in batches of 100. Each batch has a 45-second deadline and three
tries. Ten empty batches in a row (`RESTORE_GAP`, 1,000 counters) end the
keyset. A batch that fails all
three tries ends that keyset and marks the mint's row **partial**, keeping what
was found before it. Found proofs are checked with the mint and only `UNSPENT`
ones are kept (before, only `SPENT` ones were left out, and a
`PENDING` proof held by a payment still routing was filed as balance). The row
also carries, per keyset, one past the last counter the mint had signed.
The row carries `units.<unit>` beside `sats`, and `adoptScan` writes each
unit's pile under the same rules. How far the phone serves secrets:

- **This wallet's own seed** only up to 1,000 counters past the phone's next one.
  The walk stops there. A keyset that reaches it without ten empty batches,
  or a range the phone refuses ("outside the restore window"), marks the row
  partial; what was found before it is kept. Adopting the row moves the counter,
  and a scan after that looks further.
- **A candidate** from counter 0, at most 1,000 past the furthest range already
  served for it and that keyset, and 20,000 counters a keyset.
- **Only `00` and `01` keysets.** A legacy base64 keyset id is marked partial at
  once and named: the phone does not derive for it, and asking again changes
  nothing (before, each batch was asked three times, with waits, over Tor).
- **An adopted candidate stays usable while its scan runs.** The phone keeps a candidate after `seedAdopt` until the page forgets it,
  and `forgetSeedCandidate` waits for every scan still asking with it. The phone
  still drops candidates when Foxy goes to the background or the page loads
  again; a batch refused then ("unknown candidate") of words that are this
  wallet's seed now is restored with this wallet's own seed, inside its 1,000
  window. A batch past that window marks the row partial; adopting the row moves
  the counter, and a rescan of the partial rows finishes. Before, the adopt
  dropped the candidate at once, and a mint still being walked was left partial
  from its next batch on.

**`adoptScan(rows, opts)` writes:**

- **Counters only move forward:** each keyset in the rows goes to the phone
  with `counterAdvance`, which keeps the higher of its own counter and the
  scan's, including for keysets whose proofs were all spent. The phone moves a
  counter at most 100 past its next one, or to the end of a range
  `restoreSecrets` served this session ("too far ahead" otherwise). So each keyset's counter is peeked first (`counterReserve` with a
  count of 0): a move within 100 is asked for directly, and a longer one (a mint
  that answered after words were adopted, still walked with their candidate) in
  steps, each to the end of a one-counter restore of this wallet's seed the
  phone serves inside its window first. The page never asks for a move the phone
  refuses. A `00` keyset's counter is its derivation index's (id mod 2³¹ − 1).
- **Different words:** `opts.candidate` goes to the phone first (`seedAdopt`).
  It asks "Replace this wallet's seed?", and only on yes writes the words and
  sets the old seed's counters aside (`foxy-counters.replaced.<time>.json`). A
  No ("Nothing was changed."), a cancelled Face ID or an unknown candidate
  rejects with nothing changed (before, the counters were
  replaced first). A candidate the phone calls "same" is this wallet's own
  seed, adopted as a scan with no words is. Adopted or same, the phone raises
  each counter to what the words were served. Boot's one-time moves onto the
  phone are finished first (`nativeReady`), so counters an older build kept in
  this page are never put on the adopted seed.
- **New words wait for money that is still settling.** While `foxy.cashu.melting` holds a melt or `foxy.cashu.swaps`
  a swap being recovered, `adoptScan` with a candidate refuses before the phone
  is asked: "A payment or swap is still settling. Wait for it to finish before
  replacing the seed." Neither record names its seed, so after a Replace a held
  melt's change and a lost swap's ranges would be restored under the new words,
  and found nowhere. Words that are this wallet's seed already are let through:
  the phone's secret for counter 0 of a keyset the candidate was scanned on is
  compared with this wallet's own. A candidate never scanned waits too.
- **Proofs already spoken for are not adopted**: one held by
  a payment still routing (`foxy.cashu.melting`), in the quarantine, or in a
  sent token still on file (`spokenForSecrets`). Before, restoring an emptied
  mint put a sent token's and a held payment's proofs back in the balance.
- **A pile that already holds proofs** is skipped unless `overwrite` or
  `merge` is passed. An overwrite keeps everything already there when the
  words are new, when a restore has already replaced the seed this session
  (below), or when the row is partial. Otherwise it drops only proofs these
  words could rebuild, and keeps imported ones.
- **Counters move before any pile is written.** A counter
  the phone refuses throws with no pile changed; a counter write used to be
  ignored after the piles were written, which handed the next swap outputs the
  mint had signed.
- **Restored proofs get the stored-proof DLEQ check.**
  `scanSeed` checks what it found against the keys of the mint that restored
  it and names the proofs that fail (`dleqInvalid` on the row); `adoptScan`
  reports those through `onMintTrouble` as it stores them (`where: 'restore'`)
  and keeps them, as it does any stored proof. Before, a restore's piles were
  written without the check every other write of a pile runs.

The restore screen scans every mint the app knows with the candidate and adopts
every mint that answered with a balance, with `overwrite`. A mint that answers
after that is adopted as it arrives, with `merge`. When a newly connected mint
has nothing filed, the app also scans it under this wallet's own seed, with no
words, and adopts with `merge`. The lost-answer restores (§1, §3, §4) ask
`restoreSecrets` for exactly the recorded ranges, which are below the phone's
next counter, so always inside its window. A wipe is the phone's `seedWipe`.

*Superseded:* `scanSeed(words, mints)` took the words as text and
turned them into a seed in the page, different words went to the keychain with
`seedWrite` and iOS's Replace alert (`saveSeedConfirmed`), the old counters were
set aside under `foxy.counter.v1.replaced.<time>`, and a Debug-only switch ran
the path above instead. The switch and the words path are gone.

- Recovers anything derived from seed and counters: every proof this wallet
  minted, received through a swap, or kept as change.
- Does **not** recover: imported proofs, pending splits, unclaimed quotes, the
  out-token, history, notes, contacts, or proofs at a mint the app does not
  know.
- Depends on the mint supporting deterministic restore (NUT-13).

Verified once on a device: the full balance recovered through a container wipe
(a bundle ID change). That was the batch-of-300 design below, before the
keychain; the current restore is covered by `tests/run.js` in jsdom and by the
restores in `tools/live` against local mints, and has not been repeated on a
phone.

*Superseded:* "walk the counter forward in batches of 300" and "write whatever
comes back". The walk was one deadline per keyset — over Tor one slow answer
cost the whole keyset — the active keyset was walked twice, adopting a scan
could lower a counter (which made the mint refuse the next swap), and a partial
scan could replace a pile. **Replaced by** the batches, partial rows and
adoption rules above.

**A mint that answers after new words were adopted** (fixed). Such
a mint was adopted with `overwrite` and without the words. By then the new seed
was the wallet's seed, so the new-words protection did not apply: that mint's
unimported proofs from the replaced seed read as rebuildable and were dropped,
and the replaced seed's words were the only way back to them. Now, once
`adoptScan` has replaced the seed, it remembers which seed that is, in memory
(`seedReplaced`), and every later adoption while it is still the seed keeps
everything already in a pile, as the adoption that replaced it did. That covers
a late mint and a rescan of the mints that failed, for the rest of the session;
what it may keep by mistake is a spent proof, which the next reconcile removes.
The restore screen already adopted late mints with `merge`; the wallet no longer
depends on that. `tests/run.js` "MONEY §6 a mint adopted after new words keeps
the replaced seed's proofs" failed before the fix. *Superseded:* "Open, from
reading the code (not tested)", which described the drop above.

---

## 7. Move between mints — `moveQuote()` → `moveRun()`

The destination issues an invoice; this mint melts proofs to pay it.

1. **Write** `foxy.cashu.move` (destination, source, quote, amount, and the
   quote's NUT-20 key when the destination signs quotes).
2. `pay()` the invoice — §2, including its hold.
3. Connect to the destination (it becomes the saved mint) and claim the quote.
4. **Write** `foxy.cashu.move` empty.

Change from the unspent fee reserve stays under the source mint's key.

**If killed after 2:** the note is on disk. `finishMove()` runs on resume and
when the app connects, and does nothing unless the connected mint is the
destination. If the app died before step 3 the saved mint is still the source,
so the claim waits until the destination is connected. Whether the interface
points the person there was not checked for this document.

The menu's TRANSFER runs this for a chosen amount, through
`transferQuote()` rather than `sweepQuote()`: a sweep's fixed figure is what a
token is worth, a transfer's is what should LAND, and the fee is charged on top
of it at the source. Asking for 50 used to move 40 and take 41.

**If the payment is held as pending:** either `pay()` fails with "may still be
going through" and step 3 is never reached, or it returns pending and the claim
in step 3 fails because the destination has not been paid. Either way the note
stays and `finishMove()` tries the claim later.

---

## 8. Split a bill — `splitSave()` / `splitMarkPaid()`

Several invoices, one per person, **written** to `foxy.split.pending` as a
unit, stamped with the mint. Each is claimed as in §1 when paid;
`splitReconcile()` settles rows the watcher missed, first from local history,
then by asking the mint and claiming any it reports paid. A fully paid split is
marked done, not deleted. Does not survive a seed restore — the invoices are
the mint's, but the record of which belong to this bill is local only.

---

## 9. Receive on chain — `onchainAddress()` → `onchainClaim()`

An address is **not** an invoice. It carries no amount, it can be paid any
number of times, and this mint gives it no expiry, so nothing here is keyed to
"the payment": what is watched is the quote.

1. Ask the mint for an address, with a NUT-20 key made for that quote.
2. **Write** `foxy.cashu.onchain`: the quote, the address, the mint, the whole
   answer (cashu-ts signs the claim from it) and the key. `issued` starts at 0.
3. The screen shows the address, with the amount only as a BIP-21 hint.
4. Later — on launch, on return, and every two minutes while the app is open —
   `onchainClaim()` asks what the mint has seen, and mints ecash for
   `paid − issued`, capped at the mint's `max_amount`.
5. **Write** the record with `issued` raised by what was taken.

**Below the mint's floor the money is gone.** The spec says a payment under
`min_amount` does not count towards the quote and cannot be recovered, so the
app will not offer the network for less, and the screen says the floor in
words. This is the one money path where the loss happens before Foxy is
involved at all.

**If killed between 4 and 5:** the outputs were recorded before the request
(`noteQuoteOutputs`), so a restore rebuilds them; the mint's `issued` figure is
the truth on the next pass, and `paid − issued` cannot double-credit.

**Claims run one at a time** (the watcher chains them): each reserves counters,
and two at once derive the same secrets.

---

## 10. Send on chain — `onchainQuote()` → `onchainPay()` → `onchainFollow()`

1. Quote the payout: the mint's fee options, each a reserve and a rough wait.
   Nothing is spent by asking, and a mistyped address is refused here — the
   second gate after the checksum the page reads (`readAddress`).
2. Split the pile to exactly what the melt needs (§2's split, `includeFees`).
3. **Write** `foxy.cashu.onchain.out` with those proofs in it, state `SENDING`,
   before the melt goes out. They have left the pile and exist nowhere else;
   this record is the only way back.
4. Melt. `PENDING` means the mint has the transaction to broadcast, not that it
   confirmed; `PAID` means it confirmed.
5. **Write** the record's state, clearing the held proofs **only on `PAID`**.
6. `onchainFollow()` asks the mint until it says `PAID` — then history turns
   green — or `UNPAID`/`FAILED`, which returns the proofs to the pile exactly
   once and marks the entry failed.

**The fee is measured from the proofs that went**, not from the quote: with
`includeFees` the split hands the melt the mint's input fee as well, so the
quote's figure is short by exactly that (the balance fell one sat more than the
payment said it cost, in a live run).

**If killed anywhere after 3:** the record holds the proofs and the watcher
follows the quote on the next launch at that mint. Nothing is settled from the
proofs' state — a chain transaction says nothing about them — only from the
melt quote the mint keeps.

**Held proofs are spoken for.** `spokenForSecrets()` and `everyHeldProof()`
read this key as well as `foxy.cashu.melting`, so a seed scan during a payout
does not file them as balance again.

---

## 11. A request paid straight to this phone — `_requestPaid()`

The one path where money arrives without anyone tapping anything: the payer's
wallet POSTs a NUT-18 payment to a one-time onion address that exists only
while the request is on screen (THREAT-MODEL.md).

1. The payment must name a request open on this phone **now**, at the mint the
   request named *and* the mint this wallet is connected to, in sats, with at
   most 500 proofs of a shape Foxy can read, totalling at least what was asked.
2. It is turned into a token and **written to `foxy.req.unclaimed` before
   anything is attempted with it**. Everything after that write can fail and
   the money is still findable; before it, nothing could. A payment was lost
   that way once, held only in a variable while a delayed redeem sat
   in a `setTimeout` that died with the app. A write that will not land ends
   the payment there, with a 422: redeeming it anyway would only move the
   refusal to `setProofs`, with the mint having already taken the proofs.
3. Then it is redeemed as §4 — the mint decides, not the claim — and the entry
   is cleared only once the proofs are really in the wallet. `claimUnclaimed()`
   retries whatever is left on every connect, and on any screen money can leave
   from (`syncClaim`), because the balance counts what is waiting.
4. The payer is answered once: 200 when the mint took it, 409 when the proofs
   were already spent or the request is being paid on another connection, 422
   otherwise.
5. A paid request is closed, so the same payment cannot be presented twice.

**Nothing waits. Locked ecash is told first, unlocked ecash is taken first.**
Every payment is swapped the moment it lands. A locked one used to be held back
by a random 30 s to 5 min, so the mint would not see this redeem seconds after
the payer's swap for the same amount, and that delay has been removed.
It was one correlation at the mint bought with a path where the sats were only
as safe as the next thing to go wrong on it, and three things did: the only copy
of the token lived in a `setTimeout`; the receiving screen
showed nothing while the payer's phone said done; and the test for taking the
slow branch was *did the request ask for a lock*, not *is what arrived locked* —
so a payer who answered with ordinary unlocked proofs got a settled history
entry, the sats in the balance and five minutes in which to spend them back.

What survives the removal is the distinction, which now decides the **order of
the telling** rather than the timing of the swap. Ecash locked to this phone
**and to nobody else** is already ours — the payer cannot take it back — so the
payer is answered and the person is shown their money without waiting on a round
trip to the mint, and the swap follows in the same breath. Unlocked ecash is a
race, so nothing is said until the mint has taken it. What counts as locked is
`onlyLockedTo`, which asks cashu-ts who can open the proof rather than reading
the key its secret names — NUT-11 puts `pubkeys`, `locktime` and `refund` in the
tags, and each of those lets somebody else spend it too.

**And signed by the mint** (`mintSigned`). A lock says who may
spend a proof, not that it is money: anybody who has seen a request knows the
key it asks for and can write secrets locked to it beside any point at all. The
lock alone was the test, and sats no mint had signed were answered 200,
shown as paid and counted. So ecash is "already ours"
only when every piece carries a DLEQ (NUT-12) that verifies against a keyset
this wallet holds — which needs no route, since the keys are cached. A DLEQ
that is present and wrong is refused outright, on every path, with the
`signatures do not match` message. One that is missing, or from a keyset not
loaded: with a route the payment takes the unlocked branch and is announced
only once the mint has taken it; without one it is refused, since nothing here
can tell it from a forgery. The same rule applies to a locked token scanned
while offline (`receiveToken`). And ecash the mint refuses as never issued
(NUT error 10003, `notIssued`) is dropped from the unclaimed list rather than
retried and counted for ever.

The receive is written to history **when it arrives** rather than when it is
swapped. That matters more than it sounds — the confirmation screen is raised by
the history pass finding a new entry, so an entry written by the swap meant the
receiving phone went back to home with nothing on it. The swap finishes that
same entry rather than adding a second, through a hash threaded down to
`receiveToken`. `balanceSats` counts what is still waiting, through
`unclaimedSats()`, because a swap that fails leaves real money there.

*This widens "settled" for money coming in, and it is the incoming mirror of
review finding 9 (THREAT-MODEL.md §12). It does not survive a mint that will
never swap again: history and balance would both show sats that cannot be
spent.*

What the page holds besides that is the register of open requests, in memory
only — a request outlives neither the screen nor the page.

## 12. Tap to pay — ecash between two phones over Bluetooth

The only path where money crosses without a network at all. The full design,
the six-message handshake and what a listener nearby can learn are in
`TAP-TO-PAY.md`; what moves value is this:

1. The **receiver** holds up an invoice screen, or one share of a split. By
   default (AUTO TAP TO PAY) the screen arms itself and goes on the air, under
   a service UUID made fresh for this payment, without a press; with that
   setting off, a press of TAP (or a shake) does it, and an orange card covers
   the QR and says TAP HERE. Whoever advertises is findable, which is why a
   payer never advertises and a receiver advertises only while an invoice is on
   its screen. Its offer is the Lightning invoice and a NUT-18
   payment request naming its mint — or, on the CASHU rail, the request alone,
   and the offer may follow the arming rather than wait for it.
2. The **payer** listens, from home and from SEND, and never advertises.
   Listening emits nothing, so being ready to pay costs a customer nothing.
   Its confirmation opens by itself when a merchant taps.
3. The two agree an X25519 key, commit-then-exchange, and show the same four
   digits. The code covers the service and both keys and nonces. Nothing is
   revealed before that commitment.
4. On the same mint, the payer pays the **request** with ecash locked to the
   key it carries (NUT-11), and hands the proofs straight over the link —
   padded to a multiple of 4096 bytes, so the size says little. No Lightning, no fee, and
   the mint never sees a payment between two of its own users. On a different
   mint it pays the invoice as any wallet would.
5. The receiver takes it exactly as §11 above: written down first, then
   redeemed. A payment the link cannot carry falls back to the request's own
   onion transport rather than being lost.

The lock is what makes the delivery safe to be quick: ecash taken off the air
is worthless to anyone but the phone that asked for it. Measured on two
phones: made in about 1.2 s, delivered in about 180 ms.

---

## 13. Small change, and the swaps that make it

The pool is twelve pieces of each of 1, 2, 4, 8, 16, 32, 64 and 128 sats and
eight of each larger power of two up to 65,536 (`SMALL_PIECES`, `DEEP_PIECES`,
`05-paying-this-mint.js`). It is what lets a phone pay an exact amount without
asking the mint, which is the only way to pay with no connection. Four
things changed, after a top-up swap that took 27–42 seconds held the proof lock
in front of payments and a receiver's answers.

- **A payment's own swap fills the pool.** `receiveToken`'s swap and the
  locked send both pass cashu-ts the output denominations they want
  (`shapeOutputs`): every tier below its target, smallest first, at most
  sixty pieces and six of any one size, within what the mint takes in one
  request (`mintArrayCap`), the rest as powers of two. The locked send puts
  **one** large piece in — the smallest that covers the amount, its input fee
  and the fee cashu-ts adds to the sent outputs — so the small pieces on hand
  are never spent as inputs; the untouched pile is written back beside the
  change, deduplicated by secret, once only (a restored answer already
  carries it). Tests: `tests/run.js` "a receive into an empty pile fills the
  small tiers", "a locked payment takes one large piece in", the fee-mint
  variant at 1,000 ppk, and "asks a small-cap mint for no more outputs than it
  takes"; live, `tools/live/array-cap.js` and `p2pk.js` §7–8.
- **A top-up runs only with Foxy put away.** A tier is refilled once it is
  down to six (small) or four (large); the top-up itself fills every tier
  below target, six at a time. Nothing runs in the foreground: `tidyChangeNow`
  only notes that one is owed, `putAway(true)` starts it, no new swap starts
  after twelve seconds away, and the phone keeps Tor on the network for
  twenty (`FoxyWebView.appEnteredBackground`, `moneyInFlight`). There is no
  waiting screen; one was tried and taken out. Tests:
  `tests/watch-rearm.js`, `tests/kept-token.js`.
- **A swap still out as the window closes keeps its piece spendable.** At
  eighteen seconds `topUpClosing` asks the mint (`checkstate`) whether the
  input has been taken; if not, the record is marked `freeInputs` and
  `holdInputs` leaves the piece in the pile rather than holding it, so
  somebody who stays offline can spend all they have. The next connection
  settles it (`recoverSwaps`): outputs the mint signed come in and the input
  goes out **before** the record is dropped (`dropInputsOf`), never both
  counted. Until then `recoveringSats` names the piece on the audit card and
  the home pill ("being recovered from the mint") once it has left the pile.
  The one case this gets wrong is a request that lands at the mint after the
  check: the piece is spent, the next payment that offers it fails at the mint
  and drops it, and the outputs come in on the next connection — a failed
  payment, not a loss, since an offline receiver takes only locked ecash and a
  locked payment is a swap the mint refuses on the spot. Tests:
  `tests/held-swap.js` (the free-input case).
- **A send stopped before it began is not made.** STOP WAITING calls
  `giveUpWaiting`; a `sendToken`/`pay`/`payLnurl` still queued behind the
  proof lock is rejected with `foxyStopped` before it reserves anything. One
  that has started is left to finish.

What this changed in the restore: a refused or lost shaped swap burns up to
sixty counters, so the walk's gap and the phone's window went from 300 to
1,000 (§6, `SEED-HANDLING.md`). The counter-skip ladder (10, 50, 100; 160 a
session) is unchanged and inside it.

## 14. A mint that charges, and what follows from it

mint.macadamia.cash charges 150 ppk on every piece spent; mint.minibits.cash
charges nothing. Every item here was invisible at the second and wrong at the
first, and was found on phones or by `tools/live/tap-scenarios.js`
against two CDK mints set up like them (`tools/live/mint-pair.sh`).

- **The receiver gets what it asked for.** A paying Foxy adds the fee the
  receiver's own swap will cost (`includeFees`, or the fee on the exact pieces
  it hands over), so a request for 8 arrives as 9. What is announced and
  written is what stays: `kept = arrived − fee − change`
  (`20-helpers.js:_requestPaid`).
- **Change carries its own cost.** `owed = paid − asked − fee` is what was
  paid over. `changeFor(w, owed)` (`07-request-delivery.js`) is how much goes
  back: `owed` less the fee to spend one piece making it and the fee the
  token carries so the payer's swap is paid for — 2 sats at 150 ppk, nothing
  at a mint with no fee. The payer who paid over pays for getting it back;
  the receiver's entry stands at what it asked. When that leaves nothing — a
  sat or two over — no change is made at all. The payer's phone does the same
  sum from the same mint's fees (`sendToken`: `dust`, `over: 0`), so it is
  not left waiting and nothing has to cross the link to say so; the sat or
  two stays with the payment and both entries say what really moved. Both
  change makers follow it (`changeBack`, `changeForScanned`), each change is
  settled against what was paid over (`settleChangeMade`: `changeFee` when it
  cost more than allowed for, `changeDust` when less), and the payer settles
  its entry with what the change is worth to it, less the fee for taking it
  (`changeNet`).
- **Every fee is on an entry.** A token made by a swap carries that swap's
  fee (`tokFee`); a top-up's fee goes on the payment before it
  (`chargeTopUpFee`); and what was settled on an entry survives the swap
  that lands after it — locked ecash is announced first and swapped in
  second, and that swap's write used to wipe the figures out
  (`receiveToken`, "What was already charged to this entry stays charged").
- **The card refuses before SEND.** `sendShortfall(sats, {locked})` puts the
  amount, with the receiver's fee on the pieces it is cut into and four to
  spare, to the same selection the swap makes; `requestSpec` shows the fee
  and "short by … with the fee".
- **A locked payment is finished after the app is killed.** A locked send's
  outputs have no counter, so they are written into the swap record before
  the request leaves. A page that lost the answer already asked the mint for
  them (`restoreLocked`); a page that was *killed* left the record to the
  next launch, which only ever walked counter ranges — so the mint was asked
  nothing, the pile went on showing pieces the mint had spent, and after two
  minutes the record was dropped as "never made" with the payment inside it.
  Now `connect` holds those pieces out of the balance (`holdUnanswered`,
  with or without a route), `recoverSwaps` asks the mint by the written-down
  outputs (`finishLockedSend`), and what it rebuilds is written as
  `sendToken` would have written it (`writeLockedSend`): the change in, the
  spent pieces out, the payment on an entry of its own with its token, to be
  shown and scanned — it is locked to the receiver, so nobody else can take
  it. The record is given up only when the mint says the pieces that went in
  are unspent, never on its age. The app says so once (`onSendRebuilt`).
  Change being made for a payer goes on the payment it is the rest of.
- **Money passing through is not cut into small change.** A payment taken at
  the payer's mint to be melted home (`purpose: carry:…`) is received `plain`
  — the fewest pieces — late claims included (`keepUnclaimed`'s `plain`). It
  arrived as 46 pieces, 7 sats to spend where the quote allowed 6, and the
  way home was refused. `pay`'s refusal now names the figure it refuses on,
  this mint's fee included.

Tests: `tests/change-leg.js` cases 4–6, `tests/locked-send-lost.js` (the
killed cases), `tests/send-fee-check.js`, `tests/run.js` ("a token's row
carries the swap fee", "the shortfall check agrees with the swap", "a payment
only passing through", "change made at a fee mint"). Live:
`tools/live/tap-scenarios.js` — same mint and across mints, each side with
and without a route, seventeen cuts and kills, every balance checked against
the mint (`reconcile`).

- **A no that is true, and a not-yet that is said as one.** Plain ecash
  whose swap did not come back was answered 422 — "they did not take it,
  your sats are still yours" on the payer's screen — and kept on the
  unclaimed list all the same, to be claimed on the next connection; the
  payer's RECLAIM was then refused as already spent. Two things were being
  called a refusal. If the swap may have reached the mint (its record is
  still on file), the receiver keeps what it wrote down and answers 409,
  which the payer reads as UNCONFIRMED (`tapSend`): it keeps its token,
  watches it, and is not told it may spend it. (409 because the phone
  passes on only 200, 409 and 422 from the page — `handleInboxAnswer` — so
  any other status would arrive as the refusal this is meant to stop.) If the swap never left or the
  mint refused it, the copy is dropped and the 422 is true
  (`20-helpers.js:_requestPaid`, the plain branch).
- **A payment that did not go still cost its split.** `pay` swaps the pile
  into exactly what the melt needs before asking for the melt; that swap's
  fee is paid whatever follows. When the hold is given back unpaid it is
  charged once (`chargeUnsentFee`, guarded by `meltGone`) to the payment
  before it or to the tally the audit card counts.
- **A melt held at another mint is settled from wherever the phone is.**
  `sweepMelts` then asks every other mint a hold names, with a wallet built
  on this phone's seed and counters as `connect` builds one, so the melt's
  change — the unused route reserve — is restored and kept at the mint it
  belongs to, and the entry names that mint. The phone is connected nowhere
  new. A paid melt whose change restore *fails* now stays held rather than
  being written with the whole reserve as its fee.

Tests for these three: `tests/change-leg.js` case 7, and in `tests/run.js`
"a held melt at another mint is settled from wherever the phone is", "a paid
held melt whose change cannot be restored yet stays held" and "a melt that
did not go still cost its split"; live, `tap-scenarios.js` F10, F10b, F11 and
F17. That suite now passes whole.

**Found by a second suite, and fixed** —
`tools/live/offline-cross-scenarios.js`, over ground the first did not cover
(reverse crossings, lost phones and restores, replays, paying out of locked
ecash, crossings cut and repeated, amounts at the edge of a balance). What it
found, and what holds now:

- **An offline phone takes locked ecash only for a request still open on
  it.** A lock this phone's words derive was the whole test, which includes
  the key of every request it has ever been paid: a payment claimed by tap
  and shown again as a code once the receiver was offline read PAYMENT
  RECEIVED for spent ecash. Offline, the lock must match a row in
  `foxy.req.lockkeys` (`lockRowFor`); a claim strikes the row off by key
  (`dropLockKeysByPub`), and an offline acceptance marks it taken
  (`markLockTaken`), so a second token to the same request is refused too.
  The cost: with no route, ecash for a request older than the last 500, or
  one made before a restore from words, is refused until there is a route.
  Online nothing changes; the mint decides.
- **Crossing notes are a list** (`foxy.cashu.move`, `moveNotes`). One slot
  was written over by the next crossing, and the first one's quote and the
  key that claims it were gone with its melt already paid. Each note names
  its quote and the invoice its melt pays. `finishMove` finishes every one
  from wherever the phone is, with a wallet made for that mint on the phone's
  own seed (`awayWallet`), and leaves alone the ones this page is in the
  middle of (`liveMove`). A melt that never left, or is given back by the
  sweep, takes its note with it (`dropMoveNoteFor`). `recoverSwaps` asks
  every mint a record is at, the same way.
- **Locked pieces paid out of are struck off once the token exists.**
  `forwardLocked(text, { defer: true })` signs and writes nothing; `sendToken`
  strikes all of them off together after `mustSave(K.outtok)`.
- **An overpaying tap token names the key for its change** in its own memo,
  so a token shown as a code after the link dropped still gets change back.
- **One sum for what a melt needs** (`meltNeed`): the invoice, the reserve,
  the mint's fee for the split, and its fee again on the pieces the melt
  spends. `pay` and `transferQuote` both ask it, so the largest amount a
  quote allows is one the payment takes, and the amount a refusal offers
  instead is one the quote then allows. An offline payer says what it can
  hand over, not what it holds (`stuckAtMint`).
- **A visit is not a move.** Going to another mint to pay from it or to be
  paid at it connects with `{ remember: false }`: `moveRun(plan, onStage,
  { visit: true })`, `carryBegin`, and a late claim of another mint's ecash
  (`claimUnclaimed`, which then goes back). Killed over there, the app opens
  at home.

**A payment taken at the payer's mint is not received until it is home**
(`foxy.cashu.carry`, 04-lost-answers.js). The job is written before the
visit — where home is, their mint, what was asked, and once the payment
arrives its request, its entry and the key the payer sent — and every later
step finds it. `carryHome` resolves one of: `home`; `moving` (the melt home
was paid and is not claimed yet, which `finishMove` finishes and reports as
the payment arriving); `waiting` (the melt may still be going through);
`short` (bringing it home now costs more than the payer paid for, and the
person is asked: bring home what fits, or send it back); `retry` (a mint
could not be reached; tried again on every launch, resume and returning
route by `carryResume`); `refunded`; `stuck`. A launch finishes one by
itself when a fresh quote fits inside what the payer paid, and asks when it
does not.

**The refund.** A melt home the payer's mint refuses twice, a mint that
refuses to quote twice, or the person's own SEND IT BACK, sends the whole of
what that payment left at their mint back to the payer: a token locked to
the key the payer sent, made by the same code change is (`carryBack`,
`purpose: 'change'`), so a kill in the middle is finished by the same
recovery. It crosses the link if the phones are still together and the
payer's phone takes it as it takes change (lock, signature, amount, all
checked offline); otherwise it is on the payment's own entry as a code. The
entry stops saying the payment was received (`refund: true`, `sats` what was
too small to send). The receiver cannot spend what it sent back. If the
payer's mint is the thing that failed, the refund cannot be made either and
the receiver holds a claim on that mint (`stuck`); that cannot be removed,
only said.

**A refused payment is taken back by itself** (`takeBackRefused`). Plain
ecash a receiver heard and refused has been seen by another phone; it stays
off the balance, on its entry, until swapped for pieces nobody has seen.
That was a button. It now runs on the first connection after the refusal. If
the mint says the pieces are spent, the receiver took them after saying no,
and the entry says paid: that is how a payer finds out. Nothing stops a
receiver doing that; the loss is that one payment. A refused payment that
was locked to the receiver is not called "still yours" on the card: only the
receiver can spend it.

**A second tap after a move that did not finish pays from what is already
there** (`tapPayFromThere`): an unfinished crossing is collected first, and
sats this phone holds at their mint pay the request with no second Lightning
payment.

**A cheat on the other end, and a long sitting with no connection**
(`tests/offline-hostile.js`, and `dup-proof`, `soak-rx`,
`soak-payer` in the second suite). What they found, and what holds now:

- **Each piece of ecash counts once** (`repeatedProof`). A payment is added
  up by its pieces and nothing checked that they were different pieces: 205
  sats locked to an offline receiver, sent with every proof named twice,
  read PAYMENT RECEIVED for a 400-sat request. With a route the mint refuses
  the whole swap for the repeat, so the receiver got nothing and the 410 sat
  stayed on its screen as waiting for ever. The same repeat made 50 sats of
  change read as 100 to a payer with no route. Refused now in `readPayment`,
  in `checkChange`, and for any token `receiveToken` is given.
- **What the fee screen shows is what PAY sends.** A receiver carrying a
  payment home sends its terms and a request. The screen showed the figure
  in the terms and PAY paid the amount in the request, which nothing
  compared, and that screen is the only confirmation the payment has: a
  card for 1,028 sats sent 5,000. The request is read before the screen
  goes up and must be for that figure, at this phone's own mint
  (`tapStuckAtMint`). The request that answers a dollar price must be for
  the sats this phone offered (`tapQuoteTheirDollars`).
- **The receiver's fee is counted on every piece in a token**, the ones
  locked to this phone and signed on as well as the pile's
  (`exactPieces`/`coverPieces` with `beside`, `exactWithLocked`). It was
  counted on the pile's alone: ten locked pieces and four loose ones added
  1 sat for a fee of 3, and the thirtieth payment of a sitting was refused
  for landing 2 short.
- **A refused payment made partly of ecash locked to this phone is taken
  back** (`takeBackToken`). The automatic take-back skipped it and RECLAIM
  said it was locked to someone else: the payment was off the balance, and not
  in the words either. It is taken in the way any ecash locked to this phone
  is.
- **A refund far short of what was paid is said as that**: ONLY PART CAME
  BACK, with both figures.
- **What is left of a payment and worth no more than the mint's fee to
  claim is let go** (`claimUnclaimed`): a single sat left behind by paying
  piece by piece was refused by the mint on every connection and counted
  in the balance for ever. It is the fee its entry was already written net
  of.

What the long sittings showed otherwise: forty locked payments taken with
no connection in 18 s, the app killed and reopened part-way, a payment
made out of them, all forty claimed in 17 s on reconnecting, 123 thousand
characters of storage; thirty payments from a payer with no connection,
every change returned over the link. Known and left: with no connection
the balance counts a waiting payment before the mint's fee for claiming
it, about a sat a payment, until it is claimed.

**Left open, known.** A receiver that says no and redeems plain ecash
anyway; a receiver that keeps the change from an overpayment; and the unused
route reserve of a carried payment, which stays with the receiver. The first
two are visible on the payer's entry. Ideas discussed and not built: a
refund locked to the payer as the only acceptable refusal, a tolerance for
what may be kept, and paying offline from ecash locked to oneself with
whole-transaction signatures (NUT-11 `SIG_ALL`, NUT-08), which would close
all three.

## 15. A refused payment, and ecash another phone has seen

**The problem.** One phone is offline, one is online, and ecash crosses the
Bluetooth link. The receiver then says no. Without this design nothing is
handed back: the payer still holds its own copy, and so does the receiver, and
a dishonest receiver can redeem it after the payer has left. It is worse the
other way round. An online payer hands an offline receiver ecash locked to the
receiver, and if the receiver says no, the payer can never take that ecash back.

**The rule.** A receiver that can reach the mint never just refuses: it takes
the payment, or sends it back as new ecash locked to the payer. A refusal that
arrives without that locked refund is HIGH RISK on the payer's phone at once,
while both people are still standing there. And any ecash this phone counts
that another phone has seen, and that is not locked to this phone, is HIGH RISK
until this phone has swapped it. That does not cover the ordinary balance:
those pieces are unlocked too, but only this phone has ever seen them, and
flagging them would flag everything.

What the code does with money:

- **Ask first** (`askFirst`, `answerIntent`). Before a tap's ecash crosses,
  the payer sends what it is about to send — amount, mint, locked or not,
  keyset — and the receiver answers whether it could take it. No money moves on
  either answer. Only a receiver whose offer says it answers is asked
  (`ask: 1`), so an older Foxy is paid as before. "No", or no answer inside six
  seconds, ends the payment with nothing sent. Across mints the question is
  asked before the move, so a "no" costs no fee.
- **A refusal comes back locked** (`refundRefused`). A receiver that has a
  route and refuses a payment it was handed — no open request, a short amount,
  a repeated piece — swaps the pieces in and sends the same value back as new
  ecash locked to the payer's key for that request, over the link or as a
  carry job (`kind: 'refusal'`). The receiver keeps nothing: what the swap cost
  is the only difference, and it is said.
- **The payer checks the refund** (`checkRefund`, `refundArrived`): it must be
  locked to this phone's own key for that request, from this phone's mint, each
  piece once and in sats, and signed by the mint where that can be checked (with
  no route, the signatures are checked offline and a refund that does not verify
  is not kept). Anything else is not a refund and is not counted as one. A
  refund short of what was paid by more than the greater of 6 sats and 1% is
  still kept, because it is locked to this phone, and it is said as ONLY PART
  CAME BACK, with both figures.
- **No refund in 10 seconds is HIGH RISK** (`afterRefusal`, `atRiskAdd`). The
  pieces are the payer's own and the receiver has a copy. They go back into the
  pile and the balance, flagged in `foxy.cashu.atrisk` and written with
  `mustSave`; the entry reads "ecash, refused" with `highRisk`. They can be
  spent before they settle. The balance is ringed red while any are held.
- **Made safe at once when there is a route, and otherwise on the next
  connection** (`afterRefusal` calls `_settleAtRiskOnce` itself when
  `routeOpen()`; `settleAtRisk`, under the proof lock, from
  `catchUpCrossings`). The mint is asked about each flagged piece. Spent:
  the receiver took the payment after saying no — the pieces leave the pile and
  the entry becomes a payment, `taken`. Unspent: they are swapped for pieces
  only this phone has seen, the fee goes on the books (`chargeUnsentFee`), and
  the flag is dropped.
- **A late refund** scanned or pasted as a code settles the same entry
  (`atRiskRefundOf`, `atRiskRefunded`), once.
- **Redeemed is not always stolen.** A receiver that means to refund swaps the
  payer's own pieces to make the refund, so the payer's phone can see them
  spent before the refund reaches it. The record of a `taken` payment is kept
  for thirty days, emptied (`{ taken, req, sats }`), so a refund locked to that
  request's key is still recognised: the entry stops saying taken and says
  refused and returned. The card says so too: "If they are sending it back,
  they will show you a code to scan."

**Trade-offs, kept as they were weighed.**

- It does not stop theft. A cheat sends nothing back; the payer is warned on
  the spot, and the loss is that one payment.
- False alarms. An honest receiver whose mint is unreachable cannot make the
  refund, so the payer sees HIGH RISK anyway, and it is true until one of them
  is online. The words must not accuse.
- An offline receiver can never refund. Every refusal from one is HIGH RISK,
  and the payer cannot take locked ecash back. Only asking first helps.
- The link has to hold a few seconds longer. A refund is a swap over Tor, two
  to four seconds, and change legs have missed the link at that length before.
  A missed refund becomes a code to scan, with HIGH RISK showing meanwhile.
- At a mint that charges, the refund swap costs the payer a sat or two.
- The balance may overstate. Flagged pieces are counted and ringed red, and can
  be spent, though the money may be gone; keeping them off the balance would
  show money as missing instead.
- Foxy to Foxy, over Bluetooth only. Other wallets, and payments over an onion
  address or Nostr, have no way to carry a refund (the wait is only for a tap).
- More states in the money path: refused and returned, refused and at risk,
  taken back, taken by them. `tests/counter-refusal.js`, `tests/crossings.js`
  and `tests/change-leg.js` carry the fault cases, and `tools/live/` the
  two-phone suites.

The cards (HIGH RISK, ONLY PART CAME BACK) are drawn in
`build/app/07-history-tokens-mints.js`, `11-cards.js` and
`15-paid-wake-keyboard.js`. What would close the gap for good is in §14, under
"Left open, known".

## 16. One job, one mint, one balance

Found in a session of taps across three mints with one phone offline. None of
it lost money; all of it said something about money that was not so.

**A payment to be carried home has one job, and only a paid job is walked.**
A job is written down when the terms are asked for (`carryBegin`) and the
payment is written on it when it arrives (`carryArrived`, then `carryPaid`
sets `kept`). The app could ask twice for one payment — the link dropped
mid-quote and the payer touched again — leaving two jobs, and it walked the
one whose id it held, which was the empty one; `carryGo`'s failure path then
marked that one `paid`. Three guards, any one of which is enough:

- the app keeps one asking per mint and amount (`_carryAsk`), and a repeat is
  answered by the asking already under way;
- `carryHome(id)` given a job with nothing paid to it drops it and walks the
  paid job of the same visit, on a fresh quote — or does nothing if there is
  none;
- `carryStep` forgets a `paid` job whose `kept` is not above zero, which is
  also what clears the one an older build left behind. `carryRefund` does the
  same.

**Stuck ends the job.** `carryBack` with no key to lock a refund to, with
nothing worth sending, or refused by the mint, resolves `stuck` and drops the
job. The sats are in that mint's pile and its balance either way; what is
given up is trying again on every launch, which raised the same card each
time.

**The balance is one mint's.** `balanceSats()` is the pile at the mint the
wallet is on plus what is waiting to be swapped in *at that mint*
(`unclaimedSats(mint)`); rows written before the mint was kept on them are
placed by the mint in their token. With no argument `unclaimedSats()` is
still everything waiting, which is what the claim-on-reconnect asks.

**An invoice belongs to the mint that made it.** `watch()` notes that mint
(`madeAt`, from the quote's record) and asks nothing while the wallet is on
another; `_claimOnce` refuses a claim from another mint without asking and
without spending a counter (`foxyElsewhere`), and `noteClaimTrouble` does not
file that as trouble.

Proof: `tests/crossings.js` 5 and 8, `tests/cross-mint-online-only.js`.

## Paths that move proofs and have no section above

Named here rather than left out, because MONEY.md claims to enumerate where
value moves and these were once missing:

- **`exportProofs`** (`19-bill-split.js`) — serialises the whole sat pile
  into one `cashuB` bearer token. It is **not** inside the proof lock, while
  its mirror `importProofs` is.
- **`clearQuarantine`** (`15-receiving.js`) — one line that destroys
  quarantined proofs, outside the lock, while `unquarantine` writes the same
  key inside it.
- **`wipeDevice`** (`10-connection.js`) — removes every money key.
- **`payRequest`** (`20-helpers.js`) and **`deliverOverNostr`**
  (`07-request-delivery.js`) — the outgoing NUT-18 path and its Nostr
  transport. `deliverOverNostr` is named in no test.
- **`tidyChange`** (`19-bill-split.js`) — the top-up swap; only
  with Foxy put away (§13), and the pile is re-read before it is written.

## What an auditor should look hardest at

1. **§2, the melt.** The kill window is down to two adjacent writes, but
   `PENDING` has never been seen on device, and the "definite refusal" test
   (`mintRefused`) goes by flags, HTTP status and the mint's error codes, with
   a few known wordings (used counters, bad signatures) as a fallback.
2. **§3, the out-token at rest.** Bearer money in localStorage, in three keys,
   and in `foxy.txmeta` and the audit trail after it is handed over, until the
   token screen sees it redeemed and `forgetClaimedToken()` drops it, or
   history is cleared.
3. **§6, what restore cannot reach**, and whether users are told. (The late
   overwrite once noted there has been fixed.)
4. **Imported proofs.** They are the ones no restore brings back, and whether
   they are protected depends on `foxy.cashu.imported` being intact.
5. **§10, the on-chain payout's record.** It holds bearer proofs for as long as
   the mint takes to confirm, which is blocks rather than seconds, and it is
   the only copy. Clearing them on anything but `PAID` loses them: that bug was
   in the tree for a day (`tests/onchain-flow.js` now pins it).
6. **§9's floor.** Foxy refuses to show an address for less than the mint's
   minimum, but nothing stops a payer sending less than they were asked for.
7. **§13's free input.** A piece left spendable at the Tor close while its
   swap is unanswered; the race is bounded, not closed. And the restore gap:
   seventeen refused shaped swaps in a row with no success between would put
   everything after them out of a restore's reach.
8. **§11's unclaimed store.** More bearer money at rest, in `foxy.req.unclaimed`
   with the key that opens it in `foxy.req.lockkeys` beside it. It exists
   because the alternative lost sats, and it is cleared on the swap. Removing
   the delayed swap narrowed the window to the round trip to the
   mint, but not to nothing: a swap that fails leaves an entry there until the
   next connect, and every entry is claimable by whoever reads both keys.
9. **§12's proximity.** Signal strength chooses which phone is paid and is not
   a security boundary — an antenna defeats it. The four digits are the only
   thing between a payer and a relay, and comparing them is offered rather than
   enforced. That is a deliberate decision and the right one for a
   counter; it is the wrong one for a room full of strangers.

*Superseded:* this list used to name "concurrent reconcile — three reports of
one event" and "a pending-melt record would close it". The proof chain (§5)
and the hold written before the melt (§2) replaced both.
