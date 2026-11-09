'use strict';
/* paid-bulk.js — two or more payments in one opening of Foxy are one RECEIVED screen (the keeper's 2026-11-06 bulk screen).
 *
 *     node tests/paid-bulk.js
 *
 * The shipped confirmation path, lifted out of build/foxy-app.js: `announcePayment` (12-receive.js), the queue of
 * confirmations and its dismissal (15-paid-wake-keyboard.js), and the screen's values (24-render-receive-and-send.js). The
 * page's own draw is played by a `setState` that applies its updates a moment later, as React does, so a confirmation just
 * raised is not yet on `this.state`.
 *
 *   1. two arrivals on one return (the history pass's queue) are one screen: RECEIVED, the total, a row each, newest first,
 *      with its amount, time, mint and the payer's name or the note
 *   2. one arrival keeps the single RECEIVED screen (DONE)
 *   3. a third arriving while it is up joins the list, by the queue or by the wallet's own word, and the total grows
 *   4. DISMISS goes home, and every payment on it is let go of the queue, once
 *   5. SEE HISTORY: HISTORY, and back from it is home
 *   6. a till is not bulked: each sale has its own screen
 *   7. a payment out still has its own screen after the bulk one; NOW AT a mint where one landed elsewhere
 *   8. a screen it interrupted is still where DISMISS goes
 *   9. the markup: one flash over the whole RECEIVED block, the rows, SEE HISTORY and DISMISS
 *  10. a list is the screen's own: a RECEIVED raised by another way (the receive screen's own invoice) over a bulk or a single
 *      one shows its own payment, and a third joins that one; a CARD MOVED over a bulk is CARD MOVED
 *  11. in the moment before a RECEIVED is drawn, a CARD MOVED raised over it is not joined
 *  12. a payment arriving while DISMISS is on its way waits its turn rather than being raised and swept away
 *  13. DISMISS lets go of the payment it showed, not one waiting at the head of the queue that was never shown
 *  14. a queued receive the screen declined is not asked again every retry
 *  15. a row names the payer as history does (an address in the payment's details, its tag, an exchange)
 *  16. a payment to be swapped into the other unit says so on its row (THEN DOLLARS, THEN BITCOIN)
 *  17. DISMISS tapped twice is one dismissal: a payment after the first one's timer still waits its turn and stays
 *  18. a dismissal that fails part way does not leave arrivals waiting for good
 *  19. one waiting out a dismissal keeps what it is to be swapped into (DOLLARS, THEN BITCOIN) */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const ok = (cond, what, detail) => {
  if (cond) { passed += 1; console.log('ok    ' + what); } else { failed += 1; process.exitCode = 1; console.log('FAIL  ' + what + (detail !== undefined ? ' — ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '..', 'build', 'markup.html'), 'utf8');
function method(sig, optional) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) { if (optional) return ''; throw new Error('missing ' + sig); }
  let i = src.indexOf('{', at + sig.length - 1), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 3, i + 1);
}
const SIGS = ['announcePayment(ev) {', 'nextPaidScreen() {', 'queueLater() {', 'paidDismissed() {', 'renderPaid(c) {', 'renderPaidBase(c) {',
  'renderPaidRest(c, v) {', 'txWhen(t) {', 'txClock(d) {', 'txDay(d, now) {', 'txWho(t) {', 'mintNameOf(url) {', 'shortMintName(raw, url) {', 'mintKnownName(url) {'];
// the bulk screen's own parts, which the base does not have (so its checks fail there rather than the suite throwing)
const NEW = ['paidJoinable(ev) {', 'paidRowOf(ev) {', 'paidRowFromState(p) {', 'paidJoinQueued() {', 'queuedEv(next) {',
  'paidBulkWhen(at, now) {', 'paidBulkTotal(rows) {', 'paidBulkRows(rows) {', 'paidBulkVals(s) {', 'paidDismiss(history) {', 'paidDismissingNow() {'];

const group = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const MINT = 'https://mint.forge.example';

function make(o) {
  const opt = o || {};
  const tags = opt.tags || {};
  const W = {
    mintUrl: MINT, notified: [],
    notify(k) { this.notified.push(k); },
    tagsFor: (h) => tags[h] || {},
    canonicalMint: (u) => String(u || '').replace(/\/+$/, ''),
  };
  const win = { FoxyWallet: W, __foxyClock24: false };
  const doc = { visibilityState: 'visible' };
  const body = SIGS.map((s) => method(s)).concat(NEW.map((s) => method(s, true)).filter(Boolean)).join(',\n');
  const a = new Function('window', 'document', 'CTA_INK', 'CONFIRM_SCREENS', 'return {' + body + '}')(
    win, doc, () => '#fff', ['depConfirm', 'sendConfirm', 'cidConfirm']);
  Object.assign(a, {
    SPLIT_SCREENS: ['spAmount'], QUEUE_RETRY_MS: 60000, PASTE_SETTLE_MS: 10, FC_HOLD_MS: 20000,
    MINT_NAMES: { minibits: 'Minibits', forge: 'Forge' },
    CARD_MEMOS: {}, CARD_NAMED: {}, txCardName: () => '',
    money: (sats) => ({ main: '$ ' + (sats / 1000).toFixed(2), sub: '₿ ' + group(sats), usd: sats / 1000 }),
    unitFigure: (n, u) => (u === 'usd' ? '$ ' + (n / 100).toFixed(2) : '₿ ' + group(n)),
    usd: (v) => v.toFixed(2), group,
    fitStack: () => '', satsStack: () => '', boltField: () => '', paidTargetLabel: () => 'alice@example.com',
    twoUnitsOn: () => false, priceAgeWords: () => '', _lastFee: 0,
    refreshBalance() {}, haptic() {}, hideStage() {}, syncPreview() {}, settleAnimate() {},
    cardFlowHolds: () => false, keepForCardFlow() {}, splitCardEntries: () => ({}),
    secure: 0, offerSecureFoxy() { a.secure += 1; },
    homeState: () => ({ screen: 'amount', stack: [] }),
    mintHost: () => 'mint.forge.example',
    _seenSeeded: true,
    BANK_NAMES: { strike: 'Strike' }, bankName(ex) { return this.BANK_NAMES[ex] || 'the exchange'; },
  });
  a.state = Object.assign({ screen: 'home', stack: [], recv: {}, paidPlace: null, payOut: false }, opt.state || {});
  // the page draws a moment later, as React does: updates wait for the next turn, in order
  let pending = [];
  a.raised = 0;
  a.setState = (x) => {
    pending.push(x);
    if (pending.length > 1) return;
    Promise.resolve().then(() => {
      const list = pending; pending = [];
      list.forEach((u) => {
        const was = a.state.screen;
        Object.assign(a.state, typeof u === 'function' ? u(a.state) : u);
        if (was !== 'paid' && a.state.screen === 'paid') a.raised += 1;
      });
    });
  };
  a.view = () => a.renderPaid({ s: a.state, sc: a.state.screen, sats: 0 });
  a.go = (sc) => a.setState((p) => ({ screen: sc, stack: p.stack.concat([p.screen]) }));
  a.back = () => { const st = a.state.stack; a.state.screen = st.length ? st[st.length - 1] : 'home'; a.state.stack = st.slice(0, -1); };
  a.W = W;
  return a;
}
const tick = () => sleep(0);

// times as history says them: today's and yesterday's, at fixed hours
const today = new Date(); today.setHours(14, 14, 0, 0);
const yest = new Date(today.getTime() - 86400000); yest.setHours(9, 3, 0, 0);
const sec = (d) => Math.floor(d.getTime() / 1000);

(async () => {
  // ---- 1. two on one return -------------------------------------------------------------------------------------
  {
    const a = make({ tags: { h2: { note: 'for lunch' } } });
    // the history pass queues them oldest first (16-history-lists.js)
    a._paidQueue = [
      { hash: 'h1', dir: 'in', sats: 2100, at: sec(yest), mint: MINT, memo: 'From Alice' },
      { hash: 'h2', dir: 'in', sats: 0, unit: 'usd', amount: 592, at: sec(today), mint: MINT, memo: '' },
    ];
    a.nextPaidScreen();
    await tick();
    const v = a.view();
    const rows = v.paidBulkRows || [];
    ok(a.state.screen === 'paid' && a.raised === 1, '1: one screen for two payments', 'raised ' + a.raised);
    ok(!!v.isPaidIn && !!v.isPaidBulk && rows.length === 2, '1: the bulk RECEIVED, with a row each', JSON.stringify({ i: v.isPaidIn, b: v.isPaidBulk, n: rows.length }));
    ok(v.paidRestTitle === 'RECEIVED' && /^\$ 8\.02$/.test(String(v.paidHeadline)) && v.paidRestSize === '76px',
      '1: RECEIVED, and the total ($ 2.10 + $ 5.92) at 76px', v.paidHeadline + ' ' + v.paidRestSize);
    ok(rows[0] && rows[0].amt === '$ 5.92' && rows[1] && rows[1].amt === '$ 2.10' && rows[1].sub === '₿ 2,100',
      '1: newest first, each in its own unit, the other unit under a bitcoin one', JSON.stringify(rows.map((r) => [r.amt, r.sub])));
    ok(rows[0] && rows[0].time === '2:14 PM' && rows[1] && rows[1].time === 'Yesterday 9:03 AM',
      '1: the times as history says them', JSON.stringify(rows.map((r) => r.time)));
    ok(rows.every((r) => r.mint === 'Forge'), '1: the mint each went into', JSON.stringify(rows.map((r) => r.mint)));
    ok(rows[1] && rows[1].who === 'From Alice' && rows[0] && rows[0].who === 'for lunch',
      '1: the payer’s name (a Foxy ID) or the note', JSON.stringify(rows.map((r) => r.who)));
    ok(v.paidRestDone === 'DISMISS' && typeof v.paidSeeHistory === 'function' && typeof v.dismissPaid === 'function',
      '1: DISMISS and SEE HISTORY', v.paidRestDone);
    ok(a._paidQueue.length === 2 && a._paidQueue.every((q) => q.said), '1: both stay queued until dismissed, each said');

    // ---- 3. a third joins while it is up ----------------------------------------------------------------------------
    a._paidQueue.push({ hash: 'h3', dir: 'in', sats: 1000, at: sec(today) + 60, mint: MINT, memo: '' });
    a.nextPaidScreen();
    await tick();
    let v3 = a.view();
    ok(a.raised === 1 && (v3.paidBulkRows || []).length === 3 && v3.paidHeadline === '$ 9.02',
      '3: a third from the history pass joins the list, the total grows', JSON.stringify({ r: a.raised, n: (v3.paidBulkRows || []).length, h: v3.paidHeadline }));
    // and one the wallet says itself (a Foxy ID payment collected, a tap)
    a.announcePayment({ dir: 'in', sats: 500, hash: 'h4', at: sec(today) + 120, memo: 'From Bob' });
    await tick();
    v3 = a.view();
    ok(a.raised === 1 && (v3.paidBulkRows || []).length === 4 && v3.paidBulkRows[0].who === 'From Bob' && v3.paidHeadline === '$ 9.52',
      '3: one the wallet announces joins too, at the top', JSON.stringify({ r: a.raised, n: (v3.paidBulkRows || []).length }));
    a.announcePayment({ dir: 'in', sats: 500, hash: 'h4', at: sec(today) + 120 });
    await tick();
    ok((a.view().paidBulkRows || []).length === 4, '3: the same payment said twice is one row');

    // ---- 4. DISMISS -------------------------------------------------------------------------------------------------
    a.view().dismissPaid();
    await sleep(520);
    await tick();
    ok(a.state.screen === 'home' && !a.state.paidBulk && !a.state.paidRow, '4: DISMISS goes home, the list gone with it', a.state.screen);
    ok(a._paidQueue.length === 0, '4: every payment on it is let go of the queue', JSON.stringify(a._paidQueue.map((q) => q.hash)));
    await sleep(600);
    ok(a.state.screen === 'home' && a.raised === 1 && a.secure === 1, '4: nothing raised again after it; SECURE FOXY asked once', JSON.stringify({ s: a.state.screen, r: a.raised, f: a.secure }));
  }

  // ---- 2. one arrival -------------------------------------------------------------------------------------------
  {
    const a = make();
    a._paidQueue = [{ hash: 'o1', dir: 'in', sats: 2100, at: sec(today), mint: MINT }];
    a.nextPaidScreen();
    await tick();
    const v = a.view();
    ok(v.isPaidIn && !v.isPaidBulk && v.paidRestDone === 'DONE' && v.paidHeadline === '$ 2.10',
      '2: one payment keeps the single RECEIVED screen, DONE', JSON.stringify({ b: v.isPaidBulk, d: v.paidRestDone }));
    v.dismissPaid();
    await sleep(520);
    await tick();
    ok(a.state.screen === 'home' && a._paidQueue.length === 0, '2: DONE goes home and lets it go');
  }

  // ---- 5. SEE HISTORY -------------------------------------------------------------------------------------------
  {
    const a = make();
    a.announcePayment({ dir: 'in', sats: 100, hash: 's1', at: sec(today) });
    a.announcePayment({ dir: 'in', sats: 200, hash: 's2', at: sec(today) + 5 });
    await tick();
    const v = a.view();
    ok(a.raised === 1 && (v.paidBulkRows || []).length === 2, '5: two said by the wallet in a row are one screen too', JSON.stringify({ r: a.raised }));
    if (typeof v.paidSeeHistory === 'function') v.paidSeeHistory();
    await sleep(520);
    await tick();
    ok(a.state.screen === 'history' && JSON.stringify(a.state.stack) === '["home"]' && !a.state.paidBulk,
      '5: SEE HISTORY opens HISTORY over home', JSON.stringify({ s: a.state.screen, st: a.state.stack }));
    a.back();
    ok(a.state.screen === 'home', '5: back from HISTORY is home', a.state.screen);
  }

  // ---- 6. a till ------------------------------------------------------------------------------------------------
  {
    const a = make({ state: { screen: 'amount', till: { role: 'keeper', since: 0 } } });
    a.announcePayment({ dir: 'in', sats: 100, hash: 't1', at: sec(today) });
    await tick();
    a.announcePayment({ dir: 'in', sats: 200, hash: 't2', at: sec(today) + 5 });
    await tick();
    const v = a.view();
    ok(!v.isPaidBulk && !a.state.paidBulk && a.state.paidAmount === 200, '6: a till shows each sale on its own screen', JSON.stringify({ b: v.isPaidBulk, amt: a.state.paidAmount }));
    a._paidQueue = [{ hash: 't3', dir: 'in', sats: 300, at: sec(today) }];
    a.nextPaidScreen();
    await tick();
    ok(a.state.paidAmount === 200 && !a._paidQueue[0].said, '6: and a queued one waits its turn, as before');
  }

  // ---- 7. a payment out after it; NOW AT ------------------------------------------------------------------------
  {
    const a = make();
    a._paidQueue = [
      { hash: 'n1', dir: 'in', sats: 100, at: sec(today), mint: MINT },
      { hash: 'n2', dir: 'out', sats: 50, at: sec(today) + 2, mint: MINT },
      { hash: 'n3', dir: 'in', sats: 300, at: sec(today) + 4, mint: MINT },
    ];
    a.nextPaidScreen();
    await tick();
    a.announcePayment({ dir: 'in', sats: 700, hash: 'n4', at: sec(today) + 6, awayAt: 'https://mint.minibits.example' });
    await tick();
    const v = a.view();
    const rows = v.paidBulkRows || [];
    ok(rows.length === 3 && rows.map((r) => r.amt).join() === '$ 0.70,$ 0.30,$ 0.10', '7: the ones in join; the one out does not', JSON.stringify(rows.map((r) => r.amt)));
    ok(rows[0] && rows[0].mint === 'NOW AT Minibits', '7: NOW AT the mint a payment landed at', rows[0] && rows[0].mint);
    v.dismissPaid();
    // (home after 450 ms, the next in the queue 520 ms after that)
    await sleep(1100);
    await tick();
    ok(a.state.screen === 'paid' && a.state.payOut && a._paidQueue.length === 1 && a._paidQueue[0].hash === 'n2',
      '7: the payment out is raised after it, on its own', JSON.stringify({ s: a.state.screen, q: a._paidQueue.map((q) => q.hash) }));
  }

  // ---- 8. over a screen it interrupted ----------------------------------------------------------------------------
  {
    const a = make({ state: { screen: 'switchMint', stack: ['home'] } });
    a.announcePayment({ dir: 'in', sats: 100, hash: 'i1', at: sec(today) });
    await tick();
    a.announcePayment({ dir: 'in', sats: 200, hash: 'i2', at: sec(today) + 5 });
    await tick();
    ok((a.view().paidBulkRows || []).length === 2 && a._returnTo && a._returnTo.screen === 'switchMint',
      '8: the screen it was raised over is kept', JSON.stringify(a._returnTo));
    a.view().dismissPaid();
    await sleep(520);
    await tick();
    ok(a.state.screen === 'switchMint', '8: DISMISS goes back to it', a.state.screen);
  }

  // ---- 10. a list is the screen's own ------------------------------------------------------------------------------
  for (const two of [true, false]) {
    const a = make({ state: { screen: 'receive', stack: ['home'] } });
    a.announcePayment({ dir: 'in', sats: 100, hash: 'q1', at: sec(today) });
    if (two) a.announcePayment({ dir: 'in', sats: 200, hash: 'q2', at: sec(today) });
    await tick();
    a._paidOpenAt = 0;
    // the receive screen's own invoice paid, as 12-receive.js raises it (its watch), with no row or list of its own
    a.setState((p) => ({ screen: 'paid', stack: p.stack.concat([p.screen]), recvResolved: true, paidUnit: 'sat', paidAmount: 5000, paidHash: 'inv', paidPlace: null, recv: Object.assign({}, p.recv, { live: 'in' }) }));
    await tick();
    let v = a.view();
    const what = two ? '10: over a bulk RECEIVED' : '10: over a single RECEIVED';
    ok(!v.isPaidBulk && v.paidHeadline === '$ 5.00', what + ', the invoice paid shows its own payment', JSON.stringify({ b: v.isPaidBulk, h: v.paidHeadline }));
    const r = a.announcePayment({ dir: 'in', sats: 700, hash: 'q3', at: sec(today) });
    await tick();
    v = a.view();
    const amts = (v.paidBulkRows || []).map((x) => x.amt).sort().join();
    ok(r === 'joined' && v.isPaidBulk && amts === '$ 0.70,$ 5.00' && v.paidHeadline === '$ 5.70',
      what + ', then a third joins the invoice (not the earlier payment)', JSON.stringify({ r, amts, h: v.paidHeadline }));
  }
  {
    const a = make();
    a.announcePayment({ dir: 'in', sats: 100, hash: 'c1', at: sec(today) });
    a.announcePayment({ dir: 'in', sats: 200, hash: 'c2', at: sec(today) });
    await tick();
    a._paidOpenAt = 0;
    // a card's TRANSFER raised over it (26f-flashcard.js `fcMovedScreen`, a setState of its own)
    a.setState({ paidSays: 'CARD MOVED', paidPlace: { label: 'NOW AT', to: 'Minibits', dismiss: 'DONE' }, paidUnit: 'usd', paidAmount: 1994 });
    await tick();
    const v = a.view();
    ok(!v.isPaidBulk && v.paidRestTitle === 'CARD MOVED' && v.paidRestDone === 'DONE' && v.paidHeadline === '$ 19.94',
      '10: a CARD MOVED over a bulk RECEIVED is CARD MOVED, with its own button', JSON.stringify({ b: v.isPaidBulk, t: v.paidRestTitle, d: v.paidRestDone, h: v.paidHeadline }));
  }

  // ---- 11. CARD MOVED in the moment before a RECEIVED is drawn --------------------------------------------------------
  {
    const a = make();
    a.announcePayment({ dir: 'in', sats: 100, hash: 'b1', at: sec(today) });
    await tick();
    a.setState({ paidSays: 'CARD MOVED', paidPlace: { label: 'NOW AT', to: 'Minibits', dismiss: 'DONE' }, paidUnit: 'usd', paidAmount: 1994 });
    await tick();
    const joinable = a.paidJoinable ? a.paidJoinable({ dir: 'in', sats: 200, hash: 'b2' }) : null;
    const v = a.view();
    ok(joinable === false && v.paidRestTitle === 'CARD MOVED' && !v.isPaidBulk, '11: CARD MOVED inside the moment stays CARD MOVED, not joinable', JSON.stringify({ joinable, t: v.paidRestTitle }));
    const r = a.announcePayment({ dir: 'in', sats: 200, hash: 'b2', at: sec(today) + 5 });
    await tick();
    ok(r !== 'joined' && !a.state.paidBulk && a.state.paidAmount === 200, '11: the next receive is said on its own screen, not swallowed by CARD MOVED', JSON.stringify({ r, amt: a.state.paidAmount }));
  }

  // ---- 12. arriving while DISMISS is on its way ------------------------------------------------------------------
  {
    const a = make();
    a.announcePayment({ dir: 'in', sats: 100, hash: 'd1', at: sec(today) });
    a.announcePayment({ dir: 'in', sats: 200, hash: 'd2', at: sec(today) });
    await tick();
    a.view().dismissPaid();
    await sleep(100);
    const r = a.announcePayment({ dir: 'in', sats: 300, hash: 'd3', at: sec(today) });
    await tick();
    ok(r !== 'shown' && a.state.paidAmount !== 300 && (a._paidQueue || []).some((q) => q.hash === 'd3'), '12: it waits in the queue', JSON.stringify({ r, amt: a.state.paidAmount }));
    await sleep(450);
    await tick();
    ok(a.state.screen === 'home', '12: DISMISS still lands home', a.state.screen);
    await sleep(600);
    await tick();
    ok(a.state.screen === 'paid' && a.state.paidAmount === 300 && !a.state.paidBulk && a.raised === 2, '12: and is raised after it, on its own', JSON.stringify({ s: a.state.screen, amt: a.state.paidAmount, r: a.raised }));
  }

  // ---- 13. DISMISS lets go of what it showed ---------------------------------------------------------------------
  {
    const a = make();
    let held = true;
    a.cardFlowHolds = (q) => held && !!q && q.hash === 'e1';
    a._paidQueue = [{ hash: 'e1', dir: 'in', sats: 100, at: sec(today) }, { hash: 'e2', dir: 'in', sats: 200, at: sec(today) }];
    a.announcePayment({ dir: 'in', sats: 50, hash: 'e0', at: sec(today) });
    await tick();
    a.nextPaidScreen();
    await tick();
    ok((a.view().paidBulkRows || []).length === 2 && !a._paidQueue[0].said, '13: the one a card flow holds is not joined', JSON.stringify(a._paidQueue.map((q) => [q.hash, !!q.said, !!q.bulked])));
    held = false;
    a.view().dismissPaid();
    await sleep(1100);
    await tick();
    ok(a.state.screen === 'paid' && a.state.paidAmount === 100 && a._paidQueue.length === 1 && a._paidQueue[0].hash === 'e1',
      '13: the held one is not dropped: it is raised once the screen is dismissed', JSON.stringify({ s: a.state.screen, amt: a.state.paidAmount, q: a._paidQueue.map((q) => q.hash) }));
  }

  // ---- 14. a declined queued receive -----------------------------------------------------------------------------
  {
    const a = make();
    let n = 0;
    a.announcePayment({ dir: 'in', sats: 100, hash: 'f1', at: sec(today) });
    await tick();
    a.refreshBalance = () => { n += 1; };
    a._quiet = true;
    a._paidQueue = [{ hash: 'f2', dir: 'in', sats: 100, at: sec(today) }];
    for (let i = 0; i < 5; i++) a.nextPaidScreen();
    ok(n <= 1 && !a._paidQueue[0].said && !a._paidQueue[0].bulked, '14: asked once over five retries, and left for its own turn', 'asked ' + n);
  }

  // ---- 15. the payer's name as history gives it ------------------------------------------------------------------
  {
    const a = make({ tags: { l2: { to: 'Carol' }, l3: { bank: 'strike' } } });
    a._paidQueue = [
      { hash: 'l1', dir: 'in', sats: 100, at: sec(today), mint: MINT, memo: '', extra: { payer: 'bob@example.com' } },
      { hash: 'l2', dir: 'in', sats: 200, at: sec(today) + 1, mint: MINT, memo: 'Foxy' },
      { hash: 'l3', dir: 'in', sats: 300, at: sec(today) + 2, mint: MINT, memo: '' },
    ];
    a.nextPaidScreen();
    await tick();
    const who = (a.view().paidBulkRows || []).map((x) => x.amt + '=' + x.who).sort().join();
    ok(who === '$ 0.10=bob@example.com,$ 0.20=Carol,$ 0.30=To Strike', '15: an address in its details, its tag, an exchange', who);
  }

  // ---- 16. THEN DOLLARS / THEN BITCOIN ---------------------------------------------------------------------------
  {
    const a = make();
    a.twoUnitsOn = () => true;
    a.announcePayment({ dir: 'in', sats: 2100, hash: 'v1', at: sec(today), askConvert: true, usdAsked: 210, askAgeMs: 0 });
    a.announcePayment({ dir: 'in', sats: 0, unit: 'usd', amount: 150, hash: 'v2', at: sec(today) + 1, satsAsked: 1500, askConvert: true, askAgeMs: 0 });
    a.announcePayment({ dir: 'in', sats: 300, hash: 'v3', at: sec(today) + 2 });
    await tick();
    const subs = (a.view().paidBulkRows || []).map((x) => x.amt + '=' + x.sub + '/' + x.subOn).join(' | ');
    ok(subs === '$ 0.30=₿ 300/true | $ 1.50=THEN BITCOIN/true | $ 2.10=₿ 2,100 · THEN DOLLARS/true', '16: a converted row says where it goes next', subs);
  }

  // ---- 17. DISMISS tapped twice --------------------------------------------------------------------------------------
  {
    const a = make();
    a.announcePayment({ dir: 'in', sats: 100, hash: 'x1', at: sec(today) });
    a.announcePayment({ dir: 'in', sats: 200, hash: 'x2', at: sec(today) });
    await tick();
    const v = a.view();
    v.dismissPaid();
    await sleep(60);
    v.dismissPaid();
    await sleep(410);
    a.announcePayment({ dir: 'in', sats: 300, hash: 'x3', at: sec(today) });
    await sleep(1200);
    await tick();
    ok(a.state.screen === 'paid' && a.state.paidAmount === 300, '17: two taps 60 ms apart, a payment at 470 ms is raised and stays', JSON.stringify({ s: a.state.screen, amt: a.state.paidAmount }));
  }

  // ---- 18. a dismissal that throws -----------------------------------------------------------------------------------
  {
    const a = make();
    a.announcePayment({ dir: 'in', sats: 100, hash: 'y1', at: sec(today) });
    await tick();
    a.settleAnimate = () => { throw new Error('settle failed'); };
    const errs = [];
    const onErr = (e) => errs.push(e);
    process.on('uncaughtException', onErr);
    a.view().dismissPaid();
    await sleep(520);
    process.removeListener('uncaughtException', onErr);
    a.state.screen = 'home'; a.state.stack = [];
    const r = a.announcePayment({ dir: 'in', sats: 200, hash: 'y2', at: sec(today) });
    await tick();
    ok(errs.length === 1 && r === 'shown' && a.state.screen === 'paid' && a.state.paidAmount === 200,
      '18: settleAnimate throws, the next arrival is still raised', JSON.stringify({ errs: errs.length, r, amt: a.state.paidAmount }));
  }

  // ---- 19. a converted payment waiting out a dismissal -------------------------------------------------------------
  {
    const a = make();
    a.announcePayment({ dir: 'in', sats: 100, hash: 'z1', at: sec(today) });
    await tick();
    a.view().dismissPaid();
    await sleep(100);
    a.announcePayment({ dir: 'in', sats: 0, unit: 'usd', amount: 150, hash: 'z2', at: sec(today), satsAsked: 1500, askConvert: true, askAgeMs: 0 });
    await sleep(1100);
    await tick();
    const v = a.view();
    ok(a.state.screen === 'paid' && a.state.paidConvert === true && v.paidAddedTo === 'DOLLARS, THEN BITCOIN',
      '19: a dollar card’s payment for sats asked, arriving during DISMISS, shows DOLLARS, THEN BITCOIN', JSON.stringify({ c: a.state.paidConvert, to: v.paidAddedTo }));
  }

  // ---- 9. the markup ----------------------------------------------------------------------------------------------
  const inBlock = (markup.split('<sc-if value="{{ isPaidIn }}">')[1] || '').split('<sc-if value="{{ isPaidOut }}">')[0];
  const bulk = (inBlock.split('<sc-if value="{{ isPaidBulk }}">')[1] || '');
  ok(!!bulk && (inBlock.match(/\{\{ paidBoltFlash \}\}/g) || []).length === 1 && inBlock.indexOf('{{ paidBoltFlash }}') < inBlock.indexOf('{{ isPaidBulk }}'),
    '9: the bulk list is inside the RECEIVED block, under its one flash (it plays once)');
  ok(/<sc-for list="\{\{ paidBulkRows \}\}" as="r"/.test(bulk) && /\{\{ r\.amt \}\}/.test(bulk) && /\{\{ r\.time \}\}/.test(bulk) && /\{\{ r\.mint \}\}/.test(bulk) && /\{\{ r\.who \}\}/.test(bulk),
    '9: a row each: amount, time, mint, name or note');
  ok(/sc-camel-on-click="\{\{ paidSeeHistory \}\}"[^>]*>SEE HISTORY</.test(bulk) && /sc-camel-on-click="\{\{ dismissPaid \}\}"[^>]*>\{\{ paidRestDone \}\}/.test(bulk),
    '9: SEE HISTORY and DISMISS at the foot');
  ok(/\{\{ paidRestTitle \}\}/.test(bulk) && /font-size:\{\{ paidRestSize \}\}[^>]*>\{\{ paidHeadline \}\}/.test(bulk) && /stroke="#5FD58C"/.test(bulk),
    '9: RECEIVED, the total and the tick circle over the list');
  ok(/overflow-y:auto/.test(bulk), '9: the list scrolls when it is long');

  console.log(passed + ' passed, ' + failed + ' failed');
  // (the queue's retry timer is the app's own, a minute long here: nothing is waited for past the checks)
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + (e && e.stack)); process.exit(1); });
