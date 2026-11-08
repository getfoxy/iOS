'use strict';
/* swap-dollars.js — a swap's amount in dollars or sats, and its confirmation's four blocks.
 *
 *     node tests/swap-dollars.js
 *
 * SWAP at a mint with dollars and bitcoin (build/app/26i-swap.js), drawn by the real page (build/foxy-render.js, as
 * tests/two-balances-swap.js part 2 mounts it) on a stand-in wallet whose rate is fixed, so every figure is known.
 *
 * The amount: SET AMOUNT starts in dollars whichever way the swap goes, and the ⇅ turns it to sats and back as a
 * send's does, at the mint's last rate. What is typed is what arrives, never converted at the phone's price: typed
 * in the unit that arrives it is the invoice (`get`); typed in the unit that leaves it is what the mint values what
 * arrives at (`worth`). The mint's fee goes on top. With no price the ⇅ is refused and the unit that leaves stays.
 * NOT ENOUGH when the balance cannot cover the figure and the fee, with what would fit once the mint has said; ALL OF IT is the whole
 * balance that leaves; a switch after a rate was asked drops that rate.
 *
 * The confirmation: RECEIVING, FEE, SPENDING, and the mint's RATE, in that order, both ways round, at a rate of
 * $ 82,601: RECEIVING is the figure typed, a bitcoin figure is its dollar worth with its sats under it, a dollar
 * figure has no sats line, the fee is what leaves less what arrives, SPENDING the two together, the heading names
 * the mint, and "Rate held for" counts down on a clock that stops when the screen goes and when the rate lapses. */
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

  /* The stand-in: a mint that keeps 5% of what leaves, at $ 82,601. One dollar arriving in dollars costs 1,211 sats
   * and the fee on top (₿ 1,275 in all); one dollar of bitcoin (₿ 1,210) costs $ 1.05. `hold` keeps the next answer
   * back until let go. `rate` is the mint's own (its last, and the one it quotes at), which can be moved off the
   * market's; 0 is a mint that has given none. As the wallet's `swapQuote`: `get` is what arrives, `worth` what the
   * mint values it at, and all of it (or neither) what leaves. */
  const st = { usd: 4205, sat: 50000, host: 'forge.example.com', hold: null, rate: RATE };
  const asked = [];
  const quote = (from, to, given, opts) => {
    const r = st.rate || RATE;
    const o = opts || {};
    const toFrom = (n) => (from === 'usd' ? Math.ceil(n * r / 1e6) : Math.ceil(n * 1e6 / r));
    const fromTo = (n) => (from === 'usd' ? Math.floor(n * 1e6 / r) : Math.floor(n * r / 1e6));
    let total, amount, get;
    if (o.get) { get = given; amount = toFrom(get); total = Math.round(amount / 0.95); }
    else if (o.worth) { amount = given; get = fromTo(amount); total = Math.round(amount / 0.95); }
    else { total = given; amount = Math.round(given * 0.95); get = fromTo(amount); }
    return {
      id: 'uswap-' + asked.length, mint: 'https://' + st.host, from, to, total, amount, fee: total - amount, get,
      mode: o.get ? 'get' : o.worth ? 'worth' : '', asked: given, inputFee: 0, spend: total,
      rate: { usdPerBtc: r, by: st.host }, market: RATE, spread: 0, spreadWarn: false,
      expiresAt: Date.now() + 67500, state: 'quoted',
    };
  };
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
      asked.push([from, to, amount, opts && opts.all ? true : opts && opts.get ? 'get' : opts && opts.worth ? 'worth' : false]);
      const q = quote(from, to, amount, opts);
      if (st.hold) return new Promise((r) => { st.hold.push(() => r(q)); });
      return Promise.resolve(q);
    },
    swapRun() { return new Promise(() => {}); },
    // the wallet's guess (16b-two-balances.js `swapGuess`), for this stand-in's 5%
    swapGuess(from, to, n, mode, have) {
      const r = st.rate || RATE;
      const per = from === 'usd' ? r / 1e6 : 1e6 / r;
      const need = Math.ceil((mode === 'get' ? n * per : n) / 0.95);
      const part = have * 0.95;
      return { need, fits: Math.floor(mode === 'get' ? part / per : part) };
    },
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

  // bitcoin into dollars, typed in dollars: $ 1.00 arrives, exactly, whatever the price
  await type('100');
  ok(/\$ 1\.00/.test(text()) && /≈ ₿ 1,211/.test(text()), 'typed $ 1.00, the line under it says about ₿ 1,211', text().slice(0, 300));
  ok(A.swapTyped() === 100 && A.swapMode() === 'get', 'swapTyped is 100 cents, to arrive', A.swapTyped() + ' ' + A.swapMode());
  A.setState({ livePrice: 50000, satUsd: 50000 / 1e8 });
  ok(A.swapTyped() === 100, 'whatever the price is doing');
  A.setState(PRICE);
  await next();
  ok(A.state.screen === 'swapConfirm' && JSON.stringify(asked[asked.length - 1]) === '["sat","usd",100,"get"]',
    'NEXT asks the mint for an invoice of 100 cents', JSON.stringify(asked[asked.length - 1]));
  ok(A.state.swapAmount === 100 && A.state.swapMode === 'get', 'and the swap is for those cents to arrive');

  // bitcoin into dollars, typed in sats: what those sats are worth at the mint arrives
  await toAmount('sat');
  await toggle();
  await type('1211');
  ok(A.swapTyped() === 1211 && A.swapMode() === 'worth' && /≈ \$ 1\.00/.test(text()), 'typed ₿ 1,211 in sats: 1,211 exactly, and about what it is worth under it', text().slice(0, 300));
  A.setState({ livePrice: 50000, satUsd: 50000 / 1e8 });
  ok(A.swapTyped() === 1211, 'whatever the price is doing');
  A.setState(PRICE);
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["sat","usd",1211,"worth"]', 'and NEXT asks for ₿ 1,211 worth of dollars', JSON.stringify(asked[asked.length - 1]));

  // dollars into bitcoin, typed in sats: those sats arrive
  await toAmount('usd');
  await toggle();
  ok(A.state.unit === 'SATS', 'dollars into bitcoin: the ⇅ to sats');
  await type('1211');
  ok(A.swapTyped() === 1211 && A.swapMode() === 'get' && /≈ \$ 1\.00/.test(text()), 'typed ₿ 1,211: those sats to arrive, about $ 1.00 under', text().slice(0, 300));
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",1211,"get"]', 'NEXT asks for an invoice of ₿ 1,211', JSON.stringify(asked[asked.length - 1]));

  // dollars into bitcoin, typed in dollars: $ 1.00 of bitcoin, whatever the price
  await toAmount('usd');
  await type('100');
  A.setState({ livePrice: 50000, satUsd: 50000 / 1e8 });
  ok(A.swapTyped() === 100 && A.swapMode() === 'worth', 'typed $ 1.00 in dollars: $ 1.00 of bitcoin, whatever the price');
  A.setState(PRICE);
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",100,"worth"]', 'NEXT asks for $ 1.00 of bitcoin', JSON.stringify(asked[asked.length - 1]));

  /* Sats typed are sats: nothing is cut or rounded into cents on the phone (the mint's quote says what they are
   * worth). The ⇅ still writes them as the cents it shows: at a mint rate of $ 82,000, 750 sats are 61.5 cents, which
   * the ⇅ writes as $ 0.61. */
  await toAmount('usd');
  await toggle();
  await type('1000');
  ok(A.swapTyped() === 1000, 'typed ₿ 1,000: 1,000 sats, as typed', String(A.swapTyped()));
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",1000,"get"]', 'and NEXT asks for ₿ 1,000 to arrive', JSON.stringify(asked[asked.length - 1]));
  st.rate = 82000;
  await toAmount('usd');
  await toggle();
  await type('750');
  await toggle();
  ok(A.state.unit === 'USD' && A.state.amount === '0.61', 'the ⇅ shows ₿ 750 as $ 0.61', A.state.amount);
  st.rate = RATE;

  /* The mint's rate off the market's: $ 80,000 at the mint, $ 82,601 on the market. The ⇅ and the line under the
   * figure use the mint's, and the confirmation repeats the figure typed at the mint's own quote. */
  st.rate = 80000;
  await toAmount('sat');
  await type('100');
  ok(A.swapTyped() === 100 && /≈ ₿ 1,250/.test(text()), 'mint at $ 80,000: $ 1.00 is about ₿ 1,250 (not the market’s 1,211)', A.swapTyped() + ' ' + text().slice(0, 200));
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["sat","usd",100,"get"]', 'NEXT asks for $ 1.00 to arrive', JSON.stringify(asked[asked.length - 1]));
  b0 = (A.confirmSpec().rows || [])[0] || {};
  ok(b0.label === 'RECEIVING' && b0.value === '$ 1.00 in DOLLARS', 'and the confirmation repeats RECEIVING $ 1.00 in DOLLARS', b0.value);
  await toAmount('usd');
  await type('100');
  await toggle();
  ok(A.state.unit === 'SATS' && A.state.amount === '1250', 'dollars leaving: the ⇅ turns $ 1.00 into ₿ 1,250 at the mint’s rate', A.state.amount);
  await toggle();
  await next();
  ok(JSON.stringify(asked[asked.length - 1]) === '["usd","sat",100,"worth"]', 'and NEXT asks for $ 1.00 of bitcoin', JSON.stringify(asked[asked.length - 1]));
  b0 = (A.confirmSpec().rows || [])[0] || {};
  ok(b0.value === '$ 1.00 in BITCOIN' && b0.sub === '(₿ 1,250)', 'the confirmation repeats $ 1.00 in BITCOIN (₿ 1,250)', b0.value + ' ' + b0.sub);
  // a mint that has given no rate: the market's, for the line under the figure only
  st.rate = 0;
  await toAmount('sat');
  await type('100');
  ok(A.swapTyped() === 100 && /≈ ₿ 1,211/.test(text()), 'a mint with no rate yet: about ₿ 1,211 at the market’s', A.swapTyped() + ' ' + text().slice(0, 200));
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

  // the figure and the fee on top are more than the balance, both ways: NOT ENOUGH, with what would fit
  await toAmount('sat');
  await type('4000');
  v = A.renderVals();
  ok(v.sendOverShown === '1' && v.sendOverLabel === 'NOT ENOUGH', '$ 40.00 and the fee are more than ₿ 50,000: NOT ENOUGH, no figure from a guess', v.sendOverLabel);
  let n = asked.length;
  await next();
  ok(A.state.screen === 'amount' && asked.length === n, 'and NEXT does not take it');
  await type('3900');
  ok(A.renderVals().sendOverShown === '0', '$ 39.00 and the fee are not');
  ok(A.renderVals().amtAltLabel === 'ALL OF IT (₿ 50,000)', 'ALL OF IT is the whole bitcoin balance, in sats, typed in dollars or not', A.renderVals().amtAltLabel);
  A.renderVals().amtAltTap();
  await settle();
  ok(JSON.stringify(asked[asked.length - 1]) === '["sat","usd",50000,true]', 'and asks for all 50,000 sats', JSON.stringify(asked[asked.length - 1]));
  await toAmount('usd');
  await toggle();
  await type('60000');
  v = A.renderVals();
  ok(v.sendOverShown === '1' && v.sendOverLabel === 'NOT ENOUGH', '₿ 60,000 and the fee are more than $ 42.05: NOT ENOUGH', v.sendOverLabel);
  await type('48000');
  ok(A.renderVals().sendOverShown === '0', '₿ 48,000 and the fee are not');
  await toggle();
  await type('4300');
  ok(A.renderVals().sendOverLabel === 'NOT ENOUGH', 'typed in dollars, $ 43.00 of bitcoin: NOT ENOUGH', A.renderVals().sendOverLabel);
  // the mint's own answer for these keys names what would fit
  A._swapShortFor = { keypad: A.swapKeypad(), from: 'usd', mint: A.swapMintHere(), fits: 3994 };
  A.setState({ swapTick: Date.now() });
  ok(A.renderVals().sendOverLabel === 'NOT ENOUGH · UP TO $ 39.94', 'and once the mint has said, up to its figure: $ 39.94', A.renderVals().sendOverLabel);
  A._swapShortFor = null;
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
  ok(!!A.state.swapQuote && A.state.swapQuote.get === 1211, 'NEXT asks again, for the new figure to arrive');
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

  // bitcoin into dollars: $ 1.00 to arrive
  await toAmount('sat');
  await type('100');
  await next();
  let b = blocks();
  ok(said(b.slice(0, 3)) === JSON.stringify([
    ['RECEIVING', '$ 1.00 in DOLLARS', ''],
    ['FEE', '$ 0.05', '(₿ 64)'],
    ['SPENDING', '$ 1.05 in BITCOIN', '(₿ 1,275)'],
  ]), 'bitcoin into dollars: RECEIVING $ 1.00 in DOLLARS, FEE $ 0.05 (₿ 64), SPENDING $ 1.05 in BITCOIN (₿ 1,275)', said(b));
  ok(b[3][0] === 'FORGE’S RATE' && b[3][1] === '₿ 1 = $ 82,601' && /^Rate held for 00:5\d$/.test(b[3][2]),
    'then FORGE’S RATE, ₿ 1 = $ 82,601, Rate held for 00:5x', said(b));
  let t = text();
  ok(/SWAP RECEIVING \$ 1\.00 in DOLLARS FEE \$ 0\.05 \(₿ 64\) SPENDING \$ 1\.05 in BITCOIN \(₿ 1,275\) FORGE’S RATE ₿ 1 = \$ 82,601 Rate held for 00:5\d SWAP$/.test(t),
    'the page draws the four blocks in that order, and nothing else between the title and SWAP', t.slice(0, 400));
  ok(!/TOTAL|NETWORK|FEE INCLUDED|YOU GET |YOU ARE /.test(t), 'no TOTAL, NETWORK, FEE INCLUDED, YOU GET or YOU ARE left over');
  const q1 = A.state.swapQuote;
  ok(Math.round(q1.total * RATE / 1e6) - q1.get === 5, 'the fee is what leaves less what arrives, at the rate: 105 − 100 cents');

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

  // dollars into bitcoin: $ 1.00 of bitcoin
  await toAmount('usd');
  await type('100');
  await next();
  b = blocks();
  ok(said(b.slice(0, 3)) === JSON.stringify([
    ['RECEIVING', '$ 1.00 in BITCOIN', '(₿ 1,210)'],
    ['FEE', '$ 0.05', '(₿ 61)'],
    ['SPENDING', '$ 1.05 in DOLLARS', ''],
  ]), 'dollars into bitcoin: RECEIVING $ 1.00 in BITCOIN (₿ 1,210), FEE $ 0.05 (₿ 61), SPENDING $ 1.05 in DOLLARS', said(b));
  t = text();
  ok(/SWAP RECEIVING \$ 1\.00 in BITCOIN \(₿ 1,210\) FEE \$ 0\.05 \(₿ 61\) SPENDING \$ 1\.05 in DOLLARS FORGE’S RATE ₿ 1 = \$ 82,601 Rate held for 00:5\d SWAP$/.test(t),
    'the page draws them in that order', t.slice(0, 400));
  ok((t.match(/\(₿ [\d,]+\)/g) || []).length === 2, 'two sats lines, under the bitcoin and the fee, and none under the dollars');
  const q2 = A.state.swapQuote;
  ok(q2.total - Math.round(q2.get * RATE / 1e6) === 5, 'the fee is what leaves less what arrives: 105 − 100 cents');
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
  ok(said(b) === JSON.stringify([['RECEIVING', '$ 1.00 in BITCOIN', ''], ['FEE', 'UNKNOWN', ''], ['SPENDING', 'UNKNOWN', ''], ['FORGE’S RATE', 'UNKNOWN', '']]),
    'with no rate the blocks stay: the $ 1.00 of bitcoin asked for, and UNKNOWN', said(b));
  /* Bitcoin to arrive, typed in sats, with no rate in hand: its dollars at the mint's last rate, the sats under it,
   * as the keypad had it; and with no price at all, the sats alone, with no unit word after them. */
  A.setState({ swapFrom: 'usd', swapTo: 'sat', swapAmount: 1211, swapMode: 'get' });
  b = blocks();
  ok(said([b[0]]) === JSON.stringify([['RECEIVING', '$ 1.00 in BITCOIN', '(₿ 1,211)']]),
    'bitcoin to arrive, rate run out: RECEIVING $ 1.00 in BITCOIN (₿ 1,211)', said(b));
  st.rate = 0;
  A.setState({ livePrice: null, satUsd: null });
  b = blocks();
  ok(said([b[0]]) === JSON.stringify([['RECEIVING', '₿ 1,211', '']]), 'and with no price at all: ₿ 1,211 alone', said(b));
  st.rate = RATE;
  A.setState(Object.assign({ swapFrom: 'usd', swapTo: 'sat', swapMode: 'worth' }, PRICE));
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
    ok(probe.calls === 1 && /How much to swap\?/.test(text()) && !/Checking the rate|RATE ₿|MARKET PRICE/.test(text()), 'SET AMOUNT, the probe out: the question alone, no rate line under it (the keeper, 2026-11-08)', text().slice(0, 200));
    probe.hold();
    await settle();
    ok(/How much to swap\?/.test(text()) && !/RATE ₿|MARKET PRICE/.test(text()) && !A.renderVals().swapRateShown, 'its answer: still no rate line there, nor Forge’s rate', text().slice(0, 200));
    // the probe refused, and the mint with no rate: the market price, said to be the market's
    st.rate = 0;
    w.FoxyWallet.swapProbe = () => { probe.calls += 1; return Promise.reject(new Error('the mint did not answer')); };
    toasts.length = 0;
    A.setState({ screen: 'home', stack: [] });
    A.goSwap();
    A.renderVals().swapNextGo();
    await settle();
    ok(/How much to swap\?/.test(text()) && !/RATE ₿|MARKET PRICE/.test(text()) && !toasts.length, 'a probe that failed: no market price line either, and nothing said about it', text().slice(0, 200));
    A.setState({ screen: 'swap', stack: ['home'] });
    ok(A.renderVals().swapFoot === '' && !/before anything moves/.test(text()), 'the swap screen has no line about the rate and the fee before anything moves', text().slice(0, 300));
    A.setState({ screen: 'amount', stack: ['home'] });
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
    ok(asked.length === n1 + 1 && JSON.stringify(asked[asked.length - 1]) === '["usd","sat",250,"worth"]', 'after 600 ms, its quote, once', JSON.stringify(asked.slice(n1)));
    await next();
    ok(A.state.screen === 'swapConfirm' && A.state.swapQuote && A.state.swapQuote.amount === 250 && asked.length === n1 + 1,
      'NEXT: the confirmation, filled, with no new question', String(asked.length - n1));
    b0 = (A.confirmSpec().rows || [])[0] || {};
    ok(b0.value === '$ 2.50 in BITCOIN' && A.confirmSpec().cta === 'SWAP', 'RECEIVING $ 2.50 in BITCOIN, and SWAP', b0.value);
    A.setState({ screen: 'home', stack: [] });
    await wait(1200);
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
})().catch((e) => { console.log('THREW', (e && e.stack) || e); process.exit(1); });
