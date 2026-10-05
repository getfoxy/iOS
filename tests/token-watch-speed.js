'use strict';
/* token-watch-speed.js — the sender's screen keeps up with the redeemer's.
 *
 *     node tests/token-watch-speed.js
 *
 * claimWaitFor / tokenOnScreen / tokenWatchNow from build/foxy-app.js. A token
 * on its own screen has someone standing in front of it waiting for one
 * answer. It used to be asked about on the same ladder as a token nobody is
 * looking at — 3 to 5 seconds between asks, and up to 45 before the first ask
 * on a token just made — so the person who redeemed saw their money arrive
 * while the sender watched a screen that had not caught up.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const start = src.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start + 3, i + 1);
}
const waits = new Function('return ' + /CLAIM_WAITS = (\{[\s\S]*?\});/.exec(src)[1])();
const methods = new Function('return {' + [
  'claimWait(kind) {', 'claimWaitFor(age, onScreen) {', 'tokenOnScreen(hash) {', 'tokenWatchNow() {',
].map(method).join(',') + '}')();
const app = (state, extra) => Object.assign(
  { CLAIM_WAITS: waits, state: state, claimWatchTick() { this.ticked = (this.ticked || 0) + 1; } },
  extra || {}, methods);

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
const many = (fn) => Array.from({ length: 400 }, fn);

// ---- while it is on screen ------------------------------------------
{
  const a = app({ screen: 'tokenOut', tokenOutHash: 'h1' });
  const on = many(() => a.claimWaitFor(1000, true));
  check('a token being watched is asked about about once a second',
    Math.max(...on) <= 2000, 'longest wait ' + Math.max(...on) + 'ms');
  check('and never so often it hammers the mint',
    Math.min(...on) >= 500, 'shortest wait ' + Math.min(...on) + 'ms');

  const off = many(() => a.claimWaitFor(1000, false));
  check('a token nobody is looking at keeps the slower ladder',
    Math.min(...off) >= 3000, 'shortest wait ' + Math.min(...off) + 'ms');
  check('watching is several times quicker than not',
    Math.max(...on) < Math.min(...off),
    Math.max(...on) + 'ms watched vs ' + Math.min(...off) + 'ms not');
}

// ---- the cadence is not a fixed beat --------------------------------
{
  const a = app({ screen: 'tokenOut', tokenOutHash: 'h1' });
  check('the wait varies, so the asking is not a pattern at the mint',
    new Set(many(() => a.claimWaitFor(1000, true))).size > 50,
    new Set(many(() => a.claimWaitFor(1000, true))).size + ' distinct waits');
}

// ---- which token is on screen ---------------------------------------
{
  const a = app({ screen: 'tokenOut', tokenOutHash: 'h1' });
  check('the token on screen is recognised', a.tokenOnScreen('h1') === true);
  check('another token is not', a.tokenOnScreen('h2') === false);
  check('nor is one with no hash at all', a.tokenOnScreen('') === false);
  const b = app({ screen: 'home', tokenOutHash: 'h1' });
  check('and not once the screen is left', b.tokenOnScreen('h1') === false);
}

// ---- opening the screen asks at once ---------------------------------
{
  const a = app({ screen: 'tokenOut', tokenOutHash: 'h1' }, { _claimNext: { h1: Date.now() + 45000 } });
  a.tokenWatchNow();
  check('opening the screen brings a far-off question forward to now',
    a._claimNext.h1 === 0, 'next ask at ' + a._claimNext.h1);
  check('and ticks the loop so it actually goes', a.ticked === 1);

  const b = app({ screen: 'tokenOut', tokenOutHash: 'h1' }, { _claimNext: { h1: Infinity } });
  b.tokenWatchNow();
  check('a question already in flight is not disturbed',
    b._claimNext.h1 === Infinity);

  const c = app({ screen: 'tokenOut', tokenOutHash: '' }, { _claimNext: {} });
  c.tokenWatchNow();
  check('no token on the screen, nothing to bring forward',
    Object.keys(c._claimNext).length === 0);
}

console.log('\n' + (R.fail ? R.pass + ' passed, ' + R.fail + ' failed' : 'all ' + R.pass + ' token watch checks pass'));
process.exit(R.fail ? 1 : 0);
