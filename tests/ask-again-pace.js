'use strict';
/* ask-again-pace.js — a slow question is asked again at the mint's own pace.
 *
 *     node tests/ask-again-pace.js
 *
 * A question to a mint that has not answered is asked again on a fresh
 * circuit (`askedAgain`, and statesOf's second ask). It used to be every five
 * seconds whatever the mint; at a mint answering in thirteen seconds because
 * it is busy, that is more circuits on a mint that already has too many. The
 * wait is now twice the middle of the mint's last eight answer times, never
 * below five seconds (six for a proof check) nor above twenty, and the number
 * of extra circuits shrinks so the askings still fit the caller's allowance.
 *
 *   A. the record: empty at launch, per mint host, the last eight, and only a
 *      2xx counts: a 429, a 400, a broken circuit add nothing; nor does a
 *      melt, which waits on Lightning, nor a Lightning address's lookup
 *   G. a mint is paced only once it has answered three times: one slow first
 *      answer (its circuit still being built) leaves the five-second floor
 *   B. a mint that answers in about a second is asked once
 *   C. one that answers in about twelve is asked again no sooner than twenty
 *      seconds, and one that answers in about five no sooner than ten, twice
 *   D. one that never answers is still asked again at the five-second floor
 *   E. a proof check's second ask keeps its six-second floor and stretches
 *      the same way
 *   F. no timer of askedAgain outlives its question: gone when the answer
 *      comes, and gone by the time the caller gives up
 *
 * Real timers, the longest scenarios side by side: about forty seconds.
 */
const { loadReal, fakeMint, nativePhone, noBooks, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const lines = [];
const ok = (good, name, detail) => {
  lines.push((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* A page with a mint behind the bridge. `c.delay(m, path, n)` is how long the
 * n-th request to that path waits before it is answered (0 unless said), or
 * 'hang' for one never answered; `c.say(m, path, n)` answers in place of the
 * mint ('<code>\n<body>'), or `{ err }` for a request that never got one.
 * Every request is written down with when it left. */
function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let ctx = null, mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const count = {};
  ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const path = new URL(m.url).pathname;
        const what = m.method + ' ' + path.replace(/\/[0-9a-f-]{12,}$/i, '/:id');
        const n = (count[what] = (count[what] || 0) + 1);
        ctx.asked.push({ what, host: new URL(m.url).host, circuit: String(m.circuit || ''), at: Date.now() - ctx.t0 });
        const wait = ctx.delay ? ctx.delay(m, path, n) : 0;
        if (wait === 'hang') return;
        return setTimeout(() => {
          const said = ctx.say ? ctx.say(m, path, n) : null;
          if (said && said.err) return reply(w, m.id, null, said.err);
          reply(w, m.id, said || mint.handle(m));
        }, Number(wait) || 0);
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.asked = [];
  ctx.t0 = Date.now();
  ctx.delay = null;
  ctx.say = null;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.timers = trackAskAgain(ctx.window);
  return ctx;
}

/* Every timer askedAgain starts, found by the function that starts it, and
 * which of them are still to fire: fired and cleared ones leave the set. */
function trackAskAgain(win) {
  const live = new Set();
  let made = 0;
  const set = win.setTimeout, clear = win.clearTimeout;
  win.setTimeout = function (fn, ms) {
    const mine = /askAgainLater/.test(String(new Error().stack || ''));
    const rest = Array.prototype.slice.call(arguments, 2);
    const h = set.call(win, function () { live.delete(h); return typeof fn === 'function' ? fn.apply(this, arguments) : undefined; }, ms);
    if (mine) { live.add(h); made += 1; }
    return h;
  };
  win.clearTimeout = function (h) { live.delete(h); return clear.call(win, h); };
  return { live: () => live.size, made: () => made };
}

const quotes = (c) => c.asked.filter((x) => x.what === 'POST /v1/mint/quote/bolt11');
const meltQuotes = (c) => c.asked.filter((x) => x.what === 'POST /v1/melt/quote/bolt11');
const checks = (c) => c.asked.filter((x) => x.what === 'POST /v1/checkstate');
const since = (list, t) => list.map((x) => x.at - t);

async function connectedPage() {
  const c = page();
  await c.W.connect(MINT, null, null, { remember: true });
  await pause(20);
  return c;
}

/* Eight answers that each took `ms`, asked side by side so they take `ms` in
 * all: the mint's record is then eight of about `ms`. */
async function slowRecord(c, ms, host) {
  const at = host || MINT;
  c.delay = (m, path) => (path === '/v1/info' && new URL(m.url).origin === at ? ms : 0);
  const asks = [];
  for (let i = 0; i < 8; i++) asks.push(c.W.nativeRequest({ endpoint: at + '/v1/info', method: 'GET', foxyFresh: true }));
  await Promise.all(asks);
  c.delay = null;
}

/* A proof at the mint, set aside, for unquarantine to ask the mint about. */
function setAside(c, secret) {
  c.storage.setItem('foxy.cashu.quarantine', JSON.stringify([{ mint: MINT, unit: 'sat',
    proof: { id: '00ad268c4d1f5826', amount: 1, secret, C: '02' + '11'.repeat(32) } }]));
  noBooks(c, 'a made-up proof set aside, for the mint to be asked about');
}

const INVOICE = 'lnbc80n1pj9qz8psp5l0k3hh5vqf8kqlfz6zqshrw0r0t5c7c3rfxfefyx7d4l0f9xp9sqpp5ytedh4sp9n3n2wz3r7m0nyhhc2spsm3xr0s8m3m8sxj0a2gkp0hqdqqcqzzsxqyz5vq9qyyssq8fdpcm4wd4zdpz3wzxe9q2xmqwqf4l9kp0r9h0zxh7k3c7n8rkm3d2y0w7jg8a2a4wqr5u3m6l3f8t2qt7yq0e6vcxk5t9h3gp6yh6gqpjkc8c';

async function partA() {
  // empty at launch, and an empty record is today's five (six for a proof check)
  const fresh = page();
  ok(fresh.W._answerTimes(MINT).length === 0 && fresh.W._askAgainWait(MINT) === 5000 && fresh.W._askAgainWait(MINT, 6000) === 6000,
     'A. at launch nothing is known of a mint: five seconds, six for a proof check',
     JSON.stringify({ times: fresh.W._answerTimes(MINT), wait: fresh.W._askAgainWait(MINT) }));

  const c = await connectedPage();
  const had = c.W._answerTimes(MINT);
  ok(had.length > 0 && had.length <= 8 && c.W._askAgainWait(MINT) === 5000,
     'A. connecting fills the record with the mint’s quick answers, and the wait stays at five seconds', JSON.stringify(had));

  // only the last eight are kept, and the wait is twice their middle, at most twenty
  await slowRecord(c, 3000);
  const three = c.W._answerTimes(MINT);
  ok(three.length === 8 && three.every((t) => t >= 2900 && t < 4500), 'A. the last eight answers are kept, not more', JSON.stringify(three));
  const wait3 = c.W._askAgainWait(MINT);
  ok(wait3 >= 5900 && wait3 <= 8000 && wait3 === Math.round(2 * three.slice().sort((a, b) => a - b).slice(3, 5).reduce((a, b) => a + b) / 2),
     'A. the wait is twice the middle answer: about three seconds a question waits about six', String(wait3));
  ok(c.W._askAgainWait(MINT, 6000) === wait3, 'A. and a proof check’s wait is the same once past its six-second floor', String(c.W._askAgainWait(MINT, 6000)));

  // per host: another mint's record is its own; the same host by another path is the same record
  ok(c.W._answerTimes('https://other.test').length === 0 && c.W._askAgainWait('https://other.test') === 5000,
     'A. another mint knows nothing of this one’s answers', JSON.stringify(c.W._answerTimes('https://other.test')));
  ok(c.W._answerTimes('https://M.test/some/path').join() === three.join(), 'A. a mint is known by its host', JSON.stringify(c.W._answerTimes('https://M.test/some/path')));
  await slowRecord(c, 1500, 'https://other.test');
  ok(c.W._answerTimes(MINT).join() === three.join() && c.W._answerTimes('https://other.test').length === 8,
     'A. answers from another mint go on its record, not this one’s', JSON.stringify(c.W._answerTimes('https://other.test')));

  // what counts nothing: a refusal however slow, a 400, a circuit that broke
  const before = c.W._answerTimes(MINT).join();
  const info = () => c.W.nativeRequest({ endpoint: MINT + '/v1/info', method: 'GET', foxyFresh: true }).then(() => 'answered', (e) => 'refused ' + (e.status || e.message));
  c.delay = () => 2500;
  c.say = () => '429\n{"detail":"Rate limit exceeded."}';
  const slow429 = await info();
  ok(slow429 === 'refused 429' && c.W._answerTimes(MINT).join() === before, 'A. a slow 429, and the 429 on the circuit asked once more, add nothing',
     slow429 + ', ' + JSON.stringify(c.W._answerTimes(MINT)));
  c.delay = () => 0;
  const fast429 = await info();
  ok(fast429 === 'refused 429' && c.W._answerTimes(MINT).join() === before, 'A. nor does a fast one: it would hurry a busy mint',
     JSON.stringify(c.W._answerTimes(MINT)));
  c.say = () => '400\n{"detail":"no","code":10000}';
  const refused = await info();
  ok(/^refused/.test(refused) && c.W._answerTimes(MINT).join() === before, 'A. a 400 adds nothing', refused);
  c.say = () => '503\n<html>gone</html>';
  const gone = await info();
  ok(/^refused/.test(gone) && c.W._answerTimes(MINT).join() === before, 'A. a 503 from a proxy adds nothing', gone);
  c.delay = () => 4000;
  c.say = () => ({ err: 'The request timed out.' });
  const broken = await info();
  ok(/^refused/.test(broken) && c.W._answerTimes(MINT).join() === before, 'A. a timeout or a broken circuit adds nothing: one bad circuit never slows the app',
     broken + ', ' + JSON.stringify(c.W._answerTimes(MINT)));
  // turned away slowly, then answered at once on the next circuit: what counts is the answer's own time, not the refusal's
  let door = 0;
  c.delay = () => (door++ === 0 ? 3000 : 0);
  let turned = 0;
  c.say = () => (turned++ === 0 ? '429\n{"detail":"Rate limit exceeded."}' : null);
  const after = await info();
  const last = c.W._answerTimes(MINT).slice(-1)[0];
  ok(after === 'answered' && last < 1000, 'A. a request turned away and then answered counts the answer’s own time, not the wait at the door',
     after + ', ' + last + ' ms');
  c.say = null; c.delay = null;

  // a melt is held open while its Lightning payment routes: that is Lightning's time, not the mint's
  const beforeMelt = c.W._answerTimes(MINT).join();
  const post = (path, body) => c.W.nativeRequest({ endpoint: MINT + path, method: 'POST', requestBody: body, foxyFresh: true })
    .then(() => 'answered', (e) => 'refused ' + (e.status || e.message));
  c.delay = (m, path) => (path === '/v1/melt/bolt11' ? 3000 : 0);
  c.say = (m, path) => (path === '/v1/melt/bolt11' ? '200\n{"quote":"q1","state":"PAID","payment_preimage":null,"change":[]}' : null);
  const melted = await post('/v1/melt/bolt11', { quote: 'q1', inputs: [] });
  ok(melted === 'answered' && c.W._answerTimes(MINT).join() === beforeMelt,
     'A. a slow melt, answered, adds nothing: it waited on Lightning, not on the mint', melted + ', ' + JSON.stringify(c.W._answerTimes(MINT)));
  // its quote is the mint's own work, and counts
  c.delay = (m, path) => (path === '/v1/melt/quote/bolt11' ? 1200 : 0);
  c.say = (m, path) => (path === '/v1/melt/quote/bolt11'
    ? '200\n{"quote":"q2","amount":8,"fee_reserve":2,"state":"UNPAID","expiry":9999999999,"request":"' + INVOICE + '","unit":"sat"}' : null);
  const quoted = await post('/v1/melt/quote/bolt11', { request: INVOICE, unit: 'sat' });
  const lastQuote = c.W._answerTimes(MINT).slice(-1)[0];
  ok(quoted === 'answered' && lastQuote >= 1100 && lastQuote < 2500, 'A. while a melt quote, which the mint answers by itself, is timed', quoted + ', ' + lastQuote + ' ms');
  // a Lightning address's lookup is no mint's answer, even on a mint's own host
  const beforeAddr = c.W._answerTimes(MINT).join();
  c.delay = () => 2500;
  c.say = (m, path) => (/^\/\.well-known\/lnurlp\//.test(path)
    ? '200\n{"tag":"payRequest","callback":"' + MINT + '/lnurlp/cb","minSendable":1000,"maxSendable":100000000,"metadata":"[[\\"text/plain\\",\\"x\\"]]"}'
    : '200\n{"pr":"' + INVOICE + '","routes":[]}');
  const looked = await c.W.lookupLnurl('alice@m.test', 10).then(() => 'answered', (e) => 'refused ' + e.message);
  const addrAsks = c.asked.filter((x) => /lnurlp/.test(x.what)).length;
  ok(addrAsks >= 1 && c.W._answerTimes(MINT).join() === beforeAddr,
     'A. a Lightning address’s lookup on a mint’s host adds nothing to that mint’s record', looked + ', ' + addrAsks + ' asked, ' + JSON.stringify(c.W._answerTimes(MINT)));
  c.say = null; c.delay = null;
}

async function partG() {
  /* The first request after a route comes back can take twenty seconds while
   * its circuit is built. One such answer, or one among two, must not pace
   * the mint: the wait stays at its floor until three answers are known. */
  const g = page();
  const info = (p) => p.W.nativeRequest({ endpoint: MINT + '/v1/info', method: 'GET', foxyFresh: true });
  g.delay = () => 12000;
  await info(g);
  ok(g.W._answerTimes(MINT).length === 1 && g.W._askAgainWait(MINT) === 5000 && g.W._askAgainWait(MINT, 6000) === 6000,
     'G. one twelve-second answer on an empty record leaves five seconds, six for a proof check',
     JSON.stringify({ times: g.W._answerTimes(MINT), wait: g.W._askAgainWait(MINT), check: g.W._askAgainWait(MINT, 6000) }));
  g.delay = () => 0;
  await info(g);
  ok(g.W._answerTimes(MINT).length === 2 && g.W._askAgainWait(MINT) === 5000,
     'G. one slow and one quick: still five seconds', JSON.stringify(g.W._answerTimes(MINT)));
  await info(g);
  ok(g.W._answerTimes(MINT).length === 3 && g.W._askAgainWait(MINT) === 5000,
     'G. with three, the slow one is not the middle: five seconds', JSON.stringify(g.W._answerTimes(MINT)));
  // three slow answers are a slow mint
  const h = page();
  h.delay = () => 12000;
  await Promise.all([info(h), info(h), info(h)]);
  ok(h.W._answerTimes(MINT).length === 3 && h.W._askAgainWait(MINT) === 20000 && h.W._askAgainWait(MINT, 6000) === 20000,
     'G. three twelve-second answers are a slow mint: twenty seconds', JSON.stringify({ times: h.W._answerTimes(MINT), wait: h.W._askAgainWait(MINT) }));
}

async function partB() {
  const c = await connectedPage();
  await slowRecord(c, 1000);
  c.delay = (m, path) => (path === '/v1/mint/quote/bolt11' ? 1000 : 0);
  const t = Date.now() - c.t0;
  const inv = await c.W.invoice(100, '').then((x) => x, (e) => ({ err: e.message }));
  const live = c.timers.live();
  await pause(5600);
  ok(!inv.err && quotes(c).length === 1 && c.W._askAgainWait(MINT) === 5000,
     'B. a mint answering in about a second is asked once for a quote, and its wait is the five-second floor',
     (inv.err || 'answered') + ', ' + quotes(c).length + ' asked, wait ' + c.W._askAgainWait(MINT) + ' ms, at ' + JSON.stringify(since(quotes(c), t)));
  ok(live === 0 && c.timers.made() >= 1, 'F. the answer stops the ask-again timer at once', live + ' still set when the answer came');
}

async function partC12() {
  // twelve seconds an answer: twice that is more than twenty, so twenty
  const c = await connectedPage();
  await slowRecord(c, 12000);
  ok(c.W._askAgainWait(MINT) === 20000 && c.W._askAgainWait(MINT, 6000) === 20000,
     'C. a mint answering in about twelve seconds is waited on twenty, the most', String(c.W._askAgainWait(MINT)));
  // a quote that answers in twelve: asked once, no second circuit at all
  c.delay = (m, path) => (path === '/v1/mint/quote/bolt11' ? 12000 : 0);
  const inv = await c.W.invoice(100, '').then((x) => x, (e) => ({ err: e.message }));
  ok(!inv.err && quotes(c).length === 1, 'C. its twelve-second quote is asked once: no second circuit added to its load', quotes(c).length + ' asked');
  ok(c.timers.live() === 0, 'F. and the timer is gone with the answer', c.timers.live() + ' set');
  // the first asking never answers: the second goes no sooner than twenty seconds, and there is no third
  const t = Date.now() - c.t0;
  const before = quotes(c).length;
  c.delay = (m, path, n) => (path === '/v1/mint/quote/bolt11' ? (n === before + 1 ? 'hang' : 0) : 0);
  const got = await c.W.invoice(100, '').then((x) => x, (e) => ({ err: e.message }));
  const at = since(quotes(c).slice(before), t);
  ok(!got.err && at.length === 2 && at[1] >= 19900 && at[1] < 22000,
     'C. a quote not answered is asked again no sooner than the stretched twenty seconds', JSON.stringify(at));
  return c;
}

async function partC5() {
  // a little under five seconds an answer: a little under ten seconds' wait, two more circuits in thirty
  const c = await connectedPage();
  await slowRecord(c, 4800);
  const wait = c.W._askAgainWait(MINT);
  ok(wait >= 9500 && wait < 10000, 'C. a mint answering in just under five seconds is waited on just under ten', String(wait));
  const t = Date.now() - c.t0;
  c.delay = (m, path) => (path === '/v1/mint/quote/bolt11' ? 'hang' : 0);
  c.W.invoice(100, '').then(() => {}, () => {});
  await pause(29000);
  const at = since(quotes(c), t);
  ok(at.length === 3 && at[1] >= wait - 100 && at[2] >= 2 * wait - 100,
     'C. and asked again twice, each that long apart: the askings still fit the thirty seconds', JSON.stringify(at) + ' (wait ' + wait + ')');
  ok(c.timers.live() === 0, 'F. once its askings are spent no timer is left waiting', c.timers.live() + ' set');
}

async function partD() {
  // a mint that never answers, with a record of quick answers: the floor, five askings, then nothing
  const c = await connectedPage();
  const t = Date.now() - c.t0;
  c.delay = (m, path) => (path === '/v1/mint/quote/bolt11' ? 'hang' : 0);
  c.W.invoice(100, '').then(() => {}, () => {});
  await pause(26000);
  const at = since(quotes(c), t);
  ok(at.length === 5 && at[1] >= 4900 && at[1] < 6500 && at[4] >= 19900 && at[4] < 22000,
     'D. a mint that never answers is still asked again at the five-second floor, five askings in all', JSON.stringify(at));
  ok(c.timers.live() === 0, 'F. and after the fifth no timer is left', c.timers.live() + ' set');
}

async function partD2() {
  // a fee quote, which the confirmation screen gives twenty seconds: when it gives up, nothing of askedAgain is left
  const c = await connectedPage();
  const t = Date.now() - c.t0;
  c.delay = (m, path) => (path === '/v1/melt/quote/bolt11' ? 'hang' : 0);
  // quoteFee says a quote it could not get as null (the screen's FEE row shows UNKNOWN)
  const fee = await c.W.quoteFee(INVOICE).then((x) => ({ x }), (e) => ({ err: e.message }));
  const live = c.timers.live();
  const took = Date.now() - c.t0 - t;
  const at = since(meltQuotes(c), t);
  ok(fee.x === null && took >= 19900 && at.length === 4 && at[3] >= 14900,
     'D. a fee quote nobody answers is asked four times inside its twenty seconds, and is given up at twenty as it always was',
     JSON.stringify(fee) + ' after ' + took + ' ms, asked at ' + JSON.stringify(at));
  ok(live === 0, 'F. when the caller gives up, no ask-again timer is left', live + ' set');
}

async function partE() {
  // a proof check at a mint with quick answers: its second ask at six seconds, as always
  const quick = await connectedPage();
  setAside(quick, 'aa'.repeat(32));
  const t = Date.now() - quick.t0;
  quick.delay = (m, path, n) => (path === '/v1/checkstate' && n === 1 ? 'hang' : 0);
  await quick.W.unquarantine().then(() => {}, () => {});
  const at = since(checks(quick), t);
  ok(at.length === 2 && at[1] >= 5900 && at[1] < 7500, 'E. a proof check is asked again at its six-second floor at a quick mint', JSON.stringify(at));
  // at a slow one, no sooner than twenty
  const slow = await connectedPage();
  await slowRecord(slow, 12000);
  setAside(slow, 'bb'.repeat(32));
  const t2 = Date.now() - slow.t0;
  slow.delay = (m, path, n) => (path === '/v1/checkstate' && n === 1 ? 'hang' : 0);
  await slow.W.unquarantine().then(() => {}, () => {});
  const at2 = since(checks(slow), t2);
  ok(at2.length === 2 && at2[1] >= 19900 && at2[1] < 22000, 'E. and at a slow mint no sooner than twenty seconds', JSON.stringify(at2));
}

async function partF() {
  /* A caller with a short allowance (a lightning address's lookup, its
   * deadline here a second): no asking is planned at or past it, so no timer
   * is left when it gives up. Waits set outright, as the other suites do. */
  const c = page();
  c.W._reachMs = 1000;
  c.W._askAgainMs = 1200;
  c.delay = () => 'hang';
  const one = await c.W.lookupLnurl('alice@addr.test', 10).then(() => 'answered', (e) => e.message);
  const live = c.timers.live();
  const asked = c.asked.length;
  ok(/did not answer within/.test(one) && asked === 1 && live === 0,
     'F. a wait longer than the caller allows starts no timer at all: asked once, nothing left', one + ', ' + asked + ' asked, ' + live + ' set');
  const d = page();
  d.W._reachMs = 1000;
  d.W._askAgainMs = 300;
  d.delay = () => 'hang';
  const two = await d.W.lookupLnurl('alice@addr.test', 10).then(() => 'answered', (e) => e.message);
  const live2 = d.timers.live();
  ok(/did not answer within/.test(two) && d.asked.length === 3 && live2 === 0,
     'F. with room for two more, two more, and nothing left when the deadline comes', two + ', ' + d.asked.length + ' asked, ' + live2 + ' set');
  // the explicit test wait wins over a record
  const e = await connectedPage();
  await slowRecord(e, 3000);
  e.W._askAgainMs = 40;
  e.delay = (m, path, n) => (path === '/v1/mint/quote/bolt11' && n === 1 ? 'hang' : 0);
  const t = Date.now() - e.t0;
  await e.W.invoice(100, '');
  const at = since(quotes(e), t);
  ok(at.length === 2 && at[1] < 1000, 'F. FoxyWallet._askAgainMs, when set, wins over the record (for the tests)', JSON.stringify(at));
}

async function run() {
  const t = Date.now();
  // the quick parts one after another, the long ones side by side
  await partA();
  await partF();
  await Promise.all([partB(), partC12(), partC5(), partD(), partD2(), partE(), partG()]);
  const order = (l) => 'ABCDEFG'.indexOf(l.slice(6, 7));
  lines.sort((a, b) => order(a) - order(b)).forEach((l) => console.log(l));
  console.log('(' + Math.round((Date.now() - t) / 1000) + ' s)');
  console.log(failed ? '\n' + failed + ' ask-again-pace check(s) failed' : '\nall ask-again-pace checks pass');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
