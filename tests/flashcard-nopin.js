'use strict';
/* flashcard-nopin.js — card software 1.16: the PIN is optional, and a no-PIN allowance per day.
 *
 *     node tests/flashcard-nopin.js
 *
 * Until 1.16 a card had a PIN from set-up and every payment, load and owner's flow of a card with one asked for it. From 1.16 a
 * card may have none, and it then pays without one (its limits on one tap and in a day still hold). A card with a PIN may carry a
 * NO-PIN ALLOWANCE: how many sats a day it signs for without the PIN, in the day's own window, counting only what was signed for that
 * way. Over it, the card refuses the signature (6A94) and the PIN is wanted for the WHOLE payment; with the PIN the payment is as it
 * ever was. A PIN can be added later by the owner (ADD PIN), and then the allowance is nothing until the owner sets one.
 *
 * The card here is the model (tests/flashcard-card.js), which answers as the applet does (tests/flashcard-model.js). What is checked is
 * the card's rules as the model has them, and the wallet's side: what it reads (`card.noPin`, `cardNeedsPin`), what it asks for, the
 * `pin-needed` it rejects with (before the card is asked, or at its 6A94 with nothing left pending), set-up with no PIN, ADD PIN, the
 * allowance and its dollars, the log's flag, and a card of 1.15, which must keep asking for its PIN.
 */
const { funded, newCard, why, settle, binaryLoad, MINT, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const count = (card, ins) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + ins).length;
const swaps = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.swaps') || '[]');
const taken = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.taken') || '[]');
const DAY = 86400;
const SEL = '00a4040009f0464f58594341524400';
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);

/* A till (R) and a holder (H), who share a mint, and a card the holder set up: with a PIN of 1234 (`pin`), or none. 2,000 sats on it. */
async function world(pin, o) {
  const opts = o || {};
  const H = await funded({}, 9000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H, undefined, Object.assign({ format: 4 }, opts.card || {}));
  await H.W.cardSetUp(card, pin ? { pin, recoverable: true } : { recoverable: true });
  card.tap();
  if (opts.sats !== 0) { await H.W.cardAdd(card, { sats: opts.sats || 2000, owner: true }); card.tap(); }
  return { H, R, card };
}

(async () => {
  /* ---- 1: what the card says, and what the wallet makes of it ------------------------------------------------------- */
  {
    const W = (await funded({}, 0)).W;
    const longInfo = (limit, spent, now, begun, pin) => '01' + '10' + '80' + '00' + '00' + '80' + 'ff' + (pin ? '01' : '00') + '04' + '03' + '00' + '01'
      + u32(0) + '01' + u32(now) + u32(begun) + u32(0) + '00' + u32(0) + u32(limit) + u32(spent);
    const info = W.cardParse.info(longInfo(500, 120, 1000, 900, true));
    ok(info.version === '1.16' && info.noPinKnown === true && info.noPin.limit === 500 && info.noPin.spent === 120 && info.pinSet === true && info.pin === 'set' && info.setUp === true,
       'GET_INFO of 1.16 says the allowance and what is spent of it, in bytes 34 to 41', JSON.stringify(info.noPin));
    ok(info.tapStart === 0 && info.tapSpent === 0, 'which are where a card before it kept the tap window’s start and count, and are not read as them now');
    const old = W.cardParse.info(longInfo(500, 120, 1000, 900, true).replace(/^0110/, '010f'));
    ok(old.noPinKnown === false && old.noPin.limit === 0 && old.noPin.spent === 0 && old.pinSet === true, 'a card of 1.15 has no allowance; those bytes are what they were', JSON.stringify(old.noPin));
    ok(W.cardParse.noPin(old).known === false && W.cardParse.noPin(old).set === false, 'and reads as one with none to set');
    const none = W.cardParse.info(longInfo(0, 0, 1000, 900, false));
    ok(none.pin === 'none' && none.pinSet === false && none.hasRecord === true && none.setUp === true, 'a card of 1.16 with a record and no PIN is set up', JSON.stringify([none.pin, none.hasRecord, none.setUp]));
    const before = W.cardParse.info(longInfo(0, 0, 1000, 900, false).replace(/^0110/, '010f'));
    ok(before.setUp === false, 'and a card before it with a record and no PIN is not (it had a PIN before it had a record)');

    // the allowance over the day's window, as the daily limit is read
    const day = (i) => W.cardParse.noPin(W.cardParse.info(i));
    const within = day(longInfo(500, 120, 1000, 900, true));
    ok(within.set && within.limit === 500 && within.spent === 120 && within.left === 380 && within.turns === 900 + DAY, 'inside the window: what is left is the allowance less what was spent', JSON.stringify(within));
    const over = day(longInfo(500, 120, 900 + DAY, 900, true));
    ok(over.set && over.spent === 0 && over.left === 500 && over.turns === 0, 'a window that is over counts from nothing: the whole allowance is left', JSON.stringify(over));
    const trust = day(longInfo(500, 120, 0, 0, true));
    ok(trust.set && trust.onTrust === true && trust.spent === 120 && trust.left === 380 && trust.turns === 0, 'with no block header yet the window has no start and does not end: the count runs from set-up', JSON.stringify(trust));
    const spentUp = day(longInfo(500, 700, 1000, 900, true));
    ok(spentUp.left === 0, 'and never less than nothing');
    const unset = day(longInfo(0, 0, 1000, 900, true));
    ok(unset.set === false && unset.left === 0, 'no allowance is none', JSON.stringify(unset));

    // whether the card will ask for the PIN
    const card = (np, pin) => ({ info: W.cardParse.info(longInfo(np.limit, np.spent, 1000, 900, pin)), noPin: day(longInfo(np.limit, np.spent, 1000, 900, pin)) });
    ok(W.cardNeedsPin(card({ limit: 0, spent: 0 }, false), 50000) === false, 'a card with no PIN never asks for one, whatever the payment');
    ok(W.cardNeedsPin(card({ limit: 0, spent: 0 }, true), 1) === true, 'a card with a PIN and no allowance asks for it for any payment');
    ok(W.cardNeedsPin(card({ limit: 500, spent: 120 }, true), 380) === false && W.cardNeedsPin(card({ limit: 500, spent: 120 }, true), 381) === true,
       'with an allowance it asks only when the payment is more than is left of it: the whole payment, never a part');
    ok(W.cardNeedsPin({ info: Object.assign({}, W.cardParse.info(longInfo(500, 0, 1000, 900, true)), { pin: 'blocked' }), noPin: day(longInfo(500, 0, 1000, 900, true)) }, 1) === true, 'a blocked card asks (and the card refuses the PIN: it is blocked)');
    ok(W.cardNeedsPin({ info: W.cardParse.info(longInfo(500, 0, 1000, 900, true).replace(/^0110/, '010f')) }, 1) === true, 'a card of 1.15 asks for its PIN for everything');
  }

  /* ---- 2: the card's own rules, as the model has them (the bytes) ----------------------------------------------------- */
  {
    const P = await funded({}, 0);
    const c = newCard(P, undefined, { format: 4 });
    const read = async (apdu) => { const r = await c.send(apdu); return { sw: r.slice(-4), data: r.slice(0, -4) }; };
    ok((await c.send(SEL)) === '01119000', 'the latest card says 1.17 when chosen');
    const sixteen = newCard(P, undefined, { format: 4, software: 16 });
    ok((await sixteen.send(SEL)) === '01109000', 'and a card of 1.16 (`software: 16`) says 1.16');
    const fresh = await read('b001010000');
    ok(fresh.sw === '9000' && fresh.data.length === 84 && fresh.data.slice(68) === '0000000000000000' && fresh.data.substr(14, 2) === '00',
       'GET_INFO P1=1 is 42 bytes; on a new card there is no PIN (byte 7) and bytes 34 to 41 are nothing', fresh.data.slice(0, 20) + ' ... ' + fresh.data.slice(60));
    // the allowance and its count are said to anybody: set them in the model, and a reader with no proof and no PIN sees them
    c.state.noPinLimit = 5000; c.state.noPinSpent = 1234;
    const said = await read('b001010000');
    ok(said.data.slice(68, 76) === u32(5000) && said.data.slice(76, 84) === u32(1234), 'and are the allowance and the count, big-endian, to a reader that has proved nothing', said.data.slice(68));
    const asOld = newCard(P, undefined, { format: 4, software: 15 });
    await asOld.send(SEL);
    asOld.state.noPinLimit = 5000;
    ok((await asOld.send('b001010000')).slice(68, 84) === '0000000000000000', 'a card of 1.15 says nothing there');
    // ADD PIN is the owner's: refused with no grant, and with a PIN already; allowed with the grant on a card with none
    const own = newCard(P, undefined, { format: 4 });
    await own.send(SEL);
    own.state.owner = '04' + '11'.repeat(64);
    ok((await own.send('b0410000' + '04' + '31323334')) === '6a91' && own.state.pinState === 0, 'ADD PIN on a card with an owner and no grant in the tap is refused, 6A91');
    own.state.grant = true;
    ok((await own.send('b0410000' + '04' + '31323334')) === '9000' && own.state.pinState === 1 && own.state.pin === '31323334', 'with the owner’s grant in the tap it is allowed');
    ok((await own.send('b0410000' + '04' + '35363738')) === '6a91' && own.state.pin === '31323334', 'and not again once there is a PIN');
    own.state.slots[0] = { status: 1, data: '00'.repeat(81) };
    own.state.pinState = 0; own.state.pin = null;
    ok((await own.send('b0410000' + '04' + '31323334')) === '9000', 'a card that holds money takes a PIN so (a new PIN is the point of it)');
    // a payment is begun with no PIN, and the card looks at the PIN where it signs
    const pay = newCard(P, undefined, { format: 4 });
    await pay.send(SEL);
    pay.state.pinState = 1; pay.state.pin = '31323334';
    pay.state.slots[0] = { status: 1, data: '00'.repeat(4) + '00'.repeat(4) + '00000040' + '00'.repeat(69) };
    ok((await pay.send('b0220000' + '01' + '00')).slice(-4) === '9000' && pay.state.all !== null, 'with a PIN set and none shown, BEGIN is taken');
    ok((await pay.send('b024000040')) === '6a94' && pay.state.all === null && pay.state.log.refused === 0 && pay.state.log.tampers === 0 && pay.state.log.taps === 0,
       'and SIGN is 6A94, which gives the payment up and writes nothing in the log');
    // a blocked PIN has no allowance: the beginning is taken (no PIN is asked there) and the signature is refused all the same
    pay.state.pinState = 2; pay.state.noPinLimit = 5000;
    ok((await pay.send('b0220000' + '01' + '00')).slice(-4) === '9000' && (await pay.send('b024000040')) === '6a94', 'a blocked card signs nothing with no PIN, whatever allowance it had: 6A94');
    // before the limits: a reader with no PIN writes no refusal in the log, whatever it asks for
    pay.state.pinState = 1; pay.state.noPinLimit = 0; pay.state.record.limit = 10;
    await pay.send('b0220000' + '01' + '00');
    ok((await pay.send('b024000040')) === '6a94' && pay.state.log.refused === 0, 'and the PIN is asked before the limits are: a payment over the day’s limit, with no PIN, is 6A94 and nothing in the log');
    pay.state.pin = '31323334'; pay.state.pinState = 1;
    await pay.send('b0400000' + '04' + '31323334');
    await pay.send('b0220000' + '01' + '00');
    ok((await pay.send('b024000040')).slice(-4) === '6a8f' && pay.state.log.refused === 1, 'with the PIN shown it is the limit that refuses it, 6A8F, and the log writes that');
  }

  /* ---- 3: set-up with no PIN: a record and an owner, in one tap -------------------------------------------------------- */
  {
    const H = await funded({}, 0);
    const card = newCard(H, undefined, { format: 4 });
    const made = await H.W.cardSetUp(card, { recoverable: true });
    const ins = card.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));
    const at = ins.lastIndexOf('32');
    ok(made.info.pin === 'none' && made.info.hasRecord && made.info.owner === true && made.info.setUp === true && made.record.mint === MINT,
       'a card set up with no PIN has its record and its owner and no PIN', JSON.stringify([made.info.pin, made.info.hasRecord, made.info.owner]));
    ok(!ins.includes('41') && !ins.includes('40') && at >= 0 && ins.slice(at, at + 2).join() === '32,43', 'in the order record, owner: no PIN is set or shown', ins.slice(-6).join());
    ok(made.noPin.known === true && made.noPin.set === false && made.noPin.left === 0, 'and has no allowance: nothing asks for one');
    card.tap();
    ok((await why(H.W.cardSetUp(card, { recoverable: true }))) === 'set-up', 'it is not set up twice');
    // 12 bytes with an allowance on a card with no PIN: the card says no
    card.tap();
    ok((await why(H.W.cardSetLimit(card, { noPin: 100 }))) === 'no-pin', 'the wallet will not set an allowance on a card with no PIN, and says so');
    // the card refuses an allowance when it has no PIN, 6985, if it were asked (the wallet is told it has one, here, and asks)
    card.tap();
    const lying = { send: async (a) => {
      const r = await card.send(a);
      return (a.slice(0, 6) === 'b00101' && r.length === 88) ? r.slice(0, 14) + '01' + r.slice(16) : r;
    } };
    const refused = await H.W.cardSetLimit(lying, { noPin: 100 }).then(() => null, (e) => e);
    ok(refused && refused.card === 'refused' && refused.sw === '6985' && card.state.noPinLimit === 0, 'asked all the same, the card refuses an allowance with no PIN, 6985, and sets nothing', refused && refused.sw);
    // a card that has a PIN left from a set-up cut off cannot be set up again without it
    const cut = newCard(H, undefined, { format: 4 });
    await cut.send(SEL);
    cut.state.pin = '31323334'; cut.state.pinState = 1;
    cut.tap();
    ok((await why(H.W.cardSetUp(cut, { recoverable: true }))) === 'has-pin', 'a card that already has a PIN is not set up without it');
    // a card before 1.16 cannot be without one
    const old = newCard(H, undefined, { format: 4, software: 15 });
    ok((await why(H.W.cardSetUp(old, { recoverable: true }))) === 'old-card', 'a card of 1.15 cannot be set up without a PIN');
  }

  /* ---- 4: a card with no PIN pays with none, and its limits hold ------------------------------------------------------ */
  {
    const { H, R, card } = await world(null);
    card.sent.length = 0;
    const steps = [];
    const paid = await R.W.cardPay(card, { sats: 500, on: (s) => steps.push(s) });
    ok(paid.sats === 500 && (await bal(R)) === 500 && card.balance() === 1500, 'a card with no PIN pays 500 sats with no PIN typed', (await bal(R)) + ', card ' + card.balance());
    ok(count(card, '40') === 0 && count(card, '24') === 1, 'no PIN is shown to the card, and one signature is asked', card.sent.map((a) => a.slice(2, 4)).join(' '));
    ok(steps[0] === 'reading', 'the sheet goes on as it ever did', steps.join(' '));
    // its entry in the card's own log says it was signed for with no PIN
    card.tap();
    const mine = await H.W.cardLook(card, { mine: true });
    ok(mine.log && mine.log.last.length >= 1 && mine.log.last[0].sats >= 500 && mine.log.last[0].noPin === false && mine.log.last[0].refused === 0,
       'and its log marks nothing for it: a card with no PIN has no PIN to be without (the mark is for the allowance)', JSON.stringify(mine.log && mine.log.last[0]));
    // the limits hold
    card.tap();
    await H.W.cardSetLimit(card, { sats: 700 });
    card.tap();
    const dayOk = await R.W.cardPay(card, { sats: 300 });
    card.tap();
    const over = await why(R.W.cardPay(card, { sats: 600 }));
    ok(dayOk.sats === 300 && over === 'limit', 'the daily limit holds with no PIN: 300 of 700 is paid, and 600 more is over it', over);
    card.tap();
    await H.W.cardSetLimit(card, { sats: 0 });
    card.tap();
    await H.W.cardSetLimit(card, { sats: 200, tap: true });
    card.tap();
    const waits = [];
    const slow = await R.W.cardPay(card, { sats: 500, progress: (q) => { if (q.step === 'waiting') waits.push(q); } });
    ok(slow.sats === 500 && waits.length > 0 && card.state.log.sats > 0, 'and so does the limit on one tap: a payment over it waits, with no PIN as with one', waits.length + ' notes');
    // the owner's flows work on it: top up with the grant, take it all off
    card.tap();
    const added = await H.W.cardAdd(card, { sats: 300, owner: true });
    ok(added.card.balance > 0, 'its owner tops it up with the grant', String(added.card.balance));
    // and so does anyone: a card with no PIN is anyone's to fill, as it is anyone's to spend
    card.tap();
    const before = card.balance();
    const topped = await R.W.cardAdd(card, { sats: 100 });
    ok(topped.card.balance >= before + 100 && card.balance() >= before + 100, 'another phone tops it up with no PIN and no grant', String(card.balance()));
    card.tap();
    const hb = await bal(H);
    const off = await H.W.cardWithdraw(card, {});
    ok(off.sats > 0 && (await bal(H)) === hb + off.sats && card.balance() === 0, 'and takes it all off, with no PIN typed', String(off.sats));
    await settle();
  }

  /* ---- 5: ADD PIN: the owner's grant, then the PIN sealed; every payment asks for it until an allowance is set ----------- */
  {
    const { H, R, card } = await world(null);
    card.sent.length = 0;
    const withPin = await H.W.cardAddPin(card, { pin: '4321' });
    const ins = card.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));
    ok(withPin.info.pin === 'set' && withPin.info.pinSet === true && withPin.mine === true && withPin.noPin.set === false && withPin.balance === 2000,
       'a PIN added to a card that held 2,000 sats: it has one now, and the money stayed', JSON.stringify([withPin.info.pin, withPin.balance]));
    ok(ins.includes('45') && ins.includes('41') && ins.indexOf('45') < ins.lastIndexOf('41'), 'with the owner’s grant first, then the PIN', ins.join(' '));
    ok(!card.sent.some((a) => a.slice(0, 4) === 'b041' && a.indexOf('34333231') >= 0) && card.sent.some((a) => a.slice(0, 8) === 'b0410100'), 'and the PIN went sealed: it is in no command in the clear');
    ok(card.state.noPinLimit === 0, 'the allowance is nothing: every payment asks for the PIN');
    card.tap();
    ok((await why(H.W.cardAddPin(card, { pin: '4321' }))) === 'has-pin', 'a card with a PIN has none to add (that is CHANGE PIN)');
    ok((await why(H.W.cardAddPin(card, { pin: '12' }))) === 'bad-pin', 'a PIN of two digits is refused');
    // a payment with no PIN: said before the card is asked for anything
    card.tap();
    card.sent.length = 0;
    const early = await R.W.cardPay(card, { sats: 100 }).then(() => null, (e) => e);
    ok(early && early.card === 'pin-needed' && early.early === true && early.set === false && count(card, '22') === 0 && count(card, '24') === 0 && count(card, '40') === 0,
       'a payment with no PIN is stopped by the read: pin-needed, early, before the card is asked to begin one', early && (early.card + ' ' + card.sent.map((a) => a.slice(2, 4)).join(' ')));
    ok(swaps(R).length === 0 && taken(R).length === 0 && card.balance() === 2000 && (await bal(R)) === 0, 'with nothing pending anywhere');
    // at a till, in a sheet: it ends saying the PIN is wanted, as a sheet's note and not as an error
    R.nfc = card;
    R.sheet.length = 0;
    const sheeted = await R.W.cardSession('Hold the card to the top of the phone', (link) => R.W.cardPay(link, { sats: 100 })).then(() => null, (e) => e);
    ok(sheeted && sheeted.card === 'pin-needed' && R.sheet[R.sheet.length - 1] === 'end: Enter the card’s PIN' && R.sheet.filter((l) => /^error/.test(l)).length === 0,
       'in the till’s sheet it ends saying so (a note, not an error): Enter the card’s PIN', R.sheet.join(' | '));
    card.tap();
    const paid = await R.W.cardPay(card, { sats: 100, pin: '4321' });
    ok(paid.sats === 100 && (await bal(R)) === 100 && card.balance() === 1900, 'and with the PIN it pays', String(card.balance()));
    card.tap();
    const pro = await H.W.cardLook(card, { mine: true });
    ok(pro.log.last[0].noPin === false, 'a payment made with the PIN is not marked no-PIN in the log');
    // another phone cannot add one (and it costs nothing)
    const W2 = await world(null, { sats: 0 });
    W2.card.tap();
    ok((await why(R.W.cardAddPin(W2.card, { pin: '4321' }))) === 'not-owner' && W2.card.state.pinState === 0, 'a phone that is not the owner is refused, and the card stays as it was');
    // and a card of 1.15 is not given one this way
    const old = newCard(H, undefined, { format: 4, software: 15 });
    await H.W.cardSetUp(old, { pin: '1234', recoverable: true });
    old.tap();
    ok((await why(H.W.cardAddPin(old, { pin: '4321' }))) === 'old-card', 'a card of 1.15 has none to add');
    await settle();
  }

  /* ---- 6: the allowance: within it the card signs with no PIN; over it, 6A94 and the PIN for the whole payment ------------ */
  {
    const { H, R, card } = await world('1234');
    card.tap();
    // the owner sets an allowance of 500 sats: the twelve bytes, with the day's and the tap's as the card has them
    card.sent.length = 0;
    const set = await H.W.cardSetLimit(card, { sats: 500, noPin: true, usd: 0 });
    const cmd = card.sent.filter((a) => a.slice(0, 4) === 'b034')[0];
    ok(set.noPin.set && set.noPin.limit === 500 && set.noPin.left === 500 && card.state.noPinLimit === 500 && cmd && (parseInt(cmd.substr(8, 2), 16) - 1 - parseInt(cmd.substr(10, 2), 16)) === 12,
       'the owner sets an allowance of 500: one SET_LIMIT_OWNER, twelve bytes under the proof', JSON.stringify(set.noPin));
    ok(card.state.record.limit === 0 && card.state.tapLimit === 0, 'with the day’s limit and the tap’s as they were');
    card.tap();
    // 300 sats with no PIN: within it
    card.sent.length = 0;
    const one = await R.W.cardPay(card, { sats: 300 });
    ok(one.sats === 300 && (await bal(R)) === 300 && count(card, '40') === 0 && card.state.noPinSpent === 300,
       'a payment of 300 within the allowance is signed with no PIN, and the card counts it: 300 of 500', 'spent ' + card.state.noPinSpent);
    card.tap();
    const seen = await R.W.cardLook(card, { noAuth: true });
    ok(seen.noPin.set && seen.noPin.limit === 500 && seen.noPin.spent === 300 && seen.noPin.left === 200 && seen.info.noPin.spent === 300,
       'and any phone reads it: 200 left today, said to a till as to anybody', JSON.stringify(seen.noPin));
    // 300 more: more than is left; the wallet knows from the read
    card.tap();
    card.sent.length = 0;
    const early = await R.W.cardPay(card, { sats: 300 }).then(() => null, (e) => e);
    ok(early && early.card === 'pin-needed' && early.early === true && early.set === true && early.left === 200 && count(card, '22') === 0,
       'a payment of 300 is more than the 200 left: pin-needed before the card is asked, saying what is left', early && JSON.stringify([early.card, early.need, early.left]));
    // never split: the card has 200 left, and 150 + 150 are two payments, each its own
    card.tap();
    const part = await R.W.cardPay(card, { sats: 150 });
    ok(part.sats === 150 && card.state.noPinSpent === 450, 'a smaller payment of 150 is within what is left, and counts');
    // the PIN for the whole payment: a payment over the allowance with the PIN is as it ever was, and counts nothing against it
    card.tap();
    const big = await R.W.cardPay(card, { sats: 600, pin: '1234' });
    ok(big.sats === 600 && card.state.noPinSpent === 450 && (await bal(R)) === 1050, 'with the PIN a payment of 600 goes, and only what was signed for with no PIN counts against the allowance', 'spent ' + card.state.noPinSpent);
    card.tap();
    const mine = await H.W.cardLook(card, { mine: true });
    const marks = mine.log.last.map((x) => x.noPin);
    ok(marks.slice(0, 3).join() === 'false,true,true', 'the log marks the taps made with no PIN, newest first', marks.join());
    await settle();
  }

  /* ---- 7: the card's own word: 6A94 clears the payment; the wallet rejects with pin-needed and nothing pending ---------- */
  {
    const { H, R, card } = await world('1234');
    card.tap();
    await H.W.cardSetLimit(card, { sats: 100, noPin: true });
    card.tap();
    // a link that tells the wallet the allowance is bigger than it is, so that the card is asked and answers for itself
    const lying = { send: async (a) => {
      const r = await card.send(a);
      if (a.slice(0, 6) === 'b00101' && r.length === 88) return r.slice(0, 68) + u32(100000) + r.slice(76);
      return r;
    } };
    card.sent.length = 0;
    const logBefore = JSON.stringify([card.state.log.refused, card.state.log.tampers, card.state.log.run]);
    const e = await R.W.cardPay(lying, { sats: 300 }).then(() => null, (x) => x);
    ok(e && e.card === 'pin-needed' && e.sw === '6a94' && !e.early, 'the card’s own 6A94 at the signature is pin-needed, as the read’s word is', e && JSON.stringify([e.card, e.sw, e.early]));
    ok(count(card, '22') === 1 && count(card, '24') === 1 && count(card, '40') === 0, 'the card was begun and asked to sign, and shown no PIN', card.sent.map((a) => a.slice(2, 4)).join(' '));
    ok(card.state.all === null && card.balance() === 2000 && card.state.slots.every((x) => x.status !== 2), 'it signed nothing and gave the payment up: nothing burned, nothing pending on the card', String(card.balance()));
    ok(swaps(R).length === 0 && taken(R).length === 0 && R.W.cardAskedOpen() === 0 && R.W.cardOwed().length === 0 && (await bal(R)) === 0, 'and nothing is pending on the till: no row asked for, none taken, none owed');
    ok(logBefore === JSON.stringify([card.state.log.refused, card.state.log.tampers, card.state.log.run]) && card.state.noPinSpent === 0, 'the refusal is nothing in the card’s log (not a refusal over a limit, not a tamper) and counts against nothing');
    // again, with the PIN: the same payment goes
    card.tap();
    const paid = await R.W.cardPay(card, { sats: 300, pin: '1234' });
    ok(paid.sats === 300 && (await bal(R)) === 300, 'and the second tap, with the PIN, pays it', String(await bal(R)));
    // a wrong PIN is a wrong PIN, and costs a try
    card.tap();
    const wrong = await R.W.cardPay(card, { sats: 300, pin: '9999' }).then(() => null, (x) => x);
    ok(wrong && wrong.card === 'wrong-pin' && wrong.tries === 2, 'a wrong PIN is as ever: said, with the tries left');
    await settle();
  }

  /* ---- 8: the day's window: shared with the daily limit; turns both counts; begins at the first spend on the allowance alone -- */
  {
    const { H, R, card } = await world('1234');
    // a clock: the card is told a time directly (as a block header would), the window not begun
    card.tap();
    await H.W.cardSetLimit(card, { sats: 400, noPin: true });
    ok(card.state.noPinLimit === 400 && card.state.windowStart === 0 && card.state.now === 0, 'an allowance set before the card has seen a block header has a window with no start');
    card.tap();
    await R.W.cardPay(card, { sats: 250 });
    ok(card.state.noPinSpent === 250 && card.state.windowStart === 0, 'it counts from set-up: 250 spent, the window still without a start', JSON.stringify([card.state.noPinSpent, card.state.windowStart]));
    card.tap();
    const trust = await R.W.cardLook(card, { noAuth: true });
    ok(trust.noPin.onTrust === true && trust.noPin.left === 150, 'and the wallet reads the day as on trust: 150 left');
    // a header arrives: the window begins at it, and the count stays (fails toward asking for the PIN)
    card.state.now = 1700000000; card.state.windowStart = 1700000000;
    card.tap();
    const next = await R.W.cardLook(card, { noAuth: true });
    ok(next.noPin.spent === 250 && next.noPin.left === 150 && next.noPin.turns === 1700000000 + DAY, 'a window begun by a header keeps the count', JSON.stringify(next.noPin));
    // the day turns: the allowance is whole again
    card.state.now = 1700000000 + DAY + 5;
    card.tap();
    const turned = await R.W.cardLook(card, { noAuth: true });
    ok(turned.noPin.spent === 0 && turned.noPin.left === 400, 'the day turns: both counts are nothing, as the wallet reads it', JSON.stringify(turned.noPin));
    card.tap();
    await R.W.cardPay(card, { sats: 100 });
    ok(card.state.noPinSpent === 100 && card.state.windowStart === 1700000000 + DAY + 5 && card.state.spent === 0,
       'and the first spend of the new day begins its window and counts from nothing: 100 spent', JSON.stringify([card.state.noPinSpent, card.state.windowStart]));
    // a daily limit shares the window: the two counts go to nothing together
    card.tap();
    await H.W.cardSetLimit(card, { sats: 1000 });
    ok(card.state.windowStart === card.state.now && card.state.noPinSpent === 0, 'a daily limit that is set begins the window again, and with it the allowance’s count');
    card.tap();
    await R.W.cardPay(card, { sats: 150 });
    card.tap();
    await H.W.cardSetLimit(card, { sats: 1000, tap: true });
    ok(card.state.spent === 150 && card.state.noPinSpent === 150, 'a limit on one tap set leaves the window and both counts', JSON.stringify([card.state.spent, card.state.noPinSpent]));
    card.tap();
    await H.W.cardSetLimit(card, { sats: 300, noPin: true });
    ok(card.state.spent === 150 && card.state.noPinLimit === 300 && card.state.noPinSpent === 0, 'an allowance changed keeps the window and the day’s count, and counts from nothing itself', JSON.stringify([card.state.spent, card.state.noPinSpent]));
    card.tap();
    await H.W.cardSetLimit(card, { sats: 300, noPin: true });
    card.tap();
    await R.W.cardPay(card, { sats: 200 });
    card.tap();
    await H.W.cardSetLimit(card, { sats: 300, noPin: true });
    ok(card.state.noPinSpent === 200, 'and an allowance set to the number it has keeps its count');
    // the daily limit applies to a no-PIN payment as to any
    card.tap();
    const limit = await why(R.W.cardPay(card, { sats: 101 }));
    ok(limit === 'pin-needed', 'a payment of 101 with 100 left of the allowance asks for the PIN first', limit);
    card.tap();
    await H.W.cardSetLimit(card, { sats: 400 });
    card.tap();
    const dayOver = await why(R.W.cardPay(card, { sats: 500, pin: '1234' }));
    ok(dayOver === 'limit', 'and the daily limit holds for a payment made with the PIN', dayOver);
    await settle();
  }

  /* ---- 9: the dollars: an allowance set in dollars follows the price -------------------------------------------------- */
  {
    const D = await world('1234');
    D.card.tap();
    // $1.00 at $100,000 a bitcoin is 1,000 sats
    await D.H.W.cardSetLimit(D.card, { sats: 1000, noPin: true, usd: 1 });
    ok(D.H.W.cardNoPinUsd(D.card.key) === 1 && D.H.W.cardPaceUsd(D.card.key) === 0, 'an allowance set in dollars is kept in dollars on the phone that set it, apart from the limit on one tap’s');
    D.card.tap();
    await D.H.W.cardSetLimit(D.card, { sats: 800, tap: true, usd: 0.8 });
    ok(D.H.W.cardNoPinUsd(D.card.key) === 1 && D.H.W.cardPaceUsd(D.card.key) === 0.8, 'both are kept, each in its own: setting one leaves the other’s dollars');
    D.card.tap();
    D.card.sent.length = 0;
    const same = await D.H.W.cardLook(D.card, { mine: true, price: 101000 });
    ok(same.info.noPin.limit === 1000 && !same.repacedNoPin && count(D.card, '34') === 0, 'a price that has moved a little leaves the card as it is', String(same.info.noPin.limit));
    D.card.tap();
    const moved = await D.H.W.cardLook(D.card, { mine: true, price: 80000 });
    ok(moved.info.noPin.limit === 1250 && moved.repacedNoPin === 1250 && moved.noPin.limit === 1250 && D.card.state.noPinLimit === 1250 && D.card.state.tapLimit === 1000 && moved.repaced === 1000,
       'a price that has moved is followed: the allowance is set to what the dollars are worth now (and so is the limit on one tap)', JSON.stringify([moved.info.noPin, moved.repaced]));
    ok(D.card.state.record.limit === 0, 'with the day’s limit as it was');
    D.card.tap();
    const read = await D.R.W.cardLook(D.card, { mine: true, price: 50000 });
    D.card.tap();
    const still = await D.H.W.cardLook(D.card, { mine: true, price: 80000 });
    ok(!read.repacedNoPin && still.info.noPin.limit === 1250 && !still.repacedNoPin, 'another phone, which did not set it, changes nothing');
    D.card.tap();
    await D.H.W.cardSetLimit(D.card, { sats: 0, noPin: true });
    ok(D.H.W.cardNoPinUsd(D.card.key) === 0 && D.H.W.cardPaceUsd(D.card.key) === 0.8, 'no allowance forgets its dollars and not the tap’s');
    await settle();
  }

  /* ---- 10: a card of 1.15 keeps asking for its PIN, and the phone works with it -------------------------------------- */
  {
    const { H, R, card } = await world('1234', { card: { software: 15 } });
    card.tap();
    const seen = await H.W.cardLook(card, { mine: true });
    ok(seen.info.version === '1.15' && seen.info.noPinKnown === false && seen.noPin.known === false && seen.noPin.set === false, 'a card of 1.15 says no allowance, and the wallet reads none', JSON.stringify(seen.noPin));
    card.tap();
    card.sent.length = 0;
    const e = await R.W.cardPay(card, { sats: 100 }).then(() => null, (x) => x);
    ok(e && e.card === 'pin-needed' && e.early === true && count(card, '22') === 0, 'a payment with no PIN is stopped by the read: it always needs one', e && e.card);
    card.tap();
    const paid = await R.W.cardPay(card, { sats: 100, pin: '1234' });
    ok(paid.sats === 100, 'and with the PIN it pays as it did');
    card.tap();
    ok((await why(H.W.cardSetLimit(card, { sats: 100, noPin: true }))) === 'old-card', 'no allowance can be set on it');
    // the card's own refusal of a payment shown no PIN is the old one, 6982
    card.tap();
    await card.send(SEL);
    ok((await card.send('b0220000' + '01' + '00')).slice(-4) === '6982', 'a card of 1.15 refuses even the beginning of a payment with no PIN shown, 6982');
    await settle();
  }

  /* ---- 11: a blocked card, and the owner's unblocking --------------------------------------------------------------- */
  {
    const { H, R, card } = await world('1234');
    card.tap();
    await H.W.cardSetLimit(card, { sats: 1000, noPin: true });
    for (let i = 0; i < 3; i++) { card.tap(); await why(R.W.cardPay(card, { sats: 100, pin: '0000' })); }
    card.tap();
    ok((await why(R.W.cardPay(card, { sats: 100 }))) === 'blocked', 'a blocked card signs for nobody, allowance or none: no PIN gets the card’s refusal, blocked');
    card.tap();
    ok((await H.W.cardChangePin(card, { newPin: '1111' })) === true, 'its owner unblocks it with a new PIN');
    card.tap();
    const paid = await R.W.cardPay(card, { sats: 100 });
    ok(paid.sats === 100, 'and the allowance, which was kept, pays with no PIN again');
    await settle();
  }

  /* ---- 12: change comes back to a card paid with no PIN, and a signature the card gave as it left is asked for again ------- */
  {
    const { H, R, card } = await world(null, { sats: 0 });
    await binaryLoad(H, card, 4160, {});
    card.tap();
    const paid = await R.W.cardPay(card, { sats: 100, keepSheet: true });
    ok(paid.sats === 100 && count(card, '40') === 0 && paid.change && paid.change.sats > 0, 'a payment of 100 from a piece of 4,096 with no PIN: the card makes change', JSON.stringify(paid.change));
    card.tap();
    const back = await R.W.cardWrite(card, { change: true });
    ok(back.sats > 0 && back.left === 0 && card.balance() === 4160 - 100, 'and the tap after it writes the change back on the card, which asks for no PIN and has none', String(card.balance()));
    // the answer is lost on the air: the card signed
    card.tap();
    card.loseAnswerOf('24', 1);
    const cut = await R.W.cardPay(card, { sats: 64 }).then(() => null, (e) => e);
    ok(cut && cut.card === 'interrupted' && card.state.lastSig && R.W.cardAskedOpen() === 1, 'a card taken away as it signed: the signature is asked for again at the next tap', cut && cut.card);
    card.tap();
    const again = await R.W.cardPay(card, { sats: 64 });
    ok(R.W.cardAskedOpen() === 0 && again.sats >= 0 && count(card, '25') >= 1 && count(card, '40') === 0, 'with no PIN on the card it is given with none', card.sent.map((a) => a.slice(2, 4)).join(' '));
    await settle();
  }
  {
    const { H, R, card } = await world('1234', { sats: 0 });
    await binaryLoad(H, card, 4160, { pin: '1234' });
    card.tap();
    await H.W.cardSetLimit(card, { noPin: 500 });
    card.tap();
    card.sent.length = 0;
    card.loseAnswerOf('24', 1);
    const cut = await R.W.cardPay(card, { sats: 64 }).then(() => null, (e) => e);
    ok(cut && cut.card === 'interrupted' && card.state.noPinSpent > 0 && R.W.cardAskedOpen() === 1, 'a payment within the allowance whose answer was lost: signed, counted, and asked back', cut && cut.card);
    card.tap();
    const done = await R.W.cardPay(card, { sats: 64 });
    ok(done.sats === 64 && R.W.cardAskedOpen() === 0 && (await bal(R)) === 64 && count(card, '25') >= 1 && count(card, '40') === 0,
       'a signature given under the allowance is given again with no PIN, and the payment is in hand after all', String(await bal(R)));
    // and one that needed the PIN is given again with it only: the card asks, and the phone asks the person
    card.tap();
    await H.W.cardSetLimit(card, { noPin: 0 });
    card.tap();
    card.loseAnswerOf('24', 1);
    const cutPin = await R.W.cardPay(card, { sats: 64, pin: '1234' }).then(() => null, (e) => e);
    card.tap();
    const noPin = await R.W.cardPay(card, { sats: 64 }).then(() => null, (e) => e);
    ok(cutPin && cutPin.card === 'interrupted' && noPin && noPin.card === 'pin-needed' && noPin.again === true && R.W.cardAskedOpen() === 1,
       'one given with the PIN is the PIN’s to give again: pin-needed, and it stays asked for', noPin && noPin.card);
    card.tap();
    const doneWith = await R.W.cardPay(card, { sats: 64, pin: '1234' });
    ok(doneWith.sats === 64 && R.W.cardAskedOpen() === 0 && (await bal(R)) === 128, 'and with the PIN the payment is in hand', String(await bal(R)));
    card.tap();
    await R.W.cardWrite(card, { change: true });
    await settle();
  }

  await settle();
  console.log('\n' + (failed ? failed + ' flashcard-nopin check(s) failed' : 'all flashcard-nopin checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
