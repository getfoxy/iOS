'use strict';
/* price-age.js — how old a bitcoin price may be before Foxy stops working
 * an amount out from it.
 *
 *     node tests/price-age.js
 *
 * Offline, a phone turns dollars into sats with the last price it saw, and
 * that price can be days old. A day is the limit (`PRICE_TOO_OLD_MS`): past
 * it the payer offers no quote, and the receiver reads a quote that says it
 * is older, or will not say, as too old. The receiver's own price past a day
 * is no yardstick: there is no comparison, so nothing is agreed by itself.
 *
 * The wallet's half, on a real page (loadReal): the rule (`priceTooOld`), the
 * payer's quote (`quoteFor`), including for a request in dollar ecash that
 * a dollars wallet will take sats for, and the receiver's reading of it
 * (`readQuote`).
 *
 * And the screens' half (cases 4 to 8): the app's own methods, lifted out of
 * build/foxy-app.js and run against those real wallets, with a stand-in for
 * the rest of the app. The payer refuses to offer from a price a day old and
 * says how old; the receiver refuses a quote that old, and shows the ages
 * of both prices where they are more than three minutes; a fresh price says
 * nothing; this phone's own price a day old is no comparison, so the person
 * is asked; and the confirmation of an agreed request says what it is for at
 * whose price. */
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
const method = (sig) => {
  const at = appSrc.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = appSrc.indexOf('{', at + sig.length - 1), depth = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appSrc.slice(at + 3, i + 1);
};
// the methods, with the page-level names they read
const lift = (W, sigs) => new Function('window', 'PRICE_STANDS_MS', 'return {' + sigs.map(method).join(',\n') + '}')(
  { FoxyWallet: W }, 3 * 60 * 1000);
const COMMON = ['agoWords(ms) {', 'priceAgeWords(ms) {', 'cfRow(label, value, opt) {', 'group(n) {', 'usd(v) {',
  'unitFigure(amount, unit) {'];

const MINT = 'https://m.test';
const HOUR = 3600 * 1000;
let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};

function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, { units: ['sat', 'usd'], p2pk: true }); },
  });
  ctx.mint = mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}

async function run() {
  const rx = page({});
  await rx.W.connect(MINT, null, null, { remember: true });
  const payer = page({ sharedMint: rx.mint, words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
  await payer.W.connect(MINT, null, null, { remember: true });
  const W = payer.W;

  // ---- 1. the rule ------------------------------------------------------------------------
  ok(W.PRICE_TOO_OLD_MS === 24 * HOUR, 'a day is the limit', String(W.PRICE_TOO_OLD_MS));
  ok(W.priceTooOld(null, 23 * HOUR) === false, 'their price 23 hours old: not too old');
  ok(W.priceTooOld(null, 25 * HOUR) === true, 'their price 25 hours old: too old');
  ok(W.priceTooOld(null, 0) === false, 'their price just seen: not too old');
  ok(W.priceTooOld(null, null) === true && W.priceTooOld(null, undefined) === true,
    'an age they did not say is too old');
  ok(W.priceTooOld(null, NaN) === true && W.priceTooOld(null, -1) === true && W.priceTooOld(null, '5') === true
    && W.priceTooOld(null, Infinity) === true, 'an age that is not a number of milliseconds is too old');
  ok(W.priceTooOld(Date.now() + 10 * 60000) === true, 'this phone’s own price seen ten minutes in the future: too old');
  ok(W.priceTooOld(Date.now() + 60000) === false, 'a minute in the future is a clock a little out, and stands');
  ok(W.priceTooOld(Date.now() - 60000) === false, 'seen a minute ago: not too old');
  ok(W.priceTooOld(Date.now() - 25 * HOUR) === true && W.priceTooOld(Date.now() - 23 * HOUR) === false,
    'this phone’s own price: 25 hours is too old, 23 is not');
  ok(W.priceTooOld(0) === true && W.priceTooOld('soon') === true, 'never seen is too old');

  // ---- 2. the payer's quote ---------------------------------------------------------------
  const asks = { id: 'r1', usd: 500, sats: 0 };
  W._rate = 100000; W._rateAt = Date.now() - 25 * HOUR;
  ok(W.quoteFor(asks) === null, 'a payer whose price is 25 hours old offers no quote');
  W._rateAt = Date.now() + 10 * 60000;
  ok(W.quoteFor(asks) === null, 'nor one whose price is dated ten minutes ahead');
  W._rateAt = Date.now() - 2 * HOUR;
  let q = W.quoteFor(asks);
  ok(q && q.sats === 5000 && q.usd === 500 && Math.abs(q.ageMs - 2 * HOUR) < 2000 && !('forUnit' in q),
    'two hours old: a quote, with how old the price is, and no forUnit for a request asking in dollars', JSON.stringify(q));
  // a request in dollar ecash, from a dollars wallet that takes sats for it
  const usdText = rx.W.paymentRequest(500, { unit: 'usd' });
  const usdReq = W.decodeRequest(usdText) || {};
  ok(usdReq.unit === 'usd' && usdReq.amount === 500 && usdReq.usd === 0, 'a request in dollar ecash for $ 5.00', JSON.stringify(usdReq));
  q = W.quoteFor(usdReq);
  ok(q && q.usd === usdReq.amount && q.forUnit === 'usd' && q.sats === 5000 && q.id === usdReq.id && q.rate === 100000,
    'it is quoted at its amount in cents, marked forUnit usd', JSON.stringify(q));
  W._rateAt = Date.now() - 25 * HOUR;
  ok(W.quoteFor(usdReq) === null, 'and not at all from a price 25 hours old');
  W._rateAt = Date.now();
  const satReq = W.decodeRequest(rx.W.paymentRequest(2100, { unit: 'sat' })) || {};
  ok(W.quoteFor(satReq) === null && W.quoteFor(null) === null, 'a request in sats has nothing to quote');
  W._rate = null; W._rateAt = 0;
  ok(W.quoteFor(usdReq) === null, 'no price at all: no quote');

  // ---- 3. the receiver's reading ----------------------------------------------------------
  rx.W._rate = 100000; rx.W._rateAt = Date.now() - 60000;
  const fresh = { id: 'r1', usd: 500, rate: 102000, sats: 4902, at: 1, ageMs: 2 * HOUR };
  let seen = rx.W.readQuote(JSON.stringify(fresh));
  ok(seen && seen.theirAgeMs === 2 * HOUR && Math.abs(seen.theirSeenAt - (Date.now() - 2 * HOUR)) < 2000,
    'their age is kept, and when that was on this phone’s clock', JSON.stringify(seen));
  ok(seen.tooOld === false && seen.myTooOld === false && Math.abs(seen.differsPct - 2) < 0.01 && seen.forUnit === '',
    'two hours: not too old, compared with this phone’s price as before', JSON.stringify(seen));
  // their `at` is not read: only the age they said
  seen = rx.W.readQuote(JSON.stringify(Object.assign({}, fresh, { at: Date.now(), ageMs: 25 * HOUR })));
  ok(seen.tooOld === true && seen.theirAgeMs === 25 * HOUR, 'an age of 25 hours is too old, whatever its time says');
  const noAge = Object.assign({}, fresh);
  delete noAge.ageMs;
  seen = rx.W.readQuote(JSON.stringify(noAge));
  ok(seen && seen.tooOld === true && seen.theirAgeMs === null && seen.theirSeenAt === null,
    'a quote that does not say how old its price is: too old', JSON.stringify(seen));
  seen = rx.W.readQuote(JSON.stringify(Object.assign({}, fresh, { ageMs: -5 })));
  ok(seen.tooOld === true && seen.theirAgeMs === null, 'a negative age is no age');
  seen = rx.W.readQuote(JSON.stringify(Object.assign({}, fresh, { forUnit: 'usd' })));
  ok(seen.forUnit === 'usd', 'which question it answers is read: forUnit usd');
  seen = rx.W.readQuote(JSON.stringify(Object.assign({}, fresh, { forUnit: 'eur' })));
  ok(seen.forUnit === '', 'and nothing else is');
  // this phone's own price a day and more old: no comparison, so nothing agrees by itself
  rx.W._rateAt = Date.now() - 25 * HOUR;
  seen = rx.W.readQuote(JSON.stringify(fresh));
  ok(seen.myTooOld === true && seen.differsPct === null && seen.tooOld === false && seen.myRate === 100000
    && seen.myRateAgeMs > 24 * HOUR, 'own price 25 hours old: differsPct null, and not refused for it', JSON.stringify(seen));
  rx.W._rate = null; rx.W._rateAt = 0;
  seen = rx.W.readQuote(JSON.stringify(fresh));
  ok(seen.myTooOld === false && seen.differsPct === null, 'no price of its own: no comparison, as before', JSON.stringify(seen));

  // ---- the screens: the stand-in app around the lifted methods ----------------------------
  const app = (Wx, sigs, extra) => {
    const a = Object.assign(lift(Wx, COMMON.concat(sigs)), {
      state: { screen: 'home', stack: [] }, cards: [], toasts: [], gave: [], paid: [], backs: 0,
      setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
      blockedCard(kind, c) { this.cards.push(Object.assign({ kind }, c)); },
      toast(t) { this.toasts.push(t); }, back() { this.backs += 1; },
      tapGaveNothing(w) { this.gave.push(w); }, tapPreQuoteMint() {}, waitingScreen(kind, o) { this.waiting = o; },
      dismissCard() {}, hideStage() {}, waitingForPayer() {}, tapTalking(on) { this.talking = on; },
      tapPayOffer(o, sats) { this.paid.push({ o, sats }); },
      priceAgo: () => '', twoUnitsOn: () => true, walletChoiceNow: () => ({ hold: 'dollars', recv: 'usd', send: 'usd' }),
    }, extra || {});
    return a;
  };
  const row = (spec, label) => (spec.rows.find((r) => r.label === label) || null);
  const labels = (spec) => spec.rows.map((r) => r.label);

  // ---- 4. the payer, its price 25 hours old ------------------------------------------------
  {
    const said = [];
    W.tapQuote = (t) => { said.push(JSON.parse(t)); return Promise.resolve('ok'); };
    W._rate = 100000; W._rateAt = Date.now() - 25 * HOUR;
    const satBefore = W.balanceOf('sat');
    const a = app(W, ['tapQuoteTheirDollars(offer) {']);
    a.tapQuoteTheirDollars({ read: usdReq, theirRoute: false, mints: [MINT], sameMint: true });
    const c = a.cards[0] || {};
    ok(c.kind === 'priceTooOld' && c.title === 'BITCOIN PRICE TOO OLD'
      && c.reason === 'This phone last saw the Bitcoin price 1 day ago. That is too old to work out what they asked for.'
      && c.chip === 'Nothing was sent. Get online once and Foxy has a new price.',
      'payer, 25 hours: BITCOIN PRICE TOO OLD, with the age', JSON.stringify(c));
    ok(said.length === 1 && Object.keys(said[0]).join() === 'gaveUp' && said[0].gaveUp === 'The payer\u2019s Bitcoin price is too old to use.',
      'M10 carries only that it gave up, and no price', JSON.stringify(said));
    ok(!a.paid.length && a.gave.length === 1 && a.backs === 1 && W.balanceOf('sat') === satBefore && !a.state.tapQuoteWait,
      'nothing paid, nothing waited on, the tap let go', JSON.stringify({ paid: a.paid.length, gave: a.gave }));
    // a price stamped well ahead of this phone's clock: the clock is wrong, and the card says so rather than "a moment ago"
    W._rateAt = Date.now() + 10 * 60000;
    const k = app(W, ['tapQuoteTheirDollars(offer) {']);
    k.tapQuoteTheirDollars({ read: usdReq, theirRoute: false, mints: [MINT], sameMint: true });
    ok((k.cards[0] || {}).reason === 'This phone\u2019s clock and its Bitcoin price do not agree.'
      && (k.cards[0] || {}).chip === 'Nothing was sent. Get online once and Foxy has a new price.' && !k.paid.length,
      'payer, a price ten minutes in the future: refused, with its clock named', JSON.stringify(k.cards[0]));
    said.length = 0;
    // a 2-hour price is offered, and the waiting screen says how old it is
    said.length = 0;
    W._rateAt = Date.now() - 2 * HOUR;
    const b = app(W, ['tapQuoteTheirDollars(offer) {']);
    b.tapQuoteTheirDollars({ read: usdReq, theirRoute: true, mints: [MINT], sameMint: true });
    clearTimeout(b._tapQuoteT);
    ok(said.length === 1 && said[0].forUnit === 'usd' && said[0].sats === 5000 && Math.abs(said[0].ageMs - 2 * HOUR) < 2000,
      'two hours: the price is offered, with its age', JSON.stringify(said));
    ok(b.waiting && b.waiting.body === 'They asked for dollars, and must agree to this phone\u2019s Bitcoin price before continuing. This phone saw it 2 hours ago.',
      'and the waiting screen says whose price and how old', b.waiting && b.waiting.body);
    said.length = 0;
    W._rateAt = Date.now() - 30000;
    const f = app(W, ['tapQuoteTheirDollars(offer) {']);
    f.tapQuoteTheirDollars({ read: usdReq, theirRoute: false, mints: [MINT], sameMint: true });
    clearTimeout(f._tapQuoteT);
    ok(f.waiting && f.waiting.body === 'This receiver is offline and must agree to the current Bitcoin price before continuing.',
      'a fresh price, to an offline receiver: the words as they were', f.waiting && f.waiting.body);
    // an older receiver says nothing of its route, and only an offline one asks this way: the words as they were
    const o = app(W, ['tapQuoteTheirDollars(offer) {']);
    o.tapQuoteTheirDollars({ read: usdReq, theirRoute: null, mints: [MINT], sameMint: true });
    clearTimeout(o._tapQuoteT);
    ok(o.waiting && o.waiting.body === 'This receiver is offline and must agree to the current Bitcoin price before continuing.',
      'a receiver that does not say whether it is online: the words as they were', o.waiting && o.waiting.body);
    if (W.onTapTerms) W.onTapTerms(null);
  }

  // ---- 5. the receiver, offered a quote 25 hours old, and one 2 hours old ---------------------
  const rxApp = (extra) => {
    const terms = [];
    rx.W.tapTerms = (t) => { terms.push(JSON.parse(t)); return Promise.resolve('ok'); };
    const a = app(rx.W, ['tapPriceOffered(text) {', 'priceSpec() {', 'priceTermsCard(q) {', 'priceAnswer(yes) {'], Object.assign({
      _tapOffer: JSON.stringify({ v: 2, req: usdText, up: false, ask: 1, sats4usd: 1 }),
      made: [],
      railRequestReady(n) { this.made.push(n); return Promise.resolve(rx.W.paymentRequest(n, { unit: 'sat' })); },
    }, extra || {}));
    a.terms = terms;
    return a;
  };
  {
    rx.W._rate = 100000; rx.W._rateAt = Date.now() - 60000;
    const a = rxApp();
    a.tapPriceOffered(JSON.stringify(Object.assign({}, fresh, { id: usdReq.id, usd: 500, sats: 4902, ageMs: 25 * HOUR, forUnit: 'usd' })));
    const c = a.cards[0] || {};
    ok(a.terms.length === 1 && a.terms[0].no === true && a.terms[0].why === 'Their Bitcoin price is too old.',
      'receiver, their price 25 hours old: no, with why', JSON.stringify(a.terms));
    ok(c.kind === 'priceTooOld' && c.title === 'BITCOIN PRICE TOO OLD'
      && c.reason === 'The payer\u2019s phone last saw the Bitcoin price 1 day ago. Foxy does not take a payment worked out from a price that old.'
      && c.chip === 'Nothing was paid. Either of you can get online for a new price.',
      'and its card says how old', JSON.stringify(c));
    ok(!a.made.length && a.state.screen === 'home' && a._payerGaveUp === true, 'no request is made, and nothing is asked', JSON.stringify(a.made));
    const n = rxApp();
    const noAge = Object.assign({}, fresh, { id: usdReq.id, usd: 500, sats: 4902, forUnit: 'usd' });
    delete noAge.ageMs;
    n.tapPriceOffered(JSON.stringify(noAge));
    ok((n.cards[0] || {}).reason === 'The payer\u2019s phone last saw the Bitcoin price at a time it did not say. Foxy does not take a payment worked out from a price that old.'
      && n.terms[0].no === true, 'a quote that will not say its age is refused the same way', JSON.stringify(n.cards[0]));

    const t = rxApp();
    t.tapPriceOffered(JSON.stringify(Object.assign({}, fresh, { id: usdReq.id, usd: 500, sats: 4902, ageMs: 2 * HOUR, forUnit: 'usd' })));
    await new Promise((r) => setTimeout(r, 5));
    ok(t.state.screen === 'priceConfirm' && !t.terms.length && !t.cards.length, 'two hours: the person is asked', t.state.screen);
    const spec = t.priceSpec();
    ok(row(spec, 'THEIR PRICE SEEN') && row(spec, 'THEIR PRICE SEEN').value === '2 HOURS AGO' && spec.amountLabel === 'THEIR BITCOIN PRICE',
      'priceConfirm: THEIR PRICE SEEN 2 HOURS AGO, under THEIR BITCOIN PRICE', JSON.stringify(labels(spec)) + ' ' + spec.amountLabel);
    ok(row(spec, 'YOU ASKED FOR').value === '$ 5.00' && row(spec, 'THEN').value === 'Foxy swaps it into dollars at the mint as soon as you are online.'
      && !row(spec, 'YOUR PRICE SEEN'), 'for a dollar request: what was asked, and what happens after; this phone’s price is fresh, so no age',
      JSON.stringify(labels(spec)));
    t.priceAnswer(true);
    await new Promise((r) => setTimeout(r, 20));
    const open = JSON.parse(rx.storage.getItem('foxy.req.open') || '{}');
    const agreed = t.terms[0] && t.terms[0].req ? rx.W.decodeRequest(t.terms[0].req) : null;
    const kept = agreed && open[agreed.id] && open[agreed.id].terms;
    ok(!!agreed && agreed.sats === 4902 && agreed.unit === 'sat', 'yes: a request in sats for what was offered', JSON.stringify(t.terms));
    ok(kept && kept.usd === 500 && kept.rate === 102000 && kept.ageMs === 2 * HOUR && kept.convert === true && kept.from === usdReq.id,
      'and the request keeps what it was agreed for, to be swapped into dollars', JSON.stringify(kept));
    /* An online receiver, the prices apart: the payer is the one offline, so
     * nothing has changed since this phone was last online, and the swap
     * follows as soon as the sats are in. */
    rx.W._rate = 100000; rx.W._rateAt = Date.now() - 60000;
    const on = rxApp({ offlineNow: () => false });
    on.tapPriceOffered(JSON.stringify(Object.assign({}, fresh, { id: usdReq.id, usd: 500, sats: 4902, ageMs: 20 * HOUR, forUnit: 'usd' })));
    await new Promise((r) => setTimeout(r, 5));
    const onSpec = on.state.screen === 'priceConfirm' ? on.priceSpec() : { rows: [] };
    ok(on.state.screen === 'priceConfirm'
      && onSpec.subtitle === 'What you receive is based on their Bitcoin price, which is not the one this phone sees now.'
      && row(onSpec, 'THEN') && row(onSpec, 'THEN').value === 'Foxy swaps it into dollars at the mint as soon as it is in.'
      && row(onSpec, 'THEIR PRICE SEEN').value === '20 HOURS AGO' && row(onSpec, 'DIFFERENCE').value === '+2%',
      'online, their price 20 hours old and 2% apart: asked, in words for a phone that is online', JSON.stringify({ s: onSpec.subtitle, rows: onSpec.rows }));
    on.priceAnswer(false);
    await new Promise((r) => setTimeout(r, 20));
    // a quote for another request, or another amount, is not for this one
    const w = rxApp();
    w.tapPriceOffered(JSON.stringify(Object.assign({}, fresh, { id: 'other', usd: 500, sats: 4902, ageMs: 60000, forUnit: 'usd' })));
    const m = rxApp();
    m.tapPriceOffered(JSON.stringify(Object.assign({}, fresh, { id: usdReq.id, usd: 900, sats: Math.round(9 / 102000 * 1e8), ageMs: 60000, forUnit: 'usd' })));
    const h = rxApp({ walletChoiceNow: () => ({ hold: 'both', recv: 'usd', send: 'usd' }) });
    h.tapPriceOffered(JSON.stringify(Object.assign({}, fresh, { id: usdReq.id, usd: 500, sats: 4902, ageMs: 60000, forUnit: 'usd' })));
    ok([w, m, h].every((x) => x.terms.length === 1 && x.terms[0].no === true && x.terms[0].why === 'That price is not for this request.'
      && x.state.screen === 'home' && !x.made.length),
      'sats for another request, another amount, or a wallet no longer holding dollars: no', JSON.stringify([w.terms, m.terms, h.terms]));
    /* This phone's own price, named, and a sat figure that is not the dollars
     * at it: agreed by itself it would have been, with one sat for $ 5.00 on
     * the payment-received screen. It is not a quote at all. */
    rx.W._rate = 76900; rx.W._rateAt = Date.now() - 60000;
    const lie = rxApp();
    lie.tapPriceOffered(JSON.stringify({ id: usdReq.id, usd: 500, rate: 76900, ageMs: 30000, sats: 1, forUnit: 'usd' }));
    await new Promise((r) => setTimeout(r, 20));
    ok(lie.terms.length === 1 && lie.terms[0].no === true && !lie.terms[0].req && !lie.made.length && lie.state.screen === 'home',
      'one sat offered for $ 5.00 at this phone’s own price: refused, never agreed by itself', JSON.stringify(lie.terms));
    const fair = rxApp();
    fair.tapPriceOffered(JSON.stringify({ id: usdReq.id, usd: 500, rate: 76900, ageMs: 30000, sats: Math.round(5 / 76900 * 1e8), forUnit: 'usd' }));
    await new Promise((r) => setTimeout(r, 20));
    ok(fair.terms.length === 1 && fair.terms[0].sats === 6502 && fair.made[0] === 6502,
      'while the same price with its own sats is agreed as before', JSON.stringify(fair.terms));
    rx.W._rate = 100000; rx.W._rateAt = Date.now() - 60000;
  }

  // ---- 6. both fresh: nothing said about age, and the same price agreed by itself ------------
  {
    rx.W._rate = 100000; rx.W._rateAt = Date.now() - 60000;
    const t = rxApp();
    t.tapPriceOffered(JSON.stringify(Object.assign({}, fresh, { id: usdReq.id, usd: 500, sats: Math.round(5 / 100050 * 1e8), rate: 100050, ageMs: 30000, forUnit: 'usd' })));
    await new Promise((r) => setTimeout(r, 20));
    ok(t.state.screen === 'home' && t.terms.length === 1 && !!t.terms[0].req, 'under 0.1% apart: agreed without asking, as before',
      JSON.stringify({ screen: t.state.screen, terms: t.terms }));
    t.state.priceQ = rx.W.readQuote(JSON.stringify(Object.assign({}, fresh, { rate: 100050, sats: Math.round(5 / 100050 * 1e8), ageMs: 30000 })));
    const spec = t.priceSpec();
    ok(!row(spec, 'THEIR PRICE SEEN') && !row(spec, 'YOUR PRICE SEEN') && spec.amountLabel === 'CURRENT BITCOIN PRICE',
      'and were it drawn: no age rows, CURRENT BITCOIN PRICE', JSON.stringify(labels(spec)));
  }

  // ---- 7. this phone's own price 30 hours old, theirs fresh -----------------------------------
  {
    rx.W._rate = 100000; rx.W._rateAt = Date.now() - 30 * HOUR;
    const t = rxApp();
    t.tapPriceOffered(JSON.stringify(Object.assign({}, fresh, { id: usdReq.id, usd: 500, sats: 5000, rate: 100000, ageMs: 30000, forUnit: 'usd' })));
    await new Promise((r) => setTimeout(r, 5));
    ok(t.state.screen === 'priceConfirm' && !t.terms.length, 'the same figure, but this phone’s is 30 hours old: asked, not agreed by itself',
      t.state.screen);
    const spec = t.priceSpec();
    ok(row(spec, 'YOUR PRICE SEEN') && row(spec, 'YOUR PRICE SEEN').value === '1 DAY AGO' && !row(spec, 'THEIR PRICE SEEN')
      && /too old to compare/.test(spec.subtitle), 'YOUR PRICE SEEN 1 DAY AGO, and it says why there is no comparison',
      JSON.stringify(labels(spec)) + ' ' + spec.subtitle);
    t.priceAnswer(true);
    await new Promise((r) => setTimeout(r, 20));
    ok(t.terms.length === 1 && !!t.terms[0].req && t.terms[0].sats === 5000, 'ACCEPT sends the request in sats', JSON.stringify(t.terms));
    rx.W._rateAt = Date.now() - 60000;
  }

  // ---- 8. the payer's confirmation of the agreed request ---------------------------------------
  {
    const stub = { sendShortfall: () => ({ short: false, fee: 0, need: 0, have: 0 }), mintUrl: MINT };
    const conf = (ageMs) => {
      const a = app(stub, ['requestSpec() {'], {
        state: { screen: 'reqOffer', stack: [], req: { id: 'agreed-1', unit: 'sat', sats: 5000, mints: [MINT], transports: [], viaTap: true },
                 tapCode: '4242', tapQuoteFor: 'agreed-1', tapQuoteUsd: 500, tapQuoteRate: 100000, tapQuoteAgeMs: ageMs },
        money: (n) => ({ main: '\u20bf ' + n, sub: '' }), px: () => 0, peerRateRow: () => [{ label: 'PEER' }],
        connecting: () => false, requestNeedsRoute: () => false, offlineNow: () => false, mintName: () => 'Forge',
        requestHere: () => true, heldBlocks: () => '', unitBalance: () => 0, editSendNote() {}, makeTokenForRequest() {},
      });
      a.state.balSats = 100000;
      return a.requestSpec();
    };
    const fresh2 = conf(60000);
    ok(row(fresh2, 'FOR') && row(fresh2, 'FOR').value === '$ 5.00' && row(fresh2, 'BITCOIN PRICE').value === '$ 100,000'
      && row(fresh2, 'BITCOIN PRICE').sub === 'this phone\u2019s' && !row(fresh2, 'PEER'),
      'an agreed request: FOR $ 5.00, and this phone’s price with no age when it is fresh', JSON.stringify(labels(fresh2)));
    const old = conf(2 * HOUR);
    ok(row(old, 'BITCOIN PRICE').sub === 'this phone\u2019s, seen 2 hours ago', 'two hours: the age under it', row(old, 'BITCOIN PRICE').sub);
    const other = (() => {
      const a = app(stub, ['requestSpec() {'], {
        state: { screen: 'reqOffer', stack: [], req: { id: 'not-agreed', unit: 'sat', sats: 5000, mints: [MINT], transports: [], viaTap: true },
                 tapCode: '4242', tapQuoteFor: 'agreed-1', tapQuoteUsd: 500, tapQuoteRate: 100000, tapQuoteAgeMs: 0, balSats: 100000 },
        money: (n) => ({ main: '\u20bf ' + n, sub: '' }), px: () => 0, peerRateRow: () => [],
        connecting: () => false, requestNeedsRoute: () => false, offlineNow: () => false, mintName: () => 'Forge',
        requestHere: () => true, heldBlocks: () => '', unitBalance: () => 0, editSendNote() {}, makeTokenForRequest() {},
      });
      return a.requestSpec();
    })();
    ok(!row(other, 'FOR') && !row(other, 'BITCOIN PRICE'), 'and none of it on any other request', JSON.stringify(labels(other)));
    // a tap that gave nothing leaves no agreed price behind for a request of the same id later
    const gone = app(stub, ['requestSpec() {'], {
      state: { screen: 'reqOffer', stack: [], req: { id: 'agreed-1', unit: 'sat', sats: 5000, mints: [MINT], transports: [], viaTap: true },
               tapCode: '4242', tapQuoteFor: 'agreed-1', tapQuoteUsd: 500, tapQuoteRate: 100000, tapQuoteAgeMs: 0, balSats: 100000 },
      money: (n) => ({ main: '\u20bf ' + n, sub: '' }), px: () => 0, peerRateRow: () => [],
      connecting: () => false, requestNeedsRoute: () => false, offlineNow: () => false, mintName: () => 'Forge',
      requestHere: () => true, heldBlocks: () => '', unitBalance: () => 0, editSendNote() {}, makeTokenForRequest() {}, syncTap() {},
    });
    // the app's own, not the stand-in every other case here records with
    gone.tapGaveNothing = lift(stub, ['tapGaveNothing(why) {']).tapGaveNothing;
    ok(row(gone.requestSpec(), 'FOR'), 'the agreed request shows FOR');
    gone.tapGaveNothing('nothing came of it');
    const after = gone.requestSpec();
    ok(!row(after, 'FOR') && !row(after, 'BITCOIN PRICE') && !gone.state.tapQuoteFor && !gone.state.tapQuoteRate,
      'and once the tap gave nothing, the same request shows none of it', JSON.stringify(labels(after)));
  }
}

run().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
}, (e) => { console.log('THREW', (e && e.stack) || e); process.exit(1); });
