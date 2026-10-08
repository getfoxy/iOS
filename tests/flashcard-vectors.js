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

console.log('\n' + (failed ? failed + ' flashcard-vectors check(s) failed' : 'all flashcard-vectors checks pass'));
process.exit(failed ? 1 : 0);
