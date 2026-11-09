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
  not known, nor the mint's proofs a card of 1.20 keeps with its pieces (*What
  Verified says*, below), of which a load writes one piece to a command and
  nobody has timed it on a card. The list of what only a
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
  use a card at another mint, TRANSFER it (below). A top-up never moves a card that holds
  money: ADD FUNDS at another mint says to withdraw all of it. On an empty
  card, the owner's phone is offered SWITCH TO <its mint> there, and the card's
  record is rewritten in the tap that writes the funds; the PIN, owner, limit
  and clock stay as they were. A card that holds money is moved, money and all,
  by TRANSFER in the card's MENU, on the phone that owns it: the mint list, a
  confirmation with the card's mint's fee, the Lightning fee and the new mint's
  fee, and one tap that takes the money off, crosses by Lightning, tells the
  card its new mint and puts the new pieces on (`cardTransfer`). A dollar card
  going to a mint with no dollars becomes a bitcoin card there, which the
  confirmation says first. A tap cut short leaves the money owed to the card or
  noted in this phone, and the card's screen finishes it
  (`tests/flashcard-transfer.js`, `tests/flashcard-switch.js`).
- **Every card can be taken back.** A card is set up so that the phone that
  loaded it can take its money back after its date (fourteen days from when it
  was put on) if the card is lost. Set-up asks nothing about it, and FLASHCARD
  lists the cards this phone loaded, with TAKE BACK for any past its date
  (`FC_RECOVERABLE` in `build/app/26f-flashcard.js`). A cash card set up before
  reads and pays as what it is.
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

The same file carries the Associated Domains entitlement, `applinks:getfoxy.io`,
that lets a card's address open Foxy (*Tapping a card to open Foxy*, below). It is
a paid team's capability too: the app's identifier needs it enabled in the
developer account, and the site's association file has to name the app for the
path `/card`. Without the file there is neither, and a card held to the phone
opens the site's page in Safari and not Foxy.

## Tapping a card to open Foxy

A Foxy card of software 1.19 answers as an NFC tag as well as a card. The tag
carries one address, `https://getfoxy.io/card`, and it is the same on every
card. No part of it belongs to one card and none ever will: the address is a way
to open Foxy, not a name for the card, and nothing in it, or in the page behind
it, can tell one card from another.

- **On the lock screen, or from any app.** With the screen on, iOS reads a tag
  held to the top of an iPhone (XS and later) by itself and shows a banner. A tap
  on the banner opens the app the address is associated with, which is Foxy:
  its build carries the associated domain `applinks:getfoxy.io`
  (`tools/flashcard.entitlements`) and the site's association file names it for
  the path `/card`. A locked phone asks to be unlocked first, as it does for any
  banner.
- **With Foxy open.** The banner comes up over Foxy, and a tap on it comes back
  to Foxy.
- **On a phone without Foxy**, or with a build that has no entitlements file, the
  same tap opens the page on the site in Safari, which says what the card is.
- **A card whose tag is switched off raises nothing.** It is read as it always
  was, by MENU > FLASHCARD and the sheets that ask for it.

iOS hands Foxy the address and no session with the card. Foxy checks the address
(`Foxy/Flashcard/CardAddress.swift`) and tells its page one thing, that a card
was tapped. Nothing of the address goes with it. The page then does what
MENU > FLASHCARD does: it goes to the Flashcard screen and begins the tap
(TAP TO READ, and the phone's own sheet), and the card, which is usually
still behind the phone, is read by that sheet. A card that is no longer there is
asked for like any other: hold it again.

Whether it does that depends on what is on the screen, and one function says
(`cardTapRule`, `build/app/26f-flashcard.js`):

| on the screen | what happens |
|---|---|
| HOME; HISTORY, CONTACTS, a transaction, LOGS, SWITCH, or the Flashcard screen itself with no sheet up | the tap begins; a drawer or the list of apps that sell bitcoin is shut first |
| Foxy is locked (its PIN pad or Face ID is up), or still starting (the launch screens, the first-run warning, the Tor gate's screens) | the request is kept, and acted on once the person is in, if that is within a minute; after that it lapses |
| a send or receive, an amount being typed, a confirmation, a sending or paid screen, a split bill, a token, a restore or a backup, a card sheet or any of a card's flows, a notice, or anything else drawn over the screen | ignored: a card resting behind the phone must never pull a person out of a payment |
| a second request while one waits or is being acted on | the same tap, ignored |

What is on screen decides first, so a payment under the lock is ignored there and
then and not kept to be acted on later. A screen the function has not been told
about is ignored, and `tests/deep-links.js` fails until a new screen is named in
it. It works offline and while the connection is still coming, as the menu's
row does: reading a card needs no network. Each outcome is one line in the log
(`card tap: …`), and none of them carries anything of the address.

The phone keeps the request when the address arrives before the page can take it,
which a launch from the banner always does, and tells the page when it can: not
under the launch image or the app-switcher cover, and not before the page has
been told Foxy is back from the background, so that the lock a return raises is
up before a card is heard (`Foxy/Flashcard/CardTapDelivery.swift`). It asks again
until the page answers, and gives up a minute after the address arrived.

Anything else that opens the address does what a tap does: a link, a page, a QR
code. It reads nothing and moves no money, and it is ignored in the middle of a
payment (`THREAT-MODEL.md` §1).

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
4. One tap writes the PIN (none, for a card of 1.16 and on), then the card's record (this phone's mint, with zeros where a time key once was), and last the owner key. The owner goes in last so that no step
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

### Software 1.21 and on: the steps, their defaults, and no connection

A card of 1.21 and on holds no money without a PIN, so its set-up asks, in order (`build/app/26j-card-wheel.js`): NAME CARD,
CREATE A PIN and RE-ENTER PIN, CURRENCY (at a mint with two balances), then three amounts on SET AMOUNT and MAX PER SECOND,
then one tap, whose screen behind Apple's sheet is titled **TAP TO FINISH**.

| Step | Asks | Comes up at |
| --- | --- | --- |
| NO PIN AMOUNT | `What is the most this card should pay in one transaction without asking for your PIN?` | $10.00 |
| NO PIN MAXIMUM | `What’s the most this card should pay in total before asking for a PIN?` (1.21 to 1.24, whose allowance the PIN fills again); `… in 24 hours before asking for a PIN?` on 1.25 | three times NO PIN AMOUNT ($30.00 for the default) |
| MAX PER SECOND | the rate, six figures to choose from | $10 a second |

NO PIN MAXIMUM follows NO PIN AMOUNT (going back and changing it changes the default) until it is typed by hand; then it
keeps what was typed. Each default is in dollars, the keeper's default currency, and is kept as dollars for a bitcoin card
as any figure typed in dollars is, so that this phone sets the card again when the price has moved. The keypad stays in
dollars offline, at the last price this phone saw (kept on the disk, with its age said under the figure); it is in sats only
on a phone that has never seen a price. A dollar card's amounts are dollars always.

The tap needs the mint, so the route is looked at before TAP TO FINISH is shown and again as the tap fires. With none,
**NO CONNECTION** says so in the wallet's own words (`Foxy is working offline. This needs a connection — tap OFFLINE to
reconnect.`, or `Foxy is securing its connection. Try again in a moment.` while one is on its way, which is waited for a
few seconds first), with **TRY AGAIN** and **BACK**, and no sheet is opened. A tap that fails for any reason, the route
lost between NEXT and the tap among them, or a sheet ended with no card, comes back to the same choice: TRY AGAIN runs the
tap again with every entry as it was, and BACK (or a tap beside the card) is MAX PER SECOND again with the rate, both
amounts, the PIN and the name kept. Nothing goes back to the start; the entries are dropped only when the card is written
or the round back buttons are walked out of the set-up on purpose.

Figures typed in dollars offline were turned into sats at the last price this phone saw, of any age. They are worked out
again from the dollars just before the write, at this phone's own price and only one less than a day old (`fcRatePrice`):
typed at a price half today's, the card still takes the dollars meant, not twice them. With no such price the set-up is
refused with **NO BITCOIN PRICE**, TRY AGAIN and BACK, and nothing is written. CARD LIMITS does the same for a bitcoin card's
limits typed in dollars, and SEND > FLASHCARD in dollars to a bitcoin card loads the sats those dollars are at the price of
the tap. TRY AGAIN writes to the card the set-up began on and no other: another card held up is **THAT IS ANOTHER CARD**,
with nothing written to it. The kept entries, the PIN among them, live only in the page's memory and are forgotten as Foxy
locks or is put away; a TRY AGAIN left on the screen then says to start again, and a set-up still being typed goes back to
the card's screen, to be begun again.

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
- **NO PIN AMOUNT, this phone's own rule.** The card has no figure for one payment without the PIN: its allowance is a
  total, over 24 hours on 1.25 (and refilled by the PIN on 1.21 to 1.24), and a payment within what is left of it is
  signed whatever its size. So the set-up asks NO PIN AMOUNT (`What is the most this card should pay in one transaction
  without asking for your PIN?`) before NO PIN MAXIMUM, the allowance, and LIMITS' NO PIN LIMIT asks it too, and the figure is
  kept on the phone that set it, never on the card: `cardSetNoPinTx(key, n, unit, usd)` (`n` cents or sats, 0 for
  none), read with `cardNoPinTx(key)`, in the same stored row as the dollars of the card's limits. **It is not restored
  from the seed phrase and it is gone when the card is reset**: a restored phone, like any other phone, asks nothing
  above it, and the confirmation says so. A card set up for its holder from SEND is not asked it (it would be kept on
  the paying phone, not where the card pays). A bitcoin card's rule typed in dollars is kept as those dollars and weighed
  in sats at the price of the day (this phone's last, while fresh), at the sats it made when typed where there is none. `cardNeedsPin` then
  says yes for a payment over it, so `cardPay` with no PIN rejects `pin-needed` early, before the card is asked for
  anything (with `limitReached` false: it is this phone's rule, not the card's LIMIT REACHED), and the PIN is asked and
  the card tapped again as for any payment over the allowance. A rule in dollars weighed against a payment in sats, or
  the other way, is turned at the card's rate, and with none the PIN is asked. Another phone, a till among them, does not
  know it: there the card pays up to what is left of its allowance with no PIN, as it always has. The card cannot hold
  to it until its software has such a figure (the smallest change: a fourth four-byte figure in the owner's limit
  command, the most one payment signed without the PIN may take off the card, checked at the signature beside the
  allowance and refused as the allowance is, and given back in GET_INFO's long answer).
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
  - *The card's menu* says it under **LIMITS**: `No PIN up to $10.00 · $4.00 left today`. The card's screen says nothing of
    limits; its HISTORY has a row for the limit on one tap.
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

- **The card's screen.** Its title is the card's name alone. Under it: the card's picture, in the design it names (`FL1`
  stays `FL1`, before and after set-up; a card that names none is drawn in, and given, this phone's own), with its badge under
  it where it has one (`Blocked`, `Locked`, `No PIN yet`, `Not finished`); the card's mint and its balance in home's pill (two
  pills for a card of 1.23 that holds both); the warning box for what the card itself waits on (a tamper it marked, a renewal, a
  backup to move, a transfer to finish); and **DEPOSIT** and **WITHDRAW**. **HOME** is the round button at the top left and the
  card's menu (≡) the one at the top right: **HISTORY**, **RENAME CARD**, **LIMITS**, **CHANGE PIN** (**ADD PIN** on a card with
  none), **TRANSFER**, **SWAP** (a card of two currencies only, where it was a button under DEPOSIT and WITHDRAW) and **RESET**,
  each where the card and this phone allow it. **DEPOSIT** on a card of 1.23 that takes both currencies, at a mint with both, asks
  the amount first (SET AMOUNT, in dollars or sats as any payment from either balance is typed) and then which balance pays,
  offering only the ones this phone holds enough of (`fcAddWhich`): both cover it, `ADD WHICH TO THE CARD?` with both; one covers
  it, that one with nothing asked; neither, where the deposit can be asked for by invoice, the same question with both offered and
  marked `BY INVOICE`, the one chosen going on to the invoice as before (`fcDepOpen`); where it cannot, both greyed `NOT ENOUGH ON
  THIS PHONE`, and back to the amount.
  What follows the choice is as it was.
- **The card's HISTORY.** What has been done with this card on this phone, and at its top, in that list's own rows, what the
  card's screen does not say (`fcHistNotes`): what the mint says is already spent (`The mint says $ 0.25 is already spent`, red,
  with `WITHDRAW ALL or RESET clears it off the card` under it); money waiting to go onto a card (`$ 2.55 is waiting to go onto
  HHH`, amber; a press goes back to the card's screen and is the tap that puts it on from there, as the box on that screen was,
  `fcHistWrite`); how fresh the mint's word is (`Verified At 8:06am`, `Not
  Verified`, `Verifying…`, grey; *What Verified says*, below); and the card's limit (`Per second limit $30`, `Per tap limit`, `No
  limit`, with `No PIN` for a card without one, grey; a card whose one limit is a daily one has no row); what it holds in pieces above its limit (`In pieces above the
  limit`, grey) and the change it is owed with where that stands (`Change owed to this card`, grey; FINISH THIS CHANGE and GIVE UP
  THIS CHANGE stay on the card's screen). A list with these rows and no payments does not say `NOTHING TO SEE YET!` under them. A
  card with no record has no menu and so no HISTORY: money waiting for a card stays an amber line on its screen.
- **The ring.** While the mint's word stands, the card's ≡ button turns a red ring (home's `foxyRing`) and HISTORY in its menu
  has the same ring, a red label and a soft red glow (home's BACKUP row's `alertGlow`); while money waits to go onto a card the
  same in amber (`#F7931A`, `warnGlow`); red over amber when both. Both stop when the state clears: WITHDRAW ALL or RESET has the
  card let the spent pieces go, and the waiting money is written (`fcAlert`, `fcAlertLook`).
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

   More than this phone holds in the card's currency, online and at this phone's
   own mint: the app's receive invoice for the whole amount (RECEIVE's screen,
   with its tap to pay), the card behind it. The newest block header for the
   card's clock is asked for as the invoice goes up, while the payer pays
   (`fcDepOpen`, `headerWarm`). When the money has come in, PAID shows for the
   moment it takes to reach the card's screen, and the card's PIN pad comes up at
   once (a card with no PIN: the sheet), with nothing asked in between. The pieces
   for the card are made at the same moment, while the PIN is typed, so the sheet
   opens as the PIN goes in, with no GETTING IT READY (`fcDepArrived`,
   `fcDepLoad`, `fcAddPrep`). The load is the amount typed by the steps below.
   Backed out of the PIN: pieces already made, or still being made, are owed to
   the card like anything made for a card. They are locked to it, kept on this
   phone, and written at its next tap ("… is ready for the card. It goes on at
   the next tap."). Where none could be made, the money stays on this phone and
   can be spent, its history row titled "For the card · kept on this phone"
   (`fcDepKept`). What the phone held before is not touched. With no connection
   it says what this phone holds, as before.

   Where the time goes (a phone's log, 2026-11-06, $25.00 at a card of two
   balances, 51 pieces). Before: PAID, then TAP THE CARD AGAIN and the PIN (13 s of
   pressing and typing), the swap that makes the pieces (1.2 s under GETTING IT
   READY), the card found (1.4 s), its read (2.8 s, of which 2.45 s is the card
   proving its key), the PIN, the owner's grant and freeing used places (1.2 s),
   the write (51 pieces with the mint's proof, one command each, 11.3 s, about
   220 ms a piece: a slowed tap, made just after Foxy came back; a settled phone
   writes a piece in about 89 ms), and the read after it (0.3 s). The header fetch
   (10.3 s, three requests in series to each explorer, the two explorers side by
   side) ran while the person pressed and typed. The tap never waits for it,
   before or now. Now: the PIN pad at once, the swap under the PIN, and the
   header in two rounds, not three. On a card held still, the critical path after
   the PIN is the card: its read, the grant and the write.
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
   **eight of each size from 1 to 1,024**, a whole set at a time (one of every
   size, then two of every size, and so on, the smallest first), and the rest
   of the amount in powers of two. 16,376 sats fill that drawer, in
   eighty-eight pieces, and it pays eight prices in a row exactly, whatever
   they are, up to 2,047 sats each. What the card holds counts towards each
   size, so a top-up fills what has been spent from first.

   **Five seconds a tap** (decided 2026-11-06: "the first load should not
   spend more than 5 seconds signing/loading"). The drawer is not written in
   one tap. A tap is budgeted at 110 ms for each piece written (89 ms was
   measured on a phone held well; the margin is for a phone less settled),
   plus what the tap does besides: 1.6 s for a load's read, the card's proof
   of its key and the PIN or grant, and 3 s for a payment's read, signing and
   wait. So a load writes at most 30 pieces and a payment's change at most 18
   (`cardTapBudget`, 08a-flashcard.js "five seconds a tap"). A card's
   **first load** is one binary set ("one binary set on first load"): one of
   each size from 1 to 1,024, and the rest cut so that every price up to the
   whole stays exact (each piece no more than one past what the pieces before
   it reach). $25.00 is sixteen pieces, about 3.4 s by the budget; $123.45 is
   eighteen and $1,000.00 twenty-two. Only an amount in the millions is more
   than thirty pieces would make whole: 1,310,000 sats is exact for every price
   up to 261,424. So a first load pays **one** price exactly offline, any price
   up to the whole, and any number online. **A second payment to a phone that
   is offline is refused** unless its price happens to be made of what is left
   (NO CHANGE WHILE OFFLINE): the drawer deepens at the next online tap that
   writes to the card. A debug build launched with `-FoxyFirstDepth N` cuts
   first loads N deep for that run, to test the depth on a phone (DEVICE-TESTS
   §23g). Every later tap that writes, a
   top-up or a payment's change, deepens the drawer with what it writes, the
   smallest size still short first, a whole set at a time, inside the tap's
   pieces. With $25.00 top-ups the card holds 1, 2, 3, 4 and then 6 whole sets
   after the first load and each of four top-ups (16, 36, 46, 59 and 78 pieces,
   no tap over 3.8 s; `flashcard-tap-time.js`). A payment's change refills only
   with what comes back: a payment is not made to overpay for it, since on a
   card of 1.13 and on what the card signs for counts against its limit and its
   wait.

   The phone's own part is kept short. Pieces with the mint's proof go to the
   phone in lists of eight (`cardSendMany`), which sends them to the card back
   to back and stops at the first it refuses: one trip each way for eight
   pieces, every command the size it always was. The sheet's "Writing i of n"
   changes at most every half second. While a card's sheet is up, the page's
   background work waits for it (`cardAfter`): the held quote sweep, the
   Foxy ID's inbox opened again, the small-change top-up, the adding up of
   the books. A write that went whole is not followed by a read: the card is
   known from what was read before and what went on (`cardAfterWrite`). Any
   other write reads it again. The card's proof of its key (AUTH, 0.6 s on a
   contact reader, up to 2.6 s on a phone) is kept in the read before a load:
   leaving it out is the keeper's to decide.
   A card with a **per tap limit** is cut to it: nothing larger than the
   largest power of two under the limit, so a payment under the limit is never
   made from a piece the card waits for. Where that is more pieces than the
   places left (a small limit on a large balance), the places fill with pieces
   under the limit and the rest goes in larger ones; the card's screen says how
   much, `$X IN PIECES ABOVE THE LIMIT · A TILL HOLDS LONGER FOR THOSE`.
4. A tap writes them; a write that went whole is not read back (what went on is known), any other is. The screen says `GETTING IT READY`
   while the swap runs, then the states of a tap. Then the card's own screen is back, and no card is raised
   over it: the balance on it counts up, from the figure it showed to what the card holds now (the card as that tap
   knows it after the write: its balance, its limits, what is left today), over about a second, with home's own ease
   (`runBalanceAnim`'s: 1.15 seconds, an ease out; a phone set to reduce motion is shown the new figure at once).
   What the balance cannot say is a line: that the card was moved to this phone's mint by the same tap, and that
   more than was asked for went on, so that the card holds fewer pieces. (Money put on a card from the send screen,
   which leaves the person at Home, and a renewal are still said by a card, **ON THE CARD**.)

If the card leaves early, or the tap is cut short by Foxy being put away, the
pieces wait on the phone. The card's HISTORY has an amber row at its top, `₿500
is waiting to go onto this card` with `Press here, then tap it.` under it, the card's menu button
turns amber, and the next tap writes them. Putting money on a card does not touch its limit. THE CARD IS FULL
if it has no room for the load: take some money off it first.

The keypad says so before the tap. The card on show was read a moment ago, so
the wallet is asked as the amount is typed whether the card's free places hold
what it is cut into (`cardLoadFits`: the cut `cardPrepare` makes and the check
it refuses on, one function). An amount they do not hold is red, NEXT is off,
and the line under the figure reads MORE THAN THE CARD CAN TAKE; NEXT pressed
all the same says the words of the refusal above. A load needs its pieces and
the four places a write keeps back, so a card with fewer than five places free
takes nothing, and one with few takes the amount rounded up to fewer, larger
pieces. FLASHCARD on the send screen has no card on show and is capped by
this phone's balance alone, as it was.

## Paying at a till

On the receiver's phone: RECEIVE, an amount, then **CARD**, beside TAP. A receive into the dollar balance (a mint with two
balances) has the same **CARD** once the mint has made its invoice: the card pays the sats that invoice names, never a figure
priced on the phone, and those sats pay the invoice, so the dollars land as they would from any payer. The invoice lives as
long as the mint says: with under fifteen seconds of it left, CARD asks for a new code first; and where it runs out while the
card is read, no payment of it is sent and the card's sats stay as bitcoin (PAID IN BITCOIN). A split bill has the same **CARD** on each payer's own
screen, in the row beside SHARE, COPY and SCAN (four, as the receive invoice screen's row; the Bluetooth tap sits in the QR), for that payer's share: one share to a tap, ticked (and the screen moved on
to the next payer) when the mint has given this phone its pieces, as *Paid* below says, and not before. The share's row in the
bill's ledger names the payment's entry from the moment the card has signed, so a payment the mint answers late (CHECKING closed
first) ticks its share when it lands, as a share paid by its invoice late does; one a card paid while this phone was offline is
received at once, and its share is ticked then.

In the till (POINT OF SALE) the receive screen is for the payer in front of it: no NOTE, COPY, SCAN or CARD under the
code, and the big button in SHARE's place reads **PAY WITH FOXY CARD** and does what CARD does, the dollar-card path
included. It is greyed and does nothing exactly where CARD would not be offered: a cashier's till, and a dollar receive
offline with no invoice where cards are not taken offline.

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
**CHECKING**, then **STILL CHECKING**, and the phone goes on asking. The screen
behind the card's sheet says the same words by the same wait (see the table
below), so that it does not tell a person to remove a card that is long gone.
It ends as paid, or as money that goes back on the card. A timeout or a lost answer is not
a refusal: the swap record and the signed pieces are kept, and the wallet's own
recovery (`recoverSwaps` on the next connection, then the card's own settling)
makes the payment or finds it was made. If the mint refuses, see *A payment the
mint refuses*.

### What the person sees

Apple's sheet comes up whenever the phone is looking for a card. Its big title
and its CANCEL belong to iOS and cannot be changed. One line of text on it is
Foxy's and changes during a tap. Foxy's own screen sits behind it, one of the
card tap family of the keeper's 2026-11-06 design (`build/app/26h-tap-screen.js`):
a title at 34px spaced out, the amount at 76px under it, and over the top of the
screen an arrow bobbing up and TAP CARD BEHIND THE TOP. The sheet takes the bottom
of the screen; nothing is drawn there but a pill under the sheet's own. iOS ends a
session after a minute.

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

The screens of a card tap are one family, and only the words change from one flow
to the next. Each is a ground, the title, the amount, three dots where something is
being waited on, a paragraph and a chip where there is something to say, and its
pills at the foot. The status bar is the phone's own. For a person who asks for less
motion the dots and the arrow stand still.

| Screen | Ground (ink) | When | Pills |
|---|---|---|---|
| 1a WAITING | light blue #D6EEF4 to #A9D6E2 (#0F2A33) | the sheet is up and no card is in contact: the flow's TAP TO ..., with the arrow and TAP CARD BEHIND THE TOP; ENTER PIN while the PIN pad is up over it | CANCEL until the card has been asked anything |
| 1b GETTING READY | light blue | the phone is making the pieces it will write (ADD FUNDS), before any sheet; slower dots | CLOSE (the pieces then wait for the next tap) |
| 1c IN CONTACT | orange #FF9A5C to #D9561C (#1A0A02) | the card is being read or is signing, and while it has signed and is still there for its change; faster dots | CLOSE |
| 1d CHECKING | teal #1A3C47 to #081C22 (#F2FAFC) | the card has signed and been let go, and the mint is asked; STILL ... once the wait the CHECKING screen makes has run out (a first asking 3 seconds after the card is let go and then one every 5, a dozen in all). The same screen is the CHECKING screen after a tap (`fcChecking`) and the one over a code a card paid (`fcCardVerifying`) | CLOSE |
| 1e TAP AGAIN | yellow #FFE7A8 to #EDB236 (#2A1A00) | a load whose card was not read: "The card wasn't read. This money is still waiting to go onto it." (back onto it, for a payment's change) and the lock, "Only this card can receive it." (`fcStillWaiting`) | TAP CARD, LATER (it stays owed, as before) |
| 1f TAP AGAIN | yellow | a payment whose card was not read and signed nothing: "The card wasn't read. Nothing has been paid yet." and the shield, "Your money is still on your card." (`fcMissedPay`) | TAP CARD, CANCEL |
| 1g CARD LOST | red #E8503F to #B82A1E (white) | the instant the phone's link says the card has gone mid-tap: "The card moved away too soon. Hold it still behind the top of the phone." with the shield where the card had signed nothing, the lock where money is to go onto it (a load, or a payment's change), and no chip for a payment taken up again after the card left part way | TRY AGAIN (the same sheet is asking already: back to 1a), CANCEL (ends the sheet) |

The words by flow (`FC_TAP_FLOWS`; a tap names its flow, `fcTap`'s `o.flow`):

| Flow | 1a | 1c | 1d |
|---|---|---|---|
| a card paying an invoice or a request (`pay`) | TAP TO PAY | PAYING | CHECKING |
| money going onto a card: ADD FUNDS, SEND to a card, a card set up and loaded, owed money written (`load`) | TAP TO LOAD | RECEIVING | CHARGING |
| a payment's second tap, its change; a till's bound change put back (`change`) | TAP FOR CHANGE | RECEIVING | CHARGING |
| reading a card, its owner's or a guest's (`read`) | TAP TO READ | READING | VERIFYING |
| WITHDRAW (`withdraw`) | TAP TO WITHDRAW | WITHDRAWING | CHECKING |
| SWAP (`swap`) | TAP TO SWAP | SWAPPING | CHECKING |
| TRANSFER to another mint, and its write (`move`) | TAP TO MOVE | MOVING | CHECKING |
| RENEW, and a backup moved to this phone (`renew`) | TAP TO RENEW | RENEWING | CHECKING |
| RESET (`reset`) | TAP TO RESET | RESETTING | CHECKING |
| SET UP (`setup`) | TAP TO FINISH | SETTING UP | CHECKING |
| CHANGE PIN, ADD PIN (`pin`) | TAP TO SET PIN | WRITING | CHECKING |
| LIMITS (`limit`) | TAP TO SET LIMIT | WRITING | CHECKING |
| the card's rate (`rate`) | TAP TO SET RATE | WRITING | CHECKING |
| giving up change owed (`write`) | TAP CARD | WRITING | CHECKING |
| tying a card to this phone, and any tap that names no flow (`card`) | TAP CARD | READING | CHECKING |

Which screen the one behind the sheet is, by where the tap has got to (the look is
kept on the screen as `data-look`, the screen as `data-scheme`):

| Look | Screen | When |
|---|---|---|
| hold | 1a | waiting for the first contact |
| keep | 1c | in contact, the card being asked |
| verify | 1c | the card has signed and is still there: the mint is asked, and change is fetched or written (RECEIVING once the change has been asked for) |
| remove | 1d | the card has signed and is let go, for as long as the phone's sheet may still be showing (until it is seen to go, or a second and a half after the card signed) |
| checking | 1d | then, while the mint has not answered |
| still | 1d | once the wait has run out: STILL CHECKING (STILL CHARGING, STILL VERIFYING) |
| change | 1a | the second tap of a payment, waiting for the card: TAP FOR CHANGE |
| change | 1g | contact broke after the card signed and before its change went on |
| again | 1g | contact broke part way, and the same sheet asks for the card again |
| again | 1a | a tap that begins again with nothing asked of the card yet: the tap after the PIN pad, a refused payment going back on the card |
| pin | 1a | the sheet ended asking for the PIN; the pad is up over the screen, which goes with the pad's back button, or is taken up by the tap that follows it |

**How CARD LOST settles.** It is shown the moment the phone's link reports the card
gone (`Foxy/Flashcard/CardLink.swift` sends `lost` when a command to the card fails
or the session ends; 26f's `fcTap` is told the same when the wallet asks the sheet
for the card again), but only for a card that was in the field: CardLink sends
`lost` too when iOS ends a sheet no card came near (its own Cancel, its minute run
out), and then the screen stays as it was and the cancel says nothing, as before.
It stays until one of three things:

1. The card is found again (`connected`): the tap goes on, 1c.
2. The card had signed before it went (the wallet's steps reached `mint` or
   `checking`): the payment goes on at the mint, 1d, and then RECEIVED (1h) at the
   phone being paid.
3. The tap ends without it. The wallet's error says what happened (`card` in
   `build/wallet/21a-flashcard.js` and `08a-flashcard.js`), and the tap's own record
   of what its screen saw goes with it (`tapLost`, `tapSigned`, `tapAmount`):
   - a payment whose card left before it signed (`gone`, the sheet then closed
     on it), or whose sheet was dismissed after CARD LOST (`cancelled` with
     `tapLost`): TAP AGAIN, 1f;
   - a load whose card left with nothing written (`gone`), or whose sheet closed
     with no card read: TAP AGAIN, 1e;
   - any other flow (withdraw, swap, reset, a read, ...) ends on the card it always
     did (THE CARD LEFT TOO SOON); whether those get a TAP AGAIN of their own is the
     keeper's to decide;
   - a card that left part way through signing (`interrupted`) is taken up again in
     the same sheet as it always was (`Hold to finish paying`), and where that sheet
     is dismissed it is NOT PAID YET, as before, with CANCEL putting back what it
     signed: not 1f, for some of it was signed.

1e asks for the card as the card it replaced did, so a payment's confirmation held for
its change still waits while it is up; 1f rests, and holds nothing.

CLOSE on 1c and 1d takes Foxy's screen down and nothing else (its time-out goes with it): the tap goes on under
the phone's sheet, or at the mint, to its end, which is said as it always is, and
the same tap does not draw the screen again.

There is no countdown anywhere: the till cannot know the count, and the card does
not say it (the seconds KEEP HOLDING once counted are gone with it). Each title is one line, made smaller on a narrow phone if it would not
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
| (the receive closes, and PAYMENT RECEIVED) | no connection, and the card proved its money and signed it over: a line says Foxy settles it with the mint when it is online |
| TOO OLD TO PAY OFFLINE · CANNOT PROVE ITS MONEY · NOT THE MINT'S MONEY | no connection, and a card that cannot pay this phone so; said before the PIN |
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

## Paying from the card: SEND on its screen

SEND on the card's own screen opens the phone's SEND MONEY in card mode
(`fcOutMode`, 26f-flashcard.js): WITHDRAW, PASTE, CONTACTS and TYPE. What is read
goes to the phone's own confirmation with a FROM / FLASHCARD row and NEXT for
SEND. NEXT reads the payment's total off the card exactly as a till reads it
(the PIN, the per tap limit and its wait, the card's own change), and the pieces
the card pays are held for that payment alone (`cardOutHold`, K.held
`cardout-…`). The phone then pays with those pieces and no others. Not paid, they
are made into pieces for the card and owed to it (`cardOutBack`), and its next tap
puts them back. Tests: `tests/flashcard-send.js`.

**On chain.** A bitcoin address goes to the phone's own on-chain confirmation
(26b-onchain.js). It shows NETWORK ON-CHAIN, the amount, FROM FLASHCARD, the
reserve of the fee option chosen as FEE (dollars, the sats under them) and the
phone's line `A payment on chain is not instant. It is done when it confirms.`
NEXT (`fcOcNext`) reads the card for the amount plus that reserve, with the
mint's fee on the pieces they are cut into (`cardOutTotal`). The held pieces are
then handed over by the phone's own NUT-30 melt (`onchainPay` with `held`): no
split, nothing of the phone's pile, and the pieces move from their hold to the
payment's record before the melt. PENDING is the phone's from there: the on-chain
watch follows it to PAID, and the screen says it is on its way as for a payout
from the phone.

What comes back after the card has gone belongs to the card:

- the reserve the transaction did not use, which comes back as the melt's change;
- all of it, where the mint answers UNPAID, or a melt whose answer never came
  later reads UNPAID.

It goes into a hold for the card (`cardOutReturn`) and is owed to it by the same
road as a refused Lightning payment (`cardOutBack`, CARD_OWED, CARD_DUE if the
making fails). A mint that signs the change only once the transaction confirms,
or a melt whose answer was lost, leaves it to the on-chain watch: at PAID the
change is restored from the counters its outputs were made at, and goes to the
card the same way.

The two card payments differ here. On chain, the unused reserve is the card's.
Over Lightning it still comes back to this phone as melt change, as it did
before; whether that should go to the card as well is left to the owner. Each launch, and the moment it becomes owed, the card YOUR CARD HAS
MONEY WAITING says `Tap your card to put ₿N back on it.`, with TAP CARD. Money
the connect's sweep makes owed after launch is said when the sweep ends. It is
also the line for money waiting on the card's own screen. The payment's history
entry is the on-chain payment, `Paid from card`, with the change `owed to the
card` and then `put back on the card`. A mint whose info has no on-chain melt is
said no to (THAT WON'T WORK: the mint does not pay bitcoin addresses). An address
below the mint's floor is refused in the keypad's words, `This mint sends at least
N sats on chain.`, before the card is touched. Tests:
`tests/flashcard-onchain.js`.

**The per tap limit is not changed by this.** An on-chain payment is usually
larger than a till's, and the whole read (amount plus reserve) is what the card
waits on. Take $300 against a $20 limit. That is fifteen limits' worth, sixteen
once the reserve is in. A card of 1.18 asks ten askings for the first limit's
worth over and four for each after: 10 + 4 × 13 = 62 askings, about 50 s, or 66
and about 53 s with the reserve. Either way it is past the 40 s a till asks
anyone to hold a card, so it is refused before the PIN with OVER THE CARD'S PER
TAP LIMIT, and nothing is taken. At a $20 limit one tap carries at most twelve
limits' worth, $240 with the fee (50 askings, about 40 s). Larger payments are
WITHDRAWn to the phone and paid from there, or need a higher limit.

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
  finished. Cut short again, what it signed is held with the rest. With no
  connection it works the same way, for a payment whose pieces this phone proved
  before the card signed them: the rest of the exact set, proved in its turn, and
  the whole kept as one payment to settle online. One begun while the phone was
  online was never proved, and is not taken up with no connection. A held payment is given back to the card, by the road a refund always
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
  mint is on Foxy's own screen (CHECKING, 1d), and then RECEIVED (1h).
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
  So a payment is of one date's pieces. A card's money is good for fourteen days.
  A top-up takes the date the card already has while that is ten days off or
  more, and a new fourteen days after that, so a card is mostly of one date; its
  owner's phone renews the whole card, to one date, once it has less than ten
  days left: its owner's read, online, offers it (RENEW THIS CARD, with RENEW and
  LATER, once a session), and the card's screen keeps a line for it. A card topped up after that holds two; a price that neither covers alone is refused before the PIN
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
  and the outputs wait with the signed pieces, kept whole for the first connection
  (*Paying with no connection*).
- **Taking a lost card back**: this phone's own key signs once for each date's
  pieces, over the swap they come back in.

What it costs: a signature that names its outputs is good only while the mint
will still make that swap. A mint that retires the keyset the outputs are on,
or raises its fee, between the signature and the swap (which matters for a
payment kept with no connection for days) leaves pieces the card's signature can no
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

1. **SEND.** The PIN, and the first tap, under PAYING (1c). The card signs its
   one or two pieces and may be taken away.
2. **VERIFY.** The phone's sheet stays up and says `Hold for change.` while the swap runs and the change is made; Foxy's screen
   behind it says PAYING, the card still in contact. "Paid" first, since the card's part is over
   the moment it has signed, and the words are what say so: iOS plays no
   haptic of an app's while its own sheet is up. (The sheet used to say `Remove
   the card`, which beside its own Cancel read as finished, and it was closed
   before the change.)
3. **RECEIVE.** The same sheet says `Tap the card again for its change` and the
   screen says TAP FOR CHANGE (RECEIVING once it is found); the tap writes it, with no PIN: the card allows
   the tap after a payment to load. The sheet ends `Done. ₿212 of change is back
   on the card.` A card that leaves while its change is being written has used
   that one tap up, and wants its PIN for the rest: the same sheet asks for it
   again (CARD LOST, then RECEIVING) and gives it the PIN typed for this payment, so nobody is
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

   **No other payment's PAYMENT RECEIVED comes up while a card is being read or
   written.** One rose over the Flashcard screen with the phone's sheet up under it,
   and the sheet came down. Any confirmation that comes while a tap is in progress
   (the phone's sheet, the screen behind it, the pause between two taps of one flow),
   while the pieces for a tap are being made (GETTING IT READY, TAKING IT BACK), while
   a card's PIN is asked for a tap, or while a card is up that asks for the card to be
   tapped again (TAP CARD: the rest of a withdrawal, a payment held, change still to
   take), is kept in the queue of confirmations, behind
   the ones before it, and raised one at a time, in the order it came, a moment after
   the card screens have come down. The payment the card flow is making is not held by
   this: it has its own hold, above. Nothing waits for ever: a confirmation that has
   waited as long as a change tap may (two and a half minutes) is raised whatever is on
   the screen, and a Foxy that is away from the screen gets its banner as ever.

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

**LIMITS** on the card's screen first asks which of the card's limits, on the
CARD LIMITS screen: `Which limit do you want to change?`, the card's picture and
a row for each with what it is now: **PER SECOND LIMIT** (the limit on one tap,
said as the rate it makes, L/3 a second; **PER TAP LIMIT** on a card that
refuses past it) and, on a card that has a PIN (software 1.16 and on), **NO PIN
LIMIT**, and CLOSE (this phone sets no daily limit) (*The limit on
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
  Its own withdrawal does not wait. The phone signs that lift only against the
  keeper's yes, asked before the card is held up with the flow's own (WITHDRAW,
  SWAP, RENEW, RESET of a card with money, TRANSFER, the backup's move, a per tap
  limit that recuts the money): limits to nothing from what the card said in the
  tap (after the owner's grant, where a quick card says its limit on one payment),
  and then back to exactly those. The phone keeps them until it sees the card
  holding them again, so a put-back that never reached the card is made at the
  next tap that finds it lifted; no second lift is signed over a kept one.
- **The re-peg needs a yes too.** The phone signs no limit the keeper did not
  say yes to, and the sats a dollar limit becomes are the page's sum, not the
  card's: a card before 1.23 has its sats re-pegged only in a read whose tap the
  keeper said yes to that figure for (`repeg`), and in no other flow's tap. No
  screen asks for that yet (a FOLLOW THE PRICE question is a later job), so until
  then such a card keeps the sats it was given. A card of 1.23 keeps cents, and
  only its rate follows the price, which signs unasked.

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
is left. TAP CARD takes the rest with the PIN already given, and the green RECEIVED
then says the whole amount (a withdrawal cut short takes the card's screen away, as what it knew of the card is out of date;
one that goes on in the same sheet, with the card asked for again, does not; DONE on RECEIVED is the card's screen). LATER ends the withdrawal; the rest stays on the card.

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

**Before 1.15, the time was told under a signature, and was weak. The app no longer does it.**
A card before 1.15 kept the latest time it was told, and accepted a time only if
it carried a signature by a **time key** written to the card at set-up. The key
that signed was built into the app, in the clear, so it was only as good as
trusting the receiving phone's own clock. That key, its signer
(`Foxy/Flashcard/CardTime.swift`), the bridge action that asked for it
(`cardTime`) and the command that carried it (0x35, SET_TIME, which a card of
1.15 and on answers 6D00) are gone from the app, and set-up writes zeros where a
time key was. No card before 1.15 is in use. `tools/check-keys.sh` (part of
`sh tools/check-all.sh`) scans the tracked sources for private key material so a
key like it cannot come back. The card model in the tests (`tests/flashcard-card.js`)
still answers SET_TIME for software before 1.15, because the recordings of those
cards replay through it, and takes its clock from the test phone's at each SELECT.

## Paying with no connection

A till with no connection cannot ask the mint. A card of one signature (format 4)
that keeps the mint's proofs (software 1.20) can still pay it: the till sets the
swap out from its own seed, the card signs it over, and that signature is good for
those outputs and no others. Nobody but this phone can use it.

- CARD on the receive screen, with no connection, asks no question first; the PIN
  comes as it does online;
- before the PIN and before the card is asked to sign, the till reads the mint's
  proof (NUT-12) for each piece it picked (GET_DLEQ, two places to a command) and
  checks it against the mint's keys it kept. A card before 1.20, or a card of one
  piece at a time, is refused as too old; a card whose pieces have no proof, or
  whose keys are not at hand, cannot prove its money; a proof that fails is a card
  holding money the mint did not sign. Each is refused, and can pay once this phone
  is online;
- a payment the card left part way through is taken up with no connection only
  where what it signed was proved here before it signed; one begun online is not;
- a piece must have a week left to its date, by the latest clock the till has
  evidence for: its own, the newest block header it kept, the card's own clock, when
  it last had the mint's keys, and the newest card payment it kept. A clock set back
  cannot pass a piece it has seen evidence is near its date. A till with a
  connection needs a day; the card's own phone ten minutes. Pieces with no date
  (a card set up like cash, which no screen does now) have nothing to race;
- only an exact set of pieces; an offline till cannot make change. A card that has
  none for the price is refused before the PIN is sent (NO CHANGE WHILE OFFLINE);
- the card's clock needs no connection: the phone tells it the time (a note) and shows it the newest header it has kept (1.15
  and on), and the daily limit is looked at as ever, by the clock the card has;
- the whole request is kept (`foxy.flashcard.kept`: the signed pieces, the outputs,
  their counters and digest, the dates, how many pieces proved), with a row of the
  unclaimed store and an entry that says received at once, waiting for the mint. It
  counts in the balance;
- at the first connection the swap is posted as it was signed. A lost answer, or the
  same request posted by anybody else, is found to be this phone's by its own
  outputs (NUT-09) and settles. If the mint says the pieces were spent first (a copy
  of the card), or the card's owner took them back after their date, or the mint's
  keys or fee changed so that it will not take the signature now, or it will not
  take the card's signature at all, the entry is marked failed and the person is
  told. Only the mint's own answer ends a payment: this phone's library failing to
  set the swap out is asked again. A mint that does not answer is asked again at
  every connection, and the person is told once if the payment is near its date.
  The recovery of lost swaps, which runs before the claim at a connection, settles
  one it finds made;
- what a payment that did not settle was counted for is undone with it: a share of a
  split bill it paid is open again, and a wallet that holds dollars lets go of the
  swap into dollars it owed itself;
- each step of the tap and of the settling is written before the next, and one
  that did not land (a page gone between two of them, a write refused) is put right
  at the next settling from what else is on file: a record left with no row is
  settled, or ended, or given its row back, by its entry and its pieces, and the
  tap's TAKEN copy of a kept payment is struck and never posted as a second.

On the screens: the receive closes as for any payment, and the history pass says
PAYMENT RECEIVED. While it waits the HISTORY ring is amber (red is for money somebody
else can still take), its row says *Paid by card · settles online*, and its detail
says SETTLES ONLINE and the day to be online by. Settled, it is an ordinary receive,
not announced again. One that does not settle is said by a card: CARD PAYMENT NOT
SETTLED (spent by a copy of the card, a mint whose keys or fee changed, or a mint that
would not take the card's signature) or CARD
PAYMENT WENT BACK (its date passed and its owner took it back), and its row says
Failed; a payment near its date with the mint not answering is said in a line, once.
Coming back to Foxy with a route settles a waiting one at once. A dollar receive by
card with no connection (a wallet with two balances) takes the sats the dollars come
to at this phone's own last price, keeps that price with the payment, and turns the
sats into dollars once it has settled; a price too old is refused first (BITCOIN
PRICE TOO OLD).

The risk left is a copy of the card: the proofs say the mint signed the pieces, not
that they are unspent. It is an exception, for a card only, to the rule in
`OVERVIEW.md` that Foxy does not receive ordinary ecash offline. It has a switch of
its own (`CARD_OFFLINE`, build/wallet/08a-flashcard.js); plain ecash between two
offline phones keeps `OFFLINE_TO_OFFLINE`, which is off.

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

## Pieces the mint says are spent, still on a card

A card lists what it has not signed for and counts it as money. The mint may have seen
some of that spent all the same, and the card cannot tell:

- **How it gets there.** A copy of the card paid with it; this phone took the card's
  money back by its own key after the date (`cardTakeBack`) and the card turned up; or
  a write put back a piece the card had already signed away. The last was this phone's
  doing: a top-up cut short left its row owed with some of its pieces on the card, the
  card paid with those, and the next write cleared the places that payment used
  (`CLEAR_SPENT`) and loaded the same pieces again, spent. Now a row a write has begun
  on is stamped `tried` (once it is known to fit the card: its mint, its unit, its
  pieces), and before any later write the row's own mint is asked about its pieces,
  whichever mint the phone is on (`cardOwedPrune`, `cardStatesAt`; as it already was for
  rows found and filed): a row it has spent all of is struck off, one it has spent some
  of keeps the rest only, and a `tried` row no mint has answered for in this tap or just
  before is not written (it waits, owed: `unchecked`).
- **What the screen says.** Once the mint has answered (`cardCheck`, which now also says
  `spentIn`, by currency, and `left`), the balance is what the card can spend: what it
  lists less what the mint says is spent. The spent figure is a red row at the top of the
  card's HISTORY, and the card's menu button turns red until it is cleared. While the card still lists those pieces, RESET asks for the PIN
  whatever the balance says, and WITHDRAW with nothing left says RESET clears it.
- **Taking them off.** The card has no command that takes off a piece it has not signed
  for, and signing is how it lets one go. So the holder's WITHDRAW ALL, and RESET, which
  takes the money off first, ask the mint first (`cardSpentOnCard`: the screen's word
  where it is under ten minutes old and covers every piece now on the card, else one
  request with the card held). The pieces it has spent are never chosen; the rest is
  taken off and swapped as ever, and the spent ones are then signed for apart, a
  signature for each date's pieces as any taking-off is, over one output nobody holds
  the key to (`cardBurnPlan`). That swap is never sent and nothing is written down for
  it; the signature is checked and thrown away. The card marks those places spent as
  it always does, its count of unspent pieces is true again, and `cardReset` no longer
  answers `has-money`. A card all of whose pieces are spent signs for nothing else:
  the taking-off resolves with `amount` 0 and no history line, and `spentOff` says what
  the card let go of (in its unit; it is on any taking-off that let some go). Only
  pieces the mint says are SPENT, which is for good; a piece it calls pending is left
  on the card. The commands are those of a payment, the same size as any, under the
  PIN and the limit lifted by the card's owner key; a typed amount (not all of it) leaves the spent
  pieces on the card and chooses among the rest.
- **Limits of the asking.** The card is held at most twelve seconds while the mint is
  asked; no answer refuses the taking-off with nothing asked of the card. A mint whose
  info does not list NUT-07 is not asked at all: the taking-off goes by the card's own
  figure, as before, and the log says so. A signature had back from an earlier tap cut
  short is swapped in even where the tap finds only spent pieces. A card taken away
  while it lets the spent pieces go, after the money's own signatures, leaves all the
  money in this phone: `partial` with `left` 0 and `spentLeft`, and words that say the
  spent part is still on the card, for WITHDRAW ALL or RESET to clear.
- **What the card's own log says.** The card writes its letting go as a payment, in its
  log and its receipts, which no swap matches. This phone keeps the hash of each such
  signature (`foxy.flashcard.letgo`, `cardSpentLetGo`), and the card's own log says how
  many of the receipts kept were spent pieces let go, with no money moved; COPY RECEIPTS
  marks them. The card counts them in its day as any signature, under the lifted limit.
- **RESET's warning.** While the mint is still being asked, it says "What the mint says
  is unspent on it comes off to this phone first." with no figure; the tap asks the
  mint itself before anything moves.

## What Verified says (software 1.20)

Up to software 1.19 the line under the card's title, `Verified At 11:42am`, rested on the mint's word that
the card's pieces are unspent (NUT-07) and on nothing else. That is not the mint's word that they are real:
a piece with a made-up point reads unspent until somebody tries to spend it, so a card loaded by somebody
else's modified wallet read Verified. From 1.20 the card keeps, for each piece loaded with one, the mint's
NUT-12 proof (e, s and the blinding factor r, 96 bytes: `FOXY-CARD-SPEC.md` 5.9 in the card repository). It
gives it back to anybody who asks (`GET_DLEQ`, no PIN) and checks nothing. This phone does.

- **Writing.** A piece that has the whole of its proof goes onto a card of 1.20 alone, in a command of its own:
  `LOAD_PROOF` with P1 = 1, the 81 bytes of the piece and then e, s and r, which the card answers with the piece's
  place and `01` where it kept the proof or `00` where it has no room for proofs. Pieces with no proof go three to a
  command as ever, and a card of 1.19 or before is sent what it always was, byte for byte. Every write goes
  through `cardWriteOwed`: a top-up, change, what a payment's pieces come back as, the card's own change, the
  put-back of a refused payment. The proof is not made at the tap. This phone made the blinding factor and the mint's
  signature carries e and s, so a token made for a card keeps all three from the moment it exists, in the row that owes
  it to the card (`foxy.flashcard.owed`; a row filed by an older build has none, and its pieces go on plain); for the
  change a card makes for itself (1.12) they are the mint's e and s for the output and the blinding factor
  the card kept in its opening, which the DLEQ is already checked with. An answer of `00` is no error: it is said
  once in the log, and the rest of that write goes three to a command. The write leaves one line, so that the time can
  be read off a phone: `card: wrote 32 piece(s), 32 with the mint’s proof (32 kept by the card), in N ms`
  (from the first load to the last answer; nothing secret in it).
- **What this phone knows is real** is kept by the piece's nonce in `foxy.flashcard.real`, shaped as
  `foxy.flashcard.checked` is: `{ <card key>: { at, nonces } }`, twenty cards and the oldest dropped, at most a hundred and
  twenty-eight nonces a card (the newest), and cut down to the pieces on the card at each read that checks it. It is for the
  cards that keep proofs: a card of 1.19 or before is not in it. A nonce goes in
  when this phone wrote the piece onto the card, the card said it stored it, and the piece was the mint's own answer to
  this phone's swap (a top-up, change made after a payment, what the mint signed again when asked for it, NUT-09); or when
  a proof read from the card verified. **A card's own pieces written back as they came off it are not made real by being
  written.** Only one write does that, the put-back of a payment the mint refused: its row has each piece's keyset, amount,
  secret and point and no proof, so the pieces go back plain, the card keeps none for them, and they are real here only if their nonces
  were noted before. A nonce says nothing of what is spent.
- **Reading.** The card's own screen reads the card for proofs (`opts.real` of `cardLook`) and nothing a payment does:
  not a till's read, not the read before a signature, not the tap that writes change, not a withdrawal. After the pieces
  have been read whole (never the short read, which lists no nonces), each unspent piece whose nonce is not in the store is
  asked for with `GET_DLEQ`, two places to a command, and the answer is kept on the piece, `dleq: { e, s, r }` or
  `null` for `00`. The read's line in the log gains `proofs <ms>`. Nothing is checked while the card is held.
- **Checking.** Once the card is let go, `cardRealCheck` rebuilds each piece's secret as the card does
  (`cardSecret`), takes its whole keyset name (`cardFullId`) and the mint's key for its amount, and asks
  `hasValidDleq` whether that key signed it. It answers `ok` (every unspent piece on the card is in the store now), `fake`
  (a proof was read and does not verify: a made-up point, another piece's proof in its place), or `unproven` (neither: a
  piece has no proof, or the mint's keys for it are not at hand; keys that are not at hand never make `fake`). The keys of a
  keyset this wallet has not loaded, an older one of its own mint's, are asked for once before the pieces are checked, for ten
  seconds at most. It works a few
  pieces at a time and lets the page breathe between, and leaves one line (`card: its proofs: 43 piece(s) proven (43 checked
  now), 0 with no proof, 0 that cannot be checked here, 0 that fail, in N ms`; never a secret, a nonce or a point). A
  proof is checked on this side and sent nowhere.
- **The line.** For a card of 1.20 only: red `Not Verified` where the mint says a piece is spent (as before) or the check
  says `fake`; the time where the mint was asked (or was, for these same pieces: `cardCheckedAt` answers nought for a
  card of 1.20 unless every piece is also in the store) and the check says `ok`; amber `Not Verified` otherwise, which is
  where a card loaded by a build that sends no proofs stands, to a phone that did not write its pieces itself. While
  either is being worked out it says `Verifying…`. A read of the short kind keeps what the screen said. A card of 1.19
  and before reads exactly as it did: the mint's word alone.

What it does not do. It does not show that a piece is unspent: the mint says that, and is asked as ever. A till with
no connection checks the proofs of the pieces it is paid with, afresh at every tap (*Paying with no connection*). The card gives the blinding factor to any reader with no PIN, for every piece that has a proof, and the mint can
tie a piece to the request that made it from `r` (the card repository's 5.9 says so): this phone sends it nowhere.

## What is kept on the phone

Nine stores, named in `STORAGE.md`: ecash made for a card and not yet written to
it (`foxy.flashcard.owed`: a load, change, and the pieces of a payment the mint
refused; for a card that makes its own change, what the mint signed for it); pieces a card has signed for that the mint has not swapped yet
(`foxy.flashcard.taken`), which are the only copy of the right to spend them,
written down before the card is let go; the cards this phone loaded as recoverable; and when the mint last
said a card's pieces were good, so a phone with no connection can say `Verified At 9:15am`; which of a card of 1.20's pieces this phone has found real (`foxy.flashcard.real`); and the counts it last read from a card's own log, to say what is new; and, for a card that signs once for a payment, the swap each signature was asked for (`foxy.flashcard.swaps`), without which the signed pieces could not be swapped; the dollars a card's per tap limit was set in (`foxy.flashcard.pace`); the receipts read from this phone's own cards (`foxy.flashcard.receipts`); and the newest Bitcoin block header fetched for the cards' clocks (`foxy.flashcard.header`). The card's screen shows `Verifying…`, `Verified At <time>` (with the day after it when not today), or
`Not Verified`.

**The card's face.** A card is drawn in a design named by a code of three
digits, the same code the shop lists it by and the card is encoded with
(`docs/CARD-DESIGNS.md` holds the table, the old FX1 and EL1 names that read as
001 and 002, and how a design is added): 001 is Foxy's, a picture of orange fur
with a sleeping fox; 002 is the beaker, drawn in CSS and SVG with its liquid
flowing and bubbling and the beaker swaying (still under Reduce Motion), the
same block in `build/markup.html` (and `FC_EL1_FACE`, which no screen behind the
sheet draws now); a card naming none, or one this build cannot draw, is FL1,
Flash's first. A card of software
1.10 carries its code in its record, written at set-up and read back by every
phone; for a card before that, the phone that set it up writes the code it
chose on a note of its own (`foxy.flashcard.designs`, by the card's key: not
the list of cards it can take back, which a cash card is never on), and any
other phone draws it as FL1. This phone sets up its cards as 001.


## What it does not protect against

The card repository's `FOXY-CARD-SPEC.md` §10 has the full list. The ones that
matter to a person:

- **A terminal built to cheat**, on a card before 1.15, whose time was interim
  (above; no such card is in use). A card of 1.15 cannot be told a time it has to believe, but one that
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
  limit on nothing. From software 1.20 the card keeps the mint's proof for a piece
  loaded with one, and the owner's screen checks it (*What Verified says*): a card
  with such a piece reads `Not Verified` in red. A piece loaded with no proof, or a card
  of 1.19 or before, shows nothing, and a till with no connection does not look.
- **Three wrong PINs from any reader** block the card until the owner's phone
  unblocks it.
- **Whoever has the twelve words and the card** has everything on it. **Whoever
  loses the words** loses the PIN and limit for good.

## The integration vectors

The card's recordings and vectors in `tests/fixtures/`, the model of the card
(`tests/flashcard-card.js`, `tests/flashcard-model.js`), the PIN sealing and the
tap's wire constants (`Foxy/Bluetooth/TapCrypto.swift`) are also kept as copies
beside this app, for the integration vectors that other code is held to. A
change to the card's or the tap's wire format therefore changes those vectors:
`tools/check-integration-vectors.js` (a stage of `tools/check-all.sh`) compares
each pair listed in `tools/integration-vectors.txt` and refuses until the copies
are updated in the same change. The keeper sets `FOXY_LIBS` to the folder that
holds them; without it the stage says it is skipped.

## Where it is in the code

- Screens: `build/app/26f-flashcard.js`, and the FLASHCARD block of
  `build/markup.html`.
- The wallet's side: `build/wallet/08a-flashcard.js` (reading, signing, pieces,
  the clock a tap gives a card),
  `build/wallet/08b-block-headers.js` (the block headers that clock is made of,
  fetched over Tor and checked) and `build/wallet/21a-flashcard.js` (set-up,
  adding and taking money, the owner's proofs).
- Native: `Foxy/Flashcard/` (`CardLink.swift`, the NFC session; `CardGate.swift`,
  which commands may pass;
  `CardAddress.swift`, the card's address and the one message the page is told about it;
  `CardTapDelivery.swift`, which keeps that message until the page can take it and
  tells it once), and `Foxy/Bridge/FoxyBridge+Flashcard.swift`. The bridge actions are in
  `THREAT-MODEL.md` §1, and the owner key's derivation is in `SEED-HANDLING.md`. A card's
  address comes in through `ContentView` in `Foxy/FoxyWebView.swift`, and the page takes
  it at `FoxyWallet._cardTapped` (`cardTapped`, `cardTapRule`, in `26f-flashcard.js`).
- Tests: `FoxyTests/CardAddressTests.swift` and `CardTapDeliveryTests.swift` hold the
  address and the delivery to their rules (they run in `tools/nativetests`);
  `tests/deep-links.js` holds the rule for every screen, the request that is kept and
  its minute, and what is read across the two languages (the one message, the
  entitlement); `tests/flashcard-screens.js` begins a real tap from a card's address.
  `tests/flashcard-*.js` run in `tools/check-all.sh` against a model of
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
  lost answer, and the circuit made ready as the sheet opens; `tests/flashcard-proofs.js`
  pins software 1.20: a load a piece to a command with P1 = 1 and the proofs read back as
  they went, the commands to a card of 1.19 byte for byte, the store and its caps, the
  look that asks for proofs and the payments that do not, good proofs, a made-up piece,
  another piece's proof, no proof and no keys, a tap cut in the middle of a load, the card's
  own change with its proof, and the three states of the line. `tests/flashcard-offline.js` pins a card paying
  a till with no connection: the proofs read and checked, the week by the latest clock, the record kept, settling at
  the first connection, a keyset or fee changed, the owner's take-back either side of it, an answer lost, a repeat and a
  copy posted elsewhere, a silent mint, the owner's renewal, and set-up recoverable; `tests/flashcard-offline-ui.js` the
  same at the screens (the receive, PAYMENT RECEIVED, the ring, the history row, the cards for a payment that did not
  settle, the late line, RENEW THIS CARD, set-up, the dollar receive). `tests/flashcard-applet.js` is
  opt-in and drives the wallet against the applet itself over a local port.
  `tools/live/flashcard-switch.js` moves a card between two local mints.
  `DEVICE-TESTS.md` §23 is what only a card and a phone can show.
