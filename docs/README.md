# The documents

Other files name these by file name alone (`MONEY.md` §3); they are all in
this folder unless a path is given.

**Reviewing Foxy? Start with [REVIEW.md](REVIEW.md)** — a reading order, every
security claim with the test that proves it, and the vocabulary — then
[AUDIT.md](AUDIT.md), a map of where to look and how to check each claim.

## What it is

- [OVERVIEW.md](OVERVIEW.md): what Foxy does on launch, how it reaches the network, and what it leaves out on purpose.
- [ARCHITECTURE.md](ARCHITECTURE.md): one page: the two layers, why the wallet is a web page, how the build works.
- [CODE-MAP.md](CODE-MAP.md): where things are in the repository, the naming, and the table of screens.
- [BUILDING.md](BUILDING.md): building, signing, and the checks to run before trusting it with money.

## Security and money

- [REVIEW.md](REVIEW.md): a reviewer's front door: reading order, claims with their tests, glossary.
- [AUDIT.md](AUDIT.md): a map for verifying: trust boundaries, how the shipped files are made, CI, what is not proven.
- [THREAT-MODEL.md](THREAT-MODEL.md): what Foxy defends against and what it does not.
- [MONEY.md](MONEY.md): every path where value moves, and what a kill at each step costs.
- [SEED-HANDLING.md](SEED-HANDLING.md): the seed, the counters and restore.
- [STORAGE.md](STORAGE.md): every stored key and file, backups, reinstall and wipe.
- [MINT-PRIVACY.md](MINT-PRIVACY.md): what a mint can link, and what Foxy does about each case.
- [NETWORK-TEST.md](NETWORK-TEST.md): how to watch what leaves the phone, and where each call originates.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.

## Protocol

- [CASHU-CONFORMANCE.md](CASHU-CONFORMANCE.md): each NUT, where it is implemented and tested, and where Foxy differs.
- [TAP-TO-PAY.md](TAP-TO-PAY.md): ecash handed between two phones over Bluetooth: the design and its limits.
- [TAP-SPEC.md](TAP-SPEC.md): the tap and offline rules as a short spec, with what it claims and what is known to be weak.
- [UWB-TAP.md](UWB-TAP.md): a design for gating tap to pay on ultra-wideband ranging; not built.
- [CARD.md](CARD.md): a chip card that holds ecash: set-up, the PIN, the daily limit, paying at a till, and what it does not protect against. The card's own side is in https://github.com/getfoxy/card.

## Testing and upkeep

- [DEVICE-TESTS.md](DEVICE-TESTS.md): what only a real iPhone can prove, and how.
- [TOOLCHAIN.md](TOOLCHAIN.md): the compiler and tool versions behind the byte-for-byte rebuild claims.
- [TODO-LATER.md](TODO-LATER.md): work decided on and deferred.
- [LICENSING.md](LICENSING.md): what the MIT licence covers here, and what it does not.

## Beside the code

- [`Web/VENDOR.md`](../Web/VENDOR.md), [`Vendor/README.md`](../Vendor/README.md), [`tools/vendor/README.md`](../tools/vendor/README.md): where the vendored libraries and native code come from, and how to re-verify them.
- [`build/README.md`](../build/README.md), [`tests/README.md`](../tests/README.md): how the page is built, and the test layer.
- [`tools/live/README.md`](../tools/live/README.md), [`tools/live/production.md`](../tools/live/production.md), [`tools/sim/README.md`](../tools/sim/README.md): the live-mint and simulator test runs, and the rules for real mints.
