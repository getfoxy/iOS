'use strict';
/* flashcard-model.js — the model of the card answers as the card does.
 *
 *     node tests/flashcard-model.js
 *
 * tests/fixtures/flashcard-transcript.json is a conversation the applet had
 * under jCardSim: every command it was sent and what it answered. It is the
 * card that signs once for a payment (format 4), has 128 places, burns a
 * payment of any number of pieces and takes its PIN sealed (1.9). The others
 * are the same of the cards before it: -18 (no sealed PIN), -17 (its pieces
 * burned inside the payment's transaction), -16 (sixty-four places), and -3,
 * which signs for each piece (format 3). The model is held to all five. The model in
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
const read = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const ctx = loadReal({});
const W = ctx.W, CT = ctx.window.CashuTS;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

async function replay(T, format, places, software) {
  const card = makeCard({ window: ctx.window, format, places, software });
  let exact = 0, verified = 0;
  // a payment being put to a one-signature card: its places and its outputs, as the commands gave them
  let pay = null;
  // what the model last gave for sealing a PIN: the recording's sixteen bytes (the model is given them) and the model's own PIN key
  let sealKey = null;
  for (const e of T) {
    // the card taken out of the field and put back: nothing is sent, and the model is tapped anew
    if (e.kind === 'reset') { card.tap(); pay = null; sealKey = null; continue; }
    const ins = e.apdu.substr(2, 2);
    /* A sealed command is sealed again here, by the WALLET's own sealing, to the model's PIN key: the recording's
     * envelope was for the applet's key, which is another card's. What was sealed is in the entry (`clear`), with how
     * it was spoiled on its way, if it was, and the instruction it was sealed for where that was not its own. */
    let apdu = e.apdu;
    if (e.kind === 'sealed') {
      ok(!!sealKey, e.name + ': a PIN key was asked for before it');
      let env = sealKey ? W.cardParse.seal(sealKey, e.for || ins, e.clear) : '';
      if (e.spoil === 'tag') env = env.slice(0, -2) + ('0' + (parseInt(env.slice(-2), 16) ^ 1).toString(16)).slice(-2);
      else if (e.spoil === 'body') env = env.slice(0, 130) + ('0' + (parseInt(env.substr(130, 2), 16) ^ 1).toString(16)).slice(-2) + env.slice(132);
      else if (e.spoil === 'point') env = '04' + '00'.repeat(64) + env.slice(130);
      else ok(!e.spoil, e.name + ': a way of spoiling this test knows', e.spoil);
      apdu = e.apdu.substr(0, 8) + ('0' + (env.length / 2).toString(16)).slice(-2) + env;
      ok(apdu.length === e.apdu.length || apdu.length + 2 === e.apdu.length, e.name + ': an envelope of the recording’s length', apdu.length / 2 + ' bytes, the recording ' + e.apdu.length / 2);
    }
    const got = await card.send(apdu);
    const sw = got.slice(-4), data = got.slice(0, -4);
    ok(sw === e.sw, e.name + ': the status word', 'the card ' + e.sw + ', the model ' + sw);
    if (sw !== e.sw) continue;
    if (format === 4 && e.apdu.slice(0, 2) === 'b0') {
      const lc = parseInt(e.apdu.substr(8, 2), 16) || 0, body = e.apdu.substr(10, lc * 2);
      if (ins === '22') pay = sw === '9000' ? { slots: (body.match(/../g) || []).map((h) => parseInt(h, 16)), outs: '' } : null;
      else if (ins === '23') { if (pay && sw === '9000') { for (let at = 0; at < body.length; at += 74) pay.outs += String(parseInt(body.substr(at, 8), 16)) + body.substr(at + 8, 66); } else pay = null; }
      else if (ins !== '24') pay = null;
    }
    if (e.kind === 'exact' || e.kind === 'sealed') {
      ok(data === e.data, e.name + ': the answer', 'the card ' + e.data.slice(0, 60) + ', the model ' + data.slice(0, 60));
      exact += 1;
    } else if (e.kind === 'pinkey') {
      /* Sixteen bytes, the key a PIN is sealed to, and the card key's signature over that key. The key is the model's
       * own, and is held to what the recording's is: a compressed point that is not the key the card signs with, signed
       * by that one. The sixteen bytes the model is given are the recording's, as for an owner's proof. */
      const key = data.substr(32, 66), sig = data.substr(98, 128);
      ok(data.length === 226 && e.data.length === 226 && /^0[23]/.test(key) && key !== card.key, e.name + ': sixteen bytes, a key that is not the card’s signing key, and a signature');
      let good = false;
      try { good = CT.schnorrVerifyDigest(sig, ctx.window.Uint8Array.from(sha256(Buffer.concat([Buffer.from('FoxyCard/pinkey'), Buffer.from(key, 'hex')]))), card.key) === true; } catch (x) { good = false; }
      ok(good, e.name + ': the card’s own key has signed the PIN key');
      card.setNonce(e.data.substr(0, 32));
      sealKey = { nonce: e.data.substr(0, 32), pub: key };
      verified += 1;
    } else if (e.kind === 'nonce') {
      // sixteen bytes the card made up. The recording's own are the ones its proofs after this were made from
      ok(data.length === 32 && /^[0-9a-f]+$/.test(data) && /^[0-9a-f]{32}$/.test(e.data), e.name + ': sixteen bytes');
      card.setNonce(e.data);
      verified += 1;
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
    } else if (e.kind === 'sigall') {
      /* One signature for the whole payment. The message is built here from
       * what the commands said and the WALLET's text for each place's secret,
       * so it is the wallet's reading of the card that the signature is held to. */
      ok(!!pay, e.name + ': a payment was begun');
      const text = (pay ? pay.slots : []).map((i) => {
        const s = W.cardParse.slot('02' + card.state.slots[i].data);
        return W.cardSecret(s.nonce, card.key, s.date, card.state.record.refund, 4) + s.C;
      }).join('') + (pay ? pay.outs : '');
      ok(data.length === 128 && CT.schnorrVerifyMessage(data, text, card.key) === true, e.name + ': one signature over every piece and every output');
      ok(card.state.lastText === text, e.name + ': the message is the one the wallet builds');
      ok((pay ? pay.slots : []).every((i) => card.state.slots[i].status === 2), e.name + ': and every piece is burned');
      pay = null;
      verified += 1;
    } else if (e.kind === 'receipt') {
      /* A page of receipts: the count, then for each when, what the pieces were worth, the hash of what was signed and
       * the first output. All of it is the recording's to the byte but the hash, which is over the card's own key. */
      ok(data.length === e.data.length && data.slice(0, 8) === e.data.slice(0, 8), e.name + ': the count of payments, and as many receipts', data.slice(0, 8) + ' / ' + e.data.slice(0, 8));
      for (let at = 8; at + 146 <= data.length; at += 146) {
        ok(data.substr(at, 16) === e.data.substr(at, 16) && data.substr(at + 80, 66) === e.data.substr(at + 80, 66), e.name + ': a receipt\u2019s clock, worth and first output');
        ok(/^[0-9a-f]{64}$/.test(data.substr(at + 16, 64)) && data.substr(at + 16, 64) !== '0'.repeat(64), e.name + ': and a hash');
      }
      // the newest is of the payment the model last signed: the hash of that very message
      if (data.length > 8 && card.state.lastText) {
        const newest = card.state.receipts.ring[(card.state.receipts.count - 1) & 15];
        ok(newest.hash === sha256(Buffer.from(card.state.lastText, 'utf8')).toString('hex'), e.name + ': the newest receipt is the hash of the message last signed');
      }
      verified += 1;
    } else if (e.kind === 'again') {
      ok(data === card.state.lastSig, e.name + ': the last signature, again');
      verified += 1;
    } else if (e.kind === 'auth') {
      const reader = Buffer.from(e.apdu.slice(10, 42), 'hex');
      const tag = sha256(Buffer.from('FoxyCard/auth'));
      const digest = sha256(Buffer.concat([tag, tag, reader, Buffer.from(data.slice(0, 32), 'hex'), Buffer.from(card.key, 'hex')]));
      ok(data.length === 160 && CT.schnorrVerifyDigest(data.slice(32), ctx.window.Uint8Array.from(digest), card.key) === true, e.name + ': a signature over both nonces and the key');
      verified += 1;
    } else {
      ok(false, e.name + ': a kind of answer this test knows', e.kind);
    }
  }
  ok(T.length >= 100 && exact >= 90 && verified >= 12, 'the transcript is the whole conversation', T.length + ' exchanges, ' + exact + ' exact, ' + verified + ' verified');
  return { n: T.length, exact, verified };
}

(async () => {
  const now = await replay(read('flashcard-transcript.json'), 4);
  // the cards before it: 1.8 (no sealed PIN), 1.7 (its pieces burned inside the payment's transaction), and 1.6 (sixty-four places)
  const plain = await replay(read('flashcard-transcript-18.json'), 4, undefined, 8);
  const wide = await replay(read('flashcard-transcript-17.json'), 4, undefined, 7);
  const narrow = await replay(read('flashcard-transcript-16.json'), 4, 64);
  const before = await replay(read('flashcard-transcript-3.json'), 3);
  const all = [now, plain, wide, narrow, before];
  const T = { length: all.reduce((n, r) => n + r.n, 0) }, exact = all.reduce((n, r) => n + r.exact, 0), verified = all.reduce((n, r) => n + r.verified, 0);

  // the model's own extras
  const c2 = makeCard({ window: ctx.window });
  await c2.send('00a4040009f0464f58594341524400');
  c2.leaveAfter(1);
  await c2.send('b001000000');
  const left = await c2.send('b001000000').then(() => 'answered', () => 'gone');
  ok(left === 'gone', 'a card that has left answers nothing');
  c2.tap();
  ok((await c2.send('b001000000')).slice(-4) === '6999', 'and back in the field it must be selected again');

  /* What the page sends and what the phone carries are one list. The phone's
   * gate (Foxy/Flashcard/CardGate.swift) lets through the instructions it
   * names and no others, and nothing but a phone and a card shows what it
   * stops: the card's own log, and then every payment with a card that signs
   * once, were built and tested here against the model while the phone was
   * refusing to send them. */
  {
    const page = fs.readFileSync(path.join(__dirname, '..', 'build', 'wallet', '08a-flashcard.js'), 'utf8');
    const table = (/var CARD_INS = \{([\s\S]*?)\};/.exec(page) || [])[1] || '';
    const sends = Array.from(new Set((table.match(/'[0-9a-f]{2}'/g) || []).map((x) => x.slice(1, 3)))).sort();
    const gate = fs.readFileSync(path.join(__dirname, '..', 'Foxy', 'Flashcard', 'CardGate.swift'), 'utf8');
    const set = (/static let instructions: Set<UInt8> = \[([\s\S]*?)\n    \]/.exec(gate) || [])[1] || '';
    const carries = Array.from(new Set((set.replace(/\/\/.*$/gm, '').match(/0x[0-9A-Fa-f]{2}/g) || []).map((x) => x.slice(2).toLowerCase()))).sort();
    ok(sends.length >= 20, 'the page’s own table of instructions is read', String(sends.length));
    ok(sends.filter((x) => carries.indexOf(x) < 0).length === 0, 'the phone carries every instruction the page sends', 'not carried: ' + sends.filter((x) => carries.indexOf(x) < 0).join(' '));
    ok(carries.filter((x) => sends.indexOf(x) < 0).length === 0, 'and none the page does not', 'carried and never sent: ' + carries.filter((x) => sends.indexOf(x) < 0).join(' '));
  }

  console.log(failed ? failed + ' flashcard-model check(s) failed'
    : 'the model answers all ' + T.length + ' commands as the card did (' + exact + ' to the byte, ' + verified + ' signatures verified)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
