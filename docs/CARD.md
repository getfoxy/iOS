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
   Foxy's first. Tap a new card behind the phone.
2. The card's screen reads `This card is new. Set it up to put money on it.`
   Press **SET UP THIS CARD**.
3. A card of software 1.16 and on is set up with **no PIN**, and nothing is asked: the sheet comes up at once and the tap
   begins (SET UP THIS CARD, then the tap, then the card's screen). Its owner adds a PIN whenever they want one, with
   **ADD PIN** on that screen (*The PIN*, below). A card of an earlier software cannot be without a PIN, so it is asked for
   one first: **CHOOSE A PIN**, four to eight digits, then **TYPE IT AGAIN** (the PIN pad is the lock screen's; the second
   pad takes the first one's place in the same turn and with no fade, so the card's screen is never seen between the two).
4. One tap writes the PIN (none, for a card of 1.16 and on), then the card's record (this phone's mint, and for
   a card before 1.15 the time key), and last the owner key. The owner goes in last so that no step
   needs a proof; a set-up cut off anywhere is finished by the next set-up tap.
5. The card's screen, with a line: `The card is set up.` (with a PIN and with none alike; back from it is where the person
   was). Nothing is read between the pad (or, for a card of 1.16 and on, the button)
   and the tap, and nothing after it; the screen is the card's own, with ADD FUNDS. What two notices used to say stands: this
   phone is the card's owner, so it can reset the card's PIN and limits, and
   whoever holds the card and this phone's seed phrase holds its money; and a
   card is cash, so whoever has it and its PIN has what is on it, and a lost
   card's money is gone.

No limit is asked for and none is suggested. A new card has none. From software 1.16 the PIN
is left out by default (*No PIN, and the no-PIN allowance*, below): the tap writes the record and the owner only,
and the card is cash to whoever holds it from that moment. Nothing at set-up says so; ADD PIN's first pad does (below).

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

## No PIN, and the no-PIN allowance (software 1.16)

From software 1.16 a card's PIN is optional. This is the phone's side of it; the card's is in the card
repository's `FOXY-CARD-SPEC.md` and `FOXY-CARD-DAILY-LIMIT.md`.

- **A card may have no PIN.** `cardSetUp(link, { recoverable })`, with no `pin`, writes the record and then the owner
  and nothing else: no PIN is set or shown, and the tap is one command shorter than before. Such a card pays with no PIN,
  is loaded and emptied by its owner's grant as any card is, and has its per tap and daily limits set by the owner's
  proof as any card does; those limits apply to every payment, PIN or not. It has no allowance, and nothing asks for one
  (`cardSetLimit` with `noPin` says `no-pin`, and the card refuses it all the same, `6985`). A card of an earlier
  software cannot be set up without a PIN (`old-card`), and neither can a card that has a PIN already (`has-pin`: a set-up
  cut off after the PIN, whose PIN this phone does not know).
- **ADD PIN.** `cardAddPin(link, { pin })`: the owner's grant in the tap, then the PIN sealed as at set-up. One tap. It
  works on a card that holds money (the money stays), refuses a card that has a PIN (`has-pin`, which is CHANGE PIN's), a
  phone that is not the owner (`not-owner`, at no cost) and a card of an earlier software (`old-card`). The card's
  allowance is nothing when a PIN is added: every payment asks for the PIN until the owner sets one.
- **The allowance.** A card with a PIN may carry a third limit, the most it signs for in a day WITHOUT the PIN. It shares
  the day's window with the daily limit (the same clock, the same day), and only payments signed for with no PIN count
  against it. `cardSetLimit(link, { sats, noPin: true, usd })` sets it (or `noPin: <sats>`; zero is none), as the owner, in
  the twelve-byte form of the owner's limit command: the day's limit and the limit on one tap as the card has them, so
  neither's window or count begins again, and then the allowance. An allowance whose number does not change keeps its
  count; a new number counts from nothing in the window as it stands. Set in dollars (`usd`), it is kept in dollars on
  the phone that set it, apart from the limit on one tap's, and followed with the price as that limit is: the owner's
  phone sets the card's sats again when it reads the card and the price has moved by more than two in a hundred
  (`card.repacedNoPin`; `cardNoPinUsd(key)` is the dollars).
- **What the phone reads.** `info.noPin` is `{ limit, spent }`, from bytes 34 to 41 of the long answer to GET_INFO,
  which the card gives to anybody (a till needs them to know whether to ask for the PIN; the limit on one tap, bytes 30
  to 33, is still the owner's alone). `card.noPin` is `{ known, set, limit, spent, left, turns }` worked out over the
  day's window as the daily limit's `card.day` is: `left` is the allowance less what is spent when the window is
  current, and the whole of it when the window is over; with no block header yet the window has no start and does not
  end, so the count runs from set-up (`onTrust`). `info.pinSet` is whether a PIN exists, and `info.setUp` whether the card
  is set up at all (a record, and before 1.16 a PIN as well). `cardNeedsPin(card, net)` is whether the card will ask for
  its PIN to sign a payment that takes `net` sats off it: no for a card with no PIN, no for an allowance with `net` or
  more left, yes otherwise, and always yes for a card of an earlier software.
- **At a till, the tap comes first.** `cardPay(link, { sats })` with no `pin` shows the card none. The card is read; if
  it has a PIN and the allowance does not cover the payment (never less than the price and the mint's fee), the call
  rejects at once with `pin-needed` and `early: true`, before the card is asked to begin anything, with `need` (what the
  payment takes off the card, at least), `set` (whether there is an allowance) and `left` (what is left of it). Otherwise
  the card is begun and asked to sign, and signs with no PIN. The card's own answer is the truth: if it is asked and
  answers `6A94` at the signature, the call rejects with `pin-needed` and `sw: '6a94'`. The card has signed nothing and
  given the payment up, as it does for a limit, and the phone's row for it goes with it: nothing asked for, nothing
  taken, nothing owed. The error carries `sheetText`, `Enter the card's PIN`, so the sheet ends with that line as a note and not in red. The person is asked for the PIN, and the card is tapped again with `pin`. With the PIN the payment
  is as it ever was, and counts nothing against the allowance. A card of an earlier software always rejects `pin-needed`
  early when no PIN is given, since it would waste a tap. A signature the card gave under the allowance and whose answer
  was lost is given again with no PIN; one it gave with the PIN is given again with it, and the call says `pin-needed`
  with `again: true` and keeps the signature asked for.
- **The log.** A tap in which a payment was signed for under the allowance (a PIN set, none shown, the allowance
  covering it) is marked by the card, and `card.log.last[n].noPin` is true. A payment on a card that has no PIN is not
  marked: it has no PIN to be without.
- **Change.** The tap after such a payment writes the change back with no PIN, by the note the card makes that it has paid,
  as it does after any payment. A card with no PIN is loaded by whoever holds it, as it is spent by whoever holds it; the same goes for freeing its used places and for reading its log and receipts. What stays the owner's is the limits, ADD PIN, the mint and the lock.

- **The screens.** All of them are the app's own, reused: the PIN pad, `blockedCard`
  dialogs (with `pills` for a third pill-shaped button), the SET AMOUNT keypad and the confirmation shell, and a toast for
  a one-line outcome.
  - *ADD PIN* stands where CHANGE PIN stands, on a card that is set up and has no PIN (`fc.setUp && !fc.pinSet`). Its first
    pad is CHOOSE A PIN, with the line `A card with no PIN is cash to whoever holds it. Four to eight digits.`, then TYPE IT
    AGAIN, then one tap, and the toast `PIN added. Every payment asks for it until you set a no-PIN limit.` A phone that is
    not the owner is told NOT THIS PHONE'S CARD before a pad is raised.
  - *NO PIN LIMIT* is the third button of CHANGE CARD LIMITS, shown only on a card that has a PIN. Its three steps are the
    daily limit's: the warning SET NO PIN LIMIT (`A “No PIN” limit is the most this card will pay in one day without
    requiring your PIN.`, `Once you reach your limit, the PIN is asked for every payment until the next day.`, then who can
    change it, then CONTINUE or CANCEL); the amount, in dollars first,
    `What is the most this card should pay in a day without its PIN?`, with NO LIMIT under NEXT, which is none, 0, and then
    every payment asks for the PIN; and the confirmation, `YOU ARE APPLYING A NO PIN LIMIT OF:` or `YOU ARE REMOVING THIS
    CARD'S NO PIN LIMIT.` with `Every payment will ask for the PIN.` One tap, no PIN, and the toast `No PIN limit set.` or
    `No PIN limit removed.` Typed in dollars, it is kept at them (`cardNoPinUsd`). Nothing about it is shown on a card with no
    PIN, which cannot have one.
  - *The card's screen* says `NO PIN UP TO $10` in the limit line on the card's face when it is the only limit, and in a line of its
    own under the balance, `NO PIN UP TO $10 · LEFT TODAY $4`, beside the daily limit's and the limit on one tap's.
  - *The log* says `no PIN` at the end of the line for a tap in which the card signed under the allowance.
  - *Every flow that asked a card for its PIN* asks a card that has none nothing: WITHDRAW, renewing, moving to another mint,
    adding funds from a phone that is not the owner's, and the recut that a per tap limit can need.
  - *At a till*, *Paying at a till*, below.

## Resetting a card (software 1.17)

From software 1.17 a card's owner can give it back to what it was in its packet, so that another person can set it up.
This is the phone's side; the card's is in the card repository's `FOXY-CARD-SPEC.md`.

- **What the card does.** RESET (instruction 51, P1 = 0, P2 = 0xAD) under the owner's proof over `FoxyCard/reset` and an
  empty value (nothing else may follow it). The card then has no PIN (three tries), no owner, no record, no limit, no
  allowance, no log, no receipts, no change in hand and no lock, and **a new key** (the old key tied two owners' payments
  together). It keeps its clock (what it reads now and the hash of the last header; the ratchet goes to nothing, as a new
  record does it) and its software. It refuses a card with anything unspent on it (`6A8D`), one with no owner (`6A90`), a
  proof that is not the owner's (`6A91`), and a LOCKED card whose PIN was not verified in the same tap (`6982`); an
  unlocked card asks for no PIN, and a blocked PIN is no bar to it (the owner is resetting, not unblocking).
- **The owner's key.** The proof is the owner's, so native signs for a sixth label, `reset` (empty value). A lock and the
  time are still not signed for.
- **`cardReset(link, { pin })`.** Reads the card as its owner, proves ownership, verifies the PIN first where the card is
  locked, and sends RESET. Resolves `{ reset: true, key }` (the card's old key). Rejects, with `card`: `old-card`
  (before 1.17), `no-owner`, `not-owner` (these words are not the card's; costs no try), `has-money` ("Take the money off
  the card first."), `locked` (a locked card and no PIN, said before the card is sent anything), `bad-pin`, `wrong-pin`,
  `blocked` (a locked card whose PIN is blocked cannot be reset), `gone`, `change-owed` and `unsettled` (below). Nothing is
  changed by any of them. The key the tap had kept (`link.one`) is forgotten, so a read after it asks the card for its new key.
- **`cardEmptyAndReset(link, { pin, on, progress })`.** For the app: a card holding money has all of it taken off to this
  phone (as WITHDRAW all does, with the owner's proof) and is then reset, in the one call and the one tap. Resolves
  `{ reset: true, key, withdrew, hash }`. Everything that can be known is checked before the money moves, so a card that
  cannot be reset is not emptied. If the card goes after the money came off, the rejection carries `withdrew` and `hash`; the
  card is then empty and the next tap resets it.
- **What it will not lose.** A reset wipes the card's record of the change it made for itself (what the mint's signatures are
  unblinded with), and that change is locked to the key the reset destroys. So the owner's read first finishes it (asks
  the mint, puts the pieces on the card, in this tap; `cardEmptyAndReset` then takes them off with the rest), and where it
  cannot (no road to the mint, the till has not made its swap) the card is not reset: `change-owed`, "The card is owed
  change from its last payment. Tap it once more first.", with `owes.openings`. In the same way, ecash this phone has made
  for the card and not yet written to it, change it is due, a signature asked of the card and never seen, and a payment
  held from a cut-short tap are `unsettled` (`owes`: counts and `sats`). `cardReset(link, { abandon: true })` resets all the
  same and gives up the rows owed to the old key; the pieces stay locked to it, and a card set up as recoverable gives
  them back to this phone's key after their date (`cardTakeBack`).
- **What the phone forgets, and keeps.** Of the old key: the pace rows (the dollars a limit was set in), the receipts it
  copied, a lifted limit's note, when the card was last checked, the design it noted for it, and where its log was read to.
  It keeps the card's row among the cards it can take back (a piece the card signed away that its receiver never swapped is
  still this phone's to take back after its date), and the withdrawal that emptied the card is an ordinary history line;
  the reset has no line of its own.
- **The wait.** Software 1.18 asks ten signatures for the first limit's worth over the limit on one payment and four for
  each after; 1.17 asked ten and three, 1.13 to 1.16 seven and three. `info.waitOver` and `info.waitMore` say which a card
  has, and `cardWaitSigns` and `cardWait` take them as their last arguments (without them, seven and three).

### The screens

- **The card's screen.** The title has two lines under it for a card of 1.15 and on: `Verified At 11:42am` and
  `Block #970809` (above). **HISTORY**, what has been done with this card on this phone, is the round button at the top
  left, for any card with a record. The limit line is on the card's own face, at the bottom left of its picture: `NO LIMIT`,
  `DAILY LIMIT $5` and so on, and for a card with no PIN a bar and `NO PIN`: `NO LIMIT | NO PIN`, `DAILY LIMIT $5 | NO PIN`.
  A card with a badge (`Blocked`, `Locked`, `No PIN yet`, ...) has it above the line, at the same left edge. The old CLOCK
  line is gone. The line sits where the design puts BEARER at the bottom right, with the margins BEARER has, mirrored: its
  first letter about 8.5% of the card's width in from the left edge (BEARER's last letter is that far from the right), and the baseline of
  its last line as far above the bottom as BEARER's is (7.0% of the width on FL1, 6.4% on FX1, 5.8% on EL1: measured from the
  markup and from `img/card-fx1.png`). It is drawn as BEARER is, in each design: on FL1 in BEARER's own type (Sora, 2.86% of the card's
  width, semi-bold, tracked 0.24 em, white at 42%); on FX1 in the picture's ink (a dark brown, `#1A0A04`) at the size, weight
  and tracking that match the picture's lettering (2.5%, bold, 0.3 em); on EL1 in BEARER's grey (`#BDBDBD`, 2.5%, bold,
  0.32 em), 7.7% in from the left. All of it is in percentages of the card's width
  (`cqw`), so it holds at any width; a long line wraps, balanced, within 66% of the width and never reaches BEARER (the
  space before the dot of `PER TAP $2.00 · DAILY $5.00` does not break, so a line never begins with it).
  The row under ADD FUNDS and WITHDRAW is **RESET** (a card of 1.17 and on, for its owner), **CHANGE PIN** (**ADD PIN** on a
  card with none) and **LIMITS**, drawn as the receive screen's NOTE, COPY, SCAN and CARD: a round button, its drawing, its
  label under it. All three are the owner's; a card before 1.17 has the two it can offer. The card is drawn in the design it
  names (`FL1` stays `FL1`, before and after set-up); a card that names none is drawn in, and given, this phone's own.
- **RESET.** The first button of that row (a circular arrow), for the owner of a card of 1.17 and on (a locked
  card is offered it to any phone holding it: only the card can say whose it is; on another phone's unlocked card, and on
  an older card, it is not in the row, and a call that reaches it says `NOT THIS PHONE'S CARD` or `NOT ON THIS CARD`). It opens one warning:
  what is wiped (the PIN, the owner, the limits, the log; a new key), that the card is then anyone's to set up, and, when
  it holds money, that the money comes off to this phone first. **CONTINUE** goes to one tap (`cardEmptyAndReset`;
  the sheet says `Keep holding.`); a locked card, or a card with money and a PIN, asks for the PIN on the pad first
  (`CARD PIN`, button `RESET CARD`). Then Home, with `The card is reset.`, and the screen is no longer on that card.
  If the money came off and the reset did not, `EMPTY, BUT NOT RESET` says so, with `TAP CARD` to finish. The wallet's
  own refusals are the usual cards: `MONEY ON THE CARD`, `THE CARD IS OWED CHANGE`, `MONEY ON ITS WAY`, `WRONG PIN`,
  `CARD BLOCKED`.
- **FLASHCARD on the send screen.** The fifth button, under TYPE (the five are a little shorter, so the camera pane and
  everything above it are as they were). It puts money onto a card held to this phone, any card: SET AMOUNT first (the keypad
  every amount is typed on), NEXT, and the sheet at once. The card is read, and a card with no PIN has its pieces made and
  written in that tap. A card with a PIN ends the sheet `Enter the card's PIN` with nothing made; the pad comes up (`CARD PIN`,
  button `TAP AGAIN`), and the second tap makes the pieces for that card's key and writes them with the PIN
  (`cardPrepare`, then `cardWrite` as a till writes change). A wrong PIN leaves them owed to the card, and TRY AGAIN asks for
  the PIN to put them on. On success: Home, and the card `ON THE CARD`. Offline it says so and goes no further.
- **HOW TAP LIMIT WORKS** says its seconds as "~", worked out from the card's own counts as what the screen behind the sheet
  reaches on a card held well (`fcWaitSecs`: about 3.3 seconds for the read, the pieces and the change, then 0.58 seconds an
  asking, as measured on a phone, shown as the whole second the count comes to): `~1–4 SEC TAP` within the limit, then ~9,
  ~11 and ~13 for a card of 1.18 (ten askings, then four more for each further limit's worth), about 9, 10 and 12 on 1.17, about
  7, 9 and 10 before it. The limit's confirmation says the same first figure for the card over the limit
  (about 7 before 1.17), and 2 more for every limit's worth beyond.

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
   while the swap runs, then the states of a tap. Then the card's own screen is back, and no card is raised
   over it: the balance on it counts up, from the figure it showed to what the card holds now (the card as that tap
   read it after the write: its balance, its limits, what is left today), over about a second, with home's own ease
   (`runBalanceAnim`'s: 1.15 seconds, an ease out; a phone set to reduce motion is shown the new figure at once).
   What the balance cannot say is a line: that the card was moved to this phone's mint by the same tap, and that
   more than was asked for went on, so that the card holds fewer pieces. (Money put on a card from the send screen,
   which leaves the person at Home, and a renewal are still said by a card, **ON THE CARD**.)

If the card leaves early, or the tap is cut short by Foxy being put away, the
pieces wait on the phone. The card's screen shows a line in the warning colour, `₿500
is waiting to go onto this card. Press here, then tap it.`, and the next tap
writes them. Putting money on a card does not touch its limit. THE CARD IS FULL
if it has no room for the load: take some money off it first.

## Paying at a till

On the receiver's phone: RECEIVE, an amount, then **CARD**, beside TAP.

**The tap comes first, and the PIN is asked only if the card wants it.** CARD brings up the sheet and the tap at once, with
no pad before it. The card is read; a card with no PIN, or one whose no-PIN allowance covers the payment, signs in that tap
and the payment goes on from step 3 as below. Otherwise the sheet ends with `Enter the card's PIN` (a note, not red;
nothing was signed or taken), and the pad comes up: **CARD PIN**, `To pay $0.43 (₿500). The card's owner types its PIN
here.`, with the button **TAP AGAIN**, grey until four digits are in. Back from it is the invoice. TAP AGAIN begins the second
tap, which pays with the PIN, as the rest of this section describes. The card's own answer decides: if the read said
the allowance would cover it and the card says `6A94` at the signature, the sheet ends the same way and the same pad comes
up. A wrong PIN comes back to the same pad, with TRY AGAIN, as it always did. *No PIN, and the no-PIN allowance*, above.

A card of an earlier software always wants its PIN, and the phone cannot tell it from one that does not before it is tapped, so
it too is tapped first and ends that tap asking: one tap more than it used to take. (The refusals that need no PIN, a payment
over a limit, more than the card holds, a mint that is not this one, no connection and the price a card cannot make
exactly, are said in that first tap, with no pad.)

1. **CARD PIN**, for a card that wants one: the pad above. In the order below, step 2 is the first tap
   for a card that needs no PIN, and the second for one that does.
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
   right to spend them), and then the sheet ends with `Done.` The
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
Foxy's and changes during a tap. Foxy's own screen sits behind it, from the
design (`build/app/26h-tap-screen.js`): a card comes down behind a phone with
three waves rising, and under it a title and the amount. The sheet takes the
bottom of the screen; nothing is drawn there but CANCEL, under the sheet's own.
iOS ends a session after a minute.

The sheet's line, by step:

| Step | The sheet's line |
|---|---|
| waiting | Tap behind the phone. |
| reading | Reading the card (and Scanning. Hold still. from the phone's link) |
| signing | Signing piece 3 of 9 |
| the card's change (1.12 and on) | Making change 2 of 4. |
| a wait (1.13: only over the limit) | Over per tap limit (then `x2` as the second limit's worth begins, `x3` the third, and so on: ten askings for the first on 1.17, seven before it, three for each after) |
| a wait for change, or a second payment in one tap | Keep holding. |
| the change is owed (the owner's read) | Asking for change owed. |
| signed | Done. (the sheet ends here), or Hold for change. when change is coming |
| writing | Writing 2 of 4 |
| asking again | Hold for change. / Hold for the rest. / Hold to finish paying / Tap to put back signatures. / Tap behind the phone. |
| the card wants its PIN | Enter the card's PIN (a note, not an error) |
| the mint refused a payment | Payment did not go through. |

The screen behind it has two grounds and says one thing in each state. While no card
is connected it is light blue (ink #0F2A33, no fur); from the moment the phone's
link reports a card connected until the card is lost or the sheet ends it is orange
(#EB6A2E, ink #1A0A04, the fur over it). The card in the picture is the card
screen's own face at 250 px: FX1 is the picture and FL1 the face drawn in CSS, by
the card's design, and FX1 at a till until a card has been read. It loops (comes
down, the waves rise) while a card is wanted, and stays settled behind the phone
once it is there; for a person who asks for less motion it is just drawn settled.

| Title | When | Ground | Card |
|---|---|---|---|
| TAP BEHIND PHONE | waiting for the first contact (CANCEL is here only) | light | loops |
| KEEP HOLDING · 7 s | in contact, the card being asked; the seconds count up from the contact, a whole second at a time, with no estimate (change takes it past two seconds, a wait over the limit past five) | orange | settled |
| VERIFYING CARD | the card has signed and is still there: the mint is asked, and change is fetched or written | orange | settled |
| REMOVE | the card has signed and is let go, nothing more is wanted of it | orange | settled |
| TAP FOR CHANGE | the card has signed and contact broke before the change went on, or the second tap of a payment is waiting for the card | light | loops |
| PLEASE TAP AGAIN | contact broke part way and the same sheet asks for the card again (also the tap after the PIN pad, and a refused payment going back on the card) | light | loops |
| ENTER PIN | the sheet ended asking for the PIN; the pad is up over the screen, which goes with the pad's back button, or is taken up by the tap that follows it as PLEASE TAP AGAIN | light | settled |

There is no countdown anywhere: the till cannot know the count, and the card does
not say it. Each title is one line, made smaller on a narrow phone if it would not
fit. The screen is drawn from what the wallet reports and what the phone's link
says (`connected`, `lost`); the sheet's lines are not repeated on it.

A flow that goes on to speak to the card again (a renewal writes to it, a move
reads it last) holds it instead, as it always did: the sheet stays open through the
mint (`Asking the mint`) and its change is written back in
the same tap.

Each result is one of the app's own cards, with a title, a line or two and one
or two buttons. The ones a payment can end in:

| Result | Says |
|---|---|
| the paid confirmation | the usual one; the entry is marked as a card's |
| (the sheet ends `Enter the card's PIN`) | the card wants its PIN for this payment; the pad comes up, and TAP AGAIN pays with it |
| WRONG PIN | the tries left, and that nothing was taken; TRY AGAIN |
| CARD BLOCKED | too many wrong PINs; the card pays again when its owner sets a new PIN on it |
| NOT ENOUGH ON THE CARD | what it holds |
| OVER THE CARD'S DAILY LIMIT | what is left of today, and when the day turns; said before the PIN is sent |
| OVER THE CARD'S PER TAP LIMIT | how long the card would have to be held to pay this (longer than a tap lasts), its per tap limit, and what can be taken at a time; said before the PIN is sent. A charge that waits less than that is not refused: the sheet says `Over per tap limit`, and the level (`x2`, `x3`) as it goes on. (An older card, whose limit was a window: the most it pays in one tap, or what the tap has left) |
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

1. **SEND.** The PIN, and the first tap, under KEEP HOLDING. The card signs its
   one or two pieces and may be taken away.
2. **VERIFY.** The phone's sheet stays up and says `Hold for change.` while the swap runs and the change is made; Foxy's screen
   behind it says VERIFYING CARD. "Paid" first, since the card's part is over
   the moment it has signed, and the words are what say so: iOS plays no
   haptic of an app's while its own sheet is up. (The sheet used to say `Remove
   the card`, which beside its own Cancel read as finished, and it was closed
   before the change.)
3. **RECEIVE.** The same sheet says `Tap the card again for its change` and the
   screen says TAP FOR CHANGE (VERIFYING CARD once it is found); the tap writes it, with no PIN: the card allows
   the tap after a payment to load. The sheet ends `Done. ₿212 of change is back
   on the card.` A card that leaves while its change is being written has used
   that one tap up, and wants its PIN for the rest: the same sheet asks for it
   again (PLEASE TAP AGAIN) and gives it the PIN typed for this payment, so nobody is
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
change, with TAP FOR CHANGE up from the payment until that tap is over, so the
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
  another lands a few sats over). Over it the card does seven signatures of work
  (ten from software 1.17: `info.waitOver`),
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
  it waits the till's sheet says `Over per tap limit` (and `x2`, `x3` as each
  further limit's worth begins), and nothing of how long; a card of 1.12 for its first limit's worth said `Keep
  holding.` The day's limit is held at the card's
  first SIGN and not at the start of the payment, so a refusal comes after the
  outputs and the change were sent, and gives the payment up: the swap's row is
  dropped, nothing is burned.
- **One payment a tap at full speed (1.13).** A second payment signed in the
  same time in the field waits as one over the limit does, seven signatures (ten from 1.17) and
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
- **The change tap is as before**: the second tap, no PIN, TAP FOR CHANGE. The till
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
  is asked for it, `Making change 2 of 4.`, and
  then the wait, if there is one.
- **Three buzzes (1.13), asked for and not felt.** When the card has signed and
  change is coming back to it in this sheet, the page asks the phone being paid
  for three buzzes, 0.15 seconds apart (a `triple` haptic; nothing else in the
  app asks for three), in place of the single quiet tap it asks for when the
  card may be lifted. Neither is felt: iOS plays no haptic of an app's while
  its own sheet is up, and the sheet is up through both. So that change is
  coming is said in words, `Hold for change.` on the
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
  sheet says `Asking for change owed.` and ends `Done.` Openings this phone owes itself (it was the till) are not
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

(From software 1.16 the day's window is also the no-PIN allowance's: it begins at the first payment when either is set,
and when the day turns both counts go to nothing. A daily limit that is set or changed begins the window again, and with
it the allowance's count; a limit on one tap that is set leaves both. *No PIN, and the no-PIN allowance*, above.)

The limit is the most the card will sign for in one day. A card has none until
its owner sets one, and any amount may be set. Only the owner's phone sets,
changes or removes it, and it asks for no PIN.

**LIMITS** on the card's screen first asks which of the card's limits,
under CHANGE CARD LIMITS: `Which limit would you like to add or change?`, with
**PER TAP LIMIT**, **DAILY LIMIT** and, on a card that has a PIN (software 1.16
and on), **NO PIN LIMIT**, each a button, and CANCEL (*The limit on
one tap*, below; a card whose software has only the daily limit is not asked;
the third is *No PIN, and the no-PIN allowance*, above).
Each has three steps and then a tap. The daily limit's:

1. A full-screen warning, SET DAILY LIMIT: `A daily limit is the most this card
   will spend in one day.` and `If you lose the seed phrase for this Foxy app,
   the limit can never be changed.` and `Do you wish to continue?` CONTINUE or
   CANCEL.
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
LIMIT: **HOW TAP LIMIT WORKS**, a screen that plays the rule as a short
animation and leaves it on the screen as a list (`Any payment request over your
limit requires you to tap and hold your card longer.`, an EXAMPLE LIMIT of $10,
then `$0.01 – $10.00` 1–4 SEC, `$10.01 – $20.00` 9 SEC, `$20.01 – $30.00` 11
SEC, `$30.01 – $40.00` 13 SEC for a card of 1.18, the seconds the screen behind
the sheet reaches worked out from the card's own counts, `And so on…`; a tap skips the statement on the
screen, and a phone that asks for less motion is shown the list at once), with
CANCEL and CONTINUE once it has played (a card of 1.12, which pays exactly or
holds the card, is told its own rule in a warning instead), the amount (`What is the most this card should pay in
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
  within the limit (change or no change); about five seconds, seven signatures
  (ten from 1.17: about eight seconds),
  for the first limit's worth over it, and about two seconds, three, for every
  limit's worth after that, less what the change the card made counts for: two
  for every three pieces from 1.14, one for each piece in 1.13 (a piece is about
  two thirds of a signature's work; one for one let a terminal shorten the wait
  with pieces of a sat). The till's sheet says `Over per tap limit`, and `x2`, `x3` as
  each further limit's worth begins; how long is left it cannot say, because
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
- **No PIN, from 1.16.** A tap in which a payment was signed for under the no-PIN allowance (a PIN set, none shown)
  carries a mark for it, and the owner's log says so beside the tap; a card with no PIN marks nothing. A payment the card
  refused for want of the PIN (`6A94`) is nothing in the log: it is not a refusal over a limit and no part of a run of them.

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

On a card that has no PIN (software 1.16 and on) the button reads **ADD PIN**: two pads, `CHOOSE A PIN`, with a line that a
card with no PIN is cash to whoever holds it, and `TYPE IT AGAIN`, then a tap, and a toast. *No PIN, and the no-PIN
allowance*, above. The rest of this section is for a card that has one.

**CHANGE PIN** takes two pads, `NEW PIN` and `NEW PIN AGAIN`, and a tap. The old
PIN is not asked, because the owner's phone does not know it; the card takes the
owner's proof in its place. It ends at `PIN CHANGED`.

**WITHDRAW** is an amount, or `ALL OF IT`, the PIN (not on a card that has none), and a tap. The card is let go
the moment it has signed, as at a till, and is not read again afterwards. It ends on the card's own screen, with no card raised
over it, and the balance on it counts down over about a second from the figure it showed to what the card holds now. The screen
knows the card without reading it: the wallet gives back the card as the tap read it at its start, less the pieces it signed
for (`cardAfterTake`, the result's `card`), or, where the change went back onto the card in the same sheet, the card as that tap
read it after. So the balance, the pieces and the places are the card's; and where the card has a daily limit, which a
withdrawal by the owner's phone lifts and puts back, the day has begun again: the whole limit is left, and the day turns 24
hours on from the card's own clock. A mint that has not answered (the CHECKING screen) hands the same card on, and the screen
comes back to it once the mint has said paid. (A move to another mint, and a renewal, hold the card, and read it at the end.)

A withdrawal of many pieces takes longer than a person holds a card. If the card
leaves part way, what it signed is kept: it is in the phone, with an entry of its
own, and the screen says **TAP THE CARD AGAIN**, how much came off and how much
is left. TAP CARD takes the rest with the PIN already given, and IN YOUR WALLET
then says the whole amount (a withdrawal cut short takes the card's screen away, as what it knew of the card is out of date;
one that goes on in the same sheet, with the card asked for again, does not). LATER ends the withdrawal; the rest stays on the card.

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
  one kept is older than two minutes and the phone has a route, and not more
  than once a minute after a failure. A tap uses what is kept and never waits
  for the fetch. Nothing here runs on a timer.
- **What it takes from the phone's clock.** The phone's clock is the middle of
  the three hours a header's time is held to, and the note the card is told. It
  is not checked against the network's: the native side gives the page no view
  of the network's time, so the device clock stands alone. Tor itself will not
  use a consensus that is not current by its own clock, so a clock hours out
  tends not to get a route at all.
- **What the owner's screen shows.** Under its title, two lines: `Verified At 11:42am` (the time the mint's word was last had, in the
  phone's clock) and the block the card's clock is at, `Block #970809` (its height, where this phone has it: it keeps the last twenty
  blocks' heights), else the eight digits after the zeros every block hash begins with (`Block 1fa7ca83…`), or `No block yet`. A card with a day's limit and no block yet says `THE DAY
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
said a card's pieces were good, so a phone with no connection can say `Verified At 9:15am`; and the counts it last read from a card's own log, to say what is new; and, for a card that signs once for a payment, the swap each signature was asked for (`foxy.flashcard.swaps`), without which the signed pieces could not be swapped; the dollars a card's per tap limit was set in (`foxy.flashcard.pace`); the receipts read from this phone's own cards (`foxy.flashcard.receipts`); and the newest Bitcoin block header fetched for the cards' clocks (`foxy.flashcard.header`). The card's screen shows `Verifying…`, `Verified At <time>` (with the day after it when not today), or
`Not Verified`.

**The card's face.** A card is drawn in a design named by a code of three
characters (`docs/CARD-DESIGNS.md` in the card repository): FL1 is Flash's,
FX1 is Foxy's, a picture of orange fur with a sleeping fox; EL1 is the beaker, drawn
in CSS and SVG with its liquid flowing and bubbling and the beaker swaying (still
under Reduce Motion), the same block in `build/markup.html` and, for the face
behind the sheet, `FC_EL1_FACE`. A card of software
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
  `tests/flashcard-nopin.js` pins
  software 1.16: a card with no PIN, ADD PIN, the allowance and its dollars, the early and the card's own `pin-needed`
  with nothing left pending, the shared window, the log's mark, and a card of 1.15 that keeps asking for its PIN;
  `tests/flashcard-reset.js` pins software 1.17: the model's RESET byte for byte, `cardReset` and `cardEmptyAndReset` and every
  refusal, what is forgotten and kept, a card set up afresh by another person, change the card is owed, and the ten-signature wait;
  `tests/flashcard-release.js`
  pins the card being let go before the mint, a refusal and its put-back tap, a
  lost answer, and the circuit made ready as the sheet opens. `tests/flashcard-applet.js` is
  opt-in and drives the wallet against the applet itself over a local port.
  `tools/live/flashcard-switch.js` moves a card between two local mints.
  `DEVICE-TESTS.md` §23 is what only a card and a phone can show.
