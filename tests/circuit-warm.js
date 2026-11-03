'use strict';
/* circuit-warm.js — the road to a mint opened before it is needed, and a crossing's two quotes.
 *
 *     node tests/circuit-warm.js
 *
 * The first request to a mint after a quiet spell paid for a whole Tor circuit, three to six seconds of it ("a circuit
 * to ... is ready for what comes next, in 6081 ms"), and a crossing asked its two mints in turn, each on a circuit
 * built for it on the spot. Two things now: a screen that will ask a mint something within seconds opens the road
 * first (`warm`), once a minute a mint at most; and a crossing builds the circuit of the quote that waits (the near
 * mint's fee for the far mint's invoice) while the invoice is being made (`quoteRoad`).
 *
 * The phone here is a stub with circuits in it: a label's first request pays for its circuit to be built (BUILD ms),
 * a request on a label whose circuit is built or being built waits only for that, an unlabelled one always gets a
 * new circuit, and the mint answers ANSWER ms after the circuit is there. Each request is written down with its
 * label, so a job taking the warmed circuit can be seen, and how long it waited measured. Two mints of cashu-ts's
 * own crypto (tests/harness.js `fakeMint`) and the wallet as it ships. */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const HOME = 'https://home.test';
const THEIR = 'https://their.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canon = (u) => String(u || '').replace(/\/+$/, '');
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 120000).unref();

/* A page on two mints, with a phone whose circuits take time to build. `lat` is changed as the test goes. */
function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mints = null;
  const lat = { build: 0, answer: 0 };
  const built = new Map();
  let anon = 0;
  const log = [];
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const u = new URL(m.url);
        const mint = mints[canon(u.origin)];
        if (!mint) return reply(w, m.id, null, 'no such mint in this test');
        const label = m.circuit || ('anon-' + (++anon));
        if (!built.has(label)) built.set(label, sleep(lat.build));
        const row = { at: Date.now(), method: m.method, mint: canon(u.origin), path: u.pathname, label: m.circuit || '', warm: !!m.warm, ms: 0 };
        log.push(row);
        const answer = lat.answer;
        built.get(label).then(() => sleep(answer)).then(() => { row.ms = Date.now() - row.at; reply(w, m.id, mint.handle(m)); });
        return null;
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      mints = {
        [HOME]: fakeMint(w, { p2pk: true, fill: 7 }),
        [THEIR]: fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 5000 }),
      };
    },
  });
  ctx.lat = lat;
  ctx.log = log;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  // no circuit kept ready opens by itself behind a job in this suite: what is opened is what the test asked for
  ctx.W._spareAfterMs = 1e9;
  return ctx;
}

async function fund(c, at, sats) {
  await c.W.connect(at, null, null, { remember: true });
  const inv = await c.W.invoice(sats, '');
  await c.W.claim(inv.hash);
}
const since = (c, n) => c.log.slice(n);
const is = (r, method, mint, path) => r.method === method && r.mint === mint && r.path === path;

async function run() {
  /* ---- 1: a screen opens the road; the job that follows takes it ---------------------------------------- */
  {
    const p = page();
    const W = p.W;
    await fund(p, HOME, 2000);
    p.lat.build = 300; p.lat.answer = 50;
    W._spareOff = false;

    // an invoice with no road opened: its own circuit, built while the person waits
    let n = p.log.length;
    let t0 = Date.now();
    await W.invoice(100, '');
    const cold = Date.now() - t0;
    const coldQuote = since(p, n).find((r) => is(r, 'POST', HOME, '/v1/mint/quote/bolt11'));
    ok(!!coldQuote && cold >= 300, 'an invoice with no road opened waits for its circuit to be built', cold + ' ms');

    // the receive screen opens: one keysets question, on a circuit kept for the job, marked as the spare's
    n = p.log.length;
    const went = await W.warm();
    const opened = since(p, n);
    ok(went === true && opened.length === 1 && is(opened[0], 'GET', HOME, '/v1/keysets') && opened[0].label && opened[0].warm,
       'warm(): the connected mint is asked its keysets once, on a labelled circuit, marked as the spare',
       JSON.stringify(opened.map((r) => r.method + ' ' + r.path + ' ' + (r.label ? 'labelled' : 'bare') + (r.warm ? ' warm' : ''))));
    const L = opened[0] && opened[0].label;
    ok(W._spare() === L, 'and the circuit is kept ready');
    n = p.log.length;
    ok(await W.warm() === true && p.log.length === n, 'a second warm() with the road ready asks nothing');

    // the invoice that follows takes it
    n = p.log.length;
    t0 = Date.now();
    await W.invoice(100, '');
    const warmed = Date.now() - t0;
    const q = since(p, n).find((r) => is(r, 'POST', HOME, '/v1/mint/quote/bolt11'));
    ok(!!q && q.label === L, 'the invoice rides the warmed circuit', q ? (q.label === L ? 'same label' : 'another label') : 'no invoice asked');
    ok(warmed < cold && warmed < 300, 'and waits only for the mint, not for a circuit', 'cold ' + cold + ' ms, warmed ' + warmed + ' ms');
    ok(W._spare() === '', 'the circuit is the invoice’s now, kept for nobody else');

    // within the minute, a screen opened again asks nothing, though the road has gone
    n = p.log.length;
    ok(await W.warm() === false && p.log.length === n, 'warm() again inside sixty seconds: refused, nothing asked');
    // a minute on, it is opened again
    const realNow = p.window.Date.now;
    p.window.Date.now = () => realNow.call(p.window.Date) + 61000;
    n = p.log.length;
    ok(await W.warm() === true && since(p, n).filter((r) => is(r, 'GET', HOME, '/v1/keysets')).length === 1,
       'sixty seconds later it is opened again');
    p.window.Date.now = realNow;

    // a cold Tor, no network, and a switch still to answer: nothing asked
    const far = 'https://elsewhere.test';
    W._privacy({ tor: 'connecting', progress: 40, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' });
    n = p.log.length;
    ok(await W.warm(THEIR) === false && p.log.length === n, 'Tor not up yet: warm() asks nothing');
    W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct', network: 'none' });
    n = p.log.length;
    ok(await W.warm(THEIR) === false && p.log.length === n, 'no network: warm() asks nothing');
    W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' });
    await sleep(500);   // the route's return opens the spare by itself (11-routing.js); let it land
    const pend = W.connectPending;
    W.connectPending = () => ({ url: far, host: 'elsewhere.test', since: Date.now(), noKeys: false, failed: '' });
    n = p.log.length;
    ok(await W.warm(THEIR) === false && p.log.length === n, 'a mint switched to and not yet answered: warm() asks nothing');
    W.connectPending = pend;
    W._spareOff = true;
    n = p.log.length;
    ok(await W.warm(THEIR) === false && p.log.length === n, 'and nothing at all where the page opens no circuits ahead (the tests’ default)');
    W._spareOff = false;

    // another mint: a circuit kept there for the next quote, not marked as the spare's
    n = p.log.length;
    ok(await W.warm(THEIR) === true, 'warm(url) at another mint answers');
    const farOpened = since(p, n);
    const F = farOpened[0] && farOpened[0].label;
    ok(farOpened.length === 1 && is(farOpened[0], 'GET', THEIR, '/v1/keysets') && !!F && !farOpened[0].warm && W._farRoad(THEIR) === F,
       'warm(url): that mint’s keysets, once, on a circuit kept for it, and not the spare’s connection',
       JSON.stringify(farOpened.map((r) => r.mint + r.path + (r.warm ? ' warm' : ''))));
    n = p.log.length;
    ok(await W.warm(THEIR) === true && p.log.length === n, 'asked again with it kept: nothing more asked');
    // a quote from that mint takes it
    n = p.log.length;
    await W.transferQuote(THEIR, 100, { to: HOME, quoteOnly: true });
    const mq = since(p, n).find((r) => is(r, 'POST', THEIR, '/v1/melt/quote/bolt11'));
    ok(!!mq && mq.label === F && W._farRoad(THEIR) === '', 'the next quote at that mint rides it, and it is let go', mq ? mq.label.slice(0, 6) + ' vs ' + String(F).slice(0, 6) : 'no melt quote');
  }

  /* ---- 2: a crossing's two quotes, each leg two seconds ------------------------------------------------- *
   * The far mint's invoice, then the near mint's fee for it: the second needs the first's invoice. Each leg
   * here is a circuit of 1,500 ms and an answer of 500 ms. In turn, each on a circuit built when it is asked,
   * that was four seconds. The near mint's circuit is now built while the invoice is made. */
  {
    const p = page();
    const W = p.W;
    await fund(p, HOME, 2000);
    // what each mint is, loaded once at no cost, so the timing below is the two quotes and nothing else
    await W.transferQuote(HOME, 300, { to: THEIR, land: true });
    W._spareOff = false;
    p.lat.build = 1500; p.lat.answer = 500;

    W._quoteWarmOff = true;
    let n = p.log.length;
    let t0 = Date.now();
    const before = await W.transferQuote(HOME, 300, { to: THEIR, land: true });
    const beforeMs = Date.now() - t0;
    const b = since(p, n);
    ok(!!before.meltQuote && beforeMs >= 3900, 'before: the invoice and then the fee quote, each on a circuit built for it', beforeMs + ' ms');
    ok(!b.some((r) => r.label), 'and neither on a circuit opened ahead');

    W._quoteWarmOff = false;
    n = p.log.length;
    t0 = Date.now();
    const after = await W.transferQuote(HOME, 300, { to: THEIR, land: true });
    const afterMs = Date.now() - t0;
    const a = since(p, n);
    const road = a.find((r) => is(r, 'GET', HOME, '/v1/keysets'));
    const inv = a.find((r) => is(r, 'POST', THEIR, '/v1/mint/quote/bolt11'));
    const melt = a.find((r) => is(r, 'POST', HOME, '/v1/melt/quote/bolt11'));
    ok(!!road && !!inv && road.at <= inv.at + 5, 'after: the near mint’s circuit is opened as the far mint is asked for the invoice',
       road && inv ? 'road +' + (road.at - t0) + ' ms, invoice +' + (inv.at - t0) + ' ms' : 'not asked');
    ok(!!melt && !!road && melt.label === road.label, 'the fee quote rides that circuit');
    ok(!!melt && melt.ms < 1000, 'and waits only for the mint', melt ? melt.ms + ' ms' : '');
    ok(!!after.meltQuote && afterMs < beforeMs - 1000 && afterMs < 3000,
       'the crossing’s quote: ' + (beforeMs / 1000).toFixed(1) + ' s in turn, ' + (afterMs / 1000).toFixed(1) + ' s now',
       'saved ' + ((beforeMs - afterMs) / 1000).toFixed(1) + ' s');
    ok(after.gross === before.gross && after.moving === before.moving, 'with the same figures as before', after.gross + ' / ' + before.gross);

    // with the spare kept ready at the near mint, the fee quote takes that one and asks nothing more
    p.lat.build = 300; p.lat.answer = 50;
    await W.warm();
    const S = W._spare();
    n = p.log.length;
    await W.transferQuote(HOME, 300, { to: THEIR, land: true });
    const c = since(p, n);
    const m2 = c.find((r) => is(r, 'POST', HOME, '/v1/melt/quote/bolt11'));
    ok(!!S && !!m2 && m2.label === S && !c.some((r) => is(r, 'GET', HOME, '/v1/keysets')),
       'a spare ready at the near mint is the fee quote’s, and no other circuit is opened for it');
  }

  console.log(failed ? '\n' + failed + ' circuit-warm check(s) failed' : '\nall circuit-warm checks pass');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
