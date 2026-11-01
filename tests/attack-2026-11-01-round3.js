'use strict';
/* attack-2026-11-01-round3.js — round three of the attack, on 0271a3f (the round-2 fixes).
 *
 *     node tests/attack-2026-11-01-round3.js
 *
 * Every case but the controls (marked "control") fails on 0271a3f: each is a
 * finding in .claude/audits/attack-2026-11-01-round3.md, named by its letter.
 *
 *   Y  a request payment that throws before its promise chain (W.connect
 *      refuses synchronously: working offline, a mint with no keys on file)
 *      never lets its run token go: every later request is refused "A payment
 *      is still being delivered", every come-home is refused, and reqBusy holds
 *      every mint switch, until the app is restarted
 *   Z  a pass that comes back by itself (`collected`, after finishMove) reads
 *      whichever request is on screen by then: a second request opened while the
 *      first one's owed move was being collected is paid with no PAY pressed,
 *      and the A DIFFERENT MINT card is skipped for it
 *   V  a tap crossing started while a request payment is still out (STOP
 *      WAITING): the sats are moved and the fee paid, then makeTokenForRequest
 *      refuses with a toast; nothing is paid, no card says where the sats are,
 *      the receiver is not told, and the first payment's ending takes the phone
 *      to the mint it was visiting rather than home
 *   O  an on-chain payout from another mint started while a request payment is
 *      still out: its visit writes the visited mint as home, and the first
 *      payment's ending moves the phone off the payout's mint mid-confirmation
 *   Q  a come-home owed (`comeHomeOwed`) fires on any privacy push, in the
 *      middle of an on-chain confirmation quoted at the mint the phone is on
 *   L  a tap request arriving while a request payment is out is dropped with a
 *      toast; the phone that asked is never told
 *
 * The stubbed cases lift methods out of build/foxy-app.js as the round-1 and
 * round-2 attacks do; Y0 runs the real wallet.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function method(sig) {
  const at = app.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = app.indexOf('{', at + sig.length - 1), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) break; }
  }
  return app.slice(at + 3, i + 1);
}
const lift = (sigs) => new Function('return {' + sigs.map(method).join(',\n') + '}')();

const MINE = 'https://forge.flashapp.me';
const THEIRS = 'https://mint.minibits.cash/Bitcoin';
const KASHU = 'https://kashu.example.com';
const NEW = 'https://never-seen.example.net';
const NAMES = { [MINE]: 'Forge', [THEIRS]: 'Minibits', [KASHU]: 'Kashu' };
const canon = (u) => {
  const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(String(u || '').trim());
  return m ? m[1].toLowerCase() + '://' + m[2].toLowerCase().replace(/:443$/, '').replace(/\.+$/, '') + (m[3] || '').replace(/\/+$/, '') : String(u || '');
};

/* The phone of the round-2 attack: on MINE with 2,591, `o.there` at THEIRS, the real crossMove and come-home. */
function phone(o) {
  const opts = o || {};
  const log = { connects: [], cards: [], crossCards: [], quotes: [], pays: [], tokens: [], toasts: [], moves: [], watched: [], told: [] };
  const held = { [MINE]: 2591, [THEIRS]: opts.there || 0, [KASHU]: opts.kashu || 0 };
  const reqs = {};
  const W = {
    mintUrl: MINE,
    mintHost: () => W.mintUrl.replace(/^https:\/\//, ''),
    canonicalMint: canon,
    mints: () => [{ id: MINE }, { id: THEIRS }, { id: KASHU }],
    balanceAt: (u) => held[canon(u)] || 0,
    unclaimedSats: () => 0,
    decodeRequest: (t) => (reqs[t] ? JSON.parse(JSON.stringify(reqs[t])) : null),
    transferQuote: (from, sats, x) => { log.quotes.push({ from, sats, to: x && x.to }); return Promise.resolve({ net: sats, feeSats: 2, to: x.to, from, mintQuote: { quote: 'mq' + log.quotes.length }, meltQuote: { quote: 'lq' + log.quotes.length } }); },
    connect: (u, a, b, x) => {
      if (opts.connect) { const r = opts.connect(u, x); if (r) return r; }
      log.connects.push({ u: canon(u), remember: !(x && x.remember === false) }); W.mintUrl = canon(u); return Promise.resolve({});
    },
    moveRun: (plan, st, x) => W.connect(plan.to, null, null, (x && x.visit) ? { remember: false } : undefined).then(() => {
      log.moves.push({ from: plan.from, to: plan.to, net: plan.net });
      held[canon(plan.to)] = (held[canon(plan.to)] || 0) + plan.net; held[canon(plan.from)] -= plan.net + plan.feeSats; return { sats: plan.net };
    }),
    transactions: () => Promise.resolve([]),
    payRequest: (req) => { log.pays.push({ at: W.mintUrl, id: req.id, sats: req.sats }); return opts.pay ? opts.pay(req, W) : Promise.resolve({ hash: 'h-' + req.id, confirmed: true }); },
    sendToken: (sats) => { log.tokens.push({ at: W.mintUrl, sats }); return Promise.resolve({ hash: 'h2', token: 'cashuB', sats, swapped: true }); },
    sendShortfall: () => ({ short: false, fee: 0 }),
    tapQuote: (j) => { log.told.push(String(j)); return Promise.resolve(); },
    tag: () => {},
    reason: (e) => String((e && e.message) || e),
  };
  global.window = { FoxyWallet: W };
  const a = Object.assign(lift(['makeTokenForRequest(go) {', 'crossComeHome() {', 'comeHomeOwed() {', 'crossMove(plan, theirs, mine, home) {', 'hushMove(plan) {',
    'openRequest(text, opts) {', 'requestHere(req) {', 'tellPayerShort(req) {',
    // the run token's ceiling, the waits a come-home keeps, and the words a refusal under a run says (the round-3 fixes)
    'reqRunLive() {', 'homeWaitsFor() {', 'syncHome() {', 'refuseForRun(viaTap) {']), {
    state: { screen: 'home', stack: [], reqBusy: false, req: null, note: '' },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    offlineNow: () => !!opts.offline,
    refuseSwitchWhileBusy: () => false,
    changeComesBack: () => false,
    twoUnitsOn: () => false,
    crossMintCard(plan, theirs, mine) {
      return Promise.resolve(plan).then((p) => { log.crossCards.push({ net: p.net, fee: p.feeSats, theirs: canon(theirs), mine }); return true; });
    },
    crossFailed(e, mine) { log.crossFailed = { why: String(e && e.message), mine, movePaid: !!(e && e.movePaid) }; },
    showMelt() {}, hideMelt() {}, back() {},
    requestDelivered(req, r) { this.setState({ reqBusy: false, req: null, sendPhase: 'settled' }); },
    refreshBalance() {}, loadHistory() {}, needScanStage() {}, tidyChangeLater() {},
    watchToken(sats, hash) { log.watched.push(hash); },
    toast(t) { log.toasts.push(String(t)); },
    blockedCard(kind, c) { log.cards.push(Object.assign({ kind }, c)); if (kind === 'reqMint' && c.go && !opts.holdCards) setTimeout(c.go, 0); },
    needsMintCard(why) { log.cards.push({ kind: 'needsMint', why }); },
    saidToReceiver: (s) => s,
    shortForReceiver: () => 'The payer does not have enough to cover this payment.',
    group: (n) => String(n), moneyIn: (n) => String(n),
    mintNameOf: (u) => NAMES[canon(u)] || '',
  });
  return { a, W, log, held, reqs };
}
const request = (o) => Object.assign({ id: 'r1', mints: [THEIRS], sats: 1000, unit: 'sat', transports: [{ type: 'post' }],
  delivery: { kind: 'https', target: 'https://donate.example.org/pay' } }, o || {});

/* A first request payment at Minibits, visited from Forge, posted to a website that has not answered yet (a slow exit),
 * and STOP WAITING pressed (24-render-receive-and-send.js `sendStopWaiting`): home, the payment still out. */
async function firstStillOut(p) {
  let answer = null;
  const pay0 = p.W.payRequest;
  p.W.payRequest = (req) => {
    if (req.id !== 'r1') return pay0(req);
    p.log.pays.push({ at: p.W.mintUrl, id: req.id });
    return new Promise((res) => { answer = () => res({ hash: 'h-r1', confirmed: true, website: true }); });
  };
  p.a.setState({ screen: 'reqOffer', stack: ['home'], req: request() });
  p.a.makeTokenForRequest();
  await wait(20);
  p.a.setState({ screen: 'home', stack: [], sendSlow: false, sendPhase: null });
  return () => answer();
}

async function stubbed() {
  console.log('Y. a request payment that throws before its promise chain');
  {
    /* Working offline, a request at a mint with nothing on file for it. The wallet's connect refuses synchronously
     * (11-routing.js `connect`: `if (!cached) assertRoute()`, which throws; Y0 below shows it on the real wallet). */
    const p = phone({ offline: true, holdCards: true, connect: (u) => { if (canon(u) === NEW) throw new Error('Foxy is working offline. This needs a connection — tap OFFLINE to reconnect.'); return null; } });
    p.reqs['creqB-next'] = request({ id: 'r2', mints: [MINE], sats: 50 });
    p.a.setState({ screen: 'reqOffer', stack: ['home'], req: request({ mints: [NEW] }) });
    p.a.makeTokenForRequest();
    const card = p.log.cards.filter((c) => c.kind === 'reqMint')[0];
    ok('Y-control A DIFFERENT MINT is asked first', !!card, JSON.stringify(p.log.cards));
    let threw = null;
    try { card.go(); } catch (e) { threw = e; }
    /* On 0271a3f this threw out of the click handler (it was the control here). USE now behaves as PAY does: the
     * refusal lands in the payment's own ending and is said, and nothing is thrown at the button. */
    ok('Y1 the run token is let go whichever way the payment ends (here: a throw before the chain)',
      !p.a._reqRun && !p.a.state.reqBusy, '_reqRun still ' + JSON.stringify(p.a._reqRun) + ', reqBusy ' + p.a.state.reqBusy);
    ok('Y1b USE throws nothing out of the click', !threw, threw && threw.message);
    await wait(10);
    ok('Y1c and says the payment needs a connection', p.log.toasts.some((t) => /needs a connection/.test(t)), JSON.stringify(p.log.toasts));
    p.a.setState({ screen: 'home', stack: [] });
    p.a.openRequest('creqB-next');
    ok('Y2 and a later request is not refused for it', p.a.state.screen === 'reqOffer' && p.a.state.req && p.a.state.req.id === 'r2',
      'screen ' + p.a.state.screen + ', said: ' + JSON.stringify(p.log.toasts.slice(-1)));
    p.a._crossCameFrom = MINE; p.W.mintUrl = THEIRS;
    p.a.crossComeHome();
    await wait(10);
    ok('Y3 nor is every later come-home', p.W.mintUrl === MINE, 'phone left at ' + p.W.mintUrl + ' (crossComeHome returns while _reqRun is set)');
  }

  console.log('Z. a pass that comes back by itself pays the request that is on screen by then');
  {
    const p = phone({ there: 0 });
    let collect = null;
    let pending = [{ quote: 'mq0', to: THEIRS, amount: 1000 }];
    p.W.pendingMoves = () => pending.slice();
    p.W.finishMove = () => new Promise((res) => { collect = () => { pending = []; p.held[THEIRS] = 1000; res(); }; });
    p.reqs['creqB-r2'] = request({ id: 'r2', mints: [MINE], sats: 100 });
    // r1 at Minibits: PAY, and a move there is paid and not yet collected (nothing on screen says so)
    p.a.setState({ screen: 'reqOffer', stack: ['home'], req: request() });
    p.a.makeTokenForRequest();
    await wait(10);
    ok('Z-control the owed move is being collected, and no payment run has begun', !!collect && !p.a.state.reqBusy && !p.a._reqRun,
      JSON.stringify({ collecting: !!collect, busy: p.a.state.reqBusy }));
    ok('Z0 the offer shows the collect as busy (COLLECTING…), so PAY is not live under it', p.a.state.reqCollecting === true,
      'reqCollecting ' + p.a.state.reqCollecting);
    // the person goes back and opens another code, a request at their own mint; PAY is not pressed
    p.a.setState({ screen: 'home', stack: [], req: null });
    p.a.openRequest('creqB-r2');
    ok('Z-control the second request is on its offer screen', p.a.state.screen === 'reqOffer' && p.a.state.req.id === 'r2', p.a.state.screen);
    collect();
    await wait(30);
    ok('Z1 a request whose PAY was never pressed is not paid', !p.log.pays.some((x) => x.id === 'r2'),
      'paid ' + JSON.stringify(p.log.pays) + ' when r1’s collected move came back');
  }
  {
    const p = phone({ there: 0, holdCards: true });
    let collect = null;
    let pending = [{ quote: 'mq0', to: THEIRS, amount: 1000 }];
    p.W.pendingMoves = () => pending.slice();
    p.W.finishMove = () => new Promise((res) => { collect = () => { pending = []; res(); }; });
    p.reqs['creqB-evil'] = request({ id: 'r3', mints: [NEW], sats: 100 });
    p.a.setState({ screen: 'reqOffer', stack: ['home'], req: request() });
    p.a.makeTokenForRequest();
    await wait(10);
    p.a.setState({ screen: 'home', stack: [], req: null });
    p.a.openRequest('creqB-evil');
    collect();
    await wait(30);
    const asked = p.log.cards.some((c) => c.kind === 'reqMint');
    ok('Z2 and a mint never used is still named in full (A DIFFERENT MINT) before anything is moved there',
      asked || !p.log.crossCards.some((c) => c.theirs === NEW),
      'no A DIFFERENT MINT card; a crossing to ' + NEW + ' was offered straight away: ' + JSON.stringify(p.log.crossCards));
  }

  console.log('V. a tap crossing while a request payment is still out');
  {
    const p = phone({ there: 1500 });
    Object.assign(p.a, lift(['tapCrossQuote(offer, want, theirs, mine, from) {', 'crossRun(plan, offer, theirs, mine, home) {']));
    const end = await firstStillOut(p);
    ok('V-control the first payment is out, on a visit to Minibits', !!p.a._reqRun && p.W.mintUrl === THEIRS && p.a._crossCameFrom === MINE,
      JSON.stringify({ run: !!p.a._reqRun, at: p.W.mintUrl, home: p.a._crossCameFrom }));
    // a tap from somebody at Kashu, where this phone holds nothing (26d-tap.js tapCrossMint → tapCrossQuote; its guard reads moneyMoving only)
    p.reqs['creqB-tap'] = request({ id: 'tap1', mints: [KASHU], sats: 300, delivery: null, transports: [] });
    const offer = { req: 'creqB-tap', mints: [KASHU], read: { sats: 300 } };
    p.a.tapCrossQuote(offer, 300, KASHU, String(p.W.mintUrl));
    await wait(30);
    const moved = p.log.moves.filter((m) => canon(m.to) === KASHU).length;
    const paidTap = p.log.pays.filter((x) => x.id === 'tap1').length;
    const said = p.log.crossFailed || p.log.cards.filter((c) => c.kind === 'theyRefused' || c.kind === 'crossMint').length;
    ok('V1 sats are not moved to their mint (and a routing fee paid) for a payment that is then refused unmade',
      !(moved && !paidTap), moved + ' move(s) to Kashu, ' + paidTap + ' payment(s); said: ' + JSON.stringify(p.log.toasts.slice(-1)) + ', card: ' + JSON.stringify(said || null));
    ok('V2 the receiver is told when the payment will not come', paidTap || p.log.told.some((j) => /gaveUp/.test(j)), 'told the other phone: ' + JSON.stringify(p.log.told));
    ok('V3 the first payment keeps its own hold on mint switches (reqBusy) until it ends', p.a.state.reqBusy === true,
      'reqBusy ' + p.a.state.reqBusy + ' with the first payment still out (crossRun set it false)');
    end();
    await wait(30);
    ok('V4 and when the first one ends the phone is home', p.W.mintUrl === MINE, 'phone at ' + p.W.mintUrl + ' (home was overwritten with the mint being visited)');
  }

  console.log('O. an on-chain payout from another mint while a request payment is still out');
  {
    const p = phone({ there: 1500, kashu: 5000 });
    Object.assign(p.a, lift(['pfOnchainGo(e, shown) {', 'pfOcHome() {', 'pfHere() {', 'pfMint(u) {']));
    const quotedAt = [];
    p.a.ocQuote = () => { quotedAt.push(p.W.mintUrl); };
    p.a.onchainAsk = () => {};
    p.a.pfName = (m) => String(NAMES[canon(m)] || m).toUpperCase();
    const end = await firstStillOut(p);
    // SEND > a bitcoin address > 4,000: only Kashu covers it, so no PAY FROM screen (`pfOnchain`, show false)
    p.a.setState({ screen: 'ocConfirm', ocSats: 4000, ocTo: 'bc1qexample' });
    p.a.pfOnchainGo({ mint: KASHU }, false);
    await wait(10);
    ok('O-control the payout is quoted at Kashu', quotedAt[0] === KASHU && p.a._ocVisit === KASHU, JSON.stringify(quotedAt));
    end();
    await wait(30);
    ok('O1 the first payment ending does not move the phone off the mint the payout on screen was quoted at',
      p.W.mintUrl === KASHU, 'phone moved to ' + p.W.mintUrl + ' under the confirmation (ocPay melts on the connected wallet)');
    p.a.setState({ screen: 'home' });
    p.a.pfOcHome();
    await wait(10);
    ok('O2 and the phone ends at home', p.W.mintUrl === MINE, 'phone ends at ' + p.W.mintUrl + '; home was written as the mint being visited');
  }

  console.log('Q. a come-home owed, made on the next privacy push');
  {
    const p = phone({ there: 1500 });
    p.W.mintUrl = THEIRS;
    p.a._homeOwed = MINE;
    // on Minibits until the next connection (NOT BACK HOME YET); the person sends on chain from here
    p.a.setState({ screen: 'ocConfirm', ocSats: 1000, ocTo: 'bc1qexample', ocPlan: { id: 'oq1', mint: THEIRS } });
    // any push from the native side with Tor up (06-wallet-boot-and-restore.js onPrivacy → claimWhenRouteReturns)
    p.a.comeHomeOwed();
    await wait(10);
    ok('Q1 it waits while a confirmation quoted at this mint is on screen', p.W.mintUrl === THEIRS,
      'phone moved to ' + p.W.mintUrl + ' under an on-chain confirmation quoted at Minibits');
  }

  console.log('L. a tap request while a request payment is still out');
  {
    const p = phone({ there: 1500 });
    const end = await firstStillOut(p);
    p.reqs['creqB-tap2'] = request({ id: 'tap2', mints: [THEIRS], sats: 200, delivery: null, transports: [] });
    p.a.openRequest('creqB-tap2', { viaTap: true });
    ok('L1 the phone that asked is told it will not be paid now', p.log.told.some((j) => /gaveUp/.test(j)),
      'said here: ' + JSON.stringify(p.log.toasts.slice(-1)) + '; told the other phone: ' + JSON.stringify(p.log.told));
    end();
    await wait(20);
  }
}

async function wallet() {
  const { loadReal, nativePhone, PHONE_WORDS } = require('./harness');
  console.log('Y0. the real wallet: connect refuses synchronously with no route and nothing on file');
  const ph = nativePhone({ words: PHONE_WORDS });
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      const got = ph.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { ph.attach(w); },
  });
  const W = ctx.W;
  await W.seedReady();
  W._privacy({ tor: 'off', network: 'none', everUp: true });
  if (W.setOffline) W.setOffline(true);
  let sync = null, async = null;
  try {
    const r = W.connect('https://never-seen.example.net');
    if (r && r.then) await r.then(() => {}, (e) => { async = e; });
  } catch (e) { sync = e; }
  ok('Y0 (control) W.connect throws synchronously, not as a rejection, offline at a mint with no keys on file',
    !!sync && !async, sync ? 'threw: ' + sync.message : async ? 'rejected: ' + async.message : 'neither');
}

async function run() {
  await stubbed();
  await wallet();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
