#!/usr/bin/env node
'use strict';
/* mutate.js — break the wallet on purpose, one small change at a time, and
 * see whether the tests notice.
 *
 *     node tools/mutate.js --baseline [--workers 6]
 *     node tools/mutate.js --sample 100 [--seed 1] [--workers 6] [--only <part regex>] [--out FILE]
 *                          [--learn FILE] [--skip FILE] [--hours H]
 *     node tools/mutate.js --ids <id,id,…|FILE> [--suites <name,name,…>] [--out FILE]
 *
 * A test suite that passes says the code does what the tests ask. It does not
 * say the tests ask enough. This makes one change to Web/foxy-wallet.js (a
 * `<` to `<=`, an `&&` to `||`, a condition to `true`, a block emptied), runs
 * the wallet's suites against it, and writes down whether any of them
 * failed. A change nothing notices is a gap in the tests, or code that does
 * nothing.
 *
 * It never touches the tree it is run from. Each worker has a copy of tests/
 * and Web/ under --work (default: the system's temporary folder), and
 * everything else is a link back here. Results go to --out as one JSON
 * object a line, as they come, so a run that is stopped can be carried on
 * (a mutant already in the file is not run again).
 *
 * --learn takes the results of an earlier run and puts the suites that caught
 * the most per second of their own time first; a change is usually caught by
 * one of a few suites, and found first it costs seconds where found last it
 * costs the whole pass. --skip leaves out changes an earlier run already
 * made, so a second sample is a fresh one.
 *
 * --hours stops starting new changes after that long; those under way finish.
 *
 * --ids runs the changes named, and no others, whether or not they were run
 * before: the ids an earlier run wrote down (`kind@offset`), as a list or as
 * a file of them, one a line or as that run's own results. It is how a new
 * test is shown to do its job: the change it was written for, made again.
 * --suites runs only the suites named, in that order. An id is an offset into
 * the wallet as it was, so it means nothing once the wallet has been edited.
 *
 * A suite that fails is run once more against the same change before the
 * change is called caught. Many workers on one machine make a timing test
 * fail now and then with nothing wrong, and a catch that was only that would
 * flatter the tests.
 *
 * --baseline runs every suite, unchanged, in every worker at once: how long
 * each takes on a busy machine (for the order they run in, and their
 * deadlines) and which of them fail when nothing is wrong (left out, since a
 * suite that fails by itself notices nothing). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const acorn = require('./acorn/dist/acorn.js');

const ROOT = path.resolve(__dirname, '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || /^--/.test(v) ? true : v;
};
const WORKERS = Math.max(1, Number(arg('workers', 6)) || 6);
const WORK = path.resolve(String(arg('work', path.join(os.tmpdir(), 'foxy-mutate'))));
const OUT = path.resolve(String(arg('out', path.join(WORK, 'results.jsonl'))));
const BASE = path.join(WORK, 'baseline.json');
const WALLET = path.join('Web', 'foxy-wallet.js');

/* The suites that load the wallet: every tests/*.js that tools/check-all.sh
 * runs and that reaches for the harness. The others drive the app class or
 * the native side, and a change to the wallet cannot fail them. */
function walletSuites() {
  const all = fs.readFileSync(path.join(ROOT, 'tools', 'check-all.sh'), 'utf8');
  const run = new Set();
  const re = /node tests\/([a-z0-9-]+)\.js/g;
  let m;
  while ((m = re.exec(all))) run.add(m[1]);
  return Array.from(run).filter((n) => {
    const text = fs.readFileSync(path.join(ROOT, 'tests', n + '.js'), 'utf8');
    return /require\(['"]\.\/harness['"]\)|foxy-wallet/.test(text);
  }).sort();
}

/* ---- where a line of the joined wallet came from ----------------------- */
function partOf() {
  const dir = path.join(ROOT, 'build', 'wallet');
  const parts = fs.readdirSync(dir).filter((f) => /\.js$/.test(f)).sort();
  const joined = fs.readFileSync(path.join(ROOT, WALLET), 'utf8');
  let at = joined.indexOf('\n') + 1;       // the GENERATED line
  const spans = [];
  for (const f of parts) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const i = joined.indexOf(text, at);
    if (i < 0) continue;
    spans.push({ file: f, from: i, to: i + text.length, line0: joined.slice(0, i).split('\n').length });
    at = i + text.length;
  }
  return (offset, line) => {
    const s = spans.find((x) => offset >= x.from && offset < x.to);
    return s ? { file: s.file, line: line - s.line0 + 1 } : { file: '?', line: line };
  };
}

/* ---- the changes ------------------------------------------------------- */
const SWAP = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==', '===': '!==', '!==': '===',
               '+': '-', '-': '+', '*': '/', '/': '*', '%': '*', '&&': '||', '||': '&&', '??': '&&' };
const isText = (n) => n && ((n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral');
function mutants(src) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', locations: true });
  const out = [];
  const add = (kind, node, from, to, text) => out.push({ kind, from, to, text, line: node.loc.start.line });
  const between = (a, b, op) => {          // where the operator sits between two operands
    const i = src.indexOf(op, a.end);
    return i >= 0 && i < b.start ? i : -1;
  };
  (function walk(n, quiet) {
    if (!n || typeof n.type !== 'string') return;
    // what is only said to the log is not behaviour
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
        && n.callee.object.type === 'Identifier' && n.callee.object.name === 'console') quiet = true;
    if (!quiet) {
      if (n.type === 'BinaryExpression' || n.type === 'LogicalExpression') {
        const to = SWAP[n.operator];
        const joining = n.operator === '+' && (isText(n.left) || isText(n.right));
        const i = to && !joining ? between(n.left, n.right, n.operator) : -1;
        if (i >= 0) add(n.type === 'LogicalExpression' ? 'logic' : /[<>=!]/.test(n.operator) ? 'compare' : 'arithmetic',
                        n, i, i + n.operator.length, to);
      } else if (n.type === 'UnaryExpression' && (n.operator === '!' || n.operator === '-') && n.prefix) {
        add('unary', n, n.start, n.argument.start, '');
      } else if (n.type === 'UpdateExpression') {
        const i = src.indexOf(n.operator, n.start);
        if (i >= 0 && i < n.end) add('update', n, i, i + 2, n.operator === '++' ? '--' : '++');
      } else if (n.type === 'AssignmentExpression' && (n.operator === '+=' || n.operator === '-=')) {
        const i = between(n.left, n.right, n.operator);
        if (i >= 0) add('assign', n, i, i + 2, n.operator === '+=' ? '-=' : '+=');
      } else if (n.type === 'IfStatement' || n.type === 'ConditionalExpression') {
        add('condition-true', n, n.test.start, n.test.end, 'true');
        add('condition-false', n, n.test.start, n.test.end, 'false');
      } else if (n.type === 'Literal' && typeof n.value === 'boolean') {
        add('boolean', n, n.start, n.end, String(!n.value));
      } else if (n.type === 'BlockStatement' && n.body.length && n.end - n.start < 3000) {
        add('block', n, n.start, n.end, '{}');
      }
    }
    for (const k in n) {
      if (k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x, quiet));
      else if (v && typeof v === 'object') walk(v, quiet);
    }
  })(ast, false);
  return out;
}

/* A fixed shuffle, so a run can be repeated and carried on. */
function shuffled(list, seed) {
  let s = (Number(seed) || 1) >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/* ---- a worker's own tree ----------------------------------------------- */
function makeWorker(i) {
  const dir = path.join(WORK, 'w' + i);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(ROOT)) {
    if (name === '.git' || name === '.claude') continue;
    const from = path.join(ROOT, name);
    if (name === 'tests' || name === 'Web') fs.cpSync(from, path.join(dir, name), { recursive: true });
    else fs.symlinkSync(from, path.join(dir, name));
  }
  return dir;
}

function runSuite(dir, suite, ms) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join('tests', suite + '.js')],
                        { cwd: dir, stdio: 'ignore', detached: true });
    let over = false;
    const clock = setTimeout(() => {
      over = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
    }, ms);
    child.on('exit', (code) => {
      clearTimeout(clock);
      done({ ok: code === 0 && !over, timedOut: over, ms: Date.now() - t0 });
    });
    child.on('error', () => { clearTimeout(clock); done({ ok: false, timedOut: false, ms: Date.now() - t0 }); });
  });
}

async function baseline() {
  const suites = walletSuites();
  console.log(suites.length + ' wallet suites, unchanged, in ' + WORKERS + ' workers at once');
  const dirs = Array.from({ length: WORKERS }, (_, i) => makeWorker(i));
  const seen = {};
  await Promise.all(dirs.map(async (dir) => {
    for (const s of suites) {
      const r = await runSuite(dir, s, 900000);
      const e = seen[s] || (seen[s] = { ms: 0, fails: 0 });
      e.ms = Math.max(e.ms, r.ms);
      if (!r.ok) e.fails += 1;
    }
  }));
  fs.writeFileSync(BASE, JSON.stringify(seen, null, 1));
  const total = Object.values(seen).reduce((a, e) => a + e.ms, 0);
  const flaky = Object.keys(seen).filter((s) => seen[s].fails);
  console.log('a full pass takes ' + Math.round(total / 1000) + ' s on a busy machine');
  console.log(flaky.length ? 'left out, they fail with nothing changed: ' + flaky.join(', ') : 'every suite passes in every worker');
}

async function sample() {
  if (!fs.existsSync(BASE)) { console.error('run --baseline first'); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  let suites = Object.keys(base).filter((s) => !base[s].fails).sort((a, b) => base[a].ms - base[b].ms);
  const named = arg('suites', '') ? String(arg('suites')).split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (named) {
    // a suite written since the baseline has no time of its own yet
    named.forEach((s) => { if (!base[s]) base[s] = { ms: 40000, fails: 0 }; });
    suites = named;
  }
  const readRows = (file) => {
    const rows = [];
    if (file && fs.existsSync(String(file))) {
      for (const l of fs.readFileSync(String(file), 'utf8').split('\n')) { try { rows.push(JSON.parse(l)); } catch (e) {} }
    }
    return rows;
  };
  const learned = readRows(arg('learn', ''));
  if (learned.length && !named) {
    const caught = {};
    learned.forEach((r) => { if (r.by) caught[r.by] = (caught[r.by] || 0) + 1; });
    const worth = (s) => (caught[s] || 0) / Math.max(1000, base[s].ms);
    suites = suites.slice().sort((a, b) => (worth(b) - worth(a)) || (base[a].ms - base[b].ms));
    console.log('suites in order of what they caught before: ' + suites.slice(0, 8).join(', ') + ', …');
  }
  const skip = new Set(readRows(arg('skip', '')).map((r) => r.id));
  const src = fs.readFileSync(path.join(ROOT, WALLET), 'utf8');
  const where = partOf();
  const only = arg('only', '') ? new RegExp(String(arg('only'))) : null;
  let all = mutants(src).map((m) => Object.assign(m, where(m.from, m.line)));
  if (only) all = all.filter((m) => only.test(m.file));
  const id = (m) => m.kind + '@' + m.from;
  if (skip.size) all = all.filter((m) => !skip.has(id(m)));
  let ids = null;
  if (arg('ids', '')) {
    const given = String(arg('ids'));
    const lines = fs.existsSync(given) ? fs.readFileSync(given, 'utf8').split('\n') : given.split(',');
    ids = new Set(lines.map((l) => {
      const t = l.trim();
      if (t.charAt(0) === '{') { try { return String(JSON.parse(t).id || ''); } catch (e) { return ''; } }
      return t.split(/\s+/)[0];
    }).filter((t) => /^[a-z-]+@\d+$/.test(t)));
    const known = new Set(all.map(id));
    const lost = Array.from(ids).filter((t) => !known.has(t));
    if (lost.length) console.log('not a change this wallet has (edited since?): ' + lost.join(', '));
    all = all.filter((m) => ids.has(id(m)));
  }
  const want = ids ? all.length : Math.min(all.length, Number(arg('sample', 100)) || 100);
  const picked = ids ? all : shuffled(all, arg('seed', 1)).slice(0, want);
  const done = new Set();
  if (!ids && fs.existsSync(OUT)) {
    for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) { try { done.add(JSON.parse(l).id); } catch (e) {} }
  }
  const todo = picked.filter((m) => !done.has(id(m)));
  console.log(all.length + ' possible changes' + (only ? ' in ' + only : '') + '; ' + want + ' picked, ' + todo.length + ' to run, '
    + suites.length + ' suites, ' + WORKERS + ' workers');
  const dirs = Array.from({ length: WORKERS }, (_, i) => makeWorker(i));
  /* A suite that fails with nothing changed proves nothing by failing again.
   * Asked for by name, each is run once as it stands before any change is
   * made, and a failure stops the run. */
  if (named) {
    for (const s of suites) {
      const clean = await runSuite(dirs[0], s, Math.max(120000, base[s].ms * 3));
      if (!clean.ok) { console.error(s + ' fails with nothing changed; nothing was run'); process.exit(2); }
    }
  }
  let next = 0, killed = 0, survived = 0;
  const t00 = Date.now();
  const until = Number(arg('hours', 0)) > 0 ? t00 + Number(arg('hours')) * 3600000 : Infinity;
  await Promise.all(dirs.map(async (dir) => {
    for (;;) {
      if (Date.now() > until) return;
      const m = todo[next++];
      if (!m) return;
      const changed = src.slice(0, m.from) + m.text + src.slice(m.to);
      const rec = { id: id(m), kind: m.kind, file: m.file, line: m.line,
                    was: src.slice(m.from, m.to).slice(0, 80), now: m.text,
                    context: src.split('\n')[m.line - 1].trim().slice(0, 160) };
      try { acorn.parse(changed, { ecmaVersion: 'latest' }); } catch (e) { rec.result = 'invalid'; }
      if (!rec.result) {
        fs.writeFileSync(path.join(dir, WALLET), changed);
        const t0 = Date.now();
        rec.result = 'survived';
        for (const s of suites) {
          const limit = Math.max(30000, base[s].ms * 3);
          const r = await runSuite(dir, s, limit);
          if (r.ok) continue;
          // once more, so a failure that was only the machine being busy is not a catch
          const again = await runSuite(dir, s, limit);
          if (again.ok) { rec.flaky = (rec.flaky || []).concat(s); continue; }
          rec.result = again.timedOut ? 'timeout' : 'killed'; rec.by = s; break;
        }
        rec.ms = Date.now() - t0;
      }
      if (rec.result === 'survived') survived += 1; else killed += 1;
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      console.log((killed + survived) + '/' + todo.length + '  ' + rec.result + (rec.by ? ' by ' + rec.by : '')
        + '  ' + Math.round((rec.ms || 0) / 1000) + 's  ' + rec.file + ':' + rec.line + '  ' + rec.kind);
    }
  }));
  for (const dir of dirs) fs.writeFileSync(path.join(dir, WALLET), src);
  console.log('\n' + killed + ' noticed, ' + survived + ' not, in ' + Math.round((Date.now() - t00) / 60000) + ' min');
}

(arg('baseline', false) ? baseline() : sample()).catch((e) => { console.error(e); process.exit(1); });
