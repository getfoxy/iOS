'use strict';
/* animated-qr.js — the ECASH TOKEN screen's animated QR code, frame for frame.
 *
 *     node tests/animated-qr.js
 *
 * Foxy writes its frames itself (build/wallet/06-animated-qr.js). Each must be
 * exactly the frame cashu.me's library, @gandlaf21/bc-ur 1.1.12, makes for the
 * same token and fragment size: tests/fixtures/animated-qr.json, made by that
 * library (its generator is beside it). The same frames are what Foxy's
 * scanner is tested on (FoxyTests/AnimatedQRTests.swift). */
const { load } = require('./harness');
const fixture = require('./fixtures/animated-qr.json');

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

const { W } = load({});
for (const c of fixture.cases) {
  const enc = W.animatedQr(c.token, c.fragmentLength);
  const made = c.frames.map(() => enc.next());
  const first = made.findIndex((f, i) => f !== c.frames[i]);
  check(c.name + ': ' + c.frames.length + ' frames as cashu.me makes them',
    first < 0 && enc.count === c.seqLength,
    first < 0 ? 'fragments ' + enc.count + ', wanted ' + c.seqLength
      : 'frame ' + (first + 1) + ':\n        got    ' + made[first].slice(0, 90) + '\n        wanted ' + c.frames[first].slice(0, 90));
}

// the page as it ships, with its QR library, for drawing frames and reading tokens
const fs = require('fs'), path = require('path');
const real = require('./harness').loadReal({
  before: (w) => {
    const q = w.document.createElement('script');
    q.textContent = fs.readFileSync(path.join(__dirname, '..', 'Web', 'qrcode.js'), 'utf8');
    w.document.body.appendChild(q);
  },
});
const R = real.W, CT = real.window.CashuTS;
const long = fixture.cases.find(c => c.seqLength > 10);
const src = R.qr(R.animatedQr(long.token, 100).next());
check('a frame draws as a QR code', typeof src === 'string' && src.length > 100, String(src).slice(0, 60));

// which tokens animate: more than two proofs, as cashu.me decides
const hex = (n) => n.toString(16).padStart(64, '0');
const proofOf = (amount, k) => ({ id: '009a1f293253e41e', amount, secret: hex(1000 + k), C: '02' + hex(2000 + k) });
const tokenOf = (amounts) => CT.getEncodedToken({ mint: 'https://m.test', unit: 'sat', proofs: amounts.map(proofOf) });
check('a token of three proofs animates; one of two does not',
  R.tokenQrAnimates(tokenOf([16, 4, 1])) === true && R.tokenQrAnimates(tokenOf([16, 4])) === false,
  JSON.stringify({ three: R.tokenQrAnimates(tokenOf([16, 4, 1])), two: R.tokenQrAnimates(tokenOf([16, 4])) }));

results.forEach(r => console.log(r));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(failed ? failed + ' animated QR check(s) failed' : 'all animated QR checks pass');
process.exit(failed ? 1 : 0);
