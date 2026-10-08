# Tap to pay

Two phones held close together hand an offer from the one receiving to the one
paying over Bluetooth Low Energy. Nothing goes over the network until the payer
pays, and that goes over Tor like anything else.

The offer carries both ways of being paid, and the payer picks. **Two Foxys on
the same mint pay with ecash**, and the ecash goes back over the same Bluetooth
link a moment later: no Lightning route, no fee, no onion rendezvous, and the
mint never sees a payment between two of its own users. On different mints the payer uses the Lightning invoice.
The payer is never asked which — only the payer knows what mint it is on, so it
decides without a question.

The payment goes over the link **only for a request that arrived over that same
link**. A request scanned from a screen is paid the way it says to be paid; the
alternative would be handing money to whichever phone happened to be connected.
A link that has gone by then falls back to the request's own transport, so a
failed hand-over costs the time it took to try and nothing else.

## What each person does

1. **Receiver** opens an invoice (RECEIVE, amount, Lightning). The screen puts
   the phone on the air by itself, under a service UUID made fresh for this
   payment; the QR stays up, and the TAP button lights to say the phone is on
   the air. Pressing TAP brings the TAP HERE card over the QR, or a fresh
   number after a payment. A shake presses it too, but only when the screen has
   not armed itself (*Shake*).

   **The screen is the whole of it** (it used to be the press). The rule that
   matters is older than either: whoever advertises is findable, so **nothing
   advertises from home**, and the payer never advertises at all. What changed is the
   receiver, and the argument for it: an iPhone with Bluetooth on advertises
   Apple's own services all day and lets any stranger connect and read its
   model number, Foxy or no Foxy. What Foxy adds is one random 128-bit UUID
   that never repeats and names nothing — a sniffer cannot tell it is Foxy,
   cannot tell it is a receive, and cannot link two of them. With only a
   press putting it on the air, an advertisement was a tap, to anyone who
   knew the shape; with every invoice advertising, a tap is one among many.
   The payer loses nothing; the receiver gives up that its phone is
   discoverable as a nondescript peripheral for the length of an invoice
   instead of a tap. MENU › SETTINGS › AUTO TAP TO PAY, switched off, turns it back into a press.
   `tests/tap-offer.js` checks the arming and smoke check 43 reads both sides.

   A phone that subscribes takes nothing by it: the receiver stays on the air
   and its one place goes to the first phone to say a first word (M1,
   `TapPlace`). A subscribe used to take the place for five seconds, so
   anything in range could hold a till off the air by subscribing, saying
   nothing, and doing it again. A phone that begins the handshake and stops is
   let go after three seconds (`TapLink.handshakeWait`). Anything in range can
   still begin a handshake, as it can jam the radio; what it can no longer do
   is hold the place by listening.

   The press can come **before the invoice is ready**. Nothing in the handshake
   needs the offer — it is M4, and the four digits are settled at M3 from a
   transcript the offer is not in — so the phones talk, both screens show the
   code, and the offer follows the moment the page has one
   (`TapReceiver.offerSent`). That is about a second of waiting taken off the
   front of every ecash tap.

2. **Payer** holds their phone against the receiver's, touching or nearly.
   There is no screen to find and no button to press: Foxy listens from home and
   from SEND, so a phone in somebody's hand is already able to pay. Listening
   emits nothing — a central hears and says nothing — so a customer carrying
   Foxy through a room full of merchants gives away nothing they could be
   followed by.

   Choosing lands on the right side too. A central picks who to talk to by
   signal strength; a peripheral cannot, because CoreBluetooth gives it no
   reading for whoever connected. The person holding the phone that is about to
   spend is the one doing the choosing.
3. The payer's phone buzzes. At the same moment the receiver's orange card
   becomes four digits, and the receiver goes off the air — it stops advertising
   at the subscribe, which is the earliest moment a peripheral can see anything
   at all, so a second phone cannot find it mid-payment.
4. The payer's confirmation opens by itself, showing the amount and, as large as
   the amount, the same four digits under `DELIVERED TO`. They tap SEND. Nothing
   makes them compare the two screens — that step was there and was taken out
   as one tap too many — so the code is a check offered, not a check enforced.
5. Afterwards the receiver's X lifts the card off the QR, and TAP takes the next
   customer — as a **new** receiver, with a new UUID and new keys, so two
   payments taken by one merchant are not the same number twice.

## How it works

**Version 3** (`TapCrypto.version`; see *Versions*). The v1 protocol — a fixed
service, three characteristics, and a code over the offer and a nonce — was
replaced by the commitment handshake below (`TapCrypto.swift`,
`TapSession.swift`); version 3 is that handshake with a version byte in front
of its first two messages, and every sealed message bound to its own kind.
`TapProtocol.swift` still holds v1's service and characteristic UUIDs and its
code function; the app uses none of them (only a test calls the code
function). Its size limits are still in use.

The receiver is a Bluetooth *peripheral* and advertises while its invoice
screen is armed: by itself under AUTO TAP TO PAY, on a press of TAP with it
off. The payer is a *central*: it scans, and never goes on the air.

This has been both ways round. The receiver advertised first; the roles were
swapped because a till that advertises all day is a beacon, and swapped back
with the thing that made it a beacon removed: **nothing advertises from home**,
and the receiver only from an invoice screen (it was only after a press, until
the screen took that over). What is left of that leak is real and bounded, and
it is the merchant's rather than the customer's: see *What it gives away*. What
it buys is that the payer needs no screen, which could not be had the other way
round.

The protocol did not move with the roles. `TapSession` names its six messages by
role and the payer still speaks first; as a central it connects, subscribes and
then writes, which is the same order over a different transport.

| | |
|---|---|
| Service | a fresh random 128-bit UUID for each payment (`TapCrypto.newService`). There is no fixed service to scan for |
| `out` characteristic, notify | derived from the service UUID; the payer speaks down it |
| `in` characteristic, write | derived the same way; the receiver writes back |

The advertisement carries that one service UUID and nothing else: no name, no
code, no amount, no manufacturer data. The receiver scans for everything and
picks Foxy out by the *shape* of the advertisement — one 128-bit service, no
manufacturer data, connectable — then confirms it by the derived
characteristics, which is what actually says Foxy.

**Finding the receiver.** The payer keeps each phone's signal strength over
the last two seconds. A phone counts as close when it has been heard at least
twice over at least 0.35 s and the middle reading is **-33 dBm** or stronger,
read at the weaker half of a pair. If a second phone is within 8 dB of the
first, the closer one is chosen, judged across a full second. A receiver heard
at -54 dBm or stronger but not close enough puts TAP TO PAY on the payer's
screen, so the person knows to hold the phones together — or to press it, which
takes that receiver without touching, down to 8 dB below the toast's own line
(-62 dBm) because the signal wanders while the toast is up: a press is a decision, and
the code and the amount still follow. Signal
strength decides which phone to talk to; it proves nothing about who owns it,
and the code does that. See *Tuning* for why each number is what it is.

**Two receivers side by side.** Before any tap the payer opens a quiet link to
the strongest receiver it hears and says "near" down it, which is what puts
CONNECT TO PAY on that receiver's screen (*CONNECT TO PAY and the near doors*).
That link was opened once and never looked at again. With two tills on a
counter it stayed with whichever was heard first: that till went on showing
the card while the phone was held to the other, which showed nothing, and it
worked only when the first till's invoice was closed. The link now moves to
another receiver that has plainly been the nearer one: near enough to be told
about, heard for a full second, and stronger by more than the 8 dB two phones
side by side differ by (`TapProximity.rival`). The first till's card comes
down as the second's goes up. Not more than once in three seconds, and two
tills that read alike keep the link where it is; whichever is touched is the
one that is paid. `TapProtocolTests` (`testAnotherReceiverPlainlyNearerIsARival`
and the three after it); `DEVICE-TESTS.md` §22i.

**The six messages.** Nothing is sealed until M4, because there is nothing to
seal until both sides hold a key. M1 to M3 are public by design: two public
keys, two nonces and a hash.

    M1  payer → receiver   its version, and a promise about a key not yet shown
    M2  receiver → payer   its version, and the receiver's key and nonce
    M3  payer → receiver   the key it promised; the receiver checks it
    M4  receiver → payer   the offer, sealed
    M5  payer → receiver   the payment, sealed
    M6  receiver → payer   what happened to it, sealed — the receiving
                           *page's* word, not its radio's

M6 carries a code, and the payer acts on it: **200** means written down where a
force-quit cannot lose it, and only then does the payer forget its copy of the
payment; **409** and **504** mean it may have landed and may not, so the payer
keeps the token and watches for the claim; **422** is a refusal, and the payer
does not fall back to the request's own transport, because every refusal the
receiver can give is the same refusal over the other wire. Only a link that has
*gone* falls back. The receiver gives up on its own page after 25 seconds and
seals a 504, so the payer always hears something.

M6 used to be sealed the instant the bytes arrived, before the page had looked
at the payment — and the payer deletes its only copy on the strength of it. A receiver whose page had reloaded refused a moment later and the money
was gone from both sides.

The offer is the same JSON as before, at **version 2** and padded to a flat
2048 bytes so its size says nothing: `{"v":2,"inv":"ln…","req":"creqA…"}`.
Either field may be missing and at least one is there; on the CASHU rail the
request goes alone. The payment is padded up to the next multiple of 4096 bytes,
as far as 48 KB; a larger one goes in parts (*Large payments*).

**The code.** The two phones agree an X25519 key. Both then compute

    code = first 4 bytes of SHA-256(label ‖ transcript ‖ shared secret),
           as a big-endian number, mod 10000, as four digits

and the link keys come from HKDF-SHA256 over the same shared secret, salted
with the transcript — one key each way, sealed with ChaChaPoly under counter
nonces. The associated data is the transcript and the message's own kind: the
kind byte travels in the clear in front of the sealed bytes, and bound in like
this a message relabelled on the air is one that will not open. (It was not
bound, so a payer's "say that again" could be relabelled as "I kept the
change" and the receiver would have believed it; `TapSessionTests`,
`testASealedMessageRelabelledOnTheAirStopsTheLink`.) The transcript holds the
version both sides said, so neither can be talked down to another.

The commitment is what the four digits rest on. The payer hashes its public
key with a nonce and sends only that hash (M1); it reveals the key itself
(M3) after it has already seen the receiver's (M2). So neither side can pick a
key once it knows the other's, and neither can grind for digits it likes: an
impostor gets one attempt, at 1 in 10,000. A phone relaying between the two
agrees a different secret with each of them, so the two screens show different
digits.

Nobody is made to compare them. That step existed and was taken out as one tap
too many, so the code is a check offered, not enforced —
which is the single largest caveat in this document and is recorded in
`TODO-LATER.md`.

## What it gives away

- **The receiver is the one on the air**, from the moment its invoice screen
  arms (or TAP is pressed, with AUTO TAP TO PAY off) to the moment a payer
  subscribes. Anyone within Bluetooth range (tens of metres) sees
  one 128-bit service UUID, fresh for that payment, with no name and no amount.
  It says a payment is being taken, here, now.
- **Anything that connects while it is on the air** can read what iOS serves
  any connection: the model number, the battery level, the time, and perhaps
  the iPhone's name from the Generic Access service. Foxy cannot turn that
  off, and a fresh service UUID does not hide it. This is the real cost of the
  roles being this way round: a merchant taking fifty payments offers it fifty
  times, and a scanner beside a busy till can collect it. It is bounded by the
  invoice screen — there is nothing to connect to between invoices — and it is
  the merchant's own device, not a customer's. A scanner on a third phone
  (`DEVICE-TESTS.md` §22b) found Device Information (manufacturer and model),
  Apple's Continuity and Nearby services, Battery and Current Time, with Foxy
  on the air or not, and no phone name among them; anything beyond that is
  reasoned from CoreBluetooth rather than observed.
- **The payer gives nothing away.** It never advertises, so a phone carried
  through a room full of merchants is not findable. It is not silent — iOS scans
  actively, so it sends scan requests as any scanning iPhone does — but nothing
  it sends says Foxy.
- **The offer is sealed** and crosses only after the handshake, so connecting
  is not enough to read it — **but the handshake is open to anyone** (an audit
  finding). It keeps out somebody listening; it does not keep out somebody
  talking. A device in radio range that speaks M1 to M3 is handed M4: the
  invoice and the request, which is the amount, the mint, this request's
  one-time onion address and its lock key — what the QR shows, to somebody who
  need not be able to see the screen. The receiver cannot measure how far away
  a payer is (CoreBluetooth gives a peripheral no signal strength for a
  central); the -33 dBm rule is the payer's own app being polite. With every
  invoice arming itself this is each invoice, not each press.
- **The same stranger can sit on the link.** One payer at a time: while it
  holds the handshake the code card covers the QR and nobody else can tap, and
  when it leaves the receiver is told a payer went away. A subscriber that says
  nothing is dropped after five seconds; one that completes the handshake and
  then says nothing is not dropped at all. Not fixed: the handshake is open to
  anyone (`THREAT-MODEL.md` §9).
- **A receiver that is not the one you meant.** The payer links to the
  strongest Foxy-shaped advertisement, and a press on TAP TO PAY takes one
  from -62 dBm — a couple of metres. Somebody advertising beside
  a till is offered the payment in the till's place, with their own request and
  the same amount. What catches it is the four digits, which their screen
  cannot show, and nobody is made to compare them.
- Within iOS's ~15 minute address rotation, two payments taken by one phone
  share a Bluetooth address, which links them to each other whatever the service
  UUIDs say.
- The first time a receive screen arms — or a payer's phone first listens — iOS
  asks for Bluetooth permission.

## Versions

The first byte of M1 and of M2, in the clear, is the version of the wire the
sender speaks. It is read before anything else, whatever follows it, so the
one thing every version can do with a message it cannot read is learn which
version sent it.

- **The same version**: the handshake goes on.
- **Another version**: the link is let go, and the phone says so — UPDATE FOXY
  TO TAP, "The other phone has a different version of Foxy, so the two cannot
  tap", with the code on the screen as the way through for now. A receiver
  answers the payer first with a hello that holds its own version and nothing
  else, so the payer's phone can say the same. The payer then leaves that
  phone alone for ten seconds, as it does one that is not a Foxy.
- **A Foxy from before the version byte** (version 2) sends a promise with
  nothing in front of it. A receiver tells it apart by its size and raises the
  card. The other way round nothing can be said: the older receiver reads a
  newer promise as one of the wrong size and stops, and the newer payer sees
  only a phone that went quiet.

The labels in the hashes still say "v2": they name the handshake's shape,
which has not changed. The doors' labels must never change. They are how any
two Foxys find each other, whatever they speak, and a phone that cannot be
found cannot be told to update.

What a change of version costs: two phones on different versions cannot tap
until both are updated. They can still pay each other by scanning.

Tests: `TapSessionTests` (`testEachSideSaysItsVersionFirst`,
`testAPhoneFromBeforeTheVersionIsToldApart`,
`testAnotherVersionIsAnsweredWithThisOne`), `TapCryptoTests`
(`testTheVersionIsPartOfWhatWasAgreed`,
`testAMessageSealedAsOneKindDoesNotOpenAsAnother`), and `tests/tap-nearby.js`
for the card.

## Tuning

The cut-off is -33 dBm over a 0.35 s hold (`nearDbm`), in `TapProximity`
(`Foxy/Bluetooth/TapProtocol.swift`). Every reading is written to the field
log (`[tap]` lines), which is where the number comes from.

It belongs to a direction, and it has been measured in both. With the payer
advertising, touching read -37 to -44 and a hand's width -47 to -56, so the
cut-off was -52. With the **receiver** advertising, which is the arrangement
now, touching reads -33 to -41 and two feet reads -46 to -57: a much flatter
curve, and -52 let two feet pair. -44 was the middle of the measured gap for
that pair. A third phone moved it: an iPhone 15 Pro Max held against an iPhone
17 Pro read -45 to -51 either way round, and -44 refused a dozen taps. -50 took
it and paired too readily; -40 was touching, and nothing else; -33 is where it
stands, on trial (-30 was at the limit). A pair that reads weaker than that
when touching — the 15 Pro Max did — is shown CONNECT TO PAY from -54 and has
to be held tighter, or its case taken off. No one number is "touching" on every
pair; the next phone may move it again. Swap the roles again and it has to be
measured again.

**Two scales, never mixed.** An advertisement's RSSI and an open link's
`readRSSI` are different measurements and not a fixed offset apart — across 22
links they differed by anywhere from -10 to +15 dB, and on one tap the link
read -37 while the advertisements a third of a second either side said -46.
They are pooled separately. Advertisements decide. The link may only confirm,
and only when the phone's last advertisement has passed the same threshold.

**The pool has to keep being fed.** Opening a warm link used to stop
advertisements being recorded, so the pool aged out in two seconds and the
link's own reading was all that was left. Half the refusals in one session were
then a phone at **-33 dBm** — touching — turned away for `heard for 0.03s`,
because the only readings left were a burst captured in the 30 ms between a
retry and the next warm link. `didDiscover` records throughout now, and smoke
check 43 fails if that guard comes back.

The link is opened before the verdict and says nothing down it. Connecting and
iOS's service discovery cost about 1.3 s, and they used to sit between the
receiver deciding and the payer's screen hearing about it — the receiver said
CONNECTED at the verdict, the payer a second and a half later. So the receiver
opens a link to the likeliest payer as soon as one is plausibly near
(`warmest`, about a metre or two) and subscribes only when the verdict says
near: the subscribe is the first thing a payer's app can hear, and it is one
round trip, not four. A phone warmed and not paid learns nothing — no callback
reaches its app, nothing crosses, and the link closes.

A link answers `readRSSI` about once a second — an idle BLE connection drifts
to a slow interval — so the verdict decides on a pair of readings rather than
three, and reads a pair at its weaker half. Both have to be close; one strong
reflection beside one weak reading is still far. At three readings the verdict
could not be reached at all once a link was open: the receiver heard a payer at
-43 dBm and printed `only 2 reading(s)` for ten seconds.

The hold is the only other part of a tap Foxy spends. Every link logs where its
milliseconds went — `[tap] receive: link: connected …, service …, doors …,
payer spoke …` — and on the phones measured that is about 800 ms to connect,
600 for iOS's service discovery, and 200 for the characteristics and the first
word. CoreBluetooth offers no lever on any of it, which is why the hold is
where the shortening had to come from.

## Limits

- The Lightning and CASHU rails both work: Lightning offers the invoice and
  the payment request together, CASHU the request alone. On-chain does not and
  cannot — an address is not a thing one Foxy hands another over a link. Nor is
  a bank wire, nor a receive reopened from history as a plain address.
- Both apps must be open on screen. iOS strips a background advertisement down
  to almost nothing.
- The iOS Simulator has no Bluetooth. `FoxyTests/TapCryptoTests.swift` covers
  the handshake and `TapSessionTests.swift` runs both roles against each other,
  which is where the protocol is actually proved; `TapProtocolTests.swift`
  covers the framing, the offer check and the proximity rule. Two stand-ins
  carry a tap without a radio: a loopback link between two simulators
  (`tools/sim/README.md`), and `tools/live/tap-scenarios.js`, which runs a tap
  between two pages over a model of the link against local mints
  (`tools/live/README.md`). Neither tests the radio, so the rest needs two
  iPhones (`DEVICE-TESTS.md` §F).

## Shake

A shake presses TAP on the receive invoice screen, for a receiver that has not
armed itself. Only the receiver has it: the payer listens from home and from
SEND with no button, so there is nothing for a shake to do on that side.

**With AUTO TAP TO PAY on, the default, a shake does nothing.** The screen has
already armed itself, and a shake while armed is ignored: a second press of the
button would put the code card away, and a shake is not a way to dismiss
anything. The shake presses TAP only when AUTO TAP TO PAY is off.

- **The system's shake.** `UIEvent.EventSubtype.motionShake`, heard by the
  host controller (`WebHostController.motionEnded`). What counts as a shake is
  iOS's decision, tuned by Apple across every iPhone; Foxy has no threshold and
  reads no sensor. Shake to undo is off for the app
  (`applicationSupportsShakeToEdit`), so a text field being edited does not put
  an Undo alert over the page.
- **Once.** The press it makes is subject to every rule `tapArm` has: it does
  not tear down a payer that is connecting, it does not re-arm a screen that
  is already on the air, and it never puts the code card away.
- **When it is listening.** Only while the receive invoice screen is up and has
  something a payer could pay (`tapOffering()`), synced from the same place
  `syncAwake` holds the screen lit (`syncShake`). Disarmed natively when the
  page goes (`stopTap`). A shake while disarmed is written to the diary and
  nothing else.
- **What it gives away.** Nothing over the air: a shake is a press.
- **Not in it.** No shake on the payer's side, no shake to *send*, no haptic of
  its own (`tapArm` already buzzes).

| Where | What |
|---|---|
| `Foxy/FoxyWebView.swift` | `canBecomeFirstResponder`, `motionEnded` → `bridge.shaken()`; shake to edit off in `viewDidLoad`. |
| `Foxy/Bridge/FoxyBridge+Tap.swift` | `shakeStart` / `shakeStop` set and clear `shakeArmed`; `shaken()` pushes `TapStage.shake` to the page while armed. |
| `build/wallet/21-native-bridges.js` | `shakeSense(on)`. |
| `build/app/26d-tap.js` | `syncShake()`, and the `shake` stage in `tapHeard`, which calls `tapArm()` only when the screen is not already on the air. |
| Diary | `[foxy] tap: shake to tap on`, `shaken; pressing TAP`, `shaken, but shake to tap is off`, `shake ignored — …`. |

Tests: `tests/tap-shake.js` (its page stub never auto-arms, so it covers the
press path only: the page arms on `{side:'receive', stage:'shake'}` only on a
receive screen with an offer, only when not already armed, and never while a
payer is connecting; `shakeStart` is sent when that screen comes up and
`shakeStop` when it goes), `tests/bridge-matrix.js` (the two actions are in
`handlers` and in the bridge table of `THREAT-MODEL.md`), and
`DEVICE-TESTS.md` §22f on two phones.

**Upside down is off.** A receiver may lay the phone on the table top-down so
that the payer across it can read the code. iPhones since the X will not rotate
an app upside down, so the page would turn itself: the host controller watches
`UIDevice.orientationDidChangeNotification` and tells the page (`_turned`), and
`syncFlip` (`build/app/26d-tap.js`) would rotate the document 180° while the
receive invoice screen is up and the phone is top-down. It is switched off
(`const FLIP = false`): a phone lying top-down made the tap less reliable,
because the marks and the edges to bring together stopped agreeing. The screen
stays as it is whichever way up the phone lies, and the code is kept for when
it comes back. Whether the phone is top-down is still told to the payer over
the near door (below), which swaps its own mark to the other edge.

## CONNECT TO PAY and the near doors

The receiver's service now has four characteristics: `in`, `out`, and two
"near" doors, `near left` and `near right`, derived from the service number
like the others. Nothing secret crosses them and no handshake is needed.

- The payer opens its quiet link at -64 dBm, reads the receiver's model
  (Device Information, 0x2A24), and at -54 dBm subscribes to the door for the
  edge of the *receiver's* screen the mark belongs on (`TapEdges`). That
  subscription is the receiver's only way to know a payer is near; it puts
  CONNECT TO PAY over its code.
- The receiver answers on that door with one byte: bit 0, this phone is
  top-down (the payer swaps its own mark to the other edge); bit 1, this phone
  is still on its amount screen (the payer keeps its card down until NEXT).
  Sent on subscribing and again whenever either changes, to each payer by name.
- The payer's card waits for that byte. A receiver that never sends one gets
  the card a second after the announcement; one whose link never warms, four.
- A receiver's service going away (`didModifyServices`) takes the payer's card
  down at once and drops the stale link.
- The handshake starts at -33 dBm (on trial; it was -40, then -30), and never while the receiver is on its amount screen: the payer warms the link and waits for the receiver's byte first, and the receiver refuses a payer that tries anyway. The receiver goes on
  the air from the amount screen, so the link is warm by the time NEXT is pressed.
- `TapEdges`: the Bluetooth antenna is not in the same place on every iPhone,
  so which edge to hold together depends on the pair. A 17 Pro receiver is
  measured; the 17 Pro Max and the 18 Pros are assumed to match it; the X to
  the 16 take the default.

## A payer or receiver that goes away mid-payment

iOS delivers nothing to a suspended app and keeps nothing for it, while the
Bluetooth link itself stays up. Six things follow from that.

- **M12, "say that again".** A payer that returns to the foreground with a
  payment handed over asks the receiver to repeat whatever it sealed from a
  given counter on. The receiver resends those frames byte for byte (the same
  ciphertext under the same counter, so nothing is sealed twice): the result,
  and the change if it has not been confirmed. The payer then waits six
  seconds, not the forty a phone that never left is given.
- **Change is given back only when the payer says so (M8).** The receiver's
  page is answered on M8, or told after seven seconds that it was not handed
  over; the change then goes on the payment's history entry as a code, and the
  YOU OWE THE PAYER CHANGE screen shows it. A late M8 is still heard and takes
  the code down. While an entry shows a code, the receiver asks the mint every
  fifteen seconds whether it was taken.
- **No waiting screen is the last screen.** SENDING and VERIFYING ECASH each
  offer STOP WAITING after thirteen seconds (it was eight: a tap answered in
  nine showed the button for a second and then the confirmation, which
  confused more than it helped).

- **A receiver put away with a payment in hand still answers it.** The page's
  answer to a tap payment waits in the same table as the answers for an onion
  address, and leaving the foreground emptied that table with the address. The
  page then took the money and had nothing to say so on; the link, still up,
  carried the receiver's own give-up instead, "their wallet did not answer in
  time", for money the receiver held. The tap's answers are kept across the
  background now (`tapAnswerKeys`, `closeInboxForBackground`).
- **A refused "say that again" is not the payment failing.** A receiver that
  has itself just been put away cannot take a write for a moment. The payer
  used to read that refusal as "gone" and show a code to scan; it now goes on
  waiting out the six seconds, and the receiver's answer ends the wait if it
  comes. It does not ask twice: a second question would be sealed under the
  next counter, would not open at the other end, and would stop a link that
  can still carry the answer.

- **The receiver knows its own.** The answer can still be lost: a payer that
  stays suspended for more than the two seconds the receiver keeps the link
  after answering never hears it, and shows the payment as a code. Scanned by
  the phone that already took it, the mint says spent, which says nothing of
  by whom. The wallet remembers a fingerprint of what it has swapped in
  (`noteTaken`; no secret is kept) and marks that refusal as its own, and the
  card reads YOU ALREADY HAVE THIS PAYMENT, with the amount and when, in
  place of "claimed already, by someone else or by this wallet". An online
  payer needs none of this: its code screen asks the mint and turns to paid.

The history audit names change that has not been collected (payer: SCAN
CHANGE) or handed over (receiver: SHOW QR CODE), marks those payments in red,
and counts a payment whose change is outstanding at its gross.

## Large payments, pieces, and what a phone holds

- **A payment of up to 128 KB.** A frame says its length in two bytes, so one
  message is 64 KB at most; a larger payment goes as `paymentPart` messages
  and a last `payment`, each sealed under the next counter, and the receiver
  joins them. When the whole is over 16 KB a `paymentSize` message goes first
  — sealed first, because messages open in the order they were sealed — so
  the receiver can show a percentage. Both screens show how far it has got:
  SENDING on the payer, RECEIVING ECASH on the receiver. Measured on phones:
  50 KB in 6.5 seconds.
- **Locked ecash is spent piece by piece.** A payment received with no route
  is locked to this phone, and each piece carries its own lock, so a piece is
  signed and handed on without the rest (`lockedProofsFlat`,
  `takeFromUnclaimed`). Whole payments are tried first; then loose and locked
  pieces together for an exact amount; then the least overpayment, taking the
  largest pieces that fit and the smallest that finishes. Real CDK and
  Nutshell mints accept a single piece signed out of a larger payment
  (`tools/live/p2pk.js`, section 9). YOUR CHANGE lists these pieces.
- **Ecash already held is not kept twice.** A token whose pieces are in the
  unclaimed store is refused when scanned, and change arriving a second time
  is kept once.
- **With a route, an exact set of more than 24 pieces is swapped** for a
  handful; with none it goes as it is.
- **Sats held for an unanswered swap** are accounted for in the audit, and a
  payment that is over the balance only because of them is blocked with
  "pending with the mint", on the amount screen and the confirmations.
- **A Lightning payment has to fit with its fee reserve** on the confirmation,
  before SEND.
- **Coming back online** claims what was waiting; the swap that claims it is
  shaped to fill the small-change pool (`MONEY.md` §13), and any top-up still
  owed runs the next time Foxy is put away. Nothing on screen waits for
  change, and no payment or answer waits behind a top-up.

## The word that the change was kept

The payer's page lets the link go the moment its change is written down, and
M8 — "I kept it" — was still in the write queue when the link was cut: a
receiver put away mid-handover never heard it and showed the change as owed.
`TapLink.stop` now waits for pending writes, two
seconds at most, before cancelling the connection, and both phones say what
happened: the payer logs "the receiver was told the change was kept" when
the write completes, the receiver logs any write it refuses. Change of less
than half a cent is shown in sats, not as $0.00.

## An invoice paid over Lightning, and the phone that has not heard yet

Ecash crosses the link and is answered on it, so both phones know at once.
An invoice paid over Lightning is not: the payer's mint pays the receiver's,
and the receiver learns of it from its own mint, on its own clock. For those
seconds the receiver is still on its invoice screen and on the air, and the
payer is home and listening. Both phones put up CONNECT TO PAY for a payment
that was already made.

Three things stand in the way now, each enough by itself.

- **The payer says so.** When the Lightning send finishes, the payer sends
  `{ "paid": { "tail": … } }` over the link that is still open (the payer to
  receiver message, M10): the last sixteen characters of the invoice the
  receiver itself made, and nothing else. The receiver does not believe it. It
  is a reason to ask the mint now: its watch on that invoice asks at once and
  then every second for twenty seconds (`watchKick`), the screen says
  CONFIRMING PAYMENT in the payer's words ("The payer says this is paid"), and
  it goes to PAYMENT RECEIVED only when the mint says so. If the mint has not
  seen it in twenty seconds the screen says that and the invoice is open
  again. A notice naming an invoice that is not on the screen does nothing.
- **The payer does not listen for five seconds** after a payment by tap, from
  the moment it is home again.
- **An offer already paid is not paid again.** The payer remembers what it
  paid by tap for a day: the end of the invoice and the request's id, on this
  phone only. The same offer heard again raises ALREADY PAID, "Nothing was
  sent again", tells the other phone once more, and lets the link go.

And without any word from the payer: once a payer holds the offer, the
receiver asks its mint every second for a minute instead of every ten, and for
thirty seconds more after the payer leaves with nothing said.

Tests: `tests/tap-paid.js`. On the simulator, a script playing a payer that
says "paid" without paying showed it: the wrong invoice did nothing, the right
one raised CONFIRMING PAYMENT, and twenty seconds later the invoice was open
and on the air again.

## Two mints: both phones online, or no payment

A tap between two phones on different mints is paid over Lightning, and
only when both phones can reach their mints. With either one offline, the
payer's phone stops at the offer: no price is discussed, no fee is asked
for, nothing is asked of either mint. Both phones show the same card —

    OFFLINE & DIFFERENT MINT
    Your receiver uses a different mint.        (payer; "Your payer" on the receiver)
    Both of you must be online to transact between mints.
    You use <this phone's mint> while they use <the other's>.

— the payer's from what the offer said (`up`, and the mint in the request),
the receiver's from a word the payer sends on M10 before it lets the link
go: `{ gaveUp, why: 'offline-cross', mint }`. `gaveUp` is the sentence an
older Foxy shows as it stands; `mint` is the payer's, so the receiver's card
can name both. The payer's card offers CHOOSE A MINT when this phone already
holds sats at the receiver's mint, since that is a same-mint payment one
switch away. A receiver that does not say whether it is online (an older
Foxy) is not taken for offline.

The same mint is untouched by this: offline on either side, or both, is
ecash over the link as before.

**What it replaces.** Two ways round the missing connection, both still in
the code behind `OFFLINE_CROSS` (`build/app/26d-tap.js`) and still covered by
`tests/crossings.js` and `tools/live/offline-cross-scenarios.js`:

- a payer with no route asked the receiver to come to the payer's mint, take
  the ecash there and melt it home (`tapStuckAtMint`, `tapCarryHome`);
- a payer with a route moved its sats to an offline receiver's mint and paid
  in locked ecash there (`tapCrossMint`).

Each is half a dozen questions of two mints, over Tor, while two people hold
their phones together. On two phones that was four tries to make one payment,
seven minutes to bring it home, and a card asking to bring it home again for
hours. What the diaries showed, each fixed whether or not the switch is ever
turned back on:

- **An invoice read as a refusal.** The receiver's Lightning invoice, coming
  in late, was sent on M11 — the message a question is answered on — and a
  payer waiting on an answer took an answer with no request in it for "no".
  It is not sent while a question is in flight, and a payer hearing one goes
  on waiting.
- **Two jobs for one payment.** The link dropped while the fee was being
  worked out and the payer asked again; each asking wrote a job down. The
  payment was written on the first, the walk home started on the second, and
  the second went on asking to be brought home out of whatever else the
  phone held at that mint. One asking now answers a repeat of itself; a walk
  asked for by a spare's name is the paid job's; a job with nothing paid to
  it is forgotten.
- **Stuck, said for ever.** A payment that could not be brought home or sent
  back was tried, and its card raised, on every launch and every return.
  It is said once and its job ends: the sats are the receiver's, at that
  mint, and the mint screen moves them.
- **A balance from two mints.** Ecash taken offline and waiting to be
  swapped in was added to the balance of whichever mint was on screen.
- **Questions put to the wrong mint.** A phone away at a payer's mint asked
  that mint about its own mint's invoice every three seconds.
