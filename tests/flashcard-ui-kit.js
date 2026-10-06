'use strict';
/* flashcard-ui-kit.js — the FLASHCARD screens, made drivable.
 *
 * The screens are build/app/26f-flashcard.js over the PIN pad, the cards and
 * the stage screens (10-pin.js, 11-cards.js, 26e-loaders.js). Those four parts
 * are made into a class here and run against the real wallet, a test mint and
 * the model of the card (flashcard-kit.js), with the rest of the app class
 * stood in for. Keys are pressed on the pad and buttons on the cards; a card
 * is "tapped" by putting it where the phone's NFC stand-in finds it. */
const fs = require('fs');
const path = require('path');

const PARTS = ['10-pin.js', '11-cards.js', '26e-loaders.js', '26f-flashcard.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'build', 'app', f), 'utf8')).join('\n');

/* The four parts as a class over this page's window, and an app of it with
 * the rest of the app class stood in for: state, navigation, and the few
 * helpers the parts call. */
function appOn(ctx, start) {
  const Parts = new Function('window', 'document', 'localStorage', 'return class {\n' + PARTS + '\n};')(
    ctx.window, ctx.window.document, ctx.window.localStorage);
  const a = new Parts();
  a.state = Object.assign({ screen: 'home', stack: [], fc: null, invoice: '', invoiceIsAddress: false }, start || {});
  a.setState = (x) => { Object.assign(a.state, typeof x === 'function' ? x(a.state) : x); };
  a.forceUpdate = () => {};
  a.toasts = [];
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
  a.cfRow = (label, value, o) => ({ label, value, sub: (o && o.sub) || '', basis: (o && o.half) ? '50%' : '100%' });
  a.balNow = () => ({ sats: a.have || 0 });
  a.refreshBalance = () => ctx.W.balanceSats().then((n) => { a.have = n; });
  a.loadHistory = () => {};
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
  a.back = () => { const st = a.state.stack; a.state.screen = st.length ? st[st.length - 1] : 'home'; a.state.stack = st.slice(0, -1); };
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
const stage = (ctx) => { const el = ctx.window.document.getElementById('foxy-stage'); return el ? el.getAttribute('data-stage') : ''; };
const vals = (a) => a.renderFlashcard({ s: a.state, sc: a.state.screen });
const settle = async () => { for (let i = 0; i < 300; i++) await tick(); };
/* An amount typed on the SET AMOUNT screen, in sats, and NEXT pressed. */
const keyIn = (a, sats) => { a.state.amount = String(sats); a.state.unit = 'SATS'; a.fcAmountNext(); };


until.failed = 0;

module.exports = { appOn, tick, until, pad, card, stage, vals, settle, keyIn };
