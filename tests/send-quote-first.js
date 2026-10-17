'use strict';
/* send-quote-first.js — CONFIRM PAYMENT, at a mint with two balances, lets its button go on the balance that pays.
 *
 *     node tests/send-quote-first.js
 *
 * The confirmation quotes a Lightning invoice from both balances at once (`quoteFeeBoth`), so it can say what each
 * would cost and switch to the one that covers the payment. It held its button at CHECKING until both quotes were in:
 * on a launch the bitcoin quote was in at 2.3 seconds and the dollar one, its circuit gone nowhere, at 8.6, and SEND
 * waited on dollars nobody had chosen. Each quote is now taken as it lands (03-send.js `feeQuoteIn`), and the button
 * waits on the balance that pays (`feeWaits`).
 *
 * The app's own methods, lifted from the build onto the page of a real wallet at the harness's mint with a dollar
 * keyset, the mint answering each balance's melt quote after a delay set for that balance. The wallet's quotes, the
 * switch and the payment are the real ones; a repaint is a call to `syncSend`, as in tests/home-first.js.
 *
 *   a  bitcoin chosen, its quote at once and the dollar one eight seconds late: PAY, with the bitcoin fee, as soon as
 *      the bitcoin quote is in; pressed before the dollar quote lands, it pays on the bitcoin quote, on that quote's
 *      circuit, and the late quote is dropped: not shown, not kept, not asked again on other circuits beside the
 *      payment, nothing switched, nothing paid twice
 *   b  the same with dollars chosen
 *   c  the chosen balance cannot cover the payment: CHECKING until the other's quote is in, then switched to it
 *   d  the mint gives the chosen balance no quote: PAY on it at once, the fee UNKNOWN, as before; nothing waits on the
 *      other's quote and nothing is switched to it, since no quote says nothing of what the chosen balance holds
 *   e  a mint with one balance: one quote, SEND when it is in, as before
 *   f  a payment from a card: one quote, in what the card holds, as before
 *   g  the other balance picked by hand while its quote is on its way: CHECKING until it lands, then that balance pays
 *   h  PAY pressed while the other balance's quote is on its way, and the send refused: back on the confirmation, that
 *      quote alone is asked again, the one paid with kept; picked by hand the other balance waits for it, then reads
 *      NOT ENOUGH where it is short, or PAY with its own fee where it covers the payment, never PAY with no figure.
 *      The same where the first PAY met Tor reconnecting and TRY AGAIN was pressed on that card
 *   i  the price moved at PAY: back on the confirmation, a new question asks both afresh, and nothing more
 *   j  an address, PAY with no connection: back on the confirmation, the dropped quote is asked on the invoice the
 *      address gave, which is kept, and PAY on that balance pays that invoice on that quote
 *
 * Real timers, the scenarios side by side: about ten seconds.
 */
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const ROOT = path.join(__dirname, '..');
const MINT = 'https://m.test';
// a bolt11 from nobody in particular, for 2,000 sats: 154 cents at the harness mint's rate (tests/two-balances.js)
const FOREIGN = 'lnbc20000n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqxyzzy';
// and another, for 3,000, the next payment
const NEXT = FOREIGN.replace('20000n', '30000n');
const LATE = 8000;
// a Lightning address's server: asked for an amount, an invoice for it with the description hash of what it described (tests/flashcard-send.js)
const ADDRESS = 'alice@addr.test';
const META = '[["text/plain","Pay alice"]]';
const invoiceFor = (prefix, text) => {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hash = require('crypto').createHash('sha256').update(text, 'utf8').digest();
  const words = [];
  let acc = 0, bits = 0;
  for (const b of hash) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
    acc &= (1 << bits) - 1;
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  return prefix + [0, 0, 0, 0, 0, 0, 0, 23, 1, 20].concat(words, new Array(104).fill(0)).map((v) => CHARSET[v]).join('') + 'qqqqqq';
};
const addressServer = (m) => '200\n' + JSON.stringify(/\/\.well-known\//.test(m.url)
  ? { tag: 'payRequest', callback: 'https://addr.test/cb', minSendable: 1000, maxSendable: 100000000, metadata: META }
  : { pr: invoiceFor('lnbc' + Math.round(Number(/amount=(\d+)/.exec(m.url)[1]) / 100) + 'n1', META) });

let failed = 0;
const lines = [];
const ok = (good, name, detail) => {
  lines.push((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 4000); while (Date.now() < end) { if (fn()) return true; await wait(10); } return !!fn(); };
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 60000).unref();

// ---- the app's methods, as they are built ----------------------------------------------------------
const appSrc = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
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
const LIFTED = [
  // the route, and which balance pays
  'connecting() {', 'offlineNow() {', 'twoUnitsOn() {', 'cardSendNow() {', 'walletChoiceNow() {', 'walletNow(flow) {', 'rememberWallet(flow, unit) {',
  'unitWord(unit) {', 'walletLabel(unit) {', 'unitFigure(amount, unit) {', 'unitBalance(unit) {', 'syncWalletAsk() {', 'openWalletPick() {',
  'walletPickChoose(unit, why) {', 'autoWallet(fits) {', 'quoteFits(unit) {',
  // the confirmation
  'confirmSpec() {', 'confirmTwoSpec() {', 'cfRow(label, value, opt) {', 'sendToText() {', 'shortId(v) {', 'sendAmountText() {', 'money(sats, fiatCents) {',
  'usd(v) {', 'group(n) {', 'satUsd() {', 'px() {', 'peerRate() {', 'peerRateLabel() {', 'peerRateRow() {', 'heldBlocks(shortBy) {', 'heldNote() {',
  'unitLabel(unit) {', 'wantedSats() {', 'typedSats() {', 'sendSatsNow() {',
  // what it asks, and the payment
  'sendAsk() {', 'sendToAsk() {', 'quoteSendFee() {', 'feeQuotesIn(both) {', 'feeQuoteIn(unit, q) {', 'feeWaits(unit) {', 'feeQuotesLeft() {',
  'feeQuotesAgain() {', 'syncSend() {', 'notOnlineCard() {', 'offlineInvoiceCard() {', 'toConfirm() {', 'toAmount() {', 'startSend() {', 'startSendNow(to, o) {',
];

/* A page at the harness mint. `ctx.delay(path, unit)` is how long the mint takes over a request (0 unless said),
 * 'hang' for one never answered, or 'refuse' for a melt quote it turns down ('refuse:1500', turned down after that
 * long); every request is written down with its unit, its circuit and when it left. */
function page(units) {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const p = new URL(m.url).pathname;
        // the address's server answers at once, written down as 'address' and its path
        if (/^https:\/\/addr\.test\//.test(String(m.url))) {
          ctx.asked.push({ path: 'address ' + p, unit: '', circuit: String(m.circuit || ''), at: Date.now(), answered: Date.now() });
          return reply(w, m.id, addressServer(m));
        }
        let unit = '';
        try { unit = m.body ? String(JSON.parse(m.body).unit || '') : ''; } catch (e) { unit = ''; }
        const sent = { path: p, unit, circuit: String(m.circuit || ''), at: Date.now(), answered: 0 };
        ctx.asked.push(sent);
        const late = ctx.delay ? ctx.delay(p, unit) : 0;
        if (late === 'hang') return undefined;
        if (/^refuse/.test(String(late))) {
          return setTimeout(() => reply(w, m.id, '400\n{"code":11005,"detail":"unit not supported"}'), Number(String(late).split(':')[1]) || 0);
        }
        return setTimeout(() => { sent.answered = Date.now(); reply(w, m.id, mint.handle(m)); }, Number(late) || 0);
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true, units: units || ['sat', 'usd'] }); },
  });
  ctx.asked = [];
  ctx.delay = null;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}

/* A phone at the mint holding `fund` ({ sat, usd }, in each one's unit), its sends starting in `send`, and the app's
 * methods over it, on the home screen. `open()` pastes FOREIGN and opens CONFIRM PAYMENT. */
async function phone(o) {
  const ctx = page(o.units);
  const W = ctx.W;
  await W.connect(MINT, null, null, { remember: true });
  for (const unit of Object.keys(o.fund || {})) {
    const inv = await W.invoice(o.fund[unit], '', unit === 'usd' ? { unit: 'usd' } : undefined);
    await W.claim(inv.hash);
  }
  if (W.twoUnits()) W.setWalletChoice(Object.assign({ hold: 'both' }, o.send ? { send: o.send } : {}));
  // what a connect starts by itself (its sweeps) is over before the payment begins
  await wait(300);
  const app = ctx.window.eval('(function () { return {' + LIFTED.map(method).join(',\n') + '}; })()');
  const log = { toasts: [], cards: [] };
  Object.assign(app, {
    ctx, log,
    state: { screen: 'home', stack: [], flow: 'send', unit: 'SATS', amount: '', note: '', wallet: '', walletAuto: false, walletTapped: false,
             balSats: W.balanceOf('sat'), balUsdCents: W.balanceOf('usd') },
    // merged at once, as the page does; the repaint after it is `syncSend` (componentDidUpdate)
    setState(u) {
      Object.assign(app.state, typeof u === 'function' ? u(app.state) : u);
      Promise.resolve().then(() => app.syncSend());
    },
    toast(m) { log.toasts.push(String(m)); },
    blockedCard(kind, over) { log.cards.push(Object.assign({ kind }, over)); },
    go(screen) { app.setState((p) => ({ screen, stack: p.stack.concat([p.screen]) })); },
    back() { app.setState((p) => ({ screen: p.stack[p.stack.length - 1] || 'home', stack: p.stack.slice(0, -1) })); },
    mintName: () => 'm.test', balNow: () => ({ sats: app.state.balSats || 0 }), refreshBalance() {}, loadHistory() {}, tidyChangeNow() {},
    showPayPending() { log.pending = true; }, isBadSignatures: () => false, editSendNote() {}, checkSendPrice() {},
  });
  const t0 = { at: 0 };
  app.open = (inv) => {
    t0.at = Date.now();
    app.setState({ screen: 'sendConfirm', stack: ['home'], recipient: inv || FOREIGN, recipientKind: 'invoice', amount: '' });
  };
  // CONFIRM PAYMENT for `sats` to the address, typed in sats
  app.openAddress = (sats) => {
    t0.at = Date.now();
    app.setState({ screen: 'sendConfirm', stack: ['home'], recipient: ADDRESS, recipientKind: 'email', unit: 'SATS', amount: String(sats) });
  };
  // the invoices the address was asked for
  app.lookups = () => ctx.asked.filter((x) => x.path === 'address /cb');
  // ms since the confirmation opened
  app.since = () => Date.now() - t0.at;
  app.spec = () => (W.twoUnits() && !app.cardSendNow() ? app.confirmTwoSpec() : app.confirmSpec());
  app.live = () => { const s = app.spec(); return !s.ctaBusy && /^(PAY|SEND )/.test(String(s.cta)); };
  app.fee = () => { const r = (app.spec().rows || []).find((x) => x.label === 'FEE INCLUDED' || x.label === 'FEE'); return r ? r.value : ''; };
  app.quotes = (unit) => ctx.asked.filter((x) => x.path === '/v1/melt/quote/bolt11' && (!unit || x.unit === unit));
  app.melts = () => ctx.asked.filter((x) => x.path === '/v1/melt/bolt11');
  return app;
}

// the quote the screen holds for `unit`, or null: read without throwing, so a check fails rather than ending the suite
const fq = (app, unit) => (app.state.feeQ || {})[unit] || null;

// the circuit of the quote of `unit` that answered first, which is the one a payment on it goes by
const answeredOn = (app, unit) => {
  const got = app.quotes(unit).filter((x) => x.answered).sort((a, b) => a.answered - b.answered)[0];
  return got ? got.circuit : '';
};

// ---- a, b: the chosen balance's quote in at once, the other's eight seconds late --------------------
async function quickChosen(letter, pick) {
  const other = pick === 'sat' ? 'usd' : 'sat';
  const word = pick === 'sat' ? 'bitcoin' : 'dollars';
  const app = await phone({ fund: { sat: 5000, usd: 1000 }, send: pick });
  app.ctx.delay = (p, unit) => (p === '/v1/melt/quote/bolt11' && unit === other ? LATE : 0);
  app.open();
  const liveAt = (await until(() => app.live(), 4000)) ? app.since() : -1;
  const spec = app.spec();
  const q = app.state.feeQ && app.state.feeQ[pick];
  ok(liveAt >= 0 && liveAt < 1500 && app.state.quotingFee === false,
     letter + '. ' + word + ' chosen: PAY as soon as its own quote is in, with the other’s ' + LATE / 1000 + ' seconds away', 'live at ' + liveAt + ' ms');
  const feeWant = pick === 'sat' ? app.money(q && q.feeReserve).main : app.unitFigure(q && q.feeReserve, 'usd');
  const totalWant = pick === 'sat' ? app.money(q && q.amount + q.feeReserve).main : app.unitFigure(q && q.amount + q.feeReserve, 'usd');
  ok(!!q && app.fee() === feeWant && spec.amount === totalWant && spec.wallet.word === app.walletLabel(pick),
     letter + '. the fee and the total are the ' + word + ' quote’s, on the ' + app.walletLabel(pick) + ' button', app.fee() + ' / ' + spec.amount);
  ok((app.state.feeQ || {})[other] === null && app.feeWaits(pick) === false && app.feeWaits(other) === true,
     letter + '. the other balance’s quote is still on its way, and nothing waits on it but that balance', JSON.stringify(app.state.feeQ));
  // PAY, before the late quote lands
  spec.go();
  const paid = await until(() => app.melts().length === 1 && app._lastPay, 5000);
  const melt = app.melts()[0];
  ok(paid && app.since() < LATE && app._lastPay.unit === pick && melt && melt.circuit === answeredOn(app, pick),
     letter + '. PAY before it lands pays from ' + word + ', on the circuit the shown quote came by',
     JSON.stringify({ at: app.since(), unit: app._lastPay && app._lastPay.unit, melt: melt && melt.circuit.slice(0, 6), quote: answeredOn(app, pick).slice(0, 6) }));
  ok(app.quotes(pick).length === 1, letter + '. and the mint is not asked for that quote again', app.quotes(pick).length + ' asked');
  // the late one lands
  await until(() => app.quotes(other).some((x) => x.answered) && app.since() > LATE + 300, LATE + 3000);
  await wait(100);
  ok(app.quotes(other).some((x) => x.answered), letter + '. (the other balance’s quote did come, late)', app.since() + ' ms');
  ok((app.state.feeQ || {})[other] === null && (app._feeQuotes || {})[other] === null
     && (pick === 'usd' ? app.state.quotedFee === null && app._feeQuote === null : true),
     letter + '. landing after PAY, it is dropped: not on the screen, and not kept for a payment', JSON.stringify(app.state.feeQ));
  // its circuit went nowhere for a while: with PAY pressed, no other circuit is built for it beside the payment
  ok(app.quotes(other).length === 1, letter + '. and once PAY is pressed it is not asked again on another circuit',
     JSON.stringify(app.quotes(other).map((x) => x.at - app.quotes(other)[0].at)));
  ok(!app.log.toasts.some((m) => /chosen for you/.test(m)) && app.state.wallet === '' && !app.state.walletAuto && app.melts().length === 1,
     letter + '. nothing is switched, and nothing is paid twice', JSON.stringify(app.log.toasts) + ' ' + app.melts().length);
  ok(app.ctx.W.walletChoice().send === pick, letter + '. and the balance chosen is still the one remembered', app.ctx.W.walletChoice().send);
  // the next payment asks afresh: nothing of the last one's quotes is carried over
  app.setState({ screen: 'home', stack: [] });
  app.ctx.delay = null;
  app.open(NEXT);
  await until(() => app.live() && app._feeQuotes && 'sat' in app._feeQuotes && 'usd' in app._feeQuotes, 4000);
  ok(app.quotes(pick).length === 2 && (fq(app, pick) || {}).amount === (pick === 'sat' ? 3000 : 231) && (fq(app, other) || {}).bolt11 === NEXT,
     letter + '. the next payment\u2019s confirmation asks quotes of its own, for both balances', JSON.stringify(app.state.feeQ));
  return { letter, liveAt };
}

// ---- c: the chosen balance cannot cover it ------------------------------------------------------------
async function chosenShort() {
  const app = await phone({ fund: { sat: 5000, usd: 100 }, send: 'usd' });
  app.ctx.delay = (p, unit) => (p === '/v1/melt/quote/bolt11' && unit === 'sat' ? 1500 : 0);
  app.open();
  await until(() => app.state.feeQ && app.state.feeQ.usd, 1000);
  await wait(100);
  const held = app.spec();
  ok(fq(app, 'usd') && app.quoteFits('usd') === false && held.cta === 'CHECKING…' && held.ctaBusy,
     'c. dollars chosen and short ($ 1.00 for $ 1.56): CHECKING while the bitcoin quote is on its way', held.cta);
  const liveAt = (await until(() => app.live(), 4000)) ? app.since() : -1;
  ok(liveAt >= 1400 && app.state.wallet === 'sat' && app.state.walletAuto === true && app.log.toasts.filter((m) => m === 'Bitcoin was chosen for you').length === 1,
     'c. then switched to bitcoin, said once, when its quote is in, as before', 'live at ' + liveAt + ' ms, ' + JSON.stringify(app.log.toasts));
  ok(app.spec().wallet.word === 'BITCOIN' && app.fee() === app.money((fq(app, 'sat') || {}).feeReserve).main, 'c. PAY from bitcoin, with its fee', app.fee());
}

// ---- d: the mint gives the chosen balance no quote ---------------------------------------------------------
async function chosenFails() {
  const app = await phone({ fund: { sat: 5000, usd: 1000 }, send: 'usd' });
  app.ctx.delay = (p, unit) => (p !== '/v1/melt/quote/bolt11' ? 0 : unit === 'usd' ? 'refuse' : 1500);
  app.open();
  const liveAt = (await until(() => app.live(), 1000)) ? app.since() : -1;
  ok(liveAt >= 0 && liveAt < 1000 && (app._feeQuotes || {}).usd === null && (app._feeQuotes || {}).sat === undefined && app.spec().wallet.word === 'USD'
     && app.fee() === 'UNKNOWN',
     'd. dollars chosen and the mint gives no dollar quote: PAY on dollars at once, the fee UNKNOWN as before, the bitcoin quote not waited for',
     'live at ' + liveAt + ' ms, ' + app.spec().cta + ', ' + app.fee());
  await until(() => (app._feeQuotes || {}).sat !== undefined, 4000);
  await wait(50);
  ok((app._feeQuotes || {}).sat && app.quoteFits('sat') === true && app.state.wallet === '' && !app.state.walletAuto && !app.log.toasts.length
     && app.spec().wallet.word === 'USD' && app.live(),
     'd. the bitcoin quote lands and switches nothing, and says nothing of the dollars; WALLET offers bitcoin, which covers it',
     JSON.stringify({ wallet: app.state.wallet, auto: app.state.walletAuto, toasts: app.log.toasts }));
  app.spec().go();
  await until(() => app.log.cards.length, 4000);
  ok(app._paying && app._paying.unit === 'usd' && !app._lastPay && app.melts().length === 0 && app.log.cards.length === 1,
     'd. PAY pays from dollars, asking its own quote as it always did, and the mint’s refusal is told', JSON.stringify(app._paying) + ' ' + (app.log.cards[0] || {}).kind);
  // and the other way round: the bitcoin quote in at once, the dollar one turned down a second and a half later
  const late = await phone({ fund: { sat: 5000, usd: 1000 }, send: 'usd' });
  late.ctx.delay = (p, unit) => (p !== '/v1/melt/quote/bolt11' ? 0 : unit === 'usd' ? 'refuse:1500' : 0);
  late.open();
  await until(() => (late._feeQuotes || {}).sat, 1000);
  await wait(50);
  const held = late.spec().cta;
  const at = (await until(() => late.live(), 4000)) ? late.since() : -1;
  ok(held === 'CHECKING…' && at >= 1400 && late.spec().wallet.word === 'USD' && late.fee() === 'UNKNOWN' && late.state.wallet === '' && !late.state.walletAuto
     && !late.log.toasts.length,
     'd. the bitcoin quote in first and the dollar one refused after it: CHECKING on dollars until then, then PAY on dollars, nothing switched',
     held + ', live at ' + at + ' ms, ' + JSON.stringify({ wallet: late.state.wallet, toasts: late.log.toasts }));
}

// ---- e: one balance at the mint ---------------------------------------------------------------------------
async function oneBalance() {
  const app = await phone({ units: ['sat'], fund: { sat: 5000 } });
  let both = 0;
  const real = app.ctx.W.quoteFeeBoth;
  app.ctx.W.quoteFeeBoth = function () { both += 1; return real.apply(this, arguments); };
  app.ctx.delay = (p) => (p === '/v1/melt/quote/bolt11' ? 1000 : 0);
  app.open();
  await wait(400);
  ok(app.spec().cta === 'CHECKING…' && app.fee() === 'CHECKING…', 'e. one balance: CHECKING while its quote is out, as before', app.spec().cta);
  const liveAt = (await until(() => app.live(), 4000)) ? app.since() : -1;
  ok(liveAt >= 900 && /^SEND /.test(app.spec().cta) && /^UP TO/.test(app.fee()) && app.quotes().length === 1 && both === 0 && !app._feeQuotes,
     'e. then SEND with the fee: one quote, asked on its own', 'live at ' + liveAt + ' ms, ' + app.quotes().length + ' quote(s)');
  app.spec().go();
  await until(() => app.melts().length === 1 && app.state.sendPhase === 'settled', 4000);
  ok(app.melts().length === 1 && app.melts()[0].circuit === answeredOn(app, 'sat') && app.quotes().length === 1,
     'e. SEND pays on that quote, on its circuit, and asks for no other', app.quotes().length + ' quote(s)');
}

// ---- f: a payment from a card ------------------------------------------------------------------------------
async function fromCard() {
  const app = await phone({ fund: { sat: 5000, usd: 1000 }, send: 'usd' });
  let both = 0;
  const real = app.ctx.W.quoteFeeBoth;
  app.ctx.W.quoteFeeBoth = function () { both += 1; return real.apply(this, arguments); };
  // the card's screen sent this payment (26f-flashcard.js `fcOutMode`): a bitcoin card, whatever this phone's sends start in
  app.fcOutMode = () => true;
  app.state.fc = { unit: 'sat', balance: 4000 };
  app.ctx.delay = (p) => (p === '/v1/melt/quote/bolt11' ? 500 : 0);
  app.open();
  await wait(200);
  ok(app.state.quotingFee === true, 'f. a card’s payment: CHECKING while its one quote is out');
  await until(() => app.state.quotingFee === false, 4000);
  ok(both === 0 && app.quotes().length === 1 && app.quotes()[0].unit === 'sat' && app.state.quotedFee != null && !app._feeQuotes && !app.state.feeQ,
     'f. one quote, in what the card holds, and nothing of two balances', JSON.stringify({ both, quotes: app.quotes().map((x) => x.unit), fee: app.state.quotedFee }));
}

// ---- g: the other balance picked by hand while its quote is out ------------------------------------------------
async function pickedByHand() {
  const app = await phone({ fund: { sat: 5000, usd: 1000 }, send: 'sat' });
  app.ctx.delay = (p, unit) => (p === '/v1/melt/quote/bolt11' && unit === 'usd' ? 2000 : 0);
  app.open();
  await until(() => app.live(), 2000);
  app.openWalletPick();
  app.walletPickChoose('usd');
  await wait(50);
  ok(app.state.wallet === 'usd' && app.state.walletTapped && app.spec().cta === 'CHECKING…' && app.fee() === 'CHECKING…',
     'g. dollars picked by hand before their quote is in: CHECKING, and so is the fee', app.spec().cta);
  const liveAt = (await until(() => app.live(), 4000)) ? app.since() : -1;
  ok(liveAt >= 1900 && app.spec().wallet.word === 'USD' && app.fee() === app.unitFigure((fq(app, 'usd') || {}).feeReserve, 'usd'),
     'g. PAY from dollars once their quote is in, with their fee', 'live at ' + liveAt + ' ms, ' + app.fee());
  app.spec().go();
  await until(() => app._lastPay, 4000);
  ok(app._lastPay && app._lastPay.unit === 'usd' && (app.melts()[0] || {}).circuit === answeredOn(app, 'usd'), 'g. and it pays from dollars, on their quote’s circuit',
     JSON.stringify(app._lastPay));
}

// ---- h: back on the confirmation after a send that did not go, the other balance's quote dropped at PAY ---------------
/* `reconnecting`: the first PAY meets Tor reconnecting (RECONNECTING TO TOR, with TRY AGAIN), and TRY AGAIN is pressed
 * on that card, from the sending screen: the quote dropped at the first PAY is still the one asked again when the
 * person is back on the confirmation, though the second PAY found it already dropped. */
async function backAfterRefusal(usdCents, reconnecting) {
  const covers = usdCents >= 160;
  const tag = 'h. (' + (covers ? 'dollars cover it' : 'dollars short') + (reconnecting ? ', Tor reconnecting at the first PAY' : '') + ') ';
  const app = await phone({ fund: { sat: 5000, usd: usdCents }, send: 'sat' });
  let melts = 0;
  // the dollar quote takes two seconds every time it is asked; the first melt is refused, a later one paid
  app.ctx.delay = (p, unit) => (p === '/v1/melt/quote/bolt11' && unit === 'usd' ? 2000 : p === '/v1/melt/bolt11' && melts++ === 0 ? 'refuse' : 0);
  app.open();
  await until(() => app.live(), 2000);
  if (reconnecting) {
    // the gate's look before a melt (`startSend`): not up the first time, up after
    let looked = 0;
    app.ctx.window.FoxyGate = { recheck: () => Promise.resolve(looked++ > 0) };
    app.spec().go();
    await until(() => app.log.cards.some((c) => c.title === 'RECONNECTING TO TOR'), 2000);
    await wait(300);
    const card = app.log.cards.find((c) => c.title === 'RECONNECTING TO TOR');
    ok(!!card && app.state.screen === 'sendDone' && app.melts().length === 0 && app.quotes('usd').length === 1,
       tag + 'RECONNECTING TO TOR over the sending screen, nothing paid', JSON.stringify({ screen: app.state.screen, card: !!card }));
    if (card) card.go();
  } else {
    app.spec().go();
  }
  // the melt refused: its card over the confirmation (the RECONNECTING one before it, where there was one)
  await until(() => app.melts().length === 1 && app.state.screen === 'sendConfirm' && app.log.cards.length === (reconnecting ? 2 : 1), 4000);
  await wait(30);
  const kept = app._feeQuotes || {};
  ok(app.state.screen === 'sendConfirm' && app.quotes('usd').length === 2 && kept.usd === undefined && app.quotes('sat').length === 1
     && kept.sat && kept.sat.bolt11 === FOREIGN,
     tag + 'back on the confirmation, the dollar quote dropped at PAY is asked again, it alone; the bitcoin quote paid with is kept',
     JSON.stringify({ screen: app.state.screen, usd: app.quotes('usd').length, sat: app.quotes('sat').length }));
  if (reconnecting) return;
  app.walletPickChoose('usd');
  await wait(30);
  ok(app.spec().cta === 'CHECKING…' && app.spec().ctaBusy && app.fee() === 'CHECKING…',
     tag + 'dollars picked by hand while it is out: CHECKING, not PAY with no figure', app.spec().cta + ' / ' + app.fee());
  await until(() => fq(app, 'usd'), 4000);
  await wait(30);
  const s = app.spec();
  if (covers) {
    const uq = fq(app, 'usd') || {};
    ok(app.quoteFits('usd') === true && s.cta === 'PAY' && !s.ctaBusy && app.fee() === app.unitFigure(uq.feeReserve, 'usd')
       && s.amount === app.unitFigure(uq.amount + uq.feeReserve, 'usd'),
       tag + 'once it is in: PAY from dollars, with their fee and total', s.cta + ' ' + app.fee() + ' ' + s.amount);
    s.go();
    await until(() => app._lastPay, 4000);
    ok(app._lastPay && app._lastPay.unit === 'usd' && app.melts().length === 2 && (app.melts()[1] || {}).circuit === (app.quotes('usd')[1] || {}).circuit,
       tag + 'and PAY pays from dollars on the quote asked again, on its circuit', JSON.stringify(app._lastPay));
  } else {
    ok(app.quoteFits('usd') === false && s.cta === 'NOT ENOUGH' && app.fee() === '$ 0.02' && s.amount === '$ 1.56',
       tag + 'once it is in: NOT ENOUGH, with the dollar fee and total, and WALLET greys dollars', s.cta + ' ' + app.fee() + ' ' + s.amount);
  }
}

// ---- i: the price moved at PAY: a new question, both asked afresh and nothing more ---------------------------------
async function priceMoved() {
  const app = await phone({ fund: { sat: 5000, usd: 1000 }, send: 'usd' });
  // the bitcoin quote takes two seconds every time it is asked
  app.ctx.delay = (p, unit) => (p === '/v1/melt/quote/bolt11' && unit === 'sat' ? 2000 : 0);
  // the wallet stops the first payment before anything moves, the mint's price past the one confirmed (`pay`, e.repriced)
  const real = app.ctx.W.pay;
  let paid = 0;
  app.ctx.W.pay = function () {
    if (paid++ === 0) { const e = new Error('the price moved'); e.repriced = true; e.definite = true; return Promise.reject(e); }
    return real.apply(this, arguments);
  };
  app.open();
  await until(() => app.live(), 2000);
  app.spec().go();
  await until(() => app.log.toasts.some((m) => /price moved/.test(m)) && app.state.screen === 'sendConfirm', 2000);
  await until(() => app._feeQuotes && app._feeQuotes.sat !== undefined && app._feeQuotes.usd !== undefined, 4000);
  await wait(300);
  ok(app.quotes('usd').length === 2 && app.quotes('sat').length === 2 && fq(app, 'usd') && fq(app, 'sat') && app.live(),
     'i. the price moved at PAY: back on the confirmation both are asked afresh, once each, and the one dropped at PAY not a third time',
     JSON.stringify({ usd: app.quotes('usd').length, sat: app.quotes('sat').length }));
}

// ---- j: an address, PAY with no connection: back on the confirmation, the dropped quote asked on the address's invoice ----
async function addressNoConnection() {
  const app = await phone({ fund: { sat: 5000, usd: 1000 }, send: 'sat' });
  app.ctx.delay = (p, unit) => (p === '/v1/melt/quote/bolt11' && unit === 'usd' ? 2000 : 0);
  app.openAddress(2000);
  await until(() => app.live(), 2000);
  const W = app.ctx.W;
  const pr = (app._found || {}).pr || '';
  // the wallet has let go of its mint as PAY is pressed (`startSend`: CONNECTION LOST, nothing sent)
  const real = Object.getOwnPropertyDescriptor(W, 'connected');
  Object.defineProperty(W, 'connected', { get: () => false, configurable: true });
  app.spec().go();
  Object.defineProperty(W, 'connected', real);
  const card = app.log.cards[0];
  ok(!!card && card.kind === 'netLost' && app.state.screen === 'sendDone' && app.melts().length === 0, 'j. an address paid with no connection: CONNECTION LOST, nothing sent',
     JSON.stringify({ card: card && card.kind, screen: app.state.screen }));
  await wait(300);
  if (card) card.onClose();
  await until(() => app.quotes('usd').length === 2, 2000);
  await wait(30);
  const again = app.quotes('usd')[1];
  ok(app.state.screen === 'sendConfirm' && app.quotes('usd').length === 2 && app.quotes('sat').length === 1 && app.lookups().length === 1
     && !!pr && (app._found || {}).pr === pr && (app._feeQuotes || {}).usd === undefined,
     'j. back on the confirmation, the dollar quote is asked again on the invoice the address gave, which is kept, and the address is not asked again',
     JSON.stringify({ usd: app.quotes('usd').length, sat: app.quotes('sat').length, lookups: app.lookups().length, again: !!again }));
  app.walletPickChoose('usd');
  await wait(30);
  ok(app.spec().cta === 'CHECKING…', 'j. dollars picked by hand while it is out: CHECKING', app.spec().cta);
  const liveAt = (await until(() => app.live(), 4000)) ? app.since() : -1;
  ok(liveAt > 0 && app.fee() === app.unitFigure((fq(app, 'usd') || {}).feeReserve, 'usd') && (fq(app, 'usd') || {}).bolt11 === pr,
     'j. then PAY from dollars, with the fee quoted on the address’s invoice', app.spec().cta + ' ' + app.fee());
  app.spec().go();
  await until(() => app._lastPay, 4000);
  ok(app._lastPay && app._lastPay.unit === 'usd' && app.melts().length === 1 && app.lookups().length === 1 && app.quotes('usd').length === 2,
     'j. and PAY pays that invoice from dollars on that quote, the address and the mint asked nothing more', JSON.stringify(app._lastPay));
}

// a scenario that throws is a check that fails, and the others still report
const ran = (letter, p) => p.catch((e) => {
  ok(false, letter + '. the scenario ran to its end', String((e && e.stack) || e).split('\n').slice(0, 2).join(' '));
  return null;
});

(async () => {
  const t = Date.now();
  const timed = await Promise.all([ran('a', quickChosen('a', 'sat')), ran('b', quickChosen('b', 'usd')), ran('c', chosenShort()), ran('d', chosenFails()),
    ran('e', oneBalance()), ran('f', fromCard()), ran('g', pickedByHand()), ran('h', backAfterRefusal(100)), ran('h', backAfterRefusal(1000)),
    ran('h', backAfterRefusal(1000, true)), ran('i', priceMoved()), ran('j', addressNoConnection())]);
  lines.sort((x, y) => x.slice(6, 7).localeCompare(y.slice(6, 7))).forEach((l) => console.log(l));
  timed.filter(Boolean).forEach((x) => console.log('(' + x.letter + ': PAY live at ' + x.liveAt + ' ms; the other quote landed at about ' + LATE + ')'));
  console.log('(' + Math.round((Date.now() - t) / 1000) + ' s)');
  console.log(failed ? '\n' + failed + ' send-quote-first check(s) failed' : '\nall send-quote-first checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
