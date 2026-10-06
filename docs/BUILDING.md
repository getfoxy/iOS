# Building and checking

How to build Foxy, sign it, run it, and run the checks that should pass before
it is trusted with money. The page's own build is in `build/README.md`; the
compiler and tool versions are in `TOOLCHAIN.md`.

## Building it

```bash
brew install xcodegen cocoapods go
export LANG=en_US.UTF-8      # CocoaPods stops without it in a bare shell
git clone https://github.com/getfoxy/iOS.git && cd iOS
sh tools/build-iptproxy.sh    # obfs4 and Snowflake from pinned sources; needs Go 1.25+
python3 tools/smoke.py        # about sixty checks; should end "clean — build it" (SKIPs, counted, are checks that could not look)
xcodegen generate
bash tools/build-tor.sh       # Tor from signed sources, once and after a Tor update (tens of minutes)
pod install                   # Tor.framework's wrapper, with that Tor
open Foxy.xcworkspace
```

`project.yml` links `Vendor/IPtProxy.xcframework`, which is not committed, so
build it before generating the project. Smoke check 15 compares it to
`Vendor/IPtProxy.sha256`.

Install the git hooks once per clone, so the checks run before every push:

```bash
sh tools/install-hooks.sh     # pre-push: tools/check-all.sh, refuses a failing push
```

CI is three workflows in `.github/workflows` (`checks.yml`, `react.yml` and
`tor.yml`). Each runs weekly and can be started by hand; none runs on a push.

**The toolchain these builds were made with** is written down in
`TOOLCHAIN.md`, because "it rebuilds byte for byte" is only true against the
same compiler: Tor's build is reproducible with the same Xcode and gives
different bytes with another. Check yours against it before concluding that a
rebuild disagrees.

## Signing, the simulator and a phone

For the simulator, `sh tools/sim-build.sh` builds signed to run locally, so the
simulator's keychain works. An unsigned build fails every keychain call, which
tests only the path where the keychain fails. Launch it with
`-FoxyKeychainTest YES` to run the keychain self-test.

`project.yml` takes the signing team from the environment, so that no one's
team is in the repository: put `export FOXY_DEVELOPMENT_TEAM=XXXXXXXXXX` in
`local.env` (not tracked) and run `. ./local.env && xcodegen generate`. A team
picked in Xcode's own UI is lost the next time the project is generated. Unset
is fine for the simulator and the tests, which sign nothing. To install under
your own account, change the bundle identifier `io.getfoxi.foxy` in
`project.yml` to one of yours.

Run on a real phone with iOS 17 or later — the first iOS where a request that
cannot reach Tor is guaranteed to fail rather than go around it. The scanner
needs a camera, and Tor starts slowly in the simulator: about 14 seconds there,
traced to slow `timegm` calls that only the simulator has.

What Foxy does on launch, and how it reaches the network, is in `OVERVIEW.md`.

## Before trusting it with money

```bash
python3 tools/smoke.py               # structure, references, crypto, vendor, Tor routing, page policy, the tap radio
npm ci                               # jsdom 29.1.1 and TypeScript 6.0.3, pinned in package-lock.json (test-only)
node tests/run.js                    # wallet tests: proofs, payments, imports, signed quotes, seed and keychain, DLEQ, PIN wait
node tests/nut-vectors.js            # Cashu spec vectors (NUT-00, 01, 02, 10, 11, 12, 18, 20, 26) through the bundled libraries
node tests/cards-logic.js            # the app's cards queue rather than replace one another
node tests/switch-guard.js           # no mint switch while money is moving; a restore waits for its own write
node tests/render-parity.js          # every screen renders the same DOM with build/foxy-render.js as with the runtime it replaced
node tests/p2pk-round-trip.js        # ecash locked to a key only this phone holds, and the money written down before it is touched
node tests/tap-offer.js              # what each screen puts on the air for tap to pay, and which screens may not
node tests/bridge-matrix.js          # every bridge action has the gate THREAT-MODEL.md §1 says it has, and the page asks for no other
sh tools/unit-tests.sh               # Swift unit tests on the simulator: bridge actions and input checks, host rules, answer cap, alert queue, seed rules (after the build steps above)
sh tools/live/local-mint.sh up       # a CDK and a Nutshell mint on this Mac (Docker, fake Lightning, HTTPS on 8443/8444)
NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
  node tools/live/used-counters.js https://127.0.0.1:8443   # swap, receive and signed claim on used counters, then restore
sh tools/live/local-mint.sh down
node tools/foxy-crypto-vectors.js    # SHA-256 (the PIN hash) against the NIST vectors
python3 tools/verify-vendor.py       # the bundled libraries, and the BIP-39 wordlist word for word
sh tools/build-iptproxy.sh --check   # build IPtProxy twice; expect IDENTICAL
```

All of the tests, with smoke, in one command: `sh tools/check-all.sh`.

Then read, in this order: `THREAT-MODEL.md` (what it defends against, and what
it does not), `NETWORK-TEST.md` (what has been seen leaving the phone, and
which design each capture tested), `MONEY.md` (every path where value moves,
and what happens if the app dies mid-step), `MINT-PRIVACY.md` (what a mint
can learn and link, and what Foxy does about each), `STORAGE.md` (what is stored,
what a seed restores, what it does not), `SEED-HANDLING.md`, `Web/VENDOR.md`.
