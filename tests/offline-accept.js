'use strict';
/* offline-accept.js — with no route, only ecash locked to this phone is taken.
 *
 *     node tests/offline-accept.js
 *
 * Unlocked ecash is a race: anyone holding a copy can spend it, and the only
 * thing that settles it is this phone's own swap. Offline there is no swap, so
 * taking it would mean showing somebody money that may already be gone, with no
 * way to find out until the phone has a route again.
 *
 * Locked ecash is the opposite. The payer had to swap at the mint to make it, so
 * it was final before it arrived; only this phone can ever spend it; and its
 * DLEQ verifies against the cached keyset without asking anyone anything.
 *
 * Which is also what decides who may pay whom. A lock cannot be made without a
 * swap, so "locked" is proof the other phone had a route. A phone that takes
 * only locked ecash while offline therefore cannot be paid by another offline
 * phone — and nothing about that is self-reported. There is no flag to set and
 * nothing to lie about, which is why this is the rule rather than a claim of
 * connectivity carried in the payment.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

/* The answers this phone gives a payer are what the test is about, so the
 * bridge records every one of them. */
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
  ok((await W.primeLocks()) > 0, 'the phone derived lock keys for the requests to come');
  const inv = await W.invoice(2000, '');
  await W.claim(inv.hash);

  /* Two requests and two payments, both made while there is still a route —
   * a locked payment cannot be made without one. */
  const askLocked = W.decodeRequest(W.paymentRequest(31, { purpose: 'receive' })) || {};
  const askBare = W.decodeRequest(W.paymentRequest(37, { purpose: 'receive' })) || {};
  ok(!!askLocked.lockTo, 'the first request asked for a lock');

  const lockedPay = await W.sendToken(31, { unit: 'sat', lockTo: askLocked.lockTo });
  const barePay = await W.sendToken(37, { unit: 'sat' });
  const lockedBits = W.tokenInfo(lockedPay.token);
  const bareBits = W.tokenInfo(barePay.token);
  ok(lockedBits.proofs.every((pr) => pr.secret.charAt(0) === '['), 'the first payment is really locked');
  ok(bareBits.proofs.every((pr) => pr.secret.charAt(0) !== '['), 'the second payment is really unlocked');

  const bodyFor = (ask, bits) => JSON.stringify({
    id: ask.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
    // with the mint's DLEQ, as payRequest sends it: it is what makes locked ecash final
    proofs: bits.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),
  });

  // ---- offline, unlocked: refused, and nothing written ----------------------
  offline(W);
  const before = await W.balanceSats();
  const mark = answers.length;
  W._requestPaid(bodyFor(askBare, bareBits), 'inbox-bare-offline');
  await settle();

  const said = answers.slice(mark);
  ok(said.length === 1 && said[0].status === 422,
    'an unlocked payment arriving with no route is refused',
    JSON.stringify(said));
  ok(said.length === 1 && /offline/i.test(said[0].text),
    'and the payer is told why, so they know to try again', said[0] && said[0].text);
  ok((await W.balanceSats()) === before, 'the balance did not move',
    String(await W.balanceSats()) + ' vs ' + before);
  const unclaimed = JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}');
  ok(!unclaimed[askBare.id], 'nothing was written down, so there is nothing to clean up later',
    JSON.stringify(Object.keys(unclaimed)));

  // ---- offline, locked: taken gladly ---------------------------------------
  const mark2 = answers.length;
  W._requestPaid(bodyFor(askLocked, lockedBits), 'inbox-locked-offline');
  await settle();
  const said2 = answers.slice(mark2);
  ok(said2.length >= 1 && said2[0].status === 200,
    'ecash locked to this phone is taken even with no route',
    JSON.stringify(said2));
  const unclaimed2 = JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}');
  ok(!!unclaimed2[askLocked.id],
    'and it is written down, waiting for a route to swap it in',
    JSON.stringify(Object.keys(unclaimed2)));

  // ---- online, unlocked: taken as it always was ----------------------------
  online(W);
  const askBare2 = W.decodeRequest(W.paymentRequest(11, { purpose: 'receive' })) || {};
  const barePay2 = await W.sendToken(11, { unit: 'sat' });
  const bareBits2 = W.tokenInfo(barePay2.token);
  const mark3 = answers.length;
  W._requestPaid(bodyFor(askBare2, bareBits2), 'inbox-bare-online');
  await settle();
  const said3 = answers.slice(mark3);
  ok(said3.length >= 1 && said3[0].status === 200,
    'with a route, an unlocked payment is taken exactly as before',
    JSON.stringify(said3));

  /* ---- a token handed over face to face, not delivered --------------------
   *
   * When a tap's delivery fails the payer shows the token instead and the
   * receiver scans it. That goes through `receiveToken`, which asserted the
   * route before it looked at anything — so a token locked to this very phone,
   * which needs no mint to be safe, was refused with COULD NOT REACH THE MINT.
   * Same rule as the delivered path now:
   * locked is kept, anything else is refused in words that say why. */
  {
    offline(W);
    const lockedAsk = W.decodeRequest(W.paymentRequest(41, { purpose: 'receive' })) || {};
    online(W);
    const forUs = await W.sendToken(41, { unit: 'sat', lockTo: lockedAsk.lockTo });
    const loose = await W.sendToken(43, { unit: 'sat' });
    offline(W);

    const before = await W.balanceSats();
    const kept = await W.receiveToken(forUs.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(!!kept && kept.kept === true,
      'a token locked to this phone is taken while offline', JSON.stringify(kept));
    ok((await W.balanceSats()) === before + 41,
      'and counted, because it is already this phone\u2019s money',
      String(await W.balanceSats()) + ' vs ' + (before + 41));
    const rows = JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}');
    const mine = Object.keys(rows).filter((k) => /^scan-/.test(k));
    ok(mine.length === 1, 'written down once, for the next connect to swap in',
      JSON.stringify(Object.keys(rows)));
    ok(!rows[mine[0]].trusted,
      'and not marked trusted: a lock needs nobody\u2019s trust',
      JSON.stringify(rows[mine[0]]));

    const refused = await W.receiveToken(loose.token).then(() => null, (e) => e && e.message);
    ok(!!refused && /offline/i.test(refused) && /locked to it/i.test(refused),
      'an unlocked token is refused, and says why rather than blaming the mint', String(refused));
    ok((await W.balanceSats()) === before + 41, 'and nothing else was counted');
  }

  /* ---- ecash nobody signed (audit N1) --------------------------
   *
   * A lock says who may spend a proof, not that it is money. Anybody who has
   * seen a request knows the key it asks for, and can write secrets locked to
   * it beside any point at all. The lock was the whole test, so 5,000 sats no
   * mint had signed were answered 200, shown as paid and counted. Now a locked
   * payment is final only when every piece carries a DLEQ that verifies. */
  {
    const crypto = require('crypto');
    const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    const keyset = lockedBits.proofs[0].id;
    const lockedSecret = (to) => JSON.stringify(['P2PK',
      { nonce: crypto.randomBytes(32).toString('hex'), data: to }]);
    const forged = (ask, extra) => JSON.stringify({
      id: ask.id, mint: MINT, unit: 'sat',
      proofs: [4096, 512, 256, 128, 8].map((a) => Object.assign(
        { id: keyset, amount: a, C: G, secret: lockedSecret(ask.lockTo) }, extra || {})),
    });
    const stagesOf = async (body, name) => {
      const stages = [];
      const stop = W.onRequestPaid((e) => stages.push(e.stage));
      const from = answers.length;
      W._requestPaid(body, name);
      await settle();
      if (typeof stop === 'function') stop();
      return { stages, said: answers.slice(from) };
    };
    const unclaimedNow = () => JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}');

    // offline, no DLEQ at all
    online(W);
    const ask1 = W.decodeRequest(W.paymentRequest(5000, { purpose: 'receive' })) || {};
    offline(W);
    const had = await W.balanceSats();
    const r1 = await stagesOf(forged(ask1), 'forged-offline');
    ok(r1.said.length === 1 && r1.said[0].status === 422,
      'offline, ecash locked to this phone that no mint signed is refused', JSON.stringify(r1.said));
    ok(r1.stages.indexOf('paid') < 0, 'and nobody is shown a payment', r1.stages.join(', '));
    ok((await W.balanceSats()) === had, 'and the balance did not move',
      String(await W.balanceSats()) + ' vs ' + had);
    ok(!unclaimedNow()[ask1.id], 'and nothing was written down');

    // offline, with a DLEQ copied off a real proof: present, and wrong
    const r2 = await stagesOf(forged(ask1, { dleq: lockedBits.proofs[0].dleq }), 'forged-dleq-offline');
    ok(!!lockedBits.proofs[0].dleq, 'the mint\u2019s ecash carries a DLEQ to copy');
    ok(r2.said.length === 1 && r2.said[0].status === 422 && /signatures/i.test(r2.said[0].text),
      'a DLEQ that does not verify is refused, and says so', JSON.stringify(r2.said));
    ok(r2.stages.indexOf('paid') < 0 && (await W.balanceSats()) === had,
      'with nothing shown and nothing counted', r2.stages.join(', '));

    // online: the mint is the judge, and nothing is announced before it has spoken
    online(W);
    const ask3 = W.decodeRequest(W.paymentRequest(5000, { purpose: 'receive' })) || {};
    const r3 = await stagesOf(forged(ask3), 'forged-online');
    ok(r3.stages.indexOf('paid') < 0, 'with a route, forged ecash is not announced as paid',
      r3.stages.join(', '));
    ok(!r3.said.some((a) => a.status === 200), 'and its payer is not answered 200', JSON.stringify(r3.said));
    ok((await W.balanceSats()) === had, 'and the balance did not move',
      String(await W.balanceSats()) + ' vs ' + had);

    // and the same ecash shown as a code, scanned with no route
    offline(W);
    const token = ctx.window.CashuTS.getEncodedToken({ mint: MINT, unit: 'sat',
      proofs: [64, 32].map((a) => ({ id: keyset, amount: a, C: G, secret: lockedSecret(ask1.lockTo) })) });
    const scanned = await W.receiveToken(token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(!!scanned && !scanned.kept && /signatures/i.test(String(scanned.why)),
      'a forged token scanned offline is refused', JSON.stringify(scanned));
    ok((await W.balanceSats()) === had, 'and not counted',
      String(await W.balanceSats()) + ' vs ' + had);
    online(W);
  }

  /* ---- plain ecash with a signature that is wrong, scanned with no route ----
   *
   * Where a person can be asked to take plain ecash on trust, they are asked
   * only about ecash that might be good. A piece from this mint whose DLEQ is
   * there and does not verify was never made by it, so nobody is put the
   * question: it is refused first, in words about the signatures. The same
   * token with its own signatures is the control, so the refusal is shown to
   * be about them. */
  {
    online(W);
    const plain = await W.sendToken(9, { unit: 'sat' });
    const real = W.tokenInfo(plain.token);
    const wrongDleq = lockedBits.proofs[0].dleq;
    const tokenOf = (proofs) => ctx.window.CashuTS.getEncodedToken({
      mint: String(real.mint || '').replace(/\/+$/, ''), unit: 'sat', proofs: proofs });
    const damaged = tokenOf(real.proofs.map((pr) => Object.assign({}, pr, { dleq: wrongDleq })));
    ok(real.proofs.every((pr) => !!pr.dleq) && !!wrongDleq,
      'the plain token carries the mint\u2019s signatures, and there is a wrong one to put in their place');

    const asked = [];
    W.onOfflineOffer((info) => { asked.push(info); return Promise.resolve(true); });
    offline(W);
    const had = await W.balanceSats();
    const rowsBefore = Object.keys(JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}')).length;
    const bad = await W.receiveToken(damaged).then((r) => r, (e) => ({ why: e && e.message }));
    ok(!!bad && !bad.kept && /signatures do not match/i.test(String(bad.why)),
      'plain ecash whose signatures do not verify is refused, and says so', JSON.stringify(bad).slice(0, 160));
    ok(asked.length === 0, 'and the person is not asked to take it on trust', JSON.stringify(asked));
    ok((await W.balanceSats()) === had
        && Object.keys(JSON.parse(ctx.window.localStorage.getItem('foxy.req.unclaimed') || '{}')).length === rowsBefore,
      'and nothing is counted or written down', String(await W.balanceSats()) + ' vs ' + had);

    W.onOfflineOffer((info) => { asked.push(info); return Promise.resolve(false); });
    const good = await W.receiveToken(plain.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(asked.length === 1 && asked[0].scanned === true && asked[0].sats === 9,
      'the same token with its own signatures does put the question', JSON.stringify(asked));
    ok(!!good && !good.kept && /not taken/i.test(String(good.why)), 'and a no takes nothing',
      JSON.stringify(good).slice(0, 120));
    W.onOfflineOffer(null);
    online(W);
  }

  /* ---- a payment already claimed, shown again with no route ----------------
   *
   * Offline, a lock this phone's words derive was the whole test, and that
   * includes the key of every request it has ever been paid. A customer paid
   * by tap, the merchant claimed it, and later — the merchant offline — the
   * same token shown as a code read PAYMENT RECEIVED for ecash already spent
   * (tools/live/offline-cross-scenarios.js `replay-claimed`).
   * Offline, the lock must answer a request that is still open here. */
  {
    online(W);
    const ask = W.decodeRequest(W.paymentRequest(53, { purpose: 'receive' })) || {};
    const pay = await W.sendToken(53, { unit: 'sat', lockTo: ask.lockTo });
    const mark = answers.length;
    W._requestPaid(bodyFor(ask, W.tokenInfo(pay.token)), 'inbox-replay');
    await settle();
    ok(answers.slice(mark).some((a) => a.status === 200), 'a locked payment is taken and claimed with a route');
    const rowsNow = JSON.parse(ctx.window.localStorage.getItem('foxy.req.lockkeys') || '{}');
    ok(!rowsNow[ask.id], 'and its request’s lock is struck off once it is claimed', JSON.stringify(Object.keys(rowsNow).length));
    const had = await W.balanceSats();
    offline(W);
    const again = await W.receiveToken(pay.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(!again.kept && /no open request|already been paid/i.test(String(again.why)),
      'shown again as a code with no route, it is refused: it answers no request still open here', JSON.stringify(again).slice(0, 160));
    ok((await W.balanceSats()) === had, 'and nothing is counted', String(await W.balanceSats()) + ' vs ' + had);

    // one request, two tokens locked to it, both shown offline: the first is the payment
    online(W);
    const ask2 = W.decodeRequest(W.paymentRequest(61, { purpose: 'receive' })) || {};
    const one = await W.sendToken(61, { unit: 'sat', lockTo: ask2.lockTo });
    const two = await W.sendToken(61, { unit: 'sat', lockTo: ask2.lockTo });
    offline(W);
    const had2 = await W.balanceSats();
    const first = await W.receiveToken(one.token).then((r) => r, (e) => ({ why: e && e.message }));
    const second = await W.receiveToken(two.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(first.kept === true && !second.kept && /already been paid/i.test(String(second.why)),
      'a second token to a request already paid offline is refused, in words', JSON.stringify(second).slice(0, 140));
    ok((await W.balanceSats()) === had2 + 61, 'and only the first is counted', String(await W.balanceSats()) + ' vs ' + (had2 + 61));
    online(W);
  }

  console.log('\n' + (failed ? failed + ' offline-accept check(s) failed'
    : 'all offline-accept checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
