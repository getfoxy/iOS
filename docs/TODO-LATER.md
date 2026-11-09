# TODO-LATER.md — decided, and deferred

Work that has been looked at and is worth doing, but not now. Each item says
why it matters and where to start, so it can be picked up cold.

## Sending other units

Other units are restored, received and shown
(`foxy.cashu.proofs.<mint>@<unit>`). But `sendToken`, `pay`, moves, export and
splits are sats only, and a non-sat send is refused.

Start: `sendToken` with a `unitWallet`, amounts and fees in the unit, and the
token screen via `formatAmount`.

## An explicit ceiling on the on-chain melt

Every other mint call has a timeout of its own; the on-chain melt has none and
is bounded only by the bridge's 65 seconds (`bridgeAsk`). Measured, not hoped —
`tools/live/faults.js onchain` scenario f4b pins it at 65 s — but the ceiling
belongs in the wallet beside the others, not in the transport.

## A small thing the timer sweep turned up

- `retryConnect`'s `.catch` also catches a throw from `walletReady` on the
  success path, so a broken `walletReady` would reconnect in a loop rather than
  showing anything. Opposite failure mode to the sweep's; left alone
  (`build/app/06-wallet-boot-and-restore.js`).

## Dead weight still in the tree

- `moveRun`'s comment (`14-moving-between-mints.js:moveRun`) says `connect()` to the
  destination finishes an interrupted claim. It is `walletReady` in the app that
  does. The behaviour is right; the comment sends a reviewer to the wrong file.

## The on-chain claim's partial recovery is a one-shot

When a lost claim is rebuilt from its counters, `record.issued` is set to what
the mint says it issued even if `liveUnheld` returned less than that. Defensible
— the recorded ranges have been asked and there is nothing else to ask — but it
means one pass is all a partial recovery gets (`16a-onchain.js`).

---

## Tap to pay, deferred

- **The four digits are offered, not enforced.** The step that made the payer
  confirm the code matched the receiver's screen was removed as one tap too
  many. It is the only thing between a payer and a relay with a directional
  antenna, and proximity is not a defence. Worth bringing back conditionally —
  above an amount, or behind a setting someone turns on walking into a crowded
  place — rather than always or never. Start: `cfCodeUp` in
  `build/app/25-render-confirm-and-blocked.js`, and the confirmation's CTA.
- **A payment in flight is torn down by navigating.** Backing out of the
  confirmation, or stepping between a split's screens, drops the Bluetooth link
  the payment was crossing; it falls back to the request's onion address. Two
  things have since reduced it to a few seconds rather than two minutes: the
  receiver keeps its address answering for 90 s after the screen goes, and its
  radio link outlives the screen by as long as an answer may take
  (`TapReceiver.stop(whenIdle:)`). Still worth closing at the source. Start:
  `handleTapPayStart`'s unconditional `endTapPay("Started again.")`.
- **The payer has no way to see why a tap did nothing.** The payer listens
  from home and from SEND and has no screen of its own, so a
  radio that is off, denied or unsupported reaches the page as a stage nothing
  displays. Before, the tap screen said so. Worth a line on home when a tap is
  heard and Bluetooth cannot answer — which is detectable, because the stage
  arrives either way.
- **Handing an ecash token over by tap.** The token screen had an NFC button
  that had never had a click handler; it was removed rather than wired up,
  because the link is built around a payment request and a token is not one.
  It is a real feature and the handshake would carry it unchanged.

## Several accounts in one Foxy

Asked for 2026-11-09. One Foxy holds several accounts, each with its own words,
its own Cashu ID, its own mints and balances, and a name the person gives it: a
personal one, and one for each business or website, so streams of money stay
cleanly apart. An account shows the total across its mints; switching accounts
switches everything (ID, drop boxes, shops collected from, history).

With it, a cross-mint check-in: today only the active mint is connected to and
asked about on open. Every mint of every account should be checked, so a
payment that landed at a mint not on the screen is still counted and collected.
What arrived since the last look is shown on a notifications screen rather than
only in each mint's history.

Not designed yet: where the words of the other accounts live (the keychain holds
one seed today), how the per-account Cashu ID inbox is listened to without
multiplying relay traffic, and what the check-in costs over Tor with many mints.

## Several Cashu IDs, one per purpose

Asked for 2026-11-09. Foxy holds one Cashu ID per wallet today. The person
should be able to make more from the same words, at the next index each time,
name them (a market tip jar, a friend, a collaborator) and keep every one of
them open: a holder of one ID can count only that ID's boxes, and an old ID
keeps taking payments. Fifty is the expected number, growing over the years.

- Up to fifty IDs, every one is asked at every open, as the one ID is today:
  the average person hands out a few and should never wait. Above fifty,
  listening scales by activity, as the one-time request keys already do: an
  ID paid this week is asked at every open, a quiet one once a day, a dormant
  one once a week. A payment to a box nobody collected returns to its payer
  after thirty days, so a dormant ID checked weekly loses nothing.
- All of a phone's IDs are asked together on the same circuits: a relay learns
  that they share one listener, not who it is. Asking each on its own circuit
  does not scale and the counts were possible for any holder already.
- CHECK NOW under MY CASHU ID asks every known ID's boxes at once, for the
  person who expects a payment from someone who has not paid in a while and
  does not want to wait for the weekly turn.
- Restore from the words must bring the IDs back. The words give the keys at
  every index, not how many were made or their names. A restore scans a fixed
  depth (the first hundred indexes) and listens on all of them for the thirty
  days a payment waits, keeping any that receives; the names ride in the copies
  the phone sends its own recovery key, read back while the relays still hold
  them, otherwise an ID comes back as "Cashu ID 7" to be renamed.

## Tip or donate to an artist from the shop

Asked for 2026-11-09. Every collaborator in a shop's products file already has
a Cashu ID, so a card's page on the shop can carry a TIP THE ARTIST button: the
engine makes a Cashu request (and an invoice) locked to the artist's own
one-time key, exactly as a sale is locked to the keeper's, and the tip goes to
the artist directly, never through the keeper's phone. The artist's Foxy
collects it the way a keeper collects sales. Needs: a tip route in the engine
with the artist's ID as the lock, a tip page or a line under each card, and the
artist's phone knowing the shop (the drop-box notice once that is built).

## Decided: not doing

- **PIN length stays at four digits minimum.** Six would
  slow guessing on a phone in someone's hand; four was judged enough alongside
  the stored attempt limit.
- ~~**The seed does not require Face ID to read**~~ (decided, then reversed).
  The seed item now needs Face ID or the passcode for
  every read, and the page reads it once per load (`SEED-HANDLING.md`).
- **A copied token is not cleared when Foxy goes to the background.** People copy a token in Foxy to paste it into another app, so a
  copy stays on the clipboard for its full 120 seconds — device-only, never
  synced by Universal Clipboard — and then expires.
- **The system paste control stays invisible over the designed button.** A
  security review suggested drawing Apple's paste
  button visibly; on device it covered Foxy's own button in system yellow. It
  stays at 2% opacity, placed only where the rectangle checks allow.
- **Lockdown Mode is not turned on for the web view.**
  `WKWebpagePreferences.isLockdownModeEnabled` would disable WebKit's JIT, which
  is where a large share of browser exploits live. It also disables `src: url()`
  binary font loading, so a web view in Lockdown Mode draws no custom font at
  all. Foxy packs four woff2 faces and `satsymbol.woff2`, whose whole purpose is
  `unicode-range: U+20BF` — the ₿ on the balance pill and on every amount.
  Turning it on costs the typography and leaves the currency sign to whatever
  the system has, or to a missing-glyph box, on the screens that show money.

  What it would buy here is small. Lockdown Mode is built for a browser loading
  arbitrary remote content: hostile fonts, WebGL, WebAssembly, Web Audio, and
  JavaScript an attacker supplies to groom the heap for a JIT bug. Foxy's page
  loads no remote content, runs no remote script (`script-src` has no
  `unsafe-inline` and no `eval`, and the loader is pinned by hash), and cannot
  reach the network at all — the native side carries every request. With no way
  to run attacker script in the page, the JIT path is largely closed already,
  and the fonts Lockdown Mode blocks are Foxy's own, not a hostile site's.

  What remains is a memory-safety bug in a parser reached from data a mint
  sends, and disabling JIT does little about that. The defence there is the one
  already in place: the page is fed JSON and strings, never markup, and what a
  mint writes is drawn with `textContent` (checked by `cards-logic.js`).

  Reconsider if the page ever loads remote content, gains network access of its
  own, or renders anything a mint supplies as markup.
