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
 * Then the same rule on the tap card, and the way back from a send that did
 * not happen: SEND pushes the confirmation onto the screen stack as it moves
 * to the sending screen, and every return to the confirmation has to drop
 * that entry again, or the first press of its back arrow pops the entry and
 * changes nothing on screen.
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
const at = src.indexOf('\n  confirmSpec() {');
const confirmSpec = new Function('return {' + block(at + 3) + '}')().confirmSpec;
const atReq = src.indexOf('\n  requestSpec() {');
const requestSpec = new Function('return {' + block(atReq + 3) + '}')().requestSpec;

function spec(invoiceSats, balance, quotedFee, held) {
  global.window = { FoxyWallet: { amountOf: () => invoiceSats, heldSats: () => held || 0 } };
  const app = {
    state: { screen: 'sendConfirm', recipientKind: 'invoice', recipient: 'lnbc1…', balSats: balance,
             quotedFee: quotedFee, quotingFee: quotedFee == null, amount: '0', unit: 'SATS', sendPriceCheck: 'agreed' },
    cfRow: (label, value) => ({ label, value }),
    sendToText: () => 'lnbc1…',
    sendAmountText: () => String(invoiceSats),
    money: (n) => ({ main: '₿ ' + n, sub: '' }),
    heldBlocks(shortBy) { return (held > 0 && shortBy > 0 && shortBy <= held) ? 'PENDING' : ''; },
    back() {}, px: () => 0, peerRateRow: () => [],
  };
  // anything else the screen asks of the app is not what is being tested
  const any = new Proxy(app, { get: (t, k) => (k in t ? t[k] : () => '') });
  return confirmSpec.call(any);
}

{
  const s = spec(160000, 160931, 1158);
  ok(s.cta === 'CLOSE' && /short by ₿ 227 with the fee/.test(s.warn || ''),
     'an invoice that fits on its own and not with its fee is refused on the confirmation', s.cta + ' / ' + s.warn);
  ok(s.amountInk === '#FF5C5C', 'with the amount in red');
}
{
  const s = spec(100000, 160931, 1000);
  ok(s.cta !== 'CLOSE' && !s.warn, 'one that fits with its fee goes on to SEND', String(s.cta));
}
{
  const s = spec(160000, 160931, null);
  ok(s.cta !== 'CLOSE', 'while the fee is still being asked for, the invoice alone is what is checked', String(s.cta));
  ok(/^CHECKING FEE/.test(s.cta) && s.ctaBusy === true, 'and the button says CHECKING FEE and is busy, not SEND', s.cta + ' / ' + s.ctaBusy);
  const live = spec(100000, 160931, 1000);
  ok(/^SEND /.test(live.cta) && !live.ctaBusy, 'once the fee is in it is SEND again', String(live.cta));
}
{
  const s = spec(170000, 160931, null);
  ok(s.cta === 'CLOSE' && /short by ₿ 9069$/.test(s.warn || ''), 'an invoice over the balance is refused without waiting for a fee', s.warn);
}
{
  const s = spec(160000, 160931, 1158, 5000);
  ok(s.cta === 'CLOSE' && s.warn === 'PENDING', 'and when what is short is held with the mint, that is the reason given', s.warn);
}

/* The same rule on the tap card. A phone held 979 sats, was asked for
 * 980 at its own mint, saw SEND, pressed it and was refused for the fee, three
 * times running. The wallet's own sum answers before SEND. */
function reqSpec(sats, balance, shortfall) {
  global.window = { FoxyWallet: { sendShortfall: () => shortfall, heldSats: () => 0 } };
  const app = {
    state: { screen: 'reqOffer', balSats: balance, tapCode: '1234', note: '',
             req: { sats: sats, mints: ['https://mint.example'], transports: [], viaTap: true } },
    cfRow: (label, value) => ({ label, value }),
    money: (n) => ({ main: '₿ ' + n, sub: '' }),
    heldBlocks: () => '', mintName: () => 'MINT', px: () => 0, peerRateRow: () => [],
  };
  const any = new Proxy(app, { get: (t, k) => (k in t ? t[k] : () => '') });
  return requestSpec.call(any);
}
{
  const s = reqSpec(980, 979, { need: 991, fee: 11, have: 979, short: true });
  ok(s.cta === 'CLOSE' && /short by ₿ 12 with the fee/.test(s.warn || ''),
     'a tap request the balance cannot cover with the fee is refused on the card', s.cta + ' / ' + s.warn);
  ok(s.rows.some(r => r.label === 'FEE' && r.value === '₿ 11'), 'and the fee row says what the fee is');
}
{
  const s = reqSpec(900, 979, { need: 911, fee: 11, have: 979, short: false });
  ok(/^SEND /.test(s.cta) && !s.warn, 'one that fits with its fee goes on to SEND', String(s.cta));
}
{
  const s = reqSpec(980, 979, null);
  ok(s.cta === 'CLOSE' && /short by ₿ 1$/.test(s.warn || ''), 'with no wallet to ask, the balance alone still refuses', s.warn);
}

/* The way back from a send that did not happen.
 *
 * The app's own startSend, startSendNow, toConfirm and back, with a wallet
 * whose payment fails and a card that only records what it was asked to show.
 * Each failure — the mint saying no, no connection, Tor reconnecting, bad
 * signatures — has to land on the confirmation with the stack as it was before
 * SEND, so that one press of the back arrow leaves it. */
const method = (sig) => {
  const i = src.indexOf('\n  ' + sig);
  if (i < 0) throw new Error('missing ' + sig);
  return block(i + 3);
};
const lifted = new Function('return {' + [
  'startSend() {', 'startSendNow(to) {', 'toConfirm() {', 'back() {',
  'badSignatureCard(host, where, onClose) {', 'isBadSignatures(e) {',
].map(method).join(',\n') + '}')();

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
  } finally {
    console.log = loud.log; console.error = loud.error;
  }
}

waysBack().then(() => {
  console.log('\n' + (failed ? failed + ' send-fee-check check(s) failed' : 'all send-fee-check checks pass'));
  process.exit(failed ? 1 : 0);
}, (e) => {
  console.log('THREW ' + ((e && e.stack) || e));
  process.exit(1);
});
