'use strict';
/* flashcard-money.js — money onto a card, off it, and change back to it.
 *
 *     node tests/flashcard-money.js
 *
 * A holder's phone, a receiver's phone and a card between them, at one mint
 * (the harness's, which signs and refuses as a mint does). The card is the
 * model. As every suite that drives the real wallet does, this one ends by
 * asking whether each phone's entries account for what it holds
 * (tests/harness.js, the books).
 */
const { funded, newCard, binaryLoad, why, history, settle, MINT, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const amounts = (card) => card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(16, 8), 16)).sort((a, b) => b - a);
const row = (c, hash) => history(c).filter((e) => e.hash === hash)[0] || {};

async function world(feePpk) {
  const H = await funded({ feePpk }, 6000);
  const R = await funded({ feePpk, sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H);
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  return { H, R, card };
}

let L0 = null;
(async () => {
  /* ---- 1: onto the card -------------------------------------------------- */
  const { H, R, card } = await world(0);
  L0 = H.W;
  const before = await bal(H);
  const added = await H.W.cardAdd(card, { sats: 2000, pin: '1234' });
  ok(added.sats === 2000 && added.left === 0 && added.card.balance === 2000 && card.balance() === 2000,
     '2,000 sats are put on a card', JSON.stringify({ sats: added.sats, card: card.balance() }));
  ok((await bal(H)) === before - 2000, 'and are out of the phone', (await bal(H)) + ' of ' + before);
  {
    const deep = amounts(card).reduce((o, a) => { o[a] = (o[a] || 0) + 1; return o; }, {});
    ok(JSON.stringify(deep) === JSON.stringify({ 1: 8, 2: 8, 4: 8, 8: 9, 16: 9, 32: 8, 64: 9, 128: 7 }) && amounts(card).length === 66,
       'cut as a deep drawer: eight of each size from 1 up, as far as 2,000 sats go, and what is left over in powers of two', JSON.stringify(deep));
  }
  const loadRow = history(H).filter((e) => e.dir === 'out')[0] || {};
  ok(loadRow.sats === 2000 && loadRow.memo === 'to card' && loadRow.card === card.key, 'with one entry, to the card', JSON.stringify({ sats: loadRow.sats, memo: loadRow.memo }));
  ok(H.W.cardOwed().length === 0, 'and nothing left owed to it');
  {
    const year = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const dates = added.card.pieces.map((x) => x.date);
    ok(dates.every((d) => Math.abs(d - year) < 600), 'each piece can be taken back by this phone a year from now', String(dates[0]));
    const known = (H.W.cardsKnown()[card.key] || {}).pieces || {};
    ok(Object.keys(known).length === 66 && Object.keys(known).reduce((n, k) => n + known[k].amount, 0) === 2000,
       'and the phone has written down what it put there', String(Object.keys(known).length));
  }

  /* ---- 4: paying a receiver, with change ---------------------------------- */
  {
    // a card cut the old way (the powers of two of 2,000 and no more), so that 1,000 has no exact set and needs change.
    // It pays with the 1024 alone, and the card makes the 24 of change itself, cut plainly (16 and 8): restocking a drawer is a top-up's job.
    const H4 = await funded({ sharedMint: H.mint, words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' }, 4500);
    const R4 = await funded({ sharedMint: H.mint, words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' }, 0);
    const c4 = newCard(H4);
    await H4.W.cardSetUp(c4, { pin: '1234', recoverable: true });
    await binaryLoad(H4, c4, 2000);
    ok(amounts(c4).join('+') === '1024+512+256+128+64+16', 'a card with no exact set for 1,000: 1024, 512, 256, 128, 64 and 16', amounts(c4).join('+'));
    c4.tap();
    const steps = [];
    const paid = await R4.W.cardPay(c4, { sats: 1000, pin: '1234', on: (s) => steps.push(s) });
    ok(paid.sats === 1000 && (await bal(R4)) === 1000, 'a card pays a receiver 1,000 sats', String(await bal(R4)));
    ok(steps.join(' ') === 'reading signing checking done', 'the screen is told each step: the card is let go once it has signed, and the mint is done after', steps.join(' '));
    ok(paid.change && paid.change.sats === 24 && paid.change.written === false && c4.balance() === 2000 - 1024,
       'it pays with the 1024, and the 24 sats over are change the card made in the same swap, which waits for its next tap: it has been let go', JSON.stringify(paid.change) + ', card ' + c4.balance());
    ok(R4.W.cardOwed().length === 1 && R4.W.cardOwed()[0].kind === 'change' && R4.W.cardOwed()[0].sats === 24 && R4.W.cardTaken().length === 0,
       'the receiver holds nothing of the card’s but that change, owed to it');
    const payRow = row(R4, paid.hash);
    ok(payRow.dir === 'in' && payRow.sats === 1000 && payRow.memo === 'card' && payRow.changeSats === 24 && payRow.changeState === 'not handed',
       'the receiver has one entry: 1,000 from a card, its change not yet handed over', JSON.stringify({ sats: payRow.sats, memo: payRow.memo, c: payRow.changeSats, state: payRow.changeState }));
    c4.tap();
    const given = await R4.W.cardWrite(c4, { pin: '1234' });
    ok(given.left === 0 && c4.balance() === 1000 && R4.W.cardOwed().length === 0 && row(R4, paid.hash).changeState === 'given back',
       'the next tap writes it, and the entry says given back', String(c4.balance()));
    ok(amounts(c4).join('+') === '512+256+128+64+16+16+8', 'and it comes as the powers of two it is made of, 16 and 8', amounts(c4).join('+'));
    ok(R4.W.cardTaken().length === 0 && R4.W.cardOwed().length === 0, 'and the receiver holds nothing of the card’s');

    // the card held to the phone for all of it (a renewal, a move): the change is written back in the same tap
    const c4b = newCard(H4);
    await H4.W.cardSetUp(c4b, { pin: '1234', recoverable: true });
    await binaryLoad(H4, c4b, 2000);
    c4b.tap();
    const rb = await bal(R4);
    const held = await R4.W.cardPay(c4b, { sats: 1000, pin: '1234', hold: true, on: (s) => steps.push(s) });
    ok(held.change && held.change.sats === 24 && held.change.written === true && c4b.balance() === 1000 && (await bal(R4)) === rb + 1000,
       'with the card held (`hold`) the change is written back in the same tap, as it always was', JSON.stringify(held.change));
  }

  /* ---- 2: the mint first, the card after; a wrong PIN between -------------- */
  card.tap();
  const onCardBefore = card.balance(), piecesBefore = amounts(card).length, hBefore23 = await bal(H);
  const seen = await H.W.cardLook(card);
  const prep = await H.W.cardPrepare(seen, 300);
  ok(prep.sats === 300 && H.W.cardOwed().length === 1 && H.W.cardOwed()[0].kind === 'load' && card.balance() === onCardBefore,
     'pieces made for a card wait for it, and are not on it yet', JSON.stringify(H.W.cardOwed().map((r) => r.sats)));
  ok((await bal(H)) === before - 2300, 'they have left the phone’s balance already');
  card.tap();
  ok((await why(H.W.cardWrite(card, { pin: '9999' }))) === 'wrong-pin' && H.W.cardOwed().length === 1 && card.balance() === onCardBefore,
     'a wrong PIN writes nothing, and they go on waiting');
  card.tap();
  const wrote = await H.W.cardWrite(card, { pin: '1234' });
  ok(wrote.sats === 300 && wrote.left === 0 && card.balance() === onCardBefore + 300 && H.W.cardOwed().length === 0, 'the right PIN puts them on the card', String(card.balance()));

  /* ---- 2b: the room, asked before anything is made ------------------------- */
  {
    /* ADD FUNDS asks the keypad's amount of the wallet before the tap
     * (`cardLoadFits`), and the answer is the load's own: the cut it makes and
     * the check it refuses on (`cardLoadCut`), in the words it refuses in. A card
     * with fewer than five free places has no room for any load, a piece and the
     * four places a write keeps back. */
    card.tap();
    const look = await H.W.cardLook(card);
    const crowded = (free) => Object.assign({}, look, { info: Object.assign({}, look.info, { empty: free, spent: 0 }) });
    const FULL = 'The card has no room for that. Take some money off it first.';
    const roomy = H.W.cardLoadFits(look, 300);
    ok(!!roomy && roomy.ok === true && roomy.why === '' && roomy.sats >= 300 && roomy.rounded === roomy.sats - 300 && roomy.room === look.info.empty + look.info.spent,
       'a card with its places free says a load fits, and what the load comes to', JSON.stringify(roomy));
    for (const free of [0, 2, 4]) {
      const none = H.W.cardLoadFits(crowded(free), 300);
      const refused = await H.W.cardPrepare(crowded(free), 300).then(() => null, (e) => e);
      ok(!!none && none.ok === false && none.why === FULL && none.room === free && !!refused && refused.card === 'full' && refused.message === FULL && H.W.cardOwed().length === 0,
         free + ' free places: the keypad’s answer is the load’s own refusal, in its own words, and nothing was made', JSON.stringify(none) + ' | ' + (refused && refused.message));
    }
    const five = H.W.cardLoadFits(crowded(5), 300);
    ok(!!five && five.ok === true && five.sats === 512 && five.rounded === 212,
       'five free places hold one piece: the load is rounded up to it, and the answer says by how much', JSON.stringify(five));
    ok(H.W.cardLoadFits(null, 300) === null && H.W.cardLoadFits(look, 0) === null && H.W.cardLoadFits(Object.assign({}, look, { info: Object.assign({}, look.info, { setUp: false }) }), 300) === null,
       'no card, no amount, or a card not set up is no answer');
    ok(H.W.cardOwed().length === 0 && card.balance() === onCardBefore + 300, 'asking made nothing and wrote nothing', String(card.balance()));
  }

  /* ---- 3: the card taken away mid-write ----------------------------------- */
  card.tap();
  card.leaveBefore('30', 2);       // the second piece is not written
  const cut = await H.W.cardAdd(card, { sats: 48, pin: '1234' }).then((r) => r, (e) => ({ why: e.card || e.message }));
  ok(cut.why === 'gone' && H.W.cardOwed().length === 1 && card.balance() === onCardBefore + 300 + 32,
     'a card taken away between two pieces holds the first, and the phone still owes it the rest', JSON.stringify({ why: cut.why, card: card.balance() }));
  card.tap();
  const fin = await H.W.cardWrite(card, { pin: '1234' });
  ok(fin.left === 0 && card.balance() === onCardBefore + 348 && H.W.cardOwed().length === 0, 'the next tap writes what was left', String(card.balance()));
  {
    const nonces = card.state.slots.filter((x) => x.status === 1).map((x) => x.data.substr(24, 64));
    ok(card.balance() === onCardBefore + 348 && new Set(nonces).size === nonces.length && amounts(card).length > piecesBefore, 'and the piece already there is not written twice', amounts(card).length - piecesBefore + ' pieces for 300 and 48');
  }
  ok((await bal(H)) === hBefore23 - 348, 'the phone is out exactly what it put on the card');

  /* ---- 5: exact pieces need no change -------------------------------------- */
  card.tap();
  const exact = await R.W.cardPay(card, { sats: 512, pin: '1234' });
  ok(exact.change === null && (await bal(R)) === 512 && card.balance() === 2348 - 512, 'a payment the card has the pieces for needs no change', String(card.balance()));

  /* ---- 6: refused with nothing signed -------------------------------------- */
  const spentBefore = card.state.slots.filter((x) => x.status === 2).length;
  card.tap();
  const wrongPin = await R.W.cardPay(card, { sats: 100, pin: '0000' }).then(() => null, (e) => e);
  ok(wrongPin && wrongPin.card === 'wrong-pin' && wrongPin.tries === 2, 'a wrong PIN pays nothing and says how many tries are left', wrongPin && wrongPin.message);
  card.tap();
  const tooMuch = await R.W.cardPay(card, { sats: 50000, pin: '1234' }).then(() => null, (e) => e);
  ok(tooMuch && tooMuch.card === 'not-enough' && tooMuch.balance === card.balance(), 'more than the card holds is refused, saying what it holds', tooMuch && tooMuch.message);
  card.tap();
  await H.W.cardSetLimit(card, { sats: 100 });
  card.tap();
  card.sent.length = 0;
  const over = await R.W.cardPay(card, { sats: 300, pin: '1234' }).then(() => null, (e) => e);
  // (the card has been shown no block yet: its day is on trust, and has no hour to turn at)
  ok(over && over.card === 'limit' && over.left === 100 && over.need >= 300 && over.turns === 0, 'a payment the card’s daily limit cannot cover is refused, saying how much is left today', over && over.message);
  ok(!card.sent.some((a) => /^b0(40|22|24|44)/.test(a)), 'and the card was not sent its PIN, a nonce or a payment: it was told the time and read, and that is all', card.sent.map((a) => a.slice(0, 6)).join(' '));
  ok(card.state.record.limit === 100, 'its limit is as it was');
  card.tap();
  await H.W.cardSetLimit(card, { sats: 0 });
  ok(card.state.slots.filter((x) => x.status === 2).length === spentBefore && (await bal(R)) === 512 && card.state.tries === 2,
     'none of those burned a piece or moved a sat, and the wrong PIN cost the one try it was');
  {
    const away = await funded({ words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above', mint: 'https://other.test' }, 0);
    card.tap();
    const other = await away.W.cardPay(card, { sats: 10, pin: '1234' }).then(() => null, (e) => e);
    ok(other && other.card === 'other-mint' && /m\.test/.test(other.message) && /other\.test/.test(other.message),
       'a receiver at another mint refuses the card and names both mints', other && other.message);
  }

  /* ---- 7: the card is let go before its change is made -------------------- */
  {
    // a card with one piece, so any payment from it needs change
    const c7 = newCard(H);
    await H.W.cardSetUp(c7, { pin: '1234', recoverable: true });
    await binaryLoad(H, c7, 1024);
    c7.tap();
    const rBefore = await bal(R);
    const noChange = await R.W.cardPay(c7, { sats: 200, pin: '1234' });
    ok(noChange.sats === 200 && (await bal(R)) === rBefore + 200 && noChange.change && noChange.change.sats === 824 && noChange.change.written === false,
       'a card let go after it signed has still paid', JSON.stringify(noChange.change));
    // the card makes four pieces of the 824 itself (512 + 256 + 32 + 16), and the till the 8 left, after the swap
    const owed = R.W.cardOwed();
    ok(owed.length === 2 && owed.every((r) => r.kind === 'change' && r.card === c7.key) && owed.reduce((n, r) => n + r.sats, 0) === 824
       && row(R, noChange.hash).changeState === 'not handed',
       'and its change is owed to it, said on the payment’s entry', JSON.stringify(owed.map((r) => [r.kind, r.sats])));
    ok(c7.balance() === 0, 'the card holds nothing until then', String(c7.balance()));
    c7.tap();
    ok((await why(R.W.cardWrite(c7, { pin: '0000' }))) === 'wrong-pin' && R.W.cardOwed().length === 2, 'tapped again with a wrong PIN, the change goes on waiting');
    c7.tap();
    const back = await R.W.cardWrite(c7, { pin: '1234' });
    ok(back.left === 0 && c7.balance() === 824 && R.W.cardOwed().length === 0 && row(R, noChange.hash).changeState === 'given back',
       'tapped again with the PIN, the change is on the card and the entry says given back', String(c7.balance()));
    ok((await bal(R)) === rBefore + 200, 'the receiver kept exactly what it was paid');
  }

  /* ---- 9: a copy of the card pays nobody twice ----------------------------- */
  card.tap();
  const twin = card.copy();
  const rBefore = await bal(R);
  const first = await R.W.cardPay(card, { sats: 64, pin: '1234' });
  const again = await R.W.cardPay(twin, { sats: 64, pin: '1234' }).then(() => null, (e) => e);
  ok(first.sats === 64 && again && again.card === 'spent' && R.W.cardTaken().length === 0,
     'a copy of the card, tapped after the card, is told by the mint its money is spent', again && again.message);
  ok((await bal(R)) === rBefore + 64, 'and the receiver is paid once');

  /* ---- 10: the mint’s answer is lost ---------------------------------- */
  card.tap();
  const lostBefore = await bal(R);
  R.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? (R.mint.handle(m), R.fate = null, null) : null);
  // the mint acts and its answer never arrives: the bridge says the request failed
  const realHandle = R.mint.handle.bind(R.mint);
  let dropped = false;
  R.fate = (m) => {
    if (dropped || !/\/v1\/swap$/.test(String(m.url || ''))) return null;
    dropped = true;
    realHandle(m);
    return '0\n';
  };
  const lost = await R.W.cardPay(card, { sats: 32, pin: '1234' }).then((r) => r, (e) => e);
  R.fate = null;
  await settle();
  await R.W.cardSettle();
  await settle();
  ok(dropped && (await bal(R)) === lostBefore + 32 && R.W.cardTaken().length === 0,
     'a swap whose answer never came is found again, and the receiver is paid once', JSON.stringify({ first: lost && (lost.card || lost.sats), bal: await bal(R) }));

  /* ---- 11: the holder takes it all off ------------------------------------- */
  card.tap();
  const hBefore = await bal(H), onCard = card.balance();
  const out = await H.W.cardWithdraw(card, { pin: '1234' });
  ok(out.sats === onCard && (await bal(H)) === hBefore + onCard && card.balance() === 0, 'the holder takes everything off the card', out.sats + ' of ' + onCard);
  ok(row(H, out.hash).memo === 'from card' && row(H, out.hash).sats === onCard, 'with one entry, from the card');
  card.tap();
  ok((await why(R.W.cardPay(card, { sats: 1, pin: '1234' }))) === 'not-enough', 'and an empty card pays nothing');

  /* ---- 12: a mint that charges --------------------------------------------- */
  {
    const F = await world(1000);
    const f0 = await bal(F.H);
    const a = await F.H.W.cardAdd(F.card, { sats: 2000, pin: '1234' });
    ok(a.left === 0 && F.card.balance() >= 2000, 'at a mint that charges a sat a piece, 2,000 go on the card with the sat each will cost to take off', String(F.card.balance()));
    ok(f0 - (await bal(F.H)) >= F.card.balance(), 'the phone paid for them', (f0 - (await bal(F.H))) + ' for ' + F.card.balance());
    F.card.tap();
    const held = F.card.balance();
    const p = await F.R.W.cardPay(F.card, { sats: 1000, pin: '1234' });
    // RECEIVE: its change goes back on at the next tap, with no PIN
    if (p.change && p.change.sats > 0 && !p.change.written) {
      F.card.tap();
      await F.R.W.cardWrite(F.card, { change: true });
    }
    ok(p.sats === 1000 && (await bal(F.R)) >= 1000 - 2 && (await bal(F.R)) <= 1000 + 4, 'a receiver is paid 1,000 from it, within a sat or two: more when the sats over are too few to make change of, less by what making it cost', String(await bal(F.R)));
    ok(row(F.R, p.hash).sats === (await bal(F.R)) && F.R.W.cardOwed().length === 0 && F.R.W.cardTaken().length === 0,
       'its entry says exactly what it holds, and nothing of the card\u2019s is left with it', JSON.stringify({ sats: row(F.R, p.hash).sats, holds: await bal(F.R) }));
    ok(F.card.balance() > 0 && F.card.balance() <= held - 1000 + 4 && F.card.balance() >= held - 1000 - 20, 'and the card holds the rest', F.card.balance() + ' of ' + held);
  }

  /* ---- 13: the daily limit ------------------------------------------------------- */
  {
    // a card of its own, with pieces of 1024, 512, 256, 128, 64 and 16, and a limit that is set at each step
    const L = await world(0);
    const limit = (c) => c.state.record.limit;
    const spent = (c) => c.state.spent;
    const ins = (c) => c.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));

    // the owner adds funds with no PIN
    const T0 = newCard(L.H);
    await L.H.W.cardSetUp(T0, { pin: '1234', recoverable: true });
    T0.tap();
    T0.sent.length = 0;
    const put = await L.H.W.cardAdd(T0, { sats: 100, owner: true });
    ok(put.sats === 100 && T0.balance() === 100 && !ins(T0).includes('40'), 'the owner’s phone adds 100 sats with no PIN: none was sent', ins(T0).join(' '));
    ok(ins(T0).indexOf('37') >= 0 && ins(T0).indexOf('37') < ins(T0).indexOf('44') && ins(T0).indexOf('45') > ins(T0).indexOf('44') && ins(T0).indexOf('30') > ins(T0).indexOf('45'),
       'it tells the card the time, asks for a nonce, is allowed to load, and loads, in that order', ins(T0).join(' '));
    // and the card for the limit is cut the old way, so its pieces are large (1024, 512, 256, 128, 64 and 16): a day is charged what leaves the card
    const loaded = await binaryLoad(L.H, L.card, 2000);
    ok(loaded.sats === 2000 && L.card.balance() === 2000, 'a card of its own with 2,000 sats on it, in large pieces');
    L.card.tap();
    await L.H.W.cardSetLimit(L.card, { sats: 600 });
    ok(limit(L.card) === 600 && spent(L.card) === 0, 'the limit is set to 600 a day');

    // pieces as near the price as there are, and the day is charged what leaves the card, which is the price (the pieces may come to more)
    L.card.tap();
    const paid = await L.R.W.cardPay(L.card, { sats: 300, pin: '1234' });
    ok(paid.sats === 300 && spent(L.card) === 300 && limit(L.card) === 600,
       'a payment of 300 is made with pieces worth 320, the nearest cover there is, and the day is charged the 300 that left the card', JSON.stringify({ spent: spent(L.card) }));
    ok(paid.change && paid.change.sats === 20 && paid.change.written === false && L.card.balance() === 2000 - 320 && spent(L.card) === 300,
       'the card has been let go, and the change it made waits for its next tap', JSON.stringify({ spent: spent(L.card), card: L.card.balance() }));
    L.card.tap();
    await L.R.W.cardWrite(L.card, { pin: '1234' });
    ok(L.card.balance() === 2000 - 300 && spent(L.card) === 300,
       'the change that goes back on the card is not charged to the day', JSON.stringify({ spent: spent(L.card), card: L.card.balance() }));
    L.card.tap();
    L.card.sent.length = 0;
    const next = await L.R.W.cardPay(L.card, { sats: 350, pin: '1234' }).then(() => null, (e) => e);
    ok(next && next.card === 'limit' && next.left === 300 && /300 sats/.test(next.message),
       'a second payment of 350 is more than the 300 left today, and is refused, saying what is left', next && next.message);
    ok(!ins(L.card).includes('40') && !ins(L.card).includes('22'), 'before the PIN is sent or anything is begun');
    L.card.tap();
    const two = await L.R.W.cardPay(L.card, { sats: 200, pin: '1234' });
    ok(two.sats === 200 && spent(L.card) === 500, 'one of 200 goes, whatever the pieces it is paid with come to: the day is charged 200', String(spent(L.card)));
    if (two.change && two.change.sats > 0 && !two.change.written) { L.card.tap(); await L.R.W.cardWrite(L.card, { change: true }); }

    // the card reads its own day for the screens; it has been shown no block, so its day is on trust and has no hour to turn at
    // (a day turned by a block a day later is tests/flashcard-clock.js, 3b and 6)
    L.card.tap();
    const day = (await L.H.W.cardLook(L.card)).day;
    ok(day.limited && day.limit === 600 && day.spent === 500 && day.left === 100 && day.onTrust === true, 'the card’s day reads as 100 left, on trust', JSON.stringify(day));

    // a phone that does not hold the words is a till like any other: it cannot take what is past the day
    L.card.tap();
    const O = await funded({ sharedMint: L.H.mint, words: OTHER_WORDS }, 500);
    const tries = L.card.state.tries;
    L.card.sent.length = 0;
    const cantTake = await O.W.cardWithdraw(L.card, { pin: '1234' }).then(() => null, (e) => e);
    ok(cantTake && cantTake.card === 'limit' && L.card.state.tries === tries && !ins(L.card).includes('40') && !ins(L.card).includes('20'),
       'a phone that does not hold the words cannot empty a card past its day: it is refused before the PIN is sent or anything is signed', cantTake && cantTake.message);
    ok(limit(L.card) === 600 && L.card.balance() > 0, 'and the card’s limit is as it was');

    // the owner's phone takes everything off, lifting the limit with its proof and putting it back, in one tap
    const onIt = L.card.balance(), hNow = await bal(L.H);
    L.card.tap();
    L.card.sent.length = 0;
    const all = await L.H.W.cardWithdraw(L.card, { pin: '1234' });
    ok(all.sats === onIt && L.card.balance() === 0 && (await bal(L.H)) === hNow + onIt,
       'the owner’s phone empties the card whatever the day has used', JSON.stringify({ got: all.sats, onIt }));
    const seq = ins(L.card);
    const lifted = seq.indexOf('34');
    ok(lifted > seq.indexOf('40') && lifted < seq.indexOf('22') && seq.lastIndexOf('34') > seq.lastIndexOf('24') && seq.filter((i) => i === '34').length === 2,
       'by lifting the limit after the PIN and before the payment is begun, and putting it back after the signature', seq.join(' '));
    ok(limit(L.card) === 600, 'the limit is what it was', String(limit(L.card)));
    ok(!JSON.parse(L.H.storage.getItem('foxy.flashcard.lifted') || '{}')[L.card.key], 'and nothing is left written down as lifted');

    // the same, with the spending failing part way, with the card still there
    L.card.tap();
    await L.H.W.cardAdd(L.card, { sats: 300, owner: true });
    L.card.tap();
    let nth = 0;
    // the signature comes back as one that is not the card's: the card is still there, and the limit is up
    const flaky = { send: (a) => L.card.send(a).then((r) => (a.slice(0, 4) === 'b024' && ++nth === 1 && r.length === 132 ? '00'.repeat(64) + '9000' : r)) };
    const broke = await L.H.W.cardWithdraw(flaky, { pin: '1234' }).then(() => null, (e) => e);
    ok(broke && nth >= 1 && limit(L.card) === 600, 'a withdrawal that fails after the limit was lifted puts it back: the card is not left with none', JSON.stringify({ err: broke && broke.card, limit: limit(L.card) }));

    // and with the card taken away before it can be: the next tap of this phone puts it back
    L.card.tap();
    await L.H.W.cardAdd(L.card, { sats: 200, owner: true });
    L.card.tap();
    L.card.leaveBefore('22', 1);
    const gone = await L.H.W.cardWithdraw(L.card, { pin: '1234' }).then(() => null, (e) => e);
    ok(gone && gone.card === 'gone' && limit(L.card) === 0, 'a card taken away while the limit was lifted is left with none', JSON.stringify({ err: gone && gone.card, limit: limit(L.card) }));
    ok(JSON.parse(L.H.storage.getItem('foxy.flashcard.lifted') || '{}')[L.card.key].limit === 600, 'and the phone had written down what it was');
    L.card.tap();
    const back = await L.H.W.cardLook(L.card, { mine: true });
    ok(limit(L.card) === 600 && back.restored === 600 && back.info.limit === 600 && !JSON.parse(L.H.storage.getItem('foxy.flashcard.lifted') || '{}')[L.card.key],
       'the next time this phone reads the card it puts the limit back, and forgets the note', JSON.stringify({ limit: limit(L.card) }));
    L.card.tap();
    const other = await O.W.cardLook(L.card, { mine: true });
    ok(other.restored === undefined, 'and a phone with other words puts nothing back');

    // adding funds: no PIN, no change to the day
    const dayBefore = { start: L.card.state.windowStart, spent: spent(L.card) };
    L.card.tap();
    await L.H.W.cardAdd(L.card, { sats: 100, owner: true });
    ok(limit(L.card) === 600 && spent(L.card) === dayBefore.spent && L.card.state.windowStart === dayBefore.start, 'money put on a card does not touch its day');
    L.card.tap();
    const noGrant = await O.W.cardAdd(L.card, { sats: 20, owner: true }).then(() => null, (e) => e);
    ok(noGrant && noGrant.card === 'not-owner' && O.W.cardOwed().length === 1, 'another phone cannot add funds as the owner: the card refuses, and what it made for the card waits', noGrant && noGrant.message);
    L.card.tap();
    const withPin = await O.W.cardWrite(L.card, { pin: '1234' });
    ok(withPin.left === 0 && O.W.cardOwed().length === 0, 'but with the card’s PIN it can write it: a PIN loads, as it always did');

    // renewed, the card has the limit it had
    L.card.tap();
    await L.H.W.cardSetLimit(L.card, { sats: 77 });
    L.card.tap();
    const renewed = await L.H.W.cardRenew(L.card, { pin: '1234' });
    ok(limit(L.card) === 77 && L.card.balance() >= 120, 'a card renewed has the limit it had, though its money was signed off and back on', JSON.stringify({ left: limit(L.card), card: L.card.balance() }));
    await settle();
  }
  /* ---- 13b: the limit on one payment beside the day's, lifted and put back by the owner -------------------------------
   * The limit on one payment refuses nothing: a payment over it waits (tests/flashcard-sigall.js, 8). What is held here is
   * that the owner's phone sets it beside the day's, in the one thirteen-byte command, and lifts both for a withdrawal and
   * puts both back, or leaves a note that its next reading acts on. */
  {
    const P = await world(0);
    const ins = (c) => c.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));
    await binaryLoad(P.H, P.card, 2000);            // 1024 512 256 128 64 16
    P.card.tap();
    const set = await P.H.W.cardSetLimit(P.card, { sats: 300, tap: true });
    ok(P.card.state.tapLimit === 300 && P.card.state.record.limit === 0 && set.tap && set.tap.known && set.tap.limited && set.tap.limit === 300 && set.tap.paced === true && !set.day.limited,
       'the owner’s phone sets a limit of 300 on one payment, with its proof and no PIN, and the card has no daily limit still', JSON.stringify(set.tap));
    P.card.tap();
    await P.H.W.cardSetLimit(P.card, { sats: 600 });
    ok(P.card.state.record.limit === 600 && P.card.state.tapLimit === 300, 'the daily limit is set beside it, and the limit on one payment is as it was');
    P.card.tap();
    const dayFirst = await P.R.W.cardPay(P.card, { sats: 700, pin: '1234' }).then(() => null, (e) => e);
    ok(dayFirst && dayFirst.card === 'limit', '700 is over the day: refused as over the day', dayFirst && dayFirst.card);

    // the owner's phone takes everything off: both limits are lifted for it with its proof, and both put back
    const onIt = P.card.balance(), hNow = await bal(P.H);
    P.card.tap();
    P.card.sent.length = 0;
    const all = await P.H.W.cardWithdraw(P.card, { pin: '1234' });
    const seq = ins(P.card);
    ok(all.sats === onIt && P.card.balance() === 0 && (await bal(P.H)) === hNow + onIt && seq.filter((i) => i === '34').length === 2
       && P.card.state.record.limit === 600 && P.card.state.tapLimit === 300 && !JSON.parse(P.H.storage.getItem('foxy.flashcard.lifted') || '{}')[P.card.key],
       'the owner’s phone empties the card whatever the limits: both lifted in one command and both put back in one, and nothing left written down as lifted',
       JSON.stringify({ got: all.sats, day: P.card.state.record.limit, tap: P.card.state.tapLimit, seq: seq.join(' ') }));

    // a tap that ends between the two leaves a note, and this phone's next reading of the card puts both back
    P.card.tap();
    await P.H.W.cardAdd(P.card, { sats: 300, owner: true });
    P.card.tap();
    let limits = 0;
    const cut = { tap: () => P.card.tap(), send: (a) => (a.slice(0, 4) === 'b034' && ++limits === 2 ? Promise.reject(Object.assign(new Error('the card left'), { gone: true })) : P.card.send(a)) };
    await P.H.W.cardWithdraw(cut, { pin: '1234' }).then(() => null, () => null);
    const note = JSON.parse(P.H.storage.getItem('foxy.flashcard.lifted') || '{}')[P.card.key];
    ok(P.card.state.record.limit === 0 && P.card.state.tapLimit === 0 && note && note.limit === 600 && note.tap === 300,
       'a withdrawal whose card left before the limits were put back leaves both written down', JSON.stringify(note));
    P.card.tap();
    const back = await P.H.W.cardLook(P.card, { mine: true });
    ok(P.card.state.record.limit === 600 && P.card.state.tapLimit === 300 && back.tap.limit === 300 && back.day.limit === 600
       && !JSON.parse(P.H.storage.getItem('foxy.flashcard.lifted') || '{}')[P.card.key],
       'and the next reading of the card by its owner’s phone puts both back', JSON.stringify({ day: P.card.state.record.limit, tap: P.card.state.tapLimit }));

    // removed
    P.card.tap();
    const off = await P.H.W.cardSetLimit(P.card, { sats: 0, tap: true });
    ok(P.card.state.tapLimit === 0 && P.card.state.record.limit === 600 && !off.tap.limited, 'a limit of nothing on one payment removes it, and leaves the day’s');
    await settle();
  }
  /* ---- 13c: the card's own log ----------------------------------------------------------
   * Kept by the card: a tap that puts money on it, a spend, and a spend it refuses for being over a limit, write it. The owner's
   * phone reads it with its proof and no PIN, and says what is new since it last looked. */
  {
    const G = await world(0);
    await binaryLoad(G.H, G.card, 2000);            // 1024 512 256 128 64 16
    const model = () => G.card.state.log;
    G.card.tap();
    const first = await G.H.W.cardLook(G.card, { mine: true });
    ok(first.log && first.log.sats === 0 && first.log.last.length >= 1 && first.log.last.some((x) => x.loaded === 2000 && x.sats === 0),
       'a card that has paid nothing has signed for nothing in its log: what was put on it is there, as a tap of its own', JSON.stringify(first.log.last));
    G.card.tap();
    const p1 = await G.R.W.cardPay(G.card, { sats: 500, pin: '1234' });
    if (p1.change && p1.change.sats > 0 && !p1.change.written) { G.card.tap(); await G.R.W.cardWrite(G.card, { change: true }); }
    G.card.tap();
    const asTill = await G.R.W.cardLook(G.card);
    ok(!asTill.log, 'a till, which is not the card’s owner, is not shown the log');
    G.card.tap();
    const second = await G.H.W.cardLook(G.card, { mine: true });
    const signed = model().sats;
    const payTap = second.log.last.filter((x) => x.sats > 0)[0] || {};
    ok(signed === 500 && second.log.sats === signed && payTap.sats === signed && payTap.pieces >= 1 && payTap.refused === 0 && payTap.tamper === false,
       'a payment is a tap in it: what left the card (the price, the card having made the change) and how many pieces', JSON.stringify(payTap));
    ok(second.log.since && second.log.since.sats === signed && second.log.since.taps >= 1 && second.log.since.refused === 0,
       'and the owner’s phone says what is new since it last looked', JSON.stringify(second.log.since));
    G.card.tap();
    const third = await G.H.W.cardLook(G.card, { mine: true });
    ok(third.log.since.taps === 0 && third.log.since.sats === 0, 'looked at again, nothing is new');

    // a terminal that has the PIN and asks for more than the day's limit, three times: each refused, and written down
    G.card.tap();
    await G.H.W.cardSetLimit(G.card, { sats: 100 });
    G.card.tap();
    const big = G.card.state.slots.findIndex((x) => x.status === 1 && parseInt(x.data.substr(16, 8), 16) > 100);
    const balBefore = G.card.balance();
    const said = [];
    said.push((await G.card.send('00a404000bf04341534855434152440100')).slice(-4));
    said.push((await G.card.send('b04000000431323334')).slice(-4));
    for (let i = 0; i < 3; i++) {
      await G.card.send('b0220000' + '01' + ('0' + big.toString(16)).slice(-2));
      said.push((await G.card.send('b024000040')).slice(-4));
    }
    ok(big >= 0 && said.join(' ') === '9000 9000 6a8f 6a8f 6a8f' && G.card.balance() === balBefore, 'the card refuses each of the three at its signature, and nothing is burned', said.join(' '));
    G.card.tap();
    const after = await G.H.W.cardLook(G.card, { mine: true });
    ok(after.log.refused === 3 && after.log.last[0].refused === 3 && after.log.last[0].sats === 0 && after.log.since.refused === 3,
       'the owner’s phone finds a tap of three refusals and nothing signed for', JSON.stringify(after.log.last[0]));
    ok(H.W.cardParse.log('0000000200000f1f0000000c00000002' + '6b49d26e00000064010200000000000000000000' + '6b49d20000000ebb0c0a0100000000006b49d200').last.length === 2
       && (() => { try { H.W.cardParse.log('00'); return false; } catch (e) { return true; } })(), 'and a log that is not one is not read as one');
    await settle();
  }
  /* ---- 14: a terminal with the PIN cannot write a piece twice ------------------------ */
  {
    // What a card signs for is a piece's secret, which its nonce makes; its amount is only what the day is charged. A
    // terminal that holds the PIN could write a copy of a large piece with an amount of 1, spend the copy for 1 and be
    // signed for the large piece. The card refuses a nonce that is already in a slot, and the model is held to that.
    const T = await world(0);
    await binaryLoad(T.H, T.card, 2000);
    T.card.tap();
    await T.H.W.cardSetLimit(T.card, { sats: 600 });
    const nonces = () => T.card.state.slots.filter((x) => x.status !== 0).map((x) => x.data.substr(24, 64));
    const distinct = () => new Set(nonces()).size === nonces().length;
    const big = T.card.state.slots.findIndex((x) => x.status === 1 && parseInt(x.data.substr(16, 8), 16) === 1024);
    const real = T.card.state.slots[big].data;
    ok(big >= 0 && T.card.state.spent === 0, 'a card with a piece of 1024 on it, and a limit of 600 a day: honestly, that piece cannot be spent');

    // the terminal: the PIN, then the piece it read, written back with an amount of 1
    T.card.tap();
    const pin = 'b0400000' + '04' + '31323334';
    const select = '00a404000bf04341534855434152440100';
    ok((await T.card.send(select)).slice(-4) === '9000' && (await T.card.send(pin)) === '9000', 'a terminal that has the PIN is let in');
    const copy = real.slice(0, 16) + '00000001' + real.slice(24);
    const slots = T.card.state.slots.map((x) => x.status).join('');
    ok((await T.card.send('b0300000' + '51' + copy + '01')) === '6a94', 'its copy of that piece, stating an amount of 1, is refused');
    ok((await T.card.send('b0300000' + '51' + real + '01')) === '6a94', 'and so is the piece itself, a second time');
    ok(T.card.state.slots.map((x) => x.status).join('') === slots && distinct() && T.card.state.spent === 0,
       'nothing was written, and nothing was counted against the day');

    // the phone pays from the card as it is: the pieces it picks are the card's own, charged what they are worth
    T.card.tap();
    const paid = await T.R.W.cardPay(T.card, { sats: 300, pin: '1234' });
    ok(paid.sats === 300 && T.card.state.spent >= 300 && T.card.state.spent <= 600 && distinct(),
       'a payment picks pieces the card holds once, and the day is charged what they are worth: more than the price, never a piece of 1', String(T.card.state.spent));
    ok(T.card.state.slots[big].status === 1 && T.card.state.slots[big].data === real && distinct(), 'the piece of 1024 is still there, once, unspent and unchanged');

    // the phone's own write, finding the card read stale: a piece that landed in the last tap is on it, and the card says so
    T.card.tap();
    const seen = await T.H.W.cardLook(T.card);
    await T.H.W.cardPrepare(seen, 40);
    ok(T.H.W.cardOwed().length === 1, 'pieces made for the card wait for it');
    T.card.tap();
    T.card.leaveBefore('30', 2);
    const cut = await why(T.H.W.cardWrite(T.card, { pin: '1234' }));
    ok(cut === 'gone' && T.H.W.cardOwed().length === 1, 'a card taken away after the first of them holds it, and the rest is owed', cut);
    const held = nonces().length;
    T.card.tap();
    // a read that sees nothing on the card: every place empty, in the page that lists them (and in the old way of listing them)
    const stale = { send: (a) => T.card.send(a).then((r) => (a.slice(0, 4) === 'b017' ? '809000' : a.slice(0, 4) === 'b014' ? '00'.repeat(128) + '9000' : r)) };
    const twice = await why(T.H.W.cardWrite(stale, { pin: '1234' }));
    ok(twice === 'went through' && nonces().length > held && distinct() && T.H.W.cardOwed().length === 0,
       'a write that does not see that piece is told by the card it is on it already, takes that as so, writes the rest, and nothing twice', twice);
    await settle();
  }
  {
    // the pieces to take, as near to the price as can be found, and never worth more than the limit
    const stub = { getFeesForProofs: (l) => l.length };      // a sat a piece
    const pool = [100, 70, 60, 50].map((n) => ({ amount: n, secret: 's' + n }));
    const sum = (l) => l.reduce((n, x) => n + x.amount, 0);
    const pick = (want, cap) => { const r = L0.cardPick(stub, pool, want, cap); return r ? sum(r) : null; };
    ok(pick(120, 130) === 130, 'with a limit that the ordinary choice goes over, the cheapest set under it is found: 70 and 60 for 120', String(pick(120, 130)));
    ok(pick(120, 129) === null, 'and none where nothing fits', String(pick(120, 129)));
    ok(pick(120, 1000) >= 122, 'with room, the ordinary choice stands', String(pick(120, 1000)));
    ok(pick(120, null) >= 122, 'and with no bound, as before', String(pick(120, null)));
  }

  console.log('\n' + (failed ? failed + ' flashcard-money check(s) failed' : 'all flashcard-money checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
