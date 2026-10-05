# TOOLCHAIN.md — what these builds were made with

Reproducibility claims in this repository are claims about a compiler as much
as about sources. `tools/build-tor.sh` builds Tor from signed, commit-pinned
tags and a rebuild gives the same bytes — with the same Xcode. With another
Xcode it gives different bytes, and that is not a sign of tampering. The same
goes for the app binary itself.

So: this is the toolchain the recorded hashes and the "rebuilds byte for byte"
statements in AUDIT.md and Web/VENDOR.md were produced with. If yours differs
and a rebuild disagrees, the difference is the first thing to rule out.

| what | version | how to check yours |
|---|---|---|
| Xcode | 26.3 (build 17C529) | `xcodebuild -version` |
| Swift | 6.2.4 (swiftlang-6.2.4.1.4, clang-1700.6.4.2) | `swift --version` |
| iOS SDK | 26.2 | `xcrun --sdk iphoneos --show-sdk-version` |
| iOS Simulator SDK | 26.2 | `xcrun --sdk iphonesimulator --show-sdk-version` |
| macOS target of the host tools | arm64-apple-macosx26.0 | `swift --version` |
| Node | 24.14.0 | `node --version` |
| npm | 11.9.0 | `npm --version` |
| Go | 1.27.1 (IPtProxy needs 1.25 or later) | `go version` |
| Python | 3.9.6 (the macOS system one) | `python3 --version` |
| Xcode command-line tools path | `/Applications/Xcode.app/Contents/Developer` | `xcode-select -p` |

The autotools Tor is built with are **not** Homebrew's: `tools/build-autotools.sh`
builds m4, autoconf, automake, libtool and gettext from GNU's signed releases
into `build/autotools`, so the shell out of which Tor comes is one this repo
made. `tools/build-iptproxy.sh` needs Go 1.25 or later; the Go toolchain is
trusted, not rebuilt.

The table is the machine the recorded hashes were made on. The scheduled
checks in `.github/workflows` run on GitHub's images with Node 24 and Python
3.12, not these exact versions.

**What this does not say.** None of it shows the compiler is honest — a
compromised Xcode would produce a compromised binary from honest sources, and
nothing here would notice. It says only which compiler was used, so that two
people can get the same bytes and a third can tell a toolchain difference from
a source difference. `AUDIT.md`, "What is not proven yet", says the same about
Tor in its own words.

**When this changes.** Anyone who updates Xcode and rebuilds the vendored
libraries should update this file in the same commit as the new hashes; a hash
change with no toolchain change is a claim about sources, and the two should
never be confused.
