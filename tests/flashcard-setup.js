'use strict';
/* flashcard-setup.js — reading a card and making a new one this phone's.
 *
 *     node tests/flashcard-setup.js
 *
 * The card here is the model (tests/flashcard-card.js), which answers as the
 * applet does (tests/flashcard-model.js). No money moves in this suite: it is
 * the card's own state, the PIN, and what the phone writes down about a card
 * before it trusts it with any.
 */
const { funded, newCard, why, MINT } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

(async () => {
  const P = await funded({}, 0);
  const W = P.W;

  /* ---- a new card -------------------------------------------------------- */
  const card = newCard(P);
  const seen = await W.cardLook(card);
  ok(seen.key === card.key && seen.info.pin === 'none' && !seen.info.hasRecord && seen.balance === 0 && seen.info.slots === 64,
     'a new card says it is new: no PIN, no record, nothing on it', JSON.stringify(seen.info));
  ok(card.sent.some((a) => a.slice(2, 4) === '15'), 'and is made to prove it holds its key');

  /* ---- not a card, or not the card it says ------------------------------- */
  ok((await why(W.cardLook({ send: () => Promise.resolve('6a82') }))) === 'not-a-card', 'something that does not answer to the card’s name is not a card');
  ok((await why(W.cardLook({ send: () => Promise.reject(new Error('x')) }))) === 'gone', 'a card that answers nothing has gone');
  {
    // a pretend card: it relays a real card's answers and cannot sign for its key
    const real = newCard(P);
    const liar = { send: (a) => real.send(a).then((r) => (a.slice(2, 4) === '15' ? '00'.repeat(80) + '9000' : r)) };
    ok((await why(W.cardLook(liar))) === 'not-a-card', 'a card that cannot sign for the key it shows is refused');
    const other = newCard(P);
    await other.send('00a4040009f0464f58594341524400');
    const swap = { send: (a) => (a.slice(2, 4) === '15' ? other.send(a) : real.send(a)) };
    real.tap();
    ok((await why(W.cardLook(swap))) === 'not-a-card', 'and so is one whose proof was signed by another card’s key');
  }

  /* ---- set-up, recoverable ---------------------------------------------- */
  ok((await why(W.cardSetUp(card, { pin: '12', recoverable: true }))) === 'bad-pin', 'a PIN of two digits is refused before the card is told anything');
  ok((await why(W.cardSetUp(card, { pin: '12a4', recoverable: true }))) === 'bad-pin', 'and one that is not digits');
  ok(card.state.pinState === 0, 'the card still has no PIN');
  card.tap();
  const mine = await W.cardSetUp(card, { pin: '1234', recoverable: true });
  ok(mine.info.pin === 'set' && mine.info.hasRecord && mine.record.mint === MINT && mine.record.unit === 'sat',
     'a card set up has its PIN and says which mint it is for', JSON.stringify(mine.record));
  const known = W.cardsKnown()[card.key] || {};
  ok(/^0[23][0-9a-f]{64}$/.test(mine.record.refundKey) && known.refundKey === mine.record.refundKey && known.refundIndex >= 0,
     'a recoverable card carries a key of this phone’s, and the phone has written down which', JSON.stringify(known));
  {
    // that key is one the phone derives from its words at the index kept
    const got = await new Promise((res) => {
      const id = 'k' + Math.random();
      const done = P.window.FoxyWallet._scanResult;
      P.window.FoxyWallet._scanResult = function (i, text, err) { if (i === id) { P.window.FoxyWallet._scanResult = done; res(text); return; } return done.apply(this, arguments); };
      P.window.webkit.messageHandlers.foxy.postMessage({ id, action: 'p2pkKey', index: known.refundIndex });
    });
    let pub = '';
    try { pub = JSON.parse(got).pubkey; } catch (e) {}
    ok(String(pub).toLowerCase() === known.refundKey, 'and it is the key the phone’s words give at that index', String(pub).slice(0, 12));
  }
  card.tap();
  ok((await why(W.cardSetUp(card, { pin: '1234', recoverable: true }))) === 'set-up', 'a card that is set up is not set up again');

  /* ---- set-up, as cash --------------------------------------------------- */
  const cash = newCard(P);
  const c2 = await W.cardSetUp(cash, { pin: '0000' });
  ok(c2.record.refundKey === '' && !W.cardsKnown()[cash.key], 'a card set up as cash carries no key of anybody’s, and nothing is kept about it', JSON.stringify(c2.record));

  /* ---- a set-up cut off after the PIN ------------------------------------ */
  const cut = newCard(P);
  cut.leaveAfter(7);      // the six commands of a look and SET_PIN, then gone before the record
  const first = await why(W.cardSetUp(cut, { pin: '4321', recoverable: true }));
  ok(first === 'gone' && cut.state.pinState === 1 && !cut.state.record.set, 'a card taken away mid set-up has its PIN and no record', first);
  cut.tap();
  ok((await why(W.cardSetUp(cut, { pin: '9999', recoverable: true }))) === 'wrong-pin', 'tapped again with another PIN, it is the card’s PIN that counts');
  cut.tap();
  const done = await W.cardSetUp(cut, { pin: '4321', recoverable: true });
  ok(done.info.hasRecord && done.record.refundKey === W.cardsKnown()[cut.key].refundKey, 'tapped again with its PIN, the set-up is finished with the key first written down for it');

  /* ---- the PIN ----------------------------------------------------------- */
  card.tap();
  const wrong = await W.cardSetLimit(card, { pin: '9999', sats: 100 }).then(() => null, (e) => e);
  ok(wrong && wrong.card === 'wrong-pin' && wrong.tries === 2 && /2 tries left/.test(wrong.message), 'a wrong PIN says how many tries are left', wrong && wrong.message);
  card.tap();
  const lim = await W.cardSetLimit(card, { pin: '1234', sats: 5000 });
  ok(lim.info.limit === 5000 && lim.info.tries === 3, 'the right PIN sets the limit, and gives the tries back', JSON.stringify({ limit: lim.info.limit, tries: lim.info.tries }));
  card.tap();
  ok((await W.cardChangePin(card, { pin: '1234', newPin: '246810' })) === true, 'the PIN is changed');
  card.tap();
  ok((await why(W.cardSetLimit(card, { pin: '1234', sats: 1 }))) === 'wrong-pin', 'the old PIN no longer opens the card');
  card.tap();
  ok((await W.cardSetLimit(card, { pin: '246810', sats: 0 })).info.limit === 0, 'and the new one does');

  /* ---- blocked ----------------------------------------------------------- */
  const doomed = newCard(P);
  await W.cardSetUp(doomed, { pin: '1111', recoverable: true });
  const said = [];
  for (let i = 0; i < 4; i++) { doomed.tap(); said.push(await W.cardSetLimit(doomed, { pin: '2222', sats: 1 }).then(() => 'ok', (e) => e.card + (e.tries !== undefined ? ':' + e.tries : ''))); }
  ok(said.join(' ') === 'wrong-pin:2 wrong-pin:1 blocked:0 blocked:0', 'three wrong PINs block the card, and it says so each time after', said.join(' '));
  doomed.tap();
  ok((await why(W.cardSetLimit(doomed, { pin: '1111', sats: 1 }))) === 'blocked', 'the right PIN does not open a blocked card');
  doomed.tap();
  const b = await W.cardLook(doomed);
  ok(b.info.pin === 'blocked' && b.info.tries === 0 && b.key === doomed.key, 'but it still says what it is, for the phone that can take its money back');

  /* ---- a tap, through the phone ------------------------------------------- */
  {
    const tapped = newCard(P);
    P.nfc = tapped;
    P.sheet.length = 0;
    const got = await W.cardSession('Hold the card to the top of the phone', (link) => W.cardLook(link));
    ok(got.key === tapped.key && P.sheet.join(' | ') === 'begin: Hold the card to the top of the phone | end: Done',
       'a tap opens the phone\u2019s sheet, reads the card through it and closes it', P.sheet.join(' | '));
    P.sheet.length = 0;
    const refused = await W.cardSession('Hold the card', (link) => W.cardSetLimit(link, { pin: '1234', sats: 1 })).then(() => null, (e) => e);
    ok(refused && refused.card === 'no-pin' && /^begin: Hold the card \| error: /.test(P.sheet.join(' | ')),
       'what the card refuses is said on the sheet as it closes, and comes back as it was', P.sheet.join(' | '));
    P.sheet.length = 0;
    // set once the tap has begun: the card arriving is what clears what it was told before
    const left = await W.cardSession('Hold the card', (link) => { tapped.leaveAfter(3); return W.cardLook(link); }).then(() => null, (e) => e);
    ok(left && left.card === 'gone' && /error: The card was taken away too soon/.test(P.sheet.join(' | ')), 'a card taken away mid-tap is said so', P.sheet.join(' | '));
    P.nfc = null;
    ok((await why(W.cardSession('Hold the card', (link) => W.cardLook(link)))) === 'cancelled', 'a sheet dismissed with no card is a tap that was not made');
    P.nfc = 'off';
    ok((await why(W.cardSession('Hold the card', (link) => W.cardLook(link)))) === 'no-nfc', 'and a phone that cannot read a card says that');
  }

  console.log('\n' + (failed ? failed + ' flashcard-setup check(s) failed' : 'all flashcard-setup checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
