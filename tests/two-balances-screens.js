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
  const rec = { sets: [], invoices: [], watches: [], quotes: [], pays: [], tokens: [], needs: [] };
  const st = { choice: Object.assign({ hold: '', recv: '', send: '' }, opt.choice || {}), sat: opt.sat, usd: opt.usd };
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
    walletChoice: () => Object.assign({}, st.choice),
    setWalletChoice(p) {
      rec.sets.push(Object.assign({}, p));
      if (p.hold != null) {
        if (['dollars', 'bitcoin', 'both'].indexOf(p.hold) < 0) throw new Error('Foxy does not know that choice.');
        st.choice.hold = p.hold;
        if (p.hold === 'dollars') { st.choice.recv = 'usd'; st.choice.send = 'usd'; }
        if (p.hold === 'bitcoin') { st.choice.recv = 'sat'; st.choice.send = 'sat'; }
        if (p.hold === 'both') { st.choice.recv = ''; st.choice.send = ''; }
      }
      if (p.recv) st.choice.recv = p.recv;
      if (p.send) st.choice.send = p.send;
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
    ok(!v.menuItems.some((m) => m.label === 'SWAP' || m.label === 'WHAT YOU HOLD'), 'one balance: no SWAP or WHAT YOU HOLD in the menu');
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
    eq(v.homeButtonsTwo.map((b) => b.label), ['SCAN', 'PASTE', 'SWAP'], 'two pills: SCAN / PASTE / SWAP');
    const t = textOf(w);
    ok(t.indexOf(v.homeMintName) >= 0 && /MINT/.test(t) && /42\.05/.test(t) && /50,000/.test(t) && /SWAP/.test(t), 'the page draws the heading, both pills and SWAP');
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
    W.st.choice = { hold: 'dollars', recv: 'usd', send: 'usd' };
    W.st.sat = 0;
    await fresh(W, { balSats: 0 });
    const d = V();
    eq(d.homePillRows.map((p) => p.sym), ['$'], 'Dollars: one frost pill');
    eq(d.homeButtonsTwo.map((b) => b.label), ['SCAN', 'PASTE'], 'one pill: no SWAP button');
    ok(d.menuItems.some((m) => m.label === 'SWAP'), 'one pill: SWAP is a row in the menu');
    // money held is never hidden
    W.st.sat = 1200;
    await fresh(W, { balSats: 1200 });
    eq(V().homePillRows.map((p) => p.sym), ['$', '₿'], 'bitcoin held while holding Dollars keeps its pill');
    // bitcoin only
    W.st.choice = { hold: 'bitcoin', recv: 'sat', send: 'sat' };
    W.st.usd = 0;
    await fresh(W);
    eq(V().homePillRows.map((p) => p.sym), ['₿'], 'Bitcoin: one fur pill');
    // offline: SWAP dimmed, and says why
    const off = twoWallet({ choice: { hold: 'both' }, online: false });
    await fresh(off);
    const sw = V().homeButtonsTwo.find((b) => b.label === 'SWAP');
    eq(sw.dim, '0.38', 'offline: SWAP is dimmed');
    sw.tap();
    eq(toasts.pop(), 'Swapping needs the mint.', 'offline: a tap on SWAP says it needs the mint');
  }

  // ---- 3. the last first step: WHAT DO YOU WANT TO HOLD? ---------------------------------------
  {
    const W = twoWallet();
    await fresh(W);
    A.offerHoldChoice();
    await settle();
    eq(A.state.screen, 'holdChoice', 'two balances, never asked: the hold question comes up on home');
    const v = V();
    ok(v.isHoldChoice, 'the hold screen is drawn');
    eq(v.holdRows.map((h) => h.name), ['DOLLARS', 'BITCOIN', 'BOTH'], 'Dollars / Bitcoin / Both');
    ok(/WHAT DO YOU/.test(textOf(w)) && /WANT TO HOLD\?/.test(textOf(w)) && /LAST STEP/.test(textOf(w)), 'its words');
    v.holdDone();
    ok(toasts.pop() === 'Pick one first.' && A.state.screen === 'holdChoice', 'DONE with nothing picked does nothing but say so');
    V().holdRows[0].tap();
    eq(V().holdRows.map((h) => h.outline !== 'none'), [true, false, false], 'a pick is outlined');
    V().holdDone();
    await settle();
    eq(W.rec.sets.pop(), { hold: 'dollars' }, 'DONE writes the choice');
    ok(A.state.screen === 'home' && W.st.choice.recv === 'usd' && W.st.choice.send === 'usd', 'Dollars sets both remembered balances; home');
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

  // ---- 4. CURRENCY, once per kind of flow; 5. what is remembered ------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both' } });
    await fresh(W);
    V().goReceive();
    await settle();
    eq([A.state.screen, A.state.currencyFlow], ['currency', 'receive'], 'the first receive: CURRENCY first');
    const v = V();
    eq([v.curTitle, v.curQuestion], ['CURRENCY', 'What do you want to receive?'], 'its title and question');
    eq(v.curCards.map((k) => [k.name, k.balance]), [['DOLLARS', '$ 42.05'], ['BITCOIN', '₿ 50,000']], 'two big cards with the balances');
    v.curCards[0].tap();
    await settle();
    ok(A.state.screen === 'amount' && A.state.wallet === 'usd' && A.state.unit === 'USD', 'DOLLARS: SET AMOUNT, typing dollars');
    eq(W.rec.sets.pop(), { recv: 'usd' }, 'the pick is remembered for receiving');
    A.back(); await settle();
    V().goReceive();
    await settle();
    eq(A.state.screen, 'amount', 'the second receive: no CURRENCY');
    A.setState({ screen: 'home', stack: [] }); await settle();
    // a send: CURRENCY before CONFIRM PAYMENT, then never again
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-invoice');
    await settle();
    eq([A.state.screen, A.state.currencyFlow, A.state.currencyNext], ['currency', 'send', 'sendConfirm'], 'the first send: CURRENCY before CONFIRM PAYMENT');
    eq(V().curQuestion, 'What do you want to send?', 'asked as a send');
    V().curCards[1].tap();
    await settle();
    eq(A.state.screen, 'sendConfirm', 'BITCOIN: on to CONFIRM PAYMENT');
    eq(W.rec.sets.pop(), { send: 'sat' }, 'remembered for sending');
  }

  // ---- 7. the keypad for dollars --------------------------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' } });
    await fresh(W);
    V().goReceive();
    await settle();
    ['5', '0', '0'].forEach((k) => A.press(k));
    await settle();
    const v = V();
    eq(v.amountDisplay, '$ 5.00', 'dollars typed as cents: $ 5.00');
    eq(A.wantedAmount(), { unit: 'usd', amount: 500 }, 'which is 500 cents, exactly');
    eq(v.swapVis, 'hidden', 'no ₿ toggle in a dollars receive');
    eq(v.amountSub, '', 'no second figure: nothing converts');
    // a send over both balances is MORE THAN YOUR BALANCE; over the remembered one only, the other pays
    const W2 = twoWallet({ choice: { hold: 'both', send: 'usd' }, usd: 200 });
    await fresh(W2);
    A.setState({ screen: 'amount', stack: ['home'], flow: 'send', unit: 'USD', amount: '10.00',
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
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' }, usdLife: 1300 });
    await fresh(W);
    V().goReceive();
    await settle();
    ['5', '0', '0'].forEach((k) => A.press(k));
    V().next();
    await settle(); await wait(40);
    const inv = W.rec.invoices[0];
    eq([inv.amount, inv.opts], [500, { unit: 'usd' }], 'the invoice is a mint quote in dollars, for 500 cents');
    const v = V();
    ok(v.recvHeadTwo && v.recvChipsTwo && !v.recvChipsOne, 'the title between the round buttons; WALLET and NETWORK chips');
    eq([v.recvWalletWord, v.confirmNetwork], ['USD', 'LIGHTNING'], 'WALLET USD, NETWORK LIGHTNING');
    eq([v.confirmAmount, v.showSats], ['$ 5.00', false], 'the amount is the cents, with no sats line');
    ok(v.recvTapShown === true && v.recvCardShown === true, 'TAP and CARD on a dollar invoice (the card pays the invoice’s sats: tests/flashcard-usd-receive.js)');
    {
      // the same screen a moment earlier, before the mint had made the invoice: no sats to pay yet, so no CARD
      const was = A.state;
      A.state = Object.assign({}, was, { invoice: '', invoiceHash: '' });
      const before = V();
      A.state = was;
      eq([before.recvTapShown, before.recvCardShown], [true, false], 'and before the invoice is there, TAP and no CARD');
    }
    eq(A.tapOffering(), { inv: W.rec.invoices[0].inv.bolt11, req: '', waiting: false },
      'the dollar invoice goes on the air (its request in dollars beside it is tests/usd-tap-screens.js)');
    ok(v.recvClockShown && /^NEW CODE IN 0:0\d$/.test(v.recvClock), 'the code’s minute counted down under it (' + v.recvClock + ')');
    const t = textOf(w);
    ok(/RECEIVE INVOICE/.test(t) && /WALLET/.test(t) && /USD/.test(t) && />CARD</.test(w.document.getElementById('dc-root').innerHTML), 'the page draws it, CARD with it');
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
    // paid: ADDED TO DOLLARS, and remembered
    W.rec.sets.length = 0;
    W.rec.watches[1].onPaid({ hash: W.rec.invoices[1].inv.hash, unit: 'usd', amount: 500, sats: 0 });
    await settle();
    const p = V();
    eq(A.state.screen, 'paid', 'paid');
    eq([p.paidHeadline, p.paidHeadlineSub, p.paidAddedLabel, p.paidAddedTo], ['$ 5.00', '', 'ADDED TO', 'DOLLARS'], 'PAYMENT RECEIVED $ 5.00, ADDED TO DOLLARS');
    ok(/ADDED TO/.test(textOf(w)) && /DOLLARS/.test(textOf(w)) && !/Cash Balance/.test(textOf(w)), 'never "Cash Balance"');
    eq(W.rec.sets.pop(), { recv: 'usd' }, 'the receive’s balance is remembered');
    clearInterval(A._recvClockT);
  }

  // ---- WALLET chip on the invoice: changed, remembered, and a new code in it -------------------
  {
    const W = twoWallet({ choice: { hold: 'both', recv: 'sat', send: 'sat' } });
    await fresh(W);
    V().goReceive();
    await settle();
    ['5', '0', '0'].forEach((k) => A.press(k));
    V().next();
    await settle();
    eq(W.rec.invoices[0].opts, null, 'bitcoin: the invoice is asked as it always was (sats)');
    const v = V();
    eq([v.recvWalletWord, v.recvTapShown, v.recvClockShown], ['BITCOIN', true, false], 'WALLET BITCOIN; tap and card offered; no clock');
    A.recvSwitchWallet('usd');
    await settle();
    eq(W.rec.sets.pop(), { recv: 'usd' }, 'the chip’s change is remembered at once');
    const last = W.rec.invoices[W.rec.invoices.length - 1];
    eq([last.amount, last.opts], [500, { unit: 'usd' }], 'and a new code in dollars for the same $ 5.00');
    eq(V().recvWalletWord, 'USD', 'the chip reads USD');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }

  // ---- 9. CONFIRM PAYMENT, the WALLET button, the picker, the switch --------------------------
  {
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' } });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-maya');
    await settle(); await settle();
    eq(A.state.screen, 'sendConfirm', 'an invoice: CONFIRM PAYMENT');
    ok(W.rec.quotes.length === 1, 'both balances quoted at once (quoteFeeBoth)');
    let v = V();
    eq([v.cfTitle, v.cfTitleUp, v.cfAmountLabel], ['CONFIRM PAYMENT', true, 'TOTAL'], 'CONFIRM PAYMENT, the title up, TOTAL on top');
    eq(v.cfRows.map((r) => r.label), ['TO', 'AMOUNT', 'FEE INCLUDED', 'NETWORK', 'RATE'], 'TO, AMOUNT, FEE INCLUDED, NETWORK, and RATE (dollars pay bitcoin)');
    const cents = Math.ceil(6112 / 1e8 * MINT_RATE * 100);
    eq(v.cfAmount, '$ ' + ((cents + 2) / 100).toFixed(2), 'TOTAL is the dollar melt with its fee');
    eq(v.cfRows[1].sub, '(₿ 6,112)', 'AMOUNT says what the payee is paid in sats');
    eq(v.cfRows[4].value, '₿ 1 = $ 76,900 · FORGE.EXAMPLE.COM’s rate'.replace('FORGE.EXAMPLE.COM', A.mintName()), 'RATE: the mint’s');
    ok(v.cfRows.every((r) => r.cursor === 'default'), 'NETWORK and the rows are not selectable');
    eq([v.cfWalletShown, v.cfWalletWord, v.cfCtaLabel], [true, 'USD', 'PAY'], 'the WALLET button last, reading USD; PAY');
    ok(/CONFIRM PAYMENT/.test(textOf(w)) && /FEE INCLUDED/.test(textOf(w)) && /WALLET/.test(textOf(w)), 'the page draws it');
    // the picker
    v.cfWalletGo();
    await settle();
    v = V();
    eq([A.state.screen, v.curTitle], ['walletPick', 'WALLET'], 'WALLET opens the picker');
    ok(/^Pay .* from$/.test(v.curQuestion), 'Pay … from');
    eq(v.curCards.map((k) => k.tagShown), [false, false], 'both cover it: nothing greyed');
    v.curCards[1].tap();
    await settle();
    ok(A.state.screen === 'sendConfirm' && A.state.wallet === 'sat' && A.state.walletTapped, 'BITCOIN picked by hand');
    eq(W.rec.sets.pop(), { send: 'sat' }, 'and remembered at once');
    v = V();
    eq(v.cfRows.map((r) => r.label), ['TO', 'AMOUNT', 'FEE INCLUDED', 'NETWORK'], 'bitcoin pays bitcoin: no RATE row');
    v.cfGo();
    await settle(); await wait(700); await settle();
    eq(W.rec.pays[0].unit, 'sat', 'pay is called with the bitcoin balance');
    eq(W.rec.pays[0].quote, 'q-sat', 'with that balance’s own quote');
    eq(V().sentFrom, 'FROM BITCOIN', 'sent: FROM BITCOIN');
  }

  // ---- the automatic switch: once, said, and not remembered ------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' }, usd: 200 });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-ten');
    await settle(); await settle();
    ok(A.state.wallet === 'sat' && A.state.walletAuto === true, 'dollars ($ 2.00) cannot cover it: bitcoin pays');
    eq(toasts.filter((m) => m === 'Bitcoin was chosen for you').length, 1, '"Bitcoin was chosen for you", once');
    eq(W.rec.sets.length, 0, 'the remembered balance is not changed by the switch');
    V().cfWalletGo();
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
    const W = twoWallet({ choice: { hold: 'both', send: 'usd' }, usd: 200, sat: 100 });
    await fresh(W, { balSats: 100 });
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-big');
    await settle(); await settle();
    const v = V();
    eq([v.cfCtaLabel, v.cfAmountInk], ['NOT ENOUGH', '#FF5C5C'], 'neither covers it: TOTAL red, NOT ENOUGH');
    eq(v.cfChip, 'Neither balance covers this. You hold $ 2.00 and ₿ 100.', 'and says what is held');
    v.cfWalletGo(); await settle();
    eq(V().curCards.map((k) => k.tagShown), [true, true], 'both greyed in the picker');
  }

  // ---- the mint's price moved: back to CONFIRM PAYMENT, asked again, nothing sent -------------
  {
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' } });
    const realPay = W.pay;
    let refusals = 0;
    W.pay = function (bolt11, onStage, popts) {
      if (refusals === 0) {
        refusals += 1;
        const e = new Error('The mint’s price moved: this payment now needs $ 1.96 with its fee, not the $ 1.56 you confirmed. Nothing was sent.');
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
    await settle(); await settle();
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
    W.tokensNotClaimed = () => Promise.resolve([
      { unit: 'usd', amount: 300, sats: null }, { unit: 'sat', amount: 1200, sats: 1200 }]);
    W.clearHistory = () => {};
    let card = null;
    const realCard = A.blockedCard;
    A.blockedCard = (kind, over) => { card = { kind, over }; };
    await fresh(W);
    A.askClear('history'); A.askClear('history');
    await settle();
    A.blockedCard = realCard;
    ok(card && card.kind === 'unclaimedTokens', 'two unclaimed tokens: the UNCLAIMED ECASH card');
    ok(card && /2 tokens you sent, \$3\.00 and 1,200 sats, have not been claimed/.test(card.over.reason),
      'it says $3.00 and 1,200 sats, never one figure added across units', card && card.over.reason);
  }

  // ---- 10. sent from dollars; a dollar token -------------------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' } });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-coffee');
    await settle(); await settle();
    V().cfGo();
    await settle(); await wait(700); await settle();
    eq(W.rec.pays[0].unit, 'usd', 'pay is called with {unit: \'usd\'}');
    eq(W.rec.pays[0].quote, 'q-usd', 'with the dollar quote, never the other');
    const s = V();
    const cents = Math.ceil(6112 / 1e8 * MINT_RATE * 100);
    eq([s.sentFrom, s.sentHeadline, s.sentHeadlineSub], ['FROM DOLLARS', '$ ' + ((cents + 1) / 100).toFixed(2), '₿ 6,112 delivered'],
      'sent: FROM DOLLARS, the dollars that left, the sats delivered under');
    ok(/FROM DOLLARS/.test(textOf(w)), 'the page says FROM DOLLARS');
    eq(W.rec.sets.pop(), { send: 'usd' }, 'the send’s balance is remembered');
    // a token in dollars
    await fresh(W);
    A.setState({ screen: 'amount', stack: ['home'], flow: 'send', tokenMode: true, unit: 'USD', amount: '5.00' });
    await settle();
    A.makeEcashToken();
    await settle(); await settle();
    eq(W.rec.tokens[0], { amount: 500, opts: { unit: 'usd' } }, 'MAKE ECASH from dollars: sendToken(500, {unit:\'usd\'})');
    const tk = V();
    eq([A.state.screen, tk.tokenAmount, tk.tokenShowAlt], ['tokenOut', '$ 5.00', false], 'the token screen: $ 5.00, no sats line');
    // offline the wallet makes it from dollar pieces on hand (or says why not), and it is shown to be scanned
    const off = twoWallet({ choice: { hold: 'both', send: 'usd' }, online: false });
    await fresh(off);
    A.setState({ screen: 'amount', stack: ['home'], flow: 'send', tokenMode: true, unit: 'USD', amount: '5.00' });
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
    eq([v.histAuditTitle, v.histAuditBody], ['ADDS UP', 'Every cent of your $ 42.05 is accounted for by the payments below.'], 'the dollars add up on their own tab');
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
  }

  // ---- 12. what dollars can and cannot do, said in words --------------------------------------
  {
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' } });
    await fresh(W);
    A.openRequest('creqA-usd');
    eq([A.state.screen, A.state.wallet], ['reqOffer', 'usd'], 'a NUT-18 request in dollars at this mint opens its offer, paid from dollars');
    A.setState({ screen: 'home', stack: [], req: null }); await settle();
    eq(A.tapUnitRule({ unit: 'usd', amount: 500, sats: null }), '', 'a tap’s request in dollars is paid');
    eq(A.tapUnitRule({ unit: 'sat', amount: 500, sats: 500 }), '', 'a request in sats is paid as before');
    eq(A.tapUnitRule({ unit: 'eur', amount: 500, sats: null }), 'That request asks for EUR, which Foxy cannot pay over tap.', 'any other unit is refused in words');
    const offer = A.tapOfferOf(JSON.stringify({ v: 2, req: 'creqA-usd' }));
    ok(!!(offer && !offer.notSats && offer.sameMint && !offer.asksUsd), 'a tap offering a dollar request at this mint is paid in dollars, with no price asked');
    /* CARD on a dollar invoice: the card is tapped for the invoice's own sats (6,112 here), and never for a figure
     * priced on this phone; the whole flow is tests/flashcard-usd-receive.js. */
    const runs = [];
    const start0 = A.fcPayStart;
    A.fcPayStart = (...a) => { runs.push(a); };
    W.cardSession = () => Promise.reject(new Error('no card in this suite'));
    const off0 = A.offlineNow;
    A.offlineNow = () => false;
    A.setState({ screen: 'confirm', flow: 'receive', recvUnit: 'usd', wallet: 'usd', invoice: 'lnbcusd9', invoiceHash: 'q-usd9', recvAmount: 500 });
    A.payByCard();
    eq(runs.map((a) => [a[0], a[4] && a[4].bolt11, a[4] && a[4].cents]), [[6112, 'lnbcusd9', 500]],
      'CARD on a dollar invoice taps the card for the invoice’s own 6,112 sats, for the 500 cents asked');
    A.setState({ invoice: 'not an invoice' });
    A.payByCard();
    eq([runs.length, toasts.pop()], [1, 'The invoice is still being made.'], 'and with no sats named on the code, the card is not tapped');
    A.offlineNow = () => true;
    A.setState({ invoice: 'lnbcusd9' });
    A.payByCard();
    ok(runs.length === 1 && /^A card payment needs a connection/.test(toasts.pop() || ''), 'offline, a card payment needs a connection, as in bitcoin');
    A.fcPayStart = start0;
    A.offlineNow = off0;
    delete W.cardSession;
    A.setState({ screen: 'home', stack: [], wallet: 'usd' });
    A.payThisMintWithToken(2100);
    ok(/Dollars need the mint/.test(toasts.pop() || ''), 'offline token to this mint from dollars: "Dollars need the mint"');
  }

  /* ---- a second look: the rules the owner set, checked from the other side --------------------
   *
   * Hold Bitcoin and hold Both as the first step answers them, the two remembered balances kept
   * apart, the automatic switch not carried into the next payment, the keypad of a payment to an
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
    ok(W.st.choice.recv === 'sat' && W.st.choice.send === 'sat', 'Bitcoin sets both remembered balances to bitcoin');
    const v = V();
    eq(v.homePillRows.map((p) => p.sym), ['₿'], 'Bitcoin, nothing in dollars: one fur pill');
    eq(v.homeButtonsTwo.map((b) => b.label), ['SCAN', 'PASTE'], 'and SCAN / PASTE, no SWAP');
    ok(v.menuItems.some((m) => m.label === 'SWAP') && v.menuItems.some((m) => m.label === 'WHAT YOU HOLD'), 'SWAP and WHAT YOU HOLD are menu rows');
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
    // Both: two pills, and each kind of flow asks once, on its own
    const W = twoWallet();
    await fresh(W);
    A.offerHoldChoice(); await settle();
    V().holdRows[2].tap(); V().holdDone(); await settle();
    eq(W.rec.sets.pop(), { hold: 'both' }, 'Both is written as the choice');
    ok(W.st.choice.recv === '' && W.st.choice.send === '', 'Both leaves the two remembered balances unset');
    eq(V().homePillRows.map((p) => p.sym), ['$', '₿'], 'Both: two pills');
    V().goReceive(); await settle();
    eq(A.state.screen, 'currency', 'Both: the first receive asks');
    V().curCards[0].tap(); await settle();
    A.setState({ screen: 'home', stack: [] }); await settle();
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-both-first-send');
    await settle();
    eq(A.state.screen, 'currency', 'the receive’s answer is not the send’s: the first send still asks');
    V().curCards[1].tap(); await settle();
    ok(W.st.choice.recv === 'usd' && W.st.choice.send === 'sat', 'two remembered balances, apart: receive dollars, send bitcoin');
    // CURRENCY's back arrow: nothing remembered, so it asks again next time
    A.setState({ screen: 'home', stack: [] }); await settle();
    W.st.choice.send = '';
    W.rec.sets.length = 0;
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-both-back');
    await settle();
    eq(A.state.screen, 'currency', 'asked again while nothing is remembered');
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
    // MENU › WHAT YOU HOLD asks it again, with the answer given outlined
    W.st.choice.hold = 'dollars';
    V().menuItems.find((m) => m.label === 'WHAT YOU HOLD').tap(); await settle();
    eq([A.state.screen, V().holdRows.map((h) => h.outline !== 'none')], ['holdChoice', [true, false, false]], 'MENU › WHAT YOU HOLD: the question, Dollars outlined');
  }
  {
    // the automatic switch is this payment's only: the next one starts from the remembered balance
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' }, usd: 200 });
    await fresh(W);
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-auto-once');
    await settle(); await settle();
    eq(A.state.wallet, 'sat', 'dollars short: bitcoin pays this one');
    A.setState({ screen: 'home', stack: [] }); await settle();
    ok(A.state.wallet === '' && !A.state.walletAuto && A.walletNow('send') === 'usd', 'home: the next payment starts from DOLLARS again');
    toasts = [];
    W.st.usd = 4205; A.refreshUsd();
    A.setState({ screen: 'sendHow', stack: ['home'], flow: 'send' });
    A.acceptTarget('lnbcsat-auto-twice');
    await settle(); await settle();
    ok(V().cfWalletWord === 'USD' && toasts.indexOf('Bitcoin was chosen for you') < 0, 'dollars that cover it pay it, with no toast');
  }
  {
    // a payment to an address in dollars converts (an address is asked in sats): the ⇅ still works
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' } });
    await fresh(W);
    A.setState({ screen: 'amount', stack: ['home', 'sendHow'], flow: 'send', unit: 'USD', amount: '5.00',
      recipient: 'maya@flash.example', recipientKind: 'email' });
    await settle();
    eq(V().swapVis, 'visible', 'paying an address from dollars: the ⇅ toggle is there');
    A.toggleUnit(); await settle();
    eq(A.state.unit, 'SATS', 'and a tap on it puts the keypad in sats, and it stays there');
    ok(Number(A.state.amount) > 0, 'with the amount converted, not cleared (' + A.state.amount + ')');
    // a dollar receive: the toggle refuses in words and the keypad stays in dollars
    A.setState({ screen: 'home', stack: [] }); await settle();
    V().goReceive(); await settle();
    toasts = [];
    A.toggleUnit(); await settle();
    ok(A.state.unit === 'USD' && toasts.pop() === 'Dollars are typed in dollars.', 'a dollar receive: the ⇅ refuses, in dollars still');
    // offline, a dollar receive cannot be asked for
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    const W = twoWallet({ choice: { hold: 'both', recv: 'usd', send: 'usd' }, online: false });
    await fresh(W);
    V().goReceive(); await settle();
    ['5', '0', '0'].forEach((k) => A.press(k));
    toasts = [];
    V().next(); await settle();
    ok(A.state.screen === 'confirm' && A.state.recvRail === 'CASHU' && A.state.recvUnit === 'usd' && W.rec.invoices.length === 0,
      'offline: NEXT on a dollar receive opens it on CASHU (a request in dollars), and asks the mint for nothing');
    eq([V().confirmNetwork, V().recvClockShown, V().recvTapShown], ['CASHU', false, true], 'offline: NETWORK CASHU, no clock, TAP armed');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // a bitcoin receive at a mint with two: ADDED TO BITCOIN, and bitcoin remembered for receiving
    const W = twoWallet({ choice: { hold: 'both', recv: 'sat', send: 'usd' } });
    await fresh(W);
    V().goReceive(); await settle();
    ['5', '0', '0'].forEach((k) => A.press(k));
    V().next(); await settle();
    W.rec.sets.length = 0;
    const wt = W.rec.watches[W.rec.watches.length - 1];
    wt.onPaid({ hash: wt.hash, unit: 'sat', amount: 6250, sats: 6250 });
    await settle();
    const p = V();
    eq([A.state.screen, p.paidAddedLabel, p.paidAddedTo], ['paid', 'ADDED TO', 'BITCOIN'], 'bitcoin paid: ADDED TO BITCOIN');
    ok(!/Cash Balance|Bitcoin Balance/.test(textOf(w)), 'never "Bitcoin Balance" at a mint with two');
    eq(W.rec.sets.pop(), { recv: 'sat' }, 'bitcoin remembered for receiving');
    ok(W.st.choice.send === 'usd', 'and the send’s balance left alone');
    A.stopReceive();
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // a link into a receive (foxy=receive) starts it from the remembered balance, not a send's pick
    const W = twoWallet({ choice: { hold: 'both', recv: 'sat', send: 'sat' } });
    await fresh(W);
    A.setState({ screen: 'sendConfirm', stack: ['home'], flow: 'send', wallet: 'usd', walletTapped: true });
    w.location.hash = '#foxy=receive';
    A.applyDeepLink(); await settle();
    ok(A.state.screen === 'amount' && A.state.flow === 'receive' && A.walletNow('receive') === 'sat',
      'a link to RECEIVE: the remembered bitcoin, not the dollars a send had picked');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }
  {
    // holding dollars, the roads that are bitcoin only stay bitcoin: on chain and transfer are typed as today
    const W = twoWallet({ choice: { hold: 'dollars', recv: 'usd', send: 'usd' } });
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
    ok(A.state.screen === 'sendConfirm' && v.cfWalletShown === false && v.cfTitleUp === false, 'one balance: no WALLET button, the title where it was');
    ok(v.cfRows.every((r) => r.label !== 'RATE') && W.rec.quotes.length === 0, 'one balance: no RATE, and no quote of both');
    eq(V().sentFromShown, false, 'one balance: the sent screen has no FROM line');
    A.setState({ screen: 'history', stack: ['home'] }); await settle();
    eq([V().histTabsShown, V().histTabs.length], [false, 0], 'one balance: history has no DOLLARS / BITCOIN tab');
    A.setState({ screen: 'home', stack: [] }); await settle();
  }

  const errs = errors.filter((e) => !/never resolved|Not implemented/.test(e));
  ok(!errs.length, 'no errors on the page', errs.slice(0, 3).join(' | '));
  console.log('');
  console.log(failed ? failed + ' of ' + (passed + failed) + ' two-balance screen checks failed' : 'all ' + passed + ' two-balance screen checks pass');
  process.exit(failed ? 1 : 0);
})();
