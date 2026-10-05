'use strict';
/* counter-refusal.js — a refusal that costs the payer nothing.
 *
 *     node tests/counter-refusal.js
 *
 * MONEY.md §15. Two wallets as they ship, one
 * mint of cashu-ts's own crypto, and the link between them: M10 and M11 for
 * the question asked first, M5 and M6 for the payment and its answer, M7 and
 * M8 for what comes back.
 *
 *   A. asking first: every honest refusal happens before any ecash is made;
 *   B. a refund, not a word: a receiver that has to refuse ecash it was
 *      handed sends the whole of it back locked to the payer;
 *   C. no refund: the payer's ecash is in its wallet again at risk, and a
 *      refund that turns up late, as a code, settles it.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };
const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const history = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
const atRiskStore = (c) => JSON.parse(c.storage.getItem('foxy.cashu.atrisk') || '{}');

function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  const answers = [];
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      const L = ctx.link;
      const gone = () => reply(w, m.id, null, 'That phone is no longer connected.');
      switch (m.action) {
        case 'mintRequest': {
          if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
          ctx.asked.push(m.method + ' ' + new URL(m.url).pathname);
          return reply(w, m.id, ctx.mint.handle(m));
        }
        case 'inboxAnswer':
          answers.push({ status: [200, 409, 422].indexOf(Number(m.status)) >= 0 ? Number(m.status) : 422, text: String(m.text || '') });
          return reply(w, m.id, 'ok');
        case 'tapChangeDue':                               // the receiver tells the payer something is coming back
          ctx.due += 1;
          return reply(w, m.id, 'ok');
        case 'tapAsking':
          return reply(w, m.id, 'ok');
        case 'tapQuote':                                   // M10, payer to receiver
          if (!L || !L.up || L.dropM10) { if (L && L.dropM10 && L.up) { L.log.push('M10 lost'); return reply(w, m.id, 'ok'); } return gone(); }
          L.log.push('M10');
          setTimeout(() => L.receiver.W._tapQuote(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapTerms':                                   // M11, receiver to payer
          if (!L || !L.up) return gone();
          L.log.push('M11');
          setTimeout(() => L.payer.W._tapTerms(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapChange':                                  // M7, receiver to payer
          if (!L || !L.up) return gone();
          L.log.push('M7');
          setTimeout(() => L.payer.W._tapChange(String(m.body || '')), 0);
          L.m7 = { id: m.id };
          return null;
        case 'tapChangeKept':                              // M8, payer to receiver
          if (L && L.m7) {
            const a = L.m7; L.m7 = null; L.log.push('M8 ' + !!m.kept);
            if (m.kept) L.receiver.window.FoxyWallet._scanResult(a.id, 'ok');
            else L.receiver.window.FoxyWallet._scanResult(a.id, null, 'They could not keep it.');
          }
          return reply(w, m.id, 'ok');
        case 'tapSend': {                                  // M5, and M6 back
          if (!L || !L.up) return gone();
          L.log.push('M5');
          L.lastBody = String(m.body || '');
          /* Not an honest Foxy: it takes what it is handed, says no in its
           * own words and sends nothing back — and, told to, redeems the
           * pieces before it answers. */
          if (L.liar) {
            const lie = () => { L.log.push('M6 422 (a lie)'); reply(w, m.id, JSON.stringify({ v: 2, ok: false, code: 422, why: L.liar.why })); };
            if (!L.liar.steal) { setTimeout(lie, 5); return null; }
            const j = JSON.parse(L.lastBody);
            const token = L.receiver.window.CashuTS.getEncodedToken({ mint: j.mint, proofs: j.proofs, unit: 'sat' });
            L.receiver.W.receiveToken(token).then((r) => { L.stole = r.sats; lie(); }, (e) => { L.stole = 'could not: ' + e.message; lie(); });
            return null;
          }
          setTimeout(() => L.receiver.W._requestPaid(String(m.body || ''), 'wire', 'tap'), 0);
          const began = L.receiver.answers.length;
          const wait = setInterval(() => {
            const said = L.receiver.answers;
            if (said.length <= began) return;
            clearInterval(wait);
            const last = said[said.length - 1];
            L.log.push('M6 ' + last.status);
            if (L.cutAfterM6) L.up = false;
            reply(w, m.id, JSON.stringify(last.status === 200 ? { v: 2, ok: true, code: 200 }
              : { v: 2, ok: false, code: last.status, why: String(last.text || '').slice(0, 160) }));
          }, 1);
          return null;
        }
        default: {
          const got = phone.answer(w, m);
          if (!got) return reply(w, m.id, null, 'not in this test');
          return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
        }
      }
    },
    before: (w) => { phone.attach(w); ctx_mint = opts.mint || fakeMint(w, { p2pk: true, feePpk: opts.feePpk }); },
  });
  ctx.mint = ctx_mint;
  ctx.asked = [];
  ctx.answers = answers;
  ctx.due = 0;
  ctx.deaf = false;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
let ctx_mint = null;
const goOffline = (c) => { c.deaf = true; c.W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' }); c.W.setOffline(true); };
const goOnline = (c) => { c.deaf = false; c.W.setOffline(false); c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' }); };

/* A payer and a receiver on one mint, linked. */
async function pair(o) {
  const opts = o || {};
  const seed = page({ feePpk: opts.feePpk });
  await seed.W.connect(MINT, null, null, { remember: true });
  await seed.W.claim((await seed.W.invoice(3000, '')).hash);
  for (let i = 0; i < 6; i++) { const r = await seed.W.tidyChange().catch(() => null); if (!r || r.skipped) break; }
  const rx = page({ mint: seed.mint, words: OTHER_WORDS, feePpk: opts.feePpk });
  await rx.W.connect(MINT, null, null, { remember: true });
  await rx.W.claim((await rx.W.invoice(1000, '')).hash);
  await rx.W.primeLocks();
  const payer = page({ mint: seed.mint, storage: dump(seed), feePpk: opts.feePpk });
  await payer.W.connect(MINT, null, null, { remember: true });
  await payer.W.primeLocks();
  payer.W._refundWaitMs = opts.refundWaitMs || 1500;
  payer.W._askWaitMs = 400;
  const L = { up: true, log: [], payer, receiver: rx };
  payer.link = L; rx.link = L;
  payer.said = []; payer.W.onAtRisk((x) => payer.said.push(x));
  rx.stuck = null; rx.W.onChangeStuck((info) => { rx.stuck = info; });
  // what the tap offer tells the payer: their route, and that they answer a question first
  const pay = (sats, extra) => {
    const text = (extra && extra.text) || rx.W.paymentRequest(sats, { purpose: 'receive' });
    const ask = payer.W.decodeRequest(text) || {};
    const req = Object.assign({}, ask, { sats: sats, unit: 'sat', viaTap: true, theirRoute: !rx.deaf, asks: true }, (extra && extra.req) || {});
    return payer.W.payRequest(req, () => {}, { overpayOk: true }).then((r) => ({ made: r, text }), (e) => ({ e, why: (e && e.message) || String(e), text }));
  };
  return { payer, rx, L, pay };
}
const swaps = (c) => c.asked.filter((x) => x === 'POST /v1/swap').length;
/* A phone's own answer to "I am about to pay this", with nothing sent over the link. */
const askDirect = (c, intend) => {
  let out = null;
  const keep = c.W.tapTerms;
  c.W.tapTerms = (b) => { out = JSON.parse(b); return Promise.resolve('ok'); };
  c.W._tapQuote(JSON.stringify({ intend }));
  c.W.tapTerms = keep;
  return out;
};

async function run() {
  console.log('A. asking first');
  {
    const t = await pair();
    const r = await t.pay(100);
    await settle();
    const i10 = t.L.log.indexOf('M10'), i11 = t.L.log.indexOf('M11'), i5 = t.L.log.indexOf('M5');
    ok(!!r.made && r.made.confirmed === true && i10 >= 0 && i11 > i10 && i5 > i11,
       'the payer asks, the receiver says go, and only then is the payment made and sent', t.L.log.join(' '));
    // its token is still on the entry until it is known to be redeemed, and that is not a payment left in the air
    ok(!t.payer.W.crossingsWaiting() && !t.rx.W.crossingsWaiting() && !t.payer.W.atRisk().length,
       'and a payment that went through leaves nothing waiting on either phone');
    // the same request again: it was paid, so it is closed
    const before = await t.payer.W.balanceSats(), s0 = swaps(t.payer), rows0 = history(t.payer).length, m5 = t.L.log.filter((x) => x === 'M5').length;
    const again = await t.pay(100, { text: r.text });
    ok(!again.made && again.e && again.e.foxyAskedNo === true && !again.e.foxyToken && /no longer open/.test(again.why),
       'a request already paid: the answer is no, in the receiver’s own words', again.why);
    ok((await t.payer.W.balanceSats()) === before && swaps(t.payer) === s0 && history(t.payer).length === rows0
       && t.L.log.filter((x) => x === 'M5').length === m5 && !t.payer.W.atRisk().length,
       'and nothing was made, nothing sent, no entry written, nothing at risk', 'swaps ' + (swaps(t.payer) - s0) + ', entries ' + (history(t.payer).length - rows0));
  }
  {
    const t = await pair();
    const text = t.rx.W.paymentRequest(500, { purpose: 'receive' });
    const short = await t.pay(400, { text });
    ok(!short.made && short.e && short.e.foxyAskedNo && /400 sats; the request is for 500/.test(short.why), 'a payment that would be short is refused before it is made', short.why);
    const elsewhere = await t.payer.W.askFirst(Object.assign({}, t.payer.W.decodeRequest(text), { sats: 500 }), { mint: 'https://other.test', locked: true });
    ok(elsewhere.go === false && /takes that payment at m\.test/.test(elsewhere.why), 'and one that would be made at another mint', elsewhere.why);
  }
  {
    // both with no route: plain ecash would cross and be refused; asked first, nothing crosses
    const t = await pair();
    goOffline(t.payer); goOffline(t.rx);
    const before = await t.payer.W.balanceSats();
    const r = await t.pay(100);
    // the payer's own hand-over rules say so first, with nothing asked of anybody; the question is the second line of defence
    ok(!r.made && /offline/.test(r.why) && !(r.e && r.e.foxyToken) && !t.L.log.some((x) => x === 'M5') && (await t.payer.W.balanceSats()) === before && !t.payer.W.atRisk().length,
       'two phones with no route: refused before any ecash crosses, so none is at risk', r.why + ' | ' + (t.L.log.join(' ') || 'nothing crossed the link'));
    const direct = t.rx.W._tapQuote && (() => { let out = null; const keep = t.rx.W.tapTerms; t.rx.W.tapTerms = (b) => { out = JSON.parse(b); return Promise.resolve('ok'); };
      t.rx.W._tapQuote(JSON.stringify({ intend: { id: (t.payer.W.decodeRequest(t.rx.W.paymentRequest(50, { purpose: 'receive' })) || {}).id, sats: 50, mint: MINT, locked: false } })); t.rx.W.tapTerms = keep; return out; })();
    ok(!!direct && direct.go === false && /offline, so it can only take ecash locked to it/.test(direct.why), 'and asked all the same, an offline receiver says no to ecash that would not be locked', direct && direct.why);
  }
  {
    // an offline receiver and an online payer: the payer says it will lock, and the receiver says go
    const t = await pair();
    goOffline(t.rx);
    const r = await t.pay(100);
    await settle();
    ok(!!r.made && !!r.made.lockedTo && t.L.log.indexOf('M11') < t.L.log.indexOf('M5'), 'an offline receiver says go to a payment that will be locked to it', r.why || t.L.log.join(' '));
    const again = await t.pay(100, { text: r.text });
    ok(!again.made && again.e && again.e.foxyAskedNo && !again.e.foxyToken, 'and no to a second payment for the same request, before the payer has locked anything to it', again.why);
    ok(!history(t.payer).some((e) => e.highRisk), 'so no ecash is ever locked to a phone that then refuses it');
    /* And no where there is no key on file for the request. It went out with
     * no lock (the pool was empty), or its row has gone, so "locked" could only
     * mean locked to a key this phone has not got ready. Said before the payer
     * swaps: ecash locked to a phone that then refuses it is ecash the payer
     * can never take back. */
    const bare = t.payer.W.decodeRequest(t.rx.W.paymentRequest(60, { purpose: 'receive' }));
    const rows = JSON.parse(t.rx.storage.getItem('foxy.req.lockkeys') || '{}');
    delete rows[bare.id];
    t.rx.storage.setItem('foxy.req.lockkeys', JSON.stringify(rows));
    const none = askDirect(t.rx, { id: bare.id, sats: 60, mint: MINT, locked: true });
    ok(!!none && none.go === false && /no key on file/.test(none.why),
       'and no to a request it holds no key for, so nothing is locked to a key nobody has ready', none && none.why);
  }
  {
    const t = await pair();
    t.L.dropM10 = true;
    const before = await t.payer.W.balanceSats();
    const r = await t.pay(100);
    ok(!r.made && r.e && r.e.foxyAskedNo && r.e.foxySilent === true && (await t.payer.W.balanceSats()) === before && !t.L.log.some((x) => x === 'M5'),
       'no answer to the question is a no: nothing is made', r.why);
  }
  {
    const t = await pair();
    const r = await t.pay(100, { req: { asks: false } });
    await settle();
    ok(!!r.made && t.L.log.indexOf('M10') < 0, 'a receiver that does not say it answers is paid as before, with no question', t.L.log.join(' '));
  }

  console.log('\nB. a refund, not a word');
  const refusedWithGoodEcash = async (o) => {
    const t = await pair(o);
    goOffline(t.payer);                                     // plain pieces: nothing this payer makes is locked
    const first = await t.pay(128);
    await settle();
    const had = await t.payer.W.balanceSats(), rxHad = await t.rx.W.balanceSats();
    if (o && o.cut) t.L.cutAfterM6 = true;
    // a payment the receiver was already carrying home when this one came
    const other = (o && o.other) ? await t.rx.W.carryBegin({ from: MINT, to: MINT, net: 5, ask: 5 }) : '';
    if (o && o.rxOffline) goOffline(t.rx);
    // the same request again from a payer that does not ask first: the ecash crosses, and the request is closed
    const second = await t.pay(128, { text: first.text, req: Object.assign({ asks: false }, (o && o.req) || {}) });
    await settle(900);
    return { t, first, second, had, rxHad, other };
  };
  {
    const { t, first, second, had, rxHad } = await refusedWithGoodEcash();
    const said = t.rx.answers[t.rx.answers.length - 1] || {};
    ok(!!first.made && said.status === 422, 'the receiver refuses ecash it was handed for a request already paid', 'answered ' + said.status + ': ' + said.text);
    ok(!second.made && second.e && second.e.foxyRefused && second.e.foxyRefunded && !second.e.foxyAtRisk && t.L.log.indexOf('M7') > t.L.log.lastIndexOf('M6 422'),
       'and sends the whole of it back over the link, locked to the payer', second.why + ' | ' + t.L.log.join(' '));
    const back = second.e && second.e.foxyRefunded;
    ok(!!back && back.sats === back.paid && !back.short && (await t.payer.W.balanceSats()) === had && !t.payer.W.atRisk().length,
       'the payer has all of it again, and none of it is at risk', back ? 'paid ' + back.paid + ', back ' + back.sats + '; balance ' + (await t.payer.W.balanceSats()) + ' of ' + had : '');
    const row = history(t.payer).filter((e) => e.refunded)[0] || {};
    ok(row.refunded === true && row.state === 'success' && row.sats === 0 && row.changeState === 'came back',
       'its entry says refused and returned, and that it cost nothing', JSON.stringify({ sats: row.sats, state: row.state, memo: row.memo }));
    ok((await t.rx.W.balanceSats()) === rxHad && !t.rx.W.carryJobsOpen().length, 'the receiver is where it was, with nothing of the payment', (await t.rx.W.balanceSats()) + ' of ' + rxHad);
    // the entry was marked on its way while it was being delivered, and the refund is what finishes it
    const tags = t.payer.W.tagsFor(row.hash);
    ok(tags.refunded === true && !tags.refused && !tags.inflight && !tags.atRisk,
       'the entry is finished: not on its way, not refused, not at risk', JSON.stringify({ refunded: tags.refunded, refused: tags.refused, inflight: tags.inflight, atRisk: tags.atRisk }));
    ok(t.rx.due >= 1, 'and the receiver told the payer a refund was coming', 'told ' + t.rx.due + ' time(s)');
    // what the receiver saw is worth nothing now
    goOnline(t.payer);
    await t.payer.W.connect(MINT, null, null, { remember: true });
    await t.payer.W.claimUnclaimed();
    await settle();
    ok(t.payer.W.balanceAt(MINT) >= had - 0 && t.payer.W.unclaimedSats() === 0, 'and with a route the refund is the payer’s to spend', t.payer.W.balanceAt(MINT) + ' in the pile of ' + had);
  }
  {
    /* The refund is a job of its own on the receiver while it is made, and the
     * job goes when the refund is sent. Only that one: a payment this phone was
     * already carrying home is not the refusal's to forget. */
    const { t, second, other } = await refusedWithGoodEcash({ other: true });
    const jobs = t.rx.W.carryJobsOpen();
    ok(!!other && !!second.e && !!second.e.foxyRefunded && jobs.length === 1 && jobs[0].id === other,
       'a refund sent back leaves the receiver’s other payment to carry home where it was', jobs.length + ' job(s) left: ' + jobs.map((j) => j.state).join(', '));
  }
  {
    // at a mint that charges: the refund is short by the mint's fees and no more
    const { t, second, had } = await refusedWithGoodEcash({ feePpk: 150 });
    const back = second.e && second.e.foxyRefunded;
    ok(!!back && !back.short && back.paid - back.sats >= 1 && back.paid - back.sats <= 6 && had - (await t.payer.W.balanceSats()) <= 6,
       'at a mint that charges, what comes back is what was paid less the mint’s fees', back ? 'paid ' + back.paid + ', back ' + back.sats : second.why);
  }

  console.log('\nC. no refund in time');
  {
    // the link goes with the refusal: the refund cannot cross, and is a code on the receiver's screen
    const { t, second, had } = await refusedWithGoodEcash({ cut: true, refundWaitMs: 600 });
    ok(!second.made && second.e && second.e.foxyRefused && second.e.foxyAtRisk && !second.e.foxyRefunded,
       'with the link gone, the payer hears no and nothing back: its ecash is at risk', second.why);
    const flagged = t.payer.W.atRisk();
    ok(flagged.length === 1 && (await t.payer.W.balanceSats()) === had && t.payer.W.atRiskSats() === flagged[0].sats,
       'it is in the balance again, flagged', flagged.length + ' flagged, ' + t.payer.W.atRiskSats() + ' sats');
    const kept = t.payer.W.tagsFor(flagged[0].hash) || {};
    ok(!kept.token && !kept.kept, 'and its token text is gone from the entry: it would be a second way to the same pieces', JSON.stringify({ token: !!kept.token, kept: !!kept.kept }));
    await settle(900);
    ok(!!t.rx.stuck && t.rx.stuck.refund === true && !!t.rx.stuck.token, 'the receiver has made the refund all the same, and shows it as a code', t.rx.stuck ? 'a code for ' + t.rx.stuck.sats : 'no card');
    // the payer scans it, still with no route: locked to it, so it is kept, and the pieces it was made from stop counting
    const got = await t.payer.W.receiveToken(t.rx.stuck.token).then((r) => r, (e) => ({ why: e.message }));
    await settle();
    ok(got.kept === true && !t.payer.W.atRisk().length && t.payer.said.some((x) => x.state === 'refunded'),
       'scanned by the payer, it settles the payment: nothing is at risk any more', JSON.stringify(got).slice(0, 90) + ' | ' + JSON.stringify(t.payer.said.map((x) => x.state)));
    ok((await t.payer.W.balanceSats()) === had, 'and the balance counts the refund, not the pieces it replaced', (await t.payer.W.balanceSats()) + ' of ' + had);
    goOnline(t.payer);
    await t.payer.W.connect(MINT, null, null, { remember: true });
    await t.payer.W.claimUnclaimed();
    await settle(600);
    const pile = t.payer.W.balanceAt(MINT);
    ok(pile === had && t.payer.W.unclaimedSats() === 0, 'with a route, all of it is in the pile and the mint honours it', pile + ' of ' + had);
    await t.payer.W.reconcile();
    ok(t.payer.W.balanceAt(MINT) === pile, 'and none of what it shows is spent');
  }
  {
    /* A receiver with no route cannot swap the ecash it was handed, so it cannot
     * send it back, and it must not say it will: the payer would hold on for a
     * refund that is not coming instead of being told at once. */
    const { t, second, rxHad } = await refusedWithGoodEcash({ rxOffline: true, req: { theirRoute: true }, refundWaitMs: 600 });
    ok(!second.made && second.e && second.e.foxyRefused && second.e.foxyAtRisk && !second.e.foxyRefunded && t.payer.W.atRisk().length === 1,
       'a receiver with no route refuses ecash it was handed, and the payer has nothing back: it is at risk', second.why);
    ok(t.rx.due === 0 && (await t.rx.W.balanceSats()) === rxHad && !t.rx.W.carryJobsOpen().length && t.rx.W.unclaimedSats() === 0,
       'the receiver says no refund is coming and takes none of it in', 'told ' + t.rx.due + ' time(s), ' + t.rx.W.unclaimedSats() + ' sats waiting');
  }
  {
    /* The pieces cannot be flagged and put back in the wallet (the phone will
     * not write that list). They stay on the payment's entry with its token,
     * out of the balance, and that is a payment left waiting: the next
     * connection takes them back by itself. */
    const t = await pair({ refundWaitMs: 300 });
    t.L.liar = { why: 'No.' };
    const had = await t.payer.W.balanceSats();
    const proto = t.payer.window.Storage.prototype, real = proto.setItem;
    proto.setItem = function (k) { if (String(k) === 'foxy.cashu.atrisk') throw new Error('QuotaExceededError'); return real.apply(this, arguments); };
    const r = await t.pay(100, { req: { asks: false, lockTo: '' } });
    proto.setItem = real;
    await settle();
    const risk = r.e && r.e.foxyAtRisk, hash = r.e && r.e.foxyToken && r.e.foxyToken.hash;
    ok(!r.made && !!risk && risk.onEntry === true && !!hash && !!t.payer.W.tagsFor(hash).token && !t.payer.W.atRisk().length
       && (await t.payer.W.balanceSats()) === had - 100,
       'refused with nothing back and no room to flag it: the pieces stay on the entry, with their token, out of the balance', r.why + ' | ' + JSON.stringify(risk));
    ok(t.payer.W.crossingsWaiting() === true, 'and that is a payment left waiting');
    await t.payer.W.catchUpCrossings();
    await settle();
    const tags = t.payer.W.tagsFor(hash), row = history(t.payer).filter((e) => e.hash === hash)[0] || {};
    ok((await t.payer.W.balanceSats()) === had && tags.refused === false && tags.takenBack === true && row.takenBack === true && !t.payer.W.crossingsWaiting(),
       'the next connection takes them back whole, and the entry says taken back, no longer refused, and nothing is left waiting',
       (await t.payer.W.balanceSats()) + ' of ' + had + '; ' + JSON.stringify({ refused: tags.refused, takenBack: tags.takenBack, row: row.takenBack }));
    // back in the wallet is not at risk: the history reads this mark alone, and it stayed set
    ok(row.highRisk === false, 'and the entry no longer says HIGH RISK', JSON.stringify({ highRisk: row.highRisk }));
  }

  console.log('\nD. a payer with a route does not wait for its next connection');
  /* Plain ecash from a payer that is online: a request with no lock on it,
   * which no Foxy shows — so the phone on the other end is not one, or not an
   * honest one. Found driving the real app in the simulator: the
   * pieces sat flagged until the payer's next connection, on a phone that
   * was connected the whole time. */
  {
    const t = await pair({ refundWaitMs: 300 });
    t.L.liar = { why: 'No.' };
    const had = await t.payer.W.balanceSats(), before = swaps(t.payer);
    const feesOf = (c) => history(c).reduce((n, e) => n + (Number(e.feeSats) || 0) + (Number(e.topUpFee) || 0), 0) + c.W.topUpFeeSats();
    const inOf = (c) => history(c).filter((e) => e.dir === 'in').reduce((n, e) => n + (Number(e.sats) || 0), 0);
    const fees0 = feesOf(t.payer), in0 = inOf(t.payer);
    const r = await t.pay(100, { req: { asks: false, lockTo: '' } });
    await settle();
    const risk = r.e && r.e.foxyAtRisk;
    ok(!r.made && !!risk && risk.safe === true && !risk.taken && !t.payer.W.atRisk().length,
       'refused with nothing back, and a route: the pieces are swapped at once, and the payer is told they are safe', r.why + ' | ' + JSON.stringify(risk));
    const row = history(t.payer).filter((e) => /refused/.test(String(e.memo || '')))[0] || {};
    ok((await t.payer.W.balanceSats()) === had && swaps(t.payer) > before && row.highRisk === false && row.takenBack === true,
       'nothing was lost and the entry is not left saying HIGH RISK', (await t.payer.W.balanceSats()) + ' of ' + had + '; ' + JSON.stringify({ highRisk: row.highRisk, takenBack: row.takenBack }));
    /* The note of the payment goes once the pieces are safe: it is kept, emptied,
     * only for ones the other phone redeemed. */
    ok(!Object.keys(atRiskStore(t.payer)).length, 'and once they are safe nothing is kept of the payment: no note of ecash taken, since none was', JSON.stringify(atRiskStore(t.payer)));
    /* And the books say what it cost, which at this mint is nothing. The fee
     * for making the pieces safe is what went in less what came out; got
     * wrong, the whole payment is written as a fee on the entry before it. */
    ok(feesOf(t.payer) === fees0 && inOf(t.payer) === in0,
       'and making them safe is written as costing what it cost: nothing, at a mint that charges nothing',
       'fees ' + fees0 + ' -> ' + feesOf(t.payer) + ', received ' + in0 + ' -> ' + inOf(t.payer));
    const j = JSON.parse(t.L.lastBody);
    const seen = t.rx.window.CashuTS.getEncodedToken({ mint: j.mint, proofs: j.proofs, unit: 'sat' });
    const late = await t.rx.W.receiveToken(seen).then(() => 'took it', (e) => 'refused: ' + e.message);
    ok(/^refused/.test(late), 'and the copy the other phone saw is worth nothing', late.slice(0, 90));
    ok(!t.payer.said.length, 'said once, on the payment’s own screen, not again by the watcher', JSON.stringify(t.payer.said));
  }
  {
    // it says no and has already redeemed them: the payer hears that now, not at its next connection
    const t = await pair({ refundWaitMs: 300 });
    t.L.liar = { why: 'No.', steal: true };
    const had = await t.payer.W.balanceSats();
    const r = await t.pay(100, { req: { asks: false, lockTo: '' } });
    await settle();
    const risk = r.e && r.e.foxyAtRisk;
    const paid = had - (await t.payer.W.balanceSats());
    const row = () => history(t.payer).filter((e) => /refused|taken/.test(String(e.memo || '')))[0] || {};
    ok(!r.made && !!risk && risk.taken === true && !risk.safe && paid >= 100 && row().state === 'success' && row().taken === true,
       'refused in words and redeemed all the same: the payer is told the payment was taken, and its entry says paid',
       r.why + ' | stole ' + t.L.stole + ', payer down ' + paid + ' | ' + JSON.stringify(risk));
    ok(!t.payer.W.atRisk().length && !t.payer.W.crossingsWaiting(), 'nothing is left flagged or waiting', JSON.stringify(t.payer.W.atRisk()));
    /* Redeemed is not always stolen: a receiver that means to send it back
     * swaps those very pieces to make the refund. It comes late, as a code,
     * locked to the payer's key for that payment — and is still known for
     * what it is. */
    const j = JSON.parse(t.L.lastBody);
    const refund = await t.rx.W.sendToken(paid, { unit: 'sat', lockTo: j.changeTo });
    const got = await t.payer.W.receiveToken(refund.token).then((x) => x, (e) => ({ why: e.message }));
    await settle();
    ok(!got.why && (await t.payer.W.balanceSats()) === had && row().refunded === true && row().taken === false
       && t.payer.said.some((x) => x.state === 'refunded'),
       'a refund that comes after all, as a code, is taken as the refund: the entry stops saying taken', JSON.stringify(got).slice(0, 80) + ' | ' + JSON.stringify({ refunded: row().refunded, taken: row().taken, memo: row().memo }));
  }
  {
    /* Redeemed after the refusal is kept as a note, emptied, for thirty days: a
     * refund that comes later is known for one only by that note. The next
     * connection must not clear it away as it clears the notes of pieces that
     * were spent here. */
    const t = await pair({ refundWaitMs: 300 });
    t.L.liar = { why: 'No.', steal: true };
    const had = await t.payer.W.balanceSats();
    await t.pay(100, { req: { asks: false, lockTo: '' } });
    await settle();
    const paid = had - (await t.payer.W.balanceSats());
    const row = () => history(t.payer).filter((e) => /refused|taken/.test(String(e.memo || '')))[0] || {};
    const hash = row().hash, note = () => atRiskStore(t.payer)[hash] || {};
    ok(!!hash && note().taken === true && note().sats === paid && !(note().secrets || []).length && !t.payer.W.tagsFor(hash).atRisk,
       'all of it redeemed: what is kept is a note of the payment with no pieces in it, and the entry is not marked at risk',
       JSON.stringify(note()) + ' | atRisk ' + t.payer.W.tagsFor(hash).atRisk);
    await t.payer.W.settleAtRisk();
    await settle();
    ok(note().taken === true && note().sats === paid, 'and the next connection leaves the note alone', JSON.stringify(atRiskStore(t.payer)));
    const j = JSON.parse(t.L.lastBody);
    const refund = await t.rx.W.sendToken(paid, { unit: 'sat', lockTo: j.changeTo });
    const got = await t.payer.W.receiveToken(refund.token).then((x) => x, (e) => ({ why: e.message }));
    await settle();
    ok(!got.why && (await t.payer.W.balanceSats()) === had && row().refunded === true && row().taken === false,
       'so a refund that comes after that is still taken as the refund: the entry stops saying taken',
       JSON.stringify(got).slice(0, 80) + ' | ' + JSON.stringify({ refunded: row().refunded, taken: row().taken }));
    ok(t.payer.said.some((x) => x.state === 'refunded' && x.hash === hash && x.sats === paid),
       'and the payer is told how much of it came back', JSON.stringify(t.payer.said));
  }

  console.log(failed ? '\n' + failed + ' counter-refusal check(s) failed' : '\nall counter-refusal checks pass');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
