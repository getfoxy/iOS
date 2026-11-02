'use strict';
/* till-ui.js — the till (point of sale), as a person sees it.
 *
 *     node tests/till-ui.js
 *
 * A phone in the till can only RECEIVE and look at the HISTORY of the session (build/app/26m-till.js). The keeper opens and
 * closes it behind the lock it already has; a cashier joins by scanning the keeper's CASHIER CODE, takes payments locked to
 * the keeper's key and sent to the keeper, and leaves with no PIN. The wallet's half is tests/till-wallet.js; this is the
 * screens over a stand-in wallet:
 *
 *   1  the gate: no lock says SET A LOCK FIRST; a face that says yes goes through; a PIN, wrong and then right
 *   2  POINT OF SALE and CASHIER CODE are rows under SETTINGS, and only there
 *   3  the keeper's till: SET AMOUNT in receive, its X and HISTORY, no menu, no scan, no paste, no balance, no home
 *   4  every road home ends at the till's SET AMOUNT: closeReceive, dismissPending, PAID's DISMISS, a card's CLOSE, Back with
 *      nothing behind it, a flow's own `screen: 'home'`, a mint answering again (walletReady)
 *   5  HISTORY in the till: from `since`, money in only, a cashier's till rows only and whether each reached the keeper;
 *      no filters, no books, no tabs, and a row opens nothing
 *   6  the cashier: a code scanned asks WORK THE TILL? with the mint and the words; START joins; one run out or of this phone
 *      is said no to
 *   7  receiving as a cashier: requests and invoices locked to the keeper's key and named for the till, in the keeper's
 *      unit, no on chain, no CARD, no WALLET sheet, a token to the till's own way in; nothing paid from the till
 *   8  the cashier's clock: a code run out leaves with "The cashier code has expired"
 *   9  closing: the keeper's asks the lock, the cashier's asks only whether
 *   10 a cashier's till comes back after a relaunch, a keeper's does not; and the inbox and outbox are asked on wake
 *   11 CASHIER CODE: the code on the stage screen with its expiry, and its error
 *   12 the tap and the edge swipes treat the till's SET AMOUNT as home; links are not followed in the till
 *   13 a card in the till: a card tapped to the phone opens nothing on any till screen, either role (review u1); no road to
 *      the card's screens (goFlashcard, fcShow, RESTORE LOST CARD); a cashier's receive takes no card; a screen the till
 *      has none of is turned into its SET AMOUNT
 *   14 a code run out that the wallet noticed first (and went home on): out of the till, home, the toast, and the mint's
 *      own balance and history asked again
 *   15 a code run out in the middle of a payment: the till stays until the receive screen, or PAID, is left
 *   16 CASHIER CODE shown twice is the same live code the wallet answers, with its own expiry
 *
 * The real page, rendered in jsdom by build/foxy-render.js, as tests/default-currency-settings.js renders it. Run
 * `python3 tools/pack-index.py` first: this reads build/foxy-app.js. */
process.env.TZ = 'UTC';
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { loadReal } = require('./harness');

let failed = 0;
let passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name,
  'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 120000).unref();

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

// ---- the stand-in wallet ------------------------------------------------------------------------
const MINT = 'https://forge.example.com';
const KEEPER_MINT = 'https://keeper.example.org';
const OWN_MINT = 'https://own.example.net';
const PRICE = 80000;
const LOCK = '02' + 'ab'.repeat(32);
const NPROFILE = 'nprofile1' + 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passOf = (o) => Object.assign({ v: 1, id: '0123456789abcdef', mint: KEEPER_MINT, unit: 'sat', lock: LOCK, to: NPROFILE,
  exp: Math.floor(Date.now() / 1000) + 72 * 3600 }, o || {});
const codeOf = (pass) => 'https://getfoxy.io/till#' + b64url(JSON.stringify(pass));
/* The code is read by the real wallet's own reader (build/wallet/08d-till.js: `classify`, `tillDecode`, `tillProblem`), so
 * what these screens are handed is what the phone would hand them. */
const REAL = loadReal().W;

function stubWallet(o) {
  const opt = Object.assign({ pin: '', face: false, faceSays: 'yes' }, o || {});
  const calls = { requests: [], invoices: [], joins: [], leaves: 0, listens: 0, delivers: 0, taken: [], scans: 0, primes: 0,
    biometric: [], pays: 0, passMakes: 0 };
  const W = {
    connected: true,
    mintUrl: MINT,
    mintHost() { return String(W.mintUrl).replace(/^https?:\/\//, ''); },
    mints: () => [MINT],
    qr: (text) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)),
    classify: (t) => (REAL.classify(t) === 'till' ? 'till' : /^cashu[AB]/.test(t) ? 'token'
      : /^lnbc/.test(t) ? 'invoice' : /^creq/.test(t) ? 'request' : 'unknown'),
    amountOf: (inv) => (/^lnbc/.test(String(inv)) ? 6112 : null),
    tagsFor: () => ({}),
    tag() {},
    backedUp: () => true,
    // the lock: a PIN, a face, both or neither (22-screen-lock.js)
    pinIsSet: () => !!opt.pin,
    faceLock: () => !!opt.face,
    screenLocked: () => !!opt.pin || !!opt.face,
    secureChoice: () => (opt.face ? 'device' : 'none'),
    biometric(reason, passcode) { calls.biometric.push([reason, passcode]); return Promise.resolve(opt.faceSays); },
    pinAttempt: (pin) => ({ ok: !!opt.pin && pin === opt.pin, waitMs: 0 }),
    pinCheck: (pin) => !!opt.pin && pin === opt.pin,
    reason: (e) => String((e && e.message) || e),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: 50000, mint: MINT }],
    balanceAt: () => 50000,
    balanceSats: () => Promise.resolve(50000),
    balanceOf: (u) => (u === 'usd' ? 0 : 50000),
    rate: () => Promise.resolve(PRICE),
    agreedRate: () => Promise.resolve(PRICE),
    rows: [],
    transactions: () => Promise.resolve(W.rows.slice()),
    book: () => [],
    remember() {},
    listen: () => () => {},
    privacy: () => ({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false, network: 'wifi', orbot: 'none', vpn: false }),
    mintUnits: () => ['sat'],
    twoUnits: () => false,
    walletChoice: () => ({ hold: '' }),
    heldIn: () => 0,
    recoveringIn: () => 0,
    primeLocks() { calls.primes += 1; return Promise.resolve(1); },
    openInbox: () => Promise.reject(new Error('no inbox here')),
    closeInbox() {},
    paymentRequest(amount, popts) { calls.requests.push({ amount, opts: Object.assign({}, popts) }); return 'creqA' + calls.requests.length; },
    invoice(amount, memo, iopts) {
      calls.invoices.push({ amount, memo, opts: iopts === undefined ? undefined : Object.assign({}, iopts) });
      const unit = (iopts && iopts.unit) || 'sat';
      return Promise.resolve({ bolt11: 'lnbc' + unit + calls.invoices.length, hash: 'hash-' + calls.invoices.length, unit, amount,
        sats: unit === 'sat' ? amount : 0, mint: W.mintUrl, expiresIn: 600, expiresAt: null });
    },
    watch: () => () => {},
    defaultRail: () => opt.rail || 'LIGHTNING',
    lastToken: () => ({}),
    clearLastToken() {},
    pendingMelts: () => [],
    splitPending: () => null,
    stopPreview() {}, stopPasteButton() {},
    scan() { calls.scans += 1; return Promise.resolve(opt.scanned || ''); },
    // tap to pay: the payer's listen counts as a payment it would make
    tapReceive: () => Promise.resolve(),
    tapReceiveStop() {},
    tapPay() { calls.pays += 1; return new Promise(() => {}); },
    tapPayStop() {},
    // ---- the till's contract (build/wallet/08d-till.js, the brief's names) ----
    tillDecode: (t) => REAL.tillDecode(t),
    tillProblem: (t) => REAL.tillProblem(t),
    passes: [],
    tillPasses() { return W.passes.slice(); },
    // as the wallet answers: the newest code still live, and a new one only when none is
    tillPassMake() {
      calls.passMakes += 1;
      if (opt.passFails) return Promise.reject(new Error('The phone could not make a key for the code.'));
      const live = W.passes.filter((x) => Number(x.exp) * 1000 > Date.now());
      const p = live.length ? live[live.length - 1] : passOf({ id: 'fedcba9876543210' });
      if (!live.length) W.passes.push(p);
      return Promise.resolve({ text: codeOf(p), id: p.id, exp: p.exp });
    },
    tillListen() { calls.listens += 1; return Promise.resolve(0); },
    tillDeliver() { calls.delivers += 1; return Promise.resolve(0); },
    cashier: null,
    tillCashier() { return W.cashier; },
    tillJoin(pass) {
      calls.joins.push(pass);
      if (opt.joinFails) return Promise.reject(new Error('That mint did not answer.'));
      W.cashier = { pass, since: Date.now() };
      W.mintUrl = pass.mint;
      // as the wallet answers: { pass, since }
      return Promise.resolve({ pass: pass, since: W.cashier.since });
    },
    // as the wallet answers, and never a rejection
    tillLeave() { calls.leaves += 1; W.cashier = null; W.mintUrl = OWN_MINT; return Promise.resolve({ left: true, mint: KEEPER_MINT, home: OWN_MINT }); },
    tillTakeToken(t) { calls.taken.push(t); return Promise.resolve({ hash: 'till-tok-1', sats: 210, unit: 'sat' }); },
  };
  W.calls = calls;
  W.opt = opt;
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
  const card = () => (A._blockedEl && A._blockedEl.parentNode ? A._blockedEl.textContent : '');
  const shutCard = () => {
    if (A._blockedEl) A._blockedEl.remove();
    A._blockedEl = null; A._blockedKind = null; A._cardQueue = [];
  };
  // a button on the card or the stage, by its words
  const press = (root, label) => {
    const el = root && Array.prototype.slice.call(root.querySelectorAll('div')).filter((d) => d.textContent === label).pop();
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return true;
  };
  const typePin = async (pin) => {
    const pad = A._pinEl;
    for (const d of String(pin)) {
      const k = Array.prototype.slice.call(pad.querySelectorAll('div')).filter((x) => x.textContent === d && x.children.length === 1)[0];
      if (k) k.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    }
    press(pad, 'CONTINUE');
    await settle();
  };
  const pinUp = () => !!(A._pinEl && A._pinEl.parentNode);
  const stage = () => w.document.getElementById('foxy-stage');
  const fresh = async (W, state) => {
    w.FoxyWallet = W;
    const patch = {};
    for (const k of Object.keys(A.state)) if (!(k in initial)) patch[k] = undefined;
    shutCard();
    if (A._pinEl) A.pinDismiss();
    A.hideStage();
    // (the page's own timers, which are the page window's and not this process's)
    w.clearInterval(A._tillTickT); A._tillTickT = null;
    w.clearTimeout(A._tillRunOutT); A._tillRunOutT = null; A._tillRunOut = false; A._tillLeaving = null; A._paidDueAt = 0;
    // (and a confirmation an earlier scenario queued, which would land as PAID over this one's screen)
    A._paidQueue = []; w.clearTimeout(A._queueT);
    // (a road home's own later step, from the scenario before: dismissPending's PAID a second on)
    w.clearTimeout(A._sendA); w.clearTimeout(A._sendB);
    A._creqs = {};
    A.stopReceive();
    toasts = [];
    A.setState(Object.assign(patch, initial, { walletLive: true, balSats: 50000, balUsdCents: null, livePrice: PRICE,
      satUsd: PRICE / 1e8, screen: 'home', stack: [], open0: false, menuSettingsOpen: false, till: null, history: [] }, state || {}));
    await settle();
  };
  const tillAmount = () => A.state.screen === 'amount' && A.state.flow === 'receive' && (A.state.stack || []).length === 0;
  const keeperTill = async (W) => { await fresh(W); A.tillStart(); await settle(); };
  const cashierTill = async (W, pass) => {
    await fresh(W);
    const p = pass || passOf();
    W.cashier = { pass: p, since: Date.now() - 1000 };
    W.mintUrl = p.mint;
    A.setState(Object.assign({ till: { role: 'cashier', since: Date.now() - 1000, pass: p } }, A.homeState({ role: 'cashier', pass: p })));
    await settle();
    return p;
  };

  // ---- 1. the gate --------------------------------------------------------------------------------
  {
    const W = stubWallet({});
    await fresh(W);
    let through = 0;
    A.tillGate(() => { through += 1; }, 'To open the till.');
    await settle();
    ok(/SET A LOCK FIRST/.test(card()), 'no lock: SET A LOCK FIRST', card().slice(0, 60));
    ok(/SETTINGS > SET PIN or FACE \/ FINGER LOCK/.test(card()), 'and where to set one');
    eq(through, 0, 'and nothing opens');
  }
  {
    const W = stubWallet({ face: true, faceSays: 'yes' });
    await fresh(W);
    let through = 0;
    A.tillGate(() => { through += 1; }, 'To open the till.');
    await settle();
    eq(through, 1, 'Face ID says yes: through');
    ok(W.calls.biometric.length === 1 && W.calls.biometric[0][1] === true, 'with no PIN the phone’s passcode may stand in', JSON.stringify(W.calls.biometric));
    ok(!pinUp() && !card(), 'and nothing else is asked');
  }
  {
    const W = stubWallet({ face: true, faceSays: 'cancel', pin: '4321' });
    await fresh(W);
    let through = 0;
    A.tillGate(() => { through += 1; }, 'To open the till.');
    await settle();
    ok(pinUp() && /ENTER YOUR PIN/.test(A._pinEl.textContent) && /To open the till\./.test(A._pinEl.textContent),
      'a face that does not scan, with a PIN: the PIN pad, saying why');
    await typePin('1111');
    ok(pinUp() && through === 0 && /Wrong PIN/.test(A._pinEl.textContent), 'a wrong PIN: still asked, Wrong PIN');
    await typePin('4321');
    ok(!pinUp() && through === 1, 'the right PIN: through, the pad down');
  }
  {
    const W = stubWallet({ pin: '2468' });
    await fresh(W);
    let through = 0;
    A.tillGate(() => { through += 1; }, 'To open the till.');
    await settle();
    ok(pinUp() && W.calls.biometric.length === 0, 'a PIN with FACE / FINGER LOCK off: the pad, no face asked');
    await typePin('2468');
    eq(through, 1, 'and the PIN opens it');
  }

  // ---- 2. the rows ----------------------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await fresh(W, { open0: true, menuSettingsOpen: false });
    const labels = () => V().menuItems.map((m) => m.label);
    ok(labels().indexOf('POINT OF SALE') < 0 && labels().indexOf('CASHIER CODE') < 0, 'SETTINGS shut: neither row');
    A.setState({ menuSettingsOpen: true }); await settle();
    const l = labels();
    ok(l.indexOf('POINT OF SALE') > l.indexOf('SETTINGS') && l.indexOf('CASHIER CODE') === l.indexOf('POINT OF SALE') + 1,
      'SETTINGS open: POINT OF SALE then CASHIER CODE, under it', l.join(', '));
    ok(V().menuItems.find((m) => m.label === 'POINT OF SALE').indent === '10px', 'indented as SETTINGS rows are');
    ok(/POINT OF SALE/.test(textOf(w)) && /CASHIER CODE/.test(textOf(w)), 'and drawn in the drawer');
    V().menuItems.find((m) => m.label === 'POINT OF SALE').tap();
    await settle();
    ok(pinUp() && !A.state.open0, 'POINT OF SALE: the drawer shuts and the lock is asked');
    await typePin('2468');
    ok(A.state.till && A.state.till.role === 'keeper' && tillAmount(), 'past the lock: the keeper’s till, on SET AMOUNT');
  }

  // ---- 3. the keeper's till -----------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await keeperTill(W);
    const v = V();
    ok(v.isAmount && !v.isHome, 'the till: SET AMOUNT, not home');
    eq([A.state.flow, v.amountTitle, v.amountSubtitle], ['receive', 'SET AMOUNT', 'How much to receive?'], 'in receive, titled SET AMOUNT');
    eq(v.amtBackPath, 'M6 6l12 12M18 6L6 18', 'the top left is an X');
    ok(v.amtHistShown && !v.hideSkip, 'HISTORY at the top right');
    const t = textOf(w);
    ok(/SET AMOUNT/.test(t) && !/MENU/.test(t) && !/PASTE/.test(t) && !/SCAN/.test(t), 'drawn: no MENU, no SCAN, no PASTE', t.slice(0, 120));
    ok(!/50,000/.test(t), 'and no balance');
    ok(!!w.document.querySelector('[aria-label="History"]'), 'the HISTORY button is drawn');
    w.document.querySelector('[aria-label="History"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    eq([A.state.screen, A.state.stack], ['history', ['amount']], 'HISTORY opens this session’s list');
    A.back(); await settle();
    ok(tillAmount(), 'and back is the till again');
    // outside the till the same screen is as it was
    await fresh(W, { screen: 'amount', stack: ['home'], flow: 'receive', amount: '', unit: 'USD' });
    const v2 = V();
    ok(v2.amtBackPath === 'M19.5 12H5m0 0 6-6m-6 6 6 6' && !v2.amtHistShown && v2.hideSkip, 'outside the till: the back arrow, no HISTORY');
  }

  // ---- 4. every road home ends at the till ----------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    const roads = [
      ['closeReceive', async () => { A.setState({ screen: 'confirm', stack: ['amount'], amount: '5.00' }); await settle(); A.closeReceive(); }],
      ['dismissPending', async () => { A.setState({ screen: 'confirm', stack: ['amount'] }); await settle(); A.dismissPending(); await wait(450); }],
      ['PAID’s DISMISS', async () => { A.setState({ screen: 'paid', stack: [], recv: { live: 'in' }, recvResolved: true }); await settle(); V().dismissPaid(); await wait(560); }],
      ['a card’s CLOSE (blockedClose)', async () => { A.setState({ screen: 'confirm', stack: ['amount'] }); await settle(); V().blockedClose(); }],
      ['Back with nothing behind', async () => { A.setState({ screen: 'confirm', stack: [] }); await settle(); A.back(); }],
      ['a flow’s own screen: home', async () => { A.setState({ screen: 'home', stack: [] }); }],
      ['a mint answering again (walletReady)', async () => { try { A.walletReady({ name: 'forge.example.com' }); } catch (e) {} }],
    ];
    for (const [name, go] of roads) {
      await keeperTill(W);
      await go();
      await settle();
      ok(!!A.state.till && tillAmount(), name + ': the till’s SET AMOUNT', JSON.stringify([A.state.screen, A.state.flow, A.state.stack]));
    }
    // dismissPending's confirmation lands a second later: on the till, not home, and DISMISS brings it back
    await keeperTill(W);
    A.setState({ screen: 'confirm', stack: ['amount'] }); await settle();
    A.dismissPending();
    await wait(1500); await settle();
    eq(A.state.screen, 'paid', 'dismissPending: PAID a beat after the till');
    // home is never drawn: the render maps it before the state is put right
    await keeperTill(W);
    A.state.screen = 'home';
    const v = A.renderVals();
    ok(!v.isHome && v.isAmount, 'a render with screen home in the till draws SET AMOUNT');
    A.state.screen = 'amount';
  }

  // ---- 5. HISTORY in the till -------------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await keeperTill(W);
    const since = A.state.till.since;
    const at = (ms) => new Date(ms).toISOString();
    W.rows = [
      { hash: 'old-in', dir: 'in', sats: 900, at: at(since - 60000), settled: true, mint: MINT },
      { hash: 'new-in', dir: 'in', sats: 1200, at: at(since + 5000), settled: true, mint: MINT },
      { hash: 'new-out', dir: 'out', sats: 300, at: at(since + 6000), settled: true, mint: MINT },
      { hash: 'new-till', dir: 'in', sats: 700, at: at(since + 7000), settled: true, mint: MINT, till: true, who: 'cashier' },
    ];
    A.loadHistory(); await settle(); await settle();
    A.setState({ screen: 'history', stack: ['amount'] }); await settle();
    const v = V();
    const rows = v.historyGroups.reduce((a, g) => a.concat(g.items), []);
    // 1,200 and 700 sats at $ 80,000: $ 0.96 and $ 0.56
    eq(rows.map((r) => r.amtText.replace(/[^0-9.]/g, '')).sort(), ['0.56', '0.96'],'the keeper’s session: money in since it opened, nothing before, nothing out');
    eq([v.histTitle, v.histFilterShown, v.histAuditShown, v.histTabsShown, v.histClearVis], ['THIS SESSION', false, false, false, 'hidden'],
      'THIS SESSION: no filters, no books, no tabs, no clearing');
    ok(rows.every((r) => r.balText === ''), 'no running balance on a row');
    const before = JSON.stringify([A.state.screen, A.state.stack]);
    rows.forEach((r) => r.open());
    await settle();
    eq(JSON.stringify([A.state.screen, A.state.stack]), before, 'a row opens nothing');
    const t = textOf(w);
    ok(/THIS SESSION/.test(t) && !/RECEIVED/.test(t) && !/\bSENT\b/.test(t), 'drawn: THIS SESSION, no ALL / RECEIVED / SENT', t.slice(0, 160));
    ok(!/ADDS UP|DOES NOT ADD UP/.test(t), 'and no books');
  }
  {
    const W = stubWallet({});
    await cashierTill(W);
    const since = A.state.till.since;
    const at = (ms) => new Date(ms).toISOString();
    W.rows = [
      { hash: 'own-in', dir: 'in', sats: 5000, at: at(since + 2000), settled: true, mint: KEEPER_MINT },
      { hash: 't1', dir: 'in', sats: 410, at: at(since + 3000), settled: true, mint: KEEPER_MINT, till: true, who: 'cashier', tillSent: true, forKeeper: true },
      { hash: 't2', dir: 'in', sats: 520, at: at(since + 4000), settled: true, mint: KEEPER_MINT, till: true, who: 'cashier', tillSent: false, forKeeper: true },
    ];
    A.loadHistory(); await settle(); await settle();
    A.setState({ screen: 'history', stack: ['amount'] }); await settle();
    const rows = V().historyGroups.reduce((a, g) => a.concat(g.items), []);
    eq(rows.map((r) => r.line2).sort(), ['SENDING…', 'SENT TO KEEPER'].sort(), 'the cashier’s session: the till’s rows only, each sent or sending');
    ok(!/5,000/.test(textOf(w)), 'and none of this phone’s own money');
    // the books: the keeper's money was never this phone's, so 5,000 sats held are accounted for by the one row of its own
    A.setState({ balSats: 5000, historyComplete: true }); await settle();
    const au = A.histAudit();
    ok(au.whole && au.off === 0, 'this phone’s books leave the keeper’s rows out, and add up', JSON.stringify({ whole: au.whole, off: au.off }));
  }

  // ---- 6. the cashier joins ---------------------------------------------------------------------------
  {
    const W = stubWallet({});
    await fresh(W, { screen: 'sendScan', stack: ['home'], flow: 'send' });
    const pass = passOf();
    ok(A.acceptTarget(codeOf(pass)) === true, 'a cashier code scanned is taken');
    await settle();
    const c = card();
    ok(/WORK THE TILL\?/.test(c), 'WORK THE TILL?', c.slice(0, 40));
    ok(c.indexOf('keeper.example.org') >= 0, 'with the keeper’s mint');
    ok(/Money you take is locked to the keeper and sent to them\. This phone never holds it\./.test(c), 'what happens to the money');
    ok(/Your own money is hidden until you leave\./.test(c), 'and to this phone’s own');
    ok(/Expires [A-Z][a-z]{2}, \d{1,2}:\d{2} [AP]M/.test(c), 'and when it runs out', c);
    ok(/START/.test(c) && /BACK/.test(c), 'START, or BACK');
    eq(W.calls.joins.length, 0, 'nothing joined yet');
    press(A._blockedEl, 'START');
    await settle(); await settle();
    eq(W.calls.joins.length, 1, 'START joins through the wallet');
    ok(A.state.till && A.state.till.role === 'cashier' && A.state.till.pass.id === pass.id && tillAmount(), 'and this phone is the keeper’s till, on SET AMOUNT');
    ok(!stage(), 'the connecting screen is down');
    ok(A.state.till.since === W.cashier.since, 'the session from the wallet’s own moment of joining');
  }
  {
    const W = stubWallet({});
    await fresh(W, { screen: 'sendScan', stack: ['home'], flow: 'send' });
    A.acceptTarget(codeOf(passOf({ exp: Math.floor(Date.now() / 1000) - 5 })));
    await settle();
    ok(/THAT CODE WON’T WORK/.test(card()) && !A.state.till, 'a code run out: said no to, no till');
    ok(/That cashier code has expired\. Ask for a new one\./.test(card()), 'in the wallet’s words for it', card());
    shutCard();
    W.passes = [passOf()];
    A.acceptTarget(codeOf(passOf()));
    await settle();
    ok(/THIS PHONE’S OWN CODE/.test(card()) && !A.state.till, 'this phone’s own code: said no to');
    shutCard();
  }
  {
    const W = stubWallet({ joinFails: true });
    await fresh(W, { screen: 'sendScan', stack: ['home'], flow: 'send' });
    A.acceptTarget(codeOf(passOf()));
    await settle();
    press(A._blockedEl, 'START');
    await settle(); await settle();
    ok(!A.state.till && W.calls.leaves === 1 && toasts.some((m) => /did not answer/.test(m)), 'a join that fails: no till, the wallet’s row let go, said why');
  }

  // ---- 7. receiving as a cashier ----------------------------------------------------------------------
  {
    const W = stubWallet({});
    await cashierTill(W);
    eq(A.walletNow('receive'), 'sat', 'the keeper’s unit, sats');
    A.railRequest(1000);
    await settle();
    const r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && r.opts.lockPub === LOCK && r.opts.purpose === 'till', 'a request: locked to the keeper’s key, named for the till', JSON.stringify(r && r.opts));
    eq(W.calls.primes, 0, 'and no key is taken from this phone’s pool');
    A.tapOnlyRequest(1000);
    const t = W.calls.requests[W.calls.requests.length - 1];
    ok(t && t.opts.lockPub === LOCK && t.opts.purpose === 'till', 'a tap’s request: the same', JSON.stringify(t && t.opts));
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    A.openReceiveNow(); await settle();
    const inv = W.calls.invoices[W.calls.invoices.length - 1];
    ok(inv && inv.opts && inv.opts.lockPub === LOCK, 'an invoice: its ecash locked to the keeper’s key', JSON.stringify(inv && inv.opts));
    const v = V();
    eq(v.recvCardShown, false, 'no CARD at a cashier’s till');
    let sheet = 0;
    const was = A.chooseFrom;
    A.chooseFrom = (title, rows) => { sheet += 1; A._sheetRows = typeof rows === 'function' ? rows() : rows; };
    A.pickRecvWallet();
    eq(sheet, 0, 'WALLET opens no sheet of this phone’s balances');
    A.ocCan = () => true;
    A.chooseRail('LIGHTNING', () => {});
    ok(sheet === 1 && A._sheetRows.every((x) => x.label !== 'ON-CHAIN'), 'NETWORK offers no on chain', JSON.stringify((A._sheetRows || []).map((x) => x.label)));
    A.chooseFrom = was;
    delete A.ocCan;
    // the payer’s listen: never in the till
    A._tapPaying = null; A._tapGot = false; A._tapQuietUntil = 0;
    A.setState({ screen: 'amount', stack: [] }); await settle();
    const p0 = W.calls.pays;
    A.syncTap(); await settle();
    eq(W.calls.pays - p0, 0, 'the till never listens to pay a merchant');
  }
  {
    const W = stubWallet({});
    const p = await cashierTill(W, passOf({ unit: 'usd' }));
    eq(A.walletNow('receive'), 'usd', 'a dollar keeper: the cashier asks in dollars');
    ok(A.recvPicked('usd') && !A.recvPicked('sat'), 'picked for it, not asked');
    A.setState({ amount: '5.00', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    A.openReceiveNow(); await settle();
    const inv = W.calls.invoices[W.calls.invoices.length - 1];
    ok(inv && inv.opts && inv.opts.unit === 'usd' && inv.opts.lockPub === p.lock && inv.amount === 500, 'a dollar invoice: 500 cents, locked to the keeper', JSON.stringify(inv));
  }
  {
    const W = stubWallet({ scanned: 'cashuBo2F0gaJhaUgA' });
    await cashierTill(W);
    A.setState({ screen: 'confirm', stack: ['amount'] }); await settle();
    A.scanTokenToReceive(); await settle(); await settle();
    eq(W.calls.taken, ['cashuBo2F0gaJhaUgA'], 'SCAN on the receive screen: a token goes to the till’s own way in');
    ok(tillAmount() || A.state.screen === 'paid', 'and the receive screen closes onto the till');
    ok(A.acceptTarget('cashuBsecond') === true && W.calls.taken.length === 2, 'a token pasted: the same way in');
    ok(A.acceptTarget('lnbc1invoice') === false && toasts.some((m) => /The till only receives/.test(m)), 'an invoice: the till only receives');
    ok(A.acceptTarget('creqAsomething') === false, 'a payment request: the same');
    ok(A.acceptTarget(codeOf(passOf({ id: '1111111111111111' }))) === false && toasts.some((m) => /Leave the till first/.test(m)), 'another cashier code: leave the till first');
    // PAID on a cashier's phone says where the money went
    A.setState({ screen: 'paid', recv: { live: 'in' }, recvResolved: true, paidPlace: null, payOut: false }); await settle(); await settle();
    ok(A.state.paidPlace && A.state.paidPlace.to === 'THE KEEPER' && /SENT TO/.test(textOf(w)) && /THE KEEPER/.test(textOf(w)), 'PAID: SENT TO THE KEEPER, not into a balance here', textOf(w).slice(0, 160));
  }
  {
    const W = stubWallet({ pin: '2468' });
    await keeperTill(W);
    let pasted = '';
    A.takeTokenFromPaste = (t) => { pasted = t; };
    ok(A.acceptTarget('cashuBkeeper') === true && pasted === 'cashuBkeeper' && W.calls.taken.length === 0, 'the keeper’s till: a token into the keeper’s own wallet, as ever');
    delete A.takeTokenFromPaste;
    A.railRequest(800); await settle();
    const r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && !r.opts.lockPub && r.opts.purpose === 'receive', 'and its requests are this phone’s own', JSON.stringify(r && r.opts));
  }

  // ---- 8. the cashier's clock -------------------------------------------------------------------------
  {
    const W = stubWallet({});
    await cashierTill(W);
    ok(!!A._tillTickT, 'a cashier: the minute clock runs');
    await A.tillTick(); await settle();
    ok(!!A.state.till, 'a code still in date: nothing happens');
    W.cashier = null;
    await A.tillTick(); await settle(); await settle();
    ok(!A.state.till && A.state.screen === 'home', 'the code run out: out of the till, home');
    ok(toasts.indexOf('The cashier code has expired') >= 0, 'with "The cashier code has expired"', JSON.stringify(toasts));
    ok(W.calls.leaves === 1 && W.mintUrl === OWN_MINT, 'and back at this phone’s own mint');
    ok(!A._tillTickT, 'and the clock stops');
    await keeperTill(W);
    ok(!A._tillTickT, 'a keeper has no clock');
  }

  // ---- 9. closing --------------------------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await keeperTill(W);
    V().amtBack();
    await settle();
    ok(pinUp() && /To close the till\./.test(A._pinEl.textContent) && !!A.state.till, 'the keeper’s X: the lock is asked');
    await typePin('0000');
    ok(!!A.state.till, 'a wrong PIN: still in the till');
    await typePin('2468');
    ok(!A.state.till && A.state.screen === 'home', 'the right PIN: closed, home');
  }
  {
    const W = stubWallet({ face: true, faceSays: 'yes' });
    await keeperTill(W);
    V().amtBack();
    await settle(); await settle();
    ok(!A.state.till && W.calls.biometric.some((b) => /close the till/i.test(b[0])), 'Face ID: closed with a face');
  }
  {
    const W = stubWallet({ pin: '2468' });
    await cashierTill(W);
    V().amtBack();
    await settle();
    ok(!pinUp() && /LEAVE THE TILL\?/.test(card()), 'the cashier’s X: no PIN, LEAVE THE TILL?');
    ok(/Money already taken is still sent to the keeper\./.test(card()), 'saying the money still goes');
    press(A._blockedEl, 'BACK');
    await settle();
    ok(!!A.state.till && W.calls.leaves === 0, 'BACK: still in the till');
    V().amtBack(); await settle();
    press(A._blockedEl, 'LEAVE');
    await settle(); await settle();
    ok(!A.state.till && W.calls.leaves === 1 && A.state.screen === 'home', 'LEAVE: out, through the wallet, home');
  }

  // ---- 10. relaunch and wake --------------------------------------------------------------------------
  {
    const W = stubWallet({});
    await fresh(W);
    const p = passOf();
    const joined = Date.now() - 3600 * 1000;
    W.cashier = { pass: p, since: joined };
    W.mintUrl = OWN_MINT;
    const back = await A.tillResume();
    await settle();
    ok(back === true && A.state.till && A.state.till.role === 'cashier' && tillAmount(), 'a cashier’s till comes back after a relaunch');
    ok(W.calls.joins.length === 1 && W.mintUrl === KEEPER_MINT, 'onto the keeper’s mint first');
    ok(A.state.till.since === joined, 'its session from when it was joined');
  }
  {
    const W = stubWallet({});
    await fresh(W);
    const p = passOf();
    W.cashier = { pass: p, since: Date.now() };
    W.mintUrl = KEEPER_MINT;
    await A.tillResume(); await settle();
    ok(A.state.till && W.calls.joins.length === 0, 'already on the keeper’s mint: no join again');
  }
  {
    const W = stubWallet({ pin: '2468' });
    await fresh(W);
    const back = await A.tillResume();
    ok(back === false && !A.state.till, 'nothing on file (a keeper’s till is never kept): home');
    const l0 = W.calls.listens, d0 = W.calls.delivers;
    A.inboxWake();
    ok(W.calls.listens === l0 + 1 && W.calls.delivers === d0 + 1, 'on wake: the till’s inbox and outbox are asked');
  }

  // ---- 11. CASHIER CODE --------------------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await fresh(W);
    A.tillPassShow();
    await settle(); await settle();
    const s = stage();
    ok(s && s.getAttribute('data-stage') === 'tillPass' && /CASHIER CODE/.test(s.textContent), 'CASHIER CODE on the stage screen');
    ok(s && !!s.querySelector('[data-stage-qr]') && /^data:image/.test(s.querySelector('[data-stage-qr]').getAttribute('src') || ''), 'with the code drawn');
    ok(s && /Scan with Foxy\. Money they take is locked to this phone and sent here\./.test(s.textContent), 'and what it does');
    ok(s && /Expires [A-Z][a-z]{2}, /.test(s.textContent) && /DONE/.test(s.textContent), 'when it runs out, and DONE');
    ok(W.calls.passMakes === 1, 'made by the wallet');
    press(s, 'DONE'); await settle();
    ok(!stage(), 'DONE: down');
  }
  {
    const W = stubWallet({ pin: '2468', passFails: true });
    await fresh(W);
    A.tillPassShow();
    await settle(); await settle();
    ok(!stage() && /NO CASHIER CODE/.test(card()) && /Nothing was made\./.test(card()), 'a code that cannot be made: said, in the error card');
  }

  // ---- 12. the tap, the swipes, links -------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await keeperTill(W);
    A._tapAway = true; A._tapKeep = true; A._tapGot = true;
    A.syncTap(); await settle();
    ok(A._tapKeep === false && A._tapGot === false, 'a tap taken: let go on the till’s SET AMOUNT as on home');
    ok(A.fcSwipe('left') === false && A.state.screen === 'amount', 'the swipe to the card does nothing in the till');
    w.history.replaceState(null, '', '/index.html#foxy=send');
    ok(A.applyDeepLink() === true && tillAmount(), 'a link to SEND is not followed in the till');
    ok(!/foxy=/.test(w.location.hash), 'and is let go');
    const p0 = W.calls.pays;
    A.tillEnd(); A._tapPaying = null; A._tapGot = false; A._tapQuietUntil = 0;
    await settle();
    A.syncTap(); await settle();
    ok(W.calls.pays > p0, 'on home, outside the till, the phone still listens to pay', String(W.calls.pays - p0));
  }

  // ---- 13. a card in the till ----------------------------------------------------------------------------
  for (const role of ['keeper', 'cashier']) {
    for (const where of ['amount', 'history']) {
      const W = stubWallet({ pin: '2468' });
      if (role === 'keeper') await keeperTill(W); else await cashierTill(W);
      if (where === 'history') { A.go('history'); await settle(); }
      ok(A.state.screen === where && !!A.state.till, role + ', ' + where + ': the till’s screen is up', A.state.screen);
      A._cardTapAt = 0;
      A.cardTapped(); await settle(); await wait(300); await settle();
      ok(A.state.screen === where && !!A.state.till && !V().isFlashcard,
        role + ', ' + where + ': a card tapped to the phone opens nothing', JSON.stringify([A.state.screen, A.state.stack]));
      ok(!A._cardTapAt && !A._cardTapT, role + ', ' + where + ': and the tap is let go, not kept for later');
    }
  }
  {
    const W = stubWallet({ pin: '2468' });
    await keeperTill(W);
    eq(A.cardTapRule({ screen: 'history', till: true, over: '', locked: false, starting: false }), 'ignore', 'the rule: a free screen in the till is ignored');
    eq(A.cardTapRule({ screen: 'history', till: true, over: '', locked: true, starting: false }), 'ignore', 'and is not kept behind the lock either');
    eq(A.cardTapRule({ screen: 'history', over: '', locked: false, starting: false }), 'ignore', 'the till in state is enough, with facts that leave it out');
    eq(A.cardTapFacts().till, true, 'the facts say the till');
    // the card's own ways in, each refused in the till
    W.cardSession = () => Promise.reject(new Error('not in this test'));
    W.cardsList = () => [{ key: 'k1', name: 'A CARD' }];
    let reads = 0;
    const wasRead = A.fcRead;
    A.fcRead = () => { reads += 1; };
    A.goFlashcard(); await settle();
    ok(tillAmount() && reads === 0, 'goFlashcard: nothing, no card is asked for', JSON.stringify([A.state.screen, reads]));
    A.fcRead = wasRead;
    A.fcShow({ key: 'k1', info: { empty: 1, spent: 0 }, pieces: [], balance: 0 }, true); await settle();
    ok(tillAmount() && !A._fcCard, 'fcShow on the way to the card: nothing');
    const ask = A.fcAskAtMint;
    let asked = 0;
    A.fcAskAtMint = () => { asked += 1; };
    A.fcRestoreLost(); await settle();
    ok(tillAmount() && asked === 0, 'RESTORE LOST CARD: nothing');
    A.fcAskAtMint = ask;
    delete W.cardSession;
    // a screen the till has none of, however it was reached, is its SET AMOUNT before the next frame
    for (const sc of ['flashcard', 'fcRestore', 'fcWelcome', 'sendHow', 'sendScan', 'switchMint', 'swap', 'contacts']) {
      A.setState({ screen: sc, stack: ['amount'] }); await settle();
      ok(!!A.state.till && tillAmount(), sc + ' in the till: back to its SET AMOUNT', JSON.stringify([A.state.screen, A.state.flow]));
    }
    A.setState({ open0: true }); await settle();
    ok(!A.state.open0 && tillAmount(), 'the menu, however opened, is shut in the till');
    A.setState({ screen: 'amount', flow: 'cardAdd', stack: ['amount'] }); await settle();
    ok(tillAmount(), 'a card’s amount on SET AMOUNT: back to the till’s receive', JSON.stringify([A.state.screen, A.state.flow]));
    // a keeper's receive paid by a card at another mint shows its charge first, and that stays
    A.setState({ screen: 'fcXmConfirm', stack: ['amount', 'confirm'] }); await settle();
    eq(A.state.screen, 'fcXmConfirm', 'a keeper: the charge for a card at another mint stays');
    A.setState(A.homeState()); await settle();
    // the keeper's receive screen has CARD; the cashier's has not, and the button does nothing there
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    eq(V().recvCardShown, true, 'a keeper’s receive: CARD, the card paying the request');
    await cashierTill(W);
    let begun = 0;
    const wasBegin = A.fcPayBegin;
    A.fcPayBegin = () => { begun += 1; };
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'], recvUnit: 'sat' }); await settle();
    eq(V().recvCardShown, false, 'a cashier’s receive: no CARD');
    A.payByCard(); A.setState({ recvUnit: 'usd' }); A.payByCard(); await settle();
    ok(begun === 0 && !stage(), 'a cashier’s receive: the card button’s way in begins nothing', String(begun));
    A.fcPayBegin = wasBegin;
    A.setState({ screen: 'fcXmConfirm', stack: ['amount', 'confirm'] }); await settle();
    ok(tillAmount(), 'a cashier: no card’s charge screen either');
    A.closeReceive(); await settle();
  }

  // ---- 14. a code run out that the wallet noticed first ----------------------------------------------------
  {
    const W = stubWallet({});
    await cashierTill(W);
    let ready = 0, balances = 0, histories = 0;
    const wr = A.walletReady, rb = A.refreshBalance, lh = A.loadHistory;
    A.walletReady = function (x) { ready += 1; return wr.call(this, x); };
    A.refreshBalance = function () { balances += 1; return rb.call(this); };
    A.loadHistory = function () { histories += 1; return lh.call(this); };
    // the wallet's own clock: the row gone and the phone home before the app's minute comes round (`tillCashier`)
    W.cashier = null; W.mintUrl = OWN_MINT;
    // and its leave, asked again, has nothing left to do (it is idempotent)
    W.tillLeave = function () { W.calls.leaves += 1; return Promise.resolve({ left: true, mint: W.mintUrl, home: true }); };
    const left = await A.tillTick(); await settle(); await settle();
    ok(left === true && !A.state.till && A.state.screen === 'home', 'the wallet went home first: out of the till, home');
    ok(toasts.indexOf('The cashier code has expired') >= 0, 'with "The cashier code has expired"', JSON.stringify(toasts));
    ok(ready === 1, 'and the mint it is on now is taken up as a switch takes it up (walletReady)', String(ready));
    ok(balances >= 1 && histories >= 1, 'its balance and history asked again', balances + ', ' + histories);
    ok(V().isHome && !A._tillTickT, 'home drawn, and the clock stopped');
    A.walletReady = wr; A.refreshBalance = rb; A.loadHistory = lh;
  }
  {
    // the minute and a second tick at once: one leave
    const W = stubWallet({});
    await cashierTill(W);
    W.cashier = null;
    await Promise.all([A.tillTick(), A.tillTick()]); await settle();
    ok(!A.state.till && W.calls.leaves === 1, 'two ticks at once: one leave', String(W.calls.leaves));
  }
  {
    // the trip home fails: out of the till all the same, and the reason it left is what is said
    const W = stubWallet({});
    await cashierTill(W);
    W.cashier = null;
    W.tillLeave = () => Promise.reject(new Error('Could not reach own.example.net'));
    await A.tillTick(); await settle();
    ok(!A.state.till && A.state.screen === 'home' && toasts.indexOf('The cashier code has expired') >= 0, 'the way home failing: out, home, said why');
  }

  // ---- 15. a code run out in the middle of a payment --------------------------------------------------------
  {
    const W = stubWallet({});
    const p = await cashierTill(W, passOf({ exp: Math.floor(Date.now() / 1000) - 5 }));
    let asked = 0;
    const tc = W.tillCashier;
    W.tillCashier = function () { asked += 1; return tc.call(W); };
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    const left = await A.tillTick(); await settle();
    ok(left === false && !!A.state.till && A.state.screen === 'confirm', 'the receive screen up: the till stays');
    ok(asked === 0 && W.calls.leaves === 0, 'and the wallet is not asked, which would itself take the phone home', asked + ', ' + W.calls.leaves);
    // paid while it waits: PAID is shown, in the till, saying where the money went
    A.setState({ screen: 'paid', stack: [], recv: { live: 'in' }, recvResolved: true }); await settle();
    ok(!!A.state.till && A.state.screen === 'paid' && A.state.paidPlace && A.state.paidPlace.to === 'THE KEEPER', 'PAID: still the till’s, to the keeper');
    await A.tillTick(); await settle();
    ok(!!A.state.till && A.state.screen === 'paid', 'a minute on, still PAID');
    V().dismissPaid(); await wait(560); await settle(); await settle();
    ok(!A.state.till && A.state.screen === 'home' && W.calls.leaves === 1, 'PAID dismissed: out of the till, home', JSON.stringify([A.state.screen, !!A.state.till, W.calls.leaves]));
    ok(toasts.indexOf('The cashier code has expired') >= 0, 'with the word');
    ok(!A._tillRunOutT && !A._tillRunOut, 'and nothing left waiting');
    void p;
  }
  {
    // the receive screen closed with nothing paid: out at once
    const W = stubWallet({});
    await cashierTill(W, passOf({ exp: Math.floor(Date.now() / 1000) - 5 }));
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    await A.tillTick(); await settle();
    ok(!!A.state.till, 'the receive screen up: still in');
    A.closeReceive(); await settle(); await settle();
    ok(!A.state.till && A.state.screen === 'home' && W.calls.leaves === 1, 'the receive screen closed: out, home');
  }
  {
    // a pending receive dismissed: its PAID lands a second later, in the till, and only then is the till left
    const W = stubWallet({});
    await cashierTill(W, passOf({ exp: Math.floor(Date.now() / 1000) - 5 }));
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    await A.tillTick(); await settle();
    A.dismissPending();
    await wait(700); await settle();
    ok(!!A.state.till && W.calls.leaves === 0, 'between DISMISS and its PAID: still in', JSON.stringify([A.state.screen, W.calls.leaves]));
    await wait(1100); await settle();
    ok(!!A.state.till && A.state.screen === 'paid', 'its PAID, in the till', A.state.screen);
    V().dismissPaid(); await wait(560); await settle(); await settle();
    ok(!A.state.till && A.state.screen === 'home' && W.calls.leaves === 1, 'and out once it is dismissed');
  }
  {
    // a stage screen up over the till's SET AMOUNT (a token being taken, a code being shown): the leave waits for it to go down
    const W = stubWallet({});
    await cashierTill(W, passOf({ exp: Math.floor(Date.now() / 1000) - 5 }));
    A.stageScreen('tillWork', { art: '', title: 'RECEIVING', body: '', dots: true, button: 'CANCEL' });
    await settle();
    await A.tillTick(); await settle();
    ok(!!A.state.till && W.calls.leaves === 0, 'a stage screen up: still in');
    ok(!!stage(), 'the stage is up');
    A.hideStage('tillWork');
    await wait(1200); await settle(); await settle();
    ok(!A.state.till && W.calls.leaves === 1, 'the stage down: out, by the wait’s own look a moment on');
  }
  {
    // a code still in date on the receive screen: nothing at all
    const W = stubWallet({});
    await cashierTill(W);
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    await A.tillTick(); await settle();
    ok(!!A.state.till && !A._tillRunOut && !A._tillRunOutT, 'in date, on the receive screen: nothing waits');
    A.closeReceive(); await settle();
  }

  // ---- 16. CASHIER CODE, answered again ------------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await fresh(W);
    // a code made earlier, with 10 hours left: the wallet answers it, not a new one
    const older = passOf({ id: '00112233aabbccdd', exp: Math.floor(Date.now() / 1000) + 10 * 3600 });
    W.passes.push(older);
    A.tillPassShow(); await settle(); await settle();
    let s = stage();
    const qr1 = s && s.querySelector('[data-stage-qr]') && s.querySelector('[data-stage-qr]').getAttribute('src');
    ok(s && s.textContent.indexOf('Expires ' + A.tillExpiresText(older.exp)) >= 0, 'the live code’s own expiry, not 72 hours from now', s && s.textContent.slice(0, 160));
    ok(s && /CASHIER CODE/.test(s.textContent), 'titled CASHIER CODE');
    press(s, 'DONE'); await settle();
    A.tillPassShow(); await settle(); await settle();
    s = stage();
    const qr2 = s && s.querySelector('[data-stage-qr]') && s.querySelector('[data-stage-qr]').getAttribute('src');
    ok(qr1 && qr1 === qr2 && W.passes.length === 1, 'shown again: the same code', JSON.stringify([qr1 === qr2, W.passes.length]));
    press(s, 'DONE'); await settle();
  }

  const errs = errors.filter((e) => !/never resolved|Not implemented/.test(e));
  ok(!errs.length, 'no errors on the page', errs.slice(0, 3).join(' | '));
  console.log('');
  console.log(failed ? failed + ' of ' + (passed + failed) + ' till screen checks failed' : 'all ' + passed + ' till screen checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
