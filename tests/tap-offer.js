'use strict';
/* tap-offer.js — what the receiving phone puts on the air, and when it stops.
 *
 *     node tests/tap-offer.js
 *
 * The invoice screen advertises an offer: the Lightning invoice, and a Cashu
 * payment request beside it so a payer on the same mint can pay with ecash
 * instead. Two things about that offer are load-bearing and neither had a test:
 *
 *   - it must not go out half made. The request takes a moment — an onion
 *     address has to answer — and an offer with only the invoice in it is paid
 *     over Lightning, with a routing fee, by two phones on one mint that could
 *     have paid each other directly. A payer quick enough to tap inside that
 *     window got exactly that.
 *   - it must not change while a payer is on the link. The four digits both
 *     screens show are taken over the whole offer, so swapping it mid
 *     handshake breaks the one thing those digits are for — and it went
 *     through the branch that clears the code, so the receiver wiped the
 *     digits off its own screen while the payer was still holding them.
 *
 * syncTap and railRequestPending are lifted out of build/foxy-app.js and run
 * against a stand-in app, the way watch-rearm.js and switch-guard.js do.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  return block(at + 3);
}
const methods = new Function('return {' + [
  'syncTap() {', 'tapOffering() {', 'tapGaveNothing(why) {',
  'railRequestPending(sats, purpose, usdCents) {',
  // syncTap asks it: the link is held open while a receiver owes change back
  'changeStillDue() {',
  // what the native side says as a tap goes: the code arriving is what used to
  // disarm the screen and take the receiver down under a live payer
  'tapHeard(ev) {',
].map(method).join(',\n') + '}')();

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

const INVOICE = 'lnbc170n1pcheque' + 'q'.repeat(40);

/* A stand-in for the page: the state the offer is built from, and a record of
 * every call that reached the native side. */
function app(over) {
  /* Built before the assign below, because `over` carries `state` too and
   * would otherwise put its raw partial back over these — a case that names two
   * fields would silently lose the other ten. It cost nothing while every
   * default was also named by hand; `tapArmed` is not. */
  const base = Object.assign({
      screen: 'confirm', flow: 'receive', invoice: INVOICE,
      recvRail: 'LIGHTNING', recvVia: '', network: '', invoiceIsAddress: false,
      tapShownCode: '', tapRecvStage: '',
      /* Armed, because nothing goes on the air without the
       * TAP button and every case below is about *what* goes out, not whether
       * the press happened. The press itself has its own case at the end. */
    tapArmed: true,
  }, (over || {}).state);
  const a = Object.assign({
    state: base,
    said: [],
    _creqs: {},
    // what railRequest would hand back this pass, and whether one is in flight
    creq: '',
    making: false,
    setState(o) { Object.assign(a.state, typeof o === 'function' ? o(a.state) : o); },
    railRequest() { return a.creq; },
    cashuRequest() { return a.creq; },
    tapBuzz() {},
    haptic() {},
    syncClaim() {},
    tapStartPay() { a.said.push('pay'); },
    // the invoice screen arming itself has its own cases below; elsewhere the press is the subject
    tapAutoArms() { return false; },
  }, over);
  a.state = base;
  Object.assign(a, methods);
  // railRequestPending reads _creqs, which railRequest above does not fill
  a.railRequestPending = () => a.making;
  // the offer says whether this phone has a route (`up`), so the payer can hold
  // the hand-over rules up its end (tests/handover-rules.js)
  a.offlineNow = () => !!a.offline;
  // '' means the price on screen is one the app still treats as live, which is
  // what decides whether the offer carries it (26d-tap.js)
  a.priceAgo = () => (a.staleprice ? '2H AGO' : '');
  a.cashuRequest = () => a.creq || '';
  /* The tap's own request: no onion address on it, made synchronously, because
   * the payment comes back over the link that carried the offer. It is what
   * stops a tap waiting on the Lightning invoice (12-receive.js). */
  a.tapOnlyRequest = () => a.creq || '';
  a.wantedSats = () => a.want || 0;
  // the loader both phones show between the first buzz and the link (26e-loaders.js)
  a.showConnecting = () => { a.connecting = true; };
  a.hideConnecting = () => { a.connecting = false; };
  return a;
}

const wallet = (a) => ({
  mintUrl: 'https://m.test',
  classify: (t) => (/^ln/.test(String(t || '')) ? 'invoice' : 'text'),
  amountOf: () => 17,
  tapReceive: (o) => { a.said.push('receive ' + o); return Promise.resolve(''); },
  tapReceiveStop: () => { a.said.push('stop'); return Promise.resolve(''); },
  tapPayStop: () => Promise.resolve(''),
});

function run(a) {
  global.window = { FoxyWallet: wallet(a) };
  a.syncTap();
  return a.said;
}

// ---- nothing goes out while there is nothing at all to offer --------------
{
  const a = app();
  a.creq = ''; a.making = true;
  a.state.invoice = '';                     // and the mint has not made one yet
  const early = run(a);
  /* On the air at once, with nothing to offer yet.
   *
   * It used to wait for the request, so pressing TAP did nothing for about a
   * second while `railRequest` got an onion address. Nothing in the handshake
   * needs the offer — the four digits are settled at M3, before one exists —
   * so the phones can be talking through that second and the offer follows as
   * M4 (TapLink.offerSent).
   *
   * The ecash half no longer waits on anything: the tap's own
   * request carries no onion address, because the payment comes back over the
   * link, so it is made synchronously (`tapOnlyRequest`). This case is now the
   * narrow one it says it is — nothing made, and no invoice either. */
  check('on the air as soon as TAP is pressed, with nothing to offer yet',
    early.length === 1 && early[0] === 'receive ', JSON.stringify(early));

  /* And the mint's two cases: it has an invoice, or it does
   * not, and either way another Foxy at the same mint can be paid at once. */
  {
    const b = app();
    b.creq = 'creqA' + 'y'.repeat(30);
    b.state.invoice = '';                   // the mint is still thinking
    const out = run(b);
    let body = null;
    try { body = JSON.parse(out[0].slice('receive '.length)); } catch (e) {}
    check('the ecash half goes out without waiting for the Lightning invoice',
      !!(body && body.req === b.creq && !body.inv), JSON.stringify(body));
  }

  // the request lands, and the real offer follows it
  a.creq = 'creqA' + 'x'.repeat(30);
  a.making = false;
  a.state.invoice = INVOICE;
  const said = run(a);
  check('and the offer follows when the request lands', said.length === 2, JSON.stringify(said));
  let body = null;
  try { body = JSON.parse(said[1].slice('receive '.length)); } catch (e) {}
  check('carrying the invoice and the request', !!(body && body.inv === INVOICE && body.req === a.creq),
    JSON.stringify(body));

  /* And the late first offer is allowed through with a payer already on the
   * link, which a *swap* never is: the digits they are comparing were settled
   * before either offer existed, so sending the first one late changes
   * nothing they can see. */
  const late = app();
  late.creq = ''; late.making = true;
  late.state.invoice = '';                  // nothing at all to offer, at first
  run(late);
  late.state.tapShownCode = '1234';
  late.creq = 'creqA' + 'y'.repeat(30);
  late.making = false;
  late.state.invoice = INVOICE;
  const after = run(late);
  check('the first offer still goes out to a payer already on the link',
    after.length === 2 && after[1].indexOf('creqA') > 0, JSON.stringify(after));
}

// ---- an address that never answers is not waited on for ever ---------------
{
  const a = app();
  a.creq = ''; a.making = false;
  const said = run(a);
  let body = null;
  try { body = JSON.parse(said[0].slice('receive '.length)); } catch (e) {}
  check('an invoice alone still goes out when no request is coming',
    said.length === 1 && !!body && body.inv === INVOICE && body.req === undefined,
    JSON.stringify(said));
}

// ---- the offer stands while a payer is on the link ------------------------
{
  const a = app();
  a.creq = 'creqA' + 'x'.repeat(30);
  a.making = false;
  run(a);
  check('a payer finds an offer on the air', a.said.length === 1, JSON.stringify(a.said));

  // a payer connects, and the code lands on screen
  a.state.tapRecvStage = 'connecting';
  a.state.tapShownCode = '4821';
  // the amount, and so the request, changes underneath — as the invoice screen
  // settling a figure or a new address would change it
  a.creq = 'creqA' + 'y'.repeat(30);
  run(a);
  check('the offer is not swapped under a payer who is already on the link',
    a.said.length === 1, JSON.stringify(a.said));
  check('and the code stays on the receiver’s screen', a.state.tapShownCode === '4821',
    'code is ' + JSON.stringify(a.state.tapShownCode));

  // they go, and the change catches up
  a.state.tapRecvStage = '';
  a.state.tapShownCode = '';
  run(a);
  check('once they are gone the new offer goes up', a.said.length === 2, JSON.stringify(a.said));
}

// ---- leaving the screen takes it off the air ------------------------------
{
  const a = app();
  a.creq = 'creqA' + 'x'.repeat(30);
  run(a);
  a.state.screen = 'home';
  run(a);
  // home listens for a payer of its own, so 'pay' follows; 'stop' is the point
  check('leaving the invoice screen stops the advertisement',
    a.said.indexOf('stop') === 1, JSON.stringify(a.said));
}

// ---- nothing goes on the air away from the tap screen ---------------------
{
  /* The payer listens, and listening is free: a central hears and says nothing,
   * so a phone doing it in a room full of merchants gives away nothing it could
   * be followed by. It runs from the two screens somebody pays from and nowhere
   * else — not on a receive screen, where there is nothing to pay, and not
   * while a payment is already going out, where a second one opening itself
   * over the first is the one way this could cost money. */
  const listens = ['home', 'sendHow'];
  const quiet = ['confirm', 'amount', 'history', 'settings', 'spPayer'];
  const heard = listens.filter((screen) => {
    const a = app({ state: { screen: screen, flow: 'send', invoice: '' } });
    run(a);
    return a.said.indexOf('pay') >= 0;
  });
  check('the payer listens from home and from send', heard.length === listens.length,
    'only ' + JSON.stringify(heard));

  const noisy = quiet.filter((screen) => {
    const a = app({ state: { screen: screen, flow: 'send', invoice: '' } });
    run(a);
    return a.said.indexOf('pay') >= 0;
  });
  check('and from nowhere else', noisy.length === 0, 'also listened on ' + JSON.stringify(noisy));

  const busy = app({ state: { screen: 'home', flow: 'send', invoice: '', sendPhase: 'in' } });
  run(busy);
  check('and not while a payment is already going out',
    busy.said.indexOf('pay') < 0, JSON.stringify(busy.said));

  /* A finished send must not end listening for the life of the app.
   *
   * `sendPhase` is left at 'settled' by a successful send and the paths that
   * clear it are ones a success never takes, so gating on "any sendPhase"
   * meant the first payment of a launch was the last tap of it: a
   * payer heard nothing for nine minutes while the other phone pressed TAP six
   * times. Only money actually on the wire may stop a listen. */
  const done = app({ state: { screen: 'home', flow: 'send', invoice: '', sendPhase: 'settled' } });
  run(done);
  check('and a finished send does not end listening for good',
    done.said.indexOf('pay') >= 0, JSON.stringify(done.said));
}

// ---- the receiver is not stopped while a payer is on the link -------------
{
  /* The bug that broke every tap payment for an hour.
   *
   * The code arriving used to clear `tapArmed`, on the reasoning that the radio
   * goes quiet at the subscribe so the button should look plain. But `tapArmed`
   * is what `syncTap` reads to decide whether this screen wants a receiver at
   * all — so the next pass called `tapReceiveStop` the instant the digits
   * appeared, ten seconds before the payer tried to send, and long before
   * `busy` could protect anything. The payment went into a link that was no
   * longer there. */
  const a = app();
  run(a);
  a.said.length = 0;
  a.tapHeard({ side: 'receive', stage: 'code', code: '4821' });
  check('a code arriving leaves the screen armed', a.state.tapArmed === true,
    'tapArmed is ' + JSON.stringify(a.state.tapArmed));
  run(a);
  check('and nothing stops the receiver under a payer',
    a.said.indexOf('receiveStop') < 0, JSON.stringify(a.said));
}

// ---- a finished send does not swallow the next tap's confirmation ---------
{
  /* Three guards read `sendPhase` to mean "a payment is going out", and two of
   * them were written as truthiness tests. A *finished* send leaves 'settled',
   * so after the first payment of a launch the next tap buzzed, connected, and
   * then returned silently instead of opening the confirmation — the receiver's
   * side working perfectly throughout.
   *
   * This checks the rule rather than the call: every read of `sendPhase` in
   * the tap path compares it to a value, never tests it for truth. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '26d-tap.js'), 'utf8');
  const loose = [];
  for (const m of src.matchAll(/(?:now|s|this\.state)\.sendPhase(\s*[^\s=!)]|\s*\))/g)) {
    const tail = src.slice(m.index, m.index + 60);
    if (!/sendPhase\s*(===|!==)/.test(tail)) loose.push(tail.split('\n')[0].trim());
  }
  check('every sendPhase test in the tap path names a phase', loose.length === 0,
    JSON.stringify(loose.slice(0, 3)));
}

// ---- the link a payment is about to cross is not torn down ----------------
{
  /* The payer takes an offer while sitting on home, because it has no screen
   * of its own. Clearing the marks there ran in the same update as the offer
   * landing and started a fresh search, which drops the Bluetooth link — the
   * first tap fell back to the onion and took 7941 ms instead of 200. */
  const a = app({ state: { screen: 'home', flow: 'send', invoice: '' } });
  run(a);
  a.said.length = 0;
  a._tapGot = true; a._tapKeep = true;      // an offer just landed
  run(a);
  check('an offer that just landed on home is not searched over',
    a.said.indexOf('pay') < 0 && a._tapKeep === true, JSON.stringify(a.said));

  // away to the confirmation, and back once the payment is done
  a.state.screen = 'sendConfirm';
  run(a);
  a.state.screen = 'home';
  a.state.sendPhase = 'settled';
  run(a);
  check('and listening resumes once the payment has been and gone',
    a._tapKeep === false && a._tapGot === false, '_tapKeep ' + a._tapKeep + ', _tapGot ' + a._tapGot);
}

// ---- and the receiver goes on the air by itself, unless told not to --------
{
  /* The invoice screen arms itself (TAP-TO-PAY.md, "The
   * screen is the whole of it"). With the setting off it is the press, as it
   * was: a receive screen with the invoice up says nothing until TAP. */
  const idle = app({ state: { tapArmed: false } });
  idle.tapAutoArms = () => false;
  const saidIdle = run(idle);
  check('with TAP ON PRESS ONLY, a receive screen with the invoice up says nothing until TAP is pressed',
    saidIdle.length === 0, JSON.stringify(saidIdle));
  const auto = app({ state: { tapArmed: false } });
  auto.tapAutoArms = () => true;
  run(auto);
  check('otherwise the screen arms itself, with the QR left showing',
    auto.state.tapArmed === true && auto.state.tapCardOff === true, JSON.stringify(auto.state));
  const radioOff = app({ state: { tapArmed: false, tapRecvStage: 'off' } });
  radioOff.tapAutoArms = () => true;
  run(radioOff);
  check('but not with Bluetooth off', radioOff.state.tapArmed === false, JSON.stringify(radioOff.state));
  const code = app({ state: { tapArmed: false, tapShownCode: '4821' } });
  code.tapAutoArms = () => true;
  run(code);
  check('and not while a code is up', code.state.tapArmed === false, JSON.stringify(code.state));

  const pressed = app({ state: { tapArmed: true } });
  const saidPressed = run(pressed);
  check('and goes on the air when it is', saidPressed.length === 1, JSON.stringify(saidPressed));

  /* The press belongs to the screen it was made on. Leaving takes it with it,
   * so nothing is left broadcasting behind a screen nobody is looking at. */
  const gone = app({ state: { screen: 'history', tapArmed: true } });
  run(gone);
  check('leaving the screen disarms it', gone.state.tapArmed === false,
    'tapArmed is ' + JSON.stringify(gone.state.tapArmed));
}

// ---- the CASHU rail is a tap too ------------------------------------------
{
  /* The receive screen on CASHU shows a payment request instead of an invoice.
   * Handing that over by tap is better than by QR, not worse — and it went out
   * on the Lightning rail only, so switching the network quietly turned tap to
   * pay off. */
  const a = app({ state: { screen: 'confirm', flow: 'receive', recvRail: 'CASHU', invoice: INVOICE } });
  a.creq = 'creqA' + 'c'.repeat(30);
  const said = run(a);
  let body = null;
  try { body = JSON.parse(said[0].slice('receive '.length)); } catch (e) {}
  check('the CASHU rail goes on the air', said.length === 1, JSON.stringify(said));
  check('offering the request alone, with no invoice beside it',
    !!body && body.req === a.creq && body.inv === undefined, JSON.stringify(body));

  // and on chain still cannot be tapped: an address is not a thing to hand over
  const oc = app({ state: { screen: 'confirm', flow: 'receive', recvRail: 'ON-CHAIN', invoice: INVOICE } });
  oc.creq = 'creqA' + 'c'.repeat(30);
  check('on chain is not on the air', run(oc).length === 0, JSON.stringify(oc.said));
}

// ---- a split's payer screen behaves like the invoice screen ---------------
{
  /* One share, one code, held up to one phone — the receive invoice screen for
   * one person's part of a bill. It was never on the air at all. */
  const a = app({ state: { screen: 'spPayer', spIdx: 0, spInvoices: [INVOICE], spRail: 'LIGHTNING' } });
  a.creq = 'creqA' + 's'.repeat(30);
  const said = run(a);
  let body = null;
  try { body = JSON.parse(said[0].slice('receive '.length)); } catch (e) {}
  check('the split payer screen goes on the air', said.length === 1, JSON.stringify(said));
  check('with that share\u2019s invoice and its request',
    !!body && body.inv === INVOICE && body.req === a.creq, JSON.stringify(body));

  /* A slot whose invoice is still being made goes on the air with nothing.
   *
   * It used to offer nothing *and* refuse to be armed, so pressing TAP in the
   * second before the code existed answered "nothing to be paid yet" and did
   * nothing. Waiting is not no: the handshake needs no
   * offer, so the phones talk through that second and the offer follows. */
  const empty = app({ state: { screen: 'spPayer', spIdx: 1, spInvoices: [INVOICE], spRail: 'LIGHTNING' } });
  empty.creq = 'creqA' + 's'.repeat(30);
  const said2 = run(empty);
  /* And now it has something: a request made on the spot, with
   * no invoice and no onion address to wait for. */
  let body2 = null;
  try { body2 = JSON.parse(said2[0].slice('receive '.length)); } catch (e) {}
  check('a share whose invoice is still being made is offered as a request at once',
    said2.length === 1 && !!body2 && !body2.inv && body2.req === empty.creq, JSON.stringify(said2));

  /* And what really cannot be tapped still cannot. An on-chain address is not
   * a thing to hand over a Bluetooth link, and it is a `null` offering rather
   * than a waiting one — so the button refuses rather than broadcasting. */
  const chain = app({ state: { screen: 'confirm', flow: 'receive', recvRail: 'ON-CHAIN', invoice: '' } });
  check('an on-chain receive is never on the air', run(chain).length === 0, JSON.stringify(chain.said));
}

/* ---- the offer says whether this phone has a route -------------------------
 *
 * The payer needs it to hold up its end of the hand-over rules: an offline
 * receiver may only be handed ecash locked to it, at its own mint
 * (tests/handover-rules.js). It used to be guessed from whether the request
 * named an onion address, which reads every online receiver whose Tor has not
 * published yet as an offline one. A fact about this phone, said by this phone.
 */
{
  const said = (offline) => {
    const a = app({ state: { screen: 'confirm', flow: 'receive', recvRail: 'LIGHTNING', invoice: INVOICE } });
    a.creq = 'creqA' + 's'.repeat(30);
    a.offline = offline;
    const out = run(a);
    try { return JSON.parse(out[0].slice('receive '.length)); } catch (e) { return null; }
  };
  const up = said(false);
  const down = said(true);
  check('a receiver with a route says so in its offer', up && up.up === true, JSON.stringify(up));
  check('and one without says that', down && down.up === false, JSON.stringify(down));
  check('it is a boolean, so a build that does not send it reads as neither',
    typeof (up || {}).up === 'boolean' && typeof (down || {}).up === 'boolean',
    JSON.stringify([typeof (up || {}).up, typeof (down || {}).up]));
}

/* ---- the radio stays up while the answer is being given --------------------
 *
 * `priceConfirm` and `crossConfirm` are part of a conversation already in
 * flight: the payer has sent a figure and is holding the link open waiting for
 * the answer. They are not receive screens, so `syncTap` read them as "the
 * person left" and retired the receiver — and the ACCEPT, when it came, had
 * nowhere to go. `sendTerms` found no subscribed central, returned false, and
 * the payer heard silence (the accept was never heard; the same leg worked
 * while it was still a card, because a card floats over the screen and
 * `screen` never changes).
 */
{
  const live = (screen, talking) => {
    const a = app({ state: { screen: screen, flow: 'receive', recvRail: 'CASHU',
                             invoice: INVOICE, tapArmed: true, tapShownCode: '4821' } });
    a.creq = 'creqA' + 's'.repeat(30);
    a._tapOffer = 'receive {"v":2}';
    a._tapTalking = !!talking;
    run(a);
    return a;
  };
  /* Keyed on the conversation, not the screen. The answer is sent AFTER the
   * screen has gone back to home, so a screen test loses the race every time
   * (tests/tap-held.js). */
  ['priceConfirm', 'crossConfirm', 'home'].forEach((screen) => {
    const a = live(screen, true);
    check('the receiver stays on the air while an answer is still coming, on ' + screen,
      !a.said.some((x) => /stop/i.test(String(x))) && a._tapOffer !== null,
      JSON.stringify(a.said));
  });
  /* And a screen that really is leaving still takes it down, which is what
   * stops a phone broadcasting behind a screen nobody is looking at. */
  const gone = live('home', false);
  check('while leaving for real still comes off the air',
    gone._tapOffer === null, JSON.stringify(gone.said));
}

/* ---- a tap that went nowhere does not deafen the next one ------------------
 *
 * `_tapGot` stops `syncTap` searching again under a link the payment is about
 * to cross, and it is released by going away from home and coming back — which
 * is how a finished payment announces itself. A tap that ends WITHOUT going
 * anywhere never releases it: the phone sits on home with `_tapGot` set and
 * never listens again, so the payer cannot tap until they visit SEND and come
 * back.
 *
 * Every path that ends a tap with no payment now says so, and a backstop
 * catches any that a later change forgets.
 */
{
  const deaf = (setup) => {
    const a = app({ state: { screen: 'home', flow: 'send' } });
    a.tapOffering = () => null;
    Object.assign(a, setup || {});
    run(a);
    // listening again means syncTap asked the wallet to start a search
    return a.said.some((x) => /^pay/.test(String(x)));
  };

  // the state the bug leaves behind: an offer was taken, nothing came of it
  const stuck = {
    _tapGot: true, _tapKeep: true, _tapAway: false,
    _tapGotAt: Date.now() - 60000,
    changeStillDue: () => false,
  };
  check('a tap that landed a minute ago and went nowhere is let go',
    deaf(stuck) === true, 'the phone listens again without being navigated away');

  // and one that has only just landed is left alone: the payment is coming
  check('while one that has just landed is left alone, because it is about to be paid',
    deaf(Object.assign({}, stuck, { _tapGotAt: Date.now() })) === false,
    'the link the payment is about to cross is not torn down');

  // change still owed holds it whatever the clock says
  check('and change still owed holds the link however long it has been',
    deaf(Object.assign({}, stuck, { changeStillDue: () => true })) === false,
    'change comes back over that link');

  check('every path that ends a tap with no payment says so',
    (src.match(/this\.tapGaveNothing\(/g) || []).length >= 8,
    (src.match(/this\.tapGaveNothing\(/g) || []).length + ' call sites');
}

results.forEach((r) => console.log(r));
const bad = results.filter((r) => r.indexOf('FAIL') === 0).length;
console.log('');
console.log(bad ? bad + ' of ' + results.length + ' tap offer check(s) failed' : 'all tap offer checks pass');
process.exit(bad ? 1 : 0);
