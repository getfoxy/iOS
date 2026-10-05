'use strict';
/* pin-pad.js — the PIN pad's keys: a touch anywhere in a key's cell counts,
 * counts once, and shows.
 *
 *     node tests/pin-pad.js
 *
 * pinOverlay from build/foxy-app.js, in jsdom. The keys were round buttons
 * with dead space between them that waited for a click: a thumb between two
 * keys pressed neither, and iOS gives a click only for a touch that barely
 * moves and ends alone, so a quick second key was a tap that did nothing. And
 * nothing on the key said it had been felt. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const start = src.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start + 3, i + 1);
}
const dom = new JSDOM('<body></body>');
global.window = dom.window;
global.document = dom.window.document;
const methods = new Function('return {' + method('pinOverlay(opts) {') + '}')();

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fire = (el, kind) => el.dispatchEvent(new dom.window.Event(kind, { bubbles: true }));

(async () => {
  const buzzed = [];
  const app = Object.assign({ haptic: (k) => buzzed.push(k) }, methods);
  let entered = null;
  app.pinOverlay({ title: 'ENTER YOUR PIN', cta: 'UNLOCK', onSubmit: (pin) => { entered = pin; } });
  const root = app._pinEl || document.body.lastElementChild;
  const pad = Array.from(root.children).find((d) => d.style.display === 'grid');
  ok(!!pad && pad.children.length === 12, 'twelve cells: the digits, an empty corner and the delete key', pad ? String(pad.children.length) : 'no pad');
  const cell = (label) => Array.from(pad.children).find((c) => c.textContent === label);
  const face = (label) => cell(label).firstElementChild;
  const filled = () => Array.from(root.querySelectorAll('div'))
    .filter((d) => d.style.width === '14px' && /acc/.test(d.style.background)).length;

  // ---- the target is the cell, and the cells leave no dead space -----------
  ok(!pad.style.gap && Array.from(pad.children).every((c) => c.style.height === '80px'),
     'the cells meet edge to edge: nowhere between two keys presses neither', 'gap ' + (pad.style.gap || 'none'));
  ok(face('5').style.pointerEvents === 'none' && face('5').style.height === '66px',
     'the round key is only what is seen; the cell around it takes the touch');

  // ---- a touch counts the moment it lands, and once ------------------------
  fire(cell('5'), 'pointerdown');
  ok(filled() === 1 && buzzed.length === 1, 'a key takes the touch as it lands, without waiting for the finger to lift', filled() + ' dot(s)');
  ok(/acc/.test(face('5').style.background) && face('5').style.color === 'rgb(255, 255, 255)',
     'and turns orange while it is down', face('5').style.background);
  fire(cell('5'), 'pointerup');
  fire(cell('5'), 'click');
  ok(filled() === 1, 'the click that follows a touch is the same press, not a second one', filled() + ' dot(s)');
  await wait(200);
  ok(!/acc/.test(face('5').style.background), 'and the key goes back once it has been seen', face('5').style.background);

  // two keys quickly, the second landing before the first has lifted
  fire(cell('1'), 'pointerdown');
  fire(cell('2'), 'pointerdown');
  fire(cell('1'), 'pointerup');
  fire(cell('2'), 'pointerup');
  ok(filled() === 3, 'two keys pressed over each other are both taken', filled() + ' dot(s)');

  // ---- a click with no touch before it is a press too ----------------------
  fire(cell('0'), 'click');
  ok(filled() === 4, 'a click alone, where there is no touch to hear, still presses the key', filled() + ' dot(s)');

  // ---- delete, and the corner that is not a key -----------------------------
  fire(cell('⌫'), 'pointerdown');
  ok(filled() === 3 && /acc/.test(face('⌫').style.background), 'the delete key takes one off, and shows it was pressed');
  fire(cell('⌫'), 'pointerup');
  const corner = Array.from(pad.children).find((c) => c.textContent === '');
  fire(corner, 'pointerdown');
  fire(corner, 'click');
  ok(filled() === 3 && corner.firstElementChild.style.background === 'transparent', 'the empty corner does nothing and never lights');

  // ---- and what was typed is what is handed on ------------------------------
  fire(cell('7'), 'pointerdown');
  const cta = Array.from(root.children).find((d) => d.textContent === 'UNLOCK');
  fire(cta, 'click');
  await wait(20);
  ok(entered === '5127', 'the PIN handed on is the keys that were pressed, in order', String(entered));

  console.log(failed ? '\n' + failed + ' pin-pad check(s) failed' : '\nall pin-pad checks pass');
  process.exit(failed ? 1 : 0);
})();
