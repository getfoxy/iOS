'use strict';
/* mint-health.js — a mint that stops answering, and too much at one mint.
 *
 *     node tests/mint-health.js
 *
 * The wallet's half (build/wallet/98-mint-health.js) through nativeRequest and
 * a bridge that answers, refuses or says nothing, with the clock passed in
 * where time matters. The app's half (build/app/11-mint-risk.js) is lifted out
 * of build/foxy-app.js the way cards-logic.js does it, against a stand-in app. */
const fs = require('fs');
const path = require('path');
const { load } = require('./harness');

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));
const MIN = 60000;
const DAY = 86400000;
const MINT = 'https://mint.test/Bitcoin';
const OTHER = 'https://other.test';

/* A wallet whose bridge answers each mint request with box.reply(): a status
 * line and body, or an error string for "no answer". */
function bridged() {
  const box = { reply: () => ['200\n{}', null] };
  const ctx = load({
    bridge: (win, m) => {
      if (m.action !== 'mintRequest') return;
      const [text, err] = box.reply(m);
      setTimeout(() => win.FoxyWallet._scanResult(m.id, text, err), 0);
    },
  });
  ctx.box = box;
  return ctx;
}
const ask = async (W, box, endpoint, text, err) => {
  box.reply = () => [text, err];
  try { await W.nativeRequest({ endpoint, method: 'GET' }); return 'answered'; } catch (e) { return e; }
};
const fails = (W, mint) => { const r = W.mintHealth(mint); return r ? r.failures : 0; };

(async () => {
  // ---- the transport: what counts ------------------------------------------
  {
    const { W, box } = bridged();
    W._privacy({ tor: 'up', everUp: true });
    W._rateAt = Date.now();   // the price answered over Tor just now

    await ask(W, box, MINT + '/v1/keys', null, 'Foxy is not connected to Tor.');
    await ask(W, box, MINT + '/v1/keys', null, 'That is not a mint address Foxy will use.');
    check('a request refused on this side is not put on the mint', W.mintHealth(MINT) === null, JSON.stringify(W.mintHealth(MINT)));

    await ask(W, box, MINT + '/v1/keys', null, 'The request timed out.');
    check('no answer from the mint counts as a failure', fails(W, MINT) === 1, 'failures ' + fails(W, MINT));

    const refusal = await ask(W, box, MINT + '/v1/swap', '400\n{"code":11001,"detail":"Token already spent"}', null);
    const rec = W.mintHealth(MINT);
    check('a mint refusal (400) is an answer: counted OK, failures cleared',
      // the error is from the page's realm, so its status, not instanceof, says it was a refusal
      refusal && refusal.status === 400 && rec && rec.failures === 0 && rec.lastOk > 0, JSON.stringify(rec));

    await ask(W, box, MINT + '/v1/keys', '503\n<html>Service Unavailable</html>', null);
    check('a 503 from a proxy counts as a failure', fails(W, MINT) === 1, 'failures ' + fails(W, MINT));

    await ask(W, box, MINT + '/v1/melt/bolt11', '500\n{"detail":"internal"}', null);
    check('a 500 is the mint answering', fails(W, MINT) === 0, 'failures ' + fails(W, MINT));

    await ask(W, box, 'https://MINT.test:443/Bitcoin/v1/keys', null, 'The network connection was lost.');
    check('the record is kept under the mint\'s one spelling', fails(W, MINT) === 1, JSON.stringify(W.mintHealth(MINT)));
  }

  // ---- a Tor outage is not the mint's ---------------------------------------
  {
    const { W } = bridged();
    const t0 = Date.now();
    const at = (m, kind, mint) => W._noteMintAnswer((mint || MINT) + '/v1/info', kind, t0 + m * MIN);
    W._privacy({ tor: 'connecting', everUp: true });
    W._rateAt = t0;
    at(0, 'fail'); at(5, 'fail'); at(11, 'fail');
    check('failures while Tor is down are not counted, even with a fresh price', W.mintHealth(MINT) === null, JSON.stringify(W.mintHealth(MINT)));

    W._privacy({ tor: 'up', everUp: true });
    W._rateAt = 0;
    at(12, 'fail');
    check('Tor up, nothing else getting through: not counted', W.mintHealth(MINT) === null, JSON.stringify(W.mintHealth(MINT)));

    W._rateAt = t0 + 9 * MIN;
    at(13, 'fail');
    check('a price four minutes old is not recent enough', W.mintHealth(MINT) === null, JSON.stringify(W.mintHealth(MINT)));

    at(14, 'ok');
    at(15, 'fail');
    check('the mint\'s own last answer says nothing about Tor', fails(W, MINT) === 0, JSON.stringify(W.mintHealth(MINT)));

    at(15, 'ok', OTHER);
    at(16, 'fail');
    check('another mint answering over Tor a minute ago: counted', fails(W, MINT) === 1, JSON.stringify(W.mintHealth(MINT)));
  }

  // ---- the threshold, and clearing -------------------------------------------
  {
    const { W, storage } = bridged();
    const told = [];
    W.onMintDown((mint) => told.push(mint));
    W._privacy({ tor: 'up', everUp: true });
    const t0 = Date.now();
    const failAt = (m, mint) => { W._rateAt = t0 + m * MIN; return W._noteMintAnswer((mint || MINT) + '/v1/info', 'fail', t0 + m * MIN); };

    failAt(0); failAt(0.2); failAt(0.5);
    check('a burst inside a minute is one attempt', fails(W, MINT) === 1, 'failures ' + fails(W, MINT));
    failAt(1); failAt(2);
    check('three failures in two minutes: not yet', fails(W, MINT) === 3 && W.mintDown(MINT) === null && !told.length,
      JSON.stringify(W.mintHealth(MINT)));

    const B = 'https://quiet.test';
    failAt(0, B); failAt(20, B);
    check('two failures spanning twenty minutes: not yet', W.mintDown(B) === null, JSON.stringify(W.mintHealth(B)));
    failAt(25, B);
    check('three failures spanning 25 minutes: not answering', W.mintDown(B) !== null, JSON.stringify(W.mintHealth(B)));

    const C = 'https://gone.test';
    failAt(0, C); failAt(5, C);
    check('not answering needs the tenth minute', W.mintDown(C) === null, JSON.stringify(W.mintHealth(C)));
    failAt(10, C);
    const down = W.mintDown(C);
    check('three failures spanning exactly ten minutes: not answering, and the app is told',
      down && down.failures === 3 && down.firstFailAt === t0 && down.lastFailAt === t0 + 10 * MIN && told.indexOf(C) >= 0,
      JSON.stringify(down) + ' told ' + JSON.stringify(told));

    W._noteMintAnswer(C + '/v1/keys', 'ok', t0 + 11 * MIN);
    const after = W.mintHealth(C);
    check('the next answer clears it', W.mintDown(C) === null && after.failures === 0
      && after.firstFailAt === 0 && after.lastOk === t0 + 11 * MIN, JSON.stringify(after));
    const stored = JSON.parse(storage.getItem('foxy.mint.health') || '{}');
    check('kept in localStorage as foxy.mint.health { lastOk, failures, firstFailAt, lastFailAt }',
      stored[C] && ['lastOk', 'failures', 'firstFailAt', 'lastFailAt'].every(k => k in stored[C]), JSON.stringify(stored[C]));
  }

  // ---- the app's cards -------------------------------------------------------------
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
  function field(name) {
    const m = new RegExp('\\n  ' + name + ' = ([^;\\n]+);').exec(src);
    if (!m) throw new Error('missing field ' + name);
    return new Function('return (' + m[1] + ')')();
  }
  const methods = new Function('return {' + [
    method('spreadNudgeDue(sats, host, rec, now, busy) {'),
    method('spreadNudge() {'),
    method('mintQuietSince(t, now) {'),
    method('mintDownText(url) {'),
    // mintDownText asks it: offline, a mint with no cached keysets is unusable
    method('offlineNow() {'),
    method('mintReachable(url) {'),
    method('mintDownNotice(mint) {'),
    // the nudge's MOVE SOME opens the mint list through it (01-ui-basics.js)
    method('goSwitchMint(extra) {'),
  ].join(',\n') + '}')();

  const store = {};
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  let downRec = null;
  global.window = { FoxyWallet: { connected: true, mintUrl: 'https://mint.big.test', mintDown: () => downRec } };
  const cards = [];
  const makeApp = (over) => Object.assign({
    SPREAD_MIN_SATS: field('SPREAD_MIN_SATS'),
    SPREAD_EVERY_MS: field('SPREAD_EVERY_MS'),
    SPREAD_KEY: field('SPREAD_KEY'),
    state: { screen: 'home', stack: [] },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    group: n => Number(n).toLocaleString('en-US'),
    blockedCard(kind, o) { cards.push({ kind, o }); },
    mintHost: () => 'mint.big.test',
    mintPile: () => ({ sats: 250000 }),
  }, methods, over || {});

  const app = makeApp();
  const now = Date.now();
  check('the nudge\'s numbers: 100,000 sats, 30 days, foxy.mint.spread',
    app.SPREAD_MIN_SATS === 100000 && app.SPREAD_EVERY_MS === 30 * DAY && app.SPREAD_KEY === 'foxy.mint.spread',
    [app.SPREAD_MIN_SATS, app.SPREAD_EVERY_MS, app.SPREAD_KEY].join(' '));
  check('99,999 sats at one mint: no nudge', !app.spreadNudgeDue(99999, 'mint.big.test', null, now, false), '');
  check('100,000 sats at one mint: nudge', app.spreadNudgeDue(100000, 'mint.big.test', null, now, false), '');
  check('never on a test mint', !app.spreadNudgeDue(5e6, 'testnut.cashu.space', null, now, false)
    && !app.spreadNudgeDue(5e6, 'nofee.testnut.cashu.space', null, now, false), '');
  check('not again within 30 days', !app.spreadNudgeDue(5e6, 'mint.big.test', { shownAt: now - 29 * DAY }, now, false), '');
  check('again after 30 days', app.spreadNudgeDue(5e6, 'mint.big.test', { shownAt: now - 30 * DAY }, now, false), '');
  check('never once turned off', !app.spreadNudgeDue(5e6, 'mint.big.test', { shownAt: now - 400 * DAY, off: true }, now, false), '');
  check('not while another card is open or waiting', !app.spreadNudgeDue(5e6, 'mint.big.test', null, now, true), '');

  app._readyAt = 0;
  app._blockedEl = {};
  app.spreadNudge();
  check('another card open: nothing shown, nothing stamped', !cards.length && !store['foxy.mint.spread'], JSON.stringify(cards));
  app._blockedEl = null;
  app.spreadNudge();
  const spread = cards[0];
  check('A LOT AT ONE MINT, with MOVE SOME and a way to turn it off',
    spread && spread.kind === 'spread' && spread.o.title === 'A LOT AT ONE MINT' && spread.o.retry === 'MOVE SOME'
      && /250,000 sats/.test(spread.o.reason) && /fail or stop paying out/.test(spread.o.reason)
      && spread.o.also && /SHOW THIS AGAIN/.test(spread.o.also.label),
    JSON.stringify(spread && spread.o));
  spread.o.go();
  check('MOVE SOME opens the mint switch', app.state.screen === 'switchMint', app.state.screen);
  app.spreadNudge();
  check('shown once, not on the next refresh', cards.length === 1, 'cards ' + cards.length);
  spread.o.also.tap();
  check('"don\'t show this again" is stored', JSON.parse(store['foxy.mint.spread']).off === true, store['foxy.mint.spread']);
  delete store['foxy.mint.spread'];
  makeApp({ mintHost: () => 'testnut.cashu.space', _readyAt: 0 }).spreadNudge();
  check('a test mint holding a lot: no card', cards.length === 1, 'cards ' + cards.length);

  const d = new Date(); d.setHours(10, 42, 0, 0);
  check('quiet since: the time today, the date and time before', app.mintQuietSince(d.getTime(), d.getTime() + MIN) === '10:42'
    && app.mintQuietSince(new Date(2026, 8, 12, 10, 42).getTime(), new Date(2026, 8, 13, 9, 0).getTime()) === '12 Sep 10:42',
    app.mintQuietSince(new Date(2026, 8, 12, 10, 42).getTime(), new Date(2026, 8, 13, 9, 0).getTime()));

  downRec = { lastOk: 0, failures: 3, firstFailAt: d.getTime(), lastFailAt: d.getTime() + 10 * MIN };
  check('the switch list says "not answering since 10:42"', app.mintDownText('https://mint.gone.test') === 'not answering since 10:42',
    app.mintDownText('https://mint.gone.test'));
  const empty = makeApp({ mintPile: () => ({ sats: 0 }) });
  empty.mintDownNotice('https://mint.gone.test');
  check('no balance at the silent mint: no card', cards.length === 1, 'cards ' + cards.length);
  const holding = makeApp({ mintPile: () => ({ sats: 12345 }) });
  holding.mintDownNotice('https://mint.gone.test');
  const gone = cards[1];
  check('MINT NOT ANSWERING says how much, where it can be redeemed, that it may come back, and what to do',
    gone && gone.o.title === 'MINT NOT ANSWERING'
      && /mint\.gone\.test has not answered since 10:42/.test(gone.o.reason)
      && /12,345 sats/.test(gone.o.reason)
      && /only ever be redeemed at the mint that issued it/.test(gone.o.reason)
      && /may come back/.test(gone.o.reason) && /still good/.test(gone.o.reason)
      && /nothing else can recover it/.test(gone.o.reason)
      && /move some of your balance to another mint/.test(gone.o.chip)
      && !gone.o.retry,
    JSON.stringify(gone && gone.o));
  holding.mintDownNotice('https://mint.gone.test');
  check('once a session per mint', cards.length === 2, 'cards ' + cards.length);
  downRec = null;
  holding.mintDownNotice('https://mint.back.test');
  check('a mint that is answering: no card, nothing in the list', cards.length === 2 && holding.mintDownText('https://mint.back.test') === '',
    'cards ' + cards.length);

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? failed + ' mint health check(s) failed' : 'all ' + results.length + ' mint health checks pass');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
