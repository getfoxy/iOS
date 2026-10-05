'use strict';
/* gen-nut13-cross.js — NUT-13 answers from Foxy's bundled bip39.js and
 * cashu-ts.js, for the native derivation (Foxy/Keychain/NUT13.swift) to match.
 *
 *     node tools/gen-nut13-cross.js     write tests/fixtures/nut13-cross.json
 *
 * The spec's vectors are one mnemonic and five counters. This adds fresh random
 * mnemonics (12 and 24 words), real keyset ids of both versions, and the
 * counters at the edges: 0 to 50, 1000, 2^31 − 1 (the last hardened index, 00
 * only) and 2^40 and 2^53 − 1 (01 only, past 32 bits, and cashu-ts's last).
 * FoxyTests/NUT13Tests.swift must give every entry byte for byte, and
 * tests/nut13-vectors.js rederives the committed file from the bundle, so the
 * fixture cannot drift from what the page itself would derive.
 *
 * The mnemonics are made for this file and hold nothing. Rerunning it writes
 * new ones; commit the result. */
const fs = require('fs');
const path = require('path');
const { bundled } = require('../tests/nut13-bundled.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'nut13-cross.json');
const { B, C } = bundled();
const hex = u => Buffer.from(u).toString('hex');

const KEYSETS = [
  '00b4cd27d8861a44',                                                     // a real mint's 00 keyset
  '009a1f293253e41e',                                                     // NUT-13's 00 vector keyset
  '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a',   // NUT-13's 01 vector keyset
  '012fbb01a4e200c76df911eeba3b8fe1831202914b24664f4bccbd25852a6708f8',   // NUT-02 vector 3's 01 keyset
];

function counters(keysetId) {
  const list = Array.from({ length: 51 }, (_, k) => k).concat([1000]);
  return keysetId.startsWith('00') ? list.concat([2 ** 31 - 1]) : list.concat([2 ** 40, Number.MAX_SAFE_INTEGER]);
}

const mnemonics = [128, 128, 128, 256].map(bits => B.generateMnemonic(B.wordlist, bits));
const cases = mnemonics.map(mnemonic => {
  const seed = B.mnemonicToSeedSync(mnemonic);
  return {
    mnemonic,
    seed: hex(seed),
    keysets: KEYSETS.map(keysetId => ({
      keysetId,
      entries: counters(keysetId).map(counter => {
        const got = C.deriveSecretAndBlindingFactor(seed, keysetId, counter);
        return { counter, secret: hex(got.secret), blindingFactor: hex(got.blindingFactor) };
      }),
    })),
  };
});

// one entry a line, so a diff of a regenerated file stays readable
const lines = ['{',
  '  "generatedBy": "tools/gen-nut13-cross.js",',
  '  "readBy": ["tests/nut13-vectors.js", "FoxyTests/NUT13Tests.swift"],',
  '  "cases": ['];
cases.forEach((c, ci) => {
  lines.push('    {', '      "mnemonic": ' + JSON.stringify(c.mnemonic) + ',', '      "seed": "' + c.seed + '",', '      "keysets": [');
  c.keysets.forEach((k, ki) => {
    lines.push('        {', '          "keysetId": "' + k.keysetId + '",', '          "entries": [');
    k.entries.forEach((e, ei) => lines.push('            ' + JSON.stringify(e) + (ei < k.entries.length - 1 ? ',' : '')));
    lines.push('          ]', '        }' + (ki < c.keysets.length - 1 ? ',' : ''));
  });
  lines.push('      ]', '    }' + (ci < cases.length - 1 ? ',' : ''));
});
lines.push('  ]', '}', '');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
JSON.parse(fs.readFileSync(OUT, 'utf8'));
const n = cases.reduce((s, c) => s + c.keysets.reduce((t, k) => t + k.entries.length, 0), 0);
console.log('wrote ' + path.relative(ROOT, OUT) + ': ' + cases.length + ' mnemonics, ' + KEYSETS.length + ' keysets, ' + n + ' entries');
