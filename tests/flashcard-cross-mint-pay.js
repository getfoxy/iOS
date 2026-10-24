'use strict';
/* flashcard-cross-mint-pay.js — a card at one mint paying a till at another.
 *
 *     node tests/flashcard-cross-mint-pay.js
 *
 * A card's money is at the mint its record names. A till at another mint, online, has it pay the till's own invoice from
 * there: the invoice on the receive screen is quoted at the card's mint in the card's unit, the charge (the amount and the fee,
 * dollars first) is shown on a confirmation before anything is asked of the card, and PAY taps the card for that total. Its
 * pieces are held at its mint and melted there; the till's mint says the invoice is paid, and the till receives exactly what it
 * asked. Offline it is refused in one sentence, before the card is asked for anything.
 *
 *   1  a bitcoin card at mint A pays a bitcoin receive at mint B: the confirmation first, with nothing signed; the amount exact
 *      at B, the fee on the card ("UP TO" the reserve), the phone home at B after, its own mint still B; what the reserve did not
 *      use goes back on the card at its change tap (TAP TO RECEIVE), and the till keeps nothing at A
 *   1b the same at a card's mint that charges for spending pieces: that fee is the card's too, the swap of its own pieces
 *      included and shown, the card charged no more than PAY said, and the till still gets the amount exactly
 *   1c the same card with a confirmation that left the swap's fee out: refused at the tap before the card signs
 *   2  the same card with a PIN: the PIN pad comes after the confirmation, and says the total with its fee
 *   3  offline: "Paying a card from another mint needs the connection.", nothing signed, nothing taken
 *   4  a dollar card at A pays a bitcoin receive at B: the card's mint quotes it in cents, the till gets the sats exactly
 *   5  a bitcoin card at A pays a dollar receive at B: the dollar code is paid from A in sats, the cents land at B exactly
 *   6  the card's mint refuses the melt: NOT PAID, and the card is whole again at its next tap; the till keeps nothing
 *   7  the card's mint has not answered the melt: the payment is held as any is, the phone home, and the wallet's own sweep
 *      settles it from there
 *   8  a share of a split bill, and a card paying an invoice out of this phone from its own screen (SEND in card mode), are
 *      still refused as A DIFFERENT MINT (not built); money put onto a card at another mint from this phone is built, and is
 *      tests/flashcard-cross-mint-load.js
 *   9  a card that does not hold enough: said, PAY greyed, and no TRY AGAIN (asking again cannot change it)
 *  10  the till's own mint does not answer as the phone comes home: it keeps trying until it is home, the payment lands, and an
 *      invoice asked for meanwhile is made at the till's own mint, never at the card's
 *  11  a melt answered "pending" and later found not paid, with the phone home: the connect's sweep visits the card's mint and
 *      owes the card all of it there, and the card is whole at its next tap
 *  12  the card's swap made at its mint with the answer lost, then answered: never "already spent"; the payment it was for was
 *      never made, so all of it goes back on the card, and the till keeps nothing at the card's mint
 *  13  the same lost answer at a till at the card's own mint: the payment, made, and not plain ecash
 *  14  the fee on the card's own pieces higher at the tap than its confirmation showed: refused before the card signs
 *
 * The screens are the card's parts with the send and receive parts (tests/flashcard-ui-kit.js), over the real wallet, two test
 * mints (tests/flashcard-kit.js `second`) and the model of the card (tests/flashcard-card.js). The two test mints do not know
 * each other's invoices, so the world here does what Lightning does: a melt at A of an invoice B made marks B's quote paid
 * (`linked`). Every case ends with the books of both phones added up.
 */
const { page, newCard, settle, MINT, MINT2, OTHER_WORDS } = require('./flashcard-kit');
const { booksWrong } = require('./harness');
const { appOn, until, pad, card, stage } = require('./flashcard-ui-kit');
// a wait of seconds, not of turns (`until`): for what goes on a timer (the way home, the checking)
async function waitFor(cond, ms) {
  const end = Date.now() + (ms || 10000);
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return !!cond();
}

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const bare = (u) => String(u || '').replace(/\/+$/, '');
const signed = (k) => k.sent.some((x) => /^b0(40|22)/.test(x));
const offline = (c) => c.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (c) => c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
const saved = (c) => bare(JSON.parse(c.storage.getItem('foxy.cashu.mint') || '""'));

/* What Lightning does between the two test mints: a melt at A that the mint says PAID, of an invoice that B made, pays B's quote. */
function linked(R, A, B) {
  R.fate = (m) => {
    const url = new URL(m.url);
    if (url.origin !== MINT || url.pathname !== '/v1/melt/bolt11' || m.method !== 'POST') return null;
    const said = A.handle(m);
    try {
      const body = JSON.parse(String(said).slice(String(said).indexOf('\n') + 1));
      if (body && body.state === 'PAID') {
        const id = Object.keys(B.quotes).filter((k) => B.quotes[k].request === body.request)[0];
        if (id) B.payQuote(id);
      }
    } catch (e) { /* a refusal: nothing paid */ }
    return said;
  };
}

/* H, a card's owner at mint A; R, a till at mint B. `units`/`units2`: what each mint issues; `mintOpts`/`mintOpts2` the rest. */
async function world(o) {
  const opts = o || {};
  const H = page({ second: true, units: opts.units, units2: opts.units2, mintOpts: opts.mintOpts, feePpk: opts.feePpk,
                   mintOpts2: Object.assign({ quotesUnpaid: true }, opts.mintOpts2 || {}) });
  await H.W.connect(MINT, null, null, { remember: true });
  await H.W.claim((await H.W.invoice(9000, '')).hash);
  if (opts.units && opts.units.indexOf('usd') >= 0) {
    const q = await H.W.invoice(20000, '', { unit: 'usd' });
    await H.W.claim(q.hash);
  }
  await H.W.primeLocks();
  const R = page({ second: true, sharedMint: H.mint, sharedMint2: H.mint2, words: OTHER_WORDS });
  await R.W.connect(MINT2, null, null, { remember: true });
  await R.W.primeLocks();
  linked(R, H.mint, H.mint2);
  const till = appOn(R, { screen: 'confirm', flow: 'receive', stack: ['home', 'amount'] }, { send: true, receive: true });
  till.mintNameOf = (u) => bare(u).replace(/^https?:\/\//, '');
  till.mintName = () => till.mintNameOf(R.W.mintUrl);
  await till.refreshBalance();
  return { H, R, till };
}
async function satCard(H, n, pin) {
  const k = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(k, pin ? { pin } : {});
  k.tap();
  if (n) await H.W.cardAdd(k, pin ? { sats: n, pin } : { sats: n, owner: true });
  return k;
}
async function dollarCard(H, cents) {
  const k = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(k, { unit: 'usd' });
  k.tap();
  if (cents) await H.W.cardAdd(k, { amount: cents, unit: 'usd', owner: true });
  return k;
}
// a bitcoin receive of `n` on the till, its invoice made by B
async function bitcoinReceive(till, R, n) {
  const q = await R.W.invoice(n, '');
  till.setState({ screen: 'confirm', flow: 'receive', stack: ['home', 'amount'], wallet: 'sat', unit: 'SATS', amount: String(n),
                  invoice: q.bolt11, invoiceHash: q.hash, recvUnit: 'sat', recvAmount: null, recvExpiresAt: null });
  till.asking = n;
  return q;
}
// (VERIFYING over the code after a cross-mint payment, `fcCardVerifying`, is no card stage: it waits for the mint, as the test does)
const tapDone = (a, ctx) => until('the tap to be over', () => {
  const st = ctx.window.document.getElementById('foxy-stage');
  return !(a._fcTaps > 0) && (!st || st.getAttribute('data-stage') === 'paidCheck');
});
const home = (R) => until('the till to be home at B', () => bare(R.W.mintUrl) === MINT2);
const spec = (a) => a.fcXmSpec();
const rowOf = (a, label) => (spec(a).rows || []).filter((r) => r.label === label)[0] || {};
function booksGood(name, ...pages) {
  const wrong = [];
  pages.forEach((c) => booksWrong(c).forEach((l) => wrong.push(l)));
  ok(wrong.length === 0, name + ': the books add up', wrong.join(' | '));
}

(async () => {
  /* ---- 1: a bitcoin card at A pays a bitcoin receive at B ---------------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 700);
    const atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the confirmation with the card’s mint’s figure', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    const x = till.state.fcXm;
    ok(!signed(k) && k.balance() === cardBefore && !pad(till) && !card(till),
       'the first tap reads the card and nothing more: the confirmation comes up, with no PIN asked and nothing signed');
    ok(bare(R.W.mintUrl) === MINT2, 'the fee is asked of the card’s mint with this phone still at its own', R.W.mintUrl);
    ok(spec(till).title === 'A CARD FROM ANOTHER MINT' && spec(till).amountLabel === 'THE CARD PAYS' && x.pay === 710 && x.fee === 10,
       'it says what the card pays: the amount and the mint’s fee reserve', JSON.stringify({ pay: x.pay, fee: x.fee }));
    ok(rowOf(till, 'YOU RECEIVE').value === '₿ 700' && rowOf(till, 'FEE, PAID BY THE CARD').value === 'UP TO ₿ 10'
       && rowOf(till, 'THE CARD’S MINT').value === 'M.TEST' && rowOf(till, 'YOUR MINT').value === 'N.TEST',
       'its rows: what this phone receives, the fee the card pays, and the two mints', JSON.stringify(spec(till).rows.map((r) => r.label + '=' + r.value)));
    ok(spec(till).cta === 'PAY ₿ 710' && !spec(till).ctaBusy, 'PAY says the total, and can be pressed', spec(till).cta);
    k.tap();
    R.sheet.length = 0;
    till.melts.length = 0;
    spec(till).go();
    // the seconds it takes to reach the card's mint have a screen of their own, not the receive's code bare (`fcXmGo`)
    const reaching = till.melts[0] === 'Reaching m.test\u2026' && till.melting === true;
    await until('the invoice to be paid at B', () => R.mint2.quotes[q.hash].state === 'PAID');
    await tapDone(till, R);
    await home(R);
    await settle();
    ok(reaching, 'PAY: "Reaching" the card’s mint is on the screen while it is reached', JSON.stringify(till.melts));
    ok(/^begin: Hold to pay ₿710/.test(R.sheet[0] || ''), 'the sheet says what the hold pays', R.sheet[0]);
    ok(cardBefore - k.balance() === 710, 'the card paid the total it was shown at the tap, its own change back on it', String(cardBefore - k.balance()));
    ok(saved(R) === MINT2 && bare(R.W.mintUrl) === MINT2, 'the till is home at B, and B is still its own mint', saved(R) + ' ' + R.W.mintUrl);
    await R.W.claim(q.hash);
    await settle();
    ok(R.W.balanceAt(MINT2) - atB === 700, 'the till received exactly what it asked, at its own mint', String(R.W.balanceAt(MINT2) - atB));
    const owed1 = R.W.cardOwed().filter((r) => r.card === k.key).reduce((n, r) => n + r.amount, 0);
    ok(R.W.balanceAt(MINT) === 0 && owed1 === 8, 'what the fee reserve did not use is the card’s, owed to it at its mint, and the till keeps none of it',
       JSON.stringify({ a: R.W.balanceAt(MINT), owed: owed1 }));
    await until('the change tap', () => !!card(till) && card(till).title === 'TAP TO RECEIVE');
    ok(/receive its ₿ ?8 of change/.test(card(till).reason) && card(till).has('TAP CARD'), 'the card is asked for its change tap, as after any till payment', card(till).all);
    k.tap();
    card(till).press('TAP CARD');
    await until('the change on the card', () => cardBefore - k.balance() === 702);
    await settle();
    ok(cardBefore - k.balance() === 702, 'after the change tap the card paid the amount and the fee the payment used, and no more', String(cardBefore - k.balance()));
    ok(!R.W.cardOutHeld().length && !R.W.pendingMelts().length && !R.W.cardOwed().length, 'nothing is left held, waiting or owed');
    booksGood('a bitcoin card at another mint', H, R);
  }

  /* ---- 1b: at a card's mint that charges for spending pieces ------------------------------------------------------- */
  {
    const { H, R, till } = await world({ feePpk: 400 });
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 600);
    const atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    const x = till.state.fcXm;
    ok(x.pay > 610 && x.fee === x.pay - 600, 'the total has the card’s mint’s fee on the pieces it is cut into, beside the reserve', JSON.stringify({ pay: x.pay, fee: x.fee }));
    k.tap();
    spec(till).go();
    await until('the invoice to be paid at B', () => R.mint2.quotes[q.hash].state === 'PAID');
    await tapDone(till, R);
    await home(R);
    await settle();
    /* (the mint's fee for the swap of the card's own pieces into the till's hold is in what was shown: worked out from the pieces the tap
     * picks, 3 sats here, and held to at the tap) */
    const spent = cardBefore - k.balance();
    ok(x.cardFee > 0 && spent === x.pay, 'the card was charged what PAY said, its own pieces’ swap fee in it, and no more',
       spent + ' for ' + x.pay + ' (its own pieces ' + x.cardFee + ')');
    await R.W.claim(q.hash);
    ok(R.W.balanceAt(MINT2) - atB === 600 && !R.W.cardOutHeld().length && !R.W.pendingMelts().length, 'the till got the amount exactly, and nothing is left held',
       String(R.W.balanceAt(MINT2) - atB));
    booksGood('a card at a mint that charges for pieces', H, R);
  }

  /* ---- 2: with a PIN: the pad after the confirmation ------------------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await satCard(H, 3000, '2468');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 900);
    const cardBefore = k.balance();
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    ok(!pad(till) && !signed(k), 'the charge is shown before the PIN is asked');
    spec(till).go();
    await until('the PIN pad', () => !!pad(till));
    ok(/^To pay ₿910, its fee included\. /.test(pad(till).sub) && pad(till).cta === 'TAP AGAIN', 'the pad says the total with its fee', pad(till).sub);
    k.tap();
    pad(till).type('2468');
    await until('the invoice to be paid at B', () => R.mint2.quotes[q.hash].state === 'PAID');
    await tapDone(till, R);
    await home(R);
    await settle();
    ok(cardBefore - k.balance() === 910 && saved(R) === MINT2, 'paid with the PIN, the total and no more, and home', String(cardBefore - k.balance()));
    await R.W.claim(q.hash);
    booksGood('a card with a PIN at another mint', H, R);
  }

  /* ---- 3: offline ------------------------------------------------------------------------------------------------ */
  {
    const { H, R, till } = await world();
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    await bitcoinReceive(till, R, 700);
    offline(R);
    const cardBefore = k.balance();
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the refusal', () => !!card(till));
    ok(card(till).reason === 'Paying a card from another mint needs the connection.' && !signed(k) && k.balance() === cardBefore,
       'refused in one sentence, before anything is signed or taken', card(till).all);
    ok(till.state.screen === 'confirm' && bare(R.W.mintUrl) === MINT2, 'the receive screen stays, at the till’s own mint');
    card(till).press('CLOSE');
    online(R);
    booksGood('offline, a card at another mint', H, R);
  }

  /* ---- 4: a dollar card at A pays a bitcoin receive at B ------------------------------------------------------------ */
  {
    const { H, R, till } = await world({ units: ['sat', 'usd'] });
    const k = await dollarCard(H, 2000);
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 7000);
    const atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    const x = till.state.fcXm;
    const cents = Math.ceil(7000 * 1000 * 76900 / 1e9);
    ok(x.payUnit === 'usd' && x.pay === cents + 2 && x.fee === 2 && spec(till).cta === 'PAY $ ' + ((cents + 2) / 100).toFixed(2),
       'the card’s mint quotes the sats in cents, with its fee, and PAY says the dollars', JSON.stringify({ pay: x.pay, cta: spec(till).cta }));
    ok(rowOf(till, 'YOU RECEIVE').value === '₿ 7,000' && rowOf(till, 'FEE, PAID BY THE CARD').value === 'UP TO $ 0.02', 'the rows: the sats asked, the fee in dollars',
       JSON.stringify(spec(till).rows.map((r) => r.value)));
    k.tap();
    spec(till).go();
    await until('the invoice to be paid at B', () => R.mint2.quotes[q.hash].state === 'PAID');
    await tapDone(till, R);
    await home(R);
    await settle();
    ok(cardBefore - k.balance() === cents + 2, 'the card paid the cents it was shown', String(cardBefore - k.balance()));
    await R.W.claim(q.hash);
    ok(R.W.balanceAt(MINT2) - atB === 7000, 'the till got the sats asked, exactly', String(R.W.balanceAt(MINT2) - atB));
    booksGood('a dollar card at another mint, a bitcoin ask', H, R);
  }

  /* ---- 5: a bitcoin card at A pays a dollar receive at B ------------------------------------------------------------ */
  {
    const { H, R, till } = await world({ units2: ['sat', 'usd'] });
    const k = await satCard(H, 4000, '');
    R.nfc = k;
    till.setState({ screen: 'confirm', flow: 'receive', stack: ['home', 'amount'], wallet: 'usd', unit: 'USD', amount: '1.00',
                    invoice: '', invoiceHash: '', recvAmount: null, recvUnit: '' });
    till.openUsdReceive(100);
    await until('the dollar code', () => !!till.state.invoice);
    const hash = till.state.invoiceHash;
    const usdBefore = R.W.balanceOf('usd'), cardBefore = k.balance();
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    const x = till.state.fcXm;
    const sats = R.W.amountOf(till.state.invoice);
    ok(x.payUnit === 'sat' && x.ask.unit === 'usd' && x.pay === sats + 10 && rowOf(till, 'YOU RECEIVE').value === '$ 1.00',
       'the dollar code is quoted at the card’s mint in sats, and the till is said to receive the dollars asked', JSON.stringify({ pay: x.pay, sats, row: rowOf(till, 'YOU RECEIVE').value }));
    k.tap();
    spec(till).go();
    await until('the dollar code to be paid at B', () => R.mint2.quotes[hash].state === 'PAID');
    await tapDone(till, R);
    await home(R);
    await settle();
    ok(cardBefore - k.balance() === sats + 10, 'the card paid the sats it was shown', String(cardBefore - k.balance()));
    await R.W.claim(hash);
    ok(R.W.balanceOf('usd') - usdBefore === 100, 'the cents asked landed at B, exactly', String(R.W.balanceOf('usd') - usdBefore));
    till.stopReceive();
    booksGood('a bitcoin card at another mint, a dollar ask', H, R);
  }

  /* ---- 6: the card's mint refuses the melt ----------------------------------------------------------------------- */
  {
    const { H, R, till } = await world({ mintOpts: { meltRefuse: true } });
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 700);
    const cardBefore = k.balance(), atB = R.W.balanceAt(MINT2);
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    k.tap();
    spec(till).go();
    await until('NOT PAID', () => !!card(till) && card(till).title === 'NOT PAID');
    await tapDone(till, R);
    await home(R);
    await settle();
    ok(/goes back on the card: tap it to put it back\.$/.test(card(till).reason) && card(till).has('TAP CARD'),
       'NOT PAID: what the card paid goes back on it, with TAP CARD', card(till).all);
    ok(R.mint2.quotes[q.hash].state === 'UNPAID' && saved(R) === MINT2 && bare(R.W.mintUrl) === MINT2, 'the invoice is unpaid, and the till is home');
    k.tap();
    card(till).press('TAP CARD');
    await until('the card to be whole again', () => k.balance() === cardBefore);
    await settle();
    ok(k.balance() === cardBefore, 'put back from the till’s own mint, the card is whole', k.balance() + ' of ' + cardBefore);
    ok(R.W.balanceAt(MINT) === 0 && R.W.balanceAt(MINT2) === atB && !R.W.cardOwed().length && !R.W.cardOutHeld().length,
       'the till keeps nothing of it, and owes the card nothing more', JSON.stringify({ a: R.W.balanceAt(MINT), owed: R.W.cardOwed().length }));
    booksGood('the melt refused', H, R);
  }

  /* ---- 7: the card's mint has not answered the melt ------------------------------------------------------------- */
  {
    const { H, R, till } = await world({ mintOpts: { meltPending: true } });
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 700);
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    k.tap();
    spec(till).go();
    await until('the melt to be held', () => R.W.pendingMelts().length === 1);
    await tapDone(till, R);
    await home(R);
    await settle();
    ok(till.toasts.indexOf('The card’s mint has not answered yet. The payment lands when it does.') >= 0, 'said as waiting, and the phone is home',
       JSON.stringify(till.toasts));
    const held = R.W.pendingMelts()[0];
    ok(!!held && bare(held.mint) === MINT && held.bolt11 === q.bolt11, 'the melt is held at the card’s mint as any unanswered payment is', JSON.stringify(held && { mint: held.mint }));
    H.mint.settleMelt(held.quote, 'paid');
    R.mint2.payQuote(q.hash);
    await R.W.sweepMelts();
    await settle();
    ok(!R.W.pendingMelts().length && bare(R.W.mintUrl) === MINT2, 'the wallet’s own sweep settles it from home, with a wallet made for the card’s mint');
    await R.W.claim(q.hash);
    booksGood('the melt unanswered', H, R);
  }

  /* ---- 8: what is still refused ------------------------------------------------------------------------------------ */
  {
    const { H, R, till } = await world();
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    k.tap();
    k.sent.length = 0;
    till.fcPayBegin(500, { idx: 0, hash: 'x' });
    await until('the refusal', () => !!card(till));
    ok(card(till).title === 'A DIFFERENT MINT' && !signed(k) && till.state.screen !== 'fcXmConfirm', 'a share of a split bill: A DIFFERENT MINT, as before', card(till).all);
    card(till).press('CLOSE');
    booksGood('a share at another mint', H, R);
  }

  /* ---- 9: a card that does not hold enough --------------------------------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await satCard(H, 500, '');
    R.nfc = k;
    await bitcoinReceive(till, R, 700);
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    const sp = spec(till);
    ok(/^The card holds ₿ ?500, and this needs ₿ ?710 with its fee\.$/.test(sp.warn) && sp.cta === 'PAY ₿ 710' && sp.ctaBusy === true && sp.cta !== 'TRY AGAIN',
       'a card short of the total: said, PAY greyed, and no TRY AGAIN', JSON.stringify({ warn: sp.warn, cta: sp.cta, busy: sp.ctaBusy }));
    sp.go();
    await settle();
    ok(till.state.screen === 'fcXmConfirm' && !signed(k) && !pad(till), 'PAY does nothing, and nothing is asked of the card');
    booksGood('a card short of the total', H, R);
  }

  /* ---- 10: the till's own mint does not answer as the phone comes home ----------------------------------------------- */
  {
    const { H, R, till } = await world();
    R.W._cardHomeRetryMs = [300, 600, 1000];
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 700);
    let paidN = 0;
    const stopWatch = R.W.watch(q.hash, () => { paidN += 1; }, { timeoutMs: 600000 });
    const atB = R.W.balanceAt(MINT2);
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    const prev = R.fate;
    let downB = false;
    R.fate = (m) => {
      const u = new URL(m.url);
      if (u.origin === MINT2 && downB) return '504\n{"detail":"B is slow"}';
      const r = prev(m);
      if (u.origin === MINT && u.pathname === '/v1/melt/bolt11' && m.method === 'POST') { downB = true; setTimeout(() => { downB = false; }, 3000); }
      return r;
    };
    k.tap();
    spec(till).go();
    await until('the invoice to be paid at B', () => R.mint2.quotes[q.hash].state === 'PAID');
    // asked for while this phone is still at the card's mint: it waits to be made at home
    const asked = R.W.invoice(100, '');
    await waitFor(() => bare(R.W.mintUrl) === MINT2 && !R.W.cardAwayNow(), 30000);
    ok(bare(R.W.mintUrl) === MINT2 && saved(R) === MINT2, 'B not answering once does not leave the till at the card’s mint: it is home when B answers', R.W.mintUrl);
    const q2 = await asked;
    const quotes = JSON.parse(R.storage.getItem('foxy.cashu.quotes') || '[]');
    const made = quotes.filter((e) => e.quote === q2.hash)[0] || {};
    ok(bare(made.mint) === MINT2, 'an invoice asked for during the visit is made at the till’s own mint', JSON.stringify(made.mint));
    await waitFor(() => paidN > 0, 30000);
    ok(paidN === 1 && R.W.balanceAt(MINT2) - atB === 700, 'the payment lands at B once the till is home, exactly', JSON.stringify({ paidN, b: R.W.balanceAt(MINT2) - atB }));
    stopWatch && stopWatch();
    booksGood('the till’s mint slow to answer after the melt', H, R);
  }

  /* ---- 11: a melt answered "pending", later found not paid, with the phone home --------------------------------------- */
  {
    const { H, R, till } = await world({ mintOpts: { meltPending: true } });
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 700);
    const cardBefore = k.balance();
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    k.tap();
    spec(till).go();
    await until('the melt to be held', () => R.W.pendingMelts().length === 1);
    await tapDone(till, R);
    await home(R);
    await settle();
    const held = R.W.pendingMelts()[0];
    H.mint.settleMelt(held.quote, 'failed');
    const prev = R.fate;
    R.fate = (m) => {
      const u = new URL(m.url);
      if (u.origin === MINT && u.pathname.indexOf('/v1/melt/quote/bolt11/') === 0 && m.method === 'GET') {
        const said = String(H.mint.handle(m)); const i = said.indexOf('\n'); const b = JSON.parse(said.slice(i + 1));
        if (b.state === 'FAILED') b.state = 'UNPAID';
        return said.slice(0, i) + '\n' + JSON.stringify(b);
      }
      return prev(m);
    };
    const mk = 'foxy.cashu.melting';
    const list = JSON.parse(R.storage.getItem(mk));
    list.forEach((e) => { e.at = Math.floor(Date.now() / 1000) - 400; });
    R.storage.setItem(mk, JSON.stringify(list));
    await R.W.sweepMelts();
    await settle();
    // the next connect at home (a relaunch, a route back) settles what was left at the card's mint, on a visit
    await R.W.connect(MINT2, null, null, { remember: true });
    await waitFor(() => !R.W.cardOutHeld().length && R.W.cardOwed().some((r) => r.card === k.key) && !R.W.cardAwayNow() && bare(R.W.mintUrl) === MINT2, 30000);
    const owed = R.W.cardOwed().filter((r) => r.card === k.key).reduce((n, r) => n + r.amount, 0);
    ok(!R.W.cardOutHeld().length && owed === 710 && bare(R.W.mintUrl) === MINT2 && saved(R) === MINT2,
       'all of it is owed back to the card at its mint, made there on a visit, and the till is home', JSON.stringify({ held: R.W.cardOutHeld(), owed, at: R.W.mintUrl }));
    k.tap();
    till.fcWriteAsk({});
    await waitFor(() => k.balance() === cardBefore, 20000);
    await settle();
    ok(k.balance() === cardBefore && R.mint2.quotes[q.hash].state === 'UNPAID' && R.W.balanceAt(MINT) === 0,
       'the card is whole at its next tap, the invoice unpaid, and the till keeps nothing', JSON.stringify({ card: k.balance(), was: cardBefore, a: R.W.balanceAt(MINT) }));
    booksGood('a pending melt found not paid', H, R);
  }

  /* ---- 12: the card's swap made with its answer lost, then answered ---------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 700);
    const atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    const prev = R.fate;
    let lose = true, down = false;
    R.fate = (m) => {
      const u = new URL(m.url);
      if (u.origin === MINT && down) return '504\n{"detail":"lost"}';
      if (u.origin === MINT && lose && u.pathname === '/v1/swap' && m.method === 'POST') { H.mint.handle(m); lose = false; down = true; return '504\n{"detail":"the answer was lost"}'; }
      return prev(m);
    };
    k.tap();
    spec(till).go();
    await waitFor(() => stage(R) === 'cardChecking', 60000);
    setTimeout(() => { down = false; }, 3000);
    await waitFor(() => stage(R) !== 'cardChecking', 120000);
    await waitFor(() => !!card(till), 20000);
    await waitFor(() => !R.W.cardAwayNow() && bare(R.W.mintUrl) === MINT2, 30000);
    await settle();
    ok(!!card(till) && card(till).title === 'NOT PAID' && !/already spent/.test(card(till).all) && card(till).has('TAP CARD'),
       'never “already spent”: NOT PAID, and what the card paid goes back on it', card(till) && card(till).all);
    ok(R.W.balanceAt(MINT) === 0 && R.W.balanceAt(MINT2) === atB && R.mint2.quotes[q.hash].state === 'UNPAID',
       'the till keeps nothing at the card’s mint, and the invoice is unpaid', JSON.stringify({ a: R.W.balanceAt(MINT), b: R.W.balanceAt(MINT2) - atB }));
    k.tap();
    card(till).press('TAP CARD');
    await waitFor(() => k.balance() === cardBefore, 20000);
    await settle();
    ok(k.balance() === cardBefore && !R.W.cardOwed().length, 'the card is whole at its next tap', k.balance() + ' of ' + cardBefore);
    booksGood('a lost swap answer at the card’s mint', H, R);
  }

  /* ---- 13: the same lost answer at a till at the card's own mint --------------------------------------------------- */
  {
    const { H, R, till } = await world();
    await R.W.connect(MINT, null, null, { remember: true });
    await till.refreshBalance();
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    const q = await R.W.invoice(700, '');
    till.setState({ screen: 'confirm', flow: 'receive', stack: ['home', 'amount'], wallet: 'sat', unit: 'SATS', amount: '700',
                    invoice: q.bolt11, invoiceHash: q.hash, recvUnit: 'sat', recvAmount: null, recvExpiresAt: null });
    till.asking = 700;
    const atA = R.W.balanceAt(MINT), cardBefore = k.balance();
    const prev = R.fate;
    let lose = true, down = false;
    R.fate = (m) => {
      const u = new URL(m.url);
      if (u.origin === MINT && down) return '504\n{"detail":"lost"}';
      if (u.origin === MINT && lose && u.pathname === '/v1/swap' && m.method === 'POST') { H.mint.handle(m); lose = false; down = true; return '504\n{"detail":"the answer was lost"}'; }
      return prev(m);
    };
    k.tap();
    till.payByCard();
    await waitFor(() => stage(R) === 'cardChecking', 60000);
    setTimeout(() => { down = false; }, 3000);
    await waitFor(() => stage(R) !== 'cardChecking', 120000);
    await settle();
    await settle();
    const tx = await R.W.transactions(50);
    const entry = tx.filter((t) => t.dir === 'in' && /card/.test(String(t.memo || '')))[0];
    ok(!(card(till) && /already spent/.test(card(till).all)) && R.W.balanceAt(MINT) - atA >= 700 && cardBefore - k.balance() >= 700 && !!entry,
       'a lost answer at the card’s own mint is the payment, made, and its entry a card’s', JSON.stringify({ shown: card(till) && card(till).all, a: R.W.balanceAt(MINT) - atA,
         card: cardBefore - k.balance(), tx: tx.map((t) => t.memo) }));
    booksGood('a lost swap answer at a till at the card’s mint', H, R);
  }

  /* ---- 14: the fee on the card's own pieces higher at the tap than shown ---------------------------------------------- */
  {
    const { H, R, till } = await world({ feePpk: 400 });
    const k = await satCard(H, 3000, '');
    R.nfc = k;
    await bitcoinReceive(till, R, 600);
    const cardBefore = k.balance();
    k.tap();
    till.payByCard();
    await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && till.state.fcXm.quote));
    // a confirmation that had no card to work its pieces' fee out from (as if it had changed since): 0 shown for it
    till.setState({ fcXm: Object.assign({}, till.state.fcXm, { pay: till.state.fcXm.want, cardFee: 0, fee: till.state.fcXm.want - 600 }) });
    k.tap();
    k.sent.length = 0;
    spec(till).go();
    await waitFor(() => !!card(till), 20000);
    await waitFor(() => !R.W.cardAwayNow() && bare(R.W.mintUrl) === MINT2, 30000);
    await settle();
    ok(!!card(till) && card(till).title === 'NOT PAID' && /more than was shown/.test(card(till).reason) && !signed(k) && k.balance() === cardBefore,
       'refused before the card signs, and nothing is taken', card(till) && card(till).all);
    card(till).press('CLOSE');
    booksGood('the card’s own fee more than shown', H, R);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed' + (until.failed ? ', ' + until.failed + ' waits timed out' : ''));
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
