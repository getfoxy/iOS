'use strict';
/* render-parity.js — Foxy's renderer against the runtime it replaced.
 *
 *     node tests/render-parity.js
 *
 * The real template and app class, rendered in jsdom twice: once with
 * build/foxy-render.js, once with the design-tool runtime Foxy used to ship
 * (tests/reference/dc-runtime.js, kept only for this). Every screen the app's
 * bindings name, and every popup flag in its state, is rendered in both and
 * the DOM compared. Differences that carry no meaning are normalised away: the
 * old runtime's editor-only data-dc-tpl attributes, and style-active class
 * names, which are compared by the CSS they stand for.
 *
 * The app runs as a static preview (startStatic), with no wallet. */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// the page's pieces, from their committed sources (build/shell)
const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const RENDERERS = {
  old: fs.readFileSync(path.join(__dirname, 'reference', 'dc-runtime.js'), 'utf8'),
  new: fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8'),
};

// React and ReactDOM, the files the page's manifest packs
const unpack = (uuid) => {
  const e = assets.find((a) => a.uuid === uuid);
  return fs.readFileSync(path.join(ROOT, e.file), 'utf8');
};
const REACT = unpack('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047');
const REACT_DOM = unpack('93c76fbd-259d-463c-a60d-5ed97ad7e690');

// the page as packed, minus the runtime script tag, with the app as a static preview
const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
  const props = JSON.parse(v.replace(/&quot;/g, '"'));
  props.startStatic = { default: true };
  return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
});
const page = markup
  .replace(/<script src="64b433ba-[^"]*"><\/script>/, '')
  // a function, not a string: the app's source contains $& and $' sequences, which a
  // replacement string would treat as patterns (pack-index.py's Python replace does not)
  .replace(shell.marker, () => open + app + '</script>');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mount(which) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a) => errors.push(a.map(String).join(' ').slice(0, 200)));
  vc.on('jsdomError', (e) => errors.push('jsdom: ' + String(e && e.message).slice(0, 200)));
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://foxy.test/index.html', virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.scrollTo = () => {};
  const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
  run(REACT);
  run(REACT_DOM);
  const dc = w.document.querySelector('script[type="text/x-dc"]');
  run('window.__foxyComponentFactory = function (DCLogic, StreamableLogic, React) {\n' + dc.textContent
    + '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};');
  // keep a handle on the app instance, the same way under both renderers
  run('(function(){var f=window.__foxyComponentFactory;window.__foxyComponentFactory=function(a,b,R){'
    + 'var C=f(a,b,R);return class extends C{constructor(p){super(p);window.__logic=this;}};};})();');
  if (which === 'old') {
    // the old runtime's pressed styles with {{ bindings }}: inserted as raw text, and
    // the invalid declaration dropped. Their classes are compared as "bound", not by CSS.
    w.__boundPseudo = new Set();
    const insert = w.CSSStyleSheet.prototype.insertRule;
    w.CSSStyleSheet.prototype.insertRule = function (rule, index) {
      const m = /^\.(scp[0-9a-z]+):/.exec(rule);
      if (m && rule.includes('{{')) w.__boundPseudo.add(m[1]);
      return insert.call(this, rule, index);
    };
  }
  run(RENDERERS[which]);
  return { dom, w, errors };
}

function snapshot(w) {
  const root = w.document.getElementById('dc-root');
  if (!root) return '(no #dc-root)';
  const rules = {};
  for (const sheet of w.document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch (e) { continue; }
    for (const r of list) {
      const m = /^\.(sc[pd][0-9a-z]+):/.exec(r.selectorText || '');
      if (!m) continue;
      // a bound pressed style: fixed in the new renderer, broken in the old one — compared by kind
      rules[m[1]] = (m[1].startsWith('scd') || (w.__boundPseudo && w.__boundPseudo.has(m[1])))
        ? '{bound}' : r.cssText.replace(/^[^{]*/, '');
    }
  }
  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll('*')) {
    el.removeAttribute('data-dc-tpl');
    if (el.getAttribute('class')) {
      el.setAttribute('class', el.getAttribute('class').split(/\s+/).map((c) => (rules[c] ? 'pseudo' + rules[c] : c)).join(' '));
    }
  }
  return clone.outerHTML;
}

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return 'at ' + i + ':\n        old …' + a.slice(Math.max(0, i - 80), i + 80) + '…\n        new …' + b.slice(Math.max(0, i - 80), i + 80) + '…';
}

(async () => {
  // the template's structure, as the HTML parser builds it: nothing may fall
  // out of the themed wrapper (a stray </div> once put fourteen overlays there)
  {
    const probe = new JSDOM('<body></body>').window.document;
    const tpl = probe.createElement('template');
    const xdc = markup.slice(markup.indexOf('<x-dc>') + 6, markup.lastIndexOf('</x-dc>'))
      .replace(/<helmet(\s|>)/gi, '<sc-helmet$1').replace(/<\/helmet\s*>/gi, '</sc-helmet>');
    tpl.innerHTML = xdc;
    const appEl = tpl.content.querySelector('[data-foxy-app]');
    const kids = appEl ? [...appEl.children] : [];
    const themed = kids.length === 1 && kids[0].getAttribute('data-foxy-theme') === '{{ theme }}';
    const blocked = tpl.content.querySelector('sc-if[value="{{ isBlocked }}"]');
    const inside = !!(blocked && blocked.closest('[data-foxy-theme="{{ theme }}"]'));
    console.log((themed && inside ? 'ok    ' : 'FAIL  ') + 'every screen and overlay sits inside the themed wrapper'
      + (themed && inside ? '' : '\n      app wrapper children: ' + kids.map(k => k.localName + '[' + (k.getAttribute('value') || k.getAttribute('data-foxy-theme') || '') + ']').join(', ')));
    if (!(themed && inside)) process.exitCode = 1;
  }
  const pages = { old: mount('old'), new: mount('new') };
  // mounted, for up to ten seconds, then 600 ms to settle: a flat 600 ms was
  // enough on a Mac and not on GitHub's runner, where the new renderer had not
  // mounted yet and reported no error
  for (let t = 0; t < 100 && !(pages.old.w.__logic && pages.new.w.__logic); t++) await wait(100);
  await wait(600);
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  for (const k of ['old', 'new']) {
    if (!pages[k].w.__logic) check(k + ' renderer mounted the app', false, pages[k].errors.join(' | '));
  }
  if (!pages.old.w.__logic || !pages.new.w.__logic) {
    results.forEach((r) => console.log('FAIL  ' + r.name + '\n      ' + r.detail));
    process.exit(1);
  }

  const screens = [...new Set([...app.matchAll(/sc === '([A-Za-z0-9]+)'/g)].map((m) => m[1]))].sort();
  const initial = pages.old.w.__logic.state;
  const popups = Object.keys(initial).filter((k) => /Open$/.test(k) && typeof initial[k] === 'boolean').sort();

  const views = [['home (first render)', null]]
    .concat(screens.map((s) => ['screen ' + s, { screen: s, stack: [] }]))
    .concat(popups.map((p) => ['popup ' + p, { screen: 'home', stack: [], [p]: true }]))
    // the email button's pressed shadow is bound, and only there with an address the button accepts
    .concat([['screen sendType, a valid email typed', { screen: 'sendType', stack: [], emailDraft: 'someone@example.com' }]]);

  for (const [label, patch] of views) {
    for (const k of ['old', 'new']) {
      if (!patch) continue;
      // back to a clean slate, then the view: both instances get the same sequence
      try { pages[k].w.__logic.setState(Object.assign({}, initial, patch)); } catch (e) { pages[k].errors.push(String(e)); }
    }
    await wait(60);
    const a = snapshot(pages.old.w);
    const b = snapshot(pages.new.w);
    check(label, a === b, a === b ? '' : firstDifference(a, b));
  }

  // the fix itself: bound pressed styles become real rules under the new renderer
  const bound = [];
  for (const sheet of pages.new.w.document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch (e) { continue; }
    for (const r of list) if (/^\.scd[0-9a-z]+:active/.test(r.selectorText || '')) bound.push(r.cssText);
  }
  check('bound pressed styles are real rules under the new renderer (' + bound.length + ')',
    // the email button's and at least one other, and every one a real rule
    bound.length >= 2 && bound.every((t) => /box-shadow/.test(t) && !t.includes('{{')),
    JSON.stringify(bound.slice(0, 3)));

  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log('ok    ' + r.name);
    else { failed++; console.log('FAIL  ' + r.name + '\n      ' + r.detail); }
  }
  const newOnly = pages.new.errors.filter((e) => !pages.old.errors.includes(e));
  if (newOnly.length) {
    failed++;
    console.log('FAIL  errors under the new renderer only:\n      ' + newOnly.slice(0, 5).join('\n      '));
  }
  console.log('');
  console.log(failed ? failed + ' render parity check(s) failed of ' + results.length
    : 'all ' + results.length + ' views render the same DOM under both renderers');
  process.exit(failed || process.exitCode ? 1 : 0);
})();
