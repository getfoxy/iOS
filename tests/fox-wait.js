'use strict';
/* fox-wait.js — the fox (build/app/26r-fox-wait.js): the wait while a fee is checked or money moves.
 *
 *     node tests/fox-wait.js
 *
 * The keeper, 2026-11-06: shown at any time a fee is being checked or pieces are being moved, the percentage
 * intelligent and the fox's motion timed to it; the video played frame by frame along with the progress, so when the
 * progress slows the fox slows.
 *
 *   1  the figure each flow's steps head for, from one table: a fee 0 → 60 and 100 at the answer; a move 25, 45, 75,
 *      95 and 100 at the end; the wallet's own stage names read as those steps; a step a flow lacks moves nothing
 *   2  the easing: never back, no frame more than a few points, 100 only at the real end, a long gap between frames
 *      counted as a short one; and a slow step slows the figure without stopping it, never reaching the next step's
 *   3  where the fox is in the video: figure / 100 × duration × 0.92, and the length assumed before it is read
 *   4  the screen: black, CHECKING THE FEE or MOVING YOUR MONEY on one line, the figure, the fox; CANCEL only where the
 *      wait can be cancelled, and it cancels; ALL SET at 100, down FOX_HOLD_MS later; its time limit; `hideStage` and
 *      `stageUp` by its kind; never over another stage screen, but in place of another fox
 *   5  the video: never played, looped or autoplayed, put on the figure's frame each frame it moves, standing at ALL
 *      SET; the fox asleep before it loads; paused in the background and let go of when the screen comes down; Reduce
 *      Motion puts it on the shown figure's frame every tenth point only
 *   6  every wait the job names, driven end to end with the fox up: ALL SET only where the money landed or the fee
 *      came, down at once otherwise, its CANCEL and its time limit as before — a crossing's CALCULATING FEE, the other
 *      phone's fee, Getting their invoice, a transfer, a swap (each outcome), PAY FROM's swap and its asking, a token
 *      from another mint and its change, WITHDRAW TO's crossing, a tap's crossing, and a payment brought home or sent
 *      back
 *   7  the files it needs ship
 *
 * The methods are lifted out of build/foxy-app.js and run in jsdom. Run `python3 tools/pack-index.py` first.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');

let passed = 0, failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const later = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

// a method of the app by its name, as `name(args) { ... }`
function byName(name) {
  const re = new RegExp('\\n  (?:async )?' + name + '\\([^)]*\\) \\{');
  const m = re.exec(app);
  if (!m) throw new Error('missing ' + name);
  const at = m.index + 1;
  let i = app.indexOf('{', at + name.length), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) break; }
  }
  return app.slice(at + 2, i + 1);
}
const lift = (names) => new Function('return {' + names.map(byName).join(',\n') + '}')();
// a class field's value (`NAME = ...;`), up to the line that ends it
function field(name) {
  const at = app.indexOf('\n  ' + name + ' = ');
  if (at < 0) throw new Error('missing field ' + name);
  const from = at + 3 + name.length + 3;
  let i = from, depth = 0;
  for (; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) break;
  }
  return new Function('return (' + app.slice(from, i) + ');')();
}

let FOX = null;
try {
  FOX = lift(['foxStepName', 'foxTarget', 'foxCreep', 'foxEase', 'foxFigure', 'foxScrub', 'foxUp', 'foxFit', 'foxStage',
    'foxFollow', 'foxRelease', 'foxOn', 'foxStep', 'foxHears', 'foxDone', 'foxEnd', 'stageScreen', 'hideStage', 'stageUp']);
  for (const f of ['FOX_FLOWS', 'FOX_VIDEO', 'FOX_POSTER', 'FOX_VIDEO_S', 'FOX_SHARE', 'FOX_HOLD_MS']) FOX[f] = field(f);
} catch (e) {
  ok(false, 'the fox is in the app (26r-fox-wait.js)', String(e && e.message));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}

/* A page, and a frame clock the test turns. `o.reduce`: Reduce Motion. The app object answers any method it was not
 * given (and no field: `_name` or `NAME`) with one that does nothing, so a flow's own method can be run with only what matters to it stood in. */
function page(o) {
  const opt = o || {};
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://foxy.test/index.html' });
  const w = dom.window;
  global.window = w;
  global.document = w.document;
  const frames = [];
  global.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  global.cancelAnimationFrame = () => {};
  w.matchMedia = (q) => ({ matches: !!opt.reduce && /reduced-motion/.test(q) });
  const media = { plays: 0, pauses: 0, seeks: [], loads: 0 };
  const P = w.HTMLMediaElement.prototype;
  P.canPlayType = () => 'probably';
  P.load = function () { media.loads += 1; };
  P.play = function () { media.plays += 1; this._paused = false; return Promise.resolve(); };
  P.pause = function () { media.pauses += 1; this._paused = true; };
  Object.defineProperty(P, 'paused', { configurable: true, get() { return this._paused !== false; } });
  Object.defineProperty(P, 'seeking', { configurable: true, get() { return false; } });
  Object.defineProperty(P, 'readyState', { configurable: true, get() { return this._ready == null ? 4 : this._ready; } });
  Object.defineProperty(P, 'duration', { configurable: true, get() { return this._dur || 9.625; } });
  Object.defineProperty(P, 'currentTime', { configurable: true,
    get() { return this._t || 0; }, set(v) { media.seeks.push(v); this._t = v; } });
  const log = { melts: [], hides: 0, toasts: [], said: [] };
  const base = Object.assign({}, FOX, {
    STAGE_ART: {}, MELT_PATIENCE_MS: 45000, state: { stack: [], screen: 'home' },
    syncPreview() {}, cardFlowMayHaveEnded() {},
    setState(p) { const patch = typeof p === 'function' ? p(this.state) : p; this.state = Object.assign({}, this.state, patch); },
    showMelt(t) { log.melts.push(String(t)); }, hideMelt() { log.hides += 1; },
    toast(t) { log.toasts.push(String(t)); },
    mintNameOf: (u) => String(u || '').replace(/^https?:\/\//, ''), mintName: () => 'home',
    unitWord: (u) => (u === 'usd' ? 'DOLLARS' : 'BITCOIN'), unitFigure: (n) => String(n), group: (n) => String(n),
    hushSweepEntries: () => Promise.resolve(), refreshBalance() {}, loadHistory() {},
  });
  const a = new Proxy(base, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !/^[_A-Z]/.test(k) ? function () {} : undefined)) });
  let now = 1000;
  const turn = (n, ms) => {
    for (let k = 0; k < n; k++) {
      now += ms;
      const due = frames.splice(0, frames.length);
      due.forEach((fn) => fn(now));
    }
  };
  const stage = () => w.document.getElementById('foxy-stage');
  const fig = () => { const p = w.document.querySelector('[data-fox-pct]'); return p ? Number(p.textContent) : NaN; };
  const title = () => { const t = w.document.querySelector('[data-fox-title]'); return t ? t.textContent : ''; };
  const settle = async () => { for (let i = 0; i < 8; i++) await wait(0); };
  // ALL SET reached: the end runs its frames, and the screen is still up saying so
  const allSet = () => { turn(90, 1000 / 60); return !!stage() && title() === 'ALL SET' && fig() === 100; };
  return { w, a, turn, stage, fig, title, media, frames, log, settle, allSet };
}

(async () => {
  // ---- 1 the table ----
  {
    const a = FOX;
    ok(a.foxTarget('fee', 'asked') === 60 && a.foxTarget('fee', 'end') === 100,
      'a fee check: asked heads for 60, the answer is 100');
    ok(['asked', 'answered', 'made', 'landed'].map((s) => a.foxTarget('move', s)).join() === '25,45,75,95' && a.foxTarget('move', 'end') === 100,
      'a move between mints: quote asked 25, mint answered 45, pieces made 75, landed 95, confirmed 100');
    ok(['quote', 'melting', 'inflight', 'switching', 'claiming'].map((s) => a.foxTarget('move', s)).join() === '25,45,75,75,95',
      'the move’s own stages (moveRun, pay) read as those steps');
    ok(['paying', 'paid', 'claiming', 'done'].map((s) => a.foxTarget('swap', s)).join() === '45,75,95,95',
      'a swap’s own stages (swapRun) read as the same steps');
    ok(a.foxTarget('fee', 'made') === null && a.foxTarget('move', 'nonsense') === null, 'a step a flow does not have moves nothing');
    ok(a.FOX_FLOWS.fee.title === 'CHECKING THE FEE' && a.FOX_FLOWS.move.title === 'MOVING YOUR MONEY'
      && a.FOX_FLOWS.swap.title === 'MOVING YOUR MONEY', 'titles by what is happening');
    ok(['fee', 'move', 'swap'].every((f) => Object.keys(a.FOX_FLOWS[f].steps).every((s) => a.FOX_FLOWS[f].ms[s] > 0)),
      'every step has the length it is expected to take');
  }

  // ---- 2 the easing ----
  {
    const a = FOX;
    let shown = 0, worst = 0;
    for (let k = 0; k < 600; k++) {
      const next = a.foxEase(shown, 60, 1000 / 60, false);
      worst = Math.max(worst, next - shown);
      shown = next;
    }
    ok(worst <= 1.3, 'no frame moves it more than a point and a quarter while a step runs', worst.toFixed(3));
    let hundred = -1;
    worst = 0;
    for (let k = 0; k < 120 && hundred < 0; k++) {
      const next = a.foxEase(shown, 100, 1000 / 60, true);
      worst = Math.max(worst, next - shown);
      shown = next;
      if (a.foxFigure(shown) === 100) hundred = k;
    }
    ok(hundred >= 0 && hundred < 60 && worst <= 3.01, 'the real end arrives at 100 within a second, three points a frame at most', hundred + ' ' + worst.toFixed(2));
    ok(a.foxFigure(99.99) === 99 && a.foxFigure(100) === 100, '100 is written only once it is 100');
    ok(a.foxEase(30, 25, 16, false) === 30, 'a figure below the one shown changes nothing');
    ok(a.foxEase(0, 60, 2000, false) <= 75 * 0.05 + 1e-9, 'a page not drawn for two seconds counts it as a twentieth of one');
    // a slow step: a swap's melt (answered, 45, expected 6 s), driven as the screen drives it
    let s = 45, back = false;
    const at = (sec) => {
      let v = 45;
      for (let t = 0; t < sec * 60; t++) {
        const aim = Math.max(45, a.foxCreep('swap', 'answered', (t + 1) * 1000 / 60));
        const n = a.foxEase(v, aim, 1000 / 60, false);
        if (n < v) back = true;
        v = n;
      }
      return v;
    };
    const s5 = at(5), s6 = at(6), s30 = at(30), s120 = at(120);
    s = s120;
    ok(s6 > s5 && s6 - s5 < 1, 'five seconds into a slow step the figure still rises, by less than a point a second', s5.toFixed(2) + ' → ' + s6.toFixed(2));
    ok(s30 > s6 && s < 75 - 1 && !back, 'and never back, nor up to the next step’s figure', s.toFixed(2));
    ok(a.foxCreep('fee', 'asked', 1e9) <= 99 && a.foxCreep('move', 'landed', 1e9) <= 99, 'the last step creeps toward 100 and never reaches it');
  }

  // ---- 3 the video's place ----
  {
    const a = FOX;
    ok(Math.abs(a.foxScrub(50, 10) - 4.6) < 1e-9 && Math.abs(a.foxScrub(100, 9.625) - 9.625 * 0.92) < 1e-9 && a.foxScrub(0, 9) === 0,
      'the fox at figure / 100 × duration × 0.92');
    ok(Math.abs(a.foxScrub(100, NaN) - 9.625 * 0.92) < 1e-9 && Math.abs(a.foxScrub(50, Infinity) - 9.625 * 0.46) < 1e-9,
      'before the page has read the length, the file’s own 9.625 s');
    ok(a.foxScrub(140, 10) === a.foxScrub(100, 10) && a.foxScrub(-5, 10) === 0, 'never past the ends');
  }

  // ---- 4 the screen ----
  {
    const p = page();
    let cancelled = 0;
    p.a.stageScreen('calcFee', { fox: 'fee', title: 'Calculating<br>fee', dots: true, forMs: 45000, button: 'CANCEL', go: () => { cancelled += 1; } });
    const s = p.stage();
    ok(!!s && s.getAttribute('data-stage') === 'calcFee' && s.getAttribute('data-fox') === 'fee', 'up as a stage screen of its kind');
    ok(/#050505|rgb\(5, 5, 5\)/.test(s.style.background || s.style.backgroundColor), 'black');
    ok(p.title() === 'CHECKING THE FEE' && p.fig() === 0, 'CHECKING THE FEE, from 0');
    const t = p.w.document.querySelector('[data-fox-title]');
    ok(/nowrap/.test(t.style.whiteSpace), 'the title on one line, made smaller where it does not fit');
    const pct = p.w.document.querySelector('[data-fox-pct]').parentNode;
    ok(/76px/.test(pct.style.fontSize) && /EB6A2E|235, 106, 46/i.test(pct.style.color), 'the figure 76 px in the accent');
    const btn = s.querySelector('[data-stage-button]');
    ok(!!btn && btn.textContent === 'CANCEL' && /999px/.test(btn.style.borderRadius), 'a CANCEL pill at the foot');
    ok(p.a.stageUp('calcFee') && !p.a.stageUp('other'), 'stageUp knows it by its kind');
    p.turn(60, 1000 / 60);
    ok(p.fig() > 20 && p.fig() < 60, 'a second in, part of the way to 60', String(p.fig()));
    btn.click();
    ok(cancelled === 1 && !p.stage(), 'CANCEL cancels and takes it down');

    p.a.stageScreen('trMove', { fox: 'move', forMs: 45000 });
    ok(p.title() === 'MOVING YOUR MONEY' && !p.stage().querySelector('[data-stage-button]'), 'a move: MOVING YOUR MONEY, no CANCEL where nothing can be cancelled');
    p.turn(240, 1000 / 60);
    ok(p.fig() < 45, 'the quote being asked stays short of the next step’s figure', String(p.fig()));
    ok(p.a.foxStep('trMove', 'melting') && !p.a.foxStep('trMove', 'quote'), 'a later step moves it on; an earlier one does not move it back');
    p.a.foxHears('trMove')('claiming');
    p.turn(300, 1000 / 60);
    ok(p.fig() >= 75 && p.fig() < 100 && p.title() === 'MOVING YOUR MONEY', 'landing: past 75, never 100 before the end', String(p.fig()));
    ok(p.a.foxDone('trMove'), 'the real end');
    ok(p.allSet(), 'ALL SET at 100, held');
    await wait(p.a.FOX_HOLD_MS - 150);
    ok(!!p.stage(), 'still up a moment later');
    await wait(250);
    ok(!p.stage(), 'and down after ' + p.a.FOX_HOLD_MS + ' ms');

    p.a.stageScreen('swapMove', { fox: 'swap', forMs: 40 });
    await wait(80);
    ok(!p.stage(), 'its time limit takes it down');

    p.a.stageScreen('nmMove', { fox: 'fee' });
    p.a.foxEnd('nmMove', false);
    ok(!p.stage(), 'a wait that did not land comes down at once, with no ALL SET');
    p.a.stageScreen('nmMove', { fox: 'fee' });
    ok(p.a.hideStage('nmMove') && !p.stage(), 'hideStage takes it down by its kind');

    p.a.stageScreen('card', { art: 'card', title: 'HOLD YOUR CARD', button: 'CLOSE' });
    ok(p.a.foxUp('wdMove', 'move', {}) === false && p.stage().getAttribute('data-stage') === 'card',
      'never over another stage screen: the caller shows what it showed before');
    p.a.hideStage();
    p.a.stageScreen('priceSent', { fox: 'fee' });
    ok(p.a.foxUp('crossMove', 'move', {}) === true && p.stage().getAttribute('data-stage') === 'crossMove', 'but in place of another fox');
    p.a.hideStage();
  }

  // ---- 5 the video ----
  {
    const p = page();
    p.a.stageScreen('trMove', { fox: 'move' });
    const v = p.stage().querySelector('video');
    ok(!!v && v.getAttribute('src') === 'img/foxy-wait.mp4' && v.getAttribute('poster') === 'img/foxy-wait-first.png',
      'the fox is the video, the fox asleep until it has a frame');
    ok(!v.hasAttribute('loop') && !v.hasAttribute('autoplay') && v.muted && v.hasAttribute('playsinline'), 'muted, inline, never looped or started');
    ok(/screen/.test(v.style.mixBlendMode) && /285px/.test(v.style.height) && /contain/.test(v.style.objectFit), 'blended onto the black, 285 px, contained');
    p.turn(30, 1000 / 60);
    const last = p.media.seeks[p.media.seeks.length - 1];
    ok(p.media.plays === 0 && p.media.seeks.length >= 10, 'put on its frame as the figure moves, never played', JSON.stringify({ plays: p.media.plays, seeks: p.media.seeks.length }));
    ok(Math.abs(last - p.a.foxScrub(p.a._fox.shown, 9.625)) < 1 / 48 + 1e-9, 'on the frame of the figure shown');
    const n = p.media.seeks.length;
    p.turn(1, 1000 / 60);
    ok(p.media.seeks.length - n <= 1, 'once a frame at most');
    p.a.foxStep('trMove', 'claiming');
    p.turn(20, 1000 / 60);
    p.a.foxDone('trMove');
    for (let i = 0; i < 120 && p.title() !== 'ALL SET'; i++) p.turn(1, 1000 / 60);
    ok(p.title() === 'ALL SET' && Math.abs(v.currentTime - p.a.foxScrub(100, 9.625)) < 1e-9, 'at ALL SET the fox stands: the frame of 100', String(v.currentTime));
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    Object.defineProperty(p.w.document, 'hidden', { configurable: true, get: () => true });
    v._paused = false;
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    ok(v.paused, 'in the background the video is paused');
    p.a.hideStage();
    ok(!v.hasAttribute('src') && p.media.loads >= 1 && p.a._fox === null, 'down: its file let go of');

    const q = page({ reduce: true });
    q.a.stageScreen('calcFee', { fox: 'fee', go() {} });
    q.turn(120, 1000 / 60);
    const marks = q.media.seeks.map((t) => Math.round(t / q.a.foxScrub(100, 9.625) * 100));
    ok(q.fig() > 20 && q.media.plays === 0, 'Reduce Motion: the figure moves, the fox does not play');
    ok(marks.every((m) => m % 10 === 0) && marks.length <= 1 + Math.floor(q.fig() / 10) && marks[marks.length - 1] <= q.fig(),
      'a still frame, moved only every tenth point and never ahead of the figure', marks.join(',') + ' at ' + q.fig());
    q.a.foxDone('calcFee');
    q.turn(80, 1000 / 60);
    ok(marks.length < q.media.seeks.length && Math.abs(q.media.seeks[q.media.seeks.length - 1] - q.a.foxScrub(100, 9.625)) < 1e-9,
      'and standing at 100');
    q.a.hideStage();
  }

  // ---- 6 each wait, end to end ----
  const T = (name, good, detail) => ok(good, name, detail);

  // a crossing's CALCULATING FEE (crossMintCard)
  {
    const p = page();
    Object.assign(p.a, lift(['crossMintCard']));
    let release = null;
    const first = p.a.crossMintCard(new Promise((r) => { release = r; }), 'https://them', 'https://me');
    await wait(150);
    T('CALCULATING FEE is the fox', !!p.stage() && p.title() === 'CHECKING THE FEE');
    p.stage().querySelector('[data-stage-button]').click();
    T('CANCEL resolves false, as before', (await first) === false && !p.stage());
    T('its 45 s limit kept', /fox: 'fee'[^}]*forMs: 45000/.test(byName('crossMintCard')));
    const two = later();
    p.a.crossMintCard(two.p, 'https://them', 'https://me');
    await wait(150);
    two.res({ net: 1000, feeSats: 3 });
    await p.settle();
    T('the fee came: ALL SET', p.allSet());
    const three = later();
    p.a.crossMintCard(three.p, 'https://them', 'https://me').catch(() => {});
    await wait(150);
    three.rej(new Error('no'));
    await p.settle();
    T('the fee did not come: down at once', !p.stage());
  }

  // the other phone's fee (tapStuckAtMint) and its invoice (tapAwaitInvoice)
  {
    const mk = () => {
      const p = page();
      let hear = null;
      global.window.FoxyWallet = {
        mintUrl: 'https://me', onTapTerms(fn) { hear = fn; }, tapQuote: () => Promise.resolve(),
        decodeRequest: (r) => (r === 'good' ? { sats: 1000, mints: ['https://me'] } : r === 'other' ? { sats: 5000, mints: ['https://me'] } : null),
        reason: (e) => String(e && e.message),
      };
      Object.assign(p.a, lift(['tapStuckAtMint', 'waitingScreen', 'tapAwaitInvoice']), {
        crossFeeCard: () => new Promise(() => {}),
      });
      return { p, say: (o) => hear(JSON.stringify(o)) };
    };
    let m = mk();
    m.p.a.tapStuckAtMint({ read: { sats: 1000 } }, { mint: 'https://me', have: 2000 }, 1000);
    T('the other phone’s fee: the fox, with CANCEL', m.p.title() === 'CHECKING THE FEE' && !!m.p.stage().querySelector('[data-stage-button]'));
    m.say({ req: 'good', sats: 1000 });
    T('their answer: ALL SET', m.p.allSet());
    m = mk();
    m.p.a.tapStuckAtMint({ read: { sats: 1000 } }, { mint: 'https://me', have: 2000 }, 1000);
    m.say({ why: 'cannot' });
    T('a refusal: down at once', !m.p.stage());
    m = mk();
    m.p.a.tapStuckAtMint({ read: { sats: 1000 } }, { mint: 'https://me', have: 2000 }, 1000);
    m.say({ req: 'other', sats: 1000 });
    T('a request that does not match: down at once', !m.p.stage());
    m = mk();
    let back = 0;
    m.p.a.back = () => { back += 1; };
    m.p.a.tapStuckAtMint({ read: { sats: 1000 } }, { mint: 'https://me', have: 2000 }, 1000);
    m.p.stage().querySelector('[data-stage-button]').click();
    T('its CANCEL: down, and back', !m.p.stage() && back === 1);

    m = mk();
    let paid = null;
    m.p.a.tapPayOffer = (o) => { paid = o; };
    m.p.a.tapAwaitInvoice({ mints: ['https://them'] }, 1000);
    T('Getting their invoice: the fox, CHECKING THE FEE', m.p.title() === 'CHECKING THE FEE');
    m.say({ inv: 'lnbc10n1abc' });
    T('the invoice came: ALL SET, and on with it', m.p.allSet() && paid && paid.inv === 'lnbc10n1abc');
    m = mk();
    m.p.a.tapPayOffer = (o) => { paid = o; };
    paid = null;
    m.p.a.tapAwaitInvoice({ mints: ['https://them'] }, 1000);
    m.p.stage().querySelector('[data-stage-button]').click();
    T('its CANCEL: down, and nothing paid', !m.p.stage() && paid === null);
    m = mk();
    m.p.a.tapPayOffer = (o) => { paid = o; };
    m.p.a.tapAwaitInvoice({ mints: ['https://them'] }, 1000);
    await wait(5100);
    T('five seconds and no invoice: down at once, and on without it', !m.p.stage() && paid && !paid.inv);
  }

  // a transfer (runTransfer)
  for (const good of [true, false]) {
    const p = page();
    const run = later();
    let stage = null;
    global.window.FoxyWallet = { connect: () => Promise.resolve(), moveRun: (plan, s) => { stage = s; return run.p; }, reason: (e) => String(e && e.message) };
    Object.assign(p.a, lift(['runTransfer']));
    p.a.state = { trPlan: { unit: 'sat', mintQuote: { quote: 'q' } }, trBusy: false, trFrom: 'https://a', trTo: 'https://b', trSats: 100 };
    p.a.runTransfer();
    await p.settle();
    T('a transfer: MOVING YOUR MONEY, no melt loader', p.title() === 'MOVING YOUR MONEY' && p.log.melts.length === 0);
    stage('melting');
    p.turn(60, 1000 / 60);
    T('its stages move the figure', p.fig() >= 25);
    if (good) { run.res({ sats: 100 }); await p.settle(); T('landed: ALL SET', p.allSet()); }
    else { run.rej(new Error('no route')); await p.settle(); T('failed: down at once', !p.stage()); }
  }

  // a swap (swapGo), each outcome
  for (const how of ['done', 'settled', 'held', 'failed', 'throw']) {
    const p = page();
    const run = later();
    let pending = how === 'held' ? [{ id: 's' }] : [];
    global.window.FoxyWallet = {
      swapRun: () => run.p, unitSwapsPending: () => pending, sweepMelts: () => Promise.resolve(), recoverSwaps: () => Promise.resolve(),
      reason: (e) => String(e && e.message),
    };
    Object.assign(p.a, lift(['swapGo', 'swapAwait']), { swapLeft: () => 100, swapUnits: () => ({ from: 'sat', to: 'usd' }),
      balNow: () => 0, offlineNow: () => false, moneyBusy: () => false, SWAP_WAIT_MS: 60, SWAP_WAIT_STEP_MS: 10 });
    p.a.state = { swapQuote: { total: 100, get: 5 }, swapBusy: false, swapQuoting: false };
    p.a.swapGo();
    T('a swap (' + how + '): the fox', p.title() === 'MOVING YOUR MONEY' && p.log.melts.length === 0);
    if (how === 'throw') run.rej(new Error('no'));
    else run.res({ id: 's', state: how === 'done' ? 'done' : how === 'failed' ? 'failed' : 'pending' });
    await wait(how === 'held' ? 120 : 30);
    await p.settle();
    if (how === 'done' || how === 'settled') T('  ALL SET', p.allSet());
    else T('  down at once', !p.stage());
  }

  // PAY FROM's swap before a payment (pfSwapThenPay)
  for (const how of ['done', 'pending', 'throw']) {
    const p = page();
    const run = later();
    global.window.FoxyWallet = { swapRun: () => run.p, reason: (e) => String(e && e.message) };
    Object.assign(p.a, lift(['pfSwapThenPay']), { pfName: (m) => m });
    p.a.pfSwapThenPay({ id: 'r' }, { swap: { e: { unit: 'sat', toUnit: 'usd', mint: 'm' }, q: { state: 'quoted', expiresAt: Date.now() + 60000 } } }, {});
    await p.settle();
    T('PAY FROM’s swap (' + how + '): the fox', p.title() === 'MOVING YOUR MONEY');
    if (how === 'throw') run.rej(new Error('no')); else run.res({ state: how });
    await p.settle();
    if (how === 'done') T('  ALL SET', p.allSet()); else T('  down at once', !p.stage());
  }

  // PAY FROM while every balance is still asking (pfOpen, pfIn)
  {
    const mk = () => {
      const p = page();
      global.window.FoxyWallet = { mintUrl: 'https://a', reason: (e) => String(e && e.message) };
      Object.assign(p.a, lift(['pfMint', 'pfHere', 'pfKey', 'pfName', 'pfEntry', 'pfRanked', 'pfCheapest', 'pfList', 'pfOpen', 'pfAsk', 'pfIn', 'pfSettled']));
      const asks = {};
      const list = ['https://a', 'https://b'].map((m) => p.a.pfEntry({ mint: m, unit: 'sat', have: 5000 }));
      let cancels = 0, nones = 0, went = 0;
      const open = () => p.a.pfOpen('send', list, { show: true, quote: (e) => { asks[e.mint] = later(); return asks[e.mint].p; },
        go: () => { went += 1; }, none: () => { nones += 1; }, cancel: () => { cancels += 1; } });
      return { p, asks, open, n: () => ({ cancels, nones, went }) };
    };
    let m = mk();
    m.open();
    T('PAY FROM, every balance asking: the fox, CHECKING THE FEE, with CANCEL', m.p.title() === 'CHECKING THE FEE' && !!m.p.stage().querySelector('[data-stage-button]'));
    m.asks['https://b'].res({ ok: true, cost: 1001, fee: 1 });
    await m.p.settle();
    T('the first that can pay: ALL SET', m.p.allSet());
    m = mk();
    m.open();
    m.asks['https://a'].res({ ok: false, why: 'short' });
    await m.p.settle();
    T('one that cannot: still asking the other', !!m.p.stage() && m.p.title() === 'CHECKING THE FEE');
    m.asks['https://b'].res({ ok: false, why: 'short' });
    await m.p.settle();
    T('none can: down at once, before NOT ENOUGH', !m.p.stage() && m.n().nones === 1);
    m = mk();
    m.open();
    const stale = m.asks['https://a'];
    m.open();
    stale.res({ ok: true, cost: 1000, fee: 0 });
    await m.p.settle();
    m.p.turn(60, 1000 / 60);
    T('an answer from an earlier asking leaves the fox alone', !!m.p.stage() && m.p.title() === 'CHECKING THE FEE');
    m.p.stage().querySelector('[data-stage-button]').click();
    T('its CANCEL is the screen’s own way out', !m.p.stage() && m.n().cancels === 1);
  }

  // a token from another mint: its fee (nmQuote), its move (newMintRedeem), its change (sweepChange)
  {
    const mk = () => {
      const p = page();
      const q = later(), take = later(), move = later(), change = later(), change2 = later();
      let moves = 0;
      global.window.FoxyWallet = {
        sweepQuote: (m, n) => (moves ? change.p : q.p), receiveToken: () => take.p, transactions: () => Promise.resolve([]),
        moveRun: () => { moves += 1; return moves === 1 ? move.p : change2.p; }, connect: () => Promise.resolve(), reason: (e) => String(e && e.message),
      };
      Object.assign(p.a, lift(['nmQuote', 'newMintRedeem', 'sweepChange']), { movingUp() { p.log.melts.push('moving'); return true; } });
      p.a.state = { nmInfo: { mint: 'https://them', sats: 1000 }, nmPlan: { to: 'https://me', feeMax: 2 }, nmToken: 'cashuA', nmBusy: false };
      return { p, q, take, move, change, change2 };
    };
    let m = mk();
    m.p.a.nmQuote();
    T('a token from another mint: its fee is the fox', m.p.title() === 'CHECKING THE FEE' && m.p.log.melts.length === 0);
    m.q.res({ feeSats: 2 });
    await m.p.settle();
    T('  the fee came: ALL SET', m.p.allSet());
    m = mk();
    m.p.a.nmQuote();
    m.q.rej(new Error('more than the token is worth'));
    await m.p.settle();
    T('  no fee to be had: down at once', !m.p.stage());

    m = mk();
    m.p.a.newMintRedeem();
    T('its move: MOVING YOUR MONEY', m.p.title() === 'MOVING YOUR MONEY');
    m.take.res({ host: 'them' });
    await m.p.settle();
    m.move.res({ sats: 990, leftBehind: 0 });
    await m.p.settle();
    T('  landed: ALL SET', m.p.allSet());
    m = mk();
    m.p.a.newMintRedeem();
    m.take.res({ host: 'them' });
    await m.p.settle();
    m.move.rej(new Error('no route'));
    await m.p.settle();
    T('  failed: down at once', !m.p.stage());
    m = mk();
    m.p.a.newMintRedeem();
    m.take.res({ host: 'them' });
    await m.p.settle();
    m.move.res({ sats: 900, leftBehind: 80, from: 'https://them' });
    await m.p.settle();
    m.p.turn(60, 1000 / 60);
    T('  change left behind: the same fox carries on, short of 100', !!m.p.stage() && m.p.fig() < 100 && m.p.title() === 'MOVING YOUR MONEY' && m.p.log.melts.length === 0);
    m.change.res({ to: 'https://me' });
    await m.p.settle();
    m.change2.res({ sats: 70, leftBehind: 0 });
    await m.p.settle();
    T('  the change moved: ALL SET', m.p.allSet());
    for (const why of ['chasing', 'busy']) {
      const k = mk();
      k.p.a.stageScreen('nmMove', { fox: 'move' });
      if (why === 'chasing') k.p.a._chasingChange = true; else k.p.a.moneyBusy = () => true;
      k.p.a.sweepChange('https://them', 80, 900);
      T('  change not moved (' + why + '): the money that came landed, ALL SET', k.p.allSet());
    }
  }

  // WITHDRAW TO's crossing (fcWdCross)
  for (const good of [true, false]) {
    const p = page();
    const run = later();
    global.window.FoxyWallet = { mintUrl: 'https://card', transferQuote: () => Promise.resolve({ to: 'https://b' }), moveRun: () => run.p,
      connect: () => Promise.resolve(), reason: (e) => String(e && e.message) };
    Object.assign(p.a, lift(['fcWdCross']), { fcWdLand: (n) => n, _fcWdTo: 'https://b', _fcWdFee: 2, _fcWd: { card: 'https://card', unit: 'sat' } });
    p.a.fcWdCross(500, 'sat');
    T('WITHDRAW TO’s crossing: the fox', p.title() === 'MOVING YOUR MONEY' && p.log.melts.length === 0);
    await p.settle();
    if (good) { run.res({ sats: 490 }); await p.settle(); T('  landed: ALL SET', p.allSet()); }
    else { run.rej(new Error('no')); await p.settle(); T('  failed: down at once', !p.stage()); }
  }

  // a tap's crossing (crossMove), and its failure (crossFailed)
  for (const good of [true, false]) {
    const p = page();
    const run = later();
    global.window.FoxyWallet = { mintUrl: 'https://me', connect: () => Promise.resolve(), moveRun: () => run.p, transactions: () => Promise.resolve([]),
      reason: (e) => String(e && e.message) };
    Object.assign(p.a, lift(['crossMove']));
    p.a.stageScreen('crossFee', { fox: 'fee' });
    const done = p.a.crossMove({ net: 1000 }, 'https://them', 'https://me').catch(() => 'failed');
    T('a tap’s crossing: the fox, in place of the fee’s', p.title() === 'MOVING YOUR MONEY' && p.stage().getAttribute('data-stage') === 'crossMove' && p.log.melts.length === 0);
    if (good) { run.res({}); await done; await p.settle(); T('  at their mint: ALL SET', p.allSet()); }
    else { run.rej(new Error('no')); T('  failed: down at once', (await done) === 'failed' && !p.stage()); }
  }

  // a payment brought home (carryHomeNow), and the cards' BRING IT HOME and SEND IT BACK
  for (const state of ['home', 'retry']) {
    const p = page();
    const walk = later();
    let stageFn = null;
    global.window.FoxyWallet = { mintUrl: 'https://them', carryHome: (id, plan, s) => { stageFn = s; return walk.p; }, transactions: () => Promise.resolve([]),
      balanceAt: () => 0, reason: (e) => String(e && e.message) };
    let outcome = null;
    Object.assign(p.a, lift(['carryHomeNow']), { carryOutcome: (r) => { outcome = r; },
      _carryHome: { id: 'j', back: 'https://me', terms: { net: 900, sats: 1000, plan: {} } } });
    p.a.carryHomeNow();
    T('a payment brought home (' + state + '): the fox', p.title() === 'MOVING YOUR MONEY' && p.log.melts.length === 0);
    stageFn('claiming');
    walk.res({ state });
    await p.settle();
    if (state === 'home') T('  home: ALL SET', p.allSet() && outcome.state === 'home');
    else T('  not home: down at once, before its card', !p.stage() && outcome.state === 'retry');
  }
  {
    const p = page();
    Object.assign(p.a, lift(['carryFoxUp', 'carryFoxDown']));
    T('BRING IT HOME / SEND IT BACK on the cards: the fox', p.a.carryFoxUp('Sending the payment back…') === true && p.title() === 'MOVING YOUR MONEY');
    p.a.carryFoxDown(true, false);
    T('  sent back: down at once, for the card that says so', !p.stage());
    p.a.carryFoxUp('Bringing the payment to your mint…');
    p.a.carryFoxDown(true, true);
    T('  home: ALL SET', p.allSet());
    const sends = (app.match(/this\.carryFoxUp\('Sending the payment back\\u2026'\)/g) || []).length;
    const homes = (app.match(/this\.carryFoxUp\('Bringing the payment to your mint\\u2026'/g) || []).length;
    T('  both cards’ buttons, twice each, use it', sends === 2 && homes === 2, sends + ' ' + homes);
  }

  // ---- 7 the files ----
  {
    const mp4 = path.join(ROOT, 'Web', 'img', 'foxy-wait.mp4');
    const first = path.join(ROOT, 'Web', 'img', 'foxy-wait-first.png');
    ok(fs.existsSync(mp4) && fs.existsSync(first), 'the video and the fox asleep ship in Web/img');
    ok(!fs.existsSync(path.join(ROOT, 'Web', 'img', 'foxy-intro.webm')), 'and no WebM');
    const tool = fs.readFileSync(path.join(ROOT, 'tools', 'make-intro.swift'), 'utf8');
    ok(/AVVideoMaxKeyFrameIntervalKey: 1/.test(tool) && /foxy-wait\.mp4/.test(tool), 'made by tools/make-intro.swift --wait, every frame a key frame');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  threw: ' + (e && e.stack)); process.exit(1); });
