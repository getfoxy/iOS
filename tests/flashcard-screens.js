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
const { funded, newCard, history, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const { appOn, until, pad, card, stage, vals, settle, keyIn } = require('./flashcard-ui-kit');

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
  ok(H.sheet.join(' / ').indexOf('begin: Hold the card to the top of the phone') >= 0 && H.sheet.indexOf('say: Reading the card') >= 0 && H.sheet.indexOf('end: Done') >= 0,
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
  c.tap();
  pad(holder).type('1234');
  ok(!pad(holder) && !card(holder), 'cards are cash for now: nothing is asked about what happens if one is lost');
  await until('the card to be set up', () => card(holder) && card(holder).title === 'THE CARD IS READY');
  ok(/It is cash/.test(card(holder).reason) && /forget its PIN, or type it wrong three times/.test(card(holder).all),
     'and what cash means is said where the card becomes one', card(holder).all);
  v = vals(holder);
  ok(v.fcUsable && !v.fcNew && v.fcCheck === '' && !holder.state.fc.mine && !holder.state.fc.recoverable && H.W.cardsList().length === 0,
     'one tap later it has a PIN and is cash: no key of this phone’s is on it, and this phone keeps no list of it');
  ok(v.fcPill === true && v.fcPillMint === 'm.test' && v.fcPillLetter === 'M' && v.fcBalance === '₿ 0' && v.fcFields === undefined,
     'and the screen says its mint and what it holds in home’s own pill, and nothing under it', v.fcPillMint + ' | ' + v.fcBalance);
  ok(v.fcLinks.map((k) => k.label).join() === 'CHANGE PIN,SET LIMIT' && v.fcHistoryVis === 'visible' && typeof v.fcAdd === 'function' && typeof v.fcWithdraw === 'function',
     'with ADD FUNDS and WITHDRAW, CHANGE PIN and SET LIMIT under them, and its history at the top');
  ok(v.fcDesign === 'FL1' && holder.fcDesignOf({ design: 'zz9' }) === 'FL1' && holder.fcDesignOf({ design: 'fl1' }) === 'FL1' && Object.keys(holder.FC_DESIGNS).every((k) => /^[A-Z0-9]{3}$/.test(k)),
     'the card is drawn in the design FL1, as is one that names a design this build cannot draw; every design has a code of three characters', v.fcDesign);
  ok(v.fcVerified === 'Verified Just Now' && v.fcVerifiedShown === true, 'and under its title, that it is verified: a card with nothing on it has nothing a mint could dispute', v.fcVerified);

  /* ---- add funds -------------------------------------------------------------- */
  c.tap();
  card(holder).press('ADD FUNDS');
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.state.flow === 'cardAdd' && holder.state.unit === 'SATS' && holder.state.stack.slice(-1)[0] === 'flashcard',
     'ADD FUNDS asks how much on the SET AMOUNT screen (in sats here: this phone has no price to say dollars at)');
  keyIn(holder, 99999);
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.toasts.indexOf('You have ₿6,000.') >= 0, 'more than the phone holds goes no further');
  keyIn(holder, 2000);
  ok(pad(holder).title === 'CARD PIN' && /add ₿2,000/.test(pad(holder).sub) && pad(holder).cta === 'ADD ₿2,000 TO CARD' && holder.state.screen === 'amount',
     'then the card\u2019s PIN, on a pad whose button says what it will do', pad(holder).cta);
  pad(holder).back();
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.state.amount === '2000', 'back from the PIN is back to the amount, still typed');
  holder.fcAmountNext();
  pad(holder).type('1234');
  ok(holder.state.screen === 'flashcard', 'the PIN given, the keypad is left for the card\u2019s own screen');
  await until('the money to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(c.balance() === 2000 && /₿2,000 went onto the card. It now holds ₿2,000\./.test(card(holder).reason) && holder.state.fc.balance === 2000,
     'and 2,000 sats are on it, and the screen says so', card(holder).reason);
  const added = history(H).filter((e) => e.memo === 'to card')[0];
  ok(added && holder.seen[added.hash] === true && H.W.cardOwed().length === 0, 'its entry is one the app will not announce a second time, and nothing is left owed');
  card(holder).press('DONE');
  await until('the mint’s word on the card', () => holder.state.fc.check === 'ok');
  ok(vals(holder).fcCheck === 'Checked with the mint', 'the mint is asked about what the card says it holds');

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

  // a wrong PIN: the pieces are made and wait, and the screen says so wherever it is opened
  c.tap();
  // with a price, the keypad opens in dollars and the button says dollars
  holder.price = 100000;
  holder.fcAdd();
  ok(holder.state.unit === 'USD', 'where the phone has a price, the amount is asked in dollars first');
  holder.state.amount = '0.50';
  holder.fcAmountNext();
  ok(pad(holder).cta === 'ADD $0.50 TO CARD' && /add \$0\.50 \(₿500\)/.test(pad(holder).sub), 'and half a dollar typed is 500 sats asked for', pad(holder).cta + ' | ' + pad(holder).sub);
  holder.price = 0;
  pad(holder).type('9999');
  await until('the wrong PIN to be said', () => card(holder) && card(holder).title === 'WRONG PIN');
  ok(card(holder).reason === '2 tries left.' && card(holder).has('TRY AGAIN') && c.balance() === 2000 && H.W.cardOwed().length === 1,
     'a wrong PIN at the tap: said with the tries left, and the 500 is kept for the card', card(holder).reason);
  v = vals(holder);
  ok(v.fcNotes.length === 1 && /₿500 is waiting to go onto this card/.test(v.fcNotes[0].text), 'the screen carries a line for it', v.fcNotes[0] && v.fcNotes[0].text);
  c.tap();
  card(holder).press('TRY AGAIN');
  ok(pad(holder).title === 'CARD PIN' && /put ₿500 on the card/.test(pad(holder).sub), 'TRY AGAIN asks for the PIN, not for the amount again', pad(holder).sub);
  pad(holder).type('1234');
  await until('the 500 to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(c.balance() === 2500 && H.W.cardOwed().length === 0 && vals(holder).fcNotes.length === 0, 'and the right PIN finishes it: 2,500 on the card, nothing waiting');
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
  pad(till).type('1234');
  await until('the payment to be made', () => till.state.screen === 'home');
  await settle();
  ok((await R.W.balanceSats()) === 1000 && !card(till) && !stage(R), 'the right PIN: 1,000 sats paid, the receive screen closed, and no card left over it');
  ok(R.sheet.indexOf('say: Keep the card there: asking the mint') >= 0 && R.sheet.indexOf('say: Putting change back on the card') >= 0,
     'and the sheet said to keep the card there while the mint was asked and the change went back');
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

  // the card leaves before its change is written: paid, and the change waits for it.
  // A card of one piece, so there is change to give: set up as cash, with the wallet itself
  const c2 = newCard(H);
  await H.W.cardSetUp(c2, { pin: '1234' });
  c2.tap();
  await H.W.cardAdd(c2, { sats: 1024, pin: '1234' });
  till.state.screen = 'confirm';
  till.asking = 200;
  R.nfc = c2;
  // armed at the tap itself: the phone's session begins by finding the card afresh
  const tap0 = c2.tap;
  c2.tap = () => { tap0(); c2.leaveBefore('30', 1); c2.tap = tap0; };
  till.payByCard();
  pad(till).type('1234');
  await until('the change to be left waiting', () => card(till) && card(till).title === 'TAP THE CARD AGAIN');
  const owed = R.W.cardOwed().reduce((n, r) => n + r.sats, 0);
  ok((await R.W.balanceSats()) === 1200 && owed === 824 && c2.balance() === 0 && /\u20bf824 of change is waiting to go back on the card/.test(card(till).reason),
     'pulled away before its change was written: the payment stands and the change waits', card(till).reason);
  R.nfc = c;
  c.tap();
  card(till).press('TAP CARD');
  ok(/put \u20bf824 on the card/.test(pad(till).sub), 'TAP CARD asks its PIN again', pad(till).sub);
  pad(till).type('1234');
  await until('the wrong card to be noticed', () => card(till) && card(till).title === 'A DIFFERENT CARD');
  ok(R.W.cardOwed().length === 1 && /\u20bf824 is waiting for CARD/.test(card(till).reason), 'another card tapped instead gets none of it, and the till says which card it is for', card(till).reason);
  card(till).press('CLOSE');
  R.nfc = c2;
  c2.tap();
  till.fcWriteAsk({});
  pad(till).type('1234');
  await until('the change to be back on the card', () => card(till) && card(till).title === 'ON THE CARD');
  ok(c2.balance() === 824 && R.W.cardOwed().length === 0 && card(till).reason === '\u20bf824 went onto the card.',
     'and the right card\u2019s second tap puts it back, without the till being shown what the card holds', card(till).reason);
  card(till).press('DONE');
  ok(till.state.fc === null, 'nor is a payer\u2019s card left on show under the till\u2019s menu');

  /* ---- its limit, its PIN ---------------------------------------------------- */
  H.nfc = c;
  c.tap();
  holder.fcRead();
  await until('the card to be read again', () => holder.state.fc && holder.state.fc.balance === c.balance());
  holder.fcSetLimit();
  ok(holder.state.screen === 'amount' && holder.state.flow === 'cardLimit', 'SET LIMIT asks for an amount on the same keypad');
  keyIn(holder, 700);
  ok(pad(holder).cta === 'SET LIMIT', 'and its PIN pad says so');
  c.tap();
  pad(holder).type('1234');
  await until('the limit to be set', () => holder.state.fc.limit === 700);
  ok(holder.state.fc.limit === 700, 'and the card has its limit', String(holder.state.fc.limit));
  till.state.screen = 'confirm';
  till.asking = 900;
  R.nfc = c;
  c.tap();
  till.payByCard();
  pad(till).type('1234');
  await until('the limit to refuse', () => card(till) && card(till).title === 'OVER THE CARD’S LIMIT');
  ok(/Nothing was taken/.test(card(till).reason) && (await R.W.balanceSats()) === 1200, 'a till asking for more than the limit is refused, with nothing signed', card(till).reason);
  card(till).press('CLOSE');

  holder.fcChangePin();
  pad(holder).type('1234');
  pad(holder).type('4321');
  c.tap();
  pad(holder).type('4321');
  await until('the PIN to be changed', () => card(holder) && card(holder).title === 'PIN CHANGED');
  card(holder).press('DONE');

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
  ok(!pad(holder) && card(holder) && card(holder).title === 'OVER THE CARD\u2019S LIMIT' && card(holder).has('SET LIMIT'),
     'a card holding more than its limit will not be emptied in one go, and the screen says so before the PIN', card(holder) && card(holder).reason);
  card(holder).press('SET LIMIT');
  ok(holder.state.screen === 'amount' && holder.state.flow === 'cardLimit' && holder.state.stack.filter((x) => x === 'amount').length === 0,
     'SET LIMIT from there is one keypad, not one on top of another');
  holder.fcLimitPin(0);               // NO LIMIT
  ok(pad(holder).cta === 'REMOVE LIMIT', 'NO LIMIT asks the PIN to take it off');
  c.tap();
  pad(holder).type('4321');
  await until('the limit to be off', () => holder.state.fc.limit === 0);
  ok(holder.toasts.indexOf('No limit.') >= 0 && holder.state.screen === 'flashcard', 'and it is off');
  holder.fcWithdraw();
  c.tap();
  holder.fcWithdrawPin(0);
  ok(pad(holder).title === 'ENTER PIN TO WITHDRAW' && pad(holder).cta === 'WITHDRAW ALL', 'then: ENTER PIN TO WITHDRAW', pad(holder).cta);
  pad(holder).type('4321');
  await until('the money to be in the wallet', () => card(holder) && card(holder).title === 'IN YOUR WALLET');
  await settle();
  ok(c.balance() === 0 && (await H.W.balanceSats()) === hadBefore + onCard && holder.state.fc && holder.state.fc.balance === 0 && holder.state.screen === 'flashcard',
     'all of it is in the phone, and the screen is still the card, reading empty', card(holder).reason);
  const out = history(H).filter((e) => e.memo === 'from card')[0];
  ok(out && holder.seen[out.hash] === true, 'and its entry is not announced a second time');
  card(holder).press('DONE');

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
  rc.tap();
  pad(holder).type('4321');
  await until('1,024 to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
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

  failed += until.failed;
  console.log('\n' + (failed ? failed + ' flashcard-screens check(s) failed' : 'all flashcard-screens checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
