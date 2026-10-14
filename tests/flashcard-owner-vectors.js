'use strict';
/* flashcard-owner-vectors.js — the fake phone's owner key is the one native derives.
 *
 *     node tests/flashcard-owner-vectors.js
 *
 * tests/fixtures/card-owner-vectors.json is worked out by tools/gen-card-owner-vectors.js
 * with Node's own crypto, and FoxyTests/NUT13Tests.swift and SeedActionsTests.swift hold the
 * Swift to it. The tests of the wallet run against a fake native side (tests/harness.js,
 * nativePhone), which does the same derivation and signing in JavaScript. A fake that
 * derived another key would make every card test a test of nothing, so it is held to the
 * same file here: the same key from the same seed and card, the same reduction mod n,
 * signatures the file's public key accepts, and the fake's own accepted by the card model.
 */
const fs = require('fs');
const path = require('path');
const { cardOwnerScalar, p256Public, p256Sign, p256Verify, nativePhone, CARD_LABELS } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'card-owner-vectors.json'), 'utf8'));
const N = BigInt('0x' + V.n);

(async () => {
  ok(V.cases.length >= 3, 'the file has cases to hold the fake to', String(V.cases.length));
  for (const c of V.cases) {
    const seed = Buffer.from(c.seed, 'hex');
    const d = cardOwnerScalar(seed, c.cardKey);
    const name = (c.mnemonic ? c.mnemonic.split(' ').slice(0, 2).join(' ') + '…' : 'a raw seed') + ' / ' + c.cardKey.slice(0, 8);
    ok(d.toString(16).padStart(64, '0') === c.scalar, 'the fake derives the file’s owner key: ' + name);
    ok(p256Public(d) === c.pub, 'and its public key, which is all the page is given', c.pub.slice(0, 12));
    for (const s of c.signatures) {
      const message = Buffer.from(s.message, 'hex');
      ok(Buffer.from('CashuCard/' + s.label).equals(message.subarray(0, 10 + s.label.length)) && CARD_LABELS.includes(s.label),
         'the file’s ' + s.label + ' signature is over “CashuCard/” and the label, a label the fake signs for');
      ok(p256Verify(c.pub, message, s.sig), '… and the fake’s verifier accepts it');
      ok(p256Verify(c.pub, Buffer.concat([message, Buffer.from([0])]), s.sig) === false, '… and not for another message');
      // and the fake signs the same message in a way the file’s key accepts
      ok(p256Verify(c.pub, message, p256Sign(d, message)), '… and what the fake signs for it is accepted too');
    }
  }
  // mod n: a 256-bit value is below 2n, so one subtraction; a hash of exactly n is 0 and gets a counter
  for (const r of V.reductions) {
    const h = BigInt('0x' + r.hash);
    ok((h % N).toString(16).padStart(64, '0') === r.reduced, 'a hash reduces mod n as the file says', r.hash.slice(0, 8) + '…');
  }
  // the fake as the page meets it: the same answers through the bridge, from a phone that holds the file’s seed
  {
    const c = V.cases[0];
    const phone = nativePhone({ words: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
    phone.toSeed = () => Buffer.from(c.seed, 'hex');
    phone.derive = (seed, id, counter) => ({ secret: Buffer.alloc(32), blindingFactor: Buffer.alloc(32) });
    phone.validate = () => true;
    phone.generate = () => 'x';
    const got = await Promise.resolve(phone.answer(null, { action: 'cardOwnerKey', key: c.cardKey }));
    ok(got && !got[1] && JSON.parse(got[0]).pub === c.pub && Object.keys(JSON.parse(got[0])).join() === 'pub', 'cardOwnerKey answers the public key and nothing else', got && (got[1] || got[0].slice(0, 20)));
    const s = c.signatures.filter((x) => x.label === 'set-limit')[0];
    const asked = await Promise.resolve(phone.answer(null, { action: 'cardOwnerSign', key: c.cardKey, label: s.label, nonce: s.nonce, value: s.value }));
    const sig = asked && !asked[1] ? JSON.parse(asked[0]) : {};
    ok(Object.keys(sig).join() === 'sig' && p256Verify(c.pub, Buffer.from(s.message, 'hex'), sig.sig), 'cardOwnerSign answers a signature the file’s key accepts, and nothing else');
    for (const bad of [{ label: 'lock' }, { label: 'tag' }, { label: 'time' }, { label: 'CashuCard/load' }, { label: 'change-pin', value: '313233' }, { label: 'set-limit', value: '00' },
                       { label: 'set-limit', value: '000000000000000000000000' + '00' }, { label: 'set-limit', value: '000000000000000000000000' + '1f' },
                       { label: 'load', value: '00' }, { label: 'reset', value: '00' }, { label: 'set-owner', value: '04' }, { label: 'refresh', value: 'ab'.repeat(79) },
                       { nonce: 'ab' }, { key: '04' + c.cardKey.slice(2) }]) {
      const body = Object.assign({ action: 'cardOwnerSign', key: c.cardKey, label: 'load', nonce: s.nonce, value: '' }, bad);
      const r = await Promise.resolve(phone.answer(null, body));
      ok(r && r[1] === 'bad request' && r[0] === null, 'and refuses what is not one of the seven, or not shaped as that one is: ' + JSON.stringify(bad), r && String(r[1]));
    }
    /* A card's record (set-card), as native takes it (CardOwner.Label.setCard, held to the same shapes in FoxyTests/NUT13Tests.swift):
     * 100 bytes and the mint, and then nothing, or the design a card keeps there, three capital letters or
     * digits, or three zeros for none, after a mint of 77 bytes at the most. A record with no design clears the card's, so the
     * one a card is moved with carries it, and a fake that refused it, or signed more than native does, would say nothing of a phone. */
    {
      const record = (mint, after, timeKey) => '01' + c.cardKey + (timeKey || '00'.repeat(65)) + ('0' + mint.toString(16)).slice(-2) + '6d'.repeat(mint) + after;
      const code = (text) => Buffer.from(text, 'latin1').toString('hex');
      const answer = (value) => Promise.resolve(phone.answer(null, { action: 'cardOwnerSign', key: c.cardKey, label: 'set-card', nonce: s.nonce, value }));
      const signed = [['a design', record(24, code('FX1'))], ['a design of digits', record(24, code('007'))], ['a design after a time key', record(24, code('EL1'), '04' + '33'.repeat(64))],
                      ['three zeros', record(24, '000000')], ['a design after a mint of 1', record(1, code('FX1'))], ['a design after a mint of 77', record(77, code('FX1'))],
                      ['three zeros after a mint of 77', record(77, '000000')]];
      const refused = [['one byte after the mint', record(24, code('F'))], ['two', record(24, code('FX'))], ['four', record(24, code('FX1A'))], ['one zero', record(24, '00')],
                       ['four zeros', record(24, '00000000')], ['lower case', record(24, code('fx1'))], ['three more bytes of mint', record(24, '6d6d6d')],
                       ['a space', record(24, code('FX '))], ['the byte before 0', record(24, code('FX/'))], ['the byte after 9', record(24, code('FX:'))],
                       ['the byte before A', record(24, code('@X1'))], ['the byte after Z', record(24, code('F[1'))], ['a byte past 7f', record(24, '46d831')],
                       ['a zero and two characters', record(24, '005831')], ['two characters and a zero', record(24, '465800')], ['a character between zeros', record(24, '005800')],
                       ['a design after a mint of 78', record(78, code('FX1'))], ['three zeros after a mint of 80', record(80, '000000')], ['a design and no mint', record(0, code('FX1'))],
                       ['a design after a time key that is not one', record(24, code('FX1'), '02' + '33'.repeat(64))], ['a design after zeros but for one byte', record(24, code('FX1'), '00'.repeat(30) + '01' + '00'.repeat(34))]];
      const wrong = [];
      for (const [what, value] of signed) {
        const r = await answer(value);
        const sig = r && !r[1] ? JSON.parse(r[0]).sig : '';
        const message = Buffer.concat([Buffer.from('CashuCard/set-card'), Buffer.from(s.nonce, 'hex'), Buffer.from(value, 'hex')]);
        if (!sig || !p256Verify(c.pub, message, sig)) wrong.push('not signed: ' + what);
      }
      for (const [what, value] of refused) {
        const r = await answer(value);
        if (!(r && r[1] === 'bad request' && r[0] === null)) wrong.push('signed: ' + what);
      }
      ok(wrong.length === 0, 'a card’s record is signed whole with its design after the mint, or three zeros there, and with nothing else after a mint', wrong.join('; '));
    }
  }
  console.log('\n' + (failed ? failed + ' flashcard-owner-vectors check(s) failed' : 'all flashcard-owner-vectors checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
