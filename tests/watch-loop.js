'use strict';
/* watch-loop.js — the page-side loops that must outlive a pass that does nothing.
 *
 *     node tests/watch-loop.js
 *
 * A setTimeout chain that does not set its next timer on some path stops for
 * the rest of the session, and nothing looks at it. That is how the on-chain
 * watcher lost a deposit on a phone (tests/onchain-watch.js):
 * one pass with nothing to watch, no timer behind it, and an address was last
 * asked about seven minutes after it was made while the app ran on for half an
 * hour more.
 *
 * The wallet has the same shape in two places, and both are here:
 *
 *   FoxyWallet.watch(quote) — the invoice poller. Until it claims, a paid
 *     invoice is sats at the mint and nothing on this device. Every path out
 *     of a pass must set the next one, including the ones that ask nothing:
 *     no wallet, the gate shut, and a mint call that throws on the way out
 *     rather than answering.
 *
 *   probeMintNode — the one wait a mint gets to have its Lightning node
 *     learned. A mint whose node is unknown pays its own invoices over
 *     Lightning with a routing fee instead of by ecash.
 *
 * Money the poller claims is real in this test only in the sense the stub mint
 * is: harness.js's fake mint, never a real one.
 */
const { load, loadReal, stubCashu, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) =>
  results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

/* A page whose only mint call is the invoice check, driven by `answer(quote)`:
 * it may return a promise, or throw where a half-built wallet object would. */
function stubPage(answer, extra) {
  const base = stubCashu();
  class Wallet extends base.Wallet {
    checkMintQuoteBolt11(q) { return answer(q); }
    createMintQuoteBolt11(amount) {
      probes.push(Number(amount));
      return Promise.resolve({ quote: 'probe', request: 'lnbc10n1probe', amount: Number(amount) });
    }
    getMintInfo() { return { nuts: {} }; }
  }
  const probes = [];
  const ctx = load({ cashu: Object.assign({}, base, { Wallet, Mint: Wallet }) });
  // the node probe's own wait, out of the way unless a test is about it
  ctx.W._nodeProbeDelay = (extra && extra.nodeProbeDelay) || [86400000, 86400000];
  ctx.probes = probes;
  return ctx;
}

/* Tor up or down, as the native side reports it. */
const gate = (W, up) => W._privacy({ tor: up ? 'up' : 'connecting', progress: up ? 100 : 40, everUp: true });

/* The page as it ships, with harness.js's fake mint: the only way to reach a
 * claim that actually succeeds, which is what the callback tests need. */
function realPage() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const answer = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return answer(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return answer(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => answer(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}

async function run() {
  // ---- a mint call that throws on the way out -----------------------------
  /* Not the promise rejecting — that was always caught — but the call itself
   * throwing: a wallet object a mint switch left half-built, a keyset cashu-ts
   * will not use. It left no timer behind, so the invoice was never asked
   * about again and the sats waited at the mint for a sweep on some later
   * launch. */
  {
    let calls = 0;
    const ctx = stubPage(() => {
      calls += 1;
      if (calls <= 3) throw new TypeError('cannot read properties of undefined');
      return Promise.resolve({ state: 'UNPAID' });
    });
    await ctx.W.connect(MINT, { remember: true });
    // the first pass runs inside watch(): unguarded, its throw came back here
    let stop = () => {};
    try { stop = ctx.W.watch('q-throw', () => {}, { pollMs: 5 }); }
    catch (e) { check('watch() itself did not throw on the first pass', false, String(e && e.message)); }
    await wait(120);
    stop();
    check('a mint call that throws does not end the watching', calls > 6, calls + ' pass(es) in 120ms');
  }

  // ---- a mint that rejects -------------------------------------------------
  {
    let calls = 0;
    const ctx = stubPage(() => { calls += 1; return Promise.reject(new Error('no answer')); });
    await ctx.W.connect(MINT, { remember: true });
    const stop = ctx.W.watch('q-reject', () => {}, { pollMs: 5 });
    await wait(120);
    stop();
    check('a mint that will not answer is asked again', calls > 6, calls + ' pass(es) in 120ms');
  }

  // ---- the gate shut, then open -------------------------------------------
  /* The incident's own shape: a pass that asks nothing because there is
   * nothing it may ask. It must still arrange the next one, or a phone that
   * lost Tor for ten seconds stops watching for the rest of the session. */
  {
    let calls = 0;
    const ctx = stubPage(() => { calls += 1; return Promise.resolve({ state: 'UNPAID' }); });
    const W = ctx.W;
    await W.connect(MINT, { remember: true });
    gate(W, false);
    const stop = W.watch('q-gate', () => {}, { pollMs: 5 });
    await wait(80);
    const asleep = calls;
    gate(W, true);
    await wait(80);
    stop();
    check('a pass with the gate shut asks the mint nothing', asleep === 0, asleep + ' call(s) while shut');
    check('and the watching is still alive when the gate opens', calls > 3,
      calls + ' call(s) after the gate opened');
  }

  // ---- stopped while a pass is in the air ----------------------------------
  /* The opposite failure, and the same loop. `stop` cleared the timer, and
   * between passes there is no timer: the answer to a pass already asked came
   * back, found nothing saying stop, and armed the next. Over Tor a pass is in
   * the air a third of the time, so a third of abandoned invoices were polled
   * until the app closed. */
  {
    let calls = 0;
    const ctx = stubPage(() => {
      calls += 1;
      return new Promise((r) => setTimeout(() => r({ state: 'UNPAID' }), 30));
    });
    await ctx.W.connect(MINT, { remember: true });
    const stop = ctx.W.watch('q-stopped', () => {}, { pollMs: 5 });
    await wait(10);              // the first pass is asked and not yet answered
    stop();
    const atStop = calls;
    await wait(200);
    check('a watch stopped while a pass is in the air stays stopped',
      atStop === 1 && calls === 1, atStop + ' call(s) at the stop, ' + calls + ' after 200ms');
  }

  // ---- a connect that fails leaves the wallet that was working --------------
  /* Not a loop, but the same family: a fault that retrying recovers from, which
   * meanwhile took something away. A failed connect nulled the wallet, so a
   * phone reconnecting to a slow mint refused two payments "No mint connected
   * yet". */
  {
    let down = false;
    const base = stubCashu();
    class Wallet extends base.Wallet {
      loadMint() { return down ? Promise.reject(new Error('the mint is slow')) : Promise.resolve(); }
      getMintInfo() { return { nuts: {} }; }
    }
    const ctx = load({ cashu: Object.assign({}, base, { Wallet, Mint: Wallet }) });
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    const W = ctx.W;
    await W.connect(MINT, { remember: true });
    down = true;
    let failed = false;
    await W.connect(MINT).catch(() => { failed = true; });
    let sats = null, threw = '';
    try { sats = await W.balanceSats(); } catch (e) { threw = String(e && e.message); }
    check('the second connect did fail', failed, 'it succeeded');
    check('and the wallet that was working is still there', W.mintUrl === MINT && sats !== null && !threw,
      threw || ('mintUrl ' + W.mintUrl));
    let inv = null, why = '';
    down = false;
    try { inv = await W.invoice(10, ''); } catch (e) { why = String(e && e.message); }
    check('and can still ask the mint for something', !/No mint connected/.test(why), why);
  }

  // ---- the screen's callback throwing is not the mint's fault --------------
  /* onPaid used to be called inside the claim's own then, so a render that
   * threw landed in the claim's catch: a claim that had succeeded was filed as
   * money paid and not collected — the stuck-invoice card — and three of those
   * put the quote past sweepQuotes's `refused >= 3` filter for good. */
  {
    const ctx = realPage();
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT);
    const inv = await W.invoice(300, '');
    const errors = [];
    await new Promise((res) => {
      W.watch(inv.hash, () => {
        setTimeout(res, 0);
        throw new TypeError('the receive screen fell over');
      }, { pollMs: 5, onError: (e) => errors.push(String((e && e.message) || e)) });
    });
    await wait(40);
    check('a screen that throws on the answer is not read as a claim that failed',
      errors.length === 0, errors.join('; '));
    check('and the claim it threw on still put the sats in the pile',
      (await W.balanceSats()) === 300, String(await W.balanceSats()));
    const stuck = (W.pendingQuotes() || []).filter((q) => q.quote === inv.hash);
    check('and the invoice is off the pending list, not marked unclaimed',
      stuck.length === 0, JSON.stringify(stuck));
  }

  // ---- the node probe's one wait ------------------------------------------
  /* 10 to 40 seconds is long enough for Tor to drop inside it. The pass that
   * found the gate shut used to put its flag back and stop there, with nothing
   * calling probeMintNode again until the next connect. */
  {
    const ctx = stubPage(() => Promise.resolve({ state: 'UNPAID' }), { nodeProbeDelay: [20, 20] });
    const W = ctx.W;
    await W.connect(MINT, { remember: true });
    gate(W, false);
    await wait(120);
    const whileShut = ctx.probes.length;
    gate(W, true);
    await wait(120);
    check('the node probe asks nothing while the gate is shut', whileShut === 0,
      whileShut + ' probe(s) while shut');
    check('and it still asks once the gate opens', ctx.probes.length === 1,
      ctx.probes.length + ' probe(s) after the gate opened');
  }

  results.forEach((r) => console.log(r));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  if (failed) {
    console.log('\n' + failed + ' watch-loop check(s) failed');
    process.exit(1);
  }
  console.log('\nall ' + results.length + ' watch-loop checks pass');
  // the pages leave their own long waits behind; nothing here is waiting on them
  process.exit(0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
