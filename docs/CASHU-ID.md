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
| delivery key `q` | `m/129373'/20'/1'/0'/0'` | receiving NIP-17 messages for this wallet, and nothing else on Nostr; its x-only public half `Q` (32 bytes) is in the ID string, and payments go to the keys it moves to each day (the drop boxes, below), not to `Q` itself |
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
6. **Deliver**, NIP-17 gift-wrapped over Tor (`nostrSend`, the road a NUT-18
   payment and a till's cashier take) to one of the sixteen keys the delivery
   key moves to on the UTC day it is posted, picked at random, and one to five
   seconds later the same message to one of the next day's (the drop boxes,
   below), each to the three relays the receiver's inbox may listen on. The
   message:

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

## The drop boxes

A payment is never wrapped to the delivery key `Q` itself, but to one of
sixteen keys of the UTC day it is posted on, each `Q` moved by a number anyone
holding the ID string can work out (`CashuID.dropTweak`, 08e-cashu-id.js
`cidDropKey`):

    t = SHA-256("foxy-cashu-id-drop-v1" ‖ Q ‖ day (4 bytes, big-endian) ‖ j)    (once more with 0xFF appended if not 0 < t < n)
    key(day, j) = x(lift_x(Q) + t·G)

`day` is the unix time divided by 86,400, `j` from 0 to 15. The receiver opens
`key(day, j)` with `q′ + t`, `q′` being `q` or `n − q`, whichever has the even
point. The ID string does not change: `Q` is all a payer needs, and the
derivation's version is its tag (`-v1`). tests/fixtures/cashu-id-vectors.json
(`drop`) holds the page, harness.js and libsecp256k1 to the same keys.

**Posting.** The payer picks `j` at random for the day it posts, and one to
five seconds later, on a circuit of its own, sends the same message once more,
to a random key of the next day (`aheadDay`, `cidAheadAll`): seconds, so the
page is surely still awake to send it. The two wraps share no bytes (each has a
fresh seal and wrap key) and each envelope carries filler of its own random
length (`pad`, `cidPad`: none to half the token, at least 256 bytes, never
past the 32,767 bytes a send may carry, and no `pad` at all where none fits), so each
wrap's NIP-44 size bucket is drawn afresh. That blurs the size, it does not hide
it: by the NIP-44 padding rule, a wrap of a token of about 1.2 kB lands in one of
three buckets (about 4.2, 4.9 or 5.6 kB) and two wraps of it share one about a
third of the time; a small token of about 400 bytes has two buckets (about 2.5
and 3.5 kB) and its wraps share one four times in five. What pairs the two wraps
is their size and that they are seconds apart. A second wrap sent on any day
but the one before its own (the page slept between the two, even only into the
wrap's own day, when the receiver may have finished that day's listen) goes to
today's keys instead, and a new next-day wrap is set behind it. One no relay
takes is tried again as the first wrap is: once a minute, once a quarter hour
after thirty tries. The daily resend of a
payment not yet collected goes to the day it goes on, with fresh filler, and its
second wrap to the day after.

**Listening.** Every listen is the same eleven REQs of exactly 48 keys each,
covering the window (today and thirty-two days back) three days to a REQ, each
from two days (NIP-59's backdating) before its oldest day. A REQ holds the
sixteen keys of each of its days that is asked, and keys made for that REQ and
held by nobody for the rest, shuffled. The days asked are today and every day
since the last listen that finished (`foxy.cid.heard`); the whole window when
the phone has never finished one (a first listen, a restore). So neither a REQ's
size nor the number of REQs says how long the phone was away. A listen is
finished when the relay has answered every REQ to its end (EOSE, and no page
left to ask); one cut short (Foxy put away, the relay refusing a REQ or dropping
the socket with no other relay to go to) marks nothing, and the next asks the
same days. A day finished is not asked again: what was posted after the
phone's last listen of a day is found by its second wrap among the next day's
keys. A listen open across midnight (UTC) is closed at a random moment in the
new day's first hour and opened again on the new day's keys a random 0 to 60
seconds later, so one listen's end and the next one's start are not one
instant. A payer whose clock is a day behind posts to
yesterday's and today's keys, and is still heard; one a day ahead is heard a
day late.

**One relay a listen.** The REQs go to one relay of the three, picked at random,
on a circuit of its own; one that fails, drops the socket, refuses a REQ
(CLOSED), sends a NOTICE before ending them, or leaves thirty seconds without
ending the next of them or sending a wrap (`relayDeadline`, counted from the
first REQ having gone, so a slow circuit is not counted) is let go and the next
is tried. A payment is still posted to all
three, so the one asked holds it.

**`Q` itself is never asked for.** It is all a relay needs to work out every
day's keys, past and future, so a single REQ naming it would undo the drop
boxes for good at that relay. A Foxy from before this build wrapped payments to
`Q`; this build does not hear such a payment, and it comes back to its payer
(`cidWatch`) at its locktime. An ID shown before this build was asked for by `Q` at
every listen: a relay that kept those logs can tie that ID's earlier listens,
and, holding `Q`, works out its day keys too. For it, the drop boxes protect
nothing; a relay that kept no logs learns nothing from what is asked now.

**ANY WALLET keys.** Each request's key (below) is heard for a year: at every
listen in its first day, once a UTC day in its first month, once a week after
(`foxy.cid.any`: each id, when it was made and the day it was last asked). Its
keys are asked in REQs of their own, 48 to a REQ padded as above (one REQ per 48
codes due), at all three relays as a request's inbox is (another wallet may post
to only one of a code's relays, and the key is the same at each, so asking all
three tells them nothing more), a random three to thirty seconds after the day
keys. A code is marked asked only once every relay asked has ended every one of
those REQs or failed, and one has ended them (`_cashuIdAnyHeard`); Foxy put away before then asks it again at the next
listen. At most 960 codes are kept: the 961st drops the oldest, which is no
longer heard. Money paid to a code more than a year old, or one dropped so, is
not heard and is lost: it is locked to this phone's key, and the payer's wallet
has no refund unless it added one. A restore forgets every code (What a
restore loses, below).

## Receiving

The receiver's phone listens on the drop boxes (above), NIP-17 gift wraps
(kind 1059), page by page (500 to a page, up to eight, each reaching back from
the oldest of the last with `until`), while Foxy is in front, and only once the
ID is in use on it: MY CASHU ID shown, or its words restored. For each
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
| `t` (transport) | one: Nostr, `[["n", "17"]]`, to the nprofile of a **key of the request's own**, the delivery key moved by the request's id (`SHA-256("foxy-cashu-id-any-v1" ‖ Q ‖ id)`, `cidAnyKey`), naming the three relays its inbox listens on (`NostrDelivery.fallbackRelays`); the phone listens on it for a year |

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

What it costs beside the ID: the code names a key of its own and the relays,
not the delivery key, so holding it does not say which ID it belongs to; but
the key is asked for over a year (ANY WALLET keys, above), so the relays can
tie the days its REQs are asked to each other; and the payer sees an ordinary
lock key, as for any request. A code is good for a year; money paid to a code
more than a year old is not heard and is lost. No screen of the app shows an
ANY WALLET code today (MY CASHU ID shows the ID alone); a screen that shows one
again must say the code is good for a year.

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

**What a restore loses.** Beside an outbox row whose copy had not gone, a
restore loses the ANY WALLET codes this phone showed (`foxy.cid.any`: their ids
are random, not from the words, and are not in a backup). A restored phone
listens for none of them, so money paid to an old code after the restore is not
heard and is lost, as for a code past its year. Which days were finished
(`foxy.cid.heard`) is lost too, which costs nothing: the first listen asks the
whole window.

## What each party learns

| who | learns | does not learn |
|---|---|---|
| a mint | at each claim, every piece's blinded lock key and blinded refund key (`P′`, `R′`), the locktime to the day and a random second, the amounts; for a refund, `R′` signing | the ID, the refund key, the delivery key, who paid whom, or that two payments went to one ID or came from one payer: no key is seen twice |
| a mint this phone does not use, paid at | nothing until the receiver answers; then what any mint learns at a claim, and as the payment is brought home, an invoice of this phone's default mint for what lands: so which mint that is (its Lightning node), and when this phone came to collect. Sent back, a fresh payment locked as any to a contact; kept there, this phone as one of its users | the ID, or anything of other payments |
| a relay | two gift wraps for each payment, to keys of two days, their size and time; for the one picked to listen, when the receiver's phone listens (over Tor) and the 48 keys asked, among them a day's sixteen; within one UTC day, that the listens asking the same keys are one ID's. And a wrap for the payer's recovery key for each payment not collected by then, at a random moment one to thirty minutes after a relay took the payment, and when a restored phone listens on that key | what it holds, who sent it (the wrap and seal are signed by keys made for the one message), which payment a copy is of; and, from what is asked, that two days' listens are one ID's (no key is asked on two days), unless it holds the ID string (below) |
| the payer | the ID, the delivery key, the E, the blinded keys and the amounts of its own payments | anything of the receiver's other payments; it cannot open what it sent before the locktime |
| the receiver | the token, the E, the amount, the note, and the payer's ID where it proved it | the payer's other payments, or its refund key |
| anyone with the ID string | the ID and delivery keys, and that they belong together; every day's sixteen keys, so a relay handed the string ties every listen and every payment to the ID as before the drop boxes | anything paid to it |

The relays Foxy uses are its own three (`NostrDelivery.fallbackRelays`); the
nprofile the payer builds names none, so a payer sends to those three. Were the
ID a NUT-18 request, its transport would carry the relay list, telling every
holder of the ID which relays to watch for it.

### What the relays see

Before the drop boxes, every listen named the delivery key: the relays could
tie every time the phone opened, every day, to one name, the ID's whole daily
rhythm. Now, measured (`tests/attack-dropbox-2026-11-06.js`, a receive-only
phone opening about four times a day for three weeks): no key is asked on two
days, and no two days of one ID's listens share a key. What is left, plainly:

- **Within a UTC day** the listens ask the same keys: a day is one profile.
- **Anybody with the ID string** works out every day's keys. A payer can, as
  it must; a relay that is handed the string (it was shared in a chat, posted
  on a page) ties everything as before. The drop boxes keep the ID's rhythm
  from relays that do not know the ID, not from those that do.
- **A payment's two wraps**, one to a day and one to the next, go seconds
  apart; filler draws each one's NIP-44 size bucket afresh, but often into the
  same bucket (Posting, above), so size and timing together still pair them. A
  relay that pairs them can tie a paid day to the next. A day with no payment
  cannot be tied that way. A payment's daily resends carry fresh filler too, so
  their sizes vary as much, and no more.
- **An ANY WALLET key** is the same each day it is asked (a year): those REQs
  tie their days together, and relays comparing notes and watching the time can
  guess they go with the day keys' REQs a few seconds before them, so for a
  code's first month, when it is asked daily, a phone that showed one is tied
  day to day through it. A phone that never showed a code has none. (A payer
  who pays an ID daily ties its days the same way, through the wraps.)
- **IDs from before this build** were asked for by `Q` itself at every listen
  (above): for a relay that kept those logs, nothing here helps that ID.
- **Timing and Tor.** Each listen is on a fresh circuit at a random relay; the
  relays that compare notes still see when the phone is online, and with few
  Foxy phones, timing alone can tie much (THREAT-MODEL.md).
- **A payment to a day's key** tells a relay that holds no string nothing about
  which ID it is for, until that day's listen asks for the key.

**The ID does not rotate.** The ID and the delivery key last for as long as
the words do; that is the point of them, and the cost. Anyone who has the ID can send the
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
- Rotating the ID itself, and more than one ID. (What rotates is the drop box a
  payment is left in, above.)
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
