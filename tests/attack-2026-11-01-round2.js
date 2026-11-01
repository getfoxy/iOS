'use strict';
/* attack-2026-11-01-round2.js — round two of the attack, on fd5be71 (the round-1 fixes).
 *
 *     node tests/attack-2026-11-01-round2.js
 *
 * Every case but the controls (marked "control") fails on fd5be71: each is a
 * finding in .claude/audits/attack-2026-11-01-round2.md, named by its letter.
 *
 *   R  a website's refusal at a mint the phone visited: the swap-back is tried
 *      once, there; if it does not go (the mint busy, or the site holding the
 *      pieces PENDING in a melt of its own), the phone comes home and nothing
 *      ever settles them: settleAtRisk and MAKE IT SAFE NOW look only at the
 *      connected mint, a visit runs no catch-up, and home rings red for 0
 *   S  a website's 2xx (202 Accepted) is final: the token is forgotten and no
 *      claim watch runs, though the site has not redeemed it
 *   M  PAY FROM's crossing pays a second move while the first is paid and not
 *      collected (round 1's I, moved to the PAY FROM path)
 *   T  `_crossMovedTo` outlives a crossing whose payment fails with nothing made
 *      (and the asked-no, refunded, at-risk, needs-mint, over-pay-no endings):
 *      a later refusal says the sats "are now at" that mint, and a later PAY
 *      FROM choice of a crossing to that mint is skipped
 *   N  a receiver that says no on the second asking, after the crossing moved
 *      the sats: "Nothing was sent. Your sats are where they were."
 *   U  a dollar request posted to a website with no answer: "Foxy is checking",
 *      and nothing checks
 *   W  STOP WAITING, then another request scanned: openRequest clears reqBusy,
 *      so a second request payment runs beside the first, and the first's end
 *      takes the phone home from under the second's visit
 *   H2 the "short there by its fee" crossing moves the whole amount again, not
 *      the shortfall, and leaves it at their mint after coming home
 *   X  a come-home whose connect fails is dropped: the phone stays at their mint
 *   C5 a mint host with a trailing dot is filed as another mint (`canonicalMint`)
 *
 * The stubbed cases lift methods out of build/foxy-app.js as
 * tests/attack-2026-11-01.js does; R and S run the real wallet on fake mints.
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
  return m ? m[1].toLowerCase() + '://' + m[2].toLowerCase().replace(/:443$/, '') + (m[3] || '').replace(/\/+$/, '') : String(u || '');
};

/* The phone of tests/attack-2026-11-01.js: on MINE with 2,591, `o.there` at THEIRS, the real crossMove. */
function phone(o) {
  const opts = o || {};
  const log = { connects: [], cards: [], crossCards: [], quotes: [], pays: [], tokens: [], toasts: [], moves: [], watched: [] };
  const held = { [MINE]: 2591, [THEIRS]: opts.there || 0 };
  const W = {
    mintUrl: MINE,
    mintHost: () => W.mintUrl.replace(/^https:\/\//, ''),
    canonicalMint: canon,
    mints: () => [{ id: MINE }, { id: THEIRS }, { id: KASHU }],
    balanceAt: (u) => held[u] || 0,
    transferQuote: (from, sats, x) => { log.quotes.push({ from, sats, to: x && x.to }); return Promise.resolve({ net: sats, feeSats: 2, to: x.to, from, mintQuote: { quote: 'mq' + log.quotes.length }, meltQuote: { quote: 'lq' + log.quotes.length } }); },
    connect: (u, a, b, x) => { log.connects.push({ u, remember: !(x && x.remember === false) }); W.mintUrl = canon(u); return Promise.resolve({}); },
    moveRun: (plan, st, x) => W.connect(plan.to, null, null, (x && x.visit) ? { remember: false } : undefined).then(() => {
      log.moves.push({ from: plan.from, to: plan.to, net: plan.net });
      held[canon(plan.to)] = (held[canon(plan.to)] || 0) + plan.net; held[canon(plan.from)] -= plan.net + plan.feeSats; return { sats: plan.net };
    }),
    transactions: () => Promise.resolve([]),
    payRequest: (req) => { log.pays.push({ at: W.mintUrl, sats: req.sats }); return opts.pay ? opts.pay(req, W) : Promise.resolve({ hash: 'h1', confirmed: true }); },
    sendToken: (sats) => { log.tokens.push({ at: W.mintUrl, sats }); return Promise.resolve({ hash: 'h2', token: 'cashuB', sats, swapped: true }); },
    sendShortfall: (sats) => (opts.short ? opts.short(W.mintUrl, sats) : { short: false, fee: 0 }),
    tag: () => {},
    reason: (e) => String((e && e.message) || e),
  };
  global.window = { FoxyWallet: W };
  const a = Object.assign(lift(['makeTokenForRequest(go) {', 'crossComeHome() {', 'crossMove(plan, theirs, mine, home) {', 'hushMove(plan) {']), {
    state: { screen: 'reqOffer', stack: ['home'], reqBusy: false, req: null, note: '' },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    offlineNow: () => false,
    refuseSwitchWhileBusy: () => false,
    changeComesBack: () => false,
    twoUnitsOn: () => false,
    crossMintCard(plan, theirs, mine) {
      return Promise.resolve(plan).then((p) => { log.crossCards.push({ net: p.net, fee: p.feeSats, theirs, mine }); return true; });
    },
    crossFailed(e, mine) { log.crossFailed = { why: String(e && e.message), mine, movePaid: !!(e && e.movePaid) }; },
    showMelt() {}, hideMelt() {},
    requestDelivered(req, r) { this.setState({ reqBusy: false, req: null, sendPhase: 'settled' }); },
    refreshBalance() {}, loadHistory() {}, needScanStage() {}, tidyChangeLater() {},
    watchToken(sats, hash) { log.watched.push(hash); },
    toast(t) { log.toasts.push(String(t)); },
    blockedCard(kind, c) { log.cards.push(Object.assign({ kind }, c)); if (kind === 'reqMint' && c.go) setTimeout(c.go, 0); },
    needsMintCard(why) { log.cards.push({ kind: 'needsMint', why }); },
    saidToReceiver: (s) => s,
    group: (n) => String(n), moneyIn: (n) => String(n),
    mintNameOf: (u) => NAMES[canon(u)] || '',
  });
  return { a, W, log, held };
}
const request = (o) => Object.assign({ id: 'r1', mints: [THEIRS], sats: 1000, unit: 'sat',
  delivery: { kind: 'https', target: 'https://donate.example.org/pay' } }, o || {});
const withPayFrom = (p) => Object.assign(p.a, lift(['pfMint(u) {', 'pfKey(mint, unit) {', 'pfFull(key) {', 'pfReqSource(req) {', 'pfReqCrossing(want) {']));

async function stubbed() {
  console.log('M. PAY FROM’s crossing, paid and not collected, then PAY again');
  {
    const p = phone({ there: 0 });
    p.held[KASHU] = 5000;
    withPayFrom(p);
    const pending = [];
    let runs = 0;
    p.W.pendingMoves = () => pending.slice();
    p.W.finishMove = () => { p.log.finished = (p.log.finished || 0) + 1; return Promise.resolve(); };
    p.W.moveRun = (plan) => { runs++; pending.push({ quote: plan.mintQuote.quote, to: plan.to, amount: plan.net });
      const e = new Error('Paid, and not yet claimed there.'); e.movePaid = true; e.moveSats = plan.net; e.moveTo = plan.to; return Promise.reject(e); };
    const plan1 = { net: 1000, feeSats: 3, from: KASHU, to: THEIRS, mintQuote: { quote: 'mqA', request: 'lnbcA' }, meltQuote: { quote: 'lqA' } };
    p.a._pf = { flow: 'req', full: { [KASHU + '|sat']: plan1 } };
    p.a.setState({ req: request(), payFromFlow: 'req', payMint: KASHU, payUnit: 'sat' });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('M0 the first move paid and was not collected (YOUR SATS ARE ON THEIR WAY)', runs === 1 && p.log.crossFailed && p.log.crossFailed.movePaid, JSON.stringify(p.log.crossFailed));
    // the request scanned again: a fresh PAY FROM, Kashu chosen again with a fresh quote
    const plan2 = { net: 1000, feeSats: 3, from: KASHU, to: THEIRS, mintQuote: { quote: 'mqB', request: 'lnbcB' }, meltQuote: { quote: 'lqB' } };
    p.a._pf = { flow: 'req', full: { [KASHU + '|sat']: plan2 } };
    p.a.setState({ screen: 'reqOffer', req: request(), payFromFlow: 'req', payMint: KASHU, payUnit: 'sat', reqBusy: false });
    p.W.mintUrl = MINE;
    p.a.makeTokenForRequest();
    await wait(30);
    ok('M1 the move still on its way is collected first, not made a second time from Kashu',
      runs === 1, runs + ' moves (a second routing fee, a second 1,000 off Kashu), finishMove called ' + (p.log.finished || 0) + ' times');
  }

  console.log('T. what a crossing whose payment was refused with nothing made leaves behind');
  {
    const p = phone({ there: 298, pay: () => Promise.reject(new Error('That request is no longer open.')) });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('T0 (control) crossed, nothing made, home again', p.log.moves.length === 1 && p.log.tokens.length === 0 && p.W.mintUrl === MINE, JSON.stringify({ moves: p.log.moves, at: p.W.mintUrl }));
    ok('T1 nothing about that crossing is left for the next payment', !p.a._crossMovedTo, '_crossMovedTo = ' + p.a._crossMovedTo);
    // (a) a later payment to somebody at Forge, refused in words: its sats never moved
    p.a.setState({ req: request({ id: 'r2', mints: [MINE], sats: 50 }), reqBusy: false, screen: 'reqOffer' });
    const pay0 = p.W.payRequest;
    p.W.payRequest = () => { const e = new Error('That request is closed.'); e.foxyRefused = true; e.foxyToken = { token: 'cashuBr2', hash: 'h10', sats: 50 }; return Promise.reject(e); };
    p.a.makeTokenForRequest();
    await wait(30);
    const card = p.log.cards.filter((c) => c.kind === 'theyRefused').slice(-1)[0];
    ok('T2 and a later refusal does not say its sats are now at Minibits', card && !/Minibits/.test(card.chip), card && card.chip);
    p.W.payRequest = pay0;
  }
  {
    // (b) the same leftover, then a request at Minibits paid from Kashu on PAY FROM
    const p = phone({ there: 298, pay: () => Promise.reject(new Error('That request is no longer open.')) });
    p.held[KASHU] = 5000;
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    withPayFrom(p);
    const plan = { net: 1000, feeSats: 3, from: KASHU, to: THEIRS, mintQuote: { quote: 'mqK', request: 'lnbcK' }, meltQuote: { quote: 'lqK' } };
    p.a._pf = { flow: 'req', full: { [KASHU + '|sat']: plan } };
    p.held[THEIRS] = 0;
    p.a.setState({ req: request({ id: 'r3' }), screen: 'reqOffer', reqBusy: false, payFromFlow: 'req', payMint: KASHU, payUnit: 'sat' });
    p.W.payRequest = () => Promise.resolve({ hash: 'h3', confirmed: true });
    const cardsBefore = p.log.crossCards.length;
    p.a.makeTokenForRequest();
    await wait(30);
    const last = p.log.moves.slice(-1)[0];
    ok('T3 a later PAY FROM choice of Kashu for a request at Minibits moves from Kashu, as the offer said',
      last && last.from === KASHU && p.log.crossCards.length === cardsBefore,
      'moved from ' + (last && last.from) + '; a second crossing card from ' + JSON.stringify(p.log.crossCards.slice(cardsBefore)));
  }

  console.log('N. asked again after the crossing, and told no');
  {
    const p = phone({ there: 0, pay: () => { const e = new Error('That request has expired.'); e.foxyAskedNo = true; return Promise.reject(e); } });
    p.a.setState({ req: request({ viaTap: true, asks: true, delivery: null }) });
    p.a.makeTokenForRequest();
    await wait(30);
    const card = p.log.cards.filter((c) => c.kind === 'theyRefused').slice(-1)[0];
    ok('N1 a no after 1,000 sats were moved to their mint does not say the sats are where they were',
      p.log.moves.length === 1 && card && !/where they were/.test(card.chip),
      'moved ' + JSON.stringify(p.log.moves) + ', card: ' + (card && card.chip) + ', phone at ' + p.W.mintUrl);
  }

  console.log('U. a dollar request posted to a website that did not answer');
  {
    const p = phone({ pay: () => { const e = new Error('The payment may have reached them; Foxy is checking.'); e.foxyMaybeSent = true;
      e.foxyToken = { token: 'cashuBusd', hash: 'hU', sats: 0, unit: 'usd', amount: 500, swapped: true }; return Promise.reject(e); } });
    p.a.setState({ req: request({ mints: [MINE], unit: 'usd', amount: 500, sats: null }) });
    p.a.makeTokenForRequest();
    await wait(30);
    const said = p.log.toasts.slice(-1)[0] || '';
    ok('U1 "Foxy is checking" is said only where something checks (a claim watch on the token)',
      !/Foxy is checking/.test(said) || p.log.watched.indexOf('hU') >= 0, 'said "' + said + '", watches started: ' + JSON.stringify(p.log.watched));
  }

  console.log('H2. short at their mint by its fee: what the crossing moves');
  {
    const p = phone({ there: 1000, short: (at, sats) => (at === THEIRS && p.held[THEIRS] < sats + 2 ? { short: true, fee: 2 } : { short: false, fee: 0 }) });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(60);
    ok('H2 the crossing moves what is short (2), not the whole 1,000 again', p.log.quotes.length === 1 && p.log.quotes[0].sats < 1000,
      'quoted ' + JSON.stringify(p.log.quotes) + '; left at Minibits after coming home: ' + p.held[THEIRS] + ', phone at ' + p.W.mintUrl);
  }

  console.log('X. home, when home does not answer');
  {
    const p = phone({ there: 1500 });
    const connect0 = p.W.connect;
    let downHome = false;
    p.W.connect = (u, a, b, x) => (downHome && canon(u) === MINE ? Promise.reject(new Error('The request timed out.')) : connect0(u, a, b, x));
    p.W.payRequest = (req) => { p.log.pays.push({ at: p.W.mintUrl }); downHome = true; return Promise.resolve({ hash: 'hX', confirmed: true }); };
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    downHome = false;
    await wait(10);
    ok('X1 a come-home whose connect fails is tried again (or kept to try), not dropped with the phone left at their mint',
      p.W.mintUrl === MINE || !!p.a._crossCameFrom, 'phone at ' + p.W.mintUrl + ', nothing left to bring it home (_crossCameFrom ' + p.a._crossCameFrom + ')');
  }

  console.log('W. STOP WAITING, then another request');
  {
    // the first: posted to a website at Minibits from Forge, still waiting on the site (a slow exit)
    let failFirst = null;
    const p = phone({ there: 1500 });
    Object.assign(p.a, lift(['openRequest(text, opts) {', 'requestHere(req) {', 'tellPayerShort(req) {']));
    p.W.decodeRequest = (t) => (t === 'creqB-second' ? request({ id: 'r2', mints: [KASHU], sats: 100 }) : null);
    p.W.unclaimedSats = () => 0;
    p.held[KASHU] = 5000;
    const during = [];
    p.W.payRequest = (req) => {
      p.log.pays.push({ at: p.W.mintUrl, id: req.id });
      if (req.id === 'r1') return new Promise((res, rej) => { failFirst = () => rej(Object.assign(new Error('Their address could not be reached over Tor.'))); });
      // the second: made at Kashu, and what the phone is on while it is delivered
      return wait(20).then(() => { during.push(p.W.mintUrl); return wait(20); }).then(() => { during.push(p.W.mintUrl); return { hash: 'h2nd', confirmed: true }; });
    };
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(20);
    ok('W0 (control) the first is being paid at Minibits, reqBusy set', p.a.state.reqBusy === true && p.W.mintUrl === THEIRS, JSON.stringify({ busy: p.a.state.reqBusy, at: p.W.mintUrl }));
    // STOP WAITING (24-render-receive-and-send.js `sendStopWaiting`): home, reqBusy untouched; then a second request scanned
    p.a.setState({ screen: 'home', stack: [], sendSlow: false, sendPhase: null });
    p.a.openRequest('creqB-second');
    const busyAfterOpen = p.a.state.reqBusy;
    p.a.makeTokenForRequest();
    await wait(10);
    failFirst();
    await wait(80);
    ok('W1 a second request is not paid while the first is still out (openRequest must not clear reqBusy under a payment)',
      !(busyAfterOpen === false && p.log.pays.filter((x) => x.id === 'r2').length === 1),
      'reqBusy after openRequest: ' + busyAfterOpen + ', payments: ' + JSON.stringify(p.log.pays));
    ok('W2 and the first one’s ending does not take the phone off the mint the second is being paid from',
      during.every((u) => u === KASHU), 'the second was being delivered from ' + JSON.stringify(during));
  }
  {
    // the same donation page, slow: STOP WAITING, then the same code scanned again to "try again"
    const p = phone({ there: 0 });
    Object.assign(p.a, lift(['openRequest(text, opts) {', 'requestHere(req) {', 'tellPayerShort(req) {']));
    p.W.decodeRequest = (t) => (t === 'creqB-same' ? request({ mints: [MINE] }) : null);
    p.W.unclaimedSats = () => 0;
    const answers = [];
    p.W.payRequest = (req) => {
      p.log.pays.push({ at: p.W.mintUrl, id: req.id });
      // each post lands at the site; the first answers late (a slow exit), the second at once
      return new Promise((res) => answers.push(() => res({ hash: 'h' + answers.length, confirmed: true })));
    };
    p.a.openRequest('creqB-same');
    p.a.makeTokenForRequest();
    await wait(10);
    p.a.setState({ screen: 'home', stack: [], sendSlow: false, sendPhase: null });
    p.a.openRequest('creqB-same');
    p.a.makeTokenForRequest();
    await wait(10);
    answers.forEach((f) => f());
    await wait(20);
    ok('W3 the same request scanned again after STOP WAITING is not paid a second time while the first post is out',
      p.log.pays.filter((x) => x.id === 'r1').length === 1, p.log.pays.length + ' payments of request r1 posted: ' + JSON.stringify(p.log.pays));
  }
}

async function wallet() {
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS, noBooks } = require('./harness');
  const HOME = 'https://home.test';
  const THEIR = 'https://their.test';
  const SITE = 'https://donate.example.org/api/pay/abc123';
  function page(script) {
    const ph = nativePhone({ words: PHONE_WORDS });
    const mints = {};
    const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
    let ctx = null;
    ctx = loadReal({
      bridge: (w, m) => {
        if (m.action === 'httpsPost') {
          script.posts.push({ url: m.url, body: m.body });
          if (script.onPost) script.onPost(ctx);
          if (script.error) return reply(w, m.id, null, script.error);
          return reply(w, m.id, script.code + '\n' + (script.body || ''));
        }
        if (m.action === 'inboxClose') return reply(w, m.id, 'ok');
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
        mints[HOME] = fakeMint(w, { p2pk: true, fill: 7 });
        mints[THEIR] = fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 5000 });
      },
    });
    ctx.mints = mints;
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    noBooks(ctx, 'attack round 2: a website holds pieces behind the wallet’s back');
    return ctx;
  }
  const creq = (ctx, mint, sats, id) => new ctx.window.CashuTS.PaymentRequest([{ type: 'post', target: SITE }], id || 'deadbeefcafe0101', sats, 'sat', [mint], 'a donation', true).toEncodedRequest();
  const fund = async (W, at, sats, remember) => {
    await W.connect(at, null, null, remember === false ? { remember: false } : { remember: true });
    const inv = await W.invoice(sats, '');
    await W.claim(inv.hash);
  };
  const settle = async () => { for (let i = 0; i < 300; i++) await new Promise((r) => setTimeout(r, 0)); await wait(50); };

  console.log('R. a website’s refusal at a mint the phone visited, whose swap-back did not go');
  {
    const script = { posts: [], code: 500 };
    // the site has the pieces; the swap Foxy makes to take them back does not reach their mint (busy, or the pieces PENDING)
    script.onPost = (c) => { c.down = (origin, p) => origin === THEIR && p === '/v1/swap'; };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await fund(W, THEIR, 400);
    await fund(W, HOME, 400);
    // the visit makeTokenForRequest makes (remember: false)
    await W.connect(THEIR, null, null, { remember: false });
    let threw = null;
    try { await W.payRequest(W.decodeRequest(creq(ctx, THEIR, 16)), () => {}); } catch (e) { threw = e; }
    ok('R0 (control) refused by the site, put back at risk, and the swap-back did not go',
      threw && threw.foxyWebsite && threw.foxyAtRisk && !threw.foxyAtRisk.safe && !threw.foxyAtRisk.taken && !threw.foxyAtRisk.onEntry,
      threw ? threw.message + ' ' + JSON.stringify(threw.foxyAtRisk) : 'not refused');
    const sent = (() => { try { return JSON.parse(script.posts[0].body).proofs.map((x) => x.secret); } catch (e) { return []; } })();
    ctx.down = null;
    // crossComeHome: home, with a route; its connect runs the catch-up (catchUpCrossings -> settleAtRisk)
    await W.connect(HOME);
    await settle();
    /* The swap-back's timeout held the pieces aside as a lost answer (04-lost-answers.js `holdInputs`); twenty seconds
     * on, the mint says they are unspent and they go back in the pile (15-receiving.js `_recoverSwapsOnce`, which asks
     * other mints too). Those twenty seconds, passed. */
    const swaps = JSON.parse(ctx.storage.getItem('foxy.cashu.swaps') || '[]').map((r) => Object.assign(r, { at: r.at - 30, lastTry: (r.lastTry || r.at) - 30 }));
    ctx.storage.setItem('foxy.cashu.swaps', JSON.stringify(swaps));
    await W.recoverSwaps();
    await settle();
    // MAKE IT SAFE NOW on the entry (11-cards.js `settleAtRiskNow`), and a route coming back (catchUpCrossings)
    await W.takeBackRefused();
    const out = await W.settleAtRisk();
    await W.catchUpCrossings();
    await settle();
    const live = () => sent.filter((s) => ctx.mints[THEIR].spentSecrets.indexOf(s) < 0);
    const left = W.atRisk().filter((g) => g.mint === THEIR);
    ok('R1 home again, the pieces the website saw are swapped for fresh ones at their own mint',
      live().length === 0, live().length + ' of ' + sent.length + ' pieces the site holds still unspent at ' + THEIR + ', back in the pile ('
        + W.balanceAt(THEIR) + ' there) and flagged: ' + JSON.stringify(left.map((g) => ({ sats: g.sats, mint: g.mint }))) + '; settleAtRisk answered ' + JSON.stringify(out));
    ok('R2 and home says money is at risk while it is (the red ring reads atRiskSats)', W.atRiskSats() > 0 || live().length === 0,
      'atRiskSats() at home = ' + W.atRiskSats() + ' with ' + (left[0] ? left[0].sats : 0) + ' at risk at ' + THEIR);
    // a later visit there (another payment at their mint): a visit runs no catch-up
    await W.connect(THEIR, null, null, { remember: false });
    await settle();
    ok('R3 a later visit to their mint swaps them', live().length === 0,
      live().length + ' piece(s) the site holds still unspent after a visit (connect skips catchUpCrossings when remember is false)');
    await W.connect(HOME);
    await settle();
  }

  console.log('S. a website’s 202 Accepted');
  {
    const script = { posts: [], code: 202 };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await fund(W, HOME, 400);
    const req = W.decodeRequest(creq(ctx, HOME, 16, 'deadbeefcafe0202'));
    const r = await W.payRequest(req, () => {});
    ok('S0 (control) a 202 is read as confirmed', r && r.confirmed === true, JSON.stringify(r && { confirmed: r.confirmed }));
    // C, once more: the same mint with a dot after its host (a name a resolver reads as the same) is filed apart
    ok('C5 a mint written with a trailing dot on its host is the same mint (one pile, no crossing, no new mint)',
      W.canonicalMint('https://mint.minibits.cash./Bitcoin') === W.canonicalMint('https://mint.minibits.cash/Bitcoin'),
      W.canonicalMint('https://mint.minibits.cash./Bitcoin') + ' vs ' + W.canonicalMint('https://mint.minibits.cash/Bitcoin'));
    // the app's ending for a confirmed payment, with the real wallet under it
    global.window = { FoxyWallet: W };
    const watched = [];
    const a = Object.assign(lift(['requestDelivered(req, r) {']), {
      state: {}, setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
      offlineNow: () => false, tapMarkPaid() {}, expectChange() {}, refreshBalance() {}, loadHistory() {}, tidyChangeLater() {},
      announcePayment() {}, watchToken(s, h) { watched.push(h); W.watchTokenClaim(h, { persist: true }); },
    });
    a.requestDelivered(req, r);
    const sent = (() => { try { return JSON.parse(script.posts[0].body).proofs.map((x) => x.secret); } catch (e) { return []; } })();
    const unspent = sent.filter((s) => ctx.mints[HOME].spentSecrets.indexOf(s) < 0).length;
    const textKept = W._sentTokens().some((t) => t.token === r.token);
    const watching = W.watchedTokens().some((x) => x.hash === r.hash);
    ok('S1 a website’s 2xx, with the pieces unspent at the mint, keeps the token and a claim watch until the mint says spent',
      textKept || watching, 'site never redeemed: ' + unspent + ' of ' + sent.length + ' pieces unspent; token text on file: ' + textKept + ', claim watch: ' + watching);
  }
}

async function run() {
  await stubbed();
  await wallet();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
