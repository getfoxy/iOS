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

console.log('\n' + (failed ? failed + ' tap-shake check(s) failed' : 'all tap-shake checks pass'));
process.exit(failed ? 1 : 0);
