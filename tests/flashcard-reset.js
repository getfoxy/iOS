'use strict';
/* flashcard-reset.js — card software 1.17: the owner resets a card, and the first limit's worth over the limit waits ten.
 *
 *     node tests/flashcard-reset.js
 *
 * An owner can give a card back to what it was in its packet, so that another person can set it up: under the owner's proof, with
 * nothing unspent on it, and (when it is locked) with its PIN verified in the same tap. It then has no PIN (three tries), no owner,
 * no record, no limits, no allowance, no log, no receipts and no change in hand, and a NEW KEY; it keeps its clock and its software.
 *
 * The card here is the model (tests/flashcard-card.js), which answers as the applet does (tests/flashcard-model.js). What is checked
 * is the card's rules as the model has them, byte for byte (1), and the wallet's side: `cardReset` and `cardEmptyAndReset` and what
 * they refuse (2), what the phone forgets and what it keeps (3), a card set up afresh by another person (4), the money that comes
 * off first, in the one tap (5), the money this phone has not settled with the card (6), and the wait of 1.17, ten signatures to
 * the first limit's worth over, where 1.13 to 1.16 asked seven (7).
 */
const crypto = require('crypto');
const { funded, newCard, why, settle, binaryLoad, history, MINT, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const count = (card, ins) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + ins).length;
const SEL = '00a4040009f0464f58594341524400';
const NOW = 1700000000;
const HEADER_HASH = 'ab'.repeat(32);
const stored = (c, key) => JSON.parse(c.storage.getItem(key) || 'null');
const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
const hexOf = (b) => Buffer.from(b).toString('hex');

/* An owner key of this test's own (P-256), to prove ownership to the model with directly, not through a phone. */
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = pair.publicKey.export({ format: 'jwk' });
const OWNER_PUB = '04' + Buffer.from(jwk.x, 'base64url').toString('hex') + Buffer.from(jwk.y, 'base64url').toString('hex');
const OTHER = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
/* The command RESET as the owner sends it, from a nonce the card gives: its proof over "FoxyCard/<label>", the nonce and `value`. */
async function resetApdu(card, o) {
  const opts = o || {};
  const nonce = (await card.send('b044000010')).slice(0, 32);
  const value = Buffer.from(opts.value || '', 'hex');
  const message = Buffer.concat([Buffer.from('FoxyCard/' + (opts.label || 'reset')), Buffer.from(nonce, 'hex'), value]);
  const sig = crypto.sign('sha256', message, { key: opts.key || pair.privateKey, dsaEncoding: 'der' });
  const data = Buffer.concat([Buffer.from([sig.length]), sig, value]);
  return 'b051' + (opts.p1 || '00') + (opts.p2 || 'ad') + ('0' + data.length.toString(16)).slice(-2) + data.toString('hex');
}
// the card’s state but for the nonce it last gave (asking for one to prove with is not a change)
const snapshot = (card) => JSON.stringify(card.state, (k, v) => (k === 'nonce' ? null : v));

/* A till (R) and a holder (H), who share a mint, and a card the holder set up: with a PIN of 1234 (`pin`), or none. `sats` on it (2,000 unless 0). */
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
  const P = await funded({}, 0);

  /* ---- 1: the card's own rules, as the model has them (the bytes) ------------------------------------------------------------ */
  {
    const fresh = newCard(P, undefined, { format: 4 });
    ok((await fresh.send(SEL)) === '01129000', 'the latest card says 1.18 when chosen');
    const before = newCard(P, undefined, { format: 4, software: 16 });
    await before.send(SEL);
    before.state.owner = OWNER_PUB;
    ok((await before.send(await resetApdu(before))) === '6d00', 'a card of 1.16 does not know the command: 6D00, and is as it was');

    const make = async () => {
      const c = newCard(P, undefined, { format: 4 });
      await c.send(SEL);
      const s = c.state;
      s.owner = OWNER_PUB; s.pin = '31323334'; s.pinState = 1; s.tries = 2;
      s.record = { set: true, unit: 0, limit: 5000, refund: '02' + '11'.repeat(32), timeKey: '00'.repeat(65), mint: MINT, design: 'ABC' };
      s.now = NOW; s.windowStart = NOW - 100; s.spent = 40; s.noPinLimit = 300; s.noPinSpent = 20; s.tapLimit = 700; s.hardest = 0x17087bc0; s.headerHash = HEADER_HASH;
      s.log.taps = 5; s.log.sats = 99; s.log.refused = 1; s.log.tampers = 1; s.log.ring[0] = { time: NOW, sats: 9, pieces: 1, refused: 0, flags: 2, told: 3 };
      s.receipts.count = 4; s.receipts.ring[0] = { time: NOW, told: 1, sats: 9, hash: 'cd'.repeat(32), out: '02' + '22'.repeat(32) };
      s.slots[3] = { status: 2, data: '00'.repeat(81) };       // a spent place
      s.changeDue = true; s.lastSig = 'ee'.repeat(64); s.openings[0] = { state: 'pending', amount: 4, keyset: '00'.repeat(8), date: 0, nonce: '11'.repeat(32), r: '22'.repeat(32) };
      return c;
    };
    const unspentSlot = (c) => { c.state.slots[5] = { status: 1, data: '00'.repeat(4) + '00'.repeat(4) + '00000040' + '00'.repeat(69) }; };

    // refusals, each leaving the card exactly as it was
    const c1 = await make();
    const was = snapshot(c1);
    { const r = await c1.send(await resetApdu(c1, { p2: '00' })); ok(r === '6b00' && snapshot(c1) === was, 'P2 other than 0xAD is 6B00', r + ' ' + (snapshot(c1) === was)); }
    ok((await c1.send(await resetApdu(c1, { p1: '01' }))) === '6b00' && snapshot(c1) === was, 'and so is P1 other than 0');
    ok((await c1.send(await resetApdu(c1, { p2: 'de' }))) === '6b00' && snapshot(c1) === was, 'and 0xDE (the lock’s) is not the reset’s');
    ok((await c1.send(await resetApdu(c1, { key: OTHER.privateKey }))) === '6a91', 'a proof by another key is 6A91');
    ok((await c1.send(await resetApdu(c1, { label: 'set-limit' }))) === '6a91', 'a proof over another label (set-limit) is 6A91');
    ok((await c1.send(await resetApdu(c1, { label: 'lock' }))) === '6a91', 'and the lock’s is');
    ok((await c1.send(await resetApdu(c1, { value: '00' }))) === '6700', 'a proof over a value is 6700: the command carries nothing else');
    ok((await c1.send('b05100ad00')).slice(-4) === '6a91', 'no proof at all is 6A91');
    c1.state.nonce = null;
    const noOwner = await make();
    noOwner.state.owner = null;
    const apdu0 = 'b05100ad' + '02' + '0100';
    ok((await noOwner.send(apdu0)) === '6a90', 'a card with no owner says so, 6A90: there is nobody to prove it');
    unspentSlot(c1);
    const withMoney = snapshot(c1);
    ok((await c1.send(await resetApdu(c1))) === '6a8d' && snapshot(c1).replace(/"nonce":"?[0-9a-f]*"?,?/, '') === withMoney.replace(/"nonce":"?[0-9a-f]*"?,?/, ''),
       'with anything unspent on it: 6A8D, as SET_CARD refuses a record on a card that is not empty');
    ok(c1.state.owner === OWNER_PUB && c1.state.slots[5].status === 1, 'and nothing is changed');

    // a locked card: the owner’s proof and the PIN verified in this tap
    const locked = await make();
    locked.state.locked = true;
    ok((await locked.send(await resetApdu(locked))) === '6982' && locked.state.owner === OWNER_PUB, 'a locked card with the proof and no PIN is 6982');
    ok((await locked.send('b0400000' + '04' + '31323334')) === '9000' && (await locked.send(await resetApdu(locked))) === '9000' && locked.state.locked === false && locked.state.owner === null,
       'with the PIN verified in the same tap it is reset, and no longer locked');
    const lockedUnspent = await make();
    lockedUnspent.state.locked = true; unspentSlot(lockedUnspent);
    await lockedUnspent.send('b0400000' + '04' + '31323334');
    ok((await lockedUnspent.send(await resetApdu(lockedUnspent))) === '6a8d', 'a locked card with the PIN and money on it is still 6A8D');
    const lockedBlocked = await make();
    lockedBlocked.state.locked = true; lockedBlocked.state.pinState = 2; lockedBlocked.state.tries = 0;
    ok((await lockedBlocked.send('b0400000' + '04' + '31323334')) === '6983' && (await lockedBlocked.send(await resetApdu(lockedBlocked))) === '6982',
       'a locked card whose PIN is blocked cannot be reset: the PIN cannot be verified');
    // and a blocked PIN is no bar to a card that is not locked, nor is a PIN not shown
    const blocked = await make();
    blocked.state.pinState = 2; blocked.state.tries = 0;
    ok((await blocked.send(await resetApdu(blocked))) === '9000' && blocked.state.pinState === 0 && blocked.state.tries === 3, 'a blocked PIN is no bar to an unlocked card: the owner is resetting, not unblocking');
    const unshown = await make();
    ok((await unshown.send(await resetApdu(unshown))) === '9000', 'and the PIN is not asked of an unlocked card');
    // spent places are no bar
    ok(unshown.state.slots.every((x) => x.status === 0 && x.data === ''), 'the place that was spent is empty too');

    // the wipe, every field read back by the commands that read it
    const c = await make();
    const oldKey = c.key;
    const info0 = await c.send('b001010000');
    c.state.verified = true;
    ok((await c.send(await resetApdu(c))) === '9000', 'the reset is taken (9000)');
    ok(c.key !== oldKey && /^0[23][0-9a-f]{64}$/.test(c.key), 'a fresh key', oldKey.slice(0, 10) + ' -> ' + c.key.slice(0, 10));
    ok((await c.send('b010000000')) === c.key + '9000', 'GET_PUBKEY says the new key');
    const info = await c.send('b001010000');
    const want = '01' + '12' + '80' + '00' + '00' + '80' + 'ff' + '00' + '04' + '03' + '00' + '00'          // version, places, none unspent or spent, 128 empty, caps, no PIN, format 4, three tries, not locked, no record
      + '00000000' + '00' + NOW.toString(16).padStart(8, '0') + '00000000' + '00000000' + '00'                // no limit, no owner, the clock kept, no window, nothing spent, no change grant
      + '00000000' + '00000000' + '00000000' + '9000';                                                         // no tap limit, no allowance, none of it spent
    ok(info === want, 'GET_INFO reads as a new card, with its clock kept', info.slice(0, 60) + ' / ' + want.slice(0, 60));
    ok(info0 !== info, 'and not as it was');
    const rec = await c.send('b016000000');
    const word = (hexText) => hexText.slice(0, -4);
    const record = word(rec);
    ok(record.substr(2, 2) === '00' && record.substr(8, 8) === '00000000' && /^0*$/.test(record.substr(14, 66)) && record.substr(80, 8) === '00000000'
       && record.substr(88, 64) === HEADER_HASH && record.substr(210, 2) === '00', 'GET_CARD: no record, no refund key, no mint; the ratchet’s bits are nothing and the last header’s hash is kept', record.slice(0, 40));
    ok(record.length === 2 * (106 + 3), 'and no design (zeros)', String(record.length));
    ok((await c.send('b018000000')) === '0'.repeat(32) + '9000', 'GET_LOG: no taps, no sats, no refusals, no tampers, no entries');
    ok((await c.send('b018010000')) === '000000009000', 'GET_LOG receipts: none');
    ok((await c.send('b019000000')) === '009000', 'GET_CHANGE: nothing in hand');
    ok((await c.send('b014000000')) === '00'.repeat(128) + '9000', 'every place is empty');
    ok((await c.send('b025000040')) === '6a88', 'there is no signature to give again');
    ok((await c.send('b044000010')) === '6a90', 'no nonce: there is no owner to answer it');
    ok((await c.send('b05100ad0200' + '00')) === '6a90', 'the old owner’s proof fails, 6A90: there is no owner to check it');
    ok(c.state.pin === null && c.state.locked === false && c.state.noPinLimit === 0 && c.state.tapLimit === 0 && c.state.record.limit === 0 && c.state.openings.every((x) => x.state === 'empty'),
       'no PIN, no lock, no allowance, no limits, no openings');
    // the card proves itself with the new key (AUTH), not the old
    const mine = crypto.randomBytes(16).toString('hex');
    const auth = (await c.send('b0150000' + '10' + mine + '50')).slice(0, -4);
    const tag = crypto.createHash('sha256').update('FoxyCard/auth').digest();
    const digest = crypto.createHash('sha256').update(Buffer.concat([tag, tag, Buffer.from(mine, 'hex'), Buffer.from(auth.slice(0, 32), 'hex'), Buffer.from(c.key, 'hex')])).digest();
    let good = false, bad = true;
    try {
      good = P.window.CashuTS.schnorrVerifyDigest(auth.slice(32), P.window.Uint8Array.from(digest), c.key) === true;
      const old = crypto.createHash('sha256').update(Buffer.concat([tag, tag, Buffer.from(mine, 'hex'), Buffer.from(auth.slice(0, 32), 'hex'), Buffer.from(oldKey, 'hex')])).digest();
      bad = P.window.CashuTS.schnorrVerifyDigest(auth.slice(32), P.window.Uint8Array.from(old), oldKey) === true;
    } catch (e) { good = false; }
    ok(good && !bad, 'AUTH is signed by the new key, and not by the old');
    // set-up afresh works as on a new card
    ok((await c.send('b0410000' + '04' + '35363738')) === '9000' && (await c.send('b0400000' + '04' + '35363738')) === '9000', 'a PIN can be set (and shown) afresh');
    // a card is never twice the same: two resets, two keys
    const d = await make();
    const e = await make();
    await d.send(await resetApdu(d)); await e.send(await resetApdu(e));
    ok(d.key !== e.key, 'and each reset gives another key');
    // reset of a reset card: no owner now
    ok((await d.send('b05100ad0200' + '00')) === '6a90', 'a card that is reset has no owner to reset it again: 6A90');
  }

  /* ---- 2: the wallet: cardReset, and what it refuses ---------------------------------------------------------------------- */
  {
    const { H, R, card } = await world('1234', { sats: 0 });
    const oldKey = card.key;
    card.state.now = NOW; card.state.headerHash = HEADER_HASH;
    // a card that is not the phone’s own, one before 1.17, one with no owner
    const O = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
    card.tap();
    const seenByOther = await why(O.W.cardReset(card));
    ok(seenByOther === 'not-owner' && card.state.owner !== null && count(card, '51') === 0, 'a phone that did not set the card up is refused, not-owner, and the card is not sent a reset', seenByOther);
    const old = newCard(H, undefined, { format: 4, software: 16 });
    await H.W.cardSetUp(old, { pin: '1234' });
    old.tap();
    ok((await why(H.W.cardReset(old))) === 'old-card' && old.state.owner !== null, 'a card of 1.16 is old-card, and nothing is sent to it');
    const nobody = newCard(H, undefined, { format: 4 });
    nobody.tap();
    ok((await why(H.W.cardReset(nobody))) === 'no-owner', 'a card with no owner is no-owner');
    card.tap();
    ok((await why(H.W.cardReset(card, { pin: '12' }))) === 'bad-pin', 'a PIN that is not 4 to 8 digits is bad-pin');
    // money on it
    await H.W.cardAdd(card, { sats: 300, owner: true });
    card.tap();
    card.sent.length = 0;
    const money = await H.W.cardReset(card).then(() => null, (e) => e);
    ok(money && money.card === 'has-money' && /Take the money off the card first\./.test(money.message) && money.sats === 300 && count(card, '51') === 0 && card.balance() === 300,
       'with money on it: has-money, “Take the money off the card first.”, the money is still there and no reset was sent', money && money.card);
    // taken off, then reset
    card.tap();
    await H.W.cardWithdraw(card, { pin: '1234' });
    await settle();
    card.tap();
    const link = { send: (a) => card.send(a), one: {} };
    const looked = await H.W.cardLook(link, { mine: true });
    ok(looked.key === oldKey && link.one.key === oldKey, 'the card is read under its key, and the read keeps it for the tap');
    card.sent.length = 0;
    const done = await H.W.cardReset(link, {});
    ok(done.reset === true && done.key === oldKey && Object.keys(done).sort().join() === 'key,reset', 'cardReset resolves { reset: true, key: <the old key> }', JSON.stringify(done));
    ok(count(card, '51') === 1 && card.sent.filter((a) => a.slice(0, 4) === 'b051')[0].slice(4, 8) === '00ad', 'one RESET was sent, with P1 0 and P2 0xAD');
    ok(link.one.key === undefined && !link.one.proved, 'and the tap’s kept key is forgotten: the next read asks the card for its new one');
    const after = await H.W.cardLook(link, { mine: true });
    ok(after.key !== oldKey && after.info.owner === false && after.info.pin === 'none' && after.info.hasRecord === false && after.info.setUp === false && after.info.tries === 3
       && after.info.limit === 0 && after.info.tapLimit === 0 && after.info.noPin.limit === 0 && after.record.mint === '' && after.record.refundKey === '' && after.balance === 0,
       'read again, it is a card out of its packet with another key', JSON.stringify([after.info.owner, after.info.pin, after.info.hasRecord, after.info.tries]));
    ok(after.info.now === NOW && after.record.headerHash === HEADER_HASH && after.info.version === '1.18', 'with its clock and its software', after.info.now + ' ' + after.info.version);
    ok(after.info.headerBits === '' && card.state.hardest === 0, 'and the ratchet let go');
    ok((await why(H.W.cardReset(card))) === 'no-owner', 'it cannot be reset again: nobody owns it');

    // a reset whose answer is lost: the card is reset all the same, and the next read says so
    const L = await world('1234', { sats: 0 });
    L.card.tap();
    L.card.loseAnswerOf('51', 1);
    const lost = await why(L.H.W.cardReset(L.card));
    L.card.tap();
    const seen = await L.H.W.cardLook(L.card, { mine: true });
    ok(lost === 'gone' && seen.info.owner === false && seen.info.hasRecord === false, 'a reset whose answer was lost: gone, and the card was reset all the same', lost);
    // the card leaves before the command: nothing happened
    const G = await world('1234', { sats: 0 });
    G.card.tap();
    G.card.leaveBefore('51', 1);
    const gone = await why(G.H.W.cardReset(G.card));
    G.card.tap();
    ok(gone === 'gone' && G.card.state.owner !== null && G.card.state.pinState === 1, 'a card that leaves before the command is gone, and is as it was');
    await settle();
  }

  /* ---- 2b: a locked card, a blocked PIN ------------------------------------------------------------------------------------ */
  {
    const { H, card } = await world('1234', { sats: 0 });
    card.state.locked = true;
    card.tap();
    card.sent.length = 0;
    const noPin = await H.W.cardReset(card).then(() => null, (e) => e);
    ok(noPin && noPin.card === 'locked' && count(card, '51') === 0 && card.state.owner !== null, 'a locked card with no PIN given: locked, before the card is sent anything', noPin && noPin.card);
    card.tap();
    const wrong = await H.W.cardReset(card, { pin: '0000' }).then(() => null, (e) => e);
    ok(wrong && wrong.card === 'wrong-pin' && wrong.tries === 2 && count(card, '51') === 0 && card.state.owner !== null, 'a wrong PIN: wrong-pin with the tries left, and no reset', wrong && wrong.card);
    // the PIN is sent, sealed, before the proof, in the same tap as the reset
    card.tap();
    card.sent.length = 0;
    const done = await H.W.cardReset(card, { pin: '1234' });
    const order = card.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));
    ok(done.reset === true && order.indexOf('40') >= 0 && order.indexOf('40') < order.indexOf('51') && order.lastIndexOf('51') === order.length - 1 && card.state.locked === false && card.state.owner === null,
       'a locked card with its PIN: the PIN is verified, then the reset, in the one tap; it is no longer locked', order.join(' '));
    ok(order.filter((x) => x === '40').length === 1 && card.sent.some((a) => a.slice(0, 6) === 'b04001'), 'and the PIN went sealed (P1 = 1), as it goes to a card that takes it so');
    // a locked card, the PIN right, but not this phone’s: the card’s own 6A91
    const W = await world('1234', { sats: 0 });
    const O = await funded({ sharedMint: W.H.mint, words: OTHER_WORDS }, 0);
    W.card.state.locked = true;
    W.card.tap();
    const other = await why(O.W.cardReset(W.card, { pin: '1234' }));
    ok(other === 'not-owner' && W.card.state.owner !== null && W.card.state.locked === true, 'a locked card, its PIN known, a phone that is not its owner: not-owner, and it stays locked', other);
    // an unlocked card with a blocked PIN: reset all the same, and it is a new card
    const B = await world('1234', { sats: 0 });
    B.card.state.pinState = 2; B.card.state.tries = 0;
    B.card.tap();
    const blocked = await B.H.W.cardReset(B.card);
    ok(blocked.reset === true && B.card.state.pinState === 0 && B.card.state.tries === 3, 'a blocked PIN is no bar to an unlocked card');
    // a locked card with a blocked PIN: the PIN cannot be verified
    const LB = await world('1234', { sats: 0 });
    LB.card.state.pinState = 2; LB.card.state.tries = 0; LB.card.state.locked = true;
    LB.card.tap();
    const lockedBlocked = await why(LB.H.W.cardReset(LB.card, { pin: '1234' }));
    ok(lockedBlocked === 'blocked' && LB.card.state.owner !== null, 'a locked card whose PIN is blocked: blocked, and it stays as it is', lockedBlocked);
    // a card with no PIN at all resets with none
    const N = await world(null, { sats: 0 });
    N.card.tap();
    const none = await N.H.W.cardReset(N.card);
    ok(none.reset === true && N.card.state.owner === null && N.card.state.pinState === 0, 'a card with no PIN is reset with none');
    await settle();
  }

  /* ---- 3: what the phone forgets, and what it keeps ------------------------------------------------------------------------ */
  {
    const { H, R, card } = await world('1234', { sats: 1500 });
    const key = card.key;
    const stranger = '02' + 'ee'.repeat(32);
    // a payment, so the card has a log and receipts, and the owner’s phone has copied them
    card.tap();
    await R.W.cardPay(card, { sats: 300, pin: '1234' });
    card.tap();
    await H.W.cardSetLimit(card, { sats: 900, tap: true, usd: 9 });
    card.tap();
    const mine = await H.W.cardLook(card, { mine: true });
    ok(H.W.cardReceipts(key).length >= 1 && H.W.cardPaceUsd(key) === 9 && mine.log && mine.log.taps >= 1, 'before: this phone has copied a receipt, noted the dollars of the limit, and read the log', H.W.cardReceipts(key).length + ' receipts');
    // notes of its own kinds, for this key and for another card
    const put = (name, value) => {
      const all = stored(H, name) || {};
      all[key] = value; all[stranger] = value;
      H.storage.setItem(name, JSON.stringify(all));
    };
    put('foxy.flashcard.lifted', { limit: 100, tap: 0, at: Date.now() });
    put('foxy.flashcard.checked', { at: Date.now(), nonces: ['x'] });
    put('foxy.flashcard.designs', 'ABC');
    put('foxy.flashcard.logseen', { taps: 3 });
    const cardsBefore = Object.keys(H.W.cardsKnown());
    card.tap();
    await H.W.cardWithdraw(card, { pin: '1234' });
    await settle();
    const heldSats = await bal(H);
    card.tap();
    await H.W.cardReset(card);
    const gone = ['foxy.flashcard.pace', 'foxy.flashcard.receipts', 'foxy.flashcard.lifted', 'foxy.flashcard.checked', 'foxy.flashcard.designs', 'foxy.flashcard.logseen']
      .every((name) => (stored(H, name) || {})[key] === undefined);
    ok(gone, 'after: the pace row, the receipts copied, the lifted-limit note, when it was checked, its design and where the log was read to are all dropped');
    const kept = ['foxy.flashcard.lifted', 'foxy.flashcard.checked', 'foxy.flashcard.designs', 'foxy.flashcard.logseen'].every((name) => (stored(H, name) || {})[stranger] !== undefined);
    ok(kept, 'and another card’s are not touched');
    ok(H.W.cardPaceUsd(key) === 0 && H.W.cardReceipts(key).length === 0, 'the dollars of the limit and the receipts read as none');
    ok(Object.keys(H.W.cardsKnown()).join() === cardsBefore.join() && H.W.cardsKnown()[key] && H.W.cardsKnown()[key].refundKey,
       'the card’s row in the cards this phone can take back stays: a piece the card signed away that nobody swapped is still this phone’s to take back after its date');
    const lines = history(H);
    ok((await bal(H)) === heldSats && lines.filter((e) => e.memo === 'from card').length >= 1,
       'the money it took off is in the history as an ordinary withdrawal, and the reset left no line of its own', lines.map((e) => e.memo).join());
    ok(H.W.cardOwed().length === 0 && H.W.cardDue().length === 0, 'nothing is owed to the old key');
    await settle();
  }

  /* ---- 4: another person sets the card up ----------------------------------------------------------------------------------- */
  {
    const { H, card } = await world('1234', { sats: 0 });
    const oldKey = card.key;
    card.tap();
    await H.W.cardReset(card);
    const O = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 4000);
    card.tap();
    const made = await O.W.cardSetUp(card, { pin: '5678', recoverable: true });
    ok(made.info.owner === true && made.mine === true && made.key !== oldKey && made.record.mint === MINT && made.info.pin === 'set', 'another person sets it up, as on a card out of its packet, under its new key', made.key.slice(0, 10));
    card.tap();
    await O.W.cardAdd(card, { sats: 1000, owner: true });
    card.tap();
    ok((await why(H.W.cardChangePin(card, { newPin: '1111' }))) === 'not-owner', 'the old owner’s phone cannot change its PIN: not-owner');
    card.tap();
    ok((await why(H.W.cardSetLimit(card, { sats: 100 }))) === 'not-owner', 'nor its limit');
    card.tap();
    const seen = await H.W.cardLook(card, { mine: true });
    ok(seen.mine === false && !H.W.cardsKnown()[card.key], 'and reads it as somebody else’s: not mine, and not one of the cards it can take back');
    card.tap();
    ok((await why(H.W.cardReset(card))) === 'not-owner', 'nor can it reset it');
    card.tap();
    ok((await O.W.cardChangePin(card, { newPin: '9999' })) === true, 'the new owner can');
    // set up again by the same words: a card with another key is another card to the phone (another owner key, another refund key)
    const again = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(again, { pin: '1234', recoverable: true });
    again.tap();
    const first = await H.W.cardLook(again, { mine: true });
    await H.W.cardReset(again);
    again.tap();
    await H.W.cardSetUp(again, { pin: '1234', recoverable: true });
    again.tap();
    const second = await H.W.cardLook(again, { mine: true });
    ok(first.key !== second.key && second.mine === true && H.W.cardsKnown()[first.key].refundKey !== H.W.cardsKnown()[second.key].refundKey,
       'the same phone setting up the same card again finds it a new card: another key, another owner key, another key to take its money back with');
    await settle();
  }

  /* ---- 5: the money comes off first, in the one tap ------------------------------------------------------------------------- */
  {
    const { H, card } = await world('1234', { sats: 2000 });
    const before = await bal(H);
    const steps = [];
    card.tap();
    card.sent.length = 0;
    const done = await H.W.cardEmptyAndReset(card, { pin: '1234', on: (s) => steps.push(s) });
    const after = await bal(H);
    const order = card.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));
    ok(done.reset === true && done.withdrew > 0 && done.withdrew === after - before && done.withdrew <= 2000 && card.state.owner === null && card.balance() === 0,
       'a card holding money: all of it comes off to this phone and the card is reset, in the one call', 'withdrew ' + done.withdrew + ' of 2000, phone ' + before + ' -> ' + after);
    ok(order.indexOf('24') > 0 && order.indexOf('24') < order.lastIndexOf('51') && count(card, '24') >= 1 && count(card, '51') === 1, 'the card signed for its money before it was reset', order.join(' '));
    ok(steps.length > 0 && steps[0] === 'reading', 'the sheet’s steps are the withdrawal’s', steps.join(' '));
    ok(history(H).filter((e) => e.memo === 'from card').length === 1, 'the withdrawal is an ordinary history line');
    // an empty card: no withdrawal
    const E = await world('1234', { sats: 0 });
    E.card.tap();
    const none = await E.H.W.cardEmptyAndReset(E.card, { pin: '1234' });
    ok(none.reset === true && none.withdrew === 0 && count(E.card, '24') === 0, 'an empty card is just reset: withdrew 0, nothing signed');
    // no PIN given to a card that asks for it: nothing moves
    const A = await world('1234', { sats: 2000 });
    A.card.tap();
    const askedPin = await why(A.H.W.cardEmptyAndReset(A.card));
    ok(askedPin === 'pin-needed' && A.card.balance() === 2000 && A.card.state.owner !== null, 'the PIN is wanted and not given: pin-needed, and the money is still on the card', askedPin);
    A.card.tap();
    const wrongPin = await why(A.H.W.cardEmptyAndReset(A.card, { pin: '0000' }));
    ok(wrongPin === 'wrong-pin' && A.card.balance() === 2000, 'a wrong PIN: wrong-pin, and the money is still on the card');
    // checked before the money is moved
    A.card.tap();
    const O = await funded({ sharedMint: A.H.mint, words: OTHER_WORDS }, 0);
    const notMine = await why(O.W.cardEmptyAndReset(A.card, { pin: '1234' }));
    ok(notMine === 'not-owner' && A.card.balance() === 2000 && count(A.card, '24') === 0, 'a phone that is not the owner: not-owner, and the card is not emptied', notMine);
    const oldMoney = newCard(A.H, undefined, { format: 4, software: 16 });
    await A.H.W.cardSetUp(oldMoney, { pin: '1234', recoverable: true });
    oldMoney.tap();
    await A.H.W.cardAdd(oldMoney, { sats: 500, owner: true });
    oldMoney.tap();
    const oldCard = await why(A.H.W.cardEmptyAndReset(oldMoney, { pin: '1234' }));
    ok(oldCard === 'old-card' && oldMoney.balance() === 500, 'a card of 1.16: old-card, and its money is not touched', oldCard);
    // a locked card with money: the PIN is wanted before anything moves
    const K = await world('1234', { sats: 1000 });
    K.card.state.locked = true;
    K.card.tap();
    const lockedNo = await why(K.H.W.cardEmptyAndReset(K.card));
    ok(lockedNo === 'locked' && K.card.balance() === 1000 && count(K.card, '24') === 0, 'a locked card with money and no PIN given: locked, and nothing moves', lockedNo);
    K.card.tap();
    const lockedYes = await K.H.W.cardEmptyAndReset(K.card, { pin: '1234' });
    ok(lockedYes.reset === true && lockedYes.withdrew > 0 && K.card.state.locked === false && K.card.state.owner === null && K.card.balance() === 0,
       'a locked card with money and its PIN: the money comes off, then the reset, and the lock is gone');
    // the card leaves between the money and the reset: the money is safe, and the next tap resets it
    const C = await world('1234', { sats: 1000 });
    C.card.tap();
    C.card.leaveBefore('51', 1);
    const had = await bal(C.H);
    const cut = await C.H.W.cardEmptyAndReset(C.card, { pin: '1234' }).then(() => null, (e) => e);
    ok(cut && cut.card === 'gone' && cut.withdrew > 0 && cut.withdrew === (await bal(C.H)) - had && C.card.state.owner !== null && C.card.balance() === 0,
       'the card leaves before the reset: gone, with how much came off (`withdrew`), the money is on the phone and the card is empty', cut && (cut.card + ' ' + cut.withdrew));
    C.card.tap();
    const next = await C.H.W.cardReset(C.card);
    ok(next.reset === true && C.card.state.owner === null, 'and the next tap resets it');
    await settle();
  }

  /* ---- 6: money this phone has not settled with the card ------------------------------------------------------------------- */
  {
    // a row of ecash made for the card and not yet written to it: it is locked to the old key, which nothing could write to the card again
    const { H, card } = await world('1234', { sats: 0 });
    const key = card.key;
    const rows = [{ id: 'row-1', card: key, token: 'cashuB-x', sats: 64, kind: 'load', forHash: 'h1', at: Date.now() }];
    H.storage.setItem('foxy.flashcard.owed', JSON.stringify(rows));
    card.tap();
    card.sent.length = 0;
    const refused = await H.W.cardReset(card).then(() => null, (e) => e);
    ok(refused && refused.card === 'unsettled' && refused.owes.owed === 1 && refused.sats === 64 && count(card, '51') === 0 && card.state.owner !== null && stored(H, 'foxy.flashcard.owed').length === 1,
       'ecash owed to the card: unsettled, and nothing is changed (the row, the card)', refused && JSON.stringify(refused.owes));
    card.tap();
    const gives = await H.W.cardReset(card, { abandon: true });
    ok(gives.reset === true && stored(H, 'foxy.flashcard.owed').length === 0 && card.state.owner === null, '`abandon` resets all the same, and the row owed to the old key is dropped');
    // a signature asked of the card and never seen
    const S = await world('1234', { sats: 0 });
    S.H.storage.setItem('foxy.flashcard.swaps', JSON.stringify([{ id: 's1', asked: { card: S.card.key, proofs: [{ id: 'x', amount: 1, secret: 'y', C: 'z' }] } }]));
    S.card.tap();
    const asked = await S.H.W.cardReset(S.card).then(() => null, (e) => e);
    ok(asked && asked.card === 'unsettled' && asked.owes.asked === 1 && S.card.state.owner !== null, 'a signature asked of the card and not seen: unsettled');
    // change the card made for itself and nobody has fetched (the till’s phone died), with no road to the mint: the openings are all that is left of it
    const W = await world('1234', { sats: 0 });
    await binaryLoad(W.H, W.card, 2000);
    W.card.tap();
    const paid = await W.R.W.cardPay(W.card, { sats: 1000, pin: '1234' });
    const openings = W.card.state.openings.filter((x) => x.state === 'pending').length;
    W.R.storage.setItem('foxy.flashcard.owed', '[]');
    ok(paid.sats === 1000 && openings > 0 && paid.change.written === false, 'a payment whose change the till never wrote back: the card holds its openings', openings + ' openings');
    offline(W.H.W);
    W.card.tap();
    W.card.sent.length = 0;
    const heldBack = W.card.balance();
    const offlineRefusal = await W.H.W.cardEmptyAndReset(W.card, { pin: '1234' }).then(() => null, (e) => e);
    ok(offlineRefusal && offlineRefusal.card === 'change-owed' && W.card.state.owner !== null && count(W.card, '51') === 0 && count(W.card, '24') === 0 && W.card.balance() === heldBack,
       'with the mint out of reach the change cannot be fetched, and the card is not reset: it would forget what the mint’s signatures are unblinded with', offlineRefusal && (offlineRefusal.card + ' ' + JSON.stringify(offlineRefusal.owes || {})));
    ok(offlineRefusal && /owed change from its last payment\. Tap it once more first\./.test(offlineRefusal.message) && offlineRefusal.owes.openings === openings, '“The card is owed change from its last payment. Tap it once more first.”, and `owes.openings` says how many', offlineRefusal && JSON.stringify(offlineRefusal.owes));
    online(W.H.W);
    W.card.tap();
    // with the road back, the owner’s phone fetches the change and puts it on, so there is money to take off: has-money for cardReset, and cardEmptyAndReset takes it all
    const total = W.card.balance();
    const collected = await W.H.W.cardEmptyAndReset(W.card, { pin: '1234' });
    ok(collected.reset === true && collected.withdrew > 0 && W.card.state.owner === null && W.card.balance() === 0 && W.card.state.openings.every((x) => x.state === 'empty'),
       'with the mint in reach, cardEmptyAndReset fetches the change too, puts it on, takes all of it off and resets the card', 'withdrew ' + collected.withdrew + ' of ' + (total + (paid.change.sats || 0)));
    await settle();
  }

  /* ---- 7: the wait of 1.17: ten signatures for the first limit's worth over, where 1.13 to 1.16 asked seven --------------- */
  {
    const info = (W, v) => W.cardParse.info('01' + v + '80' + '00' + '00' + '80' + 'ff' + '01' + '04' + '03' + '00' + '01' + '00000000' + '01' + '00000000'.repeat(3) + '00' + '00000000'.repeat(3));
    ok(info(P.W, '12').waitMore === 4 && info(P.W, '11').waitMore === 3 && info(P.W, '10').waitMore === 3 && info(P.W, '12').waitOver === 10, 'and each further limit’s worth waits 4 on 1.18 and 3 before');
    ok(info(P.W, '11').waitOver === 10 && info(P.W, '10').waitOver === 7 && info(P.W, '0f').waitOver === 7 && info(P.W, '0d').waitOver === 7,
       'GET_INFO’s version says it: the first limit’s worth over waits 10 on 1.17 and 7 on 1.13 to 1.16', [info(P.W, '11').waitOver, info(P.W, '10').waitOver].join());
    // the wallet’s sums: a limit of 100 and a payment that leaves 250 is three limits’ worth, the first over (+ one further)
    ok(P.W.cardWaitSigns(100, 250, 0, false, true, 10) === 13 && P.W.cardWaitSigns(100, 250, 0, false, true, 7) === 10 && P.W.cardWaitSigns(100, 250, 0, false, true) === 10,
       'cardWaitSigns takes the first count: 10 + 3 = 13 on 1.17, 7 + 3 = 10 before it (and before it is the default)');
    ok(P.W.cardWaitSigns(100, 150, 0, false, true, 10) === 10 && P.W.cardWaitSigns(100, 150, 0, false, true, 7) === 7 && P.W.cardWaitSigns(100, 100, 0, false, true, 10) === 0,
       'one limit’s worth over: 10 (7), and none within the limit');
    ok(P.W.cardWaitSigns(0, 50, 0, true, true, 10) === 10 && P.W.cardWaitSigns(0, 50, 0, true, true, 7) === 7 && P.W.cardWaitSigns(0, 50, 0, false, true, 10) === 0,
       'a second payment in the same time in the field, with no limit set, waits the first count; the first does not');
    ok(P.W.cardWait(100, 150, 0, false, true, 10) > P.W.cardWait(100, 150, 0, false, true, 7), 'and the seconds follow');

    // the model card: what it actually waits, and what the wallet said beforehand
    const run = async (software) => {
      const w = await world('1234', { sats: 0, card: software ? { software } : {} });
      await binaryLoad(w.H, w.card, 3000);
      w.card.tap();
      await w.H.W.cardSetLimit(w.card, { sats: 200, tap: true });
      w.card.tap();
      w.card.state.waited = 0;
      const paid = await w.R.W.cardPay(w.card, { sats: 500, pin: '1234' });
      return { waited: w.card.state.waited, paid, version: w.card.version };
    };
    const now = await run(), then = await run(16);
    ok(now.version === 18 && then.version === 16 && now.paid.sats === 500 && then.paid.sats === 500, 'a payment of 500 against a limit of 200, on the card of 1.18 and on the card of 1.16');
    ok(now.waited - then.waited === 4 && now.waited === 13 && then.waited === 9, 'the model card of 1.18 waits four more askings than the one of 1.16 for the same payment: ten and four against seven and three, less a wait each for the change it made', now.waited + ' and ' + then.waited);
    // the wait itself, at the byte: a payment begun and signed against a limit, counted by the answers 0001
    const c = newCard(P, undefined, { format: 4 });
    const c16 = newCard(P, undefined, { format: 4, software: 16 });
    const asks = async (card) => {
      await card.send(SEL);
      card.state.pinState = 0; card.state.tapLimit = 100;
      card.state.slots[0] = { status: 1, data: '00'.repeat(4) + '00'.repeat(4) + '00000096' + '00'.repeat(69) };       // 150 sats: one limit’s worth over
      await card.send('b0220000' + '01' + '00');
      let n = 0;
      for (let i = 0; i < 40; i++) { const r = await card.send('b024000040'); if (r.slice(0, 4) === '0001' && r.length === 8) n += 1; else break; }
      return n;
    };
    const w17 = await asks(c), w16 = await asks(c16);
    ok(w17 === 10 && w16 === 7, 'at the byte: one limit’s worth over the limit is 10 answers of “not yet” on 1.17 and 7 on 1.16', w17 + ' and ' + w16);
    await settle();
  }

  console.log('\n' + (failed ? failed + ' flashcard-reset check(s) failed' : 'all flashcard-reset checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
