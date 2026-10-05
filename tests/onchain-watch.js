'use strict';
/* onchain-watch.js — the loop that asks whether an on-chain payment landed.
 *
 *     node tests/onchain-watch.js
 *
 * On chain settles in blocks, so nothing about a deposit reaches the person
 * except this timer: the mint credits nobody on its own, and `onchainClaim` is
 * what turns a confirmed payment into ecash. A loop that stops is therefore a
 * deposit that never arrives, and it stops silently.
 *
 * It did. Every early return in `onchainWatch` left no timer behind, so a
 * single pass with the wallet between mints — or with nothing yet to watch —
 * ended the watching for the rest of the session, and only a launch, a new
 * address or a payout would start it again. On a phone an address was last
 * asked about seven minutes after it was made while the app went on running
 * for half an hour more; the money sat at the mint, confirmed, with Foxy no longer
 * listening.
 *
 * The methods are lifted out of build/foxy-app.js and run against a stand-in
 * app, the way switch-guard.js and pay-this-mint.js do.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

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
const methods = new Function('return {' + [
  'onchainWatch() {', 'onchainWatchLater(ms) {', 'onchainAsk() {',
].map(method).join(',\n') + '}')();

/* The watcher chains several promises before it sets the next timer, and the
 * stubs answer at once — so "let everything that can run, run" is a handful of
 * turns of the microtask queue, not a wait. */
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

/* A clock the test drives. Every timer the watcher sets is recorded, so "did it
 * arrange to ask again?" is a question with an answer rather than a wait. */
function clock() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].live = false; },
    next() { return timers.filter(t => t.live).slice(-1)[0] || null; },
    async fire() {
      const t = this.next();
      if (!t) throw new Error('nothing was scheduled');
      t.live = false;
      await t.fn();
      await flush();
    },
  };
}

function app(over) {
  const c = clock();
  const said = [];
  const a = Object.assign({
    clock: c, said,
    state: {},
    setState(p) { Object.assign(a.state, typeof p === 'function' ? p(a.state) : p); },
    refreshBalance() { said.push('balance'); },
    loadHistory() { said.push('history'); },
    announcePayment(ev) { said.push('announce ' + ev.sats); },
    toast(m) { said.push('toast ' + m); },
    group(n) { return String(n); },
  }, methods, over || {});
  // the methods reach for the page's timers
  global.setTimeout = c.setTimeout.bind(c);
  global.clearTimeout = c.clearTimeout.bind(c);
  return a;
}

function wallet(over) {
  return Object.assign({
    connected: true,
    asked: [],
    onchainWatching() { return []; },
    onchainSending() { return []; },
    onchainClaim(q) { this.asked.push('claim ' + q); return Promise.resolve({ sats: 0, hash: '' }); },
    onchainFollow(q) { this.asked.push('follow ' + q); return Promise.resolve({ state: 'PENDING' }); },
  }, over || {});
}

async function run() {
  // ---- a pass that finds nothing still arranges the next one ---------------
  {
    const a = app();
    global.window = { FoxyWallet: wallet() };
    await a.onchainWatch(); await flush();
    check('a pass with nothing to watch still asks again later', !!a.clock.next(),
      'no timer was left behind');
    check('and it waits the slow interval, not a busy one',
      a.clock.next() && a.clock.next().ms >= 60000, JSON.stringify(a.clock.next() && a.clock.next().ms));
  }

  // ---- the wallet between mints ------------------------------------------
  {
    const a = app();
    global.window = { FoxyWallet: wallet({ connected: false }) };
    await a.onchainWatch(); await flush();
    const next = a.clock.next();
    check('a pass while the wallet is not connected asks again soon', !!next && next.ms <= 30000,
      JSON.stringify(next && next.ms));
    // and when it comes back, the loop is still alive and does the work
    const W = wallet({ onchainWatching: () => [{ quote: 'q1' }] });
    global.window = { FoxyWallet: W };
    await a.clock.fire();
    check('and the pass after it asks the mint about the address',
      W.asked.indexOf('claim q1') >= 0, JSON.stringify(W.asked));
  }

  // ---- no page at all (the wallet script has not loaded yet) --------------
  {
    const a = app();
    global.window = {};
    await a.onchainWatch(); await flush();
    check('a pass before the wallet exists asks again rather than giving up', !!a.clock.next(),
      'no timer was left behind');
  }

  // ---- a claim that lands --------------------------------------------------
  {
    const a = app();
    const W = wallet({
      onchainWatching: () => [{ quote: 'q1' }],
      onchainClaim(q) { this.asked.push('claim ' + q); return Promise.resolve({ sats: 30000, hash: 'h1' }); },
    });
    global.window = { FoxyWallet: W };
    await a.onchainWatch(); await flush();
    check('a confirmed deposit is claimed, counted and announced',
      a.said.join(' ').indexOf('announce 30000') >= 0 && a.said.indexOf('balance') >= 0,
      JSON.stringify(a.said));
    check('and the loop goes on afterwards', !!a.clock.next(), 'no timer was left behind');
  }

  // ---- a claim that throws -------------------------------------------------
  {
    const a = app();
    const W = wallet({
      onchainWatching: () => [{ quote: 'q1' }],
      onchainClaim() { return Promise.reject(new Error('the mint is unwell')); },
    });
    global.window = { FoxyWallet: W };
    await a.onchainWatch(); await flush();
    check('a claim that fails does not end the watching', !!a.clock.next(),
      'no timer was left behind after a failure');
  }

  // ---- a follow that throws ------------------------------------------------
  {
    const a = app();
    const W = wallet({
      onchainSending: () => [{ quote: 'm1', sats: 1000 }],
      onchainFollow() { return Promise.reject(new Error('no answer')); },
    });
    global.window = { FoxyWallet: W };
    await a.onchainWatch(); await flush();
    check('a payout whose state cannot be read is asked about again', !!a.clock.next(),
      'no timer was left behind after a failed follow');
  }

  // ---- many passes in a row keep the loop alive ---------------------------
  {
    const a = app();
    const W = wallet({ onchainWatching: () => [{ quote: 'q1' }] });
    global.window = { FoxyWallet: W };
    await a.onchainWatch(); await flush();
    for (let i = 0; i < 20; i++) await a.clock.fire();
    check('twenty passes later it is still asking',
      W.asked.filter(x => x === 'claim q1').length === 21, W.asked.length + ' calls');
  }

  // ---- how soon the first pass comes ---------------------------------------
  /* A phone is open for seconds. One launch was in the background
   * seventeen seconds in, where the first pass waited
   * twenty — so nothing on chain was asked about all day. */
  {
    const a = app();
    global.window = { FoxyWallet: wallet({ onchainWatching: () => [{ quote: 'q1' }] }) };
    a.onchainWatchLater();
    const soon = a.clock.next();
    check('with an address on file the first pass comes in seconds, not twenty',
      !!soon && soon.ms <= 5000, JSON.stringify(soon && soon.ms));
  }
  {
    const a = app();
    global.window = { FoxyWallet: wallet() };
    a.onchainWatchLater();
    const later = a.clock.next();
    check('with nothing on file it can wait, since nothing arrives unasked',
      !!later && later.ms >= 20000, JSON.stringify(later && later.ms));
  }
  {
    const a = app();
    global.window = {};
    a.onchainWatchLater();
    check('and a wallet that cannot answer yet still gets a timer', !!a.clock.next(),
      'no timer was left behind');
  }

  // ---- and the phone coming back from a pocket arms it --------------------
  /* The timer is suspended with the app, so a return is where the watching
   * starts again — and a return after time away is the likeliest moment for a
   * deposit to have confirmed. Read from the source: the wake handler is a
   * closure inside watchWake, not a method this file can lift out. */
  const wake = method('watchWake() {');
  check('coming back from the background arms the on-chain watcher',
    /onchainWatchLater\(\)/.test(wake), 'watchWake does not re-arm it');
  check('and asks the mint again what it does on chain', /onchainAsk\(\)/.test(wake),
    'watchWake does not refresh the limits');

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  if (failed) { console.log('\n' + failed + ' on-chain watch check(s) failed'); process.exit(1); }
  console.log('\nall ' + results.length + ' on-chain watch checks pass');
}

run().catch(e => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
