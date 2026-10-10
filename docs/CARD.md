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
  mint refuses), the two-tap payment that signs at most two pieces, the
  withdrawal that keeps what a cut-short tap signed, and the whole of a card
  that signs once for a payment (below), which has paid real mints only from
  the simulator, and the change such a card makes for itself (below), which
  has not been held to a real card at all, so how long a tap lasts with it is
  not known. The list of what only a
  card and a hand can show is
  `DEVICE-TESTS.md` §23.
- **A card's clock is the newest Bitcoin block header it has been shown**, from
  software 1.15, which no terminal can set; before it, the clock was a time told
  under a signature by a key built into the app, which a terminal could (*The
  time*, below). Neither the fetch of the header nor a card that takes it has
  run on a real card.
- **A card is cash.** Lose it and the money on it is gone. Whoever has the card
  and its PIN has the money, up to the daily limit if there is one.
- No independent review or audit has covered the card code. Do not put on a
  card what you would not carry in cash.

## What a card is

A card holds up to 128 pieces of ecash (64 with software before 1.7), each locked to the card's own key, and
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
  and clock stay as they were. Moving the money across by Lightning, with a
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
5. One tap writes the PIN, then the card's record (this phone's mint, and for
   a card before 1.15 the time key), and last the owner key. The owner goes in last so that no step
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

   **A card of 128 places that burns any number of pieces at once (software
   1.8) is cut deeper, and differently.** A
   price typed in dollars is an odd number of sats, so every payment needs a
   1 or a 2 or a 4 of its own, and nothing larger can stand in for one (two
   256s make a 512; nothing but 1s makes a 1). Three deep, the third payment
   in a row was already being paid with a piece too big and made up for in
   change. Such a card signs once for a payment however many pieces it is
   made of, so pieces cost nothing at a till, and it has the places: it gets
   **eight of each size from 1 to 1,024**, smallest first as far as the money
   goes, and the rest of the amount in powers of two. 16,376 sats fill that
   drawer, in eighty-eight pieces, and it pays eight prices in a row exactly,
   whatever they are, up to 2,047 sats each. A card with less on it has the
   small sizes eight deep and its money in nothing large: 6,070 sats are
   eighty-two pieces, none over 512. A load may be most of the card (112
   pieces, a dozen places kept free), and takes as long to write: about nine
   seconds for a hundred pieces. What the card holds counts towards each
   size, so a top-up fills what has been spent from first.
   A card with a **per tap limit** is cut to it: nothing larger than the
   largest power of two under the limit, so a payment under the limit is never
   made from a piece the card waits for. Where that is more pieces than the
   places left (a small limit on a large balance), the places fill with pieces
   under the limit and the rest goes in larger ones; the card's screen says how
   much, `$X IN PIECES ABOVE THE LIMIT · A TILL HOLDS LONGER FOR THOSE`.
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
   cover the price: the one or two that overpay least **and leave the card's
   drawer with no gap**. Where no two do, it signs the fewest pieces that cover
   it, the set of that many chosen the same way. A card that paid 3,000 with its
   last 2048 and 1024 was left holding large pieces and small change, and could
   pay nothing in between exactly, which is the only way a till with no route can
   be paid (*With no connection*); so it pays with a 4096 instead, and the change
   is cut to fill the drawer. What the card would hold afterwards is worked out
   before anything is signed, from the pieces left and the change as it will be
   cut. A card with a gap already is mended the same way, by the change of a
   larger piece. Where no set leaves it whole, the one that overpays least is
   taken; and under a daily limit it always is, because the day is charged the
   whole worth of what is signed.
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
   counting the time the phone takes to find the card over NFC. (At a till the
   sheet is kept up for the change, and says so: *Change*.) Foxy's own screen
   goes on saying that the payment is being verified. The
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
| the card's change (1.12 and on) | (the same) | The card is making change · piece 2 of 4. Keep holding. |
| a wait (1.13: only over the limit) | (the same) | Over the card's per tap limit. Keep holding (4 s) |
| signed | VERIFYING WITH THE MINT, and under it that the card can be removed (nothing to press) | Done. Remove the card. (the sheet ends here) |
| the change | MAKING THE CHANGE, and under it that the payment is made | (no sheet) |
| writing | WRITING TO THE CARD, and under it the piece | Writing 2 of 4 |
| done | REMOVE THE CARD | Done. Remove the card. |

A payment at a till has three screens of its own in place of these, drawn from
the design: **TAP TO VERIFY** (a card's outline, with arrows flying into its
mark) from the PIN until the card has signed, **VERIFYING CARD** (the card, with
a spinner) while the mint is asked and the change is made, and **TAP TO
CONFIRM** (on orange) from the moment the card is asked for again until its
change is back on it. A card that leaves part way through a tap turns that
tap's screen into **TAP AGAIN** ("The last tap didn't finish..."), on the same
ground, from the moment it is lost until the tap is finished. Each says one
thing and does not change as the card works: the sheet says the steps. They sit in the top half of the screen, above where the
sheet comes up. The sheet dims whatever is behind it; that is the phone's own
doing and an app cannot turn it off.

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
| OVER THE CARD'S PER TAP LIMIT | how long the card would have to be held to pay this (longer than a tap lasts), its per tap limit, and what can be taken at a time; said before the PIN is sent. A charge that waits less than that is not refused: the screen says `Keep holding` and counts down. (An older card, whose limit was a window: the most it pays in one tap, or what the tap has left) |
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

- **A payment.** The card signs a piece before it marks it spent, and marks it
  spent before the signature leaves the card, so a card pulled away while it
  signs has lost nothing. What the card signed before it left is held by the till for
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

## A card that signs once for a payment

There are two kinds of card. The first signs for each piece it pays with, most
of a second apiece, and everything above about signing few pieces and taking
change at a second tap is written for it. The second (the card's software 1.4,
which says of itself that it is format 4) signs **once** for a whole payment,
whatever the number of pieces. Foxy reads which kind a card is and pays with
either; a piece is written the way its own card writes it.

One signature is over more than the pieces. It is over the pieces **and the
outputs they are swapped for** (NUT-11's `SIG_ALL`), and a mint takes it for
that swap and no other. So the order of a payment is turned round:

1. the card is read, and the pieces chosen;
2. this phone sets out the swap: the outputs, made from its own seed at
   counters taken now, shaped as any receipt is. Nothing is asked of the mint;
3. what was set out is written down (`foxy.flashcard.swaps`), and the card is
   told the places and the outputs and signs once;
4. the mint is sent exactly that swap. What is about to go is hashed again and
   held to what was written down first, and a swap that cannot be set out as
   it was signed for is not sent.

What that changes:

- **The sheet goes as soon as the card has signed**, where no change is coming:
  with no words on it, only the phone's own tick as it closes. The wait for the
  mint is on Foxy's own screen (VERIFYING CARD), and then PAYMENT RECEIVED.
  Where change is coming the sheet stays, as below.
- **The PIN is sealed to the card (software 1.9).** A PIN typed at a till
  crossed the air to the card as it was typed, and anybody listening to the
  tap had it. A bank card's PIN is enciphered to a key of the card's, and so
  is this one. The card has a key for it and nothing else (never the key it
  signs payments with). Asked, it gives sixteen fresh bytes, that key, and its
  signing key's signature over that key; the phone checks the signature, makes
  a key pair for the one message, and sends the PIN under a keystream hashed
  from the secret the two keys share, the card's sixteen bytes and the
  command, with a tag over it. The card does the same sum. The sixteen bytes
  are good once, so what was heard at one tap opens nothing at another and
  cannot be put to the card again; an envelope the card cannot open costs a
  try of the PIN, as a wrong PIN does; and what is sealed is always nine
  bytes, so its length says nothing of the PIN's. A new card's first PIN and
  a PIN changed by its owner go the same way (the owner's proof and the seal
  under the same sixteen bytes). It costs one more command and one key
  agreement on the card, a fraction of a second. A card that does not say it
  takes a sealed PIN is shown it as before. What it does not do is in *What it
  does not protect against*.
- **A card of 128 places (1.7) is read in one command.** Its short listing
  is two bytes a piece (the place and the power of two it is worth, with the
  keyset and date only where they change), so a till reads a drawer of a
  hundred pieces in one answer, and then asks for the pieces it chose. A till
  that writes change back reads it the same way before and after: it wants
  what the card comes to, not what is on it. That listing names no pieces, so
  a write that was cut short is finished by the card itself: it refuses a
  piece it already holds, and that is taken as what it is.
- **Eight in a row, and then change that is worth the second tap.** With a
  deep drawer a price is nearly always made exactly. When none is, the drawer
  is short of some small size, and the set that overpays least would bring
  back a sat or two: one piece, and the payment after it short again. So a
  till takes the cheapest set that brings back 256 sats or more (and no more
  than 1,024), and that change is cut to fill the small sizes, in thirty-two
  pieces at the most (eight, where the card makes it itself). One second tap in ten payments or so, where it would be
  one in two. The larger set may be over a per tap limit the till is not
  told: the card then answers "not yet" before it has signed anything, and
  the till pays with the cheapest set after all, at once. Nobody is told to
  keep holding for the sake of change. (A card of 1.13 is paid otherwise:
  *A card that makes its own change*, below. Its change is cut plainly and
  restocks nothing in particular, so the till takes the set that overpays least,
  and the drawer's small sizes are put back by a top-up.)
- **How many pieces one signature is for.** A card burns the pieces of a
  payment as it signs. Before software 1.8 it did so inside one transaction,
  a status byte a piece, and the chip's transaction holds few: on the card
  itself eleven pieces were signed for and thirty-two were refused, with
  nothing burned. No simulator shows that, since a simulator's transaction
  has no size. So a card that does not say it burns any number is asked for
  **eight pieces at the most**: a payment is paid with a larger piece and
  change where its exact set is more, a payment no eight pieces cover is
  refused before the PIN with `TAKE IT IN PARTS` and the most the card can
  pay at once, and a whole card comes off in as many signatures as it takes,
  in the one tap. Such a card is not cut deep. A card of 1.8 commits the
  payment with one byte and marks its pieces after (finishing at its next
  command, should it leave the field first), and says so: it is asked for
  thirty-two pieces or fewer wherever such a set pays, and for as many as it
  has where nothing that few does, which is most of a small card.
- **A card of software 1.6 is quicker to hold.** A till reads its brief
  listing (what each piece is worth, its date and its keyset: three commands
  for a full card where the whole listing is eleven), chooses, and asks for
  only the pieces it chose, checking each against what the listing said. Not
  where this phone holds a signature it never saw or a payment cut short for
  that card: those are settled by the pieces' own nonces, and the whole
  listing is read. A load sends three pieces to a command. The card itself
  takes in a payment's pieces several times faster (it keeps their text
  ready from loading). Its holder's own phone no longer asks the card to
  prove its key before taking money off: the signature it then asks for is
  that proof.
- **Nothing is asked of the card twice.** Its slowest answer is the proof that
  it holds its key (most of a second, and often two on a phone). A sheet asks
  for it once at the most: a tap that writes used to ask before the write and
  again after, and a card that has just signed a payment has proved its key by
  signing. The swap is set out with twelve outputs or fewer, since the card
  hashes every one while it is held. The log says how long each part of a
  read and of a signing took (`card: read in`, `card: signed in`), in
  milliseconds and nothing else.
- **A tap is felt the moment the card has signed**, silent and of its own kind:
  the phone's sheet takes about three seconds to go after it is told to, and
  that is the phone's own doing.
- **Exactly, where the card can.** Signing costs the same for one piece as for
  thirty-two, so the pieces are chosen to come to exactly the price (and the
  mint's fee on them) where the card holds them: no change, and no second tap.
  Where it cannot, the choice is the one the other kind of card makes, with
  change owed and written back as ever. The change is locked to the card with
  the same flag, and is money it signs for again.
- **One date.** A mint takes one signature only for pieces whose secrets agree
  in everything but the nonce, and a recoverable card's pieces carry a date.
  So a payment is of one date's pieces. A top-up takes the date the card
  already has while that is ninety days off or more, and a new year after
  that, so a card is mostly of one date. A card topped up near the end of its
  year holds two; a price that neither covers alone is refused before the PIN
  with `TAKE IT IN TWO PARTS` and the most it can pay at once. The holder's own
  phone, taking a whole card off, asks for a signature for each date (and for
  each eight pieces, on a card before 1.8) in the one tap. Where that is more
  than one, the pieces are dealt out by size, a piece to each signature in
  turn, so that each has its share of the money: cut as they lay, a run of
  small pieces made a signature's worth that came to no more than the mint's
  fee on them, and the taking stopped there.
- **All or nothing.** The card burns every piece as it signs, in one
  transaction, so there is no payment half signed. A card taken away before it
  signs has burned nothing. A card taken away **as** it signs has burned the
  pieces, and this phone never heard the signature: it says `NOT PAID YET`, and
  the card's next tap here settles which it was. Pieces still on the card were
  never signed for. Pieces gone from it were, and the card is asked for that
  signature again (it keeps its last), under the PIN: tapped for the same
  amount the payment is made with nothing more signed, and tapped for another
  the first goes back to the card as a payment given up does. A card that has
  signed for another till in between cannot give it again: those pieces can
  be spent by nobody until their date, when the holder's phone takes them
  back, as a piece lost in the air always could not.
- **The signed pieces are of use to this phone only.** Somebody who has them,
  off this phone or off the air, cannot swap them for outputs of their own:
  the mint refuses the signature for anything but the swap it was made over,
  even the same outputs in another order.
- **A lost answer comes back the same way.** The outputs' counters are on the
  swap's record before the request goes, as any swap's are, and an answer that
  never arrives is restored from them. The body is not run again with other
  outputs, which is what any other swap does when a mint says it has seen the
  outputs before: here that answer means this very swap was made, and it is
  restored. A phone whose counters are behind what the mint has seen of its
  seed is refused once, the pieces go back to the card, and the counters are
  moved on so that the next payment is made.
- **With no connection** the swap is set out all the same (it needs no mint),
  and the outputs wait with the pieces kept on trust.
- **Taking a lost card back**: this phone's own key signs once for each date's
  pieces, over the swap they come back in.

What it costs: a signature that names its outputs is good only while the mint
will still make that swap. A mint that retires the keyset the outputs are on,
or raises its fee, between the signature and the swap (which matters for a
payment kept on trust for days) leaves pieces the card's signature can no
longer spend; on a recoverable card they come back to the holder's phone after
their date.

The limits are held to what a payment's pieces come to together (from 1.12, less
the change the card makes for itself: *A card that makes its own change*), by the
card, before it signs; and the card's log counts the payment once.

## Change

The card signs whole pieces, so a payment of $0.43 may use a piece worth more.
The difference is made into new pieces **locked to the card's key**, cut to fill
the gaps in what the card will then hold (*Adding money*), after the swap has
landed. Change is never the receiver's: it is kept in a store of its own, outside
the balance, until it is on the card. (A card of software 1.12 makes the change
itself, in the swap, and this phone finishes the pieces at the second tap:
*A card that makes its own change*, below; from 1.13 the card makes the four
largest powers of two the change is made of and this phone only the small tail.
What follows is the change a till makes, which is every card's before 1.12, and a
later part of a bigger change.)

A card payment is two taps, and is said as two every time, so a person learns
one way of paying:

1. **SEND.** The PIN, and the first tap, under TAP TO VERIFY. The card signs its
   one or two pieces and may be taken away.
2. **VERIFY.** The phone's sheet stays up and says `Paid. Keep the card here
   for your change.` while the swap runs and the change is made; Foxy's screen
   behind it says VERIFYING CARD. "Paid" first, since the card's part is over
   the moment it has signed, and the words are what say so: iOS plays no
   haptic of an app's while its own sheet is up. (The sheet used to say `Remove
   the card`, which beside its own Cancel read as finished, and it was closed
   before the change.)
3. **RECEIVE.** The same sheet says `Tap the card again for its change` and the
   screen says TAP TO CONFIRM; the tap writes it, with no PIN: the card allows
   the tap after a payment to load. The sheet ends `Done. ₿212 of change is back
   on the card.` A card that leaves while its change is being written has used
   that one tap up, and wants its PIN for the rest: the same sheet asks for it
   again (TAP AGAIN) and gives it the PIN typed for this payment, so nobody is
   asked for it twice. The PIN is held for the length of the one payment's sheet
   and no longer; a change tap in a sheet of its own, later, asks for it on the
   pad as it always did.
4. **PAYMENT RECEIVED**, the receiver's own confirmation, is held from the
   moment the card has signed and goes up as the sheet ends. It is held as that
   payment's and no other's, and it is let go whenever nothing is owed for the
   payment any more, however that came about: the change back on the card, the
   change left for later, or after two and a half minutes whatever happens. A
   confirmation still held when the next card payment begins is dropped; the
   payment is in HISTORY.

There is one sheet for all of it: a second sheet opened for the change was
refused by iOS as often as not. iOS ends a sheet after a minute; where the mint
is slower than that, or the sheet was closed, a new sheet comes up for the
change, with TAP TO CONFIRM up from the payment until that tap is over, so the
till is never looking at its home screen in between; and where that reads no
card, **TAP TO RECEIVE** stays up with TAP CARD. A payment the mint refuses
after the card signed is put back in the same sheet too (`The payment did not
go through. Tap the card to put it back`), and the screen says PAYMENT FAILED
with the money back on the card.

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

## A card that makes its own change

From software 1.12 the card makes a payment's change itself. Before it, a till
paid in pieces worth more than the price made the difference into new pieces
after the swap, locked to the card, and the card could not tell what it was given
back, so its limits had to count the pieces whole. Now the till names an amount
for each piece of change and the card makes the piece: it draws the nonce and
the blinding factor, builds the secret as it builds its own pieces' (locked to
its own key), hashes it to the curve, blinds it, and answers the blinded message.
That goes into the swap beside the till's own outputs, the card signs once for
all of it, and the mint signs the card's outputs in the same swap as the till's.

The order of a payment is the pieces, the till's outputs, the card's change one
command a piece, and the signature. The swap's row (`foxy.flashcard.swaps`) holds
the sizes of the card's change before the card is asked for anything and each
blinded message as the card answers it, before the signature is asked for: the
signature is over every output and must never exist without the row having them.
The till then keeps what the mint signed for each output of the card's, with the
DLEQ and the mint's key for the size, as what the card is owed
(`foxy.flashcard.owed`, with no token in it). Nothing in it can be spent without
what only the card holds.

What it means for the holder:

- **Nothing a till names can take the change.** A till says how much and nothing
  else. The secret, the nonce and the blinding factor are the card's, and the
  piece is locked to the card's key, so a terminal built to cheat cannot choose
  an output of its own for it.
- **The limits are held to what leaves the card for good**: the pieces less the
  change it made for itself, which is the price and the mint's fee on the pieces.
  A payment of $3 made with a $10 piece costs the day $3, and not $10. A till that
  writes change back by other means gives the day nothing back, and the card does
  not take its word.
- **The wait on a per tap limit is by the same.** It is counted on what leaves the
  card, and overpaying costs no wait, so the pieces are not chosen to overpay the
  least for the wait's sake. **From software 1.13** a payment within the limit
  goes at once, with change or without (a thirty-second over the limit counts as
  within it: a limit set in dollars at one moment and a price in dollars at
  another lands a few sats over). Over it the card does seven signatures of work,
  about five seconds, for the first limit's worth over the limit and three more,
  about two seconds, for every limit's worth after that, whole or in part. The
  change the card made counts toward them as work done, for what it cost: **from
  software 1.14** two waits off for every three pieces (a piece is about two thirds
  of a signature's work, so one for one took off more than a piece cost), and none
  is below nothing; at most 255 limits' worth are counted. A payment over the limit
  takes about the same time in the hand with change as without, and what is felt
  says how far over the limit it was; and asking for more pieces buys a terminal
  nothing, since each costs the holder's hand what it takes off. (**Software
  1.13** took one off for each piece, and a terminal could buy the wait down with
  pieces of a sat: eight of them took eight off for less than six signatures of
  work.) That change is coming is the phone's to say and not the card's: see
  *Three buzzes*, below. **Software 1.12** waited four signatures for every limit's
  worth, three seconds, and for a payment within the limit that made change. While
  it waits the till's sheet says `Over the card's per tap limit. Keep holding`,
  and how long it has been; a card of 1.12 for its first limit's worth said `The
  card is making change. Keep holding`. The day's limit is held at the card's
  first SIGN and not at the start of the payment, so a refusal comes after the
  outputs and the change were sent, and gives the payment up: the swap's row is
  dropped, nothing is burned.
- **One payment a tap at full speed (1.13).** A second payment signed in the
  same time in the field waits as one over the limit does, seven signatures and
  its own count where that is more, whether the card has a limit or not, unless
  the owner's grant is in the tap. Without it a terminal that has the PIN could
  take a limit's worth a second for as long as the card is held. A new SELECT
  is the same time in the field; the card out of it and back is a new one. The
  change tap, a refund and any load are not payments. A till is not told the
  limit, but it knows what it has had the card sign in its sheet, so it says the
  seven before the PIN is sent, with what the change it will ask for counts for
  taken off (two for every three pieces from 1.14, one for each before), and
  the screen says `A second payment in one tap. Keep holding`. The owner's phone,
  which gives the grant first and takes a whole card off in as many signatures as
  its pieces have dates, is not slowed. Nothing a till does in one sheet makes a
  second payment today: a payment begun and given up, a refusal and the change
  tap are none.
- **The change tap is as before**: the second tap, no PIN, TAP TO CONFIRM. The till
  reads the card's openings (`GET_CHANGE`, three a page, once in the tap), finds
  the one each output of its is (it makes the blinded message from the opening's
  nonce and factor again, and the two are the same), takes the blinding off the
  mint's signature, checks its DLEQ where the mint gave one, and writes the piece
  with the rest, three to a command. The card lets an opening go as its piece is
  written, so a tap that was cut short is finished by the next, and the card lists
  none when all is back. An output the card no longer lists and does not hold (it
  was wiped and set up again) cannot be finished: the row is kept, marked, and
  left out of what the screen says is owed.
- **Four pieces at most, from 1.13** (eight, from 1.12 to 1.13), and the card
  keeps openings for eight, of which the change not yet written back counts.
  Each piece costs the card about half a second of its own work over NFC (its
  hash to the curve) while it is held to the phone, in the first tap, and change
  may add no more than two seconds to that tap. So the change is cut plainly, in
  the powers of two the amount is made of, and the card makes the four largest:
  2,357 sats is 2048 + 256 + 32 + 16 + 4 + 1, of which the card makes the first
  four. The rest, the small tail, is made by the till after the swap and written
  at the change tap, as before 1.12 (a `change` token row beside the card's own;
  the log line says how it was split: `the card makes 2352 sats of the change
  itself, in 4 pieces (2048 + 256 + 32 + 16); 5 sats more are made here after the
  swap`). That tail leaves the card with the price as far as its day's limit and
  its wait are concerned, since the card cannot check what the till makes. So,
  when no set of pieces comes to the price exactly, a till takes among the sets that
  overpay least one whose change is four powers of two or fewer, if one overpays a
  little more (an eighth of the price, 64 sats at the least), and only where there
  is none does the tail take the road after the swap. Stocking the drawer's small
  sizes is a top-up's work (the owner's phone cuts the drawer, eight deep) and not
  a till's; a card of 1.12 was asked for eight pieces cut to the gaps in its
  drawer, and is still. A card with no opening free refuses the first request for
  change, and the payment is begun again with none asked of it. The card makes its
  pieces in the keyset of its first piece, which has to be the one in use at the mint;
  if it is not, the change is the till's.
- **The sheet says what the card is doing.** Between the pieces being named and
  the wait, the sheet used to say nothing: with seven pieces of change that was
  four seconds, and the holder pulled the card. Now each piece is said as the card
  is asked for it, `The card is making change · piece 2 of 4. Keep holding.`, and
  then the wait, if there is one.
- **Three buzzes (1.13), asked for and not felt.** When the card has signed and
  change is coming back to it in this sheet, the page asks the phone being paid
  for three buzzes, 0.15 seconds apart (a `triple` haptic; nothing else in the
  app asks for three), in place of the single quiet tap it asks for when the
  card may be lifted. Neither is felt: iOS plays no haptic of an app's while
  its own sheet is up, and the sheet is up through both. So that change is
  coming is said in words, `Paid. Keep the card here for your change.` on the
  sheet, and a payment within the limit waits for nothing either way. The
  buzzes stay in the code for the day iOS allows them, or for a sheet that is
  already down.
- **A lost answer comes back the same way**: the till asks the mint for the
  signatures by the blinded messages (NUT-09) when it finds the payment was made,
  and where the mint cannot say, notes it as due and asks again whenever it
  connects.
- **If a till never hands the change over**, the card's owner fetches it. The change
  is at the mint, locked to the card's key, so nobody can spend it but the card;
  and the card still has what each piece is made of until the piece is written
  back. So the owner's phone, reading the card on its FLASHCARD screen, reads the
  openings too (`GET_CHANGE`, no PIN), makes the blinded message each one was, and
  asks the mint for the signatures it already gave for them (NUT-09, `POST
  /v1/restore`, which answers the outputs it knows and no others). What comes
  back is kept as the row a till would have kept, before anything else is done
  with it, and put on the card in the same tap with the owner's own grant and no
  PIN: the blinding taken off, the DLEQ checked where the mint gave one, three
  pieces to a command, and the card lets each opening go as its piece lands. The
  sheet says `Keep the card there: asking the mint` and ends `Done. ₿280 of change
  is back on the card.` Openings this phone owes itself (it was the till) are not
  asked of the mint: it has the signatures, and the change tap finishes them as
  before. A phone that is not the card's owner reads none of this.

  The card's screen says where it stands, in one line under the balance for each
  state the change is in, dollars first and the sats after: `CHANGE OWED TO THIS
  CARD · $0.28 (₿280) —` **FETCHED AND PUT ON**; **FETCHED, WAITING TO GO ON** (the
  card left, or the tap could not wait; the next read, or the line in the warning
  colour, puts it on); **BEING FETCHED** (the mint had not answered when the tap
  went on: the answer is kept when it comes, and the line follows it);
  **NOT YET MADE BY THE TILL**; **NO CONNECTION TO FETCH IT**; **AT ANOTHER MINT**
  (the mint to ask is the card's); **THE MINT DID NOT ANSWER**; and **CANNOT BE
  FINISHED** (a signature that did not check out, kept apart as ever).

  Not yet made is the case where the till signed (the card burned its pieces and
  made its change) but never sent the swap, so the mint has signed nothing for the
  card's outputs. Nothing can be done for those from here and they stay openings,
  asked after again at every read; the holder's money is in the pieces the card
  burned, which the take-back by the refund key brings home after their date on a
  card that can be taken back, and which the till's swap finishes if it ever
  comes. Whoever finishes first wins and nothing is written twice: the card
  refuses a piece it already holds, and a till that taps afterwards finds the
  pieces on the card and writes nothing. The wait on the mint is fifteen seconds;
  a card is only to be held so long. What the mint learns is that something asked
  after outputs it signed itself, from a circuit of its own.

A card before 1.12 is paid as it always was, and the wait is by what its pieces
come to (*The limit on one tap*).

## The daily limit and the owner's phone

The limit is the most the card will sign for in one day. A card has none until
its owner sets one, and any amount may be set. Only the owner's phone sets,
changes or removes it, and it asks for no PIN.

**CHANGE LIMIT** on the card's screen first asks which of the card's two limits:
**PER TAP LIMIT** or **DAILY LIMIT** (*The limit on one tap*, below; a card whose
software has only the daily limit is not asked). Each has three steps and then a
tap. The daily limit's:

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
  that straddles a boundary can take up to two days' limit in a short time. The
  hours are the card's own clock's: from 1.15 the newest block header it has
  been shown, so a day turns when a block of a day later reaches the card, and
  a limit set before the card has seen any block begins its day with the first
  (*The time*).
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

### The limit on one tap

A second limit: the most the card pays in **one tap straight away**. It is set
the same way, by the owner's phone and no PIN, from PER TAP LIMIT under CHANGE
LIMIT: a warning, SET PER TAP LIMIT (`A per tap limit is the most this card
pays in one tap straight away, change or no change: the sheet says when change
is coming. Over the limit, the card has to be held
about 5 seconds, and 2 seconds more for every limit's worth beyond that. Lift
the card and the payment stops, with nothing taken.`; a card of 1.12 is told its
own rule), the amount (`What is the most this card should pay in
one tap straight away?`, with NO LIMIT under it), and a CONFIRMATION (`YOU ARE
APPLYING A PER TAP LIMIT OF:`). The card's screen then says `PER TAP LIMIT` and
the amount, or `PER TAP $2.00 · DAILY $5.00` where it has both.

This is the card that signs once for a payment (software 1.5). An older card's
second limit was a window of ten seconds of its clock, and refused; what
follows is the one a card has now.

- **It asks no clock, and refuses nothing.** The card's clock moves only when
  it is told something (*The time*), and before 1.15 whoever could tell it a
  time could turn a day, or a window of seconds. This limit counts nothing
  against time and remembers nothing from one payment to the next, so there is
  nothing to replay: a payment is judged by its own size, every time.
- **The drawer is cut to it.** A top-up onto a card with this limit cuts
  nothing larger than the largest power of two under the limit (*Adding
  money*). A limit set lower than pieces the card already holds asks the PIN
  at CONFIRMATION (`It holds $X in pieces larger than that: with your PIN
  they are recut under the new limit in the same tap`): in that one tap the
  money comes off, is swapped at the mint and goes back cut under the limit,
  which at a mint that charges for inputs costs what a withdrawal and a top-up
  cost. Without the PIN the card is left as it is, and its screen says what it
  holds above the limit.
- **A payment over it waits.** The card does signatures of its own work before
  it signs, and nothing is taken until that is done. From software 1.13: nothing
  within the limit (change or no change); about five seconds, seven signatures,
  for the first limit's worth over it, and about two seconds, three, for every
  limit's worth after that, less what the change the card made counts for: two
  for every three pieces from 1.14, one for each piece in 1.13 (a piece is about
  two thirds of a signature's work; one for one let a terminal shorten the wait
  with pieces of a sat). The till's screen says `Over the card's per tap limit.
  Keep holding` and how long it has been; how long is left it cannot say, because
  the card does not tell it. The limit's worth is of what leaves the card (*A
  card that makes its own change*).
  Software 1.12 waited four signatures, three seconds, for every limit's worth,
  ceil(what leaves / limit) of them, and for one when a payment within the limit
  made change. Before 1.12 the card waited by what its pieces come to, the first
  limit's worth free, so a small payment made with a piece worth twice the price or
  more waited too: the screen then says `Paying from a larger piece. Keep
  holding`, since it is the piece that is over the limit and not the payment.
  Lifted in the wait, the card has paid nothing and the till holds nothing; tapped
  again, it waits the whole of it again. A second payment in the same time in the
  field waits as one over the limit does (*A card that makes its own change*).
- **The limit is its owner's to know.** The card says it to the phone that
  holds its owner's key and to no other: a till reads none, and is told only
  "not yet" while the card waits, never how long. A till that knew the limit
  would charge just under it, over and over, and never be made to wait. It
  can still find it by trying, a second or so a try; that is time, once, and
  is all that hiding can buy.
- **What it buys.** A terminal that has the PIN can take one limit for each
  second or so that the card is held, by many small payments or one large one
  that waits, and no faster. Money leaves the card about as fast as an honest
  payment of that size would, so a card lifted when the payment ought to be
  over has lost about what it ought to have paid. It is a rate and not a
  ceiling: the daily limit is the ceiling, and that one does ask the clock.
- **It counts what leaves the card.** Before 1.12 that was the pieces signed, not
  the price, so the pieces for such a card were chosen to overpay the least where
  they could not come to the price exactly. From 1.12 it is the pieces less the
  change the card makes for itself, and overpaying costs no wait; but the part of
  the change the card does not make (more than four pieces, from 1.13) is made by
  the till, leaves with the price, and is counted.
- **A wait longer than a tap lasts is given up**: after forty seconds of "not
  yet" the till stops asking, with nothing signed, and says to take the
  payment in smaller parts (sixteen limits' worth is as much as a card of 1.13
  or later waits that long for).
- **It is kept in dollars.** The card holds sats and has no price. A limit typed
  in dollars is kept as dollars on the phone that set it
  (`foxy.flashcard.pace`), and when that phone reads its own card and the price
  has moved by more than a fiftieth, it sets the card's sats to match, with its
  proof and no PIN. Between those reads the card keeps the sats it has. A limit
  typed in sats stays in sats.
- **The owner takes money off at any limit**: both limits are lifted in one
  command and put back in one, and written down first, as the daily limit is.
  Its own withdrawal does not wait.

## The card's own log

The card keeps an account of its own taps, and nothing else writes it: a spend
writes it in the same step that burns the piece, and a spend the card refuses
for being over a limit writes it before it is refused. No command clears it or
sets it, for the PIN or for the owner, and its counts only go up. It is the one
record of a card's use that does not depend on any terminal being honest.

- **Four counts**: taps, sats signed for, spends refused for being over a
  limit, and runs of such refusals (below).
- **The last eight taps**, newest first: when (the card's clock; from 1.15 also
  the time the terminal told the card at that tap), sats signed for, how many
  pieces, how many refusals, and a mark.
- **A tap is one time in a phone's field**, from the card being powered to its
  being taken away. A terminal that cuts the field to begin again shows as more
  taps, and the counts count them all, so pushing the eight round hides nothing.
- **It records what was signed for, not the price.** The card cannot know a
  price, so it cannot say a payment was too much: the person compares.
- **TAMPER.** A terminal that keeps to the limits is never refused: it reads
  what the card has left before it asks. So three or more refusals inside ten
  seconds of the card's clock are a terminal trying the limit again and again,
  and the card marks that tap. One refusal at each of three visits is not that.
  It needs a limit to be set: a card with none refuses nothing. From 1.15 the
  card's clock moves only as it is shown newer blocks, so the ten seconds are
  the card's own, and three refusals before its clock next moves are one run;
  the log says `before its clock moved on`. A card that has been shown no block
  yet has no clock to tell visits apart by, so each of its refusals is a run of
  its own and it marks nothing: a false mark is worse than none.

The holder's phone reads it whenever it reads a card it owns (the owner's proof
opens it, with no PIN; a till is not shown it). The card's screen says nothing
of it unless the card has something to accuse: `TAMPER: a terminal tried 5
times to take more than this card's limit. Press here.` for as long as a marked
tap is among the eight, or, for a card before 1.15, `TAMPER: this card has been
told a false time. Press here.` What else the card did is in this phone's
history, which has it already.
The line opens **TAMPER ON THIS CARD**: the taps, the totals, and `Since this
phone last looked:` what has been added, which the phone works out from the
counts it saw last time (`foxy.flashcard.logseen`).

What it does not do: it says when and how much, never who; a terminal that
overcharges within the limits leaves no mark, only the amount; and the times in
it are, before 1.15, the times the card was told, which a terminal built to
cheat can choose. From 1.15 each tap has two: the card's own, a block's, which
nobody can choose, and the terminal's, a note, which it can (*The time*).

### What was put on, a false time, and receipts

A card of software 1.6 writes three more things, and its holder's phone reads
them with the log.

- **What was put on.** Each tap's line says what was put onto the card in it
  as well as what the card signed for: `$2.00 put on`.
- **A false time** (a card before 1.15). The card cannot know the time, but it
  can see being told it twice in one tap, more than two minutes apart, and
  marks that tap; and this phone can see a card whose clock is more than five
  minutes ahead of its own. Either way the card's screen says `TAMPER: this
  card has been told a false time`, and the log says which it was. A till
  whose own clock is wrong does the second by accident; a terminal walking the
  clock forward to turn the card's day does both. The daily limit rests on
  that clock and cannot be relied on while it is ahead. A card of 1.15 cannot
  be told a false time: its clock is a block header, which no one can make for
  a time that has not come. It writes no such mark, and neither screen speaks
  of one.
- **Receipts.** For every payment the card keeps when, what its pieces were
  worth, a hash of exactly what it signed, and the first output of the swap
  the money went into. It gives them to its owner's phone only, sixteen back;
  the phone keeps what it reads (`foxy.flashcard.receipts`). An output is
  made from its receiver's seed: nobody can tell whose it is by looking, and
  anybody shown a wallet's seed can make that wallet's outputs again and find
  this one among them. So a receipt does not say who took a payment; it lets
  a wallet be shown to be the one that did, or not. COPY RECEIPTS on the log
  copies them as text, for whoever has to be shown.
- **Two times, from 1.15.** A receipt is 73 bytes, and from 1.15 77: the card's
  clock (the newest block's time) and, beside it, the time the terminal told
  the card at that tap, a note the card trusts for nothing. The log's entries
  are 16 bytes, and from 1.15 20, with the told time at the end. The log shows
  each tap at the time the phone told the card with the block's beside it
  (`3:41 PM (block 3:30 PM)`), and COPY RECEIPTS gives both, in two columns.

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

A card has no running clock. It keeps a number and moves it forward, and what
moves it changed in software 1.15.

**From 1.15, the time is the newest Bitcoin block header the card has been
shown.** The card believes a header for the work in it, and not for who brings
it (`SET_HEADER`, 80 bytes, as the network carries them). It hashes them twice
and the hash, read as a number, must be at or under the target the header's own
difficulty (`bits`) names. That target must also be no easier than a floor built
into the card, and no easier than four times the target of the hardest header
the card has taken, which is a quarter of its work, so that headers made cheaply
later cannot stand in for the network's. A header later than the card's clock
moves the clock to the time written in it; an earlier one changes nothing and is
no fault, so a terminal that brings the header it has is never in the wrong. No
one can show the card a block from a time that has not come, because no one has
the work for one: a terminal, a phone and a stranger's reader all carry its
clock forward the same way, and none is trusted with it. There is no time key.
No PIN, owner or record is needed for a header and the card is in any state, a
blocked or locked card included, when it takes one. The floor is in the card's
software and rises with the network in each version, so a card set up years from
now starts from its own.

The bar a header must clear only climbs, and a network that fell to under a
quarter of its best would leave the card taking no real header again. The one
way out is a new record (the owner's, or the PIN's on an open card): it lets the
ratchet go. The hardest difficulty the card has taken is forgotten and the next
header sets it afresh, and the clock, its day and the hash of the last block
stay as they were.

A day's limit counts against that clock: a window of 24 hours of block time from
its start. A limit set before the card has seen any header has a window with no
start, which the first header it takes begins; until then the card spends its
first day on trust: it loads and spends up to the limit and no further, and
nothing answers `6A92` (never told the time) any more.

- **What a tap sends.** After the card has said what its clock reads, every
  phone sends it two things. The newest header the phone has kept, if it is
  later than the card's clock: once, and a card that is current is sent none.
  And the phone's own time (`TELL_TIME`), once in each time in the field. That
  one is a note, kept in the card's RAM and written into the receipts and the
  log entries made in that time. The card trusts it for nothing, and nothing it
  is told moves its clock or its day. A terminal that lies about it lies in its
  own entries, and the owner's screen shows it beside the block's, so the lie
  is seen. Neither command can fail a tap: a card that refuses a header keeps
  the clock it had.
- **Where the phone gets a header.** From two block explorers, mempool.space and
  Blockstream, each at its onion address, each on a circuit of its own, over Tor
  (`build/wallet/08b-block-headers.js`). When neither onion gave a header the
  phone could use (a fresh Tor can take longer to reach an onion service than
  the 25 seconds allowed), the same two are asked by their ordinary names
  through a Tor exit, as the price falls back from mempool's onion to clearnet
  sources. A header's trust is its work, so where it came from changes nothing;
  the exit learns what it learns from the price, that a Tor client asked for
  the newest block. It keeps a header only when it is 80
  bytes of the block the source named as its tip, its hash is at or under its
  own target, its time is within three hours of the phone's clock, and the two
  sources name the same tip. With only one answering, or one failing those
  checks, the other is taken on its word alone and the log says so. The newest
  good header is kept (`foxy.flashcard.header`). It is fetched when Tor comes
  up, when the app comes back to the front and when a card is tapped, if the
  one kept is older than ten minutes and the phone has a route, and not more
  than once a minute after a failure. A tap uses what is kept and never waits
  for the fetch. Nothing here runs on a timer.
- **What it takes from the phone's clock.** The phone's clock is the middle of
  the three hours a header's time is held to, and the note the card is told. It
  is not checked against the network's: the native side gives the page no view
  of the network's time, so the device clock stands alone. Tor itself will not
  use a consensus that is not current by its own clock, so a clock hours out
  tends not to get a route at all.
- **What the owner's screen shows.** Under the limits, `CLOCK · block 1fa7ca83… ·
  3:40 PM`: the eight digits after the zeros every block hash begins with (the
  eight at the front are always the same) and the time in that block, or `CLOCK
  · NO BLOCK YET`. A card with a day's limit and no block yet says `THE DAY
  BEGINS WITH THE CARD'S FIRST BLOCK`. The log shows each tap at the time the
  phone told the card with the block's beside it. Nothing says a card has been
  told a false time, because it cannot be. A card more than three hours ahead of
  the newest header this phone has kept is a line in the log, and nothing else:
  another phone or a till showed it a block this one has not fetched yet.
- **What it does not do.** A card that is never shown a newer block keeps its
  day where it was: a phone with no route keeps the header it fetched, which
  grows old, and a card tapped only there is no further on than that. The
  clock is the network's ten minutes at best, and a block's time is its miner's
  (the network accepts one up to two hours ahead of the real time). The card
  trusts the work in a header and no source for it, so who a header came from
  is of no account, and neither is any key.

**Before 1.15, the time was told under a signature, and was weak.** A card
before 1.15 keeps the latest time it has been told, and accepts a time only if
it carries a signature by the card's **time key**, which is written to the card
at set-up. The clock only moves forward. Every tap tells the card the time once,
before anything that depends on the day is read. Such a card is still told the
time that way, and set up with that key, until the last of them is gone.

**For those cards the time is the receiving phone's own clock, signed by a key
that is inside the app.** Its private half is a constant named `InterimCardTime`
in `Foxy/Flashcard/CardTime.swift`, and it is in this repository, in every copy
of the app, and in the tests. That is on purpose and is documented where it is
used. It makes the daily limit **as weak as trusting the receiver's clock** (the
limit on one tap asks no clock, and is not weakened by this):

- an honest receiver cannot be talked into taking more than a day's limit by
  accident, and the holder's own spending is held to the day;
- a terminal built to cheat can sign any time it likes, day after day in one
  tap, and with the card and the PIN take everything the PIN reaches. Against
  it the limit is no better than having none;
- a clock set far ahead on an honest phone signs that time too, and the card
  never takes an earlier one, so its day is frozen. The way out is for the owner
  to write the card a different time key while the card is empty.

No screen says that the limit stops an attacker, because on those cards it does
not.

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
- the card's clock needs no connection: the phone tells it the time (a note, or
  before 1.15 a signed time) and shows it the newest header it has kept (1.15
  and on), and the daily limit is looked at as ever, by the clock the card has;
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

Nine stores, named in `STORAGE.md`: ecash made for a card and not yet written to
it (`foxy.flashcard.owed`: a load, change, and the pieces of a payment the mint
refused; for a card that makes its own change, what the mint signed for it); pieces a card has signed for that the mint has not swapped yet
(`foxy.flashcard.taken`), which are the only copy of the right to spend them,
written down before the card is let go; the cards this phone loaded as recoverable; and when the mint last
said a card's pieces were good, so a phone with no connection can say `Verified 2
Hours Ago`; and the counts it last read from a card's own log, to say what is new; and, for a card that signs once for a payment, the swap each signature was asked for (`foxy.flashcard.swaps`), without which the signed pieces could not be swapped; the dollars a card's per tap limit was set in (`foxy.flashcard.pace`); the receipts read from this phone's own cards (`foxy.flashcard.receipts`); and the newest Bitcoin block header fetched for the cards' clocks (`foxy.flashcard.header`). The card's screen shows `Verifying…`, `Verified Just Now`, that, or
`Not Verified`.

**The card's face.** A card is drawn in a design named by a code of three
characters (`docs/CARD-DESIGNS.md` in the card repository): FL1 is Flash's,
FX1 is Foxy's, a picture of orange fur with a sleeping fox. A card of software
1.10 carries its code in its record, written at set-up and read back by every
phone; for a card before that, the phone that set it up writes the code it
chose on a note of its own (`foxy.flashcard.designs`, by the card's key: not
the list of cards it can take back, which a cash card is never on), and any
other phone draws it as FL1. This phone sets up its cards as FX1.


## What it does not protect against

The card repository's `FOXY-CARD-SPEC.md` §10 has the full list. The ones that
matter to a person:

- **A terminal built to cheat**, on a card before 1.15, whose time is interim
  (above). A card of 1.15 cannot be told a time it has to believe, but one that
  is never shown a newer block keeps its day where it was.
- **A receiver's phone that shows one amount and asks the card for more.** The
  limit does not check a payment, and nothing on the card can. Looking at the
  card's balance afterwards finds it out; it does not undo it.
- **The PIN, typed on a phone that may not be honest.** Whoever's phone it is
  typed on has it. A card of software 1.9 takes it sealed, which keeps it from
  anybody listening to the tap, then or later; it does nothing about the phone
  it was typed on. A pretend card can still collect a PIN typed for it: it
  signs its own PIN key with its own key, and a receiver has no way to know a
  stranger's card is real (it loses nothing if it is not). A card before 1.9
  is shown its PIN in the clear, over a few centimetres.
- **A terminal that puts points of its own choosing to the card's PIN key.**
  An envelope that does not open costs a try of the PIN, so a card with a PIN
  set allows two before it blocks. A new card's first PIN and an owner's
  change of PIN have no try to cost; if the chip's key agreement did not check
  that a point is on the curve, enough such askings could find the PIN key,
  and with it the PIN in any tap that was also recorded. The PIN key is not
  the key the card signs with, and nothing else is sealed to it.
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
  the clock a tap gives a card, the interim time key of the cards before 1.15),
  `build/wallet/08b-block-headers.js` (the block headers that clock is made of,
  fetched over Tor and checked) and `build/wallet/21a-flashcard.js` (set-up,
  adding and taking money, the owner's proofs).
- Native: `Foxy/Flashcard/` (`CardLink.swift`, the NFC session; `CardGate.swift`,
  which commands may pass; `CardTime.swift`, the interim time of the cards before 1.15), and
  `Foxy/Bridge/FoxyBridge+Flashcard.swift`. The bridge actions are in
  `THREAT-MODEL.md` §1, and the owner key's derivation is in `SEED-HANDLING.md`.
- Tests: `tests/flashcard-*.js` run in `tools/check-all.sh` against a model of
  the card held to the applet's own conversation. `tests/flashcard-fewer.js` pins
  the cash-drawer cut and the exact sets it makes; `tests/flashcard-clock.js`
  pins the card's clock: three real block headers at the card's real floor and
  mined ones at a cheap floor for the rules a real one cannot reach, the fetch
  from two explorers over a fake Tor and what it will not believe, a tap that
  sends the header only when the card is behind and never waits for a fetch,
  and what the log, the receipts and the CLOCK line make of it;
  `tests/flashcard-release.js`
  pins the card being let go before the mint, a refusal and its put-back tap, a
  lost answer, and the circuit made ready as the sheet opens. `tests/flashcard-applet.js` is
  opt-in and drives the wallet against the applet itself over a local port.
  `tools/live/flashcard-switch.js` moves a card between two local mints.
  `DEVICE-TESTS.md` §23 is what only a card and a phone can show.
