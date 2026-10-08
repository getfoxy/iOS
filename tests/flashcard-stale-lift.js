'use strict';
/* flashcard-stale-lift.js — an explicit NO LIMIT is not undone by an old note.
 *
 *     node tests/flashcard-stale-lift.js
 *
 * A withdrawal lifts the card's daily limit with the owner's proof and writes the
 * old limit down ("foxy.flashcard.lifted"), so that a tap which ends before the
 * limit is put back is finished by the owner's next read. The owner may then set
 * the limit on purpose, NO LIMIT included. Setting the limit reads the card
 * again, and a card with limit 0 and a note looks like one that was left lifted:
 * the old limit would go back on inside the same tap, and the owner's choice
 * would be undone. An explicit limit clears the note.
 */
const { funded, newCard } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

(async () => {
  const H = await funded({ feePpk: 0 }, 6000);
  const card = newCard(H);
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  const clock = { ms: Date.now() };
  H.phone.clockMs = () => clock.ms;
  const limit = (c) => c.state.record.limit;
  const note = () => JSON.parse(H.storage.getItem('foxy.flashcard.lifted') || '{}')[card.key];

  await H.W.cardAdd(card, { sats: 2000, owner: true });
  card.tap();
  await H.W.cardSetLimit(card, { sats: 600 });
  ok(limit(card) === 600, 'a daily limit of 600 is set');

  // a withdrawal: the limit is lifted, and the card is taken away before it can be put back
  card.tap();
  card.leaveBefore('20', 1);
  const gone = await H.W.cardWithdraw(card, { pin: '1234' }).then(() => null, (e) => e);
  ok(gone && gone.card === 'gone' && limit(card) === 0 && note() && note().limit === 600,
     'a card taken away while lifted is left with no limit and the phone has noted 600', JSON.stringify({ err: gone && gone.card, limit: limit(card), note: note() }));

  // the owner now says NO LIMIT, on purpose
  card.tap();
  await H.W.cardSetLimit(card, { sats: 0 });
  ok(limit(card) === 0, 'the owner chooses NO LIMIT: the card must be left with none',
     'card limit is ' + limit(card) + ' (the stale note put 600 back inside the same tap)');
  ok(!note(), 'and a note of a lifted limit must not survive an explicit choice', JSON.stringify(note()));

  // and a limit chosen on purpose is the limit, whatever the old note said
  card.tap();
  await H.W.cardSetLimit(card, { sats: 600 });
  card.tap();
  card.leaveBefore('20', 1);
  const gone2 = await H.W.cardWithdraw(card, { pin: '1234' }).then(() => null, (e) => e);
  ok(gone2 && gone2.card === 'gone' && limit(card) === 0 && note() && note().limit === 600, 'a second card taken away while lifted leaves a note of 600', JSON.stringify({ limit: limit(card), note: note() }));
  card.tap();
  await H.W.cardSetLimit(card, { sats: 400 });
  ok(limit(card) === 400 && !note(), 'a limit of 400 chosen then is 400, and the note is gone', JSON.stringify({ limit: limit(card), note: note() }));
  card.tap();
  const looked = await H.W.cardLook(card, { mine: true });
  ok(limit(card) === 400 && looked.restored === undefined, 'and the next read of the owner’s phone puts nothing back');

  console.log(failed ? '\n' + failed + ' flashcard-stale-lift check(s) failed' : '\nall flashcard-stale-lift checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  threw', e && e.stack || e); process.exit(1); });
