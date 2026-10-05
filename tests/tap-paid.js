'use strict';
/* tap-paid.js — a payment by tap that the other phone has not seen yet.
 *
 *     node tests/tap-paid.js
 *
 * Two phones in testing: the payer paid the receiver's invoice over Lightning
 * and went home; the receiver was still on its invoice screen, because its mint
 * had not told it yet; and both phones put up CONNECT TO PAY for a payment that
 * was already made. Three things now stand in the way, each enough alone:
 *
 *   1. an offer this phone has already paid is said to be ALREADY PAID, and
 *      is not paid again;
 *   2. the payer does not listen for five seconds after a payment by tap;
 *   3. the payer says "paid" over the link and the receiver asks its mint at
 *      once, and every second for a while — believing nothing until the mint
 *      agrees.
 *
 * The app's methods are lifted out of build/foxy-app.js and run against a
 * stand-in, as tap-held.js does; the wallet's half runs as it ships.
 */
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function method(sig) {
  const at = app.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = app.indexOf('{', at), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) break; }
  }
  return app.slice(at + 3, i + 1);
}
const lift = (sigs) => new Function('CONFIRM_SCREENS', 'return {' + sigs.map(method).join(',\n') + '}')(
  ['depConfirm', 'sendConfirm', 'reqOffer', 'trConfirm', 'ocConfirm', 'priceConfirm', 'crossConfirm']);
function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

const INV = 'lnbc230n1p5exampleinvoicethatislongenoughtocountasone0123456789abcdefghjklmnpqrstuvwxyzq9';
const INV2 = 'lnbc500n1p5anotherinvoicethatislongenoughtocountasone9876543210zyxwvutsrqpnmlkjhgfedcba77';
const offerText = (inv, id) => JSON.stringify({ v: 2, inv: inv || undefined, req: id ? 'creqA' + id : undefined, up: true, ask: 1 });

function payer(store) {
  const told = [], cards = [], paidOffers = [], stops = [];
  let next = null;
  global.localStorage = store || storage();
  global.window = { FoxyWallet: {
    mintUrl: 'https://mine.test',
    tapPay: () => new Promise((yes) => { next = yes; }),
    tapPayStop: () => { stops.push(Date.now()); return Promise.resolve('ok'); },
    tapQuote: (t) => { told.push(JSON.parse(t)); return Promise.resolve('ok'); },
    classify: (t) => (/^lnbc/i.test(t) ? 'invoice' : 'other'),
    decodeRequest: (t) => ({ id: String(t).replace(/^creqA/, ''), mints: ['https://theirs.test'], sats: 23 }),
    asksInDollars: () => false,
  } };
  const a = Object.assign(lift(['tapStartPay() {', 'tapOfferOf(text) {', 'tapPaidKeys(offer, req) {', 'tapPaidList() {',
    'tapMarkPaid(offer, req) {', 'tapWasPaid(offer) {', 'tapAgoWords(at) {', 'tapSayPaid(inv) {', 'tapPaidByLightning(inv) {',
    'tapGaveNothing(why) {']), {
    state: { screen: 'home', sendPhase: null, reqBusy: false },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    hideTapNearby() {}, hideConnecting() {}, haptic() {}, toast() {}, back() {}, tapBuzz() {}, syncTap() {},
    offlineNow: () => false, group: (n) => String(n),
    blockedCard(kind, o) { cards.push(Object.assign({ kind }, o)); },
    tapPayOffer(o) { paidOffers.push(o); },
    tapQuoteTheirDollars() {},
  });
  // one tap: the listen starts, the offer lands, and the beat before the confirmation passes
  const tap = async (text) => {
    a._tapPaying = null; a._tapGot = false; a._tapKeep = false;
    a.tapStartPay();
    next({ payload: text, code: '4242' });
    await wait(960);
  };
  return { a, tap, told, cards, paidOffers, stops };
}

async function run() {
  console.log('1. an offer already paid is not paid again');
  {
    const store = storage();
    const p = payer(store);
    await p.tap(offerText(INV, 'aa11bb22'));
    ok('a first tap goes on to the confirmation', p.paidOffers.length === 1 && !p.cards.length && p.a._tapOfferNow && p.a._tapOfferNow.inv === INV,
       p.paidOffers.length + ' offered, ' + p.cards.length + ' cards');
    // the Lightning send finishes (03-send.js)
    p.a.tapPaidByLightning('lightning:' + INV.toUpperCase());
    ok('paid over Lightning: the other phone is told, with the end of its own invoice and nothing else',
       p.told.length === 1 && JSON.stringify(p.told[0]) === JSON.stringify({ paid: { tail: INV.slice(-16) } }), JSON.stringify(p.told));
    ok('and the offer is remembered as paid', p.a.tapWasPaid(p.a.tapOfferOf(offerText(INV, 'aa11bb22'))) > 0 && p.a._tapPaidAt > 0, store.getItem('foxy.tap.paid'));
    ok('what is kept is the end of the invoice and the request id, not the invoice', store.getItem('foxy.tap.paid').indexOf(INV) < 0 && /"i:[^"]{24}"/.test(store.getItem('foxy.tap.paid')), store.getItem('foxy.tap.paid'));

    await p.tap(offerText(INV, 'aa11bb22'));
    const card = p.cards[0] || {};
    ok('the same offer heard again: ALREADY PAID, and no confirmation to pay it', p.paidOffers.length === 1 && card.kind === 'alreadyPaid' && card.title === 'ALREADY PAID',
       JSON.stringify(card));
    ok('the card says nothing was sent again', /Nothing was sent again/.test(card.chip || '') && /You paid this/.test(card.reason || ''), card.reason + ' | ' + card.chip);
    ok('the other phone is told once more, since its screen is what is behind', p.told.length === 2, p.told.length + ' told');
    ok('and this phone does not listen again for a while', p.a._tapQuietUntil - Date.now() > 12000 && !p.a._tapGot, Math.round((p.a._tapQuietUntil - Date.now()) / 1000) + ' s');
    await wait(1600);
    ok('the link is let go once the word has had time to cross', p.stops.length === 1, p.stops.length + ' stops');

    // a new page over the same storage: the phone was closed and opened
    const again = payer(store);
    await again.tap(offerText(INV, 'aa11bb22'));
    ok('remembered across a relaunch', again.cards.length === 1 && !again.paidOffers.length, again.cards.length + ' cards');
    await again.tap(offerText('', 'aa11bb22'));
    ok('the same request without its invoice is the same offer', again.cards.length === 2 && !again.paidOffers.length, again.cards.length + ' cards');
    await again.tap(offerText(INV2, 'cc33dd44'));
    ok('another invoice is another payment', again.paidOffers.length === 1, again.paidOffers.length + ' offered');

    // a day on, it is forgotten
    store.setItem('foxy.tap.paid', JSON.stringify(JSON.parse(store.getItem('foxy.tap.paid')).map((x) => ({ k: x.k, at: Date.now() - 90000000 }))));
    ok('and after a day it is forgotten', again.a.tapWasPaid(again.a.tapOfferOf(offerText(INV, 'aa11bb22'))) === 0);
  }
  {
    // ecash over the link: the request's id, and a carry-home request paid in its place
    const p = payer();
    await p.tap(offerText('', 'ee55ff66'));
    p.a.tapMarkPaid(p.a._tapOfferNow, { id: 'carry0001', viaTap: true });
    await p.tap(offerText('', 'ee55ff66'));
    ok('a request paid with ecash is remembered by its id', p.cards.length === 1 && p.paidOffers.length === 1, p.cards.length + ' cards');
    ok('nothing is said over the link for it: there is no invoice to name', p.told.length === 0, JSON.stringify(p.told));
    p.a.tapPaidByLightning(INV2);
    ok('a Lightning send that was not this tap’s invoice says nothing', p.told.length === 0);
  }

  console.log('\n2. five seconds of not listening, home from a payment by tap');
  {
    const starts = [];
    const mk = (paidAt) => {
      global.window = { FoxyWallet: { mintUrl: 'https://mine.test', tapReceive: () => Promise.resolve(''), tapReceiveStop: () => Promise.resolve(''), tapPayStop: () => Promise.resolve('') } };
      // anything else syncTap asks of the app answers with nothing: this is about when it listens
      const quietly = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && k[0] !== '_' ? () => '' : undefined)) });
      return quietly(Object.assign(lift(['syncTap() {', 'tapPaidChecking() {']), {
        state: { screen: 'home', flow: 'send', sendPhase: 'settled', reqBusy: false },
        setState() {}, tapOffering: () => null, haptic() {}, tapBuzz() {}, hideTapNearby() {}, syncConnectRecv() {},
        tapAutoArms: () => true, changeStillDue: () => false, offlineNow: () => false,
        railRequest: () => '', railRequestPending: () => false, showConnecting() {}, hideConnecting() {},
        tapStartPay() { starts.push(Date.now()); },
        _tapAway: true, _tapGot: true, _tapKeep: true, _tapPaidAt: paidAt,
      }));
    };
    const a = mk(Date.now());
    a.syncTap();
    ok('home from a payment: the marks are released and the phone does not listen yet', starts.length === 0 && a._tapGot === false && a._tapQuietUntil > Date.now() + 4000,
       starts.length + ' listens; quiet for ' + Math.round((a._tapQuietUntil - Date.now()) / 100) / 10 + ' s');
    ok('a clock is set to listen when the five seconds are up', !!a._tapQuietT);
    a.syncTap();
    ok('asked again inside the five seconds, still not', starts.length === 0);
    clearTimeout(a._tapQuietT); a._tapQuietT = null;
    a._tapQuietUntil = Date.now() - 1;
    a.syncTap();
    ok('after them, it listens', starts.length === 1, starts.length + ' listens');
    const b = mk(0);
    b.syncTap();
    ok('home from a tap that paid nothing: it listens at once', starts.length === 2 && !b._tapQuietUntil, starts.length + ' listens');
  }

  console.log('\n3. the receiver hears "paid" and asks its mint');
  {
    const kicks = [], screens = [], toasts = [], near = [];
    const mk = (state) => {
      global.window = { FoxyWallet: { watchKick: (h, ms) => { kicks.push([h, ms]); return true; } } };
      return Object.assign(lift(['tapPaidNotice(info) {', 'tapPaidChecking() {', 'tapWatchClosely(ms) {', 'tapHeard(ev) {']), {
        state: Object.assign({ screen: 'confirm', flow: 'receive', invoice: INV, invoiceHash: 'quote-1', tapShownCode: '4242', tapArmed: true }, state || {}),
        setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
        _watching: true, _tapOffer: 'x',
        waitingScreen(kind, o) { screens.push(Object.assign({ kind }, o)); },
        hideConnectRecv() {}, hideConnecting() {}, hideStage() {}, toast(m) { toasts.push(m); }, syncTap() {}, haptic() {}, tapBuzz() {},
        syncConnectRecv() { near.push(this._nearEdge); }, tapTalking() {}, stageUp: () => false, tapReceiving() {},
      });
    };
    const a = mk();
    a.tapPaidNotice({ tail: INV.slice(-16) });
    ok('the invoice on screen, named by its end: the mint is asked now and quickly', kicks.length === 1 && kicks[0][0] === 'quote-1' && kicks[0][1] === 20000, JSON.stringify(kicks));
    ok('the screen says it is confirming, in the payer’s words and not as a fact', screens.length === 1 && screens[0].kind === 'paidCheck' && /The payer says/.test(screens[0].body), JSON.stringify(screens[0]));
    ok('nothing is shown as paid on the payer’s word', a.state.screen === 'confirm');
    a.tapPaidNotice({ tail: INV.slice(-16) });
    ok('said twice, it is one wait', screens.length === 1 && kicks.length === 1);
    a.tapHeard({ side: 'receive', stage: 'nearby', edge: 'left' });
    ok('CONNECT TO PAY is not put up for a payer that has just said it paid', near.length === 0, JSON.stringify(near));
    clearTimeout(a._tapPaidNoteT);

    const b = mk();
    b.tapPaidNotice({ tail: INV2.slice(-16) });
    ok('an invoice that is not the one on screen: nothing', kicks.length === 1 && screens.length === 1 && !b.tapPaidChecking());
    const c = mk({ screen: 'home' });
    c.tapPaidNotice({ tail: INV.slice(-16) });
    ok('not on the invoice screen: nothing', kicks.length === 1 && screens.length === 1);
    const d = mk();
    d.tapPaidNotice({ tail: 'q9' });
    ok('a tail too short to name an invoice: nothing', kicks.length === 1);

    const e = mk();
    e.tapHeard({ side: 'receive', stage: 'code', code: '4242' });
    ok('a payer has the offer: the mint is asked every second for the next minute', kicks.length === 2 && kicks[1][1] === 60000, JSON.stringify(kicks.slice(1)));
    e.tapHeard({ side: 'receive', stage: 'gone' });
    ok('and for thirty seconds after it leaves with nothing said', kicks.length === 3 && kicks[2][1] === 30000, JSON.stringify(kicks.slice(2)));
    e.tapHeard({ side: 'receive', stage: 'nearby', edge: 'right' });
    ok('a payer that is merely near still gets its card', near.length === 1);
  }
  {
    // twenty seconds on with nothing from the mint: said, and the invoice is open again
    const src = method('tapPaidNotice(info) {');
    ok('unconfirmed after twenty seconds, the person is told and the invoice is open again',
       /20200\)/.test(src) && /has not seen that payment yet/.test(src) && /this\.syncTap\(\)/.test(src));
    ok('the receive screen’s own watch is what ends the wait', /_tapPaidNote = 0;[\s\S]{0,120}hideStage\('paidCheck'\)/.test(app));
    ok('and the send tells the tap code when an invoice is paid', /send complete'\);[\s\S]{0,400}tapPaidByLightning\(to\)/.test(app));
    ok('a request paid by tap is remembered too', /req\.viaTap && this\.tapMarkPaid\) this\.tapMarkPaid\(this\._tapOfferNow, req\)/.test(app));
  }

  console.log('\n4. the wallet: asked now, and the payer’s word handed on');
  {
    const phone = nativePhone({ words: PHONE_WORDS });
    let ctx = null, mint = null, paidNow = false;
    const asks = [];
    const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
    ctx = loadReal({
      bridge: (w, m) => {
        if (m.action === 'mintRequest') {
          const p = new URL(m.url).pathname;
          let said = String(mint.handle(m));
          if (/^\/v1\/mint\/quote\/bolt11\/./.test(p)) {
            asks.push(Date.now());
            if (!paidNow) { const cut = said.indexOf('\n'); said = said.slice(0, cut + 1) + JSON.stringify(Object.assign(JSON.parse(said.slice(cut + 1)), { state: 'UNPAID' })); }
          }
          return reply(w, m.id, said);
        }
        const got = phone.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
    });
    const W = ctx.W;
    W._nodeProbeDelay = [86400000, 86400000];
    await W.connect('https://m.test', null, null, { remember: true });
    const inv = await W.invoice(100, '');
    let paid = null;
    const stop = W.watch(inv.hash, (x) => { paid = x; }, {});
    await wait(300);
    const first = asks.length;
    ok('a watch asks once and then waits two seconds', first === 1, first + ' asked');
    ok('an invoice nobody is watching cannot be hurried', W.watchKick('no-such-quote') === false);
    const t0 = Date.now();
    ok('watchKick says it is hurrying this one', W.watchKick(inv.hash, 5000) === true);
    await wait(150);
    ok('and the mint is asked at once', asks.length === first + 1 && asks[asks.length - 1] - t0 < 140, (asks.length - first) + ' more, ' + (asks[asks.length - 1] - t0) + ' ms after');
    // hurried again and again, as a link's events do, including while a question is out
    W.watchKick(inv.hash, 5000); W.watchKick(inv.hash, 5000);
    await wait(1050);
    W.watchKick(inv.hash, 5000);
    await wait(1250);
    ok('then about every second, not every two', asks.length >= first + 3, (asks.length - first) + ' asked in 2.4 s');
    ok('and hurrying it again never starts a second line of questions', asks.length <= first + 6, (asks.length - first) + ' asked in 2.4 s');
    const steady = asks.length;
    await wait(2100);
    ok('one question a second, however often it was hurried', asks.length - steady >= 1 && asks.length - steady <= 3, (asks.length - steady) + ' in 2.1 s');
    paidNow = true;
    await wait(1400);
    ok('and when the mint says it is paid, it is claimed and the screen is told', !!paid && paid.sats === 100, JSON.stringify(paid));
    ok('a finished watch is not hurried again', W.watchKick(inv.hash) === false);
    stop();

    const heard = [], quoted = [];
    W.onTapPaid((x) => heard.push(x));
    W.onTapQuote((t) => quoted.push(t));
    W._tapQuote(JSON.stringify({ paid: { tail: 'abcdefghjklmnpqr', extra: 'ignored' } }));
    ok('the payer’s "paid" reaches the app as the end of an invoice, and is not mistaken for a price',
       heard.length === 1 && JSON.stringify(heard[0]) === JSON.stringify({ tail: 'abcdefghjklmnpqr' }) && !quoted.length, JSON.stringify(heard) + ' ' + JSON.stringify(quoted));
    W._tapQuote(JSON.stringify({ usd: 1.5, sats: 1700 }));
    ok('a price is still a price', quoted.length === 1 && heard.length === 1);
  }

  console.log(R.fail ? '\n' + R.fail + ' tap-paid check(s) failed, ' + R.pass + ' passed' : '\nall ' + R.pass + ' tap-paid checks pass');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
