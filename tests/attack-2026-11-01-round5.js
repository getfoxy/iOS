'use strict';
/* attack-2026-11-01-round5.js — round five of the attack, on ec47720 (the round-4 fixes: the trip home as a hold).
 *
 *     node tests/attack-2026-11-01-round5.js
 *
 * Every case but the controls (marked "control") fails on ec47720: each is a
 * finding in .claude/audits/attack-2026-11-01-round5.md, named by its letter.
 *
 *   C  the tap-live rule round 4 gave `syncHome` (`_tapTalking`, a code shown)
 *      is not in `comeHomeOwed` (every route change) nor in the trip's own
 *      2-second retry: a receiver at the mint it is visiting, its agreed
 *      request sent over the link and its screen back on home, is taken home
 *      before the payment comes, and the payment is refused there.
 *   A  a payout on chain from another mint (PAY FROM, `pfOnchainGo`) is not
 *      held by the trip home: begun while the connect home is out, it writes
 *      the mint being visited as home (`crossComeHome` cleared it), and its
 *      ending takes the phone there and saves it as the phone's own.
 *   B  what a receive screen at the visited mint holds is the Cashu request
 *      only (`_creqs`): an on-chain address on show, and a Lightning invoice
 *      being watched, are not in `homeWaitsFor`, and both are asked about only
 *      while the phone is on that mint. And `openReceive`, queued behind a
 *      trip that failed once, makes its invoice at the visited mint in the
 *      two seconds before the retry takes the phone home under it.
 *   L5 `lateRunEnded` books a dead run's result and nothing of a token made
 *      and not delivered (`e.foxyToken`): left marked on its way, unwatched.
 *   P  PAY pressed on a token-to-show request at the mint the phone is on,
 *      while the trip home is out, is paid "once home" as a request at
 *      another mint: a connect there that is remembered, so the phone's own
 *      mint becomes the one it was only visiting.
 *
 * Methods are lifted out of build/foxy-app.js, as rounds 1-4 do.
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

/* The phone of rounds 3-4: on MINE, `o.there` at THEIRS, the real come-home machinery, request payment and PAY FROM's
 * on-chain visit. `o.connect(u, x)` may return a promise to take over a connect (a slow or failing trip home). */
function phone(o) {
  const opts = o || {};
  const log = { connects: [], cards: [], toasts: [], told: [], quotes: [], tokens: [], invoices: [] };
  const held = { [MINE]: 2591, [THEIRS]: opts.there || 0 };
  const reqs = {};
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
    payRequest: (req) => Promise.resolve({ hash: 'h-' + req.id, confirmed: true }),
    sendToken: (sats) => { log.tokens.push({ at: W.mintUrl, sats }); return Promise.resolve({ hash: 'h2', token: 'cashuB', sats, swapped: true }); },
    sendShortfall: () => ({ short: false, fee: 0 }),
    tapQuote: (j) => { log.told.push(String(j)); return Promise.resolve(); },
    tag: () => {},
    reason: (e) => String((e && e.message) || e),
  };
  global.window = { FoxyWallet: W };
  const a = Object.assign(lift(['makeTokenForRequest(go) {', 'crossComeHome() {', 'comeHomeOwed() {',
    'openRequest(text, opts) {', 'requestHere(req) {', 'tellPayerShort(req) {',
    'reqRunLive() {', 'homeWaitsFor() {', 'syncHome() {', 'refuseForRun(viaTap) {',
    'pfOnchainGo(e, shown) {', 'pfOcHome() {', 'pfHere() {', 'pfMint(u) {', 'pfName(mint) {', 'openReceive() {']), {
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
    onchainAsk() {},
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
  // each try its own: a try that has failed lands nothing later (the phone stays where it is)
  let over = false;
  return new Promise((res, rej) => {
    box.land = () => { if (over) return; over = true; p.W.mintUrl = MINE; res({}); };
    box.fail = () => { if (over) return; over = true; rej(new Error('The request timed out.')); };
  });
};

async function run() {
  console.log('C. a tap still being talked over, and the trips home that do not ask');
  {
    // a merchant on NOT BACK HOME YET at Minibits; a payer tapped, the price was agreed, the request for the agreed sats went
    // over the link (26d-tap.js `priceTermsCard` → `railRequestReady` → `tapTerms`), and "the hold STAYS" with the screen
    // back on home until the payment arrives (`requestPaidHere`)
    const p = phone({ there: 300 });
    p.W.mintUrl = THEIRS;
    p.a._creqs = { [THEIRS + '|1000|receive|$0']: { text: 'creqAgreed' } };
    p.a._tapTalking = true;
    p.a.setState({ screen: 'home', stack: [], flow: 'receive' });
    // round 4's rule, in syncHome
    p.a._crossCameFrom = MINE; p.a._homeWaiting = true;
    p.a.syncHome();
    await wait(5);
    ok('C0 (control) syncHome leaves a receiver mid-tap where it is', p.W.mintUrl === THEIRS && p.log.connects.length === 0);
    p.a._crossCameFrom = null; p.a._homeWaiting = false;
    p.a._homeOwed = MINE;     // NOT BACK HOME YET; a route change now (06-wallet-boot-and-restore.js `claimWhenRouteReturns`)
    p.a.comeHomeOwed();
    await wait(5);
    ok('C1 a route change does not take a receiver home in the middle of a tap (comeHomeOwed)',
      p.W.mintUrl === THEIRS && !p.log.connects.some((c) => c.u === MINE),
      'phone at ' + p.W.mintUrl + ' with the agreed request at Minibits still to be paid; connects ' + JSON.stringify(p.log.connects));
  }
  {
    // the trip home's first connect fails; in the two seconds before its retry the merchant takes a tap at Minibits
    const box = {};
    const p = phone({ there: 300 });
    p.W.connect = ((orig, hook) => (u, a, b, x) => hook(u, x) || orig(u, a, b, x))(p.W.connect, slowHome(p, box));
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();
    box.fail();
    await wait(5);
    ok('C (control) the first try failed, the second is two seconds off', !p.a._homeGoing && p.a._crossCameFrom === MINE);
    p.a._creqs = { [THEIRS + '|1000|receive|$0']: { text: 'creqAgreed' } };
    p.a._tapTalking = true;
    p.a.setState({ screen: 'home', stack: [], flow: 'receive' });
    await wait(2100);
    if (box.land) box.land();
    await wait(5);
    const tries = p.log.connects.filter((c) => c.u === MINE).length;
    ok('C2 nor does the trip home’s own retry', tries === 1,
      tries + ' connects to Forge; the second went with a tap at Minibits still being talked over');
  }

  console.log('A. a payout on chain from another mint while the trip home is out');
  {
    const box = {};
    const p = phone({ there: 300 });
    p.W.connect = ((orig, hook) => (u, a, b, x) => hook(u, x) || orig(u, a, b, x))(p.W.connect, slowHome(p, box));
    p.W.mintUrl = THEIRS;           // on a visit (a request just paid at Minibits)
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();            // its ending: the trip home, its connect on its way
    // home stays written while the connect is out (the fix to A): cleared once it lands, so nothing writes Minibits there
    ok('A (control) the trip home is out and holds (`_homeGoing`), home still written', !!p.a._homeGoing && p.a._crossCameFrom === MINE && p.W.mintUrl === THEIRS);
    // the person scans an address and PAY FROM offers Forge, where their sats are (26b-onchain.js `payOnchain` → `pfOnchain`)
    p.a.setState({ screen: 'payFrom', ocSats: 20000, ocTo: 'bc1q' });
    const before = p.log.connects.length;
    p.a.pfOnchainGo({ mint: MINE }, false);
    await wait(5);
    const visits = p.log.connects.slice(before);
    ok('A1 PAY FROM on chain waits for the trip home, or refuses, and connects nowhere under it',
      visits.length === 0 && !p.a._ocVisit,
      'connects under the trip: ' + JSON.stringify(visits) + '; home now written as ' + p.a._crossCameFrom);
    box.land();
    await wait(5);
    // the payout ends (26b-onchain.js `ocPay`: ocPlan let go, then `pfOcHome`, then `syncHome`), or BACK (`ocCancel`)
    p.a.setState({ screen: 'home', stack: [], ocPlan: null });
    p.a.pfOcHome();
    p.a.syncHome();
    await wait(5);
    const saved = p.log.connects.filter((c) => c.u === THEIRS && c.remember);
    ok('A2 and its ending leaves the phone home, with its own mint unchanged',
      p.W.mintUrl === MINE && saved.length === 0,
      'phone at ' + p.W.mintUrl + '; remembered connects to Minibits: ' + saved.length + ' (crossComeHome connects without remember:false)');
  }

  console.log('B. a receive screen at the visited mint, and what it holds');
  {
    const p = phone({ there: 300 });
    p.W.mintUrl = THEIRS;
    p.a._creqs = {};
    p.a._ocAddr = { mint: THEIRS, address: 'bc1qvisited' };
    p.a.setState({ screen: 'confirm', flow: 'receive', recvRail: 'ON-CHAIN' });
    const why = p.a.homeWaitsFor();
    ok('B1 an on-chain address of the visited mint on show holds the trip home', why !== '',
      'homeWaitsFor() = "' + why + '" (the deposit is asked about only while the phone is on Minibits: 16a-onchain.js `onchainWatching`)');
    p.a._ocAddr = null;
    p.a._watching = true;
    p.a.setState({ recvRail: 'LIGHTNING', invoice: 'lnbc10u1visited', invoiceHash: 'q1' });
    const why2 = p.a.homeWaitsFor();
    ok('B2 a Lightning invoice of the visited mint being watched holds the trip home', why2 !== '',
      'homeWaitsFor() = "' + why2 + '" with `_watching` (moneyBusy counts it; the watch asks only at the mint that made it, 15-receiving.js `madeAt`)');
  }
  {
    // RECEIVE pressed while the trip home is out: openReceive waits for it; the first try fails
    const box = {};
    const p = phone({ there: 300 });
    p.W.connect = ((orig, hook) => (u, a, b, x) => hook(u, x) || orig(u, a, b, x))(p.W.connect, slowHome(p, box));
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();
    p.a.setState({ screen: 'confirm', flow: 'receive', recvRail: 'LIGHTNING' });
    p.a.openReceive();
    ok('B (control) the receive waits for the trip home', p.log.invoices.length === 0);
    box.fail();
    await wait(5);
    ok('B (control) and makes its invoice when the first try fails, at Minibits', p.log.invoices[0] === THEIRS, JSON.stringify(p.log.invoices));
    p.a._watching = true;
    await wait(2100);
    if (box.land) box.land();
    await wait(5);
    ok('B3 an invoice made at the visited mint is not left behind by the retry',
      !(p.log.invoices[0] === THEIRS && p.W.mintUrl === MINE),
      'invoice made at ' + p.log.invoices[0] + ', phone now at ' + p.W.mintUrl + ' with it still on screen');
  }

  console.log('P. PAY on a token-to-show request at this mint, while the trip home is out');
  {
    const box = {};
    const p = phone({ there: 5000 });
    p.W.connect = ((orig, hook) => (u, a, b, x) => hook(u, x) || orig(u, a, b, x))(p.W.connect, slowHome(p, box));
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();
    // a request at Minibits, the mint the phone is on, that names nowhere to deliver: a token to show, made here
    const r = request({ id: 'r9' });
    p.a.setState({ screen: 'reqOffer', req: r });
    p.a.makeTokenForRequest();
    ok('P (control) the payment waits for the trip home ("The payment follows")', p.log.tokens.length === 0
      && p.log.toasts.some((t) => /payment follows/.test(t)));
    box.land();
    await wait(20);
    const saved = p.log.connects.filter((c) => c.u === THEIRS && c.remember);
    ok('P1 the phone’s own mint is not changed to the one it was visiting',
      saved.length === 0,
      'token made at ' + JSON.stringify(p.log.tokens.map((t) => t.at)) + ' after ' + saved.length + ' remembered connect(s) to Minibits; phone at ' + p.W.mintUrl);
  }

  console.log('L5. a run let go as dead that ends late with a token made and not delivered');
  {
    const W = { tagged: [], tag: (h, t) => W.tagged.push([h, t]), settleTx() {}, reason: (e) => String(e && e.message) };
    global.window = { FoxyWallet: W };
    const watched = [];
    const a = Object.assign(lift(['lateRunEnded(req, r, direct, e) {']), {
      watchToken(sats, hash) { watched.push(hash); }, refreshBalance() {}, loadHistory() {},
    });
    const e = Object.assign(new Error('The onion did not answer.'), { foxyToken: { hash: 'hT', sats: 1000, token: 'cashuB', unit: 'sat' } });
    a.lateRunEnded({ id: 'r7', unit: 'sat', delivery: { kind: 'onion', target: 'x.onion' } }, null, true, e);
    ok('L5 its token is booked as the live ending books one (no longer on its way, and watched)',
      watched.indexOf('hT') >= 0 && W.tagged.some(([h, t]) => h === 'hT' && t && t.inflight === false),
      'watched ' + JSON.stringify(watched) + ', tagged ' + JSON.stringify(W.tagged));
  }

  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
