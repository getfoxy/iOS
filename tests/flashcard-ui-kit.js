'use strict';
/* flashcard-ui-kit.js — the FLASHCARD screens, made drivable.
 *
 * The screens are build/app/26f-flashcard.js (and the screen behind the card
 * sheet, 26h-tap-screen.js) over the PIN pad, the cards and the stage screens
 * (10-pin.js, 11-cards.js, 26e-loaders.js). Those parts
 * are made into a class here and run against the real wallet, a test mint and
 * the model of the card (flashcard-kit.js), with the rest of the app class
 * stood in for. Keys are pressed on the pad and buttons on the cards; a card
 * is "tapped" by putting it where the phone's NFC stand-in finds it.
 *
 * `appOn(ctx, start, { split: true })` adds the split bill's own parts (17-split-bill-and-copy.js, 20-split-values.js), for
 * the suites that press CARD on a payer's share: the bill's invoices, its ledger, and the screens that tick a share are then
 * the app's own, and what the screen draws for a share is `splitVals`'.
 *
 * `appOn(ctx, start, { send: true })` adds the app's own SEND MONEY flow, lifted out of its files by each method's first line:
 * the send screen's values (`renderSend`), what a scan or a paste is taken as (`acceptTarget`), the confirmation
 * (`confirmSpec`, the fee asked of the mint, `quoteSendFee`), the payment itself (`startSend`, `startSendNow`), the keypad's
 * ceiling (`renderContext`) and the camera (`syncPreview`), for the suites that pay from a card (tests/flashcard-send.js).
 *
 * The send flow carries the phone's own on-chain screens with it (26b-onchain.js, whole): a bitcoin address read in card
 * mode is paid on chain from the card where the mint does that (tests/flashcard-onchain.js). `{ send: true, money: true }`
 * also has the app's own `money` (03-send.js: dollars first, the sats under them) in place of the suites' sats-only one.
 *
 * `appOn(ctx, start, { send: true, receive: true })` adds a receive into the dollar balance as well (12-receive.js: its
 * invoice, the watch that lands it and the code's minute; 24-render-receive-and-send.js: the receive screen's values), for
 * the suite that pays a dollar invoice with a card (tests/flashcard-usd-receive.js). */
const fs = require('fs');
const path = require('path');

const read = (files) => files.map((f) => fs.readFileSync(path.join(__dirname, '..', 'build', 'app', f), 'utf8')).join('\n');
const PARTS = read(['10-pin.js', '11-cards.js', '26e-loaders.js', '26f-flashcard.js', '26g-tap-limit-explainer.js', '26h-tap-screen.js', '26j-card-wheel.js']);
const SPLIT_PARTS = read(['17-split-bill-and-copy.js', '20-split-values.js']);
/* One of the app's methods, out of the text of its file, by its first line: from there to the brace that closes it. */
const liftFrom = (src, sig) => {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('flashcard-ui-kit: no method ' + sig);
  let i = src.indexOf('{', at + 3 + sig.length - 1), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 3, i + 1);
};
const SEND_SIGS = {
  '01-ui-basics.js': ['confirmSpec() {', 'cfRow(label, value, opt) {', 'sendToText() {', 'sendAmountText() {',
                      // a mint with two balances: the confirmation's own for it, and what decides which balance pays
                      'twoUnitsOn() {', 'cardSendNow() {', 'walletChoiceNow() {', 'walletNow(flow) {', 'homePills() {',
                      'unitWord(unit) {', 'walletLabel(unit) {', 'unitFigure(amount, unit) {', 'unitBalance(unit) {', 'syncWalletAsk() {',
                      'openWalletPick() {', 'autoWallet(fits) {', 'quoteFits(unit) {', 'confirmTwoSpec() {',
                      // the dollar keypad's cents, exactly: a dollar card's own amounts are typed on it (26f-flashcard.js, `fcTyped`)
                      'centsTyped() {'],
  // whether the keypad types a dollar balance's own amount, which a dollar card's flows do
  '23-render-home-and-amount.js': ['usdKeypad() {'],
  '03-send.js': ['shortId(v) {', 'typedSats() {', 'sendSatsNow() {', 'sendAsk() {', 'sendToAsk() {', 'quoteSendFee() {', 'feeQuotesIn(both) {',
                 'feeQuoteIn(unit, q) {', 'feeWaits(unit) {', 'feeQuotesLeft() {', 'feeQuotesAgain() {', 'syncSend() {',
                 'notOnlineCard() {', 'toConfirm() {', 'toAmount() {', 'startSend() {', 'showPayPending() {', 'checkSendPrice() {', 'startSendNow(to, o) {'],
  '12-receive.js': ['acceptTarget(text) {', 'offlineInvoiceCard() {'],
  '15-paid-wake-keyboard.js': ['syncPreview() {', 'pasteUncovered(el, box) {'],
  '21-render-values.js': ['renderContext() {'],
  '24-render-receive-and-send.js': ['renderSend(c) {'],
};
const SEND_PARTS = Object.keys(SEND_SIGS).map((f) => SEND_SIGS[f].map((sig) => liftFrom(read([f]), sig)).join('\n')).join('\n')
  // the phone's own on-chain screens, which a card in card mode pays a bitcoin address through
  + '\n' + read(['26b-onchain.js']);
const MONEY_PARTS = liftFrom(read(['03-send.js']), 'money(sats, fiatCents) {');
// the two-way pill's halves, history's DOLLARS | BITCOIN
const SEG_PART = liftFrom(read(['26-render-history-and-contacts.js']), 'segLook(on, look) {');
const RECEIVE_SIGS = {
  '12-receive.js': ['wantedAmount() {', 'stopReceive() {', 'openUsdReceive(cents) {', 'usdInvoiceUp(inv, mine) {', 'recvClockTick(mine) {', 'recvRequote(mine) {'],
  '24-render-receive-and-send.js': ['renderReceive(c) {'],
};
const RECEIVE_PARTS = Object.keys(RECEIVE_SIGS).map((f) => RECEIVE_SIGS[f].map((sig) => liftFrom(read([f]), sig)).join('\n')).join('\n');

/* The parts as a class over this page's window, and an app of it with
 * the rest of the app class stood in for: state, navigation, and the few
 * helpers the parts call. */
function appOn(ctx, start, o) {
  const body = PARTS + '\n' + SEG_PART + ((o && o.split) ? '\n' + SPLIT_PARTS : '') + ((o && o.send) ? '\n' + SEND_PARTS : '')
    + ((o && o.receive) ? '\n' + RECEIVE_PARTS : '') + ((o && o.money) ? '\n' + MONEY_PARTS : '');
  // (the split values keep a React ref in a field of the class: nothing here draws with it)
  const Parts = new Function('window', 'document', 'localStorage', 'React', 'navigator', 'CTA_INK', 'return class {\n' + body + '\n};')(
    ctx.window, ctx.window.document, ctx.window.localStorage, { createRef: () => ({ current: null }) }, ctx.window.navigator, () => '#fff');
  const a = new Parts();
  a.state = Object.assign({ screen: 'home', stack: [], fc: null, invoice: '', invoiceIsAddress: false }, start || {});
  a.setState = (x) => { Object.assign(a.state, typeof x === 'function' ? x(a.state) : x); };
  a.forceUpdate = () => {};
  a.toasts = [];
  // the sheet at once in the suites: the half-second the screen is shown before it on a phone is checked on its own
  a.FC_TAP_LEAD = 0;
  // REMOVE keeps its place behind the sheet, whatever a busy machine does to a payment's timing, unless a test is about the clock that gives way to CHECKING (26h-tap-screen.js)
  a.FC_TAP_REMOVE_MS = 3600 * 1000;
  a.seen = {};
  a.toast = (m) => a.toasts.push(m);
  a.group = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  a.haptic = () => {};
  a.px = () => a.price || 0;
  a.usd = (v) => v.toFixed(2);
  a.BLOCKED_INFO = () => null;
  a.offlineNow = () => !!a.offline;
  a.offlineNo = (what) => a.toasts.push(what + ' needs a connection.');
  // as the app's own (01-ui-basics.js): the one way into the mint list, clearing what it was asking before
  a.goSwitchMint = (extra) => a.setState((p) => Object.assign({
    screen: 'switchMint', stack: p.stack.concat([p.screen]), trStep: '', trFrom: '', trTo: '', fcPick: false,
  }, extra || {}));
  // a mint by its address, so two can be told apart
  a.mintNameOf = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  a.mintName = () => a.mintNameOf(ctx.W.mintUrl);
  a.refuseSwitchWhileBusy = () => false;
  a.hushMove = (plan) => { ['mintQuote', 'meltQuote'].forEach((k) => { if (plan && plan[k] && plan[k].quote) a.seen[plan[k].quote] = true; }); };
  // as the app's own: every entry written since `_sweepBefore` was taken is marked seen (07-history-tokens-mints.js)
  a.hushSweepEntries = () => {
    const before = a._sweepBefore;
    a._sweepBefore = null;
    return ctx.W.transactions(50).then((list) => { list.forEach((x) => { if (!(before && before.has(x.hash))) a.seen[x.hash] = true; }); });
  };
  a.melts = [];
  a.showMelt = (label) => { a.melts.push(label); a.melting = true; };
  a.hideMelt = () => { a.melting = false; };
  a.money = (sats) => ({ main: '\u20bf ' + a.group(sats), sub: '' });
  // as the app's own (09-melt-paste-switch.js)
  a.agoWords = (ms) => {
    const n = Number(ms) || 0;
    if (n < 90 * 1000) return 'a moment ago';
    const mins = Math.floor(n / 60000);
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
    const days = Math.floor(hours / 24);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  };
  a.cfRow = (label, value, o) => ({ label, value, sub: (o && o.sub) || '', basis: (o && o.half) ? '50%' : '100%' });
  a.balNow = () => ({ sats: a.have || 0 });
  a.refreshBalance = () => ctx.W.balanceSats().then((n) => { a.have = n; });
  a.loadHistory = () => {};
  // the queue of confirmations is the app's own (15-paid-wake-keyboard.js), and a card flow's end lets it move on: a suite that is about it lifts the real one (`withConfirmations`, flashcard-screens.js)
  a.nextPaidScreen = () => {};
  a.queueLater = () => {};
  a.closeReceive = () => { a.state.screen = 'home'; };
  a.noteReceived = () => {};
  a.txIsNew = (h) => { const fresh = !a.seen[h]; a.seen[h] = true; return fresh; };
  // the SET AMOUNT screen's own sum (12-receive.js), for the card's amounts; the till's is the invoice's
  a.wantedSats = () => {
    if (a.state.screen !== 'amount' || !/^card/.test(String(a.state.flow))) return a.asking || 0;
    const val = parseFloat(a.state.amount) || 0;
    if (a.state.unit === 'SATS') return Math.round(val);
    return a.px() ? Math.round(val / a.px() * 1e8) : 0;
  };
  // as the app's own (01-ui-basics.js): a card's set-up asking an amount goes back to its question; back off the card's screen leaves the card behind
  a.back = () => {
    if (a.fcSuAmountBack && a.fcSuAmountBack()) return;
    const st = a.state.stack;
    if (a.state.screen === 'flashcard' && (st.length ? st[st.length - 1] : 'home') !== 'flashcard' && st.slice(0, -1).indexOf('flashcard') < 0) a._fcCard = null;
    a.state.screen = st.length ? st[st.length - 1] : 'home'; a.state.stack = st.slice(0, -1);
  };
  if (o && o.send) {
    // the app's own row, and not the short one above: the confirmation's rows are read as the app makes them
    delete a.cfRow;
    // the keypad's amount, for a payment typed on it (the app's own reads the same figure, 12-receive.js)
    const cardWanted = a.wantedSats;
    a.wantedSats = () => {
      if (a.state.flow === 'send') {
        const val = parseFloat(a.state.amount) || 0;
        if (a.state.unit === 'SATS') return Math.round(val);
        return a.px() ? Math.round(val / a.px() * 1e8) : 0;
      }
      return cardWanted();
    };
    a.connecting = () => !!a.comingRoute;
    a.heldBlocks = () => '';
    a.satUsd = () => (a.px() || 0) / 1e8;
    // (the app's own refreshes the screen; here the figures are asked for when a test wants them)
    a.balNow = () => ({ sats: a.have || 0 });
    // the progress overlay over the sending screen, and the burst at its end, are the page's: none here
    a.settleAnimate = () => {};
    a.editSendNote = () => {};
    // the on-chain screens' own helpers that are the app's elsewhere: what was announced, the speed sheet, the keypad's sats
    a.announced = [];
    a.announcePayment = (ev) => a.announced.push(ev);
    a.chooseFrom = (title, rows) => { a.chose = { title, rows }; };
    a.meltSays = (label) => a.melts.push(label);
    a.amountInSats = () => {
      const val = parseFloat(a.state.amount) || 0;
      if (a.state.unit === 'SATS') return Math.round(val);
      return a.px() ? Math.round(val / a.px() * 1e8) : 0;
    };
  }
  // the app's own money, dollars first with the sats under them, in place of the stand-in
  if (o && o.money) delete a.money;
  return a;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/* Wait for something to be true of the screen, a few thousand turns at most. */
async function until(what, cond) {
  for (let i = 0; i < 6000; i++) { if (cond()) return true; await tick(); }
  console.log('FAIL  waited for: ' + what);
  process.exitCode = 1;
  until.failed += 1;
  return false;
}
const leaves = (root) => Array.from(root.querySelectorAll('div')).filter((d) => d.childElementCount === 0);
const click = (el) => el.dispatchEvent(new (el.ownerDocument.defaultView.Event)('click', { bubbles: true }));

/* The pad that is up: its title, its subtitle, its red line, and its keys. */
function pad(a) {
  const root = a._pinEl;
  if (!root || !root.parentNode) return null;
  const kids = Array.from(root.children);
  const find = (text) => leaves(root).filter((d) => d.textContent === text)[0];
  return {
    title: kids[0].textContent, sub: kids[1].textContent, note: kids[3].textContent, figure: kids[2].textContent,
    // what its button says, and whether it can be pressed yet
    cta: root.querySelector('[data-pin-cta]').textContent,
    ready: root.querySelector('[data-pin-cta]').getAttribute('data-pin-ready') === '1',
    hasCancel: !!find('CANCEL'),
    type(digits) {
      String(digits).split('').forEach((d) => click(find(d).parentNode));
      click(root.querySelector('[data-pin-cta]'));
    },
    back() { click(root.querySelector('[data-pin-back]')); },
    press(label) { click(find(label)); },
    has(label) { return !!find(label); },
  };
}
/* The card that is up: its title, its words, and its buttons by their label. */
function card(a) {
  const root = a._blockedEl;
  if (!root || !root.parentNode) return null;
  // past the glow and the mark in the circle (! or \u00d7; the asking card's is a drawing)
  const texts = leaves(root).map((d) => d.textContent).filter((t) => t && t !== '!' && t !== '\u00d7');
  return {
    title: texts[0], reason: texts[1], all: texts.join(' | '),
    press(label) { click(leaves(root).filter((d) => d.textContent === label)[0]); },
    has(label) { return texts.indexOf(label) >= 0; },
  };
}
/* HOW TAP LIMIT WORKS (build/app/26g-tap-limit-explainer.js): its title and every line on it, whether it has played out
 * (`done`), `finish()` to end the playing, and its buttons, which do nothing until it has. */
function explainer(a) {
  const x = a._fcExplainer;
  if (!x || !x.root || !x.root.parentNode) return null;
  const texts = leaves(x.root).map((d) => d.textContent).filter((t) => t);
  return {
    title: texts[0], all: texts.join(' | '), done: x.done(),
    finish() { x.finish(); },
    press(label) { click(leaves(x.root).filter((d) => d.textContent === label)[0]); },
    has(label) { return texts.indexOf(label) >= 0; },
  };
}
/* The screen behind the card sheet (build/app/26h-tap-screen.js), as a person sees it: which of its states, on which ground,
 * what it says, whether the card moves, whether CANCEL shows, and the design the card is drawn in. Null when it is not up. */
const behind = (ctx) => {
  const up = ctx.window.document.getElementById('foxy-stage');
  if (!up || up.getAttribute('data-stage') !== 'card' || !up.getAttribute('data-look')) return null;
  const q = (sel) => up.querySelector(sel);
  const btn = q('[data-stage-button]');
  const fur = q('[data-tap-fur]');
  return {
    look: up.getAttribute('data-look'), scheme: up.getAttribute('data-scheme'),
    title: q('h1').textContent, amount: q('[data-tap-amount]').textContent,
    loop: up.getAttribute('data-loop') === '1', cancel: !!btn && btn.style.visibility === 'visible',
    design: q('[data-card-design]').getAttribute('data-card-design'), fur: fur ? fur.style.opacity : '',
    cardMoves: q('[data-tap-card]').style.animation !== 'none',
  };
};
/* Every state the screen goes through on `app` (a state is recorded when it differs from the one before), until `.stop()`. */
const watchBehind = (app, ctx) => {
  const seen = /** @type {any[]} */ ([]);
  const draw = app.fcTapDraw.bind(app);
  app.fcTapDraw = () => {
    draw();
    const b = behind(ctx);
    // `at`: how many lines the sheet had shown when this state came up
    if (b && (!seen.length || seen[seen.length - 1].look !== b.look)) seen.push(Object.assign({ at: ctx.sheet.length }, b));
  };
  seen.stop = () => { app.fcTapDraw = draw; };
  seen.path = () => seen.map((x) => x.look).join(' > ');
  seen.titles = () => seen.map((x) => x.title).join(' > ');
  return seen;
};
const stage = (ctx) => { const el = ctx.window.document.getElementById('foxy-stage'); return el ? el.getAttribute('data-stage') : ''; };
const vals = (a) => a.renderFlashcard({ s: a.state, sc: a.state.screen });
const settle = async () => { for (let i = 0; i < 300; i++) await tick(); };
/* An amount typed on the SET AMOUNT screen, in sats, and NEXT pressed. */
const keyIn = (a, sats) => { a.state.amount = String(sats); a.state.unit = 'SATS'; a.fcAmountNext(); };

/* The card screens of the owner's designs (26j-card-wheel.js, `renderCardScreens`), as a person sees them; each null when it is not up.
 *   welcome   WELCOME TO YOUR CASHU CARD: its line, and SET UP CARD, RESTORE LOST CARD and CANCEL by their labels;
 *   limits    CARD LIMITS: its rows ("LABEL | sub | value | unit"), and a row pressed by its label, or CLOSE;
 *   speed     MAX SPEND PER SECOND: the figure, the chips and the one chosen, a chip picked by its dollars, NEXT, the figure, back. */
const screens = (a) => a.renderCardScreens({ s: a.state, sc: a.state.screen });
function welcome(a) {
  const v = screens(a);
  if (!v.isFcPanel || !v.fpWelcome) return null;
  const go = { 'SET UP CARD': v.fpSetUp, 'RESTORE LOST CARD': v.fpRestore, CANCEL: v.fpCancel };
  return { line: v.fpLine, design: v.fpDesign, buttons: Object.keys(go).join(), press(label) { go[label](); } };
}
function limits(a) {
  const v = screens(a);
  if (!v.isFcPanel || !v.fpLimits) return null;
  return {
    rows: v.fpRows.map((r) => [r.label, r.sub, r.value, r.unit].join(' | ')),
    labels: v.fpRows.map((r) => r.label).join(),
    press(label) { if (label === 'CLOSE') { v.fpBack(); return; } v.fpRows.filter((r) => r.label === label)[0].tap(); },
  };
}
function speed(a) {
  const v = screens(a);
  if (!v.isFcSpeed) return null;
  return {
    figure: v.fsFigure, chips: v.fsChips.map((k) => k.label).join(), chosen: v.fsChips.filter((k) => k.bg === 'var(--acc)').map((k) => k.label).join(),
    mode: a.state.fcSpeed && a.state.fcSpeed.mode,
    pick(r) { v.fsChips.filter((k) => k.label === '$' + r)[0].tap(); return speed(a); },
    next() { v.fsNext(); }, other() { v.fsOther(); }, back() { v.fsBack(); },
  };
}

until.failed = 0;

module.exports = { appOn, tick, until, pad, card, explainer, stage, behind, watchBehind, vals, settle, keyIn, welcome, limits, speed };
