'use strict';
/* till-key-vectors-generate.js — writes tests/fixtures/till-key-vectors.json.
 *
 *     node tests/fixtures/till-key-vectors-generate.js
 *
 * A till sale's key (build/wallet/08d-till.js `tillSaleKey`, docs/MONEY.md §19): the
 * code's key L, a seed-derived lock key of the phrase tests/harness.js gives a phone
 * (m/129373'/10'/0'/0'/i), moved by t = SHA-256("foxy-till-lock-v1" ‖ L ‖ n) to
 * K = L + t·G, spent with l + t. Made with tests/harness.js's BigInt arithmetic,
 * which shares no code with the page's library or with libsecp256k1:
 * tests/till-wallet.js holds the page to these numbers, and
 * FoxyTests/TillSaleKeyTests.swift holds P2PK.swift and libsecp256k1 to them. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('../harness');

const words = H.PHONE_WORDS;
const seed = crypto.pbkdf2Sync(Buffer.from(words.normalize('NFKD')), Buffer.from('mnemonic'), 2048, 64, 'sha512');
const parent = H.p2pkParent(seed);
const nonces = ['00000000000000000000000000000000', '0123456789abcdef0123456789abcdef', 'ffffffffffffffffffffffffffffffff',
                '5c2e1f0a9b8d7c6e5f4a3b2c1d0e9f8a'];
const cases = [0, 1, 4, 5].map((index, i) => {
  const key = H.p2pkAt(parent, index);
  const n = nonces[i];
  return {
    index, L: key.pub, l: key.priv, n,
    t: H.tillSaleTweak(key.pub, n).toString(16).padStart(64, '0'),
    K: H.tillSaleKey(key.pub, n),
    k: H.tillSaleSecret(key.priv, key.pub, n),
  };
});
const out = { tag: 'foxy-till-lock-v1', words, cases };
fs.writeFileSync(path.join(__dirname, 'till-key-vectors.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote till-key-vectors.json, ' + cases.length + ' cases, L parities ' + cases.map((c) => c.L.slice(0, 2)).join(' '));
