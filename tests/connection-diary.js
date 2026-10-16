'use strict';
/* connection-diary.js — the LOGS screen's CONNECTION view, and the request
 * mark only a test mint is sent.
 *
 *     node tests/connection-diary.js
 *
 * The phone writes one field log line per mint request, one per change of
 * network and one as Foxy is put away (Foxy/Debug/NetDiary.swift, held to
 * its shapes by FoxyTests/NetDiaryTests.swift). This is the page's half:
 *
 *   A. the request mark: none to any host unless FoxyWallet.requestIdHosts
 *      names it; to a host it names, sixteen hex characters, new for every
 *      request, a request asked again included; a debug build's launch
 *      argument reaches the list (window.__foxyRequestIdHosts)
 *   B. the page's ask-again lines reach the field log: the console mirror
 *      posts them to the phone, Release's silenced console.log included
 *   C. CONNECTION shows the diary's lines and only those, newest first; COPY
 *      copies exactly what is shown; ALL and ERRORS are as they were; a view
 *      overtaken by a tap on another never lands on top of it
 *   D. none of it starts a timer
 */
const fs = require('fs');
const path = require('path');
const { loadReal } = require('./harness');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX16 = /^[0-9a-f]{16}$/;

/* ---- A. the request mark ------------------------------------------------ */

/* A page whose phone answers every mint request at once, and writes down
 * what each request message carried. `say(m, n)` answers the n-th instead. */
function page(before) {
  const sent = [];
  let say = null;
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action !== 'mintRequest') return setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'not in this test'), 0);
      sent.push(m);
      const answer = say ? say(m, sent.length) : '200\n{}';
      if (answer === 'hang') return;
      setTimeout(() => w.FoxyWallet._scanResult(m.id, answer, null), 0);
    },
    before,
  });
  ctx.sent = sent;
  ctx.say = (f) => { say = f; };
  return ctx;
}
const ask = (c, url, method) => c.W.nativeRequest({ endpoint: url, method: method || 'GET', foxyFresh: true }).catch((e) => e);

async function partA() {
  {
    const c = page();
    ok(Array.isArray(c.W.requestIdHosts) && c.W.requestIdHosts.length === 0, 'A1 requestIdHosts is empty at launch',
      JSON.stringify(c.W.requestIdHosts));
    await ask(c, 'https://mint.example/v1/info');
    await ask(c, 'https://testmint.example/v1/keysets');
    ok(c.sent.length === 2 && c.sent.every((m) => !('requestId' in m)),
      'A2 with nothing listed, no request carries a mark, not even an empty one',
      c.sent.map((m) => Object.keys(m).join(',')).join(' | '));
  }
  {
    const c = page();
    c.W.requestIdHosts = ['TestMint.Example'];
    await ask(c, 'https://mint.minibits.cash/Bitcoin/v1/info');
    await ask(c, 'https://testmint.example.evil/v1/info');
    await ask(c, 'https://sub.testmint.example/v1/info');
    ok(c.sent.length === 3 && c.sent.every((m) => !('requestId' in m)),
      'A3 a host not on the list gets no mark, a look-alike or a subdomain included',
      c.sent.map((m) => m.url + ' ' + ('requestId' in m)).join(' | '));

    c.sent.length = 0;
    for (let i = 0; i < 5; i++) await ask(c, 'https://testmint.example/v1/info');
    await ask(c, 'https://testmint.example/v1/swap', 'POST');
    const marks = c.sent.map((m) => m.requestId);
    ok(marks.length === 6 && marks.every((x) => HEX16.test(String(x))),
      'A4 to a listed host every request carries sixteen lowercase hex characters', marks.join(' '));
    ok(new Set(marks).size === marks.length, 'A5 and a new one every time', new Set(marks).size + ' of ' + marks.length);
    const keys = new Set(c.sent.flatMap((m) => Object.keys(m)));
    ok(['action', 'id', 'url', 'method', 'headers', 'circuit', 'body', 'requestId'].every((k) => keys.has(k)) && keys.size === 8,
      'A6 the mark is one field more, and nothing else about the request changed', [...keys].join(','));
  }
  {
    // a request turned away (429) is asked again on another circuit: that ask is a request of its own
    const c = page();
    c.W.requestIdHosts = ['testmint.example'];
    c.say((m, n) => (n === 1 ? '429\nslow down' : '200\n{}'));
    await ask(c, 'https://testmint.example/v1/info');
    ok(c.sent.length === 2 && HEX16.test(c.sent[0].requestId) && HEX16.test(c.sent[1].requestId)
      && c.sent[0].requestId !== c.sent[1].requestId,
    'A7 a request asked again carries a new mark of its own', c.sent.map((m) => m.requestId).join(' '));
  }
  {
    // a port on the list is matched with the port; a bare name matches the host at any port
    const c = page();
    c.W.requestIdHosts = ['testmint.example:3338', 'other.test'];
    await ask(c, 'https://testmint.example:3338/v1/info');
    await ask(c, 'https://testmint.example/v1/info');
    await ask(c, 'https://other.test:8443/v1/info');
    ok(HEX16.test(c.sent[0].requestId) && !('requestId' in c.sent[1]) && HEX16.test(c.sent[2].requestId),
      'A8 a listed port is the host at that port', c.sent.map((m) => m.url + ' ' + (m.requestId || '-')).join(' | '));
  }
  {
    // the debug build's launch argument, as FoxyWebView hands it to the page
    const c = page((w) => { w.__foxyRequestIdHosts = ['testmint.example']; });
    ok(JSON.stringify(c.W.requestIdHosts) === '["testmint.example"]', 'A9 the launch argument fills the list',
      JSON.stringify(c.W.requestIdHosts));
    await ask(c, 'https://testmint.example/v1/info');
    ok(HEX16.test(String(c.sent[0] && c.sent[0].requestId)), 'A10 and the listed host is sent a mark');
  }
}

/* ---- the app's own methods, taken from build/foxy-app.js ----------------- */

const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
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
const SIGS = ['mirrorConsole() {', '_installMirror() {', 'goFieldLog(onlyBad) {', 'flShow(view) {', 'flIsDiary(text) {',
  'loadFieldLog(view) {', 'flStamp(at) {', 'flText() {', 'copyFieldLog() {', 'renderFieldLog(c) {'];
const METHODS = new Function('CTA_INK', 'return {' + SIGS.map(method).join(',\n') + '}')(() => '#fff');

function app(lines) {
  const a = Object.assign({
    state: { screen: 'home', stack: [] },
    copied: [],
    toasts: [],
    setState(u) { this.state = Object.assign({}, this.state, typeof u === 'function' ? u(this.state) : u); },
    copySecret(t) { this.copied.push(t); return true; },
    toast(t) { this.toasts.push(t); },
    back() {},
    shareFieldLog() {},
    clearFieldLog() {},
  }, METHODS);
  global.window = {
    FoxyWallet: {
      fieldLog: (onlyBad) => Promise.resolve(onlyBad ? lines.filter((l) => l.bad) : lines.slice()),
    },
  };
  return a;
}
const vals = (a) => a.renderFieldLog({ s: a.state, sc: 'fieldLog' });

/* ---- B. the ask-again lines reach the field log ------------------------- */

function partB() {
  const posted = [];
  const realLog = console.log, realWarn = console.warn, realError = console.error;
  global.window = { webkit: { messageHandlers: { foxy: { postMessage: (m) => posted.push(m) } } } };
  // as a Release build's page starts: console.log is a no-op before any script of ours runs (FoxyWebView)
  console.log = function () {};
  try {
    const a = Object.assign({}, METHODS);
    a.mirrorConsole();
    console.log('[foxy] ' + 'mint.example/v1/mint/quote/bolt11' + ' has not answered in 5s; asking again on another circuit');
    console.log('[foxy] the mint’s proof check has not answered in 6s; asking again on another circuit');
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realError;
  }
  const texts = posted.filter((m) => m.action === 'log').map((m) => m.text);
  ok(texts.length === 2 && texts.every((t) => /asking again on another circuit$/.test(t)),
    'B1 the ask-again lines are posted to the phone (handleLog → print → FieldLog), a silenced console.log included',
    texts.join(' | '));
  const a = app([]);
  ok(texts.every((t) => a.flIsDiary(t)), 'B2 and, as they arrive there, CONNECTION shows them');
}

/* ---- C. the CONNECTION view --------------------------------------------- */

const LOG = [
  { at: 1000, text: '[foxy] Foxy 1.0 (20) on iOS 18.0', bad: false },
  { at: 2000, text: 'last run · [foxy] tor: bootstrapped 45% (requesting_descriptors) - Asking for relay descriptors', bad: false },
  { at: 3000, text: '[foxy] network: wifi, constrained (Low Data Mode)', bad: false },
  { at: 4000, text: '[foxy] net: GET mint.example/Bitcoin/v1/info · circuit 3fa9c1 · 812 ms · 200', bad: false },
  { at: 5000, text: '[foxy-js] +2210ms [log] [foxy] screen home -> receive (back stack 1)', bad: false },
  { at: 6000, text: '[foxy-js] +3001ms [log] [foxy] mint.example/v1/mint/quote/bolt11 has not answered in 5s; asking again on another circuit', bad: false },
  { at: 7000, text: '[foxy] net: POST mint.example/v1/swap · circuit 77aa01 · 20013 ms · failed: timeout [-1001] · tor up', bad: true },
  { at: 8000, text: '[foxy-js] +4100ms [error] [foxy] could not read the pile', bad: true },
  { at: 9000, text: '[foxy] app: in the background', bad: false },
  { at: 10000, text: '[foxy-js] +9100ms [log] [foxy] wake: 12s in the background', bad: false },
  { at: 11000, text: '[tap] something at -61 dBm', bad: false },
  { at: 12000, text: '[foxy] mint request to mint.example never left (the proxy refused the stream); asking again', bad: false },
  // one refusal as Foxy is put away: Route.start's line, then the request's own
  { at: 13000, text: '[foxy] route: a request to mint.example not sent; Foxy is being put away', bad: false },
  { at: 14000, text: '[foxy] net: POST mint.example/v1/swap · circuit 77aa01 · 0 ms · not sent (Foxy put away)', bad: false },
];
const DIARY_AT = [2000, 3000, 4000, 6000, 7000, 9000, 10000, 12000, 14000];

async function partC() {
  const a = app(LOG);
  a.goFieldLog(false);
  await pause(0);
  let v = vals(a);
  ok(v.flTitle === 'LOGS' && a.state.flLines.length === LOG.length && v.flCopyLabel === 'COPY ALL',
    'C1 LOGS opens on everything, as it did', v.flTitle + ' ' + a.state.flLines.length);
  ok(v.flAllBg === 'var(--acc)' && v.flNetBg === 'transparent' && v.flBadBg === 'transparent',
    'C2 and the row under the title says ALL');

  v.flShowNet();
  ok(a.state.flLines === null && vals(a).flSub === 'Reading…', 'C3 CONNECTION reads the lines again');
  await pause(0);
  v = vals(a);
  const shown = a.state.flLines.map((l) => l.at);
  ok(v.flTitle === 'CONNECTION' && v.flNetBg === 'var(--acc)' && v.flAllBg === 'transparent',
    'C4 CONNECTION is the title and the lit pill', v.flTitle);
  ok(JSON.stringify(shown) === JSON.stringify(DIARY_AT.slice().reverse()),
    'C5 only the diary\'s lines, newest first: requests, ask-agains, network, background and return, Tor, last run\'s too',
    shown.join(','));
  ok(v.flRows.length === DIARY_AT.length && v.flRows[0].text.indexOf('not sent (Foxy put away)') >= 0
    && v.flRows[1].text.indexOf('never left') >= 0,
    'C6 the rows drawn are those lines', v.flRows.length + ' rows');
  ok(v.flRows.filter((r) => r.text.indexOf('not sent') >= 0).length === 1,
    'C6b a request refused as Foxy is put away is one line there, not two',
    v.flRows.filter((r) => r.text.indexOf('not sent') >= 0).length + ' lines');

  v.flCopy();
  const text = a.copied[a.copied.length - 1] || '';
  const body = text.split('\n\n')[1] || '';
  ok(/^Foxy connection diary, 9 lines, newest first\./.test(text), 'C7 COPY says what it copied', text.split('\n')[0]);
  ok(body.trim().split('\n').length === DIARY_AT.length
    && LOG.every((l) => (body.indexOf(l.text) >= 0) === DIARY_AT.includes(l.at)),
  'C8 and copies exactly the lines shown, and none of the others');
  ok(vals(a).flCopyLabel === 'COPIED', 'C9 the button says it was copied');

  v = vals(a);
  v.flShowBad();
  await pause(0);
  v = vals(a);
  ok(v.flTitle === 'ERRORS' && a.state.flLines.map((l) => l.at).join(',') === '8000,7000' && v.flCopyLabel === 'COPY',
    'C10 ERRORS is the short list, as it was', a.state.flLines.map((l) => l.at).join(','));

  // overtaken: CONNECTION then ALL at once, the first answer arriving last
  const slow = app(LOG);
  let hold = null;
  global.window.FoxyWallet.fieldLog = (onlyBad) => (hold === null
    ? new Promise((r) => { hold = () => r(LOG.slice()); })
    : Promise.resolve(LOG.slice()));
  slow.state = { screen: 'fieldLog', stack: ['home'], flView: 'all', flLines: LOG.slice().reverse() };
  slow.flShow('net');
  slow.flShow('all');
  await pause(0);
  hold();
  await pause(0);
  ok(slow.state.flView === 'all' && slow.state.flLines.length === LOG.length,
    'C11 a view overtaken by another tap does not land on top of it', slow.state.flView + ' ' + slow.state.flLines.length);

  const empty = app([{ at: 1, text: '[foxy] screen home -> history', bad: false }]);
  empty.state = { screen: 'fieldLog', stack: ['home'], flView: 'all', flLines: [] };
  empty.flShow('net');
  await pause(0);
  ok(vals(empty).flSub === 'No connection lines yet.', 'C12 an empty diary says so', vals(empty).flSub);
}

/* ---- D. no timers --------------------------------------------------------- */

async function partD() {
  let made = 0;
  const set = global.setTimeout, every = global.setInterval;
  const a = app(LOG);
  global.setTimeout = function () { made += 1; return set.apply(this, arguments); };
  global.setInterval = function () { made += 1; return every.apply(this, arguments); };
  try {
    a.goFieldLog(false);
    a.flShow('net');
    a.flShow('bad');
    vals(a);
  } finally {
    global.setTimeout = set; global.setInterval = every;
  }
  await pause(0);
  ok(made === 0, 'D1 opening the screen and switching views starts no timer', made + ' started');
}

(async () => {
  await partA();
  partB();
  await partC();
  await partD();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
