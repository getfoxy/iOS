# Tap and offline payments: the rules

What two Foxy phones say to each other over Bluetooth, and when one phone
takes ecash from another without asking the mint.

This page is for people who know Cashu. It is short on purpose and it is
written to be attacked: section 8 lists what it claims, section 9 lists what
is already known to be weak. The long form, with the reasons, is
`TAP-TO-PAY.md`. To report a break, see `SECURITY.md`.

## 1. Words

- **Receiver**: the phone showing an invoice. **Payer**: the phone paying it.
- **Online**: the phone can reach its mint right now. **Offline**: it cannot.
- **Locked**: NUT-11 P2PK to one key and nothing else (section 6).
- **Same mint**: the payer holds ecash at the mint the receiver uses.

## 2. The rules in one table

| payer | receiver | same mint | two mints |
|---|---|---|---|
| online | online | ecash over the link, locked | Lightning: the payer melts to the receiver's invoice |
| offline | online | ecash over the link, unlocked; the receiver swaps first | no payment |
| online | offline | ecash over the link, locked | no payment |
| offline | offline | no payment | no payment |

Three rules give that table.

1. **One of the two must be online.** Somebody has to swap. An online receiver
   swaps what arrives. An online payer swaps into proofs locked to the
   receiver. With nobody online, nothing settles, so nothing is sent.
2. **An offline receiver takes only locked ecash.** It cannot swap, so the
   lock is the only thing that stops the payer spending the same proofs again.
3. **An offline receiver takes nothing from a mint it does not use.** It could
   not swap, melt or move it.

## 3. The link

Bluetooth Low Energy. The receiver is the peripheral and advertises only while
an invoice is on screen. The payer is the central and never advertises.

- The service is a random 128-bit UUID, new for every invoice. The
  advertisement holds that UUID and nothing else.
- The characteristics are `SHA-256(label ‖ service)[0..16]`, with the labels
  `foxy tap v2 in` and `foxy tap v2 out`.
- The payer picks a receiver by signal strength: −33 dBm or stronger, which is
  phones touching. The receiver cannot measure the payer; iOS gives a
  peripheral no reading.

**Handshake.** Three messages in the clear. `P` and `R` are X25519 public
keys, new for every link. `Np` and `Nr` are 16 random bytes. `v` is one byte,
the version of the wire: 3.

    M1  payer → receiver    v ‖ c,   c = SHA-256("foxy tap v2 commit" ‖ P ‖ Np)
    M2  receiver → payer    v ‖ R ‖ Nr
    M3  payer → receiver    P ‖ Np          the receiver checks c

`v` is read before anything else. If it is not the reader's own version, the
link is let go and the phone says so on its screen; a receiver first answers
with `v` alone, so the payer can say the same. The labels say "v2" because
they name the handshake's shape, which is older than the version byte.

**Keys and the code.**

    th    = SHA-256("foxy tap v2" ‖ v ‖ service ‖ R ‖ P ‖ Nr ‖ Np)
    s     = X25519 shared secret
    okm   = HKDF-SHA256(ikm = s, salt = th, info = "foxy tap v2 keys", 64 bytes)
    k_rp  = okm[0..32]      receiver → payer
    k_pr  = okm[32..64]     payer → receiver
    code  = be32(SHA-256("foxy tap v2 code" ‖ th ‖ s)[0..4]) mod 10000

Both screens show `code` as four digits. The payer sees it next to the amount
before pressing SEND. Nobody is made to compare the two screens.

**Sealing.** ChaCha20-Poly1305. The nonce is a 12-byte big-endian counter, one
counter for each direction, starting at 0. The associated data is `th ‖ kind`,
where `kind` is the byte that says what the message is. A message that does
not open ends the link, and no reason is given.

**On the wire.** Two bytes of length, one byte saying the kind of message,
then the body. From M4 on the body is sealed. The kind byte is in the clear
and is bound into the seal, so it cannot be changed on the way. Before sealing, a body is padded
with a 4-byte length in front and zeros behind: an offer to 2048 bytes, a
result to 256, change to 2048, a payment to the next 4096. One message is at
most 48 KB. A larger payment goes in parts, up to 128 KB in all.

## 4. The messages

| | from | holds |
|---|---|---|
| M1–M3 | | the handshake, above |
| M4 offer | receiver | `{v:2, inv, req, up, ask, rate, at}` |
| M5 payment | payer | a NUT-18 payment, plus `changeTo` and `overpaid` |
| M6 result | receiver | `{v:2, ok, code, why}` |
| M7 change | receiver | a token for what was paid over, locked to `changeTo` |
| M8 change kept | payer | the payer has written the change down |
| M9 asking | receiver | a person is deciding; carries nothing |
| M10 | payer | words before the money: its price, "I am about to pay", "paid over Lightning", "I gave up" |
| M11 | receiver | the answer to M10: go, or no with a reason |
| M12 again | payer | "repeat what you sealed from counter n on" |

In the offer, `inv` is a bolt11 invoice and `req` is a NUT-18 request for the
same amount. `up` says whether the receiver is online. The payer picks: ecash
when it holds enough at the request's mint, the invoice otherwise.

M12 exists because iOS delivers nothing to a suspended app. The receiver
answers it by sending the same bytes again, under the same counters. Nothing
is sealed twice.

## 5. The request and its key

The request is plain NUT-18: an id, an amount in sats, one mint, single use.
Its `nut10` field names a P2PK key when two things hold: the receiver's mint
supports NUT-11, and the receiver has a key ready. Otherwise the request goes
out with no key, and an offline payment to it is not possible.

The key is derived from the seed at NUT-13's P2PK path,
`m/129373'/10'/0'/0'/{index}`, one index for each request. The private half
is asked of the phone only when there is ecash to open with it. So locked
ecash already in hand can be opened from the twelve words. NUT-09 restore
cannot find it, because the payer made the blinding factors.

## 6. What "locked" means here

A proof counts as locked to the receiver only if all of these hold:

- the secret is `["P2PK", …]`, not HTLC;
- the keys NUT-11 says can sign it are exactly one, and it is the request's
  key (compared by x coordinate);
- there is no `locktime` tag at all, so no refund path;
- it needs one signature and is not `SIG_ALL`;
- it carries a DLEQ (NUT-12) that verifies against a keyset this wallet
  already holds.

A payment counts as locked only when every proof in it does. cashu-ts answers
the NUT-11 questions; Foxy does not parse the tags itself.

## 7. What the receiver does with a payment

Before anything else it checks: the request is one it has open; the mint is
the request's mint and its own; the unit is sats; 1 to 500 proofs, none
repeated; the sum, less the input fees it will pay to swap (NUT-02), covers
the amount; no proof carries a DLEQ that fails.

Then:

| receiver | payment | what it does | when it answers 200 |
|---|---|---|---|
| online | locked | writes it down, swaps at once | before the swap |
| online | not locked | writes it down, swaps at once | only after the mint has swapped it |
| offline | locked | writes it down, swaps when next online | at once |
| offline | not locked | refuses with 422 | never |

"Writes it down" means the token is in storage that outlives a force-quit
before the payer is told anything.

**What the payer does with the answer.** 200: it forgets its copy. 422: a
refusal (below). 409, 504 or silence: it keeps the token and asks the mint
(NUT-07) whether the proofs were spent.

**A refusal.** Once ecash has crossed, the other phone has seen it, so "no"
has to be more than a word.

- *Ask first.* Before any ecash is made, the payer says on M10 what it is
  about to send: the amount, the mint, locked or not, the keyset. The
  receiver answers go or no on M11. Every honest refusal happens here, with
  nothing sent.
- *An online receiver hands it back.* If it must still refuse unlocked ecash
  it was handed, it swaps it and sends the same value back, locked to
  `changeTo`.
- *Otherwise the payer treats it as seen.* With no refund in ten seconds the
  payer marks those proofs as at risk and swaps them for fresh ones as soon
  as it is online. If the mint says they are spent, the entry becomes a
  payment.

**Paying over.** An offline payer cannot swap, so it pays with pieces it has
and may pay too much. It sends a key of its own, `changeTo`. An online
receiver swaps and sends the difference back over the same link, locked to
that key. An offline receiver is never paid over: it could not make change.

**The payer's receipt.** A payer that locked its ecash keeps the pieces. Once
the mint says they are spent, the payer asks for the signature they were
spent with (NUT-07 returns the witness), checks it against each piece, and
keeps it. Only the holder of the request's key could have made it, so it is
proof of who took the payment, in a form that can be handed to somebody else.
The person can delete it. A payment that was not locked has no such proof.

**Spending it again while still offline.** A receiver that took locked ecash
offline can pay with it before it has swapped. It signs each proof
(`SIG_INPUTS`) and hands the proof and its signature to somebody who is
online and swaps at once. It keeps a list of what it has signed away and will
not sign the same proof twice.

## 8. What we claim

Break any of these and we want to hear it.

1. **An offline receiver that answers 200 is never out of pocket to the
   payer.** The payer cannot spend, take back or let lapse what it handed
   over. Only the mint failing costs the receiver money.
2. **A phone in the middle gets one guess in 10,000.** With the commitment in
   M1, neither side can choose a key after seeing the other's, so the digits
   cannot be ground.
3. **Listening gives nothing.** Someone recording the radio learns that a
   payment happened, roughly how big the ecash was (4 KB buckets), which
   version of Foxy the phones run, and which kinds of message crossed. Not
   the amount, the mint, the invoice or a proof.
4. **A sealed message cannot be replayed** into another link, or into the same
   link at another place, **or passed off as another kind of message.**
5. **The payer never loses its only copy.** It forgets a payment only on a
   200, and the receiver gives a 200 only after the token is written down.
6. **A payment cannot be counted twice.** A request is paid once; the same
   proof twice in one payment is refused; ecash already held is not kept
   again.
7. **Two requests cannot be linked by their keys.** Each has its own key, and
   the mint sees a key only when the ecash locked to it is swapped.

## 9. What we know is weak

- **Nobody is made to compare the four digits.** A phone in the middle can
  run one handshake with each side and hand the payer its own request for the
  same amount. The two screens then show different digits. If neither person
  looks, the payer pays the wrong phone. The receiver's screen never says
  paid, so the receiver is not fooled, but the payer's money is gone.
- **The handshake is open to anyone in range.** Any device that speaks M1 to
  M3 is given M4: the invoice and the request, which is the amount, the mint
  and the one-time key. The receiver cannot tell how far away that device is.
- **Signal strength proves nothing.** It is the payer's own app choosing the
  nearest phone. A relay defeats it.
- **An older Foxy cannot be told to update.** A phone from before the version
  byte stops at a newer payer's first message and says nothing, so the newer
  payer sees only a phone that went quiet. From version 3 on, both phones say
  why.
- **An offline receiver cannot give locked ecash back.** If it refuses a
  payment that is locked to it, only it can ever move that ecash, and it
  cannot swap. Asking first is the only thing that prevents this.
- **A cheating receiver can refuse and then redeem.** It says no to unlocked
  ecash and swaps it once the payer has gone. The payer is warned on the
  spot; the loss is that one payment.
- **An offline receiver trusts what it cached.** It checks DLEQs against
  keysets it fetched earlier and trusts its saved copy of the mint's NUT-11
  support. A keyset it has never seen means a refusal, not a guess.
- **The mint sees two swaps close together**: the payer's, into locked proofs,
  and the receiver's, out of them, for the same amount. Between two online
  phones they are seconds apart.
- **The signed-away list lives on the phone.** A phone restored from its
  twelve words has lost it. The worst case we see is a second person being
  handed a proof the mint then refuses, which is why such proofs go only to
  somebody online.
- **Both phones offline is refused, not solved.** There is a switch that lets
  the person receiving accept unlocked ecash as a stated risk. It is off.

## 10. Questions

1. Is there a tag, a NUT-10 kind or a secret shape that passes section 6 and
   still lets the payer, or anyone but the receiver, spend the proof?
2. Is a valid DLEQ against a cached keyset enough to call a proof "signed by
   this mint" offline? What does a mint rotating keysets do to that?
3. Should the four digits be enforced, for example the payer types the
   receiver's digits above some amount? Is there a way to bind the link to
   the two phones that needs no one to read anything?
4. The request's key is a non-hardened child at the last level. The chain
   code never leaves the native side. Is that enough?
5. Is "the receiver swaps at once" a privacy cost worth paying, against
   holding locked proofs for a random while?

## 11. Where it is in the code

| | |
|---|---|
| Handshake, keys, sealing, padding | `Foxy/Bluetooth/TapCrypto.swift` |
| Message order and counters | `Foxy/Bluetooth/TapSession.swift` |
| Radio, signal strength, timers | `Foxy/Bluetooth/TapLink.swift` |
| The payer's rules (section 2) | `handoverRefusal`, `build/wallet/07-request-delivery.js` |
| The receiver's checks (section 7) | `readPayment`, same file; `_requestPaid`, `build/wallet/20-helpers.js` |
| What "locked" means (section 6) | `onlyLockedTo`, `build/wallet/00-header-and-mint-errors.js`; `mintSigned`, `build/wallet/02-dleq-lock-holds-imports.js` |
| The request's key | `Foxy/Keychain/P2PK.swift` |
| Tests | `tests/handover-rules.js`, `tests/offline-accept.js`, `tests/spend-offline.js`, `tools/live/tap-scenarios.js`, `FoxyTests/` |
