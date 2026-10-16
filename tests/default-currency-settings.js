'use strict';
/* default-currency-settings.js — RECEIVE IN and SEND IN, the two rows inside SETTINGS.
 *
 *     node tests/default-currency-settings.js
 *
 * At a mint with two balances, a receive and a send each start in a balance the wallet remembers
 * (build/wallet/16b-two-balances.js `walletChoice`, `setWalletChoice`): the last one that kind of flow used,
 * or '' and the CURRENCY screen asks. The two rows in SETTINGS (build/app/21-render-values.js) show those two
 * values and set them, a tap flipping between DOLLARS and BITCOIN. They are only there while the person
 * holds both: holding one sets both values to it, and the rows would say otherwise.
 *
 * The real page, rendered in jsdom by build/foxy-render.js as tests/two-balances-screens.js renders it, on a
 * stand-in wallet whose walletChoice and setWalletChoice are the real wallet's (tests/harness.js `loadReal`),
 * so what a tap writes is read back from the real wallet's own storage. Checked:
 *   - no rows at a mint with one balance, nor while holding only dollars or only bitcoin
 *   - with Both, the two rows after the two switches and before SET PIN, each with its word: ASK, DOLLARS, BITCOIN
 *   - a tap flips the word, drawn at once, and writes that flow's value and nothing else; the drawer stays
 *     open, no toast
 *   - walletNow follows the rows; a receive opened after a flip starts in that balance, with no CURRENCY
 *   - a tap flips from the value kept, even on a row drawn before it changed
 *   - a balance picked in a flow (CURRENCY, WALLET) moves the row's word, as it always moved what was remembered
 *   - WHAT YOU HOLD answered Both again keeps both values; another answer still sets them as before
 *   - a value the wallet does not know is refused, and nothing is written */
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
  if (c.recv) ctx.W.setWalletChoice({ recv: c.recv });
  if (c.send) ctx.W.setWalletChoice({ send: c.send });
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
  const words = () => [row('RECEIVE IN'), row('SEND IN')].map((r) => (r ? r.value : null));

  // ---- 1. where the rows are not --------------------------------------------------------------
  {
    const W = twoWallet({ units: ['sat'], real: realChoice({ hold: 'both' }) });
    await fresh(W);
    ok(labels().indexOf('SET PIN') >= 0, 'one balance: SETTINGS is open (SET PIN is there)');
    ok(!row('RECEIVE IN') && !row('SEND IN'), 'one balance: no RECEIVE IN or SEND IN');
    ok(!/RECEIVE IN|SEND IN/.test(textOf(w)), 'one balance: neither is drawn');
    eq(A.walletNow('receive'), 'sat', 'one balance: a receive is in bitcoin');
  }
  for (const hold of ['dollars', 'bitcoin']) {
    const W = twoWallet({ real: realChoice({ hold }) });
    await fresh(W);
    ok(!row('RECEIVE IN') && !row('SEND IN') && !/RECEIVE IN|SEND IN/.test(textOf(w)),
      'holding ' + hold + ': no RECEIVE IN or SEND IN (WHAT YOU HOLD already set both)');
  }
  {
    const W = twoWallet({ real: realChoice() });
    await fresh(W);
    ok(!row('RECEIVE IN') && !row('SEND IN'), 'two balances, never asked what to hold: no rows');
    await fresh(W, { menuSettingsOpen: false });
    ok(!row('RECEIVE IN'), 'SETTINGS closed: no rows');
  }

  // ---- 2. holding both: the rows, where and what they say ------------------------------------
  {
    const W = twoWallet({ real: realChoice({ hold: 'both' }) });
    await fresh(W);
    const l = labels();
    const at = (x) => l.indexOf(x);
    ok(at('RECEIVE IN') >= 0 && at('SEND IN') >= 0, 'holding both: RECEIVE IN and SEND IN are rows');
    ok(at('FACE / FINGER LOCK') < at('RECEIVE IN') && at('RECEIVE IN') + 1 === at('SEND IN') && at('SEND IN') + 1 === at('SET PIN'),
      'after the two switches, before SET PIN', l.join(', '));
    const r = row('RECEIVE IN');
    ok(r.indent === '10px' && r.hasSwitch === false && r.hasChev === false, 'indented as SETTINGS rows are, with no switch or chevron');
    eq(words(), ['ASK', 'ASK'], 'never set: both read ASK');
    ok(/RECEIVE IN\s*ASK/.test(textOf(w)) && /SEND IN\s*ASK/.test(textOf(w)), 'the page draws each word at the end of its row');
    eq(row('AUTO TAP TO PAY').value, '', 'the other rows carry no word');

    W.real.W.setWalletChoice({ recv: 'usd' });
    W.real.W.setWalletChoice({ send: 'sat' });
    await fresh(W);
    eq(words(), ['DOLLARS', 'BITCOIN'], 'the words follow the wallet: DOLLARS, BITCOIN');
    ok(/RECEIVE IN\s*DOLLARS/.test(textOf(w)) && /SEND IN\s*BITCOIN/.test(textOf(w)), 'and are drawn');
  }

  // ---- 3. a tap flips, and writes that flow's value only --------------------------------------
  for (const [label, flow, key, other] of [['RECEIVE IN', 'receive', 'recv', 'send'], ['SEND IN', 'send', 'send', 'recv']]) {
    const real = realChoice({ hold: 'both' });
    const W = twoWallet({ real });
    await fresh(W);
    const otherBefore = real.W.walletChoice()[other];
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const before = store(real);
      row(label).tap();
      await settle();
      const after = store(real);
      const c = real.W.walletChoice();
      seen.push([row(label).value, c[key], A.walletNow(flow)]);
      // what is drawn, not only what renderVals would say: the tap must redraw the row
      ok(new RegExp(label + '\\s*' + row(label).value).test(textOf(w)), label + ' tap ' + (i + 1) + ': the drawn row reads '
        + row(label).value + ' at once', textOf(w).slice(textOf(w).indexOf(label), textOf(w).indexOf(label) + 40));
      eq(changed(before, after), ['foxy.wallet.' + key], label + ' tap ' + (i + 1) + ': only foxy.wallet.' + key + ' is written');
      ok(c.hold === 'both' && c[other] === otherBefore, label + ' tap ' + (i + 1) + ': the hold and the other flow untouched');
    }
    eq(seen, [['DOLLARS', 'usd', 'usd'], ['BITCOIN', 'sat', 'sat'], ['DOLLARS', 'usd', 'usd']],
      label + ': ASK → DOLLARS (dollars first) → BITCOIN → DOLLARS, and walletNow(\'' + flow + '\') follows');
    eq(W.sets, [{ [key]: 'usd' }, { [key]: 'sat' }, { [key]: 'usd' }], label + ': each tap one setWalletChoice({ ' + key + ' })');
    ok(A.state.open0 === true && A.state.menuSettingsOpen === true && A.state.screen === 'home', label + ': the drawer and SETTINGS stay open');
    eq(toasts, [], label + ': no toast');
  }

  // ---- 4. the next flow starts where the row says ---------------------------------------------
  {
    const W = twoWallet({ real: realChoice({ hold: 'both' }) });
    await fresh(W);
    row('RECEIVE IN').tap(); await settle();
    eq(row('RECEIVE IN').value, 'DOLLARS', 'RECEIVE IN set to DOLLARS');
    A.setState({ open0: false }); await settle();
    V().goReceive();
    await settle();
    ok(A.state.screen === 'amount' && A.state.currencyFlow !== 'receive', 'a receive after the tap: SET AMOUNT, no CURRENCY', A.state.screen);
    ok(A.walletNow('receive') === 'usd' && A.state.unit === 'USD', 'the receive is in dollars, typed in dollars', A.state.unit);
    A.setState({ screen: 'home', stack: [], flow: '', wallet: '' }); await settle();
    // and the other way
    await fresh(W);
    row('RECEIVE IN').tap(); await settle();
    eq(row('RECEIVE IN').value, 'BITCOIN', 'RECEIVE IN flipped to BITCOIN');
    A.setState({ open0: false }); await settle();
    V().goReceive();
    await settle();
    ok(A.state.screen === 'amount' && A.walletNow('receive') === 'sat', 'a receive after the flip: SET AMOUNT, in bitcoin', A.state.screen);
    A.setState({ screen: 'home', stack: [], flow: '', wallet: '' }); await settle();
    // this payment's own pick still comes first
    await fresh(W, { wallet: 'usd' });
    ok(A.walletNow('receive') === 'usd' && row('RECEIVE IN').value === 'BITCOIN', 'a balance picked for this payment comes before the row');
  }

  // ---- 5. a balance used in a flow moves the row's word ---------------------------------------
  {
    const W = twoWallet({ real: realChoice({ hold: 'both' }) });
    await fresh(W, { open0: false });
    V().goReceive();
    await settle();
    eq([A.state.screen, A.state.currencyFlow], ['currency', 'receive'], 'RECEIVE IN at ASK: the first receive asks on CURRENCY');
    A.currencyPick('sat');
    await settle();
    await fresh(W);
    eq(words(), ['BITCOIN', 'ASK'], 'BITCOIN picked on CURRENCY: RECEIVE IN reads BITCOIN, SEND IN still ASK');
    // WALLET on CONFIRM PAYMENT, picked by hand
    A.setState({ screen: 'walletPick', stack: ['home', 'sendConfirm'], flow: 'send', open0: false });
    await settle();
    A.walletPickChoose('usd');
    await settle();
    await fresh(W);
    eq(words(), ['BITCOIN', 'DOLLARS'], 'DOLLARS picked on WALLET: SEND IN reads DOLLARS');
    A.rememberWallet('receive', 'usd');
    await fresh(W);
    eq(words(), ['DOLLARS', 'DOLLARS'], 'a receive that used dollars: RECEIVE IN reads DOLLARS');
  }

  // ---- 4b. a tap flips from what is kept, not from what the row drew -------------------------
  for (const [label, key] of [['RECEIVE IN', 'recv'], ['SEND IN', 'send']]) {
    const real = realChoice({ hold: 'both' });
    const W = twoWallet({ real });
    await fresh(W);
    const drawn = row(label);
    eq(drawn.value, 'ASK', label + ': drawn at ASK');
    real.W.setWalletChoice({ [key]: 'usd' });   // kept elsewhere, with no redraw
    drawn.tap();
    await settle();
    eq(real.W.walletChoice()[key], 'sat', label + ': a tap on the row drawn at ASK, the wallet now at dollars, flips to bitcoin');
    eq(row(label).value, 'BITCOIN', label + ': and reads BITCOIN');
  }

  // ---- 5b. WHAT YOU HOLD answered again ---------------------------------------------------------
  {
    const real = realChoice({ hold: 'both', recv: 'usd', send: 'sat' });
    const W = twoWallet({ real });
    await fresh(W);
    eq(words(), ['DOLLARS', 'BITCOIN'], 'set by hand: DOLLARS, BITCOIN');
    const before = store(real);
    row('WHAT YOU HOLD').tap();
    await settle();
    eq([A.state.screen, A.state.holdPick], ['holdChoice', 'both'], 'MENU › WHAT YOU HOLD opens on Both');
    A.holdDone();
    await settle();
    eq(changed(before, store(real)), [], 'Both again, DONE: nothing written');
    eq(real.W.walletChoice(), { hold: 'both', recv: 'usd', send: 'sat' }, 'Both again keeps both balances');
    await fresh(W);
    eq(words(), ['DOLLARS', 'BITCOIN'], 'and the rows still read DOLLARS, BITCOIN');
    // a different answer is still written, and sets both, as it always did
    row('WHAT YOU HOLD').tap(); await settle();
    A.setState({ holdPick: 'bitcoin' }); await settle();
    A.holdDone(); await settle();
    eq(real.W.walletChoice(), { hold: 'bitcoin', recv: 'sat', send: 'sat' }, 'Bitcoin instead: both set to bitcoin');
    A.setState({ screen: 'holdChoice', stack: ['home'], holdPick: 'both' }); await settle();
    A.holdDone(); await settle();
    eq(real.W.walletChoice(), { hold: 'both', recv: '', send: '' }, 'then Both, from Bitcoin: cleared, each flow asks once');
    await fresh(W);
    eq(words(), ['ASK', 'ASK'], 'and the rows read ASK');
    eq(toasts, [], 'no toast on the way');
  }

  // ---- 6. the wallet refuses what it does not know ---------------------------------------------
  {
    const real = realChoice({ hold: 'both', recv: 'usd', send: 'sat' });
    for (const bad of [{ recv: 'eur' }, { send: 'btc' }, { recv: '' }, { send: 'USD' }, { recv: 'usd', send: 'sats' }, { hold: 'some' }]) {
      const before = store(real);
      let threw = false;
      try { real.W.setWalletChoice(bad); } catch (e) { threw = true; }
      ok(threw && changed(before, store(real)).length === 0, 'refused, nothing written: ' + JSON.stringify(bad));
    }
    eq(real.W.walletChoice(), { hold: 'both', recv: 'usd', send: 'sat' }, 'the choice is as it was');
  }

  const errs = errors.filter((e) => !/never resolved|Not implemented/.test(e));
  ok(!errs.length, 'no errors on the page', errs.slice(0, 3).join(' | '));
  console.log('');
  console.log(failed ? failed + ' of ' + (passed + failed) + ' default currency checks failed' : 'all ' + passed + ' default currency checks pass');
  process.exit(failed ? 1 : 0);
})();
