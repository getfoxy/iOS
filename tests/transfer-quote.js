'use strict';
/* transfer-quote.js — moving an amount between two mints you already hold.
 *
 *     node tests/transfer-quote.js
 *
 * The figure the person types is what should LAND at the other mint; the fee
 * comes out of the source on top of it. Asking for 50 once moved 40 and took
 * 41, because the transfer borrowed sweepQuote, whose
 * fixed figure is what a token is worth, not what should arrive. These checks
 * hold the two apart.
 */
const { load, proof } = require('./harness');

const FROM = 'https://from.test';
const TO = 'https://to.test';

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

/* A pair of mints that answer a quote: the destination writes an invoice for
 * what it is asked, the source quotes a melt for it with a fee reserve. */
function mints(reserve, o) {
  const opts = o || {};
  const asked = { mint: [], melt: [] };
  class Wallet {
    constructor(url) {
      this.mintUrl = typeof url === 'string' ? url : (url && url.mintUrl);
      this.keysetId = '00b4cd27d8861a44';
      this.on = { countersReserved: () => {} };
    }
    loadMint() { return Promise.resolve(); }
    getKeySets() { return Promise.resolve([{ id: this.keysetId, unit: 'sat' }]); }
    checkProofsStates(ps) { return Promise.resolve((ps || []).map(() => ({ state: 'UNSPENT' }))); }
    checkMintQuoteBolt11() { return Promise.resolve({ state: 'UNPAID' }); }
    /* NUT-02's per-input fee, in parts per thousand. Zero at most mints, and
     * the reason padding a cross-mint payment is usually free. */
    getFeesForKeyset(count) { return Math.ceil((count * (opts.ppk || 0)) / 1000); }
    getFeesForProofs(list) { return this.getFeesForKeyset((list || []).length); }
    createMintQuoteBolt11(amount) {
      asked.mint.push({ mint: this.mintUrl, amount: amount });
      return Promise.resolve({ quote: 'q' + asked.mint.length, amount: amount,
        request: 'lnbc' + amount + 'n1pfoxytest', state: 'UNPAID' });
    }
    createMeltQuoteBolt11(request) {
      const amount = Number(/^lnbc(\d+)n/.exec(request)[1]);
      asked.melt.push({ mint: this.mintUrl, amount: amount });
      return Promise.resolve({ quote: 'm' + asked.melt.length, amount: amount,
        fee_reserve: reserve, request: request, state: 'UNPAID' });
    }
  }
  return { asked, cashu: { Wallet, Mint: Wallet, getDecodedToken: t => t, getEncodedToken: t => t } };
}

async function run() {
  const made = mints(10);
  const ctx = load({ cashu: made.cashu });
  const W = ctx.W;
  // 500 sats at the mint the money leaves
  ctx.storage.setItem('foxy.cashu.proofs.' + FROM,
    JSON.stringify([64, 128, 256, 32, 16, 4].map(a => proof(a))));
  await W.connect(TO, { remember: true });

  const plan = await W.transferQuote(FROM, 50);
  check('the destination is asked for exactly what should land',
    made.asked.mint.length === 1 && made.asked.mint[0].mint === TO && made.asked.mint[0].amount === 50,
    JSON.stringify(made.asked.mint));
  check('the plan moves what was typed', plan.moving === 50 && plan.net === 50, JSON.stringify(plan.moving));
  check('the fee is on top of it, not out of it', plan.feeSats >= 10 && plan.gross === 50 + plan.feeSats,
    'fee ' + plan.feeSats + ', leaving ' + plan.gross);
  check('the fee reserve is the route’s, and it is a ceiling', plan.reserve === 10 && plan.feeMin === 0,
    JSON.stringify({ reserve: plan.reserve, feeMin: plan.feeMin }));
  check('the plan says which mints, for moveRun', plan.from === FROM && plan.to === TO,
    JSON.stringify({ from: plan.from, to: plan.to }));
  check('the invoice it will pay is the destination’s', !!plan.mintQuote && !!plan.meltQuote
    && plan.meltQuote.request === plan.mintQuote.request, 'quotes do not match');

  // more than is there, counting the fee: refused before anything moves
  let refused = '';
  try { await W.transferQuote(FROM, 496); } catch (e) { refused = e.message; }
  check('an amount the fee cannot fit beside is refused', /costs up to/.test(refused), refused || 'it was allowed');

  let sameMint = '';
  try { await W.transferQuote(TO, 10); } catch (e) { sameMint = e.message; }
  check('moving a mint to itself is refused', /already at/.test(sameMint), sameMint || 'it was allowed');

  let zero = '';
  try { await W.transferQuote(FROM, 0); } catch (e) { zero = e.message; }
  check('nothing to move is refused', /above zero/.test(zero), zero || 'it was allowed');

  /* ---- paying somebody at another mint ------------------------------------
   *
   * Three options the cross-mint tap needs, and none of them existed when this
   * quote was written for the transfer screen.
   *
   * `to` names the destination instead of taking it from whichever mint is
   * connected. The transfer screen connects first and then quotes, which is
   * right there — the person is already on the destination. Paying somebody is
   * not: the quote happens while a card is still asking whether to pay the fee
   * at all, and flipping the wallet's mint under an unanswered question is a
   * side effect with no consent behind it.
   *
   * `land` says the figure is what somebody must hold after this phone has also
   * paid it out at the far mint. The far mint's own fee for spending what it
   * issues would otherwise come out of the amount, and the receiver asked for a
   * number.
   *
   * `quoteOnly` is a quote for money that has not arrived: the receiver in a
   * cross-mint tap works out the fee before the payer has sent anything, so the
   * proofs are not in its pile and never were.
   */
  {
    const two = mints(10);
    const c2 = load({ cashu: two.cashu });
    const V = c2.W;
    c2.storage.setItem('foxy.cashu.proofs.' + FROM,
      JSON.stringify([256, 128, 64].map(a => proof(a))));
    await V.connect(FROM, { remember: true });
    const was = V.mintUrl;

    const named = await V.transferQuote(FROM, 50, { to: TO });
    check('`to` sends the far mint the figure, wherever this wallet is connected',
      two.asked.mint.length === 1 && two.asked.mint[0].mint === TO && two.asked.mint[0].amount === 50,
      JSON.stringify(two.asked.mint));
    check('and quoting does not move the wallet off the mint it was on',
      V.mintUrl === was && was === FROM, V.mintUrl + ' was ' + was);
    check('the plan still carries both ends, so moveRun needs no connection made for it',
      named.from === FROM && named.to === TO, JSON.stringify({ from: named.from, to: named.to }));
    check('without `land` the figure is issued as asked, and padding is nothing',
      named.moving === 50 && named.net === 50 && named.padSats === 0,
      JSON.stringify({ moving: named.moving, net: named.net, pad: named.padSats }));

    /* A mint that charges nothing to spend a piece — which is most of them —
     * pads nothing, so `land` changes not one number. */
    const free = mints(10);
    const c3 = load({ cashu: free.cashu });
    c3.storage.setItem('foxy.cashu.proofs.' + FROM,
      JSON.stringify([256, 128, 64].map(a => proof(a))));
    await c3.W.connect(TO, { remember: true });
    const noFee = await c3.W.transferQuote(FROM, 50, { land: true });
    check('at a mint that charges nothing per piece, landing the figure costs nothing extra',
      noFee.moving === 50 && noFee.net === 50 && noFee.padSats === 0,
      JSON.stringify({ moving: noFee.moving, net: noFee.net, pad: noFee.padSats }));

    /* And one that charges. A mint at a sat an input is far above anything real
     * — Nutshell's own rate is a tenth of that, which came out at five sats of
     * padding on a hundred against the live mint — and it makes the arithmetic
     * legible here. */
    const paid = mints(10, { ppk: 1000 });
    const c4 = load({ cashu: paid.cashu });
    c4.storage.setItem('foxy.cashu.proofs.' + FROM,
      JSON.stringify([256, 128, 64].map(a => proof(a))));
    await c4.W.connect(TO, { remember: true });
    const land = await c4.W.transferQuote(FROM, 50, { land: true });
    check('at a mint that charges, the far mint is asked for the figure plus its own fee',
      land.moving > 50 && land.net === 50 && land.padSats === land.moving - 50,
      JSON.stringify({ moving: land.moving, net: land.net, pad: land.padSats }));
    /* Generous on purpose, and the two mistakes are not the same size.
     *
     * Too low and the move has already happened — a real Lightning payment,
     * gone — when the payment it was for comes up short: 101 sats claimed at
     * Nutshell for a 100-sat payment, and "Not enough funds available to send"
     * (tools/live/cross-mint.js). Too high and a few sats stay at the far mint,
     * still the payer's and still spendable. So it asks what thirty-two inputs
     * cost, which is more than any payment out of a freshly claimed pile will
     * spend, and adds one. */
    check('the padding covers more inputs than the payment can possibly spend',
      land.padSats === Math.ceil(32 * 1000 / 1000) + 1,
      land.padSats + ' sats, for a mint charging a sat an input');
    check('the figure asked for is still what lands, and the payer carries the rest',
      land.net === 50 && land.feeSats === land.gross - 50,
      JSON.stringify({ net: land.net, fee: land.feeSats, gross: land.gross }));

    /* `quoteOnly`: the receiver quoting for money it does not hold. Without it
     * the balance test refuses every such quote, because the pile is empty. */
    const none = mints(10, { ppk: 1000 });
    const c5 = load({ cashu: none.cashu });
    await c5.W.connect(TO, { remember: true });          // and nothing at FROM
    let refused = null;
    await c5.W.transferQuote(FROM, 50).catch(e => { refused = e; });
    check('a quote for money this phone does not hold is refused by default',
      !!refused, refused ? String(refused.message).slice(0, 60) : 'IT QUOTED');
    const ahead = await c5.W.transferQuote(FROM, 50, { quoteOnly: true });
    check('`quoteOnly` asks the two mints anyway, for money that has not arrived',
      ahead.net === 50 && ahead.to === TO, JSON.stringify({ net: ahead.net, to: ahead.to }));
    check('and reports what the source will charge to spend proofs it has not issued yet',
      ahead.inPadSats === 33, ahead.inPadSats + ' sats, the same allowance at the other end');
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  if (failed) { console.log('\n' + failed + ' transfer check(s) failed'); process.exit(1); }
  console.log('\nall ' + results.length + ' transfer quote checks pass');
  // jsdom leaves its timers running, and the wallet's background checks with them
  process.exit(0);
}

run().catch(e => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
