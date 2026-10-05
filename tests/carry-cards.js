'use strict';
/* carry-cards.js — what the app says and does about money between two mints.
 *
 *     node tests/carry-cards.js
 *
 * The wallet's half is in tests/crossings.js. This is the app's: the methods
 * are lifted out of the built app, as tap-settle.js lifts its own, and run
 * against a wallet that answers what each case scripts. What is checked is
 * which card goes up and which wallet call is made, because every one of
 * these used to say something untrue at the moment it mattered: "nothing was
 * sent" after the sats had left, PAID while the payment sat at a mint the
 * receiver never chose, "still yours" for ecash only the other phone can
 * spend.
 */
const fs = require('fs');
const path = require('path');

let failed = 0;
const ok = (good, what, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + what + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0)); };

const SRC = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const at = SRC.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = SRC.indexOf('{', at + sig.length - 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(at + 3, j + 1);
}
const HOME = 'https://home.test', THEIR = 'https://their.test';

/* An app with the lifted methods and everything around them recorded. */
function app(W) {
  const window = { FoxyWallet: W };
  const lifted = new Function('window', 'return {'
    + ['carryHomeNow() {', 'carryOutcome(r, ctx) {', 'crossFailed(e, mine) {', 'hushMove(plan) {',
       'tapPayFromThere(offer, want, theirs, mine, there) {'].map(method).join(',\n') + '};')(window);
  const a = Object.assign({
    cards: [], said: [], melts: [], state: {}, quoted: [], paidNow: 0, toasts: [],
    showMelt(t) { this.melts.push(t); }, hideMelt() {}, syncTap() {}, refreshBalance() {}, loadHistory() {},
    hushSweepEntries() { return Promise.resolve(); }, noteReceived() {}, dismissCard() {}, goSwitchMint() {},
    announcePayment(ev) { this.said.push(ev); }, saySatsLeftAt(n, at) { this.cards.push({ kind: 'leftBehind', title: 'SATS LEFT', n }); },
    blockedCard(kind, o) { this.cards.push(Object.assign({ kind }, o)); },
    mintNameOf(u) { return u === HOME ? 'Home' : u === THEIR ? 'Theirs' : ''; },
    group(n) { return String(n); }, setState(s) { Object.assign(this.state, typeof s === 'function' ? s(this.state) : s); },
    back() { this.wentBack = true; }, toast(t) { this.toasts.push(t); },
    crossMintCard(plan) { this.asked = plan; return Promise.resolve(this.answer !== false); },
    makeTokenForRequest() { this.paidNow += 1; }, tapCrossQuote() { this.quoted.push(Array.from(arguments)); },
  }, lifted);
  return a;
}
const wallet = (o) => Object.assign({
  mintUrl: THEIR, calls: [],
  balanceAt() { return 0; }, transactions() { return Promise.resolve([]); },
  reason(e) { return String((e && e.message) || e); },
}, o || {});
const terms = { from: THEIR, to: HOME, net: 300, ask: 310, plan: { mintQuote: { quote: 'q1' }, meltQuote: { quote: 'm1' } } };
const job = { id: 'c1', home: HOME, from: THEIR, net: 300, ask: 310, payerKey: '02' + 'ab'.repeat(32) };

async function carryCase(result) {
  const W = wallet({
    carryHome(id, plan, stage, opts) { this.calls.push(['carryHome', id, !!plan, opts || null]); return Promise.resolve(result); },
    carryRefund(id) { this.calls.push(['carryRefund', id]); return Promise.resolve({ state: 'refunded', handed: false, job }); },
  });
  const a = app(W);
  a._carryHome = { back: HOME, terms, id: 'c1' };
  await a.carryHomeNow();
  await settle();
  return { a, W, card: a.cards[a.cards.length - 1] || null };
}

async function run() {
  // ---- a payment being brought home: one card for each ending ---------------
  {
    const t = await carryCase({ state: 'home', sats: 300, quote: 'q1', done: { sats: 300, leftBehind: 0, from: THEIR }, job });
    ok(t.W.calls[0][0] === 'carryHome' && t.W.calls[0][1] === 'c1' && t.W.calls[0][2] === true, 'the walk home is the wallet’s, by the job’s id, on the way home that was quoted');
    ok(t.a.said.length === 1 && t.a.said[0].sats === 300 && t.a.said[0].dir === 'in' && !t.card, 'landed: PAYMENT RECEIVED is said once, for what landed, and no card');
    ok(t.a._carryingHome === false && t.a._quiet === false, 'and the screen is back on the air');
  }
  {
    const t = await carryCase({ state: 'moving', why: 'x', job });
    ok(t.card && t.card.title === 'ON ITS WAY TO YOUR MINT' && !t.a.said.length && /not received until/i.test(t.card.chip),
       'paid and not yet claimed at home: on its way, and not announced as received', t.card && t.card.title);
  }
  {
    const t = await carryCase({ state: 'retry', why: 'The Internet connection appears to be offline.', job });
    ok(t.card && t.card.title === 'NOT HOME YET' && t.card.retry === 'TRY AGAIN' && t.card.shut && t.card.shut.label === 'SEND IT BACK' && !t.a.said.length,
       'a mint not reached: not home yet, with TRY AGAIN and SEND IT BACK', t.card && t.card.title);
    t.card.shut.tap();
    await settle();
    ok(t.W.calls.some((c) => c[0] === 'carryRefund' && c[1] === 'c1'), 'SEND IT BACK asks the wallet for the refund');
  }
  {
    const t = await carryCase({ state: 'short', lands: 290, net: 300, job });
    ok(t.card && t.card.title === 'IT COSTS MORE TO BRING HOME' && /290/.test(t.card.retry) && /290 sats would arrive, not 300/.test(t.card.reason),
       'the way home costs more than was paid for: the person is asked, with both figures', t.card && t.card.reason);
    t.card.go();
    await settle();
    const again = t.W.calls.filter((c) => c[0] === 'carryHome')[1];
    ok(!!again && again[2] === false && again[3] && again[3].less === true, 'BRING IT HOME says yes to what fits, on a fresh quote');
  }
  {
    const t = await carryCase({ state: 'refunded', handed: true, why: 'This mint will not do that.', job });
    ok(t.card && t.card.title === 'NOT RECEIVED' && !t.a.said.length, 'sent back over the link: NOT RECEIVED, and nothing announced as received', t.card && t.card.title);
    const u = await carryCase({ state: 'refunded', handed: false, job });
    ok(!u.card && !u.a.said.length, 'sent back as a code: the code card is the wallet’s to raise, and this adds no second one');
  }
  {
    const t = await carryCase({ state: 'stuck', why: 'no key', job });
    ok(t.card && t.card.title === 'PAID, STILL AT THEIR MINT' && t.card.retry === 'MOVE IT', 'neither home nor sent back: said as it is, with the mint screen offered');
    const b = await carryCase({ state: 'busy', job });
    ok(!b.card && !b.a.said.length, 'a walk the wallet is already on raises nothing here');
  }

  // ---- a crossing that failed: what is true of the money --------------------
  {
    const W = wallet({ mintUrl: HOME, connect() { return Promise.resolve(); } });
    const a = app(W);
    a.crossFailed(Object.assign(new Error('Quote not paid'), { movePaid: true, moveTo: THEIR, moveSats: 506 }), HOME);
    const c = a.cards[0];
    ok(c.title === 'YOUR SATS ARE ON THEIR WAY' && /506 sats/.test(c.chip) && !/Nothing was sent/.test(c.chip + c.reason) && /not been paid/.test(c.reason),
       'the move was paid and not claimed: the card says the sats left and nobody has been paid', c.title);
    const b = app(W);
    b.crossFailed(Object.assign(new Error('may still be going through'), { pending: true, moveTo: THEIR }), HOME);
    ok(b.cards[0].title === 'THE MOVE MAY STILL GO THROUGH', 'a melt with no answer: said as held, not as failed');
    const n = app(W);
    n.crossFailed(new Error('The Internet connection appears to be offline.'), HOME);
    ok(n.cards[0].title === 'COULD NOT REACH THEIR MINT' && /Nothing was sent/.test(n.cards[0].chip), 'nothing left: the card it always was');
  }

  // ---- sats already at their mint pay the request ---------------------------
  {
    const seen = [];
    const W = wallet({ mintUrl: HOME,
      connect(u, a, b, opts) { seen.push([u, opts && opts.remember]); this.mintUrl = u; return Promise.resolve(); },
      sendShortfall() { return { short: false }; }, decodeRequest() { return { id: 'r1', sats: 500 }; } });
    const a = app(W);
    a.tapPayFromThere({ req: 'creqA', theirRoute: false }, 500, THEIR, HOME, 506);
    await settle();
    ok(a.asked && a.asked.net === 500 && a.asked.feeSats === 0, 'the confirmation shows the amount and no fee');
    ok(seen.length === 1 && seen[0][0] === THEIR && seen[0][1] === false, 'their mint is a visit, not saved as this phone’s own', JSON.stringify(seen));
    ok(a.paidNow === 1 && a._crossCameFrom === HOME && a.state.req && a.state.req.viaTap === true && a.state.req.theirRoute === false && !a.quoted.length,
       'and the request is paid from there, with home to come back to and no move quoted');
  }
  {
    const seen = [];
    const W = wallet({ mintUrl: HOME,
      connect(u, a, b, opts) { seen.push(u); this.mintUrl = u; return Promise.resolve(); },
      sendShortfall() { return { short: true }; }, decodeRequest() { return { id: 'r1' }; } });
    const a = app(W);
    a.tapPayFromThere({ req: 'creqA' }, 500, THEIR, HOME, 500);
    await settle();
    ok(a.paidNow === 0 && seen[seen.length - 1] === HOME && a.quoted.length === 1, 'not enough there once its fee is counted: home again, and the ordinary crossing is quoted');
    const c = app(wallet({ mintUrl: HOME, connect() { throw new Error('must not connect'); } }));
    c.answer = false;
    c.tapPayFromThere({ req: 'creqA' }, 500, THEIR, HOME, 600);
    await settle();
    ok(c.paidNow === 0 && !c.cards.length, 'CANCEL does nothing at all');
  }

  // ---- an online receiver at another mint, and its invoice a few seconds behind its offer ----
  {
    const rail = (o) => {
      let heard = null;
      const W = wallet({ mintUrl: HOME, onTapTerms(fn) { heard = fn; }, stuckAtMint() { return o.stuck || null; } });
      const lifted = new Function('window', 'return {' + [method('tapPayOffer(offer, sats) {'), method('tapAwaitInvoice(offer, sats) {')].join(',\n') + '};')({ FoxyWallet: W });
      const a = Object.assign({
        paidInvoice: '', crossed: 0, stuckAsked: 0, wrong: 0, opened: 0, waits: [], state: {}, gone: [],
        offlineNow() { return !!o.offline; }, setState(x) { Object.assign(this.state, x); }, group(n) { return String(n); },
        acceptTarget(inv) { this.paidInvoice = inv; return true; }, tapCrossMint() { this.crossed += 1; },
        tapStuckAtMint() { this.stuckAsked += 1; }, tapWrongMint() { this.wrong += 1; }, openRequest() { this.opened += 1; },
        tapAgreeTheirPrice() {}, waitingScreen(kind) { this.waits.push(kind); }, dismissCard() {}, hideStage() {}, tapGaveNothing(w) { this.gone.push(w); }, back() {},
      }, lifted);
      a.say = (text) => heard && heard(text);
      a.listening = () => typeof heard === 'function';
      return a;
    };
    const offer = { inv: '', req: 'creqA', sameMint: false, crossable: true, theirRoute: true, read: { id: 'r', sats: 500 }, mints: [THEIR] };
    const a = rail({});
    a.tapPayOffer(offer, 500);
    ok(a.waits[0] === 'invWait' && a.crossed === 0 && a.listening(), 'no invoice from a receiver that says it is online: the payer waits for it, and moves nothing');
    a.say(JSON.stringify({ inv: 'lnbc5u1pfoxytestinvoice' }));
    await settle();
    ok(a.paidInvoice === 'lnbc5u1pfoxytestinvoice' && a.crossed === 0, 'the invoice arrives on the link, and that is what is paid: one Lightning payment, no move', a.paidInvoice || 'not paid');
    const b = rail({});
    b.tapPayOffer(offer, 500);
    b.say(JSON.stringify({ inv: 'not an invoice' }));
    await new Promise((r) => setTimeout(r, 5200));
    ok(b.crossed === 1 && !b.paidInvoice, 'none in five seconds, or something that is not one: the move to their mint, as before');
    const c = rail({});
    c.tapPayOffer(Object.assign({}, offer, { theirRoute: false }), 500);
    ok(c.crossed === 1 && !c.waits.length, 'a receiver with no route will never make one: no wait');
    const d = rail({ offline: true, stuck: { mint: HOME, have: 900 } });
    d.tapPayOffer(offer, 500);
    ok(d.stuckAsked === 1 && !d.waits.length && d.crossed === 0, 'a payer with no route cannot pay an invoice: no wait, and it asks them to carry it home');
    const e = rail({});
    e.tapPayOffer(Object.assign({}, offer, { inv: 'lnbc5u1pready' }), 500);
    ok(e.paidInvoice === 'lnbc5u1pready' && !e.waits.length, 'an offer that came with its invoice is paid at once');
  }

  console.log(failed ? '\n' + failed + ' carry-card check(s) failed' : '\nall carry-card checks pass');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
