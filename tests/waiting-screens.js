'use strict';
/* waiting-screens.js — no waiting screen is the last screen, and a long
 * payment says how far it has got.
 *
 *     node tests/waiting-screens.js
 *
 * A payer came back to SENDING with nothing to press and killed the app; a
 * scan sat on VERIFYING ECASH for twenty-six seconds behind a stalled Tor;
 * and a payment of a hundred pieces crossed in half a minute of silence.
 * What was built for those: a percentage from both
 * radios, shown where each person is looking, and a way off both screens
 * after eight seconds.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
const prog = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-receive-progress.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '..', 'build', 'markup.html'), 'utf8');

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
const methods = new Function('return {' + ['tapHeard(ev) {', 'tapReceiving(pct) {'].map(method).join(',') + '}')();

/* Timers the test turns by hand. */
let timers = [];
const realSet = global.setTimeout, realClear = global.clearTimeout;
function fakeTimers() {
  timers = [];
  global.setTimeout = (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; };
  global.clearTimeout = (t) => { if (t) t.live = false; };
}
function restoreTimers() { global.setTimeout = realSet; global.clearTimeout = realClear; }
const fire = (ms) => timers.filter((t) => t.live && t.ms === ms).forEach((t) => { t.live = false; t.fn(); });

function page() {
  const head = { innerHTML: '' };
  const d = { melt: false, head };
  global.document = {
    getElementById: (id) => (id === 'foxy-melt' && d.melt ? {} : null),
    querySelector: (q) => (q === '#foxy-melt h1' && d.melt ? head : null),
  };
  const a = Object.assign({
    state: { screen: 'confirm', flow: 'receive', sendPct: 0 },
    shown: 0, hidden: 0,
    setState(o) { Object.assign(a.state, typeof o === 'function' ? o(a.state) : o); },
    showMelt() { a.shown += 1; d.melt = true; },
    hideMelt() { a.hidden += 1; d.melt = false; },
  }, methods);
  return { a, d };
}

// ---- the payer's side ------------------------------------------------------
{
  const { a } = page();
  a.tapHeard({ side: 'pay', stage: 'sending', pct: 37 });
  ok(a.state.sendPct === 37, 'the payer’s radio saying how far it has got is kept for the SENDING screen', String(a.state.sendPct));
  ok(a.state.tapStage === undefined, 'and is not taken for a stage of the tap', String(a.state.tapStage));
  ok(/'SENDING ' \+ Math\.round\(s\.sendPct\) \+ '%'/.test(src), 'which shows it beside the word');
  ok(/Number\(s\.sendPct\) > 0 && Number\(s\.sendPct\) < 100/.test(src), 'only while it is under way');
  ok(/else if \(s\.sendSlow \|\| s\.sendPct\) \{\s*this\.setState\(\{ sendSlow: false, sendPct: 0 \}\)/.test(src),
     'and leaving the screen forgets it, so the next payment starts from nothing');
}

// ---- the receiver's side ---------------------------------------------------
{
  fakeTimers();
  const { a, d } = page();
  a.tapHeard({ side: 'receive', stage: 'receiving', pct: 12 });
  ok(a.shown === 1 && d.melt, 'a large payment arriving puts RECEIVING ECASH up over the code');
  ok(/Receiving ecash<br>12%/.test(d.head.innerHTML), 'with how far it has got', d.head.innerHTML);
  a.tapHeard({ side: 'receive', stage: 'receiving', pct: 58 });
  ok(a.shown === 1, 'the next figure is written on the same screen, not a new one', String(a.shown));
  ok(/58%/.test(d.head.innerHTML), 'and it moves', d.head.innerHTML);
  a.tapHeard({ side: 'receive', stage: 'receiving', pct: 140 });
  ok(/99%/.test(d.head.innerHTML), 'never past 99 until it is really in', d.head.innerHTML);
  ok(timers.filter((t) => t.live).length === 1, 'one clock, renewed each time', String(timers.filter((t) => t.live).length));
  fire(20000);
  ok(a.hidden === 1 && !d.melt, 'twenty seconds of nothing is a payer that went: the screen comes down');
  // and a payment that lands takes the clock with it
  a.tapHeard({ side: 'receive', stage: 'receiving', pct: 90 });
  ok(/clearTimeout\(this\._recvProgT\);\s*if \(this\._recvProg && !onIt\) this\.hideMelt\(\);\s*this\._recvProg = false;/.test(src),
     'the payment landing stops that clock and hands over to the ordinary receiving screen');
  restoreTimers();
}

// ---- thirteen seconds, and a way off ------------------------------------------
ok(/if \(s\.screen === 'sendDone'\) \{\s*this\._sendSlowT = setTimeout\(\(\) => \{[\s\S]{0,200}?sendSlow: true[\s\S]{0,40}?\}, 13000\)/.test(src),
   'SENDING starts a thirteen second clock on arriving');
ok(/clearTimeout\(this\._sendSlowT\);\s*if \(s\.screen === 'sendDone'\)/.test(src), 'and clears it on every change of screen');
ok(/sendSlowShown: sc === 'sendDone' && !!s\.sendSlow && \(sendPhase === 'in'\)/.test(src),
   'the notice shows only while it is still sending');
ok(/\{\{ sendSlowShown \}\}[\s\S]{0,700}?Still waiting for their phone to answer\.[\s\S]{0,700}?STOP WAITING/.test(markup),
   'with words and a STOP WAITING button on the screen');
ok(/sendStopWaiting: \(\) => \{[\s\S]{0,1600}?screen: 'home', stack: \[\], sendSlow: false/.test(src),
   'which goes home and leaves the payment to finish behind');

ok(/slowT = setTimeout\(function \(\) \{[\s\S]{0,900}?STOP WAITING[\s\S]{0,500}?\}, 13000\)/.test(prog),
   'VERIFYING ECASH does the same after eight seconds');
ok(/if \(root !== mine\) return;/.test(prog), 'only if it is still the same wait');
ok(/end: function \(\) \{\s*clearTimeout\(slowT\);/.test(prog), 'and its clock stops when the wait ends');
ok(/__foxyStopWaiting = \(\) => \{[\s\S]{0,300}?this\._takingToken = false;[\s\S]{0,120}?screen: 'home'/.test(src),
   'stopping lets the next scan through and goes home');

console.log('\n' + (failed ? failed + ' waiting-screens check(s) failed' : 'all waiting-screens checks pass'));
process.exit(failed ? 1 : 0);
