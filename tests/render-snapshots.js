'use strict';
/* render-snapshots.js — what every screen, card and dialog draws, recorded.
 *
 *     node tests/render-snapshots.js              compare with tests/snapshots/render/
 *     node tests/render-snapshots.js --update     write them again
 *     node tests/render-snapshots.js --vals DIR   also write each view's renderVals(), in full, to DIR
 *
 * render-parity.js asks whether two renderers draw the same thing. This asks
 * whether the page still draws what it drew when these files were written: the
 * real template and app class, rendered in jsdom by build/foxy-render.js,
 * through a fixed list of views —
 *
 *   - with no wallet: the first render, every screen the app names and every
 *     popup flag in its state (the views render-parity.js covers);
 *   - against a stand-in wallet: each screen in representative states — a
 *     balance, a chart, history, an invoice, a fee, a restore scan, a split bill;
 *   - the cards and dialogs the app builds in plain DOM on document.body
 *     (blockedCard and its callers, the PIN pad, the seed and verify screens,
 *     the note and mint sheets, the melt loader, the price bar).
 *
 * Each view's markup is compared byte for byte with its file in
 * tests/snapshots/render/ (the file is the markup with a line break between
 * tags, for reading; index.json holds the SHA-256 of the markup as rendered).
 * index.json also holds a hash of everything renderVals() returned — values,
 * and handlers by their source text — so a handler that changes is caught
 * even where the markup cannot show it.
 *
 * Written before renderValsBase was split into a render function
 * per screen, to show the split draws every view identically. A change meant
 * to alter a view runs --update and commits the difference. */
process.env.TZ = 'UTC';
const { JSDOM, VirtualConsole } = require('jsdom');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'snapshots', 'render');
const UPDATE = process.argv.includes('--update');
const VALS_DIR = process.argv.includes('--vals') ? process.argv[process.argv.indexOf('--vals') + 1] : null;
const VERBOSE = process.argv.includes('--verbose');

// the page's pieces, from their committed sources, as render-parity.js builds them
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
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

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
  // the same text on every machine: a number or a sort with no locale named is read as en-US
  run('(function(){var n=Number.prototype.toLocaleString;Number.prototype.toLocaleString=function(l,o){return n.call(this,l===undefined?"en-US":l,o);};'
    + 'var c=String.prototype.localeCompare;String.prototype.localeCompare=function(t,l,o){return c.call(this,t,l===undefined?"en-US":l,o);};})();');
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

/* everything renderVals() returned, as text: keys sorted, handlers by their
 * source, React elements by type and props, DOM nodes by name */
function serial(v, seen, depth) {
  seen = seen || new Set();
  depth = depth || 0;
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'undefined') return 'undefined';
  if (t === 'function') return 'fn ' + v.toString();
  if (t === 'string') return JSON.stringify(v);
  if (t !== 'object') return String(v);
  if (v.nodeType) return '[node ' + v.nodeName + ']';
  if (seen.has(v) || depth > 16) return '[seen]';
  seen.add(v);
  let out;
  if (v.$$typeof) {
    const type = typeof v.type === 'string' ? v.type : 'component';
    out = '<' + type + ' key=' + JSON.stringify(v.key) + ' ' + serial(v.props, seen, depth + 1) + '>';
  } else if (Array.isArray(v)) {
    out = '[' + v.map((x) => serial(x, seen, depth + 1)).join(',\n') + ']';
  } else {
    out = '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ': ' + serial(v[k], seen, depth + 1)).join(',\n') + '}';
  }
  seen.delete(v);
  return out;
}

/* ---- the stand-in wallet ------------------------------------------------ */
const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const MINT = 'https://mint.minibits.cash/Bitcoin';
const OTHER = 'https://strange.example.com';
const INVOICE_THIS_MINT = 'lnbc21u1pexample';

function wallet(over) {
  return Object.assign({
    connected: true,
    mintUrl: MINT,
    mintHost: () => 'mint.minibits.cash/Bitcoin',
    mints: () => [MINT, OTHER],
    qr: (text, o) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)) + (o && o.ecc ? ';ecc=' + o.ecc : ''),
    amountOf: (inv) => (/^lnbc/.test(String(inv)) ? 2100 : null),
    // a request names sats or dollars, never both: offline, asking to be paid
    // is in dollars and the paying phone works out the sats (price-terms.js)
    paymentRequest: (sats, opt) => (Math.round(Number(opt && opt.usd) || 0) > 0)
      ? 'creqAstub$' + Math.round(Number(opt.usd))
      : 'creqAstub' + (sats || 0),
    classify: (t) => (/^lnbc/.test(t) ? 'invoice' : /@/.test(t) ? 'lnurl' : 'unknown'),
    auditTrail: (hash) => (hash === 'hash-audit'
      ? [{ inputs: [{ amount: 64, id: '00ab', secret: 'secret-one' }, { amount: 32, id: '00ab', secret: 'secret-two' }],
        outputs: [{ amount: 90, id: '00ab', secret: 'secret-three' }] }]
      // a payment locked to the phone that asked, with the signature its pieces were spent with
      : hash === 'hash-receipt'
      ? [{ kind: 'token', mint: 'https://m.example', at: 1700000000, sats: 21, lockedTo: '02' + 'ab'.repeat(32),
        ys: ['02' + 'cd'.repeat(32)],
        inputs: [{ amount: 21, id: '00ab', secret: '["P2PK",{"nonce":"n","data":"02' + 'ab'.repeat(32) + '","tags":[]}]', C: '02' + 'ef'.repeat(32) }],
        outputs: [], spent: { at: 1700000100, witness: ['{"signatures":["' + '9'.repeat(128) + '"]}'] } }]
      // older than the last hundred: a receipt, with the pieces themselves let go
      : hash === 'hash-slim'
      ? [{ kind: 'token', mint: 'https://m.example', at: 1690000000, sats: 500, slim: true, ins: 4, outs: 7,
        ys: ['02' + 'cd'.repeat(32)] }]
      : []),
    lastToken: () => ({ token: 'cashuBstubtoken', sats: 1234, hash: 'tok-hash' }),
    clearLastToken() {},
    tagsFor: () => ({ note: 'lunch money' }),
    tag() {},
    backedUp: () => false,
    pinIsSet: () => false,
    pinClear() {},
    // the seed and its words are the phone's: its screens, which never answer here
    showSeedNative: () => new Promise(() => {}),
    enterSeedNative: () => new Promise(() => {}),
    forgetSeedCandidate: () => Promise.resolve(true),
    reason: (e) => String((e && e.message) || e),
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: 5000, mint: MINT }, { unit: 'usd', amount: 123, mint: 'https://stablenut.example.com' }],
    mintDown: (url) => (String(url).indexOf('strange') >= 0 ? { firstFailAt: Date.UTC(2020, 8, 12, 10, 42) } : null),
    quarantinedSats: () => 2100,
    quarantinedUnknown: () => 100,
    tokensNotClaimed: () => Promise.resolve([{ sats: 100 }, { sats: 21 }]),
    clearHistory() {},
    clearContacts() {},
    splitClear() {},
    share: () => true,
    // asked for by the send confirmation as it opens; never answers here
    quoteFee: () => new Promise(() => {}),
    agreedRate: () => new Promise(() => {}),
  }, over || {});
}

const LIVE = { walletLive: true, balSats: 250000, balUsd: 0, livePrice: 64000 };
const TX_IN = { name: 'Alice', dir: 'in', time: '10:42', sats: 2100, fee: 0, hash: 'hash-audit', note: 'pizza', token: 'cashuBclaimed', party: 'alice@example.com' };
/* A payment accepted while both phones were offline and not yet swapped in. */
const TX_AT_RISK = { name: 'Paid in person', dir: 'in', time: '14:20', sats: 4900, fee: 0,
  rail: 'CASHU', hash: 'req-atrisk', pending: true, atRisk: true, note: '' };
/* Paid by a card while this phone was offline, and not settled with the mint yet: received, amber, with the day to be online by.
 * Its date is fixed and far off, so the words do not turn on today's date. */
const TX_CARD_KEPT = { name: 'From a card', dir: 'in', time: '14:31', sats: 592, fee: 0, rail: 'CASHU', hash: 'req-card-kept',
  memo: 'card, offline', cardWaits: true, cardKept: 'waiting', cardDate: 4102444800, note: '' };
const TX_OUT = { name: 'bob@example.com', dir: 'out', time: 'Yesterday', sats: 5000, fee: 12, pending: true, rail: 'LIGHTNING', hash: 'hash-out' };
const TX_USD = { name: 'Stablenut', dir: 'in', time: 'Sep 3', unit: 'usd', amount: 250, feeAmount: 1 };
const TX_CASH = { name: 'Carol', dir: 'out', time: 'Sep 2', usd: 4.5, sats: 7000 };
const TX_SPLIT = { name: 'Dinner', dir: 'in', time: 'Sep 1', sats: 9000, split: true, pending: true };
const TX_FAILED = { name: 'dave@example.com', dir: 'out', time: 'Aug 30', sats: 300, fee: 0, failed: true, hash: 'hash-failed' };
const TX_SENT = { name: 'ecash', dir: 'out', time: 'Aug 29', sats: 21, fee: 0, hash: 'hash-sent' };
const CONTACTS = [
  { name: 'Bob', handle: 'bob@walletofsatoshi.com', tint: '#5A5A5A' },
  { name: 'alice', handle: 'alice@example.com' },
  { name: 'Zed', handle: 'zed@example.com', tint: '#DC7F1C' },
];
const SERIES = { '1D': { pts: [[0, 60], [50, 40], [100, 20]], d: 'M0 60L50 40L100 20', y: 20, t: '+2.1% today' } };

// a representative state of a screen, against the stand-in wallet
const at = (screen, state, extra) => Object.assign({ wallet: true, state: Object.assign({ screen, stack: [] }, LIVE, state || {}) }, extra || {});

function representative(logic) {
  const v = [];
  const add = (label, view) => v.push([label, view]);
  // home
  add('home, a balance and a chart', at('home', { series: SERIES, range: '1D' }));
  add('home, balance hidden', at('home', { hidden: true, series: SERIES, range: '1D' }));
  add('home, the menu open', at('home', { open0: true }));
  add('home, price collapsed', at('home', { priceCollapsed: true }));
  add('home, price removed', at('home', { priceRemoved: true }));
  add('home, balance loading, no price', at('home', { balSats: null, livePrice: null }));
  add('home, a credit counting up', at('home', { animFrom: { usd: 0, sats: 200000 }, animT: 0.5, animLane: 'btc' }));
  add('home, backup prompt due', at('home', { everReceived: true, dismissedBackup: false }));
  add('home, the PIN set', at('home', { open0: true }, { wallet: { pinIsSet: () => true } }));

  /* Working offline, which no other view can show.
   *
   * The stand-in wallet has no `privacy`, so `torBannerVals` reads null and every
   * other snapshot has no banner at all. These four give it one — which is the
   * only way the offline screens get pinned as pictures rather than as rules.
   * The home banner, the receive screen with one network it cannot
   * change, and the send screen with two of four rows dimmed. */
  const OFFLINE = { privacy: () => ({ tor: 'connecting', progress: 0, everUp: true,
                                      unprotected: false, offline: true,
                                      orbot: 'none', vpn: false, orbotKey: false }) };
  const ONLINE = { privacy: () => ({ tor: 'up', progress: 100, everUp: true,
                                     unprotected: false, offline: false,
                                     orbot: 'none', vpn: false, orbotKey: false }) };
  /* SEE CHANGE, which is the one screen that answers "can this phone pay an exact
   * amount" — the only question that matters offline. Listed with none held as
   * well, because a small tier of zeroes is the state worth seeing. */
  const PIECES = (rows) => ({ pieces: () => rows });
  add('change, a full pool', at('change', {}, { wallet: PIECES([
    { amount: 1, count: 12, want: 12 }, { amount: 2, count: 12, want: 12 },
    { amount: 4, count: 12, want: 12 }, { amount: 8, count: 12, want: 12 },
    { amount: 16, count: 12, want: 12 }, { amount: 32, count: 12, want: 12 },
    { amount: 64, count: 12, want: 12 }, { amount: 128, count: 12, want: 12 },
    { amount: 256, count: 7, want: 8 }, { amount: 4096, count: 1, want: 0 },
  ]) }));
  add('change, short of small pieces', at('change', {}, { wallet: PIECES([
    { amount: 1, count: 0, want: 12 }, { amount: 2, count: 3, want: 12 },
    { amount: 4, count: 12, want: 12 }, { amount: 8, count: 1, want: 12 },
    { amount: 16, count: 0, want: 12 }, { amount: 32, count: 12, want: 12 },
    { amount: 64, count: 12, want: 12 }, { amount: 128, count: 12, want: 12 },
    { amount: 2048, count: 2, want: 8 },
  ]) }));
  add('change, nothing held', at('change', {}, { wallet: PIECES([]) }));
  /* FLASHCARD: the invitation to tap, and a card as each kind reads. Dates are
   * fixed and far off, so no view turns on today's date; the state that does
   * (RENEW, in a card's last month) is tests/flashcard-screens.js's. */
  const CARDS = (over) => Object.assign({ cardSession: () => Promise.resolve(), cardOwed: () => [], cardsList: () => [] }, over || {});
  const KEY_A = '02' + 'a1'.repeat(30) + 'c3d4';
  const KEY_B = '03' + 'b2'.repeat(30) + '9f0e';
  const KEY_C = '02' + 'c3'.repeat(30) + '77ab';
  const FC = (over) => Object.assign({ key: KEY_A, balance: 2048, count: 12, room: 52, pin: 'set', locked: false,
    hasRecord: true, setUp: true, pinSet: true, limit: 0, day: null, owner: true, ownedHere: true, mint: MINT, recoverable: true, mine: true, first: 4102444800, last: 4102444800, check: 'ok',
    // when the mint's word was had, far off and fixed, so the line under the title is the same every day
    checkedAt: 4102358400000 }, over || {});
  // a card with a daily limit of 5,000 sats, 1,200 of it left, and its day turning at a fixed hour far off
  const DAY = { limited: true, limit: 5000, spent: 3800, left: 1200, turns: 4102444800, now: 4102358400, noTime: false };
  // the card's three amounts, on the keypad every amount is typed on
  add('amount, adding to a card', at('amount', { flow: 'cardAdd', amount: '5', unit: 'USD', fc: FC() }, { wallet: CARDS() }));
  /* The card read a moment ago has no room for what is typed: the figure goes red, NEXT goes off, and the line under it names the card's
   * limit and not the phone's. The wallet's answer is the cut a load makes and the check it refuses on (`cardLoadFits`). */
  add('amount, adding to a card that has no room for it', at('amount', { flow: 'cardAdd', amount: '5', unit: 'USD', fc: FC({ room: 3 }) }, {
    wallet: CARDS({ cardLoadFits: () => ({ ok: false, why: 'The card has no room for that. Take some money off it first.', sats: 8192, rounded: 0, room: 3 }) }),
    before: (a) => { a._fcCard = { key: KEY_A, info: {}, pieces: [] }; },
  }));
  add('amount, withdrawing from a card, with all of it under NEXT', at('amount', { flow: 'cardWd', amount: '', unit: 'USD', fc: FC() }, { wallet: CARDS() }));
  add('amount, a card\u2019s limit on one tap, in sats, with NO LIMIT under NEXT', at('amount', { flow: 'cardLimit', amount: '5000', unit: 'SATS', fc: FC() }, { wallet: CARDS() }));
  add('fcLimitConfirm, a limit on one tap, to be confirmed, with no tap said', at('fcLimitConfirm', { fc: FC(), fcLimit: { sats: 5000 } }, { wallet: CARDS() }));
  add('fcLimitConfirm, no limit, to be confirmed', at('fcLimitConfirm', { fc: FC(), fcLimit: { sats: 0 } }, { wallet: CARDS() }));
  add('fcLimitConfirm, a per tap limit, to be confirmed', at('fcLimitConfirm', { fc: FC(), fcLimit: { sats: 2000 } }, { wallet: CARDS(), before: (a) => { a._fcLimitTap = true; } }));
  add('amount, a card\u2019s limit for paying without its PIN, with NO LIMIT under NEXT', at('amount', { flow: 'cardLimit', amount: '10', unit: 'USD', fc: FC({ noPinKnown: true }) }, { wallet: CARDS(), before: (a) => { a._fcLimitNoPin = true; } }));
  // a card's set-up asks its two amounts on the same keypad (26j-card-wheel.js), the max per tap with its seconds under the figure
  add('amount, the set-up\u2019s no PIN amount, nothing typed yet, SKIP under NEXT', at('amount', { flow: 'cardSuNoPin', amount: '', unit: 'USD' }, { before: (a) => { a._fcSu = { unit: '' }; } }));
  add('amount, the set-up\u2019s max per tap, its seconds under the figure, SKIP under NEXT', at('amount', { flow: 'cardSuTap', amount: '10.00', unit: 'USD' }, { before: (a) => { a._fcSu = { unit: '' }; } }));
  add('amount, the set-up\u2019s max per tap on a dollar card', at('amount', { flow: 'cardSuTap', amount: '10.00', unit: 'USD' }, { before: (a) => { a._fcSu = { unit: 'usd' }; } }));
  /* The owner's designs (26j-card-wheel.js): WELCOME TO YOUR CASHU CARD over a new card's screen and as SEND's own screen, MAX SPEND PER
   * SECOND as the set-up and LIMITS ask it, CARD LIMITS with its rows, and a limit confirmed as the rate it makes */
  const NEWCARD = { setUp: false, pinSet: false, hasRecord: false, pin: 'none', owner: false, ownedHere: false, balance: 0, count: 0, mint: '', check: 'none', design: '' };
  add('flashcard, a new card: WELCOME TO YOUR CASHU CARD', at('flashcard', { fc: FC(NEWCARD) }, { wallet: CARDS() }));
  add('flashcard, a set-up cut short: the welcome, saying so', at('flashcard', { fc: FC(Object.assign({}, NEWCARD, { pin: 'set', pinSet: true })) }, { wallet: CARDS() }));
  add('fcWelcome, a new card met by SEND > FLASHCARD', at('fcWelcome', { fcWelcome: { sats: 1500, unit: 'sat', alt: null, info: null }, flow: 'cardSend', amount: '1500', unit: 'SATS' }, { wallet: CARDS() }));
  add('fcName, NAME CARD in the set-up, empty, SKIP under NEXT', at('fcName', { fcNaming: { mode: 'su', key: '' }, fcNameDraft: '' }));
  add('fcName, NAME CARD with a name typed', at('fcName', { fcNaming: { mode: 'su', key: '' }, fcNameDraft: 'Lunch card' }));
  add('fcName, RENAME CARD with the name filled in', at('fcName', { fcNaming: { mode: 'rename', key: '' }, fcNameDraft: 'Lunch card' }));
  add('fcSpeed, MAX SPEND PER SECOND, the set-up at $5, SKIP under NEXT', at('fcSpeed', { fcSpeed: { mode: 'su', unit: 'usd', r: 5 } }));
  add('fcSpeed, MAX SPEND PER SECOND, LIMITS at $25, NO LIMIT under NEXT', at('fcSpeed', { fcSpeed: { mode: 'limit', unit: 'sat', r: 25 }, fc: FC({ tap: { known: true, paced: true, limited: false } }) }, { wallet: CARDS() }));
  const PACED = { unit: 'usd', pinFirst: true, noPinKnown: true, tap: { known: true, paced: true, limited: true, limit: 1500 }, noPin: { known: true, set: true, limit: 10000, left: 10000 } };
  add('fcLimits, CARD LIMITS: $5 per sec, $100 per tap', at('fcLimits', { fc: FC(PACED) }, { wallet: CARDS() }));
  add('fcLimits, CARD LIMITS: none set, a card with no PIN', at('fcLimits', { fc: FC({ pinSet: false, tap: { known: true, paced: true, limited: false } }) }, { wallet: CARDS() }));
  add('fcLimits, CARD LIMITS: a card that refuses past its limit', at('fcLimits', { fc: FC({ tap: { known: true, paced: false, limited: true, limit: 2000 } }) }, { wallet: CARDS() }));
  add('fcLimitConfirm, a per second limit, to be confirmed', at('fcLimitConfirm', { fc: FC(PACED), fcLimit: { sats: 1500 } }, { wallet: CARDS(), before: (a) => { a._fcLimitTap = true; a._fcLimitNoPin = false; } }));
  add('fcLimitConfirm, a per second limit removed', at('fcLimitConfirm', { fc: FC(PACED), fcLimit: { sats: 0 } }, { wallet: CARDS(), before: (a) => { a._fcLimitTap = true; a._fcLimitNoPin = false; } }));
  // paying from a card: the owner's confirmation, the price under the amount and NETWORK FROM ARRIVES FEE two by two
  add('sendConfirm, from a card, an invoice with its fee', at('sendConfirm', { flow: 'send', amount: '', unit: 'SATS', recipient: 'lnbc2100n1stub', recipientKind: 'invoice', quotedFee: 12, quotedAmt: 2100,
    sendFrom: 'card', fc: FC({ balance: 60000 }), stack: ['flashcard'] }, { wallet: CARDS({ amountOf: (inv) => (/^lnbc/.test(String(inv)) ? 2100 : null),
      cardOutTotal: (amount, reserve) => amount + reserve }),
    // (card mode needs the card's screen under the flow: no slide in or out of it, as the on-chain one from a card; the quote is this invoice's)
    before: (a) => { a._fcCard = { key: KEY_A, info: {}, pieces: [] }; a._nav = { screen: 'sendConfirm', len: 1 }; a._quotedFor = 'lnbc2100n1stub'; },
    after: (a) => { a._nav = { screen: 'sendConfirm', len: 0 }; } }));
  add('fcLimitConfirm, a limit for paying without the PIN, to be confirmed', at('fcLimitConfirm', { fc: FC({ noPinKnown: true }), fcLimit: { sats: 5000 } }, { wallet: CARDS(), before: (a) => { a._fcLimitNoPin = true; } }));
  add('fcLimitConfirm, a limit for paying without the PIN, kept in dollars', at('fcLimitConfirm', { fc: FC({ noPinKnown: true }), fcLimit: { sats: 5000, usd: 5 } }, { wallet: CARDS(), before: (a) => { a._fcLimitNoPin = true; } }));
  add('fcLimitConfirm, no limit for paying without the PIN, to be confirmed', at('fcLimitConfirm', { fc: FC({ noPinKnown: true }), fcLimit: { sats: 0 } }, { wallet: CARDS(), before: (a) => { a._fcLimitNoPin = true; } }));
  // a card moved to another mint: the list asking which, and the confirmation as it is asked, answered and refused
  add('switchMint, asking which mint a card moves to', at('switchMint', { fcPick: true, fc: FC() }, { wallet: CARDS() }));
  const MOVE = (over) => Object.assign({ from: MINT, to: OTHER, sats: 2048, plan: null, fee: null, lands: 0, err: '', busy: false }, over || {});
  add('fcMoveConfirm, asking what it costs', at('fcMoveConfirm', { fc: FC(), fcMove: MOVE() }, { wallet: CARDS() }));
  add('fcMoveConfirm, with its cost', at('fcMoveConfirm', { fc: FC(), fcMove: MOVE({ fee: 22, lands: 2026 }) }, { wallet: CARDS() }));
  add('fcMoveConfirm, too little to move', at('fcMoveConfirm', { fc: FC({ balance: 9 }), fcMove: MOVE({ sats: 9, err: 'That is too little to move by Lightning: the fee would take it all.' }) }, { wallet: CARDS() }));
  // a card at another mint paying this phone's invoice from there: the confirmation as its fee is asked, answered, and refused
  const XM = (over) => Object.assign({ xm: true, mint: OTHER, home: MINT, payUnit: 'sat', key: KEY_A, pinSet: false, noPinLeft: 0, balance: 2048,
                                        usdAsk: false, ask: { unit: 'sat', amount: 700 }, bolt11: 'lnbc7u1x', hash: 'h', ends: 0,
                                        quote: null, pay: 0, fee: 0, err: '' }, over || {});
  add('fcXmConfirm, asking the card\u2019s mint what it costs', at('fcXmConfirm', { fcXm: XM() }, { wallet: CARDS() }));
  add('fcXmConfirm, with what the card pays', at('fcXmConfirm', { fcXm: XM({ quote: { quote: { quote: 'q' } }, pay: 710, fee: 10 }) }, { wallet: CARDS() }));
  add('fcXmConfirm, a dollar card, with what it pays', at('fcXmConfirm', { fcXm: XM({ payUnit: 'usd', quote: { quote: { quote: 'q' } }, pay: 541, fee: 2 }) }, { wallet: CARDS() }));
  add('fcXmConfirm, a card that does not hold enough', at('fcXmConfirm', { fcXm: XM({ quote: { quote: { quote: 'q' } }, pay: 710, fee: 10, short: true, balance: 500,
    err: 'The card holds \u20bf500, and this needs \u20bf710 with its fee.' }) }, { wallet: CARDS() }));
  add('fcXmConfirm, the card\u2019s mint would not say', at('fcXmConfirm', { fcXm: XM({ err: 'The card\u2019s mint could not say what this costs: it did not answer.' }) }, { wallet: CARDS() }));
  /* A dollar card asked for sats: the confirmation it comes up on (26f-flashcard.js, `fcOuSpec`), at the mint's rate held for a countdown,
   * as it is asked again, run out and refused, and at this phone's own price with no route. */
  const OU_READ = { card: 'other-unit', unit: 'usd', asked: 'sat', message: 'This card holds dollars here, not bitcoin.', mint: MINT, pinSet: false, noPinLeft: 0 };
  const OU_QUOTE = { amount: 1015, feeReserve: 4, rate: { usdPerBtc: 81924 }, get at() { return Date.now(); },
                     quote: { quote: 'q', get expiry() { return (Date.now() + 75000 + 161500) / 1000; } } };
  const OU = (over) => Object.assign({ e: OU_READ, sats: 12391, offline: false, share: null, asking: false, err: '', lapsed: false, requotes: 0,
    terms: { payUnit: 'usd', pay: 1019, sats: 12391, online: true, bolt11: 'lnbc1', hash: 'h', quote: OU_QUOTE, key: '', read: OU_READ } }, over || {});
  add('fcOuConfirm, a dollar card asked for sats, at the mint\u2019s rate, held', at('fcOuConfirm', { fcOu: OU() }, { wallet: CARDS() }));
  add('fcOuConfirm, a card of both whose bitcoin is short', at('fcOuConfirm', { fcOu: OU({ e: Object.assign({}, OU_READ, { satsToo: 200 }) }) }, { wallet: CARDS() }));
  add('fcOuConfirm, the mint\u2019s rate asked again', at('fcOuConfirm', { fcOu: OU({ asking: true }) }, { wallet: CARDS() }));
  add('fcOuConfirm, the mint\u2019s rate ran out', at('fcOuConfirm', { fcOu: OU({ lapsed: true }) }, { wallet: CARDS() }));
  add('fcOuConfirm, the mint would not say', at('fcOuConfirm', { fcOu: OU({ err: 'The mint could not say what this invoice costs in dollars just now. Nothing was taken.' }) },
    { wallet: CARDS() }));
  add('fcOuConfirm, a dollar card asked for sats, at this phone\u2019s price', at('fcOuConfirm', { fcOu: OU({ offline: true,
    terms: { payUnit: 'usd', pay: 592, sats: 7000, rate: 84571, ageMs: 2 * 3600 * 1000, seenAt: 1, own: true, convert: true } }) }, { wallet: CARDS() }));
  // money from this phone onto a card at another mint: the confirmation as both mints are asked, answered, short, and silent
  const XL = (over) => Object.assign({ from: 'send', mint: OTHER, home: MINT, key: KEY_A, cardUnit: 'sat', payUnit: 'sat', amount: 1000, pinSet: true, pin: '',
                                        plan: null, err: '', short: false, busy: false }, over || {});
  const XLPLAN = (over) => Object.assign({ amount: 1000, land: 1000, issue: 1000, total: 1010, worth: 1000, fee: 10, short: false, why: '', at: Date.now(),
                                            melt: { quote: { quote: 'm' } }, mintQuote: { quote: 'q' } }, over || {});
  add('fcXlConfirm, asking both mints what it costs', at('fcXlConfirm', { fcXl: XL() }, { wallet: CARDS() }));
  add('fcXlConfirm, with what it costs', at('fcXlConfirm', { fcXl: XL({ plan: XLPLAN() }) }, { wallet: CARDS() }));
  add('fcXlConfirm, a dollar card, from bitcoin', at('fcXlConfirm', { fcXl: XL({ cardUnit: 'usd', amount: 500, plan: XLPLAN({ amount: 500, land: 500, issue: 500, total: 6513, worth: 6503, fee: 10 }) }) }, { wallet: CARDS() }));
  add('fcXlConfirm, this phone short of the fee', at('fcXlConfirm', { fcXl: XL({ short: true, err: 'Your balance isn\u2019t enough to cover the payment and its fee: this needs 1010 sats and you hold 1005.',
    plan: XLPLAN({ short: true }) }) }, { wallet: CARDS() }));
  add('fcXlConfirm, a mint would not say', at('fcXlConfirm', { fcXl: XL({ err: 'Foxy could not find out what this costs: n.test did not answer.' }) }, { wallet: CARDS() }));
  add('amount, money for a card from the send screen', at('amount', { flow: 'cardSend', amount: '5', unit: 'USD' }, { wallet: CARDS() }));
  add('flashcard, nothing tapped', at('flashcard', {}, { wallet: CARDS() }));
  // every card can be taken back (FC_RECOVERABLE): the list of cards this phone loaded is drawn, with the money waiting
  add('flashcard, cards loaded and money waiting for one', at('flashcard', {}, { wallet: CARDS({
    cardOwed: () => [{ id: 'o1', card: KEY_A, sats: 1000, kind: 'load' }, { id: 'o2', card: KEY_A, sats: 24, kind: 'change' }],
    cardsList: () => [
      { key: KEY_A, mint: MINT, sats: 2048, date: 4102444800, due: false, takenBack: 0 },
      { key: KEY_B, mint: MINT, sats: 1024, date: 1700000000, due: true, takenBack: 0 },
      { key: KEY_C, mint: MINT, sats: 512, date: 1700000000, due: true, takenBack: 1700000500000 },
    ] }) }));
  add('flashcard, a card of this phone\u2019s, with no limit', at('flashcard', { fc: FC() }, { wallet: CARDS() }));
  add('flashcard, a card with a daily limit, which it says nothing about', at('flashcard', { fc: FC({ limit: 5000, day: DAY }) }, { wallet: CARDS() }));
  // the limit on one tap: alone, and beside the daily limit
  const TAP = { known: true, limited: true, limit: 2000, spent: 0, left: 2000, turns: 0, noTime: false };
  add('flashcard, a card with a limit on one tap', at('flashcard', { fc: FC({ tap: TAP }) }, { wallet: CARDS() }));
  add('flashcard, a card with a limit on one tap and a daily limit: the one on one tap alone', at('flashcard', { fc: FC({ limit: 5000, day: DAY, tap: TAP }) }, { wallet: CARDS() }));
  /* The limit line is on the card's own face, at its bottom left (the card's badge above it where it has one), in either design; and the balance
   * on the card's screen counts to what the card holds after money goes on or off it. */
  add('flashcard, a locked card with a daily limit: its badge on the face, and nothing of the limit', at('flashcard', { fc: FC({ locked: true, limit: 5000, day: DAY }) }, { wallet: CARDS() }));
  add('flashcard, a card of the Foxy design with a limit on one tap on its face, and a daily one not said', at('flashcard', { fc: FC({ design: 'FX1', limit: 5000, day: DAY, tap: TAP }) }, { wallet: CARDS() }));
  add('flashcard, the balance counting up after money went on', at('flashcard', { fc: FC({ balance: 2000 }), fcRoll: { key: KEY_A, from: 0 }, fcRollT: 0.5 }, { wallet: CARDS() }));
  // the card's own log: its last tap in a line under the balance, and a tap the card has marked
  const LOG = { taps: 41, sats: 213400, refused: 0, tampers: 0, since: { taps: 2, sats: 15360, refused: 0, tampers: 0, at: 0 },
                last: [{ time: 4102358400, sats: 12288, pieces: 2, refused: 0, tamper: false }, { time: 4102354800, sats: 3072, pieces: 2, refused: 0, tamper: false }] };
  const LOG_MARKED = { taps: 42, sats: 213400, refused: 5, tampers: 1, since: { taps: 1, sats: 0, refused: 5, tampers: 1, at: 0 },
                       last: [{ time: 4102358460, sats: 0, pieces: 0, refused: 5, tamper: true }].concat(LOG.last) };
  add('flashcard, a card with its own log', at('flashcard', { fc: FC({ tap: TAP, log: LOG }) }, { wallet: CARDS() }));
  add('flashcard, a card whose log has a tap marked as a tamper', at('flashcard', { fc: FC({ tap: TAP, log: LOG_MARKED }) }, { wallet: CARDS() }));
  /* A card of software 1.15: its clock is Bitcoin block headers. One line under the limits says the block it reads its time from (the
   * eight digits after its zeros, and the time in it), or that it has been shown none; with a daily limit and no block yet its day has
   * no start, and the line under what is left says when it will. */
  const CLOCK = { hash: '00000000000000000001fa7ca83e1eb90d5a1865d8db9684f3f03ca64ccaec8a', short: '1fa7ca83', time: 4102358400 };
  const NO_CLOCK = { hash: '', short: '', time: 0 };
  const DAY_ON_TRUST = { limited: true, limit: 5000, spent: 800, left: 4200, turns: 0, now: 0, noTime: false, onTrust: true };
  add('flashcard, a card of software 1.15, the block its clock reads', at('flashcard', { fc: FC({ headers: true, clock: CLOCK }) }, { wallet: CARDS() }));
  add('flashcard, a card of software 1.15 with a limit on one tap and a daily one not said, the block its clock reads under them', at('flashcard', { fc: FC({ headers: true, clock: CLOCK, limit: 5000, day: DAY, tap: TAP }) }, { wallet: CARDS() }));
  add('flashcard, a card of software 1.15 that has been shown no block', at('flashcard', { fc: FC({ headers: true, clock: NO_CLOCK }) }, { wallet: CARDS() }));
  add('flashcard, a card of software 1.15 with a daily limit and no block yet: nothing said of its day', at('flashcard', { fc: FC({ headers: true, clock: NO_CLOCK, limit: 5000, day: DAY_ON_TRUST }) }, { wallet: CARDS() }));
  /* Software 1.17: RESET in the row under the card for the owner, the row drawn as the receive screen's (HISTORY is the round button at the top left), and under the title
   * the time the mint's word was had and the block the card's clock is at (its height where this phone has it, else its hash, else none). */
  const R17 = { resetKnown: true, headers: true, clock: CLOCK };
  add('flashcard, a card of software 1.17, with RESET CARD, its row and its block by height', at('flashcard', { fc: FC(R17) }, { wallet: CARDS({ headerHeightOf: () => 970809 }) }));
  add('flashcard, a card of software 1.17, its block by its hash', at('flashcard', { fc: FC(R17) }, { wallet: CARDS() }));
  add('flashcard, a card of software 1.17 shown no block', at('flashcard', { fc: FC({ resetKnown: true, headers: true, clock: NO_CLOCK }) }, { wallet: CARDS() }));
  add('flashcard, a card of software 1.17 on another phone: no RESET CARD', at('flashcard', { fc: FC({ resetKnown: true, headers: true, clock: CLOCK, ownedHere: false }) }, { wallet: CARDS() }));
  add('flashcard, a locked card of software 1.17: RESET CARD is there', at('flashcard', { fc: FC({ resetKnown: true, headers: true, clock: CLOCK, ownedHere: false, locked: true }) }, { wallet: CARDS() }));
  add('flashcard, a card with no PIN, its limit line says so', at('flashcard', { fc: FC({ resetKnown: true, headers: true, clock: CLOCK, pin: 'none', pinSet: false, noPinKnown: true,
    limit: 5000, day: DAY, noPin: { known: true, set: false, limit: 0, spent: 0, left: 0, turns: 0, now: 0 } }) }, { wallet: CARDS() }));
  add('flashcard, a card of the beaker design EL1 with no PIN, its lines on the face', at('flashcard', { fc: FC({ design: 'EL1',  resetKnown: true, headers: true, clock: CLOCK, pin: 'none', pinSet: false, noPinKnown: true,
    limit: 5000, day: DAY, noPin: { known: true, set: false, limit: 0, spent: 0, left: 0, turns: 0, now: 0 } }) }, { wallet: CARDS() }));
  add('flashcard, a card of 1.17 that names its design FL1, not yet set up', at('flashcard', { fc: FC({ resetKnown: true, design: 'FL1', balance: 0, count: 0, room: 64, pin: 'none', hasRecord: false, setUp: false, pinSet: false, mint: '', recoverable: false, mine: false, first: 0, last: 0, check: 'none' }) }, { wallet: CARDS() }));
  // the change this card made for itself (software 1.12) that no till has handed back, as its owner's read left it: a line for each state it is in
  const OWES = (parts) => ({ sats: parts.reduce((n, p) => n + p.sats, 0), parts });
  add('flashcard, change a till never handed over, fetched and put on', at('flashcard', { fc: FC({ owes: OWES([{ state: 'put', sats: 280, count: 3 }]) }) }, { wallet: CARDS() }));
  add('flashcard, change the till has not made yet', at('flashcard', { fc: FC({ owes: OWES([{ state: 'unmade', sats: 280, count: 3 }]) }) }, { wallet: CARDS() }));
  add('flashcard, change owed in two states, under the limits', at('flashcard', { fc: FC({ limit: 5000, day: DAY, tap: TAP, owes: OWES([{ state: 'put', sats: 280, count: 3 }, { state: 'unmade', sats: 112, count: 2 }]) }) }, { wallet: CARDS() }));
  // a card whose software reported two units, which no card's does yet: SWAP joins RESET, CHANGE PIN and LIMITS
  add('flashcard, a card holding two balances, with SWAP', at('flashcard', { fc: FC(Object.assign({ units: ['sat', 'usd'] }, R17)) }, { wallet: CARDS() }));
  // a card at another mint than this phone's: headed by the card's own mint
  add('flashcard, a card at another mint than this phone\u2019s', at('flashcard', { fc: FC({ mint: 'https://forge.example/Bitcoin' }) }, { wallet: CARDS() }));
  add('flashcard, a new card', at('flashcard', { fc: FC({ balance: 0, count: 0, room: 64, pin: 'none', hasRecord: false, setUp: false, pinSet: false, mint: '', recoverable: false, mine: false, first: 0, last: 0, check: 'none' }) }, { wallet: CARDS() }));
  /* Software 1.16: a card with no PIN has ADD PIN where a card with one has CHANGE PIN; a card with a PIN may have a limit for paying without
   * it, on the card's face as the one limit there is, and under it with what is left of it today, beside the other limits. */
  const NOPIN = { known: true, set: true, limit: 1000, spent: 300, left: 700, turns: 4102444800, now: 4102358400 };
  add('flashcard, a card with no PIN, with ADD PIN', at('flashcard', { fc: FC({ pin: 'none', pinSet: false, noPinKnown: true, noPin: { known: true, set: false, limit: 0, spent: 0, left: 0, turns: 0, now: 0 } }) }, { wallet: CARDS() }));
  add('flashcard, a card with a PIN and a limit for paying without it', at('flashcard', { fc: FC({ noPinKnown: true, noPin: NOPIN }) }, { wallet: CARDS() }));
  add('flashcard, a card with a PIN and a limit for paying without it, beside the limit on one tap (and a daily limit, not said)',
    at('flashcard', { fc: FC({ noPinKnown: true, noPin: NOPIN, limit: 5000, day: DAY, tap: TAP }) }, { wallet: CARDS() }));
  add('flashcard, a card with a PIN and no limit for paying without it', at('flashcard', { fc: FC({ noPinKnown: true, noPin: Object.assign({}, NOPIN, { set: false, limit: 0, spent: 0, left: 0, turns: 0 }) }) }, { wallet: CARDS() }));
  add('flashcard, a blocked card, on its owner\u2019s phone, with UNBLOCK', at('flashcard', { fc: FC({ pin: 'blocked' }) }, { wallet: CARDS() }));
  add('flashcard, a blocked card, on another phone', at('flashcard', { fc: FC({ pin: 'blocked', ownedHere: false, owner: true }) }, { wallet: CARDS() }));
  /* Software 1.21 and 1.22: the owner's card (no RESTORE in its menu: that is home's); and the card of a holder with no phone, read on any
   * Foxy, with its balance and VIEW AS
   * GUEST and TIE OWNERSHIP TO THIS PHONE, and the same card after a guest's view (its log, and its limit on one tap read under the PIN). */
  add('flashcard, a card of software 1.21 of this phone\u2019s', at('flashcard', { fc: FC({ pinFirst: true, resetKnown: true, noPinKnown: true, noPin: NOPIN }) }, { wallet: CARDS() }));
  const GUEST = { owner: false, ownedHere: false, mine: false, recoverable: false, guests: true, pinFirst: true, noPinKnown: true, noPin: NOPIN, first: 0, last: 0 };
  add('flashcard, a holder\u2019s card with no owner, with VIEW AS GUEST and TIE OWNERSHIP TO THIS PHONE', at('flashcard', { fc: FC(GUEST) }, { wallet: CARDS() }));
  add('flashcard, a holder\u2019s card after a guest\u2019s view', at('flashcard', { fc: FC(Object.assign({}, GUEST, { guestRead: true, tap: { known: true, limited: true, limit: 2000, spent: 0, left: null, turns: 0, noTime: false, paced: true } })) }, { wallet: CARDS() }));
  add('flashcard, a new card: welcome, SET UP CARD and CANCEL', at('flashcard', { fc: FC({ setUp: false, hasRecord: false, pin: 'none', pinSet: false, owner: false, ownedHere: false, balance: 0, count: 0, pinFirst: true, guests: true }) }, { wallet: CARDS() }));
  add('flashcard, a cash card the mint says is spent', at('flashcard', { fc: FC({ recoverable: false, mine: false, first: 0, last: 0, check: { spent: 1024 } }) }, { wallet: CARDS() }));
  add('flashcard, somebody else\u2019s card, past its date, no connection', at('flashcard', { fc: FC({ mine: false, first: 1700000000, last: 1700000000, check: 'off', locked: true }) }, { wallet: CARDS() }));
  add('home, working offline', at('home', { series: SERIES, range: '1D' }, { wallet: OFFLINE }));
  add('home, a secure connection', at('home', { series: SERIES, range: '1D' }, { wallet: ONLINE }));
  /* A phone that opens with no route, and draws the line it kept the last time it had one: a day of rows through the real chart
   * code, marked as kept, with the rider's panel, the offline banner and a price that says how old it is. The stand-in wallet is
   * given the price three hours old, which is what puts that age under the figure. */
  const KEPT_ROWS = Array.from({ length: 288 }, (_, i) => ({ t: 1700000000 + i * 300, c: Math.round(80000 + 900 * Math.sin(i / 20) + i * 5) }));
  const KEPT_LINE = Object.assign(logic.buildChart(KEPT_ROWS, 'last 24 hours'), { kept: true, at: 1700086400000 });
  add('home, working offline, a kept line and a stale price', at('home', { series: { '1D': KEPT_LINE }, range: '1D' },
    { wallet: Object.assign({}, OFFLINE, { _rate: 64000, _rateAt: Date.now() - 3 * 3600 * 1000 }) }));
  add('sendhow, working offline', at('sendHow', { flow: 'send' }, { wallet: OFFLINE }));
  add('sendhow, with a connection', at('sendHow', { flow: 'send' }, { wallet: ONLINE }));
  /* The mint list with no route: only the mints whose keysets this phone already
   * has can be connected to, so the rest are greyed and say why. The one screen
   * that could not be used offline at all before this. */
  add('switchMint, working offline, one mint on file', at('switchMint', {},
    { wallet: Object.assign({}, OFFLINE, { mintCached: (u) => String(u).indexOf('minibits') >= 0 }) }));
  /* The receive screen with no route: CASHU is the only rail there is, the
   * network pill cannot be tapped, and the price says how old it is. */
  add('confirm, working offline, cashu only', at('confirm',
    { flow: 'receive', amount: '2100', unit: 'SATS', asset: 'BITCOIN', network: 'LIGHTNING',
      recvRail: 'CASHU', invoice: 'lnbc2100n1stub' }, { wallet: OFFLINE }));
  /* And holding past half of what it takes before it settles, then at all of it (26j-till-caps.js): the notice under the
   * code, in amber, the second one firm. */
  add('confirm, working offline, holding half the cap', at('confirm',
    { flow: 'receive', amount: '2100', unit: 'SATS', asset: 'BITCOIN', network: 'LIGHTNING',
      recvRail: 'CASHU', invoice: 'lnbc2100n1stub' },
    { wallet: Object.assign({}, OFFLINE, { tillNotice: () => ({ level: 'prompt', heldSats: 211000, heldCents: 16240 }) }) }));
  add('confirm, working offline, holding all the cap', at('confirm',
    { flow: 'receive', amount: '2100', unit: 'SATS', asset: 'BITCOIN', network: 'LIGHTNING',
      recvRail: 'CASHU', invoice: 'lnbc2100n1stub' },
    { wallet: Object.assign({}, OFFLINE, { tillNotice: () => ({ level: 'full', heldSats: 390000, heldCents: 30010 }) }) }));
  add('sendtype, working offline', at('sendType', { flow: 'send' }, { wallet: OFFLINE }));
  /* The two decisions that used to be cards. Both are a person weighing
   * figures, which is what the confirmation shell is for, and the crossing one
   * IS the confirmation — its button is the last thing there is to press. */
  add('priceconfirm, their bitcoin price', at('priceConfirm',
    { priceQ: { sats: 2876, usd: 242, theirRate: 84123, differsPct: 0.6,
                myRateAgeMs: 2 * 3600 * 1000 } },
    { wallet: Object.assign({}, OFFLINE, { _rate: 83621, _rateAt: Date.now() - 2 * 3600 * 1000 }) }));
  add('crossconfirm, they use another mint', at('crossConfirm',
    { crossQ: { net: 60, fee: 10, them: 'Minibits', mine: 'Macadamia' } }));
  /* Asking to be paid with no route is in dollars and only in dollars: this
   * phone's price may be hours old, so it names the amount and leaves the
   * conversion to the phone that has a current one. No sat line under the
   * figure, no swap control beside it, and the age said plainly. */
  add('amount, receive in dollars, working offline', at('amount',
    { flow: 'receive', amount: '25', unit: 'USD' },
    { wallet: Object.assign({}, OFFLINE, { _rate: 84746, _rateAt: Date.now() - 2 * 3600 * 1000 }) }));
  /* The same screen reached in sats: the keypad is put into dollars and the
   * figure is converted, not relabelled — 25,000 sats is $16.00, and calling
   * it $25,000 would be eighty thousand times the money. */
  add('amount, receive in sats, working offline', at('amount',
    { flow: 'receive', amount: '25000', unit: 'SATS' }, { wallet: OFFLINE }));
  add('home, the Tor warning', at('home', {}, {
    before: (a, w) => { w.FoxyGate = { warning: () => ({ text: 'Reconnecting to Tor', colour: '#8C1D1D' }), rearm() {} }; },
    after: (a, w) => { delete w.FoxyGate; },
  }));
  add('home, light theme, orange accent', at('home', { theme: 'light', accent: 'orange' }));
  add('home, with the keyboard up', at('home', { kbInset: 300 }));
  add('home, a toast', at('home', { toastMsg: 'Invoice Copied' }));
  add('home, an amber toast', at('home', { toastMsg: 'Could not copy', toastAmber: true }));
  // amount
  add('amount, receive, dollars', at('amount', { flow: 'receive', amount: '25', unit: 'USD' }));
  add('amount, receive, empty', at('amount', { flow: 'receive', amount: '', unit: 'USD' }));
  add('amount, send, sats', at('amount', { flow: 'send', amount: '1500', unit: 'SATS', recipient: 'bob@example.com', recipientKind: 'email' }));
  add('amount, send, more than the balance', at('amount', { flow: 'send', amount: '999999', unit: 'USD', payFrom: 'BITCOIN' }));
  add('amount, send, an invoice', at('amount', { flow: 'send', amount: '', unit: 'USD', recipient: 'lnbc2100n1stub', recipientKind: 'invoice' }));
  add('amount, make an ecash token', at('amount', { flow: 'send', tokenMode: true, amount: '100', unit: 'SATS', recipient: '', makeBusy: true }));
  for (const flow of ['deposit', 'cardAdd', 'cardWd', 'withdraw']) add('amount, ' + flow, at('amount', { flow, amount: '3', unit: 'USD' }));
  add('amount, no price', at('amount', { flow: 'receive', amount: '25', unit: 'USD', livePrice: null }));
  add('amount, satUsd set', at('amount', { flow: 'receive', amount: '2500', unit: 'SATS', satUsd: 0.0007 }));
  // receive
  add('confirm, an invoice and a note', at('confirm', { flow: 'receive', invoice: 'lnbc2100n1stub', amount: '2100', unit: 'SATS', asset: 'BITCOIN', network: 'LIGHTNING', note: 'pizza' }));
  add('confirm, a payer tapped, the code up', at('confirm', { flow: 'receive', invoice: 'lnbc2100n1stub', amount: '2100', unit: 'SATS', asset: 'BITCOIN', network: 'LIGHTNING', tapShownCode: '4821' }));
  // TAP pressed and nobody there yet: the orange card over the code
  add('confirm, on the air, tap here', at('confirm', { flow: 'receive', invoice: 'lnbc2100n1stub', amount: '2100', unit: 'SATS', asset: 'BITCOIN', network: 'LIGHTNING', tapArmed: true }));
  add('confirm, on the air, a payer connecting', at('confirm', { flow: 'receive', invoice: 'lnbc2100n1stub', amount: '2100', unit: 'SATS', asset: 'BITCOIN', network: 'LIGHTNING', tapArmed: true, tapRecvStage: 'connecting' }));
  add('confirm, paid by Cashu', at('confirm', { flow: 'receive', invoice: 'lnbc2100n1stub', amount: '2100', unit: 'SATS', asset: 'BITCOIN', network: 'LIGHTNING', recvRail: 'CASHU' }));
  add('confirm, any amount, no invoice yet', at('confirm', { flow: 'receive', amount: '', unit: 'USD' }));
  add('confirm, dollars', at('confirm', { flow: 'receive', invoice: 'lnbc2100n1stub', amount: '1.34', unit: 'USD', asset: 'DOLLARS' }));
  add('confirm, no wallet', { state: { screen: 'confirm', stack: [], invoice: 'lnbc2100n1stub', amount: '21', unit: 'SATS' } });
  add('paid, received, live', at('paid', { amount: '2100', unit: 'SATS', asset: 'BITCOIN', recv: { live: 'in' }, recvResolved: true }));
  add('paid, received, cash', at('paid', { amount: '2100', unit: 'SATS', asset: 'DOLLARS', recv: { live: 'gone' } }));
  add('paid, sent with a fee', at('paid', { amount: '2100', unit: 'SATS', payOut: true, recipient: 'lnbc2100n1stub', recipientKind: 'invoice', flow: 'send', recv: { live: 'out' } }, {
    before: (a) => { a._lastFee = 12; },
  }));
  add('paid, sent to an address', at('paid', { amount: '500', unit: 'SATS', payOut: true, paidTo: 'alice@example.com', recv: { live: 'in' } }));
  // send
  add('sendHow, camera on', at('sendHow', { flow: 'send', camOk: true }));
  add('sendType, an address being typed', at('sendType', { flow: 'send', emailDraft: 'someone@' }));
  add('sendType, a valid address, keyboard up', at('sendType', { flow: 'send', emailDraft: 'someone@example.com', kbInset: 320 }));
  add('sendScan, camera on', at('sendScan', { flow: 'send', camOk: true }));
  add('sendDone, sending', at('sendDone', { flow: 'send', sendPhase: 'in', amount: '2100', unit: 'SATS', recipient: 'alice@example.com', recipientKind: 'email' }));
  add('sendDone, on-chain', at('sendDone', { flow: 'send', sendPhase: 'onchain', etaLeft: 421, amount: '2100', unit: 'SATS', recipient: 'bc1qexampleaddressxyz', recipientKind: 'address' }));
  add('sendDone, done with a fee', at('sendDone', { flow: 'send', sendPhase: 'done', amount: '2100', unit: 'SATS', recipient: 'lnbc2100n1stub', recipientKind: 'invoice' }, {
    before: (a) => { a._lastFee = 7; },
  }));
  add('sendDone, settled, leaving', at('sendDone', { flow: 'send', sendPhase: 'settled', sendExit: true, amount: '50', unit: 'USD' }));
  add('sendDone, receive pending', at('sendDone', { recvPending: true, sendPhase: 'in', amount: '100', unit: 'SATS' }));
  add('tokenOut, a token with a fee', at('tokenOut', { tokenOut: 'cashuBtoken', tokenOutSats: 2100, tokenOutFee: 2, tokenCopied: true }));
  add('tokenOut, from the last token', at('tokenOut', {}));
  add('tokenOut, paying someone at this mint', at('tokenOut', { tokenOut: 'cashuBtoken', tokenOutSats: 2100, tokenForPayee: true }));
  add('reqOffer, a payment request', at('reqOffer', { req: { sats: 500, mints: ['https://mint.example.com'], transports: ['nostr', 'post'] } }));
  add('reqOffer, in person (no transport)', at('reqOffer', { req: { sats: 100, mints: ['https://mint.minibits.cash/Bitcoin'], transports: [] } }));
  add('reqOffer, busy, no details', at('reqOffer', { req: { sats: 0, mints: [], transports: [] }, reqBusy: true }));
  // confirmation shells
  add('sendConfirm, lightning address, a quoted fee, a note', at('sendConfirm', { flow: 'send', amount: '20', unit: 'USD', recipient: 'alice@example.com', recipientKind: 'email', payFrom: 'BITCOIN', quotedFee: 12, note: 'rent' }));
  add('sendConfirm, an invoice, quoting', at('sendConfirm', { flow: 'send', amount: '', unit: 'SATS', recipient: 'lnbc2100n1stub', recipientKind: 'invoice', quotingFee: true }));
  /* The confirmation held (CHECKING, with the FEE row saying the same) for a
   * connection that is on its way: working offline while Tor is at work, which
   * is where Foxy opens and where it comes back from the background. The wallet
   * stand-in says so the way the real one does, in `routeComing` and in the
   * privacy record the home banner is drawn from. */
  const COMING = Object.assign({}, OFFLINE, { routeComing: () => true, lookupLnurl: () => new Promise(() => {}),
    privacy: () => ({ tor: 'connecting', progress: 40, everUp: true, unprotected: false, offline: true, network: 'wifi',
                      orbot: 'none', vpn: false, orbotKey: false }) });
  add('sendConfirm, an invoice, the connection on its way', at('sendConfirm',
    { flow: 'send', amount: '2100', unit: 'SATS', recipient: 'lnbc2100n1stub', recipientKind: 'invoice', payFrom: 'BITCOIN' }, { wallet: COMING }));
  add('sendConfirm, a lightning address, the connection on its way', at('sendConfirm',
    { flow: 'send', amount: '2100', unit: 'SATS', recipient: 'alice@example.com', recipientKind: 'email', payFrom: 'BITCOIN' }, { wallet: COMING }));
  add('reqOffer, a payment request, the connection on its way', at('reqOffer',
    { req: { sats: 500, mints: ['https://mint.example.com'], transports: ['nostr', 'post'], delivery: { kind: 'nostr', target: 'npub1stub' } } }, { wallet: COMING }));
  add('sendConfirm, a lightning address, quoted, SEND with its fee', at('sendConfirm',
    { flow: 'send', amount: '2100', unit: 'SATS', recipient: 'alice@example.com', recipientKind: 'email', payFrom: 'BITCOIN',
      balSats: 250000, quotedFee: 12, quotedAmt: 2100 },
    { wallet: { lookupLnurl: () => new Promise(() => {}), payNeed: () => ({ ok: true, need: 2112, have: 250000, fee: 12, why: '' }) },
      before: (a) => { a._quotedFor = 'alice@example.com|2100'; } }));
  // a payout on chain, its quote in and the balance covering it: SEND, with the speed it was quoted at
  const OC_PLAN = (more) => ({ id: 'oc-melt-1', address: 'bc1qexampleaddressxyz0123456789abcdef', sats: 50000, expiry: null,
    options: [{ index: 0, fee: 500, blocks: 1 }].concat(more || []) });
  const OC = { ocSats: 50000, ocTo: 'bc1qexampleaddressxyz0123456789abcdef', ocFee: 0, ocErr: '', balSats: 250000 };
  add('ocConfirm, a quote that fits', at('ocConfirm', Object.assign({ ocPlan: OC_PLAN() }, OC),
    { wallet: { onchainNeed: () => ({ ok: true, need: 50500, have: 250000, fee: 500, why: '' }) } }));
  add('depConfirm, by card', at('depConfirm', { flow: 'deposit', amount: '10', unit: 'USD', depositVia: 'DEBIT / CREDIT CARD' }));
  /* The quote in, the balance not covering the payment and its fee: the
   * button reads NOT ENOUGH and does nothing, with the wallet's sentence under
   * the rows. The invoice fits the balance; its fee reserve and the mint's own
   * fee do not. After the others, and before a screen of another kind: the
   * button is the orange of a refusal, and a confirmation after it in the same
   * run would be drawn on the button this one leaves behind (a style set again
   * as a shorthand clears the shine set beside it), not as it is drawn fresh. */
  add('sendConfirm, a quote the balance cannot cover', at('sendConfirm',
    { flow: 'send', amount: '2100', unit: 'SATS', recipient: 'lnbc2100n1stub', recipientKind: 'invoice', payFrom: 'BITCOIN',
      balSats: 2105, quotedFee: 12, quotedAmt: 2100 },
    { wallet: { payNeed: () => ({ ok: false, need: 2113, have: 2105, fee: 13,
        why: 'Your balance isn\'t enough to cover the payment and its fee: this needs 2113 sats and you hold 2105.' }) },
      before: (a) => { a._quotedFor = 'lnbc2100n1stub'; } }));
  /* The same on chain, and for a payment request: the quote or the request judged by the wallet's own sum, the button held at NOT
   * ENOUGH with its sentence, and (on chain, where the mint offers a slower speed that costs less) CHANGE THE SPEED to choose it. */
  add('ocConfirm, a quote the balance cannot cover', at('ocConfirm', Object.assign({ ocPlan: OC_PLAN() }, OC, { balSats: 50504 }),
    { wallet: { onchainNeed: () => ({ ok: false, need: 50505, have: 50504, fee: 505,
        why: 'Your balance isn\'t enough to cover the payment and its fee: this needs 50505 sats and you hold 50504.' }) } }));
  add('ocConfirm, a quote the balance cannot cover, with a slower speed to choose', at('ocConfirm',
    Object.assign({ ocPlan: OC_PLAN([{ index: 2, fee: 100, blocks: 6 }]) }, OC, { balSats: 50200 }),
    { wallet: { onchainNeed: () => ({ ok: false, need: 50500, have: 50200, fee: 500,
        why: 'Your balance isn\'t enough to cover the payment and its fee: this needs 50500 sats and you hold 50200.' }) } }));
  add('reqOffer, a payment request the balance cannot cover with the mint\'s fee', at('reqOffer',
    { req: { id: 'req-short', sats: 500, mints: ['https://mint.minibits.cash/Bitcoin'], transports: [], viaTap: true }, tapCode: '4821', balSats: 505 },
    { wallet: { sendShortfall: () => ({ need: 511, fee: 11, have: 505, short: true,
        why: 'Your balance isn\'t enough to cover the payment and its fee: this needs 511 sats and you hold 505.' }) } }));
  for (const kind of ['sendFail', 'mintRefused', 'netLost', 'lnNoRoute', 'badAddress']) {
    add('blocked screen ' + kind, at(kind, { flow: 'send', amount: '20', unit: 'USD' }));
  }
  // history and detail
  add('history, every kind of entry', at('history', { history: [{ label: 'TODAY', items: [TX_IN, TX_OUT] }, { label: 'EARLIER', items: [TX_USD, TX_CASH, TX_SPLIT] }] }));
  add('history, done, pending and failed', at('history', { history: [{ label: 'EARLIER', items: [TX_IN, TX_SENT, TX_OUT, TX_FAILED] }] }));
  add('history, a sent token not yet redeemed', at('history', { history: [{ label: 'TODAY', items: [Object.assign({}, TX_SENT, { pending: true })] }] }));
  /* Taken on trust while both phones were offline: the one pending row in Foxy
   * that somebody else can still take away, so it does not look like the rest. */
  add('history, a payment at risk beside an ordinary pending one', at('history', {
    history: [{ label: 'TODAY', items: [TX_AT_RISK, Object.assign({}, TX_OUT, { pending: true })] }] },
    { wallet: Object.assign({}, OFFLINE, { trustedWaiting: () => [{ id: 'r1', sats: 4900, at: 1 }] }) }));
  add('txDetail, a payment at risk', at('txDetail', { tx: TX_AT_RISK }));
  // a card's payment taken offline: in the list, its detail, and the amber ring on home while it waits
  add('history, a card payment taken offline, waiting for the mint', at('history', {
    history: [{ label: 'TODAY', items: [TX_CARD_KEPT, TX_IN] }] }, { wallet: { cardKeptWaiting: () => [{ id: 'card-kept', sats: 592, date: 4102444800, state: 'kept', at: 1 }] } }));
  add('txDetail, a card payment taken offline, waiting for the mint', at('txDetail', { tx: TX_CARD_KEPT }));
  add('txDetail, a card payment taken offline that did not settle', at('txDetail', { tx: Object.assign({}, TX_CARD_KEPT,
    { cardWaits: false, cardKept: 'retired', failed: true, memo: 'card, offline \u2014 not settled' }) }));
  add('home, a card payment waiting for the mint: the ring amber', at('home', { series: SERIES, range: '1D' },
    { wallet: Object.assign({}, OFFLINE, { cardKeptWaiting: () => [{ id: 'card-kept', sats: 592, date: 4102444800, state: 'kept', at: 1 }] }) }));
  /* An over-payment and its change are one transaction: the list shows the net,
   * and this is where the arithmetic is kept. */
  add('txDetail, paid with change back', at('txDetail', { tx: {
    name: 'Paid in person', dir: 'out', time: '14:39', sats: 2, fee: 0, rail: 'CASHU',
    hash: 'request-chg', grossSats: 4, changeSats: 2, changeState: 'came back' } }));
  add('txDetail, received with change given', at('txDetail', { tx: {
    name: 'Paid in person', dir: 'in', time: '14:39', sats: 2, fee: 0, rail: 'CASHU',
    hash: 'req-chg', grossSats: 4, changeSats: 2, changeState: '' } }));
  add('txDetail, the change never came', at('txDetail', { tx: {
    name: 'Paid in person', dir: 'out', time: '14:39', sats: 4, fee: 0, rail: 'CASHU',
    hash: 'request-chg2', grossSats: 4, changeSats: 2, changeState: 'never came' } }));
  add('home, a payment at risk is still out there', at('home', { series: SERIES, range: '1D' },
    { wallet: Object.assign({}, OFFLINE, { trustedWaiting: () => [{ id: 'r1', sats: 4900, at: 1 }] }) }));
  add('history, outgoing only', at('history', { histFilter: 'out', history: [{ label: 'TODAY', items: [TX_IN, TX_OUT] }] }));
  add('history, incoming, none match', at('history', { histFilter: 'in', history: [{ label: 'TODAY', items: [TX_OUT] }] }));
  add('history, a fresh wallet', at('history', { fresh: true }));
  add('txDetail, received, a note, a token, an audit record', at('txDetail', { tx: TX_IN, txAuditCopied: true, txTokenCopied: true }));
  add('txDetail, sent, pending, a fee', at('txDetail', { tx: TX_OUT, txReclaiming: true }));
  /* What can be shown to somebody else about a payment: the preimage of a
   * Lightning send, the payment hash of a Lightning receive, and for ecash
   * locked to the phone that asked, the signature it was spent with. */
  add('txDetail, a Lightning send with its proof of payment', at('txDetail', { tx: Object.assign({}, TX_OUT, { pending: false, preimage: '0f'.repeat(32) }) }));
  add('txDetail, a Lightning receive with its payment hash', at('txDetail', { tx: { name: 'Lightning', dir: 'in', time: '09:12', sats: 1500, fee: 0, rail: 'LIGHTNING', hash: 'hash-in-ln', payHash: 'a1'.repeat(32) } }));
  add('txDetail, a locked payment with its receipt', at('txDetail', { tx: { name: 'Paid in person', dir: 'out', time: '14:39', sats: 21, fee: 0, rail: 'CASHU', hash: 'hash-receipt' } }));
  add('txDetail, a payment older than the last hundred, as a receipt', at('txDetail', { tx: { name: 'ecash', dir: 'out', time: 'Aug 2', sats: 500, fee: 0, rail: 'CASHU', hash: 'hash-slim' } }));
  add('txDetail, another unit', at('txDetail', { tx: TX_USD }));
  add('txDetail, cash', at('txDetail', { tx: TX_CASH }));
  add('txDetail, an ecash receive', at('txDetail', { tx: { dir: 'in', sats: 21, hash: 'token-1789157866360', memo: 'ecash' } }));
  // contacts
  add('contacts, a list', at('contacts', { contacts: CONTACTS }));
  add('contacts, searching, a match', at('contacts', { contacts: CONTACTS, ctSearch: true, ctQuery: 'ali' }));
  add('contacts, searching, a handle nobody saved', at('contacts', { contacts: CONTACTS, ctSearch: true, ctQuery: 'nobody@example.com' }));
  add('contacts, searching, no match', at('contacts', { contacts: CONTACTS, ctSearch: true, ctQuery: 'qqq' }));
  add('contacts, a fresh wallet, not live', at('contacts', { walletLive: false, fresh: true, contacts: [] }));
  // mints and restore
  add('switchMint, one connecting, one not answering', at('switchMint', { mintBusy: OTHER }));
  add('switchMint, no wallet', { state: { screen: 'switchMint', stack: [] } });
  add('newMint, a quote with a fee range', at('newMint', { nmInfo: { sats: 5000, amount: 5000, unit: 'sat', mint: 'https://new.example.com' }, nmPlan: { feeMin: 2, feeMax: 10, net: 4990 } }));
  add('newMint, one fee, redeeming', at('newMint', { nmInfo: { sats: 5000, amount: 5000, unit: 'sat', mint: 'https://new.example.com' }, nmPlan: { feeMin: 4, feeMax: 4, net: 4996 }, nmBusy: true, nmStage: 'Swapping…' }));
  add('newMint, an error', at('newMint', { nmInfo: { sats: 5000, amount: 5000, unit: 'sat', mint: 'https://new.example.com' }, nmErr: 'The mint did not answer.' }));
  add('newMint, waiting for the fee', at('newMint', { nmInfo: { sats: 5000, amount: 5000, unit: 'sat', mint: 'https://new.example.com' } }));
  add('newMint, too small to move', at('newMint', { nmInfo: { sats: 4, amount: 4, unit: 'sat', mint: 'https://mint.westernbtc.com' }, nmErr: 'The fee to move it is more than the token is worth.', nmTooSmall: true }));
  add('newMint, dollar ecash', at('newMint', { nmInfo: { sats: 0, amount: 250, unit: 'usd', mint: 'https://stablenut.example.com' } }));
  add('newMint, nothing yet', at('newMint', {}));
  add('importSeed, a finished scan, every kind of row', at('importSeed', {
    rsRows: [
      { host: 'mint.minibits.cash', state: 'done', sats: 5000 },
      { host: 'stablenut.example.com', state: 'done', sats: 0, units: { usd: { amount: 123 } } },
      { host: 'empty.example.com', state: 'done', sats: 0 },
      { host: 'down.example.com', state: 'failed' },
      { host: 'slow.example.com', state: 'looking' },
      { host: 'partial.example.com', state: 'done', partial: true, sats: 100 },
      { host: 'partial2.example.com', state: 'done', partial: true, sats: 0 },
    ],
    rsKept: 'Kept your words.',
  }));
  add('importSeed, looking', at('importSeed', { rsBusy: true, rsRows: [{ host: 'mint.minibits.cash', state: 'looking' }] }));
  add('importSeed, an error', at('importSeed', { rsErr: 'The phone did not answer.' }));
  add('rsConfirm, a pick', at('rsConfirm', { rsPick: { host: 'mint.minibits.cash', sats: 5000 }, rsPickErr: 'Could not reach it.' }));
  add('rsConfirm, units, working', at('rsConfirm', { rsPick: { host: 'stablenut.example.com', sats: 0, units: { usd: { amount: 123 } } }, rsBusy2: true }));
  // backup: the words and their quiz are the phone's screens
  add('bkStart', at('bkStart', {}));
  // split a bill
  add('spAmount, an amount', at('spAmount', { spAmt: '4500', spWays: 4 }));
  add('spAmount, too small', at('spAmount', { spAmt: '150', spWays: 4 }));
  add('spWays, three', at('spWays', { spAmt: '4500', spWays: 3 }));
  add('spWays, two', at('spWays', { spAmt: '4500', spWays: 2 }));
  add('spShares, even', at('spShares', { spAmt: '4500', spWays: 3 }));
  add('spShares, uneven, one assigned', at('spShares', { spAmt: '4500', spWays: 3, spShares: [1000, 2000, 1000], spAssigns: [{ type: 'contact', name: 'Bob', handle: 'bob@walletofsatoshi.com', ini: 'B' }] }));
  add('spShares, editing a share', at('spShares', { spAmt: '4500', spWays: 3, spEditIdx: 1, spEditBuf: '1200' }));
  add('spShares, editing yours', at('spShares', { spAmt: '4500', spWays: 3, spEditIdx: 0, spEditBuf: '0' }));
  add('spPayer, a QR, an invoice, copied', at('spPayer', { spAmt: '4500', spWays: 3, spIdx: 0, spInvoices: ['lnbc1500n1stub'], spCopied: 0 }));
  add('spPayer, a QR, paid by Cashu', at('spPayer', { spAmt: '4500', spWays: 3, spIdx: 0, spInvoices: ['lnbc1500n1stub'], spRail: 'CASHU' }));
  add('spPayer, the last, a contact, from waiting', at('spPayer', { spAmt: '4500', spWays: 3, spIdx: 1, spFromWaiting: true, spShared: 1, spAssigns: [{ type: 'qr' }, { type: 'contact', name: 'Zed', handle: 'zed@example.com', ini: 'Z' }] }));
  /* The four digits over a share's QR, which is what a payer holding a tap
   * compares against. Neither screen's code card was drawn by any snapshot, so
   * the split's missing one was invisible here. */
  add('spPayer, a payer tapped, the code up', at('spPayer', { spAmt: '4500', spWays: 3, spIdx: 0, spInvoices: ['lnbc1500n1stub'], tapShownCode: '4821' }));
  add('spPayer, on the air, tap here', at('spPayer', { spAmt: '4500', spWays: 3, spIdx: 0, spInvoices: ['lnbc1500n1stub'], tapArmed: true }));
  /* CARD is the fourth button of a share's row (SHARE, COPY, SCAN, CARD, as the receive invoice screen's; the Bluetooth tap is in the QR); a share that is paid has none, and the row is as it was. */
  add('spPayer, a paid share has no CARD', at('spPayer', { spAmt: '4500', spWays: 3, spIdx: 0, spInvoices: ['lnbc1500n1stub'], spPaid: [true, false] }));
  add('spAssign, contacts, one taken', at('spAssign', { spAmt: '4500', spWays: 3, spIdx: 0, contacts: CONTACTS, spAssigns: [{ type: 'qr' }, { type: 'contact', name: 'Zed', handle: 'zed@example.com', ini: 'Z' }] }));
  add('spWaiting, one of two paid', at('spWaiting', { spAmt: '4500', spWays: 3, spPaid: [true, false], spAssigns: [{ type: 'contact', name: 'Bob', handle: 'bob@walletofsatoshi.com', ini: 'B' }] }));
  add('spWaiting, one left of one', at('spWaiting', { spAmt: '4500', spWays: 2, spPaid: [false] }));
  add('spAllPaid', at('spAllPaid', { spAmt: '4500', spWays: 3, spPaid: [true, true] }));
  // popups and sheets with something in them
  add('note sheet, a note', at('confirm', { noteOpen: true, note: 'for the pizza', invoice: 'lnbc2100n1stub' }));
  add('backup ask', at('home', { bkAskOpen: true }));
  add('settings groups open', at('home', { gPaid: true, gPrefs: true, gAdv: true, gComm: true }));
  /* Two balances at one mint: dollars and bitcoin (build/app/01-ui-basics.js, the owner's design). The stand-in
   * wallet answers the two-balance calls; every view above it has none of them, and draws as it always did. */
  const TWO = (over) => Object.assign({
    mintUnits: () => ['sat', 'usd'], twoUnits: () => true,
    walletChoice: () => ({ hold: 'both', recv: '', send: '' }), setWalletChoice() {},
    balanceOf: (u) => (u === 'usd' ? 4205 : 250000), heldIn: () => 0, recoveringIn: () => 0,
    payNeed: (a, r, o) => ({ ok: !(o && o.unit === 'usd'), need: a + r, have: o && o.unit === 'usd' ? 200 : 250000, fee: r,
      unit: (o && o.unit) || 'sat', why: o && o.unit === 'usd' ? 'This payment needs $ 1.66 with its fee, and you hold $ 2.00.' : '' }),
    quoteFeeBoth: () => new Promise(() => {}),
  }, over || {});
  const TWO_LIVE = { balUsdCents: 4205 };
  const FEEQ = { sat: { unit: 'sat', amount: 2100, feeReserve: 12, rate: null, bolt11: INVOICE_THIS_MINT },
    usd: { unit: 'usd', amount: 162, feeReserve: 2, rate: { usdPerBtc: 76900 }, bolt11: INVOICE_THIS_MINT } };
  const asked = (l) => { l._quotedFor = INVOICE_THIS_MINT; };
  add('two balances: home, both pills', at('home', Object.assign({ series: SERIES, range: '1D' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: home, holding dollars', at('home', Object.assign({ balSats: 0 }, TWO_LIVE),
    { wallet: TWO({ walletChoice: () => ({ hold: 'dollars', recv: 'usd', send: 'usd' }), balanceOf: (u) => (u === 'usd' ? 4205 : 0) }) }));
  add('two balances: home, the menu with SWAP', at('home', Object.assign({ balSats: 0, open0: true }, TWO_LIVE),
    { wallet: TWO({ walletChoice: () => ({ hold: 'dollars', recv: 'usd', send: 'usd' }), balanceOf: (u) => (u === 'usd' ? 4205 : 0) }) }));
  // holding both, SETTINGS open: no RECEIVE IN or SEND IN (every receive and send asks which balance)
  add('two balances: settings', at('home', Object.assign({ open0: true, menuSettingsOpen: true }, TWO_LIVE),
    { wallet: TWO({ walletChoice: () => ({ hold: 'both', recv: '', send: '' }) }) }));
  // SETTINGS open with the two till caps (26j-till-caps.js): what one payer may hand this phone offline, and what it holds in all
  add('settings, what it takes offline', at('home', { open0: true, menuSettingsOpen: true },
    { wallet: { tillCaps: () => ({ payerSats: 66000, holdSats: 396000, promptSats: 198000, payerSet: false, holdSet: true }) } }));
  add('SET AMOUNT, what one payer may hand you offline', at('amount', { flow: 'tillCap', tillCapWhich: 'payer', unit: 'USD', amount: '40' }));
  add('two balances: what to hold, Both picked', at('holdChoice', Object.assign({ holdPick: 'both' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: CURRENCY before the first receive', at('currency', Object.assign({ currencyFlow: 'receive', currencyNext: 'amount' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: SET AMOUNT, a dollars receive', at('amount', Object.assign({ flow: 'receive', wallet: 'usd', unit: 'USD', amount: '5.00' }, TWO_LIVE), { wallet: TWO() }));
  // the same, with sats typed: asked as the cents they are worth, said under them
  add('two balances: SET AMOUNT, a dollars receive typed in sats', at('amount', Object.assign({ flow: 'receive', wallet: 'usd', unit: 'SATS', amount: '1000' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: RECEIVE INVOICE in dollars', at('confirm', Object.assign({ flow: 'receive', wallet: 'usd', unit: 'USD', amount: '5.00',
    recvUnit: 'usd', recvAmount: 500, recvRail: 'LIGHTNING', invoice: 'lnbcusdexample', asset: 'BITCOIN' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: RECEIVE INVOICE in bitcoin', at('confirm', Object.assign({ flow: 'receive', wallet: 'sat', unit: 'USD', amount: '5.00',
    recvUnit: 'sat', recvRail: 'LIGHTNING', invoice: INVOICE_THIS_MINT, asset: 'BITCOIN' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: CONFIRM PAYMENT from bitcoin', at('sendConfirm', Object.assign({ flow: 'send', wallet: 'sat', walletTapped: true,
    recipientKind: 'invoice', recipient: INVOICE_THIS_MINT, feeQ: FEEQ }, TWO_LIVE), { wallet: TWO(), before: asked }));
  add('two balances: CONFIRM PAYMENT from dollars, short', at('sendConfirm', Object.assign({ flow: 'send', wallet: 'usd', walletTapped: true,
    recipientKind: 'invoice', recipient: INVOICE_THIS_MINT, feeQ: FEEQ }, TWO_LIVE), { wallet: TWO(), before: asked }));
  /* Dollars paying a bitcoin invoice that came over a tap with the receiver's price on it, 3 % under the mint's: the
   * line under the dollars, amber (26k-price-line.js). */
  add('two balances: CONFIRM PAYMENT from dollars, their price 3 % off', at('sendConfirm', Object.assign({ flow: 'send', wallet: 'usd',
    walletTapped: true, recipientKind: 'invoice', recipient: INVOICE_THIS_MINT, feeQ: FEEQ,
    askRate: 74600, get askRateAt() { return Date.now(); }, askRateFor: INVOICE_THIS_MINT }, TWO_LIVE),
    { wallet: TWO({ payNeed: (a, r) => ({ ok: true, need: a + r, have: 4205, fee: r, unit: 'usd', why: '' }) }), before: asked }));
  add('two balances: WALLET, dollars short', at('walletPick', Object.assign({ flow: 'send', wallet: 'sat', walletAuto: true,
    recipientKind: 'invoice', recipient: INVOICE_THIS_MINT, feeQ: FEEQ }, TWO_LIVE), { wallet: TWO(), before: asked }));
  add('two balances: paid, ADDED TO DOLLARS', at('paid', Object.assign({ paidUnit: 'usd', paidAmount: 500, recvResolved: true,
    recv: { live: 'in' } }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: sent FROM DOLLARS', at('sendDone', Object.assign({ sendPhase: 'settled', recipientKind: 'invoice',
    recipient: INVOICE_THIS_MINT }, TWO_LIVE), { wallet: TWO(), before: (l) => { l._lastPay = { unit: 'usd', amount: 162, fee: 1, asked: 2100 }; } }));
  const SWAP_OUT = { name: 'Swap', dir: 'out', time: '09:10', unit: 'usd', amount: 1000, feeAmount: 0, sats: 0, kind: 'swap', swap: 'sw1', hash: 'sw1-out', mintRate: { usdPerBtc: 81786 } };
  const SWAP_IN = { name: 'Swap', dir: 'in', time: '09:10', unit: '', sats: 12230, fee: 0, kind: 'swap', swap: 'sw1', hash: 'sw1-in' };
  const TWO_HIST = [{ label: 'TODAY', items: [SWAP_OUT, SWAP_IN, Object.assign({}, TX_USD, { amount: 5205, feeAmount: 0 }), TX_IN] }];
  add('two balances: history, DOLLARS', at('history', Object.assign({ history: TWO_HIST, historyComplete: true, histUnit: 'usd' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: history, BITCOIN', at('history', Object.assign({ history: TWO_HIST, historyComplete: true, histUnit: 'sat' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: a swap in detail', at('txDetail', Object.assign({ tx: Object.assign({ mint: 'https://forge.example.com' }, SWAP_OUT) }, TWO_LIVE), { wallet: TWO() }));
  /* SWAP (build/app/26i-swap.js): which way, how much, the four blocks with the time the rate is held for, and
   * SWAPPED. The quote's expiry is read at render time, so the countdown always says 00:52. */
  const SWAP_Q = (over) => Object.assign({ id: 'uswap-1', mint: 'https://forge.example.com', from: 'usd', to: 'sat',
    total: 1000, amount: 998, fee: 2, get: 12202, rate: { usdPerBtc: 81786, by: 'forge.example.com' }, market: 80000,
    spread: 0.0223, spreadWarn: true, state: 'quoted', get expiresAt() { return Date.now() + 67500; } }, over || {});
  add('two balances: SWAP, from dollars', at('swap', Object.assign({ swapFrom: 'usd', swapTo: 'sat' }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: SET AMOUNT, a swap from bitcoin', at('amount', Object.assign({ flow: 'swap', swapFrom: 'sat', swapTo: 'usd',
    unit: 'SATS', amount: '12230' }, TWO_LIVE), { wallet: TWO({ mintRate: () => ({ usdPerBtc: 81786, at: Date.now() }) }) }));
  add('two balances: SWAP confirm, the market price far off', at('swapConfirm', Object.assign({ swapFrom: 'usd', swapTo: 'sat',
    swapAmount: 1000, swapQuote: SWAP_Q() }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: SWAP confirm, a new rate', at('swapConfirm', Object.assign({ swapFrom: 'usd', swapTo: 'sat',
    swapAmount: 1000, swapNewRate: true, swapQuote: SWAP_Q({ spreadWarn: false, spread: 0.01 }) }, TWO_LIVE), { wallet: TWO() }));
  // bitcoin leaving before the rate: its dollars at the mint's last rate, $ 10.00, with the sats under it
  add('two balances: SWAP confirm, asking the rate', at('swapConfirm', Object.assign({ swapFrom: 'sat', swapTo: 'usd',
    swapAmount: 12230, swapQuoting: true }, TWO_LIVE), { wallet: TWO({ mintRate: () => ({ usdPerBtc: 81786 }) }) }));
  add('two balances: SWAPPED', at('swapDone', Object.assign({ swapResult: { id: 'uswap-1', state: 'done', from: { unit: 'usd', amount: 1000 },
    to: { unit: 'sat', amount: 1221 }, fee: 1, rate: { usdPerBtc: 81786, by: 'forge.example.com' } } }, TWO_LIVE), { wallet: TWO() }));
  /* The shield on the money card, in each of the states the Tor banner had (23-render-home-and-amount.js, `shieldVals`), at a
   * mint with one balance and at one with two; the first frame of the pulse a turn to IP EXPOSED starts; and the connection
   * card its tap opens, which now carries the state's words. */
  const ROUTE = (over) => ({ privacy: () => Object.assign({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false,
    network: 'wifi', orbot: 'none', vpn: false, orbotKey: false }, over || {}) });
  const SHIELDS = [
    ['secure', ROUTE()],
    ['securing, Tor connecting at launch', ROUTE({ tor: 'connecting', progress: 40, everUp: false })],
    ['offline, no network', ROUTE({ tor: 'connecting', progress: 0, offline: true, network: 'none' })],
    ['cannot connect', ROUTE({ tor: 'failed', progress: 0, offline: true, network: 'wifi' })],
    // where the banner was blank and nothing is under way: no ring
    ['offline, Tor up over no network, not chosen', ROUTE({ network: 'none' })],
    ['cannot connect, Tor failed, not chosen', ROUTE({ tor: 'failed', progress: 0, everUp: false })],
    ['via a VPN', ROUTE({ tor: 'connecting', progress: 0, unprotected: true, vpn: true })],
    ['IP exposed', ROUTE({ tor: 'connecting', progress: 0, unprotected: true })],
  ];
  for (const [name, route] of SHIELDS) {
    add('home shield: ' + name + ', one balance', at('home', { series: SERIES, range: '1D' }, { wallet: route }));
    add('home shield: ' + name + ', two balances', at('home', Object.assign({ series: SERIES, range: '1D' }, TWO_LIVE),
      { wallet: TWO(route) }));
  }
  // a mint name too long for the heading runs to an ellipsis short of the shield, at one balance and two
  const LONG = { mintHost: () => 'cashu-mint-of-the-northern-valley.example/Bitcoin' };
  add('home shield: a long mint name, one balance', at('home', { series: SERIES, range: '1D' }, { wallet: Object.assign(ROUTE(), LONG) }));
  add('home shield: a long mint name, two balances', at('home', Object.assign({ series: SERIES, range: '1D' }, TWO_LIVE),
    { wallet: TWO(Object.assign(ROUTE(), LONG)) }));
  add('home shield: IP exposed, the first frame of its pulse', at('home', { series: SERIES, range: '1D', shieldPulse: true },
    { wallet: ROUTE({ tor: 'connecting', progress: 0, unprotected: true }) }));
  add('home shield: a pulse left over draws nothing once the route is secure', at('home', { series: SERIES, range: '1D', shieldPulse: true },
    { wallet: ROUTE() }));
  add('two balances: home, a swap still going through', at('home', Object.assign({}, TWO_LIVE),
    { wallet: TWO({ unitSwapsPending: () => [{ id: 'uswap-1', at: 1, from: { unit: 'usd', amount: 1000 }, to: { unit: 'sat', amount: 1221 } }] }) }));
  /* The other way round, at the owner's example: $ 1.00 of bitcoin for $ 0.95 at $ 82,601, and its amount typed in
   * dollars, the sats that leave under it. */
  add('two balances: SWAP confirm, bitcoin into dollars', at('swapConfirm', Object.assign({ swapFrom: 'sat', swapTo: 'usd',
    swapAmount: 1211, swapQuote: SWAP_Q({ from: 'sat', to: 'usd', total: 1211, amount: 1150, fee: 61, get: 95,
      rate: { usdPerBtc: 82601, by: 'forge.example.com' }, market: 82601, spread: 0, spreadWarn: false }) }, TWO_LIVE), { wallet: TWO() }));
  add('two balances: SET AMOUNT, a swap from bitcoin in dollars', at('amount', Object.assign({ flow: 'swap', swapFrom: 'sat', swapTo: 'usd',
    unit: 'USD', amount: '1.00' }, TWO_LIVE), { wallet: TWO({ mintRate: () => ({ usdPerBtc: 82601, at: Date.now() }) }) }));
  /* The rate line under the question (26i-swap.js, `swapRateLine`): while the rate asked at the SWAP tap is out, and the
   * market price, said to be the market's, from a mint that has given none. */
  add('two balances: SET AMOUNT, a swap, checking the rate', at('amount', Object.assign({ flow: 'swap', swapFrom: 'usd', swapTo: 'sat',
    unit: 'USD', amount: '', swapProbing: true }, TWO_LIVE), { wallet: TWO({ mintRate: () => null }) }));
  add('two balances: SET AMOUNT, a swap at the market price', at('amount', Object.assign({ flow: 'swap', swapFrom: 'usd', swapTo: 'sat',
    unit: 'USD', amount: '' }, TWO_LIVE), { wallet: TWO({ mintRate: () => null }) }));
  /* The same address paid from a card (SEND on the card's screen): FROM / FLASHCARD in place of PAYING FROM, the fee's sats
   * under it, and NEXT, which reads the card for the amount and the reserve (26f-flashcard.js, `fcOcNext`). */
  add('ocConfirm, from a card: FROM FLASHCARD and NEXT', at('ocConfirm',
    Object.assign({ ocPlan: OC_PLAN() }, OC, { sendFrom: 'card', fc: FC({ balance: 60000 }), stack: ['flashcard'] }),
    { wallet: CARDS({ cardOutTotal: (amount, reserve) => amount + reserve }),
      // card mode needs the card's screen under the flow, a stack the other views do not have: no slide in or out of it (`syncSlide`)
      before: (a) => { a._fcCard = { key: KEY_A, info: {}, pieces: [] }; a._nav = { screen: 'ocConfirm', len: 1 }; },
      after: (a) => { a._nav = { screen: 'ocConfirm', len: 0 }; } }));
  /* Sats paid to a wallet that holds dollars (build/app/26i-swap.js `convertOnReturn`): the PRICE screen for sats offered for a
   * dollar request, with both prices' ages; the payer's confirmation of the request agreed, at its price two hours old; PAYMENT
   * RECEIVED with the dollars asked; and history and a payment's detail, swapped and still to be swapped. */
  const HOLDS_USD = TWO({ walletChoice: () => ({ hold: 'dollars', recv: 'usd', send: 'usd' }) });
  // a receiver whose own price is that old has been offline, and is still
  add('priceconfirm, sats for dollars, both prices aged', at('priceConfirm', Object.assign({ priceQ: { id: 'r1', sats: 6502, usd: 500,
    theirRate: 76900, differsPct: null, myTooOld: true, myRateAgeMs: 30 * 3600 * 1000, theirAgeMs: 2 * 3600 * 1000, forUnit: 'usd' } }, TWO_LIVE),
    { wallet: Object.assign({}, HOLDS_USD, OFFLINE) }));
  // and one online, paid by a payer that is not, at the payer's price from 20 hours ago, 2% over its own
  add('priceconfirm, sats for dollars, to a receiver online', at('priceConfirm', Object.assign({ priceQ: { id: 'r1', sats: 6375, usd: 500,
    theirRate: 78438, differsPct: 2, myTooOld: false, myRateAgeMs: 60000, theirAgeMs: 20 * 3600 * 1000, forUnit: 'usd' } }, TWO_LIVE),
    { wallet: Object.assign({}, HOLDS_USD, ONLINE) }));
  add('reqOffer, sats for dollars agreed, this phone’s price two hours old', at('reqOffer', { req: { id: 'agreed-1', sats: 6502, unit: 'sat',
    mints: ['https://mint.minibits.cash/Bitcoin'], transports: [], viaTap: true }, tapCode: '4242', tapQuoteFor: 'agreed-1', tapQuoteUsd: 500,
    tapQuoteRate: 76900, tapQuoteAgeMs: 2 * 3600 * 1000 }));
  add('two balances: paid, sats for the dollars asked', at('paid', Object.assign({ amount: '6502', unit: 'SATS', asset: 'BITCOIN', paidUnit: 'sat',
    paidAmount: 6502, paidAsked: 500, paidAskAgeMs: 2 * 3600 * 1000, paidConvert: true, recvResolved: true, recv: { live: 'in' } }, TWO_LIVE),
    { wallet: HOLDS_USD }));
  // agreed in dollars on the old path, and staying bitcoin: PAYMENT RECEIVED as it always was
  add('two balances: paid, sats agreed in dollars that stay bitcoin', at('paid', Object.assign({ amount: '6502', unit: 'SATS', asset: 'BITCOIN',
    paidUnit: 'sat', paidAmount: 6502, paidAsked: 500, paidAskAgeMs: 2 * 3600 * 1000, paidConvert: false, recvResolved: true, recv: { live: 'in' } },
    TWO_LIVE), { wallet: TWO() }));
  const ASKED = { name: 'Paid in person', dir: 'in', sats: 6502, fee: 0, rail: 'CASHU', rate: 76900, usdAsked: 500, askRate: 76900,
    askAgeMs: 2 * 3600 * 1000, askSeenAt: 1 };
  const CONV_DONE = Object.assign({ time: '09:20', hash: 'req-c1', convert: 'done', convertSwap: 'sw2', convertUsd: 493 }, ASKED);
  const CONV_OWED = Object.assign({ time: '09:30', hash: 'req-c2', pending: true, convert: 'owed' }, ASKED);
  const CONV_HIST = [{ label: 'TODAY', items: [CONV_OWED, CONV_DONE].concat(TWO_HIST[0].items) }];
  add('two balances: history, BITCOIN, sats swapped into dollars and still to be', at('history', Object.assign({ history: CONV_HIST,
    historyComplete: false, histUnit: 'sat' }, TWO_LIVE), { wallet: HOLDS_USD }));
  add('two balances: a payment swapped into dollars, in detail', at('txDetail', Object.assign({ tx: Object.assign({ stamp: 'Today, 09:20' }, CONV_DONE) }, TWO_LIVE),
    { wallet: HOLDS_USD }));
  add('two balances: a payment still to be swapped into dollars, in detail', at('txDetail', Object.assign({ tx: Object.assign({ stamp: 'Today, 09:30' }, CONV_OWED) }, TWO_LIVE),
    { wallet: HOLDS_USD }));
  // in the pile and waiting only for a quiet moment, and one spent before it could be swapped
  const CONV_CLAIMED = Object.assign({ time: '09:40', hash: 'req-c3', convert: 'claimed' }, ASKED);
  const CONV_SPENT = Object.assign({ time: '09:50', hash: 'req-c4', convert: 'kept', convertWhy: 'spent' }, ASKED);
  add('two balances: history, BITCOIN, sats in the pile to be swapped and sats spent first', at('history', Object.assign({
    history: [{ label: 'TODAY', items: [CONV_SPENT, CONV_CLAIMED].concat(TWO_HIST[0].items) }], historyComplete: false, histUnit: 'sat' }, TWO_LIVE),
    { wallet: HOLDS_USD }));
  add('two balances: a payment in the pile to be swapped into dollars, in detail', at('txDetail', Object.assign({ tx: Object.assign({ stamp: 'Today, 09:40' }, CONV_CLAIMED) }, TWO_LIVE),
    { wallet: HOLDS_USD }));
  /* A card that holds dollars (26f-flashcard.js): its screen, its keypad and its limit in dollars, the CURRENCY screen asking
   * what a new card will hold, PAYMENT RECEIVED for one, and dollars it paid for sats this phone asked (a bitcoin-only phone's
   * to be swapped into bitcoin, a phone of both's kept), in history and in detail. */
  const USD_DAY = { limited: true, limit: 5000, spent: 1200, left: 3800, turns: 4102444800, now: 4102358400, noTime: false };
  add('flashcard, a dollar card', at('flashcard', Object.assign({ fc: FC({ unit: 'usd', balance: 2000, limit: 5000, day: USD_DAY, tap: TAP }) }, TWO_LIVE), { wallet: CARDS() }));
  add('flashcard, a dollar card with no PIN', at('flashcard', Object.assign({ fc: FC({ unit: 'usd', balance: 2000, pin: 'none', pinSet: false, noPinKnown: true,
    noPin: { known: true, set: false, limit: 0, spent: 0, left: 0, turns: 0, now: 0 } }) }, TWO_LIVE), { wallet: CARDS() }));
  // (this phone's $42.05 is what can be put on it: the dollar keypad, capped by it)
  add('amount, adding to a dollar card', at('amount', Object.assign({ flow: 'cardAdd', amount: '5.00', unit: 'USD', fc: FC({ unit: 'usd', balance: 2000 }) }, TWO_LIVE),
    { wallet: Object.assign(TWO(), CARDS()) }));
  add('fcLimitConfirm, a dollar card\u2019s limit on one tap', at('fcLimitConfirm', { fc: FC({ unit: 'usd', balance: 2000 }), fcLimit: { sats: 2000, usd: 0 } },
    { wallet: CARDS(), before: (a) => { a._fcLimitNoPin = false; a._fcLimitTap = false; } }));
  add('CURRENCY, setting up a card', at('currency', Object.assign({ currencyFlow: 'card', currencyNext: 'flashcard' }, TWO_LIVE), { wallet: TWO() }));
  /* A card of software 1.23 (26f-flashcard.js): dollars and bitcoin on one card, its two pills and its one ceiling in dollars under them;
   * one of bitcoin alone, its ceiling in dollars all the same; which currency pays, is added or is taken off, on the CURRENCY screen; the
   * rate guard; the card's SWAP from its own balances; and a refusal of 1.23 in its own words. */
  const TAP_CENTS = { known: true, paced: true, limited: true, limit: 1000, spent: 0, left: null, turns: 0, noTime: false };
  const NOPIN_CENTS = { known: true, set: true, limit: 200, spent: 15, left: 185, turns: 0, now: 0 };
  const FC123 = (over) => FC(Object.assign({ v123: true, cents: true, pinFirst: true, noPinKnown: true, units: ['sat', 'usd'], bal: { usd: 1500, sat: 3000 },
    balance: 3000, tap: TAP_CENTS, noPin: NOPIN_CENTS, rate: 1000 }, over || {}));
  add('flashcard, a card of software 1.23 holding dollars and bitcoin: two pills, its ceiling in dollars under them', at('flashcard', Object.assign({ fc: FC123() }, TWO_LIVE),
    { wallet: Object.assign(TWO(), CARDS()) }));
  add('flashcard, a card of software 1.23 holding bitcoin alone: one pill, its ceiling in dollars', at('flashcard', Object.assign({ fc: FC123({ units: ['sat'], bal: { usd: 0, sat: 3000 } }) }, TWO_LIVE),
    { wallet: Object.assign(TWO(), CARDS()) }));
  add('CURRENCY, which currency of a card pays', at('currency', Object.assign({ currencyFlow: 'card', currencyNext: 'flashcard', fc: FC123(),
    curCard: { question: 'PAY FROM WHICH?', foot: 'This card holds dollars and bitcoin. The one you pick pays this time; you are asked every time.',
      bal: { usd: 1500, sat: 3000 }, short: { usd: '', sat: '' } } }, TWO_LIVE), { wallet: TWO() }));
  add('CURRENCY, which currency of a card pays, one too short', at('currency', Object.assign({ currencyFlow: 'card', currencyNext: 'flashcard', fc: FC123(),
    curCard: { question: 'PAY FROM WHICH?', foot: 'This card holds dollars and bitcoin. The one you pick pays this time; you are asked every time.',
      bal: { usd: 50, sat: 3000 }, short: { usd: 'NOT ENOUGH ON THE CARD', sat: '' } } }, TWO_LIVE), { wallet: TWO() }));
  // (setting a new card of 1.23 up: a third card, BOTH, with this phone's two balances on its one line, and the words for the three)
  add('CURRENCY, setting up a card of software 1.23: dollars, bitcoin or both', at('currency', Object.assign({ currencyFlow: 'card', currencyNext: 'flashcard', curBoth: true,
    fc: FC123({ hasRecord: false, setUp: false, owner: false, ownedHere: false, units: null, bal: null, balance: 0 }) }, TWO_LIVE), { wallet: TWO() }));
  add('CURRENCY, adding to a card of software 1.23', at('currency', Object.assign({ currencyFlow: 'card', currencyNext: 'flashcard', fc: FC123(),
    curCard: { question: 'ADD WHICH TO THE CARD?', foot: 'From what this phone holds. The card keeps dollars and bitcoin side by side.', bal: null, short: { usd: '', sat: '' } } }, TWO_LIVE),
    { wallet: TWO() }));
  add('two balances: SWAP, a card\u2019s two balances', at('swap', Object.assign({ swapFrom: 'usd', swapTo: 'sat', fc: FC123() }, TWO_LIVE),
    { wallet: TWO(), before: (a) => { a._swapCard = { key: KEY_A, bal: { usd: 1500, sat: 3000 } }; } }));
  add('amount, withdrawing dollars from a card of software 1.23', at('amount', Object.assign({ flow: 'cardWd', amount: '', unit: 'USD', fc: FC123() }, TWO_LIVE),
    { wallet: Object.assign(TWO(), CARDS()), before: (a) => { a._fcFlowUnit = 'usd'; } }));
  add('PAYMENT RECEIVED, a dollar card paid', at('paid', Object.assign({ paidUnit: 'usd', paidAmount: 475, recvResolved: true, recv: { live: 'in' } }, TWO_LIVE), { wallet: TWO() }));
  add('PAYMENT RECEIVED, sats asked of a dollar card, to be swapped into bitcoin', at('paid', Object.assign({ paidUnit: 'usd', paidAmount: 592, paidAskedSats: 7000,
    paidAskOwn: true, paidAskAgeMs: 2 * 3600 * 1000, paidConvert: true, recvResolved: true, recv: { live: 'in' } }, TWO_LIVE),
    { wallet: TWO({ walletChoice: () => ({ hold: 'bitcoin', recv: 'sat', send: 'sat' }) }) }));
  add('PAYMENT RECEIVED, sats asked of a dollar card, kept as dollars', at('paid', Object.assign({ paidUnit: 'usd', paidAmount: 592, paidAskedSats: 7000,
    paidAskOwn: true, paidAskAgeMs: 2 * 3600 * 1000, paidConvert: false, recvResolved: true, recv: { live: 'in' } }, TWO_LIVE), { wallet: TWO() }));
  const HOLDS_BTC = TWO({ walletChoice: () => ({ hold: 'bitcoin', recv: 'sat', send: 'sat' }) });
  const SATS_ASKED = { name: 'From a card', dir: 'in', unit: 'usd', amount: 592, feeAmount: 0, sats: 0, fee: 0, rail: 'CASHU', satsAsked: 7000,
    askRate: 84571, askAgeMs: 2 * 3600 * 1000, askSeenAt: 1, askOwn: true, memo: 'card, offline' };
  const ASK_ROW = (hash, time, over) => Object.assign({ hash, time }, SATS_ASKED, over || {});
  add('two balances: history, DOLLARS, dollars a card paid for sats, in each state', at('history', Object.assign({ history: [{ label: 'TODAY', items: [
    ASK_ROW('req-d1', '09:10', { convert: 'owed' }), ASK_ROW('req-d2', '09:20', { convert: 'swapping' }), ASK_ROW('req-d3', '09:30', { convert: 'done', convertSats: 6961 }),
    ASK_ROW('req-d4', '09:40', { convert: 'failed' }), ASK_ROW('req-d5', '09:50', { convert: 'kept', convertWhy: 'small' }), ASK_ROW('req-d6', '10:00', { convert: 'kept', convertWhy: 'hold' }),
    ASK_ROW('req-d7', '10:10', { convert: 'owed', cardWaits: true }),
  ] }], historyComplete: false, histUnit: 'usd' }, TWO_LIVE), { wallet: HOLDS_BTC }));
  add('two balances: dollars a card paid for sats, swapped into bitcoin, in detail', at('txDetail', Object.assign({ tx: ASK_ROW('req-d3', '09:30',
    { convert: 'done', convertSats: 6961, stamp: 'Today, 09:30' }) }, TWO_LIVE), { wallet: HOLDS_BTC }));
  return v;
}

/* ---- cards and dialogs, built in plain DOM ------------------------------ */
function cards() {
  const v = [];
  const add = (label, call, over) => v.push([label, Object.assign({ wallet: true, state: Object.assign({ screen: 'home', stack: [] }, LIVE), call }, over || {})]);
  for (const kind of ['sendFail', 'mintRefused', 'netLost', 'lnNoRoute', 'badAddress']) add('card: ' + kind, (a) => a.blockedCard(kind));
  /* A bitcoin price too old to work dollars out from, on each side of a tap (26d-tap.js): the payer's own, two days old, and a
   * payer's the receiver is offered. Each by the method that raises it. */
  const TWO_DAYS = 2 * 24 * 3600 * 1000;
  add('card: the payer’s bitcoin price too old', (a) => a.tapQuoteTheirDollars({ read: { id: 'r1', unit: 'usd', amount: 500, sats: null },
    theirRoute: false, mints: [MINT], sameMint: true }), { wallet: { lastPrice: () => ({ rate: 76900, at: Date.now() - TWO_DAYS, ageMs: TWO_DAYS }),
    priceTooOld: () => true, tapQuote: () => Promise.resolve('ok') } });
  // stamped ahead of the phone's clock: the clock is what is wrong, and the card says that
  add('card: the payer’s bitcoin price ahead of its clock', (a) => a.tapQuoteTheirDollars({ read: { id: 'r1', unit: 'usd', amount: 500, sats: null },
    theirRoute: false, mints: [MINT], sameMint: true }), { wallet: { lastPrice: () => ({ rate: 76900, at: Date.now() + 600000, ageMs: 0 }),
    priceTooOld: () => true, tapQuote: () => Promise.resolve('ok') } });
  add('card: the receiver refuses a price too old', (a) => a.tapPriceOffered('{"id":"r1"}'), { wallet: {
    readQuote: () => ({ id: 'r1', usd: 500, sats: 6502, theirRate: 76900, myRate: 0, myRateAgeMs: 0, differsPct: null,
      theirAgeMs: TWO_DAYS, theirSeenAt: 1, tooOld: true, myTooOld: false, forUnit: 'usd' }),
    tapTerms: () => Promise.resolve('ok') } });
  add('card: blocked, a retry and a second button', (a) => a.blockedCard('netLost', { retry: 'RETRY', go() {}, also: { label: 'LATER', tap() {} } }));
  // the tone that asks rather than reports: the Tor banner's card, and SECURE FOXY
  add('card: the Tor banner explains itself', (a) => a.blockedCard('torConnection', {
    tone: 'ask', title: 'TOR CONNECTION',
    reason: 'Tor is a privacy network that hides your IP address while you use Foxy.',
  }));
  // the same card from the shield's tap, which carries the words the shield no longer says: here, that the IP address is exposed
  add('card: the shield\u2019s tap, IP exposed, says so in words', (a) => a.renderVals().torBanner(), { wallet: { privacy: () => ({
    tor: 'connecting', progress: 0, everUp: false, unprotected: true, offline: false, network: 'wifi', orbot: 'none', vpn: false, orbotKey: false }) } });
  add('card: secure Foxy, three ways', (a) => a.blockedCard('secureFoxy', {
    tone: 'ask', title: 'SECURE FOXY',
    reason: 'You have bitcoin in Foxy now. What should stand in front of it?',
    chip: 'Face ID also guards your twelve words. With no protection, nothing does.',
    retry: 'USE FACE ID', go() {},
    shut: { label: 'SET A FOXY PIN', tap() {} },
    also: { label: 'NO PROTECTION', tap() {} },
  }));
  add('card: paying another user of this mint', (a) => a.acceptTarget(INVOICE_THIS_MINT),
    { wallet: { classify: () => 'invoice', amountOf: () => 2100, msatOf: () => 2100000, invoiceFromThisMint: () => true, mintHost: () => 'mint.minibits.cash/Bitcoin' } });
  add('card: invalid signatures at a claim', (a) => a.badSignatureCard('mint.example.com', 'claim'));
  add('card: invalid signatures at a payment', (a) => a.badSignatureCard('', 'pay'));
  add('card: invalid signatures, elsewhere', (a) => a.badSignatureCard(null, 'swap'));
  add('card: paid, not collected, bad signatures', (a) => a.showStuckInvoice({ quote: 'q1', mint: MINT, amount: 2100, unclaimed: { badSignatures: true } }));
  add('card: paid, not collected, refused', (a) => a.showStuckInvoice({ quote: 'q2', mint: MINT, amount: 2100, unclaimed: { refused: 3, reason: 'outputs already signed' } }));
  add('card: paid, not collected yet', (a) => a.showStuckInvoice({ quote: 'q3', mint: MINT, amount: 2100, unclaimed: { refused: 1, reason: 'busy' } }));
  // with no route nothing is being tried, so the card does not say retrying (11-cards.js `stuckRetryCard`)
  add('card: paid, not collected yet, no connection', (a) => a.showStuckInvoice({ quote: 'q4', mint: MINT, amount: 2100, unclaimed: { unsent: true, reason: 'Foxy is not connected to Tor.' } }),
    { wallet: { routeOpen: () => false } });
  /* Both phones offline: the only card in Foxy that decides whether money is
   * taken. Pinned as a picture because its words are the whole protection. */
  add('card: both offline, high risk', (a) => { a.offlineRiskCard({ sats: 4900 }); });
  add('card: both offline, a small amount', (a) => { a.offlineRiskCard({ sats: 64 }); });
  add('card: a trusted payment was taken back', (a) => a.trustLostCard({ sats: 4900 }));
  /* No exact change: asked, never assumed — and the wording turns on whether
   * the difference can come back at all. */
  add('card: no exact change, both offline', (a) => {
    a.overpayCard({ asked: 4, pay: 32, over: 28, changeComesBack: false }); });
  add('card: no exact change, change comes back', (a) => {
    a.overpayCard({ asked: 100, pay: 128, over: 28, changeComesBack: true }); });
  add('card: they did not take it', (a) => a.blockedCard('netLost', {
    tone: 'warn', title: 'THEY DID NOT TAKE IT',
    reason: 'You are both offline, so this phone cannot give change. Send exactly 4 sats, or one of you get online.',
    chip: 'Your 32 sats are still yours.',
    retry: 'SHOW THEM A TOKEN', go() {}, shut: { label: 'CLOSE', tap() {} } }));
  add('card: claim failed, already spent', (a) => a.claimFailed(new Error('Token already spent')));
  add('card: claim failed, ecash this phone already took', (a) => a.claimFailed(Object.assign(new Error('Token already spent'),
    { foxyMine: true, foxyTakenAt: 0, foxyTakenSats: 1156 })));
  add('card: claim failed, locked', (a) => a.claimFailed(new Error('P2PK: locked to another key')));
  add('card: claim failed, the network, again', (a) => a.claimFailed(new Error('timed out'), () => {}));
  add('card: claim failed, invalid signatures', (a) => a.claimFailed(new Error('DLEQ verification failed')));
  add('card: the mint holds your bitcoin', (a, w) => { w.localStorage.removeItem('foxy.custody.told'); a.custodyNotice(); });
  add('card: a test mint', (a) => a.custodyNotice(), { wallet: { mintHost: () => 'testnut.cashu.space' } });
  add('card: mint not answering', (a, w) => {
    w.localStorage.setItem('foxy.cashu.proofs.' + OTHER, JSON.stringify([{ amount: 64 }, { amount: 8 }]));
    a.mintDownNotice(OTHER);
    w.localStorage.removeItem('foxy.cashu.proofs.' + OTHER);
  });
  add('card: a lot at one mint', (a, w) => {
    w.localStorage.setItem('foxy.cashu.proofs.' + MINT, JSON.stringify([{ amount: 131072 }]));
    w.localStorage.removeItem(a.SPREAD_KEY);
    a._readyAt = 0;
    a.spreadNudge();
    w.localStorage.removeItem('foxy.cashu.proofs.' + MINT);
    w.localStorage.removeItem(a.SPREAD_KEY);
  });
  add('card: this iPhone has no passcode', (a) => a.passcodeNotice(), { wallet: { phoneHasPasscode: () => false } });
  add('card: ecash set aside', (a) => a.offerQuarantine());
  add('card: ecash set aside, no mint known', (a) => a.offerQuarantine(), { wallet: { quarantinedUnknown: () => 5000 } });
  add('card: unclaimed ecash before clearing history', async (a) => { a.askClear('history'); a.askClear('history'); await wait(20); });
  add('price error bar', (a) => a.showPriceError());
  add('sheet: type a mint', (a) => a.typeMint());
  add('sheet: a note', (a) => a.noteSheet('dinner', () => {}));
  add('sheet: a token note', (a) => a.editTokenNote());
  add('loader: melt', (a) => a.showMelt('Claiming at a new mint…'));
  /* BACKUP opens the phone's screen and keeps a sheet around it (verify is
   * the phone's quiz, and draws nothing here), and RESTORE has one button that
   * asks the phone for the words. */
  add('overlay: the seed phrase', (a) => a.showSeed());
  add('overlay: PIN entry', (a) => a.pinOverlay({ title: 'ENTER YOUR PIN', subtitle: 'To turn the lock off.', cta: 'TURN OFF', onCancel() {}, onSubmit() {} }));
  add('overlay: PIN set-up', (a) => a.pinSetup(() => {}));
  // the same pad asking for a card's PIN, and for an amount with a second answer (26f-flashcard.js)
  add('overlay: a card\u2019s PIN, to pay, after a wrong one', (a) => a.fcAskPin({ title: 'CARD PIN', subtitle: 'To pay $0.43 (\u20bf500). The card\u2019s owner types its PIN here.', warn: 'Wrong PIN. 2 tries left.', cta: 'PAY $0.43' }, () => {}));
  /* The screen behind the card sheet (26h-tap-screen.js), one view for each of its states, and the card in each design; the
   * seconds of KEEP HOLDING are fixed so the view does not move with the clock */
  const behind = (o, fn) => (a) => { a.FC_TAP_REMOVE_MS = 1500; a._fcTapO = Object.assign({ amount: '$25.75' }, o || {}); a.fcHeldSeconds = () => 7; a.fcStage('hold'); if (fn) fn(a); };
  const link = (a, stage) => a.fcTapEvent({ stage, text: '' });
  add('stage: tap behind phone', behind());
  add('stage: keep holding', behind({}, (a) => link(a, 'connected')));
  add('stage: verifying card', behind({}, (a) => { link(a, 'connected'); a.fcStage('mint'); }));
  // (REMOVE gives way to CHECKING a second and a half after the card signed: held here, so the view does not move with the clock)
  add('stage: remove', behind({}, (a) => { a.FC_TAP_REMOVE_MS = 3600 * 1000; link(a, 'connected'); a.fcStage('checking'); }));
  // the mint not heard from once the card is gone: CHECKING, and after the wait the CHECKING card makes (58 seconds), STILL CHECKING
  add('stage: checking', behind({}, (a) => { link(a, 'connected'); a.fcStage('checking'); a._fcTapO.t.goneAt = Date.now() - 5000; a.fcTapDraw(); }));
  add('stage: still checking', behind({}, (a) => { link(a, 'connected'); a.fcStage('checking'); a._fcTapO.t.goneAt = Date.now() - 100000; a.fcTapDraw(); }));
  add('stage: tap for change', behind({ look: 'receive' }));
  add('stage: please tap again', behind({}, (a) => { link(a, 'connected'); link(a, 'lost'); }));
  add('stage: enter pin', behind({}, (a) => { link(a, 'connected'); a.fcTapPin(); }));
  add('stage: keep holding, a card of the drawn design', behind({}, (a) => { link(a, 'connected'); a.fcTapSeen(''); }));
  add('stage: tap behind phone, no amount', behind({ amount: '' }));
  add('stage: checking a card payment', (a) => { a.fcChecking('card-x', { paying: true, taken: true }); clearTimeout(a._fcCheckT); },
    { wallet: { cardSession: () => Promise.resolve(), cardSettle: () => new Promise(() => {}) } });
  // a limit's first step (no daily limit is asked for), what making this phone a card's owner says, and what a till says when a card cannot cover a payment
  add('card: set per tap limit, the warning', (a) => a.fcLimitAsk(() => {}));
  add('card: set no PIN limit, the warning', (a) => a.fcLimitAsk(() => {}, 'nopin'));
  /* A card's set-up from software 1.21 (26j-card-wheel.js): the PIN pad for a card set up for somebody else (its two amounts are SET AMOUNT
   * and MAX SPEND PER SECOND, above, with no question first); then the card of a holder with no phone (1.22): TIE OWNERSHIP's warning. */
  add('overlay: CREATE A PIN, for a card set up for its holder', (a) => a.fcSetUpSteps({ other: true, unit: 'sat', run() {} }));
  add('card: tie ownership to this phone, the warning', (a) => { a.state.fc = { balance: 0, count: 0 }; a.fcGuestTie(); });
  add('card: restore lost card, a phone that loaded none', (a) => a.fcRestoreLost(), { wallet: { cardSession: () => Promise.resolve(), cardsList: () => [] } });
  // a card of software before 1.16 is asked for a PIN when it is set up (a card of 1.16 and on is not: it is set up with none), and the pad that adds a PIN says what a card with none is
  add('overlay: a new card\u2019s PIN, for a card of software before 1.16', (a) => { a.state.fc = { noPinKnown: false, pinSet: false, setUp: false }; a.fcSetUp(); });
  add('overlay: ADD PIN, the first pad', (a) => { a.state.fc = { owner: true, ownedHere: true, setUp: true, pinSet: false, noPinKnown: true }; a.fcPinAdd(); });
  // a till whose first tap, with no PIN, found the card wants one
  add('overlay: a card\u2019s PIN, for the second tap', (a) => a.fcPayAsk(500));
  // the limit on one tap has a warning and a confirmation of its own (LIMITS' rows are the fcLimits views)
  add('card: set per tap limit on a card of 1.12, the warning', (a) => { a._fcCard = { info: { format: 4, shaped: false } }; a.fcLimitAsk(() => {}, true); });
  // the card that makes its own change is shown the rule played out; recorded as it stands once it has played
  add('card: how tap limit works, played out', (a) => { a.fcLimitAsk(() => {}, true); a._fcExplainer.finish(); });
  add('card: how tap limit works, for a card before 1.17, played out', (a) => { a._fcCard = { info: { waitOver: 7 } }; a.fcLimitAsk(() => {}, true); a._fcExplainer.finish(); });
  // RESET CARD (software 1.17): the warning, with and without money on the card, and the PIN of a locked one
  add('card: reset, the warning', (a) => { a.state.fc = { resetKnown: true, owner: true, ownedHere: true, balance: 0 }; a.fcReset(); });
  add('card: reset, the warning with money on the card', (a) => { a._fcCard = {}; a.state.fc = { resetKnown: true, owner: true, ownedHere: true, balance: 2048, mint: MINT }; a.fcReset(); },
    { wallet: { cardSession: () => Promise.resolve(), mintHost: () => 'mint.minibits.cash/Bitcoin' } });
  add('overlay: a locked card\u2019s PIN, to reset it', (a) => { a.state.fc = { resetKnown: true, owner: true, ownedHere: false, locked: true, pinSet: true, setUp: true, balance: 0 }; a.fcResetGo(); });
  add('card: reset, the money came off and the reset did not', (a) => a.blockedCard('fc-reset-part', { tone: 'warn', title: 'EMPTY, BUT NOT RESET',
    reason: '$1.31 (\u20bf2,048) came off the card into this phone. The card is not reset yet: tap it again to finish.', chip: 'Hold it still until the phone says to remove it.',
    retry: 'TAP CARD', go: () => {}, shut: { label: 'LATER' } }));
  // FLASHCARD on the send screen: the PIN of a card that has one, for the second tap
  add('overlay: a card\u2019s PIN, to put money on it from the send screen', (a) => a.fcSendAsk(500));
  // the card's own log, opened from its line on the card's screen
  add('card: this card\u2019s own log', (a) => { a.state.fc = { log: { taps: 41, sats: 213400, refused: 0, tampers: 0, since: { taps: 2, sats: 15360, refused: 0, tampers: 0 },
    last: [{ time: 4102358400, sats: 12288, pieces: 2, refused: 0, tamper: false }, { time: 4102354800, sats: 3072, pieces: 2, refused: 0, tamper: false }] } }; a.fcLogCard(); });
  add('card: this card\u2019s own log, a tap made without the PIN', (a) => { a.state.fc = { log: { taps: 41, sats: 213400, refused: 0, tampers: 0, since: { taps: 2, sats: 15360, refused: 0, tampers: 0 },
    last: [{ time: 4102358400, sats: 12288, pieces: 2, refused: 0, tamper: false, noPin: true }, { time: 4102354800, sats: 3072, pieces: 2, refused: 0, tamper: false, noPin: false }] } }; a.fcLogCard(); });
  add('card: tamper on this card', (a) => { a.state.fc = { log: { taps: 42, sats: 213400, refused: 5, tampers: 1, since: { taps: 1, sats: 0, refused: 5, tampers: 1 },
    last: [{ time: 4102358460, sats: 0, pieces: 0, refused: 5, tamper: true }, { time: 4102358400, sats: 12288, pieces: 2, refused: 0, tamper: false }] } }; a.fcLogCard(); });
  // the log of a card of software 1.15: each tap at the time the phone that tapped it told the card, with the block the card had beside it
  add('card: this card\u2019s own log, software 1.15', (a) => { a.state.fc = { headers: true, clockAhead: 0, log: { taps: 41, sats: 213400, refused: 0, tampers: 0, since: { taps: 2, sats: 15360, refused: 0, tampers: 0 },
    last: [{ time: 4102358400, told: 4102358437, sats: 12288, pieces: 2, refused: 0, tamper: false, clock: false }, { time: 4102358400, told: 0, sats: 3072, pieces: 2, refused: 0, tamper: false, clock: false },
           { time: 0, told: 4102354800, sats: 0, pieces: 0, refused: 0, tamper: false, clock: false, loads: 3, loaded: 640 }] } }; a.fcLogCard(); });
  add('card: tamper on this card, software 1.15: a run of refusals, and nothing about a clock', (a) => { a.state.fc = { headers: true, clockAhead: 0, log: { taps: 42, sats: 213400, refused: 5, tampers: 1, since: { taps: 1, sats: 0, refused: 5, tampers: 1 },
    last: [{ time: 4102358400, told: 4102358460, sats: 0, pieces: 0, refused: 5, tamper: true, clock: false }] } }; a.fcLogCard(); });
  add('card: a till, over the card\u2019s per tap limit', (a) => a.fcFailed({ card: 'tap-limit', left: 2000, need: 4096, limit: 2000, turns: 0, message: 'x' }, { taken: true }));
  add('card: a till, over what is left of this tap', (a) => a.fcFailed({ card: 'tap-limit', left: 300, need: 512, limit: 2000, turns: 4102444800, message: 'x' }, { taken: true }));
  add('card: a per tap limit on a card whose software has none', (a) => a.fcFailed({ card: 'old-card', message: 'This card\u2019s software has no limit on one tap.' }, {}));
  add('card: a till, over the card\u2019s daily limit, with what is left today', (a) => a.fcFailed({ card: 'limit', left: 1200, need: 2000, limit: 5000, turns: 4102444800, message: 'x' }, { taken: true }));
  add('card: a till, over what a card can spend in a day', (a) => a.fcFailed({ card: 'limit', left: 5000, need: 9000, limit: 5000, turns: 4102444800, message: 'x' }, { taken: true }));
  add('card: another phone\u2019s card', (a) => a.fcFailed({ card: 'not-owner', message: 'x' }, {}));
  add('card: not a Foxy card, another signer\u2019s', (a) => a.fcFailed({ card: 'wrong-signer', message: 'That card keeps its time by another signer than this Foxy.' }, { taken: true }));
  add('card: a card\u2019s wrong PIN', (a) => a.fcFailed({ card: 'wrong-pin', tries: 2, message: 'Wrong PIN. 2 tries left.' }, { taken: true, again() {} }));
  add('card: a blocked card', (a) => a.fcFailed({ card: 'blocked', message: 'x' }, { taken: true }));
  add('card: not enough on the card', (a) => a.fcFailed({ card: 'not-enough', balance: 900, message: 'The card holds 900 sats.' }, { taken: true }));
  add('card: a card payment not made, no mint', (a) => a.fcFailed({ card: 'no-route', message: 'x' }, { taken: true, again() {} }));
  // a card at another mint than this phone\u2019s: what ADD FUNDS says, by what is on it and whose phone it is (26f-flashcard.js, fcOtherMint)
  const THERE = (over) => Object.assign({ key: '02' + 'a1'.repeat(30) + 'c3d4', balance: 0, count: 0, room: 64, pin: 'set', locked: false,
    hasRecord: true, limit: 0, day: null, owner: true, ownedHere: true, mint: 'https://forge.example/Bitcoin', recoverable: false, mine: false,
    first: 0, last: 0, check: 'none' }, over || {});
  // (a card with money on it, or one on another phone, is loaded at its own mint instead: the fcXlConfirm snapshots)
  add('card: a different mint, adding funds, an empty card, on its owner\u2019s phone', (a) => { a.state.fc = THERE(); a.fcOtherMint('Adding funds'); });
  // money from this phone onto a card at another mint: what is refused before anything is asked (26f-flashcard.js, fcXlOffline, fcXlSend)
  add('card: a card at another mint, loaded with no connection', (a) => a.fcXlOffline());
  add('card: a dollar card at another mint, the amount typed in sats', (a) => a.blockedCard('fc-xl-unit', { tone: 'warn', title: 'A DOLLAR CARD', reason: 'This card holds dollars. Type the amount in dollars.' }));
  add('card: a card at another mint, the melt refused', (a) => a.blockedCard('fc-xl-not', { tone: 'warn', title: 'NOT ON THE CARD', reason: 'The payment could not be routed. Nothing was taken.' }));
  /* A till with no route: a card that cannot pay it (too old to prove its money, unable to, or holding money the mint never
   * signed), and the price a card cannot make exactly. */
  add('card: too old to pay offline', (a) => a.fcFailed({ card: 'offline-old', message: 'This card is too old to pay a phone that is offline. Take this payment when this phone is online.' }, { taken: true }));
  add('card: cannot prove its money offline', (a) => a.fcFailed({ card: 'offline-unproven', message: 'This card cannot prove its money to a phone that is offline. Take this payment when this phone is online.' }, { taken: true }));
  add('card: holds money the mint did not sign', (a) => a.fcFailed({ card: 'fake', message: 'This card holds money the mint did not sign. Nothing was taken.' }, { taken: true }));
  add('card: under a week left, offline', (a) => a.fcFailed({ card: 'renew', message: 'This card\u2019s money runs out in less than 7 days, so this phone cannot take it while offline. Its owner renews it by tapping it on their phone.' }, { taken: true }));
  // a card's payment taken offline that did not settle: spent twice, gone back to its owner, or refused by a mint that changed
  add('card: a card payment went back', (a) => a.cardKeptLostCard({ id: 'card-1', sats: 592, cause: 'unwound', date: 4102444800 }));
  add('card: a card payment not settled', (a) => a.cardKeptLostCard({ id: 'card-1', sats: 592, cause: 'spent', date: 4102444800 }));
  add('card: a card payment not settled, the mint changed', (a) => a.cardKeptLostCard({ id: 'card-1', sats: 592, cause: 'retired', date: 4102444800 }));
  // or the mint would not take the card's signature at all, and a share of a bill it paid is open again
  add('card: a card payment not settled, its signature refused', (a) => a.cardKeptLostCard({ id: 'card-1', sats: 592, cause: 'retired', why: 'signature', date: 4102444800, shares: [0] }));
  // a dollar receive by card with no route, and this phone's price too old to work out the sats from
  /* A dollar receive with no route taps the card for dollars whatever the price (a dollar card pays them), and a bitcoin card,
   * read, is told why it was not asked for its sats: here, a price two days old (26f-flashcard.js, `fcFailed`). */
  add('card: the bitcoin price too old for a dollar receive by card', (a) => a.fcFailed(
    { card: 'wrong-unit', message: 'This card holds bitcoin here, not dollars.', cardUnit: 'sat', askUnit: 'usd' },
    { paying: true, taken: true, offline: true, dollarAsk: true, codeUp: false,
      usd: { cents: 100, bolt11: '', satsWhy: 'old', price: { rate: 64000, at: 1, ageMs: 2 * 86400000 } } }), { wallet: {
    privacy: () => ({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, offline: true, orbot: 'none', vpn: false, orbotKey: false }),
    cardSession: () => Promise.resolve(), cardOnline: () => false, cardOffline: () => true, convertOne: () => Promise.resolve(null),
    lastPrice: () => ({ rate: 64000, at: 1, ageMs: 2 * 86400000 }), priceTooOld: () => true } });
  // its owner's read, online, with under twenty days left: the renewal offered, and its PIN pad
  const RENEW_FC = { key: '02' + 'a1'.repeat(30) + 'c3d4', balance: 2048, count: 12, room: 52, pin: 'set', locked: false, hasRecord: true, setUp: true,
    pinSet: true, limit: 0, owner: true, ownedHere: true, mint: MINT, recoverable: true, mine: true, first: 4102444800, last: 4102444800, check: 'ok',
    // when the mint's word was had, far off and fixed, as the card screens' own views have it
    checkedAt: 4102358400000 };
  const RENEW_W = { cardSession: () => Promise.resolve(), cardOwed: () => [], cardsList: () => [], cardOnline: () => true };
  const RENEW_AT = { wallet: RENEW_W, state: Object.assign({ screen: 'flashcard', stack: [], fc: RENEW_FC }, LIVE) };
  add('card: renew this card, offered at its owner\u2019s read', (a, w) => {
    a._fcRefreshAsked = {};
    // nineteen days before its date, by the page's clock and the app's
    const now = w.Date.now;
    w.Date.now = () => (4102444800 - 19 * 86400) * 1000;
    try { a.fcRefreshMaybe({ key: RENEW_FC.key }); } finally { w.Date.now = now; }
  }, RENEW_AT);
  add('overlay: the renewal\u2019s PIN pad, thirty days', (a) => { a._fcCard = { key: RENEW_FC.key, info: {}, pieces: [] }; a.fcRenew(); }, RENEW_AT);
  add('card: no change while offline', (a) => a.fcFailed({ card: 'inexact', message: 'This phone is offline, so it cannot give change, and this card does not hold pieces that make exactly 1000 sats. Pay an amount it can make, or pay when this phone is online.' }, { taken: true }));
  add('card: change waiting for a card', (a) => a.fcChangeWaiting(212));
  // a card payment is two taps: SEND, then RECEIVE its change, then COMPLETE
  add('card: tap to receive the change of a payment', (a) => a.fcChangeWaiting(212, 1180));
  add('card: a payment cut short, not paid', (a) => a.fcFailed({ card: 'interrupted', owed: 512, made: true, message: 'x' }, { paying: true, taken: true }));
  add('card: change the mint did not make yet', (a) => a.fcChangeLater(824, 200));
  add('card: a payment the card left part way through, not paid yet', (a) => { a.fcHeldClock = () => {}; a.fcHeldCard(1536, '1234', false); });
  add('card: a payment taken up again that the card could not finish', (a) => a.fcShortHeld({ balance: 1, still: 5, torn: 4, letGo: { sats: 72, made: true } }, 77));
  add('card: how a lost card is treated', (a) => a.fcSetUpKind('1234'), { wallet: { cardSession: () => Promise.resolve(), mintHost: () => 'mint.minibits.cash/Bitcoin' } });
  add('card: take a lost card back', (a) => a.fcRowCard({ key: '02' + 'b2'.repeat(30) + '9f0e', sats: 1024, date: 1700000000, due: true, takenBack: 0 }));
  add('card: a payment the mint refused, the card to be tapped again', (a) => a.fcFailed({ card: 'putback', owed: 600, limited: true, message: 'x' }, { paying: true, taken: true }));
  add('card: a payment the mint refused, a card with no limit', (a) => a.fcFailed({ card: 'putback', owed: 88, limited: false, message: 'x' }, { paying: true, taken: true }));
  add('card: a withdrawal the mint refused', (a) => a.fcFailed({ card: 'putback', owed: 1024, limited: true, message: 'x' }, { taken: true }));
  /* A card that holds dollars: the refusals it can meet, said before its PIN, and those of a dollar card asked for sats
   * (26f-flashcard.js, `fcOtherUnit`; the figure it agrees to is the fcOuConfirm screen's, with the confirmations above). */
  add('card error, this card holds dollars', (a) => a.fcFailed({ card: 'wrong-unit', cardUnit: 'usd', message: 'This card holds dollars, so it is paid with the dollars wallet.' },
    { paying: true, taken: true }));
  add('card error, this card holds bitcoin (offline)', (a) => a.fcFailed({ card: 'wrong-unit', cardUnit: 'sat', askUnit: 'usd', message: 'This card holds bitcoin here, not dollars.' },
    { paying: true, taken: true, offline: true, dollarAsk: true, usd: { cents: 100, bolt11: '', satsWhy: 'build' } }));
  add('card error, this card holds bitcoin, before the dollar code', (a) => a.fcFailed({ card: 'wrong-unit', cardUnit: 'sat', askUnit: 'usd', message: 'This card holds bitcoin here, not dollars.' },
    { paying: true, taken: true, dollarAsk: true, codeUp: false, usd: { cents: 100, bolt11: '' } }));
  // (software 1.23: the rate guard, and two of its refusals in their own words, 26f-flashcard.js)
  add('card: the rate guard, a price far from the card\u2019s', (a) => a.fcRateFar({ now: 260000, was: 100000 }, () => {}));
  add('card error, a card of software 1.23 asked for both currencies at once', (a) => a.fcFailed({ card: 'two-units', message: 'The card was asked to pay from both currencies at once. Nothing was taken.' },
    { paying: true, taken: true }));
  add('card error, a new currency on a card, not its owner\u2019s phone', (a) => a.fcFailed({ card: 'owner-unit', message: 'Only the card\u2019s owner can add a new currency to it.' }, {}));
  add('card error, no dollars at this mint', (a) => a.fcFailed({ card: 'no-dollars-here', cardUnit: 'usd', message: 'mint.minibits.cash does not issue dollars now, so this card cannot be used here.' },
    { paying: true, taken: true }));
  const USD_TERMS = { payUnit: 'usd', pay: 592, sats: 7000, rate: 84571, ageMs: 2 * 3600 * 1000, seenAt: 1, own: true, convert: true };
  add('overlay: a dollar card\u2019s PIN, for sats asked, at this phone\u2019s price', (a) => a.fcPayAsk(7000, true, false, null, null, null, USD_TERMS, 'usd'));
  add('overlay: a dollar card\u2019s PIN, for sats asked, at the mint\u2019s rate', (a) => a.fcPayAsk(7000, false, false, null, null, null,
    { payUnit: 'usd', pay: 593, sats: 7000, online: true }, 'usd'));
  add('overlay: a dollar card\u2019s PIN, for a dollar receive', (a) => a.fcPayAsk(0, false, false, null, null, { cents: 475, bolt11: '' }, null, 'usd'));
  const ASKED_OF = { card: 'other-unit', unit: 'usd', asked: 'sat', message: 'This card holds dollars here, not bitcoin.', mint: MINT, pinSet: false, noPinLeft: 0 };
  const PRICED = (over) => Object.assign({ cardSession: () => Promise.resolve(), twoUnits: () => true, mintUnits: () => ['sat', 'usd'],
    lastPrice: () => ({ rate: 84571, at: 1, ageMs: 2 * 3600 * 1000 }), priceTooOld: () => false, unitKeysOffline: () => true,
    centsFor: (n) => ({ sats: n, cents: 592, rate: 84571, at: 1, ageMs: 2 * 3600 * 1000 }), walletChoice: () => ({ hold: 'bitcoin', recv: 'sat', send: 'sat' }) }, over || {});
  add('card: no bitcoin price, for a dollar card', (a) => { a.state.wallet = 'sat'; a.fcOtherUnit(ASKED_OF, 7000, true, null); },
    { wallet: PRICED({ lastPrice: () => ({ rate: 0, at: 0, ageMs: 0 }) }) });
  add('card: the bitcoin price too old, for a dollar card', (a) => { a.state.wallet = 'sat'; a.fcOtherUnit(ASKED_OF, 7000, true, null); },
    { wallet: PRICED({ lastPrice: () => ({ rate: 84571, at: 1, ageMs: 25 * 3600 * 1000 }), priceTooOld: () => true }) });
  add('card: card not taken, no dollar keys seen', (a) => { a.state.wallet = 'sat'; a.fcOtherUnit(ASKED_OF, 7000, true, null); },
    { wallet: PRICED({ unitKeysOffline: () => false }) });
  add('stage: a dollar card asked for sats, the second tap', behind({ amount: '$ 5.92', amountSub: '\u20bf 7,000 at this phone\u2019s price, seen 2 hours ago' }));
  add('card: paid in dollars, the invoice not paid', (a) => a.fcBtcKept({ pay: 593, bolt11: 'lnbc1' }, null, 'The mint could not find a route.'));
  add('card: a dollar card\u2019s payment not settled', (a) => a.cardKeptLostCard({ id: 'card-2', unit: 'usd', amount: 592, sats: 0, cause: 'spent', date: 4102444800 }));
  add('card: a dollar card cannot switch mints with money on it', (a) => { a._fcCard = {}; a.state.fc = { unit: 'usd', balance: 2000, mint: MINT, key: '02' + 'a1'.repeat(30) + 'c3d4' }; a.fcSwitchMint(); },
    { wallet: { cardSession: () => Promise.resolve(), cardOwed: () => [] } });
  add('card: a dollar card cannot pay a bitcoin address', (a) => { a.state.fc = { unit: 'usd', balance: 2000, mint: MINT }; a.fcOutAddress('bc1qexample'); },
    { wallet: { cardSession: () => Promise.resolve(), connected: true } });
  v.push(['importSeed, the words on the phone', at('importSeed', {})]);
  v.push(['importSeed, on the phone, a finished scan', at('importSeed', {
    rsCandidate: 'candidate-1',
    rsRows: [
      { host: 'mint.minibits.cash', state: 'done', sats: 5000 },
      { host: 'down.example.com', state: 'failed' },
      { host: 'partial.example.com', state: 'done', partial: true, sats: 100 },
    ],
  })]);
  // money a card is owed from a payment it made from this phone, said at launch until a tap puts it on (26f-flashcard.js)
  add('card: your card has money waiting', (a) => a.fcMoneyWaiting(),
    { wallet: { cardSession: () => Promise.resolve(), cardOwed: () => [{ id: 'o1', card: '02' + 'a1'.repeat(31), sats: 32, kind: 'change', out: true, payment: 'onchain-q1' }] } });
  return v;
}

// what a view leaves behind on the instance, cleared before the next
const INSTANCE = ['_lastFee', '_returnTo', '_blockedEl', '_blockedKind', '_cardQueue', '_pinEl', '_priceBar', '_priceOff', '_fcExplainer', '_fcCard',
  // (and whether a card's renewal was offered this session, 26f-flashcard.js `fcRefreshMaybe`)
  '_fcRefreshAsked', '_meltEl', '_fcTapO', '_stuckShown', '_stuckOpen', '_mintDownShown', '_quarantineShown', '_armed', '_armedAt',
  // what the send confirmation has asked, and whether it waited (03-send.js `quoteSendFee`, `syncSend`)
  '_quotedFor', '_found', '_feeQuote', '_feeClearedFor', '_askRun', '_sendWaited',
  // which balance paid, and the quotes of both, at a mint with two (03-send.js)
  '_lastPay', '_paying', '_feeQuotes'];

(async () => {
  const { w, errors } = mount();
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(600);
  if (!w.__logic) {
    console.log('FAIL  the app did not mount\n      ' + errors.join(' | '));
    process.exit(1);
  }
  const logic = w.__logic;
  const initial = Object.assign({}, logic.state);
  const baseline = new Set([...w.document.body.children]);
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}

  const screens = [...new Set([...app.matchAll(/sc === '([A-Za-z0-9]+)'/g)].map((m) => m[1]))].sort();
  const popups = Object.keys(initial).filter((k) => /Open$/.test(k) && typeof initial[k] === 'boolean').sort();
  const views = [['home (first render)', {}]]
    .concat(screens.map((s) => ['screen ' + s, { state: { screen: s, stack: [] } }]))
    .concat(popups.map((p) => ['popup ' + p, { state: { screen: 'home', stack: [], [p]: true } }]))
    .concat(representative(logic), cards());

  const recorded = fs.existsSync(path.join(DIR, 'index.json'))
    ? JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')) : {};
  const index = UPDATE ? {} : recorded;
  /* A view keeps the file it was first recorded under, so removing or adding a
   * view renames no other view's file; a new view takes the next number. It
   * used to be the view's place in the list, and removing the
   * page's word screens would have renamed every file after them. */
  let nextNumber = Math.max(-1, ...Object.values(recorded).map((e) => parseInt(e.file, 10)).filter((n) => n >= 0)) + 1;
  const wrote = {};
  const labels = new Set();
  let failed = 0;
  const fail = (msg) => { failed++; console.log('FAIL  ' + msg); };
  if (VALS_DIR) fs.mkdirSync(VALS_DIR, { recursive: true });
  if (UPDATE) fs.mkdirSync(DIR, { recursive: true });

  for (let i = 0; i < views.length; i++) {
    const [label, view] = views[i];
    if (labels.has(label)) { fail('two views are called ' + label); continue; }
    labels.add(label);
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const had0 = recorded[label];
    const file = had0 && /^\d{3}-/.test(had0.file) && had0.file.slice(4) === slug + '.html'
      ? had0.file : String(nextNumber++).padStart(3, '0') + '-' + slug + '.html';
    for (const k of INSTANCE) delete logic[k];
    if (view.wallet) w.FoxyWallet = wallet(view.wallet === true ? null : view.wallet);
    else delete w.FoxyWallet;
    if (view.before) view.before(logic, w);
    if (view.state) {
      // back to a clean slate: what the last view added is cleared, not merged
      const patch = {};
      for (const k of Object.keys(logic.state)) if (!(k in initial)) patch[k] = undefined;
      try { logic.setState(Object.assign(patch, initial, view.state)); } catch (e) { errors.push(label + ': ' + e); }
    }
    const errorsBefore = errors.length;
    if (view.call) {
      try { await view.call(logic, w); } catch (e) { errors.push(label + ': ' + (e && e.stack || e)); }
    }
    await wait(60);
    const root = w.document.getElementById('dc-root');
    const overlays = [...w.document.body.children].filter((el) => !baseline.has(el) && el.localName !== 'script');
    const html = (root ? root.outerHTML : '(no #dc-root)')
      + overlays.map((el) => '\n<!-- on document.body -->\n' + el.outerHTML).join('');
    let vals;
    try { vals = serial(logic.renderVals()); } catch (e) { vals = 'renderVals threw: ' + e; }
    if (VERBOSE && errors.length > errorsBefore) console.log('  errors in ' + label + ':\n    ' + errors.slice(errorsBefore).join('\n    '));
    if (view.call && !overlays.length) fail(label + ': the call drew nothing on document.body');
    for (const el of overlays) el.remove();
    if (view.after) view.after(logic, w);

    const body = '<!-- ' + label + ' -->\n' + html.replace(/></g, '>\n<') + '\n';
    const entry = { file, markup: sha(html), vals: sha(vals) };
    if (VALS_DIR) fs.writeFileSync(path.join(VALS_DIR, file.replace(/\.html$/, '.vals.txt')), vals + '\n');
    if (UPDATE) {
      fs.writeFileSync(path.join(DIR, file), body);
      wrote[label] = entry;
      continue;
    }
    const had = index[label];
    if (!had) { fail(label + ': no snapshot (run with --update)'); continue; }
    const text = fs.existsSync(path.join(DIR, had.file)) ? fs.readFileSync(path.join(DIR, had.file), 'utf8') : null;
    if (had.file !== file) fail(label + ': recorded as ' + had.file + ', now ' + file + ' (the view list changed)');
    else if (had.markup !== entry.markup || text !== body) {
      const a = text || '', b = body;
      let at = 0;
      while (at < a.length && at < b.length && a[at] === b[at]) at++;
      fail(label + ': markup differs from ' + file + ' at ' + at + ':\n        was …' + a.slice(Math.max(0, at - 100), at + 100)
        + '…\n        now …' + b.slice(Math.max(0, at - 100), at + 100) + '…');
    } else if (had.vals !== entry.vals) {
      fail(label + ': the markup is the same, but renderVals() returned something different (compare with --vals DIR before and after)');
    }
  }

  if (UPDATE) {
    for (const f of fs.readdirSync(DIR)) if (f.endsWith('.html') && !Object.values(wrote).some((e) => e.file === f)) fs.unlinkSync(path.join(DIR, f));
    fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(wrote, null, 1) + '\n');
    console.log('wrote ' + Object.keys(wrote).length + ' snapshots to tests/snapshots/render');
    process.exit(0);
  }
  for (const label of Object.keys(index)) if (!labels.has(label)) fail(label + ': in index.json, but no longer a view');
  console.log('');
  console.log(failed ? failed + ' render snapshot check(s) failed of ' + views.length
    : 'all ' + views.length + ' views render byte for byte as recorded');
  process.exit(failed ? 1 : 0);
})();
