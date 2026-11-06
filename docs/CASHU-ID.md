# The Cashu ID

A name another wallet keeps in its contacts and pays, with no server in the
middle: something like a Lightning address, with more privacy. MENU › MY
CASHU ID shows it as a QR code with SHARE. Another Foxy scans it, or pastes it
on the home screen, names the contact, and from then on pays it from
CONTACTS (SEND › CONTACTS, or CONTACTS in the menu). The ID itself is never what the money is locked to: every payment
is locked, by NUT-28 (pay-to-blinded-key, P2BK), to keys nobody has seen
before, which only the ID's seed can open.

The code: `Foxy/Keychain/CashuID.swift` (the keys, the blinding and the
signatures, native, libsecp256k1), `Foxy/Bridge/FoxyBridge+CashuID.swift` (the
inbox, and the recovery key's), `build/wallet/08e-cashu-id.js` and
`21c-cashu-id.js` (the string, the payer's half, the outbox and its copies, the
arrivals, the receiver's choice at other mints), `build/app/26o-cashu-id.js`
(the screens). Tests: `tests/cashu-id.js`, `tests/cashu-id-choice.js`, `tests/cashu-id-any.js`, `tests/cashu-id-ui.js`,
`FoxyTests/CashuIDTests.swift`, all held to `tests/fixtures/cashu-id-vectors.json`
(NUT-28's own vectors and Foxy's).

On the numbering: the blinding is the one cashu-ts 4.11.0 bundles as
`deriveP2BKBlindedPubkeys` and calls NUT-28 (cashubtc/nuts `28.md`; it was
proposed as NUT-26, a number now given to bech32 payment requests).

## The keys

Derived from the BIP-39 seed (the twelve words, no passphrase) by BIP-32,
every level hardened:

| key | path | what it is for |
|---|---|---|
| ID key `d` | `m/129373'/20'/0'/0'/0'` | the ID: payments are locked to its public half `ID = d·G` (33 bytes, compressed), blinded |
| delivery key `q` | `m/129373'/20'/1'/0'/0'` | receiving NIP-17 messages for this wallet, and nothing else on Nostr; its x-only public half (32 bytes) is the Nostr key |
| paying key | `m/129373'/20'/2'/0'/0'` | this phone's own throwaway keys for what it pays to other IDs (below); never public |
| recovery key | `m/129373'/20'/3'/0'/0'` | the copies this phone sends itself of what it pays (Restoring, below); its x-only public half is the only address they go to, in no string, never shown, and used for nothing else |

129373' is the purpose NUT-13 gives P2PK keys; a payment request's lock keys
are its account 10' (`m/129373'/10'/0'/0'/i`), and 20' is the Cashu ID's. A
restore from the words gives the same keys and so the same ID string. The
private halves stay in native code (`SEED-HANDLING.md`).

## The ID string

`foxyid1` followed by base64url, no padding, of 134 bytes (version 2):

| bytes | |
|---|---|
| 1 | version, `02` |
| 33 | the ID public key, compressed |
| 32 | the delivery public key, x-only |
| 64 | the ID key's BIP-340 signature over SHA-256(`"foxy-cashu-id-bind-v1"` ‖ ID ‖ delivery key), made with all-zero auxiliary randomness so the string is the same every time |
| 4 | checksum: the first four bytes of SHA-256 of the bytes before it |

186 characters in all. A string whose checksum does not match, or whose
signature is not the ID key's over its own delivery key, is refused: "That is
not a Cashu ID." A version above 2 is "from a newer Foxy"; both keys must be
points on the curve. Version 1 (70 bytes, no signature, 101 characters), which
early test builds showed, is refused the same way, pasted or scanned: nothing in
it says the delivery key is the ID's own. So a contact's address changes only by
a string the ID key signed. For example, the ID of the words `abandon … abandon
about` (the tests' phone), whose keys are
`ID = 0365233b8ef683341a31e9cd29dcbc2612c5f4e07bb5dbad2d2e7d64fefc0bd896` and
`nostr = 666dc8e5c853e51553d257ee7af3626b26c9e11d3db11ae8048d14f778f20dba`:

    foxyid1AgNlIzuO9oM0GjHpzSncvCYSxfTge7XbrS0ufWT-_AvYlmZtyOXIU-UVU9JX7nrzYmsmyeEdPbEa6ASNFPd48g26EPOPUFyYCy9xZzTbsvViIhV2HDzAJDNeGcYIGblEp2iMep1sFKXAuXUXqKl1GLigDLYZscBObqRIv-AtDSG9YJyYCL4

**Why not a NUT-18 payment request.** cashu-ts can encode a static request
(no amount, `nut10` P2PK to the ID key, a Nostr transport to the delivery key's
nprofile with its relays, extra transport tags), and Foxy reads and pays those
already. What NUT-18 cannot say is *blind it*: NUT-28 removed its payment
request flag (cashu-ts 3.5.0, "removes Keysetid and NUT-18 flag"), and nothing
replaced it. A wallet handed a static P2PK request locks to the key it names,
as it is. Every payment from such a wallet would be locked to the ID key itself,
which the mint then sees at every claim (every payment to one person linked),
and the ID key would become a lock key, which this design never lets it be.
Until NUT-18 can carry "blind the keys", the ID stays `foxyid1`, and a wallet
that is not a Foxy has no way to pay a Cashu ID now: the one-time request that
served it (below, "Any wallet") has no screen, so nothing shows it.

## Paying

The payer, holding the contact's `ID` and delivery key:

1. **A refund key** `R`, a fresh lock key from the payer's own seed-derived
   pool (`takeLockKey`), its index `i` kept on a row of its own.
2. **A locktime** `T`: the day thirty days on, at a random second of it (the day
   start of now + 30 days, plus 0 to 86,399 s), so a mint reading it at the
   claim is not told when the payment was made to the second.
3. **The throwaway keys**, from the seed (`cashuIdEphemeral`): native answers
   `base = HMAC-SHA256(paying key, "foxy-cashu-id-e-v1" ‖ ID (33) ‖ i (4, big-endian) ‖ T (8, big-endian))`,
   and piece `j`'s key is `e_j = SHA-256(base ‖ j as 2 bytes)`, once more with
   `0xFF` appended if that is 0 or not below `n`. A fresh one for every piece,
   as NUT-28 asks. The same words, the contact, `i` and `T` give them again.
4. **The blinding**, exactly cashu-ts's, per piece with `E_j = e_j·G`:

       Zx = x(e_j·P)                       the 32-byte x coordinate of the shared point
       r  = SHA-256("Cashu_P2BK_v1" ‖ Zx ‖ slot)     plain prefix, one slot byte;
                                           if r = 0 or r ≥ n, once more with 0xFF appended
       P′ = P + r·G

   with the ID at slot 0 (the lock key, `data`) and `R` at slot 1 (the refund
   tag), the order `[data, …pubkeys, …refund]`. The secret is an ordinary NUT-11
   P2PK secret, `["locktime", T]` and `["refund", R′]`, and `E_j` goes on the
   proof as `p2pk_e` (`pe`, 33 bytes, in a V4 token). cashu-ts strips it before
   any request leaves for a mint.
5. **The name, proved** (only once this phone's own ID is in use: shown, or its
   words restored): `tag = SHA-256("foxy-cashu-id-from-v1" ‖ x(d_payer·ID) ‖ E)`,
   worked out natively (`cashuIdTag`), `E` one of the pieces' E.
6. **Deliver**, NIP-17 gift-wrapped to the delivery key over Tor (`nostrSend`,
   the road a NUT-18 payment and a till's cashier take), to the three relays the
   receiver's inbox listens on. The message:

       { "v": 2, "type": "foxy-cashu-id", "token": "cashuB…", "E": "<66 hex>",
         "from": "<the payer's ID, 66 hex>"?, "tag": "<64 hex>"?, "note": "<at most 140 characters>"? }

The payer's history row says `To <name>`. The token goes into the outbox
(`foxy.cid.outbox`, written as money is) before it is sent, with `E`, the
refund key, its index and its row. The confirmation says once: "If <name> has
not collected it in 30 days it comes back to you, here or wherever your words
are restored." It does not promise when it arrives.

A mint that does not say it honours a lock (NUT-11) is refused before anything
is made, as the till refuses one.

**Other wallets.** NUT-28 needs nothing of the mint, and any wallet that has
the ID's key and blinds as cashu-ts does can pay it, by Foxy's envelope or by a
NUT-18 `PaymentRequestPayload` (`{ id?, memo?, mint, unit, proofs }`) wrapped to
the delivery key, with `E` on each proof and no locktime or refund needed.

## Receiving

The receiver's phone listens on the delivery key, NIP-17 gift wraps (kind
1059) from thirty-two days back (the thirty a payment waits, and NIP-59's two
of backdating), page by page (500 to a page, up to eight, each reaching back
from the oldest of the last with `until`), while Foxy is in front, and only
once the ID is in use on it: MY CASHU ID shown, or its words restored. For each
delivery:

1. **Read and bounded**: at most 64 kB and 100 pieces, a token in sats or
   dollars at a mint address Foxy would use, every piece a P2PK secret with an E
   that is a point and a DLEQ, no piece named twice, none taken before
   (`foxy.cid.seen`, by a hash of each secret). Anything else is dropped before
   anything is written.
2. **At a mint this phone uses**: the one it is on, its home, every mint it has
   connected to or used, the till's. A delivery at any other mint, in sats or
   dollars, is its receiver's to decide (below).
3. **The mint's own ecash**: its keys (fetched when they are not here; a mint
   that does not answer is asked again no sooner than a minute later, then two,
   four, and never more than once an hour), the unit's keysets, and every
   piece's DLEQ verifying.
4. **Signed by the phone** (`cashuIdSign {pieces: [{secret, e}]}`): for each
   piece, native works out `r₀` from `d·E` and its lock key: `d + r₀` where
   `data = ID + r₀·G`, `−d + r₀` where `data = −ID + r₀·G` (a payer that blinded
   the other parity); any other key refuses the whole request. It signs SHA-256
   of each secret by BIP-340. The one-time key never leaves native code: a page
   that chose its own E knows `r₀`, and from the key would have `d = k − r₀`.
5. **Locked to that key alone**, by cashu-ts's own reading of the secret
   (`onlyLockedTo`): no other key, no SIG_ALL, and any locktime at least a day
   out.
6. **Named only when proved**: `from` is believed only where `tag` is the one
   this phone works out from its own `d` and `from` (`cashuIdTag`) and `from` is
   a contact; the history row says `From <name>`, otherwise `From a Cashu ID`.
7. Taken in as any locked ecash that arrives signed for (`receiveToken`), with E
   removed: swapped at its own mint, at once. A mint of this phone's that it is
   not on is swapped there by a wallet made for it, the phone staying where it
   is, and the money stays at that mint until it is moved (TRANSFER).

With no route, or while a mint's keys are to be fetched, a delivery at a mint
this phone uses whose every piece has a locktime more than a day out is kept
(`foxy.cid.inbox`, fifty and a megabyte at most) until a day before its
locktime, and taken when it can be. One with no locktime is not kept: the
relays still hold it and it is read again on the next listen. The same delivery
twice, from three relays or a resend, is one receipt.

## Receiving from a mint you don't use

The payer cannot know which mints the receiver uses, so the receiver decides
(`cidForeign`). With a route, within a cap of five such deliveries an hour that
make this phone ask a mint it does not use anything (`foxy.cid.foreign`, kept
across a restart), and outside that mint's backoff:

1. its keys are fetched and every check above is made by them; a mint whose
   keys do not come, whose keysets do not hold the pieces or whose DLEQs do not
   verify (a fake one) is backed off and nothing is taken or kept;
2. the way home is quoted before anything is signed (`cidHomeQuote`): an
   invoice of the default mint for what would land, that mint's melt quote for
   it, and both mints' fees for the pieces, stepped down until the whole cost
   fits inside the payment (and everything else waiting at that mint in the same
   unit), with nothing taken;
3. a card asks (`cidOfferCard`, in the app's card style), and nothing is signed
   until it is answered:

       PAID AT ANOTHER MINT
       Carol sent you 300 sats at forge.flashapp.me, a mint you don't use.
       [ ] Always do this for forge.flashapp.me
       BRING IT HOME
         fee about 10 sats
       KEEP IT THERE
       SEND IT BACK
       DECIDE LATER

   The amount is in the delivery's unit ("$3.00"), and the name is the
   contact's where the payer proved it (above), "A Cashu ID" otherwise. Under
   BRING IT HOME is the fee the way home was quoted at, in the delivery's unit,
   and what it lands as where that is another unit ("fee about $0.06 · lands as
   3,875 sats"). With more waiting at that mint in that unit the card says so
   ("One more payment waits there, $4.50 in all: BRING IT HOME brings them
   together"), and the fee is for the whole.

- **BRING IT HOME** takes the pieces at that mint (signed for, swapped in by a
  wallet made for it, the phone staying where it is) and carries the sum to the
  default mint as one payment (`bringHome`, the carry-home job, `MONEY.md` §7):
  sats as sats; dollars melted at that mint into Lightning and minted at the
  default mint as **dollars** where it issues them on an active keyset (at that
  mint's rate), as **sats** where it does not. The row at home says what left
  and what landed: `From <name>, came home from <mint>, fee <x> sats` for sats,
  `From <name>, came home from forge.flashapp.me as 3,901 sats, fee $0.06` or
  `… as $2.94, fee $0.09` for dollars; the fee is what was taken, less any
  change of the route's reserve (which stays at that mint, this phone's), less
  what landed was worth there. A walk home that fails after the take (a mint
  did not answer) or after the melt (the claim did not come) is finished on the
  next launch, connection or return (`carryResume`, `finishMove`), in the unit
  it lands in; the money is this phone's at that mint meanwhile and is never
  thrown away. A crossing that was paid and never claimed is dropped an hour
  after its invoice is still unpaid (`finishMove`): a fake mint that says it
  paid ends with nothing kept.
- **KEEP IT THERE** takes the pieces at that mint, and that mint is one this
  phone uses from then on (`cidUseMint`: in its mint list, on SWITCH MINT like
  any other, off `foxy.cid.brought`). What comes there later is taken as at any
  of its mints, with no card, and so is anything else waiting there.
- **SEND IT BACK**, shown only where the delivery's `from` is proved by its tag
  and this phone knows where to send it (the ID is a contact, or one it has paid
  before: `cidBackTo`), takes the pieces at that mint and at once pays them back
  to the sender's ID as a payment to a contact, at the same mint (`cidPay`: a
  one-time key, a locktime, a refund key, a copy to this seed's recovery key),
  for what was taken less what that mint charges to make it. No crossing and no
  fee beyond the mint's own. Its rows: `From <name>, sent back` and `Sent back
  to <name>`. A pay-back that fails after the take leaves the money at that
  mint, this phone's, and the mint is then one it uses; the row says
  `From <name>, kept at <mint>: it could not be sent back`.
- **The tick** ("Always do this for <mint>") remembers the answer for that mint
  (`foxy.cid.choice.<host>`: `home`, `keep` or `back`), and a remembered answer
  runs with no card. BRING IT HOME remembered is what every such delivery did
  before there was a card; SEND IT BACK remembered for a payer this phone
  cannot send to asks instead. SETTINGS > OTHER MINTS, there only while an
  answer is remembered, lists them and forgets one, or all: the next payment at
  that mint asks again.
- **Doing nothing**: the card closes (DECIDE LATER, or a tap outside) and the
  delivery waits (`foxy.cid.offers`, at most ten, a quarter of a megabyte),
  unasked again, in no balance, listed in HISTORY as a pending row `From
  <name>`, "At <mint> · tap to decide"; tapped, the card opens again. It is
  dropped a day before its locktime, when its payer may have it back.

**Too small, or no way home.** A delivery smaller than its crossing's fee (the
quote leaves nothing to land) shows the same card with BRING IT HOME grey and
the reason under it ("Too small to bring home: the fee would take all of it."),
so KEEP IT THERE and SEND IT BACK remain. With BRING IT HOME remembered it waits
with no card, and a later delivery at the same mint in the same unit is quoted
with every one waiting there: when the whole is worth crossing they all come
home together. A way home that cannot be quoted backs that mint off; the card
shows BRING IT HOME grey with why, and a remembered BRING IT HOME takes nothing
(the relays still hold it, and it is read again on the next listen). A mint
first met by bringing a payment home from it, or by sending one back, is in this
phone's lists from that visit and is still not one it uses: what comes there
later asks again, or runs the remembered answer.

**For other arrivals.** `FoxyWallet.bringHome({ mint, unit, amount, toUnit?, name?,
hash?, before? })` carries money this phone already holds at a mint it does not
use home by the same job, dollars or sats, and `bringHomeQuote(mint, unit,
amount, pieces)` prices it first; a till's or another cross-mint arrival can
use the two as they are.

## Any wallet

MY CASHU ID shows its code with SHARE and DONE; it has no ANY WALLET button, and
the screen that button opened is gone, so a wallet that is not a Foxy has no way
to pay a Cashu ID until something shows the request again. What stays is the wallet's half: for a
payer whose wallet cannot blind (Minibits, Cashu.me, any wallet that reads a
NUT-18 request), `cashuIdAnyRequest` (`cidAnyRequest`) makes a standard payment
request, and a payment to it comes in by the ID's inbox as ever. Its fields, as
cashu-ts encodes them (`creqA…`):

| field | |
|---|---|
| `i` (id) | 8 hex characters, random, new at each opening |
| `a` (amount) | none: the payer chooses |
| `u` (unit) | the balance the phone is in (`sat`, or `usd` where it holds dollars), dollars first where it holds both |
| `m` (mints) | this phone's mints that issue the unit and honour a lock (NUT-11), the default first, then the one it is on and the others it has connected to; five at most |
| `s` (single use) | true |
| `nut10` | `{ k: "P2PK", d: <key>, t: [] }`: a **fresh key from the seed-derived lock pool** (`takeLockKey`, account 10', as a receive request's), filed as `cid-any-<id>`; never the ID key |
| `t` (transport) | one: Nostr, `[["n", "17"]]`, to the nprofile of the ID's **delivery key** naming the three relays its inbox listens on (`NostrDelivery.fallbackRelays`) |

Each opening takes a new key, so no two codes lock to the same one and the mint
sees each key at one claim. Opening it puts the ID in use (the phone listens).
A payment comes to the ID's inbox as a NUT-18 `PaymentRequestPayload` with no
E, every piece locked to one key of this seed's; it is taken (`cidPoolTake`) as
any ecash locked to this phone (`receiveToken`, at its own mint where that is
another of this phone's), once per delivery (`foxy.cid.seen`), and its history
row says "From another wallet". A code paid a second time (a stale key) is
taken again: the row `cid-any-<id>` stays once paid (it is not dropped as a
request's is), so a second payer's payment is found by it. A key no row names,
after a restore from the words, is found by walking the lock path
(`lockKeyMatching`), at most five such walks an hour (`foxy.cid.walks`). A
payment at a mint this phone does not use is refused: the request names only
its own. With no route it is not kept: the relays still hold it, and it is read
again on the next listen.

What it costs beside the ID: the code names the delivery key and the relays, so
anyone holding it can tell a payment to it reaches the same inbox as a payment
to the ID; and the payer sees an ordinary lock key, as for any request.

## Paid to the ID key itself

A payer that locks to the ID as it is (its `data` the ID's x, either parity, no
blinding: a wallet handed the ID's key with no word to blind it) shows the mint
the ID at the claim, and every such payment is then linked there. The phone
signs nothing for it by itself (`cidBare`). After the delivery's shape and its
mint (one this phone uses) are checked, the card asks, once a page load for each
delivery (`_onCashuIdUnblinded`):

    PAID TO YOUR ID KEY
    <name, or Someone> paid you without blinding the key. Taking it would let
    the mint link your payments together.
    LEAVE IT
    TAKE IT ANYWAY

- **LEAVE IT**, the default, takes nothing and says nothing; the delivery is
  noted as left (`foxy.cid.left`) and not asked again. Where it carried a
  locktime and a refund key, its payer has it back after the locktime.
- **TAKE IT ANYWAY** has the ID key itself sign for that delivery's secrets
  alone, by an action of its own (`cashuIdSignUnblinded`, which signs only
  secrets locked to the ID as it is and logs every signing), and takes it as
  any receipt; the history row says "From <name>, unblinded" ("From someone,
  unblinded" for a payer that did not prove who it is).
- Closed with neither, nothing is decided: it is asked again the next time Foxy
  reads it.

The name is a contact's only where the payer proved it as above (`tag`, with
its E on a piece). A delivery mixing pieces locked to the ID itself with others
is refused, and one at a mint this phone does not use is refused. A blinded
delivery never shows the card.

## The payer's outbox

- **Sent** only once a relay has said OK.
- **Copied**, once a relay has taken it, to this phone's own recovery key
  (Restoring), one to thirty minutes later at a random moment, never with the
  payment. A payment collected before its copy is due sends none. Until then it is tried once a
  minute (every quarter of an hour after thirty tries), and at once when the
  route comes back: the till's outbox rules.
- **Sent again** once a day while the mint says its pieces are unspent and
  the locktime has not passed.
- **Collected** when the mint says every piece is spent: the row is done and
  the history row settles.
- **Back** after the locktime, with pieces still unspent, whether or not a
  relay ever took it: the payer's refund key (found again from the words if its
  row has gone) opens each piece's blinded refund key and signs, and they are
  swapped in. The mint refuses the refund key before the locktime (NUT-11), so
  nothing can take back money the contact can still collect. The history row:
  "Came back: <name> did not collect it".

**Restoring.** The words do not bring storage back, so the outbox is copied
where the words can find it. Once a relay has taken a payment, a copy of its
row (the token, `E`, the contact's ID and delivery key, the locktime, the refund
key and its index, the name) is gift-wrapped (NIP-17) to the x-only public half
of this phone's **recovery key**, `m/129373'/20'/3'/0'/0'`, to the same four
relays, after a random delay of one to thirty minutes (`cidCopyDelay`), so a
relay cannot pair the two by the second they came. The recovery key is not the
delivery key, is in no string, is never shown, and nothing else is sent to it.

A restore from the words (`cidRestored`) listens on the recovery key, thirty-two
days back, for a week (`cashuIdCopiesOpen`), and rebuilds each outbox row from
its copy (`cidCopyArrived`), once by its token: the same copy from three relays
is one row. A copy is believed only where this seed made it: its refund key is
this seed's lock key at the index it names, and every piece's E is one of the
throwaway keys this seed's paying key gives for that contact, index and
locktime, the contact's ID blinded by it at slot 0 and the refund key at slot 1.
Its public half is on every wrap a relay holds, so anybody can send it
something; nobody without the words can make a copy that passes. A copy whose
every piece the mint has as spent (collected, or brought back) is nothing to
rebuild. A rebuilt row is watched like any other: sent again daily, collected,
or brought back by the refund key after its locktime ("Came back: <name> did
not collect it"). What is lost with the phone is only a payment whose copy had
not gone yet: one no relay took, or one paid in the last half hour.

## What each party learns

| who | learns | does not learn |
|---|---|---|
| a mint | at each claim, every piece's blinded lock key and blinded refund key (`P′`, `R′`), the locktime to the day and a random second, the amounts; for a refund, `R′` signing | the ID, the refund key, the delivery key, who paid whom, or that two payments went to one ID or came from one payer: no key is seen twice |
| a mint this phone does not use, paid at | nothing until the receiver answers; then what any mint learns at a claim, and as the payment is brought home, an invoice of this phone's default mint for what lands: so which mint that is (its Lightning node), and when this phone came to collect. Sent back, a fresh payment locked as any to a contact; kept there, this phone as one of its users | the ID, or anything of other payments |
| a relay | a gift wrap for the delivery key, its size and time; when the receiver's phone listens (over Tor); how many arrive for one ID. And a wrap for the payer's recovery key for each payment not collected by then, at a random moment one to thirty minutes after a relay took the payment, and when a restored phone listens on that key | what it holds, who sent it (the wrap and seal are signed by keys made for the one message), or which payment a copy is of |
| the payer | the ID, the delivery key, the E, the blinded keys and the amounts of its own payments | anything of the receiver's other payments; it cannot open what it sent before the locktime |
| the receiver | the token, the E, the amount, the note, and the payer's ID where it proved it | the payer's other payments, or its refund key |
| anyone with the ID string | the ID and delivery keys, and that they belong together | anything paid to it |

The relays Foxy uses are its own three (`NostrDelivery.fallbackRelays`); the
nprofile the payer builds names none, so a payer sends to those three. Were the
ID a NUT-18 request, its transport would carry the relay list, telling every
holder of the ID which relays to watch for it.

**No rotation.** The ID and the delivery key last for as long as the words do;
that is the point of them, and the cost. Anyone who has the ID can send the
receiver as many deliveries as they like (each must look like money to be read
further, and those at mints this phone does not use make it ask such a mint
anything at most five times an hour), and the relays can count them. A delivery key that leaked would let its holder read
the amount, note and E of every payment to the ID, but not spend them: that
needs `d`. The ID key leaking is the words leaking.

## The screens

MY CASHU ID is the round button at the top left of home (the menu button's
twin, with a head-and-shoulders drawing) and a row in the menu's WALLET; both
open the same screen: the ID as a QR code with SHARE and DONE. Opened from home,
DONE goes back to home; opened from the menu, back to the menu. With no ID read
yet, both say NO CASHU ID and why.

CONTACTS, from the menu or from SEND, lists the contacts; a Cashu ID reads
CASHU ID, and tapping it goes to SET AMOUNT for that contact (the payment
above), from either. An empty CONTACTS says "Ask another Foxy user to share
their Cashu ID with you to add them as a contact." with ADD A CASHU ID, a card
with a field to paste the ID into (PASTE A CASHU ID, NEXT reads it as a pasted
one is), and SCAN A CASHU ID under it (the camera, then the same). Neither is
offered where the wallet cannot read an ID, and SCAN is not where it cannot
scan.

The menu, in this order, every section open until it is tapped shut:

    BACKUP ACCOUNT    only while the wallet holds a balance and the words are not verified
    WALLET            MY CASHU ID · HISTORY · CONTACTS · HIDE BALANCE
    MINTS             SWITCH/ADD MINTS · TRANSFER MONEY (money at two mints or more) · SWAP and WHAT YOU HOLD
                      (a mint with two balances) · OTHER MINTS (an answer remembered)
    TOOLS             POINT OF SALE · SPLIT A BILL
    SETTINGS          BLUETOOTH TAP · SET PIN · FACE ID LOCK · BACKUP · RESTORE · RESTORE LOST CARD · TEST LOGS

## Not built

- **Delivery over the onion.** An ID names no onion address: every onion
  address Foxy has is made for one request and ends with the visit, and a
  lasting one would be a name anyone could probe. The Nostr road is the only
  one.
- **PAY FROM** across mints: a payment to an ID is made at the mint the phone
  is on, in the balance the keypad is in.
- Rotating the ID, and more than one ID.
- A Cashu ID as a NUT-18 request: NUT-18 cannot yet ask a payer to blind the
  key (above). A proposal to add that marker is drafted, not sent. The
  one-time request (no screen shows it) was the stand-in.
- The one-time request with an amount, or across mints this phone does not use; and a
  payment to the ID key itself at a mint this phone does not use (refused).
- Messages between two Cashu IDs. A contact is paid and nothing else; a
  payment's note goes in its own envelope (above). An earlier build had them;
  this build drops their stores at its first boot (`foxy.msg.threads`,
  `foxy.msg.outbox`, `foxy.msg.seen`, STORAGE.md), and a first message an older
  Foxy sends to the delivery key is refused as no payment.
