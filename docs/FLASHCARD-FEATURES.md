# Flashcard: what it does

A Cashu ecash card (a chip card running the Foxy applet) and the Foxy app's screens for it, as built for card software 1.18. Where older docs differ from the code, this follows the code. Button and screen names are in capitals as the app shows them.

**Status.** Over NFC, one card and one phone have been through set-up, loading, a payment and change. The rest has run against a model of the card, the applet in a simulator, and the chip in a contact reader. No audit has covered the card. A card is cash.

## 1. What the card is and holds

- A chip card that holds ecash and signs to spend it. No battery, no network; it works by an NFC tap.
- **128 places** (64 before 1.7), each holding one **piece** of ecash locked to the card's own key, which never leaves the chip. It also keeps its PIN, owner's public key, mint address (77 characters at most), clock, three limits, design code, a log of eight taps and sixteen receipts.
- **One mint a card.** Another mint gives A DIFFERENT MINT. A card with money must be emptied first; an empty card offers its owner SWITCH TO <mint> on ADD FUNDS. Moving money across by Lightning is built, with no button.
- **One signature for a payment** (1.4 and on): over all the pieces and the outputs they are swapped for (NUT-11 SIG_ALL), so signed pieces are useless to anyone but the phone that set out that swap. Older cards sign each piece, about 0.75 s each; the app pays with both.
- **Change the card makes itself** (1.12 and on): the till names amounts, the card builds the pieces locked to its own key, so a till cannot divert them. It makes the four largest powers of two; the till writes any small remainder at a second tap.
- **The drawer.** Money is cut like a till's float, in powers of two, so most prices come out exact: a 128-place card gets eight of each size from 1 to 1,024, then the rest; up to 112 pieces a load, a dozen places kept free. A per tap limit caps piece size.
- **PIN sealed** (1.9 and on) to a key of the card's, so listening to a tap learns nothing; the till's phone still sees it.
- **Only its own applet:** thirty-three commands are carried; a bank card held to the phone is not read. Reading needs the NFC Tag Reading entitlement (paid developer team), else NO CARD READER.
- **Cash.** Recoverable cards (the loading phone takes money back after a year) are built and off.
- **The phone keeps** fifteen `foxy.flashcard.*` stores (STORAGE.md names ten): money owed to or taken from cards, swaps, receipts, the last block header.

## 2. Setting up a card

1. MENU, FLASHCARD goes straight to Apple's sheet (and once this phone has a card, a swipe to the left across home does the same; a swipe to the right on the card's screen is home again). A new card reads `Welcome to Foxy Card. Set it up to put money on it.` with SET UP CARD and RESTORE LOST CARD.
2. **From 1.21** (a card holds no money without a PIN), a new card tapped lands on WELCOME TO YOUR CASHU CARD (the card's picture, SET UP CARD, RESTORE LOST CARD, CANCEL), the one way into its set-up; SET UP CARD runs the owner's steps: CREATE A PIN, RE-ENTER PIN; at a mint with two balances, CURRENCY (`What will this card hold?`: DOLLARS, BITCOIN and, on 1.23, BOTH, as tall tiles); NO PIN AMOUNT? on SET AMOUNT (no question first); then MAX SPEND PER SECOND: $1 $2 $5 $10 $25 $50 a second ($5 unless changed), the figure itself for another rate typed on SET AMOUNT. The card holds one limit on a payment, L, paid at once, then waits about three seconds for each further L, so a rate R is L = 3R ($5 a second is a $15 limit) and a limit is said as L/3 a second wherever it is shown; a bitcoin card with no price types the rate in sats. SKIP under NEXT on either sets none. The round back button off NO PIN AMOUNT? leaves the set-up with nothing written; off MAX SPEND PER SECOND it is NO PIN AMOUNT? again; off the rate typed, MAX SPEND PER SECOND (or NO PIN AMOUNT? where the rate was asked in sats straight away). One tap writes the PIN, the record, the two numbers (SET_LIMIT's PIN form, before the claim) and claims the owner (Keep holding while the card holds). No daily limit is asked or set.
3. On 1.16 to 1.20 there is no PIN to choose: SET UP THIS CARD goes straight to the tap (ADD PIN, on the card's screen, gives it one later). A card before 1.16 cannot be without a PIN: CHOOSE A PIN (four to eight digits), then TYPE IT AGAIN, the second pad taking the first one's place with no flash of the screen between.
4. One tap writes the PIN (if any), the record (this phone's mint, a design) and last the owner key; a cut-off set-up is finished by the next tap. `The card is set up.`

- No limit is asked or suggested. A no-PIN card is cash to whoever holds it; only ADD PIN's pad says so.
- **Owner:** the phone whose twelve words made the card's owner key (the page sees only its public half and six kinds of signature). A phone restored from those words is owner too; a holder with no phone uses a friend's. Lose the words and the PIN and limits can never change.
- **Designs:** FX1 (orange fur, a sleeping fox) is what the app writes; FL1 (black, a bolt in a circle) is drawn for a card naming none; EL1 (black, a beaker of orange liquid with a die in it and a sprout, its liquid, bubbles and sway animated, still under Reduce Motion) is the third. From 1.10 the card holds its code. Every design gets the snow that settles on the card's top edge.
- **Cash or recoverable:** all cards are cash; the recoverable choice (IF THE CARD IS LOST) is off.
- A card with no owner is open while empty and cannot be loaded.

## 3. Paying at a till

On the receiving phone: RECEIVE, an amount, CARD.

- **A dollar receive** (a mint with two balances) has CARD too, once the mint has made the invoice: the card pays the sats that invoice names, those sats pay it, and the dollars land as from any payer; the card's screens show the dollars with the sats under them. A code with under fifteen seconds left is renewed before the card is asked; one that runs out while the card is read leaves its sats as bitcoin (PAID IN BITCOIN), with no payment sent.
- **A split bill** has CARD on each payer's own screen too (a paid share has none), for that payer's share, with the till's tap, PIN, limits, change and offline rules. The share is ticked, and the screen goes on to the next payer, once the mint has given the phone its pieces, however late: a payment answered after CHECKING was closed, or taken on trust and swapped later, ticks its share when it lands. One share to a tap: the next share is its own CARD and its own tap. No PAYMENT RECEIVED comes up on top of the bill's own screens.
- **One tap; PIN only if needed.** A card with no PIN, or whose no-PIN allowance covers the payment, pays in the first tap. Otherwise the sheet ends `Enter the card's PIN` (nothing taken), the CARD PIN pad comes up and TAP AGAIN pays. Cards before 1.16 always ask. Three wrong PINs (WRONG PIN counts down) give CARD BLOCKED.
- **No-PIN allowance** (1.16, cards with a PIN): the most signed a day without the PIN; over what is left, the PIN is asked for the whole payment. Only PIN-less payments count.
- **Per tap limit:** the most paid in one tap straight away. Over it the card makes the holder wait, doing "askings" (signatures of its own work, about 0.6 to 0.75 s each): ten for the first limit's worth over (seven before 1.17) and four for each further one (three before 1.18). Counted from the card being found, the screen behind the sheet reaches about 9 s for one limit's worth over, 11 for two and 13 for three on a card of 1.18 (9, 10 and 12 on 1.17). The sheet says `Over per tap limit`, `x2`, `x3`. Lift the card and nothing is taken. The till is never told the limit. Change the card makes counts as work done; a second payment in one tap waits too. Past about 40 s the till gives up: OVER THE CARD'S PER TAP LIMIT.
- **Daily limit:** the most signed a day, counted as pieces less the card's own change. A piece worth more than what is left can't be spent today. A day is 24 hours of block time from its window's start; setting the limit starts one, the first spend a day later the next. A mint-refused payment still charges it. Over: OVER THE CARD'S DAILY LIMIT, before the PIN, with what is left and when the day turns. Across a window's edge a terminal can take two days' limit.
- **Clock** (1.15 and on): the newest Bitcoin block header the card has been shown, believed for its proof of work only, so no one can show a future block. The phone fetches headers over Tor (mempool.space and Blockstream), shows a card only a later one, never waits on a fetch, and tells the card its own time as a note, trusted for nothing. With no block yet a card spends its first day on trust. Before 1.15 a key inside the app signed the time: those limits bind only an honest receiver.
- **Offline taps:** HIGH RISK, YOU ARE OFFLINE (CONTINUE or REJECT) comes before the PIN; only an exact set of pieces is taken (else NO CHANGE WHILE OFFLINE); signatures are checked on the phone; the entry is TAKEN ON TRUST, swapped when online, never shown as paid. Trusted: that the pieces are real (the card holds no mint proof), unspent and not signed for elsewhere; if the mint says spent, the receiver bears the loss.
- **Paid** is said only when the mint has given the phone its own pieces (CHECKING, STILL CHECKING meanwhile).
- **Change, one sheet.** Exact pieces need none. Otherwise the same sheet signs, says `Hold for change.` while the mint swaps, asks for the card again and writes the change with no PIN; PAYMENT RECEIVED waits for it (2.5 minutes at most). A closed sheet is reopened; if that reads no card, TAP TO RECEIVE (TAP CARD, LATER). Change is locked to that card; if the mint fails to make it, CHANGE NOT MADE YET.
- **Cut short:** nothing is lost; the sheet reopens and the next tap signs the rest (NOT PAID YET: TAP CARD or CANCEL). If the mint refuses, PAYMENT FAILED; the next tap puts the money back (PUT BACK ON THE CARD); the day stays charged.
- **A lost card** can be spent by whoever has its PIN, up to the daily limit and no faster than the per tap limit; without the PIN, up to the no-PIN allowance (a card with no PIN: its limits); three wrong PINs block it. It cannot have its PIN, limits, owner or mint changed, be loaded without the owner's grant or PIN, or be recovered or frozen from afar.

## 4. The owner's screens (MENU, FLASHCARD)

- **Top:** HISTORY (round, top left, for any card with a record), a cross, FLASHCARD, `Verified At <time>` (when the mint last vouched for the pieces; or `Verifying…`, `Not Verified`) and, from 1.15, `Block #<height>` (the card's clock; or `No block yet`).
- **The card** shows its design; on its face, at the bottom left where BEARER is at the bottom right, the limit line (`NO LIMIT`, `PER TAP LIMIT $5`, `NO PIN UP TO $10`, `| NO PIN` on a card with none; nothing for a card whose one limit is a daily one) with a line above it for anything odd (NO PIN YET, NOT FINISHED, LOCKED, BLOCKED); under it the card's own mint over MINT with the shield at its right (CARD BALANCE for a card with no mint yet), then home's bitcoin pill (sats; their dollars under), `NO PIN UP TO $10 · LEFT $4` (`LEFT TODAY` before 1.21), and lines for pieces above the per tap limit, change owed (the owner's phone fetches change a till never handed back) and money waiting to go on. The card screens say nothing of a daily limit: the app sets none.
- **ADD FUNDS:** SET AMOUNT, NEXT. The owner's phone asks no PIN; others CARD PIN (ADD $2.00 TO CARD). GETTING IT READY, a tap, and the card's screen is back with the balance counting up to what the card holds (no card is raised over it); THE CARD IS FULL if no room. Limits are untouched.
- **SEND** (where WITHDRAW was; RECEIVE is where ADD FUNDS was): the phone's SEND MONEY in card mode, with WITHDRAW, PASTE, CONTACTS and TYPE. What is read goes to the phone's confirmation with FROM FLASHCARD and NEXT. NEXT reads the amount and fee off the card as a till does (PIN, per tap limit and its wait), and the phone pays with the pieces it paid and no others. Not paid: they go back on at the next tap.
- **SEND on chain:** a bitcoin address, where the mint pays on chain, goes to the phone's on-chain confirmation (NETWORK ON-CHAIN, FROM FLASHCARD, FEE the reserve in dollars over sats, `A payment on chain is not instant.`). NEXT reads the amount plus the reserve off the card, and the phone's own on-chain melt hands those pieces over. It is PENDING, followed by the phone until it confirms. The unused reserve, or all of it if the mint does not take the payment, is owed back to the card: YOUR CARD HAS MONEY WAITING at launch (`Tap your card to put ₿N back on it.`, TAP CARD) until a tap puts it on. Below the mint's floor: `This mint sends at least N sats on chain.` A mint with no on-chain melt: THAT WON'T WORK. The per tap limit counts the whole read: $300 against a $20 limit is refused, nothing taken.
- **WITHDRAW:** SET AMOUNT or ALL OF IT, ENTER PIN TO WITHDRAW (none on a no-PIN card), a tap, and the card's screen is back with the balance counting down (the card is not read again once it has signed: the screen is brought up to date from what the tap read, and shows the day's whole limit left). The owner takes money off at any limit (lifted and put back in the same tap, which restores the day's whole limit). Cut short: TAP THE CARD AGAIN, then IN YOUR WALLET once the rest is in.
- **HISTORY** (top left): CARD HISTORY, this card's entries.
- **CHANGE PIN** (owner): NEW PIN, NEW PIN AGAIN, a tap, PIN CHANGED; no old PIN. **ADD PIN** on a card with none: CHOOSE A PIN, TYPE IT AGAIN, a tap. A blocked card shows its owner UNBLOCK (same pads, CARD UNBLOCKED).
- **LIMITS** (owner, no PIN): CARD LIMITS (`Which limit do you want to change?`, the card's picture and a row for each, with what it is now) offers PER SECOND LIMIT (PER TAP LIMIT on a card that refuses past its limit rather than waiting) and, for cards with a PIN, NO PIN LIMIT (no daily limit); each is a warning, its amount (MAX SPEND PER SECOND for the per second limit, SET AMOUNT otherwise and for another rate, with NO LIMIT under NEXT on both to remove it), CONFIRMATION, a tap. PER SECOND LIMIT first plays HOW TAP LIMIT WORKS once per phone (ten-dollar example: `~1–4 SEC TAP` within the limit, then `~9`, `~11` and `~13 SEC TAP` for one, two and three limits' worth over; the figures are worked out from the card's own counts, so a card of 1.17 shows 9, 10 and 12 and an older one 7, 9 and 10). Per tap and no-PIN limits typed in dollars follow the price (re-set past 2%); the daily limit stays in sats.
- **RESET** (the first of the row of round buttons under the card; the owner of a 1.17 card, or any holder of a locked one): RESET CARD, a warning (PIN, owner, limits, log wiped; new key; money comes off first), CONTINUE, CARD PIN pad if locked or holding money and a PIN, one tap, Home, `The card is reset.` Cut short: EMPTY, BUT NOT RESET. Refused with MONEY ON THE CARD, THE CARD IS OWED CHANGE or MONEY ON ITS WAY. The clock stays.
- **Log and receipts** show only when the card has something to accuse: the TAMPER line opens TAMPER ON THIS CARD: counts, the last eight taps (phone's time, block's beside it; sats and pieces; put on; `no PIN`; refusals), COPY RECEIPTS. The card keeps sixteen receipts, the phone 200.
- **FLASHCARD on the send screen** (fifth button under TYPE; dimmed offline) loads any card held to the phone: SET AMOUNT, NEXT, the sheet. A no-PIN card takes it in that tap; a card with a PIN ends `Enter the card's PIN`, then CARD PIN and TAP AGAIN.

- **RESTORE** (cards of 1.21 and on, after LIMITS in the row; and RESTORE LOST CARD on a new card's welcome): the take-back of a lost card's dated pieces by the phone that loaded them (CARDS YOU LOADED). A cash card says `This card is cash: it was set up with no key that can take its money back, so if it is lost its money cannot be restored.`

## 4a. A holder with no phone (1.22)

- **The first paying phone sets the card up.** SEND, FLASHCARD to a new card: the sheet ends `Set up the card first`, nothing made, and WELCOME TO YOUR CASHU CARD comes up over SEND's keypad; its SET UP CARD is the set-up for the holder, who types their PIN twice on that phone (CREATE A PIN says it is theirs), answers NO PIN AMOUNT? and MAX SPEND PER SECOND (or skips them), and one tap writes the PIN, a record with no refund key (a cash card), the two numbers and the money under the PIN. That phone does not become the owner; the card holds what is being sent. A new card of 1.21 is refused in plain words: its holder sets it up first.
- **On any Foxy** such a card shows its balance at once and two buttons: VIEW AS GUEST (its PIN, then Keep holding for about five seconds while the card is held for, then the card's own log, `Shown as a guest: nothing of it is kept on this phone.`; no payment in that tap; a tap that paid says THE CARD HAS JUST PAID) and TIE OWNERSHIP TO THIS PHONE (a plain warning, its PIN, about four seconds of Keep holding; only an empty card, else MONEY ON THE CARD: spend or move it first; the card is then given this phone's refund key). The phone that set it up sees the same two buttons.

## 5. The screen behind the sheet, and the sheet's words

Behind Apple's sheet: a card comes down behind a phone, three waves rising; it loops while a card is wanted, settles once it is there, and is still under Reduce Motion. Light blue until a card connects, then orange with fur until it is lost or the sheet ends. No countdown. Titles: TAP BEHIND PHONE (it comes up with the sheet, which is asked for at once) · KEEP HOLDING · 7 s (whole seconds from contact) · VERIFYING CARD (signed; mint asked, change written) · REMOVE (only while the sheet may still be showing: until it has gone or a second and a half after the card signed) · CHECKING, then STILL CHECKING (the mint not yet answered, by the wait of the CHECKING card) · TAP FOR CHANGE · PLEASE TAP AGAIN (contact broke) · ENTER PIN (pad up).

Sheet lines: `Tap behind the phone.` · `Reading the card` · `Signing` or, before 1.4, `Signing piece 3 of 9` · `Making change 2 of 4.` · `Over per tap limit` (`x2`, `x3`) · `Keep holding.` · `Hold for change.` · `Writing 2 of 4` · `Hold for the rest.` · `Hold to finish paying` · `Tap to put back signatures.` · `Asking for change owed.` · `Enter the card's PIN` (a note, not an error) · `Payment did not go through.` · `Done.` Buzzes for change coming are asked for; iOS plays none under its sheet.

## 6. What the card refuses, and why

- **Blocked PIN:** three wrong PINs in a row, from any reader in range. BLOCKED on its face, CARD BLOCKED at a till. Only the owner's phone unblocks it, with a new PIN; lose the words and it stays blocked. A blocked card has no no-PIN allowance.
- **Locked card:** only a tool can lock one, never the phone. It takes no more writes (THE CARD IS LOCKED) but still pays; reset needs the owner's proof and the PIN.
- **Tamper marks:** three refusals over a limit before the card's clock moves on mark that tap (an honest till reads what is left first). Needs a limit; a card that has seen no block marks nothing.
- **Owner's proofs:** each owner command needs a signature over a label and a number the card just gave, good once; a wrong proof costs no PIN try. The phone signs only change-pin, set-limit, set-owner, set-card, load and reset, never lock or time. Another phone gets NOT THIS PHONE'S CARD (NOT ON THIS CARD for an older card).
- **Also:** NOT ENOUGH ON THE CARD; A DIFFERENT MINT; TAKE IT IN PARTS or TWO PARTS (more pieces, or two dates, than one signature covers); NO MONEY ON THIS CARD; NOT A FOXY CARD; THE CARD LEFT TOO SOON; a piece it already holds; changing record, owner or mint while it holds money.

## 7. Hardware

- **Chip:** NXP JCOP 4 (J3R180), Java Card 3.0.5, 180 KB, 164,176 bytes free when clean.
- **Install:** the chip refuses the card's applet as a package's first, so an empty opener goes in first. Whether it installs turns on the load file's size by no rule found: a table of sizes tried is kept and a version ships only at a size that installed (1.17 and 1.18: 18,486 bytes). A simulator shows none of this.
- **Limits:** one transaction holds about a dozen status bytes (eleven pieces burned, thirty-two refused), so since 1.8 the burn is outside it. Working memory: 941 bytes.
- **Timing:** an asking (a signature) 0.7 s in a contact reader, 0.74 s over NFC. Over NFC a command takes 0.06 s, a read 1.2 s (so one piece pays in about 1.2 s), a change piece 0.4 s, a hundred-piece load about 9 s. iOS ends a session after a minute.

## 8. Card software versions

| Version | Added |
|---|---|
| 1.4 | One signature for a whole payment (format 4) |
| 1.5 | Per tap limit asks no clock; a larger payment waits, not refused |
| 1.6 | Quicker to hold; limit told only to the owner; receipts |
| 1.7 | 128 places; short listing; a payment may name every place |
| 1.8 | Burn outside the chip's small transaction: any number of pieces |
| 1.9 | PIN sealed |
| 1.10 | Design code in the record |
| 1.11 | Faster signing and listing |
| 1.12 | Card makes its change; limits held to what leaves the card |
| 1.13 | Wait only over the limit (7 askings, then 3); one payment a tap at full speed |
| 1.14 | Change counts toward the wait, two askings per three pieces |
| 1.15 | Clock from Bitcoin block headers; signed time gone |
| 1.16 | PIN optional; no-PIN allowance; ADD PIN |
| 1.17 | RESET CARD; ten askings for the first limit's worth over |
| 1.18 | Four askings for each further limit's worth over, three before |
| 1.20 | The mint's proof kept with each piece, for the phone to check: `Verified At` also needs every piece found real |

Before 1.4: the fork, owner key, daily limit, and a first per tap limit that refused.
