'use strict';
/* card-headers.js — one header on every screen with a round back button, and the welcome's card that turns.
 *
 *     node tests/card-headers.js
 *
 * SET AMOUNT's header is the pattern: the title in the top row, in line with the round button, then the divider, then the
 * subtitle under it. The card's set-up screens (NAME CARD, the PIN pad, CARD LIMITS, RESTORE CARD, MAX PER SECOND) and the app's
 * other screens that drew the title under the buttons, then the subtitle, then the divider, all draw it so now. NAME CARD has no
 * CARD NAME label over its field. The welcome reads WELCOME TO YOUR FOXY CARD, and its card stands on a turntable: it turns
 * by itself, a finger turns it, and where less motion is asked for it turns only by hand.
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

// one screen's block: from its <sc-if> to the </sc-if> that closes it at the start of a line
const block = (cond) => {
  const at = markup.indexOf('<sc-if value="{{ ' + cond + ' }}">\n');
  if (at < 0) return '';
  const end = markup.indexOf('\n</sc-if>', at);
  return markup.slice(at, end < 0 ? markup.length : end);
};
const TITLE_IN_ROW = 'flex:1;min-width:0;font-size:22px;font-weight:800;letter-spacing:-0.022em';
const RULE = 'height:1px;background:rgba(var(--ink-rgb),.1);margin:16px ';
const SUB = 'padding:14px ';

/* ---- every screen with a back button and a title and subtitle: title in the row, divider, subtitle ---------------------------- */
const SCREENS = [
  ['isFcName', '{{ fnTitle }}', 'What should we call this card?'],
  ['isFcPanel', 'CARD LIMITS', 'Which limit do you want to change?'],
  ['isFcRestore', 'RESTORE CARD', 'You can reclaim the money on a card once it is unlocked.'],
  ['isFcSpeed', 'MAX PER SECOND', 'How fast should your card pay?'],
  ['isContacts', 'CONTACTS', 'Tap anyone to pay them.'],
  ['isSendType', 'SELECT RECIPIENT', 'Who to send money to?'],
  ['isBankAsk', '{{ bkTitle }}', '{{ bkQuestion }}'],
  ['spIsWays', 'SPLIT THE CHECK', 'How many ways including yourself?'],
  ['spIsAmount', 'SPLIT THE CHECK', 'What is the total bill?'],
  ['spIsAssign', '{{ spPayerTitle }}', 'Who is paying this share?'],
  ['noteOpen', 'ADD A NOTE', 'What is this payment for?'],
];
/* Each screen's block parsed as a page would hold it: the row the title sits in is exactly [round button | title | round button or
 * the 52-wide filler that balances it] (an <sc-if> around a button counts as the button); the divider and the subtitle under it sit
 * 24 points in from the screen's edges, as SET AMOUNT's do, with no padded column around them. */
const parse = (html) => {
  const d = new JSDOM('<body>' + html.replace(/^<sc-if[^>]*>\n/, '') + '</body>').window.document;
  return d.body;
};
const flat = (el) => Array.from(el.children).flatMap((k) => (k.tagName === 'SC-IF' ? Array.from(k.children) : [k]));
const isButton = (el) => !!el && el.hasAttribute('sc-camel-on-click') && el.style.width === '52px';
const isFiller = (el) => !!el && !el.hasAttribute('sc-camel-on-click') && el.style.width === '52px' && el.children.length === 0;
const sideInset = (el) => {
  const pad = (n) => (parseFloat(n.style.paddingLeft) || 0);
  let sum = 0;
  for (let n = el.parentNode; n && n.tagName !== 'BODY'; n = n.parentNode) if (n.style) sum += pad(n);
  return sum;
};
for (const [cond, title, sub] of SCREENS) {
  const b = block(cond);
  const root = parse(b);
  const t = Array.from(root.querySelectorAll('div')).find((d) => d.textContent === title && d.children.length === 0 && (d.getAttribute('style') || '').indexOf(TITLE_IN_ROW) === 0);
  const row = t ? flat(t.parentNode) : [];
  ok(!!t && row.length === 3 && isButton(row[0]) && row[1] === t && (isButton(row[2]) || isFiller(row[2])),
     cond + ': ' + title + ' sits in the top row, in line with the round back button, and the row is button | title | button or filler',
     t ? row.map((k) => (k === t ? 'TITLE' : isButton(k) ? 'button' : isFiller(k) ? 'filler' : (k.getAttribute('style') || '').slice(0, 30))).join(' | ') : 'no title in a row');
  const rule = Array.from(root.querySelectorAll('div')).find((d) => d.style.height === '1px' && d.style.marginTop === '16px');
  const subEl = Array.from(root.querySelectorAll('div')).find((d) => d.textContent === sub && d.children.length === 0);
  const after = (x, y) => !!(x && y && (x.compareDocumentPosition(y) & 4));
  ok(after(t, rule) && after(rule, subEl), cond + ': then the divider, then the subtitle under it');
  ok(!!rule && !!subEl && rule.style.marginLeft === '24px' && rule.style.marginRight === '24px' && subEl.style.paddingLeft === '24px' && subEl.style.paddingRight === '24px'
     && subEl.style.paddingTop === '14px' && subEl.style.paddingBottom === '8px' && sideInset(rule) === 0 && sideInset(subEl) === 0,
     cond + ': the divider and the subtitle 24 in from the edges, as SET AMOUNT’s', rule && subEl ? [rule.style.margin, subEl.style.padding, sideInset(rule)].join(' / ') : 'missing');
  ok(!/<div style="margin-top:0"><div style="font-size:22px/.test(b) && !/padding:3px (0|24px) 16px;font-size:22px/.test(b),
     cond + ': no title under the buttons, no subtitle over a divider');
}
// SET AMOUNT, the pattern, is as it was
{
  const b = block('isAmount');
  ok(b.indexOf('{{ amountTitle }}') < b.indexOf('margin:16px 24px 0') && b.indexOf('margin:16px 24px 0') < b.indexOf('{{ amountSubtitle }}'), 'SET AMOUNT: the pattern, title, divider, subtitle');
}

/* ---- NAME CARD: no CARD NAME label; the field keeps its placeholder ----------------------------------------------------------- */
{
  const b = block('isFcName');
  ok(b.length > 0 && b.indexOf('>CARD NAME<') < 0, 'NAME CARD: the CARD NAME label over the field is gone');
  ok(b.indexOf('placeholder="My card"') >= 0, 'and the field still says My card until a name is typed');
}

/* ---- the PIN pad a card's screens ask with: the same header; the lock's is its own -------------------------------------------- */
{
  const dom = new JSDOM('<body></body>');
  global.window = dom.window;
  global.document = dom.window.document;
  const methods = new Function('return {' + lift(part('10-pin.js'), 'pinOverlay(opts) {') + '}')();
  const app = Object.assign({ haptic() {} }, methods);
  const root = app.pinOverlay({ title: 'CREATE A PIN', subtitle: '4 to 8 digits', cta: 'NEXT', gate: true, back: () => {}, onSubmit() {} });
  const kids = Array.from(root.children);
  const backBtn = root.querySelector('[data-pin-back]');
  const titleEl = kids.find((d) => d.textContent === 'CREATE A PIN');
  const at = (txt) => kids.findIndex((d) => d.textContent === txt);
  const rule = kids.findIndex((d) => d.style.height === '1px');
  const dots = kids.findIndex((d) => /gap: 14px/.test(d.getAttribute('style') || '') || d.style.gap === '14px');
  ok(!!titleEl && titleEl.style.minHeight === '52px' && root.style.paddingTop === '56px' && !!backBtn && backBtn.style.top === '56px',
     'a card’s PIN pad: the title in the top row, at least 52 high from 56 down (two lines if it wraps), in line with the round back button', JSON.stringify([titleEl && titleEl.style.minHeight, root.style.paddingTop]));
  ok(at('CREATE A PIN') === 0 && rule === 1 && at('4 to 8 digits') === 2 && dots === 3,
     'then the divider, then the subtitle, and the dots under the subtitle as they were', JSON.stringify([at('CREATE A PIN'), rule, at('4 to 8 digits'), dots]));
  const subEl = kids[at('4 to 8 digits')];
  ok(!!subEl && subEl.style.fontSize === '22px' && subEl.style.padding === '14px 0px 8px', 'the subtitle as SET AMOUNT’s: 22 points, 14 above and 8 under', subEl && subEl.getAttribute('style'));
  app.pinDismiss = () => { root.remove(); };
  root.remove();
  const lock = app.pinOverlay({ title: 'FOXY IS LOCKED', subtitle: 'Enter your PIN.', cta: 'UNLOCK', onSubmit() {} });
  ok(lock.children[0].textContent === 'FOXY IS LOCKED' && lock.children[1].textContent === 'Enter your PIN.' && !Array.from(lock.children).some((d) => d.style.height === '1px'),
     'the lock’s pad, which has no back button, keeps its own header');
  lock.remove();
}

/* ---- the welcome: its title, and the card on its turntable -------------------------------------------------------------------- */
{
  const b = block('isFcPanel');
  ok(b.indexOf('>WELCOME TO<br>YOUR FOXY CARD</div>') >= 0, 'the welcome reads WELCOME TO YOUR FOXY CARD');
  const old = [];
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir)).forEach((f) => {
    const p = path.join(dir, f);
    if (p === path.join('tests', 'snapshots')) return;
    if (fs.statSync(path.join(ROOT, p)).isDirectory()) { walk(p); return; }
    if (/\.(js|md|html)$/.test(f) && /YOUR\s+CASHU\s+CARD/.test(read(p))) old.push(p);
  });
  ['build/app', 'build/wallet', 'docs', 'tests'].forEach(walk);
  if (/YOUR\s+CASHU\s+CARD/.test(markup)) old.push('build/markup.html');
  ok(old.length === 0, 'and the old words are nowhere: not in the code, its comments, the tests or the docs', old.join(', '));

  const stageAt = b.indexOf('data-card-stage="{{ fpSpin }}"');
  const spinAt = b.indexOf('data-card-spin', stageAt);
  const portAt = b.indexOf('data-card-portrait', spinAt);
  const backAt = b.indexOf('data-card-back', portAt);
  ok(stageAt >= 0 && /perspective:\{\{ fpPersp \}\}/.test(b.slice(stageAt, spinAt)) && /transform-style:preserve-3d/.test(b.slice(spinAt, portAt)),
     'the card’s picture stands in a stage with perspective, on a turntable that keeps its faces in 3D');
  const backDiv = backAt >= 0 ? b.slice(backAt, b.indexOf('>', backAt)) : '';
  ok(portAt > spinAt && backAt > portAt && /rotateY\(180deg\)/.test(backDiv) && /backface-visibility:hidden/.test(backDiv),
     'two faces on it: the card’s own picture, and a back turned away from it that hides when it faces away', backDiv.slice(0, 160));
  ok(/\[data-card-stage="1"\] \[data-card-portrait\]\{backface-visibility:hidden/.test(markup) && /\[data-card-stage="1"\]\{touch-action:none/.test(markup),
     'the front hides its back side on the turntable, and the stage takes the finger’s drag for itself');
  ok(/<sc-if value="\{\{ fpWelcome \}\}"><div data-card-back/.test(b), 'the back is drawn on the welcome only');

  // the values: a turntable on the welcome only
  const wheel = part('26j-card-wheel.js');
  const sigs = ['renderCardScreens(c) {', 'fcWelcomeCard(s) {', 'fcSpinOn() {', 'fcSpinLive() {', 'fcSpinSync(drawn) {', 'fcSpinPark() {', 'fcSpinUnpark() {',
    'fcSpinStageUp() {', 'fcSpinOverStage() {'];
  const src = sigs.map((sig) => lift(wheel, sig)).filter(Boolean).join(',\n');
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  let reduce = false;
  dom.window.matchMedia = () => ({ matches: reduce });
  const app = Object.assign(new Function('return {' + src + '}')(), {
    FC_SPIN: { auto: 24, perPx: 0.57, keep: 0.94, rest: 1600, gone: 60 }, FC_SETUP_DESIGN: '001', FC_SPEED_CHIPS: [1, 2, 5],
    fcDesignOf: () => '001', fcLimitRows: () => [], fcLostRows: () => [], back() {}, state: {},
  });
  const vals = (sc, s) => app.renderCardScreens({ s, sc });
  const w = vals('fcWelcome', { fcWelcome: { sats: 1 } });
  const l = vals('fcLimits', { fc: { key: 'k' } });
  ok(w.fpSpin === '1' && l.fpSpin === '' && w.fpPersp !== 'none' && l.fpPersp === 'none', 'the turntable on the welcome only; CARD LIMITS’ picture stands still', JSON.stringify([w.fpSpin, l.fpSpin, w.fpPersp, l.fpPersp]));
  ok(typeof app.fcSpinOn === 'function', 'and the welcome starts its turning when it is drawn');

  // the markup of the welcome in a page, and a finger on it
  const html = b.replace(/<\/?sc-if[^>]*>/g, '').replace(/\{\{ fpSpin \}\}/g, '1').replace(/\{\{ fpPersp \}\}/g, '1100px').replace(/\{\{ fpCardH \}\}/g, '300px').replace(/\{\{[^}]*\}\}/g, '');
  document.body.innerHTML = html;
  const spin = document.querySelector('[data-card-stage="1"] [data-card-spin]');
  const portrait = document.querySelector('[data-card-portrait]');
  const angle = () => { const m = /rotateY\((-?[\d.]+)deg\)/.exec((spin && spin.style.transform) || ''); return m ? Number(m[1]) : NaN; };
  const fire = (el, type, x, id) => { const e = new dom.window.Event(type, { bubbles: true, cancelable: true }); e.clientX = x; e.pointerId = id === undefined ? 1 : id; el.dispatchEvent(e); };
  // the listeners the turntable puts on the page, counted: they must all come off when it stops
  let on = 0;
  const add = document.addEventListener.bind(document), rem = document.removeEventListener.bind(document);
  document.addEventListener = (k, f, o) => { on += 1; add(k, f, o); };
  document.removeEventListener = (k, f, o) => { on -= 1; rem(k, f, o); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    if (!spin || !portrait || typeof app.fcSpinOn !== 'function') {
      ok(false, 'the welcome’s card can be turned by a finger', 'no turntable in the markup, or nothing to turn it');
      ok(false, 'and it turns by itself, slowly, when it is not held');
      ok(false, 'where less motion is asked for it never turns by itself, and a finger still turns it');
    } else {
      app.FC_SPIN.rest = 0;
      // (the welcome is the screen: the turntable runs only while its screen is up, 26j-card-wheel.js `fcSpinLive`)
      app.state = { screen: 'fcWelcome' };
      app.fcSpinOn();
      await wait(80);
      const a0 = angle();
      ok(a0 > 0, 'it turns by itself, slowly, when it is not held', String(a0));
      fire(portrait, 'pointerdown', 100);
      const a1 = angle();
      fire(document, 'pointermove', 200);
      const a2 = angle();
      ok(Math.abs(a2 - a1 - 57) < 0.6, 'a finger dragged across it turns it by hand: 100 points, 57 degrees', JSON.stringify([a1, a2]));
      fire(portrait, 'pointerdown', 300, 2);
      fire(document, 'pointermove', 500, 2);
      ok(Math.abs(angle() - a2) < 1e-9, 'a second finger is not heard while the first holds it: the card does not jump', JSON.stringify([a2, angle()]));
      fire(document, 'pointerup', 500, 2);
      await wait(80);
      ok(Math.abs(angle() - a2) < 1e-9, 'and while it is held it does not turn by itself', JSON.stringify([a2, angle()]));
      fire(document, 'pointerup', 200);
      // (the screen left: the loop stops and the angle is forgotten, so the next start is face on)
      app.fcSpinSync(false);
      // less motion
      reduce = true;
      spin.style.transform = '';
      const before = on;
      app.fcSpinOn();
      const started = on - before;
      await wait(80);
      const r0 = angle();
      ok(!(r0 > 0.5 || r0 < -0.5), 'where less motion is asked for it never turns by itself', String(r0));
      fire(portrait, 'pointerdown', 50);
      fire(document, 'pointermove', 10);
      const r1 = angle();
      fire(document, 'pointerup', 10);
      await wait(80);
      ok(Math.abs(r1 + 22.8) < 0.6 && Math.abs(angle() - r1) < 1e-9, 'and a finger still turns it, with nothing carried on after it lets go', JSON.stringify([r1, angle()]));
      // the welcome goes: the loop stops by itself, its listeners come off, and nothing is left running
      app.FC_SPIN.gone = 5;
      document.body.innerHTML = '';
      await wait(400);
      ok(app._fcSpin === null && started === 8 && on === before, 'once the welcome is gone the turning stops by itself, and every listener it put on the page comes off', JSON.stringify([app._fcSpin === null, started, before, on]));

      // the card screen's swipe home does not start on the turning card (26f-flashcard.js, `fcSwipeFrom`)
      const swipeFrom = new Function('return {' + lift(part('26f-flashcard.js'), 'fcSwipeFrom(target) {') + '}')();
      document.body.innerHTML = html;
      const onCard = document.querySelector('[data-card-portrait] [data-card-picture]') || document.querySelector('[data-card-portrait]');
      const offCard = Array.from(document.querySelectorAll('div')).find((d) => d.textContent === 'SET UP CARD');
      ok(typeof swipeFrom.fcSwipeFrom === 'function' && swipeFrom.fcSwipeFrom(onCard) === false && swipeFrom.fcSwipeFrom(offCard) === true,
         'a finger that starts on the turning card is never the card screen’s swipe home; one that starts beside it still is');
      document.body.innerHTML = '';
    }
    console.log('\n' + (failed ? failed + ' failed' : 'all card header checks pass'));
    process.exit(failed ? 1 : 0);
  })();
}
