'use strict';
/* receive-fits.js — the receive code gives way so the buttons keep their names.
 *
 *     node tests/receive-fits.js
 *
 * The receive screen stacks a QR code over a row of four buttons, and the two
 * of them together have to fit above SHARE. At a flat 300px they did not: on an
 * iPhone XS the circles were on screen and every label was off the bottom of it. The XS is the shortest phone Foxy will ever run on that
 * has a notch — iOS 17 needs an A12 — and the SE is shorter still.
 *
 * So the box is capped against the viewport's own height and may shrink below
 * even that under flex pressure. Two things have to hold for that to work, and
 * both are easy to undo by accident:
 *
 *   - the cap has to be there, and small enough to clear the row on an XS;
 *   - it has to survive into the snapshots, which is not free. The snapshot
 *     renderer drops any declaration it cannot parse, and `min()` is one of
 *     them: written `min(300px, 34vh)` the box reaches the snapshots with no
 *     width and no height at all, and every render test still passes while
 *     pinning nothing. That is why the cap is a max-width/max-height pair.
 *
 * This reads the shipped snapshots, so it fails whichever way it is broken.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'snapshots', 'render');
const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

/* The shortest screen that has to fit, in CSS pixels, and the room the row of
 * buttons needs under the code: a 60px circle, a 7px gap, its label, and the
 * margins around the row. Measured in a browser at 375x812 against the real
 * markup, the whole column clears SHARE with the cap at 34vh and does not at
 * 40vh, so 34 is the ceiling this pins rather than a number picked for luck. */
const SHORTEST = 812;
const MAX_VH = 34;

const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
/* The receive screen is the one whose QR sits above the NOTE/COPY/SCAN/TAP row;
 * the token and split screens draw their own codes and are sized separately. */
const boxes = [];
for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!/>NOTE</.test(html) || !/>SCAN</.test(html)) continue;
  const m = html.match(/style="([^"]*border-radius: 22px[^"]*)"/);
  if (!m) continue;
  if (!/margin-top: auto/.test(m[1])) continue;
  boxes.push({ f, style: m[1] });
}

check('receive snapshots found', boxes.length > 0, boxes.length + ' of ' + files.length);

const px = (style, prop) => {
  const m = style.match(new RegExp('(?:^|[; ])' + prop + ': *([0-9.]+)px'));
  return m ? parseFloat(m[1]) : null;
};
const vh = (style, prop) => {
  const m = style.match(new RegExp('(?:^|[; ])' + prop + ': *([0-9.]+)vh'));
  return m ? parseFloat(m[1]) : null;
};

let sized = 0, capped = 0, square = 0, shrinks = 0, fits = 0;
const bad = [];
for (const b of boxes) {
  const w = px(b.style, 'width'), h = px(b.style, 'height');
  const cw = vh(b.style, 'max-width'), ch = vh(b.style, 'max-height');
  /* A size that reached the snapshot at all. `min()` lands here as null, and
   * that is the whole point of looking. */
  if (w !== null && h !== null) sized++; else bad.push(b.f + ': no width/height');
  if (cw !== null && ch !== null) capped++; else bad.push(b.f + ': no vh cap');
  if (w !== null && h !== null && w === h && cw === ch) square++;
  else bad.push(b.f + ': not square (' + w + '/' + h + ', ' + cw + '/' + ch + ')');
  if (/flex: 0 1/.test(b.style) && /min-height: 0px/.test(b.style)) shrinks++;
  else bad.push(b.f + ': cannot shrink under pressure');
  if (ch !== null && ch <= MAX_VH && (ch / 100) * SHORTEST < w) fits++;
  else bad.push(b.f + ': cap ' + ch + 'vh does not shrink it on a ' + SHORTEST + 'px screen');
}

check('every receive QR has a width and a height in the snapshot', sized === boxes.length, sized + '/' + boxes.length);
check('every receive QR is capped against the viewport height', capped === boxes.length, capped + '/' + boxes.length);
check('every cap is square, so the code stays square', square === boxes.length, square + '/' + boxes.length);
check('every receive QR can shrink under flex pressure', shrinks === boxes.length, shrinks + '/' + boxes.length);
check('every cap actually bites on the shortest phone', fits === boxes.length,
  'cap <= ' + MAX_VH + 'vh, which is ' + Math.round(MAX_VH / 100 * SHORTEST) + 'px at ' + SHORTEST);

if (bad.length) console.log('\n  ' + bad.slice(0, 8).join('\n  '));
console.log('\n' + (R.fail ? 'FAILED ' + R.fail : 'PASSED ' + R.pass) + ' of ' + (R.pass + R.fail));
process.exit(R.fail ? 1 : 0);
