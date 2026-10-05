'use strict';
/* rider-tap.js — tapping the rider reaches the code that sends him off.
 *
 *     node tests/rider-tap.js
 *
 * rider-lines.js drives the motion with the methods lifted out of the app.
 * This asks the question those cannot: does a finger on the price panel get
 * there at all? The answer runs through the template's binding and the
 * renderer's handling of a camel-cased event attribute — and the panel is the
 * whole target, because between rides he is off the right of the screen and
 * there is nothing else to aim at.
 *
 * The page is mounted the way render-parity.js mounts it: the committed shell,
 * the real template, the real app class, React, and the shipped renderer.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8');
const unpack = (uuid) => fs.readFileSync(path.join(ROOT, assets.find((a) => a.uuid === uuid).file), 'utf8');

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
  const props = JSON.parse(v.replace(/&quot;/g, '"'));
  props.startStatic = { default: true };
  return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
});
const page = markup
  .replace(/<script src="64b433ba-[^"]*"><\/script>/, '')
  .replace(shell.marker, () => open + app + '</script>');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e).slice(0, 200)));
const dom = new JSDOM(page, {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://foxy.test/index.html', virtualConsole: vc,
});
const w = dom.window;
w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
w.HTMLCanvasElement.prototype.getContext = () => null;
w.scrollTo = () => {};
const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
run(unpack('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047'));                 // React
run(unpack('93c76fbd-259d-463c-a60d-5ed97ad7e690'));                 // ReactDOM
const dc = w.document.querySelector('script[type="text/x-dc"]');
run('window.__foxyComponentFactory = function (DCLogic, StreamableLogic, React) {\n' + dc.textContent
  + '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};');
// a handle on the instance, the way render-parity.js keeps one
run('(function(){var f=window.__foxyComponentFactory;window.__foxyComponentFactory=function(a,b,R){'
  + 'var C=f(a,b,R);return class extends C{constructor(p){super(p);window.__logic=this;}};};})();');
run(renderer);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* Until it is up, not for a fixed half second. The page has grown and the
   * machine is sometimes busy building the app beside this; at 500 ms flat
   * the suite failed with "no app instance" on a page that mounted at 600
   * (and it blocked a push). Eight seconds is the give-up. */
  for (let waited = 0; !w.__logic && waited < 8000; waited += 100) await wait(100);
  await wait(200);
  const logic = w.__logic;
  if (!logic) {
    console.log('FAIL  the page mounts  — no app instance; ' + (errors.join(' | ') || 'no errors reported'));
    process.exit(1);
  }
  /* The real markerSkate wants a drawn chart, which jsdom has no geometry for.
   * What is being asked here is whether the tap arrives, so it is counted. */
  let taps = 0;
  logic.markerRoll = function () { taps++; return true; };
  logic.setState({ screen: 'home', priceExpanded: true, livePrice: 81000 });
  await wait(200);

  const rider = w.document.querySelector('[data-rider="body"]');
  check('the rider is drawn on the home screen', !!rider, 'no [data-rider="body"] in the page');
  const marker = rider && rider.parentElement;
  const panel = marker && marker.parentElement;
  check('he takes no taps himself, so nothing under him is shadowed',
    !!marker && marker.style.pointerEvents === 'none', marker ? marker.style.pointerEvents : 'no marker');
  check('the emphasis lines have a layer beside him',
    !!w.document.querySelector('[data-rider="streaks"]'), 'no [data-rider="streaks"] in the page');

  /* Counted as a difference across the tap, not as a total: with no drawn
   * chart in jsdom the app itself keeps trying the ride on every update, which
   * is what a cold launch relies on. */
  const onTap = (what, el) => {
    const before = taps;
    if (el) el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    check(what, taps === before + 1, (taps - before) + ' rides came of it');
  };
  // the panel the line sits in is the target, wherever in it the finger lands
  onTap('a tap on the line runs the ride again', panel && panel.querySelector('svg'));
  onTap('and so does a tap on the empty part of its panel', panel);
  onTap('and a tap that lands on him mid-ride is the same tap', rider);

  check('the page raised nothing while doing it', errors.length === 0, errors.join(' | '));

  results.forEach((r) => console.log(r));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  if (failed) { console.log('\n' + failed + ' rider tap check(s) failed'); process.exit(1); }
  console.log('\nall ' + results.length + ' rider tap checks pass');
  process.exit(0);
})();
