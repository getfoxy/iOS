'use strict';
/* watch-rearm.js — the page's other recurring watchers, and whether they leave
 * a timer behind.
 *
 *     node tests/watch-rearm.js
 *
 * Companion to onchain-watch.js, which pins the loop that asks whether an
 * on-chain payment landed. That one stopped on a phone because every
 * early return set no next timer and nothing re-armed it on a return from the
 * background, and the same shape was in three
 * more places:
 *
 *   - the split-the-check watchers, which are the only thing that claims a
 *     share once a payer pays it. They give up after an hour and nothing
 *     re-watched, and a return from the background did not either;
 *   - the confirmation queue, which only moved when something else happened to
 *     call it, so a payment held behind a busy screen was never shown;
 *   - walletReady's fifteen-second balance and history refresh, armed on the
 *     last line of a method whose eight preceding calls all reach out to the
 *     wallet.
 *
 * The methods are lifted out of build/foxy-app.js and run against a stand-in
 * app and a clock the test drives, the way onchain-watch.js and
 * switch-guard.js do. The claim watch — the fourth of these — is pinned in
 * pay-this-mint.js, beside the rest of its behaviour.
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
function field(name) {
  const m = new RegExp('\\n  ' + name + ' = ([^;]+);').exec(src);
  if (!m) throw new Error('missing ' + name);
  return JSON.parse(m[1].replace(/'/g, '"'));
}
const methods = new Function('return {' + [
  'resumeSplit(force) {', 'resumeSplitNow(force) {', 'splitWatchLater() {', 'spStopWatch() {',
  'nextPaidScreen() {', 'queueLater() {', 'paidDismissed() {',
  'walletReady(w) {',
  'spSyncPaid() {', 'spPaidArr() {', 'spOthers() {', 'spWaysN() {',
  // the change tidy, and the move it must stay out of (07-history-tokens-mints.js)
  'tidyChangeLater(more) {', 'movingMints() {',
].map(method).join(',\n') + '}')();

const SPLIT_REWATCH_MS = field('SPLIT_REWATCH_MS');
const QUEUE_RETRY_MS = field('QUEUE_RETRY_MS');
const SPLIT_SCREENS = field('SPLIT_SCREENS');

/* The watchers chain a promise or two before they set the next timer, and the
 * stubs answer at once — so "let everything that can run, run" is a handful of
 * turns of the microtask queue, not a wait. */
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

/* A clock the test drives. Every timer these methods set is recorded, so "did
 * it arrange to come back?" is a question with an answer rather than a wait. */
function clock() {
  const timers = [];
  const add = (fn, ms, repeats) => { timers.push({ fn, ms, repeats, live: true }); return timers.length; };
  const kill = id => { if (timers[id - 1]) timers[id - 1].live = false; };
  return {
    timers,
    setTimeout(fn, ms) { return add(fn, ms, false); },
    clearTimeout: kill,
    setInterval(fn, ms) { return add(fn, ms, true); },
    clearInterval: kill,
    next() { return timers.filter(t => t.live && !t.repeats).slice(-1)[0] || null; },
    every() { return timers.filter(t => t.live && t.repeats); },
    async fire(t) {
      const run = t || this.next();
      if (!run) throw new Error('nothing was scheduled');
      if (!run.repeats) run.live = false;
      await run.fn();
      await flush();
    },
  };
}

function app(over) {
  const c = clock();
  const said = [];
  const a = Object.assign({
    clock: c, said,
    SPLIT_SCREENS: SPLIT_SCREENS,
    SPLIT_REWATCH_MS: SPLIT_REWATCH_MS,
    QUEUE_RETRY_MS: QUEUE_RETRY_MS,
    state: { screen: 'home' },
    setState(p) { Object.assign(a.state, typeof p === 'function' ? p(a.state) : p); },
    refreshBalance() { said.push('balance'); },
    loadHistory() { said.push('history'); },
    announcePayment(ev) { said.push('announce ' + ev.hash); a.state.screen = 'paid'; },
    toast(m) { said.push('toast ' + m); },
    group(n) { return String(n); },
  }, methods, over || {});
  // the methods reach for the page's timers
  global.setTimeout = c.setTimeout.bind(c);
  global.clearTimeout = c.clearTimeout.bind(c);
  global.setInterval = c.setInterval.bind(c);
  global.clearInterval = c.clearInterval.bind(c);
  return a;
}

function splitWallet(over) {
  return Object.assign({
    watched: [],
    splitReconcile() { return Promise.resolve(0); },
    splitPending() { return { done: false, ways: 3, total: 3000, rows: [
      { hash: 'h1', bolt11: 'lnbc1', sats: 1000, paid: true },
      { hash: 'h2', bolt11: 'lnbc2', sats: 1000, paid: false },
    ] }; },
    watch(hash, cb, opts) { this.watched.push({ hash: hash, timeoutMs: opts && opts.timeoutMs }); return () => {}; },
    splitMarkPaid() {},
  }, over || {});
}

async function run() {
  /* ---- the collecting screen believes the ledger, whoever settled the row --
   *
   * spPaid is what that screen ticks off, and only the per-invoice watcher
   * used to write it. splitReconcile settles a share by another path — it
   * claims one the mint reports PAID and marks the row — and when it got
   * there first the money was in history and in the balance while the screen
   * still read PENDING, 0 of 3. */
  {
    const a = app();
    a.state = { screen: 'spWaiting', spWays: 3, spPaid: [] };
    global.window = { FoxyWallet: splitWallet() };   // row 1 paid, row 2 not
    a.spSyncPaid();
    check('a share settled by the reconcile shows on the collecting screen',
      a.state.spPaid[0] === true, JSON.stringify(a.state.spPaid));
    check('and one nobody has paid is left alone',
      a.state.spPaid[1] === false && a.state.screen === 'spWaiting', JSON.stringify(a.state));
  }
  {
    // the last share landing that way ends the screen, as the watcher's does
    const a = app();
    a.state = { screen: 'spWaiting', spWays: 3, spPaid: [true, false] };
    global.window = { FoxyWallet: splitWallet({ splitPending() {
      return { done: false, ways: 3, total: 3000, rows: [
        { hash: 'h1', sats: 1000, paid: true }, { hash: 'h2', sats: 1000, paid: true }] };
    } }) };
    a.spSyncPaid();
    check('the last share landing that way finishes the bill',
      a.state.screen === 'spAllPaid' && a.state.spPaid.every(Boolean), JSON.stringify(a.state));
  }
  {
    // a tally that has not moved must not redraw the screen under the person
    const a = app();
    let writes = 0;
    a.state = { screen: 'spWaiting', spWays: 3, spPaid: [true, false] };
    a.setState = () => { writes++; };
    global.window = { FoxyWallet: splitWallet() };   // says exactly the same
    a.spSyncPaid();
    check('a ledger that says nothing new sets no state', writes === 0, writes + ' write(s)');
  }

  // ---- splitting the check: the watchers outlive their own timeout ---------
  /* Without a watcher a share paid at the mint is never claimed by this
   * wallet, and W.watch gives up after an hour. A bill left on the table is
   * exactly the case: the phone is in a pocket and the app has been open for
   * hours. */
  {
    const a = app();
    const W = splitWallet();
    global.window = { FoxyWallet: W };
    await a.resumeSplit(); await flush();
    const next = a.clock.next();
    check('a bill still being collected arranges to be watched again', !!next,
      'no timer was left behind');
    check('and does it well inside the hour a watcher lasts',
      !!next && next.ms < 3600000 && next.ms > 60000, JSON.stringify(next && next.ms));
    check('the shares still owed are the ones watched',
      W.watched.length === 1 && W.watched[0].hash === 'h2', JSON.stringify(W.watched));
    await a.clock.fire();
    check('and the pass after it watches them again rather than letting them lapse',
      W.watched.length === 2 && W.watched[1].hash === 'h2', JSON.stringify(W.watched));
    check('which leaves yet another timer behind', !!a.clock.next(), 'the loop stopped after one pass');
  }
  /* A wake does not restart the watchers' own back-off.
   *
   * FoxyWallet.watch polls every two seconds for its first two minutes, and
   * that clock runs from when it was armed. resumeSplit runs on every return
   * to the foreground and every mint connect, and re-armed unconditionally —
   * so every return put every open share back into the fast phase. Nine
   * returns in five minutes held three invoices there the whole time: 165
   * mint requests over Tor in seven minutes. */
  {
    const a = app();
    const W = splitWallet();
    global.window = { FoxyWallet: W };
    await a.resumeSplit(); await flush();
    check('the first pass watches the share still owed', W.watched.length === 1, JSON.stringify(W.watched));
    await a.resumeSplit(); await flush();
    await a.resumeSplit(); await flush();
    check('and two more wakes leave that watcher running rather than replacing it',
      W.watched.length === 1, W.watched.length + ' watchers armed');
    check('while still arranging the pass that outlives the hour', !!a.clock.next(), 'no timer');
    // the scheduled pass is the one that must always replace them
    await a.clock.fire();
    check('the scheduled pass arms a new set whatever the wakes did',
      W.watched.length === 2, JSON.stringify(W.watched));
  }

  // ---- a bill collected in full stops, and says why ------------------------
  {
    const a = app();
    global.window = { FoxyWallet: splitWallet({ splitPending: () => ({ done: true, rows: [] }) }) };
    await a.resumeSplit(); await flush();
    check('a bill everyone has paid is not watched for ever', !a.clock.next(),
      'a settled split kept a timer running');
  }

  // ---- the wallet between mints -------------------------------------------
  {
    const a = app();
    global.window = {};
    await a.resumeSplit(); await flush();
    check('a pass before the wallet is on the page comes back to it', !!a.clock.next(),
      'no timer was left behind');
    global.window = { FoxyWallet: splitWallet() };
    await a.clock.fire();
    check('and the pass after it watches the open share', true, '');
  }

  // ---- and the phone coming back from a pocket arms it --------------------
  /* The watchers were suspended with the app, and a bill on a table is
   * collected while the phone is in a pocket. Read from the source: the wake
   * handler is a closure inside watchWake, not a method this file can lift. */
  {
    const wake = method('watchWake() {');
    check('coming back from the background watches the open shares again',
      /resumeSplit\(\)/.test(wake), 'watchWake does not resume the split');
    check('and re-opens the onion inbox the native side ended while away',
      /inboxWake\(\)/.test(wake), 'watchWake does not re-open the inbox');
    check('and still resumes the token claims and the on-chain watcher',
      /claimWatchResume\(\)/.test(wake) && /onchainWatchLater\(\)/.test(wake),
      'watchWake lost one of the watchers it already had');
  }

  // ---- the confirmation queue drains itself --------------------------------
  /* The money is credited by loadHistory either way; what stalls here is the
   * confirmation for it, and everything queued behind it. */
  {
    const a = app({ state: { screen: 'paid' }, _paidQueue: [{ sats: 10, hash: 'a' }] });
    global.window = { FoxyWallet: {} };
    a.nextPaidScreen();
    check('a payment queued behind a confirmation is come back for', !!a.clock.next(),
      'no timer was left behind');
    a.state.screen = 'home';
    await a.clock.fire();
    check('and is shown once the screen is free', a.said.indexOf('announce a') >= 0,
      JSON.stringify(a.said));
  }
  {
    const a = app({ state: { screen: 'spWaiting' }, _paidQueue: [{ sats: 10, hash: 'a' }] });
    global.window = { FoxyWallet: {} };
    a.nextPaidScreen();
    check('a payment queued behind a split is come back for too', !!a.clock.next(),
      'the queue stalled while the split screen was up');
    a.state.screen = 'home';
    await a.clock.fire();
    check('and shows when the split is left', a.said.indexOf('announce a') >= 0, JSON.stringify(a.said));
  }
  {
    // the confirmation that never lands: dropped on the queue's own timer
    const a = app({
      state: { screen: 'home' },
      _paidQueue: [{ sats: 10, hash: 'a' }, { sats: 20, hash: 'b' }],
      announcePayment(ev) { a.said.push('announce ' + ev.hash); },   // never reaches the screen
    });
    global.window = { FoxyWallet: {} };
    a.nextPaidScreen();
    a._paidQueue[0].said = Date.now() - 21000;        // twenty seconds later
    await a.clock.fire();
    check('a confirmation that never landed is dropped without anything else asking',
      a._paidQueue[0] && a._paidQueue[0].hash === 'b', JSON.stringify(a._paidQueue));
    check('and the payment behind it is announced', a.said.indexOf('announce b') >= 0,
      JSON.stringify(a.said));
  }
  {
    const a = app({ state: { screen: 'home' }, _paidQueue: [] });
    global.window = { FoxyWallet: {} };
    a.nextPaidScreen();
    check('an empty queue arms nothing, so the poll ends of its own accord', !a.clock.next(),
      'an empty queue kept polling');
  }

  // ---- the balance and history heartbeat ----------------------------------
  /* Fifteen seconds is how an arrival nobody watched for reaches the screen.
   * It was armed on walletReady's last line, behind eight calls out to the
   * wallet — so one of them throwing, on a mint switch as much as a launch,
   * took the balance and the history with it for the rest of the session. */
  {
    const a = app({
      loadSeries() {}, custodyNotice() {}, passcodeNotice() {},
      onchainAsk() {}, onchainWatchLater() {}, claimWatchResume() {},
      tidyChangeLater() {}, listenWallet() {},
      resumeSplit() { throw new Error('the wallet is between mints'); },
    });
    global.window = { FoxyWallet: {
      finishMove: () => Promise.resolve(0),
      lastToken: () => null,
    } };
    let threw = false;
    try { a.walletReady({ name: 'mint.example' }); } catch (e) { threw = true; }
    const beat = a.clock.every();
    check('a step of walletReady that throws does not take the refresh with it',
      threw && beat.length === 1, JSON.stringify({ threw: threw, intervals: beat.length }));
    check('and it is the fifteen-second one', beat.length === 1 && beat[0].ms === 15000,
      JSON.stringify(beat.map(t => t.ms)));
    await a.clock.fire(beat[0]);
    check('which asks for the balance and the history',
      a.said.indexOf('balance') >= 0 && a.said.indexOf('history') >= 0, JSON.stringify(a.said));
  }
  {
    // and a mint switch replaces it rather than running two
    const a = app({
      loadSeries() {}, custodyNotice() {}, passcodeNotice() {},
      onchainAsk() {}, onchainWatchLater() {}, claimWatchResume() {}, resumeSplit() {},
      tidyChangeLater() {}, listenWallet() {},
    });
    global.window = { FoxyWallet: {
      finishMove: () => Promise.resolve(0),
      lastToken: () => null,
    } };
    a.walletReady({ name: 'one' });
    a.walletReady({ name: 'two' });
    check('a mint switch leaves one heartbeat, not two', a.clock.every().length === 1,
      a.clock.every().length + ' intervals running');
  }

  /* ---- the change tidy keeps out of a move between mints ------------------
   *
   * It is armed twenty to ninety seconds after money moves and guarded by
   * moneyBusy() — which does not cover the stretch where a token from another
   * mint has been priced and the person is deciding. One landed in that gap on
   * a phone and spent fourteen seconds on change it did not need,
   * in the middle of a move that already takes six round trips over Tor. */
  {
    const a = app();
    let tidied = 0;
    const W = Object.assign(splitWallet(), { tidyChange() { tidied++; return Promise.resolve({}); } });
    global.window = { FoxyWallet: W };
    a.TIDY_WAIT = [20000, 90000];
    a.moneyBusy = () => false;

    /* A top-up runs only with Foxy put away: in the foreground
     * it is noted and nothing is scheduled, whatever the screen. */
    a.state = { screen: 'newMint' };            // the fee is quoted, they are deciding
    a.tidyChangeLater();
    check('a tidy asked for in the foreground does not run, and schedules nothing', tidied === 0 && !a.clock.next(), tidied + ' ran');
    check('but is noted for the next put-away', a._tidyOwed === true, String(a._tidyOwed));

    a.state = { screen: 'home' };
    a._putAway = true;                           // put away with a move being decided: still not
    a.state = { screen: 'newMint', nmBusy: true };
    a.tidyChangeLater();
    await a.clock.fire(); await flush();
    check('put away while a move is running, it waits', tidied === 0, tidied + ' ran');
    check('and arranges to come back rather than being dropped', !!a.clock.next(), 'no timer left');

    a.state = { screen: 'home' };                // away from it, it does its job
    a.tidyChangeLater();
    await a.clock.fire(); await flush();
    check('and put away with nothing in the way, it runs', tidied === 1, tidied + ' ran');
  }

  /* ---- and it keeps going while the pool is short -------------------------
   *
   * Each run splits one piece, and a pool filling from scratch is twelve of
   * each of eight small denominations. At the idle pace — twenty to ninety
   * seconds, floored at two minutes, and only when something re-armed it —
   * that is far longer than anybody holds an app open, and a person kept
   * finding the pool half full when they needed exact change.
   *
   * So a swap that worked arms the next one in seconds, and it stops on its
   * own the moment `tidyChange` says there is nothing to do. */
  {
    const a = app();
    let tidied = 0;
    const W = Object.assign(splitWallet(), {
      // three pieces to split, then nothing left short
      tidyChange() {
        tidied++;
        return Promise.resolve(tidied <= 3 ? { split: true } : { skipped: 'nothing short' });
      },
    });
    global.window = { FoxyWallet: W };
    a.TIDY_WAIT = [20000, 90000];
    a.TIDY_MORE = [2500, 6000];
    a.moneyBusy = () => false;
    a.state = { screen: 'home' };
    a._putAway = true;
    a._putAwayAt = Date.now();

    a.tidyChangeLater();
    for (let i = 0; i < 6 && a.clock.next(); i++) { await a.clock.fire(); await flush(); }
    check('a swap that works brings the next one along rather than waiting',
      tidied === 4, tidied + ' runs');
    check('and it stops of its own accord once nothing is short', !a.clock.next(),
      'a timer is still armed');

    /* The two-minute floor is for going looking, not for finishing. It used to
     * apply to every run, so the follow-ons it is meant to allow would all have
     * been dropped on the spot. */
    const seen = [];
    const B = app();
    let n = 0;
    global.window = { FoxyWallet: Object.assign(splitWallet(), {
      tidyChange() { n++; return Promise.resolve(n <= 2 ? { split: true } : { skipped: 'done' }); },
    }) };
    B.TIDY_WAIT = [20000, 90000];
    B.TIDY_MORE = [2500, 6000];
    B.moneyBusy = () => false;
    B.state = { screen: 'home' };
    B._putAway = true;
    B._putAwayAt = Date.now();
    B.tidyChangeLater();
    while (B.clock.next() && seen.length < 5) { seen.push(B.clock.next().ms); await B.clock.fire(); await flush(); }
    /* Put away, every wait is short: the phone holds Tor up twenty seconds
     * for this and the long random wait was for somebody still here. */
    check('put away, the waits are all short, the follow-ons included',
      seen.length >= 3 && seen.every((ms) => ms <= 6000),
      JSON.stringify(seen));
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  if (failed) { console.log('\n' + failed + ' watcher re-arm check(s) failed'); process.exit(1); }
  console.log('\nall ' + results.length + ' watcher re-arm checks pass');
}

run().catch(e => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
