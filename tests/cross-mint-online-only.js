'use strict';
/* cross-mint-online-only.js — between two mints, both phones online or no payment.
 *
 *     node tests/cross-mint-online-only.js
 *
 * Two phones in testing, a run of taps across three mints with one phone in
 * airplane mode. Four tries to make one payment, seven minutes to bring it
 * home, and IT COSTS MORE TO BRING HOME ten times over for a payment that had
 * landed. The decision: across two mints both phones must be online, and
 * otherwise each shows
 *
 *     OFFLINE & DIFFERENT MINT
 *     Your receiver (payer) uses a different mint.
 *     Both of you must be online to transact between mints.
 *     You use <mine> while they use <theirs>.
 *
 *   1. the payer's gate: where it stops a tap, where it does not, and what
 *      it tells the other phone;
 *   2. the receiver's card, from that word and from an older payer's ask;
 *   3. an invoice arriving late on the answering message is not an answer
 *      (what ended two of those four tries);
 *   4. and it is not sent into a talk in the first place.
 *
 * The app's methods are lifted out of build/foxy-app.js and run against a
 * stand-in, as tap-paid.js does.
 */
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function method(sig) {
  const at = app.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = app.indexOf('{', at + sig.length - 1), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) break; }
  }
  return app.slice(at + 3, i + 1);
}
const lift = (sigs) => new Function('CONFIRM_SCREENS', 'return {' + sigs.map(method).join(',\n') + '}')(
  ['depConfirm', 'sendConfirm', 'reqOffer', 'trConfirm', 'ocConfirm', 'priceConfirm', 'crossConfirm']);
/* The switch is a class field, so it is read from the source rather than lifted. */
const SWITCH = /\n  OFFLINE_CROSS = (true|false);/.exec(app);

const MINE = 'https://mint.minibits.cash/Bitcoin';
const THEIRS = 'https://forge.flashapp.me';
const NAMES = { [MINE]: 'Minibits', [THEIRS]: 'Forge' };
const INV = 'lnbc230n1p5exampleinvoicethatislongenoughtocountasone0123456789abcdefghjklmnpqrstuvwxyzq9';
const TITLE = 'OFFLINE & DIFFERENT MINT';
const BOTH = 'Both of you must be online to transact between mints.';

/* A payer on MINE. `o.offline`: it has no route. `o.heldThere`: sats of its
 * own at the receiver's mint. */
function payer(o) {
  const opts = o || {};
  const told = [], cards = [], paidOffers = [], priced = [], stops = [];
  let next = null;
  const m = new Map();
  global.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  global.window = { FoxyWallet: {
    mintUrl: MINE,
    tapPay: () => new Promise((yes) => { next = yes; }),
    tapPayStop: () => { stops.push(Date.now()); return Promise.resolve('ok'); },
    tapQuote: (t) => { told.push(JSON.parse(t)); return Promise.resolve('ok'); },
    classify: (t) => (/^lnbc/i.test(t) ? 'invoice' : 'other'),
    decodeRequest: (t) => ({ id: 'r1', mints: [/same/.test(t) ? MINE : THEIRS], sats: 116 }),
    asksInDollars: (r) => !!opts.dollars,
    balanceAt: (u) => (u === THEIRS ? (opts.heldThere || 0) : 5000),
  } };
  const a = Object.assign(lift(['tapStartPay() {', 'tapOfferOf(text) {', 'tapOfflineCross(offer) {', 'tapPaidKeys(offer, req) {',
    'tapPaidList() {', 'tapWasPaid(offer) {', 'tapGaveNothing(why) {']), {
    OFFLINE_CROSS: opts.allowed === true,
    state: { screen: 'home', sendPhase: null, reqBusy: false },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    hideTapNearby() {}, hideConnecting() {}, haptic() {}, toast() {}, back() {}, tapBuzz() {}, syncTap() {},
    offlineNow: () => !!opts.offline, group: (n) => String(n),
    mintNameOf: (u) => NAMES[String(u || '').replace(/\/+$/, '')] || '',
    goSwitchMint() { this.switched = true; },
    blockedCard(kind, c) { cards.push(Object.assign({ kind }, c)); },
    tapPayOffer(x) { paidOffers.push(x); },
    tapQuoteTheirDollars(x) { priced.push(x); },
  });
  const tap = async (text) => {
    a._tapPaying = null; a._tapGot = false; a._tapKeep = false;
    a.tapStartPay();
    next({ payload: text, code: '4242' });
    await wait(960);
  };
  return { a, tap, told, cards, paidOffers, priced, stops };
}
const offer = (o) => JSON.stringify(Object.assign({ v: 2, req: 'creqA-other', ask: 1 }, o));

async function run() {
  console.log('1. the payer: across two mints, both online or not paid');
  ok('the switch is in the source, and off', !!SWITCH && SWITCH[1] === 'false', SWITCH ? SWITCH[0].trim() : 'not found');
  {
    const p = payer();
    await p.tap(offer({ up: true, inv: INV }));
    ok('both online, different mints: it goes on to be paid', p.paidOffers.length === 1 && !p.cards.length && !p.told.length,
       p.paidOffers.length + ' on, ' + p.cards.length + ' cards');
  }
  {
    const p = payer({ offline: true });
    await p.tap(offer({ up: true, inv: INV }));
    const c = p.cards[0] || {};
    ok('the payer offline: not paid, and no price or fee is asked about', !p.paidOffers.length && !p.priced.length && p.cards.length === 1,
       p.paidOffers.length + ' on, ' + p.cards.length + ' cards');
    ok('its card, word for word', c.kind === 'offlineCross' && c.title === TITLE
       && c.reason === 'Your receiver uses a different mint.\n' + BOTH
       && c.chip === 'You use Minibits while they use Forge.', JSON.stringify([c.title, c.reason, c.chip]));
    ok('with only CLOSE on it when nothing of this phone’s is at their mint', !c.retry && !c.go, String(c.retry));
    const w = p.told[0] || {};
    ok('the other phone is told: why, and this phone’s mint so its card can name both', p.told.length === 1 && w.why === 'offline-cross' && w.mint === MINE
       && w.gaveUp === 'Your payer uses a different mint. ' + BOTH, JSON.stringify(w));
    ok('the link is kept while the word leaves', p.a._tapGot === true);
    ok('and this phone does not listen again at once', p.a._tapQuietUntil - Date.now() > 12000, Math.round((p.a._tapQuietUntil - Date.now()) / 1000) + ' s');
    await wait(1600);
    ok('then it is let go', p.a._tapGot === false && p.a._tapKeep === false);
  }
  {
    const p = payer();
    await p.tap(offer({ up: false }));
    const c = p.cards[0] || {};
    ok('the receiver offline, the payer online: the same card, and nothing moved to their mint', !p.paidOffers.length && c.kind === 'offlineCross'
       && c.chip === 'You use Minibits while they use Forge.' && p.told.length === 1, JSON.stringify([c.kind, c.chip]));
  }
  {
    const p = payer({ dollars: true });
    await p.tap(offer({ up: false }));
    ok('asked in dollars by an offline receiver at another mint: no price talk is started', !p.priced.length && !p.paidOffers.length && p.cards.length === 1,
       p.priced.length + ' priced');
  }
  {
    const p = payer({ offline: true });
    await p.tap(offer({ up: false }));
    ok('both offline: the same card', p.cards.length === 1 && p.cards[0].title === TITLE && !p.paidOffers.length);
  }
  {
    const p = payer({ heldThere: 68845 });
    await p.tap(offer({ up: false }));
    const c = p.cards[0] || {};
    ok('sats of this phone’s already at their mint: the card offers the mint screen', c.retry === 'CHOOSE A MINT' && typeof c.go === 'function', String(c.retry));
    c.go();
    ok('and opens it', p.a.switched === true);
  }
  {
    const p = payer({ offline: true });
    await p.tap(offer({ up: true, req: 'creqA-same' }));
    ok('the same mint, payer offline: not this card', p.paidOffers.length === 1 && !p.cards.length && !p.told.length, p.cards.length + ' cards');
    const q = payer();
    await q.tap(offer({ up: false, req: 'creqA-same' }));
    ok('the same mint, receiver offline: not this card', q.paidOffers.length === 1 && !q.cards.length, q.cards.length + ' cards');
  }
  {
    const p = payer();
    await p.tap(offer({ inv: INV }));
    ok('an older Foxy that does not say whether it is online is not taken for offline', p.paidOffers.length === 1 && !p.cards.length, p.cards.length + ' cards');
  }
  {
    const p = payer({ offline: true, allowed: true });
    await p.tap(offer({ up: true }));
    ok('with the switch on, the old ways are reached again', p.paidOffers.length === 1 && !p.cards.length, p.cards.length + ' cards');
  }

  console.log('\n2. the receiver: the same card, from where it stands');
  const receiver = (o) => {
    const opts = o || {};
    const cards = [], terms = [], carried = [], ahead = [];
    global.window = { FoxyWallet: {
      mintUrl: THEIRS,
      tapTerms: (t) => { terms.push(JSON.parse(t)); return Promise.resolve('ok'); },
      readQuote: () => null,
    } };
    const a = Object.assign(lift(['tapPriceOffered(text) {', 'offlineCrossCard(theirMint) {']), {
      OFFLINE_CROSS: opts.allowed === true,
      state: { tapArmed: true }, setState() {},
      waitingForPayer() {}, tapTalking(on) { this.talking = on; }, hideStage() {}, toast() {},
      mintNameOf: (u) => NAMES[String(u || '').replace(/\/+$/, '')] || '',
      blockedCard(kind, c) { cards.push(Object.assign({ kind }, c)); },
      tapCarryHome(b) { carried.push(b); }, tapCarryAhead(b) { ahead.push(b); },
    });
    return { a, cards, terms, carried, ahead };
  };
  {
    const r = receiver();
    r.a.tapPriceOffered(JSON.stringify({ gaveUp: 'Your payer uses a different mint. ' + BOTH, why: 'offline-cross', mint: MINE }));
    const c = r.cards[0] || {};
    ok('told by the payer: its card, word for word', r.cards.length === 1 && c.kind === 'offlineCross' && c.title === TITLE
       && c.reason === 'Your payer uses a different mint.\n' + BOTH
       && c.chip === 'You use Forge while they use Minibits.', JSON.stringify([c.title, c.reason, c.chip]));
    ok('and it knows the payer went on purpose, so it does not offer to scan a code', r.a._payerGaveUp === true && r.a.talking === false);
  }
  {
    const r = receiver();
    r.a.tapPriceOffered(JSON.stringify({ gaveUp: 'The payer cancelled.' }));
    ok('any other reason for giving up is the card it always was', r.cards.length === 1 && r.cards[0].kind === 'payerGaveUp' && /cancelled/.test(r.cards[0].reason), JSON.stringify(r.cards[0]));
  }
  {
    const r = receiver();
    r.a.tapPriceOffered(JSON.stringify({ gaveUp: 'x', why: 'offline-cross', mint: 'https://mint.example.org/' }));
    ok('a mint with no name here is named by its address', /while they use mint\.example\.org\.$/.test((r.cards[0] || {}).chip || ''), (r.cards[0] || {}).chip);
  }
  {
    // a payer on an older build, with no route, asking to be carried home
    const r = receiver();
    r.a.tapPriceOffered(JSON.stringify({ id: 'o1', sats: 116, mint: MINE, have: 9000 }));
    ok('an older payer’s ask to have its sats carried home is refused, with the reason', !r.carried.length && r.terms.length === 1 && r.terms[0].no === true && r.terms[0].why === BOTH,
       JSON.stringify(r.terms));
    ok('and this phone shows the card too', r.cards.length === 1 && r.cards[0].kind === 'offlineCross' && r.cards[0].chip === 'You use Forge while they use Minibits.', JSON.stringify(r.cards[0] || {}));
    const q = receiver();
    q.a.tapPriceOffered(JSON.stringify({ deciding: true, ahead: { mint: MINE, have: 9000, sats: 116 } }));
    ok('nor is the fee for it asked of two mints ahead of time', !q.ahead.length);
  }
  {
    const r = receiver({ allowed: true });
    r.a.tapPriceOffered(JSON.stringify({ id: 'o1', sats: 116, mint: MINE, have: 9000 }));
    ok('with the switch on, it is carried as before', r.carried.length === 1 && !r.cards.length && !r.terms.length);
  }

  console.log('\n3. an invoice arriving late on the answering message is not an answer');
  {
    // the payer with no route, waiting to hear what bringing its sats home costs
    let heard = null;
    const stub = { mintUrl: MINE, onTapTerms(fn) { heard = fn; }, tapQuote() { return Promise.resolve(); },
      decodeRequest() { return { id: 'r1', sats: 1028, unit: 'sat', mints: [MINE] }; },
      reason(e) { return String((e && e.message) || e); } };
    const lifted = new Function('window', 'return {' + method('tapStuckAtMint(offer, stuck, sats) {') + '};')({ FoxyWallet: stub });
    const a = Object.assign({
      state: {}, shown: null, toasts: [], gave: [],
      waitingScreen() {}, dismissCard() {}, hideStage() {}, tapGaveNothing(w) { this.gave.push(w); }, back() {}, toast(t) { this.toasts.push(t); },
      group(n) { return String(n); }, setState(s) { Object.assign(this.state, s); },
      crossFeeCard(terms) { this.shown = { sats: Number(terms.sats) }; return Promise.resolve(false); },
      makeTokenForRequest() {},
    }, lifted);
    a.tapStuckAtMint({ read: { id: 'o1', sats: 1000 }, mints: [THEIRS], theirRoute: true }, { mint: MINE, have: 9000 }, 1000);
    heard(JSON.stringify({ inv: INV }));
    ok('the stuck payer hears an invoice and goes on waiting', !a.gave.length && !a.toasts.length && typeof heard === 'function', JSON.stringify(a.gave.concat(a.toasts)));
    heard(JSON.stringify({ req: 'creqA-terms', sats: 1028, net: 1000, fee: 28, at: MINE }));
    await wait(40);
    clearTimeout(a._tapQuoteT);
    ok('and the terms, when they come, are still read', !!a.shown && a.shown.sats === 1028, JSON.stringify(a.shown));
  }
  {
    // the payer waiting on a price to be agreed
    let heard = null;
    const stub = { mintUrl: MINE,
      quoteFor() { return { id: 'o1', usd: 100, rate: 100000, at: 1, ageMs: 0, sats: 1000 }; },
      onTapTerms(fn) { heard = fn; }, tapQuote() { return Promise.resolve(); },
      decodeRequest() { return { id: 'r2', sats: 1000, unit: 'sat' }; },
      reason(e) { return String((e && e.message) || e); } };
    const lifted = new Function('window', 'return {' + method('tapQuoteTheirDollars(offer) {') + '};')({ FoxyWallet: stub });
    const a = Object.assign({
      state: {}, opened: [], toasts: [], gave: [],
      tapPreQuoteMint() {}, waitingScreen() {}, dismissCard() {}, hideStage() {}, tapGaveNothing(w) { this.gave.push(w); }, back() {},
      toast(t) { this.toasts.push(t); }, group(n) { return String(n); }, setState(s) { Object.assign(this.state, s); },
      tapPayOffer(o, sats) { this.opened.push({ req: o.req, sats: sats }); },
    }, lifted);
    a.tapQuoteTheirDollars({ read: { id: 'o1', usd: 100 }, mints: [THEIRS] });
    heard(JSON.stringify({ inv: INV }));
    ok('the payer waiting on a price hears an invoice and goes on waiting', !a.gave.length && !a.toasts.length && !a.opened.length, JSON.stringify(a.gave.concat(a.toasts)));
    heard(JSON.stringify({ req: 'creqA-agreed', sats: 1000 }));
    await wait(40);
    clearTimeout(a._tapQuoteT);
    ok('and their yes, when it comes, is still read', a.opened.length === 1 && a.opened[0].sats === 1000, JSON.stringify(a.opened));
    // and a real no is still a no
    let heard2 = null;
    stub.onTapTerms = (fn) => { heard2 = fn; };
    const b = Object.assign({
      state: {}, opened: [], toasts: [], gave: [],
      tapPreQuoteMint() {}, waitingScreen() {}, dismissCard() {}, hideStage() {}, tapGaveNothing(w) { this.gave.push(w); }, back() {},
      toast(t) { this.toasts.push(t); }, group(n) { return String(n); }, setState(s) { Object.assign(this.state, s); },
      tapPayOffer(o, sats) { this.opened.push({ req: o.req, sats: sats }); },
    }, new Function('window', 'return {' + method('tapQuoteTheirDollars(offer) {') + '};')({ FoxyWallet: stub }));
    b.tapQuoteTheirDollars({ read: { id: 'o1', usd: 100 }, mints: [THEIRS] });
    heard2(JSON.stringify({ no: true }));
    clearTimeout(b._tapQuoteT);
    ok('a refusal is still a refusal', b.gave.length === 1 && b.toasts.length === 1 && !b.opened.length, JSON.stringify(b.gave));
  }

  console.log('\n4. and the receiver does not send it into a talk');
  {
    const sent = [];
    const had = JSON.stringify({ v: 2, req: 'creqA-mine', up: true, ask: 1 });
    const mk = (talking) => {
      global.window = { FoxyWallet: { mintUrl: THEIRS, tapReceive: () => Promise.resolve(''), tapReceiveStop: () => Promise.resolve(''),
        tapPayStop: () => Promise.resolve(''), tapTerms: (t) => { sent.push(JSON.parse(t)); return Promise.resolve('ok'); } } };
      const quietly = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && k[0] !== '_' ? () => '' : undefined)) });
      return quietly(Object.assign(lift(['syncTap() {', 'tapPaidChecking() {']), {
        state: { screen: 'confirm', flow: 'receive', tapArmed: true, tapShownCode: '4242', tapRecvStage: 'linked' },
        setState() {}, tapOffering: () => ({ inv: INV, req: 'creqA-mine', waiting: false }),
        offlineNow: () => false, changeStillDue: () => false,
        _tapOffer: had, _tapTalking: talking, _tapInvTold: '',
      }));
    };
    const a = mk(true);
    a.syncTap();
    ok('with a question in flight, the invoice is held back', sent.length === 0 && a._tapInvTold === '', JSON.stringify(sent));
    const b = mk(false);
    b.syncTap();
    ok('with none, it goes to the payer as before', sent.length === 1 && sent[0].inv === INV && b._tapInvTold === INV, JSON.stringify(sent).slice(0, 80));
    b.syncTap();
    ok('once', sent.length === 1);
  }

  console.log('\n' + (R.fail ? R.fail + ' FAILED, ' : '') + R.pass + ' passed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
