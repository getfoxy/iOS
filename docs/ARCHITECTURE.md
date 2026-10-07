# Architecture

One page: what Foxy is made of, why the wallet is a web page inside a native
app, and how the thing on a phone is built from what is in this repository.
Details are in `THREAT-MODEL.md` (the layers and the bridge), `STORAGE.md`
(what is kept where) and `build/README.md` (the build).

## The shape

    ┌──────────────────────────── the app, one process ───────────────────────────┐
    │                                                                              │
    │   Web page (one WKWebView, loaded from a local file)                         │
    │     screens            build/app, build/markup.html                          │
    │     wallet             build/wallet  → Web/foxy-wallet.js                    │
    │     cashu-ts 4.11.0    unmodified, bundled as Web/cashu-ts.js                │
    │     proofs, history    localStorage                                          │
    │                                                                              │
    │        │  66 named actions, nothing else                                     │
    │        ▼                                                                     │
    │   Swift                                                                      │
    │     bridge             Foxy/Bridge                                           │
    │     seed, lock keys    Foxy/Keychain   (keychain; libsecp256k1)              │
    │     network            Foxy/Network, Foxy/Tor   (Tor 0.4.9.12, in process)   │
    │     tap to pay         Foxy/Bluetooth  (CoreBluetooth, CryptoKit)            │
    │     camera, Nostr, onion inbox, notifications                                │
    │                                                                              │
    └──────────────────────────────────────────────────────────────────────────────┘

The page is the wallet. Swift is everything the page is not trusted with or
cannot do.

## Why a web page

**It runs cashu-ts as it is.** The Cashu logic is the reference TypeScript
library, bundled from its release and not edited. `tools/verify-vendor.py`
rebuilds the bundle and compares it byte for byte. Blind signatures, DLEQ,
NUT-11 rules and token encoding are the library's, not ours. Swift does only
one piece of Cashu: it derives NUT-13 secrets and P2PK keys from the seed,
because the seed never enters the page.

**The wallet can be tested without a phone.** The same `Web/foxy-wallet.js`
that ships is loaded in Node. The test suites drive it against a fake mint,
against local CDK and Nutshell mints with fake sats, and as two wallets
paying each other in one process. The wallet suites need no simulator and
run in about ten minutes on a laptop.

**What ships can be read.** Foxy's own code is not minified. The wallet
ships as one plain file, joined from named parts. The screens ship inside
`index.html`, packed from their parts by a script anyone can run and compare
(below).

## What that costs, and what is done about it

A script that runs in the page can read the proofs. That is the price, and
most of the native side exists to make sure no such script gets in and that
it could do little if it did.

- **The page has no network.** Three separate blocks: a content rule list
  refuses `http`, `https`, `ws`, `wss` and `ftp`; the web view's proxy is a
  SOCKS address where nothing listens; and the page's policy
  (`connect-src 'self' file: blob: data:`) forbids it. Nothing is loaded from
  anywhere but the app's own files.
- **No script but ours.** The policy allows no inline script and no `eval`,
  except one loader pinned by its hash. Every third-party file is checked
  against its public release.
- **Every mint request is Swift's.** The page asks the bridge (`mintRequest`),
  and Swift sends it through Tor or refuses it. `https` only, or `http` to an
  onion address; never an IP address or a local name.
- **The bridge is a fixed list.** 66 actions, each one function, in one table
  (`FoxyBridge.handlers`). A message from anything but the main frame of the
  local page is refused. The unit tests fail if the table and the list in
  `THREAT-MODEL.md` differ.
- **The seed is not in the page.** The twelve words are in the keychain.
  Swift shows them and takes them in on its own screens, owns the NUT-13
  counters, and hands the page the secrets for counters it has reserved. The
  page never holds the words or a BIP-32 chain code.
- **What is still true.** Proofs are in the web view's `localStorage`, so
  code running in the page could spend them, and could ask the bridge for
  secrets at counters it reserves. Tor runs in the same process as the seed.
  `THREAT-MODEL.md` says what each of those means.

## How the build works

Foxy's own code is edited in parts and joined. Nothing of Foxy's is compiled
or minified for the page. React, the renderer, the icons and the fonts go
into `index.html` gzipped, the same bytes every time.

    build/wallet/*.js   26 parts ──join──▶ Web/foxy-wallet.js
    build/app/*.js      33 parts ──join──▶ build/foxy-app.js ─┐
    build/markup.html   the screens ─────────────────────────┤
    build/foxy-render.js   the renderer ─────────────────────┼─pack─▶ Web/index.html
    build/shell/        head, React 18.3.1, icons, fonts ────┘

    python3 tools/pack-index.py        does both steps

- `Web/` is what goes into the app, whole. The joined files are committed, so
  the repository holds exactly what ships. Nobody edits them by hand.
- Packing is repeatable: the same parts give the same bytes.
  `sh tools/verify-shipped.sh` proves it from a clean export of a commit.
- `sh tools/check-all.sh` fails if a part was edited and pack was not run.
- The Xcode project is generated from `project.yml`. Tor, OpenSSL, libevent
  and xz are built here from signed source releases (`tools/build-tor.sh`)
  and pinned by hash. The Tor transports and libsecp256k1 are built from
  source too.

**From a commit to a phone.** At launch the app hashes the files it loaded
and shows the first twelve characters in its menu. `python3
tools/page-hash.py <commit>` prints the same number from the repository. If
they match, the page on that phone is the page at that commit.

## How it is checked

| | |
|---|---|
| `sh tools/check-all.sh` | the Node suites, the type checks, the smoke checks and the seed's Swift tests; `sh tools/install-hooks.sh` makes it run before every push |
| `tests/*.js` | the wallet and the screens in Node: money paths, lost answers, restore, the Cashu test vectors, every screen drawn and compared |
| `tsc` | type checks over the JavaScript, from its comments |
| `sh tools/unit-tests.sh` | the Swift side: the bridge, the seed, Tor routing, the tap handshake |
| `tools/live/*.js` | two wallets against local CDK and Nutshell mints, with faults injected between them |
| `python3 tools/verify-vendor.py` | every vendored file against its public release |
| `node tools/mutate.js` | breaks the wallet one small change at a time and counts how many the tests notice |

## Where to start reading

- Money: `build/wallet/README.md` lists the parts in order; `MONEY.md` walks
  every path where value moves.
- Protocol: `CASHU-CONFORMANCE.md`, then `TAP-SPEC.md` for what is Foxy's own.
- Security: `REVIEW.md`, which lists each claim beside the test that holds it.
