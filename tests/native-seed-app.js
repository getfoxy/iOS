'use strict';
/* native-seed-app.js — BACKUP, verify, RESTORE, the new-mint sweep and the
 * wipe ask the phone, and the page has nowhere to show or type the words.
 *
 *     node tests/native-seed-app.js
 *
 * The real template and app class, rendered in jsdom by build/foxy-render.js as
 * render-snapshots.js renders them, against a stand-in wallet that records what
 * the app asks of it. The seed and its words are the phone's, and no words may
 * be asked for or typed into the page: BACKUP, bkStart's button and the backup
 * prompt open the phone's screen (showSeedNative with verify false), verify its
 * quiz (verify true), RESTORE has one button that asks the phone for the words
 * (enterSeedNative) and scans and adopts their candidate, leaving RESTORE
 * forgets it, and the new-mint sweep scans this wallet's own seed with no words.
 * What the wallet does with those is tests/run.js's "seed on the phone" section. */
process.env.TZ = 'UTC';
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8');
const unpack = (uuid) => fs.readFileSync(path.join(ROOT, assets.find((a) => a.uuid === uuid).file), 'utf8');
const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
  const props = JSON.parse(v.replace(/&quot;/g, '"'));
  props.startStatic = { default: true };
  return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
});
const page = markup
  .replace(/<script src="64b433ba-[^"]*"><\/script>/, '')
  .replace(shell.marker, () => open + app + '</script>');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function mount() {
  const vc = new VirtualConsole();
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://foxy.test/index.html', virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.scrollTo = () => {};
  const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
  run(unpack('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047'));
  run(unpack('93c76fbd-259d-463c-a60d-5ed97ad7e690'));
  const dc = w.document.querySelector('script[type="text/x-dc"]');
  run('window.__foxyComponentFactory = function (DCLogic, StreamableLogic, React) {\n' + dc.textContent
    + '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};');
  run('(function(){var f=window.__foxyComponentFactory;window.__foxyComponentFactory=function(a,b,R){'
    + 'var C=f(a,b,R);return class extends C{constructor(p){super(p);window.__logic=this;}};};})();');
  run(RENDERER);
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  if (!w.__logic) throw new Error('the app did not mount');
  return { w, a: w.__logic, baseline: new Set([...w.document.body.children]) };
}

/* The stand-in wallet: every call recorded as [name, ...args], including any
 * call to something it does not have (seedWords, say), so a path that still
 * asked for the words would show up in `calls`. */
function standIn(over) {
  const calls = [];
  const rec = (name, answer) => (...args) => { calls.push([name, ...args]); return typeof answer === 'function' ? answer(...args) : answer; };
  const W = Object.assign({
    calls,
    connected: true,
    mintUrl: 'https://mint.minibits.cash/Bitcoin',
    defaultMint: 'https://mint.minibits.cash/Bitcoin',
    mintHost: () => 'mint.minibits.cash/Bitcoin',
    mints: () => [],
    // what the screens read as they render, as render-snapshots.js's stand-in answers
    qr: () => 'data:image/svg+xml;stub',
    amountOf: () => null,
    classify: () => 'unknown',
    auditTrail: () => [],
    lastToken: () => null,
    tagsFor: () => ({}),
    balances: () => [{ unit: 'sat', amount: 5000, mint: 'https://mint.minibits.cash/Bitcoin' }],
    mintDown: () => null,
    quarantinedSats: () => 0,
    quarantinedUnknown: () => 0,
    tokensNotClaimed: () => Promise.resolve([]),
    transactions: () => Promise.resolve([]),
    balanceSats: () => Promise.resolve(5000),
    pinIsSet: () => false,
    formatAmount: (x, u) => x + ' ' + u,
    unitName: (u) => String(u).toUpperCase(),
    quoteFee: () => new Promise(() => {}),
    agreedRate: () => new Promise(() => {}),
    backedUp: () => false,
    setBackedUp: rec('setBackedUp', true),
    reason: (e) => String((e && e.message) || e),
    proofLockDepth: () => 0,
    showSeedNative: rec('showSeedNative', () => Promise.resolve({ verified: true, revealed: true })),
    enterSeedNative: rec('enterSeedNative', () => Promise.resolve('candidate-1')),
    forgetSeedCandidate: rec('forgetSeedCandidate', () => Promise.resolve(true)),
    scanSeed: rec('scanSeed', (words, urls, each) => {
      const row = { url: urls[0], host: 'mint.minibits.cash', state: 'done', sats: 5000, proofs: [], counters: {} };
      if (each) each(row);
      return Promise.resolve([row]);
    }),
    adoptScan: rec('adoptScan', () => Promise.resolve({ kept: [], skipped: [], units: [] })),
    connect: rec('connect', () => Promise.resolve({ name: 'mint.minibits.cash' })),
    wipeDevice: rec('wipeDevice', () => Promise.resolve({ removed: 3, created: true })),
  }, over || {});
  return new Proxy(W, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? (...args) => { calls.push([k, ...args]); } : undefined)) });
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    const problem = await fn();
    if (problem) { failures.push(name); console.log('FAIL  ' + name + '\n      ' + problem); }
    else { passed++; console.log('ok    ' + name); }
  } catch (e) {
    failures.push(name);
    console.log('THREW ' + name + '\n      ' + (e && e.stack || e));
  }
}
const said = (W, name) => W.calls.filter((c) => c[0] === name);
const asksWords = (W) => W.calls.some((c) => /^seed(Words|OnPhone)$/.test(c[0]));
const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ') : '');

(async () => {
  const { w, a, baseline } = await mount();
  const doc = w.document;
  const overlays = () => [...doc.body.children].filter((el) => !baseline.has(el) && el.localName !== 'script');
  const clear = () => overlays().forEach((el) => el.remove());
  // the innermost element with exactly that text: a wrapper around a button reads the same, and a click on it misses
  const byText = (root, text) => [...root.querySelectorAll('div')].filter((d) => d.textContent === text).pop();
  async function screen(W, state) {
    w.FoxyWallet = W;
    a.setState(Object.assign({ screen: 'home', stack: [], rsRows: [], rsBusy: false, rsCandidate: null, rsPick: null, rsAdopted: false,
      rsErr: '', rsKept: '' }, state));
    await wait(60);
    return doc.getElementById('dc-root');
  }

  await test('BACKUP opens the phone\'s screen, shows no words, and verifies there', async () => {
    const W = standIn({ showSeedNative: undefined });
    let answer = { verified: false };
    W.showSeedNative = (o) => { W.calls.push(['showSeedNative', o]); return Promise.resolve(answer); };
    await screen(W, {});
    clear();
    a.showSeed();
    await wait(30);
    const sheet = overlays()[0];
    if (!sheet) return 'no sheet was drawn';
    const shows = said(W, 'showSeedNative');
    if (shows.length !== 1 || shows[0][1].verify !== false) return 'as it opened: ' + JSON.stringify(shows);
    if (sheet.querySelector('[data-foxy-secret]') || sheet.hasAttribute('data-foxy-seed-screen')) return 'the sheet has a place for the words';
    // its DELETE wipes the wallet, so the lock closes it
    if (!sheet.hasAttribute('data-foxy-close-on-lock')) return 'the sheet stays open over the lock';
    const again = byText(sheet, 'SHOW MY WORDS');
    if (!again) return 'no SHOW MY WORDS: ' + textOf(sheet).slice(0, 200);
    again.click();
    await wait(20);
    if (said(W, 'showSeedNative').length !== 2 || said(W, 'showSeedNative')[1][1].verify !== false) return 'SHOW MY WORDS: ' + JSON.stringify(said(W, 'showSeedNative'));
    answer = { verified: true };
    byText(sheet, 'VERIFY WORDS').click();
    await wait(30);
    const last = said(W, 'showSeedNative').pop();
    if (!last || last[1].verify !== true) return 'VERIFY WORDS: ' + JSON.stringify(last);
    clear();
    return asksWords(W) ? 'the words were asked for' : null;
  });

  await test('verify, bkStart\'s button and the backup prompt ask the phone', async () => {
    const W = standIn();
    await screen(W, { screen: 'bkStart', stack: ['home'] });
    clear();
    a.showVerify();
    await wait(30);
    if (overlays().length) return 'the page drew its own quiz';
    a.renderVals().goBkPhrase();
    await wait(30);
    a.renderVals().bkAskNow();
    await wait(30);
    clear();
    const got = said(W, 'showSeedNative').map((c) => c[1].verify);
    if (JSON.stringify(got) !== '[true,false,false]') return 'showSeedNative verify: ' + JSON.stringify(got);
    if (asksWords(W)) return 'the words were asked for';
    if (said(W, 'setBackedUp').length) return 'the page marked the backup itself';
    return /checked/.test(a.state.toastMsg || '') ? null : 'no word that the phrase was checked: ' + a.state.toastMsg;
  });

  await test('RESTORE has one button for the phone, and no cells to type in', async () => {
    const W = standIn({ enterSeedNative: undefined });
    let typed = null;
    W.enterSeedNative = () => { W.calls.push(['enterSeedNative']); return Promise.resolve(typed); };
    const root = await screen(W, { screen: 'importSeed', stack: ['home'] });
    if (root.querySelectorAll('[data-foxy-secret]').length) return 'RESTORE has a place for the words';
    const button = byText(root, 'ENTER YOUR 12 WORDS');
    if (!button) return 'no ENTER YOUR 12 WORDS: ' + textOf(root).slice(0, 300);
    button.click();                                  // cancelled on the phone
    await wait(40);
    if (said(W, 'enterSeedNative').length !== 1) return 'the button did not ask the phone';
    if (said(W, 'scanSeed').length || a.state.rsErr) return 'a cancel did something: ' + JSON.stringify(W.calls) + ' ' + a.state.rsErr;
    typed = 'candidate-1';
    byText(doc.getElementById('dc-root'), 'ENTER YOUR 12 WORDS').click();
    await wait(60);
    const scans = said(W, 'scanSeed');
    if (scans.length !== 1 || JSON.stringify(scans[0][1]) !== '{"candidate":"candidate-1"}') return 'scan: ' + JSON.stringify(scans);
    if (a.state.rsCandidate !== 'candidate-1') return 'the candidate was not kept: ' + a.state.rsCandidate;
    // tap the mint, then REPLACE AND RESTORE
    a.pickRestoreMint(a.state.rsRows[0]);
    await wait(30);
    a.renderVals().rsConfirmGo();
    await wait(80);
    const adopts = said(W, 'adoptScan');
    if (adopts.length !== 1 || JSON.stringify(adopts[0][2]) !== '{"overwrite":true,"candidate":"candidate-1"}') return 'adopt: ' + JSON.stringify(adopts.map((c) => c[2]));
    if (!said(W, 'connect').length) return 'did not connect after adopting';
    const forgot = said(W, 'forgetSeedCandidate').map((c) => c[1]);
    if (JSON.stringify(forgot) !== '["candidate-1"]') return 'forgotten after adopting: ' + JSON.stringify(forgot);
    return asksWords(W) ? 'the words were asked for' : null;
  });

  await test('leaving RESTORE forgets words entered on the phone, but not under a scan still running', async () => {
    let finish = null;
    const W = standIn({
      enterSeedNative: () => Promise.resolve('candidate-2'),
      scanSeed: (words, urls) => { W.calls.push(['scanSeed', words, urls]); return new Promise((ok) => { finish = ok; }); },
    });
    await screen(W, { screen: 'importSeed', stack: ['home'] });
    a.runSeedScan(false);
    await wait(40);
    if (!finish) return 'no scan started';
    a.back();
    await wait(40);
    if (said(W, 'forgetSeedCandidate').length) return 'forgotten while its scan was still asking';
    finish([]);
    await wait(40);
    const forgot = said(W, 'forgetSeedCandidate').map((c) => c[1]);
    return JSON.stringify(forgot) === '["candidate-2"]' ? null : 'forgotten: ' + JSON.stringify(forgot);
  });

  await test('the new-mint sweep scans the phone\'s seed with no words, and the wipe goes to the wallet', async () => {
    const W = standIn({ mintPile: undefined });
    await screen(W, {});
    a.sweepNewMint('https://new.example.com', 'new.example.com');
    await wait(40);
    const scans = said(W, 'scanSeed');
    if (scans.length !== 1 || scans[0][1] !== null || scans[0][2][0] !== 'https://new.example.com') return 'sweep: ' + JSON.stringify(scans);
    await a.wipeAndRestart(null);
    await wait(20);
    if (said(W, 'wipeDevice').length !== 1) return 'the wipe did not reach the wallet';
    return asksWords(W) ? 'the words were asked for' : null;
  });

  await test('the page has no word grid, quiz or cells: nothing in its markup, values or methods can hold the words', async () => {
    const W = standIn();
    await screen(W, { screen: 'importSeed', stack: ['home'] });
    const vals = a.renderVals();
    const inVals = ['bkWords', 'bkPool', 'bkDots', 'bkPicked', 'rsCells', 'isBkPhrase', 'isBkVerify', 'isBkDone'].filter((k) => k in vals);
    if (inVals.length) return 'renderVals still has ' + inVals.join(', ');
    const inMarkup = ['bkWords', 'bkPool', 'rsCells', 'data-foxy-seed-screen'].filter((k) => markup.includes(k));
    if (inMarkup.length) return 'the markup still has ' + inMarkup.join(', ');
    const methods = ['bkPhrase', 'bkTapWord', 'bkShuffled', 'restoreReady', 'restoreWords', 'seedOnPhone'].filter((k) => typeof a[k] === 'function');
    if (methods.length) return 'the app still has ' + methods.join(', ');
    if (/seedWords|FoxyBip39|BK_PHRASE/.test(app)) return 'the app still names the page\'s words';
    if (/bip39\.js/.test(app.replace(/\/\/[^\n]*/g, ''))) return 'the app still loads bip39.js';
    return null;
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})();
