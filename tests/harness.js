/* harness.js — load foxy-wallet.js in Node, with a mint that does as it is told.
 *
 * The wallet is a browser script that expects localStorage, a cashu-ts global
 * and a native bridge. This supplies all three, so its behaviour can be tested
 * in a second rather than on a phone. The native side is the phone
 * (nativePhone, below), which keeps the seed and the counters as the app does:
 * the wallet has no other seed path, and refuses to connect without a bridge.
 *
 * The mint here is a stub. That is a real limit and worth stating: it tests
 * what the wallet does with an answer, not what a mint actually answers. The
 * findings that needed a real mint — fee arithmetic, the melt state machine —
 * came from moving sats, and tools/live/README.md is where those live.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
// the seed a phone holds unless a test says otherwise: an install that already has one
const PHONE_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/* The wallet in jsdom. Its native side is a phone: o.phone, or a new one
 * holding o.words (PHONE_WORDS by default; '' is a phone with no seed yet),
 * with Tor up. Actions the phone does not know go to o.bridge(window, message).
 * o.phone === false loads a page with no bridge at all, as a browser has. */
function load(opts) {
  const o = opts || {};
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<body></body>', {
    runScripts: 'dangerously',
    url: 'https://foxy.test/',
  });
  const w = dom.window;

  // the globals the wallet expects before it runs
  w.CashuTS = o.cashu || {};
  if (o.storage) {
    for (const [k, v] of Object.entries(o.storage)) w.localStorage.setItem(k, v);
  }
  const phone = o.phone === false ? null
    : (o.phone || nativePhone({ words: o.words === undefined ? PHONE_WORDS : o.words, window: o.window }));
  if (phone) {
    w.webkit = { messageHandlers: { foxy: { postMessage: m => {
      const got = phone.answer(w, m);
      // a screen still open answers when it closes
      if (got) return Promise.resolve(got).then((r) => setTimeout(() => w.FoxyWallet._scanResult(m.id, r[0], r[1]), 0));
      if (o.bridge) return o.bridge(w, m);
    } } } };
  } else if (o.bridge) {
    w.webkit = { messageHandlers: { foxy: { postMessage: m => o.bridge(w, m) } } };
  }

  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(ROOT, 'Web', 'foxy-wallet.js'), 'utf8');
  w.document.body.appendChild(s);

  const W = w.FoxyWallet;
  if (!W) throw new Error('foxy-wallet.js did not define FoxyWallet');
  if (W.requireVpn) W.requireVpn(false);   // no gate in a test
  // no circuit is opened ahead of time unless a test asks: it is a request to the mint nobody made
  W._spareOff = !o.spare;
  if (phone) W._privacy({ tor: 'up', progress: 100, everUp: true });
  // background checks unpaused, unless a test asks for a pause (sweepPause)
  W._sweepPause = o.sweepPause || [0, 0];
  W._keysetCheckDelay = o.keysetCheckDelay || [0, 0];
  return { W, window: w, storage: w.localStorage, phone };
}

/* A proof, shaped the way the mint returns them. */
let n = 0;
function proof(amount, secret) {
  n += 1;
  // The counter goes at the END. Padding it to the left and truncating to 64
  // gave every proof the same secret, which made a proof-corruption test pass
  // for the wrong reason.
  const tag = String(n).padStart(8, '0');
  return {
    amount: amount,
    secret: secret || ('0'.repeat(56) + tag),
    C: '02' + '0'.repeat(56) + tag,
    id: '00b4cd27d8861a44',
  };
}

/* A cashu-ts stand-in, enough for connect() to finish.
 *
 * Most of the wallet's surface is unreachable until mintUrl is set, and only
 * connect() sets it — so a test that touches the proof list has to get through
 * loadMint() first. This is not a mint: it answers, it does not decide. What a
 * real mint actually does is tools/live/README.md's job.
 */
function stubCashu(behaviour) {
  const b = behaviour || {};
  class Wallet {
    constructor(url, opts) {
      this.mintUrl = typeof url === 'string' ? url : (url && url.mintUrl);
      this.opts = opts || {};
      this.keysetId = '00b4cd27d8861a44';
      this.on = { countersReserved: () => {} };
    }
    loadMint() { return Promise.resolve(); }
    getKeySets() { return Promise.resolve([{ id: this.keysetId, unit: 'sat' }]); }
    checkProofsStates(ps) {
      const spent = new Set(b.spent || []);
      return Promise.resolve((ps || []).map(
        p => ({ state: spent.has(p.secret) ? 'SPENT' : 'UNSPENT' })));
    }
    batchRestore() { return Promise.resolve({ proofs: b.restore || [] }); }
    // an invoice nobody has paid: the sweep leaves it alone
    checkMintQuoteBolt11() { return Promise.resolve({ state: 'UNPAID' }); }
  }
  return { Wallet, Mint: Wallet, getDecodedToken: t => t, getEncodedToken: t => t };
}

/* Load, then connect, so the proof list is reachable. */
async function connected(opts) {
  const o = opts || {};
  const url = o.mint || 'https://m.test';
  const ctx = load(Object.assign({}, o, { cashu: stubCashu(o.behaviour) }));
  await ctx.W.connect(url, { remember: true });
  return ctx;
}

/* The page as it ships: Web/bip39.js, Web/cashu-ts.js and Web/foxy-wallet.js
 * in one jsdom window, with `o.bridge(window, message)` as the native side.
 * `o.before(window)` runs after the libraries and before the wallet. */
function loadReal(opts) {
  const o = opts || {};
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<body></body>', { runScripts: 'dangerously', url: 'https://foxy.test/' });
  const w = dom.window;
  if (!w.crypto || !w.crypto.getRandomValues) Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
  if (!w.TextEncoder) { w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; }
  if (o.storage) {
    for (const [k, v] of Object.entries(o.storage)) w.localStorage.setItem(k, v);
  }
  if (o.bridge) {
    w.webkit = { messageHandlers: { foxy: { postMessage: m => o.bridge(w, m) } } };
  }
  for (const f of ['bip39.js', 'cashu-ts.js']) {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(ROOT, 'Web', f), 'utf8');
    w.document.body.appendChild(s);
  }
  if (o.before) o.before(w);
  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(ROOT, 'Web', 'foxy-wallet.js'), 'utf8');
  w.document.body.appendChild(s);
  const W = w.FoxyWallet;
  if (!W) throw new Error('foxy-wallet.js did not define FoxyWallet');
  if (W.requireVpn) W.requireVpn(false);
  // no circuit is opened ahead of time unless a test asks: it is a request to the mint nobody made
  W._spareOff = !o.spare;
  if (o.bridge) W._privacy({ tor: 'up', progress: 100, everUp: true });
  // background checks unpaused, unless a test asks for a pause (sweepPause)
  W._sweepPause = o.sweepPause || [0, 0];
  W._keysetCheckDelay = o.keysetCheckDelay || [0, 0];
  const ctx = { W, window: w, storage: w.localStorage };
  watchBooks(ctx);
  return ctx;
}

/* ---- the books ---------------------------------------------------------
 *
 * Every page loadReal makes is asked one more question as the suite ends,
 * whatever the suite was about: do its history entries still account for the
 * ecash it holds? It is the sum the history screen's card does
 * (16-history-lists.js `histAudit`: ADDS UP, DOES NOT ADD UP) and the live
 * suites do after every scenario (tools/live/tap-scenarios.js `books`), one
 * mint at a time, in sats.
 *
 * A test asks whether the thing it is about happened. This asks whether
 * anything else did: a piece counted twice, a fee on no entry, change that
 * came back with no row. Those pass a test that compares with `>=`, and they
 * are what a person would otherwise find as a balance that is not what the
 * payments say.
 *
 * What is compared is the change since the page was made, so a page started
 * with ecash already in its storage is not a failure: what its entries say,
 * less what it holds, must be what it was. A page with money on its way
 * (a token not yet swapped in, a melt still routing, a move between mints)
 * is not judged; its entries are not meant to add up until that lands.
 *
 * `noBooks(ctx, why)` for a page a test puts ecash into, or takes it out of,
 * behind the wallet's back; `rebook(ctx)` after doing so, to carry on being
 * judged from there. FOXY_BOOKS=0 turns the question off. */
const BOOK_KEYS = { log: 'foxy.cashu.log', proofs: 'foxy.cashu.proofs.', held: 'foxy.cashu.held',
                    melting: 'foxy.cashu.melting', fees: 'foxy.cashu.topupfees' };
const bookMint = (u) => String(u || '').replace(/\/+$/, '');
const watched = [];
function stored(ctx, key, dflt) {
  try { const v = JSON.parse(ctx.storage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; }
}
/* One line a mint: what the entries say this page should hold there, what it
 * holds (the pile, and pieces held back for a swap the mint has not answered),
 * and the difference. */
function books(ctx) {
  const rows = stored(ctx, BOOK_KEYS.log, []);
  const says = new Map(), holds = new Map();
  const add = (m, mint, n) => m.set(bookMint(mint), (m.get(bookMint(mint)) || 0) + n);
  (Array.isArray(rows) ? rows : []).forEach((e) => {
    if (!e || (e.unit && e.unit !== 'sat')) return;
    if (e.state === 'failed' || e.failed || e.atRisk) return;
    if (e.dir === 'in' && (e.changeRow || /^(tap|req)-change-/.test(String(e.hash || '')))) return;
    if (e.dir === 'in') { if (!(e.state === 'pending' && !e.settled)) add(says, e.mint, Number(e.sats) || 0); return; }
    const owedBack = e.changeState === 'owed' ? (Number(e.changeSats) || 0) : 0;
    add(says, e.mint, -((Number(e.sats) || 0) + Math.max(0, Number(e.feeSats) || 0) + owedBack));
  });
  // less the fees no entry could carry, which the card counts too (topUpFeeSats)
  const fees = stored(ctx, BOOK_KEYS.fees, {});
  Object.keys(fees || {}).forEach((mint) => add(says, mint, -Math.max(0, Math.round(Number(fees[mint]) || 0))));
  const sum = (list) => (Array.isArray(list) ? list : []).reduce((n, p) => n + (Number(p && p.amount) || 0), 0);
  for (let i = 0; i < ctx.storage.length; i++) {
    const k = ctx.storage.key(i);
    if (k && k.indexOf(BOOK_KEYS.proofs) === 0) add(holds, k.slice(BOOK_KEYS.proofs.length), sum(stored(ctx, k, [])));
  }
  const held = stored(ctx, BOOK_KEYS.held, {});
  Object.keys(held || {}).forEach((id) => {
    const h = held[id];
    if (h && !(h.unit && h.unit !== 'sat')) add(holds, h.mint, sum(h.proofs));
  });
  const out = {};
  new Set([...says.keys(), ...holds.keys()]).forEach((mint) => {
    const a = says.get(mint) || 0, b = holds.get(mint) || 0;
    out[mint] = { says: a, holds: b, off: a - b };
  });
  return out;
}
/* Money on its way, which the entries are not meant to account for yet. */
function limbo(ctx) {
  const W = ctx.W, n = (f) => { try { return Math.round(Number(f()) || 0); } catch (e) { return 0; } };
  return {
    unclaimed: n(() => W.unclaimedSats()),
    recovering: n(() => W.recoveringSats()),
    melts: (stored(ctx, BOOK_KEYS.melting, []) || []).length || 0,
    move: n(() => (W.pendingMove && W.pendingMove() ? 1 : 0)),
  };
}
function watchBooks(ctx) {
  if (process.env.FOXY_BOOKS === '0') return;
  ctx.booksFrom = books(ctx);
  // where in the suite the page was made, to find the test by
  const frames = String(new Error().stack || '').split('\n').slice(1)
    .filter((l) => !/harness\.js|node:internal|node_modules/.test(l))
    .map((l) => (/([^\/\\(]+\.js:\d+)/.exec(l) || [])[1]).filter(Boolean);
  ctx.booksAt = frames.slice(0, 3).map((f, i) => (i ? f.replace(/^.*\.js/, '') : f)).join(' < ');
  if (!watched.length) process.on('exit', judgeBooks);
  watched.push(ctx);
}
/* The entries at a mint, newest first, short: which way, how much, the fee,
 * and what kind of entry. For the line that says they do not add up. */
function bookRows(ctx, mint) {
  return (stored(ctx, BOOK_KEYS.log, []) || []).filter((e) => e && bookMint(e.mint) === mint).map((e) =>
    (e.dir === 'in' ? '+' : '-') + (Number(e.sats) || 0)
    + (Number(e.feeSats) > 0 ? 'f' + Number(e.feeSats) : '')
    + (Number(e.grossSats) > 0 ? 'g' + Number(e.grossSats) : '')
    + (Number(e.changeSats) > 0 ? 'c' + Number(e.changeSats) : '')
    + (e.changeState ? '(' + e.changeState + ')' : '')
    + (e.state === 'pending' ? 'P' : '') + (e.state === 'failed' ? 'F' : '') + (e.atRisk ? 'R' : '')
    + (e.unit && e.unit !== 'sat' ? 'U' : '')
    + '<' + String(e.memo || '').slice(0, 14) + '|' + String(e.hash || '').slice(0, 10) + '>').join(' ');
}
function rebook(ctx) { ctx.booksFrom = books(ctx); }
function noBooks(ctx, why) { ctx.booksOff = why || 'not judged'; }
/* What does not add up on a page, as lines to print; none when it does. */
function booksWrong(ctx) {
  if (ctx.booksOff || !ctx.booksFrom) return [];
  const l = limbo(ctx);
  if (l.unclaimed || l.recovering || l.melts || l.move) return [];
  const now = books(ctx), was = ctx.booksFrom, wrong = [];
  new Set([...Object.keys(now), ...Object.keys(was)]).forEach((mint) => {
    const a = now[mint] || { says: 0, holds: 0, off: 0 }, b = was[mint] || { says: 0, holds: 0, off: 0 };
    if (a.off === b.off) return;
    wrong.push((mint || 'no mint named') + ': holds ' + a.holds + ' (' + (a.holds - b.holds >= 0 ? '+' : '') + (a.holds - b.holds)
      + ' since the page was made), its entries account for ' + (a.says - b.says >= 0 ? '+' : '') + (a.says - b.says)
      + ': ' + Math.abs(a.off - b.off) + ' sats ' + (a.off - b.off > 0 ? 'fewer are here than' : 'more are here than') + ' they explain'
      + '\n        entries: ' + (bookRows(ctx, mint) || 'none'));
  });
  return wrong;
}
function judgeBooks() {
  let bad = 0;
  watched.forEach((ctx, i) => {
    let wrong = [];
    try { wrong = booksWrong(ctx); } catch (e) { wrong = ['could not be read: ' + (e && e.message)]; }
    wrong.forEach((line) => { bad += 1; console.log('FAIL  the books of the page made at ' + (ctx.booksAt || 'page ' + (i + 1)) + ' do not add up — ' + line); });
  });
  if (bad) {
    console.log(bad + ' page(s) whose entries do not account for what they hold (tests/harness.js, "the books")');
    process.exitCode = 1;
  }
}

/* A mint made of cashu-ts's own crypto, for loadReal's page, answering the
 * bridge's mintRequest: `handle(message)` returns "status\nbody".
 *
 * Its keys come from a fixed seed, so two pages see the same keyset (a 00 id,
 * or 01 with versionByte 1). It signs what it is sent, refuses outputs it has
 * signed before and inputs already spent, and remembers what it signed for
 * restore. Every output sent to it is kept in `posted`, by path, the change
 * a melt returned in `change`, and the secret of every input it spent in
 * `spentSecrets`. Lightning is pretend: a mint quote is
 * paid when made, and a melt pays at once for 2 sat and returns the rest of
 * its 10-sat fee reserve as change (NUT-08). Not a mint: it checks no
 * signature on an input and no fee.
 *
 * `issuedSats()` and `takenSats()` are its books: every sat it has ever put
 * its signature to, and every sat it has taken as an input. The difference is
 * the ecash it still honours, which is what a wallet's own holdings are
 * measured against (tests/interleave.js).
 *
 * o.onchain: it settles on chain as well (NUT-30), as cdk-mintd's does.
 * Pretend in the same way and honest about state — an address reports only
 * what the test says has been paid to it (onchainCredit), and a payout answers
 * PENDING until the test says the transaction confirmed (onchainConfirm). It
 * comes with NUT-20 as such a mint does, because Foxy will not ask for an
 * address a quote it cannot sign for (quoteLock); a mint without o.onchain
 * advertises neither and answers 404 on every on-chain path, exactly as
 * before. */
function fakeMint(w, opts) {
  const o = opts || {};
  const C = w.CashuTS;
  // o.fill: the byte its key seed is made of, for mints with keysets of their own
  const pair = C.createNewMintKeys(16, new w.Uint8Array(64).fill(o.fill || 7), { versionByte: o.versionByte || 0 });
  const id = pair.keysetId;
  const hex = (b) => Buffer.from(Array.from(b)).toString('hex');
  const pubs = {};
  for (const [a, k] of Object.entries(pair.pubKeys)) pubs[a] = typeof k === 'string' ? k : hex(k);
  const quotes = {}, melts = {}, spent = new Set(), signed = new Map();
  const posted = [], change = [], spentSecrets = [];
  const witnesses = {};
  // addresses paid into this wallet, and payouts on their way out (NUT-30)
  const chainIn = {}, chainOut = {};
  /* o.quoteFrom: the number this mint's quotes start from. Two mints in one
   * test must not hand out the same quote id — Foxy keys a history entry by
   * the quote alone, and a real mint's are UUIDs, so a collision here is the
   * harness inventing a coincidence rather than a wallet being wrong. */
  let n = Number(o.quoteFrom) || 0;
  // the mint's own books: what it has signed for, and what it has taken
  let issued = 0, taken = 0;
  const quoteId = () => (++n).toString(16).padStart(32, '0');
  const now = () => Math.floor(Date.now() / 1000);
  const ok = (j) => '200\n' + JSON.stringify(j);
  const no = (code, detail) => '400\n' + JSON.stringify({ code, detail });
  const sum = (list) => (list || []).reduce((a, x) => a + Number(x.amount), 0);
  const yOf = (secret) => C.hashToCurve(new w.Uint8Array(Buffer.from(String(secret), 'utf8'))).toHex(true);
  const unsigned = (outs) => (outs || []).every((x) => !signed.has(x.B_));
  function sign(outs, amounts) {
    return outs.map((out, i) => {
      const amount = amounts ? amounts[i] : Number(out.amount);
      const priv = pair.privKeys[String(amount)];
      if (!priv) throw new Error('fake mint: no key for ' + amount);
      const sig = { id, amount, C_: C.createBlindSignature(C.pointFromHex(out.B_), priv, id).C_.toHex(true) };
      /* With its DLEQ (NUT-12), as a real mint sends it: Foxy takes locked
       * ecash as final only when the mint's signature can be checked, so a
       * mint that sent none would make every such payment wait for the swap.
       * o.dleq === false is a mint that sends none. */
      if (o.dleq !== false) {
        const d = C.createDLEQProof(C.pointFromHex(out.B_), priv);
        sig.dleq = { e: hex(d.e), s: hex(d.s) };
      }
      signed.set(out.B_, { out: { id, amount, B_: out.B_ }, sig });
      issued += amount;
      return sig;
    });
  }
  function spend(inputs) {
    const ys = (inputs || []).map((p) => yOf(p.secret));
    if (ys.some((y) => spent.has(y))) return false;
    ys.forEach((y) => spent.add(y));
    // the signature a piece was spent with, kept to be said to whoever asks about the piece (NUT-07)
    (inputs || []).forEach((p, i) => { if (p && p.witness) witnesses[ys[i]] = typeof p.witness === 'string' ? p.witness : JSON.stringify(p.witness); });
    (inputs || []).forEach((p) => { spentSecrets.push(String(p.secret)); taken += Number(p.amount) || 0; });
    return true;
  }
  /* The change a melt hands back: the largest denominations that fit, signed
   * into as many of the wallet's blanks as there are (NUT-08). A wallet that
   * sends fewer blanks than the change needs forfeits the rest, which is the
   * mint's own behaviour and shows up in its books as a sat it kept. */
  function changeFor(outs, back) {
    const amounts = [];
    for (let bit = 1; back > 0; bit *= 2) if (back & bit) { amounts.push(bit); back -= bit; }
    const use = (outs || []).slice(0, amounts.length);
    return sign(use, amounts.slice(0, use.length));
  }
  /* What this mint will do on chain, and what it charges. The floor is the one
   * a real mint advertises; Foxy raises it to its own (onchainFloor). */
  const CHAIN = {
    min: 10000, max: 1000000, confirmations: 3,
    fees: [{ fee_index: 0, fee_reserve: 64, estimated_blocks: 1 },
           { fee_index: 1, fee_reserve: 24, estimated_blocks: 6 }],
  };
  // an address of the shape a payer's wallet would see, made from the quote's number
  const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function chainAddress(k) {
    let out = '';
    for (let i = 0; i < 38; i++) out += BECH32[(k * 7 + i * 11) % 32];
    return 'bc1q' + out;
  }
  const chainTxid = (quote) => String(quote).replace(/[^0-9a-f]/g, '').padStart(64, 'd');
  /* A mint quote as the mint answers it. Its state is read off the two amounts
   * rather than kept: nothing else decides whether an address has been paid. */
  const chainQuote = (q) => ({
    quote: q.quote, request: q.address, pubkey: q.pubkey, unit: 'sat', expiry: null,
    amount_paid: q.paid, amount_issued: q.issued,
    state: !q.paid && !q.issued ? 'UNPAID' : q.paid > q.issued ? 'PAID' : 'ISSUED',
  });
  function sats(bolt11) {
    const m = /^lnbc(\d+)([munp]?)1/.exec(String(bolt11));
    if (!m) return 0;
    const msat = { '': 1e11, m: 1e8, u: 1e5, n: 100, p: 0.1 }[m[2]];
    return Math.floor((Number(m[1]) * msat) / 1000);
  }
  function handle(m) {
    const p = new URL(m.url).pathname;
    const body = m.body ? JSON.parse(m.body) : {};
    const record = (outs) => posted.push({ path: p, B_: (outs || []).map((x) => x.B_) });
    const last = p.split('/').pop();
    if (p === '/v1/info') {
      /* The on-chain method sits beside bolt11 in each group, as a mint that
       * does both advertises it: the wallet has to pick it out rather than
       * take the first method it sees. */
      const methods = (extra) => [{ method: 'bolt11', unit: 'sat' }].concat(
        o.onchain ? [Object.assign({ method: 'onchain', unit: 'sat',
          min_amount: CHAIN.min, max_amount: CHAIN.max }, extra || {})] : []);
      const nuts = {
        4: { methods: methods({ options: { confirmations: CHAIN.confirmations } }), disabled: false },
        5: { methods: methods(), disabled: false },
        7: { supported: true }, 8: { supported: true }, 9: { supported: true } };
      // an on-chain quote is locked to a key of the wallet's (NUT-20), so a mint
      // that does one does the other
      if (o.onchain) nuts[20] = { supported: true };
      /* Spending conditions, for the tests that lock ecash to a key. Off by
       * default, because a mint that does not do NUT-11 is a case worth having
       * too: Foxy leaves the lock off a request such a mint would refuse. */
      if (o.p2pk) { nuts[10] = { supported: true }; nuts[11] = { supported: true }; }
      // a cap on inputs/outputs per request (NUT-06 max_array_length), when a test wants one
      const info = { name: 'fake mint', pubkey: pubs['1'], version: 'fake/1', nuts: nuts };
      if (o.maxArray > 0) info.max_array_length = o.maxArray;
      return ok(info);
    }
    if (p === '/v1/keysets') return ok({ keysets: [{ id, unit: 'sat', active: true, input_fee_ppk: Number(o.feePpk) || 0 }] });
    if (p === '/v1/keys' || p === '/v1/keys/' + id) return ok({ keysets: [{ id, unit: 'sat', active: true, keys: pubs }] });
    if (p === '/v1/mint/quote/bolt11') {
      // cashu-ts checks the invoice's amount against the quote's: amount × 10 nano-bitcoin
      const q = { quote: quoteId(), request: 'lnbc' + (Number(body.amount) * 10) + 'n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq', amount: Number(body.amount), unit: 'sat',
                  state: 'PAID', expiry: now() + 3600 };
      // a quote asked for locked comes back locked, or cashu-ts refuses it (NUT-20)
      if (typeof body.pubkey === 'string' && body.pubkey) q.pubkey = body.pubkey;
      quotes[q.quote] = q;
      return ok(q);
    }
    if (p.startsWith('/v1/mint/quote/bolt11/')) return quotes[last] ? ok(quotes[last]) : no(20007, 'quote not found');
    if (p === '/v1/mint/bolt11') {
      const q = quotes[body.quote];
      if (!q) return no(20007, 'quote not found');
      if (q.state === 'ISSUED') return no(20002, 'quote already issued');
      if (sum(body.outputs) !== q.amount) return no(11002, 'outputs do not add up to the quote');
      if (!unsigned(body.outputs)) return no(10002, 'Blinded Message is already signed.');
      record(body.outputs);
      q.state = 'ISSUED';
      return ok({ signatures: sign(body.outputs) });
    }
    /* Locked inputs have to be signed for, the way a real mint insists.
     *
     * This mint used to take a P2PK proof with no witness at all and swap it
     * happily, so every test about locks proved that Foxy *wrote* one, never that
     * anything would accept it. cashu-ts's own verifier is what says yes here:
     * not a mint, and it shares code with the signer, but it catches a missing
     * witness, a wrong key, the wrong secret signed, and SIG_ALL — which is the
     * whole class of mistake a wallet can make on its own. */
    const unauthorised = (inputs) => {
      const CT = w.CashuTS;
      if (!CT || !CT.isP2PKSpendAuthorised) return null;
      for (const pr of (inputs || [])) {
        if (String((pr && pr.secret) || '').charAt(0) !== '[') continue;
        let allowed = false;
        try { allowed = CT.isP2PKSpendAuthorised(pr); } catch (e) { allowed = false; }
        if (!allowed) {
          return pr.witness
            ? 'signature for P2PK does not verify'
            : 'no witness for a P2PK-locked proof';
        }
      }
      return null;
    };

    /* And inputs have to be this mint's own signatures. It used to take any
     * point for a C, so ecash nobody had signed swapped like the real thing and
     * no test could tell forged from issued (audit N1). */
    const counterfeit = (inputs) => (inputs || []).some((pr) => {
      const priv = pair.privKeys[String(Number(pr && pr.amount))];
      if (!priv || (pr.id && pr.id !== id)) return true;
      try {
        return !C.verifyUnblindedSignature({
          secret: new w.Uint8Array(Buffer.from(String(pr.secret), 'utf8')), C: C.pointFromHex(pr.C) }, priv);
      } catch (e) { return true; }
    });

    /* One proof named twice in a request. A real mint refuses it before it
     * looks at anything else (NUT error 11007); this one summed the amounts
     * and signed for both, so a test could mint money out of a repeat. */
    const repeated = (inputs) => {
      const seen = new Set();
      return (inputs || []).some((pr) => { const k = String(pr && pr.secret); if (seen.has(k)) return true; seen.add(k); return false; });
    };
    if ((p === '/v1/swap' || p === '/v1/melt/bolt11') && repeated(body.inputs)) return no(11007, 'Duplicate inputs provided');
    if (p === '/v1/swap') {
      // a mint that charges per piece keeps the fee: inputs minus fee is what comes out
      const swapFee = Math.ceil(((body.inputs || []).length * (Number(o.feePpk) || 0)) / 1000);
      if (sum(body.inputs) - swapFee !== sum(body.outputs)) return no(11002, 'inputs and outputs do not balance');
      if (!unsigned(body.outputs)) return no(10002, 'Blinded Message is already signed.');
      if (counterfeit(body.inputs)) return no(10003, 'Proof could not be verified.');
      const badLock = unauthorised(body.inputs);
      if (badLock) return no(11000, badLock);
      if (!spend(body.inputs)) return no(11001, 'Token already spent.');
      record(body.outputs);
      return ok({ signatures: sign(body.outputs) });
    }
    if (p === '/v1/checkstate') {
      return ok({ states: (body.Ys || []).map((Y) => ({ Y, state: spent.has(Y) ? 'SPENT' : 'UNSPENT',
                                                        witness: (spent.has(Y) && witnesses[Y]) || null })) });
    }
    if (p === '/v1/melt/quote/bolt11') {
      const q = { quote: quoteId(), amount: sats(body.request), fee_reserve: 10, state: 'UNPAID',
                  expiry: now() + 3600, request: body.request, unit: 'sat', payment_preimage: null };
      melts[q.quote] = q;
      return ok(q);
    }
    if (p.startsWith('/v1/melt/quote/bolt11/')) return melts[last] ? ok(melts[last]) : no(20007, 'quote not found');
    if (p === '/v1/melt/bolt11') {
      const q = melts[body.quote];
      if (!q) return no(20007, 'quote not found');
      if (q.state !== 'UNPAID') return no(20005, 'quote already ' + q.state);
      const paidIn = sum(body.inputs);
      if (paidIn < q.amount + q.fee_reserve) return no(11002, 'not enough inputs for the quote');
      if (!unsigned(body.outputs)) return no(10002, 'Blinded Message is already signed.');
      if (counterfeit(body.inputs)) return no(10003, 'Proof could not be verified.');
      if (!spend(body.inputs)) return no(11001, 'Token already spent.');
      record(body.outputs);
      const sigs = changeFor(body.outputs, paidIn - q.amount - 2);
      change.push(...sigs);
      Object.assign(q, { state: 'PAID', payment_preimage: o.preimage === undefined ? '00'.repeat(32) : o.preimage, change: sigs });
      return ok(q);
    }
    /* ---- on chain (NUT-30) -------------------------------------------------
     *
     * Only with o.onchain; without it these paths 404 like any other the fake
     * mint has never heard of.
     *
     * The shape matters as much as the numbers: cashu-ts refuses an answer
     * that does not carry amount_paid and amount_issued on a mint quote, or
     * fee_options, request, selected_fee_index and outpoint on a melt one, so
     * these are answered in full rather than with the fields Foxy happens to
     * read. What it does NOT do is decide: nothing is ever paid to an address
     * until a test says so, and a payout stays PENDING until a test confirms
     * it, because on chain that is a miner's decision and not a mint's. */
    if (o.onchain && p === '/v1/mint/quote/onchain') {
      const q = { quote: quoteId(), address: chainAddress(n), paid: 0, issued: 0,
                  pubkey: typeof body.pubkey === 'string' ? body.pubkey : null };
      chainIn[q.quote] = q;
      return ok(chainQuote(q));
    }
    if (o.onchain && p.startsWith('/v1/mint/quote/onchain/')) {
      return chainIn[last] ? ok(chainQuote(chainIn[last])) : no(20007, 'quote not found');
    }
    if (o.onchain && p === '/v1/mint/onchain') {
      const q = chainIn[body.quote];
      if (!q) return no(20007, 'quote not found');
      const want = sum(body.outputs);
      // what has confirmed and is not yet ecash is all there is to take
      if (want > q.paid - q.issued) return no(20002, 'the quote has only ' + (q.paid - q.issued) + ' available');
      if (!unsigned(body.outputs)) return no(10002, 'Blinded Message is already signed.');
      record(body.outputs);
      q.issued += want;
      return ok({ signatures: sign(body.outputs) });
    }
    if (o.onchain && p === '/v1/melt/quote/onchain') {
      const want = Number(body.amount) || 0;
      // the limits it advertises are the ones it keeps
      if (want < CHAIN.min || want > CHAIN.max) return no(11006, 'that is not an amount this mint will send on chain');
      const q = { quote: quoteId(), request: String(body.request || ''), amount: want,
                  unit: 'sat', state: 'UNPAID', expiry: now() + 3600,
                  // the slower the transaction may be, the less it reserves
                  fee_options: CHAIN.fees.map((f) => Object.assign({}, f)),
                  selected_fee_index: null, outpoint: null };
      chainOut[q.quote] = q;
      return ok(q);
    }
    if (o.onchain && p.startsWith('/v1/melt/quote/onchain/')) {
      return chainOut[last] ? ok(chainOut[last]) : no(20007, 'quote not found');
    }
    if (o.onchain && p === '/v1/melt/onchain') {
      const q = chainOut[body.quote];
      if (!q) return no(20007, 'quote not found');
      if (q.state !== 'UNPAID') return no(20005, 'quote already ' + q.state);
      let pick = null;
      q.fee_options.forEach((f) => { if (f.fee_index === Number(body.fee_index)) pick = f; });
      if (!pick) return no(11002, 'that fee is not one this quote offers');
      const paidIn = sum(body.inputs);
      if (paidIn < q.amount + pick.fee_reserve) return no(11002, 'not enough inputs for the quote');
      if (!unsigned(body.outputs)) return no(10002, 'Blinded Message is already signed.');
      if (!spend(body.inputs)) return no(11001, 'Token already spent.');
      record(body.outputs);
      // the reserve is a ceiling: the transaction costs half of it and the rest comes back
      const fee = Math.ceil(pick.fee_reserve / 2);
      const sigs = changeFor(body.outputs, paidIn - q.amount - fee);
      change.push(...sigs);
      /* PENDING, not PAID. The mint has the ecash and a transaction to
       * broadcast; whether it confirms is what onchainConfirm below decides. */
      Object.assign(q, { state: 'PENDING', selected_fee_index: pick.fee_index,
                         outpoint: chainTxid(q.quote) + ':0' });
      return ok(Object.assign({}, q, { change: sigs }));
    }
    if (p === '/v1/restore') {
      record(body.outputs);
      const outputs = [], signatures = [];
      for (const x of body.outputs || []) {
        const s = signed.get(x.B_);
        if (s) { outputs.push(s.out); signatures.push(s.sig); }
      }
      return ok({ outputs, signatures });
    }
    return '404\n' + JSON.stringify({ detail: 'the fake mint has no ' + m.method + ' ' + p });
  }
  return {
    id, pubs, posted, change, spentSecrets, handle,
    // the mint's books, for a wallet's holdings to be measured against
    issuedSats: () => issued,
    takenSats: () => taken,
    /* What the world does on chain, which a mint only reports: `onchainCredit`
     * is a payment to that address confirming, `onchainConfirm` is a payout's
     * transaction confirming. Both answer false for a quote it never made. */
    onchainCredit: (quote, amount) => {
      const q = chainIn[quote];
      if (!q) return false;
      q.paid += Math.round(Number(amount) || 0);
      return true;
    },
    onchainConfirm: (quote) => {
      const q = chainOut[quote];
      if (!q || q.state !== 'PENDING') return false;
      q.state = 'PAID';
      return true;
    },
  };
}

/* The native side of "the seed on the phone" (build/wallet/03-seed-counters-logs.js),
 * in node, as the app answers it: the whole contract, from a keychain that
 * holds words the page never sees.
 *
 *   const phone = nativePhone({ words, window: 1000 });
 *   phone.attach(w)                  // in loadReal's `before`, with the page's own bip39 and cashu-ts
 *   phone.answer(w, message)         // [text, error], a promise of one (a screen still open), or null
 *                                    // for an action that is not the seed's
 *   phone.background()               // Foxy went to the background: native drops every candidate
 *   phone.relaunch()                 // a new app session: what restoreSecrets served is forgotten
 *
 * NATIVE_RULES and NATIVE_SAYS below are native's rules and its words for each
 * refusal, as they stand after the native seed review's fixes, each
 * naming the Swift it mirrors. The mock follows them and nothing looser: a page
 * that passes here must pass on the phone. A page load on a new window is a
 * reload, and drops candidates as native does.
 *
 * Counters are kept per seed in memory, as native's one counter file is: the
 * file of the seed held now is `counters.get(keychain.words)`, keyed as native
 * keys it (a 00 keyset's by the first id stored for its derivation index).
 * Adopting a candidate and wiping set the old seed's aside (`aside`) and start
 * the new one's from nothing. After attach, secrets are NUT-13's, from the
 * bundled cashu-ts and bip39; without it (a page on a stubbed cashu-ts) they are
 * stand-ins, an HMAC of the words, keyset and counter, which no stub turns into
 * outputs. Candidates are ids for words that `hooks.enter()` returns (null is
 * "cancelled"). The screens answer through test hooks: `hooks.show({ verify })`
 * -> verified, `hooks.enter()` -> words, either of them a promise to keep the
 * screen open; `hooks.adopt(words)` and `hooks.wipe()` -> true for yes;
 * `hooks.unlock(action, why)` -> false for a cancelled Face ID or passcode on a
 * read of the saved seed; `hooks.refuse(message)` returning text refuses any
 * action with it. `asks` is every action asked with its message, including
 * seedRead, seedWrite, seedDelete and seedSecrets, which the app no longer has
 * and answers as unknown; `refusals` every refusal as { action, error };
 * `lowered` any counter the phone was asked to move down (it never does), and
 * `keychain` an object whose `words` the phone reads and writes (pass one in to
 * share it). */
/* Native's rules and its words for each refusal, read from the one file that
 * holds them: tests/fixtures/native-rules.json. They used to be written out
 * here as well as in the Swift, kept in step by hand; the Swift tests named in
 * that file's `where` now compare both sides, so a rule cannot change on one
 * side alone. The mock follows them and nothing looser: a page that passes
 * here must pass on the phone. */
const NATIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'native-rules.json'), 'utf8'));
const NATIVE_RULES = NATIVE.rules;
const NATIVE_SAYS = NATIVE.says;

/* A 00 keyset's derivation index, NUT13.swift keysetIndex: the id as a number,
 * mod 2^31 - 1. Every 00 id with the same index is one keyset's counters
 * (review H1). A 01 keyset is its id. */
function counterSlot(id) {
  const k = String(id).toLowerCase();
  return /^00/.test(k) ? '00:' + (BigInt('0x' + k) % (2n ** 31n - 1n)).toString() : k;
}

/* ---- the lock keys a payment request locks ecash to ------------------------
 *
 * NUT-13's P2PK path, m/129373'/10'/0'/0'/{index}, derived here from nothing but
 * node's own crypto: HMAC-SHA512 for BIP-32's CKDpriv, BigInt for the scalar
 * addition, and `createECDH('secp256k1')` for the public keys.
 *
 * A second implementation on purpose. Foxy/Keychain/P2PK.swift walks the same
 * path with libsecp256k1 and CryptoKit; if the mock called the same code, or
 * copied its answers, the two agreeing would say nothing. Written from the spec
 * separately, they agree only if both are right — and the round-trip test locks
 * ecash to a key this file derived and opens it with one the Swift derived, so a
 * difference between them is a test that fails rather than a phone that cannot
 * open its own money.
 *
 * **The last level is a NORMAL child, not a hardened one.** That is the spec and
 * it is the one thing easy to get wrong: hardened here would give a wallet whose
 * keys are perfectly self-consistent and match no other implementation.
 */
const SECP_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

function secpPublic(privateKey) {
  const e = crypto.createECDH('secp256k1');
  e.setPrivateKey(Buffer.from(privateKey));
  return e.getPublicKey(null, 'compressed');
}

/* BIP-32's CKDpriv. A hardened index hashes 0x00 || k; a normal one hashes the
 * compressed public key of k, which is the whole difference. */
function bip32Child(node, index) {
  const data = Buffer.alloc(37);
  if (index >= 0x80000000) node.key.copy(data, 1);
  else secpPublic(node.key).copy(data, 0);
  data.writeUInt32BE(index >>> 0, 33);
  const mac = crypto.createHmac('sha512', node.chain).update(data).digest();
  const tweak = BigInt('0x' + mac.subarray(0, 32).toString('hex'));
  const child = (tweak + BigInt('0x' + Buffer.from(node.key).toString('hex'))) % SECP_ORDER;
  if (tweak >= SECP_ORDER || child === 0n) throw new Error('an invalid BIP-32 child');
  return { key: Buffer.from(child.toString(16).padStart(64, '0'), 'hex'), chain: mac.subarray(32) };
}

/* The four hardened levels, which every index shares. */
function p2pkParent(seed) {
  const mac = crypto.createHmac('sha512', 'Bitcoin seed').update(Buffer.from(seed)).digest();
  let node = { key: mac.subarray(0, 32), chain: mac.subarray(32) };
  for (const level of [129373, 10, 0, 0]) node = bip32Child(node, level + 0x80000000);
  return node;
}

function p2pkAt(parent, index) {
  const child = bip32Child(parent, index);
  return { priv: child.key.toString('hex'), pub: secpPublic(child.key).toString('hex') };
}

/* ---- the owner key and the time key (P-256) --------------------------------
 *
 * What the phone's native side does for a card, as Foxy/Keychain (CardOwner) and
 * Foxy/Flashcard/CardTime.swift do it, with Node's own crypto, and held to the
 * same fixture (tests/fixtures/card-owner-vectors.json). A card's owner key is
 * derived per card from the seed and never leaves native; the page gets the
 * public half and signatures, and that is what these answer. */
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
/* The labels native signs for, and no others (never "lock", never "time"). */
const CARD_LABELS = ['change-pin', 'set-limit', 'set-owner', 'set-card', 'load'];
/* INTERIM: the private half of the key a card's time is signed by. It is built into the app, so it is no secret
 * (Foxy/Flashcard/CardTime.swift holds the same value, and tests/flashcard-daily.js holds the two together). */
const INTERIM_TIME_PRIVATE = '5d3aa8864437b69bc699905ded587014b3d1f7e0de402684e5eec162d540b2ca';

function cardOwnerScalar(seed, cardKeyHex) {
  for (let counter = 0; ; counter++) {
    const message = Buffer.concat([Buffer.from('FoxyCard/owner', 'utf8'), Buffer.from([0]), Buffer.from(cardKeyHex, 'hex'),
      counter ? Buffer.from([counter]) : Buffer.alloc(0)]);
    const d = BigInt('0x' + crypto.createHmac('sha256', seed).update(message).digest('hex')) % P256_ORDER;
    if (d !== 0n) return d;
  }
}
const scalarBytes = (d) => Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
function p256Public(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(scalarBytes(d));
  return ecdh.getPublicKey('hex', 'uncompressed');
}
function p256Sign(d, message) {
  const pub = Buffer.from(p256Public(d), 'hex');
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: scalarBytes(d).toString('base64url'),
    x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  return crypto.sign('sha256', message, { key, dsaEncoding: 'der' }).toString('hex');
}
/* Whether `sig` (DER hex) is a good signature over `message` by the P-256 public key `pubHex` (04 || X || Y). */
function p256Verify(pubHex, message, sig) {
  try {
    const pub = Buffer.from(pubHex, 'hex');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
    return crypto.verify('sha256', message, { key, dsaEncoding: 'der' }, Buffer.from(sig, 'hex'));
  } catch (e) { return false; }
}

function nativePhone(opts) {
  const o = opts || {};
  const R = NATIVE_RULES, SAYS = NATIVE_SAYS;
  const keychain = o.keychain || { words: o.words || '' };
  const phone = {
    keychain,
    rules: R,
    window: o.window || R.window,
    candidateMax: o.candidateMax || R.candidateCap,
    counters: new Map(),        // words -> Map(keysetId -> next): each seed's counter file
    locks: new Map(),           // words -> next: each seed's foxy-p2pk.json
    lockServed: 0,              // the end of the furthest p2pkPubkeys range this app session
    aside: [],
    candidates: new Map(),      // id -> { words, served: Map(slot -> highest end) }
    served: new Map(),          // slot -> the highest end restoreSecrets served for the saved seed this app session
    imported: false,            // countersImport has run on this install
    asks: [],
    said: [],                   // what the phone answered, action by action: a test can look for a secret in it
    refusals: [],
    lowered: [],
    screen: null,               // the seed screen open or queued: { close }
    faceIdCancelledAt: null,
    now: () => Date.now(),
    /* The phone's own clock, in milliseconds, which `cardTime` signs: the real one unless a test sets `clockMs`. */
    clockMs: () => Date.now(),
    page: null,
    hooks: { enter: null, show: null, adopt: null, wipe: null, refuse: null, unlock: null },
    toSeed: null, generate: null, wordlist: null, derive: null, validate: null,
    /* seedMigrate's one-time window (SeedMigrationWindow.swift): open as on an
     * install that had page storage before this launch (o.migration false:
     * closed from the start). Closed by an answer about the words (migrated,
     * same, different), by seedStatus finding a seed, by seedCreate, and by an
     * adopt; never by an error. */
    migrationOpen: o.migration !== false,
  };
  const seeds = new Map();
  let made = 0, generated = 0;
  // stand-ins until attach: never NUT-13, and never needed to be
  const standIn = {
    toSeed: (words) => crypto.createHash('sha512').update('stand-in seed|' + words).digest(),
    derive: (seed, id, counter) => ({
      secret: crypto.createHmac('sha256', seed).update(id + '|' + counter + '|secret').digest(),
      blindingFactor: crypto.createHmac('sha256', seed).update(id + '|' + counter + '|r').digest(),
    }),
    generate: () => Array(11).fill('zoo').concat(['wrong' + (++generated)]).join(' '),
    validate: (x) => typeof x === 'string' && x.trim().split(/\s+/).length === 12,
  };
  const toSeed = (words) => (phone.toSeed || standIn.toSeed)(words);
  const derive = (seed, id, counter) => (phone.derive || standIn.derive)(seed, id, counter);
  const generate = () => (phone.generate || standIn.generate)();
  const validate = (x) => (phone.validate || standIn.validate)(x);
  const WORDS = new Set(['seedRead', 'seedWrite', 'seedDelete', 'seedSecrets']);
  const hex = (b) => Buffer.from(Array.from(b)).toString('hex');
  const goodId = (id) => typeof id === 'string' && /^(00[0-9a-f]{14}|01[0-9a-f]{64})$/i.test(id);
  const int = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  const largest = (id) => R.largestNext[String(id).slice(0, 2)];
  const ok = (j) => [JSON.stringify(j), null];
  const no = (why) => [null, why];
  const words = () => keychain.words;
  // the seed held now, as native derives from it
  const seedNow = () => {
    const seedKey = (phone.toSeed ? 'real|' : 'stand-in|') + words();
    if (!seeds.has(seedKey)) seeds.set(seedKey, toSeed(words()));
    return Buffer.from(seeds.get(seedKey));
  };

  /* The counter file of the seed held now, and native's keying of it. */
  const book = (w) => {
    if (!phone.counters.has(w)) phone.counters.set(w, new Map());
    return phone.counters.get(w);
  };
  const keyIn = (b, id) => {
    const slot = counterSlot(id);
    for (const key of b.keys()) if (counterSlot(key) === slot) return key;
    return null;
  };
  const nextIn = (b, id) => { const key = keyIn(b, id); return key === null ? 0 : b.get(key); };
  /* Stored under the first id seen for its index; false when that would be a keyset past the cap. */
  const store = (b, id, n) => {
    const key = keyIn(b, id);
    if (key === null && b.size >= R.keysets) return false;
    b.set(key === null ? id.toLowerCase() : key, n);
    return true;
  };
  const snapshot = () => Object.fromEntries(book(words()));
  const unlock = (action, why) => !phone.hooks.unlock || phone.hooks.unlock(action, why) !== false;
  const closeWindow = () => { phone.migrationOpen = false; };
  /* A seed change: native closes any seed screen (verified false, cancelled) and
   * forgets what it served for the seed before. */
  const seedChanged = () => {
    phone.served.clear();
    if (phone.screen) phone.screen.close();
  };
  /* CounterStore.moveAside: both files, and the served window cleared. The lock
   * index goes with the counters because the seed it belonged to is going. */
  const moveAside = (w) => {
    const b = phone.counters.get(w);
    if (b && b.size) phone.aside.push({ words: w, counters: Object.fromEntries(b), locks: phone.locks.get(w) || 0 });
    phone.counters.delete(w);
    phone.locks.delete(w);
    phone.lockServed = 0;
  };

  phone.attach = (w) => {
    // before the page wraps or replaces its libraries: the phone's own copy of each
    const B = w.FoxyBip39;
    phone.toSeed = B.mnemonicToSeedSync;
    phone.generate = () => B.generateMnemonic(B.wordlist, 128);
    phone.validate = (x) => B.validateMnemonic(x, B.wordlist);
    phone.derive = w.CashuTS.deriveSecretAndBlindingFactor;
  };
  phone.background = () => { phone.candidates.clear(); };
  phone.relaunch = () => {
    phone.candidates.clear();
    phone.served.clear();
    phone.lockServed = 0;
    phone.page = null;
  };

  /* The lock keys of one seed, derived once and kept: node's ECDH is slow
   * enough that a 20,000-index walk twice over would be felt. The Swift derives
   * them afresh every time; caching here changes no answer. */
  const lockParents = new Map();
  const lockKeys = new Map();

  function lockKeyAt(w, index) {
    const at = w + '|' + index;
    if (lockKeys.has(at)) return lockKeys.get(at);
    const seedKey = (phone.toSeed ? 'real|' : 'stand-in|') + w;
    if (!seeds.has(seedKey)) seeds.set(seedKey, toSeed(w));
    if (!lockParents.has(seedKey)) lockParents.set(seedKey, p2pkParent(seeds.get(seedKey)));
    const pair = p2pkAt(lockParents.get(seedKey), index);
    lockKeys.set(at, pair);
    return pair;
  }

  const lockPubs = (w, start, count) => {
    const out = [];
    for (let i = 0; i < count; i++) out.push(lockKeyAt(w, start + i).pub);
    return out;
  };
  /* P2PK.largestNext: a normal BIP-32 index stops one below the hardened half,
   * which is the same 2^31 a 00 keyset's hardened counters stop at. */
  const lockCeiling = R.largestNext['00'];

  function secrets(w, m, start, count) {
    const key = (phone.toSeed ? 'real|' : 'stand-in|') + w;
    if (!seeds.has(key)) seeds.set(key, toSeed(w));
    const seed = seeds.get(key);
    const id = m.keysetId.toLowerCase();
    const s = [], r = [];
    for (let i = 0; i < count; i++) {
      const d = derive(seed, id, start + i);
      s.push(hex(d.secret));
      r.push(hex(d.blindingFactor));
    }
    // native echoes the id as sent; `shout` echoes it in uppercase, to see the page not mind
    return [JSON.stringify({ keysetId: phone.shout ? m.keysetId.toUpperCase() : m.keysetId, start, secrets: s, blindingFactors: r }), null];
  }
  // NativeSeedBridge.swift counterRangeCheck: an id native derives for, count 1..1000, every counter inside the version's
  const rangeOk = (m, least) => goodId(m.keysetId) && int(m.start, 0, Number.MAX_SAFE_INTEGER) &&
    int(m.count, least, R.batch) && m.start + m.count <= largest(m.keysetId);

  /* A seed screen: `value` a hook's answer, or a promise of one while the screen stays open. */
  function screen(value, done, closed) {
    if (!value || typeof value.then !== 'function') return done(value);
    return new Promise((res) => {
      let settled = false;
      const finish = (out) => { if (settled) return; settled = true; phone.screen = null; res(out); };
      phone.screen = { close: () => finish(closed()) };
      value.then((v) => finish(done(v)), () => finish(closed()));
    });
  }

  const RULES = {
    // NativeSeedBridge.swift handleSeedStatus: a seed found closes the migration window
    seedStatus() {
      if (words()) closeWindow();
      return ok({ exists: !!words() });
    },
    // NativeSeedBridge.swift createSeed: counters with no seed beside them go aside; the window closes
    seedCreate() {
      if (words()) return no(SAYS.exists);
      moveAside('');
      keychain.words = generate();
      phone.counters.delete(keychain.words);
      phone.locks.delete(keychain.words);
      closeWindow();
      seedChanged();
      return ok({ created: true });
    },
    /* NativeSeedBridge.swift handleSeedMigrate, SeedMigrationWindow.swift. With
     * the window closed it still compares with a saved seed (review M4); only
     * writing needs it open. An error never closes it. */
    seedMigrate(m) {
      if (!phone.migrationOpen && !words()) return no(SAYS.noMigration);
      // seedMigrateCheck: a string or an array of words, capitals folded, spaces collapsed
      const list = typeof m.words === 'string' ? m.words.split(/\s+/) : Array.isArray(m.words) ? m.words : null;
      const given = list && list.every((x) => typeof x === 'string') ? list.map((x) => x.trim().toLowerCase()).filter(Boolean).join(' ') : '';
      if (!given || !validate(given)) return no(SAYS.bad);
      if (!words()) {
        keychain.words = given;
        // native's one counter file stays: counters imported before now are these words'
        if (phone.counters.has('')) { phone.counters.set(given, phone.counters.get('')); phone.counters.delete(''); }
        closeWindow();
        return ok({ migrated: true });
      }
      if (!unlock('seedMigrate', 'read')) return no(SAYS.unreadable);
      closeWindow();
      return given === words() ? ok({ migrated: false, same: true }) : ok({ migrated: false, different: true });
    },
    // NativeSeedBridge.swift handleCountersImport, CounterStore importMax: no seed needed, once per install
    countersImport(m) {
      const c = m.counters;
      if (!c || typeof c !== 'object' || Array.isArray(c) || Object.entries(c).some(([k, v]) => !goodId(k) || !int(v, 0, Number.MAX_SAFE_INTEGER))) return no(SAYS.bad);
      if (phone.imported) return no(SAYS.imported);
      const b = book(words()), trial = new Map(b);
      for (const [k, v] of Object.entries(c)) {
        if (!store(trial, k, Math.max(nextIn(trial, k), Math.min(v, largest(k))))) return no(SAYS.keysets);
      }
      phone.counters.set(words(), trial);
      phone.imported = true;
      return ok({ counters: snapshot() });
    },
    // handleCounterReserve: a count of 0 is a peek, with no seed read and nothing moved
    counterReserve(m) {
      if (!goodId(m.keysetId) || !int(m.count, 0, R.batch)) return no(SAYS.bad);
      const b = book(words()), next = nextIn(b, m.keysetId);
      if (m.count === 0) return secrets(words(), m, next, 0);
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('counterReserve', 'read')) return no(SAYS.unreadable);
      if (next + m.count > largest(m.keysetId)) return no(SAYS.outOfRange);
      if (!store(b, m.keysetId, next + m.count)) return no(SAYS.keysets);
      return secrets(words(), m, next, m.count);
    },
    // handleCounterReserveAt, CounterStore reserve(at:): below next is issued, more than 100 past it too far
    counterReserveAt(m) {
      if (!rangeOk(m, 1)) return no(SAYS.bad);
      const b = book(words()), next = nextIn(b, m.keysetId);
      if (m.start < next) return no(SAYS.issued);
      if (m.start > next + R.ahead) return no(SAYS.ahead);
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('counterReserveAt', 'read')) return no(SAYS.unreadable);
      if (!store(b, m.keysetId, m.start + m.count)) return no(SAYS.keysets);
      return secrets(words(), m, m.start, m.count);
    },
    /* handleCounterAdvance, CounterStore advance: never down; up to 100 past
     * next, or to the highest end restoreSecrets served this session, and never
     * past the version's largest next. No seed read. */
    counterAdvance(m) {
      if (!goodId(m.keysetId) || !int(m.next, 0, Number.MAX_SAFE_INTEGER)) return no(SAYS.bad);
      const b = book(words()), now = nextIn(b, m.keysetId);
      if (m.next < now) phone.lowered.push({ keysetId: m.keysetId.toLowerCase(), asked: m.next, was: now });
      if (m.next > now) {
        if (m.next > largest(m.keysetId)) return no(SAYS.outOfRange);
        if (m.next > Math.max(now + R.ahead, phone.served.get(counterSlot(m.keysetId)) || 0)) return no(SAYS.ahead);
        if (!store(b, m.keysetId, m.next)) return no(SAYS.keysets);
      }
      return ok({ keysetId: m.keysetId, next: Math.max(now, m.next) });
    },
    // handleCounterSnapshot: no seed read
    counterSnapshot() {
      return ok({ counters: snapshot() });
    },
    /* handleRestoreSecrets, RestoreWindow: the saved seed up to next + 1000 (and
     * what it served raises how far counterAdvance may go); a candidate from 0,
     * 1000 past what it was served, 20,000 a keyset. */
    restoreSecrets(m) {
      if (!rangeOk(m, 1)) return no(SAYS.bad);
      const slot = counterSlot(m.keysetId);
      if (m.candidate != null) {
        if (typeof m.candidate !== 'string' || !m.candidate) return no(SAYS.bad);
        const cand = phone.candidates.get(m.candidate);
        if (!cand) return no(SAYS.unknown);
        const served = cand.served.get(slot) || 0;
        if (m.start > served + phone.window || m.start + m.count > phone.candidateMax) return no(SAYS.window);
        cand.served.set(slot, Math.max(served, m.start + m.count));
        return secrets(cand.words, m, m.start, m.count);
      }
      if (m.start + m.count > nextIn(book(words()), m.keysetId) + phone.window) return no(SAYS.window);
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('restoreSecrets', 'read')) return no(SAYS.unreadable);
      phone.served.set(slot, Math.max(phone.served.get(slot) || 0, m.start + m.count));
      return secrets(words(), m, m.start, m.count);
    },
    /* handleP2PKReserve, SeedActions.p2pkReserve: `next ..< next + count`,
     * written first, public halves only. A count of 0 is a peek, with no seed
     * read and nothing moved. The seed is read before the range is checked, as
     * the Swift does. */
    p2pkReserve(m) {
      if (!int(m.count, 0, R.lockBatch)) return no(SAYS.bad);
      const next = phone.locks.get(words()) || 0;
      if (m.count === 0) return ok({ start: next, next: next, pubkeys: [] });
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('p2pkReserve', 'read')) return no(SAYS.unreadable);
      if (next + m.count > lockCeiling) return no(SAYS.outOfRange);
      phone.locks.set(words(), next + m.count);
      return ok({ start: next, next: next + m.count, pubkeys: lockPubs(words(), next, m.count) });
    },
    /* handleP2PKPubkeys, SeedActions.p2pkPubkeys: public halves for exactly that
     * range, moving nothing, and the range noted so p2pkKey will answer inside
     * it. This is the walk a restore does to find which index a token in hand is
     * locked to. */
    p2pkPubkeys(m) {
      if (!int(m.start, 0, Number.MAX_SAFE_INTEGER) || !int(m.count, 1, R.lockScan) ||
          m.start + m.count > R.lockCap) return no(SAYS.bad);
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('p2pkPubkeys', 'read')) return no(SAYS.unreadable);
      const keys = lockPubs(words(), m.start, m.count);
      phone.lockServed = Math.max(phone.lockServed, m.start + m.count);
      return ok({ start: m.start, next: phone.locks.get(words()) || 0, pubkeys: keys });
    },
    /* handleP2PKKey, SeedActions.p2pkKey: one index's private half, inside 1000
     * of the last index reserved or inside a range this session's walk served.
     * The window is checked before the seed is read, as the Swift does. */
    p2pkKey(m) {
      if (!int(m.index, 0, lockCeiling - 1)) return no(SAYS.bad);
      const next = phone.locks.get(words()) || 0;
      if (!(m.index < phone.lockServed || m.index < next + R.window)) return no(SAYS.lockWindow);
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('p2pkKey', 'read')) return no(SAYS.unreadable);
      const pair = lockKeyAt(words(), m.index);
      return ok({ index: m.index, privkey: pair.priv, pubkey: pair.pub });
    },
    /* handleCardOwnerKey, SeedActions.cardOwnerKey: the owner PUBLIC key for a
     * card, 04 || X || Y. The private half is HMAC-SHA256 keyed with the seed over
     * "FoxyCard/owner", a zero byte and the card's key (33 bytes), taken mod the
     * order of P-256, and it never leaves here: the key is checked before the seed
     * is read, no counter moves and no window applies. */
    cardOwnerKey(m) {
      const key = typeof m.key === 'string' ? m.key.toLowerCase() : '';
      if (!/^0[23][0-9a-f]{64}$/.test(key)) return no(SAYS.bad);
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('cardOwnerKey', 'read')) return no(SAYS.unreadable);
      return ok({ pub: p256Public(cardOwnerScalar(seedNow(), key)) });
    },
    /* handleCardOwnerSign, SeedActions.cardOwnerSign: a signature (ECDSA, SHA-256,
     * DER) over "FoxyCard/" + label || nonce (16) || value, for one of five fixed
     * labels and the shape each takes. Every check comes before the seed is read.
     * Nothing else is signed: not "lock", not "time". */
    cardOwnerSign(m) {
      const key = typeof m.key === 'string' ? m.key.toLowerCase() : '';
      if (!/^0[23][0-9a-f]{64}$/.test(key)) return no(SAYS.bad);
      if (typeof m.label !== 'string' || !CARD_LABELS.includes(m.label)) return no(SAYS.bad);
      if (typeof m.nonce !== 'string' || !/^[0-9a-f]{32}$/i.test(m.nonce)) return no(SAYS.bad);
      if (typeof m.value !== 'string' || !/^([0-9a-f]{2})*$/i.test(m.value)) return no(SAYS.bad);
      const value = Buffer.from(m.value, 'hex');
      const shaped = {
        'change-pin': value.length >= 4 && value.length <= 8 && value.every((b) => b >= 0x30 && b <= 0x39),
        'set-limit': value.length === 4,
        'set-owner': value.length === 65 && value[0] === 4,
        'set-card': value.length >= 101 && value.length <= 180 && value[99] >= 1 && value[99] <= 80 && value.length === 100 + value[99] && value[34] === 4,
        'load': value.length === 0,
      }[m.label];
      if (!shaped) return no(SAYS.bad);
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('cardOwnerSign', 'read')) return no(SAYS.unreadable);
      const message = Buffer.concat([Buffer.from('FoxyCard/' + m.label, 'ascii'), Buffer.from(m.nonce, 'hex'), value]);
      return ok({ sig: p256Sign(cardOwnerScalar(seedNow(), key), message) });
    },
    /* handleCardTime, CardTime.swift: the phone's own clock, signed by the INTERIM
     * time key over "FoxyCard/time" || the time (4 bytes, big-endian). No seed. */
    cardTime() {
      const time = Math.floor(phone.clockMs() / 1000);
      const message = Buffer.concat([Buffer.from('FoxyCard/time', 'ascii'), Buffer.from([time >>> 24, (time >>> 16) & 255, (time >>> 8) & 255, time & 255])]);
      return ok({ time, sig: p256Sign(BigInt('0x' + INTERIM_TIME_PRIVATE), message) });
    },
    // handleSeedShow, SeedScreens: one screen at a time, and none within 10 s of a cancelled Face ID
    seedShow(m) {
      if (phone.screen) return no(SAYS.screenOpen);
      if (phone.faceIdCancelledAt != null && phone.now() - phone.faceIdCancelledAt < R.showAfterCancelMs) return no(SAYS.again);
      if (!words()) return no(SAYS.noSeed);
      if (!unlock('seedShow', 'read')) { phone.faceIdCancelledAt = phone.now(); return no(SAYS.unreadable); }
      const shown = phone.hooks.show ? phone.hooks.show({ verify: !!m.verify }) : !!m.verify;
      return screen(shown, (v) => ok({ verified: !!v }), () => ok({ verified: false }));
    },
    /* handleSeedEnter: one screen at a time, at most two candidates. Words Foxy
     * itself copied are refused on the screen (review M8), which needs nothing
     * from the page: here that is hooks.enter returning null. */
    seedEnter() {
      if (phone.screen) return no(SAYS.screenOpen);
      if (phone.candidates.size >= R.candidates) return no(SAYS.full);
      const typed = phone.hooks.enter ? phone.hooks.enter() : null;
      return screen(typed, (t) => {
        if (!t || !validate(t)) return no(SAYS.cancelled);
        if (phone.candidates.size >= R.candidates) return no(SAYS.full);
        const id = 'candidate-' + (++made);
        phone.candidates.set(id, { words: t, served: new Map() });
        return ok({ candidate: id });
      }, () => no(SAYS.cancelled));
    },
    /* handleSeedAdopt: same, or the Replace alert and then Face ID or the
     * passcode. Adopted or same, each counter is raised to at least 1000 short of
     * what the candidate was served (review M2), and the candidate is kept until the page
     * forgets it (M6); the other candidates go with the seed write. */
    seedAdopt(m) {
      if (typeof m.candidate !== 'string' || !m.candidate) return no(SAYS.bad);
      const cand = phone.candidates.get(m.candidate);
      if (!cand) return no(SAYS.unknown);
      const raise = () => {
        const b = book(words());
        for (const [slot, end] of cand.served) {
          // served is kept by slot; the counter file by the first id stored for it
          const id = cand.ids && cand.ids.get(slot);
          // RestoreWindow.adoptedCounters: 1000 short of what was served, the end of
          // the scan's last batch with a signature, inside every restore's reach
          const to = Math.max(0, end - phone.window);
          if (id && to > nextIn(b, id)) store(b, id, to);
        }
      };
      if (words() && !unlock('seedAdopt', 'read')) return no(SAYS.unreadable);
      if (cand.words === words()) {
        raise();
        closeWindow();
        return ok({ adopted: false, same: true });
      }
      if (phone.hooks.adopt && !phone.hooks.adopt(cand.words)) return no(SAYS.unchanged);
      if (words() && !unlock('seedAdopt', 'replace')) return no(SAYS.unchanged);
      moveAside(words());
      keychain.words = cand.words;
      phone.counters.delete(cand.words);
      phone.locks.delete(cand.words);
      for (const id of [...phone.candidates.keys()]) if (id !== m.candidate) phone.candidates.delete(id);
      closeWindow();
      seedChanged();
      raise();
      return ok({ adopted: true });
    },
    // handleSeedCandidateForget: known or not
    seedCandidateForget(m) {
      if (typeof m.candidate !== 'string' || !m.candidate) return no(SAYS.bad);
      phone.candidates.delete(m.candidate);
      return ok({ forgotten: true });
    },
    // handleSeedWipe: the Delete alert, then the seed, every candidate and the counters go, and a new seed is made
    seedWipe() {
      if (phone.hooks.wipe && !phone.hooks.wipe()) return no(SAYS.notErased);
      moveAside(words());
      phone.candidates.clear();
      keychain.words = generate();
      phone.counters.delete(keychain.words);
      phone.locks.delete(keychain.words);
      closeWindow();
      seedChanged();
      return ok({ wiped: true, created: true });
    },
  };

  phone.answer = function (w, m) {
    if (!RULES[m.action] && !WORDS.has(m.action)) return null;
    // a page loaded again: native drops the candidates (SeedVault.forgetNativeSeed on a reload)
    if (w && phone.page !== w) { if (phone.page) phone.candidates.clear(); phone.page = w; }
    phone.asks.push(Object.assign({}, m));
    const said = (got) => { if (got[1]) phone.refusals.push({ action: m.action, error: got[1] }); else phone.said.push({ action: m.action, text: got[0] }); return got; };
    if (WORDS.has(m.action)) return said(no('Unknown action: ' + m.action));
    const refusal = phone.hooks.refuse && phone.hooks.refuse(m);
    if (refusal) return said(no(refusal));
    // a candidate's served ranges are kept by slot; remember an id for each, to raise the counter file by
    if (m.action === 'restoreSecrets' && m.candidate && goodId(m.keysetId) && phone.candidates.has(m.candidate)) {
      const cand = phone.candidates.get(m.candidate);
      cand.ids = cand.ids || new Map();
      if (!cand.ids.has(counterSlot(m.keysetId))) cand.ids.set(counterSlot(m.keysetId), m.keysetId.toLowerCase());
    }
    const got = RULES[m.action](m);
    return got && typeof got.then === 'function' ? got.then(said) : said(got);
  };
  /* The counters of the seed the phone holds now, { keysetId: next }. */
  phone.countersNow = () => Object.fromEntries(phone.counters.get(keychain.words) || new Map());
  /* One keyset's next counter, by any id with its index. */
  phone.nextOf = (id) => nextIn(phone.counters.get(keychain.words) || new Map(), id);
  return phone;
}

module.exports = { load, proof, stubCashu, connected, loadReal, fakeMint, books, booksWrong, rebook, noBooks, nativePhone, NATIVE_RULES, NATIVE_SAYS, counterSlot, PHONE_WORDS,
                   p2pkParent, p2pkAt, cardOwnerScalar, p256Public, p256Sign, p256Verify, INTERIM_TIME_PRIVATE, CARD_LABELS };
