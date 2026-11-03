'use strict';
/* switch-instant.js — a mint switch lands at once, and its mint is asked behind it.
 *
 *     node tests/switch-instant.js
 *
 * A switch took as long as the mint took to answer: its info and keysets over
 * Tor, before the wallet would say it was anywhere. Everything the home screen
 * shows of a mint is on the phone already, the keysets among them
 * (`foxy.cashu.mint.cache`), so a switch now builds the wallet from those and
 * resolves at once (`switchTo`, `connect` with `lazy`), and the real connect
 * runs behind it. What this pins, against the real wallet and stand-in mints:
 *   - a switch to a mint with keys on file resolves before the mint has said
 *     a word, with `mintUrl` moved and that mint's balance readable
 *   - what needs the live mint is refused meanwhile in the words for it, and
 *     works once the mint has answered; the page is told when it does
 *   - a mint with no keys on file is at once "connecting" with nothing in hand,
 *     and nothing is made there until its keys come
 *   - a mint that will not answer leaves the phone on it, from the keys on
 *     file, still refusing what needs it, until a connect for real lands; one
 *     with no keys on file puts back the mint it was on
 *   - a visit (`remember: false`) does not write the mint this phone keeps
 *   - a mint that answers after the phone has gone elsewhere is let go
 *   - a lazy connect to a mint with no keys on file, not a person's switch,
 *     waits for the mint as a connect always did
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const A = 'https://a.test', B = 'https://b.test', C = 'https://c.test', D = 'https://d.test';
const canon = (u) => String(u || '').replace(/\/+$/, '');
const at = (m) => canon(new URL(m.url).origin);

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || !detail ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const tick = async (n) => { for (let i = 0; i < (n || 200); i++) await new Promise((r) => setTimeout(r, 0)); };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e || new Error('rejected with nothing'); } };

/* A page with four stand-in mints. `ctx.hold[url]`: that mint's requests wait until `release(url)`; `ctx.down[url]`:
 * it answers nothing (the error iOS gives with no answer). */
function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mints = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const u = at(m);
        const go = () => {
          if (ctx.down[u]) return reply(w, m.id, null, 'The request timed out.');
          const mint = mints[u];
          if (!mint) return reply(w, m.id, null, 'no such mint in this test');
          ctx.asked.push(u + new URL(m.url).pathname);
          return reply(w, m.id, mint.handle(m));
        };
        // `holdOnly[u]`: only the requests whose path it matches are held (a connect's reads, say)
        if (ctx.hold[u] && (!ctx.holdOnly[u] || ctx.holdOnly[u].test(new URL(m.url).pathname))) {
          ctx.held[u] = (ctx.held[u] || []).concat([go]);
          return null;
        }
        return go();
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      mints = {
        [A]: fakeMint(w, { p2pk: true, fill: 7 }),
        [B]: fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 5000 }),
        [C]: fakeMint(w, { p2pk: true, fill: 11, quoteFrom: 9000 }),
        [D]: fakeMint(w, { p2pk: true, fill: 13, quoteFrom: 13000 }),
      };
    },
  });
  ctx.hold = {}; ctx.held = {}; ctx.down = {}; ctx.asked = []; ctx.holdOnly = {};
  ctx.release = (u) => { ctx.hold[u] = false; const list = ctx.held[u] || []; ctx.held[u] = []; list.forEach((go) => go()); };
  ctx.events = [];
  ctx.W.onMintConnected((ev) => ctx.events.push(ev));
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}

async function fund(ctx, sats) {
  const inv = await ctx.W.invoice(sats, '');
  await ctx.W.claim(inv.hash);
}

async function run() {
  const ctx = page();
  const W = ctx.W;
  const savedMint = () => JSON.parse(ctx.storage.getItem('foxy.cashu.mint') || 'null');

  // ---- once at each of two mints, for real: their keys are on file, and B holds 300 sat ----------------------------
  await W.connect(B, null, null, {});
  await fund(ctx, 300);
  await W.connect(A, null, null, {});
  await fund(ctx, 40);
  await tick();
  ok(W.mintUrl === A && W.mintCached(B) && W.mintCached(A), 'set up: on A, with the keys of A and B on file',
     W.mintUrl + ' ' + W.mintCached(B));

  // ---- 1. a switch to B lands before B has said anything -------------------------------------------------------------
  ctx.hold[B] = true;
  const askedBefore = ctx.asked.length;
  const t0 = Date.now();
  const got = await W.switchTo(B);
  ok(!!got && got.pending === true, 'a switch to a mint with keys on file resolves at once, pending', JSON.stringify(got));
  ok(W.mintUrl === B, 'and mintUrl has moved', W.mintUrl);
  ok(Date.now() - t0 < 1000 && ctx.asked.length === askedBefore, 'without waiting for one word from B',
     (Date.now() - t0) + ' ms, ' + (ctx.asked.length - askedBefore) + ' answered');
  ok((await W.balanceSats()) === 300 && got.balanceSats === 300, 'and B’s balance is readable from the pile',
     String(await W.balanceSats()));
  ok(savedMint() === B, 'B is the mint this phone keeps from now', String(savedMint()));
  const pend = W.connectPending();
  ok(!!pend && pend.url === B && pend.host === 'b.test' && pend.noKeys === false && pend.failed === '',
     'connectPending says B, by host, with its keys on file', JSON.stringify(pend));
  ok(W.fromCache() === true, 'and the wallet in hand is the one from the keys on file', String(W.fromCache()));

  // ---- 2. what needs B waits for it ---------------------------------------------------------------------------------
  const inv1 = await threw(() => W.invoice(50, ''));
  ok(!!inv1 && inv1.foxyConnecting === true && /still connecting to b\.test/i.test(inv1.message),
     'an invoice asked while B has not answered is refused with the connecting reason', inv1 && inv1.message);
  ok(ctx.events.length === 0, 'and nothing has said B answered', JSON.stringify(ctx.events));
  const soon = await W.routeSoon(0);
  ok(soon === false, 'routeSoon says the mint is not there yet', String(soon));
  const waiting = W.routeSoon(5000);

  // ---- 3. B answers ---------------------------------------------------------------------------------------------------
  ctx.release(B);
  await tick(400);
  ok(ctx.events.length === 1 && ctx.events[0].ok === true && ctx.events[0].url === B,
     'when B answers the page hears it, once', JSON.stringify(ctx.events));
  ok((await waiting) === true, 'and what was waiting for it hears true');
  ok(W.connectPending() === null && W.fromCache() === false, 'the pending mark is gone, and the wallet is B’s own now',
     JSON.stringify(W.connectPending()) + ' ' + W.fromCache());
  const inv2 = await W.invoice(50, '');
  ok(!!inv2 && !!inv2.bolt11, 'and the same invoice is made now', inv2 && inv2.hash);
  ok((await W.balanceSats()) === 300, 'and the balance is as it was', String(await W.balanceSats()));

  // ---- 4. a mint with no keys on file -------------------------------------------------------------------------------
  ok(!W.mintCached(C), 'C has never been connected to');
  ctx.hold[C] = true;
  const evC = ctx.events.length;
  const gotC = await W.switchTo(C);
  ok(!!gotC && gotC.pending === true && gotC.noKeys === true && W.mintUrl === C,
     'a switch to a mint with no keys on file still lands at once, connecting', JSON.stringify(gotC) + ' ' + W.mintUrl);
  ok((await W.balanceSats()) === 0 && W.connected === false, 'with no balance and no wallet in hand',
     (await W.balanceSats()) + ' ' + W.connected);
  const pc = W.connectPending();
  ok(!!pc && pc.noKeys === true, 'connectPending says it has no keys', JSON.stringify(pc));
  ok(savedMint() === B, 'and C is not kept as this phone’s mint before it has answered', String(savedMint()));
  const invC = await threw(() => W.invoice(10, ''));
  const tokC = await threw(() => W.sendToken(1, { unit: 'sat' }));
  ok(!!invC && invC.foxyConnecting === true, 'nothing is made at it: no invoice', invC && invC.message);
  ok(!!tokC && /connecting to c\.test/i.test(tokC.message), 'and no token', tokC && tokC.message);
  ctx.release(C);
  await tick(400);
  ok(ctx.events.length === evC + 1 && ctx.events[evC].ok === true && ctx.events[evC].noKeys === true,
     'when its keys come the page hears it', JSON.stringify(ctx.events.slice(evC)));
  ok(W.connected === true && W.mintUrl === C && W.mintCached(C) && savedMint() === C,
     'and the phone is on C for real, its keys now on file and C kept', W.connected + ' ' + savedMint());

  // ---- 5. a mint with no keys on file that does not answer: the mint it was on comes back ---------------------------
  ctx.down[D] = true;
  const evD = ctx.events.length;
  const gotD = await W.switchTo(D);
  ok(!!gotD && gotD.pending === true && W.mintUrl === D, 'a switch to an unknown mint that is down lands, connecting', W.mintUrl);
  await tick(600);
  ok(ctx.events.length === evD + 1 && ctx.events[evD].ok === false && ctx.events[evD].back === true && !!ctx.events[evD].why,
     'and when it does not answer the page is told, with why, and that the phone went back', JSON.stringify(ctx.events.slice(evD)));
  ok(W.mintUrl === C && W.connected === true && W.connectPending() === null && savedMint() === C,
     'the phone is on C again, as it was', W.mintUrl + ' ' + savedMint());
  ctx.down[D] = false;

  // ---- 6. a mint with keys on file that does not answer: the phone stays, in the offline state ---------------------
  ctx.down[A] = true;
  const evA = ctx.events.length;
  const gotA = await W.switchTo(A);
  ok(!!gotA && gotA.pending === true && W.mintUrl === A && (await W.balanceSats()) === 40,
     'a switch to A, which is down, lands with A’s 40 sat', W.mintUrl + ' ' + (await W.balanceSats()));
  await tick(600);
  ok(ctx.events.length === evA + 1 && ctx.events[evA].ok === false && ctx.events[evA].back === false,
     'A not answering is told, and the phone does not bounce back', JSON.stringify(ctx.events.slice(evA)));
  const pa = W.connectPending();
  ok(W.mintUrl === A && W.fromCache() === true && !!pa && !!pa.failed && savedMint() === A,
     'it stays on A, from the keys on file, with why it did not answer', JSON.stringify(pa) + ' ' + savedMint());
  const invA = await threw(() => W.invoice(10, ''));
  ok(!!invA && invA.foxyConnecting === true && /not answering/i.test(invA.message),
     'and what needs A is still refused, in the words for that', invA && invA.message);
  ok((await W.routeSoon(5000)) === false, 'routeSoon does not wait on a mint that has not answered');
  ctx.down[A] = false;
  await W.connect(A, null, null, {});
  await tick(200);
  ok(W.connectPending() === null && W.fromCache() === false && ctx.events.length === evA + 2 && ctx.events[evA + 1].ok === true,
     'a connect for real that lands lifts it, and the page hears A answered', JSON.stringify(ctx.events.slice(evA)));
  const invA2 = await W.invoice(10, '');
  ok(!!invA2 && !!invA2.bolt11, 'and an invoice is made at A again');

  // ---- 7. a visit does not change the mint this phone keeps ---------------------------------------------------------
  ctx.hold[B] = true;
  const visit = await W.connect(B, null, null, { remember: false, lazy: true });
  ok(!!visit && visit.pending === true && W.mintUrl === B, 'a lazy visit lands at once too', JSON.stringify(visit));
  ok(savedMint() === A, 'and the mint this phone keeps is still A', String(savedMint()));
  ctx.release(B);
  await tick(400);
  ok(savedMint() === A && W.connectPending() === null && W.mintUrl === B, 'nor once B has answered', String(savedMint()));

  // ---- 8. a mint that answers after the phone has gone elsewhere is let go -----------------------------------------
  await W.connect(A, null, null, {});
  ctx.hold[B] = true;
  const evS = ctx.events.length;
  await W.switchTo(B);
  ok(W.mintUrl === B && !!W.connectPending(), 'a switch to B, held');
  const back = await W.switchTo(A);
  ok(!!back && W.mintUrl === A, 'and straight back to A before B answers', W.mintUrl + ' ' + JSON.stringify(back));
  await tick(300);
  ctx.release(B);
  await tick(400);
  ok(W.mintUrl === A && savedMint() === A, 'B answering late moves nothing', W.mintUrl + ' ' + savedMint());
  ok(!ctx.events.slice(evS).some((e) => e.url === B), 'and the page is not told B answered', JSON.stringify(ctx.events.slice(evS)));
  ok(W.connectPending() === null || W.connectPending().url === A, 'nor is anything left pending for B', JSON.stringify(W.connectPending()));
  await tick(400);
  ok(W.connectPending() === null, 'and A, which answers, is connected for real', JSON.stringify(W.connectPending()));

  // ---- 8b. a payment started while the mint has not answered waits for it, as for a route on its way ---------------
  ctx.hold[B] = true;
  await W.switchTo(B);
  W._routeWaitMs = 4000;
  let sent = null, sendErr = null;
  const sending = W.sendToken(5, { unit: 'sat' }).then((r) => { sent = r; }, (e) => { sendErr = e; });
  await tick(200);
  ok(!sent && !sendErr, 'a token started while B has not answered waits for it', String(sendErr && sendErr.message));
  ctx.release(B);
  await sending;
  ok(!!(sent && sent.token) && !sendErr, 'and is made once B answers', String(sendErr && sendErr.message));
  W._routeWaitMs = 0;

  // ---- 8c. a till opened at another mint is open before that mint answers, and closing it is home at once ---------
  await W.connect(A, null, null, {});
  await tick(200);
  ctx.hold[B] = true;
  const opened = await W.tillKeeperOpen(B);
  ok(!!opened && opened.moved === true && opened.mint === B && W.mintUrl === B && !!W.connectPending(),
     'a till opened at B, which has not answered, is open at once, on B', JSON.stringify(opened));
  ok(savedMint() === A, 'and the till’s visit keeps A as this phone’s mint', String(savedMint()));
  ctx.release(B);
  await tick(400);
  ok(W.connectPending() === null && W.fromCache() === false, 'B answers behind the till', JSON.stringify(W.connectPending()));
  ctx.hold[A] = true;
  const closed = await W.tillKeeperClose();
  ok(!!closed && closed.moved === true && W.mintUrl === A && !!W.connectPending(), 'closing it puts the phone home on A at once',
     JSON.stringify(closed));
  ctx.release(A);
  await tick(400);
  ok(W.connectPending() === null && savedMint() === A, 'and A answers behind it', JSON.stringify(W.connectPending()));

  // ---- 9. lazy without a person's switch, with no keys on file: waited for, as ever ---------------------------------
  const ctx2 = page();
  await ctx2.W.connect(A, null, null, {});
  ctx2.hold[C] = true;
  let landed = false;
  const lazyC = ctx2.W.connect(C, null, null, { remember: false, lazy: true }).then((r) => { landed = true; return r; });
  await tick(200);
  ok(!landed && ctx2.W.mintUrl === A, 'a lazy visit to a mint with no keys on file waits for it, still on A', ctx2.W.mintUrl);
  ctx2.release(C);
  const rC = await lazyC;
  ok(landed && ctx2.W.mintUrl === C && !(rC && rC.pending), 'and lands when it answers, not pending', JSON.stringify(rC));

  // ---- 11. a late claim's walk away at another mint: a switch does not wait for it, and it does not come home over it
  for (const how of ['switch', 'till']) {
    const x = page(); const X = x.W;
    const payer = page(); const P = payer.W;
    await P.connect(B, null, null, {}); await fund(payer, 200);
    await X.connect(C, null, null, {}); await X.connect(D, null, null, {}); await X.connect(B, null, null, {});
    await tick();
    // a payment locked to this phone at B, kept unclaimed because B did not answer its claim
    await X.primeLocks();
    const ask = X.decodeRequest(X.paymentRequest(31, { purpose: 'receive' })) || {};
    const paid = await P.sendToken(31, { unit: 'sat', lockTo: ask.lockTo });
    const bits = X.tokenInfo(paid.token);
    x.down[B] = true;
    X._requestPaid(JSON.stringify({ id: ask.id, mint: B, unit: 'sat', proofs: bits.proofs.map((pr) => Object.assign(
      { id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C }, pr.dleq ? { dleq: pr.dleq } : {})) }), 'kept-' + how);
    await tick(400);
    x.down[B] = false;
    // home is A; its connect's sweeps walk to B for that payment, and B is slow
    x.hold[B] = true;
    await X.connect(A, null, null, {});
    await tick(200);
    const walking = X.claimUnclaimed();
    for (let i = 0; i < 40 && !X.awayClaiming(); i++) await tick(20);
    ok(X.awayClaiming(), how + ': a late claim\u2019s walk is away at B', X.mintUrl);
    const t0 = Date.now();
    if (how === 'switch') {
      const r = await X.switchTo(C);
      ok(!!r && r.pending === true && X.mintUrl === C && Date.now() - t0 < 1000,
         'a person\u2019s switch to C lands at once, not after the walk', X.mintUrl + ' ' + (Date.now() - t0) + ' ms');
    } else {
      const r = await X.tillKeeperOpen(D);
      ok(!!r && r.moved === true && X.mintUrl === D, 'a till opened at D meanwhile is open on D', X.mintUrl + ' ' + JSON.stringify(r));
    }
    const want = how === 'switch' ? C : D;
    x.release(B);
    await walking.then(null, () => null);
    await tick(400);
    ok(X.mintUrl === want && !X.awayClaiming(), 'the walk ends without coming home to A over it: still on ' + want.replace('https://', ''),
       X.mintUrl + ' away ' + X.awayClaiming());
    const req = X.decodeRequest(X.paymentRequest(5, { purpose: 'receive' })) || {};
    ok(canon(req.mint || (req.mints || [])[0]) === want, 'and a request made now names ' + want.replace('https://', ''), JSON.stringify(req.mints || req.mint));
    const inv = await X.invoice(5, '');
    ok(!!inv && canon(inv.mint) === want, 'and so does an invoice', inv && inv.mint);
  }

  // ---- 12. a card's visit ending after a till was opened elsewhere does not come home over it --------------------
  {
    const x = page(); const X = x.W;
    await X.connect(B, null, null, {}); await X.connect(C, null, null, {}); await X.connect(A, null, null, {}); await tick();
    const visit = await X.cardVisit(B);
    ok(X.mintUrl === B, 'a card\u2019s visit to B', X.mintUrl);
    const r = await X.tillKeeperOpen(C);
    ok(!!r && r.moved === true && X.mintUrl === C, 'a till opened at C during it is on C', X.mintUrl);
    await visit.end();
    await tick(400);
    ok(X.mintUrl === C && !X.awayClaiming(), 'the visit ends, and does not take the phone home to A over the till', X.mintUrl);
    const req = X.decodeRequest(X.paymentRequest(5, { purpose: 'receive' })) || {};
    ok(canon((req.mints || [])[0] || req.mint) === C, 'a request names C', JSON.stringify(req.mints || req.mint));
  }

  // ---- 10. the review's findings, each pinned ------------------------------------------------------------------------
  {
    // p1: a connect under way when the person switches does not take the phone back, landing or failing
    for (const how of ['lands', 'fails']) {
      const x = page(); const X = x.W;
      await X.connect(B, null, null, {}); await X.connect(A, null, null, {}); await X.connect(C, null, null, {});
      await tick();
      x.hold[A] = true;
      let late = null;
      const plainA = X.connect(A, null, null, {}).then(() => { late = 'landed'; }, (e) => { late = e; });
      await tick(50);
      await X.switchTo(B);
      await tick(300);
      if (how === 'fails') x.down[A] = true;
      x.release(A);
      await plainA; await tick(200);
      const saved = JSON.parse(x.storage.getItem('foxy.cashu.mint') || 'null');
      ok(X.mintUrl === B && saved === B, 'p1 ' + how + ': a connect to A under way when the person switched to B does not take the phone back',
         X.mintUrl + ' ' + saved);
      if (how === 'lands') ok(!!late && late.foxyMovedOn === true, 'and it is refused, so nothing goes on as if it were at A', String(late && late.message));
    }
    // p3: two switches in one moment end on the second
    {
      const x = page(); const X = x.W;
      await X.connect(B, null, null, {}); await X.connect(A, null, null, {}); await tick();
      x.hold[C] = true;
      const [rb, rc] = await Promise.all([X.switchTo(B), X.switchTo(C)]);
      ok(X.mintUrl === C && !!rb.superseded && rc.pending === true && rc.noKeys === true, 'p3: B then C in one moment: the phone is on C, the last chosen',
         X.mintUrl + ' ' + JSON.stringify([rb, rc]));
      const inv = await threw(() => X.invoice(10, ''));
      ok(!!inv && /connecting to c\.test/.test(inv.message), 'and nothing is made at B', inv && inv.message);
      x.release(C); await tick(300);
    }
    // p2: a till's visit that did not answer first time is not made the phone's mint by the page's catch-up connect
    {
      const x = page(); const X = x.W;
      await X.connect(B, null, null, {}); await X.connect(A, null, null, {}); await tick();
      x.down[B] = true;
      await X.connect(B, null, null, { remember: false, lazy: true });
      await tick(400);
      ok(!!X.connectPending() && !!X.connectPending().failed, 'p2: a visit to B, which does not answer', JSON.stringify(X.connectPending()));
      x.down[B] = false;
      await X.connect(X.mintUrl);
      await tick(300);
      const saved = JSON.parse(x.storage.getItem('foxy.cashu.mint') || 'null');
      ok(X.connectPending() === null && X.mintUrl === B && saved === A, 'and the catch-up connect that lands keeps it a visit: A is still the mint kept',
         X.mintUrl + ' ' + saved);
    }
    // p4: the limits on what is held unsettled count while the mint has not answered, as with no route
    {
      const x = page(); const X = x.W;
      await X.connect(B, null, null, {}); await X.connect(A, null, null, {}); await tick();
      X.setTillCap('hold', 100);
      X.setTillCap('payer', 100);
      x.hold[B] = true;
      await X.switchTo(B);
      ok(!!X.tillRefusal(500, 'sat', '', false), 'p4: while B has not answered, 500 sat over a 100 sat cap is refused', JSON.stringify(X.tillRefusal(500, 'sat', '', false)));
      x.release(B); await tick(300);
      ok(X.tillRefusal(500, 'sat', '', false) === '', 'and once it answers the cap is the online one again');
    }
    // p5: the same mint switched to again while it is asked is not "not answering"
    {
      const x = page(); const X = x.W;
      await X.connect(B, null, null, {}); await X.connect(A, null, null, {}); await tick();
      x.hold[B] = true;
      await X.switchTo(B); await tick(50);
      const r2 = await X.switchTo(B); await tick(50);
      ok(!x.events.some((e) => !e.ok) && !!X.connectPending() && X.connectPending().failed === '' && r2.gen > 0,
         'p5: B switched to twice before it answers: nothing says it is not answering', JSON.stringify(x.events));
      x.release(B); await tick(300);
      ok(x.events.length === 1 && x.events[0].ok === true && x.events[0].gen === r2.gen, 'and its answer is told once, for the switch that stands, by its number',
         JSON.stringify(x.events));
    }
    // 7: a claim refused while the mint has not answered is not filed as a paid invoice that will not collect
    {
      const x = page(); const X = x.W;
      await X.connect(A, null, null, {}); await X.connect(B, null, null, {});
      const inv = await X.invoice(20, '');
      // not collected from A's side meanwhile (the walk of other mints' invoices a connect ends with)
      X._sweepAway = () => Promise.resolve([]);
      await X.connect(A, null, null, {}); await tick();
      ok((X.pendingQuotes() || []).some((q) => q.quote === inv.hash), '7: an invoice at B, paid and not yet collected');
      // B's connect reads held, its quotes answered: the sweep finds the invoice paid and the claim is refused
      x.hold[B] = true;
      x.holdOnly[B] = /\/v1\/(info|keys|keysets)/;
      await X.switchTo(B);
      const no = await threw(() => X.claim(inv.hash));
      ok(!!no && no.foxyConnecting === true, '7: claiming a paid invoice while B has not answered is refused with the connecting reason', no && no.message);
      await X.sweepQuotes().then(null, () => null);
      await tick(200);
      ok(!!X.connectPending() && !(X.stuckInvoices() || []).some((q) => q.quote === inv.hash),
         'and a sweep that finds it paid meanwhile does not file it as paid and not collected', JSON.stringify(X.stuckInvoices()));
      x.release(B); await tick(400);
      ok((await X.balanceSats()) >= 20, 'and the connect\u2019s sweep collects it once B answers', String(await X.balanceSats()));
    }
  }

  // ---- 13. 2026-11-03: which path a switch takes, said; a mint whose keysets the store could not keep -----------------
  {
    const x = page(); const X = x.W;
    const said = [];
    const wl = x.window.console.log, ww = x.window.console.warn;
    x.window.console.log = (...a) => { said.push(a.join(' ')); };
    x.window.console.warn = (...a) => { said.push(a.join(' ')); };
    await X.connect(B, null, null, {}); await X.connect(A, null, null, {}); await tick();
    ok(X.switchWaits(B) === '', '13: a switch to a mint with its keys on file and a route lands at once (switchWaits says nothing)', X.switchWaits(B));
    ok(X.switchWaits(D) === 'no keys on file', 'and one never connected to waits for the mint: no keys on file', X.switchWaits(D));
    X._privacy({ tor: 'connecting', progress: 10, everUp: true });
    ok(X.switchWaits(B) === 'no route', 'and with no route: no route', X.switchWaits(B));
    X._privacy({ tor: 'up', progress: 100, everUp: true });
    // the store refuses the mint cache: the connect works, says so, and remembers it
    const proto = Object.getPrototypeOf(x.storage);
    const set0 = proto.setItem;
    proto.setItem = function (k, v) {
      if (k === 'foxy.cashu.mint.cache') throw new x.window.DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return set0.call(this, k, v);
    };
    said.length = 0;
    await X.connect(C, null, null, {}); await tick();
    proto.setItem = set0;
    ok(said.some((l) => l === "[foxy] could not keep c.test's keysets: the store is full"),
       'a connect whose keysets the full store refused says so, by host', JSON.stringify(said.filter((l) => /keysets/.test(l))));
    ok(X.mintUrl === C, 'and the connect itself stands', X.mintUrl);
    await X.connect(A, null, null, {}); await tick();
    ok(X.switchWaits(C) === 'its keysets could not be kept: the store is full', 'a switch to it would wait for the mint, for that reason', X.switchWaits(C));
    said.length = 0;
    x.hold[C] = true;
    const t0 = Date.now();
    let landed = null;
    const going = X.switchTo(C).then((r) => { landed = r; });
    await tick(100);
    ok(landed === null && said.some((l) => l === '[foxy] switch: c.test waits for the mint: its keysets could not be kept: the store is full'),
       'and it does: the live path, the reason printed, nothing landed from the keys on file', JSON.stringify({ landed, said: said.filter((l) => /switch/.test(l)) }));
    x.release(C);
    await going; await tick();
    ok(X.mintUrl === C && landed && !landed.pending, 'once the mint answers the switch lands, for real', JSON.stringify(landed) + ' ' + (Date.now() - t0) + ' ms');
    ok(X.switchWaits(C) === '', 'and the keysets it gave, kept this time, put the mint back on the at-once path', X.switchWaits(C));
    x.window.console.log = wl; x.window.console.warn = ww;
  }

  // ---- 14. the build stamp: the page and the wallet in Web/ carry one, and the boot says when they differ ----------------
  {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const root = path.join(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'Web', 'index.html'), 'utf8');
    const wtext = fs.readFileSync(path.join(root, 'Web', 'foxy-wallet.js'), 'utf8');
    const ps = (/<meta name="foxy-wallet-stamp" content="([0-9a-f]{64})">/.exec(html) || [])[1];
    const ws = (/window\.FoxyWallet\.buildStamp = '([0-9a-f]{64})'/.exec(wtext) || [])[1];
    const self = crypto.createHash('sha256').update(wtext.replace(/(window\.FoxyWallet\.buildStamp = ')[0-9a-f]*(')/, '$1$2'), 'utf8').digest('hex');
    ok(!!ps && ps === ws && ws === self, '14: the page\u2019s stamp, the wallet\u2019s, and the wallet\u2019s own hash with its stamp blanked are one',
       [ps, ws, self].map((v) => String(v).slice(0, 8)).join(' '));
    const ctx = loadReal({});
    ok(ctx.W.buildStamp === ws, 'and the wallet as loaded carries it (FoxyWallet.buildStamp)', String(ctx.W.buildStamp).slice(0, 8));
    // the boot's comparison, lifted out of build/foxy-app.js
    const src = fs.readFileSync(path.join(root, 'build', 'foxy-app.js'), 'utf8');
    const at = src.indexOf('\n  buildStampCheck() {');
    let i = src.indexOf('{', at), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
    const check = new Function('return {' + src.slice(at + 3, i + 1) + '}')().buildStampCheck;
    const run = (pageStamp, walletStamp) => {
      const lines = [];
      const log0 = console.log;
      global.window = { FoxyWallet: { buildStamp: walletStamp } };
      global.document = { querySelector: () => (pageStamp == null ? null : { getAttribute: () => pageStamp }) };
      console.log = (...a) => lines.push(a.join(' '));
      let same;
      try { same = check.call({}); } finally { console.log = log0; delete global.window; delete global.document; }
      return { same, lines };
    };
    const a1 = 'a'.repeat(64), b1 = 'b'.repeat(64);
    const same = run(a1, a1), diff = run(a1, b1), none = run(a1, ''), bare = run(null, b1);
    ok(same.same === true && same.lines.length === 0, 'one build: nothing said', JSON.stringify(same));
    ok(diff.same === false && diff.lines.length === 1 && diff.lines[0] === '[foxy] page and wallet from different builds (page aaaaaaaa, wallet bbbbbbbb)',
       'two builds: one line, the page\u2019s eight and the wallet\u2019s', JSON.stringify(diff.lines));
    ok(none.lines[0] === '[foxy] page and wallet from different builds (page aaaaaaaa, wallet none)', 'a wallet with no stamp (an older build) is named so', JSON.stringify(none.lines));
    ok(bare.same === true && bare.lines.length === 0, 'and a page with no stamp (a test\u2019s, unpacked) says nothing', JSON.stringify(bare));
    ok(/bootWalletNow\(\) \{\s*const W = window\.FoxyWallet;\s*this\.buildStampCheck\(\);/.test(src), 'the boot asks it first', 'bootWalletNow');
  }

  console.log('\n' + (failed ? failed + ' of ' + (passed + failed) + ' switch-instant checks FAILED' : 'all ' + passed + ' switch-instant checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
