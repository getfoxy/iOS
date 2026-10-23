'use strict';
/* sats-for-dollars-tap.js — a wallet that holds dollars, paid in sats by tap, the whole way through.
 *
 *     node tests/sats-for-dollars-tap.js
 *
 * A receiver who chose to hold dollars asks in dollar ecash. A payer holding only sats could pay that
 * only by paying the dollar invoice from bitcoin, which needs both phones online. Now the receiver says
 * on its offer that it takes sats for the dollars (`sats4usd`), and with one phone offline the payer
 * offers sats at its own price (M10), the receiver agrees to that price (M11, a request in sats), the
 * payer pays it, and the receiver swaps the sats into dollars at the mint as soon as it is online.
 *
 *   1. the receiver offline and holding dollars, the payer online with sats only: the offer says so; the
 *      price is offered and agreed; the payment is locked to the receiver and kept, owed a swap, its row
 *      saying what was asked at whose price; back online, the claim lands and the swap runs once;
 *   2. the payer offline with sats, the receiver online and holding dollars: paid plain, swapped in, and
 *      swapped into dollars at once;
 *   3. both offline: refused with the both-offline words, no price sent, nothing moved;
 *   4. a receiver holding both, with a dollar request: no `sats4usd`, and the refusals of today;
 *   5. an older receiver that does not say it: the refusals of today;
 *   6. both online: their dollar invoice paid from bitcoin, as before, and no price talked over;
 *   7. the checks: a quote for another request or amount is refused by the receiver; an answer in dollars,
 *      or at another mint, is refused by the payer;
 *   8. a payer short of the sats with the fee: refused before any price is sent;
 *   9. when the swap runs: not while put away, and not under money moving, but once that is over;
 *  10. the app's half on a stand-in wallet: each outcome's words, once each; the card on home and no
 *      move; two payments one after the other; nothing under a tap, a confirmation, SET AMOUNT for a
 *      payment or put-away, and then once; a new price asked for before the swap;
 *  11. the places in the build that start it;
 *  12. PAYMENT RECEIVED heads with the dollars asked only for a payment to be swapped into them.
 *
 * Two pages of the real wallet (loadReal) share one fake mint with a usd keyset and P2PK, and one link
 * that carries what the radio carries (as tests/usd-tap.js has it). The app's own methods for the tap's
 * decisions, the price talk, the screens' words and `convertOnReturn` are lifted out of
 * build/foxy-app.js and run on each page, with a stand-in for the rest of the app. Every case ends with
 * each page's books closing in both units (harness `books`, judged again on exit) and the history card's
 * two audits off by 0. */
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, books, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const WORDS_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
// the fake mint's own rate for its usd keyset: both phones' prices sit beside it, so a swap is not refused as far off
const PRICE = 76900;
const HOUR = 3600 * 1000;

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 8000);
  while (Date.now() < end) { if (fn()) return true; await wait(5); }
  return !!fn();
};
const read = (c, key, dflt) => { try { const v = JSON.parse(c.storage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; } };
const rows = (c) => read(c, 'foxy.cashu.log', []);
const recs = (c) => read(c, 'foxy.cashu.convert', []);
const recOf = (c, id) => recs(c).find((r) => r.id === id) || null;
const rowOf = (c, id) => rows(c).find((r) => r.hash === 'req-' + id) || {};
const swapRows = (c) => rows(c).filter((r) => r.swap);
const canon = (u) => String(u || '').replace(/\/+$/, '');

// ---- the app's methods, as the build has them -------------------------------------------------
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const at = appSrc.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = appSrc.indexOf('{', at + sig.length - 1), depth = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appSrc.slice(at + 3, i + 1);
}
const lift = (W, sigs) => new Function('window', 'PRICE_STANDS_MS', 'CONFIRM_SCREENS', 'return {' + sigs.map(method).join(',\n') + '}')(
  { FoxyWallet: W }, 3 * 60 * 1000, ['depConfirm', 'sendConfirm', 'reqOffer', 'trConfirm', 'ocConfirm', 'priceConfirm', 'crossConfirm']);
const COMMON = ['agoWords(ms) {', 'priceAgeWords(ms) {', 'cfRow(label, value, opt) {', 'group(n) {', 'usd(v) {',
  'unitFigure(amount, unit) {', 'moneyIn(n, unit) {', 'shortForReceiver() {', 'walletChoiceNow() {'];

/* The history card's audits (16-history-lists.js), as tests/usd-tap.js lifts them. */
const auditMethods = new Function('return {' + ['histAudit() {', 'histAuditUsd() {', 'txTotalOut(t) {', 'arrivingBucket(unit) {',
  'arrivingNow() {', 'heldPill() {'].map(method).join(',') + '}')();
async function appAudit(c) {
  const W = c.W;
  const items = rows(c).filter((t) => !t.mint || canon(t.mint) === MINT).map((t) => ({
    dir: t.dir, sats: t.sats, fee: t.feeSats, hash: t.hash, unit: t.unit, amount: t.amount, feeAmount: t.feeAmount,
    grossSats: t.grossSats, changeSats: t.changeSats, changeState: t.changeState, changeAmount: t.changeAmount,
    pending: !t.settled, failed: t.state === 'failed', atRisk: !!t.trusted && !t.settled && t.state !== 'failed',
  }));
  const a = Object.assign({
    state: { balSats: await W.balanceSats(), balUsdCents: W.balanceOf('usd'), history: [{ items }], historyComplete: true, fresh: false },
    twoUnitsOn: () => true, stageMoney: (n) => '₿ ' + n, unitFigure: (n, u) => (u === 'usd' ? '$ ' + (n / 100).toFixed(2) : '₿ ' + n),
    recoveringSats: () => Math.round(Number(W.recoveringSats()) || 0), topUpFeeSats: () => Math.round(Number(W.topUpFeeSats()) || 0),
  }, auditMethods);
  const had = global.window;
  global.window = { FoxyWallet: W };
  const quiet = console.log;
  console.log = () => {};
  try { return { sat: a.histAudit(), usd: a.histAuditUsd() }; }
  finally { console.log = quiet; global.window = had; }
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
async function booksShut(t, name) {
  for (const [who, c] of [['receiver', t.rx], ['payer', t.payer]]) {
    const move = booksMove(c, c.from);
    const audit = await appAudit(c);
    ok(Object.values(move).every((n) => n === 0) && audit.sat.off === 0 && audit.usd.off === 0,
      name + ': the ' + who + '’s books close in both units, and both audits are off by 0',
      JSON.stringify({ move, sat: audit.sat.off, usd: audit.usd.off }));
  }
}

// ---- two pages, one mint, one link (tests/usd-tap.js) -----------------------------------------
function link() {
  const L = { up: true, log: [], payer: null, receiver: null };
  return L;
}
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  let mint = opts.mint || null;
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    bridge: (w, m) => {
      const L = ctx.link;
      switch (m.action) {
        case 'mintRequest':
          if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
          return reply(w, m.id, mint.handle(m));
        case 'inboxAnswer':
          ctx.answers.push({ answer: m.answer, status: [200, 409, 422].indexOf(Number(m.status)) >= 0 ? Number(m.status) : 422,
                             text: String(m.text || '') });
          return reply(w, m.id, 'ok');
        case 'tapChangeDue': case 'tapAsking': case 'tapChangeKept':
          return reply(w, m.id, 'ok');
        case 'tapQuote':
          ctx.quotes.push(String(m.body || ''));
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M10');
          setTimeout(() => L.receiver.W._tapQuote(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapTerms':
          ctx.terms.push(String(m.body || ''));
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M11');
          setTimeout(() => L.payer.W._tapTerms(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapChange':
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          setTimeout(() => L.payer.W._tapChange(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapSend': {
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M5');
          const began = L.receiver.answers.length;
          setTimeout(() => L.receiver.W._requestPaid(String(m.body || ''), 'wire', 'tap'), 0);
          const gaveUp = Date.now() + 30000;
          const poll = setInterval(() => {
            const said = L.receiver.answers;
            if (said.length <= began && Date.now() > gaveUp) { clearInterval(poll); reply(w, m.id, null, 'That phone is no longer connected.'); return; }
            if (said.length <= began) return;
            clearInterval(poll);
            const last = said[said.length - 1];
            L.log.push('M6 ' + last.status);
            reply(w, m.id, JSON.stringify(last.status === 200 ? { v: 2, ok: true, code: 200 }
              : { v: 2, ok: false, code: last.status, why: String(last.text || '').slice(0, 160) }));
          }, 1);
          return null;
        }
        default: {
          const got = phone.answer(w, m);
          if (!got) return reply(w, m.id, null, 'not in this test');
          return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
        }
      }
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, { units: ['sat', 'usd'], p2pk: true });
    },
  });
  ctx.deaf = false;
  ctx.answers = [];
  ctx.quotes = [];
  ctx.terms = [];
  ctx.mint = mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._askWaitMs = 4000;
  ctx.W._swapPollMs = 5;
  ctx.W._swapClaimWaitMs = 200;
  return ctx;
}
const goOffline = (c) => {
  c.deaf = true;
  c.W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });
  c.W.setOffline(true);
};
const goOnline = (c) => {
  c.deaf = false;
  c.W.setOffline(false);
  c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
};
async function connected(o) {
  const c = page(o);
  await c.W.connect(MINT, null, null, { remember: true });
  return c;
}
async function fund(c, amount, unit) {
  const inv = await c.W.invoice(amount, '', { unit: unit || 'sat' });
  return c.W.claim(inv.hash);
}

/* The receiver's app: the offer it puts on the air (`syncTap`), the price talk (`tapPriceOffered`, the
 * PRICE screen and its answer), and the swap into dollars (`convertOnReturn`). */
function rxApp(c, o) {
  const opts = o || {};
  const W = c.W;
  const a = Object.assign(lift(W, COMMON.concat(['tapPriceOffered(text) {', 'priceTermsCard(q) {', 'priceAnswer(yes) {', 'priceSpec() {',
    'convertOnReturn(due) {', 'convertWaiting() {', 'convertLater() {', 'swapPendingCard(r, o) {', 'moneyBusy() {'])), {
    CONVERT_WAITS: 6,
    state: { screen: 'home', stack: [], tapArmed: false }, cards: [], toasts: [], made: [], settled: [], events: [],
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    blockedCard(kind, cc) { this.cards.push(Object.assign({ kind }, cc)); },
    toast(t) { this.toasts.push(t); },
    tapTalking(on) { this._tapTalking = !!on; }, waitingForPayer() {}, hideStage() {},
    offlineNow: () => !!c.deaf, twoUnitsOn: () => true,
    refreshBalance() {}, loadHistory() {}, settleAnimate(l) { this.settled.push(l); },
    // the sats request the price talk agrees to, as the receive screen makes it (12-receive.js)
    railRequestReady(n) { const t = W.paymentRequest(n, { unit: 'sat', purpose: 'receive' }); this.made.push(t); return Promise.resolve(t); },
  }, opts.extra || {});
  W.onTapQuote((text) => a.tapPriceOffered(text));
  W.onConvertDue(() => a.convertOnReturn(true));
  W.onRequestPaid((ev) => {
    a.events.push(ev);
    // the conversation is over, as `requestPaidHere` ends it
    if (ev.stage === 'paid' || ev.stage === 'failed') a._tapTalking = false;
  });
  return a;
}
/* The offer that receiver puts on the air for `text`, by the app's own `syncTap`. */
function offerOf(c, a, text, o) {
  const opts = o || {};
  const said = [];
  const W = Object.assign(Object.create(c.W), {
    tapReceive: (x) => { said.push(x); return Promise.resolve(''); }, tapReceiveStop: () => Promise.resolve(''), tapPayStop: () => Promise.resolve(''),
    classify: (t) => (/^ln/.test(String(t)) ? 'invoice' : 'text'),
  });
  const quietly = (x) => new Proxy(x, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && k[0] !== '_' ? () => '' : undefined)) });
  const s = quietly(Object.assign(lift(W, ['syncTap() {']), {
    state: { screen: 'confirm', flow: 'receive', tapArmed: true, tapShownCode: '', tapRecvStage: '' },
    setState() {}, tapOffering: () => ({ inv: opts.inv || '', req: text, waiting: false }),
    offlineNow: () => !!c.deaf, changeStillDue: () => false, priceAgo: () => '',
    walletNow: () => 'usd', twoUnitsOn: () => true, walletChoiceNow: () => a.walletChoiceNow(),
    _tapOffer: null, _tapTalking: false,
  }));
  s.syncTap();
  return said.length ? said[said.length - 1] : '';
}
/* The payer's app: what it reads off the offer and decides (`tapOfferOf`, `tapPayOffer`, `tapUnitHeld`,
 * `tapSatsForDollars`), and its half of the price talk (`tapQuoteTheirDollars`). Where it would open
 * the confirmation, the request is kept; SEND on it is `payRequest`, as `makeTokenForRequest` calls it. */
function payerApp(c) {
  const W = c.W;
  const a = Object.assign(lift(W, COMMON.concat(['tapOfferOf(text) {', 'tapUnitRule(read) {', 'tapPayOffer(offer, sats) {',
    'tapUnitHeld(offer, sats) {', 'tapSatsForDollars(offer) {', 'tapRefuseUnit(reason, toThem) {', 'tapQuoteTheirDollars(offer) {',
    'tapPreQuoteMint(offer, sats) {'])), {
    state: { screen: 'home', stack: [] }, cards: [], toasts: [], gave: [], opened: [], converted: [], awaited: [], backs: 0,
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    blockedCard(kind, cc) { this.cards.push(Object.assign({ kind }, cc)); },
    needsMintCard(reason) { this.cards.push({ kind: 'needsMint', reason }); },
    toast(t) { this.toasts.push(t); }, back() { this.backs += 1; },
    tapGaveNothing(w) { this.gave.push(w); }, hideConnecting() {}, waitingScreen(kind, oo) { this.waiting = oo; },
    dismissCard() {}, hideStage() {}, haptic() {},
    offlineNow: () => !!c.deaf, twoUnitsOn: () => true,
    openRequest(text, oo) { this.opened.push({ text, o: oo }); },
    tapConvertPay(inv, from) { this.converted.push({ inv, from }); },
    tapAwaitUnitInvoice(offer, from) { this.awaited.push(from); },
    tapAgreeTheirPrice() { this.cards.push({ kind: 'agreeTheirPrice' }); },
    acceptTarget() { this.cards.push({ kind: 'lightning' }); return true; },
    tapWrongMint() { this.cards.push({ kind: 'wrongMint' }); },
    tapCrossMint() { this.cards.push({ kind: 'cross' }); },
    tapAwaitInvoice() { this.cards.push({ kind: 'awaitInvoice' }); },
  });
  return a;
}
/* A receiver at the mint holding dollars, and a payer, wired over one link. Prices are set and both
 * have seen the mint (its keys on file) before either goes offline. */
async function pair(o) {
  const opts = o || {};
  const rx = await connected({});
  await rx.W.primeLocks();
  rx.W.setWalletChoice({ hold: opts.hold || 'dollars' });
  const payer = await connected({ mint: rx.mint, words: WORDS_B });
  if (opts.payerSat !== 0) await fund(payer, opts.payerSat || 20000, 'sat');
  if (opts.payerUsd) await fund(payer, opts.payerUsd, 'usd');
  await payer.W.primeLocks();
  payer.W._rate = PRICE; payer.W._rateAt = Date.now() - (opts.payerAge || 30000);
  rx.W._rate = opts.rxRate || PRICE; rx.W._rateAt = Date.now() - (opts.rxAge || 30000);
  if (opts.rxOffline) { goOffline(rx); await rx.W.connect(MINT, null, null, { remember: true }); }
  if (opts.payerOffline) { goOffline(payer); await payer.W.connect(MINT, null, null, { remember: true }); }
  const L = link();
  L.payer = payer; L.receiver = rx;
  payer.link = L; rx.link = L;
  rx.from = books(rx);
  payer.from = books(payer);
  const t = { rx, payer, L, rxa: rxApp(rx, { extra: opts.rxExtra }), pa: payerApp(payer) };
  t.text = rx.W.paymentRequest(opts.cents || 500, { unit: 'usd', purpose: 'receive' });
  t.usdReq = rx.W.decodeRequest(t.text) || {};
  t.offer = offerOf(rx, t.rxa, t.text, { inv: opts.inv });
  if (opts.dropFlag) { const j = JSON.parse(t.offer); delete j.sats4usd; t.offer = JSON.stringify(j); }
  t.rxa._tapOffer = t.offer;
  return t;
}
// the tap: the payer reads the offer and does what `tapStartPay` does with it at one mint
function tap(t) {
  const offer = t.pa.tapOfferOf(t.offer);
  t.read = offer;
  if (offer.asksUsd) t.pa.tapQuoteTheirDollars(offer); else t.pa.tapPayOffer(offer);
  return offer;
}
// SEND on the confirmation: the request it opened, paid over the link as `makeTokenForRequest` pays it
function send(t) {
  const opened = t.pa.opened[t.pa.opened.length - 1];
  const req = Object.assign({}, t.payer.W.decodeRequest(opened.text) || {}, { viaTap: true, theirRoute: !t.rx.deaf, asks: true });
  return t.payer.W.payRequest(req, () => {}, {}).then((made) => ({ made }), (e) => ({ e, why: String((e && e.message) || e) }));
}
const priced = (c) => c.quotes.map((q) => { try { return JSON.parse(q); } catch (e) { return {}; } }).filter((q) => q.rate != null || q.sats != null);

async function run() {
  console.log('foxy: a wallet holding dollars, paid in sats by tap\n');

  // ---- 1. the receiver offline and holding dollars, the payer online with sats only ---------------
  {
    const t = await pair({ rxOffline: true, rxRate: 75500, rxAge: 2 * HOUR });
    const o = JSON.parse(t.offer);
    ok(o.sats4usd === 1 && o.up === false && !o.rate && t.usdReq.unit === 'usd' && t.usdReq.amount === 500,
      '1: the offer: a request in dollars, offline, and that sats are taken for it', t.offer);
    const satBefore = t.payer.W.balanceOf('sat');
    const offer = tap(t);
    ok(offer.satsForUsd === true && offer.sameMint === true, '1: the payer reads it so', JSON.stringify({ s4u: offer.satsForUsd, same: offer.sameMint }));
    await until(() => t.rxa.state.screen === 'priceConfirm');
    const q = priced(t.payer)[0] || {};
    ok(q.forUnit === 'usd' && q.usd === 500 && q.rate === PRICE && q.sats === Math.round(5 / PRICE * 1e8) && q.id === t.usdReq.id && q.ageMs >= 0,
      '1: M10: the payer’s price, its age, and the sats it makes, for this dollar request', JSON.stringify(q));
    ok(t.pa.waiting && t.pa.waiting.body === 'This receiver is offline and must agree to the current Bitcoin price before continuing.',
      '1: the payer waits with the words it always had for an offline receiver', t.pa.waiting && t.pa.waiting.body);
    ok(t.rxa.state.screen === 'priceConfirm', '1: the receiver’s own price is 2% off: the person is asked', t.rxa.state.screen);
    const spec = t.rxa.priceSpec();
    const rowv = (l) => (spec.rows.find((r) => r.label === l) || {}).value;
    ok(rowv('YOU ASKED FOR') === '$ 5.00' && rowv('YOUR PRICE SEEN') === '2 HOURS AGO' && !rowv('THEIR PRICE SEEN')
      && rowv('THEN') === 'Foxy swaps it into dollars at the mint as soon as you are online.' && spec.amountLabel === 'CURRENT BITCOIN PRICE',
      '1: the PRICE screen: what was asked, this phone’s price two hours old, and what happens after', JSON.stringify(spec.rows.map((r) => r.label + '=' + r.value)));
    t.rxa.priceAnswer(true);
    await until(() => t.pa.opened.length > 0);
    const back = t.payer.W.decodeRequest((t.pa.opened[0] || {}).text || '') || {};
    ok(t.pa.opened.length === 1 && back.unit === 'sat' && back.sats === q.sats && canon(back.mints[0]) === MINT,
      '1: ACCEPT: a request in sats for exactly that, and the payer opens it', JSON.stringify({ opened: t.pa.opened.length, back }));
    ok(t.pa.state.tapQuoteFor === back.id && t.pa.state.tapQuoteUsd === 500 && t.pa.state.tapQuoteRate === PRICE,
      '1: the confirmation will say what it is for, at whose price', JSON.stringify(t.pa.state));
    const r = await send(t);
    ok(!!r.made && !!r.made.lockedTo, '1: paid, locked to the receiver', r.why);
    await until(() => t.rx.answers.length > 0 && !!recOf(t.rx, back.id));
    const rec = recOf(t.rx, back.id) || {};
    ok(rec.state === 'owed' && rec.sats === q.sats && rec.usd === 500, '1: the receiver keeps it, owed a swap into dollars', JSON.stringify(rec));
    const row = rowOf(t.rx, back.id);
    ok(row.usdAsked === 500 && row.askRate === PRICE && row.rate === PRICE && typeof row.askAgeMs === 'number' && row.convert === 'owed',
      '1: its row: what was asked, the payer’s price and its age', JSON.stringify(row));
    ok(t.rxa.events.length && t.rxa.events.every((e) => e.convert === true), '1: told from the first word that these become dollars',
      JSON.stringify(t.rxa.events.map((e) => e.stage + ':' + e.convert)));
    ok(t.payer.W.balanceOf('sat') < satBefore && t.payer.W.balanceOf('usd') === 0, '1: the payer paid sats, and holds no dollars');
    ok(t.L.log.join(' ').indexOf('M10') >= 0 && t.L.log.indexOf('M5') > t.L.log.indexOf('M11'), '1: price, answer, then payment', t.L.log.join(' | '));
    // back online: the claim lands, and the swap runs once (with the price any connection fetches)
    goOnline(t.rx);
    t.rx.W._rate = PRICE; t.rx.W._rateAt = Date.now();
    await t.rx.W.connect(MINT, null, null, { remember: true });
    await t.rx.W.claimUnclaimed();
    await until(() => (recOf(t.rx, back.id) || {}).state === 'done' && !t.rxa._converting, 10000);
    const done = recOf(t.rx, back.id) || {};
    const legs = swapRows(t.rx).filter((x) => x.swap === done.swap);
    ok(done.state === 'done' && legs.length === 2 && legs.some((x) => x.dir === 'in' && x.unit === 'usd' && x.amount === done.gotUsd),
      '1: back online: claimed, then swapped once, a dollar row in', JSON.stringify({ done, legs: legs.length }));
    ok(t.rxa.toasts.length === 1 && t.rxa.toasts[0] === 'You chose dollars, so Foxy is swapping the ₿ ' + t.rxa.group(q.sats) + ' you were paid into dollars.',
      '1: and said as it starts', JSON.stringify(t.rxa.toasts));
    ok(rowOf(t.rx, back.id).convert === 'done' && rowOf(t.rx, back.id).convertUsd === done.gotUsd && t.rx.W.balanceOf('usd') === done.gotUsd,
      '1: the row says swapped into what; the dollars are in the dollar balance', JSON.stringify(rowOf(t.rx, back.id)));
    await booksShut(t, '1');
  }

  // ---- 2. the payer offline with sats, the receiver online and holding dollars -------------------
  {
    // offline there is no swap to make change with, so the payer holds exactly the pieces for $ 5.00 at its price
    const t = await pair({ payerOffline: true, payerSat: Math.round(5 / PRICE * 1e8) });
    const o = JSON.parse(t.offer);
    ok(o.sats4usd === 1 && o.up === true, '2: an online dollars wallet says it too', t.offer);
    tap(t);
    await until(() => t.pa.opened.length > 0);
    ok(t.rxa.state.screen === 'home' && t.rx.terms.length === 1, '2: the same price on both phones: agreed without asking',
      JSON.stringify({ screen: t.rxa.state.screen, terms: t.rx.terms }));
    ok(t.pa.waiting && t.pa.waiting.body === 'They asked for dollars, and must agree to this phone’s Bitcoin price before continuing.',
      '2: the payer, to a receiver that is online, says why it waits', t.pa.waiting && t.pa.waiting.body);
    const back = t.payer.W.decodeRequest(t.pa.opened[0].text) || {};
    const r = await send(t);
    ok(!!r.made && !r.made.lockedTo, '2: paid plain from an offline payer', r.why);
    await until(() => (recOf(t.rx, back.id) || {}).state === 'done' && !t.rxa._converting, 10000);
    const done = recOf(t.rx, back.id) || {};
    const legs = swapRows(t.rx).filter((x) => x.swap === done.swap);
    ok(done.state === 'done' && legs.length === 2 && t.rx.W.balanceOf('usd') === done.gotUsd && t.rx.W.balanceOf('sat') === back.sats - legs.find((x) => x.dir === 'out').sats - (legs.find((x) => x.dir === 'out').feeSats || 0),
      '2: swapped in, claimed, and swapped into dollars at once', JSON.stringify({ done, sat: t.rx.W.balanceOf('sat'), usd: t.rx.W.balanceOf('usd') }));
    const row = rowOf(t.rx, back.id);
    ok(row.usdAsked === 500 && row.convert === 'done' && row.rate === PRICE, '2: its row: asked $ 5.00, swapped', JSON.stringify(row));
    /* the screen's own word on a payment that has landed (`requestPaidHere`): nothing is kept for the next receive,
     * whatever was paid and whatever is held (the owner, 2026-10-22: each receive asks) */
    const landed = (ev, hold) => {
      const kept = [];
      const quietly = (x) => new Proxy(x, { get: (o2, k) => (k in o2 ? o2[k] : (typeof k === 'string' && k[0] !== '_' ? () => '' : undefined)) });
      const h = quietly(Object.assign(lift(t.rx.W, ['requestPaidHere(ev) {']), {
        state: { screen: 'home', stack: [] }, setState() {}, twoUnitsOn: () => true,
        walletChoiceNow: () => ({ hold }), rememberWallet(kind, u) { kept.push(kind + ':' + u); },
        setWalletChoice(x) { kept.push('set:' + JSON.stringify(x)); },
      }));
      h.requestPaidHere(ev);
      return kept;
    };
    const paidEv = t.rxa.events.filter((e) => e.stage === 'paid').pop() || {};
    ok(paidEv.convert === true && !landed(paidEv, 'dollars').length && t.rx.W.walletChoice().recv === 'usd',
      '2: the sats were swapped into dollars, the wallet still holds dollars, and nothing is kept for the next receive', JSON.stringify(paidEv));
    ok(!landed(Object.assign({}, paidEv, { convert: false }), 'dollars').length
      && !landed(Object.assign({}, paidEv, { convert: false }), 'both').length,
      '2: a wallet holding both, paid in sats, keeps nothing either: its next receive asks');
    await booksShut(t, '2');
  }

  // ---- 3. both offline -----------------------------------------------------------------------------
  {
    const t = await pair({ rxOffline: true, payerOffline: true });
    const before = t.payer.W.balanceOf('sat');
    tap(t);
    await wait(30);
    const c = t.pa.cards[0] || {};
    ok(c.kind === 'needsMint' && c.reason === 'You are both offline, so nothing here could settle this payment. One of you needs a connection.',
      '3: both offline: refused, in the words of today', JSON.stringify(t.pa.cards));
    ok(!priced(t.payer).length && t.payer.quotes.length === 1 && JSON.parse(t.payer.quotes[0]).gaveUp === 'You are both offline. One of you needs a connection.',
      '3: no price is sent, only why', JSON.stringify(t.payer.quotes));
    ok(!t.pa.opened.length && t.payer.W.balanceOf('sat') === before && !recs(t.rx).length, '3: nothing moved');
    await booksShut(t, '3');
  }

  // ---- 4. a receiver holding both, with a dollar request ------------------------------------------
  {
    const t = await pair({ hold: 'both', rxOffline: true });
    ok(!('sats4usd' in JSON.parse(t.offer)), '4: a wallet holding both does not take sats for dollars', t.offer);
    tap(t);
    await wait(30);
    ok((t.pa.cards[0] || {}).reason === 'This request is in dollars. You hold no dollars here, and paying it from bitcoin needs both of you online.'
      && !priced(t.payer).length && !t.pa.opened.length, '4: the payer online, the receiver offline: today’s refusal', JSON.stringify(t.pa.cards));
    const u = await pair({ hold: 'both', payerOffline: true });
    tap(u);
    await wait(30);
    ok((u.pa.cards[0] || {}).reason === 'This request is in dollars. You hold no dollars here, and paying it from bitcoin needs the mint.'
      && !priced(u.payer).length && !u.pa.opened.length, '4: the payer offline: today’s refusal', JSON.stringify(u.pa.cards));
    await booksShut(t, '4');
    await booksShut(u, '4');
  }

  // ---- 5. an older receiver that does not say it ----------------------------------------------------
  {
    const t = await pair({ rxOffline: true, dropFlag: true });
    tap(t);
    await wait(30);
    ok((t.pa.cards[0] || {}).reason === 'This request is in dollars. You hold no dollars here, and paying it from bitcoin needs both of you online.'
      && !priced(t.payer).length, '5: no flag: today’s refusal', JSON.stringify(t.pa.cards));
    await booksShut(t, '5');
  }

  // ---- 6. both online -------------------------------------------------------------------------------
  {
    const t = await pair({ inv: 'lnbc5000n1pdollarinvoice' });
    tap(t);
    await wait(30);
    ok(t.pa.converted.length === 1 && t.pa.converted[0].from === 'sat' && !t.payer.quotes.length && !t.pa.opened.length,
      '6: both online: their dollar invoice paid from bitcoin, and no price talked over', JSON.stringify({ conv: t.pa.converted, quotes: t.payer.quotes }));
    await booksShut(t, '6');
  }

  // ---- 7. the checks ---------------------------------------------------------------------------------
  {
    // the receiver: a quote for another request, or another amount, is not for this one
    const t = await pair({ rxOffline: true });
    const quote = Object.assign(t.payer.W.quoteFor(t.usdReq), {});
    t.rx.W._tapQuote(JSON.stringify(Object.assign({}, quote, { id: 'not-this-one' })));
    t.rx.W._tapQuote(JSON.stringify(Object.assign({}, quote, { usd: 900, sats: Math.round(9 / quote.rate * 1e8) })));
    await wait(30);
    const said = t.rx.terms.map((x) => JSON.parse(x));
    ok(said.length === 2 && said.every((x) => x.no === true && x.why === 'That price is not for this request.') && !t.rxa.made.length,
      '7: the receiver refuses sats for another request or another amount', JSON.stringify(said));
    await booksShut(t, '7a');
    // the payer: an answer in dollars is not an answer to sats
    const u = await pair({ rxOffline: true });
    /* For the very sats offered, so the amount check would pass it: only
     * the unit can refuse it. */
    u.rxa.railRequestReady = function (n) {
      const x = u.rx.W.paymentRequest(500, { unit: 'usd', purpose: 'receive' });
      this.made.push(x); this.dollar = x; this.offered = n;
      return Promise.resolve(x);
    };
    const realU = u.payer.W.decodeRequest;
    u.payer.W.decodeRequest = (x) => {
      const r = realU(x);
      return (r && x === u.rxa.dollar) ? Object.assign({}, r, { sats: u.rxa.offered }) : r;
    };
    tap(u);
    await until(() => u.pa.toasts.length > 0);
    u.payer.W.decodeRequest = realU;
    ok(u.pa.toasts[0] === 'Their request is not for sats at this mint. Nothing was sent.' && !u.pa.opened.length
      && u.pa.gave.indexOf('their request was not for what was offered') >= 0,
      '7: an answer in dollars: refused by the payer, nothing sent', JSON.stringify({ toasts: u.pa.toasts, gave: u.pa.gave }));
    await booksShut(u, '7b');
    // and an answer at another mint
    const v = await pair({ rxOffline: true });
    const realDecode = v.payer.W.decodeRequest;
    v.rxa.railRequestReady = function (n) { const x = v.rx.W.paymentRequest(n, { unit: 'sat', purpose: 'receive' }); this.made.push(x); this.elsewhere = x; return Promise.resolve(x); };
    v.payer.W.decodeRequest = (x) => {
      const r = realDecode(x);
      return (r && x === v.rxa.elsewhere) ? Object.assign({}, r, { mints: ['https://other.test'] }) : r;
    };
    tap(v);
    await until(() => v.pa.toasts.length > 0);
    ok(v.pa.toasts[0] === 'Their request is not for sats at this mint. Nothing was sent.' && !v.pa.opened.length,
      '7: an answer at another mint: refused by the payer, nothing sent', JSON.stringify(v.pa.toasts));
    v.payer.W.decodeRequest = realDecode;
    await booksShut(v, '7c');
  }

  // ---- 8. a payer short of the sats with the fee -------------------------------------------------------
  {
    const t = await pair({ rxOffline: true, payerSat: 3000 });
    tap(t);
    await wait(30);
    const c = t.pa.cards[0] || {};
    ok(c.kind === 'needsMint' && /needs|enough/i.test(c.reason || '') && !priced(t.payer).length && t.payer.quotes.length === 1
      && JSON.parse(t.payer.quotes[0] || '{}').gaveUp === 'The payer does not have enough to cover this payment.' && !t.pa.opened.length,
      '8: short of the sats with the fee: refused before any price, and they are told without figures', JSON.stringify({ cards: t.pa.cards, q: t.payer.quotes }));
    await booksShut(t, '8');
  }

  // ---- 9. when the swap runs: never put away, and not under money moving ------------------------------
  {
    const t = await pair({ rxOffline: true });
    tap(t);
    await until(() => t.pa.opened.length > 0);
    const back = t.payer.W.decodeRequest(t.pa.opened[0].text) || {};
    await send(t);
    await until(() => (recOf(t.rx, back.id) || {}).state === 'owed');
    // put away when the route comes back: the claim lands, and nothing is swapped
    t.rxa._putAway = true;
    goOnline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    await t.rx.W.claimUnclaimed();
    await wait(80);
    ok((recOf(t.rx, back.id) || {}).state === 'claimed' && !swapRows(t.rx).length && !t.rxa._convertT,
      '9: put away: claimed, and not swapped, and nothing waiting on a clock', JSON.stringify(recOf(t.rx, back.id)));
    // back in front with a payment going out: it waits, and goes once that is done
    t.rxa._putAway = false;
    t.rxa._sendRun = true;
    t.rxa.convertOnReturn();
    await wait(50);
    ok(!swapRows(t.rx).length && !!t.rxa._convertT, '9: money moving: not now, but a little later', String(!!t.rxa._convertT));
    t.rxa._sendRun = null;
    await until(() => (recOf(t.rx, back.id) || {}).state === 'done' && !t.rxa._converting, 6000);
    ok((recOf(t.rx, back.id) || {}).state === 'done' && swapRows(t.rx).length === 2 && t.rxa.settled.indexOf('both') >= 0,
      '9: then swapped, once, and home counts both balances to their new figures', JSON.stringify({ rec: recOf(t.rx, back.id), settled: t.rxa.settled }));
    t.rxa.convertOnReturn();
    await wait(50);
    ok(swapRows(t.rx).length === 2 && t.rxa.toasts.length === 1, '9: asked again, nothing more happens', JSON.stringify(t.rxa.toasts));
    await booksShut(t, '9');
  }

  // ---- 10. what the swap says, and what it waits for ---------------------------------------------------
  /* The app's half alone (`convertOnReturn` and its helpers), on a stand-in wallet that answers what it is
   * told to: the words for each outcome, once each, and every moment it holds back for. */
  {
    const stub = (results, o) => {
      const opts = o || {};
      const W = {
        connected: true, calls: 0, priced: 0, wants: !!opts.wants,
        owed: (opts.owed || ['p1']).map((id) => ({ id, state: 'claimed', tried: false })),
        fromCache: () => false,
        convertsOwed() { return this.owed.map((x) => Object.assign({}, x)); },
        convertWantsPrice() { return this.wants; },
        rate() { this.priced += 1; this.wants = false; return Promise.resolve(PRICE); },
        convertOne(stage) {
          this.calls += 1;
          const r = results.shift() || null;
          if (r && (r.outcome === 'done' || r.outcome === 'pending' || r.outcome === 'failed')) stage('start', { got: 5000 }, { total: 5000 });
          if (r) this.owed = this.owed.map((x) => (x.id === r.id ? Object.assign({}, x, { tried: true, state: r.outcome === 'done' ? 'done' : 'claimed' }) : x));
          return Promise.resolve(r);
        },
      };
      return W;
    };
    const say = (id, outcome) => ({ id, outcome, state: outcome === 'done' ? 'done' : 'claimed', rec: { id, got: 5000 },
      from: { unit: 'sat', amount: 5000 }, to: { unit: 'usd', amount: outcome === 'done' ? 380 : 0 } });
    const appOf = (W, extra) => Object.assign(lift(W, COMMON.concat(['convertOnReturn(due) {', 'convertWaiting() {', 'convertLater() {',
      'swapPendingCard(r, o) {', 'moneyBusy() {'])), {
      CONVERT_WAITS: 6, state: { screen: 'home', stack: [], tapArmed: false }, cards: [], toasts: [], settled: [], went: [],
      setState(u) { const n = typeof u === 'function' ? u(this.state) : u; if (n.screen) this.went.push(n.screen); Object.assign(this.state, n); },
      blockedCard(kind, cc) { this.cards.push(Object.assign({ kind }, cc)); },
      toast(t) { this.toasts.push(t); }, offlineNow: () => false, twoUnitsOn: () => true,
      refreshBalance() {}, loadHistory() {}, settleAnimate(l) { this.settled.push(l); },
    }, extra || {});

    // a mint that will not swap it, said twice in one launch: one word
    let W = stub([say('p1', 'failed'), say('p1', 'failed')]);
    let a = appOf(W);
    a.convertOnReturn(true);
    await wait(10);
    W.owed[0].tried = false;
    a.convertOnReturn(true);
    await wait(10);
    ok(W.calls === 2 && a.toasts.filter((x) => /^Foxy could not swap the ₿ 5,000 into dollars just now\. It stays as bitcoin\.$/.test(x)).length === 1,
      '10: not swapped, twice in one launch: said once', JSON.stringify(a.toasts));
    clearTimeout(a._convertT);

    // with the mint on home: its card over home, and nobody taken anywhere
    W = stub([say('p1', 'pending')]);
    a = appOf(W);
    a.convertOnReturn(true);
    await wait(10);
    ok(a.cards.length === 1 && a.cards[0].kind === 'swapPending' && a.cards[0].title === 'SWAP STILL GOING THROUGH'
      && /The mint has your ₿ 5,000 and has not finished the swap yet/.test(a.cards[0].reason) && !a.went.length && a.state.screen === 'home',
      '10: still with the mint, on home: the card, and no move', JSON.stringify({ cards: a.cards, went: a.went }));
    // and anywhere else: a word, and no card over what the person is doing
    W = stub([say('p1', 'pending')]);
    a = appOf(W);
    a.state.screen = 'history';
    a.convertOnReturn(true);
    await wait(10);
    ok(!a.cards.length && a.toasts.indexOf('The swap into dollars is still going through. Foxy finishes it by itself.') >= 0 && !a.went.length,
      '10: still with the mint, elsewhere: said, with no card', JSON.stringify({ cards: a.cards, toasts: a.toasts }));

    // done: no word but the one as it started, and home counts both balances
    W = stub([say('p1', 'done')]);
    a = appOf(W);
    a.convertOnReturn(true);
    await wait(10);
    ok(a.toasts.length === 1 && /^You chose dollars, so Foxy is swapping the ₿ 5,000 you were paid into dollars\.$/.test(a.toasts[0])
      && a.settled.indexOf('both') >= 0 && !a.cards.length, '10: swapped: one word as it starts, and both balances counted up', JSON.stringify(a.toasts));

    // two waiting: the second goes a second after the first
    W = stub([say('p1', 'done'), say('p2', 'done')], { owed: ['p1', 'p2'] });
    a = appOf(W);
    a.convertOnReturn(true);
    await wait(10);
    ok(W.calls === 1 && !!a._convertT, '10: two waiting: one now, and the next on a clock');
    await until(() => W.calls === 2 && !a._converting, 3000);
    ok(W.calls === 2 && W.owed.every((x) => x.state === 'done'), '10: and then the second', JSON.stringify(W.owed));

    // a tap under way, or a person on a confirmation or SET AMOUNT for a payment: not now, and then
    for (const [hold, clear] of [
      ['a tap under way', (x) => { x._tapTalking = true; return () => { x._tapTalking = false; }; }],
      ['the radio on for a tap', (x) => { x.state.tapArmed = true; return () => { x.state.tapArmed = false; }; }],
      ['a payment being confirmed', (x) => { x.state.screen = 'sendConfirm'; return () => { x.state.screen = 'home'; }; }],
      ['SET AMOUNT for a payment', (x) => { x.state.screen = 'amount'; x.state.flow = 'send'; return () => { x.state.screen = 'home'; }; }],
      ['a SWAP being confirmed', (x) => { x.state.screen = 'swapConfirm'; return () => { x.state.screen = 'home'; }; }],
    ]) {
      W = stub([say('p1', 'done')]);
      a = appOf(W);
      const free = clear(a);
      a.convertOnReturn(true);
      await wait(10);
      ok(W.calls === 0 && !!a._convertT, '10: ' + hold + ': nothing is swapped, and it looks again later', JSON.stringify({ calls: W.calls }));
      free();
      await until(() => W.calls === 1 && !a._converting, 3000);
      ok(W.calls === 1 && a.toasts.length === 1, '10: ' + hold + ' over: swapped, once', JSON.stringify({ calls: W.calls, toasts: a.toasts }));
      clearTimeout(a._convertT);
    }

    // put away: nothing, and nothing left on a clock (the return asks)
    W = stub([say('p1', 'done')]);
    a = appOf(W, { _putAway: true });
    a.convertOnReturn(true);
    await wait(10);
    ok(W.calls === 0 && !a._convertT, '10: put away: nothing, and no clock');

    // no current price: one is asked for first, and the swap follows it
    W = stub([say('p1', 'done')], { wants: true });
    a = appOf(W);
    a.convertOnReturn(true);
    await until(() => W.calls === 1, 2000);
    ok(W.priced === 1 && W.calls === 1, '10: an old price: a new one is asked for, then the swap', JSON.stringify({ priced: W.priced, calls: W.calls }));
  }

  // ---- 11. where the swap is started from, in the build ------------------------------------------------
  {
    const has = (sig, re) => re.test(method(sig));
    ok(has('bootWallet() {', /W\.onConvertDue\(\(\) => this\.convertOnReturn\(true\)\)/),
      '11: at boot, the wallet’s word that sats are in the pile starts it');
    ok(has('setUpAfterReturn() {', /Promise\.resolve\(swept\)\.then\(\(\) => \{ if \(this\.convertOnReturn\) this\.convertOnReturn\(\); \}\)/),
      '11: a return or a launch starts it, after the sweeps');
    ok(has('claimWhenRouteReturns() {', /W\.claimUnclaimed\(\)\.then\(\(took\) => \{[\s\S]*this\.convertOnReturn\(\)/),
      '11: a route coming back starts it, after what waited is claimed');
    ok(has('connectForRealOnceOnline() {', /this\.offerQuarantine\(\);\s*\/\/[^\n]*\n\s*if \(this\.convertOnReturn\) this\.convertOnReturn\(\);/),
      '11: and the connect behind home, once the mint’s own keys are in');
  }

  // ---- 12. the payment-received screen for sats paid for dollars --------------------------------------
  {
    // `nextPaidScreen` passes the dollars asked only for a payment that is to be swapped into them
    const raised = [];
    const q = Object.assign(lift({}, ['nextPaidScreen() {']), {
      state: { screen: 'home' }, SPLIT_SCREENS: [], queueLater() {}, cardFlowHolds: () => false,
      announcePayment(ev) { raised.push(ev); },
    });
    q._paidQueue = [{ dir: 'in', sats: 6502, hash: 'req-a', usdAsked: 500, askAgeMs: 2 * HOUR, convert: 'owed' }];
    q.nextPaidScreen();
    q._paidQueue = [{ dir: 'in', sats: 6502, hash: 'req-b', usdAsked: 500, askAgeMs: 2 * HOUR }];
    q.nextPaidScreen();
    ok(raised.length === 2 && raised[0].askConvert === true && raised[0].usdAsked === 500 && raised[0].askAgeMs === 2 * HOUR
      && !raised[1].askConvert && raised[1].usdAsked === undefined,
      '12: the dollars asked go to the screen only with a payment to be swapped; one agreed in dollars that stays bitcoin carries none',
      JSON.stringify(raised));
    // and `renderPaid` heads it with them only then
    const r = Object.assign(lift({}, COMMON.concat(['renderPaid(c) {'])), {
      renderPaidBase: () => ({ paidHeadline: '₿ 6,502', paidHeadlineSub: '$ 5.00', paidAddedTo: '' }),
      twoUnitsOn: () => true,
    });
    const shown = (extra) => r.renderPaid({ s: Object.assign({ paidUnit: '', payOut: false, paidAsked: 500, paidAskAgeMs: 2 * HOUR }, extra), sc: 'paid', sats: 6502 });
    const conv = shown({ paidConvert: true });
    const plain = shown({ paidConvert: false });
    ok(conv.paidHeadline === '$ 5.00' && conv.paidHeadlineSub === '₿ 6,502 · THEIR PRICE 2 HOURS AGO' && conv.paidAddedTo === 'BITCOIN, THEN DOLLARS',
      '12: to be swapped: the dollars asked, the sats under them with the payer’s price age, bitcoin then dollars', JSON.stringify(conv));
    ok(plain.paidHeadline === '₿ 6,502' && plain.paidHeadlineSub === '$ 5.00' && plain.paidAddedTo === 'BITCOIN',
      '12: agreed in dollars and staying bitcoin: shown as it always was', JSON.stringify(plain));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

run().catch((e) => { console.log('THREW', (e && e.stack) || e); process.exitCode = 1; })
  .then(() => setTimeout(() => process.exit(), 50));
