'use strict';
/* hostile-quote.js — a mint that answers about another quote than the one asked.
 *
 *     node tests/hostile-quote.js
 *
 * Foxy keeps its invoices and its payments by quote id, and asks the mint about
 * each by that id. A mint (or whatever stands between) that answers with
 * another quote's record, a batch of records out of order, short, or with one
 * too many, or a record whose amount or unit is not the one asked, must change
 * nothing: no invoice marked paid, nothing minted, no pieces struck or held or
 * given back, no history row, and one plain line in the log saying the answer
 * was refused (22-screen-lock.js `nativeRequest`, `quoteAnswerProblem`).
 *
 *   a. a mint quote check answered with another quote's id, state PAID
 *   b. a melt quote check answered with another quote's id (PAID, then FAILED)
 *   c. a batch state answer out of order
 *   d. a batch state answer short by one
 *   e. a batch state answer with an extra quote
 *   f. a quote answer whose amount or unit is not the one asked
 *
 * Pages on harness.js's fake mints, with the answers rewritten on the way back.
 */
const H = require('./harness');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = H;

const MINT = 'https://m.test';
const FOREIGN = 'lnbc20000n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqxyzzy';
const REFUSED = /answered about a quote other than the one asked/;

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 180000).unref();

/* A page on one fake mint. `ctx.rewrite(path, method, body, answer)` may return another answer text; `ctx.asked` is
 * every request the mint saw, `ctx.lines` every line the page logged. */
function page(mintOpts) {
  const phone = nativePhone({ words: PHONE_WORDS });
  const asked = [];
  const lines = [];
  let mint = null;
  const ctx = { asked, lines, rewrite: null };
  Object.assign(ctx, loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const u = new URL(String(m.url || ''));
        asked.push({ path: u.pathname, method: m.method, body: String(m.body || '') });
        let text = mint.handle(m);
        if (ctx.rewrite) {
          const other = ctx.rewrite(u.pathname, String(m.method || 'GET'), m.body ? JSON.parse(m.body) : null, text);
          if (typeof other === 'string') text = other;
        }
        return setTimeout(() => w.FoxyWallet._scanResult(m.id, text), 0);
      }
      const got = phone.answer(w, m);
      if (!got) return setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'not in this test'), 0);
      return Promise.resolve(got).then((r) => setTimeout(() => w.FoxyWallet._scanResult(m.id, r[0], r[1]), 0));
    },
    before: (w) => {
      phone.attach(w);
      mint = fakeMint(w, Object.assign({ fill: 31, quoteFrom: 70000 }, mintOpts || {}));
      for (const k of ['log', 'warn', 'error']) {
        const was = w.console[k].bind(w.console);
        w.console[k] = (...a) => { lines.push(a.map((x) => (x && x.message) || String(x)).join(' ')); if (process.env.FOXY_VERBOSE) was(...a); };
      }
    },
  }));
  ctx.mint = mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
const J = (s, k, d) => { try { return JSON.parse(s.getItem(k) || '') || d; } catch (e) { return d; } };
const body = (text) => JSON.parse(String(text).slice(String(text).indexOf('\n') + 1));
const answer = (obj) => '200\n' + JSON.stringify(obj);
const mintsAsked = (P, from) => P.asked.slice(from).filter((x) => x.method === 'POST' && x.path === '/v1/mint/bolt11').length;
const refusals = (P, from) => P.lines.slice(from).filter((l) => REFUSED.test(l)).length;
const snapshot = (P) => ({
  quotes: P.storage.getItem('foxy.cashu.quotes') || '',
  log: P.storage.getItem('foxy.cashu.log') || '',
  melting: P.storage.getItem('foxy.cashu.melting') || '',
});
const balance = async (P) => Number(await P.W.balanceSats()) || 0;

async function run() {
  /* ---- a. a mint quote check answered with another quote's id, PAID ---------------------------------------- */
  {
    const P = page({ quotesUnpaid: true });
    await P.W.connect(MINT, { remember: true });
    const A = (await P.W.invoice(100, '')).hash;
    const B = (await P.W.invoice(200, '')).hash;
    const before = snapshot(P), bal0 = await balance(P);
    const a0 = P.asked.length, l0 = P.lines.length;
    // every check of A is answered with B's record, said to be paid
    P.rewrite = (p, m, b, text) => (m === 'GET' && p === '/v1/mint/quote/bolt11/' + A
      ? answer(Object.assign({}, P.mint.quotes[B], { state: 'PAID' })) : null);
    await P.W.sweepQuotes({ awayLater: true }).catch(() => null);
    let paid = 0;
    const stop = P.W.watch(A, () => { paid += 1; });
    await sleep(1500);
    if (typeof stop === 'function') stop();
    const after = snapshot(P);
    ok(mintsAsked(P, a0) === 0, 'a: an answer about another quote, PAID, mints nothing', mintsAsked(P, a0) + ' mint request(s)');
    ok(paid === 0, 'a: the invoice on screen is not said to be paid');
    ok(after.quotes === before.quotes, 'a: neither invoice’s record is touched');
    ok(after.log === before.log && (await balance(P)) === bal0, 'a: no history row, the balance as it was');
    const n = refusals(P, l0);
    ok(n >= 1, 'a: the refusal is said in the log in one plain line', n + ' line(s)');
    const asks = P.asked.slice(a0).filter((x) => x.path === '/v1/mint/quote/bolt11/' + A).length;
    ok(n === asks, 'a: one line for each refused answer, no more', n + ' lines for ' + asks + ' answers');
  }

  /* ---- b. a melt quote check answered with another quote's id --------------------------------------------- */
  for (const said of ['PAID', 'FAILED']) {
    const P = page({ meltPending: true });
    await P.W.connect(MINT, { remember: true });
    await P.W.claim((await P.W.invoice(5000, '')).hash);
    let r = null;
    try { r = await P.W.pay(FOREIGN, () => {}, {}); } catch (e) { r = { error: e.message }; }
    const held = J(P.storage, 'foxy.cashu.melting', []);
    ok(held.length === 1, 'b(' + said + '): a payment still routing is held', JSON.stringify(r).slice(0, 120));
    const Q = held[0] && held[0].quote;
    // another melt quote at the same mint, which the hostile answers name
    const other = body(P.mint.handle({ url: MINT + '/v1/melt/quote/bolt11', method: 'POST',
      body: JSON.stringify({ request: FOREIGN, unit: 'sat' }) })).quote;
    const before = snapshot(P), bal0 = await balance(P);
    const a0 = P.asked.length, l0 = P.lines.length;
    P.rewrite = (p, m) => (m === 'GET' && p === '/v1/melt/quote/bolt11/' + Q
      ? answer(Object.assign({}, P.mint.melts[other], { state: said, payment_preimage: said === 'PAID' ? '00'.repeat(32) : null, change: [] }))
      : null);
    await P.W.sweepMelts().catch(() => null);
    const after = snapshot(P);
    ok(after.melting === before.melting, 'b(' + said + '): the held pieces stay held, not struck nor given back');
    ok(after.log === before.log && (await balance(P)) === bal0, 'b(' + said + '): no history row, the balance as it was');
    const asks = P.asked.slice(a0).filter((x) => x.path === '/v1/melt/quote/bolt11/' + Q).length;
    const n = refusals(P, l0);
    ok(asks >= 1 && n === asks, 'b(' + said + '): one plain refusal line for each answer', n + ' lines for ' + asks + ' answers');
  }

  /* ---- c, d, e. a batch state answer (several quotes in one ask) ------------------------------------------ */
  {
    const P = page({ quotesUnpaid: true });
    await P.W.connect(MINT, { remember: true });
    const A = (await P.W.invoice(100, '')).hash;
    const B = (await P.W.invoice(200, '')).hash;
    const C = (await P.W.invoice(300, '')).hash;
    const rec = (q) => Object.assign({}, P.mint.quotes[q], { state: 'PAID' });
    const cases = {
      'c: out of order': [rec(B), rec(A)],
      'd: short by one': [rec(A)],
      'e: with an extra quote': [rec(A), rec(B), rec(C)],
    };
    const sources = require('fs').readFileSync(require('path').join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
    ok(!/checkMintQuoteBatch|checkMeltQuoteBatch|quote\/[a-z0-9]+\/check/.test(sources),
      'the wallet asks no batch of quote states itself today; a batch asked by the request door is checked there');
    for (const [name, list] of Object.entries(cases)) {
      const before = snapshot(P);
      const a0 = P.asked.length, l0 = P.lines.length;
      P.rewrite = (p, m) => (m === 'POST' && p === '/v1/mint/quote/bolt11/check' ? answer(list) : null);
      let got = null, no = '';
      try { got = await P.W.nativeRequest({ endpoint: MINT + '/v1/mint/quote/bolt11/check', method: 'POST', requestBody: { quotes: [A, B] } }); }
      catch (e) { no = e.message; }
      ok(got === null && !!no, name + ': the answer is refused whole at the door', JSON.stringify(got).slice(0, 80));
      ok(refusals(P, l0) === 1, name + ': in one plain refusal line', refusals(P, l0) + ' line(s)');
      // and as the library asks it: refused too, nothing used
      let lib = null;
      try { lib = await new P.window.CashuTS.Mint(MINT, { customRequest: P.W.nativeRequest }).checkMintQuoteBatch('bolt11', [A, B]); }
      catch (e) { lib = null; }
      ok(lib === null, name + ': the library’s batch check gets no answer either');
      ok(mintsAsked(P, a0) === 0 && snapshot(P).quotes === before.quotes && snapshot(P).log === before.log,
        name + ': nothing minted, no record or row touched');
    }
    // the exact set, in order, is an answer
    P.rewrite = (p, m) => (m === 'POST' && p === '/v1/mint/quote/bolt11/check' ? answer([P.mint.quotes[A], P.mint.quotes[B]]) : null);
    let fine = null;
    try { fine = await P.W.nativeRequest({ endpoint: MINT + '/v1/mint/quote/bolt11/check', method: 'POST', requestBody: { quotes: [A, B] } }); }
    catch (e) { fine = e.message; }
    ok(Array.isArray(fine) && fine.length === 2 && fine[0].quote === A && fine[1].quote === B, 'the exact quotes asked, in order, are an answer', JSON.stringify(fine).slice(0, 80));
  }

  /* ---- f. a quote answer whose amount or unit is not the one asked ---------------------------------------- */
  {
    const P = page({ quotesUnpaid: true });
    await P.W.connect(MINT, { remember: true });
    const A = (await P.W.invoice(100, '')).hash;
    const big = 'lnbc1500n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';
    const flavours = {
      'its amount is not the one asked': () => Object.assign({}, P.mint.quotes[A], { state: 'PAID', amount: 150, request: big }),
      'its unit is not the one asked': () => Object.assign({}, P.mint.quotes[A], { state: 'PAID', unit: 'usd' }),
    };
    for (const [name, make] of Object.entries(flavours)) {
      const before = snapshot(P), bal0 = await balance(P);
      const a0 = P.asked.length, l0 = P.lines.length;
      P.rewrite = (p, m) => (m === 'GET' && p === '/v1/mint/quote/bolt11/' + A ? answer(make()) : null);
      await P.W.sweepQuotes({ awayLater: true }).catch(() => null);
      let paid = 0;
      const stop = P.W.watch(A, () => { paid += 1; });
      await sleep(1500);
      if (typeof stop === 'function') stop();
      await sleep(50);
      const after = snapshot(P);
      ok(mintsAsked(P, a0) === 0 && paid === 0, 'f: a check answer where ' + name + ', PAID: nothing minted', mintsAsked(P, a0) + ' mint request(s)');
      ok(after.quotes === before.quotes && after.log === before.log && (await balance(P)) === bal0, 'f: ' + name + ': no record, row or balance touched');
      const asks = P.asked.slice(a0).filter((x) => x.path === '/v1/mint/quote/bolt11/' + A).length;
      ok(asks >= 1 && refusals(P, l0) === asks, 'f: ' + name + ': one plain refusal line for each answer', refusals(P, l0) + ' lines for ' + asks + ' answers');
    }
    // a new invoice answered in another unit than asked
    {
      const before = snapshot(P);
      const l0 = P.lines.length;
      P.rewrite = (p, m, b, text) => (m === 'POST' && p === '/v1/mint/quote/bolt11' ? answer(Object.assign(body(text), { unit: 'usd' })) : null);
      let no = '';
      try { await P.W.invoice(250, ''); } catch (e) { no = e.message; }
      ok(!!no && snapshot(P).quotes === before.quotes, 'f: a new invoice answered in another unit is refused, nothing written down', no.slice(0, 80));
      ok(refusals(P, l0) >= 1, 'f: and said in a plain refusal line', refusals(P, l0) + ' line(s)');
    }
    // a payment's quote answered in another unit than asked
    {
      P.rewrite = null;
      const funds = (await P.W.invoice(3000, '')).hash;
      P.mint.payQuote(funds);
      await P.W.claim(funds);
      ok((await balance(P)) === 3000, 'f: the wallet holds 3,000 to pay with');
      const before = snapshot(P), bal0 = await balance(P);
      const a0 = P.asked.length, l0 = P.lines.length;
      P.rewrite = (p, m, b, text) => (m === 'POST' && p === '/v1/melt/quote/bolt11' ? answer(Object.assign(body(text), { unit: 'usd' })) : null);
      let no = '';
      try { await P.W.pay(FOREIGN, () => {}, {}); } catch (e) { no = e.message; }
      const melts = P.asked.slice(a0).filter((x) => x.method === 'POST' && x.path === '/v1/melt/bolt11').length;
      ok(!!no && melts === 0, 'f: a payment quote answered in another unit is refused, nothing melted', melts + ' melt(s); ' + no.slice(0, 80));
      ok(snapshot(P).melting === before.melting && snapshot(P).log === before.log && (await balance(P)) === bal0, 'f: no pieces held, no row, the balance as it was');
      ok(refusals(P, l0) >= 1, 'f: and said in a plain refusal line', refusals(P, l0) + ' line(s)');
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
