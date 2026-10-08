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
  ok(amounts(card).join('+') === '512+256+256+128+128+128+128+64+64+64+64+32+32+32+16+16+16+16+8+8+8+4+4+4+2+2+2+2+1+1+1+1',
     'cut like a cash drawer: every power of two to 512 once, the rest of the amount, and then two more of each of 1 to 128 with the places left', amounts(card).join('+'));
  const loadRow = history(H).filter((e) => e.dir === 'out')[0] || {};
  ok(loadRow.sats === 2000 && loadRow.memo === 'to card' && loadRow.card === card.key, 'with one entry, to the card', JSON.stringify({ sats: loadRow.sats, memo: loadRow.memo }));
  ok(H.W.cardOwed().length === 0, 'and nothing left owed to it');
  {
    const year = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const dates = added.card.pieces.map((x) => x.date);
    ok(dates.every((d) => Math.abs(d - year) < 600), 'each piece can be taken back by this phone a year from now', String(dates[0]));
    const known = (H.W.cardsKnown()[card.key] || {}).pieces || {};
    ok(Object.keys(known).length === 32 && added.card.pieces.every((x) => known[x.nonce] && known[x.nonce].amount === x.amount),
       'and the phone has written down what it put there', String(Object.keys(known).length));
  }

  /* ---- 4: paying a receiver, with change ---------------------------------- */
  {
    // a card cut the old way (the powers of two of 2,000 and no more), so that 1,000 has no exact set and needs change
    const H4 = await funded({ sharedMint: H.mint, words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' }, 4500);
    const R4 = await funded({ sharedMint: H.mint, words: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' }, 0);
    const c4 = newCard(H4);
    await H4.W.cardSetUp(c4, { pin: '1234', recoverable: true });
    await binaryLoad(H4, c4, 2000);
    ok(amounts(c4).join('+') === '1024+512+256+128+64+16', 'a card with no exact set for 1,000: 1024, 512, 256, 128, 64 and 16', amounts(c4).join('+'));
    c4.tap();
    const steps = [];
    const paid = await R4.W.cardPay(c4, { sats: 1000, pin: '1234', on: (s) => steps.push(s) });
    ok(paid.sats === 1000 && (await bal(R4)) === 1000, 'a card pays a receiver 1,000 sats', String(await bal(R4)));
    ok(steps.join(' ') === 'reading signing checking making done', 'the screen is told each step: the card is let go once it has signed, and the mint and the change are done after', steps.join(' '));
    ok(paid.change && paid.change.sats === 24 && paid.change.written === false && c4.balance() === 1000 - 24,
       'the 24 sats over are made into change, and wait for the card’s next tap: it has been let go', JSON.stringify(paid.change) + ', card ' + c4.balance());
    ok(R4.W.cardOwed().length === 1 && R4.W.cardOwed()[0].kind === 'change' && R4.W.cardOwed()[0].sats === 24 && R4.W.cardTaken().length === 0,
       'the receiver holds nothing of the card’s but that change, owed to it');
    const payRow = row(R4, paid.hash);
    ok(payRow.dir === 'in' && payRow.sats === 1000 && payRow.memo === 'card' && payRow.changeSats === 24 && payRow.changeState === 'not handed',
       'the receiver has one entry: 1,000 from a card, its change not yet handed over', JSON.stringify({ sats: payRow.sats, memo: payRow.memo, c: payRow.changeSats, state: payRow.changeState }));
    c4.tap();
    const given = await R4.W.cardWrite(c4, { pin: '1234' });
    ok(given.left === 0 && c4.balance() === 1000 && R4.W.cardOwed().length === 0 && row(R4, paid.hash).changeState === 'given back',
       'the next tap writes it, and the entry says given back', String(c4.balance()));
    // the change fills the drawer’s gaps: the card held 512, 256, 128, 64 and 16, so 24 comes as 1, 2, 4 and 8 (a drawer up to 16) and the 9 left,
    // and then the smallest rungs deepened with the places left: three of 1 and 2, then 4, 8, 2 and 1
    ok(amounts(c4).join('+') === '512+256+128+64+16+8+4+2+2+2+2+1+1+1+1', 'and it comes as the sizes the card lacked, not as 16 and 8', amounts(c4).join('+'));
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
  ok(over && over.card === 'limit' && over.left === 100 && over.need >= 300 && over.turns > 0, 'a payment the card’s daily limit cannot cover is refused, saying how much is left today', over && over.message);
  ok(!card.sent.some((a) => /^b0(40|20|44)/.test(a)), 'and the card was not sent its PIN, a nonce or a request to sign: it was told the time and read, and that is all', card.sent.map((a) => a.slice(0, 6)).join(' '));
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
    const owed = R.W.cardOwed();
    ok(owed.length === 1 && owed[0].kind === 'change' && owed[0].card === c7.key && owed[0].sats === 824
       && row(R, noChange.hash).changeState === 'not handed',
       'and its change is owed to it, said on the payment’s entry', JSON.stringify(owed.map((r) => [r.kind, r.sats])));
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
    await binaryLoad(H, c8, 1536);
    c8.tap();
    const rBefore = await bal(R);
    c8.leaveBefore('20', 2);
    const half = await R.W.cardPay(c8, { sats: 1535, pin: '1234' }).then(() => null, (e) => e);
    ok(half && half.card === 'interrupted' && half.resumable === true && (await bal(R)) === rBefore, 'a card taken away between two signatures has paid nothing yet', half && half.message);
    const held = R.W.cardHeldPayment(c8.key);
    ok(held && held.held === 1024 && held.want === 1535 && held.fresh && R.W.cardOwed().length === 0,
       'what it had signed for is held for this payment: not given back, so nothing waits to be written to the card', JSON.stringify(held));
    ok(c8.balance() === 512, 'the card holds only the piece it had not signed for');
    // the next tap, for the same payment, signs only the rest
    c8.tap();
    c8.sent.length = 0;
    const then = await R.W.cardPay(c8, { sats: 1535, pin: '1234' });
    const signedNow = c8.sent.filter((x) => /^b020/.test(x)).length;
    ok(then.sats === 1535 && signedNow === 1 && !R.W.cardHeldPayment(c8.key) && R.W.cardTaken().length === 0 && (await bal(R)) >= rBefore + 1535 && (await bal(R)) <= rBefore + 1536,
       'the next tap for the same payment signs only the piece it had not, and the payment is made with both', signedNow + ' signed, ' + ((await bal(R)) - rBefore) + ' received');
    ok(c8.balance() + R.W.cardOwed().filter((r) => r.card === c8.key).reduce((n, r) => n + r.sats, 0) <= 1, 'and the card has paid it once: nothing put back, nothing lost', String(c8.balance()));
  }

  /* ---- 8b: a payment left part way through, and what becomes of it ----------- */
  {
    // a phone of its own to load the cards, at the same mint as the till
    const L = await funded({ sharedMint: R.mint, words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' }, 12000);
    const fresh = async (sats) => { const c = newCard(L); await L.W.cardSetUp(c, { pin: '1234' }); await binaryLoad(L, c, sats); return c; };
    const cut = async (c, sats, nth) => { c.tap(); c.leaveBefore('20', nth || 2); return R.W.cardPay(c, { sats, pin: '1234' }).then(() => null, (e) => e); };

    // another amount from the same card: a payment of its own, and the one left part way through is given back as it ends
    const a = await fresh(1536);
    await cut(a, 1535);
    a.tap();
    const other = await R.W.cardPay(a, { sats: 300, pin: '1234' });
    const owedA = R.W.cardOwed().filter((r) => r.card === a.key);
    ok(other.sats === 300 && other.letGo && other.letGo.made && !R.W.cardHeldPayment(a.key)
       && owedA.some((r) => r.kind === 'refund' && r.sats === 1024) && owedA.some((r) => r.kind === 'change'),
       'another amount from the same card is a payment of its own, and the one left part way through goes back as it ends', JSON.stringify({ letGo: other.letGo, owed: owedA.map((r) => [r.kind, r.sats]) }));
    a.tap();
    await R.W.cardWrite(a, { change: true });
    ok(a.balance() === 1536 - 300 && R.W.cardOwed().filter((r) => r.card === a.key).length === 0,
       'and the one tap after it puts back both its change and what the first had signed', String(a.balance()));

    // nobody comes back: three minutes on, the next settling gives it back
    const b = await fresh(1536);
    await cut(b, 1535);
    const settledEarly = await R.W.cardSettle();
    ok(!!R.W.cardHeldPayment(b.key) && settledEarly.some((x) => x.state === 'held'), 'a fresh one is left alone by the settling', JSON.stringify(settledEarly));
    const real = R.window.Date.now.bind(R.window.Date);
    R.window.Date.now = () => real() + 4 * 60 * 1000;
    const settled = await R.W.cardSettle();
    R.window.Date.now = real;
    ok(!R.W.cardHeldPayment(b.key) && settled.some((x) => x.state === 'released' && x.made) && R.W.cardOwed().some((r) => r.card === b.key && r.kind === 'refund' && r.sats === 1024),
       'one nobody came back for is given back at the first settling after three minutes: owed to the card', JSON.stringify(settled));
    b.tap();
    await R.W.cardWrite(b, { change: true });
    ok(b.balance() === 1536, 'and its next tap puts it back', String(b.balance()));

    // cut short twice: the second tap signs some more, the third the rest
    const d = await fresh(1536 + 256);
    const firstCut = await cut(d, 1791, 2);
    ok(firstCut && firstCut.resumable && R.W.cardHeldPayment(d.key).held === 1024, 'cut short once', JSON.stringify(R.W.cardHeldPayment(d.key)));
    const secondCut = await cut(d, 1791, 2);
    ok(secondCut && secondCut.resumable && R.W.cardHeldPayment(d.key).held === 1024 + 512, 'cut short again: what it signed this time is held with the rest', JSON.stringify(R.W.cardHeldPayment(d.key)));
    d.tap();
    const done = await R.W.cardPay(d, { sats: 1791, pin: '1234' });
    ok(done.sats === 1791 && !R.W.cardHeldPayment(d.key) && d.balance() + R.W.cardOwed().filter((r) => r.card === d.key).reduce((n, r) => n + r.sats, 0) <= 1,
       'and the third tap finishes it, the card having paid it once', String(d.balance()));

    // and offline, taken on trust: the next tap signs the rest of the exact set, and the whole is kept on trust
    const e = await fresh(1536);
    R.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    e.tap();
    e.leaveBefore('20', 2);
    const offCut = await R.W.cardPay(e, { sats: 1536, pin: '1234', trusted: true }).then(() => null, (x) => x);
    ok(offCut && offCut.resumable && R.W.cardHeldPayment(e.key) && R.W.cardHeldPayment(e.key).held === 1024, 'offline, a payment taken on trust is held the same way', JSON.stringify(offCut && { card: offCut.card, held: R.W.cardHeldPayment(e.key) }));
    e.tap();
    const offDone = await R.W.cardPay(e, { sats: 1536, pin: '1234', trusted: true });
    R.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    ok(offDone.trusted === true && offDone.sats === 1536 && !R.W.cardHeldPayment(e.key) && e.balance() === 0,
       'and the next tap signs the rest of the exact set, kept on trust as one payment', JSON.stringify(offDone));
    await settle();
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
    ok(F.card.balance() > 0 && F.card.balance() <= held - 1000 + 4 && F.card.balance() >= held - 1000 - 10, 'and the card holds the rest', F.card.balance() + ' of ' + held);
  }

  /* ---- 13: the daily limit ------------------------------------------------------- */
  {
    // a card of its own, with pieces of 1024, 512, 256, 128, 64 and 16, and a limit that is set at each step
    const L = await world(0);
    // both phones tell the card the time from one clock, which a day is moved on by
    const clock = { ms: Date.now() };
    L.H.phone.clockMs = () => clock.ms;
    L.R.phone.clockMs = () => clock.ms;
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
    ok(ins(T0).slice(ins(T0).indexOf('35')).join(' ').indexOf('35') === 0 && ins(T0).indexOf('45') > ins(T0).indexOf('44') && ins(T0).indexOf('30') > ins(T0).indexOf('45'),
       'it tells the card the time, asks for a nonce, is allowed to load, and loads, in that order', ins(T0).join(' '));
    // and the card for the limit is cut the old way, so its pieces are large (1024, 512, 256, 128, 64 and 16): a day is charged what they are worth
    const loaded = await binaryLoad(L.H, L.card, 2000);
    ok(loaded.sats === 2000 && L.card.balance() === 2000, 'a card of its own with 2,000 sats on it, in large pieces');
    L.card.tap();
    await L.H.W.cardSetLimit(L.card, { sats: 600 });
    ok(limit(L.card) === 600 && spent(L.card) === 0, 'the limit is set to 600 a day');

    // pieces as near the price as there are, and the day is charged what they are worth
    L.card.tap();
    const paid = await L.R.W.cardPay(L.card, { sats: 300, pin: '1234' });
    ok(paid.sats === 300 && spent(L.card) === 320 && limit(L.card) === 600,
       'a payment of 300 is made with pieces worth 320, the nearest cover there is, and the day is charged 320 and not 300', JSON.stringify({ spent: spent(L.card) }));
    ok(paid.change && paid.change.sats === 20 && paid.change.written === false && L.card.balance() === 2000 - 320 && spent(L.card) === 320,
       'the card has been let go, and its change waits for its next tap', JSON.stringify({ spent: spent(L.card), card: L.card.balance() }));
    L.card.tap();
    await L.R.W.cardWrite(L.card, { pin: '1234' });
    ok(L.card.balance() === 2000 - 300 && spent(L.card) === 320,
       'the change that goes back on the card gives the day nothing back', JSON.stringify({ spent: spent(L.card), card: L.card.balance() }));
    L.card.tap();
    L.card.sent.length = 0;
    const next = await L.R.W.cardPay(L.card, { sats: 300, pin: '1234' }).then(() => null, (e) => e);
    const start = L.card.state.windowStart;
    ok(next && next.card === 'limit' && next.left === 280 && next.turns === start + 86400 && /280 sats/.test(next.message),
       'a second payment of 300 is more than the 280 left today, and is refused, saying when the day turns', next && next.message);
    ok(!ins(L.card).includes('40') && !ins(L.card).includes('20'), 'before the PIN is sent or anything is signed');
    L.card.tap();
    const tooBig = await L.R.W.cardPay(L.card, { sats: 200, pin: '1234' }).then(() => null, (e) => e);
    ok(tooBig && tooBig.card === 'limit', 'nor can one of 200: the card’s pieces are large, and what is signed for is charged whole', tooBig && tooBig.message);
    L.card.tap();
    const small = await L.R.W.cardPay(L.card, { sats: 150, pin: '1234' });
    // no two pieces under the 280 left cover 150; three do (128, 16 and 8, from the change cut to fill the card's gaps), where exactly 150 is four
    ok(small.sats === 150 && spent(L.card) === 472, 'one of 150 goes, with the fewest pieces that cover it: three, worth 152, from the change that came back cut to fill the card’s gaps', String(spent(L.card)));

    // the card reads its own day for the screens
    L.card.tap();
    const day = (await L.H.W.cardLook(L.card)).day;
    ok(day.limited && day.limit === 600 && day.spent === 472 && day.left === 128 && day.turns === start + 86400, 'the card’s day reads as 128 left, turning a day after it began', JSON.stringify(day));

    // a till that sends the PIN again and again is held to the day by the card, and a day later it is a new day
    clock.ms += 86399 * 1000;
    L.card.tap();
    const still = await L.R.W.cardPay(L.card, { sats: 300, pin: '1234' }).then(() => null, (e) => e);
    ok(still && still.card === 'limit' && still.left === 128, 'a second short of a day on, it is the same day', still && still.message);
    clock.ms += 1000;
    L.card.tap();
    const turned = await L.R.W.cardPay(L.card, { sats: 300, pin: '1234' });
    ok(turned.sats === 300 && L.card.state.windowStart === Math.floor(clock.ms / 1000) && spent(L.card) >= 300 && spent(L.card) <= 600,
       'at 86,400 seconds it is a new day: the same payment goes, a new day begins, and only this payment is in it', JSON.stringify({ start: L.card.state.windowStart, spent: spent(L.card) }));

    // a phone that does not hold the words is a till like any other: it cannot take what is past the day
    L.card.tap();
    const O = await funded({ sharedMint: L.H.mint, words: OTHER_WORDS }, 500);
    O.phone.clockMs = () => clock.ms;
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
    ok(lifted > seq.indexOf('40') && lifted < seq.indexOf('20') && seq.lastIndexOf('34') > seq.lastIndexOf('20') && seq.filter((i) => i === '34').length === 2,
       'by lifting the limit after the PIN and before the first piece, and putting it back after the last', seq.join(' '));
    ok(limit(L.card) === 600, 'the limit is what it was', String(limit(L.card)));
    ok(!JSON.parse(L.H.storage.getItem('foxy.flashcard.lifted') || '{}')[L.card.key], 'and nothing is left written down as lifted');

    // the same, with the spending failing part way, with the card still there
    L.card.tap();
    await L.H.W.cardAdd(L.card, { sats: 300, owner: true });
    L.card.tap();
    let nth = 0;
    // the second piece comes back with a signature that is not the card's: the card is still there, and the limit is up
    const flaky = { send: (a) => L.card.send(a).then((r) => (a.slice(0, 4) === 'b020' && ++nth === 2 ? '00'.repeat(64) + '9000' : r)) };
    const broke = await L.H.W.cardWithdraw(flaky, { pin: '1234' }).then(() => null, (e) => e);
    ok(broke && nth > 1 && limit(L.card) === 600, 'a withdrawal that fails after the limit was lifted puts it back: the card is not left with none', JSON.stringify({ err: broke && broke.card, limit: limit(L.card) }));

    // and with the card taken away before it can be: the next tap of this phone puts it back
    L.card.tap();
    await L.H.W.cardAdd(L.card, { sats: 200, owner: true });
    L.card.tap();
    L.card.leaveBefore('20', 1);
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
  /* ---- 14: a terminal with the PIN cannot write a piece twice ------------------------ */
  {
    // What a card signs for is a piece's secret, which its nonce makes; its amount is only what the day is charged. A
    // terminal that holds the PIN could write a copy of a large piece with an amount of 1, spend the copy for 1 and be
    // signed for the large piece. The card refuses a nonce that is already in a slot, and the model is held to that.
    const T = await world(0);
    const clock = { ms: Date.now() };
    T.H.phone.clockMs = () => clock.ms;
    T.R.phone.clockMs = () => clock.ms;
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
    const select = '00a4040009f0464f58594341524400';
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
    const stale = { send: (a) => T.card.send(a).then((r) => (a.slice(0, 4) === 'b017' ? '409000' : a.slice(0, 4) === 'b014' ? '00'.repeat(64) + '9000' : r)) };
    const twice = await why(T.H.W.cardWrite(stale, { pin: '1234' }));
    ok(twice === 'on-card' && nonces().length === held && distinct() && T.H.W.cardOwed().length === 1,
       'a write that does not see that piece is told it is on the card already, writes nothing twice, and still owes the rest', twice);
    T.card.tap();
    const fin = await T.H.W.cardWrite(T.card, { pin: '1234' });
    ok(fin.left === 0 && T.H.W.cardOwed().length === 0 && distinct(), 'and the next tap, which sees it, writes the rest');
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
