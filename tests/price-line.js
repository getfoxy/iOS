'use strict';
/* price-line.js — the price line is kept, drawn before there is a route, and
 * turns into the fresh one when it arrives.
 *
 *     node tests/price-line.js
 *
 * The home screen opens before Tor is up, and the candles are fetched fresh
 * and refused without a route, so a launch drew the last price (kept on the
 * phone, with its age) and no line under it and no rider on it. Now:
 *
 *   - a fetch that succeeds is written down (`foxy.price.line`): every row,
 *     the granularity and span, when, and the price the phone had;
 *   - a launch or a return with no route draws that line, whatever its age,
 *     and the rider rides it; the warning that there is no line is for when
 *     nothing is kept;
 *   - the fresh line arriving over a line on screen replaces it over half a
 *     second, the points mixed by position and the rider carried by the line;
 *     a phone set to reduce motion has it at once.
 *
 * Part 1 is the wallet as it ships (Web/foxy-wallet.js) against a fake native
 * side. Part 2 is the real template and app class rendered in jsdom by
 * build/foxy-render.js, as render-snapshots.js renders them, with the clock and
 * the animation frames turned by hand and the page's path geometry answered
 * from the path text itself. */
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { load } = require('./harness');
const ROOT = path.join(__dirname, '..');

setTimeout(() => { console.log('WATCHDOG: a check never finished'); process.exit(2); }, 150000).unref();
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    const problem = await fn();
    if (problem) { failures.push(name); console.log('FAIL  ' + name + '\n      ' + problem); }
    else { passed++; console.log('ok    ' + name); }
  } catch (e) {
    failures.push(name);
    console.log('THREW ' + name + '\n      ' + (e && e.stack || e));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b, what) => (JSON.stringify(a) === JSON.stringify(b) ? null : what + ': ' + JSON.stringify(a) + ' against ' + JSON.stringify(b));

/* A day of five-minute rows, as the native side sends them: [time, close]. */
const dayOf = (from, f, n) => Array.from({ length: n || 288 }, (_, i) => [from + i * 300, Math.round(f(i) * 10) / 10]);
const KEPT_ROWS = dayOf(1700000000, (i) => 80000 + 900 * Math.sin(i / 20) + i * 5);
// three hours on: starts later, a row fewer, another shape
const FRESH_ROWS = dayOf(1700000000 + 36 * 300, (i) => 80500 + 1400 * Math.cos(i / 31) - i * 3, 287);
const asRows = (list) => list.map((r) => ({ t: r[0], c: r[1] }));

/* ======================================================================== */
/* Part 1 — the wallet keeps the line                                       */
/* ======================================================================== */

function walletAnswering(rows, over) {
  const opts = Object.assign({
    bridge: (w, m) => {
      if (m.action !== 'candles') return;
      setTimeout(() => {
        if (opts.error) w.FoxyWallet._scanResult(m.id, null, opts.error);
        else w.FoxyWallet._scanResult(m.id, JSON.stringify(opts.rows), null);
      }, 0);
    },
    rows,
  }, over || {});
  return Object.assign(load(opts), { opts });
}
const stored = (ctx) => JSON.parse(ctx.storage.getItem('foxy.price.line'));
const copyStorage = (ctx) => {
  const kept = {};
  for (let i = 0; i < ctx.storage.length; i++) kept[ctx.storage.key(i)] = ctx.storage.getItem(ctx.storage.key(i));
  return kept;
};

(async () => {
  await test('a fetch that succeeds is kept: every row, as it came', async () => {
    const ctx = walletAnswering(KEPT_ROWS);
    const before = Date.now();
    const got = await ctx.W.candles(300, 86400);
    if (got.length !== 288) return 'the caller was handed ' + got.length + ' rows';
    const rec = stored(ctx);
    if (!rec) return 'nothing was written under foxy.price.line';
    if (rec.rows.length !== 288) return 'kept ' + rec.rows.length + ' rows of 288';
    if (eq(rec.rows, KEPT_ROWS, 'the rows')) return eq(rec.rows, KEPT_ROWS, 'the rows').slice(0, 200);
    if (rec.g !== 300 || rec.span !== 86400) return 'kept for ' + rec.g + ' and ' + rec.span;
    if (!(rec.at >= before && rec.at <= Date.now())) return 'the time it was fetched: ' + rec.at;
    return null;
  });

  await test('what the caller is handed is what the native side sent, as before', async () => {
    const ctx = walletAnswering(KEPT_ROWS);
    const got = await ctx.W.candles(300, 86400);
    return eq(got, asRows(KEPT_ROWS), 'the rows handed back');
  });

  await test('the price the phone had goes with it, or none when it had none', async () => {
    const none = walletAnswering(KEPT_ROWS);
    await none.W.candles(300, 86400);
    if (stored(none).price !== null) return 'a price from nowhere: ' + stored(none).price;
    const some = walletAnswering(KEPT_ROWS);
    some.W._rate = 84746;
    some.W._rateAt = Date.now();
    await some.W.candles(300, 86400);
    return stored(some).price === 84746 ? null : 'kept price ' + stored(some).price;
  });

  await test('it reads back as the same rows, oldest first, for the range it was fetched for', async () => {
    const ctx = walletAnswering(KEPT_ROWS);
    await ctx.W.candles(300, 86400);
    const line = ctx.W.keptLine(300, 86400);
    if (!line) return 'nothing came back';
    if (eq(line.rows, asRows(KEPT_ROWS), 'the rows')) return 'the rows differ';
    if (line.g !== 300 || line.span !== 86400) return 'g and span: ' + line.g + ', ' + line.span;
    if (!(line.at > 0)) return 'no time';
    return null;
  });

  await test('another range has none: the kept line is not handed to a week or an hour', async () => {
    const ctx = walletAnswering(KEPT_ROWS);
    await ctx.W.candles(300, 86400);
    if (ctx.W.keptLine(3600, 7 * 86400) !== null) return 'a week was given the day';
    if (ctx.W.keptLine(60, 3600) !== null) return 'an hour was given the day';
    return null;
  });

  await test('it is there on the next launch, with no route and nothing asked of anyone', async () => {
    const first = walletAnswering(KEPT_ROWS);
    await first.W.candles(300, 86400);
    const next = load({ storage: copyStorage(first) });
    next.W._privacy({ tor: 'connecting', progress: 5, everUp: false });
    let refused = '';
    try { await next.W.candles(300, 86400); } catch (e) { refused = e.message; }
    if (!refused) return 'the fetch was not refused with no route';
    const line = next.W.keptLine(300, 86400);
    return line && line.rows.length === 288 ? null : 'the next launch has ' + (line ? line.rows.length : 'no') + ' rows';
  });

  await test('a refusal, or a fetch that fails, leaves the line that was kept as it was', async () => {
    const ctx = walletAnswering(KEPT_ROWS);
    await ctx.W.candles(300, 86400);
    const was = ctx.storage.getItem('foxy.price.line');
    ctx.opts.error = 'timed out';
    let failed = '';
    try { await ctx.W.candles(300, 86400); } catch (e) { failed = e.message; }
    if (!failed) return 'the failure was not passed on';
    if (ctx.storage.getItem('foxy.price.line') !== was) return 'a failed fetch changed the kept line';
    ctx.W._privacy({ tor: 'connecting', progress: 5, everUp: false });
    try { await ctx.W.candles(300, 86400); } catch (e) { failed = e.message; }
    return ctx.storage.getItem('foxy.price.line') === was ? null : 'a refused fetch changed the kept line';
  });

  await test('a newer line replaces it', async () => {
    const ctx = walletAnswering(KEPT_ROWS);
    await ctx.W.candles(300, 86400);
    ctx.opts.rows = FRESH_ROWS;
    await ctx.W.candles(300, 86400);
    const rec = stored(ctx);
    return rec.rows.length === 287 && rec.rows[0][0] === FRESH_ROWS[0][0] ? null : 'kept ' + rec.rows.length + ' rows from ' + rec.rows[0][0];
  });

  await test('rows that cannot be drawn are left out, and too few to draw keep nothing', async () => {
    const ctx = walletAnswering(KEPT_ROWS);
    await ctx.W.candles(300, 86400);
    const was = ctx.storage.getItem('foxy.price.line');
    ctx.opts.rows = [[1700000000, 80000], [1700000300, 0], [1700000600, 'x'], [1700000900, 80100], [null, 80200], [1700001500, -5]];
    await ctx.W.candles(300, 86400);
    if (ctx.storage.getItem('foxy.price.line') !== was) return 'two usable rows replaced a whole line';
    ctx.opts.rows = [[1700000000, 80000], [1700000300, 80010], [1700000600, 80020], [1700000900, 80030], [1700001200, 'x']];
    await ctx.W.candles(300, 86400);
    const rec = stored(ctx);
    return rec.rows.length === 4 ? null : 'the four good rows were kept as ' + rec.rows.length;
  });

  await test('rows that arrive out of order are kept oldest first', async () => {
    const ctx = walletAnswering(KEPT_ROWS.slice().reverse());
    await ctx.W.candles(300, 86400);
    const rec = stored(ctx);
    return rec.rows.every((r, i) => i === 0 || rec.rows[i - 1][0] <= r[0]) ? null : 'not in time order';
  });

  await test('more rows than the source ever sends are not kept, and not cut down to fit', async () => {
    const ctx = walletAnswering(dayOf(1700000000, (i) => 80000 + i, 1001));
    await ctx.W.candles(300, 86400);
    return ctx.storage.getItem('foxy.price.line') === null ? null : 'a thousand and one rows were kept';
  });

  await test('what is on the disk is read with care: nothing that does not read as a line is drawn', async () => {
    const good = JSON.stringify({ g: 300, span: 86400, at: Date.now(), price: 84000, rows: KEPT_ROWS });
    const bad = {
      'not JSON': '{',
      'not an object': '"a line"',
      'no rows': JSON.stringify({ g: 300, span: 86400, at: Date.now(), rows: 5 }),
      'no time': JSON.stringify({ g: 300, span: 86400, rows: KEPT_ROWS }),
      'a row with no price': JSON.stringify({ g: 300, span: 86400, at: Date.now(), rows: KEPT_ROWS.slice(0, 5).concat([[1700009999, 0]]) }),
      'a row that is not a pair': JSON.stringify({ g: 300, span: 86400, at: Date.now(), rows: KEPT_ROWS.slice(0, 5).concat(['x']) }),
      'rows out of order': JSON.stringify({ g: 300, span: 86400, at: Date.now(), rows: KEPT_ROWS.slice(0, 6).reverse() }),
      'three rows': JSON.stringify({ g: 300, span: 86400, at: Date.now(), rows: KEPT_ROWS.slice(0, 3) }),
    };
    if (!load({ storage: { 'foxy.price.line': good } }).W.keptLine(300, 86400)) return 'a good line was refused';
    for (const k of Object.keys(bad)) {
      const got = load({ storage: { 'foxy.price.line': bad[k] } }).W.keptLine(300, 86400);
      if (got !== null) return k + ' was drawn';
    }
    return null;
  });

  await test('a price outside what the wallet believes is not handed back with the line', async () => {
    const odd = JSON.stringify({ g: 300, span: 86400, at: Date.now(), price: 12, rows: KEPT_ROWS });
    const line = load({ storage: { 'foxy.price.line': odd } }).W.keptLine(300, 86400);
    return line && line.price === null ? null : 'the price handed back was ' + (line && line.price);
  });

  await test('a wipe removes it with the rest', async () => {
    const ctx = walletAnswering(KEPT_ROWS);
    await ctx.W.candles(300, 86400);
    if (ctx.storage.getItem('foxy.price.line') === null) return 'nothing to wipe';
    await ctx.W.wipeDevice();
    if (ctx.storage.getItem('foxy.price.line') !== null) return 'the line is still there after a wipe';
    return ctx.W.keptLine(300, 86400) === null ? null : 'and it is still handed out';
  });

  await test('the key is in STORAGE.md, with what it holds and what a wipe does', async () => {
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'STORAGE.md'), 'utf8');
    const row = md.split('\n').find((l) => l.indexOf('| `foxy.price.line`') === 0);
    if (!row) return 'no row for foxy.price.line';
    if (!/public|market/i.test(row)) return 'the row does not say it is public market data';
    return /price line/.test(md.slice(md.indexOf('## What a wipe removes'))) ? null : 'the wipe section does not name it';
  });

  /* ====================================================================== */
  /* Part 2 — the app draws it, and turns it into the fresh one              */
  /* ====================================================================== */

  const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
  const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
  const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
  const RENDERER = fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8');
  const unpack = (uuid) => fs.readFileSync(path.join(ROOT, assets.find((a) => a.uuid === uuid).file), 'utf8');
  const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
    const props = JSON.parse(v.replace(/&quot;/g, '"'));
    props.startStatic = { default: true };
    return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
  });
  const page = markup
    .replace(/<script src="64b433ba-[^"]*"><\/script>/, '')
    .replace(shell.marker, () => open + app + '</script>');

  /* The page's path geometry, answered from the path text: jsdom draws nothing.
   * The lines this app writes are M, C, L and Z, which is all this reads. */
  function flatten(d) {
    const toks = String(d).match(/[MCLZ]|-?[0-9.]+/g) || [];
    const pts = [];
    let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = '';
    const num = () => Number(toks[i++]);
    while (i < toks.length) {
      if (/[MCLZ]/.test(toks[i])) cmd = toks[i++];
      if (cmd === 'M') { cx = num(); cy = num(); sx = cx; sy = cy; pts.push([cx, cy]); cmd = 'L'; }
      else if (cmd === 'L') { cx = num(); cy = num(); pts.push([cx, cy]); }
      else if (cmd === 'C') {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        for (let k = 1; k <= 16; k++) {
          const t = k / 16, u = 1 - t;
          pts.push([u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
            u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y]);
        }
        cx = x; cy = y;
      } else if (cmd === 'Z') pts.push([sx, sy]);
      else break;
    }
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    return { pts, cum, total: cum[cum.length - 1] || 0 };
  }

  const vc = new VirtualConsole();
  const pageErrors = [];
  vc.on('jsdomError', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 200)));
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://foxy.test/index.html', virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.scrollTo = () => {};
  const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
  run(unpack('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047'));
  run(unpack('93c76fbd-259d-463c-a60d-5ed97ad7e690'));
  const dc = w.document.querySelector('script[type="text/x-dc"]');
  run('window.__foxyComponentFactory = function (DCLogic, StreamableLogic, React) {\n' + dc.textContent
    + '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};');
  run('(function(){var f=window.__foxyComponentFactory;window.__foxyComponentFactory=function(a,b,R){'
    + 'var C=f(a,b,R);return class extends C{constructor(p){super(p);window.__logic=this;}};};})();');
  run(RENDERER);
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(500);
  const logic = w.__logic;
  if (!logic) {
    console.log('FAIL  the app did not mount\n      ' + pageErrors.join(' | '));
    process.exit(1);
  }
  // what a launch does when the page is not a static frame; the mount above was one
  logic.props.startStatic = false;

  // the geometry of the page, from the text of the paths in it
  w.Element.prototype.getTotalLength = function () { return flatten(this.getAttribute('d')).total; };
  w.Element.prototype.getPointAtLength = function (s) {
    const f = flatten(this.getAttribute('d'));
    let k = 1;
    while (k < f.cum.length - 1 && f.cum[k] < s) k++;
    const r = (s - f.cum[k - 1]) / ((f.cum[k] - f.cum[k - 1]) || 1);
    return { x: f.pts[k - 1][0] + (f.pts[k][0] - f.pts[k - 1][0]) * r, y: f.pts[k - 1][1] + (f.pts[k][1] - f.pts[k - 1][1]) * r };
  };
  w.Element.prototype.getBoundingClientRect = function () {
    return { width: 390, height: 160, left: 0, top: 0, right: 390, bottom: 160, x: 0, y: 0 };
  };

  // the clock and the animation frames, turned by hand
  const clock = { now: 1000 };
  let queue = [];
  let frameId = 0;
  w.requestAnimationFrame = (fn) => { queue.push({ id: ++frameId, fn }); return frameId; };
  w.cancelAnimationFrame = (id) => { queue = queue.filter((q) => q.id !== id); };
  w.performance.now = () => clock.now;
  /* One frame, `ms` after the last, every callback that was waiting for one. */
  const frame = (ms) => {
    clock.now += ms;
    const due = queue;
    queue = [];
    due.forEach((q) => q.fn(clock.now));
  };

  // what the page says to its console, so a warning can be looked for
  const said = [];
  w.console.warn = (...a) => said.push(a.map(String).join(' '));
  const warnedNoLine = () => said.filter((l) => /price line for 1D not loaded/.test(l));

  /* Waiting is for a thing to be true, not for a time to pass: this machine is
   * sometimes busy with other work, and a page that takes a second where it took
   * a tenth is not a failure. */
  const until = async (cond, what, ms) => {
    const end = Date.now() + (ms || 5000);
    while (!cond()) {
      if (Date.now() > end) throw new Error('waited for ' + what + ' and it never came');
      await wait(5);
    }
  };
  // the screen drawn again from the state as it is now
  const drawn = async () => {
    await until(() => logic.__host && logic.__host.renderedState === logic.state, 'the screen to be drawn from the state');
    await wait(0);
  };

  // the wallet the app talks to
  let asked = 0;
  const UP = { tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false,
    network: 'wifi', orbot: 'none', vpn: false, orbotKey: false };
  const wallet = (over) => {
    const calls = [];
    const W = Object.assign({
      calls,
      connected: true,
      mintUrl: 'https://mint.minibits.cash/Bitcoin',
      defaultMint: 'https://mint.minibits.cash/Bitcoin',
      mintHost: () => 'mint.minibits.cash/Bitcoin',
      mints: () => [],
      qr: () => 'data:image/svg+xml;stub',
      amountOf: () => null,
      classify: () => 'unknown',
      auditTrail: () => [],
      lastToken: () => null,
      tagsFor: () => ({}),
      balances: () => [{ unit: 'sat', amount: 5000, mint: 'https://mint.minibits.cash/Bitcoin' }],
      mintDown: () => null,
      quarantinedSats: () => 0,
      quarantinedUnknown: () => 0,
      tokensNotClaimed: () => Promise.resolve([]),
      transactions: () => Promise.resolve([]),
      balanceSats: () => Promise.resolve(5000),
      pinIsSet: () => false,
      formatAmount: (x, u) => x + ' ' + u,
      unitName: (u) => String(u).toUpperCase(),
      quoteFee: () => new Promise(() => {}),
      agreedRate: () => new Promise(() => {}),
      backedUp: () => false,
      reason: (e) => String((e && e.message) || e),
      proofLockDepth: () => 0,
      // working offline with a connection on its way: the first seconds of a launch
      privacy: () => ({ tor: 'connecting', progress: 10, everUp: true, unprotected: false, offline: true,
        network: 'wifi', orbot: 'none', vpn: false, orbotKey: false }),
      keptLine: (g, span) => (over && over.kept && over.kept(g, span)) || null,
    }, over || {});
    // every ask is counted, whatever answers it; a wallet with no route refuses
    const answer = (over && over.candles) || (() => Promise.reject(new Error('Foxy is securing its connection. Try again in a moment.')));
    W.candles = (g, span) => { asked++; return answer(g, span); };
    return new Proxy(W, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? (...args) => { calls.push([k, ...args]); } : undefined)) });
  };
  const KEPT = { g: 300, span: 86400, at: Date.now() - 3 * 3600 * 1000, price: 84746, rows: asRows(KEPT_ROWS) };
  const keptWallet = (over) => wallet(Object.assign({ kept: () => KEPT }, over || {}));

  const doc = w.document;
  const pathsOf = () => {
    const svg = doc.querySelector('[data-rider="streaks"]').parentElement.querySelector('svg');
    const all = [...svg.querySelectorAll('path')];
    return { fill: all[0], line: all[1] };
  };
  const markerEl = () => doc.querySelector('[data-rider="body"]').parentElement;
  const LIVE = { walletLive: true, balSats: 250000, balUsd: 0, livePrice: 84746, screen: 'home', stack: [], range: '1D' };
  /* Every view starts from the home screen with no line, nobody riding and nothing in flight. */
  async function fresh(W, state) {
    if (logic._morph) logic.chartMorphEnd();
    clearTimeout(logic._seriesT);
    logic._loading = {};
    logic._seriesTries = 0;
    queue = [];
    logic.markerGone();
    w.FoxyGate = undefined;
    w.FoxyWallet = W;
    said.length = 0;
    asked = 0;
    logic.setState(Object.assign({ series: undefined, toastMsg: '' }, LIVE, state || {}));
    await drawn();
    await until(() => !!doc.querySelector('[data-rider="body"]'), 'the home screen');
    queue = [];
    logic._rolled = false;
  }
  const lineD = () => pathsOf().line.getAttribute('d');
  const fillD = () => pathsOf().fill.getAttribute('d');
  // the kept line, up on the page
  const keptUp = async () => {
    logic.showKeptLine();
    await until(() => logic.state.series && logic.state.series['1D'] && lineD() === logic.state.series['1D'].d, 'the kept line on the page');
  };
  // the fresh line asked for, and its change of line begun
  const turning = async () => {
    logic.loadSeries('1D');
    await until(() => !!logic._morph, 'the change of line to begin');
  };
  // the candles asked for and refused, or answered
  const settled = () => until(() => asked >= 1 && !logic._loading['1D'], 'the candles to be refused');
  const frames = (n) => { for (let k = 0; k < n; k++) frame(16); };

  /* ---- 2a. a launch with no route and a kept line ----------------------- */

  await test('the launch calls the kept line up before it asks for a new one', async () => {
    const mount = app.slice(app.indexOf('  componentDidMount() {'), app.indexOf('  componentWillUnmount() {'));
    const at = mount.indexOf('this.showKeptLine()');
    if (at < 0) return 'componentDidMount never draws the kept line';
    return at < mount.indexOf('this.loadSeries(') ? null : 'the line is asked for before the kept one is drawn';
  });

  await test('no route and a kept line: the line is drawn, whatever its age, and the rider has a track', async () => {
    await fresh(keptWallet());
    if (lineD()) return 'a line was on the page before anything was kept or asked';
    await keptUp();
    const chart = logic.state.series['1D'];
    if (!chart.kept) return 'the kept line is not marked as kept';
    if (fillD() !== chart.d + ' L462 92 L-60 92 Z') return 'the wash under the line is not the line closed down';
    const rows = logic.chartRows(KEPT.rows);
    if (chart.t !== logic.buildChart(rows, 'last 24 hours').t) return 'the label under the price is not read off the kept rows';
    // the rider is out on it: the ride began as the line landed
    await until(() => logic._riding, 'the rider to ride the kept line');
    if (markerEl().style.visibility !== 'visible') return 'the rider is not in view';
    return logic.riderTrack(markerEl()) ? null : 'the rider has no track';
  });

  await test('with a route refused, a kept line draws no warning, and stays', async () => {
    await fresh(keptWallet());
    await keptUp();
    logic.loadSeries('1D');
    await settled();
    if (asked !== 1) return 'the candles were asked for ' + asked + ' times';
    if (warnedNoLine().length) return 'the warning was logged: ' + warnedNoLine()[0];
    const chart = logic.state.series['1D'];
    if (!chart || !chart.kept) return 'the kept line did not stay up';
    return logic.seriesFresh('1D') ? 'a kept line counted as a fresh one' : null;
  });

  await test('and it is asked again later, kept line or not', async () => {
    await fresh(keptWallet());
    await keptUp();
    logic.loadSeries('1D');
    await settled();
    // the retry is a timer: when it fires it asks again
    if (!logic._seriesT) return 'no retry is waiting';
    clearTimeout(logic._seriesT);
    logic.offlineNow = () => false;
    const before = asked;
    logic.loadSeries('1D');
    delete logic.offlineNow;
    await until(() => asked === before + 1, 'the kept line not to stop it being asked again');
    return null;
  });

  await test('a route coming up asks for the fresh line over a kept one, and not over a fresh one', async () => {
    await fresh(keptWallet({ privacy: () => UP }));
    await keptUp();
    logic.sayBackOnline();
    await settled();
    if (asked !== 1) return 'a route with a kept line shown asked ' + asked + ' times';
    await fresh(keptWallet({ privacy: () => UP }), { series: { '1D': logic.buildChart(logic.chartRows(KEPT.rows), 'last 24 hours') } });
    logic.sayBackOnline();
    await wait(30);
    return asked === 0 ? null : 'a fresh line on screen was asked for again (' + asked + ')';
  });

  /* ---- 2b. no route and nothing kept ------------------------------------ */

  await test('no route and nothing kept: the warning is logged as ever, and there is no line', async () => {
    await fresh(wallet());
    logic.showKeptLine();
    logic.loadSeries('1D');
    await settled();
    if (warnedNoLine().length !== 1) return 'the warning was logged ' + warnedNoLine().length + ' times';
    if (!/securing its connection/.test(warnedNoLine()[0])) return 'the warning says ' + warnedNoLine()[0];
    if (logic.state.series && logic.state.series['1D']) return 'a line was drawn from nothing';
    if (lineD()) return 'the page has a line';
    return logic._riding ? 'a rider is out on nothing' : null;
  });

  await test('a kept line that does not read as a line is no line', async () => {
    const odd = { g: 300, span: 86400, at: Date.now(), price: null, rows: [{ t: 1, c: 80000 }, { t: 2, c: 80100 }, { t: 3, c: 80200 }] };
    await fresh(wallet({ kept: () => odd }));
    logic.showKeptLine();
    logic.loadSeries('1D');
    await settled();
    if (logic.state.series && logic.state.series['1D']) return 'three rows were drawn as a line';
    return warnedNoLine().length === 1 ? null : 'and it did not say there was no line';
  });

  /* ---- 2c. the fresh line arrives over the kept one ---------------------- */

  const freshWallet = () => keptWallet({ candles: () => Promise.resolve(asRows(FRESH_ROWS)) });
  const freshChart = () => logic.buildChart(logic.chartRows(asRows(FRESH_ROWS)), 'last 24 hours');
  const ease = (u) => u * u * (3 - 2 * u);

  await test('the fresh line turns the kept one into itself, a frame at a time, and ends exactly on its points', async () => {
    await fresh(freshWallet());
    await keptUp();
    const kept = logic.state.series['1D'];
    const want = freshChart();
    await turning();
    if (lineD() !== kept.d) return 'the first thing drawn is not the line already there';
    const seen = [];
    for (let n = 1; n <= 40 && logic._morph; n++) {
      frame(16);
      seen.push(lineD());
    }
    if (logic._morph) return 'still turning after forty frames';
    if (seen.length < 25 || seen.length > 36) return 'it took ' + seen.length + ' frames, for half a second';
    if (seen[seen.length - 1] !== want.d) return 'the last frame is not the fresh line, to the digit';
    if (new Set(seen).size < seen.length - 3) return 'the line drew the same shape over and over: ' + new Set(seen).size + ' shapes in ' + seen.length + ' frames';
    // a frame in the middle is the mix of the two, by position
    const midFrame = 15;
    const u = (midFrame * 16) / logic.CHART_MORPH_MS;
    const expected = logic.chartBetween(kept, want, ease(u)).d;
    if (seen[midFrame - 1] !== expected) return 'frame ' + midFrame + ' is not the mix of the two at ' + u.toFixed(2) + ':\n      ' + seen[midFrame - 1].slice(0, 90) + '\n      ' + expected.slice(0, 90);
    await drawn();
    const chart = logic.state.series['1D'];
    if (chart.kept) return 'the line in the state is still marked as kept';
    if (!logic.seriesFresh('1D')) return 'the line in the state is not a fresh one';
    if (chart.d !== want.d) return 'the state does not hold the fresh line';
    if (lineD() !== want.d) return 'the page ends on ' + lineD().slice(0, 60) + ' and not on the fresh points';
    if (fillD() !== want.d + ' L462 92 L-60 92 Z') return 'the wash does not end on the fresh line';
    return null;
  });

  await test('the screen drawn again in the middle of it does not undo a frame', async () => {
    await fresh(freshWallet());
    await keptUp();
    await turning();
    frames(10);
    const mid = lineD();
    if (mid === logic.state.series['1D'].d) return 'ten frames in, the line has not moved';
    logic.setState({ toastMsg: 'something else changed' });
    await drawn();
    const after = lineD();
    logic.setState({ toastMsg: '' });
    return after === mid ? null : 'a redraw of the screen wrote the old line over the frame';
  });

  await test('the rider is carried by the line: no jump on any frame, and no jump when it ends', async () => {
    await fresh(freshWallet());
    await keptUp();
    await until(() => logic._riding, 'the rider to ride');
    // well onto the line before the fresh one lands
    frames(130);
    if (!logic._riding) return 'the ride was over before the line changed';
    const el = markerEl();
    const at = () => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    let last = at();
    await turning();
    let far = 0;
    for (let n = 0; n < 32 && logic._morph; n++) {
      frame(16);
      const p = at();
      far = Math.max(far, Math.hypot(p.x - last.x, p.y - last.y));
      last = p;
    }
    if (far > 14) return 'a frame moved him ' + far.toFixed(1) + 'px';
    await drawn();
    // the renderer wrote the new line's resting height; the ride's place is back before anything was drawn
    if (!/px$/.test(el.style.top)) return 'after the change of line his place was ' + el.style.top;
    if (el.style.top !== logic._rideAt.top) return 'his place is ' + el.style.top + ', the ride has him at ' + logic._rideAt.top;
    // and the ride goes on, to its end
    let ended = false;
    for (let n = 0; n < 700 && !ended; n++) { frame(16); ended = !logic._riding; }
    return ended && el.style.visibility === 'hidden' ? null : 'the ride did not finish';
  });

  await test('he goes forward along the line the whole way through, and the line changing adds no step of its own', async () => {
    await fresh(freshWallet());
    await keptUp();
    await until(() => logic._riding, 'the rider to ride');
    frames(130);
    const el = markerEl();
    // how far along the line he is, as a fraction of it, read off the line as the page has it at that frame
    const standing = (p) => {
      const track = logic.riderTrack(el);
      let best = Infinity, along = 0;
      for (let i = 1; i < track.pts.length; i++) {
        const a = track.pts[i - 1], b = track.pts[i];
        const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        const d = Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
        if (d < best) { best = d; along = a.s + (b.s - a.s) * u; }
      }
      return { at: along / track.total, off: best };
    };
    const at = () => standing({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    const walk = [at().at];
    let off = 0;
    await turning();
    for (let n = 0; n < 40 && logic._morph; n++) {
      frame(16);
      const s = at();
      walk.push(s.at);
      off = Math.max(off, s.off);
    }
    if (off > 1.5) return 'he was ' + off.toFixed(1) + 'px off the line on some frame';
    const steps = walk.slice(1).map((f, i) => f - walk[i]);
    if (steps.some((d) => d < -0.002)) return 'he went back along the line: ' + steps.map((d) => d.toFixed(4)).join(' ');
    // a frame of the ride is a fraction of a percent of the line; the change of line must not add a step of its own
    return Math.max.apply(null, steps) < 0.02 ? null : 'a frame took him ' + (Math.max.apply(null, steps) * 100).toFixed(1) + '% of the line';
  });

  await test('reduced motion: the fresh line replaces the kept one at once, with no change of line', async () => {
    await fresh(freshWallet());
    await keptUp();
    const want = freshChart();
    w.matchMedia = (q) => ({ matches: /reduce/.test(q), addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    try {
      logic.loadSeries('1D');
      await until(() => logic.state.series['1D'].d === want.d, 'the fresh line to replace the kept one');
      if (logic._morph) return 'a change of line began under reduced motion';
      await drawn();
      if (lineD() !== want.d) return 'the page does not show the fresh line';
      return logic.state.series['1D'].kept ? 'the line is still marked as kept' : null;
    } finally {
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    }
  });

  await test('another screen is up: the fresh line is the state’s at once, with nothing to draw on', async () => {
    await fresh(freshWallet());
    await keptUp();
    logic.setState({ screen: 'amount', stack: ['home'] });
    await drawn();
    logic.loadSeries('1D');
    await until(() => logic.state.series['1D'].d === freshChart().d, 'the fresh line to be the state’s');
    if (logic._morph) return 'a change of line began with the chart off the page';
    return logic.state.series['1D'].kept ? 'the line is still marked as kept' : null;
  });

  await test('the launch screen still over the page: the same, at once', async () => {
    await fresh(freshWallet());
    await keptUp();
    w.FoxyGate = { visible: () => true };
    logic.loadSeries('1D');
    await until(() => logic.state.series['1D'].d === freshChart().d, 'the fresh line to be the state’s');
    return logic._morph ? 'a change of line began behind the cover' : null;
  });

  await test('leaving the home screen in the middle of it settles on the fresh line', async () => {
    await fresh(freshWallet());
    await keptUp();
    await turning();
    frames(8);
    logic.setState({ screen: 'amount', stack: ['home'] });
    await drawn();
    frame(16);
    await until(() => !logic._morph, 'the change of line to end');
    const chart = logic.state.series['1D'];
    return chart.d === freshChart().d && !chart.kept ? null : 'the state was left on the old line';
  });

  await test('a line that arrives with none on screen is simply put up', async () => {
    await fresh(freshWallet());
    logic.loadSeries('1D');
    await until(() => logic.state.series && logic.state.series['1D'] && lineD() === logic.state.series['1D'].d, 'the line on the page');
    if (logic._morph) return 'a change of line began from nothing';
    const chart = logic.state.series['1D'];
    if (chart.kept) return 'the fresh line is marked as kept';
    return warnedNoLine().length ? 'it warned of a line it had just drawn' : null;
  });

  await test('the fetch that fails over a kept line keeps it, and a later one still turns it into the fresh line', async () => {
    let n = 0;
    await fresh(keptWallet({ candles: () => (++n === 1 ? Promise.reject(new Error('timed out')) : Promise.resolve(asRows(FRESH_ROWS))) }));
    await keptUp();
    logic.loadSeries('1D');
    await settled();
    if (!logic.state.series['1D'].kept) return 'the kept line went when the fetch failed';
    if (warnedNoLine().length) return 'it warned with a line on screen';
    clearTimeout(logic._seriesT);
    await turning();
    for (let k = 0; k < 60 && logic._morph; k++) frame(16);
    await drawn();
    return logic.state.series['1D'].d === freshChart().d ? null : 'the state does not hold the fresh line';
  });

  await test('the page raised nothing while doing it', async () => {
    return pageErrors.length ? pageErrors.join(' | ') : null;
  });

  console.log('');
  if (failures.length) { console.log(failures.length + ' price line check(s) failed of ' + (passed + failures.length)); process.exit(1); }
  console.log('all ' + passed + ' price line checks pass');
  process.exit(0);
})();
