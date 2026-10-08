'use strict';
/* split-doors.js — a bill settled by any of its three doors stays in step.
 *
 *     node tests/split-doors.js
 *
 * A share of a split bill can arrive by the onion, over the tap or by a code.
 * Whichever door it comes by, the ledger, the screen's source, the balance and
 * the log agree, and a second reconcile changes nothing. */
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

const rowsOf = (ctx) => (JSON.parse(ctx.storage.getItem('foxy.split.pending') || 'null') || {}).rows || [];
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };

async function run() {
  const ctx = page();
  const W = ctx.W;
  await W.connect(MINT, { remember: true });
  await W.claim((await W.invoice(1000, '')).hash);
  const before = await W.balanceSats();

  // a four-way bill: three shares owed, as spMakeInvoices writes it down
  const invs = [];
  for (let i = 0; i < 3; i++) invs.push(await W.invoice(100 + i * 50, ''));
  W.splitSave({
    ways: 4, total: 45000, at: Date.now(), mint: invs[0].mint,
    rows: invs.map((inv, k) => ({ hash: inv.hash, bolt11: inv.bolt11, sats: inv.sats,
                                  label: 'Split ' + (k + 2) + ' of 4', paid: false })),
  });

  // door one, a tap payment: the app marks the row by its hash (12-receive.js:403)
  W.splitMarkPaid(invs[2].hash);
  ok(rowsOf(ctx).filter((r) => r.paid).length === 1, 'the tap-paid share is marked in the ledger');

  // door two, a scanned token for exactly the share (17-split-bill-and-copy.js:371)
  const token = await W.sendToken(150, { unit: 'sat' });
  const got = await W.receiveToken(token.token);
  ok(got && got.sats === 150, 'the scanned share’s token is taken (' + (got && got.sats) + ')');
  W.splitMarkPaid(invs[1].hash);
  ok(rowsOf(ctx).filter((r) => r.paid).length === 2, 'the scanned share is marked too');

  // door three, the invoice: the reconcile finds it paid at the mint and claims it
  const n = await W.splitReconcile();
  await settle();
  const record = JSON.parse(ctx.storage.getItem('foxy.split.pending') || 'null') || {};
  ok(n >= 1 && (record.rows || []).every((r) => r.paid) && record.done === true,
    'the reconcile claims the invoice share and the record reads done',
    'marked ' + n + ', rows ' + JSON.stringify((record.rows || []).map((r) => !!r.paid)));
  ok(W.splitPending() === null, 'nothing is still owed');

  // the money: the funding, plus the invoice share; the scan churned 150 through
  const balance = await W.balanceSats();
  ok(balance === before + 100, 'the sats add up: funding + the 100-sat invoice share',
    balance + ' vs ' + (before + 100));

  // one entry per settled share's claim, and a second reconcile claims nothing
  const log = JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]');
  const claims = log.filter((e) => e && e.hash === invs[0].hash);
  ok(claims.length === 1 && claims[0].settled === true, 'the claimed share has one settled entry');
  const n2 = await W.splitReconcile();
  await settle();
  const balance2 = await W.balanceSats();
  const claims2 = (JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]'))
    .filter((e) => e && e.hash === invs[0].hash);
  ok(n2 === 0 && balance2 === balance && claims2.length === 1,
    'a second reconcile marks nothing, claims nothing, writes nothing',
    'marked ' + n2 + ', balance ' + balance2 + ', entries ' + claims2.length);

  console.log('\n' + (failed ? failed + ' split-doors check(s) failed — a regression'
    : 'all split-doors checks pass — the three doors stay in step'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
