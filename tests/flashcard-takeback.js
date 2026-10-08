'use strict';
/* flashcard-takeback.js — a lost card's money, taken back with no card.
 *
 *     node tests/flashcard-takeback.js
 *
 * A recoverable card's pieces name a key of the phone that loaded it, which
 * may spend them once their date has passed. This is that road: not before
 * the date, only by the phone that set the card up, only what that phone
 * knew to be on the card, and never twice. The date is passed here by moving
 * the page's clock, which the test mint reads too.
 */
const { funded, newCard, binaryLoad, why, history, MINT, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const YEAR = 366 * 24 * 3600 * 1000;
function later(c, ms) {
  const real = c.window.Date.now.bind(c.window.Date);
  c.window.Date.now = () => real() + ms;
  return () => { c.window.Date.now = real; };
}

(async () => {
  const H = await funded({}, 6000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H);
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  // cut the old way, in large pieces, so that 1,000 is paid with change
  await binaryLoad(H, card, 2000);
  card.tap();
  const paid = await R.W.cardPay(card, { sats: 1000, pin: '1234' });
  ok(paid.sats === 1000 && paid.change && paid.change.sats === 24 && paid.change.written === false && card.balance() === 976,
     'a card holding 2,000 pays 1,000 and is let go; its 24 of change waits for the next tap', JSON.stringify(paid.change));
  card.tap();
  await R.W.cardWrite(card, { pin: '1234' });
  ok(card.balance() === 1000, 'which writes it back, without the holder’s phone being there', String(card.balance()));

  const list = H.W.cardsList();
  ok(list.length === 1 && list[0].key === card.key && list[0].sats === 2000 && list[0].due === false && list[0].date > Date.now() / 1000,
     'the phone that loaded it lists the card, what it last knew on it, and its date', JSON.stringify(list.map((c) => [c.sats, c.due])));

  /* ---- not before its date, and not by anyone else ------------------------- */
  const soon = await H.W.cardTakeBack(card.key).then(() => null, (e) => e);
  ok(soon && soon.card === 'too-soon' && soon.sats === 2000 && soon.date === list[0].date, 'before its date nothing can be taken back, and the date is said', soon && soon.message);
  ok((await why(R.W.cardTakeBack(card.key))) === 'unknown', 'a phone that did not set the card up cannot take it back at all');
  const cash = newCard(H);
  await H.W.cardSetUp(cash, { pin: '0000' });
  ok((await why(H.W.cardTakeBack(cash.key))) === 'unknown', 'nor can anyone take back a card set up as cash');

  /* ---- a year on: the card is lost ---------------------------------------- */
  const undo = later(H, YEAR);
  const hBefore = await bal(H);
  ok(H.W.cardsList()[0].due === true, 'a year on, the list says the card can be taken back');
  const back = await H.W.cardTakeBack(card.key);
  ok(back.sats === 976 && (await bal(H)) === hBefore + 976, 'what the phone loaded and the card had not spent comes back: 976 of the 2,000', String(back.sats));
  const entry = history(H).filter((e) => e.hash === back.hash)[0] || {};
  ok(entry.dir === 'in' && entry.sats === 976 && entry.memo === 'from card', 'with one entry, from the card');
  ok(H.W.cardTaken().length === 0, 'and nothing left waiting');
  const again = await H.W.cardTakeBack(card.key);
  ok(again.sats === 0 && (await bal(H)) === hBefore + 976, 'taken back a second time, there is nothing more', String(again.sats));

  /* ---- the card turns up again -------------------------------------------- */
  undo();
  card.tap();
  const rBefore = await bal(R);
  const stale = await R.W.cardPay(card, { sats: 500, pin: '1234' }).then(() => null, (e) => e);
  ok(stale && stale.card === 'spent' && (await bal(R)) === rBefore, 'found again, the card cannot spend what was taken back: the mint says it is spent', stale && stale.message);

  /* ---- a phone that has read the card since knows its change too ---------- */
  {
    const c2 = newCard(H);
    await H.W.cardSetUp(c2, { pin: '1234', recoverable: true });
    await binaryLoad(H, c2, 1024);
    c2.tap();
    const p2 = await R.W.cardPay(c2, { sats: 200, pin: '1234' });
    c2.tap();
    await R.W.cardWrite(c2, { pin: '1234' });
    ok(p2.change && p2.change.sats === 824 && c2.balance() === 824, 'another card pays 200 from one piece and holds 824 of change');
    c2.tap();
    await H.W.cardLook(c2);          // the holder checks its balance: the change is now known to the phone
    const undo2 = later(H, YEAR);
    const h0 = await bal(H);
    const b2 = await H.W.cardTakeBack(c2.key);
    undo2();
    ok(b2.sats === 824 && (await bal(H)) === h0 + 824, 'read by its holder’s phone after it was paid with, a card is taken back change and all', String(b2.sats));
  }

  /* ---- the last week before a card's date ---------------------------------
   * A stranger's phone stops taking a piece a week before its date. The phone
   * that loaded the card is not a stranger to it, and must still be able to
   * empty it and to give its money a new date. */
  {
    const DAY = 24 * 3600 * 1000;
    const c3 = newCard(H);
    await H.W.cardSetUp(c3, { pin: '1234', recoverable: true });
    c3.tap();
    await H.W.cardAdd(c3, { sats: 1024, pin: '1234' });
    const date0 = H.W.cardsList().filter((c) => c.key === c3.key)[0].date;
    const undoH = later(H, 362 * DAY), undoR = later(R, 362 * DAY);
    c3.tap();
    const looked = await H.W.cardLook(c3);
    ok(H.W.cardIsMine(looked) === true && R.W.cardIsMine(looked) === false, 'a card knows no owner, and each phone knows whether it is its own');
    c3.tap();
    ok((await why(R.W.cardPay(c3, { sats: 100, pin: '1234' }))) === 'renew' && c3.balance() === 1024,
       'three days before its date another phone will not be paid by it, and nothing is signed');
    c3.tap();
    const renewed = await H.W.cardRenew(c3, { pin: '1234' });
    const date1 = H.W.cardsList().filter((c) => c.key === c3.key)[0].date;
    ok(renewed.sats === 1024 && renewed.left === 0 && c3.balance() === 1024 && date1 > date0 + 300 * 24 * 3600,
       'its own phone renews it in one tap: the same 1,024 on the card, dated a year on', renewed.sats + ' ' + (date1 - date0));
    c3.tap();
    const p3 = await R.W.cardPay(c3, { sats: 100, pin: '1234' });
    ok(p3.sats === 100, 'and renewed, it pays');
    c3.tap();
    const h1 = await bal(H);
    const out = await H.W.cardWithdraw(c3, { pin: '1234' });
    ok(out.sats === 924 && (await bal(H)) === h1 + 924 && c3.balance() === 0, 'its own phone empties what is left', String(out.sats));
    ok(H.W.cardsList().filter((c) => c.key === c3.key)[0].sats === 0, 'and its list no longer says the card holds what it has spent',
       String(H.W.cardsList().filter((c) => c.key === c3.key)[0].sats));
    undoH(); undoR();

    // past its date: the card's own key is no longer asked, and the phone says which road is open
    const c4 = newCard(H);
    await H.W.cardSetUp(c4, { pin: '1234', recoverable: true });
    c4.tap();
    await H.W.cardAdd(c4, { sats: 512, pin: '1234' });
    const undo4 = later(H, YEAR);
    c4.tap();
    ok((await why(H.W.cardWithdraw(c4, { pin: '1234' }))) === 'past-date' && c4.balance() === 512,
       'past its date the card is not asked to sign: its phone is told to take it back instead');
    const b4 = await H.W.cardTakeBack(c4.key);
    undo4();
    ok(b4.sats === 512, 'which it does, with no card', String(b4.sats));
  }

  console.log('\n' + (failed ? failed + ' flashcard-takeback check(s) failed' : 'all flashcard-takeback checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
