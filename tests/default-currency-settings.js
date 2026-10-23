'use strict';
/* default-currency-settings.js — no default currency: nothing is remembered for a receive or a send.
 *
 *     node tests/default-currency-settings.js
 *
 * The owner, 2026-10-22: "the default of receiving in dollars or bitcoin or sending in bitcoin or dollars should
 * be removed, if user has multiple balances they should be asked each receive and send what they want to receive
 * or send from". So the RECEIVE IN and SEND IN rows that were in SETTINGS are gone, and the wallet keeps no balance
 * for either kind of flow (build/wallet/16b-two-balances.js `walletChoice`, `setWalletChoice`): only what the
 * person holds. This suite used to pin those rows; it now pins their absence and what stands in their place.
 *
 * The real page, rendered in jsdom by build/foxy-render.js as tests/two-balances-screens.js renders it, on a
 * stand-in wallet whose walletChoice and setWalletChoice are the real wallet's (tests/harness.js `loadReal`),
 * so what a tap writes is read back from the real wallet's own storage. Checked:
 *   - no RECEIVE IN or SEND IN row anywhere: one balance, holding dollars, bitcoin, both, or never asked
 *   - holding both: every receive asks on CURRENCY, the pick is this receive's only, nothing is written, and the
 *     next receive asks again; the same for WALLET on a send
 *   - a receive or send balance an older build left in storage is not read
 *   - holding one: the receive is in it with no question (home shows one balance)
 *   - walletChoice's recv and send are what the hold makes them, nothing else; WHAT YOU HOLD writes the hold only
 *   - the wallet refuses to keep a receive or send balance, and anything else it does not know, writing nothing */
process.env.TZ = 'UTC';
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { loadReal } = require('./harness');
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

// ---- the stand-in wallet: the real wallet's choice, the rest answered here ----------------------
const MINT = 'https://forge.example.com';
const PRICE = 80000;

/* A fresh real wallet for each scenario, its storage seeded with a hold and the two values as the
 * wallet itself writes them (setWalletChoice), so nothing here guesses at its storage format. */
function realChoice(choice) {
  const ctx = loadReal();
  const c = choice || {};
  if (c.hold) ctx.W.setWalletChoice({ hold: c.hold });
  // what an older build kept, written straight into storage: the wallet no longer writes it
  if (c.recv) ctx.storage.setItem('foxy.wallet.recv', JSON.stringify(c.recv));
  if (c.send) ctx.storage.setItem('foxy.wallet.send', JSON.stringify(c.send));
  return ctx;
}
const store = (ctx) => {
  const o = {};
  for (let i = 0; i < ctx.storage.length; i++) o[ctx.storage.key(i)] = ctx.storage.getItem(ctx.storage.key(i));
  return o;
};
// what changed in a storage, key by key
const changed = (before, after) => Object.keys(Object.assign({}, before, after)).filter((k) => before[k] !== after[k]).sort();

function twoWallet(o) {
  const opt = Object.assign({ units: ['sat', 'usd'], sat: 50000, usd: 4205 }, o || {});
  const real = opt.real;
  const sets = [];
  let n = 0;
  const W = {
    connected: true,
    mintUrl: MINT,
    mintHost: () => 'forge.example.com',
    mints: () => [MINT],
    qr: (text) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)),
    classify: (t) => (/^lnbc/.test(t) ? 'invoice' : /@/.test(t) ? 'lnurl' : 'unknown'),
    amountOf: (inv) => (/^lnbc/.test(String(inv)) ? 6112 : null),
    tagsFor: () => ({}),
    tag() {},
    backedUp: () => true,
    pinIsSet: () => false,
    reason: (e) => String((e && e.message) || e),
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: opt.sat, mint: MINT }].concat(opt.units.indexOf('usd') >= 0 ? [{ unit: 'usd', amount: opt.usd, mint: MINT }] : []),
    balanceAt: () => opt.sat,
    balanceSats: () => Promise.resolve(opt.sat),
    rate: () => Promise.resolve(PRICE),
    agreedRate: () => Promise.resolve(PRICE),
    transactions: () => Promise.resolve([]),
    book: () => [],
    remember() {},
    listen: () => () => {},
    privacy: () => ({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false, network: 'wifi', orbot: 'none', vpn: false }),
    mintUnits: () => opt.units.slice(),
    twoUnits: () => opt.units.indexOf('sat') >= 0 && opt.units.indexOf('usd') >= 0,
    // the real wallet's, so what is written is what the wallet keeps
    walletChoice: () => real.W.walletChoice(),
    setWalletChoice(p) { sets.push(Object.assign({}, p)); return real.W.setWalletChoice(p); },
    balanceOf: (u) => (u === 'usd' ? opt.usd : opt.sat),
    heldIn: () => 0,
    recoveringIn: () => 0,
    invoice(amount, memo, opts) {
      const unit = (opts && opts.unit) || 'sat';
      n += 1;
      return Promise.resolve({ bolt11: 'lnbc' + unit + n, hash: 'hash-' + unit + '-' + n, unit, amount,
        sats: unit === 'sat' ? amount : 0, mint: MINT, expiresIn: 600, expiresAt: null });
    },
    watch: () => () => {},
    quoteFee: () => new Promise(() => {}),
    quoteFeeBoth: () => new Promise(() => {}),
    payNeed: (amount, reserve, popts) => ({ ok: true, need: amount + reserve, have: opt.sat, fee: reserve, unit: (popts && popts.unit) || 'sat', why: '' }),
    lastToken: () => ({}),
    clearLastToken() {},
    pendingMelts: () => [],
    splitPending: () => null,
  };
  W.sets = sets;
  W.real = real;
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
  let toasts = [];
  A.toast = (m) => { toasts.push(String(m)); };
  const V = () => A.renderVals();
  // a clean slate, the wallet given, and home with the drawer and SETTINGS open
  const fresh = async (W, state) => {
    w.FoxyWallet = W;
    const patch = {};
    for (const k of Object.keys(A.state)) if (!(k in initial)) patch[k] = undefined;
    A._lastPay = null; A._paying = null; A._feeQuotes = null; A._quotedFor = null; A._holdLater = false;
    clearTimeout(A._holdT); A.stopReceive();
    toasts = [];
    A.setState(Object.assign(patch, initial, { walletLive: true, balSats: 50000, balUsdCents: null, livePrice: PRICE,
      satUsd: PRICE / 1e8, screen: 'home', stack: [], open0: true, menuSettingsOpen: true }, state || {}));
    A.refreshUsd();
    await settle();
  };
  const labels = () => V().menuItems.map((m) => m.label);
  const row = (label) => V().menuItems.find((m) => m.label === label);
  const noRows = () => !row('RECEIVE IN') && !row('SEND IN') && !/RECEIVE IN|SEND IN/.test(textOf(w));
  const home = async () => { A.setState({ screen: 'home', stack: [], flow: '', open0: false }); await settle(); };

  // ---- 1. the rows are nowhere ------------------------------------------------------------------
  {
    const W = twoWallet({ units: ['sat'], real: realChoice({ hold: 'both' }) });
    await fresh(W);
    ok(labels().indexOf('SET PIN') >= 0, 'one balance: SETTINGS is open (SET PIN is there)');
    ok(noRows(), 'one balance: no RECEIVE IN or SEND IN');
    eq(A.walletNow('receive'), 'sat', 'one balance: a receive is in bitcoin');
  }
  for (const hold of ['dollars', 'bitcoin', 'both', '']) {
    const W = twoWallet({ real: realChoice({ hold }) });
    await fresh(W);
    ok(labels().indexOf('SET PIN') >= 0 && noRows(), 'two balances, holding ' + (hold || 'nothing chosen') + ': no RECEIVE IN or SEND IN in SETTINGS');
  }
  {
    const W = twoWallet({ real: realChoice({ hold: 'both' }) });
    await fresh(W);
    const l = labels();
    ok(l.indexOf('FACE / FINGER LOCK') >= 0 && l.indexOf('FACE / FINGER LOCK') + 1 === l.indexOf('SET PIN'),
      'holding both: SET PIN follows the two switches straight away', l.join(', '));
  }

  // ---- 2. holding both: every receive asks, and nothing is kept ------------------------------
  {
    const real = realChoice({ hold: 'both' });
    const W = twoWallet({ real });
    for (const [i, pick] of [[1, 'sat'], [2, 'usd'], [3, 'sat']]) {
      await fresh(W, { open0: false });
      const before = store(real);
      V().goReceive();
      await settle();
      eq([A.state.screen, A.state.currencyFlow], ['currency', 'receive'], 'receive ' + i + ': asked on CURRENCY');
      A.currencyPick(pick);
      await settle();
      ok(A.state.screen === 'amount' && A.walletNow('receive') === pick && (pick !== 'usd' || A.state.unit === 'USD'),
        'receive ' + i + ': ' + pick + ' picked, SET AMOUNT in it', JSON.stringify([A.state.screen, A.walletNow('receive'), A.state.unit]));
      eq(changed(before, store(real)), [], 'receive ' + i + ': the pick writes nothing');
      await home();
      eq(A.walletNow('receive'), '', 'receive ' + i + ': back home, no balance is left for the next receive');
    }
    eq(W.sets, [], 'no setWalletChoice on the way');
    eq(toasts, [], 'no toast on the way');
  }

  // ---- 3. WALLET on a send: this payment's only ----------------------------------------------
  {
    const real = realChoice({ hold: 'both' });
    const W = twoWallet({ real });
    await fresh(W, { open0: false });
    const before = store(real);
    A.setState({ screen: 'walletPick', stack: ['home', 'sendConfirm'], flow: 'send' });
    await settle();
    A.walletPickChoose('usd');
    await settle();
    eq(A.walletNow('send'), 'usd', 'DOLLARS picked on WALLET: this send is in dollars');
    eq(changed(before, store(real)), [], 'and nothing is written');
    await home();
    eq(A.walletNow('send'), '', 'back home: the next send is not started in dollars');
    eq(W.sets, [], 'no setWalletChoice');
  }

  // ---- 4. what an older build kept is not read -------------------------------------------------
  {
    const real = realChoice({ hold: 'both', recv: 'usd', send: 'sat' });
    const W = twoWallet({ real });
    eq(real.W.walletChoice(), { hold: 'both', recv: '', send: '' }, 'a kept recv and send are not read back');
    await fresh(W, { open0: false });
    eq([A.walletNow('receive'), A.walletNow('send')], ['', ''], 'neither starts a flow');
    V().goReceive();
    await settle();
    eq([A.state.screen, A.state.currencyFlow], ['currency', 'receive'], 'a receive still asks');
    await home();
  }

  // ---- 5. holding one: no question, the receive is in it -------------------------------------
  for (const [hold, unit, bal] of [['dollars', 'usd', { sat: 0 }], ['bitcoin', 'sat', { usd: 0 }]]) {
    const W = twoWallet(Object.assign({ real: realChoice({ hold }) }, bal));
    await fresh(W, Object.assign({ open0: false }, hold === 'dollars' ? { balSats: 0, balUsdCents: 4205 } : { balUsdCents: 0 }));
    eq(A.homePills(), [unit], 'holding ' + hold + ' with nothing in the other: home shows one balance');
    V().goReceive();
    await settle();
    ok(A.state.screen === 'amount' && A.walletNow('receive') === unit, 'holding ' + hold + ': a receive opens SET AMOUNT in ' + unit + ', with no CURRENCY',
      JSON.stringify([A.state.screen, A.walletNow('receive')]));
    await home();
  }

  // ---- 6. WHAT YOU HOLD: the hold, and recv/send only as the hold makes them ------------------
  {
    const real = realChoice({ hold: 'both' });
    const W = twoWallet({ real });
    await fresh(W);
    const before = store(real);
    row('WHAT YOU HOLD').tap();
    await settle();
    eq([A.state.screen, A.state.holdPick], ['holdChoice', 'both'], 'MENU › WHAT YOU HOLD opens on Both');
    A.holdDone();
    await settle();
    eq(changed(before, store(real)), [], 'Both again, DONE: nothing written');
    eq(real.W.walletChoice(), { hold: 'both', recv: '', send: '' }, 'Both: no one balance');
    row('WHAT YOU HOLD').tap(); await settle();
    const b2 = store(real);
    A.setState({ holdPick: 'bitcoin' }); await settle();
    A.holdDone(); await settle();
    eq(changed(b2, store(real)), ['foxy.wallet.hold'], 'Bitcoin instead: only the hold is written');
    eq(real.W.walletChoice(), { hold: 'bitcoin', recv: 'sat', send: 'sat' }, 'and its one balance is bitcoin');
    A.setState({ screen: 'holdChoice', stack: ['home'], holdPick: 'both' }); await settle();
    A.holdDone(); await settle();
    eq(real.W.walletChoice(), { hold: 'both', recv: '', send: '' }, 'then Both, from Bitcoin: no one balance again');
    eq(toasts, [], 'no toast on the way');
  }

  // ---- 7. the wallet refuses what it does not keep or know -------------------------------------
  {
    const real = realChoice({ hold: 'both' });
    for (const bad of [{ recv: 'usd' }, { send: 'sat' }, { recv: 'eur' }, { send: 'btc' }, { recv: '' }, { hold: 'both', send: 'usd' }, { hold: 'some' }]) {
      const before = store(real);
      let threw = false;
      try { real.W.setWalletChoice(bad); } catch (e) { threw = true; }
      ok(threw && changed(before, store(real)).length === 0, 'refused, nothing written: ' + JSON.stringify(bad));
    }
    eq(real.W.walletChoice(), { hold: 'both', recv: '', send: '' }, 'the choice is as it was');
  }

  const errs = errors.filter((e) => !/never resolved|Not implemented/.test(e));
  ok(!errs.length, 'no errors on the page', errs.slice(0, 3).join(' | '));
  console.log('');
  console.log(failed ? failed + ' of ' + (passed + failed) + ' no-default-currency checks failed' : 'all ' + passed + ' no-default-currency checks pass');
  process.exit(failed ? 1 : 0);
})();
