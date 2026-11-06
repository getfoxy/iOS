'use strict';
/* card-cancel.js — FOXY CARD pressed, and the phone's sheet dismissed with no card held up.
 *
 *     node tests/card-cancel.js
 *
 * On a phone that has never tied a card to itself the dismissal shows what a Foxy Card is, with VISIT WEBSITE; on one that has,
 * it goes back to the menu the press came from. Only the first read of that press is this: a swipe, a card's address, TRY AGAIN
 * and a card read inside a flow keep their old answer (the screen they were on). */
const { funded, newCard, OTHER_WORDS } = require('./flashcard-kit');
const { appOn, until, stage } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

/* The learn screen's buttons, found by their words. */
const press = (ctx, label) => {
  const root = ctx.window.document.getElementById('foxy-stage');
  const hit = root && Array.from(root.querySelectorAll('div')).filter((d) => d.children.length === 0 && d.textContent === label)[0];
  if (!hit) return false;
  hit.dispatchEvent(new ctx.window.Event('click'));
  return true;
};
const text = (ctx) => { const el = ctx.window.document.getElementById('foxy-stage'); return el ? el.textContent : ''; };
const quiet = () => new Promise((r) => setTimeout(r, 60));

(async () => {
  const H = await funded({}, 0);
  const opened = [];
  H.W.openCompany = (which) => { opened.push(which); return Promise.resolve(); };
  H.nfc = null; // the sheet is dismissed: nothing is held up

  /* FOXY CARD is pressed on home. (The menu's row, were there one, shuts the drawer first, as `shut` does: so does this.) */
  const pressCard = (a) => { a.setState({ open0: false }); a.goFlashcard(); };

  /* ---- a phone that never tied a card ------------------------------------------ */
  ok(Object.keys(H.W.cardsKnown()).length === 0 && !H.W.cardsTied(), 'this phone has no card on file, and no mark of one');
  let app = appOn(H, { screen: 'home', open0: false });
  pressCard(app);
  await until('the learn screen', () => stage(H) === 'cardLearn');
  ok(app.state.screen === 'home' && app.state.stack.length === 0, 'the empty card screen the press opened is left: the phone is on home again', app.state.screen);
  ok(/FOXY CARD/.test(text(H)) && /VISIT WEBSITE/.test(text(H)) && /DONE/.test(text(H)), 'the learn screen is titled FOXY CARD, with VISIT WEBSITE and DONE', text(H));
  ok(/ecash/.test(text(H)) && !/till/i.test(text(H)), 'and says what a Foxy Card is, in the app’s words');
  ok(!/animation/.test(H.window.document.getElementById('foxy-stage').innerHTML.split('<h1')[0].replace(/animation:glowDrift[^;]*;|animation:grain[^;]*;|animation:foxyIn[^"]*/g, '')), 'and its card picture does not breathe');
  ok(press(H, 'VISIT WEBSITE') && opened.join() === 'foxycard' && stage(H) === 'cardLearn',
     'VISIT WEBSITE opens the Foxy Card page (the bridge’s "foxycard") and the screen stays', opened.join());
  ok(press(H, 'DONE') && stage(H) === '', 'DONE ends the screen');
  ok(app.state.screen === 'home' && !app.state.open0, 'and the phone is on home');

  // not the person’s dismissal: the sheet timing out, or iOS ending it
  for (const why of ['the session timed out', 'the session was interrupted']) {
    H.beginWhy = why;
    app = appOn(H, { screen: 'home' });
    pressCard(app);
    await quiet();
    await until('home again (' + why + ')', () => app.state.screen === 'home' && app.state.stack.length === 0);
    ok(stage(H) === '', '"' + why + '" leaves quietly: no learn screen');
  }
  H.beginWhy = null;

  // a payment arriving between the press and the cancel: the empty card screen is not left in the stack
  app = appOn(H, { screen: 'home' });
  pressCard(app);
  // (raised as 12-receive.js `announcePayment` does: the screen it covers is remembered, and pushed on the stack)
  app._returnTo = { screen: app.state.screen, stack: app.state.stack.slice() };
  app.setState((p) => ({ screen: 'paid', stack: p.stack.concat([p.screen]) }));
  await quiet();
  ok(stage(H) === '' && app.state.screen === 'paid' && app.state.stack.indexOf('flashcard') < 0, 'a payment raised before the cancel keeps its screen, with no empty card screen under it', JSON.stringify(app.state.stack));
  ok(app._returnTo && app._returnTo.screen === 'home' && app._returnTo.stack.indexOf('flashcard') < 0, 'and DONE on it goes back to home, not to the empty card screen', JSON.stringify(app._returnTo));

  // a swipe, or a card’s address, is not that press
  for (const how of ['swipe', 'tap']) {
    app = appOn(H, { screen: 'home' });
    app.goFlashcard(how);
    await quiet();
    ok(stage(H) === '' && !app.state.open0, 'a ' + how + ' that ends in a dismissed sheet shows no learn screen');
  }

  // TRY AGAIN, a read inside a flow, and every other cancel go through fcFailed with no say of this press
  app = appOn(H, { screen: 'confirm' });
  app.fcFailed({ card: 'cancelled', message: 'x' }, { again: () => {} });
  app.fcRead();
  await quiet();
  ok(stage(H) === '' && app.state.screen === 'confirm' && !app.state.open0, 'a cancel inside a payment, or of a plain read, does nothing new');

  /* ---- a phone that has tied a card ---------------------------------------------- */
  const c = newCard(H);
  c.tap();
  await H.W.cardSetUp(c, { pin: '1234', recoverable: true });
  ok(Object.keys(H.W.cardsKnown()).length === 1 && H.W.cardsTied(), 'now a card is on file here');
  app = appOn(H, { screen: 'home', open0: false });
  pressCard(app);
  await quiet();
  await until('home again', () => app.state.screen === 'home' && app.state.stack.length === 0);
  ok(stage(H) === '' && !app.state.open0, 'a cancel goes back to home, where CARD was pressed, with no learn screen');

  /* ---- a phone restored from its words: no card file, but a card of its own has answered once */
  {
    const R = await funded({ words: OTHER_WORDS }, 0);
    ok(!R.W.cardsTied(), 'a phone with no card file and no read of its own card is not tied');
    const rc = newCard(R);
    rc.tap();
    await R.W.cardSetUp(rc, { pin: '1234', recoverable: true });
    rc.tap();
    await R.W.cardLook(rc, { mine: true });
    R.storage.removeItem('foxy.flashcard.cards');
    ok(Object.keys(R.W.cardsKnown()).length === 0 && R.W.cardsTied(), 'the card file gone (as on a restore), the mark of a card that answered "mine" still counts as tied');
  }

  console.log('\n' + (failed ? failed + ' card-cancel check(s) failed' : 'all card-cancel checks pass'));
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
