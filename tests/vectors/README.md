# Cashu spec test vectors

Copied unchanged from the `tests/` folder of https://github.com/cashubtc/nuts
(main; the latest commit touching tests was 3bc8b6d5b160, 2026-07-30), so
`tests/nut-vectors.js` runs offline against the exact files it was written for.
They carry their upstream's licence: see `LICENSE` at the root of that
repository.

| File | Source |
|---|---|
| nut00-tests.md | tests/00-tests.md — hash to curve, blinding, token v3/v4 |
| nut01-tests.md | tests/01-tests.md — keysets a wallet should take and refuse |
| nut02-tests.md | tests/02-tests.md — keyset ids v1 and v2 |
| nut11-tests.md | tests/11-test.md — P2PK: locktime, refund, n_sigs, SIG_ALL |
| nut12-tests.md | tests/12-tests.md — DLEQ |
| nut18-tests.md | tests/18-tests.md — payment requests |
| nut20-tests.md | tests/20-test.md — signed mint quotes |
| nut26-tests.md | tests/26-test.md — bech32m payment requests (`creqB`) |

Upstream's own file names are in the table: `11-test.md`, `20-test.md` and
`26-test.md` are singular upstream, the others plural. Last upstream commit to
touch three of them: `a246a91ceb39` (11), `78ed24c9cc12` (01), `df1ca22e7775`
(26). The sha256 of each as vendored:

```
81ae4a2fc1b11c88d024ddcde427e70d21d443c508f7bb208aeef505452adf8a  nut00-tests.md
c5d324d656407d86b285f30364c02594e00233927f9161c45a3395ac61274278  nut01-tests.md
16cd0060523bb8b00f424c813a44c81abc4ae1da73e5b3b8c2648010ef4a5e0b  nut02-tests.md
80e7c962167d31513030bcf7e2d52cdb89a55d6bd5264a3d13f7ae78a26e8dfe  nut11-tests.md
d5c010b1915ef30cd24d1e9d502a74056ea253f80208481c6737642a7798787d  nut12-tests.md
4ee47bc67de47c2d98db8e0a474ac7389cec3295959ff991b87c0e9e7703fc0b  nut18-tests.md
7c178b14e4fad68b8e38fd7265cb3eb8ac7cb6ce58882f27697de71e91ca8231  nut20-tests.md
dcc42575452ed141b49f0a4d8dcc358f06c4675259698f756846ab10292c881c  nut26-tests.md
```

NUT-13 vectors are in `tests/fixtures/nut13-vectors.json`, which
`tests/nut13-vectors.js` and `FoxyTests/NUT13Tests.swift` both read. Beside it,
`nut13-cross.json` holds the bundled cashu-ts's own answers for random mnemonics
and edge counters (`node tools/gen-nut13-cross.js` writes it).

To refresh: download the same files again and rerun `node tests/nut-vectors.js`.
