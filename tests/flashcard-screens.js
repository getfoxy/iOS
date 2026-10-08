'use strict';
/* flashcard-screens.js — the FLASHCARD screens, driven as a person drives them.
 *
 *     node tests/flashcard-screens.js
 *
 * The screens are build/app/26f-flashcard.js over the PIN pad, the cards and
 * the stage screens (10-pin.js, 11-cards.js, 26e-loaders.js). Those four parts
 * are made into a class here and run against the real wallet, a test mint and
 * the model of the card (flashcard-kit.js): keys are pressed on the pad,
 * buttons on the cards, and a card is "tapped" by putting it where the phone's
 * NFC stand-in finds it. What is checked is what a person would see, and that
 * the money is where the screen says it is.
 *
 * The render snapshots pin how these look. This pins what they do. */
const { funded, newCard, binaryLoad, history, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const { appOn, until, pad, card, stage, vals, settle, keyIn } = require('./flashcard-ui-kit');

/* The daily limit's three steps, as a person takes them: the warning's CONTINUE, an amount on the keypad
 * (or NO LIMIT under it, for 0), and the confirmation's CONFIRM. */
const takeLimitSteps = (app, sats) => {
  card(app).press('CONTINUE');
  if (sats > 0) keyIn(app, sats); else app.fcLimitConfirm(0);
  app.fcLimitSpec().go();
};
const LIMIT_WARNING = 'A daily limit is the most this card will spend in one day. It starts again by itself each day.\n\n'
  + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.\n\n'
  + 'If you lose the seed phrase for this Foxy app, the PIN and the limit on this card can never be changed.\n\n'
  + 'Do you wish to continue?';

(async () => {
  const H = await funded({}, 6000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const holder = appOn(H);
  const till = appOn(R, { screen: 'confirm' });
  await holder.refreshBalance();
  const c = newCard(H);

  /* ---- MENU > FLASHCARD, and a new card ------------------------------------ */
  holder.goFlashcard();
  ok(H.sheet.length === 1 && /^begin: Hold the card/.test(H.sheet[0]), 'FLASHCARD in the menu asks for the card at once, with no screen to read first', H.sheet[0]);
  await settle();
  ok(holder.state.screen === 'home' && !holder.state.fc && !card(holder) && !stage(H),
     'the sheet dismissed: the person is where they were, with nothing over it and no screen for no card');
  H.nfc = c;
  holder.goFlashcard();
  await until('the new card to be read', () => !!holder.state.fc);
  ok(holder.state.screen === 'flashcard' && holder.state.stack.slice(-1)[0] === 'home', 'a card tapped, and the screen is that card; back from it is where they were');
  let v;
  v = vals(holder);
  ok(v.fcHas && v.fcNew && !v.fcUsable && v.fcCheck === 'No PIN yet' && v.fcBalance === '₿ 0' && v.fcSub === '' && !stage(H),
     'a card out of its packet reads as new, with one thing to do', v.fcCheck);
  ok(H.sheet.join(' / ').indexOf('begin: Hold the card to the top of the phone') >= 0 && H.sheet.indexOf('say: Reading the card') >= 0 && H.sheet.indexOf('end: Done. Remove the card.') >= 0,
     'and the phone’s own sheet was told what was happening', H.sheet.slice(-3).join(' / '));

  holder.fcSetUp();
  ok(pad(holder).title === 'CHOOSE A PIN', 'setting it up starts with a PIN');
  ok(pad(holder).ready === false && !pad(holder).hasCancel, 'its button is grey until there is a PIN to give, and the way out is the back button at the top');
  pad(holder).type('123');
  ok(pad(holder).title === 'CHOOSE A PIN' && pad(holder).ready === false && pad(holder).note === '', 'three digits and the button still does nothing');
  pad(holder).type('4');
  ok(pad(holder).title === 'TYPE IT AGAIN', 'typed twice');
  pad(holder).type('1235');
  ok(pad(holder).title === 'CHOOSE A PIN' && /did not match/.test(pad(holder).note), 'and two that differ start it again', pad(holder).note);
  pad(holder).type('1234');
  pad(holder).type('1234');
  ok(!pad(holder) && card(holder) && card(holder).title === 'SET UP THIS CARD'
       && card(holder).all === ['SET UP THIS CARD',
         'This phone can reset this card’s PIN and limit. Whoever holds the card and this phone’s seed phrase holds its money.',
         'CONTINUE', 'CANCEL'].join(' | ') && !c.state.owner,
     'the PIN given, the screen that makes this phone the card’s owner says what that means, once, before the card is touched; no limit is asked for', card(holder) && card(holder).all);
  card(holder).press('CANCEL');
  ok(!card(holder) && !pad(holder) && holder.state.screen === 'flashcard' && c.state.pinState === 0 && !c.state.owner,
     'CANCEL on it ends the set-up: nothing was written to the card');
  holder.fcSetUp();
  pad(holder).type('1234'); pad(holder).type('1234');
  card(holder).press('CONTINUE');
  ok(!card(holder) && !pad(holder) && holder.state.screen === 'flashcard' && holder.state.flow !== 'cardLimit',
     'CONTINUE goes to the tap: there is no limit to choose, and no amount is asked');
  await until('the card to be set up', () => card(holder) && card(holder).title === 'THE CARD IS READY');
  ok(c.state.record.limit === 0 && c.state.owner && holder.state.fc.limit === 0 && holder.state.fc.owner && holder.state.fc.ownedHere === true,
     'one tap gave the card its PIN, its record and its owner, and no limit', JSON.stringify({ limit: c.state.record.limit }));
  ok(/It is cash/.test(card(holder).reason) && !/limit/i.test(card(holder).reason) && /Lose the card and the money on it is gone/.test(card(holder).all),
     'and what cash means is said where the card becomes one', card(holder).all);
  v = vals(holder);
  ok(v.fcUsable && !v.fcNew && v.fcCheck === '' && !holder.state.fc.mine && !holder.state.fc.recoverable && H.W.cardsList().length === 0,
     'one tap later it has a PIN and is cash: no key of this phone’s is on it, and this phone keeps no list of it');
  ok(v.fcPill === true && v.fcPillMint === 'm.test' && v.fcPillLetter === 'M' && v.fcBalance === '₿ 0' && v.fcFields === undefined,
     'and the screen says its mint and what it holds in home’s own pill', v.fcPillMint + ' | ' + v.fcBalance);
  ok(v.fcLimitShown === true && v.fcLimitLine === 'NO LIMIT' && v.fcDayShown === false, 'and under it, that it has no limit, with nothing else to say of its day', v.fcLimitLine);
  ok(v.fcLinks.map((k) => k.label).join() === 'CHANGE PIN,CHANGE LIMIT' && v.fcHistoryVis === 'visible' && typeof v.fcAdd === 'function' && typeof v.fcWithdraw === 'function',
     'with ADD FUNDS and WITHDRAW, CHANGE PIN and CHANGE LIMIT under them, and its history at the top');
  ok(v.fcDesign === 'FL1' && holder.fcDesignOf({ design: 'zz9' }) === 'FL1' && holder.fcDesignOf({ design: 'fl1' }) === 'FL1' && Object.keys(holder.FC_DESIGNS).every((k) => /^[A-Z0-9]{3}$/.test(k)),
     'the card is drawn in the design FL1, as is one that names a design this build cannot draw; every design has a code of three characters', v.fcDesign);
  ok(v.fcVerified === 'Verified Just Now' && v.fcVerifiedShown === true, 'and under its title, that it is verified: a card with nothing on it has nothing a mint could dispute', v.fcVerified);

  /* ---- add funds: the owner's phone, with no PIN ------------------------------- */
  c.tap();
  card(holder).press('ADD FUNDS');
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.state.flow === 'cardAdd' && holder.state.unit === 'SATS' && holder.state.stack.slice(-1)[0] === 'flashcard',
     'ADD FUNDS asks how much on the SET AMOUNT screen (in sats here: this phone has no price to say dollars at)');
  keyIn(holder, 99999);
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.toasts.indexOf('You have ₿6,000.') >= 0, 'more than the phone holds goes no further');
  c.sent.length = 0;
  keyIn(holder, 2000);
  ok(!pad(holder) && holder.state.screen === 'flashcard', 'then no PIN is asked for: this phone owns the card, and the PIN was typed once, at set-up');
  await until('the money to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(c.balance() === 2000 && card(holder).reason === '₿2,000 went onto the card. It now holds ₿2,000.' && holder.state.fc.balance === 2000,
     'and 2,000 sats are on it, and the screen says so', card(holder).reason);
  ok(!c.sent.some((a) => /^b040/.test(a)) && c.sent.some((a) => /^b045/.test(a)), 'the card was never sent a PIN: this phone’s proof let it be loaded', c.sent.map((a) => a.slice(2, 4)).join(' '));
  const added = history(H).filter((e) => e.memo === 'to card')[0];
  ok(added && holder.seen[added.hash] === true && H.W.cardOwed().length === 0, 'its entry is one the app will not announce a second time, and nothing is left owed');
  card(holder).press('DONE');
  await until('the mint’s word on the card', () => holder.state.fc.check === 'ok');
  ok(vals(holder).fcCheck === '' && vals(holder).fcVerified === 'Verified Just Now', 'the mint is asked about what the card says it holds, and the screen says so once, under its title');

  /* ---- under the title: how fresh the mint's word on the card is -------------- */
  {
    ok(vals(holder).fcVerified === 'Verified Just Now' && H.W.cardCheckedAt(holder._fcCard) > 0, 'asked just now, the screen says so under its title', vals(holder).fcVerified);
    // two hours on, with no connection: the card is read, the mint cannot be asked, and the screen says how old its word is
    const realW = H.window.Date.now.bind(H.window.Date);
    const realN = Date.now;
    const shift = (ms) => { H.window.Date.now = () => realW() + ms; Date.now = () => realN() + ms; };
    const reread = async () => {
      c.tap();
      holder.setState({ fc: null });
      holder.fcRead();
      await until('the card to be read again', () => !!holder.state.fc && holder.state.fc.check !== 'asking');
    };
    shift(2 * 3600000 + 60000);
    H.deaf = true;
    await reread();
    ok(holder.state.fc.check === 'off' && vals(holder).fcVerified === 'Verified 2 Hours Ago', 'with no connection two hours later, it says when it was last verified', vals(holder).fcVerified);
    // a phone that never had the mint's word on these pieces cannot say it has
    const kept = H.storage.getItem('foxy.flashcard.checked');
    H.storage.setItem('foxy.flashcard.checked', '{}');
    await reread();
    ok(vals(holder).fcVerified === 'Not Verified', 'and a phone that never asked about these pieces says the card is not verified', vals(holder).fcVerified);
    // nor one whose word was about other pieces than the card holds now
    const other = JSON.parse(kept);
    Object.keys(other).forEach((k) => { other[k].nonces = other[k].nonces.slice(1); });
    H.storage.setItem('foxy.flashcard.checked', JSON.stringify(other));
    await reread();
    ok(vals(holder).fcVerified === 'Not Verified', 'nor one whose word did not cover every piece on it', vals(holder).fcVerified);
    H.storage.setItem('foxy.flashcard.checked', kept);
    H.deaf = false;
    H.window.Date.now = realW; Date.now = realN;
    await reread();
    await until('the mint to be asked again', () => holder.state.fc.check === 'ok');
    ok(vals(holder).fcVerified === 'Verified Just Now', 'and with the connection back it is verified again', vals(holder).fcVerified);
  }

  // the card taken away before the money is written: the pieces are made and wait, and the screen says so wherever it is opened
  c.tap();
  // with a price, the keypad opens in dollars and the button says dollars
  holder.price = 100000;
  holder.fcAdd();
  ok(holder.state.unit === 'USD', 'where the phone has a price, the amount is asked in dollars first');
  holder.state.amount = '0.50';
  const tap1 = c.tap;
  c.tap = () => { tap1(); c.leaveBefore('30', 1); c.tap = tap1; };
  holder.fcAmountNext();
  holder.price = 0;
  await until('the card to leave too soon', () => card(holder) && card(holder).title === 'THE CARD LEFT TOO SOON');
  ok(card(holder).has('TRY AGAIN') && c.balance() === 2000 && H.W.cardOwed().length === 1,
     'a card taken away before it was written to: said, and the 500 is kept for the card', card(holder).reason);
  v = vals(holder);
  ok(v.fcNotes.length === 1 && /₿500 is waiting to go onto this card/.test(v.fcNotes[0].text), 'the screen carries a line for it', v.fcNotes[0] && v.fcNotes[0].text);
  c.tap();
  card(holder).press('TRY AGAIN');
  ok(!pad(holder), 'TRY AGAIN asks for no PIN: this phone owns the card');
  await until('the 500 to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(c.balance() === 2500 && H.W.cardOwed().length === 0 && vals(holder).fcNotes.length === 0, 'and the next tap finishes it: 2,500 on the card, nothing waiting');
  card(holder).press('DONE');

  /* ---- being paid by the card, at somebody else's phone ----------------------- */
  till.asking = 1000;
  R.nfc = c;
  c.tap();
  till.payByCard();
  ok(pad(till).title === 'CARD PIN' && /To pay ₿1,000/.test(pad(till).sub) && pad(till).cta === 'PAY ₿1,000' && !pad(till).hasCancel,
     'CARD on the receive screen asks for the card’s PIN, on a button that says PAY and the amount', pad(till).cta);
  pad(till).back();
  ok(!pad(till) && till.state.screen === 'confirm', 'back from it is back to the invoice');
  till.payByCard();
  pad(till).type('0000');
  await until('the till to say the PIN was wrong', () => card(till) && card(till).title === 'WRONG PIN');
  ok(card(till).reason === '2 tries left. Nothing was taken.' && (await R.W.balanceSats()) === 0 && c.balance() === 2500 && till.state.screen === 'confirm',
     'a wrong PIN: said, nothing taken, and the invoice is still up', card(till).reason);
  c.tap();
  card(till).press('TRY AGAIN');
  // what is on the screen at the moment the mint is asked
  let atMint = null;
  R.sheet.length = 0;
  R.fate = (m) => {
    if (!atMint && /\/v1\/swap$/.test(String(m.url || ''))) {
      const up = R.window.document.getElementById('foxy-stage');
      atMint = { kind: stage(R), head: up && up.querySelector('h1') && up.querySelector('h1').textContent, line: up && up.querySelector('[data-stage-line]') && up.querySelector('[data-stage-line]').textContent,
                 button: up && up.querySelector('[data-stage-button]') && up.querySelector('[data-stage-button]').style.visibility, ended: R.ended };
    }
    return null;
  };
  // every card the till puts up, to see that none stood between the two taps
  const titles = [];
  const shown = till.blockedCard.bind(till);
  till.blockedCard = (kind, spec) => { titles.push((spec && spec.title) || kind); return shown(kind, spec); };
  pad(till).type('1234');
  await until('the payment to be made', () => till.state.screen === 'home');
  R.fate = null;
  // tap 1, SEND: the card signs the fewest pieces that cover it (two 512s for 1,000 here), and is let go; the 24 over is its change.
  // Then tap 2, RECEIVE, asked for by itself: the phone's sheet comes up again with nothing to press, and the card's tap puts the change back.
  await until('the payment to be complete', () => card(till) && card(till).title === 'COMPLETE');
  await settle();
  const ends = R.sheet.map((x, i) => (/^end:/.test(x) ? i : -1)).filter((i) => i >= 0);
  const sheet1 = R.sheet.slice(0, (ends[0] === undefined ? -1 : ends[0]) + 1);
  const sheet2 = R.sheet.slice(sheet1.length);
  ok(sheet1.indexOf('say: Keep the card there: asking the mint') < 0 && sheet1[sheet1.length - 1] === 'end: Done. Remove the card.' && !sheet1.some((x) => /^error:/.test(x)),
     'and the sheet did not say to keep the card there while the mint was asked: it ended, "Done. Remove the card.", when the card had signed', sheet1.slice(-4).join(' / '));
  ok(atMint && atMint.ended === true && atMint.kind === 'card' && /VERIFYING\s*WITH THE MINT/.test(atMint.head) && atMint.line === 'You can remove the card.' && atMint.button === 'hidden',
     'with the mint being asked, our own screen said VERIFYING WITH THE MINT and that the card can be removed, with nothing to press', JSON.stringify(atMint));
  ok((await R.W.balanceSats()) === 1000 && sheet2[0] === 'begin: Hold the card here again for its change' && ends.length === 2 && !pad(till),
     'the right PIN: 1,000 sats paid, and the second tap asked for by itself once the mint said paid: the sheet comes up again for the change, with no PIN', sheet2.join(' / '));
  ok(titles.indexOf('TAP TO RECEIVE') < 0 && titles.filter((t) => t !== 'COMPLETE').length === 0,
     'with no card to press between the two taps', titles.join(', '));
  ok(card(till).reason === 'Paid \u20bf1,000. \u20bf24 of change is back on the card.' && R.W.cardOwed().length === 0,
     'and then the payment is COMPLETE: what was paid, and the change back on the card', card(till).reason);
  card(till).press('DONE');
  till.blockedCard = shown;
  const paid = history(R).filter((e) => e.memo === 'card')[0];
  ok(paid && !till.seen[paid.hash] && R.W.tagsFor(paid.hash).to === 'card payment', 'its entry is left for the history pass to announce, as a payment');
  ok(c.balance() === 1500 && R.W.cardOwed().length === 0, 'the card holds its change: 1,500', String(c.balance()));

  till.state.screen = 'confirm';
  till.asking = 99999;
  c.tap();
  till.payByCard();
  pad(till).type('1234');
  await until('too little to be said', () => card(till) && card(till).title === 'NOT ENOUGH ON THE CARD');
  ok(card(till).reason === 'It holds ₿1,500. Nothing was taken.' && c.balance() === 1500, 'more than the card holds: refused before it signs anything', card(till).reason);
  card(till).press('CLOSE');

  // the card is let go before its change is made: paid, and the change waits for it.
  // A card of one piece, so there is change to give: cut the old way, with the wallet itself
  const c2 = newCard(H);
  await H.W.cardSetUp(c2, { pin: '1234' });
  await binaryLoad(H, c2, 1024);
  till.state.screen = 'confirm';
  till.asking = 200;
  R.nfc = c2;
  c2.tap();
  till.payByCard();
  pad(till).type('1234');
  // the card is taken away once it has signed and not brought back: the second tap's sheet comes up by itself and reads nothing
  await until('the payment to be made', () => till.state.screen === 'home' && R.W.cardOwed().length === 1);
  R.nfc = null;
  await until('the change to be said to be still waiting', () => card(till) && card(till).title === 'TAP TO RECEIVE' && /not read/.test(card(till).reason));
  const owed = R.W.cardOwed().reduce((n, r) => n + r.sats, 0);
  ok((await R.W.balanceSats()) === 1200 && owed === 824 && c2.balance() === 0
     && /^The card was not read\. \u20bf824 is still waiting to go back on it\. No PIN is needed\.$/.test(card(till).reason) && card(till).has('TAP CARD'),
     'a payment whose second tap reads no card: the payment stands, and the change is said to be still waiting, with TAP CARD to try again', card(till).reason);
  // a fresh card that has never paid: it has no change note, so it asks for the PIN after all
  const cElse = newCard(H);
  await H.W.cardSetUp(cElse, { pin: '1234' });
  R.nfc = cElse;
  cElse.tap();
  card(till).press('TAP CARD');
  await until('the PIN to be asked after all', () => pad(till));
  ok(/put \u20bf824 on the card/.test(pad(till).sub), 'TAP CARD taps first with no PIN; a card that has not just paid asks for it, and the pad comes up', pad(till).sub);
  cElse.tap();   // tapped again, with the PIN this time
  pad(till).type('1234');
  await until('the wrong card to be noticed', () => card(till) && card(till).title === 'A DIFFERENT CARD');
  ok(R.W.cardOwed().length === 1 && /\u20bf824 is waiting for CARD/.test(card(till).reason), 'another card tapped instead gets none of it, and the till says which card it is for', card(till).reason);
  card(till).press('CLOSE');
  R.nfc = c2;
  c2.tap();
  till.fcWriteAsk({});
  ok(!pad(till), 'the right card, which has just paid, is tapped with no PIN pad');
  await until('the change to be back on the card', () => card(till) && card(till).title === 'COMPLETE');
  ok(c2.balance() === 824 && R.W.cardOwed().length === 0 && card(till).reason === '\u20bf824 of change is back on the card.',
     'and the right card\u2019s second tap puts it back, COMPLETE, without the till being shown what the card holds', card(till).reason);
  card(till).press('DONE');
  ok(till.state.fc === null, 'nor is a payer\u2019s card left on show under the till\u2019s menu');

  /* ---- a payment the card leaves part way through is finished, not given back --------
   * What it signed is held for that payment, and the sheet comes up again by itself: the next
   * tap signs only the rest. No card to press, and nothing to write back to the card. */
  {
    const HL = await funded({ sharedMint: H.mint, words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' }, 4000);
    const RT = await funded({ sharedMint: H.mint, words: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' }, 0);
    const till2 = appOn(RT, { screen: 'confirm' });
    const c3 = newCard(HL);
    await HL.W.cardSetUp(c3, { pin: '1234' });
    await binaryLoad(HL, c3, 1536);         // 1,024 and 512, and a price they make exactly: no change to take
    till2.state.screen = 'confirm';
    till2.asking = 1536;
    RT.nfc = c3;
    const rb = await RT.W.balanceSats();
    const tap0 = c3.tap;
    c3.tap = () => { tap0(); c3.leaveBefore('20', 2); c3.tap = tap0; };      // the first tap only: it leaves before its second signature
    const titles = [];
    const shown = till2.blockedCard.bind(till2);
    till2.blockedCard = (k, sp) => { titles.push((sp && sp.title) || k); return shown(k, sp); };
    RT.sheet.length = 0;
    till2.payByCard();
    pad(till2).type('1234');
    await until('the payment to be finished by the next tap', () => till2.state.screen === 'home' && !RT.W.cardHeldPayment(c3.key) && RT.W.cardTaken().length === 0 && !stage(R));
    await settle();
    const got = (await RT.W.balanceSats()) - rb;
    const begins = RT.sheet.filter((x) => /^begin:/.test(x));
    ok(got === 1536 && c3.balance() === 0 && begins.length === 2 && begins[1] === 'begin: Hold the card here again to finish paying' && !pad(till2),
       'a payment the card leaves part way through: the sheet comes up again by itself, with no PIN, and the next tap signs the rest and pays', begins.join(' / ') + '; ' + got + ' received');
    ok(titles.length === 0 && RT.W.cardOwed().filter((r) => r.card === c3.key).length === 0, 'with no card to press, and nothing to put back on the card', titles.join(', '));
    till2.blockedCard = shown;

    // the tap to finish reads no card: NOT PAID YET, with TAP CARD to finish and CANCEL to give it back
    const c4 = newCard(HL);
    await HL.W.cardSetUp(c4, { pin: '1234' });
    await binaryLoad(HL, c4, 768);          // 512 and 256
    till2.state.screen = 'confirm';
    till2.asking = 768;
    RT.nfc = c4;
    const rb4 = await RT.W.balanceSats();
    const tap4 = c4.tap;
    c4.tap = () => { tap4(); c4.leaveBefore('20', 2); c4.tap = tap4; };
    till2.payByCard();
    pad(till2).type('1234');
    await until('the payment to be held', () => !!RT.W.cardHeldPayment(c4.key));
    RT.nfc = null;                      // and the card is not brought back
    await until('NOT PAID YET to be said', () => card(till2) && card(till2).title === 'NOT PAID YET');
    ok(/^The card was taken away before it had signed for all of ₿768\. Tap it again to finish paying\.$/.test(card(till2).reason) && card(till2).has('TAP CARD') && card(till2).has('CANCEL')
       && RT.W.cardOwed().length === 0 && (await RT.W.balanceSats()) === rb4,
       'a tap to finish that reads no card says NOT PAID YET, with TAP CARD to finish and CANCEL', card(till2).all);
    RT.nfc = c4;
    c4.tap();
    card(till2).press('CANCEL');
    await until('what it signed to be back on the card', () => card(till2) && card(till2).title === 'BACK ON THE CARD');
    ok(c4.balance() === 768 && !RT.W.cardHeldPayment(c4.key) && RT.W.cardOwed().length === 0 && (await RT.W.balanceSats()) === rb4,
       'CANCEL gives back what the card signed: the sheet comes up by itself, and the tap puts it back with no PIN', card(till2).reason + ' / ' + c4.balance());
    card(till2).press('DONE');
  }

  /* ---- its daily limit, in three steps; its PIN --------------------------------- */
  H.nfc = c;
  c.tap();
  holder.fcRead();
  await until('the card to be read again', () => holder.state.fc && holder.state.fc.balance === c.balance() && holder.state.fc.ownedHere === true);
  ok(holder.state.fc.ownedHere === true && vals(holder).fcLimitLine === 'NO LIMIT', 'the card is read again, and this phone is found to be its owner');
  holder.fcSetLimit();
  ok(card(holder) && card(holder).title === 'SET DAILY LIMIT' && card(holder).all === ['SET DAILY LIMIT', LIMIT_WARNING, 'CONTINUE', 'CANCEL'].join(' | '),
     'CHANGE LIMIT opens the warning, with CONTINUE and CANCEL', card(holder) && card(holder).all);
  card(holder).press('CANCEL');
  ok(!card(holder) && holder.state.screen === 'flashcard' && c.state.record.limit === 0 && holder._fcLimitDone === null, 'and CANCEL there changes nothing');
  holder.fcSetLimit();
  card(holder).press('CONTINUE');
  ok(holder.state.screen === 'amount' && holder.state.flow === 'cardLimit' && holder.state.stack.filter((x) => x === 'amount').length === 0,
     'CONTINUE asks for an amount on the same keypad, and only one keypad is up');
  keyIn(holder, 0);
  ok(holder.state.screen === 'amount' && holder.toasts.indexOf('Type an amount first.') >= 0, 'an amount of nothing typed goes no further: NO LIMIT is the way to say none');
  keyIn(holder, 700);
  ok(holder.state.screen === 'fcLimitConfirm' && holder.state.stack.slice(-2).join() === 'flashcard,amount', 'NEXT goes to the confirmation, over the keypad');
  {
    const cf = holder.fcLimitSpec();
    ok(cf.amountLabel === 'YOU ARE APPLYING A DAILY LIMIT OF:' && cf.amount === '\u20bf 700' && cf.cta === 'CONFIRM' && cf.secondary.label === 'CANCEL'
       && cf.warn === 'This card will spend no more than this in one day. The limit starts again by itself each day. Only this phone, or a phone restored from its seed phrase, can change or remove it.',
       'which says the amount, what it means and who can change it, with CONFIRM and CANCEL', JSON.stringify([cf.amountLabel, cf.amount]));
    cf.secondary.go();
    ok(holder.state.screen === 'flashcard' && c.state.record.limit === 0 && !card(holder) && !pad(holder),
       'CANCEL there goes back to the card’s screen, and nothing was written');
  }
  holder.fcSetLimit();
  card(holder).press('CONTINUE');
  keyIn(holder, 700);
  c.tap();
  c.sent.length = 0;
  holder.fcLimitSpec().go();
  ok(!pad(holder), 'CONFIRM asks for no PIN: this phone’s proof is what sets the limit');
  await until('the limit to be set', () => holder.state.fc.limit === 700);
  ok(c.state.record.limit === 700 && !c.sent.some((a) => /^b040/.test(a)) && holder.toasts.indexOf('Daily limit set.') >= 0,
     'and the card has its daily limit, and was never sent a PIN', String(holder.state.fc.limit));
  v = vals(holder);
  ok(v.fcLimitLine === 'DAILY LIMIT ₿700' && v.fcDayShown && v.fcDayLeft === 'LEFT TODAY ₿700' && /^THE DAY TURNS AT \d{1,2}:\d\d [AP]M/.test(v.fcDayTurns),
     'its screen shows the daily limit, what is left today, and when the day turns', [v.fcLimitLine, v.fcDayLeft, v.fcDayTurns].join(' | '));

  /* ---- a till, over the day --------------------------------------------------------- */
  // the card's clock never goes back, and an earlier check in this suite moved the phone's two hours on: this one begins from the card's
  const clock = { ms: Math.max(Date.now(), c.state.now * 1000) + 1000 };
  H.phone.clockMs = () => clock.ms;
  R.phone.clockMs = () => clock.ms;
  till.state.screen = 'confirm';
  till.asking = 900;
  R.nfc = c;
  c.tap();
  c.sent.length = 0;
  till.payByCard();
  pad(till).type('1234');
  await until('the limit to refuse', () => card(till) && card(till).title === 'OVER THE CARD’S DAILY LIMIT');
  ok(/Nothing was taken/.test(card(till).reason) && /The card can spend ₿700 in a day, and this payment is more than that/.test(card(till).reason) && (await R.W.balanceSats()) === 1200,
     'a till asking for more than the card can spend in a day is refused, in plain words, with nothing signed', card(till).reason);
  ok(!c.sent.some((a) => /^b0(40|20)/.test(a)), 'and the card was never sent the PIN');
  card(till).press('CLOSE');
  till.asking = 300;
  c.tap();
  till.payByCard();
  pad(till).type('1234');
  await until('the payment of 300', () => till.state.screen === 'home');
  // its change, if any, goes back on at the second tap, asked for by itself; the day stays charged the whole pieces
  await until('the 300 to be complete', () => R.W.cardOwed().length === 0 && (!R.W.cardTaken().length));
  await until('the second tap, if any, to be over', () => !stage(R));
  if (card(till) && card(till).title === 'COMPLETE') card(till).press('DONE');
  const spentNow = c.state.spent;
  ok(spentNow >= 300 && spentNow <= 700 && (await R.W.balanceSats()) >= 1200 + 290, 'a payment inside the day goes, and the day is charged the whole pieces', String(spentNow));
  till.state.screen = 'confirm';
  till.asking = 450;     // the day was charged at least 300 of its 700, so less than 450 is left
  c.tap();
  c.sent.length = 0;
  till.payByCard();
  pad(till).type('1234');
  await until('the day to refuse', () => card(till) && card(till).title === 'OVER THE CARD’S DAILY LIMIT');
  ok(/The card can still spend/.test(card(till).reason) && /today\. Its day turns at \d{1,2}:\d\d [AP]M/.test(card(till).reason) && /Nothing was taken/.test(card(till).reason),
     'a second payment is over what is left today: said, with how much is left and when the day turns', card(till).reason);
  ok(!c.sent.some((a) => /^b0(40|20)/.test(a)), 'with nothing sent to the card but the time and its own words');
  card(till).press('CLOSE');
  // a day on, the card's day is over and a payment the card has pieces for goes
  clock.ms += 86400 * 1000;
  till.asking = 150;
  c.tap();
  till.payByCard();
  pad(till).type('1234');
  await until('the day to have turned', () => till.state.screen === 'home');
  // its change goes back on at the second tap, asked for by itself
  await until('the 150 to be complete', () => R.W.cardOwed().length === 0 && !R.W.cardTaken().length);
  await until('the second tap, if any, to be over', () => !stage(R));
  if (card(till) && card(till).title === 'COMPLETE') card(till).press('DONE');
  ok((await R.W.balanceSats()) >= 1200 + 290 + 140 && c.state.windowStart === Math.floor(clock.ms / 1000) && c.state.spent <= 700, 'a day later the card’s day has turned: a payment goes, and a new day begins with only that in it', String(c.state.spent));

  // a phone that does not hold the words cannot change the PIN: said before anything is asked
  {
    const O = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
    const other = appOn(O);
    O.nfc = c;
    c.tap();
    other.fcRead(true);
    await until('the card to be read by the other phone', () => other.state.fc);
    ok(other.state.fc.owner === true && other.state.fc.ownedHere === false, 'a phone with other words finds the card is not its own');
    other.fcChangePin();
    ok(!pad(other) && card(other) && card(other).title === 'NOT THIS PHONE’S CARD' && /does not hold the seed phrase this card was set up with/.test(card(other).reason)
       && c.state.tries === 3 && c.state.pin === Buffer.from('1234').toString('hex'),
       'changing the PIN with other words is refused in plain words before any pad is raised, and the card’s PIN is as it was', card(other) && card(other).reason);
    card(other).press('CLOSE');
    other.fcSetLimit();
    ok(!pad(other) && card(other) && card(other).title === 'NOT THIS PHONE’S CARD', 'and so is the limit');
  }

  holder.fcChangePin();
  ok(pad(holder).title === 'NEW PIN', 'CHANGE PIN asks for the new PIN, and not the old: this phone does not know it');
  pad(holder).type('4321');
  c.tap();
  pad(holder).type('4321');
  await until('the PIN to be changed', () => card(holder) && card(holder).title === 'PIN CHANGED');
  ok(c.state.pin === Buffer.from('4321').toString('hex'), 'and the card has the new PIN', c.state.pin);
  card(holder).press('DONE');

  /* ---- a blocked card, and UNBLOCK on its owner's phone ------------------------ */
  {
    till.state.screen = 'confirm';
    till.asking = 3;     // a piece the card has, within what is left of its day
    R.nfc = c;
    for (let i = 0; i < 3; i++) {
      c.tap();
      till.payByCard();
      pad(till).type('0000');
      await until('a wrong PIN to be said', () => card(till) && (card(till).title === 'WRONG PIN' || card(till).title === 'CARD BLOCKED'));
      card(till).press(card(till).title === 'WRONG PIN' ? 'CANCEL' : 'CLOSE');
    }
    ok(c.state.pinState === 2, 'three wrong PINs at a till block the card');
    H.nfc = c;
    c.tap();
    holder.fcRead();
    await until('the blocked card to be read', () => holder.state.fc && holder.state.fc.pin === 'blocked');
    v = vals(holder);
    ok(v.fcBlocked && v.fcUnblock === true && /This phone can unblock the card/.test(v.fcBlockedLine) && !v.fcUsable,
       'the owner’s phone reads it as blocked, and offers UNBLOCK', v.fcBlockedLine);
    v.fcUnblockTap();
    ok(pad(holder).title === 'NEW PIN', 'UNBLOCK is CHANGE PIN: a new PIN, and not the old one');
    pad(holder).type('4321');
    pad(holder).type('4321');
    c.tap();
    await until('the card to be unblocked', () => card(holder) && card(holder).title === 'CARD UNBLOCKED');
    ok(c.state.pinState === 1 && c.state.tries === 3 && c.state.pin === Buffer.from('4321').toString('hex') && holder.state.fc.pin === 'set',
       'and the card is unblocked with the new PIN, which no one had to know the old one to set', String(c.state.pinState));
    card(holder).press('DONE');
    // a phone that does not own it is offered nothing
    holder.state.fc = Object.assign({}, holder.state.fc, { pin: 'blocked', ownedHere: false });
    v = vals(holder);
    ok(v.fcBlocked && v.fcUnblock === false && /Only the phone that owns this card/.test(v.fcBlockedLine), 'another phone is told only the owner can unblock it, and is offered no button');
    holder.state.fc = Object.assign({}, holder.state.fc, { pin: 'set', ownedHere: true });
  }
  /* ---- NO LIMIT: how a limit is removed ------------------------------------------- */
  holder.fcSetLimit();
  card(holder).press('CONTINUE');
  ok(holder.state.screen === 'amount' && holder.state.flow === 'cardLimit', 'the keypad is asking for the daily limit, and NO LIMIT is its second answer under NEXT');
  holder.fcLimitConfirm(0);
  {
    const cf = holder.fcLimitSpec();
    ok(cf.amountLabel === 'YOU ARE REMOVING THIS CARD’S DAILY LIMIT.' && cf.amount === 'NO LIMIT' && cf.warn === 'It will be able to spend everything on it.' && cf.cta === 'CONFIRM' && cf.secondary.label === 'CANCEL',
       'NO LIMIT is confirmed in its own words: the card will be able to spend everything on it', JSON.stringify([cf.amountLabel, cf.amount, cf.warn]));
  }
  c.tap();
  holder.fcLimitSpec().go();
  await until('the limit to be removed', () => holder.state.fc.limit === 0);
  ok(c.state.record.limit === 0 && holder.toasts.indexOf('Daily limit removed.') >= 0 && vals(holder).fcLimitLine === 'NO LIMIT' && vals(holder).fcDayShown === false,
     'and the card has no limit, and its screen says so', vals(holder).fcLimitLine);
  // and a limit again, taken through the screens as a person does
  holder.fcSetLimit();
  takeLimitSteps(holder, 700);
  c.tap();
  await until('the limit to be set again', () => holder.state.fc.limit === 700);
  ok(c.state.record.limit === 700, 'a limit again, for what follows');

  /* ---- withdraw ------------------------------------------------------------ */
  c.tap();
  holder.fcRead();
  await until('the card to be read', () => holder.state.fc && holder._fcCard && holder.state.fc.check !== 'asking');
  await holder.refreshBalance();
  const hadBefore = holder.have;
  const onCard = c.balance();
  holder.fcWithdraw();
  ok(holder.state.screen === 'amount' && holder.state.flow === 'cardWd', 'WITHDRAW asks on the same keypad, with ALL OF IT under its NEXT');
  keyIn(holder, onCard + 1);
  ok(!pad(holder) && holder.toasts.indexOf('The card holds ₿' + holder.group(onCard) + '.') >= 0, 'more than the card holds goes no further');
  holder.fcWithdrawPin(0);            // ALL OF IT
  ok(card(holder) === null && pad(holder) && pad(holder).title === 'ENTER PIN TO WITHDRAW',
     'the card holds more than the day has left, and the holder is not stopped: the PIN is asked for at once', pad(holder) && pad(holder).title);
  pad(holder).back();
  await settle();
  c.tap();
  c.sent.length = 0;
  holder.fcWithdrawPin(0);
  ok(pad(holder).title === 'ENTER PIN TO WITHDRAW' && pad(holder).cta === 'WITHDRAW ALL', 'then: ENTER PIN TO WITHDRAW', pad(holder).cta);
  pad(holder).type('4321');
  await until('the money to be in the wallet', () => card(holder) && card(holder).title === 'IN YOUR WALLET');
  await settle();
  ok(c.balance() === 0 && (await H.W.balanceSats()) === hadBefore + onCard && holder.state.fc === null && holder.state.screen !== 'flashcard',
     'all of it is in the phone, though the limit was 700 a day: the holder’s phone lifted it in the same tap. The card was let go once it had signed and is not read again, so its screen goes: the next tap shows it', card(holder).reason);
  ok(c.state.record.limit === 700, 'and the limit is back as it was when the card left the phone', String(c.state.record.limit));
  ok(c.sent.filter((a) => /^b034/.test(a)).length === 2, 'having been lifted and put back, with this phone’s proof, in the one tap');
  const out = history(H).filter((e) => e.memo === 'from card')[0];
  ok(out && holder.seen[out.hash] === true, 'and its entry is not announced a second time');
  card(holder).press('DONE');

  // a withdrawal cut short keeps what the card signed, and the sheet comes up again by itself for the rest
  {
    c.tap();
    await H.W.cardAdd(c, { sats: 1500, owner: true });
    c.tap();
    holder.fcRead(true);
    await until('the loaded card to be read', () => holder.state.fc && holder.state.fc.balance === 1500 && holder.state.fc.check !== 'asking');
    await holder.refreshBalance();
    const had = await H.W.balanceSats();
    const titlesW = [];
    const shownW = holder.blockedCard.bind(holder);
    holder.blockedCard = (k, sp) => { titlesW.push((sp && sp.title) || k); return shownW(k, sp); };
    // the session's own tap, and then the third piece is not answered: the card is taken away
    const tapW = c.tap;
    c.tap = () => { tapW(); c.leaveBefore('20', 3); c.tap = tapW; };
    H.sheet.length = 0;
    holder.fcWithdrawPin(0);
    pad(holder).type('4321');
    await until('the whole withdrawal to be in the wallet', () => card(holder) && card(holder).title === 'IN YOUR WALLET');
    await settle();
    const begins = H.sheet.filter((x) => /^begin:/.test(x));
    ok(begins.length === 2 && begins[1] === 'begin: Hold the card here again for the rest' && !pad(holder) && titlesW.join() === 'IN YOUR WALLET',
       'a withdrawal cut short keeps what came off, and the sheet comes up again by itself for the rest, with no PIN and no card to press', begins.join(' / ') + ' | ' + titlesW.join(', '));
    ok(c.balance() === 0 && (await H.W.balanceSats()) === had + 1500 && card(holder).reason === '₿1,500 from the card is in this phone now.' && c.state.record.limit === 700 && H.W.cardOwed().length === 0,
       'and then all of it is in the phone, said as the whole withdrawal, and the card’s limit is back as it was', card(holder).reason + ' / ' + c.state.record.limit);
    card(holder).press('DONE');

    // the sheet for the rest reads no card: TAP THE CARD AGAIN, with what came off so far, and TAP CARD for the rest
    c.tap();
    await H.W.cardAdd(c, { sats: 1500, owner: true });
    c.tap();
    holder.fcRead(true);
    await until('the card to be read again', () => holder.state.fc && holder.state.fc.balance === 1500 && holder.state.fc.check !== 'asking');
    const had2 = await H.W.balanceSats();
    c.tap = () => { tapW(); c.leaveBefore('20', 3); c.tap = tapW; };
    H.sheet.length = 0;
    holder.fcWithdrawPin(0);
    pad(holder).type('4321');
    // the first tap ends with the card gone, and the card is not brought back for the sheet that follows
    await until('the first tap to end with the card gone', () => H.sheet.some((x) => /^error:/.test(x)) && holder.state.fc === null);
    H.nfc = null;
    await until('the rest to be asked for with a card', () => card(holder) && card(holder).title === 'TAP THE CARD AGAIN');
    const first = (await H.W.balanceSats()) - had2;
    ok(first > 0 && c.balance() === 1500 - first && /came off the card into this phone before it was taken away\. Tap it again for the rest/.test(card(holder).reason)
       && card(holder).has('TAP CARD') && card(holder).has('LATER') && H.W.cardOwed().length === 0,
       'where that sheet reads no card, it says what came off and offers the tap for the rest; nothing waits to go back', card(holder).reason);
    H.nfc = c;
    c.tap();
    card(holder).press('TAP CARD');
    ok(!pad(holder), 'the tap for the rest asks no PIN again: it is the same withdrawal');
    await until('the rest to be in the wallet', () => card(holder) && card(holder).title === 'IN YOUR WALLET');
    await settle();
    ok(c.balance() === 0 && (await H.W.balanceSats()) === had2 + 1500 && card(holder).reason === '₿1,500 from the card is in this phone now.',
       'and then all of it is in the phone, said as the whole', card(holder).reason);
    card(holder).press('DONE');
    holder.blockedCard = shownW;
  }

  // money going onto the card, cut short after some of it is written: the sheet comes up again by itself for the rest
  {
    c.tap();
    holder.fcRead(true);
    await until('the card to be read for a load', () => holder.state.fc && holder.state.screen === 'flashcard' && holder.state.fc.check !== 'asking');
    const onBefore = c.balance();
    c.tap();
    const seenL = await H.W.cardLook(c);
    await H.W.cardPrepare(seenL, 1000);                 // many pieces, made and owed to the card
    const tapL = c.tap;
    c.tap = () => { tapL(); c.leaveBefore('30', 3); c.tap = tapL; };   // two pieces go on, and the card leaves
    H.sheet.length = 0;
    holder.fcWriteAsk({});
    await until('the load to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
    await settle();
    const beginsL = H.sheet.filter((x) => /^begin:/.test(x));
    ok(beginsL.length === 2 && beginsL[1] === 'begin: Hold the card here again for the rest' && c.balance() === onBefore + 1000 && H.W.cardOwed().length === 0,
       'a load cut short after some pieces went on: the sheet comes up again by itself, and the rest goes on', beginsL.join(' / ') + ' | ' + c.balance());
    card(holder).press('DONE');
    // and taken off again, so what comes after has the phone and the card as they were
    c.tap();
    await H.W.cardWithdraw(c, { pin: '4321' });
    await settle();
    holder.setState({ screen: 'home', stack: [], fc: null });
  }

  // a payment the card left part-way through is said by what it was: not paid, and how its money goes back
  till.fcFailed({ card: 'interrupted', owed: 512, made: true }, { paying: true, taken: true });
  ok(card(till).title === 'NOT PAID' && card(till).reason === 'The card was taken away too soon. Nothing was paid. Tap it again to put back the ₿512 it signed for. No PIN is needed.'
     && card(till).has('TAP CARD'), 'a payment cut short says NOT PAID, and that the next tap puts back what it signed, with no PIN', card(till).all);
  card(till).press('LATER');
  till.fcFailed({ card: 'interrupted', owed: 512, made: false }, { paying: true, taken: true });
  ok(/made ready to go back on it once this phone reaches the mint, and the card\u2019s next tap here puts it back\.$/.test(card(till).reason) && !card(till).has('TAP CARD') && card(till).has('OK'),
     'and, where the mint has not answered, that it goes back once it has, with no TAP CARD to find nothing waiting', card(till).all);
  card(till).press('OK');
  // change the mint did not make: the payment stands, and the phone says it makes the change when it next connects
  till.fcChangeLater(824, 200);
  ok(card(till).title === 'CHANGE NOT MADE YET' && card(till).reason === 'Paid \u20bf200. The mint did not make its \u20bf824 of change. This phone tries again whenever it connects, and then a tap of the card here receives it.'
     && card(till).has('OK'), 'change the mint did not make is said, with when it will be', card(till).all);
  card(till).press('OK');

  /* ---- with the switch on: cards that can be taken back -----------------------
   * Off, as it ships: no list, and a card that leaves the screen takes the
   * screen with it. On, for the rest of this suite: the choice at set-up, the
   * list of cards this phone loaded, RENEW in a card's last month, and a lost
   * card's money taken back. */
  ok(vals(holder).fcRows.length === 0 && vals(holder).fcHasRows === false, 'as it ships, there is no list of cards to take back');
  holder.fcGone();
  ok(holder.state.screen === 'home' && !holder.state.fc, 'and a card that is no longer known takes its screen with it');
  holder.FC_RECOVERABLE = true;
  const cashCard = c;
  const rc = newCard(H);
  H.nfc = null;
  holder.goFlashcard();
  await settle();
  v = vals(holder);
  ok(holder.state.screen === 'flashcard' && v.fcNone && v.fcRows.length === 0, 'switched on, the sheet dismissed leaves the screen where lost cards are listed');
  H.nfc = rc;
  holder.fcRead();
  await until('the second card to be read', () => !!holder.state.fc);
  holder.fcSetUp();
  pad(holder).type('4321');
  pad(holder).type('4321');
  card(holder).press('CONTINUE');
  ok(!pad(holder) && card(holder) && card(holder).title === 'IF THE CARD IS LOST' && card(holder).has('RECOVERABLE') && card(holder).has('LIKE CASH'),
     'and set-up has its one choice: recoverable, or like cash', card(holder) && card(holder).title);
  rc.tap();
  card(holder).press('RECOVERABLE');
  await until('the second card to be set up', () => card(holder) && card(holder).title === 'THE CARD IS READY');
  ok(holder.state.fc.mine && holder.state.fc.recoverable, 'chosen recoverable, it is this phone\u2019s to take back');
  card(holder).press('LATER');
  rc.tap();
  holder.fcAdd();
  keyIn(holder, 1024);
  ok(!card(holder) && !pad(holder), 'adding funds offers nothing about a limit, and asks for no PIN');
  await until('1,024 to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(rc.state.record.limit === 0 && rc.balance() === 1024, 'and the card has it, and no limit', String(rc.state.record.limit));
  card(holder).press('DONE');
  const renewLine = (vv) => vv.fcNotes.filter((n) => /must be renewed by/.test(n.text))[0];
  ok(!renewLine(vals(holder)), 'with a year to run there is nothing to renew');
  const real = H.window.Date.now.bind(H.window.Date);
  const realHere = Date.now;
  const move = (ms) => { H.window.Date.now = () => real() + ms; Date.now = () => realHere() + ms; };
  move(350 * 86400000);
  v = vals(holder);
  ok(!!renewLine(v) && typeof renewLine(v).tap === 'function' && v.fcLinks.length === 2,
     'in its last month the screen carries a line to renew it, and by when', renewLine(v) && renewLine(v).text);
  rc.tap();
  const entriesBefore = history(H).map((e) => e.hash);
  holder.fcRenew();
  pad(holder).type('4321');
  await until('the card to be renewed', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(rc.balance() === 1024 && !renewLine(vals(holder)) && history(H).filter((e) => entriesBefore.indexOf(e.hash) < 0).length === 2
     && history(H).filter((e) => entriesBefore.indexOf(e.hash) < 0).every((e) => holder.seen[e.hash]),
     'renewed in one tap: the same 1,024, a year on, its two entries not announced', card(holder).reason);
  ok(rc.state.record.limit === 0, 'and the limit is what it was', String(rc.state.record.limit));
  card(holder).press('DONE');

  // a year later the card is lost
  move(800 * 86400000);
  H.nfc = null;                         // the card is lost: nothing answers the sheet
  holder.state.screen = 'home'; holder.state.stack = [];
  holder.goFlashcard();
  await settle();
  v = vals(holder);
  ok(v.fcRows[0].text === 'TAKE BACK' && v.fcRows[0].sub === '₿1,024 when last seen', 'past its date the list offers to take it back', v.fcRows[0].text);
  v.fcRows[0].tap();
  ok(card(holder).title === 'TAKE IT BACK?' && /lost or blocked/.test(card(holder).reason), 'asked first, and told what it is for', card(holder).reason);
  await holder.refreshBalance();
  const beforeBack = holder.have;
  card(holder).press('TAKE IT BACK');
  await until('the money to be back', () => card(holder) && card(holder).title === 'BACK IN YOUR WALLET');
  ok((await H.W.balanceSats()) === beforeBack + 1024 && /₿1,024 from the card/.test(card(holder).reason) && !stage(H), 'and 1,024 sats are back with no card', card(holder).reason);
  card(holder).press('DONE');
  ok(vals(holder).fcRows[0].sub === 'Taken back', 'the list says so');
  ok(cashCard.balance() === 0, 'and the cash card was never in it');
  H.window.Date.now = real;
  Date.now = realHere;

  /* ---- what cannot be done, said before a pad is raised ----------------------- */
  holder.offline = true;
  till.offline = true;
  till.state.screen = 'confirm';
  till.asking = 100;
  till.payByCard();
  ok(!pad(till) && /A card payment needs a connection/.test(till.toasts.join('|')), 'offline, CARD says it needs a connection and asks for nothing');
  holder.offline = false;
  till.offline = false;
  till.asking = 0;
  till.payByCard();
  ok(!pad(till) && /Enter an amount first/.test(till.toasts.join('|')), 'with no amount asked for, it says so');
  R.nfc = 'off';
  till.asking = 100;
  till.payByCard();
  pad(till).type('1234');
  await until('a phone with no reader to say so', () => card(till) && card(till).title === 'NO CARD READER');
  card(till).press('CLOSE');
  ok(!stage(R), 'and a phone that cannot read a card says that, with nothing left on screen');

  /* ---- the mint refuses a payment the card has signed for ----------------------- */
  {
    const f = newCard(H);
    await H.W.cardSetUp(f, { pin: '1234' });
    f.tap();
    await H.W.cardAdd(f, { sats: 1000, owner: true });
    f.tap();
    await H.W.cardSetLimit(f, { sats: 900 });
    const refuse = (code, detail) => '400\n' + JSON.stringify({ code, detail });
    R.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? refuse(11000, 'signature for P2PK does not verify') : null);
    const rb = await R.W.balanceSats();
    till.state.screen = 'confirm';
    till.asking = 300;
    R.nfc = f;
    f.tap();
    R.sheet.length = 0;
    till.payByCard();
    pad(till).type('1234');
    await until('the failed payment to be said', () => card(till) && card(till).title === 'PAYMENT FAILED');
    R.fate = null;
    const signedFor = f.state.spent;     // the fewest pieces that cover 300, signed whole
    ok(signedFor >= 300 && card(till).has('TAP CARD') && card(till).has('LATER') && card(till).reason === 'The mint refused it, and the card had already signed for it. Tap the card again to put ₿' + signedFor.toLocaleString('en-US') + ' back on it.'
       && /daily limit stays used/.test(card(till).all) && (await R.W.balanceSats()) === rb && till.state.screen === 'confirm' && !stage(R),
       'a refused payment says it failed and that the card must be tapped again to put the money back, and that its day stays charged; nothing was paid, and the invoice is still up', card(till).all);
    ok(R.sheet[R.sheet.length - 1] === 'end: Done. Remove the card.' && !R.sheet.some((x) => /^error:/.test(x)), 'the sheet had already ended well; it is not made to look like a failure now');
    f.tap();
    card(till).press('TAP CARD');
    ok(!pad(till), 'TAP CARD puts it back with no PIN: the card has just signed, and lets the tap after a payment load');
    await until('the money to be put back', () => card(till) && card(till).title === 'PUT BACK ON THE CARD');
    ok(card(till).reason === '₿' + signedFor.toLocaleString('en-US') + ' is back on the card. The payment was not made.' && f.balance() === 1000 && R.W.cardOwed().length === 0 && f.state.spent === signedFor,
       'and says it is back, and that the payment was not made; the card holds what it did and its day is as charged', card(till).reason + ' / ' + f.balance() + ' / ' + f.state.spent);
    card(till).press('DONE');

    // the screens for the same, said as the wallet says it (also for a withdrawal, and one found by the wallet’s own asking)
    till.fcFailed({ card: 'putback', owed: 88, limited: false }, { paying: true, taken: true });
    ok(card(till).title === 'PAYMENT FAILED' && !/daily limit/.test(card(till).all), 'a card with no limit is not told its day stays charged', card(till).all);
    card(till).press('LATER');
    till.fcFailed({ card: 'putback', owed: 88, limited: true }, { taken: true });
    ok(card(till).title === 'NOT TAKEN OFF' && /daily limit stays used/.test(card(till).all), 'a withdrawal that is refused says that, and that its limit is used', card(till).all);
    card(till).press('LATER');

    // a refusal found by the wallet's own asking, while the CHECKING screen is up, is said the same way
    const settleWas = R.W.cardSettle;
    R.W.cardSettle = () => Promise.resolve([{ id: 'card-x', state: 'putback', owed: 88, limited: true, sats: 0 }]);
    till.fcChecking('card-x', { paying: true, taken: true });
    ok(stage(R) === 'cardChecking', 'a payment whose answer has not come is on the CHECKING screen');
    await until('the refusal to be said', () => card(till) && card(till).title === 'PAYMENT FAILED');
    ok(!stage(R) && card(till).has('TAP CARD') && /put ₿88 back on it/.test(card(till).reason), 'and when the wallet finds the mint has refused it, the screen says so and offers the card’s next tap', card(till).reason);
    card(till).press('LATER');
    R.W.cardSettle = () => Promise.resolve([{ id: 'card-x', state: 'bad', owed: 0, limited: false, sats: 0 }]);
    till.fcChecking('card-x', { paying: true, taken: true });
    await until('the bad pieces to be said', () => card(till) && card(till).title === 'THE CARD’S PIECES ARE NOT GOOD');
    card(till).press('CLOSE');
    R.W.cardSettle = settleWas;
  }

  /* ---- the card says which piece it is on, on the sheet and on the screen ------- */
  {
    const d = newCard(H);
    await H.W.cardSetUp(d, { pin: '1234' });
    await binaryLoad(H, d, 1000);            // 512 256 128 64 32 8, cut the old way so that a price takes pieces and not a drawer's small ones
    const lines = [];
    const was = till.fcLine.bind(till);
    till.fcLine = (t) => { lines.push(t); was(t); };
    // the tap is held half-way, so the screen can be looked at while the card is still on the phone
    let let_go = null;
    const gate = new Promise((r) => { let_go = r; });
    R.nfc = { tap: () => d.tap(), send: (a) => (/^b020/.test(a) ? gate.then(() => d.send(a)) : d.send(a)) };
    till.state.screen = 'confirm';
    till.asking = 960;                  // 512 + 256 + 128 + 64: four pieces and no change
    R.sheet.length = 0;
    till.payByCard();
    pad(till).type('1234');
    await until('the card to be asked to sign', () => R.sheet.indexOf('say: Signing piece 1 of 4') >= 0);
    ok(lines.indexOf('Signing piece 1 of 4') >= 0 && R.window.document.querySelector('[data-stage-line]').textContent === 'Signing piece 1 of 4',
       'the screen behind the sheet says the piece being signed, as the sheet does', R.sheet.slice(-2).join(' / '));
    // what the phone’s own link says, pushed to the page as it happens
    R.W._card({ stage: 'connected', text: 'Scanning. Hold still.' });
    ok(R.window.document.querySelector('[data-stage-line]').textContent === 'Scanning. Hold still.', 'and what the phone’s link pushes (the card found) is shown there too');
    R.W._card({ stage: 'say', text: 'Signing piece 1 of 4' });
    let_go();
    await until('the payment to be made', () => till.state.screen === 'home');
    await settle();
    ok(['Signing piece 1 of 4', 'Signing piece 2 of 4', 'Signing piece 3 of 4', 'Signing piece 4 of 4'].every((t) => R.sheet.indexOf('say: ' + t) >= 0)
       && R.sheet[R.sheet.length - 1] === 'end: Done. Remove the card.' && d.balance() === 40 && !stage(R),
       'each piece was said on the sheet in turn, the sheet ended “Done. Remove the card.”, and the screen is down', R.sheet.slice(-3).join(' / '));
    till.fcLine = was;
    R.nfc = d;
    ok(R.W.cardOwed().length === 0 && d.state.slots.filter((x) => x.status === 1).length === 2, 'no change was needed: the card was not written to');

    // a push with no tap under way changes nothing and breaks nothing
    R.W._card({ stage: 'say', text: 'stray' });
    R.W._card(null);
    ok(!R.window.document.querySelector('[data-stage-line]'), 'a push with no tap under way draws nothing');

    /* ---- with no route: the HIGH RISK card first, a yes or a no, the exact set only ------ */
    const offline = () => R.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    const online = () => R.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    const e = newCard(H);
    await H.W.cardSetUp(e, { pin: '1234' });
    await binaryLoad(H, e, 1000);            // 512 256 128 64 32 8
    R.W.onOfflineOffer((info) => till.offlineRiskCard(info));
    R.nfc = e;
    offline();
    till.state.screen = 'confirm';
    till.asking = 800;                  // 512 + 256 + 32 = 800
    e.sent.length = 0;
    till.payByCard();
    ok(card(till) && card(till).title === 'HIGH RISK \u2014 YOU ARE OFFLINE' && !pad(till) && e.sent.length === 0 && /Amount/.test(card(till).all),
       'a till with no route puts the HIGH RISK card first, with the amount, before the PIN and before the card is touched', card(till) && card(till).title);
    card(till).press('REJECT');
    await settle();
    ok(!pad(till) && !card(till) && e.sent.length === 0 && R.W.trustedWaiting().length === 0 && till.state.screen === 'confirm',
       'REJECT: nothing asked of the card, nothing kept, and the invoice is still up');
    till.payByCard();
    card(till).press('CONTINUE');
    await until('the PIN pad', () => !!pad(till));
    ok(pad(till).title === 'CARD PIN', 'CONTINUE: the PIN is asked for next');
    pad(till).type('1234');
    await until('the card to be taken on trust', () => card(till) && card(till).title === 'TAKEN ON TRUST');
    ok(/not paid until this phone is online/.test(card(till).reason) && !/\bPAID\b|PAYMENT RECEIVED/.test(card(till).title) && R.W.trustedWaiting().length === 1
       && e.balance() === 200, 'it is said to be taken on trust and not paid, and kept as a pending trusted payment', card(till).reason);
    card(till).press('OK');
    ok(till.state.screen === 'home', 'OK closes the invoice');
    // a price the card does not make
    till.state.screen = 'confirm';
    till.asking = 150;                  // the card holds 128 + 64 + 8: no 150
    e.tap();
    e.sent.length = 0;
    till.payByCard();
    card(till).press('CONTINUE');
    await until('the PIN pad', () => !!pad(till));
    pad(till).type('1234');
    await until('the inexact price to be refused', () => card(till) && card(till).title === 'NO CHANGE WHILE OFFLINE');
    ok(/cannot give change/.test(card(till).reason) && /Nothing was taken/.test(card(till).reason) && !e.sent.some((a) => /^b040|^b020/.test(a)) && e.balance() === 200,
       'a price the card cannot make exactly is refused in plain words before the PIN is sent', card(till).reason);
    card(till).press('CLOSE');
    online();
    await R.W.claimUnclaimed();
    await settle();
    ok(R.W.trustedWaiting().length === 0, 'online again, what was taken on trust is swapped in');
  }

  /* ---- a card at another mint ------------------------------------------------------ */
  {
    const T = await funded({ second: true }, 6000);
    const app = appOn(T);
    const { MINT, MINT2 } = require('./flashcard-kit');
    const empty = newCard(T);
    await T.W.cardSetUp(empty, { pin: '1234' });
    empty.tap();
    await T.W.cardSetLimit(empty, { sats: 0 });
    const full = newCard(T);
    await T.W.cardSetUp(full, { pin: '1234' });
    full.tap();
    await T.W.cardAdd(full, { sats: 300, owner: true });
    const keep = { pin: empty.state.pin, owner: empty.state.owner, key: empty.state.record.timeKey, limit: empty.state.record.limit };
    await T.W.connect(MINT2, null, null, { remember: false });
    await T.W.claim((await T.W.invoice(4000, '')).hash);
    await app.refreshBalance();

    // holding something: the words that tell it to be withdrawn first, and nothing to press but CLOSE
    T.nfc = full;
    app.fcRead(true);
    await until('the card to be read', () => app.state.fc && app.state.fc.key === full.key && app.state.fc.check !== 'asking');
    app.fcAdd();
    ok(card(app) && card(app).all === 'A DIFFERENT MINT | You need to withdraw all funds on the card before you can switch mints. | CLOSE',
       'a card holding money at another mint: ADD FUNDS says to withdraw it all first, in those words, and offers only CLOSE', card(app) && card(app).all);
    card(app).press('CLOSE');
    ok(!card(app) && app.state.screen === 'flashcard', 'CLOSE leaves the card’s screen as it was');

    // empty, on a phone that is not its owner: told, plainly, that the owner’s phone must do it
    T.nfc = empty;
    app.fcRead(true);
    await until('the empty card to be read', () => app.state.fc && app.state.fc.key === empty.key && app.state.fc.check !== 'asking');
    ok(app.state.fc.count === 0 && app.state.fc.ownedHere === true, 'the empty card is read as this phone’s own');
    const mine = app.state.fc;
    app.state.fc = Object.assign({}, mine, { ownedHere: false });
    app.fcAdd();
    ok(card(app) && card(app).title === 'A DIFFERENT MINT' && !card(app).has('SWITCH TO N.TEST') && /Only the phone that set the card up can switch it to another mint/.test(card(app).reason)
       && card(app).all.split(' | ').slice(-1)[0] === 'CLOSE', 'on a phone that is not its owner there is no switch, and the card says the owner’s phone must do it', card(app) && card(app).all);
    card(app).press('CLOSE');
    app.state.fc = mine;

    // empty, on its owner’s phone: SWITCH TO <mint>, straight to the amount, one tap that moves the card and writes the funds
    app.fcAdd();
    ok(card(app) && card(app).title === 'A DIFFERENT MINT' && card(app).has('SWITCH TO N.TEST') && card(app).has('CANCEL') && /holds nothing/.test(card(app).reason),
       'an empty card at another mint, on its owner’s phone, offers SWITCH TO and the mint’s name', card(app) && card(app).all);
    empty.sent.length = 0;
    card(app).press('SWITCH TO N.TEST');
    ok(app.state.screen === 'amount' && app.state.flow === 'cardAdd' && empty.sent.length === 0 && empty.state.record.mint === MINT,
       'it goes straight to SET AMOUNT of adding funds, and the card has not been touched yet', app.state.screen + ' ' + app.state.flow);
    keyIn(app, 500);
    await until('the funds to be on the card', () => card(app) && card(app).title === 'ON THE CARD');
    ok(empty.state.record.mint === MINT2 && empty.balance() === 500 && /The card is now at n\.test/.test(card(app).reason),
       'the funds are added at the new mint and the card says it is now there', card(app).reason);
    ok(empty.state.pin === keep.pin && empty.state.owner === keep.owner && empty.state.record.timeKey === keep.key && empty.state.record.limit === keep.limit,
       'its PIN, owner, limit and time key are as they were');
    ok(empty.sent.filter((a) => /^b032/.test(a)).length === 1 && !empty.sent.some((a) => /^b040/.test(a)),
       'the record was rewritten once, with the owner’s proof and no PIN, in the same tap that wrote the funds');
    card(app).press('DONE');
  }

  failed += until.failed;
  console.log('\n' + (failed ? failed + ' flashcard-screens check(s) failed' : 'all flashcard-screens checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
