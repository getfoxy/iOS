'use strict';
/* type-check-finds.js — what the app's type check found, kept fixed.
 *
 *     node tests/type-check-finds.js
 *
 * tests/types/tsconfig.app.json type-checks build/foxy-app.js. Its first run
 * found two things that behaved wrongly; the rest of what it
 * reported were names it had not been told about, or dead references.
 *
 *  - typeMint set input.autocorrect = 'off'. That property is a boolean, so where
 *    WebKit has it the string turned autocorrect on for a mint's address, and
 *    where it does not, the assignment did nothing. The attribute says off.
 *  - clGoRail called renderVals().pickWire(), which nothing defines, when a bank
 *    wire was the only way in: a TypeError out of a tap. That method is gone
 *    (finding 19) — with one wallet and one rail, the amount screen
 *    opens the Lightning invoice itself and there is no rail to pick — so what
 *    it was checked for cannot come back, and the check went with it.
 *
 * The method is lifted out of build/foxy-app.js, the way switch-guard.js
 * does it, and run against stand-ins. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  return block(at + 3);
}
const methods = new Function('return {' + ['typeMint() {'].map(method).join(',\n') + '}')();

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('ok    ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); }
}

// ---- typeMint: the address field -------------------------------------------
{
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'https://foxy.test/' });
  const w = dom.window;
  global.window = w;
  global.document = w.document;
  global.performance = w.performance;
  global.requestAnimationFrame = (f) => w.requestAnimationFrame(f);
  global.cancelAnimationFrame = (id) => w.cancelAnimationFrame(id);
  const app = Object.assign({ state: { switchBusy: false }, props: {}, setState() {}, justSwitch() {}, toast() {} }, methods);
  let threw = null;
  try { app.typeMint(); } catch (e) { threw = e; }
  const input = w.document.querySelector('input[type="url"]');
  check('typeMint opens its sheet', !threw && !!input, threw ? String(threw.stack || threw) : 'no url input on the page');
  check('the mint address field has autocorrect off, as an attribute',
    !!input && input.getAttribute('autocorrect') === 'off', input ? input.outerHTML : '');
  check('and no autocorrect property holding a string',
    !!input && typeof input.autocorrect !== 'string', input ? 'autocorrect = ' + JSON.stringify(input.autocorrect) : '');
}

console.log('');
console.log(failed ? failed + ' of ' + (passed + failed) + ' type-check finds regressed' : 'all ' + passed + ' type-check finds hold');
process.exit(failed ? 1 : 0);
