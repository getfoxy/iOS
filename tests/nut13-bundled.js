'use strict';
/* nut13-bundled.js — Foxy's bundled bip39.js and cashu-ts.js, loaded into a
 * JSDOM page the way foxy-wallet.js finds them, for the NUT-13 checks:
 * tests/nut13-vectors.js and tools/gen-nut13-cross.js. One loader, so the
 * fixture is made by the same code that checks it. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function bundled() {
  const dom = new JSDOM('<body></body>', { runScripts: 'dangerously' });
  const w = dom.window;
  if (!w.crypto || !w.crypto.getRandomValues) Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
  if (!w.TextEncoder) { w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; }
  for (const f of ['bip39.js', 'cashu-ts.js']) {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(ROOT, 'Web', f), 'utf8');
    w.document.body.appendChild(s);
  }
  return { B: w.FoxyBip39, C: w.CashuTS };
}

module.exports = { bundled };
