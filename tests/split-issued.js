'use strict';
/* split-issued.js — a share of a bill is ticked by its ecash, not by the mint's word.
 *
 *     node tests/split-issued.js
 *
 * The reconcile used to tick a share the moment the mint said its invoice was
 * ISSUED. ISSUED says somebody claimed it, not that this phone holds the ecash:
 * a claim whose answer was lost, a second device on the same words, or a mint
 * that says so wrongly all read the same, and the collecting screen said that
 * person had paid while the sats were nowhere in the balance. Now ISSUED runs
 * the issued-invoice recovery first, and the share is ticked only once its
 * entry is in the history. */
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
  ctx.mint = () => mint;
  return ctx;
}

const rowsOf = (ctx) => (JSON.parse(ctx.storage.getItem('foxy.split.pending') || 'null') || {}).rows || [];
const logOf = (ctx) => JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]');
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };

async function run() {
  /* ---- 1: the mint says ISSUED and this phone never claimed it ---------- */
  {
    const ctx = page();
    const W = ctx.W;
    await W.connect(MINT, { remember: true });
    await W.claim((await W.invoice(1000, '')).hash);
    const before = await W.balanceSats();
    const inv = await W.invoice(300, '');
    W.splitSave({ ways: 2, total: 600, at: Date.now(), mint: inv.mint,
      rows: [{ hash: inv.hash, bolt11: inv.bolt11, sats: inv.sats, label: 'Split 2 of 2', paid: false }] });
    // somebody else claimed it (a second device on the words, or a mint that says so wrongly)
    ctx.mint().quotes[inv.hash].state = 'ISSUED';
    const n = await W.splitReconcile();
    await settle();
    const after = await W.balanceSats();
    ok(n === 0 && rowsOf(ctx)[0] && rowsOf(ctx)[0].paid === false,
      'a share the mint calls ISSUED with no ecash on this phone is not ticked',
      'marked ' + n + ', row ' + JSON.stringify(rowsOf(ctx).map((r) => !!r.paid)));
    ok(after === before && !logOf(ctx).some((e) => e && e.hash === inv.hash && e.settled),
      'and no money or entry is made up for it', after + ' vs ' + before);
    ok(W.splitPending() !== null, 'the share is still owed');
  }

  /* ---- 2: this phone claimed it and the answer was lost ------------------ */
  {
    const ctx = page();
    const W = ctx.W;
    await W.connect(MINT, { remember: true });
    await W.claim((await W.invoice(1000, '')).hash);
    const before = await W.balanceSats();
    const inv = await W.invoice(300, '');
    W.splitSave({ ways: 2, total: 600, at: Date.now(), mint: inv.mint,
      rows: [{ hash: inv.hash, bolt11: inv.bolt11, sats: inv.sats, label: 'Split 2 of 2', paid: false }] });
    ctx.mint().dropAnswerOf('mint');
    let threw = null;
    await W.claim(inv.hash).catch((e) => { threw = e; });
    await settle();
    const lost = ctx.mint().quotes[inv.hash].state === 'ISSUED'
      && !logOf(ctx).some((e) => e && e.hash === inv.hash && e.settled);
    ok(!!threw && lost, 'the claim reached the mint and its answer was lost (nothing in the history yet)',
      String(threw && threw.message || threw));
    const n = await W.splitReconcile();
    await settle();
    const after = await W.balanceSats();
    const entries = logOf(ctx).filter((e) => e && e.hash === inv.hash && e.settled);
    ok(n === 1 && rowsOf(ctx)[0].paid === true && W.splitRecord().done === true,
      'the reconcile recovers the claim and ticks the share', 'marked ' + n);
    ok(after === before + 300 && entries.length === 1,
      'its sats are in the balance and its entry in the history, once', after + ' vs ' + (before + 300) + ', entries ' + entries.length);
    const n2 = await W.splitReconcile();
    await settle();
    ok(n2 === 0 && (await W.balanceSats()) === after, 'a second reconcile changes nothing');
  }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
