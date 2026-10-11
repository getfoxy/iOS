'use strict';
/* rider-lines.js — the emphasis lines the rider throws off.
 *
 *     node tests/rider-lines.js
 *
 * The ride itself is watched on a phone, but the lines are three lines of
 * arithmetic away from drawing nothing at all: a pool that never fills, a
 * speed floor nothing passes, a layer the marker cannot find. All three
 * failures look identical on a screenshot — an empty chart — and the first
 * attempt shipped one of them.
 *
 * So the methods are lifted out of build/foxy-app.js and run against a rail
 * this file shapes: a deep dip on the left, a crest on the right, in jsdom,
 * with the clock and the frames driven by hand.
 *
 * It also holds the arithmetic of the price line turning into the fresh one
 * (the points mixed by position, the ends exact, the path text unchanged) and
 * of the rider being carried by the line while it does (same place along it,
 * no jump, the sled's own clock undisturbed). price-line.js has the same in the
 * whole page, with the renderer.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function member(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  return block(at + 3);
}
// the ride's numbers, read from the class rather than copied here
const nums = {};
src.split('\n').forEach(line => {
  const m = /^  ((?:RIDE|SKATE|SLED)_[A-Z_]+) = ([0-9.]+);/.exec(line);
  if (m) nums[m[1]] = Number(m[2]);
});
const methods = new Function('return {' + [
  'riderTrack(el, known) {', 'riderLines(el) {', 'riderLine(stk, x, y, len, angle, op, life) {',
  'riderLinesOff() {', 'riderFade(lines, dt) {', 'riderAir(lines, bag, cx, cy, ang, speed, dt) {',
  'riderImpact(lines, cx, cy) {', 'markerGone() {', 'buildChart(rows, label) {',
  'riderCovered() {', 'riderWhenSeen() {', 'riderShow() {',
  'markerRoll() {', 'sledLayout(body) {', 'sledFrame(body, fr) {',
  'chartCurve(pts) {', 'chartFillPath(d) {', 'chartBetween(a, b, u) {',
  'riderRetrack() {', 'riderCarried(was, now, along) {', 'riderClock(track, along) {', 'markerStayPut() {',
].map(member).join(',\n') + '}')();

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

/* A rail 402 x 92, the page's own view box: dips and crests the whole way, so
 * a run across it passes through fast ground and slow — and still climbing
 * where it ends, so "he keeps the angle he stopped on" is a claim that can
 * fail rather than one a flat finish would pass either way. */
const railY = x => 62 - 0.09 * x + 18 * Math.sin(x / 38);

function page() {
  const dom = new JSDOM('<!doctype html><div id="wrap">'
    + '<svg viewBox="0 0 402 92"><path d="M0 0"></path></svg>'
    + '<div data-rider="streaks"></div>'
    + '<div id="marker"><div data-rider="body"></div></div>'
    + '</div>');
  const doc = dom.window.document;
  const wrap = doc.getElementById('wrap');
  const pathEl = doc.querySelector('path');
  // jsdom draws nothing, so the rail and the box are answered here
  pathEl.getTotalLength = () => 402;
  pathEl.getPointAtLength = (at) => ({ x: at, y: railY(at) });
  wrap.getBoundingClientRect = () => ({ width: 402, height: 92, left: 0, top: 0 });
  global.document = doc;
  global.window = { };                        // no launch cover unless a check sets one
  global.performance = { now: () => clock.now };
  global.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  global.cancelAnimationFrame = () => {};
  const body = doc.querySelector('[data-rider="body"]');
  return { doc, marker: doc.getElementById('marker'), body: body,
    layer: doc.querySelector('[data-rider="streaks"]') };
}

let frames = [], clock = { now: 0 };
function app(marker, over) {
  return Object.assign({ _marker: marker, _pts: null, _mraf: 0, state: { screen: 'home' } },
    nums, methods, over || {});
}
/* Run the ride at sixty frames a second, the whole way through unless a
 * shorter window is asked for. The whole way matters: the first stretch is the
 * tuck behind the left edge, where there is nothing to draw, and a test that
 * watched only that would call a working ride broken. */
function pump(a, from, ms, onFrame) {
  for (let t = from + 16; t <= from + ms; t += 16) {
    const next = frames.pop();
    if (!next) break;
    frames = [];
    clock.now = t;
    next(t);
    if (onFrame) onFrame(t);
  }
  return Math.min(clock.now, from + ms);
}
function ride(a, ms, onFrame) {
  frames = [];
  clock.now = 0;
  a.markerRoll();
  return pump(a, 0, ms, onFrame);
}
const lit = layer => Array.from(layer.children).filter(el => Number(el.style.opacity) > 0.01);

// ---- the pool is made, once ------------------------------------------------
{
  const { marker, layer } = page();
  const a = app(marker);
  a.markerRoll();
  check('the ride makes a pool of lines in the layer the template leaves empty',
    layer.children.length === 18, layer.children.length + ' children');
  const first = layer.firstChild;
  a.markerRoll();
  check('a second ride reuses the same pool rather than growing it',
    layer.children.length === 18 && layer.firstChild === first, layer.children.length + ' children');
}

// ---- lines are drawn, and where the ride is fast ----------------------------
let everything = 0;
{
  const { marker, layer } = page();
  const a = app(marker);
  let seen = 0, high = 0;
  ride(a, a.RIDE_MS + 500, () => {
    const on = lit(layer).length;
    seen += on;
    if (on > high) high = on;
  });
  check('the ride draws emphasis lines at all', seen > 0, 'not one line was lit');
  check('and several are alight at once where it is quick', high >= 2, 'at most ' + high);
  everything = seen;
}

// ---- the floors mean something ---------------------------------------------
{
  const { marker, layer } = page();
  const a = app(marker);
  a.RIDE_LINE_MIN = 99;                       // nothing on this rail is that fast
  a.RIDE_IMPACT_MIN = 99;
  let seen = 0;
  ride(a, a.RIDE_MS + 500, () => { seen += lit(layer).length; });
  check('floors above the rail’s own speed draw nothing at all', seen === 0,
    seen + ' lines were lit');
}
{
  /* With only the air floor raised, what is left is the landings: a burst of
   * three at the bottom of a dip and nothing in between. */
  const { marker, layer } = page();
  const a = app(marker);
  a.RIDE_LINE_MIN = 99;
  let seen = 0;
  ride(a, a.RIDE_MS + 500, () => { seen += lit(layer).length; });
  check('a rail with no fast air still gets its landing bursts',
    seen > 0 && seen < everything / 4, seen + ' against ' + everything + ' in full');
}

// ---- and they go out when it parks -----------------------------------------
{
  const { marker, layer } = page();
  const a = app(marker);
  ride(a, a.RIDE_MS + 500);
  a.markerGone();
  check('parking puts every line out', lit(layer).length === 0, lit(layer).length + ' still alight');
}

// ---- a chart with no layer still rides -------------------------------------
{
  const { marker, layer } = page();
  layer.remove();
  const a = app(marker);
  let threw = '';
  try { ride(a, a.RIDE_MS + 500); } catch (e) { threw = String(e && e.message); }
  check('a page without the layer rides anyway', !threw, threw);
}

// ---- he does not stop: through the line and off the right -------------------
{
  const { marker } = page();
  const a = app(marker);
  let far = -Infinity, seenOnScreen = false;
  ride(a, a.RIDE_MS + 200, () => {
    const x = parseFloat(marker.style.left);
    if (!Number.isNaN(x)) {
      if (x > far) far = x;
      if (x > 40 && x < 360) seenOnScreen = true;
    }
  });
  check('he crosses the chart on the way', seenOnScreen, 'he was never on the screen');
  check('and carries on past its right edge before the ride ends', far > 402,
    'he got no further than ' + far.toFixed(1) + 'px of 402');
  check('the ride leaves nothing parked on the line',
    marker.style.visibility === 'hidden' && !a._riding,
    marker.style.visibility + (a._riding ? ', still riding' : ''));
}
{
  // and the ride shows him again from wherever he was put away
  const { marker } = page();
  const a = app(marker);
  a.markerGone();
  check('he waits out of sight', marker.style.visibility === 'hidden', marker.style.visibility);
  frames = [];
  clock.now = 0;
  a.markerRoll();
  pump(a, 0, 100);
  check('a fresh ride brings him back into view',
    marker.style.visibility === 'visible', marker.style.visibility);
  check('and starts him behind the left edge', parseFloat(marker.style.left) < 0,
    marker.style.left);
}

// ---- the drawn line runs off both edges, the ride does not -----------------
{
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ c: 80000 + 900 * Math.sin(i / 7) + i * 20 });
  const a = app(null);
  const chart = a.buildChart(rows, 'last 24 hours');
  const xs = (chart.d.match(/-?[0-9.]+ -?[0-9.]+/g) || []).map(pair => Number(pair.split(' ')[0]));
  check('the drawing starts left of the view box, so that end is cut off',
    Math.min.apply(null, xs) < 0, 'leftmost drawn x is ' + Math.min.apply(null, xs));
  check('and runs past its right edge, so that one is too',
    Math.max.apply(null, xs) > 402, 'rightmost drawn x is ' + Math.max.apply(null, xs));
  const ends = chart.pts;
  check('the price’s own points stay on the screen',
    ends[0].x > 0 && ends[ends.length - 1].x < 100,
    ends[0].x.toFixed(1) + '% … ' + ends[ends.length - 1].x.toFixed(1) + '%');
  check('and the delta reads off the price, not off the bleed',
    /^\+\$/.test(chart.t), chart.t);
}
{
  /* The ride runs the whole drawing — both bleeds included, since that is what
   * carries him on and off the screen — and then some, so he is clear of the
   * right edge by the time it ends. */
  const { marker } = page();
  const a = app(marker);
  const track = a.riderTrack(marker);
  /* This rail is the whole width — the real one is drawn wider than the screen
   * — so "nothing is trimmed" is the claim: the track reaches the drawing's
   * own end rather than stopping somewhere inside it. */
  check('the track is the whole drawing, not a trimmed part of it',
    Math.abs(track.pts[track.pts.length - 1].x - 402) < 2, 'it ran to '
      + track.pts[track.pts.length - 1].x.toFixed(1) + 'px of 402');
  check('and the ride carries past both of its ends',
    Math.abs(track.whole - (a.RIDE_IN_PX + track.total + a.RIDE_OUT_PX)) < 0.001,
    track.whole + ' against ' + (a.RIDE_IN_PX + track.total + a.RIDE_OUT_PX));
}

// ---- nothing rides behind the launch screen --------------------------------
{
  /* The home screen is drawn while the native launch cover is still over the
   * page. A ride there is a ride nobody sees, and the person arrives to an
   * empty line. */
  const { marker } = page();
  const a = app(marker);
  global.window.FoxyGate = { visible: () => true };
  frames = [];
  clock.now = 0;
  check('a ride called while the launch screen is up does not start',
    a.markerRoll() === false, 'it started anyway');
  check('and nothing was drawn under the cover', frames.length === 0,
    frames.length + ' frames were asked for');
  check('but it arranges to look again', !!a._rideWait, 'nothing was scheduled');
  clearTimeout(a._rideWait);

  global.window.FoxyGate = { visible: () => false };
  check('once the cover is down the same call rides', a.markerRoll() === true,
    'it still refused');
  check('and this time it draws', frames.length > 0, 'no frame was asked for');
  a.markerGone();
}

// ---- an attempt that cannot ride yet says so --------------------------------
{
  /* The bug this pins: a cold launch reaches the home screen a second or two
   * before the price line does, and the caller records "he has ridden" from
   * whatever the attempt returns. If putting him away counts as a ride, the
   * series landing afterwards finds the work already done and he is never
   * seen at all (on a first launch). */
  const { marker, doc } = page();
  const a = app(marker);
  global.window = { };
  doc.querySelector('path').getTotalLength = () => 0;      // nothing drawn yet
  frames = [];
  check('with no line to ride, the attempt answers no', a.riderShow() === false,
    'it claimed a ride');
  check('and puts him out of sight meanwhile', marker.style.visibility === 'hidden',
    marker.style.visibility);
  doc.querySelector('path').getTotalLength = () => 402;    // the series lands
  clock.now = 0;
  check('the next attempt, once the line is there, rides', a.riderShow() === true,
    'it still refused');
}

/* ---- the sheet, and the frames in it -------------------------------------- */
{
  const el = page();
  const a = app(el.marker);
  a.sledLayout(el.body);
  check('the rider is sized from one number',
    Math.abs(parseFloat(el.body.style.width) - a.RIDE_W_PX) < 0.5, el.body.style.width);
  check('and is as tall as the drawing is',
    Math.abs(parseFloat(el.body.style.height)
      - a.RIDE_W_PX * a.SLED_FRAME_H / a.SLED_FRAME_W) < 0.5, el.body.style.height);
  const seen = new Set();
  for (let fr = 0; fr < a.SLED_FRAMES; fr++) {
    a.sledFrame(el.body, fr);
    seen.add(el.body.style.backgroundPosition);
  }
  check('all ' + a.SLED_FRAMES + ' frames of the bob are distinct',
    seen.size === a.SLED_FRAMES, seen.size + ' distinct positions');
  a.sledFrame(el.body, 0);
  check('frame 0 is the start of the sheet',
    /^0(\.0+)?% 0(\.0+)?%$/.test(el.body.style.backgroundPosition),
    el.body.style.backgroundPosition);
  a.sledFrame(el.body, a.SLED_FRAMES - 1);
  // the last frame sits where the grid puts it: the bottom row, its own column
  const lastCol = (a.SLED_FRAMES - 1) % a.SLED_COLS;
  const wantX = (lastCol * (100 / (a.SLED_COLS - 1))).toFixed(4);
  check('and the last frame is on the bottom row of it',
    /^\d+(\.\d+)?% 100(\.0+)?%$/.test(el.body.style.backgroundPosition) && parseFloat(el.body.style.backgroundPosition) === parseFloat(wantX),
    el.body.style.backgroundPosition);
}

/* ---- the run cycle turns over while he rides ------------------------------ */
{
  const el = page();
  const a = app(el.marker);
  const seen = new Set();
  ride(a, a.RIDE_MS, () => seen.add(el.body.style.backgroundPosition));
  check('every frame of the drawing is used across one ride',
    seen.size === a.SLED_FRAMES, seen.size + ' of ' + a.SLED_FRAMES + ' frames shown');
}

/* ---- he moves, forward, and round again -----------------------------------
 *
 * The first cut of this drawing barely changed from frame to frame and read as
 * a still picture on the phone. These say the frames are
 * really turning over, one at a time, forward through the whole drawing and
 * round to its start (the gif, all of it, at its own pace). */
{
  const el = page();
  const a = app(el.marker);
  // which frame each background-position is, by asking sledFrame for each
  const index = {};
  for (let fr = 0; fr < a.SLED_FRAMES; fr++) {
    a.sledFrame(el.body, fr);
    index[el.body.style.backgroundPosition] = fr;
  }
  const order = [];
  ride(a, a.RIDE_MS, () => {
    const fr = index[el.body.style.backgroundPosition];
    if (order.length === 0 || order[order.length - 1] !== fr) order.push(fr);
  });
  check('the drawing changes frame many times over one ride',
    order.length > 20, 'only ' + order.length + ' changes');

  const steps = [];
  for (let i = 1; i < order.length; i++) steps.push(order[i] - order[i - 1]);
  // one frame at a time, except the wrap from the last frame round to the first
  check('it never jumps more than one frame at a time',
    steps.every(d => d === 1 || d === -(a.SLED_FRAMES - 1)),
    'biggest jump ' + Math.max(...steps.map(Math.abs)) + ' frames');
  check('and it only runs forward, the way the drawing was made',
    steps.every(d => d > 0 || d === -(a.SLED_FRAMES - 1)),
    'back steps ' + steps.filter(d => d < 0 && d !== -(a.SLED_FRAMES - 1)).length);
  check('it reaches both ends of the drawing',
    order.includes(0) && order.includes(a.SLED_FRAMES - 1),
    'range ' + Math.min(...order) + '..' + Math.max(...order));
}

/* ---- the drawing of a line has not changed --------------------------------
 *
 * The path was built inside buildChart and is now `chartCurve`, so one line can
 * be turned into another a frame at a time. These strings are what the
 * original produced for the same rows: the text of a path the screen already
 * draws must not move because the code that writes it did. */
{
  const a = app(null);
  const small = [80000, 80100, 79900, 80300, 80250, 80400].map((c, i) => ({ t: 1700000000 + i * 300, c }));
  const chart = a.buildChart(small, 'last 24 hours');
  check('six rows are drawn through the path they always were',
    chart.d === 'M-52.0 81.3 C-42.0 80.7,-14.1 79.2,8.0 78.0 C30.1 76.8,56.5 76.1,80.8 74.0 C105.1 71.9,129.3 69.7,153.6 65.5 '
      + 'C177.9 61.3,202.1 54.8,226.4 49.0 C250.7 43.2,274.9 36.3,299.2 30.5 C323.5 24.7,349.9 19.0,372.0 14.0 '
      + 'C394.1 9.0,422.0 2.7,432.0 0.4', chart.d);
  check('and the rest of what is said of them, the label and the last point, is as it was',
    chart.t === '+$ 400 last 24 hours' && chart.y === 14 && chart.pts.length === 6, chart.t + ' ' + chart.y);
  const many = [];
  for (let i = 0; i < 288; i++) many.push({ t: 1700000000 + i * 300, c: 80000 + 900 * Math.sin(i / 20) + i * 5 });
  const big = a.buildChart(many, 'last 24 hours');
  // the whole path of a day of rows, as the original wrote it, by its hash
  const sha = require('crypto').createHash('sha256').update(big.d).digest('hex');
  check('and a day of them is drawn through the one it was',
    sha === '6c31ad1f1358fca7f541b8fb225bbb8c7825984f6b177e34274ac26bf80b3df2' && big.t === '+$ 2,315 last 24 hours',
    big.d.length + ' characters, ' + big.t);
}

/* ---- one line turning into another ------------------------------------------
 *
 * The price line a launch with no route draws is the one kept from last time,
 * and the fresh one replaces it when a connection is up (`chartMorph`). The
 * arithmetic of that: heights mixed by position, and the ends exact. */
{
  const rowsOf = (n, f, from) => Array.from({ length: n }, (_, i) => ({ t: from + i * 300, c: f(i) }));
  const a = app(null);
  const old = a.buildChart(rowsOf(288, i => 80000 + 900 * Math.sin(i / 20) + i * 5, 1700000000), 'last 24 hours');
  /* The same market three hours on: it starts later, has a row fewer and is
   * another shape. Lined up first point to first point, across the same width. */
  const fresh = a.buildChart(rowsOf(287, i => 80500 + 1400 * Math.cos(i / 31) - i * 3, 1700000000 + 36 * 300), 'last 24 hours');
  check('a line keeps every point it is drawn through, the bleed at both ends included',
    old.ctl.length === 30 && fresh.ctl.length === 30, old.ctl.length + ' and ' + fresh.ctl.length);
  check('and turning into itself is the same line', a.chartBetween(old, old, 0.4).d === old.d, '');
  check('at the start it is the old line, to the digit', a.chartBetween(old, fresh, 0).d === old.d, '');
  const end = a.chartBetween(old, fresh, 1);
  check('at the end it is the new line, to the digit', end.d === fresh.d, end.d.slice(0, 60));
  check('and its points are the new line’s own',
    end.ctl.every((p, i) => p.x === fresh.ctl[i].x && p.y === fresh.ctl[i].y), '');
  const half = a.chartBetween(old, fresh, 0.5);
  check('halfway, each height is halfway between the two at the same place along the width',
    half.ctl.every((p, i) => Math.abs(p.y - (old.ctl[i].y + fresh.ctl[i].y) / 2) < 1e-9), '');
  check('and the points stay where they were across the width',
    half.ctl.every((p, i) => p.x === fresh.ctl[i].x), '');
  let monotone = true;
  for (let i = 0; i < old.ctl.length; i++) {
    let last = old.ctl[i].y;
    const dir = Math.sign(fresh.ctl[i].y - old.ctl[i].y);
    for (let u = 0.1; u <= 1.0001; u += 0.1) {
      const y = a.chartBetween(old, fresh, u).ctl[i].y;
      if ((y - last) * dir < -1e-9) monotone = false;
      last = y;
    }
  }
  check('every point goes from where it was to where it is going, and never back', monotone, '');

  // two short answers of different lengths: another number of points each
  const few = a.buildChart(rowsOf(6, i => 80000 + 300 * i, 1700000000), 'last hour');
  const more = a.buildChart(rowsOf(10, i => 80000 + 500 * Math.sin(i), 1700000000), 'last hour');
  let clean = true;
  for (let u = 0; u <= 1.0001; u += 0.125) {
    const between = a.chartBetween(few, more, u);
    if (/NaN|undefined|Infinity/.test(between.d) || between.ctl.length !== more.ctl.length) clean = false;
  }
  check('lines of different lengths turn into each other without a break in the path', clean, '');
  check('and still end on the new one, to the digit', a.chartBetween(few, more, 1).d === more.d, '');
  check('the wash under the line is closed the way the template closes it',
    a.chartFillPath('M0 0 C1 1,2 2,3 3') === 'M0 0 C1 1,2 2,3 3 L462 92 L-60 92 Z', '');
}

/* ---- he is carried by the line: the same place along it ----------------------
 *
 * While the fresh line takes the kept one's place, the rider is on whichever he
 * was on. He keeps his place along it — the same fraction of the way, not the
 * same pixels — and the line carries him; the ride goes on from there. */
const railB = x => 45 + 0.03 * x + 28 * Math.sin(x / 21);
// where a point stands along a track: the nearest place on its polyline, as a distance from its start
function standing(track, p) {
  let best = Infinity, at = 0;
  for (let i = 1; i < track.pts.length; i++) {
    const a = track.pts[i - 1], b = track.pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
    if (d < best) { best = d; at = a.s + (b.s - a.s) * u; }
  }
  return { at, off: best };
}
const placeOf = marker => ({ x: parseFloat(marker.style.left), y: parseFloat(marker.style.top) });
{
  const { marker, doc } = page();
  const pathEl = doc.querySelector('path');
  let rail = railY;
  pathEl.getPointAtLength = (at) => ({ x: at, y: rail(at) });
  const a = app(marker);
  frames = [];
  clock.now = 0;
  a.markerRoll();
  const t = pump(a, 0, 3200);
  const was = a.riderTrack(marker);
  const before = placeOf(marker);
  const stood = standing(was, before);
  check('at a good way along, he is on the line', stood.off < 0.5 && stood.at > 60 && stood.at < was.total - 60,
    'off by ' + stood.off.toFixed(2) + ', ' + stood.at.toFixed(0) + ' of ' + was.total.toFixed(0));

  rail = railB;
  a.riderRetrack();
  check('a ride that is out is asked to take the line again on its next frame', a._rideNew === true, String(a._rideNew));
  // the next frame, at the very moment of the last: nothing has moved on, so he is only carried
  const next = frames.pop();
  frames = [];
  clock.now = t;
  next(t);
  const now = a.riderTrack(marker);
  const after = placeOf(marker);
  const stands = standing(now, after);
  check('and it has: the request is answered', a._rideNew === false, String(a._rideNew));
  check('the new line is not the old one', Math.abs(now.total - was.total) > 5,
    now.total.toFixed(1) + ' against ' + was.total.toFixed(1));
  check('he is on the new line, not where the old one was',
    stands.off < 0.5, 'off the new line by ' + stands.off.toFixed(2) + 'px');
  check('at the same place along it: the same fraction of the way',
    Math.abs(stands.at / now.total - stood.at / was.total) < 0.002,
    (stands.at / now.total).toFixed(4) + ' against ' + (stood.at / was.total).toFixed(4));
  check('so he has moved, to stay where he was on the line',
    Math.hypot(after.x - before.x, after.y - before.y) > 3, 'moved ' + Math.hypot(after.x - before.x, after.y - before.y).toFixed(1) + 'px');

  // and the ride goes on from there, to the end it always had
  let ended = false;
  pump(a, t, a.RIDE_MS + 500, () => { if (!a._riding) ended = true; });
  check('and the ride goes on and ends as any ride does',
    ended && marker.style.visibility === 'hidden', marker.style.visibility);
}
{
  /* The line changing a little on every frame, thirty frames running, as the
   * change of one line into another asks for it: he never jumps, and ends where
   * the whole ride would have had him. */
  const { marker, doc } = page();
  const pathEl = doc.querySelector('path');
  let mix = 0;
  pathEl.getPointAtLength = (at) => ({ x: at, y: railY(at) * (1 - mix) + railB(at) * mix });
  const a = app(marker);
  frames = [];
  clock.now = 0;
  a.markerRoll();
  let t = pump(a, 0, 2400);
  let far = 0, last = placeOf(marker), fractions = [];
  for (let n = 1; n <= 30; n++) {
    const u = n / 30;
    mix = u * u * (3 - 2 * u);
    a.riderRetrack();
    t = pump(a, t, 16);
    const p = placeOf(marker);
    far = Math.max(far, Math.hypot(p.x - last.x, p.y - last.y));
    last = p;
    const track = a.riderTrack(marker);
    fractions.push(standing(track, p).at / track.total);
  }
  check('a line that changes on every frame does not throw him about: no frame moves him far',
    far < 14, 'the biggest step was ' + far.toFixed(1) + 'px');
  const rose = fractions.every((f, i) => i === 0 || f >= fractions[i - 1] - 0.002);
  check('and all the way through he is going forward along it', rose,
    fractions.map(f => f.toFixed(3)).join(' '));
  let ended = false;
  pump(a, t, a.RIDE_MS + 500, () => { if (!a._riding) ended = true; });
  check('and the ride then finishes', ended, 'still riding');
}
{
  // a ride that is not out has nothing to carry
  const { marker } = page();
  const a = app(marker);
  a.riderRetrack();
  check('a rider who is put away is not asked for anything', !a._rideNew, String(a._rideNew));
}

/* The place on a new track, for each of the three stretches of a ride. */
{
  const a = app(null);
  const was = { total: 400 }, now = { total: 500 };
  const lead = a.RIDE_IN_PX;
  check('still coming in, he is the same way behind the first point',
    a.riderCarried(was, now, 20) === 20 && a.riderCarried(was, now, 0) === 0, '');
  check('on the line, he is the same fraction of the way along it',
    Math.abs(a.riderCarried(was, now, lead + 100) - (lead + 125)) < 1e-9, String(a.riderCarried(was, now, lead + 100)));
  check('and leaving, the same way past the last point',
    Math.abs(a.riderCarried(was, now, lead + 400 + 30) - (lead + 500 + 30)) < 1e-9, String(a.riderCarried(was, now, lead + 430)));
  check('with no jump where one stretch becomes the next',
    a.riderCarried(was, now, lead) === lead && Math.abs(a.riderCarried(was, now, lead + 400) - (lead + 500)) < 1e-9, '');

  // the ride's clock is the gravity warp read backwards
  const { marker } = page();
  const b = app(marker);
  const track = b.riderTrack(marker);
  let exact = true;
  for (let raw = 0; raw <= 1.0001; raw += 0.05) {
    let i = 1;
    while (i < track.warp.length && track.warp[i].t < raw) i++;
    const lo = track.warp[i - 1], hi = track.warp[i] || lo;
    const along = lo.s + (hi.s - lo.s) * ((raw - lo.t) / ((hi.t - lo.t) || 1));
    if (Math.abs(b.riderClock(track, along) - Math.min(raw, 1)) > 1e-9) exact = false;
  }
  check('the clock at a place is the place’s own time through the warp, and back', exact, '');
}

/* ---- and nothing else about the ride is disturbed ---------------------------- */
{
  /* The drawing runs on a clock of its own. The ride's was moved to put him
   * on the new line, and the drawing's frame at a given moment must not move
   * with it, or the sled would stutter every time the price line changed. */
  const frameAt = (retrack) => {
    const { marker, body, doc } = page();
    const pathEl = doc.querySelector('path');
    let rail = railY;
    pathEl.getPointAtLength = (at) => ({ x: at, y: rail(at) });
    const a = app(marker);
    frames = [];
    clock.now = 0;
    a.markerRoll();
    const t = pump(a, 0, 3000);
    if (retrack) { rail = railB; a.riderRetrack(); }
    pump(a, t, 16);
    return body.style.backgroundPosition;
  };
  check('the sled’s frame at a moment is the same whether the line changed under him or not',
    frameAt(false) === frameAt(true), frameAt(false) + ' against ' + frameAt(true));
}
{
  /* The renderer writes the marker's resting place when the line's last point
   * changes. While he is out that would be a frame with him in the wrong place. */
  const { marker } = page();
  const a = app(marker);
  frames = [];
  clock.now = 0;
  a.markerRoll();
  pump(a, 0, 1500);
  const placed = marker.style.top;
  marker.style.top = '41.3%';
  a.markerStayPut();
  check('the place the ride gave him is put back over the renderer’s', marker.style.top === placed,
    marker.style.top + ' against ' + placed);
  a.markerGone();
  marker.style.top = '41.3%';
  a.markerStayPut();
  check('and a rider who is put away is left alone', marker.style.top === '41.3%', marker.style.top);
}

results.forEach(r => console.log(r));
const failed = results.filter(r => r.startsWith('FAIL')).length;
if (failed) { console.log('\n' + failed + ' rider line check(s) failed'); process.exit(1); }
console.log('\nall ' + results.length + ' rider line checks pass');
