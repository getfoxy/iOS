'use strict';
/* flashcard-sigall.js — a card that signs once for a payment (format 4).
 *
 *     node tests/flashcard-sigall.js
 *
 * The card before it signed for each piece, most of a second apiece. This one
 * signs once, over every piece and every output of the swap they are spent
 * in (NUT-11 SIG_ALL), so the swap is set out before the card is asked and is
 * the only swap the mint will take the signature for. The test mint holds the
 * rule as CDK and Nutshell do (tests/harness.js); the card is the model, held
 * to the applet's own answers (tests/flashcard-model.js).
 *
 * As every suite that drives the real wallet does, this one ends by asking
 * whether each phone's entries account for what it holds.
 */
const { funded, binaryLoad, why, history, settle, OTHER_WORDS, PHONE_WORDS } = require('./flashcard-kit');
const { makeCard } = require('./flashcard-card');
const { appOn, until, pad, stage, card: uiCard } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const card4 = (ctx) => makeCard({ window: ctx.window, format: 4 });
const amounts = (card) => card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(16, 8), 16)).sort((a, b) => b - a);
const dates = (card) => Array.from(new Set(card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(154, 8), 16))));
const count = (card, ins) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + ins).length;
const swaps = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.swaps') || '[]');
const WORDS3 = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const WORDS4 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
function later(c, ms) {
  const real = c.window.Date.now.bind(c.window.Date);
  c.window.Date.now = () => real() + ms;
  return () => { c.window.Date.now = real; };
}
const DAY = 24 * 3600 * 1000;

async function world(feePpk, sats) {
  const H = await funded({ feePpk }, sats || 9000);
  const R = await funded({ feePpk, sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = card4(H);
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  return { H, R, card };
}

(async () => {
  /* ---- 1: onto the card, written the card's way -------------------------- */
  const { H, R, card } = await world(0);
  const seen = await H.W.cardLook(card);
  ok(seen.info.format === 4 && seen.info.version === '1.5' && seen.info.paced === true, 'a card that signs once for a payment is read as what it is', seen.info.version + ', format ' + seen.info.format);
  card.tap();
  const added = await H.W.cardAdd(card, { sats: 2000, pin: '1234' });
  ok(added.sats === 2000 && card.balance() === 2000, '2,000 sats are put on it', String(card.balance()));
  ok(card.state.slots.filter((x) => x.status === 1).every((x, i) => /\["sigflag","SIG_ALL"\]\]\}\]$/.test(card.secretOf(card.state.slots.indexOf(x)))),
     'and every piece on it is written with the flag that makes one signature do for all of them');
  ok(dates(card).length === 1, 'all of one date', JSON.stringify(dates(card)));

  /* ---- 2: a payment is one signature, and exact where the card can make it -- */
  {
    card.tap();
    card.sent.length = 0;
    const steps = [];
    const paid = await R.W.cardPay(card, { sats: 1000, pin: '1234', on: (s) => steps.push(s) });
    ok(paid.sats === 1000 && (await bal(R)) === 1000 && card.balance() === 1000, 'the card pays a receiver 1,000 sats', (await bal(R)) + ', card ' + card.balance());
    ok(count(card, '24') === 1 && count(card, '22') === 1 && count(card, '20') === 0,
       'with ONE signature, whatever the number of pieces', count(card, '24') + ' signature(s) for ' + (32 - amounts(card).length) + ' pieces');
    ok(paid.change === null && R.W.cardOwed().length === 0, 'made of pieces that come to exactly the price: no change, and no second tap', JSON.stringify(paid.change));
    ok(steps.join(' ') === 'reading signing checking done', 'the screen is told each step', steps.join(' '));
    ok(R.W.cardTaken().length === 0 && swaps(R).length === 0, 'and nothing of it is left on file once the mint has swapped it', JSON.stringify(swaps(R)));
    const e = history(R).filter((x) => x.hash === paid.hash)[0] || {};
    ok(e.dir === 'in' && e.sats === 1000 && e.card === card.key, 'with one entry, of 1,000, that names the card', JSON.stringify({ sats: e.sats, memo: e.memo }));
  }

  /* ---- 3: a price it cannot make exactly: one signature, and change ------- */
  {
    const H3 = await funded({ sharedMint: H.mint, words: WORDS3 }, 4500);
    const R3 = await funded({ sharedMint: H.mint, words: WORDS4 }, 0);
    const c3 = card4(H3);
    await H3.W.cardSetUp(c3, { pin: '1234', recoverable: true });
    await binaryLoad(H3, c3, 2000);
    ok(amounts(c3).join('+') === '1024+512+256+128+64+16', 'a card with no exact set for 1,000', amounts(c3).join('+'));
    c3.tap();
    c3.sent.length = 0;
    const paid = await R3.W.cardPay(c3, { sats: 1000, pin: '1234' });
    ok(paid.sats === 1000 && (await bal(R3)) === 1000 && count(c3, '24') === 1, 'pays 1,000 with one signature', (await bal(R3)) + ', ' + count(c3, '24') + ' signature');
    ok(paid.change && paid.change.sats > 0 && paid.change.written === false && R3.W.cardOwed().length === 1,
       'and what its pieces came to over the price is made into change, owed to it', JSON.stringify(paid.change));
    const owed = paid.change.sats;
    c3.tap();
    const back = await R3.W.cardWrite(c3, { pin: '1234' });
    ok(back.left === 0 && c3.balance() === 2000 - 1000 && R3.W.cardOwed().length === 0, 'which its next tap writes back onto it', c3.balance() + ' on the card, ' + owed + ' written');
    ok(dates(c3).length === 1, 'with the date of the pieces it paid with, so the card is still of one date', JSON.stringify(dates(c3)));
    // and the change is money the card can sign for: the whole card, change and all, pays
    c3.tap();
    c3.sent.length = 0;
    const rest = await R3.W.cardPay(c3, { sats: 1000, pin: '1234' });
    ok(rest.sats === 1000 && (await bal(R3)) === 2000 && c3.balance() === 0 && count(c3, '24') === 1,
       'and the change is spent with the rest, in one signature again', (await bal(R3)) + ', card ' + c3.balance());
    await settle();
  }

  /* ---- 4: a mint that charges for every piece ----------------------------- */
  {
    const F = await world(1000, 9000);
    F.card.tap();
    await F.H.W.cardAdd(F.card, { sats: 2000, pin: '1234' });
    const on = F.card.balance();
    F.card.tap();
    F.card.sent.length = 0;
    const paid = await F.R.W.cardPay(F.card, { sats: 700, pin: '1234' });
    const fee = on - F.card.balance() - 700 - ((paid.change && paid.change.sats) || 0);
    ok(paid.sats === 700 && (await bal(F.R)) >= 700 && count(F.card, '24') === 1,
       'at a mint with a fee on every piece, the card pays the price and the fee on its pieces', JSON.stringify({ off: on - F.card.balance(), fee, change: paid.change }));
    await settle();
  }

  /* ---- 5: a top-up keeps the card's date ---------------------------------- */
  {
    const undo = later(H, 40 * DAY);
    card.tap();
    await H.W.cardAdd(card, { sats: 1500, pin: '1234' });
    undo();
    ok(card.balance() === 2500 && dates(card).length === 1, 'money put on forty days later takes the date the card already has', JSON.stringify(dates(card)));
    card.tap();
    card.sent.length = 0;
    const before = await bal(R);
    const paid = await R.W.cardPay(card, { sats: 2300, pin: '1234' });
    ok(paid.sats === 2300 && (await bal(R)) === before + 2300 && count(card, '24') === 1,
       'so a payment of both loads together is still one signature', (await bal(R)) - before + ' paid, card ' + card.balance());
    if (paid.change && paid.change.sats) { card.tap(); await R.W.cardWrite(card, { pin: '1234' }); }
    await settle();
  }

  /* ---- 6: two dates: one payment is of one date's pieces ------------------- */
  {
    const T = await world(0, 9000);
    T.card.tap();
    await T.H.W.cardAdd(T.card, { sats: 600, pin: '1234' });
    const undo = later(T.H, 300 * DAY);
    T.card.tap();
    await T.H.W.cardAdd(T.card, { sats: 500, pin: '1234' });
    undo();
    ok(dates(T.card).length === 2, 'a card topped up near the end of its year has pieces of two dates', JSON.stringify(dates(T.card)));
    T.card.tap();
    T.card.sent.length = 0;
    const e = await T.R.W.cardPay(T.card, { sats: 900, pin: '1234' }).then(() => null, (x) => x);
    ok(e && e.card === 'two-dates' && e.most === 600 && count(T.card, '40') === 0 && T.card.balance() === 1100,
       'a price neither date covers alone is refused before the PIN, and the most it can pay at once is said', e && (e.card + ': ' + e.message));
    T.card.tap();
    T.card.sent.length = 0;
    const a = await T.R.W.cardPay(T.card, { sats: 600, pin: '1234' });
    T.card.tap();
    const b = await T.R.W.cardPay(T.card, { sats: 300, pin: '1234' });
    ok(a.sats === 600 && b.sats === 300 && (await bal(T.R)) === 900, 'and it is taken in two parts, a signature each', String(await bal(T.R)));
    // the holder's own phone takes a whole card off in as many signatures as it has dates
    if (b.change && b.change.sats) { T.card.tap(); await T.R.W.cardWrite(T.card, { pin: '1234' }); }
    // topped up again when what is on it is nearly at its date: a second date once more
    const undo2 = later(T.H, 640 * DAY);
    T.card.tap();
    await T.H.W.cardAdd(T.card, { sats: 400, pin: '1234' });
    undo2();
    const hb = await bal(T.H);
    const onCard = T.card.balance();
    const nDates = dates(T.card).length;
    T.card.tap();
    T.card.sent.length = 0;
    const off = await T.H.W.cardWithdraw(T.card, { pin: '1234' });
    ok(nDates === 2 && off.sats === onCard && (await bal(T.H)) === hb + onCard && T.card.balance() === 0 && count(T.card, '24') === nDates,
       'a whole card taken off by its holder is a signature for each date, in the one tap', JSON.stringify({ sats: off.sats, signatures: count(T.card, '24'), dates: nDates }));
    ok(T.H.W.cardTaken().length === 0 && swaps(T.H).length === 0, 'and nothing is left on file');
    await settle();
  }

  /* ---- 7: more pieces than one signature takes ----------------------------- */
  {
    const M = await world(0, 9000);
    M.card.tap();
    await M.H.W.cardAdd(M.card, { sats: 2000, pin: '1234' });
    M.card.tap();
    await M.H.W.cardAdd(M.card, { sats: 1111, pin: '1234' });
    const n = amounts(M.card).length;
    const hb = await bal(M.H);
    M.card.tap();
    M.card.sent.length = 0;
    const off = await M.H.W.cardWithdraw(M.card, { pin: '1234' });
    ok(n > 32 && off.sats === 3111 && (await bal(M.H)) === hb + 3111 && M.card.balance() === 0 && count(M.card, '24') === Math.ceil(n / 32),
       'a card of more than thirty-two pieces is taken off whole in one tap, thirty-two to a signature', n + ' pieces, ' + count(M.card, '24') + ' signatures');

    // and the card taken away between the two: what it signed for is the holder's, and the next tap takes the rest
    M.card.tap();
    await M.H.W.cardAdd(M.card, { sats: 2000, pin: '1234' });
    M.card.tap();
    await M.H.W.cardAdd(M.card, { sats: 1111, pin: '1234' });
    const hb2 = await bal(M.H);
    M.card.tap();
    M.card.leaveBefore('22', 2);
    const part = await M.H.W.cardWithdraw(M.card, { pin: '1234' }).then(() => null, (x) => x);
    ok(part && part.card === 'partial' && part.sats > 0 && (await bal(M.H)) === hb2 + part.sats && M.card.balance() === 3111 - part.sats,
       'taken away between two signatures, the first is kept as part of the withdrawal', part && JSON.stringify({ kind: part.card, sats: part.sats, left: part.left }));
    M.card.tap();
    const fin = await M.H.W.cardWithdraw(M.card, { pin: '1234' });
    ok((await bal(M.H)) === hb2 + 3111 && M.card.balance() === 0 && fin.sats === 3111 - part.sats, 'and the next tap takes the rest', String(await bal(M.H)));
    await settle();
  }

  /* ---- 8: the limit on one payment is waited for, and asks no clock ---------
   * The card refuses nothing over it. For every limit's worth past the first
   * it does four signatures of work before it signs, a SIGN command each, and
   * nothing is burned until the last. Nothing is counted from one payment to
   * the next, and no time is asked. */
  {
    const L = await world(0, 9000);
    L.card.tap();
    await L.H.W.cardAdd(L.card, { sats: 3000, pin: '1234' });
    L.card.tap();
    const set = await L.H.W.cardSetLimit(L.card, { sats: 400, tap: true });
    ok(set.info.tapLimit === 400 && set.tap.paced === true && set.tap.limited === true && set.tap.left === null,
       'a per tap limit of 400 is set, and is read as one that is waited for', JSON.stringify(set.tap));
    // at the limit: straight away
    L.card.tap();
    L.card.sent.length = 0;
    const at = await L.R.W.cardPay(L.card, { sats: 400, pin: '1234' });
    ok(at.sats === 400 && count(L.card, '24') === 1, 'a payment of the limit is signed for at once', count(L.card, '24') + ' SIGN');
    // and again, at once: nothing is remembered of the one before
    L.card.tap();
    L.card.sent.length = 0;
    const at2 = await L.R.W.cardPay(L.card, { sats: 400, pin: '1234' });
    ok(at2.sats === 400 && count(L.card, '24') === 1, 'and so is the next, a moment later: nothing is counted from one payment to the next');
    // over it: one limit more is four signatures of work, then the signature
    L.card.tap();
    L.card.sent.length = 0;
    const said = [];
    const steps = [];
    const over = await L.R.W.cardPay(L.card, { sats: 500, pin: '1234', on: (st) => steps.push(st), progress: (p) => { if (p.step === 'waiting') said.push(p.left + (p.ahead ? ' ahead' : '')); } });
    ok(over.sats === 500 && (await bal(L.R)) === 1300 && count(L.card, '24') === 5,
       'a payment of 500 is made, after the card has been asked four times to wait', count(L.card, '24') + ' SIGN commands');
    ok(said.join(',') === '4 ahead,3,2,1,0', 'the screen is told the wait before the PIN is sent, and then as the card counts it down', said.join(','));
    ok(L.card.state.log.ring.some((e) => (e.flags & 2) === 2), 'and the card’s own log marks that tap as over its limit');
    // the pieces are chosen to overpay the least, since the card waits by what the pieces come to
    {
      const C = await world(0, 9000);
      await binaryLoad(C.H, C.card, 2000);          // 1024 512 256 128 64 16
      C.card.tap();
      await C.H.W.cardSetLimit(C.card, { sats: 300, tap: true });
      C.card.tap();
      C.card.sent.length = 0;
      const p = await C.R.W.cardPay(C.card, { sats: 250, pin: '1234' });
      ok(p.sats === 250 && count(C.card, '24') === 1 && C.card.balance() === 2000 - 256,
         'a price with no exact set is paid with the pieces that overpay it least (256 for 250), not a large one that would wait', 'card ' + C.card.balance() + ', ' + count(C.card, '24') + ' SIGN');
      if (p.change && p.change.sats) { C.card.tap(); await C.R.W.cardWrite(C.card, { pin: '1234' }); }
      await settle();
    }
    // lifted in the wait: nothing is burned, and the next tap waits in full again
    L.card.tap();
    const before = L.card.balance();
    L.card.leaveBefore('24', 3);
    const gone = await L.R.W.cardPay(L.card, { sats: 700, pin: '1234' }).then(() => null, (x) => x);
    ok(gone && gone.card === 'gone' && L.card.balance() === before && L.R.W.cardTaken().length === 0 && swaps(L.R).length === 0,
       'a card lifted while it waits has burned nothing, and the till holds nothing of it', gone && gone.card);
    L.card.tap();
    L.card.sent.length = 0;
    const then = await L.R.W.cardPay(L.card, { sats: 700, pin: '1234' });
    // what it waits is by what its pieces came to, which may be over the price where no exact set is left
    const signedFor = before - L.card.balance();
    ok(then.sats === 700 && signedFor >= 700 && count(L.card, '24') === 1 + 4 * (Math.ceil(signedFor / 400) - 1),
       'and tapped again it waits the whole of it again, and pays', signedFor + ' sats of pieces, ' + count(L.card, '24') + ' SIGN');
    if (then.change && then.change.sats) { L.card.tap(); await L.R.W.cardWrite(L.card, { pin: '1234' }); }
    // longer than anybody holds a card: not begun, and what can be taken is said
    L.card.tap();
    await L.H.W.cardSetLimit(L.card, { sats: 10, tap: true });
    L.card.tap();
    L.card.sent.length = 0;
    const long = await L.R.W.cardPay(L.card, { sats: 600, pin: '1234' }).then(() => null, (x) => x);
    ok(long && long.card === 'tap-limit' && long.paced === true && long.wait > 40 && long.left > 0 && count(L.card, '40') === 0,
       'a payment the card would make wait longer than a tap lasts is refused before the PIN, with the wait and the most that can be taken', long && long.message);
    // the holder's own phone lifts the limit to take money off, and puts it back
    L.card.tap();
    L.card.sent.length = 0;
    const hb = await bal(L.H);
    const onIt = L.card.balance();
    const off = await L.H.W.cardWithdraw(L.card, { pin: '1234' });
    L.card.tap();
    const after = await L.H.W.cardLook(L.card, { mine: true });
    ok(off.sats === onIt && (await bal(L.H)) === hb + onIt && count(L.card, '24') === 1 && after.info.tapLimit === 10,
       'its holder takes everything off in one signature with no wait, and the limit is back after', count(L.card, '24') + ' SIGN, limit ' + after.info.tapLimit);
    // no clock: a card never told the time takes the limit and spends under it
    {
      const N = await world(0, 9000);
      const raw = makeCard({ window: N.H.window, format: 4 });
      await raw.send('00a404000af0464f5859434152440100');
      const answer = await raw.send('b0010100' + '00');
      ok(answer.substr(12, 2) === '0f', 'the card says of itself that its limit on one payment is waited for', answer.substr(12, 2));
      await settle();
    }
    await settle();
  }

  /* ---- 8b: the limit is kept in dollars --------------------------------------
   * The card holds sats and has no price. The phone that set the limit keeps
   * the dollars it was set in, and when it reads its own card and the price
   * has moved, sets the card's sats to match. */
  {
    const D = await world(0, 9000);
    D.card.tap();
    await D.H.W.cardAdd(D.card, { sats: 2000, pin: '1234' });
    D.card.tap();
    // $1.00 at $100,000 a bitcoin is 1,000 sats
    await D.H.W.cardSetLimit(D.card, { sats: 1000, tap: true, usd: 1 });
    ok(D.H.W.cardPaceUsd(D.card.key) === 1, 'a limit set in dollars is kept in dollars on the phone that set it');
    D.card.tap();
    D.card.sent.length = 0;
    const same = await D.H.W.cardLook(D.card, { mine: true, price: 101000 });
    ok(same.info.tapLimit === 1000 && !same.repaced && count(D.card, '34') === 0, 'a price that has moved a little leaves the card as it is', String(same.info.tapLimit));
    D.card.tap();
    const moved = await D.H.W.cardLook(D.card, { mine: true, price: 80000 });
    ok(moved.info.tapLimit === 1250 && moved.repaced === 1250 && moved.tap.limit === 1250, 'a price that has moved is followed: the card’s sats are set to what the dollars are worth now', String(moved.info.tapLimit));
    D.card.tap();
    const read = await D.R.W.cardLook(D.card, { mine: true, price: 50000 });
    ok(read.info.tapLimit === 1250 && !read.repaced, 'another phone, which did not set it, changes nothing', String(read.info.tapLimit));
    D.card.tap();
    const noPrice = await D.H.W.cardLook(D.card, { mine: true });
    ok(noPrice.info.tapLimit === 1250 && !noPrice.repaced, 'nor does the holder’s phone with no price to go by');
    D.card.tap();
    await D.H.W.cardSetLimit(D.card, { sats: 700, tap: true });
    ok(D.H.W.cardPaceUsd(D.card.key) === 0, 'and a limit set in sats is left in sats');
    D.card.tap();
    const sats = await D.H.W.cardLook(D.card, { mine: true, price: 20000 });
    ok(sats.info.tapLimit === 700 && !sats.repaced, 'whatever the price does', String(sats.info.tapLimit));
    await settle();
  }

  /* ---- 9: taken away as it signs: the signature is had again -------------- */
  {
    const A = await world(0, 9000);
    A.card.tap();
    await A.H.W.cardAdd(A.card, { sats: 2000, pin: '1234' });
    // (a) before it signs: nothing is burned, and the next tap is a payment like any other
    A.card.tap();
    A.card.leaveBefore('24', 1);
    const early = await A.R.W.cardPay(A.card, { sats: 300, pin: '1234' }).then(() => null, (x) => x);
    ok(early && A.card.balance() === 2000 && A.R.W.cardTaken().length === 0, 'taken away before it signs, the card has burned nothing', early && early.card);
    A.card.tap();
    A.card.sent.length = 0;
    const again = await A.R.W.cardPay(A.card, { sats: 300, pin: '1234' });
    ok(again.sats === 300 && (await bal(A.R)) === 300 && A.card.balance() === 1700 && count(A.card, '25') === 0 && swaps(A.R).length === 0,
       'and the next tap pays, with nothing left of the first asking', (await bal(A.R)) + ', card ' + A.card.balance());

    // (b) as it signs: the pieces are burned and nobody heard the signature
    A.card.tap();
    A.card.loseAnswerOf('24', 1);
    const lost = await A.R.W.cardPay(A.card, { sats: 500, pin: '1234' }).then(() => null, (x) => x);
    ok(lost && lost.card === 'interrupted' && lost.resumable === true && A.card.balance() === 1200 && (await bal(A.R)) === 300,
       'taken away as it signs, the card has burned the pieces and the receiver has no signature: nothing is paid yet, and it is said to tap again',
       lost && (lost.card + ', card ' + A.card.balance()));
    ok(swaps(A.R).length === 1 && !!swaps(A.R)[0].asked, 'the asking is written down, with the outputs it was for');
    A.card.tap();
    A.card.sent.length = 0;
    const fin = await A.R.W.cardPay(A.card, { sats: 500, pin: '1234' });
    ok(fin.sats === 500 && (await bal(A.R)) === 800 && A.card.balance() === 1200 && count(A.card, '25') === 1 && count(A.card, '24') === 0,
       'the next tap asks the card for that signature again, and the payment is made with nothing more burned', (await bal(A.R)) + ', card ' + A.card.balance());
    ok(swaps(A.R).length === 0 && A.R.W.cardTaken().length === 0, 'and nothing is left on file');

    // (c) as it signs, and the next tap is for another amount: the first goes back to the card, and the second is paid
    A.card.tap();
    A.card.loseAnswerOf('24', 1);
    await A.R.W.cardPay(A.card, { sats: 200, pin: '1234' }).then(() => null, (x) => x);
    ok(A.card.balance() === 1000, 'again taken away as it signs', String(A.card.balance()));
    A.card.tap();
    const other = await A.R.W.cardPay(A.card, { sats: 100, pin: '1234' });
    ok(other.sats === 100 && (await bal(A.R)) === 900, 'a tap for another amount is paid', String(await bal(A.R)));
    await settle();
    const owedBack = A.R.W.cardOwed().reduce((n, r) => n + r.sats, 0);
    ok(owedBack === 200 + ((other.change && other.change.sats) || 0), 'and what the card signed for the first goes back to it, owed', owedBack + ' owed');
    A.card.tap();
    await A.R.W.cardWrite(A.card, { pin: '1234' });
    ok(A.card.balance() === 1100 && (await bal(A.R)) === 900, 'which the next tap writes onto it: the card is out 100 and no more', A.card.balance() + ', receiver ' + (await bal(A.R)));

    // (d) as it signs, and it signs for somebody else before it comes back: that signature is not to be had
    const R2 = await funded({ sharedMint: A.H.mint, words: WORDS3 }, 0);
    A.card.tap();
    A.card.loseAnswerOf('24', 1);
    await A.R.W.cardPay(A.card, { sats: 64, pin: '1234' }).then(() => null, (x) => x);
    const afterLost = A.card.balance();
    A.card.tap();
    await R2.W.cardPay(A.card, { sats: 32, pin: '1234' });
    A.card.tap();
    const rb = await bal(A.R);
    const late = await A.R.W.cardPay(A.card, { sats: 64, pin: '1234' });
    ok(late.sats === 64 && (await bal(A.R)) === rb + 64 && A.card.balance() === afterLost - 32 - 64 && swaps(A.R).length === 0,
       'a card that has signed for another till since cannot give the lost signature again: the payment is made afresh, and the asking is forgotten',
       (await bal(A.R)) - rb + ' paid, card ' + A.card.balance());
    await settle();
  }

  /* ---- 10: the mint's answer is lost -------------------------------------- */
  {
    const before = await bal(R);
    const onCard = card.balance();
    card.tap();
    const realHandle = R.mint.handle.bind(R.mint);
    let dropped = false;
    R.fate = (m) => {
      if (dropped || !/\/v1\/swap$/.test(String(m.url || ''))) return null;
      dropped = true;
      realHandle(m);
      return '0\n';
    };
    const lost = await R.W.cardPay(card, { sats: 100, pin: '1234' }).then((r) => r, (e) => e);
    R.fate = null;
    await settle();
    await R.W.cardSettle();
    await settle();
    ok(dropped && (await bal(R)) === before + 100 && R.W.cardTaken().length === 0,
       'a swap whose answer never came is found again from the same outputs, and the receiver is paid once', JSON.stringify({ first: lost && (lost.card || lost.sats), bal: (await bal(R)) - before }));
    if (card.balance() !== onCard - 100) { card.tap(); await R.W.cardWrite(card, { pin: '1234' }).catch(() => null); }
  }

  /* ---- 11: the signature is good for that swap and no other --------------- */
  {
    const S = await world(0, 9000);
    S.card.tap();
    await S.H.W.cardAdd(S.card, { sats: 1000, pin: '1234' });
    // the swap is stopped on its way, and what the receiver was sending is looked at
    S.card.tap();
    let sent = null;
    S.R.fate = (m) => { if (!sent && /\/v1\/swap$/.test(String(m.url || ''))) { sent = m; return '0\n'; } return null; };
    await S.R.W.cardPay(S.card, { sats: 200, pin: '1234' }).then(() => null, (x) => x);
    S.R.fate = null;
    await settle();
    ok(!!sent && S.R.W.cardTaken().length === 1 && swaps(S.R).length === 1, 'a payment the mint has not heard of yet is one row, and the outputs it was signed for');
    const body = JSON.parse(sent.body);
    ok(body.inputs.filter((p) => p.witness).length === 1 && !!body.inputs[0].witness, 'one signature goes to the mint, on the first piece', body.inputs.length + ' pieces');
    // the same pieces and the same signature with the outputs in another order: not the swap that was signed for
    const turned = Object.assign({}, sent, { body: JSON.stringify({ inputs: body.inputs, outputs: body.outputs.slice().reverse() }) });
    const said = String(S.R.mint.handle(turned));
    ok(!/^200/.test(said) && /signature|P2PK/i.test(said), 'the mint refuses the signature for any other outputs, even the same ones in another order', said.slice(0, 90).replace(/\n/g, ' '));
    // and somebody who has the signed pieces and not the outputs cannot even set a swap out
    const thief = await funded({ sharedMint: S.H.mint, words: WORDS4 }, 0);
    const signedToken = JSON.parse(S.R.storage.getItem('foxy.flashcard.taken'))[0].token;
    const stolen = await why(thief.W.receiveToken(signedToken));
    ok(stolen !== 'went through' && (await bal(thief)) === 0, 'the signed pieces are worth nothing to a wallet that does not hold those outputs', String(stolen).slice(0, 80));
    await S.R.W.cardSettle();
    await settle();
    ok((await bal(S.R)) === 200 && S.R.W.cardTaken().length === 0 && swaps(S.R).length === 0, 'and the receiver, who has the outputs, is paid', String(await bal(S.R)));
  }

  /* ---- 13: a receiver whose counters are behind what the mint has seen ------
   * The outputs are made before the card signs, at this phone's next counters.
   * A phone whose counters are behind (its seed was used elsewhere, or they
   * were lost) sets out outputs the mint has signed already, and the mint
   * refuses the swap. No other outputs will do for that signature, so the
   * payment is not made: the pieces go back to the card, and the counters are
   * moved on so that the next payment is. */
  {
    const B = await world(0, 9000);
    B.card.tap();
    await B.H.W.cardAdd(B.card, { sats: 1000, pin: '1234' });
    // a till with the holder's own words, at the same mint, that has never been used: its counters begin where the holder's did
    const behind = await funded({ sharedMint: B.H.mint, words: PHONE_WORDS }, 0);
    B.card.tap();
    const no = await behind.W.cardPay(B.card, { sats: 300, pin: '1234' }).then(() => null, (x) => x);
    await settle();
    ok(no && (await bal(behind)) === 0 && behind.W.cardTaken().length === 0 && behind.W.cardOwed().reduce((n, r) => n + r.sats, 0) === 300,
       'outputs the mint has signed before are refused: nothing is paid, and the card’s pieces are owed back to it as they stood', no && (no.card + ': ' + String(no.message).slice(0, 70)));
    B.card.tap();
    await behind.W.cardWrite(B.card, { pin: '1234' });
    ok(B.card.balance() === 1000, 'the next tap puts them back', String(B.card.balance()));
    let paidAt = 0;
    for (let i = 1; i <= 4 && !paidAt; i++) {
      B.card.tap();
      const r = await behind.W.cardPay(B.card, { sats: 300, pin: '1234' }).then((x) => x, () => null);
      await settle();
      if (r && r.sats === 300) paidAt = i;
      else { B.card.tap(); await behind.W.cardWrite(B.card, { pin: '1234' }).catch(() => null); }
    }
    ok(paidAt > 0 && (await bal(behind)) === 300 && B.card.balance() === 700, 'and with its counters moved on, the till is paid', 'at try ' + paidAt + ', card ' + B.card.balance());
    await settle();
  }

  /* ---- 14: with no route, on trust ------------------------------------------
   * The outputs are made from this phone's own seed and need no mint, so a
   * card signs for a swap with no route as it does with one. The outputs it
   * signed for wait with the pieces, and are the swap that is made when there
   * is a route again. */
  {
    const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    const O = await world(0, 9000);
    O.card.tap();
    await O.H.W.cardAdd(O.card, { sats: 2000, pin: '1234' });
    O.R.W.onOfflineOffer(() => Promise.resolve(true));
    offline(O.R.W);
    O.card.tap();
    O.card.sent.length = 0;
    const got = await O.R.W.cardPay(O.card, { sats: 592, pin: '1234', trusted: true });
    ok(got.trusted === true && got.sats === 592 && got.change === null && count(O.card, '24') === 1 && O.card.balance() === 2000 - 592,
       'with no route and a yes, a price the card makes exactly is signed for once and kept on trust', JSON.stringify({ sats: got.sats, trusted: got.trusted }));
    ok(O.R.W.trustedWaiting().length === 1 && swaps(O.R).length === 1 && !swaps(O.R)[0].asked && O.R.W.cardTaken().length === 0,
       'it waits as a trusted row, with the outputs it was signed for beside it');
    O.card.tap();
    const inexact = await O.R.W.cardPay(O.card, { sats: 2000, pin: '1234', trusted: true }).then(() => null, (e) => e);
    ok(inexact && inexact.card !== 'went through' && O.card.balance() === 2000 - 592, 'and a price it cannot make exactly is not taken with no route', inexact && inexact.card);
    online(O.R.W);
    await O.R.W.claimUnclaimed();
    await settle();
    ok((await bal(O.R)) === 592 && O.R.W.trustedWaiting().length === 0 && swaps(O.R).length === 0,
       'online again, it is swapped for exactly those outputs and is the till’s money', String(await bal(O.R)));
    const e = history(O.R).filter((x) => x.hash === got.hash)[0] || {};
    ok(e.state !== 'pending' && e.settled !== false && e.sats === 592, 'and its entry is settled', JSON.stringify({ s: e.state, sats: e.sats }));
    await settle();
  }

  /* ---- 15: the screens ------------------------------------------------------
   * The till's own screens (build/app/26f-flashcard.js) with such a card: one
   * tap and no second, nothing said of change where none is coming, and a
   * card taken away as it signs asked for again in the same sheet. */
  {
    const U = await world(0, 9000);
    U.card.tap();
    await U.H.W.cardAdd(U.card, { sats: 2000, pin: '1234' });
    const till = appOn(U.R, { screen: 'confirm' });
    const titles = [];
    const shown = till.blockedCard.bind(till);
    till.blockedCard = (kind, spec) => { titles.push((spec && spec.title) || kind); return shown(kind, spec); };
    const lines = [];
    const text0 = till.fcProgressText.bind(till);
    till.fcProgressText = (p) => { const t = text0(p); if (t) lines.push(t); return t; };
    till.wantedSats = () => 700;
    U.R.nfc = U.card;
    U.R.sheet.length = 0;
    U.card.sent.length = 0;
    till.payByCard();
    pad(till).type('1234');
    await until('the payment to be made', () => U.R.sheet.some((x) => /^(end|error):/.test(x)) && !stage(U.R));
    await settle();
    ok((await bal(U.R)) === 700 && U.card.balance() === 1300 && count(U.card, '24') === 1 && titles.length === 0,
       'on the till’s screens: 700 sats paid with one signature and no card to press', (await bal(U.R)) + ', ' + titles.join());
    ok(U.R.sheet.filter((x) => /^begin:/.test(x)).length === 1 && U.R.sheet.filter((x) => /^again:/.test(x)).length === 0 && U.R.sheet.filter((x) => /^end:/.test(x)).length === 1,
       'one sheet and one tap: the card is not asked for again', U.R.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / '));
    ok(U.R.sheet.indexOf('end:  ') >= 0 && U.R.sheet.every((x) => !/Verifying the payment|Remove the card|for your change/.test(x)),
       'the sheet closes with no words on it: nothing about removing the card, and nothing of change, since none is coming', JSON.stringify(U.R.sheet.filter((x) => /^(end|say):/.test(x))));
    ok(U.R.trace.indexOf('end') >= 0 && U.R.trace.indexOf('end') < U.R.trace.lastIndexOf('mint /v1/swap'),
       'and it closes as soon as the card has signed, before the mint is asked: the wait for the mint is on Foxy’s own screen');
    ok(lines.indexOf('Signing') >= 0 && lines.every((t) => !/Signing piece/.test(t)), 'and the line under the heading says Signing, with no count of pieces', lines.join(' / '));

    // taken away as it signs: the same sheet looks for the card again, and the payment is made at that tap with nothing more signed
    till.setState({ screen: 'confirm' });
    till.wantedSats = () => 300;
    U.R.sheet.length = 0;
    U.card.sent.length = 0;
    // armed at the tap's first command: the sheet's own tap puts the card back as it was
    const send0 = U.card.send.bind(U.card);
    let armed = false;
    U.card.send = (a) => { if (!armed) { armed = true; U.card.loseAnswerOf('24', 1); } return send0(a); };
    till.payByCard();
    pad(till).type('1234');
    await until('the payment to be finished at the second tap', () => U.R.sheet.some((x) => /^(end|error):/.test(x)) && !stage(U.R));
    await settle();
    ok((await bal(U.R)) === 1000 && U.card.balance() === 1000 && count(U.card, '24') === 1 && count(U.card, '25') === 1,
       'taken away as it signs: paid at the next tap, the card out 300 once, and asked only for the signature it had already given', (await bal(U.R)) + ', card ' + U.card.balance());
    ok(U.R.sheet.filter((x) => /^begin:/.test(x)).length === 1 && U.R.sheet.indexOf('again: Hold the card here again to finish paying') >= 0 && titles.length === 0,
       'in the same sheet, which asks for the card again, with no card to press', U.R.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / ') + ' ' + titles.join());
    await settle();
  }

  /* ---- 16: the limit on the screens: set in dollars, waited for at a till, read in dollars ---- */
  {
    const V = await world(0, 9000);
    V.card.tap();
    await V.H.W.cardAdd(V.card, { sats: 3000, pin: '1234' });
    const holder = appOn(V.H);
    holder.price = 100000;                       // a dollar is 1,000 sats
    V.H.nfc = V.card;
    holder.goFlashcard();
    await until('the card to be read', () => !!holder.state.fc);
    holder.fcSetLimit();
    const which = uiCard(holder);
    ok(which && which.title === 'CHANGE LIMIT' && /straight away/.test(which.reason), 'CHANGE LIMIT says what the per tap limit is now: the most it pays straight away', which && which.reason);
    which.press('PER TAP LIMIT');
    ok(/held 3 seconds longer/.test(uiCard(holder).reason) && /Lift the card and the payment stops/.test(uiCard(holder).reason), 'and its warning says a larger payment waits, and that lifting the card stops it');
    uiCard(holder).press('CONTINUE');
    holder.state.amount = '0.50';
    holder.state.unit = 'USD';
    holder.fcAmountNext();
    ok(holder.state.screen === 'fcLimitConfirm' && holder.state.fcLimit.sats === 500 && holder.state.fcLimit.usd === 0.5 && /kept at this many dollars/.test(holder.fcLimitSpec().warn),
       'an amount typed in dollars is confirmed as dollars that the phone will keep the card to', holder.fcLimitSpec().warn);
    holder.fcLimitSpec().go();
    await until('the limit to be set', () => holder.toasts.some((t) => /Per tap limit set/.test(t)));
    ok(V.card.state.tapLimit === 500 && V.H.W.cardPaceUsd(V.card.key) === 0.5, 'the card is given the sats, and the phone keeps the dollars', V.card.state.tapLimit + ' sats, $' + V.H.W.cardPaceUsd(V.card.key));
    // the price moves, and the holder opens FLASHCARD again: the card follows, with nothing asked
    holder.price = 50000;
    holder.setState({ fc: null, screen: 'home', stack: [] });
    holder.goFlashcard();
    await until('the card to be read again', () => !!holder.state.fc);
    await settle();
    ok(V.card.state.tapLimit === 1000, 'when the price has halved, the next read sets the card to twice the sats: the same dollars', String(V.card.state.tapLimit));

    // a till, charging more than the limit: it says to keep holding, and counts
    const till = appOn(V.R, { screen: 'confirm' });
    till.price = 50000;
    const lines = [];
    const text0 = till.fcProgressText.bind(till);
    till.fcProgressText = (p) => { const t = text0(p); if (t && lines[lines.length - 1] !== t) lines.push(t); return t; };
    till.wantedSats = () => 1500;
    V.R.nfc = V.card;
    V.R.sheet.length = 0;
    V.card.sent.length = 0;
    till.payByCard();
    pad(till).type('1234');
    await until('the waited payment to be made', () => V.R.sheet.some((x) => /^(end|error):/.test(x)) && !stage(V.R));
    await settle();
    const waited = lines.filter((t) => /Keep holding/.test(t));
    ok((await bal(V.R)) === 1500 && count(V.card, '24') === 5, 'a charge of one and a half limits is paid after the card has waited once', (await bal(V.R)) + ', ' + count(V.card, '24') + ' SIGN');
    ok(waited.length >= 2 && /^Over the card’s per tap limit\. Keep holding: \d+ seconds?$/.test(waited[0]), 'and the till said to keep holding, with the seconds counting down', waited.join(' / '));
    if (V.R.W.cardOwed().length) { V.card.tap(); await V.R.W.cardWrite(V.card, { pin: '1234' }); }

    // the card's own log, on its holder's phone: in dollars, and that tap marked
    holder.setState({ fc: null, screen: 'home', stack: [] });
    holder.goFlashcard();
    await until('the card to be read for its log', () => !!holder.state.fc && !!holder.state.fc.log);
    holder.fcLogCard();
    const logCard = uiCard(holder);
    ok(logCard && /\$\d/.test(logCard.reason) && !/₿/.test(logCard.reason) && /over the per tap limit/.test(logCard.reason) && /In dollars at the price now\./.test(logCard.reason),
       'the card’s own log is read in dollars, and says which tap was over the limit', logCard && logCard.reason.replace(/\n+/g, ' | ').slice(0, 260));
    await settle();
  }

  /* ---- 12: a lost card is taken back, a signature for each date ------------ */
  {
    const K = await world(0, 9000);
    K.card.tap();
    await K.H.W.cardAdd(K.card, { sats: 2000, pin: '1234' });
    const hb = await bal(K.H);
    const soon = await K.H.W.cardTakeBack(K.card.key).then(() => null, (e) => e);
    ok(soon && soon.card === 'too-soon', 'before its date nothing can be taken back', soon && soon.card);
    const undo = later(K.H, 366 * DAY);
    const back = await K.H.W.cardTakeBack(K.card.key);
    undo();
    ok(back.sats === 2000 && (await bal(K.H)) === hb + 2000, 'after it, the phone that set the card up takes it back with its own key, with no card', String(back.sats));
    ok(K.H.W.cardTaken().length === 0 && swaps(K.H).length === 0, 'and nothing is left on file');
    await settle();
  }

  await settle();
  console.log('\n' + (failed ? failed + ' flashcard-sigall check(s) failed' : 'all flashcard-sigall checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
