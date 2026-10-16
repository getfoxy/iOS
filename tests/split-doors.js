'use strict';
/* split-doors.js — a bill settled by any of its doors stays in step.
 *
 *     node tests/split-doors.js
 *
 * A share of a split bill can arrive by the onion, over the tap or by a code,
 * and a card held to the till pays one too (the fourth door, below).
 * Whichever door it comes by, the ledger, the screen's source, the balance and
 * the log agree, and a second reconcile changes nothing. */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
const { funded, newCard, binaryLoad, OTHER_WORDS } = require('./flashcard-kit');

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

  /* door four, a card (26f-flashcard.js): the card's payment is an entry of its own, which the app notes on the share's row as soon
   * as it has a name (`splitNoteCard`), and the reconcile ticks the row when that entry has settled and not before: at once, late
   * (the mint's answer lost, and found by the wallet's own settling), or, for a payment taken on trust, once it has been swapped.
   * Counted once, whichever way the row was marked. */
  {
    const holder = await funded({}, 4000);
    const till = await funded({ sharedMint: holder.mint, words: OTHER_WORDS }, 1000);
    const w = till.W;
    const offline = () => w._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    const online = () => w._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    const bill = async (n) => {
      const made = [];
      for (let i = 0; i < n; i++) made.push(await w.invoice(150 + i * 50, ''));
      w.splitClear();
      w.splitSave({
        ways: n + 1, total: 60000, at: Date.now(), mint: made[0].mint,
        rows: made.map((inv, k) => ({ hash: inv.hash, bolt11: inv.bolt11, sats: inv.sats, label: 'Split ' + (k + 2) + ' of ' + (n + 1), paid: false })),
      });
      return made;
    };
    // the quotes the test mint is to call unpaid (it calls every quote it makes paid), and whether its swaps are to go unanswered
    const unpaid = {};
    let holdSwaps = false;
    till.fate = (m) => {
      const url = String(m.url || '');
      const quote = /\/v1\/mint\/quote\/bolt11\/([0-9a-f]{32})$/.exec(url);
      if (quote && unpaid[quote[1]]) return String(holder.mint.handle(m)).replace('"state":"PAID"', '"state":"UNPAID"');
      return holdSwaps && /\/v1\/swap$/.test(url) ? '0\n' : null;
    };
    // as the app does: the payment's entry is noted on its share's row as soon as it has a name
    const noting = (share) => (step, info) => { if (info && info.hash && (step === 'checking' || step === 'mint')) w.splitNoteCard(share.hash, info.hash); };
    const owed = () => (JSON.parse(till.storage.getItem('foxy.split.pending') || 'null') || {}).rows || [];
    const log = () => JSON.parse(till.storage.getItem('foxy.cashu.log') || '[]');
    // `o.format`: 4 for a card that signs once and keeps the mint's proofs (1.20), the one that can pay with no route
    const cardWith = async (sats, o) => {
      const k = newCard(holder, undefined, o && o.format ? { format: o.format } : undefined);
      await holder.W.cardSetUp(k, { pin: '1234' });
      await binaryLoad(holder, k, sats);
      return k;
    };

    // three shares of a four-way bill, none of them paid at the mint
    const shares = await bill(3);
    shares.forEach((x) => { unpaid[x.hash] = true; });
    const before = await w.balanceSats();

    // paid at once: the entry is the card's own and not the invoice's, and the app, seeing it paid, ticks the row by hand
    const first = await cardWith(1024);
    first.tap();
    const paidFirst = await w.cardPay(first, { sats: shares[0].sats, pin: '1234', on: noting(shares[0]) });
    await settle();
    ok(paidFirst && paidFirst.sats === 150 && (await w.balanceSats()) === before + 150 && owed()[0].card === paidFirst.hash && paidFirst.hash !== shares[0].hash,
      'the card pays the first share: the till is up by exactly the share, and the row names the entry that paid it');
    w.splitMarkPaid(shares[0].hash);
    const entry = log().filter((e) => e && e.hash === paidFirst.hash);
    ok(owed()[0].paid === true && owed()[1].paid === false && entry.length === 1 && entry[0].settled === true && entry[0].memo === 'card' && w.tagsFor(paidFirst.hash).to === 'card payment',
      'the app ticks it by hand; the payment has one settled entry, named as a card payment’s', JSON.stringify(owed().map((r) => !!r.paid)));
    ok((await w.splitReconcile()) === 0, 'and a reconcile after that marks nothing: a row ticked by hand and by its entry is counted once');
    ok(w.splitNoteCard(shares[0].hash, 'card-after-the-fact') === null && w.splitNoteCard('no-such-row', 'card-x') === null && owed()[0].card === paidFirst.hash,
      'a row that is ticked is not noted over, and a row the bill does not have is not noted at all');

    // paid late: the card has signed and the mint has not answered, so the share is not ticked, and is when the payment lands
    const second = await cardWith(1024);
    holdSwaps = true;
    second.tap();
    const lost = await w.cardPay(second, { sats: shares[1].sats, pin: '1234', on: noting(shares[1]) }).then(() => null, (e) => e);
    ok(lost && lost.card === 'waiting' && owed()[1].card === lost.id && owed()[1].paid === false,
      'the mint has not answered: the row names the entry that is to pay it, and is not ticked', lost && lost.card);
    ok((await w.splitReconcile()) === 0 && owed()[1].paid === false, 'and a reconcile ticks nothing while that entry has not settled');
    holdSwaps = false;
    await w.cardSettle();
    await settle();
    const landed = await w.balanceSats();
    ok(landed === before + 150 + 200 && (await w.splitReconcile()) === 1 && owed()[1].paid === true && owed()[2].paid === false,
      'the wallet’s own settling lands it, and the reconcile ticks the share, late, by that entry alone', String(landed - before));

    /* With no route, a card that proves its money signs the share over to this phone: received at once, its entry settled, so the
     * share is ticked by it straight away; the swap at the next connection changes nothing on the bill */
    const exact = await cardWith(250, { format: 4 });          // 128 64 32 16 8 2: exactly the third share, which is all a till with no route takes
    offline();
    exact.tap();
    const kept = await w.cardPay(exact, { sats: shares[2].sats, pin: '1234', offline: true });
    w.splitNoteCard(shares[2].hash, kept.hash);          // as the app does as a card's payment is made
    ok(kept.kept === true && w.cardKeptWaiting().length === 1 && (await w.splitReconcile()) === 1 && owed().every((r) => r.paid) && w.splitRecord().done === true,
      'kept with no route: received, and the share is ticked by its entry at once');
    online();
    await w.claimUnclaimed();
    await settle();
    ok(w.cardKeptWaiting().length === 0 && (await w.splitReconcile()) === 0 && owed().every((r) => r.paid) && w.splitPending() === null,
      'swapped once there is a route, and nothing more is ticked', JSON.stringify(owed().map((r) => !!r.paid)));

    // the three shares, once each
    const sized = log().length;
    const balance = await w.balanceSats();
    const again = await w.splitReconcile();
    await settle();
    ok(balance === before + 150 + 200 + 250 && again === 0 && log().length === sized && (await w.balanceSats()) === balance,
      'the till is up by the three shares and no more, and a reconcile after it marks nothing, claims nothing and writes nothing', String(balance - before));

    /* A walk of the reconcile asks the mint a row at a time, and what it found goes onto the record as it is when it ends: a share
     * ticked by hand, or a card's payment noted on a row, while it was asking is not undone. */
    const four = await bill(4);
    [2, 3].forEach((i) => { unpaid[four[i].hash] = true; });          // the first two are paid at the mint: the walk marks them
    const walk = w.splitReconcile();                                  // it has read the record, and is asking
    w.splitMarkPaid(four[2].hash);                                    // meanwhile a share is ticked by hand
    w.splitNoteCard(four[3].hash, 'card-late-entry');                 // and a card's payment is noted on another
    const marked = await walk;
    await settle();
    ok(marked === 2 && owed()[0].paid === true && owed()[1].paid === true && owed()[2].paid === true && owed()[3].paid === false && owed()[3].card === 'card-late-entry',
      'a walk that ended after a share was ticked by hand and a payment noted does not undo either', JSON.stringify({ marked, rows: owed().map((r) => !!r.paid), card: owed()[3].card }));
    w.splitClear();
    ok(w.splitRecord() === null && (await w.splitReconcile()) === 0, 'and a bill that has gone is not written back');
  }

  console.log('\n' + (failed ? failed + ' split-doors check(s) failed — a regression'
    : 'all split-doors checks pass — the doors stay in step'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
