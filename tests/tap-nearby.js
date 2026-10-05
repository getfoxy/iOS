'use strict';
/* tap-nearby.js — a receiver close by puts TAP TO PAY on the payer's screen.
 *
 *     node tests/tap-nearby.js
 *
 * The native payer says `{side:'pay', stage:'nearby'}` about once a second
 * while a receiver reads -60 dBm or stronger without being close enough to
 * link. The page shows the tall toast only while it is listening from home or
 * SEND, keeps it up while the stage is renewed, and takes it down on `far`,
 * on `connecting`, and when the listen ends.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  return block(at + 3);
}
const methods = new Function('return {' + ['tapHeard(ev) {', 'ctpParts(edge, withX) {', 'showTapNearby(edge) {', 'hideTapNearby() {', 'showConnectRecv(edge) {', 'hideConnectRecv() {', 'syncConnectRecv() {', 'tapDropPayer() {'].map(method).join(',\n') + '}')();

/* A page with a body and, sometimes, the balance pill. */
function dom(pillBottom) {
  const nodes = {};
  const el = (id) => ({
    id, style: {}, innerHTML: '', parentNode: null, on: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(kind, fn) { this.on[kind] = fn; },
    appendChild(c) { c.parentNode = this; nodes[c.id] = c; },
    removeChild(c) { c.parentNode = null; delete nodes[c.id]; },
  });
  const body = el('body');
  global.document = {
    body,
    getElementById: (id) => nodes[id] || null,
    createElement: () => { const e = el(''); return e; },
    querySelector: (q) => (q === '[data-foxy-delta-pill]' && pillBottom
      ? { getBoundingClientRect: () => ({ bottom: pillBottom }) } : null),
  };
  return { nodes, up: () => !!nodes['foxy-tap-nearby'], height: () => (nodes['foxy-tap-nearby'] || {}).style.height };
}
function app(state, paying) {
  const a = {
    state: Object.assign({ screen: 'home', tapStage: 'searching' }, state || {}),
    _tapPaying: paying === false ? null : {},
    setState(o) { Object.assign(a.state, typeof o === 'function' ? o(a.state) : o); },
    toast() {}, haptic() {}, hideConnecting() {}, hideStage() {}, stageUp() { return false; },
    tapBuzz() {}, showConnecting() {}, stageScreen() {}, syncTap() {}, back() {},
    tapOffering() { return true; },
    hidden: 0, hideConnecting() { a.hidden += 1; },
  };
  Object.assign(a, methods);
  return a;
}
const near = { side: 'pay', stage: 'nearby' };

// ---- shown while listening, sized to the pill ------------------------------
{
  const d = dom(236);
  const a = app();
  a.tapHeard(near);
  ok(d.up(), 'a receiver close by puts the toast up');
  ok(d.height() === '236px', 'the toast reaches the bottom of the balance pill', d.height());
  a.tapHeard(near);
  ok(d.up() && Object.keys(d.nodes).length === 1, 'a renewed nearby keeps the one toast');
  a.tapHeard({ side: 'pay', stage: 'far' });
  ok(!d.up(), 'the receiver fading takes it down');
}
{
  const d = dom(0);
  const a = app();
  a.tapHeard(near);
  ok(d.height() === '220px', 'with no pill on the screen it takes a fixed height', d.height());
  a.tapHeard({ side: 'pay', stage: 'connecting' });
  ok(!d.up(), 'contact takes it down: the connecting screen is what shows now');
}

// ---- it is not a button: the touch is the only way in -----------
{
  const d = dom(236);
  const a = app();
  let asked = 0;
  global.window = { FoxyWallet: { tapPayNow() { asked += 1; return Promise.resolve('ok'); } } };
  a.tapHeard(near);
  const sheet = d.nodes['foxy-tap-nearby'];
  ok(typeof sheet.on.click !== 'function' && asked === 0, 'the sheet takes no press, so nothing is connected without touching');
  a.hideTapNearby();
  global.window = { FoxyWallet: {} };
}

// ---- and not when the phone is not listening --------------------------------
{
  const d = dom(236);
  const a = app({}, false);
  a.tapHeard(near);
  ok(!d.up(), 'no toast when the payer is not listening');
  const b = app({ tapStage: 'linked' });
  b.tapHeard(near);
  ok(!d.up(), 'no toast once a link is up');
}
{
  const d = dom(236);
  const a = app();
  a.tapHeard(near);
  a.hideTapNearby();
  ok(!d.up(), 'hideTapNearby takes it down, which the end of the listen calls');
}

// ---- the receiver's `off` does not outlive the radio being off ----------------
{
  const a = app({ screen: 'confirm', tapRecvStage: 'off' });
  a.tapHeard({ side: 'receive', stage: 'searching' });
  ok(a.state.tapRecvStage === '', 'the radio coming back on (the receiver goes on the air) clears off');
  const b = app({ screen: 'confirm', tapRecvStage: 'off' });
  b.tapHeard({ side: 'receive', stage: 'connecting' });
  ok(b.state.tapRecvStage === 'off', 'and nothing else does by accident');
}

// ---- the phone it was connecting to going away takes the screen down ------
{
  const a = app();
  a._tapHeldUntil = Date.now() + 12000;
  a.tapHeard({ side: 'pay', stage: 'gone' });
  ok(a.hidden === 1 && a._tapHeldUntil === 0, 'gone on the pay side hides CONNECTING and drops the hold');
}

// ---- the payer's sheet has no X: a press anywhere on it connects --------------
{
  const d = dom(236);
  const a = app();
  global.window = { FoxyWallet: {}, innerHeight: 800 };
  a.tapHeard(near);
  ok(!/data-ctp-x/.test(d.nodes['foxy-tap-nearby'].innerHTML), 'the payer\'s sheet carries no X');
  ok(/left:-70px/.test(d.nodes['foxy-tap-nearby'].innerHTML), 'and its mark is on the left edge when no edge is named');
  // the edge comes with the event, and a new one redraws the sheet
  a.tapHeard({ side: 'pay', stage: 'nearby', edge: 'right' });
  ok(/right:-70px/.test(d.nodes['foxy-tap-nearby'].innerHTML), 'named right, the mark moves to the right edge');
  a.tapHeard({ side: 'pay', stage: 'nearby', edge: 'left' });
  ok(/left:-70px/.test(d.nodes['foxy-tap-nearby'].innerHTML), 'and back to the left');
  a.hideTapNearby();
}

// ---- the receiver shows the same card while a payer says it is near -------
{
  const d = dom(0);
  global.window = { FoxyWallet: {}, innerHeight: 800 };
  const a = app({ screen: 'confirm', flow: 'receive', tapShownCode: '', tapRecvStage: '' });
  a.tapHeard({ side: 'receive', stage: 'nearby' });
  ok(!!d.nodes['foxy-connect-recv'], 'a payer saying it is near puts CONNECT TO PAY over the code');
  ok(/right:-70px/.test(d.nodes['foxy-connect-recv'].innerHTML) && /left:16px/.test(d.nodes['foxy-connect-recv'].innerHTML),
     'with the mark on the right and its X on the left when no edge is named');
  a.tapHeard({ side: 'receive', stage: 'nearby', edge: 'left' });
  ok(/left:-70px/.test(d.nodes['foxy-connect-recv'].innerHTML) && /right:16px/.test(d.nodes['foxy-connect-recv'].innerHTML),
     'the payer naming the left door puts the mark on the left and the X on the right');
  ok(/data-ctp-x/.test(d.nodes['foxy-connect-recv'].innerHTML), 'and an X, which the receiver keeps');
  a.tapHeard({ side: 'receive', stage: 'far' });
  ok(!!d.nodes['foxy-connect-recv'], 'a payer going far does not take it down at once: it may be back in a second');
  a.tapHeard({ side: 'receive', stage: 'nearby' });
  ok(!!d.nodes['foxy-connect-recv'], 'and one that comes back keeps it up');
  // the wait, run by hand rather than slept through
  const realTimeout = global.setTimeout;
  let gone = null;
  global.setTimeout = (fn) => { gone = fn; return 1; };
  a.tapHeard({ side: 'receive', stage: 'far' });
  global.setTimeout = realTimeout;
  if (gone) gone();
  ok(!d.nodes['foxy-connect-recv'], 'while one that stays away gives the code back');
  a.tapHeard({ side: 'receive', stage: 'nearby' });
  a.tapHeard({ side: 'receive', stage: 'connecting' });
  ok(!d.nodes['foxy-connect-recv'], 'as does the handshake starting');
  const b = app({ screen: 'confirm', flow: 'receive', tapShownCode: '4821' });
  b.tapHeard({ side: 'receive', stage: 'nearby' });
  ok(!d.nodes['foxy-connect-recv'], 'and it does not cover a code that is already up');
  // said on the amount screen, it waits for the invoice screen
  const c = app({ screen: 'amount', flow: 'receive', tapShownCode: '' });
  c.tapHeard({ side: 'receive', stage: 'nearby', edge: 'right' });
  ok(!d.nodes['foxy-connect-recv'], 'a payer near while the amount is typed draws nothing: there is no code to cover');
  c.state.screen = 'confirm';
  c.syncConnectRecv();
  ok(!!d.nodes['foxy-connect-recv'], 'and the card is there when the invoice screen is');
  c.hideConnectRecv();
  // the phone lying top-down: the page is turned, so the mark swaps sides
  const e = app({ screen: 'confirm', flow: 'receive', tapShownCode: '' });
  e._flipOn = true;
  e.tapHeard({ side: 'receive', stage: 'nearby', edge: 'right' });
  ok(/left:-70px/.test(d.nodes['foxy-connect-recv'].innerHTML),
     'turned top-down, the phone\'s right edge is the page\'s left, and the mark goes there');
  e.hideConnectRecv();
  global.window = { FoxyWallet: {} };
}

// ---- the X on the code card lets that phone go ------------------------------
{
  let stops = 0;
  const W = { tapReceiveStop() { stops += 1; } };
  global.window = { FoxyWallet: W };
  const a = app({ screen: 'confirm', tapShownCode: '4821', tapArmed: true, tapRecvStage: '' });
  a._tapOffer = '{"req":"x"}';
  a.tapDropPayer();
  ok(stops === 1 && a.state.tapShownCode === '' && a.state.tapArmed === false && a._tapOffer === null,
     'X with a code up and nothing crossing drops that phone and clears the screen to arm afresh',
     JSON.stringify({ stops, code: a.state.tapShownCode, armed: a.state.tapArmed }));

  const b = app({ screen: 'confirm', tapShownCode: '4821', tapArmed: true });
  b._tapPaidHere = true;
  b.tapDropPayer();
  ok(stops === 1 && b.state.tapShownCode === '4821' && b.state.tapCardOff === true,
     'with a payment crossing, X only puts the card away');

  const c = app({ screen: 'confirm', tapShownCode: '4821', tapArmed: true });
  c._tapTalking = true;
  c.tapDropPayer();
  ok(stops === 1 && c.state.tapShownCode === '4821', 'and the same while a price is being agreed');

  const d2 = app({ screen: 'confirm', tapShownCode: '', tapArmed: true });
  d2.tapDropPayer();
  ok(stops === 1 && d2.state.tapCardOff === true, 'with no code up it is only the card going away');
  global.window = { FoxyWallet: {} };
}

console.log(failed ? failed + ' tap-nearby check(s) failed' : '\nall tap-nearby checks pass');
process.exit(failed ? 1 : 0);
