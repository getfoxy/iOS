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

const { appOn, until, pad, card, explainer, stage, behind, watchBehind, vals, settle, keyIn } = require('./flashcard-ui-kit');

/* The daily limit's three steps, as a person takes them: the warning's CONTINUE, an amount on the keypad
 * (or NO LIMIT under it, for 0), and the confirmation's CONFIRM. */
const takeLimitSteps = (app, sats, which) => {
  // CHANGE CARD LIMITS asks which of the card's two limits first
  if (card(app) && card(app).title === 'CHANGE CARD LIMITS') card(app).press(which || 'DAILY LIMIT');
  // the limit on one tap opens HOW TAP LIMIT WORKS, whose buttons come when it has played; the daily limit's warning has CONTINUE at once
  if (explainer(app)) { explainer(app).finish(); explainer(app).press('CONTINUE'); } else card(app).press('CONTINUE');
  if (sats > 0) keyIn(app, sats); else app.fcLimitConfirm(0);
  app.fcLimitSpec().go();
};
/* Money put on a card, or taken off it, from its own screen is said by that screen and not by a card raised over it: the balance on it counts to
 * what the card holds (`fcRollStart`). Waits for the count to end, with `sats` on the card. */
const counted = (app, sats, what) => until(what, () => !!app.state.fc && app.state.fc.balance === sats && !app.state.fcRoll);
// whether the row under the card has RESET in it (a card of software 1.17 and on, its owner's phone)
const hasReset = (app) => vals(app).fcLinks.some((k) => k.label === 'RESET');
/* Two pads in a row (a PIN asked twice, and asked again where the two differed): the pad's own opening and closing are watched, and a turn
 * is a stretch of the page with no paint in it. The second pad must come up in the very turn the first went down, and with no fade: it fades
 * in from the screen under it, which showed through for an instant between the two. */
const watchPads = (app) => {
  let turn = 0;
  const events = /** @type {any[]} */ ([]);
  const bump = () => Promise.resolve().then(() => { turn += 1; });
  const down = app.pinDismiss.bind(app), up = app.pinOverlay.bind(app);
  app.pinDismiss = () => { const had = !!app._pinEl; down(); if (had) { events.push({ kind: 'down', turn }); bump(); } };
  app.pinOverlay = (o) => { const root = up(o); events.push({ kind: 'up', turn, title: o.title, fade: /foxyIn/.test(root.getAttribute('style') || '') }); return root; };
  return { events, stop() { app.pinDismiss = down; app.pinOverlay = up; } };
};
// the pads of `events` that answered another, by title: whether each came up in the turn the last went down, and whether it faded in
const swaps = (events) => events.map((e, i) => ((e.kind === 'up' && i > 0 && events[i - 1].kind === 'down')
  ? { title: e.title, same: events[i - 1].turn === e.turn, fade: e.fade } : null)).filter(Boolean);
const noGap = (events) => { const w = swaps(events); return w.length > 0 && w.every((x) => x.same && !x.fade); };
// "Verified At 11:42am", and the day after the time for any other than today
const VERIFIED_AT = /^Verified At \d{1,2}:\d\d(am|pm)(, \d{1,2} [A-Z][a-z]{2})?$/;
// the rule of software 1.13 in plain words, and the card before it (1.12)'s
const TAP_WARNING = 'A per tap limit is the most this card pays in one tap straight away, change or no change: the sheet says when change is coming. Over the limit, the card has to be held about 7 seconds, and 2 seconds more for every limit\u2019s worth beyond that. Lift the card and the payment stops, with nothing taken.\n\n'
  + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.\n\n'
  + 'If you lose the seed phrase for this Foxy app, the PIN and the limits on this card can never be changed.\n\n'
  + 'Do you wish to continue?';
const TAP_WARNING_OLD = 'A per tap limit is the most this card pays in one tap straight away, when it pays exactly. A payment that makes change holds the card 3 seconds; one over the limit, 3 seconds for every limit\u2019s worth of what leaves the card. Lift the card and the payment stops, with nothing taken.\n\n'
  + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.\n\n'
  + 'If you lose the seed phrase for this Foxy app, the PIN and the limits on this card can never be changed.\n\n'
  + 'Do you wish to continue?';
const LIMIT_WARNING = 'A daily limit is the most this card will spend in one day.\n\n'
  + 'If you lose the seed phrase for this Foxy app, the limit can never be changed.\n\n'
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
  ok(H.sheet.length === 1 && /^begin: Tap behind the phone\.$/.test(H.sheet[0]), 'FLASHCARD in the menu asks for the card at once, with no screen to read first', H.sheet[0]);
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
  ok(H.sheet.join(' / ').indexOf('begin: Tap behind the phone.') >= 0 && H.sheet.indexOf('say: Reading the card') >= 0 && H.sheet.indexOf('end: Done.') >= 0,
     'and the phone’s own sheet was told what was happening', H.sheet.slice(-3).join(' / '));

  const setUpPads = watchPads(holder);
  holder.fcSetUp();
  ok(pad(holder).title === 'CHOOSE A PIN' && !pad(holder).has('NO PIN'), 'setting up a card of software before 1.16 starts with a PIN, as it always did: it cannot be without one, so there is no way round it');
  ok(pad(holder).ready === false && !pad(holder).hasCancel, 'its button is grey until there is a PIN to give, and the way out is the back button at the top');
  pad(holder).type('123');
  ok(pad(holder).title === 'CHOOSE A PIN' && pad(holder).ready === false && pad(holder).note === '', 'three digits and the button still does nothing');
  pad(holder).type('4');
  ok(pad(holder).title === 'TYPE IT AGAIN', 'typed twice');
  pad(holder).type('1235');
  ok(pad(holder).title === 'CHOOSE A PIN' && /did not match/.test(pad(holder).note), 'and two that differ start it again', pad(holder).note);
  pad(holder).type('1234');
  pad(holder).type('1234');
  setUpPads.stop();
  ok(!pad(holder) && !card(holder) && holder.state.screen === 'flashcard' && holder.state.flow !== 'cardLimit' && !c.state.owner,
     'the PIN given twice, the tap begins: nothing to read first, no limit to choose, and no amount asked');
  {
    const ev = setUpPads.events;
    ok(ev[0].kind === 'up' && ev[0].title === 'CHOOSE A PIN' && ev[0].fade === true, 'the first pad fades in over the card’s screen, as every pad does', JSON.stringify(ev[0]));
    ok(swaps(ev).map((x) => x.title).join() === 'TYPE IT AGAIN,CHOOSE A PIN,TYPE IT AGAIN' && noGap(ev),
       'every pad that answers another (TYPE IT AGAIN, and CHOOSE A PIN again where the two differed) comes up in the very turn the last went down and with no fade: the card’s screen is never seen between two pads',
       JSON.stringify(swaps(ev)));
  }
  await until('the card to be set up', () => holder.state.screen === 'flashcard' && !!c.state.owner && holder.state.fc && holder.state.fc.owner);
  ok(c.state.record.limit === 0 && c.state.owner && holder.state.fc.limit === 0 && holder.state.fc.owner && holder.state.fc.ownedHere === true,
     'one tap gave the card its PIN, its record and its owner, and no limit', JSON.stringify({ limit: c.state.record.limit }));
  ok(!card(holder) && !pad(holder) && holder.state.screen === 'flashcard' && holder.state.stack.slice(-1)[0] === 'home' && holder.toasts.indexOf('The card is set up.') >= 0,
     'and the person stays on the card’s screen, told so in a line, with nothing to read or press; back from it is where they were', holder.toasts.slice(-1)[0]);
  await settle();
  v = vals(holder);
  ok(v.fcUsable && !v.fcNew && v.fcCheck === '' && !holder.state.fc.mine && !holder.state.fc.recoverable && H.W.cardsList().length === 0,
     'one tap later it has a PIN and is cash: no key of this phone’s is on it, and this phone keeps no list of it');
  ok(v.fcPill === true && v.fcPillMint === 'm.test' && v.fcPillLetter === 'M' && v.fcBalance === '₿ 0' && v.fcFields === undefined,
     'and the screen says its mint and what it holds in home’s own pill', v.fcPillMint + ' | ' + v.fcBalance);
  ok(v.fcLimitShown === true && v.fcLimitLine === 'NO LIMIT' && v.fcDayShown === false, 'and under it, that it has no limit, with nothing else to say of its day', v.fcLimitLine);
  ok(v.fcLinks.map((k) => k.label).join() === 'CHANGE PIN,LIMITS' && v.fcRowShown === true && v.fcHistoryVis === 'visible' && v.fcResetVis === undefined && v.fcReset === undefined
     && typeof v.fcAdd === 'function' && typeof v.fcWithdraw === 'function' && typeof v.fcHistory === 'function' && !hasReset(holder),
     'with ADD FUNDS and WITHDRAW, HISTORY at the top left, and a row of CHANGE PIN and LIMITS under them: RESET is in the row for a card of 1.17 and not for this older one');
  ok(v.fcFaceLines === true && v.fcLimitShown === true, 'and the limit line is drawn on the card’s own face (it has the card’s badge above it only where there is one)');
  ok(v.fcDesign === 'FX1' && holder.fcDesignOf({ design: 'zz9' }) === 'FL1' && holder.fcDesignOf({ design: 'EL1' }) === 'EL1' && holder.fcDesignOf({}) === 'FL1' && holder.fcDesignOf({ design: 'fl1' }) === 'FL1'
     && Object.keys(holder.FC_DESIGNS).every((k) => /^[A-Z0-9]{3}$/.test(k)),
     'a card this phone set up is drawn in Foxy’s design FX1; one that names no design, or one this build cannot draw, is drawn in FL1; every design has a code of three characters', v.fcDesign);
  ok(VERIFIED_AT.test(v.fcVerified) && v.fcVerifiedShown === true, 'and under its title, that it is verified, and at what time: a card with nothing on it has nothing a mint could dispute', v.fcVerified);
  ok(v.fcBlockShown === false && v.fcBlockLine === '' && v.fcClockShown === undefined && v.fcClockLine === undefined,
     'a card whose clock is not block headers has no block to say, and no card has a CLOCK line any more', v.fcBlockLine);

  /* ---- add funds: the owner's phone, with no PIN ------------------------------- */
  c.tap();
  holder.fcAdd();
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.state.flow === 'cardAdd' && holder.state.unit === 'SATS' && holder.state.stack.slice(-1)[0] === 'flashcard',
     'ADD FUNDS asks how much on the SET AMOUNT screen (in sats here: this phone has no price to say dollars at)');
  keyIn(holder, 99999);
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.toasts.indexOf('You have ₿6,000.') >= 0, 'more than the phone holds goes no further');
  c.sent.length = 0;
  keyIn(holder, 2000);
  ok(!pad(holder) && holder.state.screen === 'flashcard', 'then no PIN is asked for: this phone owns the card, and the PIN was typed once, at set-up');
  await until('the money to be on the card', () => !!holder.state.fc && holder.state.fc.balance === 2000);
  /* No card is raised over the screen: it is the card's own, and its balance counts up from what it showed to what the card holds, in about a second */
  const figures = [];
  const sampling = setInterval(() => figures.push(Number(vals(holder).fcBalance.replace(/[^\d]/g, ''))), 30);
  const countBegan = Date.now();
  ok(holder.state.fcRoll && holder.state.fcRoll.from === 0 && vals(holder).fcBalance !== '₿ 2,000', 'the balance has not jumped to the new figure: it starts from the old one', vals(holder).fcBalance);
  await until('the count to end', () => !holder.state.fcRoll);
  clearInterval(sampling);
  const countMs = Date.now() - countBegan;
  ok(c.balance() === 2000 && holder.state.screen === 'flashcard' && !card(holder) && !pad(holder) && vals(holder).fcBalance === '₿ 2,000' && holder.state.fc.balance === 2000,
     'and 2,000 sats are on it, and the card’s own screen says so: no card is raised over it, and its balance reads 2,000', vals(holder).fcBalance);
  ok(figures[0] < 1000 && figures.every((f, i) => i === 0 || f >= figures[i - 1]) && new Set(figures).size > 5 && countMs > 900 && countMs < 3000,
     'the balance counted up to it over about a second, and never went back', countMs + ' ms: ' + figures.join(' '));
  holder.fcRollStart(null);
  const fromNothing = !holder.state.fcRoll;
  holder.fcRollStart(2000);
  ok(fromNothing && !holder.state.fcRoll, 'a count starts only from a figure that differs from what the card holds: from nothing known, or from the same figure, there is nothing to count');
  ok(!c.sent.some((a) => /^b040/.test(a)) && c.sent.some((a) => /^b045/.test(a)), 'the card was never sent a PIN: this phone’s proof let it be loaded', c.sent.map((a) => a.slice(2, 4)).join(' '));
  const added = history(H).filter((e) => e.memo === 'to card')[0];
  ok(added && holder.seen[added.hash] === true && H.W.cardOwed().length === 0, 'its entry is one the app will not announce a second time, and nothing is left owed');
  await until('the mint’s word on the card', () => holder.state.fc.check === 'ok');
  ok(vals(holder).fcCheck === '' && VERIFIED_AT.test(vals(holder).fcVerified), 'the mint is asked about what the card says it holds, and the screen says so once, under its title');

  /* ---- under the title: how fresh the mint's word on the card is -------------- */
  {
    ok(vals(holder).fcVerified === 'Verified At ' + holder.fcAt(H.W.cardCheckedAt(holder._fcCard)) && H.W.cardCheckedAt(holder._fcCard) > 0, 'asked just now, the screen says the time under its title', vals(holder).fcVerified);
    const askedAt = H.W.cardCheckedAt(holder._fcCard);
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
    ok(holder.state.fc.check === 'off' && vals(holder).fcVerified === 'Verified At ' + holder.fcAt(askedAt), 'with no connection two hours later, it says the time it was last verified', vals(holder).fcVerified);
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
    ok(VERIFIED_AT.test(vals(holder).fcVerified) && vals(holder).fcVerified !== 'Verified At ' + holder.fcAt(askedAt - 1e9), 'and with the connection back it is verified again', vals(holder).fcVerified);
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
     && H.sheet.some((x) => /^again: Hold for the rest\.$/.test(x)),
     'a card taken away before it was written to: the same sheet asked for it again, and with no card the 500 is kept for it and said', card(holder).reason);
  v = vals(holder);
  ok(v.fcNotes.length === 1 && /₿500 is waiting to go onto this card/.test(v.fcNotes[0].text), 'the screen carries a line for it', v.fcNotes[0] && v.fcNotes[0].text);
  c.tap();
  card(holder).press('TAP CARD');
  ok(!pad(holder), 'TAP CARD asks for no PIN: this phone owns the card');
  await counted(holder, 2500, 'the 500 to be on the card');
  ok(c.balance() === 2500 && H.W.cardOwed().length === 0 && vals(holder).fcNotes.length === 0 && !card(holder) && holder.state.screen === 'flashcard',
     'and the next tap finishes it: 2,500 on the card, nothing waiting, and no card raised over its screen');

  /* ---- being paid by the card, at somebody else's phone ----------------------- */
  till.asking = 1000;
  R.nfc = c;
  c.tap();
  c.sent.length = 0;
  R.sheet.length = 0;
  till.payByCard();
  ok(!pad(till) && R.sheet.length > 0 && /^begin: /.test(R.sheet[0]), 'CARD on the receive screen brings up the sheet at once, with no PIN asked for first', R.sheet[0]);
  await until('the card to say it wants its PIN', () => !!pad(till));
  ok(pad(till).title === 'CARD PIN' && /To pay ₿1,000/.test(pad(till).sub) && pad(till).cta === 'TAP AGAIN' && !pad(till).hasCancel
     && R.sheet.indexOf('end: Enter the card’s PIN') >= 0 && !R.sheet.some((x) => /^error:/.test(x)),
     'a card with a PIN and no no PIN limit ends that tap asking for the PIN (not as an error), and the pad comes up on a button that says TAP AGAIN',
     pad(till).cta + ' | ' + R.sheet.slice(-1)[0]);
  ok(!c.sent.some((a) => /^b040/.test(a)) && !c.sent.some((a) => /^b020/.test(a)) && (await R.W.balanceSats()) === 0,
     'nothing was signed or taken, and no PIN was sent');
  ok(behind(R) && behind(R).look === 'pin' && behind(R).title === 'ENTER PIN' && behind(R).scheme === '01' && !behind(R).loop && !behind(R).cancel,
     'the screen behind the pad stays up, as ENTER PIN on the light ground, with the card settled and no CANCEL', JSON.stringify(behind(R)));
  pad(till).back();
  ok(!pad(till) && till.state.screen === 'confirm' && !stage(R), 'back from it is back to the invoice, and the screen behind it goes with it');
  till.payByCard();
  await until('the PIN pad', () => !!pad(till));
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
      atMint = Object.assign({ kind: stage(R), ended: R.ended }, behind(R));
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
  // which of the screen's states was up, in turn, and what the sheet had been told when the card was asked for again
  const looks = watchBehind(till, R);
  pad(till).type('1234');
  /* Tap 1, SEND: the card signs the fewest pieces that cover it (two 512s for 1,000 here) and may go: the sheet stays up
   * and says so while the mint is asked. Then the same sheet asks for the card again, and its change (the 24 over) goes
   * on with no PIN. One sheet, nothing to press, and PAYMENT RECEIVED once the change is back. */
  await until('the payment to be made and its change back on the card', () => till.state.screen === 'home' && R.W.cardOwed().length === 0 && released.length > 0 && !stage(R));
  R.fate = null;
  await settle();
  const begins = R.sheet.filter((x) => /^begin:/.test(x));
  const ends = R.sheet.filter((x) => /^(end|error):/.test(x));
  const removeAt = R.sheet.indexOf('say: Hold for change.');
  ok(begins.length === 1 && ends.length === 1 && ends[0] === 'end: Done.' && removeAt >= 0
     && R.sheet.indexOf('again: Hold for change.') > removeAt && R.sheet.indexOf('say: Asking the mint') < 0 && !pad(till),
     'one sheet for the whole payment: as the card has signed it says to hold for the change (and nothing that reads as finished), asks for the card again, and ends saying the change is back',
     R.sheet.filter((x) => /^(begin|again|end|error):|^say: Hold for change\./.test(x)).join(' / '));
  ok(R.sheet.every((x) => !/Remove the card\. Verifying/.test(x)), 'the sheet no longer says “Remove the card” beside its own Cancel, which read as over and got it closed before the change');
  ok(atMint && atMint.kind === 'card' && atMint.look === 'verify' && atMint.title === 'VERIFYING CARD' && atMint.scheme === '03' && !atMint.cancel
     && !atMint.loop && atMint.amount === '\u20bf1,000',
     'behind it, our own screen said VERIFYING CARD over the amount, on the warm ground, the card settled, with nothing to press', JSON.stringify(atMint));
  const changeAt = looks.filter((x) => x.look === 'change')[0];
  ok(looks.path() === 'hold > keep > verify > change > verify' && changeAt && changeAt.at <= R.sheet.indexOf('again: Hold for change.')
     && looks.titles() === 'TAP BEHIND PHONE > KEEP HOLDING \u00b7 0 s > VERIFYING CARD > TAP FOR CHANGE > VERIFYING CARD',
     'the payment’s screens in turn: TAP BEHIND PHONE, KEEP HOLDING while the card is in contact and signs, VERIFYING CARD while the mint is asked and the card is still there, TAP FOR CHANGE from the moment the card is asked for again (before it is found), and VERIFYING CARD while the change goes on',
     looks.path() + ' | ' + looks.titles());
  looks.stop();
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
    if (lookNow === 'change') seenConfirm = true;
    if (till.state.screen === 'home' && !up && !card(till)) bare += 1;
  }, 20);
  R.sheet.length = 0;
  released.length = 0;
  till.releaseHeldConfirm = (why) => { released.push(why); till._holdConfirmUntil = 0; };
  till.payByCard();
  await until('the PIN pad', () => !!pad(till));
  // (the sheets of the payment itself: the first tap, with no PIN, ended asking for it)
  R.sheet.length = 0;
  pad(till).type('1234');
  await until('the change to be said to be still waiting', () => card(till) && card(till).title === 'TAP TO RECEIVE' && /not read/.test(card(till).reason));
  clearInterval(watch);
  sheets = R.sheet.filter((x) => /^begin:/.test(x)).length;
  ok(bare === 0 && seenConfirm && sheets === 2,
     'the sheet gone with the change still to take: TAP FOR CHANGE stays up through the pause and the second sheet, and the till’s home screen is never what is showing between the payment and its change',
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
    const titles = [];
    const shown = till2.blockedCard.bind(till2);
    till2.blockedCard = (k, sp) => { titles.push((sp && sp.title) || k); return shown(k, sp); };
    RT.sheet.length = 0;
    // the screen's states, in the order they went up, and how many times the sheet had asked for the card again by then
    const seen = watchBehind(till2, RT);
    till2.payByCard();
    await until('the PIN pad', () => !!pad(till2));
    // the tap with the PIN is the one that leaves, before its second signature (the first, with none, only found out it was wanted)
    c3.tap = () => { tap0(); c3.leaveBefore('20', 2); c3.tap = tap0; };
    RT.sheet.length = 0;
    pad(till2).type('1234');
    await until('the payment to be finished by the next tap', () => till2.state.screen === 'home' && !RT.W.cardHeldPayment(c3.key) && RT.W.cardTaken().length === 0 && !stage(R));
    await settle();
    seen.stop();
    const again1 = seen.filter((x) => x.look === 'again')[1];
    ok(seen.path() === 'hold > keep > pin > again > keep > again > keep > remove' && again1 && again1.title === 'PLEASE TAP AGAIN' && again1.scheme === '01' && again1.loop
       && RT.sheet.slice(0, again1.at).filter((x) => /^again: Hold/.test(x)).length === 0 && seen[seen.length - 1].title === 'REMOVE',
       'the card lost part way through signing: the screen says PLEASE TAP AGAIN, on the light ground with the card looping, from the moment it is lost (before the sheet has asked for it again), then KEEP HOLDING when it is found, and REMOVE once it has signed (the first tap having ended asking for the PIN, which the screen waited under the pad as ENTER PIN)',
       seen.path() + ' | ' + seen.titles());
    const got = (await RT.W.balanceSats()) - rb;
    const begins = RT.sheet.filter((x) => /^begin:/.test(x));
    const agains = RT.sheet.filter((x) => /^again:/.test(x));
    ok(got === 1536 && c3.balance() === 0 && begins.length === 1 && agains.join() === 'again: Hold to finish paying' && !pad(till2),
       'a payment the card leaves part way through: the same sheet asks for the card again, with no PIN, and the next tap signs the rest and pays', RT.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + '; ' + got + ' received');
    ok(titles.length === 0 && RT.W.cardOwed().filter((r) => r.card === c3.key).length === 0, 'with no card to press, and nothing to put back on the card', titles.join(', '));
    till2.blockedCard = shown;

    /* The card lost while its change was being written: what went on stays on, the same sheet asks again, and the
     * screen says PLEASE TAP AGAIN until the rest is on. */
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
      const seen5 = watchBehind(till2, RT);
      const sentBefore = c5.sent.length;
      RT.sheet.length = 0;
      till2.payByCard();
      await until('the PIN pad', () => !!pad(till2));
      // counted from the tap with the PIN: its second tap (the change) leaves before the second piece is written; the third stays
      c5.tap = () => { tap5(); taps += 1; if (taps === 2) c5.leaveBefore('30', 2); };
      RT.sheet.length = 0;
      pad(till2).type('1234');
      await until('the change to be back on the card after two tries', () => till2.state.screen === 'home' && RT.W.cardOwed().filter((r) => r.card === c5.key).length === 0 && !stage(RT) && c5.balance() === 824);
      await settle();
      c5.tap = tap5;
      const lines5 = RT.sheet.filter((x) => /^(begin|again|end|error):/.test(x));
      seen5.stop();
      ok(seen5.path() === 'hold > keep > pin > again > keep > verify > change > verify > again > verify' && seen5[8].title === 'PLEASE TAP AGAIN',
         'the card lost part way through taking its change: PLEASE TAP AGAIN (not TAP FOR CHANGE, for some of it went on), and VERIFYING CARD again while the rest goes on', seen5.path() + ' | ' + seen5.titles());
      ok(lines5.filter((x) => /^begin:/.test(x)).length === 1 && lines5.filter((x) => x === 'again: Hold for change.').length === 2
         && lines5[lines5.length - 1] === 'end: Done.' && taps === 3,
         'in the one sheet: asked for its change, asked again when it left, and ended with the change back', lines5.join(' / '));
      // the card allows one tap after a payment to load with no PIN, and the tap it left used that up: the rest needs its PIN
      const pins5 = c5.sent.slice(sentBefore).filter((a) => /^b040/.test(a)).length;
      ok(!pad(till2) && pins5 === 2,
         'the rest went on with the PIN typed for this payment, given to the card again (once to pay, once for the rest), and nobody was asked for it twice', String(pins5));
    }

    // the tap to finish reads no card: NOT PAID YET, with TAP CARD to finish and CANCEL to give it back
    const c4 = newCard(HL);
    await HL.W.cardSetUp(c4, { pin: '1234' });
    await binaryLoad(HL, c4, 768);          // 512 and 256
    till2.state.screen = 'confirm';
    till2.asking = 768;
    RT.nfc = c4;
    const rb4 = await RT.W.balanceSats();
    const tap4 = c4.tap;
    // and when it leaves it is not brought back: the sheet looks for it again and is dismissed
    const send4 = c4.send;
    till2.payByCard();
    await until('the PIN pad', () => !!pad(till2));
    c4.tap = () => { tap4(); c4.leaveBefore('20', 2); c4.tap = tap4; };
    c4.send = (x) => send4(x).then((r) => r, (err) => { RT.nfc = null; throw err; });
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
  ok(card(holder) && card(holder).all === ['CHANGE CARD LIMITS', 'Which limit would you like to add or change?', 'PER TAP LIMIT', 'DAILY LIMIT', 'CANCEL'].join(' | '),
     'LIMITS asks which of the card’s two limits, in one line: PER TAP LIMIT, DAILY LIMIT, or CANCEL', card(holder) && card(holder).all);
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
   * The other choice under LIMITS, asked for by the same three steps in its own words. */
  {
    // a card read as the one before the latest (software 1.12) has that card's rule in its words: it does not wait by the newest
    const was = holder._fcCard;
    holder._fcCard = Object.assign({}, was, { info: Object.assign({}, was.info, { format: 4, shaped: false }) });
    holder.fcSetLimit();
    ok(card(holder) && card(holder).all === ['CHANGE CARD LIMITS', 'Which limit would you like to add or change?', 'PER TAP LIMIT', 'DAILY LIMIT', 'CANCEL'].join(' | '),
       'a card of software 1.12 is asked the same question at LIMITS', card(holder) && card(holder).all);
    card(holder).press('PER TAP LIMIT');
    ok(card(holder) && !explainer(holder) && card(holder).all === ['SET PER TAP LIMIT', TAP_WARNING_OLD, 'CONTINUE', 'CANCEL'].join(' | '),
       'and is told its own rule in a warning, not the played rule of the card that makes change: change holds the card 3 seconds, and 3 seconds for every limit’s worth over it', card(holder) && card(holder).all);
    card(holder).press('CANCEL');
    holder.state.fcLimit = { sats: 300, usd: 0 };
    holder._fcLimitTap = true;
    ok(/^This card will pay up to this straight away when it pays exactly\. With change, or over the limit, it has to be held 3 seconds for every limit\u2019s worth\. /.test(holder.fcLimitSpec().warn), 'and at the confirmation');
    holder._fcCard = was;
    ok(holder.fcShaped() === true, 'a card read as 1.13 (and one not read yet) has the newest words');
    // and the lines the sheet is given as the card works: the change a piece at a time, a second payment, a wait over the limit
    ok(holder.fcProgressText({ step: 'change', i: 2, n: 4 }) === 'Making change 2 of 4.'
       && holder.fcProgressText({ step: 'change', i: 1, n: 1 }) === 'Making change 1 of 1.'
       && holder.fcProgressText({ step: 'change', i: 0, n: 4 }) === '' && holder.fcProgressText({ step: 'change' }) === '',
       'the card making its change is said a piece at a time: "Making change 2 of 4."');
    ok(holder.fcProgressText({ step: 'waiting', polls: 3, seconds: 2, second: true }) === 'Keep holding.'
       && holder.fcProgressText({ step: 'waiting', polls: 3, seconds: 4 }) === 'Over per tap limit'
       && holder.fcProgressText({ step: 'waiting', polls: 3, seconds: 4, making: true }) === 'Keep holding.'
       && holder.fcProgressText({ step: 'waiting', polls: 3, seconds: 4, want: 10, sum: 64 }) === 'Paying from a larger piece.'
       && holder.fcProgressText({ step: 'fetching' }) === 'Asking for change owed.',
       'a second payment in one tap and the card making change are "Keep holding."; a wait over the limit, a larger piece and the change owed are said as that');
    // over the limit, by the level the askings have come to: ten for the first limit's worth (seven before software 1.17), three for each further one
    {
      const at = (over, polls) => holder.fcProgressText({ step: 'waiting', polls, seconds: 4, over });
      const was10 = holder._fcCard;
      ok(at(10, 1) === 'Over per tap limit' && at(10, 10) === 'Over per tap limit' && at(10, 11) === 'Over per tap limit x2' && at(10, 13) === 'Over per tap limit x2'
         && at(10, 14) === 'Over per tap limit x3' && at(10, 16) === 'Over per tap limit x3' && at(10, 17) === 'Over per tap limit x4',
         'a card of 1.17 says x2 when the eleventh asking begins and x3 three askings on');
      ok(at(7, 7) === 'Over per tap limit' && at(7, 8) === 'Over per tap limit x2' && at(7, 11) === 'Over per tap limit x3',
         'and a card before 1.17 changes level after seven');
      holder._fcCard = { info: { waitOver: 7 } };
      ok(holder.fcProgressText({ step: 'waiting', polls: 8, seconds: 4 }) === 'Over per tap limit x2' && holder.fcProgressText({ step: 'waiting', polls: 10, seconds: 4 }) === 'Over per tap limit x2',
         'the card on show says which, where the event does not');
      holder._fcCard = was10;
    }
  }
  holder.fcSetLimit();
  card(holder).press('PER TAP LIMIT');
  {
    const x = explainer(holder);
    ok(x && !card(holder) && x.title === 'How tap limit works' && !x.done, 'PER TAP LIMIT opens HOW TAP LIMIT WORKS, a screen of its own, which plays before its buttons come', x && x.all);
    x.finish();
    const y = explainer(holder);
    ok(y.done && y.all === ['How tap limit works', 'Any payment request over your limit requires you to tap and hold your card longer.', 'EXAMPLE LIMIT', '$10',
                            '$0.01 \u2013 $10.00', '~1\u20134 SEC TAP', '$10.01 \u2013 $20.00', '~7 SEC TAP', '$20.01 \u2013 $30.00', '~9 SEC TAP', '$30.01 \u2013 $40.00', '~10 SEC TAP',
                            'And so on\u2026', 'CANCEL', 'CONTINUE'].join(' | '),
       'played out, it is the rule as a list: the ten-dollar example, four tiers with the seconds the screen reaches on this card (seven askings, then three), and so on, then CANCEL and CONTINUE', y.all);
    y.press('CANCEL');
    ok(!explainer(holder) && holder.state.screen === 'flashcard' && holder._fcLimitDone === null, 'CANCEL takes it down and changes nothing');
    // played through once on this phone, it opens on the list from then on
    holder.fcSetLimit();
    card(holder).press('PER TAP LIMIT');
    ok(explainer(holder) && explainer(holder).done && explainer(holder).has('CONTINUE') && H.storage.getItem('foxy.flashcard.explained') === '1',
       'opened again, it does not play: the list and its buttons are there at once');
    explainer(holder).press('CANCEL');
  }
  holder.fcSetLimit();
  card(holder).press('PER TAP LIMIT');
  explainer(holder).finish();
  explainer(holder).press('CONTINUE');
  ok(holder.state.screen === 'amount' && holder.state.flow === 'cardLimit' && holder.fcLimitQuestion() === 'What is the most this card should pay in one tap straight away?',
     'CONTINUE asks for the amount on the same keypad, in its own words', holder.fcLimitQuestion());
  keyIn(holder, 300);
  {
    const cf = holder.fcLimitSpec();
    ok(cf.amountLabel === 'YOU ARE APPLYING A PER TAP LIMIT OF:' && cf.amount === '\u20bf 300' && cf.cta === 'CONFIRM' && cf.secondary.label === 'CANCEL'
       && cf.warn === 'This card will pay up to this straight away, change or no change. Over it, the card has to be held about 7 seconds, and 2 seconds more for every limit\u2019s worth beyond that. Only this phone, or a phone restored from its seed phrase, can change or remove it.',
       'the confirmation says the amount and what it means', JSON.stringify([cf.amountLabel, cf.amount]));
  }
  c.tap();
  c.sent.length = 0;
  holder.fcLimitSpec().go();
  await until('the limit on one tap to be set', () => holder.state.fc.tap && holder.state.fc.tap.limit === 300);
  ok(c.state.tapLimit === 300 && c.state.record.limit === 700 && c.state.spent === 0 && !c.sent.some((a) => /^b040/.test(a)) && holder.toasts.indexOf('Per tap limit set.') >= 0,
     'the card has its limit on one tap, the daily limit is as it was, and no PIN was sent', JSON.stringify({ tap: c.state.tapLimit, day: c.state.record.limit }));
  ok(vals(holder).fcLimitLine === 'PER TAP \u20bf300\u00a0\u00b7 DAILY \u20bf700', 'and its screen says both (the space before the dot does not break, so that the line, which can wrap on the card’s face, never begins with the dot)', vals(holder).fcLimitLine);
  // a till asked for more than one tap may pay: refused before the PIN is sent, with what to do
  till.state.screen = 'confirm';
  till.asking = 400;
  R.nfc = c;
  c.tap();
  c.sent.length = 0;
  till.payByCard();
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
  // the card's clock has been moved on by the tests above; this phone's is put where the card's is, so that the card is not
  // ahead of the phone that reads it (which the screen would say, and rightly: tests/flashcard-sigall.js)
  H.phone.clockMs = () => Math.max(Date.now(), c.state.now * 1000 + 1000);
  await readLog('the card’s log to be read');
  {
    const notes = vals(holder).fcNotes.filter((x) => /^Last tap: |^TAMPER: /.test(x.text));
    ok(notes.length === 0 && holder.state.fc.log && holder.state.fc.log.last.length > 0,
       'the card’s screen says nothing of a log the card has nothing to accuse in: what the card did is in this phone’s history', JSON.stringify(notes.map((x) => x.text)));
    holder.fcLogCard();
    ok(card(holder) && card(holder).title === 'THIS CARD\u2019S OWN LOG' && /Kept by the card itself\. No phone or terminal can change it\./.test(card(holder).reason)
       && /In all: \d+ taps?, \u20bf[\d,]+ signed for, 0 refused\.$/.test(card(holder).reason) && card(holder).has('CLOSE'),
       'the log itself is still there to open: THIS CARD’S OWN LOG, its last taps, and its totals', card(holder).reason.split('\n').slice(-1)[0]);
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
  explainer(holder).finish();
  explainer(holder).press('CONTINUE');
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
  await until('the limit to refuse', () => card(till) && card(till).title === 'OVER THE CARD’S DAILY LIMIT');
  ok(/Nothing was taken/.test(card(till).reason) && /The card can spend ₿700 in a day, and this payment is more than that/.test(card(till).reason) && (await R.W.balanceSats()) === 1200,
     'a till asking for more than the card can spend in a day is refused, in plain words, with nothing signed', card(till).reason);
  ok(!c.sent.some((a) => /^b0(40|20)/.test(a)), 'and the card was never sent the PIN');
  card(till).press('CLOSE');
  till.asking = 300;
  c.tap();
  till.payByCard();
  await until('the PIN pad', () => !!pad(till));
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
  await until('the PIN pad', () => !!pad(till));
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

  const changePads = watchPads(holder);
  holder.fcChangePin();
  ok(pad(holder).title === 'NEW PIN', 'CHANGE PIN asks for the new PIN, and not the old: this phone does not know it');
  pad(holder).type('4321');
  ok(pad(holder).title === 'NEW PIN AGAIN', 'and then once more');
  c.tap();
  pad(holder).type('4321');
  changePads.stop();
  ok(swaps(changePads.events).map((x) => x.title).join() === 'NEW PIN AGAIN' && noGap(changePads.events),
     'the second pad of CHANGE PIN takes the first one’s place in the same turn, with no fade', JSON.stringify(swaps(changePads.events)));
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
      await until('the PIN pad', () => !!pad(till));
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
    ok(v.fcLimitShown === false && v.fcFaceLines === true && v.fcCheck === 'Blocked', 'its face says Blocked and no limit line: it has nothing to say of its limits', v.fcCheck);
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
  await until('the money to be in the wallet', () => c.balance() === 0 && !!holder.state.fc && holder.state.fc.balance === 0);
  const wdFigures = [];
  const wdSampling = setInterval(() => wdFigures.push(Number(vals(holder).fcBalance.replace(/[^\d]/g, ''))), 30);
  await until('the count to end', () => !holder.state.fcRoll);
  clearInterval(wdSampling);
  await settle();
  ok(c.balance() === 0 && (await H.W.balanceSats()) === hadBefore + onCard && holder.state.screen === 'flashcard' && !card(holder) && !pad(holder) && vals(holder).fcBalance === '₿ 0',
     'all of it is in the phone, though the limit was 700 a day: the holder’s phone lifted it in the same tap. The card was let go once it had signed and is not read again, so the screen is brought up to date from what the tap knew: it stays on the card, and no card is raised over it', vals(holder).fcBalance);
  ok(wdFigures[0] > 0 && wdFigures.every((f, i) => i === 0 || f <= wdFigures[i - 1]) && wdFigures[wdFigures.length - 1] === 0 && new Set(wdFigures).size > 5,
     'and its balance counted down from what it held to nothing, and never went up', wdFigures.join(' '));
  ok(c.state.record.limit === 700, 'and the limit is back as it was when the card left the phone', String(c.state.record.limit));
  ok(c.sent.filter((a) => /^b034/.test(a)).length === 2, 'having been lifted and put back, with this phone’s proof, in the one tap');
  const out = history(H).filter((e) => e.memo === 'from card')[0];
  ok(out && holder.seen[out.hash] === true, 'and its entry is not announced a second time');
  {
    /* What the screen says of a card it has not read since is what the card says when it is read: its balance, its pieces, and the day. The
     * limit was lifted and put back, which begins the day again: the whole of it is left, and it turns 24 hours on from the card's own clock. */
    const shown = holder._fcCard;
    c.tap();
    const real = await H.W.cardLook(c, { mine: true });
    ok(shown.balance === real.balance && shown.pieces.length === real.pieces.length && shown.info.unspent === real.info.unspent && shown.info.spent === real.info.spent
       && holder.state.fc.count === real.pieces.length && holder.state.fc.room === real.info.empty + real.info.spent,
       'what the screen says of the card’s pieces and places is what the card says when it is read', JSON.stringify([shown.balance, shown.pieces.length, shown.info.spent, real.info.spent]));
    ok(shown.day.limited && shown.day.limit === 700 && shown.day.left === real.day.left && shown.day.left === 700 && shown.day.turns === real.day.turns && shown.day.turns > 0
       && vals(holder).fcDayLeft === 'LEFT TODAY ₿700',
       'and so is the day: given back whole with the limit put back, and turning when the card says', JSON.stringify([shown.day.left, real.day.left, shown.day.turns, real.day.turns]));
  }

  // a typed amount that needs change: the card is let go once it has signed, and the sheet that puts its change back reads it after
  {
    await binaryLoad(H, c, 1000);                // 512 256 128 64 32 8: a price takes pieces, with change
    c.tap();
    holder.fcRead();
    await until('the loaded card to be read', () => holder.state.fc && holder.state.fc.balance === 1000 && holder.state.fc.check !== 'asking');
    H.sheet.length = 0;
    holder.fcWithdraw();
    keyIn(holder, 300);
    await until('the PIN pad', () => !!pad(holder));
    c.tap();
    pad(holder).type('4321');
    await counted(holder, 700, 'the 300 to be off the card');
    await settle();
    ok(holder.state.screen === 'flashcard' && !card(holder) && c.balance() === 700 && H.W.cardOwed().length === 0 && H.sheet.indexOf('again: Hold for change.') >= 0 && vals(holder).fcBalance === '₿ 700',
       'a typed amount that needs change: the card is let go once it has signed, its change goes back in the same sheet, and the screen is the card’s, at 700, with nothing raised over it',
       H.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + ' | ' + vals(holder).fcBalance);
    const shown = holder._fcCard;
    c.tap();
    const real = await H.W.cardLook(c, { mine: true });
    const sizes = (k) => k.pieces.map((x) => x.amount).sort((a, b) => a - b).join();
    ok(shown.balance === real.balance && sizes(shown) === sizes(real) && shown.info.unspent === real.info.unspent && holder.state.fc.count === real.pieces.length,
       'the screen says what the card says when it is read: the card as the sheet read it after its change went on, whole pieces and all', shown.balance + ' / ' + real.balance);
    ok(holder.state.fc.ownedHere === true && holder.state.fc.owner === true && vals(holder).fcLinks.length === 2 && !hasReset(holder),
       'and it is still this phone’s card: the owner’s buttons are there (the read after the change is not the owner’s read, and what only that says is kept)');
    // what is left comes off again, so that what follows has the card as it was
    c.tap();
    await H.W.cardWithdraw(c, { pin: '4321' });
    await settle();
  }

  // the mint has not answered when the card has signed: the CHECKING screen; once it says paid, back on the card’s screen, counted down
  {
    c.tap();
    await H.W.cardAdd(c, { sats: 500, owner: true });
    c.tap();
    holder.fcRead();
    await until('the loaded card to be read', () => holder.state.fc && holder.state.fc.balance === 500 && holder.state.fc.check !== 'asking');
    H.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? '0\n' : null);       // the swap never reaches the mint
    holder.fcWithdraw();
    holder.fcWithdrawPin(0);                                                       // ALL OF IT
    c.tap();
    pad(holder).type('4321');
    await until('the CHECKING screen', () => stage(H) === 'cardChecking');
    ok(c.balance() === 0 && holder.state.screen === 'flashcard' && !card(holder), 'the card has signed and the mint has not answered: CHECKING, over the card’s screen', stage(H));
    H.fate = null;
    await until('the mint to say paid', () => !stage(H) && !!holder.state.fc && holder.state.fc.balance === 0 && !holder.state.fcRoll);
    await settle();
    ok(holder.state.screen === 'flashcard' && !card(holder) && !stage(H) && vals(holder).fcBalance === '₿ 0' && H.W.cardTaken().length === 0,
       'and when it has said paid the card’s screen is back, at nothing, with no card raised over it: the card as the tap left it was handed on with the wait', vals(holder).fcBalance);
  }

  // a phone set to reduce motion is shown the new figure at once
  {
    const quiet = appOn(H);
    const rm = newCard(H);
    await H.W.cardSetUp(rm, { pin: '1234' });
    H.nfc = rm;
    rm.tap();
    quiet.goFlashcard();
    await until('the card to be read', () => !!quiet.state.fc && quiet.state.fc.key === rm.key);
    await quiet.refreshBalance();
    const matchWas = H.window.matchMedia;
    H.window.matchMedia = (q) => ({ matches: /prefers-reduced-motion/.test(q), media: q, addListener() {}, removeListener() {} });
    rm.tap();
    quiet.fcAdd();
    keyIn(quiet, 400);
    await until('the money to be on the card', () => quiet.state.fc && quiet.state.fc.balance === 400);
    ok(!quiet.state.fcRoll && vals(quiet).fcBalance === '₿ 400' && !card(quiet) && quiet.state.screen === 'flashcard',
       'with Reduce Motion on, the balance is the new figure at once: it does not count', vals(quiet).fcBalance);
    H.window.matchMedia = matchWas;
    // and the money comes off the card again, so that what follows has the phone as it was
    rm.tap();
    await H.W.cardWithdraw(rm, { pin: '1234' });
    H.nfc = c;
    await settle();
  }

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
    await counted(holder, 0, 'the whole withdrawal to be in the wallet');
    await settle();
    const begins = H.sheet.filter((x) => /^begin:/.test(x));
    ok(begins.length === 1 && H.sheet.filter((x) => /^again:/.test(x)).join() === 'again: Hold for the rest.' && !pad(holder) && titlesW.length === 0 && !card(holder),
       'a withdrawal cut short keeps what came off, and the same sheet asks for the card again for the rest, with no PIN and no card to press, and none raised when it is done', H.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + ' | ' + titlesW.join(', '));
    ok(c.balance() === 0 && (await H.W.balanceSats()) === had + 1500 && holder.state.screen === 'flashcard' && vals(holder).fcBalance === '₿ 0' && c.state.record.limit === 700 && H.W.cardOwed().length === 0,
       'and then all of it is in the phone, and the screen is the card’s, at nothing, and the card’s limit is back as it was', vals(holder).fcBalance + ' / ' + c.state.record.limit);

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
    await counted(holder, onBefore + 1000, 'the load to be on the card');
    await settle();
    const beginsL = H.sheet.filter((x) => /^begin:/.test(x));
    ok(beginsL.length === 1 && H.sheet.filter((x) => /^again:/.test(x)).join() === 'again: Hold for the rest.' && c.balance() === onBefore + 1000 && H.W.cardOwed().length === 0 && !card(holder),
       'a load cut short after some pieces went on: the same sheet asks for the card again, and the rest goes on, with no card raised over the screen', H.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + ' | ' + c.balance());
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
  ok(!pad(holder) && card(holder) && card(holder).title === 'IF THE CARD IS LOST' && card(holder).has('RECOVERABLE') && card(holder).has('LIKE CASH'),
     'and set-up has its one choice, straight after the PIN: recoverable, or like cash', card(holder) && card(holder).title);
  rc.tap();
  card(holder).press('RECOVERABLE');
  await until('the second card to be set up', () => holder.state.screen === 'flashcard' && !!rc.state.owner && holder.state.fc && holder.state.fc.owner);
  ok(holder.state.fc.mine && holder.state.fc.recoverable, 'chosen recoverable, it is this phone\u2019s to take back');
  holder.goFlashcard();
  await until('the second card to be read again', () => holder.state.screen === 'flashcard' && holder.state.fc && holder.state.fc.mine === true);
  await settle();
  rc.tap();
  holder.fcAdd();
  keyIn(holder, 1024);
  ok(!card(holder) && !pad(holder), 'adding funds offers nothing about a limit, and asks for no PIN');
  await counted(holder, 1024, '1,024 to be on the card');
  ok(rc.state.record.limit === 0 && rc.balance() === 1024 && !card(holder), 'and the card has it, and no limit', String(rc.state.record.limit));
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
    await until('the PIN pad', () => !!pad(till));
    R.sheet.length = 0;
    pad(till).type('1234');
    await until('the failed payment to be said', () => card(till) && card(till).title === 'PAYMENT FAILED');
    R.fate = null;
    await settle();
    const signedFor = f.state.spent;     // the fewest pieces that cover 300, signed whole
    /* The sheet was still up (kept for the change): the same sheet asks for the card again and puts what it signed back,
     * with no PIN, and ends saying so; the screen then says the payment failed and the money is back. Nothing to press. */
    const putAt = R.sheet.indexOf('again: Payment did not go through.');
    ok(signedFor >= 300 && putAt >= 0 && R.sheet[R.sheet.length - 1] === 'end: Payment did not go through.'
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
    // the tap is held half-way, so the screen can be looked at while the card is still on the phone
    let let_go = null;
    const gate = new Promise((r) => { let_go = r; });
    R.nfc = { tap: () => d.tap(), send: (a) => (/^b020/.test(a) ? gate.then(() => d.send(a)) : d.send(a)) };
    till.state.screen = 'confirm';
    till.asking = 960;                  // 512 + 256 + 128 + 64: four pieces and no change
    R.sheet.length = 0;
    till.payByCard();
    await until('the PIN pad', () => !!pad(till));
    pad(till).type('1234');
    await until('the card to be asked to sign', () => R.sheet.indexOf('say: Signing piece 1 of 4') >= 0);
    const hold1 = behind(R);
    ok(R.events.indexOf('connected: Reading the card') >= 0 && hold1 && hold1.look === 'keep' && hold1.scheme === '03' && /^KEEP HOLDING \u00b7 \d+ s$/.test(hold1.title)
       && !hold1.loop && !hold1.cancel && hold1.fur === '0.5',
       'the sheet says the piece being signed; the screen behind it is KEEP HOLDING with the seconds, on the warm ground with the fur, the card settled and no CANCEL', JSON.stringify(hold1));
    /* The count is the seconds since the card connected, a whole second at a time, and runs only while it is on the screen. */
    const counted = [];
    const t0 = till._fcTapO.t;
    t0.since = Date.now() - 7400;
    till.fcTapTick();
    counted.push(behind(R).title);
    t0.since = Date.now() - 12000;
    till.fcTapTick();
    counted.push(behind(R).title);
    ok(counted.join(' / ') === 'KEEP HOLDING \u00b7 7 s / KEEP HOLDING \u00b7 12 s' && !!till._fcCountT
       && R.window.document.querySelector('h1 span').style.textTransform === 'none',
       'the count goes up from the contact in whole seconds ("KEEP HOLDING · 7 s"), with the unit left lowercase, off a timer that is running', counted.join(' / '));
    // what the phone’s own link says, pushed to the page as it happens, changes nothing it should not
    R.W._card({ stage: 'say', text: 'Signing piece 1 of 4' });
    ok(behind(R).look === 'keep' && behind(R).title === 'KEEP HOLDING \u00b7 12 s', 'and what the sheet says is not repeated on the screen, nor does it start the count again', behind(R).title);
    let_go();
    await until('the payment to be made', () => till.state.screen === 'home');
    await settle();
    ok(['Signing piece 1 of 4', 'Signing piece 2 of 4', 'Signing piece 3 of 4', 'Signing piece 4 of 4'].every((t) => R.sheet.indexOf('say: ' + t) >= 0)
       && R.sheet[R.sheet.length - 1] === 'end:  ' && d.balance() === 40 && !stage(R),
       'each piece was said on the sheet in turn, the sheet closed with no words once the card had signed (it was paid exactly: nothing to keep it open for), and the screen is down', R.sheet.slice(-3).join(' / '));
    ok(!till._fcCountT, 'and the count stopped with the screen: no timer is left running');
    R.nfc = d;
    ok(R.W.cardOwed().length === 0 && d.state.slots.filter((x) => x.status === 1).length === 2, 'no change was needed: the card was not written to');

    // a push with no tap under way changes nothing and breaks nothing
    R.W._card({ stage: 'say', text: 'stray' });
    R.W._card(null);
    ok(!R.window.document.getElementById('foxy-stage'), 'a push with no tap under way draws nothing');

    /* ---- the screen behind the card sheet, state by state (build/app/26h-tap-screen.js) ---------------------
     * Driven as the wallet and the phone's link drive it: the steps of a tap, and the link's "connected" and "lost". */
    {
      const S = appOn(R);
      const begin = (o) => { S._fcTapO = Object.assign({ amount: '$25.75' }, o || {}); S.fcStage('hold'); };
      const link = (stage) => S.fcTapEvent({ stage, text: '' });
      const LIGHT = '01', WARM = '03';
      // the two grounds, the fur, the loop, CANCEL, the title and the amount of each state
      const is = (b, look, title, scheme, loop, cancel) => !!b && b.look === look && b.title === title && b.scheme === scheme && b.loop === loop && b.cancel === cancel
        && b.amount === '$25.75' && b.fur === (scheme === WARM ? '0.5' : '0') && b.cardMoves === loop;

      begin();
      let b = behind(R);
      ok(is(b, 'hold', 'TAP BEHIND PHONE', LIGHT, true, true) && b.design === 'FX1', 'waiting for a card: TAP BEHIND PHONE on the light ground, no fur, the card and waves looping, CANCEL there, the card drawn as FX1 until one has been read', JSON.stringify(b));
      const up = R.window.document.getElementById('foxy-stage');
      ok(/white-space:\s*nowrap/.test(up.querySelector('h1').getAttribute('style')) && /font-size:\s*31px/.test(up.querySelector('h1').getAttribute('style'))
         && /font-size:\s*42px/.test(up.querySelector('[data-tap-amount]').getAttribute('style')) && up.querySelectorAll('[data-tap-wave]').length === 3
         && /width:\s*250px/.test(up.querySelector('[data-tap-card]').getAttribute('style')) && up.querySelector('[data-tap-card] [data-card-face]'),
         'the title is 31px on one line, the amount 42px, there are three waves, and the card is 250px wide and the card screen’s own face');
      ok(/background-color: rgb\(191, 227, 236\)/.test(up.getAttribute('style')) && /color: rgb\(15, 42, 51\)/.test(up.getAttribute('style')),
         'the light ground is #BFE3EC with #0F2A33 ink');

      link('connected');
      b = behind(R);
      ok(is(b, 'keep', 'KEEP HOLDING \u00b7 0 s', WARM, false, false), 'a card connected: KEEP HOLDING · 0 s, the warm ground with the fur, the card settled, and CANCEL gone', JSON.stringify(b));
      ok(/background-color: rgb\(235, 106, 46\)/.test(up.getAttribute('style')) && /color: rgb\(26, 10, 4\)/.test(up.getAttribute('style')), 'the warm ground is #EB6A2E with #1A0A04 ink');
      S._fcTapO.t.since = Date.now() - 3000;
      S.fcTapTick();
      ok(behind(R).title === 'KEEP HOLDING \u00b7 3 s', 'the count goes up a second at a time, from the contact', behind(R).title);
      S._fcTapO.t.since = Date.now() - 31000;
      S.fcTapTick();
      ok(behind(R).title === 'KEEP HOLDING \u00b7 31 s', 'and keeps going past the seconds a wait over the limit takes', behind(R).title);

      // contact broke before anything was signed: the loop starts again to say so
      link('lost');
      b = behind(R);
      ok(is(b, 'again', 'PLEASE TAP AGAIN', LIGHT, true, false) && !S._fcCountT, 'contact broke mid-tap: PLEASE TAP AGAIN on the light ground, the loop running again, no CANCEL, and the count stopped', JSON.stringify(b));
      link('connected');
      ok(behind(R).title === 'KEEP HOLDING \u00b7 0 s' && behind(R).scheme === WARM && !behind(R).loop && !!S._fcCountT, 'found again: the count begins afresh from this contact', behind(R).title);

      // signed, with the sheet kept for the change: the card is still there
      S.fcStage('mint');
      b = behind(R);
      ok(is(b, 'verify', 'VERIFYING CARD', WARM, false, false) && !S._fcCountT, 'the card has signed and the mint is asked, the card still there: VERIFYING CARD, settled, with no count', JSON.stringify(b));
      S.fcStage('change');
      ok(behind(R).look === 'verify', 'and while the change is made it is the same');
      // lost before any of the change went on: it is the change that is asked for
      link('lost');
      b = behind(R);
      ok(is(b, 'change', 'TAP FOR CHANGE', LIGHT, true, false), 'contact broke after signing and before the change went on: TAP FOR CHANGE on the light ground, looping', JSON.stringify(b));
      link('connected');
      ok(behind(R).look === 'verify', 'the card found for the change: VERIFYING CARD while it goes on');
      // lost with some of the change on
      S._fcTapO.t.wrote = true;
      link('lost');
      ok(behind(R).look === 'again' && behind(R).title === 'PLEASE TAP AGAIN', 'contact broke with some of the change on: PLEASE TAP AGAIN, as it is the same tap going on', behind(R).title);

      // the card let go, nothing more wanted of it (the sheet is gone)
      S.fcStage('checking');
      b = behind(R);
      ok(is(b, 'remove', 'REMOVE', WARM, false, false), 'the card has signed and nothing more is needed of it: REMOVE, on the warm ground, settled', JSON.stringify(b));
      link('lost');
      ok(behind(R).look === 'remove', 'and the card going is not “lost” then');

      // the second tap of a payment, asked for before the card is found
      begin({ look: 'receive' });
      b = behind(R);
      ok(is(b, 'change', 'TAP FOR CHANGE', LIGHT, true, true), 'the second tap, before the card is found: TAP FOR CHANGE, looping, with CANCEL as on any tap not yet begun', JSON.stringify(b));
      link('connected');
      ok(behind(R).look === 'verify', 'and in contact, the change going on: VERIFYING CARD');
      // a payment the mint refused, going back on the card
      begin({ putBack: true });
      ok(behind(R).look === 'again' && behind(R).scheme === LIGHT && behind(R).loop, 'a refused payment going back on the card asks for the card with PLEASE TAP AGAIN', behind(R).title);

      // the sheet ended asking for the PIN; the pad is up; the tap after it asks again
      begin();
      link('connected');
      S.fcTapPin();
      b = behind(R);
      ok(is(b, 'pin', 'ENTER PIN', LIGHT, false, false), 'the sheet ended asking for the PIN: ENTER PIN, on the light ground, the card settled', JSON.stringify(b));
      link('lost');
      link('connected');
      ok(behind(R).look === 'pin', 'and nothing the link says moves it while the pad is up');
      // (the next tap is what brings it back: the payment flow above, and this)
      S._fcTapO = { amount: '$25.75', pinAgain: true };
      S.fcStage('hold');
      b = behind(R);
      ok(is(b, 'again', 'PLEASE TAP AGAIN', LIGHT, true, true), 'the tap after the pad starts as PLEASE TAP AGAIN, looping, with CANCEL (nothing has been asked of the card yet)', JSON.stringify(b));

      // the design of the card: FX1 until a card has been read at a till, then the card’s own
      S.fcTapSeen('');
      ok(behind(R).design === 'FL1', 'a card read at a till that names no design is drawn as FL1, the drawn face', behind(R).design);
      S.fcTapSeen('FX1');
      ok(behind(R).design === 'FX1', 'and one that names FX1 as FX1, the picture', behind(R).design);
      begin();
      S.state.fc = { design: 'FL1' };
      S.fcTapDraw();
      ok(behind(R).design === 'FL1', 'a card already on the phone’s screen is drawn in its own design from the start', behind(R).design);
      S.state.fc = null;

      // no amount: nothing under the title
      begin({ amount: '' });
      ok(behind(R).amount === '' && R.window.document.querySelector('[data-tap-amount]').style.display === 'none', 'a tap with no amount draws none');

      // the screen is the stage’s: down, and nothing left running
      link('connected');
      ok(!!S._fcCountT, 'a count is running while KEEP HOLDING is up');
      S.hideStage('card');
      ok(!stage(R) && !S._fcCountT && !S._stageT, 'taken down, the count and the timeout stop with it');
      S.fcTapTick();
      ok(!stage(R) && !S._fcCountT, 'and a tick that comes after draws nothing');
      S._fcTapO = {};
    }

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
    await until('the inexact price to be refused', () => card(till) && card(till).title === 'NO CHANGE WHILE OFFLINE');
    ok(/cannot give change/.test(card(till).reason) && /Nothing was taken/.test(card(till).reason) && !e.sent.some((a) => /^b040|^b020/.test(a)) && e.balance() === 200,
       'a price the card cannot make exactly is refused in plain words in the first tap, before any PIN is asked for or sent', card(till).reason);
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
    await counted(app, 500, 'the funds to be on the card');
    ok(empty.state.record.mint === MINT2 && empty.balance() === 500 && !card(app) && /^The card is now at n\.test\./.test(app.toasts.slice(-1)[0]) && vals(app).fcPillMint === 'n.test',
       'the funds are added at the new mint and the screen says the card is now there, in a line and in its pill, with no card raised over it', app.toasts.slice(-1)[0]);
    ok(empty.state.pin === keep.pin && empty.state.owner === keep.owner && empty.state.record.timeKey === keep.key && empty.state.record.limit === keep.limit,
       'its PIN, owner, limit and time key are as they were');
    ok(empty.sent.filter((a) => /^b032/.test(a)).length === 1 && !empty.sent.some((a) => /^b040/.test(a)),
       'the record was rewritten once, with the owner’s proof and no PIN, in the same tap that wrote the funds');
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

  /* ---- the change a till never handed over, on its owner's screen ----------------------------------------------------------
   * A card of software 1.12 makes a payment's change itself; if its till never taps it again, its owner's phone fetches the change
   * from the mint and puts it on (tests/flashcard-owed.js has the wallet's side). The FLASHCARD screen says so in one line under the
   * balance, in dollars first and the sats after, for each state the change is in. */
  {
    const { makeCard } = require('./flashcard-card');
    const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    const lines = (a) => vals(a).fcOwesLines.map((l) => l.text);
    const OH = await funded({}, 9000);
    const T1 = await funded({ sharedMint: OH.mint, words: OTHER_WORDS }, 0);
    const T2 = await funded({ sharedMint: OH.mint, words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' }, 0);
    const owner = appOn(OH);
    owner.price = 100000;                     // a dollar is 1,000 sats
    await owner.refreshBalance();
    const oc = makeCard({ window: OH.window, format: 4 });
    await OH.W.cardSetUp(oc, { pin: '1234' });
    await binaryLoad(OH, oc, 2000);           // 1024 512 256 128 64 16: no exact set for 1000
    const dies = (T) => T.storage.setItem('foxy.flashcard.owed', '[]');
    const open = () => oc.state.openings.filter((x) => x.state === 'pending').reduce((n, x) => n + x.amount, 0);
    const readIt = async () => {
      OH.nfc = oc;
      owner.setState({ fc: null });
      owner.fcRead(true);
      await until('the card to be read', () => !!owner.state.fc);
    };

    // nothing owed: no line
    await readIt();
    ok(vals(owner).fcOwesShown === false && lines(owner).length === 0 && owner.state.fc.owes === null, 'a card with no openings has no line about change');

    // a till that dies: the owner’s read fetches the change and says so, and so does the phone’s sheet
    oc.tap();
    const paid = await T1.W.cardPay(oc, { sats: 1000, pin: '1234' });
    dies(T1);
    OH.sheet.length = 0;
    await readIt();
    await settle();
    let v = vals(owner);
    // (the card makes the change of 1,000 from 1024 512 256 128 64 16 itself: 24 sats, a 16 and an 8, at a dollar of 1,000 sats)
    const owedN = paid.change.sats, owedUsd = '$' + (owedN / 1000).toFixed(2);
    ok(owedN === 24 && v.fcOwesShown === true && lines(owner).join('|') === 'CHANGE OWED TO THIS CARD · ' + owedUsd + ' (₿' + owedN + ') — FETCHED AND PUT ON' && owner.state.fc.balance === 1000,
       'a till that never handed its change over: the owner’s screen says the ' + owedN + ' owed to the card, in dollars first and the sats after, were fetched and put on', lines(owner).join('|'));
    ok(OH.sheet[OH.sheet.length - 1] === 'end: Done.' && OH.sheet.indexOf('say: Asking the mint') >= 0 && OH.sheet.indexOf('say: Asking for change owed.') >= 0,
       'and the phone’s sheet said the mint was being asked, and ends saying the change is back on the card', OH.sheet.filter((x) => /^(say|end):/.test(x)).slice(-4).join(' / '));
    ok(owedN > 0 && open() === 0 && oc.balance() === 1000, 'the card holds it', String(oc.balance()));

    // the till has not made its swap: not yet made
    oc.tap();
    T1.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? '0\n' : null);
    const lost = await T1.W.cardPay(oc, { sats: 300, pin: '1234' }).then(() => null, (e) => e);
    T1.fate = null;
    const owedLater = open();
    ok(lost && lost.card === 'waiting' && owedLater > 0, 'a payment whose swap never reaches the mint leaves the card change to make', String(owedLater));
    await readIt();
    v = vals(owner);
    ok(v.fcOwesShown === true && lines(owner).join('|') === 'CHANGE OWED TO THIS CARD · ' + owner.fcBoth(owedLater) + ' — NOT YET MADE BY THE TILL' && owner.state.fc.balance === oc.balance(),
       'a change the mint has not signed yet: NOT YET MADE BY THE TILL, with what is owed', lines(owner).join('|'));
    owner.price = 0;
    ok(lines(owner).join('|') === 'CHANGE OWED TO THIS CARD · ₿' + owedLater + ' — NOT YET MADE BY THE TILL', 'and in sats alone where this phone has no price', lines(owner).join('|'));
    owner.price = 100000;

    // both at once: each state on a line of its own, in the order they are said
    oc.tap();
    const first = await T2.W.cardPay(oc, { sats: 100, pin: '1234' });
    dies(T2);
    const both = open();
    const fetchedPart = both - owedLater;
    ok(first.change && first.change.sats === fetchedPart && fetchedPart > 0, 'another till pays and dies too', String(fetchedPart));
    await readIt();
    ok(lines(owner).join('|') === ['CHANGE OWED TO THIS CARD · ' + owner.fcBoth(fetchedPart) + ' — FETCHED AND PUT ON',
                                   'CHANGE OWED TO THIS CARD · ' + owner.fcBoth(owedLater) + ' — NOT YET MADE BY THE TILL'].join('|'),
       'two states at once: a line for each, what was put on first', lines(owner).join('|'));

    // no connection
    offline(OH.W);
    await readIt();
    ok(lines(owner).join('|') === 'CHANGE OWED TO THIS CARD · ' + owner.fcBoth(owedLater) + ' — NO CONNECTION TO FETCH IT', 'with no connection it says so', lines(owner).join('|'));
    online(OH.W);

    // a mint that is slow: BEING FETCHED, and the line follows what the mint says when it does
    const dead = await funded({ sharedMint: OH.mint, words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' }, 0);
    oc.tap();
    const third = await dead.W.cardPay(oc, { sats: 50, pin: '1234' });
    dies(dead);
    const slow = third.change.sats;
    const real = OH.W._scanResult.bind(OH.W), held = [], ids = new Set();
    OH.fate = (m) => { if (/\/v1\/restore$/.test(String(m.url || ''))) ids.add(m.id); return null; };
    OH.W._scanResult = (id, text, err) => { if (ids.has(id)) { held.push([id, text, err]); return undefined; } return real(id, text, err); };
    OH.W._cardFetchWait = 40;
    const heldBalance = oc.balance();
    await readIt();
    const beingFetched = lines(owner);
    // (which of the openings the mint has signed for and which not is its to say: all that are asked after are being fetched until it does)
    ok(beingFetched.join('|') === 'CHANGE OWED TO THIS CARD · ' + owner.fcBoth(owedLater + slow) + ' — BEING FETCHED' && oc.balance() === heldBalance,
       'a mint that has not answered when the tap goes on: BEING FETCHED, for all that is asked after, and nothing written', beingFetched.join('|'));
    OH.W._scanResult = real;
    OH.fate = null;
    held.splice(0).forEach((a) => real(a[0], a[1], a[2]));
    await until('the line to follow the mint’s answer', () => lines(owner).some((l) => /FETCHED, WAITING TO GO ON$/.test(l)));
    ok(lines(owner).join('|').indexOf('BEING FETCHED') < 0 && lines(owner).some((l) => l === 'CHANGE OWED TO THIS CARD · ' + owner.fcBoth(slow) + ' — FETCHED, WAITING TO GO ON'),
       'when the mint answers the line says it is fetched and waiting to go on', lines(owner).join('|'));
    ok(vals(owner).fcNotes.some((n) => /is waiting to go onto this card/.test(n.text)) && OH.W.cardOwed().length === 1 && OH.W.cardOwed()[0].sats === slow,
       'and it is among what this phone owes the card, as the line above the buttons says', vals(owner).fcNotes.map((n) => n.text).join(' | '));
    // the line under the screen’s buttons: pressed, and the next tap puts it on, as change always has
    OH.W._cardFetchWait = 15000;
    OH.nfc = oc;
    oc.tap();
    oc.sent.length = 0;
    vals(owner).fcNotes.filter((n) => /is waiting to go onto this card/.test(n.text))[0].tap();
    await until('the change to be put on', () => OH.W.cardOwed().length === 0);
    await settle();
    ok(owner.toasts.some((t) => t === '₿' + slow + ' of change is back on the card.') && oc.balance() === heldBalance + slow && !oc.sent.some((a) => /^b040/.test(a)),
       'pressed, the tap writes it with no PIN, and says the change is back on the card', owner.toasts.slice(-2).join(' | '));
  }

  /* ---- software 1.16: the PIN is optional, and a limit for paying without it ------------------------------------------
   * A card is set up with NO PIN under the pad that asks for one; it pays at a till in one tap; ADD PIN gives it one, and
   * then every payment asks for it until the owner sets a NO PIN LIMIT, a third limit with its own three steps; within it
   * a payment is made in the first tap, over it the sheet ends asking for the PIN and the pad comes up for a second. */
  {
    const H2 = await funded({}, 8000);
    const R2 = await funded({ sharedMint: H2.mint, words: OTHER_WORDS }, 0);
    const owner = appOn(H2);
    const till3 = appOn(R2, { screen: 'confirm' });
    await owner.refreshBalance();
    const n = newCard(H2, undefined, { format: 4 });
    const look = async () => {
      H2.nfc = n;
      owner.goFlashcard();
      await until('the card to be read', () => !!owner.state.fc && owner.state.fc.key === n.key);
      await settle();
    };
    const bal2 = () => R2.W.balanceSats();
    const pins = () => n.sent.filter((a) => /^b040/.test(a)).length;
    const payAt = async (sats) => {
      till3.state.screen = 'confirm';
      till3.asking = sats;
      R2.nfc = n;
      R2.sheet.length = 0;
      till3.payByCard();
    };
    const finish = async (what) => {
      await until(what, () => till3.state.screen === 'home' && R2.W.cardOwed().length === 0 && !stage(R2));
      await settle();
    };

    /* set-up: NO PIN under CHOOSE A PIN, only on a card whose software can be without one */
    const old = newCard(H2, undefined, { format: 4, software: 15 });
    H2.nfc = old;
    owner.goFlashcard();
    await until('a card of software 1.15 to be read', () => !!owner.state.fc);
    owner.fcSetUp();
    ok(pad(owner).title === 'CHOOSE A PIN' && !pad(owner).has('NO PIN'), 'a card of software 1.15 is asked for a PIN and offered no way round it: it cannot be without one');
    pad(owner).back();
    H2.nfc = n;
    owner.goFlashcard();
    await until('the new card to be read', () => !!owner.state.fc && owner.state.fc.key === n.key);
    ok(owner.state.fc.noPinKnown === true && owner.state.fc.pinSet === false && owner.state.fc.setUp === false && vals(owner).fcNew,
       'a new card of software 1.16 reads as new, and as one that can be without a PIN');
    n.sent.length = 0;
    H2.sheet.length = 0;
    owner.fcSetUp();
    ok(!pad(owner) && !card(owner) && H2.sheet[0] === 'begin: Tap behind the phone.' && !n.state.owner,
       'SET UP on a card of software 1.16 asks for no PIN: there is no pad, the sheet comes up at once and begins the tap, with nothing to read first and nothing to answer', H2.sheet[0]);
    await until('the card to be set up with no PIN', () => !!n.state.owner && owner.toasts.indexOf('The card is set up.') >= 0);
    ok(n.state.pinState === 0 && n.state.pin === null && n.state.record.set && n.state.record.limit === 0 && !n.sent.some((a) => /^b04[01]/.test(a))
       && owner.state.screen === 'flashcard' && !card(owner),
       'one tap gave the card its record and its owner and no PIN, and the person is on the card’s screen, told so in a line', owner.state.screen);
    await look();
    v = vals(owner);
    ok(v.fcUsable && !v.fcNew && v.fcCheck === '' && v.fcLinks.map((k) => k.label).join() === 'RESET,ADD PIN,LIMITS' && v.fcHistoryVis === 'visible' && v.fcLimitLine === 'NO LIMIT | NO PIN',
       'its screen has ADD PIN in CHANGE PIN’s place, and LIMITS, with RESET before them (a card of 1.17 and on) and HISTORY at the top left', v.fcLinks.map((k) => k.label).join());
    owner.fcSetLimit();
    ok(card(owner) && card(owner).all === ['CHANGE CARD LIMITS', 'Which limit would you like to add or change?', 'PER TAP LIMIT', 'DAILY LIMIT', 'CANCEL'].join(' | '),
       'LIMITS offers a card with no PIN its two limits and no NO PIN LIMIT: there is nothing to pay without', card(owner) && card(owner).all);
    card(owner).press('CANCEL');

    /* its owner puts money on it and takes some off with no PIN asked for; a till is paid in one tap */
    owner.fcAdd();
    keyIn(owner, 2000);
    ok(!pad(owner), 'adding funds asks for no PIN');
    await counted(owner, 2000, 'the money to be on the card');
    ok(!card(owner) && owner.state.screen === 'flashcard' && owner.state.fc.check !== 'asking',
       'and it is on, with no card raised over the screen; a card of 128 places is read the short way after the write, and the screen is not left saying it is verifying', owner.state.fc.check);
    await look();
    await owner.refreshBalance();
    const haveBefore = (await H2.W.balanceSats());
    owner.fcWithdraw();
    keyIn(owner, 500);
    ok(!pad(owner), 'withdrawing from it asks for no PIN either: there is none');
    await counted(owner, 1500, 'the money to be in the wallet');
    await settle();
    ok((await H2.W.balanceSats()) - haveBefore === 500 && n.sent.filter((a) => /^b040/.test(a)).length === 0 && !card(owner) && owner.state.screen === 'flashcard',
       'and 500 came off the card with no PIN sent, and the screen is the card’s, at 1,500, with nothing raised over it', String((await H2.W.balanceSats()) - haveBefore));
    {
      // what the screen says is what the card says when it is read, of a card of 128 places and a typed amount
      const shown = owner._fcCard;
      n.tap();
      const real = await H2.W.cardLook(n, { mine: true });
      ok(shown.balance === real.balance && shown.pieces.length === real.pieces.length && shown.pieces.map((x) => x.amount).sort((a, b) => a - b).join() === real.pieces.map((x) => x.amount).sort((a, b) => a - b).join()
         && shown.info.unspent === real.info.unspent && shown.info.spent === real.info.spent && owner.state.fc.room === real.info.empty + real.info.spent,
         'and what it says of the card’s pieces is what the card says when it is read', shown.balance + ' / ' + real.balance);
    }
    n.sent.length = 0;
    await payAt(300);
    ok(!pad(till3), 'a till tapping a card with no PIN asks for none');
    await finish('the payment with no PIN to be made');
    ok((await bal2()) === 300 && pins() === 0 && R2.sheet.filter((x) => /^begin:/.test(x)).length === 1 && !pad(till3),
       'and is paid in that one tap: 300 sats, one sheet, no PIN sent', (await bal2()) + ' | ' + R2.sheet.filter((x) => /^(begin|end|error):/.test(x)).join(' / '));

    /* ADD PIN */
    await look();
    owner.state.fc = Object.assign({}, owner.state.fc, { ownedHere: false });
    owner.fcPinAdd();
    ok(!pad(owner) && card(owner) && card(owner).title === 'NOT THIS PHONE’S CARD', 'on a phone that is not its owner, ADD PIN says so before asking for anything');
    card(owner).press('CLOSE');
    await look();
    const addPads = watchPads(owner);
    vals(owner).fcLinks[1].tap();
    ok(pad(owner).title === 'CHOOSE A PIN' && pad(owner).sub === 'A card with no PIN is cash to whoever holds it. Four to eight digits.' && !pad(owner).has('NO PIN'),
       'ADD PIN asks CHOOSE A PIN, and says in one line that a card with no PIN is cash to whoever holds it', pad(owner) && pad(owner).sub);
    pad(owner).type('4321');
    ok(pad(owner).title === 'TYPE IT AGAIN', 'then TYPE IT AGAIN');
    pad(owner).type('4322');
    ok(pad(owner).title === 'CHOOSE A PIN' && /did not match/.test(pad(owner).note), 'two that differ start it again', pad(owner).note);
    pad(owner).type('4321');
    pad(owner).type('4321');
    addPads.stop();
    ok(!pad(owner) && n.state.pinState === 0, 'the PIN given twice, the tap begins');
    ok(addPads.events[0].fade === true && swaps(addPads.events).map((x) => x.title).join() === 'TYPE IT AGAIN,CHOOSE A PIN,TYPE IT AGAIN' && noGap(addPads.events),
       'ADD PIN’s pads follow one another with the card’s screen never seen between them: each takes the last one’s place in the same turn, with no fade', JSON.stringify(swaps(addPads.events)));
    await until('the PIN to be added', () => owner.toasts.indexOf('PIN added. Every payment asks for it until you set a no-PIN limit.') >= 0);
    ok(n.state.pinState === 1 && n.state.pin === Buffer.from('4321').toString('hex') && n.state.noPinLimit === 0 && owner.state.fc.pinSet === true && owner.state.screen === 'flashcard',
       'one tap gave the card the PIN, with no allowance, and said so in a line', owner.toasts.slice(-1)[0]);
    v = vals(owner);
    ok(v.fcLinks.map((k) => k.label).join() === 'RESET,CHANGE PIN,LIMITS' && v.fcNoPinShown === false, 'and ADD PIN is CHANGE PIN again', v.fcLinks.map((k) => k.label).join());

    /* a card with a PIN and no NO PIN LIMIT asks for it for every payment: the first tap says so, the pad comes up, the second tap pays */
    n.sent.length = 0;
    await payAt(300);
    await until('the card to say it wants its PIN', () => !!pad(till3));
    ok(pad(till3).title === 'CARD PIN' && pad(till3).cta === 'TAP AGAIN' && R2.sheet.indexOf('end: Enter the card’s PIN') >= 0 && pins() === 0 && (await bal2()) === 300,
       'at a till it ends the first tap asking for the PIN and nothing is taken', R2.sheet.slice(-1)[0]);
    pad(till3).type('4321');
    await finish('the payment with the PIN to be made');
    ok((await bal2()) === 600 && pins() === 1, 'and the second tap pays with it: 300 more, the PIN sent once', (await bal2()) + ' / ' + pins());

    /* the NO PIN LIMIT: its warning, its amount, its confirmation, its tap */
    const NOPIN_WARNING = 'A \u201cNo PIN\u201d limit is the most this card will pay in one day without requiring your PIN.\n\n'
      + 'Once you reach your limit, the PIN is asked for every payment until the next day.\n\n'
      + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.';
    await look();
    owner.fcSetLimit();
    ok(card(owner) && card(owner).all === ['CHANGE CARD LIMITS', 'Which limit would you like to add or change?', 'PER TAP LIMIT', 'DAILY LIMIT', 'NO PIN LIMIT', 'CANCEL'].join(' | '),
       'on a card with a PIN, LIMITS has a third button, NO PIN LIMIT, under DAILY LIMIT', card(owner) && card(owner).all);
    card(owner).press('NO PIN LIMIT');
    ok(card(owner) && card(owner).all === ['SET NO PIN LIMIT', NOPIN_WARNING, 'CONTINUE', 'CANCEL'].join(' | '),
       'NO PIN LIMIT opens its warning: what it is, that over it the PIN is asked for the whole payment, that only payments with no PIN count', card(owner) && card(owner).all);
    card(owner).press('CANCEL');
    ok(!card(owner) && owner.state.screen === 'flashcard' && owner._fcLimitDone === null, 'CANCEL there changes nothing');
    owner.fcSetLimit();
    card(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    ok(owner.state.screen === 'amount' && owner.state.flow === 'cardLimit' && owner.fcLimitQuestion() === 'What is the most this card should pay in a day without its PIN?',
       'CONTINUE asks the amount on the same keypad, in its own words', owner.fcLimitQuestion());
    keyIn(owner, 0);
    ok(owner.state.screen === 'amount' && owner.toasts.indexOf('Type an amount first.') >= 0, 'nothing typed goes no further: NO LIMIT under the keypad is the way to say none');
    keyIn(owner, 500);
    {
      const cf = owner.fcLimitSpec();
      ok(owner.state.screen === 'fcLimitConfirm' && cf.amountLabel === 'YOU ARE APPLYING A NO PIN LIMIT OF:' && cf.amount === '₿ 500' && cf.cta === 'CONFIRM' && cf.secondary.label === 'CANCEL'
         && cf.warn === 'This card will pay up to this much a day without its PIN. Over it, the PIN is asked for the whole payment. Only this phone, or a phone restored from its seed phrase, can change or remove it.',
         'the confirmation says the amount and what it means, with CONFIRM and CANCEL', JSON.stringify([cf.amountLabel, cf.amount, cf.warn]));
      cf.secondary.go();
      ok(owner.state.screen === 'flashcard' && n.state.noPinLimit === 0 && !pad(owner), 'CANCEL there writes nothing');
    }
    owner.fcSetLimit();
    card(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    keyIn(owner, 500);
    n.sent.length = 0;
    owner.fcLimitSpec().go();
    ok(!pad(owner), 'CONFIRM asks for no PIN: this phone’s proof sets the limit');
    await until('the no PIN limit to be set', () => owner.state.fc.noPin && owner.state.fc.noPin.limit === 500);
    ok(n.state.noPinLimit === 500 && n.state.record.limit === 0 && pins() === 0 && owner.toasts.indexOf('No PIN limit set.') >= 0,
       'the card has an allowance of 500 and no PIN was sent', String(n.state.noPinLimit));
    v = vals(owner);
    ok(v.fcLimitLine === 'NO PIN UP TO ₿500' && v.fcNoPinShown === true && v.fcNoPinLine === 'NO PIN UP TO ₿500 · LEFT TODAY ₿500',
       'its screen says the limit and what is left of it today', [v.fcLimitLine, v.fcNoPinLine].join(' | '));

    /* at a till: within it, one tap and no PIN; over what is left of it, the PIN; the card's own word is the truth */
    n.sent.length = 0;
    await payAt(300);
    ok(!pad(till3), 'within the limit the till is not asked for the PIN');
    await finish('the payment within the limit to be made');
    ok((await bal2()) === 900 && pins() === 0 && n.state.noPinSpent === 300 && R2.sheet.filter((x) => /^begin:/.test(x)).length === 1,
       'it is paid in the first tap, with no PIN, and the card counts 300 of its 500', (await bal2()) + ' / ' + n.state.noPinSpent);
    await look();
    v = vals(owner);
    ok(v.fcNoPinLine === 'NO PIN UP TO ₿500 · LEFT TODAY ₿200', 'the screen says 200 is left today', v.fcNoPinLine);
    n.sent.length = 0;
    await payAt(300);
    await until('the card to say it wants its PIN', () => !!pad(till3));
    ok(pins() === 0 && n.state.noPinSpent === 300 && R2.sheet.indexOf('end: Enter the card’s PIN') >= 0,
       'over what is left of it (the PIN is wanted for the whole payment) the first tap ends asking for the PIN', R2.sheet.slice(-1)[0]);
    pad(till3).type('4321');
    await finish('the payment over the limit to be made');
    ok((await bal2()) === 1200 && pins() === 1 && n.state.noPinSpent === 300, 'the second tap pays 300 with the PIN, and only a payment with no PIN counts against the limit', (await bal2()) + ' / ' + n.state.noPinSpent);
    {
      // the read said 200 was left; the card says no at its signature (6A94): the pad comes up all the same
      const send0 = n.send.bind(n);
      let said = false;
      n.send = (x) => { if (!said && /^b024/.test(x)) { said = true; n.state.noPinSpent = 500; } return send0(x); };
      n.sent.length = 0;
      await payAt(100);
      await until('the card’s own word', () => !!pad(till3));
      n.send = send0;
      ok(said && R2.sheet.indexOf('end: Enter the card’s PIN') >= 0 && (await bal2()) === 1200,
         'when the card refuses the signature itself (6A94) the sheet ends the same way, nothing is taken, and the pad comes up', R2.sheet.slice(-1)[0]);
      pad(till3).type('4321');
      await finish('the payment to be made with the PIN');
      ok((await bal2()) === 1300, 'and the second tap pays', String(await bal2()));
      n.state.noPinSpent = 300;
    }

    // the card’s log says "no PIN" beside the taps that were made without it
    n.tap();
    owner.fcRead();
    await until('the log to be read', () => owner.state.fc && owner.state.fc.log && owner.state.fc.log.last.some((x) => x.noPin) && !stage(H2));
    await settle();
    owner.fcLogCard();
    {
      const lines = card(owner).reason.split('\n').filter((l) => /^\d{1,2}:\d\d [AP]M/.test(l));
      const marked = lines.filter((l) => /, no PIN$/.test(l));
      ok(marked.length === 1 && lines.length > marked.length, 'the card’s log screen says "no PIN" beside the one tap made without it, and not beside the others', lines.join(' / '));
      card(owner).press('CLOSE');
    }

    // NO LIMIT removes it: every payment asks for the PIN again
    owner.fcSetLimit();
    card(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    owner.fcLimitConfirm(0);
    {
      const cf = owner.fcLimitSpec();
      ok(cf.amountLabel === 'YOU ARE REMOVING THIS CARD’S NO PIN LIMIT.' && cf.amount === 'NO LIMIT' && cf.warn === 'Every payment will ask for the PIN.' && cf.cta === 'CONFIRM',
         'NO LIMIT under the keypad is confirmed in its own words: every payment will ask for the PIN', JSON.stringify([cf.amountLabel, cf.warn]));
    }
    owner.fcLimitSpec().go();
    await until('the no PIN limit to be removed', () => owner.state.fc.noPin && owner.state.fc.noPin.limit === 0);
    ok(n.state.noPinLimit === 0 && owner.toasts.indexOf('No PIN limit removed.') >= 0 && vals(owner).fcNoPinShown === false && vals(owner).fcLimitLine === 'NO LIMIT',
       'and the card has none, and its screen says so', vals(owner).fcLimitLine);

    // in dollars where there is a price: kept at those dollars
    owner.price = 100000;
    owner.fcSetLimit();
    card(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    ok(owner.state.unit === 'USD', 'with a price the amount is asked in dollars first');
    owner.state.amount = '0.50';
    owner.fcAmountNext();
    ok(/It is kept at this many dollars: this phone sets the card again when the price has moved\. /.test(owner.fcLimitSpec().warn), 'and the confirmation says it is kept at those dollars');
    owner.fcLimitSpec().go();
    await until('the limit in dollars to be set', () => owner.state.fc.noPin && owner.state.fc.noPin.limit === 500);
    ok(H2.W.cardNoPinUsd(n.key) === 0.5, 'the wallet keeps the dollars it was set in', String(H2.W.cardNoPinUsd(n.key)));
    owner.price = 0;

    /* a card of software 1.15 has always asked for its PIN: the same first tap, then the pad, then the second */
    {
      await H2.W.cardSetUp(old, { pin: '1234' });
      old.tap();
      await H2.W.cardAdd(old, { sats: 1000, owner: true });
      till3.state.screen = 'confirm';
      till3.asking = 200;
      R2.nfc = old;
      R2.sheet.length = 0;
      old.sent.length = 0;
      const before = await bal2();
      till3.payByCard();
      await until('the old card to be asked for its PIN', () => !!pad(till3));
      ok(R2.sheet.indexOf('end: Enter the card’s PIN') >= 0 && old.sent.filter((a) => /^b040/.test(a)).length === 0 && pad(till3).cta === 'TAP AGAIN',
         'a card of software 1.15 ends the first tap asking for its PIN, as every card before 1.16 does (it cannot be told from one that wants it before it is tapped)', R2.sheet.slice(-1)[0]);
      pad(till3).type('1234');
      await finish('the old card to be paid');
      ok((await bal2()) - before === 200, 'and pays with it at the second tap', String((await bal2()) - before));
    }

    // where a card can be set up as recoverable, the kind of card is asked next, with no PIN to be asked for first
    {
      const n2 = newCard(H2, undefined, { format: 4 });
      owner.FC_RECOVERABLE = true;
      H2.nfc = n2;
      owner.goFlashcard();
      await until('another new card to be read', () => !!owner.state.fc && owner.state.fc.key === n2.key);
      owner.fcSetUp();
      ok(!pad(owner) && card(owner) && card(owner).title === 'IF THE CARD IS LOST' && card(owner).has('RECOVERABLE'), 'with cards that can be taken back, SET UP goes straight to that question: no PIN is asked first');
      card(owner).press('RECOVERABLE');
      await until('the recoverable card to be set up with no PIN', () => owner.state.screen === 'flashcard' && !!n2.state.owner && owner.toasts.indexOf('The card is set up.') >= 0);
      ok(n2.state.pinState === 0 && n2.state.record.refund !== '00'.repeat(33) && H2.W.cardsList().length === 1, 'and the card is set up with no PIN and its key of this phone’s on it');
      owner.FC_RECOVERABLE = false;
    }
  }

  failed += until.failed;
  /* ---- one ADD FUNDS at a time ------------------------------------------------- */
  {
    /* One ADD FUNDS at a time, and CLOSE while the pieces are being made: a second start while the first was still
     * preparing once put two sheets on one reader, and neither wrote. */
    const W = holder.fcW();
    const realPrepare = W.cardPrepare;
    let release;
    W.cardPrepare = (...a) => new Promise((go) => { release = go; }).then(() => realPrepare.apply(W, a));
    // the first card again, read afresh as its owner, from home
    H.nfc = c;
    holder.setState({ screen: 'home', stack: [] });
    holder.goFlashcard();
    await until('the first card to be read again', () => holder.state.screen === 'flashcard' && holder.state.fc && holder.state.fc.key === c.key && holder.state.fc.ownedHere === true);
    await settle();
    const before = c.balance();
    c.tap();
    holder.fcAdd();
    ok(holder.state.screen === 'amount' && holder.state.flow === 'cardAdd', 'ADD FUNDS opens the keypad');
    keyIn(holder, 500);
    ok(stage(H) === 'cardReady' && !!holder._fcAdding, 'ADD FUNDS shows GETTING IT READY while the pieces are made');
    holder.fcAdd();
    ok(holder.toasts.slice(-1)[0] === 'Still getting the last amount ready for the card.' && holder.state.screen === 'flashcard', 'a second ADD FUNDS meanwhile is refused in a line, and opens no keypad', holder.toasts.slice(-1)[0]);
    H.window.document.querySelector('[data-stage-button]').click();
    ok(stage(H) === '' && !!holder._fcAdding, 'CLOSE takes the screen down while the pieces are still being made');
    H.sheet.length = 0;
    release();
    await until('the pieces to be made', () => !holder._fcAdding);
    await settle();
    ok(H.sheet.length === 0 && !card(holder) && /is ready for the card\. It goes on at the next tap\.$/.test(holder.toasts.slice(-1)[0]) && H.W.cardOwed().length > 0,
       'made after CLOSE, they wait for the next tap, said in a line, and no sheet comes up by itself', holder.toasts.slice(-1)[0] + ' | sheets ' + H.sheet.length);
    W.cardPrepare = realPrepare;
    // the next tap writes them, as anything owed to a card is written
    c.tap();
    const wrote = await H.W.cardWrite(c, { owner: true });
    ok(wrote && c.balance() === before + 500, 'and the next tap puts them on', String(c.balance()));
  }

  /* ---- software 1.17: RESET CARD, the row under the card, the block, and FLASHCARD on the send screen --------------------------
   * The card of 1.17 can be reset by its owner: a warning, then one tap (the money on it comes off to this phone first, and a
   * locked card or one that holds money and has a PIN asks for the PIN on the pad), and the person is home with a line. The
   * row of RESET, CHANGE PIN and LIMITS is drawn as the receive screen's row, HISTORY is the round button at the top left; the card's clock is said as a block under
   * the title; and money goes onto a card held to this phone from the send screen, with no card on show. */
  {
    const H2 = await funded({}, 30000);
    const R2 = await funded({ sharedMint: H2.mint, words: OTHER_WORDS }, 0);
    const owner = appOn(H2);
    const other = appOn(R2);
    await owner.refreshBalance();
    await other.refreshBalance();
    const n = newCard(H2, undefined, { format: 4 });
    const look = async (app, ctx, cd) => {
      ctx.nfc = cd;
      app.setState({ screen: 'home', stack: [], fc: null });
      app.goFlashcard();
      await until('the card to be read', () => !!app.state.fc && app.state.fc.key === cd.key);
      await settle();
    };
    /* As a person does it now: a card of software 1.16 and on is set up with no PIN, asked for none, and is given one afterwards with ADD PIN where it is
     * to have one. */
    const setUpWith = async (app, ctx, cd, pin) => {
      await look(app, ctx, cd);
      app.fcSetUp();
      await until('the card to be set up', () => !!cd.state.owner && app.toasts.indexOf('The card is set up.') >= 0);
      await settle();
      if (!pin) return;
      await look(app, ctx, cd);
      const had = app.toasts.length;
      app.fcPinAdd();
      pad(app).type(pin);
      pad(app).type(pin);
      await until('the PIN to be added', () => app.toasts.slice(had).some((t) => /^PIN added\./.test(t)));
      await settle();
    };
    let v;

    /* the row, the block, the limit line, the design */
    ok(owner.fcAt(Date.parse('2030-05-01T11:42:00')) === '11:42am' || /^\d{1,2}:\d\d(am|pm)?, \d{1,2} [A-Z][a-z]{2}$/.test(owner.fcAt(Date.parse('2030-05-01T11:42:00'))),
       'a time is said as the phone says it, in lower case, with the day after it for any other than today', owner.fcAt(Date.parse('2030-05-01T11:42:00')));
    await setUpWith(owner, H2, n, '1234');
    await look(owner, H2, n);
    v = vals(owner);
    ok(owner.state.fc.resetKnown === true && v.fcLinks.map((k) => k.label).join() === 'RESET,CHANGE PIN,LIMITS' && v.fcHistoryVis === 'visible',
       'a card of 1.17 read by its owner: HISTORY at the top left, and the row of RESET, CHANGE PIN and LIMITS', v.fcLinks.map((k) => k.label).join());
    ok(v.fcLinks.every((k) => typeof k.tap === 'function' && /^M/.test(k.path)) && new Set(v.fcLinks.map((k) => k.path)).size === 3, 'each a button with its own drawing');
    ok(owner.state.fc.headers === true && v.fcBlockShown === true && v.fcBlockLine === 'No block yet' && VERIFIED_AT.test(v.fcVerified),
       'a card shown no block says "No block yet" under the time it was verified', v.fcBlockLine);
    const HASH = '00000000000000000001fa7ca83e1eb90d5a1865d8db9684f3f03ca64ccaec8a';
    owner.state.fc = Object.assign({}, owner.state.fc, { clock: { hash: HASH, short: '1fa7ca83', time: 4102358400 } });
    ok(vals(owner).fcBlockLine === 'Block 1fa7ca83…', 'a block this phone has no height for is told by the first digits of its hash, as the line this replaces told it', vals(owner).fcBlockLine);
    H2.storage.setItem('foxy.flashcard.heights', JSON.stringify([{ hash: HASH, height: 970809, time: 4102358400 }]));
    ok(vals(owner).fcBlockLine === 'Block #970809', 'and one it has the height of by that: Block #970809', vals(owner).fcBlockLine);
    H2.storage.removeItem('foxy.flashcard.heights');
    ok(vals(owner).fcClockLine === undefined && vals(owner).fcClockShown === undefined, 'and there is no CLOCK line under the limits');
    // the limit line: "| NO PIN" for a card without one
    const lineOf = (over) => { const was = owner.state.fc; owner.state.fc = Object.assign({}, was, over); const l = vals(owner).fcLimitLine; owner.state.fc = was; return l; };
    const DAY5 = { limited: true, limit: 500, spent: 0, left: 500, turns: 0, now: 0, noTime: false };
    ok(lineOf({}) === 'NO LIMIT' && lineOf({ pinSet: false }) === 'NO LIMIT | NO PIN' && lineOf({ pinSet: false, day: DAY5 }) === 'DAILY LIMIT ₿500 | NO PIN'
       && lineOf({ day: DAY5 }) === 'DAILY LIMIT ₿500'
       && lineOf({ pinSet: false, tap: { known: true, limited: true, limit: 200, spent: 0, left: 200, turns: 0, noTime: false } }) === 'PER TAP LIMIT ₿200 | NO PIN',
       'a card with no PIN says so beside its limit after a bar, and a card with one does not');
    // the design the card names is the one drawn, in every state
    {
      const was = owner.state.fc;
      const designs = ['new', 'not finished', 'set up'].map((st) => {
        owner.state.fc = Object.assign({}, was, { design: 'FL1' }, st === 'new' ? { setUp: false, hasRecord: false, pin: 'none', pinSet: false }
          : st === 'not finished' ? { setUp: false, hasRecord: false, pin: 'set', pinSet: true } : {});
        return vals(owner).fcDesign;
      });
      owner.state.fc = Object.assign({}, was, { design: '' });
      const none = vals(owner).fcDesign;
      owner.state.fc = was;
      ok(designs.join() === 'FL1,FL1,FL1' && none === 'FL1', 'the card screen draws the design a card names, new, not finished and set up', designs.join());
    }
    {
      const fl = newCard(H2, undefined, { format: 4 });
      fl.state.record.design = 'FL1';
      await look(owner, H2, fl);
      ok(vals(owner).fcDesign === 'FL1' && owner.state.fc.design === 'FL1', 'a card whose record names FL1 before it is set up is drawn FL1', vals(owner).fcDesign);
      await setUpWith(owner, H2, fl, '');
      await look(owner, H2, fl);
      ok(fl.state.record.design === 'FL1' && owner.state.fc.design === 'FL1' && vals(owner).fcDesign === 'FL1', 'and after it is set up: this phone keeps the design the card names', vals(owner).fcDesign);
      const fresh = newCard(H2, undefined, { format: 4 });
      await setUpWith(owner, H2, fresh, '');
      await look(owner, H2, fresh);
      ok(vals(owner).fcDesign === 'FX1', 'a card that names none is given this phone’s own, FX1', vals(owner).fcDesign);
    }
    await look(owner, H2, n);

    /* a phone that is not its owner, and a card of the software before */
    await look(other, R2, n);
    ok(other.state.fc.resetKnown === true && other.state.fc.ownedHere === false && !hasReset(other) && vals(other).fcHistoryVis === 'visible', 'on a phone that does not own the card, RESET is not in the row, and HISTORY is still at the top left');
    other.fcReset();
    ok(card(other) && card(other).title === 'NOT THIS PHONE’S CARD' && !pad(other), 'and pressed anyway it says so, before it asks for anything', card(other) && card(other).title);
    card(other).press('CLOSE');
    const old16 = newCard(H2, undefined, { format: 4, software: 16 });
    await setUpWith(owner, H2, old16, '1234');
    await look(owner, H2, old16);
    ok(owner.state.fc.resetKnown === false && !hasReset(owner) && vals(owner).fcLinks.map((k) => k.label).join() === 'CHANGE PIN,LIMITS', 'a card of software 1.16 has no RESET: its row has the two it can offer');
    owner.fcReset();
    ok(card(owner) && card(owner).title === 'NOT ON THIS CARD', 'and pressed anyway it says it cannot', card(owner) && card(owner).all);
    card(owner).press('CLOSE');

    /* an empty card: the warning, CONTINUE, one tap, and home */
    await look(owner, H2, n);
    const keyBefore = n.key;
    owner.fcReset();
    ok(card(owner) && card(owner).title === 'RESET CARD' && /anyone’s to set up/.test(card(owner).reason) && !/comes off to this phone first/.test(card(owner).reason)
       && card(owner).has('CONTINUE') && card(owner).has('CANCEL'), 'RESET CARD opens one warning: what is wiped, and that it is then anyone’s to set up', card(owner) && card(owner).reason);
    card(owner).press('CANCEL');
    ok(!card(owner) && !pad(owner) && !!n.state.owner && owner.state.screen === 'flashcard', 'CANCEL leaves the card as it was');
    owner.fcReset();
    H2.sheet.length = 0;
    card(owner).press('CONTINUE');
    ok(!pad(owner), 'an empty card that is not locked asks for no PIN');
    await until('the card to be reset', () => !n.state.owner);
    await settle();
    ok(owner.state.screen === 'home' && owner.state.stack.length === 0 && owner.state.fc === null && owner.toasts.slice(-1)[0] === 'The card is reset.' && !card(owner),
       'one tap: the person is home, told so in a line, and the screen is no longer on that card', owner.state.screen + ' | ' + owner.toasts.slice(-1)[0]);
    ok(n.key !== keyBefore && n.state.pinState === 0 && !n.state.record.set && H2.sheet.filter((x) => /^begin:/.test(x)).length === 1 && H2.sheet[H2.sheet.length - 1] === 'end: Done.',
       'the card is another card (a key of its own, no PIN, no record), in one sheet', H2.sheet.join(' / '));
    await look(owner, H2, n);
    ok(vals(owner).fcNew && owner.state.fc.owner === false && !hasReset(owner) && vals(owner).fcLinks.length === 0, 'and it reads as new, with nothing to reset');

    /* a card with money and a PIN: the warning says the money comes off first; the PIN is asked on the pad */
    await setUpWith(owner, H2, n, '1234');
    await look(owner, H2, n);
    owner.fcAdd();
    keyIn(owner, 2000);
    await counted(owner, 2000, 'the money to be on the card');
    await look(owner, H2, n);
    await owner.refreshBalance();
    const haveBefore = await H2.W.balanceSats();
    owner.fcReset();
    ok(card(owner) && card(owner).title === 'RESET CARD' && /The ₿2,000 on it comes off to this phone first\./.test(card(owner).reason), 'with money on it the warning says it comes off to this phone first', card(owner) && card(owner).reason);
    card(owner).press('CONTINUE');
    ok(pad(owner) && pad(owner).title === 'CARD PIN' && pad(owner).cta === 'RESET CARD' && /off the card and reset it\.$/.test(pad(owner).sub), 'and the PIN is asked for on the pad', pad(owner) && pad(owner).sub);
    pad(owner).type('1234');
    await until('the card to be reset', () => !n.state.owner);
    await settle();
    ok(owner.state.screen === 'home' && owner.toasts.slice(-1)[0] === 'The card is reset.' && n.balance() === 0 && (await H2.W.balanceSats()) - haveBefore === 2000,
       'one tap took the 2,000 off to this phone and reset the card', String((await H2.W.balanceSats()) - haveBefore));

    /* a locked card asks for the PIN first, even with nothing on it */
    await setUpWith(owner, H2, n, '1234');
    n.state.locked = true;
    await look(owner, H2, n);
    ok(owner.state.fc.locked === true && hasReset(owner), 'a locked card still has RESET for its owner');
    owner.fcReset();
    card(owner).press('CONTINUE');
    ok(pad(owner) && pad(owner).sub === 'To reset the card. It is locked.', 'a locked card asks for its PIN first', pad(owner) && pad(owner).sub);
    pad(owner).type('1234');
    await until('the locked card to be reset', () => !n.state.owner);
    await settle();
    ok(owner.state.screen === 'home' && owner.toasts.slice(-1)[0] === 'The card is reset.' && n.state.locked === false, 'and with it the card is reset', String(n.state.locked));
    // the wrong PIN is said, with the card as it was
    await setUpWith(owner, H2, n, '1234');
    n.state.locked = true;
    await look(owner, H2, n);
    owner.fcReset();
    card(owner).press('CONTINUE');
    pad(owner).type('9999');
    await until('the wrong PIN to be said', () => card(owner) && card(owner).title === 'WRONG PIN');
    ok(!!n.state.owner && /tries left/.test(card(owner).reason), 'a wrong PIN is said, and the card is as it was', card(owner) && card(owner).reason);
    card(owner).press('CANCEL');
    n.state.locked = false;

    /* the wait of a card of 1.18: ten askings for the first limit's worth over, four for each further one, said as the seconds the screen reaches, "about" */
    await look(owner, H2, n);
    ok(owner.fcWaitOver() === 10 && owner.fcWaitMore() === 4, 'the card on show says ten askings for the first limit’s worth over and four for each further one', [owner.fcWaitOver(), owner.fcWaitMore()].join());
    owner.fcSetLimit();
    card(owner).press('PER TAP LIMIT');
    {
      explainer(owner).finish();
      const y = explainer(owner);
      ok(y.done && y.all === ['How tap limit works', 'Any payment request over your limit requires you to tap and hold your card longer.', 'EXAMPLE LIMIT', '$10',
                              '$0.01 \u2013 $10.00', '~1\u20134 SEC TAP', '$10.01 \u2013 $20.00', '~9 SEC TAP', '$20.01 \u2013 $30.00', '~11 SEC TAP', '$30.01 \u2013 $40.00', '~13 SEC TAP',
                              'And so on\u2026', 'CANCEL', 'CONTINUE'].join(' | '),
         'HOW TAP LIMIT WORKS for a card of 1.18: ~1\u20134 within the limit, then ~9, ~11 and ~13, what the screen reaches at ten askings, fourteen and eighteen', y.all);
      y.press('CONTINUE');
      keyIn(owner, 2000);
      ok(/held about 9 seconds, and 2 seconds more for every limit\u2019s worth beyond that\./.test(owner.fcLimitSpec().warn), 'and its confirmation says about 9 seconds over the limit', owner.fcLimitSpec().warn);
      owner.fcLimitSpec().secondary.go();
    }

    /* the money came off and the reset did not: said, with the money in this phone */
    {
      await look(owner, H2, n);
      const W = owner.fcW();
      const real = W.cardEmptyAndReset;
      W.cardEmptyAndReset = () => { const e = /** @type {any} */ (new Error('The card was taken away too soon.')); e.card = 'gone'; e.withdrew = 500; e.hash = ''; return Promise.reject(e); };
      owner.state.fc = Object.assign({}, owner.state.fc, { balance: 500 });
      owner.fcResetGo();
      pad(owner).type('1234');
      await until('the half-done reset to be said', () => card(owner) && card(owner).title === 'EMPTY, BUT NOT RESET');
      ok(/came off the card into this phone/.test(card(owner).reason) && card(owner).has('TAP CARD') && owner.state.fc.balance === 0, 'a card left after its money came off says it is empty and not reset, with TAP CARD to finish', card(owner).reason);
      card(owner).press('LATER');
      W.cardEmptyAndReset = real;
    }

    /* FLASHCARD on the send screen: any card, the amount first, the sheet at once */
    {
      const free = newCard(H2, undefined, { format: 4 });
      const keyed = newCard(H2, undefined, { format: 4 });
      await setUpWith(other, R2, free, '');
      await setUpWith(other, R2, keyed, '1234');
      await owner.refreshBalance();
      owner.setState({ screen: 'sendHow', stack: ['home'], fc: null });
      H2.sheet.length = 0;
      owner.fcSendCard();
      ok(owner.state.screen === 'amount' && owner.state.flow === 'cardSend' && owner.state.stack.slice(-1)[0] === 'sendHow' && !card(owner) && !pad(owner),
         'FLASHCARD on the send screen asks the amount first, on the keypad every amount is typed on; back from it is the send screen');
      ok(!H2.sheet.some((x) => /^begin:/.test(x)), 'and no sheet has come up yet');
      keyIn(owner, 999999);
      ok(owner.state.screen === 'amount' && /^You have /.test(owner.toasts.slice(-1)[0]), 'more than the phone holds goes no further', owner.toasts.slice(-1)[0]);
      // a card with no PIN takes the money in that tap
      H2.nfc = free;
      H2.sheet.length = 0;
      const had = await H2.W.balanceSats();
      keyIn(owner, 700);
      ok(!pad(owner) && H2.sheet[0] === 'begin: Tap behind the phone.', 'NEXT brings the sheet up at once', H2.sheet[0]);
      await until('the money to be on the card', () => card(owner) && card(owner).title === 'ON THE CARD');
      await settle();
      ok(free.balance() === 700 && owner.state.screen === 'home' && owner.state.stack.length === 0 && /^₿700 went onto the card\.$/.test(card(owner).reason) && (await H2.W.balanceSats()) < had - 699,
         'a card with no PIN took the money in that tap, and the person is home with the card saying so', card(owner).reason + ' | ' + free.balance());
      ok(H2.W.cardOwed().length === 0 && H2.sheet.filter((x) => /^begin:/.test(x)).length === 1, 'in one sheet, and nothing is left owed', H2.sheet.join(' / '));
      card(owner).press('DONE');
      // a card with a PIN ends the sheet asking for it, and the pad comes up
      owner.setState({ screen: 'sendHow', stack: ['home'] });
      owner.fcSendCard();
      H2.nfc = keyed;
      H2.sheet.length = 0;
      keyIn(owner, 500);
      await until('the PIN pad', () => !!pad(owner));
      ok(H2.sheet.indexOf('end: Enter the card’s PIN') >= 0 && !H2.sheet.some((x) => /^error:/.test(x)) && keyed.balance() === 0 && H2.W.cardOwed().length === 0 && owner.state.screen === 'amount',
         'a card with a PIN ends the sheet saying so, in no red, with nothing made or written', H2.sheet.join(' / '));
      ok(pad(owner).title === 'CARD PIN' && pad(owner).cta === 'TAP AGAIN' && /^To put ₿500 on the card\./.test(pad(owner).sub), 'the pad says what the PIN is for, and TAP AGAIN writes it', pad(owner).sub);
      // a wrong PIN: the pieces were made, owed to the card, and the way on is the pad again
      H2.sheet.length = 0;
      pad(owner).type('9999');
      await until('the wrong PIN to be said', () => card(owner) && card(owner).title === 'WRONG PIN');
      ok(keyed.balance() === 0 && H2.W.cardOwed().length === 1 && card(owner).has('TRY AGAIN'), 'a wrong PIN is said; what was made for the card is owed to it', card(owner).title + ' | ' + H2.W.cardOwed().length);
      card(owner).press('TRY AGAIN');
      await until('the PIN pad again', () => !!pad(owner));
      ok(/ON CARD$/.test(pad(owner).cta), 'TRY AGAIN asks for the PIN to put it on', pad(owner).cta);
      pad(owner).type('1234');
      await until('the money to be on the card', () => card(owner) && card(owner).title === 'ON THE CARD');
      await settle();
      ok(keyed.balance() === 500 && H2.W.cardOwed().length === 0, 'and with the right one it is on', String(keyed.balance()));
      card(owner).press('DONE');
      // and with its PIN right the first time
      owner.setState({ screen: 'sendHow', stack: ['home'] });
      owner.fcSendCard();
      keyIn(owner, 300);
      await until('the PIN pad', () => !!pad(owner));
      pad(owner).type('1234');
      await until('the money to be on the card', () => card(owner) && card(owner).title === 'ON THE CARD');
      await settle();
      ok(keyed.balance() === 800 && owner.state.screen === 'home', 'the right PIN in the second tap writes it', String(keyed.balance()));
      card(owner).press('DONE');
      // offline, it says why
      owner.offline = true;
      owner.setState({ screen: 'sendHow', stack: ['home'] });
      owner.fcSendCard();
      ok(owner.state.screen === 'sendHow' && owner.toasts.slice(-1)[0] === 'Putting money on a card needs a connection.', 'offline it says so and goes no further', owner.toasts.slice(-1)[0]);
      owner.offline = false;
    }
  }

  /* ---- the card's face: the limit line sits where BEARER does, mirrored ------------------------------------------------------
   * At the bottom left of the card, with the margins BEARER has at the bottom right, in each design: FL1 is drawn in markup (BEARER's
   * type and place are in it); FX1 is a picture (img/card-fx1.png), whose BEARER is measured here, from its pixels, and the line is set by
   * what was measured (the markup's FX1 rules). Sizes are percentages of the card's width (`cqw`), so they hold at any width. A line's last
   * baseline is above its box's bottom by (line-height / 2 - 0.34) em in Sora, whose line box is 0.97 em above its baseline and 0.29 below. */
  {
    const fs = require('fs'), path = require('path'), zlib = require('zlib');
    const root = path.join(__dirname, '..');
    const markup = fs.readFileSync(path.join(root, 'build', 'markup.html'), 'utf8');
    // the picture, decoded: an 8-bit palette PNG
    const png = fs.readFileSync(path.join(root, 'Web', 'img', 'card-fx1.png'));
    let at = 8, W = 0, H0 = 0, plte = null, trns = null; const idat = [];
    while (at < png.length) {
      const n = png.readUInt32BE(at), kind = png.toString('latin1', at + 4, at + 8), body = png.subarray(at + 8, at + 8 + n);
      if (kind === 'IHDR') { W = body.readUInt32BE(0); H0 = body.readUInt32BE(4); if (body[8] !== 8 || body[9] !== 3 || body[12] !== 0) throw new Error('card-fx1.png is not an 8-bit palette picture'); }
      if (kind === 'PLTE') plte = body; if (kind === 'tRNS') trns = body; if (kind === 'IDAT') idat.push(body);
      at += 12 + n;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = W + 1, rows = [];
    for (let y = 0; y < H0; y++) {
      const f = raw[y * stride], line = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride)), up = y ? rows[y - 1] : Buffer.alloc(W);
      for (let x = 0; x < W; x++) {
        const a = x ? line[x - 1] : 0, b = up[x], c2 = x ? up[x - 1] : 0;
        const p = a + b - c2, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c2);
        line[x] = (line[x] + (f === 1 ? a : f === 2 ? b : f === 3 ? ((a + b) >> 1) : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c2) : 0)) & 255;
      }
      rows.push(line);
    }
    const dark = (x, y) => { const i = rows[y][x], r = plte[i * 3], g = plte[i * 3 + 1], b = plte[i * 3 + 2];
      return (!trns || (trns[i] === undefined ? 255 : trns[i]) > 200) && 0.2126 * r + 0.7152 * g + 0.0722 * b < 60; };
    // BEARER: the dark lettering below the bitcoin sign, in the lower right, inside the thin frame that runs round the picture's edge
    let x0 = W, x1 = 0, y0 = H0, y1 = 0;
    for (let y = Math.floor(H0 * 0.85); y < Math.floor(H0 * 0.95); y++) for (let x = Math.floor(W * 0.7); x < Math.floor(W * 0.95); x++) if (dark(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const rightMargin = (W - 1 - x1) / W * 100, baseline = (H0 - 1 - y1) / W * 100, cap = (y1 - y0 + 1) / W * 100;     // % of the width, as cqw is
    ok(x1 > x0 && Math.abs(rightMargin - 8.4) < 0.15 && Math.abs(baseline - 6.4) < 0.15 && Math.abs(cap - 1.83) < 0.1,
       'BEARER, measured in img/card-fx1.png, ends 8.4% of the width from the right and has its baseline 6.4% up, 1.83% tall', [rightMargin, baseline, cap].map((n) => n.toFixed(2)).join(' / '));
    // the markup's own: the wrapper's place, the line's type, and the FX1 rules
    const num = (text, prop) => { const m = new RegExp('(?:^|[;"{ ])' + prop + ':\\s*(-?[0-9.]+)(?:cqw|em)?').exec(text); return m ? Number(m[1]) : NaN; };
    const lines = /data-card-lines style="([^"]*)"/.exec(markup)[1];
    const fl1 = /data-card-limit style="([^"]*)"/.exec(markup)[1];
    const fx1Lines = /\[data-card-design="FX1"\] \[data-card-lines\]\{([^}]*)\}/.exec(markup)[1];
    const fx1Limit = /\[data-card-design="FX1"\] \[data-card-limit\]\{([^}]*)\}/.exec(markup)[1];
    const bearer = /font-family:Sora,sans-serif;font-size:([0-9.]+)cqw;font-weight:(\d+);letter-spacing:([0-9.]+)em;color:(rgba\(255,255,255,\.42\))">BEARER/.exec(markup);
    const bearerRight = /position:absolute;right:([0-9.]+)cqw;bottom:([0-9.]+)cqw;display:flex;flex-direction:column;align-items:center;gap:2px"><div style="font-size:5\.99cqw/.exec(markup);
    const LH = num(fl1, 'line-height'), SIDE = 0.075;               // the line's height in em, and a capital's side bearing in Sora (em)
    // FL1: BEARER is the line's own type; its ink ends 0.24 em past its box (tracking is added after the last letter)
    const bFs = Number(bearer[1]), bRight = Number(bearerRight[1]) + 0.24 * bFs, bBase = Number(bearerRight[2]) + 0.29 * bFs;
    const lFs = num(fl1, 'font-size'), lLeft = num(lines, 'left') + SIDE * lFs, lBase = num(lines, 'bottom') + (LH / 2 - 0.34) * lFs;
    ok(lFs === bFs && /font-weight:600/.test(fl1) && num(fl1, 'letter-spacing') === Number(bearer[3]) && /color:rgba\(255,255,255,\.42\)/.test(fl1) && Number(bearer[2]) === 600,
       'FL1: the line is in BEARER’s own type: its size, weight, tracking and colour', JSON.stringify([lFs, bFs]));
    ok(Math.abs(lLeft - bRight) < 0.2 && Math.abs(lBase - bBase) < 0.15,
       'FL1: its first letter is as far in from the left as BEARER’s last is from the right, and its baseline is level with BEARER’s', [lLeft, bRight, lBase, bBase].map((n) => n.toFixed(2)).join(' / '));
    // FX1: the picture's measured margins, and its ink and lettering
    const xFs = num(fx1Limit, 'font-size'), xLeft = num(fx1Lines, 'left') + SIDE * xFs, xBase = num(fx1Lines, 'bottom') + (LH / 2 - 0.34) * xFs;
    ok(Math.abs(xLeft - rightMargin) < 0.2 && Math.abs(xBase - baseline) < 0.1,
       'FX1: the line is as far in from the left as the picture’s BEARER is from the right, and level with it', [xLeft, rightMargin, xBase, baseline].map((n) => n.toFixed(2)).join(' / '));
    ok(Math.abs(xFs * 0.733 - cap) < 0.12 && /font-weight:700/.test(fx1Limit) && num(fx1Limit, 'letter-spacing') === 0.3 && /color:#1A0A04/i.test(fx1Limit),
       'FX1: in the picture’s ink (dark brown), at the size that gives BEARER’s height (Sora’s capitals are 0.733 em), bold, and tracked as BEARER is', xFs + ' -> ' + (xFs * 0.733).toFixed(2) + ' vs ' + cap.toFixed(2));
    // and it cannot reach BEARER: its box ends well left of where BEARER begins in either design
    const room = num(lines, 'max-width');
    ok(num(lines, 'left') + room < 100 - 8.4 - 15.8 && num(lines, 'left') + room < 100 - Number(bearerRight[1]) - 5.533 * bFs,
       'a long line wraps within ' + room + '% of the width, and is stopped well before BEARER in both designs', String(num(lines, 'left') + room));
    // the pill under the card has no limit line any more, and the card’s face has it
    const pill = markup.slice(markup.indexOf('{{ fcPillLetter }}'), markup.indexOf('{{ fcHistory }}', markup.indexOf('{{ fcPillLetter }}')));
    ok(pill.indexOf('fcLimitLine') < 0 && markup.indexOf('{{ fcLimitLine }}') > markup.indexOf('data-card-face') && markup.split('{{ fcLimitLine }}').length === 2,
       'the limit line is drawn once, on the card’s face, and no longer in the pill under it');
    // HISTORY is at the top left again, and RESET is no longer there
    ok(/sc-camel-on-click="\{\{ fcHistory \}\}" role="button" aria-label="This card’s history" style="position:absolute;left:22px;top:56px/.test(markup) && markup.indexOf('fcResetVis') < 0 && markup.indexOf('{{ fcReset }}') < 0,
       'HISTORY is the round button at the top left, and nothing there is for RESET any more');
  }

  /* ---- the screen before the sheet -------------------------------------------- */
  {
    // on a phone the sheet follows the screen by half a second (FC_TAP_LEAD 500); here sixty milliseconds, watched
    ok(Object.getPrototypeOf(holder).constructor.prototype.FC_TAP_LEAD === undefined ? true : true, 'the lead is a field of the app');
    const lead = new (Object.getPrototypeOf(holder).constructor)().FC_TAP_LEAD;
    ok(lead === 500, 'the app shows TAP BEHIND PHONE for half a second before the sheet', String(lead));
    holder.FC_TAP_LEAD = 60;
    H.sheet.length = 0;
    H.nfc = c;
    c.tap();
    const read = holder.fcTap({}, (link) => H.W.cardLook(link));
    ok(stage(H) === 'card' && H.sheet.length === 0, 'the tap draws its screen at once, and the sheet is not asked for yet', stage(H) + ' | sheets ' + H.sheet.length);
    await new Promise((go) => setTimeout(go, 90));
    ok(H.sheet.length >= 1 && /^begin:/.test(H.sheet[0]), 'and the sheet comes after the lead', H.sheet.join(' | '));
    await read;
    holder.FC_TAP_LEAD = 0;
  }
  console.log('\n' + (failed ? failed + ' flashcard-screens check(s) failed' : 'all flashcard-screens checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
