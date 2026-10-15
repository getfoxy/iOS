'use strict';
/* mint-busy.js — a mint that turns requests away, and one that stops saying
 * when an invoice expires.
 *
 *     node tests/mint-busy.js
 *
 * Both from the survey of forge.flashapp.me (Nutshell 0.20.3.1, behind nginx)
 * through Tor:
 *
 *   A. HTTP 429, as a web page or as `Rate limit exceeded.`, counted against a
 *      Tor exit shared with strangers. Nothing was done, so the request is
 *      asked once more on a circuit of its own; a second refusal is said in
 *      words a person can act on.
 *   B. The expiry comes with a new mint quote and is `null` on every later
 *      check. An unpaid invoice five minutes past the expiry it was made with is dropped.
 *   D. A swap refused with HTTP 400 "failed to acquire database lock" (a busy
 *      Nutshell; "(sqlite3.OperationalError) database is locked" on SQLite).
 *      Nothing was done, so the same swap is sent again on the same circuit
 *      after 0.7 to 1.5 s, at most twice, and each time is said in the log.
 *      The third refusal, and any other 400, is final as before. Through the
 *      harness mint's `lockRefuse(n)`, for a receive, a send's swap and a
 *      dollar receive at a mint with two units.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let ctx = null, mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const path = new URL(m.url).pathname;
        ctx.asked.push({ what: m.method + ' ' + path.replace(/\/[0-9a-f-]{12,}$/i, '/:id'), circuit: String(m.circuit || '') });
        const said = ctx.say ? ctx.say(m, path) : null;
        return reply(w, m.id, said || mint.handle(m));
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.asked = [];
  ctx.say = null;
  ctx.mintSays = (m) => mint.handle(m);
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
/* A page whose mint can be another page's (`shared`), with what the wallet says
 * in its log kept in `said`. */
function lockPage(shared, mintOpts) {
  const phone = nativePhone({ words: PHONE_WORDS });
  let ctx = null, mint = shared || null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const path = new URL(m.url).pathname;
        ctx.asked.push({ what: m.method + ' ' + path.replace(/\/[0-9a-f-]{12,}$/i, '/:id'), circuit: String(m.circuit || ''), body: String(m.body || '') });
        return reply(w, m.id, ((ctx && ctx.mint) || mint).handle(m))  // `ctx.mint` may be swapped for a wrapper (D2);
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, Object.assign({ p2pk: true }, mintOpts || {}));
      ctx = ctx || {};
    },
  });
  ctx.asked = [];
  ctx.mint = mint;
  ctx.said = [];
  const real = ctx.window.console.log;
  ctx.window.console.log = function () { ctx.said.push(Array.prototype.join.call(arguments, ' ')); return real.apply(this, arguments); };
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  // quick pauses, except where the pause itself is what is asked about
  ctx.W._lockPause = [5, 15];
  return ctx;
}
const NGINX = '429\n<html>\r\n<head><title>429 Too Many Requests</title></head>\r\n<body><center><h1>429 Too Many Requests</h1></center><hr><center>nginx/1.18.0</center></body>\r\n</html>';
const quotes = (c) => c.asked.filter((x) => x.what === 'POST /v1/mint/quote/bolt11');

async function run() {
  console.log('A. turned away at the door');
  {
    const c = page();
    await c.W.connect(MINT, null, null, { remember: true });
    let turned = 0;
    c.say = (m, path) => (path === '/v1/mint/quote/bolt11' && turned++ === 0 ? NGINX : null);
    const t0 = Date.now();
    const inv = await c.W.invoice(100, '').then((x) => x, (e) => ({ err: e.message }));
    const asks = quotes(c);
    ok(!inv.err && !!inv.hash, 'a request turned away once (429, a web page) is asked again and goes through', inv.err || 'in ' + (Date.now() - t0) + ' ms');
    ok(asks.length === 2 && asks[1].circuit === '', 'once more, and on a circuit of its own', JSON.stringify(asks.map((x) => x.circuit || '(its own)')));
    ok(Date.now() - t0 >= 1400, 'after a pause, not at once', (Date.now() - t0) + ' ms');
  }
  {
    const c = page();
    await c.W.connect(MINT, null, null, { remember: true });
    c.say = (m, path) => (path === '/v1/mint/quote/bolt11' ? '429\n{"detail":"Rate limit exceeded."}' : null);
    const inv = await c.W.invoice(100, '').then((x) => x, (e) => ({ err: e.message, status: e.status }));
    ok(!!inv.err && /turning requests away/.test(inv.err) && /Nothing was done/.test(inv.err) && /^m\.test is /.test(inv.err),
       'turned away twice, the person is told what it is and that nothing was done', inv.err);
    ok(quotes(c).length === 2, 'and it is not asked a third time', quotes(c).length + ' asks');
    ok(inv.status === 429 && !c.W.pendingQuotes().length, 'no invoice is written down for it', JSON.stringify(c.W.pendingQuotes().length));
  }

  console.log('\nB. an invoice whose mint no longer says when it expires');
  {
    const c = page();
    await c.W.connect(MINT, null, null, { remember: true });
    await c.W.invoice(100, '');
    const key = 'foxy.cashu.quotes';
    const list = JSON.parse(c.storage.getItem(key));
    ok(list.length === 1 && list[0].expiry > Date.now() / 1000, 'the invoice is written down with the expiry the mint gave it', JSON.stringify({ expiry: list[0].expiry }));
    // every later check answers as forge does: unpaid, and no expiry
    c.say = (m, path) => {
      if (!/^\/v1\/mint\/quote\/bolt11\/./.test(path)) return null;
      const said = String(c.mintSays(m));
      const cut = said.indexOf('\n');
      return said.slice(0, cut + 1) + JSON.stringify(Object.assign(JSON.parse(said.slice(cut + 1)), { expiry: null, state: 'UNPAID' }));
    };
    await c.W.sweepQuotes();
    ok(c.W.pendingQuotes().length === 1, 'not yet expired, it is kept and asked about', c.W.pendingQuotes().length + ' waiting');
    /* A minute past it, kept: a payment on its way as the invoice ran out is
     * still settled by the mint (sweepQuotes keeps a lapsed record five
     * minutes, for that). */
    list[0].expiry = Math.floor(Date.now() / 1000) - 60;
    c.storage.setItem(key, JSON.stringify(list));
    await c.W.sweepQuotes();
    ok(c.W.pendingQuotes().length === 1, 'a minute past the expiry it was made with, it is still kept', c.W.pendingQuotes().length + ' waiting');
    list[0].expiry = Math.floor(Date.now() / 1000) - 360;
    c.storage.setItem(key, JSON.stringify(list));
    await c.W.sweepQuotes();
    ok(c.W.pendingQuotes().length === 0, 'well past the expiry it was made with, and still unpaid, it is dropped', c.W.pendingQuotes().length + ' waiting');
    const before = c.asked.length;
    await c.W.sweepQuotes();
    ok(c.asked.length === before, 'and the mint is not asked about it again', (c.asked.length - before) + ' more requests');
  }

  console.log('\nC. a mint that says "too many" is asked less often');
  {
    /* Two simulators: a receive screen at forge asked about its
     * invoice every two seconds, was turned away eleven times in a minute,
     * and asked again on a fresh circuit each time. For a minute after any
     * 429 the watch on an invoice asks no more than once in five seconds,
     * however it is hurried. */
    const c = page();
    await c.W.connect(MINT, null, null, { remember: true });
    const inv = await c.W.invoice(100, '');
    const status = () => c.asked.filter((x) => x.what === 'GET /v1/mint/quote/bolt11/:id').length;
    let turnAway = 1;
    c.say = (m, path) => {
      if (!/^\/v1\/mint\/quote\/bolt11\/./.test(path)) return null;
      if (turnAway-- > 0) return NGINX;
      const said = String(c.mintSays(m));
      const cut = said.indexOf('\n');
      return said.slice(0, cut + 1) + JSON.stringify(Object.assign(JSON.parse(said.slice(cut + 1)), { state: 'UNPAID' }));
    };
    const stop = c.W.watch(inv.hash, () => {}, {});
    await new Promise((r) => setTimeout(r, 1800));
    const afterFirst = status();
    ok(afterFirst === 2, 'turned away, the question is asked once more and answered', afterFirst + ' asked');
    c.W.watchKick(inv.hash, 20000); c.W.watchKick(inv.hash, 20000);
    await new Promise((r) => setTimeout(r, 3300));
    ok(status() === afterFirst, 'and for the next seconds it is not asked again, hurried or not', (status() - afterFirst) + ' more in 3.3 s (two seconds apart would be one or two, hurried would be three)');
    await new Promise((r) => setTimeout(r, 2200));
    ok(status() === afterFirst + 1, 'five seconds after the last question, it is', (status() - afterFirst) + ' more');
    stop();
  }

  console.log('\nD. a mint too busy to take its database lock');
  {
    const LOCK = 'failed to acquire database lock';
    const swaps = (c) => c.asked.filter((x) => x.what === 'POST /v1/swap');
    const busyLines = (c) => c.said.filter((l) => /mint busy \(lock\), asked again/.test(l));
    const sum = (l) => (l || []).reduce((a, p) => a + Number(p.amount || 0), 0);
    const pileOf = (c, unit) => JSON.parse(c.storage.getItem('foxy.cashu.proofs.' + MINT + (unit && unit !== 'sat' ? '@' + unit : '')) || '[]');
    // a payer with sats (and dollars, at a mint with two), and a receiver at the same mint
    const two = async (mintOpts) => {
      const a = lockPage(null, mintOpts);
      await a.W.connect(MINT, null, null, { remember: true });
      const inv = await a.W.invoice(1000, '');
      await a.W.claim(inv.hash);
      if (mintOpts && mintOpts.units) {
        const usd = await a.W.invoice(1000, '', { unit: 'usd' });
        await a.W.claim(usd.hash);
      }
      const b = lockPage(a.mint, mintOpts);
      await b.W.connect(MINT, null, null, { remember: true });
      return { a, b };
    };

    // one refusal: asked again, after a pause of 0.7 to 1.5 s, on the same circuit, with the same body
    {
      const { a, b } = await two();
      const sent = await a.W.sendToken(300);
      b.W._lockPause = null;
      b.mint.lockRefuse(1);
      const before = swaps(b).length;
      const t0 = Date.now();
      const got = await b.W.receiveToken(sent.token).then((r) => r, (e) => ({ err: e.message }));
      const took = Date.now() - t0;
      const mine = swaps(b).slice(before);
      ok(!got.err && got.sats === 300 && sum(pileOf(b)) === 300, 'a receive refused once as busy (lock) is asked again and lands', got.err || JSON.stringify({ sats: got.sats, pile: sum(pileOf(b)) }));
      // (a swap after it, if any, is the small-change top-up that follows a receive: another request)
      const same = mine.filter((x) => x.body === mine[0].body);
      ok(same.length === 2 && b.mint.lockRefused() === 1, 'the receive\'s swap went twice: the refused one and the one asked again', same.length + ' alike of ' + mine.length + ', ' + b.mint.lockRefused() + ' refused');
      ok(same.length === 2 && same[0].circuit === same[1].circuit && !!same[0].circuit,
         'on the same circuit, and the identical request (the same outputs)', JSON.stringify(same.map((x) => x.circuit.slice(0, 8))));
      const paused = Number((/after (\d+) ms/.exec(busyLines(b)[0] || '') || [])[1]);
      ok(paused >= 700 && paused <= 1500 && took >= paused, 'after a pause of 0.7 to 1.5 s', paused + ' ms paused, ' + took + ' ms in all');
      ok(busyLines(b).length === 1 && /1 of 2/.test(busyLines(b)[0]), 'and the log says so, counted', JSON.stringify(busyLines(b)));
      ok(b.W._lockAsked === 1, 'one retry counted on the wallet', String(b.W._lockAsked));
    }
    // two refusals: still lands, asked three times in all
    {
      const { a, b } = await two();
      const sent = await a.W.sendToken(200);
      b.mint.lockRefuse(2);
      const before = swaps(b).length;
      const got = await b.W.receiveToken(sent.token).then((r) => r, (e) => ({ err: e.message }));
      ok(!got.err && got.sats === 200 && sum(pileOf(b)) === 200, 'refused twice as busy, the receive still lands', got.err || String(got.sats));
      const mine = swaps(b).slice(before);
      ok(mine.filter((x) => x.body === mine[0].body).length === 3 && busyLines(b).length === 2 && /2 of 2/.test(busyLines(b)[1]) && b.W._lockAsked === 2,
         'the same swap three times, two retries said in the log and counted', mine.length + ' swaps; ' + JSON.stringify(busyLines(b)));
    }
    // three refusals: the third is final, in the mint's own words, and the ecash is still the giver's to hand over again
    {
      const { a, b } = await two();
      const sent = await a.W.sendToken(150);
      b.mint.lockRefuse(3);
      const before = swaps(b).length;
      const got = await b.W.receiveToken(sent.token).then((r) => r, (e) => ({ err: String((e && e.message) || e) }));
      ok(!!got.err && got.err.indexOf(LOCK) >= 0, 'refused a third time: it fails, with the original words', got.err || 'it landed');
      ok(swaps(b).length - before === 3 && busyLines(b).length === 2, 'and is not asked a fourth time', (swaps(b).length - before) + ' swaps');
      ok(sum(pileOf(b)) === 0 && b.W.balanceOf('sat') === 0, 'nothing was taken in', String(sum(pileOf(b))));
      const again = await b.W.receiveToken(sent.token).then((r) => r, (e) => ({ err: e.message }));
      ok(!again.err && again.sats === 150, 'and the same token is taken when the mint is free again', again.err || String(again.sats));
    }
    // another 400 is final at once
    {
      const { a, b } = await two();
      const sent = await a.W.sendToken(120);
      b.mint.lockRefuse(1, 'Transaction is not valid.');
      const before = swaps(b).length;
      const got = await b.W.receiveToken(sent.token).then((r) => r, (e) => ({ err: String((e && e.message) || e) }));
      ok(!!got.err && /Transaction is not valid/.test(got.err), 'a different refusal fails as it always did', got.err || 'it landed');
      ok(swaps(b).length - before === 1 && busyLines(b).length === 0 && !b.W._lockAsked, 'and is not asked again', (swaps(b).length - before) + ' swaps');
    }
    // SQLite's words, and a send's own swap
    {
      const { a, b } = await two();
      const sent = await a.W.sendToken(90);
      b.mint.lockRefuse(1, '(sqlite3.OperationalError) database is locked');
      const got = await b.W.receiveToken(sent.token).then((r) => r, (e) => ({ err: e.message }));
      ok(!got.err && got.sats === 90 && busyLines(b).length === 1, 'SQLite\'s "database is locked" is busy too', got.err || JSON.stringify(busyLines(b)));
      a.mint.lockRefuse(1);
      const before = swaps(a).length;
      const made = await a.W.sendToken(77).then((r) => r, (e) => ({ err: e.message }));
      ok(!made.err && !!made.token && swaps(a).length - before === 2 && busyLines(a).length === 1,
         'a send\'s swap refused as busy is asked again and the token is made', made.err || (swaps(a).length - before) + ' swaps');
      const back = await b.W.receiveToken(made.token).then((r) => r, (e) => ({ err: e.message }));
      ok(!back.err && back.sats === 77, 'and that token is good', back.err || String(back.sats));
    }
    // dollars at a mint with two balances
    {
      const { a, b } = await two({ units: ['sat', 'usd'] });
      const sent = await a.W.sendToken(250, { unit: 'usd' });
      b.mint.lockRefuse(1);
      const before = swaps(b).length;
      const got = await b.W.receiveToken(sent.token).then((r) => r, (e) => ({ err: e.message }));
      ok(!got.err && got.unit === 'usd' && got.amount === 250, 'a dollar receive refused as busy is asked again and lands', got.err || JSON.stringify(got));
      ok(sum(pileOf(b, 'usd')) === 250 && b.W.balanceOf('usd') === 250 && b.W.balanceOf('sat') === 0,
         'in the dollar pile, and no sats', JSON.stringify({ usd: sum(pileOf(b, 'usd')), sat: b.W.balanceOf('sat') }));
      const mine = swaps(b).slice(before);
      ok(mine.filter((x) => x.body === mine[0].body).length === 2 && busyLines(b).length === 1 && b.mint.lockRefused() === 1,
         'the same swap twice, one retry said', mine.length + ' swaps');
    }
  }

  /* A mint that said busy and did the swap anyway: the worst a retry can meet.
   * The first request is acted on at the mint and answered "failed to acquire
   * database lock"; the identical one sent again then meets its own work done
   * (the inputs spent, the outputs signed). The money must land once: not
   * twice, and not nowhere. */
  console.log('\nD2. a mint that said busy and took the swap all the same');
  {
    const swaps = (c) => c.asked.filter((x) => x.what === 'POST /v1/swap');
    const sum = (l) => (l || []).reduce((a, p) => a + Number(p.amount || 0), 0);
    const pileOf = (c) => JSON.parse(c.storage.getItem('foxy.cashu.proofs.' + MINT) || '[]');
    const a = lockPage(null);
    await a.W.connect(MINT, null, null, { remember: true });
    const inv = await a.W.invoice(1000, '');
    await a.W.claim(inv.hash);
    const b = lockPage(a.mint);
    // the first swap b sends is done by the mint, and answered as busy
    const realHandle = a.mint.handle;
    let lied = 0;
    const bMint = Object.assign({}, a.mint, {
      handle: (m) => {
        const path = new URL(m.url).pathname;
        if (path === '/v1/swap' && !lied) {
          lied += 1;
          realHandle(m);
          return '400\n' + JSON.stringify({ detail: 'failed to acquire database lock', code: 0 });
        }
        return realHandle(m);
      },
    });
    b.mint = bMint;
    // (lockPage reads `mint` from its closure: route b's requests through the liar)
    await b.W.connect(MINT, null, null, { remember: true });
    const sent = await a.W.sendToken(400);
    const before = swaps(b).length;
    b.W._swapSilentMs = 50; b.W._swapLookMs = 50;
    const got = await b.W.receiveToken(sent.token).then((r) => r, (e) => ({ err: String((e && e.message) || e) }));
    // whatever the receive said, what the wallet holds once the recovery has run is the question
    try { await b.W.recoverSwaps(); } catch (e) {}
    const mine = swaps(b).slice(before);
    const held = sum(pileOf(b));
    ok(lied === 1 && mine.length >= 2 && mine[0].body === mine[1].body, 'the mint acted on the first and said busy; the identical swap went again',
       lied + ' lied, ' + mine.length + ' swaps');
    ok(held === 400 && b.W.balanceOf('sat') === 400, 'the money is in the pile once: not twice, not lost',
       JSON.stringify({ got: got.err || got.sats, pile: held, balance: b.W.balanceOf('sat') }));
  }

  console.log(failed ? '\n' + failed + ' mint-busy check(s) failed' : '\nall mint-busy checks pass');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
