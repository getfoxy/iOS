# Two no-money runs with the tap stand-in

`tools/sim/tap-standin.py` stands in for the other phone (see its header for
the wire, quoted from `TapLink.swift` and the page). Run as `receiver`, it
answers a question-first (`intend`) with `go: false` and a `pay` with a sealed
422 refusal (`"stand-in: no money moves"`), so nothing can cross even if PAY
is pressed by mistake. A is **Foxy Test B**. Nobody presses SEND or PAY.

    A=FA245C2F-3FF0-4D15-A49E-420B75DF1C58
    DATA=$(xcrun simctl get_app_container $A <bundle id> data)
    S=<a scratch folder for the logs>
    tail -f "$DATA/Library/Application Support/foxy-logs/foxy.log" | grep -E "tap|pay from|home|back to"

**Before either run**, no other Foxy may be on a receive screen. A's payer
connects to the first receiver whose door is open and stays there, and every
simulator shares the ports. This must print nothing:

    lsof -nP -a -c Foxy -iTCP:47411-47418 -sTCP:LISTEN

(At 11:41 on 2026-11-01, Test C's receive screen held 47411.)

## Run 1: PAY FROM while the other phone waits

A needs sats at two mints, and **each** mint must cover N on its own. PAY
FROM never puts two piles together for one payment (26l-pay-from.js header).
With an amount that only the two together cover, there is no PAY FROM screen.
Here, home is forge.flashapp.me and M2 is A's other mint, written exactly as A
lists it.

1. A is on home. Start the receiver:

       python3 tools/sim/tap-standin.py receiver --only $A --sats N --mint <M2> --log $S/run1.log

   It prints `on the air at 127.0.0.1:47411`, then within a second
   `a payer knocked: Foxy Test B` and `rx < near left -> door byte 0`. A shows
   the nearby card.
2. `touch "$DATA/Documents/sim-touch"`. Within a second the receiver prints
   `rx < hello -> code NNNN` and `rx > offer {v:2} req N sat at M2 …; up=True; ask=1`.
   - A's diary says `waiting up to 5s` for an invoice (26d-tap.js:2277), and A
     shows "Getting their invoice".
   - After 5 s it says `no invoice in five seconds; moving the sats to their mint`.
   - A then opens PAY FROM, "Pay … from", with two tiles: M2 (no fee) and
     forge (a crossing, quoted only).
   - Nothing is sent over the link while PAY FROM is open.
3. Sit on PAY FROM for **2 minutes**. Touch nothing. The receiver prints
   `clock` lines at link+25, +90, +95 and +120 s. Each line names the timer and
   says what arms it. None of them is armed in this run, so per the code the
   link should stay up and a real B would still show its code.
   - If `THE PAYER WENT AWAY` appears, or A leaves PAY FROM by itself, write
     down the link+ time. That is a finding.
4. Press **CANCEL** on PAY FROM. The receiver prints
   `PAYER GAVE UP: "The payer cancelled."` (26l-pay-from.js:597).
   - When A reaches home, its old link is retired: expect `THE PAYER WENT AWAY`,
     then a fresh knock.
   - Stop the receiver with Ctrl-C.
   - If a crossing confirmation shows instead, press CANCEL or BACK. Nothing
     moves before PAY.

Optional variant: add `--asking-at 1`. The receiver then sends `asking` 1 s
after the code, as a B whose person is deciding does, and seals
`504 "They did not answer in time."` at +90 s, as `SimTapReceiver.sendAsking`
does. This changes A's screen to the waiting stage.

## Run 2: a tap during the trip home

**The refusal is spoken by the payer.** `'The payer is changing mint; tap again
in a moment.'` (26d-tap.js:1444) is what A, **as payer**, sends the receiver
when an offer lands during `_homeGoing`. The stand-in is therefore the
**receiver**. A as receiver never meets it: `openReceive` waits for the trip
(12-receive.js:35), and `railRequest` offers nothing during it (12-receive.js:88).

**Cancelling a scanned Cashu request does not start a trip home.** PAY FROM
and the crossing quote are asked with the phone left where it is. The visit's
connect happens only once the payment is being made
(`makeTokenForRequest`: `ready = … W.connect(want, …)`).

**The no-money trip is an on-chain PAY FROM.** Choosing another mint's tile
connects there at once, only to ask its fee (26l-pay-from.js `pfOnchainGo`).
CANCEL on the confirmation runs `ocCancel → pfOcHome → crossComeHome`, which
connects home over Tor with `_homeGoing` held.

1. Put a payout URI on A's pasteboard. The address must be one you
   control, in case of a slip.

       printf 'bitcoin:<ADDR>?amount=0.00005' | xcrun simctl pbcopy $A

   The amount, here 5,000 sats, must be covered by both forge and M2. Home
   must send on chain, or `payOnchain` refuses with a toast.
2. On A: SEND, paste. PAY FROM shows "Pay … from" with tiles that say "Fee on
   the next screen". Choose the **M2** tile. A's diary says
   `pay from: visiting … for its on-chain fee`, and A shows CONFIRMATION with
   the fee (or an error with CANCEL). **Do not press SEND.**
3. Only now, with A not on home or SEND (so not listening), start the
   receiver:

       python3 tools/sim/tap-standin.py receiver --only $A --sats 21 --mint https://forge.flashapp.me --log $S/run2.log

   Then `touch "$DATA/Documents/sim-touch"`. The file waits until A listens.
4. Press **CANCEL**. A's diary shows `home waits: an on-chain confirmation …`,
   then `back to https://forge.flashapp.me …`; that connect is the trip. A is
   on home and listening, so within about 2 s the receiver prints:
   - `a payer knocked`
   - `near` / `door`
   - `hello -> code`
   - `offer`
   - about 0.9 s later (26d-tap.js:1492):
     `PAYER GAVE UP: "The payer is changing mint; tap again in a moment."`

   A's diary shows `tap: the phone is on its way home; this tap is refused`,
   and its toast reads "Foxy is getting back to your mint. Tap again in a
   moment."

   **This is a race.** The window is the Tor connect home. Forge's keysets took
   4,083 ms in Test B's diary at 11:34:53, but the connect can also be shorter
   than the ~2 s the tap needs. If the trip lands first, A treats the offer as
   a same-mint request and opens it: press BACK (nothing moves before PAY,
   and `ask:1` makes A ask first, which the stand-in refuses). Repeat from
   step 2.
5. Stop the receiver with Ctrl-C, then `rm -f "$DATA/Documents/sim-touch"`.

## The clocks, as the code has them

| Side | Clock | Where | Armed by |
|---|---|---|---|
| receiver | `resultWait` 25 s → 504 "Their wallet did not answer in time." | TapLink.swift:237, :2189 | a `pay` |
| receiver | `askingWait` 90 s → 504 "They did not answer in time." | TapLink.swift:241, :2280 | B sending `asking` |
| receiver | stop grace `resultWait` + 2 s | TapLink.swift:2328 | — |
| receiver | bridge `resultWait` + 5 s | FoxyBridge+Tap.swift:116 | — |
| receiver page | `_tapTalkT` 95 s | 26d-tap.js:2755 | B's person deciding |
| receiver page | carry-home `_carryHomeT` 120 s, then home | 26d-tap.js:2921 | the terms leg for a payer with no route |
| receiver radio | handshake 3 s | TapLink.swift:181 | — |
| payer | 30 s after `hello` with no offer | TapLink.swift:2519 | — |
| payer | invoice wait 5 s | 26d-tap.js:2277 | — |
| payer | offer beat 0.9 s | 26d-tap.js:1492 | — |
| payer | ask-first 6 s | 21-native-bridges.js:367 | — |
| payer page | price or carry-home answer 90 s | 26d-tap.js:3285, :3502 | — |
| payer | `tapSend` 40 s + 1 s per 2 KB | 21-native-bridges.js:156 | — |
| payer | stranded 15 s; idle-on-home backstop 15 s | 26d-tap.js:1280, :526 | — |
| payer | change wait 30 s | 26d-tap.js `CHANGE_WAIT_MS` | — |
| payer radio | `personWait` 95 s after `asking` | TapLink.swift:949, :1730 | Bluetooth only; `SimTapPayer` has no such clock |

Nothing on either side is armed while A sits on PAY FROM.
