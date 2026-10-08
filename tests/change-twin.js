'use strict';
/* change-twin.js — a real payment is not written off as change scanned twice.
 *
 *     node tests/change-twin.js
 *
 * History is tidied of one old duplicate: change that came back over the link
 * and was then scanned as well, which left a second row for the same sats.
 * The duplicate was looked for by amount, to within the fee allowance, inside
 * a quarter of an hour of the payment. A real payment taken by code offline
 * that happened to be near the size of change that had just come back was
 * marked failed, "the same change, scanned again", and marked again after
 * every claim put it right, since the tidying runs on every reading of
 * history. It goes by the pieces now, and by nothing else.
 *
 * The real wallet in jsdom against a fake mint (tests/harness.js). */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, rebook } = require('./harness');

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

const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };
const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true,
                                    unprotected: false, transport: 'direct' });
const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true,
                                   unprotected: false, transport: 'direct' });

async function run() {
  const ctx = page();
  const W = ctx.W;
  await W.connect(MINT, { remember: true });
  await W.primeLocks();
  const inv = await W.invoice(2000, '');
  await W.claim(inv.hash);

  /* An earlier tap payment of this phone's whose 28 sats of change came back
   * over the link — exactly the row `sendToken` + `changeSettled` leave:
   * grossSats 128, changeSats 28, changeState 'came back'. Seeded as data so
   * the test needs one phone; the shape is the one the code writes. */
  const nowS = Math.floor(Date.now() / 1000);
  const log = JSON.parse(ctx.window.localStorage.getItem('foxy.cashu.log') || '[]');
  log.push({ at: nowS - 120, mint: MINT, dir: 'out', sats: 100, grossSats: 128,
             changeSats: 28, feeSats: 0, settled: true, state: 'success',
             memo: 'ecash', hash: 'token-earlier-pay', changeState: 'came back' });
  ctx.window.localStorage.setItem('foxy.cashu.log', JSON.stringify(log));
  // (an entry written here by hand moved no money, so the books are taken from this point)
  rebook(ctx);

  // a REAL 28-sat payment, locked to this phone, taken by code while offline
  const ask = W.decodeRequest(W.paymentRequest(28, { purpose: 'receive' })) || {};
  const pay = await W.sendToken(28, { unit: 'sat', lockTo: ask.lockTo });
  offline(W);
  const got = await W.receiveToken(pay.token).then((r) => r, (e) => ({ why: e && e.message }));
  ok(got && got.kept === true, 'a real 28-sat payment is taken by code offline',
    JSON.stringify(got).slice(0, 120));
  const hash = got.hash;

  // the history pass runs, as it does on every history read
  W.repairOwedChange();
  await settle();
  const row = (await W.transactions(50)).filter((t) => t.hash === hash)[0] || {};
  ok(row.state !== 'failed',
    'the real payment is not written off as the earlier payment’s change',
    JSON.stringify({ state: row.state, memo: row.memo }));

  // and after it settles, the next history pass must leave it alone too
  online(W);
  await W.claimUnclaimed();
  await settle();
  const settledRow = (await W.transactions(50)).filter((t) => t.hash === hash)[0] || {};
  ok(settledRow.settled === true && settledRow.state !== 'failed',
    'once claimed it reads settled', JSON.stringify({ s: settledRow.settled, st: settledRow.state }));
  W.repairOwedChange();
  await settle();
  const after = (await W.transactions(50)).filter((t) => t.hash === hash)[0] || {};
  ok(after.state !== 'failed',
    'and the next history pass does not mark the settled payment failed',
    JSON.stringify({ state: after.state, memo: after.memo }));

  /* And the duplicate it exists for is still found, by its pieces: a scan
   * named after the very pieces of change that came back over the link. */
  {
    const store = ctx.window.localStorage;
    const rows = JSON.parse(store.getItem('foxy.cashu.log') || '[]');
    const at = Math.floor(Date.now() / 1000);
    rows.push({ at: at, mint: MINT, dir: 'in', sats: 28, feeSats: 0, settled: true, state: 'success',
                memo: 'ecash', hash: 'req-scan-thesamepieces' });
    rows.push({ at: at, mint: MINT, dir: 'in', sats: 28, feeSats: 0, settled: true, state: 'success',
                memo: 'ecash', hash: 'req-scan-otherpieces' });
    store.setItem('foxy.cashu.log', JSON.stringify(rows));
    store.setItem('foxy.change.seen', JSON.stringify([{ f: 'thesamepieces', at: Date.now() }]));
    W.repairOwedChange();
    const by = {};
    JSON.parse(store.getItem('foxy.cashu.log') || '[]').forEach((e) => { by[e.hash] = e; });
    ok(by['req-scan-thesamepieces'].state === 'failed' && /scanned again/.test(by['req-scan-thesamepieces'].memo || ''),
      'a scan of the very pieces of change that came back is still taken out of the count',
      JSON.stringify({ state: by['req-scan-thesamepieces'].state }));
    ok(by['req-scan-otherpieces'].state === 'success',
      'and a scan of other pieces of the same amount is left alone',
      JSON.stringify({ state: by['req-scan-otherpieces'].state }));
    // two entries were written by hand, and one of them taken out again: the books start over
    rebook(ctx);
  }

  console.log('\n' + (failed ? failed + ' change-twin check(s) failed'
    : 'all change-twin checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
