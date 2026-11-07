'use strict';
/* history-mint.js — HISTORY by mint: the mint's name for the title, a chevron to change mints, and the books where they belong.
 *
 *     node tests/history-mint.js
 *
 * The keeper's words of 2026-11-06: the history screen says the mint's name in the place of HISTORY, with a chevron that
 * makes it easy to change between mints' histories; and "if audit adds up put it at the end of the history screen. If it
 * doesn't then it's above."
 *
 *   1  HISTORY opens at the mint this phone is on, titled with its name as the mint list names it, a chevron after it
 *   2  the title opens the mint list as tiles, the mint shown ticked, no ADD A MINT, a line that says the wallet stays
 *   3  another mint picked: its rows only, its own books, one balance and no tabs; the wallet's mint is not changed
 *   4  the books: at the end when they add up, at the top when they do not, per mint and per tab
 *   5  a mint with no history: the empty state
 *   4b change not collected and change to hand over: at the top, red, with their button, at the connected mint and another
 *   6c another mint's rows that cannot be read: the empty state, not a blank list
 *   6d the list left: SWITCH and TRANSFER are their own lists again; a mint out of reach is not greyed for history
 *   6  HISTORY opened again starts at the mint this phone is on; a card's own HISTORY is untouched
 *   8  the wallet's figures set aside, at a mint named and, with none named, at the mint the real wallet is on
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
  const logs = [];
  const vc = new VirtualConsole();
  vc.on('log', (...a) => logs.push(a.map(String).join(' ')));
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
  return { dom, w, errors, logs };
}


// ---- the stand-in wallet: three mints; Forge (on) with both balances, Minibits with sats, macadamia with nothing ----------
const FORGE = 'https://forge.flashapp.me';
const MB = 'https://mint.minibits.cash/Bitcoin';
const MAC = 'https://mint.macadamia.cash';
const PRICE = 75000;
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const row = (hash, mint, dir, sats, extra) => Object.assign({ hash, mint, dir, sats, settled: true, state: 'paid', at: NOW - 3600, memo: '' }, extra || {});
function wallet(w) {
  const bal = { [FORGE]: { sat: 25066, usd: 1033 }, [MB]: { sat: 6149, usd: 0 }, [MAC]: { sat: 0, usd: 0 } };
  for (const u of Object.keys(bal)) w.localStorage.setItem('foxy.cashu.proofs.' + u, JSON.stringify(bal[u].sat ? [{ amount: bal[u].sat }] : []));
  const txs = [
    row('f-in-1', FORGE, 'in', 20000, { memo: 'Forge rent' }),
    row('f-in-2', FORGE, 'in', 5066, { memo: 'Forge lunch', at: NOW - 2 * DAY }),
    row('f-usd-1', FORGE, 'in', 0, { unit: 'usd', amount: 1033, memo: 'Forge dollars' }),
    row('m-in-1', MB, 'in', 6000, { memo: 'Minibits coffee' }),
    row('m-in-2', MB, 'in', 149, { memo: 'Minibits tip', at: NOW - 2 * DAY }),
  ];
  const strip = (u) => String(u || '').replace(/\/+$/, '');
  const at = (m) => bal[strip(m) || W.mintUrl] || { sat: 0, usd: 0 };
  const W = {
    bal, txs,
    connected: true,
    mintUrl: FORGE,
    mintHost: () => String(W.mintUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    mints: () => [FORGE, MB, MAC],
    switches: 0,
    switchTo() { W.switches += 1; return Promise.resolve({}); },
    connect() { W.switches += 1; return Promise.resolve({}); },
    qr: (text) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(text).slice(0, 24)),
    classify: () => 'unknown',
    tagsFor: () => ({}),
    tag() {},
    backedUp: () => true,
    pinIsSet: () => false,
    reason: (e) => String((e && e.message) || e),
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [].concat(...Object.keys(bal).map((m) => [{ unit: 'sat', amount: bal[m].sat, mint: m }].concat(bal[m].usd ? [{ unit: 'usd', amount: bal[m].usd, mint: m }] : []))),
    balanceAt: () => at().sat,
    balanceSats: () => Promise.resolve(at().sat),
    balanceOf: (u, m) => (u === 'usd' ? at(m).usd : at(m).sat),
    rate: () => Promise.resolve(PRICE),
    agreedRate: () => Promise.resolve(PRICE),
    transactions: () => Promise.resolve(txs.slice()),
    book: () => [],
    remember() {},
    listen: () => () => {},
    privacy: () => ({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false, network: 'wifi', orbot: 'none', vpn: false }),
    mintUnits: (m) => (strip(m || W.mintUrl) === FORGE ? ['sat', 'usd'] : ['sat']),
    twoUnits: (m) => strip(m || W.mintUrl) === FORGE,
    walletChoice: () => ({ hold: 'both', recv: '', send: '' }),
    setWalletChoice() {},
    heldSats: () => 0,
    heldIn: () => 0,
    recoveringIn: () => 0,
    recoveringSats: () => 0,
    topUpFeeSats: () => 0,
    meltingIn: () => 0,
    arriving: () => [],
    lastToken: () => ({}),
    clearLastToken() {},
    pendingMelts: () => [],
    splitPending: () => null,
    cardSession() {},
    cardOwed: () => [],
  };
  return W;
}

const tick = () => wait(15);
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
const textOf = (w) => (w.document.getElementById('dc-root') || w.document.body).textContent.replace(/\s+/g, ' ');
const names = (v) => [].concat(...(v.historyGroups || []).map((g) => g.items.map((t) => t.name)));

(async () => {
  const { w, errors, logs } = mount();
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  const A = w.__logic;
  if (!A) { console.log('FAIL  the app did not mount\n      ' + errors.join(' | ')); process.exit(1); }
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}
  const W = wallet(w);
  w.FoxyWallet = W;
  A.toast = () => {};
  A.nextPaidScreen = () => {};
  const V = () => A.renderVals();
  A.setState({ walletLive: true, fresh: false, balSats: 25066, balUsdCents: 1033, livePrice: PRICE, satUsd: PRICE / 1e8, screen: 'home', stack: [] });
  await settle();
  const click = (label) => {
    const el = w.document.querySelector('[aria-label="' + label + '"]');
    if (el) el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return !!el;
  };
  // where in the drawn page a text first is, -1 for nowhere
  const pos = (s) => textOf(w).indexOf(s);

  // ---- 1. HISTORY at the mint this phone is on: its name, a chevron ------------------------------------------------
  {
    A.go('history');
    A.loadHistory();
    await settle();
    const v = V();
    ok(v.histTitle === 'FLASH FORGE', 'the title is the mint’s name as the mint list names it, in capitals', v.histTitle);
    ok(v.histMintPick === true && typeof v.histMintGo === 'function', 'and it can be tapped to change mints');
    const btn = w.document.querySelector('[aria-label="Change mint"]');
    ok(!!btn && /FLASH FORGE/.test(btn.textContent) && !!btn.querySelector('path[d="m6 9 6 6 6-6"]'),
       'drawn: the name with the receive chips’ chevron after it', btn ? btn.outerHTML.slice(0, 200) : 'no button');
    const plain = [...w.document.querySelectorAll('div')].filter((d) => !d.children.length && d.textContent.trim() === 'HISTORY');
    ok(v.histTitlePlain === false && plain.length === 0, 'HISTORY gives way to the mint’s name: no plain HISTORY title is drawn',
       JSON.stringify([v.histTitlePlain, plain.length]));
    ok(v.histTabsShown === true, 'Forge has two balances: the tabs');
  }

  // ---- 2. the title opens the mint list, the mint shown ticked ----------------------------------------------------
  {
    click('Change mint');
    await settle();
    const v = V();
    ok(A.state.screen === 'switchMint' && v.mintTilesShown === true, 'the mint list, as tiles', A.state.screen);
    ok(v.mintTitle === 'WHICH MINT’S HISTORY?', 'titled for history', v.mintTitle);
    ok(v.mintNowShown && /history/i.test(v.mintNowLine) && /stays/.test(v.mintNowLine), 'its line says only the history changes', v.mintNowLine);
    eq(v.mintRows.map((r) => r.host), ['forge.flashapp.me', 'mint.minibits.cash', 'mint.macadamia.cash'], 'every mint, the one on first');
    ok(v.mintRows[0].here && v.mintRows.slice(1).every((r) => !r.here), 'the mint shown ticked', JSON.stringify(v.mintRows.map((r) => r.here)));
    ok(v.mintRows[1].balMain === '6,149' && v.mintRows[0].balMain === '25,066 + $10.33', 'each with its balance line', JSON.stringify(v.mintRows.map((r) => r.balMain)));
    ok(!v.mintPickers && !v.tillNextShown, 'no ADD A MINT and no NEXT');
  }

  // ---- 3. Minibits picked: its rows, its books, the wallet still at Forge -----------------------------------------
  {
    V().mintRows[1].tap();
    await settle();
    const v = V();
    ok(A.state.screen === 'history', 'back on HISTORY', A.state.screen);
    ok(v.histTitle === 'MINIBITS MINT', 'titled with the mint picked', v.histTitle);
    eq(names(v).sort(), ['Minibits coffee', 'Minibits tip'], 'its rows, and no other mint’s');
    ok(W.mintUrl === FORGE && W.switches === 0 && A.state.balSats === 25066, 'the wallet is still at Forge: nothing was switched', JSON.stringify([W.mintUrl, W.switches]));
    ok(v.histTabsShown === false, 'one balance there: no tabs');
    // the wallet's own list, books and log stay the connected mint's while another is shown
    eq(names({ historyGroups: A.state.history }).sort(), ['Forge dollars', 'Forge lunch', 'Forge rent'], 'the wallet’s own list still holds Forge’s rows only');
    ok(A.histAudit().balNow === 25066 && A.histAudit().off === 0, 'the wallet’s books (none named) are still Forge’s', JSON.stringify([A.histAudit().balNow, A.histAudit().off]));
    ok(!logs.some((l) => /\[foxy\] audit: balance 6149\b/.test(l)) && logs.some((l) => /\[foxy\] audit: balance 25066\b/.test(l)),
       'the audit line in the log is written for Forge, never for the mint only shown', logs.filter((l) => /\[foxy\] audit:/.test(l)).join(' | '));
    ok(v.histAuditShown && v.histAuditTitle === 'ADDS UP' && /\$ ?4\.61/.test(v.histAuditBody),
       'its own books: every sat of its 6,149 ($4.61) accounted for', v.histAuditTitle + ' | ' + v.histAuditBody);
    ok(v.histAuditEnd === true && v.histAuditTop === false && /payments above\./.test(v.histAuditBody), 'adding up, the books are at the end, and name the payments above them', v.histAuditBody);
    ok(pos('ADDS UP') > pos('Minibits tip') && pos('Minibits tip') > 0, 'drawn after the last row', String([pos('ADDS UP'), pos('Minibits tip')]));
    const rows = [].concat(...v.historyGroups.map((g) => g.items));
    ok(rows.every((r) => /BAL/.test(r.balText)) && /6,149/.test(rows[0].balText), 'each row’s running balance is that mint’s', rows.map((r) => r.balText).join(' | '));
    click('Change mint');
    await settle();
    ok(V().mintRows[1].here && !V().mintRows[0].here, 'the list ticks the mint shown, not the one the wallet is on');
    A.back();
    await settle();
  }

  // ---- 4. Minibits off by 51: the books at the top, red, with the figure ------------------------------------------
  {
    W.bal[MB].sat = 6200;
    A.setState({ histFilter: 'all' });
    await settle();
    const v = V();
    ok(v.histAuditTitle === 'DOES NOT ADD UP' && /\$ ?4\.65/.test(v.histAuditBody) && /\$ ?0\.04 more/.test(v.histAuditBody),
       'not adding up, with its balance and what it is off by (51 sats, $0.04)', v.histAuditBody);
    ok(v.histAuditTop === true && v.histAuditEnd === false && v.histAuditInk === 'var(--bad)' && /payments below account/.test(v.histAuditBody), 'at the top, in the warning look, naming the payments below', v.histAuditBody);
    ok(pos('DOES NOT ADD UP') >= 0 && pos('DOES NOT ADD UP') < pos('Minibits coffee'), 'drawn above the first row', String([pos('DOES NOT ADD UP'), pos('Minibits coffee')]));
    // 51 sats held back for a swap at Minibits (and none at Forge): out of its balance, named, and the books add up again
    W.bal[MB].sat = 6098;
    const asked = [];
    W.heldSats = (m) => { asked.push(m); return String(m || '').replace(/\/+$/, '') === MB ? 51 : 0; };
    A.setState({ histFilter: 'all' });
    await settle();
    const h = V();
    ok(h.histAuditTitle === 'ADDS UP' && h.histAuditEnd && /held back/.test(h.histAuditBody) && asked.indexOf(MB) >= 0,
       'what is held back is read at the mint shown, not the one the wallet is on', h.histAuditTitle + ' | ' + h.histAuditBody + ' | ' + JSON.stringify(asked.slice(-3)));
    W.heldSats = () => 0;
    W.bal[MB].sat = 6149;
  }

  // ---- 4b. change to collect or to hand over: the books at the top, red, with their button; at another mint and at the connected one ----
  {
    const first = (v) => Math.min(...names(v).map((n) => pos(n)).filter((n) => n >= 0));
    const changeCase = async (where, mint, bal, setBal) => {
      // a payment out of 100 sats whose 20 sats of change never came: CHANGE NOT COLLECTED, SCAN CHANGE
      W.txs.push(row('c-out', mint, 'out', 100, { memo: where + ' shop', changeState: 'owed', changeSats: 20 }));
      setBal(bal - 120);
      A.loadHistory();
      await settle();
      let v = V();
      ok(v.histAuditTitle === 'CHANGE NOT COLLECTED' && v.histAuditTop === true && v.histAuditEnd === false && v.histAuditAction === true
         && v.histAuditCta === 'SCAN CHANGE' && v.histAuditInk === 'var(--bad)',
         where + ': change not collected, at the top in red with SCAN CHANGE', JSON.stringify([v.histAuditTitle, v.histAuditTop, v.histAuditEnd, v.histAuditAction, v.histAuditCta]));
      ok(pos('CHANGE NOT COLLECTED') >= 0 && pos('SCAN CHANGE') > pos('CHANGE NOT COLLECTED') && pos('SCAN CHANGE') < first(v),
         where + ': drawn with its button above the first row', String([pos('CHANGE NOT COLLECTED'), pos('SCAN CHANGE'), first(v)]));
      W.txs.pop();
      // a payment in of 500 sats whose 30 sats of change for the payer is still here as a code: CHANGE TO HAND OVER, SHOW QR CODE
      W.txs.push(row('c-in', mint, 'in', 500, { memo: where + ' sale', changeState: 'not handed', changeSats: 30 }));
      const tags = W.tagsFor;
      W.tagsFor = (h) => (h === 'c-in' ? { token: 'cashuBstub' } : {});
      setBal(bal + 500);
      A.loadHistory();
      await settle();
      v = V();
      ok(v.histAuditTitle === 'CHANGE TO HAND OVER' && v.histAuditTop === true && v.histAuditEnd === false && v.histAuditAction === true
         && v.histAuditCta === 'SHOW QR CODE' && v.histAuditInk === 'var(--bad)',
         where + ': change to hand over, at the top in red with SHOW QR CODE', JSON.stringify([v.histAuditTitle, v.histAuditTop, v.histAuditEnd, v.histAuditAction, v.histAuditCta]));
      ok(pos('CHANGE TO HAND OVER') >= 0 && pos('SHOW QR CODE') > pos('CHANGE TO HAND OVER') && pos('SHOW QR CODE') < first(v),
         where + ': drawn with its button above the first row', String([pos('CHANGE TO HAND OVER'), pos('SHOW QR CODE'), first(v)]));
      W.txs.pop();
      W.tagsFor = tags;
      setBal(bal);
      A.loadHistory();
      await settle();
    };
    // Minibits, only shown
    ok(V().histTitle === 'MINIBITS MINT', 'still showing Minibits');
    await changeCase('Minibits', MB, 6149, (n) => { W.bal[MB].sat = n; });
    ok(W.mintUrl === FORGE && W.switches === 0, 'and the wallet never left Forge');
    // Forge, the mint the wallet is on, its bitcoin tab
    click('Change mint');
    await settle();
    V().mintRows[0].tap();
    await settle();
    A.setState({ histUnit: 'sat' });
    await settle();
    ok(V().histTitle === 'FLASH FORGE', 'Forge shown again');
    await changeCase('Forge', FORGE, 25066, (n) => { W.bal[FORGE].sat = n; A.setState({ balSats: n }); });
    ok(V().histAuditTitle === 'ADDS UP' && V().histAuditEnd, 'with the change gone, Forge’s books are at the end again', V().histAuditTitle);
    // back to Minibits for what follows
    click('Change mint');
    await settle();
    V().mintRows[1].tap();
    await settle();
  }

  // ---- 5. macadamia: nothing there, the empty state ---------------------------------------------------------------
  {
    click('Change mint');
    await settle();
    V().mintRows[2].tap();
    await settle();
    const v = V();
    ok(v.histTitle === 'MACADAMIA MINT' && v.historyEmpty === true && names(v).length === 0 && !v.histAuditShown, 'no history there: NOTHING TO SEE YET!',
       JSON.stringify([v.histTitle, v.historyEmpty, names(v)]));
    ok(/NOTHING TO SEE YET!/.test(textOf(w)), 'drawn');
  }

  // ---- 6. back to Forge: the tabs, each tab's books in its place --------------------------------------------------
  {
    click('Change mint');
    await settle();
    V().mintRows[0].tap();
    await settle();
    A.setState({ histUnit: 'sat' });
    await settle();
    let v = V();
    ok(v.histTitle === 'FLASH FORGE' && v.histTabsShown, 'Forge again, with its tabs');
    eq(names(v).sort(), ['Forge lunch', 'Forge rent'], 'BITCOIN: its sat rows');
    ok(v.histAuditTitle === 'ADDS UP' && v.histAuditEnd && !v.histAuditTop, 'BITCOIN adds up: at the end', v.histAuditTitle);
    // the dollars short by a dollar: the dollar tab's books at the top, the bitcoin tab's still at the end
    W.bal[FORGE].usd = 933;
    A.setState({ balUsdCents: 933, histUnit: 'usd' });
    await settle();
    v = V();
    eq(names(v), ['Forge dollars'], 'DOLLARS: its dollar row');
    ok(v.histAuditTitle === 'DOES NOT ADD UP' && v.histAuditTop && !v.histAuditEnd && /\$ ?1\.00 less/.test(v.histAuditBody), 'DOLLARS does not add up: at the top, with $1.00', v.histAuditBody);
    A.setState({ histUnit: 'sat' });
    await settle();
    ok(V().histAuditEnd && !V().histAuditTop, 'and BITCOIN still at the end');
    W.bal[FORGE].usd = 1033;
    A.setState({ balUsdCents: 1033 });
  }

  // ---- 6b. Minibits shown while the wallet has two balances at Forge: Minibits has one, no tabs ----------------------
  {
    A.setState({ histUnit: 'usd' });
    click('Change mint');
    await settle();
    V().mintRows[1].tap();
    await settle();
    const v = V();
    ok(!v.histTabsShown && names(v).length === 2 && v.histAuditTitle === 'ADDS UP', 'a one-balance mint shows its sats whatever tab was last', JSON.stringify([v.histTabsShown, names(v), v.histAuditTitle]));
  }

  // ---- 6c. another mint's rows cannot be read: the empty state, not a blank screen ---------------------------------
  {
    const txs = W.transactions;
    W.transactions = () => Promise.reject(new Error('store unreadable'));
    click('Change mint');
    await settle();
    V().mintRows[2].tap();
    await settle();
    const v = V();
    ok(v.histTitle === 'MACADAMIA MINT' && v.historyEmpty === true && names(v).length === 0 && /NOTHING TO SEE YET!/.test(textOf(w)),
       'its rows not read: NOTHING TO SEE YET!, not a list left loading for ever', JSON.stringify([v.histTitle, v.historyEmpty, names(v)]));
    W.transactions = txs;
  }

  // ---- 6d. the mint list asked for HISTORY and left: SWITCH and TRANSFER are themselves again; a mint out of reach is not greyed ----
  {
    const was = { justSwitch: A.justSwitch, trPick: A.trPick, histMintPick: A.histMintPick, mintReachable: A.mintReachable, offlineNo: A.offlineNo };
    const did = [];
    A.justSwitch = (u) => did.push('switch ' + u);
    A.trPick = (u) => did.push('transfer ' + u);
    A.histMintPick = (u) => did.push('history ' + u);
    A.offlineNo = (what) => did.push('offline ' + what);
    // macadamia cannot be reached: in HISTORY's list it is as bright as the rest, and a tap shows its history
    A.mintReachable = (u) => !/macadamia/.test(String(u));
    click('Change mint');
    await settle();
    let v = V();
    ok(v.mintTitle === 'WHICH MINT’S HISTORY?' && v.mintRows[2].dim === '1', 'HISTORY’s list: a mint out of reach is not greyed', JSON.stringify(v.mintRows.map((r) => r.dim)));
    v.mintRows[2].tap();
    eq(did.splice(0), ['history ' + MAC], 'and a tap on it shows its history');
    // left by BACK, with histPick still standing
    A.back();
    await settle();
    // SWITCH MINT from the menu: its own list, a tap switches
    A.goSwitchMint();
    await settle();
    v = V();
    ok(A.state.histPick === false && v.mintTitle !== 'WHICH MINT’S HISTORY?' && v.mintRows[2].dim === '0.4', 'SWITCH MINT after it: its own list, the mint out of reach greyed',
       JSON.stringify([A.state.histPick, v.mintTitle, v.mintRows.map((r) => r.dim)]));
    v.mintRows[1].tap();
    eq(did.splice(0), ['switch ' + MB], 'and a tap switches, not shows a history');
    A.back();
    await settle();
    // TRANSFER after the history list again
    click('Change mint');
    await settle();
    A.back();
    await settle();
    W.transferQuote = () => Promise.resolve({});
    A.goTransfer();
    await settle();
    v = V();
    ok(A.state.histPick === false && v.mintTitle === 'FROM WHICH MINT?', 'TRANSFER after it: FROM WHICH MINT?', JSON.stringify([A.state.histPick, v.mintTitle]));
    v.mintRows[1].tap();
    eq(did.splice(0), ['transfer ' + MB], 'and a tap picks where the transfer is from');
    Object.assign(A, was);
    A.setState({ screen: 'home', stack: [], trStep: '' });
    await settle();
  }

  // ---- 7. HISTORY opened again: the mint this phone is on; a card's own HISTORY is untouched ----------------------
  {
    A.setState({ screen: 'home', stack: [] });
    A.go('history');
    await settle();
    let v = V();
    ok(v.histTitle === 'FLASH FORGE' && names(v).some((n) => /Forge/.test(n)), 'opened again, it starts at the mint this phone is on', v.histTitle);
    A.setState({ screen: 'history', stack: ['home', 'flashcard'], histCard: 'K1', fc: { key: 'K1', unit: 'sat' }, histFilter: 'all' });
    await settle();
    v = V();
    ok(v.histTitle === 'CARD HISTORY' && v.histMintPick === false && !w.document.querySelector('[aria-label="Change mint"]'),
       'a card’s own HISTORY: CARD HISTORY, no chevron', JSON.stringify([v.histTitle, v.histMintPick]));
    ok(!v.histAuditShown, 'and no books there, as before');
    A.setState({ screen: 'home', stack: [], histCard: '', fc: null });
  }

  // ---- 8. the wallet's figures set aside, read at a mint named: held, fees, melting, recovering (the real wallet, on X) ----------
  {
    const { loadReal, fakeMint, nativePhone, PHONE_WORDS, noBooks } = require('./harness');
    const X = 'https://a.test', Y = 'https://b.test';
    const phone = nativePhone({ words: PHONE_WORDS });
    let mint = null;
    const reply = (pw, id, t, e) => setTimeout(() => pw.FoxyWallet._scanResult(id, t, e), 0);
    const c = loadReal({
      bridge: (pw, m) => {
        if (m.action === 'mintRequest') return reply(pw, m.id, mint.handle(m));
        const got = phone.answer(pw, m);
        if (!got) return reply(pw, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(pw, m.id, r[0], r[1]));
      },
      before: (pw) => { phone.attach(pw); mint = fakeMint(pw); },
      // the held pieces stay held: no sweep asks the mint about them while this is read
      sweepPause: [86400000, 86400000],
      storage: {
        'foxy.cashu.held': JSON.stringify({ h1: { mint: X, proofs: [{ amount: 8, secret: 's1' }] }, h2: { mint: Y, proofs: [{ amount: 16, secret: 's2' }] },
          h3: { mint: Y, unit: 'usd', proofs: [{ amount: 32, secret: 's3' }] } }),
        'foxy.cashu.topupfees': JSON.stringify({ [X]: 3, [Y]: 5 }),
        'foxy.cashu.melting': JSON.stringify([{ mint: Y, quote: 'q1', proofs: [{ amount: 4, secret: 's4' }] },
          { mint: Y, unit: 'usd', quote: 'q2', proofs: [{ amount: 64, secret: 's5' }] }]),
        // a swap at Y the mint took after Foxy was put away: its input on its way back, in each unit
        'foxy.cashu.swaps': JSON.stringify([{ id: 'r1', kind: 'swap', mint: Y, at: 1, freeInputs: true, inputs: [{ amount: 2, secret: 's6' }] },
          { id: 'r2', kind: 'swap', mint: Y, unit: 'usd', at: 1, freeInputs: true, inputs: [{ amount: 128, secret: 's7' }] }]),
      },
    });
    noBooks(c, 'figures set aside written into storage by hand');
    c.W._nodeProbeDelay = [86400000, 86400000];
    const R = c.W;
    await R.connect(X, { remember: true });
    ok(String(R.mintUrl).replace(/\/+$/, '') === X, 'the real wallet is on X', R.mintUrl);
    eq([R.heldSats(X), R.heldSats(Y), R.heldIn('sat', Y), R.heldIn('usd', Y)], [8, 16, 16, 32], 'held back, at the mint named, in each unit');
    eq([R.topUpFeeSats(X), R.topUpFeeSats(Y)], [3, 5], 'the top-ups’ fees, at the mint named');
    eq([R.meltingIn('sat', Y), R.meltingIn('usd', Y), R.meltingIn('sat', X)], [4, 64, 0], 'a melt with the mint, at the mint named');
    const back = [R.recoveringSats(Y), R.recoveringIn('usd', Y), R.recoveringSats(X)];
    ok(back[0] > 0 && back[1] > 0 && back[2] === 0, 'recovering, at the mint named, in each unit; none at X', JSON.stringify(back));
    // none named: the connected mint's, X's, which are not zero
    eq([R.heldSats(), R.heldSats(X)], [8, 8], 'held back, none named: X’s');
    eq([R.topUpFeeSats(), R.topUpFeeSats(X)], [3, 3], 'the top-ups’ fees, none named: X’s');
    eq([R.meltingIn('sat'), R.recoveringSats(), R.recoveringIn('usd')], [0, 0, 0], 'melting and recovering, none named: X’s, where there are none (Y’s are not counted)');
  }

  const real = errors.filter((e) => !/Not implemented|navigation/i.test(e));
  ok(real.length === 0, 'no errors in the page', real.slice(0, 3).join(' | '));
  console.log('\n' + (failed ? passed + ' passed, ' + failed + ' failed' : 'all ' + passed + ' history mint checks pass'));
  process.exit(failed ? 1 : 0);
})();
