'use strict';
/* audit-in-flight.js — the history audit while a payment is with the mint.
 *
 *     node tests/audit-in-flight.js
 *
 * The audit (16-history-lists.js `histAudit`, `histAuditUsd`) walks back from the
 * balance through the rows and says whether they account for it; the history
 * ring turns red when they disagree for more than four seconds. While a melt
 * was with the mint its pieces were out of the pile and on no row, and the
 * audit read "off by" the melt for as long as it took: seconds for a payment,
 * as long as the mint said PENDING for a slow one, across a relaunch too. A swap
 * between the two balances pays its first leg by such a melt.
 *
 * Here the app's own audit methods, lifted from the build, run on the page of a
 * real wallet (loadReal: the bundled cashu-ts, the phone's seed) at the
 * harness's mint, and are asked at EVERY step — before each request reaches
 * the mint, after each answer, and every few milliseconds between — through:
 *   1. a payment in sats: quoted, paid, PENDING, a relaunch while PENDING, settled
 *   2. the same payment failed at the mint and its pieces given back
 *   3. a payment answered at once (no PENDING)
 *   4. a swap bitcoin → dollars, and dollars → bitcoin, answered at once
 *   5. both swaps with the payment leg PENDING, a relaunch, then settled and claimed
 *   6. history cleared while a payment is PENDING, then settled
 * and each must read off by 0 in both units throughout. */
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, books, PHONE_WORDS } = require('./harness');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const MINT = 'https://m.test';

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (fn()) return true; await wait(10); }
  return !!fn();
};
const copyOf = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const melting = (c) => JSON.parse(c.storage.getItem('foxy.cashu.melting') || '[]');

// ---- the app's audit, as the build has it -------------------------------------------------------
const method = (sig) => {
  const start = appSrc.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = appSrc.indexOf('{', start), depth = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appSrc.slice(start + 3, i + 1);
};
const LIFTED = ['histAudit() {', 'histAuditUsd() {', 'txTotalOut(t) {', 'arrivingBucket(unit) {', 'recoveringSats() {', 'topUpFeeSats() {', 'meltingIn(unit) {'];

/* The rows as the history screen keeps them (16-history-lists.js `loadHistory`), with the fields the audit reads. */
function historyOf(c) {
  const W = c.W;
  const here = String(W.mintUrl || '').replace(/\/+$/, '');
  const all = JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
  const items = all.filter((t) => t && (!t.mint || t.mint === here)).map((t) => {
    const meta = (W.tagsFor && W.tagsFor(t.hash)) || {};
    return {
      hash: t.hash, dir: t.dir, sats: t.sats, fee: t.feeSats, memo: t.memo || '',
      unit: t.unit && t.unit !== 'sat' ? t.unit : '', amount: t.amount, feeAmount: t.feeAmount,
      forKeeper: !!t.forKeeper,
      pending: !t.settled || (t.dir === 'out' && meta.to === 'ecash' && !!meta.token),
      failed: t.state === 'failed',
      atRisk: !!t.trusted && !t.settled && t.state !== 'failed',
      grossSats: Number(t.grossSats) || 0, changeSats: Number(t.changeSats) || 0,
      changeAmount: Number(t.changeAmount) || 0, changeState: t.changeState || '',
      changeRow: !!meta.change || /^(tap|req)-change-/.test(String(t.hash || '')),
    };
  });
  return { items, complete: all.length < 500 };
}

/* The audit in both units, at this moment: what the ring would be drawn from. */
function auditNow(c) {
  if (!c.app) c.app = c.window.eval('(function () { return {' + LIFTED.map(method).join(',') + '}; })()');
  const h = historyOf(c);
  c.app.state = {
    balSats: c.W.balanceOf('sat'), balUsdCents: c.W.balanceOf('usd'),
    history: h.items.length ? [{ label: 'TODAY', items: h.items }] : [], historyComplete: h.complete, fresh: false,
  };
  const log = c.window.console.log;
  c.window.console.log = () => {};
  try {
    const sat = c.app.histAudit(), usd = c.app.histAuditUsd();
    return { sat: sat.whole ? sat.off : 0, usd: usd.whole ? usd.off : 0 };
  } finally { c.window.console.log = log; }
}

/* Every reading that was not 0, with where it was taken: a step's name, or the request it was taken beside. */
function watch(c) {
  c.seen = [];
  c.where = 'start';
  c.look = (at) => {
    let a;
    try { a = auditNow(c); } catch (e) { c.seen.push({ at: at || c.where, err: String(e && e.message) }); return; }
    c.looks = (c.looks || 0) + 1;
    if (a.sat !== 0 || a.usd !== 0) c.seen.push({ at: at || c.where, sat: a.sat, usd: a.usd });
  };
  c.tick = setInterval(() => c.look(), 2);
}
const quiet = (c) => { clearInterval(c.tick); };
const offs = (c) => c.seen.slice(0, 6).map((s) => s.err ? s.at + ': ' + s.err : s.at + ': sats ' + s.sat + ', cents ' + s.usd).join(' | ');

/* A page of the real wallet at the fake mint, as tests/swap-run.js makes it, with the audit read before every
 * request reaches the mint and after every answer. `mo` is the mint's own options, kept so a test can turn
 * PENDING on and off (`meltPending`). */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: PHONE_WORDS });
  if (opts.phone) { phone.counters = opts.phone.counters; phone.locks = opts.phone.locks; }
  let mint = opts.mint || null;
  const mo = opts.mo || Object.assign({ units: ['sat', 'usd'], version: 'Nutshell/0.20.3.1', internalFree: true }, opts.mintOpts || {});
  const ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const p = new URL(String(m.url || m.path || '')).pathname.replace(/\/[0-9a-f]{32}$/, '');
        if (ctx.look) ctx.look('before ' + p);
        const said = mint.handle(m);
        return setTimeout(() => {
          w.FoxyWallet._scanResult(m.id, said);
          // after the wallet has done what the answer leads to in this tick and the ones it chains
          setTimeout(() => { if (ctx.look) ctx.look('after ' + p); }, 0);
        }, 0);
      }
      const got = phone.answer(w, m);
      if (!got) return setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'not in this test'), 0);
      return Promise.resolve(got).then((r) => setTimeout(() => w.FoxyWallet._scanResult(m.id, r[0], r[1]), 0));
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, mo);
    },
  });
  ctx.phone = phone;
  ctx.mo = mo;
  ctx.mint = () => mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._swapPollMs = 5;
  ctx.W._swapClaimWaitMs = 200;
  return ctx;
}
/* The next launch: the same storage, the same phone, the same mint. */
function relaunch(c) {
  quiet(c);
  return page({ storage: copyOf(c), phone: c.phone, mint: c.mint(), mo: c.mo });
}
async function fund(c, amount, unit) {
  const inv = await c.W.invoice(amount, '', { unit: unit || 'sat' });
  return c.W.claim(inv.hash);
}
/* An invoice somebody else made: this mint's, with its record taken off this phone, so nothing here claims it. */
async function theirInvoice(c, sats) {
  const inv = await c.W.invoice(sats, '', { unit: 'sat' });
  const left = JSON.parse(c.storage.getItem('foxy.cashu.quotes') || '[]').filter((r) => r.quote !== inv.hash);
  c.storage.setItem('foxy.cashu.quotes', JSON.stringify(left));
  return inv.bolt11;
}

(async () => {
  // ---- 1. a payment in sats, PENDING, a relaunch, settled -----------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'sat');
    const bolt11 = await theirInvoice(c, 1000);
    const from = books(c);
    c.mo.meltPending = true;
    watch(c);
    c.where = 'paying';
    const paid = await c.W.pay(bolt11);
    c.where = 'pending';
    c.look('pending, after pay answered');
    ok(paid && paid.pending && melting(c).length === 1, '1: the payment is PENDING with its pieces held', JSON.stringify(paid));
    ok(c.seen.length === 0, '1: off by 0 at every step from the quote to PENDING (' + c.looks + ' readings)', offs(c));
    const quote = melting(c)[0].quote;
    const b = relaunch(c);
    // (the harness's books of the new page are judged from before the payment: it was made with the melt in flight)
    b.booksFrom = from;
    watch(b);
    b.where = 'relaunched, before connect';
    b.look();
    await b.W.connect(MINT, { remember: true });
    b.where = 'relaunched, still PENDING';
    await b.W.sweepMelts();
    b.look();
    ok(melting(b).length === 1 && b.seen.length === 0, '1: off by 0 across a relaunch while the mint says PENDING', offs(b));
    b.mint().settleMelt(quote, 'paid');
    b.where = 'settling';
    await b.W.sweepMelts();
    b.look('settled');
    quiet(b);
    // (the mint pays its own invoice at no routing cost, so all ten of the reserve comes back)
    ok(melting(b).length === 0 && b.W.balanceOf('sat') === 2000,
      '1: settled, the payment paid and its change back', String(b.W.balanceOf('sat')));
    ok(b.seen.length === 0, '1: off by 0 through the settle (' + b.looks + ' readings)', offs(b));
  }

  // ---- 2. the same payment, FAILED at the mint --------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'sat');
    const bolt11 = await theirInvoice(c, 1000);
    c.mo.meltPending = true;
    watch(c);
    await c.W.pay(bolt11);
    const quote = melting(c)[0] && melting(c)[0].quote;
    c.mint().settleMelt(quote, 'failed');
    /* cashu-ts reads only UNPAID, PENDING and PAID, so the mint's FAILED is read as UNPAID, as a real mint's failed payment
     * comes back (tests/flashcard-cross-mint-pay.js), and the hold is made old enough for the sweep to give it back. */
    c.mint().melts[quote].state = 'UNPAID';
    c.storage.setItem('foxy.cashu.melting', JSON.stringify(melting(c).map((e) => Object.assign(e, { at: e.at - 600 }))));
    c.where = 'failed, given back';
    await c.W.sweepMelts();
    c.look('given back');
    quiet(c);
    ok(melting(c).length === 0 && c.W.balanceOf('sat') === 3000, '2: a payment that failed gives its pieces back', String(c.W.balanceOf('sat')));
    ok(c.seen.length === 0, '2: off by 0 from the quote to the pieces back (' + c.looks + ' readings)', offs(c));
  }

  // ---- 3. a payment answered at once ------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'sat');
    const bolt11 = await theirInvoice(c, 1000);
    watch(c);
    const paid = await c.W.pay(bolt11);
    c.look('paid');
    quiet(c);
    ok(paid && !paid.pending, '3: paid at once');
    ok(c.seen.length === 0, '3: off by 0 at every step (' + c.looks + ' readings)', offs(c));
  }

  // ---- 4. swaps between the balances, answered at once ------------------------------------------
  for (const dir of [['sat', 'usd', 3000, 2000], ['usd', 'sat', 3000, 1500]]) {
    const [from, to, have, amount] = dir;
    const name = from === 'sat' ? 'bitcoin → dollars' : 'dollars → bitcoin';
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, have, from);
    watch(c);
    c.where = 'swapping';
    const r = await c.W.swapUnits(from, to, amount);
    c.where = 'swapped';
    await until(() => c.W.unitSwapsPending().length === 0, 2000);
    c.look('done');
    quiet(c);
    ok(r && r.state === 'done' && c.W.balanceOf(to) > 0, '4: ' + name + ' swapped', JSON.stringify(r));
    ok(c.seen.length === 0, '4: ' + name + ': off by 0 at every step (' + c.looks + ' readings)', offs(c));
  }

  // ---- 5. swaps with the payment leg PENDING, a relaunch, then settled and claimed ---------------
  for (const dir of [['sat', 'usd', 3000, 2000], ['usd', 'sat', 3000, 1500]]) {
    const [from, to, have, amount] = dir;
    const name = from === 'sat' ? 'bitcoin → dollars' : 'dollars → bitcoin';
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, have, from);
    const before = books(c);
    c.mo.meltPending = true;
    watch(c);
    c.where = 'swapping';
    const r = await c.W.swapUnits(from, to, amount);
    c.look('pending');
    ok(r && r.state === 'pending' && melting(c).length === 1, '5: ' + name + ': the payment leg is PENDING', JSON.stringify(r));
    ok(c.seen.length === 0, '5: ' + name + ': off by 0 up to PENDING (' + c.looks + ' readings)', offs(c));
    const quote = melting(c)[0] && melting(c)[0].quote;
    const b = relaunch(c);
    b.booksFrom = before;
    c.mo.meltPending = false;
    watch(b);
    b.where = 'relaunched';
    b.look('relaunched, before connect');
    await b.W.connect(MINT, { remember: true });
    await b.W.sweepMelts();
    b.look('relaunched, still PENDING');
    ok(melting(b).length === 1 && b.seen.length === 0, '5: ' + name + ': off by 0 across a relaunch while PENDING', offs(b));
    b.mint().settleMelt(quote, 'paid');
    b.where = 'the payment settles';
    await b.W.sweepMelts();
    b.look('the payment leg landed');
    b.where = 'the second leg is claimed';
    await b.W.sweepQuotes();
    await until(() => b.W.unitSwapsPending().length === 0, 2000);
    b.look('both legs landed');
    quiet(b);
    ok(b.W.unitSwapsPending().length === 0 && b.W.balanceOf(to) > 0, '5: ' + name + ': both legs landed', b.W.balanceOf(to) + ' ' + to);
    ok(b.seen.length === 0, '5: ' + name + ': off by 0 through the settle and the claim (' + b.looks + ' readings)', offs(b));
  }

  // ---- 6. history cleared while a payment is PENDING --------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 3000, 'sat');
    const bolt11 = await theirInvoice(c, 1000);
    c.mo.meltPending = true;
    await c.W.pay(bolt11);
    const quote = melting(c)[0] && melting(c)[0].quote;
    c.W.clearHistory();
    watch(c);
    c.look('cleared');
    c.mint().settleMelt(quote, 'paid');
    c.where = 'settling';
    await c.W.sweepMelts();
    c.look('settled');
    quiet(c);
    ok(melting(c).length === 0, '6: the payment settled after history was cleared');
    ok(c.seen.length === 0, '6: off by 0 from the clear to the settle: the opening row carries what the melt held', offs(c));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
