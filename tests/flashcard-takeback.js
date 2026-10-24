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
const { appOn, until, restore } = require('./flashcard-ui-kit');

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

  /* ---- taken back after a launch -----------------------------------------
   * The card's row on file is the one record of what it held and when it can be taken back: kept across a launch, and the
   * phone launched again takes the card back on its date as TAKE IT BACK does, once and no more. */
  {
    const c5 = newCard(H);
    await H.W.cardSetUp(c5, { pin: '1234', recoverable: true });
    c5.tap();
    await H.W.cardAdd(c5, { sats: 1024, pin: '1234' });
    const b0 = await bal(H);
    const row5 = H.W.cardsList().filter((c) => c.key === c5.key)[0];
    ok(row5 && row5.amount === 1024 && row5.due === false && row5.first > 0 && !row5.takenBack,
       'before its date the card’s row says what it held and is not due', JSON.stringify(row5));

    // the phone launched again: the card's row is still there
    const kept = {};
    for (let i = 0; i < H.storage.length; i++) kept[H.storage.key(i)] = H.storage.getItem(H.storage.key(i));
    const H2 = page({ storage: kept, phone: H.phone, sharedMint: H.mint });
    // (the phone's seed was derived once, with the first page's libraries: it derives with those still, as one phone would)
    H.phone.derive = H.window.CashuTS.deriveSecretAndBlindingFactor;
    const again = H2.W.cardsList().filter((c) => c.key === c5.key)[0];
    ok(again && again.amount === 1024 && again.date === row5.date && again.first === row5.first,
       'launched again, the phone still has the card’s row as it was', JSON.stringify(again));
    // a month on (the test mint reads the first page's clock): connected, the card is taken back
    const undoA = later(H, MONTH), undoB = later(H2, MONTH);
    await H2.W.connect(MINT, null, null, { remember: true });
    const got = await H2.W.cardTakeBack(c5.key);
    const entry5 = history(H2).filter((e) => e.hash === got.hash)[0] || {};
    ok(got.amount === 1024 && got.unit === 'sat' && (await H2.W.balanceSats()) === b0 + 1024,
       'its date come, the phone launched again takes it back', JSON.stringify(got));
    ok(entry5.dir === 'in' && entry5.sats === 1024 && entry5.lost === true && entry5.card === c5.key,
       'its entry is the ordinary take-back of a lost card', JSON.stringify([entry5.dir, entry5.sats, entry5.lost]));
    ok(H2.W.cardsList().filter((c) => c.key === c5.key)[0].takenBack > 0, 'and the card’s row says it was taken back');
    ok((await H2.W.cardTakeBack(c5.key)).amount === 0 && (await H2.W.balanceSats()) === b0 + 1024, 'and it is never taken twice');
    undoA(); undoB();
  }

  /* ---- RESTORE CARD asks the mint what is still there -------------------------
   * Opened with a route, RESTORE CARD asks the mint, one request a card at this mint and by the take-back's own check
   * (21a-flashcard.js `cardsStillAtMint`), which of the pieces this phone knew are still unspent: the row then says what the
   * take-back will bring, "at the mint", and nothing is spent or swapped by the asking. A card at another mint is not asked;
   * an answer that does not come leaves the row as it was; the next opening's "when last seen" is already the smaller figure. */
  {
    const asked = (c, p) => c.circuits.filter((x) => x.path === p).length;
    const CARDS = 'foxy.flashcard.cards';
    const c6 = newCard(H);
    await H.W.cardSetUp(c6, { pin: '1234', recoverable: true });
    c6.tap();
    await H.W.cardAdd(c6, { sats: 2000, pin: '1234' });
    // paid with at another phone, which this phone never sees: 1,024 of what it knew is spent at the mint, and the 24 of change unknown here
    c6.tap();
    const p6 = await R.W.cardPay(c6, { sats: 1000, pin: '1234' });
    c6.tap();
    await R.W.cardWrite(c6, { pin: '1234' });
    ok(p6.sats === 1000 && c6.balance() === 1000 && H.W.cardsList().filter((c) => c.key === c6.key)[0].amount === 2000,
       'a card holding 2,000 pays 1,000 at another phone; this phone still has 2,000 on file');

    // a card whose money is at another mint: on file here, never asked about
    const far = '02' + 'ab'.repeat(32);
    const filed = JSON.parse(H.storage.getItem(CARDS));
    filed[far] = Object.assign({}, filed[c6.key], { mint: 'https://n.test', at: 1, seen: 1 });
    H.storage.setItem(CARDS, JSON.stringify(filed));
    ok(H.W.cardsList().filter((c) => c.key === far)[0].amount === 2000, 'and a card at another mint is on file with 2,000');

    const undo6 = later(H, MONTH);
    const a = appOn(H, { screen: 'home', stack: [] });
    a.price = 60000;
    const name6 = a.fcName(c6.key).toUpperCase(), farName = a.fcName(far).toUpperCase(), name5 = a.fcName(H.W.cardsList().filter((c) => c.amount > 0 && c.key !== c6.key && c.key !== far)[0].key).toUpperCase();
    const sub = (n) => (restore(a) && restore(a).row(n) ? restore(a).row(n).sub : '');
    const atThisMint = H.W.cardsList().filter((c) => !c.takenBack && c.amount > 0 && c.key !== far).length;
    const checks0 = asked(H, '/v1/checkstate'), swaps0 = asked(H, '/v1/swap'), bal0 = await bal(H);
    a.fcRestoreLost();
    ok(sub(name6) === '$ 1.20 when last seen' && restore(a).row(name6).ready && sub(farName) === '$ 1.20 when last seen',
       'opened, a ready card’s row says what this phone last knew on it, as before', sub(name6));
    await until('the mint’s word on the card', () => sub(name6) !== '$ 1.20 when last seen');
    await until('every card at this mint to be asked about', () => asked(H, '/v1/checkstate') - checks0 === atThisMint);
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
    ok(sub(name6) === '$ 0.59 at the mint' && restore(a).row(name6).ready && restore(a).row(name6).top === 'Ready',
       'the mint answers: the row says the 976 still at the mint, dollars first, and is still ready', sub(name6));
    ok(asked(H, '/v1/checkstate') - checks0 === atThisMint && atThisMint >= 2,
       'one request for each card at this mint with pieces on file, and none more', (asked(H, '/v1/checkstate') - checks0) + ' of ' + atThisMint);
    ok(sub(farName) === '$ 1.20 when last seen', 'a card at another mint is not asked, and its row is as it was', sub(farName));
    ok(sub(name5) === 'Empty at the mint' && restore(a).row(name5).top === 'Nothing' && !restore(a).row(name5).ready,
       'a card whose pieces were all taken back elsewhere: Empty at the mint, Nothing / To Restore, no press', sub(name5));
    ok(asked(H, '/v1/swap') === swaps0 && (await bal(H)) === bal0 && !H.W.cardsList().filter((c) => c.key === c6.key)[0].takenBack,
       'nothing is swapped, spent or taken back by the asking');
    ok(H.W.cardsList().filter((c) => c.key === c6.key)[0].amount === 976, 'and the card’s row on file now says the 976 the mint holds',
       String(H.W.cardsList().filter((c) => c.key === c6.key)[0].amount));
    ok((await H.W.cardsStillAtMint(far)) === null && asked(H, '/v1/checkstate') - checks0 === atThisMint,
       'asked by itself, the card at another mint answers nothing and sends nothing');

    // the next opening, and the mint does not answer: the stored answer has trimmed the figure, and the row stays as it is
    H.deaf = true;
    const checks1 = asked(H, '/v1/checkstate');
    // (the card taken back elsewhere has nothing left to ask about now: its pieces are on file as spent)
    const left1 = H.W.cardsList().filter((c) => !c.takenBack && c.amount > 0 && c.key !== far).length;
    a.fcRestoreLost();
    ok(sub(name6) === '$ 0.59 when last seen', 'opened again, the row says the smaller figure at once, as when last seen', sub(name6));
    await until('the asking to fail', () => asked(H, '/v1/checkstate') - checks1 === left1);
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
    ok(left1 === 1 && sub(name6) === '$ 0.59 when last seen' && restore(a).row(name6).ready && sub(name5) === 'Empty when last seen',
       'with no answer from the mint the rows are left as they were', sub(name6) + ' / ' + sub(name5));
    ok((await H.W.cardsStillAtMint(c6.key)) === null, 'and the look answers nothing, never an error');
    H.deaf = false;

    // offline (the phone's own OFFLINE): nothing is asked, and the rows read as they do
    a.offline = true;
    const checks2 = asked(H, '/v1/checkstate');
    a.fcRestoreLost();
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
    ok(asked(H, '/v1/checkstate') === checks2 && sub(name6) === '$ 0.59 when last seen', 'offline, the mint is not asked and the row reads as when last seen', sub(name6));
    a.offline = false;

    // a third opening, answered, and the ready row pressed: what the row said is what comes back
    a.fcRestoreLost();
    await until('the mint’s word again', () => sub(name6) === '$ 0.59 at the mint');
    const swaps1 = asked(H, '/v1/swap');
    restore(a).press(name6);
    await until('the money to be back', () => a.state.screen === 'paid');
    ok(a.state.paidAmount === 976 && (await bal(H)) === bal0 + 976 && asked(H, '/v1/swap') > swaps1,
       'pressed, the 976 the row said comes back', String(a.state.paidAmount));
    undo6();
    // (the card at another mint goes, so that nothing after this reads it)
    const tidy = JSON.parse(H.storage.getItem(CARDS));
    delete tidy[far];
    H.storage.setItem(CARDS, JSON.stringify(tidy));
  }

  // (a wait that ran out is a failure too: `until` says so)
  failed += until.failed;
  console.log('\n' + (failed ? failed + ' flashcard-takeback check(s) failed' : 'all flashcard-takeback checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
