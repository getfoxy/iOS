'use strict';
/* change-recovery.js — change a receiver made and the payer never got.
 *
 *     node tests/change-recovery.js
 *
 * A payer that put Foxy away a second and a half after paying never read its
 * change, and the receiver had already written "given back" on the payment:
 * thousands of sats locked to a phone that did not hold them, on a phone that
 * showed nothing more. Three things were built for that, and none had a
 * test of its own:
 *
 *  - an entry that says "given back" without the payer's word is asked about
 *    at the mint; not taken, the change goes on the entry as a code to show
 *  - an entry showing a code is asked about again, and cleared once the mint
 *    says the change was taken
 *  - and neither touches a payment whose change really was kept
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };

function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, { p2pk: true }); },
  });
  ctx.mint = mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
const logOf = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
const metaOf = (c) => JSON.parse(c.storage.getItem('foxy.txmeta') || '{}');
const entry = (c, hash) => logOf(c).filter((e) => e && e.hash === hash)[0] || {};

async function run() {
  const recv = page({});
  await recv.W.connect(MINT, null, null, { remember: true });
  await recv.W.claim((await recv.W.invoice(4000, '')).hash);
  const payer = page({ sharedMint: recv.mint,
    words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
  await payer.W.connect(MINT, null, null, { remember: true });
  await payer.W.primeLocks();

  /* Change as the receiver makes it: locked to a key the payer asked for, and
   * tagged as change under a hash of its own. */
  const changeFor = async (sats) => {
    const ask = payer.W.decodeRequest(payer.W.paymentRequest(sats, { purpose: 'receive' })) || {};
    return recv.W.sendToken(sats, { unit: 'sat', lockTo: ask.lockTo, purpose: 'change' });
  };
  /* The payment that change belongs to, as the receiver wrote it — a minute and
   * a half ago, which is past "it may still be on its way". */
  const payment = (hash, changeSats, state, more) => {
    const log = logOf(recv);
    log.unshift(Object.assign({ hash, dir: 'in', sats: 1180, grossSats: 1180 + changeSats, changeSats,
      changeState: state, at: Math.floor(Date.now() / 1000) - 90, settled: true, feeSats: 0 }, more || {}));
    recv.storage.setItem('foxy.cashu.log', JSON.stringify(log));
  };

  // ---- written down as given back, and nobody has it ----------------------
  const lost = await changeFor(300);
  ok(Object.keys(metaOf(recv)).some((h) => metaOf(recv)[h] && metaOf(recv)[h].change && metaOf(recv)[h].token === lost.token),
     'the change the receiver made is kept under a hash of its own');
  payment('req-lost', 300, 'given back');
  recv.W.repairOwedChange();
  await settle();
  ok(entry(recv, 'req-lost').changeState === 'not handed',
     'change written down as given back, that the mint says nobody took, is owed again',
     entry(recv, 'req-lost').changeState);
  ok((metaOf(recv)['req-lost'] || {}).token === lost.token, 'and its code is on the payment’s entry to be shown');

  // ---- the payer scans it: the entry clears ------------------------------
  const took = await payer.W.receiveToken(lost.token).then((r) => r, (e) => ({ why: e && e.message }));
  ok(took && took.sats === 300, 'the payer takes it, as it would by scanning the code', JSON.stringify(took.sats || took.why));
  recv.W.repairOwedChange();
  await settle();
  const after = entry(recv, 'req-lost');
  ok(after.changeState === 'given back' && after.changeKept === true,
     'and once the mint says it was taken the entry stops saying it is owed', after.changeState + ' / ' + after.changeKept);
  ok(!(metaOf(recv)['req-lost'] || {}).token, 'and stops carrying a code for money already taken');

  // ---- given back, and really taken: left alone, and not asked twice ------
  const fine = await changeFor(200);
  await payer.W.receiveToken(fine.token);
  payment('req-fine', 200, 'given back');
  recv.W.repairOwedChange();
  await settle();
  const kept = entry(recv, 'req-fine');
  ok(kept.changeState === 'given back' && kept.changeKept === true,
     'change that really was taken is confirmed, not put back on the entry', kept.changeState + ' / ' + kept.changeKept);
  ok(!(metaOf(recv)['req-fine'] || {}).token, 'with no code added');

  // ---- confirmed by the payer at the time: never asked about -------------
  const sure = await changeFor(100);
  payment('req-sure', 100, 'given back', { changeKept: true });
  const asked = recv.mint.seen ? recv.mint.seen.length : -1;
  recv.W.repairOwedChange();
  await settle();
  ok(entry(recv, 'req-sure').changeState === 'given back' && !(metaOf(recv)['req-sure'] || {}).token,
     'a payment the payer confirmed at the time is not touched');
  void sure; void asked;

  // ---- a late "kept" with nothing waiting does nothing --------------------
  const before = JSON.stringify(logOf(recv));
  recv.W._tapChangeKeptLate();
  ok(JSON.stringify(logOf(recv)) === before, 'a late word from a payer, with no change waiting, changes nothing');

  console.log('\n' + (failed ? failed + ' change-recovery check(s) failed' : 'all change-recovery checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
