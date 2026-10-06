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
const { funded, newCard, why, history, settle, MINT, OTHER_WORDS } = require('./flashcard-kit');

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

(async () => {
  /* ---- 1: onto the card -------------------------------------------------- */
  const { H, R, card } = await world(0);
  const before = await bal(H);
  const added = await H.W.cardAdd(card, { sats: 2000, pin: '1234' });
  ok(added.sats === 2000 && added.left === 0 && added.card.balance === 2000 && card.balance() === 2000,
     '2,000 sats are put on a card', JSON.stringify({ sats: added.sats, card: card.balance() }));
  ok((await bal(H)) === before - 2000, 'and are out of the phone', (await bal(H)) + ' of ' + before);
  ok(amounts(card).join('+') === '1024+512+256+128+64+16', 'as a piece for each power of two in the amount', amounts(card).join('+'));
  const loadRow = history(H).filter((e) => e.dir === 'out')[0] || {};
  ok(loadRow.sats === 2000 && loadRow.memo === 'to card' && loadRow.card === card.key, 'with one entry, to the card', JSON.stringify({ sats: loadRow.sats, memo: loadRow.memo }));
  ok(H.W.cardOwed().length === 0, 'and nothing left owed to it');
  {
    const year = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const dates = added.card.pieces.map((x) => x.date);
    ok(dates.every((d) => Math.abs(d - year) < 600), 'each piece can be taken back by this phone a year from now', String(dates[0]));
    const known = (H.W.cardsKnown()[card.key] || {}).pieces || {};
    ok(Object.keys(known).length === 6 && added.card.pieces.every((x) => known[x.nonce] && known[x.nonce].amount === x.amount),
       'and the phone has written down what it put there', String(Object.keys(known).length));
  }

  /* ---- 4: paying a receiver, with change ---------------------------------- */
  card.tap();
  const steps = [];
  const paid = await R.W.cardPay(card, { sats: 1000, pin: '1234', on: (s) => steps.push(s) });
  ok(paid.sats === 1000 && (await bal(R)) === 1000, 'a card pays a receiver 1,000 sats', String(await bal(R)));
  ok(paid.change && paid.change.sats === 24 && paid.change.written === true && card.balance() === 2000 - 1000,
     'the 24 sats over go back on the card in the same tap', JSON.stringify(paid.change) + ', card ' + card.balance());
  ok(steps.join(' ') === 'reading signing mint change done', 'the screen is told each step', steps.join(' '));
  const payRow = row(R, paid.hash);
  ok(payRow.dir === 'in' && payRow.sats === 1000 && payRow.memo === 'card' && payRow.changeSats === 24 && payRow.changeState === 'given back',
     'the receiver has one entry: 1,000 from a card, its change given back', JSON.stringify({ sats: payRow.sats, memo: payRow.memo, c: payRow.changeSats, state: payRow.changeState }));
  ok(R.W.cardTaken().length === 0 && R.W.cardOwed().length === 0, 'and holds nothing of the card’s');

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

  /* ---- 3: the card taken away mid-write ----------------------------------- */
  card.tap();
  card.leaveBefore('30', 2);       // the second piece is not written
  const cut = await H.W.cardAdd(card, { sats: 48, pin: '1234' }).then((r) => r, (e) => ({ why: e.card || e.message }));
  ok(cut.why === 'gone' && H.W.cardOwed().length === 1 && card.balance() === onCardBefore + 300 + 32,
     'a card taken away between two pieces holds the first, and the phone still owes it the rest', JSON.stringify({ why: cut.why, card: card.balance() }));
  card.tap();
  const fin = await H.W.cardWrite(card, { pin: '1234' });
  ok(fin.left === 0 && card.balance() === onCardBefore + 348 && H.W.cardOwed().length === 0, 'the next tap writes what was left', String(card.balance()));
  ok(card.balance() === onCardBefore + 348 && amounts(card).length === piecesBefore + 6, 'and the piece already there is not written twice: six pieces for 300 and 48, and no more', amounts(card).join('+'));
  ok((await bal(H)) === hBefore23 - 348, 'the phone is out exactly what it put on the card');

  /* ---- 5: exact pieces need no change -------------------------------------- */
  card.tap();
  const exact = await R.W.cardPay(card, { sats: 512, pin: '1234' });
  ok(exact.change === null && (await bal(R)) === 1512 && card.balance() === 1348 - 512, 'a payment the card has the pieces for needs no change', String(card.balance()));

  /* ---- 6: refused with nothing signed -------------------------------------- */
  const spentBefore = card.state.slots.filter((x) => x.status === 2).length;
  card.tap();
  const wrongPin = await R.W.cardPay(card, { sats: 100, pin: '0000' }).then(() => null, (e) => e);
  ok(wrongPin && wrongPin.card === 'wrong-pin' && wrongPin.tries === 2, 'a wrong PIN pays nothing and says how many tries are left', wrongPin && wrongPin.message);
  card.tap();
  const tooMuch = await R.W.cardPay(card, { sats: 50000, pin: '1234' }).then(() => null, (e) => e);
  ok(tooMuch && tooMuch.card === 'not-enough' && tooMuch.balance === card.balance(), 'more than the card holds is refused, saying what it holds', tooMuch && tooMuch.message);
  card.tap();
  await H.W.cardSetLimit(card, { pin: '1234', sats: 100 });
  card.tap();
  const over = await R.W.cardPay(card, { sats: 300, pin: '1234' }).then(() => null, (e) => e);
  ok(over && over.card === 'over-limit' && over.limit === 100, 'more than the card’s limit is refused before the card is asked to sign', over && over.message);
  card.tap();
  await H.W.cardSetLimit(card, { pin: '1234', sats: 0 });
  ok(card.state.slots.filter((x) => x.status === 2).length === spentBefore && (await bal(R)) === 1512 && card.state.tries === 3,
     'none of those burned a piece or moved a sat');
  {
    const away = await funded({ words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above', mint: 'https://other.test' }, 0);
    card.tap();
    const other = await away.W.cardPay(card, { sats: 10, pin: '1234' }).then(() => null, (e) => e);
    ok(other && other.card === 'other-mint' && /m\.test/.test(other.message) && /other\.test/.test(other.message),
       'a receiver at another mint refuses the card and names both mints', other && other.message);
  }

  /* ---- 7: the card leaves before its change is written --------------------- */
  {
    // a card with one piece, so any payment from it needs change
    const c7 = newCard(H);
    await H.W.cardSetUp(c7, { pin: '1234', recoverable: true });
    c7.tap();
    await H.W.cardAdd(c7, { sats: 1024, pin: '1234' });
    c7.tap();
    const rBefore = await bal(R);
    c7.leaveBefore('30', 1);
    const noChange = await R.W.cardPay(c7, { sats: 200, pin: '1234' });
    ok(noChange.sats === 200 && (await bal(R)) === rBefore + 200 && noChange.change && noChange.change.sats === 824 && noChange.change.written === false,
       'a card taken away after it signed has still paid', JSON.stringify(noChange.change));
    const owed = R.W.cardOwed();
    ok(owed.length === 1 && owed[0].kind === 'change' && owed[0].card === c7.key && owed[0].sats === 824
       && row(R, noChange.hash).changeState === 'not handed',
       'and its change is owed to it, said on the payment\u2019s entry', JSON.stringify(owed.map((r) => [r.kind, r.sats])));
    ok(c7.balance() === 0, 'the card holds nothing until then', String(c7.balance()));
    c7.tap();
    ok((await why(R.W.cardWrite(c7, { pin: '0000' }))) === 'wrong-pin' && R.W.cardOwed().length === 1, 'tapped again with a wrong PIN, the change goes on waiting');
    c7.tap();
    const back = await R.W.cardWrite(c7, { pin: '1234' });
    ok(back.left === 0 && c7.balance() === 824 && R.W.cardOwed().length === 0 && row(R, noChange.hash).changeState === 'given back',
       'tapped again with the PIN, the change is on the card and the entry says given back', String(c7.balance()));
    ok((await bal(R)) === rBefore + 200, 'the receiver kept exactly what it was paid');
  }

  /* ---- 8: the card leaves while it is signing ------------------------------ */
  {
    // two pieces, and a payment that needs both
    const c8 = newCard(H);
    await H.W.cardSetUp(c8, { pin: '1234', recoverable: true });
    c8.tap();
    await H.W.cardAdd(c8, { sats: 1536, pin: '1234' });
    c8.tap();
    const rBefore = await bal(R);
    c8.leaveBefore('20', 2);
    const half = await R.W.cardPay(c8, { sats: 1535, pin: '1234' }).then(() => null, (e) => e);
    ok(half && half.card === 'interrupted' && (await bal(R)) === rBefore, 'a card taken away between two signatures has paid nothing', half && half.message);
    const refund = R.W.cardOwed();
    ok(refund.length === 1 && refund[0].kind === 'refund' && refund[0].sats === 1024 && R.W.cardTaken().length === 0,
       'what it had signed for is on its way back to it, not kept', JSON.stringify(refund.map((r) => [r.kind, r.sats])));
    ok(c8.balance() === 512, 'the card holds only the piece it had not signed for');
    c8.tap();
    await R.W.cardWrite(c8, { pin: '1234' });
    ok(c8.balance() === 1536 && R.W.cardOwed().length === 0 && (await bal(R)) === rBefore, 'and the next tap puts it back: the card holds what it did, and the receiver nothing of it', String(c8.balance()));
    c8.tap();
    const then = await R.W.cardPay(c8, { sats: 1535, pin: '1234' });
    ok(then.sats === 1535 && (await bal(R)) === rBefore + 1535, 'after which it pays as it meant to');
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
    const p = await F.R.W.cardPay(F.card, { sats: 1000, pin: '1234' });
    ok(p.sats === 1000 && (await bal(F.R)) >= 1000 - 2 && (await bal(F.R)) <= 1000, 'a receiver is paid 1,000 from it, less only what making change cost', String(await bal(F.R)));
    ok(row(F.R, p.hash).sats === (await bal(F.R)) && F.R.W.cardOwed().length === 0 && F.R.W.cardTaken().length === 0,
       'its entry says exactly what it holds, and nothing of the card\u2019s is left with it', JSON.stringify({ sats: row(F.R, p.hash).sats, holds: await bal(F.R) }));
    ok(F.card.balance() > 0 && F.card.balance() < 2008 - 1000, 'and the card has its change, less what the mint took for it', String(F.card.balance()));
  }

  console.log('\n' + (failed ? failed + ' flashcard-money check(s) failed' : 'all flashcard-money checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
