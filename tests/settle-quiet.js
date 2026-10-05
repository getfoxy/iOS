'use strict';
/* settle-quiet.js — money settling is not money arriving.
 *
 *     node tests/settle-quiet.js
 *
 * An offline receive tells the person at the moment it lands: the amount is on
 * screen and the row goes into history as PENDING, which is true. What happens
 * later, when a route comes back and the ecash is swapped in, is bookkeeping —
 * the proofs were locked to this phone from the start, this wallet's own twelve
 * words open them, and `forwardLocked` lets them be spent before they settle.
 * Nothing was at risk and nothing was unavailable.
 *
 * The confirmation pass skipped pending rows outright, so they were never
 * marked as seen — and the moment the route returned, settling them read as
 * brand-new payments and threw a screen over whatever the person was doing.
 * Three in nine seconds, for payments they had already been told
 * about.
 *
 * The pass itself, out of the shipped app, with history handed to it.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 3, i + 1);
}

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};

/* The pass, with everything around it stubbed to nothing: what is being tested
 * is which rows reach `fresh`, and `announcePayment` is where they go. */
function pass() {
  const methods = new Function('return {' + method('txIsNew(hash) {') + '}')();
  const shown = [];
  const app = Object.assign({
    state: {}, setState() {},
    announcePayment(ev) { shown.push(ev); },
    _seenSeeded: false, _seededFor: 'mint.test',
  }, methods);

  /* The forEach out of loadHistory, kept to the lines that decide. Lifting the
   * whole method would drag in the mint list, the contact book and the buckets,
   * none of which decide anything here — so the loop is transcribed and the
   * check below holds the shipped source to it. */
  const run = (list, tags) => {
    const fresh = [];
    list.forEach((t) => {
      if (!t.settled) { app.txIsNew(t.hash); return; }
      const tg = (tags && tags[t.hash]) || {};
      if (tg.change) { app.txIsNew(t.hash); return; }
      if (tg.inflight) return;
      if (app.txIsNew(t.hash) && !(t.unit && t.unit !== 'sat')) fresh.push(t);
    });
    app._seenSeeded = true;
    fresh.forEach((t) => app.announcePayment(t));
    return shown;
  };
  return { app, run, shown };
}

// ---- the source really is what is transcribed above ------------------------
ok('the shipped pass marks a pending row seen rather than skipping it',
  /if \(!t\.settled\) \{ this\.txIsNew\(t\.hash\); return; \}/.test(src),
  'loadHistory, 16-history-lists.js');

// ---- an offline receive, then the route coming back ------------------------
{
  const p = pass();
  const row = { hash: 'req-scan-1', sats: 1196, dir: 'in', settled: false, state: 'pending' };
  p.run([row]);                                   // the first load: it is pending
  ok('nothing is announced while it is still waiting to be swapped in',
    p.shown.length === 0, JSON.stringify(p.shown));
  // the route comes back and the same entry is finished, not doubled
  p.run([Object.assign({}, row, { settled: true, state: 'done' })]);
  ok('and nothing is announced when it finally settles either',
    p.shown.length === 0, JSON.stringify(p.shown.map((t) => t.sats)));
}

// ---- three of them at once, which is what was seen --------------------
{
  const p = pass();
  const rows = [
    { hash: 'a', sats: 2, dir: 'in', settled: false },
    { hash: 'b', sats: 3, dir: 'in', settled: false },
    { hash: 'c', sats: 1196, dir: 'in', settled: false },
  ];
  p.run(rows);
  p.run(rows.map((r) => Object.assign({}, r, { settled: true })));
  ok('a route returning to three waiting payments interrupts nobody',
    p.shown.length === 0, p.shown.length + ' confirmation(s)');
}

// ---- and the payment that really is new still is ---------------------------
{
  const p = pass();
  p.run([{ hash: 'seed', sats: 10, dir: 'in', settled: true }]);   // seeds quietly
  p.run([{ hash: 'seed', sats: 10, dir: 'in', settled: true },
         { hash: 'new', sats: 500, dir: 'in', settled: true }]);
  ok('a payment that arrives settled, having never been seen, is still announced',
    p.shown.length === 1 && p.shown[0].hash === 'new',
    JSON.stringify(p.shown.map((t) => t.hash)));
}

// ---- the rules that were already there, unchanged --------------------------
{
  const p = pass();
  p.run([{ hash: 'seed', sats: 1, dir: 'in', settled: true }]);
  p.run([{ hash: 'seed', sats: 1, dir: 'in', settled: true },
         { hash: 'chg', sats: 1, dir: 'in', settled: true },
         { hash: 'fly', sats: 9, dir: 'out', settled: true }],
        { chg: { change: true }, fly: { inflight: true } });
  ok('change handed back is still the tail of a payment, not one of its own',
    !p.shown.some((t) => t.hash === 'chg'), JSON.stringify(p.shown.map((t) => t.hash)));
  ok('and a payment still on its way is still not announced as one that happened',
    !p.shown.some((t) => t.hash === 'fly'), JSON.stringify(p.shown.map((t) => t.hash)));
}

console.log('\n' + (R.fail ? R.fail + ' settle check(s) failed' : 'all ' + R.pass + ' settle checks pass'));
process.exit(R.fail ? 1 : 0);
