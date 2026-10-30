'use strict';
/* flashcard-switch.js — a card moved from one mint to another.
 *
 *     node tests/flashcard-switch.js
 *
 * A card's money is at the one mint its record names. Moving the card is
 * moving the money: off the card into the phone, across by Lightning as any
 * move between the phone's own mints goes, and back onto the card at the far
 * mint, where the card is first told its new mint. The wallet's parts of that
 * are held to first, one at a time; then the screens, where TRANSFER does all of
 * it in one tap (the wallet's `cardTransfer`, and tests/flashcard-transfer.js).
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

/* The mint this phone has chosen as its own, which a visit to another does not change. */
const own = (c) => { try { return String(JSON.parse(c.storage.getItem('foxy.cashu.mint')) || '').replace(/\/+$/, ''); } catch (e) { return ''; } };

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
  // the card has a daily limit, which the owner's phone lifts to take the money off and puts back
  card.tap();
  await W.cardSetLimit(card, { sats: 700 });
  card.tap();
  const off = await W.cardWithdraw(card, { pin: '1234', hold: true });
  ok(off.sats === 2000 && card.balance() === 0 && off.card && off.card.balance === 0 && at(H, MINT) === 6000, 'the first tap takes all of it into the phone, past a limit of 700 a day');
  ok(card.state.record.limit === 700, 'and the limit is back on the card when it has gone');

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
  await W.cardWithdraw(card, { pin: '1234', hold: true });

  /* ---- the second tap, at the second mint ------------------------------------ */
  await W.connect(MINT2, null, null, { remember: false });
  card.tap();
  const on = await W.cardWrite(card, { owner: true });
  ok(card.state.record.limit === 700,
     'the card’s limit is what it was before it was emptied, and the second tap changed its mint and nothing else', String(card.state.record.limit));
  ok(on.sats === 1990 && on.left === 0 && on.card.record.mint === MINT2 && on.card.balance === 1990 && card.balance() === 1990 && W.cardOwed().length === 0,
     'the second tap tells the card its new mint, then writes the money onto it', on.card.record.mint + ' ' + on.card.balance);
  const check = await W.cardCheck(on.card);
  ok(check.sats === 1990 && check.spent === 0, 'and the second mint says every piece on it is good');

  /* ---- the card at its new mint ----------------------------------------------- */
  card.tap();
  const paid = await W.cardPay(card, { sats: 500, pin: '1234' });
  const gave = 1990 - card.balance();
  // RECEIVE: the change goes back on at the next tap, with no PIN
  if (paid.change && paid.change.sats > 0 && !paid.change.written) {
    card.tap();
    await W.cardWrite(card, { change: true });
  }
  const left = card.balance();
  ok(paid.sats === 500 && at(H, MINT2) === 500 && gave >= 500 && left === 1990 - gave + ((paid.change && paid.change.sats) || 0) && left <= 1490 && left >= 1480,
     'it pays there, with its change written back at the next tap', left + ' left');
  await W.connect(MINT, null, null, { remember: true });
  card.tap();
  ok((await why(W.cardPay(card, { sats: 100, pin: '1234' }))) === 'other-mint' && card.balance() === left, 'and at its old mint it is a card of another mint, and signs nothing');

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

  /* ---- a mint that charges for inputs: the figure shown first is a ceiling ---- */
  for (const ppk of [100, 1000]) {
    const F = await funded({ second: true, feePpk: ppk }, 6000);
    const c = newCard(F);
    await F.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    await F.W.cardAdd(c, { sats: 2000, pin: '1234' });
    c.tap();
    const seen = await F.W.cardLook(c);
    // as the screen asks it: the card's balance, and how many pieces that is
    const first = await F.W.cardMoveQuote(MINT, MINT2, seen.balance, { quoteOnly: true, pieces: seen.pieces.length });
    const shown = seen.balance - first.net;
    c.tap();
    const took = await F.W.cardWithdraw(c, { pin: '1234', hold: true });
    const real = await F.W.cardMoveQuote(MINT, MINT2, took.sats);
    const cost = seen.balance - real.net;         // off the card's balance, as a person counts it: the swap off it too
    ok(took.sats < seen.balance && cost <= shown && real.gross <= took.sats,
       'at ' + ppk + ' ppk the fee shown before the card is touched is not under what it then costs', 'shown up to ' + shown + ', costs up to ' + cost + ' (' + (seen.balance - took.sats) + ' of it to take the pieces off)');
    // over by no more than the fee on this phone's own pieces, which the payment may or may not pick
    ok(shown - cost <= Math.ceil(ppk * 120 / 1000), 'and over it by no more than the fee on a pile of pieces', String(shown - cost));
  }

  /* ---- a card that names its design -------------------------------------------- */
  {
    /* The cards above are of the software before a card's record named its design (1.10), and were set up with none.
     * A card of the software since keeps the design it was set up with after its mint, and every card the app sets up
     * is given one (FC_SETUP_DESIGN, 26f-flashcard.js). A record that names no design clears the card's, so the record
     * such a card is moved with carries it, three bytes longer, and that is the record this phone signs as its owner. */
    const D = await funded({ second: true }, 6000);
    const design = appOn(D).FC_SETUP_DESIGN;
    const full = newCard(D, undefined, { format: 4 });
    await D.W.cardSetUp(full, { pin: '1234', design });
    const empty = newCard(D, undefined, { format: 4 });
    await D.W.cardSetUp(empty, { pin: '4321', design });
    // with money on it: off the card, across, and onto it again at the second tap, which tells it its new mint first
    full.tap();
    await D.W.cardAdd(full, { sats: 2000, pin: '1234' });
    full.tap();
    const off = await D.W.cardWithdraw(full, { pin: '1234', hold: true });
    const done = await D.W.moveRun(await D.W.cardMoveQuote(MINT, MINT2, off.sats), () => {}, { visit: true });
    const made = await D.W.cardMoveLoad(off.card, done.sats);
    await D.W.connect(MINT2, null, null, { remember: false });
    full.tap();
    const on = await D.W.cardWrite(full, { owner: true }).then((r) => r, (e) => ({ no: e }));
    ok(!on.no && on.sats === made.sats && on.left === 0 && on.card.record.mint === MINT2 && full.balance() === made.sats && D.W.cardOwed().length === 0,
       'a card that names its design, moved with money on it: the second tap tells it its new mint and writes the money onto it',
       on.no ? String(on.no.message) : on.card.record.mint + ' ' + on.card.balance);
    ok(/^[A-Z0-9]{3}$/.test(design) && full.state.record.mint === MINT2 && full.state.record.design === design && !on.no && on.card.record.design === design,
       'and at its new mint it names the design the app set it up with: the record it was sent carried it', full.state.record.design + ' at ' + full.state.record.mint);
    // and empty: one tap
    empty.tap();
    const told = await D.W.cardRepoint(empty).then((r) => r, (e) => ({ no: e }));
    ok(!told.no && told.record.mint === MINT2 && told.balance === 0 && told.record.design === design && empty.state.record.mint === MINT2 && empty.state.record.design === design,
       'an empty card that names its design is told its new mint in one tap, and names its design still',
       told.no ? String(told.no.message) : told.record.mint + ' ' + told.record.design);
  }

  /* ---- the screens: TRANSFER, as a person meets it -------------------------- */
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
    const menu = () => vals(app).fcMenuItems.map((k) => k.label).join();
    /* DONE on the success screen: the app's `dismissPaid` (24-render-receive-and-send.js), which is not among this kit's parts, ends on the
     * card's screen where the screen was raised over it, as the stack says it was. */
    const done = () => { if (app.state.stack.indexOf('flashcard') >= 0) app.setState({ screen: 'flashcard', stack: [], paidPlace: null, paidSays: '' }); };
    ok(menu() === 'HISTORY,RENAME CARD,LIMITS,CHANGE PIN,TRANSFER' && typeof vals(app).fcHome === 'function',
       'the card’s screen has HISTORY, RENAME CARD, LIMITS, CHANGE PIN and TRANSFER in its menu, and HOME at the top left', menu());
    app.setState({ open0: true });
    vals(app).fcMenuItems.filter((k) => k.label === 'TRANSFER')[0].tap();
    ok(app.state.screen === 'switchMint' && app.state.fcPick === true && app.state.stack.slice(-1)[0] === 'flashcard' && !app.state.open0,
       'TRANSFER closes the menu and opens the list of mints, asking which');
    app.fcSwitchPick(MINT2);
    ok(app.state.screen === 'fcMoveConfirm' && app.state.fcPick === false && app.state.fcMove.to === MINT2 && /CHECKING/.test(app.fcMoveSpec().cta),
       'a mint chosen, the confirmation is up and asking both mints what it will cost', app.fcMoveSpec().cta);
    await until('the cost to be known', () => app.state.fcMove && app.state.fcMove.quote);
    let spec = app.fcMoveSpec();
    const row = (label) => (spec.rows.filter((r) => r.label === label)[0] || {}).value;
    ok(row('FROM') === 'M.TEST' && row('TO') === 'N.TEST' && row('M.TEST FEE') === '₿ 0' && row('LIGHTNING FEE') === 'UP TO ₿ 10' && row('N.TEST FEE') === '₿ 0'
       && row('ARRIVES ON THE CARD') === 'ABOUT ₿ 1,990' && spec.cta === 'TRANSFER ₿ 2,000' && spec.subtitle === 'Tap your card once. Its money moves to n.test.',
       'it says where from and to, the card’s mint’s fee, the Lightning fee and the new mint’s, and about what arrives', spec.rows.map((r) => r.label + ' ' + r.value).join(' / '));
    ok(c.balance() === 2000 && at(U, MINT) === 4000, 'and nothing has moved for the asking');

    const sheets = U.sheet.filter((l) => /^begin/.test(l)).length;
    const before = history(U).map((e) => e.hash);
    spec.go();
    ok(pad(app).title === 'CARD PIN' && pad(app).cta === 'TRANSFER ₿ 2,000' && /to n\.test/.test(pad(app).sub), 'TRANSFER asks the card’s PIN once', pad(app).cta);
    pad(app).type('1234');
    await until('the card to be moved', () => app.state.screen === 'paid' && app.state.paidSays === 'CARD MOVED');
    await settle();
    const st = app.state;
    ok(c.balance() === 1990 && c.state.record.mint === MINT2 && st.paidSays === 'CARD MOVED' && st.paidPlace && st.paidPlace.label === 'NOW AT' && st.paidPlace.to === 'n.test'
       && st.paidPlace.dismiss === 'DONE' && st.recvResolved === true && st.paidAmount === 1990 && st.paidUnit === 'sat' && st.stack.indexOf('flashcard') >= 0,
       'one tap: the card is at the other mint with 1,990 on it, and the orange success screen says CARD MOVED, NOW AT n.test, DONE (render-snapshots draws it)', JSON.stringify([st.paidSays, st.paidPlace, st.paidAmount]));
    ok(U.sheet.filter((l) => /^begin/.test(l)).length === sheets + 1 && !app.melting && !stage(U), 'the card was asked for once, and nothing is left over the screen');
    ok(at(U, MINT) === 4008 && at(U, MINT2) === 0 && U.W.cardOwed().length === 0, 'the phone’s own 4,000 is untouched; 8 of the fee’s reserve came back to it; nothing is owed', at(U, MINT) + ' / ' + at(U, MINT2));
    await until('the phone to be back at its own mint', () => String(U.W.mintUrl).replace(/\/+$/, '') === MINT);
    const fresh = history(U).filter((e) => before.indexOf(e.hash) < 0);
    ok(fresh.length >= 3 && fresh.every((e) => app.seen[e.hash] || U.W.tagsFor(e.hash).to === 'card'),
       'none of its entries is announced as a payment', fresh.filter((e) => !app.seen[e.hash]).map((e) => (e.memo || e.dir) + ':' + e.sats).join(' '));
    ok(app._quiet === false, 'and the quiet it kept while it ran is over');
    done();
    await until('DONE to be the card’s screen', () => app.state.screen === 'flashcard');
    ok(app.state.fc.mint === MINT2 && app.state.fc.balance === 1990, 'DONE is the card’s screen, the card at its new mint', app.state.fc.mint);

    /* ---- the tap dropped after the money crossed: TAP CARD finishes it ---------- */
    await U.W.connect(MINT2, null, null, { remember: true });      // this phone now uses the card's mint
    await app.refreshBalance();
    c.tap();
    app.setState({ fc: null });
    app.fcRead();
    await until('the card to be read at its new mint', () => app.state.fc && app.state.fc.check === 'ok');
    app.fcSwitchMint();
    app.fcSwitchPick(MINT);
    await until('the cost back to be known', () => app.state.fcMove && app.state.fcMove.quote);
    // the card leaves just before it would be told its new mint: armed by the tap the sheet begins with, which clears what was armed before
    const tap0 = c.tap.bind(c);
    c.tap = () => { tap0(); c.leaveBefore('32', 1); c.tap = tap0; };
    app.fcMoveSpec().go();
    pad(app).type('1234');
    await until('the card to be asked for again', () => face(app) && face(app).title === 'TAP THE CARD AGAIN');
    ok(c.balance() === 0 && c.state.record.mint === MINT2 && U.W.cardOwed().length === 1 && U.W.cardOwed()[0].mint === MINT && /waiting to go onto this card/.test(face(app).reason),
       'the card put away before it was told its new mint: the money has crossed and is owed to it there', face(app).reason);
    face(app).press('LATER');
    await settle();
    await until('the phone to be back where it was', () => String(U.W.mintUrl).replace(/\/+$/, '') === MINT2);
    ok(app.state.screen === 'flashcard' && !app.state.fcMove, 'LATER leaves the card’s screen, and the phone where it was');
    ok(vals(app).fcNotes.filter((n) => /waiting to go onto this card/.test(n.text)).length === 1 && /waiting to go onto this card/.test(vals(app).fcNotes[0].text),
       'with the line that says so, first of the card’s lines');
    app.fcSwitchMint();
    ok(face(app) && face(app).title === 'PUT IT ON FIRST', 'and it is not moved again while that money waits');
    face(app).press('CANCEL');
    c.tap();
    vals(app).fcNotes[0].tap();
    ok(!pad(app) && !(face(app) && face(app).title === 'A DIFFERENT MINT'), 'pressed from another mint than the money’s, the line visits that mint for the tap: no switch, and no PIN from the phone that owns the card');
    await until('the money to be on the card', () => app.state.screen === 'paid' && app.state.paidSays === 'CARD MOVED');
    ok(c.balance() === 1980 && c.state.record.mint === MINT && U.W.cardOwed().length === 0, 'a tap finishes the move: the card is at that mint with its money', String(c.balance()));
    done();
    await until('the card’s screen again', () => app.state.screen === 'flashcard');
    await until('the phone back on its own mint', () => String(U.W.mintUrl).replace(/\/+$/, '') === MINT2);

    /* ---- the crossing does not go: the money waits in this phone, and FINISH moves it ---------- */
    const heldThere = c.balance();
    const mine = at(U, MINT);
    c.tap();
    app.fcSwitchMint();
    app.fcSwitchPick(MINT2);
    await until('the cost to be known from there', () => app.state.fcMove && app.state.fcMove.quote);
    ok(String(U.W.mintUrl).replace(/\/+$/, '') === MINT && own(U) === MINT2,
       'the phone is taken to the card’s mint for the asking, as a visit: its own mint is still the one it chose', U.W.mintUrl + ' / ' + own(U));
    // the fee has risen past what was agreed between the asking and the tap
    app.setState({ fcMove: Object.assign({}, app.state.fcMove, { quote: Object.assign({}, app.state.fcMove.quote, { fee: -50 }) }) });
    app.fcMoveSpec().go();
    pad(app).type('1234');
    await until('the move to stop', () => face(app) && face(app).title === 'NOT MOVED YET');
    ok(c.balance() === 0 && at(U, MINT) === mine + heldThere && U.W.cardTransfers()[c.key] && U.W.cardTransfers()[c.key].stage === 'off' && face(app).has('FINISH'),
       'a fee over what was agreed: the money is in this phone at the old mint, the transfer noted, and FINISH offered', face(app).all);
    face(app).press('LATER');
    await settle();
    await until('the card’s screen', () => app.state.screen === 'flashcard' && String(U.W.mintUrl).replace(/\/+$/, '') === MINT2);
    const note = vals(app).fcNotes.filter((n) => /Moving this card to n\.test is not finished/.test(n.text))[0];
    ok(!!note, 'the card’s screen says the move is not finished', vals(app).fcNotes.map((n) => n.text).join(' | '));
    note.tap();
    await until('the confirmation for what is left', () => app.state.screen === 'fcMoveConfirm' && app.state.fcMove && app.state.fcMove.resume && app.state.fcMove.quote);
    ok(app.fcMoveSpec().cta === 'TRANSFER ' + app.fcMoveFig(heldThere, 'sat').main, 'it shows the fees again, for the money in this phone', app.fcMoveSpec().cta);
    app.fcMoveSpec().go();
    pad(app).type('1234');
    await until('the card to be moved from the note', () => app.state.screen === 'paid' && app.state.paidSays === 'CARD MOVED');
    await settle();
    ok(c.state.record.mint === MINT2 && c.balance() > 0 && c.balance() < heldThere && !U.W.cardTransfers()[c.key] && U.W.cardOwed().length === 0,
       'one tap finishes it: nothing taken off the card, the money across and on it', heldThere + ' became ' + c.balance());
    done();
    await until('the card’s screen once more', () => app.state.screen === 'flashcard');
    await until('the phone home', () => String(U.W.mintUrl).replace(/\/+$/, '') === MINT2);
    // back, for what follows: the card and the phone at the first mint
    c.tap();
    app.fcSwitchMint();
    app.fcSwitchPick(MINT);
    await until('the cost back to be known', () => app.state.fcMove && app.state.fcMove.quote);
    app.fcMoveSpec().go();
    pad(app).type('1234');
    await until('the card to be moved back', () => app.state.screen === 'paid' && app.state.paidSays === 'CARD MOVED');
    await settle();
    done();
    await until('the card’s screen after it', () => app.state.screen === 'flashcard');
    await U.W.connect(MINT, null, null, { remember: true });
    await app.refreshBalance();

    /* ---- an empty card ------------------------------------------------------- */
    const blank = newCard(U);
    await U.W.cardSetUp(blank, { pin: '4321' });
    U.nfc = blank;
    blank.tap();
    app.fcRead();
    await until('the empty card to be read', () => app.state.fc && app.state.fc.key === blank.key);
    app.fcSwitchMint();
    app.fcSwitchPick(MINT2);
    ok(app.state.screen === 'flashcard' && !pad(app) && !app.state.fcMove, 'an empty card has no confirmation and no Lightning, and asks for no PIN: this phone’s proof, and one tap');
    await until('the empty card to be moved', () => app.state.screen === 'paid' && app.state.paidSays === 'CARD MOVED');
    await settle();
    ok(app.state.fc.mint === MINT2 && blank.state.record.mint === MINT2, 'and it is at the other mint: CARD MOVED');
    done();
    await until('the card’s screen, the empty card', () => app.state.screen === 'flashcard' && String(U.W.mintUrl).replace(/\/+$/, '') === MINT);

    /* ---- what stops it before it starts ------------------------------------- */
    app.offline = true;
    app.fcSwitchMint();
    ok(app.state.screen === 'flashcard' && /needs a connection/.test(app.toasts.join('|')), 'with no connection it says so and opens nothing');
    app.offline = false;
    // a card that is not this phone's is not moved by it
    app.setState({ fc: Object.assign({}, app.state.fc, { ownedHere: false }) });
    ok(!vals(app).fcMenuItems.some((k) => k.label === 'TRANSFER'), 'a card that is not this phone’s has no TRANSFER in its menu');
    app.fcSwitchMint();
    ok(face(app) && face(app).title === 'NOT THIS PHONE’S CARD' && app.state.screen === 'flashcard', 'and is refused if it is asked for all the same', face(app) && face(app).title);
    face(app).press('CLOSE');
  }

  failed += until.failed;
  console.log('\n' + (failed ? failed + ' flashcard-switch check(s) failed' : 'all flashcard-switch checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
