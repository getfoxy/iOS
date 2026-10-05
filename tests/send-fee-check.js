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
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
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
  let sent = 0;
  const live = spec(100000, 160931, 1000);
  ok(/^SEND /.test(live.cta) && !live.ctaBusy, 'once the fee is in it is SEND again', String(live.cta));
  void sent;
}
{
  const s = spec(170000, 160931, null);
  ok(s.cta === 'CLOSE' && /short by ₿ 9069$/.test(s.warn || ''), 'an invoice over the balance is refused without waiting for a fee', s.warn);
}
{
  const s = spec(160000, 160931, 1158, 5000);
  ok(s.cta === 'CLOSE' && s.warn === 'PENDING', 'and when what is short is held with the mint, that is the reason given', s.warn);
}

console.log('\n' + (failed ? failed + ' send-fee-check check(s) failed' : 'all send-fee-check checks pass'));
process.exit(failed ? 1 : 0);

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

console.log(failed ? failed + ' failed' : 'all send fee checks pass');
process.exit(failed ? 1 : 0);
