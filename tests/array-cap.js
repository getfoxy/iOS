'use strict';
/* array-cap.js — never send a mint a bigger array than it will take.
 *
 *     node tests/array-cap.js
 *
 * NUT-06's `max_array_length`, which CDK 0.18 and Nutshell 0.21 began
 * advertising. cashu-ts reads it and chunks its own checkstate and restore by
 * it; Foxy has two paths that do not go through cashu-ts — the restore walk,
 * and the sent-token watch, which POSTs one Y per proof to /v1/checkstate
 * itself. A mint with a cap below what Foxy sends refuses the whole request:
 * the watch would read 'waiting' for ever on a token that was redeemed, and a
 * refused restore batch ends the walk, which means ecash that is there and not
 * found.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
function fn(sig) {
  const at = src.indexOf('\n  function ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 1, i + 1);
}
const { mintArrayCap, inChunks } =
  new Function(fn('mintArrayCap(w)') + '\n' + fn('inChunks(list, size, run)')
    + '\nreturn { mintArrayCap: mintArrayCap, inChunks: inChunks };')();

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  // ---- what the cap reads -----------------------------------------
  check('a mint that advertises a cap is believed', mintArrayCap({ maxArrayLength: 25 }) === 25);
  check('a mint that advertises nothing gets cashu-ts’s own fallback',
    mintArrayCap({}) === 500 && mintArrayCap(null) === 500, String(mintArrayCap({})));
  check('and nonsense does not become a cap of zero or a fraction',
    [0, -5, 1.5, NaN, Infinity, null, 'lots'].every(v => mintArrayCap({ maxArrayLength: v }) === 500),
    'each falls back to 500');
  /* A number that arrived as a string is still a number the mint meant, and
   * honouring it can only make Foxy ask for less. */
  check('a numeric string is honoured rather than ignored',
    mintArrayCap({ maxArrayLength: '12' }) === 12, String(mintArrayCap({ maxArrayLength: '12' })));

  // ---- the chunker -------------------------------------------------
  {
    const sent = [];
    const out = await inChunks([1, 2, 3, 4, 5, 6, 7], 3, (part) => { sent.push(part.length); return part; });
    check('a list longer than the cap is split', sent.join('+') === '3+3+1', sent.join('+'));
    check('and every piece comes back, in order', out.join(',') === '1,2,3,4,5,6,7', out.join(','));
    check('no piece is bigger than the cap', Math.max(...sent) <= 3, 'largest ' + Math.max(...sent));
  }
  {
    const sent = [];
    await inChunks([1, 2, 3], 10, (part) => { sent.push(part.length); return part; });
    check('a list inside the cap is sent whole, in one request', sent.join('+') === '3', sent.join('+'));
  }
  {
    const sent = [];
    const out = await inChunks([], 10, (part) => { sent.push(part.length); return part; });
    check('an empty list still asks once, so the caller gets an answer',
      sent.length === 1 && out.length === 0);
  }
  {
    // the requests go one at a time: these are Tor round trips to a mint
    const order = [];
    await inChunks([1, 2, 3, 4], 2, (part) => {
      order.push('start' + part[0]);
      return new Promise(ok => setTimeout(() => { order.push('end' + part[0]); ok(part); }, 5));
    });
    check('the pieces go one at a time, not all at once',
      order.join(' ') === 'start1 end1 start3 end3', order.join(' '));
  }
  {
    const worst = [];
    for (const cap of [1, 0, -3, 2.7, NaN]) {
      const sent = [];
      await inChunks([1, 2, 3], cap, (p) => { sent.push(p.length); return p; });
      worst.push(Math.min(...sent));
    }
    check('a silly cap never means a piece of zero length',
      worst.every(n => n >= 1), 'smallest piece per cap: ' + worst.join(','));
  }

  // ---- the two callers ---------------------------------------------
  check('the sent-token watch asks in pieces',
    /inChunks\(rec\.ys, cap,/.test(src), 'tokenClaimState');
  const restore = fs.readFileSync(path.join(__dirname, '..', 'build', 'wallet', '13-restore.js'), 'utf8');
  check('the restore walk takes the smaller of its batch and the cap',
    /Math\.min\(FoxyWallet\.RESTORE_BATCH \|\| 100, mintArrayCap\(ww\)\)/.test(restore));

  console.log('\n' + (R.fail ? R.pass + ' passed, ' + R.fail + ' failed' : 'all ' + R.pass + ' array cap checks pass'));
  process.exit(R.fail ? 1 : 0);
})();
