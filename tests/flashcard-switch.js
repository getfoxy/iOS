'use strict';
/* flashcard-switch.js — a card moved from one mint to another.
 *
 *     node tests/flashcard-switch.js
 *
 * A card's money is at the one mint its record names. Moving the card is
 * moving the money: off the card into the phone (a tap), across by Lightning
 * as any move between the phone's own mints goes, and back onto the card at
 * the far mint, where the card is first told its new mint (a second tap).
 *
 * What is held to here: the money that crosses pays for its own crossing and
 * the phone's own balance is not dipped into; what is left behind is the
 * unused part of the Lightning fee's reserve and nothing more; the card names
 * its new mint before a piece of that mint is written onto it, and never
 * holds ecash of a mint it does not name; a move cut short at any point
 * leaves the money in the phone, and any later tap finishes it; and the books
 * add up at both mints (the harness asks, as it asks every suite).
 *
 * Two test mints, with a Lightning payment between them that is paid when it
 * is made: a reserve of 10 sats, of which 2 are spent.
 */
const { funded, newCard, why, history, MINT, MINT2 } = require('./flashcard-kit');
// `face`: the card that is up on the screen. `card` here is the card that is tapped
const { appOn, until, pad, card: face, stage, vals, settle } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
/* What this phone holds at a mint, whichever it is connected to. */
const at = (c, mint) => {
  try { return (JSON.parse(c.storage.getItem('foxy.cashu.proofs.' + mint)) || []).reduce((n, p) => n + Number(p.amount || 0), 0); }
  catch (e) { return 0; }
};

(async () => {
  const H = await funded({ second: true }, 6000);
  const W = H.W;
  const card = newCard(H);
  await W.cardSetUp(card, { pin: '1234' });
  card.tap();
  await W.cardAdd(card, { sats: 2000, pin: '1234' });
  ok(card.balance() === 2000 && at(H, MINT) === 4000 && at(H, MINT2) === 0, 'a card with 2,000 on it at the first mint, and 4,000 of the phone’s own there', at(H, MINT) + ' / ' + at(H, MINT2));

  /* ---- what it will cost, asked before the card is touched ------------------ */
  const guess = await W.cardMoveQuote(MINT, MINT2, 2000, { quoteOnly: true });
  ok(guess.net === 1990 && guess.gross <= 2000 && guess.to === MINT2 && guess.from === MINT,
     'the quote takes the fee’s reserve out of the card’s own money: 1,990 would land, for no more than 2,000', guess.net + ' for ' + guess.gross);
  ok((await why(W.cardMoveQuote(MINT, MINT2, 9))) === 'too-little', 'and says when there is too little to move at all');

  /* ---- the first tap: off the card ---------------------------------------- */
  card.tap();
  const off = await W.cardWithdraw(card, { pin: '1234' });
  ok(off.sats === 2000 && card.balance() === 0 && off.card && off.card.balance === 0 && at(H, MINT) === 6000, 'the first tap takes all of it into the phone');

  /* ---- across, with no card ------------------------------------------------ */
  const plan = await W.cardMoveQuote(MINT, MINT2, off.sats);
  ok(plan.net === 1990 && plan.gross <= 2000, 'with the money in hand the plan is the same: it pays its own way', plan.net + ' for ' + plan.gross);
  const done = await W.moveRun(plan, () => {}, { visit: true });
  ok(done.sats === 1990 && at(H, MINT2) === 1990, '1,990 land at the second mint', String(at(H, MINT2)));
  ok(at(H, MINT) === 4008, 'the phone’s own 4,000 at the first mint was not touched, and what stays behind is the 8 the reserve did not use', String(at(H, MINT)));

  /* ---- made ready for the card, at the mint it is going to ------------------ */
  const made = await W.cardMoveLoad(off.card, done.sats);
  const owed = W.cardOwed();
  ok(made.sats === 1990 && owed.length === 1 && owed[0].mint === MINT2 && owed[0].card === card.key && at(H, MINT2) === 0,
     'all of it is made into pieces for the card and owed to it, at the second mint', JSON.stringify(owed.map((r) => [r.sats, r.mint])));

  /* ---- cut short here: the phone goes home and the card is tapped there ----- */
  await W.connect(MINT, null, null, { remember: true });
  card.tap();
  const early = await W.cardWrite(card, { pin: '1234' });
  card.tap();
  const still = await W.cardLook(card);
  ok(early.sats === 0 && early.left === 1 && early.why === 'other-mint' && still.record.mint === MINT && still.balance === 0 && W.cardOwed().length === 1,
     'tapped while the phone is at the first mint, nothing is written and the card is not moved: the money waits', early.why);

  // and a card that has been given money at the first mint since is not moved under it
  card.tap();
  await W.cardAdd(card, { sats: 64, pin: '1234' });
  await W.connect(MINT2, null, null, { remember: false });
  card.tap();
  const under = await W.cardWrite(card, { pin: '1234' }).then(() => null, (e) => e);
  card.tap();
  const held = await W.cardLook(card);
  ok(under && under.card === 'in-use' && held.record.mint === MINT && held.balance === 64 && W.cardOwed().length === 1,
     'a card holding money at its old mint is not moved under it', under && under.message);
  await W.connect(MINT, null, null, { remember: true });
  card.tap();
  await W.cardWithdraw(card, { pin: '1234' });

  /* ---- the second tap, at the second mint ------------------------------------ */
  await W.connect(MINT2, null, null, { remember: false });
  card.tap();
  const on = await W.cardWrite(card, { pin: '1234' });
  ok(on.sats === 1990 && on.left === 0 && on.card.record.mint === MINT2 && on.card.balance === 1990 && card.balance() === 1990 && W.cardOwed().length === 0,
     'the second tap tells the card its new mint, then writes the money onto it', on.card.record.mint + ' ' + on.card.balance);
  const check = await W.cardCheck(on.card);
  ok(check.sats === 1990 && check.spent === 0, 'and the second mint says every piece on it is good');

  /* ---- the card at its new mint ----------------------------------------------- */
  card.tap();
  const paid = await W.cardPay(card, { sats: 500, pin: '1234' });
  ok(paid.sats === 500 && at(H, MINT2) === 500 && card.balance() === 1490, 'it pays there, with its change written back', card.balance() + ' left');
  await W.connect(MINT, null, null, { remember: true });
  card.tap();
  ok((await why(W.cardPay(card, { sats: 100, pin: '1234' }))) === 'other-mint' && card.balance() === 1490, 'and at its old mint it is a card of another mint, and signs nothing');

  /* ---- an empty card needs no Lightning --------------------------------------- */
  const blank = newCard(H);
  await W.cardSetUp(blank, { pin: '4321' });
  await W.connect(MINT2, null, null, { remember: false });
  blank.tap();
  const moved = await W.cardRepoint(blank, { pin: '4321' });
  ok(moved.record.mint === MINT2 && moved.balance === 0, 'an empty card is told its new mint in one tap');
  blank.tap();
  ok((await W.cardRepoint(blank, { pin: '4321' })).record.mint === MINT2, 'told again where it already is, nothing happens');
  blank.tap();
  await W.cardAdd(blank, { sats: 100, pin: '4321' });
  await W.connect(MINT, null, null, { remember: true });
  blank.tap();
  ok((await why(W.cardRepoint(blank, { pin: '4321' }))) === 'in-use' && blank.balance() === 100, 'and a card with money on it is not: the money has to move first');
  blank.tap();
  ok((await why(W.cardRepoint(blank, { pin: '0000' }))) === 'in-use', 'which it says before it asks for the PIN');

  /* ---- nothing announced that the screens say themselves ----------------------- */
  const cards = history(H).filter((e) => /card/.test(String(e.memo || '')));
  ok(cards.length >= 4 && cards.every((e) => (W.tagsFor(e.hash).to === 'card') || e.memo === 'card'),
     'every entry of money to or from the phone’s own card is marked as one', cards.map((e) => e.memo + ':' + e.sats).join(' '));

  /* ---- the screens: SWITCH MINT, as a person meets it -------------------------- */
  {
    const U = await funded({ second: true }, 6000);
    const app = appOn(U);
    await app.refreshBalance();
    const c = newCard(U);
    await U.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    await U.W.cardAdd(c, { sats: 2000, pin: '1234' });
    U.nfc = c;
    app.goFlashcard();
    await until('the card to be read', () => !!app.state.fc && app.state.fc.check !== 'asking');
    ok(vals(app).fcLinks.map((k) => k.label.replace(/\s+/g, ' ').trim()).join() === 'CHANGE PIN,SET LIMIT,SWITCH MINT', 'SWITCH MINT is the third round button on the card’s screen');

    app.fcSwitchMint();
    ok(app.state.screen === 'switchMint' && app.state.fcPick === true && app.state.stack.slice(-1)[0] === 'flashcard', 'it opens the list of mints, asking which');
    app.fcSwitchPick(MINT2);
    ok(app.state.screen === 'fcMoveConfirm' && app.state.fcPick === false && app.state.fcMove.to === MINT2 && /CHECKING/.test(app.fcMoveSpec().cta),
       'a mint chosen, the confirmation is up and asking both mints what it will cost', app.fcMoveSpec().cta);
    await until('the cost to be known', () => app.state.fcMove && app.state.fcMove.fee != null);
    let spec = app.fcMoveSpec();
    const row = (label) => (spec.rows.filter((r) => r.label === label)[0] || {}).value;
    ok(row('MOVING TO') === 'N.TEST' && row('FROM') === 'M.TEST' && row('ARRIVES ON THE CARD') === 'ABOUT ₿ 1,990' && row('FEE') === 'UP TO ₿ 10' && spec.cta === 'MOVE ₿ 2,000',
       'it says where to, about what arrives, and the most the fee can be', row('ARRIVES ON THE CARD') + ' / ' + row('FEE'));
    ok(c.balance() === 2000 && at(U, MINT) === 4000, 'and nothing has moved for the asking');

    const sheets = U.sheet.filter((l) => /^begin/.test(l)).length;
    const before = history(U).map((e) => e.hash);
    spec.go();
    ok(pad(app).title === 'CARD PIN' && pad(app).cta === 'MOVE ₿2,000' && /to n\.test/.test(pad(app).sub), 'MOVE asks the card’s PIN once', pad(app).cta);
    pad(app).type('1234');
    await until('the card to be moved', () => face(app) && face(app).title === 'MOVED');
    await settle();
    ok(c.balance() === 1990 && app.state.screen === 'flashcard' && app.state.fc.mint === MINT2 && app.state.fc.balance === 1990 && !app.state.fcMove,
       'two taps later the card is at the other mint with 1,990 on it, and the screen is the card', face(app).reason);
    ok(U.sheet.filter((l) => /^begin/.test(l)).length === sheets + 2 && /Moving your sats to n\.test/.test(app.melts.join()) && !app.melting && !stage(U),
       'the card was asked for twice, with the crossing between, and nothing is left over the screen');
    ok(at(U, MINT) === 4008 && at(U, MINT2) === 0 && U.W.cardOwed().length === 0, 'the phone’s own 4,000 is untouched; 8 of the fee’s reserve came back to it; nothing is owed', at(U, MINT) + ' / ' + at(U, MINT2));
    ok(String(U.W.mintUrl).replace(/\/+$/, '') === MINT, 'and the phone is back at the mint it was at');
    const fresh = history(U).filter((e) => before.indexOf(e.hash) < 0);
    ok(fresh.length >= 3 && fresh.every((e) => app.seen[e.hash] || U.W.tagsFor(e.hash).to === 'card'),
       'none of its entries is announced as a payment', fresh.filter((e) => !app.seen[e.hash]).map((e) => (e.memo || e.dir) + ':' + e.sats).join(' '));
    ok(app._quiet === false, 'and the quiet it kept while it ran is over');
    face(app).press('DONE');

    /* ---- the second tap missed --------------------------------------------- */
    await U.W.connect(MINT2, null, null, { remember: true });      // this phone now uses the card's mint
    await app.refreshBalance();
    c.tap();
    app.setState({ fc: null });
    app.fcRead();
    await until('the card to be read at its new mint', () => app.state.fc && app.state.fc.check === 'ok');
    app.fcSwitchMint();
    app.fcSwitchPick(MINT);
    await until('the cost back to be known', () => app.state.fcMove && app.state.fcMove.fee != null);
    const melt0 = app.showMelt;
    app.showMelt = (label) => { melt0(label); U.nfc = null; };      // the card is put away during the crossing
    app.fcMoveSpec().go();
    pad(app).type('1234');
    await until('the second tap to be asked for again', () => face(app) && face(app).title === 'TAP THE CARD AGAIN');
    ok(c.balance() === 0 && U.W.cardOwed().length === 1 && U.W.cardOwed()[0].mint === MINT && /waiting to go onto this card/.test(face(app).reason),
       'the card put away before its second tap: the money has crossed and waits for it', face(app).reason);
    face(app).press('LATER');
    await settle();
    ok(app.state.screen === 'flashcard' && String(U.W.mintUrl).replace(/\/+$/, '') === MINT2 && !app.state.fcMove, 'LATER leaves the card’s screen, and the phone where it was');
    ok(vals(app).fcNotes.length === 1 && /waiting to go onto this card/.test(vals(app).fcNotes[0].text), 'with the line that says so');
    app.fcSwitchMint();
    ok(face(app) && face(app).title === 'PUT IT ON FIRST', 'and it is not moved again while that money waits');
    face(app).press('CANCEL');
    vals(app).fcNotes[0].tap();
    ok(face(app) && face(app).title === 'A DIFFERENT MINT' && face(app).has('SWITCH MINT') && !pad(app), 'pressed from the wrong mint, the line says which mint the money is at', face(app).reason);
    face(app).press('CANCEL');
    await U.W.connect(MINT, null, null, { remember: true });
    U.nfc = c;
    vals(app).fcNotes[0].tap();
    pad(app).type('1234');
    await until('the money to be on the card', () => face(app) && face(app).title === 'ON THE CARD');
    ok(c.balance() === 1980 && app.state.fc.mint === MINT && U.W.cardOwed().length === 0, 'from the right one, a tap finishes the move: the card is at that mint with its money', String(c.balance()));
    face(app).press('DONE');
    app.showMelt = melt0;

    /* ---- an empty card ------------------------------------------------------- */
    const blank = newCard(U);
    await U.W.cardSetUp(blank, { pin: '4321' });
    U.nfc = blank;
    blank.tap();
    app.fcRead();
    await until('the empty card to be read', () => app.state.fc && app.state.fc.key === blank.key);
    app.fcSwitchMint();
    app.fcSwitchPick(MINT2);
    ok(app.state.screen === 'flashcard' && pad(app) && pad(app).cta === 'MOVE CARD' && !app.state.fcMove, 'an empty card has no confirmation and no Lightning: its PIN, and one tap', pad(app).sub);
    pad(app).type('4321');
    await until('the empty card to be moved', () => face(app) && face(app).title === 'MOVED');
    await settle();
    ok(app.state.fc.mint === MINT2 && String(U.W.mintUrl).replace(/\/+$/, '') === MINT, 'and it is at the other mint, with the phone back where it was');
    face(app).press('DONE');

    /* ---- what stops it before it starts ------------------------------------- */
    app.offline = true;
    app.fcSwitchMint();
    ok(app.state.screen === 'flashcard' && /needs a connection/.test(app.toasts.join('|')), 'with no connection it says so and opens nothing');
    app.offline = false;
  }

  failed += until.failed;
  console.log('\n' + (failed ? failed + ' flashcard-switch check(s) failed' : 'all flashcard-switch checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
