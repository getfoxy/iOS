'use strict';
/* flashcard-usd-receive.js — CARD on a receive into the dollar balance.
 *
 *     node tests/flashcard-usd-receive.js
 *
 * At a mint with two balances, a receive into dollars asks the card in both: a dollar card pays the cents, and a bitcoin card
 * the sats those dollars come to at this phone's own price, as a tap pays a dollar price in sats (tests/sats-for-dollars-tap.js).
 * Nothing waits for the mint's dollar invoice, which is for a Lightning payer (the keeper, 2026-11-02): CARD is there, and the
 * card is taken, the moment the screen is up. The sats land as sats and are owed into dollars for a wallet that holds dollars
 * (`convert`), and a wallet that holds both keeps them as bitcoin.
 *
 * The till is build/app/26f-flashcard.js with the receive's own parts lifted out of their files (flashcard-ui-kit.js,
 * `receive: true`), over the real wallet, the test mint with two balances (tests/harness.js, `units`) and the model of a
 * card (tests/flashcard-card.js). What is checked: CARD before any invoice; a bitcoin card pays the sats at this phone's price,
 * which land as sats with no invoice paid and no melt, the figures its screens show, and their swap into dollars owed; with no
 * price, a bitcoin card is asked for nothing; a refusal leaves every balance as it was; a bitcoin receive's CARD is exactly what
 * it was; and the hold on a code a card pays from another mint (`fcUsdHolds`). */
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
  /* ---- 1: $1.00, paid by a bitcoin card before any invoice --------------------------------------------------------- */
  const { H, R, k, till } = await world({ satFeeReserve: 0 }, 0);
  {
    // this phone's price: $76,923.08, so $1.00 is 1,300 sats
    R.W._rate = 76923.08; R.W._rateAt = Date.now();
    R.W.setWalletChoice({ hold: 'dollars' });
    ok(till.twoUnitsOn() && till.walletNow('receive') === 'usd', 'a mint with two balances, and this receive is into dollars');
    till.setState({ screen: 'confirm', flow: 'receive', wallet: 'usd', unit: 'USD', amount: '1.00', invoice: '', invoiceHash: '', recvAmount: null, recvUnit: 'usd' });
    const v = screen(till);
    ok(v.recvTapShown === true && v.recvCardShown === true && !till.state.invoice, 'before the mint has made any invoice: TAP, and CARD');
    const cardBefore = k.balance();
    const satsBefore = sats(R), centsBefore = cents(R);
    const meltsBefore = meltsAsked(R);
    k.tap();
    k.sent.length = 0;
    R.sheet.length = 0;
    till.toasts.length = 0;
    till.payByCard();
    ok(/^begin: /.test(R.sheet[0] || '') && !till.toasts.some((m) => /code is being made/.test(m)), 'CARD brings up the sheet at once, with no invoice waited for', R.sheet[0]);
    await until('the card to want its PIN', () => !!pad(till));
    ok(pad(till).title === 'CARD PIN' && pad(till).sub === 'To pay $1.00 (₿1,300). The card’s owner types its PIN here.' && pad(till).cta === 'TAP AGAIN',
       'the PIN pad names the dollars asked and the sats the card pays at this phone’s price', pad(till).sub);
    ok(behind(R) && behind(R).amount === '$1.00' && subLine(R) === '₿1,300',
       'behind the sheet: $1.00, with ₿1,300 under it: the figure the holder agrees to', JSON.stringify({ amount: behind(R) && behind(R).amount, sub: subLine(R) }));
    ok(!till._fcUsd && !till.fcUsdHolds(''), 'no code is held for the card: nothing pays one');
    pad(till).type('1234');
    await until('the payment', () => till.state.screen !== 'confirm');
    await until('the tap to be over', () => !(till._fcTaps > 0) && R.W.cardOwed().length === 0 && !stage(R));
    await settle();
    ok(cardBefore - k.balance() === 1300, 'the card paid 1,300 sats', String(cardBefore - k.balance()));
    const fromCard = history(R).find((e) => e.memo === 'card' && e.dir === 'in' && e.sats === 1300);
    const recs = JSON.parse(R.window.localStorage.getItem('foxy.cashu.convert') || '[]');
    const rec = (Array.isArray(recs) ? recs : Object.values(recs || {})).find((r) => r && fromCard && r.id === fromCard.hash);
    ok(!!fromCard && meltsAsked(R) === meltsBefore && ((sats(R) - satsBefore === 1300 && cents(R) === centsBefore) || cents(R) > centsBefore),
       'the sats landed in this phone’s bitcoin, no invoice paid and no melt sent', JSON.stringify({ sat: sats(R) - satsBefore, usd: cents(R) - centsBefore, melts: meltsAsked(R) - meltsBefore }));
    ok(rec && rec.from === 'sat' && rec.to === 'usd' && rec.usd === 100 && rec.hash === fromCard.hash && ['claimed', 'quoting', 'swapping', 'done'].indexOf(rec.state) >= 0,
       'and owed into dollars, for the 100 cents asked, on its own entry (this wallet holds dollars)', JSON.stringify(rec));
    ok(fromCard && fromCard.convert && fromCard.convert !== '', 'its entry says it is to become dollars', JSON.stringify(fromCard && fromCard.convert));
    ok(booksWrong(R).length === 0, 'the till’s books add up, per unit', booksWrong(R).join(' / '));
  }

  /* ---- 1b: a wallet holding both keeps the card's sats as bitcoin ------------------------------------------------- */
  {
    R.W.setWalletChoice({ hold: 'both' });
    R.W._rate = 76923.08; R.W._rateAt = Date.now();
    till.setState({ screen: 'confirm', flow: 'receive', wallet: 'usd', unit: 'USD', amount: '0.50', invoice: '', invoiceHash: '', recvAmount: null, recvUnit: 'usd' });
    const satsBefore = sats(R);
    k.tap();
    till.payByCard();
    await until('the PIN pad', () => !!pad(till));
    pad(till).type('1234');
    await until('the payment', () => till.state.screen !== 'confirm');
    await until('the tap to be over', () => !(till._fcTaps > 0) && R.W.cardOwed().length === 0 && !stage(R));
    await settle();
    const e650 = history(R).find((e) => e.memo === 'card' && e.dir === 'in' && e.sats === 650);
    const recs = JSON.parse(R.window.localStorage.getItem('foxy.cashu.convert') || '[]');
    const rec = (Array.isArray(recs) ? recs : Object.values(recs || {})).find((r) => r && e650 && r.id === e650.hash);
    ok(!!e650 && sats(R) - satsBefore === 650 && !rec, 'holding both: 650 sats for $0.50 land as bitcoin, and nothing is owed into dollars', JSON.stringify({ sat: sats(R) - satsBefore, rec }));
    R.W.setWalletChoice({ hold: 'dollars' });
  }

  /* ---- 1c: no price: a bitcoin card is asked for nothing it holds ------------------------------------------------- */
  {
    R.W._rate = 0; R.W._rateAt = 0;
    till.setState({ screen: 'confirm', flow: 'receive', wallet: 'usd', unit: 'USD', amount: '1.00', invoice: '', invoiceHash: '', recvAmount: null, recvUnit: 'usd' });
    const cardBefore = k.balance(), satsBefore = sats(R);
    const starts = [];
    const realStart = till.fcPayStart;
    till.fcPayStart = (n, off, share, send, usd, terms) => { starts.push({ n, usd, terms }); };
    till.payByCard();
    till.fcPayStart = realStart;
    ok(starts.length === 1 && starts[0].n === 0 && starts[0].usd && starts[0].usd.satsWhy === 'none' && !starts[0].terms,
       'no price on this phone: the card is asked for the cents alone, and a bitcoin card is told why once read', JSON.stringify(starts));
    ok(k.balance() === cardBefore && sats(R) === satsBefore, 'and nothing moved');
    R.W._rate = 76923.08; R.W._rateAt = Date.now();
  }

  /* ---- 2: a refusal: over the card's daily limit ----------------------------------------------------------------- */
  {
    k.tap();
    await H.W.cardSetLimit(k, { sats: 1000 });
    till.setState({ screen: 'confirm', flow: 'receive', wallet: 'usd', unit: 'USD', amount: '1.00', invoice: '', invoiceHash: '', recvAmount: null, recvUnit: 'usd' });
    const cardBefore = k.balance();
    const satsBefore = sats(R), centsBefore = cents(R);
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the limit to refuse', () => card(till) && card(till).title === 'OVER THE CARD’S DAILY LIMIT');
    ok(/Nothing was taken/.test(card(till).reason) && !k.sent.some((a) => /^b0(40|20)/.test(a)),
       'over the card’s daily limit: the bitcoin receive’s own card and words, before any PIN or signature', card(till).reason);
    ok(k.balance() === cardBefore && sats(R) === satsBefore && cents(R) === centsBefore && till.state.screen === 'confirm',
       'nothing moved, and the receive is still up', JSON.stringify({ usd: cents(R), sat: sats(R) }));
    card(till).press('CLOSE');
    await settle();
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
    ok(till.fcUsdLanding(), 'CARD on it says the card has paid it, while the melt is with the mint');
    /* The wallet holds that melt no longer (the mint answered; a melt that failed is the case that mattered), and the screen's hold
     * has not asked yet: CARD no longer says the code is paid, and VERIFYING comes down. They stayed until the code's clock ran out. */
    {
      const held = inFlight;
      till.fcUsdVerifying(till._fcUsd, 'The card paid. The mint has not answered yet; the dollars land when it does.', 120000);
      const up = stage(R) === 'paidCheck';
      inFlight = [];
      const landing = till.fcUsdLanding();
      ok(up && !landing && stage(R) !== 'paidCheck' && till._fcUsd.pending === true,
         'the melt no longer held: not landing, VERIFYING down, and the answer left to the screen’s hold', JSON.stringify({ up, landing, stage: stage(R) }));
      inFlight = held;
    }
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
