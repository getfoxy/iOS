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
 *      answered, then cheapest first and chosen, with CHEAPEST on it
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
  'pfSendGo(e, shown) {', 'pfAwayNow() {', 'pfRequote() {', 'payAwaySpec() {', 'pfRequest(req) {', 'pfReqSource(req) {',
  'pfReqCrossing(want) {', 'pfTapCross(offer, want, theirs, mine, there) {', 'pfOnchain() {', 'pfOnchainGo(e, shown) {', 'pfOcHome() {',
  'crossComeHome() {', 'startSendNow(to, o) {', 'toConfirm() {', 'requestSpec() {', 'requestHere(req) {', 'requestNeedsRoute(req) {',
  'makeTokenForRequest(go) {', 'ocCancel() {', 'cfRow(label, value, opt) {', 'unitWord(unit) {', 'unitFigure(amount, unit) {',
  'money(sats, fiatCents) {', 'usd(v) {', 'group(n) {', 'sendAsk() {',
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
    tapThere: 0, tapCross: [], gaveUp: 0, payRequests: [] };
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
    transferQuote: (from, sats, x) => { log.transfers.push({ from, sats, to: x && x.to, land: !!(x && x.land) });
      const a = (opts.transfers || {})[from];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve({ from, to: x.to, net: sats, feeSats: a == null ? 3 : a }); },
    sendShortfall: (sats) => { const have = W.balanceAt(W.mintUrl); return { need: sats, fee: 0, have, short: have < sats, why: have < sats ? 'Short here.' : '' }; },
    connect: (u, a, b, x) => { log.connects.push({ u, remember: !(x && x.remember === false) }); W.mintUrl = u; return Promise.resolve(); },
    pay: (to, onStage, x) => { log.pays.push({ at: W.mintUrl, to, unit: x && x.unit, quote: x && x.quote });
      return opts.payFails ? Promise.reject(new Error('no route found')) : Promise.resolve({ hash: 'h1', feeSats: 2, amount: 2000, fee: 2 }); },
    payRequest: (req) => { log.payRequests.push({ at: W.mintUrl, sats: req.sats }); return Promise.resolve({ hash: 'h2', confirmed: true }); },
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
    showMelt() {}, hideMelt() {}, needScanStage() {}, watchToken() {}, tidyChangeLater() {}, changeComesBack: () => false,
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
    ok('the cheapest is chosen and ringed, with CHEAPEST on it', a.state.payFromPick === a.pfKey(AWAY, 'sat')
      && a.pfRows(LOOK, 'sh')[0].bestShown && /solid/.test(a.pfRows(LOOK, 'sh')[0].outline) && a.pfNextOn());
    ok('each says what it costs in its own unit', a.pfRows(LOOK, 'sh').map((r) => r.cost).join('|') === 'Costs ₿ 2,002|Costs ₿ 2,010|Costs $ 1.66',
      a.pfRows(LOOK, 'sh').map((r) => r.cost).join('|'));
    ok('and still on PAY FROM: two or more can pay', a.state.screen === 'payFrom');
    a.pfNext();
    ok('NEXT: back on the confirmation, paying from the other mint', a.state.screen === 'sendConfirm' && a.state.payMint === AWAY && a.state.payUnit === 'sat' && a.pfAway('send'));
    const spec = a.payAwaySpec();
    const paying = (spec.rows || []).filter((x) => x.label === 'PAYING FROM')[0];
    ok('its confirmation names MINIBITS · BITCOIN, its total, and PAY FROM to change it',
      paying && paying.value === 'MINIBITS · BITCOIN' && spec.cta === 'PAY' && spec.wallet && spec.wallet.label === 'PAY FROM', JSON.stringify({ p: paying && paying.value, cta: spec.cta, w: spec.wallet }));
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
    ok('greyed, NOT ENOUGH, last', short.ok === false && r.tagShown && r.tag === 'NOT ENOUGH' && r.bg === 'grey' && a.pfList().slice(-1)[0].key === short.key,
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
    ok('then PAY, with no PAY FROM button where there is no choice', spec.cta === 'PAY' && !spec.wallet, spec.cta);
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
      && a.pfCostText(a.pfList()[0]) === 'Costs ₿ 1,000 · no fee', a.pfCostText(a.pfList()[0]));
    ok('the other at the amount and the crossing’s fee', a.pfCostText(row(a, AWAY)) === 'Costs ₿ 1,003', a.pfCostText(row(a, AWAY)));
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
      a.pfList()[0].key === a.pfKey(HOME, 'sat') && a.state.payFromPick === a.pfKey(HOME, 'sat') && a.pfList().every((e) => e.ok === true && a.pfCostText(e) === 'Fee on the next screen'),
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
    ok('their mint first, chosen, with no fee; this phone’s own at the crossing’s fee',
      a.pfList()[0].key === a.pfKey(THEIRS, 'sat') && a.state.payFromPick === a.pfKey(THEIRS, 'sat') && a.pfCostText(a.pfList()[0]) === 'Costs ₿ 1,000 · no fee'
      && a.pfCostText(row(a, HOME)) === 'Costs ₿ 1,004', a.pfList().map((e) => a.pfCostText(e)).join('|'));
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
    ok('the chosen tile wears the orange look, every other grey', picked && picked.bg !== 'grey' && rows.filter((r) => r.key !== picked.key).every((r) => r.bg === 'grey'),
      JSON.stringify(rows.map((r) => [r.key, r.bg])));
    ok('each keeps its own sign', rows.every((r) => r.sym === '₿'));
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
