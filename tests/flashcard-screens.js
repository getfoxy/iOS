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
 * A payer's share of a split bill is paid by the same CARD (the split's own parts, build/app/17-split-bill-and-copy.js and
 * 20-split-values.js, are added with `appOn(ctx, start, { split: true })`).
 *
 * The render snapshots pin how these look. This pins what they do. */
const { funded, newCard, binaryLoad, history, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const { appOn, until, pad, card, family, explainer, stage, behind, watchBehind, vals, settle, keyIn, limits, named, restore } = require('./flashcard-ui-kit');
/* What the card's screen said and its HISTORY says now (26f-flashcard.js, `fcHistNotes`): its limit as the face had it, and how
 * fresh the mint's word is. */
const limitOf = (a) => a.fcLimitWords(a.state.fc);
const verOf = (a, i) => a.fcVerifiedWords(a.state.fc)[i || 0];

/* The app's own announcement of a payment (12-receive.js) and the queue that raises them one at a time (15-paid-wake-keyboard.js), lifted out of their
 * files and given to an app made of the card's parts, which has neither. A confirmation raised is the screen going to 'paid' with its amount. */
const withConfirmations = (app) => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'build', 'app', f), 'utf8');
  const lift = (src, sig) => {
    const from = src.indexOf('\n  ' + sig) + 1;
    return src.slice(from, src.indexOf('\n  }\n', from) + 5);
  };
  const receive = read('12-receive.js'), wake = read('15-paid-wake-keyboard.js');
  const body = [lift(receive, 'announcePayment(ev) {'), lift(wake, 'nextPaidScreen() {'), lift(wake, 'queueLater() {'), lift(wake, 'queuedEv(next) {'), lift(wake, 'paidDismissed() {')].join(',');
  const lifted = new Function('window', 'document', 'CONFIRM_SCREENS', 'return {' + body + '}')(
    { FoxyWallet: { notify: () => {} } }, { visibilityState: 'visible' }, []);
  Object.assign(app, lifted);
  app.SPLIT_SCREENS = [];
  app.QUEUE_RETRY_MS = 40;
  app.PASTE_SETTLE_MS = 0;
  app.offerSecureFoxy = () => {};
  // as it is in the app: a confirmation is dismissed from its own screen
  app.dismissPaid = () => { app.state.screen = 'home'; app.paidDismissed(); };
  return app;
};

/* A limit's three steps, as a person takes them: the warning's CONTINUE, an amount on the keypad
 * (or NO LIMIT under it, for 0), and the confirmation's CONFIRM. */
const takeLimitSteps = (app, sats, which) => {
  // CARD LIMITS asks which of the card's limits first
  if (limits(app)) limits(app).press(which || 'PER TAP LIMIT');
  // the limit on one tap opens HOW TAP LIMIT WORKS, whose buttons come when it has played; the daily limit's warning has CONTINUE at once
  if (explainer(app)) { explainer(app).finish(); explainer(app).press('CONTINUE'); } else card(app).press('CONTINUE');
  if (sats > 0) keyIn(app, sats); else app.fcLimitConfirm(0);
  app.fcLimitSpec().go();
};
/* Money put on a card, or taken off it, from its own screen is said by that screen and not by a card raised over it: the balance on it counts to
 * what the card holds (`fcRollStart`). Waits for the count to end, with `sats` on the card. */
const counted = (app, sats, what) => until(what, () => !!app.state.fc && app.state.fc.balance === sats && !app.state.fcRoll);
// whether the card's MENU has RESET in it (a card of software 1.17 and on, its owner's phone)
const hasReset = (app) => vals(app).fcMenuItems.some((k) => k.label === 'RESET');
// the card's MENU, at the top right: its rows, and what LIMITS says under it (what the card pays without its PIN)
const menuOf = (v) => (v.fcMenuItems || []).map((k) => k.label).join();
// HISTORY, the card's own history, is the first row of the card's MENU; the round button at the top left is HOME
const histFirst = (v) => ((v.fcMenuItems || [])[0] || {}).label === 'HISTORY' && typeof v.fcHome === 'function';
const limitsSub = (v) => ((v.fcMenuItems || []).find((k) => k.label === 'LIMITS') || {}).sub || '';
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
  /* The list of cards this phone loaded switched off (FC_RECOVERABLE) for the first part of this suite, as the screens
   * were drawn before every card could be taken back: no screen for no card, and a card that leaves takes its screen
   * with it. It ships on, and is switched on below ("with the switch on"); a card is set up recoverable either way. */
  holder.FC_RECOVERABLE = false;
  const till = appOn(R, { screen: 'confirm' });
  await holder.refreshBalance();
  const c = newCard(H);

  /* ---- MENU > FLASHCARD, and a new card ------------------------------------ */
  holder.goFlashcard();
  ok(H.sheet.length === 1 && /^begin: Tap behind the phone\.$/.test(H.sheet[0]), 'FLASHCARD in the menu asks for the card at once, with no screen to read first', H.sheet[0]);
  await settle();
  ok(holder.state.screen === 'home' && !holder.state.fc && !card(holder) && stage(H) === 'cardLearn',
     'the sheet dismissed, with no card ever tied to this phone: the person is where they were, with no screen for no card but the one that says what a Foxy Card is (tests/card-cancel.js)');
  H.window.document.getElementById('foxy-stage').remove();
  H.nfc = c;
  holder.goFlashcard();
  await until('the new card to be read', () => !!holder.state.fc);
  ok(holder.state.screen === 'flashcard' && holder.state.stack.slice(-1)[0] === 'home', 'a card tapped, and the screen is that card; back from it is where they were');
  let v;
  v = vals(holder);
  ok(v.fcHas && v.fcNew && !v.fcUsable && v.fcCheck === 'No PIN yet' && v.fcBalance === '₿ 0' && v.fcSub === '' && !stage(H),
     'a card out of its packet reads as new, with one thing to do', v.fcCheck);
  ok(holder.fcWelcomeCard(holder.state) && v.fcSpin === '',
     'a new card is met by the welcome over its screen, whose own card turns: the screen’s picture under it is not a second turntable', JSON.stringify(v.fcSpin));
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
  ok(v.fcUsable && !v.fcNew && v.fcCheck === '' && holder.state.fc.mine && holder.state.fc.recoverable && H.W.cardsList().length === 1
     && /^0[23]/.test(c.state.record.refund),
     'one tap later it has a PIN and can be taken back if it is lost, with nothing asked: a key of this phone’s is on it, and this phone lists it');
  ok(v.fcPill === true && v.fcPillMint === 'm.test' && v.fcMintName === 'M.TEST' && v.fcPillRows[0].big === '0' && v.fcBalance === '₿ 0' && v.fcFields === undefined,
     'and the screen says its mint and what it holds in home’s own pill', v.fcPillMint + ' | ' + v.fcBalance);
  ok(limitOf(holder) === 'NO LIMIT' && holder.fcHistNotes(holder.state.fc).some((r) => r.kind === 'limit' && r.name === 'No limit') && v.fcLimitShown === undefined && v.fcDayShown === undefined && v.fcDayLeft === undefined,
     'and its HISTORY, not its screen, says it has no limit, with nothing to say of a day: the card screens have no daily limit', limitOf(holder));
  ok(menuOf(v) === 'HISTORY,RENAME CARD,LIMITS,CHANGE PIN,TRANSFER' && v.fcMenuShown === true && v.fcCloseShown === false && v.fcRowShown === undefined && v.fcButtons === undefined
     && histFirst(v) && v.fcResetVis === undefined && v.fcReset === undefined
     && typeof v.fcAdd === 'function' && typeof v.fcWithdraw === 'function' && typeof v.fcMenuItems[0].tap === 'function' && !hasReset(holder),
     'with DEPOSIT (`fcAdd`) and WITHDRAW, HISTORY first in its MENU and HOME at the top left, no SCAN or PASTE, and a MENU of HISTORY, LIMITS, CHANGE PIN and TRANSFER: RESET is in the menu for a card of 1.17 and not for this older one', menuOf(v));
  ok(v.fcButtons === undefined && !v.fcMenuItems.some((k) => k.label === 'SWAP'),
     'no SWAP on a card of one currency, and no row at all: the room is the card’s picture’s', menuOf(v));
  ok(v.fcFaceLines === false && v.fcCardCap === '0px', 'and nothing is drawn under the card: no badge, and its limit is in its HISTORY');
  ok(!holder.fcWelcomeCard(holder.state) && v.fcSpin === '1' && v.fcPersp === '1100px',
     'the card’s picture on its own screen stands on the welcome’s turntable (26j-card-wheel.js, `fcSpinOn`)', JSON.stringify([v.fcSpin, v.fcPersp]));
  ok(v.fcDesign === 'FX1' && holder.fcDesignOf({ design: 'zz9' }) === 'FL1' && holder.fcDesignOf({ design: 'EL1' }) === 'EL1' && holder.fcDesignOf({}) === 'FL1' && holder.fcDesignOf({ design: 'fl1' }) === 'FL1'
     && Object.keys(holder.FC_DESIGNS).every((k) => /^[A-Z0-9]{3}$/.test(k)),
     'a card this phone set up is drawn in Foxy’s design FX1; one that names no design, or one this build cannot draw, is drawn in FL1; every design has a code of three characters', v.fcDesign);
  ok(VERIFIED_AT.test(verOf(holder)) && v.fcVerifiedShown === undefined, 'and its HISTORY, not its title, says it is verified, and at what time: a card with nothing on it has nothing a mint could dispute', verOf(holder));
  ok(v.fcBlockShown === undefined && v.fcBlockLine === undefined && v.fcClockShown === undefined && v.fcClockLine === undefined,
     'no card has a block line or a CLOCK line on its screen any more', v.fcBlockLine);

  /* ---- add funds: the owner's phone, with no PIN ------------------------------- */
  c.tap();
  holder.fcAdd();
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.state.flow === 'cardAdd' && holder.state.unit === 'SATS' && holder.state.stack.slice(-1)[0] === 'flashcard',
     'ADD FUNDS asks how much on the SET AMOUNT screen (in sats here: this phone has no price to say dollars at)');
  // (with a connection, more than the phone holds is asked for by invoice: the DEPOSIT section below)
  holder.offline = true;
  keyIn(holder, 99999);
  ok(!pad(holder) && holder.state.screen === 'amount' && holder.toasts.indexOf('You have ₿6,000.') >= 0, 'with no connection, more than the phone holds goes no further');
  holder.offline = false;
  {
    /* The card's room, asked of the wallet for the card read a moment ago: the keypad refuses an amount the card has no room for
     * (`fcLoadFits`), at NEXT in the wallet's own words, and the card is not asked, nor any money made. FLASHCARD from the send
     * screen has no card on show and is not asked about room. */
    const real = holder._fcCard;
    const FULL = 'The card has no room for that. Take some money off it first.';
    const roomy = holder.fcLoadFits(100);
    ok(!!roomy && roomy.ok === true, 'a card with its places free has room for an amount typed', JSON.stringify(roomy));
    holder._fcCard = Object.assign({}, real, { info: Object.assign({}, real.info, { empty: 3, spent: 0 }) });
    const fit = holder.fcLoadFits(100);
    ok(!!fit && fit.ok === false && fit.why === FULL, 'a card with three places free has none: the wallet’s answer, in its own words', JSON.stringify(fit));
    holder.toasts.length = 0;
    c.sent.length = 0;
    keyIn(holder, 100);
    ok(!pad(holder) && holder.state.screen === 'amount' && holder.toasts.indexOf(FULL) >= 0 && H.W.cardOwed().length === 0 && !c.sent.length,
       'NEXT on it goes no further and says so, before a PIN, a tap or any money made', holder.toasts.join(' | '));
    holder._fcCard = real;
    const other = holder.state.fc;
    holder.state.fc = null;
    ok(holder.fcLoadFits(100) === null, 'with no card on show there is nothing to ask about (FLASHCARD from the send screen)');
    holder.state.fc = Object.assign({}, other, { key: 'not-this-card' });
    ok(holder.fcLoadFits(100) === null, 'nor for a card other than the one read last');
    holder.state.fc = other;
  }
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
  ok(vals(holder).fcCheck === '' && VERIFIED_AT.test(verOf(holder)), 'the mint is asked about what the card says it holds, and the screen says so once, under its title');

  /* ---- under the title: how fresh the mint's word on the card is -------------- */
  {
    ok(verOf(holder) === 'Verified At ' + holder.fcAt(H.W.cardCheckedAt(holder._fcCard)) && H.W.cardCheckedAt(holder._fcCard) > 0, 'asked just now, the screen says the time under its title', verOf(holder));
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
    ok(holder.state.fc.check === 'off' && verOf(holder) === 'Verified At ' + holder.fcAt(askedAt), 'with no connection two hours later, it says the time it was last verified', verOf(holder));
    // a phone that never had the mint's word on these pieces cannot say it has
    const kept = H.storage.getItem('foxy.flashcard.checked');
    H.storage.setItem('foxy.flashcard.checked', '{}');
    await reread();
    ok(verOf(holder) === 'Not Verified', 'and a phone that never asked about these pieces says the card is not verified', verOf(holder));
    // nor one whose word was about other pieces than the card holds now
    const other = JSON.parse(kept);
    Object.keys(other).forEach((k) => { other[k].nonces = other[k].nonces.slice(1); });
    H.storage.setItem('foxy.flashcard.checked', JSON.stringify(other));
    await reread();
    ok(verOf(holder) === 'Not Verified', 'nor one whose word did not cover every piece on it', verOf(holder));
    H.storage.setItem('foxy.flashcard.checked', kept);
    H.deaf = false;
    H.window.Date.now = realW; Date.now = realN;
    await reread();
    await until('the mint to be asked again', () => holder.state.fc.check === 'ok');
    ok(VERIFIED_AT.test(verOf(holder)) && verOf(holder) !== 'Verified At ' + holder.fcAt(askedAt - 1e9), 'and with the connection back it is verified again', verOf(holder));
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
  await until('the money to be said to be waiting', () => card(holder) && card(holder).title === 'TAP AGAIN');
  c.send = send1;
  H.nfc = c;
  // TAP AGAIN (1e): the money that waits for the card, said as the amount, with the lock and TAP CARD or LATER
  ok(card(holder).has('TAP CARD') && card(holder).has('LATER') && card(holder).scheme === '1e' && card(holder).amount === '₿500'
     && card(holder).reason === 'The card wasn\u2019t read. This money is still waiting to go onto it.' && card(holder).chip === 'Only this card can receive it.'
     && c.balance() === 2000 && H.W.cardOwed().length === 1
     && H.sheet.some((x) => /^again: Hold for the rest\.$/.test(x)),
     'a card taken away before it was written to: the same sheet asked for it again, and with no card the 500 is kept for it and said', card(holder).reason);
  v = vals(holder);
  ok(v.fcNotes.length === 0 && holder.fcHistNotes(holder.state.fc).filter((n) => n.kind === 'owed' && /₿500 is waiting to go onto this card/.test(n.name)).length === 1 && v.fcMenuRingInk === '#F7931A',
     'the card’s HISTORY carries a row for it, and the menu turns amber; the screen has no line', holder.fcHistNotes(holder.state.fc).map((n) => n.name).join(' | '));
  c.tap();
  card(holder).press('TAP CARD');
  ok(!pad(holder), 'TAP CARD asks for no PIN: this phone owns the card');
  await counted(holder, 2500, 'the 500 to be on the card');
  ok(c.balance() === 2500 && H.W.cardOwed().length === 0 && !holder.fcHistNotes(holder.state.fc).some((n) => n.kind === 'owed') && vals(holder).fcMenuRing === 'none' && !card(holder) && holder.state.screen === 'flashcard',
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
  ok(behind(R) && behind(R).look === 'pin' && behind(R).title === 'ENTER PIN' && behind(R).scheme === '1a' && !behind(R).loop && !behind(R).cancel,
     'the screen behind the pad stays up, as ENTER PIN on the light blue (1a), with no arrow and no CANCEL', JSON.stringify(behind(R)));
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
  ok(atMint && atMint.kind === 'card' && atMint.look === 'verify' && atMint.title === 'PAYING' && atMint.scheme === '1c' && !atMint.cancel
     && !atMint.loop && atMint.amount === '\u20bf1,000',
     'behind it, our own screen said PAYING over the amount, in contact (1c), with no CANCEL', JSON.stringify(atMint));
  const changeAt = looks.filter((x) => x.look === 'change')[0];
  ok(looks.path() === 'hold > keep > verify > change > verify' && changeAt && changeAt.at <= R.sheet.indexOf('again: Hold for change.')
     && looks.titles() === 'TAP TO PAY > PAYING > PAYING > TAP FOR CHANGE > RECEIVING' && looks.schemes() === '1a > 1c > 1c > 1a > 1c',
     'the payment’s screens in turn: TAP TO PAY, PAYING while the card is in contact and signs and while the mint is asked with the card still there, TAP FOR CHANGE from the moment the card is asked for again (before it is found), and RECEIVING while the change goes on',
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
  // like cash, as the cards of this part are: none of them is on the list of cards to take back below
  await H.W.cardSetUp(c2, { pin: '1234', recoverable: false });
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
  await until('the change to be said to be still waiting', () => card(till) && card(till).title === 'TAP AGAIN' && /wasn\u2019t read/.test(card(till).reason));
  clearInterval(watch);
  sheets = R.sheet.filter((x) => /^begin:/.test(x)).length;
  ok(bare === 0 && seenConfirm && sheets === 2,
     'the sheet gone with the change still to take: TAP FOR CHANGE stays up through the pause and the second sheet, and the till’s home screen is never what is showing between the payment and its change',
     JSON.stringify({ bare, seenConfirm, sheets }));
  ok(released.length === 0, 'and PAYMENT RECEIVED is still held: the change is waiting, and the card says so', released.join());
  c2.send = send2;
  const owed = R.W.cardOwed().reduce((n, r) => n + r.sats, 0);
  ok((await R.W.balanceSats()) === 1200 && owed === 824 && c2.balance() === 0
     && card(till).reason === 'The card wasn\u2019t read. This money is still waiting to go back onto it. No PIN is needed.' && card(till).amount === '\u20bf824'
     && card(till).scheme === '1e' && card(till).has('TAP CARD') && card(till).has('LATER'),
     'a payment whose second tap reads no card: the payment stands, and the change is said to be still waiting, with TAP CARD to try again', card(till).reason);
  // a fresh card that has never paid: it has no change note, so it asks for the PIN after all
  const cElse = newCard(H);
  await H.W.cardSetUp(cElse, { pin: '1234', recoverable: false });
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

  /* ---- a payment whose card is taken away before it signs: CARD LOST at once, then TAP AGAIN (1f) ----------------------------
   * The card leaves before it is asked for anything; the same sheet asks for it again and is dismissed with no card. The screen
   * behind the sheet says CARD LOST (1g) from the moment it went, and settles on TAP AGAIN for a payment (1f): nothing paid, the
   * money still on the card, and TAP CARD to try again, which pays. */
  {
    // (seeds of their own: a seed used again on the one mint would make the same outputs as its other wallet)
    const HG = await funded({ sharedMint: H.mint, words: 'hamster diagram private dutch cause delay private meat slide toddler razor book' }, 2000);
    const RG = await funded({ sharedMint: H.mint, words: 'vessel ladder alter error federal sibling chat ability sun glass valve picture' }, 0);
    const tillG = appOn(RG, { screen: 'confirm' });
    const cg = newCard(HG);
    await HG.W.cardSetUp(cg, { pin: '1234' });
    await binaryLoad(HG, cg, 512);
    tillG.state.screen = 'confirm';
    tillG.asking = 512;
    RG.nfc = cg;
    const rb = await RG.W.balanceSats();
    const seenG = watchBehind(tillG, RG);
    tillG.payByCard();
    await until('the PIN pad', () => !!pad(tillG));
    const tapG = cg.tap, sendG = cg.send;
    // the tap with the PIN leaves before the card is asked for its PIN, and the sheet that asks again finds no card
    cg.tap = () => { tapG(); cg.leaveBefore('40', 1); cg.tap = tapG; };
    cg.send = (x) => sendG(x).then((r) => r, (err) => { RG.nfc = null; throw err; });
    pad(tillG).type('1234');
    await until('TAP AGAIN for the payment', () => !!card(tillG) && card(tillG).scheme === '1f');
    seenG.stop();
    cg.send = sendG;
    RG.nfc = cg;
    const lostAt = seenG.filter((x) => x.scheme === '1g')[0];
    ok(!!lostAt && lostAt.title === 'CARD LOST' && lostAt.chip === 'Your money is still on your card.' && seenG[seenG.length - 1].scheme === '1g',
       'the card taken away: CARD LOST (1g) at once, the shield, and it stays until the tap ends', seenG.path() + ' | ' + seenG.schemes());
    const fg = card(tillG);
    ok(fg.title === 'TAP AGAIN' && fg.reason === 'The card wasn\u2019t read. Nothing has been paid yet.' && fg.chip === 'Your money is still on your card.'
       && fg.amount === lostAt.amount && !!fg.amount && fg.buttons.join() === 'TAP CARD,CANCEL' && !behind(RG),
       'and it settles on TAP AGAIN (1f): the amount, nothing paid, the money on the card, TAP CARD and CANCEL', JSON.stringify(fg));
    ok((await RG.W.balanceSats()) === rb && cg.balance() === 512, 'nothing moved', String((await RG.W.balanceSats()) - rb));
    fg.press('TAP CARD');
    await until('the PIN pad again', () => !!pad(tillG));
    cg.tap();
    pad(tillG).type('1234');
    await until('the payment to be made', () => tillG.state.screen === 'home' && !stage(RG));
    await settle();
    ok((await RG.W.balanceSats()) === rb + 512 && cg.balance() === 0, 'TAP CARD takes the payment up again, and it is paid', String((await RG.W.balanceSats()) - rb));
  }

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
    ok(seen.path() === 'hold > keep > pin > again > keep > again > keep > remove' && again1 && again1.title === 'CARD LOST' && again1.scheme === '1g' && !again1.loop
       && RT.sheet.slice(0, again1.at).filter((x) => /^again: Hold/.test(x)).length === 0 && seen[seen.length - 1].title === 'CHECKING' && seen[seen.length - 1].scheme === '1d'
       && seen.schemes() === '1a > 1c > 1a > 1a > 1c > 1g > 1c > 1d',
       'the card lost part way through signing: CARD LOST (1g) from the moment it is lost (before the sheet has asked for it again), then PAYING (1c) when it is found, and CHECKING (1d) once it has signed (the first tap having ended asking for the PIN, which the screen waited under the pad as ENTER PIN)',
       seen.path() + ' | ' + seen.titles());
    const got = (await RT.W.balanceSats()) - rb;
    const begins = RT.sheet.filter((x) => /^begin:/.test(x));
    const agains = RT.sheet.filter((x) => /^again:/.test(x));
    ok(got === 1536 && c3.balance() === 0 && begins.length === 1 && agains.join() === 'again: Hold to finish paying' && !pad(till2),
       'a payment the card leaves part way through: the same sheet asks for the card again, with no PIN, and the next tap signs the rest and pays', RT.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + '; ' + got + ' received');
    ok(titles.length === 0 && RT.W.cardOwed().filter((r) => r.card === c3.key).length === 0, 'with no card to press, and nothing to put back on the card', titles.join(', '));
    till2.blockedCard = shown;

    /* The card lost while its change was being written: what went on stays on, the same sheet asks again, and the
     * screen says CARD LOST until the card is found again. */
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
      ok(seen5.path() === 'hold > keep > pin > again > keep > verify > change > verify > again > verify' && seen5[8].title === 'CARD LOST' && seen5[8].scheme === '1g'
         && seen5[8].chip === 'Only this card can receive it.' && seen5[9].scheme === '1c',
         'the card lost part way through taking its change: CARD LOST (1g), with the lock (the change is the card\u2019s alone), and in contact again (1c) while the rest goes on', seen5.path() + ' | ' + seen5.titles() + ' | ' + seen5.schemes());
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
    ok(till2.cardFlowBusy() === true, 'a payment waiting for its card to be tapped again is a card flow still: a confirmation that comes waits');
    RT.nfc = c4;
    c4.tap();
    card(till2).press('CANCEL');
    await until('what it signed to be back on the card', () => card(till2) && card(till2).title === 'BACK ON THE CARD');
    ok(c4.balance() === 768 && !RT.W.cardHeldPayment(c4.key) && RT.W.cardOwed().length === 0 && (await RT.W.balanceSats()) === rb4,
       'CANCEL gives back what the card signed: the sheet comes up by itself, and the tap puts it back with no PIN', card(till2).reason + ' / ' + c4.balance());
    card(till2).press('DONE');
  }

  /* ---- no daily limit on these screens; its PIN ---------------------------------------
   * This phone sets no daily limit, and a card that has one (set by an older Foxy) shows nothing about it. */
  H.nfc = c;
  c.tap();
  holder.fcRead();
  await until('the card to be read again', () => holder.state.fc && holder.state.fc.balance === c.balance() && holder.state.fc.ownedHere === true);
  ok(holder.state.fc.ownedHere === true && limitOf(holder) === 'NO LIMIT', 'the card is read again, and this phone is found to be its owner');
  holder.fcSetLimit();
  ok(limits(holder) && limits(holder).labels === 'PER TAP LIMIT',
     'LIMITS asks which limit, and offers no daily limit: PER TAP LIMIT, or CLOSE (this card has no no-PIN limit)', limits(holder) && limits(holder).labels);
  limits(holder).press('CLOSE');
  ok(!card(holder) && !pad(holder) && holder.state.screen === 'flashcard' && c.state.record.limit === 0, 'CLOSE there changes nothing');
  // a daily limit put on the card some other way: the screens say nothing about it
  c.tap();
  await H.W.cardSetLimit(c, { sats: 700 });
  c.tap();
  holder.fcRead();
  await until('the card with a daily limit to be read', () => holder.state.fc && holder.state.fc.limit === 700);
  v = vals(holder);
  ok(c.state.record.limit === 700 && limitOf(holder) === '' && v.fcLimitShown === undefined && v.fcDayShown === undefined && v.fcDayLeft === undefined && v.fcDayTurns === undefined,
     'a card with a daily limit shows nothing about it: no limit words, no day left, no day turning', JSON.stringify([limitOf(holder)]));
  holder.fcSetLimit();
  ok(limits(holder) && limits(holder).labels === 'PER TAP LIMIT', 'and LIMITS still offers none', limits(holder) && limits(holder).labels);
  limits(holder).press('CLOSE');

  /* ---- the limit on one tap ----------------------------------------------------------
   * The other choice under LIMITS, asked for by the same three steps in its own words. */
  {
    // a card read as the one before the latest (software 1.12) has that card's rule in its words: it does not wait by the newest
    const was = holder._fcCard;
    holder._fcCard = Object.assign({}, was, { info: Object.assign({}, was.info, { format: 4, shaped: false }) });
    holder.fcSetLimit();
    ok(limits(holder) && limits(holder).labels === 'PER TAP LIMIT',
       'a card of software 1.12 is asked the same question at LIMITS', limits(holder) && limits(holder).labels);
    limits(holder).press('PER TAP LIMIT');
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
  limits(holder).press('PER TAP LIMIT');
  {
    const x = explainer(holder);
    ok(x && !card(holder) && x.title === 'How tap limit works' && !x.done, 'PER TAP LIMIT opens HOW TAP LIMIT WORKS, a screen of its own, which plays before its buttons come', x && x.all);
    x.finish();
    const y = explainer(holder);
    ok(y.done && y.all === ['How tap limit works', 'Any payment request over your limit requires you to tap and hold your card longer.', 'EXAMPLE LIMIT', '$10',
                            '$0.01 \u2013 $10.00', '~1\u20134 SEC TAP', '$10.01 \u2013 $20.00', '~3 SEC TAP', '$20.01 \u2013 $30.00', '~6 SEC TAP', '$30.01 \u2013 $40.00', '~9 SEC TAP',
                            'And so on\u2026', 'CANCEL', 'CONTINUE'].join(' | '),
       'played out, it is the rule as a list: the ten-dollar example, four tiers with the seconds a card before 1.25 holds for (3 s \u00d7 (N \u2212 1)), and so on, then CANCEL and CONTINUE', y.all);
    y.press('CANCEL');
    ok(!explainer(holder) && holder.state.screen === 'flashcard' && holder._fcLimitDone === null, 'CANCEL takes it down and changes nothing');
    // played through once on this phone, it opens on the list from then on
    holder.fcSetLimit();
    limits(holder).press('PER TAP LIMIT');
    ok(explainer(holder) && explainer(holder).done && explainer(holder).has('CONTINUE') && H.storage.getItem('foxy.flashcard.explained') === '1',
       'opened again, it does not play: the list and its buttons are there at once');
    explainer(holder).press('CANCEL');
  }
  holder.fcSetLimit();
  limits(holder).press('PER TAP LIMIT');
  explainer(holder).finish();
  explainer(holder).press('CONTINUE');
  ok(holder.state.screen === 'amount' && holder.state.flow === 'cardLimit' && holder.fcLimitQuestion() === 'What is the most this card should pay in one tap straight away?',
     'CONTINUE asks for the amount on the same keypad, in its own words', holder.fcLimitQuestion());
  keyIn(holder, 300);
  {
    const cf = holder.fcLimitSpec();
    ok(cf.amountLabel === 'YOU ARE APPLYING A PER TAP LIMIT OF:' && cf.amount === '\u20bf 300' && cf.cta === 'CONFIRM' && cf.secondary.label === 'CANCEL'
       && cf.warn === 'This card will pay up to this straight away, change or no change. Over it, the card has to be held about 3 seconds, and 3 seconds more for every limit\u2019s worth beyond that. Only this phone, or a phone restored from its seed phrase, can change or remove it.',
       'the confirmation says the amount and what it means', JSON.stringify([cf.amountLabel, cf.amount]));
  }
  c.tap();
  c.sent.length = 0;
  holder.fcLimitSpec().go();
  await until('the limit on one tap to be set', () => holder.state.fc.tap && holder.state.fc.tap.limit === 300);
  ok(c.state.tapLimit === 300 && c.state.record.limit === 700 && c.state.spent === 0 && !c.sent.some((a) => /^b040/.test(a)) && holder.toasts.indexOf('Per tap limit set.') >= 0,
     'the card has its limit on one tap, the daily limit is as it was, and no PIN was sent', JSON.stringify({ tap: c.state.tapLimit, day: c.state.record.limit }));
  ok(limitOf(holder) === 'PER TAP LIMIT \u20bf300', 'and its screen says the per tap limit, and nothing of the daily one', limitOf(holder));
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
  limits(holder).press('PER TAP LIMIT');
  explainer(holder).finish();
  explainer(holder).press('CONTINUE');
  holder.fcLimitConfirm(0);
  ok(holder.fcLimitSpec().amountLabel === 'YOU ARE REMOVING THIS CARD\u2019S PER TAP LIMIT.' && holder.fcLimitSpec().warn === 'One tap will be able to pay as much as the card holds straight away.',
     'NO LIMIT under the keypad removes it, and the confirmation says what that means', holder.fcLimitSpec().warn);
  c.tap();
  holder.fcLimitSpec().go();
  await until('the limit on one tap to be gone', () => holder.state.fc.tap && holder.state.fc.tap.limit === 0 && c.state.tapLimit === 0);
  ok(holder.toasts.indexOf('Per tap limit removed.') >= 0 && c.state.record.limit === 700, 'removed, and the daily limit still as it was', limitOf(holder));
  ok(limitOf(holder) === '' && !limitOf(holder), 'and the screen says nothing of limits: the one left is the daily one', limitOf(holder));

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
    ok(limitOf(holder) === '' && v.fcFaceLines === true && v.fcCheck === 'Blocked', 'its face says Blocked and it has no limit words: it has nothing to say of its limits', v.fcCheck);
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
  /* ---- the card keeps a daily limit of 700 for what follows (set by the wallet: no screen sets one) ---------------- */
  c.tap();
  await H.W.cardSetLimit(c, { sats: 0 });
  c.tap();
  await H.W.cardSetLimit(c, { sats: 700 });
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
  H.phone.cardApprovals = [];
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
  /* The phone signs a limit only against the keeper's yes, given before the card is held up (NativeSeedBridge.swift): the
   * withdrawal asked for one, naming the lift, and only that one. Without it the phone refused the lift, and the tap with it. */
  ok(JSON.stringify(H.phone.cardApprovals.map((m) => [m.label, m.lift, m.figures, m.card])) === JSON.stringify([['set-limit', true, undefined, c.key]]),
     'the keeper was asked once, before the tap, for this card’s limit lifted for the withdrawal and put back', JSON.stringify(H.phone.cardApprovals));
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
       && vals(holder).fcDayLeft === undefined,
       'and so is the day: given back whole with the limit put back, and turning when the card says (which the screen does not show)', JSON.stringify([shown.day.left, real.day.left, shown.day.turns, real.day.turns]));
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
    ok(holder.state.fc.ownedHere === true && holder.state.fc.owner === true && vals(holder).fcMenuItems.length === 5 && !hasReset(holder),
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
    await H.W.cardSetUp(rm, { pin: '1234', recoverable: false });
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
    ok(holder.cardFlowBusy() === true, 'a withdrawal waiting for the rest is a card flow still: a confirmation that comes waits');
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
  // a wrong PIN, where the tap was run with a PIN typed earlier: TRY AGAIN is the pad again (`pinAgain`), never the same PIN at the card twice
  {
    const ran = [];
    till.fcFailed({ card: 'wrong-pin', tries: 2, message: 'Wrong PIN. 2 tries left.' }, { taken: true, again: () => ran.push('again'), pinAgain: () => ran.push('pin') });
    ok(card(till).title === 'WRONG PIN' && card(till).reason === '2 tries left. Nothing was taken.' && card(till).has('TRY AGAIN') && card(till).has('CANCEL'),
       'a wrong PIN says the tries left, with TRY AGAIN and CANCEL', card(till).all);
    card(till).press('TRY AGAIN');
    ok(ran.join() === 'pin', 'TRY AGAIN after a wrong PIN asks for the PIN again rather than running the same one', ran.join());
    // the same refusal with no pad to go back to (the PIN was not typed on this phone): TRY AGAIN is the tap again
    till.fcFailed({ card: 'wrong-pin', tries: 2, message: 'Wrong PIN. 2 tries left.' }, { taken: true, again: () => ran.push('again') });
    card(till).press('TRY AGAIN');
    ok(ran.join() === 'pin,again', 'with no pad to go back to, TRY AGAIN is the tap again', ran.join());
    // any other refusal: the tap again, whether or not a pad was offered for a wrong PIN
    till.fcFailed({ card: 'keep-holding', message: 'Hold the card longer.' }, { taken: true, again: () => ran.push('again'), pinAgain: () => ran.push('pin') });
    ok(card(till).title === 'HOLD IT LONGER' && card(till).has('TRY AGAIN'), 'a card lifted too soon offers TRY AGAIN', card(till).all);
    card(till).press('TRY AGAIN');
    ok(ran.join() === 'pin,again,again', 'another refusal’s TRY AGAIN is the tap again, not the pad', ran.join());
  }
  // change the mint did not make: the payment stands, and the phone says it makes the change when it next connects
  till.fcChangeLater(824, 200);
  ok(card(till).title === 'CHANGE NOT MADE YET' && card(till).reason === 'Paid \u20bf200. The mint did not make its \u20bf824 of change. This phone tries again whenever it connects, and then a tap of the card here receives it.'
     && card(till).has('OK'), 'change the mint did not make is said, with when it will be', card(till).all);
  card(till).press('OK');

  /* ---- with the switch on: cards that can be taken back -----------------------
   * Off: a card that leaves the screen takes the screen with it.
   * On, as it ships, for the rest of this suite: the screen with no card on
   * it stays, set-up with nothing asked, RENEW with under twenty days left, and
   * a lost card's money taken back from RESTORE CARD (home's MENU). */
  ok(!('fcRows' in vals(holder)) && !('fcHasRows' in vals(holder)), 'the card’s screen has no list of cards to take back: that is RESTORE CARD’s');
  holder.fcGone();
  ok(holder.state.screen === 'home' && !holder.state.fc, 'and a card that is no longer known takes its screen with it');
  holder.FC_RECOVERABLE = true;
  // the first card, which this phone set up and so can take back too, though it is not the one lost below
  const firstCard = c;
  const rc = newCard(H);
  H.nfc = null;
  // (not the press of FOXY CARD, whose dismissal goes back: a swipe, a card's address)
  holder.goFlashcard('swipe');
  await settle();
  v = vals(holder);
  ok(holder.state.screen === 'flashcard' && v.fcNone && !holder.state.fc,
     'switched on, the sheet dismissed leaves the card’s screen with no card on it', holder.state.screen);
  H.nfc = rc;
  holder.fcRead();
  await until('the second card to be read', () => !!holder.state.fc);
  holder.fcSetUp();
  pad(holder).type('4321');
  rc.tap();
  pad(holder).type('4321');
  ok(!pad(holder) && !(card(holder) && card(holder).title === 'IF THE CARD IS LOST'),
     'and set-up asks nothing after the PIN: there is no choice of recoverable or like cash', card(holder) && card(holder).title);
  await until('the second card to be set up', () => holder.state.screen === 'flashcard' && !!rc.state.owner && holder.state.fc && holder.state.fc.owner);
  ok(holder.state.fc.mine && holder.state.fc.recoverable && /^0[23]/.test(rc.state.record.refund), 'it is this phone\u2019s to take back', rc.state.record.refund);
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
  ok(!renewLine(vals(holder)), 'with fourteen days to run there is nothing to renew');
  const real = H.window.Date.now.bind(H.window.Date);
  const realHere = Date.now;
  const move = (ms) => { H.window.Date.now = () => real() + ms; Date.now = () => realHere() + ms; };
  move(11 * 86400000);
  v = vals(holder);
  ok(!!renewLine(v) && typeof renewLine(v).tap === 'function' && v.fcMenuItems.length === 5,
     'with under ten days to run the screen carries a line to renew it, and by when', renewLine(v) && renewLine(v).text);
  rc.tap();
  const entriesBefore = history(H).map((e) => e.hash);
  holder.fcRenew();
  pad(holder).type('4321');
  await until('the card to be renewed', () => holder.state.screen === 'paid' && holder.state.paidSays === 'ON THE CARD');
  ok(rc.balance() === 1024 && !renewLine(vals(holder)) && history(H).filter((e) => entriesBefore.indexOf(e.hash) < 0).length === 2
     && history(H).filter((e) => entriesBefore.indexOf(e.hash) < 0).every((e) => holder.seen[e.hash]),
     'renewed in one tap: the same 1,024, thirty days on, its two entries not announced', String(holder.state.paidAmount));
  ok(rc.state.record.limit === 0, 'and the limit is what it was', String(rc.state.record.limit));
  holder.setState({ screen: 'home', stack: [] }); if (holder.paidDismissed) holder.paidDismissed(); await new Promise((ok2) => setTimeout(ok2, 100));

  // a month after that the card is lost: RESTORE LOST CARD, from home's MENU, is RESTORE CARD
  move(45 * 86400000);
  H.nfc = null;                         // the card is lost: nothing answers the sheet
  holder.state.screen = 'home'; holder.state.stack = []; holder.state.fc = null;
  holder.fcRestoreLost();
  const lostName = holder.fcName(rc.key).toUpperCase();
  const lostRow = () => (restore(holder) ? restore(holder).rows.filter((x) => x.indexOf(lostName + ' | ') === 0)[0] : '') || '';
  const said = holder.fcPrice(1024, 'sat').replace(/^\$/, '$ ') + ' when last seen';
  ok(holder.state.screen === 'fcRestore' && holder.state.stack.join() === 'home' && lostRow() === lostName + ' | ' + said + ' | Ready To Restore'
     && restore(holder).ready[0] === lostName && restore(holder).inert,
     'past its date its row on RESTORE CARD is ready to restore, first, with what it held (dollars first, where this phone has a price); the rest cannot be pressed', restore(holder) && restore(holder).rows.join(' / '));
  await holder.refreshBalance();
  const beforeBack = holder.have;
  restore(holder).press(lostName);
  await until('the money to be back', () => holder.state.screen === 'paid');
  ok((await H.W.balanceSats()) === beforeBack + 1024 && holder.state.paidSays === 'RESTORED' && holder.state.paidAmount === 1024 && holder.state.paidUnit === 'sat'
     && !holder.state.payOut && holder.state.recv.live === 'in' && !stage(H) && !card(holder),
     'pressed, the 1,024 sats are back with no card, and it ends on the success screen: RESTORED, with its flash', JSON.stringify([holder.state.paidSays, holder.state.paidAmount]));
  holder.state.screen = 'home'; holder.state.stack = [];
  holder.fcRestoreLost();
  ok(lostRow() === lostName + ' | Restored to this phone | Nothing To Restore' && restore(holder).ready.length === 0 && restore(holder).inert,
     'RESTORE CARD says so after, and the row can no longer be pressed', lostRow());
  ok(firstCard.balance() === 0, 'and the first card, empty, had nothing to take back');
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
    ok(R.events.indexOf('connected: Reading the card') >= 0 && hold1 && hold1.look === 'keep' && hold1.scheme === '1c' && hold1.title === 'PAYING'
       && hold1.dots && !hold1.loop && !hold1.cancel && hold1.buttons.join() === 'CLOSE',
       'the sheet says the piece being signed; the screen behind it is PAYING (1c), the dots going, CLOSE and no CANCEL', JSON.stringify(hold1));
    // what the phone’s own link says, pushed to the page as it happens, changes nothing it should not
    R.W._card({ stage: 'say', text: 'Signing piece 1 of 4' });
    ok(behind(R).look === 'keep' && behind(R).title === 'PAYING', 'and what the sheet says is not repeated on the screen', behind(R).title);
    let_go();
    await until('the payment to be made', () => till.state.screen === 'home');
    await settle();
    ok(['Signing piece 1 of 4', 'Signing piece 2 of 4', 'Signing piece 3 of 4', 'Signing piece 4 of 4'].every((t) => R.sheet.indexOf('say: ' + t) >= 0)
       && R.sheet[R.sheet.length - 1] === 'end:  ' && d.balance() === 40 && (!stage(R) || stage(R) === 'paidCheck'),
       'each piece was said on the sheet in turn, the sheet closed with no words once the card had signed (it was paid exactly: nothing to keep it open for), and the card screen is down', R.sheet.slice(-3).join(' / '));
    ok(!till._fcLookT, 'and nothing of the screen is left running');
    R.nfc = d;
    ok(R.W.cardOwed().length === 0 && d.state.slots.filter((x) => x.status === 1).length === 2, 'no change was needed: the card was not written to');

    // a push with no tap under way changes nothing and breaks nothing
    R.W._card({ stage: 'say', text: 'stray' });
    R.W._card(null);
    // (VERIFYING may stand over the code for a moment after the tap, `fcCardVerifying`: that is no card screen)
    const strayStage = R.window.document.getElementById('foxy-stage');
    ok(!strayStage || strayStage.getAttribute('data-stage') === 'paidCheck', 'a push with no tap under way draws nothing');

    /* ---- the card tap family behind the sheet, state by state (build/app/26h-tap-screen.js, the keeper's 1a to 1g) ---------
     * Driven as the wallet and the phone's link drive it: the steps of a tap, and the link's "connected" and "lost". */
    {
      const S = appOn(R);
      const begin = (o) => { S._fcTapO = Object.assign({ amount: '$25.75' }, o || {}); S.fcStage('hold'); };
      const link = (stage) => S.fcTapEvent({ stage, text: '' });
      const up = () => R.window.document.getElementById('foxy-stage');
      // the look, title, screen of the family, the arrow over the top, CANCEL, and the amount of each state
      const is = (b, look, title, scheme, hint, cancel) => !!b && b.look === look && b.title === title && b.scheme === scheme
        && b.loop === hint && b.hint === hint && b.cancel === cancel && b.amount === '$25.75';

      // 1a: waiting for the card, a payment
      begin({ flow: 'pay' });
      let b = behind(R);
      ok(is(b, 'hold', 'TAP TO PAY', '1a', true, true) && !b.dots && b.buttons.join() === 'CANCEL' && !b.reason && !b.chip,
         '1a: TAP TO PAY over the amount, the arrow and its words over the top, no dots, and CANCEL', JSON.stringify(b));
      const st = up().getAttribute('style');
      ok(/#D6EEF4|214, 238, 244/i.test(st) && /#A9D6E2|169, 214, 226/i.test(st) && /color: (#0F2A33|rgb\(15, 42, 51\))/i.test(st),
         '1a’s ground is the light blue #D6EEF4 to #A9D6E2, with #0F2A33 ink', st);
      const h1 = up().querySelector('h1').getAttribute('style');
      const am = up().querySelector('[data-tap-amount]').getAttribute('style');
      ok(/font-size:\s*34px/.test(h1) && /letter-spacing:\s*0?\.1em/.test(h1) && /white-space:\s*nowrap/.test(h1) && /font-size:\s*76px/.test(am) && /font-weight:\s*800/.test(am),
         'the title is 34px spaced out on one line, and the amount 76px', h1 + ' | ' + am);
      ok(up().querySelector('[data-tp-hint]').textContent === 'TAP CARD BEHIND THE TOP' && /tpArrow/.test(up().querySelector('[data-tp-hint] svg').getAttribute('style'))
         && up().querySelector('[data-tp-hint] svg').hasAttribute('data-tp-move'),
         'over the top: TAP CARD BEHIND THE TOP, and the arrow bobbing (stopped for less motion)');

      /* The phone's link says `lost` too when iOS ends a sheet no card came near (its own Cancel, its minute run out: CardLink.swift
       * sends it before the error). That is no card lost: 1a stays, and the tap's cancel is silent, as it always was. */
      link('lost');
      b = behind(R);
      ok(b.look === 'hold' && b.scheme === '1a' && b.title === 'TAP TO PAY' && !S._fcTapO.t.lost, 'the sheet ended with no card near: still TAP TO PAY (1a), no CARD LOST', JSON.stringify(b));
      S.hideStage('card');
      S.fcFailed(Object.assign(new Error('The card was not tapped.'), { card: 'cancelled', tapLost: !!S._fcTapO.t.lost, tapAmount: '$25.75' }), { paying: true, taken: true, again: () => {} });
      ok(!stage(R) && !card(S), 'and its cancel says nothing: no TAP AGAIN for a card that was never there');
      begin({ flow: 'pay' });

      // 1c: the card in contact
      link('connected');
      b = behind(R);
      ok(is(b, 'keep', 'PAYING', '1c', false, false) && b.dots && b.buttons.join() === 'CLOSE', '1c: a card connected to pay: PAYING, the dots, CLOSE, and no arrow', JSON.stringify(b));
      ok(/#FF9A5C|255, 154, 92/i.test(up().getAttribute('style')) && /#D9561C|217, 86, 28/i.test(up().getAttribute('style')), '1c’s ground is the orange #FF9A5C to #D9561C');
      ok(/tpDot 0\.8s/.test(up().querySelector('[data-tp-dots] span').getAttribute('style')), 'with the faster dots');
      // the card has signed and is still there (the change to come): still in contact
      S.fcStage('mint');
      ok(is(behind(R), 'verify', 'PAYING', '1c', false, false), 'signed with the card still there: PAYING, in contact');

      // 1g: lost after it signed, its change still to go on: CARD LOST, and the change waits for this card alone
      link('lost');
      b = behind(R);
      ok(b.look === 'change' && b.scheme === '1g' && b.title === 'CARD LOST' && b.amount === '$25.75'
         && b.reason === 'The card moved away too soon. Hold it still behind the top of the phone.' && b.chipIcon === 'lock' && b.chip === 'Only this card can receive it.'
         && b.buttons.join() === 'TRY AGAIN,CANCEL' && !b.hint && !b.dots,
         '1g at once: CARD LOST, the words, the lock chip (the change is the card’s alone), TRY AGAIN and CANCEL', JSON.stringify(b));
      ok(/#E8503F|232, 80, 63/i.test(up().getAttribute('style')) && /#B82A1E|184, 42, 30/i.test(up().getAttribute('style')), '1g’s ground is the red #E8503F to #B82A1E');
      link('connected');
      ok(behind(R).look === 'verify' && behind(R).scheme === '1c', 'found again: in contact, 1c');
      S._fcTapO.t.wrote = true;
      link('lost');
      ok(behind(R).look === 'again' && behind(R).scheme === '1g', 'lost with some of the change on: CARD LOST too');

      // 1d: let go, the mint asked
      S.fcStage('checking');
      b = behind(R);
      ok(is(b, 'remove', 'CHECKING', '1d', false, false) && b.dots && b.buttons.join() === 'CLOSE', '1d: the card let go and the mint asked: CHECKING, the dots and CLOSE', JSON.stringify(b));
      ok(/#1A3C47|26, 60, 71/i.test(up().getAttribute('style')) && /color: (#F2FAFC|rgb\(242, 250, 252\))/i.test(up().getAttribute('style')), '1d’s ground is the teal #1A3C47, with #F2FAFC ink');
      link('lost');
      ok(behind(R).look === 'remove' && behind(R).scheme === '1d', 'and the card going is not “lost” then');

      // 1g before anything was signed: the money is still on the card
      begin({ flow: 'pay' });
      link('connected');
      link('lost');
      b = behind(R);
      ok(b.look === 'again' && b.scheme === '1g' && b.chipIcon === 'shield' && b.chip === 'Your money is still on your card.', '1g before the card signed: the shield, "Your money is still on your card."', JSON.stringify(b));
      // TRY AGAIN: the sheet is asking already, and the screen says where to hold the card again
      b.press('TRY AGAIN');
      b = behind(R);
      ok(b.look === 'hold' && b.scheme === '1a' && b.title === 'TAP TO PAY' && b.hint && !b.cancel, 'TRY AGAIN: back to TAP TO PAY with the arrow, the sheet still asking', JSON.stringify(b));
      link('connected');
      link('lost');
      const stopWas = R.W.cardStop;
      let stops = 0;
      R.W.cardStop = () => { stops += 1; };
      behind(R).press('CANCEL');
      R.W.cardStop = stopWas;
      ok(stops === 1, 'CANCEL on CARD LOST ends the sheet, as the sheet’s own Cancel does', String(stops));
      // a load lost: the money waits for this card
      begin({ flow: 'load' });
      link('connected');
      link('lost');
      ok(behind(R).chipIcon === 'lock', 'a load’s card lost: the lock, "Only this card can receive it."');
      // a payment taken up again after the card left part way: some of it signed already, and neither chip is said
      begin({ flow: 'pay', paying: true, lost: true });
      b = behind(R);
      ok(b.scheme === '1g' && b.title === 'CARD LOST' && !b.chip, 'a payment taken up again after the card left: CARD LOST from the start, and no chip', JSON.stringify(b));

      // every flow's words: what 1a asks, what 1c says, and what 1d says
      const words = (o) => { begin(o); const a = behind(R).title; link('connected'); const c = behind(R).title; S.fcStage('checking'); return [a, c, behind(R).title].join(' / '); };
      const want = {
        pay: 'TAP TO PAY / PAYING / CHECKING', load: 'TAP TO LOAD / RECEIVING / CHARGING', change: 'TAP FOR CHANGE / RECEIVING / CHARGING',
        read: 'TAP TO READ / READING / VERIFYING', withdraw: 'TAP TO WITHDRAW / WITHDRAWING / CHECKING', swap: 'TAP TO SWAP / SWAPPING / CHECKING',
        move: 'TAP TO MOVE / MOVING / CHECKING', renew: 'TAP TO RENEW / RENEWING / CHECKING', reset: 'TAP TO RESET / RESETTING / CHECKING',
        setup: 'TAP TO SET UP / SETTING UP / CHECKING', pin: 'TAP TO SET PIN / WRITING / CHECKING', limit: 'TAP TO SET LIMIT / WRITING / CHECKING',
        rate: 'TAP TO SET RATE / WRITING / CHECKING', write: 'TAP CARD / WRITING / CHECKING', card: 'TAP CARD / READING / CHECKING',
      };
      const got = Object.keys(want).map((f) => f + ': ' + words({ flow: f }));
      ok(got.join('\n') === Object.keys(want).map((f) => f + ': ' + want[f]).join('\n') && Object.keys(S.FC_TAP_FLOWS).join() === Object.keys(want).join(),
         'every flow has its words, and only those change', got.join(' | '));
      ok(words({ paying: true }) === want.pay && words({ look: 'receive' }) === 'TAP FOR CHANGE / RECEIVING / CHARGING' && words({}) === want.card,
         'a tap that names no flow: a payment’s when paying, the change’s for a payment’s second tap, and TAP CARD otherwise');

      /* REMOVE is right only while there is something to take away: the sheet may still be showing for a second and a half after the card
       * signed, or until it is seen to go, whichever is first. The screen is 1d all along: CHECKING, and STILL CHECKING once the wait the
       * CHECKING screen makes (`fcChecking`) has run out. The clock is wound back here; the timer that draws it by itself is below. */
      {
        const gone = () => S._fcTapO.t;
        const fresh = () => { begin({ flow: 'pay' }); link('connected'); S.fcStage('mint'); S.fcStage('checking'); };
        // (the suites hold REMOVE in place; here it is the clock of a phone, a second and a half)
        S.FC_TAP_REMOVE_MS = 1500;
        fresh();
        ok(behind(R).look === 'remove' && gone().goneAt > 0, 'the card let go: REMOVE, from the moment it signed');
        gone().goneAt = Date.now() - 1400;
        S.fcTapDraw();
        ok(behind(R).look === 'remove', 'still REMOVE a second and four tenths after it signed');
        gone().goneAt = Date.now() - 1600;
        S.fcTapDraw();
        b = behind(R);
        ok(is(b, 'checking', 'CHECKING', '1d', false, false), 'a second and a half after the card signed, the mint not yet heard from: CHECKING on 1d', JSON.stringify(b));
        const wait = S.fcCheckWait();
        ok(wait === S.FC_CHECK_FIRST_MS + (S.FC_CHECK_ASKS - 1) * S.FC_CHECK_EVERY_MS && wait === 58000, 'the wait for STILL CHECKING is the one the CHECKING screen makes: a first asking at 3 s and a dozen at 5 s', String(wait));
        gone().goneAt = Date.now() - 1500 - wait + 500;
        S.fcTapDraw();
        ok(behind(R).look === 'checking', 'CHECKING until that wait has run out');
        gone().goneAt = Date.now() - 1500 - wait - 500;
        S.fcTapDraw();
        b = behind(R);
        ok(is(b, 'still', 'STILL CHECKING', '1d', false, false), 'and STILL CHECKING after it', JSON.stringify(b));
        link('lost');
        ok(behind(R).look === 'still', 'and the card going is not “lost” then either');
        // the sheet seen to go before the clock has run out: CHECKING at once
        fresh();
        ok(behind(R).look === 'remove', 'a card just let go is REMOVE again on a tap of its own');
        S.fcSheetGone();
        ok(behind(R).look === 'checking' && gone().sheetGoneAt > 0, 'the phone\'s sheet going (the app has the screen back) is CHECKING at once, with no wait for the clock');
        // a sheet that goes before any card was let go says nothing
        begin();
        link('connected');
        S.fcSheetGone();
        ok(behind(R).look === 'keep' && !gone().sheetGoneAt, 'a sheet going while the card is still being asked for something changes nothing');
        // the mint has answered (the change is being made, or the tap is over): nothing is left to check, and the screen keeps the look it had
        fresh();
        S.fcStage('making');
        gone().goneAt = Date.now() - 100000;
        S.fcTapDraw();
        ok(behind(R).look === 'remove' && !S._fcLookT, 'answered inside the second and a half, while the change is made: it stays as it was, with no clock behind it');
        fresh();
        gone().goneAt = Date.now() - 2000;
        S.fcTapDraw();
        S.fcStage('making');
        gone().goneAt = Date.now() - 100000;
        S.fcTapDraw();
        ok(behind(R).look === 'checking' && !S._fcLookT, 'answered while it said CHECKING: it says CHECKING until the screen comes down, and does not turn to STILL CHECKING');
        fresh();
        gone().goneAt = Date.now() - 100000;
        S.fcTapDraw();
        S.fcStage('done');
        ok(behind(R).look === 'still', 'answered while it said STILL CHECKING: the same');
        // a card still in the field after it signed has no clock behind it
        begin();
        link('connected');
        S.fcStage('mint');
        ok(behind(R).look === 'verify' && !S._fcLookT, 'a card still in the field after it signed is in contact, with no clock behind it: it stays so however long the mint takes');
        // the timer that draws the change of look by itself, and goes with the screen
        S.FC_TAP_REMOVE_MS = 60;
        fresh();
        ok(behind(R).look === 'remove' && !!S._fcLookT, 'REMOVE has a timer behind it for the look that follows');
        await until('CHECKING to come up by itself', () => behind(R) && behind(R).look === 'checking');
        ok(behind(R).title === 'CHECKING' && !!S._fcLookT, 'the screen turns to CHECKING by itself, with no step or event to turn it, and has a timer behind it for STILL CHECKING');
        S.hideStage('card');
        ok(!S._fcLookT && !stage(R), 'and the timer goes with the screen: nothing left running');
        S.FC_TAP_REMOVE_MS = 3600 * 1000;
      }

      // CLOSE on 1c and 1d: the screen goes, and nothing of the same tap draws it again; the next tap does
      begin({ flow: 'pay' });
      link('connected');
      behind(R).press('CLOSE');
      ok(!stage(R), 'CLOSE takes the screen down');
      S.fcStage('mint');
      S.fcStage('checking');
      S.fcStage('done');
      ok(!stage(R), 'and the tap going on under the sheet does not bring it back');
      begin({ flow: 'pay' });
      ok(behind(R) && behind(R).look === 'hold', 'the next tap has its screen');
      S.hideStage('card');
      /* The same through a real tap: CLOSE, then the card let go ('checking'), then the end. No timer of that tap is left running to
       * take down a later tap's screen. */
      {
        const sessionWas = R.W.cardSession;
        R.W.cardSession = (text, fn) => Promise.resolve().then(() => fn({ released: false, say() {} }));
        const r = await S.fcTap({ flow: 'pay', amount: '$25.75' }, (lk, on) => {
          on('signing');
          behind(R).press('CLOSE');
          lk.released = true;
          on('checking');
          return 'paid';
        });
        R.W.cardSession = sessionWas;
        ok(r === 'paid' && !stage(R) && !S._stageT, 'CLOSE, then the card let go, then the end of a real tap: no screen, and no timer left running', JSON.stringify({ r, stage: stage(R), t: !!S._stageT }));
      }

      // the second tap of a payment, asked for before the card is found
      begin({ look: 'receive' });
      b = behind(R);
      ok(is(b, 'change', 'TAP FOR CHANGE', '1a', true, true), 'the second tap, before the card is found: TAP FOR CHANGE on 1a, with the arrow and CANCEL', JSON.stringify(b));
      link('connected');
      ok(behind(R).look === 'verify' && behind(R).title === 'RECEIVING', 'and in contact, the change going on: RECEIVING');
      // a payment the mint refused, going back on the card: the card asked for again, no card lost
      begin({ putBack: true, flow: 'load' });
      ok(behind(R).look === 'again' && behind(R).scheme === '1a' && behind(R).title === 'TAP TO LOAD' && behind(R).hint, 'a refused payment going back on the card asks for the card on 1a', behind(R).title);

      // the sheet ended asking for the PIN; the pad is up; the tap after it asks again
      begin();
      link('connected');
      S.fcTapPin();
      b = behind(R);
      ok(is(b, 'pin', 'ENTER PIN', '1a', false, false) && b.buttons.length === 0, 'the sheet ended asking for the PIN: ENTER PIN on 1a, nothing to press under the pad', JSON.stringify(b));
      link('lost');
      link('connected');
      ok(behind(R).look === 'pin', 'and nothing the link says moves it while the pad is up');
      S._fcTapO = { amount: '$25.75', pinAgain: true };
      S.fcStage('hold');
      b = behind(R);
      ok(is(b, 'again', 'TAP CARD', '1a', true, true), 'the tap after the pad asks for the card on 1a, with CANCEL (nothing has been asked of the card yet)', JSON.stringify(b));

      // no amount: nothing under the title
      begin({ amount: '' });
      ok(behind(R).amount === '' && R.window.document.querySelector('[data-tap-amount]').style.display === 'none', 'a tap with no amount draws none');
      // the screen is the stage's: down, and nothing left running
      S.hideStage('card');
      ok(!stage(R) && !S._stageT && !S._fcLookT, 'taken down, its timers stop with it');

      // the other screens of the family: CHECKING when the mint has not answered (1d), over the amount the tap was for
      const settleWas = R.W.cardSettle;
      R.W.cardSettle = () => new Promise(() => {});
      S.fcChecking('card-x', { paying: true, taken: true, tapAmount: '$25.75' });
      let f = family(R);
      ok(f && f.kind === 'cardChecking' && f.scheme === '1d' && f.title === 'CHECKING' && f.amount === '$25.75' && f.dots && f.buttons.join() === 'CLOSE' && !f.reason,
         'the CHECKING screen is 1d: CHECKING over the amount, the dots and CLOSE', JSON.stringify(f));
      clearTimeout(S._fcCheckT);
      S._fcTapO = { flow: 'load' };
      S.fcChecking('card-y', { tapAmount: '$3.55' });
      ok(family(R).title === 'CHARGING' && family(R).amount === '$3.55', 'and CHARGING for a load', family(R).title);
      clearTimeout(S._fcCheckT);
      S.hideStage();
      R.W.cardSettle = settleWas;
      // TAP AGAIN (1f): a payment whose card was not read
      let againAsked = 0;
      S.fcFailed(Object.assign(new Error('Card taken away too soon.'), { card: 'gone', tapAmount: '$15.25', tapLost: true }), { paying: true, taken: true, again: () => { againAsked += 1; } });
      f = family(R);
      ok(f && f.kind === 'cardAgain' && f.scheme === '1f' && f.title === 'TAP AGAIN' && f.amount === '$15.25' && f.reason === 'The card wasn’t read. Nothing has been paid yet.'
         && f.chipIcon === 'shield' && f.chip === 'Your money is still on your card.' && f.buttons.join() === 'TAP CARD,CANCEL' && !!card(S) && card(S).title === 'TAP AGAIN',
         '1f: a payment’s card not read: TAP AGAIN, the amount, nothing paid, the shield, TAP CARD and CANCEL', JSON.stringify(f));
      ok(/#FFE7A8|255, 231, 168/i.test(up().getAttribute('style')) && /#EDB236|237, 178, 54/i.test(up().getAttribute('style')), '1f’s ground is the yellow #FFE7A8 to #EDB236');
      ok(!S.fcAskingForCard(), '1f rests: other payments\u2019 confirmations are not held behind it');
      f.press('TAP CARD');
      ok(againAsked === 1 && !stage(R), 'TAP CARD asks for the card again, as the flow’s own TRY AGAIN did');
      // 1e asks for the card, as the card it replaced did: a payment's confirmation held for its change still waits
      S.fcOwedSum = () => ({ unit: 'sat', amount: 500 });
      S.fcOwedAfterPaying = () => false;
      S.fcStillWaiting({});
      ok(family(R) && family(R).scheme === '1e' && S.fcAskingForCard(), '1e asks for the card: a flow is still going on');
      family(R).press('LATER');
      delete S.fcOwedSum;
      delete S.fcOwedAfterPaying;
      S.fcFailed(Object.assign(new Error('The card was not tapped.'), { card: 'cancelled', tapAmount: '$15.25', tapLost: true }), { paying: true, again: () => {} });
      ok(family(R) && family(R).scheme === '1f', 'CARD LOST, then the sheet dismissed: it settles on 1f too');
      family(R).press('CANCEL');
      ok(!stage(R), 'CANCEL leaves it unpaid, and goes');
      S.fcFailed(Object.assign(new Error('The card was not tapped.'), { card: 'cancelled', tapLost: false }), { paying: true, again: () => {} });
      ok(!stage(R) && !card(S), 'a sheet cancelled with no card ever lost says nothing, as before');
      S.fcFailed(Object.assign(new Error('Card taken away too soon.'), { card: 'gone', tapSigned: true }), { paying: true, taken: true, again: () => {} });
      ok(!family(R) && card(S) && card(S).title === 'THE CARD LEFT TOO SOON', 'a card that had signed is not said to hold its money: the card that says so is as it was');
      card(S).press('CANCEL');
      S._fcTapO = {};
    }

    /* a holder of its own for these cards: the one above has spent most of what it had */
    const HX = await funded({ sharedMint: H.mint, words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' }, 5000);
    /* ---- a payment the mint is slow to answer: the screen says what is true at each moment -------------------------------
     * REMOVE while the sheet may still be showing, then CHECKING while the mint is asked, then STILL CHECKING once the wait the CHECKING card makes
     * has run out (shortened here to a fifth of a second). The swap is answered at last, and the payment is made. */
    {
      const d = newCard(HX);
      await HX.W.cardSetUp(d, { pin: '1234' });
      await binaryLoad(HX, d, 1000);            // 512 256 128 64 32 8
      const slow = appOn(R, { screen: 'confirm' });
      slow.asking = 960;                       // 512 + 256 + 128 + 64: four pieces and no change
      // wide enough that a machine that stalls for half a second does not step over CHECKING (the look follows the clock, not the order of the timers)
      slow.FC_TAP_REMOVE_MS = 200;
      slow.FC_CHECK_FIRST_MS = 600; slow.FC_CHECK_EVERY_MS = 600; slow.FC_CHECK_ASKS = 3;
      R.nfc = d;
      d.tap();
      const before = await R.W.balanceSats();
      R.hang = () => { R.hang = null; return { reach: true, answerAfter: 5000 }; };
      const seen = watchBehind(slow, R);
      slow.payByCard();
      await until('the PIN pad', () => !!pad(slow));
      d.tap();
      pad(slow).type('1234');
      await until('the screen to say STILL CHECKING', () => seen.some((x) => x.look === 'still'));
      ok(/remove > checking > still$/.test(seen.path()) && seen.titles().indexOf('CHECKING > CHECKING > STILL CHECKING') >= 0 && !!stage(R) && (await R.W.balanceSats()) === before,
         'a payment the mint is slow to answer: the screen says CHECKING, and then STILL CHECKING, and the payment is not made yet', seen.path() + ' | ' + seen.titles());
      ok(seen.filter((x) => x.look === 'remove' || x.look === 'checking' || x.look === 'still').every((x) => x.scheme === '1d' && !x.loop && !x.cancel && x.dots && x.buttons.join() === 'CLOSE'),
         'all on 1d, the dots going, with CLOSE and no CANCEL');
      await until('the swap to be answered and the payment made', () => !stage(R) && slow.state.screen === 'home');
      seen.stop();
      ok((await R.W.balanceSats()) === before + 960 && !slow._fcLookT, 'and when the mint answers the payment is made, the screen is down, and no timer is left running', String((await R.W.balanceSats()) - before));
      await settle();
    }

    /* ---- a confirmation that comes while a card is being tapped waits for the tap ----------------------------------------
     * Another payment's PAYMENT RECEIVED must not rise over the screen behind the phone's sheet, or over the PIN pad of a tap: it is kept, in the order
     * it came in, and raised one at a time when the card flow is over. The payment the flow is making is not held by this (it has its own hold). */
    {
      const d = newCard(HX);
      await HX.W.cardSetUp(d, { pin: '1234' });
      await binaryLoad(HX, d, 1000);
      const busy = withConfirmations(appOn(R, { screen: 'confirm' }));
      busy.asking = 960;
      busy.FC_END_SETTLE_MS = 40;
      ok(busy.cardFlowBusy() === false, 'with no card being tapped, no card flow is going on');
      let let_go = null;
      const gate = new Promise((r) => { let_go = r; });
      R.nfc = { tap: () => d.tap(), send: (a) => (/^b020/.test(a) ? gate.then(() => d.send(a)) : d.send(a)) };
      const before = await R.W.balanceSats();
      R.sheet.length = 0;
      busy.payByCard();
      await until('the PIN pad', () => !!pad(busy));
      ok(busy.cardFlowBusy() === true, 'the first tap ended asking for the PIN, with the screen under the pad: a card flow is going on');
      busy.announcePayment({ hash: 'req-asked', dir: 'in', sats: 33, to: 'ecash' });
      ok(busy.state.screen === 'confirm' && busy._paidQueue.length === 1 && busy._paidQueue[0].hash === 'req-asked',
         'a PIN being asked for a tap: a confirmation that comes is kept, and not raised over the pad’s screen', busy.state.screen + ' ' + JSON.stringify(busy._paidQueue));
      pad(busy).type('1234');
      await until('the card to be asked to sign', () => R.sheet.indexOf('say: Signing piece 1 of 4') >= 0);
      ok(busy.cardFlowBusy() === true && (busy._fcTaps || 0) === 1 && !!stage(R), 'the card on the phone, its sheet up: a tap is in progress');
      busy.announcePayment({ hash: 'req-two', dir: 'in', sats: 77, to: 'ecash' });
      busy.announcePayment({ hash: 'req-three', dir: 'out', sats: 5, to: 'ecash', says: 'WITHDRAWAL SENT' });
      busy.announcePayment({ hash: 'req-two', dir: 'in', sats: 77, to: 'ecash' });
      await settle();
      ok(busy.state.screen === 'confirm' && busy._paidQueue.map((q) => q.hash).join() === 'req-asked,req-two,req-three',
         'while the card is on the phone, confirmations are kept in the order they came, each once, and the screen is as it was', busy.state.screen + ' ' + busy._paidQueue.map((q) => q.hash).join());
      let_go();
      await until('the payment to be made', () => busy.state.screen !== 'confirm' && !stage(R) && (busy._fcTaps || 0) === 0);
      ok((await R.W.balanceSats()) === before + 960, 'the tap goes on to the end, as it did', String((await R.W.balanceSats()) - before));
      await until('the first confirmation to be raised', () => busy.state.screen === 'paid');
      ok(busy.state.amount === '33' && !stage(R) && !busy.cardFlowBusy() && busy._paidQueue.length === 3,
         'when the card flow is over the first is raised, with the card’s screen down, and the rest wait behind it', busy.state.amount + ' ' + busy._paidQueue.length);
      busy.dismissPaid();
      await until('the second confirmation', () => busy.state.screen === 'paid' && busy.state.amount === '77');
      busy.dismissPaid();
      await until('the third confirmation', () => busy.state.screen === 'paid' && busy.state.amount === '5');
      ok(busy.state.paidSays === 'WITHDRAWAL SENT' && busy.state.payOut === true, 'each as it was asked, in the order it came: the third carries its own heading and direction', busy.state.paidSays);
      busy.dismissPaid();
      await until('the queue to be empty', () => !(busy._paidQueue && busy._paidQueue.length));
      await settle();
    }
    {
      // the pad backed out of: the screen under it goes with it, and what waited for the pad is raised
      const d = newCard(HX);
      await HX.W.cardSetUp(d, { pin: '1234' });
      await binaryLoad(HX, d, 1000);
      const backed = withConfirmations(appOn(R, { screen: 'confirm' }));
      backed.asking = 960;
      backed.FC_END_SETTLE_MS = 40;
      R.nfc = d;
      d.tap();
      backed.payByCard();
      await until('the PIN pad', () => !!pad(backed));
      backed.announcePayment({ hash: 'req-late', dir: 'in', sats: 12, to: 'ecash' });
      ok(backed.state.screen === 'confirm' && backed._paidQueue.length === 1, 'a confirmation that comes while the PIN is asked for waits');
      pad(backed).back();
      await until('the confirmation to be raised', () => backed.state.screen === 'paid');
      ok(backed.state.amount === '12' && !pad(backed) && !stage(R) && !backed.cardFlowBusy(), 'and when the pad is backed out of, with nothing left of the card flow, it is raised', backed.state.amount);
      backed.dismissPaid();
      await settle();
    }
    {
      // ADD FUNDS making the pieces for the tap (GETTING IT READY), and a flow that goes on too long
      const add = withConfirmations(appOn(H, { screen: 'flashcard' }));
      add.FC_END_SETTLE_MS = 40;
      const realPrepare = H.W.cardPrepare;
      H.W.cardPrepare = () => new Promise(() => {});
      add._fcCard = { key: 'a-card', record: {}, pieces: [] };
      add.fcAddRun(500, '', true);
      ok(stage(H) === 'cardReady' && add.cardFlowBusy() === true, 'ADD FUNDS making the pieces for the tap: a card flow is going on');
      add.announcePayment({ hash: 'req-ready', dir: 'in', sats: 21, to: 'ecash' });
      ok(add.state.screen === 'flashcard' && add._paidQueue.length === 1, 'and a confirmation that comes waits');
      add._paidQueue[0].held = Date.now() - add.FC_HOLD_MS - 1000;
      add.nextPaidScreen();
      ok(add.state.screen === 'paid' && add.state.amount === '21', 'a card flow that goes on past the longest a confirmation waits for a change tap does not hold it for ever');
      add.dismissPaid();
      H.W.cardPrepare = realPrepare;
      add.hideStage();
      add._fcAdding = null;
      await settle();
    }

    /* ---- with no route: the exact set only, from a card that proves its money (1.20) ------ */
    const offline = () => R.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    const online = () => R.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    const e = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(e, { pin: '1234' });
    await binaryLoad(H, e, 1000);            // 512 256 128 64 32 8
    // the HIGH RISK question is plain ecash's: a card's payment never raises it
    const asked = [];
    R.W.onOfflineOffer((info) => { asked.push(info); return till.offlineRiskCard(info); });
    R.nfc = e;
    offline();
    till.state.screen = 'confirm';
    till.asking = 800;                  // 512 + 256 + 32 = 800
    e.sent.length = 0;
    till.toasts.length = 0;
    till.payByCard();
    ok(!card(till) && asked.length === 0 && R.sheet.slice(-1)[0] === 'begin: Tap behind the phone.',
       'with no route, CARD goes straight to the card: no HIGH RISK card, nothing asked of the person', card(till) && card(till).title);
    await until('the PIN pad', () => !!pad(till));
    ok(pad(till).title === 'CARD PIN', 'the card wants its PIN for the amount, and the pad comes up for a second tap');
    pad(till).type('1234');
    await until('the card’s payment to be kept', () => R.W.cardKeptWaiting().length === 1 && till.state.screen !== 'confirm');
    await settle();
    ok(R.W.cardKeptWaiting().length === 1 && R.W.trustedWaiting().length === 0 && e.balance() === 200 && !card(till) && asked.length === 0 && till.state.screen === 'home',
       'the card proves its money and signs it over: kept for the mint, the receive closed as for any payment, and nothing raised over it', R.W.cardKeptWaiting().map((x) => x.sats).join(','));
    ok(till.toasts.indexOf('Paid by card while this phone is offline. Foxy settles it with the mint when it is online.') >= 0, 'said in passing', till.toasts.join(' | '));
    const kept800 = history(R).filter((x) => x.hash === 'req-' + R.W.cardKeptWaiting()[0].id)[0] || {};
    ok(kept800.settled === true && kept800.cardKept === 'waiting' && kept800.sats === 800, 'its entry is received now, so the history pass says PAYMENT RECEIVED', JSON.stringify({ s: kept800.settled, k: kept800.cardKept }));
    // a price the card does not make
    till.state.screen = 'confirm';
    till.asking = 150;                  // the card holds 128 + 64 + 8: no 150
    e.tap();
    e.sent.length = 0;
    till.payByCard();
    await until('the inexact price to be refused', () => card(till) && card(till).title === 'NO CHANGE WHILE OFFLINE');
    ok(/cannot give change/.test(card(till).reason) && /Nothing was taken/.test(card(till).reason) && !e.sent.some((a) => /^b040|^b020/.test(a)) && e.balance() === 200,
       'a price the card cannot make exactly is refused in plain words in the first tap, before any PIN is asked for or sent', card(till).reason);
    card(till).press('CLOSE');
    online();
    await R.W.claimUnclaimed();
    await settle();
    ok(R.W.cardKeptWaiting().length === 0, 'online again, what the card signed over is swapped in');
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

    /* holding something: ADD FUNDS is not refused, and goes to SET AMOUNT, for money put on it at its own mint
     * (tests/flashcard-cross-mint-load.js); nothing is asked of the card */
    T.nfc = full;
    app.fcRead(true);
    await until('the card to be read', () => app.state.fc && app.state.fc.key === full.key && app.state.fc.check !== 'asking');
    full.sent.length = 0;
    app.fcAdd();
    ok(!card(app) && app.state.screen === 'amount' && app.state.flow === 'cardAdd' && full.sent.length === 0,
       'a card holding money at another mint: ADD FUNDS goes to SET AMOUNT, for a load at the card’s own mint', card(app) && card(app).all);
    app.back();
    ok(!card(app) && app.state.screen === 'flashcard', 'back from it is the card’s screen as it was');

    // empty, on a phone that is not its owner: the same, a load at its own mint, which needs no switch
    T.nfc = empty;
    app.fcRead(true);
    await until('the empty card to be read', () => app.state.fc && app.state.fc.key === empty.key && app.state.fc.check !== 'asking');
    ok(app.state.fc.count === 0 && app.state.fc.ownedHere === true, 'the empty card is read as this phone’s own');
    const mine = app.state.fc;
    app.state.fc = Object.assign({}, mine, { ownedHere: false });
    app.fcAdd();
    ok(!card(app) && app.state.screen === 'amount' && app.state.flow === 'cardAdd',
       'on a phone that is not its owner there is no switch: ADD FUNDS goes to SET AMOUNT, for a load at the card’s own mint', card(app) && card(app).all);
    app.back();
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
    const lines = (a) => a.fcOwesWords(a.state.fc).map((l) => l.text);
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
    ok(vals(owner).fcOwesShown === undefined && lines(owner).length === 0 && owner.state.fc.owes === null, 'a card with no openings has no line about change');

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
    ok(owedN === 24 && v.fcOwesShown === undefined && owner.fcHistNotes(owner.state.fc).some((r) => r.kind === 'owes') && lines(owner).join('|') === 'CHANGE OWED TO THIS CARD · ' + owedUsd + ' (₿' + owedN + ') — FETCHED AND PUT ON' && owner.state.fc.balance === 1000,
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
    ok(v.fcOwesShown === undefined && lines(owner).join('|') === 'CHANGE OWED TO THIS CARD · ' + owner.fcBoth(owedLater) + ' — NOT YET MADE BY THE TILL' && owner.state.fc.balance === oc.balance(),
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
    ok(owner.fcHistNotes(owner.state.fc).some((n) => n.kind === 'owed' && /is waiting to go onto this card/.test(n.name)) && OH.W.cardOwed().length === 1 && OH.W.cardOwed()[0].sats === slow
       && vals(owner).fcMenuRingInk === '#F7931A',
       'and it is among what this phone owes the card, as the amber row at the top of its HISTORY says, the menu turning amber', owner.fcHistNotes(owner.state.fc).map((n) => n.name).join(' | '));
    // the line under the screen’s buttons: pressed, and the next tap puts it on, as change always has
    OH.W._cardFetchWait = 15000;
    OH.nfc = oc;
    oc.tap();
    oc.sent.length = 0;
    owner.fcHistNotes(owner.state.fc).filter((n) => n.kind === 'owed' && /is waiting to go onto this card/.test(n.name))[0].open();
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
    ok(v.fcUsable && !v.fcNew && v.fcCheck === '' && menuOf(v) === 'HISTORY,RENAME CARD,LIMITS,ADD PIN,TRANSFER,RESET' && histFirst(v) && limitOf(owner) === 'NO LIMIT | NO PIN',
       'its MENU has ADD PIN in CHANGE PIN’s place, after LIMITS, then TRANSFER, with RESET last (a card of 1.17 and on), and HISTORY first in it', menuOf(v));
    owner.fcSetLimit();
    ok(limits(owner) && limits(owner).labels === 'PER SECOND LIMIT',
       'LIMITS offers a card with no PIN its per second limit and no NO PIN LIMIT: there is nothing to pay without', limits(owner) && limits(owner).labels);
    limits(owner).press('CLOSE');

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
    vals(owner).fcMenuItems.filter((k) => k.label === 'ADD PIN')[0].tap();
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
    ok(menuOf(v) === 'HISTORY,RENAME CARD,LIMITS,CHANGE PIN,TRANSFER,RESET' && limitsSub(v) === '', 'and ADD PIN is CHANGE PIN again', menuOf(v));

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
    ok(limits(owner) && limits(owner).labels === 'PER SECOND LIMIT,NO PIN LIMIT',
       'on a card with a PIN, LIMITS has a second row, NO PIN LIMIT, under PER SECOND LIMIT', limits(owner) && limits(owner).labels);
    limits(owner).press('NO PIN LIMIT');
    ok(card(owner) && card(owner).all === ['SET NO PIN LIMIT', NOPIN_WARNING, 'CONTINUE', 'CANCEL'].join(' | '),
       'NO PIN LIMIT opens its warning: what it is, that over it the PIN is asked for the whole payment, that only payments with no PIN count', card(owner) && card(owner).all);
    card(owner).press('CANCEL');
    ok(!card(owner) && owner.state.screen === 'flashcard' && owner._fcLimitDone === null, 'CANCEL there changes nothing');
    owner.fcSetLimit();
    limits(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    // NO PIN AMOUNT first: the most for one payment, this phone's own rule (the card has no such figure)
    ok(owner.state.screen === 'amount' && owner.state.flow === 'cardLimitTx' && owner.state.amount === '',
       'CONTINUE asks NO PIN AMOUNT first, the most one payment may be without the PIN, on the same keypad', JSON.stringify([owner.state.screen, owner.state.flow]));
    keyIn(owner, 0);
    ok(owner.state.flow === 'cardLimitTx' && owner.toasts.slice(-1)[0] === 'Type an amount first.', 'nothing typed goes no further: NO LIMIT under the keypad is the way to say none');
    keyIn(owner, 100);
    ok(owner.state.screen === 'amount' && owner.state.flow === 'cardLimit' && owner.fcLimitQuestion() === 'What is the most this card should pay in a day without its PIN?',
       'NEXT asks the card’s own figure on the same keypad, in its own words', owner.fcLimitQuestion());
    owner.back();
    ok(owner.state.screen === 'amount' && owner.state.flow === 'cardLimitTx' && owner.state.amount === '100' && owner.state.unit === 'SATS',
       'its round back button is NO PIN AMOUNT again, with the 100 chosen filled in', JSON.stringify([owner.state.flow, owner.state.amount]));
    keyIn(owner, 100);
    keyIn(owner, 0);
    ok(owner.state.screen === 'amount' && owner.toasts.indexOf('Type an amount first.') >= 0, 'nothing typed goes no further: NO LIMIT under the keypad is the way to say none');
    keyIn(owner, 500);
    {
      const cf = owner.fcLimitSpec();
      ok(owner.state.screen === 'fcLimitConfirm' && cf.amountLabel === 'YOU ARE APPLYING A NO PIN LIMIT OF:' && cf.amount === '₿ 500' && cf.cta === 'CONFIRM' && cf.secondary.label === 'CANCEL'
         && cf.warn === 'This card will pay up to this much a day without its PIN. Over it, the PIN is asked for the whole payment. Only this phone, or a phone restored from its seed phrase, can change or remove it. This phone alone asks for the PIN above ₿100; a phone restored from the seed phrase, or any other phone, does not.',
         'the confirmation says the amount and what it means, and this phone’s NO PIN AMOUNT, with CONFIRM and CANCEL', JSON.stringify([cf.amountLabel, cf.amount, cf.warn]));
      cf.secondary.go();
      ok(owner.state.screen === 'flashcard' && n.state.noPinLimit === 0 && !pad(owner) && !H2.W.cardNoPinTx(n.key), 'CANCEL there writes nothing, on the card or on this phone');
    }
    owner.fcSetLimit();
    limits(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    keyIn(owner, 100);
    keyIn(owner, 500);
    n.sent.length = 0;
    owner.fcLimitSpec().go();
    ok(!pad(owner), 'CONFIRM asks for no PIN: this phone’s proof sets the limit');
    await until('the no PIN limit to be set', () => owner.state.fc.noPin && owner.state.fc.noPin.limit === 500);
    ok(JSON.stringify(H2.W.cardNoPinTx(n.key)) === JSON.stringify({ n: 100, unit: 'sat', usd: 0 }), 'and NO PIN AMOUNT, 100, is kept on this phone once the card has taken its limit', JSON.stringify(H2.W.cardNoPinTx(n.key)));
    // (none again, for the payments below: NO LIMIT on NO PIN AMOUNT, as the button under its NEXT does)
    owner.fcSetLimit();
    limits(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    ok(owner.state.flow === 'cardLimitTx' && owner.state.amount === '100', 'NO PIN AMOUNT comes back with the 100 kept filled in', owner.state.amount);
    owner.fcLimitTxNext(0, 0);
    keyIn(owner, 500);
    owner.fcLimitSpec().go();
    await until('NO PIN AMOUNT to be none', () => !H2.W.cardNoPinTx(n.key));
    await settle();
    ok(n.state.noPinLimit === 500 && n.state.record.limit === 0 && pins() === 0 && owner.toasts.indexOf('No PIN limit set.') >= 0,
       'the card has an allowance of 500 and no PIN was sent', String(n.state.noPinLimit));
    v = vals(owner);
    ok(limitOf(owner) === '' && !v.fcLimitShown && v.fcNoPinShown === undefined && limitsSub(v) === 'No PIN up to ₿500 · ₿500 left today',
       'its limit words say nothing of the no-PIN limit, and LIMITS in its menu says it and what is left of it today', [limitOf(owner), limitsSub(v)].join(' | '));

    /* at a till: within it, one tap and no PIN; over what is left of it, the PIN; the card's own word is the truth */
    n.sent.length = 0;
    await payAt(300);
    ok(!pad(till3), 'within the limit the till is not asked for the PIN');
    await finish('the payment within the limit to be made');
    ok((await bal2()) === 900 && pins() === 0 && n.state.noPinSpent === 300 && R2.sheet.filter((x) => /^begin:/.test(x)).length === 1,
       'it is paid in the first tap, with no PIN, and the card counts 300 of its 500', (await bal2()) + ' / ' + n.state.noPinSpent);
    await look();
    v = vals(owner);
    ok(limitsSub(v) === 'No PIN up to ₿500 · ₿200 left today', 'the menu says 200 is left today', limitsSub(v));
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
    limits(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    owner.fcLimitConfirm(0);
    {
      const cf = owner.fcLimitSpec();
      ok(cf.amountLabel === 'YOU ARE REMOVING THIS CARD’S NO PIN LIMIT.' && cf.amount === 'NO LIMIT' && cf.warn === 'Every payment will ask for the PIN.' && cf.cta === 'CONFIRM',
         'NO LIMIT under the keypad is confirmed in its own words: every payment will ask for the PIN', JSON.stringify([cf.amountLabel, cf.warn]));
    }
    owner.fcLimitSpec().go();
    await until('the no PIN limit to be removed', () => owner.state.fc.noPin && owner.state.fc.noPin.limit === 0);
    ok(n.state.noPinLimit === 0 && owner.toasts.indexOf('No PIN limit removed.') >= 0 && limitsSub(vals(owner)) === '' && limitOf(owner) === 'NO LIMIT',
       'and the card has none, and its screen says so', limitOf(owner));

    // in dollars where there is a price: kept at those dollars
    owner.price = 100000;
    owner.fcSetLimit();
    limits(owner).press('NO PIN LIMIT');
    card(owner).press('CONTINUE');
    ok(owner.state.unit === 'USD', 'with a price the amount is asked in dollars first');
    owner.fcLimitTxNext(0, 0);
    owner.state.amount = '0.50';
    owner.fcAmountNext();
    ok(/It is kept at this many dollars: this phone sets the card again when the price has moved\. /.test(owner.fcLimitSpec().warn), 'and the confirmation says it is kept at those dollars');
    owner.fcLimitSpec().go();
    await until('the limit in dollars to be set', () => owner.state.fc.noPin && owner.state.fc.noPin.limit === 500);
    ok(H2.W.cardNoPinUsd(n.key) === 0.5, 'the wallet keeps the dollars it was set in', String(H2.W.cardNoPinUsd(n.key)));
    owner.price = 0;

    /* a card of software 1.15 has always asked for its PIN: the same first tap, then the pad, then the second */
    {
      await H2.W.cardSetUp(old, { pin: '1234', recoverable: false });
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

    // every card is set up so that this phone can take it back: SET UP on a card with no PIN asks nothing, and the tap makes it so
    for (const listed of [true, false]) {
      const n2 = newCard(H2, undefined, { format: 4 });
      owner.FC_RECOVERABLE = listed;
      H2.nfc = n2;
      const listedBefore = H2.W.cardsList().length;
      owner.toasts.length = 0;
      owner.goFlashcard();
      await until('another new card to be read', () => !!owner.state.fc && owner.state.fc.key === n2.key);
      owner.fcSetUp();
      ok(!pad(owner) && !(card(owner) && card(owner).title === 'IF THE CARD IS LOST'),
         'with the list of cards ' + (listed ? 'shown' : 'hidden') + ', SET UP asks nothing: no PIN, and no IF THE CARD IS LOST', card(owner) && card(owner).title);
      await until('the recoverable card to be set up with no PIN', () => owner.state.screen === 'flashcard' && !!n2.state.owner && owner.toasts.indexOf('The card is set up.') >= 0);
      ok(n2.state.pinState === 0 && /^0[23]/.test(n2.state.record.refund) && H2.W.cardsList().length === listedBefore + 1 && owner.state.fc.recoverable,
         'and the card is set up with no PIN and its key of this phone’s on it', n2.state.record.refund);
    }
    owner.FC_RECOVERABLE = true;
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
   * row of RESET, CHANGE PIN and LIMITS is drawn as the receive screen's row, HOME is the round button at the top left and HISTORY the first row of its menu; the card's clock is said as a block under
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
    ok(owner.state.fc.resetKnown === true && menuOf(v) === 'HISTORY,RENAME CARD,LIMITS,CHANGE PIN,TRANSFER,RESET' && histFirst(v),
       'a card of 1.17 read by its owner: HOME at the top left, and a MENU of HISTORY, LIMITS, CHANGE PIN, TRANSFER and RESET', menuOf(v));
    ok(v.fcMenuItems.every((k) => typeof k.tap === 'function' && /^M/.test(k.path)) && new Set(v.fcMenuItems.map((k) => k.path)).size === 6, 'each a row with its own drawing');
    ok(v.fcMenuItems.find((k) => k.label === 'TRANSFER').path === 'M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5',
       'TRANSFER has the swap arrows the app already draws for SWAP');
    ok(owner.state.fc.headers === true && v.fcBlockShown === undefined && v.fcBlockLine === undefined && VERIFIED_AT.test(verOf(owner)),
       'a card whose clock is block headers says no block under the time it was verified: the screen has no block line', verOf(owner));
    const HASH = '00000000000000000001fa7ca83e1eb90d5a1865d8db9684f3f03ca64ccaec8a';
    owner.state.fc = Object.assign({}, owner.state.fc, { clock: { hash: HASH, short: '1fa7ca83', time: 4102358400 } });
    H2.storage.setItem('foxy.flashcard.heights', JSON.stringify([{ hash: HASH, height: 970809, time: 4102358400 }]));
    ok(vals(owner).fcBlockLine === undefined && vals(owner).fcBlockShown === undefined, 'nor once it has a block whose height this phone knows', vals(owner).fcBlockLine);
    H2.storage.removeItem('foxy.flashcard.heights');
    ok(vals(owner).fcClockLine === undefined && vals(owner).fcClockShown === undefined, 'and there is no CLOCK line under the limits');
    // the limit line: "| NO PIN" for a card without one
    const lineOf = (over) => { const was = owner.state.fc; owner.state.fc = Object.assign({}, was, over); const l = limitOf(owner); owner.state.fc = was; return l; };
    // (a daily limit is not said: a card whose one limit is a daily one says nothing of limits)
    ok(lineOf({}) === 'NO LIMIT' && lineOf({ pinSet: false }) === 'NO LIMIT | NO PIN' && lineOf({ pinSet: false, limit: 500 }) === 'NO PIN'
       && lineOf({ limit: 500 }) === ''
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
      // the card maker's record (the mint "-", the design it was printed in): drawn in that design, as a new card with no mint and no menu
      const made = newCard(H2, undefined, { format: 4, software: 24 });
      await made.send('00a404000af0464f5859434152440100');
      await made.send('b0320000' + '68' + '00' + '00'.repeat(33) + '00'.repeat(65) + '01' + '2d' + Buffer.from('EL1', 'latin1').toString('hex'));
      await look(owner, H2, made);
      const mv = vals(owner);
      ok(mv.fcDesign === 'EL1' && owner.state.fc.hasRecord === false && owner.state.fc.setUp === false && mv.fcPill === false && mv.fcMintShown === false && mv.fcMenuItems.length === 0,
         'a card the maker wrote EL1 on is drawn EL1, new: no mint, no pill, no menu', JSON.stringify([mv.fcDesign, mv.fcPill, mv.fcMintShown, mv.fcMenuItems.length]));
    }
    await look(owner, H2, n);

    /* a phone that is not its owner, and a card of the software before */
    await look(other, R2, n);
    ok(other.state.fc.resetKnown === true && other.state.fc.ownedHere === false && !hasReset(other) && histFirst(vals(other)), 'on a phone that does not own the card, RESET is not in the row, and HISTORY is still first in its menu');
    other.fcReset();
    ok(card(other) && card(other).title === 'NOT THIS PHONE’S CARD' && !pad(other), 'and pressed anyway it says so, before it asks for anything', card(other) && card(other).title);
    card(other).press('CLOSE');
    const old16 = newCard(H2, undefined, { format: 4, software: 16 });
    await setUpWith(owner, H2, old16, '1234');
    await look(owner, H2, old16);
    ok(owner.state.fc.resetKnown === false && !hasReset(owner) && menuOf(vals(owner)) === 'HISTORY,RENAME CARD,LIMITS,CHANGE PIN,TRANSFER', 'a card of software 1.16 has no RESET: its menu has HISTORY, the two it can offer, and TRANSFER');
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
    ok(vals(owner).fcNew && owner.state.fc.owner === false && !hasReset(owner) && vals(owner).fcMenuItems.length === 0, 'and it reads as new, with nothing to reset');

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
    limits(owner).press('PER SECOND LIMIT');
    {
      explainer(owner).finish();
      const y = explainer(owner);
      ok(y.done && y.all === ['How tap limit works', 'Any payment request over your limit requires you to tap and hold your card longer.', 'EXAMPLE LIMIT', '$10',
                              '$0.01 \u2013 $10.00', '~1\u20134 SEC TAP', '$10.01 \u2013 $20.00', '~3 SEC TAP', '$20.01 \u2013 $30.00', '~6 SEC TAP', '$30.01 \u2013 $40.00', '~9 SEC TAP',
                              'And so on\u2026', 'CANCEL', 'CONTINUE'].join(' | '),
         'HOW TAP LIMIT WORKS for a card of 1.18: ~1\u20134 within the limit, then ~3, ~6 and ~9, about three seconds a limit (a card before 1.25)', y.all);
      y.press('CONTINUE');
      // (no price here: the rate is typed in sats, a limit of one second of it)
      ok(owner.state.screen === 'amount' && owner.state.flow === 'cardLimit' && owner.fcLimitQuestion() === 'What is the most this card should pay each second?', 'with no price, CONTINUE asks the rate on SET AMOUNT, in sats');
      keyIn(owner, 2000);
      ok(owner.state.fcLimit.sats === 2000 && /held about 3 seconds, and 3 seconds more for every ₿ 2,000 beyond that\./.test(owner.fcLimitSpec().warn) && owner.fcLimitSpec().amount === '₿2,000 / sec',
         'and its confirmation says the rate, and the hold over the limit it makes on a card before 1.25 (3 s \u00d7 (N \u2212 1))', owner.fcLimitSpec().amount + ' | ' + owner.fcLimitSpec().warn);
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
      // a card of 1.21, whose every load wants its PIN
      const keyed = newCard(H2, undefined, { format: 4, software: 21 });
      await setUpWith(other, R2, free, '');
      // (set up by this phone, with its PIN, as a card of 1.21 is: its owner claimed in the set-up's held tap; on file here)
      keyed.tap();
      await H2.W.cardSetUp(keyed, { pin: '1234' });
      // the last card this phone reads before the sends: its own of 1.20, which wants no PIN first
      await look(owner, H2, n);
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
      /* The PIN is asked ahead (`fcSendPinFirst`) only of a card known to want it, 1.21 and on with a PIN: the last card this phone
       * read was its own of 1.20, so the card is read first, and a card with no PIN is asked for none (it was asked for one it has
       * not got, and the PIN typed was dropped). */
      ok(!pad(owner) && H2.sheet[0] === 'begin: Tap behind the phone.', 'NEXT brings the sheet up at once: no PIN pad for a card not known to want one', (pad(owner) && pad(owner).cta) + ' | ' + H2.sheet[0]);
      await until('the money to be on the card', () => owner.state.screen === 'paid' && owner.state.paidSays === 'ON THE CARD');
      await settle();
      ok(free.balance() === 700 && owner.state.paidAmount === 700 && owner.state.stack.slice(-1)[0] === 'home' && (await H2.W.balanceSats()) < had - 699,
         'a card with no PIN took the money in that tap, and ON THE CARD, the success screen, says so over Home', owner.state.paidAmount + ' | ' + free.balance());
      ok(H2.W.cardOwed().length === 0 && H2.sheet.filter((x) => /^begin:/.test(x)).length === 1, 'in one sheet, and nothing is left owed', H2.sheet.join(' / '));
      owner.setState({ screen: 'home', stack: [] }); if (owner.paidDismissed) owner.paidDismissed(); await new Promise((ok2) => setTimeout(ok2, 100));
      ok(owner.state.screen === 'home' && owner.state.stack.length === 0, 'DONE: home');
      // a card with a PIN ends the sheet asking for it, and the pad comes up
      owner.setState({ screen: 'sendHow', stack: ['home'] });
      owner.fcSendCard();
      H2.nfc = keyed;
      H2.sheet.length = 0;
      keyIn(owner, 500);
      await until('the PIN pad', () => !!pad(owner));
      /* (the card last read, the one with no PIN, is not this phone's, and the cards on file are not all of 1.21, so this one is read
       * first: it says it wants its PIN, and nothing is made or written) */
      ok(H2.sheet.indexOf('end: Enter the card’s PIN') >= 0 && !H2.sheet.some((x) => /^error:/.test(x)) && keyed.balance() === 0 && H2.W.cardOwed().length === 0 && owner.state.screen === 'amount',
         'a card with a PIN, not known before: the sheet ends saying so, in no red, with nothing made or written', H2.sheet.join(' / '));
      ok(pad(owner).title === 'CARD PIN' && pad(owner).cta === 'TAP AGAIN' && /^To put ₿500 on the card\./.test(pad(owner).sub), 'the pad says what the PIN is for, and TAP AGAIN writes it', pad(owner).cta + ' | ' + pad(owner).sub);
      // a wrong PIN: the pieces were made, owed to the card, and the way on is the pad again
      H2.sheet.length = 0;
      pad(owner).type('9999');
      await until('the wrong PIN to be said', () => card(owner) && card(owner).title === 'WRONG PIN');
      ok(keyed.balance() === 0 && H2.W.cardOwed().length === 1 && card(owner).has('TRY AGAIN'), 'a wrong PIN is said; what was made for the card is owed to it', card(owner).title + ' | ' + H2.W.cardOwed().length);
      card(owner).press('TRY AGAIN');
      await until('the PIN pad again', () => !!pad(owner));
      ok(/ON CARD$/.test(pad(owner).cta), 'TRY AGAIN asks for the PIN to put it on', pad(owner).cta);
      pad(owner).type('1234');
      await until('the money to be on the card', () => owner.state.screen === 'paid' && owner.state.paidSays === 'ON THE CARD');
      await settle();
      ok(keyed.balance() === 500 && H2.W.cardOwed().length === 0, 'and with the right one it is on', String(keyed.balance()));
      owner.setState({ screen: 'home', stack: [] }); if (owner.paidDismissed) owner.paidDismissed(); await new Promise((ok2) => setTimeout(ok2, 100));
      /* and with its PIN right the first time. The card last read is this one, this phone's own of 1.21 with a PIN: known to want it,
       * so the PIN comes before any sheet, and the card is tapped once */
      owner.setState({ screen: 'sendHow', stack: ['home'] });
      owner.fcSendCard();
      H2.sheet.length = 0;
      keyIn(owner, 300);
      await until('the PIN pad', () => !!pad(owner));
      ok(pad(owner).cta === 'TAP CARD' && !H2.sheet.some((x) => /^begin:/.test(x)) && owner.fcSendPinFirst() === true,
         'a card of 1.21 just read: the PIN pad first, before any sheet, and TAP CARD writes it in the one tap', pad(owner).cta + ' | ' + H2.sheet.join(' / '));
      pad(owner).type('1234');
      await until('the money to be on the card', () => owner.state.screen === 'paid' && owner.state.paidSays === 'ON THE CARD');
      await settle();
      ok(keyed.balance() === 800 && owner.state.paidAmount === 300 && H2.sheet.filter((x) => /^begin:/.test(x)).length === 1, 'the right PIN writes it, in one sheet', String(keyed.balance()) + ' | ' + H2.sheet.join(' / '));
      const lastRead = H2.W.cardLastRead();
      ok(!!lastRead && lastRead.key === keyed.key && lastRead.info.pinFirst === true && lastRead.info.version === '1.21',
         'the wallet keeps the last card read in any flow, its key and what it said (`cardLastRead`)', JSON.stringify(lastRead && [lastRead.key === keyed.key, lastRead.info.version]));
      owner.setState({ screen: 'home', stack: [] }); if (owner.paidDismissed) owner.paidDismissed(); await new Promise((ok2) => setTimeout(ok2, 100));
      // offline, it says why
      owner.offline = true;
      owner.setState({ screen: 'sendHow', stack: ['home'] });
      owner.fcSendCard();
      ok(owner.state.screen === 'sendHow' && owner.toasts.slice(-1)[0] === 'Putting money on a card needs a connection.', 'offline it says so and goes no further', owner.toasts.slice(-1)[0]);
      owner.offline = false;
    }

    /* Which card the PIN-first rule asks (`fcPinInfo`): off the card's screen the last card read by any flow, never the card on the
     * screen this phone was last on; on it the card shown where that is the one last read. A till whose owner had opened his own 1.21
     * card and swiped home asked a customer's 1.20 card with no PIN for one, for its change. And SEND > FLASHCARD asks ahead only of a
     * card known to want it (`fcSendPinFirst`): the last card read, or else the cards on file that say what they were. */
    {
      ok(H2.W.cardsKnown()[n.key] && H2.W.cardsKnown()[n.key].software === '1.' + n.version && H2.W.cardsKnown()[n.key].pinFirst === false,
         'a card on file says the software it was last read with, and that it does not want its PIN first', JSON.stringify(H2.W.cardsKnown()[n.key] && [H2.W.cardsKnown()[n.key].software, H2.W.cardsKnown()[n.key].pinFirst]));
      const realW = owner.fcW, realCard = owner._fcCard, realState = { screen: owner.state.screen, stack: owner.state.stack };
      const own = { key: '02own', info: { version: '1.21', pinFirst: true, pinSet: true } };
      const stranger = { key: '02stranger', info: { version: '1.20', pinFirst: false, pinSet: false } };
      const new21 = { key: '02new', info: { version: '1.21', pinFirst: true, pinSet: false } };
      let last = null, file = {};
      owner.fcW = () => ({ cardLastRead: () => last, cardsKnown: () => file });
      const rule = () => [owner.fcKnownPinFirst(), owner.fcNoPinWords()].join(' | ');
      owner.setState({ screen: 'home', stack: [] });
      owner._fcCard = own;
      last = { key: stranger.key, info: stranger.info, at: Date.now() };
      ok(rule() === 'false | No PIN is needed.', 'off the card’s screen: the customer’s card just read, not the owner’s card left in memory: no PIN asked', rule());
      last = { key: own.key, info: own.info, at: Date.now() };
      owner._fcCard = null;
      ok(rule() === 'true | Its PIN is asked first.', 'a card of 1.21 with a PIN just read: its PIN first', rule());
      last = { key: new21.key, info: new21.info, at: Date.now() };
      ok(rule() === 'false | No PIN is needed.' && owner.fcCardPinFirst() === false, 'a card of 1.21 with no PIN set: none to ask', rule());
      last = null;
      ok(rule() === 'false | No PIN is needed.', 'no card read: as before, no PIN first', rule());
      owner.setState({ screen: 'flashcard', stack: ['home'] });
      owner._fcCard = own;
      last = { key: own.key, info: own.info, at: Date.now() };
      ok(owner.fcCardPinFirst() === true, 'on the card’s screen, the card shown when it is the one last read');
      last = { key: stranger.key, info: stranger.info, at: Date.now() };
      ok(owner.fcCardPinFirst() === false, 'and the card last read when another has been read since', String(owner.fcCardPinFirst()));
      // SEND > FLASHCARD (from home: no card on screen)
      owner.setState({ screen: 'home', stack: [], fc: null });
      const ahead = [];
      file = { [own.key]: { pinFirst: true, software: '1.21' }, [new21.key]: { mint: 'm' } };
      last = { key: own.key, info: own.info, at: Date.now() };
      ahead.push(owner.fcSendPinFirst());                    // its own card of 1.21 with a PIN, just read
      last = { key: new21.key, info: new21.info, at: Date.now() };
      ahead.push(owner.fcSendPinFirst());                    // its own card of 1.21 with no PIN set, just read
      file = {};
      last = { key: stranger.key, info: stranger.info, at: Date.now() };
      ahead.push(owner.fcSendPinFirst());                    // a customer's card of 1.20 just read, nothing on file
      last = { key: own.key, info: own.info, at: Date.now() };
      ahead.push(owner.fcSendPinFirst());                    // a customer's card of 1.21 just read, not this phone's: not the likely card
      last = null;
      file = { a: { mint: 'm' } };
      ahead.push(owner.fcSendPinFirst());                    // none read, a card on file that says nothing
      file = { a: { pinFirst: true, software: '1.21' }, b: { mint: 'm' } };
      ahead.push(owner.fcSendPinFirst());                    // none read, the cards on file that say are all of 1.21
      file = { a: { pinFirst: true, software: '1.21' }, b: { pinFirst: false, software: '1.20' } };
      ahead.push(owner.fcSendPinFirst());                    // none read, one of them of 1.20
      ok(ahead.join() === 'true,false,false,false,false,true,false',
         'SEND > FLASHCARD asks the PIN ahead of this phone’s own 1.21 card with a PIN just read, not of one with no PIN, nor of a card that is not its own; with none of its own read, only where every card on file that says is 1.21 and on, and one does',
         ahead.join());
      /* the edge swipe back off the card's screen leaves the card behind, as HOME does; a screen above it comes back to it (the app's
       * own `back`, 01-ui-basics.js, lifted out of its file: the kit's stands in for it everywhere else) */
      const uiSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'app', '01-ui-basics.js'), 'utf8');
      const backAt = uiSrc.indexOf('\n  back() {') + 1;
      const realBack = new Function('return {' + uiSrc.slice(backAt, uiSrc.indexOf('\n  }\n', backAt) + 4) + '}')().back;
      owner.setState({ screen: 'history', stack: ['home', 'flashcard'] });
      owner._fcCard = own;
      realBack.call(owner);
      ok(owner._fcCard === own && owner.state.screen === 'flashcard', 'back from a screen above the card’s comes back to it, the card kept', owner.state.screen);
      realBack.call(owner);
      ok(owner._fcCard === null && owner.state.screen === 'home', 'back off the card’s screen leaves the card behind', String(owner._fcCard && owner._fcCard.key) + ' ' + owner.state.screen);
      owner.fcW = realW;
      owner._fcCard = realCard;
      owner.setState(realState);
    }
  }

  /* ---- the card standing up, and the lines under it --------------------------------------------------------------------------
   * The card on its screen stands upright, 54 by 85.6 with its 3.18mm corners to scale, as tall as the room the screen leaves it (160px
   * at the least, 440px at the most, and 26px less for each line under it), and the lines that were on its face (its limit, and its badge:
   * Blocked, Locked) are under it, in the spaced capitals the face had them in. FX1 is a picture drawn standing up
   * (img/card-fx1-portrait.jpg, made by tools/make-card-portrait.py from img/card-fx1.png); every other design is its face turned a quarter. */
  {
    const fs = require('fs'), path = require('path');
    const root = path.join(__dirname, '..');
    const markup = fs.readFileSync(path.join(root, 'build', 'markup.html'), 'utf8');
    const room = /<div data-card-room style="([^"]*)">/.exec(markup);
    const card = /<div data-card-portrait data-card-design="\{\{ fcDesign \}\}" style="([^"]*)">/.exec(markup);
    ok(!!room && /container-type:size/.test(room[1]) && /flex:1 1 0%/.test(room[1]) && !!card
       && card[1].indexOf('--ch:max(160px,min(calc(100cqh - {{ fcCardCap }}),440px,calc(100cqw * 85.6 / 54)))') >= 0
       && /width:calc\(var\(--ch\) \* 54 \/ 85\.6\)/.test(card[1]) && /border-radius:calc\(var\(--ch\) \* 3\.18 \/ 85\.6\)/.test(card[1]),
       'the card stands upright, 54 by 85.6 with its corners to scale, as tall as its room leaves it: 160px at least, 440px at most', card && card[1].slice(0, 120));
    // the lines: after the card, not on its face, once each
    const at = markup.indexOf('<div data-card-portrait data-card-design="{{ fcDesign }}"');
    const lines = markup.indexOf('<div data-card-lines', at);
    const face = markup.indexOf('<div data-card-face', at);
    // (after the card's turntable closes: its picture, its back drawn where it turns, 26j-card-wheel.js `fcSpinOn`)
    ok(face > at && lines > face && markup.indexOf('</div></div></sc-if></div></div><sc-if value="{{ fcFaceLines }}"><div data-card-lines', at) > 0
       && markup.indexOf('{{ fcLimitLine }}') < 0 && markup.indexOf('data-card-limit') < 0,
       'the badge line is under the card, and there is no limit line: the limit is in the card’s HISTORY');
    const badge = /<div data-card-badge style="([^"]*)">\{\{ fcCheck \}\}/.exec(markup);
    ok(!!badge && /text-transform:uppercase/.test(badge[1]) && /letter-spacing:\.3em/.test(badge[1]) && /color:\{\{ fcCheckInk \}\}/.test(badge[1]),
       'and its badge (Blocked, Locked) above it, under the card, the same capitals in its own ink');
    // the designs: FX1's own upright picture; any other its face turned a quarter
    ok(/\[data-card-portrait\]:not\(\[data-card-design="FX1"\]\) \[data-card-picture\]\{display:none\}/.test(markup)
       && /\[data-card-portrait\]\[data-card-design="FX1"\] \[data-card-turn\]\{display:none\}/.test(markup)
       && /<div data-card-picture style="[^"]*background:url\(img\/card-fx1-portrait\.jpg\) center\/cover no-repeat"><\/div>/.test(markup)
       && /<div data-card-turn style="[^"]*width:var\(--ch\);transform:translate\(-50%,-50%\) rotate\(90deg\);container-type:inline-size">/.test(markup),
       'FX1 is its own upright picture, and every other design is its face turned a quarter');
    // the picture: a JPEG of 1080 by 1712 (54:85.6), from its frame header
    const jpg = fs.readFileSync(path.join(root, 'Web', 'img', 'card-fx1-portrait.jpg'));
    let i = 2, size = null;
    while (i < jpg.length) {
      const mark = jpg[i + 1], len = jpg.readUInt16BE(i + 2);
      if (mark >= 0xc0 && mark <= 0xc2) { size = [jpg.readUInt16BE(i + 7), jpg.readUInt16BE(i + 5)]; break; }
      i += 2 + len;
    }
    ok(jpg[0] === 0xff && jpg[1] === 0xd8 && size && size[0] === 1080 && size[1] === 1712, 'img/card-fx1-portrait.jpg is 1080 by 1712, the card’s own proportions', JSON.stringify(size));
    // the pill under the card has no limit line
    const pill = markup.slice(markup.indexOf('{{ fcPillRows }}'), markup.indexOf('</sc-for>', markup.indexOf('{{ fcPillRows }}')));
    ok(pill.indexOf('fcLimitLine') < 0, 'the pill under the card has no limit line');
    // DEPOSIT and WITHDRAW, and no SCAN or PASTE on the card's screen
    const screen = markup.slice(markup.indexOf('<sc-if value="{{ isFlashcard }}">\n<div data-template="list"'), markup.indexOf('<sc-if value="{{ isFieldLog }}">'));
    ok(/>DEPOSIT<\/div>/.test(screen) && />WITHDRAW<\/div>/.test(screen) && !/>RECEIVE<\/div>/.test(screen) && !/>SEND<\/div>/.test(screen) && />CONNECT TO PHONE<\/div>/.test(screen),
       'the card’s two buttons read DEPOSIT and WITHDRAW, and its guest button CONNECT TO PHONE');
    // HOME is the round button at the top left, HISTORY in the card's menu, and RESET is no longer there
    ok(/sc-camel-on-click="\{\{ fcHome \}\}" role="button" aria-label="Home" data-home-button="1" style="position:absolute;left:22px;top:56px/.test(markup) && markup.indexOf('{{ fcHistory }}') < 0
       && markup.indexOf('fcResetVis') < 0 && markup.indexOf('{{ fcReset }}') < 0,
       'HOME is the round button at the top left of the card’s screen, and nothing there is for HISTORY or RESET any more');
  }

  /* ---- the screen before the sheet -------------------------------------------- */
  {
    // on a phone the sheet is asked for at once (FC_TAP_LEAD 0); a lead is still honoured where one is set: here sixty milliseconds, watched
    ok(Object.getPrototypeOf(holder).constructor.prototype.FC_TAP_LEAD === undefined ? true : true, 'the lead is a field of the app');
    const lead = new (Object.getPrototypeOf(holder).constructor)().FC_TAP_LEAD;
    ok(lead === 0, 'the app asks for the sheet at once, with no head start for the screen: a card already at the phone is the payment\u2019s to read and not the system banner\u2019s', String(lead));
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

  /* ---- a share of a split bill, paid by a card ------------------------------------------------------------------------
   * CARD on a payer's own screen takes that payer's share through the till's flow (`payShareByCard`), and the share is ticked
   * when the mint has vouched for the money and not before: its row in the bill's ledger, the collecting screen's own list, and
   * the screen is on to the next payer. One share to a tap. The bill is the app's own (the real ledger, its invoices made at the
   * test mint, `splitVals` for what the screen draws), and so are the screens the card flow reaches. */
  {
    const HB = await funded({}, 6000);
    const RB = await funded({ sharedMint: HB.mint, words: OTHER_WORDS }, 0);
    const bill = appOn(RB, { screen: 'spShares', stack: ['home'], spAmt: '300', spWays: 3, spIdx: 0, spPaid: [], spInvoices: [], spAssigns: [] }, { split: true });
    bill.price = 1000000;                     // a dollar is 100 sats, so each of the two other payers owes 100
    // what the screen draws for a share is `splitVals`' (its code and its animations are not what is looked at here)
    bill.boltField = () => []; bill.qrLoadingSrc = () => ''; bill.railRequest = () => ''; bill.chooseRail = () => {}; bill.tapArm = () => {}; bill.go = () => {};
    RB.W.qr = () => 'qr';
    // the test mint takes no description on an invoice (a bill’s shares are named “Split 2 of 3”), as some real ones do not
    const invoice0 = RB.W.invoice.bind(RB.W);
    RB.W.invoice = (sats, label, expiry) => invoice0(sats, '', expiry);
    const shares = (screen) => bill.splitVals(Object.assign({}, bill.state, screen ? { screen } : {}), screen || bill.state.screen);
    const rows = () => RB.W.splitRecord().rows;
    const begins = () => RB.sheet.filter((x) => /^begin:/.test(x)).length;
    // the watchers of the invoices: which of them are still asking the mint
    const watched = [];
    RB.W.watch = (hash, fn) => { const w = { hash, fn, stopped: false }; watched.push(w); return () => { w.stopped = true; }; };
    /* the history pass's own tail (16-history-lists.js): the reconcile ticks what has landed, and the screen follows (`spSyncPaid`). The test mint
     * calls every quote it makes paid, and the bill's invoices are not: the shares are paid some other way. And its swaps can be left unanswered. */
    bill.loadHistory = () => RB.W.splitReconcile().then(() => bill.spSyncPaid());
    let holdSwaps = false;
    RB.fate = (m) => {
      const url = String(m.url || '');
      if (/\/v1\/mint\/quote\/bolt11\/[0-9a-f]{32}$/.test(url)) return String(HB.mint.handle(m)).replace('"state":"PAID"', '"state":"UNPAID"');
      return holdSwaps && /\/v1\/swap$/.test(url) ? '0\n' : null;
    };
    // the history pass and PAYMENT RECEIVED (not in these parts): what is raised, and what a pass or a hold would have left for it
    const raised = [];
    bill.announcePayment = (ev) => raised.push(ev);
    const hold0 = bill.fcHoldConfirm.bind(bill);
    bill.fcHoldConfirm = (hash) => { hold0(hash); bill._heldConfirm = { hash, dir: 'in', sats: 100 }; bill._paidQueue = [{ hash }, { hash: 'card-someone-else' }]; };
    const startBill = async () => {
      RB.W.splitClear();
      watched.length = 0;
      bill.setState({ screen: 'spShares', stack: ['home'], spAmt: '300', spWays: 3, spIdx: 0, spPaid: [], spInvoices: [], spAssigns: [], spFromWaiting: false });
      bill.spMakeInvoices();
      await until('the bill’s two invoices to be made', () => (bill.state.spInvoices || []).length === 2);
      bill.setState({ screen: 'spPayer', spIdx: 0 });
    };
    const holding = async (sats, o) => {
      // `o.format`: 4 for a card that signs once and keeps the mint's proofs (1.20), which can pay with no route
      const k = newCard(HB, undefined, o && o.format ? { format: o.format } : undefined);
      await HB.W.cardSetUp(k, { pin: '1234' });
      await binaryLoad(HB, k, sats, o);
      return k;
    };

    /* a share with no code yet has nothing to be paid, and a code that is not the ledger's own is not paid either */
    RB.W.splitSave({ ways: 3, total: 300, at: Date.now(), rows: [{ hash: 'old-1', bolt11: 'lnbc-old-1', sats: 100, paid: false }, { hash: 'old-2', bolt11: 'lnbc-old-2', sats: 100, paid: false }] });
    bill.setState({ screen: 'spPayer', spIdx: 0, spInvoices: [] });
    shares().spCardPay();
    ok(bill.toasts.slice(-1)[0] === 'That share’s invoice is still being made.' && begins() === 0 && !pad(bill),
       'CARD on a share whose code is still being made says so, and asks nothing of a card (an earlier bill’s ledger is not this share’s)', bill.toasts.slice(-1)[0]);
    bill.setState({ spInvoices: ['lnbc-another-bill'] });
    shares().spCardPay();
    ok(bill.toasts.slice(-1)[0] === 'That share’s invoice is still being made.' && begins() === 0 && !pad(bill) && rows().every((r) => !r.paid),
       'nor is a code that is not the one the ledger holds for that share', bill.toasts.slice(-1)[0]);

    await startBill();
    const cb = await holding(2000, { owner: true });
    ok(rows().length === 2 && rows().every((r) => r.sats === 100 && !r.paid) && watched.length === 2 && watched.every((w) => !w.stopped),
       'a bill of $3.00 three ways, at a dollar of 100 sats: two shares owed, 100 sats each, each invoice watched', JSON.stringify(rows().map((r) => r.sats)));
    let v = shares();
    ok(v.spPayerIsQr === true && v.spCardShown === true && typeof v.spCardPay === 'function' && v.spButtonsW === '300px' && v.spShareLabel === 'SHARE',
       'the first share’s screen has CARD in the row beside SHARE, COPY and SCAN, four as the receive invoice screen has; the Bluetooth tap is in the QR', String(v.spButtonsW));

    // CARD: the sheet at once, then the PIN for the card that wants it, and the share’s own amount is asked
    RB.nfc = cb;
    cb.tap();
    RB.sheet.length = 0;
    v.spCardPay();
    ok(!pad(bill) && begins() === 1 && /^begin: /.test(RB.sheet[0]), 'CARD brings up the sheet at once, with no PIN asked for first, as on the receive screen', RB.sheet[0]);
    await until('the card to say it wants its PIN', () => !!pad(bill));
    ok(pad(bill).title === 'CARD PIN' && /To pay \$1\.00 \(₿100\)/.test(pad(bill).sub) && pad(bill).cta === 'TAP AGAIN'
       && bill.spPaidArr()[0] === false && rows()[0].paid === false && bill.state.spIdx === 0,
       'the card asks for its PIN, for the share’s 100 sats, and nothing is ticked yet', pad(bill).sub);
    pad(bill).type('1234');
    await until('the first share to be paid', () => bill.spPaidArr()[0] === true && !stage(RB));
    await settle();
    const first = history(RB).filter((e) => e.memo === 'card')[0];
    ok(rows()[0].paid === true && rows()[1].paid === false && bill.state.spPaid[0] === true && !bill.state.spPaid[1],
       'the mint has vouched for it, and the share is ticked in the bill’s ledger and in the list the collecting screen draws', JSON.stringify(rows().map((r) => !!r.paid)));
    ok(watched[0].stopped === true && watched[1].stopped === false, 'its invoice is no longer asked about, and the other share’s still is');
    ok(bill.state.screen === 'spPayer' && bill.state.spIdx === 1 && v.spPayerTitle === 'PAYER 2' && shares().spPayerTitle === 'PAYER 3',
       'the screen is on to the next payer, as it is after a tap', bill.state.screen + ' ' + bill.state.spIdx);
    ok((await RB.W.balanceSats()) === 100 && first && first.sats === 100 && RB.W.tagsFor(first.hash).to === 'card payment' && !RB.W.cardOwed().length,
       'the till holds the share’s 100 sats, and its entry reads as a card payment’s does at the receive screen, with the card’s change back on it', String(first && first.sats));
    ok(bill.seen[first.hash] === true && raised.length === 0 && !bill._heldConfirm && bill._paidQueue.map((q) => q.hash).join() === 'card-someone-else',
       'and it is attached to the bill: its entry is marked announced, it is let go from the queue and from the hold for the change, and no PAYMENT RECEIVED is raised for it',
       JSON.stringify({ seen: bill.seen[first.hash], raised: raised.length, held: !!bill._heldConfirm, queue: (bill._paidQueue || []).map((q) => q.hash) }));
    ok(shares('spWaiting').spWaitRows.map((r) => r.status).join() === 'RECEIVED,PENDING' && shares('spWaiting').spWaitFrac === '1/2',
       'the collecting screen ticks it from the same list it ticks the others from', shares('spWaiting').spWaitRows.map((r) => r.status).join());

    // one share to a tap: nothing came up for the next payer by itself, and the paid one has no CARD
    ok(begins() === 2, 'it took the tap and the tap again for the PIN, and no sheet came up for the next share', String(begins()));
    bill.setState({ spIdx: 0 });
    v = shares();
    ok(v.spCardShown === false && v.spButtonsW === '300px' && v.spPayerIsQr === true, 'a share that is paid has no CARD, and its row is as wide as it was');
    const before = begins();
    v.spCardPay();
    ok(bill.toasts.slice(-1)[0] === 'That share is already paid.' && begins() === before && !pad(bill), 'and pressed all the same, it says so and asks nothing of a card', bill.toasts.slice(-1)[0]);
    bill.setState({ spIdx: 1 });

    // the next share is its own press and its own tap, with the same card; a wrong PIN is said, nothing is ticked, and TRY AGAIN keeps the share
    v = shares();
    ok(v.spCardShown === true, 'the next share has its own CARD');
    cb.tap();
    v.spCardPay();
    await until('the PIN pad', () => !!pad(bill));
    pad(bill).type('0000');
    await until('the card to say the PIN was wrong', () => card(bill) && card(bill).title === 'WRONG PIN');
    ok(card(bill).reason === '2 tries left. Nothing was taken.' && bill.spPaidArr()[1] === false && rows()[1].paid === false && bill.state.spIdx === 1 && bill.state.screen === 'spPayer',
       'a wrong PIN: said, nothing taken, nothing ticked, and the share is still on screen', card(bill).reason);
    cb.tap();
    card(bill).press('TRY AGAIN');
    pad(bill).type('1234');
    await until('the last share to be paid', () => bill.state.screen === 'spAllPaid');
    await settle();
    ok(rows().every((r) => r.paid) && RB.W.splitRecord().done === true && bill.spPaidArr().every(Boolean) && watched.every((w) => w.stopped),
       'TRY AGAIN paid the same share, and with every share paid the screen is EVERYONE HAS PAID', bill.state.screen);
    ok(begins() === 5 && (await RB.W.balanceSats()) === 200 && raised.length === 0 && cb.balance() === 1800,
       'each share was its own tap (the second took the first tap, the wrong PIN, and the right one): 200 paid, the card’s change back, and nothing announced',
       JSON.stringify({ sheets: begins(), till: await RB.W.balanceSats(), card: cb.balance(), raised: raised.length }));

    /* a card that holds too little: refused as at the receive screen, before the PIN, and nothing is ticked */
    await startBill();
    const poor = await holding(50);
    RB.nfc = poor;
    poor.tap();
    shares().spCardPay();
    await until('too little to be said', () => card(bill) && card(bill).title === 'NOT ENOUGH ON THE CARD');
    ok(card(bill).reason === 'It holds ₿50. Nothing was taken.' && bill.spPaidArr()[0] === false && rows()[0].paid === false && bill.state.spIdx === 0,
       'more than the card holds: refused before it signs anything, and the share is not ticked', card(bill).reason);
    card(bill).press('CLOSE');

    /* the mint has not said paid when the card has signed: CHECKING, and the share is ticked only when it does */
    const cc = await holding(2000, { owner: true });
    RB.nfc = cc;
    cc.tap();
    holdSwaps = true;                          // the swap never reaches the mint
    shares().spCardPay();
    await until('the PIN pad', () => !!pad(bill));
    cc.tap();
    pad(bill).type('1234');
    await until('the CHECKING screen', () => stage(RB) === 'cardChecking');
    ok(bill.spPaidArr()[0] === false && rows()[0].paid === false && bill.state.spIdx === 0 && bill.state.screen === 'spPayer',
       'the card has signed and the mint has not answered: the share is not ticked', String(bill.spPaidArr()[0]));
    holdSwaps = false;
    await until('the mint to say paid', () => bill.spPaidArr()[0] === true && !stage(RB));
    await settle();
    ok(rows()[0].paid === true && rows()[1].paid === false && bill.state.spIdx === 1 && watched[0].stopped === true && raised.length === 0,
       'and when it says paid, while CHECKING is up, the share is ticked and the screen is on to the next payer, with no PAYMENT RECEIVED of its own', JSON.stringify(rows().map((r) => !!r.paid)));

    /* the same, and CHECKING is closed before the mint answers: the payment is only in HISTORY, and the share is ticked when it lands, whoever
     * notices (the reconcile, and the screen from it), and the collecting screen goes on to EVERYONE HAS PAID with it */
    const late = await holding(1000, { owner: true });
    RB.nfc = late;
    late.tap();
    holdSwaps = true;
    shares().spCardPay();
    await until('the PIN pad', () => !!pad(bill));
    late.tap();
    pad(bill).type('1234');
    await until('the CHECKING screen', () => stage(RB) === 'cardChecking');
    RB.window.document.querySelector('#foxy-stage [data-stage-button]').dispatchEvent(new RB.window.Event('click', { bubbles: true }));
    ok(!stage(RB) && bill.spPaidArr()[1] === false && rows()[1].paid === false && /^card-/.test(rows()[1].card || '') && !card(bill),
       'CHECKING closed with the mint not heard from: the share is not ticked, and its row names the entry that is to pay it', String(rows()[1].card));
    bill.setState({ screen: 'spWaiting' });                 // and the person is looking at the collecting screen
    holdSwaps = false;
    await RB.W.cardSettle();                                // the wallet’s own settling, when it has a connection: the payment lands
    await settle();
    bill.loadHistory();                                     // and the next history pass
    await until('the late share to be ticked', () => bill.spPaidArr()[1] === true);
    await settle();
    ok(rows()[1].paid === true && RB.W.splitRecord().done === true && bill.state.screen === 'spAllPaid' && watched[1].stopped === true && raised.length === 0
       && shares('spWaiting').spWaitRows.map((r) => r.status).join() === 'RECEIVED,RECEIVED',
       'when the payment lands, late, the share is ticked from the ledger, its invoice is no longer asked about, and the collecting screen goes on to EVERYONE HAS PAID',
       JSON.stringify({ rows: rows().map((r) => !!r.paid), screen: bill.state.screen }));

    /* with no route: a card that proves its money (1.20) signs the share over to this phone, and the payment is received at once, so
     * the share is ticked then; the mint's swap at the next connection settles it and changes nothing on the bill */
    await startBill();
    const exact = await holding(100, { format: 4 });          // 64 32 4: exactly a share, which is all a till with no route takes
    RB.nfc = exact;
    // the HIGH RISK question is plain ecash's: a share paid by a card never raises it
    const askedB = [];
    RB.W.onOfflineOffer((info) => { askedB.push(info); return bill.offlineRiskCard(info); });
    const offline = () => RB.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    const online = () => RB.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    offline();
    shares().spCardPay();
    ok(!card(bill) && askedB.length === 0, 'a share paid by a card with no route goes straight to the card, with no HIGH RISK card', card(bill) && card(bill).title);
    await until('the PIN pad', () => !!pad(bill));
    exact.tap();
    pad(bill).type('1234');
    await until('the share to be ticked', () => bill.spPaidArr()[0] === true);
    await settle();
    ok(rows()[0].paid === true && /^req-card-/.test(rows()[0].card || '') && RB.W.cardKeptWaiting().length === 1 && RB.W.trustedWaiting().length === 0 && !card(bill) && askedB.length === 0,
       'kept for the mint and received: the entry is named on the share’s row, and the share is ticked at once, since that entry is settled', JSON.stringify(rows().map((r) => !!r.paid)));
    online();
    await RB.W.claimUnclaimed();                            // the swap, once there is a route
    await settle();
    bill.loadHistory();
    await settle();
    ok(rows()[0].paid === true && rows()[1].paid === false && RB.W.cardKeptWaiting().length === 0 && raised.length === 0,
       'swapped at the next connection, the share stays ticked and nothing more is said', JSON.stringify(rows().map((r) => !!r.paid)));

    /* a card that leaves before it has signed for all of a share, and is not brought back when the sheet looks for it: NOT PAID YET, and
     * TAP CARD finishes the same share, which is ticked then and not before */
    await startBill();
    const left = await holding(100);          // 64 32 4: three signatures, one at a time
    RB.nfc = left;
    const tapLeft = left.tap, sendLeft = left.send;
    const rb = await RB.W.balanceSats();
    shares().spCardPay();
    await until('the PIN pad', () => !!pad(bill));
    left.tap = () => { tapLeft(); left.leaveBefore('20', 2); left.tap = tapLeft; };
    left.send = (x) => sendLeft(x).then((r) => r, (err) => { RB.nfc = null; throw err; });
    pad(bill).type('1234');
    await until('NOT PAID YET to be said', () => card(bill) && card(bill).title === 'NOT PAID YET');
    left.send = sendLeft;
    ok(bill.spPaidArr()[0] === false && rows()[0].paid === false && bill.state.spIdx === 0 && (await RB.W.balanceSats()) === rb && card(bill).has('TAP CARD'),
       'a card taken away before it had signed for all of a share: NOT PAID YET, the share is not ticked, and nothing is paid', card(bill).all);
    RB.nfc = left;
    left.tap();
    card(bill).press('TAP CARD');
    await until('the tap that finishes it', () => bill.spPaidArr()[0] === true && !stage(RB));
    await settle();
    ok(rows()[0].paid === true && rows()[1].paid === false && bill.state.spIdx === 1 && (await RB.W.balanceSats()) - rb === 100 && left.balance() === 0 && !pad(bill) && raised.length === 0,
       'TAP CARD signs the rest, with no PIN asked for again, and it is that same share which is ticked, with the screen on to the next payer', JSON.stringify(rows().map((r) => !!r.paid)));
    // and where the phone cannot ask for the card again in the same sheet, a new sheet is begun for the same payment, a moment later
    const runs = [];
    const run0 = bill.fcPayRun.bind(bill);
    bill.fcPayRun = (...a) => { runs.push(a); };
    bill.fcResumeNow(100, '1234', false, { idx: 1, hash: rows()[1].hash });
    await new Promise((go) => setTimeout(go, 2700));
    bill.fcPayRun = run0;
    bill.hideStage('card');
    clearTimeout(bill._fcHeldT);
    ok(runs.length === 1 && runs[0][3] === true && runs[0][4] && runs[0][4].idx === 1 && runs[0][4].hash === rows()[1].hash,
       'and the payment begun again after a pause is taken up for the same share', JSON.stringify(runs.map((a) => a.slice(0, 5))));
    clearTimeout(bill._spResumeT);
  }
  /* ---- a card held to the phone: its address opens Foxy (build/app/26f-flashcard.js, `cardTapped`) ---------------------------------
   *
   * A Foxy card answers as a tag that carries one address, and iOS opens Foxy with it when the person taps the banner. The phone
   * tells the page one thing, that a card was tapped (FoxyWallet._cardTapped), and the page does what MENU > FLASHCARD does if it is
   * a moment for it. The tap is the real one here, against the model of the card; tests/deep-links.js holds the rule for every
   * screen, and what the phone may pass on. */
  {
    const F = await funded({}, 0);
    const app = appOn(F);
    const fresh = newCard(F);
    F.nfc = fresh;
    app.CARD_TAP_POLL_MS = 5;
    const begins = () => F.sheet.filter((l) => /^begin: /.test(l)).length;
    // the lock\u2019s own pad (10-pin.js), which is not a card\u2019s gated one: its keys by their digits, then UNLOCK
    const lockPad = () => (app._pinEl && app._pinEl.parentNode ? app._pinEl : null);
    const leaves = (root) => Array.from(root.querySelectorAll('div')).filter((d) => d.childElementCount === 0);
    const press = (el) => el.dispatchEvent(new F.window.Event('click', { bubbles: true }));
    const typeOnLock = (digits) => {
      const root = lockPad();
      String(digits).split('').forEach((d) => press(leaves(root).filter((x) => x.textContent === d)[0].parentNode));
      press(leaves(root).filter((x) => x.textContent === 'UNLOCK')[0]);
    };
    // back to a quiet home, whatever the last case left
    const quiet = () => {
      app.hideStage();
      app.pinDismiss();
      if (app._blockedEl) app.dismissCard(app._blockedKind);
      app.setState({ screen: 'home', stack: [], fc: null, open0: false });
    };

    /* from home, with the menu's drawer open: the tap begins at once, as the menu's row begins it */
    app.state.open0 = true;
    ok(app.cardTapped() === true, 'the page says it has the request');
    ok(begins() === 1 && F.sheet[0] === 'begin: Tap behind the phone.' && stage(F) === 'card' && app.state.open0 === false,
       'from home the tap begins at once, the phone’s sheet asked for in the menu’s own words, with the screen for it up and the drawer shut', F.sheet[0]);
    await until('the card to be read', () => !!app.state.fc);
    ok(app.state.screen === 'flashcard' && app.state.stack.slice(-1)[0] === 'home' && !stage(F),
       'and a card read is the card’s screen, with home behind it, exactly as MENU > FLASHCARD leaves it');
    await settle();

    /* from a screen where nothing is in progress: the same, and back is where the person was */
    app.setState({ screen: 'history', stack: ['home'], fc: null });
    app.cardTapped();
    await until('the card to be read from history', () => app.state.screen === 'flashcard' && !!app.state.fc);
    ok(begins() === 2 && app.state.stack.join() === 'home,history', 'from HISTORY it is the same tap, and the card’s screen sits on top of it', app.state.stack.join());
    app.back();
    ok(app.state.screen === 'history', 'back from it is HISTORY');
    await settle();

    /* the card’s own screen with no sheet up: the tap begins again, and the screen stays the card’s */
    app.setState({ screen: 'flashcard', stack: ['home'] });
    const before = begins();
    app.cardTapped();
    ok(begins() === before + 1 && stage(F) === 'card', 'from the card’s own screen with no sheet up it reads the card again');
    await until('the card to be read again', () => !!app.state.fc && !stage(F));
    ok(app.state.screen === 'flashcard' && app.state.stack.join() === 'home', 'and stays on the card’s screen, not on the stack twice', app.state.stack.join());
    await settle();

    /* twice in a row is the same tap; with the tap’s sheet up it is ignored */
    quiet();
    const one = begins();
    app.cardTapped();
    app.cardTapped();
    ok(begins() === one + 1, 'twice in a row, the tap begins once');
    app.cardTapped();
    ok(begins() === one + 1 && stage(F) === 'card', 'and with the sheet up a third is ignored too');
    await until('the card to be read', () => !!app.state.fc && !stage(F));
    await settle();
    quiet();
    app.goFlashcard();
    app.cardTapped();
    ok(begins() === one + 2, 'MENU > FLASHCARD and the card’s address together are one tap');
    await until('the card to be read', () => !!app.state.fc && !stage(F));
    await settle();

    /* a payment, an amount being typed, a confirmation, a card flow in progress: ignored, and nothing is begun */
    const mid = begins();
    for (const screen of ['sendConfirm', 'amount', 'sendDone', 'paid', 'spPayer', 'tokenOut', 'fcMoveConfirm', 'crossConfirm']) {
      quiet();
      app.setState({ screen, stack: ['home'] });
      app.cardTapped();
      ok(begins() === mid && !stage(F) && app.state.screen === screen && app._cardTapAt === 0, 'on ' + screen + ' a card behind the phone does nothing: the person stays where they are');
    }
    quiet();
    app.blockedCard('test', { tone: 'warn', title: 'A CARD', reason: 'Something to read first.' });
    app.cardTapped();
    ok(begins() === mid && !!card(app) && card(app).title === 'A CARD', 'a card on the screen is not covered by the sheet of another tap');
    app.dismissCard('test');
    ok(!card(app), 'the card goes when it is dismissed');
    app.fcAskPin({ title: 'CARD PIN', cta: 'PAY' }, () => {});
    app.cardTapped();
    ok(begins() === mid && !!pad(app) && pad(app).title === 'CARD PIN', 'nor is a PIN pad of a card’s flow');
    app.pinDismiss();
    quiet();

    /* locked: kept, and acted on once the person is in; and not for ever */
    F.W.pinSet('4917');
    app.pinLock();
    ok(!!lockPad() && lockPad().children[0].textContent === 'FOXY IS LOCKED' && app._pinLocked === true, 'Foxy locked, with its PIN pad up');
    const locked = begins();
    app.cardTapped();
    await settle();
    ok(begins() === locked && !stage(F) && app._cardTapAt > 0 && !!lockPad(), 'the card behind the phone does not open Foxy past its lock: the request waits', String(begins() - locked));
    app.cardTapped();
    typeOnLock('4917');
    await until('the tap to begin after the unlock', () => begins() === locked + 1);
    ok(stage(F) === 'card' && !lockPad() && app._pinLocked === false && app._cardTapAt === 0, 'the PIN given, the tap begins, once, though it was asked for twice');
    await until('the card to be read', () => !!app.state.fc && !stage(F));
    await settle();
    quiet();
    // a minute is too long to wait for here: the same rule with a shorter one
    app.CARD_TAP_KEEP_MS = 60;
    app._pinLocked = false;
    app._lockedOnce = false;
    app.pinLock();
    const lapsed = begins();
    app.cardTapped();
    await new Promise((go) => setTimeout(go, 200));
    ok(app._cardTapAt === 0 && !app._cardTapT && begins() === lapsed, 'and a request that waited past its time has lapsed, and the person getting in after it is not sent to a card');
    typeOnLock('4917');
    await settle();
    ok(begins() === lapsed && !stage(F) && !lockPad() && app._pinLocked === false, 'unlocked later, nothing begins');
    F.W.pinClear();
    app.CARD_TAP_KEEP_MS = 60000;
    quiet();

    /* still starting: the launch screens, the warning and the gate's screens are up, and then they are not */
    F.window.FoxyGate = { visible: () => true };
    const starting = begins();
    app.cardTapped();
    await settle();
    ok(begins() === starting && app._cardTapAt > 0, 'while the gate’s screens are up it waits');
    F.window.FoxyGate = { visible: () => false };
    await until('the tap to begin when they are gone', () => begins() === starting + 1);
    await until('the card to be read', () => !!app.state.fc && !stage(F));
    delete F.window.FoxyGate;
    await settle();
    quiet();

    /* with no connection it works as the menu does: reading a card needs none */
    app.offline = true;
    const offline = begins();
    app.cardTapped();
    ok(begins() === offline + 1, 'offline, the tap begins just the same');
    await until('the card to be read', () => !!app.state.fc && !stage(F));
    ok(app.state.screen === 'flashcard' && !!app.state.fc, 'and reads the card');
    app.offline = false;
    await settle();
  }

  /* ---- a card that holds dollars: the figures every screen above says, in the card's unit -----------------------------
   * The screens' money is said by three helpers, and a dollar card's figures are its cents: said as dollars, exactly, with no
   * price in them. Named no unit, every one of them is a bitcoin card's as it always was (the whole of this suite). And what
   * the till asks a card in each case it can be in, for the wallet to pick by the card's unit (tests/flashcard-usd-ui.js). */
  {
    const app = appOn(H);
    app.price = 64000;
    ok(app.fcSats(1300) === '₿1,300' && app.fcPrice(1300) === '$0.83' && app.fcBoth(1300) === '$0.83 (₿1,300)',
       'with no unit named: sats, and their dollars at the price, as ever', [app.fcSats(1300), app.fcPrice(1300), app.fcBoth(1300)].join(' | '));
    ok(app.fcSats(475, 'usd') === '$ 4.75' && app.fcPrice(475, 'usd') === '$4.75' && app.fcBoth(475, 'usd') === '$4.75',
       'in dollars: the cents as dollars, and no sats after them', [app.fcSats(475, 'usd'), app.fcPrice(475, 'usd'), app.fcBoth(475, 'usd')].join(' | '));
    app.price = 0;
    ok(app.fcPrice(475, 'usd') === '$4.75' && app.fcPrice(1300) === '₿1,300', 'with no price, a dollar card still says dollars, and sats say sats');
    const usd = { cents: 475, bolt11: '' };
    ok(JSON.stringify(app.fcAsks(1300)) === JSON.stringify([{ unit: 'sat', amount: 1300 }])
       && JSON.stringify(app.fcAsks(0, usd)) === JSON.stringify([{ unit: 'usd', amount: 475 }])
       && JSON.stringify(app.fcAsks(6112, { cents: 475, bolt11: 'lnbc1' })) === JSON.stringify([{ unit: 'usd', amount: 475 }, { unit: 'sat', amount: 6112 }])
       && JSON.stringify(app.fcAsks(593, null, null, { unit: 'usd' })) === JSON.stringify([{ unit: 'usd', amount: 593 }])
       && app.fcAsks(7000, null, { payUnit: 'usd', pay: 592, sats: 7000 })[0].amount === 592,
       'the till asks: sats; dollars before a code; dollars and the code’s sats; a dollar card’s own total; the cents agreed for sats');
    app.state.fc = { unit: 'usd' };
    ok(app.fcUnit() === 'usd' && app.fcTypedUnitFor('cardAdd') === 'usd' && app.fcTypedUnitFor('cardWd') === 'usd' && app.fcTypedUnitFor('cardLimit') === 'usd'
       && app.fcTypedUnitFor('cardSend') === 'sat',
       'a dollar card’s own amounts are typed in dollars; money onto any card from this phone’s bitcoin, in sats');
    app.state.fc = { unit: 'sat' };
    ok(app.fcUnit() === 'sat' && app.fcTypedUnitFor('cardAdd') === 'sat', 'and a bitcoin card’s in sats, as ever');
  }
  /* ---- the designs: a limit said as the rate it makes and back, and the welcome of a new card (26j-card-wheel.js) ---- */
  {
    const a = appOn(H, { screen: 'flashcard', stack: ['home'] });
    a.price = 60000;
    ok(a.FC_SPEED_SECS === 1 && a.fcSpeedLimit(5, 'usd') === 500 && a.fcSpeedLimit(5, 'sat') === Math.round(5 / 60000 * 1e8) && a.fcSpeedLimit(50, 'usd') === 5000,
       'a rate R a second is a limit L of R, one second of it (software 1.25): $5 a second is $5.00 (500 cents, or its sats at the price)');
    ok(a.fcSpeedText(500, 'usd', 0) === '$5' && a.fcSpeedText(Math.round(5 / 60000 * 1e8), 'sat', 0) === '$5' && a.fcSpeedText(99999, 'sat', 5) === '$5'
       && a.fcSpeedText(667, 'usd', 0) === '$6.67' && a.fcSpeedText(5000, 'usd', 0) === '$50',
       'and a limit L is said as L a second: the chip where it is one (by the dollars it was set at, where it was), the figure where not',
       [a.fcSpeedText(500, 'usd', 0), a.fcSpeedText(667, 'usd', 0)].join());
    ok(a.FC_SPEED_CHIPS.join() === '1,2,5,10,25,50' && a.FC_SPEED_CHIPS.every((r) => a.fcSpeedText(a.fcSpeedLimit(r, 'sat'), 'sat', 0) === '$' + r && a.fcSpeedText(a.fcSpeedLimit(r, 'usd'), 'usd', 0) === '$' + r),
       'every chip comes back as itself, both ways, in cents and in sats');
    a.price = 0;
    ok(a.fcSpeedText(100, 'sat', 0) === '\u20bf100' && !a.fcSpeedChoosable('sat') && a.fcSpeedChoosable('usd'),
       'with no price a bitcoin card’s is said in sats, and typed rather than chosen; a dollar card’s is chosen all the same');
    // the welcome, on the card's screen: a new card, a set-up cut short, and none for a card that is not this phone's to set up
    a.setState({ fc: { key: 'k1', setUp: false, pin: 'none', hasRecord: false } });
    let v = a.renderCardScreens({ s: a.state, sc: 'flashcard' });
    ok(v.isFcPanel && v.fpWelcome && !v.fpLimits && v.fpLine === '' && v.fpDesign === 'FX1', 'a new card on the card’s screen: WELCOME TO YOUR FOXY CARD over it, the card in the design it will be given');
    a.setState({ fc: { key: 'k1', setUp: false, pin: 'set', pinSet: true, hasRecord: false } });
    v = a.renderCardScreens({ s: a.state, sc: 'flashcard' });
    ok(v.fpWelcome && v.fpLine === 'Its set-up was cut short. Finish it to put money on it.', 'a set-up cut short is welcomed with a line saying so', v.fpLine);
    a.setState({ fc: { key: 'k1', setUp: false, pin: 'set', pinSet: true, forHolder: true } });
    const cut = a.renderCardScreens({ s: a.state, sc: 'flashcard' }).isFcPanel;
    a.setState({ fc: { key: 'k1', setUp: false, pin: 'blocked' } });
    const blockedUp = a.renderCardScreens({ s: a.state, sc: 'flashcard' }).isFcPanel;
    a.setState({ fc: { key: 'k1', setUp: true, pin: 'set', pinSet: true, hasRecord: true } });
    ok(!cut && !blockedUp && !a.renderCardScreens({ s: a.state, sc: 'flashcard' }).isFcPanel, 'and none over a card begun for its holder, a blocked card, or one set up');
    a.setState({ fc: { key: 'k1', setUp: false, pin: 'none' } });
    a.renderCardScreens({ s: a.state, sc: 'flashcard' }).fpCancel();
    ok(a.state.screen === 'home' && !a.state.fc, 'CANCEL is HOME', a.state.screen);
    a.setState({ screen: 'flashcard', stack: ['home'], fc: { key: 'k1', setUp: false, pin: 'none' } });
    ok(!('fpRestore' in a.renderCardScreens({ s: a.state, sc: 'flashcard' })), 'and no RESTORE LOST CARD on the welcome: that is home’s MENU’s');
  }
  /* ---- NAME CARD: a card's name on this phone (26j-card-wheel.js `fcNameOpen`, the wallet's `cardName` and `cardSetName`) ---- */
  {
    const fs = require('fs');
    const path = require('path');
    const markup = fs.readFileSync(path.join(__dirname, '..', 'build', 'markup.html'), 'utf8');
    const block = (flag) => { const at = markup.indexOf('<sc-if value="{{ ' + flag + ' }}">'); return at < 0 ? '' : markup.slice(at, markup.indexOf('\n</sc-if>', at)); };
    const typeBlock = block('isSendType'), nameBlock = block('isFcName');
    const inputOf = (b) => (b.match(/<input [^>]*>/) || [''])[0];
    const styleOf = (el) => (el.match(/ style="([^"]*)"/) || ['', ''])[1];
    ok(!!nameBlock && /\{\{ fnTitle \}\}/.test(nameBlock) && nameBlock.indexOf('What should we call this card?') >= 0,
       'NAME CARD is a screen of its own, its title bound (NAME CARD, or RENAME CARD) and its question: What should we call this card?');
    ok(/sc-camel-auto-focus="\{\{ wantFocus \}\}"/.test(inputOf(nameBlock)) && /sc-camel-auto-focus="\{\{ wantFocus \}\}"/.test(inputOf(typeBlock))
       && /\{\{ showKb \}\}/.test(nameBlock) && /sc-camel-enter-key-hint="done"/.test(inputOf(nameBlock)) && styleOf(inputOf(nameBlock)) === styleOf(inputOf(typeBlock)),
       'its field is SEND > TYPE’s: focused on arrival by the same flag, so the keyboard is up, the same caret and Done key, the same look', inputOf(nameBlock));
    ok(/sc-camel-on-click="\{\{ fnNext \}\}"[^>]*>NEXT</.test(nameBlock) && /\{\{ fnSkipShown \}\}"><div sc-camel-on-click="\{\{ fnSkip \}\}"[^>]*>SKIP</.test(nameBlock)
       && /sc-camel-on-click="\{\{ back \}\}"/.test(nameBlock) && !/CANCEL/.test(nameBlock),
       'NEXT, with SKIP under it in the set-up, and the round back button as the way out');
    ok(/\{\{ fcTitle \}\}<\/div><\/div>/.test(markup) && markup.indexOf('fcVerified') < 0,
       'the card screen’s title is bound, alone: the Verified words are in the card’s HISTORY');

    // the wallet: kept on the card's row where it has one, in a note of its own where not; trimmed, cut at 24, '' takes it off
    const known = Object.keys(H.W.cardsKnown())[0];
    const stranger = '02' + 'ab'.repeat(32);
    ok(!!known && H.W.cardName(known) === '' && H.W.cardName(stranger) === '' && H.W.cardName('') === '' && H.W.cardName(undefined) === '', 'a card has no name until it is given one', known);
    ok(H.W.cardSetName(known, '  Lunch  ') === 'LUNCH' && H.W.cardName(known) === 'LUNCH' && H.W.cardsKnown()[known].name === 'LUNCH',
       'cardSetName keeps it trimmed, on the card’s row on file', JSON.stringify(H.W.cardsKnown()[known].name));
    ok(H.W.cardSetName(known, 'A name much longer than twenty-four letters') === 'A NAME MUCH LONGER THAN' && Array.from(H.W.cardName(known)).length <= 24,
       'cut at 24 characters (and trimmed after the cut)', H.W.cardName(known));
    ok(H.W.cardSetName(known, 'Café ☕ card') === 'CAFÉ ☕ CARD' && H.W.cardName(known) === 'CAFÉ ☕ CARD', 'and kept as typed otherwise', H.W.cardName(known));
    // (cut after the capitals, which can be longer than what was typed: ß is SS)
    ok(Array.from(H.W.cardSetName(known, 'ß'.repeat(24))).length === 24 && H.W.cardName(known) === 'SS'.repeat(12),
       'a name whose capitals are longer than it is still kept at 24 characters', H.W.cardName(known));
    ok(H.W.cardSetName(stranger, 'Mum') === 'MUM' && H.W.cardName(stranger) === 'MUM' && !H.W.cardKnownHere(stranger) && !H.W.cardsKnown()[stranger],
       'a card with no row here (one set up for somebody else) is named in a note of its own, and is not made a card this phone knows');
    ok(H.W.cardSetName(stranger, '   ') === '' && H.W.cardName(stranger) === '', 'a name of nothing takes it off');

    // where the app names a card: RESTORE CARD and money waiting (`fcName`), the card screen's title, home's history rows
    const a = appOn(H, { screen: 'flashcard', stack: ['home'] });
    H.W.cardSetName(known, 'Lunch');
    ok(a.fcName(known) === 'LUNCH' && a.fcName(stranger) === 'CARD ··' + stranger.slice(-4).toUpperCase(),
       'fcName says the kept name first, and the last four of the key for a card with none, as before', a.fcName(stranger));
    a.FC_RECOVERABLE = true;
    a.setState({ fc: null });
    a.fcRestoreLost();
    ok(!!(restore(a) && restore(a).row('LUNCH')), 'the card is named, in capitals, on RESTORE CARD', restore(a) && restore(a).rows.join(' / '));
    a.setState({ screen: 'flashcard', stack: ['home'] });
    a.setState({ fc: { key: known, setUp: true, hasRecord: true, pin: 'none', unit: 'sat', balance: 0, count: 0, check: 'ok', checkedAt: Date.now() } });
    v = vals(a);
    ok(v.fcTitle === 'LUNCH' && v.fcVerifiedShown === undefined, 'the card screen’s title is its name, alone: the Verified words are in its HISTORY', v.fcTitle);
    a.setState({ fc: { key: stranger, setUp: true, hasRecord: true, pin: 'none', unit: 'sat', balance: 0, count: 0 } });
    ok(vals(a).fcTitle === 'ECASHCARD', 'a card with no name keeps ECASHCARD');
    // home's history rows, where a card is named (16-history-lists.js `txWho`)
    const hist = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '16-history-lists.js'), 'utf8');
    const lift = (sig) => { const from = hist.indexOf('\n  ' + sig) + 1; return hist.slice(from, hist.indexOf('\n  }\n', from) + 4); };
    const memos = hist.slice(hist.indexOf('  CARD_MEMOS = '), hist.indexOf('\n  // best guess at who'));
    const Hist = new Function('window', 'return class {\n' + memos + '\n' + lift('txCardName(t) {') + '\n' + lift('txWho(t) {') + '\n};')(H.window);
    const h = new Hist();
    ok(h.txWho({ memo: 'to card', card: stranger, dir: 'out' }) === 'To card' && h.txWho({ memo: 'card', card: stranger, dir: 'in' }) === 'From a card',
       'a card with no name keeps its row’s words');
    H.W.cardSetName(stranger, 'Mum');
    ok(h.txWho({ memo: 'to card', card: stranger, dir: 'out' }) === 'To MUM' && h.txWho({ memo: 'from card', card: known, dir: 'in' }) === 'From LUNCH'
       && h.txWho({ memo: 'paid from card', fromCard: known, dir: 'out' }) === 'Paid from LUNCH',
       'a named card is named in the history rows that name a card', h.txWho({ memo: 'to card', card: stranger, dir: 'out' }));
    // the welcome's SET UP CARD: NAME CARD, then the set-up; SKIP goes on with no name, and none is kept
    let went = 0;
    a.fcSetUp = () => { went += 1; };
    a.setState({ screen: 'flashcard', stack: ['home'], fc: { key: 'k9', setUp: false, pin: 'none' } });
    a.renderCardScreens({ s: a.state, sc: 'flashcard' }).fpSetUp();
    ok(named(a) && named(a).title === 'NAME CARD' && went === 0, 'SET UP CARD is NAME CARD first');
    named(a).skip();
    ok(!named(a) && went === 1 && a.state.screen === 'flashcard' && a._fcNameSu && a._fcNameSu.name === '', 'SKIP goes on to the set-up with no name');
    a.fcNameSettle('k9');
    ok(H.W.cardName('k9') === '' && !a._fcNameSu, 'and the card set up has none');
    a.renderCardScreens({ s: a.state, sc: 'flashcard' }).fpSetUp();
    named(a).type('Gym').next();
    a.fcNameSettle('another-card');
    ok(went === 2 && H.W.cardName('another-card') === '' && H.W.cardName('k9') === '', 'a name typed for one card is never given to another');
    H.W.cardSetName(stranger, ''); H.W.cardSetName(known, '');
  }
  /* ---- 2026-11-03: a card's unit rows are its own mint's, not the connected one's ------------------------------------------
   * A card of 1.23 moved to minibits (bitcoin only) still lists dollars in its table, and its screen showed a $0.00 dollar row
   * at a mint with no dollars. The rows are the card's table less what its own mint does not issue (`fcUnitsAt`, from the keys
   * on file: `mintUnits` of the card's mint). */
  {
    const H = await funded({}, 0);
    const a = appOn(H);
    const units = { 'https://minibits.test': ['sat'], 'https://forge.test': ['sat', 'usd'], 'https://new.test': [] };
    const asked = [];
    a.fcW = () => ({
      cardUnits: (c) => ['usd', 'sat'].filter((u) => c.units && c.units[u]).map((u) => ({ unit: u })),
      mintUnits: (m) => { asked.push(m); return units[m] || []; },
    });
    const card = (mint, usd, sat) => ({ record: { mint }, units: { usd: { balance: usd }, sat: { balance: sat } } });
    ok(JSON.stringify(a.fcUnitsAt(card('https://minibits.test', 0, 3645))) === '["sat"]' && asked.slice(-1)[0] === 'https://minibits.test',
       'a card of two currencies at a mint of bitcoin alone has one row, asked of the card\u2019s own mint', JSON.stringify(a.fcUnitsAt(card('https://minibits.test', 0, 3645))));
    ok(JSON.stringify(a.fcUnitsAt(card('https://forge.test', 0, 100))) === '["usd","sat"]', 'at a mint that issues both, both rows', JSON.stringify(a.fcUnitsAt(card('https://forge.test', 0, 100))));
    ok(JSON.stringify(a.fcUnitsAt(card('https://minibits.test', 250, 100))) === '["usd","sat"]', 'a currency the card holds money in keeps its row wherever it is',
       JSON.stringify(a.fcUnitsAt(card('https://minibits.test', 250, 100))));
    ok(JSON.stringify(a.fcUnitsAt(card('https://new.test', 0, 100))) === '["usd","sat"]', 'and a mint this phone knows nothing of takes nothing away', JSON.stringify(a.fcUnitsAt(card('https://new.test', 0, 100))));
    ok(!a.fcTwoUnits({ units: a.fcUnitsAt(card('https://minibits.test', 0, 3645)) }), 'so the card\u2019s screen there has no dollar pill and no SWAP');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'app', '26f-flashcard.js'), 'utf8');
    ok(/\n      units: this\.fcUnitsAt\(card\),\n/.test(src), 'and the card\u2019s screen takes its rows from there (`fcShow`)', 'fcShow');
  }

  /* ---- 2026-11-03: WITHDRAW, ALL OF IT, with other mints on the phone: WITHDRAW TO, the cheapest first --------------------
   * Lifted out of build/app (26n-card-withdraw-to.js, the list's rows from 27-render-mints-restore-backup.js, the PIN's door
   * from 26f-flashcard.js) and run against a stand-in wallet whose quotes come back late and in any order. */
  {
    const fs = require('fs'), path = require('path');
    const lift = (file, sigs) => {
      const text = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', file), 'utf8');
      return sigs.map((sig) => {
        const at = text.indexOf('\n  ' + sig);
        if (at < 0) throw new Error('no method ' + sig);
        let i = text.indexOf('{', at + 3 + sig.length - 1), depth = 0;
        for (; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}') { depth--; if (depth === 0) break; } }
        return text.slice(at + 3, i + 1);
      });
    };
    const body = lift('26n-card-withdraw-to.js', ['fcWdToAsk(go) {', 'fcWdLand(n, unit) {', 'fcWdQuote(to, run) {', 'fcWdLine() {', 'fcWdRows(row) {',
      'fcFeeLine(x, unit, base, keepsDollars) {', 'fcWdSel(url) {', 'fcListNextOn() {', 'fcListNext() {', 'fcWdPick(url) {', 'fcWdCross(got, unit) {'])
      .concat(lift('26f-flashcard.js', ['fcWithdrawPin(sats, asked) {']))
      .concat(lift('27-render-mints-restore-backup.js', ['renderMints(c) {']))
      .concat(lift('01-ui-basics.js', ['goSwitchMint(extra) {']));
    const CARD = 'https://forge.test', MB = 'https://minibits.test', MAC = 'https://macadamia.test';
    const phone = (mints, o) => {
      const opts = o || {};
      const asked = [], runs = [], connects = [], later = {};
      global.window = { FoxyWallet: {
        mintUrl: CARD,
        transferQuote: (from, sats, q) => {
          asked.push({ from, sats, q });
          const fee = (opts.fees || {})[q.to];
          if (q.quoteOnly) return new Promise((res, rej) => { later[q.to] = () => (fee == null ? rej(new Error(q.to + ' is not answering')) : res({ feeSats: fee, feeUnit: fee, moving: sats })); });
          return Promise.resolve({ to: q.to, from, moving: sats, net: sats, feeSats: fee || 0, unit: q.unit });
        },
        moveRun: (plan, stage, how) => { runs.push({ plan, how }); window.FoxyWallet.mintUrl = plan.to; return Promise.resolve({ sats: plan.moving, mint: plan.to }); },
        connect: (u) => { connects.push(u); window.FoxyWallet.mintUrl = u; return Promise.resolve({}); },
        reason: (e) => String((e && e.message) || e),
      } };
      const a = new Function('return {' + body.join(',\n') + '}')();
      Object.assign(a, {
        asked, runs, connects, later, toasts: [], pins: [],
        state: { screen: 'amount', stack: ['home', 'flashcard'], flow: 'cardWd', fc: { key: 'k1', mint: CARD, balance: opts.held || 3000, unit: opts.unit || 'sat' } },
        setState(x) { Object.assign(this.state, typeof x === 'function' ? x(this.state) : x); },
        toast(m) { this.toasts.push(m); }, offlineNow: () => false,
        fcW: () => window.FoxyWallet, fcUnit() { return this.state.fc.unit === 'usd' ? 'usd' : 'sat'; },
        fcHeld: (fc) => fc.balance, fcBoth: (n) => String(n), fcPrice: (n) => String(n),
        fcPinOr(o, then) { this.pins.push(o); this.pinThen = then; },
        fcLeaveAmount() {}, fcWithdrawRun(sats, pin) { this.ran = { sats, pin }; },
        tillMints: () => mints.map((u) => ({ url: u, name: u.replace('https://', ''), host: u.replace('https://', '') })),
        allMints: () => mints.map((u) => ({ url: u, name: u.replace('https://', ''), host: u.replace('https://', '') })),
        mintNameOf: (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\.test$/, ''),
        unitFigure: (n, u) => (u === 'usd' ? '$ ' + (n / 100).toFixed(2) : '\u20bf ' + n),
        px: () => 100000, group: (n) => String(n),
        mintPile: () => ({ sats: 0, units: [], text: '', ink: '' }), mintDownText: () => '', mintReachable: () => true,
        onMint: (u) => u === CARD, mintHost: () => 'forge.test', otherUnitsLine: () => '',
        showMelt(l) { this.melt = l; }, hideMelt() { this.melt = ''; }, refreshBalance() {}, loadHistory() {},
        tillSetNow: () => [],
      });
      return a;
    };
    const list = (a) => a.renderMints({ s: a.state, sc: a.state.screen });
    // one mint on the phone: nothing asked
    {
      const a = phone([CARD]);
      a.fcWithdrawPin(0);
      ok(a.pins.length === 1 && a.state.screen === 'amount' && !a.state.wdPick && a.asked.length === 0, 'WITHDRAW TO: a phone with one mint is asked nothing; ALL OF IT goes to the PIN', JSON.stringify(a.state.screen));
    }
    // three: the list, the card's mint first at NO FEE, the others asked what the crossing costs
    {
      const a = phone([CARD, MB, MAC], { fees: { [MB]: 42, [MAC]: 7 } });
      a.fcWithdrawPin(0);
      await settle();
      let v = list(a);
      ok(a.state.screen === 'switchMint' && a.state.wdPick && v.mintTitle === 'WITHDRAW TO' && a.pins.length === 0 && !v.mintPickers,
         'ALL OF IT with other mints on the phone: the SWITCH MINT list, WITHDRAW TO, before the PIN and before anything comes off', JSON.stringify({ sc: a.state.screen, t: v.mintTitle }));
      ok(a.asked.length === 2 && a.asked.every((x) => x.from === CARD && x.q.quoteOnly && x.sats === 3000) && a.asked.map((x) => x.q.to).sort().join() === [MAC, MB].sort().join(),
         'each other mint is asked what the crossing costs, from the card\u2019s mint, for what the card holds; nothing paid', JSON.stringify(a.asked));
      ok(v.mintRows[0].host === 'forge.test' && v.mintRows[0].text === 'NO FEE' && v.mintRows.slice(1).every((r) => r.text === 'CALCULATING\u2026'),
         'the card\u2019s own mint first at NO FEE, the others CALCULATING\u2026', v.mintRows.map((r) => r.host + ' ' + r.text).join(' / '));
      a.later[MB]();
      await settle();
      v = list(a);
      ok(v.mintRows.map((r) => r.host).join() === 'forge.test,minibits.test,macadamia.test' && v.mintRows[1].text === 'FEE $0.04' && v.mintRows[1].fee === 'FEE $0.04' && v.mintRows[1].lineFee,
         'an answer lands on its row', v.mintRows.map((r) => r.host + ' ' + r.text).join(' / '));
      a.later[MAC]();
      await settle();
      v = list(a);
      ok(v.mintRows.map((r) => r.host).join() === 'forge.test,macadamia.test,minibits.test' && v.mintRows[1].text === 'FEE $0.01',
         'and the cheapest goes first once both have answered', v.mintRows.map((r) => r.host + ' ' + r.text).join(' / '));
      v.mintRows[1].tap();
      ok(a.state.wdPick && a.pins.length === 0 && list(a).mintRows[1].here && !list(a).mintRows[0].here, 'a mint tapped: the tick moves to it, nothing goes yet',
         JSON.stringify(list(a).mintRows.map((r) => r.here)));
      list(a).tillNext();
      ok(a.state.screen === 'amount' && !a.state.wdPick && a.pins.length === 1 && a._fcWdTo === MAC, 'NEXT: off the list, and on to the PIN', JSON.stringify({ sc: a.state.screen, to: a._fcWdTo }));
      a.pinThen('1234');
      ok(a.ran && a.ran.sats === 0 && a.ran.pin === '1234', 'the withdrawal runs as before, into this phone at the card\u2019s mint', JSON.stringify(a.ran));
      a.fcWdCross(3000, 'sat');
      await settle();
      const run = a.runs[0];
      ok(a.asked.length === 3 && a.asked[2].sats === 2993 && a.asked[2].q.to === MAC && !a.asked[2].q.quoteOnly && run && run.how && run.how.visit === true,
         'what came off crosses to it: quoted for what is in hand less the fee, and moved as a visit', JSON.stringify({ q: a.asked[2], how: run && run.how }));
      ok(a.connects.slice(-1)[0] === CARD && a.toasts.some((t) => /Moved \u20bf 2993 to macadamia/.test(t)) && !a.melt,
         'then the phone comes back to the card\u2019s mint, and says what moved', JSON.stringify({ c: a.connects, t: a.toasts }));
    }
    // the card's own mint picked, a mint that cannot be reached, a row still asking, a typed amount
    {
      const a = phone([CARD, MB, MAC], { fees: { [MB]: 5 } });
      a.fcWithdrawPin(0);
      await settle();
      list(a).mintRows[1].tap();
      ok(a.toasts.some((t) => /Still asking/.test(t)) && a.state.wdPick, 'a row still being asked says so when tapped, and is not taken', JSON.stringify(a.toasts));
      a.later[MAC]();
      a.later[MB]();
      await settle();
      const v = list(a);
      ok(v.mintRows[2].host === 'macadamia.test' && v.mintRows[2].text === 'NOT AVAILABLE' && v.mintRows[2].dim === '0.4', 'one that did not answer is last, greyed, NOT AVAILABLE',
         v.mintRows.map((r) => r.host + ' ' + r.text).join(' / '));
      v.mintRows[2].tap();
      ok(a.state.wdPick && a.toasts.some((t) => /not answering/.test(t)), 'and tapping it says why and takes nothing', JSON.stringify(a.toasts));
      list(a).mintRows[0].tap();
      list(a).tillNext();
      ok(!a.state.wdPick && a._fcWdTo === '' && a.pins.length === 1, 'the card\u2019s own mint: on to the PIN, nothing to cross', a._fcWdTo);
      a.fcWdCross(3000, 'sat');
      ok(a.runs.length === 0 && a.asked.length === 2, 'and nothing crosses after it', JSON.stringify(a.runs));
      const b = phone([CARD, MB]);
      b.fcWithdrawPin(500);
      ok(b.pins.length === 1 && !b.state.wdPick && b.asked.length === 0, 'a typed amount lands at the card\u2019s mint, asked nothing', JSON.stringify(b.state.wdPick));
    }
    // a dollar card: the quotes in dollars, for what the dollars come to in sats at the phone's price
    {
      const a = phone([CARD, MB], { unit: 'usd', held: 500, fees: { [MB]: 3 } });
      a.fcWithdrawPin(0);
      await settle();
      ok(a.asked.length === 1 && a.asked[0].q.unit === 'usd' && a.asked[0].sats === 5000, 'a dollar card\u2019s crossing is quoted from its dollars, for the sats $5.00 comes to', JSON.stringify(a.asked));
      a.later[MB]();
      await settle();
      ok(list(a).mintRows[1].text === 'FEE $0.03 \u00b7 AS BITCOIN', 'its fee in dollars, and that it lands as bitcoin', list(a).mintRows[1].text);
    }
  }

  /* ---- DEPOSIT above what this phone holds (2026-11-04, 2026-11-06) ------------------------------------------------------
   * Decided: DEPOSIT, an amount, and where it is more than the phone holds, RECEIVE's own invoice for the whole of it. Once
   * the money is in, nothing more is asked of the person but the card's own PIN: the pieces for the card are made at once,
   * while the PIN is typed, and the sheet opens as the PIN goes in (no TAP THE CARD AGAIN, no GETTING IT READY). The card
   * clock is asked for as the invoice goes up. The phone's own balance is not touched. Backed out of the PIN: the pieces wait
   * for the card's next tap; where none could be made, the money stays on the phone and its history row says so. */
  {
    const { makeCard } = require('./flashcard-card');
    const DH = await funded({}, 3000);
    const dep = appOn(DH);
    await dep.refreshBalance();
    // (software 1.21: every load wants its PIN, its owner's too, so the pad is what comes up)
    const dc = makeCard({ window: DH.window, format: 4, software: 21 });
    await DH.W.cardSetUp(dc, { pin: '1234' });
    DH.nfc = dc;
    dep.goFlashcard();
    await until('the deposit card to be read', () => !!dep.state.fc && dep.state.screen === 'flashcard');
    await settle();
    const opened = [];
    dep.openReceive = () => opened.push({ screen: dep.state.screen, flow: dep.state.flow, amount: dep.state.amount, unit: dep.state.unit,
      wallet: dep.state.wallet, network: dep.state.network, top: dep.state.stack.slice(-1)[0] });
    // the card clock asked for, and on which screen (the wallet's own fetch is off in the suites: this is the app's ask)
    const warmed = [];
    DH.W.headerWarm = () => { warmed.push(dep.state.screen); return Promise.resolve({ kept: null, fetched: false, why: 'off' }); };
    // the screens of the stage that come up (GETTING IT READY is `cardReady`)
    const staged = [];
    const stageWas = dep.stageScreen.bind(dep);
    dep.stageScreen = (name, o) => { staged.push(name); return stageWas(name, o); };
    // the money for an invoice, in as RECEIVE's watch lands it: claimed, and PAID up over the invoice
    const comesIn = async (sats) => {
      const inv = await DH.W.invoice(sats, '');
      await DH.W.claim(inv.hash);
      await dep.refreshBalance();
      const prev = Object.assign({}, dep.state);
      dep.setState((p) => ({ screen: 'paid', stack: p.stack.concat([p.screen]), paidUnit: 'sat', paidAmount: sats, invoiceHash: inv.hash, payOut: false }));
      dep.syncFcDep(prev);
      await settle();
      return inv.hash;
    };
    const owedSum = () => DH.W.cardOwed().reduce((n, r) => n + (Number(r.amount) || Number(r.sats) || 0), 0);
    const toCard = async (n) => {
      if (pad(dep)) pad(dep).type('1234');
      await until('the deposit to be on the card', () => dc.balance() === n && !!dep.state.fc && dep.state.fc.balance === n && !dep._fcAdding);
      await settle();
      await dep.refreshBalance();
    };

    dep.fcAdd();
    ok(dep.state.screen === 'amount' && dep.state.flow === 'cardAdd', 'DEPOSIT asks how much, as before');
    keyIn(dep, 5000);
    const o = opened[0] || {};
    ok(opened.length === 1 && o.screen === 'confirm' && o.flow === 'receive' && o.amount === '5000' && o.unit === 'SATS' && o.wallet === 'sat'
       && o.network === 'LIGHTNING' && o.top === 'flashcard' && !pad(dep) && !card(dep),
       '₿ 5,000 with ₿ 3,000 on the phone: RECEIVE’s invoice for the whole ₿ 5,000, in the card’s currency, with the card behind it', JSON.stringify(opened));
    ok(warmed.length >= 1 && warmed[0] === 'confirm', 'the card clock is asked for as the invoice goes up: the wait for the payer is idle time', JSON.stringify(warmed));
    ok(dep.have === 3000 && dc.balance() === 0 && DH.W.cardOwed().length === 0, 'and nothing has moved: the phone still holds its ₿ 3,000', String(dep.have));
    const h1 = await comesIn(5000);
    await until('the pieces for the card to be made', () => DH.W.cardOwed().length === 1);
    await dep.refreshBalance();
    let p = pad(dep);
    ok(!card(dep) && !!p && p.title === 'CARD PIN' && dep.state.screen === 'flashcard',
       'the money in: the card’s screen and its PIN pad at once, with no TAP THE CARD AGAIN', JSON.stringify({ card: card(dep) && card(dep).all, pad: p && p.title }));
    ok(DH.W.cardOwed().length === 1 && owedSum() === 5000 && dep.have === 3000 && dc.balance() === 0,
       'and the pieces for the card are made while the PIN is typed: owed to the card, out of the phone’s balance', JSON.stringify({ owed: owedSum(), phone: dep.have }));
    staged.length = 0;
    DH.sheet.length = 0;
    await toCard(5000);
    const writing = DH.sheet.filter((l) => /^say: Writing/.test(l));
    ok(writing.length >= 1 && writing.length <= 2 && /^say: Writing 1 of \d+$/.test(writing[0]) && DH.batches.length >= 2,
       'the sheet says "Writing i of n" at most every half second (its first and last), the pieces going to the phone in lists', JSON.stringify({ writing, lists: DH.batches }));
    ok(dc.balance() === 5000 && dep.have === 3000 && !card(dep) && dep.state.screen === 'flashcard' && staged.indexOf('cardReady') < 0,
       'the PIN in: the sheet at once (no GETTING IT READY), the ₿ 5,000 typed on the card, the phone holding the ₿ 3,000 it held', JSON.stringify({ card: dc.balance(), phone: dep.have, staged }));
    ok(!((DH.W.tagsFor(h1) || {}).note), 'and the money’s own row is not marked as kept');

    // the PIN backed out of while the pieces are still being made: they are made all the same and wait for the card's next tap
    const prepWas = DH.W.cardPrepare;
    let release;
    const gate = new Promise((go) => { release = go; });
    DH.W.cardPrepare = (...a) => gate.then(() => prepWas.apply(DH.W, a));
    dep.fcAdd();
    keyIn(dep, 4000);
    ok(opened.length === 2 && opened[1].amount === '4000', '₿ 4,000 with ₿ 3,000: the invoice again, for the whole of it', JSON.stringify(opened[1]));
    const h2 = await comesIn(4000);
    ok(!!pad(dep) && !card(dep) && DH.W.cardOwed().length === 0, 'the PIN asked while the pieces are still being made');
    dep.toasts.length = 0;
    pad(dep).back();
    await settle();
    ok(!pad(dep) && !card(dep) && dep.toasts.length === 0, 'backed out of: nothing said until the pieces are made', JSON.stringify(dep.toasts));
    release();
    await until('the pieces made after the PIN was backed out of', () => DH.W.cardOwed().length === 1);
    await settle();
    await dep.refreshBalance();
    DH.W.cardPrepare = prepWas;
    ok(owedSum() === 4000 && dc.balance() === 5000 && dep.have === 3000 && !dep._fcAdding && !card(dep) && !pad(dep)
       && dep.toasts.some((t) => /4,000 is ready for the card\. It goes on at the next tap\./.test(t)),
       'then they are owed to the card, kept for it and not lost, and the screen says they go on at the next tap', JSON.stringify({ owed: owedSum(), toasts: dep.toasts }));
    ok(!((DH.W.tagsFor(h2) || {}).note), 'the money’s row is not marked as kept on this phone: it is the card’s now');

    // the PIN backed out of where the pieces could not be made: the money stays on the phone, and the history says so
    DH.W.cardPrepare = () => Promise.reject(Object.assign(new Error('The mint did not answer.'), { card: 'timeout' }));
    dep.fcAdd();
    keyIn(dep, 9000);
    const h3 = await comesIn(9000);
    await settle();
    ok(!!pad(dep), 'the PIN asked');
    dep.toasts.length = 0;
    pad(dep).back();
    await settle();
    await dep.refreshBalance();
    DH.W.cardPrepare = prepWas;
    ok(!pad(dep) && !card(dep) && (DH.W.tagsFor(h3) || {}).note === 'For the card · kept on this phone' && dep.have === 12000 && owedSum() === 4000
       && dep.toasts.indexOf('₿9,000 stays on this phone. DEPOSIT puts it on the card.') >= 0,
       'backed out of with nothing made: the ₿ 9,000 stays on this phone and its history row says so', JSON.stringify({ toasts: dep.toasts, note: (DH.W.tagsFor(h3) || {}).note, phone: dep.have }));
    ok(!dep._fcAdding, 'and nothing is left running');

    /* The money in under the app's lock (a return from paying the invoice in another wallet): the lock's pad stays, and the card's
     * PIN is asked once the app is unlocked; the lock coming over the card's pad asks it again after; ADD FUNDS is never held shut. */
    // the lock's own pad, read and typed into as a person does
    const lockUp = () => !!(dep._pinEl && dep._pinEl.parentNode && /FOXY IS LOCKED/.test(dep._pinEl.textContent));
    const unlockWith = (digits) => {
      const root = dep._pinEl;
      const leaves = Array.from(root.querySelectorAll('div')).filter((d) => d.childElementCount === 0);
      const click = (el) => el.dispatchEvent(new (el.ownerDocument.defaultView.Event)('click', { bubbles: true }));
      String(digits).split('').forEach((d) => click(leaves.filter((x) => x.textContent === d)[0].parentNode));
      // (the lock's button, where it has one marked; a pad with four digits in may answer by itself)
      const cta = root.querySelector('[data-pin-cta]') || leaves.filter((x) => x.textContent === 'UNLOCK')[0];
      if (cta && root.parentNode) click(cta);
    };
    const padTitle = () => (dep._pinEl && dep._pinEl.parentNode ? (/FOXY IS LOCKED/.test(dep._pinEl.textContent) ? 'FOXY IS LOCKED' : (pad(dep) && pad(dep).title)) : '');
    DH.W.pinSet('4321');
    await dep.refreshBalance();
    const bigger = Math.ceil((dep.have + 1000) / 1000) * 1000;
    dep.fcAdd();
    keyIn(dep, bigger);
    dep.pinLock();
    await settle();
    const lockPad = dep._pinEl;
    ok(dep._pinLocked && lockUp(), 'the app is locked', padTitle());
    const hL = await comesIn(bigger);
    await until('the pieces made under the lock', () => owedSum() === 4000 + bigger);
    await settle();
    ok(dep._pinLocked && dep._pinEl === lockPad && lockUp(),
       'the deposit in under the lock: the lock\u2019s pad stays, and no card pad takes its place', padTitle());
    ok(!dep._fcAdding, 'its pieces made, the run lets go: nothing is held while the lock is up');
    unlockWith('4321');
    await settle();
    ok(!dep._pinLocked && padTitle() === 'CARD PIN', 'unlocked: then the card\u2019s PIN', padTitle());
    // the lock comes over the card's pad (Foxy put away and back): asked again once unlocked
    dep.pinLock();
    await settle();
    ok(dep._pinLocked && lockUp(), 'the lock over the card\u2019s pad', padTitle());
    unlockWith('4321');
    await settle();
    ok(!dep._pinLocked && padTitle() === 'CARD PIN', 'unlocked: the card\u2019s PIN asked again, not left with no pad and no word', padTitle());
    DH.W.pinClear();
    await toCard(9000 + bigger);
    ok(dc.balance() === 9000 + bigger && owedSum() === 0 && !((DH.W.tagsFor(hL) || {}).note), 'and the PIN puts it on, with the ₿ 4,000 that waited for the card', String(dc.balance()));

    /* Backed out where the pieces were made and then found not to fit (`misfit-kept`, filed as owed): the card's money, said in the
     * wallet's words, never "stays on this phone". A swap that fails after the PIN: the money stays, and its row says so. */
    DH.W.cardPrepare = () => Promise.reject(Object.assign(new Error('That ecash does not fit this card. It is kept for the card: nothing is lost, and it cannot be written yet.'), { card: 'misfit-kept', hash: 'h' }));
    await dep.refreshBalance();
    const more = Math.ceil((dep.have + 1000) / 1000) * 1000;
    dep.fcAdd();
    keyIn(dep, more);
    const hM = await comesIn(more);
    await settle();
    dep.toasts.length = 0;
    pad(dep).back();
    await settle();
    ok(!((DH.W.tagsFor(hM) || {}).note) && dep.toasts.some((t) => /kept for the card/.test(t)) && !dep.toasts.some((t) => /stays on this phone/.test(t)),
       'backed out after pieces were filed as owed and found not to fit: it is said to be the card\u2019s, not this phone\u2019s', JSON.stringify(dep.toasts));
    DH.W.cardPrepare = () => Promise.reject(Object.assign(new Error('The mint did not answer.'), { card: 'timeout' }));
    await dep.refreshBalance();
    const most = Math.ceil((dep.have + 1000) / 1000) * 1000;
    dep.fcAdd();
    keyIn(dep, most);
    const hF = await comesIn(most);
    await settle();
    pad(dep).type('1234');
    await settle();
    DH.W.cardPrepare = prepWas;
    ok((DH.W.tagsFor(hF) || {}).note === 'For the card \u00b7 kept on this phone' && !dep._fcAdding,
       'the PIN typed and the swap failed: the money stays on this phone and its history row says so', JSON.stringify((DH.W.tagsFor(hF) || {}).note));
    if (card(dep)) card(dep).press(card(dep).has('CLOSE') ? 'CLOSE' : 'OK');
    await dep.refreshBalance();

    // not the deposit: money of another amount, or the invoice left, lets it go and asks nothing
    await dep.refreshBalance();
    dep.fcAdd();
    keyIn(dep, Math.ceil((dep.have + 1000) / 1000) * 1000);
    ok(!!dep._fcDep, 'an invoice up for more than the phone holds');
    dep.setState({ screen: 'flashcard', stack: [] });
    dep.syncFcDep({ screen: 'confirm' });
    ok(!dep._fcDep, 'the invoice left with nothing in: the deposit is let go');

    // a deposit the phone covers is as it was: no invoice, the PIN and the tap
    const before = opened.length;
    await dep.refreshBalance();
    const cardWas = dc.balance(), phoneWas = dep.have;
    dep.setState({ screen: 'flashcard', stack: ['home'] });
    dep.fcAdd();
    keyIn(dep, 1000);
    ok(opened.length === before && !dep._fcDep, 'a deposit within what the phone holds asks for no invoice');
    await toCard(cardWas + 1000);
    ok(dc.balance() === cardWas + 1000 && dep.have === phoneWas - 1000 && owedSum() === 0,
       'and goes on from the phone’s own balance, as before', JSON.stringify({ card: dc.balance(), phone: dep.have }));
  }

  console.log('\n' + (failed ? failed + ' flashcard-screens check(s) failed' : 'all flashcard-screens checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
