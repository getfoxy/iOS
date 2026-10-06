'use strict';
/* flashcard-model.js — the model of the card answers as the card does.
 *
 *     node tests/flashcard-model.js
 *
 * tests/fixtures/flashcard-transcript.json is a conversation the applet had
 * under jCardSim: every command it was sent and what it answered. The model in
 * tests/flashcard-card.js is what the wallet's tests pay with, so a rule the
 * model gets wrong is a rule those tests prove nothing about. Each command is
 * sent to the model again and its answer compared: to the byte, except where
 * the answer is a key or a signature, which is another card's to differ in
 * and is verified instead.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadReal } = require('./harness');
const { makeCard } = require('./flashcard-card');

let failed = 0;
const ok = (good, name, detail) => {
  if (!good) { console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); failed += 1; }
};
const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'flashcard-transcript.json'), 'utf8'));
const ctx = loadReal({});
const W = ctx.W, CT = ctx.window.CashuTS;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

(async () => {
  const card = makeCard({ window: ctx.window });
  let exact = 0, verified = 0;
  for (const e of T) {
    const got = await card.send(e.apdu);
    const sw = got.slice(-4), data = got.slice(0, -4);
    ok(sw === e.sw, e.name + ': the status word', 'the card ' + e.sw + ', the model ' + sw);
    if (sw !== e.sw) continue;
    if (e.kind === 'exact') {
      ok(data === e.data, e.name + ': the answer', 'the card ' + e.data.slice(0, 60) + ', the model ' + data.slice(0, 60));
      exact += 1;
    } else if (e.kind === 'key') {
      ok(data.length === 66 && /^0[23]/.test(data) && data === card.key, e.name + ': a compressed key');
    } else if (e.kind === 'sig') {
      const slot = parseInt(e.apdu.substr(4, 2), 16);
      ok(data.length === 128 && CT.schnorrVerifyMessage(data, card.secretOf(slot), card.key) === true,
         e.name + ': a signature good for that slot’s secret');
      // and the secret the model signed is the one the wallet builds for the slot
      const s = W.cardParse.slot('02' + card.state.slots[slot].data);
      ok(W.cardSecret(s.nonce, card.key, s.date, card.state.record.refund) === card.secretOf(slot), e.name + ': the wallet’s secret for it');
      verified += 1;
    } else if (e.kind === 'auth') {
      const reader = Buffer.from(e.apdu.slice(10, 42), 'hex');
      const tag = sha256(Buffer.from('FoxyCard/auth'));
      const digest = sha256(Buffer.concat([tag, tag, reader, Buffer.from(data.slice(0, 32), 'hex'), Buffer.from(card.key, 'hex')]));
      ok(data.length === 160 && CT.schnorrVerifyDigest(data.slice(32), ctx.window.Uint8Array.from(digest), card.key) === true, e.name + ': a signature over both nonces and the key');
      verified += 1;
    }
  }
  ok(T.length >= 60 && exact >= 55 && verified >= 6, 'the transcript is the whole conversation', T.length + ' exchanges, ' + exact + ' exact, ' + verified + ' verified');

  // the model's own extras
  const c2 = makeCard({ window: ctx.window });
  await c2.send('00a4040009f0464f58594341524400');
  c2.leaveAfter(1);
  await c2.send('b001000000');
  const left = await c2.send('b001000000').then(() => 'answered', () => 'gone');
  ok(left === 'gone', 'a card that has left answers nothing');
  c2.tap();
  ok((await c2.send('b001000000')).slice(-4) === '6999', 'and back in the field it must be selected again');

  console.log(failed ? failed + ' flashcard-model check(s) failed'
    : 'the model answers all ' + T.length + ' commands as the card did (' + exact + ' to the byte, ' + verified + ' signatures verified)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
