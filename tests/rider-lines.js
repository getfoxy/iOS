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
  'riderTrack(el) {', 'riderLines(el) {', 'riderLine(stk, x, y, len, angle, op, life) {',
  'riderLinesOff() {', 'riderFade(lines, dt) {', 'riderAir(lines, bag, cx, cy, ang, speed, dt) {',
  'riderImpact(lines, cx, cy) {', 'markerGone() {', 'buildChart(rows, label) {',
  'riderCovered() {', 'riderWhenSeen() {', 'riderShow() {',
  'markerRoll() {', 'sledLayout(body) {', 'sledFrame(body, fr) {',
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

results.forEach(r => console.log(r));
const failed = results.filter(r => r.startsWith('FAIL')).length;
if (failed) { console.log('\n' + failed + ' rider line check(s) failed'); process.exit(1); }
console.log('\nall ' + results.length + ' rider line checks pass');
