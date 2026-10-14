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
 * and cannot be loaded. Set-up gives it a PIN, its record and, last, this phone
 * as its owner, which is native's public key for the card, with the newest
 * block header the phone has as the anchor of its clock where it has one (D20
 * of the Cashu card protocol 2.0); the owner's private key never reaches the page. It
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
  ok(seen.key === card.key && seen.info.pin === 'none' && !seen.info.hasRecord && seen.balance === 0 && seen.info.slots === 128,
     'a new card says it is new: no PIN, no record, nothing on it', JSON.stringify(seen.info));
  ok(seen.info.version === '2.1' && seen.info.format === 4 && seen.info.limit === 0 && !seen.info.owner && seen.info.now === 0 && seen.info.windowStart === 0 && seen.info.spentToday === 0,
     'of the Cashu card protocol 2.1, in format 4, with no limit, no owner, and no clock', JSON.stringify(seen.info));
  ok(card.sent.some((a) => a.slice(2, 4) === '15'), 'and is made to prove it holds its key');
  ok(card.sent[0] === '00a404000b' + 'f043415348554341524401' + '00', 'the applet is chosen by its whole name', card.sent[0]);
  ok(insOf(card).slice(0, 2).join() === '01,37' && !insOf(card).includes('35'),
     'a tap reads what the card is, then tells it the phone\u2019s time as a note; no signed time is sent', insOf(card).join());

  /* ---- a card that needs an update, the opener, and other cards -------------------------------------------------- */
  {
    // a 1.x card answers 6A82 to the 2.0 name; so does a 0.x card and anything else that is not this applet
    const one = await W.cardLook({ send: (a) => Promise.resolve(a.slice(0, 4) === '00a4' ? '6a82' : '9000') }).then(() => null, (e) => e);
    ok(one && one.card === 'not-a-card' && one.needsUpdate === true && one.message === 'This card needs an update.',
       'a card that does not answer the 2.0 name needs an update, and is told so', one && one.message);
    // a 9000 with no version is a chip's opener answering for the applet: no answer at all
    const chip = newCard(P, undefined, { chip: true });
    const opened = await W.cardLook({ send: (a) => chip.send(a.slice(0, 10) === '00a404000b' ? '00a404000a' + a.slice(10, 30) + '00' : a) }).then(() => null, (e) => e);
    ok(opened && opened.needsUpdate === true && chip.sent.length === 1, 'and a SELECT answered 9000 with no version (the opener) is no answer: nothing more is said', opened && opened.message);
    // a version that is not 2: a 1.x answer under the new name needs an update; a 3.0 is newer than this app, which is what needs one
    const odd = await W.cardLook({ send: (a) => Promise.resolve(a.slice(0, 4) === '00a4' ? '0114' + '9000' : '6d00') }).then(() => null, (e) => e);
    ok(odd && odd.needsUpdate === true && !odd.appUpdate, 'a card that answers version 0114 needs an update', odd && odd.message);
    const newer = await W.cardLook({ send: (a) => Promise.resolve(a.slice(0, 4) === '00a4' ? '0300' + '9000' : '6d00') }).then(() => null, (e) => e);
    ok(newer && newer.card === 'not-a-card' && newer.appUpdate === true && !newer.needsUpdate && newer.message === 'This card is newer than this Foxy. Update the app to use it.',
       'a card that answers version 0300 is newer than this app, and the app is what is said to need the update', newer && newer.message);
    // and any minor of 2 is the protocol: 2.0 as 2.1
    const zero = newCard(P);
    const asTwoZero = { send: (a) => zero.send(a).then((r) => (a.slice(0, 4) === '00a4' && r === '02019000' ? '02009000' : r)) };
    const read20 = await W.cardLook(asTwoZero).then((c) => c, (e) => e);
    ok(read20 && read20.key === zero.key && !read20.card, 'a card whose SELECT answers 02 00 is read as one of 02 01 is', read20 && (read20.message || read20.key));
  }

  /* ---- not a card, or not the card it says ------------------------------- */
  ok((await why(W.cardLook({ send: () => Promise.resolve('6a82') }))) === 'not-a-card', 'something that does not answer to the card’s name is not a card');
  ok((await why(W.cardLook({ send: () => Promise.reject(new Error('x')) }))) === 'gone', 'a card that answers nothing has gone');
  {
    // a pretend card: it relays a real card's answers and cannot sign for its key
    const real = newCard(P);
    const liar = { send: (a) => real.send(a).then((r) => (a.slice(2, 4) === '15' ? '00'.repeat(80) + '9000' : r)) };
    ok((await why(W.cardLook(liar))) === 'not-a-card', 'a card that cannot sign for the key it shows is refused');
    const other = newCard(P);
    await other.send('00a404000bf04341534855434152440100');
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
  ok(card.state.record.mint === MINT && mine.record.rolls === 0 && mine.record.budget === 7,
     'and its rollover budget is the default, 7, with none of it spent', JSON.stringify([mine.record.rolls, mine.record.budget]));
  ok(card.sent.some((a) => a.slice(0, 4) === 'b043' && a.length === 10 + 130), 'with no block header kept, the owner is given alone: 65 bytes, no anchor');
  {
    // the owner goes in last, so that no step before it needs a proof, and no limit is set: one tap
    const ins = insOf(card);
    const at = ins.lastIndexOf('41');
    ok(at >= 0 && ins.slice(at, at + 5).join() === '41,44,40,32,43', 'in the order PIN (sealed), PIN checked (sealed), record, owner', ins.slice(at, at + 5).join());
    const until = card.sent.filter((a) => a.slice(0, 2) === 'b0').slice(0, card.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4)).lastIndexOf('41') + 5);
    ok(!until.some((a) => /^b034|^b04400|^b045/.test(a)), 'with no limit set, and no owner\u2019s nonce asked for: nothing before the owner is given needs a proof', until.map((a) => a.slice(2, 6)).join());
    // the owner is native's public key for this card, from this phone's words and the card's key, and the same on any phone that has the words
    const want = p256Public(cardOwnerScalar(seed, card.key));
    ok(card.state.owner === want, 'the owner the card holds is the P-256 public key of the key derived from the seed and the card’s key', String(card.state.owner).slice(0, 12));
    ok(!card.sent.some((a) => a.indexOf(PHONE_WORDS.split(' ')[0]) >= 0), 'and nothing the card was sent holds the words');
    // the page never held the private key, nor any secret from the seed: no answer of the phone has one in it
    const scalar = cardOwnerScalar(seed, card.key).toString(16).padStart(64, '0');
    const raw = crypto.createHmac('sha256', seed).update(Buffer.concat([Buffer.from('CashuCard/owner\0', 'latin1'), Buffer.from(card.key, 'hex')])).digest('hex');
    const heard = P.phone.said.map((x) => x.text).join('\n');
    ok(!heard.includes(scalar) && !heard.includes(raw) && !heard.includes(seed.toString('hex')), 'no answer the phone gave the page holds the owner’s private key, the secret it came from, or the seed');
    ok(!P.phone.said.some((x) => /"(secret|priv|privkey|seed)"/.test(String(x.text)) && x.action.indexOf('card') === 0), 'and no answer of a card action has a field for one');
    const asked = new Set(P.phone.asks.map((a) => a.action).filter((a) => /^card/.test(a)));
    ok([...asked].every((a) => ['cardOwnerKey', 'cardOwnerSign'].includes(a)), 'the page asked native for a card’s owner key and a signature, and for nothing else', [...asked].join());
    ok(!P.phone.asks.some((a) => a.action === 'cardOwner' || a.action === 'cardTime'), 'and not the action that once handed it a secret, nor a signed time');
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

  /* ---- no time key ------------------------------------------------------------ */
  {
    // the record's 65 bytes after the refund key are not read by a 2.0 card, and the page writes zeros there
    const set = card.sent.filter((a) => /^b032/.test(a));
    ok(set.length > 0 && set.every((a) => a.substr(10 + 68, 130) === '0'.repeat(130)), 'the record the card is given has zeros where 1.x cards kept a time key');
    ok(!fs.existsSync(path.join(__dirname, '..', 'Foxy', 'Flashcard', 'CardTime.swift')) && W.cardTimeKey === undefined, 'and the phone has no time signer: Foxy/Flashcard/CardTime.swift is gone');
  }

  /* ---- set-up, as cash --------------------------------------------------- */
  const cash = newCard(P);
  const c2 = await W.cardSetUp(cash, { pin: '0000' });
  ok(c2.record.refundKey === '' && !W.cardsKnown()[cash.key], 'a card set up as cash carries no key of anybody’s, and nothing is kept about it', JSON.stringify(c2.record));
  ok(c2.mine === true, 'and the phone that set it up is its owner, as the card says when asked', String(c2.mine));

  /* ---- a set-up cut off: every step is allowed again while the card has no owner -- */
  const half = newCard(P);
  half.leaveAfter(8);     // the six commands of a look of an empty card (select, info, time, key, proof, record) and the sealed SET_PIN (its nonce and it), then gone before the PIN is checked
  const gap = await why(W.cardSetUp(half, { pin: '5555' }));
  ok(gap === 'gone' && half.state.pinState === 1 && !half.state.owner && !half.state.record.set, 'a card taken away right after its PIN was set has a PIN, and no record and no owner', gap);
  half.tap();
  const resumed = await W.cardSetUp(half, { pin: '6666' });
  ok(resumed.info.pin === 'set' && resumed.info.hasRecord && resumed.info.owner && half.state.pin === hexOfPin('6666'),
     'tapped again, the set-up goes on from there, with whatever PIN is typed then: an open card has nobody’s PIN to protect');
  const cut = newCard(P);
  cut.leaveAfter(11);     // a look, SET_PIN and VERIFY_PIN (each sealed, with its nonce) and SET_CARD, then gone before the owner is given
  const first = await why(W.cardSetUp(cut, { pin: '4321', recoverable: true }));
  ok(first === 'gone' && cut.state.pinState === 1 && !cut.state.owner && cut.state.record.set, 'a card taken away before its owner was given has its PIN and its record and no owner', first);
  cut.tap();
  const stuck = await W.cardPrepare(await W.cardLook(cut), 100).then(() => null, (e) => e);
  ok(stuck && (stuck.card === 'no-owner' || stuck.card === 'no-record') && W.cardOwed().length === 0, 'it cannot be loaded (a card with no owner is not set up), and no money is made for it', stuck && stuck.message);
  cut.tap();
  const done = await W.cardSetUp(cut, { pin: '9999', recoverable: true });
  ok(done.info.hasRecord && done.info.owner && cut.state.pin === hexOfPin('9999') && done.record.refundKey === W.cardsKnown()[cut.key].refundKey,
     'tapped again, the set-up is finished with the key first written down for it');

  /* ---- a card with a PIN and no owner: set up by something else ------------------ */
  const foreign = newCard(P);
  await foreign.send('00a404000bf04341534855434152440100');
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
  ok(lim.info.limit === 5000 && lim.record.limit === 5000 && lim.info.windowStart === lim.info.now && lim.info.spentToday === 0 && lim.record.budget === 7,
     'the owner sets the limit, and a day begins at the card’s clock with nothing spent, with the default rollover budget', JSON.stringify({ limit: lim.info.limit, start: lim.info.windowStart, now: lim.info.now }));
  ok(card.sent.slice(b2).some((a) => /^b034/.test(a) && parseInt(a.substr(8, 2), 16) === 1 + parseInt(a.substr(10, 2), 16) + 13),
     'in the thirteen-byte SET_LIMIT: the day\u2019s limit, the one payment\u2019s, the allowance and the budget');
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
    await nobody.send('00a404000bf04341534855434152440100');
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
    ok(refused && refused.card === 'no-owner' && /^begin: Hold the card \| error: /.test(P.sheet.join(' | ')),
       'what the card refuses is said on the sheet as it closes, and comes back as it was', P.sheet.join(' | '));
    P.sheet.length = 0;
    // set once the tap has begun: the card arriving is what clears what it was told before
    const left = await W.cardSession('Hold the card', (link) => { tapped.leaveAfter(3); return W.cardLook(link); }).then(() => null, (e) => e);
    ok(left && left.card === 'gone' && /error: Card taken away too soon\./.test(P.sheet.join(' | ')), 'a card taken away mid-tap is said so', P.sheet.join(' | '));
    P.nfc = null;
    ok((await why(W.cardSession('Hold the card', (link) => W.cardLook(link)))) === 'cancelled', 'a sheet dismissed with no card is a tap that was not made');
    P.nfc = 'off';
    ok((await why(W.cardSession('Hold the card', (link) => W.cardLook(link)))) === 'no-nfc', 'and a phone that cannot read a card says that');
  }

  console.log('\n' + (failed ? failed + ' flashcard-setup check(s) failed' : 'all flashcard-setup checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
