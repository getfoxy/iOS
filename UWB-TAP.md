# Tap to pay, ultra-wideband only — a spec, not built

Status: design only. Nothing here is in the app. It describes what
would change if every tap had to prove distance by ultra-wideband (UWB) before
either phone showed a code or an offer.

## 1. Goal and non-goals

**Goal.** A receiver hands its offer only to a phone it has itself measured to
be within arm's reach, and a payer pays only a receiver it has measured the
same way. Today the only distance check is the payer's own reading of Bluetooth
signal strength, which the receiver cannot see and a stronger transmitter can
fake (TAP-TO-PAY.md; audit finding "handshake open to anyone").

**What it closes.**
- A stranger across the room completing a handshake and reading the offer.
- A stranger holding the receiver's one link so real customers cannot tap.
- A rogue receiver at a distance putting itself in front of a payer.

**What it does not do.**
- It does not replace the four-digit code. The code catches a man in the
  middle of the key agreement; ranging catches distance. Both stay.
- It does not hide that a receiver is on the air. The Bluetooth advertisement
  is unchanged.
- It is not perfect. A published attack shortened the distance Apple's first
  UWB chip reported in a few percent of attempts. Section 5 asks for several
  readings in a row so one lucky pulse is not enough.

## 2. Who can tap

Decided at run time by `NISession.deviceCapabilities.supportsPreciseDistanceMeasurement`,
never by a list of models. That one answer also covers airplane mode and the
countries where Apple switches the radio off.

| Phone | Tap |
|---|---|
| iPhone 11 and later, except the ones below | yes |
| iPhone XS, XS Max, XR | no |
| iPhone SE (2nd and 3rd generation) | no |
| iPhone 16e | no |
| Any phone with UWB off (airplane mode, region) | no, until it is back |

A phone that cannot range has no TAP button, never goes on the air and never
scans. Its receive and send screens work as they do today by QR, paste, Tor and
Nostr. Roughly 5 to 10 percent of iPhones (an estimate, not measured).

There is no fallback to signal strength. A fallback is the hole: an attacker
simply claims to be a phone without the chip.

## 3. Where ranging sits: the gate is the first thing on the link

Preferred design: distance gates everything, from the
quiet link on. One ranging session runs from the moment the link opens until
the handshake is done, and real distance replaces both Bluetooth thresholds —
the -54 dBm for the card and the -33 dBm for the handshake.

It cannot gate the link itself. UWB cannot measure a stranger: each phone must
first be handed the other's one-time token, the tokens are far too big for an
advertisement, and they must travel both ways. So a link has to exist first.
Nothing on an iPhone can refuse a Bluetooth connection either. What the gate
decides is whether anything comes of it.

```
payer                                   receiver
  hears the advertisement, opens the quiet link (as now, about -64 dBm)
  T1  ranging token, in the clear ─────►
      ◄─────  T2  ranging token, in the clear
  both start an NISession and keep it running

  over 1.0 m          nothing on either screen; link dropped after 5 s
  within 1.0 m        CONNECT TO PAY on both screens (model read as now)
  within 0.25 m       the handshake may start

  M1  promise of a key        ─────────►
      ◄─────────  M2  key
  M3  key revealed            ─────────►      keys agreed
  B1  sealed: hash of T1 and T2 ───────►
      ◄───  B2  sealed: the same hash
                                              code on both screens
      ◄─────────  M4  offer
  ... M5 onward exactly as today
```

- **T1 and T2 go in the clear** because no keys exist yet. They are random,
  made for this link only, and say nothing lasting about the phone.
- **B1 and B2 tie the measurement to the keys.** After M3 each side sends,
  sealed, a hash of the two tokens it ranged with. If they differ, someone
  swapped a token on the way and the phone that was measured is not the phone
  that holds the keys: the link is dropped and nothing is shown.
- **The code and the offer wait for B1/B2 and a passing verdict.** A handshake
  attempt from a phone not measured within 0.25 m is refused at M1.
- **The receiver decides for itself.** It accepts M1 only from the central it
  is ranging with and has measured close. The payer applies the same rule to
  the receiver, which is what stops a rogue receiver at a distance.
- The near doors stay: the payer still says which edge, and the receiver still
  says "on the amount screen". They are honoured only inside 1.0 m.
- Tokens are `NIDiscoveryToken`, archived with `NSKeyedArchiver` (secure
  coding), about 100 bytes, sent in pieces on a new `range` characteristic.

An earlier draft ranged only after M3, for one second. That was simpler but
left Bluetooth signal strength as the trigger and let a distant phone get as
far as agreed keys. Gating at the link is the better design; its costs are in
section 6.

## 4. Versioning and old Foxys

- Protocol version goes to 3. M1 carries it. A v2 M1 is refused with a reason
  the old payer shows as "This Foxy needs updating to tap".
- The near-door byte gains bit 2, "ranging required", so a current payer can
  say the same thing before it ever tries.
- A v3 payer meeting a v2 receiver does not pay it by tap.

## 5. The distance rules

Each phone runs these on its own readings from `session(_:didUpdate:)`.

| Stage | Distance | Readings in a row | Why |
|---|---|---|---|
| Card shows | at most 1.0 m | 2 | A person walking up, not someone across the room. |
| Card comes down | over 1.3 m | 3 | A gap between the two so the card does not flicker at the line. |
| Handshake allowed | at most 0.25 m | 3 | The UWB antennas are believed to be at the top of the phone, so phones touching elsewhere can read 10 to 20 cm. Three in a row turns a few-percent forgery into about one in ten thousand. |
| Still close at B1/B2 | at most 0.25 m, latest reading | 1 | The phone that shook hands is still the one in reach. |

- A reading with no distance (`distance == nil`) counts as far and resets a run.
- No reading at all for 3 s after T2: the link is dropped and the phone is not
  tried again for 10 s.
- Over 1.0 m for 5 s: the link is dropped quietly, so another payer can have it.
- Bluetooth signal strength decides nothing. It is used only to choose which
  advertisement to open a link to first (the strongest).

Failure never changes a screen. The diary says which rule failed. The receiver
counts links that reached T2 and were never measured inside 1.0 m; three inside
a minute puts a quiet line on the receive screen, "Someone out of reach is
trying to connect", with the existing X to go off the air. That is the visible
sign of an attacker, without a timer that could drop a real customer.

What this removes: the -33 dBm misses ("pressed together and still not
connecting"), the per-model edge table as anything more than a hint, and the
whole question of which phone's reading of signal strength to trust.

## 6. iOS requirements and costs

- `NearbyInteraction` framework; `NSNearbyInteractionUsageDescription`, as an
  `INFOPLIST_KEY_` setting in `project.yml` (the Info.plist is generated:
  `GENERATE_INFOPLIST_FILE: YES`).
- iOS asks the person to allow it. The prompt appears the first time a session
  runs, on each phone. Refusal arrives as `NIError.userDidNotAllow`; Foxy then
  treats the phone as unable to tap and says how to turn it back on in Settings.
  The prompt should be raised from Settings in Foxy ("turn on tap to pay"),
  not in the middle of a customer's first tap.
- One `NISession` per peer, made at T1/T2 and invalidated when the link drops,
  when the tap finishes, and when the app leaves the foreground. A suspended
  session is not resumed; the tap starts again.
- Both apps must be in the foreground, which a tap already requires.

Costs of gating at the link, compared with ranging for one second after M3:

- **More radio time.** Ranging runs for as long as a payer lingers within
  Bluetooth reach of a receive screen, not one second. Small, but it is the UWB
  radio on both phones for that whole time.
- **A payer's home screen now transmits.** Today a Foxy on its home screen only
  listens. Under this design it ranges with any receiver it links to, so it
  emits UWB while one is near. It still emits nothing when no receiver is.
- **Tokens in the clear**, mended by B1/B2.
- **One payer at a time**, as today: a session is per peer, and the receiver
  ranges with whichever payer holds the link. The 5 s rule frees it.

## 7. Screens

- **Unsupported phone:** no TAP emblem on the receive screen; AUTO TAP TO PAY
  in Settings is greyed with one line saying this iPhone cannot measure distance.
- **Permission off:** the same, with a button to Settings.
- **Connecting:** as now. Ranging is already running by then, so the
  handshake adds only the B1/B2 round trip.
- **Out of reach:** nothing on the payer's screen but the card returning; the
  quiet line on the receiver after three failures.

## 8. What stays as it is

Change (M7/M8), the asking clock (M9), price agreement (M10/M11), split bills
and offline paying all ride the link that ranging approved. No second ranging
is needed: the keys were tied to the measured phone at B1/B2. Ranging needs no
network, so offline taps work.

## 9. Code touched, if built

| Place | Change |
|---|---|
| `Foxy/Bluetooth/TapProtocol.swift` | v3, T1/T2 and B1/B2, the distance rules as a pure type replacing `TapProximity`, unit tested |
| new `Foxy/Bluetooth/TapRanging.swift` | owns the `NISession`, feeds readings to the verdict |
| `Foxy/Bluetooth/TapCrypto.swift`, `TapLink.swift` | a `range` characteristic; tokens on the quiet link; cards and M1 gated on distance; code and M4 held until B1/B2; failure counting on the receiver |
| `Foxy/Bridge/FoxyBridge+Tap.swift` | capability and permission to the page; the "out of reach" event |
| `build/app/26d-tap.js`, `24-render-receive-and-send.js` | hide TAP when unable; the quiet line; Settings row |
| `project.yml` | `INFOPLIST_KEY_NSNearbyInteractionUsageDescription` |
| `TAP-TO-PAY.md`, `THREAT-MODEL.md`, `DEVICE-TESTS.md` | the new claim and how it is tested |

## 10. Tests

- **Unit:** the verdict type against scripted readings — three close in a row
  passes; a nil in the middle resets; one far reading fails; the clock fails.
- **Page:** TAP hidden without capability; no code shown before the verdict
  event; the quiet line after three failures.
- **Devices:** every pair among several UWB-capable models, an earlier chip and
  a later one at least, in each edge arrangement, recording the distance read
  when touching, at 30 cm and at 1 m. A phone with no UWB (an iPhone XS, for
  one) confirms the "cannot tap" path.
- **Attack:** a third phone running a build with the Bluetooth threshold
  removed, 3 m away: it must reach T2, be refused at M1 and be dropped, with
  nothing on the receiver's screen until the third try. And a token swapped in
  transit must fail at B1/B2.

## 11. Open questions

1. The threshold. 0.25 m is a guess until the device matrix is measured. The
   UWB antenna is believed to sit at the top of the phone by the cameras (from
   teardowns; Apple does not publish it, and it is not measured here). The
   hearts on the CONNECT TO PAY cards mark where *Bluetooth* reads strongest,
   which is on the side edges, so phones touching at the hearts can have their
   UWB antennas 10 to 20 cm apart. Under this design the hearts become a hint
   only, and could move to the top or go.
2. Whether three readings inside a second is always available. If the first
   reading is slow on older chips, the 3 s clock may need to be 4.
3. Whether to keep a signal-strength mode behind a setting for XS, SE and 16e
   owners who accept the weaker check. This spec says no; it is still to be decided.
4. Cost in taps lost to the permission prompt being refused.
5. Gating at the link replaces `TapProximity` and its tests, which is most of
   the work beyond ranging after M3, along with the device matrix.
6. Whether a payer's home screen ranging with any nearby receiver is an
   acceptable change to what a Foxy emits. Today it emits nothing there.
