'use strict';
/* attack-2026-11-01-round7.js — round seven of the attack, on 6dd5e11 (the round-6 fixes).
 *
 *     node tests/attack-2026-11-01-round7.js
 *
 * Every case but the controls (marked "control") fails on 6dd5e11: each is a
 * finding in .claude/audits/attack-2026-11-01-round7.md, named by its letter.
 *
 *   M1 the away sweep (15-receiving.js `sweepQuotes`) finds the other mints to
 *      walk from the live invoice list only (`K.quotes`). An invoice made on a
 *      visit that has been pushed into the archive (`K.quotesOld`, past fifty
 *      newer ones: a dollar receive screen makes one a minute) is never asked
 *      about from home, though `_sweepQuotesOnce` would read the archive.
 *   L1 `onchainAsk` (26b-onchain.js) pins `_ocAsked` before the answer, and the
 *      wallet's `onchainLimits` answers a failure with null: one failed /v1/info
 *      leaves this mint "doing nothing on chain" for the session. Since round 6
 *      the screens read only the connected mint's limits, so after a trip home
 *      whose ask failed the ON-CHAIN receive stays blank, with no clock.
 *   L2 a Lightning invoice claimed by the away sweep is told to nobody: the
 *      page's `onSwept` handler refreshes home, whose balance and history do not
 *      have it (the row is filed at the other mint).
 *   L3 the away sweep waits on every other mint in turn before it reports
 *      anything, so a mint that is slow or silent (25 s for `awayWallet`) holds
 *      back the report of home's own claims, and the rest of the connect's
 *      catch-up chained after it.
 *   L4 TRY AGAIN on PAID, NOT COLLECTED for an invoice at another mint
 *      (`retryRefusedClaim`) claims with home's wallet and is refused "collected
 *      when the phone is back", which is no longer how it is collected.
 *   L5 the away invoice watch paces itself by the connected mint's "too many"
 *      (`mintBusy(mintUrl)`), not by the mint it is asking (`madeAt`).
 *
 * Methods are lifted out of build/foxy-app.js, as rounds 1-6 do; M1, L2-L5 run
 * the real wallet against fake mints (tests/harness.js).
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
const QUOTES = 'foxy.cashu.quotes';
const QUOTES_OLD = 'foxy.cashu.quotes.old';

/* The real wallet, at HOME, with THEIR beside it. `o.slow[origin]`: that mint answers every request with an error
 * after so many ms (a mint that is down behind a proxy, or silent until a timeout). `o.busy`: a function of the
 * message, true for a request THEIR answers 429 to. `o.seen`: every request, { at, url, method }. */
function realPhone(o) {
  const opts = o || {};
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ph = nativePhone({ words: PHONE_WORDS });
  const mints = {};
  const seen = opts.seen || [];
  const slow = opts.slow || {};
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const u = new URL(m.url);
        seen.push({ at: Date.now(), url: m.url, method: m.method });
        if (slow[u.origin]) return setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'The request timed out.'), slow[u.origin]);
        if (opts.busy && opts.busy(m)) return reply(w, m.id, '429\n' + JSON.stringify({ detail: 'Rate limit exceeded.' }));
        const mint = mints[u.origin];
        if (!mint) return reply(w, m.id, null, 'no such mint in this test');
        return reply(w, m.id, mint.handle(m));
      }
      const got = ph.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      ph.attach(w);
      mints[HOME] = fakeMint(w, { fill: 7, quotesUnpaid: true });
      mints[THEIR] = fakeMint(w, { fill: 9, quoteFrom: 5000, quotesUnpaid: true });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return { ctx, W: ctx.W, mints, seen, slow };
}
const stored = (ctx, k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };

/* An invoice made at THEIR on a visit, the phone home again, and the invoice paid there. */
// each connect's own catch-up (its sweep, which now walks the other mints too) let finish first
async function at(p, u, remember) {
  await p.W.connect(u, null, null, { remember: remember });
  await wait(300);
}
async function madeAway(p, sats) {
  await at(p, HOME, true);
  await at(p, THEIR, false);
  const inv = await p.W.invoice(sats || 1000, '');
  await at(p, HOME, true);
  p.mints[THEIR].payQuote(inv.hash);
  return inv;
}

async function m1() {
  console.log('M1. an invoice made on a visit, archived before the sweep reaches it');
  {
    const p = realPhone();
    await madeAway(p);
    try { await p.W.sweepQuotes(); } catch (e) {}
    ok('M1 (control) with the invoice on the live list, the sweep from home claims it at their mint',
      p.W.balanceAt(THEIR) === 1000, String(p.W.balanceAt(THEIR)));
  }
  {
    const p = realPhone();
    const inv = await madeAway(p);
    // fifty receives at home (a dollar receive screen left up makes one a minute), none of them paid yet
    for (let i = 0; i < 50; i++) await p.W.invoice(100 + i, '');
    const live = stored(p.ctx, QUOTES, []).some((q) => q.quote === inv.hash);
    const old = stored(p.ctx, QUOTES_OLD, []).some((q) => q.quote === inv.hash);
    ok('M1 (control) the visited mint’s invoice is in the archive now, kept for the sweep', !live && old, 'live ' + live + ', archived ' + old);
    const before = p.seen.length;
    try { await p.W.sweepQuotes(); } catch (e) {}
    const asked = p.seen.slice(before).some((r) => r.url.indexOf(THEIR + '/') === 0);
    ok('M1 an archived invoice at another mint is still asked about and claimed from home',
      p.W.balanceAt(THEIR) === 1000,
      'their.test holds ' + p.W.balanceAt(THEIR) + ' sats, the quote is PAID, and their mint was ' + (asked ? '' : 'never ')
        + 'asked by that sweep: the away walk lists mints from K.quotes only, so with no live invoice there it is never walked');
  }
}

async function l1() {
  console.log('L1. an on-chain limits ask that fails');
  const LIM = { receive: { min: 25000, max: 1000000, confirmations: 3 }, send: { min: 10000, max: 1000000 } };
  let asks = 0;
  let failNext = true;
  const W = {
    mintUrl: HOME, connected: true,
    canonicalMint: (u) => String(u || '').replace(/\/+$/, ''),
    // the wallet's own `onchainLimits`: a failed /v1/info resolves null (16a-onchain.js), and nothing is kept
    onchainLimits: () => { asks++; const f = failNext; failNext = false; return Promise.resolve(f ? null : LIM); },
    onchainKnown: () => !failNext && asks > 1,
    onchainAddress: () => Promise.resolve({ quote: 'q0', address: 'bc1qhome', mint: HOME }),
  };
  global.window = { FoxyWallet: W };
  const a = Object.assign(lift(['onchainAsk() {', 'ocCan(which) {', 'ocReceiveAddress() {', 'ocReceiveNote() {']), {
    state: { screen: 'confirm', flow: 'receive', recvRail: 'ON-CHAIN', stack: [] },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    onchainWatchLater() {}, toast() {}, group: (n) => String(n),
  });
  // the trip home lands and asks (07 `crossComeHome`): Tor drops that one request
  a.onchainAsk();
  await wait(5);
  ok('L1 (control) the ask failed: nothing is known of home on chain', a.ocCan('receive') === false && asks === 1);
  // two minutes of the receive screen being drawn
  const real = Date.now;
  Date.now = () => real() + 120000;
  for (let i = 0; i < 5; i++) { a.ocCan('receive'); a.ocReceiveAddress(); await wait(2); }
  Date.now = real;
  const addr = a.ocReceiveAddress();
  ok('L1 a failed on-chain limits ask is asked again, and the ON-CHAIN receive is not left blank for the session',
    asks > 1 && !!addr,
    asks + ' ask(s) in two minutes of renders; `_ocAsked` pins ' + a._ocAsked + ', ocLimits ' + JSON.stringify(a.state.ocLimits)
      + ' for ocLimitsMint ' + a.state.ocLimitsMint + '; ocReceiveAddress() = "' + addr + '", note "' + a.ocReceiveNote() + '"');
  delete global.window;
}

async function l2() {
  console.log('L2. an invoice claimed by the away sweep, as the owner sees it');
  const p = realPhone();
  const inv = await madeAway(p);
  let swept = null;
  p.W.onSwept((c) => { swept = c; });
  try { await p.W.sweepQuotes(); } catch (e) {}
  await wait(20);
  const item = (swept || []).filter((c) => c && c.quote === inv.hash)[0];
  ok('L2 (control) the sweep claims it at their mint and says so to the page ({ mint, away })',
    p.W.balanceAt(THEIR) === 1000 && !!item && item.away === true, JSON.stringify(swept));
  // home's balance and history, as the screens read them (16-history-lists.js `loadHistory`: `!x.mint || x.mint === here`)
  const rows = await p.W.transactions(500);
  const homeRows = rows.filter((x) => (!x.mint || x.mint === HOME) && x.hash === inv.hash);
  // the page's own handler for it (06-wallet-boot-and-restore.js), run on a stub that notes whatever would reach the person
  const m = /W\.onSwept\(\(claimed\) => \{([^}]*)\}\)/.exec(app);
  const told = [];
  if (m) {
    const handler = new Function('claimed', m[1]);
    const stub = {
      stuckInvoiceLanded() {}, refreshBalance() {}, loadHistory() {},
      announcePayment(ev) { told.push('announce ' + JSON.stringify(ev)); },
      toast(t) { told.push('toast ' + t); }, blockedCard(k) { told.push('card ' + k); },
    };
    try { handler.call(stub, swept || []); } catch (e) { told.push('threw ' + e.message); }
  }
  ok('L2 a payment claimed at another mint by the sweep is told to the person (NOW AT that mint)',
    told.some((t) => !/^threw/.test(t)),
    'the handler is ' + (m ? '"' + m[1].trim() + '"' : 'not found') + ': nothing said; home holds '
      + p.W.balanceAt(HOME) + ' and its history has ' + homeRows.length + ' row(s) for it; the 1000 sats sit in their.test’s pile');
}

async function l3() {
  console.log('L3. a silent other mint in the sweep');
  const p = realPhone();
  // an invoice made on a visit to their mint, never paid
  await at(p, HOME, true);
  await at(p, THEIR, false);
  await p.W.invoice(500, '');
  await at(p, HOME, true);
  // a payment to home while the app was away
  const mine = await p.W.invoice(700, '');
  p.mints[HOME].payQuote(mine.hash);
  // and their mint stops answering: every request fails after 1.5 s (a real one is 25 s for the wallet, 65 s a request)
  p.slow[THEIR] = 1500;
  let toldAt = 0;
  p.W.onSwept(() => { if (!toldAt) toldAt = Date.now(); });
  const t0 = Date.now();
  const swept = p.W.sweepQuotes();
  await wait(400);
  const homeHas = p.W.balanceAt(HOME);
  const early = toldAt ? toldAt - t0 : -1;
  try { await swept; } catch (e) {}
  ok('L3 (control) home’s own invoice is claimed at once', homeHas === 700, String(homeHas));
  ok('L3 home’s claim is told to the page without waiting on another mint that is not answering',
    early >= 0,
    'claimed into home’s pile in under 400 ms, told to the page after ' + ((toldAt || Date.now()) - t0)
      + ' ms: the walk asks their mint first (awayWallet, 25 s on a phone per silent mint), and the connect’s melts, swaps and crossings are chained behind it');
}

async function l4() {
  console.log('L4. TRY AGAIN on an invoice at another mint');
  const p = realPhone();
  const inv = await madeAway(p);
  // their mint refused it three times (the away sweep's refusals, noted by `noteClaimTrouble`): Foxy stops asking
  const list = stored(p.ctx, QUOTES, []).map((q) => (q.quote === inv.hash
    ? Object.assign({}, q, { unclaimed: { since: Date.now(), at: Date.now(), tries: 3, refused: 3, reason: 'Quote not paid' } }) : q));
  p.ctx.storage.setItem(QUOTES, JSON.stringify(list));
  const stuck = p.W.stuckInvoices().filter((h) => h.quote === inv.hash);
  ok('L4 (control) PAID, NOT COLLECTED is raised for it at home, with TRY AGAIN (refused three times)',
    stuck.length === 1 && stuck[0].unclaimed.refused >= 3);
  let said = '';
  try { await p.W.retryRefusedClaim(inv.hash); } catch (e) { said = String(e && e.message); }
  ok('L4 TRY AGAIN collects it at the mint it is at',
    p.W.balanceAt(THEIR) === 1000,
    'their.test holds ' + p.W.balanceAt(THEIR) + '; TRY AGAIN said "' + said + '" (claimed with home’s wallet; '
      + 'the away sweep collects from anywhere now, so "when the phone is back" is not true)');
}

async function l5() {
  console.log('L5. the away watch and a mint saying "too many"');
  // `away`: the invoice made at their mint and watched from home; otherwise made and watched at home
  const count = async (away) => {
    let busyOn = false;
    const seen = [];
    const at0 = away ? THEIR : HOME;
    const p = realPhone({ seen, busy: (m) => busyOn && m.url.indexOf(at0 + '/v1/mint/quote/bolt11/') === 0 && m.method === 'GET' });
    await at(p, HOME, true);
    if (away) await at(p, THEIR, false);
    const inv = await p.W.invoice(1000, '');
    if (away) await at(p, HOME, true);
    busyOn = true;
    const asks = () => seen.filter((r) => r.url.indexOf(at0 + '/v1/mint/quote/bolt11/' + inv.hash) === 0);
    const before = asks().length;
    const stop = p.W.watch(inv.hash, () => {}, { timeoutMs: 60000 });
    // wait for its first question (away, the wallet for that mint is made first), then count for 7.5 s
    for (let i = 0; i < 100 && asks().length === before; i++) await wait(50);
    const from = asks().length > before ? asks()[before].at : Date.now();
    await wait(7500);
    stop();
    return asks().slice(before).filter((r) => r.at - from < 7500).length;
  };
  const home = await count(false);
  ok('L5 (control) at home, a mint answering 429 to each question is asked at most three times in 7.5 s', home > 0 && home <= 3, String(home));
  const n = await count(true);
  ok('L5 the away watch waits as long between questions once their mint says "too many" as a watch at home does',
    n > 0 && n <= 3,
    n + ' questions in 7.5 s (at home: ' + home + '): `nextDelay` and `kick` ask `mintBusy(mintUrl)`, the mint the phone is on, '
      + 'not `madeAt`');
}

async function run() {
  await m1();
  await l1();
  await l2();
  await l3();
  await l4();
  await l5();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
