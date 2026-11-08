'use strict';
/* mint-names.js — a mint is called by one short name wherever it is shown.
 *
 *     node tests/mint-names.js
 *
 * The keeper's word of 2026-11-07: Forge says FORGE, Minibits and Macadamia lose "mint", TESTNUT is the name of the test
 * mints only. One rule (06-wallet-boot-and-restore.js `shortMintName`, used by `mintNameOf` and the shipped list) serves the
 * mint tiles, HISTORY's title, PAY FROM, the till's lists, TO WHICH MINT? and FROM WHICH MINT?, and a mint's own
 * name (from what it said about itself) is shortened by the same rule.
 *
 * The real page, rendered in jsdom as tests/render-snapshots.js renders it, against a stand-in wallet with seven mints. */
process.env.TZ = 'UTC';
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failed = 0;
let passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || !detail ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name,
  'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));

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


const textOf = (w) => (w.document.getElementById('dc-root') || w.document.body).textContent.replace(/\s+/g, ' ');

const FORGE = 'https://forge.flashapp.me';
const MB = 'https://mint.minibits.cash/Bitcoin';
const MAC = 'https://mint.macadamia.cash';
const NUT = 'https://testnut.cashu.space';
const NUT2 = 'https://nofees.testnut.cashu.space';
const ODD = 'https://mint.westernbtc.com';
const SAID = { [ODD]: 'Mint Western', 'https://kashu.me': 'Mint', 'https://21mint.me': '21mint mint' };
function wallet(w) {
  return {
    connected: true, mintUrl: FORGE, mintHost: () => 'forge.flashapp.me',
    mints: () => [FORGE, MB, MAC, NUT, NUT2, ODD, 'https://kashu.me'],
    mintSaidName: (u) => SAID[String(u).replace(/\/+$/, '')] || '',
    qr: () => '', classify: () => 'unknown', tagsFor: () => ({}), tag() {}, backedUp: () => true, pinIsSet: () => false,
    reason: (e) => String((e && e.message) || e), formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: 25066, mint: FORGE }, { unit: 'sat', amount: 6149, mint: MB }, { unit: 'sat', amount: 52, mint: MAC }],
    balanceAt: () => 25066, balanceSats: () => Promise.resolve(25066), rate: () => Promise.resolve(75000), agreedRate: () => Promise.resolve(75000),
    transactions: () => Promise.resolve([]), book: () => [], remember() {}, listen: () => () => {},
    privacy: () => ({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false, network: 'wifi', orbot: 'none', vpn: false }),
    mintUnits: () => ['sat'], twoUnits: () => false, walletChoice: () => ({ hold: 'sat', recv: '', send: '' }), setWalletChoice() {},
    balanceOf: () => 25066, heldIn: () => 0, recoveringIn: () => 0, lastToken: () => ({}), clearLastToken() {}, pendingMelts: () => [],
    splitPending: () => null, cardSession() {},
  };
}
const tick = () => wait(15);
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

(async () => {
  const { w, errors } = mount();
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  const A = w.__logic;
  if (!A) { console.log('FAIL  the app did not mount\n      ' + errors.join(' | ')); process.exit(1); }
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}
  for (const u of [FORGE, MB, MAC]) w.localStorage.setItem('foxy.cashu.proofs.' + u, JSON.stringify([{ amount: 100 }]));
  w.FoxyWallet = wallet(w);
  A.toast = () => {};
  A.setState({ walletLive: true, balSats: 25066, livePrice: 75000, satUsd: 75000 / 1e8, screen: 'home', stack: [] });
  await settle();
  const V = () => A.renderVals();

  // ---- 1. the shipped names ------------------------------------------------------------------------------------
  eq(A.DEFAULT_MINTS.map((m) => m.name), ['Forge', 'Minibits', 'Macadamia'], 'the shipped list: Forge, Minibits, Macadamia');
  eq([A.mintNameOf(FORGE), A.mintNameOf(MB), A.mintNameOf(MAC)], ['Forge', 'Minibits', 'Macadamia'], 'mintNameOf calls the shipped mints by the same names');

  // ---- 2. the rule on a name a mint gives itself -----------------------------------------------------------------
  const S = (n, u) => A.shortMintName(n, u || 'https://mint.example.com');
  eq(S('Minibits Mint'), 'Minibits', '"Minibits Mint" is Minibits');
  eq(S('Mint Foo'), 'Foo', '"Mint Foo" is Foo (a leading "mint" goes too)');
  eq(S('macadamia Mint'), 'Macadamia', '"macadamia Mint" is Macadamia (title case)');
  eq(S('MACADAMIA MINT'), 'MACADAMIA', 'any case of "mint" goes');
  eq(S('Flash Forge'), 'Forge', '"Flash Forge" is Forge');
  eq(S('Flash Forge', FORGE), 'Forge', '... at its own address too');
  eq(S('Mint', 'https://mint.example.com/x'), 'mint.example.com/x', 'a name that is only "Mint" is the host');
  eq(S('', 'https://mint.example.com'), 'mint.example.com', 'no name at all is the host');
  eq(S('  Minting Co  '), 'Minting Co', 'a word that only starts with "mint" stays');
  eq(S('Cool Mint Mint'), 'Cool', 'a trailing "mint" goes, twice if said twice');
  eq(S('WesternBTC'), 'WesternBTC', 'a name with its own capitals is kept as it is');
  eq([S('Any Name', 'https://testnut.cashu.space'), S('Cashu Test Mint', 'https://nofees.testnut.cashu.space')], ['Testnut', 'Testnut'], 'the testnut hosts are Testnut, whatever they call themselves');
  eq(S('Testnut mint', 'https://mint.example.com'), 'Testnut', 'a name that says "Testnut" off another host is shortened like any other');
  eq(S('Testnut Mint', 'https://mint.example.com/testnut.cashu.space'), 'Testnut', 'only its host decides: path text is not a host');

  // ---- 3. a mint's own name, said to the wallet -----------------------------------------------------------------
  eq(A.mintNameOf(ODD), 'Western', 'a mint that says "Mint Western" is shown as Western');
  eq(A.mintNameOf('https://kashu.me'), 'kashu.me', 'one whose name is only "Mint" is shown by its host');
  eq(A.mintNameOf('https://21mint.me'), '21mint', 'a said name is cut like any other');
  eq([A.mintNameOf(NUT), A.mintNameOf(NUT2)], ['Testnut', 'Testnut'], 'the two testnut hosts are Testnut');
  eq(A.mintNameOf('https://mint.nobody.example/'), 'Nobody', 'a mint with no said name keeps the name made from its address');

  // ---- 4. the tiles --------------------------------------------------------------------------------------------
  {
    A.goSwitchMint();
    await settle();
    eq(V().mintTitle, 'SWITCH MINT', 'the switching screen is titled SWITCH MINT');
    const rows = V().mintRows;
    const big = (h) => (rows.find((r) => r.host === h) || {}).big;
    eq([big('forge.flashapp.me'), big('mint.minibits.cash'), big('mint.macadamia.cash')], ['FORGE', 'MINIBITS', 'MACADAMIA'], 'SWITCH MINT: the tiles say FORGE, MINIBITS, MACADAMIA');
    eq([big('testnut.cashu.space'), big('nofees.testnut.cashu.space')], ['TESTNUT', 'TESTNUT'], 'the test mints say TESTNUT');
    eq(rows.find((r) => r.host === 'forge.flashapp.me').host, 'forge.flashapp.me', 'the host stays under the name');
    ok(rows.find((r) => r.host === 'forge.flashapp.me').initial === 'F' && rows.find((r) => r.host === 'mint.macadamia.cash').initial === 'M', 'the initial is the short name\'s');
    const page = textOf(w);
    ok(!/MINIBITS MINT|MACADAMIA MINT|FLASH FORGE/i.test(page), 'no long name is drawn on the screen', page.slice(0, 300));
    A.back();
    await settle();
    A.setState({ screen: 'switchMint', stack: ['home'], trStep: 'to', trFrom: FORGE });
    await settle();
    eq(V().mintTitle, 'TO WHICH MINT?', 'TRANSFER\'s second question keeps TO WHICH MINT?');
    A.setState({ trStep: 'from' });
    eq(V().mintTitle, 'FROM WHICH MINT?', 'and its first keeps FROM WHICH MINT?');
    A.setState({ screen: 'home', stack: [], trStep: '' });
    await settle();
  }

  // ---- 5. HISTORY's title and WHICH MINT'S HISTORY? -------------------------------------------------------------
  {
    eq([A.histMintName(FORGE), A.histMintName(MB), A.histMintName(MAC), A.histMintName(NUT)], ['FORGE', 'MINIBITS', 'MACADAMIA', 'TESTNUT'], 'HISTORY\'s title is the short name in capitals');
    A.goHistMints();
    await settle();
    const rows = V().mintRows;
    eq(rows.slice(0, 3).map((r) => r.big), ['FORGE', 'MINIBITS', 'MACADAMIA'], 'WHICH MINT\'S HISTORY?: the same short names');
    A.back();
    await settle();
  }

  // ---- 6. PAY FROM and the till's lists --------------------------------------------------------------------------
  {
    eq([A.pfName(FORGE), A.pfName(MB), A.pfName(MAC)], ['FORGE', 'MINIBITS', 'MACADAMIA'], 'PAY FROM names the mints short');
    eq(A.pfLabel(MB, 'sat'), 'MINIBITS · BITCOIN', 'PAYING FROM MINIBITS · BITCOIN');
    eq(A.tillMints().map((m) => m.name).slice(0, 3), ['Forge', 'Minibits', 'Macadamia'], 'the till\'s mint lists carry the short names');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
