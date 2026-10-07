# Overview

What Foxy is, what it does when it starts, how it reaches the network, and
what it leaves out on purpose. The limits are argued in `THREAT-MODEL.md`.

Foxy is a Cashu ecash wallet for iOS. It holds bearer tokens issued by a mint,
sends and receives over Lightning and as ecash, and runs Tor inside the app.
Every network request the app makes goes through that Tor or is refused, unless
the person using it chooses to continue without Tor. iOS confirms that choice
in its own alert, and it ends when Tor connects or the app closes. It has had
one independent code review (see `THREAT-MODEL.md`) and no formal audit. Do not
hold in it what you would not carry in cash.

## On launch

Foxy starts its own Tor and shows **CONNECTING TO TOR** with progress. If
direct Tor does not connect it tries the built-in obfs4 bridges, then
Snowflake, without asking. For a day after, it tries the one that worked
first. If none connects: **CANNOT CONNECT TO TOR**, with RETRY and CONTINUE
UNPROTECTED. CONTINUE UNPROTECTED opens an iOS alert, and only a tap there lets
requests go out without Tor. Foxy keeps trying Tor and moves onto it when it
connects. Until then a row across the app reads *IP ADDRESS EXPOSED*. If
Orbot is running, **ORBOT DETECTED** asks you to allow Foxy in Orbot. The default
mint is `mint.minibits.cash`.

## How it reaches the network

- **The page has none.** A WebKit content rule list blocks `http`, `https`,
  `ws`, `wss` and `ftp` from the web view, and it is installed before the page
  loads. If it cannot be built, Foxy does not start. The page's policy also
  keeps `connect-src` local and allows no `'unsafe-inline'` or `'unsafe-eval'`
  script.
- **Every request is native, and one function decides where it goes.**
  `Route` in `Foxy/Network/Route.swift` uses Tor's SOCKS session when Tor is
  ready. It uses the ordinary connection only if the person continued without
  Tor. Otherwise it refuses with "Foxy is not connected to Tor."
- **Ready means** a circuit, enough directory information to build the next
  one, and the SOCKS port read back from Tor itself.
- **Not through Tor, by design:** Snowflake's broker and STUN contacts. They
  learn the phone is starting Snowflake. They never see a mint, an amount or a
  payment.
- **Foxy opens on the home screen, and the connection is a banner.** A wallet
  that has connected once is shown from what is on file (its mint's keysets
  and the last price) and works offline until Tor is really up, a few seconds
  later. The banner at the foot of the home screen says which: SECURING YOUR
  CONNECTION while Tor is at work, OFFLINE - NO CONNECTION with no network,
  CANNOT CONNECT when Tor has given up, and a tap on it brings the connection
  screen with its count and its choices. Only a first launch, with nothing on
  file, waits behind that screen. Nothing about what is sent changes: the
  phone refuses every request without Tor, as before. A step that moves
  money waits a few seconds for a connection that is on its way rather than
  take the offline way.
- **Coming back from the background is the same.** Once what is with a mint
  has come back (a payment is waited for up to twenty seconds, anything else
  up to three), nothing new is sent, and Tor goes off the network about
  twenty-four seconds after Foxy left: as long as iOS allows, less the time
  leaving takes. Back before that, Foxy has the connection it left with.
  After it, the home screen is there at once, offline, while a private
  connection is set up again; nothing is tried on the connection from before.
  The PIN lock comes back on a real return from the background.

The details, and the limits, are in `THREAT-MODEL.md` §4.

## What it deliberately does not do

- **Receive ordinary ecash offline.** A token is not filed until it has been
  swapped at the mint, because until then the sender holds the same secrets.
  An offline receiver takes only ecash locked to its own key, for a request
  still open on it (`MONEY.md` §14).
- **Export proofs from a button.** An export is bearer money in plain text.
  Seed restore is verified against the default mint; `FoxyWallet.exportProofs()`
  exists in the console for the rare case that needs it.
- **Hide you once you continue without Tor.** That choice is real. The mint,
  the price feeds and anyone you pay see the phone's IP address until Tor
  connects.
- **Encrypt the wallet behind the PIN.** The PIN, and Face ID if turned on,
  gate the app. The seed is in the keychain, but the proofs sit in the web
  view's storage, and the PIN does not encrypt them.
- **Sync the seed.** It is a this-device-only keychain item. Lose the phone
  without the twelve words and the money is gone.

## Not yet tested on a real phone

Real Orbot (the Orbot path has been tested only in the simulator, against a
fake Orbot), a backup restore, the PIN wait, and the seed screens' hiding
during screen recording. Tor's startup time and a return from the background
have been run on a phone. The steps, and a table of what has been run on a
device, are in `DEVICE-TESTS.md`.

## Provenance

Forked from a fiat-and-bitcoin prototype and cut down to ecash only.
