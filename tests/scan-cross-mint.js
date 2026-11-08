'use strict';
/* scan-cross-mint.js — a scanned request at a mint this phone holds too little at.
 *
 *     node tests/scan-cross-mint.js
 *
 * A donation page's request named Minibits and 1,000 sats; the phone held 298
 * there and 2,591 at Forge. Foxy switched to Minibits, refused with "you hold
 * 298", and stayed — so home showed 298 sats at a mint the person had never
 * chosen and the 2,591 looked gone. Two things, both already true of a tap:
 *
 *   1. too little at their mint and enough at this phone's own: the crossing
 *      is offered (the amount, the fee, both mints, PAY), the sats are moved,
 *      and the payment follows with no second question;
 *   2. a payment made straight to them at another mint is a visit, and the
 *      phone comes home afterwards whichever way it ended.
 *
 * And what is left alone: dollars, no route, a token to show, enough there.
 * `makeTokenForRequest` is lifted out of build/foxy-app.js and run against a
 * stand-in wallet, as cross-mint-online-only.js does.
 */
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
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

/* A phone on MINE holding 2,591 there and `o.there` at THEIRS. `o.offline`:
 * no route. `o.payFails`: their wallet refuses the payment. `o.answer`: what
 * the crossing screen is answered with (true by default). */
function phone(o) {
  const opts = o || {};
  const log = { connects: [], cards: [], crossCards: [], moves: [], pays: [], tokens: [], toasts: [], melts: 0 };
  const W = {
    mintUrl: MINE,
    mintHost: () => W.mintUrl.replace(/^https:\/\//, ''),
    mints: () => [{ id: MINE }, { id: THEIRS }],
    balanceAt: (u) => (u === THEIRS ? (opts.there || 0) : 2591),
    transferQuote: (from, sats, x) => { log.quote = { from, sats, to: x && x.to, land: !!(x && x.land) }; return Promise.resolve({ net: sats, feeSats: 2, to: x.to }); },
    connect: (u, a, b, x) => { log.connects.push({ u, opts: x || null }); W.mintUrl = u; return Promise.resolve(); },
    payRequest: (req) => { log.pays.push({ at: W.mintUrl, sats: req.sats }); return opts.payFails ? Promise.reject(new Error('They refused it.')) : Promise.resolve({ hash: 'h1', confirmed: true }); },
    sendToken: (sats) => { log.tokens.push({ at: W.mintUrl, sats }); return Promise.resolve({ hash: 'h2', token: 'cashuA', sats, swapped: true }); },
    tag: () => {},
    reason: (e) => String((e && e.message) || e),
  };
  global.window = { FoxyWallet: W };
  const a = Object.assign(lift(['reqMints(req) {', 'reqCanon(u) {', 'reqPayMint(req) {', 'reqHeldAt(req, amount) {', 'makeTokenForRequest(go) {', 'crossComeHome() {']), {
    state: { screen: 'reqOffer', stack: ['home'], reqBusy: false, req: null, note: '' },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    offlineNow: () => !!opts.offline,
    refuseSwitchWhileBusy: () => false,
    changeComesBack: () => false,
    twoUnitsOn: () => false,
    // the crossing's own confirmation, answered at once
    crossMintCard(plan, theirs, mine) {
      return Promise.resolve(plan).then((p) => { log.crossCards.push({ net: p.net, fee: p.feeSats, theirs, mine }); return opts.answer !== false; });
    },
    // the move: the sats land at their mint and the phone is left there, as the real one does
    crossMove(plan, theirs, mine) {
      log.moves.push({ net: plan.net, theirs, mine });
      W.mintUrl = theirs;
      this._crossMovedTo = theirs; this._crossCameFrom = mine;
      return Promise.resolve();
    },
    crossFailed(e, mine) { log.crossFailed = { why: String(e && e.message), mine }; },
    showMelt() { log.melts++; }, hideMelt() {},
    requestDelivered(req, r) { log.delivered = { sats: req.sats, hash: r.hash }; this.setState({ reqBusy: false, req: null, sendPhase: 'settled' }); },
    refreshBalance() {}, loadHistory() {}, needScanStage() {}, watchToken() {}, tidyChangeLater() {},
    toast(t) { log.toasts.push(t); },
    blockedCard(kind, c) { log.cards.push(Object.assign({ kind }, c)); },
    needsMintCard(why) { log.cards.push({ kind: 'needsMint', why }); },
    saidToReceiver: (s) => s,
    mintNameOf: (u) => NAMES[String(u || '').replace(/\/+$/, '')] || '',
  });
  return { a, W, log };
}
// a request for 1,000 sats at THEIRS; `direct`: it says where to deliver (a nostr target)
const request = (o) => Object.assign({ id: 'r1', mints: [THEIRS], sats: 1000, unit: 'sat',
  delivery: (o && o.direct === false) ? null : { kind: 'nostr', target: 'nprofile1x' } }, o || {});

async function run() {
  console.log('1. too little at their mint: the crossing is offered, moved, and the payment follows');
  {
    const p = phone({ there: 298 });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    const c = p.log.crossCards[0];
    ok('the crossing screen is shown with the amount, the fee and both mints',
      !!c && c.net === 1000 && c.fee === 2 && c.theirs === THEIRS && c.mine === MINE, JSON.stringify(c));
    ok('the quote is for the amount, landing at their mint, from this phone’s own',
      p.log.quote && p.log.quote.from === MINE && p.log.quote.sats === 1000 && p.log.quote.to === THEIRS && p.log.quote.land, JSON.stringify(p.log.quote));
    ok('the sats are moved once', p.log.moves.length === 1 && p.log.moves[0].net === 1000, JSON.stringify(p.log.moves));
    ok('then paid at their mint, once', p.log.pays.length === 1 && p.log.pays[0].at === THEIRS && p.log.pays[0].sats === 1000, JSON.stringify(p.log.pays));
    ok('the crossing was not offered a second time', p.log.crossCards.length === 1, String(p.log.crossCards.length));
    ok('and the phone comes home to its own mint', p.W.mintUrl === MINE && p.log.connects.some(x => x.u === MINE), JSON.stringify(p.log.connects));
    ok('nothing moved home is remembered as a visit', !p.a._crossCameFrom && !p.a._crossMovedTo);
  }
  console.log('2. the crossing declined: nothing moves, nothing is paid, the phone stays home');
  {
    const p = phone({ there: 298, answer: false });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('one offer, no move, no payment', p.log.crossCards.length === 1 && !p.log.moves.length && !p.log.pays.length);
    ok('still on its own mint, nothing connected', p.W.mintUrl === MINE && !p.log.connects.length, JSON.stringify(p.log.connects));
  }
  console.log('3. the payment refused after the move: the phone still comes home');
  {
    const p = phone({ there: 298, payFails: true });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('moved and tried', p.log.moves.length === 1 && p.log.pays.length === 1);
    ok('the refusal is said', p.log.toasts.length === 1 && /refused/.test(p.log.toasts[0]), JSON.stringify(p.log.toasts));
    ok('and the phone is back on its own mint', p.W.mintUrl === MINE, p.W.mintUrl);
  }
  console.log('4. enough already at their mint: a visit, no crossing, and home after');
  {
    const p = phone({ there: 1500 });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('no crossing offered', !p.log.crossCards.length && !p.log.moves.length);
    const first = p.log.connects[0];
    ok('their mint is connected to as a visit, not remembered', !!first && first.u === THEIRS && first.opts && first.opts.remember === false, JSON.stringify(first));
    ok('paid there', p.log.pays.length === 1 && p.log.pays[0].at === THEIRS);
    ok('and home again', p.W.mintUrl === MINE, p.W.mintUrl);
  }
  console.log('5. a visit refused: home as well, and the sats are where they were');
  {
    const p = phone({ there: 1500, payFails: true });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('home after the refusal', p.W.mintUrl === MINE && p.log.toasts.length === 1, p.W.mintUrl);
  }
  console.log('6. left alone: a token to show, dollars, no route, the same mint');
  {
    const p = phone({ there: 1500 });
    p.a.setState({ req: request({ direct: false }) });
    p.a.makeTokenForRequest();
    await wait(30);
    const first = p.log.connects[0];
    ok('a token to show: their mint is connected to and remembered, as before', !!first && first.u === THEIRS && !(first.opts && first.opts.remember === false), JSON.stringify(first));
    ok('the token is made there and the phone stays there', p.log.tokens.length === 1 && p.log.tokens[0].at === THEIRS && p.W.mintUrl === THEIRS && !p.a._crossCameFrom);
  }
  {
    const p = phone({ there: 298 });
    p.a.setState({ req: request({ direct: false }) });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('a token to show with too little there: the crossing is offered too', p.log.crossCards.length === 1 && p.log.moves.length === 1);
    ok('the token is made at their mint after the move', p.log.tokens.length === 1 && p.log.tokens[0].at === THEIRS);
    ok('and the phone stays there, with nothing left to come home from', p.W.mintUrl === THEIRS && !p.a._crossCameFrom);
  }
  {
    const p = phone({ there: 0 });
    p.a.setState({ req: request({ unit: 'usd', amount: 500, sats: null }) });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('dollars: no crossing', !p.log.crossCards.length && !p.log.moves.length);
  }
  {
    const p = phone({ there: 298, offline: true });
    p.a.setState({ req: request({ delivery: null }) });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('no route: no crossing', !p.log.crossCards.length && !p.log.moves.length);
  }
  {
    const p = phone({ there: 298 });
    p.a.setState({ req: request({ mints: [MINE] }) });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('the same mint: no crossing, no connect, paid here', !p.log.crossCards.length && !p.log.connects.length && p.log.pays.length === 1 && p.log.pays[0].at === MINE);
  }

  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
