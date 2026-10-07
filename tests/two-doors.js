'use strict';
/* two-doors.js — one payment cannot come in by two doors.
 *
 *     node tests/two-doors.js
 *
 * A locked payment can reach a phone as a code that is scanned or over the tap
 * link. The scan door checks the ecash against what the phone already holds,
 * against the request's lock having been taken, and against history. The tap
 * door checked none of them, and a scan leaves its request open. So ecash
 * scanned by an offline phone and then sent again over the link was kept a
 * second time: PAYMENT RECEIVED was raised twice, the balance counted it
 * twice, and after the next connection history held two settled entries for
 * one payment, with the books out by it for good.
 *
 * A payer has only to skip its own asking first to do that on purpose, and a
 * payer whose tap stalled, who showed the code, and whose phone then delivered
 * over the link does it by accident.
 *
 * The real wallet in jsdom against a fake mint (tests/harness.js). The phone
 * here is both payer and receiver, which is enough: the token is locked to its
 * own request. */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const answers = [];
function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      if (m.action === 'inboxAnswer') {
        answers.push({ answer: m.answer, status: Number(m.status), text: String(m.text || '') });
        return reply(w, m.id, 'ok');
      }
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
  ok((await W.primeLocks()) > 0, 'lock keys are primed');
  const inv = await W.invoice(2000, '');
  await W.claim(inv.hash);

  // the request, and the payment the payer made for it while it had a route
  const ask = W.decodeRequest(W.paymentRequest(47, { purpose: 'receive' })) || {};
  ok(!!ask.lockTo, 'the request asks for a lock');
  const pay = await W.sendToken(47, { unit: 'sat', lockTo: ask.lockTo });
  const bits = W.tokenInfo(pay.token);
  const body = JSON.stringify({
    id: ask.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
    proofs: bits.proofs.map((pr) => Object.assign(
      { id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),
  });

  // and other ecash for the same request, made while there was still a route
  const pay2 = await W.sendToken(47, { unit: 'sat', lockTo: ask.lockTo });
  const bits2 = W.tokenInfo(pay2.token);
  const body2 = JSON.stringify({
    id: ask.id, mint: String(bits2.mint || '').replace(/\/+$/, ''), unit: 'sat',
    proofs: bits2.proofs.map((pr) => Object.assign(
      { id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),
  });

  // ---- door one: the token is scanned, offline --------------------------------
  offline(W);
  const before = await W.balanceSats();
  const scanned = await W.receiveToken(pay.token).then((r) => r, (e) => ({ why: e && e.message }));
  ok(scanned && scanned.kept === true, 'the scan keeps it', JSON.stringify(scanned).slice(0, 120));
  const afterScan = await W.balanceSats();
  ok(afterScan === before + 47, 'and it is counted once', afterScan + ' vs ' + (before + 47));

  // ---- door two: the SAME token arrives over the tap for the same request ----
  const mark = answers.length;
  const paidStages = [];
  W.onRequestPaid((e) => paidStages.push(e.stage));
  W._requestPaid(body, 'inbox-replay', 'tap');
  await settle();
  const said = answers.slice(mark);

  /* 409, not 422: this phone has those very pieces, so "not taken, your sats
   * are still yours" would be false. The payer reads 409 as not yet confirmed
   * and watches its token. */
  ok(said.length === 1 && said[0].status === 409 && /already has that ecash/.test(said[0].text),
    'the same ecash over the tap is turned away: this phone already holds it',
    JSON.stringify(said));
  ok(paidStages.indexOf('paid') < 0,
    'and PAYMENT RECEIVED is not raised a second time', paidStages.join(', '));
  const afterTap = await W.balanceSats();
  ok(afterTap === afterScan,
    'and the balance does not count the same payment twice', afterTap + ' vs ' + afterScan);
  const rows = JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}');
  ok(Object.keys(rows).length === 1,
    'one waiting row holds the ecash, not two', JSON.stringify(Object.keys(rows)));

  // ---- and different ecash for the request the scan already paid ---------------
  const mark2 = answers.length;
  W._requestPaid(body2, 'inbox-second', 'tap');
  await settle();
  const said2 = answers.slice(mark2);
  ok(said2.length === 1 && said2[0].status === 422 && /already been paid/.test(said2[0].text),
    'other ecash for a request the scan already paid is refused outright: the payer keeps it',
    JSON.stringify(said2));
  ok((await W.balanceSats()) === afterScan && Object.keys(JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}')).length === 1,
    'and nothing of it is kept or counted');

  // ---- the aftermath: the route returns and the books are judged --------------
  online(W);
  await W.claimUnclaimed();
  await settle();
  const log = await W.transactions(50);
  const settledIn = log.filter((t) => t.dir === 'in' && t.settled && t.sats === 47
    && t.state !== 'failed');
  ok(settledIn.length === 1,
    'history holds ONE settled 47-sat receive after the claim',
    settledIn.map((t) => t.hash).join(', '));
  const balanceNow = await W.balanceSats();
  ok(balanceNow === before + 47,
    'and the balance is the one payment', balanceNow + ' vs ' + (before + 47));

  console.log('\n' + (failed ? failed + ' two-door check(s) failed'
    : 'all two-door checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
