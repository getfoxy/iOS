'use strict';
/* lock-key-kept.js — the key of a waiting payment is never evicted.
 *
 *     node tests/lock-key-kept.js
 *
 * Lock keys are capped at 500 rows, oldest first, and the eviction spared the
 * rows whose id a waiting payment used. A payment kept from a scan waits under
 * the fingerprint of its pieces, not under the id of the request whose key it
 * is locked to, so its row was not spared; for a row from before, a random
 * key, that was the only copy, and the payment was stranded for good. The
 * eviction spares every row whose key a waiting payment names.
 *
 * The real wallet in jsdom against a fake mint (tests/harness.js). */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

function page() {
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
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}

const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true,
                                    unprotected: false, transport: 'direct' });
const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true,
                                   unprotected: false, transport: 'direct' });
const hex = (b) => Buffer.from(Array.from(b)).toString('hex');

async function run() {
  const ctx = page();
  const W = ctx.W;
  const CT = ctx.window.CashuTS;
  await W.connect(MINT, { remember: true });
  await W.claim((await W.invoice(2000, '')).hash);
  await W.primeLocks();

  /* A legacy lock row: a random private key, the shape wallets kept before
   * keys were derived. The code's own comment: "ROWS FROM BEFORE HOLD REAL
   * MONEY AND MUST WORK FOR EVER." */
  const privBytes = CT.createRandomSecretKey();
  const legacyPriv = hex(privBytes);
  const legacyPub = hex(CT.getPubKeyFromPrivKey(privBytes)).toLowerCase();
  const keys = JSON.parse(ctx.window.localStorage.getItem('foxy.req.lockkeys') || '{}');
  keys['legacy-req'] = { key: legacyPriv, at: Date.now() - 86400000 };
  ctx.window.localStorage.setItem('foxy.req.lockkeys', JSON.stringify(keys));

  // a payment locked to that legacy key arrives by code while offline: kept, waiting
  const pay = await W.sendToken(31, { unit: 'sat', lockTo: legacyPub });
  offline(W);
  const kept = await W.receiveToken(pay.token).then((r) => r, (e) => ({ why: e && e.message }));
  ok(kept && kept.kept === true, 'the payment to the legacy key is kept, waiting',
    JSON.stringify(kept).slice(0, 120));
  online(W);

  // 500 newer requests later, the 501st triggers the eviction
  const fillerPub = hex(CT.getPubKeyFromPrivKey(CT.createRandomSecretKey())).toLowerCase();
  const all = JSON.parse(ctx.window.localStorage.getItem('foxy.req.lockkeys') || '{}');
  for (let k = 0; k < 500; k++) all['filler-' + k] = { i: 5000 + k, pub: fillerPub, at: Date.now() - 1000 + k };
  ctx.window.localStorage.setItem('foxy.req.lockkeys', JSON.stringify(all));
  W.paymentRequest(5, { purpose: 'receive' });

  const after = ctx.window.localStorage.getItem('foxy.req.lockkeys') || '{}';
  ok(after.indexOf(legacyPriv) >= 0,
    'the legacy row survives the eviction: its payment is still waiting',
    'rows now ' + Object.keys(JSON.parse(after)).length);

  // the route returns: the waiting payment must be claimable
  const claimed = await W.claimUnclaimed().then((n) => n, (e) => ({ why: e && e.message }));
  const rows = JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}');
  ok(Object.keys(rows).length === 0,
    'the waiting payment is claimed when the route returns',
    'claimed ' + JSON.stringify(claimed) + '; still waiting: ' + JSON.stringify(Object.keys(rows).map((k) => ({ k, stranded: !!rows[k].stranded }))));

  console.log('\n' + (failed ? failed + ' lockkey-eviction check(s) failed'
    : 'all lockkey-eviction checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
