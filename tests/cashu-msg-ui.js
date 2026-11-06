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
 *   8  INBOX empty, and with no ID in use
 *   9  FOXY CARD is the first row of the menu's WALLET, with the card drawing, and does what home's CARD button did; CHAT
 *      there opens INBOX, CONTACTS the full list
 *  10  the whole menu in the keeper's order (21-render-values.js): WALLET, MINTS, TOOLS, SETTINGS, every section open and
 *      each shutting in place; OFFLINE LIMITS with PER PERSON and TOTAL; the renamed rows doing what they did; BACKUP
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
      satUsd: PRICE / 1e8, screen: 'home', stack: [], open0: false, menuSettingsOpen: false, till: null, history: [], contacts: W.book() }, state || {}));
    await settle();
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
      && text().indexOf('No conversations yet. Share MY CASHU ID to be paid or messaged.') >= 0, 'nothing yet: said in the app’s words', text().slice(0, 300));
    const W2 = withMessages(stubWallet(), false, []);
    await fresh(W2, { screen: 'inbox', stack: ['home'] });
    ok(V().ibOffShown === true && V().ibEmptyShown === false
      && text().indexOf('Messages go from your own Cashu ID. Open MY CASHU ID in the menu to start.') >= 0, 'no ID in use: open MY CASHU ID first', text().slice(0, 300));
    ok(V().chatBadgeShown === false, 'and no count');
  }

  // ---- 9 FOXY CARD, the first row of the menu's WALLET; CHAT there opens INBOX ----
  {
    const W = withMessages(stubWallet(), true, []);
    await fresh(W, { open0: true });
    const CARD_ICON = 'M4.6 5.5h14.8a2.1 2.1 0 0 1 2.1 2.1v8.8a2.1 2.1 0 0 1-2.1 2.1H4.6a2.1 2.1 0 0 1-2.1-2.1V7.6a2.1 2.1 0 0 1 2.1-2.1ZM2.5 10h19M6 15h4';
    const items = V().menuItems;
    ok(items[0].label === 'WALLET' && items[1].label === 'FOXY CARD' && items[1].path === CARD_ICON && items[1].indent === '10px',
      'MENU: WALLET, and FOXY CARD its first row, with the card drawing', items.map((m) => m.label).join());
    const rows = () => [...w.document.querySelectorAll('div')].filter((d) => d.style.height === '60px' && d.style.borderRadius === '18px');
    const first = rows().find((d) => d.textContent.trim() === 'FOXY CARD');
    ok(!!first && rows().indexOf(first) === 1, 'drawn as the drawer’s second row, under WALLET', first ? first.textContent : 'none');
    const went = [];
    const real = A.goFlashcard;
    A.goFlashcard = function () { went.push([...arguments]); };
    first.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    A.goFlashcard = real;
    ok(went.length === 1 && went[0].length === 0 && !A.state.open0, 'it closes the menu and opens the card’s screen (`goFlashcard`), as CARD did', JSON.stringify(went));
    A.setState({ open0: true });
    await settle();
    const labels = V().menuItems.map((m) => m.label);
    ok(labels.indexOf('CHAT') === labels.indexOf('HISTORY') + 1 && labels.indexOf('CONTACTS') === labels.indexOf('CHAT') + 1 && labels.indexOf('CONTACTS') < labels.indexOf('MINTS'),
      'CHAT after HISTORY, CONTACTS after it, both in WALLET', labels.join());
    const chatRow = rows().find((d) => d.textContent.trim() === 'CHAT');
    chatRow.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    ok(A.state.screen === 'inbox' && !A.state.open0 && JSON.stringify(A.state.stack) === '["home"]', 'the menu’s CHAT opens INBOX too, and closes the menu', A.state.screen);
    A.back();
    await settle();
    A.setState({ open0: true });
    await settle();
    rows().find((d) => d.textContent.trim() === 'CONTACTS').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    ok(A.state.screen === 'contacts', 'and CONTACTS stays the full list', A.state.screen);
    A.back();
    await settle();
  }

  // ---- 10 the whole menu: the keeper's order, every section open, BACKUP ACCOUNT's rule ----
  {
    const ORDER = ['WALLET', 'FOXY CARD', 'MY CASHU ID', 'HISTORY', 'CHAT', 'CONTACTS', 'HIDE BALANCE', 'YOUR CHANGE',
      'MINTS', 'SWITCH/ADD MINTS', 'TRANSFER MONEY',
      'TOOLS', 'POINT OF SALE', 'SPLIT A BILL',
      'SETTINGS', 'AUTO TAP TO PAY', 'SET PIN', 'FACE ID LOCK', 'OFFLINE LIMITS', 'PER PERSON', 'TOTAL',
      'BACKUP', 'RESTORE', 'RESTORE LOST CARD', 'TEST LOGS'];
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
    const heads = ['WALLET', 'MINTS', 'TOOLS', 'SETTINGS'];
    ok(items.filter((m) => m.hasChev).map((m) => m.label).join() === heads.concat(['OFFLINE LIMITS']).join()
       && items.filter((m) => m.hasChev).every((m) => m.chevRot === 'rotate(90deg)'), 'four sections and OFFLINE LIMITS, each opening and closing, each open');
    ok(items.filter((m) => !m.hasChev).every((m) => m.indent === (m.label === 'PER PERSON' || m.label === 'TOTAL' ? '20px' : '10px'))
       && items.filter((m) => heads.indexOf(m.label) >= 0).every((m) => m.indent === '0px'),
      'the rows a step in, PER PERSON and TOTAL a step further', items.map((m) => m.label + ' ' + m.indent).join(', '));
    const per = items.find((m) => m.label === 'PER PERSON');
    ok(/50\.00/.test(per.value) && /300\.00/.test(items.find((m) => m.label === 'TOTAL').value), 'PER PERSON and TOTAL with their figures', per.value);
    const drawn = [...w.document.querySelectorAll('div')].filter((d) => d.style.height === '60px' && d.style.borderRadius === '18px')
      .map((d) => d.textContent.trim().replace(/\$.*$|₿.*$/, '').trim());
    ok(drawn.length === ORDER.length && drawn[0] === 'WALLET' && drawn[drawn.length - 1] === 'TEST LOGS', 'all drawn in the drawer', drawn.join(', '));
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
    V().menuItems.find((m) => m.label === 'OFFLINE LIMITS').tap();
    await settle();
    ok(labels().indexOf('PER PERSON') < 0 && labels().indexOf('OFFLINE LIMITS') >= 0 && labels().indexOf('BACKUP') === labels().indexOf('OFFLINE LIMITS') + 1,
      'OFFLINE LIMITS shuts on its own', labels().join(', '));
    V().menuItems.find((m) => m.label === 'OFFLINE LIMITS').tap();
    await settle();
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
       && JSON.stringify(labels().slice(1)) === JSON.stringify(ORDER), 'money, words not checked: BACKUP ACCOUNT at the very top, with the red ring, then the rest',
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
    ok(labels().indexOf('PUSH NOTIFICATIONS') < 0 && labels().indexOf('PRIVATE LNURL') < 0 && labels().indexOf('AUTO TAP TO PAY') === labels().indexOf('SETTINGS') + 1,
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
