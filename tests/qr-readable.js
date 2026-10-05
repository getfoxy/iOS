'use strict';
/* qr-readable.js — every code Foxy draws survives the badge drawn on top of it.
 *
 *     node tests/qr-readable.js
 *
 * There is a logo in the middle of every QR box, and it is opaque. A reader
 * therefore gets a code with a hole in it, and whether that code still decodes
 * is arithmetic, not luck: the error correction level says what fraction of the
 * codewords may be lost, and the badge's size against the module count says
 * what fraction is being lost.
 *
 * Nobody had done that arithmetic. The badge was 84 points across a 240 point
 * box and took 12 to 16 per cent of the modules; a single invoice is written at
 * 'M' and could afford it, a bare address at 'M' could not, and the animated
 * frames were written at 'L' — 7 per cent — and could never be read at all.
 * Which is exactly what was seen on two phones: Lightning codes read where
 * Cashu and on-chain ones did not, and on one of them no code read at all.
 *
 * The margin here is half the nominal budget. A blot in one place is worse than
 * scattered damage of the same size, because it wipes out whole codewords in a
 * few blocks while the rest of the code loses nothing, and the spec's figure
 * assumes the damage is spread. Half is the usual working rule for a code with
 * something printed on it.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

global.window = {};
new Function('window', fs.readFileSync(path.join(root, 'Web', 'qrcode.js'), 'utf8') +
  '\n;window.qrcode = (typeof qrcode !== "undefined") ? qrcode : window.qrcode;')(global.window);
const qrcode = global.window.qrcode;

const app = fs.readFileSync(path.join(root, 'build', 'foxy-app.js'), 'utf8');
const badge = (() => {
  const m = /QR_BADGE = ([\d.]+) \/ ([\d.]+);/.exec(app);
  if (!m) throw new Error('QR_BADGE is not in the app');
  return Number(m[1]) / Number(m[2]);
})();
const frameEcc = (/TOKEN_QR = \{[^}]*ecc: '(\w)'/.exec(app) || [])[1];
const fragment = Number((/TOKEN_QR = \{[^}]*fragment: (\d+)/.exec(app) || [])[1]);

/* What the wallet itself would try, in its own order (20-helpers.js). */
const LEVELS = ['M', 'L'];
const BUDGET = { L: 7, M: 15, Q: 25, H: 30 };

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

/* The modules the badge hides, as a percentage of all of them. The badge is
 * centred on the whole box, quiet zone included, which is how it is drawn. */
function hidden(text, ecc) {
  const raw = /^(ln(bc|tb|bcrt)|lnurl1|ur:)/i.test(text) ? text.toUpperCase() : text;
  let q = null;
  for (const level of (ecc ? [ecc] : LEVELS)) {
    try { const t = qrcode(0, level); t.addData(raw); t.make(); q = t; ecc = level; break; }
    catch (e) { q = null; }
  }
  if (!q) return null;
  const n = q.getModuleCount(), quiet = 4, size = n + quiet * 2;
  const r = badge / 2 * size, mid = size / 2;
  let covered = 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const y = row + quiet + 0.5, x = col + quiet + 0.5;
      if ((x - mid) ** 2 + (y - mid) ** 2 <= r * r) covered++;
    }
  }
  return { ecc, modules: n, pct: covered / (n * n) * 100, pt: 240 / size };
}

/* One of each rail, shaped like the real thing. */
const RAILS = {
  'a Lightning invoice': 'lnbc5u1p5xyzabcpp5' + 'q'.repeat(80) + 'sp5' + 'r'.repeat(60) + '9qyyssq' + 'z'.repeat(100),
  'a bare address': 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  'an address with an amount': 'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.00060000',
  'a Cashu request': 'creqApWF0gaNhdGVub3N0cmFheKlucHViMXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxYWloYWlkeCRhMWIyYzNkNC1lNWY2LTQ3ODgtOTlhYS1iYmNjZGRlZWZmMDBhYWFhYWFhbWh0dHBzOi8vbWludC5taW5pYml0cy5jYXNoL0JpdGNvaW5hdWNzYXQ=',
  'a short token': 'cashuBo2FteCJodHRwczovL21pbnQubWluaWJpdHMuY2FzaC9CaXRjb2luYXVjc2F0YXSBomFpSAD_' + 'x'.repeat(120),
};

console.log('qr-readable — the badge hides ' + (badge * 100).toFixed(1) + '% of the width of the box\n');
for (const [name, text] of Object.entries(RAILS)) {
  const h = hidden(text);
  if (!h) { check(name + ' fits in a code', false, text.length + ' chars fit at no level'); continue; }
  const margin = BUDGET[h.ecc] / 2;
  check(name + ' survives the badge',
    h.pct <= margin,
    'ecc ' + h.ecc + ', ' + h.modules + ' modules, badge hides ' +
    h.pct.toFixed(1) + '% of ' + BUDGET[h.ecc] + '% (safe under ' + margin + '%)');
}

/* And the animated frames, which are what a long token and a dense request
 * both become. */
const frame = 'UR:BYTES/145-3/' + 'LQAHRPHDSSFDGDIHFHWZAOFTAYFWBTDSTBSAKKCAFEDMOEGTBDBWFEHTIYEEBWAXCPNYGWFEHDGEDPCPEOFYFPGYPY'.repeat(3).slice(0, fragment - 15);
const f = hidden(frame, frameEcc);
check('an animated frame survives the badge',
  !!f && f.pct <= BUDGET[frameEcc] / 2,
  f ? 'ecc ' + frameEcc + ', ' + f.modules + ' modules, badge hides ' + f.pct.toFixed(1) +
      '% of ' + BUDGET[frameEcc] + '%' : 'it does not fit');

/* Module size is the other half of it: correction does not help a camera that
 * cannot see the modules in the first place. */
for (const [name, text] of Object.entries(RAILS)) {
  const h = hidden(text);
  if (h) check(name + ' is drawn large enough to see', h.pt >= 3,
    h.pt.toFixed(2) + ' points per module (3 is the floor)');
}
if (f) check('an animated frame is drawn large enough to see', f.pt >= 3,
  f.pt.toFixed(2) + ' points per module');

/* Nothing may be drawn on a code that moves, and the rings did. */
const markup = fs.readFileSync(path.join(root, 'build', 'markup.html'), 'utf8');
check('nothing sweeps across a code', !/qrRing/.test(markup),
  'the expanding rings are gone');

console.log('\n  ' + R.pass + ' passed, ' + R.fail + ' failed');
process.exit(R.fail ? 1 : 0);
