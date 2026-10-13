# Foxy Wallet privacy policy

Effective date: 2026-10-13

This policy covers Foxy Wallet for iPhone, published by Island Bitcoin LLC. Questions go to apple@islandbitcoin.com.

## Summary

Foxy is a bitcoin wallet for Lightning and Cashu ecash whose seed stays on
your iPhone. The app talks directly to the services you pay and get paid
through. Island Bitcoin runs no server for Foxy and receives no data from the
app. Foxy works without an account. The app contains no analytics, advertising
or crash-reporting code.

## What leaves your iPhone, and where it goes

Foxy connects to these services to do what you ask of it. Each request goes
over Tor, which Foxy runs inside the app, so the service sees a Tor exit or an
onion connection and your IP address stays hidden from it. Requests carry a generic browser
User-Agent and no cookies.

- **Cashu mints.** The mints your wallet uses: the default mint
  (mint.minibits.cash), the other mints Foxy lists (mint.westernbtc.com,
  mint.macadamia.cash, and two test mints at testnut.cashu.space that issue
  ecash worth nothing), any mint you add, and the mint behind ecash someone
  sends you. The first time Foxy contacts a host outside its built-in list,
  iOS shows an alert with the host's name, and Foxy contacts it only if you
  tap Allow. A mint receives the ecash requests your wallet makes, the
  Lightning invoices you ask it to pay, the invoices and bitcoin addresses it
  creates for you to be paid, and the amounts involved.
- **Lightning address and LNURL servers.** When you pay a Lightning address or
  an LNURL, Foxy asks that server for an invoice (after the same alert, the
  first time). The server receives the amount you are paying and any note you
  write.
- **Price and chart sources.** A mempool.space onion service, Kraken,
  Bitstamp, blockchain.info, Gemini and Coinbase, for the bitcoin price in
  dollars, and Kraken for the chart. These are public price requests, the same
  for everyone who asks.
- **Block explorers.** The mempool.space and Blockstream onion services, then
  mempool.space and blockstream.info, for the newest Bitcoin block header.
  Foxy uses it as the clock for the Foxy Flashcard. It asks when Tor connects,
  when the app comes back to the front, and when a card is tapped.
- **Nostr relays and onion addresses.** When you pay or are paid through a
  payment request, the payment travels to the other person through a Tor onion
  address or through Nostr relays. While Foxy shows a payment request, it runs
  a temporary onion address of its own on your iPhone and listens on four
  Nostr relays (relay.damus.io, nos.lol, relay.primal.net and
  relay.minibits.cash) under a key made for that one request. When you pay a
  request, Foxy delivers to the onion address or the relays the request names.
  Over Nostr the payment is encrypted to the receiver (NIP-44 inside NIP-59
  gift wraps), so a relay sees an encrypted message. Over an onion address it
  travels inside Tor from end to end.
- **The Tor network.** Tor relays and directory authorities, and when a direct
  connection to Tor fails, Tor's built-in obfs4 bridges or Snowflake. These
  carry everything above. Snowflake reaches Tor through a content delivery
  network (CDN77), public STUN servers and a volunteer proxy. Those contacts go
  directly from your iPhone, so they see your IP address and that you are
  starting Snowflake, as with any Snowflake user. Mints, amounts and payments
  travel only inside Tor.

Three exceptions leave Foxy's Tor:

- If Tor cannot connect, Foxy offers CONTINUE UNPROTECTED. It takes effect
  only after you confirm it in an iOS alert, and it lasts until Tor connects or
  the app is closed. During that time a row across the app reads IP ADDRESS
  EXPOSED, and mints, price sources, Lightning address servers and the block
  explorers' ordinary addresses are reached over HTTPS from your own IP
  address. Onion addresses and Nostr relays are reached over Tor only.
- If you run Orbot, Foxy asks Orbot for its bypass, and Foxy's Tor reaches its
  relays through Orbot's local port. Everything Foxy sends still goes only
  through Foxy's own Tor. Orbot hands Foxy an access key through the
  clipboard; Foxy reads it once you have asked Orbot for it, clears the
  clipboard and stores the key in the keychain.
- The GET DOLLARS links (Cash App, Strike, River and Flash) open in your
  iPhone's browser, outside Foxy. Those companies' own privacy policies apply
  there.

## What stays on your iPhone

- **Your seed.** Foxy creates your twelve recovery words on the iPhone and
  stores them in the iOS keychain as an item marked this-device-only
  (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`). It is unreadable while the
  iPhone is locked, it stays out of iCloud Keychain, and it cannot be
  restored onto a different iPhone. A backup restored to the same iPhone can
  bring it back. When you turn on FACE / FINGER LOCK, the seed moves to a
  keychain item that also needs Face ID, Touch ID or the device passcode for
  every read.
- **Your wallet.** Your ecash, history, contacts, notes and settings are kept
  in Foxy's own storage on the iPhone, excluded from iCloud and computer
  backups and unreadable while the iPhone is locked. Foxy's other files (Tor's
  state, the wallet's counters and the diagnostic record below) are excluded
  from backups too. One small file that marks the installation is included in
  backups on purpose, so that a backup restored to the same iPhone keeps its
  seed. Your recovery words are the way to restore the wallet on another
  iPhone.
- **Hosts you allowed.** The mints and payment domains you allowed in the iOS
  alert are kept in the keychain, this device only.
- **Camera.** Foxy uses the camera to scan QR codes. Frames are decoded on the
  iPhone and discarded right after.
- **Bluetooth.** Tap to pay passes a payment between two phones held close
  together over Bluetooth Low Energy, encrypted between the two phones. It
  works between iPhones and Android phones running Foxy. A receiving phone
  advertises a random identifier made for that one payment while its invoice
  screen is open, or only after you tap TAP TO PAY when AUTO TAP TO PAY is off
  in settings. A paying phone only listens.
- **NFC.** Foxy talks to a Foxy Flashcard over NFC while you hold the card to
  the iPhone, and iOS lets it talk only to the Foxy card applet. A Flashcard's
  web address (getfoxy.io/card) opens Foxy; to allow that, iOS checks
  getfoxy.io's association file through Apple's servers.
- **Face ID, Touch ID and the PIN.** FACE / FINGER LOCK uses iOS's own Face ID,
  Touch ID or passcode prompt, and Foxy receives only whether it succeeded. A
  Foxy PIN, if you set one, is stored as a salted hash.
- **Notifications.** "Payment sent" and "Payment received" notifications are
  created on the iPhone itself and carry no amount. Foxy asks for permission
  the first time one is due.
- **Clipboard.** When you copy a sensitive value, such as an ecash token, Foxy
  marks it local to this device so it stays off Universal Clipboard, and iOS
  removes it 120 seconds later. Foxy reads the clipboard when you paste.
- **Screen.** The recovery words are blurred while the screen is recorded or
  mirrored. iOS lets Foxy know when a screenshot is taken, so the app can tell
  you what the picture holds.
- **Diagnostic log.** Foxy keeps a log of what it is doing, in memory, with
  ecash tokens, invoices, payment requests, onion addresses, Nostr keys and
  long hexadecimal values replaced by a placeholder. Mint addresses and
  amounts stay in it. A shorter record of the connection is saved on the
  iPhone for the next launch, so a stuck start can be explained, and deleted
  when it is read. You can read the log on the LOGS screen. It leaves the
  iPhone only if you tap COPY and paste it somewhere yourself.

Deleting Foxy deletes its storage from the iPhone. Keychain items survive an
app deletion on iOS, so on the first launch after a reinstall Foxy deletes the
old seed, the allowed hosts and the Orbot key. Write down your recovery words
first if you want to keep the wallet.

## Ecash and mints

Cashu ecash is a bearer claim on the mint that issued it. The mint holds the
bitcoin behind your ecash, and it can see the operations your wallet sends it,
though Cashu's blind signatures keep it from linking the ecash it issues to
the ecash it later redeems. Choose mints you trust with the amounts you hold.
Each mint has its own terms. docs/MINT-PRIVACY.md describes what a mint can
learn from each operation.

## Permissions

| Permission | Why |
|---|---|
| Camera | Scanning QR codes, asked the first time you scan |
| Bluetooth | Tap to pay, asked the first time an invoice screen opens or you tap TAP TO PAY |
| Face ID | FACE / FINGER LOCK and the seed's protection, asked the first time Foxy uses Face ID |
| Notifications | "Payment sent" and "Payment received", asked the first time one is due |
| NFC tag reading | The Foxy Flashcard, limited to the Foxy card applet |

These are all the permissions Foxy asks for. Foxy does not use location,
contacts, photos, the microphone or tracking, and it reads no advertising or
device identifier.

## Apple and TestFlight

Foxy is distributed through Apple. If you install it through TestFlight or the
App Store and allow sharing with app developers in iOS settings, Apple may
share crash reports and usage statistics with Island Bitcoin, and feedback
you send through TestFlight reaches Island Bitcoin with the details you
include. Apple's privacy policy applies to that.

## Children

Foxy is for people 18 and over. It is a wallet for real money, made for
adults.

## Changes

When this policy changes, the new version is published at this address with a
new effective date, and the history of every change is public in this
repository.

## Contact

Island Bitcoin LLC
apple@islandbitcoin.com
https://getfoxy.io
