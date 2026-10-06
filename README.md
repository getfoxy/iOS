# Foxy

A Cashu ecash wallet for iOS that reaches the mint only through its own Tor.

https://github.com/user-attachments/assets/1d70fea1-15a4-4025-b8c2-e4fed4902f87

- **Ecash and Lightning.** Holds ecash from a mint you choose, and pays and is
  paid over Lightning or as ecash.
- **Tor built in.** Every request goes through Foxy's own Tor or is refused,
  unless you choose to continue without it.
- **Tap to pay.** Ecash handed from one phone to another over Bluetooth.
- **Twelve words.** The seed stays in this phone's keychain and is not synced.

Foxy has had one independent code review and no formal audit. **Do not hold in
it what you would not carry in cash.**

## Build

```bash
brew install xcodegen cocoapods go
export LANG=en_US.UTF-8
git clone https://github.com/getfoxy/iOS.git && cd iOS
sh tools/build-iptproxy.sh
xcodegen generate
bash tools/build-tor.sh
pod install
open Foxy.xcworkspace
```

Run it on a phone with iOS 17 or later. What each step does, signing, the
simulator and the checks are in [docs/BUILDING.md](docs/BUILDING.md).

## Documents

- [Overview](docs/OVERVIEW.md): how it reaches the network, and what it leaves out on purpose.
- [Reviewing it](docs/REVIEW.md): a reading order, and every security claim with the test that proves it.
- [Threat model](docs/THREAT-MODEL.md): what it defends against and what it does not.
- [Money](docs/MONEY.md): every path where value moves, and what a kill at each step costs.
- [Cashu conformance](docs/CASHU-CONFORMANCE.md): each NUT, and where Foxy differs.
- [Reporting a vulnerability](docs/SECURITY.md).

The rest are listed in [docs/](docs/README.md).

## Licence

MIT for the code and the documents ([LICENSE](LICENSE)). It does not cover the
artwork, the icons or the fonts, and third-party parts keep their own
licences: [docs/LICENSING.md](docs/LICENSING.md).
