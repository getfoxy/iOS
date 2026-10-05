'use strict';
/* net-of-fee.js — a payment for a request covers the amount after the mint's fee.
 *
 *     node tests/net-of-fee.js
 *
 * NUT-18: sum(proofs) minus the input fee must cover the amount asked. Foxy
 * compared the gross sum, so at a mint charging per piece a payment could add
 * up to the amount and land short once swapped in (audit finding).
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
function page(feePpk) {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true, feePpk: feePpk }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
const bodyFor = (ask, bits) => JSON.stringify({
  id: ask.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
  proofs: bits.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
    pr.dleq ? { dleq: pr.dleq } : {})),
});

(async () => {
  // a mint charging one sat per piece
  const ctx = page(1000);
  const W = ctx.W;
  W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
  await W.connect(MINT, { remember: true });
  await W.primeLocks();
  const inv = await W.invoice(4000, '');
  await W.claim(inv.hash);

  /* Foxy's own payer adds the fee on top, so a token it makes for 100 holds
   * more than 100. A request for the token's whole gross is what another
   * wallet's exact-sum payment looks like: right on paper, short once swapped. */
  const short = W.tokenInfo((await W.sendToken(100, { unit: 'sat' })).token);
  ok(short.sats >= 100, 'a payment was made in ' + short.proofs.length + ' piece(s), ' + short.sats + ' sats gross');
  const ask = W.decodeRequest(W.paymentRequest(short.sats, { purpose: 'receive' })) || {};
  let no = null;
  try { W.readPayment(bodyFor(ask, short)); } catch (e) { no = e; }
  ok(!!no && /after this mint/.test(String(no && no.message)),
    'it is refused: after the fee it does not cover the amount', String(no && no.message));

  // and one that covers the fee is taken
  const ask100 = W.decodeRequest(W.paymentRequest(100, { purpose: 'receive' })) || {};
  const enough = W.tokenInfo((await W.sendToken(100, { unit: 'sat' })).token);
  let read = null, why = null;
  try { read = W.readPayment(bodyFor(ask100, enough)); } catch (e) { why = e && e.message; }
  ok(!!read && read.asked === 100 && read.sats >= 100 + enough.proofs.length,
    'a payment that covers the fee is read', why || JSON.stringify(read));

  // a mint charging nothing is exactly as before
  const free = page(0);
  free.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
  await free.W.connect(MINT, { remember: true });
  await free.W.primeLocks();
  const inv2 = await free.W.invoice(1000, '');
  await free.W.claim(inv2.hash);
  const ask2 = free.W.decodeRequest(free.W.paymentRequest(100, { purpose: 'receive' })) || {};
  const exact = free.W.tokenInfo((await free.W.sendToken(100, { unit: 'sat' })).token);
  let read2 = null, why2 = null;
  try { read2 = free.W.readPayment(bodyFor(ask2, exact)); } catch (e) { why2 = e && e.message; }
  ok(!!read2 && read2.sats === 100, 'with no fee, an exact payment is read as before', why2 || '');

  console.log('\n' + (failed ? failed + ' net-of-fee check(s) failed' : 'all net-of-fee checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(2); });
