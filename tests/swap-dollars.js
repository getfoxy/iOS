'use strict';
/* swap-dollars.js — a swap's amount in dollars or sats, and its confirmation's four blocks.
 *
 *     node tests/swap-dollars.js
 *
 * SWAP at a mint with dollars and bitcoin (build/app/26i-swap.js), drawn by the real page (build/foxy-render.js, as
 * tests/two-balances-swap.js part 2 mounts it) on a stand-in wallet whose rate is fixed, so every figure is known.
 *
 * The amount: SET AMOUNT starts in dollars whichever way the swap goes, and the ⇅ turns it to sats and back as a
 * send's does. What the swap moves is still the balance that leaves, exactly: typed in that unit nothing converts;
 * typed in the other it converts at the mint's last rate (the one the confirmation values it at, not the market's),
 * rounded to the cent the ⇅ shows, and the rate is asked for what that comes to. With no price
 * the ⇅ is refused and the exact unit stays. MORE THAN YOUR ... and ALL OF IT are in the unit that leaves, and a
 * switch after a rate was asked drops that rate.
 *
 * The confirmation: YOU ARE GETTING, YOU ARE SPENDING, FEE, and the mint's RATE, in that order, both ways round, at
 * a rate of $ 82,601: a bitcoin figure is its dollar worth with its sats under it, a dollar figure has no sats line,
 * the fee is what leaves less what arrives, the heading names the mint, and "Rate held for" counts down on a clock
 * that stops when the screen goes and when the rate lapses. */
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RATE = 82601;

async function mount() {
  const { JSDOM, VirtualConsole } = require('jsdom');
  const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
  const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
  const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
  const RENDERER = fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8');
  const unpack = (uuid) => fs.readFileSync(path.join(ROOT, assets.find((a) => a.uuid === uuid).file), 'utf8');
  const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
    const props = JSON.parse(v.replace(/&quot;/g, '"'));
    props.startStatic = { default: true };
    return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
  });
  const html = markup.replace(/<script src="64b433ba-[^"]*"><\/script>/, '').replace(shell.marker, () => open + appSrc + '</script>');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://foxy.test/index.html', virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.scrollTo = () => {};
  const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
  run('(function(){var n=Number.prototype.toLocaleString;Number.prototype.toLocaleString=function(l,o){return n.call(this,l===undefined?"en-US":l,o);};})();');
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
  return w;
}

(async () => {
  console.log('foxy swap: dollars or sats on the keypad, and the four blocks\n');
  const w = await mount();
  const A = w.__logic;
  if (!A) { ok(false, 'the app mounts'); process.exit(1); }
  try { w.sessionStorage.setItem('foxyBallRolled', '1'); } catch (e) {}
  const toasts = [];
  A.toast = (m) => { toasts.push(String(m)); };
  const text = () => {
    const out = [];
    const walk = w.document.createTreeWalker(w.document.getElementById('dc-root') || w.document.body, 4);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) { const t = n.nodeValue.trim(); if (t) out.push(t); }
    return out.join(' ').replace(/\s+/g, ' ');
  };
  const settle = async () => { for (let i = 0; i < 6; i++) await wait(15); };

  /* The stand-in: a mint that keeps 5% of what leaves, at $ 82,601. One dollar of bitcoin (1,211 sats) gives
   * $ 0.95; one dollar gives 1,150 sats — the owner's example. `hold` keeps the next answer back until let go.
   * `rate` is the mint's own (its last, and the one it quotes at), which can be moved off the market's; 0 is a mint
   * that has given none. */
  const st = { usd: 4205, sat: 50000, host: 'forge.example.com', hold: null, rate: RATE };
  const asked = [];
  const quote = (from, to, amount) => ({
    id: 'uswap-' + asked.length, mint: 'https://' + st.host, from, to, total: amount, amount: Math.round(amount * 0.95),
    fee: amount - Math.round(amount * 0.95),
    get: from === 'usd' ? Math.floor(amount * 0.95 * 1e6 / (st.rate || RATE)) : Math.floor(amount * (st.rate || RATE) / 1e6 * 0.95),
    rate: { usdPerBtc: st.rate || RATE, by: st.host }, market: RATE, spread: 0, spreadWarn: false,
    expiresAt: Date.now() + 67500, state: 'quoted',
  });
  w.FoxyWallet = {
    connected: true, mintUrl: 'https://forge.example.com', mintHost: () => st.host, mints: () => [],
    reason: (e) => String((e && e.message) || e), backedUp: () => true, pinIsSet: () => false, tagsFor: () => ({}), tag() {},
    qr: (x) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(x).slice(0, 24)), classify: () => 'unknown', amountOf: () => null,
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u), unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: st.sat }, { unit: 'usd', amount: st.usd }], balanceAt: () => st.sat,
    agreedRate: () => Promise.resolve(RATE), book: () => [], remember() {}, lastToken: () => ({}), clearLastToken() {},
    pendingMelts: () => [], splitPending: () => null, decodeRequest: () => null,
    balanceSats: () => Promise.resolve(st.sat), rate: () => Promise.resolve(RATE), transactions: () => Promise.resolve([]), listen: () => () => {},
    privacy: () => ({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false, network: 'wifi', orbot: 'none', vpn: false }),
    mintUnits: () => ['sat', 'usd'], twoUnits: () => true,
    walletChoice: () => ({ hold: 'both', recv: '', send: '' }), setWalletChoice() {},
    balanceOf: (u) => (u === 'usd' ? st.usd : st.sat), heldIn: () => 0, recoveringIn: () => 0,
    mintRate: () => (st.rate ? { usdPerBtc: st.rate, at: Date.now() } : null),
    unitSwapsPending: () => [],
    swapQuote(from, to, amount, opts) {
      asked.push([from, to, amount, !!(opts && opts.all)]);
      const q = quote(from, to, amount);
      if (st.hold) return new Promise((r) => { st.hold.push(() => r(q)); });
      return Promise.resolve(q);
    },
    swapRun() { return new Promise(() => {}); },
  };
  const PRICE = { livePrice: RATE, satUsd: RATE / 1e8 };
  A.setState(Object.assign({ walletLive: true, balSats: st.sat, balUsdCents: st.usd, screen: 'home', stack: [] }, PRICE));
  await settle();

  // to SET AMOUNT for a swap one way or the other, from home
  const toAmount = async (from) => {
    A.setState({ screen: 'home', stack: [], amount: '' });
    A.goSwap();
    if (A.state.swapFrom !== from) A.swapFlip();
    A.renderVals().swapNextGo();
    await settle();
  };
  const type = async (keys) => { A.setState({ amount: '' }); keys.split('').forEach((k) => A.press(k)); await settle(); };
  const next = async () => { A.renderVals().next(); await settle(); await settle(); };
  const toggle = async () => { A.renderVals().toggleUnit(); await settle(); };

  // ---- part A: the amount ------------------------------------------------------------------------------
  await toAmount('usd');
  let v = A.renderVals();
  let b0;
  ok(A.state.screen === 'amount' && A.state.flow === 'swap' && A.state.unit === 'USD', 'dollars into bitcoin: SET AMOUNT opens in dollars');
  ok(v.swapVis === 'visible' && v.swapPE === 'auto', 'with the ⇅ on screen', v.swapVis + ' ' + v.swapPE);
  await toAmount('sat');
  ok(A.state.screen === 'amount' && A.state.unit === 'USD', 'bitcoin into dollars: SET AMOUNT opens in dollars too', A.state.unit);
  await toggle();
  ok(A.state.unit === 'SATS', 'the ⇅ turns it to sats');
  await toggle();
  ok(A.state.unit === 'USD', 'and back to dollars');
  A.syncUnit();
  ok(A.state.unit === 'USD', 'and the keypad is left where the person put it');

  // bitcoin into dollars, typed in dollars: the sats that leave, at the mint's last rate
  await type('100');
  ok(/\$ 1\.00/.test(text()) && /₿ 1,211/.test(text()), 'typed $ 1.00, the line under it says the ₿ 1,211 that leave', text().slice(0, 300));
  ok(A.swapTyped() === Math.round(1 / RATE * 1e8), 'swapTyped is 1,211 sats', String(A.swapTyped()));
  await next();
  ok(A.state.screen === 'swapConfirm' && JSON.stringify(asked[asked.length - 1]) === '["sat","usd",1211,false]',
    'NEXT asks the rate for 1,211 sats', JSON.stringify(asked[asked.length - 1]));
  ok(A.state.swapAmount === 1211, 'and the swap is for those sats');

  // bitcoin into dollars, typed in sats: what is typed is what leaves
  await toAmount('sat');
  await toggle();
  await type('1211');
  ok(A.swapTyped() === 1211 && /≈ \$ 1\.00/.test(text()), 'typed ₿ 1,211 in sats: 1,211 exactly, and about what it gives under it', text().slice(0, 300));
  A.setState({ livePrice: 50000, satUsd: 50000 / 1e8 });
  ok(A.swapTyped() === 1211, 'whatever the price is doing');
  A.setState(PRICE);
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["sat","usd",1211,false]', 'and NEXT asks for 1,211 sats');

  // dollars into bitcoin, typed in sats: the cents that leave
  await toAmount('usd');
  await toggle();
  ok(A.state.unit === 'SATS', 'dollars into bitcoin: the ⇅ to sats');
  await type('1211');
  ok(A.swapTyped() === 100 && /₿ 1,211/.test(text()) && /\$ 1\.00/.test(text()), 'typed ₿ 1,211: $ 1.00 leaves, said under it', text().slice(0, 300));
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",100,false]', 'NEXT asks the rate for 100 cents', JSON.stringify(asked[asked.length - 1]));

  // dollars into bitcoin, typed in dollars: nothing converts
  await toAmount('usd');
  await type('100');
  A.setState({ livePrice: 50000, satUsd: 50000 / 1e8 });
  ok(A.swapTyped() === 100, 'typed $ 1.00 in dollars: 100 cents, whatever the price');
  A.setState(PRICE);
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",100,false]', 'NEXT asks for 100 cents');

  /* Sats typed for dollars leaving are cents rounded to the nearest, as the ⇅ writes them: 1,000 sats at $ 82,601
   * are 82.601 cents, so 83 (not 82, as cutting them down would ask), and 351 sats are 28.993 cents, so 29 (0.29
   * times a hundred is 28.999...: a cut there would ask 28). */
  await toAmount('usd');
  await toggle();
  await type('1000');
  ok(A.swapTyped() === 83, 'typed ₿ 1,000 at $ 82,601 (82.601 cents): 83 cents, rounded to the nearest', String(A.swapTyped()));
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",83,false]', 'and NEXT asks for 83 cents', JSON.stringify(asked[asked.length - 1]));
  await toAmount('usd');
  await toggle();
  await type('351');
  ok(A.swapTyped() === 29, 'typed ₿ 351 (28.993 cents): 29 cents', String(A.swapTyped()));
  /* And on an exact half the cents asked for are the figure the ⇅ shows: at a mint rate of $ 82,000, 750 sats are
   * 61.5 cents, which the ⇅ writes as $ 0.61 and rounding the product times a hundred would make 62. */
  st.rate = 82000;
  await toAmount('usd');
  await toggle();
  await type('750');
  ok(A.swapTyped() === 61, 'typed ₿ 750 at $ 82,000 (61.5 cents): 61, as the ⇅ shows it', String(A.swapTyped()));
  await toggle();
  ok(A.state.unit === 'USD' && A.state.amount === '0.61', 'and the ⇅ shows $ 0.61', A.state.amount);
  st.rate = RATE;

  /* The mint's rate off the market's: $ 80,000 at the mint, $ 82,601 on the market. A figure typed in the other unit
   * converts at the mint's, the rate the confirmation values it at, so the dollars typed are the dollars it repeats. */
  st.rate = 80000;
  await toAmount('sat');
  await type('100');
  ok(A.swapTyped() === 1250 && /₿ 1,250/.test(text()), 'mint at $ 80,000: $ 1.00 of bitcoin is ₿ 1,250 (not the market’s 1,211)', A.swapTyped() + ' ' + text().slice(0, 200));
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["sat","usd",1250,false]', 'NEXT asks for 1,250 sats', JSON.stringify(asked[asked.length - 1]));
  b0 = (A.confirmSpec().rows || [])[1] || {};
  ok(b0.value === '$ 1.00 in BITCOIN' && b0.sub === '(₿ 1,250)', 'and the confirmation repeats $ 1.00 in BITCOIN (₿ 1,250)', b0.value + ' ' + b0.sub);
  await toAmount('usd');
  await type('100');
  await toggle();
  ok(A.state.unit === 'SATS' && A.state.amount === '1250', 'dollars leaving: the ⇅ turns $ 1.00 into ₿ 1,250 at the mint’s rate', A.state.amount);
  ok(A.swapTyped() === 100, 'which is 100 cents again', String(A.swapTyped()));
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",100,false]', 'and NEXT asks for 100 cents', JSON.stringify(asked[asked.length - 1]));
  b0 = (A.confirmSpec().rows || [])[1] || {};
  ok(b0.value === '$ 1.00 in DOLLARS', 'the confirmation repeats $ 1.00 in DOLLARS', b0.value);
  // a mint that has given no rate: the market's
  st.rate = 0;
  await toAmount('sat');
  await type('100');
  ok(A.swapTyped() === 1211, 'a mint with no rate yet: the market’s, ₿ 1,211', String(A.swapTyped()));
  st.rate = RATE;

  // no price ever seen
  A.setState({ livePrice: null, satUsd: null });
  await toAmount('usd');
  toasts.length = 0;
  await toggle();
  ok(A.state.unit === 'USD' && /No bitcoin price yet/.test(toasts.pop() || ''), 'no price: the ⇅ is refused with the send keypad’s words, and dollars stay');
  await toAmount('sat');
  ok(A.state.unit === 'SATS', 'no price, bitcoin leaving: SET AMOUNT opens in sats, where nothing converts');
  await toggle();
  ok(A.state.unit === 'SATS' && /No bitcoin price yet/.test(toasts.pop() || ''), 'and its ⇅ is refused too');
  // a price that goes while the keypad is in the unit that does not leave: back to the one that does
  A.setState(PRICE);
  await toAmount('sat');
  A.setState({ amount: '5.00', livePrice: null, satUsd: null });
  A.syncUnit();
  ok(A.state.unit === 'SATS' && A.state.amount === '', 'the price gone under dollars typed for bitcoin: back to sats, cleared');
  A.setState(PRICE);

  // over the balance, both ways, in the unit that leaves
  await toAmount('sat');
  await type('5000');
  v = A.renderVals();
  ok(v.sendOverShown === '1' && v.sendOverLabel === 'MORE THAN YOUR BITCOIN', '$ 50.00 of bitcoin is more than ₿ 50,000', v.sendOverLabel);
  let n = asked.length;
  await next();
  ok(A.state.screen === 'amount' && asked.length === n, 'and NEXT does not take it');
  await type('4000');
  ok(A.renderVals().sendOverShown === '0', '$ 40.00 of bitcoin (₿ 48,425) is not');
  ok(A.renderVals().amtAltLabel === 'ALL OF IT (₿ 50,000)', 'ALL OF IT is the whole bitcoin balance, in sats, typed in dollars or not', A.renderVals().amtAltLabel);
  A.renderVals().amtAltTap();
  await settle();
  ok(JSON.stringify(asked[asked.length - 1]) === '["sat","usd",50000,true]', 'and asks for all 50,000 sats', JSON.stringify(asked[asked.length - 1]));
  await toAmount('usd');
  await toggle();
  await type('60000');
  v = A.renderVals();
  ok(v.sendOverShown === '1' && v.sendOverLabel === 'MORE THAN YOUR DOLLARS', '₿ 60,000 ($ 49.56) is more than $ 42.05', v.sendOverLabel);
  await type('50000');
  ok(A.renderVals().sendOverShown === '0', '₿ 50,000 ($ 41.30) is not');
  ok(A.renderVals().amtAltLabel === 'ALL OF IT ($ 42.05)', 'ALL OF IT is the whole dollar balance, in dollars, typed in sats or not');
  A.renderVals().amtAltTap();
  await settle();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",4205,true]', 'and asks for all 4,205 cents', JSON.stringify(asked[asked.length - 1]));

  // a switch after a rate was asked drops that rate
  await toAmount('usd');
  await type('100');
  await next();
  ok(!!A.state.swapQuote, 'a rate, for $ 1.00');
  A.back();
  await settle();
  ok(A.state.screen === 'amount' && !!A.state.swapQuote, 'back on SET AMOUNT, the rate is still in hand');
  await toggle();
  ok(A.state.unit === 'SATS' && !A.state.swapQuote, 'the ⇅ drops it');
  await type('1211');
  await next();
  ok(!!A.state.swapQuote && A.state.swapQuote.total === 100, 'NEXT asks again, for what the new figure comes to');
  A.back();
  await settle();
  A.press('0');
  await settle();
  ok(!A.state.swapQuote, 'and a key drops it the same way');
  // an answer still on its way for the old figure is not kept
  st.hold = [];
  await next();
  A.back();
  await settle();
  await toggle();
  st.hold.forEach((f) => f());
  st.hold = null;
  await settle();
  ok(!A.state.swapQuote && !A.state.swapQuoting, 'an answer that comes after the switch is dropped');

  // ---- part B: the confirmation ------------------------------------------------------------------------
  const blocks = () => (A.confirmSpec().rows || []).map((r) => [r.label, r.value, r.sub]);
  const said = (rows) => JSON.stringify(rows.map((r) => r.slice(0, 3)));

  // bitcoin into dollars: $ 1.00 of bitcoin
  await toAmount('sat');
  await type('100');
  await next();
  let b = blocks();
  ok(said(b.slice(0, 3)) === JSON.stringify([
    ['YOU ARE GETTING', '$ 0.95 in DOLLARS', ''],
    ['YOU ARE SPENDING', '$ 1.00 in BITCOIN', '(₿ 1,211)'],
    ['FEE', '$ 0.05', '(₿ 61)'],
  ]), 'bitcoin into dollars: GETTING $ 0.95 in DOLLARS, SPENDING $ 1.00 in BITCOIN (₿ 1,211), FEE $ 0.05 (₿ 61)', said(b));
  ok(b[3][0] === 'FORGE’S RATE' && b[3][1] === '₿ 1 = $ 82,601' && /^Rate held for 00:5\d$/.test(b[3][2]),
    'then FORGE’S RATE, ₿ 1 = $ 82,601, Rate held for 00:5x', said(b));
  let t = text();
  ok(/SWAP YOU ARE GETTING \$ 0\.95 in DOLLARS YOU ARE SPENDING \$ 1\.00 in BITCOIN \(₿ 1,211\) FEE \$ 0\.05 \(₿ 61\) FORGE’S RATE ₿ 1 = \$ 82,601 Rate held for 00:5\d SWAP$/.test(t),
    'the page draws the four blocks in that order, and nothing else between the title and SWAP', t.slice(0, 400));
  ok(!/TOTAL|NETWORK|FEE INCLUDED|YOU GET /.test(t), 'no TOTAL, NETWORK, FEE INCLUDED or YOU GET left over');
  const q1 = A.state.swapQuote;
  ok(Math.round(q1.total * RATE / 1e6) - q1.get === 5, 'the fee is what leaves less what arrives, at the rate: 100 − 95 cents');

  // the countdown ticks, and its clock stops with the screen
  const before = b[3][2];
  await wait(1100);
  await settle();
  const after = blocks()[3][2];
  ok(before !== after && /^Rate held for 00:5\d$/.test(after), 'Rate held for counts down each second', before + ' → ' + after);
  ok(!!A._swapClockT, 'on a clock');
  A.back();
  await wait(1200);
  ok(!A._swapClockT, 'which stops when the screen goes');

  // dollars into bitcoin: $ 1.00
  await toAmount('usd');
  await type('100');
  await next();
  b = blocks();
  ok(said(b.slice(0, 3)) === JSON.stringify([
    ['YOU ARE GETTING', '$ 0.95 in BITCOIN', '(₿ 1,150)'],
    ['YOU ARE SPENDING', '$ 1.00 in DOLLARS', ''],
    ['FEE', '$ 0.05', '(₿ 61)'],
  ]), 'dollars into bitcoin: GETTING $ 0.95 in BITCOIN (₿ 1,150), SPENDING $ 1.00 in DOLLARS, FEE $ 0.05 (₿ 61)', said(b));
  t = text();
  ok(/SWAP YOU ARE GETTING \$ 0\.95 in BITCOIN \(₿ 1,150\) YOU ARE SPENDING \$ 1\.00 in DOLLARS FEE \$ 0\.05 \(₿ 61\) FORGE’S RATE ₿ 1 = \$ 82,601 Rate held for 00:5\d SWAP$/.test(t),
    'the page draws them in that order', t.slice(0, 400));
  ok((t.match(/\(₿ [\d,]+\)/g) || []).length === 2, 'two sats lines, under the bitcoin and the fee, and none under the dollars');
  const q2 = A.state.swapQuote;
  ok(q2.total - Math.round(q2.get * RATE / 1e6) === 5, 'the fee is what leaves less what arrives: 100 − 95 cents');
  const row0 = A.confirmSpec().rows[0];
  ok(row0.size === '30px' && row0.ink === '#F2742B', 'what arrives heads the screen, a size up, in the ink of its balance');
  ok(A.renderVals().cfCtaLabel === 'SWAP' && A.renderVals().cfCtaBg === '#3AB54A', 'the green SWAP is kept');
  A.setState({ swapNewRate: true });
  ok(A.renderVals().cfCtaLabel === 'CONFIRM NEW RATE', 'and CONFIRM NEW RATE for a new rate');
  A.setState({ swapNewRate: false });

  // the rate lapses with nobody looking: the clock stops with it
  const requotes = A.SWAP_REQUOTES;
  A.SWAP_REQUOTES = 0;
  A.setState({ swapQuote: Object.assign({}, A.state.swapQuote, { expiresAt: Date.now() + 15000 }) });
  A.swapClock();
  await wait(2300);
  await settle();
  ok(A.state.swapLapsed && !A.state.swapQuote && A.confirmSpec().cta === 'GET A NEW RATE', 'a rate run out: GET A NEW RATE, as before');
  ok(!A._swapClockT, 'and the clock has stopped with the rate');
  b = blocks();
  ok(said(b) === JSON.stringify([['YOU ARE GETTING', 'UNKNOWN', ''], ['YOU ARE SPENDING', '$ 1.00 in DOLLARS', ''], ['FEE', 'UNKNOWN', ''], ['FORGE’S RATE', 'UNKNOWN', '']]),
    'with no rate the blocks stay, saying UNKNOWN', said(b));
  /* Bitcoin leaving, with no rate in hand: its dollars at the mint's last rate, the sats under it, as the keypad
   * had it; and with no price at all, the sats alone, with no unit word after them. */
  A.setState({ swapFrom: 'sat', swapTo: 'usd', swapAmount: 1211 });
  b = blocks();
  ok(said([b[1]]) === JSON.stringify([['YOU ARE SPENDING', '$ 1.00 in BITCOIN', '(₿ 1,211)']]),
    'bitcoin leaving, rate run out: YOU ARE SPENDING $ 1.00 in BITCOIN (₿ 1,211)', said(b));
  st.rate = 0;
  A.setState({ livePrice: null, satUsd: null });
  b = blocks();
  ok(said([b[1]]) === JSON.stringify([['YOU ARE SPENDING', '₿ 1,211', '']]), 'and with no price at all: ₿ 1,211 alone', said(b));
  st.rate = RATE;
  A.setState(Object.assign({ swapFrom: 'usd', swapTo: 'sat' }, PRICE));
  A.SWAP_REQUOTES = requotes;

  // another mint with two balances says its own name
  st.host = 'mint.kashu.me';
  A.setState({ screen: 'home', stack: [] });
  await toAmount('usd');
  await type('100');
  await next();
  ok(blocks()[3][0] === 'KASHU’S RATE', 'another mint’s heading: KASHU’S RATE', blocks()[3][0]);
  st.host = 'minibits.cash';
  A.setState({ swapTick: Date.now() });
  ok(blocks()[3][0] === 'MINIBITS’ RATE', 'and a name ending in s: MINIBITS’ RATE', blocks()[3][0]);
  A.setState({ screen: 'home', stack: [] });
  await wait(1200);
  ok(!A._swapClockT, 'every clock stopped at the end');

  // ---- part C: the rate line on SET AMOUNT, as drawn ------------------------------------------------------
  /* The probe at the SWAP tap (`swapProbe`): while it is out the line under the question says so; its answer is the
   * mint's rate there, in the confirmation's words; a mint that has given none is the market's, said to be. A figure
   * left still is quoted in the background, and NEXT on it opens the confirmation without asking again. */
  {
    const probe = { calls: 0, hold: null };
    st.rate = 0;
    st.host = 'forge.example.com';
    w.FoxyWallet.swapProbe = () => {
      probe.calls += 1;
      return new Promise((r) => { probe.hold = () => { st.rate = 81500; r({ usdPerBtc: 81500, at: Date.now() }); }; });
    };
    A.setState({ screen: 'home', stack: [] });
    A.goSwap();
    A.renderVals().swapNextGo();
    await settle();
    ok(probe.calls === 1 && /How much to swap\? Checking the rate…/.test(text()), 'SET AMOUNT, the probe out: "Checking the rate…" under the question', text().slice(0, 200));
    probe.hold();
    await settle();
    ok(/How much to swap\? FORGE’S RATE ₿ 1 = \$ 81,500/.test(text()), 'its answer: FORGE’S RATE ₿ 1 = $ 81,500 there', text().slice(0, 200));
    // the probe refused, and the mint with no rate: the market price, said to be the market's
    st.rate = 0;
    w.FoxyWallet.swapProbe = () => { probe.calls += 1; return Promise.reject(new Error('the mint did not answer')); };
    toasts.length = 0;
    A.setState({ screen: 'home', stack: [] });
    A.goSwap();
    A.renderVals().swapNextGo();
    await settle();
    ok(/How much to swap\? MARKET PRICE ₿ 1 = \$ 82,601/.test(text()) && !toasts.length, 'a probe that failed: MARKET PRICE ₿ 1 = $ 82,601, and nothing said about it', text().slice(0, 200));
    A.setState({ flow: '' });
    ok(!A.renderVals().swapRateShown, 'and no rate line outside a swap');
    A.setState({ flow: 'swap' });
    // offline: no probe at all
    st.rate = RATE;
    const n0 = probe.calls;
    const was = w.FoxyWallet.privacy;
    w.FoxyWallet.privacy = () => Object.assign(was(), { offline: true });
    A._swapProbed = {};
    A.swapProbe('usd');
    await settle();
    ok(probe.calls === n0, 'offline, nothing is probed');
    w.FoxyWallet.privacy = was;
    // typed and left still: one quote in the background, and NEXT takes it without asking
    delete w.FoxyWallet.swapProbe;
    await toAmount('usd');
    w.FoxyWallet._swapPairs = [];
    const n1 = asked.length;
    await type('250');
    await wait(450);
    ok(asked.length === n1, 'typed $ 2.50: nothing asked before it has stood still');
    await wait(300);
    await settle();
    ok(asked.length === n1 + 1 && JSON.stringify(asked[asked.length - 1]) === '["usd","sat",250,false]', 'after 600 ms, its quote, once', JSON.stringify(asked.slice(n1)));
    await next();
    ok(A.state.screen === 'swapConfirm' && A.state.swapQuote && A.state.swapQuote.total === 250 && asked.length === n1 + 1,
      'NEXT: the confirmation, filled, with no new question', String(asked.length - n1));
    b0 = (A.confirmSpec().rows || [])[1] || {};
    ok(b0.value === '$ 2.50 in DOLLARS' && A.confirmSpec().cta === 'SWAP', 'YOU ARE SPENDING $ 2.50 in DOLLARS, and SWAP', b0.value);
    A.setState({ screen: 'home', stack: [] });
    await wait(1200);
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
})().catch((e) => { console.log('THREW', (e && e.stack) || e); process.exit(1); });
