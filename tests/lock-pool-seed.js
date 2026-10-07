'use strict';
/* lock-pool-seed.js — the primed lock keys are this seed's, or none go out.
 *
 *     node tests/lock-pool-seed.js
 *
 * A seed change drops the primed keys; the latch for a refused drop lived in
 * memory, and the pool carried no mark of its seed. One refused write at the
 * drop, then a relaunch, and the old seed's keys went out again: the request
 * was locked to a key the new seed cannot derive, the payment to it was kept,
 * and the claim had nothing to open it with. The pool is put to the phone
 * once a launch before a key from it goes out, and until then requests go out
 * unlocked.
 *
 * The real wallet in jsdom against a fake mint (tests/harness.js). */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const NEW_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

function page(o) {
  const opts = o || {};
  const phone = opts.phone || nativePhone({ words: PHONE_WORDS });
  let mint = opts.mint || null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); if (!mint) mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.mint = mint;
  ctx.phone = phone;
  return ctx;
}

const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };

async function run() {
  // ---- session one: a seed change whose pool drop is refused once -----------
  const a = page();
  await a.W.connect(MINT, { remember: true });
  await a.W.claim((await a.W.invoice(2000, '')).hash);
  await a.W.primeLocks();
  const stalePool = JSON.parse(a.storage.getItem('foxy.req.lockpool') || '[]');
  ok(stalePool.length > 0, 'the pool holds the first seed’s keys', String(stalePool.length));

  // the store refuses exactly one write — the drop — and recovers afterwards
  // (jsdom's Storage is a proxy, so the method is replaced on the prototype)
  const SP = a.window.Storage.prototype;
  const realSet = SP.setItem;
  let refused = 0;
  SP.setItem = function (k, v) {
    if (k === 'foxy.req.lockpool' && String(v) === '[]' && refused === 0) { refused += 1; throw new Error('quota'); }
    return realSet.call(this, k, v);
  };
  a.phone.hooks.enter = () => NEW_WORDS;
  const candidate = await a.W.enterSeedNative();
  await a.W.adoptScan([], { candidate });
  ok(refused === 1, 'the seed changed, and the pool drop was refused once');
  SP.setItem = realSet;

  // in this session the latch holds: no key is handed out
  const guarded = a.W.decodeRequest(a.W.paymentRequest(5, { purpose: 'receive' })) || {};
  ok(!guarded.lockTo, 'this session’s latch keeps the stale keys out of requests',
    JSON.stringify(guarded.lockTo || null));

  // ---- session two: a relaunch over the same storage, same phone (new seed) --
  const kept = dump(a);
  const b = page({ storage: kept, mint: a.mint, phone: a.phone });
  const W = b.W;
  await W.connect(MINT, { remember: true });
  const req = W.decodeRequest(W.paymentRequest(21, { purpose: 'receive' })) || {};
  const staleStill = JSON.parse(b.storage.getItem('foxy.req.lockpool') || '[]')
    .some((r) => r && r.pub === String(req.lockTo || '').toLowerCase());
  ok(!req.lockTo || !stalePool.some((r) => r && r.pub === String(req.lockTo).toLowerCase()),
    'after the relaunch, a request never carries the old seed’s key',
    'lockTo ' + JSON.stringify(req.lockTo || null) + (staleStill ? ' (from the stale pool)' : ''));

  // and the money: a payment made to that request must be claimable
  if (req.lockTo) {
    const pay = await W.sendToken(21, { unit: 'sat', lockTo: req.lockTo });
    const bits = W.tokenInfo(pay.token);
    const body = JSON.stringify({
      id: req.id, mint: MINT, unit: 'sat',
      proofs: bits.proofs.map((pr) => Object.assign(
        { id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
        pr.dleq ? { dleq: pr.dleq } : {})),
    });
    W._requestPaid(body, 'latch-test');
    for (let i = 0; i < 600; i++) await new Promise((r) => setTimeout(r, 0));
    await W.claimUnclaimed();
    const rows = JSON.parse(b.storage.getItem('foxy.req.unclaimed') || '{}');
    ok(Object.keys(rows).length === 0,
      'the payment to it is claimed, not stranded',
      JSON.stringify(Object.keys(rows).map((k) => ({ k, stranded: !!rows[k].stranded }))));
  }

  console.log('\n' + (failed ? failed + ' stale-pool-latch check(s) failed'
    : 'all stale-pool-latch checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
