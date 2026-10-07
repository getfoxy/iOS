# AUDIT.md — where to look, in what order, and how to check it

Foxy is an iOS Cashu ecash wallet. The screens and the wallet logic are web code
in a WKWebView that cannot reach the network; everything that leaves the phone
goes through native Swift, over an embedded Tor. This page is a map for someone
reviewing it: the trust boundaries, where money moves, how the shipped files are
made, and the command that checks each claim. The detail lives in the documents
it points to.

## The boundaries

```
 ┌──────────────── WKWebView (Web/index.html) ────────────────┐
 │  screens: build/app/* + build/markup.html, rendered by      │
 │           build/foxy-render.js                              │
 │  money:   Web/foxy-wallet.js (build/wallet/*) on cashu-ts   │
 │  no network: content rules + page policy; WebRTC removed    │
 └──────────────┬──────────────────────────────────────────────┘
                │ window.webkit.messageHandlers.foxy (main frame, file origin only)
 ┌──────────────▼── native (Foxy/) ─────────────────────────────┐
 │  Bridge/FoxyBridge.swift   every action the page may ask for │
 │  Bridge/NativeSeedBridge   the seed's actions: no words out  │
 │  Network/Route.swift       Tor, or the open network only by  │
 │                            the person's choice, or refused   │
 │  Tor/TorService.swift      embedded Tor (Tor.framework)      │
 │  Tor/Bridges.swift         obfs4 / Snowflake via IPtProxy    │
 │  Keychain/SeedStore.swift  the seed: this device only        │
 └──────────────┬──────────────────────────────────────────────┘
                │ SOCKS, allowFailover = false (iOS 17)
                ▼
            Tor network ──► mints, price feeds, lightning-address servers
```

What crosses each line, and what stops it: `THREAT-MODEL.md`. Every native
network call is sent by `Route.start`, which sends nothing when there is no
route (`Route.available` asks the same first); the page has no network of its own.

## Where money moves — read these first

| Order | Where | What to look for | Written up in |
|---|---|---|---|
| 1 | `build/wallet/02-dleq-lock-holds-imports.js` | the proof lock, held melts and change recovery, imports | `MONEY.md` §2, §5 |
| 2 | `build/wallet/16-sending.js`; `sendToken` is in `19-bill-split.js` | `pay` (the melt's state decides, never the error wording), `sendToken` | `MONEY.md` §2, §3 |
| 3 | `build/wallet/15-receiving.js`; `reconcile` is in `17-backup.js` and `receiveToken` in `19-bill-split.js` | `invoice`, `claim`, sweeps, `reconcile`, quarantine | `MONEY.md` §1, §5 |
| 4 | `build/wallet/00-header-and-mint-errors.js` | used-counter recovery, invalid signatures, signed quotes (NUT-20) | `MONEY.md` §1 |
| 5 | `Foxy/Bridge/NativeSeedBridge.swift`, `Foxy/Keychain/SeedStore.swift`, `CounterStore.swift`, `NUT13.swift`; the page's side in `build/wallet/03-seed-counters-logs.js` | the seed on the phone: the keychain, `seedMigrate`, the counters native keeps, the secrets it derives, the restore window | `SEED-HANDLING.md` |
| 6 | `build/wallet/13-restore.js` | the restore walk, adopting a scan | `SEED-HANDLING.md`, `MONEY.md` §6 |
| 7 | `build/wallet/99-proof-lock-and-export.js` | which functions are inside the lock | `MONEY.md` (top) |
| 7a | `build/wallet/05-paying-this-mint.js` (`shapeOutputs`, `changePlan`), `19-bill-split.js` (`oneIn`, `tidyChange`, `topUpClosing`), `build/app/07-history-tokens-mints.js` (`putAway`) | how a swap's outputs are chosen, the top-up that runs only in the background, a piece left spendable at the Tor close | `MONEY.md` §13 |
| 8 | `Foxy/Bridge/FoxyBridge.swift`, `Foxy/Network/Route.swift` | `mintRequest`, host checks, headers | `THREAT-MODEL.md` |
| 9 | `build/wallet/20-helpers.js` (`_requestPaid`, `claimUnclaimed`), `07-request-delivery.js` | money arriving without anyone tapping anything: what is written before the mint is asked, the P2PK lock, and the order the payer and the person are told in | `MONEY.md` §11 |
| 10 | `Foxy/Bluetooth/` (`TapLink`, `TapSession`, `TapCrypto`, `TapProtocol`), `build/app/26d-tap.js` | ecash crossing between two phones with no network at all: who advertises and from which screen, the handshake and its four digits, and what proximity does and does not promise | `TAP-TO-PAY.md`, `MONEY.md` §12 |

**Four parts are named for something other than what they hold**, because the
parts are joined in name order and a rename would change the join — so the
names are stuck and this table is the fix:

| File | Name says | Also holds |
|---|---|---|
| `build/wallet/19-bill-split.js` | bill splitting | **`receiveToken`**, **`sendToken`**, `exportProofs`, `importProofs`, `tidyChange` |
| `build/wallet/22-screen-lock.js` | PIN, biometrics | **`nativeRequest`** — every mint HTTP call the wallet makes |
| `build/wallet/03-seed-counters-logs.js` | seed, counters, logs | **`bridgeAsk`**, every page→native call, and **`newWallet`** |
| `build/wallet/17-backup.js` | backup | only **`reconcile`**; the backup flags are in `19-bill-split.js` |

What is stored where, how sensitive each key is, and what losing it costs:
`STORAGE.md`. Each folder of parts has a generated table of what every part
defines: `build/wallet/README.md`, `build/app/README.md`.

The screens (`build/app/`, about 17,700 lines) do not touch proofs: they call
`window.FoxyWallet`. They matter for what the person is told — PAYMENT PENDING,
PAID NOT COLLECTED, INVALID SIGNATURES, the seed screens — more than for money.
What a template screen shows is computed in its own render function
(`renderPaid`, `renderSent`, `renderTxDetail` and the rest, in
`build/app/22-` to `27-render-*.js`, gathered by `renderValsBase()` in
`21-render-values.js`; `build/README.md` has the layout). The cards and the PIN pad
are plain DOM, built by `blockedCard` (`11-cards.js`) and `pinOverlay`
(`10-pin.js`). The seed screens, the words and the words typed for a restore, are
native (`Foxy/Bridge/SeedScreens.swift`).

## How the shipped files are made

Each row says which mode of which command proves what. "Offline" runs in every
`sh tools/check-all.sh`, on each push; `--network` and `--deep` are
`python3 tools/verify-vendor.py`'s modes, and the weekly CI vendor job runs
`--deep`.

| Shipped | Made from | Checked by, in which mode, proving what |
|---|---|---|
| `Web/foxy-wallet.js` | `build/wallet/*.js`, joined in name order | Offline: `join-sources.py --check`, the file (and `build/wallet/README.md`) is exactly its parts; `verify-shipped.sh`, the same from a clean export of the commit |
| `build/foxy-app.js` (packed into the page) | `build/app/*.js`, joined in name order | Offline: the same two, with `build/app/README.md` |
| `Web/index.html` | `build/foxy-app.js`, `build/markup.html`, `build/foxy-render.js`, `build/shell/` (the head with the loader and page policy, and the manifest's files: fonts, icons, React), by `tools/pack-index.py` | Offline: smoke check 1 packs into a temporary folder and compares with the tree; `verify-shipped.sh` regenerates it from a clean export of the commit and pins the shell |
| `Web/cashu-ts.js` | esbuild 0.25.0 over `@cashu/cashu-ts@4.11.0` and four @noble/@scure packages, pinned in `tools/vendor/package-lock.json` | Offline: size, hash, the lockfile's six pins, the licence footer. `--network` (`verify-cashu-ts.sh`): the pins against npm, and the bundle rebuilt byte for byte from npm's tarballs. `--deep` (`--from-source`): also every file esbuild read, rebuilt from its git tag |
| `Web/bip39.js` | esbuild 0.25.0 over `@scure/bip39@2.4.0` and `@noble/hashes@2.4.0`, pinned in `tools/vendor/bip39/package-lock.json` | Offline: hash, the wordlist word for word, the three pins. `--network` (`verify-bip39.sh`): the bundle rebuilt from npm's tarballs. `--deep` (`--from-source`): every bundled file from its git tag |
| `Web/qrcode.js` | `qrcode-generator@2.0.4` `dist/qrcode.js`, unmodified | Offline: hash. `--network` and `--deep` alike (`verify-qrcode.sh`; upstream commits the file, so nothing is rebuilt): byte for byte the npm file and the file at tag `js2.0.4` |
| React, ReactDOM (in the page's manifest) | `react@18.3.1`, `react-dom@18.3.1` UMD production files, unmodified | Offline: decoded from the page against pinned hashes (`verify-vendor.py`, `verify-shipped.sh`). `--network` (`verify-react.sh`): byte for byte the npm files. `--deep` (`--rebuild`), and `react.yml`, weekly and on demand: React's release build of its SSH-signed tag `v18.3.1`, byte for byte |
| Tor | Tor 0.4.9.12 with OpenSSL 3.6.4, libevent 2.1.13 and xz 5.8.4, built by `bash tools/build-tor.sh` from commit-pinned, signature-checked tags into `Vendor/TorPod`; Tor.framework 409.11.2's wrapper; recorded in `Vendor/Tor.sha256` | Offline: smoke check 18, the Podfile's code, the podspec, licence, patch, header fixer, keys and wrapper against their pins; the built `tor.xcframework` only where it is built (SKIP on CI). `--network` and `--deep` (`verify-tor.sh`): the pinned commits and their signatures, and the wrapper, patch and header fixer against Tor.framework's tag; no rebuild. `--tor-rebuild`, `build-tor.sh --verify`, and `tor.yml` (weekly and on demand, with Xcode 26.3): a rebuild compared byte for byte |
| IPtProxy (obfs4, Snowflake) | pinned sources | Offline: smoke check 15, only where it is built (SKIP on CI). `--iptproxy` (`verify-iptproxy.sh`), and `checks.yml`'s manual `iptproxy` job: two builds, byte-identical to each other and to `Vendor/IPtProxy.sha256` |
| Fonts, icons, images (`Web/`, `build/shell/assets`) | see `Web/VENDOR.md`, "Fonts, images and icons": what each is, its upstream and licence, or that its origin is not recorded | Offline: each pinned by size and SHA-256 in `verify-vendor.py`, and an unlisted one fails. No mode checks them against an upstream: for most, none is recorded |

What each script proves and does not is in `Web/VENDOR.md`.

Never edit a joined or packed file: `check-all` fails if `Web/foxy-wallet.js`,
`build/foxy-app.js`, `Web/index.html` or a part README differs from what its
parts make. `check-all` writes no tracked file; `python3 tools/pack-index.py`
is the command that writes them.

## Confirming the shipped page is the reviewed sources

```
sh tools/verify-shipped.sh            # the commit HEAD names
sh tools/verify-shipped.sh <commit>   # any other commit
```

It exports the commit with `git archive` into a temporary directory, so nothing
uncommitted and nothing gitignored takes part. In a copy of that export it
deletes `Web/foxy-wallet.js`, `build/foxy-app.js` and `Web/index.html`,
regenerates them with `tools/pack-index.py` (which runs `tools/join-sources.py`
first), and compares each with the committed file byte for byte. Then it prints
the SHA-256 of every file in `Web/`, the folder `project.yml` bundles, so the
list can be compared with the files inside a built `Foxy.app`. `check-all` runs
it; it takes under a second.

It ends with VERIFIED when all three regenerate byte for byte. For the current
hashes, run `sh tools/verify-shipped.sh`: hashes quoted here would be out of
date after the next commit that touches the page or the wallet.

**The shell is regenerated too.** The page's head, with the loader script and
the page policy, its tail, and the manifest's nine files (the renderer, React
and ReactDOM, two SVG icons and four WOFF2 fonts) are committed under
`build/shell/`, and the page is packed from the export alone. Gzipped assets
pack at level 9 with no name or time, so the same files always make the same
page. As a second line, the script still pins what the shell may be:

- the manifest holds exactly nine entries of the expected types and hashes
- one inline script, the loader, pinned by its hash (`5fb1a16f…cb52`, 17,550
  bytes), with exactly the pinned page policy and the bundler's four data
  blocks, `ext_resources` pinned by hash and `page_order` empty

Smoke check 16 checks the policy. The script also says
nothing about a built app: compare its printed hashes with the files in the
`Foxy.app` under test.

## The page on the phone

Everything above looks at the repository. Between a commit and a phone sit a
build machine, a signing step and a delivery, and a page swapped anywhere along
that road looks exactly like the reviewed one from inside the app. This is what
closes that gap, and it takes two numbers being the same:

```
python3 tools/page-hash.py <commit>   # the commit you reviewed
```

and on the phone, MENU → the small grey line at the foot of the drawer,
`page` and twelve hex digits (the hash differs with every change to `Web/`).
Those twelve characters are the start of what the tool prints. If they match, the page that phone is running is the page in this
repository at that commit.

**What the number is.** `FoxyWebView.stageWebFiles` copies the app bundle's
`Web/` folder into the app's web directory at launch — the only folder the web
view may load from — and `FoxyWebView.manifestHash` then hashes what it staged.
One line per file, `<sha256 of its bytes>␠␠<name>`, sorted by name as bytes,
names beginning with a dot left out; the manifest hash is the SHA-256 of those
lines joined. The name is hashed with the content, so a file added, removed or
renamed changes the number even when no file's content changed. It is the format
`shasum -a 256` prints, so anyone can recompute it without either program:

```
( cd Web && ls | grep -v '^\.' | LC_ALL=C sort | tr '\n' '\0' \
    | xargs -0 shasum -a 256 ) | shasum -a 256
```

That rule is written down in `tools/page-hash.py`'s header; the Swift follows
it, and smoke check 41 holds the two sides together — that the app still hashes
the folder it staged, by that rule, and still hands the result to the page.

**With a build.** `sh tools/sim-build.sh` prints the built app's page hash on
stderr, over `Foxy.app/Web` rather than the tree
(`python3 tools/page-hash.py --dir <app>/Web`), so a build records the page it
carries. The app prints the same number at launch, in groups of sixteen:
`[foxy] page hash <16 hex> <16 hex> …`. Grouped because
`DebugLog` hides runs of 64 hex characters — that shape is a key or a seed in
this app's logs — and a redacted line could not say which page ran;
`tools/page-hash.py` prints the same grouping under the plain digest.

**What it does not prove.** It covers the page: every byte of HTML, JavaScript,
font and image the web view loads. It says nothing about the native binary
around it. Tor, the bridge, the keychain and the seed screens are compiled
Swift, and no number here covers them. Nor does it say the page is *good* — only
that it is the page whose sources `verify-shipped.sh` and `verify-vendor.py`
check. The chain is: sources → generated files (`verify-shipped.sh`) → vendored
bytes (`verify-vendor.py`) → the folder that ships → the folder the app staged
(this) → the screen.

## Continuous checks

**The gate is a git hook on the machine that makes the commit.**
`tools/hooks/pre-push`, installed by `sh tools/install-hooks.sh`, runs
`sh tools/check-all.sh` before anything is pushed and refuses the push if it
fails; `FOXY_PUSH_SWIFT=1` adds the simulator Swift tests, and
`git push --no-verify` is the deliberate way past it. This is the per-push
enforcement: the three workflows in `.github/workflows` (`checks.yml`,
`react.yml` and `tor.yml`) have no push or pull-request trigger, so that they do
not read as coverage they are not providing. They run weekly and on demand.

**Read this before trusting anything below to have run.** There is no push
trigger. `.github/workflows/checks.yml` fires on a weekly cron and on demand
only (`on: schedule + workflow_dispatch`), and its `checks` and `native` jobs
are gated on `push || pull_request || workflow_dispatch` — none of which a cron
satisfies — so **on the weekly run only the `vendor` job fires**. Everything
else is on demand, or on the machine of whoever is working: `tools/hooks/pre-push`
runs `check-all.sh` locally on every push, and that is the real per-push gate.

`.github/workflows/checks.yml` runs `sh tools/check-all.sh` and
`sh tools/verify-shipped.sh` on `macos-latest` when it is asked to,
after `npm ci` installs jsdom 29.1.1, TypeScript 6.0.3 and their dependencies
from the root `package-lock.json` (test-only; nothing in it ships). Two of
smoke's checks cannot look there, since CI builds neither IPtProxy nor Tor:
checks 15 and 18 print SKIP for those parts, and smoke's summary counts them. A
weekly and manual job runs `python3 tools/verify-vendor.py --deep` (not on
push). A manual job, with the `iptproxy` input set, rebuilds IPtProxy.
`.github/workflows/tor.yml` rebuilds Tor with `bash tools/build-tor.sh --verify`
on GitHub's macOS 26 image with Xcode 26.3 (17C529), weekly and on demand, and
fails unless the result is VERIFIED. `.github/workflows/react.yml` rebuilds
React and ReactDOM from React's signed tag on Linux, weekly and on demand.

An on-demand-only `simulator` job runs `sh tools/unit-tests.sh` (the workflow's
own comment says so: "simulator on demand only"). In practice these run when
somebody types `sh tools/unit-tests.sh` on a Mac — which is worth knowing,
because it is how a red test in this half can sit unnoticed: `BridgeTests`
once went red when two bridge actions were added to THREAT-MODEL's table and
not to its list. It is the half of
the Swift tests that need Foxy.app on an iOS simulator, which the `native` job
cannot build: `BridgeTests`, `NativeSeedTests`, `RouteTests`, `SeedScreenTests`,
`CounterRangeCheckTests`, `AnswerCapTests`, `PromptQueueTests` and
`NativeRulesBridgeTests`. Foxy links Tor, so the app cannot build without it and
`Vendor/TorPod/tor.xcframework` is not in the repository: the job builds it from
source on a cache miss (hours) and restores it after, keyed on the files that
decide its bytes. It does not take the cache's word for what it restored — smoke
check 18 hashes the framework against `Vendor/Tor.sha256`, and the job fails if
that check could only SKIP. It is on demand rather than on push for the same reason.
The other simulator scripts (`tools/sim/`) still run only on a Mac, by hand.

**Those workflows run only where the repository is on GitHub with Actions
enabled, and only weekly or on demand.** Results quoted here are from local
runs — which, through the hook, is where every push's results come from.

## Checking the claims

```
sh tools/check-all.sh                 # everything below that needs no simulator or network
sh tools/verify-shipped.sh            # from a clean export: the generated files regenerate byte for byte
python3 tools/join-sources.py --check # the shipped wallet and app, and the part READMEs, are exactly their parts
python3 tools/smoke.py                # structure, page policy, Tor routing, IP-leak protections, no duplicate methods; writes nothing, counts SKIPs
node tests/run.js                     # wallet behaviour against a stub mint
node tests/interleave.js              # the money operations in random schedules, against faults and refused writes; --seed N replays one
node tests/bridge-matrix.js           # what THREAT-MODEL.md §1 says each bridge action needs, against the handler that implements it, and that the page asks for no action no handler serves
node tests/render-parity.js           # every screen renders as it did under the old runtime
node tests/render-snapshots.js        # 206 views of every screen, card and dialog, byte for byte as recorded
node tests/p2pk-round-trip.js         # ecash locked to a key only this phone holds, made, refused to others, claimed, and written down before it is touched
node tests/tap-offer.js               # what each screen offers a tap, and which screens may not go on the air at all
node tests/nut-vectors.js             # Cashu spec vectors through the shipped cashu-ts
node tests/nut13-vectors.js           # seed derivation vectors, and the native derivation's cross-check fixture rederived
node tests/fuzz-parsers.js            # the wallet's readers of untrusted text, under hostile input
node node_modules/typescript/bin/tsc -p tests/types   # the wallet's type check (TypeScript 6.0.3, pinned)
node node_modules/typescript/bin/tsc -p tests/types/tsconfig.app.json   # the app class and its render functions
node tests/type-check-finds.js        # what the app's type check found stays fixed
python3 tools/verify-vendor.py        # vendored libraries, the BIP-39 wordlist, fonts, images and test-only files, offline
python3 tools/verify-vendor.py --network  # network: each library against its npm, git or GitHub release
python3 tools/verify-vendor.py --deep     # and rebuilt from source: cashu-ts and bip39 from git, React from its signed tag
bash tools/build-tor.sh --verify      # Tor rebuilt byte for byte (hours; Xcode 26.3)
sh tools/vendor/verify-iptproxy.sh    # IPtProxy reproduces the committed checksums (Go, several minutes)
swift test --package-path tools/nativetests   # the native seed in Swift: NUT-13, BIP-39, the counters, and the rules tests/harness.js answers by
sh tools/unit-tests.sh                # simulator: Swift unit tests (FoxyTests): the bridge's action table and input checks, host rules and approvals, the 4 MB answer cap, the alert queue, the seed rules and seed actions (seedMigrate included), the counter store, NUT-13 derived natively
sh tools/sim/keychain.sh              # simulator: the seed in the keychain (tools/sim/README.md for the rest)
sh tools/live/local-mint.sh up        # local CDK and Nutshell mints in Docker, fake money (tools/live/)
```

## What holds each claim

The list above is what you can run. This is what each claim in these documents
actually rests on, which is not the same thing. Three kinds of evidence appear,
and the difference between them is the point of the table: a check that **runs on
every push**, a check that **runs somewhere else** (a Mac with a simulator,
Docker, a phone) and so can be months stale, and a claim that rests on **someone
having read the code**, which is where a reviewer's time is worth most.

| claim | stated in | what holds it | when that runs |
|---|---|---|---|
| The shipped page and wallet are the sources in `build/` | `build/README.md`, "How the shipped files are made" above | `join-sources.py --check`; `verify-shipped.sh` from a clean export of HEAD; smoke 1 | every push |
| The page runs no script it did not ship | `THREAT-MODEL.md` §1 | smoke 16 | every push |
| The page on a phone is the page in this repository | "The page on the phone" above | smoke 41 (the app still hashes what it staged, by the same rule, and still tells the page); the comparison itself is a person reading the drawer against `python3 tools/page-hash.py <commit>` | every push (the code); **by hand, on a phone** (the comparison) |
| The bridge exposes exactly these actions | `THREAT-MODEL.md` §1 | `FoxyTests/BridgeTests.swift` | **on demand** (the `simulator` job), and by hand on a Mac |
| What each action needs before it acts | `THREAT-MODEL.md` §1, the table | `tests/bridge-matrix.js`, both ways | every push |
| Only the main frame of a `file:` page is answered | `THREAT-MODEL.md` §1 | `bridge-matrix.js` (the guard is still there); `BridgeTests` (it behaves) | every push; simulator |
| The words never cross the bridge | `SEED-HANDLING.md`, `THREAT-MODEL.md` §1 | `native-seed-app.js`, `backup-logic.js`, `run.js`'s "seed on the phone"; `NativeSeedTests` | every push (the page's side); simulator (native's) |
| The native seed's rules: windows, caps, one import, capped moves | `SEED-HANDLING.md`, `tests/fixtures/native-rules.json` | `NativeRulesTests` (what `Foxy/Keychain` owns); `NativeRulesBridgeTests` (what `Foxy/Bridge` owns; 4 assertions, on a simulator); the phone mock answers by the same file | every push (Keychain half); simulator (Bridge half) |
| The seed's keychain rules: this device only, the person on every read, never written over | `SEED-HANDLING.md`, `STORAGE.md` | `FoxyTests/SeedVaultTests.swift` | every push |
| NUT-13 derivation is cashu-ts's, byte for byte | `CASHU-CONFORMANCE.md` | `nut13-vectors.js`; `NUT13Tests` against `fixtures/nut13-cross.json` | every push |
| A payment request's lock key is the seed's, at NUT-13's P2PK path, with a non-hardened last level | `CASHU-CONFORMANCE.md`, `SEED-HANDLING.md` | `P2PKTests` against BIP-32's own vector 1 and a second implementation in `harness.js`; `p2pk-round-trip.js` opens a token on another device from the words alone | every push |
| Cashu conformance, NUT by NUT | `CASHU-CONFORMANCE.md` | `nut-vectors.js` (140 checks) | every push |
| It works against real mints, including faults | `CASHU-CONFORMANCE.md` | `tools/live/flows.js`, `faults.js`, `cross-wallet-restore.js` against CDK and Nutshell | **by hand, with Docker** |
| The books balance after every operation | `MONEY.md` | `run.js` (212) with `invariants.js`; `interleave.js` (80 schedules) | every push |
| Two money operations cannot overlap | `THREAT-MODEL.md`, finding 8 | `interleave.js` (the lock's depth, and the ledger); smoke 12 | every push |
| Every request goes through Tor or is refused | `THREAT-MODEL.md` §4 | `gate-scenarios.js`; smoke 14 (no socket native cannot route), smoke 17 (iOS 17, no proxy dictionary, no fail-over); `RouteTests` | every push; simulator. A packet capture on a phone (`DEVICE-TESTS.md` §21a) saw no mint or price hostname; its control run is not done |
| Mint addresses are https, or http only for `.onion`, and never LAN, loopback or an IP literal | `THREAT-MODEL.md` §4 | `RouteTests`; the mint-URL cases in `run.js` | simulator; every push (the page's half) |
| The vendored libraries are upstream, and rebuild from source | `Web/VENDOR.md` | `verify-vendor.py`; `--network`; `--deep` | every push (offline); **weekly** (rebuilds) |
| Tor is built from signed sources, reproducibly | `Vendor/README.md` | `build-tor.sh --verify`; `.github/workflows/tor.yml` | **weekly, and by hand** |
| IPtProxy reproduces its committed checksums | `Vendor/README.md` | `verify-iptproxy.sh` | **manual only** |
| Every screen draws what it drew | `build/README.md` | `render-snapshots.js` (206 views); `render-parity.js` (33) | every push |
| Release builds log nothing: `print` is a no-op, the page's `console` is replaced, and the mirror installs only where `FOXY_DEBUG` is set | `THREAT-MODEL.md`, finding 16 | smoke 35 (the code is there and behind the right fence); `tools/sim/release-silence.sh` launches a Release build with every Debug flag and counts what it printed | every push (static); **by hand on a simulator** (the real thing) |
| The app-switcher cover, and third-party keyboards refused | `THREAT-MODEL.md` | smoke 17c checks the code is there | every push; **never observed running** |
| A packet capture shows what leaves the phone; Orbot end to end; the device checklist | `NETWORK-TEST.md`, `DEVICE-TESTS.md` | by hand | **partly**: one capture is done (`DEVICE-TESTS.md` §21a, without its control run); Orbot end to end and most of the checklist are not (`DEVICE-TESTS.md`, Part 2) |
| Ecash can be locked to the phone that asked for it, and nobody else can claim it | `CASHU-CONFORMANCE.md` (NUT-10/11), `MONEY.md` §11 | `p2pk-round-trip.js` end to end against a stub mint; the claim guards in `run.js` | every push. **Never yet run against a real mint that enforces NUT-11** |
| Only a receiver's own invoice screen puts a radio on the air (by itself, or on a press of TAP with AUTO TAP TO PAY off), and the payer never does | `TAP-TO-PAY.md`, `THREAT-MODEL.md` §12 | `tap-offer.js` checks the arming; smoke 43 reads the page for the call and `TapLink.swift` for both sides' guards | every push. The roles have been both ways round and this has been wrong in each; neither check existed the first time |
| The handshake is what it says: committed keys, one payer, a code over the whole offer | `TAP-TO-PAY.md` | `TapProtocolTests`, `TapSession` run against itself with no radio | simulator |
| What a listener beside two tapping phones actually sees | `TAP-TO-PAY.md`, `THREAT-MODEL.md` §12 | `DEVICE-TESTS.md` §22b, with a scanner on a third phone | **by hand, observed once**: one service per tap, no name, nothing readable. What iOS itself serves to a connection is not Foxy's, and is reasoned from CoreBluetooth rather than observed |

Two things worth knowing about that "when":

- **Most of the Swift tests never run in CI.** The `native` job runs the package
  (`tools/nativetests`), which builds `Foxy/Keychain` alone: 113 tests. The
  simulator suite runs 382 — all of `FoxyTests`, with everything that needs
  `Foxy.app` compiled in: `BridgeTests`, `NativeSeedTests`, `RouteTests`,
  `SeedScreenTests`, `CounterRangeCheckTests`, `AnswerCapTests`,
  `PromptQueueTests`, `NativeRulesBridgeTests`, and the tap, Nostr, onion, Orbot
  and Tor-seed tests. An on-demand `simulator` job runs them, building Tor from
  source the first time; on push they do not run, so they are as fresh as the
  last time someone ran `sh tools/unit-tests.sh` on a Mac. That is why
  `tests/bridge-matrix.js` reads the sources as text: it runs on every push.
- **A row that says "by reading" is not a failing.** Some claims are not
  mechanically checkable, and saying so is better than a check that only appears
  to cover them. It is, though, exactly where reading pays.

## What is not proven yet

- **On a real iPhone:** the packet capture's control run, which shows the method
  can see a leak (`NETWORK-TEST.md`, `DEVICE-TESTS.md` §21a), Orbot mode end to
  end, and most of the checklist in `DEVICE-TESTS.md` (its Part 2 says which
  sections have been run). The simulator showed hostnames reaching Tor with
  SafeSocks on; a device is a different stack.
- **The app-switcher cover and the refusal of third-party keyboards** are in the
  code and guarded by smoke check 17c, but neither was observed on the simulator.
- **Sending other units** than sats is not built: they are restored, received and shown, but every send path is sats only (`TODO-LATER.md`).
- **cashu-ts** is 4.11.0, the current stable release (5.0 is in release
  candidates). The shipped bundle rebuilds
  byte for byte from its git tag and pinned dependencies, and cashu-ts's own
  unit suite passes 2,524/2,524 at that tag; run against the shipped bundle
  itself, 2,444 pass and the rest fail on test-harness mixing, not bundle
  behaviour (`tools/vendor/README.md`). Upstream correctness is upstream's.
- **Tor is built here, but the toolchain is trusted.** `tools/build-tor.sh`
  builds Tor and its libraries from signed, commit-pinned tags, and a rebuild
  with the same Xcode and autotools gives the same bytes. The autotools are GNU's signed
  releases, built here by `tools/build-autotools.sh`, not Homebrew's. That
  does not show Xcode's compiler is honest, and a different Xcode version gives
  different bytes. Tor still runs in the app's process.
- **Where most of the fonts, icons and images came from is not recorded.**
  Sora and Figtree are identified by their own name tables (SIL OFL 1.1). The
  SatSymbol font, the two "Flash bolt" icons and the artwork in `Web/` (the
  sprite sheets, the fur textures, the intro video and its stills) carry no
  author or licence; two of the images carry a C2PA manifest that says only
  that the file passed through Claude's file handling, and the four GET DOLLARS
  icons are other companies' trademarks, used to name their apps. Each is
  pinned by hash (`Web/VENDOR.md`, "Fonts, images and icons").
- **The native binary a person installs is not checked against these sources.**
  The page now is: the app hashes the files it staged and shows the first twelve
  characters at the foot of the menu drawer, and `python3 tools/page-hash.py`
  prints the same number (below, "The page on the phone"). Nothing does the same
  for the Swift around it. Tor, the bridge, the keychain and the seed screens are
  compiled, and no number on any screen covers them: a phone whose page hash
  matches is running the reviewed page inside a native app still taken on trust.
- **The on-chain claim has no live fault coverage.** `tools/live/faults.js
  onchain` covers the payout side against a real mint; the receiving side needs
  a real on-chain deposit to a real address, which no fake-money mint provides.
  The state machine is covered deterministically (`tests/onchain-faults.js`).
- **qrcode.js is checked against its published file, not rebuilt:**
  `qrcode-generator` commits its `dist/qrcode.js` rather than generating it in
  a build this repo runs. React and ReactDOM are rebuilt from React's signed tag
  (`verify-react.sh --rebuild`); that still trusts the Java,
  Node and npm packages React's lockfile names.

## The documents

| Document | About |
|---|---|
| `THREAT-MODEL.md` | adversaries, boundaries, what each protection stops, known limits |
| `MONEY.md` | every path money takes, what is written when, what a crash at each step costs |
| `CASHU-CONFORMANCE.md` | each NUT: implemented, partial, refused or absent, where and how tested; where Foxy differs from Nutshell, CDK and cashu-ts; live results against both mints |
| `STORAGE.md` | every stored key, its sensitivity, what losing it costs |
| `SEED-HANDLING.md` | the seed on the phone: generation, storage, the bridge's seed actions, counters, moving an install, restore, compatibility with other wallets |
| `MINT-PRIVACY.md` | what a mint can link, and what Foxy does about each case |
| `NETWORK-TEST.md` | how to watch what leaves the phone, and where each call originates |
| `TAP-TO-PAY.md` | ecash handed between two phones over Bluetooth: the design and its limits |
| `DEVICE-TESTS.md` | what only a real iPhone can prove, and which of it has been run |
| `TODO-LATER.md` | decided and deferred work |
| `TOOLCHAIN.md` | the compiler and tool versions behind the byte-for-byte rebuilds |
| `Web/VENDOR.md`, `Vendor/README.md`, `tools/vendor/README.md` | where every bundled library and native component came from, and how it is checked |
| `REVIEW.md`, `docs/README.md` | the reviewer's front door, and the index of every document |
