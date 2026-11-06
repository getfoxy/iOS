'use strict';
/* transfer-dollars.js — a transfer between this phone's mints from a mint that holds both balances.
 *
 *     node tests/transfer-dollars.js
 *
 * On 2026-11-03 a transfer from forge (dollars and bitcoin on the phone) to minibits took sats with no question. Now:
 *   1. the wallet moves dollars: `transferQuote(from, sats, { unit: 'usd' })` asks the far mint for an invoice in sats and the
 *      source for its fee quote in cents, and `moveRun` melts the dollar pile into it at that quote; the sat pile at the source
 *      is not touched, and what lands is sats;
 *   2. the transfer screens ask TRANSFER WHICH? on the CURRENCY screen when the source holds both on this phone, and nothing
 *      when it holds one; the keypad is in dollars for a dollar transfer, its cap the dollar pile; the confirmation says the
 *      sats that land and the dollars that leave;
 *   3. a mint that holds only dollars is on the FROM WHICH MINT? list.
 * Part 1 runs the real wallet against two stand-in mints (tests/flashcard-kit.js); part 2 lifts the screens' methods out of
 * build/foxy-app.js. */
const fs = require('fs');
const path = require('path');
const { page, MINT, MINT2 } = require('./flashcard-kit');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e || new Error('rejected with nothing'); } };
const pile = (R, url, unit) => {
  const key = 'foxy.cashu.proofs.' + url + (unit && unit !== 'sat' ? '.' + unit : '');
  return (JSON.parse(R.storage.getItem(key) || '[]') || []).reduce((n, p) => n + Number(p.amount || 0), 0);
};

const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', at + 3 + sig.length - 1), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(at + 3, i + 1);
}

async function run() {
  // ---- 1. the wallet ---------------------------------------------------------------------------------------------------
  console.log('1. dollars at the source, melted into the far mint’s sat invoice');
  {
    const R = page({ second: true, units: ['sat', 'usd'] });
    const W = R.W;
    await W.connect(MINT, null, null, { remember: true });
    await W.claim((await W.invoice(2000, '', { unit: 'usd' })).hash);
    await W.claim((await W.invoice(5000, '')).hash);
    ok(W.balanceOf('usd', MINT) === 2000 && (await W.balanceSats()) === 5000, 'set up: $20.00 and 5,000 sats at A',
       W.balanceOf('usd', MINT) + ' / ' + (await W.balanceSats()));
    await W.connect(MINT2, null, null, { remember: true });
    const plan = await W.transferQuote(MINT, 10000, { unit: 'usd' });
    ok(plan.unit === 'usd' && plan.moving === 10000 && plan.net === 10000, 'the plan is in dollars, for 10,000 sats to land', JSON.stringify({ u: plan.unit, m: plan.moving }));
    ok(plan.gross > 0 && plan.gross === plan.amountUnit + plan.feeUnit && plan.feeUnit >= plan.reserve,
       'what leaves is cents: the quote’s amount and its fee', JSON.stringify({ gross: plan.gross, amount: plan.amountUnit, fee: plan.feeUnit, reserve: plan.reserve }));
    ok(!!plan.rate && plan.rate.usdPerBtc === 76900, 'and the price it was quoted at', JSON.stringify(plan.rate));
    ok(plan.feeSats === 0, 'with no fee said in sats: the sat pile is not what pays', String(plan.feeSats));
    await W.connect(MINT, null, null, {});
    const done = await W.moveRun(plan, () => {});
    ok(done && done.sats === 10000 && pile(R, MINT2) === 10000, '10,000 sats land at B', JSON.stringify(done) + ' / ' + pile(R, MINT2));
    const usdLeft = W.balanceOf('usd', MINT);
    ok(usdLeft >= 2000 - plan.gross && usdLeft < 2000, 'the dollars at A are what paid, no more than the quote said', usdLeft + ' left of 2000, gross ' + plan.gross);
    ok(pile(R, MINT) === 5000, 'and the 5,000 sats at A are untouched', String(pile(R, MINT)));
    // more than the dollars hold: refused in dollars, nothing moved
    await W.connect(MINT2, null, null, {});
    const big = await threw(() => W.transferQuote(MINT, 10000000, { unit: 'usd' }));
    ok(!!big && /\$/.test(big.message) && /you hold/.test(big.message), 'more than the dollar pile is refused, in dollars', big && big.message);
    // a mint with no dollars is refused for a dollar transfer
    const none = await threw(() => W.transferQuote(MINT2, 100, { to: MINT, unit: 'usd' }));
    ok(!!none && /does not issue/.test(none.message), 'a dollar transfer from a mint that issues none is refused', none && none.message);
    // a sat transfer is as it was
    const sat = await W.transferQuote(MINT, 1000);
    ok(!sat.unit && sat.moving === 1000 && sat.feeSats >= 0, 'and a transfer in sats is as it always was', JSON.stringify({ u: sat.unit, m: sat.moving }));
  }

  // ---- 2. the screens --------------------------------------------------------------------------------------------------
  console.log('\n2. TRANSFER WHICH?, the keypad in dollars, and the confirmation');
  const HERE = 'https://forge.test', THERE = 'https://minibits.test', ONE = 'https://one.test';
  const piles = { [HERE]: { sats: 4000, units: [{ unit: 'usd', amount: 950, mint: HERE }] }, [THERE]: { sats: 500, units: [] },
    [ONE]: { sats: 0, units: [{ unit: 'usd', amount: 300, mint: ONE }] } };
  const make = () => {
    const quoted = [];
    global.window = { FoxyWallet: {
      mintUrl: THERE, connect: () => Promise.resolve(),
      transferQuote: (from, sats, o) => { quoted.push({ from, sats, o }); return Promise.resolve({ unit: o && o.unit, gross: 512, feeUnit: 7, amountUnit: 505, moving: sats, net: sats, feeSats: 0 }); },
      reason: (e) => String((e && e.message) || e),
    } };
    const a = new Function('return {' + ['trHeldAt(url) {', 'trPick(url) {', 'trFromSats() {', 'trFromText() {', 'trNext() {', 'quoteTransfer() {',
      'transferSpec() {', 'transferSpecUsd() {', 'fcUnitAsk(then, card, both) {', 'fcPickUnit(o, then) {', 'currencyPick(unit) {'].map(method).join(',\n') + '}')();
    Object.assign(a, {
      quoted, toasts: [],
      state: { screen: 'switchMint', stack: ['home'], trStep: 'from', trUnit: 'sat' },
      setState(x) { Object.assign(this.state, typeof x === 'function' ? x(this.state) : x); },
      toast(m) { this.toasts.push(m); },
      mintPile: (u) => piles[u] || { sats: 0, units: [] },
      mintNameOf: (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\.test$/, ''),
      unitFigure: (n, u) => (u === 'usd' ? '$ ' + (n / 100).toFixed(2) : '₿ ' + n),
      group: (n) => String(n), money: (n) => ({ main: '₿ ' + n, sub: '' }),
      cfRow: (label, value) => ({ label, value }),
      moneyBusy: () => false, refuseSwitchWhileBusy: () => false,
      px: () => 100000, usd: (v) => v.toFixed(2),
      amountInSats() { const v = parseFloat(this.state.amount) || 0; return this.state.unit === 'SATS' ? Math.round(v) : Math.round(v / 100000 * 1e8); },
    });
    return a;
  };
  {
    const a = make();
    a.trPick(HERE);
    const cc = a.state.curCard || {};
    ok(a.state.screen === 'currency' && a.state.currencyFlow === 'card' && cc.question === 'TRANSFER WHICH?',
       'a source holding dollars and bitcoin asks TRANSFER WHICH? on the CURRENCY screen', JSON.stringify({ sc: a.state.screen, q: cc.question }));
    ok(cc.bal && cc.bal.usd === 950 && cc.bal.sat === 4000, 'with what this phone holds of each there', JSON.stringify(cc.bal));
    ok(a.state.trStep === 'from' && !a.state.trFrom, 'and nothing is taken as chosen until it is answered', JSON.stringify({ s: a.state.trStep, f: a.state.trFrom }));
    a.currencyPick('usd');
    ok(a.state.screen === 'switchMint' && a.state.trFrom === HERE && a.state.trUnit === 'usd' && a.state.trStep === 'to',
       'DOLLARS: back to the list, for TO WHICH MINT?, the transfer in dollars', JSON.stringify({ sc: a.state.screen, f: a.state.trFrom, u: a.state.trUnit, s: a.state.trStep }));
    a.trPick(THERE);
    ok(a.state.screen === 'amount' && a.state.flow === 'transfer' && a.state.unit === 'USD', 'the keypad is in dollars', JSON.stringify({ sc: a.state.screen, u: a.state.unit }));
    ok(a.trFromText() === 'From forge · $ 9.50 there' && a.trFromSats() === 950, 'its line says the dollars at the source', a.trFromText());
    a.state.amount = '12.00';
    a.trNext();
    ok(a.toasts.some((t) => /more than the forge balance/.test(t)) && a.state.screen === 'amount', '$12.00 is more than the $9.50 there: refused on the keypad', JSON.stringify(a.toasts));
    a.state.amount = '5.00';
    a.trNext();
    await new Promise((r) => setTimeout(r, 5));
    ok(a.state.screen === 'trConfirm' && a.quoted.length === 1 && a.quoted[0].o && a.quoted[0].o.unit === 'usd' && a.quoted[0].sats === 5000,
       '$5.00 goes to the confirmation, quoted in dollars for the sats it comes to', JSON.stringify(a.quoted));
    const spec = a.transferSpec();
    const row = (l) => (spec.rows.find((r) => r.label === l) || {}).value;
    ok(row('LANDING') === '₿ 5000' && row('LEAVING') === 'UP TO $ 5.12', 'the confirmation: the sats that land and the dollars that leave', JSON.stringify(spec.rows));
    ok(row('FEE') === 'UP TO $ 0.07' && /DOLLARS/.test(row('PAYING FROM')), 'the fee in dollars, paid from the dollars', JSON.stringify(spec.rows));
    // (TRANSFER and the dollars that leave, as the keeper drew it: 1k, 2026-11-06)
    ok(spec.cta === 'TRANSFER $ 5.12' && !spec.ctaBusy, 'and TRANSFER with what leaves, once the quote is in', spec.cta);
  }
  {
    // one balance at the source: nothing asked
    const a = make();
    a.trPick(THERE);
    ok(a.state.screen === 'switchMint' && a.state.trUnit === 'sat' && a.state.trStep === 'to' && !a.state.curCard,
       'a source with bitcoin only asks nothing, and moves sats', JSON.stringify({ sc: a.state.screen, u: a.state.trUnit }));
    const b = make();
    b.trPick(ONE);
    ok(b.state.screen === 'switchMint' && b.state.trUnit === 'usd', 'one with dollars only asks nothing, and moves dollars', JSON.stringify({ sc: b.state.screen, u: b.state.trUnit }));
    b.currencyPick && b.trPick(THERE);
    ok(b.state.unit === 'USD', 'its keypad in dollars', b.state.unit);
    // BITCOIN chosen at a two-balance source: sats, as ever
    const c = make();
    c.trPick(HERE);
    c.currencyPick('sat');
    c.trPick(THERE);
    ok(c.state.trUnit === 'sat' && c.state.unit === 'SATS' && c.trFromSats() === 4000, 'BITCOIN at a two-balance source is a sat transfer from its sats', JSON.stringify({ u: c.state.trUnit, k: c.state.unit }));
  }

  // ---- 3. the list ---------------------------------------------------------------------------------------------------
  console.log('\n3. a mint holding only dollars is one to move from');
  ok(/s\.trStep === 'from'\) \{[\s\S]{0,200}this\.mintPile\(m\.url\)\.sats > 0 \|\| \(this\.mintPile\(m\.url\)\.units \|\| \[\]\)\.some\(b => b && b\.unit === 'usd' && b\.amount > 0\)/.test(src),
     'FROM WHICH MINT? lists a mint with dollars and no sats', 'renderMints');
  ok(/goTransfer\(\) \{[\s\S]{0,900}trUnit: 'sat'/.test(src), 'and every transfer starts in sats until a source says otherwise', 'goTransfer');

  console.log('\n' + (failed ? failed + ' of ' + (passed + failed) + ' transfer-dollars checks FAILED' : 'all ' + passed + ' transfer-dollars checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
