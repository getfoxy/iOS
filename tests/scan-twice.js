'use strict';
/* scan-twice.js — plain ecash taken on trust is taken once.
 *
 *     node tests/scan-twice.js
 *
 * An offline phone shown plain ecash at its own mint asks the person (HIGH
 * RISK: whoever gave it can still spend it), and on a yes keeps it to swap in
 * when there is a connection. That branch knew a repeat only while the ecash
 * was still waiting. Once it had settled, the same token shown again was put
 * to the person again and counted again; and on the next connection it was
 * found spent, by this phone's own earlier claim, which was read as the payer
 * having spent it: both entries were written "taken back" and the person was
 * told the payer had taken money that was sitting in their pile.
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

const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };
const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true,
                                    unprotected: false, transport: 'direct' });
const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true,
                                   unprotected: false, transport: 'direct' });

async function run() {
  const ctx = page();
  const W = ctx.W;
  await W.connect(MINT, { remember: true });
  const inv = await W.invoice(2000, '');
  await W.claim(inv.hash);

  const plain = await W.sendToken(29, { unit: 'sat' });

  // the person says yes to the risk card, both times they are asked
  const asked = [];
  W.onOfflineOffer((info) => { asked.push(info); return Promise.resolve(true); });
  const lost = [];
  W._onTrustLost = (e) => lost.push(e);

  // ---- taken on trust, offline, then settled on the next connect -------------
  offline(W);
  const before = await W.balanceSats();
  const first = await W.receiveToken(plain.token).then((r) => r, (e) => ({ why: e && e.message }));
  ok(first && first.kept === true && first.trusted === true,
    'the plain token is taken on trust once', JSON.stringify(first).slice(0, 140));
  ok(asked.length === 1, 'the person was asked once');
  online(W);
  await W.claimUnclaimed();
  await settle();
  const afterClaim = await W.balanceSats();
  ok(afterClaim === before + 29, 'it settles into the pile', afterClaim + ' vs ' + (before + 29));
  const hash = first.hash;
  const entry1 = (await W.transactions(50)).filter((t) => t.hash === hash);
  ok(entry1.length === 1 && entry1[0].settled && entry1[0].state !== 'failed',
    'its one entry is settled', JSON.stringify(entry1.map((t) => ({ s: t.settled, st: t.state }))));

  // ---- the same token, scanned again offline ---------------------------------
  offline(W);
  const again = await W.receiveToken(plain.token).then((r) => r, (e) => ({ why: e && e.message }));
  ok(!again.kept && /already been paid|already/i.test(String(again.why)),
    'the same token scanned again is refused: this phone was already paid it',
    JSON.stringify(again).slice(0, 160));
  ok(asked.length === 1, 'and the person is not asked to trust it a second time',
    'asked ' + asked.length + ' time(s)');
  const afterRescan = await W.balanceSats();
  ok(afterRescan === afterClaim, 'and nothing is counted twice',
    afterRescan + ' vs ' + afterClaim);

  // ---- the aftermath: the next connect must not call the real payment stolen --
  online(W);
  await W.claimUnclaimed();
  await settle();
  ok(lost.length === 0,
    'nobody is told the payer took their money back', JSON.stringify(lost));
  const entries = (await W.transactions(50)).filter((t) => t.hash === hash);
  ok(entries.length === 1 && entries.every((t) => t.state !== 'failed'),
    'the settled entry still says the payment arrived',
    JSON.stringify(entries.map((t) => ({ s: t.settled, st: t.state, memo: t.memo }))));
  const balanceNow = await W.balanceSats();
  ok(balanceNow === before + 29, 'and the balance is the one payment',
    balanceNow + ' vs ' + (before + 29));

  console.log('\n' + (failed ? failed + ' scan-twice check(s) failed'
    : 'all scan-twice checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
