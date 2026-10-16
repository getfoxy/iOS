'use strict';
/* stuck-invoice-rearm.js — an invoice paid while Foxy was away is claimed once
 * a route comes up.
 *
 *     node tests/stuck-invoice-rearm.js
 *
 * A return from the background runs the quote sweep at once, and Tor is often
 * a few seconds from up. The sweep said it was held and returned, and nothing
 * ran it again: a paid invoice sat at the mint, under a card saying
 * "retrying. Foxy is not connected to Tor.", until a mint switch happened to
 * connect the wallet. Now a held sweep is run by the route coming up, once.
 *
 * The wallet as it ships, at a fake mint behind a fake native side
 * (tests/harness.js), and the app's own return set-up and card methods lifted
 * from build/foxy-app.js onto the same page, wired as the boot wires them:
 *
 *   1. relaunched, the invoice paid while the gate was closed: the sweep is
 *      held, then the gate opens with no connect call and the claim lands;
 *   2. a return with the route already up claims within a second, and the
 *      card for a stuck invoice says "retrying" only with a route, and goes
 *      when its invoice lands; with none it says it waits for a connection;
 *   3. a connect and the route coming up in the same moment: the mint sees
 *      one claim; and a wallet built from storage is left to its connect;
 *   4. the hold is a mark, not a timer: going to the background leaves
 *      nothing running, and a re-armed sweep whose route goes again stops;
 *      a hold set by a walk that a route coming back only shared is run
 *      again when that walk ends.
 */
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const ROOT = path.join(__dirname, '..');
const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail && !good ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 60000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (await fn()) return true; await sleep(2); }
  return !!(await fn());
};
const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };

/* The route as the native side pushes it. */
const ROUTE = {
  up: { tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' },
  // Tor building a circuit again after a return: the gate is closed
  coming: { tor: 'connecting', progress: 40, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' },
  // put away, radios off
  dark: { tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct', network: 'none' },
};
const route = (c, name) => { c.route = ROUTE[name]; c.W._privacy(Object.assign({}, ROUTE[name])); };

/* The app's methods, as written in build/foxy-app.js. */
const appSrc = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
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

/* A page on one fake mint. `slow(path)` is how long the mint takes to answer
 * a request, in milliseconds. Every request to the mint is in `hits`, every
 * console line in `said`, every timer the page starts in `timers`. */
function page(o) {
  const opts = o || {};
  const phone = opts.phone || nativePhone({ words: PHONE_WORDS });
  const reply = (w, id, text, err, ms) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), ms || 0);
  let ctx = null;
  let mint = opts.mint || null;
  const timers = { seq: 0, live: new Map() };
  ctx = loadReal({
    storage: opts.storage,
    sweepPause: opts.sweepPause,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const p = new URL(m.url).pathname;
        ctx.hits.push(p);
        return reply(w, m.id, mint.handle(m), undefined, ctx.slow ? Number(ctx.slow(p)) || 0 : 0);
      }
      // the phone's own answer about the route, for a return's refreshPrivacy
      if (m.action === 'privacy') return reply(w, m.id, JSON.stringify(ctx.route));
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, Object.assign({ quotesUnpaid: true }, opts.mintOpts || {}));
      /* Every timer the page's own code starts, and whether it is still to
       * fire: the test of "every timer stops" (part 4). */
      const st = w.setTimeout.bind(w), ct = w.clearTimeout.bind(w);
      const si = w.setInterval.bind(w), ci = w.clearInterval.bind(w);
      w.setTimeout = function (fn, ms, ...rest) {
        const n = ++timers.seq;
        const id = st(function () { timers.live.delete(id); if (typeof fn === 'function') return fn.apply(this, arguments); }, ms, ...rest);
        timers.live.set(id, { n, ms: Number(ms) || 0, every: false });
        return id;
      };
      w.clearTimeout = (id) => { timers.live.delete(id); ct(id); };
      w.setInterval = function (fn, ms, ...rest) {
        const n = ++timers.seq;
        const id = si(fn, ms, ...rest);
        timers.live.set(id, { n, ms: Number(ms) || 0, every: true });
        return id;
      };
      w.clearInterval = (id) => { timers.live.delete(id); ci(id); };
    },
  });
  ctx.mint = mint;
  ctx.phone = phone;
  ctx.hits = [];
  ctx.timers = timers;
  ctx.route = ROUTE.up;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.said = [];
  const con = ctx.window.console;
  con.log = (...a) => { ctx.said.push(a.join(' ')); };
  con.warn = (...a) => { ctx.said.push('warn: ' + a.join(' ')); };
  // how many times anything connected the wallet
  ctx.connects = 0;
  const connect = ctx.W.connect;
  ctx.W.connect = function () { ctx.connects += 1; return connect.apply(this, arguments); };
  return ctx;
}
const claims = (c) => c.hits.filter((p) => p === '/v1/mint/bolt11').length;
const asks = (c, q) => c.hits.filter((p) => p === '/v1/mint/quote/bolt11/' + q).length;
const saidHeld = (c) => c.said.some((l) => /quote sweep held/.test(l));
const liveSince = (c, n) => [...c.timers.live.values()].filter((t) => t.n > n);

/* The app's return, its stuck-invoice card and its catch-up connect, on the
 * page's real wallet, wired as bootWallet wires them. The gate is a stand-in
 * that answers from the route the test set: home first, a return never waits
 * behind a screen (FoxyGate.check answers true at once). */
const LIFTED = ['blockedCard(kind, over) {', 'showStuckInvoice(hit) {', 'stuckRetryCard(hit) {', 'stuckInvoiceRoute() {',
  'stuckInvoiceLanded(claimed) {', 'setUpAfterReturn() {', 'connectForRealOnceOnline() {'];
function appOn(c) {
  const app = Object.assign(c.window.eval('(function () { return {' + LIFTED.map(method).join(',') + '}; })()'), {
    state: {}, setState() {}, BLOCKED_INFO: () => null, toast() {},
    group: (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    pinUnlocked: () => Promise.resolve(), listenWallet() {}, loadHistory() {}, offerQuarantine() {},
    resumeLoad: () => Promise.resolve(), refreshed: 0,
  });
  app.refreshBalance = () => { app.refreshed += 1; };
  c.window.FoxyGate = {
    connected: () => c.route === ROUTE.up, visible: () => false, uncover() {}, holdVerify() {},
    showLaunch() {}, launchStage() {}, check: () => Promise.resolve(true),
  };
  c.W.onPrivacy(() => { app.connectForRealOnceOnline(); app.stuckInvoiceRoute(); });
  c.W.onSwept((claimed) => { app.stuckInvoiceLanded(claimed); app.refreshBalance(); app.loadHistory(); });
  return app;
}
// what the cards on the page say (the page's scripts are on the body too)
const cardText = (c) => [...c.window.document.body.children].filter((el) => el.localName !== 'script').map((el) => el.textContent).join(' | ');

async function run() {
  /* ---- 0: the boot wires what the tests below wire by hand ------------- */
  {
    const boot = method('bootWallet() {');
    ok(/W\.onPrivacy\([^]*?this\.stuckInvoiceRoute\(\)/.test(boot) && /W\.onSwept\(/.test(boot),
       'the boot redraws the stuck-invoice card on a route change, and listens for what a sweep claimed');
  }

  /* ---- 1: relaunched, paid while the gate was closed, then the gate opens -- */
  {
    const phone = nativePhone({ words: PHONE_WORDS });
    const first = page({ phone });
    await first.W.connect(MINT, null, null, { remember: true });
    const inv = await first.W.invoice(2100, '');
    const q = inv.hash;

    // the app is killed and opened again: the same phone, the same mint, the storage it left
    phone.relaunch();
    const c = page({ phone, mint: first.mint, storage: dump(first) });
    await c.W.connect(MINT, null, null, { remember: true });
    await until(() => asks(c, q) >= 1);
    const start = await c.W.balanceSats();
    const connects0 = c.connects;
    ok(asks(c, q) === 1 && claims(c) === 0, 'relaunched: the connect asks about the invoice on file, still unpaid');

    // put away; the invoice is paid; back, with Tor still coming up
    route(c, 'coming');
    c.mint.payQuote(q);
    c.W._resumed(600);
    await sleep(40);
    ok(saidHeld(c), 'the return’s sweep is held: the gate is closed', c.said.slice(-3).join(' | '));
    ok(claims(c) === 0 && (await c.W.balanceSats()) === start, 'and nothing is claimed while it is closed');

    // the gate opens; nobody connects
    route(c, 'up');
    const landed = await until(async () => (await c.W.balanceSats()) === start + 2100, 3000);
    ok(landed, 'the gate opens with no connect call: the claim runs and the balance rises by the invoice',
       (await c.W.balanceSats()) + ' held, from ' + start);
    ok(c.connects === connects0 && claims(c) === 1, 'with no connect, and one claim at the mint',
       (c.connects - connects0) + ' connect(s), ' + claims(c) + ' claim(s)');
    ok(c.said.some((l) => /a route is up and the quote sweep was held/.test(l)), 'the log says the held sweep ran when the route came up');

    /* Further route pushes find nothing held: no sweep. Once per hold, not
     * once per push. An unpaid invoice is kept on file, so a sweep run by a
     * push would have something to ask the mint about. */
    await c.W.invoice(500, '');
    const asked = c.hits.length;
    const reran = c.said.filter((l) => /a route is up and the quote sweep was held/.test(l)).length;
    route(c, 'coming'); route(c, 'up'); route(c, 'up');
    await sleep(40);
    ok(c.hits.length === asked, 'a route coming up again with nothing held asks the mint nothing', (c.hits.length - asked) + ' request(s)');
    ok(c.said.filter((l) => /a route is up and the quote sweep was held/.test(l)).length === reran,
       'and runs no held sweep', c.said.slice(-3).join(' | '));
  }

  /* ---- 2: the app's return, and the card ---------------------------------- */
  {
    // the route already up at the return: the sweep runs at once, not after the card's fifteen seconds
    const c = page({});
    const app = appOn(c);
    await c.W.connect(MINT, null, null, { remember: true });
    const inv = await c.W.invoice(2100, '');
    const q = inv.hash;
    route(c, 'dark');
    c.mint.payQuote(q);
    /* What an older build wrote for a claim cut off by the trip away: the
     * reason is the phone's, and the record does not say the mint was never asked. */
    const list = JSON.parse(c.storage.getItem('foxy.cashu.quotes'));
    list.forEach((e) => { if (e.quote === q) e.unclaimed = { since: Date.now(), at: Date.now(), tries: 0, refused: 0, reason: 'Foxy is not connected to Tor.', badSignatures: false, gaveUp: '' }; });
    c.storage.setItem('foxy.cashu.quotes', JSON.stringify(list));
    const hit = c.W.stuckInvoices().find((h) => h.quote === q);
    ok(!!hit && hit.unclaimed.unsent === true, 'a record from before `unsent` is read as a try that never reached the mint', JSON.stringify(hit && hit.unclaimed));

    app.showStuckInvoice(hit);
    ok(/PAID, NOT COLLECTED YET/.test(cardText(c)) && /waiting for a connection/.test(cardText(c)) && !/retrying/.test(cardText(c)),
       'with no route the card says it is waiting for a connection, not retrying', cardText(c).slice(0, 160));

    const start = await c.W.balanceSats();
    route(c, 'up');
    ok(/retrying\./.test(cardText(c)) && !/waiting for a connection/.test(cardText(c)) && !/not connected to Tor/.test(cardText(c)),
       'the route comes up: the card says retrying, without the reason from when there was none', cardText(c).slice(0, 160));
    // nothing was held, so the route alone does not sweep: the return does
    await sleep(30);
    ok(claims(c) === 0, 'nothing was held, so nothing ran before the return');
    const began = Date.now();
    const back = app.setUpAfterReturn();
    const fast = await until(async () => (await c.W.balanceSats()) === start + 2100, 1000);
    ok(fast && Date.now() - began < 1000, 'a return with the route up claims within a second of the page being ready',
       (Date.now() - began) + ' ms, ' + claims(c) + ' claim(s)');
    await back;
    ok(claims(c) === 1, 'once', claims(c) + ' claim(s)');
    await sleep(20);
    ok(!/PAID, NOT COLLECTED/.test(cardText(c)), 'and the card goes when its invoice lands', cardText(c).slice(0, 120));
    ok(app.refreshed >= 1, 'the balance is drawn again');
  }
  {
    // the return the phone made: Tor not up yet, then up two seconds later
    const c = page({});
    const app = appOn(c);
    await c.W.connect(MINT, null, null, { remember: true });
    const inv = await c.W.invoice(2100, '');
    const q = inv.hash;
    route(c, 'dark');
    c.mint.payQuote(q);
    // a claim tried as Foxy came back, before Tor: it never left the phone
    const tried = await c.W.retryRefusedClaim(q).then(() => 'claimed', (e) => e && e.message);
    const hit = c.W.stuckInvoices().find((h) => h.quote === q);
    ok(!!hit && hit.unclaimed.unsent === true && hit.unclaimed.tries === 0,
       'a claim tried with no route is written down as never sent, and costs no try', tried + ' / ' + JSON.stringify(hit && hit.unclaimed));
    app.showStuckInvoice(hit);
    route(c, 'coming');
    const start = await c.W.balanceSats();
    const refreshed0 = app.refreshed;
    await app.setUpAfterReturn();
    await sleep(30);
    ok(saidHeld(c) && claims(c) === 0, 'the return’s sweep is held while Tor comes up');
    ok(/waiting for a connection/.test(cardText(c)) && !/retrying/.test(cardText(c)), 'and the card still says it is waiting for a connection', cardText(c).slice(0, 160));
    route(c, 'up');
    ok(/retrying\./.test(cardText(c)), 'Tor up: the card says retrying', cardText(c).slice(0, 160));
    const landed = await until(async () => (await c.W.balanceSats()) === start + 2100, 3000);
    ok(landed && claims(c) === 1 && c.connects === 1, 'and the held sweep claims it: no mint switch, no second connect',
       claims(c) + ' claim(s), ' + c.connects + ' connect(s)');
    await sleep(20);
    ok(app.refreshed > refreshed0 && !/PAID, NOT COLLECTED/.test(cardText(c)), 'the balance is drawn again and the card goes',
       'refreshed ' + (app.refreshed - refreshed0) + ', ' + cardText(c).slice(0, 80));
  }

  /* ---- 3: a connect and the route at once --------------------------------- */
  {
    const c = page({});
    await c.W.connect(MINT, null, null, { remember: true });
    const inv = await c.W.invoice(2100, '');
    const q = inv.hash;
    route(c, 'coming');
    c.mint.payQuote(q);
    await c.W.resumeSweeps();
    ok(saidHeld(c), 'held, with the gate closed');
    // the mint is slow about the invoice, so the first sweep is still out when the second is asked for
    c.slow = (p) => (p.indexOf('/v1/mint/quote/bolt11/') === 0 ? 80 : 0);
    const start = await c.W.balanceSats();
    const asks0 = asks(c, q);
    route(c, 'up');
    const connecting = c.W.connect(MINT, null, null, { remember: true });
    await connecting;
    const landed = await until(async () => (await c.W.balanceSats()) === start + 2100, 3000);
    await sleep(150);
    ok(landed && claims(c) === 1, 'a connect and the route coming up together: the mint sees one claim', claims(c) + ' claim(s)');
    ok(asks(c, q) - asks0 === 1, 'and is asked about the invoice once', (asks(c, q) - asks0) + ' question(s)');
    ok(c.said.some((l) => /quote sweep already running/.test(l)), 'the second sweep says it waits for the one running');
    ok((await c.W.balanceSats()) === start + 2100, 'nothing counted twice');
  }
  {
    // a wallet built from storage, the gate closed at launch: its sweep waits for the connect the route brings
    const phone = nativePhone({ words: PHONE_WORDS });
    const first = page({ phone });
    await first.W.connect(MINT, null, null, { remember: true });
    const inv = await first.W.invoice(2100, '');
    const q = inv.hash;
    first.mint.payQuote(q);
    phone.relaunch();
    const c = page({ phone, mint: first.mint, storage: dump(first) });
    appOn(c);
    route(c, 'coming');
    await c.W.connect(MINT, null, null, { fromCache: true });
    ok(c.W.fromCache(), 'relaunched with the gate closed: the wallet is built from storage');
    await c.W.resumeSweeps();
    ok(saidHeld(c) && claims(c) === 0, 'its sweep is held');
    const start = await c.W.balanceSats();
    route(c, 'up');
    const landed = await until(async () => (await c.W.balanceSats()) === start + 2100, 3000);
    await sleep(50);
    ok(landed && claims(c) === 1 && c.connects === 2, 'the route brings the connect for real, whose sweep claims it once',
       claims(c) + ' claim(s), ' + c.connects + ' connect(s)');
    ok(!c.said.some((l) => /a route is up and the quote sweep was held/.test(l)),
       'the held sweep is not run on the wallet from storage: its keysets may be old');
  }

  /* ---- 4: every timer stops ---------------------------------------------- */
  {
    const c = page({ sweepPause: [120, 120] });
    await c.W.connect(MINT, null, null, { remember: true });
    const inv = await c.W.invoice(2100, '');
    const q = inv.hash;
    await sleep(600);                       // the connect's own pauses, done
    route(c, 'coming');
    c.mint.payQuote(q);
    const mark = c.timers.seq;
    await c.W.sweepQuotes();
    ok(saidHeld(c) && liveSince(c, mark).length === 0, 'a held sweep leaves no timer behind: the route’s own push re-arms it',
       liveSince(c, mark).length + ' timer(s)');
    // put away: nothing runs, and nothing is asked, however long it is away
    route(c, 'dark');
    const asked = c.hits.length;
    await sleep(400);
    ok(c.hits.length === asked && liveSince(c, mark).length === 0, 'in the background with a held sweep: no timer running and nothing asked',
       liveSince(c, mark).length + ' timer(s), ' + (c.hits.length - asked) + ' request(s)');

    // the route comes up, and goes again during the re-armed sweep's pause
    const mark2 = c.timers.seq;
    route(c, 'up');
    await sleep(40);
    route(c, 'dark');
    await sleep(400);
    ok(claims(c) === 0 && asks(c, q) === 0 && liveSince(c, mark2).length === 0,
       'a re-armed sweep whose route goes again stops at its pause: nothing asked, no timer left',
       claims(c) + ' claim(s), ' + asks(c, q) + ' question(s), ' + liveSince(c, mark2).length + ' timer(s)');
    // and is held again, so the next route claims it
    const start = await c.W.balanceSats();
    route(c, 'up');
    const landed = await until(async () => (await c.W.balanceSats()) === start + 2100, 3000);
    ok(landed && claims(c) === 1, 'held again, and the next route claims it', claims(c) + ' claim(s)');
    await sleep(50);
    const left = liveSince(c, mark2).filter((t) => t.every);
    ok(left.length === 0, 'and no repeating timer is left running', left.length + ' interval(s)');
  }
  {
    /* The route comes back while a re-armed walk is still running. Its push
     * shares that walk, but the walk skipped the paid invoice at the pause
     * before it, to the route lost in between. The walk ending runs the hold
     * again: no further push is needed. */
    const c = page({ sweepPause: [300, 300] });
    await c.W.connect(MINT, null, null, { remember: true });
    await sleep(600);                       // the connect's own pauses, done
    const unpaid = (await c.W.invoice(500, '')).hash;
    const paid = (await c.W.invoice(2100, '')).hash;
    const order = JSON.parse(c.storage.getItem('foxy.cashu.quotes')).map((e) => e.quote);
    const first = order.indexOf(paid) < order.indexOf(unpaid) ? paid : unpaid;
    ok(first === paid, 'the paid invoice is the one the walk reaches first', order.join(', '));
    c.mint.payQuote(paid);
    route(c, 'coming');
    await c.W.sweepQuotes();
    ok(saidHeld(c), 'held, with the gate closed');
    const start = await c.W.balanceSats();
    const mark = c.timers.seq;
    route(c, 'up');                         // the hold re-arms: a walk starts, its first pause running
    await sleep(20);
    route(c, 'coming');                     // gone before that pause ends
    await sleep(400);
    ok(asks(c, paid) === 0 && claims(c) === 0, 'the walk skips the paid invoice at its pause: the route is gone',
       asks(c, paid) + ' question(s), ' + claims(c) + ' claim(s)');
    route(c, 'up');                         // back while the walk waits on its second pause
    await sleep(0);
    ok(c.said.some((l) => /quote sweep already running/.test(l)), 'the route coming back shares the walk still running');
    const landed = await until(async () => (await c.W.balanceSats()) === start + 2100, 3000);
    ok(landed && claims(c) === 1 && asks(c, paid) === 1, 'with no further push, the walk ending runs the hold again and the paid invoice is claimed once',
       asks(c, paid) + ' question(s), ' + claims(c) + ' claim(s), ' + (await c.W.balanceSats() - start) + ' landed');
    await until(() => asks(c, unpaid) >= 2, 1500);
    await sleep(50);
    const asked = c.hits.length;
    await sleep(700);
    ok(c.hits.length === asked, 'and then stops: nothing more is asked', (c.hits.length - asked) + ' request(s)');
    ok(liveSince(c, mark).filter((t) => t.every).length === 0 && liveSince(c, mark).filter((t) => t.ms > 0 && t.ms <= 300).length === 0,
       'no pause timer or repeating timer left running', liveSince(c, mark).map((t) => t.ms).join(','));
  }

  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall stuck-invoice re-arm checks pass');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
