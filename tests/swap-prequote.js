'use strict';
/* swap-prequote.js — SWAP asks ahead: the rate at the SWAP tap, and the quote while the amount is typed.
 *
 *     node tests/swap-prequote.js
 *
 * The app's swap methods (build/app/26i-swap.js), lifted from the build as tests/two-balances-swap.js lifts them, on
 * the page of a real wallet (build/wallet/16b-two-balances.js) at the harness's mint with a usd keyset, with every
 * quote request the mint is sent counted:
 *   - the probe: one pair (a mint quote and a melt quote) once per screen opened, the mint's rate kept, nothing
 *     written down; none offline, at a one-unit mint, or beside a quote already out
 *   - SET AMOUNT's rate line: the market price, said to be the market's, before the mint has given one; "Checking the
 *     rate…" while the probe is out; the mint's own after
 *   - a figure that stands still 600 ms is quoted in the background, once; a changed figure drops it; NEXT on a held
 *     quote for exactly that figure opens the confirmation filled with no request to the mint; a short hold or another
 *     figure asks afresh; a NEXT while that very figure is being asked waits for its answer
 *   - one background question at a time, never two pairs within the gap (shortened here from the app's three
 *     seconds, so the suite runs quickly), every pair counted, the confirmation's too; and none once the minute's
 *     budget of pairs has gone
 *   - a swap from bitcoin typed in dollars: NEXT takes the quote asked for those keys, though its answer moved the
 *     rate the keys convert at; another direction, another mint, or a screen opened again asks afresh
 *   - one probe per direction per screen; the ⇅ asks the other way's; an old mint rate is shown as the market's
 *   - the first pass taken when it fits, the second still asked when it does not
 *   - the books of every unit closing to the unit after each swap run */
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, books, PHONE_WORDS } = require('./harness');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const MINT = 'https://m.test';
const OTHER = 'https://m2.test';
// the gap between pairs asked ahead; the app's is three seconds (26i-swap.js, SWAP_AHEAD_GAP_MS)
const GAP = 1000;

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (fn()) return true; await wait(10); }
  return !!fn();
};

const method = (sig) => {
  const start = appSrc.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = appSrc.indexOf('{', start), depth = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appSrc.slice(start + 3, i + 1);
};
// (`swapHave`: what there is to swap, this phone's balance or a card's, 26f-flashcard.js `fcSwap`; `swapComing`: a card's, counted as coming)
const LIFTED = ['goSwap() {', 'swapFlip() {', 'swapUnits() {', 'swapHave(u) {', 'swapComing(u) {', 'swapToAmount() {', 'swapTyped() {', 'swapNext(all) {',
  'swapAsk(again, amountGiven, allGiven) {', 'swapLeft() {', 'swapClock() {', 'swapGo() {', 'swapStillGoing(r) {', 'swapPendingCard(r) {',
  'swapDoneClose() {', 'swapRateOf(r) {', 'swapRateText(n) {', 'swapRateWho() {', 'swapInk(unit) {', 'swapEstimate() {', 'swapSpec() {',
  'swapExact() {', 'swapForget() {', 'swapRateHead() {', 'swapClockText(sec) {', 'swapWorth(n, unit, rate) {', 'swapCents(cents, sats) {',
  'cfRow(label, value, opt) {', 'unitFigure(amount, unit) {', 'unitWord(unit) {', 'unitBalance(unit) {',
  'centsTyped() {', 'usd(v) {', 'group(n) {', 'twoUnitsOn() {', 'moneyBusy() {', 'satUsd() {', 'recoveringSats() {', 'swapPx() {',
  'centsOfSats(sats, px) {', 'swapProbe(fromGiven) {', 'swapAheadLater() {', 'swapAheadAsk() {', 'swapAheadLeft(a) {',
  'swapAheadFor(a) {', 'swapAheadTake(a, from, to) {', 'swapRateLine() {', 'swapKeypad() {', 'swapMintHere() {',
  'swapAheadMine() {'];

/* A page at the mint, with each quote request it sends counted: `asks.mint` and `asks.melt`, the bolt11 quote
 * routes Nutshell limits, and `asks.at`, when each mint quote went. */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: PHONE_WORDS });
  const mints = {};
  const asks = { mint: 0, melt: 0, at: [] };
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const u = new URL(String(m.url || m.path || ''));
        const p = u.pathname;
        const mint = mints[u.origin];
        if (p === '/v1/mint/quote/bolt11') { asks.mint += 1; asks.at.push(Date.now()); }
        if (p === '/v1/melt/quote/bolt11') asks.melt += 1;
        if (opts.slow && /\/quote\/bolt11$/.test(p)) return setTimeout(() => reply(w, m.id, mint.handle(m)), opts.slow);
        return reply(w, m.id, mint.handle(m));
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mints[MINT]) mints[MINT] = fakeMint(w, Object.assign({ units: ['sat', 'usd'] }, opts.mintOpts || {}));
      if (!mints[OTHER]) mints[OTHER] = fakeMint(w, { units: ['sat', 'usd'] });
    },
  });
  ctx.asks = asks;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._swapPollMs = 5;
  ctx.W._swapClaimWaitMs = 200;
  return ctx;
}
async function fund(c, amount, unit) {
  const inv = await c.W.invoice(amount, '', { unit: unit || 'sat' });
  return c.W.claim(inv.hash);
}
const off = (c, from) => {
  const now = books(c);
  return Object.keys(now).concat(Object.keys(from || {})).every((k) => ((now[k] || { off: 0 }).off - ((from || {})[k] || { off: 0 }).off) === 0);
};
const pairs = (c) => c.asks.mint + '/' + c.asks.melt;

function appOn(ctx) {
  const app = ctx.window.eval('(function () { return {' + LIFTED.map(method).join(',') + '}; })()');
  const W = ctx.W;
  const log = { toasts: [], cards: [], settled: [] };
  Object.assign(app, {
    log,
    SWAP_MARGIN_MS: 15000, SWAP_REQUOTES: 3, SWAP_TYPED_MS: 600, SWAP_AHEAD_GAP_MS: GAP, SWAP_AHEAD_KEEP_S: 10,
    SWAP_AHEAD_PER_MIN: 8, SWAP_RATE_FRESH_MS: 600000,
    state: { screen: 'home', stack: [], flow: '', unit: 'USD', amount: '', hidden: false, livePrice: 76000, satUsd: 76000 / 1e8 },
    setState(u) { Object.assign(app.state, typeof u === 'function' ? u(app.state) : u); },
    toast(m) { log.toasts.push(String(m)); },
    blockedCard(kind, over) { log.cards.push(Object.assign({ kind }, over)); },
    settleAnimate(lane) { log.settled.push(lane); },
    showMelt() {}, hideMelt() {},
    mintName: () => 'Forge',
    offline: false,
    offlineNow() { return app.offline; },
    px() { return app.state.livePrice || null; },
    loadHistory() {},
    refreshBalance() { app.state.balSats = W.balanceOf('sat'); app.state.balUsdCents = W.balanceOf('usd'); return Promise.resolve(); },
    balNow() { return { sats: app.state.balSats, cents: app.state.balUsdCents, usd: 0 }; },
    back() { const st = app.state.stack; app.state.screen = st.length ? st[st.length - 1] : 'home'; app.state.stack = st.slice(0, -1); },
  });
  app.refreshBalance();
  // a key on SET AMOUNT, as `press` has it: the figure is forgotten, then changed
  app.typeIt = (figure) => { app.swapForget(); app.state.amount = figure; };
  // as if the last pair asked ahead were long gone
  app.paceGone = () => { W._swapPairs = []; };
  return app;
}

(async () => {
  console.log('foxy swap: asking ahead\n');

  // ---- 1. the probe at the SWAP tap ---------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 40000, 'sat');
    const app = appOn(c);
    let probes = 0;
    const realProbe = c.W.swapProbe;
    c.W.swapProbe = function () { probes += 1; return realProbe.apply(this, arguments); };
    app.state.flow = 'swap';
    ok(c.W.mintRate() === null && app.swapRateLine() === 'MARKET PRICE ₿ 1 = $ 76,000',
      'before the mint has quoted, SET AMOUNT’s line is the market price, said to be the market’s', app.swapRateLine());
    // a dollar invoice is a dollar quote too, so the mint's rate is known from here on
    await fund(c, 3000, 'usd');
    app.refreshBalance();
    const from = books(c);
    const quotesBefore = c.storage.getItem('foxy.cashu.quotes');
    const m0 = c.asks.mint, l0 = c.asks.melt;
    app.goSwap();
    ok(app.state.swapProbing === true, 'SWAP opened: the probe goes out');
    ok(app.swapRateLine() === 'Checking the rate…', 'and the line says "Checking the rate…" while it is out', app.swapRateLine());
    app.swapProbe('usd');
    await until(() => !app.state.swapProbing, 5000);
    ok(probes === 1, 'one probe, never twice for one screen opened', String(probes));
    ok(c.asks.mint - m0 === 1 && c.asks.melt - l0 === 1, 'the probe is one pair: a mint quote and a melt quote', (c.asks.mint - m0) + '/' + (c.asks.melt - l0));
    const r = c.W.mintRate();
    ok(r && Math.abs(r.usdPerBtc - 76900) / 76900 < 0.02, 'it keeps the mint’s rate', JSON.stringify(r));
    ok(app.swapRateLine() === 'FORGE’S RATE ' + app.swapRateText(r.usdPerBtc), 'and the line is now the mint’s own rate', app.swapRateLine());
    ok(c.storage.getItem('foxy.cashu.quotes') === quotesBefore && c.W.unitSwapsPending().length === 0,
      'nothing written down: no invoice record and no swap');
    app.swapToAmount();
    ok(app.state.screen === 'amount' && app.swapRateLine() === 'FORGE’S RATE ' + app.swapRateText(r.usdPerBtc), 'on SET AMOUNT before anything is typed');
    ok(off(c, from), 'the books close in each unit');
    // open again: one more, for the new screen
    app.state.screen = 'home';
    app.goSwap();
    await until(() => !app.state.swapProbing, 8000);
    ok(probes === 2 && c.asks.mint - m0 === 2, 'a SWAP opened again probes once more, paced from the last', String(c.asks.mint - m0));
    // a probe from a balance swapped before asks at that swap's size
    app._swapLast = { usd: 1234 };
    app.state.screen = 'home';
    let probedAt = null;
    c.W.swapProbe = function (f, t, a) { probedAt = a; probes += 1; return realProbe.apply(this, arguments); };
    app.goSwap();
    await until(() => !app.state.swapProbing, 8000);
    ok(probedAt === 1234, 'and at the last swap’s size from that balance, when there was one', String(probedAt));
    // not beside a quote already out
    app.state.screen = 'home';
    app._swapAskOut = new Promise(() => {});
    const p0 = probes;
    app.goSwap();
    await wait(20);
    ok(probes === p0 && !app.state.swapProbing, 'no probe while the confirmation’s own quote is still out');
    app._swapAskOut = null;
    // offline
    app.state.screen = 'home';
    app.offline = true;
    app._swapProbed = {};
    app.swapProbe('usd');
    await wait(20);
    ok(probes === p0 && !app.state.swapProbing, 'no probe offline');
    app.offline = false;
    app.state.screen = 'home';
  }
  // a one-unit mint
  {
    const c = page({ mintOpts: { units: ['sat'] } });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 5000, 'sat');
    const app = appOn(c);
    const n0 = c.asks.mint;
    app.goSwap();
    app.swapProbe('sat');
    await wait(50);
    ok(c.asks.mint === n0 && !app.state.swapProbing && /only bitcoin/.test(app.log.toasts.pop() || ''),
      'a one-unit mint: SWAP is refused and nothing is probed');
    let threw = '';
    await c.W.swapProbe('sat', 'usd').catch((e) => { threw = e.message; });
    ok(/only bitcoin/.test(threw) && c.asks.mint === n0, 'and the wallet’s probe refuses it without asking the mint', threw);
  }

  // ---- 2. quoted as it is typed, and NEXT on that quote ---------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'usd');
    await fund(c, 40000, 'sat');
    const from = books(c);
    const app = appOn(c);
    app.goSwap();
    await until(() => !app.state.swapProbing, 5000);
    app.swapToAmount();
    let quotes = 0;
    const realQuote = c.W.swapQuote;
    c.W.swapQuote = function () { quotes += 1; return realQuote.apply(this, arguments); };
    app.paceGone();   // as if the probe were long gone
    app.typeIt('10.00');
    await wait(400);
    ok(quotes === 0, 'nothing asked while the figure is still moving (400 ms)');
    await wait(300);
    ok(quotes === 1, 'still for 600 ms: its quote is asked, once', String(quotes));
    await until(() => app._swapAhead && app._swapAhead.q, 5000);
    ok(app._swapAhead.q.total <= 1000 && app._swapAhead.amount === 1000, 'a quote for $ 10.00 in hand', JSON.stringify(app._swapAhead.q.total));
    await wait(700);
    ok(quotes === 1, 'and not asked again while the figure stays put');
    // NEXT within the hold: the confirmation opens filled, and the mint is asked nothing
    const held = app._swapAhead.q;
    const n0 = pairs(c);
    app.swapNext(false);
    ok(app.state.screen === 'swapConfirm' && app.state.swapQuote === held && !app.state.swapQuoting,
      'NEXT on a held quote for exactly that figure: the confirmation is filled at once');
    await wait(100);
    ok(pairs(c) === n0 && quotes === 1, 'with no quote request at NEXT', n0 + ' → ' + pairs(c));
    ok(app.swapSpec().cta === 'SWAP' && /^Rate held for 00:[0-5]\d$/.test((app.swapSpec().rows[3] || {}).sub || ''), 'SWAP, with the hold counting on',
      (app.swapSpec().rows[3] || {}).sub);
    // and it swaps, the books closing
    app.swapGo();
    await until(() => app.state.screen !== 'swapConfirm' || app.state.swapErr, 8000);
    ok(app.state.screen === 'swapDone' && app.state.swapResult.from.amount === held.total && c.W.balanceOf('sat') === 40000 + held.get,
      'SWAP runs that quote to SWAPPED', app.state.swapErr);
    ok(off(c, from), 'the books close in each unit, off by 0');
    ok(app._swapLast && app._swapLast.usd === held.total, 'and the next probe from dollars will ask at this size');
    app.swapDoneClose();
  }

  // a changed figure drops the quote; a short hold or another figure is asked afresh; NEXT waits for one on its way
  {
    const c = page({ mintOpts: { units: ['sat', 'usd'], usdQuoteTtl: 60 } });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'usd');
    const app = appOn(c);
    app.goSwap();
    await until(() => !app.state.swapProbing, 5000);
    app.swapToAmount();
    let quotes = 0;
    const realQuote = c.W.swapQuote;
    c.W.swapQuote = function () { quotes += 1; return realQuote.apply(this, arguments); };
    app.paceGone();
    app.typeIt('10.00');
    await until(() => app._swapAhead && app._swapAhead.q, 5000);
    const ten = app._swapAhead;
    app.typeIt('12.00');
    app.paceGone();
    await wait(700);
    await until(() => app._swapAhead && app._swapAhead.q && app._swapAhead.amount === 1200, 5000);
    ok(app._swapAhead !== ten && app._swapAhead.amount === 1200, 'typed again: the $ 10.00 quote is dropped for one for $ 12.00');
    // another figure at NEXT: asked afresh
    app.state.amount = '9.00';
    let n0 = pairs(c);
    app.swapNext(false);
    ok(app.state.swapQuoting && !app.state.swapQuote, 'NEXT on another figure than the one quoted: the rate is asked');
    await until(() => app.state.swapQuote, 5000);
    ok(app.state.swapQuote.total <= 900 && app.state.swapQuote.total > 880 && pairs(c) !== n0, 'for $ 9.00, with a request to the mint');
    app.back();
    // a hold too short
    app.state.amount = '12.00';
    app._swapAhead.q.expiresAt = Date.now() + 15000 + 9000;
    n0 = c.asks.mint;
    app.swapNext(false);
    ok(app.state.swapQuoting && !app.state.swapQuote, 'NEXT on a quote with ten seconds or less of its hold left: asked afresh');
    await until(() => app.state.swapQuote, 5000);
    ok(c.asks.mint > n0 && app.swapLeft() > 30, 'a new quote, held for the full time', String(app.swapLeft()));
    app.back();
    // NEXT while that very figure is out
    const s = page({ slow: 300 });
    await s.W.connect(MINT, { remember: true });
    await fund(s, 3000, 'usd');
    const b = appOn(s);
    b.goSwap();
    await until(() => !b.state.swapProbing, 8000);
    b.swapToAmount();
    b.paceGone();
    let bq = 0;
    const bReal = s.W.swapQuote;
    s.W.swapQuote = function () { bq += 1; return bReal.apply(this, arguments); };
    b.typeIt('7.00');
    await until(() => b._swapAhead && b._swapAhead.asking, 6000);
    b.swapNext(false);
    ok(b.state.screen === 'swapConfirm' && b.state.swapQuoting && !b.state.swapQuote, 'NEXT while $ 7.00 is being asked: the confirmation waits for it');
    await until(() => b.state.swapQuote, 12000);
    ok(b.state.swapQuote === b._swapAhead.q && bq === 1, 'and opens on that answer, with no second question to the mint', String(bq));
    b.state.screen = 'home';
    app.state.screen = 'home';
  }

  // ---- 3. one at a time, never closer than the gap ------------------------------------------------
  {
    const c = page({ slow: 400 });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'usd');
    const aheadFrom = c.asks.at.length;
    const app = appOn(c);
    app.goSwap();
    await until(() => !app.state.swapProbing, 8000);
    app.swapToAmount();
    const starts = [];
    const realQuote = c.W.swapQuote;
    c.W.swapQuote = function (f, t, a) { starts.push([Date.now(), a]); return realQuote.apply(this, arguments); };
    const probeAt = Math.max.apply(null, c.W._swapPairs);
    app.typeIt('5.00');
    await until(() => starts.length === 1, 5000);
    ok(starts[0][0] - probeAt >= GAP - 50, 'the first typed quote waits out the gap from the probe', String(starts[0][0] - probeAt));
    // a new figure while it is out: it waits for the answer, then the gap from the start
    app.typeIt('6.00');
    await wait(700);
    ok(starts.length === 1 && app._swapAheadWaiting, 'a new figure while one is out waits for it');
    await until(() => starts.length === 2, 6000);
    ok(starts[1][1] === 600 && starts[1][0] - starts[0][0] >= GAP - 50, 'then asks for the new figure, the gap after the last',
      JSON.stringify(starts.map((x) => [x[0] - starts[0][0], x[1]])));
    // a figure changed and changed back while one is out: nothing more asked
    await until(() => app._swapAhead && app._swapAhead.q, 6000);

    app.typeIt('6.50');
    await until(() => starts.length === 3, 6000);
    app.typeIt('6.00');
    app.typeIt('6.50');
    await wait(700);
    await until(() => !app._swapAheadOut, 6000);
    await wait(200);
    ok(starts.length === 3, 'a figure that is the one already out is not asked again when that answer comes', String(starts.length));
    // every pair asked ahead (the probe's, and each pass of each typed quote) the gap from the one before
    const gaps = c.asks.at.slice(aheadFrom).map((t, i, l) => (i ? t - l[i - 1] : 0)).slice(1);
    ok(gaps.length >= 4 && gaps.every((g) => g >= GAP - 50), 'every pair asked ahead, second passes included, the gap or more after the last', JSON.stringify(gaps));
    app.state.screen = 'home';
  }

  // ---- 4. the first pass taken when it fits ----------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 5000, 'usd');
    await fund(c, 60000, 'sat');
    const from = books(c);
    let n = c.asks.mint;
    await c.W.swapProbe('usd', 'sat');
    ok(c.asks.mint - n === 1, 'a probe: one pair, about a thousand sats’ worth');
    n = c.asks.mint;
    const a = await c.W.swapQuote('usd', 'sat', 1000);
    ok(c.asks.mint - n >= 2, '$ 10.00 sized from the probe alone (a fixed fee read as a share): under, so a second is asked', String(c.asks.mint - n));
    n = c.asks.mint;
    const b = await c.W.swapQuote('usd', 'sat', 1000);
    ok(c.asks.mint - n === 1 && c.asks.melt >= 1 && b.total <= 1000 && 1000 - b.total <= 1,
      'the same figure again: one pair, within a cent under', (c.asks.mint - n) + ' pair(s), total ' + b.total);
    ok(b.total >= a.total, 'and no less than the two-pass quote gave', a.total + ' / ' + b.total);
    // two sizes seen tell a fixed fee from a share: another figure lands in one pair too
    n = c.asks.mint;
    const d = await c.W.swapQuote('usd', 'sat', 2345);
    ok(c.asks.mint - n === 1 && d.total <= 2345 && 2345 - d.total <= 1, '$ 23.45 after the probe and $ 10.00, the fee read from the two: one pair', (c.asks.mint - n) + ' pair(s), total ' + d.total);
    // the other way: a cent of what arrives costs a dozen sats or so, which is the most it can land under
    await c.W.swapQuote('sat', 'usd', 20000);
    n = c.asks.mint;
    const e = await c.W.swapQuote('sat', 'usd', 20000);
    const step = Math.ceil(e.amount / e.get);
    ok(c.asks.mint - n === 1 && e.total <= 20000 && 20000 - e.total <= step, 'bitcoin into dollars, the same figure again: one pair, within one cent’s worth under',
      (c.asks.mint - n) + ' pair(s), total ' + e.total + ', step ' + step);
    // a rate that has moved since: the first pass does not fit, and the second is still asked
    const key = Object.keys(c.W._swapSeen).find((k) => /\|usd\|sat$/.test(k));
    c.W._swapSeen[key] = c.W._swapSeen[key].map((p) => Object.assign({}, p, { get: Math.round(p.get * 1.05) }));
    n = c.asks.mint;
    const f = await c.W.swapQuote('usd', 'sat', 1500);
    ok(c.asks.mint - n >= 2 && f.total <= 1500, 'a pair seen at another rate: the first pass is over, and the second is asked', (c.asks.mint - n) + ' pair(s), total ' + f.total);
    c.W._swapSeen[key] = c.W._swapSeen[key].map((p) => Object.assign({}, p, { get: Math.round(p.get * 0.9) }));
    n = c.asks.mint;
    const g = await c.W.swapQuote('usd', 'sat', 1500);
    ok(c.asks.mint - n >= 2 && g.total <= 1500, 'and one well under: the second is asked as before', (c.asks.mint - n) + ' pair(s), total ' + g.total);
    // run the one-pair quote: what leaves and what arrives are the quote's, and the books close
    const h = await c.W.swapQuote('usd', 'sat', 1000);
    const usd0 = c.W.balanceOf('usd'), sat0 = c.W.balanceOf('sat');
    const done = await c.W.swapRun(h);
    ok(done.state === 'done' && c.W.balanceOf('usd') === usd0 - h.total && c.W.balanceOf('sat') === sat0 + h.get,
      'a one-pair quote swaps as any other', JSON.stringify(done.state));
    ok(off(c, from), 'the books close in each unit, off by 0');
  }


  // ---- 5. from bitcoin, typed in dollars: NEXT takes the quote asked for those keys ----------------------
  /* The keypad in dollars converts at the mint's last rate, and the background quote's own answer moves that rate, so
   * the same keys come to a few sats more than were quoted. The quote is matched on the keys, and its figure taken. */
  {
   const c = page();
   await c.W.connect(MINT, { remember: true });
   await fund(c, 3000, 'usd');
   await fund(c, 200000, 'sat');
   const app = appOn(c);
   app.goSwap();
   await until(() => !app.state.swapProbing, 8000);
   app.swapFlip();
   app.swapToAmount();
   await until(() => !app._swapAheadOut, 8000);
   ok(app.swapUnits().from === 'sat' && app.state.unit === 'USD', 'from bitcoin, SET AMOUNT opens in dollars');
   for (const fig of ['10.00', '25.00', '7.37', '50.00']) {
    if (app.state.screen === 'swapConfirm') app.back();
    app.paceGone();
    app.typeIt(fig);
    await until(() => app._swapAhead && app._swapAhead.q && app._swapAhead.keypad === 'USD ' + fig, 8000);
    const ahead = app._swapAhead;
    const n0 = pairs(c);
    app.swapNext(false);
    ok(app.state.screen === 'swapConfirm' && app.state.swapQuote === ahead.q && !app.state.swapQuoting
      && app.state.swapAmount === ahead.amount,
    '$ ' + fig + ' from bitcoin: NEXT opens filled on the quote asked for those keys (' + ahead.amount + ' sats; the keys now come to '
      + app.swapTyped() + ')');
    await wait(50);
    ok(pairs(c) === n0, 'with no quote request at NEXT', n0 + ' → ' + pairs(c));
   }
   app.state.screen = 'home';
  }
  // the same, NEXT while that quote is still on its way
  {
    const c = page({ slow: 300 });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'usd');
    await fund(c, 200000, 'sat');
    const app = appOn(c);
    app.goSwap();
    await until(() => !app.state.swapProbing, 8000);
    app.swapFlip();
    app.swapToAmount();
    await until(() => !app._swapAheadOut, 8000);
    app.paceGone();
    let quotes = 0;
    const realQuote = c.W.swapQuote;
    c.W.swapQuote = function () { quotes += 1; return realQuote.apply(this, arguments); };
    app.typeIt('12.00');
    await until(() => app._swapAhead && app._swapAhead.asking, 6000);
    app.swapNext(false);
    ok(app.state.swapQuoting && !app.state.swapQuote, 'from bitcoin in dollars, NEXT while the keys’ quote is out: the confirmation waits for it');
    await until(() => app.state.swapQuote, 12000);
    ok(app.state.swapQuote === app._swapAhead.q && quotes === 1 && app.state.swapAmount === app._swapAhead.amount,
      'and opens on that answer, with no second question', String(quotes));
    app.state.screen = 'home';
  }

  // ---- 6. never another direction's quote, another mint's, or a screen before's ----------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'usd');
    await fund(c, 200000, 'sat');
    const app = appOn(c);
    app.goSwap();
    await until(() => !app.state.swapProbing, 8000);
    app.swapToAmount();
    app.paceGone();
    app.typeIt('10.00');
    await until(() => app._swapAhead && app._swapAhead.q, 8000);
    const held = app._swapAhead;
    // the other way round, the same keys: the dollars-into-bitcoin quote is not this one
    app.state.swapFrom = 'sat'; app.state.swapTo = 'usd';
    let n0 = pairs(c);
    app.swapNext(false);
    ok(app.state.swapQuoting && app.state.swapQuote !== held.q, 'the same keys the other way round: the held quote is not taken, the rate is asked');
    await until(() => app.state.swapQuote, 8000);
    ok(app.state.swapQuote.from === 'sat' && pairs(c) !== n0, 'for bitcoin into dollars', app.state.swapQuote.from);
    app.back();
    app.state.swapFrom = 'usd'; app.state.swapTo = 'sat';
    // a screen opened again: what was asked for the last one is gone
    app._swapAhead = held;
    app.state.screen = 'home';
    app.goSwap();
    await until(() => !app.state.swapProbing, 8000);
    app.swapToAmount();
    app.state.amount = '10.00';
    n0 = pairs(c);
    app.swapNext(false);
    ok(app.state.swapQuoting && app.state.swapQuote !== held.q, 'SWAP opened again, the same keys: the last screen’s quote is not taken');
    await until(() => app.state.swapQuote, 8000);
    app.back();
    // another mint: a quote asked at the last one is not taken there, even without a new screen
    app.paceGone();
    app.typeIt('11.00');
    await until(() => app._swapAhead && app._swapAhead.q && app._swapAhead.amount === 1100, 8000);
    const atFirst = app._swapAhead;
    await c.W.connect(OTHER, { remember: true });
    await fund(c, 3000, 'usd');
    app.refreshBalance();
    ok(app._swapAhead === atFirst && app.swapAheadMine() === null, 'connected to another mint: the quote asked at the first is not this mint’s');
    n0 = pairs(c);
    app.swapNext(false);
    ok(app.state.swapQuoting && app.state.swapQuote !== atFirst.q, 'and NEXT there asks the new mint');
    await until(() => app.state.swapQuote, 8000);
    ok(app.state.swapQuote.mint === c.W.mintUrl && app.state.swapQuote.mint !== atFirst.q.mint, 'whose quote it is', app.state.swapQuote.mint);
    app.back();
    // a quote that says it is another mint's is not taken, whatever the record of where it was asked says
    app.paceGone();
    app.typeIt('12.00');
    await until(() => app._swapAhead && app._swapAhead.q && app._swapAhead.amount === 1200, 8000);
    ok(app.swapAheadMine() === app._swapAhead, 'asked here, it is this mint’s');
    app._swapAhead.q = Object.assign({}, app._swapAhead.q, { mint: MINT });
    ok(app.swapAheadMine() === null, 'a quote from another mint is never matched');
    app.state.screen = 'home';
  }

  // ---- 7. one probe per direction per screen; the ⇅ asks the other way's ------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'usd');
    const app = appOn(c);
    const probed = [];
    const realProbe = c.W.swapProbe;
    c.W.swapProbe = function (f) { probed.push(f); return realProbe.apply(this, arguments); };
    app.goSwap();
    await until(() => !app.state.swapProbing, 8000);
    app.swapProbe('usd');
    await wait(50);
    ok(probed.join() === 'usd' && !app.state.swapProbing, 'the probe answered, asked again from the same screen: nothing asked', probed.join());
    app.swapFlip();
    ok(app.state.swapProbing, 'the ⇅: the other way’s rate is asked');
    await until(() => !app.state.swapProbing, 8000);
    ok(probed.join() === 'usd,sat' && Object.keys(c.W._swapSeen).some((k) => /\|sat\|usd$/.test(k)), 'from bitcoin, once', probed.join());
    app.swapFlip();
    app.swapFlip();
    await wait(50);
    ok(probed.join() === 'usd,sat', 'and never again for this screen, either way', probed.join());
    // a ⇅ while the first is still out: that way's goes once the first answers
    app.state.screen = 'home';
    app.goSwap();
    app.swapFlip();
    await until(() => probed.length === 4 && !app.state.swapProbing, 8000);
    ok(probed.slice(2).join() === 'usd,sat', 'a ⇅ while the probe is out: the other way’s is asked after it', probed.join());
    // an old rate is not the mint's now
    const realRate = c.W.mintRate;
    app.state.flow = 'swap';
    app.state.swapProbing = false;
    c.W.mintRate = () => ({ usdPerBtc: 70000, at: Date.now() - 11 * 60000 });
    ok(app.swapRateLine() === 'MARKET PRICE ₿ 1 = $ 76,000', 'a mint rate eleven minutes old: the market price is shown, said to be the market’s', app.swapRateLine());
    c.W.mintRate = () => ({ usdPerBtc: 70000, at: Date.now() - 9 * 60000 });
    ok(app.swapRateLine() === 'FORGE’S RATE ₿ 1 = $ 70,000', 'nine minutes old: still the mint’s', app.swapRateLine());
    c.W.mintRate = realRate;
    app.state.screen = 'home';
  }

  // ---- 8. the minute's budget, and the confirmation's pairs counted ------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'usd');
    await fund(c, 40000, 'sat');
    // the person's own quote is never held back, and is counted
    c.W._swapPairs = [];
    const t0 = Date.now();
    await c.W.swapQuote('usd', 'sat', 1000);
    ok(c.W._swapPairs.length >= 1 && Date.now() - t0 < 1000, 'a quote a person waits on goes at once, and its pairs are counted', String(c.W._swapPairs.length));
    ok(c.W._swapPaceWait(GAP, 8) > GAP - 200, 'so a question asked ahead waits the gap from it', String(c.W._swapPaceWait(GAP, 8)));
    // eight pairs in the minute: the next asked ahead waits until the oldest is a minute old
    const now = Date.now();
    c.W._swapPairs = [50, 45, 40, 35, 30, 25, 20, 15].map((s) => now - s * 1000);
    const w8 = c.W._swapPaceWait(GAP, 8);
    ok(w8 > 9000 && w8 <= 10000, 'eight pairs in the last minute: the next asked ahead waits for the oldest to be a minute old', String(w8));
    ok(c.W._swapPaceWait(GAP, 9) === 0, 'seven or fewer, and the gap kept: no wait');
    // through the app: figures typed again and again with a budget of three a minute ask three pairs, no more
    const app = appOn(c);
    app.SWAP_AHEAD_PER_MIN = 3;
    app.SWAP_AHEAD_GAP_MS = 200;
    app.SWAP_TYPED_MS = 100;
    app.state.screen = 'amount'; app.state.flow = 'swap'; app.state.swapFrom = 'usd'; app.state.swapTo = 'sat'; app.state.unit = 'USD';
    app._swapProbed = { usd: true, sat: true };
    c.W._swapPairs = [];
    const m0 = c.asks.mint;
    for (const fig of ['3.00', '4.00', '5.00', '6.00', '7.00', '8.00', '9.00']) {
      app.typeIt(fig);
      await wait(450);
    }
    await wait(400);
    ok(c.asks.mint - m0 === 3, 'a budget of three pairs a minute: seven figures typed and left still ask three pairs', String(c.asks.mint - m0));
    // the confirmation's own question then goes at once, budget or none
    const n0 = c.asks.mint;
    const t1 = Date.now();
    app.swapNext(false);
    await until(() => app.state.swapQuote, 8000);
    ok(c.asks.mint > n0 && Date.now() - t1 < 1500, 'and NEXT’s own question is not held back by it', (Date.now() - t1) + ' ms');
    app.state.screen = 'home';
    clearTimeout(app._swapTypedT);
  }

  // ---- 9. NEXT on a figure whose quote is waiting out its pace: the wait is let go ------------------------
  {
    const c = page({ slow: 200 });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'usd');
    const app = appOn(c);
    app.SWAP_AHEAD_GAP_MS = 8000;
    app.state.screen = 'amount'; app.state.flow = 'swap'; app.state.swapFrom = 'usd'; app.state.swapTo = 'sat'; app.state.unit = 'USD';
    app._swapProbed = { usd: true, sat: true };
    c.W._swapSeen = {};       // nothing seen: the first pass is the rough guess, and a second pass is needed
    app.paceGone();
    let quotes = 0;
    const realQuote = c.W.swapQuote;
    c.W.swapQuote = function () { quotes += 1; return realQuote.apply(this, arguments); };
    const m0 = c.asks.mint, l0 = c.asks.melt;
    app.typeIt('10.00');
    // the first pair has gone and come back; the second waits the gap
    const paced = await until(() => c.asks.mint - m0 === 1 && c.asks.melt - l0 === 1 && app._swapAhead && app._swapAhead.asking
      && c.W._swapPaceWait(8000, 0) > 4000, 6000);
    ok(paced, 'a figure’s first pass not close enough: its second waits out the gap');
    const t0 = Date.now();
    app.swapNext(false);
    await until(() => app.state.swapQuote, 12000);
    ok(app.state.swapQuote && Date.now() - t0 < 3000 && quotes === 1, 'NEXT while that quote waits its pace: the person is waiting now, so it goes at once',
      (Date.now() - t0) + ' ms, ' + quotes + ' question(s)');
    app.state.screen = 'home';
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
})().catch((e) => { console.log('THREW', (e && e.stack) || e); process.exit(1); });
