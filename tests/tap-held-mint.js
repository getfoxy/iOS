'use strict';
/* tap-held-mint.js — a tap pays by ecash from any balance this phone holds at a mint the request names.
 *
 *     node tests/tap-held-mint.js
 *
 * The keeper, 2026-11-07: "just paid from minibits to minibits, was there a fee, why? should not have been". The payer
 * was on Forge (tens of thousands of sats there, and dollars) and held a few thousand sats at Minibits; the receiver, at Minibits, offered a
 * Minibits request and an invoice. The payer's log said "paying by lightning", PAY FROM asked three melt quotes (Forge
 * sat, Forge usd, Minibits sat), the Minibits balance was chosen, and it paid the invoice by a melt at Minibits, with a
 * fee, rather than answering the Minibits request with ecash. `sameMint` read only the mint the phone is on.
 *
 *   1  the payer's log, replayed: the Minibits balance is offered first, chosen, at no fee and with no melt quote asked
 *      of it; NEXT pays the request in ecash on a visit to Minibits (no melt, no Lightning) and the phone comes home to
 *      Forge; the books add up (what left is the amount, nothing more)
 *   2  the same tap with Forge chosen instead: their invoice, by Lightning, with Forge's fee, as before
 *   3  too little at Minibits: their invoice by Lightning, as before, and no ecash source offered
 *   4  nothing else that could pay the invoice: the request's own confirmation at once, paid from Minibits, fee 0
 *   5  a request in dollars, with dollars held at its mint and no invoice: paid there, in dollars, on a visit
 *   6  two mints named: the one holding more chosen; the mint the phone is on preferred where it holds enough
 *   7  a payer with no route: unchanged (no visit, no ecash at another mint)
 *   8  the visit never chooses the mint: every connect to Minibits is `remember: false`, the gate's record untouched
 *   9  a till's two requests: the one in a currency held at its mint is the one paid
 *  10  a mint that charges for its pieces: the tile does not say no fee
 *  11  the wallet's `piecesFreeAt` and `pieceFeePpkAt`, from the keysets on file
 *  12  a free mint before a larger balance at one that charges; a charging mint covers only with its fee and a margin
 *  13  an ecash source kept for one offer is let go by the next
 *  14  a scan naming a charging mint first and a free one after: PAY FROM ticks the free one, and PAY spends it
 *
 * The app's methods are lifted out of build/foxy-app.js and run against a stand-in wallet, as pay-from.js does.
 */
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(process.env.FOXY_APP || path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

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
  'pfSettled(run) {', 'pfTap(key) {', 'pfNext() {', 'pfCostText(e) {', 'pfTidy() {', 'syncPayFrom() {', 'pfQuoteHere(pr, unit) {',
  'pfLnCost(e, q) {', 'pfSendGo(e, shown) {', 'pfFreeThere(mint, unit) {', 'pfHeldHave(th) {', 'pfRequest(req) {', 'pfReqSource(req) {',
  'pfReqCrossing(want) {', 'pfReqOpen(req, list, want, fig) {', 'pfSwapSource(req) {', 'pfReqSwap(req) {',
  'reqMints(req) {', 'reqCanon(u) {', 'reqPayMint(req) {', 'reqHeldAt(req, amount) {', 'reqHeldMargin(m, need, unit) {', 'requestHere(req) {', 'requestNeedsRoute(req) {',
  'openRequest(text, opts) {', 'tellPayerShort(req) {', 'shortForReceiver() {', 'makeTokenForRequest(go) {', 'crossComeHome() {',
  'requestSpec() {', 'cfPayLook(spec, o) {', 'cfRow(label, value, opt) {', 'unitWord(unit) {', 'unitFigure(amount, unit) {',
  'money(sats, fiatCents) {', 'usd(v) {', 'group(n) {', 'sendAsk() {',
  'tapPayOffer(offer, sats) {', 'tapPayHeld(offer, at, inv, sats) {', 'tapLnSources(inv, at, unit) {', 'tapHeldGo(held) {',
  'tapOfferOf(text) {', 'tapPickOfTwo(main, other, inv) {', 'tapUnitRule(read) {',
];
// a method the app lacks is left out, and the checks that need it fail (FOXY_APP=<an older build> runs them against it)
const missing = LIFTED.filter((sig) => app.indexOf('\n  ' + sig) < 0);
const lifted = new Function('return {' + LIFTED.filter((sig) => missing.indexOf(sig) < 0).map(method).join(',\n') + '}')();
if (missing.length) console.log('(not in this build: ' + missing.join(' ') + ')');

const FORGE = 'https://forge.flashapp.me';
const MINIBITS = 'https://mint.minibits.cash/Bitcoin';
const KASHU = 'https://kashu.me';
const FEES = 'https://mint.macadamia.cash';
const NAMES = { [FORGE]: 'Forge', [MINIBITS]: 'Minibits', [KASHU]: 'Kashu', [FEES]: 'Macadamia' };
const INV = 'lnbc20u1pexampleinvoice';
// the requests a stand-in decodes, by their text
const REQS = {
  creqMini: { id: 'r1', mints: [MINIBITS], sats: 2000, unit: 'sat', transports: [] },
  creqUsd: { id: 'r2', mints: [MINIBITS], sats: null, amount: 500, unit: 'usd', transports: [] },
  creqTwo: { id: 'r3', mints: [MINIBITS, KASHU], sats: 2000, unit: 'sat', transports: [] },
  creqThree: { id: 'r4', mints: [MINIBITS, KASHU, FORGE], sats: 2000, unit: 'sat', transports: [] },
  creqFees: { id: 'r5', mints: [FEES], sats: 2000, unit: 'sat', transports: [] },
  creqMixed: { id: 'r8', mints: [FEES, MINIBITS], sats: 2000, unit: 'sat', transports: [] },
  creqScan: { id: 'r9', mints: [FEES, MINIBITS], sats: 2000, unit: 'sat', transports: ['nostr'], delivery: { kind: 'nostr', target: 'nprofile1x' } },
  creqTillUsd: { id: 'r6', mints: [MINIBITS], sats: null, amount: 160, unit: 'usd', transports: [] },
  creqTillSat: { id: 'r7', mints: [MINIBITS], sats: 2000, unit: 'sat', transports: [] },
};

/* A phone on FORGE. `o.piles`: [{ mint, unit, amount }]; `o.two`: FORGE issues dollars; `o.offline`; `o.free`: mints whose
 * keysets on file name no fee (MINIBITS and KASHU by default). */
function phone(o) {
  const opts = o || {};
  const log = { connects: [], pays: [], quotes: [], transfers: [], payRequests: [], toasts: [], cards: [], accepted: [], told: [], stuck: 0, wrong: 0 };
  const chosen = [FORGE];
  const free = opts.free || [MINIBITS, KASHU];
  const pile = (m, u) => (opts.piles || []).filter((p) => p.mint === m && p.unit === u)[0];
  const W = {
    mintUrl: FORGE,
    mintHost: () => W.mintUrl.replace(/^https:\/\//, ''),
    canonicalMint: (u) => String(u || '').trim().replace(/\/+$/, ''),
    mints: () => [FORGE, MINIBITS, KASHU, FEES],
    mintChosen: (u) => chosen.indexOf(u) >= 0,
    chosenNow: () => chosen.slice(),
    balances: () => (opts.piles || []).filter((p) => p.amount > 0).slice(),
    balanceAt: (u) => (pile(u, 'sat') || { amount: 0 }).amount,
    balanceOf: (unit, m) => (pile(m || W.mintUrl, unit) || { amount: 0 }).amount,
    twoUnits: (m) => ((m || W.mintUrl) === FORGE ? !!opts.two : !!pile(m, 'usd')),
    piecesFreeAt: (m) => free.indexOf(m) >= 0,
    // what a keyset there charges a piece, in parts per thousand, where `o.ppk` names it; else not on file
    pieceFeePpkAt: (m) => ((opts.ppk && opts.ppk[m] != null) ? opts.ppk[m] : (free.indexOf(m) >= 0 ? 0 : null)),
    amountOf: (inv) => (/^lnbc20u/.test(String(inv)) ? 2000 : null),
    classify: (t) => (/^lnbc/.test(t) ? 'invoice' : 'other'),
    decodeRequest: (t) => (REQS[t] ? JSON.parse(JSON.stringify(REQS[t])) : null),
    asksInDollars: () => false,
    unclaimedSats: () => 0,
    quoteFee: (pr, x) => { const u = (x && x.unit) || 'sat'; log.quotes.push(W.mintUrl + '|' + u);
      return Promise.resolve({ unit: u, amount: 2000, feeReserve: u === 'usd' ? 3 : 4, bolt11: pr, quote: { quote: 'h-' + u } }); },
    payNeed: (amount, reserve, x) => {
      const u = (x && x.unit) || 'sat';
      const have = (pile(W.mintUrl, u) || { amount: 0 }).amount;
      return { ok: have >= amount + reserve, need: amount + reserve, have, fee: reserve, unit: u, why: '' };
    },
    quoteFeeAt: (mint, pr, u) => { log.quotes.push(mint + '|' + u);
      const have = (pile(mint, u) || { amount: 0 }).amount;
      return Promise.resolve({ mint, unit: u, amount: 2000, feeReserve: 6, need: 2006, have, ok: have >= 2006, why: '',
        quote: { unit: u, amount: 2000, feeReserve: 6, quote: { quote: 'x-' + mint }, bolt11: pr } }); },
    transferQuote: (from, sats, x) => { log.transfers.push({ from, to: x && x.to }); return Promise.resolve({ from, to: x.to, net: sats, feeSats: 3 }); },
    sendShortfall: (n, x) => {
      const u = (x && x.unit) || 'sat';
      const have = (pile(W.mintUrl, u) || { amount: 0 }).amount;
      return { need: n, fee: 0, have, short: have < n, why: have < n ? 'Short here.' : '', unit: u };
    },
    connect: (u, a, b, x) => { log.connects.push({ u, remember: !(x && x.remember === false) }); if (!(x && x.remember === false) && chosen.indexOf(u) < 0) chosen.push(u); W.mintUrl = u; return Promise.resolve(); },
    pay: (to) => { log.pays.push({ at: W.mintUrl, to }); return Promise.resolve({ hash: 'h1', fee: 4 }); },
    // the request paid in ecash: what leaves is the amount, from the pile at the mint the phone is on, nothing more
    payRequest: (req) => {
      const u = req.unit === 'usd' ? 'usd' : 'sat';
      const n = u === 'usd' ? req.amount : req.sats;
      const p = pile(W.mintUrl, u);
      log.payRequests.push({ at: W.mintUrl, unit: u, amount: n });
      if (!p || p.amount < n) return Promise.reject(new Error('not enough ecash'));
      p.amount -= n;
      return Promise.resolve({ hash: 'h2', confirmed: true });
    },
    tag: () => {},
    tapQuote: (t) => { log.told.push(JSON.parse(t)); return Promise.resolve(); },
    reason: (e) => String((e && e.message) || e),
  };
  global.window = { FoxyWallet: W };
  const a = Object.assign({}, lifted, {
    log, W,
    state: { screen: 'home', stack: [], flow: 'send', unit: 'SATS', amount: '', note: '', wallet: '', recipient: '', recipientKind: '', balSats: 0, tapCode: '4242' },
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
    twoUnitsOn: () => W.twoUnits(),
    unitBalance: (u) => W.balanceOf(u),
    walletChoiceNow: () => ({ hold: '' }),
    typedSats: () => 0, sendAmountText: () => '$ 1.60', sendSatsNow: () => 2000,
    refuseSwitchWhileBusy: () => false,
    unitLabel: (u) => String(u).toUpperCase(),
    refreshBalance() {}, loadHistory() {}, heldBlocks: () => '', peerRateRow: () => [], editSendNote() {},
    showMelt() {}, hideMelt() {}, needScanStage() {}, watchToken() {}, tidyChangeLater() {}, changeComesBack: () => false,
    crossMintCard() { return Promise.resolve(true); },
    crossFailed(e) { log.crossFailed = String(e && e.message); },
    requestDelivered() { this.setState({ reqBusy: false, req: null, sendPhase: 'settled' }); this.crossComeHome(); },
    saidToReceiver: (s) => s,
    // their invoice, by Lightning: the send confirmation (12-receive.js), whose PAY FROM is `syncPayFrom`
    acceptTarget(t) { log.accepted.push(t); this.setState({ screen: 'sendConfirm', stack: ['home'], recipient: t, recipientKind: 'invoice' }); return true; },
    tapUnitHeld: () => false,
    stuckAtMint: () => null,
    tapStuckAtMint() { log.stuck++; },
    tapWrongMint() { log.wrong++; },
    tapCrossMint() { log.crossMint = (log.crossMint || 0) + 1; },
    tapAwaitInvoice() { log.awaited = (log.awaited || 0) + 1; },
  });
  return a;
}
const offerOf = (req, more) => Object.assign({ req: req, inv: '', read: JSON.parse(JSON.stringify(REQS[req])), mints: REQS[req].mints.slice(),
  sameMint: REQS[req].mints.indexOf(FORGE) >= 0, theirRoute: true, asks: false }, more || {});
const row = (a, mint, unit) => a.pfList().filter((e) => e.key === a.pfKey(mint, unit || 'sat'))[0];
const sum = (a) => (a.W.balances() || []).filter((p) => p.unit === 'sat').reduce((n, p) => n + p.amount, 0);
const stackVal = (spec, l) => ((spec.stack || []).filter((x) => x.label === l)[0] || {}).value;

async function section(f) {
  try { await f(); } catch (e) { ok('the section ran', false, e.message); }
}

async function run() {
  console.log('1. the payer’s log, replayed: Forge current, forge sat / forge usd / minibits sat, a Minibits request and invoice');
  await section(async () => {
    const a = phone({ two: true, piles: [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: FORGE, unit: 'usd', amount: 4000 },
      { mint: MINIBITS, unit: 'sat', amount: 5000 }] });
    const before = sum(a);
    a.tapPayOffer(offerOf('creqMini', { inv: INV }));
    ok('the decision is not "paying by lightning": PAY FROM is asked with the ecash in it', a.syncPayFrom() === true && a.state.screen === 'payFrom');
    await wait(5);
    const first = a.pfList()[0];
    ok('Minibits is offered first and chosen, at no fee', first && first.key === a.pfKey(MINIBITS, 'sat') && first.ecash
      && a.state.payFromPick === first.key && a.pfCostText(first) === 'FEE ' + a.money(0).main, JSON.stringify(first && [first.key, a.pfCostText(first)]));
    ok('no melt quote is asked of the Minibits balance; Forge’s two are', a.log.quotes.indexOf(MINIBITS + '|sat') < 0
      && a.log.quotes.indexOf(FORGE + '|sat') >= 0 && a.log.quotes.indexOf(FORGE + '|usd') >= 0, JSON.stringify(a.log.quotes));
    ok('Forge keeps its melt quote’s fee', a.pfCostText(row(a, FORGE)) === 'FEE ' + a.money(4).main, a.pfCostText(row(a, FORGE)));
    a.pfNext();
    ok('NEXT: the request’s own confirmation, paid from Minibits', a.state.screen === 'reqOffer' && a.state.req && a.state.req.viaTap
      && a.state.payMint === MINIBITS && a.state.payFromFlow === 'req', JSON.stringify([a.state.screen, a.state.payMint]));
    const spec = a.requestSpec();
    ok('it says PAYING FROM MINIBITS · BITCOIN and FEE ₿0, and PAY', stackVal(spec, 'FEE') === a.money(0).main && spec.from.word === 'MINIBITS · BITCOIN'
      && /^PAY /.test(spec.cta), JSON.stringify({ f: stackVal(spec, 'FEE'), w: spec.from.word, cta: spec.cta }));
    a.makeTokenForRequest();
    await wait(20);
    ok('PAY: ecash to the request at Minibits, once, and no Lightning', a.log.payRequests.length === 1 && a.log.payRequests[0].at === MINIBITS
      && !a.log.pays.length, JSON.stringify(a.log.payRequests));
    ok('a visit to Minibits, then home to Forge', a.log.connects[0] && a.log.connects[0].u === MINIBITS && a.log.connects[0].remember === false
      && a.W.mintUrl === FORGE && !a._crossCameFrom, JSON.stringify(a.log.connects));
    ok('the books add up: 2,000 left, and nothing more', before - sum(a) === 2000, String(before - sum(a)));
    ok('the gate’s record is untouched by the visit', a.W.chosenNow().indexOf(MINIBITS) < 0, JSON.stringify(a.W.chosenNow()));
  });
  console.log('2. the same tap, Forge chosen: their invoice by Lightning, with its fee');
  await section(async () => {
    const a = phone({ two: true, piles: [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: FORGE, unit: 'usd', amount: 4000 },
      { mint: MINIBITS, unit: 'sat', amount: 5000 }] });
    a.tapPayOffer(offerOf('creqMini', { inv: INV }));
    a.syncPayFrom();
    await wait(5);
    a.pfTap(a.pfKey(FORGE, 'sat'));
    a.pfNext();
    ok('back on the invoice’s confirmation, from Forge, its fee kept', a.state.screen === 'sendConfirm' && a.state.payMint === FORGE
      && row(a, FORGE).fee === 4 && !a.state.req, JSON.stringify([a.state.screen, a.state.payMint]));
  });
  console.log('3. too little at Minibits: their invoice, as before');
  await section(async () => {
    const a = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: MINIBITS, unit: 'sat', amount: 500 }] });
    a.tapPayOffer(offerOf('creqMini', { inv: INV }));
    ok('their invoice is taken, with no ecash source kept for it', a.log.accepted[0] === INV && !a._tapHeld && a.state.screen === 'sendConfirm');
    a.syncPayFrom();
    ok('and PAY FROM, where it asks, has no ecash tile', !a.pfList().some((e) => e.ecash), JSON.stringify(a.pfList().map((e) => e.key)));
  });
  console.log('4. nothing else could pay their invoice: the request at once, from Minibits');
  await section(async () => {
    const a = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 300 }, { mint: MINIBITS, unit: 'sat', amount: 5000 }] });
    a.tapPayOffer(offerOf('creqMini', { inv: INV }));
    ok('no invoice taken, no PAY FROM, the request’s confirmation paid at Minibits', !a.log.accepted.length && a.state.screen === 'reqOffer'
      && a.state.payMint === MINIBITS, JSON.stringify([a.state.screen, a.log.accepted]));
    const spec = a.requestSpec();
    ok('FEE ₿0 there', stackVal(spec, 'FEE') === a.money(0).main && /^PAY /.test(spec.cta), JSON.stringify([stackVal(spec, 'FEE'), spec.cta]));
    a.makeTokenForRequest();
    await wait(20);
    ok('paid at Minibits in ecash, home again', a.log.payRequests.length === 1 && a.log.payRequests[0].at === MINIBITS && a.W.mintUrl === FORGE && !a.log.pays.length);
  });
  console.log('5. a request in dollars, dollars held at its mint, no invoice');
  await section(async () => {
    const a = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 5000 }, { mint: MINIBITS, unit: 'usd', amount: 900 }] });
    const o = a.tapOfferOf(JSON.stringify({ v: 2, req: 'creqUsd', up: true }));
    ok('the offer is not refused as "dollars at a mint you do not use"', o && !o.notSats && o.req === 'creqUsd', JSON.stringify(o && o.notSats));
    a.tapPayOffer(o);
    ok('the request’s confirmation, paid from Minibits in dollars', a.state.screen === 'reqOffer' && a.state.payMint === MINIBITS && a.state.payUnit === 'usd',
      JSON.stringify([a.state.screen, a.state.payMint, a.state.payUnit, a.log.toasts]));
    a.makeTokenForRequest();
    await wait(20);
    ok('paid there in dollars, on a visit, and home', a.log.payRequests.length === 1 && a.log.payRequests[0].at === MINIBITS && a.log.payRequests[0].unit === 'usd'
      && a.log.connects[0].remember === false && a.W.mintUrl === FORGE, JSON.stringify(a.log.payRequests));
    ok('the dollars held there fell by the 500 cents asked, no more', a.W.balanceOf('usd', MINIBITS) === 400);
  });
  console.log('6. two mints named: the larger balance; the phone’s own mint first where it holds enough');
  await section(async () => {
    const a = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 100 }, { mint: MINIBITS, unit: 'sat', amount: 3000 }, { mint: KASHU, unit: 'sat', amount: 6000 }] });
    a.tapPayOffer(offerOf('creqTwo'));
    ok('Kashu, holding more, is paid from', a.state.screen === 'reqOffer' && a.state.payMint === KASHU, String(a.state.payMint));
    const b = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 2500 }, { mint: MINIBITS, unit: 'sat', amount: 3000 }, { mint: KASHU, unit: 'sat', amount: 6000 }] });
    ok('the phone’s own mint, named and holding enough, is the one chosen', b.reqHeldAt(REQS.creqThree) === FORGE);
    let opened = null;
    b.openRequest = (t, x) => { opened = x; };
    b.tapPayOffer(offerOf('creqThree'));
    ok('and it is paid as the same-mint tap it always was', opened && opened.viaTap && !opened.payAt, JSON.stringify(opened));
    const c = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 1000 }, { mint: MINIBITS, unit: 'sat', amount: 3000 }] });
    ok('the phone’s own mint named but short: the other named mint that holds enough', c.reqHeldAt(Object.assign({}, REQS.creqMini, { mints: [FORGE, MINIBITS] })) === MINIBITS);
  });
  console.log('7. a payer with no route: unchanged');
  await section(async () => {
    const a = phone({ offline: true, piles: [{ mint: FORGE, unit: 'sat', amount: 5000 }, { mint: MINIBITS, unit: 'sat', amount: 5000 }] });
    a.tapPayOffer(offerOf('creqMini', { inv: INV }));
    ok('no visit, no ecash at another mint, nothing taken from Minibits', !a.log.connects.length && a.state.screen !== 'reqOffer' && !a.log.payRequests.length
      && a.log.wrong === 1, JSON.stringify([a.state.screen, a.log.wrong]));
  });
  console.log('8. the mint gate: every connect to the named mint is a visit');
  await section(async () => {
    const a = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 300 }, { mint: MINIBITS, unit: 'sat', amount: 5000 }] });
    a.tapPayOffer(offerOf('creqMini', { inv: INV }));
    a.makeTokenForRequest();
    await wait(20);
    ok('Minibits connected with remember: false only, and not chosen after', a.log.connects.filter((c) => c.u === MINIBITS).every((c) => c.remember === false)
      && a.W.chosenNow().join() === FORGE, JSON.stringify([a.log.connects, a.W.chosenNow()]));
  });
  console.log('9. a till’s two requests: the currency held at its mint is the one paid');
  await section(async () => {
    const a = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 300 }, { mint: MINIBITS, unit: 'usd', amount: 900 }] });
    ok('dollars held at Minibits: the dollar request, though the main is in sats', a.tapPickOfTwo('creqTillSat', 'creqTillUsd', INV) === 'creqTillUsd');
    const b = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 300 }, { mint: MINIBITS, unit: 'sat', amount: 9000 }] });
    ok('sats held at Minibits: the sat request, though the main is in dollars', b.tapPickOfTwo('creqTillUsd', 'creqTillSat', INV) === 'creqTillSat');
  });
  console.log('10. a mint that charges for its pieces: not said to be free');
  await section(async () => {
    const a = phone({ free: [], piles: [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: FEES, unit: 'sat', amount: 5000 }] });
    a.tapPayOffer(offerOf('creqFees', { inv: INV }));
    a.syncPayFrom();
    await wait(5);
    const first = a.pfList()[0];
    ok('its ecash still first, its fee told only there', first && first.ecash && a.pfCostText(first) === 'FEE NOT KNOWN YET', first && a.pfCostText(first));
  });
  console.log('12. a free mint before a larger balance at a mint that charges; a charging mint covers only with its fee');
  await section(async () => {
    const piles = () => [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: MINIBITS, unit: 'sat', amount: 3000 }, { mint: FEES, unit: 'sat', amount: 9000 }];
    const a = phone({ ppk: { [FEES]: 1000 }, piles: piles() });
    ok('the free mint is chosen over the larger balance at the one that charges', a.reqHeldAt(REQS.creqMixed) === MINIBITS, a.reqHeldAt(REQS.creqMixed));
    ok('and a scan of the same request is paid there too', a.reqPayMint(REQS.creqMixed) === MINIBITS, a.reqPayMint(REQS.creqMixed));
    a.tapPayOffer(offerOf('creqMixed', { inv: INV }));
    a.syncPayFrom();
    await wait(5);
    const first = a.pfList()[0];
    ok('a tap: the free mint’s ecash first and chosen, at no fee', first && first.ecash && first.mint === MINIBITS && a.pfCostText(first) === 'FEE ' + a.money(0).main,
      JSON.stringify(a.pfList().map((e) => [e.mint, e.ecash ? 'ecash' : 'ln', a.pfCostText(e)])));
    const at = (n) => phone({ ppk: { [FEES]: 1000 }, piles: [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: FEES, unit: 'sat', amount: n }] });
    ok('at a mint that charges, exactly the amount held does not cover it', at(2000).reqHeldAt(REQS.creqFees) === '');
    ok('nor a few sats over it', at(2010).reqHeldAt(REQS.creqFees) === '');
    ok('the amount and the fee with a margin does', at(2100).reqHeldAt(REQS.creqFees) === FEES);
    // 2,000 makes 6 pieces: twice 10 at 1 sat a piece is 20 over
    ok('exactly the amount and its margin covers it; a sat less does not', at(2020).reqHeldAt(REQS.creqFees) === FEES && at(2019).reqHeldAt(REQS.creqFees) === '');
    const b = at(2010);
    b.tapPayOffer(offerOf('creqFees', { inv: INV }));
    ok('held a little over there: their invoice, with no ecash tile kept for it', b.log.accepted[0] === INV && !b._tapHeld);
    const c = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: MINIBITS, unit: 'sat', amount: 2000 }] });
    ok('a free mint covers on its face: exactly the amount', c.reqHeldAt(REQS.creqMini) === MINIBITS);
  });
  console.log('14. a scan naming a mint that charges first and a free one after: PAY FROM ticks the free one, and it pays');
  await section(async () => {
    const a = phone({ ppk: { [FEES]: 1000 }, piles: [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: FEES, unit: 'sat', amount: 9000 },
      { mint: MINIBITS, unit: 'sat', amount: 3000 }] });
    a.openRequest('creqScan');
    await wait(10);
    ok('PAY FROM is shown', a.state.screen === 'payFrom' && a.state.payFromFlow === 'req', a.state.screen);
    const first = a.pfList()[0];
    ok('the free mint first and ticked, at no fee; the one that charges after it', first && first.mint === MINIBITS && a.state.payFromPick === first.key
      && a.pfCostText(first) === 'FEE ' + a.money(0).main, JSON.stringify(a.pfList().map((e) => [e.mint, e.rank, a.pfCostText(e)])));
    a.pfNext();
    ok('NEXT: the offer, paid at the free mint, as `reqPayMint` says', a.state.screen === 'reqOffer' && a.state.payMint === MINIBITS
      && a.reqPayMint(a.state.req) === MINIBITS, JSON.stringify([a.state.screen, a.state.payMint]));
    a.makeTokenForRequest();
    await wait(20);
    ok('PAY: 2,000 from the free mint, nothing from the one that charges, and home', a.log.payRequests.length === 1 && a.log.payRequests[0].at === MINIBITS
      && a.W.balanceAt(FEES) === 9000 && a.W.balanceAt(MINIBITS) === 1000 && a.W.mintUrl === FORGE, JSON.stringify(a.log.payRequests));
  });
  console.log('13. a kept ecash source is let go by the next offer');
  await section(async () => {
    const a = phone({ piles: [{ mint: FORGE, unit: 'sat', amount: 60000 }, { mint: MINIBITS, unit: 'sat', amount: 5000 }] });
    a.tapPayOffer(offerOf('creqMini', { inv: INV }));
    ok('kept for its PAY FROM', !!a._tapHeld);
    a.setState({ screen: 'home', stack: [] });
    a.tapPayOffer(offerOf('creqThree'));
    ok('a later offer on another path clears it', !a._tapHeld);
  });
  console.log('11. the wallet: a mint free of fees for its pieces, read from its keysets on file');
  await section(async () => {
    const src = fs.readFileSync(process.env.FOXY_WALLET || path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
    const at = src.indexOf('\n    piecesFreeAt: function (url, unit) {');
    if (at < 0) throw new Error('piecesFreeAt is not in the wallet');
    let i = src.indexOf('{', at), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
    const body = src.slice(src.indexOf('function', at), i + 1);
    const cache = {
      [MINIBITS]: { info: {}, keys: { keysets: [{ id: '00a', unit: 'sat', active: true, input_fee_ppk: 0 }, { id: '00b', unit: 'usd', active: true }] } },
      [FEES]: { info: {}, keys: { keysets: [{ id: '00c', unit: 'sat', active: false, input_fee_ppk: 0 }, { id: '00d', unit: 'sat', active: true, input_fee_ppk: 100 }] } },
    };
    const free = new Function('unitOf', 'canonicalMint', 'mintCacheFor', 'return ' + body)(
      (u) => String(u || 'sat').toLowerCase(), (u) => String(u || '').replace(/\/+$/, ''), (u) => cache[u] || null);
    ok('a mint whose keysets name no fee: free, in sats and in dollars', free(MINIBITS + '/') === true && free(MINIBITS, 'usd') === true);
    ok('a mint with one keyset that charges: not free', free(FEES) === false);
    ok('nothing on file, or no keyset of that unit: not known', free(KASHU) === null && free(FEES, 'usd') === null);
    const at2 = src.indexOf('\n    pieceFeePpkAt: function (url, unit) {');
    if (at2 < 0) throw new Error('pieceFeePpkAt is not in the wallet');
    let j = src.indexOf('{', at2), d2 = 0;
    for (; j < src.length; j++) { if (src[j] === '{') d2++; else if (src[j] === '}') { d2--; if (d2 === 0) break; } }
    const ppk = new Function('unitOf', 'canonicalMint', 'mintCacheFor', 'return ' + src.slice(src.indexOf('function', at2), j + 1))(
      (u) => String(u || 'sat').toLowerCase(), (u) => String(u || '').replace(/\/+$/, ''), (u) => cache[u] || null);
    ok('the dearest keyset’s fee per piece: 100 at the charging mint, 0 at the free one, none not on file',
      ppk(FEES) === 100 && ppk(MINIBITS) === 0 && ppk(KASHU) === null, JSON.stringify([ppk(FEES), ppk(MINIBITS), ppk(KASHU)]));
  });
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
