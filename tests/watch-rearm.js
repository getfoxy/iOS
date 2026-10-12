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
 *     call it, so a payment held behind a busy screen was never shown (and which
 *     now also waits, in order, for a card that is being read or written);
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
  // whether a card is being read or written, and what waits for it to be over (26f-flashcard.js)
  'cardFlowBusy() {', 'cardFlowHolds(ev) {', 'fcPadUp() {', 'fcAskingForCard() {', 'cardFlowMayHaveEnded() {',
  'walletReady(w) {',
  'spSyncPaid() {', 'spPaidArr() {', 'spOthers() {', 'spWaysN() {',
  'spPaidOnScreen(idx, how) {', 'spAdvanceAfterPaid(idx, how) {', 'spStopOne(i, hash) {',
  'spMakeInvoices() {',
  // the change tidy, and the move it must stay out of (07-history-tokens-mints.js)
  'tidyChangeLater(more) {', 'movingMints() {',
].map(method).join(',\n') + '}')();

const SPLIT_REWATCH_MS = field('SPLIT_REWATCH_MS');
const QUEUE_RETRY_MS = field('QUEUE_RETRY_MS');
const FC_HOLD_MS = field('FC_HOLD_MS');
const FC_END_SETTLE_MS = field('FC_END_SETTLE_MS');
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
    FC_HOLD_MS: FC_HOLD_MS,
    FC_END_SETTLE_MS: FC_END_SETTLE_MS,
    // the card screens that are up, by the name the stage keeps (`stageUp`)
    stages: {},
    stageUp(kind) { return !!a.stages[kind]; },
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

/* The wallet's two answers about a bill, as 19-bill-split.js gives them:
 * `splitPending` is nothing once every row is paid, and `splitRecord` is the
 * record until its screen is dismissed. A stub that answered a finished bill
 * from `splitPending` hid the last-share bug below from this file. */
function splitWallet(over, paid) {
  const rows = () => [
    { hash: 'h1', bolt11: 'lnbc1', sats: 1000, paid: paid ? !!paid[0] : true },
    { hash: 'h2', bolt11: 'lnbc2', sats: 1000, paid: paid ? !!paid[1] : false },
  ];
  return Object.assign({
    watched: [],
    splitReconcile() { return Promise.resolve(0); },
    splitRecord() { const r = rows(); return { done: r.every(x => x.paid), ways: 3, total: 3000, rows: r }; },
    splitPending() { const r = this.splitRecord(); return r.rows.every(x => x.paid) ? null : r; },
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
    /* And the wallet itself gives those two answers (19-bill-split.js), which
     * is what the stub above copies. */
    const { loadReal } = require('./harness');
    const real = loadReal({ bridge: () => {} }).W;
    real.splitSave({ ways: 3, total: 3000, at: 1, rows: [
      { hash: 'q1', bolt11: 'lnbc1', sats: 1000, paid: false }, { hash: 'q2', bolt11: 'lnbc2', sats: 1000, paid: false }] });
    real.splitMarkPaid('q1');
    const half = real.splitPending();
    check('the wallet: a bill half collected is pending, and its record says who paid',
      !!half && half.rows[0].paid === true && half.rows[1].paid === false && real.splitRecord().rows.length === 2, JSON.stringify(half));
    real.splitMarkPaid('q2');
    const whole = real.splitRecord();
    check('the wallet: with the last share paid nothing is pending, and the record is still there, finished',
      real.splitPending() === null && !!whole && whole.done === true && whole.rows.every(r => r.paid), JSON.stringify(whole));
    real.splitClear();
    check('the wallet: and it is gone once the bill is cleared', real.splitRecord() === null);
  }
  {
    /* The last share landing that way ends the screen, as the watcher's does.
     * The wallet says nothing is pending by then, which is why the screen
     * reads the record: read from `splitPending`, the last payer of every
     * bill settled this way stayed unticked, with the money in history. */
    const a = app();
    a.state = { screen: 'spWaiting', spWays: 3, spPaid: [true, false], spInvoices: ['lnbc1', 'lnbc2'] };
    global.window = { FoxyWallet: splitWallet(null, [true, true]) };
    check('a finished bill is nothing pending, and still a record', window.FoxyWallet.splitPending() === null && !!window.FoxyWallet.splitRecord());
    a.spSyncPaid();
    check('the last share landing that way finishes the bill',
      a.state.screen === 'spAllPaid' && a.state.spPaid.every(Boolean), JSON.stringify(a.state));
  }
  {
    // a finished record left on file is an earlier bill's: it ticks nothing on the one being collected now
    const a = app();
    a.state = { screen: 'spWaiting', spWays: 3, spPaid: [false, false], spInvoices: ['lnbc8', 'lnbc9'] };
    global.window = { FoxyWallet: splitWallet(null, [true, true]) };
    a.spSyncPaid();
    check('an earlier bill’s finished record ticks nothing on this one',
      a.state.spPaid.every(x => !x) && a.state.screen === 'spWaiting', JSON.stringify(a.state));
    const b = app();
    b.state = { screen: 'spShares', spWays: 3, spPaid: [], spInvoices: [] };
    b.spSyncPaid();
    check('nor on one whose invoices are not made yet', (b.state.spPaid || []).every(x => !x) && b.state.screen === 'spShares', JSON.stringify(b.state));
  }
  {
    /* Paid by its invoice while its own code was on screen: the screen moves,
     * as it does for a share paid over the tap. It stayed where it was. */
    const a = app();
    a.state = { screen: 'spPayer', spIdx: 1, spWays: 3, spPaid: [true, false], spInvoices: ['lnbc1', 'lnbc2'] };
    global.window = { FoxyWallet: splitWallet(null, [true, true]) };
    a.spSyncPaid();
    check('the last payer’s own screen becomes EVERYONE HAS PAID', a.state.screen === 'spAllPaid' && a.state.spPaid.every(Boolean), JSON.stringify(a.state));
    const b = app();
    b.state = { screen: 'spPayer', spIdx: 0, spWays: 3, spPaid: [false, false], spInvoices: ['lnbc1', 'lnbc2'] };
    global.window = { FoxyWallet: splitWallet() };               // row 1 paid, row 2 not
    b.spSyncPaid();
    check('an earlier payer’s screen moves on to the next one still owed', b.state.screen === 'spPayer' && b.state.spIdx === 1, JSON.stringify(b.state));
    const c = app();
    c.state = { screen: 'spPayer', spIdx: 0, spFromWaiting: true, spWays: 3, spPaid: [false, false], spInvoices: ['lnbc1', 'lnbc2'] };
    c.spSyncPaid();
    check('a share opened from the list goes back to the list', c.state.screen === 'spWaiting' && c.state.spFromWaiting === false && c.state.spPaid[0] === true, JSON.stringify(c.state));
    const d = app();
    d.state = { screen: 'spPayer', spIdx: 1, spWays: 3, spPaid: [false, false], spInvoices: ['lnbc1', 'lnbc2'] };
    d.spSyncPaid();
    check('and a screen showing a different share stays on it', d.state.screen === 'spPayer' && d.state.spIdx === 1 && d.state.spPaid[0] === true, JSON.stringify(d.state));
  }
  {
    /* Paid by a card while its own code was on screen (26f-flashcard.js, `fcShareMoved`): the screen moves as it does for a
     * share paid over the tap or by its invoice, and the log says it was by a card. Every tap is its own, so the next
     * payer's screen starts with no code and no payer on the link from the last. */
    const lines = [];
    const log0 = console.log;
    console.log = (...x) => { lines.push(x.join(' ')); };
    const a = app();
    a.state = { screen: 'spPayer', spIdx: 0, spWays: 3, spPaid: [true, false], spInvoices: ['lnbc1', 'lnbc2'], tapShownCode: '4821', tapRecvStage: 'connected' };
    a.spPaidOnScreen(0, 'by card');
    const b = app();
    b.state = { screen: 'spPayer', spIdx: 1, spWays: 3, spPaid: [true, true], spInvoices: ['lnbc1', 'lnbc2'] };
    b.spPaidOnScreen(1, 'by card');
    const c = app();
    c.state = { screen: 'spPayer', spIdx: 0, spFromWaiting: true, spWays: 3, spPaid: [true, false], spInvoices: ['lnbc1', 'lnbc2'] };
    c.spPaidOnScreen(0, 'by card');
    const d = app();
    d.state = { screen: 'spPayer', spIdx: 1, spWays: 3, spPaid: [true, false], spInvoices: ['lnbc1', 'lnbc2'] };
    d.spPaidOnScreen(0, 'by card');
    const e = app();
    e.state = { screen: 'spPayer', spIdx: 0, spWays: 3, spPaid: [true, false], spInvoices: ['lnbc1', 'lnbc2'] };
    e.spPaidOnScreen(0);
    console.log = log0;
    check('a share paid by a card moves its screen on to the next payer, with no code carried over, and the log says how it was paid',
      a.state.screen === 'spPayer' && a.state.spIdx === 1 && a.state.tapShownCode === '' && a.state.tapRecvStage === ''
        && lines.some(l => /share 1 paid by card; on to payer 2/.test(l)), JSON.stringify({ state: a.state, lines }));
    check('the last share paid by a card is EVERYONE HAS PAID', b.state.screen === 'spAllPaid' && lines.some(l => /share 2 paid by card; everyone has paid/.test(l)), JSON.stringify(b.state));
    check('paid by a card, a share opened from the list goes back to the list', c.state.screen === 'spWaiting' && c.state.spFromWaiting === false, JSON.stringify(c.state));
    check('paid by a card, a screen showing a different share stays on it', d.state.screen === 'spPayer' && d.state.spIdx === 1, JSON.stringify(d.state));
    check('a share paid by its invoice is still logged as that', lines.some(l => /share 1 paid by its invoice/.test(l)) && e.state.spIdx === 1, JSON.stringify(lines));
  }
  {
    /* A share paid by a card whose answer came late is ticked by what the ledger says: its row names the card payment's entry
     * (`splitNoteCard`), the reconcile ticks the row when that entry settles, and the screen follows, as it does for a share its invoice
     * paid, said to be by a card. Its invoice, which nobody will pay, is no longer asked about. */
    const lines = [];
    const log0 = console.log;
    console.log = (...x) => { lines.push(x.join(' ')); };
    const ledger = (rows) => ({ splitRecord() { return { done: rows.every(r => r.paid), ways: 3, total: 3000, rows }; } });
    const row = (n, more) => Object.assign({ hash: 'h' + n, bolt11: 'lnbc' + n, sats: 1000, paid: false }, more || {});

    const a = app();
    const stopped = [];
    a.state = { screen: 'spPayer', spIdx: 0, spWays: 3, spPaid: [false, false], spInvoices: ['lnbc1', 'lnbc2'] };
    a._spWatching = 'h1,h2';
    a._spStops = [() => stopped.push('h1'), () => stopped.push('h2')];
    global.window = { FoxyWallet: splitWallet(ledger([row(1, { paid: true, card: 'card-x' }), row(2)])) };
    a.spSyncPaid();
    check('a share the ledger says a card paid is ticked on the screen, which moves on, said to be by a card',
      a.state.spPaid[0] === true && a.state.spPaid[1] === false && a.state.screen === 'spPayer' && a.state.spIdx === 1
        && lines.some(l => /share 1 paid by card; on to payer 2/.test(l)), JSON.stringify({ state: a.state, lines }));
    check('and its invoice is no longer asked about, and the other share’s still is', stopped.join() === 'h1', stopped.join());

    const b = app();
    const stoppedB = [];
    b.state = { screen: 'spPayer', spIdx: 0, spWays: 3, spPaid: [false, false], spInvoices: ['lnbc1', 'lnbc2'] };
    b._spWatching = 'h1,h2';
    b._spStops = [() => stoppedB.push('h1'), () => stoppedB.push('h2')];
    global.window = { FoxyWallet: splitWallet(ledger([row(1, { paid: true }), row(2)])) };
    b.spSyncPaid();
    check('a share its invoice paid is said to be that, and its watcher is left to the watcher',
      b.state.spIdx === 1 && lines.some(l => /share 1 paid by its invoice/.test(l)) && stoppedB.length === 0, JSON.stringify({ spIdx: b.state.spIdx, stopped: stoppedB }));

    const c = app();
    c.state = { screen: 'spWaiting', spWays: 3, spPaid: [true, false], spInvoices: ['lnbc1', 'lnbc2'] };
    global.window = { FoxyWallet: splitWallet(ledger([row(1, { paid: true }), row(2, { paid: true, card: 'card-y' })])) };
    c.spSyncPaid();
    check('the last share landing by a card ends the collecting screen on EVERYONE HAS PAID', c.state.screen === 'spAllPaid' && c.state.spPaid.every(Boolean), JSON.stringify(c.state));

    const d = app();
    d.state = { screen: 'spWaiting', spWays: 3, spPaid: [false, false], spInvoices: ['lnbc1', 'lnbc2'] };
    global.window = { FoxyWallet: splitWallet(ledger([row(1, { card: 'card-z' }), row(2)])) };
    d.spSyncPaid();
    console.log = log0;
    check('a row that names a card payment which has not settled is not ticked: only a row the ledger says is paid is',
      d.state.spPaid.every(x => !x) && d.state.screen === 'spWaiting', JSON.stringify(d.state));
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

  // ---- a card being read or written: what is queued waits, in order, and is raised when it is over --------
  /* A confirmation rose over the Flashcard screen with the phone's card sheet up under it. The queue does not move while a card is
   * being tapped (the sheet or the screen behind it, the pause between two taps, the pieces for a tap being made, a PIN being asked
   * for a tap), loses nothing and does not age; the payment the card flow is itself making is not held by it; and nothing waits
   * for ever. */
  {
    const busy = {
      'a tap in progress, with no screen up': (a) => { a._fcTaps = 1; },
      'the screen behind the sheet': (a) => { a.stages.card = true; },
      'the pieces for a tap being made': (a) => { a.stages.cardReady = true; },
      'the pieces of a card being taken back': (a) => { a.stages.cardBack = true; },
      'a card\'s PIN asked for a tap': (a) => { const pad = { parentNode: {} }; a._fcPadEl = pad; a._pinEl = pad; },
      'a card that asks for the card to be tapped again': (a) => { a._blockedEl = { parentNode: {}, textContent: 'TAP THE CARD AGAIN \u20bf128 came off the card. TAP CARD LATER' }; a._blockedKind = 'fc-part'; },
    };
    for (const name of Object.keys(busy)) {
      const a = app({ state: { screen: 'flashcard' }, _paidQueue: [{ sats: 10, hash: 'a' }, { sats: 20, hash: 'b' }] });
      global.window = { FoxyWallet: {} };
      busy[name](a);
      a.nextPaidScreen();
      check(name + ': a queued confirmation is not raised, is come back for, and does not age',
        a.said.length === 0 && !!a.clock.next() && !a._paidQueue[0].said && a._paidQueue.length === 2, JSON.stringify({ said: a.said, queue: a._paidQueue }));
      a._fcTaps = 0; a.stages = {}; a._fcPadEl = null; a._pinEl = null; a._blockedEl = null; a._blockedKind = '';
      await a.clock.fire();
      check(name + ': when it is over the first of them is raised, in its place',
        a.said.join() === 'announce a' && a._paidQueue[0].hash === 'a' && a._paidQueue.length === 2, JSON.stringify(a.said));
    }
    {
      // a pad that has been taken away, or that another pad has replaced, is not a card flow
      const a = app({ state: { screen: 'home' }, _paidQueue: [{ sats: 10, hash: 'a' }] });
      global.window = { FoxyWallet: {} };
      a._fcPadEl = { parentNode: null };
      a._pinEl = a._fcPadEl;
      check('a PIN pad that is gone is not a card flow', a.cardFlowBusy() === false);
      a._fcPadEl = { parentNode: {} };
      a._pinEl = { parentNode: {} };
      check('nor is another pad (the lock\'s, say) put up in its place', a.cardFlowBusy() === false);
      // a card that is not asking for the card to be tapped is not a card flow: another card, or a card of the screens with a different button
      a._blockedEl = { parentNode: {}, textContent: 'WRONG PIN 2 tries left. TRY AGAIN CANCEL' };
      a._blockedKind = 'fc-wrong-pin';
      check('a card of the card screens that offers TRY AGAIN is not a card being waited for', a.cardFlowBusy() === false);
      a._blockedEl = { parentNode: {}, textContent: 'NOT ENOUGH Your balance. TAP CARD' };
      a._blockedKind = 'netLost';
      check('nor is a card of another part of the app, whatever its button says', a.cardFlowBusy() === false);
      a._blockedEl = { parentNode: null, textContent: 'TAP CARD' };
      a._blockedKind = 'fc-part';
      check('nor is a card that has been taken away', a.cardFlowBusy() === false);
    }
    {
      // the payment the flow is making is the flow's own, and goes on to its own hold
      const a = app({ state: { screen: 'flashcard' }, _fcTaps: 1, _holdConfirmFor: 'card-a', _holdConfirmUntil: Date.now() + 60000,
                      _paidQueue: [{ sats: 10, hash: 'card-a' }, { sats: 20, hash: 'b' }] });
      global.window = { FoxyWallet: {} };
      a.nextPaidScreen();
      check('the confirmation of the very payment the card flow is making is not held by it (the flow\'s own hold has it)',
        a.said.join() === 'announce card-a', JSON.stringify(a.said));
      const b = app({ state: { screen: 'flashcard' }, _fcTaps: 1, _holdConfirmFor: 'card-a', _holdConfirmUntil: Date.now() + 60000,
                      _paidQueue: [{ sats: 20, hash: 'b' }] });
      b.nextPaidScreen();
      check('and another payment\'s is', b.said.length === 0, JSON.stringify(b.said));
      const c = app({ state: { screen: 'flashcard' }, _fcTaps: 1, _holdConfirmFor: 'card-a', _holdConfirmUntil: Date.now() - 1,
                      _paidQueue: [{ sats: 10, hash: 'card-a' }] });
      c.nextPaidScreen();
      check('a hold that has run out names nothing as the flow\'s own', c.said.length === 0, JSON.stringify(c.said));
    }
    {
      // nothing waits for ever: past the longest a confirmation is held for a change tap it goes up whatever is on the screen
      const a = app({ state: { screen: 'flashcard' }, _fcTaps: 1, _paidQueue: [{ sats: 10, hash: 'a' }],
                      announcePayment(ev) { a.said.push('announce ' + ev.hash + (ev.cardDone ? ' (past the wait)' : '')); a.state.screen = 'paid'; } });
      global.window = { FoxyWallet: {} };
      a.nextPaidScreen();
      a._paidQueue[0].held = Date.now() - FC_HOLD_MS - 1000;
      await a.clock.fire();
      check('a card flow that goes on past the longest a confirmation waits does not hold it any longer, and the announcement is told so (it is not held again)',
        a.said.join() === 'announce a (past the wait)', JSON.stringify(a.said));
    }
    {
      // a card screen coming down is what raises them, a moment after: not if the flow has gone straight on to its next screen
      const a = app({ state: { screen: 'flashcard' }, _paidQueue: [{ sats: 10, hash: 'a' }] });
      global.window = { FoxyWallet: {} };
      a.stages.card = true;
      a.cardFlowMayHaveEnded();
      const timer = a.clock.next();
      check('a card screen coming down sets a short wait before anything is raised, not a raise at once', !!timer && timer.ms === FC_END_SETTLE_MS && a.said.length === 0,
        JSON.stringify({ ms: timer && timer.ms, said: a.said }));
      await a.clock.fire(timer);
      check('and if the flow is still going on (the next screen is up) it raises nothing', a.said.length === 0, JSON.stringify(a.said));
      a.stages = {};
      a.cardFlowMayHaveEnded();
      await a.clock.fire(a.clock.next());
      check('and if it is over, the queue is moved on', a.said.join() === 'announce a', JSON.stringify(a.said));
    }
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

  /* A bill is filed against the mint its invoices came from.
   *
   * `splitSave` filled the mint in from wherever the wallet was when the bill
   * was saved. A late claim had the wallet at another mint for the seconds
   * between asking for the invoices and getting them, so the bill was filed
   * against a mint that had never heard of its quotes: two "quote not found"
   * and, from then on, a check that refused to ask the mint that had issued
   * them (from a phone log; the wallet's side is tests/away-claim.js). */
  {
    const a = app({ spSharesArr() { return [1000, 1000]; }, px() { return 100000; }, showPriceError() {}, spMarkPaid() {} });
    a.state = { screen: 'spPayer', spWays: 2, spPaid: [], spTotal: 2000 };
    let saved = null;
    const W = Object.assign(splitWallet(), {
      expiry: { split: 3600 },
      mintUrl: 'https://visited.test',                     // where the wallet is when the bill is saved
      invoice(sats) { return Promise.resolve({ hash: 'q1', bolt11: 'lnbc1', sats: sats, mint: 'https://issued.test' }); },
      splitSave(rec) { saved = rec; return rec; },
    });
    global.window = { FoxyWallet: W };
    a.spMakeInvoices();
    await flush();
    check('a bill is saved with the mint its invoices say issued them, wherever the wallet is by then',
      !!saved && saved.mint === 'https://issued.test' && saved.rows.length === 1 && saved.rows[0].hash === 'q1',
      JSON.stringify(saved && { mint: saved.mint, rows: saved.rows.length }));
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  if (failed) { console.log('\n' + failed + ' watcher re-arm check(s) failed'); process.exit(1); }
  console.log('\nall ' + results.length + ' watcher re-arm checks pass');
}

run().catch(e => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
