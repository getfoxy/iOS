'use strict';
/* flashcard-change.js — a card that makes its own change (software 1.12), as the model has it.
 *
 *     node tests/flashcard-change.js
 *
 * A payment's pieces are rarely worth its price. The difference used to be written back by the terminal, which the card
 * cannot check, so the limits had to count the pieces whole. From 1.12 the card makes that change itself
 * (SPEND_ALL_CHANGE): it draws a nonce and a blinding factor, writes the secret as it writes its own pieces' (locked to its
 * own key), hashes it to the curve and blinds it, and signs for the blinded message with the rest of the payment. It keeps
 * the opening (GET_CHANGE) until the piece is written back (LOAD_PROOF). The day's limit and the wait are held to what
 * leaves the card for good, the pieces less that change, worked out at the first SPEND_ALL_SIGN.
 *
 * Software 1.13 shapes the wait: nothing within the limit, change or no change; seven signatures for the first limit's worth
 * over it and three for each after, less one for every piece of change the card made; and one payment a tap at full speed.
 * Software 1.14 takes less off for the change, what it cost: two waits for every three pieces, an output being about two
 * thirds of a signature's work (one for each let a terminal buy the wait down with outputs of a sat). Software 1.15 (the
 * model's default) waits and makes change as 1.14 does, and takes its clock from Bitcoin block headers where 1.14 was told
 * a time under a signature (tests/flashcard-clock.js); a card with a day's limit and no block yet spends its first day on
 * trust, where 1.14 and before refused it, 6A92. `software: 14` is the card before that, `software: 13` the one before it,
 * and `software: 12` the one before that, which waited four signatures to a limit's worth and for the change within it;
 * their tables are here too, run on those cards.
 *
 * Each rule here is the applet's (its source and its own tests); tests/flashcard-model.js replays the applet's own
 * conversation against the model. The blinded message is checked with arithmetic of this file's own, NUT-00's hash to the
 * curve and a point multiplication from BigInt alone, which is itself held to NUT-00's vectors, and the signature with the
 * wallet's text for a piece's secret, so neither is the model's word for itself. The model is set up by writing its state
 * (an owner, a record, a PIN, a time, pieces): the commands that do that are the wallet's, and the replay's, to prove.
 */
const crypto = require('crypto');
const { loadReal } = require('./harness');
const { makeCard } = require('./flashcard-card');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const ctx = loadReal({});
const W = ctx.W, CT = ctx.window.CashuTS;
const own = (buf) => ctx.window.Uint8Array.from(buf);

/* ---- NUT-00's hash to the curve, and a point multiplication, from BigInt alone ------------------------------------- */
const FIELD = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const GEN = [0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n];
const mod = (a) => ((a % FIELD) + FIELD) % FIELD;
const power = (base, e) => {
  let out = 1n, b = mod(base);
  for (; e > 0n; e >>= 1n) { if (e & 1n) out = out * b % FIELD; b = b * b % FIELD; }
  return out;
};
const invert = (a) => power(a, FIELD - 2n);
const addPoints = (A, B) => {
  if (!A) return B;
  if (!B) return A;
  if (A[0] === B[0] && mod(A[1] + B[1]) === 0n) return null;
  const slope = A[0] === B[0] ? mod(3n * A[0] * A[0] * invert(2n * A[1])) : mod((B[1] - A[1]) * invert(B[0] - A[0]));
  const x = mod(slope * slope - A[0] - B[0]);
  return [x, mod(slope * (A[0] - x) - A[1])];
};
const timesPoint = (k, A) => {
  let out = null;
  for (; k > 0n; k >>= 1n) { if (k & 1n) out = addPoints(out, A); A = addPoints(A, A); }
  return out;
};
// the point a message hashes to: x is SHA-256 of SHA-256(domain || message) and a counter, little-endian, from 0; the even y
const hashToCurve = (message) => {
  const first = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('Secp256k1_HashToCurve_Cashu_', 'ascii'), message])).digest();
  for (let counter = 0; counter < 65536; counter++) {
    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(counter);
    const x = BigInt('0x' + crypto.createHash('sha256').update(Buffer.concat([first, tail])).digest('hex'));
    if (x >= FIELD) continue;
    const y2 = mod(x * x * x + 7n), y = power(y2, (FIELD + 1n) / 4n);
    if (mod(y * y) !== y2) continue;
    return [x, y % 2n === 0n ? y : FIELD - y];
  }
  throw new Error('no point');
};
const compressed = (p) => (p[1] % 2n === 0n ? '02' : '03') + p[0].toString(16).padStart(64, '0');
// the blinded message of a secret: Y + r*G, compressed, as hex
const blindedBy = (secret, rHex) => compressed(addPoints(hashToCurve(Buffer.from(secret, 'utf8')), timesPoint(BigInt('0x' + rHex), GEN)));

/* ---- a card to pay with, and a terminal to pay it ------------------------------------------------------------------ */
const hx1 = (n) => ('0' + n.toString(16)).slice(-2);
// the card's software as a table's label says it: the tables below are of 1.16 (`software: 16`) and before; the latest card, 1.17, waits ten where they wait seven (tests/flashcard-reset.js)
const versionOf = (software) => (software === 12 ? ' (1.12)' : software === 13 ? ' (1.13)' : software === 14 ? ' (1.14)' : software === 15 ? ' (1.15)' : ' (1.16)');
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const sha256hex = (text) => sha(Buffer.from(text, 'utf8'));
const sw = (a) => a.slice(-4);
const dat = (a) => a.slice(0, -4);
const SELECT = '00a4040009f0464f585943415244';
const KEYSET = '0059534ce0bfa19a';
const OTHER_KEYSET = '00ad268c4d1f5826';
const REFUND = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const T0 = 1700000000;
const DATED = 1900000000;
// a piece as the card holds it (81 bytes as hex): keyset, amount, nonce, C, date
const pieceWith = (amount, nonce, date, keyset) => (keyset || KEYSET) + u32(amount) + nonce + '02' + sha('C ' + nonce) + u32(date || 0);
const pieceHex = (amount, n, date, keyset) => pieceWith(amount, sha('nonce ' + n), date, keyset);
// a blinded message of the terminal's: any point will do, the card does not look
const POINT = (n) => '02' + sha('point ' + n);

// a card that is ready to be paid with: an owner, a record, a PIN and a time
function newCard(opts) {
  const card = makeCard(Object.assign({ window: ctx.window, format: 4 }, opts));
  Object.assign(card.state, { owner: '04' + '11'.repeat(64), pinState: 1, pin: '31323334', now: T0, windowStart: T0 });
  card.state.record = { set: true, unit: 0, limit: 0, refund: REFUND, timeKey: '04' + '22'.repeat(64), mint: 'https://mint.test', design: '' };
  return card;
}
// the card in the field, selected, and its PIN given
async function tap(card) {
  card.tap();
  await card.send(SELECT);
  return card.send('b04000000431323334');
}
// pieces on the card, in the first places
function fill(card, amounts, date) { amounts.forEach((a, i) => { card.state.slots[i] = { status: 1, data: pieceHex(a, i + 1, date) }; }); }
// the day's limit (0: none) and the limit on one payment (0: none)
function limits(card, day, one) { Object.assign(card.state, { tapLimit: one, windowStart: card.state.now, spent: 0 }); card.state.record.limit = day; }

const begin = (card, places) => card.send('b0220000' + hx1(places.length) + places.map(hx1).join(''));
const output = (card, amount, point) => card.send('b0230000' + '25' + u32(amount) + point);
const change = (card, amount) => card.send('b0260000' + '04' + u32(amount));
const sign = (card) => card.send('b024000040');
const listing = (card, page) => card.send('b019' + hx1(page || 0) + '0000');
const load = (card, hex) => card.send('b0300000' + hx1(hex.length / 2) + hex);
// the signature, asked for until it comes: how many times the card said "not yet" first, and the signature
async function signed(card) {
  let waits = 0, a = '';
  for (;;) {
    a = await sign(card);
    if (a !== '00019000' || waits > 1100) break;
    waits += 1;
  }
  return { answer: a, waits, signature: sw(a) === '9000' && dat(a).length === 128 ? dat(a) : null };
}
// what a payment signs: its pieces' secrets and Cs, then its outputs, the amount in decimal and the point in hex
const message = (card, places, outs) => places.map((i) => {
  const p = W.cardParse.slot('02' + card.state.slots[i].data);
  return W.cardSecret(p.nonce, card.key, p.date, card.state.record.refund, 4) + p.C;
}).join('') + outs.map(([amount, point]) => String(amount) + point).join('');
const verifies = (card, signature, text) => { try { return CT.schnorrVerifyMessage(signature, text, card.key) === true; } catch (e) { return false; } };
// the openings an answer to GET_CHANGE lists
function openings(answer) {
  const d = dat(answer), n = parseInt(d.substr(0, 2), 16), out = [];
  for (let k = 0; k < n; k++) {
    const o = d.substr(2 + 160 * k, 160);
    out.push({ amount: parseInt(o.substr(0, 8), 16), keyset: o.substr(8, 16), date: parseInt(o.substr(24, 8), 16), nonce: o.substr(32, 64), r: o.substr(96, 64) });
  }
  return { n, whole: d.length === 2 + 160 * n, list: out };
}
const pending = (card) => card.state.openings.filter((x) => x.state === 'pending');
const drafts = (card) => card.state.openings.filter((x) => x.state === 'draft');
const states = (card) => card.state.openings.map((x) => x.state[0]).join('');

(async () => {
  /* ---- 1: the arithmetic this file holds the card's point to is NUT-00's --------------------------------------- */
  {
    const vectors = [
      ['00'.repeat(32), '024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725'],
      ['00'.repeat(31) + '01', '022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf'],
      ['00'.repeat(31) + '02', '026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f'],
    ];
    for (const [m, y] of vectors) {
      ok(compressed(hashToCurve(Buffer.from(m, 'hex'))) === y, 'NUT-00 hash to the curve of ...' + m.slice(-2) + ', from BigInt alone');
      ok(CT.hashToCurve(own(Buffer.from(m, 'hex'))).toHex(true) === y, 'and the library the model blinds with gives that point too');
    }
    const r = 'c0ffee00'.repeat(8);
    const viaLibrary = CT.blindMessage(own(Buffer.from('a secret', 'utf8')), BigInt('0x' + r)).B_.toHex(true);
    ok(viaLibrary === blindedBy('a secret', r), 'and blinding is Y + r*G in both');
    // two change outputs the applet itself made, from its recording at 1.12: the card under the simulator, whose key was this
    const theirKey = '02fa05ed0a3649886270bacec5ddc1a3643009a759bee996f9a6ac060c9992a82e';
    for (const [nonce, rr, point] of [
      ['335df88135e195878644ef8cc50591e080a3dca55f48da8550c717af07e42d32', '495c82408dfab85487983026dbe15ff09ce7fa77c6c0caa08da2c91047e12eeb', '03fe48cef60156090fc3d6c081b1eb4bdf0c1fe88ef7d732d0fd7b6284dad60fc4'],
      ['e82c8dc8e79888965c74deaf43cfaedf3b6b18308685eefc750ce60be6d9bdfd', 'd6c2ad27c6a736529e043f808a7a4119cb936b50d02d85a2d4459ae0f3defac2', '0367f815e29b79fc0be19504d75d328f24cf428aee3613c41d468b06ae51c6bfda'],
    ]) {
      ok(blindedBy(W.cardSecret(nonce, theirKey, 0, REFUND, 4), rr) === point, 'the applet’s own change output ' + point.slice(0, 8) + ' is that secret, hashed to the curve, plus r times G (this file’s arithmetic)');
    }
  }

  /* ---- 2: which card it is -------------------------------------------------------------------------------------- */
  {
    const now = newCard({ software: 16 }), fifteen = newCard({ software: 15 }), fourteen = newCard({ software: 14 }), thirteen = newCard({ software: 13 }), twelve = newCard({ software: 12 }), before = newCard({ software: 11 });
    ok((await now.send(SELECT)) === '01109000' && (await fifteen.send(SELECT)) === '010f9000' && (await fourteen.send(SELECT)) === '010e9000' && (await thirteen.send(SELECT)) === '010d9000' && (await twelve.send(SELECT)) === '010c9000' && (await before.send(SELECT)) === '010b9000',
       'SELECT says 1.16, 1.15 for the card with software 15, 1.14 for the card with software 14, 1.13 for the card with software 13, 1.12 for the card with software 12, and 1.11 for the card before that');
    const latest = newCard();
    ok((await latest.send(SELECT)) === '01129000', 'and the card with no software is 1.18, which the tables below do not cover');
    await tap(latest);
    ok(W.cardParse.info(dat(await latest.send('b001000000'))).version === '1.18', 'and reads as 1.18');
    await tap(now); await tap(fifteen); await tap(fourteen); await tap(thirteen); await tap(twelve); await tap(before);
    ok((await now.send('b001000000')).slice(0, 4) === '0110' && (await fifteen.send('b001000000')).slice(0, 4) === '010f' && (await fourteen.send('b001000000')).slice(0, 4) === '010e' && (await thirteen.send('b001000000')).slice(0, 4) === '010d'
       && (await twelve.send('b001000000')).slice(0, 4) === '010c' && (await before.send('b001000000')).slice(0, 4) === '010b',
       'GET_INFO says the same in its version byte');
    /* and the wallet reads from it what the card does with its change: `shaped` from 1.13, from 1.14 `costed`, the change counted for what it cost, and from 1.15 `headers`, a clock that is block headers */
    const readInfo = async (c) => W.cardParse.info(dat(await c.send('b001000000')));
    const reads = [await readInfo(now), await readInfo(fifteen), await readInfo(fourteen), await readInfo(thirteen), await readInfo(twelve), await readInfo(before)].map((i) => [i.version, i.shaped, i.costed, i.headers].join(' '));
    ok(reads.join() === '1.16 true true true,1.15 true true true,1.14 true true false,1.13 true false false,1.12 false false false,1.11 false false false',
       'the wallet reads 1.16 and 1.15 as shaped, costed and keeping their time by block headers, 1.14 as shaped and costed, 1.13 as shaped and not costed, and the cards before them as none of these', reads.join());
    ok(sw(await listing(now)) === '9000' && sw(await listing(fifteen)) === '9000' && sw(await listing(fourteen)) === '9000' && sw(await listing(thirteen)) === '9000' && sw(await listing(twelve)) === '9000' && sw(await listing(before)) === '6d00',
       'GET_CHANGE is the 1.12, 1.13, 1.14, 1.15 and 1.16 cards’, and the card before them does not know it');
    fill(before, [100]);
    await begin(before, [0]);
    ok(sw(await change(before, 10)) === '6d00' && sw(await sign(before)) === '6985', 'nor SPEND_ALL_CHANGE, which like any command it does not know gives a begun payment up');
    const six = newCard({ places: 64 });
    await tap(six);
    ok(sw(await listing(six)) === '6d00', 'nor does the card of sixty-four places');
    ok((await now.copy().send(SELECT)) === '01109000' && (await fifteen.copy().send(SELECT)) === '010f9000' && (await fourteen.copy().send(SELECT)) === '010e9000' && (await thirteen.copy().send(SELECT)) === '010d9000' && (await twelve.copy().send(SELECT)) === '010c9000',
       'and a copy of a card is the card of its software');
  }

  /* ---- 3: a payment with change: one signature over the pieces, the terminal's output and the card's own ------- */
  for (const date of [0, DATED]) {
    const what = date ? 'pieces with a date' : 'pieces with none';
    const card = newCard();
    fill(card, [100, 50], date);
    await tap(card);
    ok((await begin(card, [0, 1])) === u32(150) + '9000', what + ': a payment of two pieces begins, and says they are worth 150');
    const terminal = POINT(1);
    ok((await output(card, 90, terminal)) === '9000', 'the terminal’s output of 90 is taken');
    const a = await change(card, 40), b = await change(card, 20);
    ok(sw(a) === '9000' && sw(b) === '9000' && dat(a).length === 66 && dat(b).length === 66 && /^0[23]/.test(dat(a)) && /^0[23]/.test(dat(b)) && dat(a) !== dat(b),
       'the card makes change of 40 and of 20, and answers a blinded message for each: 33 bytes, a point, not the same', dat(a).slice(0, 12) + ' / ' + dat(b).slice(0, 12));
    ok(states(card) === 'ddeeeeee', 'both openings are drafts, in the first places', states(card));
    const paid = await signed(card);
    ok(!!paid.signature && paid.waits === 0, 'with no limit on a payment it signs at once');
    const outs = [[90, terminal], [40, dat(a)], [20, dat(b)]];
    ok(verifies(card, paid.signature, message(card, [0, 1], outs)), 'one signature over the pieces, the terminal’s output and then the card’s two change outputs, in that order');
    ok(!verifies(card, paid.signature, message(card, [0, 1], outs.slice(0, 1))), 'and not over the terminal’s output alone');
    ok(!verifies(card, paid.signature, message(card, [0, 1], [outs[0], outs[2], outs[1]])), 'nor with the change in another order');
    ok(card.state.slots[0].status === 2 && card.state.slots[1].status === 2, 'both pieces are burned');
    ok(states(card) === 'ppeeeeee', 'and the openings are pending now', states(card));
    const said = openings(await listing(card, 0));
    ok(said.n === 2 && said.whole, 'GET_CHANGE lists two openings of 80 bytes', String(said.n));
    ok(said.list[0].amount === 40 && said.list[1].amount === 20 && said.list.every((o) => o.keyset === KEYSET && o.date === date),
       'with the change’s amounts, and the keyset and date of the pieces it was made from', JSON.stringify(said.list.map((o) => [o.amount, o.date])));
    ok(said.list.every((o) => /^[0-9a-f]{64}$/.test(o.nonce) && BigInt('0x' + o.r) > 0n && BigInt('0x' + o.r) < ORDER) && said.list[0].nonce !== said.list[1].nonce && said.list[0].r !== said.list[1].r,
       'a nonce and a blinding factor to each (the factor under the curve’s order), and no two alike');
    ok(said.list.every((o) => [o.nonce, o.r].every((v) => v.slice(0, 32) !== '0'.repeat(32) && v.slice(32) !== '0'.repeat(32))),
       'each drawn whole: neither half of a nonce or of a factor is zeros');
    const answers = [dat(a), dat(b)];
    ok(said.list.every((o, k) => blindedBy(W.cardSecret(o.nonce, card.key, o.date, REFUND, 4), o.r) === answers[k]),
       'and each opening opens the blinded message the card answered: the secret in the card’s own form' + (date ? ', with its date and refund key' : '') + ', hashed to the curve, plus r times G');
    ok(card.state.log.sats === 90 && card.state.log.ring[(card.state.log.taps - 1) & 7].sats === 90 && card.state.log.ring[(card.state.log.taps - 1) & 7].pieces === 2,
       'the card’s log has 90 sats for the payment, what left it, and the two pieces', String(card.state.log.sats));
    const receipt = card.state.receipts.ring[(card.state.receipts.count - 1) & 15];
    ok(card.state.receipts.count === 1 && receipt.sats === 90 && receipt.out === terminal && receipt.hash === sha256hex(message(card, [0, 1], outs)),
       'and its receipt is for 90, the hash of what was signed, and the terminal’s first output', String(receipt.sats));
    // they outlive the tap, and a copy of the card
    await tap(card);
    ok(pending(card).length === 2 && pending(card.copy()).length === 2 && card.copy().state.openings[1].r === said.list[1].r, 'the openings last past a tap, and are on a copy of the card');
  }

  /* ---- 3b: the opening has the keyset and date of the first piece named ------------------------------------------ */
  {
    const c = newCard();
    c.state.slots[0] = { status: 1, data: pieceHex(100, 1, DATED, KEYSET) };
    c.state.slots[1] = { status: 1, data: pieceHex(50, 2, DATED, OTHER_KEYSET) };
    await tap(c);
    for (const [named, keyset] of [[[0, 1], KEYSET], [[1, 0], OTHER_KEYSET]]) {
      await begin(c, named);
      await change(c, 10);
      ok(c.state.openings[0].keyset === keyset && c.state.openings[0].date === DATED, 'pieces of two keysets, named ' + named + ': the change is of the keyset of the first named (' + keyset.slice(2, 6) + ')', c.state.openings[0].keyset);
    }
  }

  /* ---- 4: what SPEND_ALL_CHANGE refuses, and what it does not ------------------------------------------------------ */
  {
    const fresh = async () => { const c = newCard(); fill(c, [100, 50]); await tap(c); return c; };
    const gone = async (c, what) => ok(sw(await sign(c)) === '6985', what + ': and the payment is given up, there is nothing to sign');
    let c = await fresh();
    ok(sw(await change(c, 10)) === '6985', 'no payment begun: 6985');
    await begin(c, [0, 1]);
    ok(sw(await change(c, 0)) === '6a80', 'nothing is no change: 6a80');
    await gone(c, 'refused');
    await begin(c, [0, 1]);
    ok(sw(await change(c, 151)) === '6a80', 'more than the pieces come to: 6a80');
    await gone(c, 'refused');
    await begin(c, [0, 1]);
    ok(sw(await change(c, 100)) === '9000' && sw(await change(c, 51)) === '6a80', 'by several outputs too: 100, and 51 more is over 150');
    await gone(c, 'refused');
    ok(drafts(c).length === 1, 'the draft it made first stays until the next beginning', states(c));
    await begin(c, [0, 1]);
    ok(sw(await change(c, 150)) === '9000', 'all of it as change is allowed: nothing leaves the card');
    ok(sw(await output(c, 1, POINT(2))) === '6985', 'but no output of the terminal’s after the card’s change: 6985');
    await gone(c, 'refused');
    for (const [name, apdu] of [['three bytes', 'b0260000' + '03' + '000001'], ['five', 'b0260000' + '05' + '0000000001'], ['none', 'b026000000']]) {
      await begin(c, [0, 1]);
      ok(sw(await c.send(apdu)) === '6700', 'an amount of ' + name + ' is not an amount: 6700');
      await gone(c, 'refused');
    }
    ok(c.state.slots[0].status === 1 && c.state.slots[1].status === 1 && pending(c).length === 0, 'nothing was burned by any of it, and nothing is pending');
    // it is a step of the payment, and the terminal's outputs may be none
    await begin(c, [0, 1]);
    const only = await change(c, 40);
    const paid = await signed(c);
    ok(sw(only) === '9000' && !!paid.signature && verifies(c, paid.signature, message(c, [0, 1], [[40, dat(only)]])), 'SPEND_ALL_CHANGE is a step of the payment, and a payment may be all change and no output of the terminal’s');
    ok(c.state.receipts.ring[0].out === '00'.repeat(33), 'whose receipt then has no first output (the card’s own change is not one)');
    // anything but the next step gives a payment begun up, GET_CHANGE and GET_INFO among them
    for (const [name, apdu] of [['GET_CHANGE', 'b019000000'], ['GET_INFO', 'b001000000'], ['GET_PUBKEY', 'b010000000'], ['SPEND_ALL_AGAIN', 'b025000040'], ['a command that does not exist', 'b07f000000']]) {
      c = await fresh();
      await begin(c, [0, 1]);
      await change(c, 10);
      await c.send(apdu);
      await gone(c, name + ' between the change and the signature');
    }
    c = await fresh();
    await begin(c, [0, 1]);
    await change(c, 10);
    await c.send(SELECT);
    await gone(c, 'a SELECT');
    c = await fresh();
    await begin(c, [0, 1]);
    await change(c, 10);
    c.tap();
    await c.send(SELECT);
    await c.send('b04000000431323334');
    await gone(c, 'the card leaving the field');
    ok(drafts(c).length === 1, 'the draft it had made stays, for the next beginning to let go', states(c));
  }

  /* ---- 5: eight openings at most, drafts let go at the next beginning, pages of three ---------------------------- */
  {
    const c = newCard();
    fill(c, [100, 64, 64, 64]);
    await tap(c);
    await begin(c, [0]);
    await change(c, 30);
    await change(c, 20);
    await signed(c);
    const first = openings(await listing(c)).list;
    ok(first.length === 2 && states(c) === 'ppeeeeee', 'two pending after a payment with two change outputs');
    // the change of 30, back: the next tap takes it with no PIN
    c.tap();
    await c.send(SELECT);
    ok(sw(await load(c, pieceWith(30, first[0].nonce, 0))) === '9000', 'the tap after a payment writes the change back with no PIN');
    ok(states(c) === 'epeeeeee', 'and its opening is let go, the other left as it was', states(c));
    ok(JSON.stringify(openings(await listing(c)).list) === JSON.stringify([first[1]]), 'GET_CHANGE lists the other as it was');
    ok(sw(await load(c, pieceWith(30, first[0].nonce, 0))) === '6a94' && states(c) === 'epeeeeee', 'the same piece again is on the card already, and changes nothing else');
    await tap(c);
    // seven drafts and one pending fill the eight
    await begin(c, [1]);
    for (let k = 0; k < 7; k++) if (sw(await change(c, 1)) !== '9000') ok(false, 'change output ' + (k + 1) + ' of a payment');
    ok(states(c) === 'dpdddddd', 'seven drafts take the free places, lowest first', states(c));
    ok(sw(await change(c, 1)) === '6a84', 'the eighth has no opening free: 6a84');
    ok(sw(await sign(c)) === '6985', 'and that refusal gave the payment up');
    ok(openings(await listing(c)).n === 1, 'the drafts are listed by nothing');
    await begin(c, [1]);
    ok(states(c) === 'epeeeeee', 'the next beginning lets the drafts go, and not the pending', states(c));
    for (let k = 0; k < 7; k++) await change(c, 1);
    const done = await signed(c);
    ok(!!done.signature && states(c) === 'pppppppp', 'seven more, signed for: eight pending', states(c));
    const pages = [];
    for (let page = 0; page < 4; page++) pages.push(openings(await listing(c, page)));
    ok(pages.map((p) => p.n).join() === '3,3,2,0' && pages.every((p) => p.whole), 'GET_CHANGE gives three to a page: 3, 3, 2, and then none', pages.map((p) => p.n).join());
    ok(pages.flatMap((p) => p.list).map((o) => o.amount).join() === '1,20,1,1,1,1,1,1', 'in the order of the places', pages.flatMap((p) => p.list).map((o) => o.amount).join());
    ok(sw(await listing(c, 200)) === '9000' && dat(await listing(c, 200)) === '00', 'a page far past them is none, not an error');
    await begin(c, [2]);
    ok(sw(await change(c, 1)) === '6a84', 'while eight are pending no change can be made: 6a84');
    // GET_CHANGE asks for no PIN
    c.tap();
    await c.send(SELECT);
    ok(openings(await listing(c)).n === 3, 'GET_CHANGE asks for no PIN');
  }

  /* ---- 5b: a payment makes eight change outputs at most -------------------------------------------------------- */
  {
    const c = newCard();
    fill(c, [100]);
    await tap(c);
    await begin(c, [0]);
    const made = [];
    for (let k = 0; k < 8; k++) made.push(sw(await change(c, 1)));
    ok(made.every((x) => x === '9000') && states(c) === 'dddddddd', 'a payment on a card with nothing pending makes eight change outputs', states(c));
    ok(sw(await change(c, 1)) === '6a84' && sw(await sign(c)) === '6985', 'and the ninth has no opening free: 6a84, and the payment is given up');
    ok(states(c) === 'dddddddd', 'the drafts are as they were, for the next beginning to let go');
  }

  /* ---- 6: an opening is let go when its piece is written back, and when the listing comes to it held -------------- */
  {
    const c = newCard();
    fill(c, [100, 100]);
    await tap(c);
    await begin(c, [0]);
    await change(c, 10);
    await change(c, 20);
    const draft = c.state.openings[0], other = c.state.openings[1];
    ok(states(c) === 'ddeeeeee', 'two drafts');
    ok(sw(await load(c, pieceWith(10, draft.nonce, 0))) === '9000' && states(c) === 'edeeeeee' && c.state.openings[1] === other, 'a piece with a draft’s nonce put on the card lets that draft go, and no other', states(c));
    await begin(c, [1]);
    ok(states(c) === 'eeeeeeee', 'a draft of a payment given up (the load did it) is let go by the next beginning');
    // a batch of three pieces end to end
    await change(c, 5); await change(c, 6); await change(c, 7);
    const three = c.state.openings.slice(0, 3).map((x) => x.nonce);
    await signed(c);
    c.tap();
    await c.send(SELECT);
    const batch = pieceWith(5, three[0], 0) + pieceWith(6, three[1], 0) + pieceWith(7, three[2], 0);
    ok(sw(await load(c, batch)) === '9000' && states(c) === 'eeeeeeee', 'three pieces to a command let go three openings');
    // a piece the card holds already, spent or not, is never listed, and is let go as the listing comes to it
    const d = newCard();
    fill(d, [100]);
    await tap(d);
    d.state.openings.forEach((x, k) => { d.state.openings[k] = { state: 'pending', amount: k + 1, keyset: KEYSET, date: 0, nonce: sha('open ' + k), r: sha('r ' + k) }; });
    d.state.openings[6] = { state: 'empty' }; d.state.openings[7] = { state: 'empty' };
    d.state.slots[10] = { status: 2, data: pieceWith(5, sha('open 4'), 0) };
    ok(openings(await listing(d, 0)).list.map((o) => o.amount).join() === '1,2,3' && states(d) === 'ppppppee', 'a listing looks no further than the page it fills: an opening held beyond the first page is not yet come to', states(d));
    ok(openings(await listing(d, 1)).list.map((o) => o.amount).join() === '4,6' && states(d) === 'ppppepee', 'the next page comes to it: held (spent, here), it is let go and not listed', states(d));
    d.state.slots[11] = { status: 1, data: pieceWith(2, sha('open 1'), 0) };
    ok(openings(await listing(d, 0)).list.map((o) => o.amount).join() === '1,3,4' && states(d) === 'peppepee', 'an unspent holder lets its opening go the same way, and the page is filled from the ones after', states(d));
    // a load that is refused leaves the openings as they were
    const e = newCard();
    fill(e, [100]);
    await tap(e);
    await begin(e, [0]);
    await change(e, 10);
    await signed(e);
    const o = e.state.openings[0];
    await tap(e);
    const noPoint = pieceWith(10, o.nonce, 0).replace(KEYSET + u32(10) + o.nonce + '02', KEYSET + u32(10) + o.nonce + '05');
    ok(sw(await load(e, noPoint)) === '6a80' && states(e) === 'peeeeeee', 'a piece the card refuses (not a point) lets nothing go');
  }

  /* ---- 7: the limits are held to what leaves the card -------------------------------------------------------- */
  for (const software of [16, 14, 13, 12]) {
    // what the wait is: 1.13's, 1.14's and 1.15's is shaped, nothing within the limit; 1.12 waits a limit's worth for making change, four signatures to a limit's worth
    const V = versionOf(software);
    // (1.15 has no 6A92: a card with a day's limit and no block yet spends its first day on trust)
    const trust = software === 16;
    // (300 less 10 of change is three limits' worth, 10 waits, and one piece of change takes one off in 1.13 and nothing in 1.14: two for every three)
    const E = software === 12
      ? { change90: 4, flagged: 2, three: 12, noClock: 12, allChange: 4, most: 1020, why90: 'but it made change, so one limit’s worth of waiting' }
      : { change90: 0, flagged: 0, three: software === 13 ? 9 : 10, noClock: 10, allChange: 0, most: 766, why90: 'and within the limit, so no waiting, change or no change' };
    const c = newCard({ software });
    limits(c, 100, 100);
    fill(c, [150, 50, 300]);
    await tap(c);
    ok(sw(await begin(c, [0])) === '9000', 'a payment begins whatever it is worth: the day is not asked at the beginning' + V);
    ok(sw(await sign(c)) === '6a8f', 'it is asked at the signing, with the change known: 150 whole is over a day of 100' + V);
    ok(sw(await sign(c)) === '6985', 'and the refusal gave the payment up' + V);
    ok(c.state.log.refused === 1 && c.state.slots[0].status === 1 && c.state.spent === 0, 'written down once; nothing burned and nothing charged' + V);
    await begin(c, [0]);
    await change(c, 60);
    const one = await signed(c);
    ok(!!one.signature && one.waits === E.change90, '150 less 60 of change is 90, within the day, and within the limit on a payment: ' + E.why90 + V, String(one.waits));
    ok(c.state.spent === 90, 'the day is charged what left the card, 90' + V, String(c.state.spent));
    ok((c.state.log.ring[(c.state.log.taps - 1) & 7].flags & 2) === E.flagged, 'and the card’s account of the tap ' + (E.flagged ? 'marks it as waited for' : 'does not mark it as waited for: it was not') + V);
    await begin(c, [1]);
    await change(c, 39);
    ok(sw(await sign(c)) === '6a8f' && sw(await sign(c)) === '6985', '50 less 39 is 11, and 90 and 11 are over the day: refused, at the first command, with no waiting, and the payment is given up' + V);
    ok(c.state.log.refused === 2 && c.state.slots[1].status === 1 && c.state.spent === 90, 'written down, nothing burned, nothing charged' + V);
    await begin(c, [1]);
    await change(c, 40);
    const exact = await signed(c);
    ok(!!exact.signature && c.state.spent === 100, '50 less 40 is 10: the day exactly' + V);
    ok(pending(c).length === 2, 'the change of both payments is pending' + V);
    limits(c, 0, 100);
    // (a second payment in the tap is slowed, 1.13: this one is made in a tap of its own)
    await tap(c);
    await begin(c, [2]);
    await change(c, 10);
    const three = await signed(c);
    ok(!!three.signature && three.waits === E.three, '300 less 10 is 290, and the limit on a payment is 100: three limits’ worth'
       + (software === 12 ? '' : software === 13 ? ', less the one piece of change it made' : ', and the one piece of change it made takes nothing off: two for every three') + V, String(three.waits));

    // a limit and no time
    const n = newCard({ software });
    limits(n, 100, 0);
    n.state.now = 0;
    fill(n, [50]);
    await tap(n);
    if (trust) {
      ok(sw(await begin(n, [0])) === '9000' && !!(await signed(n)).signature && n.state.spent === 50,
         'a day’s limit and no block yet: the payment begins and is signed for on trust, and counted against a day that has no start' + V);
    } else {
      ok(sw(await begin(n, [0])) === '9000' && sw(await sign(n)) === '6a92' && sw(await sign(n)) === '6985', 'a day’s limit and no time: the payment begins, the first signing is refused 6a92, and the payment is given up' + V);
    }
    limits(n, 0, 100);
    n.state.now = 0;
    fill(n, [250]);
    await begin(n, [0]);
    const noClock = await signed(n);
    ok(!!noClock.signature && noClock.waits === E.noClock, 'the limit on a payment asks no clock: 250 under 100 waits three limits’ worth with no time told' + V, String(noClock.waits));

    // the day is asked again at the signing, when the waits are done
    const m = newCard({ software });
    limits(m, 100, 20);
    fill(m, [90]);
    await tap(m);
    await begin(m, [0]);
    ok((await sign(m)) === '00019000', 'a payment of 90 under 20 is made to wait' + V);
    m.state.spent = 50;     // (only a test can move the day between two commands)
    let answer = await sign(m);
    while (answer === '00019000') answer = await sign(m);
    ok(answer === '6a8f' && sw(await sign(m)) === '6985' && m.state.slots[0].status === 1, 'and again at the signing: the day as it stands then refuses it, with nothing burned' + V);

    // nothing leaves the card
    const z = newCard({ software });
    limits(z, 100, 100);
    fill(z, [100]);
    await tap(z);
    await begin(z, [0]);
    await change(z, 100);
    const none = await signed(z);
    ok(!!none.signature && none.waits === E.allChange && z.state.spent === 0 && z.state.log.sats === 0 && z.state.receipts.ring[0].sats === 0,
       'change that is all of the pieces: nothing is charged to the day, the log or the receipt' + (software === 12 ? ', and it still waits one limit’s worth for making change' : ', and nothing is waited for') + V,
       none.waits + ' waits, ' + z.state.spent + ' charged');

    // the sum of pieces wraps
    const w = newCard({ software });
    fill(w, [4294967295, 2]);
    limits(w, 0, 0);
    await tap(w);
    ok((await begin(w, [0, 1])) === 'ffffffff9000', 'two pieces that come to more than four bytes can say begin, and say the most there is' + V);
    ok(!!(await signed(w)).signature, 'and with no limit are signed for' + V);
    fill(w, [4294967295, 2]);
    limits(w, 1000000000, 0);
    ok(sw(await begin(w, [0, 1])) === '6a8f' && sw(await sign(w)) === '6985' && w.state.log.refused === 1, 'a day’s limit refuses such a sum at the beginning, 6a8f, whatever change it would make' + V);
    limits(w, 1000000000, 0);
    w.state.now = 0;
    ok(sw(await begin(w, [0, 1])) === (trust ? '6a8f' : '6a92'), trust ? 'and with no block yet it is the same: a sum that wraps is past any day there is' + V : 'and for want of a time it is 6a92' + V);
    w.state.now = T0;
    limits(w, 0, 100);
    await tap(w);
    await begin(w, [0, 1]);
    const plain = await signed(w);
    ok(!!plain.signature && plain.waits === E.most, 'under a limit on a payment it waits the most there is, ' + E.most + V, String(plain.waits));
    const v = newCard({ software });
    fill(v, [4294967295, 2]);
    limits(v, 0, 100);
    await tap(v);
    await begin(v, [0, 1]);
    await change(v, 5);
    const wrapped = await signed(v);
    ok(!!wrapped.signature && wrapped.waits === E.most && v.state.log.sats === 4294967290, 'and so it does with change, which comes off the most there is' + V, wrapped.waits + ' waits, ' + v.state.log.sats + ' in the log');
    const u = newCard({ software });
    fill(u, [4294967295, 2]);
    limits(u, 0, 100);
    await tap(u);
    await begin(u, [0, 1]);
    await change(u, 4294967290);
    const nearly = await signed(u);
    ok(!!nearly.signature && nearly.waits === E.most && u.state.log.sats === 5, 'and whatever its change: all but 5 of it as change still waits the most, for the sum wrapped' + V, nearly.waits + ' waits, ' + u.state.log.sats + ' in the log');
    const t = newCard({ software });
    fill(t, [4294967295, 4294967295, 5]);
    limits(t, 0, 4294967295);
    await tap(t);
    await begin(t, [0, 1, 2]);
    const most = await signed(t);
    ok(!!most.signature && most.waits === E.most, 'a sum that wraps is past any limit, the largest included, and waits the most' + V, String(most.waits));
  }

  /* ---- 7b: change made among the waits ---------------------------------------------------------------------- */
  for (const software of [16, 14, 13, 12]) {
    const V = versionOf(software);
    // the card works the wait out once, at the first SIGN, from what leaves it then. Change made after that is still change: it
    // is in the message, and what the day, the log and the receipt are charged is what leaves the card when it signs.
    const whole = software === 12 ? 8 : 7;
    const c = newCard({ software });
    limits(c, 1000, 100);
    fill(c, [150]);
    await tap(c);
    await begin(c, [0]);
    ok((await sign(c)) === '00019000' && (await sign(c)) === '00019000', 'a payment of 150 under 100 is made to wait: two limits’ worth, ' + whole + ' waits' + V);
    const late = await change(c, 60);
    ok(sw(late) === '9000', 'and change may still be made among the waits' + V);
    const paid = await signed(c);
    ok(!!paid.signature && paid.waits === whole - 2, 'the waits were counted once, from 150: ' + whole + ' in all, ' + (whole - 2) + ' after the two' + V, String(paid.waits));
    ok(verifies(c, paid.signature, message(c, [0], [[60, dat(late)]])) && c.state.spent === 90 && c.state.log.sats === 90 && c.state.receipts.ring[0].sats === 90,
       'it is signed over the change, and the day, the log and the receipt have 90, what left the card when it signed' + V);
    // outputs among the waits are the terminal's, and are refused once the card has made change
    const d = newCard({ software });
    limits(d, 0, 100);
    fill(d, [150]);
    await tap(d);
    await begin(d, [0]);
    await sign(d);
    ok((await output(d, 90, POINT(4))) === '9000', 'the terminal’s outputs may come among the waits too' + V);
    await change(d, 60);
    ok(sw(await output(d, 1, POINT(5))) === '6985' && sw(await sign(d)) === '6985', 'but not after the card’s change' + V);
  }

  /* ---- 8: the wait, software 1.14 and 1.13: nothing within the limit, 7 for the first limit's worth over it, 3 for each after ------- *
   * The two are the same but for what the change the card made counts for. 1.13 took one wait off for each piece, which was more than a
   * piece costs (an output is about two thirds of a signature's work), and a terminal could buy a payment's wait down with outputs of a
   * sat. 1.14 takes two off for every three pieces, floor(2 * made / 3): a payment over the limit takes about as long in the hand with
   * change as without, and the most the eight pieces a card can make take off is five. */
  for (const software of [16, 14, 13]) {
    const V = versionOf(software);
    // what k pieces of change count for, and what the wallet is told of the card (`info.costed`) to say the same
    const credit = (k) => (software === 13 ? k : Math.floor(2 * k / 3));
    const costed = software !== 13;
    // the applet's table: the limit, the waits, then the pieces; no change. A payment is within the limit up to a thirty-second over it.
    const table = [
      [100, 0, 100], [100, 0, 60, 40], [100, 0, 1], [100, 0, 101], [100, 0, 103], [100, 7, 104], [100, 0, 100, 1], [100, 7, 200], [100, 7, 100, 100],
      [100, 7, 150, 50], [100, 7, 70, 70, 60], [100, 10, 201], [100, 10, 100, 100, 1], [100, 10, 300], [100, 13, 301], [100, 31, 1000], [100, 34, 1001],
      [1, 0, 1], [1, 7, 2], [1, 10, 3], [1, 10, 1, 1, 1], [7, 0, 7], [7, 7, 8], [7, 7, 14], [7, 10, 15], [255, 0, 255], [255, 0, 256], [255, 0, 262], [255, 7, 263],
      [256, 0, 256], [256, 0, 257], [65536, 0, 65536], [65536, 0, 65537], [16777216, 0, 16777217], [2147483647, 10, 2147483647, 2147483647, 1],
      [4294967295, 0, 4294967295], [2147483648, 0, 2147483648], [2147483648, 0, 2147483649],
      // the most: 255 limits' worth, however much more (7 + 3 * 253 = 766)
      [1, 763, 254], [1, 766, 255], [1, 766, 256], [1, 766, 1000], [10, 766, 2550], [10, 766, 100000],
    ];
    const bad = [];
    for (const [limit, want, ...pieces] of table) {
      const c = newCard({ software });
      limits(c, 0, limit);
      fill(c, pieces);
      await tap(c);
      await begin(c, pieces.map((_, i) => i));
      const r = await signed(c);
      if (!r.signature || r.waits !== want) bad.push('pieces ' + pieces + ' under ' + limit + ': ' + r.waits + ', not ' + want);
      // and the wallet's estimate of it, which a till gives a person before the PIN is sent, is the card's
      const said = W.cardWaitSigns(limit, pieces.reduce((a, b) => a + b, 0), 0, false, costed);
      if (said !== want) bad.push('the wallet says ' + said + ' for pieces ' + pieces + ' under ' + limit + ', not ' + want);
    }
    ok(bad.length === 0, 'a payment worth S under a limit L waits nothing within it (or a thirty-second over it), 7 for the first limit’s worth over and 3 for each after, 255 limits’ worth at most (the applet’s own table, and its most: ' + table.length + ' cases), and the wallet’s estimate is the same' + V, bad.join('; '));

    // with change: what leaves the card is the net, and the piece of change made counts for what it cost (1.14: nothing, one piece is under two thirds of a signature; 1.13: one signature done). Within the limit it waits nothing, change or no change.
    const withChange = [
      // the limit, the waits on 1.14 and on 1.13, the change (one piece), then the pieces
      [100, 0, 0, 60, 150], [100, 0, 0, 100, 100], [100, 0, 0, 10, 60], [100, 0, 0, 50, 150], [100, 0, 0, 49, 150], [100, 7, 6, 40, 150], [100, 10, 9, 10, 300], [100, 7, 6, 100, 300], [100, 10, 9, 99, 300],
      [100, 0, 0, 1, 102], [100, 0, 0, 1, 100], [100, 0, 0, 1, 1], [1, 0, 0, 1, 1], [1, 0, 0, 2, 3], [1, 7, 6, 1, 3], [1, 766, 765, 1, 1000], [7, 0, 0, 7, 14], [7, 7, 6, 6, 14],
      // a thirty-second over, with change: still within
      [100, 0, 0, 50, 153], [100, 7, 6, 49, 153],
    ];
    const worse = [];
    for (const [limit, want14, want13, made, ...pieces] of withChange) {
      const want = software === 13 ? want13 : want14;
      const c = newCard({ software });
      limits(c, 0, limit);
      fill(c, pieces);
      await tap(c);
      await begin(c, pieces.map((_, i) => i));
      const point = await change(c, made);
      const r = await signed(c);
      if (sw(point) !== '9000' || !r.signature || r.waits !== want) worse.push('pieces ' + pieces + ' less ' + made + ' under ' + limit + ': ' + r.waits + ', not ' + want);
      const said = W.cardWaitSigns(limit, pieces.reduce((a, b) => a + b, 0) - made, 1, false, costed);
      if (said !== want) worse.push('the wallet says ' + said + ' for pieces ' + pieces + ' less ' + made + ' under ' + limit + ', not ' + want);
    }
    ok(worse.length === 0, 'a payment that makes change waits as its net says, ' + (costed ? 'the one piece of change it made taking nothing off' : 'one signature less for the piece of change it made') + ', and nothing within the limit (' + withChange.length + ' of them), and the wallet’s estimate is the same' + V, worse.join('; '));

    /* The change counts for what it cost: on 1.14 two for every three pieces, so 0, 1, 2, 3, 4, 6 and 8 pieces take off 0, 0, 1, 2, 2, 4 and 5;
     * on 1.13 one for each, so 0, 1, 2, 3, 4, 6 and 8. And the wait is never below nothing (on 1.14 not even eight pieces get there: 7 less 5 is 2). */
    const parts = [
      // the limit, the waits on 1.14 and on 1.13, the pieces of change (amounts), then the pieces
      // ten limits' worth over a limit of 10 (7 + 3 * 8 = 31), with 0 to 8 pieces of a sat taken from it
      [10, 31, 31, [], 100], [10, 31, 30, [1], 100], [10, 30, 29, [1, 1], 100], [10, 29, 28, [1, 1, 1], 100], [10, 29, 27, [1, 1, 1, 1], 100],
      [10, 28, 26, [1, 1, 1, 1, 1], 100], [10, 27, 25, [1, 1, 1, 1, 1, 1], 100], [10, 27, 24, [1, 1, 1, 1, 1, 1, 1], 100], [10, 26, 23, [1, 1, 1, 1, 1, 1, 1, 1], 100],
      // the first limit's worth over, 7 (a piece of 20 is two limits' worth, and twelve is still two), with the same
      [10, 7, 7, [], 20], [10, 7, 6, [1], 20], [10, 6, 5, [1, 1], 20], [10, 5, 4, [1, 1, 1], 20], [10, 5, 3, [1, 1, 1, 1], 20],
      [10, 4, 2, [1, 1, 1, 1, 1], 20], [10, 3, 1, [1, 1, 1, 1, 1, 1], 20], [10, 3, 0, [1, 1, 1, 1, 1, 1, 1], 20], [10, 2, 0, [1, 1, 1, 1, 1, 1, 1, 1], 20],
      // and not below nothing, with pieces of every size
      [100, 6, 5, [200, 100], 500], [100, 2, 0, [1, 1, 1, 1, 1, 1, 1, 1], 120], [100, 5, 3, [30, 10, 6, 2], 150 + 3], [100, 12, 10, [1, 1, 1, 1, 1, 1], 500],
      // within the limit, change or no change, whatever its pieces: nothing
      [100, 0, 0, [20, 20, 20, 20, 20, 20], 150], [100, 0, 0, [1, 1, 1, 1, 1, 1, 1, 1], 100],
    ];
    const taken = [];
    for (const [limit, want14, want13, outs, ...pieces] of parts) {
      const want = software === 13 ? want13 : want14;
      const c = newCard({ software });
      limits(c, 0, limit);
      fill(c, pieces);
      await tap(c);
      await begin(c, pieces.map((_, i) => i));
      let all = true;
      for (const a of outs) all = all && sw(await change(c, a)) === '9000';
      const r = await signed(c);
      if (!all || !r.signature || r.waits !== want) taken.push('pieces ' + pieces + ' less ' + outs.join('+') + ' under ' + limit + ': ' + r.waits + ', not ' + want);
      const said = W.cardWaitSigns(limit, pieces.reduce((a, b) => a + b, 0) - outs.reduce((a, b) => a + b, 0), outs.length, false, costed);
      if (said !== want) taken.push('the wallet says ' + said + ' for pieces ' + pieces + ' less ' + outs.join('+') + ' under ' + limit + ', not ' + want);
    }
    ok(taken.length === 0, 'and the change counts toward it for what it cost: ' + (costed ? 'two waits for every three pieces, so 0, 1, 2, 3, 4, 6 and 8 pieces take off 0, 0, 1, 2, 2, 4 and 5' : 'one wait for each piece, so 0, 1, 2, 3, 4, 6 and 8 pieces take off as many') + ' (' + parts.length + ' of them), and the wallet’s estimate says the same' + V, taken.join('; '));
    ok(Array.from({ length: 9 }, (_, k) => credit(k)).join() === (costed ? '0,0,1,2,2,3,4,4,5' : '0,1,2,3,4,5,6,7,8'), 'what k pieces count for, k from 0 to 8, is the closed form of it' + V);

    // in seconds, as the screen tells a person, at 0.8 a signature; and sixteen limits' worth is as much as a till holds a card for (forty seconds)
    const secs = (limit, sats, made, second) => W.cardWait(limit, sats, made, second, costed);
    ok(secs(100, 100, 0, false) === 0 && secs(100, 200, 0, false) === 6 && secs(100, 201, 0, false) === 8 && secs(100, 200, 4, false) === (costed ? 4 : 3)
       && secs(100, 1600, 0, false) === 40 && secs(100, 1700, 0, false) === 42 && secs(0, 50, 0, true) === 6,
       'the wallet says the wait in seconds: 6 for the first limit’s worth over, 8 for the next, ' + (costed ? '4 with four pieces of change (5 signatures)' : '3 with four pieces of change (3 signatures)') + ', 40 for sixteen limits’ worth (the most it holds a card for), 6 for a second payment with no limit' + V,
       [secs(100, 200, 0, false), secs(100, 201, 0, false), secs(100, 200, 4, false), secs(100, 1600, 0, false), secs(100, 1700, 0, false)].join());

    // a sweep of both against the rule in closed form, with up to eight pieces of change of every size
    let seed = 20240607;
    const roll = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const off = [];
    for (let k = 0; k < 80; k++) {
      const limit = 1 + roll(400), sum = 1 + roll(limit * (k % 5 === 0 ? 400 : 12));
      const count = roll(3) === 0 ? 0 : Math.min(sum, 1 + roll(8));
      // each piece at least a sat, together not more than the pieces come to
      const outs = [];
      for (let j = 0, room = sum; j < count; j++) {
        const a = 1 + roll(Math.max(1, Math.floor((room - (count - 1 - j)) / 2)));
        outs.push(a);
        room -= a;
      }
      const net = sum - outs.reduce((a, b) => a + b, 0);
      const units = net <= limit + Math.floor(limit / 32) ? 1 : Math.min(255, Math.ceil(net / limit));
      const want = units <= 1 ? 0 : Math.max(0, 7 + 3 * (units - 2) - credit(count));
      const c = newCard({ software });
      limits(c, 0, limit);
      fill(c, [sum]);
      await tap(c);
      await begin(c, [0]);
      for (const a of outs) await change(c, a);
      const r = await signed(c);
      if (!r.signature || r.waits !== want) off.push(sum + ' less ' + outs.join('+') + ' under ' + limit + ': ' + r.waits + ', not ' + want);
      const said = W.cardWaitSigns(limit, net, count, false, costed);
      if (said !== want) off.push('the wallet says ' + said + ' for ' + sum + ' less ' + outs.join('+') + ' under ' + limit + ', not ' + want);
    }
    ok(off.length === 0, 'eighty payments, with up to eight pieces of change and without, wait as the rule says, and the wallet’s estimate says the same' + V, off.join('; '));

    // every wait is "not yet", 00 01, and says nothing of how many are left
    const c = newCard({ software });
    limits(c, 0, 10);
    fill(c, [95]);
    await tap(c);
    await begin(c, [0]);
    const all = [];
    for (let k = 0; k < 36; k++) all.push(await sign(c));
    ok(all.slice(0, 31).every((a) => a === '00019000') && sw(all[31]) === '9000' && dat(all[31]).length === 128,
       '95 under 10 is ten limits’ worth, 7 + 3 * 8 = 31 waits: each is the same two bytes, whatever is left, and the signature is the answer after the last' + V);
    ok(c.state.slots[0].status === 2 && all.slice(32).every((a) => a === '6985'), 'only then is the piece burned, and a command after it is not another signing' + V);
  }

  /* ---- 8a: one payment a tap at full speed (1.13 and 1.14) ------------------------------------------------------------- *
   * A second payment signed in the same time in the field waits as one over the limit does, 7, with a limit or without one,
   * and its own count where that is more, less what the change it made counts for (one for each piece on 1.13, two for every
   * three on 1.14); a SELECT is not a new time in the field, the card leaving it is; the owner's grant in the tap lifts it
   * (and a SELECT takes the grant away); a payment begun and given up, or refused, or a load, is not a payment. The card of
   * 1.12 knows none of it. */
  for (const software of [16, 14, 13]) {
    const V = versionOf(software);
    const costed = software !== 13;
    const credit = (k) => (software === 13 ? k : Math.floor(2 * k / 3));
    const pay = async (c, place, outs) => {
      await begin(c, [place]);
      for (const a of outs || []) await change(c, a);
      const r = await signed(c);
      // (-1: no signature came, so a payment given up is never read as a wait of nothing)
      return { waits: r.signature ? r.waits : -1 };
    };
    // no limit: the first payment of a tap goes at once, every one after it waits seven
    let c = newCard({ software });
    fill(c, [10, 10, 10, 10, 10, 10]);
    await tap(c);
    const run = [];
    for (let i = 0; i < 4; i++) run.push((await pay(c, i)).waits);
    ok(run.join() === '0,7,7,7', 'with no limit, the first payment of a tap goes at once and each after it waits 7' + V, run.join());
    ok((c.state.log.ring[(c.state.log.taps - 1) & 7].flags & 2) === 2, 'and the card’s account of the tap marks it as waited for' + V);
    // a SELECT is the same time in the field
    await c.send(SELECT);
    await c.send('b04000000431323334');
    ok((await pay(c, 4)).waits === 7, 'a new SELECT is the same time in the field: still slowed' + V);
    // the card leaving the field is a new one
    await tap(c);
    ok((await pay(c, 5)).waits === 0, 'the card out of the field and back is a new tap: the first payment of it goes at once' + V);

    /* with a limit: within it the second waits seven; over it, its own count, which is at least that; change counts toward it for what it cost.
     * A card for each, that has paid once already in its tap: it keeps eight openings, and the change of a payment is pending until it is written back. */
    const spentIn = [];
    const second1 = async (piece, outs) => {
      const d = newCard({ software });
      limits(d, 0, 100);
      fill(d, [50, piece]);
      await tap(d);
      const one = (await pay(d, 0)).waits;
      const two = one === 0 ? (await pay(d, 1, outs)).waits : -2;
      spentIn.push(d.state.spent);
      return two;
    };
    const lim = [];
    {
      const d = newCard({ software });
      limits(d, 0, 100);
      fill(d, [50]);
      await tap(d);
      lim.push((await pay(d, 0)).waits);
    }
    lim.push(await second1(50));
    lim.push(await second1(250));
    lim.push(await second1(50, [10]));
    lim.push(await second1(50, [1, 1, 1, 1, 1, 1, 1, 1]));
    lim.push(await second1(150, [10, 10, 10, 10]));
    const limWant = costed ? '0,7,10,7,2,5' : '0,7,10,6,0,3';
    ok(lim.join() === limWant, 'with a limit of 100: 50 goes at once; the next 50, within the limit, waits 7; 250 waits its own 10; a second 50 with a piece of change 7 less ' + credit(1)
       + '; with eight pieces of change 7 less ' + credit(8) + '; 150 less 40 of change in four pieces 7 less ' + credit(4) + V, lim.join());
    const est = [W.cardWaitSigns(100, 50, 0, false, costed), W.cardWaitSigns(100, 50, 0, true, costed), W.cardWaitSigns(100, 250, 0, true, costed), W.cardWaitSigns(100, 40, 1, true, costed),
                 W.cardWaitSigns(100, 42, 8, true, costed), W.cardWaitSigns(100, 110, 4, true, costed)];
    ok(est.join() === limWant, 'and the wallet’s estimate for a second payment says the same, with the limit or without it: 7 with none' + V,
       est.join() + ' / ' + W.cardWaitSigns(0, 50, 0, true, costed) + ',' + W.cardWaitSigns(0, 50, 2, true, costed) + ',' + W.cardWaitSigns(0, 50, 0, false, costed));
    ok(spentIn.length === 5 && spentIn.every((x) => x === 0), 'and the slowing takes nothing from a day that has no limit' + V, spentIn.join());

    /* with no limit a second payment waits 7 less what its change counts for, never below nothing, and the first waits nothing: the model
     * with 0 to 8 pieces of change (a card of its own for each: it keeps eight openings), and the wallet's estimate for those and beyond */
    const second = [];
    for (let k = 0; k <= 8; k++) {
      const d = newCard({ software });
      fill(d, [30, 30]);
      await tap(d);
      await pay(d, 0);
      second.push((await pay(d, 1, Array.from({ length: k }, () => 1))).waits);
    }
    const secondWant = costed ? '7,7,6,5,5,4,3,3,2' : '7,6,5,4,3,2,1,0,0';
    ok(second.join() === secondWant, 'with no limit, a second payment with 0 to 8 pieces of change waits 7 less ' + (costed ? 'two for every three' : 'one for each') + ': ' + secondWant + V, second.join());
    const guessed = Array.from({ length: 9 }, (_, k) => W.cardWaitSigns(0, 50, k, true, costed));
    ok(guessed.join() === secondWant && W.cardWaitSigns(0, 50, 12, true, costed) === 0 && W.cardWaitSigns(0, 50, 0, false, costed) === 0 && W.cardWaitSigns(0, 4294967295, 0, false, costed) === 0,
       'and the wallet says the same, never below nothing (twelve pieces would take eight off), and the first payment waits nothing' + V, guessed.join());

    // the grant lifts it, and a SELECT takes the grant away
    c = newCard({ software });
    fill(c, [10, 10, 10, 10]);
    await tap(c);
    c.state.grant = true;                         // (ALLOW_LOAD with the owner's proof does this; the recording of the applet replays it)
    const owner = [(await pay(c, 0)).waits, (await pay(c, 1)).waits, (await pay(c, 2)).waits];
    ok(owner.join() === '0,0,0', 'the owner’s grant in the tap: no payment of it is slowed' + V, owner.join());
    await c.send(SELECT);
    await c.send('b04000000431323334');
    ok(c.state.grant === false && (await pay(c, 3)).waits === 7, 'a SELECT takes the grant away: the next payment is the second of the time in the field, and waits' + V);

    // a payment given up, or refused, or a load, is not a payment
    c = newCard({ software });
    limits(c, 150, 0);
    fill(c, [100, 100, 20, 20]);
    await tap(c);
    await begin(c, [0]);
    await c.send('b001000000');
    ok((await pay(c, 0)).waits === 0, 'a payment begun and given up is not a payment: the first one signed goes at once' + V);
    await tap(c);
    await begin(c, [1]);
    ok(sw(await sign(c)) === '6a8f', 'a payment the day refuses (100 and 100 of a day of 150)' + V);
    ok((await pay(c, 2)).waits === 0, 'is not a payment either: the next goes at once' + V);
    ok((await pay(c, 3)).waits === 7, 'and the one after the first that is signed is slowed' + V);
    c = newCard({ software });
    fill(c, [10, 10]);
    await tap(c);
    ok(sw(await load(c, pieceHex(5, 77, 0))) === '9000' && (await pay(c, 0)).waits === 0, 'a load is not a payment: the first payment after one goes at once' + V);
    ok(sw(await load(c, pieceHex(5, 78, 0))) === '9000' && (await pay(c, 1)).waits === 7, 'and a load between two payments does not start the tap afresh' + V);

    // a copy of the card is another card: its time in the field is its own
    const first = newCard({ software });
    fill(first, [10, 10]);
    await tap(first);
    await pay(first, 0);
    const twin = first.copy();
    await tap(twin);
    ok((await pay(twin, 1)).waits === 0 && (await pay(first, 1)).waits === 7, 'a copy of a card that has paid is not slowed for it, and the card itself is' + V);
    ok((await twin.copy().send(SELECT)) === (software === 13 ? '010d9000' : software === 14 ? '010e9000' : '01109000'), 'and the copy is the card of its software' + V);
  }
  {
    // the card of 1.12 waits for none of it
    const c = newCard({ software: 12 });
    fill(c, [10, 10, 10]);
    await tap(c);
    const old12 = [];
    for (let i = 0; i < 3; i++) { await begin(c, [i]); old12.push((await signed(c)).waits); }
    ok(old12.join() === '0,0,0', 'the card of 1.12 knows no such rule: every payment goes at once', old12.join());
  }

  /* ---- 8b: software 1.12's wait: nothing within the limit, ceil(net / limit) limits' worth over it, four signatures each -------- */
  {
    // the applet's table: the limit, the waits, then the pieces; no change
    const table = [
      [100, 0, 100], [100, 0, 60, 40], [100, 0, 1], [100, 8, 101], [100, 8, 100, 1], [100, 8, 200], [100, 8, 100, 100], [100, 8, 150, 50],
      [100, 8, 70, 70, 60], [100, 12, 201], [100, 12, 100, 100, 1], [100, 12, 300], [100, 16, 301], [100, 40, 1000], [100, 44, 1001],
      [1, 0, 1], [1, 8, 2], [1, 12, 3], [1, 12, 1, 1, 1], [7, 0, 7], [7, 8, 8], [7, 8, 14], [7, 12, 15], [255, 0, 255], [255, 8, 256],
      [256, 0, 256], [256, 8, 257], [65536, 0, 65536], [65536, 8, 65537], [16777216, 8, 16777217], [2147483647, 12, 2147483647, 2147483647, 1],
      [4294967295, 0, 4294967295], [2147483648, 0, 2147483648], [2147483648, 8, 2147483649],
      // the most: 255 limits' worth, however much more
      [1, 1016, 254], [1, 1020, 255], [1, 1020, 256], [1, 1020, 1000], [10, 1020, 2550], [10, 1020, 100000],
    ];
    const bad = [];
    for (const [limit, want, ...pieces] of table) {
      const c = newCard({ software: 12 });
      limits(c, 0, limit);
      fill(c, pieces);
      await tap(c);
      await begin(c, pieces.map((_, i) => i));
      const r = await signed(c);
      if (!r.signature || r.waits !== want) bad.push('pieces ' + pieces + ' under ' + limit + ': ' + r.waits + ', not ' + want);
      const said = W.cardWaitSigns12(limit, pieces.reduce((a, b) => a + b, 0), false);
      if (said !== want) bad.push('the wallet says ' + said + ' for pieces ' + pieces + ' under ' + limit + ', not ' + want);
    }
    ok(bad.length === 0, 'a card of 1.12: a payment worth S under a limit L waits nothing within it and ceil(S / L) * 4 over it, 255 limits’ worth at most (the applet’s own table at 1.12, and its most: ' + table.length + ' cases)', bad.join('; '));

    // with change: what leaves the card is the net; within the limit it waits one limit's worth, and over it as the net says
    const withChange = [
      // the limit, the waits, the change, then the pieces
      [100, 4, 60, 150], [100, 4, 100, 100], [100, 4, 10, 60], [100, 4, 50, 150], [100, 8, 49, 150], [100, 12, 10, 300], [100, 8, 100, 300], [100, 12, 99, 300],
      [100, 8, 1, 102], [100, 4, 1, 100], [100, 4, 1, 1], [1, 4, 1, 1], [1, 4, 2, 3], [1, 8, 1, 3], [1, 1020, 1, 1000], [7, 4, 7, 14], [7, 8, 6, 14],
    ];
    const worse = [];
    for (const [limit, want, made, ...pieces] of withChange) {
      const c = newCard({ software: 12 });
      limits(c, 0, limit);
      fill(c, pieces);
      await tap(c);
      await begin(c, pieces.map((_, i) => i));
      const point = await change(c, made);
      const r = await signed(c);
      if (sw(point) !== '9000' || !r.signature || r.waits !== want) worse.push('pieces ' + pieces + ' less ' + made + ' under ' + limit + ': ' + r.waits + ', not ' + want);
      const said = W.cardWaitSigns12(limit, pieces.reduce((a, b) => a + b, 0) - made, true);
      if (said !== want) worse.push('the wallet says ' + said + ' for pieces ' + pieces + ' less ' + made + ' under ' + limit + ', not ' + want);
    }
    ok(worse.length === 0, 'a card of 1.12: a payment that makes change waits one limit’s worth within the limit, and as its net says over it (' + withChange.length + ' of them), and the wallet’s estimate says the same', worse.join('; '));

    // and a sweep of both against the rule in closed form
    let seed = 20240607;
    const roll = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const off = [];
    for (let k = 0; k < 60; k++) {
      const limit = 1 + roll(400), sum = 1 + roll(limit * (k % 5 === 0 ? 400 : 12)), made = roll(3) === 0 ? 0 : 1 + roll(sum);
      const net = sum - made;
      const units = net > limit ? Math.min(255, Math.ceil(net / limit)) : (made > 0 ? 1 : 0);
      const c = newCard({ software: 12 });
      limits(c, 0, limit);
      fill(c, [sum]);
      await tap(c);
      await begin(c, [0]);
      if (made) await change(c, made);
      const r = await signed(c);
      if (!r.signature || r.waits !== 4 * units) off.push(sum + ' less ' + made + ' under ' + limit + ': ' + r.waits + ', not ' + 4 * units);
      const said = W.cardWaitSigns12(limit, net, made > 0);
      if (said !== 4 * units) off.push('the wallet says ' + said + ' for ' + sum + ' less ' + made + ' under ' + limit + ', not ' + 4 * units);
    }
    ok(off.length === 0, 'a card of 1.12: sixty payments, with change and without, wait as the rule says, and the wallet’s estimate says the same', off.join('; '));

    // every wait is "not yet", 00 01, and says nothing of how many are left
    const c = newCard({ software: 12 });
    limits(c, 0, 10);
    fill(c, [95]);
    await tap(c);
    await begin(c, [0]);
    const all = [];
    for (let k = 0; k < 44; k++) all.push(await sign(c));
    ok(all.slice(0, 40).every((a) => a === '00019000') && sw(all[40]) === '9000' && dat(all[40]).length === 128,
       '95 under 10 is ten limits’ worth, forty waits: each is the same two bytes, whatever is left, and the signature is the answer after the last');
    ok(c.state.slots[0].status === 2 && all.slice(41).every((a) => a === '6985'), 'only then is the piece burned, and a command after it is not another signing');
  }

  /* ---- 9: the card before 1.12 holds the day to the pieces whole, as the payment begins -------------------------- */
  {
    const c = newCard({ software: 11 });
    limits(c, 100, 100);
    fill(c, [150, 50]);
    await tap(c);
    ok(sw(await begin(c, [0])) === '6a8f' && c.state.log.refused === 1, 'a payment of a piece worth more than the day is refused when it begins: 150 whole is over a day of 100');
    ok(sw(await sign(c)) === '6985', 'and the payment is given up');
    limits(c, 1000, 0);
    await begin(c, [0]);
    await output(c, 90, POINT(3));
    const paid = await signed(c);
    ok(!!paid.signature && c.state.spent === 150 && c.state.log.sats === 150 && c.state.receipts.ring[0].sats === 150, 'and what it charges the day, the log and the receipt is the piece whole, 150, with 90 paid');
    const old = [];
    for (const [limit, want, ...pieces] of [[100, 0, 100], [100, 4, 101], [100, 4, 200], [100, 8, 201], [100, 0, 60, 40], [100, 4, 150, 50], [100, 8, 100, 100, 1], [100, 36, 1000], [7, 4, 14], [1, 0, 1], [1, 4, 2]]) {
      const k = newCard({ software: 11 });
      limits(k, 0, limit);
      fill(k, pieces);
      await tap(k);
      await begin(k, pieces.map((_, i) => i));
      const r = await signed(k);
      if (!r.signature || r.waits !== want) old.push('pieces ' + pieces + ' under ' + limit + ': ' + r.waits + ', not ' + want);
      const said = W.cardWaitSignsBefore(limit, pieces.reduce((a, b) => a + b, 0));
      if (said !== want) old.push('the wallet says ' + said + ' for pieces ' + pieces + ' under ' + limit + ', not ' + want);
    }
    ok(old.length === 0, 'and the wait is worked out there too, with the first limit’s worth free: (ceil(S / L) - 1) * 4', old.join('; '));
    // a sum that wraps
    const w = newCard({ software: 11 });
    fill(w, [4294967295, 2]);
    limits(w, 0, 100);
    await tap(w);
    await begin(w, [0, 1]);
    ok((await signed(w)).waits === 1020, 'a sum that wraps waits the most there is');
    // it keeps no openings, and its twin is of its software
    ok(states(w) === 'eeeeeeee' && w.copy().state.openings.length === 8 && (await w.copy().send(SELECT)) === '010b9000', 'it keeps no openings, and a copy of it is the card of 1.11 too');
  }

  /* ---- 10: the beginning that lets drafts go, and the one that does not ---------------------------------------- */
  {
    const c = newCard();
    fill(c, [100, 50]);
    await tap(c);
    await begin(c, [0]);
    await change(c, 10);
    await change(c, 20);
    await c.send('b001000000');
    ok(states(c) === 'ddeeeeee', 'a payment given up leaves its drafts where they are');
    ok(sw(await begin(c, [0, 200])) === '6a83' && states(c) === 'ddeeeeee', 'and a beginning that is refused (a place the card has not) lets none of them go');
    ok(sw(await begin(c, [5])) === '6a88' && states(c) === 'ddeeeeee', 'nor one that names an empty place');
    ok(sw(await begin(c, [0, 0])) === '6a80' && states(c) === 'ddeeeeee', 'nor one that names a place twice');
    limits(c, 1000000000, 0);
    fill(c, [4294967295, 2]);
    ok(sw(await begin(c, [0, 1])) === '6a8f' && states(c) === 'ddeeeeee', 'nor a sum that wraps, under a day’s limit');
    limits(c, 0, 0);
    fill(c, [100, 50]);
    ok(sw(await begin(c, [0])) === '9000' && states(c) === 'eeeeeeee', 'a beginning that goes through lets every draft go');
    await change(c, 1);
    ok(states(c) === 'deeeeeee', 'and the first free place is the lowest: the next change takes the first');
    // the other payment’s pending are left alone
    await change(c, 2);
    await signed(c);
    ok(states(c) === 'ppeeeeee', 'signed for, they are pending');
    await begin(c, [1]);
    await change(c, 3);
    ok(states(c) === 'ppdeeeee', 'a payment after it takes the next free place', states(c));
  }

  /* ---- 11: the hook that replays a recording of the applet --------------------------------------------------------- */
  {
    const c = newCard();
    fill(c, [100]);
    await tap(c);
    const nonce = 'ab'.repeat(32), r = '0123456789abcdef'.repeat(4);
    c.setChange(nonce.toUpperCase(), r);
    await begin(c, [0]);
    ok(sw(await change(c, 0)) === '6a80', 'a change that is refused does not use what it was given');
    await begin(c, [0]);
    const a = await change(c, 10), b = await change(c, 10);
    ok(c.state.openings[0].nonce === nonce && c.state.openings[0].r === r, 'the next change made is made of the nonce and the blinding factor given');
    ok(dat(a) === blindedBy(W.cardSecret(nonce, c.key, 0, REFUND, 4), r), 'so its blinded message is that secret’s', dat(a).slice(0, 12));
    ok(c.state.openings[1].nonce !== nonce && /^[0-9a-f]{64}$/.test(c.state.openings[1].nonce) && c.state.openings[1].r !== r && dat(b) !== dat(a), 'and the one after it is the card’s own again');
    let threw = 0;
    for (const bad of [['ab', r], [nonce, 'cd'], [nonce, '0'.repeat(64)], [nonce, 'f'.repeat(64)], [nonce.slice(2) + 'zz', r]]) { try { c.setChange(bad[0], bad[1]); } catch (e) { threw += 1; } }
    ok(threw === 5, 'a nonce or a factor that is not 32 bytes, or a factor that is zero or not under the curve’s order, is refused by the hook');
  }

  console.log('\n' + (failed ? failed + ' flashcard-change check(s) failed' : 'all flashcard-change checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
