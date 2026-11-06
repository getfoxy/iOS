'use strict';
/* remind.js — the reminder after fifteen days away (build/wallet/08i-remind.js, build/app/26o-remind.js, Reminder.swift).
 *
 *     node tests/remind.js
 *
 *   1  the wallet: nothing with no Cashu ID in use; with one, the phone is asked without iOS's question (`ask: false`) and
 *      "ok" turns it on with no card, "needs" asks for the card, "refused" ends the question; asked once, never again
 *   2  turning on names the fixed 15 days; refused leaves it off; off cancels; NOT NOW is remembered
 *   3  SETTINGS: REMIND ME AFTER 15 DAYS the first row of SETTINGS, only with an ID in use; a switch that shows its
 *      state; a tap turns it off (cancel) or on (iOS's question), and refused says where to turn notifications on
 *   4  the card: REMIND YOU? with Foxy's words, TURN ON and NOT NOW; none when the question was answered or no ID is in use
 *
 * The real page over a stand-in wallet (as tests/cashu-id-ui.js), and the real wallet over a stand-in phone. Run
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


// ---- the wallet over a stand-in phone -------------------------------------------------------------------------------
function realWith(answers, inUse) {
  const asked = [];
  const ctx = loadReal({
    storage: inUse ? { 'foxy.cid.shown': String(Date.now()) } : {},
    bridge: (w, m) => {
      if (m.action !== 'reminder') return;
      asked.push(JSON.parse(JSON.stringify(m)));
      const a = typeof answers === 'function' ? answers(m) : answers;
      setTimeout(() => w.FoxyWallet._scanResult(m.id, a === null ? '' : a, a === null ? 'the bridge was busy' : null), 0);
    },
  });
  return { W: ctx.W, asked, store: () => JSON.parse(ctx.storage.getItem('foxy.remind') || 'null') };
}

// ---- the page over a stand-in wallet ----------------------------------------------------------------------------------
function remindStub(o) {
  const W = stubWallet();
  const said = { off: 0, on: 0, notNow: 0, settings: 0 };
  let on = !!o.on;
  W.calls.said = said;
  W.openSettings = () => { said.settings += 1; };
  W.remindView = () => ({ eligible: o.eligible !== false, on });
  W.remindStatus = () => Promise.resolve(o.status || 'none');
  W.remindTurnOn = () => { said.on += 1; on = o.grant !== false; return Promise.resolve(on ? 'on' : 'refused'); };
  W.remindTurnOff = () => { said.off += 1; on = false; return Promise.resolve('off'); };
  W.remindNotNow = () => { said.notNow += 1; };
  return W;
}

(async () => {
  // ---- 1 and 2: the wallet ----
  {
    let r = realWith('ok', false);
    ok((await r.W.remindStatus()) === 'none' && r.asked.length === 0, 'no ID in use: nothing is asked of the phone, and no switch', JSON.stringify(r.W.remindView()));
    ok(r.W.remindView().eligible === false, 'the view says it is not eligible');
    ok((await r.W.remindTurnOn()) === 'refused' && r.asked.length === 0, 'and it cannot be turned on');

    r = realWith('ok', true);
    ok(r.W.remindView().eligible === true && r.W.remindView().on === false, 'an ID in use: eligible, off until said');
    ok((await r.W.remindStatus()) === 'on', 'notifications already allowed ("ok"): on, with no card');
    ok(r.asked.length === 1 && r.asked[0].days === 15 && r.asked[0].ask === false, 'the phone was asked for 15 days and told not to ask iOS', JSON.stringify(r.asked));
    ok(JSON.stringify(r.store()) === '{"on":true,"asked":true,"owed":false}', 'and that is kept');
    ok((await r.W.remindStatus()) === 'on' && r.asked.length === 1, 'asked once: a second look asks the phone nothing');

    r = realWith('needs', true);
    ok((await r.W.remindStatus()) === 'ask', 'iOS never asked ("needs"): the card is due');
    ok((await r.W.remindStatus()) === 'ask' && r.asked.length === 2, 'and stays due until answered');
    r.W.remindNotNow();
    ok((await r.W.remindStatus()) === 'off' && r.asked.length === 2, 'NOT NOW: off, and the phone is not asked again');
    ok(r.W.remindView().on === false, 'the switch is off');
    ok((await r.W.remindTurnOn()) === 'refused', 'turning on later asks the phone, which here says iOS refused');
    const last = r.asked[r.asked.length - 1];
    ok(last.days === 15 && last.ask === undefined, 'with 15 days and no ask: false, so iOS asks', JSON.stringify(last));

    r = realWith('ok', true);
    r.W.remindNotNow();
    ok((await r.W.remindTurnOn()) === 'on' && r.W.remindView().on === true, 'turned on: on');
    ok((await r.W.remindTurnOff()) === 'off' && r.W.remindView().on === false, 'turned off: off');
    ok(JSON.stringify(r.asked[r.asked.length - 1]) === JSON.stringify({ action: 'reminder', id: r.asked[r.asked.length - 1].id, cancel: true }), 'and the phone is told to cancel', JSON.stringify(r.asked[r.asked.length - 1]));

    // a cancel that did not reach the phone is sent again at the next look
    let failCancel = true;
    r = realWith((m) => m.cancel && failCancel ? null : 'ok', true);
    await r.W.remindTurnOn();
    await r.W.remindTurnOff();
    ok(r.W.remindView().on === false && r.store().owed === true, 'a cancel that failed is owed, and the switch shows off', JSON.stringify(r.store()));
    failCancel = false;
    const before = r.asked.length;
    ok((await r.W.remindStatus()) === 'off' && r.asked.length === before + 1 && r.asked[before].cancel === true && r.store().owed === false, 'the next look sends it again, once', JSON.stringify(r.store()));
    await r.W.remindStatus();
    ok(r.asked.length === before + 1, 'and not again after it went');

    r = realWith('refused', true);
    ok((await r.W.remindStatus()) === 'off' && JSON.stringify(r.store()) === '{"on":false,"asked":true,"owed":false}', 'refused in Settings: off, and the question is over');
    ok((await r.W.remindTurnOn()) === 'refused' && r.W.remindView().on === false, 'turning on again says refused and stays off');
  }

  // ---- 3 and 4: the page ----
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
  const fresh = async (W, state) => {
    w.FoxyWallet = W;
    shutCard();
    A.hideStage();
    toasts = [];
    A._remindAsking = false; A._remindBusy = false;
    A.setState(Object.assign({}, initial, { walletLive: true, balSats: 50000, balUsdCents: null, livePrice: PRICE,
      satUsd: PRICE / 1e8, screen: 'home', stack: [], open0: true, menuSettingsOpen: false, till: null, history: [], contacts: W.book() }, state || {}));
    await settle();
  };
  const labels = () => V().menuItems.map((m) => m.label);
  const ROW = 'REMIND ME AFTER 15 DAYS';

  {
    const W = remindStub({ eligible: true, on: true });
    await fresh(W);
    const row = V().menuItems.find((m) => m.label === ROW);
    ok(row.hasSwitch === true && row.swX === '18px' && row.indent === '10px', 'a switch, on, a row of SETTINGS');
    row.tap();
    await settle();
    ok(W.calls.said.off === 1 && W.calls.said.on === 0, 'a tap on an on switch turns it off, which cancels');
    ok(V().menuItems.find((m) => m.label === ROW).swX === '0px', 'and the switch shows off');
    ok(toasts.some((t) => /No reminder/.test(t)), 'with a word', toasts.join('|'));
    V().menuItems.find((m) => m.label === ROW).tap();
    await settle();
    ok(W.calls.said.on === 1 && V().menuItems.find((m) => m.label === ROW).swX === '18px', 'a tap on an off switch turns it on');
    ok(toasts.some((t) => /remind you after 15 days/.test(t)), 'and says so', toasts.join('|'));
  }
  {
    const W = remindStub({ eligible: true, on: false, grant: false });
    await fresh(W);
    const L = labels();
    ok(L.indexOf('PUSH NOTIFICATIONS') < 0 && L.indexOf(ROW) === L.indexOf('SETTINGS') + 1, 'REMIND ME AFTER 15 DAYS is the first row of SETTINGS', L.join(', '));
    V().menuItems.find((m) => m.label === ROW).tap();
    await settle();
    ok(/NOTIFICATIONS ARE OFF/.test(card()) && /Settings/.test(card()), 'iOS said no: a card says where to turn notifications on', card());
    ok(V().menuItems.find((m) => m.label === ROW).swX === '0px', 'the switch stays off');
    press(A._blockedEl, 'OPEN SETTINGS');
    ok(W.calls.said.settings === 1, 'OPEN SETTINGS goes to Foxy\'s page in Settings');
  }
  {
    const W = remindStub({ eligible: false });
    await fresh(W);
    ok(labels().indexOf(ROW) < 0, 'no Cashu ID in use: no row');
    const W2 = stubWallet();
    await fresh(W2);
    ok(labels().indexOf(ROW) < 0, 'a wallet with no such switch: no row');
  }
  // the card
  {
    const W = remindStub({ eligible: true, status: 'ask' });
    await fresh(W, { open0: false });
    A.remindMaybeAsk();
    await settle();
    ok(/REMIND YOU\?/.test(card()) && card().indexOf('Foxy can remind you after 15 days away, so a payment waiting for you is not missed.') >= 0 && !/message/i.test(card()), 'the first time: the card, with Foxy\'s words', card());
    ok(/TURN ON/.test(card()) && /NOT NOW/.test(card()), 'TURN ON and NOT NOW');
    press(A._blockedEl, 'NOT NOW');
    await settle();
    ok(W.calls.said.notNow === 1 && W.calls.said.on === 0, 'NOT NOW is told to the wallet, which remembers it');
  }
  {
    const W = remindStub({ eligible: true, status: 'ask' });
    await fresh(W, { open0: false });
    A.remindMaybeAsk();
    await settle();
    press(A._blockedEl, 'TURN ON');
    await settle();
    ok(W.calls.said.on === 1 && toasts.some((t) => /remind you after 15 days/.test(t)), 'TURN ON asks for it (iOS asks its own question there)', toasts.join('|'));
  }
  for (const st of ['none', 'on', 'off']) {
    const W = remindStub({ eligible: true, status: st });
    await fresh(W, { open0: false });
    A.remindMaybeAsk();
    await settle();
    ok(card() === '' && W.calls.said.on === 0, 'status "' + st + '": no card');
  }
  {
    // MY CASHU ID being shown never puts the card over its code; the next return past the lock asks
    const W = remindStub({ eligible: true, status: 'ask' });
    await fresh(W, { open0: true });
    V().menuItems.find((m) => m.label === 'MY CASHU ID').tap();
    await settle(); await settle();
    ok(card() === '' && !(A._cardQueue || []).length, 'showing MY CASHU ID puts no card over its code', card());
    A.wakeWork();
    await settle();
    ok(/REMIND YOU\?/.test(card()), 'the next return asks', card());
  }

  console.log('');
  console.log(failed ? failed + ' failed, ' + passed + ' passed' : passed + ' passed, 0 failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
