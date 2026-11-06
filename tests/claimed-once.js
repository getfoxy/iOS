'use strict';
/* claimed-once.js — a payment swapped in is counted once, whatever the store does.
 *
 *     node tests/claimed-once.js
 *
 * A payment kept with no route waits on the unclaimed list and is counted in
 * the balance from there. Once a route comes back it is swapped into the pile
 * and its row is struck off the list. That strike-off is a write the store can
 * refuse (a full store), and the money is in the pile by then, so the refusal
 * is only logged. The row stayed on the list and the balance was the pile plus
 * the row: the same payment twice, until some later write happened to land.
 * Here the store refuses the strike-off, and the balance must still be what
 * the phone holds; once the store has room the row goes on the next pass, and
 * nothing about it is labelled taken back. */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

function page(o) {
  const opts = o || {};
  const store = opts.storage || null;
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  let mint = opts.mint || null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); if (!mint) mint = fakeMint(w, { p2pk: true }); },
    storage: store || undefined,
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.mint = mint;
  return ctx;
}

const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };
const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
const rowsOf = (c) => JSON.parse(c.window.localStorage.getItem('foxy.req.unclaimed') || '{}');

async function run() {
  const rx = page();
  const W = rx.W;
  await W.connect(MINT, { remember: true });
  await W.primeLocks();
  await W.claim((await W.invoice(500, '')).hash);
  const payer = page({ mint: rx.mint, words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
  await payer.W.connect(MINT, { remember: true });
  await payer.W.claim((await payer.W.invoice(900, '')).hash);

  const ask = W.decodeRequest(W.paymentRequest(120, { purpose: 'receive' })) || {};
  const pay = await payer.W.sendToken(120, { unit: 'sat', lockTo: ask.lockTo });
  offline(W);
  W._requestPaid(JSON.stringify({ id: ask.id, mint: MINT, unit: 'sat', proofs: W.tokenInfo(pay.token).proofs }), 'inbox-1');
  await settle();
  const kept = await W.balanceSats();
  ok(!!rowsOf(rx)[ask.id] && kept === 500 + 120, 'with no route the locked payment is kept and counted', String(kept));

  // the store refuses every write of the unclaimed list that would strike the row off
  const proto = rx.window.Storage.prototype;
  const set = proto.setItem;
  let refusals = 0;
  proto.setItem = function (k, v) {
    if (String(k) === 'foxy.req.unclaimed' && String(v).indexOf(ask.id) < 0) {
      refusals += 1;
      throw new rx.window.DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    return set.call(this, k, v);
  };
  online(W);
  await W.claimUnclaimed();
  await settle();
  const pile = W.balanceIn(MINT, 'sat');
  const shown = await W.balanceSats();
  ok(refusals > 0 && !!rowsOf(rx)[ask.id], 'the strike-off was refused and the row is still on disk', refusals + ' refusal(s)');
  ok(pile === 500 + 120, 'the payment is in the pile', String(pile));
  ok(shown === pile && W.unclaimedSats() === 0, 'and the balance counts it once, not as the pile and the row both',
     'balance ' + shown + ', pile ' + pile + ', unclaimed ' + W.unclaimedSats());

  /* A relaunch with the row still on disk: what was swapped in is known only to the page that swapped it, so the
   * next page has to tell from the disk alone that the row is already in the pile. Offline, so no claim pass runs. */
  {
    const disk = {};
    const st = rx.window.localStorage;
    for (let i = 0; i < st.length; i++) disk[st.key(i)] = st.getItem(st.key(i));
    const again = page({ mint: rx.mint, storage: disk });
    offline(again.W);
    await again.W.connect(MINT, { remember: true }).catch(() => {});
    await settle();
    const pile2 = again.W.balanceIn(MINT, 'sat');
    const shown2 = await again.W.balanceSats();
    ok(pile2 === 620 && shown2 === 620, 'after a relaunch the balance still counts it once',
       'balance ' + shown2 + ', pile ' + pile2 + ', unclaimed ' + again.W.unclaimedSats());
  }

  // room again: the next pass lets the row go, and labels nothing taken back
  proto.setItem = set;
  await W.claimUnclaimed();
  await settle();
  const log = JSON.parse(rx.window.localStorage.getItem('foxy.cashu.log') || '[]');
  ok(!rowsOf(rx)[ask.id] && (await W.balanceSats()) === 500 + 120, 'once a write lands the row is gone and the balance is the same',
     String(await W.balanceSats()));
  ok(!log.some((e) => e && /taken back/.test(String(e.memo || ''))), 'and nothing is labelled taken back by the payer');

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
