'use strict';
/* flashcard-proofs.js — the mint's proof, kept with each piece on a card of software 1.20, and checked by the phone that reads it.
 *
 *     node tests/flashcard-proofs.js
 *
 * A card's line "Verified At 11:42am" used to rest on the mint's word that its pieces are unspent (NUT-07) and nothing else, and a
 * made-up piece reads unspent until somebody tries to spend it: a card loaded by somebody else's modified wallet read Verified. From
 * software 1.20 the card keeps the mint's NUT-12 proof with a piece loaded with one (e, s and the blinding factor r: LOAD_PROOF with
 * P1 = 1, one piece to a command; GET_DLEQ gives it back) and checks nothing; the phone does. This pins:
 *
 *   writing: a piece that has a whole proof goes onto a card of 1.20 alone, with P1 = 1, and the proof reads back as it went; a card
 *     of 1.19 is sent the commands it always was, byte for byte; a card with no room for proofs is not an error; the one line a write
 *     leaves in the log has its numbers and nothing secret;
 *   what this phone knows is real (`foxy.flashcard.real`): the pieces it wrote from the mint's own answers, and the ones whose proof
 *     it checked; the caps; a card's own pieces written back are not made real by it;
 *   reading: the screen's read (`real`) asks for the proofs of the pieces not known real, two places to a command, and no read a
 *     payment makes asks for any; a bare read keeps what the screen said;
 *   checking: good proofs say 'ok'; a made-up piece, or another piece's proof, says 'fake'; no proof, or no keys at hand, says
 *     'unproven' and never 'fake';
 *   a tap cut short in the middle of a load with proofs, and one whose answer was lost: finished at the next, nothing lost or written twice;
 *   the card's own change, finished at the second tap, with the mint's proof for it;
 *   the line under the card's title: red, the time, or amber; and for a card before 1.20 exactly what it was.
 *
 * The card is the model (tests/flashcard-card.js), which is held to the applet's own conversation (tests/flashcard-model.js); the mint
 * is the test mint. A made-up piece is loaded the way a modified wallet would, with the card's PIN and a command of its own.
 */
const crypto = require('crypto');
const { funded, newCard, binaryLoad, settle, OTHER_WORDS } = require('./flashcard-kit');
const { appOn, until, vals } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const THIRD = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SELECT = '00a404000af0464f5859434152440100';
const hx = (n) => ('0' + n.toString(16)).slice(-2);
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
// the commands of one instruction a card was sent
const sentOf = (card, ins) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + ins);
const count = (card, ins) => sentOf(card, ins).length;
// the places on a card that hold an unspent piece, with each one's nonce
const placed = (card) => card.state.slots.map((x, i) => (x.status === 1 ? { i, nonce: x.data.substr(24, 64), amount: parseInt(x.data.substr(16, 8), 16) } : null)).filter(Boolean);
const rowsOwed = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.owed') || '[]');
const realStore = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.real') || '{}');
const realOf = (c, card) => (realStore(c)[card.key] || { nonces: [] }).nonces;
// the proof each piece this phone has made and owes to cards will be written with, by nonce: e || s || r, from the token it made
const proofsOwed = (c) => {
  const out = {};
  rowsOwed(c).forEach((row) => {
    if (!row.token) return;
    c.W.tokenInfo(row.token).proofs.forEach((p) => { if (p.dleq) out[JSON.parse(p.secret)[1].nonce] = p.dleq.e + p.dleq.s + p.dleq.r; });
  });
  return out;
};
// the page's log, line by line, from now until `.done()`
const logging = (c) => {
  const lines = [];
  const log0 = c.window.console.log, warn0 = c.window.console.warn;
  c.window.console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); return log0.apply(this, arguments); };
  c.window.console.warn = function () { lines.push('WARN ' + Array.prototype.join.call(arguments, ' ')); return warn0.apply(this, arguments); };
  return { lines, done: () => { c.window.console.log = log0; c.window.console.warn = warn0; return lines; } };
};
// a card set up by `c`, its PIN 1234, loaded with `sats` by its owner's proof; the loads (and every other command) it was sent are `card.sent`
async function loaded(c, sats, o, bare) {
  const card = (o && o.card) || newCard(c, undefined, Object.assign({ format: 4 }, o || {}));
  if (!(o && o.card)) await c.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  const seen = await c.W.cardLook(card, { mine: true, short: true });
  await c.W.cardPrepare(seen, sats);
  // the pieces as a build that keeps no proofs would have filed them: the same ecash, with the mint's proof taken off
  if (bare) {
    const rows = rowsOwed(c);
    rows.forEach((row) => {
      const info = c.W.tokenInfo(row.token);
      row.token = c.window.CashuTS.getEncodedToken({ mint: info.mint, unit: 'sat', proofs: info.proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C })) });
    });
    c.storage.setItem('foxy.flashcard.owed', JSON.stringify(rows));
  }
  const want = proofsOwed(c);
  card.tap();
  card.sent.length = 0;
  await c.W.cardWrite(card, { owner: true });
  return { card, want };
}
// one tap's read by another phone, the way the card's own screen makes it, and what its check says of it
async function readAs(c, card, o) {
  card.tap();
  card.sent.length = 0;
  const seen = await c.W.cardLook(card, Object.assign({ real: true }, o || {}));
  const real = await c.W.cardRealCheck(seen);
  return { seen, real, sent: card.sent.slice() };
}
// a piece put on a card the way a wallet of somebody else's would: the PIN typed to it (plain, as a terminal that was given it does), and a load with the proof it names
async function forge(ctx, card, o) {
  card.tap();
  await card.send(SELECT);
  await card.send('b0400000' + '04' + '31323334');
  const first = card.state.slots.filter((x) => x.status !== 0)[0].data;
  const nonce = o.nonce || crypto.randomBytes(32).toString('hex');
  // a point that is on the curve and that nobody signed
  const C = o.C || Buffer.from(ctx.window.CashuTS.getPubKeyFromPrivKey(ctx.window.Uint8Array.from(crypto.randomBytes(32)))).toString('hex');
  const piece = first.substr(0, 16) + u32(o.amount || 8) + nonce + C + u32(0);
  const said = await card.send(o.proof === null ? 'b0300000' + hx(81) + piece + '01' : 'b0300100' + hx(177) + piece + o.proof + '02');
  return { nonce, said };
}

(async () => {
  /* ---- 1: this phone loads a card of 1.20, and one of 1.19 ---------------------------------------------------------- */
  {
    const H = await funded({}, 40000);
    const card = newCard(H, undefined, { format: 4 });
    await card.send(SELECT);
    const info = H.W.cardParse.info((await card.send('b001010000')).slice(0, -4));
    const old = newCard(H, undefined, { format: 4, software: 19 });
    await old.send(SELECT);
    const oldInfo = H.W.cardParse.info((await old.send('b001010000')).slice(0, -4));
    const older = newCard(H, undefined, { format: 4, software: 16 });
    await older.send(SELECT);
    const olderInfo = H.W.cardParse.info((await older.send('b001010000')).slice(0, -4));
    ok(card.version === 20 && info.version === '1.20' && info.proofs === true && oldInfo.version === '1.19' && oldInfo.proofs === false && olderInfo.proofs === false
       && olderInfo.version === '1.16',
       'the wallet reads a card of 1.20 as one that keeps proofs, and a card of 1.19 and before as one that does not (GET_INFO is the same in every form but for the version)', info.version + ' ' + oldInfo.version);

    await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
    card.tap();
    const look = await H.W.cardLook(card, { mine: true, short: true });
    await H.W.cardPrepare(look, 300);
    const want = proofsOwed(H);
    const made = Object.keys(want).length;
    ok(made >= 4 && rowsOwed(H).length === 1 && rowsOwed(H)[0].token && /^[0-9a-f]{192}$/.test(want[Object.keys(want)[0]]),
       'the pieces made for the card keep the mint’s proof (e, s and the blinding factor r, 96 bytes) from the moment they are made, in the row that owes them to it', made + ' pieces');
    const log = logging(H);
    card.tap();
    card.sent.length = 0;
    const wrote = await H.W.cardWrite(card, { owner: true });
    const lines = log.done();
    const loads = sentOf(card, '30');
    const here = placed(card);
    ok(wrote.left === 0 && here.length === made && loads.length === made && loads.every((a) => a.slice(0, 10) === 'b0300100b1' && a.length === 2 * (4 + 1 + 177 + 1) && a.slice(-2) === '02'),
       'on a card of 1.20 every piece goes alone, in a command of its own with P1 = 1: the 81 bytes of the piece, the 96 of its proof, and two bytes expected back', loads.length + ' loads for ' + here.length + ' pieces');
    ok(here.every((p) => card.state.dleq[p.i] === want[p.nonce]) && here.length === Object.keys(want).length,
       'and the card holds each piece’s proof exactly as the phone made it');
    // asked by anybody, in a tap of its own, with no PIN and no grant
    card.tap();
    await card.send(SELECT);
    let readBack = true;
    for (const p of here) readBack = readBack && (await card.send('b01a' + hx(p.i) + 'ff00')) === '01' + want[p.nonce] + '9000';
    ok(readBack && !card.state.verified && !card.state.grant, 'GET_DLEQ gives each one back: 01 and the 96 bytes, to a reader that has shown no PIN and no grant');
    const wroteLine = lines.filter((l) => /\bwrote \d+ piece/.test(l));
    ok(wroteLine.length === 1 && new RegExp('wrote ' + made + ' piece\\(s\\), ' + made + ' with the mint.s proof \\(' + made + ' kept by the card\\), in \\d+ ms$').test(wroteLine[0]) && !/[0-9a-f]{20}/.test(wroteLine[0]),
       'a write leaves one line in the log: how many pieces, how many with the proof, how many the card kept, and the milliseconds; no secret, nonce or point in it', wroteLine.join(' | '));
    const real = realOf(H, card);
    ok(real.length === made && here.every((p) => real.indexOf(p.nonce) >= 0),
       'every piece it wrote from the mint’s own answer is noted as real, by its nonce, once the card said it stored it', real.length + ' nonces');

    // a card of 1.19: the commands it always was, byte for byte
    const o = await loaded(H, 300, { software: 19 });
    const oldLoads = sentOf(o.card, '30');
    const slots = o.card.state.slots.filter((x) => x.status === 1).map((x) => x.data);
    const chunks = [];
    for (let at = 0; at < slots.length; at += 3) chunks.push(slots.slice(at, at + 3));
    const today = chunks.map((some) => 'b0300000' + hx(some.length * 81) + some.join('') + hx(some.length));
    ok(slots.length >= 4 && oldLoads.join() === today.join() && o.card.sent.every((a) => a.slice(0, 4) !== 'b01a'),
       'a card of 1.19 is sent three pieces to a command with P1 = 0, as it always was: the commands are, byte for byte, the pieces in the order they went on', oldLoads.length + ' loads for ' + slots.length + ' pieces');
    ok(o.card.state.dleq === null && Object.keys(o.want).length === slots.length && realOf(H, o.card).length === 0,
       'it keeps no proof (it has no room for one), though the pieces this phone made for it had them; and nothing of it is noted in the store, which is for the cards that keep proofs');
    const olderCard = await loaded(H, 100, { software: 16 });
    ok(sentOf(olderCard.card, '30').every((a) => a.slice(0, 8) === 'b0300000') && olderCard.card.sent.every((a) => a.slice(0, 4) !== 'b01a') && !('dleq' in olderCard.card.state && olderCard.card.state.dleq),
       'and so is a card of 1.16');
    await settle();
  }

  /* ---- 2: a card loaded elsewhere, with good proofs ----------------------------------------------------------------- */
  const H = await funded({}, 60000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  {
    const { card, want } = await loaded(H, 300);
    const n = placed(card).length;
    const log = logging(R);
    const first = await readAs(R, card);
    const lines = log.done();
    const asks = sentOf(card, '1a');
    const here = placed(card);
    ok(asks.length === Math.ceil(n / 2) && asks.every((a, k) => a === 'b01a' + hx(here[k * 2].i) + (here[k * 2 + 1] ? hx(here[k * 2 + 1].i) : 'ff') + '00'),
       'a phone that never saw this card’s pieces asks for the proofs of all of them with its first look, two places to a command and in the order the card listed them', asks.length + ' GET_DLEQ for ' + n + ' pieces');
    ok(first.seen.pieces.every((p) => p.dleq && p.dleq.e + p.dleq.s + p.dleq.r === want[p.nonce]) && first.seen.pieces.every((p) => /^[0-9a-f]{64}$/.test(p.dleq.e) && /^[0-9a-f]{64}$/.test(p.dleq.s) && /^[0-9a-f]{64}$/.test(p.dleq.r)),
       'each comes back kept on its piece as { e, s, r } in hex, equal to the proof the loading phone made');
    ok(first.real === 'ok' && realOf(R, card).length === n && here.every((p) => realOf(R, card).indexOf(p.nonce) >= 0),
       'checked against the mint’s keys, every proof verifies: the verdict is ok, and every piece is noted real', first.real);
    const said = lines.filter((l) => /its proofs: /.test(l));
    ok(said.length === 1 && new RegExp(': ' + n + ' piece\\(s\\) proven \\(' + n + ' checked now\\), 0 with no proof, 0 that cannot be checked here, 0 that fail, in \\d+ ms$').test(said[0]) && !/[0-9a-f]{20}/.test(said[0]),
       'one line in the log: how many were proven, had no proof and failed; no secret, nonce or point', said.join(' | '));
    ok(lines.some((l) => /card: read in \d+ ms \(.*pieces \d+, proofs \d+/.test(l)), 'and the read’s own line says how long the proofs took', (lines.filter((l) => /read in/.test(l))[0] || ''));
    const second = await readAs(R, card);
    ok(count(card, '1a') === 0 && second.real === 'ok' && second.seen.pieces.every((p) => p.dleq === undefined),
       'the second look asks for none: every piece is known real, and nothing is kept on a piece that nothing was asked for');
    // the holder's own phone, which wrote them, never asked either
    const mine = await readAs(H, card, { mine: true });
    ok(count(card, '1a') === 0 && mine.real === 'ok', 'and the phone that loaded the card never asks: it wrote each piece from the mint’s answer');
    // a read that is not the card’s own screen’s (a till’s, the one on the way to a payment) asks for nothing, even where nothing is known real
    const till = await funded({ sharedMint: H.mint, words: THIRD }, 0);
    card.tap();
    card.sent.length = 0;
    const tillSaw = await till.W.cardLook(card, { noAuth: true, brief: true });
    card.tap();
    const tillWhole = await till.W.cardLook(card, { noAuth: true });
    ok(count(card, '1a') === 0 && tillWhole.pieces.length === n && tillWhole.pieces.every((p) => p.dleq === undefined) && tillSaw.pieces.length === n && tillSaw.bare === true,
       'a till’s read, whole or brief, asks for nothing: only the card’s own screen asks (`real`)');
    ok((await till.W.cardRealCheck(tillSaw)) === null && JSON.stringify(realStore(till)) === '{}', 'and a read that lists no nonces (bare) has nothing to check: it says nothing and notes nothing');
  }

  // a mint whose keysets have the long names (NUT-02's second kind): the card holds the first eight bytes, and the phone turns them back before it checks
  {
    const L = await funded({ versionByte: 1 }, 20000);
    const L2 = await funded({ sharedMint: L.mint, words: OTHER_WORDS }, 0);
    const { card } = await loaded(L, 100);
    const long = await readAs(L2, card);
    ok(L.mint.id.length === 66 && long.real === 'ok' && long.seen.pieces.every((p) => p.dleq && p.keyset.length === 16) && realOf(L2, card).length === placed(card).length,
       'at a mint whose keysets have the long names the proofs check too: the card holds eight bytes of the name and the phone has the rest', long.real);
  }

  /* ---- 3: a piece nobody signed, a proof that is another piece's, no proof, and keys that are not at hand --------------- */
  {
    // a made-up piece with a made-up proof, put on by a wallet of somebody else's: the card keeps them, and checks nothing
    const { card } = await loaded(H, 100);
    const n = placed(card).length;
    const made = await forge(H, card, { amount: 8, proof: crypto.randomBytes(96).toString('hex') });
    ok(made.said.slice(2) === '019000' && placed(card).length === n + 1 && card.state.dleq[placed(card).slice(-1)[0].i].length === 192,
       'a made-up piece and a proof of made-up bytes are taken and kept by the card, which checks nothing: it reads as unspent, with its proof', made.said);
    const log = logging(R);
    const bad = await readAs(R, card);
    const lines = log.done();
    ok(bad.real === 'fake' && realOf(R, card).length === n && realOf(R, card).indexOf(made.nonce) < 0,
       'a phone that reads it says fake, and notes every honest piece real and the made-up one not', bad.real + ', ' + realOf(R, card).length + ' of ' + (n + 1));
    ok(lines.some((l) => /its proofs: \d+ piece\(s\) proven \(\d+ checked now\), 0 with no proof, 0 that cannot be checked here, 1 that fail/.test(l)), 'and the log line says one fails', lines.filter((l) => /its proofs/.test(l)).join(' | '));
    ok((await readAs(R, card)).real === 'fake', 'and again: it stays false, since the piece was never noted real and its proof is read and checked each time');
    // a made-up point with no proof at all is not shown real either, but nobody has shown it false
    const none = await loaded(H, 100);
    await forge(H, none.card, { amount: 8, proof: null });
    const unproved = await readAs(R, none.card);
    ok(unproved.real === 'unproven' && unproved.seen.pieces.filter((p) => p.dleq === null).length === 1,
       'a made-up piece put on with no proof reads as unproven, not as fake: the card gave `00` for it, and that is not shown false', unproved.real);

    // another piece's proof in its place
    const swapped = await loaded(H, 100);
    const [a, b] = placed(swapped.card);
    [swapped.card.state.dleq[a.i], swapped.card.state.dleq[b.i]] = [swapped.card.state.dleq[b.i], swapped.card.state.dleq[a.i]];
    const wrong = await readAs(R, swapped.card);
    ok(wrong.real === 'fake' && realOf(R, swapped.card).length === placed(swapped.card).length - 2 && realOf(R, swapped.card).indexOf(a.nonce) < 0 && realOf(R, swapped.card).indexOf(b.nonce) < 0,
       'a real piece with another real piece’s proof in its place is fake: neither is noted real, and the others are', wrong.real + ', ' + realOf(R, swapped.card).length + ' of ' + placed(swapped.card).length);

    // no proof: pieces put on by a build that sends none
    const bareLoad = await loaded(H, 100, undefined, true);
    const plain = sentOf(bareLoad.card, '30');
    ok(Object.keys(bareLoad.want).length === 0 && plain.every((a) => a.slice(0, 8) === 'b0300000') && plain.length === Math.ceil(placed(bareLoad.card).length / 3)
       && bareLoad.card.state.dleq.every((x) => x === ''),
       'a card loaded by a build that sends no proofs is sent plain loads, three to a command, and keeps none');
    const amber = await readAs(R, bareLoad.card);
    ok(amber.real === 'unproven' && amber.seen.pieces.every((p) => p.dleq === null) && realOf(R, bareLoad.card).length === 0 && count(bareLoad.card, '1a') === Math.ceil(placed(bareLoad.card).length / 2),
       'read by another phone it is asked for, gives `00` for every piece, and is unproven: nothing is noted real, nothing is false', amber.real);
    ok((await readAs(H, bareLoad.card, { mine: true })).real === 'ok', 'but the phone that wrote them from the mint’s own answer knows them real');
    // some with a proof and some without
    const mixed = await loaded(H, 50);
    await loaded(H, 100, { card: mixed.card }, true);
    const half = await readAs(R, mixed.card);
    const withProof = half.seen.pieces.filter((p) => p.dleq).length;
    ok(half.real === 'unproven' && withProof > 0 && withProof < half.seen.pieces.length && realOf(R, mixed.card).length === withProof,
       'a card with proofs for some pieces and none for others is unproven: those with are noted real, the others are not', withProof + ' of ' + half.seen.pieces.length);

    // keys not at hand: a phone at a mint whose keys are not this one’s, and one with no mint at all
    const X = await funded({ versionByte: 1 }, 0);
    const good = await loaded(H, 100);
    const away = await readAs(X, good.card);
    ok(away.real === 'unproven' && away.seen.pieces.every((p) => p.dleq && p.dleq.e) && realOf(X, good.card).length === 0,
       'a phone whose mint’s keys are not the ones that signed them reads the proofs and cannot check them: unproven, never fake', away.real);
    const U = (require('./flashcard-kit').page)({ words: OTHER_WORDS });
    const none2 = await readAs(U, good.card);
    ok(none2.real === 'unproven' && realOf(U, good.card).length === 0, 'and a phone connected to no mint at all has no keys to check with: unproven too', none2.real);
    // the same card, read by a phone that has the keys: ok
    ok((await readAs(R, good.card)).real === 'ok', 'and the phone that has them says ok of the same card');

    /* keys this wallet has not loaded (an older keyset of its own mint's, after the mint has changed its keys): they are asked for once,
     * before the pieces are checked. The pieces are proven when the keys come, and left unproven, never fake, when they do not. */
    {
      const CT = R.window.CashuTS;
      let P = null;
      Object.keys(CT).forEach((k) => { const f = CT[k]; if (typeof f === 'function' && f.prototype && Object.getOwnPropertyDescriptor(f.prototype, 'keyChain')) P = f.prototype; });
      const chain = P && Object.getOwnPropertyDescriptor(P, 'keyChain');
      const ensure = P && P.ensureOperableKeysets;
      const hide = (comes) => {
        const asked = [];
        let has = false;
        Object.defineProperty(P, 'keyChain', { configurable: true, get() {
          const real = this._keyChain;
          if (has || !real) return real;
          return new Proxy(real, { get: (t, k) => k === 'getKeyset'
            ? (id) => { const ks = t.getKeyset(id); return ks ? new Proxy(ks, { get: (kt, kk) => (kk === 'hasKeys' ? false : kt[kk]) }) : ks; }
            : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
        } });
        P.ensureOperableKeysets = function (ids) { asked.push((ids || []).slice()); if (comes) has = true; return comes ? Promise.resolve() : Promise.reject(new Error('no route')); };
        return { asked, done: () => { Object.defineProperty(P, 'keyChain', chain); P.ensureOperableKeysets = ensure; } };
      };
      ok(!!P && typeof ensure === 'function', 'the library has the wallet’s keys where this test hides them');
      const older = await loaded(H, 100);
      older.card.tap();
      const seenA = await R.W.cardLook(older.card, { real: true });
      const a = hide(true);
      let realA = '';
      try { realA = await R.W.cardRealCheck(seenA); } finally { a.done(); }
      ok(realA === 'ok' && a.asked.length === 1 && a.asked[0].length === 1 && realOf(R, older.card).length === seenA.pieces.length,
         'keys this wallet had not loaded are asked for once, and the pieces of that keyset are proven when they come', realA + ', asked ' + a.asked.length);
      const older2 = await loaded(H, 100);
      older2.card.tap();
      const seenB = await R.W.cardLook(older2.card, { real: true });
      const b = hide(false);
      let realB = '';
      try { realB = await R.W.cardRealCheck(seenB); } finally { b.done(); }
      ok(realB === 'unproven' && b.asked.length === 1 && realOf(R, older2.card).length === 0,
         'keys that do not come leave the pieces unproven, never fake, and none is noted real', realB + ', asked ' + b.asked.length);
      ok((await R.W.cardRealCheck(seenB)) === 'ok' && realOf(R, older2.card).length === seenB.pieces.length, 'and the same pieces are proven once the keys are at hand');
    }
  }

  /* ---- 4: a mint that gives no NUT-12 proofs ------------------------------------------------------------------------ */
  {
    const N = await funded({ dleq: false }, 20000);
    const { card, want } = await loaded(N, 300);
    const n = placed(card).length;
    const plain = sentOf(card, '30');
    ok(Object.keys(want).length === 0 && n >= 4 && plain.length === Math.ceil(n / 3) && plain.every((a) => a.slice(0, 8) === 'b0300000'),
       'a mint that sends no DLEQ gives the pieces no proof to keep: plain loads, three to a command, as before', plain.length + ' loads for ' + n + ' pieces');
    ok(realOf(N, card).length === n, 'and this phone’s own pieces are real here all the same: they are the mint’s answer to its own swap');
    const again = await readAs(N, card, { mine: true });
    ok(again.real === 'ok' && count(card, '1a') === 0, 'so its own screen says ok of the card and asks it for nothing');
    const R2 = await funded({ sharedMint: N.mint, words: OTHER_WORDS }, 0);
    const other = await readAs(R2, card);
    ok(other.real === 'unproven' && other.seen.pieces.every((p) => p.dleq === null), 'another phone is told `00` for each piece and cannot say they are real: unproven', other.real);
    await settle();
  }

  /* ---- 4b: a card with no room for proofs, and a card that will not give them ---------------------------------------- */
  {
    const c = await funded({}, 20000);
    const card = newCard(c, undefined, { format: 4, proofRoom: false });
    await c.W.cardSetUp(card, { pin: '1234', recoverable: true });
    card.tap();
    await c.W.cardPrepare(await c.W.cardLook(card, { mine: true, short: true }), 300);
    const log = logging(c);
    card.tap();
    card.sent.length = 0;
    const wrote = await c.W.cardWrite(card, { owner: true });
    const lines = log.done();
    const n = placed(card).length;
    const loads = sentOf(card, '30');
    ok(wrote.left === 0 && n >= 4 && card.state.dleq === null && loads[0].slice(0, 10) === 'b0300100b1' && loads.slice(1).every((a) => a.slice(0, 8) === 'b0300000') && loads.length === 1 + Math.ceil((n - 1) / 3),
       'a card the chip gave no room for proofs stores the piece and answers 00 for its proof: that is no error, and the rest of the write goes plain, three to a command', loads.length + ' loads for ' + n + ' pieces');
    ok(lines.filter((l) => /no room for the mint.s proofs/.test(l)).length === 1 && lines.filter((l) => /\bwrote \d+ piece/.test(l)).length === 1
       && lines.filter((l) => /\bwrote \d+ piece/.test(l))[0].indexOf('wrote ' + n + ' piece(s), 1 with the mint’s proof (0 kept by the card), in ') >= 0,
       'it is said once in the log, and the write’s line says one piece was sent with its proof and none was kept', lines.filter((l) => /no room|wrote/.test(l)).join(' | '));
    ok(realOf(c, card).length === n && (await card.send('b01a00ff00')).slice(0, 2) === '00', 'every piece is still real here, and the card gives `00` for any place it is asked about');
    const R3 = await funded({ sharedMint: c.mint, words: OTHER_WORDS }, 0);
    const other = await readAs(R3, card);
    ok(other.real === 'unproven' && other.seen.pieces.every((p) => p.dleq === null), 'another phone is told `00` for every piece: unproven', other.real);

    // a card that will not answer GET_DLEQ, or answers what is not a proof, still reads: its pieces have no proof
    const { card: odd } = await loaded(c, 100);
    const send0 = odd.send.bind(odd);
    odd.send = (a) => (/^b01a/.test(a) ? Promise.resolve('6d00') : send0(a));
    const refused = await readAs(R3, odd);
    ok(refused.real === 'unproven' && refused.seen.pieces.length === placed(odd).length && refused.seen.pieces.every((p) => p.dleq === null),
       'a card that refuses GET_DLEQ still reads, and its pieces are unproven', refused.real);
    odd.send = (a) => (/^b01a/.test(a) ? Promise.resolve('01' + 'ab'.repeat(50) + '9000') : send0(a));
    const junk = await readAs(R3, odd);
    ok(junk.real === 'unproven' && junk.seen.pieces.every((p) => p.dleq === null), 'and so does one that answers something that is not the shape of a proof', junk.real);
    odd.send = send0;
    odd.leaveBefore('1a', 2);
    const gone = await R3.W.cardLook(odd, { real: true }).then(() => 'read', (e) => e.card);
    ok(gone === 'gone', 'a card that leaves while its proofs are asked for is a card that left, as in any read', gone);
    await settle();
  }

  /* ---- 5: a tap cut in the middle of a load with proofs ----------------------------------------------------------- */
  {
    const c = await funded({}, 30000);
    const card = newCard(c, undefined, { format: 4 });
    await c.W.cardSetUp(card, { pin: '1234', recoverable: true });
    card.tap();
    await c.W.cardPrepare(await c.W.cardLook(card, { mine: true, short: true }), 200);
    const want = proofsOwed(c);
    const total = Object.keys(want).length;
    card.tap();
    card.leaveBefore('30', 5);                     // the card leaves as the fifth piece is sent
    const cut = await c.W.cardWrite(card, { owner: true }).then(() => null, (e) => e);
    ok(cut && cut.card === 'gone' && cut.wrote === 4 && placed(card).length === 4 && c.W.cardOwed().length === 1 && total > 8,
       'the card taken away as the fifth piece is sent holds the four before it, and the phone still owes the rest', (cut && cut.card) + ', ' + placed(card).length + ' of ' + total);
    ok(placed(card).every((p) => card.state.dleq[p.i] === want[p.nonce]) && realOf(c, card).length === 4,
       'each of the four holds its own proof, and is noted real (the card said it stored it)');
    card.tap();
    card.sent.length = 0;
    const fin = await c.W.cardWrite(card, { owner: true });
    const nonces = placed(card).map((p) => p.nonce);
    ok(fin.left === 0 && nonces.length === total && new Set(nonces).size === total && c.W.cardOwed().length === 0 && placed(card).every((p) => card.state.dleq[p.i] === want[p.nonce]),
       'the next tap finishes it: every piece is on the card once, with its own proof, and nothing is owed', nonces.length + ' of ' + total);
    ok(count(card, '30') === total && realOf(c, card).length === total,
       'the four already there are sent again (the short read before a write lists no nonces) and refused by the card as pieces it holds, and nothing is lost by it: each piece is noted real', count(card, '30') + ' loads');

    // the same, with the answer lost: the card stored the third piece and nobody heard
    const d = newCard(c, undefined, { format: 4 });
    await c.W.cardSetUp(d, { pin: '1234', recoverable: true });
    d.tap();
    await c.W.cardPrepare(await c.W.cardLook(d, { mine: true, short: true }), 200);
    const wantD = proofsOwed(c);
    d.tap();
    d.loseAnswerOf('30', 3);
    const lost = await c.W.cardWrite(d, { owner: true }).then(() => null, (e) => e);
    ok(lost && lost.card === 'gone' && placed(d).length === 3 && realOf(c, d).length === 2, 'the card that does the third and is lost before it can say so holds three pieces, and the phone has heard of two', (lost && lost.card) + ', ' + placed(d).length + ' on it, ' + realOf(c, d).length + ' noted');
    d.tap();
    d.sent.length = 0;
    const done = await c.W.cardWrite(d, { owner: true });
    const noncesD = placed(d).map((p) => p.nonce);
    ok(done.left === 0 && new Set(noncesD).size === noncesD.length && noncesD.length === Object.keys(wantD).length && c.W.cardOwed().length === 0
       && placed(d).every((p) => d.state.dleq[p.i] === wantD[p.nonce]),
       'the next tap finishes it with nothing twice, and the third piece still has the proof it was sent with', noncesD.length + ' pieces');
    const third = placed(d)[2];
    ok(realOf(c, d).indexOf(third.nonce) < 0, 'the piece nobody heard of is not noted real: the card refused it as one it holds already, and that is not the card saying it stored this one');
    const found = await readAs(c, d, { mine: true });
    ok(found.real === 'ok' && count(d, '1a') === 1 && sentOf(d, '1a')[0] === 'b01a' + hx(third.i) + 'ff00' && realOf(c, d).length === noncesD.length,
       'a look at the card’s own screen asks for that one piece’s proof and no other, and finds it good', sentOf(d, '1a').join(' '));
    await settle();
  }

  /* ---- 6: the card’s own change, finished at the second tap ----------------------------------------------------------- */
  {
    const owner = await funded({}, 9000);
    const till = await funded({ sharedMint: owner.mint, words: OTHER_WORDS }, 0);
    const card = newCard(owner, undefined, { format: 4 });
    await owner.W.cardSetUp(card, { pin: '1234', recoverable: true });
    await binaryLoad(owner, card, 2000);          // 1024 512 256 128 64 16: no exact set for 1000
    const CT = owner.window.CashuTS;
    const blindedFor = (op) => CT.blindMessage(owner.window.Uint8Array.from(Buffer.from(owner.W.cardSecret(op.nonce, card.key, op.date, card.state.record.refund, 4), 'utf8')), BigInt('0x' + op.r)).B_.toHex(true);
    card.tap();
    const paid = await till.W.cardPay(card, { sats: 1000, pin: '1234' });
    const openings = card.state.openings.filter((x) => x.state === 'pending').map((x) => ({ nonce: x.nonce, r: x.r, date: x.date, amount: x.amount }));
    const blind = rowsOwed(till).filter((r) => r.blind).reduce((all, r) => all.concat(r.blind), []);
    ok(paid.sats === 1000 && openings.length >= 2 && blind.length === openings.length && blind.every((b) => b.dleq && b.dleq.e && b.dleq.s),
       'a payment the card makes change for: the till owes the card the change, with what the mint signed for it, its DLEQ among it', openings.length + ' pieces');
    card.tap();
    card.sent.length = 0;
    const log = logging(till);
    const wrote = await till.W.cardWrite(card, { change: true });
    const lines = log.done();
    const loads = sentOf(card, '30');
    const written = placed(card).filter((p) => openings.some((op) => op.nonce === p.nonce));
    ok(wrote.change > 0 && written.length === openings.length && loads.length === openings.length && loads.every((a) => a.slice(0, 10) === 'b0300100b1') && count(card, '40') === 0 && count(card, '45') === 0,
       'at the second tap the change goes on a piece at a time, with P1 = 1, with no PIN sent to the card and no grant: the tap after a payment allows it', loads.length + ' loads');
    ok(openings.every((op) => {
      const at = placed(card).filter((p) => p.nonce === op.nonce)[0];
      const b = blind.filter((x) => x.B_ === blindedFor(op))[0];
      return !!at && !!b && card.state.dleq[at.i] === b.dleq.e + b.dleq.s + op.r;
    }), 'each carries e and s from the mint’s signature for it and the blinding factor r from the opening the card kept: the proof of its own piece');
    ok(lines.filter((l) => /\bwrote \d+ piece/.test(l)).length === 1 && realOf(till, card).length === openings.length,
       'one line for the write, and the till notes the pieces real (it had them from the mint itself)');
    const good = await readAs(owner, card, { mine: true });
    const asked = sentOf(card, '1a');
    ok(good.real === 'ok' && asked.length === 1 && good.seen.pieces.filter((p) => p.dleq).map((p) => p.nonce).sort().join() === openings.map((op) => op.nonce).sort().join(),
       'the owner’s phone wrote the rest of the card itself, and asks only for the proofs of the pieces the till wrote, which it checks: ok', asked.join(' '));
    const other = await readAs(till, card);
    ok(other.real === 'ok' && count(card, '1a') === Math.ceil((placed(card).length - openings.length) / 2) && other.seen.pieces.filter((p) => p.dleq).length === placed(card).length - openings.length,
       'and the till, which wrote only the change, asks for the proofs of the rest and finds them good: ok', other.real);
    await settle();

    // the till’s phone dies: the owner’s phone fetches the change from the mint (NUT-09) and writes it, in the tap that reads the card
    card.tap();
    const second = await till.W.cardPay(card, { sats: 700, pin: '1234' });
    const open2 = card.state.openings.filter((x) => x.state === 'pending').map((x) => ({ nonce: x.nonce, r: x.r, date: x.date, amount: x.amount }));
    till.storage.setItem('foxy.flashcard.owed', '[]');
    const before = new Set(placed(card).map((p) => p.nonce));
    card.tap();
    card.sent.length = 0;
    const fetched = await owner.W.cardLook(card, { mine: true, change: true, real: true });
    const fresh = placed(card).filter((p) => !before.has(p.nonce));
    ok(second.sats === 700 && open2.length >= 1 && fetched.owes && fetched.owes.wrote > 0 && fresh.length === open2.length && fresh.every((p) => /^[0-9a-f]{192}$/.test(card.state.dleq[p.i])),
       'change a till never handed over, fetched from the mint by the owner’s phone and put on in its read, carries the mint’s proof as well', fresh.length + ' pieces');
    ok(count(card, '1a') === 0 && (await owner.W.cardRealCheck(fetched)) === 'ok' && fresh.every((p) => realOf(owner, card).indexOf(p.nonce) >= 0),
       'the owner’s phone had those from the mint and asks the card for no proof of them: the check says ok');
    const verify = await readAs(till, card);
    ok(verify.seen.pieces.filter((p) => open2.some((op) => op.nonce === p.nonce)).every((p) => p.dleq && p.dleq.r === open2.filter((op) => op.nonce === p.nonce)[0].r),
       'and the proof of each, as another phone reads it from the card, has the blinding factor the card kept for it');
  }

  /* ---- 7: the store, the cards a payment reads, and the pieces a card’s own are written back as they were ------------- */
  {
    // twenty cards, the oldest dropped
    const C = await funded({}, 3000);
    const cards = [];
    for (let k = 0; k < 22; k++) {
      const c = newCard(C, undefined, { format: 4 });
      await C.W.cardSetUp(c, { pin: '1234', recoverable: true });
      c.tap();
      await C.W.cardAdd(c, { sats: 3, owner: true });
      cards.push(c);
    }
    const kept = realStore(C);
    ok(Object.keys(kept).length === 20 && cards.slice(2).every((c) => kept[c.key] && kept[c.key].nonces.length === placed(c).length && kept[c.key].at > 0) && !kept[cards[0].key] && !kept[cards[1].key],
       'the store keeps twenty cards, as foxy.flashcard.checked does, and the oldest are the ones dropped', Object.keys(kept).length + ' cards');

    // at most 128 nonces a card: the newest kept
    const D = await funded({}, 5000);
    const card = newCard(D, undefined, { format: 4 });
    await D.W.cardSetUp(card, { pin: '1234', recoverable: true });
    const junk = Array.from({ length: 126 }, (_, i) => crypto.createHash('sha256').update('junk ' + i).digest('hex'));
    D.storage.setItem('foxy.flashcard.real', JSON.stringify({ [card.key]: { at: Date.now(), nonces: junk } }));
    card.tap();
    await D.W.cardAdd(card, { sats: 300, owner: true });
    const m = placed(card).length;
    const have = realOf(D, card);
    ok(m > 10 && have.length === 128 && have.slice(-m).join() === placed(card).map((p) => p.nonce).join() && have[0] === junk[m - 2],
       'at most a hundred and twenty-eight nonces a card: a card with 126 noted that is written ' + m + ' more keeps the newest 128, the oldest dropped', have.length + ' nonces');
    // and cut down to the pieces on the card at a read that checks it
    const stale = junk.slice(0, 20).concat(placed(card).map((p) => p.nonce).slice(0, 5));
    D.storage.setItem('foxy.flashcard.real', JSON.stringify({ [card.key]: { at: Date.now(), nonces: stale } }));
    const cut = await readAs(D, card, { mine: true });
    const left = realOf(D, card);
    ok(cut.real === 'ok' && left.length === m && placed(card).every((p) => left.indexOf(p.nonce) >= 0) && left.every((n) => placed(card).some((p) => p.nonce === n)),
       'a read that checks the card cuts its list down to the pieces on it: the ones noted that are gone are dropped, the ones that are on it and were not are asked for and noted', left.length + ' of ' + m);
  }
  {
    // a payment’s reads ask for no proof: a till that has never seen the card’s pieces pays from it, writes its change, and the owner takes the rest off
    const owner = await funded({}, 9000);
    const till = await funded({ sharedMint: owner.mint, words: OTHER_WORDS }, 0);
    const card = newCard(owner, undefined, { format: 4 });
    await owner.W.cardSetUp(card, { pin: '1234', recoverable: true });
    await binaryLoad(owner, card, 2000);
    card.tap();
    card.sent.length = 0;
    const paid = await till.W.cardPay(card, { sats: 1000, pin: '1234' });
    const asks = [count(card, '1a')];
    card.tap();
    card.sent.length = 0;
    await till.W.cardWrite(card, { change: true });
    asks.push(count(card, '1a'));
    card.tap();
    card.sent.length = 0;
    await owner.W.cardWithdraw(card, { pin: '1234', sats: 100 });
    asks.push(count(card, '1a'));
    ok(paid.sats === 1000 && asks.join() === '0,0,0', 'a payment sends no GET_DLEQ: not the till’s read, not the tap that writes its change, not a withdrawal', asks.join(' '));
    ok(realOf(till, card).length === 2 && Object.keys(realStore(till)).length === 1,
       'and the till’s store holds only what it wrote itself: the two pieces of change it put back', realOf(till, card).length + ' nonces');
  }
  {
    // a card’s own pieces, written back as they came off it, are not made real by being written
    const H2 = await funded({}, 9000);
    const R2 = await funded({ sharedMint: H2.mint, words: OTHER_WORDS }, 0);
    const T = await funded({ sharedMint: H2.mint, words: THIRD }, 0);
    const { card } = await loaded(H2, 2000);
    const holds = card.balance();
    // the mint says no to the signatures: every piece the card signed is still good, and is owed back to it
    R2.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? '400\n' + JSON.stringify({ code: 11000, detail: 'signature for P2PK does not verify' }) : null);
    card.tap();
    const refused = await R2.W.cardPay(card, { sats: 600, pin: '1234' }).then(() => null, (e) => e);
    R2.fate = null;
    const burned = card.state.slots.filter((x) => x.status === 2).map((x) => x.data.substr(24, 64));
    ok(refused && refused.card === 'putback' && burned.length >= 1 && R2.W.cardOwed().length === 1 && R2.W.cardOwed()[0].kind === 'putback',
       'a payment the mint refuses leaves the pieces the card signed owed back to it, as they came off it', refused && refused.card);
    card.tap();
    card.sent.length = 0;
    const back = await R2.W.cardWrite(card, { pin: '1234' });
    const loads = sentOf(card, '30');
    ok(back.back > 0 && card.balance() === holds && loads.length > 0 && loads.every((a) => a.slice(0, 8) === 'b0300000'),
       'they go back onto the card plain, three to a command (the row’s ecash has no proof: it is the card’s own pieces, rebuilt as they were)', loads.length + ' loads');
    const again = placed(card).filter((p) => burned.indexOf(p.nonce) >= 0);
    ok(again.length === burned.length && again.every((p) => card.state.dleq[p.i] === '') && burned.every((n) => realOf(R2, card).indexOf(n) < 0),
       'the card keeps no proof for them, and the phone that wrote them back does not note them real: written back as they were, they are real only if they were known to be', again.length + ' pieces');
    const outsider = await readAs(T, card);
    ok(outsider.real === 'unproven' && outsider.seen.pieces.filter((p) => !p.dleq).length === burned.length, 'another phone reads the rest as proven and these as having no proof: unproven', outsider.real);
    const loader = await readAs(H2, card, { mine: true });
    ok(loader.real === 'ok' && count(card, '1a') === 0, 'the phone that loaded the card had their nonces noted already, and says ok without asking', loader.real);
    await settle();
  }

  /* ---- 8: the line under the card’s title ------------------------------------------------------------------------------ */
  {
    const RED = '#FF5C5C', AMBER = '#F7931A', DIM = 'rgba(var(--ink-rgb),.62)';
    const VERIFIED_AT = /^Verified At \d{1,2}:\d\d(am|pm)(, \d{1,2} [A-Z][a-z]{2})?$/;
    const O = await funded({}, 40000);                                         // the phone that loads the cards
    const V = await funded({ sharedMint: O.mint, words: OTHER_WORDS }, 0);      // another, which reads them on its card screen
    const own = appOn(O), other = appOn(V);
    await own.refreshBalance();
    // the card screen reads a card as a person does, and waits until it has nothing more to say of it
    const read = async (app, ctx, card) => {
      ctx.nfc = card;
      card.tap();
      card.sent.length = 0;
      app.setState({ fc: null, screen: 'flashcard' });
      app.fcRead();
      await until('the card to be read and its pieces checked', () => !!app.state.fc && app.state.fc.check !== 'asking' && app.state.fc.real !== 'asking');
      const v = vals(app);
      return { text: v.fcVerified, ink: v.fcVerifiedInk, face: v.fcCheck, fc: app.state.fc };
    };
    const good = (await loaded(O, 300)).card;

    // the time: the mint was asked, and every piece is real
    let a = await read(own, O, good);
    ok(VERIFIED_AT.test(a.text) && a.ink === DIM && a.fc.proofs === true && a.fc.real === 'ok' && a.face === '' && count(good, '1a') === 0,
       'a card this phone loaded says the time under its title, and asks the card for no proof', a.text);
    a = await read(other, V, good);
    ok(VERIFIED_AT.test(a.text) && a.ink === DIM && a.fc.real === 'ok' && count(good, '1a') > 0 && a.face === '',
       'another phone’s first look at it asks for the proofs and, when both the mint and the proofs have answered, says the time too', a.text);
    a = await read(other, V, good);
    ok(VERIFIED_AT.test(a.text) && count(good, '1a') === 0, 'and its second look asks for none');
    // while it is worked out: Verifying…
    {
      const fresh = await funded({ sharedMint: O.mint, words: THIRD }, 0);
      const app = appOn(fresh);
      fresh.nfc = good;
      good.tap();
      const seen = await fresh.W.cardLook(good, { real: true });
      app.setState({ screen: 'flashcard', fc: null });
      app.fcShow(seen);
      const wait = vals(app).fcVerified;
      await until('the proofs and the mint', () => app.state.fc.check !== 'asking' && app.state.fc.real !== 'asking');
      ok(wait === 'Verifying\u2026' && VERIFIED_AT.test(vals(app).fcVerified), 'until then it says Verifying…', wait + ' > ' + vals(app).fcVerified);
    }

    // red: a made-up piece with a made-up proof
    const forged = (await loaded(O, 100)).card;
    await forge(O, forged, { amount: 8, proof: crypto.randomBytes(96).toString('hex') });
    a = await read(other, V, forged);
    ok(a.text === 'Not Verified' && a.ink === RED && a.fc.real === 'fake', 'a card with a piece nobody signed says Not Verified, in red: the mint calls the piece unspent and the proof is false', a.text + ' ' + a.ink);
    // red: another piece’s proof in its place
    const swapped = (await loaded(O, 100)).card;
    const [p, q] = placed(swapped);
    [swapped.state.dleq[p.i], swapped.state.dleq[q.i]] = [swapped.state.dleq[q.i], swapped.state.dleq[p.i]];
    a = await read(other, V, swapped);
    ok(a.text === 'Not Verified' && a.ink === RED && a.fc.real === 'fake', 'and so does one with another piece’s proof in a piece’s place', a.text + ' ' + a.ink);
    // red, as it was: the mint says a piece is spent
    {
      const t3 = await funded({ sharedMint: O.mint, words: THIRD }, 0);
      const spentCard = (await loaded(O, 600)).card;
      const twin = spentCard.copy();
      t3.nfc = twin;
      twin.tap();
      await t3.W.cardPay(twin, { sats: 100, pin: '1234' });
      a = await read(other, V, spentCard);
      ok(a.text === 'Not Verified' && a.ink === RED && a.fc.real === 'ok' && /already spent/.test(a.face), 'the mint saying a piece is spent is red as it was, whatever the proofs say, and the card’s face says how much', a.text + ' | ' + a.face);
    }
    // amber: no proof (a build that sends none), and keys that are not at hand
    const noProof = (await loaded(O, 100, undefined, true)).card;
    a = await read(other, V, noProof);
    ok(a.text === 'Not Verified' && a.ink === AMBER && a.fc.real === 'unproven' && a.fc.check === 'ok',
       'a card loaded by a build that sends no proofs says Not Verified in amber: the mint calls every piece unspent, and nobody has shown them real', a.text + ' ' + a.ink);
    a = await read(own, O, noProof);
    ok(VERIFIED_AT.test(a.text), 'the phone that loaded those pieces from the mint’s own answer says the time of the same card');
    {
      const X = await funded({ versionByte: 1 }, 0);
      const app = appOn(X);
      a = await read(app, X, good);
      ok(a.text === 'Not Verified' && a.ink === AMBER && a.fc.real === 'unproven', 'a phone whose mint’s keys are not the ones that signed the card’s pieces says Not Verified in amber', a.text + ' ' + a.ink);
    }

    // a card before 1.20 reads as it did: the mint’s word alone
    {
      const old = (await loaded(O, 100, { software: 19 })).card;
      a = await read(other, V, old);
      ok(VERIFIED_AT.test(a.text) && a.ink === DIM && a.fc.proofs === false && a.fc.real === undefined && count(old, '1a') === 0 && count(old, '30') === 0,
         'a card of 1.19, which keeps no proof, says the time under its title as it always did, and is asked for none', a.text);
      const older = (await loaded(O, 100, { software: 16 })).card;
      a = await read(other, V, older);
      ok(VERIFIED_AT.test(a.text) && a.fc.real === undefined && count(older, '1a') === 0, 'and so does a card of 1.16');
    }

    // no connection: the mint cannot be asked, and the line says when it was last
    {
      const mine = (await loaded(O, 100)).card;
      const old = (await loaded(O, 100, { software: 19 })).card;
      a = await read(own, O, mine);
      const at = O.W.cardCheckedAt(own._fcCard);
      ok(VERIFIED_AT.test(a.text) && at > 0, 'a card verified just now has a time on file', String(at));
      a = await read(own, O, old);
      const oldAt = O.W.cardCheckedAt(own._fcCard);
      a = await read(other, V, noProof);
      ok(a.fc.check === 'ok' && a.fc.real === 'unproven' && a.text === 'Not Verified', 'a card whose pieces the mint calls unspent and nobody has found real is asked about online', a.text);
      O.deaf = true;
      V.deaf = true;
      a = await read(own, O, mine);
      ok(a.fc.check === 'off' && a.text === 'Verified At ' + own.fcAt(at) && O.W.cardCheckedAt(own._fcCard) === at,
         'with no connection it says the time the mint was last asked, for a card all of whose pieces this phone knows real', a.text);
      // the mint’s word was had for these same pieces, and they are not all known real: it is worth nothing here
      a = await read(other, V, noProof);
      ok(a.fc.check === 'off' && V.W.cardCheckedAt(other._fcCard) === 0 && a.text === 'Not Verified' && a.ink === AMBER,
         'the mint’s word on file answers nought for a card of 1.20 with a piece that is not known real, and the line is amber', a.text + ' ' + a.ink);
      // the same card before 1.20: only the mint’s word counts, with the real store empty as well
      const store = O.storage.getItem('foxy.flashcard.real');
      O.storage.setItem('foxy.flashcard.real', '{}');
      a = await read(own, O, old);
      ok(oldAt > 0 && O.W.cardCheckedAt(own._fcCard) === oldAt && a.text === 'Verified At ' + own.fcAt(oldAt), 'and a card of 1.19 keeps saying the time, with the real store empty', a.text);
      O.storage.setItem('foxy.flashcard.real', store);
      O.deaf = false;
      V.deaf = false;
    }

    // a read that lists no nonces says nothing of them, and what the screen said stands
    {
      const c = (await loaded(O, 100)).card;
      a = await read(own, O, c);
      const was = a.text;
      c.tap();
      const short = await O.W.cardLook(c, { short: true, mine: true });
      own.fcShow(short);
      ok(short.bare === true && vals(own).fcVerified === was && own.state.fc.real === 'ok', 'after a read of the short kind (the one that follows a write) a verified card is still verified', vals(own).fcVerified);
      const lost = (await loaded(O, 100, undefined, true)).card;
      V.nfc = lost;
      a = await read(other, V, lost);
      lost.tap();
      const short2 = await V.W.cardLook(lost, { short: true });
      other.fcShow(short2);
      ok(a.ink === AMBER && vals(other).fcVerified === 'Not Verified' && vals(other).fcVerifiedInk === AMBER && other.state.fc.real === 'unproven', 'and an amber card is still amber after one', vals(other).fcVerified);
      // a short read that comes while the proofs are still being worked out does not leave them asking for ever: the newest whole read is heard
      const busy = (await loaded(O, 100)).card;
      V.nfc = busy;
      busy.tap();
      const whole = await V.W.cardLook(busy, { real: true });
      other.setState({ screen: 'flashcard', fc: null });
      other.fcShow(whole);
      const asking = other.state.fc.real === 'asking';
      busy.tap();
      other.fcShow(await V.W.cardLook(busy, { short: true }));
      await until('the proofs to be heard', () => other.state.fc.real !== 'asking');
      ok(asking && other.state.fc.real === 'ok', 'a short read that comes while the proofs are being worked out does not leave them asking for ever: the answer for the whole read lands', other.state.fc.real);
      await settle();
    }
  }

  console.log('\n' + (failed ? failed + ' flashcard-proofs check(s) failed' : 'all flashcard-proofs checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
