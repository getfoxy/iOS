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
- **Coming back from the background sets up a private connection again.** Tor
  goes off the network as Foxy leaves, once what is with a mint has come back:
  a payment is waited for up to twenty seconds, anything else up to three, and
  from then nothing new is sent. On return it is set up the way launch
  sets it up, behind the same screen, and the home screen shows once the
  balance has loaded. Nothing is tried on the connection from before. The PIN
  lock comes back on a real return from the background.

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
