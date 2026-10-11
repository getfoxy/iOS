'use strict';
/* send-fee-check.js — a Lightning payment has to fit with its fee, before SEND.
 *
 *     node tests/send-fee-check.js
 *
 * The confirmation compared the invoice with the balance and left the fee
 * out. Two invoices a few hundred sats under the balance were offered a SEND
 * button and refused a second later: "needs <amount> sats including the fee
 * reserve, and you hold <a little less>". The fee quote is on that screen
 * already, so the screen is where it is refused.
 *
 * The sum is the wallet's (`payNeed`, which is `pay`'s own `meltNeed`), asked
 * once the quote is in, and the words are the wallet's: while it does not
 * cover the payment the button reads NOT ENOUGH and does nothing, with the
 * wallet's sentence under the rows. A send that is refused all the same (the
 * reserve moved between the quote and the send) says the same sentence on a
 * card with no TRY AGAIN, which goes to the amount screen and not back to the
 * confirmation.
 *
 * And the confirmation's other held state: CHECKING, with the FEE row saying
 * the same word, for a connection that is on its way (Foxy comes back from
 * the background, or opens, working offline for the few seconds Tor takes) and
 * for the question asked over it. A scanned request that needs the route is
 * held the same way; one that does not is not.
 *
 * Then the same rule on the tap card, and the way back from a send that did
 * not happen: SEND pushes the confirmation onto the screen stack as it moves
 * to the sending screen, and every return to the confirmation has to drop
 * that entry again, or the first press of its back arrow pops the entry and
 * changes nothing on screen. The return to the amount screen, and the card
 * for a connection that never came, leave the stack the same way.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

let failed = 0;
// the app's own logging is silenced further down; the verdict lines are not
const out = console.log.bind(console);
const ok = (good, name, detail) => {
  out((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
// one of the app's own methods, by its first line
const method = (sig) => {
  const i = src.indexOf('\n  ' + sig);
  if (i < 0) throw new Error('missing ' + sig);
  return block(i + 3);
};
// several, as one object
const lift = (sigs) => new Function('return {' + sigs.map(method).join(',\n') + '}')();
const { confirmSpec, requestSpec, requestNeedsRoute } =
  lift(['confirmSpec() {', 'requestSpec() {', 'requestNeedsRoute(req) {']);

/* The sentence, as it is to be said: the wallet's (Web/foxy-wallet.js pins the
 * wallet's own copy), written out here so a change to it fails in two places. */
const words = (need, have) => 'Your balance isn\'t enough to cover the payment and its fee: this needs '
  + need + ' sats and you hold ' + have + '.';

/* What `payNeed` answers for a pile of `have` that has to cover `sats` and a
 * reserve, with `extra` sats of the mint's own fees on top. */
const needOf = (have, extra) => (sats, reserve) => {
  const need = sats + reserve + (extra || 0);
  return { ok: have >= need, need: need, have: have, fee: need - sats, why: have >= need ? '' : words(need, have) };
};

/* The confirmation for a payment, as `confirmSpec` draws it. `o`:
 *   kind      'invoice' (default) or 'email', a lightning address
 *   connecting  a connection is on its way
 *   asking    a question is out, or about to go (`quotingFee`, `sendToAsk`)
 *   payNeed   what the wallet says to the sum (default: the pile is `balance`)
 *   sats      for an address, the sats being sent */
function spec(invoiceSats, balance, quotedFee, held, o) {
  const opt = o || {};
  const kind = opt.kind || 'invoice';
  const sent = { start: 0, back: 0 };
  const sats = kind === 'invoice' ? invoiceSats : opt.sats;
  global.window = { FoxyWallet: Object.assign({
    amountOf: () => (kind === 'invoice' ? invoiceSats : null), heldSats: () => held || 0,
    payNeed: needOf(balance),
  }, opt.wallet || {}) };
  const app = {
    state: { screen: 'sendConfirm', recipientKind: kind, recipient: kind === 'invoice' ? 'lnbc1…' : 'alice@example.com',
             balSats: balance, quotedFee: quotedFee, quotedAmt: quotedFee == null ? null : sats,
             quotingFee: !!opt.asking, amount: kind === 'invoice' ? '0' : String(sats), unit: 'SATS', sendPriceCheck: 'agreed' },
    cfRow: (label, value) => ({ label, value }),
    sendToText: () => (kind === 'invoice' ? 'lnbc1…' : 'ALICE@EXAMPLE.COM'),
    sendAmountText: () => String(sats),
    money: (n) => ({ main: '₿ ' + n, sub: '' }),
    heldBlocks(shortBy) { return (held > 0 && shortBy > 0 && shortBy <= held) ? 'PENDING' : ''; },
    back() { sent.back += 1; }, startSend() { sent.start += 1; }, px: () => 0, peerRateRow: () => [],
    connecting: () => !!opt.connecting, sendToAsk: () => false,
    sendSatsNow: () => sats,
  };
  // anything else the screen asks of the app is not what is being tested
  const any = new Proxy(app, { get: (t, k) => (k in t ? t[k] : () => '') });
  const s = confirmSpec.call(any);
  s.sent = sent;
  s.fee = (s.rows.find((r) => r.label === 'FEE') || {}).value;
  return s;
}

// ---- the fee is counted, with the mint's own, before SEND ---------------------
{
  const s = spec(160000, 160931, 1158);
  ok(s.cta === 'NOT ENOUGH' && s.ctaTone === 'warn',
     'a quote the balance cannot cover holds the button, which reads NOT ENOUGH', s.cta + ' / ' + s.ctaTone);
  ok(s.warn === words(161158, 160931), 'with the wallet\'s sentence under the rows, at its figures', s.warn);
  ok(s.amountInk === '#FF5C5C', 'and the amount in red');
  ok(s.fee === 'UP TO ₿ 1158', 'the fee it was quoted stays in its row', s.fee);
  s.go();
  ok(s.sent.start === 0 && s.sent.back === 0 && !s.ctaBusy, 'pressing it does nothing: nothing starts, nothing closes, no spinner', JSON.stringify(s.sent));
}
{
  /* The mint's own fee for the split and the melt can be all that is short:
   * the amount and the reserve fit, the payment does not. */
  const s = spec(100000, 101050, 1000, 0, { wallet: { payNeed: needOf(101050, 80) } });
  ok(s.cta === 'NOT ENOUGH' && s.warn === words(101080, 101050),
     'the amount and the reserve fitting is not the payment fitting: the mint\'s own fee counts', s.cta + ' / ' + s.warn);
}
{
  const s = spec(100000, 160931, 1000);
  ok(/^SEND /.test(s.cta) && !s.warn && !s.ctaBusy && s.ctaTone === 'go',
     'a balance that covers it goes on to SEND, as it did', String(s.cta));
  s.go();
  ok(s.sent.start === 1, 'and pressing it sends');
}
{
  const s = spec(100000, 160931, 1000, 0, { wallet: { payNeed: needOf(101000) } });
  ok(/^SEND /.test(s.cta), 'one that fits to the sat is SEND, not NOT ENOUGH', String(s.cta));
}
{
  const s = spec(160000, 160931, 1158, 5000);
  ok(s.cta === 'NOT ENOUGH' && s.warn === 'PENDING', 'and when what is short is held with the mint, that is the reason given', s.cta + ' / ' + s.warn);
}
{
  const none = spec(160000, 160931, 1158, 0, { wallet: { payNeed: () => null } });
  ok(/^SEND /.test(none.cta), 'a wallet that cannot say leaves SEND as it was: the payment itself refuses', String(none.cta));
  const broke = spec(160000, 160931, 1158, 0, { wallet: { payNeed: () => { throw new Error('no wallet'); } } });
  ok(/^SEND /.test(broke.cta), 'and one that throws does not break the screen', String(broke.cta));
  const old = spec(160000, 160931, 1158, 0, { wallet: { payNeed: undefined } });
  ok(/^SEND /.test(old.cta), 'nor does a wallet with no such question');
}

// ---- CHECKING: the question being asked, and the connection it needs ----------
{
  const s = spec(160000, 160931, null, 0, { asking: true });
  ok(s.cta !== 'CLOSE', 'while the fee is still being asked for, the invoice alone is what is checked', String(s.cta));
  ok(s.cta === 'CHECKING…' && s.ctaBusy === true, 'and the button says CHECKING and is busy, not SEND', s.cta + ' / ' + s.ctaBusy);
  ok(s.fee === 'CHECKING…', 'the FEE row says the same word', s.fee);
  s.go();
  ok(s.sent.start === 0, 'and pressing it does nothing');
}
{
  const s = spec(100000, 160931, null, 0, { connecting: true });
  ok(s.cta === 'CHECKING…' && s.ctaBusy === true && s.fee === 'CHECKING…',
     'a connection on its way holds the button the same, and the FEE row says it too', s.cta + ' / ' + s.fee);
  s.go();
  ok(s.sent.start === 0 && s.sent.back === 0, 'nothing happens when it is pressed');
  ok(!!s.secondary, 'and the note is still there to be added: only what needs the connection waits');
}
{
  const s = spec(100000, 160931, 1000, 0, { connecting: true });
  ok(s.cta === 'CHECKING…' && s.fee === 'UP TO ₿ 1000',
     'a quote already in hand stays in its row while the connection it needs is on its way again', s.cta + ' / ' + s.fee);
  const short = spec(160000, 160931, 1158, 0, { connecting: true });
  ok(short.cta === 'NOT ENOUGH', 'and a payment that does not fit says so, connection or not', short.cta);
}
{
  const s = spec(100000, 160931, null, 0, {});
  ok(/^SEND /.test(s.cta) && s.fee === 'UNKNOWN',
     'with no connection and none coming nothing is waited for: SEND, and the fee UNKNOWN', s.cta + ' / ' + s.fee);
  s.go();
  ok(s.sent.start === 1, 'and SEND sends, to be told so by the payment itself');
}
{
  // the button and the FEE row are one state: CHECKING in one is CHECKING in the other
  const states = [];
  for (const connecting of [false, true]) for (const asking of [false, true]) for (const fee of [null, 1000]) {
    const s = spec(100000, 160931, fee, 0, { connecting, asking });
    states.push([connecting, asking, fee, s.cta, s.fee]);
  }
  const apart = states.filter(([c, a, fee, cta, row]) => fee == null && ((cta === 'CHECKING…') !== (row === 'CHECKING…')));
  ok(apart.length === 0, 'with no quote in hand, the FEE row and the button agree in all four states', JSON.stringify(apart));
}
{
  // an invoice over the balance is refused without waiting for a fee
  const s = spec(170000, 160931, null);
  ok(s.cta === 'CLOSE' && /short by ₿ 9069$/.test(s.warn || ''), 'an invoice over the balance is refused without waiting for a fee', s.warn);
  const c = spec(170000, 160931, null, 0, { connecting: true });
  ok(c.cta === 'CLOSE', 'connection on its way or not');
}

// ---- a lightning address: its invoice is looked up, then quoted --------------------
{
  const s = spec(0, 50000, null, 0, { kind: 'email', sats: 2100, connecting: true });
  ok(s.cta === 'CHECKING…' && s.ctaBusy && s.fee === 'CHECKING…', 'an address held for the connection reads CHECKING, and so does its FEE row', s.cta + ' / ' + s.fee);
  const asked = spec(0, 50000, null, 0, { kind: 'email', sats: 2100, asking: true });
  ok(asked.cta === 'CHECKING…' && asked.fee === 'CHECKING…', 'and while it is looked up and quoted', asked.cta + ' / ' + asked.fee);
  const live = spec(0, 50000, 7, 0, { kind: 'email', sats: 2100 });
  ok(/^SEND /.test(live.cta) && live.fee === 'UP TO ₿ 7', 'then SEND, with the fee in the FEE row', live.cta + ' / ' + live.fee);
  const short = spec(0, 2105, 7, 0, { kind: 'email', sats: 2100 });
  ok(short.cta === 'NOT ENOUGH' && short.warn === words(2107, 2105),
     'an address whose invoice, quoted, the balance cannot cover is held the same', short.cta + ' / ' + short.warn);
  const none = spec(0, 50000, null, 0, { kind: 'email', sats: 2100 });
  ok(/^SEND /.test(none.cta) && none.fee === 'UNKNOWN', 'an address that could not be looked up is SEND with the fee UNKNOWN: SEND does all of it, as it did', none.cta + ' / ' + none.fee);
}

// ---- a scanned request: held only where a connection would change what it does -------
/* `shortfall` is what the wallet answers to `sendShortfall`; `o`:
 *   connecting  a connection is on its way
 *   tap         the card is the tap card, with its four digits
 *   req         the request's own fields, over the defaults */
function reqSpec(sats, balance, shortfall, o) {
  const opt = o || {};
  global.window = { FoxyWallet: { sendShortfall: () => shortfall, heldSats: () => 0, mintHost: () => 'mint.example' } };
  const sent = { made: 0 };
  const app = {
    state: { screen: 'reqOffer', balSats: balance, tapCode: opt.tap ? '1234' : '', note: '',
             req: Object.assign({ sats: sats, mints: ['https://mint.example'], transports: [], viaTap: false }, opt.req || {}) },
    cfRow: (label, value) => ({ label, value }),
    money: (n) => ({ main: '₿ ' + n, sub: '' }),
    heldBlocks: () => '', mintName: () => 'MINT', px: () => 0, peerRateRow: () => [],
    connecting: () => !!opt.connecting, offlineNow: () => !!opt.connecting,
    requestNeedsRoute, makeTokenForRequest() { sent.made += 1; },
  };
  const any = new Proxy(app, { get: (t, k) => (k in t ? t[k] : () => '') });
  const s = requestSpec.call(any);
  s.sent = sent;
  s.fee = (s.rows.find((r) => r.label === 'FEE') || {}).value;
  return s;
}
const NOSTR = { delivery: { kind: 'nostr', target: 'npub1…' }, transports: ['nostr'] };
{
  const s = reqSpec(900, 979, { need: 911, fee: 11, have: 979, short: false }, { connecting: true, req: NOSTR });
  ok(s.cta === 'CHECKING…' && s.ctaBusy === true && s.fee === 'CHECKING…',
     'a request that is delivered over the route is held while the connection is on its way, its FEE row the same', s.cta + ' / ' + s.fee);
  s.go();
  ok(s.sent.made === 0, 'and pressing it makes nothing');
  ok(!!s.secondary && typeof s.close === 'function', 'with the note and the way out still there');
  const up = reqSpec(900, 979, { need: 911, fee: 11, have: 979, short: false }, { req: NOSTR });
  ok(/^PAY /.test(up.cta) && !up.ctaBusy && up.fee === '₿ 11', 'once the connection is up it reads what it read', up.cta + ' / ' + up.fee);
  up.go();
  ok(up.sent.made === 1, 'and pays');
}
{
  const lock = reqSpec(900, 979, { need: 911, fee: 11, have: 979, short: false }, { connecting: true, req: { lockTo: '02' + 'ab'.repeat(32) } });
  ok(lock.cta === 'CHECKING…', 'one that asks for a lock, which is made by a swap, is held', lock.cta);
  const other = reqSpec(900, 979, { need: 911, fee: 11, have: 979, short: false }, { connecting: true, req: { mints: ['https://other.example'] } });
  ok(other.cta === 'CHECKING…', 'and one for another mint, which must be connected to first', other.cta);
  const plain = reqSpec(900, 979, { need: 911, fee: 11, have: 979, short: false }, { connecting: true });
  ok(plain.cta === 'GENERATE ECASH TOKEN' && !plain.ctaBusy, 'a token to show them, from the pieces on hand, needs no connection and is not waited on', plain.cta);
  const tap = reqSpec(900, 979, { need: 911, fee: 11, have: 979, short: false }, { connecting: true, tap: true, req: Object.assign({ viaTap: true }, NOSTR) });
  ok(tap.cta !== 'CHECKING…' && !tap.ctaBusy, 'nor is one that came over the Bluetooth link in hand, which carries it', tap.cta);
  const short = reqSpec(980, 979, { need: 991, fee: 11, have: 979, short: true }, { connecting: true, req: NOSTR });
  ok(short.cta === 'CLOSE', 'and a request the balance cannot cover is refused, connection or not', short.cta);
}

/* The same rule on the tap card. A phone held 979 sats, was asked for
 * 980 at its own mint, saw SEND, pressed it and was refused for the fee, three
 * times running. The wallet's own sum answers before SEND. */
{
  const s = reqSpec(980, 979, { need: 991, fee: 11, have: 979, short: true }, { tap: true, req: { viaTap: true } });
  ok(s.cta === 'CLOSE' && /short by ₿ 12 with the fee/.test(s.warn || ''),
     'a tap request the balance cannot cover with the fee is refused on the card', s.cta + ' / ' + s.warn);
  ok(s.rows.some((r) => r.label === 'FEE' && r.value === '₿ 11'), 'and the fee row says what the fee is');
}
{
  const s = reqSpec(900, 979, { need: 911, fee: 11, have: 979, short: false }, { tap: true, req: { viaTap: true } });
  ok(/^SEND /.test(s.cta) && !s.warn, 'one that fits with its fee goes on to SEND', String(s.cta));
}
{
  const s = reqSpec(980, 979, null, { tap: true, req: { viaTap: true } });
  ok(s.cta === 'CLOSE' && /short by ₿ 1$/.test(s.warn || ''), 'with no wallet to ask, the balance alone still refuses', s.warn);
}

/* The way back from a send that did not happen.
 *
 * The app's own startSend, startSendNow, toConfirm, toAmount and back, with a
 * wallet whose payment fails and a card that only records what it was asked to
 * show. Each failure — the mint saying no, no connection, Tor reconnecting, bad
 * signatures, a balance that does not cover the payment — has to land on the
 * confirmation (or, for the balance, the amount screen) with the stack as it
 * was before SEND, so that one press of the back arrow leaves it. And the hold
 * (`syncSend`, `notOnlineCard`) runs on the real methods, with a route that
 * is coming and then is not. */
const lifted = lift([
  'startSend() {', 'startSendNow(to) {', 'toConfirm() {', 'toAmount() {', 'back() {',
  'badSignatureCard(host, where, onClose) {', 'isBadSignatures(e) {',
  'typedSats() {', 'sendAsk() {', 'sendToAsk() {', 'quoteSendFee() {', 'syncSend() {', 'notOnlineCard() {',
  'connecting() {', 'offlineNow() {', 'offlineInvoiceCard() {',
]);

const sendApp = (W, gate) => {
  global.window = { FoxyWallet: W, FoxyGate: gate };
  return Object.assign({
    state: { screen: 'sendConfirm', stack: ['home', 'amount'], sendPhase: null,
             recipientKind: 'invoice', recipient: 'lnbc1…', unit: 'SATS', note: '' },
    cards: [],
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    wantedSats: () => 1000,
    blockedCard(kind, over) { this.cards.push(Object.assign({ kind }, over || {})); },
    showPayPending() { this.cards.push({ kind: 'payPending' }); },
  }, lifted);
};
const wallet = (failure, connected) => ({
  connected: connected !== false,
  pendingMelts: () => [], classify: () => 'invoice', amountOf: () => 1000,
  pay: () => Promise.reject(new Error(failure)), reason: (e) => e.message,
});
// the failure has gone through the send's promise chain
const settled = () => new Promise(r => setTimeout(r, 0));
const where = (a) => a.state.screen + ' ' + JSON.stringify(a.state.stack);
const SENDING = 'sendDone ["home","amount","sendConfirm"]';
const BEFORE = 'sendConfirm ["home","amount"]';
const LEFT = 'amount ["home"]';

async function waysBack() {
  const loud = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try {
    {
      const a = sendApp(wallet('Invoice already paid'));
      a.startSend();
      ok(where(a) === SENDING, 'SEND moves to the sending screen with the confirmation pushed onto the stack', where(a));
      await settled();
      const card = a.cards.find(c => c.kind === 'mintRefused');
      ok(!!card, 'the mint saying no is a card over the confirmation', a.cards.map(c => c.kind).join());
      ok(where(a) === BEFORE, 'which shows with the stack as it was before SEND', where(a));
      if (card) card.onClose();
      ok(where(a) === BEFORE, 'closing the card changes nothing more', where(a));
      a.back();
      ok(where(a) === LEFT, 'and one press of the back arrow leaves it', where(a));
    }
    {
      const a = sendApp(wallet('Invoice already paid'));
      a.startSend();
      await settled();
      // TRY AGAIN: the card closes, then runs what it was given
      const card = a.cards.find(c => c.kind === 'mintRefused');
      if (card) { card.onClose(); card.go(); }
      ok(where(a) === SENDING, 'TRY AGAIN pushes the confirmation once, not once more', where(a));
      await settled();
      ok(where(a) === BEFORE, 'and a second refusal lands on the same stack', where(a));
    }
    {
      const a = sendApp(wallet('', false));
      a.startSend();
      const card = a.cards.find(c => c.kind === 'netLost');
      ok(!!card && where(a) === SENDING, 'with no connection, the card comes up over the sending screen', where(a));
      if (card) card.onClose();
      ok(where(a) === BEFORE, 'closing it is the confirmation with the stack as before', where(a));
      a.back();
      ok(where(a) === LEFT, 'and one press leaves', where(a));
    }
    {
      const a = sendApp(wallet('x'), { recheck: () => Promise.resolve(false) });
      await a.startSend();
      const card = a.cards.find(c => c.kind === 'netLost' && c.title === 'RECONNECTING TO TOR');
      ok(!!card, 'a Tor that is reconnecting is its own card', a.cards.map(c => c.kind + ':' + (c.title || '')).join());
      if (card) card.onClose();
      ok(where(a) === BEFORE, 'closing it is the confirmation with the stack as before', where(a));
      a.back();
      ok(where(a) === LEFT, 'and one press leaves', where(a));
    }
    {
      const a = sendApp(wallet('DLEQ verification failed'));
      a.startSend();
      await settled();
      const card = a.cards.find(c => c.kind === 'mintTrouble');
      ok(!!card, 'bad signatures are the mint-trouble card', a.cards.map(c => c.kind).join());
      if (card) card.onClose();
      ok(where(a) === BEFORE, 'closing it is the confirmation with the stack as before', where(a));
      a.back();
      ok(where(a) === LEFT, 'and one press leaves', where(a));
    }
    {
      // a refusal for want of a connection is still a refusal to try again
      const a = sendApp(wallet('Foxy is securing its connection. Try again in a moment.'));
      a.startSend();
      await settled();
      const card = a.cards.find(c => c.kind === 'netLost');
      ok(!!card && card.retry === 'TRY AGAIN' && typeof card.go === 'function',
         'a refusal for want of a connection still offers TRY AGAIN', a.cards.map(c => c.kind + ':' + c.retry).join());
      if (card) card.onClose();
      ok(where(a) === BEFORE, 'and closes onto the confirmation with the stack as before', where(a));
    }
  } finally {
    console.log = loud.log; console.error = loud.error;
  }
}

/* The balance that does not cover the payment, refused at the send itself: the
 * reserve moved between the quote and the send, or no quote was asked for. The
 * card says the wallet's sentence and has no TRY AGAIN, and goes to the amount
 * screen, the one place the sum can be changed — not back to a confirmation
 * that would say the same again. */
async function refusedForWantOfBalance() {
  const loud = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try {
    const sentence = words(161158, 160931);
    {
      const a = sendApp(wallet(sentence));
      a.startSend();
      await settled();
      const card = a.cards.find(c => c.kind === 'sendFail');
      ok(!!card && card.reason === sentence,
         'a send the wallet still refuses for want of balance puts the same words on a card', a.cards.map(c => c.kind + ':' + c.reason).join());
      ok(!!card && card.retry === 'CHANGE AMOUNT' && card.back === 'amount',
         'with no TRY AGAIN: its one button names where it goes', card && (card.retry + ' / ' + card.back));
      ok(where(a) === BEFORE, 'the confirmation is under it while it is up, with the stack as it was before SEND', where(a));
      if (card) card.onClose();
      ok(where(a) === LEFT, 'closing it goes to the amount screen, not back to the confirmation, and leaves no entry of the confirmation behind', where(a));
      a.back();
      ok(where(a) === 'home []', 'and one press of the back arrow from there leaves the payment', where(a));
    }
    {
      // the card's button does the same as its closing, and only once
      const a = sendApp(wallet(sentence));
      a.startSend();
      await settled();
      const card = a.cards.find(c => c.kind === 'sendFail');
      if (card) { card.onClose(); card.go(); }
      ok(where(a) === LEFT, 'its button, which runs after the closing, changes nothing more', where(a));
    }
    {
      // from the sending screen itself, with the confirmation's entry still under it: the entry goes with the screen
      const a = sendApp(wallet(sentence));
      a.startSend();
      ok(where(a) === SENDING, 'the sending screen has the confirmation\'s entry on the stack under it', where(a));
      a.toAmount();
      ok(where(a) === LEFT, 'and the amount screen, reached from there, leaves none of it to be gone back to', where(a));
      await settled();
    }
    {
      // a payment that came with its own amount has no amount screen: it is the screen it came from
      const a = sendApp(wallet(sentence));
      a.state.stack = ['home', 'sendScan'];
      a.startSend();
      await settled();
      const card = a.cards.find(c => c.kind === 'sendFail');
      if (card) card.onClose();
      ok(where(a) === 'sendScan ["home"]', 'a scanned invoice goes back to the scan, which is where it came from', where(a));
    }
    {
      // sends tried and refused before it: one entry of the confirmation per attempt would pile up; none does
      const W = wallet('Invoice already paid');
      const a = sendApp(W);
      a.startSend();
      await settled();
      a.cards.find(c => c.kind === 'mintRefused').onClose();
      a.startSend();
      await settled();
      ok(where(a) === BEFORE, 'a send tried again lands on the stack it started from', where(a));
      W.pay = () => Promise.reject(new Error(sentence));
      a.startSend();
      await settled();
      const card = a.cards.find(c => c.kind === 'sendFail');
      if (card) card.onClose();
      ok(!!card && where(a) === LEFT, 'and whatever was tried before the refusal for balance, the amount screen has one entry under it', where(a));
    }
  } finally {
    console.log = loud.log; console.error = loud.error;
  }
}

/* A connection that was waited for and did not come. The confirmation holds
 * its button while Tor is at work (CHECKING), and when Tor then gives up, or
 * the network goes, says so in the card a payment gets with no connection, with
 * the confirmation under it as it was. Nothing is pushed, so there is nothing
 * to drop: one press of the back arrow leaves, as it did before the hold. A
 * connection that did come asks by itself and shows no card. */
async function theHeldConfirmation() {
  const loud = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try {
    const held = (kind, route, asked) => {
      const a = sendApp({
        connected: true, pendingMelts: () => [],
        privacy: () => ({ offline: route.offline }), routeComing: () => route.coming,
        classify: (t) => (/^lnbc/.test(String(t)) ? 'invoice' : 'lnurl'),
        amountOf: (inv) => (/^lnbc/.test(String(inv)) ? 2100 : null),
        quoteFee: () => { asked.quote += 1; return new Promise(() => {}); },
        lookupLnurl: () => { asked.lookup += 1; return new Promise(() => {}); },
        reason: (e) => String(e && e.message),
      });
      a.state.recipientKind = kind;
      a.state.recipient = kind === 'invoice' ? 'lnbc2100n1stub' : 'alice@example.com';
      return a;
    };
    for (const kind of ['invoice', 'email']) {
      const what = kind === 'invoice' ? 'an invoice' : 'an address';
      const route = { coming: true, offline: true };
      const asked = { quote: 0, lookup: 0 };
      const a = held(kind, route, asked);
      a.syncSend();
      await settled();
      ok(a.cards.length === 0 && asked.quote + asked.lookup === 0 && where(a) === BEFORE,
         what + ' waits for the connection that is on its way: no card, nothing asked', a.cards.length + ' cards, ' + JSON.stringify(asked) + ' ' + where(a));
      route.coming = false; // Tor gives up (still offline)
      a.syncSend();
      const card = a.cards[0];
      ok(a.cards.length === 1 && card.kind === (kind === 'invoice' ? 'offlineInvoice' : 'offlineAddress'),
         'Tor giving up is the card for no connection, as ' + what + ' scanned with none gets', a.cards.map(c => c.kind).join());
      ok(where(a) === BEFORE, 'with the confirmation under it and the stack as it was: nothing pushed, nothing to drop', where(a));
      a.syncSend();
      ok(a.cards.length === 1, 'said once, not at every update');
      a.back();
      ok(where(a) === LEFT, 'and one press of the back arrow leaves', where(a));
    }
    for (const kind of ['invoice', 'email']) {
      const route = { coming: true, offline: true };
      const asked = { quote: 0, lookup: 0 };
      const a = held(kind, route, asked);
      a.syncSend();
      route.coming = false; route.offline = false; // the route is up
      a.syncSend();
      await settled();
      ok(a.cards.length === 0 && (kind === 'invoice' ? asked.quote === 1 : asked.lookup === 1) && where(a) === BEFORE,
         'a connection that comes asks by itself, with no card and the stack as it was', a.cards.length + ' cards, ' + JSON.stringify(asked) + ' ' + where(a));
    }
  } finally {
    console.log = loud.log; console.error = loud.error;
  }
}

waysBack().then(refusedForWantOfBalance).then(theHeldConfirmation).then(() => {
  console.log('\n' + (failed ? failed + ' send-fee-check check(s) failed' : 'all send-fee-check checks pass'));
  process.exit(failed ? 1 : 0);
}, (e) => {
  console.log('THREW ' + ((e && e.stack) || e));
  process.exit(1);
});
