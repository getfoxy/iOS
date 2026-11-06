'use strict';
/* cashu-id-ui.js — the Cashu ID, as a person sees it (build/app/26o-cashu-id.js).
 *
 *     node tests/cashu-id-ui.js
 *
 *   1  MY CASHU ID is in the menu; it shows the ID's code on the stage screen with SHARE, which hands the string to the
 *      share sheet, and from then on the phone listens for payments to it
 *   2  an ID pasted or scanned (`acceptTarget`) asks NAME THIS CONTACT? with a field; SAVE keeps it under the name typed;
 *      one already a contact starts from its name; your own is said to be yours; a mistyped one is refused in words
 *   3  in CONTACTS an ID reads CASHU ID; tapped, its screen (messages, tests/cashu-msg-ui.js) and PAY; SET AMOUNT asks how much to send to them; NEXT, the confirmation names
 *      them, says once that the money comes back to this phone after thirty days, and SEND pays them by `cashuIdPay`
 *   4  a payment at a mint this phone does not use: PAID AT ANOTHER MINT, with BRING IT HOME (its fee, or grey with why),
 *      KEEP IT THERE, SEND IT BACK where the payer proved who it is, DECIDE LATER and the tick "Always do this for <mint>";
 *      unanswered, a row in HISTORY (At <mint> · tap to decide) that opens it again; SETTINGS > OTHER MINTS lists what was
 *      remembered and forgets it
 *   5  MY CASHU ID has SHARE and DONE and no ANY WALLET button
 *   6  paid to the ID key itself: PAID TO YOUR ID KEY, "<name or Someone> paid you without blinding the key. …", LEAVE IT
 *      first (quiet) and TAKE IT ANYWAY, each answered to `cashuIdUnblinded`
 *
 * The real page, rendered in jsdom by build/foxy-render.js, over a stand-in wallet whose reader of ID strings is the real
 * wallet's (build/wallet/08e-cashu-id.js). Run `python3 tools/pack-index.py` first: this reads build/foxy-app.js. */
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
const PRICE = 80000;
const REAL = loadReal().W;
// two signed IDs (version 2), each from the words of a phone of harness.js's; and Alice's as version 1, unsigned
const seedOfWords = (words) => require('crypto').pbkdf2Sync(Buffer.from(words, 'utf8'), Buffer.from('mnemonic', 'utf8'), 2048, 64, 'sha512');
const KEYS_ALICE = require('./harness').cashuIdKeys(seedOfWords('legal winner thank year wave sausage worth useful legal winner thank yellow'));
const KEYS_MINE = require('./harness').cashuIdKeys(seedOfWords(require('./harness').PHONE_WORDS));
const ID_ALICE = REAL._cashuIdEncode(KEYS_ALICE.id, KEYS_ALICE.nostr, KEYS_ALICE.sig);
const ID_MINE = REAL._cashuIdEncode(KEYS_MINE.id, KEYS_MINE.nostr, KEYS_MINE.sig);
const ID_ALICE_V1 = REAL._cashuIdEncode(KEYS_ALICE.id, KEYS_ALICE.nostr);

function stubWallet() {
  const calls = { shares: [], shown: 0, adds: [], pays: [], listens: 0 };
  const book = [];
  const W = {
    connected: true, mintUrl: MINT,
    mintHost() { return String(W.mintUrl).replace(/^https?:\/\//, ''); },
    mints: () => [MINT],
    qr: (text) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)),
    classify: (t) => REAL.classify(t),
    tagsFor: () => ({}), tag() {}, backedUp: () => true,
    pinIsSet: () => false, faceLock: () => false, screenLocked: () => false, secureChoice: () => 'none',
    reason: (e) => String((e && e.message) || e),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: 50000, mint: MINT }],
    balanceAt: () => 50000, balanceSats: () => Promise.resolve(50000), balanceOf: (u) => (u === 'usd' ? 0 : 50000),
    rate: () => Promise.resolve(PRICE), agreedRate: () => Promise.resolve(PRICE),
    transactions: () => Promise.resolve([]),
    book: () => book.slice(), remember() {},
    listen() { return () => {}; },
    privacy: () => ({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false, network: 'wifi', orbot: 'none', vpn: false }),
    mintUnits: () => ['sat'], twoUnits: () => false, walletChoice: () => ({ hold: '' }), heldIn: () => 0, recoveringIn: () => 0,
    primeLocks: () => Promise.resolve(1), openInbox: () => Promise.reject(new Error('no inbox here')), closeInbox() {},
    watch: () => () => {}, warm: () => Promise.resolve(true), defaultRail: () => 'LIGHTNING',
    lastToken: () => ({}), clearLastToken() {}, pendingMelts: () => [], splitPending: () => null,
    stopPreview() {}, stopPasteButton() {}, notify() {},
    share(text) { calls.shares.push(String(text)); return true; },
    // ---- the Cashu ID's contract (build/wallet/21c-cashu-id.js) ----
    cashuIdMine: () => Promise.resolve({ text: ID_MINE, id: REAL.cashuIdDecode(ID_MINE).id, nostr: REAL.cashuIdDecode(ID_MINE).nostr }),
    cashuIdShown() { calls.shown += 1; return Promise.resolve(1); },
    cashuIdListen() { calls.listens += 1; return Promise.resolve(1); },
    cashuIdDeliver: () => Promise.resolve(0),
    cashuIdLockSeconds: () => 30 * 86400,
    cashuIdCheck(text) {
      const r = REAL.cashuIdDecode(text);
      if (!r) return Promise.reject(new Error(REAL.cashuIdProblem(text)));
      const known = book.find((c) => c.cid && c.cid.id === r.id);
      return Promise.resolve({ id: r.id, nostr: r.nostr, text, own: text === ID_MINE, name: known ? known.name : '' });
    },
    cashuIdAdd(text, name) {
      calls.adds.push([text, name]);
      const r = REAL.cashuIdDecode(text);
      const at = book.findIndex((c) => c.cid && c.cid.id === r.id);
      const row = { handle: text, name, at: Date.now(), cid: r };
      if (at >= 0) book[at] = row; else book.unshift(row);
      return Promise.resolve(row);
    },
    cashuIdPay(who, amount, opts) { calls.pays.push({ who, amount, opts }); return Promise.resolve({ hash: 'cid-h1', token: 'cashuB', sent: true, name: opts && opts.name }); },
  };
  W.calls = calls;
  return W;
}

async function settle() { for (let i = 0; i < 8; i++) await wait(15); }

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
  const shutCard = () => { if (A._blockedEl) A._blockedEl.remove(); A._blockedEl = null; A._blockedKind = null; A._cardQueue = []; };
  const press = (root, label) => {
    const el = root && Array.prototype.slice.call(root.querySelectorAll('div')).filter((d) => d.textContent === label).pop();
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return true;
  };
  const stage = () => w.document.getElementById('foxy-stage');
  const fresh = async (W, state) => {
    w.FoxyWallet = W;
    shutCard();
    A.hideStage();
    toasts = [];
    A.setState(Object.assign({}, initial, { walletLive: true, balSats: 50000, balUsdCents: null, livePrice: PRICE,
      satUsd: PRICE / 1e8, screen: 'home', stack: [], open0: false, menuSettingsOpen: false, till: null, history: [], contacts: W.book() }, state || {}));
    await settle();
  };

  // ---- 1 MY CASHU ID ----
  {
    const W = stubWallet();
    await fresh(W, { open0: true });
    const row = V().menuItems.find((m) => m.label === 'MY CASHU ID');
    ok(!!row, 'MY CASHU ID is a row of the menu', V().menuItems.map((m) => m.label).join(', '));
    row.tap();
    await settle();
    const st = stage();
    ok(!!st && st.getAttribute('data-stage') === 'cashuId' && /MY CASHU ID/.test(st.textContent), 'it opens the stage screen MY CASHU ID');
    const img = st && st.querySelector('[data-stage-qr]');
    ok(!!img && String(img.getAttribute('src')).indexOf(encodeURIComponent(ID_MINE.slice(0, 24))) >= 0, 'with the ID string as its QR code');
    ok(/SHARE/.test(st.textContent) && /DONE/.test(st.textContent), 'SHARE and DONE');
    press(st, 'SHARE');
    ok(W.calls.shares.length === 1 && W.calls.shares[0] === ID_MINE, 'SHARE hands the ID string to the share sheet');
    ok(W.calls.shown === 1, 'and showing it is what starts the listening');
    press(st, 'DONE');
    await settle();
    ok(!stage(), 'DONE closes it');
  }

  // ---- 2 adding by paste ----
  {
    const W = stubWallet();
    await fresh(W);
    ok(REAL.classify(ID_ALICE) === 'cashuid', 'a pasted ID is a cashuid to the wallet');
    A.acceptTarget(ID_ALICE);
    await settle();
    ok(/NAME THIS CONTACT\?/.test(card()), 'pasted, it asks NAME THIS CONTACT?', card());
    const field = A._blockedEl && A._blockedEl.querySelector('input');
    ok(!!field && field.value === '', 'with an empty field to type in');
    field.value = '  Alice ';
    press(A._blockedEl, 'SAVE');
    await settle();
    ok(W.calls.adds.length === 1 && W.calls.adds[0][0] === ID_ALICE && W.calls.adds[0][1] === 'Alice', 'SAVE keeps it under the name typed', JSON.stringify(W.calls.adds));
    ok(toasts.some((t) => /Alice is in your contacts/.test(t)), 'and says so', toasts.join(' | '));
    ok((A.state.contacts || []).some((c) => c.cid && c.name === 'Alice'), 'the contacts are read again');
    A.acceptTarget(ID_ALICE);
    await settle();
    ok(/You have this Cashu ID as Alice/.test(card()) && A._blockedEl.querySelector('input').value === 'Alice', 'pasted again, it starts from the name it has');
    shutCard();
    A.acceptTarget(ID_MINE);
    await settle();
    ok(/THIS IS YOUR CASHU ID/.test(card()), 'your own is said to be yours', card());
    shutCard();
    const bad = ID_ALICE.slice(0, 50) + (ID_ALICE[50] === 'A' ? 'B' : 'A') + ID_ALICE.slice(51);
    A.acceptTarget(bad);
    await settle();
    ok(/THAT WON.T WORK/.test(card()) && /That is not a Cashu ID\./.test(card()), 'a mistyped one: That is not a Cashu ID.', card());
    ok(W.calls.adds.length === 1, 'and nothing is added for either');
    shutCard();
    // version 1, with no signature of the ID's own: not an ID
    ok(ID_ALICE_V1.length === 101 && REAL.classify(ID_ALICE_V1) === 'cashuid', 'a version 1 string is still named a Cashu ID');
    A.acceptTarget(ID_ALICE_V1);
    await settle();
    ok(/THAT WON.T WORK/.test(card()) && /That is not a Cashu ID\./.test(card()) && !/NAME THIS CONTACT/.test(card()),
      'a version 1 string, pasted or scanned: That is not a Cashu ID., with no name to type', card());
    ok(W.calls.adds.length === 1, 'and nothing is added');
    shutCard();
  }

  // ---- 4 money at a mint this phone does not use: PAID AT ANOTHER MINT, its three answers and the tick; a row in HISTORY
  //      that opens it again; SETTINGS > OTHER MINTS for what was remembered ----
  {
    const W = stubWallet();
    const OTHER = 'https://home.example';
    const offer = (o) => Object.assign({ key: 'cid:k1', name: 'Carol', mint: OTHER, host: 'home.example', unit: 'sat', amount: 300, at: Date.now(),
      drop: Date.now() + 86400000, back: true, lands: 290, toUnit: 'sat', fee: 10, why: '', small: false, others: 0, total: 300, choice: '' }, o || {});
    let waiting = [offer()];
    let choices = [];
    const decided = [], cleared = [];
    W.cashuIdWaiting = () => waiting.slice();
    W.cashuIdDecide = (key, choice, always) => { decided.push({ key, choice, always }); waiting = waiting.filter((x) => x.key !== key); return Promise.resolve({ state: choice === 'home' ? 'taken' : choice === 'keep' ? 'there' : 'back', why: '' }); };
    W.cashuIdChoices = () => choices.slice();
    W.cashuIdChoiceClear = (host) => { cleared.push(host); choices = choices.filter((c) => host && c.host !== host); return choices.slice(); };
    await fresh(W, { screen: 'history', stack: ['home'] });
    A.cidWake();
    const at = A.mintNameOf(OTHER);
    ok(typeof W._onCashuIdOffer === 'function', 'the app listens for payments waiting at other mints');
    // a payment checked on the phone while the mint swaps it: said at once as arriving, never as received
    ok(typeof W._onCashuIdArriving === 'function', 'the app listens for a payment to the ID that is arriving');
    toasts = [];
    W._onCashuIdArriving({ unit: 'usd', amount: 125, name: 'Bob', mint: 'https://m.test' });
    ok(toasts.length === 1 && /^\$ 1\.25 from Bob is arriving$/.test(toasts[0]) && !/received|paid/i.test(toasts[0]), 'said: $ 1.25 from Bob is arriving', toasts.join(' | '));
    W._onCashuIdArriving({ unit: 'sat', amount: 0, name: '' });
    ok(toasts.length === 1, 'and nothing for no amount');
    W._onCashuIdOffer(offer());
    await settle();
    const root = () => A._blockedEl;
    ok(/PAID AT ANOTHER MINT/.test(card()) && card().indexOf('Carol sent you 300 sats at ' + at + ', a mint you don\u2019t use.') >= 0,
      'the card: Carol sent you 300 sats at ' + at + ', a mint you don’t use.', card());
    ok(/BRING IT HOME/.test(card()) && /fee about 10 sats/.test(card()) && /KEEP IT THERE/.test(card()) && /SEND IT BACK/.test(card()) && /DECIDE LATER/.test(card()),
      'BRING IT HOME with its fee under it, KEEP IT THERE, SEND IT BACK and DECIDE LATER', card());
    const tick = root() && root().querySelector('[data-tick]');
    ok(!!tick && tick.textContent === 'Always do this for ' + at && tick.getAttribute('aria-checked') === 'false', 'and the tick: Always do this for ' + at, tick && tick.textContent);
    tick.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ok(tick.getAttribute('aria-checked') === 'true', 'the tick, ticked');
    press(root(), 'BRING IT HOME');
    await settle();
    ok(decided.length === 1 && decided[0].key === 'cid:k1' && decided[0].choice === 'home' && decided[0].always === true, 'BRING IT HOME with the tick: remembered for that mint', JSON.stringify(decided));
    ok(toasts.some((t) => /It came home from/.test(t)), 'and said', toasts.join(' | '));
    shutCard();
    // KEEP IT THERE, no tick; no SEND IT BACK for a payer who did not prove who it is
    waiting = [offer({ key: 'cid:k2', back: false, name: '' })];
    W._onCashuIdOffer(waiting[0]);
    await settle();
    ok(/A Cashu ID sent you 300 sats/.test(card()) && !/SEND IT BACK/.test(card()), 'an unproved payer: A Cashu ID, and no SEND IT BACK', card());
    press(root(), 'KEEP IT THERE');
    await settle();
    ok(decided.length === 2 && decided[1].choice === 'keep' && decided[1].always === false, 'KEEP IT THERE, not remembered', JSON.stringify(decided[1]));
    ok(toasts.some((t) => /Kept at .+\. It is one of your mints now\./.test(t)), 'and said', toasts.slice(-1).join(''));
    shutCard();
    // SEND IT BACK
    waiting = [offer({ key: 'cid:k3' })];
    W._onCashuIdOffer(waiting[0]);
    await settle();
    press(root(), 'SEND IT BACK');
    await settle();
    ok(decided.length === 3 && decided[2].choice === 'back', 'SEND IT BACK', JSON.stringify(decided[2]));
    ok(toasts.some((t) => t === 'Sent back to Carol.'), 'and said: Sent back to Carol.', toasts.slice(-1).join(''));
    shutCard();
    // too small to bring home: the card all the same, BRING IT HOME grey with the reason, and it does nothing
    waiting = [offer({ key: 'cid:k4', amount: 5, total: 5, lands: 0, fee: 0, small: true, why: 'Too small to bring home: the fee would take all of it.' })];
    W._onCashuIdOffer(waiting[0]);
    await settle();
    const home = root() && Array.prototype.slice.call(root().querySelectorAll('div')).filter((d) => d.textContent === 'BRING IT HOME').pop();
    ok(!!home && home.getAttribute('aria-disabled') === 'true' && /Too small to bring home: the fee would take all of it\./.test(card()),
      'too small: BRING IT HOME is grey, with the reason', card());
    press(root(), 'BRING IT HOME');
    await settle();
    ok(decided.length === 3 && !!root(), 'pressed, it does nothing');
    press(root(), 'KEEP IT THERE');
    await settle();
    ok(decided.length === 4 && decided[3].key === 'cid:k4' && decided[3].choice === 'keep', 'KEEP IT THERE still does', JSON.stringify(decided[3]));
    shutCard();
    // dollars, landing as sats: the fee in dollars and what it lands as
    waiting = [offer({ key: 'cid:k5', unit: 'usd', amount: 300, total: 300, toUnit: 'sat', lands: 3875, fee: 6 })];
    W._onCashuIdOffer(waiting[0]);
    await settle();
    ok(/Carol sent you \$3\.00 at/.test(card()) && /fee about \$0\.06 \u00b7 lands as 3,875 sats/.test(card()), 'dollars: $3.00, fee about $0.06 · lands as 3,875 sats', card());
    shutCard();
    // DECIDE LATER: nothing asked of the wallet; the row in HISTORY opens the card again
    waiting = [offer({ key: 'cid:k6', amount: 5, total: 5 })];
    W._onCashuIdOffer(waiting[0]);
    await settle();
    press(root(), 'DECIDE LATER');
    await settle();
    ok(!card() && decided.length === 4, 'DECIDE LATER: it waits, nothing decided');
    A.loadHistory();
    await settle();
    const items = [].concat(...(A.state.history || []).map((g) => g.items));
    const row = items.find((t) => t.cidWait);
    ok(!!row && row.name === 'From Carol' && row.sats === 5 && row.pending === true && row.dir === 'in', 'HISTORY lists what waits: From Carol, 5 sats, pending', JSON.stringify(row));
    const shown = (V().historyGroups || V().history || []);
    const flat = [].concat(...shown.map((g) => g.items || []));
    const tile = flat.find((t) => /Carol/.test(String(t.name)));
    ok(!!tile && tile.line2 === 'At ' + at + ' \u00b7 tap to decide', 'its line: At ' + at + ' · tap to decide', JSON.stringify(tile && { l2: tile.line2, l3: tile.line3 }));
    if (tile) tile.open();
    await settle();
    ok(/PAID AT ANOTHER MINT/.test(card()) && /Carol sent you 5 sats/.test(card()), 'tapped, the card again', card());
    shutCard();
    waiting = [];
    if (tile) tile.open();
    await settle();
    ok(!card() && toasts.some((t) => t === 'That payment is no longer waiting.'), 'one no longer waiting says so');
    // SETTINGS > OTHER MINTS, only while something is remembered
    A.setState({ screen: 'home', open0: true, menuSettingsOpen: true });
    await settle();
    ok(!V().menuItems.some((m) => m.label === 'OTHER MINTS'), 'with nothing remembered, SETTINGS has no OTHER MINTS');
    choices = [{ host: 'forge.example.com', choice: 'home' }, { host: 'home.example', choice: 'back' }];
    A.setState({ menuTick: 1 });
    await settle();
    const omRow = V().menuItems.find((m) => m.label === 'OTHER MINTS');
    ok(!!omRow, 'with an answer remembered, SETTINGS has OTHER MINTS', V().menuItems.map((m) => m.label).join(', '));
    omRow.tap();
    await settle();
    ok(/OTHER MINTS/.test(card()) && /forge\.example\.com \u00b7 BRING IT HOME/.test(card()) && /home\.example \u00b7 SEND IT BACK/.test(card()) && /FORGET ALL/.test(card()),
      'it lists each remembered answer, and FORGET ALL', card());
    press(root(), 'home.example \u00b7 SEND IT BACK');
    await settle();
    ok(cleared.length === 1 && cleared[0] === 'home.example' && toasts.some((t) => t === 'home.example asks again next time'), 'tapped, one is forgotten', JSON.stringify(cleared));
    shutCard();
  }

  // ---- 3 paying a contact ----
  {
    const W = stubWallet();
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    await fresh(W, { screen: 'contacts', stack: ['home'] });
    // as the history pass writes them (16-history-lists.js, `merged`): the contact keeps its keys
    A.loadHistory();
    await settle();
    ok((A.state.contacts || []).some((c) => c.name === 'Alice' && c.cid && c.cid.id), 'the contacts the history pass writes keep the ID’s keys');
    const rows = V().contactAll;
    const alice = rows.find((r) => r.name === 'Alice');
    ok(!!alice && alice.handle === 'CASHU ID', 'in CONTACTS the ID reads CASHU ID', JSON.stringify(rows.map((r) => r.handle)));
    alice.tap();
    await settle();
    // the contact's own screen first (26p-cashu-msg.js, tests/cashu-msg-ui.js), and PAY on it
    ok(A.state.screen === 'cidChat' && V().cmPayLabel === 'PAY', 'tapped: the contact’s screen, with PAY', A.state.screen);
    // from SEND's CONTACTS the same row goes straight to the amount: the sender came to pay (16-history-lists.js)
    A.setState({ screen: 'contacts', stack: ['home', 'sendHow'] });
    await settle();
    V().contactAll.find((r) => r.name === 'Alice').tap();
    await settle();
    ok(A.state.screen === 'amount' && A.state.flow === 'send' && A.state.recipientKind === 'cashuid' && A.state.recipientName === 'Alice'
      && A.state.stack.slice(-2).join(',') === 'sendHow,contacts', 'from SEND, CONTACTS: tapped, straight to the amount for Alice', A.state.screen + ' ' + A.state.stack.join(','));
    A.setState({ screen: 'contacts', stack: ['home'] });
    await settle();
    V().contactAll.find((r) => r.name === 'Alice').tap();
    await settle();
    V().cmPayGo();
    await settle();
    ok(A.state.screen === 'amount' && A.state.flow === 'send' && A.state.recipientKind === 'cashuid' && A.state.unit === 'USD',
      'PAY: SET AMOUNT, in dollars', JSON.stringify({ s: A.state.screen, k: A.state.recipientKind, u: A.state.unit }));
    ok(V().amountSubtitle === 'How much to send to Alice?', 'asking how much to send to Alice', V().amountSubtitle);
    A.setState({ amount: '5' });
    await settle();
    V().next();
    await settle();
    ok(A.state.screen === 'cidConfirm' && A.state.cidAmount === 6250 && A.state.cidUnit === 'sat', 'NEXT: the confirmation, $5 as 6,250 sats', JSON.stringify({ s: A.state.screen, a: A.state.cidAmount }));
    const spec = A.confirmSpec();
    ok(spec.subtitle === 'If Alice has not collected it in 30 days it comes back to you, here or wherever your words are restored.',
      'R: it says once what happens if Alice does not collect it, and that the words bring it back too', spec.subtitle);
    ok(spec.rows.some((r) => r.label === 'TO' && r.value === 'ALICE') && spec.rows.some((r) => r.label === 'NETWORK' && r.value === 'CASHU ID'), 'TO ALICE, NETWORK CASHU ID');
    ok(!spec.rows.some((r) => /WHEN THEY OPEN FOXY/.test(String(r.value))) && spec.rows.some((r) => r.label === 'GOES BY'),
      'M2: and promises no time it arrives', JSON.stringify(spec.rows.map((r) => r.label + ' ' + r.value)));
    ok(/^SEND /.test(spec.cta), 'and SEND', spec.cta);
    spec.go();
    await settle();
    ok(W.calls.pays.length === 1 && W.calls.pays[0].who === ID_ALICE && W.calls.pays[0].amount === 6250 && W.calls.pays[0].opts.unit === 'sat'
      && W.calls.pays[0].opts.name === 'Alice', 'SEND pays Alice 6,250 sats by cashuIdPay', JSON.stringify(W.calls.pays));
    ok(!A.state.cidBusy, 'and the screen is no longer busy');
  }

  // ---- 5 no ANY WALLET: MY CASHU ID shows its code with SHARE and DONE alone ----
  {
    const W = stubWallet();
    W.cashuIdAnyRequest = () => Promise.resolve({ text: 'creqAstub', id: 'id1', pub: '02' + '1'.repeat(64), unit: 'sat', mints: [MINT] });
    await fresh(W);
    A.cidShowCode(ID_MINE);
    await settle();
    ok(/SHARE/.test(stage().textContent) && /DONE/.test(stage().textContent), 'MY CASHU ID has SHARE and DONE', stage().textContent.slice(-60));
    ok(!/ANY WALLET/.test(stage().textContent), 'and no ANY WALLET, even where the wallet could make that request', stage().textContent.slice(-80));
    ok(typeof A.cidAnyShow === 'undefined' && typeof A.cidAnyShowCode === 'undefined', 'the screen it opened is gone');
    A.hideStage();
  }

  // ---- 6 paid to the ID key itself ----
  {
    const W = stubWallet();
    const answers = [];
    W.cashuIdUnblinded = (key, take) => { answers.push({ key, take }); return Promise.resolve({ state: take ? 'taken' : 'left', why: '' }); };
    W.balanceSats = () => Promise.resolve(50015);
    await fresh(W);
    A.cidWake();
    ok(typeof W._onCashuIdUnblinded === 'function', 'the app listens for payments made to the ID key itself');
    W._onCashuIdUnblinded({ key: 'cid:b1', name: '', mint: MINT, host: 'forge.example.com', unit: 'sat', amount: 15, at: Date.now(), refund: false });
    await settle();
    ok(/PAID TO YOUR ID KEY/.test(card()), 'the card: PAID TO YOUR ID KEY', card());
    ok(card().indexOf('Someone paid you without blinding the key. Taking it would let the mint link your payments together.') >= 0,
      'Someone paid you without blinding the key. Taking it would let the mint link your payments together.', card());
    const labels = Array.prototype.slice.call(A._blockedEl.querySelectorAll('div')).filter((d) => d.children.length === 0).map((d) => d.textContent);
    ok(labels.indexOf('LEAVE IT') >= 0 && labels.indexOf('TAKE IT ANYWAY') > labels.indexOf('LEAVE IT'), 'LEAVE IT first, then TAKE IT ANYWAY', JSON.stringify(labels));
    toasts = [];
    press(A._blockedEl, 'LEAVE IT');
    await settle();
    ok(answers.length === 1 && answers[0].key === 'cid:b1' && answers[0].take === false && !card(), 'LEAVE IT answers no, and the card closes');
    ok(toasts.length === 0, 'quietly', toasts.join(' | '));
    W._onCashuIdUnblinded({ key: 'cid:b2', name: 'Bob', mint: MINT, host: 'forge.example.com', unit: 'sat', amount: 12, at: Date.now(), refund: true });
    await settle();
    ok(card().indexOf('Bob paid you without blinding the key.') >= 0, 'a payer that proved who it is is named', card());
    press(A._blockedEl, 'TAKE IT ANYWAY');
    await settle();
    ok(answers.length === 2 && answers[1].key === 'cid:b2' && answers[1].take === true, 'TAKE IT ANYWAY answers yes', JSON.stringify(answers));
    ok(toasts.some((t) => /Taken\. The mint can link this payment to your Cashu ID\./.test(t)), 'and says what it costs', toasts.join(' | '));
  }

  if (errors.length) console.log('      page errors: ' + errors.slice(0, 3).join(' | '));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
