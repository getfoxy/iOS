'use strict';
/* cashu-msg-ui.js — messages between Cashu IDs, as a person sees them (build/app/26p-cashu-msg.js).
 *
 *     node tests/cashu-msg-ui.js
 *
 *   1  with no ID in use: no counts in CONTACTS; a contact's screen has its name, PAY and NO MESSAGES YET with why, and
 *      no field
 *   2  with the ID in use: CONTACTS counts each contact's unread messages; its screen lists them, oldest at the top and
 *      newest at the bottom, this phone's own marked "sending…" or "sent"; opening it reads them
 *   3  a field and SEND: what is typed goes to `cashuMsgSend` and the field empties; a refusal is said under it
 *   4  someone who is not a contact and wrote: NEW MESSAGES in CONTACTS, "A Cashu ID"; its screen has ADD CONTACT, which
 *      asks NAME THIS CONTACT? for the ID string they sent
 *   5  a message arriving while the screen is open is read at once, and the screens draw again
 *   6  CHAT, home's round button at the top left: the unread count on its corner ("9+" past nine), drawn again as a
 *      message arrives and as one is read; it opens INBOX
 *   7  INBOX: everyone written to, heard from, paid or paid by, newest first by the latest of those; a message's first
 *      line or the payment ("Paid $1.25", "Received 500 sats"), its time, its unread count, "A Cashu ID" for a
 *      stranger; a row opens that contact's screen
 *   8  INBOX empty (words, graphic, ADD A CASHU ID), with no ID in use, its CONTACTS button and back from it; empty CONTACTS
 *   9  no FOXY CARD in the menu (home's CARD button has it); MY CASHU ID with the profile drawing; CHAT there opens INBOX,
 *      CONTACTS the full list; a screen opened from the menu goes back to the menu when it is left (MY CASHU ID's DONE
 *      too), a payment that ends on PAID does not, nor one that comes in over home, nor a swap still going; a row that
 *      only says something (SWAP offline) leaves nothing armed
 *  10  the whole menu in the keeper's order (21-render-values.js): WALLET, MINTS, TOOLS, SETTINGS, OFFLINE LIMITS, every
 *      section open and each shutting in place, the gap above each heading the gap under MENU; BLUETOOTH TAP first in SETTINGS and no
 *      YOUR CHANGE; OFFLINE LIMITS with PER PERSON and TOTAL; the renamed rows doing what they did; BACKUP
 *      ACCOUNT at the very top only with money and the words not checked; TRANSFER MONEY keeps its rule; no PUSH
 *      NOTIFICATIONS and no PRIVATE LNURL, whatever the wallet offers (Foxy talks to no server run for it)
 *
 * The real page, rendered in jsdom by build/foxy-render.js, over a stand-in wallet. Run `python3 tools/pack-index.py`
 * first: this reads build/foxy-app.js. */
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
    scan: () => Promise.resolve(''),
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

/* The messages' contract (build/wallet/21d-cashu-msg.js), kept in memory. */
function withMessages(W, on, threads) {
  const sent = [];
  const seen = [];
  let refuse = '';
  Object.assign(W, {
    cashuMsgOn: () => on,
    cashuMsgThreads: () => (on ? threads.map((t) => ({ peer: t.peer, name: t.name, contact: t.contact, unread: t.unread,
      lastAt: t.msgs.length ? t.msgs[t.msgs.length - 1].at : 0, lastText: t.msgs.length ? t.msgs[t.msgs.length - 1].text : '' })) : []),
    cashuMsgThread: (peer) => {
      if (!on) return null;
      const t = threads.find((x) => x.peer === peer);
      return t ? JSON.parse(JSON.stringify(t)) : { peer, name: 'Alice', contact: true, card: '', unread: 0, msgs: [] };
    },
    cashuMsgSeen: (peer) => { seen.push(peer); const t = threads.find((x) => x.peer === peer); if (t) t.unread = 0; },
    cashuMsgSend: (peer, text) => {
      if (refuse) return Promise.reject(new Error(refuse));
      sent.push({ peer, text });
      const t = threads.find((x) => x.peer === peer);
      if (t) t.msgs.push({ id: 'n' + sent.length, dir: 'out', text, at: Date.now(), mark: 'sending\u2026' });
      return Promise.resolve({ id: 'n' + sent.length, i: 1, first: false });
    },
  });
  W.msg = { sent, seen, threads, refuse: (why) => { refuse = why; } };
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
      satUsd: PRICE / 1e8, screen: 'home', stack: [], open0: false, menuSettingsOpen: false, till: null, history: [], contacts: W.book(), menuReturn: null }, state || {}));
    await settle();
  };

  // the paste card: type an ID, NEXT, NAME THIS CONTACT?; CANCEL there keeps nothing, then again and SAVE keeps it
  const typeIn = async (value, label) => {
    const f = A._blockedEl && A._blockedEl.querySelector('input');
    if (f) f.value = value;
    press(A._blockedEl, label);
    await settle();
  };
  const addFlow = async (W, id, name) => {
    const before = W.book().length;
    await typeIn(id, 'NEXT');
    ok(/NAME THIS CONTACT\?/.test(card()), 'NEXT reads the ID: NAME THIS CONTACT?', card());
    await typeIn(name, 'CANCEL');
    ok(W.book().length === before && !card(), 'CANCEL keeps nothing', W.book().length);
    A.cidPasteAsk();
    await settle();
    await typeIn(id, 'NEXT');
    await typeIn(name, 'SAVE');
    ok(W.book().length === before + 1 && W.book().some((c) => c.name === name), 'SAVE puts the contact in the book', JSON.stringify(W.book().map((c) => c.name)));
  };
  const screen = () => w.document.querySelector('[data-template="list"]');
  const text = () => (screen() ? screen().textContent : '');
  const ALICE = REAL.cashuIdDecode(ID_ALICE).id;
  const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);

  // ---- 1 no ID in use ----
  {
    const W = withMessages(stubWallet(), false, []);
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    await fresh(W, { screen: 'contacts', stack: ['home'] });
    const row = V().contactAll.find((r) => r.name === 'Alice');
    ok(!!row && row.unread === '' && !V().contactNewShown, 'no ID in use: no count on the contact, no NEW MESSAGES');
    row.tap();
    await settle();
    ok(A.state.screen === 'cidChat' && V().cmTitle === 'ALICE' && V().cmPayLabel === 'PAY', 'the contact’s screen: ALICE, with PAY');
    ok(V().cmOff === true && V().cmOn === false && /NO MESSAGES YET/.test(text())
      && text().indexOf('Messages go from your own Cashu ID. Open MY CASHU ID in the menu to start, then write to Alice here.') >= 0,
      'and why there are no messages: open MY CASHU ID first', text().slice(0, 300));
    ok(!screen().querySelector('input'), 'no field to write in');
    ok(W.msg.seen.length === 0, 'and nothing is marked read');
    V().cmPayGo();
    await settle();
    ok(A.state.screen === 'amount' && A.state.recipientKind === 'cashuid', 'PAY still pays them');
  }

  // ---- 2 the ID in use: counts, the list, the marks ----
  {
    const threads = [{ peer: ALICE, name: 'Alice', contact: true, card: '', unread: 2, msgs: [
      { id: 'a', dir: 'in', text: 'Lunch at noon?', at: T0, mark: '' },
      { id: 'b', dir: 'out', text: 'Yes, see you there', at: T0 + 60000, mark: 'sent' },
      { id: 'c', dir: 'in', text: 'Bring the receipt', at: T0 + 120000, mark: '' },
      { id: 'd', dir: 'out', text: 'Will do', at: T0 + 180000, mark: 'sending\u2026' },
    ] }];
    const W = withMessages(stubWallet(), true, threads);
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    await fresh(W, { screen: 'contacts', stack: ['home'] });
    const row = V().contactAll.find((r) => r.name === 'Alice');
    ok(row.unread === '2', 'CONTACTS: Alice has 2 unread', row.unread);
    ok(/Alice[\s\S]*CASHU ID[\s\S]*2/.test(text()), 'and the row shows the count', text().slice(0, 400));
    row.tap();
    await settle();
    ok(W.msg.seen.indexOf(ALICE) >= 0, 'opened: its messages are read');
    const v = V();
    ok(v.cmOn === true && v.cmSub === 'Messages go over Nostr, each to a key used once.', 'the screen says how they go', v.cmSub);
    ok(v.cmRows.length === 4 && v.cmRows[0].text === 'Will do' && v.cmRows[3].text === 'Lunch at noon?', 'newest at the bottom (the list is drawn bottom up)');
    ok(v.cmRows[0].align === 'flex-end' && v.cmRows[3].align === 'flex-start', 'this phone’s own on the right, theirs on the left');
    ok(/ \u00b7 sending\u2026$/.test(v.cmRows[0].foot) && / \u00b7 sent$/.test(v.cmRows[2].foot) && !/sent|sending/.test(v.cmRows[1].foot),
      'marks: sending…, sent; none on theirs', JSON.stringify(v.cmRows.map((r) => r.foot)));
    const bubbles = Array.prototype.slice.call(screen().querySelectorAll('div')).filter((d) => d.textContent === 'Lunch at noon?' || d.textContent === 'Will do');
    ok(bubbles.length === 2, 'both bubbles on the screen');
    ok(!!screen().querySelector('input[placeholder="Message Alice"]'), 'a field: Message Alice');
    await fresh(W, { screen: 'contacts', stack: ['home'] });
    ok(V().contactAll.find((r) => r.name === 'Alice').unread === '', 'back in CONTACTS: no count');
    // an empty conversation
    const W2 = withMessages(stubWallet(), true, []);
    await W2.cashuIdAdd(ID_ALICE, 'Alice');
    await fresh(W2, { screen: 'contacts', stack: ['home'] });
    V().contactAll.find((r) => r.name === 'Alice').tap();
    await settle();
    ok(V().cmEmptyShown && text().indexOf('No messages with Alice yet. What you write goes only to them.') >= 0, 'none yet: said so');
  }

  // ---- 3 SEND ----
  {
    const threads = [{ peer: ALICE, name: 'Alice', contact: true, card: '', unread: 0, msgs: [] }];
    const W = withMessages(stubWallet(), true, threads);
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    await fresh(W, { screen: 'contacts', stack: ['home'] });
    V().contactAll.find((r) => r.name === 'Alice').tap();
    await settle();
    ok(V().cmSendLabel === 'SEND' && /rgba/.test(V().cmSendBg), 'SEND, grey with nothing typed');
    V().cmSendGo();
    await settle();
    ok(W.msg.sent.length === 0 && V().cmErr === 'Type a message first.', 'nothing typed: Type a message first.');
    V().cmDraftInput({ target: { value: 'On my way' } });
    await settle();
    ok(V().cmSendBg === 'var(--acc)', 'typed: SEND lights');
    V().cmSendGo();
    await settle();
    ok(W.msg.sent.length === 1 && W.msg.sent[0].peer === ALICE && W.msg.sent[0].text === 'On my way', 'SEND hands it to cashuMsgSend for Alice');
    ok(A.state.cmDraft === '' && V().cmRows[0].text === 'On my way' && / \u00b7 sending\u2026$/.test(V().cmRows[0].foot), 'the field empties; it is at the bottom, marked sending…');
    W.msg.refuse('That message is too long. A message is at most 1000 characters.');
    V().cmDraftInput({ target: { value: 'x'.repeat(1200) } });
    await settle();
    ok(A.state.cmDraft.length === 1000, 'the field holds at most 1,000 characters');
    V().cmSendGo();
    await settle();
    ok(/too long/.test(V().cmErr) && /too long/.test(text()), 'a refusal is said under the field', V().cmErr);
  }

  // ---- 4 someone who is not a contact ----
  {
    const KEYS_BOB = require('./harness').cashuIdKeys(seedOfWords('letter advice cage absurd amount doctor acoustic avoid letter advice cage above'));
    const ID_BOB = REAL._cashuIdEncode(KEYS_BOB.id, KEYS_BOB.nostr, KEYS_BOB.sig);
    const threads = [{ peer: KEYS_BOB.id, name: 'A Cashu ID', contact: false, card: ID_BOB, unread: 1, msgs: [
      { id: 'x', dir: 'in', text: 'Hi, this is Bob', at: T0, mark: '' }] }];
    const W = withMessages(stubWallet(), true, threads);
    await fresh(W, { screen: 'contacts', stack: ['home'] });
    ok(V().contactNewShown === true && V().contactNew.length === 1 && V().contactNew[0].name === 'A Cashu ID' && V().contactNew[0].unread === '1',
      'NEW MESSAGES: A Cashu ID, 1 unread');
    ok(/NEW MESSAGES/.test(text()) && /Not in your contacts/.test(text()), 'drawn in CONTACTS');
    V().contactNew[0].tap();
    await settle();
    ok(A.state.screen === 'cidChat' && V().cmTitle === 'A CASHU ID' && V().cmPayLabel === 'ADD CONTACT' && V().cmSub === 'Not in your contacts.',
      'its screen: A CASHU ID, ADD CONTACT', JSON.stringify([V().cmTitle, V().cmPayLabel]));
    ok(V().cmRows[0].text === 'Hi, this is Bob', 'its message');
    V().cmPayGo();
    await settle();
    ok(/NAME THIS CONTACT\?/.test(card()), 'ADD CONTACT asks NAME THIS CONTACT?', card());
    const field = A._blockedEl && A._blockedEl.querySelector('input');
    field.value = 'Bob';
    press(A._blockedEl, 'SAVE');
    await settle();
    ok(W.calls.adds.length === 1 && W.calls.adds[0][0] === ID_BOB && W.calls.adds[0][1] === 'Bob', 'SAVE keeps the ID string they sent, as Bob');
    shutCard();
  }

  // ---- 5 a message while the screen is open ----
  {
    const threads = [{ peer: ALICE, name: 'Alice', contact: true, card: '', unread: 0, msgs: [] }];
    const W = withMessages(stubWallet(), true, threads);
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    await fresh(W, { screen: 'contacts', stack: ['home'] });
    A.cidWake();
    ok(typeof W._onCashuMsg === 'function', 'the app listens for messages');
    V().contactAll.find((r) => r.name === 'Alice').tap();
    await settle();
    const seen0 = W.msg.seen.length;
    threads[0].msgs.push({ id: 'z', dir: 'in', text: 'Are you there?', at: Date.now(), mark: '' });
    threads[0].unread = 1;
    W._onCashuMsg(ALICE);
    await settle();
    ok(W.msg.seen.length === seen0 + 1 && threads[0].unread === 0, 'it is read at once on the open screen');
    ok(V().cmRows[0].text === 'Are you there?' && text().indexOf('Are you there?') >= 0, 'and drawn');
  }

  // ---- 6 CHAT on home ----
  const KEYS_BOB = require('./harness').cashuIdKeys(seedOfWords('letter advice cage absurd amount doctor acoustic avoid letter advice cage above'));
  const KEYS_CAROL = require('./harness').cashuIdKeys(seedOfWords('carol words for a stand-in phone of this suite only'));
  const KEYS_DAVE = require('./harness').cashuIdKeys(seedOfWords('dave words for a stand-in phone of this suite only'));
  const ID_CAROL = REAL._cashuIdEncode(KEYS_CAROL.id, KEYS_CAROL.nostr, KEYS_CAROL.sig);
  const ID_DAVE = REAL._cashuIdEncode(KEYS_DAVE.id, KEYS_DAVE.nostr, KEYS_DAVE.sig);
  const chatBtn = () => w.document.querySelector('[data-chat-button]');
  const badge = () => { const b = w.document.querySelector('[data-chat-badge]'); return b ? b.textContent : ''; };
  {
    const threads = [{ peer: ALICE, name: 'Alice', contact: true, card: '', unread: 0, msgs: [
      { id: 'a', dir: 'in', text: 'Lunch at noon?', at: T0, mark: '' }] }];
    const W = withMessages(stubWallet(), true, threads);
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    await fresh(W, {});
    A.cidWake();
    const btn = chatBtn();
    ok(!!btn && btn.style.left === '22px' && btn.style.top === '56px' && btn.getAttribute('aria-label') === 'Chat' && !!btn.querySelector('svg path'),
      'home: CHAT is the round button at the top left, where CARD was', btn ? btn.outerHTML.slice(0, 200) : 'none');
    ok(!w.document.querySelector('[aria-label="Card"]') && !w.document.querySelector('[data-card-button]'), 'and there is no CARD button on home');
    ok(badge() === '' && V().chatBadgeShown === false, 'nothing unread: no count on its corner');
    threads[0].msgs.push({ id: 'b', dir: 'in', text: 'Are you near?', at: T0 + 60000, mark: '' });
    threads[0].unread = 1;
    W._onCashuMsg(ALICE);
    await settle();
    ok(badge() === '1' && V().chatSay === 'Chat, 1 unread message', 'a message arrives: "1" on its corner at once', badge());
    const b = w.document.querySelector('[data-chat-badge]');
    ok(!!b && b.style.background === 'var(--acc)' && b.style.color === 'var(--frost-chip)' && b.style.borderRadius === '12px' && b.style.position === 'absolute',
      'a filled circle in the accent colour, the number in the button’s own colour', b ? b.getAttribute('style') : 'none');
    threads.push({ peer: KEYS_BOB.id, name: 'A Cashu ID', contact: false, card: '', unread: 2, msgs: [{ id: 'x', dir: 'in', text: 'Hi', at: T0, mark: '' }] });
    W._onCashuMsg(KEYS_BOB.id);
    await settle();
    ok(badge() === '3', 'across conversations: 3', badge());
    threads[1].unread = 11;
    W._onCashuMsg(KEYS_BOB.id);
    await settle();
    ok(badge() === '9+', 'past nine: 9+', badge());
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    ok(A.state.screen === 'inbox' && JSON.stringify(A.state.stack) === '["home"]' && /INBOX/.test(text()), 'CHAT opens INBOX', A.state.screen);
    V().ibRows.find((r) => r.key === KEYS_BOB.id).tap();
    await settle();
    ok(A.state.screen === 'cidChat' && A.state.cmPeer === KEYS_BOB.id, 'a row opens that conversation');
    A.back();
    await settle();
    ok(A.state.screen === 'inbox' && V().chatBadge === '1', 'and back: read, the count is Alice’s 1 alone', V().chatBadge);
    A.back();
    await settle();
    ok(A.state.screen === 'home' && badge() === '1', 'back again: home, with 1 on CHAT', badge());
  }

  // ---- 7 INBOX's rows ----
  {
    const threads = [
      { peer: ALICE, name: 'Alice', contact: true, card: '', unread: 2, msgs: [
        { id: 'a', dir: 'out', text: 'Hello', at: T0 + 60000, mark: 'sent' },
        { id: 'b', dir: 'in', text: 'Lunch at noon?\nBring the receipt', at: T0 + 300000, mark: '' }] },
      { peer: KEYS_BOB.id, name: 'A Cashu ID', contact: false, card: '', unread: 0, msgs: [
        { id: 'x', dir: 'in', text: 'Hi, this is Bob', at: T0 + 30000, mark: '' }] },
      // a contact who has never written: not listed for that
      { peer: KEYS_DAVE.id, name: 'Dave', contact: true, card: '', unread: 0, msgs: [] },
    ];
    const W = withMessages(stubWallet(), true, threads);
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    await W.cashuIdAdd(ID_CAROL, 'Carol');
    await W.cashuIdAdd(ID_DAVE, 'Dave');
    W.cashuMsgPayments = () => [
      { peer: KEYS_CAROL.id, dir: 'out', unit: 'usd', amount: 125, at: T0 + 600000 },
      { peer: KEYS_DAVE.id, dir: 'in', unit: 'sat', amount: 500, at: T0 + 120000 },
      { peer: ALICE, dir: 'in', unit: 'sat', amount: 21, at: T0 },
    ];
    await fresh(W, { screen: 'inbox', stack: ['home'] });
    const rows = V().ibRows;
    ok(rows.map((r) => r.name).join() === 'Carol,Alice,Dave,A Cashu ID', 'newest first by the latest message or payment either way',
      rows.map((r) => r.name).join());
    ok(rows[0].line === 'Paid $1.25' && rows[2].line === 'Received 500 sats', 'a payment says what it was: Paid $1.25, Received 500 sats',
      JSON.stringify(rows.map((r) => r.line)));
    ok(rows[1].line === 'Lunch at noon?' && rows[3].line === 'Hi, this is Bob', 'a message, its first line', rows[1].line);
    ok(rows[1].unread === '2' && rows[0].unread === '' && rows[3].unread === '', 'Alice’s row carries her 2 unread; the read ones none');
    ok(rows[0].time === A.cmWhen(T0 + 600000) && rows[1].time === A.cmWhen(T0 + 300000), 'each with its time as HISTORY says one', rows[0].time);
    ok(rows[3].stranger === true && rows[3].known === false && rows[0].known === true && rows[0].ini === 'C', 'a stranger drawn apart, a contact by its initial');
    const t = text();
    ok(/Carol[\s\S]*Paid \$1\.25[\s\S]*Alice[\s\S]*Lunch at noon\?[\s\S]*2[\s\S]*Dave[\s\S]*Received 500 sats[\s\S]*A Cashu ID[\s\S]*Hi, this is Bob/.test(t)
      && t.indexOf('Bring the receipt') < 0, 'drawn in that order, with the first line only', t.slice(0, 400));
    rows[2].tap();
    await settle();
    ok(A.state.screen === 'cidChat' && A.state.cmPeer === KEYS_DAVE.id && V().cmTitle === 'DAVE' && V().cmPayLabel === 'PAY',
      'a payment-only contact’s row opens their screen, with PAY');
  }

  // ---- 8 INBOX empty, and with no ID in use ----
  {
    const W = withMessages(stubWallet(), true, []);
    W.cashuMsgPayments = () => [];
    await fresh(W, { screen: 'inbox', stack: ['home'] });
    ok(V().ibEmptyShown === true && V().ibRows.length === 0
      && text().indexOf('Ask another Foxy user for their Cashu ID to start chatting.') >= 0, 'nothing yet: Ask another Foxy user for their Cashu ID to start chatting.', text().slice(0, 300));
    ok(text().indexOf('No conversations yet') < 0, 'and the old words are gone');
    ok(!!screen().querySelector('svg[data-inbox-art]'), 'with a graphic: the CHAT icon drawn large');
    ok(/ADD A CASHU ID/.test(text()) && /CONTACTS/.test(text()), 'ADD A CASHU ID and CONTACTS', text().slice(-80));
    ok(/SCAN A CASHU ID/.test(text()), 'and SCAN A CASHU ID beside it');
    press(screen(), 'ADD A CASHU ID');
    await settle();
    ok(/PASTE A CASHU ID/.test(card()) && /foxyid1/.test(card()), 'ADD A CASHU ID opens the paste-a-Cashu-ID card', card());
    await addFlow(W, ID_ALICE, 'Alice');
    ok(A.state.screen === 'inbox', 'and the person is left on INBOX', A.state.screen);
    const W2 = withMessages(stubWallet(), false, []);
    await fresh(W2, { screen: 'inbox', stack: ['home'] });
    ok(V().ibOffShown === true && V().ibEmptyShown === false
      && text().indexOf('Messages go from your own Cashu ID. Open MY CASHU ID in the menu to start.') >= 0, 'no ID in use: open MY CASHU ID first', text().slice(0, 300));
    ok(V().chatBadgeShown === false, 'and no count');
    ok(/CONTACTS/.test(text()), 'the CONTACTS button is there too');
  }

  // ---- 8b INBOX's CONTACTS button, and back from it ----
  {
    const W = withMessages(stubWallet(), true, [
      { peer: ALICE, name: 'Alice', contact: true, card: '', unread: 0, msgs: [{ id: 'a', dir: 'in', text: 'Hi', at: T0, mark: '' }] }]);
    await W.cashuIdAdd(ID_ALICE, 'Alice');
    W.cashuMsgPayments = () => [];
    await fresh(W, { screen: 'inbox', stack: ['home'] });
    ok(V().ibRows.length === 1 && /CONTACTS/.test(text()), 'with a conversation: the CONTACTS button at the bottom');
    press(screen(), 'CONTACTS');
    await settle();
    ok(A.state.screen === 'contacts' && JSON.stringify(A.state.stack) === '["home","inbox"]', 'CONTACTS opens with INBOX under it', A.state.screen + ' ' + A.state.stack.join());
    V().contactAll.find((r) => r.name === 'Alice').tap();
    await settle();
    ok(A.state.screen === 'cidChat' && A.state.cmPeer === ALICE, 'a contact there opens that contact’s chat');
    A.back();
    await settle();
    A.back();
    await settle();
    ok(A.state.screen === 'inbox' && /INBOX/.test(text()), 'back from the chat and CONTACTS returns to INBOX', A.state.screen);
  }

  // ---- 8c empty CONTACTS ----
  {
    const W = withMessages(stubWallet(), true, []);
    await fresh(W, { screen: 'contacts', stack: ['home'] });
    ok(V().contactsEmpty === true
      && text().indexOf('Ask another Foxy user to share their Cashu ID with you to add them as a contact.') >= 0, 'empty CONTACTS: Ask another Foxy user to share their Cashu ID with you to add them as a contact.', text().slice(0, 300));
    ok(text().indexOf('Anyone you pay is saved here automatically.') < 0, 'and the old words are gone');
    ok(/ADD A CASHU ID/.test(text()), 'with ADD A CASHU ID');
    ok(/SCAN A CASHU ID/.test(text()), 'and SCAN A CASHU ID');
    press(screen(), 'ADD A CASHU ID');
    await settle();
    ok(/PASTE A CASHU ID/.test(card()), 'which opens the paste-a-Cashu-ID card', card());
    await addFlow(W, ID_ALICE, 'Alice');
    ok(A.state.screen === 'contacts' && V().contactsEmpty === false && /Alice/.test(text()), 'the saved contact is on the CONTACTS list, the empty state gone', text().slice(0, 200));
    // SCAN A CASHU ID: the camera's text goes the same way
    const W3 = withMessages(stubWallet(), true, []);
    W3.scan = (what) => { W3.scanned = what; return Promise.resolve(ID_ALICE); };
    await fresh(W3, { screen: 'contacts', stack: ['home'] });
    press(screen(), 'SCAN A CASHU ID');
    await settle();
    ok(W3.scanned === 'Scan a Cashu ID' && /NAME THIS CONTACT\?/.test(card()), 'SCAN A CASHU ID reads the camera, then NAME THIS CONTACT?', card());
    shutCard();
    // a wallet that cannot read an ID offers neither button
    const W4 = withMessages(stubWallet(), true, []);
    delete W4.cashuIdCheck;
    await fresh(W4, { screen: 'contacts', stack: ['home'] });
    ok(!/ADD A CASHU ID/.test(text()) && !/SCAN A CASHU ID/.test(text()), 'where the wallet cannot read an ID: neither button');
    const W5 = withMessages(stubWallet(), true, []);
    delete W5.scan;
    await fresh(W5, { screen: 'contacts', stack: ['home'] });
    ok(/ADD A CASHU ID/.test(text()) && !/SCAN A CASHU ID/.test(text()), 'where it cannot scan: ADD A CASHU ID alone');
  }

  // ---- 9 no FOXY CARD in the menu; MY CASHU ID's profile; CHAT opens INBOX; screens from the menu go back to it ----
  {
    const W = withMessages(stubWallet(), true, []);
    await fresh(W, { open0: true });
    const PROFILE = 'M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2ZM4.5 20.5c0-3.9 3.4-6.4 7.5-6.4s7.5 2.5 7.5 6.4';
    const items = V().menuItems;
    ok(items[0].label === 'WALLET' && items[1].label === 'MY CASHU ID' && !items.some((m) => m.label === 'FOXY CARD'),
      'MENU: WALLET, MY CASHU ID its first row, and no FOXY CARD (home’s CARD button opens the card)', items.map((m) => m.label).join());
    ok(items[1].path === PROFILE, 'MY CASHU ID has the profile drawing, a head and shoulders', items[1].path);
    const rows = () => [...w.document.querySelectorAll('div')].filter((d) => d.style.height === '60px' && d.style.borderRadius === '18px');
    const row = (label) => rows().find((d) => d.textContent.trim() === label);
    const click = async (label) => { row(label).dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); };
    const labels = V().menuItems.map((m) => m.label);
    ok(labels.indexOf('CHAT') === labels.indexOf('HISTORY') + 1 && labels.indexOf('CONTACTS') === labels.indexOf('CHAT') + 1 && labels.indexOf('CONTACTS') < labels.indexOf('MINTS'),
      'CHAT after HISTORY, CONTACTS after it, both in WALLET', labels.join());
    await click('CHAT');
    ok(A.state.screen === 'inbox' && !A.state.open0 && JSON.stringify(A.state.stack) === '["home"]', 'the menu’s CHAT opens INBOX too, and closes the menu', A.state.screen);
    A.back();
    await settle(); await settle();
    ok(A.state.screen === 'home' && A.state.open0 === true && !A.state.menuReturn, 'back off INBOX: home with the menu open again, where it was left', JSON.stringify([A.state.screen, A.state.open0]));
    await click('CONTACTS');
    ok(A.state.screen === 'contacts' && !A.state.open0, 'and CONTACTS stays the full list', A.state.screen);
    A.back();
    await settle(); await settle();
    ok(A.state.screen === 'home' && A.state.open0 === true, 'back off CONTACTS: the menu again', JSON.stringify([A.state.screen, A.state.open0]));
    await click('HISTORY');
    ok(A.state.screen === 'history' && !A.state.open0, 'HISTORY opens with the menu shut', A.state.screen);
    // a CLOSE that goes straight home, not a step back
    A.setState({ screen: 'home', stack: [] });
    await settle(); await settle();
    ok(A.state.open0 === true, 'left by a way that goes straight home: the menu again', String(A.state.open0));
    // once: the next way home from home's own buttons does not open it
    A.setState({ open0: false }); await settle();
    A.go('history'); await settle();
    A.back(); await settle(); await settle();
    ok(A.state.screen === 'home' && !A.state.open0, 'a screen opened from home, not the menu: home, the menu shut', String(A.state.open0));
    // a payment that ends on PAID ends at home with the menu shut
    A.setState({ open0: true }); await settle();
    await click('HISTORY');
    A.setState({ screen: 'paid', stack: [] }); await settle();
    A.setState({ screen: 'home', stack: [] }); await settle(); await settle();
    ok(A.state.screen === 'home' && !A.state.open0 && !A.state.menuReturn, 'a flow from the menu that ends on PAID: home, with the menu shut', JSON.stringify([A.state.open0, A.state.menuReturn]));
    // HIDE BALANCE is no screen: the drawer shuts, and the next trip home does not open it
    A.setState({ open0: true }); await settle();
    await click('HIDE BALANCE');
    ok(!A.state.open0 && !A.state.menuReturn && A.state.hidden === true, 'HIDE BALANCE shuts the drawer and leaves nothing to return to', JSON.stringify([A.state.open0, A.state.menuReturn]));
    A.setState({ hidden: false }); await settle();

    // MY CASHU ID is a stage over home: its DONE is the way back to the menu
    A.setState({ open0: true }); await settle();
    await click('MY CASHU ID'); await settle();
    ok(!!stage() && !A.state.open0 && A.state.screen === 'home', 'MY CASHU ID: its screen over home, the drawer shut');
    press(stage(), 'DONE'); await settle(); await settle();
    ok(!stage() && A.state.open0 === true && !A.state.menuReturn, 'MY CASHU ID’s DONE: the menu again', JSON.stringify([!!stage(), A.state.open0, A.state.menuReturn]));

    // a row that only says something (SWAP offline: a toast) leaves nothing armed: RECEIVE and back does not open the drawer
    {
      const two = A.twoUnitsOn, off = A.offlineNow;
      A.twoUnitsOn = () => true; A.offlineNow = () => true;
      A.setState({ open0: true, menuTick: 1 }); await settle();
      toasts = [];
      await click('SWAP'); await settle();
      A.twoUnitsOn = two; A.offlineNow = off;
      ok(toasts.indexOf('Swapping needs the mint.') >= 0 && !A.state.open0 && !A.state.menuReturn, 'SWAP offline: the toast, the drawer shut, nothing armed', JSON.stringify([toasts, A.state.menuReturn]));
      V().goReceive(); await settle();
      A.back(); await settle(); await settle();
      ok(A.state.screen === 'home' && !A.state.open0, 'and RECEIVE then back, at once: home with the drawer shut', JSON.stringify([A.state.screen, A.state.open0]));
    }

    // a payment that comes in over home while a menu row's stage is up: dismissed, home with the drawer shut
    A.setState({ open0: true, screen: 'home', stack: [] }); await settle();
    await click('MY CASHU ID'); await settle();
    A._returnTo = { screen: 'home', stack: [] };
    A.setState({ screen: 'paid', stack: [] }); await settle();
    ok(!A.state.menuReturn, 'PAID raised over home: an end, nothing armed', JSON.stringify(A.state.menuReturn));
    A._returnTo = null;
    A.setState({ screen: 'home', stack: [] }); await settle(); await settle();
    A.hideStage(); await settle(); await settle();
    ok(A.state.screen === 'home' && !A.state.open0, 'and dismissed: home with the drawer shut', String(A.state.open0));

    // a swap from the menu that ends at home while the mint finishes it: home and its card, the drawer shut
    {
      A.setState({ open0: true }); await settle();
      A.menuReturnArm(); await settle();
      A.setState({ screen: 'swap', stack: ['home'] }); await settle();
      A.setState({ screen: 'swapConfirm', stack: ['home', 'swap'] }); await settle();
      const card0 = A.swapPendingCard;
      let carded = 0;
      A.swapPendingCard = () => { carded += 1; };
      A.swapStillGoing({ state: 'pending' }); await settle(); await settle();
      A.swapPendingCard = card0;
      ok(carded === 1 && A.state.screen === 'home' && !A.state.open0 && !A.state.menuReturn, 'a swap still going: home with its card, the drawer shut', JSON.stringify([carded, A.state.open0, A.state.menuReturn]));
    }

    // a link opened while a screen from the menu is up ends where the link goes, with the drawer shut
    A.setState({ open0: true }); await settle();
    await click('HISTORY');
    w.location.hash = '#foxy=home';
    A.applyDeepLink(); await settle(); await settle();
    ok(A.state.screen === 'home' && !A.state.open0 && !A.state.menuReturn, 'a link to home from HISTORY: home, the drawer shut', JSON.stringify([A.state.screen, A.state.open0, A.state.menuReturn]));
    // POINT OF SALE under Face ID, answered yes, then ACCEPT TIPS? shut with no answer: nothing left armed
    {
      const W2 = w.FoxyWallet;
      const keep = { screenLocked: W2.screenLocked, faceLock: W2.faceLock, biometric: W2.biometric, pinIsSet: W2.pinIsSet };
      Object.assign(W2, { screenLocked: () => true, faceLock: () => true, biometric: () => Promise.resolve('yes'), pinIsSet: () => false });
      A.setState({ open0: true, screen: 'home', stack: [], till: null }); await settle();
      await click('POINT OF SALE'); await settle(); await settle();
      const asked = !!A._blockedEl && /TIP/i.test(card());
      if (A._blockedEl) A._blockedEl.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await settle(); await settle();
      Object.assign(W2, keep);
      ok(asked && !A._blockedEl && !A.state.till && !A.state.menuReturn, 'POINT OF SALE: Face ID yes, ACCEPT TIPS? shut unanswered: no till, nothing armed',
        JSON.stringify([asked, !!A._blockedEl, !!A.state.till, A.state.menuReturn]));
      A.setState({ open0: false }); await settle();
      A.go('history'); await settle(); A.back(); await settle(); await settle();
      ok(A.state.screen === 'home' && !A.state.open0, 'and a trip from home and back after it: the drawer shut', String(A.state.open0));
    }
    // a card closed by its own button is the way back: RESTORE LOST CARD with no card
    {
      const W2 = w.FoxyWallet;
      const fcW = A.fcW;
      A.fcW = () => Object.assign({}, W2, { cardsList: () => [] });
      A.setState({ open0: true }); await settle();
      await click('RESTORE LOST CARD'); await settle();
      A.fcW = fcW;
      const btn = A._blockedEl && [...A._blockedEl.querySelectorAll('div')].filter((d) => d.children.length === 0 && /^[A-Z ]{2,}$/.test(d.textContent.trim()) && d.style.cursor === 'pointer').pop();
      ok(!!btn && !A.state.open0, 'RESTORE LOST CARD with no card: its card over home, the drawer shut', btn ? btn.textContent : card());
      if (btn) btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await settle(); await settle();
      ok(!A._blockedEl && A.state.open0 === true && !A.state.menuReturn, 'its card closed: the menu again', JSON.stringify([!!A._blockedEl, A.state.open0, A.state.menuReturn]));
      A.setState({ open0: false }); await settle();
    }
  }

  // ---- 10 the whole menu: the keeper's order, every section open, BACKUP ACCOUNT's rule ----
  {
    const ORDER = ['WALLET', 'MY CASHU ID', 'HISTORY', 'CHAT', 'CONTACTS', 'HIDE BALANCE',
      'MINTS', 'SWITCH/ADD MINTS', 'TRANSFER MONEY',
      'TOOLS', 'POINT OF SALE', 'SPLIT A BILL',
      'SETTINGS', 'BLUETOOTH TAP', 'SET PIN', 'FACE ID LOCK', 'BACKUP', 'RESTORE', 'RESTORE LOST CARD', 'TEST LOGS',
      'OFFLINE LIMITS', 'PER PERSON', 'TOTAL'];
    const full = (o) => {
      const W = withMessages(stubWallet(), true, []);
      W.mints = () => [MINT, 'https://other.example.com'];
      W.balanceAt = () => 1000;
      W.tillCaps = () => ({ payerSats: 62500, payerCents: 5000, holdSats: 375000, holdCents: 30000 });
      W.backedUp = () => !!o.verified;
      return W;
    };
    const labels = () => V().menuItems.map((m) => m.label);
    // money, words checked: no BACKUP ACCOUNT
    await fresh(full({ verified: true }), { open0: true, balSats: 50000 });
    ok(JSON.stringify(labels()) === JSON.stringify(ORDER), 'the keeper’s order, every section open', labels().join(', '));
    const items = V().menuItems;
    const heads = ['WALLET', 'MINTS', 'TOOLS', 'SETTINGS', 'OFFLINE LIMITS'];
    ok(items.filter((m) => m.hasChev).map((m) => m.label).join() === heads.join()
       && items.filter((m) => m.hasChev).every((m) => m.chevRot === 'rotate(90deg)'), 'five sections, OFFLINE LIMITS its own after SETTINGS, each opening and closing, each open');
    ok(items.filter((m) => !m.hasChev).every((m) => m.indent === '10px')
       && items.filter((m) => heads.indexOf(m.label) >= 0).every((m) => m.indent === '0px'),
      'every row a step in, PER PERSON and TOTAL too', items.map((m) => m.label + ' ' + m.indent).join(', '));
    ok(['AUTO TAP TO PAY', 'YOUR CHANGE', 'FOXY CARD'].every((l) => labels().indexOf(l) < 0), 'no AUTO TAP TO PAY, no YOUR CHANGE, no FOXY CARD', labels().join(', '));
    {
      // BLUETOOTH TAP: a switch in SETTINGS before SET PIN, on by default; pressing it writes the stored key and the next draw shows it
      const row = () => V().menuItems.find((m) => m.label === 'BLUETOOTH TAP');
      const L = labels();
      ok(!!row() && L.indexOf('BLUETOOTH TAP') === L.indexOf('SETTINGS') + 1 && L.indexOf('SET PIN') === L.indexOf('BLUETOOTH TAP') + 1,
        'BLUETOOTH TAP is a row of SETTINGS, straight before SET PIN', L.join(', '));
      ok(row().hasSwitch === true && row().swX === '18px' && row().indent === '10px' && A.tapAutoArms() === true, 'a switch, on by default, a step in');
      const keep = w.localStorage.getItem('foxy.tap.auto');
      row().tap();
      ok(w.localStorage.getItem('foxy.tap.auto') === 'off' && A.tapAutoArms() === false, 'pressed: the stored key is off and receive screens do not arm');
      ok(row().swX === '0px', 'and the switch shows it off');
      row().tap();
      ok(w.localStorage.getItem('foxy.tap.auto') === 'on' && A.tapAutoArms() === true, 'pressed again: on');
      if (keep === null) w.localStorage.removeItem('foxy.tap.auto'); else w.localStorage.setItem('foxy.tap.auto', keep);
    }
    /* The gap above a heading is the gap the eye sees under MENU: the word about 8px up in its 44px row, the header's 6px
     * and the list's 10px, so 14px more than the list's 10px over every heading after the first, and nothing over a row. */
    ok(items.every((m) => m.headTop === (m.hasChev && m.label !== 'WALLET' ? '14px' : '0px')), 'a heading after the first has 14px over it, nothing else does',
      items.map((m) => m.label + ' ' + m.headTop).join(', '));
    {
      const drawer = w.document.querySelector('[data-menu-drawer]');
      const header = drawer && drawer.children[0];
      const gap = drawer ? parseFloat(drawer.style.gap) : NaN;
      const under = header ? parseFloat(header.style.marginBottom) : NaN;
      const drawnRows = [...drawer.querySelectorAll('div')].filter((d) => d.style.height === '60px' && d.style.borderRadius === '18px');
      const top = (label) => { const d = drawnRows.find((r) => r.textContent.trim().replace(/\$.*$|₿.*$/, '').trim() === label); return d ? parseFloat(d.style.marginTop || '0') : NaN; };
      const word = header ? header.children[0] : null;
      const rowH = header ? parseFloat((header.children[1] || {}).style.height) : NaN;
      const wordPx = word ? parseFloat(word.style.fontSize) : NaN;
      // the word's own box at Sora's line height (about 1.26), centred in the row: what is under it, then the 6px and the 10px
      const seen = Math.round((rowH - wordPx * 1.26) / 2) + under + gap;
      ok(gap === 10 && under === 6 && rowH === 44 && wordPx === 22 && heads.slice(1).every((h) => gap + top(h) === seen) && top('WALLET') === 0 && top('HISTORY') === 0 && top('PER PERSON') === 0,
        'drawn: over MINTS, TOOLS, SETTINGS and OFFLINE LIMITS the 24px the eye sees from MENU to WALLET; rows keep the 10px',
        JSON.stringify([gap, under, rowH, wordPx, seen, heads.map(top), top('HISTORY')]));
    }
    const per = items.find((m) => m.label === 'PER PERSON');
    ok(/50\.00/.test(per.value) && /300\.00/.test(items.find((m) => m.label === 'TOTAL').value), 'PER PERSON and TOTAL with their figures', per.value);
    const drawn = [...w.document.querySelectorAll('div')].filter((d) => d.style.height === '60px' && d.style.borderRadius === '18px')
      .map((d) => d.textContent.trim().replace(/\$.*$|₿.*$/, '').trim());
    ok(drawn.length === ORDER.length && drawn[0] === 'WALLET' && drawn[drawn.length - 1] === 'TOTAL', 'all drawn in the drawer', drawn.join(', '));
    // each section shuts and opens in place; the drawer stays
    for (const h of heads) {
      const n0 = labels().length;
      V().menuItems.find((m) => m.label === h).tap();
      await settle();
      const shut = labels();
      ok(A.state.open0 === true && shut.indexOf(h) >= 0 && shut.length < n0 && V().menuItems.find((m) => m.label === h).chevRot === 'rotate(0deg)',
        h + ' tapped: shut, the drawer stays', shut.join(', '));
      V().menuItems.find((m) => m.label === h).tap();
      await settle();
      ok(JSON.stringify(labels()) === JSON.stringify(ORDER), h + ' tapped again: open');
    }
    // OFFLINE LIMITS only while the wallet has caps to show
    {
      const noCaps = full({ verified: true });
      noCaps.tillCaps = () => null;
      await fresh(noCaps, { open0: true, balSats: 50000 });
      ok(labels().indexOf('OFFLINE LIMITS') < 0 && labels()[labels().length - 1] === 'TEST LOGS', 'no caps: no OFFLINE LIMITS section', labels().join(', '));
      await fresh(full({ verified: true }), { open0: true, balSats: 50000 });
    }
    // the rows the keeper renamed, doing what they did
    const went = [];
    A.goSwitchMint = () => went.push('switch');
    A.goTransfer = () => went.push('transfer');
    A.goFieldLog = (x) => went.push('logs ' + x);
    A.setState({ open0: true }); await settle();
    V().menuItems.find((m) => m.label === 'SWITCH/ADD MINTS').tap();
    A.setState({ open0: true }); await settle();
    V().menuItems.find((m) => m.label === 'TRANSFER MONEY').tap();
    A.setState({ open0: true }); await settle();
    V().menuItems.find((m) => m.label === 'TEST LOGS').tap();
    ok(went.join() === 'switch,transfer,logs false' && !A.state.open0, 'SWITCH/ADD MINTS, TRANSFER MONEY and TEST LOGS do what SWITCH, TRANSFER and LOGS did', went.join());
    delete A.goSwitchMint; delete A.goTransfer; delete A.goFieldLog;

    // BACKUP ACCOUNT: at the very top, only with money in the wallet and the words not checked
    await fresh(full({ verified: false }), { open0: true, balSats: 50000 });
    let top = V().menuItems[0];
    ok(top.label === 'BACKUP ACCOUNT' && top.indent === '0px' && top.ring !== 'none' && /alertGlow/.test(top.glow)
       && V().menuItems[1].label === 'WALLET' && V().menuItems[1].headTop === '14px'
       && JSON.stringify(labels().slice(1)) === JSON.stringify(ORDER), 'money, words not checked: BACKUP ACCOUNT at the very top, with the red ring, then the rest, WALLET with a heading’s gap over it',
      labels().slice(0, 3).join(', '));
    const shown = [];
    A.showSeedOnPhone = (x) => shown.push(x);
    top.tap();
    ok(shown.length === 1 && shown[0] === false && !A.state.open0, 'it opens the words, as BACKUP does');
    delete A.showSeedOnPhone;
    await fresh(full({ verified: false }), { open0: true, balSats: 0, balUsdCents: 125 });
    ok(V().menuItems[0].label === 'BACKUP ACCOUNT', 'dollars count as money');
    await fresh(full({ verified: false }), { open0: true, balSats: 0, balUsdCents: 0 });
    ok(V().menuItems[0].label === 'WALLET' && labels().indexOf('BACKUP') > labels().indexOf('SETTINGS'), 'no money: no BACKUP ACCOUNT; BACKUP stays in SETTINGS', labels().slice(0, 2).join());
    await fresh(full({ verified: true }), { open0: true, balSats: 50000 });
    ok(V().menuItems[0].label === 'WALLET' && labels().indexOf('BACKUP ACCOUNT') < 0, 'words checked: none');
    // no PUSH NOTIFICATIONS and no PRIVATE LNURL, even from a wallet that still says a wake server is set and the switch is on
    const old = full({ verified: true });
    old.wakeView = () => ({ state: 'on', forget: false, server: true });
    old.lnurlView = () => ({ code: 'lnurl1dp68gurn8ghj7', collecting: 0 });
    await fresh(old, { open0: true });
    ok(labels().indexOf('PUSH NOTIFICATIONS') < 0 && labels().indexOf('PRIVATE LNURL') < 0 && labels().indexOf('SET PIN') === labels().indexOf('SETTINGS') + 2,
      'no PUSH NOTIFICATIONS and no PRIVATE LNURL rows: Foxy talks to no server run for it', labels().join(', '));
    // and TRANSFER MONEY its own: money at one mint, none
    const one = full({ verified: true });
    one.balanceAt = (m) => (m === MINT ? 1000 : 0);
    await fresh(one, { open0: true });
    ok(labels().indexOf('TRANSFER MONEY') < 0, 'money at one mint: no TRANSFER MONEY', labels().join(', '));
    A.setState({ open0: false });
    await settle();
  }

  if (errors.length) console.log('page errors:\n  ' + errors.slice(0, 5).join('\n  '));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
