'use strict';
/* store-full.js — a full store must never cost money.
 *
 *     node tests/store-full.js
 *
 * WebKit refuses a localStorage write that would take a page's store past
 * about 5 MB. On a phone whose history had filled it, a locked card top-up's
 * swap went to the mint with its locked outputs written nowhere (the refusal
 * was caught and logged), the mint answered, the record was let go, and the
 * one write that held the token was refused: the payment in a local variable,
 * and then nowhere. A P2PK output's nonce and blinding factor are random, so
 * no seed restore finds them.
 *
 * Here the page's store refuses writes past a byte cap, measured as the
 * WebKit and the wallet measure it (`storeBytes`: key and value, one byte a character for a string of
 * characters at or below U+00FF, two for any other),
 * with WebKit's error. With the store filled to just under that cap, and
 * again exactly at it, every money path is run against the harness's mint:
 * a send, a locked send, a card top-up (the card model), an import, a
 * receive, a Lightning payment and a claim. Each either completes with every
 * proof accounted for (the books: tests/harness.js) or is refused as never
 * sent, with nothing asked of the mint (no swap, melt or mint request left)
 * and every piece it would have spent still unspent there. Once with history
 * that the wallet may trim (claimed tokens' text, the audit trail), once with
 * room nothing can make, and once with the wallet's own room check out of
 * the way, so the gates behind it are the ones that answer.
 *
 * Then the incident itself (the locked record's write refused: no request),
 * the token's write refused after the swap (retried once room is made; a
 * plain send's pieces back in the balance; a locked send's record kept and
 * the payment rebuilt by a relaunch), a relaunch that finds a finished send's
 * record beside its token (let go, nothing added), the trim keeping what it
 * must, and the room check refusing before a send. It prints what each
 * operation adds to the store at its peak, which is what `STORE_ROOM` in
 * build/wallet/01-storage-and-piles.js is set from.
 */
const crypto = require('crypto');
const { page, funded, newCard, MINT, OTHER_WORDS } = require('./flashcard-kit');
const { noBooks, booksWrong, nativePhone, PHONE_WORDS } = require('./harness');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};

/* WebKit's own cap, as the wallet measures: 5 × 2^20 bytes. The wallet's is
 * half a megabyte short of it (`STORE_CAP_BYTES`). */
const CAP = 5 * 1024 * 1024;
const WALLET_CAP = Math.round(4.5 * 1024 * 1024);
// one string as WebKit counts it: a byte a character when every character is at or below U+00FF, else two
const wk = (s) => s.length * (/[^\u0000-\u00ff]/.test(s) ? 2 : 1);
const HOLD = 'foxy.store.hold.';
const RESERVE = 'foxy.store.reserve';
// `noReserve`: what is in use, the store's standing reserve left out (it is room kept, not room used: `growReserve`)
const bytesOf = (st, noReserve) => {
  let n = 0;
  for (let i = 0; i < st.length; i++) { const k = st.key(i); if (noReserve && (k === RESERVE || k.indexOf(HOLD) === 0)) continue; n += wk(k) + wk(st.getItem(k) || ''); }
  return n;
};
const get = (c, k, d) => { try { const v = JSON.parse(c.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const MONEY = /^mint \/v1\/(swap|melt\/(?!quote)|mint\/(?!quote))/;
const moneyAsked = (c, from) => c.trace.slice(from).filter((t) => MONEY.test(t));
const key = () => { const e = crypto.createECDH('secp256k1'); e.generateKeys(); return e.getPublicKey('hex', 'compressed'); };
const quiet = () => new Promise((r) => setTimeout(r, 30));
// an error thrown in the page is of the page's Error, not this one's: told by its shape
const isErr = (x) => !!(x && typeof x === 'object' && typeof x.message === 'string' && typeof x.stack === 'string');

/* The page's store refuses, as WebKit does, a write that would take it past
 * `c.cap` (0: no cap), and any write `c.refuse(key, value)` says to refuse.
 * Each page is a window of its own, with its own Storage. `c.peak` is the most
 * the store held since `c.peak` was last set to 0. */
function capped(c) {
  const proto = c.window.Storage.prototype;
  const set = proto.setItem;
  c.cap = 0;
  c.refuse = null;
  c.refused = [];
  c.peak = 0;
  proto.setItem = function (k, v) {
    const name = String(k), val = String(v);
    const quota = () => {
      c.refused.push(name);
      throw new c.window.DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    if (c.refuse && c.refuse(name, val)) quota();
    if (c.cap) {
      const old = this.getItem(name);
      const next = bytesOf(this) - (old === null ? 0 : wk(name) + wk(old)) + wk(name) + wk(val);
      if (next > c.cap) quota();
    }
    const r = set.call(this, name, val);
    // what the operation's own writes add: the store's reserve is not one of them
    const now = bytesOf(this, true);
    if (now > c.peak) c.peak = now;
    return r;
  };
  return c;
}

/* Filled with what nothing can trim, to exactly `target` bytes: of the whole store, or (`inUse`) of what is in use, the
 * store's reserve left out, as the wallet's own room check counts. */
function fillDead(c, target, inUse) {
  const st = c.storage;
  const was = c.cap; c.cap = 0;
  st.removeItem('test.filler');
  const room = target - bytesOf(st, !!inUse) - wk('test.filler');
  if (room > 0) st.setItem('test.filler', 'z'.repeat(Math.floor(room)));
  c.cap = was;
}

/* Filled with history the wallet may let go: claimed tokens' text on their
 * notes (`kept`), and dead filler for what is left to make `target`. */
function fillHistory(c, target) {
  const was = c.cap; c.cap = 0;
  const meta = get(c, 'foxy.txmeta', {});
  for (let i = 0; i < 60; i++) meta['old-' + i] = { kept: 'cashuB' + 'k'.repeat(30000) + i, note: 'n' + i };
  c.storage.setItem('foxy.txmeta', JSON.stringify(meta));
  c.cap = was;
  fillDead(c, target);
}

/* The page launched again over what `c` left in its store: the same phone's
 * counters and lock keys, the same mint, and books judged from nothing (so a
 * payment rebuilt here must account for itself whole). */
function relaunch(c) {
  const all = {};
  for (let i = 0; i < c.storage.length; i++) { const k = c.storage.key(i); all[k] = c.storage.getItem(k); }
  const phone = nativePhone({ words: PHONE_WORDS });
  phone.counters = c.phone.counters;
  phone.locks = c.phone.locks;
  const again = page({ storage: all, phone, sharedMint: c.mint });
  again.booksFrom = {};
  return again;
}

/* A page with money, a card set up on it, a token from a second phone to take
 * in, an invoice of the second phone's to pay, and one of its own paid and not
 * claimed. */
async function world(o) {
  const H = capped(await funded({}, 30000));
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 6000);
  H.card = newCard(H);
  await H.W.cardSetUp(H.card, { pin: '1234', recoverable: true });
  /* `o.full`: a second card with money on it, to be taken off (the withdrawal: the card signs). Only where it is wanted: its
   * top-up reshapes the pile, after which a send is made of pieces on hand and asks the mint nothing. */
  H.full = newCard(H);
  if (o && o.full) {
    await H.W.cardSetUp(H.full, { pin: '1234', recoverable: true });
    H.full.tap();
    await H.W.cardAdd(H.full, { sats: 5000, pin: '1234' });
  }
  H.tokenIn = (await R.W.sendToken(400)).token;
  H.tokenIn2 = (await R.W.sendToken(300)).token;
  H.invoiceOut = (await R.W.invoice(500, '')).bolt11;
  H.quoteIn = (await H.W.invoice(800, '')).hash;
  H.R = R;
  return H;
}

const PATHS = {
  send: (c) => c.W.sendToken(777),
  'locked send': (c) => c.W.sendToken(21, { lockTo: key() }),
  'card top-up': async (c) => { c.card.tap(); const seen = await c.W.cardLook(c.card); return c.W.cardPrepare(seen, 3000); },
  'import (a swap)': (c) => Promise.resolve().then(() => c.W.importProofs(c.tokenIn2)),
  receive: (c) => c.W.receiveToken(c.tokenIn),
  'Lightning payment': (c) => c.W.pay(c.invoiceOut, () => {}),
  claim: (c) => c.W.claim(c.quoteIn),
  'card withdrawal': (c) => { c.full.tap(); return c.W.cardWithdraw(c.full, { pin: '1234' }); },
};
// what a card is asked to sign or spend with: SPEND, BEGIN, the outputs, SIGN_ALL, again, change (`CARD_INS`)
const SIGNS = /^b0(20|22|23|24|25|26)/;
const signsAsked = (card, from) => card.sent.slice(from).filter((a) => SIGNS.test(a));

/* The pieces the page holds, each asked of the mint: none of them spent. */
const pileUnspent = (c, pile) => pile.every((p) => c.mint.spentSecrets.indexOf(String(p.secret)) < 0);

/* One path on one page, judged: completed with the books adding up, or refused
 * as never sent with nothing asked of the mint and the pile as it was. */
async function judge(c, name, how) {
  const pile = get(c, 'foxy.cashu.proofs.' + MINT, []);
  const before = await c.W.balanceSats();
  const from = c.trace.length;
  const onCard = c.full.balance(), cardFrom = c.full.sent.length;
  let got = null, threw = null;
  try { got = await PATHS[name](c); } catch (e) { threw = e; }
  await quiet();
  const after = await c.W.balanceSats();
  if (threw) {
    const asked = moneyAsked(c, from);
    const never = !!(threw.unsent || (c.W.neverSent && c.W.neverSent(threw)));
    ok(never && !asked.length && after === before && pileUnspent(c, pile)
       && JSON.stringify(get(c, 'foxy.cashu.proofs.' + MINT, [])) === JSON.stringify(pile),
       how + ': ' + name + ' is refused as never sent, and the mint saw nothing',
       String(threw.message).slice(0, 110) + (asked.length ? '; asked ' + asked.join(', ') : '') + (after !== before ? '; balance ' + before + ' -> ' + after : ''));
    if (threw.storageFull) ok(/storage/i.test(threw.message) && /Clearing history/.test(threw.message), how + ': ' + name + ': the words say the storage is full and what to do');
    if (name === 'card withdrawal') {
      ok(threw.card === 'storage-full' && c.full.balance() === onCard && !signsAsked(c.full, cardFrom).length,
         how + ': the card is asked to sign nothing, and keeps all of its money', threw.card + ', ' + signsAsked(c.full, cardFrom).length + ' signing command(s)');
    }
    const off = booksWrong(c);
    ok(!off.length, how + ': ' + name + ': refused, and the books are as they were', off.join('; '));
    return { refused: true, threw };
  }
  /* An import writes no history entry (a backup is not a payment), so it is
   * judged by what it adds: the token's pieces, less nothing at this mint. */
  if (/^import/.test(name)) {
    noBooks(c, 'an import writes no entry');
    ok(after - before === c.W.tokenInfo(c.tokenIn2).sats, how + ': ' + name + ' completes, and adds what it imported', before + ' -> ' + after);
    return { refused: false, got };
  }
  const wrong = booksWrong(c);
  ok(!wrong.length, how + ': ' + name + ' completes, and every proof is accounted for', wrong.join('; ') || ('balance ' + before + ' -> ' + after));
  return { refused: false, got };
}

(async () => {
  /* ---- what each operation adds at its peak (the room it is given) --------------------------------------- */
  {
    const c = await world();
    const room = c.W._storeRoom;
    const peaks = {};
    for (const [name, kind] of [['send', 'swap'], ['locked send', 'swap'], ['card top-up', 'swap'], ['receive', 'swap'], ['Lightning payment', 'melt'], ['claim', 'mint']]) {
      const start = bytesOf(c.storage, true);
      c.peak = 0;
      await PATHS[name](c);
      peaks[name] = Math.max(0, c.peak - start);
      ok(peaks[name] <= room[kind], 'the room for a ' + kind + ' (' + room[kind] + ' bytes) holds what a ' + name + ' adds at its peak', peaks[name] + ' bytes');
    }
    // a card's top-up as large as a phone makes them: 52 locked pieces
    const den = []; for (let i = 0; i < 52; i++) den.push(1 << (i % 10));
    const start = bytesOf(c.storage, true);
    c.peak = 0;
    const big = await c.W.sendToken(den.reduce((a, b) => a + b, 0), { lockTo: key(), denominations: den });
    peaks['52 locked pieces'] = c.peak - start;
    ok(peaks['52 locked pieces'] <= room.swap && c.W.tokenInfo(big.token).proofs.length === 52,
       'and a locked send of 52 pieces, a card top-up’s size', peaks['52 locked pieces'] + ' bytes at its peak; the token ' + wk(big.token) + ' bytes');
    console.log('      peaks: ' + JSON.stringify(peaks));
  }
  // a card's withdrawal: the tap's own writes, which `STORE_ROOM.card` holds with a swap's room on top
  {
    const c = await world({ full: true });
    const room = c.W._storeRoom;
    const start = bytesOf(c.storage, true);
    c.peak = 0;
    c.full.tap();
    await c.W.cardWithdraw(c.full, { pin: '1234' });
    const peak = c.peak - start;
    ok(peak + room.swap <= room.card, 'the room for a card\u2019s tap (' + room.card + ' bytes) holds what a withdrawal adds and a swap\u2019s room on top', peak + ' bytes at its peak');
  }

  /* ---- every money path, the store just under the cap and exactly at it ---------------------------------- */
  for (const pass of [
    { how: 'history just under the cap', fill: (c) => fillHistory(c, CAP - 4096), expect: 'complete' },
    { how: 'history exactly at the cap', fill: (c) => fillHistory(c, CAP), expect: 'complete' },
    { how: 'no room to make, just under the cap', fill: (c) => fillDead(c, CAP - 4096), expect: 'refused' },
    { how: 'no room to make, exactly at the cap', fill: (c) => fillDead(c, CAP), expect: 'refused' },
    // the wallet's own room check out of the way: what stops it is the record that cannot be written, at the gate where it leaves
    { how: 'past the room check, exactly at the cap', fill: (c) => { c.W._storeCap = 1e12; fillDead(c, CAP); }, expect: 'either' },
  ]) {
    /* Not the card's withdrawal past the room check: once a card has signed it will not sign again, so its tap is refused
     * before the card is read (`cardRoom`) and nothing after the signature may be refused. That is the room check's to keep,
     * and below it is asked with no room for the signed pieces' row, and with room only once history is trimmed. */
    for (const name of Object.keys(PATHS).filter((n) => !(pass.expect === 'either' && n === 'card withdrawal'))) {
      const c = await world({ full: name === 'card withdrawal' });
      c.cap = CAP;
      pass.fill(c);
      const r = await judge(c, name, pass.how);
      if (pass.expect === 'complete') ok(!r.refused, pass.how + ': ' + name + ' goes through once room is made from history', r.threw ? String(r.threw.message).slice(0, 100) : '');
      // (a claim needs the least room of all, and with the reserve whole it may go: what it then writes the reserve answers)
      /* (the kinds that need little may go on what is left, a claim, a melt, a receive or import, a plain send: with the
       * reserve whole, what they write after their step is answered for. A locked swap and a card's tap need the most, and wait.) */
      if (pass.expect === 'refused' && ['locked send', 'card top-up', 'card withdrawal'].indexOf(name) >= 0) ok(r.refused, pass.how + ': ' + name + ' is not sent');
      if (!r.refused) ok(!get(c, 'foxy.cashu.swaps', []).length, pass.how + ': ' + name + ' leaves no swap record behind');
    }
  }

  /* ---- the incident: the locked record's write refused, and no request ----------------------------------- */
  for (const name of ['card top-up', 'locked send']) {
    const c = await world();
    c.refuse = (k) => k === 'foxy.cashu.swaps';
    const pile = get(c, 'foxy.cashu.proofs.' + MINT, []);
    const before = await c.W.balanceSats();
    const from = c.trace.length;
    const e = await PATHS[name](c).then(() => null, (x) => x);
    await quiet();
    ok(!!e && !!e.unsent && !moneyAsked(c, from).length && (await c.W.balanceSats()) === before && pileUnspent(c, pile)
       && !get(c, 'foxy.flashcard.owed', []).length && !get(c, 'foxy.cashu.outtoken', null),
       'the ' + name + ' whose locked outputs cannot be written down is never sent', e ? String(e.message).slice(0, 90) : 'it went through');
    c.refuse = null;
    const again = await PATHS[name](c).then((r) => r, (x) => x);
    ok(again && !isErr(again), 'and with room it goes', isErr(again) ? again.message : '');
  }

  /* ---- the writes cashu-ts makes in its own callback: a melt's change and a claim's ranges ------------------ */
  {
    const c = await world();
    // the hold is written; its change's counters, as cashu-ts reserves them, are not
    c.refuse = (k, v) => k === 'foxy.cashu.melting' && /"outputs":\[\{/.test(v);
    const before = await c.W.balanceSats();
    const from = c.trace.length;
    const e = await c.W.pay(c.invoiceOut, () => {}).then(() => null, (x) => x);
    await quiet();
    const asked = c.trace.slice(from);
    ok(!!e && e.unsent && asked.indexOf('mint /v1/melt/bolt11') < 0 && (await c.W.balanceSats()) === before
       && !get(c, 'foxy.cashu.melting', []).length && !booksWrong(c).length,
       'a Lightning payment whose change cannot be named on its hold is not sent, and its pieces are back',
       e ? e.message.slice(0, 80) + '; asked ' + asked.join(', ') : 'it went through');
  }
  {
    const c = await world();
    c.refuse = (k, v) => k === 'foxy.cashu.quotes' && /"outputs":\[\{/.test(v);
    const before = await c.W.balanceSats();
    const from = c.trace.length;
    const e = await c.W.claim(c.quoteIn).then(() => null, (x) => x);
    await quiet();
    const asked = c.trace.slice(from);
    const q = get(c, 'foxy.cashu.quotes', []).filter((r) => r.quote === c.quoteIn)[0];
    ok(!!e && e.unsent && asked.indexOf('mint /v1/mint/bolt11') < 0 && (await c.W.balanceSats()) === before && !!q
       && !(q.unclaimed && q.unclaimed.tries), 'a claim whose counters cannot go on its invoice is not sent, and spends none of its tries',
       e ? e.message.slice(0, 80) + '; asked ' + asked.join(', ') : 'it went through');
    c.refuse = null;
    ok((await c.W.claim(c.quoteIn)) === 800, 'and with room it is claimed');
  }

  /* ---- a card's signature with no room for what follows it ------------------------------------------------- */
  // the phone that lost a withdrawal of 57 pieces this way: the card signed, foxy.flashcard.taken was refused, no swap went
  {
    const c = await world({ full: true });
    const room = c.W._storeRoom;
    // room for a swap, not for a card's tap and the swap after it
    fillDead(c, WALLET_CAP - room.swap - 64 * 1024, true);
    c.cap = CAP;
    const onCard = c.full.balance(), cardFrom = c.full.sent.length, from = c.trace.length, before = await c.W.balanceSats();
    c.full.tap();
    const e = await c.W.cardWithdraw(c.full, { pin: '1234' }).then(() => null, (x) => x);
    ok(!!e && e.card === 'storage-full' && e.unsent && !c.full.sent.slice(cardFrom).length && c.full.balance() === onCard
       && !c.trace.slice(from).length && (await c.W.balanceSats()) === before,
       'a withdrawal with no room for what follows the card’s signature is refused before the card is read: nothing sent to the card or the mint',
       e ? e.card + ': ' + e.message.slice(0, 90) : 'it went through');
    ok(/storage on this phone is full/.test(e && e.message) && /card was asked for nothing/.test(e && e.message), 'in words that say the card was asked nothing', e && e.message);
    // a till's payment by the card, the same
    c.full.tap();
    const paid = await c.W.cardPay(c.full, { sats: 100, pin: '1234' }).then(() => null, (x) => x);
    ok(!!paid && paid.card === 'storage-full' && c.full.balance() === onCard && !signsAsked(c.full, cardFrom).length,
       'and so is a payment to a till: the card signs nothing', paid ? paid.card : 'it went through');
    // and a take-back with this phone's key (nothing due yet, but asked first: room comes before anything is signed)
    const back = await c.W.cardTakeBack(c.full.key).then(() => null, (x) => x);
    ok(!!back && back.card === 'storage-full', 'and a take-back of a lost card', back ? back.card : 'it went through');
  }
  // room only once history is trimmed: the signed pieces' row is refused once, room is made, and it is written
  {
    const c = await world({ full: true });
    c.W._storeCap = 1e12;
    fillHistory(c, CAP - 8192);
    const full = bytesOf(c.storage) - 200000;
    c.refuse = (k) => k === 'foxy.flashcard.taken' && bytesOf(c.storage) > full;
    const before = await c.W.balanceSats(), onCard = c.full.balance();
    c.full.tap();
    const got = await c.W.cardWithdraw(c.full, { pin: '1234' }).then((r) => r, (x) => x);
    await quiet();
    ok(got && !isErr(got) && c.refused.indexOf('foxy.flashcard.taken') >= 0 && c.full.balance() === 0
       && (await c.W.balanceSats()) === before + onCard && !get(c, 'foxy.flashcard.taken', []).length && !booksWrong(c).length,
       'a withdrawal whose signed pieces’ row is refused once is written after history is trimmed, and the swap goes: all of it is in the balance',
       isErr(got) ? got.message : 'balance ' + before + ' -> ' + 'card ' + c.full.balance());
  }

  /* ---- the store's reserve: a refused write after a step that cannot be undone is impossible ------------------ */
  /* From the moment the step is reached (the card asked to sign, the swap or the melt leaving), the stub refuses every write
   * that would take the store past what it held then, the reserve included. What must be written after the step still
   * lands, by construction: a refused must-write takes its room from the reserve, which shrinks, and the store never grows. */
  for (const name of ['card withdrawal', 'card top-up', 'Lightning payment', 'locked send']) {
    const c = await world({ full: name === 'card withdrawal' });
    let frozenAt = 0;
    c.W._onArm = () => { if (!frozenAt) { frozenAt = bytesOf(c.storage); c.cap = frozenAt; } };
    const before = await c.W.balanceSats();
    const got = await PATHS[name](c).then((r) => r, (x) => x);
    await quiet();
    c.W._onArm = null;
    let most = 0;
    const wrong = booksWrong(c);
    const spent = c.W._reserve() < c.W._storeRoom.card;
    ok(frozenAt > 0 && got && !isErr(got) && !wrong.length
       && !Array.from({ length: c.storage.length }, (_, i) => c.storage.key(i)).some((k) => k.indexOf(HOLD) === 0),
       name + ': with the store shut at its size as the step began, everything after it is written, from the reserve',
       (isErr(got) ? got.message : 'refused once each: ' + c.refused.join(', ') + (spent ? '; the reserve gave its room' : '')) + (wrong.length ? '; ' + wrong.join('; ') : '') + '; balance ' + before + ' -> ' + most);
  }
  /* A slow tap: nothing about the reserve is timed (the per-operation holds an earlier build of this fix took had a two-minute
   * clock, and a hold that ran out before the card signed left the signed pieces' row to be refused: the review's rv-timeout.js).
   * The card is slow to begin and to sign here, the store is shut as it is asked to sign, and what follows still lands. */
  {
    const c = await world({ full: true });
    const send = c.full.send.bind(c.full);
    c.full.send = (a) => (/^b0(22|20|24)/.test(String(a).toLowerCase()) ? new Promise((r) => setTimeout(r, 400)).then(() => send(a)) : send(a));
    let frozenAt = 0;
    c.W._onArm = () => { if (!frozenAt) { frozenAt = bytesOf(c.storage); c.cap = frozenAt; } };
    const before = await c.W.balanceSats(), onCard = c.full.balance();
    c.full.tap();
    const got = await c.W.cardWithdraw(c.full, { pin: '1234' }).then((r) => r, (x) => x);
    await quiet();
    c.W._onArm = null;
    c.cap = 0;
    ok(frozenAt > 0 && !isErr(got) && c.full.balance() === 0 && (await c.W.balanceSats()) === before + onCard && !get(c, 'foxy.flashcard.taken', []).length && !booksWrong(c).length,
       'a slow tap, the store shut as the card signs: the signed pieces\u2019 row and the swap after it land, from the reserve', isErr(got) ? got.message : 'refused once each: ' + c.refused.join(', '));
  }
  // and with the reserve not whole (spent, and no room to grow it back), money operations are refused before they start
  {
    const c = await world({ full: true });
    c.W._storeCap = 1e12;
    c.cap = CAP;
    c.storage.removeItem(RESERVE);
    fillDead(c, CAP - 300 * 1024);
    const onCard = c.full.balance(), cardFrom = c.full.sent.length, from = c.trace.length;
    c.full.tap();
    const e = await c.W.cardWithdraw(c.full, { pin: '1234' }).then(() => null, (x) => x);
    ok(!!e && e.card === 'storage-full' && !c.full.sent.slice(cardFrom).length && c.full.balance() === onCard && !moneyAsked(c, from).length,
       'past the room check, a card\u2019s tap with the reserve not whole is refused before the card is read', e ? e.card : 'it went through');
    // (locked: a swap whatever the pile holds)
    const s2 = await c.W.sendToken(21, { lockTo: key() }).then(() => null, (x) => x);
    ok(!!s2 && s2.unsent && !moneyAsked(c, from).length, 'and so is a swap', s2 ? s2.message.slice(0, 60) : 'it went through');
    // room again: the reserve grows back, and money moves
    c.storage.removeItem('test.filler');
    const s3 = await c.W.sendToken(21, { lockTo: key() }).then((r) => r, (x) => x);
    ok(!isErr(s3) && c.W._reserve() === c.W._storeRoom.card, 'with room again the reserve is whole before the next swap goes', isErr(s3) ? s3.message : '');
  }

  /* ---- a send that asks the mint nothing: its token is never written over before it is on its note ---------- */
  {
    const c = await world();
    const prior = await c.W.sendToken(300);
    const noteHas = (tok) => { const m = get(c, 'foxy.txmeta', {}); return Object.keys(m).some((h) => m[h].token === tok); };
    const anywhere = (tok) => Array.from({ length: c.storage.length }, (_, i) => c.storage.key(i)).filter((k) => (c.storage.getItem(k) || '').indexOf(tok) >= 0);
    ok(noteHas(prior.token) && get(c, 'foxy.cashu.outtoken', {}).token === prior.token, 'a token is on its note and in the last-token slot');
    // a few hundred bytes of room: the reviewer's sequence (tests at app-build/rv: rv-exact.js)
    c.cap = CAP;
    fillDead(c, WALLET_CAP - 200, true);
    const pile = get(c, 'foxy.cashu.proofs.' + MINT, []);
    const before = await c.W.balanceSats(), from = c.trace.length;
    const A = await c.W.sendToken(pile[0].amount).then((r) => r, (x) => x);
    ok(isErr(A) && A.unsent && (await c.W.balanceSats()) === before && !moneyAsked(c, from).length && anywhere(prior.token).length,
       'a send from pieces on hand with no room for its token is refused before anything is written', isErr(A) ? A.message.slice(0, 70) : 'it went through');
    // past the room check, the note's write refused: the token is not made, and nothing written over
    c.cap = 0;
    c.W._storeCap = 1e12;
    c.refuse = (k, v) => k === 'foxy.txmeta' && v.length > (c.storage.getItem(k) || '').length;
    const A2 = await c.W.sendToken(pile[0].amount).then((r) => r, (x) => x);
    ok(isErr(A2) && A2.storageFull && (await c.W.balanceSats()) === before && get(c, 'foxy.cashu.outtoken', {}).token === prior.token && noteHas(prior.token),
       'with its note refused, a send from pieces on hand is not made: its pieces are in the balance, and the last token is as it was',
       isErr(A2) ? A2.message.slice(0, 80) : 'it went through: ' + anywhere(A2.token).join(','));
    // the slot holding a token on no note (an older build, a history cleared): the next send puts it on its note, or is refused
    const meta = get(c, 'foxy.txmeta', {});
    Object.keys(meta).forEach((h) => { if (meta[h].token === prior.token) delete meta[h]; });
    c.refuse = null;
    c.storage.setItem('foxy.txmeta', JSON.stringify(meta));
    c.refuse = (k, v) => k === 'foxy.txmeta' && v.length > (c.storage.getItem(k) || '').length;
    const B = await c.W.sendToken(pile[0].amount).then((r) => r, (x) => x);
    ok(isErr(B) && B.unsent && get(c, 'foxy.cashu.outtoken', {}).token === prior.token, 'a send that would write over a token on no note, with no room to note it, is refused, and the slot keeps it',
       isErr(B) ? B.message.slice(0, 60) : 'it went through');
    c.refuse = null;
    const B2 = await c.W.sendToken(pile[0].amount).then((r) => r, (x) => x);
    ok(B2 && !isErr(B2) && noteHas(prior.token) && noteHas(B2.token) && get(c, 'foxy.cashu.outtoken', {}).token === B2.token && !booksWrong(c).length,
       'with room, the old token goes on its note before the new one takes the slot, and both are on the phone');
  }
  // the same with locked pieces received with no route and signed on: a lost text there is money lost
  {
    const H = capped(await funded({}, 0));
    const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 2000);
    const req = H.W.decodeRequest(H.W.paymentRequest(300, { purpose: 'receive' }));
    const tok = await R.W.sendToken(300, { lockTo: req.lockTo });
    H.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct', network: 'none' });
    await H.W.receiveToken(tok.token);
    const before = await H.W.balanceSats(), waiting = H.W.unclaimedSats();
    H.W._storeCap = 1e12;
    H.refuse = (k, v) => k === 'foxy.txmeta' && v.length > (H.storage.getItem(k) || '').length;
    const A = await H.W.sendToken(300).then((r) => r, (x) => x);
    ok(isErr(A) && A.storageFull && (await H.W.balanceSats()) === before && H.W.unclaimedSats() === waiting && waiting === 300,
       'locked pieces handed on with no route: with the note refused the token is not made, and the pieces are still waiting, unstruck',
       isErr(A) ? A.message.slice(0, 70) : 'it went through');
    H.refuse = null;
    const A2 = await H.W.sendToken(300).then((r) => r, (x) => x);
    const m = get(H, 'foxy.txmeta', {});
    ok(A2 && !isErr(A2) && A2.sats === 300 && Object.keys(m).some((h) => m[h].token === A2.token) && H.W.unclaimedSats() === 0,
       'and with room it is made, on its note, and the pieces are struck off', isErr(A2) ? A2.message : '');
  }

  /* ---- clearing history, which the storage-full words point to, keeps every unclaimed token ------------------- */
  {
    const c = await world();
    const plain = await c.W.sendToken(300);
    const locked = await c.W.sendToken(21, { lockTo: key() });
    c.W.forgetClaimedToken((await c.W.sendToken(200)).token);
    c.W.clearHistory({ forgetToken: true });
    const m = get(c, 'foxy.txmeta', {});
    const has = (tok) => Object.keys(m).some((h) => m[h].token === tok);
    ok(has(plain.token) && has(locked.token) && !get(c, 'foxy.cashu.outtoken', null) && !Object.keys(m).some((h) => m[h].kept),
       'clearing history keeps every token nobody is known to have claimed, plain or locked, and lets go of the rest');
    const log = get(c, 'foxy.cashu.log', []);
    ok(log.some((e) => e.hash === plain.hash) && log.some((e) => e.hash === locked.hash) && log.filter((e) => e.memo === 'opening').length === 1
       && !booksWrong(c).length,
       'and the entries of those tokens, so the screens can still reach them; with the balance carried forward, the books add up',
       log.map((e) => e.memo + ':' + e.sats).join(' ') + ' ' + booksWrong(c).join('; '));
    const after = await c.W.sendToken(400).then((r) => r, (x) => x);
    ok(!isErr(after) && !booksWrong(c).length, 'and after a payment made since, they still add up', booksWrong(c).join('; '));
  }

  /* ---- the token's write refused after the swap ------------------------------------------------------------ */
  // full until history is trimmed: the write is refused, room is made, and it is written
  {
    const c = await world();
    c.W._storeCap = 1e12;
    fillHistory(c, CAP - 8192);
    // refused while the notes still hold the old claimed tokens' text, which only the tight trim lets go
    const crowded = () => { const m = get(c, 'foxy.txmeta', {}); return Object.keys(m).filter((h) => /^old-/.test(h) && m[h].kept).length > 2; };
    c.refuse = (k) => k === 'foxy.cashu.outtoken' && crowded();
    c.card.tap();
    const seen = await c.W.cardLook(c.card);
    const prep = await c.W.cardPrepare(seen, 3000).then((r) => r, (x) => x);
    ok(prep && !isErr(prep) && c.refused.indexOf('foxy.cashu.outtoken') >= 0 && !!get(c, 'foxy.cashu.outtoken', null)
       && get(c, 'foxy.flashcard.owed', []).length === 1 && !get(c, 'foxy.cashu.swaps', []).length,
       'a card top-up whose token is refused once is written after room is made, and filed for the card',
       isErr(prep) ? prep.message : 'refused ' + c.refused.join(','));
  }
  // a plain send, refused for good: its pieces back in the balance, never sent
  {
    const c = await world();
    const before = await c.W.balanceSats();
    c.refuse = (k) => k === 'foxy.cashu.outtoken';
    const e = await c.W.sendToken(777).then(() => null, (x) => x);
    await quiet();
    c.refuse = null;
    const wrong = booksWrong(c);
    // nothing left saying the pieces are out: no note offers them, and none is listed as sent and unclaimed (`tokensNotClaimed`)
    const pileNow = {};
    get(c, 'foxy.cashu.proofs.' + MINT, []).forEach((p) => { pileNow[p.secret] = true; });
    const metaNow = get(c, 'foxy.txmeta', {});
    const twice = Object.keys(metaNow).filter((h) => { const i = metaNow[h].token && c.W.tokenInfo(metaNow[h].token); return i && i.proofs.some((p) => pileNow[p.secret]); });
    const listed = await c.W.tokensNotClaimed();
    ok(!twice.length && !listed.length, 'and nothing says they are out: no note offers them and nothing is listed as unclaimed', twice.length + ' note(s), ' + JSON.stringify(listed.map((t) => t.sats)));
    ok(!!e && e.putBack && !e.unsent && e.storageFull && (await c.W.balanceSats()) === before && !get(c, 'foxy.cashu.swaps', []).length && !wrong.length
       && /back in your balance/.test(e.message),
       'a plain send whose token cannot be written is refused, and its pieces are back in the balance (said as put back, not as never sent: the swap was made)', e ? e.message.slice(0, 80) + ' ' + wrong.join(';') : 'it went through');
  }
  // a locked card top-up, refused for good: the record stays, and a relaunch rebuilds the payment
  {
    const c = await world();
    // (the invoice paid to it claimed first, so the relaunch's connect has nothing else to bring in)
    await c.W.claim(c.quoteIn);
    c.refuse = (k) => k === 'foxy.cashu.outtoken';
    c.card.tap();
    const seen = await c.W.cardLook(c.card);
    const before = await c.W.balanceSats();
    const e = await c.W.cardPrepare(seen, 3000).then(() => null, (x) => x);
    await quiet();
    const recs = get(c, 'foxy.cashu.swaps', []);
    ok(!!e && e.storageFull && recs.length === 1 && (recs[0].locked || []).length > 0 && !get(c, 'foxy.cashu.outtoken', null),
       'a card top-up whose token cannot be written keeps its swap’s record, with every locked output', e ? e.message.slice(0, 80) : 'it went through');
    noBooks(c, 'the payment is on record and is rebuilt by the page below');
    // relaunched over that store, with room
    const again = relaunch(c);
    await again.W.connect(MINT, null, null, { remember: true });
    await again.W.recoverSwaps();
    await quiet();
    const out = get(again, 'foxy.cashu.outtoken', null);
    const info = out && again.W.tokenInfo(out.token);
    const sent = info ? info.proofs.reduce((n, p) => n + Number(p.amount), 0) : 0;
    const rows = get(again, 'foxy.cashu.log', []).filter((r) => r && out && r.hash === out.hash);
    ok(sent === 3000 && rows.length === 1 && !get(again, 'foxy.cashu.swaps', []).length && (await again.W.balanceSats()) === before - 3000,
       'the relaunch rebuilds the 3,000 sats as a token, on one entry, with the record let go',
       'token ' + sent + ', entries ' + rows.length + ', balance ' + (await again.W.balanceSats()) + ' of ' + (before - 3000));
    // the card's next read files it as owed to the card, to be written at the next tap
    c.card.tap();
    await again.W.cardLook(c.card);
    ok(get(again, 'foxy.flashcard.owed', []).some((r) => r.token === out.token), 'and the card’s next read files it as owed to the card');
    ok(!booksWrong(again).length, 'and the relaunched page’s books add up from nothing', booksWrong(again).join('; '));
  }

  /* ---- a relaunch that finds a finished send's record beside its token -------------------------------------- */
  for (const name of ['send', 'locked send']) {
    const c = await world();
    await c.W.claim(c.quoteIn);
    const before = await c.W.balanceSats();
    // the token is written; the record's drop is refused after it
    c.refuse = (k) => k === 'foxy.cashu.swaps' && !!c.storage.getItem('foxy.cashu.outtoken');
    c.storage.removeItem('foxy.cashu.outtoken');
    const made = await PATHS[name](c);
    c.refuse = null;
    ok(get(c, 'foxy.cashu.swaps', []).some((r) => r.hash === made.hash), name + ': its record is left beside its token (the drop was refused)');
    noBooks(c, 'judged on the page below');
    const again = relaunch(c);
    await again.W.connect(MINT, null, null, { remember: true });
    await again.W.recoverSwaps();
    await quiet();
    const rows = get(again, 'foxy.cashu.log', []).filter((r) => r && r.hash === made.hash);
    const fee = made.fee || 0;
    ok(!get(again, 'foxy.cashu.swaps', []).length && rows.length === 1 && (await again.W.balanceSats()) === before - made.sats - fee && !booksWrong(again).length,
       name + ': the relaunch lets the record go and adds nothing: its pieces are not restored into the balance while the token is out',
       'entries ' + rows.length + ', balance ' + (await again.W.balanceSats()) + ' of ' + (before - made.sats - fee) + ' ' + booksWrong(again).join('; '));
  }

  /* ---- the trim keeps what it must ------------------------------------------------------------------------- */
  {
    const c = await world();
    // a payment of each kind, so there are piles, records, holds and a card's rows to keep
    await c.W.sendToken(500);
    c.card.tap();
    await c.W.cardPrepare(await c.W.cardLook(c.card), 1000);
    const meta = get(c, 'foxy.txmeta', {});
    // the real load: its pieces are in this phone's file of the card (the take-back is rebuilt from that file)
    const realLoad = Object.keys(meta).filter((h) => meta[h].to === 'card' && meta[h].token)[0];
    meta.unclaimed = { token: 'cashuB' + 'u'.repeat(200000), to: 'ecash' };
    meta.carded = { token: 'cashuB' + 'c'.repeat(40000), to: 'card', carded: Date.now() };
    meta.owedCard = { token: 'cashuB' + 'o'.repeat(40000), to: 'card' };
    for (let i = 0; i < 40; i++) meta['claimed-' + i] = { kept: 'cashuB' + 'k'.repeat(20000) + i, note: 'note ' + i };
    c.storage.setItem('foxy.txmeta', JSON.stringify(meta));
    const audit = [];
    for (let i = 0; i < 300; i++) audit.push({ at: 1000 + i, hash: 'a' + i, kind: 'token', sats: i, inputs: [{ secret: 's'.repeat(3000) + i, amount: 1 }], ys: ['02' + String(i).padStart(64, '0')] });
    c.storage.setItem('foxy.cashu.audit', JSON.stringify(audit));
    c.storage.setItem('foxy.cashu.swaps', JSON.stringify([{ id: 'send-x', kind: 'send', mint: MINT, outputs: [{ keysetId: '00ab', start: 1, count: 2 }], locked: [{ amount: 1, id: '00ab', B_: '02', secret: 'aa', r: '1' }] }]));
    c.storage.setItem('foxy.cashu.held', JSON.stringify({ 'send-x': { mint: MINT, unit: 'sat', proofs: [{ amount: 1, secret: 'h' }] } }));
    noBooks(c, 'a hold and a record are put in its store behind the wallet\u2019s back');
    const MUST = Array.from({ length: c.storage.length }, (_, i) => c.storage.key(i))
      .filter((k) => k !== 'foxy.txmeta' && k !== 'foxy.cashu.audit');
    const keep = {};
    MUST.forEach((k) => { keep[k] = c.storage.getItem(k); });
    const before = bytesOf(c.storage);
    const freed = c.W._trimStore(true);
    const same = MUST.filter((k) => c.storage.getItem(k) !== keep[k]);
    const m = get(c, 'foxy.txmeta', {});
    const a = get(c, 'foxy.cashu.audit', []);
    ok(freed > 0 && bytesOf(c.storage) === before - freed, 'the trim frees room', freed + ' bytes');
    ok(!same.length && MUST.some((k) => /proofs/.test(k)) && MUST.indexOf('foxy.cashu.swaps') >= 0 && MUST.indexOf('foxy.cashu.held') >= 0
       && MUST.indexOf('foxy.cashu.outtoken') >= 0 && MUST.indexOf('foxy.flashcard.owed') >= 0 && MUST.indexOf('foxy.flashcard.cards') >= 0,
       'and touches nothing else: the piles, the swap records, the holds, the last token, the card’s owed rows and its file, the keys', same.join(', '));
    ok(m.unclaimed.token.length === 200006 && m.owedCard.token.length === 40006, 'a token nobody has claimed keeps its text, and so does a card’s load not yet on the card');
    ok(realLoad && !m[realLoad].token && Object.keys(m).filter((h) => /^claimed-/.test(h)).length === 40
       && Object.keys(m).filter((h) => /^claimed-/.test(h)).every((h) => m[h].note === 'note ' + h.slice(8)),
       'a card’s load whose every piece is in the card’s file is let go as a claimed token is, and every note is kept');
    ok(m.carded.token && m.carded.token.length === 40006, 'but one marked as on the card whose pieces are on no file keeps its text: it is all a lost card\u2019s take-back has');
    const keptChars = Object.keys(m).reduce((n, h) => n + (m[h].kept ? m[h].kept.length : 0) + (m[h].changeToken ? m[h].changeToken.length : 0), 0);
    ok(keptChars <= 50000, 'claimed tokens’ text is cut to its tight budget', keptChars + ' characters');
    ok(a.length > 0 && a[0].hash === audit[0].hash && JSON.stringify(a).length <= 150000 && a.filter((r) => !r.slim).length <= 10
       && a.every((r) => r.slim ? !r.inputs : true), 'the audit trail keeps its newest rows, slim past the newest few, within its tight budget',
       a.length + ' rows, ' + JSON.stringify(a).length + ' characters');
    ok(c.W._trimStore(true) === 0, 'and trimming again frees nothing');
  }

  /* ---- sent tokens: claimed ones let go, unclaimed ones kept ------------------------------------------------ */
  {
    const c = await world();
    const claimedTok = (await c.W.sendToken(300)).token;
    await c.R.W.receiveToken(claimedTok);
    const openTok = (await c.W.sendToken(200)).token;
    // a card top-up written before `carded` was marked: its pieces are in the card's file
    c.card.tap();
    const put = await c.W.cardAdd(c.card, { sats: 700, pin: '1234' });
    const meta = get(c, 'foxy.txmeta', {});
    const loadHash = put.hash || Object.keys(meta).filter((h) => meta[h].to === 'card' && meta[h].token)[0]
      || Object.keys(meta).filter((h) => meta[h].to === 'card')[0];
    if (meta[loadHash] && meta[loadHash].kept && !meta[loadHash].token) { meta[loadHash].token = meta[loadHash].kept; delete meta[loadHash].kept; }
    if (meta[loadHash]) delete meta[loadHash].carded;
    c.storage.setItem('foxy.txmeta', JSON.stringify(meta));
    const noteOf = (tok) => { const m = get(c, 'foxy.txmeta', {}); return Object.keys(m).map((h) => m[h]).filter((n) => n.token === tok || n.kept === tok)[0] || {}; };
    // not short of room: nothing is asked
    const from = c.trace.length;
    ok((await c.W._tidySentTokens()) === 0 && !c.trace.slice(from).length && noteOf(claimedTok).token === claimedTok,
       'with room to spare, no sent token is asked about');
    c.W._trimStore(false);
    const lm = get(c, 'foxy.txmeta', {})[loadHash] || {};
    ok(!lm.token && !!lm.kept, 'a card top-up whose every piece is in the card’s file is let go as written, unmarked or not');
    // short of room: the mint is asked, on each token's own circuit
    // only once an operation has been refused for room
    c.W._storeCap = bytesOf(c.storage) + 512 * 1024;
    ok((await c.W._tidySentTokens()) === 0, 'and not merely near the cap: only once an operation has been refused for room');
    c.W._roomShort();
    const gone = await c.W._tidySentTokens();
    ok(gone >= 1 && noteOf(claimedTok).kept === claimedTok && !noteOf(claimedTok).token, 'short of room, a sent token the mint says is claimed is let go from its note', gone + ' let go');
    ok(noteOf(openTok).token === openTok, 'and one nobody has claimed keeps its text');
    // a locked token the mint says is spent is never forgotten on that word alone
    c.W._storeCap = 0;
    const lockedTok = (await c.W.sendToken(21, { lockTo: c.R.W.decodeRequest(c.R.W.paymentRequest(21, { purpose: 'receive' })).lockTo })).token;
    await c.R.W.receiveToken(lockedTok);
    c.W._roomShort();
    await c.W._tidySentTokens();
    ok(noteOf(lockedTok).token === lockedTok, 'a locked token keeps its text though the mint says it is spent');
    ok(c.circuits.slice(-3).every((r) => !r.path.endsWith('/checkstate') || !!r.circuit), 'asked on a circuit of its own');
  }

  /* ---- the phone that lost the money, by its numbers ---------------------------------------------------------
   * About 5.1 million characters in all: 300 notes whose token fields come to 2.78 million, and an audit trail of 1.4
   * million in 255 rows. Launched with that, the trim must leave room for a swap under the cap, whether the tokens are card
   * loads already on their cards or tokens nothing here can prove claimed (kept, every one), and a send must then go. */
  /* (Card loads marked as on their cards whose pieces are on no file of this phone's keep their text: on a real phone
   * 84 of 115 were so, and only the file or the text can bring a lost card's money back. The fake tokens here read as no
   * load at all, so they are kept as the second case's are.) */
  for (const which of ['card loads marked as on their cards, on no file', 'tokens nothing can prove claimed']) {
    const c = await world();
    await c.W.claim(c.quoteIn);
    const meta = get(c, 'foxy.txmeta', {});
    for (let i = 0; i < 300; i++) {
      const token = 'cashuB' + 't'.repeat(9260) + String(i).padStart(3, '0');
      meta['phone-' + i] = which[0] === 'c' ? { token, to: 'card', carded: Date.now() } : { token, to: 'ecash' };
    }
    c.storage.setItem('foxy.txmeta', JSON.stringify(meta));
    const audit = [];
    for (let i = 0; i < 255; i++) {
      audit.push({ at: 1000 + i, hash: 'old-' + i, kind: 'token', sats: i, inputs: [{ amount: 1, secret: 's'.repeat(5380) + i }],
                   ys: ['02' + String(i).padStart(64, '0')] });
    }
    c.storage.setItem('foxy.cashu.audit', JSON.stringify(audit));
    const tokenChars = Object.keys(meta).filter((h) => /^phone-/.test(h)).reduce((n, h) => n + meta[h].token.length, 0);
    fillDead(c, 5100000);
    const at = bytesOf(c.storage);
    ok(at === 5100000 && tokenChars > 2770000 && tokenChars < 2790000 && c.storage.getItem('foxy.cashu.audit').length > 1390000,
       which + ': the store as the phone had it', at + ' bytes, ' + tokenChars + ' characters of tokens, an audit trail of ' + c.storage.getItem('foxy.cashu.audit').length);
    noBooks(c, 'judged on the page launched over it');
    const again = relaunch(c);
    const after = again.W._storeBytes();
    const kept = get(again, 'foxy.txmeta', {});
    const still = Object.keys(kept).filter((h) => /^phone-/.test(h) && kept[h].token).length;
    ok(after + again.W._storeRoom.swap <= WALLET_CAP, which + ': launched, the trim leaves room for a swap under the cap',
       at + ' -> ' + after + ' bytes, cap ' + WALLET_CAP + ', a swap\u2019s room ' + again.W._storeRoom.swap);
    ok(still === 300, which + ': every one keeps its text', still + ' of 300 keep their token');
    await again.W.connect(MINT, null, null, { remember: true });
    const before = await again.W.balanceSats();
    const made = await again.W.sendToken(777).then((r) => r, (e) => e);
    ok(made && !isErr(made) && (await again.W.balanceSats()) === before - made.sats - (made.fee || 0) && !booksWrong(again).length,
       which + ': and a payment goes', isErr(made) ? made.message : booksWrong(again).join('; '));
  }

  /* ---- a card's load is let go from its note only when its pieces are in the card's file ---------------------- */
  // the review's rv-cardload.js: the card's file refused all the while a 3,000-sat load is made and written onto the card
  {
    const c = await world();
    c.card.tap();
    const seen = await c.W.cardLook(c.card);
    c.refuse = (k) => k === 'foxy.flashcard.cards';
    await c.W.cardPrepare(seen, 3000);
    const meta0 = get(c, 'foxy.txmeta', {});
    const hash = Object.keys(meta0).filter((h) => meta0[h].to === 'card' && meta0[h].token)[0];
    const token = meta0[hash].token;
    c.card.tap();
    await c.W.cardWrite(c.card, { pin: '1234' }).then((x) => x, (e) => e);
    await quiet();
    c.refuse = null;
    const files = get(c, 'foxy.flashcard.cards', {});
    const pieces = c.W.tokenInfo(token).proofs;
    const onFile = pieces.filter((p) => { const j = JSON.parse(p.secret)[1]; return files[j.data] && files[j.data].pieces && files[j.data].pieces[j.nonce]; }).length;
    const mm = get(c, 'foxy.txmeta', {});
    for (let i = 0; i < 10; i++) mm['later-' + i] = { kept: 'cashuB' + 'k'.repeat(20000) + i };
    c.storage.setItem('foxy.txmeta', JSON.stringify(mm));
    c.W._trimStore(true);
    const after = get(c, 'foxy.txmeta', {})[hash] || {};
    ok(c.card.balance() >= 3000 && onFile === 0 && !!(mm[hash] && mm[hash].carded) && after.token === token,
       'a load on the card whose pieces are on no file of this phone keeps its token through the tight trim: a lost card\u2019s take-back has only that',
       'on file ' + onFile + '/' + pieces.length + ', carded ' + !!(mm[hash] && mm[hash].carded) + ', token kept ' + (after.token === token));
    // with the file writable, the load's pieces are written to it from the reserve if need be, and then the text may go
    c.card.tap();
    await c.W.cardLook(c.card);
    const files2 = get(c, 'foxy.flashcard.cards', {});
    const onFile2 = pieces.filter((p) => { const j = JSON.parse(p.secret)[1]; return files2[j.data] && files2[j.data].pieces && files2[j.data].pieces[j.nonce]; }).length;
    c.W._trimStore(true);
    ok(onFile2 === pieces.length && !(get(c, 'foxy.txmeta', {})[hash] || {}).token, 'and once the card is read again with the file writable, its pieces are on file and the text may go', onFile2 + '/' + pieces.length);
  }
  // the card file is written from the store's reserve when the store refuses it (`cardRemember`, a must-write)
  {
    const c = await world();
    c.card.tap();
    const seen = await c.W.cardLook(c.card);
    let frozen = false;
    c.refuse = (k, v) => frozen && k === 'foxy.flashcard.cards' && v.length > (c.storage.getItem(k) || '').length && c.W._reserve() === c.W._storeRoom.card;
    frozen = true;
    await c.W.cardPrepare(seen, 3000);
    frozen = false;
    c.refuse = null;
    const files = get(c, 'foxy.flashcard.cards', {});
    const n = Object.keys((files[c.card.key] || {}).pieces || {}).length;
    ok(n > 0 && c.W._reserve() < c.W._storeRoom.card, 'refused while the reserve is whole, the card\u2019s file is written from the reserve', n + ' pieces on file, reserve ' + c.W._reserve());
  }
  // a real phone's shape (the review's rv-cardfile2.js on the pulled store): 115 card loads marked as on their cards, 31 with every piece on file
  {
    const c = await world();
    const loads = [];
    for (let i = 0; i < 4; i++) { c.card.tap(); await c.W.cardPrepare(await c.W.cardLook(c.card), 100 + i); }
    const meta = get(c, 'foxy.txmeta', {});
    const real = Object.keys(meta).filter((h) => meta[h].to === 'card' && meta[h].token);
    real.forEach((h) => { meta[h].carded = Date.now(); });
    // 84 more marked as on cards no longer on file, or with their pieces missing: a real load's token cut to another card's key
    const sample = meta[real[0]].token;
    const info = c.W.tokenInfo(sample);
    const C = c.window.CashuTS;
    for (let i = 0; i < 84; i++) {
      const proofs = info.proofs.map((p) => { const j = JSON.parse(p.secret); j[1].nonce = crypto.randomBytes(32).toString('hex'); j[1].data = i % 2 ? key() : j[1].data; return Object.assign({}, p, { secret: JSON.stringify(j) }); });
      meta['gone-' + i] = { to: 'card', carded: Date.now(), token: C.getEncodedToken({ mint: MINT, proofs, unit: 'sat' }) };
    }
    c.storage.setItem('foxy.txmeta', JSON.stringify(meta));
    noBooks(c, 'notes put in its store behind the wallet\u2019s back');
    const again = relaunch(c);
    const left = get(again, 'foxy.txmeta', {});
    const gone = Object.keys(left).filter((h) => /^gone-/.test(h) && !left[h].token).length;
    const onFileLet = real.filter((h) => !left[h].token).length;
    ok(gone === 0 && onFileLet === real.length, 'launched over such a store, the trim lets go only the loads whose pieces are on file: none of the 84 others',
       gone + ' of 84 let go; ' + onFileLet + ' of ' + real.length + ' on file let go');
    again.booksFrom = null;
  }

  /* ---- no phone frozen out of its own money ------------------------------------------------------------------- */
  // the review's rv-frozen.js: untrimmable data to 4.3 MiB, the whole reserve no longer fits under WebKit's 5 MiB
  {
    const c = await world({ full: true });
    let told = null;
    c.W.onStorageFull((r) => { told = r; });
    const sentOut = await c.W.sendToken(300);
    c.storage.removeItem(RESERVE);
    c.cap = CAP;
    fillDead(c, Math.round(4.3 * 1024 * 1024));
    const out = {};
    for (const [n, f] of Object.entries({ send: () => c.W.sendToken(777), receive: () => c.W.receiveToken(c.tokenIn), pay: () => c.W.pay(c.invoiceOut, () => {}), claim: () => c.W.claim(c.quoteIn) })) {
      out[n] = await f().then(() => 'went', (e) => (e && e.message) || String(e));
    }
    await quiet();
    ok(Object.values(out).every((v) => v === 'went') && c.W._reserve() >= c.W._storeRoom.small && c.W._reserve() < c.W._storeRoom.card && !booksWrong(c).length,
       'a store too full for the whole reserve keeps what it can of it, and a send, a receive, a payment and a claim all go',
       JSON.stringify(out).slice(0, 200) + '; reserve ' + c.W._reserve());
    // a card's tap needs the whole reserve: refused, with the card that says what holds the room and offers the tokens to copy
    c.full.tap();
    const tap = await c.W.cardWithdraw(c.full, { pin: '1234' }).then(() => null, (e) => e);
    await quiet();
    ok(!!tap && tap.card === 'storage-full' && !!told && told.sentCount >= 1 && told.sentTokens.indexOf(sentOut.token) >= 0
       && /Clearing history (on the History screen frees|would free only)/.test(told.words) && told.total > 0,
       'a card\u2019s tap is refused, and the person is told what holds the room, with every unclaimed token to copy',
       (tap ? tap.card : 'went') + '; ' + (told ? told.words : 'not told'));
    const r = c.W.storageReport();
    ok(Math.abs(r.total - bytesOf(c.storage)) < 64 && r.sent > 0 && r.money > 0, 'the report adds up to the store as WebKit counts it', r.total + ' / ' + bytesOf(c.storage));
  }
  // the words are true: clearing history is said to be enough only when it is
  {
    const c = await world();
    c.cap = CAP;
    c.storage.removeItem(RESERVE);
    fillHistory(c, CAP - 1000);
    c.W._storeCap = 1e12;
    const w1 = c.W.storageReport().words;
    c.W._storeCap = 0;
    c.storage.removeItem('foxy.txmeta');
    fillDead(c, CAP - 1000);
    const w2 = c.W.storageReport().words;
    ok(/frees [0-9.]+ MB, which is enough/.test(w1) && /would free only/.test(w2), 'the words say clearing history is enough when it is, and say what holds the room when it is not', w1 + ' | ' + w2);
  }

  /* ---- the storage card's figures are what clearing and the trim really free ---------------------------------- */
  {
    const c = await world();
    await c.W.sendToken(300);
    c.card.tap();
    await c.W.cardPrepare(await c.W.cardLook(c.card), 1000);
    fillHistory(c, Math.round(3 * 1024 * 1024));
    const r = c.W.storageReport();
    // the trim, on a copy of this store (a page launched over it trims as it opens: measured before that, on this page)
    const before = bytesOf(c.storage, true);
    c.W._trimStore(true);
    const trimmed = before - bytesOf(c.storage, true);
    const r2 = c.W.storageReport();
    const mid = bytesOf(c.storage, true);
    c.W.clearHistory();
    const cleared = mid - bytesOf(c.storage, true);
    noBooks(c, 'history filled behind the wallet\u2019s back');
    ok(Math.abs(r.trimmable - trimmed) <= 64, 'the card\u2019s figure for what the trim frees is what it frees', r.trimmable + ' said, ' + trimmed + ' freed');
    ok(Math.abs(r2.clearable - cleared) <= 256, 'and its figure for what clearing history frees is what clearing frees', r2.clearable + ' said, ' + cleared + ' freed');
    ok(r.sentCount >= 1 && r.cardLoadCount === 1 && r.sent > 0 && r.cardLoads > 0, 'sent tokens and card loads are counted apart', r.sentCount + ' sent, ' + r.cardLoadCount + ' card loads');
  }
  // card loads kept for a lost card's take-back are listed apart from tokens sent
  {
    const c = await world();
    const sent = await c.W.sendToken(300);
    c.card.tap();
    c.refuse = (k) => k === 'foxy.flashcard.cards';
    await c.W.cardPrepare(await c.W.cardLook(c.card), 1000);
    c.refuse = null;
    const r = c.W.storageReport();
    const text = c.W.unclaimedTokensText();
    ok(r.sentTokens.indexOf(sent.token) >= 0 && r.cardLoadCount === 1 && r.cardTokens.length === 1 && r.sentTokens.indexOf(r.cardTokens[0]) < 0
       && /TOKENS YOU SENT THAT NOBODY IS KNOWN TO HAVE CLAIMED \(1\)/.test(text) && /LOADS PUT ON YOUR CARDS \(1\)/.test(text)
       && text.indexOf(sent.token) >= 0 && text.indexOf(r.cardTokens[0]) > text.indexOf('LOADS PUT ON YOUR CARDS'),
       'the text to save lists tokens sent and card loads apart, each with what it is', r.sentCount + ' sent, ' + r.cardLoadCount + ' loads');
  }

  /* ---- saving the unclaimed tokens: a file through native, never the clipboard, nothing in the log ------------- */
  {
    const c = await world();
    const sent = await c.W.sendToken(300);
    const asked = [];
    const mh = c.window.webkit.messageHandlers.foxy;
    const post = mh.postMessage.bind(mh);
    mh.postMessage = (m) => {
      if (m && m.action === 'exportText') { asked.push(m); setTimeout(() => c.W._scanResult(m.id, 'saved'), 0); return; }
      return post(m);
    };
    const said = [];
    const con = c.window.console;
    const keep = { log: con.log, warn: con.warn, error: con.error, info: con.info };
    ['log', 'warn', 'error', 'info'].forEach((k) => { con[k] = (...a) => { said.push(a.map(String).join(' ')); }; });
    const got = await c.W.exportText(c.W.unclaimedTokensText(), 'unclaimed tokens').then((x) => x, (e) => e);
    Object.assign(con, keep);
    ok(got === 'saved' && asked.length === 1 && asked[0].text.indexOf(sent.token) >= 0 && asked[0].label === 'unclaimed tokens',
       'the tokens go to native as one text to keep as a file (`exportText`)', String(got));
    ok(!said.some((l) => l.indexOf(sent.token) >= 0 || l.indexOf('cashuB') >= 0), 'and nothing of them is written to the log');
    const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'app', '11-cards.js'), 'utf8');
    const card = app.slice(app.indexOf('  storageFullCard(r) {'), app.indexOf('  changeStuckCard(info) {'));
    ok(card.length > 100 && /W\.exportText\(W\.unclaimedTokensText\(\), 'unclaimed tokens'\)/.test(card) && !/copyText|clipboard/.test(card),
       'the storage card saves them through native, and never puts them on the clipboard');
    const swift = require('fs').readFileSync(require('path').join(__dirname, '..', 'Foxy', 'Bridge', 'FoxyBridge.swift'), 'utf8');
    const native = swift.slice(swift.indexOf('    private func presentTextExport('), swift.indexOf('    /// Read the pasteboard, but only when there is text to read.'));
    ok(native.length > 100 && /UIActivityViewController\(activityItems: \[ShareFile\(file\)\]/.test(native) && /excludedActivityTypes = TextExport\.excludedActivities/.test(native)
       && /TextExport\.remove\(file\)/.test(native) && !/UIPasteboard/.test(native) && !/print\([^)]*text\)/.test(native.replace('text.count', '')),
       'and native offers a file in the share sheet with Copy left out, deletes it when the sheet closes, and logs only its length');
  }
  // the other two doors a payment starts by: an on-chain claim and a swap of ecash taken back after a refusal ask for room first
  {
    const chain = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'wallet', '16a-onchain.js'), 'utf8');
    const help = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'wallet', '20-helpers.js'), 'utf8');
    ok(/roomFor\('mint'\);\n\s+\/\/ before the claim leaves, a refusal stops it \(`refuseOn`\)\n\s+var rec = outputsRecorder\(w, \[\]/.test(chain)
       && /roomFor\('small'\);\n\s+var guard = swapGuard\(uw, 'split', \{ inputs: live, unit: gu \}\);/.test(help),
       'an on-chain claim and the swap of ecash at risk each ask for room before anything is sent');
  }

  /* ---- the reserve: cut by twice what a write adds, never by a cosmetic write ---------------------------------- */
  {
    const c = await world();
    const whole = c.W._reserve();
    // a cosmetic note (`tag` with no `must`) refused: the reserve is untouched
    c.refuse = (k, v) => k === 'foxy.txmeta' && v.length > (c.storage.getItem(k) || '').length;
    c.W.tag('cosmetic', { note: 'x'.repeat(2000) });
    const afterCosmetic = c.W._reserve();
    c.refuse = null;
    // a must-write that grows by a known amount, refused once by the store
    const grow = 3000;
    c.storage.setItem('test.money', JSON.stringify('a'));
    let once = true;
    c.refuse = (k) => { if (k === 'test.money' && once) { once = false; return true; } return false; };
    let threw = null;
    try { c.W._mustSave('test.money', 'a'.repeat(grow)); } catch (e) { threw = e; }
    c.refuse = null;
    const cut = whole - c.W._reserve();
    ok(afterCosmetic === whole, 'a cosmetic write refused takes nothing from the reserve', whole + ' -> ' + afterCosmetic);
    ok(!threw && cut > 2 * grow && cut < 4 * (grow + 200) + 8192, 'a must-write refused takes about twice what it adds (at two bytes a character), and a margin', 'cut ' + cut + ' for a growth of about ' + grow + (threw ? '; threw ' + threw.message : ''));
  }

  /* ---- at launch -------------------------------------------------------------------------------------------- */
  {
    const meta = { unclaimed: { token: 'cashuB' + 'u'.repeat(100000), to: 'ecash' } };
    for (let i = 0; i < 60; i++) meta['claimed-' + i] = { kept: 'cashuB' + 'k'.repeat(20000) + i };
    const c = page({ storage: { 'foxy.txmeta': JSON.stringify(meta) } });
    const m = get(c, 'foxy.txmeta', {});
    const keptChars = Object.keys(m).reduce((n, h) => n + (m[h].kept ? m[h].kept.length : 0), 0);
    ok(keptChars <= 500000 && keptChars > 400000 && m.unclaimed.token.length === 100006 && !!m['claimed-59'].kept,
       'the page trims as it opens: claimed tokens to their budget, newest kept, nothing unclaimed', keptChars + ' characters');
  }

  /* ---- the room check refuses before a send ----------------------------------------------------------------- */
  {
    const c = await world();
    fillDead(c, WALLET_CAP - 100000, true);
    const from = c.trace.length;
    const before = await c.W.balanceSats();
    const e = await c.W.sendToken(777).then(() => null, (x) => x);
    ok(!!e && e.unsent && e.storageFull && !c.trace.slice(from).length && (await c.W.balanceSats()) === before
       && /storage on this phone is full, so nothing was sent/.test(e.message) && /Clearing history (on the History screen frees|would free only)/.test(e.message),
       'with less room than a swap writes, a send is refused before anything is asked of the mint, in words that say what to do',
       e ? e.message : 'it went through');
    ok(!!c.W.neverSent(e), 'and it is never sent, as every caller reads it (`neverSent`)');
    // the door every request goes by refuses it too, whatever path it came by
    const asked = await c.W.nativeRequest({ endpoint: MINT + '/v1/swap', method: 'POST', requestBody: { inputs: [], outputs: [] } }).then(() => null, (x) => x);
    ok(!!asked && asked.unsent && !c.trace.slice(from).length, 'and a swap asked of the transport itself is refused there');
    const quote = await c.W.nativeRequest({ endpoint: MINT + '/v1/melt/quote/bolt11', method: 'POST', requestBody: { request: c.invoiceOut, unit: 'sat' } }).then(() => 'answered', (x) => x.message);
    ok(quote === 'answered', 'while a question that moves no money still goes', String(quote));
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + (e && e.stack)); process.exit(1); });
