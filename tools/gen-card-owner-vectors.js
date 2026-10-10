'use strict';
/* gen-card-owner-vectors.js — a Foxy card's owner key, worked out apart from
 * the Swift that derives it, for the native side (Foxy/Keychain/NUT13.swift,
 * CardOwner) and the page's stand-in for it (tests/harness.js) to match.
 *
 *     node tools/gen-card-owner-vectors.js     write tests/fixtures/card-owner-vectors.json
 *
 * Nothing here is Foxy's code. The seeds come from Node's own PBKDF2 (BIP-39's
 * seed, over the NFKD words), the scalar from Node's own HMAC and BigInt, the
 * public key from Node's own P-256 and the signatures from Node's own ECDSA, so
 * a mistake in the Swift cannot be repeated here.
 *
 * FoxyTests/NUT13Tests.swift and FoxyTests/SeedActionsTests.swift hold the Swift
 * to every field. The ECDSA signatures are randomised, so a rerun writes new
 * ones: they are checked by verifying them against the public key, never by
 * comparing them. Everything else is the same on every run.
 *
 * The mnemonics hold nothing; the third seed is no phrase at all, only bytes. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'card-owner-vectors.json');
const N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;   // the order of P-256
const hex = (b) => Buffer.from(b).toString('hex');
const hex32 = (x) => x.toString(16).padStart(64, '0');
const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();

/* BIP-39's seed: PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic", over the NFKD form of the words */
const bip39Seed = (words) => crypto.pbkdf2Sync(Buffer.from(words.normalize('NFKD')), 'mnemonic', 2048, 64, 'sha512');

/* h(counter) = HMAC-SHA256(seed, "FoxyCard/owner" || 0x00 || cardKey || (counter > 0 ? [counter] : [])),
 * d = h mod n, and the next counter while d is 0. */
function ownerScalar(seed, cardKey) {
  for (let counter = 0; counter < 256; counter++) {
    const message = Buffer.concat([Buffer.from('FoxyCard/owner'), Buffer.from([0]), cardKey,
      counter > 0 ? Buffer.from([counter]) : Buffer.alloc(0)]);
    const h = crypto.createHmac('sha256', seed).update(message).digest();
    const d = BigInt('0x' + hex(h)) % N;
    if (d !== 0n) return d;
  }
  throw new Error('no non-zero scalar in 256 tries');
}

/* the uncompressed public key of a P-256 scalar */
function publicKey(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(hex32(d), 'hex'));
  return ecdh.getPublicKey(null, 'uncompressed');
}

function keyObjects(d, pub) {
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  return {
    priv: crypto.createPrivateKey({ key: { ...jwk, d: Buffer.from(hex32(d), 'hex').toString('base64url') }, format: 'jwk' }),
    pub: crypto.createPublicKey({ key: jwk, format: 'jwk' }),
  };
}

/* the cards' keys: secp256k1's G, a real card's key (tests/fixtures/flashcard-vectors.json), and -G (the same x, the other first byte) */
const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const MINUS_G = '03' + G.slice(2);
const A_CARD = '02fa05ed0a3649886270bacec5ddc1a3643009a759bee996f9a6ac060c9992a82e';
/* the interim time key's public half (Foxy/Flashcard/CardTime.swift), a P-256 point, as the card's time key */
const TIME_KEY = '04403d6dc56a7e17ce887410e510f6214ff8699d5e09bf43dbbbb4159a9856cd0fe0737a186bbc8cbdaa924c49c3e5bc390968348d30c1c5406ba530a040fb17f8';

const MNEMONIC_1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SETUPS = [
  { mnemonic: MNEMONIC_1, seed: bip39Seed(MNEMONIC_1), cardKey: G },
  { mnemonic: MNEMONIC_2, seed: bip39Seed(MNEMONIC_2), cardKey: A_CARD },
  { mnemonic: null, seed: crypto.createHash('sha512').update('Foxy card owner vectors, a seed that is no phrase').digest(), cardKey: MINUS_G },
];

const owners = SETUPS.map((s) => {
  const d = ownerScalar(s.seed, Buffer.from(s.cardKey, 'hex'));
  return { ...s, d, pub: publicKey(d) };
});

/* a value of each label's shape, different for each card */
function values(i) {
  const next = owners[(i + 1) % owners.length];
  const mints = ['https://mint.example.com', 'x', 'https://' + 'm'.repeat(72)];   // 24, 1 and 80 bytes
  const mint = Buffer.from(mints[i]);
  const unit = Buffer.from([[1], [2], [1]][i]);
  const record = Buffer.concat([unit, Buffer.from(owners[i].cardKey, 'hex'), Buffer.from(TIME_KEY, 'hex'), Buffer.from([mint.length]), mint]);
  return {
    'change-pin': Buffer.from(['123456', '0000', '99999999'][i]),
    'set-limit': Buffer.from(['000186a0', '00000000', 'ffffffff'][i], 'hex'),
    'set-owner': next.pub,
    'set-card': record,
    'load': Buffer.alloc(0),
    'reset': Buffer.alloc(0),
  };
}

/* what a card verifies: "FoxyCard/" + label || nonce (16) || value */
const LABELS = ['change-pin', 'set-limit', 'set-owner', 'set-card', 'load', 'reset'];

const cases = owners.map((o, i) => {
  const { priv, pub } = keyObjects(o.d, o.pub);
  const given = values(i);
  const signatures = LABELS.map((label) => {
    const nonce = sha256(Buffer.from('nonce ' + i + ' ' + label)).subarray(0, 16);
    const message = Buffer.concat([Buffer.from('FoxyCard/' + label), nonce, given[label]]);
    const sig = crypto.sign('sha256', message, priv);   // DER
    if (!crypto.verify('sha256', message, pub, sig)) throw new Error('Node did not verify its own signature');
    return { label, nonce: hex(nonce), value: hex(given[label]), message: hex(message), sig: hex(sig) };
  });
  return { mnemonic: o.mnemonic, seed: hex(o.seed), cardKey: o.cardKey, scalar: hex32(o.d), pub: hex(o.pub), signatures };
});

/* x mod n for a 256-bit x: x - n when x >= n, which is as far as a 256-bit value goes (it is below 2n) */
const MAX = (1n << 256n) - 1n;
const reductions = [0n, 1n, 1n << 255n, N - 1n, N, N + 1n, MAX - 1n, MAX].map((x) => ({ hash: hex32(x), reduced: hex32(x % N) }));

const COMMENT = [
  'A Foxy card\'s owner key, worked out by tools/gen-card-owner-vectors.js with Node\'s own crypto and not with Foxy\'s code.',
  'cases[]: one seed and one card.',
  '  mnemonic: the BIP-39 words the seed came from, or null where the seed is only bytes. The words hold nothing.',
  '  seed: the 64-byte BIP-39 seed, hex: PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic", over the NFKD words (no passphrase).',
  '  cardKey: the card\'s 33-byte compressed public key, hex.',
  '  scalar: the owner private key, 32 bytes hex, which never leaves native code in the app. d = HMAC-SHA256(key = seed,',
  '    message = utf8("FoxyCard/owner") || 0x00 || cardKey) taken mod n; where that is 0 the message gets a counter byte 0x01,',
  '    then 0x02 and so on, added at its end. None of these three needs one.',
  '  pub: the owner public key, 65 bytes hex, 04 || X || Y. It is what cardOwnerKey answers (lowercase).',
  '  signatures[]: one for each label the page may ask for. label is the short name, so the label signed is "FoxyCard/" + label.',
  '    nonce: 16 bytes hex. value: hex, of the shape that label takes. message: what is signed, hex: utf8("FoxyCard/" + label) || nonce || value.',
  '    sig: ECDSA over P-256 with SHA-256 of message, by scalar, DER, hex. ECDSA signatures are randomised, so a test VERIFIES it',
  '    against pub (and against message built from label, nonce and value) and never compares it with a signature of its own.',
  'reductions[]: hash is a 32-byte value as the HMAC would give it, reduced is hash mod n, 32 bytes hex (before the check for 0).',
  'n: the order of P-256, hex.',
].join('\n');

// one case a line group and one signature a line, so a diff of a regenerated file stays readable
const lines = ['{',
  '  "$comment": ' + JSON.stringify(COMMENT) + ',',
  '  "generatedBy": "tools/gen-card-owner-vectors.js",',
  '  "readBy": ["FoxyTests/NUT13Tests.swift", "FoxyTests/SeedActionsTests.swift", "tests/harness.js"],',
  '  "n": "' + hex32(N) + '",',
  '  "cases": ['];
cases.forEach((c, ci) => {
  lines.push('    {',
    '      "mnemonic": ' + JSON.stringify(c.mnemonic) + ',',
    '      "seed": "' + c.seed + '",',
    '      "cardKey": "' + c.cardKey + '",',
    '      "scalar": "' + c.scalar + '",',
    '      "pub": "' + c.pub + '",',
    '      "signatures": [');
  c.signatures.forEach((s, si) => lines.push('        ' + JSON.stringify(s) + (si < c.signatures.length - 1 ? ',' : '')));
  lines.push('      ]', '    }' + (ci < cases.length - 1 ? ',' : ''));
});
lines.push('  ],', '  "reductions": [');
reductions.forEach((r, ri) => lines.push('    ' + JSON.stringify(r) + (ri < reductions.length - 1 ? ',' : '')));
lines.push('  ]', '}', '');
fs.writeFileSync(OUT, lines.join('\n'));
console.log('wrote ' + path.relative(process.cwd(), OUT) + ': ' + cases.length + ' cards, '
  + cases.reduce((n, c) => n + c.signatures.length, 0) + ' signatures, ' + reductions.length + ' reductions');
