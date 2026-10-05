'use strict';
/* spend-offline.js — money taken with no route, spent with no route.
 *
 *     node tests/spend-offline.js
 *
 * The question a market stall asks, and the one Foxy could not answer: a
 * payment taken this morning is locked to this phone and sitting in the
 * unclaimed store, counted in the balance — and a send reads the spendable
 * pile, which it is not in, because getting it there is a swap. So an offline
 * phone could take payments all day and not be able to make one ("so change is spendable for offline payer?").
 *
 * NUT-11 with SIG_INPUTS is what makes it possible. A signature over the inputs
 * authorises the spend and says nothing about who creates the outputs, so a
 * proof this phone signs is one anybody can swap — and handing it on is a real
 * payment rather than an IOU. `forwardLocked` has done that for a while; what
 * this pins is that a send can now reach it.
 *
 * What it must not do is let the same proofs leave twice: signing writes them
 * down as handed on and takes them out of the unclaimed store, and a second
 * attempt has to find nothing.
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
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
        return reply(w, m.id, mint.handle(m));
      }
      if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, { p2pk: true, feePpk: opts.feePpk }); },
  });
  ctx.deaf = !!opts.deaf;
  ctx.mint = mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
const goOffline = (W) => {
  W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false,
               transport: 'direct', network: 'none' });
  W.setOffline(true);
};
const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const rows = (c) => JSON.parse(c.storage.getItem('foxy.req.unclaimed') || '{}');

async function run() {
  /* A phone with keysets on file and NOTHING in its pile — everything it has
   * arrived while it was offline and is locked to it. That is the state this
   * whole exercise is about. */
  const seed = page({});
  await seed.W.connect(MINT, null, null, { remember: true });
  const inv = await seed.W.invoice(2000, '');
  await seed.W.claim(inv.hash);
  const carried = dump(seed);
  const shared = seed.mint;

  const payer = page({ sharedMint: shared,
    words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
  await payer.W.connect(MINT, null, null, { remember: true });
  const pinv = await payer.W.invoice(2000, '');
  await payer.W.claim(pinv.hash);

  const stall = page({ storage: carried, sharedMint: shared });
  await stall.W.connect(MINT, null, null, { remember: true });
  await stall.W.primeLocks();
  const ask = stall.W.decodeRequest(stall.W.paymentRequest(28, { purpose: 'receive' })) || {};
  ok(!!ask.lockTo, 'the stall asks to be paid with a lock');

  // it goes offline, and is paid while it is
  stall.deaf = true;
  goOffline(stall.W);
  await stall.W.connect(MINT, null, null, { remember: true });
  const paid = await payer.W.sendToken(28, { unit: 'sat', lockTo: ask.lockTo });
  const bits = stall.W.tokenInfo(paid.token);
  const body = JSON.stringify({
    id: ask.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
    proofs: bits.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),  // the DLEQ, as payRequest sends it
  });
  const before = await stall.W.balanceSats();
  stall.W._requestPaid(body, 'offline-take', 'tap');
  await settle();
  ok((await stall.W.balanceSats()) === before + 28,
     'and takes 28 sats while offline, because they are locked to it',
     String(await stall.W.balanceSats()) + ' vs ' + (before + 28));
  ok(Object.keys(rows(stall)).length === 1,
     'which sit in the unclaimed store, not the spendable pile',
     JSON.stringify(Object.keys(rows(stall))));

  /* ---- and now it spends them, still with no route ---------------------
   * 28 is 16 + 8 + 4, and the pile holds a 16 and no 8 or 4 — so there is no
   * exact set in it, which is the case this exists for. A swap would be the
   * ordinary answer and there is no route to make one. */
  const out = await stall.W.sendToken(28, { unit: 'sat' })
    .then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
  ok(!!out.made && !!out.made.token,
     'it pays 28 sats with no route and no exact set in the pile',
     out.made ? 'paid' : out.why);
  if (out.made) {
    const sent = stall.W.tokenInfo(out.made.token);
    ok(sent.proofs.reduce((a, pr) => a + pr.amount, 0) === 28,
       'the token really holds 28 sats', String(out.made.sats));
    ok(sent.proofs.every((pr) => pr.secret.charAt(0) === '['),
       'made of the locked proofs it was paid with, not new ones');
    ok(sent.proofs.every((pr) => !!pr.witness),
       'each carrying this phone’s signature, so anybody can swap it');

    /* Which is the whole claim: somebody else can spend it. The payer, who is
     * online, takes it in. */
    const took = await payer.W.receiveToken(out.made.token)
      .then((r) => r, (e) => ({ why: (e && e.message) || String(e) }));
    ok(took && took.sats === 28,
       'and a wallet with a route swaps it at the mint, so it was money',
       JSON.stringify(took && (took.sats || took.why)));
  }

  ok(Object.keys(rows(stall)).length === 0,
     'the row is gone, so it cannot be handed on twice',
     JSON.stringify(Object.keys(rows(stall))));
  const again = await stall.W.sendToken(28, { unit: 'sat' })
    .then(() => null, (e) => (e && e.message) || String(e));
  ok(!!again, 'and a second attempt at the same amount finds nothing', String(again));

  /* ---- a payment spent piece by piece ----------------------------------
   *
   * One payment of 28 arrives while offline: a 16, an 8 and a 4, all locked.
   * It used to be one note — pay 12 and the whole 28 went, with 16 to wait
   * for. Each piece carries its own lock, so the 8 and the 4 can go alone. */
  const cart = page({ storage: carried, sharedMint: shared });
  await cart.W.connect(MINT, null, null, { remember: true });
  await cart.W.primeLocks();
  // empty its pile, so the pieces are all it has
  const spare = await cart.W.balanceSats();
  if (spare > 0) await payer.W.receiveToken((await cart.W.sendToken(spare, { unit: 'sat' })).token);
  ok((await cart.W.balanceSats()) === 0, 'a phone with nothing in its pile');
  const ask2 = cart.W.decodeRequest(cart.W.paymentRequest(28, { purpose: 'receive' })) || {};
  cart.deaf = true;
  goOffline(cart.W);
  await cart.W.connect(MINT, null, null, { remember: true });
  const paid2 = await payer.W.sendToken(28, { unit: 'sat', lockTo: ask2.lockTo });
  const bits2 = cart.W.tokenInfo(paid2.token);
  cart.W._requestPaid(JSON.stringify({
    id: ask2.id, mint: String(bits2.mint || '').replace(/\/+$/, ''), unit: 'sat',
    proofs: bits2.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),
  }), 'offline-take-2', 'tap');
  await settle();
  ok((await cart.W.balanceSats()) === 28, 'is paid 28 while offline', String(await cart.W.balanceSats()));
  // the row as it was written when the payment landed, all three pieces in it
  const wholeRow = (Object.values(rows(cart))[0] || {}).token;

  // and they show as change, because they can be spent as change
  const shown = cart.W.pieces().filter((r) => r.count > 0).map((r) => r.amount + 'x' + r.count).join(' ');
  ok(shown === '4x1 8x1 16x1', 'YOUR CHANGE lists the pieces of a payment taken offline', shown);

  // the same ecash offered a second time, by another road, is not kept twice
  const again2 = await cart.W.receiveToken(paid2.token).then(() => 'kept', (e) => (e && e.message) || String(e));
  ok(/already/i.test(again2), 'scanning ecash this phone already holds is refused', again2);
  ok((await cart.W.balanceSats()) === 28, 'and the balance does not count it twice', String(await cart.W.balanceSats()));

  const part = await cart.W.sendToken(12, { unit: 'sat' })
    .then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
  ok(!!part.made && !!part.made.token, 'and pays 12 of it, exactly, with no route', part.made ? 'paid' : part.why);
  if (part.made) {
    const sent = cart.W.tokenInfo(part.made.token);
    ok(sent.proofs.reduce((a, pr) => a + pr.amount, 0) === 12 && sent.proofs.length === 2,
       'with the 8 and the 4, and nothing else', JSON.stringify(sent.proofs.map((pr) => pr.amount)));
    ok(sent.proofs.every((pr) => !!pr.witness), 'each signed here');
    const took = await payer.W.receiveToken(part.made.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(took && took.sats === 12, 'and whoever is given them can swap them', JSON.stringify(took && (took.sats || took.why)));
  }
  ok((await cart.W.balanceSats()) === 16, 'the 16 is still this phone’s', String(await cart.W.balanceSats()));
  const left = rows(cart);
  const leftRow = left[Object.keys(left)[0]] || {};
  ok(Object.keys(left).length === 1 && leftRow.sats === 16 && leftRow.whole === 28,
     'on the same row, which remembers it was 28 whole', JSON.stringify({ sats: leftRow.sats, whole: leftRow.whole }));
  const kept = cart.W.tokenInfo(leftRow.token);
  ok(kept.proofs.length === 1 && Number(kept.proofs[0].amount) === 16, 'and now holds only the 16',
     JSON.stringify(kept.proofs.map((pr) => Number(pr.amount))));

  // the same pieces cannot go twice
  const twice = await cart.W.sendToken(12, { unit: 'sat' }).then(() => null, (e) => (e && e.message) || String(e));
  ok(!!twice, 'the 8 and the 4 cannot be spent a second time', String(twice));

  /* Back online, the rest is swapped in — the 16, not the 28 the row once
   * was, which the mint would refuse as already spent and lose the 16 with. */
  /* And the same when the row could not be rewritten as its pieces went (a
   * full store, the app closing): it still names all three, and the list of
   * what was signed away is all that says two of them are gone. The claim
   * leaves those out before the mint is asked. Claimed whole, the mint says
   * spent, the row is dropped for it, and the 16 goes with it. */
  {
    const put = rows(cart);
    const id = Object.keys(put)[0];
    put[id].token = wholeRow;
    cart.storage.setItem('foxy.req.unclaimed', JSON.stringify(put));
    ok(cart.W.tokenInfo(rows(cart)[id].token).proofs.length === 3, 'the row names all three pieces again, as if its rewrite had failed');
  }
  cart.deaf = false;
  cart.W.setOffline(false);
  cart.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
  await cart.W.connect(MINT, null, null, { remember: true });
  await cart.W.claimUnclaimed();
  await settle();
  ok(Object.keys(rows(cart)).length === 0, 'with a route the rest is claimed and the row goes',
     JSON.stringify(Object.keys(rows(cart))));
  ok((await cart.W.balanceSats()) === 16, 'and the balance is still 16, now in the pile', String(await cart.W.balanceSats()));
  const log = JSON.parse(cart.storage.getItem('foxy.cashu.log') || '[]');
  const arrival = log.filter((e) => e && e.hash === 'req-' + ask2.id)[0] || {};
  ok(arrival.sats === 28, 'and the payment’s entry still says 28 arrived', String(arrival.sats));
  const outs = log.filter((e) => e && e.dir === 'out' && e.sats === 12).length;
  ok(outs === 1, 'beside one payment of 12 out', String(outs));

  /* ---- what a late claim does to the payment's entry -----------------------
   *
   * A payment that was spent from before it was claimed says what it was worth
   * whole, because the entry is the payment that arrived. One nobody spent
   * from has nothing to correct: its entry keeps the amount written when the
   * payment landed. */
  {
    const till = page({ sharedMint: shared,
      words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' });
    await till.W.connect(MINT, null, null, { remember: true });
    await till.W.primeLocks();
    const askUntouched = till.W.decodeRequest(till.W.paymentRequest(28, { purpose: 'receive' })) || {};
    till.deaf = true;
    goOffline(till.W);
    await till.W.connect(MINT, null, null, { remember: true });
    const made = await payer.W.sendToken(28, { unit: 'sat', lockTo: askUntouched.lockTo });
    const info = till.W.tokenInfo(made.token);
    till.W._requestPaid(JSON.stringify({
      id: askUntouched.id, mint: String(info.mint || '').replace(/\/+$/, ''), unit: 'sat',
      proofs: info.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
        pr.dleq ? { dleq: pr.dleq } : {})),
    }), 'till-untouched', 'tap');
    await settle();
    ok(Object.keys(rows(till)).length === 1 && !('whole' in (rows(till)[askUntouched.id] || {})),
      'a payment of 28 taken offline and not spent from', JSON.stringify(Object.keys(rows(till))));

    till.deaf = false;
    till.W.setOffline(false);
    till.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    await till.W.connect(MINT, null, null, { remember: true });
    await till.W.claimUnclaimed();
    await settle();
    ok(Object.keys(rows(till)).length === 0 && (await till.W.balanceSats()) === 28,
      'is claimed whole with a route', String(await till.W.balanceSats()));
    const entries = JSON.parse(till.storage.getItem('foxy.cashu.log') || '[]');
    const arrived = entries.filter((e) => e && e.hash === 'req-' + askUntouched.id)[0] || {};
    ok(arrived.sats === 28 && arrived.state === 'success',
      'and its entry says 28 arrived, as it did before the claim', JSON.stringify({ sats: arrived.sats, state: arrived.state }));
  }

  /* ---- a sat too small to claim is let go, not carried for ever -------------
   *
   * At a mint that charges a sat a piece, the one piece left of a payment
   * that was spent from is worth no more than the swap would cost. Claimed, the
   * mint refuses it and the row stays; counted in the balance and asked about
   * on every connection. It is let go instead, and the payment beside it is
   * claimed as usual. */
  {
    const dear = page({ feePpk: 1000,
      words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
    await dear.W.connect(MINT, null, null, { remember: true });
    await dear.W.claim((await dear.W.invoice(2000, '')).hash);
    const shop = page({ sharedMint: dear.mint, feePpk: 1000,
      words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' });
    await shop.W.connect(MINT, null, null, { remember: true });
    await shop.W.primeLocks();
    const askDust = shop.W.decodeRequest(shop.W.paymentRequest(1, { purpose: 'receive' })) || {};
    const askFull = shop.W.decodeRequest(shop.W.paymentRequest(2, { purpose: 'receive' })) || {};
    shop.deaf = true;
    goOffline(shop.W);
    await shop.W.connect(MINT, null, null, { remember: true });
    const take = async (askFor, sats, name) => {
      const made = await dear.W.sendToken(sats, { unit: 'sat', lockTo: askFor.lockTo });
      const info = shop.W.tokenInfo(made.token);
      shop.W._requestPaid(JSON.stringify({
        id: askFor.id, mint: String(info.mint || '').replace(/\/+$/, ''), unit: 'sat',
        proofs: info.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
          pr.dleq ? { dleq: pr.dleq } : {})),
      }), name, 'tap');
      await settle();
    };
    await take(askDust, 1, 'shop-dust');
    await take(askFull, 2, 'shop-full');
    ok(Object.keys(rows(shop)).length === 2, 'two payments are waiting at a mint that charges a sat a piece');

    /* The 2 of the first goes on, signed here, and the 1 is what is left of it. */
    const row = rows(shop)[askDust.id] || {};
    const pieces = shop.W.tokenInfo(row.token);
    const two = pieces.proofs.filter((pr) => Number(pr.amount) === 2);
    const gave = await shop.W.forwardLocked(shop.window.CashuTS.getEncodedToken({
      mint: String(pieces.mint || '').replace(/\/+$/, ''), unit: 'sat', proofs: two }))
      .then((r) => r, (e) => ({ why: e && e.message }));
    const left = shop.W.tokenInfo((rows(shop)[askDust.id] || {}).token || '');
    ok(gave.sats === 2 && left && left.proofs.length === 1 && Number(left.proofs[0].amount) === 1,
      'a payment of 3 is left with the one sat', JSON.stringify(gave.why || (left && left.proofs.map((pr) => pr.amount))));
    const dust = left && left.proofs[0] ? left.proofs[0].secret : '';

    shop.deaf = false;
    shop.W.setOffline(false);
    shop.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    await shop.W.connect(MINT, null, null, { remember: true });
    await shop.W.claimUnclaimed();
    await settle();
    ok(!rows(shop)[askDust.id], 'the sat left is let go rather than kept to be asked about again',
      JSON.stringify(Object.keys(rows(shop))));
    ok(!dear.mint.spentSecrets.includes(dust), 'and the mint was never troubled with it');
    ok(!rows(shop)[askFull.id], 'while the payment beside it is claimed');
    ok((await shop.W.balanceSats()) === 2, 'leaving what that one was worth after the mint\u2019s fee',
      String(await shop.W.balanceSats()));
    await shop.W.claimUnclaimed();
    ok(Object.keys(rows(shop)).length === 0, 'and nothing is left waiting', JSON.stringify(Object.keys(rows(shop))));
  }

  console.log('\n' + (failed ? failed + ' spend-offline check(s) failed'
    : 'all spend-offline checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
