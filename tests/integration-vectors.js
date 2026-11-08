'use strict';
// tools/check-integration-vectors.js against a made-up folder of copies: the same copies
// pass, one byte changed fails and names the pair, a missing file fails, and with no folder
// it is skipped with exit 0. Also the json, grep and seal modes, each passing and failing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'tools', 'check-integration-vectors.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxy-iv-'));
let failed = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { failed++; console.log('FAIL ' + m); } };

const libs = path.join(tmp, 'libs');
fs.mkdirSync(libs);
const copy = (rel, to) => { const d = path.join(libs, to || rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(root, rel), d); return d; };
const run = (manifestLines, env) => {
  const m = path.join(tmp, 'manifest.txt');
  fs.writeFileSync(m, manifestLines.join('\n') + '\n');
  const e = Object.assign({}, process.env);
  delete e.FOXY_LIBS;
  Object.assign(e, env);
  const r = spawnSync('node', [script, m], { env: e, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
};

const a = 'tests/fixtures/flashcard-vectors.json';
const b = 'tests/fixtures/flashcard-vectors-4.json';
const t = 'Foxy/Bluetooth/TapCrypto.swift';
copy(a); copy(b); copy(t, 'TapCrypto.swift');
const pairs = [a + '  ' + a, b + '  ' + b];

// the same copies agree
let r = run(pairs, { FOXY_LIBS: libs });
ok(r.code === 0 && /all 2 pairs agree/.test(r.out) && (r.out.match(/^same /gm) || []).length === 2, 'matching copies pass: ' + r.out);

// one byte changed
const f = path.join(libs, b);
const bytes = fs.readFileSync(f); bytes[bytes.length >> 1] ^= 1; fs.writeFileSync(f, bytes);
r = run(pairs, { FOXY_LIBS: libs });
ok(r.code === 1 && /DIFFERS .*flashcard-vectors-4\.json/.test(r.out) && /1 of 2 differ/.test(r.out), 'one byte changed fails and names the pair: ' + r.out);
ok(/^same .*flashcard-vectors\.json/m.test(r.out), 'the pair that agrees is still said to');
copy(b);

// a missing file
fs.unlinkSync(path.join(libs, b));
r = run(pairs, { FOXY_LIBS: libs });
ok(r.code === 1 && /missing there: .*flashcard-vectors-4\.json/.test(r.out), 'a missing library file fails: ' + r.out);
copy(b);
r = run([pairs[0], 'tests/fixtures/no-such-file.json  x.json'], { FOXY_LIBS: libs });
ok(r.code === 1 && /missing here/.test(r.out), 'a missing app file fails');

// unset, and a folder that is not there
r = run(pairs, {});
ok(r.code === 0 && /integration vectors: skipped \(FOXY_LIBS unset\)/.test(r.out), 'unset is skipped with exit 0: ' + r.out);
r = run(pairs, { FOXY_LIBS: path.join(tmp, 'nowhere') });
ok(r.code === 0 && /skipped/.test(r.out), 'an absent folder is skipped');

// an unreadable manifest is an error, not a pass
r = spawnSync('node', [script, path.join(tmp, 'none.txt')], { env: Object.assign({}, process.env, { FOXY_LIBS: libs }), encoding: 'utf8' });
ok(r.status === 1, 'an unreadable manifest fails');

// json mode: a re-serialisation agrees, a changed value does not
const j = path.join(libs, 'reserialised.json');
fs.writeFileSync(j, JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, a), 'utf8')), null, 4));
r = run([a + '  reserialised.json  json'], { FOXY_LIBS: libs });
ok(r.code === 0, 'json mode accepts a re-serialisation: ' + r.out);
r = run([a + '  reserialised.json'], { FOXY_LIBS: libs });
ok(r.code === 1, 'bytes mode does not');
fs.writeFileSync(j, fs.readFileSync(j, 'utf8').replace(/[0-9a-f]/, (c) => (c === '0' ? '1' : '0')));
r = run([a + '  reserialised.json  json'], { FOXY_LIBS: libs });
ok(r.code === 1 && /DIFFERS/.test(r.out), 'json mode sees a changed value');

// grep mode, one pattern and a pattern a file
const ver = 'grep:version:\\sUInt8\\s=\\s(\\d+)';
r = run([t + '  TapCrypto.swift  ' + ver], { FOXY_LIBS: libs });
ok(r.code === 0, 'grep mode: the same constant agrees: ' + r.out);
const sw = path.join(libs, 'TapCrypto.swift');
fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/(version: UInt8 = )(\d+)/, (m0, p, d) => p + (Number(d) + 1)));
r = run([t + '  TapCrypto.swift  ' + ver], { FOXY_LIBS: libs });
ok(r.code === 1 && /DIFFERS/.test(r.out), 'grep mode: a changed wire version fails: ' + r.out);
fs.writeFileSync(path.join(libs, 'T.kt'), 'const val VERSION: Byte = 3\n');
const cur = /version: UInt8 = (\d+)/.exec(fs.readFileSync(path.join(root, t), 'utf8'))[1];
fs.writeFileSync(path.join(libs, 'T.kt'), 'const val VERSION: Byte = ' + cur + '\n');
r = run([t + '  T.kt  grep:version:\\sUInt8\\s=\\s(\\d+)~VERSION:\\sByte\\s=\\s(\\d+)'], { FOXY_LIBS: libs });
ok(r.code === 0, 'grep mode: a pattern for each language: ' + r.out);
r = run([t + '  T.kt  grep:nothing\\shere'], { FOXY_LIBS: libs });
ok(r.code === 1, 'grep mode: a pattern that matches nothing fails');

// seal mode: the app's own code reproduces the recorded envelopes, a changed one is caught
const seal = 'card-rust/tests/fixtures/seal/seal-vectors.json';
{
  const { loadReal } = require(path.join(root, 'tests', 'harness'));
  const ctx = loadReal({}), W = ctx.W, CT = ctx.window.CashuTS;
  const hex = (x) => Buffer.from(Array.from(x)).toString('hex');
  const pinPriv = '31'.repeat(32);
  const pub = hex(CT.getPubKeyFromPrivKey(Uint8Array.from(Buffer.from(pinPriv, 'hex'))));
  const rows = [['5678', '40', '09'.repeat(32), '22'.repeat(16)], ['0000', '41', '7f'.repeat(32), '00'.repeat(16)]].map(([pin, ins, eph, nonce]) => {
    const clear = W.cardParse.pinBlock(Buffer.from(pin).toString('hex'));
    const envelope = W.cardParse.seal({ nonce, pub }, ins, clear, ctx.window.Uint8Array.from(Buffer.from(eph, 'hex')));
    return { pinPriv, pinPub: pub, nonce, ins, pin, clear, eph, envelope };
  });
  const sf = path.join(libs, seal);
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  fs.writeFileSync(sf, JSON.stringify(rows));
  r = run(['build/wallet/08a-flashcard.js  ' + seal + '  seal'], { FOXY_LIBS: libs });
  ok(r.code === 0, 'seal mode: recorded envelopes come out of the app: ' + r.out);
  rows[1].envelope = rows[1].envelope.slice(0, -2) + (rows[1].envelope.slice(-2) === '00' ? '01' : '00');
  fs.writeFileSync(sf, JSON.stringify(rows));
  r = run(['build/wallet/08a-flashcard.js  ' + seal + '  seal'], { FOXY_LIBS: libs });
  ok(r.code === 1 && /row 1/.test(r.out), 'seal mode: a changed envelope names its row: ' + r.out);
}

// block mode: an extract whose lines have moved agrees, a changed line inside the block fails, a marker that is not there fails
{
  const mf = path.join(tmp, 'm.txt');
  const go = (line) => { fs.writeFileSync(mf, line + '\n'); const e = Object.assign({}, process.env, { FOXY_LIBS: libs }); const q = spawnSync('node', [script, mf], { env: e, encoding: 'utf8' }); return { code: q.status, out: q.stdout }; };
  const sm = fs.readFileSync(path.join(root, 'tests', 'harness.js'), 'utf8').split('\n');
  const i = sm.findIndex((x) => /^function fakeMint\(/.test(x));
  const j = sm.findIndex((x, k) => k > i && /^\}$/.test(x));
  const blockText = sm.slice(i, j + 1).join('\n');
  const fm = 'block:^function\\sfakeMint\\(~^\\}$';
  fs.writeFileSync(path.join(libs, 'extract.js'), '// header\n\n' + blockText + '\nmodule.exports = {};\n');
  r = go('tests/harness.js  extract.js  ' + fm);
  ok(r.code === 0 && /^same /m.test(r.out), 'block mode: an extract at other line numbers agrees: ' + r.out);
  fs.writeFileSync(path.join(libs, 'extract.js'), '// header\n\n' + blockText.replace('function fakeMint(w, opts) {', 'function fakeMint(w, opts) {\n  const changed = 1;') + '\nmodule.exports = {};\n');
  r = go('tests/harness.js  extract.js  ' + fm);
  ok(r.code === 1 && /DIFFERS .*extract\.js .*block differs/.test(r.out), 'block mode: a changed line inside the block fails: ' + r.out);
  fs.writeFileSync(path.join(libs, 'extract.js'), '// header\n' + blockText + '\n// a change after the block\n');
  r = go('tests/harness.js  extract.js  ' + fm);
  ok(r.code === 0, 'block mode: a change outside the block is not looked at');
  r = go('tests/harness.js  extract.js  block:^function\\snoSuchThing~^\\}$');
  ok(r.code === 1 && /no line matches the start/.test(r.out) && /here/.test(r.out), 'block mode: a start marker that is missing here fails');
  fs.writeFileSync(path.join(libs, 'extract.js'), '// nothing here\n');
  r = go('tests/harness.js  extract.js  ' + fm);
  ok(r.code === 1 && /there/.test(r.out), 'block mode: a start marker missing there fails: ' + r.out);
  r = go('tests/harness.js  extract.js  block:^function\\sfakeMint\\(~^NEVERMATCHES$');
  ok(r.code === 1, 'block mode: an end marker that is missing fails');
}

// the manifest in the tree names files that exist here
const real = fs.readFileSync(path.join(root, 'tools', 'integration-vectors.txt'), 'utf8').split('\n').filter((x) => x.trim() && x.trim()[0] !== '#');
ok(real.length > 0 && real.every((x) => fs.existsSync(path.join(root, x.trim().split(/\s+/)[0]))), 'every app path in the manifest exists');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (failed ? failed + ' failed' : 'all ' + n + ' integration-vectors checks pass'));
process.exit(failed ? 1 : 0);
