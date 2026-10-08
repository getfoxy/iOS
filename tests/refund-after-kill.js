'use strict';
/* refund-after-kill.js — a refusal's refund survives the app being killed.
 *
 *     node tests/refund-after-kill.js
 *
 * A refused payment is refunded by a swap at the mint. Foxy killed with that
 * swap at the mint comes back to its record and finishes it: exactly one
 * refund, however many times the relaunch runs. */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, noBooks } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const hex = (b) => Buffer.from(Array.from(b)).toString('hex');

function page(state, o) {
  const opts = o || {};
  /* A page opened over what another wrote gets that page's phone as it was
   * after the kill: a fresh phone with the same keychain and counter file
   * (reusing the object itself carries the old page's realm into cashu-ts). */
  const phone = nativePhone({ words: PHONE_WORDS });
  if (opts.phone) { phone.counters = opts.phone.counters; phone.locks = opts.phone.locks; }
  let mint = opts.mint || null;
  const answer = (w, id, text, err) => setTimeout(() => { if (!state.dead) w.FoxyWallet._scanResult(id, text, err); }, 0);
  const ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (state.dead) return null;
      if (m.action === 'mintRequest') {
        const path = String(m.url || '');
        if (state.armed && path.indexOf('/v1/swap') >= 0) {
          state.swaps += 1;
          if (state.swaps === state.killOnSwap) {
            mint.handle(m);                 // the mint makes the refund's swap
            state.acted = true;
            state.dead = true;              // and the app dies with the answer
            return null;
          }
        }
        return answer(w, m.id, mint.handle(m));
      }
      if (m.action === 'inboxAnswer') { state.answers.push({ status: Number(m.status) }); return answer(w, m.id, 'ok'); }
      const got = phone.answer(w, m);
      if (!got) return answer(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => answer(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); if (!mint) mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.mint = mint;
  ctx.phone = phone;
  return ctx;
}

const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };

async function run() {
  const state = { armed: false, swaps: 0, killOnSwap: 2, dead: false, acted: false, answers: [] };
  const a = page(state);
  // killed with a swap at the mint, on purpose: its books are the next page's to finish
  noBooks(a);
  await a.W.connect(MINT, { remember: true });
  await a.W.claim((await a.W.invoice(500, '')).hash);
  const before = await a.W.balanceSats();

  // the payer's side of the story: a token, and a key for anything coming back
  const payerKey = a.window.CashuTS.createRandomSecretKey();
  const payerPub = hex(a.window.CashuTS.getPubKeyFromPrivKey(payerKey)).toLowerCase();
  const pay = await a.W.sendToken(37, { unit: 'sat' });
  const bits = a.W.tokenInfo(pay.token);
  const afterMake = await a.W.balanceSats();

  /* The payment arrives over the tap for a request that is not open: refused,
   * taken in (swap one), and sent back locked to the payer (swap two) — the
   * app dies with swap two at the mint. */
  state.armed = true;
  a.W._requestPaid(JSON.stringify({
    id: 'nonesuch', mint: MINT, unit: 'sat', changeTo: payerPub,
    proofs: bits.proofs.map((pr) => Object.assign(
      { id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),
  }), 'refund-kill', 'tap');
  for (let i = 0; i < 1200 && !state.dead; i++) await new Promise((r) => setTimeout(r, 5));
  ok(state.dead && state.acted, 'killed with the refund’s swap made at the mint',
    'swaps seen ' + state.swaps);
  ok(state.answers.some((x) => x.status === 422), 'the payer had been told 422 first');

  // ---- the relaunch ---------------------------------------------------------
  const b = page({ armed: false, swaps: 0, dead: false, answers: [] },
                 { storage: dump(a), mint: a.mint, phone: a.phone });
  // carries on from the killed page's storage, so its own start is mid-swap
  noBooks(b);
  const W = b.W;
  await W.connect(MINT, { remember: true });
  await W.recoverSwaps();
  await W.carryResume();
  await settle();

  const meta = JSON.parse(b.storage.getItem('foxy.txmeta') || '{}');
  const refunds = Object.keys(meta).filter((h) => meta[h] && meta[h].changeToken);
  ok(refunds.length === 1, 'exactly one refund token exists, on the payment’s entry',
    JSON.stringify(refunds));
  const tok = refunds.length ? W.tokenInfo(meta[refunds[0]].changeToken) : null;
  const lockedRight = !!tok && tok.proofs.every((pr) => String(pr.secret || '').indexOf(payerPub.slice(2)) >= 0
    || String(pr.secret || '').indexOf(payerPub) >= 0);
  ok(lockedRight, 'and it is locked to the payer’s key', tok ? String(tok.sats) + ' sats' : 'none');
  ok(((JSON.parse(b.storage.getItem('foxy.cashu.carry') || 'null') || []).length) === 0,
    'the refusal job is finished', b.storage.getItem('foxy.cashu.carry') || '[]');
  ok(((JSON.parse(b.storage.getItem('foxy.cashu.swaps') || 'null') || []).length) === 0,
    'no swap record is left behind');

  /* The books: the receiver took the payment in (+37) and refunded the whole
   * of it locked to the payer (−37, less nothing at a free mint), so it holds
   * what it held before the payment was made — the 37 went to the payer. */
  const balance = await W.balanceSats();
  ok(Math.abs(balance - afterMake) <= 2,
    'the receiver keeps nothing of the refused payment',
    balance + ' vs ' + afterMake + ' (started ' + before + ')');

  // ---- a second resume makes no second refund -------------------------------
  await W.recoverSwaps();
  await W.carryResume();
  await settle();
  const meta2 = JSON.parse(b.storage.getItem('foxy.txmeta') || '{}');
  const refunds2 = Object.keys(meta2).filter((h) => meta2[h] && meta2[h].changeToken);
  const balance2 = await W.balanceSats();
  ok(refunds2.length === 1 && balance2 === balance,
    'a second resume refunds nothing more',
    refunds2.length + ' refund(s), balance ' + balance2 + ' vs ' + balance);

  console.log('\n' + (failed ? failed + ' refusal-refund-kill check(s) failed — a guard has regressed'
    : 'all refusal-refund-kill checks pass — the kill/resume path holds'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
