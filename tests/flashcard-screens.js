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
const takeLimitSteps = (app, sats, which) => {
  // CHANGE LIMIT asks which of the card's two limits first
  if (card(app) && card(app).title === 'CHANGE LIMIT') card(app).press(which || 'DAILY LIMIT');
  card(app).press('CONTINUE');
  if (sats > 0) keyIn(app, sats); else app.fcLimitConfirm(0);
  app.fcLimitSpec().go();
};
const TAP_WARNING = 'A per tap limit is the most this card pays in one tap straight away. For every limit more than that, the card has to be held 3 seconds longer before it pays. Lift the card and the payment stops, with nothing taken.\n\n'
  + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.\n\n'
  + 'If you lose the seed phrase for this Foxy app, the PIN and the limits on this card can never be changed.\n\n'
  + 'Do you wish to continue?';
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
  // and it is not brought back: the same sheet asks for it again, and is dismissed
  const send1 = c.send;
  c.send = (x) => send1(x).then((r) => r, (err) => { H.nfc = null; throw err; });
  H.sheet.length = 0;
  holder.fcAmountNext();
  holder.price = 0;
  await until('the money to be said to be waiting', () => card(holder) && card(holder).title === 'TAP THE CARD AGAIN');
  c.send = send1;
  H.nfc = c;
  ok(card(holder).has('TAP CARD') && /The card was not read\. ₿500 is still waiting to go onto it\./.test(card(holder).reason) && c.balance() === 2000 && H.W.cardOwed().length === 1
     && H.sheet.some((x) => /^again: Hold the card here again for the rest$/.test(x)),
     'a card taken away before it was written to: the same sheet asked for it again, and with no card the 500 is kept for it and said', card(holder).reason);
  v = vals(holder);
  ok(v.fcNotes.length === 1 && /₿500 is waiting to go onto this card/.test(v.fcNotes[0].text), 'the screen carries a line for it', v.fcNotes[0] && v.fcNotes[0].text);
  c.tap();
  card(holder).press('TAP CARD');
  ok(!pad(holder), 'TAP CARD asks for no PIN: this phone owns the card');
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
      atMint = { kind: stage(R), look: up && up.getAttribute('data-look'), head: up && up.querySelector('h1') && up.querySelector('h1').textContent, line: up && up.querySelector('[data-stage-line]') && up.querySelector('[data-stage-line]').textContent,
                 button: up && up.querySelector('[data-stage-button]') && up.querySelector('[data-stage-button]').style.visibility, ended: R.ended,
                 amount: up && up.textContent.indexOf('\u20bf1,000') >= 0 };
    }
    return null;
  };
  // the payment's own PAYMENT RECEIVED (announcePayment, not in these parts): when it is let go, and why
  const released = [];
  till.releaseHeldConfirm = (why) => { released.push(why); till._holdConfirmUntil = 0; };
  // every card the till puts up, to see that none stood between the two taps
  const titles = [];
  const shown = till.blockedCard.bind(till);
  till.blockedCard = (kind, spec) => { titles.push((spec && spec.title) || kind); return shown(kind, spec); };
  let heldOnce = false;
  const heldFor = [];
  const hold0 = till.fcHoldConfirm.bind(till);
  till.fcHoldConfirm = (hash) => { heldOnce = true; heldFor.push(hash); hold0(hash); };
  // which of the payment's screens was up after each step of the tap, and what the sheet had last been told by then
  const looks = [];
  const look0 = till.fcLookStage.bind(till);
  till.fcLookStage = (step) => {
    look0(step);
    const up = R.window.document.getElementById('foxy-stage');
    const now = (up && up.getAttribute('data-look')) || '';
    if (looks[looks.length - 1] !== now) looks.push(now);
    if (now === 'confirm' && looks.confirmAt === undefined) looks.confirmAt = R.sheet.length;
  };
  pad(till).type('1234');
  /* Tap 1, SEND: the card signs the fewest pieces that cover it (two 512s for 1,000 here) and may go: the sheet stays up
   * and says so while the mint is asked. Then the same sheet asks for the card again, and its change (the 24 over) goes
   * on with no PIN. One sheet, nothing to press, and PAYMENT RECEIVED once the change is back. */
  await until('the payment to be made and its change back on the card', () => till.state.screen === 'home' && R.W.cardOwed().length === 0 && released.length > 0 && !stage(R));
  R.fate = null;
  await settle();
  const begins = R.sheet.filter((x) => /^begin:/.test(x));
  const ends = R.sheet.filter((x) => /^(end|error):/.test(x));
  const removeAt = R.sheet.indexOf('say: Verifying the payment. Keep this open for your change.');
  ok(begins.length === 1 && ends.length === 1 && ends[0] === 'end: Done. \u20bf24 of change is back on the card.' && removeAt >= 0
     && R.sheet.indexOf('again: Tap the card again for its change') > removeAt && R.sheet.indexOf('say: Keep the card there: asking the mint') < 0 && !pad(till),
     'one sheet for the whole payment: while the mint is asked it says to keep it open for the change (and nothing that reads as finished), asks for the card again, and ends saying the change is back',
     R.sheet.filter((x) => /^(begin|again|end|error):|Verifying the payment/.test(x)).join(' / '));
  ok(R.sheet.every((x) => !/Remove the card\. Verifying/.test(x)), 'the sheet no longer says “Remove the card” beside its own Cancel, which read as over and got it closed before the change');
  ok(atMint && atMint.kind === 'card' && atMint.look === 'verify' && atMint.head === 'Verifying card' && atMint.line === 'This may take a few seconds...' && atMint.button === 'hidden' && atMint.amount,
     'behind it, our own screen said VERIFYING CARD over the amount, with nothing to press', JSON.stringify(atMint));
  ok(looks.join(' > ') === 'tap > verify > confirm' && looks.confirmAt <= R.sheet.indexOf('again: Tap the card again for its change'),
     'the payment’s three screens in turn: TAP TO VERIFY while the card signs, VERIFYING CARD while the mint is asked, and TAP TO CONFIRM from the moment the card is asked for again, before it is found',
     looks.join(' > '));
  till.fcLookStage = look0;
  ok((await R.W.balanceSats()) === 1000 && titles.length === 0, 'the right PIN: 1,000 sats paid, with no card to press at any point', titles.join(', '));
  ok(heldOnce && released.join() === 'the change is back on the card',
     'PAYMENT RECEIVED was held while the change was taken, and went up the moment it was back on the card', JSON.stringify({ heldOnce, released }));
  till.fcHoldConfirm = hold0;
  till.blockedCard = shown;
  const paid = history(R).filter((e) => e.memo === 'card')[0];
  ok(paid && !till.seen[paid.hash] && R.W.tagsFor(paid.hash).to === 'card payment', 'its entry is left for the history pass to announce, as a payment');
  ok(heldFor.length >= 1 && heldFor.every((h) => h === paid.hash),
     'the hold names the payment it is for, from the moment the card has signed: its entry’s own name, so no other payment’s confirmation waits on it', JSON.stringify(heldFor));
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
  // the card is taken away once it has signed and not brought back: the sheet asks for it again for the change and reads nothing
  const send2 = c2.send;
  c2.send = (x) => send2(x).then((r) => { if (/^b020/.test(x)) R.nfc = null; return r; });
  /* Whether the till's own home screen could ever be seen between the payment and its change: from the payment being
   * made (the invoice put away) until the second tap is over, one of the payment's screens is up at every look. */
  let bare = 0, seenConfirm = false, sheets = 0;
  const watch = setInterval(() => {
    const up = R.window.document.getElementById('foxy-stage');
    const lookNow = (up && up.getAttribute('data-look')) || '';
    if (lookNow === 'confirm') seenConfirm = true;
    if (till.state.screen === 'home' && !up && !card(till)) bare += 1;
  }, 20);
  R.sheet.length = 0;
  released.length = 0;
  till.releaseHeldConfirm = (why) => { released.push(why); till._holdConfirmUntil = 0; };
  till.payByCard();
  pad(till).type('1234');
  await until('the change to be said to be still waiting', () => card(till) && card(till).title === 'TAP TO RECEIVE' && /not read/.test(card(till).reason));
  clearInterval(watch);
  sheets = R.sheet.filter((x) => /^begin:/.test(x)).length;
  ok(bare === 0 && seenConfirm && sheets === 2,
     'the sheet gone with the change still to take: TAP TO CONFIRM stays up through the pause and the second sheet, and the till’s home screen is never what is showing between the payment and its change',
     JSON.stringify({ bare, seenConfirm, sheets }));
  ok(released.length === 0, 'and PAYMENT RECEIVED is still held: the change is waiting, and the card says so', released.join());
  c2.send = send2;
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
  await until('the change to be back on the card', () => R.W.cardOwed().length === 0 && !stage(R));
  await settle();
  ok(released.join() === 'the change is back on the card', 'and with the change back on the card, the payment’s PAYMENT RECEIVED goes up', released.join());
  /* A tap that wrote the change and still ended as if no card had been read (the sheet closed as the last piece went on):
   * nothing is owed, so there is nothing to say, and the confirmation is let go. It was held for good. */
  released.length = 0;
  till.fcHoldConfirm('card-x');
  till.fcStillWaiting({});
  ok(released.join() === 'nothing is waiting for the card' && !card(till), 'a change tap that ended as cancelled with nothing left to write lets the confirmation go, and puts up no card', released.join());
  ok(c2.balance() === 824 && !card(till) && till.toasts.indexOf('\u20bf824 of change is back on the card.') >= 0,
     'and the right card\u2019s tap puts it back, said in passing with no card to press, and without the till being shown what the card holds', till.toasts.slice(-2).join(' | '));
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
    // the payment's screens, in the order they went up, and what TAP AGAIN said and when
    const seen = [];
    const drawLook = till2.fcLookStage.bind(till2);
    const watchLooks = (list) => (step) => {
      drawLook(step);
      const up = RT.window.document.getElementById('foxy-stage');
      const now = (up && up.getAttribute('data-look')) || '';
      if (list[list.length - 1] !== now) list.push(now);
      if (/Again$/.test(now) && !list.words) {
        list.words = up.querySelector('h1').textContent + ' / ' + up.querySelector('[data-stage-line]').textContent;
        list.asked = RT.sheet.filter((x) => /^again: Hold/.test(x)).length;
      }
    };
    till2.fcLookStage = watchLooks(seen);
    till2.payByCard();
    pad(till2).type('1234');
    await until('the payment to be finished by the next tap', () => till2.state.screen === 'home' && !RT.W.cardHeldPayment(c3.key) && RT.W.cardTaken().length === 0 && !stage(R));
    await settle();
    ok(seen.join(' > ') === 'tap > tapAgain > verify' && seen.words === 'Tap again / The last tap didn\u2019t finish...' && seen.asked === 0,
       'the card lost part way through signing: the screen says TAP AGAIN, on TAP TO VERIFY’s ground, from the moment it is lost (before the sheet has asked for it again) until it has signed',
       seen.join(' > ') + '; ' + seen.words);
    const got = (await RT.W.balanceSats()) - rb;
    const begins = RT.sheet.filter((x) => /^begin:/.test(x));
    const agains = RT.sheet.filter((x) => /^again:/.test(x));
    ok(got === 1536 && c3.balance() === 0 && begins.length === 1 && agains.join() === 'again: Hold the card here again to finish paying' && !pad(till2),
       'a payment the card leaves part way through: the same sheet asks for the card again, with no PIN, and the next tap signs the rest and pays', RT.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + '; ' + got + ' received');
    ok(titles.length === 0 && RT.W.cardOwed().filter((r) => r.card === c3.key).length === 0, 'with no card to press, and nothing to put back on the card', titles.join(', '));
    till2.blockedCard = shown;

    /* The card lost while its change was being written: what went on stays on, the same sheet asks again, and the
     * screen says TAP AGAIN on TAP TO CONFIRM's ground until the rest is on. */
    {
      const HC = await funded({ sharedMint: H.mint, words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, 2000);
      const c5 = newCard(HC);
      await HC.W.cardSetUp(c5, { pin: '1234' });
      await binaryLoad(HC, c5, 1024);         // one piece: 200 is paid with it, and 824 comes back
      till2.state.screen = 'confirm';
      till2.asking = 200;
      RT.nfc = c5;
      let taps = 0;
      const tap5 = c5.tap;
      // its second tap (the change) leaves before the second piece is written; the third stays
      c5.tap = () => { tap5(); taps += 1; if (taps === 2) c5.leaveBefore('30', 2); };
      const seen5 = [];
      till2.fcLookStage = watchLooks(seen5);
      const sentBefore = c5.sent.length;
      RT.sheet.length = 0;
      till2.payByCard();
      pad(till2).type('1234');
      await until('the change to be back on the card after two tries', () => till2.state.screen === 'home' && RT.W.cardOwed().filter((r) => r.card === c5.key).length === 0 && !stage(RT) && c5.balance() === 824);
      await settle();
      c5.tap = tap5;
      const lines5 = RT.sheet.filter((x) => /^(begin|again|end|error):/.test(x));
      ok(seen5.join(' > ') === 'tap > verify > confirm > confirmAgain' && seen5.words === 'Tap again / The last tap didn\u2019t finish...',
         'the card lost part way through taking its change: TAP AGAIN, on TAP TO CONFIRM’s ground, until the rest is on', seen5.join(' > ') + '; ' + seen5.words);
      ok(lines5.filter((x) => /^begin:/.test(x)).length === 1 && lines5.indexOf('again: Hold the card here again for its change') > lines5.indexOf('again: Tap the card again for its change')
         && lines5[lines5.length - 1] === 'end: Done. \u20bf824 of change is back on the card.' && taps === 3,
         'in the one sheet: asked for its change, asked again when it left, and ended with the change back', lines5.join(' / '));
      // the card allows one tap after a payment to load with no PIN, and the tap it left used that up: the rest needs its PIN
      const pins5 = c5.sent.slice(sentBefore).filter((a) => /^b040/.test(a)).length;
      ok(!pad(till2) && pins5 === 2,
         'the rest went on with the PIN typed for this payment, given to the card again (once to pay, once for the rest), and nobody was asked for it twice', String(pins5));
    }
    till2.fcLookStage = drawLook;

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
    // and when it leaves it is not brought back: the sheet looks for it again and is dismissed
    const send4 = c4.send;
    c4.send = (x) => send4(x).then((r) => r, (err) => { RT.nfc = null; throw err; });
    till2.payByCard();
    pad(till2).type('1234');
    await until('NOT PAID YET to be said', () => card(till2) && card(till2).title === 'NOT PAID YET');
    c4.send = send4;
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
  ok(card(holder) && card(holder).all === ['CHANGE LIMIT', 'This card has two limits.\n\nPER TAP: the most it will pay in one tap straight away. More than that and it has to be held longer.\n\nDAILY: the most it will spend in one day.',
                                           'PER TAP LIMIT', 'DAILY LIMIT', 'CANCEL'].join(' | '),
     'CHANGE LIMIT asks which of the card’s two limits: PER TAP LIMIT, DAILY LIMIT, or CANCEL', card(holder) && card(holder).all);
  card(holder).press('CANCEL');
  ok(!card(holder) && !pad(holder) && holder.state.screen === 'flashcard', 'CANCEL there changes nothing');
  holder.fcSetLimit();
  card(holder).press('DAILY LIMIT');
  ok(card(holder) && card(holder).title === 'SET DAILY LIMIT' && card(holder).all === ['SET DAILY LIMIT', LIMIT_WARNING, 'CONTINUE', 'CANCEL'].join(' | '),
     'DAILY LIMIT opens its warning, with CONTINUE and CANCEL', card(holder) && card(holder).all);
  card(holder).press('CANCEL');
  ok(!card(holder) && holder.state.screen === 'flashcard' && c.state.record.limit === 0 && holder._fcLimitDone === null, 'and CANCEL there changes nothing');
  holder.fcSetLimit();
  card(holder).press('DAILY LIMIT');
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
  card(holder).press('DAILY LIMIT');
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

  /* ---- the limit on one tap ----------------------------------------------------------
   * The other choice under CHANGE LIMIT, asked for by the same three steps in its own words. */
  holder.fcSetLimit();
  card(holder).press('PER TAP LIMIT');
  ok(card(holder) && card(holder).all === ['SET PER TAP LIMIT', TAP_WARNING, 'CONTINUE', 'CANCEL'].join(' | '),
     'PER TAP LIMIT opens a warning of its own, like the daily limit’s: what it is, who can change it, CONTINUE and CANCEL', card(holder) && card(holder).all);
  card(holder).press('CONTINUE');
  ok(holder.state.screen === 'amount' && holder.state.flow === 'cardLimit' && holder.fcLimitQuestion() === 'What is the most this card should pay in one tap straight away?',
     'CONTINUE asks for the amount on the same keypad, in its own words', holder.fcLimitQuestion());
  keyIn(holder, 300);
  {
    const cf = holder.fcLimitSpec();
    ok(cf.amountLabel === 'YOU ARE APPLYING A PER TAP LIMIT OF:' && cf.amount === '\u20bf 300' && cf.cta === 'CONFIRM' && cf.secondary.label === 'CANCEL'
       && cf.warn === 'This card will pay up to this straight away. For every limit more, it has to be held 3 seconds longer. Only this phone, or a phone restored from its seed phrase, can change or remove it.',
       'the confirmation says the amount and what it means', JSON.stringify([cf.amountLabel, cf.amount]));
  }
  c.tap();
  c.sent.length = 0;
  holder.fcLimitSpec().go();
  await until('the limit on one tap to be set', () => holder.state.fc.tap && holder.state.fc.tap.limit === 300);
  ok(c.state.tapLimit === 300 && c.state.record.limit === 700 && c.state.spent === 0 && !c.sent.some((a) => /^b040/.test(a)) && holder.toasts.indexOf('Per tap limit set.') >= 0,
     'the card has its limit on one tap, the daily limit is as it was, and no PIN was sent', JSON.stringify({ tap: c.state.tapLimit, day: c.state.record.limit }));
  ok(vals(holder).fcLimitLine === 'PER TAP \u20bf300 \u00b7 DAILY \u20bf700', 'and its screen says both', vals(holder).fcLimitLine);
  // a till asked for more than one tap may pay: refused before the PIN is sent, with what to do
  till.state.screen = 'confirm';
  till.asking = 400;
  R.nfc = c;
  c.tap();
  c.sent.length = 0;
  till.payByCard();
  pad(till).type('1234');
  await until('the tap’s limit to refuse', () => card(till) && card(till).title === 'OVER THE CARD\u2019S PER TAP LIMIT');
  ok(card(till).reason === 'The card pays at most \u20bf300 in one tap, and this payment is more than that. Charge it in parts, a tap for each. Nothing was taken.'
     && !c.sent.some((a) => /^b040/.test(a)) && !c.sent.some((a) => /^b020/.test(a)) && till.state.screen === 'confirm',
     'a payment over the limit on one tap is refused before the PIN is sent or anything signed, and says to charge it in parts', card(till).reason);
  card(till).press('CLOSE');
  /* ---- the card's own log, on its holder's screen ------------------------------------- */
  // one reading of the card by its holder's phone, waited for to its end: the log on the screen is a new one each time
  const readLog = async (what) => {
    const was = holder.state.fc && holder.state.fc.log;
    c.tap();
    holder.fcRead();
    await until(what, () => holder.state.fc && holder.state.fc.log && holder.state.fc.log !== was && !stage(H));
    await settle();
  };
  await readLog('the card’s log to be read');
  {
    const note = vals(holder).fcNotes.filter((x) => /^Last tap: /.test(x.text))[0];
    ok(note && /^Last tap: \u20bf[\d,]+, .*\. Press here for this card\u2019s own log\.$/.test(note.text), 'the card’s screen says its last tap, from the card’s own log, in a line that opens the rest', note && note.text);
    note.tap();
    ok(card(holder) && card(holder).title === 'THIS CARD\u2019S OWN LOG' && /Kept by the card itself\. No phone or terminal can change it\./.test(card(holder).reason)
       && /In all: \d+ taps?, \u20bf[\d,]+ signed for, 0 refused\.$/.test(card(holder).reason) && card(holder).has('CLOSE'),
       'the line opens THIS CARD’S OWN LOG: its last taps, and its totals', card(holder).reason.split('\n').slice(-1)[0]);
    card(holder).press('CLOSE');
  }
  // a terminal that has the PIN asks three times for more than the limit on one tap: the card refuses, writes it down, and marks the tap
  {
    // (this card's pieces are all under its limit of 300 by now, so for this the card is given a limit one of them is over)
    c.state.tapLimit = 100;
    const big = c.state.slots.findIndex((x) => x.status === 1 && parseInt(x.data.substr(16, 8), 16) > 100);
    const tampersBefore = c.state.log.tampers;
    c.tap();
    const said = [(await c.send('00a404000af0464f5859434152440100')).slice(-4), (await c.send('b04000000431323334')).slice(-4)];
    for (let i = 0; i < 3; i++) said.push((await c.send('b020' + ('0' + big.toString(16)).slice(-2) + '0040')).slice(-4));
    ok(big >= 0 && said.join(' ') === '9000 9000 6a95 6a95 6a95' && c.state.log.tampers === tampersBefore + 1, 'three requests over the limit are refused by the card, which marks the tap', said.join(' '));
    await readLog('the mark to be read');
    ok(holder.state.fc.log.tampers === tampersBefore + 1, 'the holder’s phone reads the mark from the card');
    const note = vals(holder).fcNotes.filter((x) => /^TAMPER: /.test(x.text))[0];
    ok(note && note.text === 'TAMPER: a terminal tried 3 times to take more than this card\u2019s limit. Press here.', 'and its holder’s screen says TAMPER, with how many times it was tried', note && note.text);
    note.tap();
    ok(card(holder) && card(holder).title === 'TAMPER ON THIS CARD' && /three times or more within ten seconds/.test(card(holder).reason) && /\u20bf0, 3 refused \u2014 TAMPER/.test(card(holder).reason)
       && /Since this phone last looked: 1 tap, \u20bf0 signed for, 3 refused\./.test(card(holder).reason),
       'which opens TAMPER ON THIS CARD: the tap of three refusals and nothing signed, marked, and what is new since this phone last looked',
       card(holder).reason.split('\n').filter((l) => /TAMPER|Since/.test(l)).join(' / '));
    card(holder).press('CLOSE');
    c.state.tapLimit = 300;
  }

  // and it is taken off again, the same way, with NO LIMIT
  holder.fcSetLimit();
  card(holder).press('PER TAP LIMIT');
  card(holder).press('CONTINUE');
  holder.fcLimitConfirm(0);
  ok(holder.fcLimitSpec().amountLabel === 'YOU ARE REMOVING THIS CARD\u2019S PER TAP LIMIT.' && holder.fcLimitSpec().warn === 'One tap will be able to pay as much as the card holds straight away, up to its daily limit.',
     'NO LIMIT under the keypad removes it, and the confirmation says what that means', holder.fcLimitSpec().warn);
  c.tap();
  holder.fcLimitSpec().go();
  await until('the limit on one tap to be gone', () => holder.state.fc.tap && holder.state.fc.tap.limit === 0 && c.state.tapLimit === 0);
  ok(holder.toasts.indexOf('Per tap limit removed.') >= 0 && c.state.record.limit === 700, 'removed, and the daily limit still as it was', vals(holder).fcLimitLine);
  ok(vals(holder).fcLimitLine === 'DAILY LIMIT \u20bf700', 'and the screen is back to the one limit', vals(holder).fcLimitLine);

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
  card(holder).press('DAILY LIMIT');
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
    ok(begins.length === 1 && H.sheet.filter((x) => /^again:/.test(x)).join() === 'again: Hold the card here again for the rest' && !pad(holder) && titlesW.join() === 'IN YOUR WALLET',
       'a withdrawal cut short keeps what came off, and the same sheet asks for the card again for the rest, with no PIN and no card to press', H.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + ' | ' + titlesW.join(', '));
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
    // and when it leaves it is not brought back: the sheet looks for it again and is dismissed
    const sendW = c.send;
    c.send = (x) => sendW(x).then((r) => r, (err) => { H.nfc = null; throw err; });
    H.sheet.length = 0;
    holder.fcWithdrawPin(0);
    pad(holder).type('4321');
    await until('the rest to be asked for with a card', () => card(holder) && card(holder).title === 'TAP THE CARD AGAIN');
    c.send = sendW;
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
    ok(beginsL.length === 1 && H.sheet.filter((x) => /^again:/.test(x)).join() === 'again: Hold the card here again for the rest' && c.balance() === onBefore + 1000 && H.W.cardOwed().length === 0,
       'a load cut short after some pieces went on: the same sheet asks for the card again, and the rest goes on', H.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + ' | ' + c.balance());
    card(holder).press('DONE');
    // and taken off again, so what comes after has the phone and the card as they were
    c.tap();
    await H.W.cardWithdraw(c, { pin: '4321' });
    await settle();
    holder.setState({ screen: 'home', stack: [], fc: null });
  }

  // a payment taken up again that the card could not finish: why, with any piece lost in the air, and the tap to put back what it signed
  till.fcShortHeld({ balance: 1, still: 5, torn: 4, letGo: { sats: 72, made: true } }, 77);
  ok(card(till).title === 'NOT PAID' && card(till).reason === 'The card holds ₿1, and ₿5 of ₿77 was still to pay. ₿4 it signed as it was taken away never reached this phone, and cannot be spent. What it signed for this payment goes back on it: tap it to put it back.'
     && card(till).has('TAP CARD') && card(till).has('LATER'), 'a payment the card could not finish says why, names a piece lost in the air, and offers the tap to put back what it signed', card(till).all);
  card(till).press('LATER');

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
    await settle();
    const signedFor = f.state.spent;     // the fewest pieces that cover 300, signed whole
    /* The sheet was still up (kept for the change): the same sheet asks for the card again and puts what it signed back,
     * with no PIN, and ends saying so; the screen then says the payment failed and the money is back. Nothing to press. */
    const putAt = R.sheet.indexOf('again: The payment did not go through. Tap the card to put it back');
    ok(signedFor >= 300 && putAt >= 0 && R.sheet[R.sheet.length - 1] === 'end: The payment did not go through. ₿' + signedFor.toLocaleString('en-US') + ' is back on the card.'
       && !R.sheet.some((x) => /^error:/.test(x)) && R.sheet.filter((x) => /^begin:/.test(x)).length === 1,
       'a payment the mint refuses after the card signed: the same sheet asks for the card again, puts it back, and ends saying so, not in red',
       R.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / '));
    ok(card(till).reason === 'The mint refused it. ₿' + signedFor.toLocaleString('en-US') + ' is back on the card.' && !card(till).has('TAP CARD')
       && /daily limit stays used/.test(card(till).all) && (await R.W.balanceSats()) === rb && till.state.screen === 'confirm' && !stage(R),
       'and the screen says it failed and that the money is back, and that the day stays charged; nothing was paid, and the invoice is still up', card(till).all);
    ok(f.balance() === 1000 && R.W.cardOwed().length === 0 && f.state.spent === signedFor && !pad(till),
       'the card holds what it did, with no PIN asked, and its day is as charged', f.balance() + ' / ' + f.state.spent);
    card(till).press('CLOSE');

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
    const behind = () => { const up = R.window.document.getElementById('foxy-stage'); return up ? up.getAttribute('data-look') + ': ' + up.querySelector('h1').textContent + ' / ' + up.querySelector('[data-stage-line]').textContent : ''; };
    ok(lines.indexOf('Signing piece 1 of 4') >= 0 && behind() === 'tap: Tap to verify / Tap for a few seconds...',
       'the sheet says the piece being signed; the screen behind it is TAP TO VERIFY and says the one thing to do', behind());
    // what the phone’s own link says, pushed to the page as it happens
    R.W._card({ stage: 'connected', text: 'Scanning. Hold still.' });
    ok(lines.indexOf('Scanning. Hold still.') >= 0 && behind() === 'tap: Tap to verify / Tap for a few seconds...', 'and what the phone’s link pushes (the card found) does not change it either', behind());
    R.W._card({ stage: 'say', text: 'Signing piece 1 of 4' });
    let_go();
    await until('the payment to be made', () => till.state.screen === 'home');
    await settle();
    ok(['Signing piece 1 of 4', 'Signing piece 2 of 4', 'Signing piece 3 of 4', 'Signing piece 4 of 4'].every((t) => R.sheet.indexOf('say: ' + t) >= 0)
       && R.sheet[R.sheet.length - 1] === 'end:  ' && d.balance() === 40 && !stage(R),
       'each piece was said on the sheet in turn, the sheet closed with no words once the card had signed (it was paid exactly: nothing to keep it open for), and the screen is down', R.sheet.slice(-3).join(' / '));
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

  /* ---- a held PAYMENT RECEIVED is one payment's, and no other's ---------------------------
   *
   * The app's own announcePayment (12-receive.js), lifted out and run over these parts. One payment's confirmation was
   * held, never let go, and raised with its amount when the NEXT payment's change went back, which got none of its own. */
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '12-receive.js'), 'utf8');
    const from = src.indexOf('  announcePayment(ev) {');
    const to = src.indexOf('\n  }\n', from) + 5;
    const lifted = new Function('window', 'document', 'CONFIRM_SCREENS', 'return {' + src.slice(from, to) + '}')(
      { FoxyWallet: { notify: () => {} } }, { visibilityState: 'visible' }, []);
    const g = appOn(R, { screen: 'home' });
    g.announcePayment = lifted.announcePayment;
    const up = () => (g.state.screen === 'paid' ? 'paid ' + g.state.amount : g.state.screen);
    const home = () => { g.state.screen = 'home'; g.state.stack = []; };
    ok(from > 0 && to > from && typeof g.announcePayment === 'function' && typeof g.releaseHeldConfirm === 'function', 'the app’s own announcePayment and releaseHeldConfirm are what is run');

    g.fcHoldConfirm('card-a');
    g.announcePayment({ hash: 'card-b', dir: 'in', sats: 3069 });
    ok(up() === 'paid 3069' && !g._heldConfirm, 'a hold for one card payment does not hold another payment’s confirmation: that one goes up at once', up());
    home();
    g.announcePayment({ hash: 'card-a', dir: 'in', sats: 15664 });
    ok(up() === 'home' && g._heldConfirm && g._heldConfirm.hash === 'card-a', 'its own is held, with its change still to take', up());
    g.fcReleaseConfirm('the change is back on the card');
    ok(up() === 'paid 15664' && !g._heldConfirm && !g._holdConfirmFor && !(g._holdConfirmUntil > 0), 'and goes up when it is let go, with nothing left held', up());

    // one left held (its change tap never ended in anything the screen heard of), and the next payment begun
    home();
    g.fcHoldConfirm('card-a');
    g.announcePayment({ hash: 'card-a', dir: 'in', sats: 15664 });
    g.fcDropConfirm();
    ok(up() === 'home' && !g._heldConfirm && !(g._holdConfirmUntil > 0), 'a confirmation still held when the next payment begins is dropped, not raised: it is in HISTORY', up());
    g.fcHoldConfirm('card-c');
    g.fcReleaseConfirm('the change is back on the card');
    ok(up() === 'home', 'so the next payment’s change going back raises nothing of the last one’s', up());
    g.announcePayment({ hash: 'card-c', dir: 'in', sats: 3069 });
    ok(up() === 'paid 3069', 'and its own confirmation, announced after, is the one that shows: the right payment, the right amount', up());

    // the same from the payment's own flow: a new payment drops what is left, a resumed one does not
    home();
    g.fcHoldConfirm('card-a');
    g.announcePayment({ hash: 'card-a', dir: 'in', sats: 15664 });
    g.fcTap = () => new Promise(() => {});
    g.fcPayRun(100, '1234', false, true);
    ok(g._heldConfirm && g._heldConfirm.hash === 'card-a', 'a payment taken up again leaves the hold as it is');
    g.fcPayRun(100, '1234', false, false);
    ok(!g._heldConfirm && !(g._holdConfirmUntil > 0), 'a new payment starts with nothing held');

    // a scanned payment's change (changeMaking) names no payment, and holds whichever confirmation comes, as it did
    home();
    g.changeMaking({});
    g.announcePayment({ hash: 'req-z', dir: 'in', sats: 50 });
    ok(up() === 'home' && g._heldConfirm && g._heldConfirm.hash === 'req-z', 'a scanned payment’s hold, which names none, still holds the one that comes');
    g.releaseHeldConfirm('the change card was dismissed');
    ok(up() === 'paid 50', 'and lets it go as before', up());
    clearTimeout(g._holdConfirmT);
    ok(g.FC_HOLD_MS === 150000, 'the longest a confirmation waits for a change tap is two and a half minutes');
  }

  failed += until.failed;
  console.log('\n' + (failed ? failed + ' flashcard-screens check(s) failed' : 'all flashcard-screens checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
