'use strict';
/* keyboard-lift.js — every field, and the button that goes with it, above the keyboard.
 *
 *     node tests/keyboard-lift.js
 *
 * The web view fills the screen and iOS does not make it smaller for the keyboard: the page lifts itself
 * (watchKeyboard, build/app/15-paid-wake-keyboard.js). Here a keyboard 336 high comes up three ways —
 *
 *   A  only iOS's word for it (FoxyWebView.swift `keyboardMoving`), the visual viewport not moving at all;
 *   B  the visual viewport shrinking and innerHeight shrinking with it, so innerHeight less the viewport is nothing;
 *   C  the visual viewport alone shrinking, innerHeight not —
 *
 * and on each of these, with a field focused, the field and its button must end above the keyboard's top edge:
 *
 *   1  NAME THIS CONTACT?: the name field and SAVE
 *   2  ADD A NOTE on an invoice: the note field and DONE
 *   3  a note on a payment in history (the memo sheet): the field and SAVE
 *   4  NAME CARD: the name field and NEXT
 *
 * and when the keyboard goes, everything is back at the foot. A keyboard raised while no field of the page has the
 * focus (one of the phone's own prompts over the page) moves nothing.
 *
 * jsdom lays nothing out, so where an element's foot can be is worked out here from the inline styles the page
 * draws with: a fixed box sits on the viewport, an absolute one on its positioned ancestor, and a box in the flow
 * ends no lower than its parent's content less the boxes of known height after it. That is an upper bound for a
 * page whose content fits (text that wraps past the room left is the phone's to show). Run
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
  // the phone: a page 844 high, and a visual viewport the scenarios move as a keyboard would
  const H = 844;
  let innerH = H;
  Object.defineProperty(w, 'innerHeight', { configurable: true, get: () => innerH });
  Object.defineProperty(w.document.documentElement, 'clientHeight', { configurable: true, get: () => H });
  const vv = new w.EventTarget();
  vv.height = H; vv.offsetTop = 0; vv.width = 390;
  Object.defineProperty(w, 'visualViewport', { configurable: true, value: vv });
  const phone = {
    H,
    // the visual viewport shrinks by `kb`; `inner` also shrinks innerHeight with it, as this web view may
    viewport(kb, inner) { vv.height = H - kb; innerH = inner ? H - kb : H; vv.dispatchEvent(new w.Event('resize')); },
    // iOS's word for the keyboard, as FoxyWebView.swift passes it on
    told(kb) { if (typeof w.__foxyKeyboard === 'function') w.__foxyKeyboard(kb); },
  };
  run(RENDERER);
  return { dom, w, errors, phone };
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
      const row = { handle: text, name, at: Date.now(), cid: r };
      book.unshift(row);
      return Promise.resolve(row);
    },
  };
  W.calls = calls;
  return W;
}

async function settle() { for (let i = 0; i < 8; i++) await wait(15); }

// ---- where a box's foot can be, from inline styles ------------------------------------------------
function layout(w, H) {
  const kbVar = () => parseFloat(w.document.documentElement.style.getPropertyValue('--kb')) || 0;
  // a length as the page writes it: px, a var(--kb), a calc of those, env() as none
  const px = (v) => {
    v = String(v || '').trim();
    if (!v || v === 'auto') return 0;
    let total = 0;
    v.replace(/var\(--kb(?:,[^)]*)?\)/g, () => { total += kbVar(); return ''; })
      .replace(/env\([^)]*\)/g, '')
      .replace(/(-?\d+(?:\.\d+)?)px/g, (m, n) => { total += parseFloat(n); return ''; });
    return total;
  };
  const side = (st, prop, which) => {
    const one = st.getPropertyValue(prop + '-' + which);
    if (one) return px(one);
    const all = st.getPropertyValue(prop).trim().split(/\s+(?![^(]*\))/);
    if (!all[0]) return 0;
    const at = { top: 0, right: 1, bottom: 2, left: 3 }[which];
    const pick = all.length === 1 ? all[0] : all.length === 2 ? all[at % 2] : all.length === 3 ? all[at === 3 ? 1 : at] : all[at];
    return px(pick);
  };
  const lift = (st) => { const m = /translateY\((-?\d+(?:\.\d+)?)px\)/.exec(st.transform || ''); return m ? parseFloat(m[1]) : 0; };
  const positioned = (el) => /^(relative|absolute|fixed|sticky)$/.test(el.style.position) || /translate/.test(el.style.transform || '');
  const height = (el) => (el.style && (px(el.style.height) || px(el.style.minHeight))) || 0;
  const display = (el) => (el.style && el.style.display) || '';
  const inFlow = (el) => el.nodeType === 1 && !/^(absolute|fixed)$/.test(el.style.position) && display(el) !== 'none'
    && !(el.getAttribute('aria-hidden') === 'true' && el.tagName === 'INPUT');
  const foot = (el) => {
    if (!el || el === w.document.body || el === w.document.documentElement) return H;
    const st = el.style;
    let b;
    if (st.position === 'fixed') b = H - (st.bottom ? px(st.bottom) : st.inset ? px(st.inset.split(/\s+/)[0]) : 0);
    else if (st.position === 'absolute') {
      let cb = el.parentElement;
      while (cb && cb !== w.document.body && !positioned(cb)) cb = cb.parentElement;
      b = (cb && cb !== w.document.body ? foot(cb) - side(cb.style, 'border', 'bottom') : H) - (st.bottom ? px(st.bottom) : st.inset ? px(st.inset.split(/\s+/)[0]) : 0);
    } else {
      const p = el.parentElement;
      b = content(p) - side(st, 'margin', 'bottom');
      const pst = p && p.style ? p.style : {};
      const rowFlex = display(p) === 'flex' && !/column/.test(pst.flexDirection || '');
      if (!rowFlex) {
        const reverse = /column-reverse/.test(pst.flexDirection || '');
        const kids = Array.prototype.slice.call(p.children);
        const after = reverse ? kids.slice(0, kids.indexOf(el)) : kids.slice(kids.indexOf(el) + 1);
        after.filter(inFlow).forEach((k) => { b -= height(k) + side(k.style, 'margin', 'top') + side(k.style, 'margin', 'bottom'); });
      }
    }
    return b + lift(st);
  };
  const content = (el) => {
    if (!el || el === w.document.body || el === w.document.documentElement) return H;
    return foot(el) - side(el.style, 'padding', 'bottom');
  };
  return { foot };
}

(async () => {
  const { w, errors, phone } = mount();
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  const A = w.__logic;
  if (!A) { console.log('FAIL  the app did not mount\n      ' + errors.join(' | ')); process.exit(1); }
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}
  const initial = Object.assign({}, A.state);
  A.toast = () => {};
  const H = phone.H;
  const KB = 336;
  const { foot } = layout(w, H);
  const shutCard = () => { if (A._blockedEl) A._blockedEl.remove(); A._blockedEl = null; A._blockedKind = null; A._cardQueue = []; };
  const shutSheets = () => Array.prototype.slice.call(w.document.body.children)
    .filter((d) => d.tagName === 'DIV' && /2147483500/.test(d.style.zIndex)).forEach((d) => d.remove());
  const fresh = async (W, state) => {
    w.FoxyWallet = W;
    shutCard(); shutSheets();
    if (w.document.activeElement && w.document.activeElement.blur) w.document.activeElement.blur();
    phone.told(0); phone.viewport(0, false);
    A.setState(Object.assign({}, initial, { walletLive: true, balSats: 50000, balUsdCents: null, livePrice: PRICE,
      satUsd: PRICE / 1e8, screen: 'home', stack: [], open0: false, menuSettingsOpen: false, till: null, history: [], contacts: W.book() }, state || {}));
    await settle();
  };
  const byText = (root, label) => Array.prototype.slice.call(root.querySelectorAll('div')).filter((d) => d.textContent === label && !d.querySelector('div')).pop();
  const raise = async (how) => {
    if (how === 'A') { phone.told(KB); }
    else if (how === 'B') { phone.viewport(KB, true); }
    else { phone.viewport(KB, false); }
    await settle();
  };
  const drop = async () => { phone.told(0); phone.viewport(0, false); await settle(); };
  const line = H - KB;

  const contactWallet = async () => {
    const W = stubWallet();
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    return W;
  };

  /* Each screen: open it, focus its field, and give back [field's box, its button]. */
  const SCREENS = {
    'NAME THIS CONTACT?': async () => {
      const W = await contactWallet();
      await fresh(W, { screen: 'contacts', stack: ['home'] });
      A.cidNameAsk(ID_ALICE, '');
      await wait(80);
      const card = A._blockedEl;
      const input = card && card.querySelector('input');
      if (!input) return null;
      input.focus();
      return { field: input, button: byText(card, 'SAVE'), extra: byText(card, 'CANCEL') };
    },
    'ADD A NOTE': async () => {
      await fresh(stubWallet(), { screen: 'invoice', stack: ['home'], noteOpen: true, note: 'rent' });
      const input = w.document.querySelector('input[placeholder^="Rent"]');
      if (!input) return null;
      input.focus();
      const root = input.closest('[style*="z-index: 60"]') || w.document;
      return { field: input.parentElement, button: byText(root, 'DONE') };
    },
    'a note in history': async () => {
      await fresh(stubWallet(), { screen: 'home', stack: [] });
      A.noteSheet('dinner', () => {}, { edit: true });
      await wait(120);
      const sheet = Array.prototype.slice.call(w.document.body.children).filter((d) => /2147483500/.test(d.style.zIndex)).pop();
      const input = sheet && sheet.querySelector('input');
      if (!input) return null;
      input.focus();
      return { field: input, button: byText(sheet, 'SAVE') };
    },
    'NAME CARD': async () => {
      await fresh(stubWallet(), { screen: 'fcName', stack: ['home'], fcNaming: { mode: 'rename', key: 'k' }, fcNameDraft: 'Groceries' });
      const input = w.document.querySelector('input[placeholder="My card"]');
      if (!input) return null;
      input.focus();
      return { field: input.parentElement, button: byText(w.document.querySelector('[data-template="list"]'), 'NEXT') };
    },
  };

  for (const [name, open] of Object.entries(SCREENS)) {
    for (const how of ['A', 'B', 'C']) {
      const got = await open();
      if (!got || !got.field || !got.button) { ok(false, name + ' (' + how + '): the screen has its field and button', JSON.stringify(!!got)); continue; }
      const before = [foot(got.field), foot(got.button)];
      ok(before[0] <= H && before[1] <= H, name + ' (' + how + '): before the keyboard, on the screen' + (process.env.KB_SHOW ? ' ' + before.join(' / ') : ''), before.join(' / '));
      await raise(how);
      const up = [foot(got.field), foot(got.button)].concat(got.extra ? [foot(got.extra)] : []);
      ok(up.every((b) => b <= line), name + ' (' + how + '): the field and its button above the keyboard (top at ' + line + ')',
        'feet at ' + up.map((b) => Math.round(b)).join(' / '));
      await drop();
      const down = [foot(got.field), foot(got.button)];
      ok(down[0] === before[0] && down[1] === before[1], name + ' (' + how + '): the keyboard gone, back where they were', down.join(' / ') + ' vs ' + before.join(' / '));
    }
  }

  // a keyboard of the phone's own, over the page, with no field of the page focused: nothing moves
  {
    await fresh(stubWallet(), { screen: 'fcName', stack: ['home'], fcNaming: { mode: 'rename', key: 'k' }, fcNameDraft: 'Groceries' });
    const send = byText(w.document.querySelector('[data-template="list"]'), 'NEXT');
    const at = foot(send);
    phone.told(KB);
    await settle();
    ok(foot(send) === at && (A.state.kbInset || 0) === 0, 'a keyboard of the phone’s own over the page, no field focused: nothing moves', foot(send) + ' vs ' + at);
    await drop();
  }

  if (errors.length) ok(false, 'no page errors', errors.slice(0, 3).join(' | '));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
