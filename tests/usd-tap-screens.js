'use strict';
/* usd-tap-screens.js — two Foxys at one mint, both holding dollars, paying each other by tap.
 *
 *     node tests/usd-tap-screens.js
 *
 * The owner asked for two people at Forge with dollar balances to pay each other with no connection. Foxy's
 * rule for a tap is the sat rule: one of the two phones must be online (docs/TAP-SPEC.md §2). So this drives
 * what that means in dollars, as a person drives it, on two real pages side by side:
 *
 *   1. the receiver offline: SET AMOUNT in dollars, RECEIVE opens on CASHU with a request in dollars (no
 *      invoice, no minute counted down, no price), TAP on the air; the payer reads the offer, sees SENDING
 *      $ 5.00 / FROM DOLLARS with the four digits, presses SEND; the receiver keeps it offline, says ADDED TO
 *      DOLLARS, and its dollar pill counts the dollars kept; the payer says $ 5.00 sent;
 *   2. the receiver back online: the sweep swaps the kept dollars in, and the balance is still dollars;
 *      YOUR MONEY IS SAFE says dollars as dollars;
 *   3. the payer offline with no dollars, or too few: NEEDS THE MINT before anything moves, and the receiver
 *      is told in words;
 *   4. the payer offline with dollars, the receiver online: paid from the dollar pile;
 *   5. online, short in dollars, sats on hand: their dollar invoice is paid from bitcoin through CONFIRM
 *      PAYMENT; with the receiver offline there is no invoice, and it is refused;
 *   6. the cards in dollars: HIGH RISK, the over-pay card, a refund, RECEIVER NEEDS TO SCAN.
 *
 * The real page, rendered in jsdom by build/foxy-render.js as tests/two-balances-screens.js renders it, twice,
 * each against a stand-in wallet that answers the contract the wallet half of this build keeps
 * (`paymentRequest(cents, { unit: 'usd' })`, `decodeRequest` with `unit` and `amount`, `sendShortfall` and
 * `payRequest` in the unit, `balanceOf('usd')` with the dollars kept offline, `onRequestPaid` with `unit` and
 * `amount`). The two stand-ins share one stand-in mint and one stand-in tap link, which carries the offer
 * and the payment between the two pages as the simulators' stand-in link does. The wallet's own half is
 * tested on the real wallet elsewhere (tests/two-balances.js and the tap suites). */
process.env.TZ = 'UTC';
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failed = 0;
let passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || !detail ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name,
  'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));

// ---- the page, as render-snapshots.js builds it -------------------------------------------------
const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8');
const unpack = (uuid) => fs.readFileSync(path.join(ROOT, assets.find((a) => a.uuid === uuid).file), 'utf8');
const REACT = unpack('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047');
const REACT_DOM = unpack('93c76fbd-259d-463c-a60d-5ed97ad7e690');
const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
  const props = JSON.parse(v.replace(/&quot;/g, '"'));
  props.startStatic = { default: true };
  return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
});
const page = markup
  .replace(/<script src="64b433ba-[^"]*"><\/script>/, '')
  .replace(shell.marker, () => open + app + '</script>');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mount(label) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a) => errors.push(a.map(String).join(' ').slice(0, 300)));
  vc.on('jsdomError', (e) => errors.push('jsdom: ' + String(e && e.message).slice(0, 300)));
  // the pages' diaries, for a run that needs reading: FOXY_TEST_LOG=1
  if (process.env.FOXY_TEST_LOG) vc.on('log', (...a) => console.log('   ' + (label || '') + ' ' + a.map(String).join(' ').slice(0, 240)));
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://foxy.test/index.html', virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.scrollTo = () => {};
  const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
  run('(function(){var n=Number.prototype.toLocaleString;Number.prototype.toLocaleString=function(l,o){return n.call(this,l===undefined?"en-US":l,o);};})();');
  run(REACT);
  run(REACT_DOM);
  const dc = w.document.querySelector('script[type="text/x-dc"]');
  run('window.__foxyComponentFactory = function (DCLogic, StreamableLogic, React) {\n' + dc.textContent
    + '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};');
  run('(function(){var f=window.__foxyComponentFactory;window.__foxyComponentFactory=function(a,b,R){'
    + 'var C=f(a,b,R);return class extends C{constructor(p){super(p);window.__logic=this;}};};})();');
  run(RENDERER);
  return { dom, w, errors };
}

// ---- one stand-in mint, one stand-in tap link, two stand-in wallets --------------------------------
const MINT = 'https://forge.example.com';
const PRICE = 80000;
const requests = new Map();          // creq text -> what decodeRequest answers (both phones read the same codes)
const link = { offer: '', said: [], heard: new Set() };
const money = (c) => '$ ' + (c / 100).toFixed(2);
// one count for every code either phone makes, so no two cases share a request or an invoice
let made = 0;

/* A phone's wallet. `o.online`: whether it reaches the mint. `o.usd`, `o.sat`: its piles. Dollars it was paid
 * offline are `kept`, counted in `balanceOf('usd')` and never in sats, and swapped in by `claimUnclaimed`. */
function phone(role, o) {
  const opt = Object.assign({ sat: 0, usd: 0, online: true }, o || {});
  const st = { sat: opt.sat, usd: opt.usd, online: opt.online, kept: [], open: {}, txs: [],
    choice: Object.assign({ hold: 'both', recv: 'usd', send: 'usd' }, opt.choice || {}) };
  const rec = { creqs: [], invoices: [], pays: [], tokens: [], claims: 0, shortfalls: [], priceAsks: 0, cards: [] };
  const paidFns = [];
  const next = () => { made += 1; return made; };
  const keptUsd = () => st.kept.reduce((a, r) => a + r.amount, 0);
  const tx = (t) => st.txs.unshift(Object.assign({ at: Date.now(), mint: MINT, settled: true, fee: 0, feeAmount: 0 }, t));
  const W = {
    role,
    connected: true,
    mintUrl: MINT,
    mintHost: () => 'forge.example.com',
    mints: () => [MINT],
    qr: (text) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)),
    classify: (t) => (/^lnbc/.test(t) ? 'invoice' : /^creq/.test(t) ? 'request' : /^cashu/.test(t) ? 'token' : 'unknown'),
    amountOf: (inv) => (/^lnbc/.test(String(inv)) ? 6250 : null),
    tagsFor: () => ({}),
    tag() {},
    settleTx() {},
    backedUp: () => true,
    pinIsSet: () => false,
    reason: (e) => String((e && e.message) || e),
    formatAmount: (a, u) => (u === 'usd' ? money(a) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: st.sat, mint: MINT }, { unit: 'usd', amount: st.usd + keptUsd(), mint: MINT }],
    balanceAt: () => st.sat,
    balanceSats: () => Promise.resolve(st.sat),
    rate: () => Promise.resolve(PRICE),
    agreedRate: () => Promise.resolve(PRICE),
    lastPrice: () => ({ rate: st.online ? PRICE : 0, at: Date.now(), ageMs: 0 }),
    transactions: () => Promise.resolve(st.txs.slice()),
    book: () => [],
    remember() {},
    listen: () => () => {},
    privacy: () => ({ tor: st.online ? 'up' : 'connecting', progress: 100, everUp: true, unprotected: false,
      offline: !st.online, network: st.online ? 'wifi' : 'none', orbot: 'none', vpn: false }),
    mintUnits: () => ['sat', 'usd'],
    twoUnits: () => true,
    walletChoice: () => Object.assign({}, st.choice),
    setWalletChoice(p) { if (p.recv) st.choice.recv = p.recv; if (p.send) st.choice.send = p.send; },
    // the dollar pill: the pile and the dollars kept offline, in cents; never a sat in it
    balanceOf: (u) => (u === 'usd' ? st.usd + keptUsd() : st.sat),
    keptIn: (u) => (u === 'usd' ? keptUsd() : 0),
    heldIn: () => 0,
    recoveringIn: () => 0,
    lastToken: () => ({}),
    clearLastToken() {},
    pendingMelts: () => [],
    splitPending: () => null,
    primeLocks: () => Promise.resolve(1),
    openInbox: () => (st.online ? Promise.resolve({ onion: role + '.onion' }) : Promise.reject(new Error('no route'))),
    closeInbox() {},
    invoice(amount, memo, io) {
      if (!st.online) return Promise.reject(new Error('This phone is offline.'));
      const unit = (io && io.unit) || 'sat';
      const n = next();
      const inv = { bolt11: 'lnbc' + unit + role + n, hash: 'inv-' + role + n, unit, amount, sats: unit === 'sat' ? amount : 0,
        mint: MINT, expiresIn: 60, expiresAt: Date.now() + 60000 };
      rec.invoices.push(inv);
      return Promise.resolve(inv);
    },
    watch: () => () => {},
    // a request names its unit; in dollars the amount is cents and `sats` is null
    paymentRequest(amount, ro) {
      const unit = (ro && ro.unit) || 'sat';
      const id = role + '-req-' + next();
      const text = 'creqA' + unit + '-' + id;
      requests.set(text, { id, unit, amount, sats: unit === 'sat' ? amount : null, mints: [MINT], lockTo: '02' + 'ab'.repeat(32),
        transports: [], delivery: null, purpose: (ro && ro.purpose) || 'receive' });
      st.open[id] = { unit, amount };
      rec.creqs.push({ amount, opts: ro || null, text });
      return text;
    },
    decodeRequest: (t) => (requests.has(t) ? Object.assign({}, requests.get(t), { mints: requests.get(t).mints.slice() }) : null),
    asksInDollars: (r) => !!(r && Number(r.usd) > 0 && !(Number(r.sats) > 0)),
    sendShortfall(amount, so) {
      const unit = (so && so.unit) || 'sat';
      rec.shortfalls.push(unit);
      const have = unit === 'usd' ? st.usd + (st.online ? 0 : keptUsd()) : st.sat;
      const say = (x) => (unit === 'usd' ? money(x) : x + ' sats');
      return { short: have < amount, need: amount, have, fee: 0,
        why: have < amount ? 'Your balance isn\'t enough to cover the payment and its fee: this needs ' + say(amount) + ' and you hold ' + say(have) + '.' : '' };
    },
    // the payment over the link: refused offline in a unit not held, as `unitHeldRefusal` does, before anything moves
    payRequest(req) {
      const unit = req.unit === 'usd' ? 'usd' : 'sat';
      const amount = unit === 'usd' ? req.amount : req.sats;
      const have = unit === 'usd' ? st.usd : st.sat;
      if (!st.online && have < amount) {
        const word = unit === 'usd' ? 'dollars' : 'bitcoin';
        const e = new Error(have > 0 ? W.sendShortfall(amount, { unit }).why
          : 'This request is in ' + word + '. You hold no ' + word + ' here, and paying it from ' + (unit === 'usd' ? 'bitcoin' : 'dollars') + ' needs the mint.');
        e.foxyNeedsMint = true;
        return Promise.reject(e);
      }
      if (!st.online && req.theirRoute === false) return Promise.reject(new Error('You are both offline, so nothing here could settle this payment. One of you needs a connection.'));
      if (unit === 'usd') st.usd -= amount; else st.sat -= amount;
      const hash = 'pay-' + role + next();
      rec.pays.push({ unit, amount, locked: st.online });
      const answered = link.deliver({ id: req.id, unit, amount, locked: st.online });
      return answered.then((code) => {
        if (code !== 200) {
          if (unit === 'usd') st.usd += amount; else st.sat += amount;
          const e = new Error('They refused it.'); e.foxyAskedNo = true; throw e;
        }
        // its entry, once the other phone has it (an entry on its way is not announced)
        tx({ hash, dir: 'out', unit: unit === 'usd' ? 'usd' : '', amount, sats: unit === 'sat' ? amount : 0, name: 'ecash' });
        return { hash, unit, amount, sats: unit === 'sat' ? amount : 0, confirmed: true, lockedTo: st.online ? req.lockTo : '', over: 0 };
      });
    },
    // the receiver's side of a payment for one of its requests (`_requestPaid`)
    _requestPaid(p) {
      const open = st.open[p.id];
      if (process.env.FOXY_TEST_LOG) console.log('   (stand-in) ' + role + ' paid for ' + p.id + ' in ' + p.unit + ': ' + (open ? 'open' : 'not open here'));
      if (!open || open.unit !== p.unit) return 422;
      // offline only locked ecash is taken, and kept until the mint is back; online it is swapped in
      if (!st.online && !p.locked) return 422;
      const tell = (stage) => paidFns.forEach((fn) => fn({ stage, unit: p.unit, amount: p.amount, sats: p.unit === 'sat' ? p.amount : 0,
        id: p.id, purpose: 'receive', asked: open.amount }));
      tell('arrived');
      if (!st.online) st.kept.push({ id: p.id, unit: p.unit, amount: p.amount });
      else if (p.unit === 'usd') st.usd += p.amount; else st.sat += p.amount;
      delete st.open[p.id];
      tx({ hash: 'req-' + p.id, dir: 'in', unit: p.unit === 'usd' ? 'usd' : '', amount: p.amount, sats: p.unit === 'sat' ? p.amount : 0, name: 'ecash' });
      tell('paid');
      return 200;
    },
    onRequestPaid: (fn) => { paidFns.push(fn); },
    // the sweep: what was kept offline is swapped in, in its own unit
    claimUnclaimed() {
      rec.claims += 1;
      if (!st.online) return Promise.resolve(0);
      const took = st.kept.splice(0);
      took.forEach((r) => { if (r.unit === 'usd') st.usd += r.amount; else st.sat += r.amount; });
      took.forEach((r) => W._lateClaim && W._lateClaim({ unit: r.unit, amount: r.amount, sats: r.unit === 'sat' ? r.amount : 0, trusted: false, id: r.id }));
      return Promise.resolve(took.length);
    },
    // the stand-in tap link
    tapReceive(offer) {
      if (process.env.FOXY_TEST_LOG) console.log('   (stand-in) ' + role + ' on the air: ' + String(offer).slice(0, 90));
      if (role === 'receiver') link.offer = offer;
      return Promise.resolve('ok');
    },
    tapReceiveStop: () => Promise.resolve('ok'),
    tapPay() {
      if (role !== 'payer') return new Promise(() => {});
      return new Promise((yes) => {
        const look = () => {
          // a wallet the page has let go of hears nothing more
          if (W.retired) return;
          // one touch, one hearing: a phone that stays on the air is not a second tap
          // (the offer is re-sent as its price's timestamp moves; the request in it is what was touched)
          let key = link.offer;
          try { const o = JSON.parse(link.offer); key = o.req || o.inv || key; } catch (e) {}
          if (link.offer && !link.heard.has(key)) {
            if (process.env.FOXY_TEST_LOG) console.log('   (stand-in) payer heard: ' + link.offer.slice(0, 90));
            link.heard.add(key);
            yes({ payload: link.offer, code: '4821' });
          } else setTimeout(look, 20);
        };
        look();
      });
    },
    tapPayStop: () => Promise.resolve('ok'),
    tapQuote(text) { link.said.push(JSON.parse(text)); if (link.toReceiver) link.toReceiver(text); return Promise.resolve('ok'); },
    tapTerms: () => Promise.resolve('ok'),
    onTapTerms() {},
    tapChangeKept: () => Promise.resolve('ok'),
    // the camera the send screens open and close
    startPreview: () => Promise.resolve('ok'),
    stopPreview: () => Promise.resolve('ok'),
    startPasteButton() {},
    stopPasteButton() {},
    notify() {},
    // a spy: a dollar request must never be priced in sats
    quoteFor: () => { rec.priceAsks += 1; return null; },
  };
  W.rec = rec;
  W.st = st;
  return W;
}

// ---- driving it ---------------------------------------------------------------------------------
const tick = () => wait(15);
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
const textOf = (w) => (w.document.getElementById('dc-root') || w.document.body).textContent.replace(/\s+/g, ' ');

async function phonePage(name) {
  const { w, errors } = mount(name);
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  const A = w.__logic;
  if (!A) { console.log('FAIL  the ' + name + '’s page did not mount\n      ' + errors.join(' | ')); process.exit(1); }
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}
  const initial = Object.assign({}, A.state);
  const P = { name, w, A, errors, toasts: [], cards: [], V: () => A.renderVals() };
  A.toast = (m) => { P.toasts.push(String(m)); };
  // every card the page raises, with its words, as well as drawn
  const draw = A.blockedCard.bind(A);
  A.blockedCard = (kind, over) => { P.cards.push(Object.assign({ kind }, over || {})); return draw(kind, over); };
  P.fresh = async (W, state) => {
    if (w.FoxyWallet && w.FoxyWallet !== W) w.FoxyWallet.retired = true;
    w.FoxyWallet = W;
    const patch = {};
    for (const k of Object.keys(A.state)) if (!(k in initial)) patch[k] = undefined;
    A._lastPay = null; A._paying = null; A.stopReceive(); A._creqs = {};
    // a confirmation an earlier case left waiting is not this case's
    A._paidQueue = [];
    A._tapGot = false; A._tapKeep = false; A._tapPaying = null; A._tapQuietUntil = 0; A._shortTold = '';
    document_clear(w);
    P.toasts.length = 0; P.cards.length = 0;
    A.setState(Object.assign(patch, initial, { walletLive: true, balSats: W.st.sat, balUsdCents: null, livePrice: PRICE,
      satUsd: PRICE / 1e8, screen: 'home', stack: [] }, state || {}));
    A.refreshUsd();
    // the app's own listeners, as the boot puts them on the wallet
    W.onRequestPaid((ev) => A.requestPaidHere(ev));
    W._lateClaim = (info) => A.moneyIsSafe(info);
    await settle();
    A.loadHistory();
    await settle();
  };
  return P;
}
function document_clear(w) {
  const card = w.document.querySelectorAll('[data-foxy-card], #foxy-stage, #foxy-melt');
  card.forEach((n) => n.remove());
}

/* The receiver: RECEIVE, five dollars typed, NEXT. */
async function receiveFive(R) {
  R.V().goReceive(); await settle();
  ['5', '0', '0'].forEach((k) => R.A.press(k));
  R.V().next(); await settle(); await settle();
}

/* The payer hears the offer and opens it (`tapStartPay` waits 900 ms before the confirmation). */
async function payerHears(P) {
  const cards = P.cards.length;
  if (!P.A._tapPaying) P.A.tapStartPay();
  // until the offer has been acted on: a screen of its own, or a card
  for (let i = 0; i < 200 && P.A.state.screen === 'home' && P.cards.length === cards; i++) await wait(25);
  await settle(); await wait(60); await settle();
}

/* Nothing on the air: what an earlier case's screen left there is not this case's offer. */
function quiet() { link.offer = ''; link.said.length = 0; }

/* Both phones, a fresh link, and the payment delivered from the payer's wallet to the receiver's. */
function wire(Rw, Pw, R) {
  quiet();
  link.deliver = (p) => Promise.resolve(Rw._requestPaid(p));
  link.toReceiver = (text) => R.A.tapPriceOffered(text);
}

(async () => {
  const R = await phonePage('receiver');
  const P = await phonePage('payer');

  // ---- 1. the receiver offline: a request in dollars, paid by tap -----------------------------
  console.log('1. the receiver offline, the payer online: five dollars by tap');
  {
    const Rw = phone('receiver', { online: false, usd: 0, sat: 0 });
    const Pw = phone('payer', { online: true, usd: 4205, sat: 50000 });
    wire(Rw, Pw, R);
    await R.fresh(Rw); await P.fresh(Pw);
    quiet();
    await receiveFive(R);
    const v = R.V();
    eq([R.A.state.screen, R.A.state.recvRail, R.A.state.recvUnit, Rw.rec.invoices.length], ['confirm', 'CASHU', 'usd', 0],
      'offline, RECEIVE in dollars opens on CASHU, and asks the mint for nothing');
    eq([v.confirmAmount, v.confirmNetwork, v.recvWalletWord, v.recvClockShown, v.recvTapShown, v.recvCardShown],
      ['$ 5.00', 'CASHU', 'USD', false, true, false], 'the screen: $ 5.00, NETWORK CASHU, WALLET USD, no clock, TAP, no CARD');
    const made = Rw.rec.creqs.filter((c) => c.opts && c.opts.unit === 'usd');
    ok(made.length >= 1 && made.every((c) => c.amount === 500), 'its request is in dollars, for 500 cents', JSON.stringify(Rw.rec.creqs));
    ok(!Rw.rec.creqs.some((c) => c.opts && Number(c.opts.usd) > 0), 'and never the old sat request priced in dollars');
    const code = R.A.cashuRequest();
    eq([!!code, (Rw.decodeRequest(code) || {}).unit], [true, 'usd'], 'the code on screen is that request');
    ok(!/₿/.test(String(v.confirmAmount) + String(v.confirmAlt || '')), 'no bitcoin figure on a dollar request');
    // on the air
    R.A.setState({ tapArmed: true }); await settle();
    let offer = null;
    try { offer = JSON.parse(link.offer); } catch (e) { offer = null; }
    ok(!!offer && offer.v === 2 && offer.up === false && !offer.inv && Rw.decodeRequest(offer.req).unit === 'usd',
      'the offer on the air: the dollar request, no invoice, and "no route here"', link.offer);
    ok(offer && offer.rate === undefined, 'and no bitcoin price in it');
    // the payer
    const asked0 = Pw.rec.priceAsks;
    await payerHears(P);
    eq([P.A.state.screen, P.A.state.wallet, (P.A.state.req || {}).unit], ['reqOffer', 'usd', 'usd'],
      'the payer: the request opens on its offer screen, paid from dollars');
    const spec = P.A.requestSpec();
    eq([spec.amount, spec.amountSub, spec.code, spec.cta], ['$ 5.00', '', '4821', 'SEND $ 5.00'], 'SENDING $ 5.00, the four digits, SEND $ 5.00');
    ok(spec.rows.some((r) => r.label === 'FROM' && r.value === 'DOLLARS') && !spec.rows.some((r) => r.label === 'BITCOIN PRICE'),
      'FROM DOLLARS, and no bitcoin price row', JSON.stringify(spec.rows.map((r) => r.label + '=' + r.value)));
    ok(Pw.rec.shortfalls.indexOf('usd') >= 0 && Pw.rec.shortfalls.indexOf('sat') < 0, 'the shortfall is asked in dollars, never in sats');
    ok(/\$ 5\.00/.test(textOf(P.w)) && /DOLLARS/.test(textOf(P.w)), 'the page draws $ 5.00 and DOLLARS');
    eq(Pw.rec.priceAsks - asked0, 0, 'no bitcoin price was asked for, on the payer (no quote of dollars into sats)');
    ok(!P.A.state.peerRate && P.A.state.screen !== 'priceConfirm', 'and no "their price" to agree');
    // SEND
    spec.go();
    await settle(); await wait(50); await settle();
    eq(Pw.rec.pays, [{ unit: 'usd', amount: 500, locked: true }], 'the payer pays 500 cents, locked to the receiver');
    eq([Pw.balanceOf('usd'), Pw.balanceOf('sat')], [3705, 50000], 'its dollars went down by $ 5.00, its sats untouched');
    const pv = P.V();
    eq([P.A.state.screen, P.A.state.paidUnit, pv.paidHeadline], ['paid', 'usd', '$ 5.00'], 'the payer: $ 5.00 sent, in dollars');
    // the receiver kept it, offline
    eq([Rw.st.kept.length, Rw.keptIn('usd'), Rw.balanceOf('usd'), Rw.balanceOf('sat')], [1, 500, 500, 0],
      'the receiver kept $ 5.00 offline, counted in dollars and never in sats');
    for (let i = 0; i < 20 && R.A.state.screen !== 'paid'; i++) { R.A.loadHistory(); await settle(); }
    const rv = R.V();
    eq([R.A.state.screen, R.A.state.paidUnit, rv.paidHeadline, rv.paidAddedLabel, rv.paidAddedTo], ['paid', 'usd', '$ 5.00', 'ADDED TO', 'DOLLARS'],
      'the receiver: PAYMENT RECEIVED, $ 5.00, ADDED TO DOLLARS');
    eq(Rw.st.choice.recv, 'usd', 'the next receive starts in dollars, the unit it was paid in');
    R.A.refreshUsd(); await settle();
    eq(R.A.state.balUsdCents, 500, 'the dollar pill counts the dollars kept offline');
    R.A.setState({ screen: 'home', stack: [] }); await settle();
    const pills = R.V().homePillRows || [];
    ok(pills.length === 2 && pills[0].sym === '$' && pills[0].big === '5.00' && pills[1].big === '0', 'home: $ 5.00 on the dollar pill, nothing on bitcoin',
      JSON.stringify(pills.map((p) => [p.sym, p.big])));
    // the history's DOLLARS tab
    R.A.setState({ screen: 'history', stack: ['home'], histUnit: 'usd' }); await settle(); R.A.loadHistory(); await settle();
    const rows = ((R.V().historyGroups || [])[0] || { items: [] }).items;
    eq(rows.map((r) => r.amtText), ['+ $ 5.00'], 'history, DOLLARS: + $ 5.00');
    eq([R.A.histAuditUsd().whole, R.A.histAuditUsd().off], [true, 0], 'and the dollar books add up with the dollars kept offline');
    // the ledger per unit: the dollars kept are not on the BITCOIN tab, and the bitcoin books are untouched
    R.A.setState({ histUnit: 'sat' }); await settle(); R.A.loadHistory(); await settle();
    const satRows = ((R.V().historyGroups || [])[0] || { items: [] }).items;
    ok(!satRows.some((r) => /\$ 5\.00|500/.test(String(r.amtText))), 'history, BITCOIN: no row for the dollars kept', JSON.stringify(satRows.map((r) => r.amtText)));
    eq(R.A.histAudit().off, 0, 'and the bitcoin books add up, with no cents in them');
    R.A.setState({ histUnit: 'usd' }); await settle();

    // ---- 2. the sweep, once the receiver has a connection ----------------------------------
    console.log('2. the receiver back online: the sweep');
    Rw.st.online = true;
    R.A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' }); await settle();
    R.A.syncClaim(); await settle();
    ok(Rw.rec.claims >= 1, 'a screen money can leave from asks the wallet to claim what it kept');
    eq([Rw.st.kept.length, Rw.st.usd, Rw.balanceOf('usd'), Rw.balanceOf('sat')], [0, 500, 500, 0],
      'the kept dollars are swapped into the dollar pile: still $ 5.00, still no sats');
    R.A.refreshUsd(); await settle();
    eq(R.A.state.balUsdCents, 500, 'the dollar pill is unchanged by the sweep');
    ok(!R.w.document.getElementById('foxy-stage') || R.w.document.getElementById('foxy-stage').getAttribute('data-stage') !== 'moneySafe',
      'locked dollars swapped in are not announced as "safe": they never were at risk');
    // money taken on trust, in dollars
    R.A.setState({ screen: 'home', stack: [] }); await settle();
    R.A.moneyIsSafe({ unit: 'usd', amount: 250, sats: 0, trusted: true });
    await settle();
    const safe = R.w.document.getElementById('foxy-stage');
    const safeText = safe ? safe.textContent.replace(/\s+/g, ' ') : '';
    ok(/\$ 2\.50/.test(safeText) && !/₿/.test(safeText), 'YOUR MONEY IS SAFE says $ 2.50, and no sats', safeText.slice(0, 160));
    if (R.A.hideStage) R.A.hideStage('moneySafe');
    R.A._safeTotal = 0; R.A._safeUsd = 0; R.A._safeCount = 0;
  }

  // ---- 3. the payer offline, with no dollars or too few ---------------------------------------
  console.log('3. the payer offline, holding no dollars here or too few: NEEDS THE MINT');
  for (const held of [0, 300]) {
    const Rw = phone('receiver', { online: true });
    const Pw = phone('payer', { online: false, usd: held, sat: 50000 });
    wire(Rw, Pw, R);
    await R.fresh(Rw); await P.fresh(Pw);
    quiet();
    await receiveFive(R);
    eq([R.A.state.recvRail, Rw.rec.invoices.length, (Rw.rec.invoices[0] || {}).unit], ['LIGHTNING', 1, 'usd'],
      'the receiver online: a dollar invoice (held ' + held + ')');
    R.A.setState({ tapArmed: true }); await settle();
    let offer = null;
    try { offer = JSON.parse(link.offer); } catch (e) { offer = null; }
    ok(!!offer && /^lnbcusd/.test(offer.inv || '') && Rw.decodeRequest(offer.req || '') && Rw.decodeRequest(offer.req).unit === 'usd'
      && Rw.decodeRequest(offer.req).amount === 500 && offer.up === true,
      'online, the offer is the dollar invoice and a request in dollars beside it', link.offer);
    await payerHears(P);
    const card = P.cards.find((c) => c.kind === 'needsMint');
    const words = held ? 'Your balance isn\'t enough to cover the payment and its fee: this needs $ 5.00 and you hold $ 3.00.'
      : 'This request is in dollars. You hold no dollars here, and paying it from bitcoin needs the mint.';
    eq(card ? [card.title, card.reason, card.chip] : null, ['NEEDS THE MINT', words, 'Nothing was sent.'],
      'the payer: NEEDS THE MINT, in words (' + (held ? 'too few' : 'none') + ')');
    eq([Pw.rec.pays.length, P.A.state.screen], [0, 'home'], 'nothing paid, and no offer screen');
    const told = link.said.find((x) => typeof x.gaveUp === 'string');
    eq(told && told.gaveUp, held ? 'The payer does not have enough to cover this payment.'
      : 'The payer holds no dollars here, and paying from bitcoin needs the mint.', 'the receiver is told why, with no figures of the payer’s');
    await settle();
    const rcard = R.cards.find((c) => c.kind === 'payerGaveUp');
    ok(!!rcard && rcard.reason === (told && told.gaveUp), 'and the receiver shows it: THE PAYER COULD NOT PAY');
    // put away, as the person would, so the next case's confirmation is not held behind it
    R.A.dismissCard('payerGaveUp'); P.A.dismissCard('needsMint');
    R.A.stopReceive();
  }

  // ---- 4. the payer offline, with dollars; the receiver online --------------------------------
  console.log('4. the payer offline with dollars, the receiver online');
  {
    const Rw = phone('receiver', { online: true });
    const Pw = phone('payer', { online: false, usd: 1000, sat: 0 });
    wire(Rw, Pw, R);
    await R.fresh(Rw); await P.fresh(Pw);
    quiet();
    await receiveFive(R);
    R.A.setState({ tapArmed: true }); await settle();
    await payerHears(P);
    eq([P.A.state.screen, P.A.state.wallet], ['reqOffer', 'usd'], 'the payer, offline, opens the offer in dollars');
    const asked0 = Pw.rec.priceAsks;
    P.A.requestSpec().go();
    await settle(); await wait(50); await settle();
    eq([Pw.rec.pays, Pw.st.usd, Rw.st.usd, Rw.st.kept.length], [[{ unit: 'usd', amount: 500, locked: false }], 500, 500, 0],
      'paid from the dollar pile, unlocked; the receiver, online, swapped it straight in');
    eq(Pw.rec.priceAsks - asked0, 0, 'and no price asked');
    eq([P.A.state.screen, P.V().paidHeadline], ['paid', '$ 5.00'], 'the payer: $ 5.00 sent');
    for (let i = 0; i < 20 && R.A.state.screen !== 'paid'; i++) { R.A.loadHistory(); await settle(); }
    const rv4 = R.V();
    eq([R.A.state.screen, rv4.paidHeadline, rv4.paidHeadlineSub, rv4.paidAddedTo], ['paid', '$ 5.00', '', 'DOLLARS'],
      'the receiver, online: PAYMENT RECEIVED, $ 5.00, ADDED TO DOLLARS, nothing in sats under it');
    R.A.stopReceive();
  }

  // ---- 5. online, short in dollars: their invoice from bitcoin; the receiver offline: refused ---
  console.log('5. online, no dollars: the dollar invoice paid from bitcoin, or refused when there is no invoice');
  {
    const Rw = phone('receiver', { online: true });
    const Pw = phone('payer', { online: true, usd: 0, sat: 50000 });
    wire(Rw, Pw, R);
    await R.fresh(Rw); await P.fresh(Pw);
    quiet();
    await receiveFive(R);
    R.A.setState({ tapArmed: true }); await settle();
    const inv = JSON.parse(link.offer).inv;
    await payerHears(P);
    eq([P.A.state.screen, P.A.state.wallet, P.A.state.recipient, Pw.rec.pays.length], ['sendConfirm', 'sat', inv, 0],
      'the payer holds no dollars: CONFIRM PAYMENT for their dollar invoice, from BITCOIN, nothing paid yet');
    R.A.stopReceive();
  }
  {
    const Rw = phone('receiver', { online: false });
    const Pw = phone('payer', { online: true, usd: 0, sat: 50000 });
    wire(Rw, Pw, R);
    await R.fresh(Rw); await P.fresh(Pw);
    quiet();
    await receiveFive(R);
    R.A.setState({ tapArmed: true }); await settle();
    await payerHears(P);
    const card = P.cards.find((c) => c.kind === 'needsMint');
    eq(card && card.reason, 'This request is in dollars. You hold no dollars here, and paying it from bitcoin needs both of you online.',
      'the receiver offline, the payer with no dollars: refused, needing both online');
    eq((link.said.find((x) => typeof x.gaveUp === 'string') || {}).gaveUp,
      'They hold no dollars here, and paying from bitcoin needs both of you online.', 'and the receiver is told so');
    eq(Pw.rec.pays.length, 0, 'nothing paid');
    R.A.stopReceive();
  }

  // ---- 6. the cards, in dollars ---------------------------------------------------------------
  console.log('6. the cards, in dollars');
  {
    const Rw = phone('receiver', { online: false });
    await R.fresh(Rw);
    R.A.offlineRiskCard({ unit: 'usd', amount: 200, sats: 0, scanned: true });
    const risk = R.cards.find((c) => c.kind === 'offlineRisk');
    eq(risk && risk.chip, 'Amount $ 2.00', 'HIGH RISK: "Amount $ 2.00", no sats and no price under it');
    R.A.dismissCard && R.A.dismissCard('offlineRisk');
    P.A.overpayCard({ unit: 'usd', asked: 200, pay: 256, over: 56, changeComesBack: true });
    const over = P.cards.find((c) => c.kind === 'overpay');
    ok(!!over && /\$ 2\.56 for a \$ 2\.00 payment/.test(over.reason) && /\$ 0\.56 comes straight back/.test(over.reason)
      && over.retry === 'YES, SEND $ 2.56' && !/sat/.test(over.reason + over.chip), 'YOU DON’T HAVE EXACT CHANGE, in dollars', over && over.reason);
    P.A.dismissCard && P.A.dismissCard('overpay');
    P.A.trustLostCard({ unit: 'usd', amount: 300, sats: 0 });
    const lost = P.cards.find((c) => c.kind === 'trustLost');
    ok(!!lost && /^The \$ 3\.00 you accepted/.test(lost.reason), 'THEY TOOK THAT PAYMENT BACK, in dollars', lost && lost.reason);
    P.A.dismissCard && P.A.dismissCard('trustLost');
    eq([P.A.stageMoney(505, 'usd'), P.A.stageMoney(0, 'usd')], ['$ 5.05', '$ 0.00'], 'a stage screen says cents as dollars, with no price in it');
    P.A.needScanStage({ token: 'cashuBusd', unit: 'usd', amount: 500, sats: 0 });
    await settle();
    const scan = P.w.document.getElementById('foxy-stage');
    ok(!!scan && /\$ 5\.00/.test(scan.textContent), 'RECEIVER NEEDS TO SCAN: $ 5.00');
    if (P.A.hideStage) P.A.hideStage('needScan');
  }

  // ---- 7. a second look: change, the at-risk words, the dollar books, and the offer's price ----
  console.log('7. change in dollars over the link, the at-risk words, the dollar books, no price on the air');
  {
    /* Change on a payment in dollars arrives over the link as dollar ecash. The app's handler checks it with
     * the wallet (`checkChange(token, owed, unit)`), whose contract is that the unit is the payment's: asked
     * with none it means sats, and dollar change is refused as "it is not sats". */
    const mk = (online) => {
      const Pw = phone('payer', { online, usd: 1000, sat: 5000 });
      const seen = { checks: [], kept: [], acks: [], settled: [] };
      let changeFn = null;
      Pw.onTap = () => {};
      Pw.onTapChange = (fn) => { changeFn = fn; };
      Pw.tokenInfo = (t) => (/usd/.test(t) ? { unit: 'usd', amount: 56, sats: null, mint: MINT } : { unit: 'sat', amount: 21, sats: 21, mint: MINT });
      Pw.checkChange = (token, owed, unit) => {
        const u = unit || 'sat';
        const tu = /usd/.test(token) ? 'usd' : 'sat';
        seen.checks.push([u, owed]);
        if (tu !== u) return { ok: false, why: 'it is not ' + (u === 'usd' ? 'dollars' : 'sats') };
        return { ok: true, signed: true, amount: tu === 'usd' ? 56 : 21 };
      };
      Pw.changeNet = (t) => (/usd/.test(t) ? 56 : 21);
      Pw.keepChange = (token, n) => { seen.kept.push(n); };
      Pw.receiveToken = () => Promise.resolve({ unit: 'usd', amount: 56 });
      Pw.tapChangeKept = (yes) => { seen.acks.push(yes); return Promise.resolve('ok'); };
      Pw.changeSettled = (hash, n) => { seen.settled.push([hash, n]); };
      return { Pw, seen, fire: (t) => changeFn && changeFn(t) };
    };
    for (const online of [false, true]) {
      const { Pw, seen, fire } = mk(online);
      await P.fresh(Pw);
      P.A._tapHooked = false; P.A.listenWallet();
      P.A.expectChange(56, 'pay-usd-1', 'usd');
      fire('cashuBusd-change');
      await settle();
      eq(seen.checks, [['usd', 56]], (online ? 'online' : 'offline') + ': dollar change is checked as dollars, for the 56 cents owed');
      eq(seen.acks, [true], (online ? 'online' : 'offline') + ': and kept, and the receiver told so');
      if (!online) eq(seen.kept, [56], 'offline: written down as 56 cents, to be swapped in later');
      eq(seen.settled, [['pay-usd-1', 56]], (online ? 'online' : 'offline') + ': the payment’s own entry is settled with the change');
    }
    {
      // and sat change is as it always was
      const { Pw, seen, fire } = mk(false);
      await P.fresh(Pw);
      P.A._tapHooked = false; P.A.listenWallet();
      P.A.expectChange(21, 'pay-sat-1');
      fire('cashuBsat-change');
      await settle();
      eq([seen.checks, seen.acks, seen.kept], [[['sat', 21]], [true], [21]], 'sat change: checked as sats and kept, as before');
    }

    /* The words when a refused payment settles, or is taken back by itself: in its unit. The sat sentences
     * are the ones the app always said. */
    {
      const Pw = phone('payer', { online: true, usd: 1000, sat: 5000 });
      await P.fresh(Pw);
      P.toasts.length = 0; P.cards.length = 0;
      P.A.atRiskSettled({ state: 'safe', unit: 'usd', amount: 200, sats: 0 });
      P.A.atRiskSettled({ state: 'refunded', unit: 'usd', amount: 200, sats: 0 });
      P.A.takenBackSaid({ unit: 'usd', amount: 200, sats: 0 });
      P.A.atRiskSettled({ state: 'safe', sats: 2000 });
      P.A.atRiskSettled({ state: 'refunded', sats: 2000 });
      P.A.takenBackSaid({ sats: 2000 });
      eq(P.toasts, ['The $ 2.00 they refused is safe again.', 'The $ 2.00 they refused came back, locked to this phone.',
        'The $ 2.00 they did not take is back in your wallet.',
        'The 2,000 sats they refused are safe again.', 'The 2,000 sats they refused came back, locked to this phone.',
        'The 2,000 sats they did not take are back in your wallet.'], 'refused and settled: dollars as dollars, sats as before');
      P.A.atRiskSettled({ state: 'taken', unit: 'usd', amount: 200, sats: 0 });
      const taken = P.cards.find((c) => c.kind === 'atRiskTaken');
      eq(taken && taken.reason, 'A payment they refused was redeemed afterwards: $ 2.00. Its entry in your history now says paid.',
        'THEY TOOK THE PAYMENT, in dollars');
      P.A.dismissCard && P.A.dismissCard('atRiskTaken');
      const boot = fs.readFileSync(path.join(ROOT, 'build', 'app', '06-wallet-boot-and-restore.js'), 'utf8');
      ok(/W\.onAtRisk\(\(info\) => this\.atRiskSettled\(info\)\)/.test(boot) && /W\.onTakenBack\(\(info\) => this\.takenBackSaid\(info\)\)/.test(boot),
        'the boot puts those two on the wallet’s events');
    }

    /* The dollar books, after an over-payment in dollars: the payment's entry is its net and its change came
     * back on a row of its own (`tap-change-…`). That row is the tail of the payment, never a second
     * receive; while it is owed it is out of the balance and counted with the payment. */
    for (const state of ['came back', 'owed']) {
      const Pw = phone('payer', { online: true, usd: state === 'owed' ? 744 : 800, sat: 0 });
      Pw.st.txs = [];
      const at = Date.now();
      if (state === 'came back') Pw.st.txs.push({ hash: 'tap-change-1', dir: 'in', unit: 'usd', amount: 56, sats: 0, at: at, mint: MINT, settled: true });
      Pw.st.txs.push({ hash: 'pay-over-1', dir: 'out', unit: 'usd', amount: 200, feeAmount: 0, sats: 0, grossAmount: 256, changeAmount: 56,
        changeState: state, at: at - 1000, mint: MINT, settled: true, memo: 'ecash' });
      Pw.st.txs.push({ hash: 'req-in-1', dir: 'in', unit: 'usd', amount: 1000, sats: 0, at: at - 2000, mint: MINT, settled: true });
      await P.fresh(Pw);
      P.A.refreshUsd(); await settle();
      P.A.setState({ screen: 'history', stack: ['home'], histUnit: 'usd' }); await settle();
      P.A.loadHistory(); await settle();
      const au = P.A.histAuditUsd();
      eq([au.whole, au.off], [true, 0], 'the dollar books add up after an over-payment whose change ' + (state === 'owed' ? 'is still owed' : 'came back'));
      const row = (P.A.state.history || []).reduce((a, g) => a.concat(g.items), []).find((t) => t.hash === 'pay-over-1');
      const d = row ? P.A.renderTxDetail({ s: P.A.state, sc: 'txDetail', tx: row }) : {};
      eq([d.txHasChange, d.txGross, d.txChange, d.txChangeNet],
        [true, 'Paid $ 2.56', '$ 0.56' + (state === 'owed' ? ' due' : ' back'), '−$ 2.00'],
        'its detail: what left, the change, and the net, in dollars (' + state + ')');
      P.A.setState({ screen: 'home', stack: [] }); await settle();
    }

    /* An online receiver's offer for dollars carries no bitcoin price: nothing in a dollar tap is converted. */
    {
      const Rw = phone('receiver', { online: true });
      const Pw = phone('payer', { online: true, usd: 1000 });
      wire(Rw, Pw, R);
      await R.fresh(Rw); await P.fresh(Pw);
      quiet();
      await receiveFive(R);
      R.A.setState({ tapArmed: true }); await settle();
      let offer = null;
      try { offer = JSON.parse(link.offer); } catch (e) { offer = null; }
      ok(!!offer && !!offer.req && offer.up === true && offer.rate === undefined && offer.at === undefined,
        'online, the dollar offer carries no bitcoin price', link.offer);
      /* The simulators' stand-in link carries the offer as it is (TapLink.swift, SimWire), and the bridge lets
       * it through only if it is the shape `TapProtocol.isPayload` asks for: v 2, a request starting creq, an
       * invoice only if there is one, under 4096 bytes. The unit is inside the request, so nothing is lost. */
      const isPayload = (text) => {
        let o = null;
        try { o = JSON.parse(text); } catch (e) { return false; }
        if (!o || o.v !== 2 || Buffer.byteLength(text) > 4096) return false;
        if (o.inv !== undefined && !(typeof o.inv === 'string' && /^ln[a-z0-9]+1?[a-z0-9]+$/.test(o.inv))) return false;
        if (o.req !== undefined && !(typeof o.req === 'string' && /^creq[A-Za-z0-9_=+/-]{16,}$/.test(o.req))) return false;
        return o.inv !== undefined || o.req !== undefined;
      };
      ok(isPayload(link.offer), 'and it is an offer the stand-in link and the radio both pass', link.offer);
      eq((Rw.decodeRequest(offer.req) || {}).unit, 'usd', 'with the dollar unit inside its request');
      R.A.stopReceive();
      // and a sat receive's offer still carries the receiver's price, as before
      const Rs = phone('receiver', { online: true, choice: { recv: 'sat' } });
      wire(Rs, Pw, R);
      await R.fresh(Rs);
      quiet();
      R.V().goReceive(); await settle();
      ['5', '0', '0'].forEach((k) => R.A.press(k));
      R.V().next(); await settle(); await settle();
      R.A.setState({ tapArmed: true }); await settle();
      let so = null;
      try { so = JSON.parse(link.offer); } catch (e) { so = null; }
      ok(!!so && so.rate === PRICE, 'a sat receive’s offer still carries the receiver’s price', link.offer);
      R.A.stopReceive();
    }
  }

  const errs = R.errors.concat(P.errors).filter((e) => !/never resolved|Not implemented/.test(e));
  ok(!errs.length, 'no errors on either page', errs.slice(0, 3).join(' | '));
  console.log('');
  console.log(failed ? failed + ' of ' + (passed + failed) + ' dollar tap screen checks failed' : 'all ' + passed + ' dollar tap screen checks pass');
  process.exit(failed ? 1 : 0);
})();
