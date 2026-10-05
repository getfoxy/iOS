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
 *
 * The same pair of pretend mints answers the rest of what moves sats between
 * mints: switching everything to another mint (moveQuote), sweeping a token
 * from one (sweepQuote), the note a crossing leaves while it is under way, and
 * when that note goes.
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
      /* What cashu-ts would pick to send an amount, with the fee on what it
       * picks counted: the biggest pieces first, until they cover it, and
       * nothing when the pile cannot. Only for a test that asks (`select`); a
       * wallet that cannot be asked is given the plain sum instead. */
      if (opts.select) {
        this.selectProofsToSend = (list, amount, includeFees) => {
          const pile = (list || []).slice().sort((x, y) => y.amount - x.amount);
          const left = (picked) => picked.reduce((n, p) => n + p.amount, 0) - (includeFees ? this.getFeesForProofs(picked) : 0);
          const send = [];
          for (const p of pile) { if (left(send) >= amount) break; send.push(p); }
          return left(send) >= amount ? { send, keep: pile.filter(p => send.indexOf(p) < 0) } : { send: [], keep: pile };
        };
      }
    }
    loadMint() { return Promise.resolve(); }
    getKeySets() { return Promise.resolve([{ id: this.keysetId, unit: 'sat' }]); }
    checkProofsStates(ps) { return Promise.resolve((ps || []).map(() => ({ state: 'UNSPENT' }))); }
    /* What the mint calls a quote, and what it says to a claim of one. Unpaid
     * unless a test says otherwise, and a mint that has not been paid, or has
     * issued already, turns a claim away. */
    checkMintQuoteBolt11() { return Promise.resolve({ state: opts.state || 'UNPAID' }); }
    mintProofsBolt11() {
      return Promise.reject(Object.assign(new Error(opts.state === 'ISSUED' ? 'Quote already issued' : 'Quote not paid'),
        { status: 400, code: opts.state === 'ISSUED' ? 20002 : 20001 }));
    }
    checkMeltQuoteBolt11() { return Promise.resolve({ state: opts.meltState || 'UNPAID' }); }
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

  /* ---- the amount that would fit -----------------------------------------
   *
   * An amount the fee cannot sit beside is refused, and the refusal says what
   * would fit, so the screen can offer it instead of sending the person back to
   * the keypad. What it offers has to be an amount the quote then allows: the
   * fee is paid on the pieces the mint is made to spend, which change with the
   * amount, so the figure is found by asking again lower, a sat at a time,
   * until the same sum says yes.
   */
  {
    const dear = mints(10, { ppk: 100, select: true });
    const c = load({ cashu: dear.cashu });
    const V = c.W;
    c.storage.setItem('foxy.cashu.proofs.' + FROM,
      JSON.stringify([256, 128, 64].map(a => proof(a))));
    await V.connect(TO, { remember: true });

    let over = null;
    await V.transferQuote(FROM, 448).catch(e => { over = e; });
    check('all that is held cannot be moved, and the refusal says what is held',
      !!over && /costs up to \d+ with the fee, and you hold 448 at from\.test/.test(over.message) && over.foxyHave === 448,
      over ? over.message : 'it was quoted');
    const offered = over ? over.foxyFits : 0;
    check('and offers something that fits, and not the whole', offered > 0 && offered < 448, String(offered));
    const taken = await V.transferQuote(FROM, offered).then(p => p, e => ({ refused: e.message }));
    check('the amount it offers is one the quote then allows', !!taken && !taken.refused && taken.net === offered,
      taken && taken.refused ? 'refused: ' + taken.refused : JSON.stringify(taken && taken.net));
    const above = await V.transferQuote(FROM, offered + 1).then(() => null, e => e);
    check('and it is the most that is allowed: one more sat is refused again', !!above && /costs up to/.test(above.message),
      above ? above.message : 'it was quoted');
  }

  /* ---- moving everything at one mint to another ---------------------------
   *
   * `moveQuote` is the mint switch: all that is held here is paid to the other
   * mint as one Lightning payment, so the plan carries both quotes and the
   * invoice the second mint wrote is the one the first is asked to pay. The two
   * ends have to be two mints. A mint with nothing in it has nothing to pay
   * for, so it is a change of address and no invoice is asked for.
   */
  {
    const sw = mints(10);
    const c = load({ cashu: sw.cashu });
    const V = c.W;
    c.storage.setItem('foxy.cashu.proofs.' + FROM,
      JSON.stringify([64, 128, 256, 32, 16, 4].map(a => proof(a))));
    await V.connect(FROM, { remember: true });

    let same = '', respelled = '';
    try { await V.moveQuote(FROM); } catch (e) { same = e.message; }
    try { await V.moveQuote(FROM.toUpperCase() + '/'); } catch (e) { respelled = e.message; }
    check('moving everything to the mint you are on is refused',
      /already on that mint/.test(same), same || 'it was allowed');
    check('and so is the same mint spelled another way',
      /already on that mint/.test(respelled), respelled || 'it was allowed');
    check('and refused before either mint is asked anything',
      sw.asked.mint.length === 0 && sw.asked.melt.length === 0, JSON.stringify(sw.asked));

    const plan = await V.moveQuote(TO);
    check('the plan names both mints and carries both quotes, for the same invoice',
      plan.from === FROM && plan.to === TO && !!plan.mintQuote && !!plan.meltQuote
      && plan.meltQuote.request === plan.mintQuote.request, JSON.stringify({ from: plan.from, to: plan.to }));
    check('what moves, and the fee it leaves behind, add up to all that is held',
      plan.balance === 500 && plan.moving + plan.feeSats === 500 && plan.moving > 0, JSON.stringify(plan.moving));
    check('the fee reserve fits inside what is held, and the invoice is for what moves',
      plan.moving + plan.meltQuote.fee_reserve <= plan.balance && plan.mintQuote.amount === plan.moving,
      JSON.stringify({ moving: plan.moving, reserve: plan.meltQuote.fee_reserve }));
    check('an invoice too big for the fee beside it is asked again, smaller',
      sw.asked.mint.length === 2 && sw.asked.mint[1].amount < sw.asked.mint[0].amount, JSON.stringify(sw.asked.mint));

    // nothing at the mint it leaves: no invoice, no fee, only a change of address
    const bare = mints(10);
    const c0 = load({ cashu: bare.cashu });
    await c0.W.connect(FROM, { remember: true });
    const none = await c0.W.moveQuote(TO);
    check('with nothing to move there is no invoice to ask for',
      none.empty === true && none.moving === 0 && bare.asked.mint.length === 0, JSON.stringify(none));
    const there = await c0.W.moveRun(none, () => {});
    check('and carrying that plan out takes the phone there and says nothing moved',
      !!there && there.sats === 0 && there.feeSats === 0 && there.mint === TO && c0.W.mintUrl === TO,
      JSON.stringify(there) + ' on ' + c0.W.mintUrl);
  }

  /* ---- a token from another mint, brought home ----------------------------
   *
   * `sweepQuote` starts from what the token is worth and works out what can
   * land after the fee, asking again with a smaller invoice when the first
   * leaves no room for it. The plan it answers is the one `moveRun` carries
   * out, and a mint's reserve learned once is the first guess the next time.
   */
  {
    const sw = mints(10);
    const c = load({ cashu: sw.cashu });
    const V = c.W;
    await V.connect(TO, { remember: true });

    const asked = (list) => list.map(a => a.amount).join(',');
    // a sweep that fails, or answers nothing, is said as a failed check and not thrown past the rest
    const sweep = (w, from, sats) => w.sweepQuote(from, sats).then(p => p || { failed: 'no plan' }, e => ({ failed: e.message }));
    const plan = await sweep(V, FROM, 100);
    check('a sweep answers a plan naming both mints and what the token was worth',
      !!plan && plan.from === FROM && plan.to === TO && plan.gross === 100 && plan.balance === 100,
      JSON.stringify(plan));
    check('it asked for less than the token, then for what the reserve left room for',
      asked(sw.asked.mint) === '92,82' && asked(sw.asked.melt) === '92,82', asked(sw.asked.mint) + ' / ' + asked(sw.asked.melt));
    check('what lands is the second invoice, and the fee is the rest of the token',
      plan.moving === 82 && plan.net === 82 && plan.feeSats === 18 && plan.feeMax === 18,
      JSON.stringify({ moving: plan.moving, net: plan.net, fee: plan.feeSats }));
    check('the plan carries both quotes, for the same invoice, and the reserve is the route’s',
      !!plan.mintQuote && !!plan.meltQuote && plan.mintQuote.amount === 82
      && plan.meltQuote.request === plan.mintQuote.request && plan.reserve === 10,
      JSON.stringify({ mint: plan.mintQuote && plan.mintQuote.amount, reserve: plan.reserve }));

    // the reserve the mint asked for last time is the first guess this time
    await sweep(V, FROM, 100);
    check('the second sweep from that mint asks for the figure that fit, straight off',
      asked(sw.asked.mint) === '92,82,82', asked(sw.asked.mint));

    // a route that costs nothing to take fits on the first ask
    const cheap = mints(0);
    const c1 = load({ cashu: cheap.cashu });
    await c1.W.connect(TO, { remember: true });
    const easy = await sweep(c1.W, FROM, 100);
    check('with no reserve the first invoice fits, and the token is spent but for the margin',
      asked(cheap.asked.mint) === '92' && easy.moving === 92 && easy.feeSats === 8,
      asked(cheap.asked.mint) + ' / ' + JSON.stringify({ moving: easy.moving, fee: easy.feeSats }));

    let small = '', same = '';
    try { await V.sweepQuote(FROM, 5); } catch (e) { small = e.message; }
    try { await V.sweepQuote(TO, 100); } catch (e) { same = e.message; }
    check('a token worth less than the fee to move it is refused', /more than the token is worth/.test(small), small || 'it was allowed');
    check('and one from the mint you are on is not swept', /already from this mint/.test(same), same || 'it was allowed');
  }

  /* ---- the note of a crossing, written before the payment ------------------
   *
   * Between paying the far mint's invoice and claiming at the far end the sats
   * are at that mint and nowhere else, and the note `moveRun` writes is the only
   * way back to them. So a store that will not take the note stops the move
   * before the payment is made, not after.
   */
  {
    const full = mints(10);
    const c = load({ cashu: full.cashu });
    const V = c.W;
    c.storage.setItem('foxy.cashu.proofs.' + FROM,
      JSON.stringify([256, 128, 64].map(a => proof(a))));
    await V.connect(FROM, { remember: true });
    const plan = await V.transferQuote(FROM, 50, { to: TO });
    const quotes = full.asked.melt.length;
    const held = V.balanceAt(FROM);

    // a phone whose store is full, for this one key
    const proto = c.window.Storage.prototype;
    const real = proto.setItem;
    proto.setItem = function (k, v) {
      if (String(k) === 'foxy.cashu.move') throw new c.window.DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return real.call(this, k, v);
    };
    const err = await V.moveRun(plan, () => {}, { visit: true }).then(() => null, e => e);
    proto.setItem = real;

    check('a crossing whose note cannot be written is refused as storage, and as not sent',
      !!err && err.storageFull === true && err.unsent === true, err ? String(err.message).slice(0, 80) : 'it went ahead');
    check('and no payment was asked for: the mint was not even quoted a melt again',
      full.asked.melt.length === quotes, full.asked.melt.length + ' melt quotes for ' + quotes);
    check('nothing is on file as a crossing, and the sats are still where they were',
      V.pendingMoves().length === 0 && V.balanceAt(FROM) === held, V.pendingMoves().length + ' note(s), ' + V.balanceAt(FROM) + ' of ' + held);
  }

  /* ---- a note for a payment that never was ---------------------------------
   *
   * `finishMove` claims every note it finds. A claim the mint turns away is not
   * always a payment on its way: when the invoice was never paid, and nothing
   * is held that could still pay it, the melt the note was written for did not
   * happen, and the note goes. But only after its hour — a payment may be
   * moments from landing — and not at all while a melt is held that could be
   * the one.
   */
  {
    const HOUR = 3600000;
    const note = (id, age) => ({ to: TO, from: FROM, quote: id, amount: 40, lock: null,
      request: 'lnbc' + id + 'n1pfoxytest', at: Date.now() - age });
    const quotes = (c) => c.W.pendingMoves().map(n => n.quote).sort().join(',');
    const beside = async (storage) => {
      const c = load({ cashu: mints(10).cashu, storage });
      await c.W.connect(FROM, { remember: true });
      await new Promise(r => setTimeout(r, 20));      // connect's own catch-up
      await c.W.finishMove();
      return c;
    };

    const c = await beside({ 'foxy.cashu.move': JSON.stringify([note('q-new', 10 * 60000), note('q-old', 2 * HOUR)]) });
    check('a crossing note whose invoice was never paid is dropped once it is an hour old',
      !quotes(c).includes('q-old'), 'on file: ' + quotes(c));
    check('and not before: one ten minutes old is kept, with its claim still to try',
      quotes(c) === 'q-new', 'on file: ' + quotes(c));
    check('and nothing arrived for either', c.W.balanceAt(TO) === 0 && c.W.balanceAt(FROM) === 0, c.W.balanceAt(TO) + ' at ' + TO);

    // a melt held that could still pay the invoice keeps even an old note
    const h = await beside({
      'foxy.cashu.move': JSON.stringify([note('q-old', 2 * HOUR)]),
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm-held', mint: FROM, proofs: [proof(64)], amount: 40, bolt11: 'lnbcq-oldn1pfoxytest',
        at: Math.floor(Date.now() / 1000) }]),
    });
    check('a note is kept as long as a melt is held that could be its payment',
      quotes(h) === 'q-old' && h.W.pendingMelts().length === 1, 'notes ' + quotes(h) + ', holds ' + h.W.pendingMelts().length);
  }

  /* ---- the note goes when what it was for is settled -----------------------
   *
   * A melt that was given back was not paid and will not be, so nothing is on
   * its way and its note is a note of nothing: left, every launch would ask the
   * far mint to issue a quote nobody paid. The note names the invoice the melt
   * pays, and only that melt's note goes. And a note for a quote the mint has
   * already issued, with no record of which counters the claim used, cannot be
   * claimed or restored; it goes too, rather than being asked about for ever.
   */
  {
    const bolt = 'lnbc90n1pfoxytest';
    const held = (extra) => Object.assign({ quote: 'm-held', mint: FROM, proofs: [proof(64)], amount: 90, feeReserve: 10,
      bolt11: bolt, at: Math.floor(Date.now() / 1000) - 600, outputs: [] }, extra || {});
    const note = (id, request) => ({ to: TO, from: FROM, quote: id, amount: 90, lock: null, request: request, at: Date.now() });
    const ids = (c) => c.W.pendingMoves().map(n => n.quote).sort().join(',');

    const given = mints(10, { meltState: 'FAILED' });
    const c = load({ cashu: given.cashu, storage: {
      'foxy.cashu.move': JSON.stringify([note('q-this', bolt), note('q-other', 'lnbc7n1pfoxytest')]),
      'foxy.cashu.melting': JSON.stringify([held()]),
    } });
    await c.W.connect(FROM, { remember: true });
    await new Promise(r => setTimeout(r, 20));
    await c.W.sweepMelts();
    check('a melt the mint says failed is given back, proofs and all',
      c.W.pendingMelts().length === 0 && c.W.balanceAt(FROM) === 64, c.W.pendingMelts().length + ' held, ' + c.W.balanceAt(FROM) + ' sats back');
    check('and the note of the crossing that melt was paying goes with it, and no other',
      ids(c) === 'q-other', 'on file: ' + ids(c));

    // a melt the mint has not settled is not given back, and keeps its note
    const routing = mints(10, { meltState: 'PENDING' });
    const r = load({ cashu: routing.cashu, storage: {
      'foxy.cashu.move': JSON.stringify([note('q-this', bolt)]),
      'foxy.cashu.melting': JSON.stringify([held({ at: Math.floor(Date.now() / 1000) })]),
    } });
    await r.W.connect(FROM, { remember: true });
    await new Promise(done => setTimeout(done, 20));
    await r.W.sweepMelts();
    check('a melt still routing keeps its hold, and its note',
      r.W.pendingMelts().length === 1 && ids(r) === 'q-this', r.W.pendingMelts().length + ' held; on file: ' + ids(r));

    // issued at the far mint, with nothing on the note to say which counters it used
    const gone = mints(10, { state: 'ISSUED' });
    const g = load({ cashu: gone.cashu, storage: {
      'foxy.cashu.move': JSON.stringify([note('q-issued', bolt)]),
    } });
    await g.W.connect(FROM, { remember: true });
    await new Promise(done => setTimeout(done, 20));
    await g.W.finishMove();
    check('a crossing the far mint says it issued, with no counters on its note, is dropped',
      g.W.pendingMoves().length === 0, 'on file: ' + ids(g));
    check('and nothing is invented for it: no sats, no history',
      g.W.balanceAt(TO) === 0 && g.W.balanceAt(FROM) === 0 && !g.storage.getItem('foxy.cashu.log'),
      g.W.balanceAt(TO) + ' sats at ' + TO + '; log ' + g.storage.getItem('foxy.cashu.log'));
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  if (failed) { console.log('\n' + failed + ' transfer check(s) failed'); process.exit(1); }
  console.log('\nall ' + results.length + ' transfer quote checks pass');
  // jsdom leaves its timers running, and the wallet's background checks with them
  process.exit(0);
}

run().catch(e => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
