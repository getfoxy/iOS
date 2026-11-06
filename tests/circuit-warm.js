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
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 240000).unref();

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
        // a circuit that goes nowhere (`ctx.hang`): the request is written down and never answered
        if (ctx.hang && ctx.hang(row, label)) return null;
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
        'https://dead.test': fakeMint(w, { fill: 11, quoteFrom: 9000 }),
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

  /* ---- 3: a first connect whose circuit goes nowhere ---------------------------------------------------- *
   * A switch to a mint took 13.5 s on a phone where every other switch took 2.2 s: one bad circuit, and the
   * connect's reads (the mint's info, keysets and keys, `loadMintOnOne`) were never asked again elsewhere, as a
   * quote is. Now each is asked again on another circuit at the pace a quote is (`askedAgain`), inside the
   * connect's thirty seconds; and a mint that answers nothing still fails at those thirty seconds, not later. */
  {
    const p = page();
    const W = p.W;
    p.lat.build = 200; p.lat.answer = 50;
    // the first circuit any of THEIR's reads takes goes nowhere; every other answers
    let deadLabel = '';
    p.hang = (row, label) => {
      if (row.mint !== THEIR || !row.label) return false;
      if (!deadLabel) deadLabel = row.label;
      return row.label === deadLabel;
    };
    const lines = [];
    const was = p.window.console.log;
    p.window.console.log = (...a) => { lines.push(a.join(' ')); };
    let n = p.log.length;
    let t0 = Date.now();
    let no = '';
    try { await W.connect(THEIR, null, null, { remember: true }); } catch (e) { no = e.message; }
    const took = Date.now() - t0;
    p.window.console.log = was;
    const reads = since(p, n).filter((r) => r.mint === THEIR && /^\/v1\/(info|keysets|keys)/.test(r.path));
    const onDead = reads.filter((r) => r.label === deadLabel);
    const elsewhere = reads.filter((r) => r.label && r.label !== deadLabel);
    ok(!no && took < 12000, 'a first connect whose circuit goes nowhere completes on another, well inside its thirty seconds',
       (no ? no.slice(0, 80) + '; ' : '') + took + ' ms');
    ok(onDead.length >= 1 && elsewhere.length >= onDead.length, 'each read the dead circuit held was asked again on another circuit',
       onDead.length + ' on the dead circuit, ' + elsewhere.length + ' elsewhere');
    const again = lines.filter((l) => /has not answered in \d+s; asking again on another circuit/.test(l) && l.indexOf('their.test') >= 0);
    ok(again.length >= 1, 'and the log says so as a quote’s asking again does', again[0] || lines.filter((l) => /their/.test(l)).slice(0, 3).join(' | '));
    ok(/their\.test/.test(String(W.mintHost())), 'the phone is on that mint', String(W.mintHost()));

    // a mint that answers nothing at all: refused at the connect's thirty seconds, not later
    const DEAD = 'https://dead.test';
    p.hang = (row) => row.mint === DEAD;
    n = p.log.length;
    t0 = Date.now();
    no = '';
    try { await W.connect(DEAD, null, null, { remember: true }); } catch (e) { no = e.message; }
    const deadMs = Date.now() - t0;
    const deadReads = since(p, n).filter((r) => r.mint === DEAD);
    ok(!!no && deadMs >= 29000 && deadMs < 32000, 'a mint that never answers still fails at the thirty seconds, not later', deadMs + ' ms; ' + no.slice(0, 80));
    const labels = new Set(deadReads.map((r) => r.label));
    ok(deadReads.length <= 3 * 6, 'with a bounded number of askings', deadReads.length + ' requests on ' + labels.size + ' circuits');
    await sleep(1500);
    const late = p.log.slice(n).filter((r) => r.mint === DEAD && r.at > t0 + deadMs);
    ok(late.length === 0, 'and nothing is asked of it after the connect gave up', late.length + ' late request(s)');
  }

  console.log(failed ? '\n' + failed + ' circuit-warm check(s) failed' : '\nall circuit-warm checks pass');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
