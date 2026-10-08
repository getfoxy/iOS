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

function representative() {
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
    hasRecord: true, limit: 0, day: null, owner: true, ownedHere: true, mint: MINT, recoverable: true, mine: true, first: 4102444800, last: 4102444800, check: 'ok' }, over || {});
  // a card with a daily limit of 5,000 sats, 1,200 of it left, and its day turning at a fixed hour far off
  const DAY = { limited: true, limit: 5000, spent: 3800, left: 1200, turns: 4102444800, now: 4102358400, noTime: false };
  // the card's three amounts, on the keypad every amount is typed on
  add('amount, adding to a card', at('amount', { flow: 'cardAdd', amount: '5', unit: 'USD', fc: FC() }, { wallet: CARDS() }));
  add('amount, withdrawing from a card, with all of it under NEXT', at('amount', { flow: 'cardWd', amount: '', unit: 'USD', fc: FC() }, { wallet: CARDS() }));
  add('amount, a card\u2019s daily limit, in sats, with NO LIMIT under NEXT', at('amount', { flow: 'cardLimit', amount: '5000', unit: 'SATS', fc: FC() }, { wallet: CARDS() }));
  add('fcLimitConfirm, a daily limit, to be confirmed', at('fcLimitConfirm', { fc: FC(), fcLimit: { sats: 5000 } }, { wallet: CARDS() }));
  add('fcLimitConfirm, no limit, to be confirmed', at('fcLimitConfirm', { fc: FC(), fcLimit: { sats: 0 } }, { wallet: CARDS() }));
  // a card moved to another mint: the list asking which, and the confirmation as it is asked, answered and refused
  add('switchMint, asking which mint a card moves to', at('switchMint', { fcPick: true, fc: FC() }, { wallet: CARDS() }));
  const MOVE = (over) => Object.assign({ from: MINT, to: OTHER, sats: 2048, plan: null, fee: null, lands: 0, err: '', busy: false }, over || {});
  add('fcMoveConfirm, asking what it costs', at('fcMoveConfirm', { fc: FC(), fcMove: MOVE() }, { wallet: CARDS() }));
  add('fcMoveConfirm, with its cost', at('fcMoveConfirm', { fc: FC(), fcMove: MOVE({ fee: 22, lands: 2026 }) }, { wallet: CARDS() }));
  add('fcMoveConfirm, too little to move', at('fcMoveConfirm', { fc: FC({ balance: 9 }), fcMove: MOVE({ sats: 9, err: 'That is too little to move by Lightning: the fee would take it all.' }) }, { wallet: CARDS() }));
  add('flashcard, nothing tapped', at('flashcard', {}, { wallet: CARDS() }));
  // cards are cash for now (FC_RECOVERABLE), so the list of cards to take back is not drawn: the money waiting is
  add('flashcard, cards loaded and money waiting for one', at('flashcard', {}, { wallet: CARDS({
    cardOwed: () => [{ id: 'o1', card: KEY_A, sats: 1000, kind: 'load' }, { id: 'o2', card: KEY_A, sats: 24, kind: 'change' }],
    cardsList: () => [
      { key: KEY_A, mint: MINT, sats: 2048, date: 4102444800, due: false, takenBack: 0 },
      { key: KEY_B, mint: MINT, sats: 1024, date: 1700000000, due: true, takenBack: 0 },
      { key: KEY_C, mint: MINT, sats: 512, date: 1700000000, due: true, takenBack: 1700000500000 },
    ] }) }));
  add('flashcard, a card of this phone\u2019s, with no limit', at('flashcard', { fc: FC() }, { wallet: CARDS() }));
  add('flashcard, a card with a daily limit, what is left and when the day turns', at('flashcard', { fc: FC({ limit: 5000, day: DAY }) }, { wallet: CARDS() }));
  add('flashcard, a new card', at('flashcard', { fc: FC({ balance: 0, count: 0, room: 64, pin: 'none', hasRecord: false, mint: '', recoverable: false, mine: false, first: 0, last: 0, check: 'none' }) }, { wallet: CARDS() }));
  add('flashcard, a blocked card, on its owner\u2019s phone, with UNBLOCK', at('flashcard', { fc: FC({ pin: 'blocked' }) }, { wallet: CARDS() }));
  add('flashcard, a blocked card, on another phone', at('flashcard', { fc: FC({ pin: 'blocked', ownedHere: false, owner: true }) }, { wallet: CARDS() }));
  add('flashcard, a cash card the mint says is spent', at('flashcard', { fc: FC({ recoverable: false, mine: false, first: 0, last: 0, check: { spent: 1024 } }) }, { wallet: CARDS() }));
  add('flashcard, somebody else\u2019s card, past its date, no connection', at('flashcard', { fc: FC({ mine: false, first: 1700000000, last: 1700000000, check: 'off', locked: true }) }, { wallet: CARDS() }));
  add('home, working offline', at('home', { series: SERIES, range: '1D' }, { wallet: OFFLINE }));
  add('home, a secure connection', at('home', { series: SERIES, range: '1D' }, { wallet: ONLINE }));
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
  add('depConfirm, by card', at('depConfirm', { flow: 'deposit', amount: '10', unit: 'USD', depositVia: 'DEBIT / CREDIT CARD' }));
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
  add('spAssign, contacts, one taken', at('spAssign', { spAmt: '4500', spWays: 3, spIdx: 0, contacts: CONTACTS, spAssigns: [{ type: 'qr' }, { type: 'contact', name: 'Zed', handle: 'zed@example.com', ini: 'Z' }] }));
  add('spWaiting, one of two paid', at('spWaiting', { spAmt: '4500', spWays: 3, spPaid: [true, false], spAssigns: [{ type: 'contact', name: 'Bob', handle: 'bob@walletofsatoshi.com', ini: 'B' }] }));
  add('spWaiting, one left of one', at('spWaiting', { spAmt: '4500', spWays: 2, spPaid: [false] }));
  add('spAllPaid', at('spAllPaid', { spAmt: '4500', spWays: 3, spPaid: [true, true] }));
  // popups and sheets with something in them
  add('note sheet, a note', at('confirm', { noteOpen: true, note: 'for the pizza', invoice: 'lnbc2100n1stub' }));
  add('backup ask', at('home', { bkAskOpen: true }));
  add('settings groups open', at('home', { gPaid: true, gPrefs: true, gAdv: true, gComm: true }));
  return v;
}

/* ---- cards and dialogs, built in plain DOM ------------------------------ */
function cards() {
  const v = [];
  const add = (label, call, over) => v.push([label, Object.assign({ wallet: true, state: Object.assign({ screen: 'home', stack: [] }, LIVE), call }, over || {})]);
  for (const kind of ['sendFail', 'mintRefused', 'netLost', 'lnNoRoute', 'badAddress']) add('card: ' + kind, (a) => a.blockedCard(kind));
  add('card: blocked, a retry and a second button', (a) => a.blockedCard('netLost', { retry: 'RETRY', go() {}, also: { label: 'LATER', tap() {} } }));
  // the tone that asks rather than reports: the Tor banner's card, and SECURE FOXY
  add('card: the Tor banner explains itself', (a) => a.blockedCard('torConnection', {
    tone: 'ask', title: 'TOR CONNECTION',
    reason: 'Tor is a privacy network that hides your IP address while you use Foxy.',
  }));
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
  add('stage: hold the card to the phone', (a) => { a._fcTapO = { amount: '\u20bf 1,180' }; a.fcStage('hold'); });
  add('stage: keep the card there', (a) => { a._fcTapO = { amount: '\u20bf 1,180' }; a.fcStage('mint'); });
  add('stage: checking a card payment', (a) => { a.fcChecking('card-x', { paying: true, taken: true }); clearTimeout(a._fcCheckT); },
    { wallet: { cardSession: () => Promise.resolve(), cardSettle: () => new Promise(() => {}) } });
  // the daily limit's first step, what making this phone a card's owner says, and what a till says when a card cannot cover a payment
  add('card: set daily limit, the warning', (a) => a.fcLimitAsk(() => {}));
  add('card: set up this card, this phone becomes its owner', (a) => a.fcSetUpOwner('1234'));
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
  add('card: a different mint, adding funds, a card that holds money', (a) => { a.state.fc = THERE({ balance: 2048, count: 4 }); a.fcOtherMint('Adding funds'); });
  add('card: a different mint, adding funds, an empty card, on its owner\u2019s phone', (a) => { a.state.fc = THERE(); a.fcOtherMint('Adding funds'); });
  add('card: a different mint, adding funds, an empty card, on another phone', (a) => { a.state.fc = THERE({ ownedHere: false }); a.fcOtherMint('Adding funds'); });
  // a till with no route: taken on trust and not paid, and the price a card cannot make exactly
  add('card: taken on trust, a card payment with no route', (a) => a.fcTrusted({ sats: 592 }));
  add('card: no change while offline', (a) => a.fcFailed({ card: 'inexact', message: 'This phone is offline, so it cannot give change, and this card does not hold pieces that make exactly 1000 sats. Pay an amount it can make, or pay when this phone is online.' }, { taken: true }));
  add('stage: signing piece 3 of 9', (a) => { a._fcTapO = { amount: '\u20bf 1,180' }; a.fcStage('signing'); a.fcLine('Signing piece 3 of 9'); });
  add('card: change waiting for a card', (a) => a.fcChangeWaiting(212));
  // a card payment is two taps: SEND, then RECEIVE its change, then COMPLETE
  add('stage: tap 1 of 2, send', (a) => { a._fcTapO = { amount: '\u20bf 1,180', body: 'Tap 1 of 2: SEND.' }; a.fcStage('hold'); });
  add('card: tap to receive the change of a payment', (a) => a.fcChangeWaiting(212, 1180));
  add('stage: tap 2 of 2, receive', (a) => { a._fcTapO = { body: 'Tap 2 of 2: RECEIVE.' }; a.fcStage('writing'); });
  add('card: a payment complete, its change back on the card', (a) => { a.refreshBalance = () => {}; a.loadHistory = () => {}; a.fcWrote({ card: { balance: 0, info: {}, record: {} }, sats: 212, change: 212, refund: 0, back: 0, left: 0 }, { paid: 1180 }); });
  add('card: a payment cut short, not paid', (a) => a.fcFailed({ card: 'interrupted', owed: 512, made: true, message: 'x' }, { paying: true, taken: true }));
  add('card: change the mint did not make yet', (a) => a.fcChangeLater(824, 200));
  add('card: how a lost card is treated', (a) => a.fcSetUpKind('1234'), { wallet: { cardSession: () => Promise.resolve(), mintHost: () => 'mint.minibits.cash/Bitcoin' } });
  add('card: take a lost card back', (a) => a.fcRowCard({ key: '02' + 'b2'.repeat(30) + '9f0e', sats: 1024, date: 1700000000, due: true, takenBack: 0 }));
  // the card has signed and been let go; the sheet is gone and our own screen waits for the mint
  add('stage: checking with the mint, the card let go', (a) => { a._fcTapO = { amount: '\u20bf 1,180' }; a.fcStage('checking'); a.fcLine('You can remove the card.'); });
  add('stage: making the change, the card let go', (a) => { a._fcTapO = { amount: '\u20bf 1,180' }; a.fcStage('making'); a.fcLine('The payment is made.'); });
  add('card: a payment the mint refused, the card to be tapped again', (a) => a.fcFailed({ card: 'putback', owed: 600, limited: true, message: 'x' }, { paying: true, taken: true }));
  add('card: a payment the mint refused, a card with no limit', (a) => a.fcFailed({ card: 'putback', owed: 88, limited: false, message: 'x' }, { paying: true, taken: true }));
  add('card: a withdrawal the mint refused', (a) => a.fcFailed({ card: 'putback', owed: 1024, limited: true, message: 'x' }, { taken: true }));
  v.push(['importSeed, the words on the phone', at('importSeed', {})]);
  v.push(['importSeed, on the phone, a finished scan', at('importSeed', {
    rsCandidate: 'candidate-1',
    rsRows: [
      { host: 'mint.minibits.cash', state: 'done', sats: 5000 },
      { host: 'down.example.com', state: 'failed' },
      { host: 'partial.example.com', state: 'done', partial: true, sats: 100 },
    ],
  })]);
  return v;
}

// what a view leaves behind on the instance, cleared before the next
const INSTANCE = ['_lastFee', '_returnTo', '_blockedEl', '_blockedKind', '_cardQueue', '_pinEl', '_priceBar', '_priceOff',
  '_meltEl', '_stuckShown', '_mintDownShown', '_quarantineShown', '_armed', '_armedAt'];

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
    .concat(representative(), cards());

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
