'use strict';
/* confirm-screens.js — the confirmations and PAY FROM as the keeper drew them on 2026-11-06 (1k, 1l, 1m, 1p).
 *
 *     node tests/confirm-screens.js
 *
 *   1  1k, TRANSFER: MOVING, FEE and RECEIVING stacked (RECEIVING 68px in the accent), MORE DETAILS closed until tapped,
 *      then FROM, TO and the three fees, UP TO on the route's; CANCEL then TRANSFER and what leaves, in that order on the
 *      page; a transfer from dollars says what it becomes
 *   2  1l, a Lightning invoice: RECEIVER GETS, FEE, PAYING, RECEIVER (the invoice shortened); PAYING FROM's pill at the
 *      foot, which opens nothing with one balance and PAY FROM with a choice; PAY and what leaves; no MORE DETAILS
 *   3  1m, a Cashu request over Tor: the same with no RECEIVER; a Foxy ID payment names the contact there instead
 *   4  1p, PAY FROM: the tiles' name, balance line, tick on the one chosen only, the fee line with its badge,
 *      CALCULATING… while asked, NOT ENOUGH kept as a tag, no CHEAPEST and no question line
 *
 * The real page, rendered in jsdom by build/foxy-render.js as tests/two-balances-screens.js renders it, against a
 * stand-in wallet. */
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

function mount() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a) => errors.push(a.map(String).join(' ').slice(0, 300)));
  vc.on('jsdomError', (e) => errors.push('jsdom: ' + String(e && e.message).slice(0, 300)));
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


const MINT = 'https://forge.example.com';
const AWAY = 'https://mint.minibits.cash/Bitcoin';
const PRICE = 80000;
const INV = 'lnbc61120n1pexampleinvoicexeh50';

function wallet(o) {
  const opt = Object.assign({ sat: 50000, units: ['sat'], awayUnits: ['sat'], awaySat: 9000, inFee: 0, short: false }, o || {});
  const told = [];
  const W = {
    connected: true, mintUrl: MINT,
    mintHost: () => 'forge.example.com', mints: () => [MINT, AWAY],
    qr: (text) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)),
    classify: () => 'invoice',
    amountOf: (inv) => (/^lnbc/.test(String(inv)) ? 6112 : null),
    tagsFor: () => ({}), tag() {}, backedUp: () => true, pinIsSet: () => false,
    reason: (e) => String((e && e.message) || e),
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: opt.sat, mint: MINT }, { unit: 'sat', amount: opt.awaySat, mint: AWAY }],
    balanceAt: (url) => (String(url || '').indexOf('minibits') >= 0 ? opt.awaySat : opt.sat), balanceSats: () => Promise.resolve(opt.sat),
    rate: () => Promise.resolve(PRICE), agreedRate: () => Promise.resolve(PRICE),
    transactions: () => Promise.resolve([]), book: () => [], remember() {}, listen: () => () => {},
    privacy: () => ({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false, network: 'wifi', orbot: 'none', vpn: false }),
    mintUnits: (url) => (String(url || MINT).indexOf('minibits') >= 0 ? opt.awayUnits.slice() : opt.units.slice()),
    twoUnits: () => false,
    walletChoice: () => ({ hold: '', recv: '', send: '' }),
    balanceOf: () => opt.sat, heldIn: () => 0, recoveringIn: () => 0,
    // `inFee`: the mint's fee on the pieces a melt spends, which `pay` refuses on and the quote's fee alone does not say
    payNeed: (amount, reserve) => ({ ok: true, need: amount + reserve + opt.inFee, have: opt.sat, fee: reserve + opt.inFee, unit: 'sat', why: '' }),
    sendShortfall: (want) => ({ need: want + 2, fee: 2, have: opt.short ? want : opt.sat, short: !!opt.short, unit: 'sat',
      why: opt.short ? 'Your balance isn\u2019t enough.' : '' }),
    tapQuote: (j) => { told.push(String(j)); return Promise.resolve(); },
    told: told,
    quoteFee: () => new Promise(() => {}),
    watch: () => () => {},
    lastToken: () => ({}), clearLastToken() {}, pendingMelts: () => [], splitPending: () => null,
  };
  return W;
}

const tick = () => wait(15);
async function settle() { for (let i = 0; i < 6; i++) await tick(); }
const textOf = (w) => (w.document.getElementById('dc-root') || w.document.body).textContent.replace(/\s+/g, ' ');
// the words given, each found after the one before it on the page
const inOrder = (text, words) => {
  let at = -1;
  for (const wd of words) { const i = text.indexOf(wd, at + 1); if (i < 0) return wd + ' missing after ' + at; at = i; }
  return '';
};

(async () => {
  const { w, errors } = mount();
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  const A = w.__logic;
  if (!A) { console.log('FAIL  the app did not mount\n      ' + errors.join(' | ')); process.exit(1); }
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}
  const initial = Object.assign({}, A.state);
  A.toast = () => {};
  A.quoteSendFee = () => {};
  A.quoteTransfer = () => {};
  const V = () => A.renderVals();
  const fresh = async (W, state) => {
    w.FoxyWallet = W;
    const patch = {};
    for (const k of Object.keys(A.state)) if (!(k in initial)) patch[k] = undefined;
    A._pf = null;
    A.setState(Object.assign(patch, initial, { walletLive: true, balSats: 50000, balUsdCents: null, livePrice: PRICE,
      satUsd: PRICE / 1e8, screen: 'home', stack: [] }, state || {}));
    await settle();
  };
  const money = (n) => A.money(n).main;
  const FORGE = A.pfName(MINT), MINI = A.pfName(AWAY);

  // ---- 1. 1k: the transfer's confirmation ----------------------------------------------------------
  try {
    await fresh(wallet(), { screen: 'trConfirm', stack: ['home', 'amount'], trFrom: MINT, trTo: AWAY, trUnit: 'sat', trSats: 1000,
      trFee: 80, trErr: '', trBusy: false, trPlan: { from: MINT, to: AWAY, reserve: 50, padSats: 3, feeSats: 80, gross: 1080 }, cfMore: '' });
    const v = V();
    ok(v.isConfirmShell && v.cfStackShown && !v.cfOldShown, '1k: the transfer is drawn as the new confirmation');
    eq(v.cfStack.map((x) => x.label), ['MOVING', 'FEE', 'RECEIVING'], '1k: MOVING, FEE, RECEIVING');
    eq(v.cfStack.map((x) => x.value), [money(1080), money(80), money(1000)], '1k: what leaves at most, the fee, what lands');
    eq(v.cfStack.map((x) => x.size), ['48px', '48px', '68px'], '1k: 48px figures, RECEIVING at 68px');
    eq(v.cfStack.map((x) => x.ink), ['var(--ink)', 'var(--ink)', 'var(--acc)'], '1k: RECEIVING in the accent');
    eq([v.cfMoreShown, v.cfMoreOpen, v.cfFromShown, v.cfTitle, v.cfTitleUp], [true, false, false, 'CONFIRMATION', true],
      '1k: MORE DETAILS, closed; no PAYING FROM; CONFIRMATION level with the back button');
    eq([v.cfSecondaryLabel, v.cfCtaLabel], ['CANCEL', 'TRANSFER ' + money(1080)], '1k: CANCEL, then TRANSFER and what leaves');
    const t0 = textOf(w);
    eq(inOrder(t0, ['CONFIRMATION', 'MOVING', 'FEE', 'RECEIVING', 'MORE DETAILS', 'CANCEL', 'TRANSFER']), '', '1k: the page draws them in that order');
    ok(t0.indexOf('LIGHTNING FEE') < 0 && t0.indexOf('LANDING AT') < 0, '1k: the details are not drawn until asked, nor the old rows');
    v.cfMoreTap();
    await settle();
    const o = V();
    eq([o.cfMoreOpen, o.cfMoreRot], [true, 'rotate(180deg)'], '1k: MORE DETAILS tapped: open, the chevron turned');
    eq(o.cfDetails.map((d) => d.label), ['FROM', 'TO', FORGE + ' FEE', 'LIGHTNING FEE', MINI + ' FEE'], '1k: FROM, TO and the three fees');
    eq(o.cfDetails.map((d) => d.value), [FORGE, MINI, money(27), 'UP TO ' + money(50), money(3)],
      '1k: the source’s own fee, the route’s reserve UP TO, the far mint’s');
    eq(o.cfDetails.map((d) => d.span), ['auto', 'auto', 'auto', 'auto', '1 / -1'], '1k: two to a row, the last across both');
    eq(o.cfDetailNoteShown, false, '1k: sats to sats has no note');
    eq(inOrder(textOf(w), ['RECEIVING', 'MORE DETAILS', 'FROM', 'TO', 'LIGHTNING FEE', MINI + ' FEE', 'CANCEL']), '', '1k: the grid is drawn under MORE DETAILS');
    o.cfMoreTap();
    await settle();
    eq(V().cfMoreOpen, false, '1k: tapped again, closed');
    // from dollars, to a mint with none
    await fresh(wallet({ units: ['sat', 'usd'], awayUnits: ['sat'] }), { screen: 'trConfirm', stack: ['home'], trFrom: MINT, trTo: AWAY, trUnit: 'usd',
      trSats: 5000, trErr: '', cfMore: 'trConfirm', trPlan: { unit: 'usd', gross: 512, feeUnit: 12, reserve: 5, padSats: 0, amountUnit: 500 } });
    const d = V();
    eq(d.cfStack.map((x) => x.value), ['$ 5.12', '$ 0.12', money(5000)], '1k in dollars: the dollars that leave, the fee in cents, what lands');
    eq(d.cfStack[2].sub, '₿ 5,000', '1k in dollars: the sats that land under RECEIVING');
    eq(d.cfDetails.map((x) => x.value).slice(2, 4), ['$ 0.07', 'UP TO $ 0.05'], '1k in dollars: the fees in dollars');
    eq(d.cfDetailNote, A.mintNameOf(AWAY) + ' has no dollars, so the money becomes bitcoin.', '1k in dollars: the note, as the card’s move says it');
    eq(d.cfCtaLabel, 'TRANSFER $ 5.12', '1k in dollars: TRANSFER and the dollars that leave');
  } catch (e) { ok(false, 'the section ran to its end', String(e && e.message)); }

  // ---- 2. 1l: a Lightning invoice --------------------------------------------------------------------
  try {
    await fresh(wallet(), { screen: 'sendConfirm', stack: ['home'], flow: 'send', recipient: INV, recipientKind: 'invoice',
      quotedFee: 12, quotedAmt: 6112, quotingFee: false, cfMore: '' });
    // the quote for this invoice is in (`sendToAsk`)
    A._quotedFor = (A.sendAsk() || {}).key;
    A.setState({ cfMore: '' });
    await settle();
    const v = V();
    ok(v.cfStackShown, '1l: the invoice’s confirmation is the new one');
    eq(v.cfStack.map((x) => x.label), ['RECEIVER GETS', 'FEE', 'PAYING', 'RECEIVER'], '1l: RECEIVER GETS, FEE, PAYING, RECEIVER');
    eq(v.cfStack.map((x) => x.value), [money(6112), money(12), money(6124), A.shortId(INV)], '1l: the figures, and the invoice shortened');
    eq(v.cfStack.map((x) => x.size), ['48px', '48px', '68px', '24px'], '1l: PAYING at 68px, the invoice at 24px');
    eq([v.cfMoreShown, v.cfSecondaryShown, v.cfCloseShown, v.cfWalletShown], [false, false, true, false],
      '1l: no MORE DETAILS (only on a transfer), no note button, the X, no WALLET button');
    eq([v.cfFromShown, v.cfFromWord, v.cfFromMany], [true, FORGE + ' · BITCOIN', false], '1l: PAYING FROM’s pill, one balance: no chevron');
    eq(v.cfCtaLabel, 'PAY ' + money(6124), '1l: PAY and what leaves');
    eq(inOrder(textOf(w), ['CONFIRMATION', 'RECEIVER GETS', 'FEE', 'PAYING', 'RECEIVER', 'PAYING FROM', FORGE + ' · BITCOIN', 'PAY ']), '',
      '1l: the page draws them in that order, the pill at the foot');
    v.cfFromGo();
    await settle();
    eq(A.state.screen, 'sendConfirm', '1l: with one balance the pill opens nothing');
    // a choice of mints: the pill opens PAY FROM
    A.setState({ payFromFlow: 'send', payFromList: [
      Object.assign(A.pfEntry({ mint: MINT, unit: 'sat', have: 50000 }), { ok: true, cost: 6124, fee: 12 }),
      Object.assign(A.pfEntry({ mint: AWAY, unit: 'sat', have: 9000 }), { ok: true, cost: 6116, fee: 4 }),
    ] });
    await settle();
    const m = V();
    eq([m.cfFromMany, m.cfFromCursor], [true, 'pointer'], '1l: with a choice, the pill has its chevron');
    m.cfFromGo();
    await settle();
    eq([A.state.screen, A.state.payFromReopen], ['payFrom', true], '1l: the pill opens PAY FROM');
  } catch (e) { ok(false, 'the section ran to its end', String(e && e.message)); }

  // ---- 3. 1m: a Cashu request over Tor, and a Foxy ID ---------------------------------------------
  try {
    const req = { id: 'r1', unit: 'sat', sats: 750, amount: 750, mints: [MINT], transports: ['onion'], delivery: { kind: 'onion', target: 'x.onion' } };
    await fresh(wallet(), { screen: 'reqOffer', stack: ['home'], req: req, cfMore: '' });
    const v = V();
    eq(v.cfStack.map((x) => x.label), ['RECEIVER GETS', 'FEE', 'PAYING'], '1m: no RECEIVER line for a request');
    eq(v.cfStack.map((x) => x.value), [money(750), money(2), money(752)], '1m: the figures, the mint’s fee for the pieces in');
    eq([v.cfMoreShown, v.cfSecondaryShown, v.cfCloseShown, v.cfFromShown, v.cfFromWord], [false, false, true, true, FORGE + ' · BITCOIN'],
      '1m: no MORE DETAILS, no note button, the X, PAYING FROM');
    ok(/^PAY /.test(v.cfCtaLabel), '1m: PAY', v.cfCtaLabel);
    eq(inOrder(textOf(w), ['RECEIVER GETS', 'FEE', 'PAYING', 'PAYING FROM', 'PAY ']), '', '1m: in that order on the page');
    eq(v.cfFromMany, false, '1m: no choice offered, the pill opens nothing');
    // PAY FROM offered a choice for it: the pill opens it again, the source it is paid from ticked
    A.setState({ payFromFlow: 'req', payMint: AWAY, payUnit: 'sat', payFromList: [
      Object.assign(A.pfEntry({ mint: MINT, unit: 'sat', have: 50000 }), { ok: true, cost: 750, fee: 0 }),
      Object.assign(A.pfEntry({ mint: AWAY, unit: 'sat', have: 9000 }), { ok: true, cost: 753, fee: 3 }),
    ] });
    await settle();
    const rq = V();
    eq([rq.cfFromMany, rq.cfFromWord], [true, MINI + ' · BITCOIN'], '1m: with a choice, the pill names the source and has its chevron');
    rq.cfFromGo();
    await settle();
    eq([A.state.screen, A.state.payFromReopen, A.state.payFromPick], ['payFrom', true, A.pfKey(AWAY, 'sat')], '1m: the pill opens PAY FROM, its source ticked');
    await fresh(wallet(), { screen: 'cidConfirm', stack: ['home'], recipient: 'cashuid1x', recipientKind: 'cashuid', recipientName: 'Ada',
      cidAmount: 750, cidUnit: 'sat', cidBusy: false, cidErr: '', cfMore: '' });
    const c = V();
    eq(c.cfStack.map((x) => x.label), ['RECEIVER GETS', 'FEE', 'PAYING', 'RECEIVER'], '1m, a Foxy ID: the contact where the invoice would be');
    eq(c.cfStack[3].value, 'ADA', '1m, a Foxy ID: its name');
    eq([c.cfMoreShown, c.cfSecondaryShown, c.cfCloseShown, c.cfFromMany], [false, false, true, false], '1m, a Foxy ID: CANCEL is the X; the pill opens nothing');
    c.cfClose();
    await settle();
    eq(A.state.screen, 'home', '1m, a Foxy ID: the X goes home');
  } catch (e) { ok(false, 'the section ran to its end', String(e && e.message)); }

  // ---- 3b. what leaves, said as it is: the review's points ---------------------------------------
  try {
    // M1: at a mint that charges for the pieces a melt spends, PAYING and PAY are the sum `pay` refuses on
    await fresh(wallet({ inFee: 40 }), { screen: 'sendConfirm', stack: ['home'], flow: 'send', recipient: INV, recipientKind: 'invoice',
      quotedFee: 12, quotedAmt: 6112, quotingFee: false, cfMore: '' });
    A._quotedFor = (A.sendAsk() || {}).key;
    A.setState({ cfMore: '' }); await settle();
    const m1 = V();
    eq(m1.cfStack.map((x) => x.value).slice(0, 3), [money(6112), money(52), money(6164)], '1l, input fees: FEE and PAYING are what leaves (6,164 sats), not the quote alone');
    eq(m1.cfCtaLabel, 'PAY ' + money(6164), '1l, input fees: PAY says the same figure');
    // a note already written is drawn, with no button to add one
    A.setState({ note: 'Lunch' }); await settle();
    eq(V().cfStack.map((x) => x.label + '=' + x.value).slice(-1), ['NOTE=Lunch'], '1l: a note written is drawn under the figures');
    ok(V().cfSecondaryShown === false, '1l: and still no note button');

    // M2: a request at a mint this phone holds nothing at is paid from here, across: the pill names this mint
    const there = { id: 'r2', unit: 'sat', sats: 750, amount: 750, mints: [AWAY], transports: ['onion'], delivery: { kind: 'onion', target: 'x.onion' } };
    await fresh(wallet({ awaySat: 0 }), { screen: 'reqOffer', stack: ['home'], req: there, cfMore: '', note: '' });
    eq(V().cfFromWord, FORGE + ' · BITCOIN', '1m: nothing held at the request’s mint: the pill names the mint the money leaves');
    // and one held there is paid there on a visit, whose fee for the pieces is told only there
    await fresh(wallet({ awaySat: 9000 }), { screen: 'reqOffer', stack: ['home'], req: there, cfMore: '', note: '' });
    const vis = V();
    eq([vis.cfFromWord, vis.cfStack[1].value, vis.cfStack[2].value], [MINI + ' · BITCOIN', 'NOT KNOWN YET', money(750) + ' + FEE'],
      '1m, paid there: the pill names that mint, and the fee is not said to be nothing');
    // R1: the same mint picked by hand on PAY FROM (a source with no crossing and no swap) is still paid there on a visit
    await fresh(wallet({ awaySat: 9000 }), { screen: 'reqOffer', stack: ['home'], req: there, cfMore: '', note: '',
      payFromFlow: 'req', payMint: AWAY, payUnit: 'sat' });
    const vis2 = V();
    eq([vis2.cfStack[1].value, vis2.cfStack[2].value], ['NOT KNOWN YET', money(750) + ' + FEE'],
      '1m, the visited mint picked on PAY FROM: the fee is still not said to be nothing');

    // M3a: a website is named under RECEIVER
    const site = { id: 'r3', unit: 'sat', sats: 750, amount: 750, mints: [MINT], transports: ['post'], delivery: { kind: 'https', target: 'https://shop.example.org/pay' } };
    await fresh(wallet(), { screen: 'reqOffer', stack: ['home'], req: site, cfMore: '', note: '' });
    const ws = V();
    eq(ws.cfStack.map((x) => x.label + '=' + x.value).slice(3), ['RECEIVER=shop.example.org'], '1m, a website: its host under RECEIVER');
    // L1: PAY says what leaves, the fee in it
    eq(ws.cfCtaLabel, 'PAY ' + money(752), '1m: PAY says PAYING, the mint’s fee in it');

    // M3b: sats for dollars agreed over a tap: the dollars asked and this phone's price under RECEIVER GETS, the fee in sats
    const tapReq = { id: 'r4', unit: 'sat', sats: 6502, amount: 6502, mints: [MINT], transports: [], viaTap: true };
    await fresh(wallet(), { screen: 'reqOffer', stack: ['home'], req: tapReq, tapCode: '4821', tapQuoteFor: 'r4', tapQuoteUsd: 500,
      tapQuoteRate: 76900, tapQuoteAgeMs: 2 * 3600 * 1000, cfMore: '', note: '' });
    const ag = V();
    ok(/^For \$ 5\.00 at \$ 76,900, this phone’s price, seen /.test(ag.cfStack[0].sub), '1m, sats for dollars: the dollars asked and whose price, with its age', ag.cfStack[0].sub);
    eq([ag.cfStack[0].value, ag.cfStack[1].value, ag.cfStack[2].value], ['₿ 6,502', '₿ 2', '₿ 6,504'], '1m, sats for dollars: every figure in sats, the fee too');
    eq(ag.cfCtaLabel, 'PAY ₿ 6,504', '1m, a tap: PAY, as on every one');
    // L3: the X on a tap's request tells the other phone, on the short screen as on the other
    await fresh(wallet({ short: true }), { screen: 'reqOffer', stack: ['home'], req: Object.assign({}, tapReq, { id: 'r5' }), tapCode: '4821', cfMore: '', note: '' });
    const W5 = w.FoxyWallet;
    const sh = V();
    eq(sh.cfCtaLabel, 'NOT ENOUGH', '1m, a tap the balance cannot cover: NOT ENOUGH');
    sh.cfClose(); await settle();
    ok(A.state.screen === 'home' && W5.told.some((j) => /gaveUp/.test(j)), '1m: its X tells the other phone the payer gave up', JSON.stringify(W5.told));

    // M3c: paid from the other balance, swapped first: what leaves in both, and from what, under PAYING
    const swapReq = { id: 'r6', unit: 'sat', sats: 5000, amount: 5000, mints: [MINT], transports: ['nostr'], delivery: { kind: 'nostr', target: 'nprofile1x' } };
    await fresh(wallet({ sat: 3190, units: ['sat', 'usd'] }), { screen: 'reqOffer', stack: ['home'], req: swapReq, balSats: 3190, cfMore: '', note: '',
      payFromFlow: 'req', payMint: MINT, payUnit: 'usd',
      payFromList: [Object.assign(A.pfEntry({ mint: MINT, unit: 'usd', have: 500 }), { swap: true, toUnit: 'sat', ok: true, cost: 151, fee: 2 })] });
    A._pf = { flow: 'req', run: 1, home: MINT, full: { [MINT + '|usd']: { total: 151, amount: 149, fee: 2, get: 1868, rate: { usdPerBtc: 80000 },
      state: 'quoted', expiresAt: 4102444800000 } }, go: () => {}, cancel: () => {} };
    A.setState({ cfMore: '' }); await settle();
    const sw = V();
    eq(sw.cfStack[2].value, '$ 1.51 + ₿ 3,132', '1m, a swap: PAYING is the dollars for the swap and the sats held');
    ok(/^From your dollars at /.test(sw.cfStack[2].sub), '1m, a swap: from what, under PAYING', sw.cfStack[2].sub);

    // L4: the pill, PAY FROM, NEXT, and back on the request with the new source
    const twoReq = { id: 'r7', unit: 'sat', sats: 750, amount: 750, mints: [MINT], transports: ['onion'], delivery: { kind: 'onion', target: 'x.onion' } };
    await fresh(wallet(), { screen: 'reqOffer', stack: ['home'], req: twoReq, cfMore: '', note: '' });
    A.pfReqOpen(twoReq, [
      A.pfEntry({ mint: MINT, unit: 'sat', have: 50000 }, { pref: true, ok: true, cost: 752, fee: 2, rank: 2 }),
      A.pfEntry({ mint: AWAY, unit: 'sat', have: 9000 }, { ok: true, cost: 755, fee: 5, rank: 5 }),
    ], MINT, money(750));
    await settle();
    eq(A.state.screen, 'payFrom', '1m: PAY FROM first, with two that can pay');
    A.pfTap(A.pfKey(AWAY, 'sat')); A.pfNext(); await settle();
    eq([A.state.screen, V().cfFromWord, V().cfFromMany], ['reqOffer', MINI + ' · BITCOIN', true], '1m: NEXT, back on the request, the pill naming the source chosen');
    V().cfFromGo(); await settle();
    eq([A.state.screen, A.state.payFromPick], ['payFrom', A.pfKey(AWAY, 'sat')], '1m: the pill opens PAY FROM, its source ticked');
    V().curBack(); await settle();
    eq([A.state.screen, V().cfFromWord], ['reqOffer', MINI + ' · BITCOIN'], '1m: PAY FROM’s back returns to the same confirmation, the source unchanged');
    V().cfFromGo(); await settle();
    A.pfTap(A.pfKey(MINT, 'sat')); A.pfNext(); await settle();
    eq([A.state.screen, V().cfFromWord], ['reqOffer', FORGE + ' · BITCOIN'], '1m: another picked: back, the pill naming it');

    // the Foxy ID's PAY says what leaves too
    await fresh(wallet(), { screen: 'cidConfirm', stack: ['home'], recipient: 'cashuid1x', recipientKind: 'cashuid', recipientName: 'Ada',
      cidAmount: 750, cidUnit: 'sat', cidBusy: false, cidErr: '', cfMore: '', note: '' });
    eq(V().cfCtaLabel, 'PAY ' + money(752), '1m, a Foxy ID: PAY and what leaves');

    // a dollar transfer's RECEIVING at the source's own rate, so MOVING less FEE comes to it
    await fresh(wallet({ units: ['sat', 'usd'] }), { screen: 'trConfirm', stack: ['home'], trFrom: MINT, trTo: AWAY, trUnit: 'usd', trSats: 5000, trErr: '',
      cfMore: '', trPlan: { unit: 'usd', gross: 512, feeUnit: 12, reserve: 5, padSats: 0, amountUnit: 500, rate: { usdPerBtc: 100000 } } });
    eq(V().cfStack.map((x) => x.value), ['$ 5.12', '$ 0.12', '$ 5.00'], '1k in dollars: RECEIVING at the quote’s rate, MOVING less FEE');
  } catch (e) { ok(false, 'the section ran to its end', String(e && e.stack)); }

  // ---- 4. 1p: PAY FROM ---------------------------------------------------------------------------------
  try {
    await fresh(wallet(), { screen: 'payFrom', stack: ['home', 'sendConfirm'], payFromFlow: 'send', payFromAsk: 'Pay $ 4.89 from' });
    const KASHU = 'https://kashu.example.com';
    const list = [
      Object.assign(A.pfEntry({ mint: MINT, unit: 'sat', have: 19622 }), { ok: true, cost: 6113, fee: 1 }),
      Object.assign(A.pfEntry({ mint: MINT, unit: 'usd', have: 283 }), { ok: true, cost: 495, fee: 6 }),
      A.pfEntry({ mint: AWAY, unit: 'sat', have: 6149 }),
      Object.assign(A.pfEntry({ mint: KASHU, unit: 'sat', have: 6200 }), { ok: false, tag: 'NOT ENOUGH', why: 'short' }),
    ];
    A.setState({ payFromList: list, payFromPick: list[0].key });
    await settle();
    const v = V();
    eq([v.curAskAbove, v.curAskBelow], [false, false], '1p: PAY FROM has its title alone, no question line');
    const r = v.curRows;
    eq(r.map((x) => x.name), [FORGE, FORGE, MINI, A.pfName(KASHU)], '1p: a tile for each, the mint’s name');
    eq(r.map((x) => x.unitLine + (x.unitAlt ? ' ' + x.unitAlt : '')), ['BITCOIN · ₿ 19,622 (' + money(19622) + ')', 'DOLLARS · $ 2.83',
      'BITCOIN · ₿ 6,149 (' + money(6149) + ')', 'BITCOIN · ₿ 6,200 (' + money(6200) + ')'], '1p: the balance and what it holds, sats with their dollars');
    eq(r.map((x) => x.pickOn), [true, false, false, false], '1p: the tick on the one chosen only');
    eq(r.map((x) => x.cost), ['FEE ' + money(1), 'FEE $ 0.06', 'CALCULATING…', ''], '1p: the fee lines, CALCULATING… while asked, none where short');
    eq(r.map((x) => x.feeShown), [true, true, true, false], '1p: no fee line on a tile that cannot pay');
    eq(r.map((x) => x.tagShown ? x.tag : ''), ['', '', '', 'NOT ENOUGH'], '1p: NOT ENOUGH stays as the tag');
    eq(r.map((x) => x.sym), ['₿', '$', '₿', '₿'], '1p: each fee line’s badge in its unit');
    eq([r[0].bg, r[0].edge, r[1].bg, r[1].edge], ['rgba(var(--acc-rgb),.1)', '2px solid var(--acc)', 'var(--surface)', '1px solid rgba(var(--ink-rgb),.1)'],
      '1p: the chosen tile on the accent’s wash with its edge, the others on the surface');
    eq([r[0].feeInk, r[1].feeInk, r[2].feeInk], ['var(--acc)', 'var(--acc-lt)', 'rgba(var(--ink-rgb),.43)'], '1p: the fee in the accent, lighter on the others, grey while asked');
    eq([r[0].badgeBg, r[1].badgeBg, r[2].badgeBg], ['var(--acc)', '#BFE3EC', 'rgba(var(--ink-rgb),.12)'], '1p: ₿ on the accent, $ on light blue, grey while asked');
    const t = textOf(w);
    eq(w.document.querySelectorAll('[data-pf-tick]').length, 1, '1p: one tick on the page');
    ok(t.indexOf('CHEAPEST') < 0 && t.indexOf('Pay $ 4.89 from') < 0, '1p: no CHEAPEST and no question on the page');
    eq(inOrder(t, ['PAY FROM', FORGE, 'BITCOIN', 'FEE', 'DOLLARS · $ 2.83', 'FEE $ 0.06', MINI, 'CALCULATING…', 'NOT ENOUGH', 'NEXT']), '', '1p: in that order on the page');
    r[1].tap();
    await settle();
    eq(V().curRows.map((x) => x.pickOn), [false, true, false, false], '1p: a tile tapped takes the tick');
  } catch (e) { ok(false, 'the section ran to its end', String(e && e.message)); }

  if (errors.length) ok(false, 'no errors from the page', errors.slice(0, 3).join(' | '));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
