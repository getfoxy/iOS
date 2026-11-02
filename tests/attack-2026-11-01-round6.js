'use strict';
/* attack-2026-11-01-round6.js — round six of the attack, on c210639 (the round-5 fixes).
 *
 *     node tests/attack-2026-11-01-round6.js
 *
 * Every case but the controls (marked "control") fails on c210639: each is a
 * finding in .claude/audits/attack-2026-11-01-round6.md, named by its letter.
 *
 *   M1 a Lightning invoice made at the mint the phone is visiting is asked
 *      about only while the phone is on that mint (15-receiving.js `watch`
 *      `madeAt`, `_sweepQuotesOnce` "only this mint's quotes"): paid after the
 *      phone is home, it is never claimed from home. Round 5 gave on-chain
 *      addresses an away claim and Lightning nothing. And the trip's own
 *      retry still goes under an invoice being made (`_watching` is set only
 *      once the mint has answered).
 *   M2 the on-chain limits on screen (`ocLimits`, the floor) are the last mint
 *      `onchainAsk` was asked at: a PAY FROM visit sets the visited mint's,
 *      and back home the receive screen says that mint's floor over an
 *      address made at home.
 *   L1 an on-chain deposit claimed away (`onchainClaimAway`) is announced at
 *      home as PAYMENT RECEIVED, ADDED TO the balance, naming no mint, with
 *      the sats in another mint's pile.
 *   L2 a token-to-show payment queued behind the trip (`afterHome`) leaves the
 *      phone at the mint it visited for the rest of the session.
 *   L3 the queued request payment goes out after the person has left its
 *      offer (BACK, the edge swipe): only a changed `state.req` drops it.
 *   L4 the trip's 2-second retry does not ask `_homeGoing`: a second trip is
 *      begun under one already out.
 *   L5 an on-chain address being made (`_ocMaking`) does not hold the trip.
 *
 * Methods are lifted out of build/foxy-app.js, as rounds 1-5 do; M1a runs the
 * real wallet against fake mints (tests/harness.js).
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
const NAMES = { [MINE]: 'Forge', [THEIRS]: 'Minibits' };
const canon = (u) => {
  const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(String(u || '').trim());
  return m ? m[1].toLowerCase() + '://' + m[2].toLowerCase().replace(/:443$/, '').replace(/\.+$/, '') + (m[3] || '').replace(/\/+$/, '') : String(u || '');
};

/* The phone of round 5: on MINE, `o.there` at THEIRS, the real come-home machinery, request payment, PAY FROM's
 * on-chain visit, and here the on-chain receive screen's limits and address. */
function phone(o) {
  const opts = o || {};
  const log = { connects: [], cards: [], toasts: [], told: [], quotes: [], tokens: [], invoices: [], paid: [], addrs: [] };
  const held = { [MINE]: 2591, [THEIRS]: opts.there || 0 };
  const reqs = {};
  const limits = opts.limits || {};
  const W = {
    mintUrl: MINE,
    connected: true,
    mintHost: () => W.mintUrl.replace(/^https:\/\//, ''),
    canonicalMint: canon,
    mints: () => [{ id: MINE }, { id: THEIRS }],
    balanceAt: (u) => held[canon(u)] || 0,
    decodeRequest: (t) => (reqs[t] ? JSON.parse(JSON.stringify(reqs[t])) : null),
    connect: (u, a, b, x) => {
      if (opts.connect) { const r = opts.connect(u, x); if (r) return r; }
      log.connects.push({ u: canon(u), remember: !(x && x.remember === false) }); W.mintUrl = canon(u); return Promise.resolve({});
    },
    transactions: () => Promise.resolve([]),
    payRequest: (req) => { log.paid.push({ id: req.id, at: W.mintUrl }); return Promise.resolve({ hash: 'h-' + req.id, confirmed: true }); },
    sendToken: (sats) => { log.tokens.push({ at: W.mintUrl, sats }); return Promise.resolve({ hash: 'h2', token: 'cashuB', sats, swapped: true }); },
    sendShortfall: () => ({ short: false, fee: 0 }),
    tapQuote: (j) => { log.told.push(String(j)); return Promise.resolve(); },
    onchainLimits: () => Promise.resolve(limits[W.mintUrl] || null),
    onchainAddress: () => {
      const at = W.mintUrl;
      const made = { quote: 'q-' + log.addrs.length, address: 'bc1q' + (at === MINE ? 'home' : 'visited') + log.addrs.length, mint: at };
      log.addrs.push(made);
      return opts.addrLater ? new Promise((r) => { opts.addrLater.done = () => r(made); }) : Promise.resolve(made);
    },
    tag: () => {},
    reason: (e) => String((e && e.message) || e),
  };
  global.window = { FoxyWallet: W };
  const a = Object.assign(lift(['reqMints(req) {', 'reqCanon(u) {', 'reqPayMint(req) {', 'makeTokenForRequest(go) {', 'crossComeHome() {', 'comeHomeOwed() {',
    'openRequest(text, opts) {', 'requestHere(req) {', 'tellPayerShort(req) {',
    'reqRunLive() {', 'homeWaitsFor() {', 'syncHome() {', 'refuseForRun(viaTap) {',
    'pfOnchainGo(e, shown) {', 'pfOcHome() {', 'pfHere() {', 'pfMint(u) {', 'pfName(mint) {', 'openReceive() {',
    'onchainAsk() {', 'ocCan(which) {', 'ocReceiveAddress() {', 'ocReceiveNote() {', 'ocReceiveBlocked(sats) {']), {
    state: { screen: 'home', stack: [], reqBusy: false, req: null, note: '' },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    offlineNow: () => false,
    refuseSwitchWhileBusy: () => false,
    changeComesBack: () => false,
    twoUnitsOn: () => false,
    crossFailed(e) { log.crossFailed = String(e && e.message); },
    showMelt() {}, hideMelt() {}, back() {},
    requestDelivered(req, r) { this.setState({ reqBusy: false, req: null, sendPhase: 'settled' }); },
    refreshBalance() {}, loadHistory() {}, needScanStage() {}, tidyChangeLater() {},
    watchToken() {},
    onchainWatchLater() {},
    ocQuote() { log.quotes.push(W.mintUrl); },
    stopReceive() {},
    openReceiveNow() { log.invoices.push(W.mintUrl); },
    toast(t) { log.toasts.push(String(t)); },
    blockedCard(kind, c) { log.cards.push(Object.assign({ kind }, c)); },
    needsMintCard(why) { log.cards.push({ kind: 'needsMint', why }); },
    saidToReceiver: (s) => s,
    shortForReceiver: () => 'The payer does not have enough to cover this payment.',
    group: (n) => String(n), moneyIn: (n) => String(n),
    mintNameOf: (u) => NAMES[canon(u)] || '',
  });
  return { a, W, log, held, reqs };
}
const request = (o) => Object.assign({ id: 'r1', mints: [THEIRS], sats: 1000, unit: 'sat', transports: [], delivery: null }, o || {});
// a trip home whose connect lands only when `land()` is called (Tor), or fails when `fail()` is
const slowHome = (p, box) => (u, x) => {
  if (canon(u) !== MINE || (x && x.remember === false)) return null;
  p.log.connects.push({ u: MINE, remember: true });
  let over = false;
  return new Promise((res, rej) => {
    box.land = () => { if (over) return; over = true; p.W.mintUrl = MINE; res({}); };
    box.fail = () => { if (over) return; over = true; rej(new Error('The request timed out.')); };
  });
};
const hookConnect = (p, hook) => { p.W.connect = ((orig) => (u, a, b, x) => hook(u, x) || orig(u, a, b, x))(p.W.connect); };

/* M1a: the real wallet. An invoice made on a visit, paid once the phone is home. */
async function lightningAway() {
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
  const HOME = 'https://home.test';
  const THEIR = 'https://their.test';
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ph = nativePhone({ words: PHONE_WORDS });
  const mints = {};
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const u = new URL(m.url);
        const mint = mints[u.origin];
        if (!mint) return reply(w, m.id, null, 'no such mint in this test');
        return reply(w, m.id, mint.handle(m));
      }
      const got = ph.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      ph.attach(w);
      mints[HOME] = fakeMint(w, { fill: 7 });
      mints[THEIR] = fakeMint(w, { fill: 9, quoteFrom: 5000, quotesUnpaid: true });
    },
  });
  const W = ctx.W;
  W._nodeProbeDelay = [86400000, 86400000];
  await W.connect(HOME, null, null, { remember: true });
  // NOT BACK HOME YET at their mint (or a hold keeping the phone there): the merchant's receive makes the invoice there
  await W.connect(THEIR, null, null, { remember: false });
  const inv = await W.invoice(1000, '');
  ok('M1 (control) the invoice is made at the mint being visited', W.mintUrl === THEIR && !!inv && !!inv.hash);
  // the screen is left (the watch stops, "the sweep has the quote") and the trip home lands; then the payer pays
  await W.connect(HOME, null, null, { remember: true });
  mints[THEIR].payQuote(inv.hash);
  // what a phone at home runs: the invoice watch (were it still up), and the sweep a connect and a route change run
  let paidSaid = null;
  const stop = W.watch(inv.hash, (p) => { paidSaid = p; }, { timeoutMs: 4000, pollMs: 50 });
  await wait(400);
  stop();
  try { await W.sweepQuotes(); } catch (e) {}
  await wait(50);
  const theirs = W.balanceAt(THEIR);
  ok('M1a a Lightning invoice made at another mint and paid after the phone came home is claimed from home',
    theirs === 1000 || paidSaid,
    'their.test holds ' + theirs + ' sats and the quote is PAID at the mint; the watch never asked (madeAt ≠ the mint the phone is on) '
      + 'and the sweep asks only the connected mint’s quotes. On-chain has `onchainClaimAway`; Lightning has nothing.');
  await W.connect(THEIR, null, null, { remember: false });
  try { await W.sweepQuotes(); } catch (e) {}
  ok('M1 (control) and it is still there, claimed on the next visit to that mint', W.balanceAt(THEIR) === 1000, String(W.balanceAt(THEIR)));
}

async function run() {
  console.log('M1. a Lightning invoice made at the mint being visited');
  await lightningAway();
  {
    // RECEIVE pressed while the trip home is out; the first try fails; the invoice takes longer than 2 s to make (Tor)
    const box = {};
    const p = phone({ there: 300 });
    hookConnect(p, slowHome(p, box));
    p.a.openReceiveNow = function () {
      const at = p.W.mintUrl;
      setTimeout(() => { p.log.invoices.push(at); p.a._watching = true; }, 2500);
    };
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();
    p.a.setState({ screen: 'confirm', flow: 'receive', recvRail: 'LIGHTNING' });
    p.a.openReceive();
    box.fail();
    await wait(2150);
    if (box.land) box.land();
    await wait(500);
    ok('M1b the trip’s retry does not go under an invoice still being made at the visited mint',
      !(p.log.invoices[0] === THEIRS && p.W.mintUrl === MINE),
      'invoice made at ' + p.log.invoices[0] + ' after the retry left; phone now at ' + p.W.mintUrl
        + ' with that invoice on screen and its watch asking nowhere');
  }

  console.log('M2. the on-chain floor on screen after a PAY FROM visit');
  {
    const limits = {
      [MINE]: { receive: { min: 25000, max: 1000000, confirmations: 3 }, send: { min: 10000, max: 1000000 } },
      [THEIRS]: { receive: { min: 10000, max: 1000000, confirmations: 3 }, send: { min: 10000, max: 1000000 } },
    };
    const p = phone({ there: 60000, limits });
    p.a.onchainAsk();                       // launch, at home
    await wait(5);
    ok('M2 (control) at home the screen has home’s floor', p.a.state.ocLimits && p.a.state.ocLimits.receive.min === 25000);
    // a payout on chain paid from Minibits (PAY FROM): a visit there for its fee, and home after
    p.a.setState({ screen: 'ocConfirm', ocTo: 'bc1qpayee', ocSats: 20000 });
    p.a.pfOnchainGo({ mint: THEIRS }, false);
    await wait(5);
    p.a.setState({ screen: 'home', stack: [], ocPlan: null });
    p.a.pfOcHome();
    await wait(5);
    ok('M2 (control) the payout’s visit is over and the phone is home', p.W.mintUrl === MINE && !p.a._ocVisit, p.W.mintUrl);
    // RECEIVE 15,000 sats, ON-CHAIN (the default rail): `openReceiveNow` asks `ocReceiveBlocked` before it opens on it
    p.a.setState({ screen: 'confirm', flow: 'receive', recvRail: 'ON-CHAIN' });
    p.a.ocReceiveAddress();
    await wait(5);
    const addr = p.a._ocAddr;
    const note = p.a.ocReceiveNote();
    ok('M2 an address made at home is shown with home’s floor, and 15,000 is refused under it',
      p.a.ocReceiveBlocked(15000) && /25000/.test(note),
      'address at ' + (addr && addr.mint) + '; the screen says "' + note + '" and offers 15,000 on chain (blocked: '
        + p.a.ocReceiveBlocked(15000) + '); under 25,000 home swallows it');
  }

  console.log('L1. an on-chain deposit claimed at another mint, announced at home');
  {
    const ann = [];
    const W = {
      connected: true, mintUrl: MINE,
      onchainWatching: () => [], onchainDue: () => [],
      onchainDueAway: () => [{ quote: 'qa', mint: THEIRS, at: Date.now() }],
      onchainClaimAway: () => Promise.resolve({ sats: 12000, hash: 'onchain-qa-0' }),
      onchainClaim: () => Promise.reject(new Error('not here')),
      onchainAsked() {}, onchainSending: () => [], onchainSendingAway: () => [],
      balanceAt: (u) => (canon(u) === THEIRS ? 12000 : 2591),
      notify() {},
    };
    global.window = { FoxyWallet: W };
    global.document = { visibilityState: 'visible' };
    // the app's own list of confirmation screens (build/foxy-app.js, top), which announcePayment reads
    global.CONFIRM_SCREENS = JSON.parse(/const CONFIRM_SCREENS = (\[[^\]]*\])/.exec(app)[1].replace(/'/g, '"'));
    const a = Object.assign(lift(['onchainWatch() {', 'announcePayment(ev) {']), {
      state: { screen: 'home', stack: [], recv: {} },
      setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
      refreshBalance() {}, loadHistory() {}, toast() {}, haptic() {}, hideStage() {},
      cardFlowHolds: () => false, keepForCardFlow() {}, ocTxidOf: () => '', group: (n) => String(n),
    });
    const orig = a.announcePayment;
    a.announcePayment = function (ev) { ann.push(ev); return orig.call(this, ev); };
    a.onchainWatch();
    await wait(20);
    clearTimeout(a._ocWatchT);
    const s = a.state;
    ok('L1 (control) the deposit is announced on the paid screen', ann.length === 1 && s.screen === 'paid', 'screen ' + s.screen);
    ok('L1 a deposit claimed at another mint says where the sats are, not ADDED TO this balance',
      ann.length === 1 && !!s.paidPlace && /minibits/i.test(JSON.stringify(s.paidPlace)),
      'screen ' + s.screen + ', paidPlace ' + JSON.stringify(s.paidPlace) + ', announced ' + JSON.stringify(ann)
        + ' (the paid screen reads PAYMENT RECEIVED · ADDED TO; home holds 2591, the 12000 are in Minibits’ pile)');
    delete global.document;
    delete global.CONFIRM_SCREENS;
  }

  console.log('L2. a token to show, queued behind the trip home, at the mint the phone was visiting');
  {
    // control: no trip out, a trip owed (`_homeWaiting`): the token is made here and the phone still comes home after
    const p0 = phone({ there: 5000 });
    p0.W.mintUrl = THEIRS;
    p0.a._crossCameFrom = MINE; p0.a._homeWaiting = true;
    p0.a.setState({ screen: 'reqOffer', req: request({ id: 'r8' }) });
    p0.a.makeTokenForRequest();
    await wait(20);
    ok('L2 (control) with no trip out, the token is made at Minibits and home is still owed',
      p0.log.tokens.length === 1 && p0.log.tokens[0].at === THEIRS && p0.a._crossCameFrom === MINE);
    const box = {};
    const p = phone({ there: 5000 });
    hookConnect(p, slowHome(p, box));
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();
    p.a.setState({ screen: 'reqOffer', req: request({ id: 'r9' }) });
    p.a.makeTokenForRequest();
    box.land();
    await wait(20);
    ok('L2 queued behind the trip, it ends the same way: home owed, or home',
      p.W.mintUrl === MINE || p.a._crossCameFrom === MINE,
      'token made at ' + JSON.stringify(p.log.tokens.map((t) => t.at)) + '; phone at ' + p.W.mintUrl
        + ', nothing to bring it home (`_crossCameFrom` ' + p.a._crossCameFrom + ')');
  }

  console.log('L3. the queued payment after the person has left its offer');
  {
    const box = {};
    const p = phone({ there: 300 });
    hookConnect(p, slowHome(p, box));
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();
    // a request at home, delivered over an onion: PAY under the trip ("The payment follows")
    const r = request({ id: 'r5', mints: [MINE], delivery: { kind: 'onion', target: 'x.onion' } });
    p.a.setState({ screen: 'reqOffer', stack: ['home'], req: r });
    p.a.makeTokenForRequest();
    ok('L3 (control) PAY is queued behind the trip', p.log.paid.length === 0 && p.log.toasts.some((t) => /payment follows/.test(t)));
    // the edge swipe (14-reconcile-seed-restore.js `watchEdgeSwipe` → `back()`): the screen goes, `req` stays
    p.a.setState({ screen: 'home', stack: [] });
    box.land();
    await wait(20);
    ok('L3 a payment whose offer was left before it began is not made',
      p.log.paid.length === 0,
      'paid ' + JSON.stringify(p.log.paid) + ' from screen home, now on ' + p.a.state.screen
        + ' (the on-chain queues ask the screen; this one asks only `state.req`)');
  }

  console.log('L4. the trip’s retry under a trip already out');
  {
    const box = {};
    const p = phone({ there: 300 });
    hookConnect(p, slowHome(p, box));
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();
    box.fail();
    await wait(5);
    // in the two seconds before the retry, a flow that ended comes home itself (`crossDone`, `pfOcHome`, a tap's ending)
    p.a.crossComeHome();
    ok('L4 (control) a second trip is out', !!p.a._homeGoing && p.log.connects.length === 2);
    await wait(2150);
    const tries = p.log.connects.filter((c) => c.u === MINE).length;
    ok('L4 the retry does not begin a third connect home under the one still out', tries === 2,
      tries + ' connects home, two of them out at once; the retry asks `homeWaitsFor`, which does not list `_homeGoing`');
    if (box.land) box.land();
  }

  console.log('L5. an on-chain address being made at the visited mint');
  {
    const later = {};
    const p = phone({ there: 300, addrLater: later, limits: { [THEIRS]: { receive: { min: 10000, max: 1000000, confirmations: 3 } } } });
    p.W.mintUrl = THEIRS;
    p.a._homeOwed = MINE;     // NOT BACK HOME YET
    p.a.setState({ screen: 'confirm', flow: 'receive', recvRail: 'ON-CHAIN' });
    p.a.ocReceiveAddress();
    ok('L5 (control) the address is being made', !!p.a._ocMaking);
    const why = p.a.homeWaitsFor();
    ok('L5 an address being made at this mint for a receive screen holds the trip home', why !== '',
      'homeWaitsFor() = "' + why + '": a route change now (comeHomeOwed) goes, the address lands naming Minibits, and the '
        + 'landing remakes it at Forge under the payer');
    later.done();
  }

  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
