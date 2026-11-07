'use strict';
/* card-spin.js — the card's picture on its own screen turns, as the welcome's does.
 *
 *     node tests/card-spin.js
 *
 * The card's screen (26f-flashcard.js, `renderFlashcard`; build/markup.html, `isFlashcard`) stands its picture on the welcome's
 * turntable (26j-card-wheel.js, `fcSpinOn`): one helper for both screens. It turns by itself, a finger turns it, its back shows
 * when it faces away, and where less motion is asked for it turns only by hand. The loop runs only while the card is free to be
 * seen: the menu, a stage or sheet over it, a tap under way or Foxy put away stops it, and it goes on from where it stood once
 * that is gone; leaving the screen stops it for good, with every listener it put on the page taken off. A finger that starts on
 * the card is never the screen's swipe home (`fcSwipeFrom`).
 *
 * Read from the parts (build/markup.html, build/app/*.js), so it runs before a repack. FOXY_ROOT runs it against another tree. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = process.env.FOXY_ROOT || path.join(__dirname, '..');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail && !good ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const markup = read('build/markup.html');
const part = (f) => read(path.join('build', 'app', f));
const lift = (src, sig) => {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) return '';
  let i = src.indexOf('{', at + 3 + sig.length - 1), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 3, i + 1);
};

/* ---- the markup: the card screen's picture on a stage, with both faces ------------------------------------------------------ */
const from = markup.indexOf('<sc-if value="{{ isFlashcard }}">\n');
const b = from < 0 ? '' : markup.slice(from, markup.indexOf('\n</sc-if>', from));
const stageAt = b.indexOf('data-card-stage="{{ fcSpin }}"');
const spinAt = b.indexOf('data-card-spin', stageAt);
const portAt = b.indexOf('data-card-portrait', spinAt);
const backAt = b.indexOf('data-card-back', portAt);
const stageTag = stageAt >= 0 ? b.slice(stageAt, b.indexOf('>', stageAt)) : '';
ok(stageAt >= 0 && /perspective:\{\{ fcPersp \}\}/.test(stageTag) && /transform-style:preserve-3d/.test(b.slice(spinAt, portAt)) && portAt > spinAt,
   'the card screen’s picture stands in a stage with perspective, on a turntable that keeps its faces in 3D');
const backDiv = backAt >= 0 ? b.slice(backAt, b.indexOf('>', backAt)) : '';
ok(backAt > portAt && /rotateY\(180deg\)/.test(backDiv) && /backface-visibility:hidden/.test(backDiv)
   && /<sc-if value="\{\{ fcSpin \}\}"><div data-card-back/.test(b),
   'two faces on it: the card’s own picture, and the welcome’s dark back turned away from it, drawn only where it turns');
const CH = '--ch:max(160px,min(calc(100cqh - {{ fcCardCap }}),440px,calc(100cqw * 85.6 / 54)))';
const portTag = portAt >= 0 ? b.slice(portAt, b.indexOf('>', portAt)) : '';
ok(portTag.indexOf(CH + ';flex:none;position:relative;height:var(--ch)') >= 0 && stageTag.indexOf(CH) >= 0,
   'the picture keeps its size and place: the same height, the two-balance screen’s smaller one too, and the stage the size of the card', portTag.slice(0, 160));
ok(!/sc-camel-on-click/.test(stageTag) && !/sc-camel-on-click/.test(b.slice(stageAt, backAt)),
   'a touch on the card opens nothing, as before: a drag on it is only a turn');
// one turntable for the two screens
const appSrc = fs.readdirSync(path.join(ROOT, 'build', 'app')).filter((f) => /\.js$/.test(f)).map((f) => part(f));
ok(appSrc.filter((s) => s.indexOf('\n  fcSpinOn() {') >= 0).length === 1 && appSrc.filter((s) => /rotateY\(/.test(s)).length === 1,
   'one turntable for both screens: one `fcSpinOn`, and nothing else in the app turns a card');
const flash = part('26f-flashcard.js');
const render = lift(flash, 'renderFlashcard(c) {');
ok(/fcSpin: on && !\(this\.fcWelcomeCard/.test(render) && /fcPersp: on \?/.test(render),
   'the card’s screen draws its turntable, and not while the welcome is drawn over it (whose own card turns)');
ok(/const free = \(\) => \{[^\n]*this\.fcSpinOn\(\)/.test(lift(flash, 'fcTap(o, fn) {')),
   'a tap’s end lets the card turn on, if nothing else is up');

/* ---- the turntable on the card's screen, driven ----------------------------------------------------------------------------- */
const wheel = part('26j-card-wheel.js');
const sigs = ['renderCardScreens(c) {', 'fcWelcomeCard(s) {', 'fcSpinOn() {', 'fcSpinLive() {', 'fcSpinSync(drawn) {', 'fcSpinPark() {', 'fcSpinUnpark() {'];
const family = lift(part('26h-tap-screen.js'), 'fcFamilyBuild(kind) {');
const src = sigs.map((sig) => lift(wheel, sig)).filter(Boolean).concat([lift(flash, 'cardTapOver() {'), lift(flash, 'fcSwipeFrom(target) {'), family]).filter(Boolean).join(',\n');
const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
let reduce = false;
let hidden = false;
dom.window.matchMedia = () => ({ matches: reduce });
Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden });
let app = null;
try {
  app = Object.assign(new Function('return {' + src + '}')(), {
    FC_SPIN: { auto: 24, perPx: 0.57, keep: 0.94, rest: 0, gone: 60 }, FC_SETUP_DESIGN: 'FX1', FC_SPEED_CHIPS: [1, 2, 5],
    fcDesignOf: () => 'FX1', fcLimitRows: () => [], fcLostRows: () => [], back() {}, cardFlowBusy: () => false,
    hideStage() { const o = document.getElementById('foxy-stage'); if (o) o.remove(); },
    state: { screen: 'flashcard', fc: { key: 'k', setUp: true } },
  });
} catch (e) { app = null; }
const html = b.replace(/<\/?sc-(if|for)[^>]*>/g, '').replace(/\{\{ fcSpin \}\}/g, '1').replace(/\{\{ fcPersp \}\}/g, '1100px')
  .replace(/\{\{ fcCardCap \}\}/g, '0px').replace(/\{\{[^}]*\}\}/g, '');
document.body.innerHTML = '<div id="dc-root">' + html + '</div>';
const spin = document.querySelector('[data-card-stage="1"] [data-card-spin]');
const portrait = document.querySelector('[data-card-stage="1"] [data-card-portrait]');
const angle = () => { const m = /rotateY\((-?[\d.]+)deg\)/.exec((spin && spin.style.transform) || ''); return m ? Number(m[1]) : NaN; };
const fire = (el, type, x, id) => { const e = new dom.window.Event(type, { bubbles: true, cancelable: true }); e.clientX = x; e.pointerId = id === undefined ? 1 : id; el.dispatchEvent(e); };
// the listeners the turntable puts on the page, counted (the page's own, such as a picture's load, are not): they must all come off
let on = 0;
const ours = (k) => /^(pointer|touch|visibilitychange)/.test(String(k));
const add = document.addEventListener.bind(document), rem = document.removeEventListener.bind(document);
document.addEventListener = (k, f, o) => { if (ours(k)) on += 1; add(k, f, o); };
document.removeEventListener = (k, f, o) => { if (ours(k)) on -= 1; rem(k, f, o); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const drawn = () => app.renderCardScreens({ s: app.state, sc: app.state.screen });

(async () => {
  if (!app || !spin || !portrait || typeof app.fcSpinSync !== 'function') {
    ok(false, 'the card on the card’s screen turns by itself, slowly, when it is not held', 'no turntable on the card’s screen, or nothing to run it');
  } else {
    const before = on;
    drawn();
    await wait(80);
    const a0 = angle();
    ok(!!app._fcSpin && a0 > 0, 'the card on the card’s screen turns by itself, slowly, when it is not held, started by the screen being drawn', String(a0));
    fire(portrait, 'pointerdown', 100);
    const a1 = angle();
    fire(document, 'pointermove', 200);
    ok(Math.abs(angle() - a1 - 57) < 0.6, 'a finger dragged across it turns it by hand: 100 points, 57 degrees', JSON.stringify([a1, angle()]));
    fire(document, 'pointerup', 200);

    // the menu over it: the loop ends, its touches come off, and the card stands where it was
    app.state.open0 = true;
    await wait(60);
    const m0 = angle();
    await wait(80);
    ok(app._fcSpin === null && on - before === 1 && angle() === m0,
       'the ≡ menu over the card stops it: no loop runs under the menu, and only the wait for Foxy coming back is left on the page', JSON.stringify([app._fcSpin === null, on - before, m0, angle()]));
    app.state.open0 = false;
    drawn();
    await wait(80);
    ok(!!app._fcSpin && angle() > m0 && angle() - m0 < 20, 'the menu closed, it turns on from where it stood', JSON.stringify([m0, angle()]));

    // a stage over it (a sheet, a card, a pad: a fixed element on the page), and gone again, with no new draw of the screen
    const st = document.createElement('div');
    st.id = 'foxy-stage';
    st.style.position = 'fixed';
    document.body.appendChild(st);
    await wait(60);
    const s0 = angle();
    await wait(80);
    ok(app._fcSpin === null && angle() === s0, 'a stage that comes up over it stops it', JSON.stringify([app._fcSpin === null, s0, angle()]));
    st.remove();
    await wait(80);
    ok(!!app._fcSpin && angle() > s0, 'and when it goes, the card turns on by itself', JSON.stringify([s0, angle()]));

    // the card tap's own screens (1a to 1g, 26h-tap-screen.js `fcFamilyBuild`), each a stage of its own, stop it the same way
    let fam = null;
    try { fam = typeof app.fcFamilyBuild === 'function' ? app.fcFamilyBuild('card') : null; } catch (e) { fam = null; }
    await wait(60);
    const f0 = angle();
    await wait(80);
    ok(!!fam && fam.parentNode === document.body && app._fcSpin === null && angle() === f0,
       'a card tap’s screen (TAP TO PAY, RECEIVING, CARD LOST and the rest) over it stops it', JSON.stringify([!!fam, app._fcSpin === null, f0, angle()]));
    if (fam) fam.remove();
    await wait(80);
    ok(!!app._fcSpin && angle() > f0, 'and when the tap’s screen goes, the card turns on by itself', JSON.stringify([f0, angle()]));

    // the phone's NFC sheet: a tap under way
    app._fcTaps = 1;
    await wait(60);
    const t0 = angle();
    await wait(80);
    ok(app._fcSpin === null && angle() === t0, 'a tap under way (the phone’s own sheet up) stops it', JSON.stringify([app._fcSpin === null, t0, angle()]));
    app._fcTaps = 0;
    app.fcSpinOn();
    await wait(80);
    ok(!!app._fcSpin && angle() > t0, 'and the tap over, it turns on', JSON.stringify([t0, angle()]));

    // Foxy put away and back
    hidden = true;
    await wait(60);
    const h0 = angle();
    ok(app._fcSpin === null, 'Foxy put away stops it');
    hidden = false;
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await wait(80);
    ok(!!app._fcSpin && angle() > h0, 'and Foxy back, it turns on', JSON.stringify([h0, angle()]));

    // less motion: no turn by itself, a finger still turns it
    reduce = true;
    await wait(60);
    const r0 = angle();
    await wait(100);
    const r1 = angle();
    fire(portrait, 'pointerdown', 50);
    fire(document, 'pointermove', 10);
    const r2 = angle();
    fire(document, 'pointerup', 10);
    await wait(80);
    ok(r1 === r0 && Math.abs(r2 - r1 + 22.8) < 0.6 && angle() === r2,
       'where less motion is asked for it never turns by itself, and a finger still turns it with nothing carried on', JSON.stringify([r0, r1, r2, angle()]));
    reduce = false;

    // a menu up while it is parked, then the screen left: nothing is left waiting or running
    app.state.open0 = true;
    await wait(60);
    app.state = { screen: 'home', open0: false };
    drawn();
    await wait(80);
    ok(app._fcSpin === null && !app._fcSpinWake && on === before && !(app._fcSpinA),
       'the screen left stops it for good: no loop, no wait, every listener it put on the page taken off, and the next visit starts face on',
       JSON.stringify([app._fcSpin === null, !app._fcSpinWake, on - before, app._fcSpinA]));
    document.body.appendChild(st);
    st.remove();
    await wait(60);
    ok(app._fcSpin === null, 'and a stage coming and going on another screen does not start it');

    // the swipe home does not start on the turning card, and still starts beside it
    const onCard = document.querySelector('[data-card-stage="1"] [data-card-picture]');
    const offCard = document.querySelector('[data-shield]');
    ok(app.fcSwipeFrom(onCard) === false && app.fcSwipeFrom(document.querySelector('[data-card-stage="1"] [data-card-back]')) === false && !!offCard && app.fcSwipeFrom(offCard) === true,
       'a finger that starts on the card screen’s turning card, either face, is never the swipe home; one that starts on the money card under it still is');
  }
  console.log('\n' + (failed ? failed + ' failed' : 'all card spin checks pass'));
  process.exit(failed ? 1 : 0);
})();
