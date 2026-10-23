'use strict';
/* flashcard-units.js — a card of software 1.23: dollars and bitcoin on one card at its one mint.
 *
 *     node tests/flashcard-units.js
 *
 * The card's part is the card repository's docs/FOXY-CARD-KEYSETS.md (applet 1.23, `SELECT` answering 01 17): a table of the keysets it
 * holds and their units, one ceiling in cents for both units with a rate the owner's phone writes, one unit a payment, and the format
 * byte 5 while it holds a keyset of the other unit. The phone's part is design section 9, and this pins it against the model of the card
 * (tests/flashcard-card.js, `software: 23`, held to the applet's own recording by tests/flashcard-model.js) and the test mint with a sat
 * and a usd keyset:
 *
 *   1  the model: the version, GET_INFO P1 = 3, the table and its mark, the cap on entries without it, the format by content, the
 *      conversion ceil(S x 100 / R), SET_LIMIT's lengths, 6A99 to 6A9D and 6B00 in the applet's order, GET_BALANCE P1 = 1, GET_LOG P1 = 2, 3
 *   2  a 1.23 card of one unit, as a 1.22 card is: set up, loaded, paid from, read, taken off; format 4, no table asked
 *   3  two units loaded and read: format 5, the table, each unit's pieces and balance, the record's balance alone in `balance`
 *   4  the bytes the phone sends a 1.23 card: a load of each unit (P2 = 1, the unit first), a limit with the rate (sixteen bytes), the PIN
 *      form at set-up (twelve), and a payment of each unit (the places of that unit alone)
 *   5  one ceiling across both units in cents: a sats payment weighed at the rate, the allowance counted across units, the PIN asked
 *   6  the rate: written at set-up and with every limit, re-pegged when the price moves past 2%, the guard far from the card's, never on a
 *      first write; CHANGE LIMIT in dollars or in sats
 *   7  always ask: a till that asks both units of a card that holds both is told to ask (`choose-unit`); the holder's choice pays; a till
 *      of one unit, or a card that holds one, asks nothing
 *   8  SWAP between the two balances: off in one unit, swapped at the mint, on in the other; withdraw all of both in one tap
 *   9  the drawer: four of every size in each unit on a card of both, a refill of one unit never counting the other's pieces
 *   10 refusals in words: 6A9D a new currency by a phone that is not the owner, 6A99 sats onto a card with a limit and no rate (written
 *      first by the owner's phone), a format-5 card refused by a phone that knows no units
 *   11 the version gate: a card of 1.22 is sent nothing new
 *   12 the log and the receipts by unit (bit 5, the other unit's count, each receipt's unit)
 *   13 no format compared with 4 alone in the three files
 *   14 the screens: two pills, WITHDRAW asking which currency first on the CURRENCY screen and taking it off in that one, the till's
 *      PAY FROM WHICH? with a short currency greyed, and the rate guard asked once from the owner's read
 *   15 what review found: all of a card whose record's currency is empty, a card's SWAP priced before its money comes off and the fee's
 *      unused part put back, PAY FROM WHICH? at another mint, the dollars offered where the sats are short, no false pieces above the
 *      limit, no price no write, figures in the unit they are said in, a choice backed out of, the rate's price, LIMITS by what is held

 *   16 what a second look found: at another mint that charges for spending pieces, the currency chosen is the one its fee is worked out
 *      on and the one that pays, end to end; a card of both short of sats at a bitcoin till pays from its dollars, end to end, and says
 *      why; the limit screen of a card of both says its pieces stay as they are, and asks no PIN to recut; set-up with no price says
 *      the card was not set up
 *   17 the set-up's CURRENCY step on a card of 1.23: DOLLARS, BITCOIN or BOTH, three cards of one shape; BOTH writes a dollar record
 *      and ADD FUNDS asks which every time, sats going on after; BITCOIN alone never asks and refuses nothing the card can do (dollars
 *      put on it all the same make it a card of both, asked again), and SEND refuses dollars it cannot turn into sats; a card of 1.22
 *      shows the two rows and the old words; a set-up for somebody else asks no currency. The choice drives the card's screen: BOTH
 *      shows two pills at nothing from the moment set-up ends, the ceiling said for both and SWAP greyed with its reason while a
 *      side is empty; DOLLARS or BITCOIN one pill and no question; a phone that did not set it up shows what the card holds
 *   18 what the owner found: ADD FUNDS asks the PIN of a card of 1.21 and on from the card just read, and a load the card refuses
 *      for want of it asks for it; SEND > FLASHCARD to a card of both in the currency the send was started in, or asked once the card
 *      is read, a card of one currency still refusing the other; the card's SEND asks the way to pay first and the currency only on
 *      the confirmation, where both could pay
 *   19 ADD FUNDS as the owner pressed it on the card's screen of a 1.23 card of both: the PIN pad before any card sheet, then one tap
 *      that writes; and money left waiting for the card (the line on its screen, TAP CARD on NOT PAID) the same: PIN, then one tap,
 *      never a tap refused for want of the PIN and a second one after the pad
 *
 * Every page ends with its books per unit off by 0. */
const fs = require('fs');
const path = require('path');
const { funded, page, newCard, settle, why, OTHER_WORDS, MINT, MINT2 } = require('./flashcard-kit');
const { booksWrong } = require('./harness');
const { makeCard } = require('./flashcard-card');
const { appOn, until, pad, card: cardUp, vals, settle: uiSettle } = require('./flashcard-ui-kit');
/* One of the app's methods, out of the text of its file, by its first line (as flashcard-ui-kit.js lifts them). */
const liftFrom = (file, sig) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', file), 'utf8');
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('no method ' + sig);
  let i = src.indexOf('{', at + 3 + sig.length - 1), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(at + 3, i + 1);
};

let failed = 0, passed = 0;
// what LIMITS says under it in the card's MENU (what the card pays without its PIN)
const limitsSub = (v) => ((v.fcMenuItems || []).find((k) => k.label === 'LIMITS') || {}).sub || '';
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const ONLY = String(process.env.ONLY || '').split(',').filter(Boolean).map(Number);
const want = (n) => !ONLY.length || ONLY.indexOf(n) >= 0;
const PRICE = 100000;   // dollars a bitcoin: a rate of 1,000 sats a dollar
const sw = (a) => a.slice(-4);
const cmds = (card, ins) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + ins);
const booksGood = (name, ...pages) => {
  const wrong = [];
  pages.forEach((c) => booksWrong(c).forEach((l) => wrong.push(l)));
  ok(wrong.length === 0, name + ': the books add up in each unit', wrong.join(' | '));
};
async function fundUsd(c, cents) { return c.W.claim((await c.W.invoice(cents, '', { unit: 'usd' })).hash); }

/* H, the card's owner, with sats and dollars at a mint of both, and a card of 1.23 set up in `unit` with the holder's two numbers
 * (dollars: $10.00 on one payment, $2.00 with no PIN) at PRICE; R, a stranger at the same mint (a till). */
async function world(o) {
  const opts = o || {};
  const H = await funded({ units: ['sat', 'usd'] }, opts.sats === undefined ? 50000 : opts.sats);
  await fundUsd(H, opts.cents || 20000);
  const R = await funded({ units: ['sat', 'usd'], sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H, undefined, Object.assign({ format: 4, software: 23 }, opts.card || {}));
  const setUp = Object.assign({ pin: '1234', unit: opts.unit || 'sat', price: PRICE }, opts.limits === false ? {} : { tapLimit: 10000, tapUsd: 10, noPin: 2000, noPinUsd: 2 });
  if (setUp.unit === 'usd' && opts.limits !== false) Object.assign(setUp, { tapLimit: 1000, tapUsd: 0, noPin: 200, noPinUsd: 0 });
  await H.W.cardSetUp(card, setUp);
  return { H, R, card };
}
const add = (H, card, amount, unit, o) => { card.tap(); return H.W.cardAdd(card, Object.assign({ amount, unit, pin: '1234', price: PRICE }, o || {})); };
const pay = (R, card, o) => { card.tap(); card.sent.length = 0; return R.W.cardPay(card, Object.assign({ pin: '1234' }, o)).then((r) => r, (e) => ({ refused: (e && e.card) || (e && e.message), error: e })); };

(async () => {
  /* ---- 1: the model ---------------------------------------------------------------------------------------------- */
  if (want(1)) {
    const c = await funded({ units: ['sat', 'usd'] }, 0);
    const card = makeCard({ window: c.window, format: 4, software: 23 });
    const ask = (a) => card.send(a);
    ok((await ask('00a4040009f0464f58594341524400')) === '01179000', 'SELECT answers 01 17');
    const info3 = await ask('b001030000');
    ok(sw(info3) === '9000' && info3.length === 51 * 2 + 4 && info3.substr(16, 2) === '04' && info3.substr(86, 2) === '00',
       'GET_INFO P1 = 3: 51 bytes, format 4, no book before the first SET_CARD', info3);
    const old = makeCard({ window: c.window, format: 4, software: 22 });
    await old.send('00a4040009f0464f58594341524400');
    ok(((await old.send('b001030000')).length - 4) / 2 === 30, 'a card of 1.22 answers P1 = 3 with the thirty bytes');
    ok((await old.send('b016020000')).substr(0, 2) === '04' && ((await old.send('b016020000')).length - 4) / 2 > 100, 'and GET_CARD P1 = 2 with its record');
    // a card of sats with an owner and a PIN, as the phone sets one up
    const H = await funded({ units: ['sat', 'usd'] }, 0);
    const c2 = newCard(H, undefined, { format: 4, software: 23 });
    await H.W.cardSetUp(c2, { pin: '1234', unit: 'sat', price: PRICE });
    ok(c2.state.book && c2.state.book.table.length === 6 && c2.state.book.table.every((x) => x.state === 0), 'the first SET_CARD makes the book: six free entries');
    const s = c2.state;
    const piece = (ks, amount, n) => ks + ('00000000' + amount.toString(16)).slice(-8) + ('0' + n).slice(-2).repeat(32) + '02' + 'ab'.repeat(32) + '00000000';
    const KS_A = 'aa00000000000001', KS_B = 'bb00000000000001', KS_C = 'aa00000000000002', KS_D = 'aa00000000000003', KS_E = 'aa00000000000004';
    const load = (p2, body, p1) => '' + 'b030' + ('0' + (p1 || 0)).slice(-2) + ('0' + p2).slice(-2) + ('0' + (body.length / 2).toString(16)).slice(-2) + body;
    c2.tap();
    await c2.send('00a4040009f0464f58594341524400');
    await c2.send('b04000000431323334');
    ok(sw(await c2.send(load(0, piece(KS_A, 2000, 1)))) === '9000' && s.book.table[0].state === 0x40, 'a plain load enters its keyset as the record’s unit, unmarked (40)');
    ok(sw(await c2.send(load(1, '01' + piece(KS_B, 150, 2)))) === '6a9d', 'a new keyset labelled the other unit under the PIN alone: 6A9D, nothing written');
    ok(sw(await c2.send(load(2, '01' + piece(KS_B, 150, 2)))) === '6b00', 'P2 = 2: 6B00');
    ok(sw(await c2.send(load(1, '02' + piece(KS_B, 150, 2)))) === '6a80', 'a unit over 01: 6A80');
    ok(sw(await c2.send(load(1, '01' + piece(KS_B, 150, 2).slice(0, 160)))) === '6700', 'a labelled length that is not 82, 163, 244 or 178: 6700');
    // ask the wallet for a real owner's grant through a tap of its own
    c2.tap();
    const seen = await H.W.cardLook(c2, { mine: true, price: PRICE });
    ok(seen.mine === true && c2.state.grant === true, 'the owner’s read gives the grant in the tap');
    await c2.send('b04000000431323334');
    ok(sw(await c2.send(load(1, '01' + piece(KS_B, 150, 2)))) === '9000' && s.book.table[1].state === 0xc1, 'with the PIN and the grant: entered, marked (C1)');
    ok((await c2.send('b001030000')).substr(16, 2) === '05' && (await c2.send('b016000000')).substr(0, 2) === '05', 'format 5 now, in GET_INFO and GET_CARD');
    ok(sw(await c2.send(load(1, '01' + piece(KS_A, 5, 3)))) === '6a9b', 'the sats keyset labelled dollars: 6A9B');
    ok((await c2.send('b016020000')) === '02' + KS_A + '40' + KS_B + 'c1' + '9000', 'GET_CARD P1 = 2: the count and each entry in use, its nine bytes');
    ok((await c2.send('b011010000')) === '02' + '0001000007d0' + '010100000096' + '9000', 'GET_BALANCE P1 = 1: sats first, then dollars, each its pieces and sum');
    ok((await c2.send('b011000000')) === '000007d09000', 'GET_BALANCE P1 = 0: the record’s unit alone');
    // a payment of both units at once
    c2.tap();
    await c2.send('00a4040009f0464f58594341524400');
    await c2.send('b04000000431323334');
    ok(sw(await c2.send('b02200000200' + '01')) === '6a9a', 'SPEND_ALL_BEGIN of a sats place and a dollar place: 6A9A');
    // the cap on entries without the mark: a third unmarked keyset is 6A9C while two live ones lack it
    ok(sw(await c2.send(load(0, piece(KS_C, 300, 4)))) === '9000', 'a second sats keyset under the PIN alone, unmarked');
    ok(sw(await c2.send(load(0, piece(KS_D, 400, 5)))) === '6a9c', 'a third unmarked one while two live ones lack the mark: 6A9C');
    // the conversion, as the card counts it into its allowance: ceil(S x 100 / R)
    const toCents = (S, R) => { const q = (BigInt(S) * 100n + BigInt(R) - 1n) / BigInt(R); return q > 4294967295n ? 4294967295 : Number(q); };
    ok(toCents(1, 1000) === 1 && toCents(1000, 1000) === 100 && toCents(1001, 1000) === 101 && toCents(4294967295, 100) === 4294967295 && toCents(4294967295, 99) === 4294967295,
       'the conversion is ceil(S x 100 / R), past four bytes taken as FF FF FF FF (U16)');
    // SET_LIMIT's lengths on a sats record (the owner's form): sixteen taken, the old twelve refused
    ok(c2.state.rate === 1000 && c2.state.tapLimit === 0, 'a card set up with no limit is given its rate all the same, while it is empty (the PIN form, twelve bytes)');
    void KS_E;
    // GET_LOG P1 = 4: 6A86
    ok(sw(await c2.send('b018040000')) === '6a86', 'GET_LOG with P1 = 4: 6A86');
    booksGood('the model', c, H);
  }

  /* ---- 2: a 1.23 card of one unit is a 1.22 card to this phone -------------------------------------------------- */
  if (want(2)) {
    const { H, R, card } = await world({ limits: false });
    const r = await add(H, card, 3000, 'sat');
    ok(r.amount === 3000 && r.unit === 'sat', 'a load of sats onto a card of 1.23 in sats', JSON.stringify(r && { amount: r.amount, unit: r.unit }));
    card.tap();
    card.sent.length = 0;
    const seen = await H.W.cardLook(card, { mine: true, price: PRICE });
    ok(seen.info.format === 4 && seen.info.units === true && !seen.table && cmds(card, '16').every((a) => a.substr(4, 2) === '00'),
       'read: format 4, the table never asked (GET_CARD P1 = 0 alone)');
    ok(seen.balance === 3000 && seen.units.sat.balance === 3000 && seen.units.usd.balance === 0, 'its balance, all of it the record’s unit');
    ok(cmds(card, '01').every((a) => a.substr(4, 2) === '03'), 'GET_INFO is asked with P1 = 3 on a card of 1.23');
    const p = await pay(R, card, { sats: 250 });
    ok(p.amount === 250 && p.unit === 'sat', 'a till paid 250 sats from it, nothing asked of the holder', JSON.stringify(p.refused || p.amount));
    ok(!cmds(card, '16').some((a) => a.substr(4, 2) === '02'), 'the till never asks for the table of a card of one unit');
    card.tap();
    const w = await H.W.cardWithdraw(card, { pin: '1234' }).then((x) => x, (e) => ({ refused: e.card || e.message }));
    ok(!w.refused && w.unit === 'sat' && w.amount > 0 && !w.also, 'all of it taken off, in its one unit', JSON.stringify(w.refused || w.amount));
    await settle();
    booksGood('one unit', H, R);
  }

  /* ---- 3 and 4: two units loaded and read; the bytes -------------------------------------------------------------- */
  if (want(3) || want(4)) {
    const { H, R, card } = await world({});
    card.sent.length = 0;
    const s1 = await add(H, card, 3000, 'sat');
    const satLoads = cmds(card, '30');
    card.sent.length = 0;
    const u1 = await add(H, card, 500, 'usd');
    const usdLoads = cmds(card, '30');
    ok(s1.amount === 3000 && s1.unit === 'sat' && u1.amount === 500 && u1.unit === 'usd', 'sats and dollars loaded onto one card', JSON.stringify([s1.amount, u1.amount, u1.unit]));
    ok(satLoads.length > 0 && satLoads.every((a) => a.substr(6, 2) === '01' && a.substr(10, 2) === '00'), 'every sats load is labelled (P2 = 1), its unit byte 00 first', satLoads[0]);
    ok(usdLoads.length > 0 && usdLoads.every((a) => a.substr(6, 2) === '01' && a.substr(10, 2) === '01'), 'every dollar load is labelled, its unit byte 01 first', usdLoads[0]);
    ok(satLoads.every((a) => ['52', 'a3', 'f4', 'b2'].indexOf(a.substr(8, 2)) >= 0), 'of the lengths a labelled load is: 82, 163, 244, or 178 with the proof',
       satLoads.map((a) => a.substr(8, 2)).join(' '));
    ok(card.state.book.table.filter((x) => x.state).map((x) => x.state).sort().join(',') === '192,193', 'the owner’s loads entered both keysets marked (C0, C1)',
       JSON.stringify(card.state.book.table));
    card.tap();
    card.sent.length = 0;
    const seen = await H.W.cardLook(card, { mine: true, price: PRICE });
    ok(seen.info.format === 5 && seen.info.twoUnits === true && seen.table && seen.table.list.length === 2, 'read: format 5, and the table asked and read');
    ok(seen.units.sat.balance === 3000 && seen.units.usd.balance === 500 && seen.balance === 3000, 'each unit’s balance, and `balance` the record’s alone, never a sum across units');
    ok(seen.unitSums && seen.unitSums.sat.sum === 3000 && seen.unitSums.usd.sum === 500 && cmds(card, '11').some((a) => a.substr(4, 2) === '01'),
       'the holder’s read asks the card’s own sums (GET_BALANCE P1 = 1), and they agree with the table’s sorting');
    ok(seen.pieces.length === seen.units.sat.pieces.length + seen.units.usd.pieces.length && seen.units.usd.pieces.every((x) => x.unit === 'usd'), 'every piece sorted into its unit by the table');
    const units = H.W.cardUnits(seen);
    ok(units && units.length === 2 && units[0].unit === 'sat' && units[1].unit === 'usd', 'cardUnits: both, sats first');
    // the bytes of a payment of each unit
    const ps = await pay(R, card, { sats: 100 });
    const begSat = cmds(card, '22')[0] || '';
    const pu = await pay(R, card, { asks: [{ unit: 'usd', amount: 100 }], from: 'usd' });
    const begUsd = cmds(card, '22')[0] || '';
    const placesOf = (beg) => (beg.substr(10, parseInt(beg.substr(8, 2), 16) * 2).match(/../g) || []).map((h) => parseInt(h, 16));
    const unitOfPlace = (i) => (card.state.book.table.find((x) => x.keyset === card.state.slots[i].data.substr(0, 16)) || { state: -1 }).state & 1;
    ok(ps.amount === 100 && ps.unit === 'sat' && placesOf(begSat).every((i) => unitOfPlace(i) === 0), 'a sats payment names sats places alone', begSat);
    ok(pu.amount === 100 && pu.unit === 'usd' && placesOf(begUsd).every((i) => unitOfPlace(i) === 1), 'a dollar payment names dollar places alone', begUsd);
    if (want(4)) {
      console.log('BYTES  a sats load (header, then the unit byte):     ' + satLoads[0].slice(0, 12) + '… (' + satLoads[0].length / 2 + ' bytes)');
      console.log('BYTES  a dollar load (header, then the unit byte):   ' + usdLoads[0].slice(0, 12) + '… (' + usdLoads[0].length / 2 + ' bytes)');
      console.log('BYTES  a sats payment, SPEND_ALL_BEGIN:              ' + begSat);
      console.log('BYTES  a dollar payment, SPEND_ALL_BEGIN:            ' + begUsd);
    }
    await settle();
    booksGood('two units', H, R);
  }

  /* ---- 4: a limit with the rate, and the PIN form at set-up --------------------------------------------------------- */
  if (want(4)) {
    const H = await funded({ units: ['sat', 'usd'] }, 0);
    const card = newCard(H, undefined, { format: 4, software: 23 });
    await H.W.cardSetUp(card, { pin: '1234', unit: 'sat', price: PRICE, tapLimit: 10000, tapUsd: 10, noPin: 2000, noPinUsd: 2 });
    const pinForm = cmds(card, '33')[0] || '';
    ok(pinForm === 'b03300000c' + '000003e8' + '000000c8' + '000003e8', 'set-up: the PIN form of twelve bytes, $10.00 and $2.00 in cents and 1,000 sats a dollar', pinForm);
    ok(card.state.tapLimit === 1000 && card.state.noPinLimit === 200 && card.state.rate === 1000, 'the card holds them so');
    card.tap();
    card.sent.length = 0;
    await H.W.cardSetLimit(card, { sats: 2500, tap: true, usd: 25, unit: 'sat', price: PRICE });
    const lim = cmds(card, '34')[0] || '';
    const value = lim.slice(-32);
    ok(lim && parseInt(lim.substr(8, 2), 16) === parseInt(lim.substr(10, 2), 16) + 1 + 16 && value === '00000000' + '000009c4' + '000000c8' + '000003e8',
       'CHANGE LIMIT: the owner’s form of sixteen bytes, no daily limit, $25.00 on one payment, the allowance as it was, the rate', value);
    console.log('BYTES  a limit with the rate, SET_LIMIT (0x34):      ' + lim.slice(0, 10) + ' <proof> ' + value);
    console.log('BYTES  the PIN form at set-up, SET_LIMIT (0x33):     ' + pinForm);
  }

  /* ---- 5: one ceiling in cents across both units -------------------------------------------------------------------- */
  if (want(5)) {
    const { H, R, card } = await world({});
    // the till is not told the card's rate: it guesses at its own price, as the card's answer has the last word
    R.W._rate = PRICE; R.W._rateAt = Date.now();
    await add(H, card, 3000, 'sat');
    await add(H, card, 500, 'usd');
    // no PIN: 150 sats at 1,000 sats a dollar is 15 cents of the $2.00 allowance
    const p1 = await pay(R, card, { sats: 150, pin: '' });
    ok(p1.amount === 150 && card.state.noPinSpent === toC(card.state, 150), 'a sats payment with no PIN, weighed at the rate: 15 cents of the allowance',
       JSON.stringify([p1.refused || p1.amount, card.state.noPinSpent]));
    // dollars with no PIN: what is left of the $2.00 is the same allowance
    const p2 = await pay(R, card, { asks: [{ unit: 'usd', amount: 150 }], pin: '', from: 'usd' });
    ok(p2.amount === 150 && card.state.noPinSpent === 165, 'a dollar payment with no PIN counts into the same allowance: 15 + 150 cents', JSON.stringify([p2.refused || p2.amount, card.state.noPinSpent]));
    card.tap();
    const asTill = await R.W.cardLook(card, { noAuth: true });
    ok(R.W.cardNeedsPin(R.W.cardInUnit(asTill, 'sat'), 400) === true && R.W.cardNeedsPin(R.W.cardInUnit(asTill, 'sat'), 300) === false,
       'the till’s guess at its own price: 400 sats is 40 cents, over the 35 left, and asks the PIN first; 300 does not');
    const p3 = await pay(R, card, { sats: 900, pin: '' });
    ok(p3.refused === 'pin-needed', 'and sats over what is left of it: the PIN, asked before anything is signed', JSON.stringify(p3.refused || p3.amount));
    const p4 = await pay(R, card, { sats: 900 });
    ok(p4.amount === 900, 'with the PIN it pays');
    await settle();
    booksGood('one ceiling', H, R);
  }

  /* ---- 6: the rate -------------------------------------------------------------------------------------------------- */
  if (want(6)) {
    const { H, card } = await world({});
    await add(H, card, 3000, 'sat');
    // under 2% moved: nothing written
    card.tap(); card.sent.length = 0;
    await H.W.cardLook(card, { mine: true, price: PRICE * 1.01 });
    ok(cmds(card, '34').length === 0 && card.state.rate === 1000, 'the price moved 1%: the rate is left as it is');
    // past 2%: written, with nothing said, the figures as they are
    card.tap(); card.sent.length = 0;
    const r2 = await H.W.cardLook(card, { mine: true, price: 104000 });
    ok(card.state.rate === Math.floor(1e8 / 104000) && r2.repegged === Math.floor(1e8 / 104000) && card.state.tapLimit === 1000 && card.state.noPinLimit === 200,
       'the price moved 4%: the rate written again, the figures kept', JSON.stringify([card.state.rate, card.state.tapLimit, card.state.noPinLimit]));
    // far off: not written, and asked
    card.tap(); card.sent.length = 0;
    const r3 = await H.W.cardLook(card, { mine: true, price: 260000 });
    ok(cmds(card, '34').length === 0 && r3.rateAsk && r3.rateAsk.now === 260000 && r3.rateAsk.was === Math.round(1e8 / card.state.rate),
       'the price more than twice the card’s: nothing written, and the owner asked', JSON.stringify(r3.rateAsk));
    card.tap();
    await H.W.cardSetRate(card, { price: 260000 });
    ok(card.state.rate === Math.floor(1e8 / 260000), 'the owner said yes: the rate written');
    // CHANGE LIMIT at a far price asks; with the answer, writes
    card.tap();
    const far = await why(H.W.cardSetLimit(card, { sats: 3000, tap: true, usd: 30, unit: 'sat', price: 90000 }));
    ok(far === 'rate-far' && card.state.tapLimit === 1000, 'CHANGE LIMIT at a price far from the card’s: asked first, nothing written', far);
    card.tap();
    await H.W.cardSetLimit(card, { sats: 3000, tap: true, usd: 30, unit: 'sat', price: 90000, keepRate: true });
    ok(card.state.tapLimit === 3000 && card.state.rate === Math.floor(1e8 / 260000), 'answered NO: the limit written ($30.00) with the card’s own rate');
    // a limit typed in sats: turned into cents at the rate written with it
    card.tap();
    await H.W.cardSetLimit(card, { sats: 5000, noPin: true, unit: 'sat', price: 250000 });
    ok(card.state.noPinLimit === Math.ceil(5000 * 100 / card.state.rate), 'a limit typed in sats is cents at the rate written in the same tap', String(card.state.noPinLimit));
    // a first rate is never asked about: a card with a limit and no rate is given one
    const w2 = await world({ limits: false });
    w2.card.tap();
    await w2.H.W.cardSetLimit(w2.card, { sats: 500, tap: true, usd: 5, unit: 'sat', price: 50000 });
    ok(w2.card.state.rate === 2000 && w2.card.state.tapLimit === 500, 'a first rate is written with the limit, nothing asked');
    await settle();
    booksGood('the rate', H);
  }

  /* ---- 7: always ask -------------------------------------------------------------------------------------------- */
  if (want(7)) {
    const { H, R, card } = await world({});
    await add(H, card, 3000, 'sat');
    await add(H, card, 500, 'usd');
    const both = await pay(R, card, { asks: [{ unit: 'usd', amount: 100 }, { unit: 'sat', amount: 100 }] });
    ok(both.refused === 'choose-unit' && both.error.units.length === 2 && both.error.units.every((x) => !x.short) && cmds(card, '22').length === 0 && cmds(card, '40').length === 0,
       'a till that takes both, a card that holds both: the holder is asked, before any PIN or BEGIN', JSON.stringify(both.refused));
    const chose = await pay(R, card, { asks: [{ unit: 'usd', amount: 100 }, { unit: 'sat', amount: 100 }], from: 'sat', fromKey: card.key });
    ok(chose.unit === 'sat' && chose.amount === 100, 'the holder’s choice pays');
    const short = await pay(R, card, { asks: [{ unit: 'usd', amount: 1000 }, { unit: 'sat', amount: 100 }] });
    ok(short.unit === 'sat' && short.amount === 100, 'a currency that cannot cover it is not offered: the other pays, nothing asked', JSON.stringify(short.refused || short.unit));
    const one = await pay(R, card, { sats: 100 });
    ok(one.unit === 'sat' && one.amount === 100, 'a till of one unit asks nothing');
    const elsewhere = await pay(R, card, { asks: [{ unit: 'usd', amount: 100 }, { unit: 'sat', amount: 100 }], from: 'usd', fromKey: '02' + '11'.repeat(32) });
    ok(elsewhere.refused === 'choose-unit', 'a choice made for another card is not this card’s');
    await settle();
    booksGood('always ask', H, R);
  }

  /* ---- 8: SWAP, and all of both off in one tap --------------------------------------------------------------------- */
  if (want(8)) {
    const { H, card } = await world({});
    await add(H, card, 3000, 'sat');
    await add(H, card, 500, 'usd');
    const before = H.W.balanceOf('sat');
    card.tap();
    const off = await H.W.cardWithdraw(card, { pin: '1234', sats: 300, unit: 'usd' });
    ok(off.unit === 'usd' && off.amount === 300, 'tap 1: $3.00 off the card in dollars');
    const sw1 = await H.W.swapUnits('usd', 'sat', 300);
    ok(sw1 && sw1.state === 'done' && sw1.to && sw1.to.unit === 'sat' && sw1.to.amount > 0, 'no card: swapped at the mint', JSON.stringify(sw1 && sw1.state));
    const got = sw1.to.amount;
    const on = await add(H, card, got, 'sat');
    ok(on.unit === 'sat' && on.amount === got, 'tap 2: what arrived put on in sats', JSON.stringify([on.unit, on.amount, got]));
    card.tap();
    const seen = await H.W.cardLook(card, { mine: true, price: PRICE });
    ok(seen.units.usd.balance === 200 && seen.units.sat.balance === 3000 + got, 'the card holds $2.00 and the sats more');
    ok(H.W.balanceOf('sat') === before, 'this phone’s own sats are as they were', String(H.W.balanceOf('sat') - before));
    card.tap();
    const all = await H.W.cardWithdraw(card, { pin: '1234' });
    ok(all.also && all.also.length === 1 && all.also[0].unit !== all.unit && all.amount > 0 && all.also[0].amount > 0, 'all of it: both units off in one tap, each in its own unit',
       JSON.stringify([all.unit, all.amount, all.also]));
    card.tap();
    const empty = await H.W.cardLook(card, { mine: true, price: PRICE });
    ok(empty.units.sat.balance === 0 && empty.units.usd.balance === 0, 'the card is empty');
    await settle();
    booksGood('swap', H);
    // RENEW: each currency off and on again in its own unit, in the one tap
    const w2 = await world({});
    await add(w2.H, w2.card, 2000, 'sat');
    await add(w2.H, w2.card, 400, 'usd');
    w2.card.tap();
    const rn = await w2.H.W.cardRenew(w2.card, { pin: '1234' });
    w2.card.tap();
    const after = await w2.H.W.cardLook(w2.card, { mine: true, price: PRICE });
    ok(after.units.sat.balance > 1990 && after.units.sat.balance <= 2000 && after.units.usd.balance > 390 && after.units.usd.balance <= 400 && rn.hashes.length === 3,
       'RENEW of a card of both: each currency back on in its own unit, less the mint\u2019s fees', JSON.stringify([after.units.sat.balance, after.units.usd.balance, rn.hashes.length]));
    await settle();
    booksGood('renew', w2.H);
  }

  /* ---- 9: the drawer ------------------------------------------------------------------------------------------------ */
  if (want(9)) {
    const W0 = (await funded({ units: ['sat', 'usd'] }, 0)).W;
    const four = W0.cardDeepLadder(8188, 112, 32768, [], 4).denominations;
    const counts = {};
    four.forEach((d) => { counts[d] = (counts[d] || 0) + 1; });
    ok([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].every((d) => counts[d] === 4) && four.length === 44, 'a drawer four deep: four of every size from 1 to 1,024, 44 pieces, 8,188', JSON.stringify(counts));
    const eight = W0.cardDeepLadder(16376, 112, 32768, []).denominations;
    ok(eight.length === 88, 'and eight deep where no depth is said: 88 pieces, 16,376');
    const { H, card } = await world({ limits: false });
    await add(H, card, 3000, 'sat');
    await add(H, card, 600, 'usd');
    card.tap();
    const seen = await H.W.cardLook(card, { mine: true, price: PRICE });
    const usdCounts = {};
    seen.units.usd.pieces.forEach((x) => { usdCounts[x.amount] = (usdCounts[x.amount] || 0) + 1; });
    ok(usdCounts[1] === 4 && usdCounts[2] === 4 && [4, 8, 16, 32, 64].every((d) => usdCounts[d] >= 4), 'the dollars, the card’s second unit, cut four deep', JSON.stringify(usdCounts));
    const satCounts = {};
    seen.units.sat.pieces.forEach((x) => { satCounts[x.amount] = (satCounts[x.amount] || 0) + 1; });
    ok(satCounts[1] === 8, 'the first unit’s eight-deep drawer is not cut down', JSON.stringify(satCounts));
    const fitsUsd = H.W.cardLoadFits(seen, 100, 'usd');
    ok(fitsUsd && fitsUsd.ok, 'a top-up of dollars is cut for the dollar rungs alone');
    const held = H.W.cardHeld(H.W.cardInUnit(seen, 'usd'));
    ok(held.length === seen.units.usd.pieces.length, 'and counts the dollar pieces alone, never a sats piece');
  }

  /* ---- 10: refusals -------------------------------------------------------------------------------------------------- */
  if (want(10)) {
    const { H, R, card } = await world({});
    await add(H, card, 3000, 'sat');
    // a phone that is not the owner, with the PIN: dollars onto a sats card
    await fundUsd(R, 5000);
    card.tap();
    const no = await why(R.W.cardAdd(card, { amount: 200, unit: 'usd', pin: '1234' }));
    ok(no === 'owner-unit', 'a new currency by a phone that is not the card’s owner: refused in words (6A9D)', no);
    // a card with a limit and no rate (set so by something else): the owner's phone writes the rate first
    card.state.rate = 0;
    const r = await add(H, card, 200, 'sat');
    ok(r.amount === 200 && card.state.rate === 1000, 'sats onto a card with a limit and no rate: the owner’s phone writes the rate first, and they go on', JSON.stringify([r.amount, card.state.rate]));
    card.state.rate = 0;
    card.tap();
    const p = await pay(R, card, { sats: 100 });
    ok(p.refused === 'no-rate' && /cannot pay in bitcoin/.test(p.error.message), 'a sats payment with a limit and no rate: 6A99, in words', JSON.stringify(p.refused));
    card.state.rate = 1000;
    // a phone that knows no units, reading format 5, is the old page's refusal; this page reads it
    await add(H, card, 300, 'usd');
    card.tap();
    const seen = await H.W.cardLook(card, { mine: true, price: PRICE });
    ok(seen.info.format === 5, 'format 5 is read by this phone');
    card.tap();
    await card.send('00a4040009f0464f58594341524400');
    const said = H.W.cardParse.info((await card.send('b001030000')).slice(0, -4));
    ok(said.format === 5 && said.units && said.twoUnits && said.book && said.book.entries === 2, 'GET_INFO P1 = 3 of a card of both parsed: format 5, the book', JSON.stringify(said.book));
    await settle();
    booksGood('refusals', H, R);
  }

  /* ---- 11: the version gate ----------------------------------------------------------------------------------------- */
  if (want(11)) {
    const H = await funded({ units: ['sat', 'usd'] }, 20000);
    const card = newCard(H, undefined, { format: 4, software: 22 });
    await H.W.cardSetUp(card, { pin: '1234', unit: 'sat', price: PRICE, tapLimit: 10000, tapUsd: 10, noPin: 2000, noPinUsd: 2 });
    await add(H, card, 2000, 'sat');
    card.tap();
    await H.W.cardSetLimit(card, { sats: 20000, tap: true, usd: 20, price: PRICE });
    card.tap();
    await H.W.cardLook(card, { mine: true, price: PRICE });
    ok(!card.sent.some((a) => a.slice(0, 8) === 'b0010300'), 'a card of 1.22 is never asked GET_INFO P1 = 3');
    ok(!card.sent.some((a) => a.slice(0, 4) === 'b030' && a.substr(6, 2) === '01'), 'nor sent a labelled load');
    ok(cmds(card, '33').every((a) => a.substr(8, 2) === '08') && cmds(card, '34').length > 0
       && cmds(card, '34').every((a) => { const n = parseInt(a.substr(8, 2), 16), proof = parseInt(a.substr(10, 2), 16); return [4, 8, 12].indexOf(n - 1 - proof) >= 0; }),
       'nor a limit of twelve bytes (0x33) or sixteen (0x34)');
    ok(card.state.tapLimit === 20000, 'its limit is in sats, as ever');
  }

  /* ---- 12: the log and the receipts by unit ------------------------------------------------------------------------- */
  if (want(12)) {
    const { H, R, card } = await world({});
    await add(H, card, 3000, 'sat');
    await add(H, card, 500, 'usd');
    await pay(R, card, { sats: 100 });
    await pay(R, card, { asks: [{ unit: 'usd', amount: 50 }], from: 'usd' });
    card.tap();
    const seen = await H.W.cardLook(card, { mine: true, price: PRICE });
    const log = seen.log;
    ok(log && log.other === 50 && log.otherUnit === 'usd' && log.sats >= 100, 'the log: the record’s count in sats and the other unit’s apart', JSON.stringify(log && [log.sats, log.other]));
    ok(log && log.last.some((x) => x.unit === 'usd' && x.otherUnit && x.sats === 50) && log.last.some((x) => x.unit === 'sat' && x.sats === 100), 'each entry says its unit (bit 5)');
    const rc = seen.receipts;
    ok(rc && rc.list.some((x) => x.unit === 'usd' && x.sats === 50) && rc.list.some((x) => x.unit === 'sat' && x.sats === 100), 'each receipt says its unit', JSON.stringify(rc && rc.list.map((x) => [x.unit, x.sats])));
    await settle();
    booksGood('the log', H, R);
  }

  /* ---- 13: no format compared with 4 alone -------------------------------------------------------------------------- */
  if (want(13)) {
    const files = ['build/wallet/08a-flashcard.js', 'build/wallet/21a-flashcard.js', 'build/app/26f-flashcard.js'];
    const found = [];
    files.forEach((f) => {
      fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').forEach((line, i) => {
        if (/format/i.test(line) && (/=== CARD_FORMAT_ALL\b/.test(line) || /={2,3} 4\b/.test(line)) && !/=== 5|CARD_FORMAT_UNITS/.test(line)) found.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
      });
    });
    ok(found.length === 0, 'no format is compared with 4 alone in the three files: 5 is format 4 to a phone that knows units', found.join(' | '));
  }

  /* ---- 14: the screens ---------------------------------------------------------------------------------------------- */
  if (want(14)) {
    const { H, R, card } = await world({});
    await add(H, card, 3000, 'sat');
    await add(H, card, 500, 'usd');
    H.nfc = card;
    const holder = appOn(H, { screen: 'flashcard', stack: ['home'] });
    holder.price = PRICE;
    holder.twoUnitsOn = () => true;
    holder.unitBalance = (u) => (u === 'usd' ? 10000 : 10000);
    // the CURRENCY screen's pick, the app's own (01-ui-basics.js)
    const pick = new Function('return {' + liftFrom('01-ui-basics.js', 'currencyPick(unit) {') + '}')();
    holder.currencyPick = pick.currencyPick;
    holder.fcRead();
    await until('the card read', () => !!holder.state.fc && !(holder._fcTaps > 0));
    await uiSettle();
    const fc = holder.state.fc;
    ok(fc.v123 && fc.cents && fc.bal && fc.bal.usd === 500 && fc.bal.sat === 3000 && holder.fcTwoUnits(fc), 'the card\u2019s screen knows it holds both, and each balance');
    const v = vals(holder);
    ok(v.fcPillRows.length === 2 && v.fcPillRows[0].big === '5.00' && v.fcPillRows[1].big === '3,000', 'two pills: dollars, then bitcoin', JSON.stringify(v.fcPillRows.map((x) => x.big)));
    ok(/^PER TAP LIMIT \$10\.00/.test(v.fcLimitLine) && /both currencies$/.test(limitsSub(v)), 'the ceiling once, in dollars, for both', v.fcLimitLine + ' / ' + limitsSub(v));
    ok(v.fcButtons.some((x) => x.label === 'SWAP' && (x.dim === '1') === !holder.offlineNow()), 'SWAP is in the bottom row, and not greyed for being of one currency');
    holder.fcWithdraw();
    ok(holder.state.screen === 'currency' && holder.state.currencyFlow === 'card' && holder.state.curCard && holder.state.curCard.question === 'WITHDRAW WHICH?'
       && holder.state.curCard.bal.usd === 500, 'WITHDRAW asks which currency first, with what the card holds of each');
    holder.currencyPick('usd');
    ok(holder.state.screen === 'amount' && holder.state.flow === 'cardWd' && holder.fcUnit() === 'usd', 'dollars chosen: SET AMOUNT in dollars');
    holder.state.amount = '1.00';
    holder.state.unit = 'USD';
    card.tap();
    holder.fcAmountNext();
    await until('the PIN pad', () => !!pad(holder));
    pad(holder).type('1234');
    await until('the money to come off', () => !(holder._fcTaps > 0) && card.state.slots.filter((x) => x.status === 1 && (card.state.book.table.find((e) => e.keyset === x.data.substr(0, 16)) || {}).state === 0xc1)
      .reduce((n, x) => n + parseInt(x.data.substr(16, 8), 16), 0) === 400);
    await uiSettle();
    ok(cardUp(holder) === null || !/WRONG|NOT/.test(cardUp(holder).title || ''), 'and $1.00 came off in dollars, the sats left alone', cardUp(holder) && cardUp(holder).all);
    // the till's question
    const till = appOn(R, { screen: 'home' });
    let again = 0;
    till.fcPayChoose({ card: 'choose-unit', key: card.key, units: [{ unit: 'usd', balance: 50, amount: 100, short: true }, { unit: 'sat', balance: 3000, amount: 100, short: false }] }, () => { again += 1; });
    ok(till.state.screen === 'currency' && till.state.curCard.question === 'PAY FROM WHICH?' && till.state.curCard.short.usd === 'NOT ENOUGH ON THE CARD' && !till.state.curCard.short.sat,
       'the till: PAY FROM WHICH?, the currency that cannot cover it greyed');
    till.currencyPick = pick.currencyPick;
    till.currencyPick('sat');
    ok(again === 1 && till._fcFrom && till._fcFrom.unit === 'sat' && till._fcFrom.key === card.key, 'the one chosen is this payment\u2019s, for this card, and the payment goes on');
    // the rate guard, from the owner's read
    holder.price = 260000;
    card.tap();
    holder.fcRead();
    await until('the question', () => !!cardUp(holder) && cardUp(holder).title === 'BITCOIN PRICE');
    ok(/now \$260,000; the card last knew \$100,000\. Update it\?/.test(cardUp(holder).reason) && card.state.rate === 1000, 'a price far from the card\u2019s: asked once, nothing written yet',
       cardUp(holder).reason);
    card.tap();
    cardUp(holder).press('YES');
    await until('the rate written', () => card.state.rate === Math.floor(1e8 / 260000) && !(holder._fcTaps > 0));
    ok(card.state.rate === Math.floor(1e8 / 260000), 'YES: the rate written in one tap');
    await uiSettle();
    booksGood('the screens', H, R);
  }

  /* ---- 15: what review found ---------------------------------------------------------------------------------------- */
  if (want(15)) {
    // (1) a card of sats holding dollars alone: all of it off, renewed and reset, on the wallet and on its screen
    {
      const mk = async () => {
        const w = await world({});
        await add(w.H, w.card, 1500, 'usd');
        return w;
      };
      let w = await mk();
      w.card.tap();
      const wd = await w.H.W.cardWithdraw(w.card, { pin: '1234' }).then((x) => x, (e) => ({ refused: e.card, msg: e.message }));
      ok(wd.unit === 'usd' && wd.amount === 1500, 'review 1: WITHDRAW of all from a sats card holding dollars alone takes the dollars', JSON.stringify(wd));
      await settle();
      w = await mk();
      w.card.tap();
      const rn = await w.H.W.cardRenew(w.card, { pin: '1234' }).then((x) => x, (e) => ({ refused: e.card, msg: e.message }));
      w.card.tap();
      const after = await w.H.W.cardLook(w.card, { mine: true, price: PRICE });
      ok(!rn.refused && after.units.usd.balance > 1490 && after.units.usd.balance <= 1500 && after.units.sat.balance === 0,
         'review 1: RENEW of it puts the dollars back on as dollars', JSON.stringify([rn.refused, after.units.usd.balance, after.units.sat.balance]));
      await settle();
      w = await mk();
      w.H.nfc = w.card;
      const holder = appOn(w.H, { screen: 'flashcard', stack: ['home'] });
      holder.price = PRICE;
      holder.fcRead();
      await until('the card read', () => !!holder.state.fc && !(holder._fcTaps > 0));
      await uiSettle();
      const fc = holder.state.fc;
      ok(fc.balance === 0 && holder.fcAnyMoney(fc) && /\$15\.00/.test(holder.fcWholeWords(fc)), 'review 1: its screen knows it holds money though its record’s currency is empty');
      holder.fcReset();
      ok(cardUp(holder) && /\$15\.00 on it comes off/.test(cardUp(holder).reason), 'review 1: RESET’s warning names the dollars', cardUp(holder) && cardUp(holder).reason);
      cardUp(holder).press('CONTINUE');
      await until('the PIN pad', () => !!pad(holder));
      ok(!!pad(holder) && /\$15\.00/.test(pad(holder).sub), 'review 1: and asks the PIN to take them off', pad(holder) && pad(holder).sub);
      w.card.tap();
      pad(holder).type('1234');
      await until('the reset', () => !(holder._fcTaps > 0) && holder.state.screen === 'home');
      ok(w.card.state.owner === null && w.card.state.slots.every((x) => x.status !== 1), 'review 1: the card is emptied of its dollars and reset');
      await settle();
      booksGood('review 1', w.H);
    }

    // (2) a card's SWAP priced while its money is still on the card, and the fee's unused part put back on it
    {
      const { H, card } = await world({ cents: 5000 });
      await add(H, card, 5000, 'usd');
      ok(H.W.balanceOf('usd') === 0, 'review 2: this phone holds no dollars of its own');
      const no = await H.W.swapQuote('usd', 'sat', 2000, {}).then(() => 'quoted', (e) => e.message);
      const q = await H.W.swapQuote('usd', 'sat', 2000, { coming: 5000 }).then((x) => x, (e) => ({ refused: e.message }));
      ok(/more than your dollars/.test(no) && q.total > 0 && q.total <= 2000, 'review 2: the rate for the card’s dollars is asked with what comes off the card counted', JSON.stringify([no, q.total || q.refused]));
      card.tap();
      const off = await H.W.cardWithdraw(card, { pin: '1234', sats: q.total, unit: 'usd' });
      const sw2 = await H.W.swapRun(q, () => {});
      ok(sw2 && sw2.state === 'done', 'review 2: swapped at the mint');
      const left = Math.max(0, off.amount - sw2.from.amount);
      // what the fee did not use, and a little of this phone's own as a stand-in where the test mint used it all
      const back = Math.max(left, 1);
      if (H.W.balanceOf('usd') < back) await fundUsd(H, back);
      H.nfc = card;
      const holder = appOn(H, { screen: 'flashcard', stack: ['home'] });
      holder.price = PRICE;
      card.tap();
      holder.fcSwapOn(sw2.to.amount, 'sat', '1234', sw2, { amount: back, unit: 'usd' });
      await until('the second tap', () => !(holder._fcTaps > 0) && holder.state.screen === 'swapDone');
      card.tap();
      const seen = await H.W.cardLook(card, { mine: true, price: PRICE });
      ok(seen.units.usd.balance === 5000 - off.amount + back && seen.units.sat.balance === sw2.to.amount,
         'review 2: the swap’s sats and the fee’s unused dollars both go on in the second tap', JSON.stringify([seen.units.usd.balance, seen.units.sat.balance, off.amount, back]));
      ok(holder.toasts.some((t) => /fee was not used and is back on the card/.test(t)), 'review 2: and it is said', holder.toasts.join(' | '));
      const sc = appOn(H, { screen: 'flashcard' });
      sc._swapCard = { key: card.key, bal: { usd: 3000, sat: 0 } };
      const lifted = new Function('return {' + liftFrom('26i-swap.js', 'swapComing(u) {') + '}')();
      ok(lifted.swapComing.call(sc, 'usd').coming === 3000 && Object.keys(lifted.swapComing.call({ _swapCard: null }, 'usd')).length === 0,
         'review 2: the swap screen counts the card’s money as coming, and nothing for this phone’s own SWAP');
      await settle();
      booksGood('review 2', H);
    }

    // (3) a card of both at a till at another mint: its holder is asked which pays
    {
      const H = await funded({ units: ['sat', 'usd'] }, 50000);
      await fundUsd(H, 20000);
      const R = await funded({ units: ['sat', 'usd'], mint: MINT2, words: OTHER_WORDS }, 0);
      const card = newCard(H, undefined, { format: 4, software: 23 });
      await H.W.cardSetUp(card, { pin: '1234', unit: 'sat', price: PRICE, tapLimit: 10000, tapUsd: 10, noPin: 2000, noPinUsd: 2 });
      await add(H, card, 100, 'sat');
      await add(H, card, 3000, 'usd');
      const p = await pay(R, card, { asks: [{ unit: 'usd', amount: 500 }, { unit: 'sat', amount: 5000 }] });
      ok(p.refused === 'other-mint' && p.error.units && p.error.units.usd === 3000 && p.error.units.sat === 100, 'review 3: the other mint’s refusal says what the card holds in each', JSON.stringify(p.error && p.error.units));
      const till = appOn(R, { screen: 'receive', invoice: 'lnbcrt50u1test' });
      till.fcPickUnit = (o, then) => { till.asked = o; till.then = then; };
      till.fcXmOpen = (x) => { till.opened = x; };
      R.W.cardOnline = () => true;
      till.fcXmBegin(p.error, 5000, false, null);
      ok(till.asked && till.asked.question === 'PAY FROM WHICH?' && till.asked.bal.usd === 3000 && till.asked.bal.sat === 100 && !till.opened, 'review 3: PAY FROM WHICH? before the card’s mint is asked anything');
      till.then('usd');
      ok(till.opened && till.opened.payUnit === 'usd' && till.opened.balance === 3000, 'review 3: dollars chosen, the card pays from its dollars', JSON.stringify(till.opened && [till.opened.payUnit, till.opened.balance]));
      await settle();
    }

    // (4) a card of both at a till of sats alone, its sats short and its dollars enough: the dollars are offered, as a dollar card's are
    {
      const { H, R, card } = await world({});
      await add(H, card, 200, 'sat');
      await add(H, card, 2000, 'usd');
      const p = await pay(R, card, { sats: 1000 });
      ok(p.refused === 'other-unit' && p.error.balance === 2000 && p.error.cardUnit === 'usd', 'review 4: the till is told the card can pay in dollars', JSON.stringify([p.refused, p.error && p.error.balance]));
      const agreed = await pay(R, card, { asks: [{ unit: 'usd', amount: 100 }] });
      ok(agreed.unit === 'usd' && agreed.amount === 100, 'review 4: and the dollars agreed to pay');
      await settle();
      booksGood('review 4', H, R);
    }

    // (5) a card of one currency on 1.23 says no pieces above its limit where a card of 1.22 says none
    {
      for (const software of [22, 23]) {
        const { H, card } = await world({ card: { software } });
        await add(H, card, 20000, 'sat');
        H.nfc = card;
        const holder = appOn(H, { screen: 'flashcard', stack: ['home'] });
        holder.price = PRICE;
        holder.fcRead();
        await until('the card read', () => !!holder.state.fc && !(holder._fcTaps > 0));
        await uiSettle();
        ok(holder.state.fc.above === 0, 'review 5: a sats card of 1.' + software + ' with $10 a tap and 20,000 sats: nothing above the limit', String(holder.state.fc.above));
        if (software === 23) {
          const c = holder._fcCard;
          ok(holder.fcAbove(c, 100, 'usd') > 0 && holder.fcAbove(c, 100, 'usd') === H.W.cardAboveFor(c, 100, 'usd', PRICE), 'review 5: under a $1.00 limit its pieces above $1.00 are counted, in sats');
        }
        await settle();
      }
      const { H, card } = await world({});
      await add(H, card, 20000, 'sat');
      await add(H, card, 500, 'usd');
      card.tap();
      const seen = await H.W.cardLook(card, { mine: true, price: PRICE });
      H.nfc = card;
      const holder = appOn(H, { screen: 'flashcard' });
      holder.price = PRICE;
      ok(holder.fcAbove(seen, 100, 'usd', true) === 0 && holder.fcAbove(seen, 100, 'usd') > 0, 'review 5: a card of both is promised no recut under a new limit');
      await settle();
    }

    // (6) no price, no write
    {
      const H = await funded({ units: ['sat', 'usd'] }, 50000);
      const R = await funded({ units: ['sat', 'usd'], sharedMint: H.mint, words: OTHER_WORDS }, 0);
      H.W._rate = null; H.W._rateAt = 0;
      const card = newCard(H, undefined, { format: 4, software: 23 });
      await H.W.cardSetUp(card, { pin: '1234', unit: 'sat' });
      await add(H, card, 3000, 'sat', { price: 0 });
      card.tap();
      const r = await H.W.cardSetLimit(card, { sats: 500, tap: true, usd: 5, unit: 'usd' }).then(() => 'written', (e) => e.card);
      ok(r === 'no-price' && card.state.tapLimit === 0 && card.state.rate === 0, 'review 6: CHANGE LIMIT with no price on a card of bitcoin: refused, nothing written', JSON.stringify([r, card.state.tapLimit]));
      const p = await pay(R, card, { sats: 100 });
      ok(p.amount === 100, 'review 6: and its sats still pay');
      const card2 = newCard(H, undefined, { format: 4, software: 23 });
      const s2 = await why(H.W.cardSetUp(card2, { pin: '1234', unit: 'sat', tapLimit: 10000, tapUsd: 10 }));
      ok(s2 === 'no-price' && !card2.state.owner && !card2.state.hasRecord, 'review 6: set-up with limits and no price: refused before anything is written', JSON.stringify([s2, card2.state.owner]));
      const card3 = newCard(H, undefined, { format: 4, software: 23 });
      R.W._rate = null; R.W._rateAt = 0;
      const s3 = await why(R.W.cardSetUpFor(card3, { pin: '1234', unit: 'sat', tapLimit: 10000, tapUsd: 10 }));
      ok(s3 === 'no-price' && !card3.state.hasRecord, 'review 6: and set-up for a holder too', String(s3));
      const card4 = newCard(H, undefined, { format: 4, software: 23 });
      const s4 = await H.W.cardSetUp(card4, { pin: '1234', unit: 'usd', tapLimit: 1000, noPin: 200 }).then(() => 'set up', (e) => e.card);
      ok(s4 === 'set up' && card4.state.tapLimit === 1000, 'review 6: a dollar card needs no price for its limits, as before', String(s4));
      await settle();
    }

    // (7) figures in the unit they are said in
    {
      const { H, R, card } = await world({});
      await add(H, card, 9000, 'sat');
      card.tap();
      await H.W.cardSetLimit(card, { sats: 100, usd: 1, unit: 'usd', price: PRICE });
      // (the till's own price, which it weighs the card's sats at: the card says its rate to its holder alone)
      R.W._rate = PRICE; R.W._rateAt = Date.now();
      const p = await pay(R, card, { sats: 5000 });
      ok((p.refused === 'limit' || p.refused === 'tap-limit') && p.error.cardUnit === 'sat' && p.error.limit === 1000 && p.error.left <= 1000,
         'review 7: the day’s refusal says its limit and what is left in sats, not cents', JSON.stringify(p.error && [p.refused, p.error.limit, p.error.left, p.error.cardUnit]));
      const holder = appOn(H, { screen: 'flashcard' });
      ok(holder.fcCardHolds({ balance: 3000, units: { sat: { balance: 3000 }, usd: { balance: 500 } } }, 'usd') === 500 && holder.fcCardHolds({ balance: 70 }, 'sat') === 70,
         'review 7: "It now holds" reads the balance of the currency that went on');
      const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '26f-flashcard.js'), 'utf8');
      ok(!/It now holds ' \+ this\.fcSats\(r\.card\.balance/.test(src), 'review 7: no line says the record’s balance in another currency');
      await settle();
      booksGood('review 7', H, R);
    }

    // suspected: a choice backed out of, a borrowed or old price, LIMITS on a card of dollars alone
    {
      const { H, R, card } = await world({});
      await add(H, card, 3000, 'sat');
      await add(H, card, 500, 'usd');
      const till = appOn(R, { screen: 'home' });
      const pick = new Function('return {' + liftFrom('01-ui-basics.js', 'currencyPick(unit) {') + '}')();
      till.currencyPick = pick.currencyPick;
      till.fcPayChoose({ card: 'choose-unit', key: card.key, units: [{ unit: 'usd', balance: 500, amount: 100 }, { unit: 'sat', balance: 3000, amount: 100 }] },
                       () => till.fcPayAsk(100, false, false, null, null, null, null, 'sat'));
      till.currencyPick('sat');
      ok(till._fcFrom && till._fcFrom.unit === 'sat' && !!pad(till), 'suspected: the choice is made, and the PIN is asked');
      pad(till).back();
      ok(till._fcFrom === null, 'suspected: backed out of the PIN, the choice is forgotten and the next payment asks again');
      const holder = appOn(H, { screen: 'flashcard' });
      holder.price = 50000;
      holder.peerRate = () => 50000;
      holder.state.satUsd = PRICE / 1e8;
      ok(holder.fcRatePrice() === PRICE, 'suspected: a card’s rate is never written at another phone’s price', String(holder.fcRatePrice()));
      holder.peerRate = () => 0;
      holder.price = PRICE;
      H.W._rate = PRICE; H.W._rateAt = Date.now() - 30 * 86400 * 1000;
      ok(holder.fcRatePrice() === 0, 'suspected: nor at a price older than this phone trusts', String(holder.fcRatePrice()));
      H.W._rateAt = Date.now();
      ok(holder.fcRatePrice() === PRICE, 'suspected: a fresh price of this phone’s own is used');
      holder.state.fc = { v123: true, unit: 'sat', bal: { usd: 500, sat: 0 }, units: ['sat', 'usd'], balance: 0 };
      ok(holder.fcLimitUnit() === 'usd', 'suspected: LIMITS on a card holding dollars alone is in dollars');
      holder.state.fc = { v123: true, unit: 'usd', bal: { usd: 500, sat: 10 }, units: ['sat', 'usd'], balance: 500 };
      ok(holder.fcLimitUnit() === 'sat', 'suspected: and in dollars or sats where it holds bitcoin');
      holder.state.fc = { v123: true, unit: 'sat', bal: { usd: 0, sat: 0 }, units: ['sat'], balance: 0 };
      ok(holder.fcLimitUnit() === 'sat', 'suspected: an empty card of bitcoin, as it was set up');
      await settle();
    }
  }

  /* ---- 16: what a second look found ---------------------------------------------------------------------------------- */
  if (want(16)) {
    // (3) a card of both at another mint that charges for spending pieces: the fee on the chosen currency's own pieces is shown, and that
    // currency pays, end to end
    for (const u of ['usd', 'sat']) {
      const H = page({ second: true, units: ['sat', 'usd'], feePpk: 400, mintOpts: { usdFeePpk: 400 }, mintOpts2: { quotesUnpaid: true } });
      await H.W.connect(MINT, null, null, { remember: true });
      await H.W.claim((await H.W.invoice(9000, '')).hash);
      await fundUsd(H, 20000);
      await H.W.primeLocks();
      const R = page({ second: true, sharedMint: H.mint, sharedMint2: H.mint2, words: OTHER_WORDS });
      await R.W.connect(MINT2, null, null, { remember: true });
      await R.W.primeLocks();
      // what Lightning does between the two test mints: a melt at the card's mint that is PAID pays the till's quote
      R.fate = (m) => {
        const url = new URL(m.url);
        if (url.origin !== MINT || url.pathname !== '/v1/melt/bolt11' || m.method !== 'POST') return null;
        const said = H.mint.handle(m);
        try {
          const body = JSON.parse(String(said).slice(String(said).indexOf('\n') + 1));
          const id = body && body.state === 'PAID' ? Object.keys(H.mint2.quotes).filter((k) => H.mint2.quotes[k].request === body.request)[0] : '';
          if (id) H.mint2.payQuote(id);
        } catch (e) { /* a refusal: nothing paid */ }
        return said;
      };
      const till = appOn(R, { screen: 'confirm', flow: 'receive', stack: ['home', 'amount'] }, { send: true, receive: true });
      till.mintNameOf = (x) => String(x || '').replace(/\/+$/, '').replace(/^https?:\/\//, '');
      till.mintName = () => till.mintNameOf(R.W.mintUrl);
      till.currencyPick = new Function('return {' + liftFrom('01-ui-basics.js', 'currencyPick(unit) {') + '}')().currencyPick;
      const card = newCard(H, undefined, { format: 4, software: 23 });
      await H.W.cardSetUp(card, { pin: '1234', unit: 'sat', price: PRICE });
      await add(H, card, 3000, 'sat');
      await add(H, card, 3000, 'usd');
      card.tap();
      const before = await H.W.cardLook(card, { mine: true, price: PRICE });
      R.nfc = card;
      const q = await R.W.invoice(600, '');
      till.setState({ screen: 'confirm', flow: 'receive', stack: ['home', 'amount'], wallet: 'sat', unit: 'SATS', amount: '600',
                      invoice: q.bolt11, invoiceHash: q.hash, recvUnit: 'sat', recvAmount: null, recvExpiresAt: null });
      till.asking = 600;
      card.tap();
      till.payByCard();
      await until('PAY FROM WHICH?', () => till.state.screen === 'currency');
      till.currencyPick(u);
      await until('the confirmation', () => till.state.screen === 'fcXmConfirm' && !!(till.state.fcXm && (till.state.fcXm.quote || till.state.fcXm.err)));
      const x = till.state.fcXm;
      ok(x.payUnit === u && x.cardFee > 0 && !x.err && x.balance === before.units[u].balance,
         'review 3 again (' + u + '): the confirmation counts the card’s mint’s fee on the chosen currency’s own pieces', JSON.stringify({ payUnit: x.payUnit, cardFee: x.cardFee, err: x.err }));
      card.tap();
      till.fcXmSpec().go();
      await until('the PIN pad', () => !!pad(till));
      card.tap();
      pad(till).type('1234');
      await until('the invoice to be paid', () => ['PAID', 'ISSUED'].indexOf(H.mint2.quotes[q.hash].state) >= 0, 4000);
      await until('the tap to be over', () => !(till._fcTaps > 0));
      await settle();
      card.tap();
      const after = await H.W.cardLook(card, { mine: true, price: PRICE });
      const other = u === 'usd' ? 'sat' : 'usd';
      ok(['PAID', 'ISSUED'].indexOf(H.mint2.quotes[q.hash].state) >= 0 && before.units[u].balance - after.units[u].balance === x.pay
         && after.units[other].balance === before.units[other].balance,
         'review 3 again (' + u + '): it pays what PAY said from that currency, and the other is untouched',
         JSON.stringify({ state: H.mint2.quotes[q.hash].state, spent: before.units[u].balance - after.units[u].balance, pay: x.pay, other: before.units[other].balance - after.units[other].balance }));
      await settle();
    }

    // (4) a card of both at a bitcoin till, its sats short and its dollars enough: the dollars pay, end to end, and it says why
    {
      const { H, R, card } = await world({});
      await add(H, card, 200, 'sat');
      await add(H, card, 2000, 'usd');
      card.tap();
      const before = await H.W.cardLook(card, { mine: true, price: PRICE });
      const till = appOn(R, { screen: 'confirm', flow: 'receive', stack: ['home', 'amount'] }, { send: true, receive: true });
      R.nfc = card;
      const q = await R.W.invoice(1000, '');
      till.setState({ screen: 'confirm', flow: 'receive', stack: ['home', 'amount'], wallet: 'sat', unit: 'SATS', amount: '1000',
                      invoice: q.bolt11, invoiceHash: q.hash, recvUnit: 'sat', recvAmount: null, recvExpiresAt: null });
      till.asking = 1000;
      card.tap();
      till.payByCard();
      await until('the dollars offered', () => !!cardUp(till) || !!pad(till));
      const said = pad(till) ? pad(till).sub : (cardUp(till) && cardUp(till).reason) || '';
      ok(/^Its ₿ 200 in bitcoin is not enough\. They asked for ₿ 1,000\./.test(said), 'review 4 again: the till says the card’s bitcoin is short, then what its dollars pay', said);
      card.tap();
      if (pad(till)) pad(till).type('1234'); else cardUp(till).press('TAP CARD');
      await until('the invoice to be paid', () => ['PAID', 'ISSUED'].indexOf(R.mint.quotes[q.hash].state) >= 0, 4000);
      await until('the tap to be over', () => !(till._fcTaps > 0));
      await settle();
      card.tap();
      const after = await H.W.cardLook(card, { mine: true, price: PRICE });
      ok(after.units.sat.balance === before.units.sat.balance && after.units.usd.balance < before.units.usd.balance,
         'review 4 again: the invoice is paid from the card’s dollars, its sats untouched', JSON.stringify([before.units.usd.balance - after.units.usd.balance, before.units.sat.balance - after.units.sat.balance]));
      await settle();
    }

    // (5) the limit screen of a card of both: its pieces above a new limit stay as they are, said plainly, and no PIN is asked to recut
    {
      const { H, card } = await world({});
      await add(H, card, 20000, 'sat');
      await add(H, card, 500, 'usd');
      H.nfc = card;
      const holder = appOn(H, { screen: 'flashcard', stack: ['home'] });
      holder.price = PRICE;
      holder.fcRead();
      await until('the card read', () => !!holder.state.fc && !(holder._fcTaps > 0));
      await uiSettle();
      holder._fcLimitTap = true;
      holder._fcLimitNoPin = false;
      holder.state.fcLimit = { sats: 100, usd: 0 };
      const warn = holder.fcLimitSpec().warn;
      ok(!/recut under the new limit/.test(warn) && /in pieces larger than that\. On a card that holds both currencies they are not recut: they stay as they are, and a till holds the card longer to pay with them\./.test(warn)
         && /\$/.test((/It holds (.*?) in pieces larger/.exec(warn) || [])[1] || ''),
         'review 5 again: no recut is promised; what stays above the limit is said, in dollars first', warn);
      let asked = 'not called';
      holder._fcLimitDone = (s, u, pin) => { asked = pin === undefined ? 'no PIN' : 'PIN'; };
      holder.state.screen = 'fcLimitConfirm';
      holder.fcLimitConfirmed();
      ok(asked === 'no PIN' && !pad(holder), 'review 5 again: and the limit is written with no PIN asked for a recut', asked);
      await settle();
    }

    // (6) set-up with limits and no price: said as a card not set up
    {
      const H = await funded({ units: ['sat', 'usd'] }, 50000);
      H.W._rate = null; H.W._rateAt = 0;
      const card2 = newCard(H, undefined, { format: 4, software: 23 });
      const e = await H.W.cardSetUp(card2, { pin: '1234', unit: 'sat', tapLimit: 10000, tapUsd: 10 }).then(() => null, (x) => x);
      ok(e && e.card === 'no-price' && /the card was not set up/.test(e.message) && !card2.state.hasRecord, 'review 6 again: set-up with no price says the card was not set up', e && e.message);
      await settle();
    }
  }

  /* ---- 17: the set-up's CURRENCY step ------------------------------------------------------------------------------ */
  if (want(17)) {
    const H = await funded({ units: ['sat', 'usd'] }, 50000);
    await fundUsd(H, 20000);
    // the phone's screens, with the CURRENCY screen's own values and pick (25-render-confirm-and-blocked.js, 01-ui-basics.js)
    const screens = () => {
      const a = appOn(H, { screen: 'home' });
      a.price = PRICE;
      a.twoUnitsOn = () => true;
      a.unitBalance = (u) => (u === 'usd' ? 20000 : 50000);
      const lifted = new Function('return {' + [['01-ui-basics.js', 'currencyPick(unit) {'], ['01-ui-basics.js', 'unitWord(unit) {'],
        ['01-ui-basics.js', 'unitFigure(amount, unit) {'], ['25-render-confirm-and-blocked.js', 'renderCurrency(c) {']].map(([f, sig]) => liftFrom(f, sig)).join(',\n') + '}')();
      Object.assign(a, lifted);
      a.satUsd = () => PRICE / 1e8;
      return a;
    };
    const cur = (a) => a.renderCurrency({ s: a.state, sc: 'currency' });
    const toCurrency = async (a, c) => {
      H.nfc = c;
      c.tap();
      a.goFlashcard();
      await until('the new card to be read', () => !!a.state.fc && a.state.fc.key === c.key && !(a._fcTaps > 0));
      a.fcSetUp();
      pad(a).type('1234');
      pad(a).type('1234');
    };
    const setUpAs = async (a, c, i) => {
      await toCurrency(a, c);
      cur(a).curCards[i].tap();
      cardUp(a).press('NO');
      c.tap();
      cardUp(a).press('NO');
      await until('the card to be set up', () => !!c.state.owner && a.state.fc && a.state.fc.key === c.key && a.state.fc.ownedHere === true && !(a._fcTaps > 0));
      await uiSettle();
    };

    /* YES to each question opens SET AMOUNT (26j-card-wheel.js, `fcSuAmount`), in the unit the card will hold, and NEXT carries the figure
     * into the one tap: a card of 1.23 keeps both in cents, a dollar card's typed in dollars, a bitcoin card's typed in dollars too. */
    for (const [i, name] of [[0, 'DOLLARS'], [1, 'BITCOIN']]) {
      const a = screens();
      const c = newCard(H, undefined, { format: 4, software: 23 });
      await toCurrency(a, c);
      cur(a).curCards[i].tap();
      cardUp(a).press('YES');
      const unitNow = a.fcTypedUnit();
      ok(a.state.screen === 'amount' && a.state.flow === 'cardSuNoPin' && a.state.unit === 'USD' && a.state.amount === '' && unitNow === (i === 0 ? 'usd' : 'sat'),
         name + ': YES opens SET AMOUNT for the no-PIN amount, empty and in dollars, for ' + (i === 0 ? 'cents' : 'sats'), JSON.stringify([a.state.flow, a.state.unit, unitNow]));
      a.setState({ amount: '2.00' });
      a.fcAmountNext();
      ok(a.state.screen === 'flashcard' && cardUp(a) && cardUp(a).title === 'MAX PER TAP', name + ': NEXT is the next question, over the card’s screen');
      cardUp(a).press('YES');
      a.setState({ amount: '10.00' });
      ok(a.state.flow === 'cardSuTap' && a.fcSuAmountLine() === 'It will take 13 seconds to pay $40.00.', name + ': the limit’s SET AMOUNT, its seconds under the figure', a.fcSuAmountLine());
      c.tap();
      a.fcAmountNext();
      await until('the card to be set up', () => !!c.state.owner && a.state.fc && a.state.fc.key === c.key && a.state.fc.ownedHere === true && !(a._fcTaps > 0));
      await uiSettle();
      ok(c.state.noPinLimit === 200 && c.state.tapLimit === 1000, name + ': NEXT wrote them to the card in the one tap, $2.00 and $10.00 in cents', JSON.stringify([c.state.noPinLimit, c.state.tapLimit]));
      // one currency chosen: one pill from the moment set-up ends, the ceiling said with no "both", and ADD FUNDS asks nothing
      const v1 = vals(a);
      ok(v1.fcPillRows.length === 1 && v1.fcPillRows[0].big === (i === 0 ? '0.00' : '0') && !/both currencies/.test(limitsSub(v1)),
         name + ': one pill, at nothing, and the ceiling not said for both', JSON.stringify([v1.fcPillRows.map((x) => x.big), limitsSub(v1)]));
      a.fcAdd();
      ok(a.state.screen === 'amount' && a.state.flow === 'cardAdd' && !a.state.curCard && a.fcUnit() === (i === 0 ? 'usd' : 'sat'), name + ': ADD FUNDS asks no currency', a.state.screen);
      a.back();
    }

    // BOTH: three cards of one shape, the words; a dollar record, and ADD FUNDS asks which, sats going on after
    {
      const a = screens();
      const c = newCard(H, undefined, { format: 4, software: 23 });
      await toCurrency(a, c);
      const v = cur(a);
      ok(a.state.screen === 'currency' && v.curQuestion === 'WHAT WILL THIS CARD HOLD?' && v.curCards.map((x) => x.name).join() === 'DOLLARS,BITCOIN,BOTH',
         'a card of 1.23: WHAT WILL THIS CARD HOLD? with DOLLARS, BITCOIN and BOTH', v.curCards.map((x) => x.name).join());
      const b = v.curCards[2];
      ok(b.balance === '' && b.labelShown === false && v.curCards.every((x) => x.labelShown === false && x.balance === '')
         && v.curCards.every((x) => x.badgePx === '52px' && typeof x.tap === 'function'),
         'BOTH is a card of the same shape; the set-up tiles show no balances, all three a size smaller', JSON.stringify([b.balance, b.labelShown]));
      ok(v.curFoot === 'DOLLARS or BITCOIN: the card holds that one, and ADD FUNDS never asks. BOTH: it holds either, and ADD FUNDS asks which each time.',
         'the words under them say what each choice does', v.curFoot);
      b.tap();
      cardUp(a).press('NO');
      c.tap();
      cardUp(a).press('NO');
      await until('the card to be set up', () => !!c.state.owner && a.state.fc && a.state.fc.key === c.key && a.state.fc.ownedHere === true && !(a._fcTaps > 0));
      await uiSettle();
      ok(c.state.record.unit === 1 && a.state.fc.unit === 'usd' && (H.W.cardsKnown()[c.key] || {}).hold === 'both' && a.state.fc.only === ''
         && a.toasts.indexOf('The card is set up. It holds dollars and bitcoin.') >= 0,
         'BOTH: a dollar record, BOTH kept beside the card’s row on this phone, and the screen says it holds dollars and bitcoin',
         JSON.stringify({ unit: c.state.record.unit, hold: (H.W.cardsKnown()[c.key] || {}).hold, only: a.state.fc.only }));
      ok(c.state.book && c.state.book.table.every((x) => x.state === 0), 'and nothing of it is told the card: its table is empty');
      // two pills from the moment set-up ends, each at nothing, though the card holds neither yet; SWAP greyed with its reason
      let vb = vals(a);
      ok(vb.fcPillRows.length === 2 && vb.fcPillRows[0].big === '0.00' && vb.fcPillRows[0].small === '\u20bf 0'
         && vb.fcPillRows[1].big === '0' && vb.fcPillRows[1].small === '$0.00 USD',
         'BOTH: two pills at once, $0.00 with \u20bf 0 under and \u20bf 0 with $0.00 under', JSON.stringify(vb.fcPillRows.map((x) => [x.big, x.small])));
      const swapB = vb.fcButtons.find((x) => x.label === 'SWAP');
      a.toasts.length = 0;
      swapB.tap();
      ok(swapB.dim === '0.38' && a.state.screen === 'flashcard' && a.toasts[0] === 'Put money on the card to swap.',
         'SWAP is offered, greyed, and says why while the card holds nothing', JSON.stringify([swapB.dim, a.toasts]));
      a.fcAdd();
      ok(a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'ADD WHICH TO THE CARD?' && !a.state.curBoth,
         'ADD FUNDS on it asks which currency, with no BOTH among them', a.state.screen);
      a.currencyPick('sat');
      ok(a.state.screen === 'amount' && a.state.flow === 'cardAdd' && a.fcUnit() === 'sat', 'bitcoin chosen: SET AMOUNT in bitcoin');
      a.setState({ amount: '2000', unit: 'SATS' });
      await a.refreshBalance();
      c.tap();
      a.fcAmountNext();
      await until('the PIN pad', () => !!pad(a));
      pad(a).type('1234');
      await until('the sats to go on', () => !(a._fcTaps > 0) && a.state.fc && a.state.fc.bal && a.state.fc.bal.sat >= 2000);
      await uiSettle();
      ok(a.state.fc.bal.sat >= 2000 && a.state.fc.bal.usd === 0 && a.state.fc.unit === 'usd', 'and sats go on a card whose record is dollars', JSON.stringify(a.state.fc.bal));
      vb = vals(a);
      ok(vb.fcPillRows.length === 2 && vb.fcPillRows[0].big === '0.00' && vb.fcPillRows[1].big === a.group(a.state.fc.bal.sat),
         'still two pills: the dollars at nothing, the sats as they are', JSON.stringify(vb.fcPillRows.map((x) => x.big)));
      const swapS = vb.fcButtons.find((x) => x.label === 'SWAP');
      ok(swapS.dim === (a.offlineNow() ? '0.38' : '1'), 'and SWAP is not greyed once one side holds something: it swaps into the empty one', swapS.dim);
      a.fcAdd();
      ok(a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'ADD WHICH TO THE CARD?', 'and ADD FUNDS asks again the next time');
      a.back();
    }

    /* BOTH holding $10.00 and ₿0 (the owner's card): SWAP is offered, opens from dollars into bitcoin, and the two taps swap part of the
     * dollars into sats on the empty side; the card then holds both. */
    {
      const a = screens();
      const c = newCard(H, undefined, { format: 4, software: 23 });
      await setUpAs(a, c, 2);
      await add(H, c, 1000, 'usd');
      c.tap();
      a.fcRead();
      await until('the card read with its dollars', () => !(a._fcTaps > 0) && a.state.fc && a.state.fc.bal && a.state.fc.bal.usd === 1000);
      await uiSettle();
      a.offlineNow = () => false;
      // the swap screen's own (26i-swap.js): its units and what the card has to swap; the rate is asked below, not probed
      Object.assign(a, new Function('return {' + [['26i-swap.js', 'swapUnits() {'], ['26i-swap.js', 'swapComing(u) {'], ['26i-swap.js', 'swapHave(u) {']]
        .map(([f, sig]) => liftFrom(f, sig)).join(',\n') + '}')());
      a.swapProbe = () => {};
      let v = vals(a);
      ok(v.fcPillRows.length === 2 && v.fcPillRows[0].big === '10.00' && v.fcPillRows[1].big === '0' && a.state.fc.bal.sat === 0,
         'BOTH with $10.00 and ₿0: two pills', JSON.stringify(v.fcPillRows.map((x) => x.big)));
      const sb = v.fcButtons.find((x) => x.label === 'SWAP');
      a.toasts.length = 0;
      ok(sb.dim === '1', 'SWAP is not greyed', sb.dim);
      sb.tap();
      ok(a.state.screen === 'swap' && a.state.swapFrom === 'usd' && a.state.swapTo === 'sat' && a.swapHave('usd') === 1000 && !a.toasts.length,
         'SWAP opens the swap screen from dollars into bitcoin, with the card’s $10.00 to swap', JSON.stringify([a.state.screen, a.state.swapFrom, a.toasts]));
      await uiSettle();
      const q = await H.W.swapQuote('usd', 'sat', 400, a.swapComing('usd'));
      ok(q && q.total > 0 && q.total <= 1000, 'the mint quotes the card’s dollars', JSON.stringify(q && q.total));
      c.tap();
      a.fcSwapGo(q);
      await until('the PIN pad', () => !!pad(a));
      pad(a).type('1234');
      await until('the dollars to come off', () => !!a._swapRun || a.state.screen === 'swapDone' || !!cardUp(a));
      c.tap();
      await until('the swap and the second tap', () => !(a._fcTaps > 0) && (a.state.screen === 'swapDone' || !!cardUp(a)));
      await uiSettle();
      ok(a.state.screen === 'swapDone' && !cardUp(a), 'SWAPPED: both taps made', JSON.stringify([a.state.screen, cardUp(a) && cardUp(a).all]));
      c.tap();
      const seen = await H.W.cardLook(c, { mine: true, price: PRICE });
      ok(seen.units.usd.balance > 0 && seen.units.usd.balance < 1000 && seen.units.sat.balance > 0,
         'the card holds both now: the dollars left and the sats the swap brought', JSON.stringify([seen.units.usd.balance, seen.units.sat.balance]));
      a.setState({ screen: 'flashcard', stack: [] });
      c.tap();
      a.fcRead();
      await until('the card read again', () => !(a._fcTaps > 0) && a.state.fc && a.state.fc.bal && a.state.fc.bal.sat > 0);
      await uiSettle();
      v = vals(a);
      ok(v.fcPillRows.length === 2 && v.fcPillRows[0].big !== '10.00' && v.fcPillRows[1].big !== '0',
         'and its screen shows both', JSON.stringify(v.fcPillRows.map((x) => x.big)));
      await settle();
    }

    /* BOTH with a no-PIN allowance: the ceiling is said for both currencies from the start. Read on another phone (one that did not set
     * it up), the card falls back to what it holds: one pill while it holds one currency, two once it holds both. */
    {
      const a = screens();
      const c = newCard(H, undefined, { format: 4, software: 23 });
      await toCurrency(a, c);
      cur(a).curCards[2].tap();
      cardUp(a).press('YES');
      a.setState({ amount: '2.00' });
      a.fcAmountNext();
      c.tap();
      cardUp(a).press('NO');
      await until('the card to be set up', () => !!c.state.owner && a.state.fc && a.state.fc.key === c.key && a.state.fc.ownedHere === true && !(a._fcTaps > 0));
      await uiSettle();
      const v = vals(a);
      ok(v.fcPillRows.length === 2 && / \u00b7 both currencies$/.test(limitsSub(v)), 'BOTH: two pills, and the ceiling under LIMITS says both currencies', limitsSub(v));
      const R = await funded({ units: ['sat', 'usd'], sharedMint: H.mint, words: OTHER_WORDS }, 0);
      const other = appOn(R, { screen: 'home' });
      other.price = PRICE;
      const readOn = async () => {
        R.nfc = c;
        c.tap();
        other.setState({ screen: 'home', stack: [], fc: null });
        other._fcCard = null;
        other.goFlashcard();
        await until('the card read on the other phone', () => !!other.state.fc && other.state.fc.key === c.key && !(other._fcTaps > 0));
        await uiSettle();
        return vals(other);
      };
      let vo = await readOn();
      ok(vo.fcPillRows.length === 1 && other.state.fc.ownedHere !== true, 'on a phone that did not set it up, a card that holds nothing yet shows one pill', String(vo.fcPillRows.length));
      await add(H, c, 1500, 'sat');
      await add(H, c, 250, 'usd');
      vo = await readOn();
      ok(vo.fcPillRows.length === 2 && vo.fcPillRows[0].big === '2.50' && vo.fcPillRows[1].big === '1,500', 'and two once it holds both', JSON.stringify(vo.fcPillRows.map((x) => x.big)));
    }

    // BITCOIN alone: never asked, refuses nothing the card can do, and dollars on it all the same make it a card of both
    {
      const a = screens();
      const c = newCard(H, undefined, { format: 4, software: 23 });
      await setUpAs(a, c, 1);
      ok(c.state.record.unit === 0 && (H.W.cardsKnown()[c.key] || {}).hold === 'sat' && a.state.fc.only === 'sat', 'BITCOIN: a bitcoin record, and BITCOIN kept for it on this phone',
         JSON.stringify({ unit: c.state.record.unit, hold: (H.W.cardsKnown()[c.key] || {}).hold, only: a.state.fc.only }));
      a.fcAdd();
      ok(a.state.screen === 'amount' && a.state.flow === 'cardAdd' && a.fcUnit() === 'sat' && !a.state.curCard, 'ADD FUNDS asks nothing: SET AMOUNT in bitcoin at once', a.state.screen);
      a.setState({ amount: '3000', unit: 'SATS' });
      await a.refreshBalance();
      c.tap();
      a.fcAmountNext();
      await until('the PIN pad', () => !!pad(a));
      pad(a).type('1234');
      await until('the sats to go on', () => !(a._fcTaps > 0) && a.state.fc && a.state.fc.bal && a.state.fc.bal.sat >= 3000);
      await uiSettle();
      ok(a.state.fc.bal.sat >= 3000 && a.state.fc.only === 'sat', 'and the sats go on, the card still one of bitcoin', JSON.stringify(a.state.fc.bal));
      // SEND > FLASHCARD from this phone's dollars, with no price to turn them into sats: refused before anything is made
      c.tap();
      const read = await H.W.cardLook(c, { mine: true, price: PRICE });
      let no = null;
      try { await a.fcSendPrepare(read, 300, 'usd', null); } catch (e) { no = e; }
      ok(no && no.card === 'wrong-unit' && no.cardUnit === 'sat' && /holds bitcoin, so it is loaded from your bitcoin/.test(no.message),
         'SEND of dollars to it is refused in words, nothing made', no && no.message);
      // typed in dollars with a price, it is loaded with their sats
      const made = await a.fcSendPrepare(read, 300, 'usd', { sats: 1000, have: 50000 });
      ok(made && made.unit === 'sat' && made.amount === 1000, 'SEND typed in dollars with a price puts their sats on it', JSON.stringify(made && [made.unit, made.amount]));
      c.tap();
      await H.W.cardWrite(c, { pin: '1234' });
      // the card itself is not bound: a payment from it, and dollars put on by the wallet asked for them
      const R = await funded({ units: ['sat', 'usd'], sharedMint: H.mint, words: OTHER_WORDS }, 0);
      const p = await pay(R, c, { sats: 100 });
      ok(!p.refused, 'it pays as any card does', JSON.stringify(p.refused));
      const d = await add(H, c, 300, 'usd');
      ok(d && d.amount === 300, 'and the card takes dollars when they are put on it all the same: the choice was this phone’s, not the card’s', JSON.stringify(d && d.amount));
      c.tap();
      a.fcRead();
      await until('the card read again', () => !(a._fcTaps > 0) && a.state.fc && a.state.fc.bal && a.state.fc.bal.usd === 300);
      await uiSettle();
      ok(a.state.fc.only === '' && H.W.cardHold(await (async () => { c.tap(); return H.W.cardLook(c, { mine: true, price: PRICE }); })()) === 'both',
         'holding dollars, it is read as a card of both', a.state.fc.only);
      a.fcAdd();
      ok(a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'ADD WHICH TO THE CARD?', 'and ADD FUNDS asks which');
      a.back();
      await settle();
      booksGood('the set-up’s currency', H, R);
    }

    // a card of 1.22: the two rows and the old words
    {
      const a = screens();
      const c = newCard(H, undefined, { format: 4, software: 22 });
      await toCurrency(a, c);
      const v = cur(a);
      ok(a.state.screen === 'currency' && v.curCards.map((x) => x.name).join() === 'DOLLARS,BITCOIN' && v.curCards.every((x) => x.badgePx === '92px' && x.labelShown === false && x.balance === '')
         && v.curFoot === 'A card holds one of them. To change it later, RESET the card and set it up again.',
         'a card of 1.22: DOLLARS and BITCOIN, and the old words', JSON.stringify([v.curCards.map((x) => x.name), v.curFoot]));
      v.curBack();
    }

    // a set-up for somebody else (SEND > FLASHCARD to a new card of 1.23) asks no currency: the card holds what is sent
    {
      const a = screens();
      const c = newCard(H, undefined, { format: 4, software: 23 });
      a.fcSendSetUp(500, 'sat', null, null);
      pad(a).type('1234');
      pad(a).type('1234');
      ok(a.state.screen !== 'currency' && cardUp(a) && cardUp(a).title === 'SMALL AMOUNTS', 'a set-up for the card’s holder goes from the PIN to SMALL AMOUNTS, no currency asked',
         a.state.screen + ' ' + (cardUp(a) && cardUp(a).title));
      void c;
    }
  }

  /* ---- 18: what the owner found trying the card screens (ADD FUNDS's PIN, SEND > FLASHCARD to a card of both, the card's SEND) ---- */
  if (want(18)) {
    const H = await funded({ units: ['sat', 'usd'] }, 50000);
    await fundUsd(H, 20000);
    const R = await funded({ units: ['sat', 'usd'], sharedMint: H.mint, words: OTHER_WORDS }, 0);
    const lifted = () => new Function('return {' + [['01-ui-basics.js', 'currencyPick(unit) {'], ['01-ui-basics.js', 'unitWord(unit) {'],
      ['01-ui-basics.js', 'unitFigure(amount, unit) {'], ['01-ui-basics.js', 'centsTyped() {']].map(([f, sig]) => liftFrom(f, sig)).join(',\n') + '}')();
    const phone = (o) => {
      const a = appOn(H, { screen: 'home' }, o);
      Object.assign(a, (o && o.send) ? {} : lifted());
      if (o && o.send) Object.assign(a, { currencyPick: lifted().currencyPick, unitWord: lifted().unitWord, unitFigure: lifted().unitFigure });
      a.price = PRICE;
      a.twoUnitsOn = () => true;
      a.unitBalance = (u) => (u === 'usd' ? 20000 : 50000);
      a.satUsd = () => PRICE / 1e8;
      return a;
    };
    const both = newCard(H, undefined, { format: 4, software: 23 });
    both.tap();
    await H.W.cardSetUp(both, { pin: '1234', unit: 'usd', hold: 'both', price: PRICE });
    const usdOnly = newCard(H, undefined, { format: 4, software: 23 });
    usdOnly.tap();
    await H.W.cardSetUp(usdOnly, { pin: '1234', unit: 'usd', hold: 'usd', price: PRICE });
    const readOn = async (a, c) => {
      H.nfc = c;
      c.tap();
      a.setState({ screen: 'home', stack: [], fc: null, curCard: null });
      a._fcCard = null;
      a.goFlashcard();
      await until('the card read', () => !!a.state.fc && a.state.fc.key === c.key && !(a._fcTaps > 0));
      await uiSettle();
    };

    // ADD FUNDS on a card of 1.21 and on asks the PIN, decided from the card just read, whatever the screen's figures say
    {
      const a = phone();
      await readOn(a, both);
      ok(a.state.fc.ownedHere === true && a.fcCardPinFirst() === true, 'the owner’s card of 1.23, just read: every load wants its PIN');
      delete a.state.fc.pinFirst;
      a.fcAddPin(300);
      ok(!!pad(a) && pad(a).title === 'CARD PIN' && /^ADD /.test(pad(a).cta), 'ADD FUNDS asks the PIN, with nothing of the screen’s to say so', pad(a) && pad(a).cta);
      pad(a).back();
      const was = a._fcCard;
      ok([['1.20', false], ['1.21', true], ['1.23', true], ['2.0', true], ['', true]].every(([ver, want]) => {
        a._fcCard = { info: { version: ver } };
        return a.fcCardPinFirst() === want;
      }) && (a._fcCard = null, a.fcCardPinFirst() === true), 'before 1.21 the owner’s proof loads; from 1.21, or where the card said no version, the PIN is asked');
      a._fcCard = was;
      // a load the card answers with "wants its PIN" where none was given: the PIN is asked, and what was made goes on with it
      a._fcFlowUnit = 'usd';
      both.tap();
      a.fcAddRun(250, '', true);
      await until('the PIN pad after the card asked for it', () => !!pad(a) && !(a._fcTaps > 0));
      ok(pad(a).title === 'CARD PIN' && /^PUT \$2\.50 ON CARD$/.test(pad(a).cta) && !cardUp(a), 'a load refused for want of the PIN asks the PIN, no refusal shown', pad(a).cta);
      both.tap();
      pad(a).type('1234');
      await until('the dollars to go on', () => !(a._fcTaps > 0) && !pad(a) && a.state.fc && a.state.fc.bal && a.state.fc.bal.usd === 250);
      ok(a.state.fc.bal.usd === 250 && (H.W.cardOwed() || []).length === 0, 'and they go on with it, nothing left owed and nothing made twice', JSON.stringify(a.state.fc.bal));
    }

    // SEND > FLASHCARD from home onto a card set up for both: in the currency the send was started in, or asked where it was not
    {
      const sendTo = async (c, wallet, amount, unit) => {
        const a = phone();
        a.walletNow = () => wallet;
        a.state.balUsdCents = 20000;
        await a.refreshBalance();
        a.setState({ screen: 'amount', stack: ['home', 'sendHow'], flow: 'cardSend', amount, unit });
        H.nfc = c;
        c.tap();
        a.fcAmountNext();
        await until('the sheet to end', () => !(a._fcTaps > 0) && (!!pad(a) || !!cardUp(a) || a.state.screen !== 'amount'));
        return a;
      };
      let a = await sendTo(both, 'sat', '500', 'SATS');
      ok(!!pad(a) && !cardUp(a), 'started in bitcoin, a card of both: no refusal, its PIN asked', cardUp(a) && cardUp(a).reason);
      both.tap();
      pad(a).type('1234');
      await until('the sats on the card', () => !(a._fcTaps > 0) && a.state.screen === 'home');
      both.tap();
      let look = await H.W.cardLook(both, { mine: true, price: PRICE });
      ok(look.units.sat.balance === 500 && look.units.usd.balance === 250, 'and the sats go on beside its dollars', JSON.stringify([look.units.sat.balance, look.units.usd.balance]));
      a = await sendTo(both, 'usd', '1.00', 'USD');
      both.tap();
      pad(a).type('1234');
      await until('the dollars on the card', () => !(a._fcTaps > 0) && a.state.screen === 'home');
      both.tap();
      look = await H.W.cardLook(both, { mine: true, price: PRICE });
      ok(look.units.usd.balance === 350 && look.units.sat.balance === 500, 'started in dollars, the dollars go on', JSON.stringify([look.units.sat.balance, look.units.usd.balance]));
      // not started in either, both of this phone's balances could pay: the card is read, and the CURRENCY screen asks which
      a = await sendTo(both, '', '1.00', 'USD');
      ok(a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'SEND WHICH TO THE CARD?' && !pad(a) && !cardUp(a),
         'not started in a currency: the card read, the CURRENCY screen asks which, nothing made yet', a.state.screen);
      a.currencyPick('sat');
      ok(a.state.screen === 'amount' && !!pad(a) && /1,000/.test(pad(a).sub), 'bitcoin chosen: its PIN, for the sats the dollars typed come to', pad(a) && pad(a).sub);
      both.tap();
      pad(a).type('1234');
      await until('the sats on the card', () => !(a._fcTaps > 0) && a.state.screen === 'home');
      both.tap();
      look = await H.W.cardLook(both, { mine: true, price: PRICE });
      ok(look.units.sat.balance === 1500 && look.units.usd.balance === 350, 'and they go on', JSON.stringify([look.units.sat.balance, look.units.usd.balance]));
      // a card its owner set up for dollars alone: the guard stays
      a = await sendTo(usdOnly, 'sat', '500', 'SATS');
      ok(!!cardUp(a) && /holds dollars, so it is loaded from your dollars/.test(cardUp(a).reason) && !pad(a), 'a card set up for dollars alone still refuses bitcoin, nothing made', cardUp(a) && cardUp(a).reason);
      // and not started in a currency, the one currency it holds, with nothing asked
      a = await sendTo(usdOnly, '', '1.00', 'USD');
      ok(a.state.screen !== 'currency' && !!pad(a) && /\$1\.00/.test(pad(a).sub), 'not started in a currency, a card of dollars alone is sent dollars, nothing asked', pad(a) && pad(a).sub);
      pad(a).back();
      await settle();
    }

    // SEND on the card's screen: the way to pay first, and which currency only on the confirmation, only where both could pay
    {
      const a = phone({ send: true });
      await readOn(a, both);
      ok(a.state.fc.bal.usd > 0 && a.state.fc.bal.sat > 0, 'a card that holds both');
      vals(a).fcSend();
      ok(a.state.screen === 'sendHow' && a.state.sendFrom === 'card' && !a.state.curCard && !a._fcFlowUnit, 'SEND opens the ways to pay, no currency asked first', a.state.screen);
      // a bill pasted on SEND MONEY in card mode, as tests/flashcard-send.js pastes one
      const bill = async (sats) => {
        a.acceptTarget('lnbc' + (sats * 10) + 'n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq');
        ok(a.state.screen === 'sendConfirm', 'the bill of ' + sats + ' sats on the confirmation', a.state.screen);
      };
      await bill(500);
      ok(a.fcOutUnitAsk() === true && a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'PAY FROM WHICH?',
         'a bill both could pay: PAY FROM WHICH? on the confirmation, once the bill is known', a.state.screen);
      a.currencyPick('usd');
      ok(a.state.screen === 'sendConfirm' && a._fcFlowUnit === 'usd' && a.fcUnit() === 'usd' && a.fcOutUnitAsk() === false, 'dollars chosen: back on the confirmation, paid in dollars');
      a.back();
      await bill(2000);
      ok(a.fcOutUnitAsk() === false && a.state.screen === 'sendConfirm' && a._fcFlowUnit === 'usd', 'a bill only the dollars cover: no question, the dollars', String(a._fcFlowUnit));
      a.back();
      // backed out of the question: back past the confirmation
      await bill(300);
      ok(a.fcOutUnitAsk() === true && a.state.screen === 'currency', 'asked again for another bill', a.state.screen);
      a.back();
      ok(a.state.screen === 'sendConfirm', 'backed out of PAY FROM WHICH?', a.state.screen);
      a.fcOutUnitAsk();
      ok(a.state.screen === 'sendHow', 'and the confirmation goes too: back to the ways to pay', a.state.screen);
      // WITHDRAW, the way to pay that is the card's own: its own question, asked once
      a.fcOutWithdraw();
      ok(a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'WITHDRAW WHICH?', 'WITHDRAW asks its own question, the only one', a.state.curCard && a.state.curCard.question);
    }
    await settle();
  }

  /* ---- 19: ADD FUNDS from the card's screen, as the owner pressed it: the PIN before the card is asked for, then one tap ---- */
  if (want(19)) {
    const H = await funded({ units: ['sat', 'usd'] }, 50000);
    await fundUsd(H, 20000);
    const lifted = new Function('return {' + [['01-ui-basics.js', 'currencyPick(unit) {'], ['01-ui-basics.js', 'unitWord(unit) {'],
      ['01-ui-basics.js', 'unitFigure(amount, unit) {'], ['01-ui-basics.js', 'centsTyped() {']].map(([f, sig]) => liftFrom(f, sig)).join(',\n') + '}')();
    const both = newCard(H, undefined, { format: 4, software: 23 });
    both.tap();
    await H.W.cardSetUp(both, { pin: '1234', unit: 'usd', hold: 'both', price: PRICE });
    const a = appOn(H, { screen: 'home' });
    Object.assign(a, lifted);
    a.price = PRICE;
    a.twoUnitsOn = () => true;
    a.unitBalance = (u) => (u === 'usd' ? 20000 : 50000);
    a.satUsd = () => PRICE / 1e8;
    a.state.balUsdCents = 20000;
    await a.refreshBalance();
    H.nfc = both;
    both.tap();
    a.goFlashcard();
    await until('the card read', () => !!a.state.fc && a.state.fc.key === both.key && !(a._fcTaps > 0));
    await uiSettle();
    ok(a.state.fc.ownedHere === true && a.state.fc.v123 === true, 'the owner’s card of 1.23, of both, read on its screen');
    // what is asked, in order: each card sheet and each PIN pad
    const asked = [];
    const tap = a.fcTap.bind(a), askPin = a.fcAskPin.bind(a);
    a.fcTap = (...x) => { asked.push('tap'); return tap(...x); };
    a.fcAskPin = (...x) => { asked.push('pin'); return askPin(...x); };
    a.fcAdd();
    ok(a.state.screen === 'currency', 'ADD FUNDS asks which', a.state.screen);
    a.currencyPick('usd');
    a.state.amount = '10.00';
    a.state.unit = 'USD';
    both.tap();
    a.fcAmountNext();
    await uiSettle();
    ok(asked[0] === 'pin' && !!pad(a) && /^ADD \$10\.00 TO CARD$/.test(pad(a).cta), 'NEXT: the PIN pad first, before the card is asked for', asked.join(' ') + ' | ' + (pad(a) && pad(a).cta));
    if (pad(a)) pad(a).type('1234');
    await until('the dollars on the card', () => !(a._fcTaps > 0) && !pad(a) && a.state.fc && a.state.fc.bal && a.state.fc.bal.usd === 1000);
    ok(asked.join(' ') === 'pin tap', 'and one tap writes it: no second tap, no PIN after it', asked.join(' '));
    ok(a.state.fc.bal.usd === 1000 && (H.W.cardOwed() || []).length === 0, 'the $10.00 is on the card, nothing left owed', JSON.stringify(a.state.fc.bal));
    /* The owner's own finding: ADD FUNDS's dollars made and left waiting for the card (CLOSE while they were being made, or a tap that
     * did not take), then "Press here, then tap it" on the card's screen. The card of 1.21 and on takes no load on its owner's proof
     * alone: its PIN is asked first, then one tap, and not a tap refused for want of it and a second one after the pad. */
    const waiting = async (cents, press) => {
      // the card's screen as the owner had it: CARD on home, the card read and known as this phone's own
      both.tap();
      a.setState({ screen: 'home', stack: [], fc: null });
      a.goFlashcard();
      await until('the card read again', () => !!a.state.fc && a.state.fc.key === both.key && !(a._fcTaps > 0));
      await uiSettle();
      await H.W.cardPrepare(a._fcCard, cents, { unit: 'usd' });
      ok((H.W.cardOwed() || []).length > 0, 'money waiting for the card: ' + press);
      asked.length = 0;
      ok(a.state.screen === 'flashcard' && a.state.fc.ownedHere === true, press + ': on the card’s screen, the card known as this phone’s');
      both.tap();
      if (press === 'the line on its screen') {
        const note = (vals(a).fcNotes || [])[0];
        ok(!!note && /waiting to go onto this card/.test(note.text), 'the card’s screen says it is waiting', note && note.text);
        if (note) note.tap();
      } else a.fcOutWrite();
      await uiSettle();
      ok(asked[0] === 'pin' && !!pad(a) && !(a._fcTaps > 0), press + ': the PIN pad first, no card asked for yet', asked.join(' '));
      if (pad(a)) pad(a).type('1234');
      await until('the waiting dollars on the card', () => !(a._fcTaps > 0) && !pad(a) && (H.W.cardOwed() || []).length === 0);
      await uiSettle();
      ok(asked.join(' ') === 'pin tap', press + ': and one tap puts it on', asked.join(' '));
    };
    await waiting(250, 'the line on its screen');
    await waiting(150, 'TAP CARD on NOT PAID');
    ok(a.state.fc.bal.usd === 1400, 'all of it on the card', JSON.stringify(a.state.fc.bal));
    await settle();
  }

  console.log(failed ? failed + ' flashcard-units check(s) failed, ' + passed + ' passed' : 'all flashcard-units checks pass (' + passed + ')');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });

// what the card counts a sats payment's whole as, in cents, at its rate (the allowance counts the whole of the pieces)
function toC(state, sats) { return Math.ceil(sats * 100 / state.rate); }
