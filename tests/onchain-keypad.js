'use strict';
/* onchain-keypad.js — the keypad of an on-chain send.
 *
 *     node tests/onchain-keypad.js
 *
 * A pasted address with no amount opens SET AMOUNT. It opened in sats where
 * every other amount screen opens in dollars, and it
 * took a figure over the balance and left the refusal to the confirmation, a
 * screen and a fee quote later. The methods are lifted out of
 * build/foxy-app.js and run against a stand-in app, as pay-this-mint.js does. */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  return block(at + 3);
}
const methods = new Function('return {' + [
  'payOnchain(text) {', 'ocNext() {', 'renderContext() {', 'amountInSats() {', 'satUsd() {', 'px() {', 'balNow() {',
].map(method).join(',\n') + '}')();

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok || !detail ? '' : '\n      ' + detail));
};

const ADDRESS = 'bc1qexampleexampleexampleexampleexample00';
function app(state, over) {
  const quotes = [], toasts = [];
  global.window = { FoxyWallet: Object.assign({
    readAddress: (t) => ({ address: ADDRESS, sats: /amount/.test(t) ? 5000 : 0 }),
    onchainQuote(to, sats) { quotes.push(sats); return new Promise(() => {}); },
    amountOf: () => null, reason: (e) => String(e),
  }, over || {}) };
  const a = Object.assign({
    state: Object.assign({ screen: 'sendHow', stack: ['home'], flow: 'send', unit: 'USD', amount: '',
      balSats: 100000, balUsd: 85, livePrice: 85000, ocLimits: { send: { min: 546, max: 0 } } }, state || {}),
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    toast(m) { toasts.push(m); }, onchainAsk() {}, mintName: () => 'a mint', group: (n) => String(n),
    peerRate: () => 0, heldBlocks: () => '',
    quotes, toasts,
  }, methods);
  a.ocQuote = function () { quotes.push(this.state.ocSats); };
  return a;
}

{
  const a = app();
  a.payOnchain(ADDRESS);
  check('an address with no amount opens the keypad', a.state.screen === 'amount' && a.state.flow === 'onchain', JSON.stringify(a.state));
  check('in dollars, like the other amount screens', a.state.unit === 'USD', a.state.unit);
}
{
  const a = app({ livePrice: 0, balUsd: 0 });
  a.payOnchain(ADDRESS);
  check('with no price to turn dollars into sats, it opens in sats', a.state.unit === 'SATS', a.state.unit);
}
{
  const a = app();
  a.payOnchain(ADDRESS + '?amount=0.00005');
  check('an address that names its amount still goes straight to the confirmation',
    a.state.screen === 'ocConfirm' && a.state.ocSats === 5000 && a.quotes.length === 1, JSON.stringify(a.state));
}
{
  // 100,000 sats at $85,000 is $85.00
  const a = app();
  a.payOnchain(ADDRESS);
  a.setState({ amount: '90.00' });
  check('more dollars than the balance is over, on the keypad', a.renderContext().sendOver === true);
  a.ocNext();
  check('and NEXT refuses it, with no fee asked of the mint', a.state.screen === 'amount' && !a.quotes.length && a.toasts.length === 1,
    JSON.stringify({ screen: a.state.screen, quotes: a.quotes, toasts: a.toasts }));
  a.setState({ amount: '50.00' });
  check('an amount within the balance is not over', a.renderContext().sendOver === false);
  a.ocNext();
  check('and goes on to the confirmation', a.state.screen === 'ocConfirm' && a.quotes.length === 1 && a.state.ocSats > 0,
    JSON.stringify({ screen: a.state.screen, quotes: a.quotes }));
}
{
  // in sats, and with no price at all: the cap in dollars cannot see it, the check in sats does
  const a = app({ livePrice: 0, balUsd: 0 });
  a.payOnchain(ADDRESS);
  a.setState({ amount: '100001' });
  a.ocNext();
  check('with no price, one sat over the balance is still refused', a.state.screen === 'amount' && !a.quotes.length, JSON.stringify(a.toasts));
  a.setState({ amount: '100000' });
  a.ocNext();
  check('and the whole balance is let through to the confirmation, which adds the fee', a.state.screen === 'ocConfirm');
}
{
  const page = fs.readFileSync(require('path').join(__dirname, '..', 'build', 'app', '23-render-home-and-amount.js'), 'utf8');
  check('the keypad\'s NEXT does nothing on chain while the amount is over',
    /flow === 'onchain'\) \{ if \(!sendOver\) this\.ocNext\(\); return; \}/.test(page));
}

console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
