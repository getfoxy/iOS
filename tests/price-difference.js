'use strict';
/* price-difference.js — a payment across units, and whose fee is whose.
 *
 *     node tests/price-difference.js
 *
 * The owner's rules (2026-10-16):
 *
 *   C14. When a payment crosses units (a dollar holder paying an ask in sats,
 *        or the reverse), the big number is the unit the payer holds, and one
 *        line under it names the difference from what the ask would be at the
 *        asker's price, with both prices' ages: "$ 0.05 more than asked: their
 *        rate differs from yours, theirs from 3 hours ago". At 2 % or more
 *        between the prices the line is amber. A payment in one unit shows
 *        none of it, nor one where the asker's price is not carried. A price
 *        more than a day old is refused for a payment across units.
 *
 *   C16. Same currency at the same mint: no Foxy fee, and nothing said. Across
 *        currencies or mints: "You pay the mint’s fees", with the amount, on
 *        the FEE row of every confirmation that has one.
 *
 * The app's own methods, lifted out of build/foxy-app.js as price-age.js does,
 * with a stand-in for the rest of the app; and the wallet as it ships for the
 * one-day rule.
 */
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
const method = (sig) => {
  const at = appSrc.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = appSrc.indexOf('{', at + sig.length - 1), depth = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appSrc.slice(at + 3, i + 1);
};
const COMMON = ['priceDiffLine(o) {', 'agoWords(ms) {', 'priceAgeWords(ms) {', 'cfRow(label, value, opt) {', 'group(n) {', 'usd(v) {',
  'unitFigure(amount, unit) {', 'money(sats, fiatCents) {'];
const lift = (W, sigs) => new Function('window', 'PRICE_STANDS_MS', 'return {' + COMMON.concat(sigs).map(method).join(',\n') + '}')(
  { FoxyWallet: W }, 3 * 60 * 1000);
const app = (W, sigs, extra) => Object.assign(lift(W, sigs), {
  state: { screen: 'home', stack: [] },
  setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
  toast() {}, back() {}, satUsd: () => 0.001, px: () => 100000,
}, extra || {});
const row = (spec, label) => (spec.rows || []).find((r) => r.label === label) || null;
const FEES = 'You pay the mint’s fees';

const HOUR = 3600 * 1000;
let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};

async function run() {
  console.log('C14. the line');
  {
    const t = app({}, []);
    ok(t.priceDiffLine({ askUnit: 'sat', askAmount: 10000, payUnit: 'sat', askerRate: 100000, payerRate: 104000 }) === null,
      'a payment in one unit: no line, whatever the prices');
    ok(t.priceDiffLine({ askUnit: 'sat', askAmount: 10000, payUnit: 'usd', askerRate: 0, payerRate: 104000 }) === null,
      'no price from the asker: no line');
    ok(t.priceDiffLine({ askUnit: 'sat', askAmount: 10000, payUnit: 'usd', askerRate: 100000, payerRate: 100050 }) === null,
      'under a tenth of a percent apart is the same price: no line');
    const a = t.priceDiffLine({ askUnit: 'sat', askAmount: 10000, payUnit: 'usd', askerRate: 100000, askerAgeMs: 3 * HOUR,
      payerRate: 100500, payerAgeMs: 60000 });
    ok(!!a && a.text === '$ 0.05 more than asked: their rate differs from yours, theirs from 3 hours ago' && a.amber === false,
      'dollars for an ask of 10,000 sats, the payer’s price half a percent higher: the owner’s line, plain', JSON.stringify(a));
    const b = t.priceDiffLine({ askUnit: 'usd', askAmount: 500, payUnit: 'sat', askerRate: 97000, askerAgeMs: 0,
      payerRate: 100000, payerAgeMs: 5 * HOUR });
    ok(!!b && b.text === '$ 0.15 less than asked: their rate differs from yours, yours from 5 hours ago' && b.amber === true,
      'sats for $ 5.00, the payer’s price 3 % above theirs: fewer sats than they would ask, and amber', JSON.stringify(b));
    const c = t.priceDiffLine({ askUnit: 'sat', askAmount: 10000, payUnit: 'usd', askerRate: 100000, payerRate: 102000 });
    ok(!!c && c.amber === true && /^\$ 0\.20 more/.test(c.text), 'at 2 % exactly it is amber', JSON.stringify(c));
    const d = t.priceDiffLine({ askUnit: 'sat', askAmount: 10000, payUnit: 'usd', askerRate: 100000, payerRate: 101990 });
    ok(!!d && d.amber === false, 'just under 2 %: plain', JSON.stringify(d));
    const e = t.priceDiffLine({ askUnit: 'usd', askAmount: 500, payUnit: 'sat', askerRate: 103000, askerAgeMs: 2 * HOUR,
      payerRate: 100000, payerAgeMs: 30000, side: 'ask' });
    ok(!!e && e.text === '$ 0.15 more than asked: their rate differs from yours, yours from 2 hours ago',
      'on the asker’s screen "their" is the payer’s price and "yours" its own', JSON.stringify(e));
    // a difference that comes to less than a cent names no sum (it used to read "$ 0.01")
    ok(t.priceDiffLine({ askUnit: 'sat', askAmount: 100, payUnit: 'usd', askerRate: 100000, payerRate: 100500 }) === null,
      'under a cent of difference: no line, not "$ 0.01"');
  }

  console.log('C14. the mint’s cent rounding is not a price difference');
  {
    const t = app({}, []);
    // the rate CONFIRM PAYMENT works out from the mint's quote: whole cents, rounded up, over the invoice's sats
    const quoted = (sats, cents) => t.priceDiffLine({ askUnit: 'sat', askAmount: sats, payUnit: 'usd', askerRate: 100000,
      payerRate: Math.round(cents / 100 / (sats / 1e8)), ownWord: 'the mint’s', slackCents: 1 });
    ok(quoted(333, 34) === null, '333 sats quoted at 34¢ at the same price: no line (it was amber, 2.1 %)', JSON.stringify(quoted(333, 34)));
    ok(quoted(150, 16) === null, '150 sats quoted at 16¢: no line (it was amber, 6.7 %)', JSON.stringify(quoted(150, 16)));
    ok(quoted(10000, 1001) === null, '10,000 sats quoted at $ 10.01: no line', JSON.stringify(quoted(10000, 1001)));
    const real = quoted(333, 35);
    ok(!!real && real.amber === true && /^\$ 0\.02 more than asked/.test(real.text),
      'a mint 3 % dearer on 333 sats: the line, amber, naming the whole difference', JSON.stringify(real));
    const big = quoted(10000, 1050);
    ok(!!big && big.text.indexOf('$ 0.50 more than asked') === 0 && big.amber === true, 'and on $ 10.50 the figure is as it was', JSON.stringify(big));
    ok(/slackCents: 1/.test(method('confirmTwoSpec() {')), 'CONFIRM PAYMENT allows the quote its cent');
  }

  console.log('C14. CONFIRM PAYMENT: dollars paying a bitcoin invoice over a tap');
  {
    const W = { amountOf: () => 10000, payNeed: () => ({ ok: true }) };
    const two = (extra) => app(W, ['confirmTwoSpec() {'], Object.assign({
      walletNow: () => 'usd', connecting: () => false, sendToAsk: () => false, feeWaits: () => false, quoteFits: () => true,
      sendToText: () => 'LNBC…', mintName: () => 'Forge', walletLabel: () => 'DOLLARS', openWalletPick() {},
      sendAmountText: () => '₿ 10,000', typedSats: () => 0, startSend() {}, unitBalance: () => 0, heldBlocks: () => '',
      unitWord: (u) => (u === 'usd' ? 'DOLLARS' : 'BITCOIN'),
    }, extra || {}));
    const t = two();
    t.state = { screen: 'sendConfirm', stack: [], recipientKind: 'invoice', recipient: 'lnbc1x', note: '',
      feeQ: { usd: { amount: 1050, feeReserve: 3, rate: { usdPerBtc: 105000 } } },
      askRate: 100000, askRateAt: Date.now() - 1000, askRateFor: 'lnbc1x' };
    const spec = t.confirmTwoSpec();
    ok(spec.amount === '$ 10.53' && !!spec.diffLine
      && spec.diffLine.text === '$ 0.50 more than asked: their rate differs from the mint’s' && spec.diffLine.amber === true,
      'the dollars that pay are the big number, and the line weighs the mint’s rate against theirs (5 %: amber)',
      spec.amount + ' ' + JSON.stringify(spec.diffLine));
    ok(row(spec, 'FEE INCLUDED') && row(spec, 'FEE INCLUDED').value === '$ 0.03' && row(spec, 'FEE INCLUDED').sub2 === FEES,
      'and its fee row says whose fees they are', JSON.stringify(row(spec, 'FEE INCLUDED')));
    t.state.askRateFor = 'lnbc-another';
    ok(!t.confirmTwoSpec().diffLine, 'a rate carried for another invoice is not this one’s');
    t.state.askRateFor = 'lnbc1x';
    t.walletNow = () => 'sat';
    t.state.feeQ = { sat: { amount: 10000, feeReserve: 10 } };
    ok(!t.confirmTwoSpec().diffLine, 'bitcoin paying a bitcoin invoice is one unit: no line');
  }

  console.log('C14. the request in dollars, paid in sats');
  {
    const stub = { sendShortfall: () => ({ short: false, fee: 0, need: 0, have: 0 }), mintUrl: 'https://m.test' };
    const conf = (state, extra) => {
      const a = app(stub, ['requestSpec() {'], Object.assign({
        peerRateRow: () => [], connecting: () => false, requestNeedsRoute: () => false, offlineNow: () => false,
        mintName: () => 'Forge', requestHere: () => true, heldBlocks: () => '', unitBalance: () => 0,
        editSendNote() {}, makeTokenForRequest() {},
      }, extra || {}));
      a.state = Object.assign({ screen: 'reqOffer', stack: [], balSats: 100000, tapCode: '4242' }, state);
      return a.requestSpec();
    };
    const agreed = conf({ req: { id: 'agreed-1', unit: 'sat', sats: 5000, mints: ['https://m.test'], transports: [], viaTap: true },
      tapQuoteFor: 'agreed-1', tapQuoteUsd: 500, tapQuoteRate: 100000, tapQuoteAgeMs: 60000 });
    ok(agreed.amount === '₿ 5,000' && agreed.amountSub === '$ 5.00' && agreed.cta === 'SEND ₿ 5,000',
      'the sats this phone holds are the big number, the dollars asked under them, and the button says the sats',
      agreed.amount + ' / ' + agreed.amountSub + ' / ' + agreed.cta);
    ok(!agreed.diffLine, 'a request in dollars carries no price of the asker’s, so there is no line');
    ok(row(agreed, 'FEE') && row(agreed, 'FEE').sub2 === FEES && row(agreed, 'FEE').value === '$ 0.00',
      'across units the FEE row stays, with the amount and whose fees they are', JSON.stringify(row(agreed, 'FEE')));
    const plain = conf({ req: { id: 'plain-1', unit: 'sat', sats: 5000, mints: ['https://m.test'], transports: [], viaTap: true } });
    ok(plain.amount === '$ 5.00' && !row(plain, 'FEE') && !plain.diffLine,
      'sats for sats at this mint: dollars first as ever, no line, and no FEE row: no Foxy fee, nothing said',
      plain.amount + ' ' + JSON.stringify(plain.rows.map((r) => r.label)));
    const feeStub = { sendShortfall: () => ({ short: false, fee: 2, need: 5002, have: 100000 }), mintUrl: 'https://m.test' };
    const a2 = app(feeStub, ['requestSpec() {'], {
      peerRateRow: () => [], connecting: () => false, requestNeedsRoute: () => false, offlineNow: () => false,
      mintName: () => 'Forge', requestHere: () => true, heldBlocks: () => '', unitBalance: () => 0, editSendNote() {}, makeTokenForRequest() {},
    });
    a2.state = { screen: 'reqOffer', stack: [], balSats: 100000, tapCode: '4242',
      req: { id: 'plain-2', unit: 'sat', sats: 5000, mints: ['https://m.test'], transports: [], viaTap: true } };
    const charged = a2.requestSpec();
    ok(row(charged, 'FEE') && row(charged, 'FEE').value === '< $ 0.01' && row(charged, 'FEE').sub2 === FEES,
      'a mint that takes a fee for the pieces: the row is back, with the amount, and it is the mint’s', JSON.stringify(row(charged, 'FEE')));
  }

  console.log('C14. the asker’s screen: BITCOIN PRICE');
  {
    const t = app({}, ['priceSpec() {'], { offlineNow: () => true, priceAnswer() {} });
    t.state.priceQ = { sats: 5000, usd: 500, theirRate: 100000, myRate: 103000, myRateAgeMs: 2 * HOUR, theirAgeMs: 30000,
      differsPct: (100000 - 103000) / 103000 * 100 };
    const spec = t.priceSpec();
    ok(!!spec.diffLine && spec.diffLine.text === '$ 0.15 more than asked: their rate differs from yours, yours from 2 hours ago'
      && spec.diffLine.amber === true, 'a request in dollars answered in sats: the line, amber at 2.9 %', JSON.stringify(spec.diffLine));
    t.state.priceQ = Object.assign({}, t.state.priceQ, { side: 'pay' });
    ok(!t.priceSpec().diffLine, 'the payer’s side of that screen is sats for sats: no line');
    t.state.priceQ = Object.assign({}, t.state.priceQ, { side: undefined, differsPct: null, myTooOld: true });
    ok(!t.priceSpec().diffLine, 'this phone’s price over a day old is no yardstick: no line');
  }

  console.log('C14. a day is the limit, across units');
  {
    const phone = nativePhone({ words: PHONE_WORDS });
    let mint = null;
    const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
    const ctx = loadReal({
      bridge: (w, m) => {
        if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
        const got = phone.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => { phone.attach(w); mint = fakeMint(w, { units: ['sat', 'usd'], p2pk: true }); },
    });
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    await ctx.W.connect('https://m.test', null, null, { remember: true });
    const W = ctx.W;
    W._rate = 100000; W._rateAt = Date.now() - 25 * HOUR;
    ok(W.quoteFor({ id: 'r', usd: 500, sats: 0 }) === null && W.quoteFor({ id: 'r', unit: 'usd', amount: 500 }) === null,
      'sats for a dollar ask: a price 25 hours old makes no quote (`quoteFor`)');
    ok(W.centsFor(5000) === null, 'a dollar card for a sat ask: no cents from a price 25 hours old (`centsFor`)');
    W._rateAt = Date.now() - 23 * HOUR;
    ok(!!W.quoteFor({ id: 'r', usd: 500, sats: 0 }) && !!W.centsFor(5000), '23 hours: both still answer');
    const q = W.readQuote(JSON.stringify({ id: 'r', usd: 500, sats: 5000, rate: 100000, ageMs: 25 * HOUR }));
    ok(!!q && q.tooOld === true, 'and their price 25 hours old reads as too old on the asker’s side (`readQuote`)');
  }

  console.log('C16. whose fee, on every FEE row');
  {
    const t = app({}, ['crossSpec() {'], { crossAnswer() {} });
    t.state.crossQ = { net: 5000, fee: 20, them: 'n.test', mine: 'm.test' };
    t.peerRateRow = () => [];
    const cs = t.crossSpec();
    ok(row(cs, 'FEE') && !row(cs, 'SWAP FEE') && row(cs, 'FEE').value === '$ 0.02' && row(cs, 'FEE').sub2 === FEES,
      'paying at another mint: FEE, with the amount, the mint’s fees', JSON.stringify(cs.rows.map((r) => [r.label, r.value, r.sub2])));
    const tr = app({}, ['transferSpec() {'], { mintNameOf: (u) => String(u || '').replace(/^https?:\/\//, ''), trCancel() {}, runTransfer() {}, quoteTransfer() {}, trMoveLess() {} });
    tr.state = { screen: 'trConfirm', stack: [], trSats: 5000, trFee: 30, trFrom: 'https://m.test', trTo: 'https://n.test' };
    const ts = tr.transferSpec();
    ok(row(ts, 'FEE') && !row(ts, 'FEE ON TOP') && row(ts, 'FEE').value === 'UP TO $ 0.03' && row(ts, 'FEE').sub2 === FEES,
      'moving money between mints: the same row in the same words', JSON.stringify(ts.rows.map((r) => [r.label, r.value, r.sub2])));
    const src = (sig) => method(sig);
    ok(src('confirmSpec() {').indexOf("this.cfRow('FEE', s.quotedFee != null") >= 0 && /sub2: 'You pay the mint\\u2019s fees'/.test(src('confirmSpec() {')),
      'a Lightning payment, and paying from a card (SEND): the FEE row says the mint’s fees');
    // SWAP is left as the owner drew it: four blocks and nothing between (tests/swap-dollars.js), and the fee is in one of them
    ok(/block\('FEE', fee, ''\)/.test(src('swapSpec() {')), 'a swap between dollars and bitcoin keeps its FEE block as drawn');
    ok((src('onchainSpec() {').match(/sub2: 'You pay the mint\\u2019s fees'/g) || []).length === 2, 'and paying on chain');
    ok(!/with its fee\.'|with the fee'/.test(src('confirmSpec() {') + src('requestSpec() {') + src('onchainSpec() {')),
      'refusals for fees say the mint’s fees, as the rows do');
    // and the wallet's own refusals under those rows: moving between mints, and a payment whose price moved
    const wsrc = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
    ok(!/' with the fee, and you hold '|' with its fee, not the '/.test(wsrc)
      && wsrc.indexOf("' with the mint\\u2019s fees, and you hold '") >= 0 && wsrc.indexOf("' with the mint\\u2019s fees, not the '") >= 0,
      'the wallet’s refusals for moving between mints and for a price that moved say the mint’s fees');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.log('FAIL  threw: ' + ((e && e.stack) || e)); process.exit(1); });
