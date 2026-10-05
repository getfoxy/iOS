# tools/vendor — checking `Web/cashu-ts.js`

`Web/cashu-ts.js` (270,256 bytes, sha256 `34c1bdab…3d2e`) is the vendored file
that holds the Cashu protocol and its key handling. (`Web/bip39.js` and
libsecp256k1 hold key-handling code too: see `Web/VENDOR.md` and
`Vendor/README.md`.) This directory lets anyone check, from public sources,
that it is exactly what it claims to be.

| file | what |
|---|---|
| `package.json`, `package-lock.json` | the six build inputs, pinned by version and sha512 |
| `verify-cashu-ts.sh` | rebuild the bundle from those inputs and compare bytes |
| `test-cashu-ts-bundle.sh` | run cashu-ts's own unit tests against the shipped bundle |
| `vitest.bundle.config.mjs`, `summarize-bundle-tests.js` | used by the test script |

The other vendored code has a script here too. What each proves, and what it
does not, is in `Web/VENDOR.md` under "Checked against public releases".
`python3 tools/verify-vendor.py --network` runs all of them except IPtProxy.

| file | checks |
|---|---|
| `bip39/package.json`, `bip39/package-lock.json` | the three inputs of `Web/bip39.js`, pinned by sha512 |
| `verify-bip39.sh [--from-source]` | rebuild `Web/bip39.js` from them and compare bytes; with `--from-source`, every bundled file from its git tag |
| `verify-qrcode.sh` | `Web/qrcode.js` against `qrcode-generator@2.0.4` on npm and at tag `js2.0.4` |
| `verify-react.sh [--rebuild]` | React and ReactDOM decoded from `Web/index.html` against `react`/`react-dom@18.3.1` on npm; with `--rebuild`, against React's release build of its SSH-signed tag `v18.3.1` (Node 14.17.6 from a signed checksum list, keys in `keys/`) |
| `verify-tor.sh` | Tor's sources (pinned commits, signed tags) and Tor.framework `v409.11.2`'s patch, header fixer and wrapper; `--rebuild` also rebuilds Tor and compares with `Vendor/Tor.sha256` |
| `verify-iptproxy.sh` | `tools/build-iptproxy.sh --check`, and both builds against `Vendor/IPtProxy.sha256` |
| `verify-secp256k1.sh` | `Vendor/secp256k1` against libsecp256k1's tag `v0.8.0`: the tag and commit ids, `git verify-tag` against `keys/secp256k1-thestack.gpg` (primary key `6A8F9C26…6EA7`), and every file's `git hash-object` against the tag's tree |

## 1. Provenance: `verify-cashu-ts.sh`

```bash
bash tools/vendor/verify-cashu-ts.sh                # ~30 s: registry, github.com
bash tools/vendor/verify-cashu-ts.sh --from-source  # ~3-5 min: also rebuilds every input from git
bash tools/vendor/verify-cashu-ts.sh --no-git       # npm registry only
```

It needs node, npm, curl, openssl, shasum and git, and writes only to a mktemp
directory. It exits 0 only if every step passes and ends with `VERIFIED:`.

| step | checks | a failure would mean |
|---|---|---|
| 1 | each lockfile `integrity` equals the npm registry's `dist.integrity` | the lockfile was edited, or npm serves different bytes |
| 2 | sha512 of the cashu-ts 4.11.0 tarball, computed with openssl rather than npm | same, checked without trusting npm's client |
| 3 | tag `v4.11.0` is commit `05f80b726f5f…`, and its own `package-lock.json` pins @noble/curves, @noble/hashes, @scure/base and @scure/bip32 at the same versions and hashes as ours | Foxy's dependencies differ from what cashu-ts released and tested with |
| 4 | `npm ci --ignore-scripts` from the lockfile (npm checks each tarball's sha512 again) | |
| 5 | `esbuild 0.25.0 --bundle --format=iife --global-name=CashuTS --platform=browser --target=es2020 --minify` over `export * from '@cashu/cashu-ts'` | |
| 6 | **the output is byte-identical to `Web/cashu-ts.js`** and to the hash in `Web/VENDOR.md` | the shipped file has code that is not in these inputs |
| 7 | the bundle loads and exports `Wallet`, `Mint`, `getDecodedToken`, `getEncodedToken` (150 exports) | |
| 8 (`--from-source`) | every file esbuild read (19 files, listed from its metafile) is rebuilt from its git tag with that repo's own lockfile and compared byte for byte: cashu-ts `v4.11.0` (`npm run compile`, vite 8.0.10), noble-curves, noble-hashes, scure-base and scure-bip32 `2.4.0` (`npm run build`, tsc) | an npm tarball contains code that is not in the public repository |

**What passing proves.** Every byte of `Web/cashu-ts.js` is the deterministic
output of esbuild 0.25.0 over the published npm releases of @cashu/cashu-ts
4.11.0, @noble/curves 2.4.0, @noble/hashes 2.4.0, @scure/base 2.4.0 and
@scure/bip32 2.4.0. With `--from-source`, each of those releases is also the
build of its public git tag, so the bundle traces to reviewable source with no
trust in npm publishers. Nothing in the bundle comes from anywhere else.

**What it does not prove.** That the upstream source is correct or honest;
that the git tags will never be moved (the cashu-ts commit is pinned; the
paulmillr tags are not); or anything about the esbuild binary beyond npm's
integrity check. Other esbuild versions give different bytes; that is
expected and does not mean tampering.

**A passing run** (macOS arm64, node 24.14.0, npm 11.9.0) gets through all 8
steps, including every one of the 19 source-rebuilt files identical.

`python3 tools/verify-vendor.py` runs an offline subset on every check: the
lockfile still pins these six inputs with these hashes, and the bundle's
license footer names only @noble/@scure modules. `python3
tools/verify-vendor.py --network` also runs `verify-cashu-ts.sh`.

## 2. Behaviour: `test-cashu-ts-bundle.sh`

```bash
bash tools/vendor/test-cashu-ts-bundle.sh    # ~2 min, ~400 dev dependencies
```

It clones `v4.11.0`, runs `npm ci` from its lockfile, then runs vitest's `node`
project twice. It runs no integration tests, needs no mint and downloads no
browsers.

1. **Control, against `src/`:** the project's own suite, all pass.
2. **Against `Web/cashu-ts.js`:** `vitest.bundle.config.mjs` loads the shipped
   bytes and rewrites each test's imports from `src/`. Every name the package
   exports is taken from the bundle. Internal names the tests reach into
   (`getKeepAmounts`, `NULL_LOGGER`, `* as utils` for spying and so on) are
   not in the bundle, so they stay on source.

Result at 4.11.0: **2,444 of 2,524 pass**. By file:

| | files | tests | failed |
|---|---|---|---|
| A: bundle only | 23 | 631 | **0** |
| B: bundle, and the test passes its own @noble objects in | 15 | 438 | 2 |
| C: bundle plus internal names from `src/` | 29 | 1455 | 78 |

(4.10.2 measured 2,458 tests and 704 in group A. Group A got smaller while the
suite grew: upstream added ~6,900 lines of tests, and several files that used
to import only public API now reach into `src/`, which moves them A → C. The
failure count fell from 119 to 80.)

All 80 failures are the harness, not the bundle. The bundle is byte-identical
to a build of the same code that passes the suite. Examined one by one, they
fall into three groups:

- **Two copies of a class meet.** A source helper gets an `Amount` made by the
  bundle, or the reverse, and throws `Unsupported amount input type`.
  `toBeInstanceOf(NetworkError)` fails on errors that source code threw.
- **The test's own copy of noble.** The NUT28 test builds a secp256k1 point
  with its own copy of @noble/curves and passes it to the bundle's copy:
  `Weierstrass Point expected`.
- **A spy the bundle cannot see.** `vi.spyOn(utils, 'hasValidDleq')`,
  `vi.mock('../../src/wallet')`, `vi.spyOn(OutputData, …)` and
  `vi.stubGlobal` set on source modules. The bundle never calls those.

Group A is the clean signal. The script reruns those 23 files by themselves,
and the config records every `src/` file vitest loads: **631/631 pass, with 0
source modules loaded.** They cover `Mint`, wallet operations (swap, send,
receive, fees, state, P2PK, auth, bolt11/bolt12, WebSocket), keychain and
keysets, proof selection, NUT-10, `Amount`, the error types and JSONInt, and
they exercise only the shipped bytes. The crypto test files (NUT-01/09/11-14,
`crypto/core`) are not in group A. They pass their own @noble objects or
internal helpers in, so they land in groups B and C.

## Checking the checker

One byte changed in a copy of `Web/cashu-ts.js` (in a scratch root, with this
directory copied beside it): `verify-cashu-ts.sh` reports both `FAIL  Web/cashu-ts.js
differs from the rebuild` and the pinned-hash failure, and exits 1.
