'use strict';
/* two-balances-swap.js — SWAP, dollars into bitcoin and back, the whole way through.
 *
 *     node tests/two-balances-swap.js
 *
 * The swap is two halves built apart: the wallet's swapQuote / swapRun (build/wallet/16b-two-balances.js) and the
 * screens that ask for them (build/app/26i-swap.js and its blocks in build/markup.html). This holds the two together.
 *
 * Part 1 runs the app's own swap methods, lifted from the build, on the page of a real wallet (loadReal: the
 * bundled cashu-ts, the phone's seed) at the harness's mint with a usd keyset (fakeMint `units`), as a person
 * would: SWAP, the direction, the amount, the confirmation, SWAP. Each scenario ends with the books of the page
 * closing in each unit (harness `books`, per mint@unit):
 *   - a quote, and the confirmation's four blocks drawn from it
 *   - a swap run to SWAPPED, a row on each side, both balances right
 *   - a rate that runs out on screen: asked again by itself, and the button reads CONFIRM NEW RATE once
 *   - the mint refusing the payment: nothing held, the pile whole, the screen says so
 *   - cut off after the payment (the claim's answer lost, and the payment's own answer lost): the card SWAP STILL
 *     GOING THROUGH, home's held pill, and the next connect finishing it into the right pile
 *
 * Part 2 mounts the real page (build/foxy-render.js, as tests/two-balances-screens.js does) on a stand-in wallet
 * that answers the swap calls, and reads what is drawn: the SWAP button, the two pills and the ⇅, SET AMOUNT in the
 * dollars with its ⇅ and ALL OF IT, the confirmation's four blocks with the countdown and the green SWAP, SWAPPED, both pills
 * glowing on home, SWAP dimmed offline, and the card for a swap still going through. */
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, books, PHONE_WORDS } = require('./harness');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const MINT = 'https://m.test';

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
const rows = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
const store = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };

// ---- one method of the app class, as the build has it -------------------------------------------
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
const LIFTED = ['goSwap() {', 'swapFlip() {', 'swapUnits() {', 'swapToAmount() {', 'swapTyped() {', 'swapNext(all) {',
  'swapAsk(again, amountGiven, allGiven) {', 'swapLeft() {', 'swapClock() {', 'swapGo() {', 'swapStillGoing(r) {', 'swapPendingCard(r) {', 'swapDoneClose() {',
  'swapRateOf(r) {', 'swapRateText(n) {', 'swapRateWho() {', 'swapInk(unit) {', 'swapEstimate() {', 'swapSpec() {',
  'swapExact() {', 'swapForget() {', 'swapRateHead() {', 'swapClockText(sec) {', 'swapWorth(n, unit, rate) {', 'swapCents(cents, sats) {',
  'renderSwap(c) {', 'cfRow(label, value, opt) {', 'unitFigure(amount, unit) {', 'unitWord(unit) {', 'unitBalance(unit) {',
  'centsTyped() {', 'usd(v) {', 'group(n) {', 'twoUnitsOn() {', 'offlineNow() {', 'moneyBusy() {', 'heldPill() {',
  'satUsd() {', 'recoveringSats() {', 'swapPx() {', 'centsOfSats(sats, px) {'];

// ---- a page at the mint (as tests/two-balances.js has it) ----------------------------------------
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: PHONE_WORDS });
  if (opts.phone) { phone.counters = opts.phone.counters; phone.locks = opts.phone.locks; }
  let mint = opts.mint || null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || m.path || '');
        if (ctx.lose && ctx.lose.test(url)) {
          ctx.lose = null;
          mint.handle(m);
          return reply(w, m.id, null, 'The network connection was lost.');
        }
        return reply(w, m.id, mint.handle(m));
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, Object.assign({ units: ['sat', 'usd'] }, opts.mintOpts || {}));
    },
  });
  ctx.lose = null;
  ctx.phone = phone;
  ctx.mint = () => mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._swapPollMs = 5;
  ctx.W._swapClaimWaitMs = 200;
  return ctx;
}
async function fund(c, amount, unit) {
  const inv = await c.W.invoice(amount, '', { unit: unit || 'sat' });
  return c.W.claim(inv.hash);
}
function booksMove(c, from) {
  const now = books(c);
  const out = {};
  new Set([...Object.keys(now), ...Object.keys(from || {})]).forEach((k) => {
    const a = now[k] || { off: 0 }, b = (from || {})[k] || { off: 0 };
    out[k] = a.off - b.off;
  });
  return out;
}
const booksClose = (c, from) => Object.values(booksMove(c, from)).every((n) => n === 0);

/* The app's swap methods on a page of the real wallet, with what they reach for outside themselves stood in:
 * setState is synchronous, the balances are the wallet's own, and cards, toasts and the count-up are recorded. */
function appOn(ctx) {
  const app = ctx.window.eval('(function () { return {' + LIFTED.map(method).join(',') + '}; })()');
  const W = ctx.W;
  const log = { toasts: [], cards: [], settled: [], melts: [] };
  Object.assign(app, {
    log,
    SWAP_MARGIN_MS: 15000, SWAP_REQUOTES: 3,
    state: { screen: 'home', stack: [], flow: '', unit: 'USD', amount: '', hidden: false, livePrice: 76900, satUsd: 76900 / 1e8 },
    setState(u) { Object.assign(app.state, typeof u === 'function' ? u(app.state) : u); },
    toast(m) { log.toasts.push(String(m)); },
    blockedCard(kind, over) { log.cards.push(Object.assign({ kind }, over)); },
    settleAnimate(lane) { log.settled.push(lane); },
    showMelt(t) { log.melts.push(t); }, hideMelt() {},
    mintName: () => 'Forge',
    px() { return app.state.livePrice || null; },
    stageMoney: (n) => '₿ ' + n,
    loadHistory() {},
    refreshBalance() { app.state.balSats = W.balanceOf('sat'); app.state.balUsdCents = W.balanceOf('usd'); return Promise.resolve(); },
    balNow() { return { sats: app.state.balSats, cents: app.state.balUsdCents, usd: 0 }; },
    back() { const st = app.state.stack; app.state.screen = st.length ? st[st.length - 1] : 'home'; app.state.stack = st.slice(0, -1); },
  });
  app.refreshBalance();
  return app;
}
const rowOf = (spec, label) => (spec.rows || []).find((r) => r.label === label) || {};

(async () => {
  console.log('foxy two balances: SWAP, the screens on the wallet\n');

  // ---- 1. a quote, and a swap run to SWAPPED ---------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 2000, 'usd');
    await fund(c, 30000, 'sat');
    const from = books(c);
    const app = appOn(c);
    app.goSwap();
    ok(app.state.screen === 'swap' && app.state.swapFrom === 'usd' && app.state.swapTo === 'sat', 'SWAP opens on dollars into bitcoin');
    let v = app.renderSwap({ s: app.state, sc: 'swap' });
    ok(v.swapRows.map((r) => r.label + ' ' + r.name + ' ' + r.text).join(' | ') === 'FROM DOLLARS $ 20.00 | TO BITCOIN ₿ 30,000',
      'the FROM pill over the TO pill, each with its balance', v.swapRows.map((r) => r.text).join(' | '));
    v.swapFlipGo();
    ok(app.state.swapFrom === 'sat' && app.state.swapTo === 'usd', '⇅ turns it round');
    app.swapFlip();
    app.swapToAmount();
    ok(app.state.screen === 'amount' && app.state.flow === 'swap' && app.state.unit === 'USD', 'NEXT: SET AMOUNT, typed in dollars');
    app.state.amount = '25.00';
    app.swapNext(false);
    ok(app.state.screen === 'amount' && /more than your dollars: you hold \$ 20\.00/.test(app.log.toasts.pop() || ''),
      'more than the dollars is not taken past the keypad');
    app.state.amount = '10.00';
    app.swapNext(false);
    ok(app.state.screen === 'swapConfirm' && app.state.swapAmount === 1000, 'NEXT with $ 10.00: the confirmation, 1,000 cents');
    let spec = app.swapSpec();
    ok(spec.cta === 'CHECKING THE RATE…' && spec.ctaBusy, 'it says it is checking the rate while it is asked');
    await until(() => app.state.swapQuote || app.state.swapErr);
    const q = app.state.swapQuote;
    ok(q && q.from === 'usd' && q.to === 'sat' && q.total <= 1000 && typeof q._melt === 'object', 'the wallet’s quote is kept whole, insides and all',
      app.state.swapErr);
    spec = app.swapSpec();
    ok(spec.title === 'SWAP' && spec.titleUp && !spec.amountLabel && !spec.amount, 'SWAP, with no TOTAL over the blocks', spec.amount);
    ok(JSON.stringify(spec.rows.map((r) => r.label)) === '["YOU ARE GETTING","YOU ARE SPENDING","FEE","FORGE’S RATE"]',
      'blocks YOU ARE GETTING, YOU ARE SPENDING, FEE, FORGE’S RATE, and no NETWORK', JSON.stringify(spec.rows.map((r) => r.label)));
    const qr = app.swapRateOf(q.rate);
    const getC = Math.round(q.get * qr / 1e6);
    ok(rowOf(spec, 'YOU ARE GETTING').value === app.unitFigure(getC, 'usd') + ' in BITCOIN'
      && rowOf(spec, 'YOU ARE GETTING').sub === '(' + app.unitFigure(q.get, 'sat') + ')' && rowOf(spec, 'YOU ARE GETTING').ink === '#F2742B',
      'YOU ARE GETTING: the bitcoin’s dollar worth, its sats under it, in fur ink', rowOf(spec, 'YOU ARE GETTING').value);
    ok(rowOf(spec, 'YOU ARE SPENDING').value === app.unitFigure(q.total, 'usd') + ' in DOLLARS' && rowOf(spec, 'YOU ARE SPENDING').sub === '',
      'YOU ARE SPENDING: the dollars that leave, exactly, with no sats line', rowOf(spec, 'YOU ARE SPENDING').value);
    ok(rowOf(spec, 'FEE').value === app.unitFigure(q.total - getC, 'usd'), 'the fee: what leaves less what arrives, in dollars', rowOf(spec, 'FEE').value);
    ok(/^₿ 1 = \$ 7[67],\d{3}$/.test(rowOf(spec, 'FORGE’S RATE').value), 'the rate is the mint’s, by name', rowOf(spec, 'FORGE’S RATE').value);
    ok(/^Rate held for 00:4\d$/.test(rowOf(spec, 'FORGE’S RATE').sub), 'and how long it is held for, under it', rowOf(spec, 'FORGE’S RATE').sub);
    ok(spec.cta === 'SWAP' && spec.ctaTone === 'money' && !spec.ctaBusy, 'the button is the green SWAP');
    const run = new Promise((r) => { const t = setInterval(() => { if (app.state.screen !== 'swapConfirm' || app.state.swapErr) { clearInterval(t); r(); } }, 5); });
    spec.go();
    ok(app._swapRun && app.moneyBusy(), 'while it runs, money is moving (a mint switch waits for it)');
    await run;
    ok(app.state.screen === 'swapDone' && app.state.swapResult && app.state.swapResult.state === 'done', 'SWAPPED', app.state.swapErr);
    v = app.renderSwap({ s: app.state, sc: 'swapDone' });
    const r = app.state.swapResult;
    ok(v.isSwapDone && v.swapDoneRows[0].text === '−' + app.unitFigure(r.from.amount, 'usd') && v.swapDoneRows[1].text === '+' + app.unitFigure(q.get, 'sat'),
      'what left in frost, what arrived in fur', v.swapDoneRows.map((x) => x.text).join(' '));
    ok(c.W.balanceOf('usd') === 2000 - r.from.amount && c.W.balanceOf('sat') === 30000 + q.get, 'both balances moved by their own figures');
    const legs = rows(c).filter((x) => x.swap === q.id);
    ok(legs.length === 2 && legs.every((x) => x.kind === 'swap'), 'a row on each side, both marked as the swap');
    ok(app.swapRateOf(legs[0].mintRate) > 0 && app.swapRateOf({ usdPerBtc: 5 }) === 5, 'the rate on a row reads as a number, or an object');
    app.swapDoneClose();
    ok(app.state.screen === 'home' && app.log.settled.pop() === 'both', 'DISMISS: home, and both pills count up');
    ok(booksClose(c, from), 'the books close in each unit', JSON.stringify(booksMove(c, from)));
    app.state.screen = 'home';
    await wait(1100);
    ok(!app._swapClockT, 'the countdown stopped with its screen');
  }

  // ---- 2. a rate that runs out on screen ------------------------------------------------------------
  {
    // a usd invoice that lives seventeen seconds: two to tap, then the rate runs out
    const c = page({ mintOpts: { units: ['sat', 'usd'], usdQuoteTtl: 17 } });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 40000, 'sat');
    const from = books(c);
    const app = appOn(c);
    app.goSwap();
    ok(app.state.swapFrom === 'sat', 'with no dollars, SWAP opens on bitcoin into dollars');
    app.swapToAmount();
    ok(app.state.unit === 'USD', 'bitcoin leaving is typed in dollars to start, too');
    app.swapNext(true);
    ok(app.state.swapAmount === 40000 && app.state.swapAll, 'ALL OF IT: the whole bitcoin balance');
    await until(() => app.state.swapQuote);
    const first = app.state.swapQuote;
    ok(first && app.swapLeft() <= 2, 'held for under two seconds', String(app.swapLeft()));
    await until(() => app.state.swapQuote && app.state.swapQuote !== first, 5000);
    const second = app.state.swapQuote;
    ok(second && second.id !== first.id && app.state.swapNewRate === true, 'when it runs out a new rate is asked for by itself');
    ok(app.swapSpec().cta === 'CONFIRM NEW RATE', 'and the button reads CONFIRM NEW RATE');
    app.swapGo();
    ok(!app._swapRun && c.W.balanceOf('sat') === 40000, 'a tap the moment the rate changed is not taken for the new one');
    // the next rate: confirmed, it runs (it holds two seconds, so it is taken while it lasts)
    await until(() => app.state.swapQuote && app.state.swapQuote !== second, 5000);
    app._swapQuotedAt = Date.now() - 2000;
    ok(app.swapSpec().cta === 'CONFIRM NEW RATE', 'still CONFIRM NEW RATE on the next one');
    const third = app.state.swapQuote;
    app.swapGo();
    await until(() => app.state.screen !== 'swapConfirm' || app.state.swapErr, 5000);
    ok(app.state.screen === 'swapDone' && c.W.balanceOf('usd') === third.get, 'CONFIRM NEW RATE swaps at the new rate', app.state.swapErr);
    ok(booksClose(c, from), 'the books close in each unit', JSON.stringify(booksMove(c, from)));
    app.state.screen = 'home';
  }
  // left alone, it stops asking
  {
    const c = page({ mintOpts: { units: ['sat', 'usd'], usdQuoteTtl: 16 } });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 9000, 'sat');
    const app = appOn(c);
    app.SWAP_REQUOTES = 1;
    app.goSwap(); app.swapToAmount(); app.swapNext(true);
    await until(() => app.state.swapLapsed, 6000);
    ok(app.state.swapLapsed && !app.state.swapQuote, 'a confirmation nobody looks at stops asking after its new rates');
    const spec = app.swapSpec();
    ok(spec.cta === 'GET A NEW RATE' && /ran out/.test(spec.chip), 'and offers to ask again', spec.chip);
    app.state.screen = 'home';
  }

  // backed out of while the rate was being asked, and NEXT again: the answer to the first is not waited on for ever
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 900, 'usd');
    const app = appOn(c);
    app.goSwap(); app.swapToAmount(); app.state.amount = '5.00'; app.swapNext(false);
    app.back();
    ok(app.state.screen === 'amount', 'back to SET AMOUNT while the rate is asked');
    await until(() => !app.state.swapQuoting);
    ok(!app.state.swapQuoting && !app.state.swapQuote, 'its answer ends the wait, and is not kept for a screen that has gone');
    app.state.amount = '4.00'; app.swapNext(false);
    await until(() => app.state.swapQuote);
    ok(app.state.swapQuote && app.state.swapQuote.total <= 400 && app.state.swapQuote.total > 380, 'NEXT again asks for the new amount', JSON.stringify(app.state.swapQuote && app.state.swapQuote.total));
    app.state.screen = 'home';
  }

  // ---- 3. the mint refuses the payment ----------------------------------------------------------------
  {
    const c = page({ mintOpts: { units: ['sat', 'usd'], meltRefuse: true } });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 900, 'usd');
    const from = books(c);
    const app = appOn(c);
    app.goSwap(); app.swapToAmount(); app.state.amount = '5.00'; app.swapNext(false);
    await until(() => app.state.swapQuote);
    app.swapGo();
    await until(() => !app._swapRun && !app.state.swapBusy);
    ok(app.state.screen === 'swapConfirm' && /did not make this swap\. Nothing moved/.test(app.state.swapErr), 'the confirmation says nothing moved', app.state.swapErr);
    const spec = app.swapSpec();
    ok(spec.cta === 'TRY AGAIN' && spec.ctaTone === 'warn' && spec.warn === app.state.swapErr, 'and offers TRY AGAIN');
    ok(c.W.balanceOf('usd') === 900 && c.W.heldIn('usd') === 0, 'the dollars are whole and nothing is held', c.W.balanceOf('usd') + ' / ' + c.W.heldIn('usd'));
    ok(!JSON.parse(c.storage.getItem('foxy.cashu.melting') || '[]').length && c.W.unitSwapsPending().length === 0, 'no hold, no swap left pending');
    ok(app.heldPill() === '', 'home’s held pill has nothing to say');
    ok(booksClose(c, from), 'the books close in each unit', JSON.stringify(booksMove(c, from)));
    app.state.screen = 'home';
  }

  // ---- 4. cut off after the payment -----------------------------------------------------------------
  /* Three ways a swap is cut off once its payment has gone to the mint: the claim's answer lost (the swap's
   * invoice paid, its ecash not yet taken), the mint leaving the payment PENDING (the dollars held in a melt
   * record until it says), and the payment's own answer lost, which the wallet asks the mint about at once. */
  for (const [what, mintOpts, lose] of [
    ['the claim’s answer lost', {}, /\/v1\/mint\/bolt11$/],
    ['the payment left pending', { meltPending: true }, null],
  ]) {
    const a = page({ mintOpts: Object.assign({ units: ['sat', 'usd'] }, mintOpts) });
    await a.W.connect(MINT, { remember: true });
    await fund(a, 1500, 'usd');
    const from = books(a);
    const app = appOn(a);
    app.goSwap(); app.swapToAmount(); app.state.amount = '10.00'; app.swapNext(false);
    await until(() => app.state.swapQuote);
    const q = app.state.swapQuote;
    a.lose = lose;
    app.swapGo();
    await until(() => !app._swapRun && !app.state.swapBusy, 5000);
    const card = app.log.cards.pop() || {};
    ok(app.state.screen === 'home' && card.title === 'SWAP STILL GOING THROUGH', what + ': SWAP STILL GOING THROUGH, and home', card.title);
    const fig = app.unitFigure(q.total, 'usd');
    ok((card.reason || '').indexOf('has your ' + fig + ' ') >= 0 && /Nothing is lost/.test(card.chip || ''), 'the card names what the mint has', card.reason);
    ok(a.W.unitSwapsPending().length === 1, 'the swap is on record as still with the mint');
    ok(app.heldPill() === fig + ' pending with the mint', 'home’s held pill names it', app.heldPill());
    ok(a.W.balanceOf('sat') === 0, 'and the bitcoin is not in the balance yet');
    if (mintOpts.meltPending) {
      const hold = JSON.parse(a.storage.getItem('foxy.cashu.melting') || '[]').find((h) => h.swap === q.id);
      ok(!!hold && hold.unit === 'usd', 'the dollars are held in a melt record that names the swap and its unit');
      // the mint pays it while the app is away
      a.mint().settleMelt(hold.quote, 'paid');
    }
    // the next launch: the same storage, the same phone, the same mint
    const b = page({ storage: store(a), phone: a.phone, mint: a.mint() });
    // judged at exit against the books before the swap, not as they stood with the dollars still with the mint
    b.booksFrom = from;
    await b.W.connect(MINT, { remember: true });
    const fin = await until(() => b.W.balanceOf('sat') === q.get && b.W.unitSwapsPending().length === 0, 4000);
    ok(fin, 'the next connect finishes it into the bitcoin pile', b.W.balanceOf('sat') + ' sats, ' + b.W.unitSwapsPending().length + ' pending');
    const usdLeft = b.W.balanceOf('usd');
    ok(usdLeft >= 1500 - q.total && usdLeft <= 1500 - q.amount && b.W.heldIn('usd') === 0,
      'the dollars are what is left after the swap and its fee, and nothing is held any more', usdLeft + ' cents, ' + b.W.heldIn('usd') + ' held');
    ok(rows(b).filter((x) => x.swap === q.id).length === 2, 'with a row on each side');
    const bApp = appOn(b);
    ok(bApp.heldPill() === '', 'and home’s held pill is gone');
    ok(booksClose(b, from), 'the books close in each unit', JSON.stringify(booksMove(b, from)));
    app.state.screen = 'home';
  }

  // the payment's own answer lost: the wallet asks the mint what became of it, and finishes the swap there and then
  {
    const a = page();
    await a.W.connect(MINT, { remember: true });
    await fund(a, 1500, 'usd');
    const from = books(a);
    const app = appOn(a);
    app.goSwap(); app.swapToAmount(); app.state.amount = '10.00'; app.swapNext(false);
    await until(() => app.state.swapQuote);
    const q = app.state.swapQuote;
    a.lose = /\/v1\/melt\/bolt11$/;
    app.swapGo();
    await until(() => !app._swapRun && !app.state.swapBusy, 5000);
    ok(app.state.screen === 'swapDone' && a.W.balanceOf('sat') === q.get && a.W.unitSwapsPending().length === 0,
      'the payment’s own answer lost: the mint is asked, and the swap ends SWAPPED', app.state.screen);
    ok(booksClose(a, from), 'the books close in each unit', JSON.stringify(booksMove(a, from)));
    app.state.screen = 'home';
  }

  // ---- 5. offline, and a mint with one balance --------------------------------------------------------
  {
    const c = page({ mintOpts: { units: ['sat'] } });
    await c.W.connect(MINT, { remember: true });
    const app = appOn(c);
    app.goSwap();
    ok(app.state.screen === 'home' && /only bitcoin/.test(app.log.toasts.pop() || ''), 'a mint with one balance has nothing to swap with');
    const d = page();
    await d.W.connect(MINT, { remember: true });
    await fund(d, 500, 'usd');
    const off = appOn(d);
    d.W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });
    d.W.setOffline(true);
    off.goSwap();
    ok(off.state.screen === 'home' && off.log.toasts.pop() === 'Swapping needs the mint.', 'offline: Swapping needs the mint.');
  }

  await part2();

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
})().catch((e) => { console.log('THREW', (e && e.stack) || e); process.exit(1); });

// ---- part 2: the page itself ----------------------------------------------------------------------
async function part2() {
  console.log('\nfoxy two balances: SWAP, drawn by the page\n');
  const { JSDOM, VirtualConsole } = require('jsdom');
  const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
  const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
  const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
  const RENDERER = fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8');
  const unpack = (uuid) => fs.readFileSync(path.join(ROOT, assets.find((a) => a.uuid === uuid).file), 'utf8');
  const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
    const props = JSON.parse(v.replace(/&quot;/g, '"'));
    props.startStatic = { default: true };
    return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
  });
  const html = markup.replace(/<script src="64b433ba-[^"]*"><\/script>/, '').replace(shell.marker, () => open + appSrc + '</script>');
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://foxy.test/index.html', virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.scrollTo = () => {};
  const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
  run('(function(){var n=Number.prototype.toLocaleString;Number.prototype.toLocaleString=function(l,o){return n.call(this,l===undefined?"en-US":l,o);};})();');
  run(unpack('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047'));
  run(unpack('93c76fbd-259d-463c-a60d-5ed97ad7e690'));
  const dc = w.document.querySelector('script[type="text/x-dc"]');
  run('window.__foxyComponentFactory = function (DCLogic, StreamableLogic, React) {\n' + dc.textContent
    + '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};');
  run('(function(){var f=window.__foxyComponentFactory;window.__foxyComponentFactory=function(a,b,R){'
    + 'var C=f(a,b,R);return class extends C{constructor(p){super(p);window.__logic=this;}};};})();');
  run(RENDERER);
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  const A = w.__logic;
  if (!A) { ok(false, 'the app mounts'); return; }
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}
  const toasts = [];
  A.toast = (m) => { toasts.push(String(m)); };
  // the words on the page, one text node after another with a space between
  const text = () => {
    const out = [];
    const walk = w.document.createTreeWalker(w.document.getElementById('dc-root') || w.document.body, 4);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) { const t = n.nodeValue.trim(); if (t) out.push(t); }
    return out.join(' ').replace(/\s+/g, ' ');
  };
  const settle = async () => { for (let i = 0; i < 6; i++) await wait(15); };

  // the stand-in: the swap calls, keeping cents and sats apart
  const st = { usd: 4205, sat: 50000, online: true, runAs: 'done' };
  const asked = [];
  const quote = (from, to, amount) => {
    const q = { id: 'uswap-' + asked.length, mint: 'https://forge.example.com', from, to, total: amount, amount: amount - 2, fee: 2,
      get: from === 'usd' ? Math.floor((amount - 2) / 100 / 81786 * 1e8) : Math.floor((amount - 2) * 81786 / 1e8 * 100),
      rate: { usdPerBtc: 81786, by: 'forge.example.com' }, market: 80000, spread: 0.022, spreadWarn: true,
      expiresAt: Date.now() + 67500, state: 'quoted' };
    return q;
  };
  w.FoxyWallet = {
    connected: true, mintUrl: 'https://forge.example.com', mintHost: () => 'forge.example.com', mints: () => [],
    reason: (e) => String((e && e.message) || e), backedUp: () => true, pinIsSet: () => false, tagsFor: () => ({}), tag() {},
    qr: (x) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(x).slice(0, 24)), classify: () => 'unknown', amountOf: () => null,
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u), unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: st.sat }, { unit: 'usd', amount: st.usd }], balanceAt: () => st.sat,
    agreedRate: () => Promise.resolve(80000), book: () => [], remember() {}, lastToken: () => ({}), clearLastToken() {},
    pendingMelts: () => [], splitPending: () => null, decodeRequest: () => null,
    balanceSats: () => Promise.resolve(st.sat), rate: () => Promise.resolve(80000), transactions: () => Promise.resolve([]), listen: () => () => {},
    privacy: () => ({ tor: st.online ? 'up' : 'connecting', progress: 100, everUp: true, unprotected: false, offline: !st.online,
      network: st.online ? 'wifi' : 'none', orbot: 'none', vpn: false }),
    mintUnits: () => ['sat', 'usd'], twoUnits: () => true,
    walletChoice: () => ({ hold: 'both', recv: '', send: '' }), setWalletChoice() {},
    balanceOf: (u) => (u === 'usd' ? st.usd : st.sat), heldIn: () => 0, recoveringIn: () => 0,
    mintRate: () => ({ usdPerBtc: 81786 }),
    unitSwapsPending: () => (st.runAs === 'pending' && st.ran ? [{ id: 'p', at: 1, from: { unit: 'usd', amount: 1000 }, to: { unit: 'sat', amount: 1220 } }] : []),
    swapQuote(from, to, amount) { asked.push([from, to, amount]); return Promise.resolve(quote(from, to, amount)); },
    swapRun(q, stage) {
      st.ran = true;
      if (st.runAs === 'pending') return Promise.resolve({ id: q.id, state: 'pending', from: { unit: q.from, amount: q.total }, to: { unit: q.to, amount: q.get }, fee: q.fee, rate: q.rate });
      stage('paying'); stage('paid'); stage('claiming'); stage('done');
      if (q.from === 'usd') { st.usd -= q.total; st.sat += q.get; } else { st.sat -= q.total; st.usd += q.get; }
      return Promise.resolve({ id: q.id, state: 'done', from: { unit: q.from, amount: q.total }, to: { unit: q.to, amount: q.get }, fee: q.fee, rate: q.rate });
    },
  };
  A.setState({ walletLive: true, balSats: st.sat, balUsdCents: st.usd, livePrice: 80000, satUsd: 80000 / 1e8, screen: 'home', stack: [] });
  await settle();
  let v = A.renderVals();
  const swapBtn = v.homeButtonsTwo.find((b) => b.label === 'SWAP');
  ok(!!swapBtn && swapBtn.dim === '1', 'home has SWAP, lit');
  swapBtn.tap();
  await settle();
  ok(A.state.screen === 'swap' && /SWAP/.test(text()) && /FROM DOLLARS \$ 42\.05/.test(text()) && /TO BITCOIN ₿ 50,000/.test(text()),
    'the swap screen draws FROM DOLLARS over TO BITCOIN', text().slice(0, 200));
  ok(!!w.document.querySelector('[aria-label="Turn the swap round"]'), 'with the ⇅ on the seam');
  A.renderVals().swapFlipGo();
  await settle();
  ok(/FROM BITCOIN ₿ 50,000/.test(text()), '⇅ turns it round on the page');
  A.renderVals().swapFlipGo();
  A.renderVals().swapNextGo();
  await settle();
  ok(A.state.screen === 'amount' && /How much to swap\?/.test(text()) && /ALL OF IT \(\$ 42\.05\)/.test(text()), 'SET AMOUNT: How much to swap?, ALL OF IT ($ 42.05)');
  v = A.renderVals();
  ok(v.swapVis === 'visible' && v.swapPE === 'auto', 'the ⇅ is on screen: dollars or sats, as a send has it');
  ['1', '0', '0', '0'].forEach((k) => A.press(k));
  await settle();
  ok(/\$ 10\.00/.test(text()) && /≈ ₿ 12,2\d\d/.test(text()), 'typed in dollars, with what it makes in sats under it', text().slice(0, 300));
  A.renderVals().next();
  await settle(); await settle();
  ok(A.state.screen === 'swapConfirm' && JSON.stringify(asked.pop()) === '["usd","sat",1000]', 'NEXT: the confirmation, the rate asked for 1,000 cents');
  const t = text();
  ok(/YOU ARE GETTING \$ 9\.98 in BITCOIN \(₿ 12,2\d\d\) YOU ARE SPENDING \$ 10\.00 in DOLLARS FEE \$ 0\.02 \(₿ \d+\) \S+’S RATE/.test(t),
    'YOU ARE GETTING, YOU ARE SPENDING, FEE, in that order', t.slice(0, 400));
  ok(/FORGE’S RATE ₿ 1 = \$ 81,786 Rate held for 00:5\d Market ₿ 1 = \$ 80,000/.test(t), 'the mint’s RATE, the time it is held for, and the market price far off', t.slice(0, 500));
  ok(!/NETWORK|TOTAL/.test(t), 'no NETWORK row and no TOTAL');
  v = A.renderVals();
  ok(v.cfCtaLabel === 'SWAP' && v.cfCtaBg === '#3AB54A' && v.cfTitleUp === true, 'the green SWAP, the title between the round buttons');
  A.setState({ swapNewRate: true });
  ok(A.renderVals().cfCtaLabel === 'CONFIRM NEW RATE', 'a new rate: CONFIRM NEW RATE');
  A.setState({ swapNewRate: false });
  A._preSettle = null;
  v.cfGo();
  await settle(); await settle();
  ok(A.state.screen === 'swapDone' && /SWAPPED/.test(text()) && /−\$ 10\.00/.test(text()) && /\+₿ 12,2\d\d/.test(text()), 'SWAPPED: −$ 10.00 and +₿', text().slice(0, 300));
  A.renderVals().swapDoneGo();
  await settle();
  ok(A.state.screen === 'home' && A.state.animLane === 'both', 'DISMISS: home, both lanes counting');
  const pills = A.renderVals().homePillRows;
  ok(pills.length === 2 && pills.every((p) => /0 0 0 2\.5px/.test(p.glow)), 'and both pills glow', pills.map((p) => p.glow).join(' | '));
  await wait(1500);
  // offline: dimmed, and says why
  st.online = false;
  A.setState({ routeAt: Date.now() });
  await settle();
  const dim = A.renderVals().homeButtonsTwo.find((b) => b.label === 'SWAP');
  ok(dim.dim === '0.38', 'offline: SWAP is dimmed');
  dim.tap();
  ok(toasts.pop() === 'Swapping needs the mint.', 'and a tap says it needs the mint');
  st.online = true;
  // a swap still going through
  st.runAs = 'pending';
  A.goSwap();
  A.swapToAmount();
  A.setState({ amount: '10.00' });
  A.swapNext(false);
  await settle(); await settle();
  A.swapGo();
  await settle(); await settle();
  const card = [...w.document.body.children].map((el) => el.textContent).join(' ');
  ok(A.state.screen === 'home' && /SWAP STILL GOING THROUGH/.test(card), 'one leg unanswered: the card SWAP STILL GOING THROUGH, over home');
  ok(A.renderVals().deltaText === '$ 10.00 pending with the mint', 'and home’s held pill names it', A.renderVals().deltaText);
  if (A._blockedEl) A._blockedEl.remove();
}
