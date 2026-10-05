'use strict';
/* token-state.js — ask the mint what a token's proofs are actually worth.
 *
 *     node tools/token-state.js <file holding the token>
 *
 * Read only. It decodes the token with the bundled cashu-ts, asks the mint for
 * the state of every proof in it (NUT-07), and prints what is still spendable.
 * Nothing is swapped, nothing is claimed, no counter moves: the only request
 * it makes is the same /v1/checkstate Foxy makes before it takes a token.
 *
 * Why this exists. A wallet that refuses a token as "already spent" is telling
 * you about the first spent proof it found, not about the token — and a token
 * can be part dead and part alive. A send built with `online-no-swap` once
 * shipped proofs straight out of the balance rather than swapping for fresh
 * ones; the send errored, the reclaim errored, and the mint
 * still called some of those proofs spent. Two wallets disagreed and neither
 * would say by how much. The mint is the only one that knows.
 *
 * It talks to the mint directly, over the network this Mac is on. The mint
 * already knows these proofs — it issued them — but it will see the request.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
/* --proofs prints a line per proof: amount, keyset, state, and the full
 * secret. A secret is how the mint files a proof — it stores hash_to_curve(s)
 * — so it is the right thing to hand a mint operator who is asked to explain
 * where a proof went. It is NOT enough to spend one: that needs the mint's
 * signature C as well, which this never prints. */
const showProofs = args.indexOf('--proofs') >= 0;
const file = args.filter((a) => a.charAt(0) !== '-')[0];
if (!file) { console.error('usage: node tools/token-state.js [--proofs] <file holding the token>'); process.exit(2); }

/* cashu-ts is loaded for hashToCurve alone — the token is read by the CBOR
 * reader below rather than by getDecodedToken, which refused this one: the
 * keyset id is the newer eight-byte form (01fc0ec0e59cd6fa) and the bundled
 * decoder would not take it. Worth knowing on its own — a token Foxy cannot
 * decode is a token Foxy cannot help with.
 *
 * Loaded as the page loads it, a <script> in a jsdom document, which is how
 * tests/nut13-bundled.js does it and the only way the bundle finds its globals. */
const dom = new JSDOM('<body></body>', { runScripts: 'dangerously', url: 'https://localhost' });
const w = dom.window;
if (!w.crypto || !w.crypto.getRandomValues) Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
if (!w.TextEncoder) { w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; }
// the bundle asks the network through the page's fetch; node's is the one that works here
w.fetch = globalThis.fetch;
w.Headers = globalThis.Headers;
w.Request = globalThis.Request;
w.Response = globalThis.Response;
global.window = w;
global.document = w.document;
{
  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(__dirname, '..', 'Web', 'cashu-ts.js'), 'utf8');
  w.document.body.appendChild(s);
}
const CT = w.CashuTS;
if (!CT) { console.error('cashu-ts did not load'); process.exit(1); }

const raw = fs.readFileSync(file, 'utf8').trim();

/* The V4 token body: CBOR, and only the handful of major types a token uses.
 * Reading it here rather than through the bundle means a token this tool can
 * see is one it can always report on, whatever the library makes of it. */
function readCbor(buf) {
  let i = 0;
  function next() {
    const ib = buf[i++], mt = ib >> 5, ai = ib & 31;
    let len = ai;
    if (ai === 24) len = buf[i++];
    else if (ai === 25) { len = buf.readUInt16BE(i); i += 2; }
    else if (ai === 26) { len = buf.readUInt32BE(i); i += 4; }
    else if (ai === 27) { len = Number(buf.readBigUInt64BE(i)); i += 8; }
    switch (mt) {
      case 0: return len;
      case 2: { const v = buf.subarray(i, i + len); i += len; return v; }
      case 3: { const v = buf.toString('utf8', i, i + len); i += len; return v; }
      case 4: { const a = []; for (let k = 0; k < len; k++) a.push(next()); return a; }
      case 5: { const o = {}; for (let k = 0; k < len; k++) { const key = next(); o[key] = next(); } return o; }
      default: throw new Error('the token holds something this reader does not know (CBOR major ' + mt + ')');
    }
  }
  const out = next();
  return { value: out, read: i, of: buf.length };
}

(async () => {
  if (!/^cashuB/.test(raw)) throw new Error('that is not a cashuB token');
  const body = Buffer.from(raw.slice('cashuB'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const { value: tok, read, of } = readCbor(body);
  if (read !== of) console.log('note: ' + (of - read) + ' bytes after the token — it may be truncated or padded');

  const proofs = [];
  (tok.t || []).forEach((entry) => {
    const id = Buffer.from(entry.i).toString('hex');
    (entry.p || []).forEach((p) => proofs.push({ amount: Number(p.a), secret: p.s, id: id }));
  });
  const face = proofs.reduce((a, p) => a + p.amount, 0);

  console.log('mint   :', tok.m);
  console.log('unit   :', tok.u || 'sat');
  console.log('keysets:', [...new Set(proofs.map((p) => p.id))].join(', '));
  console.log('face   :', face.toLocaleString(), (tok.u || 'sat'), 'in', proofs.length, 'pieces');
  console.log('');

  // NUT-07: the mint is asked by each proof's Y, never by its secret
  const Ys = proofs.map((p) => CT.hashToCurve(new TextEncoder().encode(p.secret)).toHex(true));
  const answer = await fetch(String(tok.m).replace(/\/+$/, '') + '/v1/checkstate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Ys: Ys }),
  });
  const json = await answer.json();
  const states = json.states || [];
  if (states.length !== proofs.length) throw new Error('the mint answered about ' + states.length + ' of ' + proofs.length);

  const by = {};
  states.forEach((st, k) => {
    const name = String((st && st.state) || 'UNKNOWN').toUpperCase();
    (by[name] = by[name] || []).push(proofs[k]);
  });
  Object.keys(by).sort().forEach((name) => {
    const list = by[name];
    const sum = list.reduce((a, p) => a + p.amount, 0);
    console.log(name.padEnd(8), String(list.length).padStart(3), 'pieces',
      String(sum.toLocaleString()).padStart(10), (tok.u || 'sat'));
    console.log('        ', list.map((p) => p.amount).sort((a, b) => b - a).join(', '));
  });

  if (showProofs) {
    console.log('');
    console.log('  ' + 'amount'.padStart(7) + '  ' + 'keyset'.padEnd(16) + '  ' + 'state'.padEnd(8) + '  secret');
    proofs.forEach((p, k) => {
      const st = String((states[k] && states[k].state) || 'UNKNOWN').toUpperCase();
      console.log('  ' + String(p.amount).padStart(7) + '  ' + p.id.padEnd(16) + '  ' + st.padEnd(8) + '  ' + p.secret);
    });
  }

  const alive = (by.UNSPENT || []).reduce((a, p) => a + p.amount, 0);
  console.log('');
  console.log('still claimable:', alive.toLocaleString(), (tok.u || 'sat'),
    '(' + (by.UNSPENT || []).length + ' of ' + proofs.length + ' pieces)');
})().catch((e) => {
  console.error('failed:', (e && e.message) || e);
  process.exit(1);
});
