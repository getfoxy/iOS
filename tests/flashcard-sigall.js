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
const crypto = require('crypto');
const { funded, binaryLoad, why, history, settle, OTHER_WORDS, PHONE_WORDS } = require('./flashcard-kit');
const { makeCard } = require('./flashcard-card');
const { appOn, until, pad, stage, card: uiCard, explainer: uiExplainer, vals } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
// the latest card the model has: software 1.15, whose clock is Bitcoin block headers. Its wait and its change are those of 1.14, whose change counts
// toward its wait for what it cost, two for every three pieces; what 1.15 changes is the clock (tests/flashcard-clock.js)
const card4 = (ctx) => makeCard({ window: ctx.window, format: 4 });
// the card before it (1.14): the same wait and the same change, and a clock that is a time told under a signature, which a terminal can be made to lie about
const card14 = (ctx) => makeCard({ window: ctx.window, format: 4, software: 14 });
// the card before it (1.13): the same, but it takes one wait off for each piece of change it made
const card13 = (ctx) => makeCard({ window: ctx.window, format: 4, software: 13 });
// the card before that: it makes its own change in up to eight pieces cut to its drawer, and waits four signatures to a limit's worth (1.12)
const card12 = (ctx) => makeCard({ window: ctx.window, format: 4, software: 12 });
const amounts = (card) => card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(16, 8), 16)).sort((a, b) => b - a);
// how many pieces of each size are on a card
const deep = (card) => amounts(card).reduce((o, a) => { o[a] = (o[a] || 0) + 1; return o; }, {});
const dates = (card) => Array.from(new Set(card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(154, 8), 16))));
const count = (card, ins) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + ins).length;
const swaps = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.swaps') || '[]');
const owedRows = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.owed') || '[]');
const WORDS3 = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const WORDS4 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
function later(c, ms) {
  const real = c.window.Date.now.bind(c.window.Date);
  c.window.Date.now = () => real() + ms;
  return () => { c.window.Date.now = real; };
}
const DAY = 24 * 3600 * 1000;
// what a payment that leaves the card for this many sats waits under a limit on one payment, in SIGN commands before the signature (software 1.13 and 1.14):
// nothing within the limit (or a thirty-second over it), 7 for the first limit's worth over it and 3 for each after, whole or in part, less what the
// pieces of change the card made (`made`) count for: one for each in 1.13, two for every three from 1.14 (`costed`)
const waitsOf = (sats, limit, made, costed) => {
  const units = sats <= limit + Math.floor(limit / 32) ? 1 : Math.min(255, Math.ceil(sats / limit));
  const done = costed ? Math.floor(2 * (made || 0) / 3) : (made || 0);
  return units <= 1 ? 0 : Math.max(0, 7 + 3 * (units - 2) - done);
};
// and software 1.12's: nothing within the limit, and four to every limit's worth over it, whole or in part. With change, a payment within the limit waits four.
const waitsOf12 = (sats, limit) => (sats <= limit ? 0 : 4 * Math.ceil(sats / limit));

// the card as it was on the chip before 1.8: 128 places, and a transaction that held about a dozen pieces and no more
const card7 = (ctx) => makeCard({ window: ctx.window, format: 4, software: 7, burnMost: 11 });
// the card before it made its own change (1.12): the change is made by the till, after the swap, and the wait is by the pieces
const card11 = (ctx) => makeCard({ window: ctx.window, format: 4, software: 11 });
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
  ok(seen.info.format === 4 && seen.info.version === '1.15' && seen.info.headers === true && seen.info.shaped === true && seen.info.costed === true && seen.info.ownChange === true && seen.info.paced === true && seen.info.quick === true && seen.info.wide === true && seen.info.many === true && seen.info.sealed === true && seen.info.slots === 128,
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
    {
      // a card of 1.13 slows a second payment signed in a time in the field unless the owner's grant is in the tap: the grant (ALLOW_LOAD)
      // is sent first, and no SELECT comes between it and the last of the signatures, which would take it away
      const seq = T.card.sent.map((a) => (a.slice(0, 4) === '00a4' ? 'select' : a.slice(2, 4)));
      const grant = seq.indexOf('45'), firstSign = seq.indexOf('24'), lastSign = seq.lastIndexOf('24');
      ok(nDates === 2 && grant >= 0 && grant < firstSign && seq.lastIndexOf('select') < grant && lastSign > firstSign && seq.slice(firstSign, lastSign).indexOf('select') < 0,
         'the owner’s phone gives its grant before the first of the signatures, and no new SELECT takes it away before the last: the second is not slowed', seq.join(' '));
    }
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
   * The card refuses nothing over it. Over the limit it does signatures of
   * work before it signs, a SIGN command each (seven for the first limit's
   * worth over it, three for each after: software 1.13), and nothing is burned
   * until the last. Nothing is counted from one payment to the next, and no
   * time is asked. */
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
    // over it: a limit's worth more is seven signatures of work, then the signature
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
    ok(over.sats === 500 && (await bal(L.R)) === 1300 && count(L.card, '24') === 8,
       'a payment of 500 is made, after the card has been asked seven times to wait: over the limit of 400, which is the first limit’s worth over it', count(L.card, '24') + ' SIGN commands');
    ok(said.join(',') === '1,2,3,4,5,6,7' && answers.join(',') === '0001,0001,0001,0001,0001,0001,0001',
       'the card says only "not yet", never how many waits are left, and the screen counts what has been', said.join(',') + ' / ' + answers.join(','));
    ok(L.card.state.log.ring.some((e) => (e.flags & 2) === 2), 'and the card’s own log marks that tap as over its limit');
    // the card before 1.12 waits by what its pieces come to, so the pieces are chosen to overpay the least
    {
      const C = await world(0, 9000, card11);
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
         'a card before 1.12 is paid a price with no exact set with the pieces that overpay it least (256 for 250), not a larger set the card would wait for: that one is given up at the card’s first "not yet", and nobody is told to keep holding',
         'card ' + C.card.balance() + ', ' + count(C.card, '24') + ' SIGN, ' + holding.length + ' told to hold');
      ok(!C.card.state.log.ring.some((e) => (e.flags & 2) === 2), 'and the card’s log does not mark that tap as over its limit: the payment it signed for was not');
      if (p.change && p.change.sats) { C.card.tap(); await C.R.W.cardWrite(C.card, { pin: '1234' }); }
      await settle();
    }
    /* From 1.12 the wait is by what leaves the card, and a larger piece costs none: the price is 250, within the limit of
     * 300, so whichever set pays, it is the change that a card of 1.12 waits for (one limit's worth, four SIGN), and a card of
     * 1.13 or 1.14 waits for nothing: within the limit it goes at once, change or no change. The set that fills the drawer is taken
     * and nobody is sent round to a cheaper one, which would make change as well. */
    for (const [label, make, waits] of [['1.12', card12, 4], ['1.13', card13, 0], ['1.15', card4, 0]]) {
      const C = await world(0, 9000, make);
      await binaryLoad(C.H, C.card, 2000);          // 1024 512 256 128 64 16
      C.card.tap();
      await C.H.W.cardSetLimit(C.card, { sats: 300, tap: true });
      C.card.tap();
      C.card.sent.length = 0;
      const holding = [];
      const p = await C.R.W.cardPay(C.card, { sats: 250, pin: '1234', progress: (q) => { if (q.step === 'waiting') holding.push(q); } });
      ok(p.sats === 250 && count(C.card, '22') === 1 && count(C.card, '24') === 1 + waits && C.card.balance() === 2000 - 250 - p.change.sats && p.change.sats > 0,
         'a card of ' + label + ' is paid with the one set, whatever it overpays, and ' + (waits ? 'waits a limit’s worth for its change: begun once, four "not yet" before the signature' : 'waits for nothing, within the limit, with its change: begun once, signed at the first asking'),
         'card ' + C.card.balance() + ', ' + count(C.card, '24') + ' SIGN, ' + count(C.card, '22') + ' BEGIN');
      ok(holding.length === waits && holding.every((q) => q.making === true) && C.card.state.log.ring.some((e) => (e.flags & 2) === 2) === (waits > 0),
         waits ? 'the till was told it was making change, four times, and the card’s log marks that tap as one that waited' : 'the till was told nothing to hold for, and the card’s log does not mark the tap as one that waited', holding.length + ' told to hold');
      C.card.tap();
      await C.R.W.cardWrite(C.card, { change: true });
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
    ok(then.sats === 700 && signedFor >= 700 && count(L.card, '24') === 1 + waitsOf(signedFor, 400) && count(L.card, '25') === 0 && swaps(L.R).length === 0,
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
    ok(got.trusted === true && got.sats === 592 && got.change === null && count(O.card, '24') === 1 && count(O.card, '26') === 0 && O.card.balance() === 2000 - 592,
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
    ok(which && which.title === 'CHANGE CARD LIMITS' && which.reason === 'Which limit would you like to add or change?', 'CHANGE CARD LIMITS asks which limit, in one line', which && which.reason);
    which.press('PER TAP LIMIT');
    ok(uiExplainer(holder) && !uiCard(holder) && uiExplainer(holder).title === 'How tap limit works', 'and PER TAP LIMIT opens HOW TAP LIMIT WORKS, the rule played out', uiExplainer(holder) && uiExplainer(holder).title);
    uiExplainer(holder).finish();
    uiExplainer(holder).press('CONTINUE');
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
    ok((await bal(V.R)) === 1500 && count(V.card, '24') === 1 + waitsOf(1500, 1000),
       'a charge of one and a half limits is paid after the card has waited for the first limit’s worth over it: seven', (await bal(V.R)) + ', ' + count(V.card, '24') + ' SIGN');
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

  /* ---- 17: receipts, and a false time (a card of software 1.14) ----------------
   * For each payment the card keeps when, how much, the hash of what it signed
   * and the first output the money went into, and gives them to its owner's
   * phone and to no other. The output is the receiver's own (made from its
   * seed): it is in the swap the till itself sent. And the card's clock: told
   * twice in one tap, far apart, the card writes it down; ahead of this
   * phone's, this phone says so.
   *
   * That last is a card whose clock is a time it is told under a signature,
   * which is software 1.14 and before. A card of 1.15 is shown block headers
   * and cannot be told a false time, so it has no such mark: its receipts (77
   * bytes, with the time the terminal told it beside its own clock), its log
   * (20) and what the screens make of them are in tests/flashcard-clock.js. */
  {
    const X = await world(0, 9000, card14);
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
   * brings change back that fills it again: in thirty-two pieces at the most
   * made here after the swap (the card before 1.12), or in the eight pieces
   * the card makes of its own change (1.12). A card of 1.13 or later does not restock the
   * drawer with its change: it is cut plainly, in four pieces at the most, and the
   * least that is overpaid is the change, a few sats; that is a top-up's job. */
  for (const [version, make] of [['1.11', card11], ['1.12', card12], ['1.15', card4]]) {
    const own = version !== '1.11', shaped = version === '1.15';
    const D = await world(0, 60000, make);
    D.card.tap();
    await D.H.W.cardAdd(D.card, { sats: 20000, pin: '1234' });
    const small = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
    const d0 = deep(D.card);
    ok(small.every((a) => d0[a] >= 8) && d0[2048] === 1 && amounts(D.card).length === 93 && D.card.balance() === 20000,
       'a card given 20,000 sats holds eight of every size from 1 to 1,024 (16,376 sats), and the rest in powers of two', JSON.stringify(d0));
    const prices = [613, 1777, 613, 430, 615, 2047, 1023, 999];
    let exact = 0, signs = 0, shortPages = 0, wholePages = 0, asked = 0;
    for (const p of prices) {
      D.card.tap();
      D.card.sent.length = 0;
      const paid = await D.R.W.cardPay(D.card, { sats: p, pin: '1234' });
      if (paid.sats === p && paid.change === null) exact += 1;
      signs += count(D.card, '24');
      asked += count(D.card, '26');
      shortPages += D.card.sent.filter((a) => /^b017..03/.test(a)).length;
      wholePages += D.card.sent.filter((a) => /^b017..0[01]/.test(a)).length;
    }
    const paidSum = prices.reduce((a, b) => a + b, 0);
    ok(exact === 8 && signs === 8 && asked === 0 && (await bal(D.R)) === paidSum && D.card.balance() === 20000 - paidSum && D.R.W.cardOwed().length === 0,
       'eight prices in a row, odd amounts and even and none of them round, are each paid exactly: one signature, no change and no second tap, and the card asked for none of its own', exact + ' exact, ' + signs + ' signatures');
    ok(shortPages === 8 && wholePages === 0, 'and each time the till read what the card holds in one command', shortPages + ' short, ' + wholePages + ' whole');

    // the 1s run out: seven of those prices were odd, and the eighth odd one takes the last
    D.card.tap();
    const last = await D.R.W.cardPay(D.card, { sats: 101, pin: '1234' });
    ok(last.change === null && !deep(D.card)[1], 'a ninth takes the last piece of 1', JSON.stringify(deep(D.card)));
    D.card.tap();
    D.card.sent.length = 0;
    const onBefore = D.card.balance();
    const piecesBefore = amounts(D.card).length;
    const short = await D.R.W.cardPay(D.card, { sats: 613, pin: '1234' });
    const back = (short.change && short.change.sats) || 0;
    const made = count(D.card, '26');
    const usedUp = piecesBefore - amounts(D.card).length;
    if (shaped) {
      ok(short.sats === 613 && back >= 1 && back < 64 && count(D.card, '24') === 1 && onBefore - D.card.balance() === 613 + back && made >= 1 && made <= 4,
         version + ': the next odd price cannot be made exactly, and is paid with the set that overpays least, whose change the card makes itself in four pieces at the most (nothing is restocked by it)',
         back + ' sats of change, ' + count(D.card, '24') + ' SIGN, ' + made + ' of the card’s own pieces');
    } else {
      ok(short.sats === 613 && back >= 256 && back <= 1024 && count(D.card, '24') === 1 && onBefore - D.card.balance() === 613 + back && (own ? made >= 1 && made <= 8 : made === 0),
         version + ': the next odd price cannot be made exactly, and is paid with a set that brings back change worth going back for (256 sats or more, where the least there was to overpay was 1)'
         + (own ? ', the card making the change itself in eight pieces at the most' : ''),
         back + ' sats of change, ' + count(D.card, '24') + ' SIGN, ' + made + ' of the card’s own pieces');
    }
    // the change goes back at the next tap, with no PIN, cut to fill what has been spent from
    D.card.tap();
    D.card.sent.length = 0;
    const wrote = await D.R.W.cardWrite(D.card, { change: true });
    const d1 = deep(D.card);
    ok(wrote.left === 0 && wrote.change === back && D.card.balance() === onBefore - 613 && D.R.W.cardOwed().length === 0, 'the change goes back onto the card at its next tap', String(D.card.balance()));
    if (shaped) {
      const onIt = amounts(D.card).length - (piecesBefore - usedUp);
      ok(onIt >= 1 && onIt <= 4 && count(D.card, '30') === 1,
         version + ': in four pieces at the most, since that is all the card makes of its own change at once: one command', count(D.card, '30') + ' LOAD commands; ' + onIt + ' pieces');
    } else if (own) {
      const onIt = amounts(D.card).length - (piecesBefore - usedUp);
      ok(onIt <= 8 && count(D.card, '30') <= 3,
         version + ': in eight pieces at the most, since that is all the card makes of its own change at once: three to a command', count(D.card, '30') + ' LOAD commands; ' + onIt + ' pieces');
    } else {
      ok(count(D.card, '30') <= 11 && d1[1] >= 4 && d1[2] >= 4 && d1[4] >= 4,
         'in thirty-two pieces at the most, smallest sizes first: the card has 1s, 2s and 4s again', count(D.card, '30') + ' LOAD commands; ' + JSON.stringify({ 1: d1[1], 2: d1[2], 4: d1[4], 8: d1[8] }));
    }
    ok(D.card.sent.filter((a) => /^b017..00/.test(a)).length === 0 && D.card.sent.filter((a) => /^b017..03/.test(a)).length === 2,
       'and the till read the card the short way before and after: it wants what the card comes to, not what is on it', D.card.sent.filter((a) => /^b017/.test(a)).length + ' listing commands');
    let again = 0, allPaid = true;
    for (const p of [613, 303, 1215, 81]) {
      D.card.tap();
      D.card.sent.length = 0;
      const paid = await D.R.W.cardPay(D.card, { sats: p, pin: '1234' });
      if (paid.sats === p && paid.change === null) again += 1;
      // (a card of 1.13 makes its change in four pieces at the most, whatever the payment)
      allPaid = allPaid && paid.sats === p && (!shaped || count(D.card, '26') <= 4);
    }
    // (eight pieces fill less of the drawer than thirty-two did, so a card that makes its own change is not made exact for as many; a card of 1.13 restocks nothing, and is paid with change until it is topped up)
    ok(allPaid && (shaped ? again >= 0 : own ? again >= 1 : again === 4), version + ': ' + (shaped ? 'a drawer that is short of small pieces stays short until it is topped up: the prices after are all paid, with the change the pieces it has allow, never more than four pieces of it made by the card' : 'and odd prices are paid exactly again' + (own ? ' where the pieces it was given allow' : '')), again + ' of 4 exact');

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
   * and that is taken as what it is. Nothing goes on twice. (The change here
   * is made by the till and written as a token: the card before 1.12. The
   * card's own change that a tap cut short is finished from its openings is
   * 25g.) */
  {
    const E = await world(0, 9000, card11);
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

  /* ---- 25: the card makes its own change (software 1.12, and 1.13 and later) ------------
   * 1,000 from 1024 512 256 128 64 16: a card of 1.12 takes the 1024 and the 256 (a deep drawer's refill) and gets 280 back, in three pieces
   * it makes itself; a card of 1.13 or later takes the 1024 alone and gets 24 back, in two (16 and 8). */
  for (const [label, make, owedChange] of [['1.12', card12, 280], ['1.15', card4, 24]]) {
    const OC = await world(0, 9000, make);
    const CT = OC.R.window.CashuTS;
    const own = (buf) => OC.R.window.Uint8Array.from(buf);
    await binaryLoad(OC.H, OC.card, 2000);            // 1024 512 256 128 64 16: no exact set for 1000
    ok(amounts(OC.card).join('+') === '1024+512+256+128+64+16', 'a card with no exact set for 1000', amounts(OC.card).join('+'));
    OC.card.tap();
    OC.card.sent.length = 0;
    // the swap is looked at as it leaves for the mint: the row it was written down in, and the request itself
    let atSend = null, request = null;
    OC.R.fate = (m) => {
      if (!/\/v1\/swap$/.test(String(m.url || '')) || request) return null;
      request = JSON.parse(m.body);
      atSend = { swap: swaps(OC.R)[0] || null, owed: owedRows(OC.R).length };
      return null;
    };
    const steps = [];
    const paid = await OC.R.W.cardPay(OC.card, { sats: 1000, pin: '1234', on: (s) => steps.push(s) });
    OC.R.fate = null;
    const order = OC.card.sent.map((a) => a.slice(2, 4)).filter((i) => /^(22|23|26|24)$/.test(i)).join(' ');
    const k = count(OC.card, '26');
    ok(paid.sats === 1000 && (await bal(OC.R)) === 1000 && k >= 1 && k <= 8 && count(OC.card, '24') === 1 && count(OC.card, '22') === 1,
       'a payment the card cannot make exactly: the till is paid exactly the price, and the card is asked for its own change, one command an output', 'paid ' + (await bal(OC.R)) + ', ' + k + ' change commands');
    ok(/^22( 23)+( 26)+ 24$/.test(order), 'in the order its outputs are hashed in: the pieces, the till’s outputs, the card’s change, and the signature', order);
    const asked = OC.card.sent.filter((a) => a.slice(0, 4) === 'b026').map((a) => parseInt(a.substr(10, 8), 16));
    const got = paid.change.sats;
    ok(asked.reduce((a, b) => a + b, 0) === got && got === owedChange && OC.card.sent.filter((a) => a.slice(0, 4) === 'b026').every((a) => a.substr(8, 2) === '04'),
       'a command names an amount and nothing else, and the amounts are the pieces’ worth over the price', asked.join('+') + ' = ' + got);
    // the request the mint was sent: the till's outputs, then the card's, in the order the card hashed them
    const outs = request.outputs;
    const tail = outs.slice(outs.length - k);
    const openings = OC.card.state.openings.filter((x) => x.state === 'pending');
    const blindedFor = (op) => CT.blindMessage(own(Buffer.from(OC.R.W.cardSecret(op.nonce, OC.card.key, op.date, OC.card.state.record.refund, 4), 'utf8')), BigInt('0x' + op.r)).B_.toHex(true);
    ok(tail.map((o) => o.amount).join(',') === asked.join(',') && tail.every((o, i) => openings.some((op) => op.amount === o.amount && blindedFor(op) === o.B_)),
       'the card’s blinded messages are the last outputs of the swap, in the order it made them, and each is the secret its nonce makes, hashed to the curve, plus r times G',
       outs.length + ' outputs, the last ' + k + ' the card’s');
    ok(outs.slice(0, outs.length - k).reduce((n, o) => n + o.amount, 0) === 1000 && outs.reduce((n, o) => n + o.amount, 0) === request.inputs.reduce((n, p) => n + p.amount, 0),
       'the till’s own outputs come to the price, and all of them to the pieces', '');
    // the signature is over every piece and every output, in that order
    const text = request.inputs.map((p) => p.secret + p.C).join('') + outs.map((o) => String(o.amount) + o.B_).join('');
    const sig = JSON.parse(request.inputs[0].witness).signatures[0];
    let good = false;
    try { good = CT.schnorrVerifyMessage(sig, text, OC.card.key) === true; } catch (e) { good = false; }
    ok(good && text === OC.card.state.lastText && request.inputs.filter((p) => p.witness).length === 1,
       'the card’s one signature verifies over the pieces and all the outputs in that order, and is the message the card says it signed', 'the first piece carries it, the others none');
    // the row it was written down in has every output, with the card's, before the card signed
    ok(atSend && atSend.swap && atSend.swap.change && atSend.swap.change.outs.length === k
       && atSend.swap.change.outs.every((o, i) => o.B_ === tail[i].B_ && o.amount === tail[i].amount) && atSend.swap.amounts.length === outs.length - k
       && !atSend.swap.asked && atSend.owed === 0,
       'the swap’s row held the card’s blinded messages by the time the mint was sent the swap, and nothing was owed to the card yet', atSend && JSON.stringify(atSend.swap && atSend.swap.change && atSend.swap.change.outs.length));
    // the row the card is owed: the mint's signatures, and no token
    const rows = owedRows(OC.R);
    ok(rows.length === 1 && rows[0].kind === 'change' && rows[0].sats === got && !rows[0].token && Array.isArray(rows[0].blind) && rows[0].blind.length === k
       && rows[0].blind.every((b, i) => b.B_ === tail[i].B_ && b.amount === tail[i].amount && /^0[23][0-9a-f]{64}$/.test(b.C_) && !!b.dleq && /^0[23][0-9a-f]{64}$/.test(b.K) && b.id === request.outputs[0].id)
       && rows[0].forHash === paid.hash,
       'what the card is owed is the mint’s signature on each of its outputs, with its DLEQ and the key for the size, and no token', JSON.stringify(Object.keys(rows[0] || {})));
    ok(swaps(OC.R).length === 0 && OC.R.W.cardTaken().length === 0 && OC.R.W.cardOwed().length === 1 && OC.R.W.cardOwed()[0].sats === got, 'and the swap’s row is gone once it is owed');
    const e = history(OC.R).filter((x) => x.hash === paid.hash)[0] || {};
    ok(e.sats === 1000 && e.feeSats === 0 && e.grossSats === 1000 + got && e.changeSats === got && e.changeState === 'not handed',
       'its entry says 1,000 kept, no fee, and the change owed back to the card, not as the mint’s fee', JSON.stringify({ sats: e.sats, fee: e.feeSats, gross: e.grossSats, change: e.changeSats, state: e.changeState }));
    ok(paid.change.written === false && steps.indexOf('checking') >= 0, 'the sheet is kept for the change tap, as for change made here', JSON.stringify(paid.change));
    ok((await bal(OC.R)) === 1000 && OC.H.mint.issuedSats() - OC.H.mint.takenSats() === (await bal(OC.R)) + (await bal(OC.H)) + OC.card.balance() + got + 0,
       'the books: every sat is in the till, the holder, the card, or signed for the card and waiting', String(OC.H.mint.issuedSats() - OC.H.mint.takenSats()));

    // the change tap
    OC.card.tap();
    OC.card.sent.length = 0;
    const before = OC.card.balance();
    const wrote = await OC.R.W.cardWrite(OC.card, { change: true });
    ok(wrote.left === 0 && wrote.change === got && OC.card.balance() === before + got && OC.R.W.cardOwed().length === 0 && owedRows(OC.R).length === 0,
       'the next tap finishes the pieces from the card’s openings, with no PIN, and nothing is owed after', 'the card has ' + OC.card.balance());
    ok(count(OC.card, '19') === Math.floor(k / 3) + 1 && count(OC.card, '40') === 0 && count(OC.card, '30') === Math.ceil(k / 3),
       'its openings are read a page at a time while a page is full, once, and the pieces go on three to a command', count(OC.card, '19') + ' pages, ' + count(OC.card, '30') + ' LOAD');
    ok((await OC.card.send('b019000000')) === '009000' && OC.card.state.openings.every((x) => x.state === 'empty'), 'and the card lists none after: it let each opening go as its piece was written');
    const e2 = history(OC.R).filter((x) => x.hash === paid.hash)[0] || {};
    ok(e2.changeState === 'given back', 'the entry says the change is given back', e2.changeState);
    // and the pieces are the card's to spend: every one of them, with the rest, pays 1000 at the mint
    OC.card.tap();
    const rest = await OC.R.W.cardPay(OC.card, { sats: 1000, pin: '1234' });
    ok(rest.sats === 1000 && OC.card.balance() === 0 && (await bal(OC.R)) === 2000, 'the pieces made from the card’s openings are good for the mint: the whole card pays 1,000 more', (await bal(OC.R)) + ', card ' + OC.card.balance());
    await settle();
  }


  /* ---- 25b: the wait is by what leaves the card ---------------------------------
   * Within the limit with no change: nothing. Over it: ceil(net / limit) limits' worth, with change or without.
   * Software 1.12: within it with change, one limit's worth of waiting (four SIGN), and four to a limit's worth over it.
   * Software 1.13: within it, nothing at all, change or no change; over it seven SIGN for the first limit's worth over it and
   * three for each after, less one for every piece of change the card made. Software 1.14 and 1.15: the same, but the change counts for
   * what it cost, two for every three pieces. */
  for (const [label, make] of [['1.12', card12], ['1.13', card13], ['1.15', card4]]) {
    const shaped = label !== '1.12', costed = label === '1.15';
    const WC = await world(0, 9000, make);
    await WC.H.W.cardAdd(WC.card, { sats: 3000, pin: '1234' });      // a deep drawer: most prices are exact
    WC.card.tap();
    await WC.H.W.cardSetLimit(WC.card, { sats: 400, tap: true });
    const sign = async (sats) => { WC.card.tap(); WC.card.sent.length = 0; const p = await WC.R.W.cardPay(WC.card, { sats, pin: '1234' }); return { p, signs: count(WC.card, '24'), changes: count(WC.card, '26') }; };
    let r = await sign(392);
    ok(r.p.sats === 392 && r.changes === 0 && r.signs === 1, label + ': within the limit with no change (an exact set): signed at once', r.signs + ' SIGN, ' + r.changes + ' change');
    r = await sign(400);
    ok(r.p.sats === 400 && r.changes === 0 && r.signs === 1, label + ': exactly the limit with no change: at once', r.signs + ' SIGN');
    r = await sign(900);
    ok(r.p.sats === 900 && r.changes === 0 && r.signs === 1 + (shaped ? waitsOf(900, 400) : waitsOf12(900, 400)),
       label + ': over it with no change: ceil(900 / 400) = 3 limits’ worth, ' + (shaped ? '7 + 3 = 10' : '12') + ' waits', r.signs + ' SIGN');
    // a card with no exact set for the price: change is unavoidable
    const NC = await world(0, 9000, make);
    await binaryLoad(NC.H, NC.card, 4000);
    NC.card.tap();
    await NC.H.W.cardSetLimit(NC.card, { sats: 400, tap: true });
    const signN = async (sats) => {
      NC.card.tap(); NC.card.sent.length = 0; const said = [];
      const p = await NC.R.W.cardPay(NC.card, { sats, pin: '1234', progress: (q) => { if (q.step === 'waiting') said.push(q); } });
      const cardMade = NC.card.sent.filter((a) => a.slice(0, 4) === 'b026').reduce((n, a) => n + parseInt(a.substr(10, 8), 16), 0);
      return { p, signs: count(NC.card, '24'), changes: count(NC.card, '26'), said, cardMade };
    };
    r = await signN(250);
    if (shaped) {
      ok(r.p.sats === 250 && r.changes >= 1 && r.signs === 1 && r.said.length === 0,
         label + ': within the limit but with change made by the card: nothing to wait for, signed at the first asking, and the till is told nothing to hold for', r.signs + ' SIGN, ' + r.said.length + ' told to hold, ' + r.changes + ' pieces of change');
    } else {
      ok(r.p.sats === 250 && r.changes >= 1 && r.signs === 1 + 4 && r.said.length === 4 && r.said.every((q) => q.making === true),
         label + ': within the limit but with change made by the card: one limit’s worth of waiting, three seconds, and the till says the card is making change', r.signs + ' SIGN, ' + r.said.length + ' told to hold');
    }
    const till = appOn(NC.R, { screen: 'confirm' });
    if (!shaped) ok(/^The card is making change\. Keep holding \(\d+ s\)$/.test(till.fcProgressText(r.said[0])), 'in those words', till.fcProgressText(r.said[0]));
    NC.card.tap(); await NC.R.W.cardWrite(NC.card, { change: true });
    r = await signN(900);
    if (shaped) {
      // what leaves the card: the price, and the part of the change the card did not make (made here after the swap)
      const leaves = 900 + (r.p.change.sats - r.cardMade);
      const waits = waitsOf(leaves, 400, r.changes, costed);
      ok(r.p.sats === 900 && r.changes >= 1 && r.signs === 1 + waits && r.said.length === waits && r.said.every((q) => q.making === false),
         label + ': over the limit with change: the wait is the limit’s, with ' + (costed ? 'two signatures done for every three pieces of change the card made' : 'one signature done for every piece of change the card made') + ', and said as over the limit and never as making change',
         r.signs + ' SIGN, ' + r.changes + ' pieces of change, ' + waits + ' waits for ' + leaves + ' that left the card');
    } else {
      ok(r.p.sats === 900 && r.changes >= 1 && r.signs === 1 + waitsOf12(900, 400) && r.said.length === 12 && r.said.slice(0, 4).every((q) => q.making === true) && r.said.slice(4).every((q) => q.making === false),
         label + ': over the limit with change: the same limits’ worth as without it (overpaying costs no wait), said as making change for the first and as over the limit after', r.signs + ' SIGN');
    }
    NC.card.tap(); await NC.R.W.cardWrite(NC.card, { change: true });
    await settle();
  }


  /* ---- 25c: the card before it makes its change as it always was ------------------ */
  {
    const OLD = await world(0, 9000, (ctx) => makeCard({ window: ctx.window, format: 4, software: 11 }));
    await binaryLoad(OLD.H, OLD.card, 2000);
    OLD.card.tap();
    const seen11 = await OLD.R.W.cardLook(OLD.card);
    ok(seen11.info.version === '1.11' && seen11.info.ownChange === false, 'a card of software 1.11 is not one that makes its own change', seen11.info.version);
    OLD.card.tap();
    OLD.card.sent.length = 0;
    const p11 = await OLD.R.W.cardPay(OLD.card, { sats: 1000, pin: '1234' });
    const rows11 = owedRows(OLD.R);
    ok(p11.sats === 1000 && (await bal(OLD.R)) === 1000 && count(OLD.card, '26') === 0 && count(OLD.card, '19') === 0 && count(OLD.card, '24') === 1,
       'it is asked for no change of its own: the pieces are signed for against outputs that are all the till’s', OLD.card.sent.map((a) => a.slice(2, 4)).join(' '));
    ok(rows11.length === 1 && rows11[0].kind === 'change' && typeof rows11[0].token === 'string' && !rows11[0].blind && p11.change.sats === rows11[0].sats && p11.change.sats > 0,
       'and the change is made here after the swap, locked to the card, and owed as a token', JSON.stringify(Object.keys(rows11[0] || {})));
    OLD.card.tap();
    OLD.card.sent.length = 0;
    const w11 = await OLD.R.W.cardWrite(OLD.card, { change: true });
    ok(w11.left === 0 && OLD.card.balance() === 1000 && count(OLD.card, '19') === 0 && count(OLD.card, '30') >= 1 && OLD.R.W.cardOwed().length === 0,
       'which the next tap writes, with no look at the card’s openings', 'the card has ' + OLD.card.balance());
    const e11 = history(OLD.R).filter((x) => x.hash === p11.hash)[0] || {};
    ok(e11.sats === 1000 && e11.changeSats === p11.change.sats && e11.changeState === 'given back', 'its entry as ever', JSON.stringify({ sats: e11.sats, change: e11.changeSats, state: e11.changeState }));
    await settle();
  }

  /* ---- 25d: change of more pieces than the card makes at once --------------------
   * The card keeps eight openings, and a card of 1.12 is asked for up to eight of them, a card of 1.13 or later for four at the most (each
   * is about half a second of the first tap, and change may add two seconds to it and no more). A change that would be more
   * pieces than that has the largest made by the card, and the rest made here after the swap, as change always was. */
  for (const [label, make, most, madeSum, tail, split] of [['1.12', card12, 8, 1020, 3, null], ['1.15', card4, 4, 960, 63, '512 + 256 + 128 + 64']]) {
    const MP = await world(0, 9000, make);
    await binaryLoad(MP.H, MP.card, 2048);            // one piece of 2048
    MP.card.tap();
    MP.card.sent.length = 0;
    const logs = [];
    const log0 = MP.R.window.console.log;
    MP.R.window.console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')); return log0.apply(this, arguments); };
    const paid = await MP.R.W.cardPay(MP.card, { sats: 1025, pin: '1234' });
    MP.R.window.console.log = log0;
    const rows = owedRows(MP.R);
    const blind = rows.filter((r) => r.blind), token = rows.filter((r) => r.token);
    ok(paid.sats === 1025 && (await bal(MP.R)) === 1025 && count(MP.card, '26') === most && count(MP.card, '24') === 1,
       label + ': 2048 paying 1025 is 1023 of change, which is ten powers of two: the card is asked for the ' + (most === 8 ? 'eight' : 'four') + ' largest', count(MP.card, '26') + ' change commands, till has ' + (await bal(MP.R)));
    ok(blind.length === 1 && blind[0].sats === madeSum && blind[0].blind.length === most && token.length === 1 && token[0].sats === tail && paid.change.sats === 1023 && paid.change.written === false,
       label + ': and the ' + tail + ' sats left are made here after the swap and owed as a token, beside the card’s own', rows.map((r) => r.sats + (r.blind ? ' (the card’s)' : ' (a token)')).join(', '));
    ok(logs.some((l) => new RegExp('the card makes ' + madeSum + ' sats of the change itself, in ' + most + ' pieces \\(' + (split ? split.replace(/\+/g, '\\+') : '[0-9 +]+') + '\\); ' + tail + ' sats more are made here after the swap, at the change tap').test(l)),
       label + ': the log line says how it was split: what the card makes, in how many pieces and which, and what is left for after the swap', logs.filter((l) => /card makes/.test(l)).join(' | '));
    const e = history(MP.R).filter((x) => x.hash === paid.hash)[0] || {};
    ok(e.sats === 1025 && e.grossSats === 2048 && e.changeSats === 1023 && e.feeSats === 0 && e.changeState === 'not handed',
       label + ': one entry for the payment, with the change as one amount', JSON.stringify({ sats: e.sats, gross: e.grossSats, change: e.changeSats, fee: e.feeSats, state: e.changeState }));
    MP.card.tap();
    MP.card.sent.length = 0;
    const wrote = await MP.R.W.cardWrite(MP.card, { change: true });
    ok(wrote.left === 0 && wrote.change === 1023 && MP.card.balance() === 1023 && MP.R.W.cardOwed().length === 0 && MP.card.state.openings.every((x) => x.state === 'empty'),
       label + ': one tap writes both', 'the card has ' + MP.card.balance());
    const e2 = history(MP.R).filter((x) => x.hash === paid.hash)[0] || {};
    ok(e2.changeState === 'given back', label + ': and the entry says given back', e2.changeState);
    await settle();
  }

  /* ---- 25e: a card with no opening free is paid the way it always was -------------- */
  {
    const NO = await world(0, 9000);
    await binaryLoad(NO.H, NO.card, 2000);
    // the openings of change not yet written back count, and eight is all it keeps
    for (let i = 0; i < 8; i++) NO.card.state.openings[i] = { state: 'pending', amount: 1, keyset: '0059534ce0bfa19a', date: 0, nonce: crypto.randomBytes(32).toString('hex'), r: crypto.randomBytes(32).toString('hex') };
    NO.card.tap();
    NO.card.sent.length = 0;
    const logs = [];
    const log0 = NO.R.window.console.log;
    NO.R.window.console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')); return log0.apply(this, arguments); };
    const paid = await NO.R.W.cardPay(NO.card, { sats: 1000, pin: '1234' });
    NO.R.window.console.log = log0;
    ok(paid.sats === 1000 && (await bal(NO.R)) === 1000 && count(NO.card, '26') === 1 && count(NO.card, '22') === 2 && count(NO.card, '24') === 1,
       'its first request for change is refused for want of an opening, and the payment is begun again with none asked of it', NO.card.sent.map((a) => a.slice(2, 4)).join(' '));
    const rows = owedRows(NO.R);
    ok(rows.length === 1 && !rows[0].blind && typeof rows[0].token === 'string' && rows[0].sats === paid.change.sats && swaps(NO.R).length === 0 && NO.card.state.openings.filter((x) => x.state === 'pending').length === 8,
       'the change is made here and owed as a token, and the card’s eight openings are the eight it had', JSON.stringify(Object.keys(rows[0] || {})));
    ok(logs.some((l) => /no opening free/.test(l)), 'said in the log', logs.filter((l) => /opening/.test(l)).join(' | '));
    NO.card.tap();
    const wrote = await NO.R.W.cardWrite(NO.card, { change: true });
    ok(wrote.left === 0 && NO.card.balance() === 1000, 'and written back at the next tap', String(NO.card.balance()));
    await settle();
  }


  /* ---- 25f: the swap's answer is lost, and the card's change is had from the mint ----
   * This phone never held what the card's pieces are made of, but the mint remembers whom
   * it signed for: asked by the blinded messages (NUT-09), as a lost locked send's outputs are. */
  for (const [label, make, change, pieces] of [['1.12', card12, 280, 3], ['1.15', card4, 24, 2]]) {
    const LA = await world(0, 9000, make);
    await binaryLoad(LA.H, LA.card, 2000);
    LA.card.tap();
    const realHandle = LA.R.mint.handle.bind(LA.R.mint);
    let dropped = false, deaf = true;
    LA.R.fate = (m) => {
      const url = String(m.url || '');
      if (!dropped && /\/v1\/swap$/.test(url)) { dropped = true; realHandle(m); return '0\n'; }
      // and the mint does not answer the questions that would find it out, for now
      if (deaf && /\/v1\/restore$/.test(url)) return '0\n';
      return null;
    };
    const lost = await LA.R.W.cardPay(LA.card, { sats: 1000, pin: '1234' }).then((r) => r, (e) => e);
    ok(dropped && lost && lost.card === 'waiting' && owedRows(LA.R).length === 0 && swaps(LA.R).length === 1 && swaps(LA.R)[0].change.outs.length === pieces && LA.R.W.cardTaken().length === 1,
       'a swap whose answer never came: the card has signed, the mint has made it, and nothing is owed to the card yet; the row has its blinded messages', lost && (lost.card || lost.message));
    deaf = false;
    await settle();
    // as the wallet does on connecting: its own recovery of lost answers first, then the card's settling
    await LA.R.W.recoverSwaps();
    await settle();
    const settled = await LA.R.W.cardSettle();
    await settle();
    const mine = settled.filter((x) => x.state === 'paid')[0] || {};
    const rows = owedRows(LA.R);
    ok(mine.sats === 1000 && mine.change === change && rows.length === 1 && rows[0].blind && rows[0].blind.length === pieces && rows[0].sats === change && swaps(LA.R).length === 0
       && LA.R.W.cardTaken().length === 0 && LA.R.W.cardDue().length === 0 && (await bal(LA.R)) === 1000,
       'found again, the payment is made and the card’s change is had from the mint by its blinded messages, and owed', JSON.stringify(mine) + ', ' + rows.length + ' owed');
    LA.R.fate = null;
    const eL = history(LA.R).filter((x) => x.hash === mine.id)[0] || {};
    ok(eL.sats === 1000 && eL.feeSats === 0 && eL.grossSats === 1000 + change && eL.changeSats === change && eL.changeState === 'not handed',
       'its entry, written by the wallet’s own recovery, does not count the card’s change as the mint’s fee', JSON.stringify({ sats: eL.sats, fee: eL.feeSats, gross: eL.grossSats, change: eL.changeSats, state: eL.changeState }));
    LA.card.tap();
    const wrote = await LA.R.W.cardWrite(LA.card, { change: true });
    ok(wrote.left === 0 && LA.card.balance() === 1000 && LA.R.W.cardOwed().length === 0, 'and written at the next tap, as any is', 'the card has ' + LA.card.balance());

    // the answer lost, and the payment recovered at once (the swap's own recovery); the mint will not say what it signed for the card
    const LB = await world(0, 9000, make);
    await binaryLoad(LB.H, LB.card, 2000);
    LB.card.tap();
    const realB = LB.R.mint.handle.bind(LB.R.mint);
    let droppedB = false, cardBs = new Set(), hushed = true;
    LB.R.fate = (m) => {
      const url = String(m.url || '');
      if (!droppedB && /\/v1\/swap$/.test(url)) { droppedB = true; cardBs = new Set(swaps(LB.R)[0].change.outs.map((o) => o.B_)); realB(m); return '0\n'; }
      if (hushed && /\/v1\/restore$/.test(url) && (JSON.parse(m.body).outputs || []).some((o) => cardBs.has(o.B_))) return '0\n';
      return null;
    };
    const pB = await LB.R.W.cardPay(LB.card, { sats: 1000, pin: '1234' });
    await settle();
    ok(pB.sats === 1000 && pB.change && pB.change.unmade === true && pB.change.sats === change && owedRows(LB.R).length === 0 && LB.R.W.cardDue().length === 1 && LB.R.W.cardDue()[0].sats === change
       && swaps(LB.R).length === 1 && (await bal(LB.R)) === 1000,
       'a mint that will not say what it signed for the card: the payment stands, its change is noted as due, said as change not made yet, and the swap’s row is kept', JSON.stringify(pB.change) + ' ' + JSON.stringify(LB.R.W.cardDue()));
    hushed = false;
    const again = await LB.R.W.cardDueRetry();
    await settle();
    ok(again.length === 1 && again[0].state === 'made' && owedRows(LB.R).length === 1 && owedRows(LB.R)[0].sats === change && LB.R.W.cardDue().length === 0 && swaps(LB.R).length === 0,
       'asked again when the phone connects, it is had and owed, and the note is gone', JSON.stringify(again));
    LB.R.fate = null;
    LB.card.tap();
    await LB.R.W.cardWrite(LB.card, { change: true });
    ok(LB.card.balance() === 1000, 'and written', String(LB.card.balance()));
    await settle();
  
  }

  /* ---- 25g: a change write cut short ----------------------------------------------
   * The card lets an opening go when its piece is on it, so what a tap that left had written is not
   * asked for again, and what it had not is. A card of 1.12 makes this change in six pieces (two commands to
   * write); a card of 1.13 or later makes four of them and the till one more, after the swap, all written at the change tap. */
  for (const [label, make, kPieces, total, openLeft] of [['1.12', card12, 6, 343, 3], ['1.15', card4, 4, 87, null]]) {
    const CS = await world(0, 9000, make);
    await binaryLoad(CS.H, CS.card, 4000);                 // 2048 1024 512 256 128 32
    CS.card.tap();
    const paid = await CS.R.W.cardPay(CS.card, { sats: 681, pin: '1234' });
    const blindRow = owedRows(CS.R).filter((r) => r.blind)[0];
    const k = blindRow.blind.length;
    const tokens = owedRows(CS.R).filter((r) => r.token).length;
    const after = CS.card.balance();
    ok(paid.sats === 681 && k === kPieces && paid.change.sats === total && tokens === (label === '1.15' ? 1 : 0),
       label + ': a change of ' + (label === '1.12' ? 'six pieces, two commands to write' : 'four pieces made by the card, and the 1 sat left of 87 made by the till'), k + ' pieces, ' + paid.change.sats + ', ' + tokens + ' token row(s)');
    CS.card.tap();
    CS.card.leaveBefore('30', 2);
    const cut = await why(CS.R.W.cardWrite(CS.card, { change: true }));
    const nonces = () => CS.card.state.slots.filter((x) => x.status === 1).map((x) => x.data.substr(24, 64));
    const pendingNow = CS.card.state.openings.filter((x) => x.state === 'pending').length;
    ok(cut === 'gone' && CS.card.balance() > after && CS.card.balance() < after + total && owedRows(CS.R).length >= 1 && (openLeft === null ? pendingNow >= 1 && pendingNow < kPieces : pendingNow === openLeft),
       label + ': taken away after the first three pieces: they are on the card, the openings of the rest are left, and the rows are still owed', cut + ', card ' + CS.card.balance() + ', ' + pendingNow + ' openings left');
    CS.card.tap();
    CS.card.sent.length = 0;
    const fin = await CS.R.W.cardWrite(CS.card, { pin: '1234' });
    ok(fin.left === 0 && CS.card.balance() === after + total && owedRows(CS.R).length === 0 && new Set(nonces()).size === nonces().length
       && CS.card.state.openings.every((x) => x.state === 'empty') && count(CS.card, '30') === (label === '1.12' ? 1 : 2),
       label + ': the next tap writes the pieces that are left and no more, and nothing is on the card twice', 'card ' + CS.card.balance() + ', ' + count(CS.card, '30') + ' LOAD');
    await settle();
  }

  /* ---- 25h: what cannot be finished is kept and not promised ------------------------ */
  for (const [label, make, pieces] of [['1.12', card12, 3], ['1.15', card4, 2]]) {
    const WP = await world(0, 9000, make);
    await binaryLoad(WP.H, WP.card, 2000);
    WP.card.tap();
    const paid = await WP.R.W.cardPay(WP.card, { sats: 1000, pin: '1234' });
    // the card is wiped and set up again: nothing on it, and nothing of what its change was made of
    WP.card.state.slots.forEach((x) => { x.status = 0; x.data = ''; });
    WP.card.state.openings.forEach((x, i) => { WP.card.state.openings[i] = { state: 'empty' }; });
    WP.card.tap();
    const wrote = await WP.R.W.cardWrite(WP.card, { change: true });
    const stuck = WP.R.W.cardStuck();
    ok(wrote.left === 0 && wrote.sats === 0 && WP.card.balance() === 0 && WP.R.W.cardOwed().length === 0 && stuck.length === 1 && stuck[0].sats === paid.change.sats && stuck[0].why === 'opening' && stuck[0].blind.length === pieces,
       'an output the card no longer lists and does not hold cannot be finished: the row is kept with why, and is no longer owed', JSON.stringify(stuck.map((x) => [x.sats, x.why])));
    const e = history(WP.R).filter((x) => x.hash === paid.hash)[0] || {};
    ok(e.changeState === 'not handed', 'its entry is not said to be given back', e.changeState);
    WP.card.tap();
    WP.card.sent.length = 0;
    const again = await WP.R.W.cardWrite(WP.card, { change: true }).then((r) => r, (x) => x);
    ok(again.left === 0 && count(WP.card, '19') === 0 && count(WP.card, '30') === 0, 'and it is not asked about again: nothing is read or written for it', WP.card.sent.map((a) => a.slice(2, 4)).join(' '));
    await settle();

    // a signature that does not check out is not written
    const BD = await world(0, 9000, make);
    await binaryLoad(BD.H, BD.card, 2000);
    BD.card.tap();
    const p2 = await BD.R.W.cardPay(BD.card, { sats: 1000, pin: '1234' });
    const stored = owedRows(BD.R);
    const flip = (hex) => (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1);
    stored[0].blind[1].dleq.e = flip(stored[0].blind[1].dleq.e);
    BD.R.storage.setItem('foxy.flashcard.owed', JSON.stringify(stored));
    BD.card.tap();
    BD.card.sent.length = 0;
    const w2 = await BD.R.W.cardWrite(BD.card, { change: true });
    const st2 = BD.R.W.cardStuck();
    ok(st2.length === 1 && st2[0].why === 'signature' && st2[0].sats === p2.change.sats - (p2.change.sats - st2[0].sats) && st2[0].blind.length === 1 && BD.R.W.cardOwed().length === 0,
       'the mint’s signature on one output fails its DLEQ: that piece is not written, and is kept apart; the others went on', JSON.stringify(st2.map((x) => [x.sats, x.why, x.blind.length])) + ', card ' + BD.card.balance());
    ok(BD.card.balance() === 2000 - 1000 - p2.change.sats + (p2.change.sats - st2[0].sats), 'the card has the pieces that were good', String(BD.card.balance()));
    await settle();

    // a mint that sends no DLEQ is taken as every other is: its signatures cannot be checked, and are not refused for it
    const ND = await world(0, 9000, make);
    await binaryLoad(ND.H, ND.card, 2000);
    ND.card.tap();
    const p3 = await ND.R.W.cardPay(ND.card, { sats: 1000, pin: '1234' });
    const st3 = owedRows(ND.R);
    st3[0].blind.forEach((b) => { delete b.dleq; });
    ND.R.storage.setItem('foxy.flashcard.owed', JSON.stringify(st3));
    ND.card.tap();
    const w3 = await ND.R.W.cardWrite(ND.card, { change: true });
    ok(w3.left === 0 && ND.R.W.cardStuck().length === 0 && ND.card.balance() === 2000 - 1000 - p3.change.sats + p3.change.sats, 'a signature with no DLEQ is written all the same', String(ND.card.balance()));
    await settle();
  
  }

  /* ---- 25i: a mint that charges for every piece ------------------------------------
   * What leaves the card is the price and the fee on the pieces; the rest is its change, and costs nothing to make. */
  {
    const FM = await world(1000, 9000);
    await binaryLoad(FM.H, FM.card, 2000);
    FM.card.tap();
    let request = null;
    FM.R.fate = (m) => { if (!request && /\/v1\/swap$/.test(String(m.url || ''))) request = JSON.parse(m.body); return null; };
    const onCard = FM.card.balance();
    const paid = await FM.R.W.cardPay(FM.card, { sats: 700, pin: '1234' });
    FM.R.fate = null;
    const fee = request.inputs.length;              // 1,000 ppk is a sat a piece
    const given = request.inputs.reduce((n, p) => n + p.amount, 0);
    const e = history(FM.R).filter((x) => x.hash === paid.hash)[0] || {};
    ok(paid.sats === 700 && (await bal(FM.R)) === 700 && paid.change.sats === given - fee - 700 && e.sats === 700 && e.feeSats === fee && e.changeSats === paid.change.sats && e.grossSats === given - fee,
       'the fee on the pieces is the mint’s, and the rest over the price is the card’s change', JSON.stringify({ pieces: request.inputs.length, given, fee, change: paid.change.sats, entry: [e.sats, e.feeSats, e.changeSats, e.grossSats] }));
    FM.card.tap();
    await FM.R.W.cardWrite(FM.card, { change: true });
    ok(FM.card.balance() === onCard - 700 - fee, 'the card is out the price and the fee and no more', FM.card.balance() + ' of ' + onCard);
    await settle();
  }

  /* ---- 25j: the day is charged what leaves the card, and its refusal comes at the signing ---- */
  {
    // (a card of 1.13 or 1.14 makes four pieces of change at most: prices are chosen whose change is that few, so all of it is the card's)
    for (const [label, make, prices] of [['1.12', card12, [300, 300, 100]], ['1.15', card4, [320, 280, 100]]]) {
      const DL = await world(0, 9000, make);
      await binaryLoad(DL.H, DL.card, 2048);            // one piece of 2048
      DL.card.tap();
      await DL.H.W.cardSetLimit(DL.card, { sats: 600 });
      DL.card.tap();
      const first = await DL.R.W.cardPay(DL.card, { sats: prices[0], pin: '1234' });
      ok(first.sats === prices[0] && DL.card.state.spent === prices[0], label + ': a day of 600 and a piece of 2,048: a payment of ' + prices[0] + ' is made, and the day is charged ' + prices[0] + ' and not the piece', 'spent ' + DL.card.state.spent);
      DL.card.tap();
      await DL.R.W.cardWrite(DL.card, { change: true });
      DL.card.tap();
      const second = await DL.R.W.cardPay(DL.card, { sats: prices[1], pin: '1234' });
      ok(second.sats === prices[1] && DL.card.state.spent === 600, label + ': and so is a second, of ' + prices[1], 'spent ' + DL.card.state.spent);
      DL.card.tap();
      await DL.R.W.cardWrite(DL.card, { change: true });
      DL.card.tap();
      DL.card.sent.length = 0;
      const third = await DL.R.W.cardPay(DL.card, { sats: prices[2], pin: '1234' }).then(() => null, (e) => e);
      ok(third && third.card === 'limit' && third.need === prices[2] && third.left === 0 && count(DL.card, '40') === 0,
         label + ': one more is refused before the PIN is sent, and said as the price over what the day has left', third && (third.card + ': ' + third.message));
      await settle();
    }

    /* A change of more pieces than the card makes has its tail made by the till after the swap, and that tail leaves the
     * card with the price: it is what the day, and the wait, are charged. 300 from a piece of 2,048 is 1,748 of change, six
     * powers of two; the card makes the four largest (1024 + 512 + 128 + 64) and the 20 left go with the 300. */
    {
      const DT = await world(0, 9000);
      await binaryLoad(DT.H, DT.card, 2048);
      DT.card.tap();
      await DT.H.W.cardSetLimit(DT.card, { sats: 600 });
      DT.card.tap();
      DT.card.sent.length = 0;
      const tailed = await DT.R.W.cardPay(DT.card, { sats: 300, pin: '1234' });
      const madeBy = DT.card.sent.filter((a) => a.slice(0, 4) === 'b026').map((a) => parseInt(a.substr(10, 8), 16));
      ok(tailed.sats === 300 && madeBy.join('+') === '1024+512+128+64' && DT.card.state.spent === 320 && tailed.change.sats === 1748,
         '1.15: a change of six pieces, which the card makes four of, charges the day with the price and the tail the till makes (320), as it leaves the card with the price', 'made ' + madeBy.join('+') + ', spent ' + DT.card.state.spent);
      DT.card.tap();
      await DT.R.W.cardWrite(DT.card, { change: true });
      await settle();
    }

    // the day's refusal at the card's first SIGN, after the outputs and the change were sent: the payment is given up, and its row with it
    const DS = await world(0, 9000);
    await binaryLoad(DS.H, DS.card, 2000);
    DS.card.tap();
    await DS.H.W.cardSetLimit(DS.card, { sats: 5000 });
    DS.card.tap();
    DS.card.sent.length = 0;
    const send0 = DS.card.send.bind(DS.card);
    // another terminal has used the day up since this one read the card
    DS.card.send = (a) => { if (String(a).slice(0, 4) === 'b024') DS.card.state.spent = 5000; return send0(a); };
    const before = DS.card.balance();
    const refused = await DS.R.W.cardPay(DS.card, { sats: 1000, pin: '1234' }).then(() => null, (e) => e);
    DS.card.send = send0;
    const order = DS.card.sent.map((a) => a.slice(2, 4)).filter((i) => /^(22|23|26|24)$/.test(i)).join(' ');
    ok(refused && refused.card === 'limit' && /^22( 23)+( 26)+ 24$/.test(order) && swaps(DS.R).length === 0 && DS.R.W.cardTaken().length === 0 && DS.card.balance() === before && (await bal(DS.R)) === 0 && owedRows(DS.R).length === 0,
       'refused at the first SIGN, with the pieces named and the outputs and the change sent: the swap’s row is dropped, nothing is burned, kept or owed', refused && (refused.card + ': ' + order));
    await settle();
  }


  /* ---- 25k: taken away as it signs, with change of its own in the swap --------------
   * The row of the swap has the card's blinded messages and the digest of everything the card signed,
   * so the signature the card gives again is held to it, and the payment is made with the card's change in it. */
  for (const [label, make, change, pieces] of [['1.12', card12, 280, 3], ['1.15', card4, 24, 2]]) {
    const AB = await world(0, 9000, make);
    await binaryLoad(AB.H, AB.card, 2000);
    AB.card.tap();
    AB.card.loseAnswerOf('24', 1);
    const lost = await AB.R.W.cardPay(AB.card, { sats: 1000, pin: '1234' }).then(() => null, (e) => e);
    const row = swaps(AB.R)[0];
    ok(lost && lost.card === 'interrupted' && lost.resumable === true && AB.card.balance() === 2000 - 1000 - change && row && row.asked && row.change.outs.length === pieces
       && row.digest === crypto.createHash('sha256').update(AB.card.state.lastText, 'utf8').digest('hex'),
       'taken away as it signs: the pieces are burned, and the row holds the digest of everything the card signed, with its change', lost && lost.card);
    AB.card.tap();
    AB.card.sent.length = 0;
    const fin = await AB.R.W.cardPay(AB.card, { sats: 1000, pin: '1234' });
    ok(fin.sats === 1000 && count(AB.card, '25') === 1 && count(AB.card, '24') === 0 && count(AB.card, '26') === 0 && (await bal(AB.R)) === 1000 && swaps(AB.R).length === 0 && AB.R.W.cardTaken().length === 0,
       'the next tap asks for the signature it gave, and the payment is made with nothing more burned or asked for', (await bal(AB.R)) + ', ' + JSON.stringify(fin.change));
    const rows = owedRows(AB.R);
    const e = history(AB.R).filter((x) => x.hash === fin.hash)[0] || {};
    ok(rows.length === 1 && rows[0].blind && rows[0].sats === change && fin.change && fin.change.sats === change && e.feeSats === 0 && e.changeSats === change && e.sats === 1000,
       'with the card’s change owed as if it had been made in that tap', JSON.stringify({ owed: rows.map((r) => r.sats), fin: fin.change, fee: e.feeSats }));
    AB.card.tap();
    await AB.R.W.cardWrite(AB.card, { change: true });
    ok(AB.card.balance() === 1000, 'and written', String(AB.card.balance()));
    await settle();
  
  }

  /* ---- 25m: taken away while the card is making its change ------------------------
   * Nothing is signed until the card is asked to sign, so nothing is burned and nothing is kept: the row
   * the swap was written down in goes with the payment, and the drafts of change the card made are let go at the next BEGIN. */
  {
    const GC = await world(0, 9000);
    await binaryLoad(GC.H, GC.card, 2000);
    GC.card.tap();
    GC.card.leaveBefore('26', 2);
    const left = await GC.R.W.cardPay(GC.card, { sats: 1000, pin: '1234' }).then(() => null, (e) => e);
    ok(left && left.card === 'gone' && GC.card.balance() === 2000 && swaps(GC.R).length === 0 && GC.R.W.cardTaken().length === 0 && owedRows(GC.R).length === 0 && (await bal(GC.R)) === 0,
       'taken away between two of its change outputs: nothing was signed, burned, kept or owed, and the swap’s row is gone', left && left.card);
    ok(GC.card.state.openings.filter((x) => x.state === 'draft').length === 1, 'the card holds the one draft it made', GC.card.state.openings.map((x) => x.state).join(','));
    GC.card.tap();
    GC.card.sent.length = 0;
    const paid = await GC.R.W.cardPay(GC.card, { sats: 1000, pin: '1234' });
    ok(paid.sats === 1000 && (await bal(GC.R)) === 1000 && GC.card.state.openings.filter((x) => x.state === 'draft').length === 0 && GC.card.state.openings.filter((x) => x.state === 'pending').length === count(GC.card, '26'),
       'and the next tap pays: the draft was let go as the payment began, and the openings are the change of this one', count(GC.card, '26') + ' change outputs');
    GC.card.tap();
    await GC.R.W.cardWrite(GC.card, { change: true });
    ok(GC.card.balance() === 1000 && owedRows(GC.R).length === 0, 'whose change is written', String(GC.card.balance()));
    await settle();
  }

  /* ---- 25l: a holder taking money off the card asks it for no change ------------------- */
  {
    const WD = await world(0, 9000);
    await WD.H.W.cardAdd(WD.card, { sats: 1500, pin: '1234' });
    const hb = await bal(WD.H);
    WD.card.tap();
    WD.card.sent.length = 0;
    const off = await WD.H.W.cardWithdraw(WD.card, { pin: '1234' });
    ok(off.sats === 1500 && count(WD.card, '26') === 0 && count(WD.card, '24') === 1 && (await bal(WD.H)) === hb + 1500 && WD.H.W.cardOwed().length === 0, 'taking everything off is one signature and no change of the card’s own', count(WD.card, '26') + ' change commands');
    await settle();
  }


  /* ---- 26: among the sets that overpay least, one whose change the card makes whole ---------
   * A card of 1.13 makes four pieces of change at the most, cut plainly: the four largest of the powers of two it is made of.
   * What is more than that is made by the till after the swap, a second swap at the mint that leaves the card with the price. So when
   * no set of pieces comes to the price exactly, the set whose change is four powers of two or fewer is taken among those that
   * overpay least, if one overpays a little more (an eighth of the price, 64 sats at the least); and where none does, the least stands. */
  {
    const bitsOf = (n) => n.toString(2).split('').filter((c) => c === '1').length;
    const named = (card) => card.sent.filter((a) => a.slice(0, 4) === 'b022').map((a) => parseInt(a.substr(8, 2), 16));
    const madeOf = (card) => card.sent.filter((a) => a.slice(0, 4) === 'b026').map((a) => parseInt(a.substr(10, 8), 16));
    const logsOf = (ctx) => {
      const logs = [];
      const log0 = ctx.window.console.log;
      ctx.window.console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')); return log0.apply(this, arguments); };
      return { logs, done: () => { ctx.window.console.log = log0; } };
    };

    // 4096 and the five smallest sizes: 1631 cannot be made exactly. The 4096 alone overpays least, by 2465, which is five powers of two
    // (2048 + 256 + 128 + 32 + 1); with the 31 that are in the small pieces it overpays 31 more, by 2496, which is four (2048 + 256 + 128 + 64).
    const TD = await world(0, 9000);
    await binaryLoad(TD.H, TD.card, 4127);
    ok(amounts(TD.card).join('+') === '4096+16+8+4+2+1' && bitsOf(4096 - 1631) === 5 && bitsOf(4127 - 1631) === 4,
       'a drawer where the set that overpays least brings back a change of five powers of two, and a set that overpays 31 more one of four', amounts(TD.card).join('+'));
    TD.card.tap();
    TD.card.sent.length = 0;
    const tl = logsOf(TD.R);
    const tidy = await TD.R.W.cardPay(TD.card, { sats: 1631, pin: '1234' });
    tl.done();
    const rowsT = owedRows(TD.R);
    ok(tidy.sats === 1631 && named(TD.card)[0] === 6 && madeOf(TD.card).join('+') === '2048+256+128+64' && tidy.change.sats === 2496 && rowsT.length === 1 && !!rowsT[0].blind && rowsT[0].sats === 2496,
       'the four-bit one is chosen: six pieces named, not the 4096 alone, and the card makes all 2496 of the change in four pieces, with nothing left for the till to make after the swap',
       'named ' + named(TD.card).join() + ', made ' + madeOf(TD.card).join('+') + ', change ' + tidy.change.sats + ', ' + rowsT.length + ' owed row(s)');
    ok(tl.logs.some((l) => /the card makes 2496 sats of the change itself, in 4 pieces \(2048 \+ 256 \+ 128 \+ 64\)$/.test(l)),
       'and the log line says it was split in four and that nothing is left to make after the swap', tl.logs.filter((l) => /card makes/.test(l)).join(' | '));
    ok(TD.card.balance() === 0 && (await bal(TD.R)) === 1631, 'the pieces are all signed for', 'card ' + TD.card.balance());
    TD.card.tap();
    const wroteT = await TD.R.W.cardWrite(TD.card, { change: true });
    ok(wroteT.left === 0 && TD.card.balance() === 2496 && TD.R.W.cardOwed().length === 0, 'and written back at the next tap', 'the card has ' + TD.card.balance());

    // the card before it is not asked to prefer, and takes the 4096 alone, its change cut to its drawer in up to eight pieces
    const TO = await world(0, 9000, card12);
    await binaryLoad(TO.H, TO.card, 4127);
    TO.card.tap();
    TO.card.sent.length = 0;
    const old = await TO.R.W.cardPay(TO.card, { sats: 1631, pin: '1234' });
    ok(old.sats === 1631 && named(TO.card)[0] === 1 && old.change.sats === 2465, 'a card of 1.12 takes the 4096 alone, as the set that overpays least', 'named ' + named(TO.card).join() + ', change ' + old.change.sats);
    TO.card.tap();
    await TO.R.W.cardWrite(TO.card, { change: true });

    // no such set: the 4096 alone. The card makes the four largest, 2048 + 256 + 128 + 32, and the 1 left is made after the swap
    const TE = await world(0, 9000);
    await binaryLoad(TE.H, TE.card, 4096);
    TE.card.tap();
    TE.card.sent.length = 0;
    const el = logsOf(TE.R);
    const tail = await TE.R.W.cardPay(TE.card, { sats: 1631, pin: '1234' });
    el.done();
    const rowsE = owedRows(TE.R);
    ok(tail.sats === 1631 && named(TE.card)[0] === 1 && madeOf(TE.card).join('+') === '2048+256+128+32' && tail.change.sats === 2465
       && rowsE.filter((r) => r.blind).length === 1 && rowsE.filter((r) => r.blind)[0].sats === 2464 && rowsE.filter((r) => r.token).length === 1 && rowsE.filter((r) => r.token)[0].sats === 1,
       'where no set brings back change of four powers of two or fewer, the least stands: the card makes 2048 + 256 + 128 + 32 and the 1 sat left is made after the swap, a token row owed beside the card’s own',
       'made ' + madeOf(TE.card).join('+') + ', ' + rowsE.map((r) => r.sats + (r.blind ? ' (the card’s)' : ' (a token)')).join(', '));
    ok(el.logs.some((l) => /the card makes 2464 sats of the change itself, in 4 pieces \(2048 \+ 256 \+ 128 \+ 32\); 1 sat more is made here after the swap, at the change tap$/.test(l)),
       'and the log line says how it was split: four pieces, then the 1 sat', el.logs.filter((l) => /card makes/.test(l)).join(' | '));
    TE.card.tap();
    const wroteE = await TE.R.W.cardWrite(TE.card, { change: true });
    ok(wroteE.left === 0 && TE.card.balance() === 2465 && TE.R.W.cardOwed().length === 0, 'both are written at the change tap', 'the card has ' + TE.card.balance());

    await settle();
  }

  /* ---- 27: at a till: the change a piece at a time, and three buzzes ---------------------------
   * The card makes each piece of its change in about half a second over NFC, and the sheet said nothing between the pieces
   * being named and the wait, which with seven pieces was four seconds of silence: now it says which piece, of how many.
   * And when the card has signed with change coming back to it in this sheet, the phone buzzes three times so that whoever
   * holds the card knows a second tap is coming; a payment with no change gets the single quiet tap it always got. */
  {
    const UB = await world(0, 9000);
    await binaryLoad(UB.H, UB.card, 4096);
    const till = appOn(UB.R, { screen: 'confirm' });
    const lines = [];
    const text0 = till.fcProgressText.bind(till);
    till.fcProgressText = (p) => { const t = text0(p); if (t) lines.push(t); return t; };
    const felt = [];
    till.haptic = (kind, silent) => felt.push({ kind, silent: !!silent, ended: UB.R.sheet.some((x) => /^end:/.test(x)), signed: UB.card.sent.some((a) => a.slice(0, 4) === 'b024') });
    till.wantedSats = () => 1631;
    UB.R.nfc = UB.card;
    UB.R.sheet.length = 0;
    UB.card.sent.length = 0;
    till.payByCard();
    pad(till).type('1234');
    await until('the payment and its change to be finished', () => UB.R.sheet.some((x) => /^(end|error):/.test(x)) && !stage(UB.R));
    await settle();
    const piece = (k) => 'The card is making change · piece ' + k + ' of 4. Keep holding.';
    const asked = UB.card.sent.filter((a) => a.slice(0, 4) === 'b026').length;
    ok((await bal(UB.R)) === 1631 && asked === 4,
       'at a till: 1,631 paid from a card of one piece of 4,096, the card making four pieces of its change', (await bal(UB.R)) + ', ' + asked + ' change commands');
    const making = lines.filter((t) => /making change/.test(t));
    ok(making.join(' / ') === [1, 2, 3, 4].map(piece).join(' / '),
       'the line under the heading moves from piece to piece, between the pieces being named and the signature: "' + piece(1) + '"', making.join(' / '));
    const said = UB.R.sheet.filter((x) => /^say: The card is making change/.test(x));
    ok(said.length === 4 && said[0] === 'say: ' + piece(1) && said[3] === 'say: ' + piece(4), 'and the phone’s sheet is told the same, a piece at a time', said.join(' / '));
    const order = [lines.indexOf('Signing'), lines.indexOf(piece(1)), lines.indexOf(piece(4))];
    ok(order[0] >= 0 && order[1] > order[0] && order[2] > order[1], 'after "Signing", before anything else', JSON.stringify(order));
    const buzz = felt.filter((f) => f.kind !== 'light');
    const threes = buzz.filter((f) => f.kind === 'triple');
    ok(threes.length === 1 && threes[0].silent === true && threes[0].signed === true && threes[0].ended === false && !buzz.some((f) => f.kind === 'tap') && buzz[buzz.length - 1].kind === 'success',
       'the page asks for the three buzzes once, as the card has signed and its sheet is kept for the change, and for no single tap beside them; the payment’s own buzz comes when it is paid',
       JSON.stringify(buzz.map((f) => f.kind + (f.silent ? ' (silent)' : '') + (f.ended ? ' [sheet ended]' : ''))));
    ok(UB.card.balance() === 2465 && UB.R.W.cardOwed().length === 0, 'and the change is written back in the same sheet', 'the card has ' + UB.card.balance());

    // a payment with no change: no three buzzes; the quiet tap it always had
    const UC = await world(0, 9000);
    await UC.H.W.cardAdd(UC.card, { sats: 2000, pin: '1234' });
    const till2 = appOn(UC.R, { screen: 'confirm' });
    const felt2 = [];
    till2.haptic = (kind, silent) => felt2.push({ kind, silent: !!silent });
    till2.wantedSats = () => 700;
    UC.R.nfc = UC.card;
    UC.R.sheet.length = 0;
    till2.payByCard();
    pad(till2).type('1234');
    await until('the exact payment to be finished', () => UC.R.sheet.some((x) => /^(end|error):/.test(x)) && !stage(UC.R));
    await settle();
    const quiet = felt2.filter((f) => f.kind !== 'light');
    ok((await bal(UC.R)) === 700 && !quiet.some((f) => f.kind === 'triple') && quiet.filter((f) => f.kind === 'tap').length === 1 && !UC.R.sheet.some((x) => /making change/.test(x)),
       'a payment made exactly asks for no three buzzes and says nothing of making change', JSON.stringify(quiet.map((f) => f.kind)));

    // the other half of the phone: the page's call is a kind the phone knows (Foxy/Bridge/FoxyBridge.swift), and the web fallback has its pattern
    const swift = require('fs').readFileSync(require('path').join(__dirname, '..', 'Foxy', 'Bridge', 'FoxyBridge.swift'), 'utf8');
    const block = (/case "triple":([\s\S]*?)default:/.exec(swift) || [])[1] || '';
    ok(/UIImpactFeedbackGenerator\(style: \.heavy\)/.test(block) && /0\.15 \* Double\(knock\)/.test(block) && /for knock in 0\.\.<3/.test(block),
       'on the phone: three heavy impacts, 0.15 s apart', block.replace(/\s+/g, ' ').slice(0, 120));
    const fallback = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'app', '05-device-shell.js'), 'utf8');
    ok(/kind === 'triple' \? \[60, 150, 60, 150, 60\]/.test(fallback), 'where there is no phone, the web fallback vibrates the same three times');
    await settle();
  }

  /* ---- 28: a second payment in one tap, and what the wallet says of it ----------------------
   * A card of 1.13 or later makes a second payment signed in the same time in the field wait as one over the limit does, with a limit
   * or without one, and the owner's grant in the tap lifts that. A till is not told the limit, but it knows what it has had the card
   * sign in this sheet (`link.one.paid`, which a card back in the field empties): so its estimate, before the PIN is sent, says
   * at least the 7 (less what its change counts for), and the screen says it is a second payment. */
  {
    const SP = await world(0, 9000);
    await SP.H.W.cardAdd(SP.card, { sats: 3000, pin: '1234' });
    SP.card.one = {};                                    // (what a sheet of the phone has: this card is the link, and its time in the field is one)
    SP.card.tap();
    const notes = [];
    const nots0 = [];
    const one = await SP.R.W.cardPay(SP.card, { sats: 300, pin: '1234', progress: (q) => { if (q.step === 'waiting') nots0.push(q); } });
    ok(one.sats === 300 && SP.card.one.paid === 1 && nots0.length === 0, 'the first payment of a time in the field goes at once, and the sheet counts it', 'paid ' + SP.card.one.paid);
    // the same time in the field: no tap between
    SP.card.sent.length = 0;
    const two = await SP.R.W.cardPay(SP.card, { sats: 350, pin: '1234', progress: (q) => { if (q.step === 'waiting') notes.push(q); } });
    const waitsTaken = count(SP.card, '24') - 1;
    const ahead = notes.filter((q) => q.ahead === true);
    ok(two.sats === 350 && waitsTaken === 7 - Math.floor(2 * (two.change ? count(SP.card, '26') : 0) / 3) && ahead.length === 1 && ahead[0].second === true && ahead[0].left === waitsTaken && SP.card.one.paid === 2,
       'a second payment in it waits at the card, and the wallet had said so before the PIN was sent: how many signatures, and that it is a second payment',
       waitsTaken + ' waits, said ' + JSON.stringify(ahead));
    ok(notes.filter((q) => !q.ahead).length === waitsTaken && /^A second payment in one tap\. Keep holding \(\d+ s\)$/.test(appOn(SP.R).fcProgressText(ahead[0])),
       'the screen told the person to keep holding for each, in words that say why', appOn(SP.R).fcProgressText(ahead[0]));
    // the card out of the field and back: a new time in the field, which the sheet knows (`link.again`) and a test does by hand
    SP.card.tap();
    SP.card.one.paid = 0;
    SP.card.sent.length = 0;
    const three = await SP.R.W.cardPay(SP.card, { sats: 200, pin: '1234' });
    ok(three.sats === 200 && count(SP.card, '24') === 1, 'a card back in the field starts afresh: the next goes at once', count(SP.card, '24') + ' SIGN');
    // the holder's own phone takes the whole card off in the same time in the field: its grant is given before it signs anything, and it is not slowed
    SP.card.tap();
    SP.card.one.paid = 0;
    await SP.R.W.cardPay(SP.card, { sats: 120, pin: '1234' });
    await SP.R.W.cardPay(SP.card, { sats: 130, pin: '1234' });
    ok(SP.card.state.tapPaid === true, 'two payments in one time in the field, and the card knows it');
    SP.card.sent.length = 0;
    const onIt = SP.card.balance();
    const hb = await bal(SP.H);
    const off = await SP.H.W.cardWithdraw(SP.card, { pin: '1234' });
    ok(off.sats > 0 && (await bal(SP.H)) > hb && SP.card.balance() === 0 && count(SP.card, '24') === 1 && SP.card.state.tapPaid === true,
       'the card’s owner, whose grant is in the tap, takes the rest off in one signature and no wait, though payments were signed in it before', count(SP.card, '24') + ' SIGN for ' + onIt + ' on the card');
    await settle();
  }

  /* ---- 28b: the change counts toward a second payment's wait for what it cost, and the wallet says so before the PIN ----
   * A card with a piece of 4,096 and one of 64: the 64 is paid exactly (the first payment of the time in the field, which goes at once),
   * and the second is paid from the 4,096, whose change the card makes itself, in one to four pieces (the largest powers of two it is made
   * of). 1.13 took one wait off for each piece, 1.14 takes two off for every three: so the wait is the 7 of a second payment (or the limit's
   * own, where the payment is over it) less k on the one card and less floor(2k / 3) on the other, and the estimate the till gives before
   * the PIN is sent is the card's own number, which is what carries the card's software to the wait (`info.costed`). Where there is a
   * limit the till is not told it, so it says what it can, the 7 less the same change; the card waits its own count, which is more. */
  for (const [label, make, credit] of [['1.13', card13, (k) => k], ['1.15', card4, (k) => Math.floor(2 * k / 3)]]) {
    for (const [pieces, price, limit] of [[1, 3072, 0], [2, 2816, 0], [3, 2800, 0], [4, 2799, 0], [4, 2799, 1000]]) {
      const SQ = await world(0, 9000, make);
      await binaryLoad(SQ.H, SQ.card, 4160);                       // 4096 and 64
      if (limit) { SQ.card.tap(); await SQ.H.W.cardSetLimit(SQ.card, { sats: limit, tap: true }); }
      SQ.card.one = {};                                            // (the sheet's, as in 28)
      SQ.card.tap();
      const first = await SQ.R.W.cardPay(SQ.card, { sats: 64, pin: '1234' });
      SQ.card.sent.length = 0;
      const notes = [];
      const second = await SQ.R.W.cardPay(SQ.card, { sats: price, pin: '1234', progress: (q) => { if (q.step === 'waiting') notes.push(q); } });
      const made = count(SQ.card, '26'), taken = count(SQ.card, '24') - 1;
      const base = limit ? 7 + 3 * (Math.ceil(price / limit) - 2) : 7;
      const want = base - credit(pieces), told = 7 - credit(pieces);
      const ahead = notes.filter((q) => q.ahead === true);
      ok(first.sats === 64 && second.sats === price && made === pieces && taken === want && ahead.length === 1 && ahead[0].second === true && ahead[0].left === told
         && notes.filter((q) => !q.ahead).length === want,
         label + ': a second payment of ' + price + ' from the 4,096, ' + pieces + ' piece' + (pieces > 1 ? 's' : '') + ' of change made by the card' + (limit ? ', over a limit of ' + limit : ', with no limit')
         + ': ' + base + ' less ' + credit(pieces) + ' is ' + want + ' waits at the card, and the wallet said ' + told + ' before the PIN was sent' + (limit ? ' (the limit is not the till’s to know)' : ''),
         taken + ' waits, ' + made + ' pieces, said ' + JSON.stringify(ahead));
      SQ.card.tap();
      await SQ.R.W.cardWrite(SQ.card, { change: true });
      await settle();
    }
  }


  await settle();
  console.log('\n' + (failed ? failed + ' flashcard-sigall check(s) failed' : 'all flashcard-sigall checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
