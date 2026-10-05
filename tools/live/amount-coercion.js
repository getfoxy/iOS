'use strict';
/* amount-coercion.js — no money path may coerce an Amount.
 *
 *   sh tools/live/local-mint.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/amount-coercion.js
 *
 * cashu-ts hands amounts back as an `Amount` object. Reaching one through
 * `Number(x)`, `x + y` or `x > y` goes via Symbol.toPrimitive, which that
 * library deprecated and says will THROW in v5.
 *
 * It was doing it on every melt — `meltFee` called `Number` on the amount the
 * mint reported — which is the worst place in this wallet to throw: the sats
 * have left and the change has not come back (in the middle of melting a
 * cross-mint payment home). A warning is a bug with a date on it, and the
 * date is whenever cashu-ts v5 lands.
 *
 * So every path money takes is walked with the deprecation recorded, and any
 * hit fails this. Mint, swap out, swap in, melt, and a transfer between two
 * real mints.
 *
 * Fake money only — the local Docker mints. */
const H = require('./harness');

setTimeout(() => { console.log('WATCHDOG 600s'); process.exit(2); }, 600000).unref();

const hits = [];
function watch(b, where) {
  const was = b.w.console.warn;
  b.w.console.warn = function (...a) {
    if (/Implicit numeric coercion/.test(a.map(String).join(' '))) {
      hits.push(where + ': ' + String(new Error('x').stack).split('\n').slice(2, 5).join(' | '));
    }
    return was.apply(this, a);
  };
}

async function run() {
  const CDK = H.MINTS.cdk.https, NUT = H.MINTS.nutshell.https;
  const names = await H.mintNames(['cdk', 'nutshell']);
  console.log('\n' + names.cdk + '  <->  ' + names.nutshell + '\n');

  const b = H.boot({ keychain: { words: '' }, quiet: true });
  await b.W.seedReady();
  await b.W.connect(CDK);
  watch(b, 'wallet');

  const step = async (what, fn) => {
    const before = hits.length;
    await fn();
    const clean = hits.length === before;
    console.log((clean ? '  OK    ' : '  FAIL  ') + what
      + (clean ? '' : ' — ' + hits.slice(before).join(' ;; ')));
  };

  await step('minting and claiming', () => H.mintAndClaim(b.W, 2000));
  let token = null;
  await step('making a token (a swap out)', async () => { token = (await b.W.sendToken(200)).token; });
  await step('taking it back (a swap in)', () => b.W.receiveToken(token));
  await step('paying a Lightning invoice (a melt)', async () => {
    await b.W.pay(await H.rawInvoice(H.MINTS.nutshell.http, 40), () => {});
  });
  let plan = null;
  await step('quoting a move to the other mint', async () => {
    plan = await b.W.transferQuote(CDK, 100, { to: NUT, land: true });
  });
  await step('running it (a melt and a claim at two mints)', async () => {
    await b.W.connect(CDK);
    await b.W.moveRun(plan, () => {});
  });

  console.log('\n' + (hits.length
    ? hits.length + ' Amount coercion(s) — each one throws when cashu-ts v5 lands'
    : 'no money path coerces an Amount'));
  process.exit(hits.length ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
