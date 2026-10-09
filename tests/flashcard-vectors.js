'use strict';
/* flashcard-vectors.js — the wallet builds a card piece's secret as the card does.
 *
 *     node tests/flashcard-vectors.js
 *
 * tests/fixtures/flashcard-vectors.json is written by the applet's own tests
 * under jCardSim: pieces as they were loaded, the secret text of each, and the
 * signature the card gave when it was asked to spend it. The card signs
 * SHA-256 of a text it builds itself from the slot, so a wallet that builds a
 * different text by one character makes pieces the card can never spend.
 */
const fs = require('fs');
const path = require('path');
const { loadReal } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'flashcard-vectors.json'), 'utf8'));
const ctx = loadReal({});
const W = ctx.W, CT = ctx.window.CashuTS;

ok(V.pieces.length >= 5 && V.pieces.some((p) => p.date === 0) && V.pieces.some((p) => p.date === 4294967295),
   'the vectors hold pieces with no date, with one, and with the largest there is', String(V.pieces.length));

for (const p of V.pieces) {
  const mine = W.cardSecret(p.nonce, V.cardKey, p.date, V.refundKey);
  ok(mine === p.secret, 'date ' + p.date + ': the secret is the card’s, byte for byte', mine === p.secret ? '' : mine);
  // the slot as GET_PROOF gave it reads back to the same piece
  const slot = W.cardParse.slot(p.slot);
  ok(slot.state === 'spent' || slot.state === 'unspent', 'date ' + p.date + ': its slot reads', slot.state);
  ok(slot.keyset === p.keyset && slot.amount === p.amount && slot.nonce === p.nonce && slot.C === p.C && slot.date === p.date,
     'date ' + p.date + ': and says what was loaded', JSON.stringify({ amount: slot.amount, date: slot.date }));
  ok(W.cardParse.piece(slot) === p.slot.slice(2), 'date ' + p.date + ': and writes back to the 81 bytes it was loaded from');
  // the library that will take this proof to a mint finds the card's signature good for it
  const proof = Object.assign(W.cardParse.proof(slot, V.cardKey, V.refundKey), { witness: JSON.stringify({ signatures: [p.signature] }) });
  ok(CT.schnorrVerifyMessage(p.signature, proof.secret, V.cardKey) === true,
     'date ' + p.date + ': the card’s signature is good for that secret, as NUT-11 checks one');
  ok(CT.schnorrVerifyMessage(p.signature, proof.secret.replace('"tags":[', '"tags":[["sigflag","SIG_INPUTS"]' + (p.date ? ',' : '')), V.cardKey) === false,
     'date ' + p.date + ': and for no other text, the upstream card\u2019s among them');
  let parsed = null;
  try { parsed = CT.parseP2PKSecret(proof.secret); } catch (e) { parsed = { why: e.message }; }
  ok(parsed && !parsed.why, 'date ' + p.date + ': the library reads the secret as a P2PK one', parsed && parsed.why);
  let spendable = null;
  try { spendable = CT.isP2PKSpendAuthorised(proof); } catch (e) { spendable = 'threw: ' + e.message; }
  /* With no date, or one still ahead, the card's signature opens the piece.
   * Once the date has passed mints differ: NUT-11 as it now reads lets the
   * first key go on spending beside the refund key, and the bundled library
   * follows that, while an older mint takes the refund key only. The wallet
   * leans on neither: it treats a piece near its date as one to renew, and
   * refuses to be paid with it (docs/FOXY-CARD-SPEC.md in https://github.com/getfoxy/card, section 6). So only
   * the case that is the same everywhere is held to here. */
  const past = p.date !== 0 && p.date * 1000 < Date.now();
  if (!past) ok(spendable === true, 'date ' + p.date + ': the library says the card may spend it', String(spendable));
  else ok(typeof spendable === 'boolean', 'date ' + p.date + ': past its date, the library answers (it says ' + spendable + '; mints differ)');
}

/* The library's own pieces. A card is loaded with an ordinary locked send, so
 * the secrets that send makes must be ones the card builds: the text the
 * library writes, rebuilt here from its nonce alone, must be that text. */
for (const [name, opt, date] of [
  ['locked to one key', { pubkey: V.cardKey }, 0],
  ['locked with a date and a refund key', { pubkey: V.cardKey, locktime: 1900000000, refundKeys: [V.refundKey] }, 1900000000],
  ['locked with the largest date', { pubkey: V.cardKey, locktime: 4294967295, refundKeys: [V.refundKey] }, 4294967295],
]) {
  const made = new ctx.window.TextDecoder().decode(CT.OutputData.createSingleP2PKData(opt, 16, '0059534ce0bfa19a').secret);
  let nonce = '';
  try { nonce = JSON.parse(made)[1].nonce; } catch (e) {}
  let mine = '';
  try { mine = W.cardSecret(nonce, V.cardKey, date, V.refundKey); } catch (e) { mine = 'threw: ' + e.message; }
  ok(mine === made, 'a piece the library makes, ' + name + ', is one the card builds', mine === made ? '' : made + ' / ' + mine);
}

// what a wallet must refuse to build
const bad = (name, fn) => { let threw = false; try { fn(); } catch (e) { threw = true; } ok(threw, name); };
bad('a nonce that is not 32 bytes is refused', () => W.cardSecret('00', V.cardKey, 0, ''));
bad('uppercase hex is refused: the card writes lowercase', () => W.cardSecret(V.pieces[0].nonce.toUpperCase(), V.cardKey, 0, ''));
bad('a key that is not a compressed point is refused', () => W.cardSecret(V.pieces[0].nonce, '04' + V.cardKey.slice(2), 0, ''));
bad('a date with no refund key is refused', () => W.cardSecret(V.pieces[0].nonce, V.cardKey, 1900000000, ''));
bad('a date the card cannot hold is refused', () => W.cardSecret(V.pieces[0].nonce, V.cardKey, 4294967296, V.refundKey));
bad('half a date is refused', () => W.cardSecret(V.pieces[0].nonce, V.cardKey, 1.5, V.refundKey));

/* ---- a card that signs once for a payment (format 4) -----------------------
 * tests/fixtures/flashcard-vectors-4.json is the same, written by the applet
 * that signs once for a whole payment. Every piece's secret ends with the
 * SIG_ALL flag, and the signature recorded for each is the card's for a
 * payment of that one piece and no outputs: over the piece's secret and its
 * C, which is the whole of NUT-11's message for such a swap. */
const V4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'flashcard-vectors-4.json'), 'utf8'));
ok(V4.pieces.length >= 5 && V4.pieces.some((p) => p.date === 0) && V4.pieces.some((p) => p.date === 4294967295),
   'format 4: the vectors hold pieces with no date, with one, and with the largest there is', String(V4.pieces.length));
for (const p of V4.pieces) {
  const mine = W.cardSecret(p.nonce, V4.cardKey, p.date, V4.refundKey, 4);
  ok(mine === p.secret, 'format 4, date ' + p.date + ': the secret is the card’s, byte for byte', mine === p.secret ? '' : mine);
  ok(/\["sigflag","SIG_ALL"\]\]\}\]$/.test(p.secret) && W.cardSecret(p.nonce, V4.cardKey, p.date, V4.refundKey) !== p.secret,
     'format 4, date ' + p.date + ': it ends with the flag, and is not the text of the card before it');
  const slot = W.cardParse.slot(p.slot);
  const proof = Object.assign(W.cardParse.proof(slot, V4.cardKey, V4.refundKey, undefined, 4), { witness: JSON.stringify({ signatures: [p.signature] }) });
  // the vector's `message` is what was signed: SHA-256 of the text
  const text = p.secret + p.C;
  ok(proof.secret === p.secret && p.message === require('crypto').createHash('sha256').update(text, 'utf8').digest('hex'),
     'format 4, date ' + p.date + ': what the card signed is the hash of the piece’s secret and its C');
  ok(CT.schnorrVerifyMessage(p.signature, text, V4.cardKey) === true, 'format 4, date ' + p.date + ': the card’s signature is good for that message');
  ok(CT.schnorrVerifyMessage(p.signature, p.secret, V4.cardKey) === false,
     'format 4, date ' + p.date + ': and not for the secret alone, which is what a mint checks a piece without the flag against');
  let all = null;
  try { all = CT.isP2PKSigAll([proof]); } catch (e) { all = 'threw: ' + e.message; }
  ok(all === true, 'format 4, date ' + p.date + ': the library reads it as a piece signed for with the whole swap', String(all));
  const past = p.date !== 0 && p.date * 1000 < Date.now();
  let spendable = null;
  try { spendable = CT.isP2PKSpendAuthorised(proof, undefined, text); } catch (e) { spendable = 'threw: ' + e.message; }
  if (!past) ok(spendable === true, 'format 4, date ' + p.date + ': and says the card may spend it, with that message', String(spendable));
}
for (const [name, opt, date] of [
  ['locked to one key', { pubkey: V4.cardKey, sigFlag: 'SIG_ALL' }, 0],
  ['locked with a date and a refund key', { pubkey: V4.cardKey, locktime: 1900000000, refundKeys: [V4.refundKey], sigFlag: 'SIG_ALL' }, 1900000000],
  ['locked with the largest date', { pubkey: V4.cardKey, locktime: 4294967295, refundKeys: [V4.refundKey], sigFlag: 'SIG_ALL' }, 4294967295],
]) {
  const made = new ctx.window.TextDecoder().decode(CT.OutputData.createSingleP2PKData(opt, 16, '0059534ce0bfa19a').secret);
  let nonce = '';
  try { nonce = JSON.parse(made)[1].nonce; } catch (e) {}
  let mine = '';
  try { mine = W.cardSecret(nonce, V4.cardKey, date, V4.refundKey, 4); } catch (e) { mine = 'threw: ' + e.message; }
  ok(mine === made, 'format 4: a piece the library makes with the flag, ' + name + ', is one the card builds', mine === made ? '' : made + ' / ' + mine);
}

console.log('\n' + (failed ? failed + ' flashcard-vectors check(s) failed' : 'all flashcard-vectors checks pass'));
process.exit(failed ? 1 : 0);
