'use strict';
/* tap-shake.js — a shake presses TAP, and nothing else (TAP-TO-PAY.md).
 *
 *     node tests/tap-shake.js
 *
 * iOS recognises the shake, the host controller tells the page `{side:'receive',
 * stage:'shake'}`. The page presses the button itself, so every rule the
 * button has applies: only on a receive screen with something to offer, only
 * when not already on the air, and never under a payer that is connecting.
 * It is armed only while that screen is up, synced like the screen lock.
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
const methods = new Function('return {' + ['tapHeard(ev) {', 'syncShake() {', 'tapArm() {'].map(method).join(',\n') + '}')();

/* A stand-in page: state, and a record of what reached the native side. */
function app(state) {
  const a = {
    state: Object.assign({ screen: 'confirm', flow: 'receive', tapArmed: false, tapShownCode: '',
                           tapRecvStage: '', tapCardOff: false }, state || {}),
    said: [], armed: 0,
    setState(o) { Object.assign(a.state, typeof o === 'function' ? o(a.state) : o); },
    tapOffering() { return a.offer !== false; },
    offer: true,
    toast() {}, haptic() {}, hideConnecting() {}, hideStage() {}, stageUp() { return false; },
    tapTalking() {}, tapBuzz() {}, waitingForPayer() {}, blockedCard() {}, stageScreen() {},
    syncTap() {},
  };
  Object.assign(a, methods);
  // the real button, counted: it sets tapArmed the way the app does
  const arm = a.tapArm;
  a.tapArm = function () { a.armed += 1; return arm.call(a); };
  global.window = { FoxyWallet: { shakeSense(on) { a.said.push(on ? 'shakeStart' : 'shakeStop'); } } };
  return a;
}
const shake = { side: 'receive', stage: 'shake' };

// ---- the shake presses TAP, once, where the button would ---------------------
{
  const a = app();
  a.tapHeard(shake);
  ok(a.armed === 1 && a.state.tapArmed === true, 'a shake on the receive screen presses TAP');
  a.tapHeard(shake);
  ok(a.armed === 1, 'a second shake while on the air does nothing', 'armed ' + a.armed + ' times');
}

// ---- and never where the button would do something else ---------------------
{
  const a = app({ tapArmed: true, tapShownCode: '4821' });
  a.tapHeard(shake);
  ok(a.armed === 0 && a.state.tapCardOff === false,
    'a shake with the code card up does not put the card away (the button would)');

  const b = app({ tapRecvStage: 'connecting' });
  b.tapHeard(shake);
  ok(b.armed === 0, 'a shake while a payer is connecting is ignored');

  const c = app({ screen: 'home' });
  c.tapHeard(shake);
  ok(c.armed === 0, 'a shake anywhere but the receive screen is ignored');

  const d = app();
  d.offer = false;
  d.tapHeard(shake);
  ok(d.armed === 0, 'a shake with nothing to offer is ignored');

  const e = app({ screen: 'confirm', flow: 'send' });
  e.tapHeard(shake);
  ok(e.armed === 0, 'a shake on a send confirmation is ignored');
}

// ---- it is armed only while that screen is up ---------------------------
{
  const a = app();
  a.syncShake();
  ok(a.said.join(',') === 'shakeStart', 'shake is armed when the receive screen is up with an offer');
  a.syncShake();
  ok(a.said.length === 1, 'and is not armed again on the next pass');
  a.state.screen = 'home';
  a.syncShake();
  ok(a.said.join(',') === 'shakeStart,shakeStop', 'and disarmed when the screen goes');
  a.state.screen = 'confirm';
  a.offer = false;
  a.syncShake();
  ok(a.said.length === 2, 'with nothing to offer it stays off');

  const b = app({ screen: 'confirm', flow: 'send' });
  b.syncShake();
  ok(b.said.length === 0, 'a send confirmation never arms it');
}

// ---- and it is synced from the same place the screen is kept awake -----------
{
  const pass = method('componentDidUpdate(prevProps, prevState) {');
  ok(/this\.syncAwake\(\);\s*this\.syncShake\(\);/.test(pass),
    'syncShake runs beside syncAwake on every update');
}

// ---- off that screen, a shake asks COPY YOUR LOGS? ------------------------------
/* The native side decides which: armed, the shake presses TAP as above; not
 * armed, the page's `_shaken` is called and the app asks. Asked, never done on
 * the shake alone, and never under the lock. */
{
  const logs = new Function('return {' + ['shakenForLogs() {', 'flTextOf(lines, view) {', 'flStamp(at) {'].map(method).join(',\n') + '}')();
  function logApp(opts) {
    const a = { _pinLocked: !!(opts && opts.locked), cards: [], copied: [], toasts: [], state: {} };
    a.blockedCard = (kind, spec) => a.cards.push(Object.assign({ kind }, spec));
    a.copySecret = (text) => { a.copied.push(text); return true; };
    a.toast = (t, bad) => a.toasts.push((bad ? '!' : '') + t);
    Object.assign(a, logs);
    const lines = opts && opts.lines !== undefined ? opts.lines
      : [{ at: 1000, text: 'first' }, { at: 2000, text: 'second' }];
    global.window = { FoxyWallet: { fieldLog(bad) { a.asked = bad; return Promise.resolve(lines); } } };
    return a;
  }
  const a = logApp();
  a.shakenForLogs();
  ok(a.cards.length === 1 && a.cards[0].kind === 'shakeLogs' && a.cards[0].title === 'COPY YOUR LOGS?'
     && a.cards[0].tone === 'ask' && a.cards[0].retry === 'COPY' && a.cards[0].shut.label === 'NOT NOW',
    'a shake off the receive screen asks COPY YOUR LOGS? with COPY and NOT NOW');
  ok(a.copied.length === 0, 'and copies nothing on the shake alone');
  a.cards[0].go();
  Promise.resolve().then(() => {
    ok(a.asked === false, 'COPY reads the whole log, not only the errors');
    ok(a.copied.length === 1 && /^Foxy log, 2 lines, newest first\./.test(a.copied[0]),
      'COPY puts the log on the clipboard with the LOGS screen’s heading', JSON.stringify(a.copied[0] && a.copied[0].slice(0, 40)));
    ok(a.copied[0].indexOf('  first\n') >= 0 && a.copied[0].indexOf('  first\n') < a.copied[0].indexOf('  second\n'),
      'the body reads oldest first, as COPY ALL does');
    ok(a.toasts.some(t => /two minutes/.test(t)), 'and says the clipboard is short-lived', a.toasts.join(' | '));

    const b = logApp({ locked: true });
    b.shakenForLogs();
    ok(b.cards.length === 0, 'under the lock a shake asks nothing');

    const c = logApp({ lines: [] });
    c.shakenForLogs();
    c.cards[0].go();
    return Promise.resolve().then(() => {
      ok(c.copied.length === 0 && c.toasts.some(t => /nothing to copy/.test(t)), 'an empty log copies nothing and says so');
    });
  }).then(() => {
    // the wiring, end to end: Swift tells the page, the bridge tells the app, the app asks
    const swift = fs.readFileSync(path.join(__dirname, '..', 'Foxy', 'Bridge', 'FoxyBridge+Tap.swift'), 'utf8');
    const shaken = swift.slice(swift.indexOf('func shaken()'), swift.indexOf('func stopTap()'));
    ok(/guard shakeArmed else \{[^}]*FoxyWallet\._shaken\(\)/s.test(shaken), 'Swift: a shake while not armed calls the page’s _shaken');
    ok(/pushTap\(side: "receive", stage: \.shake/.test(shaken), 'Swift: a shake while armed still presses TAP');
    const wallet = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
    ok(/onShaken: function \(fn\)/.test(wallet) && /_shaken: function \(\)/.test(wallet), 'the bridge has onShaken and _shaken');
    ok(/W\.onShaken\(\(\) => this\.shakenForLogs\(\)\)/.test(src), 'the app listens with shakenForLogs at boot');
    console.log('\n' + (failed ? failed + ' tap-shake check(s) failed' : 'all tap-shake checks pass'));
    process.exit(failed ? 1 : 0);
  });
}
// the verdict and the exit come at the end of the chain above: COPY reads the log through a promise
