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
const { page, funded, newCard, binaryLoad, why, history, MINT, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
// past a piece's date: a card's money is put on for thirty days
const MONTH = 31 * 24 * 3600 * 1000;
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
  // loaded as a card is, a drawer of 2,000: 1,000 is paid with its 512 and two 256s, and 24 of change
  card.tap();
  await H.W.cardAdd(card, { sats: 2000, pin: '1234' });
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
  await H.W.cardSetUp(cash, { pin: '0000', recoverable: false });
  ok((await why(H.W.cardTakeBack(cash.key))) === 'unknown', 'nor can anyone take back a card set up as cash');

  /* ---- a month on: the card is lost --------------------------------------- */
  const undo = later(H, MONTH);
  const hBefore = await bal(H);
  ok(H.W.cardsList()[0].due === true, 'a month on, the list says the card can be taken back');
  const back = await H.W.cardTakeBack(card.key);
  ok(back.sats === 976 && (await bal(H)) === hBefore + 976, 'what the phone loaded and the card had not spent comes back: 976 of the 2,000', String(back.sats));
  const entry = history(H).filter((e) => e.hash === back.hash)[0] || {};
  ok(entry.dir === 'in' && entry.sats === 976 && entry.memo === 'from card', 'with one entry, from the card');
  /* marked as a lost card's take-back (`lost`): that card cannot be read, so its own list cannot be opened, and home's history
   * keeps this row (26-render-history-and-contacts.js; the list itself is pinned in history-notes §6) */
  ok(entry.card === card.key && entry.lost === true, 'and the entry names the card and is marked the take-back of a lost card', JSON.stringify([entry.card === card.key, entry.lost]));
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
    const undo2 = later(H, MONTH);
    const h0 = await bal(H);
    const b2 = await H.W.cardTakeBack(c2.key);
    undo2();
    ok(b2.sats === 824 && (await bal(H)) === h0 + 824, 'read by its holder’s phone after it was paid with, a card is taken back change and all', String(b2.sats));
  }

  /* ---- the last day before a card's date ----------------------------------
   * A stranger's phone with a route stops taking a piece a day before its date
   * (a week, with none: tests/flashcard-offline.js). The phone
   * that loaded the card is not a stranger to it, and must still be able to
   * empty it and to give its money a new date. */
  {
    const DAY = 24 * 3600 * 1000;
    const c3 = newCard(H);
    await H.W.cardSetUp(c3, { pin: '1234', recoverable: true });
    c3.tap();
    await H.W.cardAdd(c3, { sats: 1024, pin: '1234' });
    const date0 = H.W.cardsList().filter((c) => c.key === c3.key)[0].date;
    const undoH = later(H, 29.5 * DAY), undoR = later(R, 29.5 * DAY);
    c3.tap();
    const looked = await H.W.cardLook(c3);
    ok(H.W.cardIsMine(looked) === true && R.W.cardIsMine(looked) === false, 'a card knows no owner, and each phone knows whether it is its own');
    c3.tap();
    ok((await why(R.W.cardPay(c3, { sats: 100, pin: '1234' }))) === 'renew' && c3.balance() === 1024,
       'half a day before its date another phone will not be paid by it, and nothing is signed');
    c3.tap();
    const renewed = await H.W.cardRenew(c3, { pin: '1234' });
    const date1 = H.W.cardsList().filter((c) => c.key === c3.key)[0].date;
    ok(renewed.sats === 1024 && renewed.left === 0 && c3.balance() === 1024 && date1 > date0 + 25 * 24 * 3600,
       'its own phone renews it in one tap: the same 1,024 on the card, dated thirty days on', renewed.sats + ' ' + (date1 - date0));
    c3.tap();
    const p3 = await R.W.cardPay(c3, { sats: 100, pin: '1234' });
    ok(p3.sats === 100, 'and renewed, it pays');
    // RECEIVE: the change goes back on at the next tap, with no PIN
    if (p3.change && p3.change.sats > 0 && !p3.change.written) {
      c3.tap();
      await R.W.cardWrite(c3, { change: true });
    }
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
    const undo4 = later(H, MONTH);
    c4.tap();
    ok((await why(H.W.cardWithdraw(c4, { pin: '1234' }))) === 'past-date' && c4.balance() === 512,
       'past its date the card is not asked to sign: its phone is told to take it back instead');
    const b4 = await H.W.cardTakeBack(c4.key);
    undo4();
    ok(b4.sats === 512, 'which it does, with no card', String(b4.sats));
  }

  /* ---- RESTORE before its date ---------------------------------------------
   * Asked before the card's date (26f-flashcard.js `fcRestoreAsk`, kept; RESTORE CARD does not offer it now): written down on the card's row and
   * nothing else, in no balance, forgotten by CANCEL RESTORE, kept across a launch, and taken back by itself once its date has
   * come, by the connection's sweep (`cardRestoreDue`), as TAKE IT BACK takes it. */
  {
    const c5 = newCard(H);
    await H.W.cardSetUp(c5, { pin: '1234', recoverable: true });
    c5.tap();
    await H.W.cardAdd(c5, { sats: 1024, pin: '1234' });
    const now = Math.floor(Date.now() / 1000);
    const b0 = await bal(H);
    const asked = H.W.cardRestoreAsk(c5.key);
    ok(!!asked && asked.key === c5.key && asked.amount === 1024 && asked.sats === 1024 && asked.unit === 'sat' && asked.date > now + 25 * 24 * 3600 && asked.asked >= now,
       'a restore asked before the card’s date is written down, with what the card held and the date it can be taken back', JSON.stringify(asked));
    ok((await bal(H)) === b0, 'and is in no balance', String((await bal(H)) - b0));
    const row5 = () => H.W.cardsList().filter((c) => c.key === c5.key)[0];
    ok(row5().restore > 0 && row5().due === false && H.W.cardRestores().length === 1, 'the card’s row says a restore is waiting', JSON.stringify(row5()));
    ok(H.W.cardRestoreAsk(cash.key) === null, 'a card set up as cash has nothing this phone can restore');
    ok((await H.W.cardRestoreDue()).length === 0 && H.W.cardRestores().length === 1 && (await bal(H)) === b0, 'before its date the sweep takes nothing');
    ok(H.W.cardRestoreCancel(c5.key) === true && H.W.cardRestores().length === 0 && row5().restore === 0 && row5().amount === 1024 && !row5().takenBack,
       'CANCEL RESTORE forgets it, and nothing else changes', JSON.stringify(row5()));
    H.W.cardRestoreAsk(c5.key);

    // the phone launched again: the restore is still there
    const kept = {};
    for (let i = 0; i < H.storage.length; i++) kept[H.storage.key(i)] = H.storage.getItem(H.storage.key(i));
    const H2 = page({ storage: kept, phone: H.phone, sharedMint: H.mint });
    // (the phone's seed was derived once, with the first page's libraries: it derives with those still, as one phone would)
    H.phone.derive = H.window.CashuTS.deriveSecretAndBlindingFactor;
    const again = H2.W.cardRestores();
    ok(again.length === 1 && again[0].key === c5.key && again[0].amount === 1024 && again[0].date === asked.date,
       'launched again, the phone still has the restore waiting', JSON.stringify(again));
    // a month on (the test mint reads the first page's clock): connected, the sweep takes it back by itself
    const told = [];
    H2.W.onCardRestored((info) => told.push(info));
    const undoA = later(H, MONTH), undoB = later(H2, MONTH);
    await H2.W.connect(MINT, null, null, { remember: true });
    for (let i = 0; i < 400 && !told.length; i++) await new Promise((r) => setTimeout(r, 10));
    const got = told[0] || {};
    const entry5 = history(H2).filter((e) => e.hash === got.hash)[0] || {};
    ok(got.key === c5.key && got.amount === 1024 && got.unit === 'sat' && (await H2.W.balanceSats()) === b0 + 1024,
       'its date come, the connection’s sweep takes it back by itself, and the page is told', JSON.stringify(got));
    ok(entry5.dir === 'in' && entry5.sats === 1024 && entry5.lost === true && entry5.card === c5.key,
       'its entry is the ordinary take-back of a lost card', JSON.stringify([entry5.dir, entry5.sats, entry5.lost]));
    ok(H2.W.cardRestores().length === 0 && H2.W.cardsList().filter((c) => c.key === c5.key)[0].takenBack > 0,
       'and the restore is over: the card is taken back');
    ok((await H2.W.cardRestoreDue()).length === 0 && (await H2.W.balanceSats()) === b0 + 1024, 'and is never taken twice');
    undoA(); undoB();
  }

  console.log('\n' + (failed ? failed + ' flashcard-takeback check(s) failed' : 'all flashcard-takeback checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
