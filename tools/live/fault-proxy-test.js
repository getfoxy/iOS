'use strict';
/* fault-proxy-test.js — the fault proxy against a fake mint, no Docker, no network.
 *
 *   node tools/live/fault-proxy-test.js
 *
 * The proxy is what the live fault runs stand on, and what a mint operator is
 * handed to run in front of a test mint, so it is checked by itself first: a
 * plain http server on 127.0.0.1 plays the mint and records what reached it,
 * the proxy runs in this process in front of it behind a throwaway self-signed
 * certificate (made as tools/live/local-mint.sh makes build/live-tls, in a
 * temporary folder removed at the end), and every action, the seconds rule,
 * the canned rules, the log line's shape and the standalone command are
 * proved against it. Then nothing may be left open: no listening port, no
 * timer, no socket. A proxy that leaves a timer running fails here. */
const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { createFaultProxy, flipDleq, upstreamOf, pathForLog } = require('./fault-proxy');

const watchdog = setTimeout(() => { console.log('WATCHDOG 55s'); process.exit(2); }, 55000);
watchdog.unref();

let failed = 0, passed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// a port nobody has: the system's pick, released at once
function freePort() {
  return new Promise((done, no) => {
    const s = net.createServer();
    s.on('error', no);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => done(port)); });
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-proxy-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=foxy-local-mint',
  '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
{ stdio: 'ignore' });
const CA = fs.readFileSync(path.join(dir, 'cert.pem'));

/* The fake mint: what it was asked, and answers long enough to cut in half. */
const seen = [];
const SWAP = JSON.stringify({ signatures: [{ id: '00ad268c4d1f5826', amount: 2, C_: '02' + 'ab'.repeat(32),
  dleq: { e: 'e0'.repeat(32), s: '51'.repeat(32) } }], pad: 'x'.repeat(300) });
const KEYS = JSON.stringify({ keysets: [{ id: '00ad268c4d1f5826', unit: 'sat', keys: { 1: '02' + 'cd'.repeat(32) } }], pad: 'k'.repeat(1500) });
const mint = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, body });
    const send = (code, text) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(text); };
    const p = req.url.replace(/^\/Bitcoin/, '').split('?')[0];
    if (p === '/v1/swap') return send(200, SWAP);
    if (p.startsWith('/v1/keys')) return send(200, KEYS);
    if (p === '/v1/missing') return send(404, JSON.stringify({ detail: 'not found' }));
    return send(200, JSON.stringify({ name: 'fake mint', path: req.url }));
  });
});

/* One request through the proxy, never kept alive, with whatever came back:
 * the status, the bytes that arrived, and how it ended. */
function ask(base, method, p, o = {}) {
  return new Promise((done) => {
    const u = new URL(p, base);
    const t0 = Date.now();
    const got = { status: 0, headers: {}, body: '', chunks: 0, error: null };
    let settled = false;
    const finish = () => { if (settled) return; settled = true; got.ms = Date.now() - t0; done(got); };
    const r = https.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, ca: CA, agent: false,
      headers: { 'content-type': 'application/json', ...(o.headers || {}) } }, (res) => {
      got.status = res.statusCode;
      got.headers = res.headers;
      res.on('data', (c) => { got.body += c; got.chunks++; });
      res.on('end', finish);
      res.on('aborted', () => { got.error = got.error || 'aborted'; });
      res.on('error', (e) => { got.error = got.error || e.code || e.message; finish(); });
      res.on('close', finish);
    });
    r.on('error', (e) => { got.error = got.error || e.code || e.message; finish(); });
    if (o.timeout) r.setTimeout(o.timeout, () => { got.error = 'timeout'; r.destroy(); });
    r.end(o.body || '');
  });
}
const json = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const reached = (url) => seen.filter((x) => x.url === url).length;

async function run() {
  const t = Date.now();
  await new Promise((done) => mint.listen(0, '127.0.0.1', done));
  const mintPort = mint.address().port;
  const logFile = path.join(dir, 'requests.log');
  const port = await freePort();
  const p = createFaultProxy({ listen: port, target: mintPort, certDir: dir, logFile });
  await p.ready;
  const U = p.url;

  // passes untouched
  let r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 200 && json(r.body) && json(r.body).name === 'fake mint' && reached('/v1/info') === 1, 'no rule: the answer passes untouched', r.status + ' ' + r.body);

  // drop-before: the mint never sees it
  p.add({ method: 'POST', path: '/v1/swap', action: 'drop-before' });
  let n = reached('/v1/swap');
  r = await ask(U, 'POST', '/v1/swap', { body: '{}' });
  ok(r.error && !r.status && reached('/v1/swap') === n, 'drop-before: the connection closes and the mint never saw it', JSON.stringify([r.status, r.error, reached('/v1/swap') - n]));

  // drop-after: the mint did the work, the answer is lost
  p.add({ method: 'POST', path: '/v1/swap', action: 'drop-after' });
  n = reached('/v1/swap');
  r = await ask(U, 'POST', '/v1/swap', { body: '{}' });
  ok(r.error && !r.status && reached('/v1/swap') === n + 1 && p.last('POST', '/v1/swap').upstream === 200,
    'drop-after: the mint answered 200 and the client got nothing', JSON.stringify([r.status, r.error]));

  // status, with headers of its own
  p.add({ path: '/v1/info', action: 'status', status: 502, headers: { 'retry-after': '5' } });
  r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 502 && r.headers['retry-after'] === '5', 'status: 502 with the rule\'s own Retry-After', r.status + ' ' + JSON.stringify(r.headers));

  // `when` that does not match: the rule passes the answer and keeps its turn
  p.add({ path: '/v1/missing', action: 'drop-after', when: 200 });
  r = await ask(U, 'GET', '/v1/missing');
  const kept = p.rules.find((x) => x.path === '/v1/missing');
  ok(r.status === 404 && kept && kept.times === 1, 'when: 200 lets a 404 through and keeps its turn', r.status + ' times ' + (kept && kept.times));
  p.clear();

  // hang: no answer until the rules are cleared
  p.add({ path: '/v1/info', action: 'hang' });
  const hanging = ask(U, 'GET', '/v1/info');
  await pause(300);
  ok(p.pending().hung === 1, 'hang: the request is held open', JSON.stringify(p.pending()));
  p.clear();
  r = await hanging;
  ok(!r.status && r.error, 'hang: clearing the rules lets go of it', JSON.stringify([r.status, r.error]));

  // delays
  p.add({ path: '/v1/info', action: 'delay-before', ms: 300 });
  n = reached('/v1/info');
  r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 200 && r.ms >= 280 && reached('/v1/info') === n + 1, 'delay-before: 300 ms, then forwarded', r.ms + ' ms');
  p.add({ path: '/v1/info', action: 'delay-after', ms: 300 });
  r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 200 && r.ms >= 280, 'delay-after: the answer held 300 ms', r.ms + ' ms');

  // rewrite: one DLEQ digit changed
  p.add({ method: 'POST', path: '/v1/swap', action: 'rewrite', rewrite: flipDleq('e') });
  r = await ask(U, 'POST', '/v1/swap', { body: '{}' });
  const e = json(r.body) && json(r.body).signatures[0].dleq.e;
  ok(r.status === 200 && e && e !== json(SWAP).signatures[0].dleq.e && e.length === 64, 'rewrite: the DLEQ e has one digit changed', String(e).slice(-4));

  // cut-mid-body: the status and headers, half the bytes, then nothing
  p.add({ path: '/v1/keys', action: 'cut-mid-body' });
  r = await ask(U, 'GET', '/v1/keys');
  const promised = Number(r.headers['content-length']);
  ok(r.status === 200 && promised === KEYS.length && r.body.length > 0 && r.body.length < promised && r.error,
    'cut-mid-body: 200 and its headers, ' + r.body.length + ' of ' + promised + ' bytes, then cut', JSON.stringify([r.status, promised, r.body.length, r.error]));
  ok(Math.abs(r.body.length - Math.floor(promised / 2)) <= 1, 'cut-mid-body: the cut is about half way', r.body.length + ' of ' + promised);

  // trickle: all of it, slowly, in pieces
  p.add({ method: 'POST', path: '/v1/swap', action: 'trickle', chunk: 64, ms: 20 });
  r = await ask(U, 'POST', '/v1/swap', { body: '{}' });
  const pieces = Math.ceil(SWAP.length / 64);
  ok(r.status === 200 && r.body === SWAP && r.ms >= pieces * 20 * 0.8 && r.chunks >= 3,
    'trickle: the whole answer in ' + r.chunks + ' pieces over ' + r.ms + ' ms', JSON.stringify([r.status, r.body.length, r.ms, r.chunks]));
  p.add({ path: '/v1/info', action: 'trickle' });
  r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 200 && json(r.body) && r.ms >= 90, 'trickle: a default of 64 bytes every 100 ms', r.ms + ' ms');

  // refuse: every connection closed at accept for the time given, then open again
  p.add({ action: 'refuse', seconds: 0.6 });
  n = seen.length;
  r = await ask(U, 'GET', '/v1/info');
  const r2 = await ask(U, 'GET', '/__fault');
  ok(!r.status && r.error && !r2.status && seen.length === n, 'refuse: connections closed at accept, the control port too', JSON.stringify([r.error, r2.error]));
  await pause(700);
  r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 200, 'refuse: open again when the seconds are up', r.status + ' ' + r.error);
  ok(p.lines.some((l) => / - - - refuse 0ms$/.test(l)), 'refuse: a log line for each connection refused', p.lines.slice(-3).join(' | '));
  p.clear();

  // seconds: until the time is up, however many requests
  p.add({ path: '/v1/info', action: 'status', status: 503, seconds: 0.5 });
  const a = await ask(U, 'GET', '/v1/info'), b = await ask(U, 'GET', '/v1/info'), c = await ask(U, 'GET', '/v1/info');
  await pause(550);
  r = await ask(U, 'GET', '/v1/info');
  ok(a.status === 503 && b.status === 503 && c.status === 503 && r.status === 200, 'seconds: every request faulted for 0.5 s, none after',
    [a.status, b.status, c.status, r.status].join(','));
  // seconds and times: whichever ends first
  p.add({ path: '/v1/info', action: 'status', status: 503, seconds: 5, times: 1 });
  const d = await ask(U, 'GET', '/v1/info');
  r = await ask(U, 'GET', '/v1/info');
  ok(d.status === 503 && r.status === 200, 'seconds with times 1: one request, then it is spent', d.status + ',' + r.status);
  p.clear();
  let threw = '';
  try { p.add({ action: 'teleport' }); } catch (x) { threw = x.message; }
  ok(/no action teleport/.test(threw), 'an unknown action is refused when added', threw);

  // canned: the Nutshell lock refusal, once, on a swap
  p.add({ canned: 'lock-refusal', times: 1 });
  r = await ask(U, 'GET', '/v1/swap');
  const lockGet = r.status;
  r = await ask(U, 'POST', '/v1/swap', { body: '{}' });
  const detail = json(r.body) && json(r.body).detail;
  ok(lockGet === 200 && r.status === 400 && /^\s*failed to acquire database lock/i.test(detail) && /proofs_pending/.test(detail) && /timeout=1\),\)$/.test(detail),
    'lock-refusal: 400 on POST /v1/swap with the busy refusal the wallet reads as busy', r.status + ' ' + detail);
  r = await ask(U, 'POST', '/v1/swap', { body: '{}' });
  ok(r.status === 200, 'lock-refusal: times 1, the next swap goes through', String(r.status));

  // canned: rate limited, with Retry-After, for a stretch of time
  p.add({ canned: 'rate-limit', seconds: 0.5, retryAfter: 30 });
  r = await ask(U, 'GET', '/v1/keysets');
  const r3 = await ask(U, 'POST', '/v1/swap', { body: '{}' });
  ok(r.status === 429 && r3.status === 429 && json(r.body) && json(r.body).detail === 'Rate limit exceeded.' && r.headers['retry-after'] === '30',
    'rate-limit: 429 {"detail":"Rate limit exceeded."} with Retry-After: 30 on every path', r.status + ' ' + r.body + ' ' + r.headers['retry-after']);
  await pause(550);
  r = await ask(U, 'GET', '/v1/keysets');
  ok(r.status === 200, 'rate-limit: over when the seconds are up', String(r.status));
  p.add({ canned: 'rate-limit', times: 1 });
  r = await ask(U, 'GET', '/v1/keysets');
  ok(r.status === 429 && r.headers['retry-after'] === undefined, 'rate-limit: no Retry-After unless asked for', JSON.stringify(r.headers['retry-after']));
  p.add({ canned: 'bad-gateway', times: 1 });
  r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 502 && /text\/plain/.test(r.headers['content-type']) && !json(r.body), 'bad-gateway: a 502 that is not JSON, as a front proxy says it', r.status + ' ' + r.headers['content-type']);
  threw = '';
  try { p.add({ canned: 'meteor' }); } catch (x) { threw = x.message; }
  ok(/no canned rule meteor/.test(threw), 'an unknown canned rule is refused when added', threw);

  // the log line: time, method, path with ids out, status or fault, ms, the request id and nothing else
  const before = p.lines.length;
  await ask(U, 'GET', '/v1/keys/00ad268c4d1f5826', { headers: { 'x-request-id': 'req-7f3a', authorization: 'Bearer secret-header' } });
  await ask(U, 'GET', '/v1/mint/quote/bolt11/3fa85f64-5717-4562-b3fc-2c963f66afa6?probe=secret-query');
  await ask(U, 'POST', '/v1/melt/quote/bolt11/Kd_Ehg9hXqzRvA12bQ', { body: '{"secret":"secret-body"}' });
  p.add({ path: '/v1/info', action: 'status', status: 500 });
  await ask(U, 'GET', '/v1/info', { headers: { 'x-request-id': 'two words\tand a tab' } });
  p.add({ path: '/v1/info', action: 'drop-after' });
  await ask(U, 'GET', '/v1/info');
  await pause(50);
  const L = p.lines.slice(before);
  const shape = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (GET|POST) \S+ (\d{3}|-) \S+ \d+ms( x-request-id=\S+)?$/;
  ok(L.length === 5 && L.every((l) => shape.test(l)), 'log: five lines of time, method, path, status, fault, ms', L.join(' | '));
  ok(/ GET \/v1\/keys\/:id 200 pass \d+ms x-request-id=req-7f3a$/.test(L[0]), 'log: a keyset id reads :id and the X-Request-Id is carried', L[0]);
  ok(/ GET \/v1\/mint\/quote\/bolt11\/:id 200 pass \d+ms$/.test(L[1]), 'log: a uuid quote id reads :id, the query is left off, no id when none was sent', L[1]);
  ok(/ POST \/v1\/melt\/quote\/bolt11\/:id 200 pass /.test(L[2]), 'log: a base64-style quote id reads :id', L[2]);
  ok(/ GET \/v1\/info 500 status \d+ms x-request-id=two\?words\?and\?a\?tab$/.test(L[3]), 'log: a faulted status, and a request id stays one word', L[3]);
  ok(/ GET \/v1\/info - drop-after \d+ms$/.test(L[4]), 'log: a drop shows no status and the fault', L[4]);
  ok(!p.lines.some((l) => /secret|Bearer|00ad268c|3fa85f64|Kd_Ehg9h/.test(l)), 'log: nothing from headers, bodies, queries or ids', p.lines.filter((l) => /secret|Bearer/.test(l)).join(' | '));
  ok(p.lines.some((l) => / POST \/v1\/swap 400 lock-refusal /.test(l)) && p.lines.some((l) => / GET \/v1\/keysets 429 rate-limit /.test(l)),
    'log: a canned rule is named by its name', '');

  // the control endpoint: add over HTTP, the same lines back, clear
  r = await ask(U, 'POST', '/__fault', { body: JSON.stringify({ canned: 'rate-limit', seconds: 30, retryAfter: 2 }) });
  ok(r.status === 200 && json(r.body) && json(r.body).added, 'control: a canned rule added over HTTP', r.body);
  r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 429 && r.headers['retry-after'] === '2', 'control: and it applies', String(r.status));
  r = await ask(U, 'POST', '/__fault', { body: JSON.stringify({ path: '^/v1/(swap|melt)', action: 'cut-mid-body', seconds: 10 }) });
  await pause(30);
  r = await ask(U, 'GET', '/__fault');
  const ctl = json(r.body);
  ok(ctl && Array.isArray(ctl.log) && ctl.log.every((l) => typeof l === 'string') && ctl.log.join('\n') === p.lines.join('\n')
    && ctl.rules.some((x) => x.canned === 'rate-limit' && x.until) && ctl.rules.some((x) => x.path === '/^\\/v1\\/(swap|melt)/' && x.action === 'cut-mid-body'),
    'control: GET returns the rules and the very same log lines', ctl ? ctl.log.length + ' lines, ' + ctl.rules.length + ' rules' : r.body);
  ok(!/secret/.test(r.body), 'control: no request or answer body in what GET returns', '');
  r = await ask(U, 'POST', '/__fault', { body: JSON.stringify({ action: 'teleport' }) });
  ok(r.status === 400, 'control: an unknown action is a 400', String(r.status));
  r = await ask(U, 'DELETE', '/__fault');
  r = await ask(U, 'GET', '/v1/info');
  ok(r.status === 200 && p.rules.length === 0, 'control: DELETE clears every rule', String(r.status));

  // a mint under a path keeps its path, once
  const bp = await freePort();
  const q = createFaultProxy({ listen: bp, target: { host: '127.0.0.1', port: mintPort, protocol: 'http:', path: '/Bitcoin/' }, certDir: dir });
  await q.ready;
  q.add({ path: '/v1/info', action: 'status', status: 418, times: 1 });
  const s0 = seen.length;
  const x1 = await ask(q.url, 'GET', '/Bitcoin/v1/info');
  const x2 = await ask(q.url, 'GET', '/v1/info?x=1');
  const x3 = await ask(q.url, 'GET', '/Bitcoin/v1/info');
  const ups = seen.slice(s0).map((s) => s.url);
  ok(x1.status === 418 && x2.status === 200 && x3.status === 200 && ups.join(',') === '/Bitcoin/v1/info?x=1,/Bitcoin/v1/info',
    'a mint at /Bitcoin: rules match without the path, the path is added once', JSON.stringify([x1.status, x2.status, x3.status, ups]));
  const u = upstreamOf('https://mint.example/Bitcoin/');
  ok(u.base === '/Bitcoin' && u.label === 'https://mint.example/Bitcoin' && u.hostHeader === 'mint.example' && upstreamOf(3338).base === '',
    'a mint URL with a path keeps it; a local port has none', JSON.stringify(u));
  ok(pathForLog('/Bitcoin/v1/keys/009a1f293253e41e') === '/Bitcoin/v1/keys/:id', 'log: the mint\'s own path stays, its id does not', pathForLog('/Bitcoin/v1/keys/009a1f293253e41e'));
  await q.close();

  // standalone: the same proxy as a command, its log on stdout and in --log
  const sp = await freePort();
  const sLog = path.join(dir, 'standalone.log');
  const child = spawn(process.execPath, [path.join(__dirname, 'fault-proxy.js'), String(sp), String(mintPort), dir,
    '--log', sLog, '--rule', JSON.stringify({ canned: 'rate-limit', times: 1, retryAfter: 9 })], { stdio: ['ignore', 'pipe', 'pipe'] });
  let sOut = '', sErr = '';
  child.stdout.on('data', (c) => { sOut += c; });
  child.stderr.on('data', (c) => { sErr += c; });
  for (let i = 0; i < 100 && !/control:/.test(sErr); i++) await pause(50);
  const s1 = await ask('https://127.0.0.1:' + sp, 'GET', '/v1/info', { headers: { 'x-request-id': 'abc' } });
  const s2 = await ask('https://127.0.0.1:' + sp, 'GET', '/v1/keys/00ad268c4d1f5826');
  await pause(50);
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  child.kill('SIGTERM');
  let giveUp;
  const code = await Promise.race([exited, new Promise((done) => { giveUp = setTimeout(() => done('still running'), 5000); })]);
  clearTimeout(giveUp);
  const fileLines = fs.existsSync(sLog) ? fs.readFileSync(sLog, 'utf8').trim().split('\n') : [];
  ok(s1.status === 429 && s1.headers['retry-after'] === '9' && s2.status === 200, 'standalone: --rule applies a canned rule from the start', s1.status + ',' + s2.status + ' ' + sErr.trim());
  ok(/ GET \/v1\/info 429 rate-limit \d+ms x-request-id=abc\n.* GET \/v1\/keys\/:id 200 pass \d+ms\n$/.test(sOut), 'standalone: one line a request on stdout, and nothing else there', JSON.stringify(sOut));
  ok(fileLines.join('\n') === sOut.trim(), 'standalone: --log holds the same lines', JSON.stringify(fileLines));
  ok(code === 0, 'standalone: SIGTERM closes it and it exits 0', String(code));
  if (code !== 0) child.kill('SIGKILL');

  // closing with work in flight: a long delay, a trickle and a hang, all let go at once
  p.add({ path: '/v1/info', action: 'delay-before', ms: 20000 });
  p.add({ path: '/v1/swap', action: 'trickle', ms: 5000, chunk: 1 });
  p.add({ path: '/v1/keys', action: 'hang' });
  const inflight = [ask(U, 'GET', '/v1/info'), ask(U, 'POST', '/v1/swap', { body: '{}' }), ask(U, 'GET', '/v1/keys')];
  await pause(300);
  const busy = p.pending();
  const c0 = Date.now();
  await p.close();
  const closeMs = Date.now() - c0;
  const ends = await Promise.all(inflight);
  const after = p.pending();
  ok(busy.timers >= 2 && busy.hung === 1, 'close: a delay, a trickle and a hang were in flight', JSON.stringify(busy));
  ok(closeMs < 1000 && ends.every((x) => x.error), 'close: done in ' + closeMs + ' ms, each of them cut', JSON.stringify(ends.map((x) => x.error)));
  ok(after.timers === 0 && after.sockets === 0 && after.upstream === 0 && after.hung === 0 && after.open === 0 && !after.listening, 'close: no timer, socket or listener left', JSON.stringify(after));
  const refused = await new Promise((done) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); done('connected'); });
    s.on('error', (x) => done(x.code));
  });
  ok(refused === 'ECONNREFUSED', 'close: nothing listens on the port', refused);
  const fileText = fs.readFileSync(logFile, 'utf8').trim();
  ok(fileText === p.lines.join('\n'), 'logFile: every line, the ones cut at close included', fileText.split('\n').length + ' in the file, ' + p.lines.length + ' kept; not in the file: ' + p.lines.filter((l) => !fileText.includes(l)).join(' | '));

  await new Promise((done) => mint.close(done));
  await pause(20);
  // nothing may keep this process alive now (the watchdog is unref'd and not counted)
  const left = process.getActiveResourcesInfo().filter((k) => k !== 'TTYWrap' && k !== 'PipeWrap');
  ok(left.length === 0, 'nothing of the proxy is left running in this process', JSON.stringify(left));
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('(' + ((Date.now() - t) / 1000).toFixed(1) + ' s)');
  console.log(failed ? '\n' + failed + ' of ' + (passed + failed) + ' fault-proxy checks failed' : '\nall ' + passed + ' fault-proxy checks pass');
  process.exitCode = failed ? 1 : 0;
}
run().catch((e) => {
  console.log('THREW ' + ((e && e.stack) || e));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
