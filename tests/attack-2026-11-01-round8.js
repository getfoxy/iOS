'use strict';
/* attack-2026-11-01-round8.js — round eight of the attack, on 5b97fb3 (the round-7 fixes).
 *
 *     node tests/attack-2026-11-01-round8.js
 *
 * Every case but the controls (marked "control") and the measurements (marked "sound") fails on 5b97fb3: each is a
 * finding in .claude/audits/attack-2026-11-01-round8.md, named by its letter.
 *
 *   L1 a claim at another mint (the away walk `_sweepAway`, the away watch, TRY AGAIN) that meets signatures that do
 *      not verify is reported by the proof lock's wrapper (99-proof-lock-and-export.js) against the mint the phone is
 *      on (`hostOf(mintUrl)`): THIS MINT SENT INVALID SIGNATURES names home, and tells the person to move their
 *      balance away from it.
 *   L2 a payment claimed at another mint by the away walk, told while a crossing or a carry home has the page quiet
 *      (`_quiet`, `_hushUntil`), is never said: the hush drops it before `announcePayment` marks it, and the crossing's
 *      `hushSweepEntries` has already marked its row seen, so neither the away path nor the history pass at that
 *      mint ever raises it. Home's balance does not move for it (round 7's L2 outcome, by another door).
 *   L3 the away announcement (`onSwept` → `announcePayment`) skips none of what the history pass skips: a leg of a
 *      swap between balances claimed at another mint is raised as a payment received.
 *
 *   P1 (pre-existing, 0e2a50b) `keepQuote` keeps the newest 500 of the archive, blind to what they are: a paid invoice
 *      waiting for TRY AGAIN (or at a mint that is down) is dropped, with its NUT-20 key, by 551 newer unpaid invoices
 *      (a till's dollar receive screen, about nine hours with no sweep).
 *   W1-W4 words added in the seven rounds.
 *
 * Measured and sound (S1): the proof lock under the away walk and a tap's token arriving during it.
 *
 * Added with the fixes: L2b (the held claim said when the quiet ends), L3's two-balances control and L3b (a marked
 * swap leg), and P1b (600 expired invoices leave a paid one at another mint for `_sweepAway`).
 *
 * Methods are lifted out of build/foxy-app.js, as rounds 1-7 do; L1, L1b, S1 and P1 run the real wallet against fake mints
 * (tests/harness.js).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function method(sig) {
  const at = app.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = app.indexOf('{', at + sig.length - 1), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) break; }
  }
  return app.slice(at + 3, i + 1);
}
const lift = (sigs) => new Function('return {' + sigs.map(method).join(',\n') + '}')();

const HOME = 'https://home.test';
const THEIR = 'https://their.test';
const OTHER = 'https://other.test';

/* The real wallet, at HOME, with THEIR and OTHER beside it. `o.mangle(m, text)`: rewrites a mint's answer.
 * `o.delay[origin]`: that mint answers after so many ms. `o.seen`: every request. */
function realPhone(o) {
  const opts = o || {};
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ph = nativePhone({ words: PHONE_WORDS });
  const mints = {};
  const seen = opts.seen || [];
  const delay = opts.delay || {};
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const u = new URL(m.url);
        seen.push({ at: Date.now(), url: m.url, method: m.method });
        const mint = mints[u.origin];
        if (!mint) return reply(w, m.id, null, 'no such mint in this test');
        let text = mint.handle(m);
        if (opts.mangle) text = opts.mangle(m, text);
        const d = delay[u.origin] || 0;
        if (d) return setTimeout(() => w.FoxyWallet._scanResult(m.id, text, null), d);
        return reply(w, m.id, text);
      }
      const got = ph.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      ph.attach(w);
      mints[HOME] = fakeMint(w, { fill: 7, quotesUnpaid: true });
      mints[THEIR] = fakeMint(w, { fill: 9, quoteFrom: 5000, quotesUnpaid: true });
      mints[OTHER] = fakeMint(w, { fill: 11, quoteFrom: 9000, quotesUnpaid: true });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return { ctx, W: ctx.W, mints, seen, delay };
}

async function at(p, u, remember) {
  await p.W.connect(u, null, null, { remember: remember });
  await wait(300);
}
// an invoice made at `where` on a visit, the phone home again, and the invoice paid there
async function madeAway(p, where, sats) {
  await at(p, HOME, true);
  await at(p, where, false);
  const inv = await p.W.invoice(sats || 1000, '');
  await at(p, HOME, true);
  p.mints[where].payQuote(inv.hash);
  return inv;
}

/* L1. Signatures that do not verify, at another mint. */
async function l1() {
  console.log('L1. invalid signatures from another mint, claimed from home');
  let bad = false;
  const flip = (h) => (h[0] === '0' ? '1' : '0') + h.slice(1);
  const p = realPhone({
    mangle: (m, text) => {
      if (!bad || m.method !== 'POST' || m.url !== THEIR + '/v1/mint/bolt11') return text;
      const nl = text.indexOf('\n');
      const body = JSON.parse(text.slice(nl + 1));
      (body.signatures || []).forEach((s) => { if (s.dleq) s.dleq.s = flip(s.dleq.s); });
      return text.slice(0, nl) + '\n' + JSON.stringify(body);
    },
  });
  const inv = await madeAway(p, THEIR);
  const trouble = [];
  p.W.onMintTrouble((t) => trouble.push(t));
  bad = true;
  try { await p.W.sweepQuotes(); } catch (e) {}
  await wait(50);
  const rec = (JSON.parse(p.ctx.storage.getItem('foxy.cashu.quotes') || '[]') || []).filter((q) => q.quote === inv.hash)[0];
  ok('L1 (control) their mint’s signatures fail the check and nothing is kept: the record is marked, their pile is empty',
    p.W.balanceAt(THEIR) === 0 && !!rec && !!rec.unclaimed && !!rec.unclaimed.badSignatures,
    'their pile ' + p.W.balanceAt(THEIR) + ', record ' + JSON.stringify(rec && rec.unclaimed));
  const named = trouble.filter((t) => t && t.badSignatures).map((t) => t.mint);
  ok('L1 a Lightning invoice claimed away: THIS MINT SENT INVALID SIGNATURES never names the mint the phone is on',
    named.length > 0 && named.every((m) => /their\.test/.test(m)),
    'raised for ' + JSON.stringify(named) + ' in that order (phone on home.test; the signatures came from their.test): '
      + 'the wrapper reports `hostOf(mintUrl)` first; noteClaimTrouble’s card for their.test replaces it, and '
      + '"home.test|claim" is spent in `badSigTold` for the session');
}

/* L1b. The same, for an on-chain deposit to an address made on a visit (`onchainClaimAway`): nothing corrects it. */
async function l1b() {
  console.log('L1b. invalid signatures from another mint, on an on-chain deposit claimed from home');
  let bad = false;
  const flip = (h) => (h[0] === '0' ? '1' : '0') + h.slice(1);
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ph = nativePhone({ words: PHONE_WORDS });
  const mints = {};
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const u = new URL(m.url);
        const mint = mints[u.origin];
        if (!mint) return reply(w, m.id, null, 'no such mint in this test');
        let text = mint.handle(m);
        if (bad && m.method === 'POST' && m.url === THEIR + '/v1/mint/onchain') {
          const nl = text.indexOf('\n');
          const body = JSON.parse(text.slice(nl + 1));
          (body.signatures || []).forEach((s) => { if (s.dleq) s.dleq.s = flip(s.dleq.s); });
          text = text.slice(0, nl) + '\n' + JSON.stringify(body);
        }
        return reply(w, m.id, text);
      }
      const got = ph.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      ph.attach(w);
      mints[HOME] = fakeMint(w, { fill: 7, quotesUnpaid: true, onchain: true });
      mints[THEIR] = fakeMint(w, { fill: 9, quoteFrom: 5000, quotesUnpaid: true, onchain: true });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  const p = { W: ctx.W };
  await at(p, HOME, true);
  await at(p, THEIR, false);
  const addr = await p.W.onchainAddress();
  await at(p, HOME, true);
  mints[THEIR].onchainCredit(addr.quote, 50000);
  const trouble = [];
  p.W.onMintTrouble((t) => trouble.push(t));
  bad = true;
  let said = '';
  try { await p.W.onchainClaimAway(addr.quote); } catch (e) { said = String(e && e.message); }
  await wait(50);
  ok('L1b (control) the deposit’s signatures fail the check, and nothing is kept at their mint',
    p.W.balanceAt(THEIR) === 0 && /dleq|signature/i.test(said), 'their pile ' + p.W.balanceAt(THEIR) + ', said "' + said + '"');
  const named = trouble.filter((t) => t && t.badSignatures).map((t) => t.mint + ' (' + t.where + ')');
  ok('L1b THIS MINT SENT INVALID SIGNATURES names the mint the deposit is at, not home',
    named.length > 0 && named.every((m) => /their\.test/.test(m)),
    'the only card raised names ' + JSON.stringify(named) + ': "home.test sent signatures that do not match the keys it '
      + 'publishes. Nothing it sent back was kept." and "Consider moving your balance to another mint", about the honest mint');
}

/* The page's `onSwept` handler (06-wallet-boot-and-restore.js), as written. */
function sweptHandler() {
  const m = /W\.onSwept\(\(claimed\) => \{([^\n]*)\}\);\n/.exec(app);
  if (!m) throw new Error('the onSwept handler was not found');
  return new Function('claimed', m[1]);
}

/* A page stand-in with the real `announcePayment`, `txIsNew` and `hushSweepEntries`. `rows`: what
 * W.transactions answers. Everything that reaches the person is noted in `said`. */
function page(rows, mintUrl) {
  const said = [];
  const W = {
    mintUrl: mintUrl || HOME,
    canonicalMint: (u) => String(u || '').replace(/\/+$/, '').toLowerCase(),
    transactions: () => Promise.resolve(rows.slice()),
    tagsFor: () => ({}),
    notify: () => {},
  };
  global.window = { FoxyWallet: W };
  global.document = { visibilityState: 'visible' };
  global.CONFIRM_SCREENS = eval(/const CONFIRM_SCREENS = (\[[^\]]*\]);/.exec(app)[1]);
  const a = Object.assign(lift(['txIsNew(hash) {', 'announcePayment(ev) {', 'hushSweepEntries() {']), {
    state: { screen: 'home', stack: [] },
    setState(u) {
      const next = typeof u === 'function' ? u(this.state) : u;
      if (next && next.screen === 'paid' && this.state.screen !== 'paid') said.push('paid ' + (next.paidPlace ? next.paidPlace.label + ' ' + next.paidPlace.to : ''));
      Object.assign(this.state, next);
    },
    refreshBalance() {}, loadHistory() {}, stuckInvoiceLanded() {}, haptic() {}, hideStage() {},
    cardFlowHolds() { return false; }, keepForCardFlow() {},
    mintNameOf: (u) => String(u || '').replace(/^https?:\/\//, ''),
    _seenSeeded: true,
  });
  return { a, W, said };
}

/* L2. A payment claimed away, told while the page is hushed for a crossing. */
async function l2() {
  console.log('L2. an away claim told during a crossing’s hush');
  const q = '00000000000000000000000000001389';
  const claim = { quote: q, unit: 'sat', amount: 1000, sats: 1000, mint: THEIR, away: true, awayAt: THEIR, dir: 'in', hash: q };
  {
    // control: told with nothing going on, it is said, NOW AT their mint
    const { a, said } = page([]);
    sweptHandler().call(a, [claim]);
    ok('L2 (control) told with the page not hushed, it is said NOW AT their mint', said.length === 1 && /NOW AT their\.test/.test(said[0]),
      JSON.stringify(said));
  }
  {
    // the crossing (26d-tap.js `crossMove`): quiet, and what history held before it noted
    const rows = [];
    const { a, said } = page(rows);
    a._quiet = true;
    a._sweepBefore = new Set(rows.map((x) => x.hash));
    // its visit connect walks the other mints at the end of its catch-up, and their mint's claim is written
    rows.unshift({ hash: q, dir: 'in', sats: 1000, mint: THEIR, settled: true });
    // the move ends: the crossing marks every new row seen (`hushSweepEntries`)
    await a.hushSweepEntries();
    // the away walk's report lands while the crossing is still quiet, or in the 20-30 s after it
    sweptHandler().call(a, [claim]);
    a._quiet = false;
    a._hushUntil = 0;
    // later: the phone visits their mint, and that mint's history pass reads the row (16-history-lists.js: txIsNew)
    const later = a.txIsNew(q);
    ok('L2 a payment claimed at another mint during a crossing’s hush is said, then or later',
      said.length > 0 || later,
      'said ' + JSON.stringify(said) + '; the history pass at their.test would ' + (later ? '' : 'not ')
        + 'raise it (hushSweepEntries marked it seen, and the hush dropped the away report before it marked anything)');
  }
  {
    // after the fix: the away claim told in the hush is held, and said once the quiet is over (`sayHushedAway`)
    const rows = [];
    const { a, said } = page(rows);
    a.sayHushedAway = lift(['sayHushedAway() {']).sayHushedAway;
    a._quiet = true;
    a._sweepBefore = new Set();
    rows.unshift({ hash: q, dir: 'in', sats: 1000, mint: THEIR, settled: true });
    await a.hushSweepEntries();
    sweptHandler().call(a, [claim]);
    const during = said.length;
    a._quiet = false;
    await wait(2300);
    ok('L2b a payment claimed at another mint during the quiet is held, then said NOW AT that mint once the quiet ends',
      during === 0 && said.length === 1 && /NOW AT their\.test/.test(said[0]),
      'said during the quiet ' + during + ', after ' + JSON.stringify(said));
  }
  delete global.window; delete global.document; delete global.CONFIRM_SCREENS;
}

/* L3. A swap leg claimed away is raised as a payment received. */
async function l3() {
  console.log('L3. the away announcement skips nothing the history pass skips');
  const q = '0000000000000000000000000000138a';
  // the claim the away walk reports for the second leg of a swap between balances (15-receiving.js `said`)
  const leg = { quote: q, unit: 'usd', amount: 150, sats: 0, mint: THEIR, away: true, awayAt: THEIR, dir: 'in', hash: q };
  const { a, said } = page([{ hash: q, dir: 'in', unit: 'usd', amount: 150, kind: 'swap', mint: THEIR, settled: true }]);
  sweptHandler().call(a, [leg]);
  // what the history pass at that mint does with the same row (16-history-lists.js: `t.kind === 'swap'` is never fresh)
  const histSays = !/t\.kind === 'swap'\) \{ this\.txIsNew\(t\.hash\); return; \}/.test(app);
  ok('L3 (control) the history pass never raises a swap leg as a payment', !histSays);
  ok('L3 a leg of a swap between balances, claimed at another mint by the away walk, is not raised as a payment received',
    said.length === 0,
    'said ' + JSON.stringify(said) + ': the onSwept handler announces every away claim with an amount; the claim carries no '
      + '`swap` mark, so nothing could tell it apart');
  {
    // at a mint with two balances, where a dollar payment is said: a payment is, and a swap's leg (marked) is not
    const pay = Object.assign({}, leg, { quote: q + 'p', hash: q + 'p' });
    const { a, said } = page([]);
    global.window.FoxyWallet.twoUnits = () => true;
    sweptHandler().call(a, [pay]);
    ok('L3 (control) a dollar payment claimed at another mint with two balances is said NOW AT that mint',
      said.length === 1 && /NOW AT their\.test/.test(said[0]), JSON.stringify(said));
    const marked = Object.assign({}, leg, { swap: 'sw1', kind: 'swap' });
    const p2 = page([]);
    global.window.FoxyWallet.twoUnits = () => true;
    sweptHandler().call(p2.a, [marked]);
    const carries = /entry\.swap \? \{ swap: String\(entry\.swap\), kind: 'swap' \}/
      .test(fs.readFileSync(path.join(ROOT, 'Web', 'foxy-wallet.js'), 'utf8'));
    ok('L3b the away walk’s report of a swap leg carries its mark, and a marked leg is not said, two balances or not',
      carries && p2.said.length === 0, 'said() carries the mark: ' + carries + '; said ' + JSON.stringify(p2.said));
  }
  delete global.window; delete global.document; delete global.CONFIRM_SCREENS;
}

/* S1. The proof lock while the away walk runs: how long each hold is, and how long a tap's token waits. */
async function s1() {
  console.log('S1. the proof lock under the away walk (measured)');
  const p = realPhone();
  // three invoices at each of two other mints, made on visits; the phone home, and every connect's own walk over
  const made = [];
  for (const where of [THEIR, OTHER]) {
    await at(p, HOME, true);
    await at(p, where, false);
    for (let i = 0; i < 3; i++) made.push({ where, inv: await p.W.invoice(200 + i, '') });
  }
  await at(p, HOME, true);
  for (let i = 0; i < 100 && p.W.proofLockHolder(); i++) await wait(50);
  await wait(2500);
  made.forEach((m) => p.mints[m.where].payQuote(m.inv.hash));
  // each answer from those mints takes 300 ms (a quick Tor)
  p.delay[THEIR] = 300; p.delay[OTHER] = 300;
  const holds = [];
  let cur = null;
  const tick = setInterval(() => {
    const h = p.W.proofLockHolder();
    if (h && !cur) cur = { what: h.what, from: Date.now() - h.ms };
    else if (!h && cur) { holds.push(Object.assign(cur, { ms: Date.now() - cur.from })); cur = null; }
    else if (h && cur && Date.now() - h.ms > cur.from + 1) { holds.push(Object.assign(cur, { ms: Date.now() - h.ms - cur.from })); cur = { what: h.what, from: Date.now() - h.ms }; }
  }, 1);
  const t0 = Date.now();
  const walk = p.W._sweepAway();
  // a tap's token arriving at any moment of the walk: a locked call every 100 ms, each timed to its turn
  const waits = [];
  let walking = true;
  walk.then(() => { walking = false; }, () => { walking = false; });
  while (walking) {
    const asked = Date.now();
    p.W.importProofs([]).then(() => waits.push(Date.now() - asked), () => waits.push(Date.now() - asked));
    await wait(100);
  }
  const got = await walk;
  await wait(20);
  clearInterval(tick);
  const waited = waits.reduce((m, x) => Math.max(m, x), 0);
  const longest = holds.reduce((m, h) => Math.max(m, h.ms), 0);
  console.log('      walk ' + (Date.now() - t0) + ' ms, ' + (got || []).length + ' claimed, ' + holds.length + ' holds, longest '
    + longest + ' ms; ' + waits.length + ' locked calls through it, the longest wait ' + waited + ' ms');
  ok('S1 (sound) every claim is its own hold, none longer than about one answer, and a locked call waits for one at most',
    (got || []).length === 6 && longest < 1500 && waited < 1500,
    JSON.stringify(holds) + ', waited ' + waited);
}

/* P1. The archive's cap drops a paid invoice Foxy has stopped asking about (pre-existing, 08c-units.js `keepQuote`). */
async function p1() {
  console.log('P1. the invoice archive past five hundred');
  const p = realPhone();
  await at(p, HOME, true);
  const inv = await p.W.invoice(4000, '');
  p.mints[HOME].payQuote(inv.hash);
  // home refused it three times (or never answered ten): Foxy stops asking, and PAID, NOT COLLECTED offers TRY AGAIN
  const K = 'foxy.cashu.quotes', KO = 'foxy.cashu.quotes.old';
  const get = (k) => JSON.parse(p.ctx.storage.getItem(k) || '[]') || [];
  p.ctx.storage.setItem(K, JSON.stringify(get(K).map((q) => (q.quote === inv.hash
    ? Object.assign({}, q, { unclaimed: { since: Date.now(), at: Date.now(), tries: 3, refused: 3, gaveUp: 'refused', reason: 'Quote not paid' } }) : q))));
  ok('P1 (control) PAID, NOT COLLECTED is offered for it, with TRY AGAIN',
    p.W.stuckInvoices().some((h) => h.quote === inv.hash));
  // a till's dollar receive screen makes one a minute, none paid, and no sweep in between: about nine hours
  for (let i = 0; i < 551; i++) await p.W.invoice(100 + (i % 50), '');
  const kept = get(K).concat(get(KO)).some((q) => q.quote === inv.hash);
  const card = p.W.stuckInvoices().some((h) => h.quote === inv.hash);
  ok('P1 a paid invoice waiting for TRY AGAIN is not dropped from the archive by newer unpaid ones',
    kept && card,
    'after 551 newer invoices the record (and its NUT-20 key) is ' + (kept ? 'kept' : 'gone') + ', the PAID, NOT COLLECTED card '
      + (card ? 'is still offered' : 'is gone') + ': `keepQuote` keeps the newest 500 of the archive, blind to what they are');
}

/* P1b. Six hundred unpaid invoices that ran out leave a paid one made on a visit where the away walk finds it: the
 * cap drops the expired ones first. */
async function p1b() {
  console.log('P1b. six hundred expired invoices and one paid at another mint');
  let expired = false;
  const p = realPhone({
    mangle: (m, text) => {
      if (!expired || m.method !== 'POST' || m.url !== HOME + '/v1/mint/quote/bolt11') return text;
      const nl = text.indexOf('\n');
      const body = JSON.parse(text.slice(nl + 1));
      body.expiry = Math.floor(Date.now() / 1000) - 3600;
      return text.slice(0, nl) + '\n' + JSON.stringify(body);
    },
  });
  const inv = await madeAway(p, THEIR);
  expired = true;
  for (let i = 0; i < 600; i++) await p.W.invoice(100 + (i % 50), '');
  const get = (k) => JSON.parse(p.ctx.storage.getItem(k) || '[]') || [];
  const old = get('foxy.cashu.quotes.old');
  const kept = get('foxy.cashu.quotes').concat(old).some((q) => q.quote === inv.hash);
  let got = [];
  try { got = await p.W._sweepAway(); } catch (e) {}
  const found = (got || []).some((c) => c && c.quote === inv.hash);
  ok('P1b a paid invoice at another mint outlives 600 newer ones that expired unpaid, and the away walk claims it',
    kept && old.length <= 500 && found && p.W.balanceAt(THEIR) === 1000,
    'kept ' + kept + ', archive ' + old.length + ', claimed by _sweepAway ' + found + ', their pile ' + p.W.balanceAt(THEIR));
}

/* W. Words. */
function words() {
  console.log('W. the words added in the seven rounds');
  const wallet = fs.readFileSync(path.join(ROOT, 'Web', 'foxy-wallet.js'), 'utf8');
  ok('W1 a payment stopped by a mint change says the person’s mint, not "Foxy’s mint"',
    !/Foxy\\u2019s mint changed while this payment/.test(wallet), '20-helpers.js:2253 says "Foxy’s mint changed while this payment was being made"');
  // TRY AGAIN's success, for an invoice at another mint (11-cards.js, both TRY AGAIN cards)
  const tryAgain = /retryRefusedClaim\(hit\.quote\)\.then\(\(\) => \{\s*this\.toast\('Collected ' \+ sats \+ ' sats'\);/.test(app);
  ok('W2 TRY AGAIN on an invoice at another mint says where the money landed (NOW AT), not a bare "Collected"',
    !tryAgain, '"Collected 1,000 sats" and a refresh of home, whose balance does not move; the sats are at their.test');
  const website = /'It did not reach them \(' \+ W\.reason\(e\) \+ '\)\. Show them this token instead\.'/.test(app);
  ok('W3 a website post that failed does not tell the person to "show them" a token',
    !website, '07-history-tokens-mints.js:1667 says "It did not reach them (…). Show them this token instead." for an https delivery too');
  ok('W4 HIGH RISK says what "safe" will look like',
    !/Do not pay again until it is safe\./.test(app), '"Do not pay again until it is safe." names no signal the person can wait for');
}

async function run() {
  await l1();
  await l1b();
  await l2();
  await l3();
  await s1();
  await p1();
  await p1b();
  words();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
