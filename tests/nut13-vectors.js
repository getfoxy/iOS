'use strict';
/* nut13-vectors.js — NUT-13 through the bundled bip39.js and cashu-ts.js: the
 * spec's vectors for both keyset versions (00 and 01), and every entry of the
 * cross-check fixture the native derivation is tested against.
 *
 *     node tests/nut13-vectors.js
 *
 * Both fixtures are in tests/fixtures, and FoxyTests/NUT13Tests.swift reads the
 * same two files: the page's derivation and the native one answer to one
 * source. The cross-check fixture is rederived here from the bundle, so it
 * cannot drift from what the page itself would derive
 * (node tools/gen-nut13-cross.js writes it). */
const fs = require('fs');
const path = require('path');
const { bundled } = require('./nut13-bundled.js');

const ROOT = path.join(__dirname, '..');
const { B, C } = bundled();
const hex = u => Buffer.from(u).toString('hex');
const fixture = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', name), 'utf8'));
let fail = 0;

// NUT-13 test vectors (cashubtc/nuts tests/13-tests.md)
const V = fixture('nut13-vectors.json');
const seed = B.mnemonicToSeedSync(V.mnemonic);
let vectors = 0;
for (const [id, v] of Object.entries(V.keysets)) {
  if (v.secrets.length !== v.blindingFactors.length) { fail++; console.log('FAIL', id, 'lists', v.secrets.length, 'secrets and', v.blindingFactors.length, 'blinding factors'); }
  v.secrets.forEach((want, k) => {
    const got = C.deriveSecretAndBlindingFactor(seed, id, k);
    // the secret and its blinding factor at every counter the spec lists
    const ok = hex(got.secret) === want && hex(got.blindingFactor) === v.blindingFactors[k];
    vectors++;
    if (!ok) fail++;
    console.log(ok ? 'PASS' : 'FAIL', id.slice(0, 4) + '…', 'counter', k, hex(got.secret).slice(0, 16), 'r ' + hex(got.blindingFactor).slice(0, 16));
  });
}
// a fixture that lost entries would still "pass" what is left
if (vectors !== 10) { fail++; console.log('FAIL the vectors fixture holds', vectors, 'vectors, not the spec\'s 10'); }

// the cross-check fixture: mnemonics, keysets of both versions, counters at the edges
const X = fixture('nut13-cross.json');
let entries = 0;
for (const c of X.cases) {
  const s = B.mnemonicToSeedSync(c.mnemonic);
  if (hex(s) !== c.seed) { fail++; console.log('FAIL the seed of a', c.mnemonic.split(' ').length, 'word mnemonic'); }
  for (const k of c.keysets) {
    for (const e of k.entries) {
      const got = C.deriveSecretAndBlindingFactor(s, k.keysetId, e.counter);
      entries++;
      if (hex(got.secret) !== e.secret || hex(got.blindingFactor) !== e.blindingFactor) {
        fail++;
        console.log('FAIL cross-check', k.keysetId.slice(0, 4) + '…', 'counter', e.counter);
      }
    }
  }
}
if (entries < 800) { fail++; console.log('FAIL the cross-check fixture holds only', entries, 'entries'); }
console.log('cross-check fixture:', X.cases.length, 'mnemonics,', entries, 'entries rederived');

console.log('12 words from generateMnemonic(wordlist,128):', B.generateMnemonic(B.wordlist, 128).split(' ').length);
console.log(fail ? fail + ' FAILED' : 'all NUT-13 vectors and cross-check entries pass with the bundled libraries');
process.exit(fail ? 1 : 0);
