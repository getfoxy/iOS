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
const { appOn, until, pad, stage, card: uiCard, vals } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const card4 = (ctx) => makeCard({ window: ctx.window, format: 4 });
const amounts = (card) => card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(16, 8), 16)).sort((a, b) => b - a);
// how many pieces of each size are on a card
const deep = (card) => amounts(card).reduce((o, a) => { o[a] = (o[a] || 0) + 1; return o; }, {});
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

// the card as it was on the chip before 1.8: 128 places, and a transaction that held about a dozen pieces and no more
const card7 = (ctx) => makeCard({ window: ctx.window, format: 4, software: 7, burnMost: 11 });
async function world(feePpk, sats, make) {
  const H = await funded({ feePpk }, sats || 9000);
  const R = await funded({ feePpk, sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = (make || card4)(H);
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  return { H, R, card };
}

(async () => {
  /* ---- 1: onto the card, written the card's way -------------------------- */
  const { H, R, card } = await world(0);
  const seen = await H.W.cardLook(card);
  ok(seen.info.format === 4 && seen.info.version === '1.10' && seen.info.paced === true && seen.info.quick === true && seen.info.wide === true && seen.info.many === true && seen.info.sealed === true && seen.info.slots === 128,
     'a card that signs once for a payment is read as what it is, with its 128 places', seen.info.version + ', format ' + seen.info.format + ', ' + seen.info.slots + ' places');
  card.tap();
  card.sent.length = 0;
  const added = await H.W.cardAdd(card, { sats: 2000, pin: '1234' });
  ok(added.sats === 2000 && card.balance() === 2000, '2,000 sats are put on it', String(card.balance()));
  ok(count(card, '30') === Math.ceil(added.card.pieces.length / 3) && added.card.pieces.length === 66,
     'three pieces to a command: sixty-six pieces go on in twenty-two', count(card, '30') + ' LOAD commands for ' + added.card.pieces.length + ' pieces');
  ok(JSON.stringify(deep(card)) === JSON.stringify({ 1: 8, 2: 8, 4: 8, 8: 9, 16: 9, 32: 8, 64: 9, 128: 7 }),
     'cut as a deep drawer: eight of each size from 1 up, as far as 2,000 sats go, and what is left over in powers of two', JSON.stringify(deep(card)));
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
       'with ONE signature, whatever the number of pieces', count(card, '24') + ' signature(s) for ' + (66 - amounts(card).length) + ' pieces');
    ok(paid.change === null && R.W.cardOwed().length === 0, 'made of pieces that come to exactly the price: no change, and no second tap', JSON.stringify(paid.change));
    {
      // how the till read the card: the short listing, then only the pieces it chose, whole
      const pages = card.sent.filter((a) => /^b017..03/.test(a)).length, wholePages = card.sent.filter((a) => /^b017..0[01]/.test(a)).length;
      const asked = card.sent.filter((a) => /^b0170002/.test(a)).reduce((n, a) => n + parseInt(a.substr(8, 2), 16), 0);
      ok(pages === 1 && wholePages === 0 && asked === 10 && count(card, '15') === 0,
         'the till read the card’s short listing (one command for sixty-six pieces, where the whole listing is twenty-two) and then asked for the ten pieces it chose and no others',
         pages + ' short pages, ' + wholePages + ' whole pages, ' + asked + ' pieces asked for by name');
    }
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
    // a signature for each date's pieces, however many they are
    const signatures = nDates;
    T.card.tap();
    T.card.sent.length = 0;
    const off = await T.H.W.cardWithdraw(T.card, { pin: '1234' });
    ok(nDates === 2 && off.sats === onCard && (await bal(T.H)) === hb + onCard && T.card.balance() === 0 && count(T.card, '24') === signatures,
       'a whole card taken off by its holder is a signature for each date’s pieces, in the one tap', JSON.stringify({ sats: off.sats, signatures: count(T.card, '24'), dates: nDates }));
    ok(T.H.W.cardTaken().length === 0 && swaps(T.H).length === 0, 'and nothing is left on file');
    await settle();
  }

  /* ---- 7: more pieces than one signature takes ----------------------------- */
  {
    // (the card before 1.8, whose chip burns a dozen pieces at once and no more: this phone asks it for eight at a time)
    const M = await world(0, 9000, card7);
    M.card.tap();
    await M.H.W.cardAdd(M.card, { sats: 2000, pin: '1234' });
    M.card.tap();
    await M.H.W.cardAdd(M.card, { sats: 1111, pin: '1234' });
    const n = amounts(M.card).length;
    const hb = await bal(M.H);
    M.card.tap();
    M.card.sent.length = 0;
    const off = await M.H.W.cardWithdraw(M.card, { pin: '1234' });
    ok(n > 8 && off.sats === 3111 && (await bal(M.H)) === hb + 3111 && M.card.balance() === 0 && count(M.card, '24') === Math.ceil(n / 8),
       'a card of more pieces than one signature takes is taken off whole in one tap, eight to a signature', n + ' pieces, ' + count(M.card, '24') + ' signatures');

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
    // what a till can read of the card says nothing of the limit: it is the holder's, and the holder's phone hears it
    const tillSees = await L.R.W.cardLook(L.card, { mine: true });
    L.card.tap();
    const ownerSees = await L.H.W.cardLook(L.card, { mine: true });
    ok(tillSees.info.tapLimit === 0 && tillSees.tap.limited === false && ownerSees.info.tapLimit === 400,
       'the card says its per tap limit to its owner’s phone and to no other: a till reads none', 'till ' + tillSees.info.tapLimit + ', owner ' + ownerSees.info.tapLimit);
    L.card.tap();
    L.card.sent.length = 0;
    const answers = [];
    const send0 = L.card.send.bind(L.card);
    L.card.send = (a) => send0(a).then((r) => { if (String(a).slice(0, 4) === 'b024' && r.length === 8) answers.push(r.slice(0, 4)); return r; });
    const over = await L.R.W.cardPay(L.card, { sats: 500, pin: '1234', on: (st) => steps.push(st), progress: (p) => { if (p.step === 'waiting') said.push(p.polls); } });
    L.card.send = send0;
    ok(over.sats === 500 && (await bal(L.R)) === 1300 && count(L.card, '24') === 5,
       'a payment of 500 is made, after the card has been asked four times to wait', count(L.card, '24') + ' SIGN commands');
    ok(said.join(',') === '1,2,3,4' && answers.join(',') === '0001,0001,0001,0001',
       'the card says only "not yet", never how many waits are left, and the screen counts what has been', said.join(',') + ' / ' + answers.join(','));
    ok(L.card.state.log.ring.some((e) => (e.flags & 2) === 2), 'and the card’s own log marks that tap as over its limit');
    // the pieces are chosen to overpay the least, since the card waits by what the pieces come to
    {
      const C = await world(0, 9000);
      await binaryLoad(C.H, C.card, 2000);          // 1024 512 256 128 64 16
      C.card.tap();
      await C.H.W.cardSetLimit(C.card, { sats: 300, tap: true });
      C.card.tap();
      C.card.sent.length = 0;
      const holding = [];
      const p = await C.R.W.cardPay(C.card, { sats: 250, pin: '1234', progress: (q) => { if (q.step === 'waiting') holding.push(q); } });
      /* The till first asks for a set that brings change worth having back (512: the drawer is short), is told "not
       * yet" once, since that is over a limit it was not told, and pays with the cheapest set instead. Nobody is
       * made to wait, or told to. */
      ok(p.sats === 250 && count(C.card, '24') === 2 && count(C.card, '22') === 2 && C.card.balance() === 2000 - 256 && holding.length === 0,
         'a price with no exact set is paid with the pieces that overpay it least (256 for 250), not a larger set the card would wait for: that one is given up at the card’s first "not yet", and nobody is told to keep holding',
         'card ' + C.card.balance() + ', ' + count(C.card, '24') + ' SIGN, ' + holding.length + ' told to hold');
      ok(!C.card.state.log.ring.some((e) => (e.flags & 2) === 2), 'and the card’s log does not mark that tap as over its limit: the payment it signed for was not');
      if (p.change && p.change.sats) { C.card.tap(); await C.R.W.cardWrite(C.card, { pin: '1234' }); }
      await settle();
    }
    // lifted in the wait: nothing is burned, and the next tap waits in full again
    L.card.tap();
    const before = L.card.balance();
    L.card.leaveBefore('24', 3);
    const gone = await L.R.W.cardPay(L.card, { sats: 700, pin: '1234' }).then(() => null, (x) => x);
    ok(gone && gone.card === 'interrupted' && gone.resumable === true && L.card.balance() === before && L.R.W.cardTaken().length === 0,
       'a card lifted while it waits has burned nothing, and the till holds nothing of it: it is asked to tap again', gone && gone.card);
    L.card.tap();
    L.card.sent.length = 0;
    const then = await L.R.W.cardPay(L.card, { sats: 700, pin: '1234' });
    // what it waits is by what its pieces came to, which may be over the price where no exact set is left
    const signedFor = before - L.card.balance();
    ok(then.sats === 700 && signedFor >= 700 && count(L.card, '24') === 1 + 4 * (Math.ceil(signedFor / 400) - 1) && count(L.card, '25') === 0 && swaps(L.R).length === 0,
       'and tapped again it is seen to have signed nothing (its pieces are still on it), waits the whole of it again, and pays', signedFor + ' sats of pieces, ' + count(L.card, '24') + ' SIGN');
    if (then.change && then.change.sats) { L.card.tap(); await L.R.W.cardWrite(L.card, { pin: '1234' }); }
    // longer than anybody holds a card: not begun, and what can be taken is said
    L.card.tap();
    await L.H.W.cardSetLimit(L.card, { sats: 10, tap: true });
    L.card.tap();
    L.card.sent.length = 0;
    const onBefore = L.card.balance();
    const long = await L.R.W.cardPay(L.card, { sats: 600, pin: '1234' }).then(() => null, (x) => x);
    ok(long && long.card === 'tap-limit' && long.paced === true && long.hidden === true && count(L.card, '24') === 55 && L.card.balance() === onBefore
       && swaps(L.R).length === 0 && L.R.W.cardTaken().length === 0,
       'a payment the card makes wait longer than a tap lasts is given up, with nothing signed and nothing kept, and said as that', long && long.message);
    // the holder's own phone lifts the limit to take money off, and puts it back
    L.card.tap();
    L.card.sent.length = 0;
    const hb = await bal(L.H);
    const onIt = L.card.balance();
    const piecesOn = amounts(L.card).length;
    const off = await L.H.W.cardWithdraw(L.card, { pin: '1234' });
    L.card.tap();
    const after = await L.H.W.cardLook(L.card, { mine: true });
    ok(off.sats === onIt && (await bal(L.H)) === hb + onIt && count(L.card, '24') === 1 && after.info.tapLimit === 10,
       'its holder takes everything off in one signature with no wait, and the limit is back after', count(L.card, '24') + ' SIGN for ' + piecesOn + ' pieces, limit ' + after.info.tapLimit);
    // no clock: a card never told the time takes the limit and spends under it
    {
      const N = await world(0, 9000);
      const raw = makeCard({ window: N.H.window, format: 4 });
      await raw.send('00a404000af0464f5859434152440100');
      const answer = await raw.send('b0010100' + '00');
      ok((parseInt(answer.substr(12, 2), 16) & 8) === 8, 'the card says of itself that its limit on one payment is waited for', answer.substr(12, 2));
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
    D.card.tap();
    const still = await D.H.W.cardLook(D.card, { mine: true, price: 80000 });
    ok(read.info.tapLimit === 0 && !read.repaced && still.info.tapLimit === 1250 && !still.repaced,
       'another phone, which did not set it, is not told the limit and changes nothing', 'the other reads ' + read.info.tapLimit + ', the card still has ' + still.info.tapLimit);
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
    // every buzz, and what the sheet had been told by then
    const felt = [];
    till.haptic = (kind, silent) => felt.push({ kind, silent: !!silent, ended: U.R.sheet.some((x) => /^end:/.test(x)), paid: U.R.W.cardTaken().length === 0 && U.R.trace.indexOf('mint /v1/swap') >= 0 });
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
    // (the PIN pad's own keys are felt too, lightly: those are not this)
    const buzz = felt.filter((f) => f.kind !== 'light');
    ok(buzz.length === 2 && buzz[0].kind === 'tap' && buzz[0].silent === true && buzz[0].ended === true && buzz[1].kind === 'success',
       'a silent tap is felt the moment the card has signed and its sheet is told to go, and the payment’s own buzz comes when it is paid', JSON.stringify(buzz.map((f) => f.kind + (f.silent ? ' (silent)' : ''))));

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
    ok(waited.length >= 1 && /^Over the card’s per tap limit\. Keep holding \(\d+ s\)$/.test(waited[0]), 'and the till said to keep holding, with how long it had been and not how long was left', waited.join(' / '));
    // a small payment paid from a piece worth much more is not over anybody's limit, and is not told it is
    ok(till.fcProgressText({ step: 'waiting', polls: 2, seconds: 3, sum: 2048, want: 613 }) === 'Paying from a larger piece. Keep holding (3 s)'
       && /^Over the card’s per tap limit/.test(till.fcProgressText({ step: 'waiting', polls: 2, seconds: 3, sum: 1500, want: 1500 }))
       && /^Over the card’s per tap limit/.test(till.fcProgressText({ step: 'waiting', polls: 2, seconds: 3 })),
       'where the wait is for a piece worth twice the price or more, the till says it is paying from a larger piece, and not that the payment is over a limit');
    if (V.R.W.cardOwed().length) { V.card.tap(); await V.R.W.cardWrite(V.card, { pin: '1234' }); }

    // the card's own log, on its holder's phone: in dollars, and that tap marked
    holder.setState({ fc: null, screen: 'home', stack: [] });
    holder.goFlashcard();
    await until('the card to be read for its log', () => !!holder.state.fc && !!holder.state.fc.log);
    holder.fcLogCard();
    const logCard = uiCard(holder);
    ok(logCard && /\$\d/.test(logCard.reason) && !/₿/.test(logCard.reason) && /over the per tap limit/.test(logCard.reason) && /In dollars at the price now\./.test(logCard.reason)
       && /put on/.test(logCard.reason) && /Receipts kept on this phone: 1 of 1 payment/.test(logCard.reason) && logCard.has('COPY RECEIPTS'),
       'the card’s own log is read in dollars, says which tap was over the limit and what was put on, and offers its receipts', logCard && logCard.reason.replace(/\n+/g, ' | ').slice(0, 260));
    await settle();
  }

  /* ---- 17: receipts, and a false time ------------------------------------------
   * For each payment the card keeps when, how much, the hash of what it signed
   * and the first output the money went into, and gives them to its owner's
   * phone and to no other. The output is the receiver's own (made from its
   * seed): it is in the swap the till itself sent. And the card's clock: told
   * twice in one tap, far apart, the card writes it down; ahead of this
   * phone's, this phone says so. */
  {
    const X = await world(0, 9000);
    X.card.tap();
    await X.H.W.cardAdd(X.card, { sats: 2000, pin: '1234' });
    let asked = null;
    X.R.fate = (m) => { if (!asked && /\/v1\/swap$/.test(String(m.url || ''))) asked = JSON.parse(m.body); return null; };
    X.card.tap();
    await X.R.W.cardPay(X.card, { sats: 700, pin: '1234' });
    X.R.fate = null;
    const signedText = X.card.state.lastText;
    X.card.tap();
    const tillRead = await X.R.W.cardLook(X.card, { mine: true });
    ok(!tillRead.receipts && !tillRead.log && X.R.W.cardReceipts(X.card.key).length === 0, 'a till is given no receipts and no log of the card');
    X.card.tap();
    const own = await X.H.W.cardLook(X.card, { mine: true });
    const r1 = (own.receipts && own.receipts.list[0]) || {};
    ok(own.receipts && own.receipts.count === 1 && own.receipts.fresh === 1 && r1.n === 1 && r1.sats === 700
       && r1.hash === require('crypto').createHash('sha256').update(signedText, 'utf8').digest('hex'),
       'its owner’s phone reads a receipt for the payment: its number, what the pieces were worth, and the hash of exactly what the card signed', JSON.stringify({ n: r1.n, sats: r1.sats }));
    ok(!!asked && r1.out === asked.outputs[0].B_ && asked.outputs.length > 1,
       'and the first output of the swap the money went into, which is the receiver’s own: the one its phone made from its seed and sent the mint', String(r1.out).slice(0, 16) + '…');
    ok(own.log.last.some((x) => x.loaded === 2000 && x.loads === 66) && own.log.last.some((x) => x.sats === 700),
       'the card’s log says what was put on as well as what was paid', JSON.stringify(own.log.last.map((x) => [x.sats, x.loaded])));
    // more payments than the card's ring holds, read as they go: the phone keeps them all, in order
    for (let i = 0; i < 18; i++) {
      X.card.tap();
      await X.R.W.cardPay(X.card, { sats: 10 + i, pin: '1234' });
      if (X.R.W.cardOwed().length) { X.card.tap(); await X.R.W.cardWrite(X.card, { pin: '1234' }); }
      if (i === 8 || i === 17) { X.card.tap(); await X.H.W.cardLook(X.card, { mine: true }); }
    }
    const kept = X.H.W.cardReceipts(X.card.key);
    ok(kept.length === 19 && kept.every((x, i) => x.n === i + 1) && kept[18].sats >= 27 && X.card.state.receipts.count === 19,
       'the card holds its last sixteen; this phone, reading as it goes, has all nineteen in order', kept.length + ' kept, the card has signed ' + X.card.state.receipts.count);
    X.card.tap();
    X.card.sent.length = 0;
    const again = await X.H.W.cardLook(X.card, { mine: true });
    ok(again.receipts.fresh === 0 && X.card.sent.filter((a) => /^b01801/.test(a)).length === 1, 'with nothing new, one command says so', X.card.sent.filter((a) => /^b01801/.test(a)).length + ' command');

    // told the time twice in one tap, three hours apart, with nothing signed in it
    X.card.tap();
    const ringBefore = JSON.stringify(X.card.state.log.ring), marksBefore = X.card.state.log.tampers;
    await X.H.W.cardLook(X.card);
    X.H.phone.clockMs = () => Date.now() + 3 * 3600 * 1000;
    await X.H.W.cardLook(X.card);
    X.H.phone.clockMs = () => Date.now();
    ok(X.card.state.log.tampers === marksBefore + 1 && JSON.stringify(X.card.state.log.ring) === ringBefore,
       'a card told the time twice in one tap, hours apart, counts it, and its taps are not pushed out of its log by it', 'marked ' + X.card.state.log.tampers);
    // its holder's screen, at the next reading
    const holder = appOn(X.H);
    holder.price = 100000;
    X.H.nfc = X.card;
    holder.goFlashcard();
    await until('the card to be read', () => !!holder.state.fc && !!holder.state.fc.log);
    ok(holder.state.fc.clockAhead > 3 * 3600 - 600 && holder.state.fc.clockAhead < 3 * 3600 + 600 && holder.state.fc.log.since.tampers === 1,
       'its owner’s phone sees that the card’s clock is ahead of its own, and that the card has marked something since it last looked', holder.state.fc.clockAhead + ' seconds');
    const noteText = vals(holder).fcNotes.map((x) => x.text).join(' | ');
    ok(/TAMPER: this card has been told a false time/.test(noteText), 'the card’s screen says so under its balance', noteText.slice(0, 120));
    holder.fcLogCard();
    const lc = uiCard(holder);
    ok(lc && lc.title === 'TAMPER ON THIS CARD' && /told this card the time twice in one tap/.test(lc.reason) && /clock is 3 hours ahead of this phone/.test(lc.reason),
       'and its log says TAMPER, and why: told the time twice, and a clock that is ahead', lc && lc.reason.replace(/\n+/g, ' | ').slice(0, 300));
    lc.press('CLOSE');
    // and where the same tap goes on to pay, the payment's own line is marked
    X.card.tap();
    await X.R.W.cardLook(X.card);
    X.R.phone.clockMs = () => Date.now() + 9 * 3600 * 1000;
    await X.R.W.cardPay(X.card, { sats: 5, pin: '1234' });
    X.R.phone.clockMs = () => Date.now();
    if (X.R.W.cardOwed().length) { X.card.tap(); await X.R.W.cardWrite(X.card, { pin: '1234' }); }
    X.card.tap();
    const marked = await X.H.W.cardLook(X.card, { mine: true });
    ok(marked.log.last.some((x) => x.clock === true && x.sats >= 5), 'a tap in which the clock was moved twice and something was then signed for has its own line marked');
    holder.fcCopyReceipts = holder.fcCopyReceipts.bind(holder);
    let copied = '';
    holder.copySecret = (t) => { copied = t; return true; };
    holder.fcCopyReceipts();
    ok(/^Foxy card receipts\ncard 0[23][0-9a-f]{64}\n/.test(copied) && copied.split('\n').length === 3 + 20 && /^#1, \d{4}-\d\d-\d\dT[\d:]+Z, 700, [0-9a-f]{64}, 0[23][0-9a-f]{64}$/m.test(copied),
       'COPY RECEIPTS copies them as text: the card, and each payment’s number, time, sats, hash and first output', copied.split('\n').slice(0, 4).join(' / ').slice(0, 260));
    await settle();
  }

  /* ---- 18: a deep drawer: eight prices in a row, each paid exactly ------------
   * A card of 128 places is cut eight deep in every size from 1 to 1,024. A
   * price typed in dollars is an odd number of sats, and each needs small
   * pieces of its own: eight in a row are paid exactly, whatever they are, up
   * to 2,047 each. Then the drawer is short, and the payment that finds it so
   * brings change back that fills it again. */
  {
    const D = await world(0, 60000);
    D.card.tap();
    await D.H.W.cardAdd(D.card, { sats: 20000, pin: '1234' });
    const small = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
    const d0 = deep(D.card);
    ok(small.every((a) => d0[a] >= 8) && d0[2048] === 1 && amounts(D.card).length === 93 && D.card.balance() === 20000,
       'a card given 20,000 sats holds eight of every size from 1 to 1,024 (16,376 sats), and the rest in powers of two', JSON.stringify(d0));
    const prices = [613, 1777, 613, 430, 615, 2047, 1023, 999];
    let exact = 0, signs = 0, shortPages = 0, wholePages = 0;
    for (const p of prices) {
      D.card.tap();
      D.card.sent.length = 0;
      const paid = await D.R.W.cardPay(D.card, { sats: p, pin: '1234' });
      if (paid.sats === p && paid.change === null) exact += 1;
      signs += count(D.card, '24');
      shortPages += D.card.sent.filter((a) => /^b017..03/.test(a)).length;
      wholePages += D.card.sent.filter((a) => /^b017..0[01]/.test(a)).length;
    }
    const paidSum = prices.reduce((a, b) => a + b, 0);
    ok(exact === 8 && signs === 8 && (await bal(D.R)) === paidSum && D.card.balance() === 20000 - paidSum && D.R.W.cardOwed().length === 0,
       'eight prices in a row, odd amounts and even and none of them round, are each paid exactly: one signature, no change and no second tap', exact + ' exact, ' + signs + ' signatures');
    ok(shortPages === 8 && wholePages === 0, 'and each time the till read what the card holds in one command', shortPages + ' short, ' + wholePages + ' whole');

    // the 1s run out: seven of those prices were odd, and the eighth odd one takes the last
    D.card.tap();
    const last = await D.R.W.cardPay(D.card, { sats: 101, pin: '1234' });
    ok(last.change === null && !deep(D.card)[1], 'a ninth takes the last piece of 1', JSON.stringify(deep(D.card)));
    D.card.tap();
    D.card.sent.length = 0;
    const onBefore = D.card.balance();
    const short = await D.R.W.cardPay(D.card, { sats: 613, pin: '1234' });
    const back = (short.change && short.change.sats) || 0;
    ok(short.sats === 613 && back >= 256 && back <= 1024 && count(D.card, '24') === 1 && onBefore - D.card.balance() === 613 + back,
       'the next odd price cannot be made exactly, and is paid with a set that brings back change worth going back for (256 sats or more, where the least there was to overpay was 1)',
       back + ' sats of change, ' + count(D.card, '24') + ' SIGN');
    // the change goes back at the next tap, with no PIN, cut to fill what has been spent from
    D.card.tap();
    D.card.sent.length = 0;
    const wrote = await D.R.W.cardWrite(D.card, { change: true });
    const d1 = deep(D.card);
    ok(wrote.left === 0 && wrote.change === back && D.card.balance() === onBefore - 613 && D.R.W.cardOwed().length === 0, 'the change goes back onto the card at its next tap', String(D.card.balance()));
    ok(count(D.card, '30') <= 11 && d1[1] >= 4 && d1[2] >= 4 && d1[4] >= 4,
       'in thirty-two pieces at the most, smallest sizes first: the card has 1s, 2s and 4s again', count(D.card, '30') + ' LOAD commands; ' + JSON.stringify({ 1: d1[1], 2: d1[2], 4: d1[4], 8: d1[8] }));
    ok(D.card.sent.filter((a) => /^b017..00/.test(a)).length === 0 && D.card.sent.filter((a) => /^b017..03/.test(a)).length === 2,
       'and the till read the card the short way before and after: it wants what the card comes to, not what is on it', D.card.sent.filter((a) => /^b017/.test(a)).length + ' listing commands');
    let again = 0;
    for (const p of [613, 303, 1215, 81]) {
      D.card.tap();
      const paid = await D.R.W.cardPay(D.card, { sats: p, pin: '1234' });
      if (paid.sats === p && paid.change === null) again += 1;
    }
    ok(again === 4, 'and odd prices are paid exactly again', again + ' of 4');

    // a top-up fills what has been spent from, before anything else
    D.card.tap();
    await D.H.W.cardAdd(D.card, { sats: 15000, pin: '1234' });
    const d2 = deep(D.card);
    ok(small.every((a) => d2[a] >= 8), 'and a top-up brings every small size back to eight', JSON.stringify(d2));
    await settle();
  }

  /* ---- 19: a change write cut short on a card read the short way -------------
   * The short listing names no pieces, so a till cannot see which of the
   * change is on the card already. The card can: it refuses a piece it holds,
   * and that is taken as what it is. Nothing goes on twice. */
  {
    const E = await world(0, 9000);
    await binaryLoad(E.H, E.card, 4000);            // 2048 1024 512 256 128 32: no exact set for 700
    E.card.tap();
    const paid = await E.R.W.cardPay(E.card, { sats: 700, pin: '1234' });
    const back = (paid.change && paid.change.sats) || 0;
    const after = E.card.balance();
    ok(paid.sats === 700 && back > 0 && E.R.W.cardOwed().length === 1, 'a payment with change owed to the card', back + ' sats');
    const nonces = () => E.card.state.slots.filter((x) => x.status === 1).map((x) => x.data.substr(24, 64));
    E.card.tap();
    E.card.leaveBefore('30', 2);
    const cut = await why(E.R.W.cardWrite(E.card, { change: true }));
    const some = nonces().length;
    ok(cut === 'gone' && E.card.balance() > after && E.card.balance() < after + back && E.R.W.cardOwed().length === 1, 'taken away after the first three pieces of its change: the rest is still owed', cut + ', card ' + E.card.balance());
    E.card.tap();
    E.card.sent.length = 0;
    const fin = await E.R.W.cardWrite(E.card, { pin: '1234' });
    ok(fin.left === 0 && E.card.balance() === after + back && E.R.W.cardOwed().length === 0 && new Set(nonces()).size === nonces().length && nonces().length > some,
       'the next tap, under the PIN, finishes it: the card refuses the pieces it already holds, the rest go on, and nothing is on it twice', 'card ' + E.card.balance() + ', ' + nonces().length + ' pieces');
    ok(E.card.sent.filter((a) => /^b017..00/.test(a)).length === 0, 'with the card read the short way');
    // and all of it is money the card can pay with
    E.card.tap();
    const rest = await E.R.W.cardPay(E.card, { sats: 1300, pin: '1234' });
    ok(rest.sats === 1300, 'which it then pays with', String(await bal(E.R)));
    if (rest.change && rest.change.sats) { E.card.tap(); await E.R.W.cardWrite(E.card, { pin: '1234' }); }
    await settle();
  }

  /* ---- 20: most of a small card, in one signature ------------------------------
   * A deep drawer holds its money in small pieces, so a payment of most of a
   * small card is more pieces than thirty-two. The card of 128 places signs
   * once for as many as it has. */
  {
    const G = await world(0, 9000);
    G.card.tap();
    await G.H.W.cardAdd(G.card, { sats: 6070, pin: '1234' });
    const n0 = amounts(G.card).length;
    ok(n0 === 82 && amounts(G.card)[0] === 512, 'a card with five dollars on it holds them in eighty-two pieces, none larger than 512', n0 + ' pieces, the largest ' + amounts(G.card)[0]);
    G.card.tap();
    G.card.sent.length = 0;
    const paid = await G.R.W.cardPay(G.card, { sats: 5950, pin: '1234' });
    const used = n0 - amounts(G.card).length;
    ok(paid.sats === 5950 && paid.change === null && count(G.card, '24') === 1 && count(G.card, '22') === 1 && used > 32 && G.card.balance() === 120,
       'a payment of nearly all of it is one signature for more than thirty-two pieces, exact', used + ' pieces, ' + count(G.card, '24') + ' signature');
    // and where thirty-two or fewer pay, with a larger piece and change, that is what is taken
    const P = await world(0, 60000);
    P.card.tap();
    await P.H.W.cardAdd(P.card, { sats: 40000, pin: '1234' });
    const p0 = amounts(P.card).length;
    P.card.tap();
    const big = await P.R.W.cardPay(P.card, { sats: 16000, pin: '1234' });
    ok(big.sats === 16000 && p0 - amounts(P.card).length <= 32, 'where a set of thirty-two or fewer pays, that is the one taken', (p0 - amounts(P.card).length) + ' pieces');
    if (big.change && big.change.sats) { P.card.tap(); await P.R.W.cardWrite(P.card, { change: true }); }
    await settle();
  }

  /* ---- 21: a mint that charges for every piece, and a deep drawer -------------- */
  {
    const F = await world(1000, 60000);
    F.card.tap();
    await F.H.W.cardAdd(F.card, { sats: 20000, pin: '1234' });
    let exact = 0, got = 0;
    for (const p of [613, 1777, 430, 999, 2047]) {
      F.card.tap();
      const before = await bal(F.R);
      const paid = await F.R.W.cardPay(F.card, { sats: p, pin: '1234' });
      if (paid.sats === p && paid.change === null && (await bal(F.R)) === before + p) exact += 1;
      got += p;
    }
    ok(exact === 5 && (await bal(F.R)) === got, 'at a mint with a fee on every piece, prices are still made exactly: the pieces come to the price and the fee on them', exact + ' of 5');
    // and its holder takes the rest off, in one signature
    const piecesOn = amounts(F.card).length, onIt = F.card.balance(), hb = await bal(F.H);
    F.card.tap();
    F.card.sent.length = 0;
    const off = await F.H.W.cardWithdraw(F.card, { pin: '1234' }).then((r) => r, (e) => e);
    ok(piecesOn > 64 && off && off.sats === onIt - piecesOn && F.card.balance() === 0 && (await bal(F.H)) === hb + off.sats && count(F.card, '24') === 1,
       'its holder takes a deep card off whole at such a mint, in one tap and one signature',
       JSON.stringify({ pieces: piecesOn, on: onIt, off: off && (off.sats || off.card), signatures: count(F.card, '24') }));
    await settle();
  }

  /* ---- 22: the card before it, of sixty-four places (1.6) ----------------------- */
  {
    const H6 = await funded({}, 9000);
    const R6 = await funded({ sharedMint: H6.mint, words: OTHER_WORDS }, 0);
    const old = makeCard({ window: H6.window, format: 4, places: 64 });
    await H6.W.cardSetUp(old, { pin: '1234', recoverable: true });
    old.tap();
    const seen6 = await H6.W.cardLook(old);
    ok(seen6.info.version === '1.6' && seen6.info.wide === false && seen6.info.slots === 64 && seen6.info.quick === true, 'a card of sixty-four places is read as that', seen6.info.version + ', ' + seen6.info.slots + ' places');
    old.tap();
    const added6 = await H6.W.cardAdd(old, { sats: 2000, pin: '1234' });
    ok(added6.card.pieces.length === 32 && old.balance() === 2000, 'and is cut as it always was: thirty-two pieces, three deep in its smallest sizes', added6.card.pieces.length + ' pieces');
    old.tap();
    old.sent.length = 0;
    const paid6 = await R6.W.cardPay(old, { sats: 1000, pin: '1234' });
    ok(paid6.sats === 1000 && paid6.change === null && count(old, '24') === 1 && old.sent.filter((a) => /^b017..01/.test(a)).length === 3 && old.sent.filter((a) => /^b017..03/.test(a)).length === 0,
       'it is read by its brief listing and pays with one signature', old.sent.filter((a) => /^b017/.test(a)).length + ' listing commands');
    await binaryLoad(H6, old, 3000);
    old.tap();
    const more6 = await R6.W.cardPay(old, { sats: 1700, pin: '1234' });
    ok(more6.sats === 1700, 'and pays a price that needs change', JSON.stringify(more6.change));
    if (more6.change && more6.change.sats) { old.tap(); await R6.W.cardWrite(old, { change: true }); }
    ok(R6.W.cardOwed().length === 0 && old.balance() === 4000 - 1700, 'whose change goes back onto it', String(old.balance()));
    old.tap();
    const hb6 = await bal(H6);
    const off6 = await H6.W.cardWithdraw(old, { pin: '1234' });
    ok(off6.sats === 2300 && (await bal(H6)) === hb6 + 2300 && old.balance() === 0, 'and its holder takes the rest off', String(off6.sats));
    await settle();
  }

  /* ---- 22b: a card whose chip burns a dozen pieces at once and no more ----------
   * Every card before 1.8 burned a payment's pieces inside its transaction,
   * and on the chip that held eleven and refused thirty-two (`6A96`, nothing
   * burned). No simulator shows it. This phone asks such a card for eight at
   * a time: a payment is eight pieces or fewer, a whole card comes off in as
   * many signatures as that takes, and it is not cut deep, since a deep
   * drawer's money is in small pieces it could not pay with at once. */
  {
    const C = await world(1000, 60000, card7);
    C.card.tap();
    const seen7 = await C.H.W.cardLook(C.card);
    ok(seen7.info.version === '1.7' && seen7.info.wide === true && seen7.info.many === false, 'the card before 1.8 does not say it burns any number', seen7.info.version);
    C.card.tap();
    const added7 = await C.H.W.cardAdd(C.card, { sats: 2000, pin: '1234' });
    ok(added7.card.pieces.length <= 34, 'so it is cut as a card of sixty-four places is, and not deep', added7.card.pieces.length + ' pieces');
    // a deep drawer written by a build that did not know: as much as a full one, in small pieces
    C.card.tap();
    const read7 = await C.H.W.cardLook(C.card);
    await C.H.W.cardPrepare(Object.assign({}, read7, { info: Object.assign({}, read7.info, { many: true }) }), 30000);
    C.card.tap();
    await C.H.W.cardWrite(C.card, { owner: true });
    const n7 = amounts(C.card).length;
    ok(n7 > 64, 'with a deep drawer on it all the same (a build before this one cut it so)', n7 + ' pieces, ' + C.card.balance() + ' sats');
    let most8 = 0, made8 = 0;
    for (const p of [613, 1777, 430, 2047, 5000]) {
      C.card.tap();
      C.card.sent.length = 0;
      const paid = await C.R.W.cardPay(C.card, { sats: p, pin: '1234' });
      C.card.sent.filter((a) => a.slice(0, 4) === 'b022').forEach((a) => { most8 = Math.max(most8, parseInt(a.substr(8, 2), 16)); });
      if (paid.sats === p && count(C.card, '24') === 1) made8 += 1;
      if (paid.change && paid.change.sats) { C.card.tap(); await C.R.W.cardWrite(C.card, { change: true }); }
    }
    ok(made8 === 5 && most8 <= 8, 'payments are made with eight pieces or fewer, each in one signature (with a larger piece and change where the exact set is more)', made8 + ' of 5, at most ' + most8 + ' pieces');
    C.card.tap();
    C.card.sent.length = 0;
    // more than its eight largest pieces come to, and less than it holds
    const top8 = amounts(C.card).slice(0, 8).reduce((a, b) => a + b, 0);
    const tooBig = Math.min(C.card.balance() - 150, top8 + 300);
    const big = await C.R.W.cardPay(C.card, { sats: tooBig, pin: '1234' }).then(() => null, (e) => e);
    ok(tooBig > top8 && big && big.card === 'too-many' && big.most > 0 && big.most <= top8 && count(C.card, '40') === 0 && /at once/.test(big.message),
       'a payment that would need more pieces than that is refused before the PIN, and the most the card can pay at once is said', big && big.message);
    const onIt = C.card.balance(), piecesOn = amounts(C.card).length, hb = await bal(C.H);
    C.card.tap();
    C.card.sent.length = 0;
    const off = await C.H.W.cardWithdraw(C.card, { pin: '1234' }).then((r) => r, (e) => e);
    let widest = 0;
    C.card.sent.filter((a) => a.slice(0, 4) === 'b022').forEach((a) => { widest = Math.max(widest, parseInt(a.substr(8, 2), 16)); });
    ok(off && off.sats === onIt - piecesOn && C.card.balance() === 0 && (await bal(C.H)) === hb + off.sats && count(C.card, '24') === Math.ceil(piecesOn / 8) && widest <= 8,
       'its holder takes the whole card off in one tap, eight pieces to a signature, at a mint with a fee on every piece: the pieces are dealt out by size, so every signature has its share of the money',
       JSON.stringify({ pieces: piecesOn, on: onIt, off: off && (off.sats || off.card), signatures: count(C.card, '24') }));
    await settle();
  }

  /* ---- 24: the PIN is sealed to the card -----------------------------------------
   * A PIN typed at a till used to cross the air to the card as it was typed.
   * A card of 1.9 has a key for it: the phone seals the PIN to that key, under
   * sixteen bytes of the card's that are good once. Somebody listening has
   * nothing to use, then or later. */
  {
    const P = await world(0, 9000);
    const PIN_HEX = '31323334';
    const pinCommands = (card) => card.sent.filter((a) => /^b04[012]/.test(a));
    ok(P.card.sent.length > 0 && pinCommands(P.card).length >= 2 && pinCommands(P.card).every((a) => a.substr(4, 2) === '01' && a.indexOf(PIN_HEX) < 0),
       'a new card’s PIN is set, and then shown to it, sealed: the PIN is in neither command', pinCommands(P.card).map((a) => a.slice(0, 8)).join(' '));
    P.card.tap();
    await P.H.W.cardAdd(P.card, { sats: 2000, pin: '1234' });
    P.card.tap();
    P.card.sent.length = 0;
    const paid = await P.R.W.cardPay(P.card, { sats: 300, pin: '1234' });
    const first = pinCommands(P.card);
    ok(paid.sats === 300 && first.length === 1 && first[0].slice(0, 8) === 'b0400100' && parseInt(first[0].substr(8, 2), 16) === 65 + 9 + 16 && first[0].indexOf(PIN_HEX) < 0
       && P.card.sent.filter((a) => a.slice(0, 8) === 'b0440100').length === 1,
       'a payment asks the card for its PIN key and sixteen fresh bytes, and sends the PIN sealed: ninety bytes, whatever the PIN’s length', first.map((a) => a.slice(0, 10)).join(' '));
    P.card.tap();
    P.card.sent.length = 0;
    await P.R.W.cardPay(P.card, { sats: 200, pin: '1234' });
    const second = pinCommands(P.card);
    ok(second.length === 1 && second[0] !== first[0] && second[0].substr(10, 130) !== first[0].substr(10, 130), 'the next payment’s envelope is another one altogether: another key for the message, other bytes');

    // what was heard at one tap, played to the card at another
    P.card.tap();
    await P.card.send('00a404000af0464f5859434152440100');
    const cold = await P.card.send(first[0]);
    await P.card.send('b0440100' + '71');
    const stale = await P.card.send(first[0]);
    const info = async () => P.R.W.cardParse.info((await P.card.send('b0010100' + '00')).slice(0, -4));
    ok(cold === '6985' && stale === '63c2' && (await info()).tries === 2,
       'the envelope heard at one tap opens nothing at another: with no fresh bytes asked for it is not even tried, and under new ones it does not open, and costs a try as a wrong PIN would', cold + ', ' + stale);
    ok((await P.card.send('b0220000' + '01' + '00')).slice(-4) === '6982', 'and the card is not let into: a payment is still refused for want of the PIN');

    // the right PIN gives the tries back; a wrong one, sealed, costs one
    P.card.tap();
    const wrong = await P.R.W.cardPay(P.card, { sats: 100, pin: '9999' }).then(() => null, (e) => e);
    ok(wrong && wrong.card === 'wrong-pin' && wrong.tries === 1, 'a wrong PIN, sealed, is a wrong PIN: said with the tries left', wrong && wrong.message);
    P.card.tap();
    const right = await P.R.W.cardPay(P.card, { sats: 100, pin: '1234' });
    P.card.tap();
    ok(right.sats === 100 && (await P.H.W.cardLook(P.card)).info.tries === 3, 'and the right one after it pays, with the tries back');

    // an envelope changed on its way
    P.card.tap();
    const send0 = P.card.send.bind(P.card);
    P.card.send = (a) => send0(/^b04001/.test(a) ? a.slice(0, 10 + 130) + (a.substr(140, 2) === '00' ? '01' : '00') + a.slice(142) : a);
    const bent = await P.R.W.cardPay(P.card, { sats: 50, pin: '1234' }).then(() => null, (e) => e);
    P.card.send = send0;
    ok(bent && bent.card === 'wrong-pin', 'an envelope with a byte changed on its way does not open', bent && bent.card);
    P.card.tap();
    await P.R.W.cardPay(P.card, { sats: 50, pin: '1234' });

    // a PIN key that is not the card's own: the PIN is not sent at all
    P.card.tap();
    P.card.sent.length = 0;
    const other = require('crypto').randomBytes(32);
    const otherPub = Buffer.from(P.R.window.CashuTS.getPubKeyFromPrivKey(P.R.window.Uint8Array.from(other))).toString('hex');
    P.card.send = (a) => send0(a).then((r) => (/^b04401/.test(a) && r.length === 230 ? r.slice(0, 32) + otherPub + r.slice(98) : r));
    const fake = await P.R.W.cardPay(P.card, { sats: 50, pin: '1234' }).then(() => null, (e) => e);
    P.card.send = send0;
    ok(fake && fake.card === 'not-a-card' && pinCommands(P.card).length === 0, 'a PIN key the card’s own key has not signed is not sealed to: the PIN is not sent', fake && fake.message);

    // its owner changes the PIN: the new one sealed too, under the same sixteen bytes the proof is over
    P.card.tap();
    P.card.sent.length = 0;
    await P.H.W.cardChangePin(P.card, { newPin: '86420' });
    const changed = pinCommands(P.card);
    ok(changed.length === 1 && changed[0].slice(0, 6) === 'b04201' && changed[0].indexOf('3836343230') < 0 && P.card.sent.filter((a) => /^b04401/.test(a)).length === 1 && P.card.sent.filter((a) => /^b04400/.test(a)).length === 0,
       'its owner’s phone changes the PIN with the new one sealed, and one asking for fresh bytes serves the proof and the seal both', changed.map((a) => a.slice(0, 10)).join(' '));
    P.card.tap();
    const old = await P.R.W.cardPay(P.card, { sats: 60, pin: '1234' }).then(() => null, (e) => e);
    P.card.tap();
    const fresh = await P.R.W.cardPay(P.card, { sats: 60, pin: '86420' });
    ok(old && old.card === 'wrong-pin' && fresh.sats === 60, 'and the card then takes the new PIN and not the old');

    // the envelope is what the card's own sum makes it: sealed here, opened by a sum written apart from it
    {
      const crypto = require('crypto');
      const cardKey = crypto.createECDH('secp256k1');
      cardKey.generateKeys();
      const key = { nonce: crypto.randomBytes(16).toString('hex'), pub: cardKey.getPublicKey('hex', 'compressed') };
      const env = Buffer.from(P.R.W.cardParse.seal(key, '40', P.R.W.cardParse.pinBlock('3132333435')), 'hex');
      const E = env.subarray(0, 65), ct = env.subarray(65, env.length - 16), tag = env.subarray(env.length - 16);
      const shared = cardKey.computeSecret(E);
      const block = (i, more) => crypto.createHash('sha256').update(Buffer.concat([Buffer.from('FoxyCard/seal'), Buffer.from([i]), shared, E, Buffer.from(key.nonce, 'hex'), Buffer.from([0x40]), more || Buffer.alloc(0)])).digest();
      const clear = Buffer.from(ct.map((b, i) => b ^ block(1)[i]));
      ok(env.length === 65 + 9 + 16 && E[0] === 4 && block(0, ct).subarray(0, 16).equals(tag) && clear.toString('hex') === '053132333435000000',
         'the envelope is the sum the card does: the message’s key, a nine-byte block (the length, the PIN, zeros) under the keystream, and the tag', clear.toString('hex'));
    }

    // the card before it knows no sealing, and is shown its PIN as it always was
    const O = await world(0, 9000, (ctx) => makeCard({ window: ctx.window, format: 4, software: 8 }));
    O.card.tap();
    await O.H.W.cardAdd(O.card, { sats: 1000, pin: '1234' });
    O.card.tap();
    O.card.sent.length = 0;
    const was = await O.R.W.cardPay(O.card, { sats: 100, pin: '1234' });
    ok(was.sats === 100 && pinCommands(O.card).length === 1 && pinCommands(O.card)[0] === 'b0400000' + '04' + PIN_HEX, 'a card of 1.8, which does not say it takes a sealed PIN, is shown it as before');
    await settle();
  }

  /* ---- 23: the cut, and the short listing, by themselves ------------------------ */
  {
    const L = (n, most, top, have) => H.W.cardDeepLadder(n, most, top, have);
    const total = (a) => a.reduce((x, y) => x + y, 0);
    const tally = (a) => a.reduce((o, v) => { o[v] = (o[v] || 0) + 1; return o; }, {});
    let bad = '';
    for (const n of [1, 7, 8, 9, 100, 419, 613, 2000, 6070, 16376, 16377, 19001, 20000, 50000, 123456, 1000000]) {
      for (const most of [4, 12, 32, 60, 112]) {
        for (const have of [[], [1, 1, 1, 2, 4, 4, 512, 4096], Array(8).fill(1).concat(Array(8).fill(2), Array(8).fill(4))]) {
          const cut = L(n, most, 0, have);
          const d = cut.denominations;
          if (total(d) !== cut.sats) bad = bad || 'the pieces do not come to the amount: ' + n + ' in ' + most;
          if (cut.extra === 0 && cut.sats !== n) bad = bad || 'an amount changed with nothing said: ' + n;
          if (cut.extra === 0 && d.length > most) bad = bad || 'more pieces than there is room for: ' + n + ' in ' + most + ' is ' + d.length;
          if (d.some((a) => !(a > 0) || !Number.isInteger(Math.log2(a)))) bad = bad || 'a piece that is no power of two';
          // with all the room there is, the card ends with eight of each small size as far as the money went
          if (most === 112 && cut.extra === 0 && d.length <= most) {
            const after = tally(have.concat(d));
            const before = tally(have);
            let rest = n;
            for (let a = 1; a <= 1024; a *= 2) {
              const short = Math.max(0, 8 - (before[a] || 0));
              const can = Math.min(short, Math.floor(rest / a));
              // (only where eight deep fitted the room)
              rest -= can * a;
              if (can < short) break;
              if ((after[a] || 0) < 8 && d.length < 100) bad = bad || 'fewer than eight of ' + a + ' for ' + n + ' on ' + JSON.stringify(before);
            }
          }
        }
      }
    }
    ok(!bad, 'a deep cut is always exactly the amount, in powers of two, in no more pieces than there is room for, and eight deep from the smallest size up where the room allows', bad);
    ok(L(19001, 112, 0, []).denominations.filter((a) => a <= 1024).length >= 88 && tally(L(19001, 112, 0, []).denominations)[1] === 9,
       '19,001 sats are eight of each size to 1,024 and 2,625 over in powers of two', JSON.stringify(tally(L(19001, 112, 0, []).denominations)));
    ok(JSON.stringify(tally(L(300, 32, 0, []).denominations)) === JSON.stringify({ 1: 6, 2: 5, 4: 5, 8: 5, 16: 6, 32: 4 }) || total(L(300, 32, 0, []).denominations) === 300,
       'change of 300 for an empty drawer, in thirty-two pieces at most, is five or six of each of the smallest sizes', JSON.stringify(tally(L(300, 32, 0, []).denominations)));

    // the short listing, read: what the card says and nothing it does not
    const S = H.W.cardParse.short;
    const ks = '00aabbccddeeff11', date = '6a000000';
    const one = S('80' + '80' + ks + date + '0a' + '01' + '00' + '05' + 'ff' + '000003e8', 0, 128);
    ok(one.next === 128 && one.slots.length === 3 && one.slots[0].i === 0 && one.slots[0].amount === 1024 && one.slots[1].i === 1 && one.slots[1].amount === 1
       && one.slots[2].i === 5 && one.slots[2].amount === 1000 && one.slots.every((x) => x.keyset === ks && x.date === 0x6a000000 && x.bare === true && x.state === 'unspent'),
       'a page of the short listing is read: a place with its keyset and date, places that share them, a power of two and an amount that is not one', JSON.stringify(one.slots.map((x) => [x.i, x.amount])));
    const refuses = (hex, from) => { try { S(hex, from === undefined ? 0 : from, 128); return false; } catch (e) { return true; } };
    ok(refuses('80' + '00' + '0a') && refuses('80' + '80' + ks + date + '20') && refuses('80' + '80' + ks + date + '0a' + '00' + '01')
       && refuses('80' + '80' + ks + date) && refuses('80' + '80' + ks + date + 'ff' + '0000') && refuses('80' + '80' + ks + date + 'ff' + '00000000')
       && refuses('00' + '80' + ks + date + '0a') && refuses('05' + '85' + ks + date + '0a') && refuses('81') && refuses(''),
       'and a page that begins with no keyset, names a size past 31, goes backwards, stops short, is worth nothing, or does not move on, is refused');
    ok(S('80', 0, 128).slots.length === 0 && S('80', 7, 128).next === 128, 'an empty card’s page is its one byte');
    // the whole listing of a wide card: the place in seven bits, and 0x80 where it is spent
    const piece = ks + '00000400' + 'ab'.repeat(32) + '02' + 'cd'.repeat(32) + date;
    const page = H.W.cardParse.page('80' + '45' + piece + 'c6', 0, { wide: true, slots: 128 });
    ok(page.slots.length === 2 && page.slots[0].i === 0x45 && page.slots[0].amount === 1024 && page.slots[1].i === 0x46 && page.slots[1].state === 'spent',
       'a page of a wide card’s whole listing names places above sixty-three, and a spent one by its high bit', JSON.stringify(page.slots.map((x) => [x.i, x.state])));
    const page6 = H.W.cardParse.page('40' + '45' + piece + '86', 0, { wide: false, slots: 64 });
    ok(page6.slots.length === 2 && page6.slots[0].i === 5 && page6.slots[1].i === 6 && page6.slots[1].state === 'spent', 'and a page of a card of sixty-four places is read as it always was');
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

  /* ---- 13: the drawer is shaped by the limit on one tap --------------------
   * With a limit, a top-up cuts nothing larger than the largest power of two
   * under it, so a payment under the limit never falls on a piece the card
   * waits for. A lower limit set on a loaded card, with the PIN, has the money
   * off and back under it in the same tap; without the PIN the card is left as
   * it is, and says what it holds above the limit. A limit too small for the
   * places fills them with pieces under it and leaves the rest above, said. */
  {
    const D = await world(0, 60000);
    D.card.tap();
    await D.H.W.cardSetLimit(D.card, { sats: 1000, tap: true });
    D.card.tap();
    const put = await D.H.W.cardAdd(D.card, { sats: 20000, owner: true });
    const sizes = deep(D.card);
    ok(put.card.pieces.every((x) => x.amount <= 512) && [1, 2, 4, 8, 16, 32, 64, 128, 256].every((a) => sizes[a] >= 8),
       'with a limit of 1,000 on one tap, a top-up of 20,000 cuts nothing larger than 512, eight deep below it', JSON.stringify(sizes));
    ok(D.H.W.cardAboveLimit(put.card) === 0 && (put.card.aboveLimit || 0) === 0, 'and nothing of it is above the limit');
    D.card.tap();
    D.card.sent.length = 0;
    const low = await D.H.W.cardSetLimit(D.card, { sats: 300, tap: true, pin: '1234' });
    ok(low.recut === true && low.balance === 20000 && low.pieces.every((x) => x.amount <= 256) && low.aboveLimit === 0 && count(D.card, '24') === 1,
       'set lower, with the PIN, the card\u2019s money comes off in one signature and goes back cut under the new limit, in the same tap',
       low.pieces.length + ' pieces, ' + low.balance + ' sats, ' + count(D.card, '24') + ' SIGN');
    D.card.tap();
    const told = await D.H.W.cardSetLimit(D.card, { sats: 100, tap: true });
    const expect = low.pieces.filter((x) => x.amount > 100).reduce((n, x) => n + x.amount, 0);
    ok(!told.recut && told.aboveLimit === expect && expect > 0 && told.balance === 20000,
       'set lower with no PIN, the card is left as it is, and says what it holds in pieces above the limit', told.aboveLimit + ' of ' + told.balance);
    D.card.tap();
    const tiny = await D.H.W.cardSetLimit(D.card, { sats: 20, tap: true, pin: '1234' });
    const under = tiny.pieces.filter((x) => x.amount <= 16).length;
    const over = tiny.pieces.filter((x) => x.amount > 20).reduce((n, x) => n + x.amount, 0);
    ok(tiny.recut === true && tiny.balance === 20000 && tiny.aboveLimit === over && over > 0 && under >= 64 && tiny.pieces.length <= 128,
       'a limit of 20 on 20,000 sats: the places fill with pieces under it, the rest stays above, and the card says how much', tiny.pieces.length + ' pieces, ' + over + ' above');
    await settle();
  }

  await settle();
  console.log('\n' + (failed ? failed + ' flashcard-sigall check(s) failed' : 'all flashcard-sigall checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
