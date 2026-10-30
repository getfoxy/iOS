'use strict';
/* flashcard-transfer.js — TRANSFER: a whole card moved to another mint in one tap, and the screens that do it.
 *
 *     node tests/flashcard-transfer.js
 *
 * The card's MENU has TRANSFER, above RESET. It opens the mint list (TO WHICH MINT?), then the confirmation with the three fees
 * (the card's mint's, the Lightning route's, the new mint's) and what arrives on the card, then one tap: the money comes off the
 * card, crosses by Lightning, the empty card is told its new mint with the owner's proof, and the new pieces are written, all in
 * that tap. It ends on the orange success screen, CARD MOVED, NOW AT the new mint, DONE.
 *
 * What is held to here:
 *   - the quote is asked before the card is touched and says the three fees; the money pays its own way, and the phone's own
 *     balance at either mint is not dipped into;
 *   - one tap moves it: the card names its new mint and holds what was quoted to land, nothing is left owed, nothing noted;
 *   - a tap that drops after the pieces were made at the new mint leaves them owed to the card, and its next tap there writes
 *     them, the record first;
 *   - a crossing that does not go (the fee risen past what was agreed) leaves the money in this phone at the old mint and the
 *     TRANSFER noted, and finishing it from the note moves it in one tap with nothing taken off the card;
 *   - a dollar card moves as dollars to a mint that issues dollars, and to one that does not as bitcoin, its record's unit
 *     changed at the write; the confirmation says so;
 *   - the screens: TRANSFER above RESET, the one tap, CARD MOVED, and a dollar card no longer refused;
 *   - the books add up at both mints (the harness asks, as it asks every suite).
 *
 * Two test mints, with a Lightning payment between them that is paid when it is made: a reserve of 10, of which 2 are spent.
 */
const { funded, newCard, why, MINT, MINT2 } = require('./flashcard-kit');
const { appOn, until, pad, card: face, vals, settle } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const at = (c, mint, unit) => {
  try { return (JSON.parse(c.storage.getItem('foxy.cashu.proofs.' + mint + (unit && unit !== 'sat' ? '.' + unit : ''))) || []).reduce((n, p) => n + Number(p.amount || 0), 0); }
  catch (e) { return 0; }
};

(async () => {
  /* ---- a bitcoin card, one tap ------------------------------------------------------------------------------------------ */
  {
    const H = await funded({ second: true }, 6000);
    const W = H.W;
    const card = newCard(H);
    await W.cardSetUp(card, { pin: '1234' });
    card.tap();
    await W.cardAdd(card, { sats: 2000, pin: '1234' });
    card.tap();
    const read = await W.cardLook(card, { mine: true });
    const q = await W.cardTransferQuote(read, MINT2);
    ok(q.unit === 'sat' && q.toUnit === 'sat' && !q.converts && q.have === 2000 && q.lands > 1950 && q.lands < 2000 && q.cost <= 2000
       && q.fees.lightning === 10 && q.fees.from >= 0 && q.fees.to >= 0,
       'asked before the card is touched: what lands, and the three fees (the Lightning reserve is 10)', JSON.stringify(q));
    ok(card.balance() === 2000, 'and nothing was taken off the card by asking');
    const mine = at(H, MINT);
    card.tap();
    const r = await W.cardTransfer(card, { pin: '1234', to: MINT2, most: q.fee });
    await r.visit.end();
    ok(card.state.record.mint === MINT2 && card.balance() === q.lands && r.lands === q.lands && r.left === 0,
       'one tap: the card names its new mint and holds what was quoted to land', JSON.stringify([card.state.record.mint, card.balance(), q.lands]));
    ok(!W.cardOwed().length && !Object.keys(W.cardTransfers()).length, 'nothing is left owed to it, and no TRANSFER is noted');
    ok(at(H, MINT) >= mine && at(H, MINT) <= mine + 10 && at(H, MINT2) === 0,
       'the phone’s own money was not dipped into: at the old mint it holds what it held and the reserve’s unused part, at the new nothing',
       JSON.stringify([mine, at(H, MINT), at(H, MINT2)]));
    const check = await (async () => { await W.connect(MINT2, null, null, { remember: false }); card.tap(); return W.cardCheck(await W.cardLook(card)); })();
    ok(check.spent === 0 && check.sats === q.lands, 'and the new mint says every piece on it is good');
    await W.connect(MINT, null, null, { remember: true });
  }

  /* ---- the tap drops after the pieces were made: the next tap at the new mint finishes it -------------------------------- */
  {
    const H = await funded({ second: true }, 6000);
    const W = H.W;
    const card = newCard(H);
    await W.cardSetUp(card, { pin: '1234' });
    card.tap();
    await W.cardAdd(card, { sats: 1500, pin: '1234' });
    card.tap();
    const q = await W.cardTransferQuote(await W.cardLook(card, { mine: true }), MINT2);
    card.tap();
    // the card leaves just before it would have been told its new mint
    card.leaveBefore('32', 1);
    const e = await W.cardTransfer(card, { pin: '1234', to: MINT2, most: q.fee }).then(() => null, (x) => x);
    const owed = W.cardOwed();
    ok(e && e.card === 'gone' && e.stage === 'owed' && card.balance() === 0 && card.state.record.mint === MINT && owed.length === 1 && owed[0].mint === MINT2,
       'cut off after the pieces were made at the new mint: the card empty at its old one, the pieces owed to it at the new', JSON.stringify([e && e.card, e && e.stage, owed.length]));
    ok(!Object.keys(W.cardTransfers()).length, 'from there the owed pieces carry it, and no TRANSFER note is left');
    // its next tap, with the phone at the new mint (the visit still open)
    card.tap();
    const w = await W.cardWrite(card, { owner: true });
    if (e && e.visit) await e.visit.end();
    ok(w.left === 0 && card.state.record.mint === MINT2 && card.balance() === q.lands && !W.cardOwed().length,
       'its next tap tells it its new mint, then writes them', JSON.stringify([card.state.record.mint, card.balance()]));
  }

  /* ---- the crossing does not go: the money waits in this phone, and the note finishes it --------------------------------- */
  {
    const H = await funded({ second: true }, 6000);
    const W = H.W;
    const card = newCard(H);
    await W.cardSetUp(card, { pin: '1234' });
    card.tap();
    await W.cardAdd(card, { sats: 1200, pin: '1234' });
    const mine = at(H, MINT);
    card.tap();
    // agreed to fees of nothing: the crossing's fee is over that, and it stops with the money off the card
    const e = await W.cardTransfer(card, { pin: '1234', to: MINT2, most: 0 }).then(() => null, (x) => x);
    const note = W.cardTransfers()[card.key];
    ok(e && e.card === 'fee-up' && e.stage === 'off' && card.balance() === 0 && at(H, MINT) === mine + 1200 && note && note.stage === 'off' && note.amount === 1200,
       'a fee over what was agreed stops it: the money in this phone at the old mint, and the TRANSFER noted', JSON.stringify([e && e.card, e && e.stage, note]));
    card.tap();
    const r = await W.cardTransfer(card, { pin: '1234', to: MINT2, resume: true });
    await r.visit.end();
    ok(card.state.record.mint === MINT2 && card.balance() > 1150 && !Object.keys(W.cardTransfers()).length && at(H, MINT) <= mine + 10,
       'finished from the note in one tap: nothing taken off the card, the money moved and written', JSON.stringify([card.balance(), at(H, MINT) - mine]));
  }

  /* ---- a dollar card: as dollars where the new mint has them, as bitcoin where it has none -------------------------------- */
  for (const units2 of [['sat', 'usd'], ['sat']]) {
    const H = await funded({ second: true, units: ['sat', 'usd'], units2 }, 6000);
    const W = H.W;
    await W.claim((await W.invoice(3000, '', { unit: 'usd' })).hash);
    const card = newCard(H);
    await W.cardSetUp(card, { pin: '1234', unit: 'usd' });
    card.tap();
    await W.cardAdd(card, { amount: 2000, unit: 'usd', pin: '1234' });
    card.tap();
    const q = await W.cardTransferQuote(await W.cardLook(card, { mine: true }), MINT2);
    const dollars = units2.includes('usd');
    ok(q.unit === 'usd' && q.toUnit === (dollars ? 'usd' : 'sat') && q.converts === !dollars && q.lands > 0,
       dollars ? 'a dollar card going to a mint with dollars lands in dollars' : 'a dollar card going to a mint with none lands in bitcoin, and the quote says it converts',
       JSON.stringify(q));
    card.tap();
    const r = await W.cardTransfer(card, { pin: '1234', to: MINT2, most: q.fee, toUnit: q.toUnit });
    await r.visit.end();
    ok(card.state.record.mint === MINT2 && card.state.record.unit === (dollars ? 1 : 0) && card.balance() === r.lands && r.lands > 0 && r.toUnit === q.toUnit,
       dollars ? 'moved, its record still dollars' : 'moved, its record bitcoin now, the money on it in sats', JSON.stringify([card.state.record.unit, card.balance(), r.toUnit]));
    ok((W.cardsKnown()[card.key] || {}).unit === q.toUnit, 'and the row this phone keeps for it says the unit it holds now', (W.cardsKnown()[card.key] || {}).unit);
  }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
