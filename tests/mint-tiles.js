'use strict';
/* mint-tiles.js — the mint list as tiles, a card's WITHDRAW TO and TRANSFER TO, and the currency tiles.
 *
 *     node tests/mint-tiles.js
 *
 * The keeper's design of 2026-11-06: every list of mints (switching, a transfer's two steps, the till's) is a column of
 * tiles, the mint's name large, its host, a rule, and under it what is held there in every unit and what it comes to in
 * dollars; the mint you are on ticked; ADD A MINT the last tile. A card's WITHDRAW TO and TRANSFER TO are the same tiles,
 * the card's own mint first and ticked, the others with what the crossing costs (FEE, CALCULATING…, NOT AVAILABLE), a tap
 * picking one and NEXT going on. The till's lists of people and codes and BANK ACCOUNT keep their rows. The currency tiles
 * are DOLLARS in frost, BITCOIN in orange and BOTH split, each with its sign faint at the right and its word 40px.
 *
 * The real page, rendered in jsdom by build/foxy-render.js as tests/render-snapshots.js renders it, against a stand-in
 * wallet with three mints. */
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


// ---- the stand-in wallet: three mints, sats at each, dollars at one -------------------------------
const FORGE = 'https://forge.flashapp.me';
const MB = 'https://mint.minibits.cash/Bitcoin';
const MAC = 'https://mint.macadamia.cash';
const PRICE = 75000;                         // dollars per bitcoin: 6,149 sats are $4.61
function wallet(w) {
  const proofs = { [FORGE]: 25066, [MB]: 6149, [MAC]: 52 };
  for (const u of Object.keys(proofs)) w.localStorage.setItem('foxy.cashu.proofs.' + u, JSON.stringify([{ amount: proofs[u] }]));
  const later = {};
  const W = {
    connected: true,
    mintUrl: FORGE,
    mintHost: () => 'forge.flashapp.me',
    mints: () => [FORGE, MB, MAC],
    qr: (text) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)),
    classify: () => 'unknown',
    tagsFor: () => ({}),
    tag() {},
    backedUp: () => true,
    pinIsSet: () => false,
    reason: (e) => String((e && e.message) || e),
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: 25066, mint: FORGE }, { unit: 'usd', amount: 1033, mint: FORGE },
      { unit: 'sat', amount: 6149, mint: MB }, { unit: 'sat', amount: 52, mint: MAC }],
    balanceAt: () => 25066,
    balanceSats: () => Promise.resolve(25066),
    rate: () => Promise.resolve(PRICE),
    agreedRate: () => Promise.resolve(PRICE),
    transactions: () => Promise.resolve([]),
    book: () => [],
    remember() {},
    listen: () => () => {},
    privacy: () => ({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false, network: 'wifi', orbot: 'none', vpn: false }),
    mintUnits: () => ['sat', 'usd'],
    twoUnits: () => true,
    walletChoice: () => ({ hold: 'both', recv: '', send: '' }),
    setWalletChoice() {},
    balanceOf: (u) => (u === 'usd' ? 1033 : 25066),
    heldIn: () => 0,
    recoveringIn: () => 0,
    lastToken: () => ({}),
    clearLastToken() {},
    pendingMelts: () => [],
    splitPending: () => null,
    cardSession() {},
    // a crossing's cost, asked and answered when a check says so
    transferQuote: (from, sats, q) => new Promise((res, rej) => { later[q.to] = { res, rej }; }),
  };
  W.later = later;
  return W;
}

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
  const W = wallet(w);
  w.FoxyWallet = W;
  let toasts = [];
  A.toast = (m) => { toasts.push(String(m)); };
  const V = () => A.renderVals();
  A.setState({ walletLive: true, balSats: 25066, livePrice: PRICE, satUsd: PRICE / 1e8, screen: 'home', stack: [] });
  await settle();
  const hostOf = (r) => r.host;
  const clickLabel = (label) => {
    const el = w.document.querySelector('[aria-label="' + label + '"]');
    if (el) el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return !!el;
  };

  // ---- 1. SWITCH: titled SWITCH MINT, a tile a mint, the one you are on first and ticked, ADD A MINT last --------------
  {
    A.goSwitchMint();
    await settle();
    const v = V();
    ok(v.mintTitle === 'SWITCH MINT' && v.mintTilesShown === true && v.mintRowsShown === false && v.mintNowShown === false,
       'switching: SWITCH MINT, drawn as tiles, no line under the title', JSON.stringify([v.mintTitle, v.mintTilesShown, v.mintNowLine]));
    const rows = v.mintRows;
    eq(rows.slice(0, 3).map(hostOf), ['forge.flashapp.me', 'mint.minibits.cash', 'mint.macadamia.cash'], 'the mint you are on first, then the others');
    ok(rows[0].here === true && rows[0].border === 'var(--acc)' && rows[0].edge === '2px' && rows.slice(1).every((r) => !r.here && r.edge === '1px'),
       'the mint you are on ticked, in the accent with a 2px edge; the others not', JSON.stringify(rows.map((r) => [r.here, r.border, r.edge])));
    const mb = rows[1];
    ok(mb.big === 'MINIBITS' && mb.nameSize === '38px' && mb.hostSize === '17px' && mb.radius === '28px',
       'a tile: the name in capitals at 38px, the host at 17px', JSON.stringify([mb.big, mb.nameSize, mb.hostSize, mb.radius]));
    ok(mb.lineBal === true && mb.balSym === true && mb.balMain === '6,149' && mb.balAbout === '≈ $4.61' && !mb.lineFee && !mb.lineWait,
       'under its rule: the sat sign, 6,149, and ≈ $4.61', JSON.stringify([mb.balMain, mb.balAbout]));
    ok(rows[0].balMain === '25,066 + $10.33' && rows[0].balAbout === '≈ $29.13',
       'a mint with two balances: 25,066 + $10.33 ≈ $29.13', JSON.stringify([rows[0].balMain, rows[0].balAbout]));
    const page = textOf(w);
    ok(/SWITCH MINT/.test(page) && !/TO WHICH MINT/.test(page) && /MINIBITS/.test(page) && /6,149/.test(page) && /≈ \$4\.61/.test(page) && /ADD A MINT/.test(page)
       && !/ADD MINT BY URL/.test(page) && !/ADD MINT BY QR/.test(page),
       'drawn: the title, the tiles with their balances, and ADD A MINT in place of the two old buttons', page.slice(0, 300));
    let typed = 0, scanned = 0;
    const t0 = A.typeMint, s0 = A.scanOtherMint;
    A.typeMint = () => { typed += 1; };
    A.scanOtherMint = () => { scanned += 1; };
    clickLabel('Add a mint');
    clickLabel('Scan a mint');
    ok(typed === 1 && scanned === 1, 'ADD A MINT opens the address sheet, and its scan button the scanner', JSON.stringify({ typed, scanned }));
    A.typeMint = t0; A.scanOtherMint = s0;
    // busy: CONNECTING… in grey where the balance was
    A.setState({ mintBusy: MB });
    await settle();
    const busy = V().mintRows[1];
    ok(busy.lineWait === true && busy.wait === 'CONNECTING…' && busy.lineBal === false, 'a mint being connected to says CONNECTING… under its rule', JSON.stringify(busy));
    A.setState({ mintBusy: '' });
  }

  // ---- 2. a transfer's two steps: FROM WHICH MINT? and TO WHICH MINT?, as tiles, no ADD A MINT --------------------
  {
    A.goTransfer();
    await settle();
    let v = V();
    ok(v.mintTitle === 'FROM WHICH MINT?' && v.mintTilesShown && !v.mintPickers && v.mintRows.length === 3 && v.mintRows.every((r) => r.lineBal),
       'TRANSFER MONEY: FROM WHICH MINT?, tiles with balances, no ADD A MINT', JSON.stringify([v.mintTitle, v.mintRows.map(hostOf)]));
    A.setState({ trStep: 'to', trFrom: FORGE });
    await settle();
    v = V();
    ok(v.mintTitle === 'TO WHICH MINT?' && v.mintTilesShown && v.mintRows.map(hostOf).indexOf('forge.flashapp.me') < 0,
       'then TO WHICH MINT?, every mint but the one it leaves', JSON.stringify(v.mintRows.map(hostOf)));
  }

  // ---- 3. a card's TRANSFER TO: the card's mint first and ticked, a tap picks, NEXT moves --------------------------
  {
    A.setState({ screen: 'home', stack: [], fc: { key: 'k1', mint: MB, balance: 2000, unit: 'sat' } });
    A.fcMoveAsk();
    await settle();
    let v = V();
    ok(v.mintTitle === 'TRANSFER TO' && v.mintNowLine === 'This card is at ' + A.mintNameOf(MB) + '. Other mints cost a Lightning fee.' && v.mintNowShown,
       'TRANSFER TO, and the line: where the card is, and that other mints cost a Lightning fee', JSON.stringify([v.mintTitle, v.mintNowLine]));
    ok(v.mintRows[0].host === 'mint.minibits.cash' && v.mintRows[0].here === true && v.mintRows.slice(1).every((r) => !r.here)
       && v.mintRows.every((r) => !r.lineBal) && !v.mintRows[0].lineFee && !v.mintRows[0].lineWait && v.mintRows[0].nameSize === '32px' && v.mintRows[0].hostSize === '16px',
       'the card’s own mint first, ticked, no line under it; no balance lines; names 32px', JSON.stringify(v.mintRows.map((r) => [r.host, r.here])));
    ok(v.mintRows.slice(1).every((r) => r.lineWait && r.wait === 'CALCULATING\u2026') && !!W.later[FORGE] && !!W.later[MAC] && !W.later[MB],
       'each other mint is asked what the move costs, CALCULATING\u2026 meanwhile; the card\u2019s own is not asked', JSON.stringify(v.mintRows.map((r) => r.wait)));
    W.later[FORGE].res({ feeSats: 67 });
    W.later[MAC].rej(new Error('macadamia is not answering'));
    await settle();
    v = V();
    const fo = v.mintRows.find((r) => r.host === 'forge.flashapp.me');
    const ma = v.mintRows.find((r) => r.host === 'mint.macadamia.cash');
    ok(fo.lineFee && fo.fee === 'FEE $0.05' && ma.lineWait && ma.wait === 'NOT AVAILABLE' && ma.dim === '0.4',
       'an answer: FEE $0.05; one that did not answer: NOT AVAILABLE, greyed', JSON.stringify([fo.fee, ma.wait, ma.dim]));
    toasts = [];
    ma.tap();
    await settle();
    ok(!V().mintRows.find((r) => r.host === 'mint.macadamia.cash').here && toasts.some((t) => /not answering/.test(t)), 'one that did not answer says why and is not picked', JSON.stringify(toasts));
    ok(v.tillNextShown === true && v.tillNextBg !== 'var(--acc)' && !v.mintPickers, 'NEXT at the foot, grey while the card’s own mint is the one picked', v.tillNextBg);
    let picked = '';
    const sp = A.fcSwitchPick;
    A.fcSwitchPick = (u) => { picked = u; };
    toasts = [];
    v.tillNext();
    ok(!picked && toasts.some((t) => /Pick the mint to move it to/.test(t)), 'NEXT with the card’s own mint says to pick another, and moves nothing', JSON.stringify(toasts));
    v.mintRows.find((r) => r.host === 'forge.flashapp.me').tap();
    await settle();
    v = V();
    ok(v.mintRows.find((r) => r.host === 'forge.flashapp.me').here === true && v.mintRows[0].here === false && v.tillNextBg === 'var(--acc)',
       'a tap moves the tick to that mint, and NEXT lights', JSON.stringify(v.mintRows.map((r) => [r.host, r.here])));
    ok(A.state.screen === 'switchMint' && !picked, 'and nothing moves on the tap alone');
    v.tillNext();
    ok(picked === FORGE, 'NEXT moves the card to the mint picked (`fcSwitchPick`)', picked);
    A.fcSwitchPick = sp;
  }

  // ---- 3b. TRANSFER TO asks only the mints this phone uses; AS BITCOIN only where dollars do not stay dollars ----------
  {
    for (const k of Object.keys(W.later)) delete W.later[k];
    const tm = A.tillMints, mu = W.mintUnits;
    // macadamia never used by this phone: not asked (a quote is not made at a mint it has never used)
    A.tillMints = () => A.allMints().filter((m) => m.url !== MAC);
    // forge issues dollars, minibits does not
    W.mintUnits = (u) => (String(u).indexOf('forge') >= 0 ? ['sat', 'usd'] : ['sat']);
    A.setState({ screen: 'home', stack: [], fc: { key: 'k2', mint: MB, balance: 500, unit: 'usd' } });
    A.fcMoveAsk();
    await settle();
    ok(!!W.later[FORGE] && !W.later[MB] && !W.later[MAC], 'TRANSFER TO asks only the mints this phone uses (`tillMints`)', JSON.stringify(Object.keys(W.later)));
    A.setState({ fc: { key: 'k2', mint: FORGE, balance: 500, unit: 'usd' } });
    for (const k of Object.keys(W.later)) delete W.later[k];
    A.tillMints = () => A.allMints();
    A.fcMoveAsk();
    await settle();
    W.later[MB].res({ feeSats: 3 });
    W.later[MAC].res({ feeSats: 3 });
    await settle();
    const v = V();
    const mb = v.mintRows.find((r) => r.host === 'mint.minibits.cash');
    ok(mb.lineFee && mb.feeNote === 'AS BITCOIN' && mb.feeNoteShown, 'a dollar card to a mint with no dollars: AS BITCOIN', JSON.stringify(mb.feeNote));
    W.mintUnits = (u) => (String(u).indexOf('macadamia') >= 0 ? ['sat', 'usd'] : ['sat']);
    A.setState({ wdQuotes: Object.assign({}, A.state.wdQuotes) });
    await settle();
    const ma = V().mintRows.find((r) => r.host === 'mint.macadamia.cash');
    ok(ma.lineFee && !ma.feeNoteShown && ma.feeNote === '', 'a dollar card to a mint that issues dollars: no AS BITCOIN (it stays dollars there)', JSON.stringify(ma.feeNote));
    A.tillMints = tm; W.mintUnits = mu;
  }

  // ---- 4. a card's WITHDRAW TO: the fee under each rule, CALCULATING… while asked, NOT AVAILABLE ---------------------
  {
    A.setState({ screen: 'amount', stack: ['home', 'flashcard'], fc: { key: 'k1', mint: FORGE, balance: 3000, unit: 'sat' } });
    const fu = A.fcUnit, fh = A.fcHeld;
    A.fcUnit = () => 'sat';
    A.fcHeld = (fc) => fc.balance;
    let went = 0;
    const asked = A.fcWdToAsk(() => { went += 1; });
    await settle();
    let v = V();
    ok(asked === true && v.mintTitle === 'WITHDRAW TO' && v.mintNowLine === 'This card is at ' + A.mintNameOf(FORGE) + '. Other mints cost a Lightning fee.',
       'WITHDRAW TO, and the line under it', JSON.stringify([v.mintTitle, v.mintNowLine]));
    ok(v.mintRows[0].host === 'forge.flashapp.me' && v.mintRows[0].here && !v.mintRows[0].lineFee && !v.mintRows[0].lineWait && !v.mintRows[0].lineBal
       && v.mintRows[0].bg === 'rgba(var(--acc-rgb),.12)' && v.mintRows[0].edge === '2px',
       'the card’s own mint first: ticked, filled, a 2px accent edge, no line', JSON.stringify(v.mintRows[0]));
    ok(v.mintRows.slice(1).every((r) => r.lineWait && r.wait === 'CALCULATING…' && !r.lineFee), 'the others CALCULATING… while they are asked',
       JSON.stringify(v.mintRows.map((r) => r.wait)));
    toasts = [];
    v.mintRows[1].tap();
    await settle();
    ok(toasts.some((t) => /Still asking/.test(t)) && V().mintRows[0].here, 'a mint still being asked is not picked, and says so', JSON.stringify(toasts));
    W.later[MB].res({ feeSats: 67 });
    W.later[MAC].rej(new Error('macadamia is not answering'));
    await settle();
    v = V();
    const mb = v.mintRows.find((r) => r.host === 'mint.minibits.cash');
    const mac = v.mintRows.find((r) => r.host === 'mint.macadamia.cash');
    ok(mb.lineFee && mb.fee === 'FEE $0.05' && !mb.lineWait, 'an answer: FEE $0.05 under its rule', JSON.stringify(mb));
    ok(mac.lineWait && mac.wait === 'NOT AVAILABLE' && mac.dim === '0.4' && v.mintRows[2] === mac, 'one that did not answer: NOT AVAILABLE, greyed, last', JSON.stringify(mac));
    ok(v.tillNextShown && v.tillNextBg === 'var(--acc)', 'NEXT at the foot, lit: the card’s own mint is a place to withdraw to');
    mb.tap();
    await settle();
    v = V();
    ok(v.mintRows.find((r) => r.host === 'mint.minibits.cash').here && !v.mintRows[0].here && went === 0, 'a priced mint tapped takes the tick; nothing goes yet');
    v.tillNext();
    await settle();
    ok(went === 1 && A._fcWdTo === MB.replace(/\/+$/, '') && !A.state.wdPick, 'NEXT goes on with it: off the list, to the PIN', JSON.stringify([went, A._fcWdTo]));
    A.fcUnit = fu; A.fcHeld = fh;
  }

  // ---- 4b. the fee's words: under a cent, no price, a dollar card's ------------------------------------------------
  {
    let f = A.fcFeeLine({ state: 'ok', fee: 1 }, 'sat', {});
    ok(f.fee === 'FEE < $0.01' && f.lineFee && !f.feeNoteShown, 'a fee under half a cent: FEE < $0.01', f.fee);
    f = A.fcFeeLine({ state: 'ok', fee: 3 }, 'usd', {});
    ok(f.fee === 'FEE $0.03' && f.feeNote === 'AS BITCOIN' && f.feeNoteShown && f.text === 'FEE $0.03 \u00b7 AS BITCOIN',
       'a dollar card: FEE $0.03, and AS BITCOIN smaller beside it', JSON.stringify(f));
    ok(!A.fcFeeLine(null, 'sat', {}).lineFee && !A.fcFeeLine(null, 'sat', {}).lineWait, 'a mint not asked: no line');
    const pr = A.px;
    A.px = () => null;
    f = A.fcFeeLine({ state: 'ok', fee: 42 }, 'sat', {});
    ok(f.fee === 'FEE \u20bf 42', 'no price: the fee in sats', f.fee);
    A.px = pr;
  }

  // ---- 4c. the till's lists of mints are tiles too -----------------------------------------------------------------------
  {
    A.goSwitchMint({ tillPick: 'set', tillSet: [FORGE] });
    await settle();
    let v = V();
    ok(v.mintTitle === 'TILL AT WHICH MINTS?' && v.mintTilesShown && v.mintRows.length > 0 && v.mintRows.every((r) => r.lineBal && r.big)
       && !v.mintPickers && v.tillNextShown, 'TILL AT WHICH MINTS?: tiles with balances, NEXT, no ADD A MINT', JSON.stringify([v.mintTitle, v.mintRows.map(hostOf)]));
    A.setState({ tillPick: 'default' });
    await settle();
    v = V();
    ok(v.mintTitle === 'DEFAULT MINT' && v.mintTilesShown, 'DEFAULT MINT: tiles', v.mintTitle);
    const title = [...w.document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'DEFAULT MINT' && !d.querySelector('div'));
    const row = title && title.parentElement;
    ok(!!row && row.style.position === 'relative' && row.style.justifyContent === 'center' && /absolute/.test(row.firstElementChild.style.position),
       'the header as designed: the back button set apart, the title centred across the row', row ? row.getAttribute('style') : 'no title');
  }

  // ---- 4d. a phone on no mint is told so --------------------------------------------------------------------------------
  {
    const mh = W.mintHost;
    W.mintHost = () => '';
    A.goSwitchMint();
    await settle();
    ok(V().mintNowShown && V().mintNowLine === 'Connected to no mint.', 'no mint: the line says so', V().mintNowLine);
    W.mintHost = mh;
    A.goSwitchMint();
    await settle();
    ok(!V().mintNowShown, 'on a mint: no line');
  }

  // ---- 5. the lists that are not of mints keep their rows ------------------------------------------------------------
  {
    A.goSwitchMint({ bankPick: true });
    await settle();
    const v = V();
    ok(v.mintTilesShown === false && v.mintRowsShown === true, 'BANK ACCOUNT keeps its rows', JSON.stringify([v.mintTitle]));
  }

  // ---- 6. the currency tiles: DOLLARS in frost, BITCOIN in orange, BOTH split, each sign faint, the word 40px --------
  {
    A.setState({ screen: 'currency', stack: ['home'], currencyFlow: 'card', curCard: null, curBoth: true });
    await settle();
    const v = V();
    const [d, b, both] = v.curCards;
    ok(v.curCards.map((k) => k.name).join() === 'DOLLARS,BITCOIN,BOTH', 'three tiles: DOLLARS, BITCOIN, BOTH', v.curCards.map((k) => k.name).join());
    ok(d.bg.indexOf('#D6EEF4') >= 0 && d.bg.indexOf('#BFE3EC') >= 0 && d.sign === '$' && d.signOne && !d.signTwo && d.ink === '#0F2A33',
       'DOLLARS: the light blue, a big $ at the right', JSON.stringify([d.bg, d.sign]));
    ok(b.bg.indexOf('#EB6A2E') >= 0 && b.sign === '₿' && b.signOne && b.ink === '#1A0A02', 'BITCOIN: the orange, a big ₿ at the right', JSON.stringify([b.bg, b.sign]));
    ok(both.bg.indexOf('#BFE3EC 49.8%') >= 0 && both.bg.indexOf('#EB6A2E 50.2%') >= 0 && both.signTwo && !both.signOne && both.signA === '$' && both.signB === '₿',
       'BOTH: split blue and orange, both signs', JSON.stringify([both.bg]));
    ok(v.curCards.every((k) => k.labelPx === '40px' && k.radius === '30px'), 'each word 40px, each tile rounded 30px');
    ok(v.curAskBelow === true && v.curAskAbove === false && v.curQuestion === 'What will this card hold?', 'the question in grey under the rule');
    const page = textOf(w);
    ok(/What will this card hold\?/.test(page) && /DOLLARS/.test(page) && /BOTH/.test(page), 'drawn', page.slice(0, 200));
    A.setState({ screen: 'home', stack: [], currencyFlow: '', curBoth: false });
  }

  // ---- 7. CURRENCIES, the question of what to hold, in the same tiles -----------------------------------------------------
  {
    A.setState({ screen: 'holdChoice', stack: ['home'], holdPick: 'bitcoin' });
    await settle();
    const r = V().holdRows;
    ok(r.map((h) => h.name).join() === 'DOLLARS,BITCOIN,BOTH' && r[0].bg.indexOf('#D6EEF4') >= 0 && r[0].sign === '$' && r[0].signOne
       && r[1].bg.indexOf('#EB6A2E') >= 0 && r[1].sign === '\u20bf' && r[2].signTwo && !r[2].signOne && r.every((h) => h.labelPx === '40px' && h.radius === '30px'),
       'the three choices in the currency tiles: blue, orange, split, each sign faint, the word 40px', JSON.stringify(r.map((h) => [h.name, h.sign])));
    ok(r[1].outline !== 'none' && r[0].outline === 'none' && typeof V().holdDone === 'function', 'the chosen one outlined, DONE kept');
    ok(/Steady\. For spending\./.test(textOf(w)), 'each with its line', textOf(w).slice(0, 200));
    // the header as every set-up screen has it: the title beside the back button, the divider, then the mint line as the subtitle
    {
      const root = w.document.querySelector('[data-template="hold"]');
      const row = root && root.children[0];
      const rule = root && root.children[1];
      const kids = row ? Array.from(row.children) : [];
      ok(kids.length === 3 && /CURRENCIES/.test(kids[1].textContent) && kids[1].style.fontSize === '22px' && kids[2].style.width === '52px',
         'CURRENCIES sits beside the back button, 22px, with the 52px spacer', row && row.textContent);
      ok(rule && rule.style.height === '1px' && /^At /.test(rule.nextElementSibling.textContent.trim()), 'the divider comes before the mint line, the subtitle', rule && rule.nextElementSibling && rule.nextElementSibling.textContent);
      ok(!Array.from(root.querySelectorAll('div')).some((d) => d.style.fontSize === '34px'), 'no 34px title is left');
    }
    // the chosen tile: the ring and the tick PAY FROM gives its chosen source, the others dimmed, for each of the three choices
    for (const [pick, ring, tickBg] of [['dollars', 'var(--acc)', 'var(--acc)'], ['bitcoin', '#FFFFFF', '#FFFFFF'], ['both', '#FFFFFF', '#FFFFFF']]) {
      A.setState({ screen: 'holdChoice', stack: ['home'], holdPick: pick });
      await settle();
      const rr = V().holdRows;
      const at = rr.findIndex((h) => h.key === undefined ? h.name.toLowerCase() === pick : false);
      ok(at >= 0 && rr.every((h, i) => (i === at) === !!h.pickOn), pick + ': exactly that tile is marked chosen');
      ok(rr[at].outline === '4px solid ' + ring && rr[at].opacity === '1' && /0 0 0 3px rgba\(0,0,0,\.55\)/.test(rr[at].shadow) && rr[at].tickBg === tickBg, pick + ': a 4px ring, a dark halo and a tick', JSON.stringify(rr[at]));
      ok(rr.every((h, i) => i === at || (h.outline === 'none' && h.opacity === '.55' && h.shadow.indexOf('0 0 0 3px') < 0)), pick + ': the others have no ring and are dimmed');
      const tiles = w.document.querySelectorAll('[data-template="hold"] [role="button"][aria-label]');
      const ticks = w.document.querySelectorAll('[data-hold-tick]');
      ok(ticks.length === 1 && tiles[at].contains(ticks[0]), pick + ': one tick drawn, on the chosen tile');
    }
    A.setState({ screen: 'home', stack: [], holdPick: '' });
  }

  const real = errors.filter((e) => !/Not implemented|navigation/i.test(e));
  ok(real.length === 0, 'no errors in the page', real.slice(0, 3).join(' | '));
  console.log('\n' + (failed ? passed + ' passed, ' + failed + ' failed' : 'all ' + passed + ' mint tile checks pass'));
  process.exit(failed ? 1 : 0);
})();
