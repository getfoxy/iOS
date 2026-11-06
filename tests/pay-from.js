'use strict';
/* pay-from.js — PAY FROM: which of this phone's balances a payment is made from.
 *
 *     node tests/pay-from.js
 *
 * The owner, 2026-10-31: with enough at more than one mint, a payment shows the
 * balances that could make it before its confirmation, the cheapest first and
 * chosen, and one at the mint that asked for it as the cheapest. Two at one mint
 * were already asked between (CURRENCY, WALLET); a balance at another mint was
 * never offered at all, and a Lightning invoice the phone's own mint could not
 * cover read NOT ENOUGH with the money for it sitting at another.
 *
 *   1  a Lightning invoice, two mints, one with two balances: every pile that
 *      covers it is a row, each CALCULATING and not choosable until its mint has
 *      answered, then cheapest first and chosen, with the tick on it
 *   2  one that turns out short is greyed NOT ENOUGH, and cannot be chosen
 *   3  one source: no screen, and the confirmation is that mint's; every pile at
 *      this mint: nothing here at all (CURRENCY and WALLET as before)
 *   4  paying from another mint is a visit, home again after it went, and after
 *      it was refused
 *   5  a Cashu request: its own mint first with no fee, another by the crossing
 *      at that crossing's fee; chosen, the crossing runs with no second question
 *   6  a request's NOT ENOUGH judged at the mint it is paid from
 *   7  a payout on chain: every mint's sats, the fee on the next screen, a visit
 *      to the one chosen and home again
 *   8  a tap at another mint: their mint first with no fee, this phone's own by
 *      the crossing asked while they decided; one source, on as before
 *   9  no route: nothing offered that crosses
 *  13  short in the unit asked, with the other at hand at the same mint (2026-11-04): the other balance is a row, "From your
 *      dollars at FORGE, fee about $ 0.02", quoted by the SWAP screen's swap, beside the crossings and cheapest first; chosen,
 *      the swap and the payment go under one PAY; the reverse (a dollar request paid from sats); neither enough; one unit
 *
 * The methods are lifted out of build/foxy-app.js and run against a stand-in
 * wallet, as scan-cross-mint.js does.
 */
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

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
const LIFTED = [
  'pfMint(u) {', 'pfHere() {', 'pfHome() {', 'pfKey(mint, unit) {', 'pfName(mint) {', 'pfLabel(mint, unit) {', 'pfPiles() {',
  'pfFace(have, unit, sats) {', 'pfEntry(src, more) {', 'pfRanked(list) {', 'pfCheapest(list) {', 'pfList() {', 'pfFull(key) {',
  'pfChosen() {', 'pfMany(flow) {', 'pfAway(flow) {', 'pfOpen(flow, list, o) {', 'pfAsk(e, run) {', 'pfIn(run, key, r) {',
  'pfSettled(run) {', 'pfTap(key) {', 'pfNext() {', 'pfBack() {', 'pfClose() {', 'pfCostText(e) {', 'pfRows(LOOK, SHADOW) {',
  'pfFoot() {', 'pfNextOn() {', 'pfTidy() {', 'syncPayFrom() {', 'pfQuoteHere(pr, unit) {', 'pfLnCost(e, q) {', 'pfPre(pr) {',
  'pfSendGo(e, shown) {', 'pfAwayNow() {', 'pfRequote() {', 'payAwaySpec() {', 'cfPayLook(spec, o) {', 'pfReopen() {', 'reqMints(req) {', 'reqCanon(u) {', 'reqPayMint(req) {', 'pfRequest(req) {', 'pfReqSource(req) {',
  'pfReqCrossing(want) {', 'pfTapCross(offer, want, theirs, mine, there) {', 'pfOnchain() {', 'pfOnchainGo(e, shown) {', 'pfOcHome() {',
  'crossComeHome() {', 'startSendNow(to, o) {', 'toConfirm() {', 'requestSpec() {', 'requestHere(req) {', 'requestNeedsRoute(req) {',
  'makeTokenForRequest(go) {', 'ocCancel() {', 'cfRow(label, value, opt) {', 'unitWord(unit) {', 'unitFigure(amount, unit) {',
  'money(sats, fiatCents) {', 'usd(v) {', 'group(n) {', 'sendAsk() {',
  'pfReqOpen(req, list, want, fig) {', 'pfSwapSource(req) {', 'pfSwapRate() {', 'pfSwapQuote(e) {', 'pfSwapCost(e, q) {', 'pfSwapFee(q, from) {',
  'pfSwapText(e, q) {', 'pfReqSwap(req) {', 'pfSwapThenPay(req, src, go) {', 'swapRateOf(r) {',
];
const lifted = new Function('return {' + LIFTED.map(method).join(',\n') + '}')();

const HOME = 'https://forge.example.com';
const AWAY = 'https://mint.minibits.cash/Bitcoin';
const THIRD = 'https://kashu.example.com';
const NAMES = { [HOME]: 'Forge', [AWAY]: 'Minibits', [THIRD]: 'Kashu' };
const INV = 'lnbc20u1pexample';

/* A phone on HOME. `o.piles`: [{ mint, unit, amount }]. `o.quotes[mint|unit]`: what that mint's melt quote answers, a
 * function given resolve for a quote that waits, or an Error. `o.payFails`, `o.offline`, `o.two` (HOME issues both). */
function phone(o) {
  const opts = o || {};
  const log = { connects: [], pays: [], toasts: [], cards: [], moves: [], quotes: [], transfers: [], ocQuotes: 0, sends: 0, crossCards: 0,
    tapThere: 0, tapCross: [], gaveUp: 0, payRequests: [], swapQuotes: [], swapRuns: [], melts: [] };
  const waiting = {};
  const answer = (key, make) => {
    const a = (opts.quotes || {})[key];
    if (a instanceof Error) return Promise.reject(a);
    if (a === 'wait') return new Promise((res, rej) => { waiting[key] = { res: (v) => res(make(v)), rej }; });
    return Promise.resolve(make(a));
  };
  const W = {
    mintUrl: HOME,
    connected: true,
    mintHost: () => W.mintUrl.replace(/^https:\/\//, ''),
    mints: () => [HOME, AWAY, THIRD],
    balances: () => (opts.piles || []).slice(),
    balanceAt: (u) => ((opts.piles || []).filter((p) => p.mint === u && p.unit === 'sat')[0] || { amount: 0 }).amount,
    twoUnits: (m) => (m || W.mintUrl) === HOME && !!opts.two,
    amountOf: (inv) => (/^lnbc20u/.test(String(inv)) ? 2000 : null),
    classify: (t) => (/^lnbc/.test(t) ? 'invoice' : 'lnurl'),
    lookupLnurl: () => Promise.resolve({ pr: INV, addr: 'a@b.c', sats: 2000, at: Date.now() }),
    quoteFee: (pr, x) => { const u = (x && x.unit) || 'sat'; log.quotes.push(HOME + '|' + u); return answer(HOME + '|' + u, (q) => q && Object.assign({ unit: u, bolt11: pr, quote: { quote: 'h-' + u }, w: {} }, q)); },
    payNeed: (amount, reserve, x) => {
      const u = (x && x.unit) || 'sat';
      const have = ((opts.piles || []).filter((p) => p.mint === W.mintUrl && p.unit === u)[0] || { amount: 0 }).amount;
      const need = amount + reserve;
      return { ok: have >= need, need, have, fee: reserve, unit: u, why: have >= need ? '' : 'Not enough here.' };
    },
    quoteFeeAt: (mint, pr, u) => { log.quotes.push(mint + '|' + u); return answer(mint + '|' + u, (q) => {
      const have = ((opts.piles || []).filter((p) => p.mint === mint && p.unit === u)[0] || { amount: 0 }).amount;
      const need = q.amount + q.feeReserve;
      return { mint, unit: u, amount: q.amount, feeReserve: q.feeReserve, need, have, ok: have >= need, why: have >= need ? '' : 'You hold ' + have + ' there.',
        rate: q.rate || null, quote: { unit: u, amount: q.amount, feeReserve: q.feeReserve, quote: { quote: 'x-' + mint }, bolt11: pr, at: Date.now() } };
    }); },
    transferQuote: (from, sats, x) => { log.transfers.push({ from, sats, to: x && x.to, land: !!(x && x.land), landing: x && x.landing });
      const a = (opts.transfers || {})[from];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve({ from, to: x.to, net: sats, feeSats: a == null ? 3 : a }); },
    sendShortfall: (sats, x) => {
      const u = (x && x.unit) || 'sat';
      const have = ((opts.piles || []).filter((p) => p.mint === W.mintUrl && p.unit === u)[0] || { amount: 0 }).amount;
      return { need: sats, fee: 0, have, short: have < sats, why: have < sats ? 'Short here.' : '', unit: u };
    },
    // the SWAP screen's swap at this mint (16b-two-balances.js), at $ 80,000 a bitcoin with 1 % kept by the mint
    mintRate: () => ({ usdPerBtc: 80000, at: Date.now() }),
    swapQuote: (from, to, amount) => {
      log.swapQuotes.push({ from, to, amount });
      const get = from === 'usd' ? Math.floor(amount * 0.99 / 100 / 80000 * 1e8) : Math.floor(amount * 0.99 * 80000 / 1e8 * 100);
      return Promise.resolve({ id: 'q' + log.swapQuotes.length, mint: W.mintUrl, from, to, total: amount, amount, fee: Math.ceil(amount / 100), get,
        rate: { usdPerBtc: 80000 }, state: 'quoted', expiresAt: Date.now() + 60000 });
    },
    swapRun: (q) => {
      log.swapRuns.push(q);
      const pile = (u) => (opts.piles || []).filter((p) => p.mint === W.mintUrl && p.unit === u)[0];
      if (opts.swapFails) return Promise.resolve({ id: q.id, state: 'failed' });
      pile(q.from).amount -= q.total;
      if (pile(q.to)) pile(q.to).amount += q.get; else opts.piles.push({ mint: W.mintUrl, unit: q.to, amount: q.get });
      return Promise.resolve({ id: q.id, state: 'done', from: { unit: q.from, amount: q.total }, to: { unit: q.to, amount: q.get } });
    },
    connect: (u, a, b, x) => { log.connects.push({ u, remember: !(x && x.remember === false) }); W.mintUrl = u; return Promise.resolve(); },
    pay: (to, onStage, x) => { log.pays.push({ at: W.mintUrl, to, unit: x && x.unit, quote: x && x.quote });
      return opts.payFails ? Promise.reject(new Error('no route found')) : Promise.resolve({ hash: 'h1', feeSats: 2, amount: 2000, fee: 2 }); },
    payRequest: (req) => { log.payRequests.push({ at: W.mintUrl, sats: req.sats, unit: req.unit, amount: req.amount,
      held: (opts.piles || []).filter((p) => p.mint === W.mintUrl).map((p) => p.unit + ' ' + p.amount).join(', ') }); return Promise.resolve({ hash: 'h2', confirmed: true }); },
    pendingMelts: () => [],
    tag: () => {},
    tapQuote: (t) => { if (/gaveUp/.test(t)) log.gaveUp++; return Promise.resolve(); },
    reason: (e) => String((e && e.message) || e),
  };
  global.window = { FoxyWallet: W };
  const a = Object.assign({}, lifted, {
    log, W, waiting,
    state: { screen: 'home', stack: [], flow: 'send', unit: 'SATS', amount: '', note: '', wallet: '', recipient: '', recipientKind: '', balSats: 0 },
    MINT_NAMES: {},
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    back() { this.setState((p) => ({ screen: p.stack[p.stack.length - 1] || 'home', stack: p.stack.slice(0, -1) })); },
    go(sc) { this.setState((p) => ({ screen: sc, stack: p.stack.concat([p.screen]) })); },
    toast(t) { log.toasts.push(String(t)); },
    blockedCard(kind, c) { log.cards.push(Object.assign({ kind }, c)); },
    mintNameOf: (u) => NAMES[String(u || '').replace(/\/+$/, '')] || '',
    mintName() { return this.mintNameOf(W.mintUrl); },
    satUsd: () => 0.0008,
    offlineNow: () => !!opts.offline,
    connecting: () => false,
    cardSendNow: () => false,
    fcOutMode: () => false,
    twoUnitsOn: () => W.twoUnits(),
    typedSats: () => 0,
    sendSatsNow: () => 2000,
    sendAmountText: () => '$ 1.60',
    sendToText: () => 'lnbc2…ample',
    refuseSwitchWhileBusy: () => false,
    startSend() { log.sends++; },
    walletNow: () => 'sat',
    refreshBalance() {}, loadHistory() {}, tidyChangeNow() {}, showPayPending() { log.pending = true; }, isBadSignatures: () => false, balNow: () => ({ sats: 0 }),
    heldBlocks: () => '', peerRateRow: () => [], editSendNote() {}, openWalletPick() { this.setState({ payFromReopen: true }); this.go('payFrom'); },
    ocQuote() { log.ocQuotes++; }, onchainAsk() {},
    // the crossing's pieces: what they were asked with, answered at once
    crossMintCard() { log.crossCards++; return Promise.resolve(true); },
    crossMove(plan, theirs, mine, home) { log.moves.push({ net: plan.net, theirs, mine, home }); W.mintUrl = theirs; this._crossCameFrom = home && home !== mine ? home : mine; return Promise.resolve(); },
    crossFailed(e) { log.crossFailed = String(e && e.message); },
    showMelt(t) { log.melts.push(String(t)); }, hideMelt() {}, needScanStage() {}, watchToken() {}, tidyChangeLater() {}, changeComesBack: () => false,
    requestDelivered(req) { this.setState({ reqBusy: false, req: null, sendPhase: 'settled' }); this.crossComeHome(); },
    saidToReceiver: (s) => s,
    tapPayFromThere() { log.tapThere++; },
    tapCrossQuote(offer, want, theirs, mine, from) { log.tapCross.push({ want, theirs, mine, from: from || mine, ready: this._crossReady }); },
  });
  return a;
}
const LOOK = { usd: { sym: '$' }, sat: { sym: '₿' }, grey: { bg: 'grey' } };
const row = (a, mint, unit) => a.pfList().filter((e) => e.key === a.pfKey(mint, unit || 'sat'))[0];
const onInvoice = (a) => a.setState({ screen: 'sendConfirm', stack: ['home'], recipient: INV, recipientKind: 'invoice', amount: '' });

async function run() {
  console.log('1. a Lightning invoice, two mints, one with two balances');
  {
    const a = phone({ two: true, piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: HOME, unit: 'usd', amount: 1000 }, { mint: AWAY, unit: 'sat', amount: 3000 }],
      quotes: { [HOME + '|sat']: 'wait', [HOME + '|usd']: 'wait', [AWAY + '|sat']: 'wait' } });
    onInvoice(a);
    const took = a.syncPayFrom();
    await wait(5);
    ok('PAY FROM is put up over the confirmation', took === true && a.state.screen === 'payFrom' && a.state.stack.slice(-1)[0] === 'sendConfirm', a.state.screen);
    ok('with a row for each pile that covers it: both of this mint’s and the other’s sats', a.pfList().length === 3, JSON.stringify(a.pfList().map((e) => e.key)));
    ok('every mint is asked, this one without moving and the other without a switch',
      a.log.quotes.sort().join() === [AWAY + '|sat', HOME + '|sat', HOME + '|usd'].sort().join() && !a.log.connects.length, JSON.stringify(a.log.quotes));
    ok('the question names the amount', a.state.payFromAsk === 'Pay $ 1.60 from', a.state.payFromAsk);
    const rows0 = a.pfRows(LOOK, 'sh');
    ok('while asked, each says CALCULATING… and none is chosen, NEXT not live',
      rows0.every((r) => r.cost === 'CALCULATING…' && r.cursor === 'default') && !a.pfNextOn(), JSON.stringify(rows0.map((r) => r.cost)));
    a.pfTap(a.pfKey(AWAY, 'sat'));
    ok('a tile still being asked cannot be chosen', a.state.payFromPick !== a.pfKey(AWAY, 'sat') && /Still asking/.test(a.log.toasts.slice(-1)[0] || ''), a.log.toasts.join('|'));
    a.waiting[HOME + '|sat'].res({ amount: 2000, feeReserve: 10 });
    await wait(5);
    ok('the first answer is chosen while the others are out', a.state.payFromPick === a.pfKey(HOME, 'sat'), a.state.payFromPick);
    a.waiting[AWAY + '|sat'].res({ amount: 2000, feeReserve: 2 });
    a.waiting[HOME + '|usd'].res({ amount: 160, feeReserve: 6, rate: { usdPerBtc: 80000 } });
    await wait(5);
    const keys = a.pfList().map((e) => e.key);
    ok('cheapest first: the other mint’s 2 sats, this one’s 10, then 6 cents (75 sats)',
      keys.join() === [AWAY + '|sat', HOME + '|sat', HOME + '|usd'].map((k) => k).join(), JSON.stringify(keys));
    // (the keeper's 1p, 2026-11-06: a tick and the accent's edge on the one chosen, no CHEAPEST, the fee line on each)
    ok('the cheapest is chosen, first, with the tick and the accent’s edge', a.state.payFromPick === a.pfKey(AWAY, 'sat')
      && a.pfRows(LOOK, 'sh')[0].pickOn && /var\(--acc\)/.test(a.pfRows(LOOK, 'sh')[0].edge) && a.pfRows(LOOK, 'sh').filter((r) => r.pickOn).length === 1 && a.pfNextOn());
    ok('each says its fee in its own unit, sats in dollars', a.pfRows(LOOK, 'sh').map((r) => r.cost).join('|') === 'FEE < $ 0.01|FEE $ 0.01|FEE $ 0.06',
      a.pfRows(LOOK, 'sh').map((r) => r.cost).join('|'));
    ok('and still on PAY FROM: two or more can pay', a.state.screen === 'payFrom');
    a.pfNext();
    ok('NEXT: back on the confirmation, paying from the other mint', a.state.screen === 'sendConfirm' && a.state.payMint === AWAY && a.state.payUnit === 'sat' && a.pfAway('send'));
    const spec = a.payAwaySpec();
    const paying = (spec.rows || []).filter((x) => x.label === 'PAYING FROM')[0];
    ok('its confirmation names MINIBITS · BITCOIN, its total, and PAY FROM to change it',
      paying && paying.value === 'MINIBITS · BITCOIN' && spec.cta === 'PAY ' + spec.amount && spec.from && spec.from.word === 'MINIBITS · BITCOIN' && typeof spec.from.go === 'function',
      JSON.stringify({ p: paying && paying.value, cta: spec.cta, f: spec.from }));
    ok('this mint’s own quotes are kept for its confirmation, not the other mint’s', !!a.pfPre(INV).sat && !!a.pfPre(INV).usd);
  }
  console.log('2. one that turns out short after its quote');
  {
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 2001 }, { mint: THIRD, unit: 'sat', amount: 9000 }],
      quotes: { [HOME + '|sat']: { amount: 2000, feeReserve: 10 }, [AWAY + '|sat']: { amount: 2000, feeReserve: 4 }, [THIRD + '|sat']: { amount: 2000, feeReserve: 3 } } });
    onInvoice(a);
    a.syncPayFrom();
    await wait(5);
    const short = row(a, AWAY);
    const r = a.pfRows(LOOK, 'sh').filter((x) => x.key === a.pfKey(AWAY, 'sat'))[0];
    ok('greyed, NOT ENOUGH, last', short.ok === false && r.tagShown && r.tag === 'NOT ENOUGH' && !r.feeShown && !r.pickOn && r.opacity === '.6' && a.pfList().slice(-1)[0].key === short.key,
      JSON.stringify(short));
    a.pfTap(short.key);
    ok('and it cannot be chosen', a.state.payFromPick !== short.key && a.log.toasts.length === 1, a.log.toasts.join('|'));
    ok('the cheapest that covers it is chosen', a.state.payFromPick === a.pfKey(THIRD, 'sat'), a.state.payFromPick);
  }
  console.log('3. one source, and none away');
  {
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 1000 }, { mint: AWAY, unit: 'sat', amount: 3000 }],
      quotes: { [AWAY + '|sat']: 'wait' } });
    onInvoice(a);
    a.syncPayFrom();
    await wait(5);
    ok('only the other mint covers it: no screen, and it pays', a.state.screen === 'sendConfirm' && a.state.payMint === AWAY, a.state.screen + ' ' + a.state.payMint);
    let spec = a.payAwaySpec();
    ok('its confirmation says CHECKING until that mint answers', spec.cta === 'CHECKING…' && spec.ctaBusy && !spec.wallet, spec.cta);
    a.waiting[AWAY + '|sat'].res({ amount: 2000, feeReserve: 2 });
    await wait(5);
    spec = a.payAwaySpec();
    ok('then PAY, with no PAY FROM button where there is no choice', spec.cta === 'PAY ' + spec.amount && !spec.wallet && spec.from && !spec.from.go, spec.cta);
    const b = phone({ two: true, piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: HOME, unit: 'usd', amount: 1000 }, { mint: AWAY, unit: 'sat', amount: 100 }] });
    onInvoice(b);
    ok('every pile that could pay at this mint: nothing asked here, nothing changed', b.syncPayFrom() === false && !b.state.payFromFlow && !b.log.quotes.length);
    const c = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }], quotes: { [HOME + '|sat']: { amount: 2000, feeReserve: 10 }, [AWAY + '|sat']: { amount: 2000, feeReserve: 2000 } } });
    onInvoice(c);
    c.syncPayFrom();
    await wait(5);
    ok('two on their face, one short after its quote: on to the confirmation with the one, nothing to choose',
      c.state.screen === 'sendConfirm' && c.state.payMint === HOME && !c.pfMany('send'), c.state.screen + ' ' + c.state.payMint);
  }
  console.log('4. paying from another mint: a visit, and home whichever way it ends');
  for (const fails of [false, true]) {
    const a = phone({ payFails: fails, piles: [{ mint: HOME, unit: 'sat', amount: 1000 }, { mint: AWAY, unit: 'sat', amount: 3000 }],
      quotes: { [AWAY + '|sat']: { amount: 2000, feeReserve: 2 } } });
    onInvoice(a);
    a.syncPayFrom();
    await wait(5);
    a.setState({ screen: 'sendDone', stack: ['home', 'sendConfirm'], sendPhase: 'in' });
    a.startSendNow(INV);
    await wait(500);
    const visit = a.log.connects[0] || {};
    ok((fails ? 'refused: ' : 'paid: ') + 'the other mint is visited, not remembered', visit.u === AWAY && visit.remember === false, JSON.stringify(a.log.connects));
    ok((fails ? 'refused: ' : 'paid: ') + 'paid there, in sats, with the quote shown and not its wallet',
      a.log.pays.length === 1 && a.log.pays[0].at === AWAY && a.log.pays[0].unit === 'sat' && a.log.pays[0].quote && !a.log.pays[0].quote.w, JSON.stringify(a.log.pays));
    ok((fails ? 'refused: ' : 'paid: ') + 'and home again', a.W.mintUrl === HOME && a.log.connects.slice(-1)[0].u === HOME && !a._crossCameFrom, JSON.stringify(a.log.connects));
    if (fails) ok('refused: the card says so', a.log.cards.length === 1 && a.log.cards[0].kind === 'lnNoRoute', JSON.stringify(a.log.cards.map((x) => x.kind)));
  }
  console.log('5. a Cashu request: its own mint first, another by the crossing');
  {
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }], transfers: { [AWAY]: 3 } });
    const req = { id: 'r1', mints: [HOME], sats: 1000, unit: 'sat', transports: ['nostr'], delivery: { kind: 'nostr', target: 'nprofile1x' } };
    a.setState({ screen: 'reqOffer', stack: ['home'], req: req });
    ok('PAY FROM is put up over the offer', a.pfRequest(req) === true && a.state.screen === 'payFrom' && a.state.stack.slice(-1)[0] === 'reqOffer');
    await wait(5);
    ok('the crossing is quoted from the other mint, to theirs, to land there',
      a.log.transfers.length === 1 && a.log.transfers[0].from === AWAY && a.log.transfers[0].to === HOME && a.log.transfers[0].land, JSON.stringify(a.log.transfers));
    ok('their own mint first, chosen, with no fee', a.pfList()[0].key === a.pfKey(HOME, 'sat') && a.state.payFromPick === a.pfKey(HOME, 'sat')
      && a.pfCostText(a.pfList()[0]) === 'FEE $ 0.00', a.pfCostText(a.pfList()[0]));
    ok('the other at the crossing’s fee', a.pfCostText(row(a, AWAY)) === 'FEE ' + a.money(3).main && row(a, AWAY).cost === 1003, a.pfCostText(row(a, AWAY)));
    a.pfTap(a.pfKey(AWAY, 'sat'));
    a.pfNext();
    ok('chosen: back on the offer, from the other mint', a.state.screen === 'reqOffer' && a.state.payMint === AWAY);
    const spec = a.requestSpec();
    const v = (l) => ((spec.rows || []).filter((x) => x.label === l)[0] || {}).value;
    ok('the offer says PAYING FROM MINIBITS · BITCOIN and the crossing’s FEE', v('PAYING FROM') === 'MINIBITS · BITCOIN' && v('FEE') === a.money(3).main && !/NOT ENOUGH|CLOSE/.test(spec.cta),
      JSON.stringify({ p: v('PAYING FROM'), f: v('FEE'), cta: spec.cta }));
    a.makeTokenForRequest();
    await wait(20);
    ok('PAY: the sats cross from the other mint, with no second confirmation', a.log.moves.length === 1 && a.log.moves[0].mine === AWAY && a.log.moves[0].theirs === HOME
      && a.log.moves[0].home === HOME && a.log.crossCards === 0, JSON.stringify(a.log.moves));
    ok('and the request is paid at their mint, once', a.log.payRequests.length === 1 && a.log.payRequests[0].at === HOME, JSON.stringify(a.log.payRequests));
    const b = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 300 }] });
    ok('one source: no screen', b.pfRequest(Object.assign({}, req)) === false && !b.state.payFromFlow);
    const c = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }] });
    ok('a request in dollars: dollars do not cross, no screen', c.pfRequest(Object.assign({}, req, { unit: 'usd', amount: 500 })) === false);
  }
  console.log('6. a request’s NOT ENOUGH, judged at the mint it is paid from');
  {
    const req = { id: 'r2', mints: [AWAY], sats: 1000, unit: 'sat', transports: ['nostr'], delivery: { kind: 'nostr', target: 'nprofile1x' } };
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 100 }, { mint: AWAY, unit: 'sat', amount: 3000 }] });
    a.setState({ screen: 'reqOffer', stack: ['home'], req: req, balSats: 100 });
    let spec = a.requestSpec();
    ok('enough at their mint and little here: PAY, not CLOSE (it used to judge this mint)', /^PAY /.test(spec.cta) && !spec.warn, spec.cta + ' ' + spec.warn);
    const b = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 100 }, { mint: AWAY, unit: 'sat', amount: 500 }] });
    b.setState({ screen: 'reqOffer', stack: ['home'], req: req, balSats: 100 });
    spec = b.requestSpec();
    ok('too little at both: short, as before', spec.cta === 'CLOSE' && /short by/.test(spec.warn), spec.cta + ' ' + spec.warn);
    const c = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 100 }, { mint: AWAY, unit: 'sat', amount: 500 }] });
    c.setState({ screen: 'reqOffer', stack: ['home'], req: req, balSats: 100, payFromFlow: 'req', payMint: AWAY, payUnit: 'sat', payFromList: [] });
    spec = c.requestSpec();
    ok('the source chosen, short by the time PAY is near: NOT ENOUGH, in its own words', spec.cta === 'NOT ENOUGH' && /at Minibits|at MINIBITS/.test(spec.warn), spec.cta + ' ' + spec.warn);
  }
  console.log('7. a payout on chain');
  {
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }] });
    a.setState({ screen: 'ocConfirm', stack: ['home', 'amount'], ocSats: 2000, ocTo: 'bc1qexample' });
    ok('PAY FROM is put up before the fee is asked', a.pfOnchain() === true && a.state.screen === 'payFrom' && a.log.ocQuotes === 0);
    ok('every mint’s sats, this one first and chosen, each with its fee on the next screen',
      a.pfList()[0].key === a.pfKey(HOME, 'sat') && a.state.payFromPick === a.pfKey(HOME, 'sat') && a.pfList().every((e) => e.ok === true && a.pfCostText(e) === 'FEE ON THE NEXT SCREEN'),
      JSON.stringify(a.pfList().map((e) => a.pfCostText(e))));
    a.pfTap(a.pfKey(AWAY, 'sat'));
    a.pfNext();
    await wait(5);
    ok('the other mint chosen: a visit there, then its fee asked', a.log.connects[0] && a.log.connects[0].u === AWAY && a.log.connects[0].remember === false && a.log.ocQuotes === 1
      && a.state.screen === 'ocConfirm', JSON.stringify(a.log.connects));
    a.ocCancel();
    await wait(5);
    ok('CANCEL: home again', a.W.mintUrl === HOME && a.log.connects.slice(-1)[0].u === HOME && !a._ocVisit, JSON.stringify(a.log.connects));
    const b = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 100 }] });
    b.setState({ screen: 'ocConfirm', stack: ['home'], ocSats: 2000, ocTo: 'bc1qexample' });
    ok('only this mint covers it: nothing asked, the fee asked here as before', b.pfOnchain() === false && b.state.screen === 'ocConfirm');
  }
  console.log('8. a tap at another mint');
  {
    const THEIRS = AWAY;
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: THEIRS, unit: 'sat', amount: 1500 }] });
    const plan = { net: 1000, feeSats: 4, to: THEIRS, from: HOME };
    a._crossReady = { sats: 1000, to: THEIRS, from: HOME, plan: Promise.resolve(plan) };
    a.setState({ screen: 'home', stack: [] });
    const offer = { mints: [THEIRS], req: 'creqA' };
    ok('PAY FROM where the tap is decided', a.pfTapCross(offer, 1000, THEIRS, HOME, 1500) === true && a.state.screen === 'payFrom');
    await wait(5);
    ok('the crossing asked while they decided is reused, not asked again', a.log.transfers.length === 0, JSON.stringify(a.log.transfers));
    // (paid there on a visit, their mint's fee for its pieces is told only there: not said to be nothing)
    ok('their mint first, chosen, its fee not known yet; this phone’s own at the crossing’s fee',
      a.pfList()[0].key === a.pfKey(THEIRS, 'sat') && a.state.payFromPick === a.pfKey(THEIRS, 'sat') && a.pfCostText(a.pfList()[0]) === 'FEE NOT KNOWN YET'
      && a.pfCostText(row(a, HOME)) === 'FEE ' + a.money(4).main && row(a, HOME).cost === 1004, a.pfList().map((e) => a.pfCostText(e)).join('|'));
    a.pfNext();
    ok('their mint chosen: paid from what is there, as before', a.log.tapThere === 1 && !a.log.tapCross.length && a.state.screen === 'home');
    const b = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: THEIRS, unit: 'sat', amount: 1500 }, { mint: THIRD, unit: 'sat', amount: 4000 }],
      transfers: { [THIRD]: 2, [HOME]: 9 } });
    b.pfTapCross(offer, 1000, THEIRS, HOME, 1500);
    await wait(5);
    b.pfTap(b.pfKey(THIRD, 'sat'));
    b.pfNext();
    const x = b.log.tapCross[0] || {};
    ok('another mint chosen: the crossing from it, its plan handed on, home still this phone’s',
      x.from === THIRD && x.mine === HOME && x.ready && x.ready.from === THIRD, JSON.stringify(x));
    const c = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: THEIRS, unit: 'sat', amount: 200 }] });
    ok('one source: on exactly as before', c.pfTapCross(offer, 1000, THEIRS, HOME, 200) === false && !c.state.payFromFlow);
    const d = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: THEIRS, unit: 'sat', amount: 1500 }] });
    d.pfTapCross(offer, 1000, THEIRS, HOME, 1500);
    d.pfBack();
    ok('backing out tells the other phone, and goes home', d.log.gaveUp === 1 && d.state.screen === 'home');
  }
  console.log('9. no route');
  {
    const a = phone({ offline: true, piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }] });
    onInvoice(a);
    ok('a Lightning payment: nothing asked', a.syncPayFrom() === false && !a.log.quotes.length);
    ok('a request: only its own mint, no screen', a.pfRequest({ mints: [HOME], sats: 1000, unit: 'sat' }) === false);
    ok('a tap: nothing crosses', a.pfTapCross({ mints: [AWAY] }, 1000, AWAY, HOME, 3000) === false);
  }
  console.log('11. a test mint is never a source, and the chosen tile is the orange one');
  {
    const TEST = 'https://testnut.cashu.space';
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }, { mint: TEST, unit: 'sat', amount: 9000 }],
      quotes: { [HOME + '|sat']: { amount: 2000, feeReserve: 10 }, [AWAY + '|sat']: { amount: 2000, feeReserve: 2 } } });
    onInvoice(a);
    a.syncPayFrom();
    await wait(5);
    ok('testnut is not among the balances offered', a.pfList().length === 2 && !a.pfList().some((e) => /testnut/.test(e.mint)), JSON.stringify(a.pfList().map((e) => e.key)));
    const rows = a.pfRows(LOOK, 'sh');
    const picked = rows.filter((r) => r.key === a.state.payFromPick)[0];
    ok('the chosen tile on the accent’s wash, every other on the surface', picked && picked.pickOn && picked.bg === 'rgba(var(--acc-rgb),.1)' && rows.filter((r) => r.key !== picked.key).every((r) => r.bg === 'var(--surface)' && !r.pickOn),
      JSON.stringify(rows.map((r) => [r.key, r.bg])));
    ok('each keeps its own sign', rows.every((r) => r.sym === '₿'));
  }
  console.log('12. a request’s crossing asks nothing twice (2026-11-01)');
  {
    const req = { id: 'r9', mints: [THIRD], sats: 1000, unit: 'sat', transports: ['nostr'], delivery: { kind: 'nostr', target: 'nprofile1x' } };
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }, { mint: THIRD, unit: 'sat', amount: 2000 }] });
    a.setState({ screen: 'reqOffer', stack: ['home'], req: req, balSats: 5000 });
    a.pfRequest(req);
    await wait(5);
    const t = a.log.transfers;
    ok('every source is quoted with one landing for the run, so the request’s mint makes one invoice',
      t.length === 2 && !!t[0].landing && t[0].landing === t[1].landing && t.every((x) => x.to === THIRD && x.land), JSON.stringify(t.map((x) => x.from)));
    ok('one fee quote per source for the payment: each source is asked once', t.filter((x) => x.from === HOME).length === 1 && t.filter((x) => x.from === AWAY).length === 1);
    const b = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }, { mint: THIRD, unit: 'sat', amount: 2000 }] });
    b.setState({ screen: 'reqOffer', stack: ['home'], req: req, balSats: 5000 });
    b.pfRequest(req);
    await wait(5);
    ok('another run has a landing of its own', !!b.log.transfers[0].landing && b.log.transfers[0].landing !== t[0].landing);
    // the crossing PAY FROM chose melts the plan's own quote and warms the far mint (26d-tap.js `crossMove`)
    const runs = [];
    const W = {
      mintUrl: HOME,
      transactions: () => Promise.resolve([]),
      connect: (u) => { W.mintUrl = u; return Promise.resolve(); },
      moveRun: (plan, st, x) => { runs.push(x || null); W.mintUrl = plan.to; return Promise.resolve({ sats: plan.moving }); },
    };
    global.window = { FoxyWallet: W };
    const m = Object.assign(new Function('return {' + method('crossMove(plan, theirs, mine, home) {') + '}')(), {
      hushMove() {}, showMelt() {}, hideMelt() {}, refreshBalance() {}, mintNameOf: () => 'Kashu', hushSweepEntries: () => Promise.resolve(),
    });
    await m.crossMove({ net: 1000, moving: 1000, to: THIRD, from: AWAY }, THIRD, AWAY, HOME);
    ok('the crossing pays with the quote the plan holds and warms the far mint while the melt runs',
      runs.length === 1 && runs[0] && runs[0].visit === true && runs[0].quoted === true && runs[0].warm === true, JSON.stringify(runs));
  }
  console.log('13. short in the unit asked, with the other balance at the same mint (2026-11-04)');
  {
    const t = (good, name, detail) => ok(name, good, detail);
    // the log's case: a request for sats at Forge, 3,190 sats there and $ 89.16 in dollars
    const piles = () => [{ mint: HOME, unit: 'sat', amount: 3190 }, { mint: HOME, unit: 'usd', amount: 8916 }];
    const req = { id: 'r13', mints: [HOME], sats: 5000, unit: 'sat', transports: ['nostr'], delivery: { kind: 'nostr', target: 'nprofile1x' } };
    const a = phone({ two: true, piles: piles() });
    a.setState({ screen: 'reqOffer', stack: ['home'], req: req, wallet: 'sat', balSats: 3190 });
    t(a.pfRequest(req) === true, 'PAY FROM is opened, where it used to be NOT ENOUGH with $ 89.16 beside it');
    await wait(5);
    const q0 = a.log.swapQuotes[0] || {};
    t(a.log.swapQuotes.length === 1 && q0.from === 'usd' && q0.to === 'sat' && q0.amount === 151,
      'the swap is quoted as the SWAP screen quotes one: dollars into sats at this mint, sized for the 1,810 missing and a little over', JSON.stringify(a.log.swapQuotes));
    const e = row(a, HOME, 'usd');
    t(!!e && e.swap === true && e.ok === true && a.pfCostText(e) === 'FEE $ 0.02' && a.pfSwapText(e, a.pfFull(e.key)) === 'From your dollars at FORGE, fee about $ 0.02',
      'its tile: "FEE $ 0.02", the swap’s cost as SWAP counts it ("From your dollars at FORGE, fee about $ 0.02")', e && a.pfCostText(e));
    t(a.state.screen === 'reqOffer' && a.state.payMint === HOME && a.state.payUnit === 'usd',
      'the one balance that can pay is chosen with nothing asked, and the offer is back', a.state.screen + ' ' + a.state.payUnit);
    const spec = a.requestSpec();
    const v = (l) => ((spec.rows || []).filter((x) => x.label === l)[0] || {}).value;
    t(v('PAYING FROM') === 'FORGE · DOLLARS' && v('SWAP') === 'From your dollars at FORGE, fee about $ 0.02' && /^PAY /.test(spec.cta) && !spec.warn,
      'the offer: PAYING FROM FORGE · DOLLARS, the swap’s row, and PAY, not NOT ENOUGH', JSON.stringify({ p: v('PAYING FROM'), s: v('SWAP'), cta: spec.cta, warn: spec.warn }));
    a.makeTokenForRequest();
    await wait(20);
    const paid = a.log.payRequests[0] || {};
    t(a.log.swapRuns.length === 1 && a.log.swapRuns[0] === a.pfFull(e.key) && a.log.melts.some((t) => /Swapping dollars into bitcoin/.test(t)),
      'PAY: the quote shown is the swap run, under the swapping overlay', JSON.stringify(a.log.melts));
    t(a.log.payRequests.length === 1 && paid.at === HOME && paid.sats === 5000 && /sat 5058/.test(paid.held),
      'and the request is paid at Forge from the sats the swap brought, once, with no second scan or confirmation', JSON.stringify(a.log.payRequests));
    t(a.log.toasts.length === 0 && a.log.cards.length === 0 && a.log.swapQuotes.length === 1, 'nothing else asked or said', JSON.stringify(a.log.toasts));

    // the same, beside a crossing from another mint: cheapest first
    const b = phone({ two: true, piles: piles().concat([{ mint: AWAY, unit: 'sat', amount: 9000 }]), transfers: { [AWAY]: 3 } });
    b.setState({ screen: 'reqOffer', stack: ['home'], req: req, wallet: 'sat' });
    b.pfRequest(req);
    await wait(5);
    t(b.state.screen === 'payFrom' && b.pfList().map((x) => x.key).join() === [AWAY + '|sat', HOME + '|usd'].join(),
      'beside another mint’s sats by the crossing (3 sats), the swap (2 cents, 25 sats) is second', JSON.stringify(b.pfList().map((x) => x.key + ' ' + x.rank)));
    b.pfTap(b.pfKey(HOME, 'usd'));
    b.pfNext();
    t(b.state.screen === 'reqOffer' && b.state.payUnit === 'usd' && b.pfReqCrossing(HOME) === null, 'and chosen, it is a swap and no crossing');

    // the reverse: a request for dollars, short in dollars, with sats enough
    const ureq = { id: 'r14', mints: [HOME], amount: 500, unit: 'usd', transports: ['nostr'], delivery: { kind: 'nostr', target: 'nprofile1x' } };
    const c = phone({ two: true, piles: [{ mint: HOME, unit: 'sat', amount: 50000 }, { mint: HOME, unit: 'usd', amount: 100 }] });
    c.setState({ screen: 'reqOffer', stack: ['home'], req: ureq, wallet: 'usd' });
    t(c.pfRequest(ureq) === true, 'a request in dollars short in dollars: PAY FROM, from the sats');
    await wait(5);
    const ce = row(c, HOME, 'sat');
    t(c.log.swapQuotes.length === 1 && c.log.swapQuotes[0].from === 'sat' && ce && c.pfCostText(ce) === 'FEE ' + c.money(52).main
      && c.pfSwapText(ce, c.pfFull(ce.key)) === 'From your sats at FORGE, fee about ₿ 52',
      'its tile: the swap’s 52 sats as FEE, in dollars ("From your sats at FORGE, fee about ₿ 52")', ce && c.pfCostText(ce));
    const cs = c.requestSpec();
    const cv = (l) => ((cs.rows || []).filter((x) => x.label === l)[0] || {}).value;
    t(cv('PAYING FROM') === 'FORGE · BITCOIN' && /From your sats/.test(cv('SWAP')) && !cv('FROM') && /^PAY /.test(cs.cta),
      'its offer says PAYING FROM FORGE · BITCOIN and the swap, and PAY', JSON.stringify({ p: cv('PAYING FROM'), cta: cs.cta }));
    c.makeTokenForRequest();
    await wait(20);
    t(c.log.swapRuns.length === 1 && c.log.swapRuns[0].to === 'usd' && c.log.payRequests.length === 1 && c.log.payRequests[0].unit === 'usd' && /usd 505/.test(c.log.payRequests[0].held),
      'PAY: sats into dollars, then the dollars paid', JSON.stringify(c.log.payRequests));

    // neither enough: as today
    const d = phone({ two: true, piles: [{ mint: HOME, unit: 'sat', amount: 3190 }, { mint: HOME, unit: 'usd', amount: 50 }] });
    d.setState({ screen: 'reqOffer', stack: ['home'], req: req, wallet: 'sat', balSats: 3190 });
    t(d.pfRequest(req) === false && !d.log.swapQuotes.length, 'neither balance enough: no PAY FROM and no swap asked');
    const ds = d.requestSpec();
    t(/NOT ENOUGH|CLOSE/.test(ds.cta) && !((ds.rows || []).some((x) => x.label === 'SWAP')), 'and the offer is short, as it always was', ds.cta);

    // a mint with one unit: no such row
    const f = phone({ two: false, piles: [{ mint: HOME, unit: 'sat', amount: 3190 }, { mint: HOME, unit: 'usd', amount: 8916 }] });
    f.setState({ screen: 'reqOffer', stack: ['home'], req: req, wallet: 'sat', balSats: 3190 });
    t(f.pfRequest(req) === false && !f.log.swapQuotes.length, 'a mint that issues one unit: no swap row');

    // a swap the mint did not make: said, nothing paid, the offer stays
    const g = phone({ two: true, swapFails: true, piles: piles() });
    g.setState({ screen: 'reqOffer', stack: ['home'], req: req, wallet: 'sat' });
    g.pfRequest(req);
    await wait(5);
    g.makeTokenForRequest();
    await wait(20);
    t(!g.log.payRequests.length && /did not make the swap/.test(g.log.toasts.join('|')) && g.state.screen === 'reqOffer' && !g.state.reqSwapping,
      'a swap the mint did not make: said, nothing paid, and the offer still up', g.log.toasts.join('|'));

    // and the quote does not cover the gap (the dollars would be spent and the sats still short): NOT ENOUGH, not offered
    const h = phone({ two: true, piles: [{ mint: HOME, unit: 'sat', amount: 3190 }, { mint: HOME, unit: 'usd', amount: 140 }] });
    h.setState({ screen: 'reqOffer', stack: ['home'], req: req, wallet: 'sat', balSats: 3190 });
    h.pfRequest(req);
    await wait(5);
    t(row(h, HOME, 'usd').ok === false && row(h, HOME, 'usd').tag === 'NOT ENOUGH' && h.state.screen === 'reqOffer' && !h.state.payMint,
      'enough on its face and not with the swap’s fee: NOT ENOUGH, and the offer as it was', JSON.stringify(row(h, HOME, 'usd')));
  }
  console.log('10. the choice is let go when the flow ends');
  {
    const a = phone({ piles: [{ mint: HOME, unit: 'sat', amount: 5000 }, { mint: AWAY, unit: 'sat', amount: 3000 }],
      quotes: { [HOME + '|sat']: { amount: 2000, feeReserve: 10 }, [AWAY + '|sat']: { amount: 2000, feeReserve: 2 } } });
    onInvoice(a);
    a.syncPayFrom();
    await wait(5);
    a.pfNext();
    a.setState({ screen: 'home', stack: [] });
    a.pfTidy();
    ok('home: nothing of it is left', !a.state.payFromFlow && !a.state.payMint && !a.state.payFromList && !a._pf && !a._pfFor);
  }
}

run().then(() => {
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
