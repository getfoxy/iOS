#!/usr/bin/env node
'use strict';
// check-integration-vectors.js: the integration vectors kept beside this app, compared
// with this app's own copies.
//
//   FOXY_LIBS=/path/to/the/folder node tools/check-integration-vectors.js [manifest]
//
// The manifest (tools/integration-vectors.txt) has one pair a line:
//
//   app/path  lib/path  [mode]
//
// The first path is relative to the app's root, the second to $FOXY_LIBS. The mode is
//   (none)         the two files are byte for byte the same (sha256),
//   json           the two files hold the same JSON, keys sorted, white space ignored,
//   grep:REGEX     the same matches in both (group 1 when the pattern has one); the
//                  pattern may not hold a space, write \s; grep:HERE~THERE gives the
//                  two files a pattern each, for two languages,
//   block:START~END  one block of each file, byte for byte: the text from the first line
//                  matching START up to and including the first later line matching END
//                  (regexes, no space, write \s). For a file that holds an extract of the
//                  other, whose line numbers move; the rest of either file is not compared,
//   seal           the app's own cardSeal turns each recorded PIN into the recorded
//                  envelope (the file is a list of the inputs and what came out).
// A line that starts with # and a blank line are skipped.
//
// It prints one line a pair and a summary, and exits 1 on a difference, on a missing
// file or on a manifest it cannot read. With FOXY_LIBS unset or not a folder it says it
// is skipped and exits 0: whoever has no such folder has nothing to compare. A change to
// the card's or the tap's wire format changes these vectors, and the folder's copies are
// updated in the same change.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const manifest = process.argv[2] || path.join(__dirname, 'integration-vectors.txt');
const libs = process.env.FOXY_LIBS;
if (!libs || !fs.existsSync(libs) || !fs.statSync(libs).isDirectory()) {
  console.log('integration vectors: skipped (FOXY_LIBS unset)');
  process.exit(0);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v);
const matches = (text, re) => {
  const out = [];
  for (const m of text.matchAll(new RegExp(re, 'g'))) out.push(m.length > 1 ? m[1] : m[0]);
  return out;
};

// each returns '' when the pair agrees, else what differs
const modes = {
  bytes(a, l) {
    const x = sha(fs.readFileSync(a)), y = sha(fs.readFileSync(l));
    return x === y ? '' : 'sha256 ' + x.slice(0, 12) + ' here, ' + y.slice(0, 12) + ' there';
  },
  json(a, l) {
    const x = canon(JSON.parse(fs.readFileSync(a, 'utf8'))), y = canon(JSON.parse(fs.readFileSync(l, 'utf8')));
    return x === y ? '' : 'the JSON differs';
  },
  grep(a, l, re) {
    const [ra, rl] = re.split('~');
    const x = matches(fs.readFileSync(a, 'utf8'), ra), y = matches(fs.readFileSync(l, 'utf8'), rl || ra);
    if (!x.length) return 'the pattern matches nothing here';
    return JSON.stringify(x) === JSON.stringify(y) ? '' : 'here ' + JSON.stringify(x) + ', there ' + JSON.stringify(y);
  },
  block(a, l, re) {
    const [rs, re_] = re.split('~');
    const take = (file, side) => {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const i = lines.findIndex((x) => new RegExp(rs).test(x));
      if (i < 0) return { why: 'no line matches the start ' + rs + ' ' + side };
      const j = lines.findIndex((x, k) => k > i && new RegExp(re_).test(x));
      if (j < 0) return { why: 'no line after the start matches the end ' + re_ + ' ' + side };
      return { text: lines.slice(i, j + 1).join('\n') };
    };
    const x = take(a, 'here'), y = take(l, 'there');
    if (x.why || y.why) return x.why || y.why;
    return x.text === y.text ? '' : 'the block differs, sha256 ' + sha(x.text).slice(0, 12) + ' here, ' + sha(y.text).slice(0, 12) + ' there';
  },
  seal(a, l) {
    const { loadReal } = require(path.join(root, 'tests', 'harness'));
    const ctx = loadReal({});
    const W = ctx.W, bad = [];
    const rows = JSON.parse(fs.readFileSync(l, 'utf8'));
    rows.forEach((r, i) => {
      const clear = W.cardParse.pinBlock(Buffer.from(r.pin).toString('hex'));
      const env = W.cardParse.seal({ nonce: r.nonce, pub: r.pinPub }, r.ins, clear, ctx.window.Uint8Array.from(Buffer.from(r.eph, 'hex')));
      if (clear !== r.clear || env !== r.envelope) bad.push(i);
    });
    return bad.length ? 'row ' + bad.join(', ') + ' no longer comes out of the app' : '';
  },
};

let lines;
try { lines = fs.readFileSync(manifest, 'utf8').split('\n'); } catch (e) {
  console.log('integration vectors: cannot read ' + manifest);
  process.exit(1);
}
let total = 0, bad = 0;
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line[0] === '#') continue;
  const [app, lib, mode] = line.split(/\s+/);
  total++;
  const a = path.join(root, app), l = path.join(libs, lib);
  let why = '';
  if (!lib) why = 'a line with one path';
  else if (!fs.existsSync(a)) why = 'missing here: ' + app;
  else if (!fs.existsSync(l)) why = 'missing there: ' + lib;
  else {
    const m = mode || 'bytes';
    const name = m.startsWith('grep:') ? 'grep' : m.startsWith('block:') ? 'block' : m;
    if (!modes[name]) why = 'unknown mode ' + m;
    else {
      try { why = modes[name](a, l, m.slice(m.indexOf(':') + 1)); } catch (e) { why = 'could not compare: ' + (e && e.message || e); }
    }
  }
  if (why) { bad++; console.log('DIFFERS  ' + app + '  ' + lib + '  ' + why); }
  else console.log('same     ' + app + '  ' + lib);
}
console.log('integration vectors: ' + (bad ? bad + ' of ' + total + ' differ' : 'all ' + total + ' pairs agree'));
process.exit(bad ? 1 : 0);
