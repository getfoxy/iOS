'use strict';
/* source-interface.js — the seam's contract.
 *
 *     node tests/source-interface.js
 *
 * The wallet answers money questions through one source at a time
 * (build/wallet/09-source.js). What this pins:
 *   - sourceId() is the connected mint's URL, byte for byte — so every key,
 *     scope and record that used to read mintUrl reads the same string now
 *   - the source's kind is 'cashu' and all twelve verbs are there
 *   - a verb through the source answers the wallet's own answer (balance)
 *   - the mintUrl getter is untouched for the flows that juggle mint URLs
 */
const { connected } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

async function run() {
  const ctx = await connected({});
  const W = ctx.W;

  ok(typeof W.sourceId === 'function', 'the wallet has sourceId()');
  ok(typeof W.source === 'function', 'the wallet has source()');
  if (typeof W.sourceId !== 'function' || typeof W.source !== 'function') {
    console.log('\n' + failed + ' source-interface check(s) failed');
    process.exit(1);
  }

  ok(W.sourceId() === W.mintUrl, 'sourceId() is the mint URL, byte for byte');
  ok(W.mintUrl.indexOf('m.test') >= 0, 'the mintUrl getter is unchanged');

  const s = W.source();
  ok(s && typeof s === 'object', 'source() answers an object');
  ok(s.kind === 'cashu', 'the only kind is cashu');

  const VERBS = ['info', 'balance', 'invoice', 'watchInvoice', 'payQuote', 'pay',
                 'sendEcash', 'receiveEcash', 'onchainAddress', 'onchainQuote',
                 'onchainPay', 'recover'];
  ok(VERBS.length === 12, 'the contract is twelve verbs');
  for (const v of VERBS) ok(typeof s[v] === 'function', 'the source has ' + v + '()');

  ok(s.sourceId() === W.mintUrl, 'source.sourceId() is the mint URL, byte for byte');

  const direct = await W.balanceSats();
  const viaSource = await s.balance();
  ok(viaSource === direct && viaSource === 0, 'balance through the source is the wallet’s own',
     String(viaSource) + ' vs ' + String(direct));

  const info = await s.info();
  ok(info === null || typeof info === 'object', 'info is null or the mint’s own record');

  /* Ask again after a verb ran: the adapter holds no state of its own. */
  ok(s.sourceId() === W.mintUrl, 'source id still the mint’s URL after a verb');

  console.log('\n' + (failed ? failed + ' source-interface check(s) failed'
    : 'all source-interface checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
