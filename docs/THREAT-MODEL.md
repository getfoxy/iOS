# Foxy — threat model

**Status: reviewed, then revised for a new network design.** Written to scope a
security review, then revised against it. An independent reviewer
examined an earlier version of the app in four passes over the wallet's money
logic, the native shell, the interface layer and the vendored supply chain,
every finding traced to code. It raised 22 findings. 20 are closed in the code
and 2 are kept partly open by decision (§12 has each one). Later review passes
are cited where they changed something; their reports are not in this
repository. See `NETWORK-TEST.md` for the runtime evidence the review itself
could not gather.

**Revised for Tor inside the app.** The review examined an app whose privacy
rested on Orbot or a VPN and a JavaScript gate. Since then:

- Tor runs inside the app.
- Every native request is routed by one decision.
- The web page has no network of its own.
- The seed is in the keychain.
- A PIN gates the app.

Where a passage describes the older design, it says so and the current design
sits beside it. This file records no independent review of the
changes made since.

The two questions the review left **[OPEN]**, whether the gate should enforce
(§4) and whether the seed moves to the keychain (§7), are both answered below.
What remains open is what has not yet been tested on a real phone (§9).

Foxy is a Cashu ecash wallet for iOS. It holds bearer tokens issued by a mint
and moves them over Lightning, with all traffic routed through a Tor daemon
running inside the app. It is not a company product. It has been reviewed as
described above and has had no formal audit.

---

## 1. What Foxy is, mechanically

A single WKWebView hosting a web application, with a Swift bridge for the
things the web cannot do — including every network request.

| Layer | Files | Does |
|---|---|---|
| UI | `Web/index.html` | every screen; built from `build/app/` (joined into `build/foxy-app.js`), `build/markup.html` and the renderer `build/foxy-render.js` |
| Wallet | `Web/foxy-wallet.js` | ecash protocol, keys, storage, and the hook every mint call goes through; joined from `build/wallet/` |
| Gate | `Web/foxy-tor-gate.js` | the screens shown while Tor connects or cannot; decides nothing |
| Host | `Foxy/FoxyWebView.swift` | stages `Web/` into Caches, blocks the page's network, covers the app-switcher snapshot, detects a reinstall |
| Bridge | `Foxy/Bridge/`, `Foxy/Tor/`, `Foxy/Network/`, `Foxy/Keychain/`, `Foxy/Scanner/`, `Foxy/Bluetooth/`, `Foxy/Nostr/`, `Foxy/TorSeed/` | camera, clipboard, share, notifications, keychain, Bluetooth tap to pay, Nostr delivery, and the network: `TorService`, `Bridges`, `Route`, `OrbotLink`, the onion inbox and post, and the relay directory a first run starts Tor from |
| Tor | Tor 0.4.9.12, built here from signed sources (`tools/build-tor.sh`), with Tor.framework 409.11.2's Objective-C wrapper, as a local CocoaPods pod | the Tor daemon, in the app's process |
| Transports | `Vendor/IPtProxy.xcframework` | obfs4 and Snowflake, built from source by `tools/build-iptproxy.sh` |

The bridge exposes exactly these actions:

- `scan`, `log`, `covered`, `fieldLog`, `fieldLogClear`
- `price`, `candles`, `mintRequest`
- `clipboard`, `copy`, `biometric`
- the seed and its counters, in every build: `seedStatus`, `seedCreate`, `seedMigrate`, `countersImport`, `counterReserve`, `counterReserveAt`, `counterAdvance`, `counterSnapshot`, `restoreSecrets`, `seedShow`, `seedEnter`, `seedAdopt`, `seedCandidateForget`, `seedWipe`, `seedProtection`, `seedProtect`
- the keys a payment request locks ecash to, derived from the seed at NUT-13's P2PK path: `p2pkReserve`, `p2pkPubkeys`, `p2pkKey`
- `orbotAccess`, `orbotRefresh`, `privacy`, `captured`, `torRetry`, `unprotected`, `isDebug`
- `hostsKnown` (once, the first time a version with host approvals runs)
- `previewStart`, `previewStop`, `pasteStart`, `pasteStop`, `notify`, `share`, `openSettings`, `openCompany`
- payment requests paid straight to whoever asked: `inboxOpen`, `inboxClose`, `inboxAnswer`, `onionPost`, `nostrSend`
- tap to pay, an invoice or a payment request handed over Bluetooth: `tapReceiveStart`, `tapReceiveStop`, `tapPayStart`, `tapPayStop`, `tapSend`, `tapChange`, and `bluetoothAsk`, the first install's Bluetooth question, `tapChangeKept`, `tapAsking`, `tapChangeDue`, `tapQuote`, `tapTerms`
- `awake`, which holds the screen lit while a screen is being looked at rather than touched
- `shakeStart`, `shakeStop`: whether a shake of the phone presses TAP, armed only on the receive screen (TAP-TO-PAY.md)
- a card that holds ecash, held to the phone: `cardBegin`, `cardSend`, `cardSay`, `cardAgain`, `cardEnd`
- a card's owner key, which never leaves native code: `cardOwnerKey` (its public half) and `cardOwnerSign` (a signature for one of five labels); and `cardTime`, the time a card is told, signed by the interim key

Haptics arrive as a separate `{haptic}` message with no action. The review-era
`open`, `vpn`, `path` and `torcheck` are gone. `open` handed https links to
Safari, which reaches them outside Tor. The page's own seed actions, `seedRead`,
`seedWrite` and `seedDelete`, and the Debug switch that once gated the native
ones are gone: asking for one is an unknown action in every build.

Each action is one function, named in a table
(`FoxyBridge.handlers`); an action not in it is refused with an error. The unit
tests (`sh tools/unit-tests.sh`) fail if the table and the list above differ.

**What each action needs before it acts.** Every message is refused unless it
came from the main frame of a `file:` page (`FoxyBridge.answers`), so the rows
below are what stands in front of an action *after* that. `tests/bridge-matrix.js`
holds this table to the code: a gate added or removed without a row fails it, and
so does a row claiming a gate the handler does not have. Read "—" as "nothing
beyond the frame gate and this action's own arguments", which is the honest
answer for a third of them.

| action | needs | what stands in front of it |
|---|---|---|
| `scan` | — | the full-screen camera sheet, from the presenter, with one of Foxy's own prompts. A person has to point it at something |
| `covered` | — | a nudge with nothing in it: the page saying it has the screen to itself (the launch intro, or CONNECTING TO TOR) so the native splash can come down without the bare home shell showing in between. Carries no data, answers nothing, and the splash lifts on its own timers anyway |
| `log` | — | the device log in Debug, where it reaches NSLog and a file. In Release it reaches `FieldLog` and nothing else: memory on the phone, for the ERRORS and LOGS screens, and a subset of the lines kept in a file for the next run |
| `fieldLog` | — | reads back what `FieldLog` holds, for the ERRORS and LOGS screens: the native lines and the page's own, redacted on the way in (tokens, invoices, payment requests, onion addresses, keys, long hex). Memory, apart from a subset of the lines (Tor, tap, screens, payment timing) that is also saved to `Library/Caches/foxy-lastrun.log` for the next run, excluded from backups and deleted when read back; nothing is sent anywhere, and it leaves the phone only if the person taps COPY |
| `fieldLogClear` | — | forgets all of it |
| `price` | route | refused with "Foxy is not connected to Tor." unless Tor is up, or the person chose to continue without it |
| `candles` | route | as `price` |
| `mintRequest` | route + mint url | https, or http only for a `.onion`; never localhost, an IP literal in any form, a single-label name or the `.local` family; a `.onion` needs Tor; the answer stops at 4 MB |
| `clipboard` | — | what it answers passes the seed-phrase filter first: a phrase reads as a clipboard with nothing on it |
| `copy` | expiry | a sensitive copy is device-only and expires after 120 s; an empty string copies nothing |
| `biometric` | reasons | one of three fixed reasons; the page cannot write its own |
| `seedStatus` | seed queue | reads whether a seed exists |
| `seedCreate` | one change + seed queue | the words are made in Swift; one seed change at a time, or "Another change to the seed is still waiting." |
| `seedMigrate` | one change + seed queue | only a BIP-39 phrase, only inside the one-time window, and never over a seed already saved |
| `countersImport` | seed queue | once per install |
| `counterReserve` | seed queue | the range is written before its secrets are answered |
| `counterReserveAt` | seed queue | refuses a range already issued, or a start more than 100 past the counter |
| `counterAdvance` | seed queue | up, never down, and no further than 100 or what a restore served |
| `counterSnapshot` | seed queue | reads; moves nothing |
| `restoreSecrets` | seed queue | the restore window: 1,000 past next for the saved seed, 0 to 20,000 for typed words |
| `p2pkReserve` | seed queue | the index is written before its public keys are answered; 0 (a peek) to 64 at a time, and only public halves come back |
| `p2pkPubkeys` | seed queue | public halves only, 1 to 300 at a time and no index past 20,000; moves nothing. This is the scan that finds which index a token in hand is locked to |
| `p2pkKey` | seed queue | one lock key's private half, and only within 1,000 of the last index reserved or inside a range this app session's scan served. The chain code is never answered, because a normal BIP-32 child and its parent's chain code give every other index |
| `seedShow` | screen queue + seed queue + presenter | one screen at a time, presented from the presenter, and not within 10 s of a cancelled read. The words are read behind Face ID or the passcode and never answered — only whether the quiz was finished |
| `seedEnter` | screen queue + presenter | refused before the screen opens when two candidates are already held |
| `seedAdopt` | one change + seed queue + seed alert | the Replace alert, then iOS asks for Face ID or the passcode, which a pasted lure cannot supply |
| `seedCandidateForget` | — | takes an id and forgets it |
| `seedWipe` | one change + seed alert + seed queue | the Delete alert, then Face ID or the passcode; the seed is checked gone before the counters move, and a new one is always made |
| `seedProtection` | seed queue | reads which of the two the person chose; asks them for nothing |
| `seedProtect` | seed queue | moves the seed between the two. Taking Face ID off reads the seed from behind it first, so iOS asks before the guard comes off; the seed is written and read back where it is going before the copy it came from is deleted |
| `orbotAccess` | — | opens Orbot's own permission flow |
| `orbotRefresh` | — | polls Orbot now rather than on its 15s timer; answers its state |
| `privacy` | — | reads the route's state |
| `captured` | — | reads whether the screen is recorded or mirrored |
| `torRetry` | — | asks Tor to try again |
| `unprotected` | tor alert | turning it on asks in an iOS alert, and is ignored while Tor is running; turning it off needs nothing |
| `isDebug` | — | answers whether this is a Debug build |
| `hostsKnown` | once | the first run only, never again once the marker is stored; the page's list is filtered and kept apart from the hosts the person allowed |
| `previewStart` | presenter | a finite rectangle inside the web view |
| `previewStop` | — | stops the preview |
| `pasteStart` | presenter + rect limits | wider than 30 and taller than 20, at most 90% of the width and half the height, inside the view and below its top third |
| `pasteStop` | — | removes the control |
| `notify` | kinds + throttle | two texts only, "Payment sent" and "Payment received", no amounts, one every 3 s at most |
| `share` | — | the iOS share sheet from the presenter, refused when something else is already up or the text is empty |
| `openSettings` | settings url | opens Foxy's own page in the Settings app (`UIApplication.openSettingsURLString`) and no other URL, for a Bluetooth or camera permission refused once, which iOS never asks about again |
| `openCompany` | company sites | opens one of four fixed web addresses in the phone's browser, picked by name (`cashapp`, `strike`, `river`, `flash`); the page never supplies a URL. The browser is outside Foxy and outside Tor, so that company sees the phone's own address |
| `inboxOpen` | onion inbox | an onion address with a key Tor makes and discards (`NEW:ED25519-V3`, `DiscardPK`), forwarding to a listener on 127.0.0.1 only; refused unless Tor is up. It accepts one thing: a POST to a path of 128 random bits, with a Content-Length of at most 256 kB, no chunked body, four connections at a time and 30 s to send |
| `inboxClose` | — | ends the address (`DEL_ONION`) and the listener |
| `inboxAnswer` | answer limits | answers a payment that arrived: status 200, 409 or 422 only, and 300 characters of text, to a payment still waiting |
| `nostrSend` | nostr only | a payment wrapped for the receiver's key (NIP-17/59, signed by keys made for that payment and forgotten) and published to at most five `wss` relays their request names, each over Tor on its own circuit; never the open connection. Foxy also *listens* on relays while a payment request is on screen — see `inboxOpen` |
| `onionPost` | onion only | only `http://` to a version 3 `.onion` host, with no user, query or fragment, through Tor's SOCKS port and never the open connection; a body of at most 256 kB, an answer cut off at 64 kB |
| `tapReceiveStart` | offer only | a BOLT11 invoice, a Cashu payment request, or both, at most 4096 characters in all, advertised over Bluetooth by service UUID alone, with no name, code or amount; sent to any phone that connects, which learns no more than the QR code shows (TAP-TO-PAY.md) |
| `tapReceiveStop` | — | stops advertising and removes the service |
| `tapPayStart` | tap payer | connects only to a Foxy whose signal is strong enough to mean the two phones are touching (the `nearDbm` cut-off in `TapProtocol.swift`, -33 dBm), accepts only a BOLT11 invoice, and answers it with the four-digit code both phones show; the page pays nothing until the person has seen that code and tapped SEND |
| `tapPayStop` | — | stops searching or connecting |
| `bluetoothAsk` | — | puts iOS's Bluetooth question on screen by making a central manager and answers allowed, denied, off, unsupported or unknown, and the screen moves on whichever it is (iOS asks once per install); scans for nothing, advertises nothing, and lets the manager go once answered. Asked by the first-install screen after the warning (`foxy-tor-gate.js`) |
| `tapSend` | one link | the payment, written to the receiver over the link this tap already holds, at most 64 KB; refused when that link is gone, and the page then falls back to the request's own transport. The proofs are bearer money either way — anyone in range who could take them off this link could take them off the QR code the screen showed a moment earlier |
| `tapChange` | one link | change back to the payer over the link the payment came in on, when they paid more than they were asked for because no route meant no swap and their pieces could not make the amount exactly. A token, so it goes in its own action rather than through `inboxAnswer`, which is shared with the onion path and clamps to a status and 300 characters. Sealed to the session and padded to one flat size, unlike a payment: a change token's length tracks the number of pieces and so roughly the amount, and a bucketed size would say on a link chosen because it says nothing. Refused when the link has gone, so the page learns rather than believing change went out. |
| `tapChangeKept` | one link | the payer's page saying it has written the change down, which becomes M8. The receiver holds the link open until it comes and will not be retired by NEXT PAYER meanwhile: change is money leaving, and bytes arriving says nothing about money kept — the same reason M6 is the page's word and not the radio's. A refusal is sent too, because the other phone is waiting and "we could not keep it" is something it can act on where silence is only a timeout. |
| `tapAsking` | one link | the receiver's page saying a person is being asked about the payment, which becomes M9. Sent only when both phones are offline: unlocked ecash cannot be settled without a route, so the page puts the question to the person holding the phone, who takes longer than a swap. It carries nothing — not the amount, not the reason, nothing about who is being asked — and decides nothing; M6 is still the answer. What it buys is the payer's clock and the payer's screen: twenty seconds of silence in the middle of handing money over reads as a broken app. The payer honours one and ignores the rest, so it cannot be used to hold a link open. |
| `tapChangeDue` | one link | the receiver's page saying this payment owes change back, told the moment the amount is read rather than when the change exists. It sends nothing and decides nothing: it only stops the link being retired while the swap that makes the change is still at the mint. The link's own teardown is two seconds and the mint took three and a half, so the guard that protects the link was being set after the link had gone — the change was made and had nowhere to deliver. Resolved rather than refused with no live receiver: the page must not be made to care about the radio. |
| `tapQuote` | one link | the payer's page quoting its bitcoin price and the sats it makes of a dollar amount, which becomes M10. A receiver with no route has a price that may be hours old, so it asks in dollars and leaves the conversion to the phone that has a current one. Nothing moves on this: it is a number for a person to agree to, and until they do the payer still holds its sats. The receiver does not have to trust the figure — it is shown the sats and told how the payer's price compares with the last one it saw itself, and that comparison is its own arithmetic. The same message also carries the question asked before a payment (`intend`) and the payer's word that it paid the receiver's invoice over Lightning (`paid`, the last sixteen characters of that invoice): neither moves money, and the receiver asks its mint rather than believing the second. |
| `tapTerms` | one link | the receiver's page agreeing that price and sending the request, now in sats, which becomes M11. It carries a payment request exactly as the offer does and is padded the same way. This is the message that ends the price leg; the payment that follows is the ordinary one. |
| `shakeStart` | shake flag | sets a flag: while it is set, a shake the system recognises (the shake-to-undo gesture, heard by the host controller) is told to the page as a `shake` stage, and the page presses TAP itself, subject to every rule the button has. No sensor of Foxy's own, nothing over the air; cleared when the page goes |
| `shakeStop` | — | clears it |
| `awake` | screen only | holds the screen lit (receive, tap and gate screens); dropped when Foxy leaves the foreground |
| `cardBegin` | card session | opens the phone's NFC sheet with one line of the page's text on it (one line, printable, 120 characters). One session at a time: a session left open is closed first. Answers when a card is there, or why not; iOS ends it after a minute, when the sheet is dismissed, and when Foxy leaves the foreground |
| `cardSend` | card session + card commands | one command to the card and its answer back, as hex. Carried only if it is the command that chooses Foxy's own applet by its whole name, or one of that applet's nineteen instructions after the applet has answered that it was chosen; anything else is refused with nothing sent, so a page that had been got at cannot talk to a bank card or a passport held to the phone. Nothing sent or answered is kept or logged: one of the commands is the card's PIN |
| `cardSay` | card session | changes the one line of text on the sheet, under the same limits |
| `cardAgain` | card session | the card left part way through: the open sheet looks for a card again, with one line of the page's text on it, under the same limits. Answers when a card is there, or why not. The applet must be chosen again before any of its instructions is carried |
| `cardEnd` | card session | closes the sheet, with a word or with a reason; also how the page takes down a sheet still waiting for a card |
| `cardOwnerKey` | seed queue | the owner PUBLIC key for one card, as 130 lowercase hex characters (`04`, X, Y of a P-256 key). The private half is derived from the seed and the card's public key, which the page gives as 66 hex characters starting 02 or 03; anything else is "bad request" before the seed is read. The page gives the answer to the card at set-up. No counter moves, and the same twelve words derive the same key on a new phone, so that phone is the owner of the same cards. Only the public half is ever answered |
| `cardOwnerSign` | seed queue | an ECDSA signature (P-256, SHA-256, DER, lowercase hex) by that owner key, and nothing else, over `FoxyCard/` and a label, a 16-byte nonce and a value. Only five labels are signed: `change-pin`, `set-limit`, `set-owner`, `set-card` and `load`, each with the shape of value its card command takes (a PIN of 4 to 8 digits; a 4-byte limit; a 65-byte key beginning 04; a card record of 100 + L bytes, L from 1 to 80; nothing at all). Anything else is "bad request" before the seed is read: a lock (`lock`) and a time (`time`) cannot be asked for, and no label is the start of another. A page that had been got at can ask for any of the five for any card whose key it knows. A nonce comes only from a card held to the phone, and a signature is good for that nonce, in that tap, and no other, so it needs the card held to the phone; with that, it can do what the card's owner can, with no PIN, which includes setting the PIN, lifting the limit and so spending what is on the card. The owner key and the seed are never in an answer |
| `cardTime` | — | `{"time", "sig"}`: the phone's clock in whole seconds since 1970 (it must fit four bytes), and a signature over `FoxyCard/time` and the time by the INTERIM time key, which the card verifies against the time key in its record. It needs no seed, no card and no argument, and answers nothing secret. It is INTERIM: the private half of that key is built into the app, so anyone can extract it, and this is as weak as trusting the receiving phone's own clock. It bounds an honest receiver and the holder's own overspending, and not a terminal built to cheat, which can sign its own time. No server exists yet; a real signer replaces it by provisioning, not by a new applet. No screen says that the daily limit stops an attacker |

Two things the table does not check, and does not pretend to: each action's own
argument checks (`FoxyTests/NativeSeedTests.swift` and `CounterRangeCheckTests`
cover those), and Face ID or the passcode, which `SeedVault` enforces on the read
itself rather than at the bridge.

What bounds the bridge:

- **The words never cross the bridge, in any build** (`SEED-HANDLING.md`). No
  action answers them, and only `seedMigrate` takes them
  from the page:
  - **Native makes, shows and takes the words.** A new seed's words are made
    in Swift (`seedCreate`: 128 bits from `SecRandomCopyBytes`, the bundled
    wordlist used only if its SHA-256 is the pinned one). They are shown on
    Foxy's own screen (`seedShow`, with the verify quiz; it answers only
    whether the quiz was finished), and typed on its own screen (`seedEnter`),
    which holds them under a random 128-bit id, two at most, until adopted,
    forgotten, or the unlock, the page or the foreground goes. The seed screens
    hide the words while the screen is recorded or shared, and close when Foxy
    goes to the background, so none is left over the PIN lock.
  - **`seedMigrate` never replaces a seed.** It is the one-time move for an
    install whose page still holds words from before the keychain. It takes
    only a BIP-39 phrase and writes it only where no seed is saved. Otherwise
    it answers `same` or `different`, changing nothing and asking nothing, and
    it never answers words. It writes only inside a one-time window
    (`SeedMigrationWindow`): an install that had page storage before this
    launch, until its first answer or until a seed is made or found saved.
    Closed, it still compares with a saved seed, and
    only with no seed saved does it answer "no migration here", so a script in
    a fresh install's page cannot plant words it knows before the wallet makes
    its own.
  - **Replacing or deleting the seed** (`seedAdopt`, `seedWipe`) asks the iOS
    alerts "Replace this wallet's seed?" and "Delete this wallet's seed?", one
    seed change at a time, and sets the counters aside once the keychain has
    changed. The Replace alert warns that whoever gave the words can take
    everything the wallet receives, and after its yes iOS asks for Face ID or
    the device passcode, which a pasted lure cannot
    supply. Deleting asks the same after its yes.
    A wipe checks the seed is gone before it moves the counters, and
    always makes a new seed: the page's `seedDelete`, which left none, let a
    script delete the seed and then write words of its own.
  - **Native owns the NUT-13 counters** (`foxy-counters.json`, `STORAGE.md`).
    Secrets are derived in Swift (`Foxy/Keychain/NUT13.swift`, libsecp256k1
    from its signed tag) only for a range reserved and written first
    (`counterReserve`, or `counterReserveAt`, which refuses a range already
    issued or starting more than 100 past the counter), or for a restore
    (`restoreSecrets`): for the saved seed, ranges ending at most 1,000 past the
    keyset's next counter, and for typed words, contiguously from 0 up to
    20,000 counters per keyset; adopting them raises the counters to 1,000 short
    of the furthest range served, the end of a scan's last batch with a
    signature. A script that walked the typed words far past the scan during a
    restore can push the counters past a gap no restore crosses.
    A `00` keyset's counter is kept by its derivation index, so a second id
    that derives the same path reaches the same counter and window.
    `counterAdvance` moves a counter at most 100, or to what a
    restore served; `countersImport` answers once per install; the file holds
    256 keysets. An early `seedSecrets` action, which answered any counter, is
    gone. The BIP-39 seed is kept in native memory until the unlock is
    forgotten, the page goes, Foxy goes to the background, or the saved seed is
    written or deleted. Put away, it serves the top-up that runs then and is
    dropped when that is over, twenty seconds at most; a return ends it at
    once (`SEED-HANDLING.md`, `SeedVault.putAway`).
  - **What it does not stop:** a script in the page can still reserve
    counters and receive their secrets, which is enough to spend outputs made
    from them, and can open the seed screens, whose read of the words needs
    Face ID or the passcode, and it can still draw a look-alike of a seed
    screen or ask the person to type words it supplies; what it cannot draw is
    the iOS sheet with the page pushed back behind it and the material lock bar.
    `seedMigrate` writes only in its one-time window on an install that had page
    storage before this launch. `same` or `different` tells it only whether a phrase it already has
    is the saved seed. It cannot read the words, replace a saved seed without
    the person's yes and passcode, lower a counter, push one out of a restore's
    reach, or collect secrets for counters far ahead of the wallet's. What
    remains, by design: the secrets of the next 1,000 counters of each keyset,
    the restore window a restore of these words looks across, and so enough to
    take what the next 1,000 outputs of a keyset receive if a script keeps them.
    A stronger design would serve a restore's secrets only for outputs the mint
    has signed.

- **It answers only the staged page's main frame**, with a `file` security
  origin. A subframe, or any other origin, gets nothing.
- **Native questions come one at a time.** Allowing a host, replacing or
  deleting the seed, and continuing without Tor wait in one queue of iOS
  alerts, so none is drawn over another; one gone without an answer is a no. A
  second seed change (a create, migrate, adopt or wipe) while one is waiting is
  refused. A replace waiting on its alert gives up after two minutes, as a no,
  and takes the alert down.
- **Navigation is locked** to `.html` file URLs under `Library/Caches/web/`.
- **Notifications**: the page names a kind, `sent` or `received`, and the
  words are Foxy's: "Payment sent" or "Payment received", titled "Foxy". Any
  other request is refused, so a script cannot write its own banner, and no
  amount reaches the lock screen. With previews hidden iOS shows only "Foxy".
  At most one every three seconds.
- **The system paste control** is placed only in a rectangle that is inside
  the web view, no more than 90% of its width and 50% of its height, and in
  its lower two-thirds. That keeps it from being parked over a confirm button.
  It is drawn at 2% opacity over the page's own paste button, so the designed
  button shows and Apple's control takes the tap. A visible system button was
  tried after the review and taken out; the rectangle checks are what stop it
  being moved elsewhere.
  A tap the control takes and does nothing with
  reads the pasteboard directly after 1.5 s, text only and never a seed
  phrase, and only while Foxy is still the active app, so an "Allow Paste"
  alert that is up is left to answer.
- **Sensitive copies** (tokens and the like) go to the pasteboard device-only,
  with a 120-second expiry.
- **`mintRequest`** accepts only `https`, or `http` to an `.onion` host, and
  refuses IP literals and local names. Redirects meet the same rules and never
  go to another host. Only `GET` and `POST` are sent. Every native request
  stops reading an answer at 4 MB, as it arrives, and one whose declared
  length is larger is refused before its body.
- **Two things listen, and only while a payment request is on screen** *and
  Foxy is in the foreground*. The onion inbox is one. The other is
  `Foxy/Nostr/NostrInbox.swift`, opened by the same `inboxOpen` action: up to
  four `wss` connections to public relays, each over Tor, subscribed to
  messages for a key made for that one request. A relay therefore learns that
  somebody is waiting for a payment, and the times it holds the socket open,
  though not who or how much. This document once said Foxy listened on no relay,
  and `tests/bridge-matrix.js` did not catch it because it
  reads only each handler's own body and the relay half is a function further
  in. The onion inbox is opened
  at the keypad, closed a moment after the screen goes (`syncInbox`), and ended
  outright when the app leaves the foreground (`closeInboxForBackground`, beside
  Tor leaving the network). It used to survive a background, so an address
  whose listener iOS had taken away could stay published with a request naming
  it still on screen — a dud QR rather than a leak, but the address is meant to
  last as long as the screen and no longer. The page forgets its side on the
  way back (`inboxWake`) and opens a fresh one. Everything about it is written
  to survive someone who knows it is there.
  - It binds to `127.0.0.1`, which is what keeps it off the network; Tor
    forwards the hidden service to that port. `acceptLocalOnly` is *not* that
    — it means the local link, and with it set the listener refused loopback
    connections without ever saying so (found with two simulators).
  - Any app on the phone can reach a loopback port, so the request's path
    carries 128 random bits and the path is checked **before** the method: a
    caller without it is answered 404 and learns nothing else about what is
    listening.
  - What is read is bounded before it is believed: at most 4 connections at
    once, an 8 kB head, a `Content-Length` of at most 256 kB refused *before*
    its body arrives, no chunked bodies and no other method than `POST`, a
    payer that stalls loses its slot after 30 seconds, and a page that has not
    answered in 100 seconds answers 504 for it.
  - What arrives is a claim, not an instruction. It must name a request open on
    this phone right now, at the mint that request named *and* the mint this
    wallet is connected to, in sats, with at most 500 proofs, each of a shape
    Foxy can read, totalling at least what was asked; its memo is cut to 200
    characters. Nothing in it chooses a mint, a URL or a destination. The
    proofs are then redeemed at the mint over Tor, and the mint is what decides
    whether they were real.
  - The answer says only whether the redemption worked: one of three statuses
    and 300 characters (`inboxAnswer`).
- **A host Foxy has not used needs an Allow** in an iOS alert before the first
  request to it (`HostApprovals`). Otherwise any script that ran in
  the page could send what the page holds (its proofs and, before the seed left
  the page, the seed) to an address of its own over Tor, silently. Approved
  without asking: the five mints Foxy lists by default (two of them test mints),
  any host under one of those or under a host the person allowed (a
  lightning address's callback on its own subdomain), and the mints and contact
  domains a wallet already had the first time a version with approvals ran,
  carried over once. A carried host approves only itself: the list comes
  from the page, and a carried `co.uk` used to approve every name under it.
  Hosts carried by an earlier version were stored with the allowed ones and still
  cover their subdomains. Approvals are kept in the
  keychain, this device only, not UserDefaults, which goes into backups and
  would list the mints and payment domains the person uses. Smoke check 25.
  This stops a script; it does not stop native code already inside the process.
- **`unprotected`** can be turned on only by a tap on an iOS alert (§4).

There is no server. There is no account. There is no backend that belongs to
the author.

---

## 2. Assets — what an attacker would want

Storage keys were renamed from `flash.*` to `foxy.*` by a one-time schema
step in `foxy-wallet.js` (`SCHEMA_STEPS`).

**The seed.** Twelve BIP39 words, 128 bits of entropy from
`SecRandomCopyBytes`, made in Swift on the device. It is kept in the iOS
keychain, this device only. With Face ID on it is `foxy.seed.v2` and every read
needs Face ID or the passcode; a new install starts with Face ID off, in
`foxy.seed.v1`, which only the phone's own lock protects, until the person turns
it on (§7). The page never holds it: native keeps only the BIP-39 seed made from
the words,
in its own memory, while the wallet needs secrets (§1). It is created at first
launch, before any proof exists. Everything else is derived from it. Whoever has
it has the wallet.

**The proofs.** `foxy.cashu.proofs.<mint-url>`, in the web view's storage. In
Cashu these *are* the money — bearer tokens, not a claim on an account.
Copying them is stealing them; losing them is losing the balance, and the seed
alone does not always recover them (see §6).

**The transaction log.** `foxy.cashu.log`, plus `foxy.txmeta` for notes.
Amounts, timestamps, mints, and free-text notes the user wrote about what a
payment was for. Not money, but a complete picture of the user's financial
activity.

**Network position.** Which mint the user talks to, when, and from what IP.
The mint learns the Tor exit by definition. The question is who learns more.

**Contacts.** `foxy.contacts` — names and Lightning addresses the user has
saved.

**The Orbot access key.** `foxy.orbot.token`, in the keychain. It is a
credential Orbot issues so Foxy's Tor can use Orbot's bypass port.

**Tor's state.** `Application Support/tor`. It holds the entry guards Tor keeps
for months on purpose. Losing them makes Tor choose again, and every new choice
is another chance of picking a hostile guard.

---

## 3. Adversaries

### Who is this for, and who is it defending against?

**Answered, in this order.** The review's own reading of the evidence, adopted
here:

1. **The person holding the unlocked phone, or a backup of it.** The most
   serious finding lived here: the seed and the proofs rode along in every
   iCloud and iTunes backup with nothing excluding them. Fixed. The web store
   is marked do-not-back-up with file protection, the seed has since moved to a
   this-device-only keychain item, and a PIN now gates the app (§7). This is
   still the adversary with the shortest path to the money, because the PIN
   encrypts nothing.
2. **A malicious server**, whether a mint URL or a lightning-address host.
   Two live findings sat here and each needed only a scan or a payment: an
   address server could name its own price, and a scanned QR could point the
   wallet at a cleartext mint. Both closed. A mint that signs one wallet's
   proofs with its own keys, to recognise that wallet's ecash later, is now
   caught by the DLEQ check (§5).
3. **A network observer.** Third, once the gate's three fail-open paths were
   closed and the captures confirmed nothing reached a mint while the gate was
   blocking. That gate is superseded. The answer to this adversary is now Tor
   inside the app (§4).

The mint is assumed *untrusted for privacy* and *trusted for custody* (§5).

### The original framing, kept for the record

The design so far implies a user in a jurisdiction where holding or moving
bitcoin attracts attention — the Tor gate is not a convenience feature. But the
review needs this stated, because it changes which of the following matter:

- **A network observer** — ISP, national-level filtering, someone on the same
  Wi-Fi. Wants to know that the user runs a bitcoin wallet, and to whom they
  pay.
- **The mint** — an honest-but-curious operator correlating amounts, timing and
  IPs across users. Foxy assumes the mint is *untrusted for privacy* and
  *trusted for custody* (see §5).
- **Someone holding the unlocked phone** — a thief, a border officer, a family
  member. No PIN, no biometric, no wipe. See §7. *(Written before the PIN.)*
- **A malicious mint URL** — a user scans or types a hostile address.
- **A hostile ecash token** — a crafted token pasted into the wallet.
- **Apple, or anyone with the device backup** — iCloud backups, forensic
  extraction. See §7.

These are now ranked above.

---

## 4. The network — Tor inside the app

### What it is now

**Tor runs in Foxy's process** and starts at launch. Before Tor starts, Foxy
asks Orbot's local API once, which takes well under a second. That way Tor's
first connection already goes the right way when Orbot is running.

**One decision for every request.** `Route.start` in `Network/Route.swift`
sends each request one of three ways:

- on a Tor SOCKS session made for that request, when Tor is ready
- on an ephemeral session with no cookies and no cache, only if the person
  chose to continue without Tor
- nowhere, when neither is true

When there is no route, `Route.start` returns nil and the call is refused
before a socket opens, with "Foxy is not connected to Tor." The `price`,
`candles` and `mintRequest` actions check `Route.available`, which asks the
same question without making a session, and send through `Route.start`. `mintRequest` carries every cashu-ts call and the
lightning-address lookups. The page checks the same state first
(`assertRoute`) so it can say something friendlier, but the native check is
the one that holds.

**Ready means three things.** A circuit. Enough directory information to build
the next one, because with per-destination isolation every new destination
needs a new circuit. And Tor's SOCKS port, read back from Tor itself. Losing
any of the three closes the route until it returns. After Tor has been up once
in a session, a drop shows no screen: requests are refused until it
reconnects, and the place a request was refused says so.

**The SOCKS port.** The setting is `SocksPort auto IsolateDestAddr`. Tor picks
a port on 127.0.0.1, and Foxy reads it over the control link. Foxy forgets the
port before anything that makes Tor close and reopen its listener: a transport
switch, a change to Orbot's bypass, a retry. It reads the port again
afterwards. It used to be a fixed 9050, which any app on the phone could have
taken in the gap. While the port is unknown the session points at port 9,
where nothing listens. `IsolateDestAddr` gives each destination its own
circuit, so the mint, a price feed and a lightning-address server do not share
an exit that could link them.

**One circuit per job at a mint.** Isolating by destination still
put every request to one mint on one circuit for up to ten minutes: a launch's
checks, a payment and a receive arrived from one exit, as one person. Each mint
request now logs in to the SOCKS port with a label (`MintCircuit`,
`ProxyConfiguration.applyCredential`), and Tor keeps different logins on
different circuits (`IsolateSOCKSAuth`, on by default). The page labels a job:
one payment's quote, swap and melt; one invoice's polls and claim; one sent
token's checks; each held melt, swap record and invoice in a sweep. A request
with no label gets a circuit of its own. Tested locally: the credential
reaches a SOCKS server as a username/password login, and a new URLSession
resumes no TLS session from another, so connections share nothing but timing.
What a mint can still link, and why, is in MINT-PRIVACY.md.

**Failing closed.** The session uses a SOCKSv5 `ProxyConfiguration` with
`allowFailover = false`, so a request that cannot reach Tor fails. That API
exists from iOS 17, and Foxy requires iOS 17: the iOS 16
fallback to `connectionProxyDictionary`, which Apple does not promise will fail
closed, is gone. Smoke check 17 fails the build if the minimum drops or that
dictionary comes back. The cost: iPhone 8, 8 Plus and X, which cannot run
iOS 17, cannot install Foxy.

**Control port and data.** The control port is TCP on 127.0.0.1, chosen by Tor
(the Unix socket path limit ruled out a socket), with cookie authentication.
The cookie lives in the app's container, and last launch's port and cookie
files are removed before starting. Tor's data directory is
`Application Support/tor`: mode 0700, excluded from backups (a restored backup
would carry another device's guards), and moved out of Caches if found there.

**Logs.** In release builds:

- Tor logs errors only (`Log err stderr`).
- Native `print` is a no-op for the whole bridge module.
- The page's `console.log`, `warn`, `info` and `debug` are replaced with no-ops
  before any script runs. `console.error` survives.

**Transports.** Direct, then obfs4, then Snowflake, tried automatically. Direct
gets three goes of five seconds each (twenty seconds on a first set-up, which
has the relay list to load), because a direct connection that is stuck on a
guard that will not answer is cured by starting again, as a relaunch does.
obfs4 gets 60 seconds and Snowflake 90. A transport still making progress
gets extensions, and one with a circuit that is fetching directory
information is given longer again. A bridge that worked is tried first for a
day, then direct is tried again.

obfs4 comes before Snowflake for privacy: an obfs4 bridge
is one party that sees the phone's IP address, as a guard is. Snowflake shows
it to a broker reached through a CDN, to STUN servers and to a volunteer
proxy, all outside Tor. Before, one Snowflake fallback on a bad network made
Snowflake the first choice on every later launch, anywhere.

**Closed after the IP review.** Each is guarded by smoke check 17b.
- WebRTC is removed from every frame before the page's own script runs. Its
  STUN traffic is UDP that neither the content rule list nor the page policy
  sees, so script in the page could otherwise learn the phone's IP address.
- No link previews, long-press callout or text-selection menu outside text
  fields: Look Up, Translate and Search Web hand text to system services.
- Tor refuses a request that arrives as a bare IP address (`SafeSocks 1`), so
  a hostname resolved on the phone would fail rather than go quietly; and
  refuses internal addresses explicitly.
- Requests carry Tor Browser's desktop `User-Agent` and `Accept-Language`,
  not "Foxy/1 CFNetwork/… Darwin/…", and the page cannot set other headers.
- Mint, LNURL and lightning-address requests refuse IP literals, localhost,
  single-label and local-network names, and `.onion` when Tor is not up.
- A mint URL must be `https`, or `http` to an `.onion` host. Any other scheme
  is refused; it used to be accepted whenever the host ended in `.onion`.
- Redirects meet the same rules. Every session Foxy makes (Tor's and the open
  one) carries `Route.redirectGuard`, which cancels a redirect to a URL that
  fails those checks or that names a different host. Unprotected, a hostile
  mint could otherwise have redirected the phone to an address on its own
  network, which App Transport Security does not cover. Smoke check 17d fails
  if a session is made without it.
- Tor's SOCKS port is forgotten on return to the app until Tor names it again.
  Each request, every price source included, still takes a fresh Tor session
  with the port as it is then, and that session is invalidated as soon as its
  task has started (`Route.startOnce`). Before, none was ever invalidated, and
  each stayed with its delegate and connection pool for as long as the app ran.
  Smoke check 17e.
- The share sheet is handed a `ShareText` that supplies its own link metadata
  (a title, no URL) and plain text. Given a bare string, the share sheet could
  find a link in it and fetch a preview from its own process, outside Tor. Once
  the person sends the text, the receiving app may preview a link in it; that is
  outside Foxy. Smoke check 17f.

**Not yet verified:** that iOS hands hostnames to Tor rather than resolving
them first. SafeSocks makes a failure visible; a packet capture of this build
on a phone (NETWORK-TEST.md) is what would show it.

Coming back from the background through a bridge, the confirming check does
not ask for a recovery while Tor is up on a circuit it built in the last 45
seconds. It keeps probing, with the mint given 25 seconds and the price 30.
Through obfs4, a first circuit to each destination took 3 to 24 seconds, and the
earlier 12-second limit tore down circuits that were seconds from working. On a
bridge the price asks two sources at a time, so two price servers see a request
where one did before; each still gets its own circuit. The built-in bridge lines
were refreshed from Moat, unchanged. From the test network only the
two iat-mode=1 bridges connected reliably; they stay in the list because other
networks differ.

The pluggable transports come from IPtProxy, built from pinned sources by
`tools/build-iptproxy.sh`. Two builds were byte-identical,
checksums are committed in `Vendor/IPtProxy.sha256`, and smoke check 15 fails
on a mismatch. The bridge lines are the Tor Project's built-in ones, as shipped
by IPtProxyUI. **Snowflake's broker contact, through a CDN, and its STUN
servers go outside Tor by design.** They learn this phone is starting
Snowflake. They never see a mint, an amount or a payment.

**The page has no network of its own.** Five layers keep it that way:

- **A content rule list.** A `WKContentRuleList` blocks `http`, `https`, `ws`,
  `wss` and `ftp`. It is installed on the web view before the page is loaded,
  and if it cannot be compiled Foxy shows an error instead of loading. A policy
  inside the page can be undone by the page; this cannot.
- **A dead-end proxy.** The web view's data store has one
  SOCKS proxy, `127.0.0.1:9`, where nothing listens, with no failover
  (`Foxy/FoxyWebView.swift`). A connection WebKit opens outside the rule list,
  such as a preconnect, goes there and fails. On the simulator, the
  page's preconnect, prefetch or image reached example.com directly without the
  proxy, and went to the proxy with it (`NETWORK-TEST.md`). **Local-network
  addresses are not sent through the proxy**, so a script in the page could still
  open a connection to a device on the same network. It cannot learn the
  phone's public address that way.
- **The Content-Security-Policy.**
  - `connect-src 'self' file: blob: data:`
  - `script-src 'self' file: blob:` plus the SHA-256 of the one inline loader
    script, with no `'unsafe-inline'` and no `'unsafe-eval'`
  - `object-src`, `base-uri`, `frame-src` and `form-action` set to `'none'`
- **No eval.** The app's class comes from a factory the loader delivers as a
  blob script; the renderer calls it and never compiles text (the design
  runtime's `evalDcLogic` once used `new Function`). `tools/pack-index.py`
  recomputes the loader hash on every pack, and smoke check 16 fails if the
  policy allows inline or eval script, if the hash does not match the loader,
  or if `evalDcLogic` compiles text.
- **Foxy's own renderer.** The page is rendered by
  `build/foxy-render.js`, about 500 lines in this repo, not by a generated
  design-tool runtime with no source. It evaluates only names and dotted paths
  in the template, and refuses any other template feature when the page starts.
  `tests/render-parity.js` shows all 33 views (the screens and popups the app
  names) render the same DOM as under the old runtime; `tools/verify-vendor.py` checks the packed copy is
  the file.

`style-src` still allows `'unsafe-inline'`, for the template's inline styles.

**The screens.** `foxy-tor-gate.js` shows these, as the native side reports
Tor's state:

- **SECURING YOUR CONNECTION**, with a percentage, at launch and on every
  return; RESTART TOR appears when Tor is stuck
- **NO CONNECTION**, when the phone has no network at all
- **CANNOT CONNECT TO TOR**, with RETRY and CONTINUE UNPROTECTED
- **TOR STOPPED**, when Tor's thread has exited and only reopening Foxy can
  start it
- **ORBOT DETECTED**, with ALLOW FOXY IN ORBOT, and **VPN DETECTED** for any
  other tunnel

They decide nothing; the native side does.

**Continuing without Tor.** CONTINUE UNPROTECTED asks the native side, which
presents a `UIAlertController`. Only a tap on "Continue without Tor" there sets
`Route.unprotected`. A script in the page can ask but cannot tap an alert iOS
draws. That replaces the two taps on a page button, which any script could
have simulated.

The choice is not stored, so it is asked again each launch. It is ignored
while Tor is up, and cleared the moment Tor connects, so the app moves onto
Tor as soon as it can. While it lasts, a row across the app reads *IP ADDRESS
EXPOSED*, and the mint, the price feeds and anyone paid see the phone's
address. The alert says those requests go through Orbot's tunnel only when
Foxy holds Orbot's key and Orbot answered it with a bypass port. Anything that
answers 403 on Orbot's port while a VPN is up used to change that wording; now
the alert says the mint and anyone paid will see the phone's address.

**Orbot.** Orbot is a VPN that sends the whole phone through its own Tor, and
Foxy's Tor cannot run inside it. Foxy asks Orbot's local API
(`GET /info` on `127.0.0.1:15182`, raw TCP on loopback) at start, every 15
seconds in the foreground, and on return.

- **Getting a key.** ALLOW FOXY IN ORBOT opens
  `orbot:request/token?…need-bypass=true` (no `//`). Orbot issues a key and copies it
  to the clipboard. Foxy picks it up on its next return to the foreground, only
  after having asked, only if it is shaped like a UUID. It clears the clipboard
  and stores the key in the keychain.
- **Using it.** With the key, Foxy's direct Tor reaches its relays through
  Orbot's bypass SOCKS port (`Socks5Proxy`). A bridge transport reaches its
  bridge through the same port. Requests still go only to Foxy's Tor. If Orbot
  stops, Tor loses its relays and requests are refused until it reconnects
  directly.
- **Trust.** Foxy believes Orbot only while a VPN interface is up (`utun`,
  `ipsec`, `ppp`, `tun` or `tap` in the system's scoped proxy settings). It
  believes a bypass port only when the request carried a key. Anything else
  answering on that port is treated as no Orbot.

These checks rule out an ordinary app listening on 15182. They do not rule out
a VPN app the person installed that imitates Orbot's API. That app could carry
Tor's connections to relays, which are Tor-encrypted; it would not see mint
requests in the clear. This is reasoned from the code, not tested.

Once a key is stored, the key check is weaker than it reads. Foxy sends the
key with each request, so whatever answers learns it. While Orbot itself is
stopped, another app holding 15182 could, with any VPN up, name its own bypass
port. Orbot's API offers no challenge to check a reply against, and iOS does
not say which app owns a port or a VPN. Such an app would carry Tor's
encrypted relay connections, not mint requests.

**Tested so far:** the Orbot path in the simulator, against a fake Orbot. **Not
yet tested with real Orbot on a phone.**

### Back from the background

iOS suspends Foxy when it leaves the screen, and closes a suspended app's
sockets. After a few minutes away every request used to fail until the app was
killed.

**Off the network while away.** Once Foxy has been in the background for as
long as iOS allows less six seconds (`Route.holding`, about twenty-four in
all), the native side switches Tor's network off (`TorService.backgrounded`),
under a background task so Tor answers before iOS suspends the app. Tor then
has nothing open for the suspension to break. Until then only the connection
is kept: the door is shut and the seed dropped as the work of being put away
ends, so nothing new is sent while Foxy is away, and somebody back within
that time finds the circuit they left. Before this, Tor woke with broken sockets and began
connecting to its guards again, and the reconnect Foxy then ran switched its
network off mid-attempt. Tor counts a guard connection that closes before it
opens as that guard failing, and tries a failed primary guard again only after
ten minutes, so a return waited on guards Tor trusted less and sat at 44% while
a fresh launch, which remembers no such failures, connected in seconds.

**The home screen does not wait for Tor.** A wallet that has connected once
opens on the home screen and works offline until Tor is up (`homeFirst`,
`Web/foxy-tor-gate.js`); the connection screen shows only on a first launch or
when the banner is tapped. This changes what is seen and nothing about what is
sent: `Route.start` refuses every request without Tor exactly as before, and
working offline is the page saying so, not a way round it. What it does change
is how often a phone is offline for a few seconds with a network in the room,
so the steps that move money wait for a route that is on its way
(`routeSoon`), and the paths an offline phone takes are held to the same rules
as the others: `tests/two-doors.js`, `tests/scan-twice.js`.

**Set up again on every return after that.** Nothing is tried on a connection
that was taken off the network. Every such return sets up a private connection the way launch does
(`TorService.setUp`). Tor can't be started twice in one process, so the steps
run on the daemon that is already running:

- Tor is marked not ready, its SOCKS port forgotten and `everUp` cleared, so
  requests are refused and the page shows its launch screens.
- Tor's network is switched off, if it is not off already.
- A bridge transport (obfs4 or Snowflake) is stopped and started fresh.
- Its settings are applied, then the network is switched back on and the
  listener read again.
- The transport's deadline and fallback run as at launch.
- Tor is ready on its own `CIRCUIT_ESTABLISHED`, as at launch. With its network
  off Tor forgot it had a circuit, so the next one it announces was built after
  the network came back, and Tor never announces a one-hop directory tunnel.
  Tor is asked for a circuit (`EXTENDCIRCUIT 0`) every five seconds until then,
  in case it predicts no need for one after a long idle.

The page shows what launch shows: CONNECTING TO TOR with "Setting up a private
connection", then "Loading your balance", and the home screen once the balance
has loaded. If Tor cannot connect, CANNOT CONNECT TO TOR with RETRY and
CONTINUE UNPROTECTED, as at launch. RETRY runs the same set-up.

This replaced a check that tested the connection from before on each return,
with a price request and the mint's `/v1/info`, and asked Tor to reconnect when
they failed. On a phone that was the slow path, and each reconnect could mark
more guards down.

Every control command claims only a reply that can be its own, with a
deadline. Tor.framework offers each reply to the newest command first, and its
helpers take replies that are not theirs: in two of three obfs4 simulator
trials of the old reconnect the SOCKS port read lost its reply and waited for
good. Smoke check 23 fails if TorService calls those helpers again. A control
link that doesn't answer within 3 seconds is connected again first. Face ID and
Control Center take focus without sending Foxy to the background, and change
nothing.

The native side measures time in the background. The PIN lock comes back on a
real return, before the set-up screen. Payments that arrived while away, and
melts still settling, are swept once Tor is up. Debug builds log each guard's
status (`tor guards (…)`) on the way out, at each set-up, and 15 seconds into
one that has not finished.

Tested in the simulator and on a phone: a normal return builds its circuit
again in about two seconds, and a return onto a different network takes longer.

**Supply chain of shipped code.** `Web/cashu-ts.js` and
`Web/bip39.js` rebuild byte for byte from sha512-pinned npm inputs, and every
file bundled into them is byte-identical to a build of its upstream git tag.
`Web/qrcode.js`, and the React and ReactDOM inside `Web/index.html`, are
byte-identical to their npm releases (qrcode also to its git tag), but are not
rebuilt from source. `Web/index.html`, `Web/foxy-wallet.js` and the app class
regenerate byte for byte from `build/` in a clean export
(`tools/verify-shipped.sh`, run by check-all). The page's shell — loader, page
policy and manifest — is taken from `index.html` and reviewed in place; its
manifest is limited to nine pinned entries. IPtProxy rebuilds from pinned commits
to the committed checksums. **Tor's C library, with OpenSSL, libevent and xz, is
built here** (`tools/build-tor.sh`) from tags whose commits
are pinned and whose signatures are checked against the projects' own keys, and
a rebuild with the same toolchain gives the same bytes. Before that it was the
Tor.framework maintainer's prebuilt release binary, which an attacker who
controlled that build could have used to put code in the wallet's process
unseen. What remains trusted is Apple's toolchain, Xcode's compiler. The autotools are
GNU's signed releases, built here by `tools/build-autotools.sh`, not Homebrew's.
`.github/workflows/tor.yml` repeats the rebuild, weekly and on demand, on a
GitHub-hosted Mac with the same Xcode, so a toolchain tampered with on one Mac
alone would show as different bytes; Apple's Xcode itself stays trusted. None of
these checks shows the upstream code is correct.

### What it does not promise

- **Tor shares a process with the seed.** A memory-safety bug in Tor or its C
  libraries is a bug in this wallet. This was one of the reasons embedding Tor
  was first declined, and it is accepted as the cost.
- **Tor is built from source here, with a toolchain that is trusted.**
  `tools/build-tor.sh` builds Tor and its libraries from signed,
  pinned tags, reproducibly with the same Xcode and autotools. The other reason
  embedding Tor was first declined, a binary nobody can rebuild, no longer
  holds; the compiler and autotools themselves are not verified.
- **Snowflake's broker and STUN contacts go outside Tor.** Above.
- **Continuing without Tor exists.** It takes an iOS alert and lasts one
  session at most, but a person who takes it is visible.
- **Host checks are on names.** A public name whose DNS answer is a private
  address passes them, and in unprotected mode the phone would open a TCP
  connection to it. Only `https` reaches the open connection, and a device on
  the local network cannot present a certificate for the attacker's name, so
  the TLS handshake fails before any request is sent. Over Tor, Tor refuses
  internal addresses. Reviewed and left as it is: URLSession has no
  hook between resolving a name and connecting, resolving first to check can be
  answered differently the second time (DNS rebinding), and connection metrics
  report the address only after the request has been sent. Over Tor the name is
  resolved at the exit, so a private answer points at the exit's network, not
  the phone's.
- **The mint still sees** amounts, timing and a Tor exit per job, and what one
  request carries links that request's parts: a swap's inputs are one wallet's,
  an invoice's polls are one receive. Jobs that start in the same second can
  still be matched by timing (MINT-PRIVACY.md).
- **App Review is unknown.** Onion Browser is precedent; a bitcoin wallet
  embedding Tor has not been through it.
- **Not yet tested on a real phone:** real Orbot. Startup and a return from
  the background have been run on a phone: three cold installs reached a circuit
  in about 13 seconds. In the simulator Tor took 14 seconds to start, traced to
  slow `timegm` calls specific to the simulator.

### The review's question, answered

**[DECIDE]** *Is the gate's job to prevent clear-net traffic, or to make it
obvious and deliberate?*

**Answered: prevent.** Every native request is refused unless Tor is ready,
the page cannot reach the network at all, and the one exception is a
per-session choice confirmed in an alert iOS draws. It is the native,
URLSession-level block the question pointed at, reached through a daemon in
the app rather than a proxy setting.

## 5. Trust in the mint

Cashu mints are custodians. The default is `mint.minibits.cash/Bitcoin`, chosen
because it works, not because it has been vetted.

**Foxy trusts the mint to:**
- honour redemption of valid proofs
- not double-spend against itself
- stay online

**Foxy does not trust the mint with:**
- the user's IP (hence Tor, §4)
- correctness of amounts — proofs are verified client-side by cashu-ts
- signing honestly. A mint could sign one wallet's proofs with keys of its
  own and recognise that wallet's ecash wherever it turns up, which is the
  linking Tor is there to prevent. So the DLEQ proof (NUT-12) is checked:
  - Proofs the mint issues are checked as they are stored. One that fails is
    kept, because the mint may still honour it, and the person is told the
    mint may be marking this wallet.
  - A token received from someone else is checked before it is swapped, and
    refused if a DLEQ it carries fails.
  - A proof with no DLEQ is accepted, since many mints and wallets do not
    include one.
  - `tests/run.js` covers both the failing and the valid-or-absent case.

**A mint can, at any time, simply keep the money.** No cryptography prevents
this. Users should hold only what they can afford to lose with any mint, and
the app does not currently say so anywhere.

**Answered: yes, and it is in the app now.**

A card at first connect on any mint, once per mint, before money exists:

> **THE MINT HOLDS YOUR BITCOIN** — Ecash in this wallet is issued by
> `<host>`. You are trusting that mint to back it with bitcoin until you move
> your money to another bitcoin lightning wallet. If it goes offline or
> refuses to pay out, there is no one to appeal to. Hold only what you can
> afford to lose.

And a quieter line under the invoice on the receive screen, which is the
moment someone is about to take custody of something.

The wording follows Minibits', which names the trust relationship rather than
gesturing at it, and says what ends the exposure — moving the money out.

**A mint that stops answering is now said.** Ecash is redeemable only at the
mint that issued it. Foxy counts a mint as not answering after three failures
spanning ten minutes. A failure is no answer, or a 502/503/504. Failures are
counted only while Tor is up and the price source or another mint answered
over it in the last three minutes, so a Tor outage is never blamed on the
mint. Any answer, a refusal included, clears it. MINT NOT ANSWERING is shown
once a session for each mint that holds part of the balance.

**Concentration.** When 100,000 sats or more sit at one mint, A LOT AT ONE
MINT suggests spreading the balance. It shows at most once in 30 days, never
on a test mint, and can be turned off.

**A lost answer's recovery adds only what that operation made.**
A claim's, a swap's or a melt's outputs restored from counter ranges are added
only when they match what the operation should have produced: for a claim, a
range summing to the invoice amount; for a receive, reclaim or import, the
incoming amount less its input fee; for a send or split, the inputs the mint now
calls SPENT, less their fee; for a held melt, at most the fee reserve. Otherwise
nothing is added and the record is kept. Without this, a record pointing at
another operation's range — an unclaimed token already handed over, say — could
count that ecash twice. A hostile mint can still lie about proof states; the
effect is refusing a recovery, leaving money for a seed restore, never creating
balance, because only proofs derived from this seed are restored. Swap records
for sends and splits hold input secrets, without signatures — no more than the
pile already exposes to the mint. Recovered proofs are never marked imported, so
reconcile removes them once spent instead of setting them aside. Set-aside ecash
with no record of its mint is shown to the person and never assigned to a mint.

---

## 6. Backup and recovery — the sharpest edge

The seed restores the wallet's *keys*. Recovering *proofs* from the seed
depends on the mint supporting deterministic restore and on the counter in
`foxy.counter.v1` being walked correctly.

Anything held outside that path does not survive a reinstall:

- `foxy.split.pending` — a bill being collected from several people
- `foxy.cashu.quotes` — invoices issued but not yet paid, and for a signed
  quote (NUT-20) the one-time key that claims it. Signed quotes close the gap
  where anyone who learned a quote id could claim a paid invoice first.
- `foxy.txmeta` — the user's own notes on past payments
- `foxy.contacts`

The app tells the user to write down twelve words. It does not tell them that
twelve words is not the whole picture. **This is the gap most likely to lose
someone real money, and it is a design gap rather than a bug.**

---

### Restoring in another wallet

Foxy's seeds are twelve English words with no passphrase, and its proofs use
NUT-13 deterministic secrets. The bundled libraries pass all ten NUT-13
vectors, for both `00` and `01` keysets. cashu.me uses the same derivation.
Nutshell needs 0.20.0 or later for `01` keysets, and a wider search than its
default for long histories (`cashu restore --to 10 --batch 100`). Restores in
Foxy never lower counters, keep a replaced seed's counters aside, never replace
a pile from a partial scan, and recover from used counters however the mint
says it (Nutshell 10002, 11003, 11004; CDK 11008, and 20006 on a claim of a quote
still PAID).
Details and test results: `SEED-HANDLING.md`.

## 7. Device and storage

### Where things are now

| what | where | in backups | at rest |
|---|---|---|---|
| the seed | keychain: `foxy.seed.v2` with Face ID on, `foxy.seed.v1` with it off (where a new install starts) or on a phone with no passcode | this-device-only: never moved to another device or to iCloud Keychain | `WhenUnlockedThisDeviceOnly`, unreadable while locked; v2 adds `.userPresence`, so every read needs Face ID or the passcode, and with v1 the phone's own lock is all that stands in front of it |
| the Orbot key | keychain, `foxy.orbot.token`, saved with `SeedStore.save` | this-device-only, as the seed | `WhenUnlockedThisDeviceOnly`, without `.userPresence`: unreadable while locked, read without Face ID or the passcode |
| proofs, log, notes, contacts, counter, PIN hash and wrong-PIN count | web view localStorage, `Library/WebKit` | **excluded** | `completeUnlessOpen` |
| the install marker | `Application Support/foxy.install` | **included**, on purpose (below) | `completeFileProtection` |
| Tor's state | `Application Support/tor` | excluded | directory mode 0700 |
| the web files | `Library/Caches/web/` | — | copied fresh from the app bundle every launch; hold nothing of the wallet's |

### A Tor bug and the seed

Tor runs in Foxy's process, so a memory bug in Tor that a relay or bridge can
reach is a way to run code beside the seed. Two things now narrow what that
code gets:

- **Tor is kept current.** `tools/vendor/check-tor-fresh.sh`, in the weekly CI
  vendor job, fails when a newer release of Tor, OpenSSL, libevent or xz ships
  in the series `tools/build-tor.sh` pins. Foxy was once found five security
  releases behind; it now builds Tor 0.4.9.12, OpenSSL 3.6.4 and xz 5.8.4
  itself.
- **The keychain no longer hands the seed over silently, once Face ID is on.**
  Its item then needs Face ID or the passcode for every read, the read after a
  Face ID unlock of Foxy uses that unlock's approval, and the page never gets
  the words (`SEED-HANDLING.md`). A new install starts with Face ID off and
  asks the person at the SECURE FOXY card.

What remains: while Foxy is open and unlocked, code inside the process can read
the BIP-39 seed native keeps in memory for the page's secrets, or ask the bridge
for the secrets of counters it reserves. Separating Tor into its own process
would take a Network Extension; replacing C Tor with Arti was evaluated and set
aside as not yet ready for iOS.

### The review's questions, answered

- *What file protection class does the web view store get?* The app sets
  `completeUnlessOpen` on `Library/WebKit` and everything in it at every
  launch.
- *Does it go into backups?* No; it is excluded at every launch.
- *Is the seed a plaintext file?* No longer. It is in the keychain. A
  plaintext copy from before is written to the keychain, read back, and only
  then removed.
- *What if content in the web view were attacker-controlled?* It could not
  reach the network (§4). It could not run injected inline script or eval
  under the page's policy. It could not navigate elsewhere and keep the bridge.
  A subframe or other origin gets no bridge at all. What it could still do is
  call the bridge as the page, which is why the bridge's own limits in §1
  exist.

### Losing the seed to a bug — which happened

A keychain read used to return the same nil for "no seed" and "the keychain
did not answer". A page told there was no seed made one, and that write
replaced the real seed. Now:

- **Three answers, not two.** `SeedStore.read` answers found, absent or
  failed.
- **A failed read is not "no seed".** The page asks again after one second and
  after three. If the keychain still does not answer, nothing is generated and
  connecting to a mint refuses, with a message saying nothing was created or
  changed.
- **A write never replaces a different saved seed unasked.** `seedCreate` and
  `seedMigrate` never replace one; only adopting typed words does, after a yes to
  "Replace this wallet's seed?" and Face ID or the passcode (the page's old
  `seedWrite` with `replace` is gone). A keychain that cannot be read is not written blind. Every write
  is read back.
- **A new wallet's seed is created as soon as the keychain says there is
  none** (`seedCreate`, on the phone), at first launch and at the latest at its
  first mint connection, so no proof is ever made with random secrets the twelve
  words could not rebuild.
- **Counters come from one stored source** shared by every wallet object, and
  restores walk each keyset in retried batches of 100; a keyset that does not
  finish marks the scan partial. See `SEED-HANDLING.md`.

`tests/run.js` covers each of these.

### Reinstall, and restoring a backup

Keychain items outlive app deletion. Minibits shipped a fix for exactly this:
a reinstall found the old seed and collided with onboarding. Foxy checks for a
marker file in its own container at launch, before the web view exists. With
no marker, both seed items, the approved hosts and the Orbot key are deleted,
and the marker is written. An earlier version deleted only the older seed item,
so once the seed had moved behind Face ID a reinstall kept it.

The marker is **included** in backups. It used to be excluded, and that turned
a restore into a reinstall. A this-device-only keychain item comes back when a
phone is restored from its own encrypted backup, but the excluded marker did
not, so the restored seed was deleted — with the proofs, which are excluded
from backups, already gone. How each case plays out now:

- **A reinstall** removes the marker with the app, so the old seed is removed.
- **A same-phone restore** brings back both marker and seed, and keeps them.
- **A backup restored to a different phone** brings the marker but not the
  seed.

**Not yet tested on a real phone.**

### The PIN

Minibits ships the shape worth following — biometric first, PIN as the
fallback for a device without biometrics. Both halves exist now: a PIN, and
Face ID or Touch ID when the device has it and the person turns it on.

**What it protects.** Someone who picks up the unlocked phone cannot open Foxy
and spend. That is the realistic case the review ranked first: a thief, a
border officer, a family member.

**What it does not protect.** It gates the app; it encrypts nothing. A person
with the unlocked device and forensic tooling can read the web store, which
holds the proofs — the money — without ever seeing this screen. The seed is in
the keychain rather than a file, which is harder to reach, not impossible.

The PIN itself is weak by construction. A PIN needs at least four digits:
ten thousand candidates at four, a million at six. Anyone holding the stored
hash can exhaust them offline. The stored value is SHA-256 iterated 120,000
times over a random 16-byte salt, which makes that cost real rather than
instant — roughly 240ms per guess on device — but it does not make it
impossible.

Failed attempts on the phone are limited:

- Five free tries, then a wait that doubles from one second to a cap of an
  hour.
- The count and the time of the last miss are stored, so closing Foxy does not
  reset them.
- While a wait runs, no PIN is checked at all, however many are typed.
- A clock moved backwards restarts the wait.

That is about the phone in a hand, not about an attacker with the file.

**POS mode** has been removed: nothing in the shipped page opened it.

**The PIN wait is not yet tested on a real phone.** The tests cover it in
jsdom.

**What happens if it is forgotten**, and what the app says: not "you can never
get in again", which would be false. The twelve words restore the wallet here
or in any other Cashu wallet. So the setup flow's third screen says the true
thing — delete Foxy, reinstall, restore from the twelve words, and if those
words are not written down the money is gone. It points at the backup, which
is where the real risk lives.

The PIN is never stored. `foxy.pin.v1` holds a salt, a round count and a
hash. A PIN guarding the screen while the seed rode in every iCloud backup
would have guarded the wrong door. That ordering was deliberate.

### Snapshots, recording and screenshots

- **The app-switcher snapshot.** When Foxy stops being the active app, the
  splash image covers everything before iOS takes its picture. It also appears
  for a moment during Face ID or when Control Center is pulled down.
- **Recording.** While the screen is recorded, mirrored or captured, the seed
  words are hidden, with a line saying why, and the restore screen ends editing
  and empties its suggestion bar, so no word shows in the bar or the keyboard.
- **Screenshots.** A screenshot cannot be prevented on iOS. One taken on a seed
  screen gets a card saying to delete it, from Recently Deleted too.

**The recording blur is not yet tested on a real phone.**

## 8. Cryptography

Most of the protocol work is done by **cashu-ts**, an established library.

One piece is hand-rolled in `foxy-wallet.js`: **SHA-256**, used for the PIN
hash. It is checked against the published NIST FIPS 180-4 vectors:

```
node tools/foxy-crypto-vectors.js     # 5 passed, 0 failed
```

The hand-rolled secp256k1 arithmetic is gone: payee recovery went first, and
the old P2PK key derivation, its last user, was removed with Foxy's own
earlier P2PK scheme. Its vectors and generator went with it.

**The review checked this independently and it held.** A differential test of
the SHA-256 against a reference implementation across 134 inputs — every
padding and block boundary — matched exactly, and all ten scalar-multiplication
vectors re-derived with math written for the audit, plus nineteen scalars of
its own including 1, 2, n−1 and the point at infinity.

**Known limits:** the SHA-256 is not constant-time. It hashes the PIN with its
salt, inside the app; a timing attack there is not a realistic threat.

**P2PK, for payment requests only.** A request Foxy makes
carries a fresh public key and asks payers to lock the ecash to it, so a
payment taken off the air or off a relay is worthless to anyone else. The key
is derived from the seed at NUT-13's P2PK path (`Foxy/Keychain/P2PK.swift`),
so the twelve words open a locked token already in hand on any phone;
`foxy.req.lockkeys` keeps only the index and the public half, and the private
half comes from the phone (`p2pkKey`) when there is ecash to open. An ordinary
send still carries no lock. A token carrying any condition this phone holds no key for is
refused before the mint is asked, and one this phone *could* open is accepted
only when cashu-ts says it alone can (`onlyLockedTo`): NUT-11's tags can leave
a proof spendable by the payer, or by anyone, while its `data` field still
names us.

The DLEQ check (§5) uses cashu-ts's `hasValidDleq`, not hand-rolled code. A
mint response whose DLEQ fails is refused by cashu-ts; the app says THIS MINT
SENT INVALID SIGNATURES and offers no retry, and the claim is never repeated.

Payment requests (NUT-18) are read by cashu-ts's decoder; Foxy's
own CBOR reader is gone. `tests/nut-vectors.js` runs the NUT-18 vectors through
it, and a crafted request claiming a 4 GB string is refused at once.

---

## 9. Known weaknesses, stated rather than found

Better to list these than to have them written up as discoveries.

1. **Continuing without Tor is possible**, for one session at most, confirmed
   in an iOS alert. §4.
2. **Tor runs in the wallet's process.** Its C library is built here from
   signed sources; the toolchain is trusted. §4.
3. **Snowflake's broker and STUN contacts go outside Tor.** §4.
4. **Resolved: iOS 17 is required**, so failing closed always rests on
   `ProxyConfiguration` with failover off. §4.
5. **The PIN gates the app and encrypts nothing.** The proofs sit in the web
   store. §7.
6. **Backup does not cover everything.** §6.
7. **Mint custody is absolute.** §5.
8. ~~Dead code from a fork.~~ Resolved. The bindings named here
   (`isKycRun`, `isPlaidRun`, `isCardHub`) were already gone; the last 11
   render values defined and used nowhere, and four screens with no markup,
   were removed. Render parity covers the 33 views that remain.
9. **`Web/index.html` is a generated artifact** of about 1.4 MB. Read
   `build/app/` (joined into `build/foxy-app.js`) and `build/markup.html` instead — `build/README.md`
   explains the relationship. `tools/pack-index.py` rebuilds the artifact,
   round-trips byte-for-byte, and recomputes the loader hash in the page
   policy.
10. **No release process.** No Apple developer enrollment, no TestFlight, no
    signed builds, no reproducible build story for the app as a whole. The app
    is installed by cable from Xcode.
11. **Price and candle data** come over Tor. The price comes from the first of
    mempool.space's onion, Kraken, Bitstamp, blockchain.info, Gemini and
    Coinbase to answer; the candles come from Kraken. The onion is asked first
    and beside Kraken, not in front of it: an onion has no exit node in its
    path, so none of the refusals the clearnet five meet — Coinbase's outright,
    Cloudflare's challenge, a rate limit on an exit address thousands share —
    apply to it, and it is the one that still answers when the rest are being
    turned away. It is a public address, the same for every Foxy, and naming it
    tells a watcher nothing; clearnet mempool.space was dropped when the onion
    arrived, so that one operator cannot satisfy the two-source rule below on
    its own. A failed price fetch is visible; a
    wrong one from a single source shows only in the dollar figures. For a
    payment typed in dollars the price decides how many sats go, so there two
    sources must agree within 2% before anything can be sent. Those sats are
    fixed when the confirmation has that price, shown as its headline beside
    it, and sent exactly. Before that the first source alone decided, the
    headline was in dollars, and the sats were worked out again at the tap.
12. **A relay directory ships in the app.** Tor cannot build a circuit until
    it holds the microdescriptors of the relays it might use, and a first run
    has none: it downloads all nine thousand first, which was 37 of the 45
    seconds between launch and the first circuit on a phone.
    `Foxy/TorSeed/tor-microdescs.xz` is a copy of that
    directory, harvested from Foxy's own Tor by `tools/make-tor-seed.sh` and
    laid down once, on a first run only, by `TorSeed.plant`.

    It is not a trust boundary. Tor verifies every microdescriptor against the
    SHA-256 digest the consensus gives for it, and the consensus against the
    directory authorities' signing keys compiled into Tor itself; an entry that
    fails is dropped and fetched instead. A seed that is stale, truncated or
    tampered with therefore costs the disk it sits on and nothing else, and a
    cache Tor has already built for itself is never replaced by it.

    Nor does it say anything about the phone: the Tor directory is public and
    every copy of Foxy ships the same one. What it does change is what a first
    run asks a directory mirror for — the relays that have changed since the
    seed was made, rather than all of them. That is the ordinary shape of any
    Tor client that has run before, and less distinctive than the empty cache
    it replaces. It goes stale rather than wrong: an old seed covers less of
    the consensus and saves less time, which is why it is refreshed at release.
13. **`style-src` allows `'unsafe-inline'`.** Script does not.
14. **Host approvals stop new hosts, not a script already in the page.** It
    could still send what it reads through a host that is approved: a
    lightning-address comment, or a payment to an invoice of its own at the
    connected mint. A host's subdomains are approved with it, and the alert
    says so; a host carried over from the page approves only itself. After a
    Don't Allow, no alert appears for 30 seconds.
15. **The system paste control sits at 2% opacity** over Foxy's own paste
    button, by decision. A page script could place it over another
    control and take the clipboard on the next tap there without iOS asking.
16. **A PIN that is also the phone's passcode** unlocks more than Foxy: the
    PIN hash is in the web store and quick to try offline, and the passcode
    reads the seed item.
17. **Not yet tested on a real phone:**
    - real Orbot
    - a backup restore
    - the PIN wait
    - the seed blur during screen recording

    (Tor's startup and a return from the background have been run on a phone.)

Superseded from the earlier list:

- *the gate cannot enforce* — replaced by `Route`, §4
- *the seed in localStorage* — now in the keychain, §7
- *the Tor check is a round trip through Tor* — the check is gone, §4
- *no PIN or biometric* — both built, §7

---

### Added after the alignment review

- ~~P2PK keys are Foxy's own derivation.~~ Removed with the scheme.
- ~~Only sat keysets are restored.~~ Resolved: every unit a mint
  lists is restored, received and shown (`foxy.cashu.proofs.<mint>@<unit>`).
  Sending in another unit is not built and is refused (`TODO-LATER.md`).
- **Tor 0.4.9.6 logged internal `Bug:` warnings from its conflux (multipath
  circuit) code** when recovery switched its network off and on. Resolved by
  turning conflux off (`ConfluxEnabled 0`). In four simulator recovery trials,
  conflux on: 27 `Bug:` lines in one of two runs, recovery confirmed in 5.5 and
  5.8 s. Conflux off: none in either run, recovery in 7.0 and 7.6 s, first
  circuit unchanged at 18 s. Conflux mainly helps large transfers; a wallet's
  requests are small.

### Added later

- **A chip card that holds ecash has limits of its own.** A terminal built to
  cheat, the card's PIN typed in the clear on the receiving phone, a time key
  that is public while the time is interim, and a card payment taken on trust
  when the till has no route are each argued in `CARD.md`, *What it does not
  protect against*. The bridge actions that serve a card are in §1.
- **A restore's reach.** A swap now asks for up to sixty shaped outputs, and a
  refused or lost request burns the counters it reserved. The walk's gap and
  the phone's window are 1,000 counters (`RestoreWindow.beyond`,
  `RESTORE_GAP`); seventeen such failures in a row with no success between
  would leave everything after them unreachable from the words. The same
  constant bounds how far past the last reserved index a lock private key may
  be asked for.
- **A piece left spendable while its swap is unanswered.** As the Tor window
  closes on a put-away top-up, a piece the mint says it has not taken stays
  in the pile (`freeInputs`). A request landing after that check spends it;
  the next payment offering it fails at the mint and drops it, and the
  outputs come in on the next connection. Bounded by the twelve-second rule
  on starting swaps; not closed.
- **The tap handshake hands the offer to whoever completes it** (found by a
  later audit, still open): what the QR already shows, to a phone that cannot
  see the screen. The gate that would close it against an active device is
  ultra wideband ranging, specified in `UWB-TAP.md` and not built; nothing at
  the Bluetooth layer closes it.

## 10. Out of scope

**Settled**, after the review. Each of these is excluded
deliberately, and the reason matters as much as the exclusion — a reviewer
should know what was not looked at, and why, rather than infer it.

- **Tor, Tor.framework, IPtProxy, and Orbot.** Foxy embeds the first three and
  can work alongside the fourth; it cannot audit any of them. What it can do:
  pin their versions, build IPtProxy reproducibly, refuse every request while
  Tor is not ready, and believe Orbot only under the checks in §4. *(This
  line once read "Orbot, Mullvad, or any other tunnel provider", when Foxy
  depended on them for its privacy.)*
- **The Cashu protocol itself, and `cashu-ts` as a library.** This is the
  exclusion to look at hardest: `cashu-ts` builds every proof and secret in
  the app. `Web/VENDOR.md` establishes that the shipped copy is genuinely
  `@cashu/cashu-ts@4.11.0` and unmodified. It does not establish that the
  library is correct, and nothing here does.
- **The mint's own infrastructure.** A mint can keep the money without any
  software failing. That is §5, and it is a property of Cashu rather than a
  defect to be found.
- **iOS platform vulnerabilities.** Out of reach, and a jailbreak or a
  WebKit exploit defeats every control in this document.
- **Physical coercion.** The PIN in §7 does not help here and must not be
  relied on for it. Someone who can compel you can compel the PIN.

---

## 11. What the review prioritised

The order proposed before the review, which it followed:

1. **Seed and key handling** — generation, storage, protection class, backup
   exposure. The highest-value area and the least examined.
2. **The web/native boundary** — what the bridge exposes and whether any of it
   can be reached in a way that was not intended.
3. **The gate's real guarantees**, as opposed to its intended ones.
4. **The proof lifecycle** — the reconcile path that can drop proofs, the
   pending-split file, and what happens to money mid-operation when the app is
   killed.
5. **The hand-rolled crypto**, now vector-checked but never reviewed by a
   cryptographer.

---

## 12. What the review changed

Twenty-two findings, numbered and titled as in the report. This file used to
say all were addressed when the review closed; a re-check found
three still partly open (9, 13, 17), which were then fixed. A second re-check,
against the report's own text, found this table had numbered the
last four findings differently from the report and dropped the sub-points of
13, 20 and 21; the residue in 13 had been missed that way. Status:

| # | finding | status |
|---|---|---|
| 1 | every phone backup carries the whole wallet | closed; the web store is excluded from backups and protected `completeUnlessOpen` (one class below `complete`, so storage still works while the phone is locked); the seed is in the keychain, this device only (behind Face ID or the passcode once the person turns that on) |
| 2 | a payment link can name its own price | closed; the amount must match to the millisat, and an invoice with no amount is refused |
| 3 | the "not through Tor" screen leaves the wallet open | closed; the design was replaced by `Route` |
| 4 | the background invoice pollers skip the gate | closed; every poller asks the route first, and the WebSocket is never opened |
| 5 | the native price and Tor-check calls have no tunnel check | closed; refused natively unless Tor is ready or the person continued without it; the Tor check and the network monitor are gone |
| 6 | a copied token syncs to every Apple device | partly open by decision: device-only with a 120 s expiry, not cleared when Foxy goes to the background |
| 7 | the web view has no navigation policy | closed; only the staged folder loads, and the bridge answers only its main frame |
| 8 | two bookkeeping routines trample each other | closed; one lock over every read-then-write of the proofs (18 operations). It re-opened for the on-chain paths, which read the pile, waited on the mint and wrote it back outside the lock until that was fixed: ecash that arrived while a payout's split was in flight was written over (`tests/onchain-faults.js`) |
| 9 | a payment in flight is booked as paid | closed, including lightning addresses and the 150 s backstop |
| 10 | the wallet takes the mint's word that money is spent | closed; quarantine, put back only if UNSPENT; only seed-derived proofs are dropped |
| 11 | a QR code can point the wallet at a cleartext mint | closed; https, or http only for `.onion`, on the typed and scanned paths; no transport-security exceptions |
| 12 | a failed first storage write loses the new seed | closed; the seed is made and stored by Swift, and one the keychain has not confirmed is never used to connect |
| 13 | fork residue: the More screen rows, the demo QR, the domain chips, the notification title, the dead sheets | closed. The rows, chips and title went first. Still shipping after that: a "Sign in on another device" sheet whose QR image encoded a company's web address, ten more sheets nothing opened (card read and delete, sign-out, POS exit keypad, PIN, support, delete, ways to receive, higher limits, add bitcoin) with the GET HIGHER LIMITS button, and `renderUnbound`, the fiat prototype's values no markup bound. All removed. A second pass took the confirm-delete sheet (nothing set `askWhat`), POS mode and its test, and 26 methods the prototype left behind — sign-up, the card and bank flows, the map, the layout editor. A third pass took the fiat swap, cash-only mode, and seven screens the app still named but nothing drew |
| 14 | imported backups fake a balance; one mint under two spellings splits the money | closed; imports are de-duplicated and mint-checked, and mint URLs are canonicalised |
| 15 | an invisible paste button can be parked over anything | partly open by decision: kept invisible, placement limited to under 90 % of the width, under half the height and the lower two-thirds; seed phrases are never handed to the page through it |
| 16 | notifications can be faked, amounts show on the lock screen, the log guard is bypassed | closed; two fixed texts, no amounts, rate-limited; the console mirror is Debug-only and native logging is silent in Release |
| 17 | a payment request moves the wallet to a strange mint | closed; a card naming the mint in full before connecting, and every switch path refuses while money is moving — including the transfer between mints, which connects to the destination to quote and did not wait until that was fixed |
| 18 | the embedded runtime's remote-code loader | closed; the runtime was replaced by an in-repo renderer |
| 19 | two unused helpers, `burn()` and `restoreFromSeed()` | closed; both removed |
| 20 | smaller items in the wallet core (five) | closed: the platform UTF-8 encoder; payment requests decoded by cashu-ts and fuzz-tested; the LNURL checksum verified, https required and callbacks through the host checks; quotes past 50 kept in a second list that is still swept; the refund-key counter removed |
| 21 | smaller items in the shell and tooling (four) | closed: the network monitor is gone; the paste host is torn down on stop, on page loss and on re-placement; seed words are no longer in the page; `foxy-walk` skips secret screens. The camera overlay is still hidden rather than removed, deliberately, with the capture session stopped |
| 22 | the bundles can't be rebuilt | closed except qrcode: cashu-ts and bip39 rebuild byte for byte; React and ReactDOM from React's signed tag; Tor from signed tags, rebuilt again by the weekly `tor.yml` workflow on a GitHub-hosted Mac; IPtProxy to its recorded checksums. qrcode.js is the npm release's own file, checked against it and its git tag. The runtime that broadcast component metadata is gone |

The seven urgent ones, as they stood when the review closed:

| finding | what it was | now |
|---|---|---|
| backups | the seed and proofs rode in every iCloud and iTunes backup | the web store is excluded and file-protected |
| a payment link naming its own price | the invoice a lightning address returned was paid unchecked | the amount is compared to the request and a mismatch is refused |
| the blocking screen | stopped taps, not traffic — the wallet's flag stayed set | a failed verification closes the wallet |
| background pollers | the invoice sweep and quote watcher never consulted the gate | all of them do, plus the socket |
| native calls | price, candles and the Tor check ran with no tunnel check | refused natively unless the user chose exposed mode |
| the clipboard | a copied token synced to every paired Apple device | device-only with a two-minute expiry |
| navigation | the web view would follow any navigation and hand over the bridge | an allowlist, file-only |

**Since then.** The blocking-screen, poller and native-call rows
describe the superseded gate:

- Native calls are now refused by `Route` unless Tor is ready or the person
  continued without Tor in an iOS alert (what the table calls exposed mode).
  The Tor check is gone.
- The page cannot reach the network at all, so the mint WebSocket is not only
  gated but never opened.
- Pollers ask the same route state before each attempt.
- On top of the navigation allowlist, the bridge now answers only the staged
  page's main frame, and `open` is removed.
- The backup row is extended: the seed is in the keychain, and the install
  marker is included in backups so a same-phone restore keeps it.

**Later, two things a re-check should look at.**

- **Finding 9's line moved, for money coming in.** A receive is written to
  history as settled when the ecash *arrives*, not when it is swapped into this
  wallet's own secrets. The swap follows immediately — the delay it used to sit
  behind has been removed — so the gap is now a round trip to the
  mint rather than minutes, but it is still a gap. The balance already counted
  it (`unclaimedSats`), so this makes the two agree rather than widening either
  on its own, and the claim rests on the proofs being locked to a key only this
  phone holds: the payer cannot take them back and nobody else can spend them.
  What it does not survive is a mint that will never swap again — history and
  balance would both show sats that cannot be spent. Finding 9 was about
  outgoing payments booked before they completed; this is the incoming mirror
  of the same question, and it is named here rather than left for a reviewer to
  find (`build/wallet/20-helpers.js`, `tests/p2pk-round-trip.js`).
- **Tap to pay puts a radio on the air**, which the reviewed app did not have.
  The receiver advertises while an invoice with an amount is on its screen: it
  arms itself by default (AUTO TAP TO PAY, which the person can turn off,
  leaving a press of TAP or a shake), and the payer never advertises. §1 has
  its bridge actions and `TAP-TO-PAY.md` has the handshake and what a listener
  nearby can learn. It was wrong once, in the way that matters: the page armed
  from the home screen as well, left over from when the payer was the listener,
  so Foxy broadcast whenever it was open (since fixed). The guard that should have
  caught it tested the mechanism — does `advertise()` refuse unless armed —
  rather than the policy, which is who may arm.

Three findings were the author's own mistakes and are recorded as such: the
demo receive address came from a PII scrub that put a
real custodial service's address on a live screen; the reconcile race was documented here
as a double-report nuisance when it was silent money corruption; and the
release console guard was defeated by the app's own console mirror, which had
not been checked for.

Two mechanisms for tunnel enforcement were investigated and both turned out not
to exist as described. That is recorded in §4 rather than quietly dropped.
