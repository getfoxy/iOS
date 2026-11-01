'use strict';
/* attack-2026-11-01.js — round one of the attack on 5a74f01, 72bd222 and 3eb3fe6.
 *
 *     node tests/attack-2026-11-01.js
 *
 * Every case here but the controls failed on 3eb3fe6: each is a finding in
 * .claude/audits/attack-2026-11-01-round1.md, named by its letter. They pass
 * since the round-1 fixes, and check-all runs them so that none comes back.
 *
 *   K  a website answering the payment's POST with a same-host redirect: the
 *      bridge followed it as a GET with no body and the page read its 200 as
 *      paid (the bridge now never redirects this post, and says "redirected N"
 *      if one gets through; the page confirms a 2xx status line only)
 *
 *   A  a payment made straight to them at another mint whose delivery fails
 *      (a website's 500, an onion that does not answer, no relay) is shown as
 *      a token and the visit never ends: the phone stays at their mint, and the
 *      mint to come home to is left set for whatever runs next
 *   B  a crossing whose payment became a token to show leaves `_crossMovedTo`
 *      set, and the next refusal says the sats "are now at" that mint
 *   C  a request whose mint is the same mint written differently (capitals in
 *      the host) is crossed to with a Lightning fee though the phone holds
 *      enough there, asks A DIFFERENT MINT again after the sats have moved, and
 *      the visit overwrites the home it should return to
 *   D  a website that answers 201, 202 or 204 took the payment and is told it
 *      did not; the token comes back to "show them" and nothing takes it back
 *   E  the https post's two clocks: the page gives up at 50 s, the native post
 *      runs to Tor's 60 s and ignores the timeout the page sends
 *   F  a scanned request posted to a website carries `changeTo`, a key of this
 *      phone's, once the lock pool has been filled (any tap or shown request)
 *   G  the native post skips the host checks a mint request gets
 *      (Route.urlProblem), and the offer says OVER TOR on the open connection
 *   H  a request at a mint that charges per piece, where the phone holds
 *      exactly the amount there: no crossing is offered and the payment is
 *      refused there
 *
 * A-C and H lift `makeTokenForRequest`, `crossMove` and `crossComeHome` out of
 * build/foxy-app.js and run them against a stand-in wallet, as
 * scan-cross-mint.js does; D and F run the real wallet against a fake mint, as
 * https-delivery.js does; E and G read the sources.
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
// the wallet's own spelling of a mint (00-header-and-mint-errors.js `canonicalMint`): scheme and host in small letters
const canon = (u) => {
  const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(String(u || '').trim());
  return m ? m[1].toLowerCase() + '://' + m[2].toLowerCase().replace(/:443$/, '') + (m[3] || '').replace(/\/+$/, '') : String(u || '');
};

/* A phone on MINE with 2,591 there and `o.there` at THEIRS, as scan-cross-mint.js has it, with the real crossMove.
 * `o.pay(req, W)`: what payRequest does. `o.short(at)`: sendShortfall's answer at a mint (default: never short). */
function phone(o) {
  const opts = o || {};
  const log = { connects: [], cards: [], crossCards: [], quotes: [], pays: [], tokens: [], toasts: [] };
  const held = { [MINE]: 2591, [THEIRS]: opts.there || 0 };
  const W = {
    mintUrl: MINE,
    mintHost: () => W.mintUrl.replace(/^https:\/\//, ''),
    mints: () => [{ id: MINE }, { id: THEIRS }],
    // read by the key it is given, exactly as the wallet's own (`balanceAt` loads K.proofs + '.' + url)
    balanceAt: (u) => held[u] || 0,
    transferQuote: (from, sats, x) => { log.quotes.push({ from, sats, to: x && x.to }); return Promise.resolve({ net: sats, feeSats: 2, to: x.to, from, mintQuote: { quote: 'mq' }, meltQuote: { quote: 'lq' } }); },
    // the wallet's connect writes the mint in its own spelling (11-routing.js)
    connect: (u, a, b, x) => { log.connects.push({ u, remember: !(x && x.remember === false) }); W.mintUrl = canon(u); return Promise.resolve({}); },
    moveRun: (plan, st, x) => W.connect(plan.to, null, null, (x && x.visit) ? { remember: false } : undefined).then(() => {
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
    crossFailed(e, mine) { log.crossFailed = { why: String(e && e.message), mine }; },
    showMelt() {}, hideMelt() {},
    requestDelivered(req, r) { this.setState({ reqBusy: false, req: null, sendPhase: 'settled' }); },
    refreshBalance() {}, loadHistory() {}, needScanStage() {}, watchToken() {}, tidyChangeLater() {},
    toast(t) { log.toasts.push(String(t)); },
    // a card answered as the person would: A DIFFERENT MINT is accepted, the rest recorded
    blockedCard(kind, c) { log.cards.push(Object.assign({ kind }, c)); if (kind === 'reqMint' && opts.acceptMint !== false && c.go) setTimeout(c.go, 0); },
    needsMintCard(why) { log.cards.push({ kind: 'needsMint', why }); },
    saidToReceiver: (s) => s,
    group: (n) => String(n), moneyIn: (n) => String(n),
    mintNameOf: (u) => NAMES[canon(u)] || '',
  });
  return { a, W, log, held };
}
const request = (o) => Object.assign({ id: 'r1', mints: [THEIRS], sats: 1000, unit: 'sat',
  delivery: { kind: 'https', target: 'https://donate.example.org/pay' } }, o || {});
// what payRequest throws when the token was made and the delivery failed (20-helpers.js `carryToken`)
const undelivered = (why) => () => { const e = new Error(why); e.foxyToken = { token: 'cashuBmade', hash: 'h9', sats: 1000, swapped: true }; return Promise.reject(e); };

async function stubbed() {
  console.log('A. a visit whose delivery failed never comes home');
  {
    const p = phone({ there: 1500, pay: undelivered('Their address did not take the payment (500).') });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('A1 their mint was visited, not remembered', p.log.connects[0] && p.log.connects[0].u === THEIRS && !p.log.connects[0].remember, JSON.stringify(p.log.connects));
    ok('A2 the token is shown to hand over', p.a.state.screen === 'tokenOut' && p.a.state.tokenOut === 'cashuBmade', p.a.state.screen);
    ok('A3 and the phone is home again, on the mint the person banks at', p.W.mintUrl === MINE, 'still at ' + p.W.mintUrl);
    ok('A4 with no mint left to come home to for the next flow to act on', !p.a._crossCameFrom, '_crossCameFrom = ' + p.a._crossCameFrom);
  }
  {
    const p = phone({ there: 1500, pay: () => Promise.reject(new Error('Their address could not be reached over Tor.')) });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('A5 (control) a failure with nothing made does come home', p.W.mintUrl === MINE, p.W.mintUrl);
  }

  console.log('B. a crossing that became a token leaves where it moved the sats');
  {
    const p = phone({ there: 298 });
    p.a.setState({ req: request({ delivery: null }) });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('B0 crossed, and a token made there', p.log.crossCards.length === 1 && p.log.tokens.length === 1 && p.log.tokens[0].at === THEIRS, JSON.stringify(p.log));
    ok('B1 nothing about that crossing is left for the next payment', !p.a._crossMovedTo, '_crossMovedTo = ' + p.a._crossMovedTo);
    // a later payment to somebody at Forge, refused in words: its sats never moved anywhere
    p.a.setState({ req: request({ id: 'r2', mints: [MINE], sats: 50 }), reqBusy: false, screen: 'reqOffer' });
    p.W.payRequest = () => { const e = new Error('That request is closed.'); e.foxyRefused = true; e.foxyToken = { token: 'cashuBr2', hash: 'h10', sats: 50 }; return Promise.reject(e); };
    p.a.makeTokenForRequest();
    await wait(30);
    const card = p.log.cards.filter((c) => c.kind === 'theyRefused').slice(-1)[0];
    ok('B2 and its refusal does not say the sats are now at Minibits', card && !/Minibits/.test(card.chip), card && card.chip);
  }

  console.log('C. the same mint written with capitals');
  {
    const SHOUT = 'https://MINT.minibits.cash/Bitcoin';
    const p = phone({ there: 1500 });
    p.a.setState({ req: request({ mints: [SHOUT] }) });
    p.a.makeTokenForRequest();
    await wait(60);
    ok('C1 no crossing is offered: 1,500 of the 1,000 are already at that mint', p.log.crossCards.length === 0,
      p.log.crossCards.length + ' crossing(s), quoted ' + JSON.stringify(p.log.quotes));
    ok('C2 A DIFFERENT MINT is asked once at most', p.log.cards.filter((c) => c.kind === 'reqMint').length <= 1,
      p.log.cards.filter((c) => c.kind === 'reqMint').length + ' times');
    ok('C3 and after the payment the phone is home at Forge', p.W.mintUrl === MINE, 'at ' + p.W.mintUrl + ', connects ' + JSON.stringify(p.log.connects));
  }
  {
    // the card answered no the second time: the sats have been moved and nothing is paid
    const SHOUT = 'https://MINT.minibits.cash/Bitcoin';
    let seen = 0;
    const p = phone({ there: 1500, acceptMint: false });
    p.a.blockedCard = function (kind, c) { p.log.cards.push(Object.assign({ kind }, c)); if (kind === 'reqMint' && ++seen === 1) setTimeout(c.go, 0); };
    p.a.setState({ req: request({ mints: [SHOUT] }) });
    p.a.makeTokenForRequest();
    await wait(60);
    ok('C4 a no to the second A DIFFERENT MINT does not leave moved sats behind at Minibits and the phone there',
      !(p.log.crossCards.length && !p.log.pays.length && p.W.mintUrl === THEIRS),
      'moved ' + p.log.crossCards.length + ', paid ' + p.log.pays.length + ', at ' + p.W.mintUrl + ', _crossCameFrom ' + p.a._crossCameFrom);
  }

  console.log('H. a mint that charges per piece');
  {
    // 1,000 held there, 1,002 needed with its fee; the tap path asks `sendShortfall` there (26d-tap.js `tapPayFromThere`)
    const p = phone({ there: 1000, short: (at, sats) => (at === THEIRS ? { short: true, fee: 2, need: sats + 2, have: 1000 } : { short: false, fee: 0 }),
      pay: () => Promise.reject(new Error('Not enough ecash: this payment needs 1,002 sats with the mint’s fee, and you hold 1,000.')) });
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('H1 the crossing is offered for what that mint’s fee leaves short', p.log.crossCards.length === 1,
      'no crossing; paid at ' + JSON.stringify(p.log.pays) + ', said ' + JSON.stringify(p.log.toasts));
  }

  console.log('I. a move that paid and was not collected, then PAY again');
  {
    // the first move's melt went, their mint has not issued yet (14-moving-between-mints.js: e.movePaid)
    const p = phone({ there: 298 });
    let runs = 0;
    const pending = [];
    p.W.pendingMoves = () => pending.slice();
    p.W.finishMove = () => { p.log.finished = (p.log.finished || 0) + 1; return Promise.resolve(); };
    p.W.moveRun = (plan) => { runs++; pending.push({ quote: 'mq' + runs, to: plan.to });
      const e = new Error('Paid, and not yet claimed there.'); e.movePaid = true; e.moveSats = plan.net; e.moveTo = plan.to; return Promise.reject(e); };
    p.a.setState({ req: request() });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('I0 the first move paid and was not collected', runs === 1 && p.log.crossFailed && p.log.crossFailed.why.indexOf('not yet claimed') >= 0, JSON.stringify(p.log.crossFailed));
    // the card says the sats are on their way; the offer is still there, and PAY is pressed again
    p.a.setState({ screen: 'reqOffer', crossBusy: false });
    p.a.makeTokenForRequest();
    await wait(30);
    ok('I1 the move still on its way is collected first, not made a second time (a second routing fee, another 1,000 off home)',
      runs === 1 && p.log.quotes.length === 1, runs + ' moves, ' + p.log.quotes.length + ' quotes, finishMove called ' + (p.log.finished || 0) + ' times');
  }

  console.log('J. PAY FROM’s crossing, then an over-payment question');
  {
    const C = 'https://kashu.example.com';
    NAMES[C] = 'Kashu';
    const p = phone({ there: 0 });
    p.held[C] = 5000;
    Object.assign(p.a, lift(['pfMint(u) {', 'pfKey(mint, unit) {', 'pfFull(key) {', 'pfReqSource(req) {', 'pfReqCrossing(want) {']));
    let runs = 0;
    const realMove = p.W.moveRun;
    p.W.moveRun = (plan, st, x) => { runs++; return runs > 1 ? Promise.reject(new Error('Invoice already paid.')) : realMove(plan, st, x); };
    // a tap at the same mint as theirs, an offline receiver (no change back), Kashu chosen on PAY FROM with its quoted crossing
    const plan = { net: 1000, feeSats: 3, from: C, to: THEIRS, mintQuote: { quote: 'mq1', request: 'lnbc-their-invoice' }, meltQuote: { quote: 'lq1' } };
    p.a._pf = { flow: 'req', full: { [C + '|sat']: plan } };
    p.a.setState({ req: request({ viaTap: true, theirRoute: false, delivery: null }), payFromFlow: 'req', payMint: C, payUnit: 'sat' });
    let first = true;
    p.W.payRequest = (req) => { p.log.pays.push({ at: p.W.mintUrl }); if (first) { first = false; const e = new Error('no exact pieces'); e.foxyNeedsOverpay = { pay: 1024, asked: 1000 }; return Promise.reject(e); } return Promise.resolve({ hash: 'h1', confirmed: true }); };
    p.a.overpayCard = () => Promise.resolve(true);
    p.W.mintUrl = MINE;
    p.a.makeTokenForRequest();
    await wait(60);
    ok('J1 the over-payment answered yes pays from what was moved, without running the same crossing again',
      runs === 1 && p.log.pays.length === 2, runs + ' moves of the one plan, ' + p.log.pays.length + ' payment attempts, crossFailed: ' + JSON.stringify(p.log.crossFailed));
  }
}

async function wallet() {
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
  const MINT = 'https://m.test';
  const SITE = 'https://donate.example.org/api/pay/abc123';
  function page(script) {
    const ph = nativePhone({ words: PHONE_WORDS });
    let mint = null;
    const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
    const ctx = loadReal({
      bridge: (w, m) => {
        if (m.action === 'httpsPost') {
          script.posts.push({ url: m.url, body: m.body, timeout: m.timeout });
          if (script.error) return reply(w, m.id, null, script.error);
          return reply(w, m.id, script.code + '\n' + (script.body || ''));
        }
        if (m.action === 'inboxClose') return reply(w, m.id, 'ok');
        if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
        const got = ph.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => { ph.attach(w); mint = fakeMint(w, { p2pk: true }); },
    });
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    return ctx;
  }
  const creq = (ctx, id) => new ctx.window.CashuTS.PaymentRequest([{ type: 'post', target: SITE }], id || 'deadbeefcafe0001', 21, 'sat', [MINT], 'a donation', true).toEncodedRequest();

  console.log('D. a website that took it with a 2xx other than 200');
  for (const code of [201, 202, 204]) {
    const script = { posts: [], code };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    let threw = null, r = null;
    try { r = await W.payRequest(W.decodeRequest(creq(ctx)), () => {}); } catch (e) { threw = e; }
    ok('D ' + code + ': a ' + code + ' is the website saying it took the payment', !threw && r && r.confirmed === true,
      threw ? 'refused: "' + threw.message + '", token handed back to show: ' + !!(threw.foxyToken && threw.foxyToken.token) + ', taken back (foxyRefused/afterRefusal): ' + !!threw.foxyRefused : 'unconfirmed');
  }

  // a website's answer the page must not read as paid, and what then becomes of the proofs it saw
  const refusedAt = async (script) => {
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    const before = W.balanceAt(MINT);
    let threw = null, r = null;
    try { r = await W.payRequest(W.decodeRequest(creq(ctx)), () => {}); } catch (e) { threw = e; }
    return { r, threw, before, after: W.balanceAt(MINT) };
  };
  console.log('K. a redirect is never a payment taken');
  for (const line of ['redirected 200', '301', '302', '303']) {
    const t = await refusedAt({ posts: [], code: line, body: '<html>Donate page</html>' });
    ok('K ' + line + ': not confirmed, and the pieces the site saw are taken back',
      t.threw && !(t.r && t.r.confirmed) && t.threw.foxyRefused && t.threw.foxyAtRisk && t.threw.foxyAtRisk.safe === true && t.after === t.before,
      t.threw ? t.threw.message + ' ' + JSON.stringify({ refused: !!t.threw.foxyRefused, atRisk: t.threw.foxyAtRisk, before: t.before, after: t.after }) : 'read as paid');
  }
  console.log('D. any other answer is a refusal, and the pieces come back');
  {
    const t = await refusedAt({ posts: [], code: 500 });
    ok('D 500: refused by its number, taken back at once, nothing to show',
      t.threw && /did not take the payment \(500\)/.test(t.threw.message) && t.threw.foxyAtRisk && t.threw.foxyAtRisk.safe === true && t.after === t.before,
      t.threw && (t.threw.message + ' ' + JSON.stringify({ atRisk: t.threw.foxyAtRisk, before: t.before, after: t.after })));
  }
  console.log('E. no answer in time');
  for (const err of ['httpsPost did not answer.', 'The payment may have reached them; Foxy is checking.']) {
    const t = await refusedAt({ posts: [], error: err });
    ok('E3 "' + err.slice(0, 24) + '…": said as maybe arrived, never the action’s name, and the token kept for its claim watch',
      t.threw && t.threw.foxyMaybeSent && !/httpsPost/.test(t.threw.message) && /may have reached them/.test(t.threw.message)
        && !t.threw.foxyRefused && t.threw.foxyToken && t.threw.foxyToken.token,
      t.threw && t.threw.message);
  }

  console.log('G. an onion written with a dot at the end');
  {
    const ctx = page({ posts: [], code: 200 });
    await ctx.W.seedReady();
    const dotted = 'https://' + 'a'.repeat(55) + 'd.onion./pay';
    const r = ctx.W.decodeRequest(new ctx.window.CashuTS.PaymentRequest([{ type: 'post', target: dotted }], 'deadbeefcafe0003', 21, 'sat', [MINT], 'x', true).toEncodedRequest());
    ok('G3 an onion with a trailing dot is not taken for a web address (it would be posted through an exit, or looked up in DNS on the open connection)',
      !(r && r.delivery && r.delivery.kind === 'https'), 'read as ' + JSON.stringify(r && r.delivery));
  }

  console.log('F. what a website is sent');
  {
    const script = { posts: [], code: 200 };
    const ctx = page(script);
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    // the pool a tap, or a request this phone showed, fills (20-helpers.js `primeLocks`)
    let primed = 0;
    try { primed = await W.primeLocks(); } catch (e) { primed = -1; }
    await W.payRequest(W.decodeRequest(creq(ctx, 'feedface00000002')), () => {});
    let body = null;
    try { body = JSON.parse(script.posts[0].body); } catch (e) {}
    const extra = body ? Object.keys(body).filter((k) => !['id', 'memo', 'mint', 'unit', 'proofs'].includes(k)) : ['(unread)'];
    ok('F1 nothing but NUT-18’s fields goes to a website (lock pool primed: ' + primed + ')', extra.length === 0,
      'also sent: ' + extra.join(', ') + (body && body.changeTo ? ' = ' + String(body.changeTo).slice(0, 20) + '…' : ''));
  }
}

function sources() {
  console.log('E. the two clocks of an https post');
  const wsrc = fs.readFileSync(path.join(ROOT, 'build', 'wallet', '07-request-delivery.js'), 'utf8');
  const reach = Number((/var HTTPS_REACH_MS = (\d+)/.exec(wsrc) || [])[1]);
  const slack = Number((/var ONION_SLACK_MS = (\d+)/.exec(wsrc) || [])[1]);
  const sw = fs.readFileSync(path.join(ROOT, 'Foxy', 'Bridge', 'FoxyBridge+Delivery.swift'), 'utf8');
  const fn = sw.slice(sw.indexOf('func handleHttpsPost'), sw.indexOf('\n    }\n', sw.indexOf('func handleHttpsPost')));
  const tor = fs.readFileSync(path.join(ROOT, 'Foxy', 'Tor', 'TorService.swift'), 'utf8');
  const torReq = Number((/timeoutIntervalForRequest = (\d+)/.exec(tor.slice(tor.indexOf('static func socksSession'))) || [])[1]);
  ok('E1 the native post honours the page’s timeout', /body\["timeout"\]/.test(fn) && /timeoutInterval = /.test(fn), 'handleHttpsPost never reads it');
  ok('E2 the page waits at least as long as the post can run (' + (reach + slack) + ' ms against Tor’s ' + torReq + ' s)',
    reach + slack >= torReq * 1000, 'gives up ' + (torReq * 1000 - reach - slack) + ' ms before the post can still land');

  console.log('K. the native post is never redirected');
  const route = fs.readFileSync(path.join(ROOT, 'Foxy', 'Network', 'Route.swift'), 'utf8');
  const guard = route.slice(route.indexOf('willPerformHTTPRedirection'), route.indexOf('// MARK: Answers, collected up to a limit'));
  ok('K1 handleHttpsPost starts its post with redirects: false', /Route\.start\(request, circuit: MintCircuit\.label\(nil\), redirects: false\)/.test(fn), 'it follows same-host redirects');
  ok('K2 and RedirectGuard refuses every redirect for such a task', /\.redirects \?\? true/.test(guard) && /if !follows \{[^}]*completionHandler\(nil\)/.test(guard),
    'RedirectGuard has no per-task refusal');
  ok('K3 a final address other than the one asked is answered as redirected, never as its status', /"redirected \\\(code\)\\n"/.test(fn), 'not checked');

  console.log('G. the host checks, and the words on the offer');
  ok('G1 the post’s address meets Route.urlProblem, as a mint’s does', /urlProblem|hostProblem/.test(fn), 'not called in handleHttpsPost');
  const spec = method('requestSpec() {');
  ok('G2 the offer does not say OVER TOR when the open connection would carry it', !/'THEIR WEBSITE, OVER TOR'/.test(spec) || /unprotected/.test(spec),
    'THEIR WEBSITE, OVER TOR is said whatever the route');
}

async function run() {
  await stubbed();
  sources();
  await wallet();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });
