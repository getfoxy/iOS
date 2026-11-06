'use strict';
/* card-spent-on-card.js — pieces the mint says are spent, still on a card.
 *
 *     node tests/card-spent-on-card.js
 *
 * A card lists what it has not signed for, and goes on counting it as money. The mint may have seen some of that spent all the same,
 * and then the card's balance is too high and RESET is refused (`has-money`) for money nobody can spend: a keeper's card showed 25c
 * of it, in red, and could not be reset. What is checked here:
 *
 *   1  how it got there: a top-up cut short leaves its row owed with some of its pieces on the card; the card pays with those; the
 *      next write clears the places that payment used and puts the same pieces on again, spent. Closed: a row a write began on is
 *      asked of the mint first, and only what it has not spent goes on (`cardOwedPrune`, `cardWriteOwed`);
 *   2  a copy of the card pays with some of its pieces: the mint's word says how much, WITHDRAW ALL takes the rest and has the card
 *      let go of the spent ones (`cardSpentOnCard`, `cardBurnPlan`), and the card can then be reset;
 *   3  everything on it spent: RESET takes nothing, lets the spent pieces go, and resets;
 *   4  this phone took the card's money back by its own key after the date (`cardTakeBack`) and the card turned up: RESET the same;
 *   5  the screen: what the card can spend once the mint has answered, the spent figure in red in its HISTORY, and RESET asking for the PIN that
 *      letting the spent pieces go needs; the card's own log says which of its payments were spent pieces let go; RESET's warning
 *      gives no figure while the mint is still being asked;
 *   6  a top-up at another mint than the phone's, cut short, the card paying with part of it: the next write, from the phone's own
 *      mint, asks the card's mint and puts on the rest;
 *   7  the card taken away while it lets the spent pieces go, after the money came off: all of the money is in the phone, and the
 *      words say the spent part is still on the card, not that money is;
 *   8  a signature had back from an earlier tap cut short, in a tap that finds only spent pieces: that money is swapped in;
 *   9  a mint that does not say it answers NUT-07: not asked, and the taking-off goes as it did before, by the card's own figure.
 * Every case ends with the books added up.
 *
 * The card is the model (tests/flashcard-card.js) of a card that signs once for a payment, as it says it is when chosen (1.20), and
 * 2 and 3 again as cards of 1.21, 1.23 and 1.25 (`SOFTWARE`); the mint is the test mint.
 */
const { page, funded, newCard, why, settle, history, MINT, MINT2, OTHER_WORDS } = require('./flashcard-kit');
const { booksWrong } = require('./harness');
const { appOn, until, pad, card: cardOf, vals } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
// what every real-wallet suite ends a case with: each page's entries account for what it holds (tests/harness.js, "the books")
function booksGood(name, ...pages) {
  const wrong = [];
  pages.forEach((c) => booksWrong(c).forEach((l) => wrong.push(l)));
  ok(wrong.length === 0, name + ': the books add up', wrong.join(' | '));
}
const owed = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.owed') || '[]');
// past a piece's date (fourteen days), as the take-back suite moves the page's clock, which the test mint reads too
const MONTH = 31 * 24 * 3600 * 1000;
// the card as it says it is when chosen, and the software that changed what a payment asks of it since: the PIN first, two currencies, the floor
const SOFTWARE = [0, 21, 23, 25];
function later(c, ms) {
  const real = c.window.Date.now.bind(c.window.Date);
  c.window.Date.now = () => real() + ms;
  return () => { c.window.Date.now = real; };
}

/* A holder (H) and a till (R) at one mint, and a card the holder set up with the PIN 1234 and `sats` on it. */
async function world(sats, software) {
  const H = await funded({}, 9000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H, undefined, Object.assign({ format: 4 }, software ? { software } : {}));
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  if (sats) { await H.W.cardAdd(card, { sats, pin: '1234' }); card.tap(); }
  return { H, R, card };
}
// the owner's read, and the mint's word on it
async function asked(H, card) {
  card.tap();
  const seen = await H.W.cardLook(card, { mine: true });
  return { seen, check: await H.W.cardCheck(seen) };
}

(async () => {
  /* ---- 1: a write cut short, a payment, and the next write ------------------------------------------------------------------- */
  {
    const { H, R, card } = await world(0);
    card.tap();
    await H.W.cardPrepare(await H.W.cardLook(card), 2000);
    card.tap();
    // three loads answered, and the card leaves as the fourth is sent: some of the top-up is on it, and its row is still owed
    card.leaveBefore('30', 3);
    const cut = await why(H.W.cardWrite(card, { owner: true }));
    const onAfterCut = card.balance();
    ok(cut === 'gone' && onAfterCut > 0 && onAfterCut < 2000 && owed(H).length === 1 && owed(H)[0].tried > 0,
       'a top-up cut short: part of it is on the card, its row is still owed, and the row says a write began on it', cut + ' ' + onAfterCut + ' ' + owed(H).length);
    card.tap();
    const paid = await R.W.cardPay(card, { sats: onAfterCut, pin: '1234' });
    ok(paid && card.balance() === 0, 'the card pays a till with what went on, and holds nothing', String(card.balance()));
    await settle();
    card.tap();
    await H.W.cardWrite(card, { owner: true });
    const { check } = await asked(H, card);
    ok(check.spent === 0 && card.balance() === 2000 - onAfterCut,
       'the next write puts on only what the mint has not spent: the card holds the rest of the top-up and nothing spent (before, the same pieces went on again, spent)',
       JSON.stringify({ spent: check.spent, holds: card.balance(), want: 2000 - onAfterCut }));
    ok(owed(H).length === 0, 'and nothing is left owed to the card', String(owed(H).length));
    const lines = history(H).filter((e) => e.memo === 'to card');
    ok(lines.length === 1, 'the top-up is one line in the history', String(lines.length));
    booksGood('a write cut short and finished', H, R);

    // a row a write began on is not written by a tap that has not asked the mint about it
    {
      const W2 = await world(0);
      W2.card.tap();
      await W2.H.W.cardPrepare(await W2.H.W.cardLook(W2.card), 1000);
      W2.card.tap();
      W2.card.leaveBefore('30', 2);
      await why(W2.H.W.cardWrite(W2.card, { owner: true }));
      const had = W2.card.balance();
      W2.H.deaf = true;
      W2.card.tap();
      const quiet = await W2.H.W.cardWrite(W2.card, { owner: true }).then((r) => r, (e) => e);
      ok(W2.card.balance() === had && owed(W2.H).length === 1 && quiet && (quiet.left === 1 || quiet.card),
         'with the mint not answering, the rest of a row a write began on waits, owed, and nothing more goes on', JSON.stringify({ holds: W2.card.balance(), had, left: quiet && quiet.left, why: quiet && (quiet.why || quiet.card) }));
      W2.H.deaf = false;
      W2.card.tap();
      await W2.H.W.cardWrite(W2.card, { owner: true });
      ok(W2.card.balance() === 1000 && owed(W2.H).length === 0, 'and once it answers, the rest goes on', String(W2.card.balance()));
    }
    await settle();
  }

  /* ---- 2: a copy of the card paid with some of it ---------------------------------------------------------------------------- */
  for (const software of SOFTWARE) {
    const V = software ? ' (1.' + software + ')' : '';
    const { H, R, card } = await world(2000, software);
    const twin = card.copy();
    twin.tap();
    const paid = await R.W.cardPay(twin, { sats: 300, pin: '1234' });
    await settle();
    const gone = 2000 - twin.balance();
    ok(paid && gone >= 300 && card.balance() === 2000, 'a copy of the card pays 300 with pieces the card itself still lists' + V, 'the copy let go of ' + gone);
    const { check } = await asked(H, card);
    ok(check.spent === gone && check.left === 2000 - gone && check.spentIn.sat === gone, 'the mint says how much of what the card lists is spent, and what is left' + V, JSON.stringify(check));
    card.tap();
    card.sent.length = 0;
    const before = await bal(H);
    const out = await H.W.cardWithdraw(card, { pin: '1234' });
    const after = await bal(H);
    const signs = card.sent.filter((a) => a.slice(0, 4) === 'b024').length;
    ok(out.amount === 2000 - gone && after - before === 2000 - gone && card.balance() === 0,
       'WITHDRAW ALL takes what the mint has not spent, and the card holds nothing after it' + V, JSON.stringify({ amount: out.amount, got: after - before, holds: card.balance() }));
    ok(out.spentOff === gone && signs >= 2, 'and the card let go of the spent pieces, signing for them apart (that signature is thrown away)' + V, JSON.stringify({ spentOff: out.spentOff, signs }));
    ok(!card.sent.some((a) => a.slice(0, 4) === 'b034') || card.state.record.limit === 0, 'with no limit lifted where the card has none' + V);
    ok(history(H).filter((e) => e.memo === 'from card').length === 1, 'one line in the history, for what came off' + V);
    card.tap();
    const reset = await H.W.cardReset(card);
    ok(reset.reset === true && card.state.owner === null, 'and the card can be reset' + V, JSON.stringify(reset));
    booksGood('a copy paid with part of it' + V, H, R);
    await settle();
  }

  // a typed amount: chosen among what the mint has not spent, and the spent pieces are left where they are
  {
    const { H, R, card } = await world(2000);
    const twin = card.copy();
    twin.tap();
    await R.W.cardPay(twin, { sats: 300, pin: '1234' });
    await settle();
    const gone = 2000 - twin.balance();
    await asked(H, card);
    card.tap();
    const out = await H.W.cardWithdraw(card, { pin: '1234', sats: 500 });
    await settle();
    const after = await asked(H, card);
    ok(out.amount === 500 && !owed(H).some((r) => r.kind === 'putback') && after.check.spent === gone && !out.spentOff,
       'WITHDRAW of a typed 500: paid from pieces the mint has not spent (no swap refused, nothing to put back), and the spent ones stay on the card for WITHDRAW ALL or RESET',
       JSON.stringify({ amount: out.amount, spent: after.check.spent, putback: owed(H).filter((r) => r.kind === 'putback').length }));
  }

  /* ---- 3: everything on it spent ------------------------------------------------------------------------------------------- */
  for (const software of SOFTWARE) {
    const V = software ? ' (1.' + software + ')' : '';
    const { H, card } = await world(2000, software);
    const twin = card.copy();
    twin.tap();
    await H.W.cardWithdraw(twin, { pin: '1234' });
    ok(twin.balance() === 0 && card.balance() === 2000, 'a copy has all of it taken off; the card still lists 2,000' + V);
    card.tap();
    const refused = await why(H.W.cardReset(card));
    ok(refused === 'has-money', 'a plain RESET is refused, as it was: the card counts what it lists' + V, refused);
    card.tap();
    const before = await bal(H);
    const done = await H.W.cardEmptyAndReset(card, { pin: '1234' });
    ok(done.reset === true && done.withdrew === 0 && (await bal(H)) === before && card.state.owner === null,
       'RESET (taking the money off first) takes nothing, lets the spent pieces go, and resets the card in the same tap' + V, JSON.stringify(done));
    ok(history(H).filter((e) => e.memo === 'from card').length === 1, 'and writes no line for money that did not move' + V);
    // no PIN given: nothing is let go
    const W3 = await world(1000, software);
    const t3 = W3.card.copy();
    t3.tap();
    await W3.H.W.cardWithdraw(t3, { pin: '1234' });
    W3.card.tap();
    const noPin = await why(W3.H.W.cardEmptyAndReset(W3.card));
    ok(noPin === 'pin-needed' && W3.card.balance() === 1000 && W3.card.state.owner !== null, 'with no PIN given, the card lets nothing go and is not reset' + V, noPin);
    booksGood('everything spent' + V, H, W3.H);
    await settle();
  }

  /* ---- 4: this phone took the card back by its own key, and the card turned up --------------------------------------------- */
  {
    const { H, card } = await world(2000);
    const undo = later(H, MONTH);
    const back = await H.W.cardTakeBack(card.key);
    undo();
    ok(back.sats === 2000 && card.balance() === 2000, 'a month on the phone takes the card’s 2,000 back by its own key; the card, found again, still lists it', String(back.sats));
    const { check } = await asked(H, card);
    ok(check.spent === 2000 && check.left === 0, 'the mint says all of it is spent', JSON.stringify(check));
    card.tap();
    const done = await H.W.cardEmptyAndReset(card, { pin: '1234' });
    ok(done.reset === true && done.withdrew === 0 && card.state.owner === null, 'and RESET clears it and resets the card', JSON.stringify(done));
    booksGood('taken back, then found', H);
    await settle();
  }

  /* ---- 5: the card's screen ------------------------------------------------------------------------------------------------ */
  {
    const { H, R, card } = await world(2000);
    const holder = appOn(H);
    await holder.refreshBalance();
    const twin = card.copy();
    twin.tap();
    await R.W.cardPay(twin, { sats: 300, pin: '1234' });
    await settle();
    const gone = 2000 - twin.balance();
    H.nfc = card;
    holder.goFlashcard();
    await until('the card to be read and the mint to answer', () => !!holder.state.fc && holder.state.fc.key === card.key && holder.state.fc.check && holder.state.fc.check.spent > 0);
    await settle();
    const v = vals(holder);
    ok(holder.state.fc.balance === 2000 - gone && v.fcBalance === '₿ ' + holder.group(2000 - gone),
       'the balance is what the card can spend once the mint has answered, not what it lists', v.fcBalance);
    const top = holder.fcHistNotes(holder.state.fc)[0];
    ok(top.name === 'The mint says ' + holder.fcSats(gone, 'sat') + ' is already spent' && top.tileBg === 'var(--bad)' && holder.fcVerifiedWords(holder.state.fc)[0] === 'Not Verified' && v.fcMenuRingInk === '#FF5C5C',
       'and the spent figure is said in red at the top of the card’s HISTORY, with the menu turning red', top.name);
    ok(vals(holder).fcMenuItems.some((k) => k.label === 'RESET'), 'RESET is offered');

    // all of it spent: the balance says nothing is there, and RESET asks for the PIN, which letting the spent pieces go needs
    const twin2 = card.copy();
    twin2.tap();
    await H.W.cardWithdraw(twin2, { pin: '1234' });
    holder.setState({ screen: 'home', stack: [], fc: null });
    H.nfc = card;
    holder.goFlashcard();
    await until('the card to be read again', () => !!holder.state.fc && holder.state.fc.check && holder.state.fc.check.spent === 2000);
    await settle();
    ok(holder.state.fc.balance === 0 && vals(holder).fcBalance === '₿ 0' && holder.state.fc.spentOn === true, 'everything spent: the balance reads nothing', vals(holder).fcBalance);
    holder.fcWithdraw();
    ok(holder.toasts.slice(-1)[0] === 'The mint says everything on this card is spent. RESET clears it.', 'WITHDRAW says there is nothing to take, and what clears it', holder.toasts.slice(-1)[0]);
    holder.fcReset();
    ok(cardOf(holder) && cardOf(holder).title === 'RESET CARD' && /already spent is cleared off it too/.test(cardOf(holder).reason), 'RESET’s warning says the spent pieces are cleared off', cardOf(holder) && cardOf(holder).reason);
    cardOf(holder).press('CONTINUE');
    ok(pad(holder) && pad(holder).title === 'CARD PIN' && /what the mint says is spent/.test(pad(holder).sub), 'and the PIN is asked for, though the balance is nothing', pad(holder) && pad(holder).sub);
    pad(holder).type('1234');
    await until('the card to be reset', () => !card.state.owner);
    await settle();
    ok(holder.state.screen === 'home' && holder.toasts.slice(-1)[0] === 'The card is reset.', 'one tap, and the card is reset', holder.toasts.slice(-1)[0]);
  }

  /* ---- 5, more: the card's own log, and RESET's warning while the mint is asked ---------------------------------------------- */
  {
    const { H, R, card } = await world(2000);
    const twin = card.copy();
    twin.tap();
    await R.W.cardPay(twin, { sats: 300, pin: '1234' });
    await settle();
    await asked(H, card);
    card.tap();
    await H.W.cardWithdraw(card, { pin: '1234' });
    const holder = appOn(H);
    await holder.refreshBalance();
    H.nfc = card;
    holder.goFlashcard();
    await until('the card to be read', () => !!holder.state.fc && holder.state.fc.key === card.key && holder.state.fc.check !== 'asking');
    await settle();
    const kept = (holder.state.fc.receipts && holder.state.fc.receipts.list) || [];
    const letGo = H.W.cardSpentLetGo(card.key);
    ok(letGo.length === 1 && kept.some((r) => r.hash === letGo[0]), 'the card wrote its letting go of the spent pieces as a payment, and this phone knows which receipt it is', JSON.stringify({ letGo: letGo.length, receipts: kept.length }));
    holder.fcLogCard();
    ok(cardOf(holder) && /One of them went into no swap: it is spent pieces let go, which the mint had already spent\./.test(cardOf(holder).reason),
       'the card’s own log says that payment was spent pieces let go, and that no money moved', cardOf(holder) && cardOf(holder).reason.slice(-260));
    cardOf(holder).press('CLOSE');
    // RESET while the mint is still being asked: no figure, which may count pieces it has spent
    const { H: H2, card: c2 } = await world(1000);
    const h2 = appOn(H2);
    await h2.refreshBalance();
    H2.nfc = c2;
    h2.goFlashcard();
    await until('the card to be read', () => !!h2.state.fc && h2.state.fc.key === c2.key);
    await settle();
    h2.setState({ fc: Object.assign({}, h2.state.fc, { check: 'asking' }) });
    h2.fcReset();
    ok(cardOf(h2) && /What the mint says is unspent on it comes off to this phone first\./.test(cardOf(h2).reason) && !/₿/.test(cardOf(h2).reason),
       'RESET’s warning while the mint is still being asked says what comes off in words, with no figure', cardOf(h2) && cardOf(h2).reason);
    cardOf(h2).press('CANCEL');
    booksGood('the card’s own log', H, R);
  }

  /* ---- 6: a top-up at another mint, cut short, and the card paid with part of it ----------------------------------------------- */
  {
    // the holder's phone set the card up at A, and is on B from then on; a till at A
    const H = page({ second: true });
    await H.W.connect(MINT, null, null, { remember: true });
    await H.W.claim((await H.W.invoice(5000, '')).hash);
    await H.W.primeLocks();
    const card = newCard(H, undefined, { format: 4, software: 21 });
    await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
    card.tap();
    await H.W.cardPrepare(await H.W.cardLook(card), 1000);
    card.tap();
    card.leaveBefore('30', 2);
    const cut = await why(H.W.cardWrite(card, { pin: '1234' }));
    const went = card.balance();
    await H.W.connect(MINT2, null, null, { remember: true });
    await H.W.primeLocks();
    const T = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
    card.tap();
    await T.W.cardPay(card, { sats: went, pin: '1234' });
    await settle();
    ok(cut === 'gone' && went > 0 && went < 1000 && card.balance() === 0 && owed(H).length === 1 && owed(H)[0].tried > 0,
       'a top-up at A cut short, the phone now on B, and the card has paid a till at A with what went on', JSON.stringify({ cut, went, owed: owed(H).length }));
    card.tap();
    await H.W.cardWrite(card, { pin: '1234' });
    ok(card.balance() === 1000 - went && owed(H).length === 0,
       'the next write, from B, asks A (the top-up’s own mint) and puts on only what A has not spent: asked of B, the spent pieces went on again',
       JSON.stringify({ holds: card.balance(), want: 1000 - went, owed: owed(H).length }));
    booksGood('a top-up at another mint cut short', H, T);
  }

  /* ---- 7: taken away while letting the spent pieces go, after the money came off --------------------------------------------- */
  {
    const { H, R, card } = await world(2000);
    const twin = card.copy();
    twin.tap();
    await R.W.cardPay(twin, { sats: 300, pin: '1234' });
    await settle();
    const gone = 2000 - twin.balance();
    await asked(H, card);
    card.tap();
    // the money's signature is the first SIGN; the card leaves as the second, the letting go, is sent
    card.leaveBefore('24', 2);
    const before = await bal(H);
    const e = await H.W.cardWithdraw(card, { pin: '1234' }).then(() => null, (x) => x);
    ok(e && e.card === 'partial' && e.amount === 2000 - gone && e.left === 0 && e.spentLeft === gone && (await bal(H)) - before === 2000 - gone
       && /is still on the card: WITHDRAW ALL or RESET clears it\./.test(e.message) && !/tap it again for the rest/.test(e.message),
       'all the money is in the phone; the words say the spent part is still on the card, and nothing of the money is left', e && JSON.stringify({ card: e.card, amount: e.amount, left: e.left, spentLeft: e.spentLeft, message: e.message }));
    card.tap();
    const done = await H.W.cardEmptyAndReset(card, { pin: '1234' });
    ok(done.reset === true && done.withdrew === 0, 'and the next RESET lets it go and resets the card', JSON.stringify(done));
    booksGood('taken away while letting go', H, R);
  }

  /* ---- 8: a signature had back from a tap cut short, in a tap that finds only spent pieces ------------------------------------- */
  {
    const { H, R, card } = await world(2000);
    const twin = card.copy();
    twin.tap();
    await R.W.cardPay(twin, { sats: 300, pin: '1234' });
    await settle();
    const gone = 2000 - twin.balance();
    await asked(H, card);
    card.tap();
    // the card signs for the money and its answer is lost: the money's pieces are gone from it, and only the spent ones are left
    card.loseAnswerOf('24', 1);
    const before = await bal(H);
    const lost = await why(H.W.cardWithdraw(card, { pin: '1234' }));
    card.tap();
    const r = await H.W.cardWithdraw(card, { pin: '1234' });
    await settle();
    ok(lost === 'interrupted' && r.amount === 2000 - gone && (await bal(H)) - before === 2000 - gone && r.spentOff === gone && card.balance() === 0,
       'the next tap finds only spent pieces, lets them go, and swaps in the money whose signature it had back', JSON.stringify({ lost, amount: r.amount, spentOff: r.spentOff, got: (await bal(H)) - before }));
    booksGood('a signature had back with only spent pieces left', H, R);
  }

  /* ---- 9: a mint that does not say it answers NUT-07 ---------------------------------------------------------------------- */
  {
    const H = await funded({ mintOpts: { nut07: false } }, 9000);
    const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
    const card = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
    card.tap();
    await H.W.cardAdd(card, { sats: 1000, pin: '1234' });
    card.tap();
    H.trace.length = 0;
    const r = await H.W.cardWithdraw(card, { pin: '1234' });
    ok(r.amount === 1000 && card.balance() === 0 && !H.trace.some((x) => /checkstate/.test(x)) && !r.spentOff,
       'not asked which pieces are spent: the card’s own figure is taken off, as before', JSON.stringify({ amount: r.amount, asked: H.trace.filter((x) => /checkstate/.test(x)).length }));
    booksGood('a mint without NUT-07', H, R);
  }

  console.log(failed ? failed + ' failed' : 'all card-spent-on-card checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
