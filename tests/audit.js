'use strict';
/* audit.js — the history audit's arithmetic.
 *
 *     node tests/audit.js
 *
 * The card on the history screen walks back from the balance through every
 * payment and says whether they account for it. It was wrong three times in a
 * week, each found on a phone: change that came back counted twice (off by one
 * sat for the life of the wallet), a payment whose answer never came left out
 * (off by exactly that payment), and change not yet collected read as a
 * mismatch. Each of those is pinned here, with the cases around them.
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
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  return block(at + 3);
}
const methods = new Function('return {' + ['histAudit() {', 'txTotalOut(t) {', 'heldNote() {', 'heldBlocks(shortBy) {'].map(method).join(',') + '}')();

global.window = { FoxyWallet: { heldSats: () => 0 } };
const quiet = console.log;
function audit(balance, rows, extra) {
  const a = Object.assign({
    state: Object.assign({ balSats: balance, history: [{ items: rows }], historyComplete: true, fresh: false }, extra || {}),
  }, methods);
  console.log = () => {};
  try { return a.histAudit(); } finally { console.log = quiet; }
}
const inn = (sats, o) => Object.assign({ dir: 'in', sats, hash: 'in-' + Math.random() }, o || {});
const out = (sats, o) => Object.assign({ dir: 'out', sats, hash: 'out-' + Math.random() }, o || {});

// newest first, as the list is kept
{
  const r = audit(70, [out(30), inn(100)]);
  ok(r.whole && r.off === 0, 'a receive and a payment that explain the balance add up', 'off ' + r.off);
  const short = audit(60, [out(30), inn(100)]);
  ok(short.off === -10, 'ten sats fewer than they explain is off by -10', String(short.off));
  const more = audit(90, [out(30), inn(100)]);
  ok(more.off === 20, 'and twenty more is off by 20', String(more.off));
}
{
  const r = audit(69, [out(30, { fee: 1 }), inn(100)]);
  ok(r.off === 0, 'a payment costs its fee as well', String(r.off));
}
{
  // 2,366 paid, 1 sat of change came back over the link: one payment at its net, and the change's own row
  const rows = [inn(1, { hash: 'req-change-1790', changeRow: true }),
                out(2365, { grossSats: 2366, changeSats: 1, changeState: 'came back' }), inn(3000)];
  ok(audit(635, rows).off === 0, 'change that came back is counted once, on its payment', String(audit(635, rows).off));
  const byHash = [inn(1, { hash: 'tap-change-1790' }), rows[1], rows[2]];
  ok(audit(635, byHash).off === 0, 'whether the row is known by its tag or by its name');
  const plain = [inn(1, { hash: 'token-1790' }), rows[1], rows[2]];
  ok(audit(635, plain).off !== 0, 'and a separate receive of one sat is still a receive', String(audit(635, plain).off));
}
{
  // handed over and never answered: the pieces left, the row says pending
  const rows = [out(5916, { pending: true }), inn(5916)];
  ok(audit(0, rows).off === 0, 'a payment still waiting to be confirmed has left the balance', String(audit(0, rows).off));
  const waiting = [inn(500, { pending: true }), inn(100)];
  ok(audit(100, waiting).off === 0, 'a receive still waiting has not arrived', String(audit(100, waiting).off));
}
{
  const rows = [inn(40, { failed: true }), out(10, { failed: true }), inn(25, { atRisk: true }),
                inn(9, { split: true }), inn(7, { unit: 'usd' }), inn(100)];
  ok(audit(100, rows).off === 0, 'failed, at risk, a bill being collected and another unit move nothing', String(audit(100, rows).off));
}
{
  // paid 1,180 with a 23,606 piece; the change has not come back
  const owed = out(1180, { grossSats: 23606, changeSats: 22426, changeState: 'owed' });
  const r = audit(0, [owed, inn(23606)]);
  ok(r.off === 0, 'a payment whose change is owed cost its gross so far', String(r.off));
  ok(r.dueChange === 22426 && r.dueCount === 1, 'and the change is named as due', r.dueChange + ' / ' + r.dueCount);
  ok(r.flagged.has(owed) && r.flagged.get(owed) === 'Change not collected', 'on the payment it belongs to');
  // collected later by scanning: the payment at its gross, the change as its own row
  const done = [inn(22426), out(23606, { grossSats: 23606, changeSats: 22426, changeState: 'collected' }), inn(23606)];
  const c = audit(22426, done);
  ok(c.off === 0 && c.dueChange === 0 && c.flagged.size === 0, 'once collected it adds up and nothing is due', 'off ' + c.off);
  const never = out(23606, { grossSats: 23606, changeSats: 22426, changeState: 'never came' });
  const n = audit(0, [never, inn(23606)]);
  ok(n.off === 0 && n.dueChange === 22426, 'change that never came is still due, and still adds up', n.off + ' / ' + n.dueChange);
}
{
  // the receiver's side: change made and not handed over
  const held = inn(1180, { grossSats: 23606, changeSats: 22426, changeState: 'not handed', token: 'cashuB…' });
  const r = audit(1180, [held]);
  ok(r.off === 0, 'the receiver keeps the net and the audit agrees', String(r.off));
  ok(r.toShowCount === 1 && r.toShowSats === 22426 && r.toShow === held, 'the change to hand over is named, with its payment');
  ok(r.flagged.get(held) === 'Change to hand over', 'and that payment is marked');
  const gone = audit(1180, [inn(1180, { grossSats: 23606, changeSats: 22426, changeState: 'given back' })]);
  ok(gone.toShowCount === 0 && gone.flagged.size === 0, 'handed over, nothing is marked');
  const noCode = audit(1180, [inn(1180, { changeSats: 22426, changeState: 'not handed', token: '' })]);
  ok(noCode.toShowCount === 0, 'with no code to show there is no button to show it');
}
{
  // a top-up swap the mint has not answered: its input is held back, out of the balance, and named
  global.window = { FoxyWallet: { heldSats: () => 32768 } };
  const r = audit(2613, [inn(35381)]);
  ok(r.off === 0 && r.held === 32768, 'sats held back for an unanswered swap are accounted for, not missing', r.off + ' / ' + r.held);
  const really = audit(2000, [inn(35381)]);
  ok(really.off === -613, 'and anything short beyond what is held is still short', String(really.off));
  global.window = { FoxyWallet: { heldSats: () => 0 } };
}
{
  const part = audit(50, [inn(100)], { historyComplete: false });
  ok(!part.whole && part.off === 0, 'a list that is not the whole ledger is not judged', part.whole + ' / ' + part.off);
  const fresh = audit(0, [], { fresh: true });
  ok(!fresh.whole && fresh.off === 0, 'nor is an empty wallet');
}
{
  // the running balance beside each row, newest first
  const a = inn(100), b = out(30), c = inn(5);
  const r = audit(75, [c, b, a]);
  ok(r.balOf.get(c) === 75 && r.balOf.get(b) === 70 && r.balOf.get(a) === 100,
     'each row carries the balance as it stood after it', [r.balOf.get(c), r.balOf.get(b), r.balOf.get(a)].join(', '));
}

// ---- said where a person is about to pay -----------------------------------
{
  const a = Object.assign({ stageMoney: (n) => '$' + (n / 2340).toFixed(0) }, methods);
  global.window = { FoxyWallet: { heldSats: () => 32768 } };
  ok(a.heldNote() === '$14 of your balance is currently pending with the mint. Please wait a minute and try again.',
     'sats held back are said in dollars, with what to do', a.heldNote());
  global.window = { FoxyWallet: { heldSats: () => 0 } };
  ok(a.heldNote() === '', 'and nothing is said when nothing is held');
  // a block, and only when it is the reason
  global.window = { FoxyWallet: { heldSats: () => 32768 } };
  ok(a.heldBlocks(1000) === a.heldNote(), 'a payment short by less than what is held is blocked for that reason', a.heldBlocks(1000));
  ok(a.heldBlocks(32768) === a.heldNote(), 'up to exactly what is held');
  ok(a.heldBlocks(32769) === '', 'one more than that is simply more than the balance', a.heldBlocks(32769));
  ok(a.heldBlocks(0) === '' && a.heldBlocks(-5) === '', 'a payment that fits is not blocked at all');
  global.window = { FoxyWallet: { heldSats: () => 0 } };
  ok(a.heldBlocks(1000) === '', 'and with nothing held it is the ordinary block');
  ok(/priceWarn: sendHeld \? sendHeld/.test(src) && /sendOverLabel: sendHeld \? 'PENDING WITH THE MINT' : 'MORE THAN YOUR BALANCE'/.test(src),
     'on the amount screen it takes the place of MORE THAN YOUR BALANCE, with the amount red and NEXT off');
  ok((src.match(/warn: this\.heldBlocks\(/g) || []).length === 3,
     'and on the three confirmations that already close on a payment over the balance', String((src.match(/warn: this\.heldBlocks\(/g) || []).length));
}

console.log('\n' + (failed ? failed + ' audit check(s) failed' : 'all audit checks pass'));
process.exit(failed ? 1 : 0);
