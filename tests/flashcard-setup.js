'use strict';
/* flashcard-setup.js — reading a card and making a new one this phone's.
 *
 *     node tests/flashcard-setup.js
 *
 * The card here is the model (tests/flashcard-card.js), which answers as the
 * applet does (tests/flashcard-model.js). No money moves in this suite: it is
 * the card's own state, the PIN, the daily limit, the owner, and what the phone
 * writes down about a card before it trusts it with any.
 *
 * A new card has no owner and is open: it takes a PIN and a record from anybody
 * and cannot be loaded. Set-up gives it a PIN, its record (with the key its time
 * is checked against) and, last, this phone as its owner, which is native's
 * public key for the card; the owner's private key never reaches the page. It
 * asks for no limit. Changing the PIN and setting the limit are the owner's, by
 * proof, and no PIN is typed for them.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { cardOwnerScalar, p256Public } = require('./harness');
const { funded, newCard, why, MINT, OTHER_WORDS, PHONE_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const hexOfPin = (pin) => Buffer.from(pin, 'latin1').toString('hex');
const insOf = (card) => card.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));

(async () => {
  const P = await funded({}, 0);
  const W = P.W;
  const seed = Buffer.from(P.phone.toSeed(PHONE_WORDS));

  /* ---- a new card -------------------------------------------------------- */
  const card = newCard(P);
  const seen = await W.cardLook(card);
  ok(seen.key === card.key && seen.info.pin === 'none' && !seen.info.hasRecord && seen.balance === 0 && seen.info.slots === 64,
     'a new card says it is new: no PIN, no record, nothing on it', JSON.stringify(seen.info));
  ok(seen.info.format === 3 && seen.info.limit === 0 && !seen.info.owner && seen.info.windowStart === 0 && seen.info.spentToday === 0,
     'in format 3, with no limit and no owner', JSON.stringify(seen.info));
  ok(card.sent.some((a) => a.slice(2, 4) === '15'), 'and is made to prove it holds its key');
  ok(!insOf(card).includes('35'), 'and no tap sends it SET_TIME: the app has no signed time to tell', insOf(card).join());

  /* ---- not a card, or not the card it says ------------------------------- */
  ok((await why(W.cardLook({ send: () => Promise.resolve('6a82') }))) === 'not-a-card', 'something that does not answer to the card’s name is not a card');
  ok((await why(W.cardLook({ send: () => Promise.reject(new Error('x')) }))) === 'gone', 'a card that answers nothing has gone');
  {
    // a pretend card: it relays a real card's answers and cannot sign for its key
    const real = newCard(P);
    const liar = { send: (a) => real.send(a).then((r) => (a.slice(2, 4) === '15' ? '00'.repeat(80) + '9000' : r)) };
    ok((await why(W.cardLook(liar))) === 'not-a-card', 'a card that cannot sign for the key it shows is refused');
    const other = newCard(P);
    await other.send('00a4040009f0464f58594341524400');
    const swap = { send: (a) => (a.slice(2, 4) === '15' ? other.send(a) : real.send(a)) };
    real.tap();
    ok((await why(W.cardLook(swap))) === 'not-a-card', 'and so is one whose proof was signed by another card’s key');
  }

  /* ---- set-up, recoverable ---------------------------------------------- */
  ok((await why(W.cardSetUp(card, { pin: '12', recoverable: true }))) === 'bad-pin', 'a PIN of two digits is refused before the card is told anything');
  ok((await why(W.cardSetUp(card, { pin: '12a4', recoverable: true }))) === 'bad-pin', 'and one that is not digits');
  ok(card.state.pinState === 0, 'the card still has no PIN');
  card.tap();
  const mine = await W.cardSetUp(card, { pin: '1234', recoverable: true });
  ok(mine.info.pin === 'set' && mine.info.hasRecord && mine.record.mint === MINT && mine.record.unit === 'sat',
     'a card set up has its PIN and says which mint it is for', JSON.stringify(mine.record));
  ok(mine.info.owner === true && mine.info.limit === 0 && mine.record.limit === 0,
     'and an owner, and no limit: set-up asks for none and a new card has none', JSON.stringify({ owner: mine.info.owner, limit: mine.info.limit }));
  ok(mine.record.timeKey === undefined && !Object.prototype.hasOwnProperty.call(W, 'cardTimeKey'),
     'and no key to check a time against: the wallet has none to write, and the record read has none');
  {
    // the owner goes in last, so that no step before it needs a proof, and no limit is set: one tap
    const ins = insOf(card);
    const at = ins.lastIndexOf('41');
    ok(at >= 0 && ins.slice(at, at + 4).join() === '41,40,32,43', 'in the order PIN, PIN checked, record, owner', ins.slice(at, at + 4).join());
    const until = ins.slice(0, at + 4);
    ok(!until.includes('34') && !until.includes('44') && !until.includes('45'), 'with no limit set, and no nonce asked for: nothing before the owner is given needs a proof', until.join());
    // the owner is native's public key for this card, from this phone's words and the card's key, and the same on any phone that has the words
    const want = p256Public(cardOwnerScalar(seed, card.key));
    ok(card.state.owner === want, 'the owner the card holds is the P-256 public key of the key derived from the seed and the card’s key', String(card.state.owner).slice(0, 12));
    ok(!card.sent.some((a) => a.indexOf(PHONE_WORDS.split(' ')[0]) >= 0), 'and nothing the card was sent holds the words');
    // the page never held the private key, nor any secret from the seed: no answer of the phone has one in it
    const scalar = cardOwnerScalar(seed, card.key).toString(16).padStart(64, '0');
    const raw = crypto.createHmac('sha256', seed).update(Buffer.concat([Buffer.from('FoxyCard/owner\0', 'latin1'), Buffer.from(card.key, 'hex')])).digest('hex');
    const heard = P.phone.said.map((x) => x.text).join('\n');
    ok(!heard.includes(scalar) && !heard.includes(raw) && !heard.includes(seed.toString('hex')), 'no answer the phone gave the page holds the owner’s private key, the secret it came from, or the seed');
    ok(!P.phone.said.some((x) => /"(secret|priv|privkey|seed)"/.test(String(x.text)) && x.action.indexOf('card') === 0), 'and no answer of a card action has a field for one');
    const asked = new Set(P.phone.asks.map((a) => a.action).filter((a) => /^card/.test(a)));
    ok([...asked].every((a) => ['cardOwnerKey', 'cardOwnerSign'].includes(a)), 'the page asked native for a card’s owner key and a signature, and for nothing else', [...asked].join());
    ok(!P.phone.asks.some((a) => a.action === 'cardOwner'), 'and the action that once handed it a secret is not asked');
  }
  const known = W.cardsKnown()[card.key] || {};
  ok(/^0[23][0-9a-f]{64}$/.test(mine.record.refundKey) && known.refundKey === mine.record.refundKey && known.refundIndex >= 0,
     'a recoverable card carries a key of this phone’s, and the phone has written down which', JSON.stringify(known));
  {
    // that key is one the phone derives from its words at the index kept
    const got = await new Promise((res) => {
      const id = 'k' + Math.random();
      const done = P.window.FoxyWallet._scanResult;
      P.window.FoxyWallet._scanResult = function (i, text, err) { if (i === id) { P.window.FoxyWallet._scanResult = done; res(text); return; } return done.apply(this, arguments); };
      P.window.webkit.messageHandlers.foxy.postMessage({ id, action: 'p2pkKey', index: known.refundIndex });
    });
    let pub = '';
    try { pub = JSON.parse(got).pubkey; } catch (e) {}
    ok(String(pub).toLowerCase() === known.refundKey, 'and it is the key the phone’s words give at that index', String(pub).slice(0, 12));
  }
  card.tap();
  ok((await why(W.cardSetUp(card, { pin: '1234', recoverable: true }))) === 'set-up', 'a card that has an owner is not set up again');

  /* ---- the signed time is gone ---------------------------------------------------- */
  {
    ok(!fs.existsSync(path.join(__dirname, '..', 'Foxy', 'Flashcard', 'CardTime.swift')), 'the app has no signer of a card’s time: no private key for one is built into it');
    ok(!P.phone.asks.some((a) => a.action === 'cardTime'), 'and the page never asks the phone for one');
  }

  /* ---- set-up, as cash ---------------------------------------------------
   * Every card is set up recoverable unless the caller says `recoverable: false`, which no screen does: the first case
   * here, with nothing said, is recoverable, and a card that is cash is made only by asking for it. */
  {
    const plain = newCard(P);
    const c0 = await W.cardSetUp(plain, { pin: '0000' });
    ok(/^0[23][0-9a-f]{64}$/.test(c0.record.refundKey) && !!W.cardsKnown()[plain.key],
       'a card set up with nothing said is recoverable: its record names this phone’s key, and the phone keeps it', JSON.stringify({ refund: c0.record.refundKey.slice(0, 8) }));
  }
  const cash = newCard(P);
  const c2 = await W.cardSetUp(cash, { pin: '0000', recoverable: false });
  ok(c2.record.refundKey === '' && !W.cardsKnown()[cash.key], 'a card set up as cash carries no key of anybody’s, and nothing is kept about it', JSON.stringify(c2.record));
  ok(c2.mine === true, 'and the phone that set it up is its owner, as the card says when asked', String(c2.mine));

  /* ---- a set-up cut off: every step is allowed again while the card has no owner -- */
  const half = newCard(P);
  half.leaveAfter(6);     // the five commands of a look of an empty card (select, info, key, proof, record) and SET_PIN, then gone before the PIN is checked
  const gap = await why(W.cardSetUp(half, { pin: '5555' }));
  ok(gap === 'gone' && half.state.pinState === 1 && !half.state.owner && !half.state.record.set, 'a card taken away right after its PIN was set has a PIN, and no record and no owner', gap);
  half.tap();
  const resumed = await W.cardSetUp(half, { pin: '6666' });
  ok(resumed.info.pin === 'set' && resumed.info.hasRecord && resumed.info.owner && half.state.pin === hexOfPin('6666'),
     'tapped again, the set-up goes on from there, with whatever PIN is typed then: an open card has nobody’s PIN to protect');
  const cut = newCard(P);
  cut.leaveAfter(8);      // a look, SET_PIN, VERIFY_PIN and SET_CARD, then gone before the owner is given
  const first = await why(W.cardSetUp(cut, { pin: '4321', recoverable: true }));
  ok(first === 'gone' && cut.state.pinState === 1 && !cut.state.owner && cut.state.record.set, 'a card taken away before its owner was given has its PIN and its record and no owner', first);
  cut.tap();
  const stuck = await W.cardPrepare(await W.cardLook(cut), 100).then(() => null, (e) => e);
  ok(stuck && stuck.card === 'no-owner' && W.cardOwed().length === 0, 'it cannot be loaded, and no money is made for it', stuck && stuck.message);
  cut.tap();
  const done = await W.cardSetUp(cut, { pin: '9999', recoverable: true });
  ok(done.info.hasRecord && done.info.owner && cut.state.pin === hexOfPin('9999') && done.record.refundKey === W.cardsKnown()[cut.key].refundKey,
     'tapped again, the set-up is finished with the key first written down for it');

  /* ---- a card with a PIN and no owner: set up by something else ------------------ */
  const foreign = newCard(P);
  await foreign.send('00a4040009f0464f585943415244');
  ok((await foreign.send('b04100000431323334')) === '9000', 'a reader that knows nothing of owners gives a card a PIN');
  foreign.tap();
  const taken = await W.cardSetUp(foreign, { pin: '5678' });
  ok(taken.info.owner && foreign.state.pin === hexOfPin('5678') && taken.mine === true, 'and this phone, which is the first to give it an owner, sets it up: until then it is nobody’s');

  /* ---- a card with another phone's owner --------------------------------------- */
  const O = await funded({ words: OTHER_WORDS }, 0);
  {
    const theirs = newCard(P);
    await O.W.cardSetUp(theirs, { pin: '2468' });
    theirs.tap();
    const again = await why(W.cardSetUp(theirs, { pin: '1111' }));
    ok(again === 'set-up' && theirs.state.pin === hexOfPin('2468'), 'a card that is another phone’s is not set up by this one, empty or not: nothing was written', again);
    theirs.tap();
    const look = await W.cardLook(theirs, { mine: true });
    ok(look.info.owner === true && look.mine === false, 'and says, when asked, that this phone is not its owner', String(look.mine));
    theirs.tap();
    const forOwn = await W.cardLook(theirs);
    ok(forOwn.mine === undefined, 'a till does not ask');
  }

  /* ---- the PIN, by the owner ------------------------------------------------------ */
  card.tap();
  const before = card.sent.length;
  ok((await W.cardChangePin(card, { newPin: '246810' })) === true && card.state.pin === hexOfPin('246810'), 'the owner changes the PIN with the new one only: no old PIN is asked for');
  ok(!card.sent.slice(before).some((a) => a.slice(0, 2) === 'b0' && a.slice(2, 4) === '40'), 'and the PIN is not sent to the card at all');
  ok((await why(W.cardChangePin(card, { newPin: '12' }))) === 'bad-pin', 'a new PIN is 4 to 8 digits');
  card.tap();
  ok((await why(W.cardWrite(card, { pin: '1234' }))) === 'wrong-pin', 'the old PIN no longer opens the card');
  card.tap();
  ok((await W.cardWrite(card, { pin: '246810' })).card.info.tries === 3, 'and the new one does');

  /* ---- the daily limit, by the owner ------------------------------------------------ */
  card.tap();
  const b2 = card.sent.length;
  const lim = await W.cardSetLimit(card, { sats: 5000 });
  // within a second: the two are read a moment apart, and the clock ticked between them once in a check-all (2026-11-01)
  ok(lim.info.limit === 5000 && lim.record.limit === 5000 && Math.abs(lim.info.windowStart - lim.info.now) <= 1 && lim.info.spentToday === 0 && lim.info.now > 0,
     'the owner sets the limit, and a day begins at the card’s clock with nothing spent', JSON.stringify({ limit: lim.info.limit, start: lim.info.windowStart, now: lim.info.now }));
  ok(!card.sent.slice(b2).some((a) => a.slice(2, 4) === '40'), 'with no PIN sent');
  ok(lim.day.limited && lim.day.limit === 5000 && lim.day.left === 5000 && lim.day.spent === 0, 'and the card’s day is read as the whole limit left', JSON.stringify(lim.day));
  card.tap();
  ok((await W.cardSetLimit(card, { sats: 0 })).info.limit === 0, 'a limit of nothing is no limit: the way to remove one');
  card.tap();
  ok((await why(W.cardSetLimit(card, { sats: -5 }))) === 'bad-limit' && (await why(W.cardSetLimit(card, { sats: 4294967296 }))) === 'bad-limit', 'and there is none below nothing or above what a card holds');
  card.tap();
  ok((await W.cardSetLimit(card, { sats: 4294967295 })).info.limit === 4294967295, 'any amount the card can hold is one');
  card.tap();
  await W.cardSetLimit(card, { sats: 800 });

  /* ---- who may change the PIN and the limit ------------------------------------------ */
  {
    // the owner is this phone's words, and nobody else's
    card.tap();
    const theirs = await O.W.cardChangePin(card, { newPin: '1357' }).then(() => null, (e) => e);
    ok(theirs && theirs.card === 'not-owner' && card.state.pin === hexOfPin('246810') && card.state.tries === 3,
       'a phone with other words cannot change the PIN, and it costs the card no try', theirs && theirs.message);
    ok(/seed phrase/.test(theirs.message) && /cannot change the card/.test(theirs.message), 'and is told so in plain words', theirs.message);
    card.tap();
    const upLimit = await O.W.cardSetLimit(card, { sats: 0 }).then(() => null, (e) => e);
    ok(upLimit && upLimit.card === 'not-owner' && card.state.record.limit === 800 && card.state.tries === 3, 'nor can it remove the limit', upLimit && upLimit.message);
    card.tap();
    // a phone restored from the same twelve words is the owner again
    const N = await funded({ words: PHONE_WORDS }, 0);
    ok((await N.W.cardChangePin(card, { newPin: '1357' })) === true && card.state.pin === hexOfPin('1357'), 'a new phone restored from the same twelve words can change the PIN');
    card.tap();
    ok((await N.W.cardSetLimit(card, { sats: 900 })).info.limit === 900, 'and set the limit');
    // the wrong proof is no wrong PIN: three of them and the card is no worse
    for (let i = 0; i < 3; i++) { card.tap(); await why(O.W.cardChangePin(card, { newPin: '2468' })); }
    ok(card.state.tries === 3 && card.state.pinState === 1, 'wrong proofs three times over leave the card’s tries as they were');
    // a card with no owner has nobody to change anything
    const nobody = newCard(P);
    await nobody.send('00a4040009f0464f585943415244');
    await nobody.send('b04100000431323334');
    nobody.tap();
    const none = await W.cardChangePin(nobody, { newPin: '5678' }).then(() => null, (e) => e);
    ok(none && none.card === 'no-owner' && nobody.state.pin === '31323334', 'a card with no owner cannot have its PIN changed, and says that it has none', none && none.message);
  }

  /* ---- the allowance is gone from the page ------------------------------------------- */
  ok(!W.cardSetAllowance && typeof W.cardSetLimit === 'function', 'the wallet has no call that sets an allowance, and one that sets the daily limit');

  /* ---- blocked, and unblocked by the owner ------------------------------------------- */
  const doomed = newCard(P);
  await W.cardSetUp(doomed, { pin: '1111', recoverable: true });
  const said = [];
  for (let i = 0; i < 4; i++) { doomed.tap(); said.push(await W.cardWrite(doomed, { pin: '2222' }).then(() => 'ok', (e) => e.card + (e.tries !== undefined ? ':' + e.tries : ''))); }
  ok(said.join(' ') === 'wrong-pin:2 wrong-pin:1 blocked:0 blocked:0', 'three wrong PINs block the card, and it says so each time after', said.join(' '));
  doomed.tap();
  ok((await why(W.cardWrite(doomed, { pin: '1111' }))) === 'blocked', 'the right PIN does not open a blocked card');
  doomed.tap();
  const b = await W.cardLook(doomed, { mine: true });
  ok(b.info.pin === 'blocked' && b.info.tries === 0 && b.key === doomed.key, 'but it still says what it is, for the phone that can take its money back');
  ok(b.mine === true, 'and, to the phone that owns it, that it is its owner');
  doomed.tap();
  ok((await W.cardChangePin(doomed, { newPin: '3333' })) === true && doomed.state.pinState === 1 && doomed.state.tries === 3,
     'and the owner’s CHANGE PIN unblocks it, with no old PIN: that is UNBLOCK');
  doomed.tap();
  ok((await W.cardWrite(doomed, { pin: '3333' })).card.info.pin === 'set', 'and the new PIN works');

  /* ---- a tap, through the phone ------------------------------------------- */
  {
    const tapped = newCard(P);
    P.nfc = tapped;
    P.sheet.length = 0;
    const got = await W.cardSession('Hold the card to the top of the phone', (link) => W.cardLook(link));
    ok(got.key === tapped.key && P.sheet.join(' | ') === 'begin: Hold the card to the top of the phone | end: Done.',
       'a tap opens the phone’s sheet, reads the card through it and closes it', P.sheet.join(' | '));
    P.sheet.length = 0;
    const refused = await W.cardSession('Hold the card', (link) => W.cardSetLimit(link, { sats: 1 })).then(() => null, (e) => e);
    // (a refusal the app's screen explains ends the sheet with its tick and "Card read", not in red)
    ok(refused && refused.card === 'no-owner' && P.sheet.join(' | ') === 'begin: Hold the card | end: Card read',
       'what the card refuses comes back as it was, and the sheet closes calmly with "Card read" for the screen to explain', P.sheet.join(' | '));
    P.sheet.length = 0;
    // set once the tap has begun: the card arriving is what clears what it was told before
    const left = await W.cardSession('Hold the card', (link) => { tapped.leaveAfter(3); return W.cardLook(link); }).then(() => null, (e) => e);
    ok(left && left.card === 'gone' && /error: Card taken away too soon\./.test(P.sheet.join(' | ')), 'a card taken away mid-tap is said so', P.sheet.join(' | '));
    // and so, in red, is a card not held long enough (6A98) or taken away before it signed for all of it: the card going wrong, not a refusal
    for (const code of ['keep-holding', 'partial']) {
      P.sheet.length = 0;
      const e2 = await W.cardSession('Hold the card', () => Promise.reject(Object.assign(new Error('The card was not held long enough.'), { card: code }))).then(() => null, (e) => e);
      ok(e2 && e2.card === code && /^begin: Hold the card \| error: /.test(P.sheet.join(' | ')) && !/Card read/.test(P.sheet.join(' | ')),
         'a card taken away too soon (' + code + ') ends the sheet in red, not with the tick of a refusal', P.sheet.join(' | '));
    }
    // and so is a card that is not what it claims: a fake, a bad signature or the wrong signer, pieces a copy has spent
    for (const code of ['fake', 'bad-signature', 'wrong-signer', 'spent']) {
      P.sheet.length = 0;
      const e3 = await W.cardSession('Hold the card', () => Promise.reject(Object.assign(new Error('This card is not what it claims.'), { card: code }))).then(() => null, (e) => e);
      ok(e3 && e3.card === code && /^begin: Hold the card \| error: /.test(P.sheet.join(' | ')) && !/Card read/.test(P.sheet.join(' | ')),
         'a card that is not what it claims (' + code + ') ends the sheet in red, never with a tick', P.sheet.join(' | '));
    }
    P.nfc = null;
    ok((await why(W.cardSession('Hold the card', (link) => W.cardLook(link)))) === 'cancelled', 'a sheet dismissed with no card is a tap that was not made');
    P.nfc = 'off';
    ok((await why(W.cardSession('Hold the card', (link) => W.cardLook(link)))) === 'no-nfc', 'and a phone that cannot read a card says that');
  }

  /* ---- the card maker's record: the design a card is printed in, on the chip before it is set up --------------------------
   * The encoder (bulk encoding, before printing) writes the shortest record a card takes: a unit of sats, no refund key, the mint
   * "-" (one character, which no mint's address is: the card refuses a mint of none) and the design. The phone reads such a card as
   * new, in that design, and set-up writes its own mint over the record and keeps the design. */
  {
    const maker = (design) => 'b0320000' + '68' + '00' + '00'.repeat(33) + '00'.repeat(65) + '01' + '2d' + Buffer.from(design, 'latin1').toString('hex');
    const printed = newCard(P, undefined, { format: 4, software: 24 });
    await printed.send('00a404000af0464f5859434152440100');
    ok((await printed.send(maker('EL1'))).slice(-4) === '9000' && printed.state.record.set && printed.state.record.mint === '-' && printed.state.record.design === 'EL1',
       'a blank card of 1.24 takes the card maker’s record from anyone: the mint "-" and the design EL1');
    ok((await printed.send('b0320000' + '65' + '00' + '00'.repeat(33) + '00'.repeat(65) + '00' + Buffer.from('EL1', 'latin1').toString('hex'))).slice(-4) === '6700',
       'and refuses one with no mint at all (6700): "-" is the shortest record it takes');
    printed.tap();
    const fresh = await W.cardLook(printed);
    ok(fresh.info.setUp === false && fresh.info.hasRecord === false && fresh.info.recordSet === true && fresh.record.factory === true
       && fresh.record.mint === '' && fresh.design === 'EL1',
       'read by a phone, it is new and names no mint, in the design it was printed in (the card’s own word that it has a record kept apart)',
       JSON.stringify({ setUp: fresh.info.setUp, hasRecord: fresh.info.hasRecord, recordSet: fresh.info.recordSet, mint: fresh.record.mint, design: fresh.design }));
    printed.tap();
    const made = await W.cardSetUp(printed, { pin: '2580', design: '001' });
    ok(made.info.setUp && made.info.hasRecord && made.record.mint === MINT && printed.state.record.mint === MINT && printed.state.record.design === 'EL1' && made.design === 'EL1',
       'set up with the app’s 001, it keeps EL1: the record is this phone’s mint, with the design the card named', JSON.stringify([printed.state.record.mint, printed.state.record.design]));
    printed.tap();
    ok((await W.cardLook(printed)).design === 'EL1', 'and reads EL1 afterwards');
    // one with no design on it is given the app's own
    const plain = newCard(P, undefined, { format: 4, software: 24 });
    plain.tap();
    const plainMade = await W.cardSetUp(plain, { pin: '2580', design: '001' });
    ok(plain.state.record.design === '001' && plainMade.design === '001', 'a card that names none is set up in the app’s 001, three digits on the chip', plain.state.record.design);
    // a set-up cut off after its PIN and before its record: the card keeps that PIN (it has a record, the maker's), and the same set-up tried again finishes it under it
    const cut = newCard(P, undefined, { format: 4, software: 24 });
    await cut.send('00a404000af0464f5859434152440100');
    await cut.send(maker('EL1'));
    cut.tap();
    cut.leaveBefore('32', 1);
    ok((await why(W.cardSetUp(cut, { pin: '2580', design: '001' }))) === 'gone' && cut.state.pinState === 1 && cut.state.record.mint === '-' && !cut.state.owner,
       'a set-up cut off before its record leaves a PIN on the maker’s record, and no owner');
    cut.tap();
    const cutSeen = await W.cardLook(cut);
    ok(cutSeen.info.setUp === false && cutSeen.info.hasRecord === false && cutSeen.info.recordSet === true && cutSeen.info.pinSet === true,
       'it reads as a set-up not finished, not as a holder’s card at a mint called "-"', JSON.stringify({ setUp: cutSeen.info.setUp, hasRecord: cutSeen.info.hasRecord }));
    cut.tap();
    const cutMade = await W.cardSetUp(cut, { pin: '2580', design: '001' });
    ok(cutMade.mine === true && !!cut.state.owner && cut.state.record.mint === MINT && cut.state.record.design === 'EL1',
       'and the same set-up tried again finishes it, the PIN shown first, at this phone’s mint, still EL1', JSON.stringify([cut.state.record.mint, cut.state.record.design]));
  }

  /* ---- the keeper's yes, asked before the card is held up ------------------- */
  /* Every owner's command but a top-up is signed only against a yes the phone asks itself, before the tap (cardOwnerApprove,
   * NativeSeedBridge.swift). What the page sends for each, and a No said as `declined`, not as a missing seed. */
  {
    P.phone.cardApprovals = [];
    await W.cardApprove({ label: 'change-pin', pin: '2468' });
    await W.cardApprove({ label: 'reset', number: 3 });
    await W.cardApprove({ label: 'reset' });
    await W.cardApprove({ label: 'set-card', mint: MINT + '/', units: ['usd'], keep: true, card: '02' + '11'.repeat(32) });
    await W.cardApprove({ label: 'set-limit', figures: ['tap'] });
    // a taking-off's lift: alone, with a reset, with a move, with a limit; never with a PIN
    await W.cardApprove({ label: 'set-limit', lift: true });
    await W.cardApprove({ label: 'reset', lift: true });
    await W.cardApprove({ label: 'set-card', mint: MINT, keep: true, card: '02' + '11'.repeat(32), lift: true });
    await W.cardApprove({ label: 'set-limit', figures: ['tap'], lift: true });
    await W.cardApprove({ label: 'change-pin', pin: '2468', lift: true });
    const asked = P.phone.cardApprovals.map((m) => [m.label, m.value, m.mint, (m.units || []).join(), m.keep, m.card, (m.figures || []).join(), m.lift]);
    ok(JSON.stringify(asked) === JSON.stringify([
      ['change-pin', '32343638', undefined, '', undefined, undefined, ''],
      ['reset', '03', undefined, '', undefined, undefined, ''],
      ['reset', '', undefined, '', undefined, undefined, ''],
      ['set-card', undefined, MINT, 'usd', true, '02' + '11'.repeat(32), ''],
      ['set-limit', undefined, undefined, '', undefined, undefined, 'tap'],
      ['set-limit', undefined, undefined, '', undefined, undefined, '', true],
      ['reset', '', undefined, '', undefined, undefined, '', true],
      ['set-card', undefined, MINT, '', true, '02' + '11'.repeat(32), '', true],
      ['set-limit', undefined, undefined, '', undefined, undefined, 'tap', true],
      ['change-pin', '32343638', undefined, '', undefined, undefined, '', undefined]].map((r) => r.length === 8 ? r : r.concat([undefined]))),
      'the page asks the phone for the keeper’s yes with the exact PIN or opening, the mint as the card will hold it, which limit, and the lift of a taking-off, which names no figure', JSON.stringify(asked));
    P.phone.hooks.cardApprove = () => false;
    ok((await why(W.cardApprove({ label: 'reset' }))) === 'declined', 'a No is the keeper’s answer (`declined`), not a missing seed phrase');
    P.phone.hooks.cardApprove = null;
    ok((await why(W.cardApprove({ label: 'change-pin', pin: '12' }))) === 'bad-pin', 'and a PIN that is no PIN is refused before the phone is asked');
  }

  /* ---- 2026-11-03: the per second limit made true (software 1.25) ------------------------------------------------------
   * The card of 1.25 waits one second for each limit's worth after the first, and signs nothing earlier than two seconds into
   * the tap. So a rate of R a second is a limit of R (FC_SPEED_SECS 1: "$5 a second" sends $5), and what the screens say a
   * payment of N limits' worth takes is 2 s + 1 s × (N − 1) on a 1.25 card, 3 s × (N − 1) on one before it (`fcHoldSecs`). */
  {
    const { appOn } = require('./flashcard-ui-kit');
    const H = await funded({}, 0);
    const a = appOn(H, { screen: 'flashcard', stack: ['home'] });
    a.price = 50000;
    ok(a.FC_SPEED_SECS === 1 && a.fcSpeedLimit(5, 'usd') === 500 && a.fcSpeedLimit(5, 'sat') === 10000,
       '1.25: "$5 a second" is a limit of $5.00 (500 cents, or 10,000 sats at $50,000)', [a.fcSpeedLimit(5, 'usd'), a.fcSpeedLimit(5, 'sat')].join());
    const on = (version) => { a._fcCard = version ? { info: { version } } : null; };
    on('1.25');
    ok(a.fcCard125() && [1, 2, 3, 4, 10].map((n) => a.fcHoldSecs(n)).join() === '2,4,5,6,13',
       'a card of 1.25 holds about 2.4 s + 1.2 s \u00d7 (N \u2212 1) for N limits\u2019 worth, the floor even within the limit', [1, 2, 3, 4, 10].map((n) => a.fcHoldSecs(n)).join());
    ok(a.fcWaitLine(1000, 'usd', 'usd') === 'It will take 6 seconds to pay $40.00.', 'its SET AMOUNT line: $10 a second, four limits\u2019 worth, six seconds', a.fcWaitLine(1000, 'usd', 'usd'));
    on('1.26');
    ok(a.fcCard125() && a.fcHoldSecs(4) === 6, 'and so does a card after it');
    on('1.24');
    ok(!a.fcCard125() && [1, 2, 3, 4].map((n) => a.fcHoldSecs(n)).join() === '0,3,6,9', 'a card before 1.25 still waits about three seconds a limit: 3 s \u00d7 (N \u2212 1), nothing within it',
       [1, 2, 3, 4].map((n) => a.fcHoldSecs(n)).join());
    ok(a.fcWaitLine(1000, 'usd', 'usd') === 'It will take 9 seconds to pay $40.00.', 'and its SET AMOUNT line says nine seconds for the same', a.fcWaitLine(1000, 'usd', 'usd'));
    on('');
    ok(a.fcCard125() && a.fcHoldSecs(4) === 6, 'a card not read yet is taken as the newest');
    // the sheet's words while a 1.25 card waits: its floor is not "over the limit"
    ok(a.fcProgressText({ step: 'waiting', floor: 3, more: 2, polls: 2 }) === 'Keep holding.' && a.fcProgressText({ step: 'waiting', floor: 3, more: 2, polls: 3 }) === 'Keep holding.'
       && a.fcProgressText({ step: 'waiting', floor: 3, more: 2, polls: 4 }) === 'Over per tap limit x2' && a.fcProgressText({ step: 'waiting', floor: 3, more: 2, polls: 6 }) === 'Over per tap limit x3',
       'on 1.25 the floor\u2019s waits are "Keep holding", and only a wait past it is over the limit, x2 and x3 by two waits a limit',
       [2, 3, 4, 6].map((n) => a.fcProgressText({ step: 'waiting', floor: 3, more: 2, polls: n })).join(' | '));
    ok(a.fcProgressText({ step: 'waiting', over: 10, more: 4, polls: 3 }) === 'Over per tap limit', 'and a card before it is over its limit from its first wait, as ever');
    a._fcCard = null;

    // the wallet against the card itself: 1.25 waits its floor and two a limit past it; 1.24 signs within its limit at once
    for (const software of [25, 24]) {
      const R = await funded({}, 20000);
      const card = newCard(R, undefined, { format: 4, software });
      const PRICE = 100000;
      await R.W.cardSetUp(card, { pin: '1234', unit: 'sat', price: PRICE });
      card.tap();
      await R.W.cardAdd(card, { amount: 9000, unit: 'sat', pin: '1234', price: PRICE });
      card.tap();
      const read = await R.W.cardLook(card, { mine: true, price: PRICE });
      const i = read.info || {};
      if (software === 25) {
        ok(i.waitFloor === 3 && i.waitMore === 2 && i.waitOver === 5, '1.25 says its wait: a floor of 3, two more a limit (and 5 for the first past it)', JSON.stringify([i.waitFloor, i.waitMore, i.waitOver]));
      } else {
        ok(i.waitFloor === 0 && i.waitMore === 4 && i.waitOver === 10, 'a card of 1.24 has no floor: four a limit, ten for the first past it', JSON.stringify([i.waitFloor, i.waitMore, i.waitOver]));
      }
      // (a card of 1.23 and on keeps its limits in cents: $2.00, 2,000 sats at the price)
      card.state.tapLimit = 200;
      const w0 = card.state.waited || 0;
      card.tap();
      const small = await R.W.cardPay(card, { sats: 512, pin: '1234', price: PRICE }).then((r) => r, (e) => ({ no: e }));
      const w1 = card.state.waited || 0;
      ok(!small.no && w1 - w0 === (software === 25 ? 3 : 0), software === 25
        ? '1.25: a payment within its limit waits the floor, three, and is signed (the floor is not read as over the limit)'
        : '1.24: a payment within its limit is signed at once', (small.no ? String(small.no.message) : '') + ' waited ' + (w1 - w0));
      card.tap();
      const big = await R.W.cardPay(card, { sats: 6000, pin: '1234', price: PRICE }).then((r) => r, (e) => ({ no: e }));
      const w2 = card.state.waited || 0;
      ok(!big.no && w2 - w1 === (software === 25 ? 7 : 14), software === 25
        ? '1.25: three limits\u2019 worth waits the floor and two a limit past the first: 3 + 2 \u00d7 2'
        : '1.24: three limits\u2019 worth waits ten and four: 14', (big.no ? String(big.no.message) : '') + ' waited ' + (w2 - w1));
    }
    {
      // the signing loop's "a cheaper set" turn is made at the first wait past the floor, never at the floor's own first "not yet"
      const wsrc = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
      ok(/var floorWaits = \(card && card\.info && Number\(card\.info\.waitFloor\) > 0\)[\s\S]{0,200}if \(polls === floorWaits && other && other\.group && other\.group\.length\)/.test(wsrc)
         && !/if \(polls === 0 && other && other\.group/.test(wsrc),
         'on 1.25 a payment with another set of pieces is not dropped at the floor\u2019s first "not yet": the turn to a cheaper set is past the floor', 'signing loop');
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '26g-tap-limit-explainer.js'), 'utf8');
    ok(/\[2, 3, 4\]\.map\(\(n\) => String\(this\.fcHoldSecs\(n\)\)\)/.test(src), 'HOW TAP LIMIT WORKS takes its tiers from the same (`fcHoldSecs`)', 'explainer');
    const wheel = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '26j-card-wheel.js'), 'utf8');
    ok(!/three seconds of|L = 3 \u00d7 R|L \/ 3/.test(wheel), 'and no word of the card wheel still says a limit is three seconds of the rate', 'wording');
    a._fcCard = null;
  }

  console.log('\n' + (failed ? failed + ' flashcard-setup check(s) failed' : 'all flashcard-setup checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
