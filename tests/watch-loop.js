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
 * And the other end of a watch: it must stop when its time is up, claim its
 * own invoice and no other, give up on a claim that keeps failing, and say
 * so when it does — the same family, a loop that goes on or a failure nobody
 * hears about.
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
    // what the mint says when it is asked to issue a paid invoice, if a test cares
    mintProofsBolt11(...args) {
      return extra && extra.mintProofs ? extra.mintProofs(...args) : Promise.reject(new Error('not in this test'));
    }
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

/* The page's timers, watched. `last(ms)` is the callback of the latest timer set
 * for that many milliseconds, so a test can fire by hand one that a stop has
 * already cleared. A claim that fails waits 12 seconds, then 36 (4000 x 3^n);
 * with `shrink` those waits are milliseconds, and `waits` lists what was asked
 * for. Nothing else is touched. */
function clock(win, shrink) {
  const real = win.setTimeout.bind(win);
  const c = { fns: {}, waits: [], last: (ms) => c.fns[ms] };
  const retry = [12000, 36000, 108000, 324000, 972000];
  win.setTimeout = (fn, ms, ...rest) => {
    c.fns[ms] = fn;
    if (retry.indexOf(ms) < 0 || !shrink) return real(fn, ms, ...rest);
    c.waits.push(ms);
    return real(fn, ms / 1000, ...rest);
  };
  return c;
}

/* The page as it ships, with harness.js's fake mint: the only way to reach a
 * claim that actually succeeds, which is what the callback tests need. */
function realPage(asked) {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const answer = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        if (asked) asked.push(String(m.url));
        return answer(w, m.id, mint.handle(m));
      }
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

  // ---- a watch that runs out of time ---------------------------------------
  /* An invoice nobody pays is watched for its window and then let go: the
   * screen is told it expired, and the mint is not asked about it again. A watch
   * that never expired was asked about every few seconds until the app closed,
   * and a finished one that could still be hurried would start asking again on
   * the next kick. */
  {
    const asked = {};
    const ctx = stubPage((q) => { asked[q] = (asked[q] || 0) + 1; return Promise.resolve({ state: 'UNPAID' }); });
    const W = ctx.W;
    await W.connect(MINT, { remember: true });
    let expired = 0;
    const stop = W.watch('q-expiry', () => {}, { pollMs: 5, timeoutMs: 40, onExpired: () => { expired += 1; } });
    // the handle a hurry goes through, taken while the watch is alive
    const handle = W._watches['q-expiry'];
    await wait(200);
    check('a watch that runs out of time tells the screen, once', expired === 1, expired + ' time(s)');
    const atEnd = asked['q-expiry'];
    await wait(150);
    check('and the mint is not asked about the invoice after that',
      asked['q-expiry'] === atEnd, atEnd + ' asked when it ended, ' + asked['q-expiry'] + ' later');
    check('and nothing is watching it any more', W.watchKick('q-expiry') === false && !W._watches['q-expiry'],
      JSON.stringify(Object.keys(W._watches || {})));
    const hurried = handle.kick(20000);
    await wait(60);
    check('a hurry on a watch that has expired is refused and asks nothing',
      hurried === false && asked['q-expiry'] === atEnd, 'kick said ' + hurried + ', ' + (asked['q-expiry'] - atEnd) + ' more asked');
    stop();
  }

  // ---- a timer that fires after the watch has ended -----------------------
  /* A clear that comes too late — a timer already due when the watch stopped,
   * or ended by itself — must find a poll that does nothing. Fired by hand
   * here, because a clear that works never lets one through. */
  {
    const asked = [];
    const ctx = stubPage((q) => { asked.push(q); return Promise.resolve({ state: 'UNPAID' }); });
    const W = ctx.W;
    const clk = clock(ctx.window);
    await W.connect(MINT, { remember: true });
    // let go by the caller
    const stop = W.watch('q-let-go', () => {}, { pollMs: 5 });
    await wait(60);
    stop();
    const late = clk.last(5);
    const before = asked.length;
    late();
    await wait(30);
    check('a timer that fires after the caller let go asks the mint nothing',
      typeof late === 'function' && asked.length === before, (asked.length - before) + ' asked');
    // ended by running out of time
    const atEnd = [];
    let ended = false;
    const ctx2 = stubPage((q) => { atEnd.push(q); return Promise.resolve({ state: 'UNPAID' }); });
    const clk2 = clock(ctx2.window);
    await ctx2.W.connect(MINT, { remember: true });
    ctx2.W.watch('q-ended', () => {}, { pollMs: 5, timeoutMs: 30, onExpired: () => { ended = true; } });
    await wait(150);
    const seen = atEnd.length;
    const late2 = clk2.last(5);
    late2();
    await wait(30);
    check('and so does one that fires after the watch ran out of time',
      ended && typeof late2 === 'function' && atEnd.length === seen, (atEnd.length - seen) + ' asked');
  }

  // ---- a paid invoice whose claim keeps failing ---------------------------
  /* The mint says the invoice is paid and then will not issue the ecash. That
   * is tried three times, 12 and 36 seconds apart, and left to the stuck-invoice
   * card and the next sweep: it used to be tried every four seconds for as long
   * as the screen was open, reserving counters each time. The screen hears every
   * failure, and so does the invoice's own record — a failed claim that says
   * nothing leaves sats at the mint and a person with no way to know. */
  {
    let paid = false;
    const tries = [];
    const ctx = stubPage(() => Promise.resolve({ state: paid ? 'PAID' : 'UNPAID' }), {
      mintProofs: () => {
        tries.push(Date.now());
        const e = new Error('the mint said nothing');
        e.status = 502;
        return Promise.reject(e);
      },
    });
    const W = ctx.W;
    const clk = clock(ctx.window, true);
    await W.connect(MINT, { remember: true });
    await wait(50);
    ctx.storage.setItem('foxy.cashu.quotes', JSON.stringify([{ quote: 'q-fail', amount: 21, mint: MINT, at: 1 }]));
    const told = [], trouble = [], arrived = [];
    W._onClaimTrouble = (h) => trouble.push(h);
    paid = true;
    const stop = W.watch('q-fail', (x) => arrived.push(x), {
      pollMs: 5,
      onError: (e) => told.push(String((e && e.message) || e)),
    });
    for (let i = 0; i < 200 && tries.length < 3; i++) await wait(10);
    // long enough for a fourth try after the 108 that would follow a third
    await wait(500);
    stop();
    check('a claim that keeps failing is tried three times and then left',
      tries.length === 3, tries.length + ' tries');
    check('the tries are 12 and then 36 seconds apart', clk.waits.join() === '12000,36000', clk.waits.join());
    check('the screen is told of every failure', told.length === 3 && /said nothing/.test(told[0]),
      told.length + ' told: ' + told.join('; '));
    check('and it is not told the invoice was paid', arrived.length === 0, JSON.stringify(arrived));
    const rec = (W.pendingQuotes() || []).filter((q) => q.quote === 'q-fail')[0];
    check('the invoice keeps its record, marked as paid and not collected, with the reason',
      !!rec && !!rec.unclaimed && rec.unclaimed.tries === 3 && /said nothing/.test(rec.unclaimed.reason || ''),
      JSON.stringify(rec));
    check('and the app is told, for the stuck-invoice card',
      trouble.length === 3 && trouble[0].quote === 'q-fail' && trouble[2].unclaimed.tries === 3,
      JSON.stringify(trouble.map((t) => t && t.quote)));
  }

  // ---- two invoices open, each claimed as itself ---------------------------
  /* A claim finds its own record on the list, by its quote. Taking the first
   * one would hand an invoice the amount and the NUT-20 key of another, and an app that has made two invoices — a receive screen opened
   * twice, a tap payment beside a QR — has two on the list all the time. */
  {
    const ctx = realPage();
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT);
    const first = await W.invoice(100, '');
    const second = await W.invoice(300, '');
    const got = {}, errors = [];
    await Promise.race([
      new Promise((res) => {
        [first, second].forEach((inv) => W.watch(inv.hash, (x) => {
          got[inv.hash] = x;
          if (Object.keys(got).length === 2) res();
        }, { pollMs: 5, onError: (e) => errors.push(String((e && e.message) || e)) }));
      }),
      wait(4000),
    ]);
    await wait(40);
    check('each invoice is claimed for its own amount',
      !!got[first.hash] && got[first.hash].sats === 100 && !!got[second.hash] && got[second.hash].sats === 300,
      JSON.stringify(got) + ' ' + errors.join('; '));
    check('and both are in the pile', (await W.balanceSats()) === 400, String(await W.balanceSats()));
    const log = JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]').filter((e) => e.dir === 'in');
    const byHash = {};
    log.forEach((e) => { byHash[e.hash] = e; });
    check('the history has each one as what it was',
      log.length === 2 && !!byHash[first.hash] && byHash[first.hash].sats === 100
        && !!byHash[second.hash] && byHash[second.hash].sats === 300,
      JSON.stringify(log.map((e) => [e.hash, e.sats])));
    check('and neither is left on the pending list', (W.pendingQuotes() || []).length === 0,
      JSON.stringify(W.pendingQuotes()));
  }

  // ---- the sweep and the archive -------------------------------------------
  /* An invoice pushed off the list is archived, and the sweep still asks about
   * it — at the mint that made it, and only there. An archived invoice of this
   * mint that was paid after it left the list is still collected; one of another
   * mint is not asked about here, which was a 400 on every launch. */
  {
    const seen = [];
    const ctx = realPage(seen);
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT);
    const inv = await W.invoice(300, '');
    const record = JSON.parse(ctx.storage.getItem('foxy.cashu.quotes'))[0];
    const stray = { quote: 'q-at-another-mint', amount: 50, memo: '', at: 1, mint: 'https://elsewhere.test' };
    ctx.storage.setItem('foxy.cashu.quotes', '[]');
    ctx.storage.setItem('foxy.cashu.quotes.old', JSON.stringify([stray, record]));
    seen.length = 0;
    await W.sweepQuotes();
    await wait(40);
    check('an archived invoice of this mint, paid, is collected by the sweep',
      (await W.balanceSats()) === 300, String(await W.balanceSats()));
    const left = JSON.parse(ctx.storage.getItem('foxy.cashu.quotes.old') || '[]');
    check('and it leaves the archive', !left.some((e) => e.quote === inv.hash), JSON.stringify(left.map((e) => e.quote)));
    check('an archived invoice of another mint is not asked about here',
      !seen.some((u) => u.indexOf(stray.quote) >= 0), seen.join(' '));
    check('and stays in the archive, not marked as asked',
      left.length === 1 && left[0].quote === stray.quote && !left[0].checked, JSON.stringify(left));
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
