# Vendor

## IPtProxy.xcframework — obfs4 and Snowflake for Foxy's Tor

Not committed. Built from source by `tools/build-iptproxy.sh`; what is committed
is `IPtProxy.sha256`, and `tools/smoke.py` fails if the framework on disk does
not match it.

    sh tools/build-iptproxy.sh           # build it
    sh tools/build-iptproxy.sh --check   # build twice, expect IDENTICAL

Pinned:

| | |
|---|---|
| IPtProxy | `d25ce337c619b5f70ca2cf460f441b2a39a58aa6` (5.5: Lyrebird `fc105a03`, Snowflake 2.14.1) |
| dnstt | `f1b9b97a269f83bad41d2ceef291b4d2c161cd11` |
| gomobile / gobind | `golang.org/x/mobile v0.0.0-20260908204917-8b95e45f8d3e` |
| Go | 1.25 or later (built here with 1.27.1) |

Reproducible because the script fixes the work and temporary paths, zeroes
archive dates (`ZERO_AR_DATE=1`), maps C source paths and strips the Go build
id. Two builds are byte-identical.

Why not the CocoaPods binary: transports run in the wallet's process, and a
binary nobody can rebuild is the property `Web/VENDOR.md` exists to rule out.

The built-in bridge lines in `Foxy/Tor/Bridges.swift` are the Tor Project's, first
taken from IPtProxyUI (MIT, Guardian Project) at commit `f764d6f`. They sit
between `BEGIN BUILT-IN BRIDGES` and `END BUILT-IN BRIDGES` markers with the date
they were fetched. `python3 tools/update-bridges.py` compares them with the Tor
Project's current list, and `--write` replaces them. Smoke check 19 reports
their age.

## Tor — built here from signed sources

Tor's C library, with the OpenSSL, libevent and xz it is built with, is built
here by `tools/build-tor.sh` into `Vendor/TorPod/tor.xcframework`, which is not
committed. CocoaPods takes Tor from `Vendor/TorPod`
(`pod 'Tor', :path => 'Vendor/TorPod'`): Tor.framework's Objective-C wrapper,
and no download. Tor used to be the Tor.framework maintainer's prebuilt
release binary, which nothing here could check against its source.

    bash tools/build-tor.sh             # build it (tens of minutes), then pod install
    bash tools/build-tor.sh --verify    # rebuild and compare with Tor.sha256
    bash tools/build-tor.sh --sources   # check the sources only

Committed:

| | |
|---|---|
| `Tor.sha256` | the build: the SHA-256 of the xcframework's full listing, both `tor` binaries, the wrapper's files, the sources and the toolchain; and every other file in `TorPod`: the podspec, `LICENSE`, the patch, the header fixer and the keys |
| `TorPod/Tor.podspec` | Tor.framework 409.11.2's podspec, with no `prepare_command` |
| `TorPod/LICENSE` | Tor.framework's MIT licence, which the podspec names |
| `TorPod/Tor/Classes` | the Objective-C wrapper, from Tor.framework commit `727f628a` (tag v409.11.2) |
| `TorPod/mmap-cache.patch`, `TorPod/fix_includes.pl` | Tor.framework's patch (upstream tor#40832, memory-mapping the microdescriptor journal) and header fixer, from that commit, pinned by SHA-256 in `build-tor.sh` |
| `TorPod/keys` | the keys the source tags and GNU's tarballs must be signed with |

Smoke check 18 compares all of it with `Tor.sha256` on every `check-all`,
fails on a file in `TorPod` that the file does not list, and pins the
Podfile's code (its comments aside) by hash, so a second pod, a script phase or
a change to the `post_install` hook is a deliberate edit; `Podfile.lock` may
name no pod but Tor. `build-tor.sh --verify` and `--sources` check the pod's
files first. Where `tor.xcframework` is not built, as on CI, check 18 says
SKIP for the build comparison and smoke counts it.

Each source is the commit its annotated tag names, and the tag's signature must
be valid and come from the pinned key:

| source | tag | commit | signed by (primary key) | key taken from |
|---|---|---|---|---|
| Tor | `tor-0.4.9.12` | `78923280eed3` | David Goulet, `B744 17ED DF22 AC9F 9E90 F491 42E8 6A2A 11F4 8D36` | keys.openpgp.org; the fingerprint is on Tor's own page (support.torproject.org, verify-little-t-tor) |
| OpenSSL | `openssl-3.6.4` | `d3c1b1169b35` | OpenSSL, `B146 647E 45A7 B339 47AB 226B 2A2C 87D1 6169 2D40` | openssl-library.org/source/pubkeys.asc; also in OpenSSL's `doc/fingerprints.txt` |
| libevent | `release-2.1.13-stable` | `79ddfb460847` | Nick Mathewson, `2133 BC60 0AB1 33E1 D826 D173 FE43 009C 4607 B1FB` | keys.openpgp.org; the fingerprint is on Tor's page (he signs Tor releases), and he published libevent's GitHub release |
| xz | `v5.8.4` | `d3e650e63c11` | Lasse Collin, `3690 C240 CE51 B467 0D30 AD1C 38EE 757D 6918 4620` | tukaani.org/misc/lasse_collin_pubkey.txt |

The build is arranged to make the same bytes every time: no bitcode (its
embedded command lines carried the build folder), no debug info, fixed install
prefixes, zeroed archive dates (`libtool -D`), `SOURCE_DATE_EPOCH=0`, and one
fixed build folder, `/private/tmp/foxy-tor-build`, because OpenSSL writes its
compiler command line into the library. Only iOS arm64 and the arm64 simulator
are built. The xcframework's Info.plist is written by the script, since
xcodebuild orders its slices differently from run to run. The same Xcode and
autotools give the same bytes; `Tor.sha256` names the ones used.

Two builds from scratch on one Mac matched byte for byte. GitHub's first
rebuilds did not, and their `config.log` showed why: OpenSSL records its
compiler's path, and Tor its configure line, and the runner's Xcode lived at
`Xcode_26.3.app`. The script now reaches Xcode through a fixed link, configures
with only the system's tools on PATH, and copies sources with their times. The
recorded build is `8cc5d7e9…`, and GitHub's Mac, with its own Xcode 26.3 at
another path and its own Homebrew, rebuilds it byte for byte (`tor.yml`). The
top of `tools/build-tor.sh` lists every difference from Tor.framework's own
`build-xcframework.sh`.

**What the build takes from the machine.**
Every configure, make and autogen step, and the header fixer and `libtool`,
runs under `env -i` with only `PATH` (the system's tools, and the autotools for
autogen), an empty `HOME` and `TMPDIR` in the build folder, `SHELL=/bin/sh`,
`LC_ALL=C`, `TZ=UTC`, `ZERO_AR_DATE=1`, `SOURCE_DATE_EPOCH=0`, and
`DEVELOPER_DIR` if the caller set it (it chooses the recorded Xcode).
`CONFIG_SITE`, `CPPFLAGS`, `PERL5OPT`, `MAKEFLAGS` and the rest of a shell's
environment no longer reach them; `build-autotools.sh` does the same for GNU's
tools and reads no `~/.curlrc`. git runs with `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null` and no `GIT_*`
variable from the caller, so an `insteadOf` or a hook in the user's git config
plays no part in a clone. A rebuild with these changes (autotools rebuilt from
GNU's tarballs under `env -i` too), `bash tools/build-tor.sh --verify`, gives
VERIFIED, `8cc5d7e9…`, the recorded bytes. GitHub's Mac does the same with its
own Xcode 26.3 and its own autotools.

**gpg is the one tool still taken from the caller's PATH**: Homebrew's on a Mac
(GnuPG 2.5.21 when it was checked) and on GitHub's runner. Each import and verify runs with a fresh, empty `GNUPGHOME`
(one for all four source tags, one per GNU tarball), whose agents are stopped
before it is removed, so no keyring, `gpg.conf` or key server of the user's is
consulted. gpg only decides whether a signature verifies; a gpg that lied
would still meet the pinned commits and tarball hashes, and nothing it does
reaches the bytes. Building gpg from source as well was not done.

What this does not establish: that Xcode's compiler is honest, or that Tor's
source has no bugs. What it removes is the
maintainer's build machine from what Foxy has to trust.

A second machine narrows that further. `.github/workflows/tor.yml` runs the
same `--verify` on one of GitHub's Macs, with its own copy of Xcode 26.3
(17C529, checked before building) and its own build of the autotools, weekly
and on demand. VERIFIED there means the build Mac added nothing of its own:
a tampered Xcode or autotools on that one machine would have made different
bytes. It still trusts Apple's Xcode itself, as every iOS app does.

The autotools that generate Tor's, libevent's and xz's build scripts are not
Homebrew's. `tools/build-autotools.sh` builds them from GNU's
release tarballs, each pinned by SHA-256 and checked against its maintainer's
key (from ftp.gnu.org/gnu/gnu-keyring.gpg, in `Vendor/TorPod/keys`), into the
fixed prefix `/private/tmp/foxy-autotools`, with only the system's tools on
PATH:

| tool | version | signed by (primary key) |
|---|---|---|
| m4 | 1.4.21 | Eric Blake, `71C2 CC22 B1C4 6029 27D2 F3AA A7A1 6B4A 2527 436A` |
| autoconf | 2.73 | Zack Weinberg, `82F8 54F3 CE73 174B 8B63 1740 91FC C32B 6769 AA64` |
| automake | 1.19 | Kamila Szewczyk, `6C22 2EA6 B2BD 216A A406 516A C868 F0B6 DE38 409D` |
| libtool | 2.6.2 | Ileana Dumitrescu, `FA26 CA78 4BE1 8892 7F22 B99F 6570 EA01 146F 7354` (see below) |
| gettext | 1.0 | Bruno Haible, `E0FF BD97 5397 F77A 32AB 76EC B630 1D9E 1BBE AC08` |

**libtool 2.6.2's signature postdates its key's expiry.** It was signed on
2026-07-16 by a key that GNU's keyring, keys.openpgp.org and
keyserver.ubuntu.com all show as expired on 2026-03-07, never renewed in public.
The signature itself is valid, and the likeliest story is a
renewal the maintainer never published, but by the public record the key was no
longer in force. `build-autotools.sh` accepts that tarball only at its pinned
SHA-256, `2ef1067c…e191e`, which is also the hash Homebrew pins for it; any other
signature made after its key expired stops the build. Asking the libtool
maintainers to publish the renewed key would remove the exception.

Two things are done as Homebrew does, because the build scripts depend on them:
libtool is installed as `glibtool` and `glibtoolize`, and `autoreconf` calls
`glibtoolize`.

Building with these tools made the recorded tor.xcframework byte for byte
(`8cc5d7e9…`, both tor binaries included): only the toolchain line in
`Vendor/Tor.sha256` changed, from Homebrew's `autopoint` to this one. GitHub's
Mac builds the autotools from GNU's signed tarballs and rebuilds
tor.xcframework to the same `8cc5d7e9…`.

Updating: move a pin in `build-tor.sh` (tag, commit, signer), run `--sources`,
then build and `pod install`. `tools/vendor/check-tor-fresh.sh`, in the weekly CI
vendor job, fails when a newer release of a pinned series ships.

## secp256k1 — libsecp256k1, for NUT-13 secrets derived natively

Foxy derives the page's NUT-13 secrets in Swift, in every build
(THREAT-MODEL.md §1, SEED-HANDLING.md), in `Foxy/Keychain/NUT13.swift`, for
`counterReserve`, `counterReserveAt` and `restoreSecrets`. It started as a
Debug-only prototype behind a launch flag; the library is now in every Release
build. BIP-32's non-hardened step needs secp256k1 point
arithmetic. That comes from Bitcoin Core's libsecp256k1, never from code of
Foxy's own. It is committed as source and compiled into Foxy.app, and so into
the unit tests' host, by `project.yml`. Nothing is fetched or prebuilt: after a
change to project.yml, `xcodegen generate`, then `pod install`, as always.

| | |
|---|---|
| release | v0.8.0, the latest tag when it was vendored |
| tag object | `18f07c42218765cd46148d74d9fe575795f56dce` |
| commit | `6e2c8bc4ecdc6e71dbe7a368f360d8d453ce435d` (2026-08-03, "release: prepare for 0.8.0") |
| signed by (primary key) | Sebastian Falbesoner (theStack), `6A8F 9C26 6528 E25A EB1D 7731 C237 1D91 CB71 6EA7` |
| key taken from | bitcoin-core/guix.sigs, `builder-keys/theStack.gpg`; keys.openpgp.org serves the same primary key |
| files | `Vendor/secp256k1.sha256`: the SHA-256 of each file, and of the whole listing (`10c47b5e…`) |

How it was checked:

- **The tag's signature verifies.** gpg 2.5.21, with a fresh, empty `GNUPGHOME`
  holding only that key, reports a good signature (`VALIDSIG 6A8F9C26…`) over
  the tag object, rebuilt byte for byte from `git cat-file tag v0.8.0`, whose
  SHA-1 is the tag's id `18f07c42…`. GitHub's API reports the same tag,
  pointing at the same commit, with its signature verified.
  `tools/vendor/verify-secp256k1.sh` makes the same check with git's own
  `verify-tag`.
- **The files are the commit's.** The git blob id of each vendored file matches
  the one GitHub lists for it in commit `6e2c8bc4`'s tree (52 of 52).
- **What the key rests on.** Sebastian Falbesoner is a libsecp256k1 maintainer
  and signed the release; the key is the one Bitcoin Core's guix.sigs lists for
  him. No key Foxy already trusts has signed it, so gpg shows its validity as
  unknown, as it does for the Tor keys above.

What is vendored: `src/secp256k1.c`, the precomputed tables
`src/precomputed_ecmult.c` and `src/precomputed_ecmult_gen.c`, the 48 headers
they include when built for arm64 with the modules below (listed with
`clang -MM`), and `COPYING` (MIT) — 52 files, which is what
`Vendor/secp256k1.sha256` lists and smoke check 31 holds it to.

**Three optional modules are vendored and compiled in**, under
`src/modules/`: **ecdh** (the shared point NIP-44 hashes), **extrakeys** and
**schnorrsig** (BIP-340, which signs a Nostr event) — all three for
`Foxy/Nostr`, and each switched on by an explicit
`-DENABLE_MODULE_…=1` in `project.yml`.

Not vendored: the remaining optional modules (recovery, MuSig, ElligatorSwift,
silent payments), the tests, benchmarks, table generators and build systems. The
defines are written out in project.yml: `ECMULT_WINDOW_SIZE=15` and the
source's fallback comb table (11/6, 22 KiB), `COMB_BLOCKS=11`, `COMB_TEETH=6`,
with `-O2`. Upstream's own builds default to a larger comb table (43/6); both
are constant-time, and the vendored `precomputed_ecmult_gen.c` holds tables for
both. tools/nativetests compiles the same three files with the same defines.
`Vendor/CSecp256k1/module.modulemap` is Foxy's own file; it lets Swift import
the header.

`Foxy/Keychain/NUT13.swift` calls `secp256k1_ec_pubkey_create`,
`secp256k1_ec_pubkey_serialize` (compressed), `secp256k1_ec_seckey_tweak_add`
and `secp256k1_ec_seckey_verify`. It also makes one context per request with
`secp256k1_context_create`, blinds it with `secp256k1_context_randomize` from
`SecRandomCopyBytes` before any secret key touches it, and frees it with
`secp256k1_context_destroy`. `Foxy/Nostr/NostrCrypto.swift` adds eight more,
for the Nostr gift wrap: `secp256k1_ec_pubkey_parse`, `secp256k1_ecdh`,
`secp256k1_keypair_create`, `secp256k1_keypair_xonly_pub`,
`secp256k1_xonly_pubkey_parse`, `secp256k1_xonly_pubkey_serialize`,
`secp256k1_schnorrsig_sign32` and `secp256k1_schnorrsig_verify`. Smoke check 31
fails on:

- any other call;
- a file in `Vendor/secp256k1` that is missing, differs from its listing in
  `secp256k1.sha256`, or is not listed there;
- a project.yml that compiles anything else from it.

The derivation is tested against the NUT-13 vectors and 856 answers from the
bundled cashu-ts (`FoxyTests/NUT13Tests.swift`), on the simulator
(`sh tools/unit-tests.sh`) and on a Mac with no simulator
(`swift test --package-path tools/nativetests`, run by `tools/check-all.sh` and
GitHub's checks). libsecp256k1's own test suite was not run here.

**Checking it again.** `bash tools/vendor/verify-secp256k1.sh` (and
`python3 tools/verify-vendor.py --network`) repeats the check with git itself:
it fetches tag `v0.8.0` into an empty bare repository, checks the tag and commit
ids above, runs `git verify-tag` with a fresh `GNUPGHOME` holding only
`tools/vendor/keys/secp256k1-thestack.gpg` (bitcoin-core/guix.sigs'
`builder-keys/theStack.gpg`, primary key
`6A8F9C266528E25AEB1D7731C2371D91CB716EA7`), and compares the `git hash-object`
of every file in `Vendor/secp256k1` with the tag's tree (52 of 52).

Updating: fetch the new tag and verify its signature against a maintainer's
key. Copy the same set of files, rerunning `clang -MM` in case the headers
changed. Rewrite `secp256k1.sha256` and its listing hash, then run
`sh tools/unit-tests.sh` and `python3 tools/smoke.py`.
