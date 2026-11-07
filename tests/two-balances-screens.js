'use strict';
/* two-balances-screens.js — the screens of a mint with two balances, driven as a person drives them.
 *
 *     node tests/two-balances-screens.js
 *
 * A mint may issue dollar ecash beside bitcoin. The wallet keeps each in its own pile (build/wallet), and these
 * are the screens that show and move them (build/app, build/markup.html): the home with two pills or one, the
 * question of what to hold, CURRENCY, the receive invoice with its WALLET and NETWORK chips and the minute a
 * dollar code lives, CONFIRM PAYMENT with its WALLET button and the picker behind it, the paid and sent words,
 * history's DOLLARS / BITCOIN tab, and the refusals of what dollars cannot do yet.
 *
 * The real page, rendered in jsdom by build/foxy-render.js as tests/render-snapshots.js renders it, against a
 * stand-in wallet that answers the two-balance contract (window.FoxyWallet: mintUnits, twoUnits, walletChoice,
 * setWalletChoice, balanceOf, invoice with a unit, quoteFeeBoth, payNeed and pay with a unit, sendToken with a
 * unit). The stand-in keeps its own sats and cents, never one added to the other, and records every call, so a
 * check can say what the screen asked of the wallet as well as what it drew.
 *
 * A mint with one balance is checked first: nothing of this shows there. tests/render-snapshots.js pins how
 * every screen looks; this pins what the new ones do. */
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

// ---- the stand-in wallet: the two-balance contract, and a record of what was asked --------------
const MINT = 'https://forge.example.com';
const PRICE = 80000;                         // dollars per bitcoin, the market's
const MINT_RATE = 76900;                     // the mint's, from a dollar quote
const satsOfCents = (c) => Math.round((c / 100) / MINT_RATE * 1e8);

function twoWallet(o) {
  const opt = Object.assign({ units: ['sat', 'usd'], sat: 50000, usd: 4205, online: true }, o || {});
  const rec = { sets: [], setAt: [], invoices: [], watches: [], quotes: [], pays: [], tokens: [], needs: [] };
  const st = { choice: Object.assign({ hold: '' }, opt.choice || {}), sat: opt.sat, usd: opt.usd, at: {}, keptAt: {} };
  let n = 0;
  const invoiceSats = new Map();
  const W = {
    connected: true,
    mintUrl: MINT,
    mintHost: () => 'forge.example.com',
    mints: () => [MINT],
    qr: (text) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)),
    classify: (t) => (/^lnbc/.test(t) ? 'invoice' : /@/.test(t) ? 'lnurl' : /^creq/.test(t) ? 'request' : /^cashu/.test(t) ? 'token' : 'unknown'),
    amountOf: (inv) => (invoiceSats.has(String(inv)) ? invoiceSats.get(String(inv)) : /^lnbc/.test(String(inv)) ? 6112 : null),
    tagsFor: () => ({}),
    tag() {},
    backedUp: () => true,
    pinIsSet: () => false,
    reason: (e) => String((e && e.message) || e),
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: st.sat, mint: MINT }].concat(opt.units.indexOf('usd') >= 0 ? [{ unit: 'usd', amount: st.usd, mint: MINT }] : []),
    balanceAt: () => st.sat,
    balanceSats: () => Promise.resolve(st.sat),
    rate: () => Promise.resolve(PRICE),
    agreedRate: () => Promise.resolve(PRICE),
    transactions: () => Promise.resolve(opt.txs || []),
    book: () => [],
    remember() {},
    listen: () => () => {},
    privacy: () => ({ tor: opt.online ? 'up' : 'connecting', progress: 100, everUp: true, unprotected: false,
      offline: !opt.online, network: opt.online ? 'wifi' : 'none', orbot: 'none', vpn: false }),
    // ---- two balances ----
    mintUnits: () => opt.units.slice(),
    twoUnits: () => opt.units.indexOf('sat') >= 0 && opt.units.indexOf('usd') >= 0,
    // the wallet's contract: the hold, and the one balance it makes (no balance is kept for receives or sends)
    /* Each mint its own choice, as the wallet keeps it: this mint's (MINT) in st.choice, another's in st.at, written
     * where `setWalletChoice` is told (or the connected mint), and which mint each write was for in rec.setAt. The
     * balances are one pair: a test that connects another mint does it only to see where a choice is written. */
    walletChoice: (mint) => {
      const m = mint || W.mintUrl;
      const hold = m === MINT ? st.choice.hold : (st.at[m] || '');
      const one = hold === 'dollars' ? 'usd' : hold === 'bitcoin' ? 'sat' : '';
      return { hold, recv: one, send: one };
    },
    setWalletChoice(p, mint) {
      rec.sets.push(Object.assign({}, p));
      rec.setAt.push(mint || W.mintUrl);
      if (p.recv !== undefined || p.send !== undefined) throw new Error('Foxy does not know that choice.');
      if (p.kept !== undefined && p.kept !== 0) throw new Error('Foxy does not know that choice.');
      if (p.hold != null) {
        if (['dollars', 'bitcoin', 'both'].indexOf(p.hold) < 0) throw new Error('Foxy does not know that choice.');
        const m = mint || W.mintUrl;
        // the wallet keeps what a swap of all left in the other currency (`holdKept`), none where it was told so
        const kept = p.kept === 0 ? 0 : p.hold === 'dollars' ? st.sat : p.hold === 'bitcoin' ? st.usd : 0;
        if (m === MINT) { st.choice.hold = p.hold; st.kept = kept; } else { st.at[m] = p.hold; st.keptAt[m] = kept; }
      }
    },
    // never more than is there now: read below it, it is lowered (spent dust is not a line for later money)
    holdKept: () => {
      if (W.mintUrl !== MINT || !(st.choice.hold === 'dollars' || st.choice.hold === 'bitcoin')) return 0;
      const now = st.choice.hold === 'bitcoin' ? st.usd : st.sat;
      if (now < (st.kept || 0)) st.kept = now;
      return st.kept || 0;
    },
    balanceOf: (u) => (u === 'usd' ? st.usd : st.sat),
    heldIn: () => 0,
    recoveringIn: () => 0,
    invoice(amount, memo, opts) {
      const unit = (opts && opts.unit) || 'sat';
      n += 1;
      const bolt11 = 'lnbc' + unit + n;
      invoiceSats.set(bolt11, unit === 'usd' ? satsOfCents(amount) : amount);
      const inv = { bolt11, hash: 'hash-' + unit + '-' + n, unit, amount, sats: unit === 'sat' ? amount : 0, mint: MINT,
        expiresIn: unit === 'usd' ? 60 : 600, expiresAt: unit === 'usd' ? Date.now() + (opt.usdLife || 60000) : null };
      rec.invoices.push({ amount, memo, opts: opts || null, inv });
      return Promise.resolve(inv);
    },
    watch(hash, onPaid, wopts) {
      const wt = { hash, onPaid, opts: wopts, stopped: false };
      rec.watches.push(wt);
      return () => { wt.stopped = true; };
    },
    quoteFee: () => new Promise(() => {}),
    quoteFeeBoth(bolt11) {
      const sats = W.amountOf(bolt11) || 0;
      const cents = Math.ceil(sats / 1e8 * MINT_RATE * 100);
      rec.quotes.push(bolt11);
      return Promise.resolve({
        sat: { unit: 'sat', amount: sats, feeReserve: 12, msat: sats * 1000, rate: null, quote: 'q-sat', bolt11, at: Date.now() },
        usd: opt.units.indexOf('usd') >= 0 ? { unit: 'usd', amount: cents, feeReserve: 2, msat: sats * 1000,
          rate: { usdPerBtc: MINT_RATE }, quote: 'q-usd', bolt11, at: Date.now() } : null,
      });
    },
    payNeed(amount, reserve, popts) {
      const unit = (popts && popts.unit) || 'sat';
      const have = unit === 'usd' ? st.usd : st.sat;
      const need = amount + reserve;
      rec.needs.push(unit);
      const say = (x) => (unit === 'usd' ? '$ ' + (x / 100).toFixed(2) : '₿ ' + x);
      return { ok: have >= need, need, have, fee: reserve, unit,
        why: have >= need ? '' : 'This payment needs ' + say(need) + ' with its fee, and you hold ' + say(have) + '.' };
    },
    pay(bolt11, onStage, popts) {
      const unit = (popts && popts.unit) || 'sat';
      rec.pays.push({ bolt11, unit, quote: popts && popts.quote ? popts.quote.quote : '' });
      const q = popts && popts.quote;
      const amount = q ? q.amount : (W.amountOf(bolt11) || 0);
      const fee = unit === 'usd' ? 1 : 3;
      if (unit === 'usd') st.usd -= amount + fee; else st.sat -= amount + fee;
      return Promise.resolve({ hash: 'paid-' + rec.pays.length, unit, amount, fee, feeSats: unit === 'sat' ? fee : 0 });
    },
    sendToken(amount, sopts) {
      const unit = (sopts && sopts.unit) || 'sat';
      rec.tokens.push({ amount, opts: sopts || null });
      if (unit === 'usd') st.usd -= amount; else st.sat -= amount;
      return Promise.resolve({ token: 'cashuBtoken' + rec.tokens.length, hash: 'tok-' + rec.tokens.length, unit, amount, sats: unit === 'sat' ? amount : 0 });
    },
    decodeRequest: (t) => (/usd/.test(t) ? { id: 'r1', unit: 'usd', amount: 500, sats: null, mints: [MINT] }
      : { id: 'r2', unit: 'sat', amount: 500, sats: 500, mints: [MINT] }),
    lastToken: () => ({}),
    clearLastToken() {},
    pendingMelts: () => [],
    splitPending: () => null,
  };
  W.rec = rec;
  W.st = st;
  return W;
}

// ---- driving it ---------------------------------------------------------------------------------
const tick = () => wait(15);
async function settle() { for (let i = 0; i < 6; i++) await tick(); }
const textOf = (w) => (w.document.getElementById('dc-root') || w.document.body).textContent.replace(/\s+/g, ' ');

(async () => {
  const { w, errors } = mount();
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  const A = w.__logic;
  if (!A) { console.log('FAIL  the app did not mount\n      ' + errors.join(' | ')); process.exit(1); }
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}
  const initial = Object.assign({}, A.state);
  // toasts are kept, not timed out
  let toasts = [];
  A.toast = (m) => { toasts.push(String(m)); };
  const V = () => A.renderVals();
  // a clean slate, the wallet given, and home
  const fresh = async (W, state) => {
    w.FoxyWallet = W;
    const patch = {};
    for (const k of Object.keys(A.state)) if (!(k in initial)) patch[k] = undefined;
    A._lastPay = null; A._paying = null; A._feeQuotes = null; A._quotedFor = null; A._holdLater = false;
    clearTimeout(A._holdT); A.stopReceive();
    toasts = [];
    A.setState(Object.assign(patch, initial, { walletLive: true, balSats: W.st.sat, balUsdCents: null, livePrice: PRICE,
      satUsd: PRICE / 1e8, screen: 'home', stack: [] }, state || {}));
    A.refreshUsd();
    await settle();
  };
  // CURRENCY's answer, where it is up: every receive and send at a mint with two asks (the owner, 2026-10-22)
  const pickOn = async (unit) => {
    if (A.state.screen !== 'currency') return false;
    V().curCards[unit === 'usd' ? 0 : 1].tap();
    await settle();
    return true;
  };

  // ---- 1. a mint with one balance: nothing of this shows -----------------------------------------
  {
    const W = twoWallet({ units: ['sat'] });
    await fresh(W);
    const v = V();
    ok(v.homeOneMint === true && v.homeTwo === false, 'one balance: the one-balance row of buttons, with no SWAP');
    // the card itself is the two-balance card with one pill: the mint's name over MINT, and the bitcoin pill (tests/home-shield.js)
    eq(v.homePillRows.map((p) => p.sym), ['₿'], 'one balance: one pill, the bitcoin one');
    ok(!/YOUR MONEY/.test(textOf(w)) && textOf(w).indexOf(v.homeMintName) >= 0, 'one balance: the sheet is headed by the mint, not YOUR MONEY');
    eq(v.homeButtonsTwo, [], 'one balance: no SWAP row of three');
    ok(!v.menuItems.some((m) => m.label === 'SWAP' || m.label === 'CURRENCIES'), 'one balance: no SWAP or CURRENCIES in the menu');
    eq(A.state.balUsdCents, null, 'one balance: no dollar figure kept');
    A.offerHoldChoice();
    await settle();
    eq(A.state.screen, 'home', 'one balance: the hold question is never asked');
    V().goReceive();
    await settle();
    eq(A.state.screen, 'amount', 'one balance: RECEIVE goes straight to SET AMOUNT, no CURRENCY');
    const r = V();
    ok(r.recvChipsTwo === false && r.recvHeadTwo === false, 'one balance: the receive screen keeps its one NETWORK chip');
    eq(W.rec.sets.length, 0, 'one balance: nothing remembered');
  }

  // ---- 2. home with two balances -------------------------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    const v = V();
    ok(v.homeTwo === true && v.homeOneMint === false, 'two balances: the new home');
    eq(v.homeMintName, String(A.mintName()).toUpperCase(), 'the sheet is headed by the mint’s name (' + v.homeMintName + ')');
    eq(v.homePillRows.map((p) => p.sym), ['$', '₿'], 'Both: two pills, dollars (frost) over bitcoin (fur)');
    // the owner's change: the dollars' worth in sats under them, at the market price, as the bitcoin pill shows the sats' worth in dollars
    eq([v.homePillRows[0].big, v.homePillRows[0].small], ['42.05', '₿ ' + Math.round(4205 / 100 / (PRICE / 1e8)).toLocaleString('en-US')],
      'the frost pill: $ 42.05, and its worth in sats under it (₿ 52,562 at $ 80,000)');
    A.setState({ satUsd: null, livePrice: null });
    eq([V().homePillRows[0].big, V().homePillRows[0].small], ['42.05', ''], 'with no price the frost pill has nothing under it (not "USD")');
    A.setState({ satUsd: PRICE / 1e8, livePrice: PRICE });
    eq([v.homePillRows[1].big, v.homePillRows[1].small], ['50,000', '$40.00 USD'], 'the fur pill: the sats, their dollar worth under');
    ok(v.homePillRows[0].ink === '#10161B' && v.homePillRows[1].ink === '#FFFFFF', 'frost has dark ink, fur white');
    eq(v.homeButtonsTwo.map((b) => b.label), ['SCAN', 'PASTE', 'CARD'], 'two pills: SCAN / PASTE / CARD, no SWAP on home');
    {
      const l = v.menuItems.map((m) => m.label);
      ok(l.indexOf('SWAP') > l.indexOf('MINTS') && l.indexOf('SWAP') < l.indexOf('TOOLS') && l.indexOf('SWAP') === Math.max(l.indexOf('SWITCH/ADD MINTS'), l.indexOf('TRANSFER MONEY')) + 1,
        'two pills: SWAP is a row of MINTS, under TRANSFER MONEY (or SWITCH/ADD MINTS where there is none)', l.join(', '));
    }
    const t = textOf(w);
    ok(t.indexOf(v.homeMintName) >= 0 && !/\bMINT\b/.test(t) && /42\.05/.test(t) && /50,000/.test(t) && /CARD/.test(t), 'the page draws the heading (the mint’s name alone, no MINT under it), both pills and CARD');
    ok(!/YOUR MONEY/.test(t), 'YOUR MONEY is gone at a mint with two balances');
    eq(v.priceTopPad, 8, 'BITCOIN PRICE level with the round buttons');
    // hidden
    A.setState({ hidden: true });
    eq(V().homePillRows.map((p) => p.big), ['••••••', '••••••'], 'HIDE BALANCE hides both pills');
    A.setState({ hidden: false });
    // a pill opens history on its own tab
    V().homePillRows[0].tap();
    await settle();
    ok(A.state.screen === 'history' && A.state.histUnit === 'usd', 'the frost pill opens history on DOLLARS');
    // dollars only
    W.st.choice = { hold: 'dollars' };
    W.st.sat = 0;
    await fresh(W, { balSats: 0 });
    const d = V();
    eq(d.homePillRows.map((p) => p.sym), ['$'], 'Dollars: one frost pill');
    eq(d.homeButtonsTwo.map((b) => b.label), ['SCAN', 'PASTE', 'CARD'], 'one pill: SCAN / PASTE / CARD');
    ok(d.menuItems.some((m) => m.label === 'SWAP'), 'one pill: SWAP is a row in the menu');
    // money held is never hidden
    W.st.sat = 1200;
    await fresh(W, { balSats: 1200 });
    eq(V().homePillRows.map((p) => p.sym), ['$', '₿'], 'bitcoin held while holding Dollars keeps its pill');
    // bitcoin only
    W.st.choice = { hold: 'bitcoin' };
    W.st.usd = 0;
    await fresh(W);
    eq(V().homePillRows.map((p) => p.sym), ['₿'], 'Bitcoin: one fur pill');
    // offline: SWAP dimmed, and says why
    const off = twoWallet({ choice: { hold: 'both' }, online: false });
    await fresh(off);
    ok(!V().homeButtonsTwo.some((b) => b.label === 'SWAP'), 'offline: no SWAP on home either');
    const sw = V().menuItems.find((m) => m.label === 'SWAP');
    sw.tap();
    eq(toasts.pop(), 'Swapping needs the mint.', 'offline: a tap on SWAP says it needs the mint');
  }

  // ---- 3. the last first step: CURRENCIES ------------------------------------------------------
  {
    // (nothing in bitcoin yet: Dollars leaves nothing behind, so it is DONE; with bitcoin held it is NEXT, below)
    const W = twoWallet({ sat: 0 });
    await fresh(W);
    A.offerHoldChoice();
    await settle();
    eq(A.state.screen, 'holdChoice', 'two balances, never asked: the hold question comes up on home');
    const v = V();
    ok(v.isHoldChoice, 'the hold screen is drawn');
    eq(v.holdRows.map((h) => h.name), ['DOLLARS', 'BITCOIN', 'BOTH'], 'Dollars / Bitcoin / Both');
    ok(/CURRENCIES/.test(textOf(w)) && /At forge\.example\.com/.test(textOf(w)) && /LAST STEP/.test(textOf(w)), 'its words');
    v.holdDone();
    ok(toasts.pop() === 'Pick one first.' && A.state.screen === 'holdChoice', 'DONE with nothing picked does nothing but say so');
    V().holdRows[0].tap();
    eq(V().holdRows.map((h) => h.outline !== 'none'), [true, false, false], 'a pick is outlined');
    V().holdDone();
    await settle();
    eq(W.rec.sets.pop(), { hold: 'dollars' }, 'DONE writes the choice');
    ok(A.state.screen === 'home' && W.st.choice.hold === 'dollars', 'Dollars is kept; home');
    A.offerHoldChoice();
    await settle();
    eq(A.state.screen, 'home', 'asked once');
    // behind a card: waits for it
    const W2 = twoWallet();
    await fresh(W2);
    const fakeCard = w.document.createElement('div');
    w.document.body.appendChild(fakeCard);
    A._blockedEl = fakeCard;
    A.offerHoldChoice();
    await settle();
    eq(A.state.screen, 'home', 'not over a card that is up (SECURE FOXY, custody)');
    fakeCard.remove();
    A._blockedEl = null;
    A.offerHoldChoice();
    await settle();
    eq(A.state.screen, 'holdChoice', 'and up once the card is gone');
    clearTimeout(A._holdT);
  }

  // ---- 4. CURRENCY at every receive and send; nothing remembered (the owner, 2026-10-22) -------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    V().goReceive();
    await settle();
    eq([A.state.screen, A.state.currencyFlow], ['currency', 'receive'], 'a receive: CURRENCY first, before SET AMOUNT');
    const v = V();
    eq([v.curTitle, v.curQuestion], ['CURRENCY', 'What do you want to receive?'], 'its title and question');
    // (a receive's tiles show no balances: what is held says nothing about what to receive — the owner, 2026-10-23)
    eq(v.curCards.map((k) => [k.name, k.balance]), [['DOLLARS', ''], ['BITCOIN', '']], 'two big cards, no balances on a receive');
    v.curCards[0].tap();
    await settle();
    ok(A.state.screen === 'amount' && A.state.wallet === 'usd' && A.state.unit === 'USD', 'DOLLARS: SET AMOUNT, starting in dollars');
    eq(W.rec.sets.length, 0, 'nothing is written: the pick is this receive’s only');
    A.back(); await settle();
    eq([A.state.screen, A.state.wallet], ['home', ''], 'back home: the pick is gone');
    V().goReceive();
    await settle();
    eq(A.state.screen, 'currency', 'the second receive asks again');
    await pickOn('sat');
    ok(A.state.screen === 'amount' && A.walletNow('receive') === 'sat', 'BITCOIN this time: SET AMOUNT for bitcoin');
    A.setState({ screen: 'home', stack: [] }); await settle();
    // a send: CURRENCY before CONFIRM PAYMENT where both can pay, every time
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-invoice');
    await settle();
    eq([A.state.screen, A.state.currencyFlow, A.state.currencyNext], ['currency', 'send', 'sendConfirm'], 'a send both can pay: CURRENCY before CONFIRM PAYMENT');
    eq(V().curQuestion, 'What do you want to send?', 'asked as a send');
    V().curCards[1].tap();
    await settle();
    eq(A.state.screen, 'sendConfirm', 'BITCOIN: on to CONFIRM PAYMENT');
    eq(W.rec.sets.length, 0, 'nothing written for sending either');
    A.setState({ screen: 'home', stack: [] }); await settle();
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-invoice-2');
    await settle();
    eq(A.state.screen, 'currency', 'the next send asks again');
    A.setState({ screen: 'home', stack: [] }); await settle();
    // SETTINGS: no RECEIVE IN or SEND IN rows
    A.setState({ menuSettingsOpen: true, menuSecurityOpen: true });
    const labels = V().menuItems.map((m) => m.label);
    ok(labels.indexOf('SET PIN') >= 0 && labels.indexOf('RECEIVE IN') < 0 && labels.indexOf('SEND IN') < 0,
      'SETTINGS has no RECEIVE IN or SEND IN rows', labels.join(','));
    A.setState({ menuSettingsOpen: false });
    // holding Dollars with nothing in bitcoin: one balance on home, and a receive asks nothing
    const W2 = twoWallet({ choice: { hold: 'dollars' }, sat: 0 });
    await fresh(W2, { balSats: 0 });
    V().goReceive(); await settle();
    ok(A.state.screen === 'amount' && A.walletNow('receive') === 'usd', 'one pill (Dollars): RECEIVE goes straight to SET AMOUNT, into dollars');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }

  // ---- 4b. the card's rule: CURRENCY only when both balances can pay (the owner, 2026-10-22) -----
  {
    // both cover 6,112 sats (about $ 4.89): asked, as above
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-both-cover');
    await settle();
    eq([A.state.screen, A.payFromOnly()], ['currency', ''], 'both cover it: CURRENCY asks');
    // dollars short ($ 2.00): no question, CONFIRM PAYMENT on bitcoin, nothing remembered
    const W2 = twoWallet({ choice: { hold: 'both' }, usd: 200 });
    await fresh(W2);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-dollars-short');
    await settle(); await settle();
    ok(A.state.screen === 'sendConfirm' && A.state.wallet === 'sat' && V().cfWalletWord === 'BITCOIN' && W2.rec.sets.length === 0,
      'only bitcoin covers it: no CURRENCY, CONFIRM PAYMENT on bitcoin, nothing remembered',
      JSON.stringify([A.state.screen, A.state.wallet, W2.rec.sets]));
    ok(/^PAY/.test(String(A.confirmTwoSpec().cta)), 'and it can be paid', String(A.confirmTwoSpec().cta));
    // the WALLET picker stays, with dollars greyed NOT ENOUGH
    A.openWalletPick(); await settle();
    eq(V().curCards.map((k) => k.tag), ['NOT ENOUGH FOR ' + A.sendAmountText(), ''], 'WALLET still opens, dollars NOT ENOUGH');
    A.back(); await settle();
    // bitcoin short: dollars, typed in dollars
    const W3 = twoWallet({ choice: { hold: 'both' }, sat: 1000 });
    await fresh(W3);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-bitcoin-short');
    await settle(); await settle();
    ok(A.state.screen === 'sendConfirm' && A.state.wallet === 'usd' && V().cfWalletWord === 'USD' && W3.rec.sets.length === 0,
      'only dollars cover it: no CURRENCY, CONFIRM PAYMENT on dollars', JSON.stringify([A.state.screen, A.state.wallet]));
    // neither: no question, NOT ENOUGH
    const W4 = twoWallet({ choice: { hold: 'both' }, sat: 1000, usd: 200 });
    await fresh(W4);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-neither');
    await settle(); await settle();
    const nf = A.confirmTwoSpec();
    ok(A.state.screen === 'sendConfirm' && nf.cta === 'NOT ENOUGH' && /^Neither balance covers this/.test(String(nf.warn)),
      'neither covers it: no CURRENCY, NOT ENOUGH', JSON.stringify([A.state.screen, nf.cta, nf.warn]));
    // SET AMOUNT, nothing typed yet: an empty balance is the only one known not to pay
    const W5 = twoWallet({ choice: { hold: 'both' }, usd: 0 });
    await fresh(W5);
    A.setState({ screen: 'amount', stack: ['home'], flow: 'send', unit: 'SATS', amount: '', recipient: 'me@addr.test', recipientKind: 'email' });
    await settle();
    ok(A.state.screen === 'amount' && A.state.wallet === 'sat', 'no dollars at all: SET AMOUNT on bitcoin, not asked', JSON.stringify([A.state.screen, A.state.wallet]));
    const W6 = twoWallet({ choice: { hold: 'both' } });
    await fresh(W6);
    A.setState({ screen: 'amount', stack: ['home'], flow: 'send', unit: 'SATS', amount: '', recipient: 'me@addr.test', recipientKind: 'email' });
    await settle();
    eq(A.state.screen, 'currency', 'both hold something, nothing typed: asked, as before');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }

  // ---- 7. the keypad for dollars --------------------------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    V().goReceive();
    await settle();
    await pickOn('usd');
    ['5', '0', '0'].forEach((k) => A.press(k));
    await settle();
    const v = V();
    eq(v.amountDisplay, '$ 5.00', 'dollars typed as cents: $ 5.00');
    eq(A.wantedAmount(), { unit: 'usd', amount: 500 }, 'which is 500 cents, exactly');
    eq(v.swapVis, 'visible', 'the ⇅ is there on a dollars receive');
    eq(v.amountSub, '₿ 6,250', 'and the same money in sats under it, at the phone’s price');
    // sats typed for the dollar balance
    A.toggleUnit(); await settle();
    eq([A.state.unit, A.state.amount], ['SATS', '6250'], '⇅: the same money, in sats');
    A.setState({ amount: '1000' }); await settle();
    eq(A.wantedAmount(), { unit: 'usd', amount: 80 }, '1,000 sats for dollars ask for the 80 cents they are worth at $ 80,000');
    eq(V().amountSub, '$ 0.80', 'and $ 0.80 is said under them');
    A.toggleUnit(); await settle();
    eq([A.state.unit, A.state.amount], ['USD', '0.80'], '⇅ back: $ 0.80');
    // no price: the keypad stays in dollars and says why in one line
    A.setState({ satUsd: null, livePrice: null });
    toasts = [];
    A.toggleUnit(); await settle();
    eq([A.state.unit, toasts.pop()], ['USD', 'No current bitcoin price, so dollars are typed in dollars.'], 'no price: dollars stay, and it says why');
    A.setState({ satUsd: PRICE / 1e8, livePrice: PRICE, unit: 'SATS', amount: '1000' }); await settle();
    A.setState({ satUsd: null, livePrice: null }); await settle();
    eq(A.state.unit, 'USD', 'a price lost with sats on the keypad: back to dollars');
    A.setState({ satUsd: PRICE / 1e8, livePrice: PRICE, screen: 'home', stack: [] }); await settle();
    // a send over both balances is MORE THAN YOUR BALANCE; over the picked one only, the other pays
    const W2 = twoWallet({ choice: { hold: 'both' }, usd: 200 });
    await fresh(W2);
    A.setState({ screen: 'amount', stack: ['home'], flow: 'send', unit: 'USD', amount: '10.00', wallet: 'usd',
      recipient: 'lnbcsat-noamount', recipientKind: 'invoice' });
    await settle();
    eq(V().sendOverShown, '0', '$ 10.00: dollars ($ 2.00) short, bitcoin ($ 40.00) covers it: not red');
    A.setState({ amount: '99.00' });
    await settle();
    eq([V().sendOverShown, V().sendOverLabel], ['1', 'MORE THAN YOUR BALANCE'], '$ 99.00: neither covers it');
    A.setState({ amount: '10.00' });
    A.keypadWallet();
    ok(A.state.wallet === 'sat' && A.state.walletAuto && toasts.pop() === 'Bitcoin was chosen for you', 'NEXT: bitcoin is chosen for the person, and told');
    eq(W2.rec.sets.length, 0, 'and nothing remembered for it');
  }

  // ---- 8. the receive invoice in dollars ------------------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' }, usdLife: 1300 });
    await fresh(W);
    V().goReceive();
    await settle();
    await pickOn('usd');
    ['5', '0', '0'].forEach((k) => A.press(k));
    V().next();
    await settle(); await wait(40);
    const inv = W.rec.invoices[0];
    eq([inv.amount, inv.opts], [500, { unit: 'usd' }], 'the invoice is a mint quote in dollars, for 500 cents');
    const v = V();
    ok(v.recvHeadTwo && v.recvChipsTwo && !v.recvChipsOne, 'the title between the round buttons; WALLET and NETWORK chips');
    eq([v.recvWalletWord, v.confirmNetwork], ['DOLLARS', 'LIGHTNING'], 'the chips read DOLLARS and LIGHTNING');
    {
      // the chips carry only their word and the chevron: no small WALLET or NETWORK label over it
      const mk = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'markup.html'), 'utf8');
      const block = (k) => { const i = mk.indexOf('<sc-if value="{{ ' + k + ' }}">'); return i < 0 ? '' : mk.slice(i, mk.indexOf('</sc-if>', i)); };
      const one = block('recvChipsOne'), two = block('recvChipsTwo');
      ok(!!one && !!two && !/>\s*NETWORK\s*</.test(one + two) && !/>\s*WALLET\s*</.test(two) && /\{\{ confirmNetwork \}\}/.test(one) && /\{\{ recvWalletWord \}\}/.test(two)
        && /height:56px/.test(one) && (two.match(/height:56px/g) || []).length === 2,
        'the receive chips: no NETWORK or WALLET label, only the word and its chevron, each chip the same height');
    }
    eq([v.confirmAmount, v.showSats, v.confirmAlt], ['$ 5.00', true, '₿ 6,250'], 'the amount in both: the cents asked, their sats under at the phone’s price');
    ok(v.recvTapShown === true && v.recvCardShown === true, 'TAP and CARD on a dollar invoice (the card pays the invoice’s sats: tests/flashcard-usd-receive.js)');
    {
      // the same screen a moment earlier, before the mint had made the invoice: a dollar card pays the cents and needs none, so CARD is there
      const was = A.state;
      A.state = Object.assign({}, was, { invoice: '', invoiceHash: '' });
      const before = V();
      A.state = was;
      eq([before.recvTapShown, before.recvCardShown], [true, true], 'and before the invoice is there, TAP and CARD (a dollar card needs no invoice: tests/flashcard-usd-ui.js)');
    }
    eq(A.tapOffering(), { inv: W.rec.invoices[0].inv.bolt11, req: '', waiting: false },
      'the dollar invoice goes on the air (its request in dollars beside it is tests/usd-tap-screens.js)');
    ok(!v.recvClockShown && /^NEW CODE IN 0:0\d$/.test(v.recvClock), 'the code’s minute counted but not shown: a new code comes in place by itself (' + v.recvClock + ')');
    const t = textOf(w);
    ok(/RECEIVE INVOICE/.test(t) && !/WALLET/.test(t) && !/NETWORK/.test(t) && /DOLLARS/.test(t) && /LIGHTNING/.test(t) && />CARD</.test(w.document.getElementById('dc-root').innerHTML), 'the page draws it: DOLLARS and LIGHTNING with no label over either, CARD with it');
    // the networks a dollar invoice cannot use are greyed
    A.ocCan = () => true;
    V().pickNetwork();
    const sheet = w.document.querySelector('[data-foxy-rail-sheet]');
    const sheetText = sheet ? sheet.textContent : '';
    ok(/On chain is bitcoin only\./.test(sheetText) && !/Dollar requests come later\./.test(sheetText), 'NETWORK: ON-CHAIN greyed for dollars, saying why; CASHU (a request in dollars) open');
    if (sheet) sheet.remove();
    delete A.ocCan;
    // runs out: a new code, the old watch let go
    await wait(1400); await wait(1100); await settle();
    eq(W.rec.invoices.length, 2, 'the code ran out unpaid: a new one is asked for');
    eq([W.rec.invoices[1].amount, W.rec.invoices[1].opts], [500, { unit: 'usd' }], 'for the same 500 cents, in dollars');
    ok(W.rec.watches[0].stopped && !W.rec.watches[1].stopped, 'the old code’s watch is let go, the new one watched');
    eq(A.state.invoice, W.rec.invoices[1].inv.bolt11, 'the new code is on screen');
    // paid: ADDED TO DOLLARS, and nothing remembered
    W.rec.sets.length = 0;
    W.rec.watches[1].onPaid({ hash: W.rec.invoices[1].inv.hash, unit: 'usd', amount: 500, sats: 0 });
    await settle();
    const p = V();
    eq(A.state.screen, 'paid', 'paid');
    eq([p.paidHeadline, p.paidHeadlineSub, p.paidAddedLabel, p.paidAddedTo], ['$ 5.00', '', 'ADDED TO', 'DOLLARS'], 'PAYMENT RECEIVED $ 5.00, ADDED TO DOLLARS');
    ok(/ADDED TO/.test(textOf(w)) && /DOLLARS/.test(textOf(w)) && !/Cash Balance/.test(textOf(w)), 'never "Cash Balance"');
    eq(W.rec.sets.length, 0, 'nothing is kept for the next receive');
    clearInterval(A._recvClockT);
  }

  // ---- 8b. a figure typed in the other unit: the quote is in the balance picked ----------------
  {
    // dollars asked for with sats typed: a mint quote in dollars for the cents they are worth
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    V().goReceive(); await settle();
    await pickOn('usd');
    A.toggleUnit(); await settle();
    A.setState({ amount: '1000' }); await settle();
    V().next();
    await settle(); await wait(40);
    eq([W.rec.invoices[0].amount, W.rec.invoices[0].opts], [80, { unit: 'usd' }], '1,000 sats typed for dollars: a dollar quote for 80 cents');
    const v = V();
    eq([v.recvWalletWord, v.confirmAmount, v.confirmAlt], ['DOLLARS', '$ 0.80', '₿ 1,000'], 'the screen says it in both');
    A.stopReceive(); clearInterval(A._recvClockT);
    A.setState({ screen: 'home', stack: [] }); await settle();
    // bitcoin asked for with dollars typed: a sat invoice for what they are worth, as before
    const W2 = twoWallet({ choice: { hold: 'both' } });
    await fresh(W2);
    V().goReceive(); await settle();
    await pickOn('sat');
    A.setState({ unit: 'USD', amount: '5.00' }); await settle();
    V().next();
    await settle(); await wait(40);
    eq([W2.rec.invoices[0].amount, W2.rec.invoices[0].opts], [6250, null], '$ 5.00 typed for bitcoin: a sat invoice for 6,250');
    A.stopReceive();
    A.setState({ screen: 'home', stack: [] }); await settle();
  }

  // ---- WALLET chip on the invoice: changed for this receive, and a new code in it -------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    V().goReceive();
    await settle();
    await pickOn('sat');
    A.setState({ unit: 'USD', amount: '' });
    ['5', '0', '0'].forEach((k) => A.press(k));
    V().next();
    await settle();
    eq(W.rec.invoices[0].opts, null, 'bitcoin: the invoice is asked as it always was (sats)');
    const v = V();
    eq([v.recvWalletWord, v.recvTapShown, v.recvClockShown], ['BITCOIN', true, false], 'WALLET BITCOIN; tap and card offered; no clock');
    A.recvSwitchWallet('usd');
    await settle();
    eq(W.rec.sets.length, 0, 'the chip’s change is this receive’s only: nothing kept');
    const last = W.rec.invoices[W.rec.invoices.length - 1];
    eq([last.amount, last.opts], [500, { unit: 'usd' }], 'and a new code in dollars for the same $ 5.00');
    eq(V().recvWalletWord, 'DOLLARS', 'the chip reads DOLLARS');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }

  // ---- 9. CONFIRM PAYMENT, the WALLET button, the picker, the switch --------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-maya');
    await settle();
    ok(await pickOn('usd'), 'both can pay: CURRENCY asks, DOLLARS picked');
    await settle();
    eq(A.state.screen, 'sendConfirm', 'an invoice: CONFIRM PAYMENT');
    ok(W.rec.quotes.length === 1, 'both balances quoted at once (quoteFeeBoth)');
    let v = V();
    // (the keeper's 1l, 2026-11-06: CONFIRMATION level with the round buttons, the figures stacked, PAYING FROM's pill)
    eq([v.cfTitle, v.cfTitleUp, v.cfStackShown], ['CONFIRMATION', true, true], 'CONFIRMATION, the title up, the figures stacked');
    // (what is drawn: the stack; the old rows are hidden on the new confirmation)
    const cents = Math.ceil(6112 / 1e8 * MINT_RATE * 100);
    eq(v.cfStack.map((x) => [x.label, x.value]), [['RECEIVER GETS', '$ ' + (cents / 100).toFixed(2)], ['FEE', '$ 0.02'],
      ['PAYING', '$ ' + ((cents + 2) / 100).toFixed(2)], ['RECEIVER', A.sendToText()]], 'RECEIVER GETS, FEE, PAYING (the total), RECEIVER');
    eq(v.cfStack[0].sub, '₿ 6,112', 'RECEIVER GETS says what the payee is paid in sats');
    ok(textOf(w).indexOf('₿ 6,112') >= 0 && textOf(w).indexOf('$ ' + ((cents + 2) / 100).toFixed(2)) >= 0, 'the page draws the sats and the total');
    eq([v.cfWalletShown, v.cfFromShown, v.cfFromWord, v.cfFromMany, v.cfCtaLabel],
      [false, true, A.pfName(MINT) + ' · DOLLARS', true, 'PAY $ ' + ((cents + 2) / 100).toFixed(2)], 'PAYING FROM’s pill on the dollars, with its chevron; PAY and the total');
    ok(/CONFIRMATION/.test(textOf(w)) && /RECEIVER GETS/.test(textOf(w)) && /PAYING FROM/.test(textOf(w)) && !/FEE INCLUDED/.test(textOf(w)), 'the page draws it');
    // the picker, from the pill
    v.cfFromGo();
    await settle();
    v = V();
    eq([A.state.screen, v.curTitle], ['walletPick', 'WALLET'], 'WALLET opens the picker');
    ok(/^Pay .* from$/.test(v.curQuestion), 'Pay … from');
    eq(v.curCards.map((k) => k.tagShown), [false, false], 'both cover it: nothing greyed');
    v.curCards[1].tap();
    await settle();
    ok(A.state.screen === 'sendConfirm' && A.state.wallet === 'sat' && A.state.walletTapped, 'BITCOIN picked by hand');
    eq(W.rec.sets.length, 0, 'and nothing kept for the next send');
    v = V();
    eq([v.cfFromWord, v.cfStack[0].sub], [A.pfName(MINT) + ' · BITCOIN', ''], 'bitcoin picked: the pill names it, and no sats line under RECEIVER GETS');
    eq(v.cfStack[2].value, A.money(6112 + 12).main, 'and PAYING is the bitcoin melt with its fee');
    v.cfGo();
    await settle(); await wait(700); await settle();
    eq(W.rec.pays[0].unit, 'sat', 'pay is called with the bitcoin balance');
    eq(W.rec.pays[0].quote, 'q-sat', 'with that balance’s own quote');
    eq(V().sentFrom, 'FROM BITCOIN', 'sent: FROM BITCOIN');
  }

  // ---- only one can pay: no question, the other greyed in the picker --------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' }, usd: 200 });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-ten');
    await settle(); await settle();
    ok(A.state.screen === 'sendConfirm' && A.state.wallet === 'sat' && A.state.walletAuto === true, 'dollars ($ 2.00) cannot cover it: bitcoin pays, nothing asked');
    eq(W.rec.sets.length, 0, 'nothing written');
    eq(V().cfFromWord, A.pfName(MINT) + ' · BITCOIN', 'the pill names the bitcoin chosen');
    V().cfFromGo();
    await settle();
    const v = V();
    eq(v.curCards[0].tag, 'NOT ENOUGH FOR ' + A.sendAmountText(), 'the picker greys dollars: NOT ENOUGH FOR …');
    ok(v.curCards[0].bg.indexOf('#2A3034') >= 0 && v.curCards[1].outline !== 'none', 'the short card grey, bitcoin outlined');
    eq(v.curFoot, 'Bitcoin was chosen for you: your dollars cannot cover this one.', 'and says why');
    v.curCards[0].tap();
    eq([A.state.screen, toasts.pop()], ['walletPick', 'Your dollars cannot cover this payment.'], 'a greyed card cannot be picked');
    A.back(); await settle();
    V().cfGo();
    await settle(); await wait(700); await settle();
    eq(W.rec.pays[0].unit, 'sat', 'paid from bitcoin');
    eq(W.rec.sets.length, 0, 'a payment Foxy switched is not remembered');
  }

  // ---- neither covers it --------------------------------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' }, usd: 200, sat: 100 });
    await fresh(W, { balSats: 100 });
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-big');
    await settle(); await settle();
    const v = V();
    eq([v.cfCtaLabel, v.cfStack[2].ink], ['NOT ENOUGH', '#FF5C5C'], 'neither covers it: PAYING red, NOT ENOUGH');
    eq(v.cfChip, 'Neither balance covers this. You hold $ 2.00 and ₿ 100.', 'and says what is held');
    v.cfFromGo(); await settle();
    eq(V().curCards.map((k) => k.tagShown), [true, true], 'both greyed in the picker');
  }

  // ---- the mint's price moved: back to CONFIRM PAYMENT, asked again, nothing sent -------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    const realPay = W.pay;
    let refusals = 0;
    W.pay = function (bolt11, onStage, popts) {
      if (refusals === 0) {
        refusals += 1;
        const e = new Error('The mint’s price moved: this payment now needs $ 1.96 with the mint’s fees, not the $ 1.56 you confirmed. Nothing was sent.');
        e.definite = true; e.repriced = true;
        return Promise.reject(e);
      }
      return realPay.call(W, bolt11, onStage, popts);
    };
    const cards = [];
    const realCard = A.blockedCard;
    A.blockedCard = (kind) => { cards.push(kind); };
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-moved');
    await settle();
    await pickOn('usd'); await settle();
    const before = W.rec.quotes.length;
    const usdBefore = W.st.usd;
    V().cfGo();
    await settle(); await wait(700); await settle();
    eq(A.state.screen, 'sendConfirm', 'a repriced dollar payment goes back to CONFIRM PAYMENT');
    eq(cards, [], 'with no failure card');
    ok(W.rec.quotes.length === before + 1, 'and the mint is asked again for the new total');
    ok(toasts.indexOf('The price moved. Check the new total.') >= 0, 'it says why');
    eq(W.st.usd, usdBefore, 'nothing left the dollar balance');
    V().cfGo();
    await settle(); await wait(700); await settle();
    A.blockedCard = realCard;
    eq(V().sentFrom, 'FROM DOLLARS', 'confirmed again at the new price: paid from dollars');
  }

  // ---- UNCLAIMED ECASH: each unit summed on its own --------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    // what clearing kept is read from the notes, not asked of the mint (14-reconcile-seed-restore.js `sayWhatClearingKept`)
    W._sentTokens = () => [{ hash: 'a', token: 'cashuAusd' }, { hash: 'b', token: 'cashuAsat' }];
    W.tokenInfo = (t) => (t === 'cashuAusd' ? { unit: 'usd', amount: 300, sats: null, proofs: [{}] }
      : { unit: 'sat', amount: 1200, sats: 1200, proofs: [{}] });
    W.clearHistory = () => {};
    let card = null;
    const realCard = A.blockedCard;
    A.blockedCard = (kind, over) => { card = { kind, over }; };
    await fresh(W);
    // clearing asks twice, ARE YOU SURE? and ARE YOU TRIPLE SURE? (14-reconcile-seed-restore.js): the second YES clears, then the tokens' card says what was kept
    A.askClear('history');
    if (card && card.over && card.over.go) card.over.go();
    if (card && card.over && card.over.go) card.over.go();
    await settle();
    A.blockedCard = realCard;
    ok(card && card.kind === 'unclaimedTokens', 'two unclaimed tokens: the UNCLAIMED ECASH card');
    ok(card && /2 tokens you sent, \$3\.00 and 1,200 sats, have not been claimed/.test(card.over.reason),
      'it says $3.00 and 1,200 sats, never one figure added across units', card && card.over.reason);
  }

  // ---- 10. sent from dollars; a dollar token -------------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-coffee');
    await settle();
    await pickOn('usd'); await settle();
    V().cfGo();
    await settle(); await wait(700); await settle();
    eq(W.rec.pays[0].unit, 'usd', 'pay is called with {unit: \'usd\'}');
    eq(W.rec.pays[0].quote, 'q-usd', 'with the dollar quote, never the other');
    const s = V();
    const cents = Math.ceil(6112 / 1e8 * MINT_RATE * 100);
    eq([s.sentFrom, s.sentHeadline, s.sentHeadlineSub], ['FROM DOLLARS', '$ ' + ((cents + 1) / 100).toFixed(2), '₿ 6,112 delivered'],
      'sent: FROM DOLLARS, the dollars that left, the sats delivered under');
    ok(/FROM DOLLARS/.test(textOf(w)), 'the page says FROM DOLLARS');
    eq(W.rec.sets.length, 0, 'nothing kept for the next send');
    // a token in dollars
    await fresh(W);
    A.setState({ screen: 'amount', stack: ['home'], flow: 'send', tokenMode: true, unit: 'USD', amount: '5.00', wallet: 'usd' });
    await settle();
    A.makeEcashToken();
    await settle(); await settle();
    eq(W.rec.tokens[0], { amount: 500, opts: { unit: 'usd' } }, 'MAKE ECASH from dollars: sendToken(500, {unit:\'usd\'})');
    const tk = V();
    eq([A.state.screen, tk.tokenAmount, tk.tokenShowAlt], ['tokenOut', '$ 5.00', false], 'the token screen: $ 5.00, no sats line');
    // offline the wallet makes it from dollar pieces on hand (or says why not), and it is shown to be scanned
    const off = twoWallet({ choice: { hold: 'both' }, online: false });
    await fresh(off);
    A.setState({ screen: 'amount', stack: ['home'], flow: 'send', tokenMode: true, unit: 'USD', amount: '5.00', wallet: 'usd' });
    A.makeEcashToken();
    await settle(); await settle();
    eq([off.rec.tokens.length, off.rec.tokens[0] && off.rec.tokens[0].opts, A.state.tokenOutUnit],
      [1, { unit: 'usd' }, 'usd'], 'offline: a dollar token is asked of the wallet in dollars, and shown in dollars');
    const stage = w.document.getElementById('foxy-stage');
    ok(!!stage && /\$ 5\.00/.test(stage.textContent), 'offline: RECEIVER NEEDS TO SCAN, for $ 5.00', stage ? stage.textContent.slice(0, 120) : 'no stage');
    if (A.hideStage) A.hideStage('needScan');
  }

  // ---- 11. history: DOLLARS / BITCOIN ---------------------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    const row = (o) => Object.assign({ name: 'x', time: '10:00', fee: 0, rail: 'Lightning', note: '' }, o);
    const items = [
      row({ name: 'Swap', dir: 'out', unit: 'usd', amount: 1000, feeAmount: 0, sats: 0, kind: 'swap', swap: 's1', hash: 'h1', mintRate: { usdPerBtc: 81786 } }),
      row({ name: 'Swap', dir: 'in', unit: '', sats: 12230, kind: 'swap', swap: 's1', hash: 'h2' }),
      row({ name: 'Corner Market', dir: 'in', unit: 'usd', amount: 1200, feeAmount: 0, sats: 0, hash: 'h3' }),
      row({ name: 'Alex', dir: 'out', unit: '', sats: 2000, fee: 0, hash: 'h4' }),
      row({ name: 'Opening', dir: 'in', unit: 'usd', amount: 4005, feeAmount: 0, sats: 0, hash: 'h5' }),
      row({ name: 'Opening', dir: 'in', unit: '', sats: 39770, hash: 'h6' }),
    ];
    A.setState({ screen: 'history', stack: ['home'], history: [{ label: 'TODAY', items }], historyComplete: true, histUnit: 'usd' });
    await settle();
    let v = V();
    ok(v.histTabsShown && v.histTabs.map((u) => u.label).join() === 'DOLLARS,BITCOIN', 'a tab at the foot: DOLLARS / BITCOIN');
    ok(v.histTabs[0].ink === '#10161B' && v.histTabs[1].bg === 'transparent', 'the active side in its colour (frost)');
    const usdRows = v.historyGroups[0].items;
    eq(usdRows.map((r) => r.amtText), ['- $ 10.00', '+ $ 12.00', '+ $ 40.05'], 'DOLLARS: the dollar rows only, in dollars');
    eq(usdRows[0].amtSub, '₿ 12,230', 'a swap row has the other leg under it');
    eq(usdRows[0].name, 'Swap', 'named Swap');
    eq(usdRows.map((r) => r.balText), ['BAL $ 42.05', 'BAL $ 52.05', 'BAL $ 40.05'], 'the running balance in dollars');
    eq([v.histAuditTitle, v.histAuditBody], ['ADDS UP', 'Every cent of your $ 42.05 is accounted for by the payments above.'], 'the dollars add up on their own tab');
    v.histTabs[1].tap();
    await settle();
    v = V();
    ok(v.histTabs[1].ink === '#fff' && /foxy-fur/.test(v.histTabs[1].bg), 'BITCOIN active, in fur');
    const satRows = v.historyGroups[0].items;
    eq(satRows.map((r) => r.amtText), ['+ ₿ 12,230', '- ₿ 2,000', '+ ₿ 39,770'], 'BITCOIN: the bitcoin rows, sats big');
    eq(satRows[0].amtSub, '$ 10.00', 'the swap’s other leg, in dollars');
    eq(satRows.map((r) => r.balText), ['BAL ₿ 50,000', 'BAL ₿ 37,770', 'BAL ₿ 39,770'], 'the running balance in sats');
    eq(v.histAuditTitle, 'ADDS UP', 'the bitcoin books add up on theirs');
    // a dollar row off by a cent says so on its own tab only
    A.setState({ balUsdCents: 4206, histUnit: 'usd' });
    await settle();
    eq(V().histAuditTitle, 'DOES NOT ADD UP', 'a cent unaccounted for: DOES NOT ADD UP on DOLLARS');
    A.setState({ histUnit: 'sat' });
    eq(V().histAuditTitle, 'ADDS UP', 'and BITCOIN still adds up');
    // the swap's detail
    A.setState({ balUsdCents: 4205, screen: 'txDetail', tx: Object.assign({ mint: MINT }, items[0]) });
    await settle();
    const d = V();
    eq([d.txSwapShown, d.txSwapRate, d.txMint, d.txTotalAlt], [true, '₿ 1 = $ 81,786', 'forge.example.com', 'DOLLARS'], 'a swap’s detail: its rate, its own mint, DOLLARS');
    /* A dollar payment out with a fee: SENT is the amount, TOTAL is the amount
     * and the fee. A card paying a $1.01 invoice with a 5-cent fee showed
     * TOTAL $1.01, and the fee read as a cent. */
    A.setState({ screen: 'txDetail', tx: { dir: 'out', unit: 'usd', amount: 101, feeAmount: 5, mint: MINT, kind: 'melt', at: Date.now() } });
    await settle();
    const f = V();
    eq([f.txSent, f.txFee, f.txTotal], ['−' + A.unitMoney(101, 'usd'), A.unitMoney(5, 'usd'), '−' + A.unitMoney(106, 'usd')],
      'a dollar payment’s TOTAL is the amount and the fee');
    A.setState({ screen: 'txDetail', tx: { dir: 'in', unit: 'usd', amount: 101, feeAmount: 5, mint: MINT, at: Date.now() } });
    await settle();
    eq(V().txTotal, '+' + A.unitMoney(101, 'usd'), 'and a dollar receipt’s TOTAL is what arrived');
  }

  // ---- 12. what dollars can and cannot do, said in words --------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    A.openRequest('creqA-usd');
    eq([A.state.screen, A.state.wallet], ['reqOffer', 'usd'], 'a NUT-18 request in dollars at this mint opens its offer, paid from dollars');
    A.setState({ screen: 'home', stack: [], req: null }); await settle();
    eq(A.tapUnitRule({ unit: 'usd', amount: 500, sats: null }), '', 'a tap’s request in dollars is paid');
    eq(A.tapUnitRule({ unit: 'sat', amount: 500, sats: 500 }), '', 'a request in sats is paid as before');
    eq(A.tapUnitRule({ unit: 'eur', amount: 500, sats: null }), 'That request asks for EUR, which Foxy cannot pay over tap.', 'any other unit is refused in words');
    const offer = A.tapOfferOf(JSON.stringify({ v: 2, req: 'creqA-usd' }));
    ok(!!(offer && !offer.notSats && offer.sameMint && !offer.asksUsd), 'a tap offering a dollar request at this mint is paid in dollars, with no price asked');
    /* CARD on a dollar receive: the card is tapped for the cents at once, with no invoice in it and none waited for, and a
     * bitcoin card for the sats they come to at this phone's price where it has one (none in this suite: nothing asked of a
     * bitcoin card); the whole flow is tests/flashcard-usd-receive.js. */
    const runs = [];
    const start0 = A.fcPayStart;
    A.fcPayStart = (...a) => { runs.push(a); };
    W.cardSession = () => Promise.reject(new Error('no card in this suite'));
    const off0 = A.offlineNow;
    A.offlineNow = () => false;
    A.setState({ screen: 'confirm', flow: 'receive', recvUnit: 'usd', wallet: 'usd', invoice: 'lnbcusd9', invoiceHash: 'q-usd9', recvAmount: 500 });
    A.payByCard();
    eq(runs.map((a) => [a[0], a[4] && a[4].bolt11, a[4] && a[4].cents]), [[0, '', 500]],
      'CARD on a dollar receive taps the card for the 500 cents asked, with no invoice in it');
    A.setState({ invoice: '' });
    A.payByCard();
    eq(runs.length, 2, 'and with no invoice made yet, the card is tapped all the same');
    A.offlineNow = () => true;
    A.setState({ invoice: 'lnbcusd9' });
    A.payByCard();
    ok(runs.length === 2 && /^A card payment needs a connection/.test(toasts.pop() || ''), 'offline, a card payment needs a connection, as in bitcoin');
    A.fcPayStart = start0;
    A.offlineNow = off0;
    delete W.cardSession;
    A.setState({ screen: 'home', stack: [], wallet: 'usd' });
    A.payThisMintWithToken(2100);
    ok(/Dollars need the mint/.test(toasts.pop() || ''), 'offline token to this mint from dollars: "Dollars need the mint"');
  }

  /* ---- a second look: the rules the owner set, checked from the other side --------------------
   *
   * Hold Bitcoin and hold Both as the first step answers them, every payment asking afresh,
   * the automatic switch not carried into the next payment, the keypad of a payment to an
   * address (asked in sats, so it converts and keeps its ⇅), the bitcoin paid screen's words, the
   * hold question put off, and a mint with one balance drawing the confirmation and the sent
   * screen as it always did. */
  {
    // Bitcoin: one fur pill, no SWAP button, and no flow asks which balance
    const W = twoWallet({ usd: 0 });
    await fresh(W);
    A.offerHoldChoice(); await settle();
    V().holdRows[1].tap(); V().holdDone(); await settle();
    eq(W.rec.sets.pop(), { hold: 'bitcoin' }, 'Bitcoin is written as the choice');
    ok(A.walletNow('receive') === 'sat' && A.walletNow('send') === 'sat', 'Bitcoin: its flows use bitcoin');
    const v = V();
    eq(v.homePillRows.map((p) => p.sym), ['₿'], 'Bitcoin, nothing in dollars: one fur pill');
    eq(v.homeButtonsTwo.map((b) => b.label), ['SCAN', 'PASTE', 'CARD'], 'and SCAN / PASTE / CARD, no SWAP');
    ok(v.menuItems.some((m) => m.label === 'SWAP') && v.menuItems.some((m) => m.label === 'CURRENCIES'), 'SWAP and CURRENCIES are menu rows');
    V().goReceive(); await settle();
    ok(A.state.screen === 'amount' && A.walletNow('receive') === 'sat', 'holding Bitcoin: RECEIVE goes straight to SET AMOUNT, in bitcoin');
    eq(V().swapVis, 'visible', 'a bitcoin receive keeps its ⇅ toggle, as today');
    A.setState({ screen: 'home', stack: [] }); await settle();
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-hold-bitcoin');
    await settle(); await settle();
    eq(A.state.screen, 'sendConfirm', 'holding Bitcoin: a send goes straight to CONFIRM PAYMENT');
    eq(V().cfWalletWord, 'BITCOIN', 'and its WALLET button reads BITCOIN');
    // the history tab opens on the pill that is there
    A.setState({ screen: 'history', stack: ['home'], histUnit: '' }); await settle();
    eq(V().histTabs.map((t) => t.ink === 'rgba(var(--ink-rgb),.55)'), [true, false], 'history opens on BITCOIN, the one pill held');
  }
  {
    // Both: two pills, and every receive and send asks
    const W = twoWallet();
    await fresh(W);
    A.offerHoldChoice(); await settle();
    V().holdRows[2].tap(); V().holdDone(); await settle();
    eq(W.rec.sets.pop(), { hold: 'both' }, 'Both is written as the choice');
    ok(A.walletNow('receive') === '' && A.walletNow('send') === '', 'Both: no balance until a payment picks one');
    eq(V().homePillRows.map((p) => p.sym), ['$', '₿'], 'Both: two pills');
    V().goReceive(); await settle();
    eq(A.state.screen, 'currency', 'Both: a receive asks');
    V().curCards[0].tap(); await settle();
    A.setState({ screen: 'home', stack: [] }); await settle();
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-both-first-send');
    await settle();
    eq(A.state.screen, 'currency', 'the receive’s answer is not the send’s: the send asks');
    V().curCards[1].tap(); await settle();
    eq(W.rec.sets.length, 0, 'nothing written by either answer');
    // CURRENCY's back arrow: nothing remembered, so it asks again next time
    A.setState({ screen: 'home', stack: [] }); await settle();
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-both-back');
    await settle();
    eq(A.state.screen, 'currency', 'asked again');
    V().curBack(); await settle();
    ok(A.state.screen !== 'currency' && W.rec.sets.length === 0, 'back from CURRENCY: nothing remembered');
  }
  {
    // the hold question put off: home, nothing written, not asked again until the next launch
    const W = twoWallet();
    await fresh(W);
    A.offerHoldChoice(); await settle();
    V().holdBack(); await settle();
    ok(A.state.screen === 'home' && W.rec.sets.length === 0, 'back from the hold question: home, nothing written');
    A.offerHoldChoice(); await settle();
    eq(A.state.screen, 'home', 'and not asked again until the next launch');
    // MENU › CURRENCIES asks it again, with the answer given outlined
    W.st.choice.hold = 'dollars';
    V().menuItems.find((m) => m.label === 'CURRENCIES').tap(); await settle();
    eq([A.state.screen, V().holdRows.map((h) => h.outline !== 'none')], ['holdChoice', [true, false, false]], 'MENU › CURRENCIES: the question, Dollars outlined');
  }
  {
    // the automatic choice is this payment's only: the next one asks again
    const W = twoWallet({ choice: { hold: 'both' }, usd: 200 });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-auto-once');
    await settle(); await settle();
    eq(A.state.wallet, 'sat', 'dollars short: bitcoin pays this one');
    A.setState({ screen: 'home', stack: [] }); await settle();
    ok(A.state.wallet === '' && !A.state.walletAuto && A.walletNow('send') === '', 'home: nothing carried into the next payment');
    toasts = [];
    W.st.usd = 4205; A.refreshUsd();
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-auto-twice');
    await settle();
    eq(A.state.screen, 'currency', 'both cover the next one: it asks');
    await pickOn('usd'); await settle();
    ok(V().cfWalletWord === 'USD' && toasts.indexOf('Bitcoin was chosen for you') < 0, 'dollars picked pay it, with no toast');
  }
  {
    // a payment to an address in dollars converts (an address is asked in sats): the ⇅ still works
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    A.setState({ screen: 'amount', stack: ['home', 'sendHow'], flow: 'send', unit: 'USD', amount: '5.00', wallet: 'usd',
      recipient: 'maya@flash.example', recipientKind: 'email' });
    await settle();
    eq(V().swapVis, 'visible', 'paying an address from dollars: the ⇅ toggle is there');
    A.toggleUnit(); await settle();
    eq(A.state.unit, 'SATS', 'and a tap on it puts the keypad in sats, and it stays there');
    ok(Number(A.state.amount) > 0, 'with the amount converted, not cleared (' + A.state.amount + ')');
    // a dollar receive: the toggle takes it to sats, as any receive
    A.setState({ screen: 'home', stack: [] }); await settle();
    V().goReceive(); await settle();
    await pickOn('usd');
    toasts = [];
    A.toggleUnit(); await settle();
    ok(A.state.unit === 'SATS' && !toasts.length, 'a dollar receive: the ⇅ puts the keypad in sats');
    // offline, a dollar receive cannot be asked for
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    const W = twoWallet({ choice: { hold: 'both' }, online: false });
    await fresh(W);
    V().goReceive(); await settle();
    await pickOn('usd');
    ['5', '0', '0'].forEach((k) => A.press(k));
    toasts = [];
    V().next(); await settle();
    ok(A.state.screen === 'confirm' && A.state.recvRail === 'CASHU' && A.state.recvUnit === 'usd' && W.rec.invoices.length === 0,
      'offline: NEXT on a dollar receive opens it on CASHU (a request in dollars), and asks the mint for nothing');
    eq([V().confirmNetwork, V().recvClockShown, V().recvTapShown], ['CASHU', false, true], 'offline: NETWORK CASHU, no clock, TAP armed');
    A.setState({ screen: 'home', stack: [] }); await settle();
    // offline, sats typed for dollars: the cents at the last price, with that price's age said under the figure
    V().goReceive(); await settle();
    await pickOn('usd');
    A.toggleUnit(); await settle();
    A.setState({ amount: '1000' }); await settle();
    const ov = V();
    ok(A.state.unit === 'SATS' && ov.priceWarnShown === '1' && /^WARNING: This is based on the price of Bitcoin/.test(ov.priceWarn),
      'offline: sats typed for dollars, and the price’s age said', JSON.stringify([A.state.unit, ov.priceWarn]));
    eq(A.wantedAmount(), { unit: 'usd', amount: 80 }, 'asked as 80 cents');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // a bitcoin receive at a mint with two: ADDED TO BITCOIN, and nothing remembered
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    V().goReceive(); await settle();
    await pickOn('sat');
    A.setState({ unit: 'USD', amount: '' });
    ['5', '0', '0'].forEach((k) => A.press(k));
    V().next(); await settle();
    W.rec.sets.length = 0;
    const wt = W.rec.watches[W.rec.watches.length - 1];
    wt.onPaid({ hash: wt.hash, unit: 'sat', amount: 6250, sats: 6250 });
    await settle();
    const p = V();
    eq([A.state.screen, p.paidAddedLabel, p.paidAddedTo], ['paid', 'ADDED TO', 'BITCOIN'], 'bitcoin paid: ADDED TO BITCOIN');
    ok(!/Cash Balance|Bitcoin Balance/.test(textOf(w)), 'never "Bitcoin Balance" at a mint with two');
    eq(W.rec.sets.length, 0, 'nothing kept for the next receive');
    A.stopReceive();
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // a link into a receive (foxy=receive) asks afresh, not with a send's pick
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    A.setState({ screen: 'sendConfirm', stack: ['home'], flow: 'send', wallet: 'usd', walletTapped: true });
    w.location.hash = '#foxy=receive';
    A.applyDeepLink(); await settle();
    ok(A.state.screen === 'currency' && A.state.flow === 'receive' && A.state.wallet === '',
      'a link to RECEIVE: CURRENCY asks, not the dollars a send had picked', JSON.stringify([A.state.screen, A.state.wallet]));
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // holding dollars, the roads that are bitcoin only stay bitcoin: on chain and transfer are typed as today
    const W = twoWallet({ choice: { hold: 'dollars' } });
    await fresh(W);
    for (const flow of ['onchain', 'transfer']) {
      A.setState({ screen: 'amount', stack: ['home'], flow: flow, unit: 'USD', amount: '5.00', recipientKind: flow === 'onchain' ? 'address' : '' });
      await settle();
      ok(!A.usdKeypad() && V().swapVis === 'visible' && A.state.unit === 'USD' && A.state.amount === '5.00',
        flow + ' while holding dollars: the keypad converts to sats as today, its ⇅ there');
    }
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // a mint with one balance: CONFIRM PAYMENT and the sent screen as they always were
    const W = twoWallet({ units: ['sat'] });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-one-mint');
    await settle(); await settle();
    const v = V();
    ok(A.state.screen === 'sendConfirm' && v.cfWalletShown === false && v.cfFromMany === false, 'one balance: no WALLET button, and PAYING FROM opens nothing');
    ok(W.rec.quotes.length === 0 && v.cfStack[0].sub === '', 'one balance: no dollar line, and no quote of both');
    eq(V().sentFromShown, false, 'one balance: the sent screen has no FROM line');
    A.setState({ screen: 'history', stack: ['home'] }); await settle();
    eq([V().histTabsShown, V().histTabs.length], [false, 0], 'one balance: history has no DOLLARS / BITCOIN tab');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }

  /* ---- CURRENCIES: the choice is made for this mint, and changes the balances seen -------------
   *
   * The keeper's rules: the screen says which mint it is for; Both shows both and receives in both; one currency with
   * nothing in the other is one balance at once; one currency with money in the other is NEXT, the swap's own
   * confirmation for the whole of the other balance with its fee, and CONFIRM moves it and goes home with one balance,
   * the choice kept; CANCEL, or a swap that fails, keeps the choice as it was; what a swap of all leaves (too little for
   * the mint after its fee) is a line under the chosen balance, not a pill, and a receive does not ask about it.
   * The stand-in leaves what the real wallet leaves at the harness mint: 8 cents of dollars, 115 sats of bitcoin. */
  // the stand-in's swap calls, keeping cents and sats apart (as tests/two-balances-swap.js has them)
  const swapping = (W, how) => {
    const run = Object.assign({ asked: [], ran: [], as: 'done', pending: [], outcome: {} }, how || {});
    W.mintRate = () => ({ usdPerBtc: MINT_RATE });
    W.unitSwapsPending = () => run.pending.map((id) => ({ id, at: 1, from: { unit: 'usd', amount: 0 }, to: { unit: 'sat', amount: 0 } }));
    W.swapOutcome = (id) => run.outcome[id] || '';
    // what a swap of all leaves behind at the harness mint (review probe: $ 0.08 and ₿ 115 with no input fee)
    const LEAVE = { usd: 8, sat: 115 };
    W.sweepMelts = () => Promise.resolve([]);
    W.recoverSwaps = () => Promise.resolve([]);
    W.swapProbe = () => Promise.resolve({ usdPerBtc: MINT_RATE });
    W.swapQuote = (from, to, amount, o) => {
      run.asked.push({ from, to, amount, all: !!(o && o.all) });
      if (run.refuse) return Promise.reject(new Error(run.refuse));
      const total = (o && o.all) ? (from === 'usd' ? W.st.usd : W.st.sat) - LEAVE[from] : amount;
      const fee = from === 'usd' ? 2 : 3;
      return Promise.resolve({ id: 'uswap-' + run.asked.length, mint: MINT, from, to, total, amount: total - fee, fee,
        get: from === 'usd' ? Math.floor((total - fee) / 100 / MINT_RATE * 1e8) : Math.floor((total - fee) * MINT_RATE / 1e8 * 100),
        rate: { usdPerBtc: MINT_RATE, by: 'forge.example.com' }, market: PRICE, spread: 0, spreadWarn: false,
        expiresAt: Date.now() + 67500, state: 'quoted' });
    };
    W.swapRun = (q, stage) => {
      run.ran.push(q);
      if (run.as === 'throw') return Promise.reject(new Error('The mint is busy. Try again in a moment.'));
      if (run.as === 'failed') return Promise.resolve({ id: q.id, state: 'failed', from: { unit: q.from, amount: q.total }, to: { unit: q.to, amount: 0 } });
      const pend = { id: q.id, state: 'pending', from: { unit: q.from, amount: q.total }, to: { unit: q.to, amount: q.get }, fee: q.fee, rate: q.rate };
      // with the mint, then given back (nothing moved) or finished (both moved), as `run.settle` says, by `run.land()`
      if (run.as === 'pending') {
        run.pending.push(q.id);
        if (q.from === 'usd') W.st.usd -= q.total; else W.st.sat -= q.total;
        run.land = (how) => {
          run.pending = run.pending.filter((x) => x !== q.id);
          if (how === 'back') { if (q.from === 'usd') W.st.usd += q.total; else W.st.sat += q.total; run.outcome[q.id] = run.word ? 'failed' : ''; }
          else { if (q.from === 'usd') W.st.sat += q.get; else W.st.usd += q.get; run.outcome[q.id] = run.word ? 'done' : ''; }
        };
        if (run.landAt === 'now') run.land(run.settle);
        return Promise.resolve(pend);
      }
      stage('paying'); stage('done');
      if (q.from === 'usd') { W.st.usd -= q.total; W.st.sat += q.get; } else { W.st.sat -= q.total; W.st.usd += q.get; }
      return Promise.resolve({ id: q.id, state: 'done', from: { unit: q.from, amount: q.total }, to: { unit: q.to, amount: q.get }, fee: q.fee, rate: q.rate });
    };
    return run;
  };
  const openCurrencies = async () => {
    V().menuItems.find((m) => m.label === 'CURRENCIES').tap();
    await settle();
  };
  {
    // the screen: titled CURRENCIES, and it says which mint the choice is for
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    await openCurrencies();
    const t = textOf(w);
    ok(A.state.screen === 'holdChoice' && /CURRENCIES/.test(t) && !/WHAT DO YOU WANT TO HOLD/.test(t), 'MENU › CURRENCIES: a screen titled CURRENCIES', t.slice(0, 200));
    ok(/At forge\.example\.com/.test(t) && V().holdMint === 'At forge.example.com', 'it says the mint the choice is for', V().holdMint);
    ok(/at this mint/i.test(V().holdSub), 'and that the choice is this mint’s', V().holdSub);
    ok(!/LAST STEP/.test(t) && V().holdStep === '', 'from the menu it is not LAST STEP');
  }
  {
    // Both, after one: both balances on home, and a receive offers both
    const W = twoWallet({ choice: { hold: 'bitcoin' }, usd: 0 });
    await fresh(W);
    eq(V().homePillRows.map((p) => p.sym), ['₿'], 'holding bitcoin, nothing in dollars: one pill');
    await openCurrencies();
    V().holdRows[2].tap(); await settle();
    eq(V().holdDoneLabel, 'DONE', 'Both: the button reads DONE');
    V().holdDone(); await settle();
    eq([A.state.screen, W.rec.sets.pop()], ['home', { hold: 'both' }], 'Both: home, and Both kept');
    eq(V().homePillRows.map((p) => p.sym), ['$', '₿'], 'Both: both balances on home');
    V().goReceive(); await settle();
    ok(A.state.screen === 'currency' && V().curCards.length === 2, 'and a receive offers both');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // one currency, the other at 0: home at once, one balance, no swap asked, receives only in the one
    const W = twoWallet({ choice: { hold: 'both' }, usd: 0 });
    const run = swapping(W);
    await fresh(W);
    await openCurrencies();
    V().holdRows[1].tap(); await settle();
    eq(V().holdDoneLabel, 'DONE', 'Bitcoin with no dollars: the button reads DONE');
    V().holdDone(); await settle();
    eq([A.state.screen, W.rec.sets.pop(), run.asked.length], ['home', { hold: 'bitcoin' }, 0], 'home at once, Bitcoin kept, no swap asked');
    eq(V().homePillRows.map((p) => p.sym), ['₿'], 'one balance on home');
    V().goReceive(); await settle();
    ok(A.state.screen === 'amount' && A.walletNow('receive') === 'sat', 'a receive is in bitcoin, dollars not offered');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // one currency, the other funded: NEXT, the swap's confirmation for all of it with its fee, SWAP, home with one balance
    const W = twoWallet({ choice: { hold: 'both' }, usd: 4205, sat: 50000 });
    const run = swapping(W);
    await fresh(W);
    await openCurrencies();
    V().holdRows[1].tap(); await settle();
    eq(V().holdDoneLabel, 'NEXT', 'Bitcoin with dollars held: the button reads NEXT');
    ok(/\$ 42\.05/.test(V().holdNote) && /bitcoin/i.test(V().holdNote), 'and says the dollars will be swapped into bitcoin first', V().holdNote);
    V().holdDone(); await settle(); await settle();
    eq(W.rec.sets.length, 0, 'NEXT writes nothing yet');
    eq(run.asked.pop(), { from: 'usd', to: 'sat', amount: 4205, all: true }, 'the rate is asked for all of the dollars');
    const t = textOf(w);
    ok(A.state.screen === 'swapConfirm' && /YOU ARE GETTING/.test(t) && /YOU ARE SPENDING\s*\$ 41\.97 in DOLLARS/.test(t) && /FEE\s*\$ 0\.02/.test(t),
      'the swap confirmation: what arrives, all the dollars the mint will take ($ 41.97 of $ 42.05), and the fee', t.slice(0, 300));
    eq(V().cfCtaLabel, 'SWAP', 'its button is SWAP, as every swap’s');
    // CANCEL (the round ✕): the choice as it was
    V().cfClose(); await settle();
    eq([A.state.screen, W.rec.sets.length, run.ran.length, W.st.choice.hold], ['home', 0, 0, 'both'], 'CANCEL: home, nothing moved, the choice as it was');
    // back from the confirmation: CURRENCIES again, nothing kept
    await openCurrencies();
    V().holdRows[1].tap(); V().holdDone(); await settle(); await settle();
    A.back(); await settle();
    eq([A.state.screen, W.rec.sets.length, W.st.choice.hold], ['holdChoice', 0, 'both'], 'back: CURRENCIES again, the choice as it was');
    V().holdDone(); await settle(); await settle();
    A._preSettle = null;
    V().cfGo(); await settle(); await settle();
    eq(run.ran.length, 1, 'SWAP runs the swap');
    eq([A.state.screen, W.rec.sets.pop()], ['home', { hold: 'bitcoin' }], 'and home, Bitcoin kept');
    eq(W.st.usd, 8, 'all the dollars the mint would take are moved: 8 cents are left, as at a real mint');
    A.refreshUsd(); await settle();
    eq(V().homePillRows.map((p) => p.sym), ['₿'], 'one balance on home, not a pill for the 8 cents');
    eq([V().homeLeftShown, V().homeLeft], [true, 'Also here: $ 0.08 in dollars'], 'the 8 cents a line under it, so nothing is hidden');
    ok(/Also here: \$ 0\.08 in dollars/.test(textOf(w)), 'drawn on the page');
    V().goReceive(); await settle();
    ok(A.state.screen === 'amount' && A.walletNow('receive') === 'sat', 'a receive is in bitcoin with no question', A.state.screen);
    A.setState({ screen: 'home', stack: [] }); await settle();
    // money that comes in dollars since: past what was left, its own pill again, the choice as set
    W.st.usd = 508; A.refreshUsd(); await settle();
    eq([V().homePillRows.map((p) => p.sym), V().homeLeftShown, W.st.choice.hold], [['₿', '$'], false, 'bitcoin'], 'dollars paid in since: their pill again, bitcoin first');
    // the leftover spent, then a little paid in: not taken for the leftover (it only goes down as it is spent)
    W.st.usd = 8; W.st.kept = 8; A.refreshUsd(); await settle();
    eq(V().homeLeftShown, true, 'back to the 8 cents: the line');
    W.st.usd = 0; A.refreshUsd(); await settle();
    eq([V().homePillRows.map((p) => p.sym), V().homeLeftShown, W.st.kept], [['₿'], false, 0], 'the 8 cents spent: no line, and nothing recorded as left');
    W.st.usd = 5; A.refreshUsd(); await settle();
    eq([V().homePillRows.map((p) => p.sym), V().homeLeftShown], [['₿', '$'], false], '5 cents paid in later: a pill, not the line');
  }
  {
    // still going through at one mint, landing while another is connected: the choice is the first mint's, with its
    // own leftover, and the other mint's choice is as it was
    const B = 'https://other.example.com';
    const W = twoWallet({ choice: { hold: 'both' }, usd: 4205, sat: 50000 });
    const run = swapping(W, { as: 'pending', word: true });
    W.st.at[B] = 'both';
    await fresh(W);
    await openCurrencies();
    V().holdRows[1].tap(); V().holdDone(); await settle(); await settle();
    A._preSettle = null;
    A.SWAP_WAIT_MS = 0; A.HOLD_WATCH_MS = 20;
    V().cfGo(); await settle(); await settle();
    [...w.document.body.children].filter((el) => /SWAP STILL GOING/.test(el.textContent)).forEach((el) => el.remove());
    A._blockedEl = null; A._blockedKind = ''; A._cardQueue = [];
    W.mintUrl = B;
    run.land('done');
    await wait(80); await settle();
    eq([W.rec.setAt.pop(), W.rec.sets.pop()], [MINT, { hold: 'bitcoin' }], 'it lands with another mint connected: written at the mint it was made at');
    eq([W.st.choice.hold, W.st.kept, W.st.at[B], W.st.keptAt[B]], ['bitcoin', 8, 'both', undefined], 'that mint holds bitcoin with its 8 cents left; the other is as it was');
    W.mintUrl = MINT;
    // a switch of mint, a wipe and a restore stop the look
    const src = (f) => fs.readFileSync(path.join(ROOT, 'build', 'app', f), 'utf8');
    const stops = (f, fn) => { const t = src(f); const i = t.indexOf('  ' + fn + '('); const j = t.indexOf('\n  }\n', i); return i > 0 && t.slice(i, j).indexOf('this.holdSwapWatchStop()') > 0; };
    ok(stops('09-melt-paste-switch.js', 'justSwitch') && stops('14-reconcile-seed-restore.js', 'wipedAndRestarting') && stops('06-wallet-boot-and-restore.js', 'adoptRestoreMint'),
      'a switch of mint, a wipe and a restore stop the look');
    A.HOLD_WATCH_MS = 20;
    A.holdSwapWatch({ id: 'x', hold: 'bitcoin', from: 'usd', before: 0, total: 1, mint: MINT });
    A.holdSwapWatchStop();
    ok(!A._holdWatchT, 'and stopping it leaves no timer');
    A.HOLD_WATCH_MS = 5000;
  }
  {
    // and the other way round: dollars, bitcoin held
    const W = twoWallet({ choice: { hold: 'both' }, usd: 4205, sat: 50000 });
    const run = swapping(W);
    await fresh(W);
    await openCurrencies();
    V().holdRows[0].tap(); await settle();
    eq(V().holdDoneLabel, 'NEXT', 'Dollars with bitcoin held: NEXT');
    V().holdDone(); await settle(); await settle();
    eq(run.asked.pop(), { from: 'sat', to: 'usd', amount: 50000, all: true }, 'the rate is asked for all of the bitcoin');
    A._preSettle = null;
    V().cfGo(); await settle(); await settle();
    eq([A.state.screen, W.rec.sets.pop(), W.st.sat], ['home', { hold: 'dollars' }, 115], 'SWAP: home, Dollars kept, 115 sats left as at a real mint');
    A.refreshUsd(); A.setState({ balSats: W.st.sat }); await settle();
    eq([V().homePillRows.map((p) => p.sym), V().homeLeft], [['$'], 'Also here: ₿ 115 in bitcoin'], 'one dollar pill, the sats a line under it');
    V().goReceive(); await settle();
    ok(A.state.screen === 'amount' && A.walletNow('receive') === 'usd', 'a receive is in dollars with no question', A.state.screen);
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // a swap that settles while the screen waits: kept only if it landed; one given back says the mint did not make it
    for (const [settleAs, word] of [['back', false], ['back', true], ['done', false], ['done', true]]) {
      const W = twoWallet({ choice: { hold: 'both' }, usd: 4205, sat: 50000 });
      swapping(W, { as: 'pending', landAt: 'now', settle: settleAs, word });
      await fresh(W);
      await openCurrencies();
      V().holdRows[1].tap(); V().holdDone(); await settle(); await settle();
      A._preSettle = null;
      A.SWAP_WAIT_MS = 400; A.SWAP_WAIT_STEP_MS = 20;
      V().cfGo(); await settle(); await settle(); await wait(60); await settle();
      const said = word ? ' (the wallet’s word)' : ' (by the balance)';
      if (settleAs === 'back') {
        ok(A.state.screen === 'swapConfirm' && W.rec.sets.length === 0 && W.st.choice.hold === 'both' && /did not make this swap/.test(V().cfChip),
          'given back while the screen waited' + said + ': the choice not kept, and the mint did not make it', JSON.stringify([A.state.screen, W.rec.sets, V().cfChip]));
      } else {
        eq([A.state.screen, W.rec.sets.pop()], ['home', { hold: 'bitcoin' }], 'landed while the screen waited' + said + ': home, Bitcoin kept');
      }
      A.SWAP_WAIT_MS = 0;
      A.setState({ screen: 'home', stack: [] }); await settle();
    }
  }
  {
    // still with the mint after the wait (SWAP STILL GOING THROUGH): kept when it lands, not if it comes back
    for (const settleAs of ['done', 'back']) {
      const W = twoWallet({ choice: { hold: 'both' }, usd: 4205, sat: 50000 });
      const run = swapping(W, { as: 'pending', word: true });
      await fresh(W);
      await openCurrencies();
      V().holdRows[1].tap(); V().holdDone(); await settle(); await settle();
      A._preSettle = null;
      A.SWAP_WAIT_MS = 0; A.HOLD_WATCH_MS = 20;
      V().cfGo(); await settle(); await settle();
      const card = [...w.document.body.children].map((el) => el.textContent).join(' ');
      ok(A.state.screen === 'home' && /SWAP STILL GOING THROUGH/.test(card) && W.rec.sets.length === 0 && W.st.choice.hold === 'both',
        'still going through: the card, and the choice not kept yet', JSON.stringify([A.state.screen, W.rec.sets]));
      [...w.document.body.children].filter((el) => /SWAP STILL GOING/.test(el.textContent)).forEach((el) => el.remove());
      A._blockedEl = null; A._blockedKind = ''; A._cardQueue = [];
      await wait(60);
      eq(W.rec.sets.length, 0, 'nothing kept while it is with the mint');
      run.land(settleAs);
      await wait(80); await settle();
      if (settleAs === 'done') eq([W.rec.sets.pop(), W.st.choice.hold], [{ hold: 'bitcoin' }, 'bitcoin'], 'it lands: Bitcoin kept then');
      else eq([W.rec.sets.length, W.st.choice.hold], [0, 'both'], 'it comes back: the choice stays Both');
      ok(!A._holdWatchT, 'and the look stops');
      A.HOLD_WATCH_MS = 5000;
    }
  }
  {
    // the first time, with no route: the choice is kept and the other money left where it is, a balance of its own
    // (a pill) until it is swapped: only what a swap of all left is ever drawn as the line
    const W = twoWallet({ usd: 4205, sat: 50000, online: false });
    swapping(W);
    await fresh(W);
    A.offerHoldChoice(); await settle();
    V().holdRows[1].tap(); await settle();
    eq(V().holdDoneLabel, 'DONE', 'first time, offline, dollars held: DONE, not NEXT');
    V().holdDone(); await settle();
    eq([A.state.screen, W.rec.sets.pop()], ['home', { hold: 'bitcoin', kept: 0 }], 'Bitcoin kept, home, nothing recorded as left beside it');
    A.refreshUsd(); await settle();
    eq([V().homePillRows.map((p) => p.sym), V().homeLeftShown], [['₿', '$'], false], 'the dollars left where they are, still their own pill, bitcoin first');
    // from the menu, offline, it is NEXT and says the swap needs the mint
    V().menuItems.find((m) => m.label === 'CURRENCIES').tap(); await settle();
    V().holdRows[0].tap(); await settle();
    V().holdDone(); await settle();
    ok(A.state.screen === 'holdChoice' && toasts.pop() === 'Swapping needs the mint.' && W.st.choice.hold === 'bitcoin', 'from the menu offline: the swap needs the mint, nothing changes');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // a swap that fails: the choice is not kept, and the confirmation says why
    for (const as of ['throw', 'failed']) {
      const W = twoWallet({ choice: { hold: 'both' }, usd: 4205, sat: 50000 });
      swapping(W, { as });
      await fresh(W);
      await openCurrencies();
      V().holdRows[1].tap(); V().holdDone(); await settle(); await settle();
      A._preSettle = null;
      V().cfGo(); await settle(); await settle();
      ok(A.state.screen === 'swapConfirm' && W.rec.sets.length === 0 && W.st.choice.hold === 'both',
        'a swap that ' + (as === 'throw' ? 'cannot reach the mint' : 'the mint does not make') + ': the choice is not kept', JSON.stringify([A.state.screen, W.rec.sets]));
      ok(!!V().cfChip && (as === 'throw' ? /busy/.test(V().cfChip) : /did not make this swap/.test(V().cfChip)), 'and the confirmation says why', V().cfChip);
      A.setState({ screen: 'home', stack: [] }); await settle();
    }
  }
  {
    // dust: too little to swap after the fee is not nothing; it stays, a line under the chosen balance
    const W = twoWallet({ choice: { hold: 'both' }, usd: 1, sat: 50000 });
    const run = swapping(W, { refuse: 'That is too little to swap after the mint’s fee.' });
    await fresh(W);
    await openCurrencies();
    V().holdRows[1].tap(); await settle();
    eq(V().holdDoneLabel, 'NEXT', 'a cent of dollars is not nothing: NEXT');
    V().holdDone(); await settle(); await settle();
    ok(A.state.screen === 'swapConfirm' && /too little to swap/.test(V().cfChip) && /stays/.test(V().cfChip), 'too little to swap: the confirmation says it stays', V().cfChip);
    ok(/under your bitcoin/.test(V().cfChip), 'and where home shows it', V().cfChip);
    eq(V().cfCtaLabel, 'KEEP IT AND HOLD BITCOIN', 'and offers to keep it');
    V().cfGo(); await settle();
    eq([A.state.screen, W.rec.sets.pop(), run.ran.length], ['home', { hold: 'bitcoin' }, 0], 'home, Bitcoin kept, nothing swapped');
    A.refreshUsd(); await settle();
    eq([V().homePillRows.map((p) => p.sym), V().homeLeft], [['₿'], 'Also here: $ 0.01 in dollars'], 'one pill, the cent a line under it');
    V().goReceive(); await settle();
    ok(A.state.screen === 'amount' && A.walletNow('receive') === 'sat', 'and a receive asks nothing', A.state.screen);
    A.setState({ screen: 'home', stack: [] }); await settle();
  }

  const errs = errors.filter((e) => !/never resolved|Not implemented/.test(e));
  ok(!errs.length, 'no errors on the page', errs.slice(0, 3).join(' | '));
  console.log('');
  console.log(failed ? failed + ' of ' + (passed + failed) + ' two-balance screen checks failed' : 'all ' + passed + ' two-balance screen checks pass');
  process.exit(failed ? 1 : 0);
})();
