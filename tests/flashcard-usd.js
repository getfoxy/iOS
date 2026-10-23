'use strict';
/* flashcard-usd.js — a card that holds dollars.
 *
 *     node tests/flashcard-usd.js
 *
 * A card holds one kind of money, chosen when it is set up: bitcoin, or the mint's dollars (usd ecash, in cents). The
 * card keeps the unit in its record and never reads it, so this is the phone's work alone: a dollar card is moved with
 * the dollar wallet (the dollar keyset, its fee, its counters), every row and entry written for it says its unit and
 * carries its cents under `amount` with sats at 0, and a figure is never added across units. This pins, at the wallet:
 *
 *   1  set-up in dollars: the record's byte, the file row, a mint with one unit, a unit that is not one
 *   2  the record kept: an empty dollar card moved to a mint with dollars, refused at one without, a move's own repoint
 *   3  a load from the dollar balance: the dollar keyset, the drawer in cents, the pile, the entry, the owed row, the
 *      mint's proofs, a fee mint, a deep card, and a load typed in the other unit refused before the mint is asked
 *   4  the dollar send's refusals: a card's pieces never unlocked, and never with no route
 *   5  a till paid in dollars, online, to the cent: no melt, no mint, no price; the swap the card signed for
 *   6  over-payment with the card's own change (1.12 and on), in cents
 *   7  change this phone makes (before 1.12), and an over-payment too small to come back at a fee mint
 *   8  one tap, two asks: the card's unit decides; a dollar ask alone refuses a bitcoin card before the PIN
 *   9  the wrong unit refused: an old caller's sats, an owed row of the other unit, a misfit piece, a planted piece
 *   10 withdraw, renew and empty-and-reset, in cents
 *   11 the take-back of a lost dollar card after its date
 *   12 lost answers in cents: a refused swap put back, a lost answer restored, a card taken away mid-signature
 *   13 limits in cents: never re-pegged by a price, the wait over the limit on one tap
 *   14 a bitcoin card unchanged: the same tap asked both ways
 *   15 a mint that stops issuing dollars: refused before the card is asked to sign
 *   16 offline: a dollar card pays a till with no route, kept and settled in cents; and a dollar card asked for sats
 *      (`other-unit`), paid at the till's own price with the holder's agreement, then swapped into sats at a phone that
 *      holds bitcoin and kept as dollars at one that holds both; the till's dollar keys never seen; limits in cents
 *   17 the cents for a sats ask at this phone's price (`centsFor`): rounded up, typed exactly, a price too old
 *   18 a real connect at a mint with two units keeps every unit's keys for a launch with no route
 *   19 card SEND from a dollar card: an invoice paid by a melt in dollars, and what is not paid going back
 *   20 a dollar card's payment kept offline, taken back by its owner first: failed in dollars, its swap let go
 *   21 a dollar card's hold is never paid on chain: refused before anything moves, the hold left as it was
 *   22 payments held for two cards of two units, let go together: each unit said apart, never added
 *   23 a hold for this phone's own invoice (`holdKeep`): paid with exactly the card's pieces at a fee mint, the
 *      receiver paying nothing; refused, the pieces are this phone's dollars, and the sweep leaves them so
 *   24 unit-sure answers: a hold's way back with no route says its cents as cents, a row of a unit this phone does not
 *      know is never read as sats, and a held payment still fresh says its unit
 *
 * Every page ends with its books per unit off by 0 (tests/harness.js, judged again at exit), no piece in the pile of
 * another unit, and no dollar row, entry or result with a figure under a sats name. The card is the model
 * (tests/flashcard-card.js); the mint is the test mint with a sat and a usd keyset, which holds SIG_ALL as CDK and
 * Nutshell do and refuses a swap of two units. */
const { page, funded, newCard, binaryLoad, settle, history, why, MINT, MINT2, OTHER_WORDS } = require('./flashcard-kit');
const { books, booksWrong } = require('./harness');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const THIRD = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const read = (c, key, dflt) => { try { const v = JSON.parse(c.storage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; } };
const sum = (l) => (l || []).reduce((n, p) => n + (Number(p && p.amount) || 0), 0);
const satPile = (c, m) => read(c, 'foxy.cashu.proofs.' + (m || MINT), []);
const usdPile = (c, m) => read(c, 'foxy.cashu.proofs.' + (m || MINT) + '@usd', []);
const owedRows = (c) => read(c, 'foxy.flashcard.owed', []);
const takenRows = (c) => read(c, 'foxy.flashcard.taken', []);
const swapRows = (c) => read(c, 'foxy.flashcard.swaps', []);
const keptRows = (c) => read(c, 'foxy.flashcard.kept', []);
const dueRows = (c) => read(c, 'foxy.flashcard.due', []);
const unclaimedRows = (c) => read(c, 'foxy.req.unclaimed', {});
const converts = (c) => read(c, 'foxy.cashu.convert', []);
const entryOf = (c, hash) => history(c).filter((e) => e.hash === hash)[0] || {};
const ins = (card) => card.sent.map((a) => a.slice(2, 4));
const count = (card, i) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + i).length;
const mintPaths = (c, from) => c.trace.slice(from || 0).filter((x) => /^mint /.test(x)).map((x) => x.slice(5));
const offline = (c) => c.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (c) => c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
function later(c, ms) {
  const real = c.window.Date.now.bind(c.window.Date);
  c.window.Date.now = () => real() + ms;
  return () => { c.window.Date.now = real; };
}
async function fundUsd(c, cents) { return c.W.claim((await c.W.invoice(cents, '', { unit: 'usd' })).hash); }
const tag = (c, hash) => c.W.tagsFor(hash) || {};
// `ONLY=3,5 node tests/flashcard-usd.js` runs those cases alone
const ONLY = String(process.env.ONLY || '').split(',').filter(Boolean).map(Number);
const want = (n) => !ONLY.length || ONLY.indexOf(n) >= 0;

/* The rules every case ends on, for each page: the books per unit (`booksWrong`, which waits while money is on its
 * way), no piece in the pile of another unit, and no dollar row, entry, or kept record with a figure under a sats name. */
function unitsClean(c) {
  const bad = [];
  const ids = { sat: c.mint.id, usd: c.mint.usdId };
  for (let i = 0; i < c.storage.length; i++) {
    const k = c.storage.key(i);
    if (!k || k.indexOf('foxy.cashu.proofs.') !== 0) continue;
    const want = /@usd$/.test(k) ? 'usd' : 'sat';
    const at = k.slice('foxy.cashu.proofs.'.length).replace(/@usd$/, '');
    if (at !== MINT) continue;
    read(c, k, []).forEach((p) => { if (p && p.id !== ids[want]) bad.push(k + ' holds a piece of ' + p.id); });
  }
  history(c).forEach((e) => {
    if (!e || e.unit !== 'usd') return;
    if (Number(e.sats) > 0 || Number(e.feeSats) > 0 || e.grossSats !== undefined || e.changeSats !== undefined || e.dustSats !== undefined) {
      bad.push('a dollar entry with a sats figure: ' + JSON.stringify({ hash: e.hash, sats: e.sats, feeSats: e.feeSats, grossSats: e.grossSats, changeSats: e.changeSats }));
    }
  });
  [owedRows(c), takenRows(c), dueRows(c), keptRows(c)].forEach((rows) => rows.forEach((r) => {
    if (r && r.unit === 'usd' && Number(r.sats) > 0) bad.push('a dollar card row with sats: ' + JSON.stringify({ id: r.id, sats: r.sats }));
  }));
  return bad;
}
const booksGood = (name, ...pages) => {
  const wrong = [];
  pages.forEach((c) => { booksWrong(c).forEach((l) => wrong.push(l)); unitsClean(c).forEach((l) => wrong.push(l)); });
  ok(wrong.length === 0, name + ': the books add up in each unit, and no unit is mixed', wrong.join(' | '));
};
/* While a payment waits in the unclaimed store, the dollar books: what the entries say less what the page holds has moved
 * since the page was made by exactly what waits, which the balance counts and the pile does not hold yet. */
function waitOffUsd(c) {
  const now = books(c), was = c.booksFrom || {};
  const key = MINT + '@usd';
  return ((now[key] || { off: 0 }).off - ((was[key] || { off: 0 }).off)) - Math.round(Number(c.W.keptIn('usd', '')) || 0);
}

/* H, the card's owner, with dollars and sats at a mint with both, and a dollar card set up and loaded; R, a stranger at the
 * same mint. `o.card`: the model's options; `o.mintOpts`: the mint's (`usdFeePpk`); `o.load`: cents put on (0 for none);
 * `o.binary`: cents put on the old way, in the powers of two and no more. */
async function world(o) {
  const opts = o || {};
  const H = await funded({ units: ['sat', 'usd'], mintOpts: opts.mintOpts, feePpk: opts.feePpk, second: opts.second, units2: opts.units2 }, opts.fundSat === undefined ? 5000 : opts.fundSat);
  if (opts.fundUsd !== 0) await fundUsd(H, opts.fundUsd || 20000);
  const R = await funded({ units: ['sat', 'usd'], sharedMint: H.mint, words: OTHER_WORDS }, opts.rSat || 0);
  if (opts.rUsd) await fundUsd(R, opts.rUsd);
  const card = newCard(H, undefined, Object.assign({ format: 4 }, opts.card || {}));
  await H.W.cardSetUp(card, Object.assign({ pin: '1234', unit: 'usd' }, opts.setUp || {}));
  card.tap();
  if (opts.binary) await binaryLoad(H, card, opts.binary, { pin: '1234' });
  else if (opts.load !== 0) await H.W.cardAdd(card, { amount: opts.load || 2000, unit: 'usd', pin: '1234' });
  return { H, R, card };
}
async function pay(R, card, asks, o) {
  card.tap();
  card.sent.length = 0;
  return R.W.cardPay(card, Object.assign({ asks, pin: '1234' }, o || {})).then((r) => r, (e) => ({ refused: (e && e.card) || (e && e.message), error: e }));
}

(async () => {
  /* ---- 1: set-up in dollars -------------------------------------------------------------------------------- */
  if (want(1)) {
    const H = await funded({ units: ['sat', 'usd'] }, 1000);
    const card = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(card, { pin: '1234', unit: 'usd' });
    ok(card.state.record.unit === 1, '1: set up in dollars, the card’s record says 01', String(card.state.record.unit));
    card.tap();
    const seen = await H.W.cardLook(card, { mine: true });
    ok(seen.record.unit === 'usd', '1: and the phone reads it as a dollar card', seen.record.unit);
    const row = H.W.cardsKnown()[card.key] || {};
    ok(row.unit === 'usd' && /^0[23]/.test(row.refundKey), '1: the card on file here says it holds dollars', JSON.stringify({ unit: row.unit }));
    // a bitcoin card set up the same way, with no unit said, is as ever
    const sat = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(sat, { pin: '1234' });
    ok(sat.state.record.unit === 0 && (H.W.cardsKnown()[sat.key] || {}).unit === 'sat', '1: with no unit said, a card is set up in bitcoin (00)');
    // a mint with one unit: refused before the card is asked to write anything
    const one = await funded({}, 1000);
    const c1 = newCard(one, undefined, { format: 4 });
    const r1 = await why(one.W.cardSetUp(c1, { pin: '1234', unit: 'usd' }));
    ok(r1 === 'no-dollars-here' && count(c1, '32') === 0 && c1.sent.length === 0, '1: at a mint with one unit, a dollar card is refused before the card is spoken to', r1 + ' ' + c1.sent.length);
    const r2 = await why(H.W.cardSetUp(newCard(H, undefined, { format: 4 }), { pin: '1234', unit: 'eur' }));
    ok(r2 === 'bad-unit', '1: a unit a card cannot hold is refused', r2);
    booksGood('1', H, one);
  }

  /* ---- 2: the record kept ------------------------------------------------------------------------------------ */
  if (want(2)) {
    const two = await funded({ units: ['sat', 'usd'], second: true, units2: ['sat', 'usd'] }, 1000);
    const card = newCard(two, undefined, { format: 4 });
    await two.W.cardSetUp(card, { pin: '1234', unit: 'usd' });
    await two.W.connect(MINT2, null, null, { remember: false });
    card.tap();
    const moved = await two.W.cardRepoint(card);
    ok(moved.record.mint === MINT2 && card.state.record.unit === 1 && moved.record.unit === 'usd',
       '2: an empty dollar card moved to another mint with dollars keeps its unit', JSON.stringify({ mint: moved.record.mint, unit: card.state.record.unit }));
    // a move's own repoint (a row made at the far mint for a card still at the first): the unit kept as well
    await two.W.connect(MINT, null, null, { remember: true });
    card.tap();
    await two.W.cardRepoint(card);
    ok(card.state.record.mint === MINT && card.state.record.unit === 1, '2: and back again');
    await two.W.connect(MINT2, null, null, { remember: false });
    await fundUsd2(two, 300);
    card.tap();
    const look = await two.W.cardLook(card, { short: true, mine: true });
    await two.W.cardPrepare(look, 200, { moving: true });
    card.tap();
    const wrote = await two.W.cardWrite(card, { owner: true });
    ok(card.state.record.mint === MINT2 && card.state.record.unit === 1 && wrote.unit === 'usd' && wrote.amount >= 200 && wrote.sats === 0,
       '2: a load made at the far mint repoints the card first, and its unit stays dollars', JSON.stringify({ mint: card.state.record.mint, unit: card.state.record.unit, amount: wrote.amount, sats: wrote.sats }));
    await two.W.connect(MINT, null, null, { remember: true });
    booksGood('2', two);
    // and to a mint with no dollars: refused, nothing written
    const one2 = await funded({ units: ['sat', 'usd'], second: true }, 1000);
    const c2 = newCard(one2, undefined, { format: 4 });
    await one2.W.cardSetUp(c2, { pin: '1234', unit: 'usd' });
    await one2.W.connect(MINT2, null, null, { remember: false });
    c2.tap();
    c2.sent.length = 0;
    const r = await why(one2.W.cardRepoint(c2));
    ok(r === 'no-dollars-here' && c2.state.record.mint === MINT && count(c2, '32') === 0, '2: an empty dollar card is not moved to a mint with no dollars', r);
    await one2.W.connect(MINT, null, null, { remember: true });
    booksGood('2b', one2);
  }

  /* ---- 3: a load from the dollar balance --------------------------------------------------------------------- */
  if (want(3)) {
    const H = await funded({ units: ['sat', 'usd'] }, 5000);
    await fundUsd(H, 10000);
    const card = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(card, { pin: '1234', unit: 'usd' });
    const sat0 = sum(satPile(H)), usd0 = sum(usdPile(H));
    card.tap();
    const look = await H.W.cardLook(card, { short: true, mine: true });
    const fits = H.W.cardLoadFits(look, 2000);
    const made = await H.W.cardPrepare(look, 2000);
    const row = owedRows(H).filter((x) => x.id === made.hash)[0] || {};
    ok(made.unit === 'usd' && made.amount >= 2000 && made.sats === 0 && row.unit === 'usd' && row.amount === made.amount && row.sats === 0 && row.kind === 'load',
       '3: made for the card in cents: the result and the owed row say dollars, with sats 0', JSON.stringify({ made, row: { unit: row.unit, amount: row.amount, sats: row.sats } }));
    ok(fits && fits.ok && fits.sats === made.amount, '3: and the keypad’s question of whether it fits gave the same cut', JSON.stringify(fits));
    const tok = H.W.tokenInfo(row.token);
    // a card of 128 places is cut deep (`cardDeepLadder`), one of 64 as a drawer (`cardLadder`): either way a drawer with no gap
    const deepCut = !!(look.info.wide && look.info.many);
    const want = (deepCut ? H.W.cardDeepLadder(2000, 128, 32768, []) : H.W.cardLadder(2000, 32, 32768, [])).denominations.slice().sort((a, b) => b - a);
    const got = tok.proofs.map((p) => Number(p.amount)).sort((a, b) => b - a);
    ok(tok.unit === 'usd' && tok.proofs.every((p) => p.id === H.mint.usdId) && got.indexOf(1) >= 0 && got.every((a) => a <= 32768 && (a & (a - 1)) === 0)
       && H.W.cardReach(got) === sum(tok.proofs) && sum(tok.proofs) === made.amount && (got.length === want.length || deepCut),
       '3: every piece on the dollar keyset, cut as the drawer is cut, one cent the smallest and no gap', JSON.stringify({ deepCut, got, want }));
    const e = entryOf(H, made.hash);
    ok(e.unit === 'usd' && e.dir === 'out' && e.amount === made.amount && e.sats === 0 && e.card === card.key && tag(H, made.hash).to === 'card',
       '3: one dollar entry, out, to the card', JSON.stringify({ unit: e.unit, amount: e.amount, to: tag(H, made.hash).to }));
    ok(sum(satPile(H)) === sat0 && sum(usdPile(H)) === usd0 - made.amount - (Number(e.feeAmount) || 0), '3: the dollar pile is down by it and its fee, the sat pile untouched',
       JSON.stringify({ sat: sum(satPile(H)) - sat0, usd: sum(usdPile(H)) - usd0 }));
    card.tap();
    const w = await H.W.cardWrite(card, { pin: '1234' });
    ok(w.unit === 'usd' && w.amount === made.amount && w.sats === 0 && card.balance() === made.amount && owedRows(H).length === 0,
       '3: written at the next tap, in cents', JSON.stringify({ unit: w.unit, amount: w.amount, sats: w.sats, card: card.balance() }));
    card.tap();
    const real = await H.W.cardLook(card, { mine: true, real: true });
    ok((await H.W.cardRealCheck(real)) === 'ok', '3: and the mint’s proofs went on with the pieces: the card’s money is real');
    // typed in the other unit: refused before anything is asked of the mint
    card.tap();
    const t0 = H.trace.length;
    const r = await why(H.W.cardAdd(card, { amount: 2000, unit: 'sat', pin: '1234' }));
    ok(r === 'wrong-unit' && mintPaths(H, t0).indexOf('/v1/swap') < 0, '3: a load of sats onto a dollar card is refused before the mint is asked', r + ' ' + mintPaths(H, t0).join(','));
    booksGood('3', H);
    // at a mint that charges for dollar pieces: the fee is the dollar entry's own
    const F = await funded({ units: ['sat', 'usd'], mintOpts: { usdFeePpk: 100 } }, 1000);
    await fundUsd(F, 10000);
    const cf = newCard(F, undefined, { format: 4 });
    await F.W.cardSetUp(cf, { pin: '1234', unit: 'usd' });
    cf.tap();
    const before = sum(usdPile(F));
    const fr = await F.W.cardAdd(cf, { amount: 1500, unit: 'usd', pin: '1234' });
    const loadEntry = history(F).filter((x) => x.unit === 'usd' && x.dir === 'out' && x.card === cf.key)[0] || {};
    ok(fr.unit === 'usd' && loadEntry.feeAmount > 0 && before - sum(usdPile(F)) === loadEntry.amount + loadEntry.feeAmount && cf.balance() === loadEntry.amount,
       '3: at a fee mint, the fee in cents is on the load’s entry', JSON.stringify({ amount: loadEntry.amount, fee: loadEntry.feeAmount, moved: before - sum(usdPile(F)) }));
    booksGood('3b', F);
    // a deep card (128 places): the deep drawer, in cents
    const D = await funded({ units: ['sat', 'usd'] }, 1000);
    await fundUsd(D, 10000);
    const deep = newCard(D, undefined, { format: 4 });
    await D.W.cardSetUp(deep, { pin: '1234', unit: 'usd' });
    deep.tap();
    await D.W.cardAdd(deep, { amount: 3000, unit: 'usd', pin: '1234' });
    const small = deep.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(16, 8), 16)).filter((a) => a === 1).length;
    ok(deep.balance() >= 3000 && small >= 3, '3: a card of 128 places is cut deep, several one-cent pieces', JSON.stringify({ balance: deep.balance(), ones: small }));
    booksGood('3c', D);
  }

  /* ---- 4: the dollar send's refusals ---------------------------------------------------------------------- */
  if (want(4)) {
    const H = await funded({ units: ['sat', 'usd'] }, 1000);
    await fundUsd(H, 2000);
    const r1 = await why(H.W.sendToken(100, { unit: 'usd', sigAll: true }));
    ok(/locked to the card/.test(r1), '4: a card’s one-signature pieces are never made unlocked', r1);
    const r2 = await why(H.W.sendToken(100, { unit: 'usd', denominations: [64, 32, 4] }));
    ok(/locked to the card/.test(r2), '4: nor a card’s cut drawer', r2);
    const card = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(card, { pin: '1234', unit: 'usd' });
    offline(H);
    const r3 = await why(H.W.sendToken(100, { unit: 'usd', lockTo: card.key, sigAll: true }));
    ok(/needs the mint/.test(r3), '4: and a locked dollar send needs the mint', r3);
    online(H);
    booksGood('4', H);
  }

  /* ---- 5: a till paid in dollars, online, to the cent ------------------------------------------------------- */
  if (want(5)) {
    const { H, R, card } = await world({ load: 2000 });
    const sat0 = sum(satPile(R)), usd0 = sum(usdPile(R));
    let priced = 0;
    const q0 = R.W.quoteFor, c0 = R.W.centsFor;
    R.W.quoteFor = function () { priced += 1; return q0.apply(this, arguments); };
    R.W.centsFor = function () { priced += 1; return c0.apply(this, arguments); };
    const t0 = R.trace.length, posted0 = R.mint.posted.length;
    const onCard = card.balance();
    const got = await pay(R, card, [{ unit: 'usd', amount: 475 }]);
    R.W.quoteFor = q0; R.W.centsFor = c0;
    ok(got.unit === 'usd' && got.amount === 475 && got.sats === 0 && !got.refused, '5: a dollar card pays a dollar ask: 475 cents, sats 0', JSON.stringify({ unit: got.unit, amount: got.amount, sats: got.sats, refused: got.refused }));
    ok(sum(usdPile(R)) === usd0 + 475 && sum(satPile(R)) === sat0, '5: the till’s dollars are up by exactly 475, its sats untouched', JSON.stringify({ usd: sum(usdPile(R)) - usd0, sat: sum(satPile(R)) - sat0 }));
    const paths = mintPaths(R, t0);
    ok(paths.filter((p) => /melt|\/v1\/mint/.test(p)).length === 0 && paths.indexOf('/v1/swap') >= 0 && priced === 0,
       '5: one swap, no melt, no invoice, and no price asked', paths.join(',') + ' priced ' + priced);
    const e = entryOf(R, got.hash);
    ok(e.unit === 'usd' && e.dir === 'in' && e.amount === 475 && e.sats === 0 && tag(R, got.hash).to === 'card payment' && e.card === card.key,
       '5: the entry is a dollar receipt of 475, a card payment', JSON.stringify({ unit: e.unit, amount: e.amount, to: tag(R, got.hash).to }));
    const swap = R.mint.posted.slice(posted0).filter((p) => p.path === '/v1/swap')[0] || {};
    // (the test mint holds SIG_ALL as CDK and Nutshell do: one signature over these very outputs, or the swap is refused)
    ok(swapRows(R).length === 0 && swap.B_ && swap.B_.length >= 1 && card.balance() <= onCard - 475,
       '5: the mint took the swap the card signed once for, its outputs and no others, and its row is gone', JSON.stringify({ rows: swapRows(R).length, outs: swap.B_ && swap.B_.length }));
    ok(count(card, '22') === 1 && count(card, '24') === 1, '5: one BEGIN and one signature');
    booksGood('5', H, R);
  }

  /* ---- 6: over-payment with the card's own change (1.12 and on) -------------------------------------------- */
  if (want(6)) {
    const { H, R, card } = await world({ binary: 128 });
    const usd0 = sum(usdPile(R));
    const got = await pay(R, card, [{ unit: 'usd', amount: 100 }]);
    const e = entryOf(R, got.hash);
    ok(got.unit === 'usd' && got.amount === 100 && sum(usdPile(R)) === usd0 + 100 && e.unit === 'usd' && e.amount === 100 && e.grossAmount === 128 && e.changeAmount === 28 && e.grossSats === undefined,
       '6: $1.28 for $1.00: the till keeps 100, its entry says 128 came and 28 went back to the card', JSON.stringify({ amount: e.amount, gross: e.grossAmount, change: e.changeAmount, pile: sum(usdPile(R)) - usd0 }));
    const change = owedRows(R).filter((r) => /^change-/.test(r.id))[0] || {};
    ok(change.unit === 'usd' && change.amount === 28 && change.sats === 0 && got.change && got.change.unit === 'usd' && got.change.amount === 28 && got.change.sats === 0,
       '6: the card’s own change is owed to it in cents', JSON.stringify({ row: { unit: change.unit, amount: change.amount }, change: got.change }));
    card.tap();
    const back = await R.W.cardWrite(card, { change: true });
    ok(back.unit === 'usd' && back.amount === 28 && card.balance() === 28 && owedRows(R).length === 0, '6: and written at the next tap', JSON.stringify({ amount: back.amount, card: card.balance() }));
    booksGood('6', H, R);
  }

  /* ---- 7: change this phone makes (before 1.12), and change too small to come back ----------------------- */
  if (want(7)) {
    const { H, R, card } = await world({ binary: 128, card: { software: 11 }, rUsd: 500 });
    const usd0 = sum(usdPile(R));
    const got = await pay(R, card, [{ unit: 'usd', amount: 100 }]);
    const e = entryOf(R, got.hash);
    const owed = owedRows(R).filter((r) => r.kind === 'change')[0] || {};
    const tok = owed.token ? R.W.tokenInfo(owed.token) : { proofs: [] };
    ok(got.unit === 'usd' && owed.unit === 'usd' && owed.amount > 0 && owed.amount <= 28 && owed.sats === 0 && tok.unit === 'usd'
       && tok.proofs.every((p) => p.id === R.mint.usdId && /SIG_ALL/.test(p.secret) && /locktime/.test(p.secret)),
       '7: change made here in cents, locked to the card with its date and its refund key', JSON.stringify({ owed: { unit: owed.unit, amount: owed.amount }, unit: tok.unit }));
    ok(e.unit === 'usd' && e.amount <= 100 && e.amount >= 95 && e.changeState === 'not handed' && e.changeAmount === 28 && e.grossAmount === 128 && e.changeSats === undefined,
       '7: the payment’s entry says the change in cents', JSON.stringify({ amount: e.amount, state: e.changeState, change: e.changeAmount, gross: e.grossAmount }));
    void usd0;
    card.tap();
    const back = await R.W.cardWrite(card, { change: true });
    ok(back.unit === 'usd' && back.amount === owed.amount && card.balance() === owed.amount, '7: and the next tap writes it', JSON.stringify({ amount: back.amount, card: card.balance() }));
    booksGood('7', H, R);
    // a cent over at a fee mint: too little to come back, and the payment keeps it
    const F = await world({ binary: 101, mintOpts: { usdFeePpk: 100 }, card: { software: 11 }, rUsd: 500 });
    const g2 = await pay(F.R, F.card, [{ unit: 'usd', amount: 100 }]);
    const e2 = entryOf(F.R, g2.hash);
    ok(g2.unit === 'usd' && owedRows(F.R).length === 0 && e2.unit === 'usd' && !(e2.changeState === 'owed'),
       '7: a cent over at a fee mint is too little to come back: no change is owed, and the payment keeps it', JSON.stringify({ refused: g2.refused, change: e2.changeAmount, state: e2.changeState, owed: owedRows(F.R).length }));
    booksGood('7b', F.H, F.R);
  }

  /* ---- 8: one tap, two asks -------------------------------------------------------------------------------- */
  if (want(8)) {
    const { H, R, card } = await world({ load: 1000 });
    const both = [{ unit: 'usd', amount: 100 }, { unit: 'sat', amount: 1300 }];
    const d = await pay(R, card, both);
    ok(d.unit === 'usd' && d.amount === 100 && d.sats === 0, '8: asked in both, a dollar card pays the dollars', JSON.stringify({ unit: d.unit, amount: d.amount }));
    const satCard = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(satCard, { pin: '1234' });
    satCard.tap();
    await H.W.cardAdd(satCard, { sats: 3000, pin: '1234' });
    const s = await pay(R, satCard, both);
    ok(s.unit === 'sat' && s.amount === 1300 && s.sats === 1300, '8: and a bitcoin card the sats', JSON.stringify({ unit: s.unit, amount: s.amount, sats: s.sats }));
    const only = await pay(R, satCard, [{ unit: 'usd', amount: 100 }]);
    ok(only.refused === 'wrong-unit' && only.error.cardUnit === 'sat' && count(satCard, '22') === 0 && count(satCard, '40') === 0,
       '8: asked in dollars alone, a bitcoin card is refused before the PIN and before BEGIN', JSON.stringify({ refused: only.refused, unit: only.error && only.error.cardUnit, ins: ins(satCard).join(',') }));
    booksGood('8', H, R);
  }

  /* ---- 9: the wrong unit refused ---------------------------------------------------------------------------- */
  if (want(9)) {
    const { H, R, card } = await world({ load: 1000 });
    const old = await pay(R, card, undefined, { sats: 100 });
    ok(old.refused === 'other-unit' && old.error.cardUnit === 'usd' && old.error.unit === 'usd' && old.error.asked === 'sat' && old.error.balance === card.balance()
       && old.error.mint === MINT && old.error.pinSet === true && count(card, '40') === 0 && count(card, '22') === 0,
       '9: an old caller asking sats of a dollar card is told the card holds dollars, with what the screen needs, before the PIN and BEGIN',
       JSON.stringify({ refused: old.refused, e: old.error && { unit: old.error.unit, asked: old.error.asked, balance: old.error.balance } }));
    // an owed row of sats for a dollar card is passed over, and stays owed; the card is unchanged
    const satTok = await H.W.sendToken(64, { unit: 'sat', lockTo: card.key, sigAll: true, denominations: [64] });
    const rows = owedRows(H).concat([{ id: 'planted-sat', card: card.key, token: satTok.token, unit: 'sat', sats: 64, kind: 'load', forHash: 'planted-sat', at: Date.now() }]);
    H.storage.setItem('foxy.flashcard.owed', JSON.stringify(rows));
    const bal0 = card.balance();
    card.tap();
    const w1 = await H.W.cardWrite(card, { pin: '1234' });
    ok(card.balance() === bal0 && owedRows(H).some((r) => r.id === 'planted-sat') && w1.why === 'wrong-unit', '9: a row of sats owed to a dollar card is passed over and stays owed', JSON.stringify({ why: w1.why, card: card.balance() - bal0 }));
    let misfit = '';
    const look = await (async () => { card.tap(); return H.W.cardLook(card, { mine: true }); })();
    try { H.W._cardPiecesOf(satTok.token, look); } catch (e) { misfit = (e && e.card) + ': ' + (e && e.message); }
    ok(/^misfit/.test(misfit) && /this card’s money/.test(misfit), '9: and its pieces do not fit the card', misfit);
    H.storage.setItem('foxy.flashcard.owed', JSON.stringify(owedRows(H).filter((r) => r.id !== 'planted-sat')));
    // and the other way: a dollar row owed to a bitcoin card
    const satCard = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(satCard, { pin: '1234' });
    const usdTok = await H.W.sendToken(32, { unit: 'usd', lockTo: satCard.key, sigAll: true, denominations: [32] });
    H.storage.setItem('foxy.flashcard.owed', JSON.stringify(owedRows(H).concat([{ id: 'planted-usd', card: satCard.key, token: usdTok.token, unit: 'usd', amount: usdTok.amount, sats: 0, kind: 'load', forHash: 'planted-usd', at: Date.now() }])));
    satCard.tap();
    const w2 = await H.W.cardWrite(satCard, { pin: '1234' });
    ok(satCard.balance() === 0 && owedRows(H).some((r) => r.id === 'planted-usd') && w2.why === 'wrong-unit', '9: and a dollar row owed to a bitcoin card the same', JSON.stringify({ why: w2.why }));
    H.storage.setItem('foxy.flashcard.owed', JSON.stringify(owedRows(H).filter((r) => r.id !== 'planted-usd')));
    // the money in those two tokens is still this phone's to account for: it left the pile on rows that are its own
    // a piece of sats planted on a dollar card (a card written wrong) is never offered to pay
    const P = await world({ binary: 64 });
    const slot = P.card.state.slots.findIndex((x) => x.status === 1);
    const satShort = P.H.mint.id.slice(0, 16);
    P.card.state.slots[slot].data = satShort + P.card.state.slots[slot].data.slice(16);
    const p1 = await pay(P.R, P.card, [{ unit: 'usd', amount: 64 }]);
    ok(p1.refused === 'not-enough' && p1.error.cardUnit === 'usd' && count(P.card, '22') === 0, '9: a piece of sats planted on a dollar card is foreign there, and never paid with', JSON.stringify({ refused: p1.refused }));
    booksGood('9', R, P.H, P.R);
  }

  /* ---- 10: withdraw, renew, empty and reset ---------------------------------------------------------------- */
  if (want(10)) {
    const { H, card } = await world({ load: 2000 });
    const onCard = card.balance();
    const usd0 = sum(usdPile(H)), sat0 = sum(satPile(H));
    card.tap();
    const some = await H.W.cardWithdraw(card, { sats: 500, pin: '1234' });
    ok(some.unit === 'usd' && some.amount === 500 && some.sats === 0 && sum(usdPile(H)) >= usd0 + 500 && sum(satPile(H)) === sat0,
       '10: a withdrawal of 500 cents lands in the dollar pile', JSON.stringify({ unit: some.unit, amount: some.amount, pile: sum(usdPile(H)) - usd0 }));
    const entry = entryOf(H, some.hash);
    ok(entry.unit === 'usd' && entry.dir === 'in' && entry.amount === 500 && tag(H, some.hash).to === 'card', '10: its entry is a dollar receipt from the card, not a payment', JSON.stringify({ unit: entry.unit, to: tag(H, some.hash).to }));
    card.tap();
    const renewed = await H.W.cardRenew(card, { pin: '1234' });
    const dates = Array.from(new Set(card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(154, 8), 16))));
    ok(renewed.unit === 'usd' && card.balance() > 0 && card.balance() <= onCard - 500 && dates.length === 1 && Math.abs(dates[0] - (Date.now() / 1000 + 30 * 86400)) < 600,
       '10: renewed in one tap: its dollars back on with a date thirty days off', JSON.stringify({ balance: card.balance(), dates }));
    card.tap();
    const all = await H.W.cardWithdraw(card, { pin: '1234' });
    ok(all.unit === 'usd' && all.amount > 0 && all.sats === 0 && card.balance() === 0, '10: all of it off', JSON.stringify({ amount: all.amount }));
    card.tap();
    await H.W.cardAdd(card, { amount: 300, unit: 'usd', pin: '1234' });
    card.tap();
    const reset = await H.W.cardEmptyAndReset(card, { pin: '1234' });
    ok(reset.reset === true && reset.unit === 'usd' && reset.withdrew > 0 && reset.withdrew <= 300 && card.state.record.set === false,
       '10: emptied and reset: what came off is said in cents', JSON.stringify(reset));
    booksGood('10', H);
  }

  /* ---- 11: the take-back of a lost dollar card --------------------------------------------------------------- */
  if (want(11)) {
    const { H, card } = await world({ load: 1500 });
    const usd0 = sum(usdPile(H));
    const soon = await why(H.W.cardTakeBack(card.key));
    ok(soon === 'too-soon', '11: before its date, nothing is taken back', soon);
    const undo = later(H, 31 * DAY);
    const back = await H.W.cardTakeBack(card.key).then((r) => r, (e) => ({ refused: (e && e.card) || (e && e.message) }));
    undo();
    ok(back.unit === 'usd' && back.amount > 0 && back.amount <= 1500 && back.sats === 0 && sum(usdPile(H)) === usd0 + back.amount,
       '11: after its date the phone takes the dollars back with its own key, into the dollar pile', JSON.stringify(back));
    const listed = H.W.cardsList().filter((x) => x.key === card.key)[0] || {};
    ok(listed.unit === 'usd' && listed.sats === 0, '11: the list of cards says it is a dollar card', JSON.stringify(listed));
    booksGood('11', H);
  }

  /* ---- 12: lost answers in cents ------------------------------------------------------------------------------ */
  if (want(12)) {
    // the mint refuses the swap: what is still good goes back on the card, in dollars
    const W1 = await world({ load: 1000 });
    W1.R.fate = (m) => (new URL(m.url).pathname === '/v1/swap' ? '400\n' + JSON.stringify({ code: 11000, detail: 'no' }) : null);
    const r1 = await pay(W1.R, W1.card, [{ unit: 'usd', amount: 300 }]);
    W1.R.fate = null;
    const put = owedRows(W1.R).filter((r) => r.kind === 'putback')[0] || {};
    ok(r1.refused === 'putback' && put.unit === 'usd' && put.amount > 0 && put.sats === 0 && r1.error.cardUnit === 'usd' && R1tok(W1.R, put) === 'usd',
       '12: a swap the mint refuses: the card’s pieces are owed back to it in dollars', JSON.stringify({ refused: r1.refused, put: { unit: put.unit, amount: put.amount } }));
    W1.card.tap();
    await W1.R.W.cardWrite(W1.card, { change: true }).then(() => null, () => null);
    booksGood('12a', W1.H, W1.R);
    // the answer is lost after the mint made the swap: found again, into the dollar pile, one entry
    const W2 = await world({ load: 1000 });
    const usd0 = sum(usdPile(W2.R));
    W2.R.hang = () => ({ reach: true, failAfter: 50 });
    const r2 = await pay(W2.R, W2.card, [{ unit: 'usd', amount: 250 }]);
    W2.R.hang = null;
    await W2.R.W.recoverSwaps();
    const settled = await W2.R.W.cardSettle();
    await settle();
    const entries = history(W2.R).filter((e) => e.unit === 'usd' && e.dir === 'in' && e.card === W2.card.key);
    ok((r2.refused === 'waiting' || r2.unit === 'usd') && sum(usdPile(W2.R)) === usd0 + 250 && entries.length === 1 && entries[0].amount === 250 && W2.R.W.cardTaken().length === 0,
       '12: a lost answer is found again: 250 cents in the dollar pile, one entry', JSON.stringify({ first: r2.refused || r2.unit, pile: sum(usdPile(W2.R)) - usd0, entries: entries.length, settled }));
    booksGood('12b', W2.H, W2.R);
    // the card taken away as it signs: held, and the next tap finishes it
    const W3 = await world({ load: 1000 });
    W3.card.tap();
    W3.card.sent.length = 0;
    W3.card.leaveBefore('24', 1);
    const r3 = await W3.R.W.cardPay(W3.card, { asks: [{ unit: 'usd', amount: 200 }], pin: '1234' }).then((r) => r, (e) => ({ refused: e && e.card, error: e }));
    const again = await pay(W3.R, W3.card, [{ unit: 'usd', amount: 200 }]);
    ok(again.unit === 'usd' && again.amount === 200, '12: a card taken away as it signs is paid by the next tap', JSON.stringify({ first: r3.refused, then: again.unit + ' ' + again.amount + ' ' + again.refused }));
    booksGood('12c', W3.H, W3.R);
  }

  /* ---- 13: limits in cents ------------------------------------------------------------------------------------ */
  if (want(13)) {
    const { H, R, card } = await world({ load: 5000 });
    card.tap();
    await H.W.cardSetLimit(card, { sats: 2000, tap: true, usd: 20 });
    ok(card.state.tapLimit === 2000 && !(read(H, 'foxy.flashcard.pace', {})[card.key]), '13: a limit on one tap of $20.00 is 2,000 cents on the card, with no price note to follow',
       JSON.stringify({ tap: card.state.tapLimit, pace: read(H, 'foxy.flashcard.pace', {})[card.key] }));
    card.tap();
    card.sent.length = 0;
    await H.W.cardLook(card, { mine: true, price: 1 });
    card.tap();
    await H.W.cardLook(card, { mine: true, price: 1e6 });
    ok(count(card, '34') === 0 && card.state.tapLimit === 2000, '13: and no price ever moves it', JSON.stringify({ setLimit: count(card, '34'), tap: card.state.tapLimit }));
    const waits = [];
    const big = await pay(R, card, [{ unit: 'usd', amount: 2100 }], { progress: (p) => { if (p && p.step === 'waiting') waits.push(p); } });
    ok(big.unit === 'usd' && big.amount === 2100 && waits.length >= 1, '13: a payment over the limit on one tap waits, counted in cents', JSON.stringify({ paid: big.amount, refused: big.refused, waits: waits.length }));
    booksGood('13', H, R);
  }

  /* ---- 14: a bitcoin card unchanged: the same tap asked both ways ------------------------------------------- */
  if (want(14)) {
    const runs = [];
    for (const how of ['sats', 'asks']) {
      const H = await funded({ units: ['sat', 'usd'] }, 9000);
      const R = await funded({ units: ['sat', 'usd'], sharedMint: H.mint, words: OTHER_WORDS }, 0);
      const card = newCard(H, undefined, { format: 4 });
      await H.W.cardSetUp(card, { pin: '1234' });
      card.tap();
      await H.W.cardAdd(card, { sats: 2000, pin: '1234' });
      card.tap();
      card.sent.length = 0;
      const t0 = R.trace.length;
      const r = await R.W.cardPay(card, how === 'sats' ? { sats: 475, pin: '1234' } : { asks: [{ unit: 'sat', amount: 475 }], pin: '1234' });
      runs.push({ ins: ins(card).join(','), mint: mintPaths(R, t0).join(','), r, bal: card.balance() });
      booksGood('14 ' + how, H, R);
    }
    ok(runs[0].ins === runs[1].ins && runs[0].mint === runs[1].mint && runs[0].bal === runs[1].bal && runs[0].r.sats === 475 && runs[1].r.sats === 475 && runs[0].r.unit === 'sat',
       '14: a bitcoin card asked in sats the old way and as an ask is the same tap, to the instruction', JSON.stringify(runs.map((x) => ({ ins: x.ins, mint: x.mint }))));
  }

  /* ---- 15: a mint that stops issuing dollars ------------------------------------------------------------------ */
  if (want(15)) {
    const { H, card } = await world({ load: 1000 });
    const noUsd = (m) => {
      const p = new URL(m.url).pathname;
      if (p !== '/v1/keysets') return null;
      const said = H.mint.handle(m);
      const j = JSON.parse(said.slice(said.indexOf('\n') + 1));
      j.keysets = j.keysets.filter((k) => k.unit !== 'usd');
      return '200\n' + JSON.stringify(j);
    };
    // a till that meets the mint after it stopped: no dollars there, and a dollar card refused before the PIN and BEGIN
    const R = page({ units: ['sat', 'usd'], sharedMint: H.mint, words: OTHER_WORDS });
    R.fate = noUsd;
    await R.W.connect(MINT, null, null, { remember: true });
    const p = await pay(R, card, [{ unit: 'usd', amount: 100 }]);
    ok(R.W.mintUnits().indexOf('usd') < 0 && p.refused === 'no-dollars-here' && /does not issue dollars/.test(p.error.message) && count(card, '22') === 0 && count(card, '40') === 0,
       '15: a dollar card at a mint that stopped issuing dollars: refused before the PIN and BEGIN', JSON.stringify({ units: R.W.mintUnits(), refused: p.refused }));
    // its owner's phone, launched again since: a load and a withdrawal refused the same way
    const store = {};
    for (let i = 0; i < H.storage.length; i++) store[H.storage.key(i)] = H.storage.getItem(H.storage.key(i));
    const H2 = page({ units: ['sat', 'usd'], sharedMint: H.mint, storage: store, phone: H.phone });
    H2.fate = noUsd;
    await H2.W.connect(MINT, null, null, { remember: true });
    card.tap();
    const l = await why(H2.W.cardAdd(card, { amount: 100, unit: 'usd', pin: '1234' }));
    card.tap();
    card.sent.length = 0;
    const wd = await why(H2.W.cardWithdraw(card, { pin: '1234' }));
    ok(l === 'no-dollars-here' && wd === 'no-dollars-here' && count(card, '22') === 0, '15: and so are a load and a withdrawal', l + ' / ' + wd);
    // the card's own screen still reads it, in dollars
    card.tap();
    const seen = await H2.W.cardLook(card, { mine: true });
    ok(seen.record.unit === 'usd' && seen.balance === card.balance(), '15: and the card still reads, in dollars');
    H.booksOff = 'its storage went on in the next launch';
    H2.booksFrom = H.booksFrom;
    booksGood('15', R, H2);
  }

  /* ---- 16: offline -------------------------------------------------------------------------------------------- */
  if (want(16)) {
    // a dollar ask at a till with no route: kept in cents, and settled at the first connection
    const { H, R, card } = await world({ load: 2000 });
    // a phone that holds both, so what comes in dollars stays dollars (no receive balance is remembered to say so)
    R.W.setWalletChoice({ hold: 'both' });
    const usd0 = sum(usdPile(R));
    offline(R);
    const t0 = R.trace.length;
    const k = await pay(R, card, [{ unit: 'usd', amount: 475 }], { offline: true });
    const rec = keptRows(R)[0] || {};
    const row = unclaimedRows(R)[String(k.hash || '').slice(4)] || {};
    const e = entryOf(R, k.hash);
    ok(k.kept === true && k.unit === 'usd' && k.amount === 475 && k.sats === 0 && mintPaths(R, t0).length === 0,
       '16: offline, a dollar card pays a dollar ask, kept, and the mint is asked nothing', JSON.stringify({ kept: k.kept, unit: k.unit, amount: k.amount, refused: k.refused }));
    ok(rec.unit === 'usd' && rec.amount === 475 && rec.sats === 0 && rec.asked === 475 && row.unit === 'usd' && row.amount === 475 && row.cardKept === true
       && e.unit === 'usd' && e.amount === 475 && e.sats === 0 && e.cardKept === 'waiting' && !e.convert,
       '16: the kept record, its row and its entry are dollars; taken in dollars on purpose, nothing is to be swapped',
       JSON.stringify({ rec: { unit: rec.unit, amount: rec.amount, sats: rec.sats }, row: { unit: row.unit, amount: row.amount }, entry: { unit: e.unit, amount: e.amount, convert: e.convert } }));
    const w0 = R.W.cardKeptWaiting()[0] || {};
    ok(w0.unit === 'usd' && w0.amount === 475 && w0.sats === 0 && R.W.balanceOf('usd') === usd0 + 475 && waitOffUsd(R) === 0,
       '16: it waits in dollars, counted in the dollar balance, and the books add up counting it', JSON.stringify({ w0, bal: R.W.balanceOf('usd') - usd0, off: waitOffUsd(R) }));
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    ok((R.W.cardKept(rec.id) || {}).state === 'settled' && sum(usdPile(R)) === usd0 + 475 && entryOf(R, k.hash).cardKept === 'settled' && converts(R).length === 0,
       '16: online, it settles into the dollar pile, and nothing is swapped', JSON.stringify({ state: (R.W.cardKept(rec.id) || {}).state, pile: sum(usdPile(R)) - usd0 }));
    booksGood('16a', H, R);
    // a dollar card asked for sats offline: told so at the first tap, nothing signed; paid in cents at the till's price at the second
    R.W._rate = 76900; R.W._rateAt = Date.now() - 2 * HOUR;
    // and now a phone that holds bitcoin only: what comes in dollars is swapped into sats
    R.W.setWalletChoice({ hold: 'bitcoin' });
    offline(R);
    const first = await pay(R, card, [{ unit: 'sat', amount: 7000 }], { offline: true });
    ok(first.refused === 'other-unit' && first.error.unit === 'usd' && first.error.asked === 'sat' && first.error.mint === MINT && first.error.key === card.key
       && count(card, '22') === 0 && count(card, '40') === 0 && count(card, '24') === 0,
       '16: a dollar card asked for sats offline: other-unit, read only, nothing signed', JSON.stringify({ refused: first.refused, ins: ins(card).join(',') }));
    const q = R.W.centsFor(7000);
    ok(q && q.cents === Math.ceil(7000 * 76900 / 1e6) && q.sats === 7000 && q.rate === 76900, '16: the till works out the cents at its own price, rounded up', JSON.stringify(q));
    const terms = { payUnit: 'usd', pay: q.cents, sats: q.sats, rate: q.rate, ageMs: q.ageMs, seenAt: q.at, own: true, convert: true };
    const usd1 = sum(usdPile(R)), sat1 = sum(satPile(R)), onCard = card.balance();
    const k2 = await pay(R, card, [{ unit: 'usd', amount: q.cents, terms }], { offline: true });
    const rec2 = keptRows(R).filter((x) => x.id === String(k2.hash || '').slice(4))[0] || {};
    const e2 = entryOf(R, k2.hash);
    const cv = converts(R).filter((x) => 'req-' + x.id === k2.hash)[0] || {};
    ok(k2.kept === true && k2.unit === 'usd' && k2.amount === q.cents && rec2.unit === 'usd' && rec2.amount === q.cents && rec2.sats === 0,
       '16: the second tap pays the cents, kept in dollars', JSON.stringify({ kept: k2.kept, amount: k2.amount, refused: k2.refused }));
    ok(e2.unit === 'usd' && e2.amount === q.cents && e2.sats === 0 && e2.satsAsked === 7000 && e2.askRate === 76900 && e2.askOwn === true && typeof e2.askAgeMs === 'number'
       && e2.usdAsked === undefined,
       '16: its entry says what was asked in sats, at this phone’s price', JSON.stringify({ satsAsked: e2.satsAsked, askRate: e2.askRate, askOwn: e2.askOwn, convert: e2.convert }));
    ok(e2.convert === 'owed' && cv.from === 'usd' && cv.to === 'sat' && cv.sats === q.cents && cv.asked === 7000 && cv.state === 'owed',
       '16: a phone that holds bitcoin owes itself the swap into sats', JSON.stringify(cv));
    ok(onCard - card.balance() >= q.cents && R.W.walletChoice().recv === 'sat', '16: the card is lighter by the cents, and the till’s own receive unit is untouched',
       JSON.stringify({ off: onCard - card.balance(), recv: R.W.walletChoice().recv }));
    online(R);
    R.W._swapPollMs = 5; R.W._swapClaimWaitMs = 400; R.W._rateAt = Date.now();
    await R.W.claimUnclaimed();
    await settle();
    const cv2 = converts(R).filter((x) => x.id === cv.id)[0] || {};
    ok(cv2.state === 'claimed' && sum(usdPile(R)) === usd1 + q.cents, '16: online, it settles into the dollar pile and is ready to be swapped', JSON.stringify({ state: cv2.state }));
    const done = await R.W.convertOne();
    const cv3 = converts(R).filter((x) => x.id === cv.id)[0] || {};
    const legs = history(R).filter((x) => x.swap && x.swap === cv3.swap);
    const out = legs.filter((x) => x.dir === 'out')[0] || {}, inn = legs.filter((x) => x.dir === 'in')[0] || {};
    ok(done && done.outcome === 'done' && done.from.unit === 'usd' && done.to.unit === 'sat' && cv3.state === 'done' && cv3.gotTo > 0 && out.unit === 'usd' && (inn.unit || 'sat') === 'sat'
       && inn.sats === cv3.gotTo && sum(satPile(R)) === sat1 + cv3.gotTo && entryOf(R, k2.hash).convert === 'done' && entryOf(R, k2.hash).convertSats === cv3.gotTo,
       '16: and swapped once into sats: a dollar row out and a sat row in, the record and the entry done', JSON.stringify({ outcome: done && done.outcome, gotTo: cv3.gotTo, legs: legs.length }));
    ok((await R.W.convertOne()) === null, '16: a second go does nothing');
    booksGood('16b', H, R);
    // a phone that holds both keeps what came
    const B = await world({ load: 2000 });
    B.R.W.setWalletChoice({ hold: 'both' });
    B.R.W._rate = 76900; B.R.W._rateAt = Date.now();
    offline(B.R);
    const qb = B.R.W.centsFor(7000);
    const kb = await pay(B.R, B.card, [{ unit: 'usd', amount: qb.cents, terms: { payUnit: 'usd', pay: qb.cents, sats: 7000, rate: qb.rate, ageMs: qb.ageMs, seenAt: qb.at, own: true, convert: false } }], { offline: true });
    ok(kb.kept === true && converts(B.R).length === 0 && !entryOf(B.R, kb.hash).convert && entryOf(B.R, kb.hash).satsAsked === 7000,
       '16: a phone that holds both keeps the dollars, and nothing is to be swapped', JSON.stringify({ kept: kb.kept, converts: converts(B.R).length }));
    online(B.R);
    await B.R.W.claimUnclaimed();
    await settle();
    booksGood('16c', B.H, B.R);
    /* A phone that holds bitcoin whose person picked dollars for this one receive at the till (`kept`, the app's `recvPicked`): the
     * dollar card's payment kept offline stays dollars, and nothing is swapped; the same payment with nothing picked is swapped. */
    {
      const P = await world({ load: 2000 });
      P.R.W.setWalletChoice({ hold: 'bitcoin' });
      const usdP = sum(usdPile(P.R));
      offline(P.R);
      const kp = await pay(P.R, P.card, [{ unit: 'usd', amount: 260 }], { offline: true, kept: true });
      const ep = entryOf(P.R, kp.hash);
      ok(kp.kept === true && kp.unit === 'usd' && kp.amount === 260 && !ep.convert && converts(P.R).length === 0,
         '16: a phone that holds bitcoin, dollars picked for this receive: kept in dollars, nothing to be swapped', JSON.stringify({ kept: kp.kept, convert: ep.convert, converts: converts(P.R).length }));
      const kn = await pay(P.R, P.card, [{ unit: 'usd', amount: 140 }], { offline: true });
      const en = entryOf(P.R, kn.hash);
      ok(kn.kept === true && en.convert === 'owed' && converts(P.R).filter((x) => 'req-' + x.id === kn.hash).length === 1,
         '16: and with nothing picked, the next is owed its swap into sats, as the phone holds', JSON.stringify({ convert: en.convert }));
      online(P.R);
      await P.R.W.claimUnclaimed();
      await settle();
      ok(sum(usdPile(P.R)) === usdP + 400 && entryOf(P.R, kp.hash).cardKept === 'settled' && !entryOf(P.R, kp.hash).convert,
         '16: online, both settle into the dollar pile; the picked one is never to be swapped', JSON.stringify({ pile: sum(usdPile(P.R)) - usdP }));
      booksGood('16d', P.H, P.R);
    }
    // the till has never seen the mint's dollar keys: refused at once, nothing asked of the mint
    const N = await world({ load: 1000 });
    const strip = (m) => {
      const p = new URL(m.url).pathname;
      if (p !== '/v1/keys') return null;
      const said = N.H.mint.handle(m);
      const j = JSON.parse(said.slice(said.indexOf('\n') + 1));
      j.keysets = j.keysets.filter((ks) => ks.unit !== 'usd');
      return '200\n' + JSON.stringify(j);
    };
    const T = page({ units: ['sat', 'usd'], sharedMint: N.H.mint, words: THIRD });
    T.fate = strip;
    await T.W.connect(MINT, null, null, { remember: true });
    T.fate = null;
    offline(T);
    const t1 = T.trace.length, began = Date.now();
    const nk = await pay(T, N.card, [{ unit: 'usd', amount: 100 }], { offline: true });
    ok(nk.refused === 'offline-no-keys' && T.trace.length === t1 && Date.now() - began < 2000 && count(N.card, '22') === 0 && T.W.unitKeysOffline('usd') === false,
       '16: a till that has not seen the dollar keys refuses at once, asking the mint nothing', JSON.stringify({ refused: nk.refused, asked: T.trace.length - t1, ms: Date.now() - began }));
    online(T);
    booksGood('16d', N.H, T);
    // limits in cents, offline: a limit on one tap of 500 cents refuses 592
    const L = await world({ load: 2000 });
    L.card.tap();
    await L.H.W.cardSetLimit(L.card, { sats: 500, tap: true });
    offline(L.R);
    const lim = await pay(L.R, L.card, [{ unit: 'usd', amount: 592 }], { offline: true });
    ok(lim.refused === 'tap-limit' || lim.kept === true, '16: offline, a payment over the limit on one tap is held to it in cents', JSON.stringify({ refused: lim.refused, kept: lim.kept }));
    online(L.R);
    await L.R.W.claimUnclaimed();
    await settle();
    booksGood('16e', L.H, L.R);
  }

  /* ---- 17: cents for a sats ask, at this phone's price -------------------------------------------------------- */
  if (want(17)) {
    const c = await funded({ units: ['sat', 'usd'] }, 0);
    c.W._rate = 100000; c.W._rateAt = Date.now() - HOUR;
    const a = c.W.centsFor(1001);
    ok(a && a.cents === 101 && a.ageMs >= HOUR - 1000, '17: 1,001 sats at $100,000 is 100.1 cents: rounded up to 101', JSON.stringify(a));
    ok(c.W.centsFor(1001, 592).cents === 592, '17: typed in dollars, the cents are what was typed');
    c.W._rateAt = Date.now() - 25 * HOUR;
    ok(c.W.centsFor(1001) === null, '17: a price over a day old works out nothing');
    c.W._rateAt = Date.now() - 23 * HOUR;
    ok(!!c.W.centsFor(1001), '17: under a day, it does');
    c.W._rateAt = Date.now() + 10 * 60 * 1000;
    ok(c.W.centsFor(1001) === null, '17: a price from ahead of this phone’s clock is too old as well');
    c.W._rate = 0;
    ok(c.W.centsFor(1001) === null, '17: and with no price, nothing');
    booksGood('17', c);
  }

  /* ---- 18: every unit's keys kept at a real connect ---------------------------------------------------------- */
  if (want(18)) {
    const c = await funded({ units: ['sat', 'usd'] }, 0);
    const cache = read(c, 'foxy.cashu.mint.cache', {})[MINT] || {};
    const kept = ((cache.keys && cache.keys.keysets) || []).filter((k) => k.unit === 'usd' && k.keys && Object.keys(k.keys).length > 0);
    ok(kept.length === 1 && c.W.unitKeysOffline('usd') === true && c.W.unitKeysOffline('sat') === true,
       '18: a real connect at a mint with two units keeps the dollar keys too, for a launch with no route', JSON.stringify({ kept: kept.length }));
    booksGood('18', c);
  }

  /* ---- 19: card SEND from a dollar card ------------------------------------------------------------------------ */
  if (want(19)) {
    const { H, card } = await world({ load: 3000 });
    const usd0 = sum(usdPile(H)), sat0 = sum(satPile(H));
    const inv = await H.W.invoice(1000, '', { unit: 'sat' });
    const q = await H.W.quoteFee(inv.request || inv.bolt11 || inv.invoice, { unit: 'usd' });
    const total = H.W.cardOutTotal(q.amount, q.feeReserve, 'usd');
    card.tap();
    const r = await H.W.cardPay(card, { asks: [{ unit: 'usd', amount: total }], pin: '1234', holdFor: inv.hash || 'send', only: card.key });
    ok(r.unit === 'usd' && r.held && r.heldAmount >= q.amount + q.feeReserve && r.heldSats === 0, '19: the card pays its dollars into a hold for the payment', JSON.stringify({ unit: r.unit, held: r.held, heldAmount: r.heldAmount }));
    const paid = await H.W.pay(inv.request || inv.bolt11 || inv.invoice, null, { held: r.held, unit: 'usd', card: card.key }).then((x) => x, (e) => ({ refused: e && e.message }));
    const e = entryOf(H, paid.hash);
    ok(paid.unit === 'usd' && e.unit === 'usd' && e.dir === 'out' && e.fromCard === card.key && e.sats === 0 && sum(satPile(H)) >= sat0,
       '19: the invoice is paid by a melt in dollars from the card’s pieces', JSON.stringify({ paid: paid.unit || paid.refused, entry: { unit: e.unit, fromCard: e.fromCard } }));
    // a hold whose payment is refused goes back to the card in dollars
    card.tap();
    const r2 = await H.W.cardPay(card, { asks: [{ unit: 'usd', amount: 500 }], pin: '1234', holdFor: 'refused', only: card.key });
    const backed = await H.W.cardOutBack(r2.held);
    const back = owedRows(H).filter((x) => x.outBack)[0] || {};
    ok(backed.unit === 'usd' && back.unit === 'usd' && back.amount > 0 && back.sats === 0, '19: a payment not made: its hold goes back to the card in dollars', JSON.stringify({ backed, row: { unit: back.unit, amount: back.amount } }));
    const satRefused = await why(H.W.pay(inv.request || inv.bolt11 || inv.invoice, null, { held: r2.held, unit: 'sat' }));
    ok(/not here any more|pays in dollars/.test(String(satRefused)), '19: and a dollar card’s pieces are never melted in sats', String(satRefused));
    card.tap();
    await H.W.cardWrite(card, { owner: true });
    booksGood('19', H);
    void usd0;
  }

  /* ---- 20: a dollar card's offline payment that never settles --------------------------------------------------- */
  if (want(20)) {
    // kept in dollars for a sats ask, owed a swap into sats; the card's owner takes the money back before the till is online
    const { H, R, card } = await world({ load: 2000 });
    R.W.setWalletChoice({ hold: 'bitcoin' });
    R.W._rate = 76900; R.W._rateAt = Date.now();
    const heard = [];
    R.W.onCardKeptLost((x) => heard.push(x));
    offline(R);
    const q = R.W.centsFor(7000);
    const k = await pay(R, card, [{ unit: 'usd', amount: q.cents, terms: { payUnit: 'usd', pay: q.cents, sats: 7000, rate: q.rate, ageMs: q.ageMs, seenAt: q.at, own: true, convert: true } }], { offline: true });
    const id = String(k.hash || '').slice(4);
    ok(k.kept === true && (converts(R).filter((x) => x.id === id)[0] || {}).state === 'owed', '20: kept offline in dollars, owed a swap into sats', JSON.stringify({ kept: k.kept }));
    const usdH = sum(usdPile(H));
    const undoH = later(H, 31 * DAY);
    const back = await H.W.cardTakeBack(card.key).then((r) => r, (e) => ({ refused: (e && e.card) || (e && e.message) }));
    undoH();
    ok(back.unit === 'usd' && back.amount > 0 && sum(usdPile(H)) === usdH + back.amount, '20: the owner takes the card’s dollars back after their date', JSON.stringify(back));
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    const rec = R.W.cardKept(id) || {};
    const e = entryOf(R, k.hash);
    const cv = converts(R).filter((x) => x.id === id)[0] || {};
    ok(['spent', 'unwound'].indexOf(rec.state) >= 0 && e.state === 'failed' && e.unit === 'usd' && e.amount === q.cents && e.sats === 0 && !unclaimedRows(R)[id],
       '20: the till finds it gone: its entry fails, in dollars, and its row goes', JSON.stringify({ state: rec.state, entry: { state: e.state, unit: e.unit, amount: e.amount, sats: e.sats } }));
    ok(cv.state === 'kept' && cv.why === rec.state && e.convert === 'kept' && (await R.W.convertOne()) === null, '20: and its swap into sats is let go, never run', JSON.stringify(cv));
    const told = heard.filter((x) => x.id === id && x.cause === rec.state)[0] || {};
    ok(told.unit === 'usd' && told.amount === q.cents && told.sats === 0, '20: the screen is told, in dollars', JSON.stringify(told));
    booksGood('20', H, R);
  }

  /* ---- 21: a dollar card's hold is never paid on chain ------------------------------------------------------------ */
  if (want(21)) {
    const H = await funded({ units: ['sat', 'usd'], onchain: true, mintOpts: { onchain: true } }, 20000);
    await fundUsd(H, 20000);
    const card = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(card, { pin: '1234', unit: 'usd' });
    card.tap();
    await H.W.cardAdd(card, { amount: 18000, unit: 'usd', pin: '1234' });
    const plan = await H.W.onchainQuote('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 10000);
    card.tap();
    const r = await H.W.cardPay(card, { asks: [{ unit: 'usd', amount: 15000 }], pin: '1234', holdFor: 'oc', only: card.key });
    const sat0 = sum(satPile(H)), usd0 = sum(usdPile(H)), at = H.trace.length;
    const sent = await H.W.onchainPay(plan, plan.options[0].index, null, { held: r.held }).then((x) => ({ state: x.state }), (e) => ({ refused: e && e.message, unsent: !!(e && e.unsent), held: e && e.held }));
    const hold = (H.W.cardOutHeld().filter((h) => h.id === r.held)[0]) || {};
    ok(sent.unsent && sent.held === r.held && /in dollars, so it pays Lightning invoices\. Nothing was paid\./.test(sent.refused || '')
       && hold.unit === 'usd' && hold.amount === r.heldAmount && mintPaths(H, at).filter((x) => /melt/.test(x)).length === 0
       && sum(satPile(H)) === sat0 && sum(usdPile(H)) === usd0,
       '21: a dollar card’s hold handed to a payment on chain is refused before any melt, and stays the card’s, in dollars',
       JSON.stringify({ sent, hold, melts: mintPaths(H, at) }));
    const backed = await H.W.cardOutBack(r.held);
    ok(backed.unit === 'usd' && backed.made && backed.sats === 0, '21: and it goes back to the card in dollars', JSON.stringify(backed));
    card.tap();
    await H.W.cardWrite(card, { owner: true });
    booksGood('21', H);
  }

  /* ---- 22: held payments of two units let go together -------------------------------------------------------------- */
  if (want(22)) {
    const R = await funded({ units: ['sat', 'usd'] }, 1000);
    offline(R);
    // what a card taken away part way leaves (`cardHeld`): one row a bitcoin card's, one a dollar card's
    const rows = [
      { id: 'card-satheld', token: '', unit: 'sat', sats: 0, worth: 3000, over: 3000, all: false, card: '02aa', memo: 'card, not completed', at: Date.now() - 600000, refund: true, resume: { want: 3000, proved: false } },
      { id: 'card-usdheld', token: '', unit: 'usd', amount: 0, sats: 0, worth: 475, over: 475, all: false, card: '02bb', memo: 'card, not completed', at: Date.now() - 600000, refund: true, resume: { want: 475, proved: false } },
    ];
    R.storage.setItem('foxy.flashcard.taken', JSON.stringify(rows));
    const all = await R.W.cardHeldLetGo();
    const each = [all].concat(all.also || []).map((x) => x.unit + ':' + x.amount + ':' + x.sats);
    ok(each.sort().join() === 'sat:3000:3000,usd:475:0', '22: let go with no card named, each unit is said apart: sats and cents never added', JSON.stringify(all));
    R.storage.setItem('foxy.flashcard.taken', JSON.stringify(rows));
    const one = await R.W.cardHeldLetGo('02bb');
    ok(one.unit === 'usd' && one.amount === 475 && one.sats === 0 && !one.also, '22: and one card named lets that one go, in its unit', JSON.stringify(one));
  }

  /* ---- 23: a hold for this phone's own invoice ---------------------------------------------------------------------- */
  if (want(23)) {
    for (const refuse of [false, true]) {
      // a dollar fee mint, and a receiver that holds no dollars: what it is paid with must pay its invoice by itself
      const { H, R, card } = await world({ load: 3000, mintOpts: Object.assign({ usdFeePpk: 1000 }, refuse ? { meltRefuse: true } : {}) });
      const inv = await R.W.invoice(7000, '', { unit: 'sat' });
      const bolt11 = inv.request || inv.bolt11 || inv.invoice;
      const q = await R.W.quoteFee(bolt11, { unit: 'usd' });
      const total = R.W.cardOutTotal(q.amount, q.feeReserve, 'usd');
      const usd0 = sum(usdPile(R)), sat0 = sum(satPile(R));
      const r = await pay(R, card, [{ unit: 'usd', amount: total, terms: { payUnit: 'usd', pay: total, sats: 7000, online: true } }], { holdFor: true, holdKeep: true, only: card.key });
      const tg = tag(R, r.hash);
      ok(r.unit === 'usd' && r.held && r.heldAmount === total && sum(usdPile(R)) === usd0 && tg.to === 'card payment',
         '23' + (refuse ? 'b' : '') + ': the card’s cents are held for this phone’s invoice, out of its pile, and its entry is a payment to this phone',
         JSON.stringify({ held: r.held, heldAmount: r.heldAmount, total, pile: sum(usdPile(R)) - usd0, tag: tg.to }));
      const at = R.trace.length;
      const paid = await R.W.pay(bolt11, () => {}, { unit: 'usd', quote: q, held: r.held }).then((x) => x, (e) => ({ refused: e && e.message, held: e && e.held }));
      if (!refuse) {
        await R.W.claim(inv.hash).then(() => null, () => null);
        await settle();
        ok(paid.unit === 'usd' && R.mint.quotes[inv.hash].state !== 'UNPAID' && sum(satPile(R)) - sat0 === 7000 && sum(usdPile(R)) - usd0 >= 0
           && mintPaths(R, at).filter((x) => /\/v1\/swap/.test(x)).length === 0 && R.W.cardOutHeld().length === 0,
           '23: at a fee mint, a receiver with no dollars is paid the sats asked: the melt spends exactly the card’s pieces, with no split, and costs it nothing',
           JSON.stringify({ paid: paid.unit || paid.refused, sat: sum(satPile(R)) - sat0, usd: sum(usdPile(R)) - usd0, swaps: mintPaths(R, at) }));
      } else {
        const kept = await R.W.cardOutKeep(paid.held || r.held);
        ok(!!paid.refused && kept.unit === 'usd' && kept.amount === total && kept.sats === 0 && sum(usdPile(R)) - usd0 === total && R.W.cardOutHeld().length === 0 && R.W.cardOwed().length === 0,
           '23b: refused, the pieces are this phone’s dollars, all of them, and nothing is owed to the card',
           JSON.stringify({ paid, kept, usd: sum(usdPile(R)) - usd0, held: R.W.cardOutHeld(), owed: R.W.cardOwed().length }));
        // a hold of its own left behind (Foxy closed before the melt) is kept by this phone too, never sent back to the card
        const r2 = await pay(R, card, [{ unit: 'usd', amount: 300, terms: { payUnit: 'usd', pay: 300, sats: 3000, online: true } }], { holdFor: true, holdKeep: true, only: card.key });
        const undo = later(R, 11 * 60000);
        const swept = await R.W.cardOutsLeft();
        undo();
        ok(swept.length === 1 && swept[0].kept && swept[0].unit === 'usd' && swept[0].amount === 300 && R.W.cardOutHeld().length === 0 && R.W.cardOwed().length === 0
           && sum(usdPile(R)) - usd0 === total + 300,
           '23b: and the sweep keeps a hold of its own left behind as this phone’s dollars', JSON.stringify({ swept, owed: R.W.cardOwed().length, r2: r2.held }));
      }
      booksGood('23' + (refuse ? 'b' : ''), H, R);
    }
  }

  /* ---- 24: unit-sure answers ---------------------------------------------------------------------------------------- */
  if (want(24)) {
    const { H, card } = await world({ load: 3000 });
    card.tap();
    const r = await H.W.cardPay(card, { asks: [{ unit: 'usd', amount: 500 }], pin: '1234', holdFor: 'nope', only: card.key });
    offline(H);
    const off = await H.W.cardOutBack(r.held);
    ok(off.unit === 'usd' && off.amount === r.heldAmount && off.sats === 0 && off.made === false, '24: a hold’s way back with no route says its cents as cents', JSON.stringify(off));
    online(H);
    await H.W.cardOutBack(r.held);
    card.tap();
    await H.W.cardWrite(card, { owner: true });
    // a row naming a unit this phone does not know: never read as sats (its sats are none), and never written to a card
    const rows = owedRows(H);
    H.storage.setItem('foxy.flashcard.owed', JSON.stringify(rows.concat([{ id: 'odd-1', card: card.key, kind: 'change', mint: MINT, unit: 'eur', amount: 120, sats: 0, at: Date.now() },
                                                                           { id: 'odd-2', card: card.key, kind: 'change', mint: MINT, unit: 'u s d', amount: 80, sats: 0, at: Date.now() }])));
    const odd = H.W.cardOwed().filter((x) => /^odd-/.test(x.id) || x.unit === 'eur' || x.unit === 'u s d');
    ok(odd.length === 2 && odd.every((x) => x.unit !== 'sat' && x.sats === 0 && x.amount > 0), '24: a row of a unit this phone does not know is not read as sats', JSON.stringify(odd));
    H.storage.setItem('foxy.flashcard.owed', JSON.stringify(rows));
    // a payment the card left, still fresh, said in its unit as it waits
    H.storage.setItem('foxy.flashcard.taken', JSON.stringify([{ id: 'card-fresh', token: '', unit: 'usd', amount: 0, sats: 0, worth: 475, over: 475, all: false, card: card.key,
                                                               memo: 'card, not completed', at: Date.now(), refund: true, resume: { want: 475, proved: false } }]));
    const st = await H.W.cardSettle();
    const fresh = st.filter((x) => x.id === 'card-fresh')[0] || {};
    ok(fresh.state === 'held' && fresh.unit === 'usd' && fresh.sats === 0, '24: a held payment still fresh says its unit', JSON.stringify(fresh));
    H.storage.setItem('foxy.flashcard.taken', JSON.stringify([]));
    booksGood('24', H);
  }

  await settle();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  console.log(failed ? failed + ' flashcard-usd check(s) failed' : 'all flashcard-usd checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });

/* The kind of token a put-back row holds. */
function R1tok(c, row) { try { return c.W.tokenInfo(row.token).unit; } catch (e) { return ''; } }
/* Dollars at the second mint: an invoice there, as at the first. */
async function fundUsd2(c, cents) { return c.W.claim((await c.W.invoice(cents, '', { unit: 'usd' })).hash); }
