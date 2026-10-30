'use strict';
/* flashcard-offline.js — a card pays a phone that has no route.
 *
 *     node tests/flashcard-offline.js
 *
 * A card that signs once for a payment (format 4) and keeps the mint's proofs (software 1.20) can pay a till with no
 * route: the till sets the swap out from its own seed, reads the mint's proof for each piece the card is to pay with and
 * checks it against the mint's keys it kept, and the card signs the swap over to it. The till keeps the whole request
 * (`foxy.flashcard.kept`, and a row of the unclaimed store), counts it in its balance at once, and posts it the first
 * time it is online. This pins, at the wallet:
 *
 *   the tap: the proofs read for the picked places and no others, one signature, nothing asked of the mint, the record
 *     and the entry, the books; the switch; the week a piece must have left by the latest clock the till has evidence
 *     for, and a day for a till with a route; a card too old, one whose money does not prove, and one with no proofs;
 *   settling: at the first connection; a keyset retired and a fee changed between the tap and the connection; the
 *     card's owner taking it back before and after; an answer lost, a repeat, and a copy of the request posted
 *     elsewhere; a mint that does not answer, and a payment late near its date;
 *   the online till read, unchanged; a stranger's change keeping its date; the owner's renewal; set-up recoverable.
 *
 * The card is the model (tests/flashcard-card.js), held to the applet's own answers; the mint is the test mint, which
 * holds SIG_ALL as CDK and Nutshell do. Every page ends with its books checked (tests/harness.js), and while a payment
 * waits the books are checked counting it as held.
 */
const { funded, newCard, binaryLoad, settle, history, why, tipIs, mineHeader, MINT, OTHER_WORDS } = require('./flashcard-kit');
const { books, booksWrong } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const THIRD = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const bal = (c) => c.W.balanceSats();
const count = (card, ins) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + ins).length;
const firstOf = (card, ins) => card.sent.findIndex((a) => a.slice(0, 4) === 'b0' + ins);
const lastOf = (card, ins) => { let at = -1; card.sent.forEach((a, i) => { if (a.slice(0, 4) === 'b0' + ins) at = i; }); return at; };
const slotDates = (card) => Array.from(new Set(card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(154, 8), 16))));
const swaps = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.swaps') || '[]');
const keptRows = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.kept') || '[]');
const unclaimedRows = (c) => JSON.parse(c.storage.getItem('foxy.req.unclaimed') || '{}');
const entryOf = (c, hash) => history(c).filter((e) => e.hash === hash)[0] || {};
const offline = (c) => c.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (c) => c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
// a page's clock moved, and put back by the function it answers
function later(c, ms) {
  const real = c.window.Date.now.bind(c.window.Date);
  c.window.Date.now = () => real() + ms;
  return () => { c.window.Date.now = real; };
}
/* The books while a payment waits: what the entries say less what the page holds has moved since the page was made by
 * exactly what waits in the unclaimed store, which the balance counts and the pile does not yet hold. Once nothing waits,
 * this is the harness's own rule (`booksWrong`). */
function waitOff(c) {
  const now = books(c), was = c.booksFrom || {};
  const key = MINT.replace(/\/+$/, '');
  const moved = ((now[key] || { off: 0 }).off) - ((was[key] || { off: 0 }).off);
  return moved - Math.round(Number(c.W.unclaimedSats()) || 0);
}
// the page's log, line by line, until `.done()`
const logging = (c) => {
  const lines = [];
  const log0 = c.window.console.log, warn0 = c.window.console.warn;
  c.window.console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); return log0.apply(this, arguments); };
  c.window.console.warn = function () { lines.push('WARN ' + Array.prototype.join.call(arguments, ' ')); return warn0.apply(this, arguments); };
  return { lines, done: () => { c.window.console.log = log0; c.window.console.warn = warn0; return lines; } };
};
// what the page was told of kept payments that did not settle, or are late (`onCardKeptLost`)
const listen = (c) => { const heard = []; c.W.onCardKeptLost((x) => heard.push(x)); return heard; };

/* H, the card's owner, with the card set up (recoverable, as every card is) and 2,000 put on it; R, a stranger at the
 * same mint, with nothing. `o.card`: the model's options (format 4, the latest software, unless they say). `o.feePpk`:
 * the mint's input fee. */
async function world(o) {
  const opts = o || {};
  const H = await funded({ feePpk: opts.feePpk, units: opts.units }, opts.fund || 9000);
  const R = await funded({ feePpk: opts.feePpk, sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H, undefined, Object.assign({ format: 4 }, opts.card || {}));
  await H.W.cardSetUp(card, { pin: '1234' });
  card.tap();
  if (opts.binary) await binaryLoad(H, card, opts.binary);
  else await H.W.cardAdd(card, { sats: opts.sats || 2000, pin: '1234' });
  return { H, R, card };
}
// the card pays R with no route; resolves what the wallet answered, or the refusal
async function payOffline(R, card, sats, o) {
  offline(R);
  card.tap();
  card.sent.length = 0;
  const got = await R.W.cardPay(card, Object.assign({ sats, pin: '1234', offline: true }, o || {})).then((r) => r, (e) => ({ refused: (e && e.card) || (e && e.message), error: e }));
  return got;
}
const booksGood = (name, ...pages) => {
  const wrong = [];
  pages.forEach((c) => booksWrong(c).forEach((l) => wrong.push(l)));
  ok(wrong.length === 0, name, wrong.join(' | '));
};

(async () => {
  /* ---- 1: the card pays a page with no route --------------------------------- */
  const A = await world();
  {
    const { H, R, card } = A;
    const loadDate = slotDates(card)[0];
    ok(slotDates(card).length === 1 && Math.abs(loadDate - (Date.now() / 1000 + 14 * 86400)) < 600 && /^0[23]/.test(card.state.record.refund),
       'the owner’s card is recoverable and its money is good for fourteen days', JSON.stringify({ days: ((loadDate - Date.now() / 1000) / 86400).toFixed(2) }));
    const before = await bal(R);
    const onCard = card.balance();
    const trace0 = R.trace.length, circuits0 = R.circuits.length;
    const got = await payOffline(R, card, 592);
    ok(got.kept === true && got.sats === 592 && got.change === null && /^req-card-/.test(got.hash) && got.date === loadDate,
       'with no route a card that proves its money pays: kept, 592, no change, and its date said', JSON.stringify({ kept: got.kept, sats: got.sats, refused: got.refused }));
    const dleqAt = firstOf(card, '1a'), beginAt = firstOf(card, '22');
    const asked = card.sent.filter((a) => a.slice(0, 4) === 'b01a').map((a) => [parseInt(a.substr(4, 2), 16), parseInt(a.substr(6, 2), 16)]);
    ok(dleqAt >= 0 && lastOf(card, '1a') < beginAt && count(card, '22') === 1 && count(card, '23') >= 1 && count(card, '24') === 1 && count(card, '26') === 0,
       'the card is asked for the mint’s proofs first (GET_DLEQ), then BEGIN, its outputs and one signature, and makes no change of its own',
       JSON.stringify({ dleq: count(card, '1a'), begin: count(card, '22'), outputs: count(card, '23'), sign: count(card, '24'), change: count(card, '26') }));
    ok(card.balance() === onCard - 592, 'the card is 592 lighter: it burned the pieces as it signed', String(onCard - card.balance()));
    ok(R.trace.slice(trace0).filter((x) => /^mint /.test(x)).length === 0 && R.circuits.length === circuits0, 'and the mint was asked nothing', R.trace.slice(trace0).join(','));
    const waiting = R.W.cardKeptWaiting();
    ok(waiting.length === 1 && waiting[0].sats === 592 && waiting[0].state === 'kept' && waiting[0].date === loadDate && R.W.trustedWaiting().length === 0,
       'it waits as a kept card payment, not one taken on trust', JSON.stringify(waiting));
    const rec = R.W.cardKept(waiting[0].id);
    const sw = swaps(R)[0] || {};
    ok(rec && rec.state === 'kept' && rec.request.inputs.length > 0 && !!rec.request.inputs[0].witness && rec.request.inputs.slice(1).every((p) => !p.witness)
       && rec.request.outputs.length === sw.amounts.length && rec.request.outputs.every((x) => /^0[23][0-9a-f]{64}$/.test(x.B_) && x.id === sw.keyset)
       && rec.swap && rec.swap.digest === sw.digest && rec.dates.first === loadDate && rec.dates.last === loadDate && rec.proven === rec.request.inputs.length
       && rec.card === card.key && rec.sats === 592 && rec.fee === 0 && rec.refundKey === card.state.record.refund,
       'its record keeps the whole request (the witness on the first piece, the outputs it was signed for), the swap, the date and how many pieces proved',
       rec ? JSON.stringify({ inputs: rec.request.inputs.length, outputs: rec.request.outputs.length, proven: rec.proven }) : 'none');
    const proved = rec ? rec.request.inputs.length : 0;
    // the places BEGIN names are the ones signed for: the proofs asked for are those places, and no others
    const begin = card.sent.filter((a) => a.slice(0, 4) === 'b022')[0] || '';
    const named = (begin.substr(10, parseInt(begin.substr(8, 2), 16) * 2).match(/../g) || []).map((h) => parseInt(h, 16)).sort((a, b) => a - b);
    const askedFor = [].concat(...asked).filter((n) => n !== 255).sort((a, b) => a - b);
    ok(asked.length === Math.ceil(proved / 2) && named.length === proved && JSON.stringify(askedFor) === JSON.stringify(named),
       'the proofs are asked for the picked places only, two to a command', JSON.stringify({ asked: askedFor, signed: named }));
    const e = entryOf(R, got.hash);
    ok(e.dir === 'in' && e.sats === 592 && e.settled === true && e.state === 'success' && e.cardKept === 'waiting' && e.cardDate === loadDate && e.card === card.key && !e.trusted,
       'the entry is received at once, settled, and says it waits for the mint', JSON.stringify({ s: e.state, settled: e.settled, k: e.cardKept }));
    const row = unclaimedRows(R)[got.hash.slice(4)] || {};
    ok(row.cardKept === true && row.card === card.key && row.date === loadDate && !row.trusted && row.amount === 592, 'and its row in the unclaimed store is marked a card’s, with its date');
    ok((await bal(R)) === before + 592 && waitOff(R) === 0, 'the balance is 592 up, and the books add up counting it', String((await bal(R)) - before));
    ok(R.W.cardTaken().length === 0, 'nothing is left in the TAKEN store');
  }

  /* ---- 2: settled at the first connection ------------------------------------- */
  {
    const { H, R } = A;
    const id = R.W.cardKeptWaiting()[0].id;
    const rec = R.W.cardKept(id);
    const posted0 = A.H.mint.posted.length;
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    const swapsPosted = A.H.mint.posted.slice(posted0).filter((p) => p.path === '/v1/swap');
    const after = R.W.cardKept(id);
    ok(after.state === 'settled' && after.endedAt > 0 && after.tries === 1 && R.W.cardKeptWaiting().length === 0 && !unclaimedRows(R)[id] && swaps(R).length === 0,
       'online, it is swapped in: the record is settled, the row and the swap’s row are gone', JSON.stringify({ state: after.state, tries: after.tries }));
    ok(swapsPosted.length === 1 && swapsPosted[0].B_.join() === rec.request.outputs.map((x) => x.B_).join(),
       'the mint saw one swap, for exactly the outputs the card signed for', String(swapsPosted.length));
    const e = entryOf(R, 'req-' + id);
    ok(e.cardKept === 'settled' && e.settled === true && e.state === 'success' && e.sats === 592 && history(R).filter((x) => x.hash === 'req-' + id).length === 1,
       'the same entry says settled, and there is one', JSON.stringify({ k: e.cardKept }));
    ok((await bal(R)) === 592, 'the balance is still 592, now in the pile', String(await bal(R)));
    booksGood('the books of both pages add up once nothing waits', R, H);
  }

  /* ---- 3: the switch ------------------------------------------------------------ */
  {
    const { R, card } = A;
    R.W.cardOffline(false);
    const off = await payOffline(R, card, 64);
    ok(off.refused && off.refused !== 'went through' && card.sent.length === 0 && R.W.cardKeptWaiting().length === 0,
       'switched off, a till with no route refuses a card and does not speak to it', String(off.refused));
    R.W.cardOffline(true);
    const on = await payOffline(R, card, 64);
    ok(on.kept === true && on.sats === 64 && R.W.cardKeptWaiting().length === 1, 'switched on again, it pays', JSON.stringify({ kept: on.kept, refused: on.refused }));
    // and the old name of the asking (`trusted`) is the same asking
    const old = await payOffline(R, card, 32, { offline: undefined, trusted: true });
    ok(old.kept === true && R.W.cardKeptWaiting().length === 2, 'asked by its old name, `trusted`, it is the same', JSON.stringify({ kept: old.kept, refused: old.refused }));
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    ok(R.W.cardKeptWaiting().length === 0 && (await bal(R)) === 592 + 64 + 32, 'and both settle', String(await bal(R)));
    booksGood('the books add up', R);
  }

  /* ---- 4: a week left, by the latest clock --------------------------------------- */
  {
    const W4 = await world();
    const { R, card } = W4;
    const date = slotDates(card)[0] * 1000;
    // six days and twenty-three hours left: refused, before the PIN and before BEGIN
    let undo = later(R, date - (6 * DAY + 23 * HOUR) - Date.now());
    const near = await payOffline(R, card, 592);
    ok(near.refused === 'renew' && /less than 7 days/.test(near.error.message) && /renews it by tapping it on their phone/.test(near.error.message)
       && count(card, '40') === 0 && count(card, '22') === 0 && card.balance() === 2000,
       'with less than a week left on its money, the card is refused offline in its own words, before the PIN and before it is asked to sign', near.error && near.error.message);
    undo();
    // seven days and an hour left: taken
    undo = later(R, date - (7 * DAY + HOUR) - Date.now());
    const fine = await payOffline(R, card, 592);
    ok(fine.kept === true && R.W.cardKeptWaiting().length === 1, 'with a week and an hour left, it is taken', JSON.stringify({ kept: fine.kept, refused: fine.refused }));
    undo();
    // a clock set back three days, on a phone that kept a block header at the real time: the header is the clock
    const W4b = await world();
    const R2 = W4b.R, card2 = W4b.card;
    const date2 = slotDates(card2)[0] * 1000;
    const realAt = date2 - (6 * DAY + 23 * HOUR);
    undo = later(R2, realAt - Date.now());
    tipIs(R2, mineHeader(Math.floor(realAt / 1000)));
    await R2.W.headerRefresh({ force: true });
    const kept = R2.W.headerKept();
    undo();
    undo = later(R2, realAt - 3 * DAY - Date.now());
    const log = logging(R2);
    const skew = await payOffline(R2, card2, 592);
    const lines = log.done();
    ok(!!kept && skew.refused === 'renew' && count(card2, '22') === 0 && lines.some((l) => /held to the time from header/.test(l)),
       'a phone whose clock was set back three days, and that kept a block header at the real time, holds the card to the header and refuses it',
       JSON.stringify({ header: !!kept, refused: skew.refused, said: lines.filter((l) => /held to the time/.test(l)).join('|') }));
    undo();
    // a till with a route needs a day, not a week: three days left is paid, half a day is not
    online(R2);
    undo = later(R2, date2 - 3 * DAY - Date.now());
    card2.tap();
    const three = await R2.W.cardPay(card2, { sats: 300, pin: '1234' }).then((r) => r, (e) => ({ refused: e && e.card }));
    undo();
    undo = later(R2, date2 - 12 * HOUR - Date.now());
    card2.tap();
    const half = await why(R2.W.cardPay(card2, { sats: 300, pin: '1234' }));
    undo();
    ok(three.sats === 300 && half === 'renew', 'a till with a route takes a piece with three days left and refuses one with half a day', JSON.stringify({ three: three.sats || three.refused, half }));
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    await settle();
    booksGood('the books add up', R, R2);
  }

  /* ---- 5: a keyset retired, or a fee changed, between the tap and the connection -- */
  {
    const W5 = await world();
    const { R, card } = W5;
    const heard = listen(R);
    const got = await payOffline(R, card, 592);
    const id = got.hash.slice(4);
    R.fate = (m) => (/\/v1\/swap$/.test(new URL(m.url).pathname) ? '400\n{"code":12002,"detail":"keyset inactive"}' : null);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    R.fate = null;
    const rec = R.W.cardKept(id), e = entryOf(R, got.hash);
    ok(rec.state === 'retired' && rec.endedAt > 0 && e.state === 'failed' && e.settled === false && e.cardKept === 'retired' && !unclaimedRows(R)[id] && swaps(R).length === 0,
       'a keyset retired after the tap: the record is retired, the entry failed, the row and its swap gone', JSON.stringify({ s: rec.state, e: e.state, k: e.cardKept }));
    ok((await bal(R)) === 0 && heard.length === 1 && heard[0].cause === 'retired' && heard[0].sats === 592 && heard[0].id === id && heard[0].date === rec.dates.first,
       'the balance is back where it was, and the page is told, once, why', JSON.stringify(heard));
    booksGood('the books add up', R);

    // the fee: a wallet built from storage keeps it, and the real connect retires it
    const W5b = await world();
    const R5 = W5b.R;
    const heard5 = listen(R5);
    const got5 = await payOffline(R5, W5b.card, 592);
    const id5 = got5.hash.slice(4);
    W5b.H.mint.feeIs(500);
    offline(R5);
    await R5.W.connect(MINT, null, null, { remember: true });
    const cached = R5.W.fromCache();
    online(R5);
    await R5.W.claimUnclaimed();
    await settle();
    const mid = R5.W.cardKept(id5);
    ok(cached === true && mid.state === 'kept' && mid.tries === 1 && !!unclaimedRows(R5)[id5] && heard5.length === 0 && (await bal(R5)) === 592,
       'a fee raised after the tap: tried on a wallet built from storage, it is kept, and nothing is said', JSON.stringify({ cached, state: mid.state, tries: mid.tries }));
    await R5.W.connect(MINT, null, null, { remember: true });
    await R5.W.claimUnclaimed();
    await settle();
    const end = R5.W.cardKept(id5), e5 = entryOf(R5, got5.hash);
    ok(R5.W.fromCache() === false && end.state === 'retired' && e5.state === 'failed' && e5.cardKept === 'retired' && !unclaimedRows(R5)[id5] && (await bal(R5)) === 0
       && heard5.length === 1 && heard5[0].cause === 'retired',
       'and once the mint’s own keys are in, the fee is seen to have changed, and it is retired', JSON.stringify({ state: end.state, why: end.why }));
    W5b.H.mint.feeIs(0);
    booksGood('the books add up', R5);
  }

  /* ---- 6: the owner's take-back, before and after the payment settles ------------- */
  {
    // the owner first: the till is told the money went back
    const W6 = await world();
    const { H, R, card } = W6;
    const heard = listen(R);
    const got = await payOffline(R, card, 592);
    const id = got.hash.slice(4);
    const date = slotDates(card)[0] * 1000;
    const undoH = later(H, date + HOUR - Date.now()), undoR = later(R, date + HOUR - Date.now());
    const h0 = await bal(H);
    const back = await H.W.cardTakeBack(card.key);
    ok(back.sats === 2000 && (await bal(H)) === h0 + 2000, 'after the date, the owner takes back every piece it loaded, the ones signed to the till too', String(back.sats));
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    const rec = R.W.cardKept(id), e = entryOf(R, got.hash);
    ok(rec.state === 'unwound' && e.state === 'failed' && e.cardKept === 'unwound' && (await bal(R)) === 0 && heard.length === 1 && heard[0].cause === 'unwound',
       'then the till, online: the mint says spent, not by this phone, and past the date: it went back to the card’s owner', JSON.stringify({ s: rec.state, heard }));
    undoH(); undoR();
    booksGood('the books of both add up', R, H);

    // the till first: what it settled is not the owner's to take back
    const W6b = await world();
    const got6 = await payOffline(W6b.R, W6b.card, 592);
    const date6 = slotDates(W6b.card)[0] * 1000;
    let uH = later(W6b.H, date6 - HOUR - Date.now()), uR = later(W6b.R, date6 - HOUR - Date.now());
    online(W6b.R);
    await W6b.R.W.claimUnclaimed();
    await settle();
    ok(W6b.R.W.cardKept(got6.hash.slice(4)).state === 'settled' && (await bal(W6b.R)) === 592, 'an hour before the date, the till settles', String(await bal(W6b.R)));
    uH(); uR();
    uH = later(W6b.H, date6 + HOUR - Date.now());
    const hb = await bal(W6b.H);
    const back6 = await W6b.H.W.cardTakeBack(W6b.card.key);
    uH();
    ok(back6.sats === 2000 - 592 && (await bal(W6b.H)) === hb + 2000 - 592, 'after it, the owner takes back the rest, and nothing of what the till settled', String(back6.sats));
    booksGood('the books of both add up', W6b.R, W6b.H);
  }

  /* ---- 7: a swap posted more than once ------------------------------------------- */
  {
    const W7 = await world();
    const { R, card } = W7;
    const got = await payOffline(R, card, 592);
    const id = got.hash.slice(4);
    const rowCopy = JSON.parse(JSON.stringify(unclaimedRows(R)[id]));
    // the mint makes the swap and its answer is lost on the way back
    let first = true;
    R.hang = () => (first ? ((first = false), { reach: true, failAfter: 50 }) : null);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    R.hang = null;
    for (let i = 0; i < 5 && R.W.cardKeptWaiting().length; i++) { await R.W.claimUnclaimed(); await settle(); }
    const e = entryOf(R, got.hash);
    ok(R.W.cardKept(id).state === 'settled' && (await bal(R)) === 592 && e.state === 'success' && e.cardKept === 'settled' && history(R).every((x) => x.state !== 'failed'),
       'an answer lost after the mint made the swap: found again, settled, 592 once, and never failed', JSON.stringify({ s: R.W.cardKept(id).state, bal: await bal(R) }));
    booksGood('the books add up', R);
    // the same row walked again: its record is over, and it is let go unposted
    const store = unclaimedRows(R);
    store[id] = rowCopy;
    R.storage.setItem('foxy.req.unclaimed', JSON.stringify(store));
    const posted0 = W7.H.mint.posted.length;
    await R.W.claimUnclaimed();
    await settle();
    ok(!unclaimedRows(R)[id] && W7.H.mint.posted.length === posted0 && (await bal(R)) === 592, 'the row walked again, its payment over: let go, not posted, no second credit');
    // and walked again with its record as it was before it settled (a write lost): spent, found to be this phone's own, no second credit
    const recs = keptRows(R).map((r) => (r.id === id ? Object.assign({}, r, { state: 'kept', endedAt: 0 }) : r));
    R.storage.setItem('foxy.flashcard.kept', JSON.stringify(recs));
    const store2 = unclaimedRows(R);
    store2[id] = rowCopy;
    R.storage.setItem('foxy.req.unclaimed', JSON.stringify(store2));
    await R.W.claimUnclaimed();
    await settle();
    ok(R.W.cardKept(id).state === 'settled' && !unclaimedRows(R)[id] && (await bal(R)) === 592 && entryOf(R, got.hash).state === 'success',
       'and with its record put back as it was: the mint says spent, the outputs say it was this phone, settled again, no second credit', JSON.stringify({ s: R.W.cardKept(id).state, bal: await bal(R) }));
    booksGood('the books still add up', R);

    // somebody else posts the request (a copy of it): the mint signs this phone's outputs, which only this phone can open
    const W7b = await world();
    const R7 = W7b.R;
    const got7 = await payOffline(R7, W7b.card, 592);
    const rec7 = R7.W.cardKept(got7.hash.slice(4));
    const answer = W7b.H.mint.handle({ url: MINT + '/v1/swap', method: 'POST',
      body: JSON.stringify({ inputs: rec7.request.inputs, outputs: rec7.request.outputs }) });
    ok(/^200\n/.test(answer), 'another page posts the request itself, and the mint makes the swap', answer.slice(0, 60));
    const heard7 = listen(R7);
    online(R7);
    await R7.W.claimUnclaimed();
    await settle();
    ok(R7.W.cardKept(got7.hash.slice(4)).state === 'settled' && (await bal(R7)) === 592 && heard7.length === 0 && entryOf(R7, got7.hash).cardKept === 'settled',
       'the till finds its own outputs signed (NUT-09), and the payment is its own: settled, 592', JSON.stringify({ s: R7.W.cardKept(got7.hash.slice(4)).state, bal: await bal(R7) }));
    booksGood('the books add up', R7);
  }

  /* ---- 8: a mint that does not answer, and then does -------------------------------- */
  {
    const W8 = await world();
    const { R, card } = W8;
    const heard = listen(R);
    const got = await payOffline(R, card, 592);
    const id = got.hash.slice(4);
    online(R);
    R.deaf = true;
    await R.W.claimUnclaimed();
    await settle();
    const rec = R.W.cardKept(id);
    ok(rec.state === 'kept' && rec.tries === 1 && entryOf(R, got.hash).cardKept === 'waiting' && R.W.cardKeptWaiting().length === 1 && heard.length === 0 && (await bal(R)) === 592,
       'a mint that does not answer: kept, tried once, still waiting, and nothing said with its date far off', JSON.stringify({ s: rec.state, tries: rec.tries }));
    const date = slotDates(card)[0] * 1000;
    const undo = later(R, date - DAY - Date.now());
    await R.W.claimUnclaimed();
    await settle();
    await R.W.claimUnclaimed();
    await settle();
    undo();
    ok(heard.length === 1 && heard[0].cause === 'late' && heard[0].id === id && heard[0].sats === 592 && R.W.cardKept(id).state === 'kept',
       'a day before its date, still not answered: said to be late, once', JSON.stringify(heard));
    R.deaf = false;
    for (let i = 0; i < 4 && R.W.cardKeptWaiting().length; i++) { await R.W.claimUnclaimed(); await settle(); }
    ok(R.W.cardKept(id).state === 'settled' && (await bal(R)) === 592, 'and once it answers, settled', JSON.stringify({ s: R.W.cardKept(id).state }));
    await settle();
    booksGood('the books add up', R);
  }

  /* ---- 9: a wallet that holds dollars ----------------------------------------------
   * Only with the dollars build (`convertOne`): a card's payment kept with no route, to a wallet that holds dollars and
   * agreed it for dollars, is owed to be swapped into dollars, claimed when the swap lands, and swapped after. */
  {
    const probe = A.R;
    if (typeof probe.W.convertOne !== 'function') {
      console.log('skip  a wallet that holds dollars takes a card’s offline payment in dollars: this build has no dollars build (convertOne)');
    } else {
      const W9 = await world({ units: ['sat', 'usd'] });
      const { R, card } = W9;
      R.W._swapPollMs = 5;
      R.W._swapClaimWaitMs = 200;
      R.W.setWalletChoice({ hold: 'dollars' });
      const convertRecs = () => JSON.parse(R.storage.getItem('foxy.cashu.convert') || '[]');
      // a price this phone saw a moment ago, which the mint's own rate agrees with: the swap is made by it (`convertOne`)
      R.W._rate = 76900; R.W._rateAt = Date.now();
      const got = await payOffline(R, card, 592, { terms: { usd: 50, rate: 84000, ageMs: 1000, seenAt: Date.now(), convert: true } });
      const id = got.hash ? got.hash.slice(4) : '';
      const owed = convertRecs().filter((r) => r.id === id)[0] || {};
      ok(got.kept === true && owed.state === 'owed' && owed.hash === got.hash && entryOf(R, got.hash).usdAsked === 50 && waitOff(R) === 0,
         'paid by card with no route, a wallet that holds dollars owes itself the swap into dollars, and the entry says the dollars asked', JSON.stringify({ state: owed.state }));
      online(R);
      await R.W.claimUnclaimed();
      await settle();
      const claimed = convertRecs().filter((r) => r.id === id)[0] || {};
      ok(R.W.cardKept(id).state === 'settled' && /claimed|done|swapping|pending/.test(String(claimed.state)), 'settled at the connection, and the sats are claimed for the swap', JSON.stringify({ state: claimed.state }));
      const usd0 = R.W.balanceOf('usd');
      if (claimed.state === 'claimed') await R.W.convertOne();
      await settle();
      // (what the swap leaves in sats, the melt's change, is the dollars build's own to say: tests/convert-on-return.js)
      ok(R.W.balanceOf('usd') > usd0 && R.W.balanceOf('sat') < 592, 'and swapped into dollars: dollars up, the sats spent on them', JSON.stringify({ usd: R.W.balanceOf('usd'), sat: R.W.balanceOf('sat') }));
      booksGood('the books add up in both units', R);
    }
  }

  /* ---- 10: a card that cannot prove its money ----------------------------------------- */
  {
    // software 1.19: no proofs. Refused offline before anything is asked of it, paid online
    const W10 = await world({ card: { software: 19 } });
    const old = await payOffline(W10.R, W10.card, 592);
    ok(old.refused === 'offline-old' && count(W10.card, '40') === 0 && count(W10.card, '22') === 0 && W10.R.W.cardKeptWaiting().length === 0,
       'a card of 1.19 is too old to pay with no route: refused, no PIN, nothing signed', String(old.refused));
    online(W10.R);
    W10.card.tap();
    const paid = await W10.R.W.cardPay(W10.card, { sats: 592, pin: '1234' });
    ok(paid.sats === 592 && !paid.kept, 'online, it pays as ever', String(paid.sats));

    // a piece whose C was changed on the card: its proof does not verify
    const W10b = await world();
    const live = W10b.card.state.slots.map((x, i) => (x.status === 1 ? i : -1)).filter((i) => i >= 0);
    const Cs = live.map((i) => W10b.card.state.slots[i].data.substr(88, 66));
    live.forEach((i, k) => { const s = W10b.card.state.slots[i]; s.data = s.data.slice(0, 88) + Cs[(k + 1) % Cs.length] + s.data.slice(154); });
    const fake = await payOffline(W10b.R, W10b.card, 592);
    ok(fake.refused === 'fake' && /did not sign/.test(fake.error.message) && count(W10b.card, '40') === 0 && count(W10b.card, '22') === 0 && W10b.card.balance() === 2000,
       'a card whose pieces do not prove (their C changed): refused as fake, before the PIN, nothing signed', fake.error && fake.error.message);

    // a card of 1.20 whose pieces were loaded with no proofs
    const W10c = await world({ card: { proofRoom: false } });
    const none = await payOffline(W10c.R, W10c.card, 592);
    ok(none.refused === 'offline-unproven' && /cannot prove its money/.test(none.error.message) && count(W10c.card, '22') === 0 && none.error.proven === 0,
       'a card that kept no proofs cannot prove its money offline: refused, nothing signed', none.error && none.error.message);
    online(W10c.R);
    W10c.card.tap();
    const paidC = await W10c.R.W.cardPay(W10c.card, { sats: 592, pin: '1234' });
    ok(paidC.sats === 592, 'and online it pays', String(paidC.sats));
    booksGood('the books add up', W10.R, W10c.R, W10b.R);
  }

  /* ---- 11: the online till read is unchanged ------------------------------------------- */
  {
    const W11 = await world();
    const { R, card } = W11;
    online(R);
    card.tap();
    card.sent.length = 0;
    const paid = await R.W.cardPay(card, { sats: 592, pin: '1234' });
    ok(paid.sats === 592 && !paid.kept && paid.change === null && count(card, '1a') === 0 && count(card, '22') === 1 && count(card, '24') === 1
       && keptRows(R).length === 0 && R.W.cardKeptWaiting().length === 0 && (await bal(R)) === 592,
       'online, a card pays as it did: no proofs read, one signature, swapped at once, no kept record', JSON.stringify({ dleq: count(card, '1a'), kept: keptRows(R).length }));
    booksGood('the books add up', R);
  }

  /* ---- 12: a stranger's change keeps the payment's date -------------------------------- */
  {
    const W12 = await world({ binary: 1024 });
    const { R, card } = W12;
    const date = slotDates(card)[0];
    online(R);
    card.tap();
    const paid = await R.W.cardPay(card, { sats: 200, pin: '1234' });
    if (paid.change && paid.change.sats > 0 && !paid.change.written) { card.tap(); await R.W.cardWrite(card, { change: true }); }
    await settle();
    ok(paid.sats === 200 && card.balance() === 824 && slotDates(card).length === 1 && slotDates(card)[0] === date,
       'a stranger’s payment with change: the change the card holds after it keeps the date of the pieces it paid with', JSON.stringify({ dates: slotDates(card), date, card: card.balance() }));
    booksGood('the books add up', R);
  }

  /* ---- 13: the owner's renewal ----------------------------------------------------------- */
  {
    // a card that signs for eight pieces at a time (no `many`), with more than sixteen pieces on it
    const W13 = await world({ card: { software: 7 }, fund: 12000, sats: 3000 });
    const { H, card } = W13;
    ok(H.W.cardRefreshLeft() === 10 * 86400, 'the owner renews a card with ten days left', String(H.W.cardRefreshLeft()));
    const n = card.state.slots.filter((x) => x.status === 1).length;
    const date0 = slotDates(card)[0];
    const undo = later(H, date0 * 1000 - 9 * DAY - Date.now());
    const hb = await bal(H);
    card.tap();
    card.sent.length = 0;
    const renewed = await H.W.cardRenew(card, { pin: '1234' });
    const nowS = Math.floor(H.window.Date.now() / 1000);
    ok(n > 16 && count(card, '24') === Math.ceil(n / 8) && renewed.sats === 3000 && card.balance() === 3000 && slotDates(card).length === 1
       && Math.abs(slotDates(card)[0] - (nowS + 14 * 86400)) < 600 && (await bal(H)) === hb,
       'with nine days left, renewed in one tap: every piece off in a signature for each eight, and on again with one date fourteen days on',
       JSON.stringify({ pieces: n, signatures: count(card, '24'), days: ((slotDates(card)[0] - nowS) / 86400).toFixed(2) }));
    undo();

    // cut between the taking off and the writing: the money is in this phone, owed to the card, and the next tap writes it
    const W13b = await world({ sats: 1000 });
    const Hb = W13b.H, cb = W13b.card;
    const d0 = slotDates(cb)[0];
    const u2 = later(Hb, d0 * 1000 - 9 * DAY - Date.now());
    const h0 = await bal(Hb);
    cb.tap();
    cb.leaveBefore('30', 1);
    const cut = await why(Hb.W.cardRenew(cb, { pin: '1234' }));
    const owed = Hb.W.cardOwed().filter((r) => r.card === cb.key);
    ok(cut !== 'went through' && cb.balance() === 0 && owed.length > 0 && owed.every((r) => r.kind === 'load') && owed.reduce((s, r) => s + r.sats, 0) === 1000,
       'cut between taking the money off and writing it: the card is empty, and 1,000 is owed to it as a load', JSON.stringify({ cut, owed: owed.map((r) => [r.kind, r.sats]) }));
    cb.tap();
    await Hb.W.cardWrite(cb, { pin: '1234' });
    const nowB = Math.floor(Hb.window.Date.now() / 1000);
    ok(cb.balance() === 1000 && Hb.W.cardOwed().length === 0 && slotDates(cb).length === 1 && Math.abs(slotDates(cb)[0] - (nowB + 14 * 86400)) < 600 && (await bal(Hb)) === h0,
       'the next tap writes it, with a fresh date fourteen days on', JSON.stringify({ card: cb.balance(), days: ((slotDates(cb)[0] - nowB) / 86400).toFixed(2) }));
    u2();
    booksGood('the books add up', H, Hb);
  }

  /* ---- 14: set-up is recoverable ---------------------------------------------------------- */
  {
    const H = await funded({}, 3000);
    const c = newCard(H, undefined, { format: 4 });
    const set = await H.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    await H.W.cardAdd(c, { sats: 500, pin: '1234' });
    ok(/^0[23][0-9a-f]{64}$/.test(set.record.refundKey) && c.state.record.refund === set.record.refundKey && !!H.W.cardsKnown()[c.key]
       && slotDates(c).length === 1 && Math.abs(slotDates(c)[0] - (Date.now() / 1000 + 14 * 86400)) < 600,
       'a card set up with nothing said is recoverable, and what is put on it is good for fourteen days', JSON.stringify({ refund: set.record.refundKey.slice(0, 6) }));
    booksGood('the books add up', H);
  }

  /* ---- 15: the swap found by the wallet's own recovery first ----------------------------------
   * The mint makes the swap and the answer is lost, and the restore in the same walk cannot be had either (the mint
   * silent, or the page gone). The next connection's sweep runs the recovery of lost swaps before the walk: it finds the
   * outputs, and the kept payment is settled there, with its own entry left as it was. */
  for (const how of ['the mint silent after it', 'the page gone while it was posted']) {
    const W15 = await world();
    const { H, R, card } = W15;
    const got = await payOffline(R, card, 592);
    const id = got.hash.slice(4);
    let page = R;
    online(R);
    if (how === 'the mint silent after it') {
      let first = true;
      R.hang = () => (first ? ((first = false), (R.deaf = true), { reach: true, failAfter: 50 }) : null);
      await R.W.claimUnclaimed();
      await settle();
      R.hang = null; R.deaf = false;
    } else {
      R.hang = () => ({ reach: true });
      R.W.claimUnclaimed();
      await settle(); await settle();
      // the next launch: a page on the same storage
      page = await funded({ sharedMint: H.mint, words: OTHER_WORDS, storage: R.storage }, 0);
      page.booksFrom = R.booksFrom;
      online(page);
    }
    ok(['kept', 'posting'].indexOf(page.W.cardKept(id).state) >= 0 && !!unclaimedRows(page)[id], how + ': the walk could not tell, and the payment still waits',
       page.W.cardKept(id).state);
    await page.W.recoverSwaps();
    await settle();
    const e = entryOf(page, got.hash);
    ok(page.W.cardKept(id).state === 'settled' && page.W.cardKeptWaiting().length === 0 && !unclaimedRows(page)[id]
       && e.state === 'success' && e.cardKept === 'settled' && e.memo === 'card, offline' && e.sats === 592 && !(e.feeSats > 0),
       'the recovery of lost swaps finds it: settled, nothing waits, and its entry is still the card’s, as it was', JSON.stringify({ s: page.W.cardKept(id).state, memo: e.memo, k: e.cardKept }));
    await page.W.claimUnclaimed();
    await settle();
    ok((await bal(page)) === 592 && history(page).filter((x) => x.hash === got.hash).length === 1 && page.W.cardKeptWaiting().length === 0,
       'and the walk after it has nothing to do: 592, one entry', String(await bal(page)));
    R.hang = null;
    booksGood('the books add up', page);
  }

  /* ---- 16: the tap's own writes, one of them refused ---------------------------------------------
   * The record is written and the unclaimed row is refused (storage full): the tap says so, the record is struck, and
   * the TAKEN row is the payment, posted online as any card payment is. */
  {
    const { R, card } = await world();
    const P = R.window.Storage.prototype, setItem0 = P.setItem;
    P.setItem = function (k, v) { if (k === 'foxy.req.unclaimed') throw new Error('QuotaExceededError'); return setItem0.call(this, k, v); };
    const got = await payOffline(R, card, 592);
    P.setItem = setItem0;
    ok(!!got.refused && R.W.cardTaken().length === 1 && R.W.cardKeptWaiting().length === 0 && keptRows(R).length === 0,
       'its row refused: the tap says so, and no kept record is left waiting for a row that never came', JSON.stringify({ refused: String(got.refused).slice(0, 40), kept: keptRows(R).length }));
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    await R.W.cardSettle();
    await settle();
    ok(R.W.cardTaken().length === 0 && (await bal(R)) === 592 && R.W.cardKeptWaiting().length === 0, 'online, the TAKEN row is posted as a card payment: 592, and nothing waits', String(await bal(R)));
    booksGood('the books add up', R);
  }
  // the same, where even striking the record is refused: the next settling finds it beside its TAKEN row, and lets it go
  {
    const { R, card } = await world();
    const P = R.window.Storage.prototype, setItem0 = P.setItem;
    let kept = 0;
    P.setItem = function (k, v) {
      if (k === 'foxy.req.unclaimed') throw new Error('QuotaExceededError');
      if (k === 'foxy.flashcard.kept' && (kept += 1) > 1) throw new Error('QuotaExceededError');
      return setItem0.call(this, k, v);
    };
    await payOffline(R, card, 592);
    P.setItem = setItem0;
    ok(R.W.cardKeptWaiting().length === 1 && R.W.cardTaken().length === 1, 'the record could not be struck: it is there, with the TAKEN row');
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    await R.W.cardSettle();
    await settle();
    ok(R.W.cardKeptWaiting().length === 0 && keptRows(R).length === 0 && R.W.cardTaken().length === 0 && (await bal(R)) === 592,
       'the walk lets the record go, the TAKEN row is the payment: 592, and nothing waits', JSON.stringify({ waiting: R.W.cardKeptWaiting().length, bal: await bal(R) }));
    booksGood('the books add up', R);
  }

  /* ---- 17: a tap cut off after its entry and before its TAKEN row was struck ----------------------
   * The TAKEN row, the unclaimed row and the record are all there. Whichever settles first, the payment is one entry of
   * 592, and the TAKEN row is never posted as a second. */
  for (const first of ['the walk', 'the TAKEN settling']) {
    const { R, card } = await world();
    let lastTaken = null;
    const P = R.window.Storage.prototype, setItem0 = P.setItem;
    P.setItem = function (k, v) { if (k === 'foxy.flashcard.taken') { try { if (JSON.parse(v).length) lastTaken = v; } catch (x) {} } return setItem0.call(this, k, v); };
    const got = await payOffline(R, card, 592);
    P.setItem = setItem0;
    R.storage.setItem('foxy.flashcard.taken', lastTaken);
    ok(R.W.cardTaken().length === 1 && !!unclaimedRows(R)[got.hash.slice(4)] && R.W.cardKeptWaiting().length === 1, 'cut off before its last step: TAKEN, the row and the record are all there');
    online(R);
    if (first === 'the walk') { await R.W.claimUnclaimed(); await settle(); await R.W.cardSettle(); }
    else { await R.W.cardSettle(); await settle(); await R.W.claimUnclaimed(); }
    await settle();
    for (let i = 0; i < 2; i++) { await R.W.cardSettle(); await R.W.claimUnclaimed(); await settle(); }
    const mine = history(R).filter((x) => /card-/.test(String(x.hash)) && x.dir === 'in' && x.state !== 'failed');
    ok(R.W.cardTaken().length === 0 && R.W.cardKept(got.hash.slice(4)).state === 'settled' && mine.length === 1 && mine[0].hash === got.hash && (await bal(R)) === 592,
       first + ' first: one entry of 592, settled, and the TAKEN copy struck, never posted', JSON.stringify(mine.map((x) => x.hash.slice(0, 9))));
    booksGood('the books add up', R);
  }

  /* ---- 18: this phone's own library, not the mint, naming a keyset ---------------------------------
   * The swap could not be set out (the library's words name a keyset): not the mint's answer, so nothing ends. Kept on a
   * wallet built from storage, and on a real one too where nothing about the mint has changed. */
  for (const words of ['Could not resolve unknown keyset 00ab', 'Cannot split amount, keyset is inactive or contains no keys']) {
    const { R, card } = await world();
    const heard = listen(R);
    const got = await payOffline(R, card, 592);
    const id = got.hash.slice(4);
    const CT = R.window.CashuTS;
    const name = Object.keys(CT).filter((k) => CT[k] && CT[k].prototype && CT[k].prototype.prepareSwapToReceive)[0];
    const proto = CT[name].prototype, orig = proto.prepareSwapToReceive;
    proto.prepareSwapToReceive = function () { return Promise.reject(new Error(words)); };
    await R.W.connect(MINT, null, null, { remember: true }).catch(() => {});
    offline(R);
    await R.W.connect(MINT, null, null, { remember: true }).catch(() => {});
    const cached = R.W.fromCache();
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    const mid = R.W.cardKept(id).state;
    await R.W.connect(MINT, null, null, { remember: true }).catch(() => {});
    await R.W.claimUnclaimed();
    await settle();
    proto.prepareSwapToReceive = orig;
    ok(cached && mid === 'kept' && R.W.fromCache() === false && R.W.cardKept(id).state === 'kept' && !!unclaimedRows(R)[id] && heard.length === 0 && entryOf(R, got.hash).state === 'success',
       '“' + words.slice(0, 30) + '…” from the library: kept on a wallet built from storage and on a real one, nothing ended', JSON.stringify({ cached, mid, now: R.W.cardKept(id).state }));
    for (let i = 0; i < 3 && R.W.cardKeptWaiting().length; i++) { await R.W.claimUnclaimed(); await settle(); }
    ok(R.W.cardKept(id).state === 'settled' && (await bal(R)) === 592, 'and once it can be set out, settled');
    booksGood('the books add up', R);
  }

  /* ---- 19: the mint refuses the card's signature ---------------------------------------------------
   * Over (`unwound` past the date, `retired` before it), and told as the signature: not the mint's keys, and not the
   * owner taking it back. */
  for (const when of ['before its date', 'after its date']) {
    const { R, card } = await world();
    const heard = listen(R);
    const got = await payOffline(R, card, 592);
    const id = got.hash.slice(4);
    const undo = when === 'after its date' ? later(R, got.date * 1000 + HOUR - Date.now()) : () => {};
    R.fate = (m) => (/\/v1\/swap$/.test(new URL(m.url).pathname) ? '400\n{"code":11010,"detail":"Witness signature is not valid: locktime has passed"}' : null);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    R.fate = null;
    undo();
    const want = when === 'after its date' ? 'unwound' : 'retired';
    const e = entryOf(R, got.hash);
    ok(R.W.cardKept(id).state === want && e.state === 'failed' && e.cardKept === want && e.cardWhy === 'signature' && heard.length === 1 && heard[0].cause === want && heard[0].why === 'signature'
       && card.balance() === 2000 - 592 && (await bal(R)) === 0,
       when + ', the signature refused: ' + want + ', said as the signature, and the card’s owner took nothing', JSON.stringify(heard));
    booksGood('the books add up', R);
  }

  /* ---- 20: what a kept payment was counted for, undone when it ends ------------------------------------ */
  // a share of a split bill it paid, ticked at the tap, is open again
  {
    const { R, card } = await world();
    const heard = listen(R);
    R.storage.setItem('foxy.split.pending', JSON.stringify({ at: Date.now(), rows: [{ hash: 'inv-share-1', bolt11: 'lnbc1share', sats: 592, paid: false },
                                                                                     { hash: 'inv-share-2', bolt11: 'lnbc2share', sats: 592, paid: false }] }));
    const rows = () => (JSON.parse(R.storage.getItem('foxy.split.pending') || '{}').rows || []);
    const got = await payOffline(R, card, 592);
    R.W.splitNoteCard('inv-share-1', got.hash);
    await R.W.splitReconcile().catch(() => {});
    ok(rows()[0].paid === true && rows()[0].card === got.hash, 'a share paid by the card with no route is ticked at the tap, its entry received', JSON.stringify(rows()[0]));
    R.fate = (m) => (/\/v1\/swap$/.test(new URL(m.url).pathname) ? '400\n{"code":12002,"detail":"keyset inactive"}' : null);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    R.fate = null;
    await R.W.splitReconcile().catch(() => {});
    ok(rows()[0].paid === false && !rows()[0].card && rows()[1].paid === false && heard.length === 1 && JSON.stringify(heard[0].shares) === '[0]',
       'the payment retired: the share is open again, with nothing paid on it, and the page is told which', JSON.stringify({ share: rows()[0], heard: heard[0] && heard[0].shares }));
    booksGood('the books add up', R);
  }
  // a send with no route, from a balance that is all a kept payment, says why it cannot be spent
  {
    const { R, card } = await world();
    await payOffline(R, card, 592);
    const said = await R.W.sendToken(100).then(() => '', (e) => String((e && e.message) || ''));
    ok((await bal(R)) === 592 && /Another 592 sats a card paid while this phone was offline cannot be spent until the mint has settled them\.$/.test(said),
       'a send of 100 with no route: the 592 a card paid is in the balance, and the refusal says why it cannot be spent yet', said);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    booksGood('the books add up', R);
  }

  /* ---- 21: a dollars wallet, found settled another way, or ended ----------------------------------------- */
  if (typeof A.R.W.convertOne === 'function') {
    for (const how of ['another page posted it', 'the keyset retired']) {
      const W21 = await world({ units: ['sat', 'usd'] });
      const { R, card } = W21;
      R.W._swapPollMs = 5;
      R.W._swapClaimWaitMs = 200;
      R.W.setWalletChoice({ hold: 'dollars' });
      R.W._rate = 76900; R.W._rateAt = Date.now();
      const convertRecs = () => JSON.parse(R.storage.getItem('foxy.cashu.convert') || '[]');
      const got = await payOffline(R, card, 592, { terms: { usd: 50, rate: 84000, ageMs: 1000, seenAt: Date.now(), convert: true } });
      const id = got.hash.slice(4);
      ok(entryOf(R, got.hash).convert === 'owed', 'the entry says the swap into dollars is owed, as a request’s does', String(entryOf(R, got.hash).convert));
      let due = 0;
      R.W._onConvertDue = () => { due += 1; };
      if (how === 'another page posted it') {
        const rec0 = R.W.cardKept(id);
        W21.H.mint.handle({ url: MINT + '/v1/swap', method: 'POST', body: JSON.stringify({ inputs: rec0.request.inputs, outputs: rec0.request.outputs }) });
      } else {
        R.fate = (m) => (/\/v1\/swap$/.test(new URL(m.url).pathname) ? '400\n{"code":12002,"detail":"keyset inactive"}' : null);
      }
      online(R);
      await R.W.claimUnclaimed();
      await settle();
      R.fate = null;
      const c = convertRecs().filter((r) => r.id === id)[0] || {};
      if (how === 'another page posted it') {
        ok(R.W.cardKept(id).state === 'settled' && c.state === 'claimed' && due === 1 && entryOf(R, got.hash).convert === 'claimed',
           'found settled after a spent answer: the sats are claimed for the swap into dollars, and the page told', JSON.stringify({ state: c.state, due }));
      } else {
        ok(R.W.cardKept(id).state === 'retired' && c.state === 'kept' && c.why === 'retired' && due === 0 && entryOf(R, got.hash).convert === 'kept',
           'retired: nothing came to swap, and the swap into dollars is let go with why', JSON.stringify({ state: c.state, why: c.why }));
      }
    }
  } else {
    console.log('skip  a dollars wallet’s kept payment, found settled another way or ended: this build has no dollars build (convertOne)');
  }

  /* ---- 22: a payment the card left part way through, taken up with no route ------------------------------- */
  {
    // begun with no route: its pieces were proved before the card was asked, and the tap that takes it up finishes it
    const { R, card } = await world();
    offline(R);
    card.tap();
    card.loseAnswerOf('24', 1);
    const lost = await R.W.cardPay(card, { sats: 592, pin: '1234', offline: true }).then((r) => r, (e) => e);
    ok(lost && lost.card && card.balance() === 2000 - 592 && (await bal(R)) === 0, 'its signature’s answer lost: not paid yet, and the card has signed', lost && lost.card);
    const again = await payOffline(R, card, 592);
    ok(again.kept === true && again.sats === 592 && card.balance() === 2000 - 592 && R.W.cardKeptWaiting().length === 1 && (await bal(R)) === 592 && R.W.cardTaken().length === 0,
       'tapped again for the same amount with no route: taken up and kept, the card no lighter than once', JSON.stringify({ kept: again.kept, refused: again.refused }));
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    ok(R.W.cardKeptWaiting().length === 0 && (await bal(R)) === 592, 'and settled online: 592');
    booksGood('the books add up', R);
  }
  {
    // begun online, and never proved: not taken up with no route
    const { R, card } = await world();
    online(R);
    card.tap();
    card.loseAnswerOf('24', 1);
    const lost = await R.W.cardPay(card, { sats: 592, pin: '1234' }).then((r) => r, (e) => e);
    const again = await payOffline(R, card, 592);
    ok(lost && lost.card && again.refused === 'offline-unproven' && again.error.held === true && count(card, '24') === 0 && R.W.cardKeptWaiting().length === 0 && R.W.cardTaken().length === 1,
       'one begun online and taken up with no route: refused, the card not asked to sign, what it signed still held', JSON.stringify({ refused: again.refused }));
    online(R);
    card.tap();
    const done = await R.W.cardPay(card, { sats: 592, pin: '1234' }).then((r) => r, (e) => e);
    await settle();
    ok(done && done.sats === 592 && (await bal(R)) === 592 && card.balance() === 2000 - 592, 'online, the same tap takes it up and it is paid', JSON.stringify({ sats: done && done.sats }));
    booksGood('the books add up', R);
  }

  /* ---- 23: a cash card (date 0) offline ---------------------------------------------------------------------- */
  {
    const H = await funded({}, 9000);
    const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
    const cash = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(cash, { pin: '1234', recoverable: false });
    cash.tap();
    await H.W.cardAdd(cash, { sats: 2000, pin: '1234' });
    const heard = listen(R);
    const got = await payOffline(R, cash, 592);
    ok(got.kept === true && got.date === 0 && R.W.cardKeptWaiting()[0].date === 0, 'a card with no date pays with no route: kept, undated', JSON.stringify({ kept: got.kept, date: got.date }));
    // far on, and the mint not answering: never late, and never gone back, since nobody else can ever spend it
    const undo = later(R, 400 * DAY);
    online(R);
    R.deaf = true;
    await R.W.claimUnclaimed();
    await settle();
    await R.W.claimUnclaimed();
    await settle();
    ok(heard.length === 0 && R.W.cardKept(got.hash.slice(4)).state === 'kept', 'a year on with the mint silent: not said to be late, still kept', JSON.stringify(heard));
    R.deaf = false;
    for (let i = 0; i < 3 && R.W.cardKeptWaiting().length; i++) { await R.W.claimUnclaimed(); await settle(); }
    undo();
    ok(R.W.cardKept(got.hash.slice(4)).state === 'settled' && (await bal(R)) === 592 && heard.length === 0, 'and settled once the mint answers: 592');
    booksGood('the books add up', R, H);
  }

  /* ---- 24: the card's owner, paid by its own card with no route ---------------------------------------------- */
  {
    const { H, card } = await world();
    const b0 = await bal(H);
    const date = slotDates(card)[0] * 1000;
    // three days left: under the week a stranger needs, and its owner's phone holds it to its own margin
    const undo = later(H, date - 3 * DAY - Date.now());
    const got = await payOffline(H, card, 592);
    ok(got.kept === true && card.balance() === 2000 - 592 && (await bal(H)) === b0 + 592,
       'three days from its date, its owner’s phone is paid by it with no route: kept', JSON.stringify({ kept: got.kept, refused: got.refused }));
    online(H);
    await H.W.claimUnclaimed();
    await settle();
    undo();
    ok(H.W.cardKept(got.hash.slice(4)).state === 'settled', 'and settled online');
    booksGood('the books add up', H);
  }

  /* ---- 25: a kept payment's row with no record (the store lost) ------------------------------------------------- */
  {
    const { R, card } = await world();
    const heard = listen(R);
    const got = await payOffline(R, card, 592);
    const id = got.hash.slice(4);
    R.storage.setItem('foxy.flashcard.kept', '[]');
    R.fate = (m) => (/\/v1\/swap$/.test(new URL(m.url).pathname) ? '400\n{"code":11001,"detail":"Token already spent"}' : null);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    R.fate = null;
    const e = entryOf(R, got.hash);
    ok(!unclaimedRows(R)[id] && e.state === 'failed' && e.cardKept === 'spent' && heard.length === 1 && heard[0].cause === 'spent' && (await bal(R)) === 0,
       'spent, not by this phone, with its record lost: it ends as spent all the same, and is not counted for good', JSON.stringify({ e: e.state, heard }));
    booksGood('the books add up', R);
  }

  /* ---- 26: a fee change that leaves less than nothing: retired, never dropped as dust ------------------------------ */
  {
    const { H, R, card } = await world();
    const got = await payOffline(R, card, 16);
    const id = got.hash.slice(4);
    H.mint.feeIs(16000);
    // the next launch, which has the mint's new fee from the start (a page on the same storage)
    const R2 = await funded({ sharedMint: H.mint, words: OTHER_WORDS, storage: R.storage }, 0);
    R2.booksFrom = R.booksFrom;
    const heard = listen(R2);
    online(R2);
    await R2.W.claimUnclaimed();
    await settle();
    H.mint.feeIs(0);
    const e = entryOf(R2, got.hash);
    ok(got.kept === true && R2.W.cardKept(id).state === 'retired' && e.state === 'failed' && e.cardKept === 'retired' && heard.length === 1 && heard[0].cause === 'retired',
       'a fee raised past what a 16 sat payment is worth: retired and said, not let go unsaid as too little to claim', JSON.stringify({ s: R2.W.cardKept(id).state, why: R2.W.cardKept(id).why }));
    booksGood('the books add up', R2);
  }

  /* ---- the order of the walk: the nearest date first --------------------------------------- */
  {
    const H = await funded({}, 9000);
    const R = await funded({ sharedMint: H.mint, words: THIRD }, 0);
    const a = newCard(H, undefined, { format: 4 });
    const b = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(a, { pin: '1234' });
    await H.W.cardSetUp(b, { pin: '1234' });
    // `a` loaded five days before `b`: its date is nearer
    const u = later(H, -5 * DAY);
    a.tap();
    await H.W.cardAdd(a, { sats: 1000, pin: '1234' });
    u();
    b.tap();
    await H.W.cardAdd(b, { sats: 1000, pin: '1234' });
    const pb = await payOffline(R, b, 300);
    const pa = await payOffline(R, a, 300);
    const outsA = R.W.cardKept(pa.hash.slice(4)).request.outputs.map((x) => x.B_).join();
    const outsB = R.W.cardKept(pb.hash.slice(4)).request.outputs.map((x) => x.B_).join();
    const posted0 = H.mint.posted.length;
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    const order = H.mint.posted.slice(posted0).filter((p) => p.path === '/v1/swap').map((p) => p.B_.join());
    ok(pa.kept && pb.kept && order.length === 2 && order[0] === outsA && order[1] === outsB && (await bal(R)) === 600,
       'two kept payments are posted the nearest date first, whatever order they came in', JSON.stringify({ first: order[0] === outsA }));
    booksGood('the books add up', R, H);
  }

  console.log('\n' + (failed ? failed + ' flashcard-offline check(s) failed' : 'all flashcard-offline checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
