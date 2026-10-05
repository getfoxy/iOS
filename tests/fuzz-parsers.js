'use strict';
/* fuzz-parsers.js — the wallet's readers of untrusted text, fed damaged, random
 * and hostile input.
 *
 *     node tests/fuzz-parsers.js
 *     FOXY_FUZZ_CASES=20000 FOXY_FUZZ_SEED=12345 node tests/fuzz-parsers.js
 *
 * A QR code, the clipboard, a link or a mint can hand Foxy any text at all, and
 * a handful of readers decide what it is. One of them once froze the app on a
 * crafted QR code, by taking a declared length as fact. These run each reader
 * over three kinds of input:
 *
 *   - mutations of real ones: the spec vectors in tests/vectors, and BOLT11 and
 *     LUD-01 examples
 *   - random text
 *   - input valid in form and hostile in content: an LNURL with a correct
 *     checksum around an address built to slip past the https rule, and tokens
 *     carrying negative, fractional or oversized amounts
 *
 * and check what must always hold:
 *
 *   - no reader throws where it promises null, and none takes over 250 ms on one
 *     input
 *   - amountOf and msatOf: null or a whole, non-negative, safe number, and the
 *     two agree
 *   - descriptionHashOf: null or 64 hex characters
 *   - invoiceSigner: null or a compressed public key
 *   - decodeLnurl and mintProblem: an address passes only if a URL parser, the
 *     way the platform reads it, sees https, or http to a .onion host
 *   - decodeRequest and tokenInfo: null or the documented shape, with whole,
 *     non-negative amounts
 *   - unwrap: always a string
 *
 * The random source is seeded, so a failure prints the seed and case that
 * reproduce it. Everything runs through the shipped Web/ files, as
 * nut-vectors.js does. No network.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const CASES = Number(process.env.FOXY_FUZZ_CASES) || 1500;
const SEED = Number(process.env.FOXY_FUZZ_SEED) || 20260914;
const SLOW_MS = 250;

const dom = new JSDOM('<body></body>', { runScripts: 'dangerously', url: 'https://foxy.test/' });
const w = dom.window;
if (!w.crypto || !w.crypto.getRandomValues) Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
if (!w.TextEncoder) { w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; }
for (const f of ['bip39.js', 'cashu-ts.js', 'foxy-wallet.js']) {
  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(ROOT, 'Web', f), 'utf8');
  w.document.body.appendChild(s);
}
const C = w.CashuTS;
const W = w.FoxyWallet;
// the readers log what they refuse; thousands of refusals are noise here
w.console.warn = () => {};
w.console.log = () => {};

// ---- a seeded random source --------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(SEED);
const int = (n) => Math.floor(rand() * n);
const pick = (a) => a[int(a.length)];
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const chars = (alphabet, n) => { let s = ''; for (let i = 0; i < n; i++) s += alphabet[int(alphabet.length)]; return s; };
const hex = (n) => chars('0123456789abcdef', n);

// pieces that have broken parsers before, somewhere
const DICT = ['\\', '@', '#', '?', '/', '%', '%2e', '%2F', '%00', '\u0000', '\t', '\n', '\r', ' ', '。', '．',
  '.onion', '.ONION', '.onion.', 'http://', 'https://', 'HTTPS://', 'lightning:', 'cashu:', 'web+cashu://',
  'lnbc', 'lntb', '1', 'p', 'm', '0', '99999999999999999999', '-1', '1e308', 'NaN', 'null', '{"a":', ']]]]', '\ud800',
  '\u{1F600}', 'ﬀ', '‮', 'creqA', 'cashuA', 'cashuB', '?token=', '&token='];

function randomText() {
  const alphabet = pick([BECH32, B64URL, '0123456789', ' \t\n{}[]":,.-+eE0123456789', 'ABCé中😀\u0000\uffff']);
  return chars(alphabet, int(pick([8, 40, 300, 3000])));
}

function mutate(s) {
  let t = String(s);
  const ops = 1 + int(4);
  for (let k = 0; k < ops; k++) {
    const at = int(t.length + 1);
    switch (int(8)) {
      case 0: t = t.slice(0, at) + pick(BECH32 + B64URL) + t.slice(at + 1); break;           // change one character
      case 1: t = t.slice(0, at) + pick(DICT) + t.slice(at); break;                            // insert a known troublemaker
      case 2: t = t.slice(0, at) + t.slice(at + 1 + int(20)); break;                           // delete a run
      case 3: t = t.slice(0, at) + t.slice(at, at + int(40)) + t.slice(at); break;             // duplicate a run
      case 4: t = t.slice(0, int(t.length + 1)); break;                                        // truncate
      case 5: t = t.toUpperCase(); break;
      case 6: t = pick(['', ' ', '\n', 'Here you go: ', '\u{1F98A} ', 'lightning:', 'cashu:']) + t + pick(['', ' ', '\n', '.', ' thanks']); break;
      case 7: t = t.repeat(1 + int(3)); break;
    }
  }
  return t;
}

// ---- bech32, to build LNURLs whose checksum is right --------------------------
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function bech32(hrp, bytes) {
  const data = [];
  let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod(expand.concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const sum = []; for (let i = 0; i < 6; i++) sum.push((mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(sum).map((d) => BECH32[d]).join('');
}

// an address meant to look like https or an .onion without being one
function hostileUrl() {
  const scheme = pick(['http://', 'https://', 'HTTP://', 'hTtPs://', 'http:/', 'https:\\\\', 'ftp://', '']);
  const user = pick(['', 'user@', 'x.onion@', 'a:b@']);
  const host = pick(['evil.example', 'x.onion', 'abcdefghijklmnop.onion', '127.0.0.1', '[::1]', 'EVIL.EXAMPLE']);
  const joint = pick(['', '\\', '/', '?', '#', '@', '%2F', '\t', ' ', '.', ':8080', '。']);
  const tail = pick(['', '.onion', 'x.onion', '.onion.', '.ONION', '/lnurlp/me', '?q=.onion', '#.onion']);
  return scheme + user + host + joint + tail;
}
function whatwgSecure(u) {
  let url;
  try { url = new URL(String(u).trim()); } catch (e) { return false; }
  return url.protocol === 'https:' || (url.protocol === 'http:' && /\.onion$/i.test(url.hostname));
}

// ---- the inputs to start from -----------------------------------------------
const vectors = fs.readdirSync(path.join(__dirname, 'vectors')).filter((f) => f.endsWith('.md'))
  .map((f) => fs.readFileSync(path.join(__dirname, 'vectors', f), 'utf8')).join('\n');
const TOKENS = [...new Set(vectors.match(/cashu[AB][A-Za-z0-9_\-=+/]{20,}/g) || [])];
const REQUESTS = [...new Set(vectors.match(/creq[AB][A-Za-z0-9_\-=+/]{20,}/g) || [])];
const INVOICES = [
  // BOLT11's own examples
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w',
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp',
  'lnbc20m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqscc6gd6ql3jrc5yzme8v4ntcewwz5cnw92tz0pc8qcuufvq7khhr8wpald05e92xw006sq94mg8v2ndf4sefvf9sygkshp5zfem29trqq2yxxz7',
];
const LNURLS = [
  // LUD-01's example
  'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS',
  bech32('lnurl', [...Buffer.from('https://service.example/lnurlp/alice')]),
];

// ---- running and recording -------------------------------------------------
const results = [];
function reader(name, gen, check) {
  rand = mulberry32(SEED ^ [...name].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7));
  const failures = [];
  let slowest = 0;
  for (let i = 0; i < CASES; i++) {
    const input = gen(i);
    const t0 = performance.now();
    let out, threw = null;
    try { out = check.run(input); } catch (e) { threw = e; }
    const ms = performance.now() - t0;
    slowest = Math.max(slowest, ms);
    let problem = null;
    if (ms > SLOW_MS) problem = 'took ' + ms.toFixed(0) + ' ms';
    else if (threw && !(check.mayThrow && check.mayThrow(threw))) problem = 'threw: ' + (threw && threw.message);
    else if (!threw) problem = check.holds(out, input);
    if (problem) failures.push({ i, input, problem });
  }
  results.push({ name, failures, slowest });
}

const fromCorpus = (corpus, other) => (i) => {
  const k = i % 10;
  if (k < 6 && corpus.length) return mutate(pick(corpus));
  if (k < 8) return other ? other() : randomText();
  return randomText();
};
const ln = () => 'ln' + pick(['bc', 'tb', 'bcrt', 'BC', 'xx']) + pick(['', '0', '1', '25', '10', '999999999', '99999999999999999999', String(2 ** 53), '1'.repeat(400)])
  + pick(['m', 'u', 'n', 'p', 'P', '', 'x']) + '1' + chars(BECH32, int(400));
const wholeOrNull = (x) => x === null || (Number.isSafeInteger(x) && x >= 0);

reader('amountOf and msatOf', fromCorpus(INVOICES, ln), {
  run: (s) => [W.amountOf(s), W.msatOf(s)],
  holds: ([a, m]) => {
    if (!wholeOrNull(a)) return 'amountOf gave ' + a;
    if (!wholeOrNull(m)) return 'msatOf gave ' + m;
    if (a !== null && m !== null && Math.abs(a - m / 1000) > 0.5 + 1e-9) return 'amountOf ' + a + ' and msatOf ' + m + ' disagree';
    return null;
  },
});

reader('descriptionHashOf', fromCorpus(INVOICES, ln), {
  run: (s) => W.descriptionHashOf(s),
  holds: (h) => (h === null || /^[0-9a-f]{64}$/.test(h) ? null : 'gave ' + JSON.stringify(h)),
});

reader('invoiceSigner', fromCorpus(INVOICES, ln), {
  run: (s) => W.invoiceSigner(s),
  holds: (k) => (k === null || /^0[23][0-9a-f]{64}$/.test(k) ? null : 'gave ' + JSON.stringify(k)),
});

reader('decodeLnurl', (i) => (i % 3 === 0 ? bech32(pick(['lnurl', 'LNURL', 'lnurl']).toLowerCase(), [...Buffer.from(hostileUrl())])
  : fromCorpus(LNURLS)(i)), {
  run: (s) => W.decodeLnurl(s),
  mayThrow: (e) => e instanceof w.Error || e instanceof Error,
  holds: (url, input) => {
    if (typeof url !== 'string') return 'returned ' + typeof url;
    if (!whatwgSecure(url)) return 'accepted ' + JSON.stringify(url) + ', which a URL parser reads as not https and not an .onion';
    return null;
  },
});

reader('mintProblem', (i) => (i % 2 ? hostileUrl() : mutate(pick(['https://mint.example', 'http://abcdefghijklmnop.onion', 'https://testnut.cashu.space']))), {
  run: (u) => W.mintProblem(u),
  holds: (p, u) => {
    if (p !== null && typeof p !== 'string') return 'returned ' + typeof p;
    if (p === null && !whatwgSecure(u)) return 'passed ' + JSON.stringify(u) + ', which a URL parser reads as not https and not an .onion';
    return null;
  },
});

reader('decodeRequest', fromCorpus(REQUESTS), {
  run: (s) => W.decodeRequest(s),
  holds: (r) => {
    if (r === null) return null;
    if (typeof r !== 'object') return 'returned ' + typeof r;
    if (typeof r.id !== 'string' || typeof r.unit !== 'string' || typeof r.description !== 'string') return 'fields of the wrong type: ' + JSON.stringify(r).slice(0, 160);
    if (!Number.isFinite(r.sats) || r.sats < 0) return 'sats ' + r.sats;
    if (!Array.isArray(r.mints) || r.mints.some((m) => typeof m !== 'string')) return 'mints ' + JSON.stringify(r.mints).slice(0, 120);
    if (!Array.isArray(r.transports)) return 'transports not a list';
    return null;
  },
});

// tokens valid in form: v3 JSON built by hand, so amounts can be anything
function hostileToken() {
  const amounts = [1, 2, 64, 0, -1, -64, 1.5, 2 ** 53, 1e308, '8', null];
  const proofs = [];
  for (let k = 0, n = int(4); k <= n; k++) {
    proofs.push({ id: pick(['009a1f293253e41e', '00ad268c4d1f5826', hex(16), '']), amount: pick(amounts), secret: hex(64), C: '02' + hex(64) });
  }
  const token = { token: [{ mint: pick(['https://mint.example', hostileUrl(), '']), proofs }], unit: pick(['sat', 'usd', ' SAT ', '', 'x'.repeat(40)]) };
  return 'cashuA' + Buffer.from(JSON.stringify(token)).toString('base64url');
}
reader('tokenInfo', (i) => (i % 3 === 0 ? hostileToken() : fromCorpus(TOKENS)(i)), {
  run: (s) => W.tokenInfo(s),
  holds: (r) => {
    if (r === null) return null;
    if (typeof r !== 'object') return 'returned ' + typeof r;
    if (typeof r.mint !== 'string' || typeof r.unit !== 'string' || !Array.isArray(r.proofs)) return 'fields of the wrong type: ' + JSON.stringify(r).slice(0, 160);
    if (!Number.isSafeInteger(r.amount) || r.amount < 0) return 'amount ' + r.amount + ' from proofs ' + JSON.stringify(r.proofs.map((p) => p && p.amount)).slice(0, 100);
    if (r.sats !== null && r.sats !== r.amount) return 'sats ' + r.sats + ' is not the amount ' + r.amount;
    return null;
  },
});

const ADDRESSES = [
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
  '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  'bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?amount=0.00021&label=x',
];
reader('readAddress', fromCorpus(ADDRESSES.concat(INVOICES, LNURLS)), {
  run: (s) => W.readAddress(s),
  holds: (r) => {
    if (r === null) return null;
    if (typeof r !== 'object') return 'returned ' + typeof r;
    if (typeof r.address !== 'string' || !r.address) return 'address ' + JSON.stringify(r.address);
    // whatever comes back must itself read as the same address: money goes to this string
    const again = W.readAddress(r.address);
    if (!again || again.address !== r.address) return 'it does not read its own answer back: ' + r.address;
    if (!Number.isSafeInteger(r.sats) || r.sats < 0) return 'sats ' + r.sats;
    return null;
  },
});

reader('unwrap', fromCorpus(TOKENS.concat(REQUESTS, INVOICES)), {
  run: (s) => W.unwrap(s),
  holds: (t) => (typeof t === 'string' ? null : 'returned ' + typeof t),
});

// ---- report ----------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (!r.failures.length) {
    console.log('ok    ' + r.name + ': ' + CASES + ' cases, slowest ' + r.slowest.toFixed(1) + ' ms');
    continue;
  }
  failed++;
  console.log('FAIL  ' + r.name + ': ' + r.failures.length + ' of ' + CASES + ' cases');
  for (const f of r.failures.slice(0, 4)) {
    console.log('      case ' + f.i + ': ' + f.problem);
    console.log('        input ' + JSON.stringify(f.input).slice(0, 220));
  }
}
console.log('\nseed ' + SEED + ', ' + TOKENS.length + ' tokens, ' + REQUESTS.length + ' payment requests, '
  + INVOICES.length + ' invoices and ' + LNURLS.length + ' LNURLs to start from');
if (failed) {
  console.log(failed + ' reader(s) failed; rerun with FOXY_FUZZ_SEED=' + SEED + ' to reproduce');
  process.exit(1);
}
console.log('all ' + results.length + ' readers hold under ' + (CASES * results.length) + ' fuzzed inputs');
