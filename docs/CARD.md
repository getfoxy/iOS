# Card

What Foxy does with a card: a chip card that holds ecash and pays a Foxy by a
tap and a PIN. This file is the phone's side: set-up, the PIN, adding money,
paying at a till, change, the daily limit, a blocked card, and what the person
sees. The card's own side, the applet and its commands, is in the card
repository, https://github.com/getfoxy/card (start with its `FORK.md`; the
protocol is `docs/FOXY-CARD-SPEC.md` and `docs/FOXY-CARD-DAILY-LIMIT.md` there). This file
does not repeat the protocol. The limits are listed at the end and argued in
`THREAT-MODEL.md`.

## State of it

- **Almost nothing has run on a real card.** One phone and one card have been
  tested together: a card set up, loaded, paid from, and given its change back
  over NFC. Everything else here has been driven against a model of the card
  and against the applet running in a JavaCard simulator, which cannot show
  torn writes, memory limits or how long a tap really takes. That includes what
  was built after that run: the paged read of the pieces (`GET_PIECES`), a
  payment with no key proof, the progress lines on the sheet, loading like a
  cash drawer, SWITCH TO a mint, taking a card payment with no connection, and
  letting the card go before the mint is asked (with the put-back tap when the
  mint refuses), the two-tap payment that signs at most two pieces, and the
  withdrawal that keeps what a cut-short tap signed. The list of what only a
  card and a hand can show is
  `DEVICE-TESTS.md` §23.
- **The time the card is told is interim, and weak** (*The time*, below).
- **A card is cash.** Lose it and the money on it is gone. Whoever has the card
  and its PIN has the money, up to the daily limit if there is one.
- No independent review or audit has covered the card code. Do not put on a
  card what you would not carry in cash.

## What a card is

A card holds up to 64 pieces of ecash, each locked to the card's own key, and
the card signs a spend of a piece only when the right PIN has been given. It
also keeps its PIN, the address of the one mint its pieces are at, an owner's
public key, a clock, and a daily limit. It has no battery and no network.

The receiving phone does the rest. It asks the card to sign, takes the
signatures to the mint, swaps the pieces for ecash of its own, and says paid
only when the mint has given it those pieces. A copied or pretend card gains
nothing from this: the receiver always asks the mint first.

- **One mint per card.** The mint is written on the card at set-up. A payment
  to a phone that is at another mint stops at A DIFFERENT MINT, with nothing
  taken. A mint whose address is longer than 80 characters cannot be used. To
  use a card at another mint, take everything off it first. A card that holds
  money cannot be switched: ADD FUNDS says to withdraw all of it. On an empty
  card, the owner's phone is offered SWITCH TO <its mint> there, and the card's
  record is rewritten in the tap that writes the funds; the PIN, owner, limit
  and time key stay as they were. Moving the money across by Lightning, with a
  card that still holds it, is built and tested at two local mints, but the app
  has no button for it.
- **Cards are cash only.** A card set up so that the phone that loaded it can
  take its money back after a date, if the card is lost, is built and switched
  off (`FC_RECOVERABLE` in `build/app/26f-flashcard.js`). Nothing in the app
  offers it.
- **Foxy speaks only to its own applet.** The phone selects the applet by its
  whole name and carries a fixed list of its commands. The page cannot send
  anything else to a card, and a bank card held to the phone is not read.

## Who holds what

- **The holder** has the card and its PIN.
- **The owner** is the phone that set the card up. The owner key is worked out
  inside the app from the twelve words and the card's public key. Its private
  half never leaves the native side: the page is given the public half and
  signatures, nothing else, and only five kinds of signature are made. A holder
  with no phone of their own has a card set up on a friend's phone, and that
  phone is then the owner.
- **The receiver** is the phone being paid. It sees the PIN, because the PIN is
  typed on it.

Only the owner can change the card's PIN or limit, unblock it, or add money
without the PIN. A phone restored from the same twelve words is the owner too.
If the words are lost, the PIN and the limit on the card can never be changed.

## What it takes

Reading a card needs the NFC Tag Reading capability, which Apple gives only to a
paid developer team. It is not in the project by default: a free team cannot
sign it, and a build that claimed it would not install. A paid team sets
`FOXY_ENTITLEMENTS=tools/flashcard.entitlements` in `local.env` and regenerates
the project (`BUILDING.md`). Without it Foxy builds and runs as before, and
every card screen says NO CARD READER. The simulator has no NFC; in simulator
builds only, it reaches a stand-in card over the Mac's loopback, which can be
the real applet running under jCardSim (`FORK.md` in the card repository).

## Setting up a card

1. MENU, then FLASHCARD. It goes straight to Apple's sheet, with no screen of
   Foxy's first. Hold a new card to the top of the phone.
2. The card's screen reads `This card is new. Give it a PIN to put money on it.`
   Press **SET UP THIS CARD**.
3. **CHOOSE A PIN**, four to eight digits, then **TYPE IT AGAIN**. The PIN pad
   is the lock screen's.
4. The notice, titled SET UP THIS CARD: `This phone can reset this card's PIN
   and limit. Whoever holds the card and this phone's seed phrase holds its
   money.` CONTINUE or CANCEL. It is the one place that says what making this
   phone the owner means.
5. One tap writes the PIN, then the card's record (this phone's mint and the
   time key), and last the owner key. The owner goes in last so that no step
   needs a proof; a set-up cut off anywhere is finished by the next set-up tap.
6. **THE CARD IS READY**: that it is cash, that whoever has the card and its PIN
   has the money, and that if the card is lost the money on it is gone.

No limit is asked for and none is suggested. A new card has none.

A card with no owner is open while it is empty, because there is nothing on it
to protect, and it cannot be loaded. A card with an owner is its owner's, empty
or not: a terminal that has the PIN and empties a card cannot then claim it.

## The PIN

Four to eight digits. The card's PIN is not Foxy's PIN. It is typed on the same
pad because that is the pad a person knows; it is held for the length of one
flow, passed to the card, and never stored or logged.

Three wrong PINs in a row block the card. After a wrong one the screen says
how many tries are left and that nothing was taken, and on the last try that
one more blocks the card.

The PIN is typed on the receiver's phone and goes to the card in the clear over
the few centimetres between them. Anyone running a till, or holding a phone
altered to look like one, sees it.

## Adding money

**ADD FUNDS** on the card's screen.

1. The amount, on the app's own SET AMOUNT screen, dollars first and sats under
   them.
2. On the owner's phone no PIN is asked: the card is given the owner's proof and
   lets the money in for that tap. On any other phone, CARD PIN, and the button
   `ADD $2.00 TO CARD`.
3. The wallet swaps from its own pile at the mint into ecash locked to the card's
   key, cut like the float in a cash drawer, and never into the small change the
   rest of the wallet keeps. Every power of two from 1 up to the largest that
   fits is on the card at least once, and the rest of the amount comes after
   them in powers of two. Pieces cut that way make any price up to the whole
   balance exactly, which is what a till with no connection needs: it cannot
   make change, so it takes only an exact set (*Paying with no
   connection*). Online, a payment overpays with the fewest pieces instead, and
   the change comes back at a second tap (*Paying at a till*).

   One of each rung makes one exact payment: the payment takes the rungs its
   price is made of, and the next price needs some of the same. So the drawer is
   cut deep where the load allows, like a till's: a load is at most thirty-two
   pieces, half the card's 64 places, and keeps at least a dozen places free
   besides, so that an online payment's change always has somewhere to go.
   Whatever places a load has left after the drawer and the rest go to more of
   the smallest rungs, three of each where there is room and two where not.
   2,000 sats is 1 to 512 once, two more of each of 1 to 128, and 256, 128, 64,
   16, 2 and 1: thirty-two pieces. 11,000 sats is a whole drawer to 4096 in
   thirty-one. An amount that is more than a full drawer can hold in the places
   there are has fewer rungs, the biggest taken off first, and the big pieces
   carry the rest; such a card is not exact for every price. An amount that is
   more than the places even with no drawer is rounded up, smallest pieces
   first, and the screen says by how many sats. No piece is larger than the
   mint's own largest key.

   A card that holds pieces already is cut for: the sizes it lacks are filled
   first, the smallest first, then the rest of the amount, then the smallest
   rungs deepened with what is left of the places. The same goes for change
   written back (*Change*) and for money moved on from another mint, so a card
   keeps its drawer as it is spent from. The pieces are written down on the
   phone before the tap, as every swap here is.

   The cost of a deep drawer is pieces: taking everything off a card signs
   every one, most of a second each, which is longer than a person holds a
   card. A withdrawal cut short keeps what the card signed, and the next tap
   takes the rest (*Change PIN, withdraw, and a blocked card*).
4. A tap writes them, and reads them back. The screen says `GETTING IT READY`
   while the swap runs, then the states of a tap. **ON THE CARD** gives the new
   balance.

If the card leaves early, or the tap is cut short by Foxy being put away, the
pieces wait on the phone. The card's screen shows a line in the warning colour, `₿500
is waiting to go onto this card. Press here, then tap it.`, and the next tap
writes them. Putting money on a card does not touch its limit. THE CARD IS FULL
if it has no room for the load: take some money off it first.

## Paying at a till

On the receiver's phone: RECEIVE, an amount, then **CARD**, beside TAP.

1. **CARD PIN**, titled with what is to be paid: `To pay $0.43 (₿500). The
   card's owner types its PIN here.` The button reads `PAY $0.43` and stays grey
   until four digits are in.
2. Apple's sheet asks for the card. The card is read in a few commands: its
   state and key, its record, and its pieces three to a page (`GET_PIECES`; an
   older applet is read the old way). A till does not ask the card to prove its
   key: the signatures it is about to give prove that, piece by piece, and the
   mint's swap is what says paid. The phone checks,
   before it sends the PIN, what it can: that the card is at this mint, that it
   holds enough, and that what is left of today's limit can cover the payment. A
   refusal here takes nothing.
3. The phone chooses the pieces, as few as it can, because a tap should take
   under three seconds and each piece is most of a second of signing. The card
   is read in about 1.2 seconds, so a payment signs at most two pieces where two
   cover the price: the one or two that overpay least. Where no two do, it signs
   the fewest pieces that cover it, the set of that many that overpays least.
   What they come to over the price is change, made after the swap and written
   back at the second tap (*Change*). From a drawer of $50, every price from $1
   to $10 is one or two pieces. The mint's fee for swapping them, where it
   charges one, is added to the price, and the card pays it.
4. The phone writes down the outputs of the swap to come, so a lost answer can be
   recovered. Then it sends the PIN and asks the card to sign each piece. From
   here the card's slots are spent. The card signs each piece in software, about
   three quarters of a second a piece on the card tested, so a payment of many
   pieces keeps the card against the phone for several seconds.
5. **The card is let go the moment it has signed.** The signed pieces are
   written down first (`foxy.flashcard.taken`: they are now the only copy of the
   right to spend them), and then the sheet ends with `Done. Remove the card.` The
   card's part is a few commands and the signatures: for a payment of one piece
   eight commands and one signing, which on the card tested through its contact
   reader (a command about 0.06 s, a signature 0.74 s) is about 1.2 seconds, not
   counting the time the phone takes to find the card over NFC. Foxy's own screen
   goes on saying VERIFYING WITH THE MINT and that the card can be removed. The
   mint's part took 10 to 40 seconds over Tor, and used to be done with the card
   held to the phone and the sheet open.
6. The phone swaps at the mint, with the card's signatures as the witness for each
   piece, and asks the mint nothing before it: the swap refuses spent pieces
   itself, and a question first was a round trip over Tor in front of every
   payment (9 to 24 seconds). One swap request leaves, on the circuit that was
   made ready as the sheet opened (a payment's tap starts that circuit when the
   sheet comes up and not when the card has signed). **Paid is said when the mint
   has given this phone its own pieces,** not before.
7. Change, where there is any, is made after the swap, from the phone's own pile,
   and is owed to the card for its next tap (*Change*).

The holder's own read of a card (MENU, then FLASHCARD) is not a payment and asks
the mint for its word on the pieces, because that is something to show. It does
it after the sheet has ended: the card's screen comes up with the card's own
figures at once, and the line under its title says `Verifying…` until the mint
has answered.

If the mint has not answered once the card has signed, the screen says
**CHECKING**, then **STILL CHECKING**, and the phone goes on asking. It ends as
paid, or as money that goes back on the card. A timeout or a lost answer is not
a refusal: the swap record and the signed pieces are kept, and the wallet's own
recovery (`recoverSwaps` on the next connection, then the card's own settling)
makes the payment or finds it was made. If the mint refuses, see *A payment the
mint refuses*.

### What the person sees

Apple's sheet comes up whenever the phone is looking for a card. Its big title
and its CANCEL belong to iOS and cannot be changed. One line of text on it is
Foxy's and changes during a tap, and Foxy's own screen sits behind it with the
amount and says the same. iOS ends a session after a minute.

| Step | Foxy's screen | The sheet's line |
|---|---|---|
| waiting | HOLD THE CARD TO THE TOP OF THE PHONE (CANCEL is here only) | Hold the card to the top of the phone |
| reading | READING THE CARD | Reading the card |
| found | (the same) | Scanning. Hold still. |
| signing | KEEP THE CARD THERE, and under it the piece | Signing piece 3 of 9 |
| signed | VERIFYING WITH THE MINT, and under it that the card can be removed (nothing to press) | Done. Remove the card. (the sheet ends here) |
| the change | MAKING THE CHANGE, and under it that the payment is made | (no sheet) |
| writing | WRITING TO THE CARD, and under it the piece | Writing 2 of 4 |
| done | REMOVE THE CARD | Done. Remove the card. |

A flow that goes on to speak to the card again (a renewal writes to it, a move
reads it last) holds it instead, as it always did: the sheet stays open through the
mint (`Keep the card there: asking the mint`) and its change is written back in
the same tap.

Each result is one of the app's own cards, with a title, a line or two and one
or two buttons. The ones a payment can end in:

| Result | Says |
|---|---|
| the paid confirmation | the usual one; the entry is marked as a card's |
| WRONG PIN | the tries left, and that nothing was taken; TRY AGAIN |
| CARD BLOCKED | too many wrong PINs; the card pays again when its owner sets a new PIN on it |
| NOT ENOUGH ON THE CARD | what it holds |
| OVER THE CARD'S DAILY LIMIT | what is left of today, and when the day turns; said before the PIN is sent |
| A DIFFERENT MINT | the card's mint and this phone's. Adding funds to a card that holds money: "You need to withdraw all funds on the card before you can switch mints." and CLOSE. To an empty card, on its owner's phone: SWITCH TO <MINT>, which goes to the amount and moves the card in the tap that writes the funds; on any other phone, that only the phone that set the card up can switch it |
| NO CHANGE WHILE OFFLINE | no connection, and the card has no pieces that make the price exactly; said before the PIN |
| TAKEN ON TRUST | no connection: kept, not paid, swapped in when online |
| NO MONEY ON THIS CARD | a card with no PIN, or nothing on it |
| NOT A FOXY CARD | it could not be read, or is another kind |
| NO CARD READER | this phone, or this build, cannot read a card |
| NOT PAID YET | the card left while it was signing, and the sheet that came up again to finish read no card: TAP CARD finishes the payment, CANCEL gives back what it signed |
| NOT PAID | the card was refused, or gave a bad signature, part way through: nothing was paid, and the next tap puts back what it signed, with no PIN (or, where the mint has not answered, once it has) |
| TAP TO RECEIVE | the payment is made and its change is waiting for the second tap, with no PIN |
| COMPLETE | the second tap did it: what was paid, and the change back on the card |
| PAYMENT FAILED (NOT TAKEN OFF for a withdrawal) | the mint refused it after the card had signed: tap the card again to put the money back, and, if it has a limit, that the day stays used |
| PUT BACK ON THE CARD | the next tap did it: ₿ is back on the card, and the payment was not made |

Every screen of the card flows has a render snapshot in `tests/snapshots/render`
(the views named `flashcard…`, `card: …`, `stage: …`).

## A tap cut short is taken up again

A card held to a phone for a second or two is sometimes taken away too soon.
Wherever some of the work was done, the next tap does the rest, and the phone's
sheet comes up again by itself for it, with the PIN already given:

- **A payment.** What the card signed before it left is held by the till for
  that payment, and the next tap of the same card for the same amount signs only
  the rest. The two are swapped at the mint as one payment. Nothing has to be
  written back to the card, so the card is never short for a payment that was
  finished. Cut short again, what it signed is held with the rest. Offline, taken
  on trust, it works the same way: the rest of the exact set, kept on trust as one
  payment. A held payment is given back to the card, by the road a refund always
  took, when the person presses CANCEL, when the card pays another amount at that
  till (its money then goes back in the same tap as that payment's change), or
  three minutes later, at the next settling.
- **A withdrawal.** What the card signed is already in the phone, with an entry
  of its own, and the next tap takes the rest.
- **Money going onto the card.** Whatever pieces went on stay on, and the next
  tap writes the rest.

Where the sheet that comes up again reads no card, the screen says what is
waiting, with TAP CARD to finish. A card refused, or a bad signature, part way
through a payment is not taken up again: what the card signed goes back to it.

## Change

The card signs whole pieces, so a payment of $0.43 may use a piece worth more.
The difference is made into new pieces **locked to the card's key**, cut to fill
the gaps in what the card will then hold (*Adding money*), after the swap has
landed. Change is never the receiver's: it is kept in a store of its own, outside
the balance, until it is on the card.

A card payment is two taps, and is said as two every time, so a person learns
one way of paying:

1. **SEND.** The PIN, and the first tap (`Tap 1 of 2: SEND.` under the amount).
   The card signs its one or two pieces and is let go.
2. **VERIFY.** Foxy's screen says VERIFYING WITH THE MINT while the swap runs,
   then MAKING THE CHANGE.
3. **RECEIVE.** **TAP TO RECEIVE**: `Paid ₿1,180. Tap the card again to receive
   its ₿212 of change. No PIN is needed.` with **TAP CARD** and LATER. The tap
   (`Tap 2 of 2: RECEIVE.`) writes the change. The card allows the tap after a
   payment to load with no PIN; a card that has not just paid asks for it.
4. **COMPLETE.** `Paid ₿1,180. ₿212 of change is back on the card.`

Where the pieces came to the price exactly there is nothing to receive, and the
payment is complete at the first tap. Until the second tap the change stays on
that payment's entry. The receiver cannot spend it, and neither can anyone else
but that card. Because cards are cash, change that is never written back stays
unspendable. A tap that reads no card says the change is still waiting, and
offers the tap again.

Where a sat or two are over and not enough to make change of, they stay with the
payment, and its entry says so. A payment whose swap answer was lost and found
later has its change made then, and owed to the card the same way; the checking
screen asks for the second tap when it finds it.

If the mint does not make the change, the payment still stands, and the screen
says **CHANGE NOT MADE YET**: this phone tries again whenever it connects, and
then a tap of the card here receives it. Until it is made the receiver holds it,
and the payment's entry says the whole amount. A change swap whose answer was
lost waits for the wallet's own recovery, so nothing is made twice, and what the
recovery finds is owed to the card. After thirty days of trying, the payment
keeps it.

## The daily limit and the owner's phone

The limit is the most the card will sign for in one day. A card has none until
its owner sets one, and any amount may be set. Only the owner's phone sets,
changes or removes it, and it asks for no PIN.

**CHANGE LIMIT** on the card's screen has three steps and then a tap:

1. A full-screen warning, SET DAILY LIMIT: `A daily limit is the most this card
   will spend in one day. It starts again by itself each day.` and `Only this
   phone, or a phone restored from its seed phrase, can change or remove the
   limit.` and `If you lose the seed phrase for this Foxy app, the PIN and the
   limit on this card can never be changed.` CONTINUE or CANCEL.
2. The app's SET AMOUNT screen: `What would you like the daily limit to be?`
   with NEXT, and under it **NO LIMIT**, which is how a limit is removed.
3. A CONFIRMATION, `YOU ARE APPLYING A DAILY LIMIT OF:` and the amount, or `YOU
   ARE REMOVING THIS CARD'S DAILY LIMIT.` with `It will be able to spend
   everything on it.` CONFIRM or CANCEL.

The card's screen shows `DAILY LIMIT` and its amount, or `NO LIMIT`; with a limit,
`LEFT TODAY` and `THE DAY TURNS AT` a time.

How it behaves:

- **It counts the pieces signed, not the price.** A payment of $0.43 made with
  one piece worth $1.00 costs the day $1.00. A piece worth more than what is
  left of today cannot be spent today, whatever the payment.
- **A day is 24 hours from when its window began.** Setting the limit begins a
  window. The first spend after a day has passed begins the next. A terminal
  that straddles a boundary can take up to two days' limit in a short time.
- **A payment the mint refuses still charges the day.** The card counted what it
  signed when it signed, and putting the pieces back (*A payment the mint
  refuses*) gives the day nothing back. Only the owner's phone can set the limit,
  and so only it can give a day back.
- **A payment over what is left is refused before the PIN is sent**, and the
  screen says how much the card can still spend and when its day turns. The card
  may hold enough and still be over the limit.
- **The owner takes money off at any limit.** WITHDRAW, renewing and taking
  everything off lift the limit with the owner's proof, spend under the PIN, and
  put the limit back, all in one tap, even when the spending fails part way. If
  the card leaves before the limit can be put back, the phone has written the old
  limit down first and puts it back at the next tap. Putting it back begins a new
  window, so a withdrawal gives the day back its whole limit.
- **Another phone cannot do any of this.** It is told NOT THIS PHONE'S CARD:
  `This phone does not hold the seed phrase this card was set up with, so it
  cannot change the card's PIN or limit.`

## Change PIN, withdraw, and a blocked card

**CHANGE PIN** takes two pads, `NEW PIN` and `NEW PIN AGAIN`, and a tap. The old
PIN is not asked, because the owner's phone does not know it; the card takes the
owner's proof in its place. It ends at `PIN CHANGED`.

**WITHDRAW** is an amount, or `ALL OF IT`, the PIN, and a tap. The card is let go
the moment it has signed, as at a till, and is not read again afterwards: it ends
at **IN YOUR WALLET**, and the card's screen goes away, so that the next tap shows
the card as it is. (A move to another mint, and a renewal, hold the card.)

A withdrawal of many pieces takes longer than a person holds a card. If the card
leaves part way, what it signed is kept: it is in the phone, with an entry of its
own, and the screen says **TAP THE CARD AGAIN**, how much came off and how much
is left. TAP CARD takes the rest with the PIN already given, and IN YOUR WALLET
then says the whole amount. LATER ends the withdrawal; the rest stays on the card.

**A blocked card** shows BLOCKED on its face and a red line. Any reader in range
can send three wrong PINs and block a card, so this is a known way to annoy a
holder, not only a sign of theft. On the owner's phone the line says that this
phone can unblock the card by giving it a new PIN, and there is one button,
**UNBLOCK**. It is the CHANGE PIN pads and tap, and ends at `CARD UNBLOCKED`.
On any other phone the line says that only the phone that owns the card can
unblock it, and there are no buttons. A blocked card whose owner has lost the
twelve words stays blocked.

## The time

A card has no running clock. It keeps the latest time it has been told, and it
accepts a time only if it carries a signature by the card's **time key**, which
is written to the card at set-up. The clock only moves forward. Every tap tells
the card the time once, before anything that depends on the day is read.

**For now, the time is the receiving phone's own clock, signed by a key that is
inside the app.** Its private half is a constant named `InterimCardTime` in
`Foxy/Flashcard/CardTime.swift`, and it is in this repository, in every copy of
the app, and in the tests. That is on purpose and is documented where it is
used. It makes the daily limit **as weak as trusting the receiver's clock**:

- an honest receiver cannot be talked into taking more than a day's limit by
  accident, and the holder's own spending is held to the day;
- a terminal built to cheat can sign any time it likes, day after day in one
  tap, and with the card and the PIN take everything the PIN reaches. Against
  it the limit is no better than having none;
- a clock set far ahead on an honest phone signs that time too, and the card
  never takes an earlier one, so its day is frozen. The way out is for the owner
  to write the card a different time key while the card is empty.

No screen says that the limit stops an attacker, because until the time is real
it does not. A scheme with no signing key at all is meant to replace this: the
card is told a Bitcoin block header, checks its proof of work against a floor
written at set-up, and takes its timestamp if that is newer than its own. It
needs a new version of the applet and is not built.

## Paying with no connection

A till with no connection cannot ask the mint, and a card cannot prove that what
it signs is unspent: it holds no copy of the mint's answer, and a cloned card
signs the same piece again. So a card taken with no connection is taken as
**HIGH RISK**, the word `MONEY.md` uses for ecash another phone has seen and this
phone has not yet swapped. It is ecash taken on trust, and the risk is the
receiver's.

- CARD on the receive screen, with no connection, puts the HIGH RISK card first
  (YOU ARE OFFLINE: whoever gave it can still spend it until this phone is online),
  in front of the amount and before the PIN. CONTINUE or REJECT; the person's
  answer decides, and REJECT touches nothing;
- only an exact set of pieces; an offline till cannot make change. A card that has
  none for the price is refused before the PIN is sent (NO CHANGE WHILE OFFLINE).
  It is one tap, with no second, and a longer one than online: from a drawer of
  $50 a price of $1 to $10 is five to nine pieces;
- the card's time is signed on the phone, which works with no connection, and the
  daily limit is looked at as ever;
- the card's signatures are checked on the phone, and so is each piece's DLEQ
  proof where the card can supply one. The card holds none today, so a piece
  the mint never signed cannot be told from a real one, which is why this stays
  HIGH RISK;
- the amount is kept as a trusted row with a pending entry, swapped when the
  phone is back online, and **never shown as paid while offline** (TAKEN ON
  TRUST);
- if the mint says the pieces were spent in the meantime, the entry is marked
  taken back and the person is told. Nothing was paid, and the receiver bears the
  loss.

It is an exception, for a card only, to the rule in `OVERVIEW.md` that Foxy does
not receive ordinary ecash offline. It has a switch of its own
(`CARD_OFFLINE`, build/wallet/08a-flashcard.js); plain ecash between two offline
phones keeps `OFFLINE_TO_OFFLINE`, which is off.

## A payment the mint refuses

The card burns the pieces it signs for, and the mint is asked after it has been let
go. If the mint refuses (a spent piece, a signature it will not take, any answer
that is a "no" and not a lack of one), the pieces the card burned are still the
holder's, and only that card can hold them. So:

- the screen says the payment failed (PAYMENT FAILED, or NOT TAKEN OFF for a
  withdrawal) and that the card must be tapped again to put the money back, with
  the amount. If the card has a daily limit it says the day stays used;
- before it says so the phone asks the mint which of the signed pieces are still
  unspent. Those are filed as owed to the card, as the pieces themselves without the
  card's signatures (`foxy.flashcard.owed`, kind `putback`). The ones the mint says
  are spent are gone, and are not put back. If all are spent the screen says
  NOT PAID and that the mint has the card's money spent, and there is nothing to
  put back. Pieces the mint says it never signed are not put back either;
- the next tap on the card (TAP CARD, with its PIN) clears the places the signing
  burned (`CLEAR_SPENT`) and loads the same pieces again, which the applet allows,
  and says so: PUT BACK ON THE CARD, with the amount and that the payment was
  not made;
- the daily limit **stays charged** for everything the card signed. Loading
  gives the day nothing back. Only the owner's phone can set a limit, and so only
  it can restore a day.

An answer that does not come, a mint that says it is too busy, and a mint that
cannot be asked which pieces are good, are not refusals: the row and the swap record
wait, and the payment is made when the wallet next asks.

## What is kept on the phone

Four stores, named in `STORAGE.md`: ecash made for a card and not yet written to
it (`foxy.flashcard.owed`: a load, change, and the pieces of a payment the mint
refused); pieces a card has signed for that the mint has not swapped yet
(`foxy.flashcard.taken`), which are the only copy of the right to spend them,
written down before the card is let go; the cards this phone loaded as recoverable; and when the mint last
said a card's pieces were good, so a phone with no connection can say `Verified 2
Hours Ago`. The card's screen shows `Verifying…`, `Verified Just Now`, that, or
`Not Verified`.

## What it does not protect against

The card repository's `FOXY-CARD-SPEC.md` §10 has the full list. The ones that
matter to a person:

- **A terminal built to cheat**, while the time is interim (above).
- **A receiver's phone that shows one amount and asks the card for more.** The
  limit does not check a payment, and nothing on the card can. Looking at the
  card's balance afterwards finds it out; it does not undo it.
- **The PIN in the clear**, over a few centimetres, to a phone that may not be
  honest. A pretend card can collect a PIN typed for it, and a receiver has no
  way to know a stranger's card is real. It loses nothing if it is not.
- **Pieces a terminal writes that the mint will refuse.** The card has no DLEQ
  check, so it cannot tell. A later payment that picks such a piece spends a day's
  limit on nothing.
- **Three wrong PINs from any reader** block the card until the owner's phone
  unblocks it.
- **Whoever has the twelve words and the card** has everything on it. **Whoever
  loses the words** loses the PIN and limit for good.

## Where it is in the code

- Screens: `build/app/26f-flashcard.js`, and the FLASHCARD block of
  `build/markup.html`.
- The wallet's side: `build/wallet/08a-flashcard.js` (reading, signing, pieces,
  the interim time key) and `build/wallet/21a-flashcard.js` (set-up, adding and
  taking money, the owner's proofs).
- Native: `Foxy/Flashcard/` (`CardLink.swift`, the NFC session; `CardGate.swift`,
  which commands may pass; `CardTime.swift`, the interim time), and
  `Foxy/Bridge/FoxyBridge+Flashcard.swift`. The bridge actions are in
  `THREAT-MODEL.md` §1, and the owner key's derivation is in `SEED-HANDLING.md`.
- Tests: `tests/flashcard-*.js` run in `tools/check-all.sh` against a model of
  the card held to the applet's own conversation. `tests/flashcard-fewer.js` pins
  the cash-drawer cut and the exact sets it makes; `tests/flashcard-release.js`
  pins the card being let go before the mint, a refusal and its put-back tap, a
  lost answer, and the circuit made ready as the sheet opens. `tests/flashcard-applet.js` is
  opt-in and drives the wallet against the applet itself over a local port.
  `tools/live/flashcard-switch.js` moves a card between two local mints.
  `DEVICE-TESTS.md` §23 is what only a card and a phone can show.
