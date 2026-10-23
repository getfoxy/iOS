'use strict';
/* flashcard-usd-receive.js — CARD on a receive into the dollar balance.
 *
 *     node tests/flashcard-usd-receive.js
 *
 * At a mint with two balances, a receive into dollars shows an invoice the mint made for the cents asked: a Lightning
 * invoice naming its own number of sats at the mint's rate. A card holds bitcoin. CARD on that screen taps the card for
 * exactly the invoice's sats (read off the invoice, never priced on this phone), and those sats then pay the invoice from
 * this phone; the mint says the invoice is paid, and the dollars land as they land for any payer (12-receive.js,
 * `usdInvoiceUp`). The card's money is at this phone's own mint, so the mint is paying an invoice it made itself.
 *
 * The till is build/app/26f-flashcard.js with the receive's own parts lifted out of their files (flashcard-ui-kit.js,
 * `receive: true`), over the real wallet, the test mint with two balances (tests/harness.js, `units`) and the model of a
 * card (tests/flashcard-card.js). What is checked: CARD appears once the invoice is there; the card pays the invoice's
 * sats and only those; the dollar balance rises by the cents and the bitcoin balance does not move; the figures the card's
 * screens show; a refusal leaves the invoice unpaid and every balance as it was; a mint that charges for the payment
 * takes its fee from this phone's bitcoin, and where there is none to pay it the sats are kept as bitcoin and said so;
 * and a bitcoin receive's CARD is exactly what it was. */
const { page, newCard, history, MINT, OTHER_WORDS } = require('./flashcard-kit');
const { appOn, until, pad, card, stage, behind, settle } = require('./flashcard-ui-kit');
const { booksWrong } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

/* A holder (H) with a card it set up, 5,000 sats on it and a PIN of 1234, and a till (R) at the same mint, holding
 * `tillSats` of bitcoin. The mint issues sats and dollars; an invoice it makes waits to be paid (`quotesUnpaid`), so that
 * only a payment pays it. */
async function world(mintOpts, tillSats) {
  const H = page({ units: ['sat', 'usd'], mintOpts: Object.assign({ quotesUnpaid: true }, mintOpts || {}) });
  await H.W.connect(MINT, null, null, { remember: true });
  const fund = async (c, sats) => { const q = await c.W.invoice(sats, ''); H.mint.payQuote(q.hash); await c.W.claim(q.hash); };
  await fund(H, 9000);
  await H.W.primeLocks();
  const R = page({ sharedMint: H.mint, words: OTHER_WORDS });
  await R.W.connect(MINT, null, null, { remember: true });
  if (tillSats) await fund(R, tillSats);
  await R.W.primeLocks();
  const k = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(k, { pin: '1234' });
  k.tap();
  await H.W.cardAdd(k, { sats: 5000, owner: true });
  const till = appOn(R, { screen: 'confirm', flow: 'receive', stack: ['home', 'amount'], wallet: 'usd', unit: 'USD', amount: '1.00' },
                     { send: true, receive: true });
  // what the receive screen's values ask of the rest of the app, with no request or address on screen here
  till.dollarsOnly = () => false;
  till.cashuRequest = () => '';
  till.railRequest = () => '';
  till.ocReceiveAddress = () => '';
  R.nfc = k;
  return { H, R, k, till };
}

const sats = (c) => c.W.balanceOf('sat');
const cents = (c) => c.W.balanceOf('usd');
// the receive screen's values, as the template reads them
const screen = (till) => till.renderReceive({ s: till.state, sc: till.state.screen, val: 0, landed: 0, invSats: 0, sats: 0 });
// the line under the amount on the screen behind the card's sheet (26h-tap-screen.js), or '' where there is none
const subLine = (ctx) => {
  const el = ctx.window.document.querySelector('#foxy-stage [data-tap-amount-sub]');
  return el && el.style.display !== 'none' ? el.textContent : '';
};
const quoteState = (ctx, id) => (ctx.mint.quotes[id] || {}).state;
const meltsAsked = (ctx) => ctx.trace.filter((t) => /\/v1\/melt\//.test(t)).length;

/* A dollar receive of `amount` (a figure typed on the keypad), its invoice asked of the mint. */
async function receiveDollars(till, R, amount) {
  till.setState({ screen: 'confirm', flow: 'receive', wallet: 'usd', unit: 'USD', amount, invoice: '', invoiceHash: '', recvAmount: null });
  till.openUsdReceive(till.centsTyped());
  await until('the dollar invoice', () => !!till.state.invoice);
  return { bolt11: till.state.invoice, hash: till.state.invoiceHash, sats: R.W.amountOf(till.state.invoice) };
}

(async () => {
  /* ---- 1: $1.00, paid by a card ---------------------------------------------------------------------------------- */
  const { H, R, k, till } = await world({ satFeeReserve: 0 }, 0);
  {
    ok(till.twoUnitsOn() && till.walletNow('receive') === 'usd', 'a mint with two balances, and this receive is into dollars');
    till.setState({ amount: '1.00', invoice: '' });
    let v = screen(till);
    // (a dollar card pays the cents and needs no invoice, so CARD is there already; a bitcoin card is told to tap again: tests/flashcard-usd-ui.js)
    ok(v.recvTapShown === true && v.recvCardShown === true, 'before the mint has made the invoice: TAP, and CARD for a dollar card');
    /* CARD pressed while the mint is still making the code (the owner pressed it the moment the screen opened, and the bitcoin
     * card was read and refused): no sheet yet, a word, and CARD tries again by itself until the code is there. */
    {
      const was = { screen: till.state.screen, run: till._invoiceRun, making: till._usdCodeMaking, toasts: till.toasts.length };
      till._invoiceRun = (till._invoiceRun || 0) + 1;
      till._usdCodeMaking = till._invoiceRun;
      till.setState({ screen: 'confirm', invoice: '', recvAmount: 100, recvUnit: 'usd' });
      R.sheet.length = 0;
      till.payByCard();
      ok(!R.sheet.some((x) => /^begin: /.test(x)) && till.toasts.slice(-1)[0] === 'One moment: the code is being made.',
         'CARD while the code is being made: no sheet, "One moment: the code is being made."', (till.toasts.slice(-1)[0] || '') + ' | ' + R.sheet.join(' / '));
      // the screen left before the code came: the retry does nothing
      till.setState({ screen: 'home' });
      await new Promise((ok2) => setTimeout(ok2, 400));
      ok(!R.sheet.some((x) => /^begin: /.test(x)), 'and no sheet comes up for a screen that was left');
      till._usdCodeMaking = was.making; till._fcUsdCodeWait = 0;
      till.setState({ screen: was.screen });
    }
    const inv = await receiveDollars(till, R, '1.00');
    v = screen(till);
    ok(v.recvCardShown === true && v.recvTapShown === true && v.confirmAmount === '$ 1.00',
       'once the invoice is there, CARD is beside TAP, under $ 1.00', JSON.stringify({ card: v.recvCardShown, amount: v.confirmAmount }));
    ok(typeof v.cardPay === 'function', 'and it is the same button, with the same handler, as on a bitcoin receive');
    ok(inv.sats === 1300 && quoteState(R, inv.hash) === 'UNPAID',
       'the invoice is the mint’s for 100 cents, naming 1,300 sats at its rate, and unpaid', JSON.stringify(inv));

    const cardBefore = k.balance();
    const satsBefore = sats(R), centsBefore = cents(R);
    const meltsBefore = meltsAsked(R);
    k.tap();
    k.sent.length = 0;
    R.sheet.length = 0;
    till.payByCard();
    ok(!pad(till) && /^begin: /.test(R.sheet[0] || ''), 'CARD brings up the sheet at once, as it does for bitcoin', R.sheet[0]);
    await until('the card to want its PIN', () => !!pad(till));
    ok(pad(till).title === 'CARD PIN' && pad(till).sub === 'To pay $1.00 (₿1,300). The card’s owner types its PIN here.' && pad(till).cta === 'TAP AGAIN',
       'the PIN pad names the dollars asked and the sats the card pays', pad(till).sub);
    ok(behind(R) && behind(R).amount === '$1.00' && subLine(R) === '₿1,300',
       'behind the sheet: $1.00, with ₿1,300 under it', JSON.stringify({ amount: behind(R) && behind(R).amount, sub: subLine(R) }));
    // the dollar code is kept while the card pays it, even with its minute run out
    const kept = till.state.recvExpiresAt;
    till.setState({ recvExpiresAt: Date.now() - 1 });
    ok(till.fcUsdHolds(inv.hash), 'the code on screen is held while the card pays it');
    till.recvClockTick(till._invoiceRun);
    ok(till.state.invoice === inv.bolt11 && !till._requoting, 'and its minute running out asks for no new code meanwhile');
    till.setState({ recvExpiresAt: kept });
    pad(till).type('1234');
    /* From the card's payment to PAYMENT RECEIVED the screen says VERIFYING over the code, instead of the code read as unpaid
     * (the owner tapped the card at it again); the receive's watch takes it down as it says paid. */
    let verifying = false, verifyingBody = '';
    await until('VERIFYING or the dollars', () => {
      if (stage(R) === 'paidCheck') { verifying = true; verifyingBody = (R.window.document.getElementById('foxy-stage') || {}).textContent || ''; }
      return till.state.screen === 'paid';
    });
    ok(verifying && /Verifying/.test(verifyingBody) && /The card paid ₿1,300\. Foxy is confirming the payment with your mint\./.test(verifyingBody),
       'VERIFYING over the code while the card’s sats pay it, naming what the card paid', verifyingBody.replace(/\s+/g, ' ').slice(0, 160));
    await until('the tap to be over', () => !(till._fcTaps > 0) && R.W.cardOwed().length === 0 && !stage(R));
    await settle();
    ok(!stage(R), 'and VERIFYING is gone with PAYMENT RECEIVED');
    ok(till.state.paidUnit === 'usd' && till.state.paidAmount === 100,
       'PAYMENT RECEIVED in dollars: 100 cents, by the dollar invoice’s own watch', JSON.stringify({ unit: till.state.paidUnit, amount: till.state.paidAmount }));
    ok(cardBefore - k.balance() === 1300, 'the card paid the invoice’s 1,300 sats, and only those', String(cardBefore - k.balance()));
    /* Between the card's payment and PAYMENT RECEIVED the code is still on screen: CARD pressed again then brings no second
     * sheet, which read the card again for the same code and refused it as short on the phone. */
    {
      const was = { fcUsd: till._fcUsd, screen: till.state.screen, invoiceHash: till.state.invoiceHash };
      till._fcUsd = { hash: inv.hash, bolt11: inv.bolt11, sats: 1300, melting: true };
      till.setState({ screen: 'confirm', invoiceHash: inv.hash });
      R.sheet.length = 0;
      const toastsBefore = till.toasts.length;
      till.payByCard();
      ok(!R.sheet.some((x) => /^begin: /.test(x)) && till.toasts.length === toastsBefore + 1 && /The card has paid this code/.test(till.toasts.slice(-1)[0]),
         'CARD pressed again while the card’s payment settles: no second sheet, a word instead', (till.toasts.slice(-1)[0] || '') + ' | ' + R.sheet.join(' / '));
      till._fcUsd = { hash: inv.hash, bolt11: inv.bolt11, sats: 1300, landingUntil: Date.now() + 20000 };
      till.payByCard();
      ok(!R.sheet.some((x) => /^begin: /.test(x)), 'nor while the paid code’s dollars are landing');
      till._fcUsd = was.fcUsd;
      till.setState({ screen: was.screen, invoiceHash: was.invoiceHash });
    }
    ok(cents(R) - centsBefore === 100 && sats(R) === satsBefore,
       'the dollar balance rose by 100 cents, and the bitcoin balance did not move', JSON.stringify({ usd: cents(R), sat: sats(R) }));
    ok(quoteState(R, inv.hash) === 'ISSUED', 'the mint says its dollar invoice was paid, and its dollars issued', quoteState(R, inv.hash));
    ok(meltsAsked(R) - meltsBefore === 2, 'the sats paid it in one payment: a fee asked, and one melt', String(meltsAsked(R) - meltsBefore));
    const h = history(R);
    const fromCard = h.find((e) => e.memo === 'card' && e.dir === 'in');
    const melt = h.find((e) => e.dir === 'out' && e.bolt11 === inv.bolt11);
    const landed = h.find((e) => e.hash === inv.hash);
    ok(fromCard && fromCard.sats === 1300 && melt && melt.sats === 1300 && (melt.unit === undefined || melt.unit === 'sat') && landed && landed.unit === 'usd',
       'HISTORY: 1,300 sats from the card, 1,300 sats paying the dollar invoice, and the dollars in', JSON.stringify({ card: fromCard && fromCard.sats, melt: melt && melt.sats, usd: landed && landed.unit }));
    ok(fromCard && melt && till.seen[fromCard.hash] && till.seen[melt.hash],
       'neither the card’s sats nor their paying of the invoice is announced as a payment of its own: the dollars are');
    ok(booksWrong(R).length === 0, 'the till’s books add up, per unit', booksWrong(R).join(' / '));
  }

  /* ---- 2: a refusal: over the card's daily limit ----------------------------------------------------------------- */
  {
    k.tap();
    await H.W.cardSetLimit(k, { sats: 1000 });
    const inv = await receiveDollars(till, R, '1.00');
    const cardBefore = k.balance();
    const satsBefore = sats(R), centsBefore = cents(R);
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the limit to refuse', () => card(till) && card(till).title === 'OVER THE CARD’S DAILY LIMIT');
    ok(/Nothing was taken/.test(card(till).reason) && !k.sent.some((a) => /^b0(40|20)/.test(a)),
       'over the card’s daily limit: the bitcoin receive’s own card and words, before any PIN or signature', card(till).reason);
    ok(quoteState(R, inv.hash) === 'UNPAID' && k.balance() === cardBefore && sats(R) === satsBefore && cents(R) === centsBefore && till.state.screen === 'confirm',
       'the invoice is left unpaid, nothing moved, and the invoice is still up', JSON.stringify({ q: quoteState(R, inv.hash), usd: cents(R), sat: sats(R) }));
    card(till).press('CLOSE');
    await settle();
    ok(!till.fcUsdHolds(inv.hash), 'and the code is no longer held: its minute counts on as before');
    till.stopReceive();
    k.tap();
    await H.W.cardSetLimit(k, { sats: 0 });
  }

  /* ---- 3: a bitcoin receive's CARD is as it was ------------------------------------------------------------------ */
  {
    const q = await R.W.invoice(200, '');
    till.setState({ screen: 'confirm', flow: 'receive', wallet: 'sat', unit: 'SATS', amount: '200', invoice: q.bolt11, invoiceHash: q.hash, recvUnit: 'sat' });
    ok(screen(till).recvCardShown === true, 'a bitcoin receive shows CARD as it always did');
    const cardBefore = k.balance();
    const satsBefore = sats(R), centsBefore = cents(R);
    const meltsBefore = meltsAsked(R);
    k.tap();
    till.payByCard();
    await until('the PIN pad', () => !!pad(till));
    ok(pad(till).sub === 'To pay ₿200. The card’s owner types its PIN here.' && behind(R).amount === '₿200' && subLine(R) === '',
       'its pad and its screen say what they said, with no line under the amount', pad(till).sub + ' | ' + behind(R).amount);
    pad(till).type('1234');
    await until('the payment', () => till.state.screen === 'home');
    await until('the tap to be over', () => !(till._fcTaps > 0) && R.W.cardOwed().length === 0 && !stage(R));
    await settle();
    const entry = history(R).find((e) => e.memo === 'card' && e.dir === 'in' && e.sats === 200);
    ok(cardBefore - k.balance() === 200 && sats(R) - satsBefore === 200 && cents(R) === centsBefore && meltsAsked(R) === meltsBefore,
       'the card pays 200 sats into the bitcoin balance, the receive closes, no invoice is paid and the dollars are untouched',
       JSON.stringify({ card: cardBefore - k.balance(), sat: sats(R) - satsBefore, melts: meltsAsked(R) - meltsBefore }));
    ok(entry && !till.seen[entry.hash] && quoteState(R, q.hash) === 'UNPAID',
       'its entry is left for the history pass to announce, as a payment, and the invoice is let be');
    ok(booksWrong(R).length === 0, 'the books add up', booksWrong(R).join(' / '));
  }

  /* ---- 4: a mint that charges to pay the invoice ----------------------------------------------------------------- */
  {
    // a reserve of 10 sats and a fee of 2 (tests/harness.js): the till's own bitcoin pays the fee, and the card still pays 1,300
    const w2 = await world({}, 50);
    const inv = await receiveDollars(w2.till, w2.R, '1.00');
    const cardBefore = w2.k.balance();
    w2.k.tap();
    w2.till.payByCard();
    await until('the PIN pad', () => !!pad(w2.till));
    pad(w2.till).type('1234');
    await until('the dollars to land', () => w2.till.state.screen === 'paid');
    await until('the tap to be over', () => !(w2.till._fcTaps > 0) && w2.R.W.cardOwed().length === 0 && !stage(w2.R));
    await settle();
    ok(cardBefore - w2.k.balance() === 1300 && cents(w2.R) === 100 && sats(w2.R) === 48,
       'the card pays the invoice’s 1,300 sats; the dollars land; the mint’s 2-sat fee comes out of this phone’s bitcoin',
       JSON.stringify({ card: cardBefore - w2.k.balance(), usd: cents(w2.R), sat: sats(w2.R) }));
    ok(booksWrong(w2.R).length === 0, 'the books add up', booksWrong(w2.R).join(' / '));
    w2.till.stopReceive();
  }
  {
    // with no bitcoin of its own to pay the reserve, the payment cannot be made: the card's sats stay, as bitcoin, and it is said
    const w3 = await world({}, 0);
    const inv = await receiveDollars(w3.till, w3.R, '1.00');
    const meltsBefore = meltsAsked(w3.R);
    w3.k.tap();
    w3.till.payByCard();
    await until('the PIN pad', () => !!pad(w3.till));
    pad(w3.till).type('1234');
    await until('the sats to be said to be kept as bitcoin', () => card(w3.till) && card(w3.till).title === 'PAID IN BITCOIN');
    ok(card(w3.till).reason === 'The card paid ₿1,300, and the mint did not turn it into dollars. This phone’s bitcoin could not cover the mint’s fee. It is in your bitcoin balance.',
       'PAID IN BITCOIN: what the card paid, that no dollars were made, why in plain words, and where the money is', card(w3.till).reason);
    ok(meltsAsked(w3.R) - meltsBefore === 1, 'the fee was asked, and no melt was sent that the till could not cover', String(meltsAsked(w3.R) - meltsBefore));
    await until('the tap to be over', () => !(w3.till._fcTaps > 0) && w3.R.W.cardOwed().length === 0 && !stage(w3.R));
    await settle();
    ok(sats(w3.R) === 1300 && cents(w3.R) === 0 && quoteState(w3.R, inv.hash) === 'UNPAID' && w3.till.state.screen === 'confirm',
       'the 1,300 sats are in the bitcoin balance, no dollars, and the dollar invoice is still unpaid on screen', JSON.stringify({ sat: sats(w3.R), usd: cents(w3.R) }));
    ok(!w3.till.fcUsdHolds(inv.hash), 'and the code is let go, to be renewed when its minute runs out');
    ok(booksWrong(w3.R).length === 0, 'the books add up', booksWrong(w3.R).join(' / '));
    card(w3.till).press('OK');
    w3.till.stopReceive();
  }

  /* ---- 5: a code with too little of its life left ---------------------------------------------------------------- */
  {
    // the mint's dollar invoices live ten seconds: CARD asks for a new code rather than hand a card one about to run out
    const w5 = await world({ satFeeReserve: 0, usdQuoteTtl: 10 }, 0);
    const inv = await receiveDollars(w5.till, w5.R, '1.00');
    const cardBefore = w5.k.balance();
    w5.k.tap();
    w5.k.sent.length = 0;
    w5.R.sheet.length = 0;
    w5.till.toasts.length = 0;
    w5.till.payByCard();
    ok(w5.R.sheet.length === 0 && !pad(w5.till) && w5.k.sent.length === 0 && !w5.till.fcUsdHolds(inv.hash),
       'with under fifteen seconds of the code left, CARD brings up no sheet and asks nothing of the card', JSON.stringify(w5.R.sheet));
    ok(w5.till.toasts.some((m) => /A new one is being made/.test(m)), 'and says a new code is being made', JSON.stringify(w5.till.toasts));
    await until('the new code', () => !!w5.till.state.invoiceHash && w5.till.state.invoiceHash !== inv.hash);
    ok(w5.k.balance() === cardBefore && quoteState(w5.R, inv.hash) === 'UNPAID' && sats(w5.R) === 0 && cents(w5.R) === 0,
       'a new code is on screen, and nothing moved', JSON.stringify({ old: quoteState(w5.R, inv.hash), now: w5.till.state.invoiceHash }));
    w5.till.stopReceive();
  }

  /* ---- 6: the code runs out while the card's PIN is typed ------------------------------------------------------- */
  {
    // seventeen seconds: enough to begin, and gone by the time the PIN is in
    const w6 = await world({ satFeeReserve: 0, usdQuoteTtl: 17 }, 0);
    const inv = await receiveDollars(w6.till, w6.R, '1.00');
    const cardBefore = w6.k.balance();
    w6.k.tap();
    w6.till.payByCard();
    await until('the PIN pad', () => !!pad(w6.till));
    const ends = w6.till._fcUsd && w6.till._fcUsd.ends;
    ok(ends > 0 && ends === w6.till.state.recvExpiresAt, 'the card is paying a code whose end the mint gave', String(ends));
    // the PIN is slow: typed with four seconds of the code left, under the five a melt needs to be sent
    while (Date.now() <= ends - 4000) await new Promise((r) => setTimeout(r, 200));
    ok(w6.till.state.invoice === inv.bolt11 && w6.till.fcUsdHolds(inv.hash), 'the code stays on screen while the PIN pad is up');
    const meltsBefore = meltsAsked(w6.R);
    pad(w6.till).type('1234');
    await until('the sats to be said to be kept as bitcoin', () => card(w6.till) && card(w6.till).title === 'PAID IN BITCOIN');
    ok(/The code ran out while the card paid\. It is in your bitcoin balance\.$/.test(card(w6.till).reason),
       'PAID IN BITCOIN, saying the code ran out', card(w6.till).reason);
    await until('the tap to be over', () => !(w6.till._fcTaps > 0) && w6.R.W.cardOwed().length === 0 && !stage(w6.R));
    await settle();
    ok(meltsAsked(w6.R) === meltsBefore, 'no fee was asked and no melt sent for a code the mint would refuse', String(meltsAsked(w6.R) - meltsBefore));
    ok(cardBefore - w6.k.balance() === 1300 && sats(w6.R) === 1300 && cents(w6.R) === 0 && quoteState(w6.R, inv.hash) === 'UNPAID',
       'the card’s 1,300 sats are in the bitcoin balance, and no dollars', JSON.stringify({ sat: sats(w6.R), usd: cents(w6.R) }));
    ok(!w6.till.fcUsdHolds(inv.hash), 'and the code is let go, so a new one is made');
    ok(booksWrong(w6.R).length === 0, 'the books add up', booksWrong(w6.R).join(' / '));
    card(w6.till).press('OK');
    w6.till.stopReceive();
  }

  /* ---- 7: a payment of the invoice still with the mint holds the code -------------------------------------------- */
  {
    const inv = await receiveDollars(till, R, '1.00');
    const W = R.W;
    const real = W.pendingMelts;
    let inFlight = [{ quote: 'q', bolt11: inv.bolt11.toUpperCase(), proofs: [] }];
    W.pendingMelts = () => inFlight;
    till._fcUsd = { bolt11: inv.bolt11, hash: inv.hash, cents: 100, sats: inv.sats, run: till._invoiceRun, ends: Date.now() - 1, pending: true };
    till.setState({ recvExpiresAt: Date.now() - 1 });
    ok(till.fcUsdHolds(inv.hash) && till._fcUsd.pending === true && !till._fcUsd.landingUntil,
       'while the wallet lists the melt as unanswered, the code is held, as a payment still with the mint');
    till.recvClockTick(till._invoiceRun);
    ok(till.state.invoice === inv.bolt11 && !till._requoting, 'and no new code is asked for, with its minute long gone');
    // the code's watch has ended by now (its minute and a quarter are long gone), and the mint answers
    till.stopReceive();
    inFlight = [];
    ok(till.fcUsdHolds(inv.hash) && !till._fcUsd.pending && till._fcUsd.landingUntil > Date.now(),
       'the mint answered: the hold becomes the twenty seconds the watch has to see the dollars');
    ok(till.state.recvExpiresAt > Date.now() && till.state.recvExpiresAt <= Date.now() + 20000,
       'its watch is begun again, and the clock counts those twenty seconds, not a minute the code does not have', String(till.state.recvExpiresAt - Date.now()));
    ok(!!till._stopWatch && !!till._recvClockT, 'with the screen’s watch and clock running again');
    till._fcUsd.landingUntil = Date.now() - 1;
    ok(!till.fcUsdHolds(inv.hash), 'then the code is let go');
    W.pendingMelts = real;
    till._fcUsd = null;
  }

  till.stopReceive();
  console.log(failed || until.failed ? '\n' + (failed + until.failed) + ' FAILED' : '\nall flashcard-usd-receive checks pass');
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
