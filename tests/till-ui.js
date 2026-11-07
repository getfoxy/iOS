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
 *   17 opening the till: the mint list where the phone uses more than one; the till takes what the keeper holds at the default,
 *      and where that is both, DEFAULT CURRENCY once (back off it opens nothing), and then no question at any receive: no
 *      CURRENCY, no WALLET chip, the keypad in dollars with its swap; the tap offered { v: 2, inv, req, req2 }, the invoice and
 *      `req` in the main and `req2` the other currency for the same price; a till in one currency offered as ever, no `req2`;
 *      the code carries the main; a visit that fails, back off the list
 *   18 the till at several mints: tick one or more, NEXT (grey with none), DEFAULT MINT among the ticked, back keeps the ticks;
 *      the wallet told of the set and the default; every request names the set, the default first, a cashier's from its code;
 *      a till in both at a set with a mint of sats alone asks DEFAULT CURRENCY after DEFAULT MINT; SET AMOUNT and HISTORY say
 *      where; a cashier on a code for both receives in its main (sats for a code from before codes said one), its pair locked
 *      to the keeper; 18d the payer of a pair pays the request it holds (`tapPickOfTwo`); 18e a card at a till in both is asked
 *      in either currency, and one at another mint of the till is taken there
 *   21 the till's receive screen: no NOTE, COPY, SCAN or CARD; PAY WITH FOXY CARD in SHARE's place, doing what CARD did and
 *      greyed where CARD was not offered; the ordinary receive unchanged
 *   19 the road to the mint opened ahead (the wallet's `warm`): as the till opens, at each PAID back to SET AMOUNT, at SEND's
 *      keypad reaching an amount (once), at a receive's amount screen and at a card's screen
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
const REAL_CTX = loadReal();
const REAL = REAL_CTX.W;
// a NUT-18 request naming `mints`, read back by the real wallet's reader, for the payer's side of a till at several mints
const requestAt = (mints, sats) => new REAL_CTX.window.CashuTS.PaymentRequest([], 'abcd1234', sats || 30, 'sat', mints, undefined, true).toEncodedRequest();

function stubWallet(o) {
  const opt = Object.assign({ pin: '', face: false, faceSays: 'yes' }, o || {});
  const calls = { requests: [], invoices: [], joins: [], leaves: 0, listens: 0, delivers: 0, taken: [], scans: 0, primes: 0,
    biometric: [], pays: 0, passMakes: 0, passUnits: [], passOpts: [], keeperOpens: [], keeperCloses: 0, received: [], warms: 0,
    tipsSet: [], tipTaken: [], passEnds: [], cidAdds: [] };
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
    // the wallet's word of a payment, kept so a scenario can speak it (15-paid-wake-keyboard.js)
    listen(cb) { W._listenCb = cb; return () => {}; },
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
    // the road to the mint opened ahead of a screen's question (03-seed-counters-logs.js `warmRoad`): counted
    warm() { calls.warms += 1; return Promise.resolve(true); },
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
    tillPassMake(mo) {
      calls.passMakes += 1;
      const unit = (mo && mo.unit) || '';
      calls.passUnits.push(unit);
      calls.passOpts.push(mo === undefined ? undefined : JSON.parse(JSON.stringify(mo)));
      if (opt.passFails) return Promise.reject(new Error('The phone could not make a key for the code.'));
      // (in the unit asked, where one is: sats, dollars or both, as the till takes, and its code says which)
      const live = W.passes.filter((x) => Number(x.exp) * 1000 > Date.now() && (!unit || x.unit === unit));
      // (and at the mints the keeper's till takes, the default first, where one is open: `tillKeeperOpen`)
      const set = W.keeper ? [W.keeper.def].concat(W.keeper.mints.filter((u) => u !== W.keeper.def)) : [W.mintUrl];
      // (another code beside those live, for the list's ADD A CASHIER: `fresh`, with tips and a label of its own)
      if (mo && mo.fresh) {
        const n = W.passes.length;
        const pf = passOf({ id: ('a' + String(n)).padEnd(16, '0').slice(0, 16), unit: unit || 'sat', mint: set[0], mints: set });
        if (mo.tips && mo.tips.on) pf.tips = true;
        W.passes.push(Object.assign({}, pf, { label: mo.label || '', tipsRow: mo.tips || null, made: Date.now() }));
        return Promise.resolve({ text: codeOf(pf), id: pf.id, exp: pf.exp, mints: pf.mints, tips: !!pf.tips, label: mo.label || '' });
      }
      const p = live.length ? live[live.length - 1] : passOf({ id: unit === 'usd' ? 'fedcba9876543211' : unit === 'both' ? 'fedcba9876543212' : 'fedcba9876543210', unit: unit || 'sat', mint: set[0], mints: set });
      if (!live.length) W.passes.push(p);
      return Promise.resolve({ text: codeOf(p), id: p.id, exp: p.exp, mints: p.mints || [p.mint] });
    },
    // ---- tips and the list of codes (08f-till-tips.js), as the wallet answers ----
    tips: null,
    tillTipsSet(t) { calls.tipsSet.push(JSON.parse(JSON.stringify(t))); W.tips = t; return t; },
    tillTipsProblem: (t) => REAL.tillTipsProblem(t),
    tillTipTaken(o) { calls.tipTaken.push(Object.assign({}, o)); return Promise.resolve({ jobs: W.tips && W.tips.to !== 'self' ? 1 : 0, kept: 0, waiting: 0 }); },
    tillPassList() {
      const now = Date.now();
      const view = (x) => ({ id: x.id, label: x.label || '', unit: x.unit, main: x.main || x.unit, mints: x.mints || [x.mint],
        tips: x.tipsRow ? { on: !!x.tipsRow.on, to: x.tipsRow.to, names: (x.tipsRow.ids || []).map((r) => r.name) } : { on: false, to: 'self', names: [] },
        made: x.made || now - 1000, exp: x.exp, endedAt: x.endedAt || 0, how: x.endedAt ? 'ended' : 'expired', until: x.endedAt || x.exp * 1000,
        text: !x.endedAt && x.exp * 1000 > now ? codeOf(x) : '' });
      const all = W.passes.map(view);
      return { live: all.filter((v) => v.text), past: all.filter((v) => !v.text) };
    },
    tillPassEnd(id) { calls.passEnds.push(id); const x = W.passes.find((y) => y.id === id && !y.endedAt); if (x) x.endedAt = Date.now(); return !!x; },
    // ---- Cashu ID contacts, for who the tips go to (08e-cashu-id.js) ----
    cids: [],
    cashuIdContacts() { return W.cids.slice(); },
    cashuIdCheck(text) {
      const hit = (W.idTexts || {})[String(text).trim()];
      if (!hit) return Promise.reject(new Error('That is not a Cashu ID.'));
      const known = W.cids.find((c) => c.cid.id === hit.id);
      return Promise.resolve({ id: hit.id, nostr: hit.nostr, text, own: !!hit.own, name: known ? known.name : '' });
    },
    cashuIdAdd(text, name) {
      const hit = (W.idTexts || {})[String(text).trim()];
      calls.cidAdds.push([text, name]);
      const c = { handle: text, name, at: Date.now(), cid: { id: hit.id, nostr: hit.nostr } };
      W.cids.unshift(c);
      return Promise.resolve(c);
    },
    tillListen() { calls.listens += 1; return Promise.resolve(0); },
    // the keeper's till at a set of its mints, `def` the default: the visit there, and the way home
    keeper: null,
    tillKeeperOpen(mints, def) {
      const set = Array.isArray(mints) ? mints.slice() : [mints];
      const at = def || set[0];
      calls.keeperOpens.push({ mints: set, def: at });
      if (opt.openFails) return Promise.reject(new Error('That mint did not answer.'));
      const moved = W.mintUrl !== at;
      W.mintUrl = at;
      W.keeper = { mints: set, def: at };
      return Promise.resolve({ mint: at, mints: set, moved });
    },
    tillKeeperClose() { calls.keeperCloses += 1; W.keeper = null; const moved = W.mintUrl !== MINT; W.mintUrl = MINT; return Promise.resolve({ mint: MINT, moved }); },
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
  // ACCEPT TIPS?, as the till opens: answered NO, or left for the scenario to answer (26p-till-tips.js)
  const tipsAsked = () => /ACCEPT TIPS\?/.test(card());
  const noTips = async () => { if (tipsAsked()) { press(A._blockedEl, 'NO'); await settle(); } };
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
    ok(/SETTINGS > SET PIN or FACE ID LOCK/.test(card()), 'and where to set one');
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
    ok(pinUp() && W.calls.biometric.length === 0, 'a PIN with FACE ID LOCK off: the pad, no face asked');
    await typePin('2468');
    eq(through, 1, 'and the PIN opens it');
  }

  // ---- 2. the rows ----------------------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await fresh(W, { open0: true });
    const labels = () => V().menuItems.map((m) => m.label);
    let l = labels();
    ok(l.indexOf('TOOLS') > l.indexOf('MINTS') && l.indexOf('TOOLS') < l.indexOf('SETTINGS') && l.indexOf('POINT OF SALE') === l.indexOf('TOOLS') + 1
       && l.indexOf('SPLIT A BILL') === l.indexOf('TOOLS') + 2 && l.indexOf('CASHIER CODE') < 0 && l.indexOf('RESTORE LOST CARD') > l.indexOf('SETTINGS'),
      'TOOLS, open to start with, between MINTS and SETTINGS: POINT OF SALE, SPLIT A BILL; no CASHIER CODE row (that is the till’s own screen’s); RESTORE LOST CARD is SETTINGS’', l.join(', '));
    V().menuItems.find((m) => m.label === 'TOOLS').tap(); await settle();
    l = labels();
    ok(l.indexOf('POINT OF SALE') < 0 && l.indexOf('SPLIT A BILL') < 0 && A.state.open0 === true, 'TOOLS tapped shut: its rows go, and the drawer stays', l.join(', '));
    V().menuItems.find((m) => m.label === 'TOOLS').tap(); await settle();
    l = labels();
    ok(l.indexOf('POINT OF SALE') === l.indexOf('TOOLS') + 1 && A.state.open0 === true, 'and open again', l.join(', '));
    ok(V().menuItems.find((m) => m.label === 'POINT OF SALE').indent === '10px', 'indented as every section’s rows are');
    ok(l.indexOf('RESTORE LOST CARD') === l.indexOf('RESTORE') + 1 && V().menuItems.find((m) => m.label === 'RESTORE LOST CARD').indent === '10px',
      'RESTORE LOST CARD sits under SETTINGS after RESTORE, indented');
    // SETTINGS opened again after it was tapped shut scrolls the drawer to its end, where its rows unfold (19-update-keypad-balance.js `syncMenuScroll`)
    {
      const drawer = w.document.querySelector('[data-menu-drawer]');
      const scrolled = [];
      if (drawer) drawer.scrollTo = (o) => scrolled.push(o && o.top);
      A.setState({ menuShut: { settings: true } }); await settle();
      ok(scrolled.length === 0, 'tapping SETTINGS shut does not scroll', String(scrolled.length));
      A.setState({ menuShut: { settings: false } }); await settle(); await settle();
      ok(!!drawer && scrolled.length >= 1, 'opening SETTINGS again scrolls the drawer to its end', JSON.stringify([!!drawer, scrolled]));
      A.setState({ menuShut: { tools: true } }); await settle();
      const n = scrolled.length;
      A.setState({ menuShut: {} }); await settle();
      ok(scrolled.length === n, 'opening TOOLS does not', String(scrolled.length - n));
    }
    ok(/POINT OF SALE/.test(textOf(w)) && !/CASHIER CODE/.test(textOf(w)), 'and drawn in the drawer, with no CASHIER CODE row anywhere in it');
    V().menuItems.find((m) => m.label === 'POINT OF SALE').tap();
    await settle();
    ok(pinUp() && !A.state.open0, 'POINT OF SALE: the drawer shuts and the lock is asked');
    await typePin('2468');
    ok(tipsAsked() && !A.state.till, 'past the lock (and the mint questions, none here): ACCEPT TIPS? before the till');
    await noTips();
    ok(A.state.till && A.state.till.role === 'keeper' && tillAmount(), 'NO: the keeper’s till, on SET AMOUNT');
    ok(A.state.till.tips && A.state.till.tips.on === false && W.calls.tipsSet.length === 1 && W.calls.tipsSet[0].on === false, 'with tips off, kept with the till');
  }

  // ---- 3. the keeper's till -----------------------------------------------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await keeperTill(W);
    const v = V();
    ok(v.isAmount && !v.isHome, 'the till: SET AMOUNT, not home');
    eq([A.state.flow, v.amountTitle, v.amountSubtitle], ['receive', 'POS MODE', 'How much to receive?'], 'in receive, titled POS MODE');
    ok(v.amtCodeShown === true && typeof v.amtCodeTap === 'function', 'with CASHIER CODE as a third button up top, the keeper’s');
    v.amtCodeTap(); await settle();
    ok(pinUp(), 'which asks the lock first');
    await typePin('2468');
    ok(A.state.screen === 'switchMint' && A.state.tillList === 'codes' && !stage(), 'and then shows CASHIER CODES, the list');
    A.back(); await settle();
    ok(tillAmount(), 'back off it is the till again');
    eq(v.amtBackPath, 'M6 6l12 12M18 6L6 18', 'the top left is an X');
    ok(v.amtHistShown && !v.hideSkip, 'HISTORY at the top right');
    const t = textOf(w);
    ok(/POS MODE/.test(t) && !/SET AMOUNT/.test(t) && !/MENU/.test(t) && !/PASTE/.test(t) && !/SCAN/.test(t), 'drawn as POS MODE: no MENU, no SCAN, no PASTE', t.slice(0, 120));
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
    /* A card paying in its other currency (dollars for this till's sats) shows the total the holder agrees to first
     * (26f-flashcard.js `fcOtherAgree`): it stays, and its back is the till's receive screen, the till still open. */
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    A.setState((p) => ({ screen: 'fcOuConfirm', stack: p.stack.concat(['confirm']), fcOu: null })); await settle();
    eq(A.state.screen, 'fcOuConfirm', 'a keeper: a card’s total in its other currency stays on screen');
    A.back(); await settle();
    ok(A.state.screen === 'confirm' && !!A.state.till, 'and back from it is the till’s receive screen, not home', JSON.stringify([A.state.screen, !!A.state.till]));
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
    A.setState({ screen: 'fcOuConfirm', stack: ['amount', 'confirm'], fcOu: null }); await settle();
    eq(A.state.screen, 'fcOuConfirm', 'a cashier: a card’s total in its other currency is not thrown out by the till');
    A.setState(A.homeState()); await settle();
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

  // ---- 17. opening the till: which mint, which currency, one of each for the session ------------------------------
  {
    // one mint, one balance: straight in, in sats, no question
    let W = stubWallet({ pin: '2468' });
    await fresh(W);
    A.tillOpen(); await settle(); await noTips();
    ok(tillAmount() && A.state.till && A.state.till.role === 'keeper' && A.state.till.unit === 'sat' && A.tillUnit() === 'sat' && A.state.screen !== 'currency',
       'one mint with one balance: POINT OF SALE opens the till at once, in sats', JSON.stringify([A.state.screen, A.state.till]));
    ok(A.walletNow('receive') === 'sat', 'every receive in the till is in that currency, no balance asked', JSON.stringify([A.walletNow('receive'), A.state.wallet]));
    // nothing from before the till opened is raised as a new payment, however it comes: the history's sweep, or the wallet's own word
    {
      const since = A.state.till.since;
      const said = [];
      const wasAnnounce = A.announcePayment;
      A.announcePayment = (ev) => { said.push(ev.hash); };
      W.rows = [
        { hash: 'old-row', dir: 'in', sats: 100, at: Math.floor((since - 3600 * 1000) / 1000), settled: true, mint: MINT },
        { hash: 'new-row', dir: 'in', sats: 50, at: Math.floor((Date.now() + 2000) / 1000), settled: true, mint: MINT },
      ];
      // (seeded already, as a phone that came to this mint during the session is)
      A._seenSeeded = true; A._seededFor = A.mintHost(); delete A._seenTx;
      A.loadHistory(); await settle(); await settle();
      ok(said.join() === 'new-row' && A._seenTx['old-row'] === true, 'the history sweep raises only what came after the till opened; the rest is marked seen', said.join());
      W._listenCb && W._listenCb({ hash: 'old-ev', dir: 'in', sats: 7, at: Math.floor((since - 60000) / 1000) });
      await settle();
      ok(said.join() === 'new-row', 'and the wallet’s word about an old payment is not raised either', said.join());
      A.announcePayment = wasAnnounce;
      W.rows = [];
    }
    // no payment on chain in the till, the keeper's as the cashier's: NETWORK offers none, and a phone whose default is on chain opens on Lightning
    {
      let sheet = 0;
      const was = A.chooseFrom;
      A.chooseFrom = (title, rows) => { sheet += 1; A._sheetRows = typeof rows === 'function' ? rows() : rows; };
      A.ocCan = () => true;
      A.chooseRail('LIGHTNING', () => {});
      ok(sheet === 1 && A._sheetRows.every((x) => x.label !== 'ON-CHAIN') && A._sheetRows.some((x) => x.label === 'LIGHTNING'), 'the keeper’s till: NETWORK offers no on chain', JSON.stringify((A._sheetRows || []).map((x) => x.label)));
      A.chooseFrom = was;
      delete A.ocCan;
    }
    A.tillEnd(); await settle();
    ok(W.calls.keeperCloses === 1 && !A.state.till, 'closing asks the wallet home (nothing to do at its own mint)', String(W.calls.keeperCloses));

    /* One mint issuing both, the keeper holding both: one question as the till opens, DEFAULT CURRENCY (`tillAskMain`), after the
     * wallet is told of the till; then no question at any receive. The till takes both; its main is what the QR invoice is in, and
     * a tap is offered a request in each (`tillTwinRequest`). */
    let sheet = null;
    const wasChoose = A.chooseFrom;
    const sheetOn = () => { sheet = null; A.chooseFrom = (title, rows) => { sheet = { title, rows: typeof rows === 'function' ? rows() : rows }; }; };
    const sheetOff = () => { A.chooseFrom = wasChoose; };
    W = stubWallet({ pin: '2468' });
    W.twoUnits = () => true; W.mintUnits = () => ['sat', 'usd']; W.balanceOf = (u) => (u === 'usd' ? 1234 : 50000);
    W.walletChoice = () => ({ hold: 'both' });
    await fresh(W, { balUsdCents: 1234 });
    A.tillOpen(); await settle(); await noTips();
    ok(!A.state.till && A.state.screen === 'currency' && A.state.currencyFlow === 'card' && A.state.curCard && A.state.curCard.question === 'DEFAULT CURRENCY'
       && W.calls.keeperOpens.length === 1,
       'holding both at a mint of both: DEFAULT CURRENCY is asked once the wallet is told of the till, and no till yet', JSON.stringify([A.state.screen, A.state.till, A.state.curCard, W.calls.keeperOpens.length]));
    let cv = V();
    ok(cv.curQuestion === 'DEFAULT CURRENCY' && Array.isArray(cv.curCards) && cv.curCards.length === 2 && cv.curCards.every((c) => !c.tagShown)
       && cv.curCards[0].balance === '$ 12.34' && /^\$ /.test(cv.curCards[1].balance),
       'with this phone’s balances at the default on it, and nothing greyed', JSON.stringify((cv.curCards || []).map((c) => [c.name, c.balance, c.tag])));
    ok(/QR invoice is made in it/.test(JSON.stringify(A.state.curCard.foot)), 'and the foot says what it decides', A.state.curCard.foot);
    // back off it: no till, the wallet's record of it let go
    A.back(); await settle(); await settle();
    ok(!A.state.till && A.state.screen !== 'currency' && W.calls.keeperCloses === 1 && !A._tillMainAsk,
       'back off DEFAULT CURRENCY: the opening stops, no till, and the wallet told', JSON.stringify([A.state.screen, A.state.till, W.calls.keeperCloses]));
    // again, and dollars picked as the main, then bitcoin
    A.tillOpen(); await settle(); await noTips();
    A.currencyPick('usd'); await settle(); await settle(); await noTips();
    ok(tillAmount() && A.state.till && A.state.till.unit === 'both' && A.state.till.main === 'usd' && A.tillMain() === 'usd' && A.tillUnit() === '' && A.tillBoth() === true,
       'dollars picked: the till takes both, dollars first', JSON.stringify([A.state.screen, A.state.till]));
    ok(A.state.unit === 'USD' && A.walletNow('receive') === 'usd', 'its keypad opens in dollars', JSON.stringify([A.state.unit, A.state.wallet]));
    A.tillEnd(); await settle();
    A.tillOpen(); await settle(); await noTips();
    A.currencyPick('sat'); await settle(); await settle(); await noTips();
    ok(tillAmount() && A.state.till && A.state.till.unit === 'both' && A.state.till.main === 'sat' && A.tillMain() === 'sat',
       'bitcoin picked: the till takes both, bitcoin first', JSON.stringify([A.state.screen, A.state.till]));
    await settle();
    ok(tillAmount() && A.state.screen !== 'currency' && A.walletNow('receive') === 'sat', 'and no receive asks which', JSON.stringify([A.state.screen, A.state.wallet]));
    ok(A.state.unit === 'USD' && V().swapVis === 'visible', 'its keypad opens in dollars too, the swap to sats there', JSON.stringify([A.state.unit, V().swapVis]));
    A.setState({ amount: '5' }); await settle();
    A.toggleUnit(); await settle();
    ok(A.state.unit === 'SATS' && A.state.amount === '6250', 'the swap: $5 is 6,250 sats here', JSON.stringify([A.state.unit, A.state.amount]));
    A.toggleUnit(); await settle();
    ok(A.state.unit === 'USD' && A.state.amount === '5.00', 'and back', JSON.stringify([A.state.unit, A.state.amount]));
    // the receive screen: no WALLET chip, and WALLET asks nothing
    A.setState({ amount: '5.00', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    ok(V().recvChipsTwo === false && V().recvChipsOne === true, 'its receive screen has no WALLET chip', JSON.stringify([V().recvChipsTwo, V().recvChipsOne]));
    sheetOn();
    A.pickRecvWallet();
    ok(sheet === null, 'and WALLET asks nothing', JSON.stringify(sheet));
    sheetOff();
    // the QR's invoice and request in the main, bitcoin; the tap offered both
    A.openReceiveNow(); await settle();
    let inv1 = W.calls.invoices[W.calls.invoices.length - 1];
    ok(inv1 && (!inv1.opts || !inv1.opts.unit || inv1.opts.unit === 'sat') && inv1.amount === 6250, 'its invoice is in the main, bitcoin: 6,250 sats for $5', JSON.stringify(inv1));
    A.setState({ invoice: 'lnbcsat-main', recvRail: 'LIGHTNING' }); await settle();
    // (the request a text is, from the stand-in's own numbering: 'creqA' and its place among the calls)
    const reqOf = (t) => W.calls.requests[Number(String(t || '').slice(5)) - 1];
    let offerAsk = A.tapOffering();
    const made = offerAsk ? [reqOf(offerAsk.req), reqOf(offerAsk.req2)].filter(Boolean) : [];
    ok(offerAsk && offerAsk.inv === 'lnbcsat-main' && offerAsk.req && offerAsk.req2 && offerAsk.req !== offerAsk.req2,
       'the tap is offered the invoice, the main’s request and one in the other currency', JSON.stringify(offerAsk));
    const rMain = made.filter((x) => !x.opts.twin)[0], rTwin = made.filter((x) => !!x.opts.twin)[0];
    ok(rMain && rMain.amount === 6250 && !rMain.opts.unit && rMain.opts.kept === true
       && rTwin && rTwin.amount === 500 && rTwin.opts.unit === 'usd' && rTwin.opts.twin === offerAsk.req && rTwin.opts.kept === true && JSON.stringify(rTwin.opts.mints) === JSON.stringify([MINT]),
       'the main’s request: 6,250 sats; the other: exactly 500 cents, paired with it, at the till’s mints', JSON.stringify(made));
    // as it goes on the air
    A.setState({ tapArmed: true }); await settle();
    A.syncTap(); await settle();
    let onAir = null;
    try { onAir = JSON.parse(String(A._tapOffer || '')); } catch (e) { onAir = null; }
    ok(onAir && onAir.v === 2 && onAir.inv === 'lnbcsat-main' && onAir.req === offerAsk.req && onAir.req2 === offerAsk.req2,
       'the offer on the air: { v: 2, inv, req, req2 }', String(A._tapOffer));
    A.setState({ tapArmed: false }); await settle();
    // sats typed: the sat request for the sats, the dollar one for their dollar worth
    A.closeReceive(); await settle();
    A.setState({ amount: '12500', unit: 'SATS', screen: 'confirm', stack: ['amount'], invoice: 'lnbcsat-two', recvRail: 'LIGHTNING' }); await settle();
    offerAsk = A.tapOffering();
    const made2 = offerAsk ? [reqOf(offerAsk.req), reqOf(offerAsk.req2)].filter(Boolean) : [];
    ok(offerAsk && offerAsk.req2 && made2.some((x) => !x.opts.twin && x.amount === 12500 && !x.opts.unit)
       && made2.some((x) => x.opts.twin && x.amount === 1000 && x.opts.unit === 'usd'),
       'a price typed in sats: 12,500 sats, and its dollar worth, 1,000 cents', JSON.stringify(made2));
    A.closeReceive(); await settle();
    // the code for it carries both, and the main
    A.setState(A.homeState()); await settle();
    A.tillPassShow(); await settle(); await settle();
    let s = stage();
    const poMain = W.calls.passOpts[W.calls.passOpts.length - 1];
    ok(W.calls.passUnits.slice(-1)[0] === 'both' && poMain && poMain.main === 'sat' && s && /CASHIER CODE/.test(s.textContent),
       'the cashier code is asked for in both, with its main', JSON.stringify(W.calls.passOpts));
    press(s, 'DONE'); await settle();
    A.tillEnd(); await settle();

    // a till in dollars first: the main's request in dollars, the other in sats at this phone's price
    W = stubWallet({ pin: '2468' });
    W.twoUnits = () => true; W.mintUnits = () => ['sat', 'usd']; W.balanceOf = (u) => (u === 'usd' ? 1234 : 50000);
    W.walletChoice = () => ({ hold: 'both' });
    await fresh(W, { balUsdCents: 1234 });
    A.tillOpen(); await settle(); await noTips();
    A.currencyPick('usd'); await settle(); await settle(); await noTips();
    A.setState({ amount: '5.00', unit: 'USD', screen: 'confirm', stack: ['amount'], invoice: 'lnbcusd-main', recvRail: 'LIGHTNING', recvAmount: 500 }); await settle();
    offerAsk = A.tapOffering();
    const made3 = offerAsk ? [W.calls.requests[Number(String(offerAsk.req).slice(5)) - 1], W.calls.requests[Number(String(offerAsk.req2).slice(5)) - 1]].filter(Boolean) : [];
    ok(offerAsk && offerAsk.req2 && made3.some((x) => !x.opts.twin && x.amount === 500 && x.opts.unit === 'usd')
       && made3.some((x) => x.opts.twin === offerAsk.req && x.amount === 6250 && !x.opts.unit),
       'dollars first: 500 cents in dollars, and 6,250 sats beside it', JSON.stringify(made3));
    A.closeReceive(); await settle();
    A.tillEnd(); await settle();
    // a till in one currency is offered as it always was: one request, no `req2`
    W = stubWallet({ pin: '2468' });
    W.twoUnits = () => true; W.mintUnits = () => ['sat', 'usd'];
    W.walletChoice = () => ({ hold: 'bitcoin' });
    await fresh(W);
    A.tillOpen(); await settle(); await settle(); await noTips();
    A.setState({ amount: '5.00', unit: 'USD', screen: 'confirm', stack: ['amount'], invoice: 'lnbcsat-one', recvRail: 'LIGHTNING', tapArmed: true }); await settle();
    const one = A.tapOffering();
    A.syncTap(); await settle();
    let oneAir = null;
    try { oneAir = JSON.parse(String(A._tapOffer || '')); } catch (e) { oneAir = null; }
    ok(A.state.till && A.state.till.unit === 'sat' && one && one.req && !('req2' in one) && oneAir && oneAir.req === one.req && !('req2' in oneAir)
       && Object.keys(oneAir).join() === 'v,inv,req,up,ask' + (oneAir.rate ? ',rate,at' : ''),
       'a till in sats: its offer has no req2, its keys as ever', String(A._tapOffer));
    A.setState({ tapArmed: false }); await settle();
    A.closeReceive(); await settle();
    A.tillEnd(); await settle();
    // holding dollars at a mint of both: a till in dollars, nothing asked, ever
    W = stubWallet({ pin: '2468' });
    W.twoUnits = () => true; W.mintUnits = () => ['sat', 'usd'];
    W.walletChoice = () => ({ hold: 'dollars' });
    await fresh(W, { balUsdCents: 1234 });
    A.tillOpen(); await settle(); await settle(); await noTips();
    ok(tillAmount() && A.state.till && A.state.till.unit === 'usd' && A.tillUnit() === 'usd' && A.walletNow('receive') === 'usd' && A.state.screen !== 'currency',
       'holding dollars: the till opens in dollars, and every receive is in dollars with no question', JSON.stringify([A.state.screen, A.state.till, A.state.wallet]));
    sheetOn();
    A.pickRecvWallet();
    ok(sheet === null, 'and WALLET asks nothing', JSON.stringify(sheet));
    sheetOff();
    A.tillPassShow(); await settle(); await settle();
    ok(W.calls.passUnits.slice(-1)[0] === 'usd', 'its cashier code is in dollars', JSON.stringify(W.calls.passUnits));
    press(stage(), 'DONE'); await settle();
    A.tillEnd(); await settle();

    // holding bitcoin, nothing chosen, or a mint of sats alone: sats
    for (const [hold, units, why] of [['bitcoin', ['sat', 'usd'], 'holding bitcoin at a mint of both'], ['', ['sat', 'usd'], 'nothing chosen at a mint of both'],
      ['both', ['sat'], 'holding both at a mint of sats alone'], ['dollars', ['sat'], 'holding dollars at a mint of sats alone']]) {
      W = stubWallet({ pin: '2468' });
      W.twoUnits = () => units.length > 1; W.mintUnits = () => units.slice();
      W.walletChoice = () => ({ hold });
      await fresh(W);
      A.tillOpen(); await settle(); await settle(); await noTips();
      ok(tillAmount() && A.state.till && A.state.till.unit === 'sat' && A.walletNow('receive') === 'sat' && A.state.screen !== 'currency',
         why + ': a till in sats, nothing asked', JSON.stringify([A.state.screen, A.state.till]));
      A.tillEnd(); await settle();
    }
    // two mints: TILL AT WHICH MINTS? first, on the mint list; the other mint alone ticked is visited for the till, and left when it closes
    W = stubWallet({ pin: '2468' });
    W.mints = () => [MINT, OWN_MINT];
    await fresh(W);
    A.tillOpen(); await settle(); await noTips();
    let rm = A.renderMints({ s: A.state, sc: 'switchMint' });
    ok(A.state.screen === 'switchMint' && A.state.tillPick === 'set' && rm.mintTitle === 'TILL AT WHICH MINTS?' && rm.mintRows.length === 2 && rm.mintRows[0].here === true && rm.mintPickers === false,
       'two mints: the mint list asks TILL AT WHICH MINTS?, this phone’s own first and ticked, no add-a-mint pickers', JSON.stringify([A.state.screen, rm.mintTitle, rm.mintRows.map((r) => [r.host, r.here])]));
    rm.mintRows[0].tap(); await settle();
    A.renderMints({ s: A.state, sc: 'switchMint' }).mintRows[1].tap(); await settle();
    A.renderMints({ s: A.state, sc: 'switchMint' }).tillNext(); await settle(); await settle(); await noTips();
    ok(W.calls.keeperOpens.length === 1 && JSON.stringify(W.calls.keeperOpens[0]) === JSON.stringify({ mints: [OWN_MINT], def: OWN_MINT }) && W.mintUrl === OWN_MINT
       && tillAmount() && A.state.till && A.state.till.unit === 'sat' && A.state.tillPick === false,
       'the other mint alone ticked, NEXT: no default asked, the wallet visits it, and the till opens there (one balance, sats)', JSON.stringify([W.calls.keeperOpens, W.mintUrl, A.state.screen]));
    ok(String(A.state.till.mint || '').indexOf('own.example.net') >= 0, 'the till remembers its mint', A.state.till.mint);
    A.tillEnd(); await settle();
    ok(W.calls.keeperCloses === 1 && W.mintUrl === MINT && !A.state.till, 'closed: the wallet is asked home, and is', JSON.stringify([W.calls.keeperCloses, W.mintUrl]));

    // the visit fails: NO TILL, nothing opened, the phone where it was
    W = stubWallet({ pin: '2468', openFails: true });
    W.mints = () => [MINT, OWN_MINT];
    await fresh(W);
    A.tillOpen(); await settle(); await noTips();
    A.renderMints({ s: A.state, sc: 'switchMint' }).mintRows[1].tap(); await settle();
    A.renderMints({ s: A.state, sc: 'switchMint' }).tillNext(); await settle();
    A.renderMints({ s: A.state, sc: 'switchMint' }).mintRows[1].tap(); await settle(); await settle(); await noTips();
    ok(!A.state.till && /NO TILL/.test(card()) && W.mintUrl === MINT, 'a mint that cannot be reached opens no till, and says so', card());
    shutCard(); await settle();

    // back off the mint list: the list is left, nothing opened
    W = stubWallet({ pin: '2468' });
    W.mints = () => [MINT, OWN_MINT];
    await fresh(W);
    A.tillOpen(); await settle(); await noTips();
    A.back(); await settle();
    ok(!A.state.till && A.state.screen !== 'switchMint' && A.state.tillPick === false && W.calls.keeperOpens.length === 0, 'back off the mint list opens nothing', JSON.stringify([A.state.screen, A.state.tillPick]));
  }

  // ---- 18. the till at several mints: which mints, then the default ------------------------------------------------
  {
    const mr = () => A.renderMints({ s: A.state, sc: 'switchMint' });
    let W = stubWallet({ pin: '2468' });
    W.mints = () => [MINT, OWN_MINT];
    await fresh(W);
    A.tillOpen(); await settle(); await noTips();
    let rm = mr();
    ok(A.state.tillPick === 'set' && rm.mintRows.map((r) => r.here).join() === 'true,false' && rm.tillNextShown === true && rm.tillNextBg === 'var(--acc)',
       'the set list: the mint this phone is on ticked at first, NEXT in fur', JSON.stringify([A.state.tillPick, rm.mintRows.map((r) => r.here), rm.tillNextBg]));
    eq(rm.mintNowLine, 'Pick every mint this till takes. Payments from other mints cross into the default, the payer paying the fee.', 'its line says what the set is');
    rm.mintRows[0].tap(); await settle();
    rm = mr();
    ok(rm.mintRows.every((r) => !r.here) && rm.tillNextBg !== 'var(--acc)' && rm.tillNextFur === 'none,none,none', 'nothing ticked: NEXT grey', JSON.stringify([rm.mintRows.map((r) => r.here), rm.tillNextBg]));
    rm.tillNext(); await settle();
    ok(A.state.screen === 'switchMint' && A.state.tillPick === 'set' && W.calls.keeperOpens.length === 0, 'and NEXT with nothing ticked does nothing', JSON.stringify([A.state.screen, A.state.tillPick]));
    rm.mintRows[0].tap(); await settle();
    mr().mintRows[1].tap(); await settle();
    rm = mr();
    ok(rm.mintRows.every((r) => r.here) && rm.mintRows.every((r) => r.bg === 'rgba(var(--acc-rgb),.12)'), 'both ticked: each in the look of the mint you are on', JSON.stringify(rm.mintRows.map((r) => [r.here, r.bg])));
    rm.tillNext(); await settle();
    rm = mr();
    ok(A.state.screen === 'switchMint' && A.state.tillPick === 'default' && rm.mintTitle === 'DEFAULT MINT' && rm.mintRows.length === 2 && rm.tillNextShown === false && rm.mintPickers === false,
       'NEXT: DEFAULT MINT, the two ticked listed, no NEXT and no pickers', JSON.stringify([A.state.tillPick, rm.mintTitle, rm.mintRows.map((r) => r.host)]));
    eq(rm.mintNowLine, 'Payments from mints you did not pick are moved here. Invoices are made here.', 'its line says what the default is');
    // back off DEFAULT MINT: the set list again, with its ticks
    A.back(); await settle();
    rm = mr();
    ok(A.state.screen === 'switchMint' && A.state.tillPick === 'set' && rm.mintRows.every((r) => r.here) && W.calls.keeperOpens.length === 0,
       'back off DEFAULT MINT: the set list, both still ticked, nothing opened', JSON.stringify([A.state.screen, A.state.tillPick, rm.mintRows.map((r) => r.here)]));
    rm.tillNext(); await settle();
    const own = mr().mintRows.filter((r) => r.host === 'own.example.net')[0];
    own.tap(); await settle(); await settle(); await noTips();
    ok(W.calls.keeperOpens.length === 1 && JSON.stringify(W.calls.keeperOpens[0]) === JSON.stringify({ mints: [MINT, OWN_MINT], def: OWN_MINT }),
       'the default picked: the wallet is told the set and the default', JSON.stringify(W.calls.keeperOpens));
    ok(tillAmount() && A.state.till && A.state.till.role === 'keeper' && A.state.till.mint === OWN_MINT && JSON.stringify(A.state.till.mints) === JSON.stringify([OWN_MINT, MINT])
       && A.state.tillPick === false && W.mintUrl === OWN_MINT,
       'and the till opens at the default, the set kept with it, the default first', JSON.stringify([A.state.screen, A.state.till]));
    // every request names the set, the default first
    A.railRequest(1000); await settle();
    let r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && JSON.stringify(r.opts.mints) === JSON.stringify([OWN_MINT, MINT]) && r.opts.purpose === 'receive' && !r.opts.lockPub,
       'a till’s request names its mints, the default first', JSON.stringify(r && r.opts));
    A.tapOnlyRequest(1000);
    r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && JSON.stringify(r.opts.mints) === JSON.stringify([OWN_MINT, MINT]), 'a tap’s request: the same', JSON.stringify(r && r.opts));
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    A.openReceiveNow(); await settle();
    const inv = W.calls.invoices[W.calls.invoices.length - 1];
    ok(inv && W.mintUrl === OWN_MINT && !(inv.opts && inv.opts.mints), 'the invoice is made where the phone is, the default', JSON.stringify(inv));
    A.closeReceive(); await settle();
    A.setState(A.homeState()); await settle();
    // SET AMOUNT says where it is
    let v = V();
    ok(tillAmount() && v.amountNoteShown === true && v.amountNote === 'At ' + A.mintNameOf(OWN_MINT) + ' and 1 more mint',
       'the till’s SET AMOUNT says where it is: the default, and how many more', JSON.stringify([v.amountNoteShown, v.amountNote]));
    // HISTORY: a row at a mint that is not the default names it
    const since = A.state.till.since;
    const at = (ms) => new Date(ms).toISOString();
    W.rows = [
      { hash: 'at-def', dir: 'in', sats: 1200, at: at(since + 5000), settled: true, mint: OWN_MINT },
      { hash: 'at-other', dir: 'in', sats: 700, at: at(since + 6000), settled: true, mint: MINT },
    ];
    A.loadHistory(); await settle(); await settle();
    A.setState({ screen: 'history', stack: ['amount'] }); await settle();
    v = V();
    const rows = v.historyGroups.reduce((a, g) => a.concat(g.items), []);
    const other = rows.filter((x) => x.line2.indexOf(' · ') >= 0);
    ok(rows.length === 2 && other.length === 1 && other[0].line2.slice(-(' · ' + A.mintNameOf(MINT)).length) === ' · ' + A.mintNameOf(MINT),
       'HISTORY: the row taken at the other mint names it, the default’s does not', JSON.stringify(rows.map((x) => x.line2)));
    A.setState({ screen: 'amount', stack: [] }); await settle();
    // the cashier code is asked for in this till, which the wallet makes at its set
    A.tillPassShow(); await settle(); await settle();
    ok(W.passes.length === 1 && JSON.stringify(W.passes[0].mints) === JSON.stringify([OWN_MINT, MINT]) && W.passes[0].mint === OWN_MINT,
       'its cashier code is at the till’s mints, the default first', JSON.stringify(W.passes));
    press(stage(), 'DONE'); await settle();
    A.tillEnd(); await settle();
    ok(W.calls.keeperCloses === 1 && W.mintUrl === MINT && !A.state.till, 'closed: the wallet is asked home, and is', JSON.stringify([W.calls.keeperCloses, W.mintUrl]));

    // the default the mint this phone is on: no visit, but the wallet still told of the set
    W = stubWallet({ pin: '2468' });
    W.mints = () => [MINT, OWN_MINT];
    await fresh(W);
    A.tillOpen(); await settle(); await noTips();
    mr().mintRows[1].tap(); await settle();
    mr().tillNext(); await settle();
    mr().mintRows.filter((x) => x.host === 'forge.example.com')[0].tap(); await settle(); await settle(); await noTips();
    ok(W.calls.keeperOpens.length === 1 && JSON.stringify(W.calls.keeperOpens[0]) === JSON.stringify({ mints: [MINT, OWN_MINT], def: MINT }) && W.mintUrl === MINT
       && tillAmount() && JSON.stringify(A.state.till.mints) === JSON.stringify([MINT, OWN_MINT]),
       'the default where the phone is: the wallet told of the set, the phone where it was', JSON.stringify([W.calls.keeperOpens, A.state.till]));
    A.tillEnd(); await settle();

    /* A default that issues both, the keeper holding both, with a mint of the set that issues sats alone: DEFAULT CURRENCY asked
     * after DEFAULT MINT, and then nothing at any receive; a dollar request names the till's mints, and the wallet leaves off those
     * that issue no dollars (tests/till-wallet.js, `paymentRequest`). */
    W = stubWallet({ pin: '2468' });
    W.mints = () => [MINT, OWN_MINT];
    W.twoUnits = () => true;
    W.mintUnits = (u) => (String(u || W.mintUrl) === OWN_MINT ? ['sat'] : ['sat', 'usd']);
    W.walletChoice = () => ({ hold: 'both' });
    await fresh(W, { balUsdCents: 1234 });
    A.tillOpen(); await settle(); await noTips();
    mr().mintRows[1].tap(); await settle();
    mr().tillNext(); await settle();
    ok(A.state.tillPick === 'default' && !(A.state.curCard && A.state.curCard.question), '(set-up) DEFAULT MINT first, nothing of the currency yet', JSON.stringify([A.state.tillPick, A.state.curCard]));
    mr().mintRows.filter((x) => x.host === 'forge.example.com')[0].tap(); await settle(); await settle(); await noTips();
    ok(!A.state.till && A.state.screen === 'currency' && A.state.curCard && A.state.curCard.question === 'DEFAULT CURRENCY' && W.calls.keeperOpens.length === 1,
       'a set whose default issues both, holding both: DEFAULT CURRENCY after DEFAULT MINT', JSON.stringify([A.state.screen, A.state.till, A.state.curCard && A.state.curCard.question]));
    A.currencyPick('usd'); await settle(); await settle(); await noTips();
    ok(A.state.till && A.state.till.unit === 'both' && A.state.till.main === 'usd' && A.state.till.mints.length === 2 && tillAmount(),
       'dollars first: the till opens at both mints taking both', JSON.stringify([A.state.screen, A.state.till]));
    await settle();
    ok(tillAmount() && A.walletNow('receive') === 'usd', 'and its receive asks nothing', A.state.screen);
    A.setState({ amount: '2.50', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    A.cashuRequest(); await settle();
    r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && r.amount === 250 && r.opts.unit === 'usd' && JSON.stringify(r.opts.mints) === JSON.stringify([MINT, OWN_MINT]),
       'the request in dollars, handed the till’s mints for the wallet to keep those that issue dollars', JSON.stringify(r));
    A.closeReceive(); await settle();
    A.setState(A.homeState()); await settle();
    // SET AMOUNT still says where it is
    ok(tillAmount() && V().amountNote === 'At ' + A.mintNameOf(MINT) + ' and 1 more mint', 'its SET AMOUNT line as ever', V().amountNote);
    A.tillPassShow(); await settle(); await settle();
    const poB = W.calls.passOpts[W.calls.passOpts.length - 1];
    ok(poB && poB.unit === 'both' && poB.main === 'usd' && JSON.stringify(poB.mints) === JSON.stringify([MINT, OWN_MINT]), 'its cashier code is asked for in both, dollars first, at the set', JSON.stringify(poB));
    press(stage(), 'DONE'); await settle();
    A.tillEnd(); await settle();

    // a cashier on a code for both from before codes said a main: in sats, nothing asked, the dollar half locked to the keeper too
    W = stubWallet({});
    W.twoUnits = () => true; W.mintUnits = () => ['sat', 'usd'];
    W.walletChoice = () => ({ hold: 'dollars' });
    const pb = await cashierTill(W, passOf({ mint: KEEPER_MINT, unit: 'both' }));
    await settle();
    ok(A.tillUnit() === '' && A.tillBoth() === true && A.tillMain() === 'sat' && tillAmount() && A.walletNow('receive') === 'sat' && A.state.unit === 'USD',
       'a cashier on a code for both with no main: sats first, nothing asked, the keypad in dollars', JSON.stringify([A.state.screen, A.tillMain(), A.state.unit]));
    A.setState({ amount: '3.00', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    A.openReceiveNow(); await settle();
    let ci = W.calls.invoices[W.calls.invoices.length - 1];
    ok(ci && ci.opts && (ci.opts.unit || 'sat') === 'sat' && ci.opts.lockPub === pb.lock && ci.amount === 3750, 'its invoice in sats, locked to the keeper', JSON.stringify(ci));
    A.setState({ invoice: 'lnbcsat-cashier', recvRail: 'LIGHTNING' }); await settle();
    const cOffer = A.tapOffering();
    const cMade = cOffer ? [W.calls.requests[Number(String(cOffer.req).slice(5)) - 1], W.calls.requests[Number(String(cOffer.req2).slice(5)) - 1]].filter(Boolean) : [];
    ok(cOffer && cOffer.req && cOffer.req2 && cMade.length === 2 && cMade.every((x) => x.opts.lockPub === pb.lock && x.opts.purpose === 'till')
       && cMade.some((x) => !x.opts.twin && x.amount === 3750 && !x.opts.unit) && cMade.some((x) => x.opts.twin === cOffer.req && x.amount === 300 && x.opts.unit === 'usd'),
       'its tap offer: 3,750 sats and exactly 300 cents, both locked to the keeper and named for the till', JSON.stringify(cMade));
    ok(A.acceptTarget('cashuBdollars') === true && W.calls.taken.indexOf('cashuBdollars') >= 0, 'and a token is handed to the till’s own way in, which takes either unit', JSON.stringify(W.calls.taken));
    A.closeReceive(); await settle();
    // and on a code that says dollars first
    W = stubWallet({});
    W.twoUnits = () => true; W.mintUnits = () => ['sat', 'usd'];
    const pu = await cashierTill(W, passOf({ mint: KEEPER_MINT, unit: 'both', main: 'usd' }));
    await settle();
    ok(A.tillMain() === 'usd' && tillAmount() && A.walletNow('receive') === 'usd', 'a cashier on a code for both, dollars first: dollars, nothing asked', JSON.stringify([A.state.screen, A.tillMain()]));
    A.setState({ amount: '3.00', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    A.openReceiveNow(); await settle();
    ci = W.calls.invoices[W.calls.invoices.length - 1];
    ok(ci && ci.opts && ci.opts.unit === 'usd' && ci.opts.lockPub === pu.lock && ci.amount === 300, 'its invoice in dollars, locked to the keeper', JSON.stringify(ci));
    A.closeReceive(); await settle();

    // a cashier's requests name the mints its code carries, the default first
    W = stubWallet({});
    await cashierTill(W, passOf({ mint: KEEPER_MINT, mints: [KEEPER_MINT, OWN_MINT] }));
    A.railRequest(1000); await settle();
    r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && r.opts.lockPub === LOCK && r.opts.purpose === 'till' && JSON.stringify(r.opts.mints) === JSON.stringify([KEEPER_MINT, OWN_MINT]),
       'a cashier’s request: locked to the keeper, named for the till, at the code’s mints', JSON.stringify(r && r.opts));
    A.tapOnlyRequest(1000);
    r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && r.opts.lockPub === LOCK && JSON.stringify(r.opts.mints) === JSON.stringify([KEEPER_MINT, OWN_MINT]), 'a cashier’s tap request: the same', JSON.stringify(r && r.opts));
    // and a code from before codes carried a set: its one mint
    W = stubWallet({});
    await cashierTill(W);
    A.railRequest(1000); await settle();
    r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && JSON.stringify(r.opts.mints) === JSON.stringify([KEEPER_MINT]), 'a code with no set: its one mint', JSON.stringify(r && r.opts));
    eq(V().amountNoteShown, false, 'and a till at one mint says nothing of where on SET AMOUNT');

    // one mint on the phone: as ever, no list, and the request names that one mint
    W = stubWallet({ pin: '2468' });
    await fresh(W);
    A.tillOpen(); await settle(); await noTips();
    /* The wallet is told of a till at one mint too (review, stale-keeper): its record is what a cashier code reads its
     * mints from, and one left by an app killed in an earlier till handed this till's cashiers that till's mints. */
    ok(tillAmount() && W.calls.keeperOpens.length === 1 && JSON.stringify(W.calls.keeperOpens[0]) === JSON.stringify({ mints: [MINT], def: MINT })
       && W.mintUrl === MINT && JSON.stringify(A.state.till.mints) === JSON.stringify([MINT]) && A.state.till.mint === MINT,
       'one mint: no list, no visit, the wallet told of the till at that mint', JSON.stringify([W.calls.keeperOpens, A.state.till]));
    A.railRequest(1000); await settle();
    r = W.calls.requests[W.calls.requests.length - 1];
    ok(r && JSON.stringify(r.opts.mints) === JSON.stringify([MINT]), 'and its request names it', JSON.stringify(r && r.opts));
    A.tillPassShow(); await settle(); await settle();
    const po = W.calls.passOpts[W.calls.passOpts.length - 1];
    ok(po && JSON.stringify(po.mints) === JSON.stringify([MINT]) && po.unit === 'sat',
       'its cashier code is asked for at the screen’s own till, that one mint, never what the wallet last had on record', JSON.stringify(W.calls.passOpts));
    press(stage(), 'DONE'); await settle();
    A.tillEnd(); await settle();
    // a one-mint till that cannot open (the wallet's no): NO TILL, in the wallet's words
    W = stubWallet({ pin: '2468', openFails: true });
    await fresh(W);
    A.tillOpen(); await settle(); await settle(); await noTips();
    ok(!A.state.till && /NO TILL/.test(card()) && /did not answer/.test(card()), 'one mint the wallet will not open: NO TILL, and why', card());
    shutCard();

    /* ---- 18b. a keeper's till takes a token at another of its mints there (review) ---------------------------------- */
    W = stubWallet({ pin: '2468' });
    W.mints = () => [MINT, OWN_MINT];
    W.canonicalMint = (u) => String(u || '').replace(/\/+$/, '');
    W.tokenInfo = (t) => ({ mint: /own/.test(t) ? OWN_MINT : /far/.test(t) ? 'https://far.example.org' : MINT, unit: 'sat', amount: 210, proofs: [] });
    W.sweepQuote = () => new Promise(() => {});   // (another mint's token is asked about by a quote to move it home)
    W.receiveToken = (t, o) => { W.calls.received.push({ t, o: o === undefined ? undefined : Object.assign({}, o) }); return Promise.resolve({ sats: 210, unit: 'sat', amount: 210, host: 'x', mint: W.mintUrl, hash: 'h-' + W.calls.received.length }); };
    await fresh(W);
    A.tillStart({ unit: 'sat', mint: MINT, mints: [MINT, OWN_MINT] }); await settle();
    ok(A.tillAccept('cashuBown', 'token') === true, '(set-up) a token scanned at the keeper’s till is taken');
    await settle(); await settle();
    const got = W.calls.received[0] || {};
    ok(W.calls.received.length === 1 && got.o && got.o.away === true && W.mintUrl === MINT && A.state.screen !== 'switchMint' && !/MOVE|SWITCH/.test(card()),
       'at another mint of the till: taken there by the wallet (away), with no switch-mint offer, the phone where it was', JSON.stringify([W.calls.received, card()]));
    shutCard();
    A.tillAccept('cashuBhere', 'token'); await settle(); await settle();
    const got2 = W.calls.received[1] || {};
    ok(W.calls.received.length === 2 && !(got2.o && got2.o.away), 'at the mint the phone is on: taken as any token is', JSON.stringify(W.calls.received));
    shutCard();
    A.tillAccept('cashuBfar', 'token'); await settle(); await settle();
    ok(W.calls.received.length === 2, 'at a mint the till does not take: not taken away, but asked about as any other mint’s token is', JSON.stringify([W.calls.received.length, card()]));
    shutCard();
    A.tillEnd(); await settle();

    /* ---- 18c. the payer of a till at several mints (review, payer-cross) ------------------------------------------- */
    const two = requestAt([KEEPER_MINT, OWN_MINT], 30);
    const twoRead = REAL.decodeRequest(two);
    ok(twoRead && JSON.stringify(twoRead.mints) === JSON.stringify([KEEPER_MINT, OWN_MINT]), '(set-up) a request naming two mints, the default first', JSON.stringify(twoRead && twoRead.mints));
    W = stubWallet({});
    W.decodeRequest = (t) => REAL.decodeRequest(t);
    W.asksInDollars = () => false;
    W.canonicalMint = (u) => String(u || '').replace(/\/+$/, '');
    W.mintUrl = 'https://y.example.com';
    await fresh(W);
    const offer = A.tapOfferOf(JSON.stringify({ v: 2, req: two, up: true }));
    ok(offer && offer.crossable === true && offer.sameMint === false && JSON.stringify(offer.mints) === JSON.stringify([KEEPER_MINT, OWN_MINT]),
       'a payer at neither mint, facing two: crossable, into the default as into a till of one', JSON.stringify(offer && { c: offer.crossable, s: offer.sameMint }));
    W.mintUrl = OWN_MINT;
    const offer2 = A.tapOfferOf(JSON.stringify({ v: 2, req: two, up: true }));
    ok(offer2 && offer2.sameMint === true, 'a payer at the second mint named: the same mint, paid as it stands', JSON.stringify(offer2 && offer2.sameMint));
    // scanned: the phone's own mint where it is named, else one named where it holds enough, else the default
    ok(A.requestHere(twoRead) === true && A.reqPayMint(twoRead) === OWN_MINT, 'scanned at the second mint: here, and paid here', A.reqPayMint(twoRead));
    W.mintUrl = 'https://y.example.com';
    W.balanceAt = (u) => (String(u) === OWN_MINT ? 1000 : 0);
    ok(A.requestHere(twoRead) === false && A.reqPayMint(twoRead) === OWN_MINT, 'at neither, holding enough at the second: paid at the second, with no crossing', A.reqPayMint(twoRead));
    W.balanceAt = () => 0;
    ok(A.reqPayMint(twoRead) === KEEPER_MINT, 'holding enough at neither: the default, which a crossing goes to', A.reqPayMint(twoRead));
    W.mintUrl = OWN_MINT;
    const quotes = [];
    W.balanceAt = (u) => (String(u) === OWN_MINT ? 1000 : 0);
    W.pendingMoves = () => [];
    W.transferQuote = (from, n, o) => { quotes.push({ from, n, to: o && o.to }); return new Promise(() => {}); };
    const tokens = [];
    W.sendToken = (n, o) => { tokens.push({ n, o }); return new Promise(() => {}); };
    A.setState({ req: twoRead, screen: 'reqOffer', reqBusy: false, reqCollecting: false }); await settle();
    A.makeTokenForRequest({ req: twoRead }); await settle();
    ok(quotes.length === 0 && !/DIFFERENT MINT/.test(card()), 'PAY at the second mint, holding 1,000 there: no crossing quoted, nothing asked about the mint', JSON.stringify([quotes, card()]));
    shutCard();
    A.setState({ req: null, screen: 'home', stack: [] }); await settle();

    /* ---- 18d. the payer of a till in both: a request in each currency for one price (`tapPickOfTwo`) ---------------------- */
    const reqIn = (unit, mints, amount, id) => new REAL_CTX.window.CashuTS.PaymentRequest([], id, amount, unit, mints, undefined, true).toEncodedRequest();
    const satReq = reqIn('sat', [KEEPER_MINT, OWN_MINT], 6250, 'aaaa1111');
    const usdReq = reqIn('usd', [KEEPER_MINT], 500, 'bbbb2222');
    const pair = (o) => JSON.stringify(Object.assign({ v: 2, req: satReq, req2: usdReq, up: true, ask: 1 }, o || {}));
    const payer = async (mint, cents, sats, hold) => {
      W = stubWallet({});
      W.decodeRequest = (t) => REAL.decodeRequest(t);
      W.asksInDollars = (x) => REAL.asksInDollars(x);
      W.canonicalMint = (u) => String(u || '').replace(/\/+$/, '');
      W.twoUnits = () => true; W.mintUnits = () => ['sat', 'usd'];
      W.walletChoice = () => ({ hold: hold || '' });
      W.mintUrl = mint;
      await fresh(W, { balUsdCents: cents, balSats: sats });
    };
    await payer(KEEPER_MINT, 1000, 0);
    let po2 = A.tapOfferOf(pair({ inv: 'lnbcsat-pair' }));
    ok(po2 && po2.req === usdReq && po2.sameMint === true && po2.read && po2.read.unit === 'usd' && po2.crossable === false,
       'a payer holding dollars at the default of a till in bitcoin first: pays the dollar request, in dollars, nothing crossed', JSON.stringify(po2 && { u: po2.read && po2.read.unit, s: po2.sameMint }));
    await payer(KEEPER_MINT, 0, 50000);
    po2 = A.tapOfferOf(pair({ inv: 'lnbcsat-pair' }));
    ok(po2 && po2.req === satReq && po2.sameMint === true && po2.read.unit === 'sat', 'one holding sats there: the sat request', JSON.stringify(po2 && po2.read && po2.read.unit));
    po2 = A.tapOfferOf(JSON.stringify({ v: 2, req: usdReq, req2: satReq, up: true }));
    ok(po2 && po2.req === satReq && po2.sameMint === true, 'whichever of the two is the main, a payer with sats alone pays in sats', JSON.stringify(po2 && po2.read && po2.read.unit));
    await payer(KEEPER_MINT, 1000, 50000, 'dollars');
    po2 = A.tapOfferOf(pair({ inv: 'lnbcsat-pair' }));
    ok(po2 && po2.req === usdReq, 'holding enough of both, chosen to hold dollars: dollars', JSON.stringify(po2 && po2.read && po2.read.unit));
    await payer(KEEPER_MINT, 1000, 50000, 'both');
    po2 = A.tapOfferOf(pair({ inv: 'lnbcsat-pair' }));
    ok(po2 && po2.req === satReq, 'holding enough of both, chosen both: the till’s main', JSON.stringify(po2 && po2.read && po2.read.unit));
    await payer(KEEPER_MINT, 300, 1000);
    po2 = A.tapOfferOf(pair({ inv: 'lnbcsat-pair' }));
    ok(po2 && po2.req === satReq && po2.sameMint === true, 'too little of either: the main, which says what it says of a request not covered', JSON.stringify(po2 && po2.read && po2.read.unit));
    // at the other mint of the set, which issues no dollars and is listed on the sat request alone
    await payer(OWN_MINT, 1000, 50000);
    po2 = A.tapOfferOf(pair({ inv: 'lnbcsat-pair' }));
    ok(po2 && po2.req === satReq && po2.sameMint === true, 'a payer at a mint of the set listed for sats alone: the sat request, paid there', JSON.stringify(po2 && po2.read && po2.read.unit));
    // at a mint the till does not take
    await payer('https://far.example.org', 1000, 50000);
    po2 = A.tapOfferOf(pair({ inv: 'lnbcsat-pair' }));
    ok(po2 && po2.req === satReq && po2.sameMint === false && po2.inv === 'lnbcsat-pair', 'a payer at a mint the till does not take: the main, and its invoice, which lands in the main', JSON.stringify(po2 && { s: po2.sameMint, i: po2.inv }));
    po2 = A.tapOfferOf(JSON.stringify({ v: 2, inv: 'lnbcusd-pair', req: usdReq, req2: satReq, up: true }));
    ok(po2 && po2.req === usdReq && po2.inv === 'lnbcusd-pair' && po2.sameMint === false && !po2.notSats,
       'dollars first, from a mint it does not take: the dollar invoice, which lands in dollars', JSON.stringify(po2 && { r: po2.read && po2.read.unit, n: po2.notSats }));
    po2 = A.tapOfferOf(JSON.stringify({ v: 2, req: usdReq, req2: satReq, up: true }));
    ok(po2 && po2.req === satReq && po2.crossable === true && JSON.stringify(po2.mints) === JSON.stringify([KEEPER_MINT, OWN_MINT]),
       'no invoice on the offer: the sat request, crossed into the default', JSON.stringify(po2 && { c: po2.crossable, m: po2.mints }));
    po2 = A.tapOfferOf(JSON.stringify({ v: 2, req: usdReq, up: true }));
    ok(po2 && /dollars at a mint you do not use/.test(String(po2.notSats)), 'an offer with no req2 is unchanged: a dollar request at another mint, no invoice, refused', JSON.stringify(po2 && po2.notSats));

    /* ---- 18e. a card at a till in both (the keeper, 2026-11-02) ------------------------------------------------------ */
    W = stubWallet({ pin: '2468' });
    W.mints = () => [MINT, OWN_MINT];
    W.twoUnits = () => true; W.mintUnits = () => ['sat', 'usd'];
    W.walletChoice = () => ({ hold: 'both' });
    W.cardOnline = () => true;
    await fresh(W, { balUsdCents: 1234 });
    A.tillStart({ unit: 'both', main: 'sat', mint: MINT, mints: [MINT, OWN_MINT] }); await settle();
    A.setState({ amount: '5.00', unit: 'USD', screen: 'confirm', stack: ['amount'], invoice: 'lnbcsat-card', recvRail: 'LIGHTNING' }); await settle();
    const runs = [];
    const wasRun = A.fcPayRun, wasW = A.fcW, wasGo = A.fcXmGo, wasOpen = A.fcXmOpen;
    A.fcW = () => W;
    A.fcPayRun = (sats, pin, offline, resuming, share, send, usd, terms) => { runs.push({ sats, usd, terms, asks: A.fcAsks(sats, usd, terms, send) }); };
    A.payByCard(); await settle();
    const run0 = runs[0] || {};
    ok(runs.length === 1 && run0.usd && run0.usd.both === true && JSON.stringify(run0.asks) === JSON.stringify([{ unit: 'usd', amount: 500 }, { unit: 'sat', amount: 6112 }]),
       'a card at a till in bitcoin first is asked 500 cents or the invoice’s 6,112 sats: a dollar card at the default pays dollars, kept as dollars', JSON.stringify(runs));
    // and with no invoice made yet: the card is taken all the same, for the keypad's figure (the keeper, 2026-11-02)
    A.setState({ invoice: '' }); await settle();
    A.payByCard(); await settle();
    ok(runs.length === 2 && runs[1].usd && runs[1].usd.both === true && runs[1].asks.length === 2 && runs[1].asks[1].amount === 6250,
       'before any invoice, CARD at a till in both is taken at once: 500 cents or 6,250 sats at this phone’s price', JSON.stringify(runs[1]));
    runs.pop();
    A.setState({ invoice: 'lnbcsat-card' }); await settle();
    A.fcPayRun = wasRun;
    // a card at the other mint of the set: taken there, no crossing
    const visits = [], opened = [];
    A.fcXmGo = (x, then) => { visits.push(Object.assign({ then }, x)); };
    A.fcXmOpen = (x) => { opened.push(x); };
    A.fcXmBegin({ card: 'other-mint', mint: OWN_MINT, cardUnit: 'usd', key: 'k1', balance: 2000 }, 6250, false, run0.usd);
    ok(visits.length === 1 && visits[0].mint === OWN_MINT && visits[0].tillAway === true && opened.length === 0 && A._fcTillAway && A._fcTillAway.mint === OWN_MINT,
       'a card at another mint of the till: the phone visits that mint to take it there, and no invoice is paid from it', JSON.stringify([visits, opened]));
    // there, the card is asked as at the default, in either currency, and pays this phone's pile at that mint
    A.fcPayRun = (sats, pin, offline, resuming, share, send, usd, terms) => { runs.push({ sats, usd, terms, asks: A.fcAsks(sats, usd, terms, send) }); };
    if (visits[0] && visits[0].then) visits[0].then();
    const run1 = runs[1] || {};
    ok(runs.length === 2 && run1.usd && run1.usd.both === true && !run1.terms && run1.asks.length === 2 && run1.asks[0].unit === 'usd' && run1.asks[0].amount === 500,
       'and at that mint the card is asked as at the default: no crossing, no quote, its dollars kept there', JSON.stringify(run1));
    A.fcPayRun = wasRun;
    // a card at a mint the till does not take: its mint pays the till's invoice, in the main
    A._fcTillAway = null;
    A.fcXmBegin({ card: 'other-mint', mint: 'https://far.example.org', cardUnit: 'usd', key: 'k2', balance: 2000 }, 6250, false, run0.usd);
    ok(visits.length === 1 && opened.length === 1 && opened[0].mint === 'https://far.example.org' && opened[0].bolt11 === 'lnbcsat-card' && opened[0].ask.unit === 'sat' && opened[0].ask.amount === 6112,
       'a card at a mint the till does not take: it pays the invoice in the main, bitcoin', JSON.stringify(opened));
    A.fcXmGo = wasGo; A.fcXmOpen = wasOpen; A.fcW = wasW;
    A.setState({ fcXm: null, screen: 'confirm', stack: ['amount'] }); await settle();
    A.closeReceive(); await settle();
    A.tillEnd(); await settle();
  }

  // ---- 19. the road to the mint, opened as a screen that will ask it something opens ----------------------------------
  {
    const W = stubWallet({ pin: '2468' });
    await fresh(W);
    let n = W.calls.warms;
    await keeperTill(W);
    ok(tillAmount() && W.calls.warms === n + 1, 'opening the till: the road to the mint is opened for the first invoice', String(W.calls.warms - n));
    n = W.calls.warms;
    A.setState({ screen: 'paid', stack: [], recv: { live: 'in' }, recvResolved: true }); await settle(); V().dismissPaid(); await wait(560); await settle();
    ok(tillAmount() && W.calls.warms === n + 1, 'PAID back to SET AMOUNT: opened again for the next customer’s invoice (the wallet holds it to once a minute)',
       String(W.calls.warms - n));
    A.tillEnd(); await settle();
    await fresh(W);
    n = W.calls.warms;
    A.setState({ screen: 'amount', flow: 'send', stack: ['home'], amount: '', unit: 'USD' }); await settle();
    ok(W.calls.warms === n, 'SEND’s keypad with nothing typed: nothing opened yet', String(W.calls.warms - n));
    A.press('5'); await settle();
    ok(W.calls.warms === n + 1, 'the keypad reaching an amount: the road is opened for the fee quote after NEXT', String(W.calls.warms - n));
    A.press('0'); await settle();
    ok(W.calls.warms === n + 1, 'and typing on asks nothing more', String(W.calls.warms - n));
    await fresh(W);
    n = W.calls.warms;
    A.setState({ screen: 'amount', flow: 'receive', stack: ['home'], amount: '', unit: 'USD' }); await settle();
    ok(W.calls.warms === n + 1, 'a receive’s amount screen, outside the till, as before', String(W.calls.warms - n));
    await fresh(W);
    n = W.calls.warms;
    A.setState({ screen: 'flashcard', stack: ['home'] }); await settle();
    ok(W.calls.warms === n + 1, 'a card’s screen: opened for the load or the claim after it', String(W.calls.warms - n));
    await fresh(W);
  }

  // ---- 20. tips: ACCEPT TIPS?, who they go to, the tip buttons, CASHIER CODES as a list ------------------------------------
  {
    const ID = (n) => '02' + String(n).repeat(64).slice(0, 64);
    const NO = (n) => String(n).repeat(64).slice(0, 64);
    const contacts = () => [
      { handle: 'foxyid1ana', name: 'Ana', at: 1, cid: { id: ID(1), nostr: NO(1) } },
      { handle: 'foxyid1ben', name: 'Ben', at: 2, cid: { id: ID(2), nostr: NO(2) } },
    ];
    const typeInCard = async (text, label) => {
      const f = A._blockedEl && A._blockedEl.querySelector('input');
      if (f) f.value = text;
      press(A._blockedEl, label); await settle();
    };
    const pressCard = async (label) => { press(A._blockedEl, label); await settle(); };
    const mr = () => A.renderMints({ s: A.state, sc: 'switchMint' });
    const openTill = async (W) => { await fresh(W); A.tillOpen(); await settle(); };

    // 20a: YES, MYSELF
    let W = stubWallet({ pin: '2468' });
    await openTill(W);
    ok(tipsAsked() && /YES/.test(card()) && /NO/.test(card()) && /\$1, \$2, \$5 and OTHER/.test(card()), '20a ACCEPT TIPS?: YES or NO, and what payers will see', card());
    await pressCard('YES');
    ok(/TIPS GO TO/.test(card()) && /MYSELF/.test(card()) && /ONE PERSON/.test(card()) && /GROUP/.test(card()), 'YES: TIPS GO TO, MYSELF, ONE PERSON, GROUP', card());
    await pressCard('BACK');
    ok(tipsAsked(), 'BACK off TIPS GO TO: ACCEPT TIPS? again');
    await pressCard('YES'); await pressCard('MYSELF');
    ok(A.state.till && tillAmount() && JSON.stringify(A.state.till.tips) === JSON.stringify({ on: true, to: 'self', ids: [] }) && W.calls.tipsSet.length === 1,
      'MYSELF: the till opens, its tips to the keeper, kept with the till', JSON.stringify(A.state.till && A.state.till.tips));

    // walked away from: no till, the wallet's record let go
    W = stubWallet({ pin: '2468' });
    await openTill(W);
    A._blockedEl.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); await settle();
    ok(!A.state.till && W.calls.keeperCloses === 1 && W.calls.tipsSet.length === 0, 'ACCEPT TIPS? closed with no answer: no till, the wallet told to let go', JSON.stringify([A.state.screen, W.calls.keeperCloses]));

    // ONE PERSON: a contact
    W = stubWallet({ pin: '2468' });
    W.cids = contacts();
    await openTill(W);
    await pressCard('YES'); await pressCard('ONE PERSON');
    let rm = mr();
    ok(A.state.screen === 'switchMint' && A.state.tillList === 'person' && rm.mintTitle === 'TIPS GO TO' && rm.mintRows.map((r) => r.name).join() === 'Ana,Ben'
      && rm.tillAddLabel === 'PASTE A CASHU ID' && rm.tillNextLabel === 'SCAN A CASHU ID' && rm.mintPickers === false,
      'ONE PERSON: the SWITCH MINT list of Cashu ID contacts, PASTE and SCAN under it', JSON.stringify([rm.mintTitle, rm.mintRows.map((r) => r.name), rm.tillAddLabel, rm.tillNextLabel]));
    A.back(); await settle();
    ok(/TIPS GO TO/.test(card()) && A.state.screen !== 'switchMint', 'back off it: TIPS GO TO again');
    await pressCard('ONE PERSON');
    mr().mintRows[1].tap(); await settle();
    ok(A.state.till && A.state.till.tips.to === 'one' && A.state.till.tips.ids.length === 1 && A.state.till.tips.ids[0].id === ID(2) && A.state.till.tips.ids[0].name === 'Ben'
      && A.state.till.tips.ids[0].pct === 100 && A.state.screen === 'amount' && !A.state.tillList,
      'a contact tapped: tips to Ben, 100%, and the till opens', JSON.stringify(A.state.till && A.state.till.tips));

    // ONE PERSON: pasted, not a contact: NAME THIS CONTACT? first, kept as one
    W = stubWallet({ pin: '2468' });
    W.idTexts = { foxyid1dee: { id: ID(4), nostr: NO(4) }, foxyid1me: { id: ID(5), nostr: NO(5), own: true } };
    await openTill(W);
    await pressCard('YES'); await pressCard('ONE PERSON');
    ok(mr().mintNowLine === 'No Cashu ID contacts yet. Paste or scan one.', 'with no contacts, the line says to paste or scan one');
    mr().tillAdd(); await settle();
    ok(/PASTE A CASHU ID/.test(card()) && !!A._blockedEl.querySelector('input'), 'PASTE A CASHU ID: a card with a field');
    await typeInCard('foxyid1me', 'NEXT'); await settle();
    ok(/THIS IS YOUR CASHU ID/.test(card()) && /MYSELF/.test(card()), 'this phone’s own: pick MYSELF instead', card());
    shutCard(); await settle();
    mr().tillAdd(); await settle();
    await typeInCard('nonsense', 'NEXT'); await settle();
    ok(/THAT WON’T WORK/.test(card()) && /not a Cashu ID/.test(card()), 'one that is not an ID is refused in the contacts’ words', card());
    shutCard(); await settle();
    mr().tillAdd(); await settle();
    await typeInCard('foxyid1dee', 'NEXT'); await settle();
    ok(/NAME THIS CONTACT\?/.test(card()), 'an ID that is not a contact: NAME THIS CONTACT? first', card());
    await typeInCard('', 'SAVE'); await settle();
    ok(/NAME THIS CONTACT\?/.test(card()) && !A.state.till, 'no name: asked again, nothing kept');
    await typeInCard('Dee', 'SAVE'); await settle(); await settle();
    ok(W.calls.cidAdds.length === 1 && W.calls.cidAdds[0][1] === 'Dee' && A.state.till && A.state.till.tips.ids[0].name === 'Dee' && A.state.till.tips.ids[0].id === ID(4),
      'named Dee: kept as a contact, and the tips go to Dee', JSON.stringify(A.state.till && A.state.till.tips));

    // GROUP: rows, shares that add up to 100, ADD, REMOVE, SAVE
    W = stubWallet({ pin: '2468' });
    W.cids = contacts().concat([{ handle: 'foxyid1cy', name: 'Cy', at: 3, cid: { id: ID(3), nostr: NO(3) } }]);
    await openTill(W);
    await pressCard('YES'); await pressCard('GROUP');
    rm = mr();
    ok(A.state.tillList === 'group' && rm.mintTitle === 'GROUP' && rm.mintRows.length === 0 && rm.tillAddLabel === 'ADD' && rm.tillNextLabel === 'SAVE' && rm.tillNextBg !== 'var(--acc)',
      'GROUP: an empty list, ADD, and SAVE grey', JSON.stringify([rm.mintTitle, rm.tillAddLabel, rm.tillNextLabel, rm.tillNextBg]));
    rm.tillNext(); await settle();
    ok(A.state.tillList === 'group' && !A.state.till && toasts.slice(-1)[0] === 'Add someone first.', 'SAVE with nobody: nothing, and why', toasts.slice(-1)[0]);
    rm.tillAdd(); await settle();
    ok(A.state.tillList === 'person' && mr().mintTitle === 'ADD TO THE GROUP', 'ADD: the contacts, to add one');
    mr().mintRows[0].tap(); await settle();
    rm = mr();
    ok(A.state.tillList === 'group' && rm.mintRows.length === 1 && rm.mintRows[0].text === '100%' && rm.tillNextBg === 'var(--acc)', 'Ana added: the whole 100%, and SAVE in fur', JSON.stringify(rm.mintRows.map((r) => r.text)));
    rm.tillAdd(); await settle();
    ok(mr().mintRows.map((r) => r.name).join() === 'Ben,Cy', 'one already in the group is not offered again');
    mr().mintRows[0].tap(); await settle();
    rm = mr();
    ok(rm.mintRows.map((r) => r.text).join() === '100%,0%' && rm.tillNextBg !== 'var(--acc)' && /add up to 100% of 100%/.test(rm.mintNowLine),
      'Ben added with what is left, 0%: SAVE grey', JSON.stringify([rm.mintRows.map((r) => r.text), rm.mintNowLine]));
    rm.mintRows[0].tap(); await settle();
    ok(/ANA/.test(card()) && !!A._blockedEl.querySelector('input') && /REMOVE/.test(card()), 'a row tapped: its share in a field, SET, REMOVE', card());
    await typeInCard('60', 'SET');
    mr().mintRows[1].tap(); await settle();
    await typeInCard('150', 'SET');
    ok(toasts.slice(-1)[0] === 'A share is a whole percent from 1 to 100.' && mr().mintRows[1].text === '0%', 'a share over 100 is refused');
    mr().mintRows[1].tap(); await settle();
    await typeInCard('40', 'SET');
    rm = mr();
    ok(rm.mintRows.map((r) => r.text).join() === '60%,40%' && rm.tillNextBg === 'var(--acc)' && /add up to 100% of 100%/.test(rm.mintNowLine), '60 and 40: SAVE in fur');
    rm.tillAdd(); await settle(); mr().mintRows[0].tap(); await settle();
    ok(mr().mintRows.length === 3 && mr().mintRows[2].text === '0%' && mr().tillNextBg !== 'var(--acc)', 'Cy added at 0%: SAVE grey again');
    mr().mintRows[2].tap(); await settle(); await pressCard('REMOVE');
    rm = mr();
    ok(rm.mintRows.length === 2 && rm.tillNextBg === 'var(--acc)', 'REMOVE: Cy off, SAVE in fur');
    A.back(); await settle();
    ok(/TIPS GO TO/.test(card()), 'back off the group: TIPS GO TO again');
    await pressCard('GROUP');
    ok(mr().mintRows.length === 0, '(GROUP again starts from the till’s answer, here none)');
    mr().tillAdd(); await settle(); mr().mintRows[0].tap(); await settle();
    mr().tillAdd(); await settle(); mr().mintRows[0].tap(); await settle();
    mr().mintRows[0].tap(); await settle(); await typeInCard('70', 'SET');
    mr().mintRows[1].tap(); await settle(); await typeInCard('30', 'SET');
    mr().tillNext(); await settle();
    ok(A.state.till && A.state.till.tips.to === 'group' && A.state.till.tips.ids.map((r) => r.name + r.pct).join() === 'Ana70,Ben30' && W.calls.tipsSet.slice(-1)[0].to === 'group',
      'SAVE: tips split 70/30, kept with the till, and the till opens', JSON.stringify(A.state.till && A.state.till.tips));
    // eight at most: ADD gone at eight
    A.setState({ screen: 'switchMint', stack: ['amount'], tillList: 'group', tillGroup: Array.from({ length: 8 }, (_, i) => ({ id: ID(i + 1), nostr: NO(i + 1), name: 'P' + i, pct: i ? 12 : 16 })) });
    await settle();
    ok(mr().tillAddShown === false && mr().tillNextBg === 'var(--acc)', 'a group of eight: no ADD');
    A.back(); await settle();

    // 20b: the tip buttons on the keeper's receive screen
    W = stubWallet({ pin: '2468' });
    await fresh(W);
    A.tillStart({ unit: 'sat', tips: { on: true, to: 'one', ids: [{ id: ID(1), nostr: NO(1), name: 'Ana', pct: 100 }] } }); await settle();
    A.setState({ amount: '10', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    let v = V();
    ok(v.tipRowShown === false && v.tipAddShown === true && v.tipChips.length === 0 && /ADD A TIP/.test(textOf(w)) && !/\$1\$2\$5OTHER/.test(textOf(w).replace(/\s/g, '')),
      '20b the till’s receive: the tips folded into one ADD A TIP, the buttons not drawn', JSON.stringify([v.tipRowShown, v.tipAddShown, v.tipChips.length]));
    v.tipAdd(); await settle();
    v = V();
    ok(v.tipAddShown === false && !/ADD A TIP/.test(textOf(w)), 'ADD A TIP tapped: it gives way to the row');
    ok(v.tipRowShown === true && v.tipChips.map((c) => c.label).join() === '$1,$2,$5,OTHER' && v.tipLine === 'TIP', '20b the till’s receive: $1, $2, $5, OTHER under the amount, no NO',
      JSON.stringify(v.tipChips.map((c) => c.label)));
    ok(/\$1\$2\$5OTHER/.test(textOf(w).replace(/\s/g, '')), 'and drawn');
    const inv0 = W.calls.invoices.length;
    v.tipChips[1].tap(); await settle();
    v = V();
    ok(A.state.amount === '12' && A.state.tillTip && A.state.tillTip.cents === 200 && A.state.tillTip.base === '10' && v.tipChips[1].bg === 'var(--acc)'
      && v.tipLine === 'Includes a $2.00 tip', '$2: the amount is $12, the tip on it, its button lit', JSON.stringify([A.state.amount, A.state.tillTip, v.tipLine]));
    ok(W.calls.invoices.length === inv0 + 1 && W.calls.invoices[inv0].amount === 15000, 'and the invoice is made again for the total, 15,000 sats', JSON.stringify(W.calls.invoices.slice(inv0)));
    ok(v.confirmAmount === '$ 12.00', 'the amount on screen is the total', v.confirmAmount);
    v.tipChips[1].tap(); await settle();
    ok(A.state.amount === '10' && !A.state.tillTip && W.calls.invoices.length === inv0 + 2 && W.calls.invoices[inv0 + 1].amount === 12500, 'the same tip again takes it off: $10, the invoice again');
    V().tipChips[0].tap(); await settle(); V().tipChips[2].tap(); await settle();
    ok(A.state.amount === '15' && A.state.tillTip.cents === 500 && A.state.tillTip.base === '10', '$1 then $5: $15, the tip $5 on the $10', JSON.stringify(A.state.tillTip));
    V().tipChips[3].tap(); await settle();
    ok(A.state.screen === 'amount' && A.state.flow === 'tillTip' && V().amountTitle === 'TIP' && V().amountSubtitle === 'How much is the tip?' && A.state.amount === '',
      'OTHER: SET AMOUNT for the tip', JSON.stringify([A.state.screen, A.state.flow, V().amountTitle]));
    A.back(); await settle(); await wait(30); await settle();
    ok(A.state.screen === 'confirm' && A.state.amount === '15' && A.state.tillTip && A.state.tillTip.pick === 500, 'back off it: the receive, with the $5 tip it had', JSON.stringify([A.state.screen, A.state.amount]));
    V().tipChips[3].tap(); await settle();
    A.press('3'); A.press('5'); A.press('0'); await settle();
    V().next(); await settle(); await wait(30); await settle();
    v = V();
    ok(A.state.screen === 'confirm' && A.state.amount === '13.50' && A.state.tillTip.cents === 350 && A.state.tillTip.pick === 'other' && v.tipChips[3].label === '$3.50',
      'a tip of $3.50 typed: $13.50, OTHER says $3.50', JSON.stringify([A.state.amount, A.state.tillTip, v.tipChips[3].label]));
    ok(['till', 'one', 'self', 'confirm'].indexOf(A.state.screen) >= 0 && !!A.state.till, 'still in the till');
    // back to SET AMOUNT: the amount typed, no tip
    A.back(); await settle(); await settle();
    ok(tillAmount() && A.state.amount === '10' && !A.state.tillTip, 'back to SET AMOUNT: $10 again, no tip', JSON.stringify([A.state.screen, A.state.amount]));
    // PAID with a tip: the tip part to the wallet
    A.setState({ amount: '10', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    ok(V().tipAddShown === true && V().tipRowShown === false, 'the next invoice: ADD A TIP folded again');
    V().tipAdd(); await settle();
    V().tipChips[1].tap(); await settle();
    ok(V().tipRowShown === true && V().tipAddShown === false, 'a tip chosen: the row stays open, its line said', V().tipLine);
    W.tips = A.state.till.tips;
    A.setState({ screen: 'paid', stack: ['amount', 'confirm'], paidUnit: 'sat', paidAmount: 15000, paidHash: 'sale-1' }); await settle(); await settle();
    ok(W.calls.tipTaken.length === 1 && W.calls.tipTaken[0].amount === 2500 && W.calls.tipTaken[0].unit === 'sat' && W.calls.tipTaken[0].hash === 'sale-1',
      'PAID 15,000 sats for $10 + $2: 2,500 sats of it passed on as the tip, by the sale’s row', JSON.stringify(W.calls.tipTaken));
    ok(/^Tip .* · goes to Ana$/.test(toasts.slice(-1)[0] || ''), 'and said', toasts.slice(-1)[0]);
    A.setState({ screen: 'paid', stack: ['amount'], paidUnit: 'sat', paidAmount: 9000, paidHash: 'sale-2' }); await settle();
    ok(W.calls.tipTaken.length === 1, 'a later PAID with no tip on screen passes nothing on');
    // a request paid: the receive closes before PAID, and the tip still goes
    A.setState(Object.assign({}, A.homeState())); await settle();
    A.setState({ amount: '10', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    ok(V().tipAddShown === true, 'after PAID, the next sale’s receive starts folded');
    V().tipAdd(); await settle();
    V().tipChips[0].tap(); await settle();
    A.setState({ screen: 'home', stack: [] }); await settle(); await settle();
    ok(tillAmount() && A.state.amount === '', '(a request paid closes the receive: the till’s SET AMOUNT)');
    A.setState({ screen: 'paid', stack: ['amount'], paidUnit: 'usd', paidAmount: 1100, paidHash: 'req-abc' }); await settle();
    ok(W.calls.tipTaken.length === 2 && W.calls.tipTaken[1].amount === 100 && W.calls.tipTaken[1].unit === 'usd', 'and its PAID, $11 in dollars, passes on the $1', JSON.stringify(W.calls.tipTaken[1]));
    // tips off: no buttons
    A.tillEnd(); await settle();
    await fresh(W);
    A.tillStart({ unit: 'sat' }); await settle();
    A.setState({ amount: '10', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    ok(V().tipRowShown === false && V().tipAddShown === false && !/OTHER/.test(textOf(w)) && !/ADD A TIP/.test(textOf(w)), 'a till with tips off: no tip buttons, no ADD A TIP');
    A.tillEnd(); await settle();
    // in sats typed: the tip in sats at the price
    await fresh(W);
    A.tillStart({ unit: 'sat', tips: { on: true, to: 'self', ids: [] } }); await settle();
    A.setState({ amount: '10000', unit: 'SATS', screen: 'confirm', stack: ['amount'] }); await settle();
    V().tipAdd(); await settle();
    V().tipChips[0].tap(); await settle();
    ok(A.state.amount === '11250' && A.state.tillTip.num === 1250 && A.state.tillTip.den === 11250, 'sats typed: $1 is 1,250 sats more, the tip 1,250 of 11,250', JSON.stringify(A.state.tillTip));
    A.tillEnd(); await settle();

    // 20c: a cashier on a code with tips, and without
    W = stubWallet({});
    await cashierTill(W, passOf({ tips: true }));
    A.setState({ amount: '10', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    ok(V().tipAddShown === true && V().tipRowShown === false, '20c a cashier on a code with tips: ADD A TIP');
    V().tipAdd(); await settle();
    ok(V().tipRowShown === true, 'and tapped, the buttons');
    V().tipChips[2].tap(); await settle();
    A._creqs = {};
    A.railRequest(18750); await settle();
    let rq = W.calls.requests.filter((r) => r.amount === 18750).slice(-1)[0];
    ok(rq && rq.opts.lockPub === LOCK && rq.opts.tillTip === 6250, 'its request for $15 (18,750 sats) names the keeper’s lock and the $5 tip, 6,250 sats', JSON.stringify(rq && rq.opts));
    const ia = W.calls.invoices.slice(-1)[0];
    ok(ia && ia.opts && ia.opts.lockPub === LOCK && ia.opts.tillTip === 6250, 'and so does its invoice', JSON.stringify(ia && ia.opts));
    A.tapOnlyRequest(18750);
    rq = W.calls.requests.slice(-1)[0];
    ok(rq && rq.opts.tillTip === 6250, 'and a tap’s request');
    const keyTip = Object.keys(A._creqs).filter((k) => /\|tip/.test(k));
    ok(keyTip.length >= 1, 'a request with a tip is kept apart from one without', Object.keys(A._creqs).join(' '));
    A.setState({ screen: 'paid', stack: ['amount'], paidUnit: 'sat', paidAmount: 18750, paidHash: 'till-x' }); await settle();
    ok(W.calls.tipTaken.length === 0, 'a cashier’s PAID passes nothing on itself: its delivery says the tip, and the keeper passes it on');
    A.tillEnd(); await settle();
    W = stubWallet({});
    await cashierTill(W, passOf());
    A.setState({ amount: '10', unit: 'USD', screen: 'confirm', stack: ['amount'] }); await settle();
    ok(V().tipRowShown === false && V().tipAddShown === false, 'a cashier on a code without tips: none');
    A.railRequest(12500); await settle();
    rq = W.calls.requests.slice(-1)[0];
    ok(rq && !('tillTip' in rq.opts), 'and no tip on its requests');
    A.tillEnd(); await settle();

    // 20d: CASHIER CODES as a list: ADD, several at once, a row again with END, PAST
    W = stubWallet({ pin: '2468' });
    await fresh(W);
    A.tillStart({ unit: 'sat', tips: { on: true, to: 'one', ids: [{ id: ID(1), nostr: NO(1), name: 'Ana', pct: 100 }] } }); await settle();
    V().amtCodeTap(); await settle(); await typePin('2468');
    rm = mr();
    ok(A.state.tillList === 'codes' && rm.mintTitle === 'CASHIER CODES' && rm.mintRows.length === 0 && rm.tillNextLabel === 'ADD A CASHIER' && /No code is live/.test(rm.mintNowLine)
      && rm.tillPastShown === false, '20d CASHIER CODES: none live yet, ADD A CASHIER', JSON.stringify([rm.mintTitle, rm.mintNowLine]));
    rm.tillNext(); await settle();
    ok(/NAME THIS CODE\?/.test(card()), 'ADD A CASHIER: a name for its row first');
    await typeInCard('Front', 'NEXT');
    ok(tipsAsked() && /Now: Tips to Ana/.test(card()), 'then ACCEPT TIPS?, the till’s answer said', card());
    await pressCard('NO'); await settle(); await settle();
    let po = W.calls.passOpts.slice(-1)[0];
    ok(po && po.fresh === true && po.label === 'Front' && po.tips && po.tips.on === false && stage() && stage().getAttribute('data-stage') === 'tillPass' && /No tips/.test(stage().textContent),
      'NO: a fresh code, labelled, without tips, its QR shown', JSON.stringify(po));
    press(stage(), 'DONE'); await settle();
    mr().tillNext(); await settle();
    await typeInCard('Patio', 'NEXT'); await pressCard('YES'); await pressCard('MYSELF'); await settle(); await settle();
    po = W.calls.passOpts.slice(-1)[0];
    ok(po && po.label === 'Patio' && po.tips.on && po.tips.to === 'self' && /Tips to you/.test(stage().textContent), 'another, Patio, with tips to the keeper', JSON.stringify(po));
    press(stage(), 'DONE'); await settle();
    rm = mr();
    ok(rm.mintRows.length === 2 && rm.mintRows.map((r) => r.name).join() === 'Front,Patio' && rm.mintRows.every((r) => r.text === 'LIVE')
      && /No tips/.test(rm.mintRows[0].host) && /Tips to you/.test(rm.mintRows[1].host) && /Ends /.test(rm.mintRows[0].host) && /bitcoin/.test(rm.mintRows[0].host),
      'two live at once, each with its mint, currency, tips and end', JSON.stringify(rm.mintRows.map((r) => [r.name, r.host])));
    rm.mintRows[0].tap(); await settle();
    ok(stage() && /END THIS CODE/.test(stage().textContent) && /Front/.test(stage().textContent), 'a row tapped: its QR again, with END THIS CODE');
    press(stage(), 'END THIS CODE'); await settle();
    ok(/END THIS CODE\?/.test(card()) && /not told/.test(card()), 'END asks first, and says its cashier is not told', card());
    await pressCard('END'); await settle();
    rm = mr();
    ok(W.calls.passEnds.length === 1 && rm.mintRows.length === 1 && rm.mintRows[0].name === 'Patio' && rm.tillPastShown === true && rm.tillPastRows.length === 1
      && rm.tillPastRows[0].name === 'Front' && rm.tillPastRows[0].text === 'ENDED' && / – /.test(rm.tillPastRows[0].host),
      'ended: Front under PAST, ENDED, with when it ran; Patio still live', JSON.stringify([rm.mintRows.map((r) => r.name), rm.tillPastRows.map((r) => [r.name, r.text, r.host])]));
    ok(/PAST/.test(textOf(w)) && /ENDED/.test(textOf(w)), 'PAST drawn under the live ones');
    ok(!/\$ ?\d/.test(rm.mintRows.concat(rm.tillPastRows).map((r) => r.host + r.text).join(' ')), 'no figure of what any code took, anywhere on the list');
    W.passes.forEach((x) => { if (x.label === 'Patio') x.exp = Math.floor(Date.now() / 1000) - 10; });
    A.setState({ menuTick: 1 }); await settle();
    rm = mr();
    ok(rm.mintRows.length === 0 && rm.tillPastRows.map((r) => r.name + ':' + r.text).sort().join() === 'Front:ENDED,Patio:EXPIRED', 'run out: EXPIRED under PAST too');
    A.back(); await settle();
    ok(tillAmount(), 'back off the list: the till');
    A.tillEnd(); await settle();
  }

  // ---- 21. the till's receive screen: no NOTE, COPY, SCAN or CARD; PAY WITH FOXY CARD in SHARE's place ----------------------
  {
    const W = stubWallet({});
    await fresh(W);
    const rounds = () => ['NOTE', 'COPY', 'SCAN', 'CARD'].filter((l) => Array.prototype.slice.call(w.document.querySelectorAll('div'))
      .some((d) => d.textContent === l && d.children.length === 0));
    // outside the till: as ever
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['home'], invoice: 'lnbc-plain', recvRail: 'LIGHTNING' }); await settle();
    let v = V();
    eq(rounds(), ['NOTE', 'COPY', 'SCAN', 'CARD'], '21 the ordinary receive: NOTE, COPY, SCAN and CARD drawn');
    ok(v.recvRoundShown === true && v.recvBigLabel === 'SHARE' && /SHARE/.test(textOf(w)) && !/PAY WITH FOXY CARD/.test(textOf(w)), 'and SHARE, no PAY WITH FOXY CARD');
    let paid = 0;
    const wasPay = A.payByCard;
    A.payByCard = () => { paid += 1; };
    let shared = 0;
    const wasShare = W.share;
    W.share = () => { shared += 1; return true; };
    V().recvBigTap(); await settle();
    ok(shared === 1 && paid === 0, 'SHARE there shares the code', JSON.stringify([shared, paid]));
    A.setState(A.homeState()); await settle();
    // the keeper's till
    A.tillStart({ unit: 'sat' }); await settle();
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'], invoice: 'lnbc-till', recvRail: 'LIGHTNING' }); await settle();
    v = V();
    eq(rounds(), [], 'the till’s receive: none of NOTE, COPY, SCAN, CARD drawn');
    ok(v.recvRoundShown === false && v.recvBigLabel === 'PAY WITH FOXY CARD' && /PAY WITH FOXY CARD/.test(textOf(w)) && !/SHARE/.test(textOf(w)),
      'the big button reads PAY WITH FOXY CARD, no SHARE', v.recvBigLabel);
    ok(v.recvBigDim === '1' && v.recvCardShown === true, 'not greyed where CARD would be there');
    v.recvBigTap(); await settle();
    ok(paid === 1 && shared === 1, 'PAY WITH FOXY CARD does what CARD did: the card paying this invoice, nothing shared', JSON.stringify([paid, shared]));
    v.shareQr(); await settle();
    ok(shared === 1, 'and SHARE’s own way in shares nothing in the till');
    ok(/LIGHTNING/.test(textOf(w)) && !/NETWORK/.test(textOf(w)) && !!w.document.querySelector('img[data-req-qr]'), 'the network chip (LIGHTNING, no NETWORK label over it) and the QR stay');
    // a cashier's: CARD was not there, so the button is greyed and does nothing
    await cashierTill(W);
    A.setState({ amount: '1000', unit: 'SATS', screen: 'confirm', stack: ['amount'], recvUnit: 'sat', invoice: 'lnbc-cashier', recvRail: 'LIGHTNING' }); await settle();
    v = V();
    ok(v.recvCardShown === false && v.recvBigDim === '0.35' && v.recvBigLabel === 'PAY WITH FOXY CARD', 'a cashier’s: PAY WITH FOXY CARD greyed, as CARD was absent', JSON.stringify([v.recvBigDim, v.recvCardShown]));
    v.recvBigTap(); await settle();
    ok(paid === 1 && shared === 1, 'and tapped, it begins nothing', JSON.stringify([paid, shared]));
    eq(rounds(), [], 'nor any round button');
    A.payByCard = wasPay; W.share = wasShare;
    A.setState(A.homeState()); await settle();
    A.tillEnd(); await settle();
  }

  const errs = errors.filter((e) => !/never resolved|Not implemented/.test(e));
  ok(!errs.length, 'no errors on the page', errs.slice(0, 3).join(' | '));
  console.log('');
  console.log(failed ? failed + ' of ' + (passed + failed) + ' till screen checks failed' : 'all ' + passed + ' till screen checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
