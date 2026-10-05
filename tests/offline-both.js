'use strict';
/* offline-both.js — a payment between two phones that are both offline.
 *
 *     node tests/offline-both.js
 *
 * This used to be simply refused. Unlocked ecash is a race: the payer
 * keeps a copy, and the only thing that settles it is the receiver's swap at the
 * mint, which needs a route. So two offline phones could not pay each other at
 * all, and the rule was enforced by arithmetic rather than by anybody's word — a
 * lock cannot be made without a swap, so "locked" proves the payer had a route.
 *
 * The decision is to allow it, behind a card the receiver has to accept:
 * the risk is real, bounded and theirs to take, and whether a particular payer
 * would spend their copy back is a question about that payer. What this pins:
 *
 *   - the card is asked, once, with the amount, before anything is written down
 *   - REJECT leaves the payer holding their own ecash and tells them so
 *   - no card registered means no: money is never taken on an unasked question
 *   - over-payment is refused BEFORE the card. An offline receiver cannot make
 *     change, and change out of its own pile would cost it the payment AND the
 *     change if the payer spends theirs again — so the person is never asked to
 *     accept a payment that could cost more than it is worth
 *   - only over Bluetooth: a payer with no route reaches no onion and no relay
 *   - accepted, it is PENDING, not settled, and swapped on the next connect
 *   - and if the payer did spend it back, the person is told, with the history
 *     entry turned from pending to failed rather than vanishing
 *   - locked ecash arriving offline still needs no card at all
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, rebook } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  const answers = [];
  const asked = [];
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  let ctx = null;
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        // read live, so a phone can be given its radios back mid-test
        if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
        return reply(w, m.id, mint.handle(m));
      }
      if (m.action === 'inboxAnswer') {
        answers.push({ status: Number(m.status), text: String(m.text || '') });
        return reply(w, m.id, 'ok');
      }
      if (m.action === 'tapAsking') { asked.push(true); return reply(w, m.id, 'ok'); }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    /* One mint for every page in a case, so its books are one set of books.
     * A per-page mint would have let the payer "spend their copy back" at a
     * mint the receiver never asks, and case 7 would have proved nothing. */
    before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, { p2pk: true }); },
  });
  ctx.deaf = !!opts.deaf;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.answers = answers;
  ctx.tapAsking = asked;
  ctx.mint = mint;
  return ctx;
}

const settle = async () => { for (let i = 0; i < 500; i++) await new Promise((r) => setTimeout(r, 0)); };
const goOffline = (W) => {
  W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false,
               transport: 'direct', network: 'none' });
  W.setOffline(true);
};
const goOnline = (W) => {
  W.setOffline(false);
  W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
};
const dump = (ctx) => {
  const out = {};
  for (let i = 0; i < ctx.storage.length; i++) out[ctx.storage.key(i)] = ctx.storage.getItem(ctx.storage.key(i));
  return out;
};
const bodyFor = (ask, bits) => JSON.stringify({
  id: ask.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
  proofs: bits.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),  // the DLEQ, as payRequest sends it
});
const unclaimedRows = (ctx) => JSON.parse(ctx.storage.getItem('foxy.req.unclaimed') || '{}');
const history = (ctx) => JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]');

/* A receiver with keysets on file, offline, with a request open; and a payer
 * holding ecash it made while it still had a route. The payer's proofs are
 * unlocked on purpose: that is what an offline payer can make. */
async function pair(cardSays, o) {
  const opts = o || {};
  const seed = page({});
  await seed.W.connect(MINT, null, null, { remember: true });
  const inv = await seed.W.invoice(3000, '');
  await seed.W.claim(inv.hash);
  const carried = dump(seed);
  const shared = seed.mint;

  const payer = page({ sharedMint: shared,
    words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
  await payer.W.connect(MINT, null, null, { remember: true });
  const pinv = await payer.W.invoice(2000, '');
  await payer.W.claim(pinv.hash);

  const rx = page({ storage: carried, deaf: true, sharedMint: shared });
  /* The feature is off as Foxy ships (`OFFLINE_TO_OFFLINE`). `opts.shipped`
   * leaves it off, which is what the first case checks; everything else drives
   * it on, so the card and everything behind it stay covered for the day it
   * is turned back on. */
  /* Both pages: the payer refuses to make the payment at all without it
   * (`handoverRefusal`), and the receiver refuses to take it. Two halves of
   * one rule, and a test that flips only one of them is testing neither. */
  if (!opts.shipped) { rx.W._offlineToOffline(true); payer.W._offlineToOffline(true); }
  goOffline(rx.W);
  await rx.W.connect(MINT, null, null, { remember: true });
  const cards = [];
  if (cardSays !== null) {
    rx.W.onOfflineOffer((info) => { cards.push(info); return Promise.resolve(cardSays); });
  }
  const lost = [];
  rx.W.onTrustLost((info) => lost.push(info));
  await rx.W.primeLocks();
  const ask = rx.W.decodeRequest(rx.W.paymentRequest(opts.asks || 64, { purpose: 'receive' })) || {};

  const pay = await payer.W.sendToken(opts.pays || 64, { unit: 'sat' });
  const bits = rx.W.tokenInfo(pay.token);
  return { rx, payer, ask, pay, bits, cards, lost, carried };
}

async function run() {
  /* ---- as it ships: not supported --------------------------------------
   *
   * It is turned off. What is unsettled is not the card or
   * anything behind it — all of that is exercised below — but what a payer
   * should be able to do after handing money over on trust. Until that has an
   * answer an offline phone takes only ecash locked to it, which needs nobody's
   * trust. This is the shipped behaviour; everything after it drives the switch
   * on, so the day it returns it returns tested. */
  {
    const t = await pair(true, { shipped: true });
    const before = await t.rx.W.balanceSats();
    t.rx.W._requestPaid(bodyFor(t.ask, t.bits), 'off-by-default', 'tap');
    await settle();
    ok(t.cards.length === 0, 'as it ships, no card is shown', JSON.stringify(t.cards));
    const said = t.rx.answers;
    ok(said.length === 1 && said[0].status === 422 && /locked to it/i.test(said[0].text),
       'and an unlocked payment with no route is refused, as it was before',
       JSON.stringify(said));
    ok((await t.rx.W.balanceSats()) === before, 'with nothing taken');
  }


  // ---- 1: accepted on trust ------------------------------------------------
  {
    const t = await pair(true);
    const before = await t.rx.W.balanceSats();
    t.rx.W._requestPaid(bodyFor(t.ask, t.bits), 'both-yes', 'tap');
    await settle();
    ok(t.cards.length === 1, 'the card is asked once', String(t.cards.length));
    ok(t.cards[0] && t.cards[0].sats === 64, 'and it is told the amount',
       JSON.stringify(t.cards[0]));
    ok(t.rx.tapAsking.length === 1, 'and the payer is told a person is deciding',
       String(t.rx.tapAsking.length));
    const said = t.rx.answers;
    ok(said.length === 1 && said[0].status === 200, 'the payer is answered 200',
       JSON.stringify(said));
    ok((await t.rx.W.balanceSats()) === before + 64, 'the sats are counted',
       String(await t.rx.W.balanceSats()) + ' vs ' + (before + 64));
    const rows = unclaimedRows(t.rx);
    ok(!!rows[t.ask.id] && rows[t.ask.id].trusted === true,
       'the row is marked trusted, so a later "spent" answer is news and not bookkeeping',
       JSON.stringify(rows[t.ask.id] && Object.keys(rows[t.ask.id])));
    const h = history(t.rx).filter((e) => e.hash === 'req-' + t.ask.id);
    ok(h.length === 1 && h[0].settled === false && h[0].state === 'pending',
       'history says pending, because it has not settled', JSON.stringify(h));
    ok(h.length === 1 && h[0].trusted === true,
       'and the entry itself is marked, so the list can say AT RISK rather than Pending',
       JSON.stringify(h[0] && h[0].trusted));
    const at = t.rx.W.trustedWaiting();
    ok(at.length === 1 && at[0].sats === 64,
       'and it is listed as still at risk, which is what turns the ring red',
       JSON.stringify(at));
    ok(t.rx.W.trustedWaitingSats() === 64, 'with the amount that is out there',
       String(t.rx.W.trustedWaitingSats()));

    // ---- 6: and the next connect settles it -------------------------------
    t.rx.deaf = false;
    goOnline(t.rx.W);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const took = await t.rx.W.claimUnclaimed();
    ok(took === 64, 'with a route it is swapped in', String(took));
    ok(!unclaimedRows(t.rx)[t.ask.id], 'and the row is gone',
       JSON.stringify(Object.keys(unclaimedRows(t.rx))));
    ok(t.rx.W.trustedWaiting().length === 0,
       'nothing is at risk any more, so the ring stops',
       JSON.stringify(t.rx.W.trustedWaiting()));
    const h2 = history(t.rx).filter((e) => e.hash === 'req-' + t.ask.id);
    ok(h2.length === 1 && h2[0].settled === true,
       'the same entry settles rather than a second one appearing', JSON.stringify(h2));
    ok(t.lost.length === 0, 'and nobody was told anything went wrong');
  }

  // ---- 2: rejected ---------------------------------------------------------
  {
    const t = await pair(false);
    const before = await t.rx.W.balanceSats();
    t.rx.W._requestPaid(bodyFor(t.ask, t.bits), 'both-no', 'tap');
    await settle();
    ok(t.cards.length === 1, 'the card is asked');
    const said = t.rx.answers;
    ok(said.length === 1 && said[0].status === 422, 'the payer is refused', JSON.stringify(said));
    ok(said.length === 1 && /did not accept/i.test(said[0].text),
       'and told the person did not accept, not that something broke', said[0] && said[0].text);
    ok(said.length === 1 && /still yours/i.test(said[0].text),
       'and that their ecash is still theirs', said[0] && said[0].text);
    ok((await t.rx.W.balanceSats()) === before, 'nothing was counted');
    ok(!unclaimedRows(t.rx)[t.ask.id], 'nothing was written down',
       JSON.stringify(Object.keys(unclaimedRows(t.rx))));
    ok(history(t.rx).filter((e) => e.hash === 'req-' + t.ask.id).length === 0,
       'and nothing is in history');
  }

  // ---- 3: no card registered ---------------------------------------------
  {
    const t = await pair(null);
    const before = await t.rx.W.balanceSats();
    t.rx.W._requestPaid(bodyFor(t.ask, t.bits), 'both-none', 'tap');
    await settle();
    const said = t.rx.answers;
    ok(said.length === 1 && said[0].status === 422,
       'with no card registered the payment is refused', JSON.stringify(said));
    ok((await t.rx.W.balanceSats()) === before, 'and nothing is taken on a question nobody asked');
  }

  // ---- 4: over-payment, refused before the card ---------------------------
  {
    const t = await pair(true, { asks: 64, pays: 128 });
    const before = await t.rx.W.balanceSats();
    t.rx.W._requestPaid(bodyFor(t.ask, t.bits), 'both-over', 'tap');
    await settle();
    ok(t.cards.length === 0, 'an over-payment never reaches the card',
       JSON.stringify(t.cards));
    const said = t.rx.answers;
    ok(said.length === 1 && said[0].status === 422, 'it is refused', JSON.stringify(said));
    ok(said.length === 1 && /exactly 64/.test(said[0].text),
       'and the payer is told the exact amount to send', said[0] && said[0].text);
    ok((await t.rx.W.balanceSats()) === before, 'nothing was taken');
    ok(!unclaimedRows(t.rx)[t.ask.id], 'and nothing was written down');
  }

  // ---- 5: not over Bluetooth ---------------------------------------------
  {
    const t = await pair(true);
    t.rx.W._requestPaid(bodyFor(t.ask, t.bits), 'both-relay', '');
    await settle();
    ok(t.cards.length === 0, 'unlocked ecash off a relay or an onion never reaches the card',
       JSON.stringify(t.cards));
    const said = t.rx.answers;
    ok(said.length === 1 && said[0].status === 422 && /locked to it/i.test(said[0].text),
       'it is refused as it always was', JSON.stringify(said));
  }

  // ---- 7: the payer took it back ------------------------------------------
  {
    const t = await pair(true);
    t.rx.W._requestPaid(bodyFor(t.ask, t.bits), 'both-cheat', 'tap');
    await settle();
    ok((await t.rx.W.balanceSats()) > 0 && !!unclaimedRows(t.rx)[t.ask.id],
       'the payment was taken on trust');
    const shown = await t.rx.W.balanceSats();

    // the payer spends their own copy back at the mint, which is the whole risk
    await t.payer.W.receiveToken(t.pay.token);

    t.rx.deaf = false;
    goOnline(t.rx.W);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const took = await t.rx.W.claimUnclaimed();
    ok(took === 0, 'the claim gets nothing', String(took));
    ok(t.lost.length === 1 && t.lost[0].sats === 64,
       'the person is told the payer took it back', JSON.stringify(t.lost));
    ok((await t.rx.W.balanceSats()) === shown - 64, 'and the sats come off the balance',
       String(await t.rx.W.balanceSats()) + ' vs ' + (shown - 64));
    const h = history(t.rx).filter((e) => e.hash === 'req-' + t.ask.id);
    ok(h.length === 1 && h[0].state === 'failed',
       'the entry turns to failed rather than vanishing, so nobody is left sure they were paid',
       JSON.stringify(h));
  }

  // ---- 8: locked ecash offline still needs no card ------------------------
  {
    const t = await pair(true);
    const locked = await t.payer.W.sendToken(64, { unit: 'sat', lockTo: t.ask.lockTo });
    const lbits = t.rx.W.tokenInfo(locked.token);
    const before = await t.rx.W.balanceSats();
    t.rx.W._requestPaid(bodyFor(t.ask, lbits), 'locked-offline', 'tap');
    await settle();
    ok(t.cards.length === 0, 'ecash locked to this phone is taken with no card at all',
       JSON.stringify(t.cards));
    ok(t.rx.tapAsking.length === 0, 'and the payer is never told anybody is deciding');
    ok((await t.rx.W.balanceSats()) === before + 64, 'and it is taken',
       String(await t.rx.W.balanceSats()) + ' vs ' + (before + 64));
    const rows = unclaimedRows(t.rx);
    ok(!rows[t.ask.id] || rows[t.ask.id].trusted !== true,
       'and it is not marked trusted: it needs no trust', JSON.stringify(rows[t.ask.id]));
  }

  /* ---- 9: an offline payer paying an ONLINE receiver ----------------------
   *
   * The case hit on a real device. A receiver asks for a lock whenever its
   * mint supports NUT-11, which says nothing about whether the receiver is
   * online — and locking means swapping, which the payer cannot do. So the send
   * died on the spot, silently, with both phones linked and the code on both
   * screens. The lock is dropped instead, and the receiver, who does have a
   * route, swaps the ecash in before it says a word. */
  {
    const t = await pair(true);
    // the receiver puts its radios back on: it is the payer that is offline here
    t.rx.deaf = false;
    goOnline(t.rx.W);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    await t.rx.W.primeLocks();
    /* 128, not 64: `pair` already spent this payer's 64-sat piece, and an
     * offline send is exact pieces or nothing. Which is the other half of what
     * went wrong on the phones — a lock that could not be made, and a pool that
     * had not finished filling. */
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(128, { purpose: 'receive' })) || {};
    ok(!!ask.lockTo, 'the online receiver asks for a lock, as it always does');

    // and the payer loses its own
    t.payer.deaf = true;
    goOffline(t.payer.W);
    await t.payer.W.connect(MINT, null, null, { remember: true });

    const before = await t.rx.W.balanceSats();
    /* Delivery is the onion here, because the harness has no Bluetooth link to
     * hand it over — so the delivery fails, as it should with no route, and the
     * token comes back on the error for the token screen to show. What is being
     * tested is the step before it: the *making*, which used to die on the lock
     * and take the whole payment with it. On the phones the link is open and the
     * hand-over goes over it. */
    const paid = await t.payer.W.payRequest(Object.assign({}, ask, {
      delivery: { kind: 'onion', target: 'x' }, sats: 128, unit: 'sat',
    }), () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ made: e && e.foxyToken,
                                                       why: (e && e.message) || String(e) }));
    const made = paid.made;
    ok(!!made && !!made.token,
       'the offline payer makes the payment rather than dying on the lock',
       made ? 'made' : 'nothing made \u2014 ' + paid.why);
    const bits = made && made.token ? t.rx.W.tokenInfo(made.token) : null;
    ok(!!bits, 'and it is a real token', bits ? String(bits.proofs.length) + ' proofs' : 'none');
    if (bits) {
      ok(bits.proofs.every((pr) => pr.secret.charAt(0) !== '['),
         'paid unlocked, because a lock cannot be made with no route');
      t.rx.W._requestPaid(bodyFor(ask, bits), 'offline-payer', 'tap');
      await settle();
      ok((await t.rx.W.balanceSats()) === before + 128,
         'and the online receiver takes it, swapping it in first',
         String(await t.rx.W.balanceSats()) + ' vs ' + (before + 128));
      ok(!unclaimedRows(t.rx)[ask.id],
         'nothing is left unclaimed: the receiver had a route and settled it',
         JSON.stringify(Object.keys(unclaimedRows(t.rx))));
      ok(t.rx.W.trustedWaiting().length === 0,
         'and nothing is at risk \u2014 no trust was needed from anybody');
    }
  }

  /* ---- 10: an offline payer with no exact pieces ---------------------------
   *
   * Exact amounts went through and anything needing change died on the spot.
   * A swap is how an awkward amount is
   * normally made and a swap needs a mint, so offline the choice is between
   * paying a little too much and not paying at all — and paying too much costs
   * nothing, because the receiver hands the difference back locked to the payer
   * over the same link. No QR, no scanning, no trust. */
  {
    const t = await pair(true);
    t.rx.deaf = false;
    goOnline(t.rx.W);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    await t.rx.W.primeLocks();

    t.payer.deaf = true;
    goOffline(t.payer.W);
    await t.payer.W.connect(MINT, null, null, { remember: true });

    /* 100 sats: the payer holds 1024/512/256/128/16 and no 64 (pair spent it),
     * so there is no exact set and a swap is the only other way. */
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { purpose: 'receive' })) || {};
    const paid = await t.payer.W.payRequest(Object.assign({}, ask, {
      delivery: { kind: 'onion', target: 'x' }, viaTap: true, sats: 100, unit: 'sat',
    }), () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ made: e && e.foxyToken,
                                                       why: (e && e.message) || String(e) }));
    const made = paid.made;
    ok(!!made && !!made.token, 'an amount with no exact pieces is still paid',
       made ? 'made' : 'nothing made \u2014 ' + paid.why);
    if (made) {
      ok(made.over > 0, 'by over-paying, with the difference owed back',
         JSON.stringify({ paid: made.sats, asked: made.asked, over: made.over }));
      ok(made.sats === 100 + made.over, 'and the token really holds that much',
         String(made.sats));
      ok(made.swapped === false, 'and the mint was never asked \u2014 it could not be',
         String(made.swapped));

      /* And the receiver, which does have a route, takes the whole thing. The
       * change leg itself — locked to the key the payer sends, handed back as
       * M7 — is `changeBack`, covered by tests/forward-locked.js and by the
       * harness proof; what is being pinned here is that the over-payment is
       * made at all and arrives intact. */
      const bits = t.rx.W.tokenInfo(made.token);
      const before = await t.rx.W.balanceSats();
      /* `changeTo` is what the payer's own `payRequest` puts in the body, and
       * without it the receiver keeps the lot — correctly, since there is
       * nowhere to lock change to. Shape-valid is all this needs. */
      const body = JSON.stringify({
        id: ask.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
        changeTo: ask.lockTo,
        proofs: bits.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),  // the DLEQ, as payRequest sends it
      });
      t.rx.W._requestPaid(body, 'cover-pay', 'tap');
      await settle();
      ok((await t.rx.W.balanceSats()) === before + 100,
         'the online receiver keeps the payment and hands the rest back',
         String(await t.rx.W.balanceSats()) + ' vs ' + (before + 100));

      /* One transaction, with the change inside it. Two rows for one sale is
       * what a person kept reading: a payment for the gross and a withdrawal
       * for the change. */
      const rxLog = history(t.rx).filter((e) => e.hash === 'req-' + ask.id);
      ok(rxLog.length === 1, 'the receiver has one entry, not two',
         String(rxLog.length));
      ok(rxLog[0] && rxLog[0].sats === 100 && rxLog[0].grossSats === 128
         && rxLog[0].changeSats === 28,
         'showing the net, with what moved and what went back kept beside it',
         JSON.stringify(rxLog[0] && { sats: rxLog[0].sats, gross: rxLog[0].grossSats,
                                      change: rxLog[0].changeSats }));
      const changeRows = history(t.rx).filter((e) => e.dir === 'out' && e.sats === 28);
      ok(changeRows.length === 0, 'and the change is not a transaction of its own',
         JSON.stringify(changeRows));

      // the payer's side of the same sale
      const payLog = history(t.payer).filter((e) => e.hash === made.hash);
      ok(payLog.length === 1 && payLog[0].sats === 100 && payLog[0].grossSats === 128
         && payLog[0].changeSats === 28,
         'and the payer records the same three figures',
         JSON.stringify(payLog[0] && { sats: payLog[0].sats, gross: payLog[0].grossSats,
                                       change: payLog[0].changeSats }));

      /* And the entry is finished by what actually happens to the change. */
      t.payer.W.changeSettled(made.hash, 0);
      const gone = history(t.payer).filter((e) => e.hash === made.hash)[0];
      ok(gone && gone.sats === 128 && gone.changeState === 'never came',
         'change that never comes turns the entry into what it really cost',
         JSON.stringify(gone && { sats: gone.sats, state: gone.changeState }));
      t.payer.W.changeSettled(made.hash, 28);
      rebook(t.payer);   // the entry is told by hand that 28 sats came back, and none were put in the pile
      const back = history(t.payer).filter((e) => e.hash === made.hash)[0];
      ok(back && back.sats === 100 && back.changeState === 'came back',
         'and change that comes back turns it into what it really cost',
         JSON.stringify(back && { sats: back.sats, state: back.changeState }));
    }

    /* Over an onion or a relay there is no link to hand change back over, so
     * the same amount is refused rather than over-paid into thin air. */
    const noLink = await t.payer.W.payRequest(Object.assign({}, ask, {
      delivery: { kind: 'onion', target: 'x' }, sats: 100, unit: 'sat',
    }), () => {}, { overpayOk: true }).then(() => null, (e) => (e && e.foxyToken) ? 'made anyway' : 'refused');
    ok(noLink === 'refused',
       'and with no link to give change back over, it is refused instead', String(noLink));
  }

  /* ---- 11: a request from an offline receiver names no transport ----------
   *
   * An offline receiver cannot publish an onion or reach a relay, so its
   * request carries no transports at all — and `payRequest` refused before it
   * looked at anything, while the two phones were linked and the four digits
   * were on both screens. The payer was sent to the token screen to show a QR,
   * which is the one thing this was built to make unnecessary.
   *
   * The link the offer arrived over IS the delivery. `viaTap` says there is
   * one, and it is only ever set for a request that came over that very link. */
  {
    const t = await pair(true);
    t.payer.deaf = true;
    goOffline(t.payer.W);
    await t.payer.W.connect(MINT, null, null, { remember: true });

    // what an offline receiver's request looks like: no deliverTo at all
    const bare = t.rx.W.decodeRequest(
      t.rx.W.paymentRequest(128, { purpose: 'receive' })) || {};
    ok(!bare.delivery, 'an offline receiver names no way to be reached',
       JSON.stringify(bare.delivery));

    const refused = await t.payer.W.payRequest(Object.assign({}, bare, { sats: 128, unit: 'sat' }),
      () => {}).then(() => null, (e) => (e && e.message) || String(e));
    ok(!!refused && /no way Foxy can deliver/.test(refused),
       'and with no link either, there is genuinely nothing to deliver to', String(refused));

    /* Over the link it arrived on, it is payable — the token is made and handed
     * to the tap. The harness has no radio, so `tapSend` is what fails, not the
     * refusal above: what is pinned is that it got that far at all. */
    let handed = '';
    t.payer.W.tapSend = (body) => { handed = String(body || ''); return Promise.resolve('settled'); };
    const paid = await t.payer.W.payRequest(
      Object.assign({}, bare, { sats: 128, unit: 'sat', viaTap: true }), () => {}, { overpayOk: true })
      .then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
    ok(!!paid.made && !!paid.made.token,
       'over the open link it is paid, with no transport named at all',
       paid.made ? 'paid' : 'refused \u2014 ' + paid.why);
    ok(handed.indexOf('"proofs"') > 0,
       'and the proofs really went over the link, not onto a QR',
       handed.slice(0, 40));
  }

  /* ---- 12: a route coming back clears what is at risk ----------------------
   *
   * Everything that claims waiting money hangs off `connect()`, and neither a
   * launch nor a mint switch happens when a network returns mid-session. So a
   * payment taken on trust sat in history as AT RISK with wifi in the room, and
   * the red ring turned until the app was restarted (a circuit came up and
   * nothing was claimed after it). */
  {
    const t = await pair(true);
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(31, { purpose: 'receive' })) || {};
    const pay = await t.payer.W.sendToken(31, { unit: 'sat' });
    const bits = t.rx.W.tokenInfo(pay.token);
    t.rx.W._requestPaid(bodyFor(ask, bits), 'at-risk-route', 'tap');
    await settle();
    ok(t.rx.W.trustedWaiting().length === 1, 'a payment is taken on trust and is at risk',
       JSON.stringify(t.rx.W.trustedWaiting()));

    // the radios come back, and nothing calls connect()
    t.rx.deaf = false;
    goOnline(t.rx.W);
    const took = await t.rx.W.claimUnclaimed();
    ok(took === 31, 'the claim a route coming back should run takes it', String(took));
    ok(t.rx.W.trustedWaiting().length === 0, 'and nothing is at risk any more',
       JSON.stringify(t.rx.W.trustedWaiting()));
    ok(t.rx.W.unclaimedSats() === 0,
       'which is what the app asks before running it', String(t.rx.W.unclaimedSats()));
    const h = history(t.rx).filter((e) => e.hash === 'req-' + ask.id);
    ok(h.length === 1 && h[0].settled === true,
       'and the row settles rather than staying AT RISK', JSON.stringify(h));
  }

  /* ---- 13: over-paying is asked, never assumed ---------------------------
   *
   * Where the receiver has a route the difference comes straight back; where
   * neither phone has one it cannot come back at all and the extra is a gift. A
   * wallet does not give somebody's money away because the arithmetic was
   * convenient. */
  {
    const t = await pair(true);
    t.payer.deaf = true;
    goOffline(t.payer.W);
    await t.payer.W.connect(MINT, null, null, { remember: true });
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { purpose: 'receive' })) || {};
    const before = await t.payer.W.balanceSats();

    const asked = await t.payer.W.payRequest(
      Object.assign({}, ask, { sats: 100, unit: 'sat', viaTap: true }), () => {})
      .then(() => null, (e) => e);
    ok(!!asked && !!asked.foxyNeedsOverpay,
       'without an answer it refuses rather than over-paying',
       asked ? (asked.message || '') : 'it paid anyway');
    ok(asked && asked.foxyNeedsOverpay.asked === 100
       && asked.foxyNeedsOverpay.pay === 128 && asked.foxyNeedsOverpay.over === 28,
       'and hands back the three figures for the card to ask with',
       JSON.stringify(asked && asked.foxyNeedsOverpay));
    ok(!asked.foxyToken, 'nothing was made, so a cancel costs nothing',
       asked.foxyToken ? 'a token exists' : 'none');
    ok((await t.payer.W.balanceSats()) === before, 'and the pile is untouched',
       String(await t.payer.W.balanceSats()) + ' vs ' + before);

    const agreed = await t.payer.W.payRequest(
      Object.assign({}, ask, { sats: 100, unit: 'sat', viaTap: true }), () => {},
      { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ made: e && e.foxyToken }));
    ok(!!agreed.made && agreed.made.over === 28, 'with the answer it over-pays',
       JSON.stringify(agreed.made && agreed.made.over));

    /* And the receiver, also offline, takes it — because the payer said the
     * extra was meant. Without that word it is refused exactly as before, or
     * the card would lead the person straight into a refusal. */
    const bits = t.rx.W.tokenInfo(agreed.made.token);
    const bodyOf = (meant) => JSON.stringify({
      id: ask.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
      overpaid: meant || undefined,
      proofs: bits.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),  // the DLEQ, as payRequest sends it
    });
    const rxBefore = await t.rx.W.balanceSats();
    const mark = t.rx.answers.length;
    t.rx.W._requestPaid(bodyOf(false), 'meant-no', 'tap');
    await settle();
    ok(t.rx.answers.slice(mark).some((a) => a.status === 422 && /exactly/.test(a.text)),
       'an over-payment with no such word is refused as it always was',
       JSON.stringify(t.rx.answers.slice(mark)));

    const mark2 = t.rx.answers.length;
    t.rx.W._requestPaid(bodyOf(true), 'meant-yes', 'tap');
    await settle();
    ok(t.rx.answers.slice(mark2).some((a) => a.status === 200),
       'and one the payer meant is taken', JSON.stringify(t.rx.answers.slice(mark2)));
    ok((await t.rx.W.balanceSats()) === rxBefore + 128,
       'with the whole of it kept, because there is no change to make',
       String(await t.rx.W.balanceSats()) + ' vs ' + (rxBefore + 128));
  }

  /* ---- 14: a payment on its way is not a payment that happened -------------
   *
   * `sendToken` writes a settled entry the moment the token exists, which is
   * before it has been handed to anybody — and the history pass announces every
   * new settled entry. On a both-offline tap the receiver is reading a card, so
   * the payer was shown a confirmation of withdrawal thirteen seconds before
   * they said no. */
  {
    const t = await pair(true);
    t.payer.deaf = true;
    goOffline(t.payer.W);
    await t.payer.W.connect(MINT, null, null, { remember: true });
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(16, { purpose: 'receive' })) || {};
    // no tapSend in the harness, so the delivery fails and the token comes back
    const out = await t.payer.W.payRequest(
      Object.assign({}, ask, { sats: 16, unit: 'sat', viaTap: true }), () => {})
      .then((r) => r, (e) => e && e.foxyToken);
    ok(!!out && !!out.hash, 'a payment was made', out ? out.hash : 'none');
    const tags = t.payer.W.tagsFor(out.hash) || {};
    ok(tags.inflight === true,
       'and is marked as on its way while nobody has taken it',
       JSON.stringify(tags.inflight));
    ok(!!tags.token, 'with its token kept, so it can still be handed over',
       tags.token ? 'kept' : 'gone');
  }

  console.log('\n' + (failed ? failed + ' offline-both check(s) failed'
    : 'all offline-both checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
