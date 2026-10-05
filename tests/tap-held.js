'use strict';
/* tap-held.js — what a screen change tears down, and what a live tap forbids.
 *
 *     node tests/tap-held.js
 *
 * A tap is a Bluetooth link held open between two phones. While it is open the
 * payer is waiting — for a price to be agreed, or a fee — and everything the
 * receiver needs in order to answer has to still be there when it does.
 *
 * Five separate passes run on every state change and each reads `screen` to
 * decide whether the person has left (componentDidUpdate, 19-update-keypad-
 * balance.js): the Bluetooth radio, the onion inbox, the screen-awake lock, the
 * camera and the claim sweep. Four of them were written when every decision was
 * a card — and a card floats over the screen, so `screen` never changed and
 * none of them ever fired mid-tap.
 *
 * Turning the price and the crossing into confirmation SCREENS changed that.
 * `syncTap` retired the receiver, so an ACCEPT reached the payer as silence;
 * `syncAwake` let the phone sleep, which drops the link on its own. Both shipped
 * green, because every suite stubbed the piece that broke: the price tests stub
 * the screen, and the tap tests hand `syncTap` state by hand and never gave it
 * one of the new screens.
 *
 * So this asks the question from the other end. For each pass, and for each
 * screen a live tap can be sitting on, it holds the rule: a tap being talked
 * about is a tap still in progress, and nothing may be torn down under it.
 */
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};

function method(sig) {
  const at = app.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = app.indexOf('{', at), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) break; }
  }
  return app.slice(at + 3, i + 1);
}

/* Every screen a tap can be live on. The two confirmations are the ones this
 * is about; the receive screens are here so a pass that stops firing entirely
 * is caught too. */
const LIVE = ['confirm', 'priceConfirm', 'crossConfirm'];
/* And what actually holds everything open: a decision put to a person with a
 * payer waiting. Keying this on the screen lost the race — `priceAnswer`
 * navigates home and *then* sends the answer, so the update that matters
 * arrives with `screen` already 'home'. `_tapTalking` spans both. */
const TALKING = { _tapTalking: true };

// ---- 1. the Bluetooth radio ------------------------------------------------
{
  const M = new Function('CONFIRM_SCREENS', 'return {' + method('syncTap() {') + '}');
  const run = (screen, talking) => {
    const stopped = [];
    const a = Object.assign(M(['depConfirm', 'sendConfirm', 'reqOffer', 'trConfirm', 'ocConfirm',
                               'priceConfirm', 'crossConfirm']), {
      state: { screen: screen, flow: 'receive', recvRail: 'CASHU', invoice: 'lnbc1',
               tapArmed: true, tapShownCode: '4821' },
      _tapTalking: talking,
      setState() {}, tapOffering: () => null, haptic() {}, tapBuzz() {},
      railRequest: () => '', railRequestPending: () => false, offlineNow: () => true,
      showConnecting() {}, hideConnecting() {},
    });
    a._tapOffer = 'receive {"v":2}';
    global.window = { FoxyWallet: {
      mintUrl: 'https://m.test',
      tapReceive: () => Promise.resolve(''),
      tapReceiveStop: () => { stopped.push('radio'); return Promise.resolve(''); },
    } };
    try { a.syncTap(); } catch (e) {}
    return { stopped, offer: a._tapOffer };
  };
  ['priceConfirm', 'crossConfirm', 'home'].forEach((screen) => {
    const r = run(screen, true);
    ok('the radio stays up while the answer is still coming, on ' + screen,
      !r.stopped.length && r.offer !== null, JSON.stringify(r.stopped));
  });
  const left = run('home', false);
  ok('and comes down when the person really leaves',
    left.stopped.length === 1, JSON.stringify(left.stopped));
}

// ---- 2. the onion inbox ----------------------------------------------------
{
  const M = new Function('return {' + method('syncInbox() {') + '}');
  const wants = (screen, talking) => {
    const a = Object.assign(M(), {
      state: { screen: screen, flow: 'receive' },
      setState() {}, _inboxUrl: 'x.onion', _inboxOpening: null, _tapTalking: !!talking,
    });
    global.window = { FoxyWallet: { openInbox: () => new Promise(() => {}), closeInbox() {} } };
    a._inboxLeftAt = 0;
    try { a.syncInbox(); } catch (e) {}
    // it marks the moment it decided the person had gone
    return !a._inboxLeftAt;
  };
  ok('the address stays open on the receive screen', wants('confirm', false) === true);
  ['priceConfirm', 'home'].forEach((screen) => {
    ok('and while an answer is still coming, on ' + screen, wants(screen, true) === true);
  });
  ok('and is let go when the person really leaves', wants('home', false) === false);
}

// ---- 3. the screen-awake lock ----------------------------------------------
{
  const M = new Function('return {' + method('syncAwake() {') + '}');
  const held = (screen, talking) => {
    let want = null;
    const a = Object.assign(M(), {
      state: { screen: screen, flow: 'receive' },
      _awake: false, _tapTalking: !!talking,
    });
    global.window = { FoxyWallet: { keepAwake: (v) => { want = v; } } };
    try { a.syncAwake(); } catch (e) {}
    return want;
  };
  ok('the phone is kept awake on the receive screen', held('confirm', false) === true);
  ['priceConfirm', 'home'].forEach((screen) => {
    ok('and while an answer is still coming, on ' + screen + ' — sleeping drops the link',
      held(screen, true) === true, String(held(screen, true)));
  });
  ok('and is allowed to sleep once the tap is over',
    held('home', false) !== true, String(held('home', false)));
}

// ---- 4. every pass, named, so a new one cannot be forgotten ----------------
{
  /* A new pass added to componentDidUpdate that reads `screen` is a new way to
   * tear something down mid-tap. This does not check behaviour — the three
   * above do — it checks that the list of passes is the list this file knows
   * about, so adding one is a decision rather than an accident. */
  /* The method, not the first mention of its name: it is talked about in a
   * comment two thousand lines earlier. */
  const at = app.indexOf('\n  componentDidUpdate(');
  /* The whole method, by matching its braces. It was the first 2,600 characters,
   * which is the same thing right up until somebody adds a pass or a comment and
   * the last one falls off the end — reported as a pass that had gone missing
   * when it was sitting there untouched. */
  const body = (() => {
    let i = app.indexOf('{', at), depth = 0;
    for (; i < app.length; i++) {
      if (app[i] === '{') depth++;
      else if (app[i] === '}') { depth--; if (depth === 0) break; }
    }
    return app.slice(at, i + 1);
  })();
  const passes = (body.match(/this\.(sync[A-Z]\w*)\(\)/g) || [])
    .map((m) => m.slice(5, -2)).filter((v, i, a2) => a2.indexOf(v) === i).sort();
  /* Each of these either reads `screen` to decide whether the person has left,
   * or does not. The ones that do are the ones a live tap has to survive, and
   * the three above hold them. `syncSnow` draws the home screen's snow once and
   * leaves it alone; `syncAccent`, `syncHaptics`, `syncQueue`, `syncSlide`,
   * `syncUnit`, `syncPreview`, `syncTokenQr`, `syncReqQr`, `syncClaim`, `syncShake` and `syncFlip` tear
   * nothing down that a payer is waiting on. */
  const known = ['syncAccent', 'syncAwake', 'syncShake', 'syncFlip', 'syncClaim', 'syncHaptics', 'syncInbox',
                 'syncPreview', 'syncQueue', 'syncReqQr', 'syncSlide', 'syncSnow',
                 'syncTap', 'syncTokenQr', 'syncUnit'].sort();
  ok('the passes that run on every update are the ones this file knows about',
    JSON.stringify(passes) === JSON.stringify(known),
    'new: ' + passes.filter((p) => known.indexOf(p) < 0).join(', ')
    + ' | gone: ' + known.filter((p) => passes.indexOf(p) < 0).join(', '));
}

/* ---- 5. pressing TAP again must not throw away a payer ---------------------
 *
 * TAP is a three-state control and the person cannot see which state they are
 * in: press once and it arms, press again and the prompt only goes away, press
 * a third time and it is a NEW receiver — a different service UUID and new
 * keys. That third press used to happen while a payer was part way through its
 * handshake, which left the payer talking to a number that no longer existed,
 * so it had to start over. Which is exactly what pressing several times to get
 * a connection looks like from the outside.
 */
{
  const M = new Function('return {' + method('tapArm() {') + '}');
  const run = (state) => {
    const app2 = M.call(null);
    const out = { set: null, offerCleared: false, hapticed: false };
    const self = {
      state: state,
      tapOffering: () => ({ inv: 'lnbc1', req: 'creq1' }),
      toast: () => {},
      haptic: () => { out.hapticed = true; },
      setState: (p) => { out.set = Object.assign({}, out.set || {}, p); },
    };
    Object.defineProperty(self, '_tapOffer', {
      get() { return this.__o; },
      set(v) { if (v === null) out.offerCleared = true; this.__o = v; },
      configurable: true,
    });
    app2.tapArm.call(self);
    return out;
  };

  const first = run({ tapArmed: false, tapShownCode: '', tapCardOff: false, tapRecvStage: '' });
  ok('a first press arms the phone',
    !!(first.set && first.set.tapArmed === true), JSON.stringify(first.set));

  const second = run({ tapArmed: true, tapShownCode: '', tapCardOff: false, tapRecvStage: '' });
  ok('a second press only puts the prompt away, staying on the air',
    !!(second.set && second.set.tapCardOff === true && !second.offerCleared),
    JSON.stringify(second.set));

  /* The third press, with nobody connecting: a new receiver is right here —
   * the last payer's keys must not be handed to the next customer. */
  const third = run({ tapArmed: true, tapShownCode: '', tapCardOff: true, tapRecvStage: '' });
  ok('a third press with nobody there starts a fresh receiver',
    third.offerCleared && !!(third.set && third.set.tapArmed === true),
    'offer cleared: ' + third.offerCleared);

  /* And the same press while a payer is coming in: the prompt comes back and
   * the conversation is left alone. */
  const during = run({ tapArmed: true, tapShownCode: '', tapCardOff: true, tapRecvStage: 'connecting' });
  ok('but not while a payer is connecting — that link is kept',
    !during.offerCleared && !!(during.set && during.set.tapCardOff === false),
    'offer cleared: ' + during.offerCleared + ', set: ' + JSON.stringify(during.set));

  /* Once the code is on screen the keys are agreed, and the first branch
   * already covers it: the press is the card's X and nothing else. */
  const agreed = run({ tapArmed: true, tapShownCode: '4821', tapCardOff: false, tapRecvStage: '' });
  ok('and never once the four digits are up',
    !agreed.offerCleared && !!(agreed.set && agreed.set.tapCardOff === true),
    JSON.stringify(agreed.set));
}

/* ---- 6. a refused radio has to try again -----------------------------------
 *
 * `_tapOffer` is set before `tapReceive` is called and the advertise guard is
 * `this._tapOffer !== offer`, so a refusal left the phone off the air with the
 * offer recorded as sent and nothing ever retried. The screen went on saying
 * HOLD A PHONE HERE over a radio that was not on, and the only way out was to
 * press TAP again — which is what pressing several times to get a connection
 * actually was (the refusal read "That payment is still going through. A
 * moment.").
 */
{
  const src = method('syncTap() {');
  ok('a refused advertise forgets the offer, so the next pass tries again',
    /\.then\([^)]*\},\s*\(e\)\s*=>\s*\{[\s\S]*?this\._tapOffer = null;/.test(src)
      || /not advertising[\s\S]{0,400}this\._tapOffer = null;/.test(src),
    'the catch does not clear _tapOffer');
  ok('and it says so on the screen rather than lying about it',
    /tapNotYet/.test(src), 'no tapNotYet is set');
  ok('and schedules the retry on a clock, not on every update',
    /setTimeout\([\s\S]{0,160}syncTap\(\)/.test(src), 'no timed retry');
  const vals = app;   // the same source, already read at the top
  ok('and the hint shows the reason instead of HOLD A PHONE HERE',
    /tapNotYet \? String\(s\.tapNotYet\)/.test(vals), 'the hint ignores it');
}

console.log('\n' + (R.fail ? R.fail + ' tap-held check(s) failed' : 'all ' + R.pass + ' tap-held checks pass'));
process.exit(R.fail ? 1 : 0);
