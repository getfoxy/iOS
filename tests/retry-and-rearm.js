'use strict';
/* retry-and-rearm.js — a try is not spent on a shut network, and a listen that
 * ends starts again.
 *
 *     node tests/retry-and-rearm.js
 *
 * Two failures seen on phones, both of the same shape: a
 * loop that stopped for a reason nothing was watching for.
 *
 *   1. The receive screen has three tries, for a mint that stumbles. All three
 *      were spent on a network that was shut — Tor goes off the air on purpose
 *      while Foxy is in the background — and the third fired two seconds after
 *      the app woke, with Tor still setting up. 100 seconds, nothing asked of
 *      the mint, and "Foxy is still connecting to Tor" as the final answer to a
 *      receive asked for once.
 *
 *   2. `tapPayStart` is asked with a 30 minute budget and answers with an error
 *      when it runs out. `syncTap` is the only thing that starts a listen and it
 *      runs from componentDidUpdate, on a state change and never on a clock, so
 *      the phone stopped hearing taps. One phone recovered 16 seconds later
 *      because the price poll ticked; the other's price sources were all timing
 *      out, so on that phone there was no such tick.
 *
 * These read the shipped files, so they fail whichever way either is undone.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'build', 'foxy-app.js'), 'utf8');
const wallet = fs.readFileSync(path.join(root, 'Web', 'foxy-wallet.js'), 'utf8');

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

/* The body of a method, by its signature, so a pin cannot match a different
 * function that happens to contain the same words. */
function body(src, sig, label) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error('missing ' + (label || sig));
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}

/* 1 — the wallet says which failures never left the phone ------------------ */

check('the wallet exports neverSent', /neverSent:\s*function/.test(wallet));
const never = body(wallet, 'function neverSent(', 'neverSent');
check('neverSent still names the Tor messages',
  /still connecting to Tor/.test(wallet) && /NEVER_SENT/.test(never),
  'the list the counters use');

/* 2 — the receive screen waits rather than spending a try ------------------ */

const recv = body(app, 'openReceiveNow() {', 'openReceiveNow');
check('the receive retry asks whether the request ever left', /neverSent\s*\(/.test(recv));

/* The branch that handles it: it must wait on the gate and recurse WITHOUT
 * advancing the try count. `attempt(n, waits + 1)` is the whole point — an
 * `attempt(n + 1, ...)` there would spend a try exactly as before. */
const closedBranch = /if\s*\(\s*closed[\s\S]{0,600}?quiet\(\)[\s\S]{0,300}?attempt\(\s*n\s*,\s*waits\s*\+\s*1\s*\)/.test(recv);
check('a shut network waits on the gate and keeps the try', closedBranch,
  'attempt(n, waits + 1), not attempt(n + 1, …)');
check('the waiting is bounded', /waits\s*<\s*WAITS/.test(recv) && /WAITS\s*=\s*[1-9]/.test(recv),
  'a radio that never returns still ends in an answer');
check('a real mint failure still spends a try',
  /if\s*\(\s*n\s*>=\s*3\s*\)\s*throw/.test(recv) && /attempt\(\s*n\s*\+\s*1\s*,\s*waits\s*\)/.test(recv),
  'three tries, as before');

/* 3 — a listen that ends starts again -------------------------------------- */

const startPay = body(app, 'tapStartPay() {', 'tapStartPay');
check('the search stamps when it began', /_tapSearchAt\s*=\s*Date\.now\(\)/.test(startPay));

/* The failure handler is the one that logs "search ended". */
const ended = startPay.slice(startPay.indexOf('search ended'));
check('a search that ended schedules another', /setTimeout\(/.test(ended) && /_tapReArm/.test(ended));
/* Through syncTap, so the screen decides whether listening is still wanted —
 * calling tapStartPay directly here would listen on from a screen that had
 * moved on. */
check('the re-arm goes through syncTap, not straight back into tapStartPay',
  /syncTap\(\)/.test(ended) && !/tapStartPay\(\)/.test(ended),
  'the screen stays the authority');
check('an instant failure backs off', /Math\.min\(/.test(ended),
  'Bluetooth off rejects at once; re-arming that every second is a hot loop');
check('a long listen resets the backoff', /lasted\s*>=\s*\d+/.test(ended),
  'a budget that expires after half an hour is picked straight up');

console.log('\n' + (R.fail ? 'FAILED ' + R.fail : 'PASSED ' + R.pass) + ' of ' + (R.pass + R.fail));
process.exit(R.fail ? 1 : 0);
