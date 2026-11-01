'use strict';
/* attack-2026-11-01-round4.js — round four of the attack, on 38205ad (the round-3 fixes).
 *
 *     node tests/attack-2026-11-01-round4.js
 *
 * Every case but the controls (marked "control") fails on 38205ad: each is a
 * finding in .claude/audits/attack-2026-11-01-round4.md, named by its letter.
 *
 *   G  a trip home whose connect is still out is no hold on anything: a tap
 *      paid at the mint the phone is visiting, begun while the connect home
 *      is on its way, is made from home's pile for a request that names the
 *      visited mint (G0 shows the wallet half: payRequest binds the wallet
 *      only after the question asked first). And `homeWaitsFor` says nothing
 *      while a PAY FROM crossing moves sats, so a trip home owed is made in
 *      the middle of one.
 *   D  `reqRunLive`'s 150 s death is not the longest a payment can take
 *      (connect 30 s + a swap 65 s, twice after a 429, + the post 65 s): the
 *      same website request scanned again after it is paid a second time
 *      while the first post is still out, and the first's late ending clears
 *      `reqBusy` and `req` from under the second.
 *   T  a token to show (no delivery) wipes a trip home that is waiting
 *      (`_crossCameFrom = null`): the phone stays at the mint it was
 *      visiting for the session.
 *   L2 a tap request's pass dropped because another request was opened
 *      (`go.req` no longer on screen) tells the other phone nothing.
 *   B  the books (tests/harness.js `booksWrong`) through a website payment's
 *      life: 2xx and unspent, RECLAIM, a site that redeems late, and a
 *      refusal whose swap-back did not go and that the site redeemed after.
 *
 * The stubbed cases lift methods out of build/foxy-app.js as the earlier
 * rounds do; G0 and B run the real wallet against fake mints.
 *
 * After the fixes, three cases ask their question where the fix answers it
 * (each still fails on 38205ad): D2 at the ten-minute clock, where a second
 * run can begin at all; L2 with the second request refused while the move is
 * collected and the person leaving the offer, so the pass is dropped; and G6
 * as the wallet's rule (a control), with G6b holding the trip home under a
 * request on show. G1b, D1b and L2b are new.
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
const NAMES = { [MINE]: 'Forge', [THEIRS]: 'Minibits', [KASHU]: 'Kashu' };
const canon = (u) => {
  const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(String(u || '').trim());
  return m ? m[1].toLowerCase() + '://' + m[2].toLowerCase().replace(/:443$/, '').replace(/\.+$/, '') + (m[3] || '').replace(/\/+$/, '') : String(u || '');
};

/* The phone of the round-3 attack: on MINE with 2,591, `o.there` at THEIRS, the real makeTokenForRequest, crossMove and
 * come-home, with the round-3 run token and holds. */
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
    moveRun: (plan, st, x) => (opts.moveRun ? opts.moveRun(plan, x) : W.connect(plan.to, null, null, (x && x.visit) ? { remember: false } : undefined).then(() => {
      log.moves.push({ from: plan.from, to: plan.to, net: plan.net });
      held[canon(plan.to)] = (held[canon(plan.to)] || 0) + plan.net; held[canon(plan.from)] -= plan.net + plan.feeSats; return { sats: plan.net };
    })),
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
    // what requestDelivered does to state first (07-history-tokens-mints.js, `requestDelivered`)
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

async function stubbed() {
  console.log('G. a trip home whose connect is still out holds nothing');
  {
    // the connect home is slow (Tor); it lands when `land()` is called
    let land = null;
    const p = phone({
      there: 5000,
      connect: (u) => {
        if (canon(u) !== MINE) return null;
        return new Promise((res) => { land = () => { p.log.connects.push({ u: MINE, remember: true, landed: true }); p.W.mintUrl = MINE; res({}); }; });
      },
      /* payRequest binds the wallet when it makes the token (sendToken, `needLocal`), after the change key is primed and,
       * over a tap whose receiver asks first, after its answer (20-helpers.js `payRequest`: `primed.then`, `asked.then`).
       * Here that wait is 20 ms; G0 below runs the real one. */
      pay: (req, W) => wait(20).then(() => { p.log.made = W.mintUrl; return { hash: 'h-' + req.id, confirmed: true }; }),
    });
    p.W.mintUrl = THEIRS;   // on a visit, paying somebody there
    p.a._crossCameFrom = MINE;
    p.a.crossComeHome();    // that payment ended: the trip home begins, its connect on its way
    // home stays written until the connect lands (round 5's A)
    ok('G (control) the trip home has begun', typeof land === 'function' && p.a._crossCameFrom === MINE && p.W.mintUrl === THEIRS);
    ok('G1 (control) and nothing is listed as holding it', p.a.homeWaitsFor() === '');
    // (fix) the trip home is a hold of its own while its connect is out: a mint switch waits for it
    const mb = Object.assign(lift(['moneyBusy() {']), { state: {}, _homeGoing: p.a._homeGoing });
    ok('G1b a mint switch waits for the trip home (moneyBusy)', !!p.a._homeGoing && mb.moneyBusy() === true,
      '_homeGoing ' + !!p.a._homeGoing);
    // a second merchant at the same mint taps: same mint, paid straight from here
    p.reqs.t2 = request({ id: 't2', delivery: null, transports: [] });
    p.a.openRequest('t2', { viaTap: true });
    p.a.makeTokenForRequest();
    land();                  // the connect home lands while the payment is being made
    await wait(40);
    ok('G2 a tap paid at the mint the phone is on while the trip home is out is made from that mint',
      p.log.made === THEIRS, 'request names ' + THEIRS + '; the token was made at ' + p.log.made + ' (the connect home landed under it)');
  }
  {
    // PAY FROM: a request at Minibits paid from Kashu by a crossing, and a trip home owed from an earlier visit
    let moving = null;
    const p = phone({ there: 0, kashu: 5000, moveRun: () => new Promise((res) => { moving = res; }) });
    p.a.pfReqCrossing = () => ({ from: KASHU, plan: { net: 1000, feeSats: 2, from: KASHU, to: THEIRS, mintQuote: { quote: 'mqk' } } });
    p.a.setState({ screen: 'reqOffer', req: request() });
    p.a.makeTokenForRequest();
    await wait(5);
    ok('G3 (control) the crossing chosen on PAY FROM is moving sats', typeof moving === 'function');
    const said = p.a.homeWaitsFor();
    ok('G4 and the trip home waits for it', said !== '', 'homeWaitsFor() = "' + said + '" while sats move from Kashu to Minibits');
    p.a._homeOwed = MINE;   // NOT BACK HOME YET, earlier; a privacy push now (06-wallet-boot-and-restore.js)
    const before = p.log.connects.length;
    p.a.comeHomeOwed();
    const home = p.log.connects.slice(before).filter((c) => c.u === MINE);
    ok('G5 a trip home owed is not made in the middle of a crossing', home.length === 0,
      home.length + ' connect(s) to Forge while the move to Minibits was out');
  }

  console.log('D. the 150-second death of a payment still being made');
  {
    let answer = null;
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      const p = phone({ there: 5000, pay: (req) => (p.log.pays.filter((x) => x.id === 'r1').length === 1
        ? new Promise((res) => { answer = () => res({ hash: 'h-r1a', confirmed: true, website: true }); })
        : new Promise(() => {})) });
      p.reqs.r1 = request();
      p.a.setState({ screen: 'reqOffer', stack: ['home'], req: request() });
      p.a.makeTokenForRequest();
      await wait(5);
      ok('D (control) the first payment is out, on a visit to Minibits', p.log.pays.length === 1 && !!p.a._reqRun && p.W.mintUrl === THEIRS);
      // STOP WAITING (24-render-receive-and-send.js `sendStopWaiting`): home, the payment running on
      p.a.setState({ screen: 'home', stack: [], sendPhase: null });
      /* 151 s in. The post has not answered: the connect took 30 s, the swap a 429 and a second circuit (65 + 1.5 + 65,
       * 22-screen-lock.js), and the post is the Tor session's 60 s + 5 (07-request-delivery.js `HTTPS_REACH_MS`). */
      skew = 151000;
      p.a.openRequest('r1');
      p.a.makeTokenForRequest();
      await wait(5);
      const r1 = p.log.pays.filter((x) => x.id === 'r1');
      ok('D1 the same website request scanned again while the first post is still out is not paid again', r1.length === 1,
        r1.length + ' payments of r1 started; the first was never answered');
      ok('D1b and the refusal says it is still being delivered, with no promise of a minute',
        p.log.toasts.some((t) => /still being delivered/.test(t)) && !p.log.toasts.some((t) => /about a minute/.test(t)),
        JSON.stringify(p.log.toasts.slice(-1)));
      /* (fix) The clock is ten minutes now (`reqRunLive`), a backstop past any chain, so D1 holds at 151 s. D2 asks the
       * question at the clock itself: past it the first run is let go as dead and the same code paid again begins a
       * run of its own, and the first's late answer must leave that one alone. */
      skew = 601000;
      p.a.openRequest('r1');
      p.a.makeTokenForRequest();
      await wait(5);
      const run2 = p.a._reqRun;
      ok('D (control) past the clock the first run is let go and the second begins', !!run2 && p.log.pays.filter((x) => x.id === 'r1').length === 2,
        JSON.stringify({ run: !!run2, pays: p.log.pays.length }));
      answer();             // the first post answers 2xx, late
      await wait(5);
      ok('D2 the first payment’s late ending leaves the second’s hold alone', !!run2 && p.a._reqRun === run2 && p.a.state.reqBusy === true,
        'second run ' + (p.a._reqRun === run2 ? 'still set' : 'gone') + ', reqBusy ' + p.a.state.reqBusy + ', req ' + JSON.stringify(p.a.state.req && p.a.state.req.id) + ', sendPhase ' + p.a.state.sendPhase);
    } finally { Date.now = realNow; }
  }

  console.log('T. a token to show, while a trip home waits');
  {
    const p = phone({ there: 5000 });
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a._sendRun = new Promise(() => {});   // a Lightning send from here, still out
    p.a.crossComeHome();
    ok('T (control) the trip home waits for the send', p.a._homeWaiting === true && p.a._crossCameFrom === MINE);
    // a request at Minibits that names nowhere to deliver: a token to show, made here
    p.a.setState({ screen: 'reqOffer', req: request({ id: 'r3', delivery: null, transports: [] }) });
    p.a.makeTokenForRequest();
    await wait(5);
    p.a._sendRun = null;    // the send ends
    p.a.syncHome();
    await wait(5);
    ok('T1 once the send is over, the phone goes home', p.W.mintUrl === MINE,
      'phone at ' + p.W.mintUrl + ', _crossCameFrom ' + p.a._crossCameFrom + ' (the token’s ending wrote null over the home the send was holding)');
  }

  console.log('L2. a tap request’s pass dropped for another request');
  {
    let collect = null;
    const p = phone({ there: 0 });
    p.W.pendingMoves = () => [{ to: THEIRS, amount: 1000 }];
    p.W.finishMove = () => new Promise((res) => { collect = res; });
    const t1 = request({ id: 't1', delivery: null, transports: [], viaTap: true });
    p.a.setState({ screen: 'reqOffer', req: t1 });
    p.a.makeTokenForRequest();
    ok('L2 (control) the owed move is being collected first (COLLECTING…)', typeof collect === 'function' && p.a.state.reqCollecting === true);
    p.reqs.r2 = request({ id: 'r2', mints: [MINE], delivery: null, transports: [] });
    p.a.openRequest('r2');
    ok('L2b (fix) a second request is not opened over the one whose move is being collected, and that is said',
      p.a.state.req === t1 && p.log.toasts.some((t) => /collecting an earlier move/.test(t)),
      'on screen ' + JSON.stringify(p.a.state.req && p.a.state.req.id) + '; said ' + JSON.stringify(p.log.toasts.slice(-1)));
    // the person leaves the offer before the collect is back (as round 3's Z does), so the pass comes back to nothing
    p.a.setState({ screen: 'home', stack: [], req: null });
    collect();
    await wait(5);
    ok('L2a the other phone of the dropped tap is told the payment is not coming', p.log.told.some((j) => /gaveUp/.test(j)),
      'told: ' + JSON.stringify(p.log.told));
  }

  console.log('G6b. a request of this phone on show at the mint it is visiting, and the trip home');
  {
    /* G6 below shows the wallet's rule on the real wallet: a payment at a mint the phone has left is refused. So the
     * trip home must not land under a request on show; here, a receive screen showing one made at Minibits. */
    const p = phone({ there: 5000 });
    p.W.mintUrl = THEIRS;
    p.a._crossCameFrom = MINE;
    p.a._creqs = { [THEIRS + '|16|receive|$0']: { text: 'creqA-shown' } };
    p.a.setState({ screen: 'confirm', flow: 'receive' });
    p.a.crossComeHome();
    await wait(5);
    ok('G6b the trip home waits while the request is on show', p.W.mintUrl === THEIRS && !p.log.connects.some((c) => c.u === MINE) && p.a._homeWaiting === true,
      'phone at ' + p.W.mintUrl + '; homeWaitsFor() = "' + p.a.homeWaitsFor() + '"');
    // the screen goes, and its requests with it (12-receive.js `forgetRequests`)
    p.a._creqs = {};
    p.a.setState({ screen: 'home', flow: 'receive' });
    p.a.syncHome();
    await wait(5);
    ok('G6c (control) and comes home once it has gone', p.W.mintUrl === MINE, 'phone at ' + p.W.mintUrl);
  }
}

async function wallet() {
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS, booksWrong, rebook } = require('./harness');
  const HOME = 'https://home.test';
  const THEIR = 'https://their.test';
  const SITE = 'https://donate.example.org/api/pay/abc123';
  const SITE_WORDS = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  function page(script, shared) {
    const ph = nativePhone({ words: (shared && shared.words) || PHONE_WORDS });
    const mints = (shared && shared.mints) || {};
    let ctx = null;
    ctx = loadReal({
      bridge: (w, m) => {
        if (m.action === 'httpsPost') {
          script.posts.push({ url: m.url, body: m.body });
          if (script.onPost) script.onPost(ctx);
          return reply(w, m.id, script.code + '\n' + (script.body || ''));
        }
        if (m.action === 'tapQuote') { script.quotes = (script.quotes || 0) + 1; return reply(w, m.id, 'ok'); }
        if (m.action === 'tapSend') { script.taps = (script.taps || []); script.taps.push(m.body); return reply(w, m.id, JSON.stringify({ code: 200, ok: true })); }
        if (m.action === 'inboxClose') return reply(w, m.id, 'ok');
        if (m.action === 'onionPost') { script.onions = (script.onions || []); script.onions.push(m.body); return reply(w, m.id, '200\n{"ok":true}'); }
        if (m.action === 'mintRequest') {
          const u = new URL(m.url);
          const mint = mints[u.origin];
          if (!mint) return reply(w, m.id, null, 'no such mint in this test');
          if (ctx.down && ctx.down(u.origin, u.pathname)) return reply(w, m.id, null, 'The request timed out.');
          return reply(w, m.id, mint.handle(m));
        }
        const got = ph.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => {
        ph.attach(w);
        if (!shared) {
          mints[HOME] = fakeMint(w, { p2pk: true, fill: 7 });
          mints[THEIR] = fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 5000 });
        }
      },
    });
    ctx.mints = mints;
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    return ctx;
  }
  const creq = (ctx, mint, sats, id, transports) => new ctx.window.CashuTS.PaymentRequest(transports || [{ type: 'post', target: SITE }], id || 'deadbeefcafe0401', sats, 'sat', [mint], 'a donation', true).toEncodedRequest();
  const fund = async (W, at, sats, remember) => {
    await W.connect(at, null, null, remember === false ? { remember: false } : { remember: true });
    const inv = await W.invoice(sats, '');
    await W.claim(inv.hash);
  };
  const settle = async () => { for (let i = 0; i < 300; i++) await new Promise((r) => setTimeout(r, 0)); await wait(50); };
  const books = (ctx) => { const b = booksWrong(ctx); return b.length ? b.join(' | ') : ''; };
  // the site: a wallet of its own at the same mints, which redeems what it was posted when it likes
  const site = async (ctx) => {
    const s = page({ posts: [] }, { mints: ctx.mints, words: SITE_WORDS });
    await s.W.seedReady();
    await s.W.connect(HOME, null, null, { remember: true });
    return s;
  };
  const redeem = async (s, ctx, body, mint) => {
    const pay = JSON.parse(body);
    const text = ctx.window.CashuTS.getEncodedToken({ mint: mint || pay.mint, proofs: pay.proofs, unit: pay.unit || 'sat' });
    if (mint && mint !== HOME) await s.W.connect(mint, null, null, { remember: false });
    return s.W.receiveToken(text);
  };
  // the app's ending for a website's 2xx (requestDelivered), with the real wallet under it
  const delivered = (ctx, req, r) => {
    global.window = { FoxyWallet: ctx.W };
    const a = Object.assign(lift(['requestDelivered(req, r) {']), {
      state: {}, setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
      offlineNow: () => false, tapMarkPaid() {}, expectChange() {}, refreshBalance() {}, loadHistory() {}, tidyChangeLater() {},
      announcePayment() {}, watchToken(s, h) { ctx.W.watchTokenClaim(h, { persist: true }); },
    });
    a.requestDelivered(req, r);
  };

  console.log('G0. the wallet half of G: payRequest over a tap binds the wallet after the question asked first');
  {
    const script = { posts: [] };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await fund(W, HOME, 400);
    await fund(W, THEIR, 400, false);   // a visit to their mint, as a payment there makes
    const req = W.decodeRequest(creq(ctx, THEIR, 16, 'deadbeefcafe0402', []));
    req.viaTap = true;
    req.asks = true;
    const paying = W.payRequest(req, () => {});
    for (let i = 0; i < 100 && !W._askWaiter; i++) await wait(5);
    ok('G0 (control) the question is asked of the other phone, nothing made yet', !!W._askWaiter);
    await W.connect(HOME);               // the trip home lands while they answer
    if (W._askWaiter) W._askWaiter.done({ go: true });
    let r = null, threw = null;
    try { r = await paying; } catch (e) { threw = e; }
    const made = r && r.token ? W.tokenInfo(r.token) : null;
    ok('G0a a payment for a request at their mint is made at their mint, or refused',
      !!threw || (made && W.canonicalMint(made.mint) === THEIR),
      threw ? threw.message : 'request names ' + THEIR + '; the token handed over is ' + (made && made.mint) + ' ecash');
    rebook(ctx);
  }

  console.log('G6. a request shown to be paid at the mint being visited, when the trip home lands under it');
  {
    const script = { posts: [] };
    const payer = page(script);
    await payer.W.seedReady();
    await fund(payer.W, THEIR, 400, false);
    // the receiver: on a visit to their mint (a payment it made there is still out), it shows a request to be paid
    const rx = page({ posts: [] }, { mints: payer.mints, words: SITE_WORDS });
    await rx.W.seedReady();
    await rx.W.connect(HOME, null, null, { remember: true });
    await rx.W.connect(THEIR, null, null, { remember: false });
    const ONION = 'http://' + 'a'.repeat(55) + 'd.onion/' + 'ab'.repeat(8);
    const text = rx.W.paymentRequest(16, { purpose: 'receive', deliverTo: { onion: ONION } });
    const req = payer.W.decodeRequest(text);
    await payer.W.payRequest(req, () => {});
    const body = (script.onions || [])[0];
    let first = null;
    try { first = rx.W.readPayment(body); } catch (e) { first = e; }
    // (an error from the page's own realm is not a Node Error: read by its fields)
    ok('G6 (control) the payment is read as one for the request, while the phone is on that mint', !!first && first.sats === 16,
      first && first.message ? first.message : JSON.stringify(first && { sats: first.sats }));
    await rx.W.connect(HOME);           // the trip home (crossComeHome: nothing listed holds a request on show)
    let then = null;
    try { then = rx.W.readPayment(body); } catch (e) { then = e; }
    /* (fix) Kept as the wallet's rule: the phone takes a payment only at the mint it is on, where the redeem and the
     * signature check run. The fix is that the trip home does not land under a request on show (G6b above). */
    ok('G6a (control) once the trip home has landed, the wallet refuses it at a mint it has left',
      !!then && then.foxyStatus === 422 && /not at the mint the request named/.test(String(then.message)),
      then && then.message ? 'refused ' + then.foxyStatus + ': ' + then.message : JSON.stringify(then));
    rebook(payer); rebook(rx);
  }

  console.log('B. the books through a website payment’s life');
  {
    const script = { posts: [], code: 200 };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await fund(W, HOME, 400);
    rebook(ctx);
    const req = W.decodeRequest(creq(ctx, HOME, 16, 'deadbeefcafe0403'));
    const r = await W.payRequest(req, () => {});
    delivered(ctx, req, r);
    await settle();
    ok('B1 (control) a website’s 2xx, its token kept and watched: the books add up', books(ctx) === '', books(ctx));
    // RECLAIM before the site has redeemed (P4: offered at once)
    let back = null, why = '';
    try { back = await W.reclaimToken(r.token); } catch (e) { why = e.message; }
    await settle();
    ok('B2 (control) RECLAIM takes it back, and the books add up', !!back && books(ctx) === '', (why || '') + ' ' + books(ctx));
    // the site redeems late, and is refused: nothing changes on the phone
    const s = await site(ctx);
    let late = '';
    try { await redeem(s, ctx, script.posts[0].body); late = 'redeemed'; } catch (e) { late = 'refused: ' + e.message; }
    await settle();
    ok('B3 (control) the site’s late redeem after RECLAIM is refused at the mint, and the books still add up', /^refused/.test(late) && books(ctx) === '', late + ' ' + books(ctx));
  }
  {
    const script = { posts: [], code: 200 };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await fund(W, HOME, 400);
    rebook(ctx);
    const req = W.decodeRequest(creq(ctx, HOME, 16, 'deadbeefcafe0404'));
    const r = await W.payRequest(req, () => {});
    delivered(ctx, req, r);
    const s = await site(ctx);
    await redeem(s, ctx, script.posts[0].body);
    const st = await W.tokenClaimState(r.hash);
    if (st === 'claimed') { W.settleTx(r.hash); if (W.forgetClaimedToken) W.forgetClaimedToken(r.hash); }
    await settle();
    ok('B4 (control) the site redeems, the watch reads it claimed and settles it: the books add up', st === 'claimed' && books(ctx) === '', st + ' ' + books(ctx));
  }
  {
    // the site answers 500 having kept the pieces, the swap-back does not reach the mint, and the site redeems later
    const script = { posts: [], code: 500 };
    script.onPost = (c) => { c.down = (origin, p) => origin === HOME && p === '/v1/swap'; };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await fund(W, HOME, 400);
    rebook(ctx);
    let threw = null;
    try { await W.payRequest(W.decodeRequest(creq(ctx, HOME, 16, 'deadbeefcafe0405')), () => {}); } catch (e) { threw = e; }
    ctx.down = null;
    await settle();
    ok('B5 (control) refused by the site and back in the wallet at risk', !!(threw && threw.foxyAtRisk && !threw.foxyAtRisk.safe));
    const lost = JSON.parse(ctx.storage.getItem('foxy.cashu.swaps') || '[]');
    // twenty seconds on (as round 2's R), the lost swap's pieces are found unspent and go back to the pile
    ctx.storage.setItem('foxy.cashu.swaps', JSON.stringify(lost.map((x) => Object.assign(x, { at: x.at - 30, lastTry: (x.lastTry || x.at) - 30 }))));
    await W.recoverSwaps();
    await settle();
    ok('B6 (control) back in the pile and flagged at risk: the books add up', W.atRisk().length === 1 && books(ctx) === '',
      'at risk ' + JSON.stringify(W.atRisk()) + ' ' + books(ctx));
    const s = await site(ctx);
    let late = '';
    try { await redeem(s, ctx, script.posts[0].body); late = 'redeemed'; } catch (e) { late = 'refused: ' + e.message; }
    const out = await W.settleAtRisk();
    await settle();
    ok('B7 (control) the site redeemed after saying no; settleAtRisk enters it as taken and the books add up',
      late === 'redeemed' && W.atRisk().length === 0 && books(ctx) === '', late + '; settle ' + JSON.stringify(out) + '; at risk ' + JSON.stringify(W.atRisk()) + ' ' + books(ctx));
  }
  {
    // a crossing whose move went, then the website refused the payment made at the far mint; a second refusal there whose
    // swap-back did not go, settled from home after the site redeemed it
    const script = { posts: [], code: 500 };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await fund(W, HOME, 600);
    rebook(ctx);
    const plan = await W.transferQuote(HOME, 100, { to: THEIR, land: true });
    await W.moveRun(plan, () => {}, { visit: true });
    await settle();
    ok('B8 (control) the crossing to their mint landed: the books add up', W.balanceAt(THEIR) >= 100 && books(ctx) === '', W.balanceAt(THEIR) + ' there; ' + books(ctx));
    let threw = null;
    try { await W.payRequest(W.decodeRequest(creq(ctx, THEIR, 40, 'deadbeefcafe0406')), () => {}); } catch (e) { threw = e; }
    await settle();
    ok('B9 (control) the site refused the payment made there, the pieces swapped back: the books add up',
      !!(threw && threw.foxyAtRisk && threw.foxyAtRisk.safe) && books(ctx) === '', (threw && JSON.stringify(threw.foxyAtRisk)) + ' ' + books(ctx));
    script.onPost = (c) => { c.down = (origin, p) => origin === THEIR && p === '/v1/swap'; };
    threw = null;
    try { await W.payRequest(W.decodeRequest(creq(ctx, THEIR, 30, 'deadbeefcafe0407')), () => {}); } catch (e) { threw = e; }
    ctx.down = null;
    await W.connect(HOME);
    await settle();
    const lost = JSON.parse(ctx.storage.getItem('foxy.cashu.swaps') || '[]');
    ctx.storage.setItem('foxy.cashu.swaps', JSON.stringify(lost.map((x) => Object.assign(x, { at: x.at - 30, lastTry: (x.lastTry || x.at) - 30 }))));
    await W.recoverSwaps();
    await settle();
    const s = await site(ctx);
    let late = '';
    try { await redeem(s, ctx, script.posts[script.posts.length - 1].body, THEIR); late = 'redeemed'; } catch (e) { late = 'refused: ' + e.message; }
    const out = await W.settleAtRisk();
    await settle();
    ok('B10 (control) the group at the mint visited, settled from home after the site redeemed: taken, and the books add up',
      late === 'redeemed' && W.atRisk().length === 0 && books(ctx) === '', late + '; settle ' + JSON.stringify(out) + '; at risk ' + JSON.stringify(W.atRisk()) + ' ' + books(ctx));
  }
}

async function run() {
  await stubbed();
  await wallet();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
