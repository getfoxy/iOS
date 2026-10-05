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
 *      check. An unpaid invoice past the expiry it was made with is dropped.
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
    list[0].expiry = Math.floor(Date.now() / 1000) - 60;
    c.storage.setItem(key, JSON.stringify(list));
    await c.W.sweepQuotes();
    ok(c.W.pendingQuotes().length === 0, 'past the expiry it was made with, and still unpaid, it is dropped', c.W.pendingQuotes().length + ' waiting');
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

  console.log(failed ? '\n' + failed + ' mint-busy check(s) failed' : '\nall mint-busy checks pass');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
