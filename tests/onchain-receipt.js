'use strict';
/* onchain-receipt.js — what an on-chain payment can be checked against.
 *
 *     node tests/onchain-receipt.js
 *
 * Two things the detail screen used to get wrong about a payment on chain.
 *
 * The address was elided to seventeen characters and only the elided form was
 * ever written down, so the full one could not be recovered at all. Nothing
 * caught it because every on-chain test pays `bc1qpayee`, which is nine
 * characters — under `shortAddress`'s twenty — so the elision never fired in a
 * test in its life. This one pays a real forty-two character bech32 address.
 *
 * And PAYMENT ID is the mint's NUT-30 melt quote id with `onchain-` in front of
 * it. Pasted into mempool.space it finds nothing, which is fair:
 * no explorer has heard of a mint's bookkeeping. The melt quote carries an
 * `outpoint` — `txid:vout` — which the wallet has been resolving all along and
 * the app discarded every time.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'build', 'foxy-app.js'), 'utf8');
const wallet = fs.readFileSync(path.join(root, 'build', 'wallet', '16a-onchain.js'), 'utf8');
const markup = fs.readFileSync(path.join(root, 'build', 'markup.html'), 'utf8');

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function body(src, sig, label) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error('missing ' + (label || sig));
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}

/* 1 — the txid really is validated, not just sliced ------------------------ */

const ocTxidOf = new Function('return function (outpoint) '
  + body(app, 'ocTxidOf(outpoint) {', 'ocTxidOf').slice('ocTxidOf(outpoint) '.length) + ';')();

const TXID = 'd4e5f6a7b8c90123456789abcdef0123456789abcdef0123456789abcdef0123';
const cases = [
  [TXID + ':0', TXID, 'a real outpoint gives the transaction id'],
  [TXID + ':7', TXID, 'the output index is dropped'],
  [TXID.toUpperCase() + ':0', TXID, 'upper case is folded, because explorers take either'],
  [null, '', 'null — the mint has not broadcast yet — gives nothing'],
  [undefined, '', 'undefined gives nothing'],
  ['', '', 'empty gives nothing'],
  ['deadbeef:0', '', 'too short is refused rather than shown'],
  [TXID.slice(0, 63) + ':0', '', '63 characters is refused'],
  [TXID + 'ab:0', '', '66 characters is refused'],
  ['zz' + TXID.slice(2) + ':0', '', 'non-hex is refused'],
  ['onchain-01a0dae3-c16d:0', '', 'a melt quote id is not a transaction id'],
];
let good = 0;
for (const [input, want, why] of cases) {
  const got = ocTxidOf(input);
  if (got === want) good++; else check(why, false, 'got ' + JSON.stringify(got));
}
check('the transaction id is checked, not trusted', good === cases.length,
  good + '/' + cases.length + ' inputs');

/* 2 — the full address is written down ------------------------------------- */

check('the send tags the whole address beside the elided one',
  /tag\(entry,\s*\{[^}]*to:\s*shortAddress\(plan\.address\)[^}]*address:\s*plan\.address/.test(wallet),
  'to stays short for the tile; address is the full one');

/* `to` must stay elided: the paid confirmation, the announcement and the list
 * tile all render it as a single line with room for about seventeen characters.
 * Making it the full address is the tempting wrong fix. */
check('the elided form is still what `to` holds',
  /to:\s*shortAddress\(plan\.address\)/.test(wallet),
  'paidTo and the tile have no room for forty-two characters');

const rows = body(app, 'buckets[key].push({', 'the history row');
check('the detail screen prefers the full address', /party:\s*meta\.address\s*\|\|\s*who/.test(rows));
check('the list tile keeps the short one', /name:\s*who\b/.test(rows));
check('the row carries the transaction id', /txid:\s*meta\.txid\s*\|\|\s*''/.test(rows));

/* 3 — the transaction id is persisted from both places it can appear -------- */

const pay = body(app, 'ocPay() {', 'ocPay');
check('the melt answer is mined for a transaction id',
  /ocTxidOf\(done\.outpoint\)/.test(pay) && /tag\('onchain-'\s*\+\s*done\.quote,\s*\{\s*txid/.test(pay));

const watch = app.slice(app.indexOf('onchainFollow(record.quote)'));
const follow = watch.slice(0, watch.indexOf("again(120000)"));
check('every watch pass is mined too', /ocTxidOf\(answer\.outpoint\)/.test(follow),
  'the mint answers outpoint: null until it broadcasts, so this is where it arrives');
/* Before the PAID test, or a payment seen once as PENDING and then PAID would
 * have its outpoint read only on the pass that returns early. */
const txidAt = follow.indexOf('ocTxidOf(answer.outpoint)');
const paidAt = follow.indexOf("answer.state === 'PAID'");
check('it is read before the PAID branch returns', txidAt >= 0 && paidAt >= 0 && txidAt < paidAt,
  'PENDING is exactly when the outpoint first appears');

/* 4 — and shown, only when there is one ------------------------------------ */

check('the screen offers a TXID row', /txTxid:\s*tx\.txid/.test(app) && /txHasTxid:\s*!!tx\.txid/.test(app));
check('the row is gated, so other rails get no empty label',
  /txHasTxid/.test(markup) && /<sc-if value="\{\{ txHasTxid \}\}">/.test(markup));
check('the transaction id can be copied', /txCopyTxid/.test(app) && /txCopyTxid/.test(markup),
  'sixty-four characters is not read off one screen into another');

console.log('\n' + (R.fail ? 'FAILED ' + R.fail : 'PASSED ' + R.pass) + ' of ' + (R.pass + R.fail));
process.exit(R.fail ? 1 : 0);
