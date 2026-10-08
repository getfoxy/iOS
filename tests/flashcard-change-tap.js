'use strict';
/* flashcard-change-tap.js — the tap after a payment writes the change with no
 * PIN.
 *
 *     node tests/flashcard-change-tap.js
 *
 * A till lets the card go as soon as it has signed, and the change is written at
 * a second tap. The card notes that it has paid (permanent memory), and lets the
 * next tap put pieces on with no PIN, once (spec 8.2). This pins:
 *
 *   a payment with change leaves the change owed, and the card holding the note;
 *   the next tap writes the change with no PIN sent, and the note is used up;
 *   a tap after that with no PIN is refused before anything is sent, with the
 *     change (if any) still owed, and the PIN writes it;
 *   a tap that only reads the card (its holder's phone) uses the note up, so the
 *     till is asked for the PIN after all, and nothing is lost;
 *   the note opens nothing but loading: a spend in that tap still needs the PIN;
 *   a card of version 1.1, which says nothing of the sort, is written with the PIN.
 */
const { funded, newCard, binaryLoad, why, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const pinSent = (card) => card.sent.some((a) => /^b040/.test(a));

(async () => {
  const H = await funded({}, 12000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);

  /* ---- 1: a payment with change, and the change written with no PIN ------------------ */
  const card = newCard(H);
  await H.W.cardSetUp(card, { pin: '1234' });
  await binaryLoad(H, card, 1024);   // one piece: a payment of 200 needs change
  card.tap();
  const paid = await R.W.cardPay(card, { sats: 200, pin: '1234' });
  ok(paid.sats === 200 && paid.change && paid.change.sats === 824 && paid.change.written === false && (await bal(R)) === 200,
     'a card of one piece pays 200: the receiver is paid, and 824 of change waits for the card', JSON.stringify(paid.change));
  ok(R.W.cardOwed().length === 1 && R.W.cardOwed()[0].kind === 'change' && R.W.cardOwed()[0].sats === 824, 'owed to it, as change');
  ok(card.state.changeDue === true && card.state.changeGrant === false, 'the card has noted that it paid, for the next tap and not this one');

  card.tap();
  card.sent.length = 0;
  const wrote = await R.W.cardWrite(card, { change: true });
  ok(wrote.sats === 824 && wrote.left === 0 && card.balance() === 824 && R.W.cardOwed().length === 0,
     'the next tap writes the change with no PIN', JSON.stringify({ sats: wrote.sats, card: card.balance() }));
  ok(!pinSent(card), 'and no PIN was sent to the card', card.sent.map((a) => a.slice(0, 6)).join(' '));
  ok(card.state.changeDue === false, 'the note is used up');
  ok(card.sent.filter((a) => /^b031/.test(a)).length >= 1, 'the place the payment burned was freed first');

  /* ---- 2: a tap after that, with no PIN, is refused before anything is sent --------- */
  card.tap();
  card.sent.length = 0;
  const again = await why(R.W.cardWrite(card, { change: true }));
  ok(again === 'pin-needed', 'a tap with no PIN after the change tap is refused: pin-needed', again);
  ok(!card.sent.some((a) => /^b030|^b031/.test(a)), 'and nothing was sent to the card but a read', card.sent.map((a) => a.slice(0, 6)).join(' '));
  ok(card.balance() === 824, 'the card is as it was');

  /* ---- 3: a read between the payment and the change tap does NOT use the note up ------ */
  const c2 = newCard(H);
  await H.W.cardSetUp(c2, { pin: '1234' });
  await binaryLoad(H, c2, 1024);
  c2.tap();
  const paid2 = await R.W.cardPay(c2, { sats: 300, pin: '1234' });
  ok(paid2.sats === 300 && paid2.change && paid2.change.sats === 724 && !paid2.change.written, 'another card pays 300 from one piece, 724 of change owed');
  c2.tap();
  await H.W.cardLook(c2);   // the holder looks at it on their own phone, between the payment and the change tap
  ok(c2.state.changeDue === true, 'a tap that only reads the card leaves the note standing (the fix: it is not burned at SELECT)');
  c2.tap();
  const wrote2 = await R.W.cardWrite(c2, { change: true });
  ok(wrote2.sats === 724 && wrote2.left === 0 && c2.balance() === 724 && R.W.cardOwed().filter((r) => r.card === c2.key).length === 0,
     'so the change still goes on with no PIN, after the glance', String(c2.balance()));
  ok(c2.state.changeDue === false, 'and the load closed the window');
  c2.tap();
  const noMore = await why(R.W.cardWrite(c2, { change: true }));
  ok(noMore === 'pin-needed', 'a tap after the change is on gets no grant', noMore);

  /* ---- 4: the note opens nothing but loading ------------------------------------------ */
  {
    const c3 = newCard(H);
    await H.W.cardSetUp(c3, { pin: '1234' });
    await binaryLoad(H, c3, 512 + 2 + 1);
    c3.tap();
    await R.W.cardPay(c3, { sats: 512, pin: '1234' });   // exact: 512, which leaves a 2 and a 1 and no gap; the note is set all the same
    ok(c3.state.changeDue === true, 'an exact payment leaves the note too (the card cannot know there is no change)');
    c3.tap();
    await c3.send('00a40400' + '0a' + 'f0464f58594341524401' + '00');
    const info = await c3.send('b001000000');
    ok(info.slice(58, 60) === '01', 'GET_INFO says this tap may load', info);
    const spend = await c3.send('b020000040');
    ok(spend === '6982', 'but a spend in it still needs the PIN', spend);
    const limit = await c3.send('b03300000400000064');
    ok(limit === '6982' || limit === '6a91', 'and so does anything else the PIN opens', limit);
    const info2 = await c3.send('b001000000');
    ok(info2.slice(58, 60) === '01', 'the refusals did not use the grant up', info2);
    ok(c3.balance() === 3, 'nothing was spent');
  }

  /* ---- 5: a card that says nothing of the sort (version 1.1) is written with the PIN -- */
  {
    const old = newCard(H);
    await H.W.cardSetUp(old, { pin: '1234' });
    await binaryLoad(H, old, 1024);
    old.tap();
    const p = await R.W.cardPay(old, { sats: 100, pin: '1234' });
    ok(p.change && p.change.sats === 924, 'an old card pays 100 with change owed');
    // its GET_INFO is 29 bytes: the answer is cut before the last byte
    const send = old.send.bind(old);
    old.send = (apdu) => send(apdu).then((r) => (/^b001/.test(String(apdu)) ? r.slice(0, 58) + '9000' : r));
    old.tap();
    const r = await why(R.W.cardWrite(old, { change: true }));
    ok(r === 'pin-needed', 'a tap with no PIN is refused: it says nothing of a grant', r);
    old.tap();
    const w = await R.W.cardWrite(old, { pin: '1234' });
    ok(w.sats === 924 && old.balance() === 924, 'and the PIN writes the change', String(old.balance()));
  }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
