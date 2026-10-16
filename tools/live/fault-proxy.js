'use strict';
/* fault-proxy.js — tls-proxy.js with faults, per request path. Fake money only.
 *
 * A wallet is only as good as what it does when the mint's answer goes wrong,
 * and a mint does not go wrong on cue. This stands between the two on
 * 127.0.0.1 and makes it go wrong on purpose, for a request or for a stretch
 * of time, so the same faults can be run against Foxy here and against a test
 * mint somebody else runs.
 *
 * In process (tools/live/faults.js):
 *
 *   const { createFaultProxy, flipDleq } = require('./fault-proxy');
 *   const p = createFaultProxy({ listen: 8453, target: 3338, certDir: 'build/live-tls' });
 *   await p.ready;
 *   p.add({ method: 'POST', path: '/v1/swap', action: 'drop-after', times: 1 });
 *   p.add({ canned: 'rate-limit', seconds: 60, retryAfter: 30 });
 *   ...
 *   await p.close();
 *
 * `target` is a port on this Mac, or a mint somewhere else — a URL string, or
 * { host, port, protocol, path }. The remote form exists because a mint that
 * speaks NUT-30 is not one that runs on this Mac: the local Docker mints were
 * built for the Lightning paths, and the on-chain section of faults.js needs a
 * mint that will quote and pay on chain with fake money (testnut.cashu.space).
 * The proxy then talks https upstream, with that host in the Host header and
 * in the TLS handshake, while still listening on 127.0.0.1 behind the local
 * certificate the wallet already trusts. A mint that lives under a path
 * (https://host/Bitcoin) keeps it: the wallet dials the proxy bare, and
 * /v1/info goes up as /Bitcoin/v1/info (a request already under the path is
 * not given it twice). Rules match the path without it.
 *
 *   createFaultProxy({ listen: 8455, target: 'https://testnut.cashu.space', certDir: 'build/live-tls' });
 *
 * Other options: logFile (append each log line there), print (write each log
 * line to stdout; standalone does).
 *
 * Standalone, with a control endpoint on the same port (127.0.0.1 only):
 *
 *   node tools/live/fault-proxy.js <listen-port> <mint-port|mint-url> <cert-dir> [--log <file>] [--rule '<json>' ...]
 *   node tools/live/fault-proxy.js 8453 3338 build/live-tls
 *   node tools/live/fault-proxy.js 8455 https://testmint.example/Bitcoin build/live-tls --log build/proxy.log
 *   curl --cacert build/live-tls/cert.pem -X POST https://127.0.0.1:8453/__fault \
 *        -d '{"method":"POST","path":"/v1/swap","action":"drop-after","times":1}'
 *   curl --cacert build/live-tls/cert.pem -X POST https://127.0.0.1:8453/__fault \
 *        -d '{"canned":"rate-limit","seconds":60,"retryAfter":30}'
 *   curl --cacert build/live-tls/cert.pem https://127.0.0.1:8453/__fault          # rules + request log
 *   curl --cacert build/live-tls/cert.pem -X DELETE https://127.0.0.1:8453/__fault # clear
 *
 * A rule: { method?, path?: '/prefix' | RegExp (or '^regex' over HTTP; every path when left out),
 *           times (default 1, -1 forever), seconds?, action, status?, body?, headers?, ms?, chunk?,
 *           rewrite? (fn), dleq? ('e'|'s', over HTTP), canned? }
 * `seconds` makes a rule last that long from when it is added. With no `times`
 * it holds until the time is up; with `times` it ends at whichever comes first.
 * Actions:
 *   drop-before   close the connection without forwarding (the mint never sees it)
 *   drop-after    forward, let the mint answer, then close without replying
 *   status        answer `status` (500) with `body` and `headers` without forwarding
 *   hang          never answer (the connection stays open until the proxy closes)
 *   delay-before  wait `ms`, then forward
 *   delay-after   forward at once, hold the mint's answer for `ms`
 *   rewrite       forward, then pass the JSON answer through `rewrite(json)`
 *   cut-mid-body  forward, send the status line, the headers and about half the
 *                 body, then cut the connection
 *   trickle       forward, then send the answer `chunk` bytes (64) every `ms` (100)
 *   refuse        close every new connection as it is accepted, before TLS, the
 *                 way a mint being restarted looks; give it `seconds` (or `times`
 *                 connections). It takes the control endpoint's port with it.
 * `when: 200` on an action that forwards first (drop-after, delay-after,
 * rewrite, cut-mid-body, trickle): only an answer with that status is faulted;
 * any other passes and the rule keeps its turn.
 * The first rule that matches and is still live is used.
 *
 * Canned rules, `{ canned: name }` with any field above laid over them:
 *   lock-refusal  400 on POST /v1/swap, the busy refusal a Nutshell mint gives
 *                 when it cannot take its proofs_pending lock in time
 *   rate-limit    429 {"detail":"Rate limit exceeded."} on every path;
 *                 `retryAfter: n` adds a Retry-After header
 *   bad-gateway   502 with a plain-text body, as a reverse proxy says it when
 *                 the mint behind it is down
 *
 * The request log: one line per request, in GET /__fault, in `logFile`, and on
 * stdout standalone:
 *
 *   <ISO time> <METHOD> <path> <status|-> <pass|fault> <ms>ms [x-request-id=<value>]
 *
 * Quote ids, keyset ids and any hex or uuid segment in the path read `:id`,
 * and the query is left off. Nothing else from the headers or the bodies goes
 * in a line: it is meant to be handed to the mint's operator. The in-process
 * `log` keeps objects (with the mint's status and the start of its answer) for
 * the scripts that check what the mint did. */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const readAll = (stream) => new Promise((ok, no) => {
  const parts = [];
  stream.on('data', (c) => parts.push(c));
  stream.on('end', () => ok(Buffer.concat(parts)));
  stream.on('error', no);
});

const ACTIONS = new Set(['drop-before', 'drop-after', 'status', 'hang', 'delay-before', 'delay-after',
  'rewrite', 'cut-mid-body', 'trickle', 'refuse']);
// actions that forward first and so can look at the mint's status (`when`)
const AFTER = new Set(['drop-after', 'delay-after', 'rewrite', 'cut-mid-body', 'trickle']);
// a standalone proxy may run for a whole session; the newest lines are the ones asked for
const KEEP = 5000;

const CANNED = {
  'lock-refusal': () => ({ method: 'POST', path: '/v1/swap', action: 'status', status: 400,
    body: JSON.stringify({ detail: "failed to acquire database locks (LockOptions(table='proofs_pending', ... timeout=1),)", code: 0 }) }),
  'rate-limit': (r) => ({ path: '/', action: 'status', status: 429,
    body: JSON.stringify({ detail: 'Rate limit exceeded.' }),
    headers: r.retryAfter != null ? { 'retry-after': String(r.retryAfter) } : undefined }),
  'bad-gateway': () => ({ path: '/', action: 'status', status: 502,
    body: '502 Bad Gateway', headers: { 'content-type': 'text/plain; charset=utf-8' } }),
};

/* Change one hex digit of the first blind signature's DLEQ `e` or `s`. */
function flipDleq(field) {
  return (j) => {
    const list = (j && (j.signatures || j.promises)) || [];
    const sig = list.find((x) => x && x.dleq && x.dleq[field]);
    if (!sig) throw new Error('no dleq.' + field + ' in the answer to rewrite');
    const v = sig.dleq[field];
    const last = v.slice(-1);
    sig.dleq[field] = v.slice(0, -1) + (last === '0' ? '1' : '0');
    return j;
  };
}

/* Where the requests go: a bare port is http on this Mac, as it always was; a
 * URL or { host, port, protocol, path } is a mint elsewhere, reached over https.
 * The Host header is written from the same place, so a shared host that routes
 * by name (testnut sits behind one) sees the name it expects. */
function upstreamOf(target) {
  let host = '127.0.0.1', port = Number(target), protocol = 'http:', base = '';
  if (target && typeof target === 'object') {
    host = target.host || host;
    protocol = target.protocol || 'https:';
    port = Number(target.port) || (protocol === 'https:' ? 443 : 80);
    base = target.path || '';
  } else if (/^https?:\/\//.test(String(target))) {
    const u = new URL(String(target));
    host = u.hostname;
    protocol = u.protocol;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    base = u.pathname;
  }
  base = String(base).replace(/\/+$/, '');
  const bare = (protocol === 'https:' && port === 443) || (protocol === 'http:' && port === 80);
  return { host, port, protocol, base, hostHeader: host + (bare ? '' : ':' + port),
    label: protocol + '//' + host + (bare ? '' : ':' + port) + base };
}

/* A path as the log may show it: what a request was for, not whose it was. */
const ID_PARENT = new Set(['keys', 'keysets']);
function pathForLog(p) {
  const segs = String(p).split('?')[0].split('/');
  return segs.map((s, i) => {
    if (!s) return s;
    const id = (i >= 2 && segs[i - 2] === 'quote')                  // /quote/<method>/<id>
      || (i >= 1 && ID_PARENT.has(segs[i - 1]))                     // /keys/<keyset id>
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
      || /^[0-9a-f]{8,}$/i.test(s)
      || (s.length >= 16 && /^[A-Za-z0-9_=-]+$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s));
    return id ? ':id' : s.replace(/[^\x21-\x7e]/g, '?');
  }).join('/');
}
// the caller's own label for a request, and only if it is one printable word
function requestIdOf(req) {
  const v = req.headers['x-request-id'];
  if (v == null || v === '') return '';
  return String(Array.isArray(v) ? v[0] : v).replace(/[^\x21-\x7e]/g, '?').slice(0, 128);
}

function createFaultProxy(opts) {
  const { listen, target, certDir } = opts;
  const upstream = upstreamOf(target);
  const rules = [];
  const log = [];
  const lines = [];
  const sockets = new Set();
  const hung = new Set();
  const waits = new Set();     // every timer this proxy started and has not yet seen fire
  const ups = new Set();       // requests on their way to the mint
  const open = new Set();      // exchanges whose log line is not yet written
  let drained = null;          // close() waits on this for the last of them
  // its own agent, so close() can let go of the mint's kept-alive connections too
  const agent = new (upstream.protocol === 'https:' ? https : http).Agent({ keepAlive: true });
  const out = opts.logFile ? fs.createWriteStream(opts.logFile, { flags: 'a' }) : null;
  let closed = false;

  /* A pause that close() can end. It resolves either way; the caller looks at
   * `closed` before doing anything more. */
  function wait(ms) {
    return new Promise((ok) => {
      const w = { ok };
      w.t = setTimeout(() => { waits.delete(w); ok(); }, Math.max(0, Number(ms) || 0));
      waits.add(w);
    });
  }
  function writeLine(line) {
    lines.push(line);
    if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
    if (opts.print) process.stdout.write(line + '\n');
    if (out && !out.writableEnded) out.write(line + '\n');
  }
  function live(r, now) {
    return r.times !== 0 && (r.until == null || now < r.until);
  }
  function stripBase(p) {
    const b = upstream.base;
    return b && (p === b || p.startsWith(b + '/')) ? p.slice(b.length) || '/' : p;
  }
  function matches(rule, method, p) {
    if (rule.action === 'refuse') return false;   // a connection's rule, not a request's
    if (rule.method && rule.method !== method) return false;
    if (rule.path == null) return true;
    if (rule.path instanceof RegExp) return rule.path.test(p);
    return p === rule.path || p.startsWith(rule.path);
  }
  function take(method, p) {
    const now = Date.now();
    for (const r of rules) {
      if (!live(r, now) || !matches(r, method, p)) continue;
      if (r.times > 0) r.times--;
      r.used = (r.used || 0) + 1;
      return r;
    }
    return null;
  }
  function refusing() {
    const now = Date.now();
    const r = rules.find((x) => x.action === 'refuse' && live(x, now));
    if (r && r.times > 0) r.times--;
    return r;
  }
  function forward(req, body) {
    return new Promise((ok, no) => {
      const wire = upstream.protocol === 'https:' ? https : http;
      const b = upstream.base;
      const upPath = b && !(req.url === b || req.url.startsWith(b + '/') || req.url.startsWith(b + '?')) ? b + req.url : req.url;
      const up = wire.request({
        host: upstream.host, port: upstream.port, method: req.method, path: upPath, agent,
        // the name in the handshake, not the one the client dialled (127.0.0.1)
        servername: upstream.protocol === 'https:' ? upstream.host : undefined,
        // identity: a gzipped answer cannot be read or rewritten
        headers: { ...req.headers, host: upstream.hostHeader, 'accept-encoding': 'identity' },
      }, (r) => readAll(r).then((x) => ok({ status: r.statusCode, headers: r.headers, body: x }), no));
      ups.add(up);
      up.on('close', () => ups.delete(up));
      up.on('error', no);
      up.end(body);
    });
  }
  function control(req, res, body) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET') {
      return send(200, { rules: rules.map((r) => ({ ...r, path: r.path == null ? undefined : String(r.path),
        rewrite: r.rewrite ? 'fn' : undefined, onHit: undefined })), log: lines });
    }
    if (req.method === 'DELETE') { api.clear(); return send(200, { cleared: true }); }
    if (req.method === 'POST') {
      try {
        const r = JSON.parse(body.toString() || '{}');
        if (typeof r.path === 'string' && r.path[0] === '^') r.path = new RegExp(r.path);
        if (r.dleq) r.rewrite = flipDleq(r.dleq);
        api.add(r);
        return send(200, { added: true, rules: rules.length });
      } catch (e) { return send(400, { error: e.message }); }
    }
    return send(405, { error: 'GET, POST or DELETE' });
  }

  async function handle(req, res) {
    const t0 = Date.now();
    const full = new URL(req.url, 'https://proxy').pathname;
    let body;
    try { body = await readAll(req); } catch (e) { return; }
    if (full === '/__fault') return control(req, res, body);
    const p = stripBase(full);
    const rule = take(req.method, p);
    const entry = { at: t0, method: req.method, path: p, action: rule ? rule.action : 'pass' };
    log.push(entry);
    if (log.length > KEEP) log.splice(0, log.length - KEEP);
    let fault = rule ? rule.canned || rule.action : 'pass';
    const rid = requestIdOf(req);
    // one line when the exchange is over, however it ended
    open.add(res);
    res.once('close', () => {
      writeLine(new Date(t0).toISOString() + ' ' + req.method + ' ' + pathForLog(full) + ' ' +
        (entry.status || '-') + ' ' + fault + ' ' + (Date.now() - t0) + 'ms' + (rid ? ' x-request-id=' + rid : ''));
      open.delete(res);
      if (drained && open.size === 0) drained();
    });
    if (rule && rule.onHit) { try { rule.onHit(entry); } catch (e) {} }
    const act = rule && rule.action;
    if (act === 'drop-before') { req.socket.destroy(); return; }
    if (act === 'hang') { hung.add(res); return; }
    if (act === 'status') {
      entry.status = rule.status || 500;
      res.writeHead(entry.status, { 'content-type': 'application/json', ...(rule.headers || {}) });
      res.end(rule.body != null ? rule.body : JSON.stringify({ detail: 'fault proxy: ' + entry.status }));
      return;
    }
    if (act === 'delay-before') { await wait(rule.ms); if (closed) { req.socket.destroy(); return; } }
    let up;
    try { up = await forward(req, body); } catch (e) {
      if (closed || req.socket.destroyed) { req.socket.destroy(); return; }
      entry.status = 502;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: upstream.label + ' unreachable: ' + e.message }));
      return;
    }
    entry.upstream = up.status;
    entry.upstreamBody = up.body.toString().slice(0, 400);
    entry.requestBody = body.toString().slice(0, 600);
    let act2 = act;
    if (rule && rule.when && up.status !== rule.when && AFTER.has(act)) {
      if (rule.times >= 0) rule.times++;   // not this one: the rule keeps its turn
      entry.action = 'pass (status ' + up.status + ')';
      fault = 'pass';
      act2 = null;
    }
    if (act2 === 'drop-after') { req.socket.destroy(); return; }
    if (act2 === 'delay-after') { await wait(rule.ms); if (closed) { req.socket.destroy(); return; } }
    let outBody = up.body;
    if (act2 === 'rewrite' && up.status === 200) {
      try {
        outBody = Buffer.from(JSON.stringify(rule.rewrite(JSON.parse(up.body.toString()))));
        entry.rewritten = true;
      } catch (e) { entry.rewriteError = e.message; }
    }
    if (req.socket.destroyed) { entry.clientGone = true; return; }
    const headers = { ...up.headers };
    delete headers['transfer-encoding'];
    headers['content-length'] = outBody.length;
    entry.status = up.status;
    res.writeHead(up.status, headers);
    if (act2 === 'cut-mid-body') {
      // the length promised in full, half of it sent: the client is left mid-read
      const half = outBody.subarray(0, Math.floor(outBody.length / 2));
      res.flushHeaders();
      res.write(half, () => req.socket.destroy());
      return;
    }
    if (act2 === 'trickle') {
      const step = Math.max(1, Number(rule.chunk) || 64);
      const ms = rule.ms != null ? Number(rule.ms) : 100;
      res.flushHeaders();
      for (let off = 0; off < outBody.length; off += step) {
        await wait(ms);
        if (closed || res.destroyed) { req.socket.destroy(); return; }
        res.write(outBody.subarray(off, off + step));
      }
      res.end();
      return;
    }
    res.end(outBody);
  }

  const server = https.createServer({
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
  }, (req, res) => { handle(req, res).catch(() => { try { req.socket.destroy(); } catch (e) {} }); });
  server.on('connection', (s) => {
    sockets.add(s); s.on('close', () => sockets.delete(s));
    const r = refusing();
    if (r) {
      writeLine(new Date().toISOString() + ' - - - ' + (r.canned || 'refuse') + ' 0ms');
      s.destroy();
    }
  });
  server.on('secureConnection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  // a connection refused or cut before its handshake is the point, not a fault of ours
  server.on('tlsClientError', (e, s) => { try { s.destroy(); } catch (x) {} });

  const api = {
    server, rules, log, lines, upstream,
    ready: new Promise((ok, no) => { server.once('error', no); server.listen(Number(listen), '127.0.0.1', ok); }),
    url: 'https://127.0.0.1:' + listen,
    add(rule) {
      let r = { ...rule };
      if (r.canned != null) {
        const make = CANNED[r.canned];
        if (!make) throw new Error('no canned rule ' + r.canned + ' (' + Object.keys(CANNED).join(', ') + ')');
        const base = make(r);
        r = { ...base, ...r, headers: { ...(base.headers || {}), ...(r.headers || {}) } };
      }
      if (!ACTIONS.has(r.action)) throw new Error('no action ' + r.action + ' (' + [...ACTIONS].join(', ') + ')');
      if (r.seconds != null) {
        if (!(Number(r.seconds) > 0)) throw new Error('seconds must be above 0');
        r.until = Date.now() + Number(r.seconds) * 1000;
        if (r.times == null) r.times = -1;
      } else if (r.times == null) r.times = 1;
      rules.push(r);
      return api;
    },
    clear() {
      rules.length = 0;
      for (const r of hung) { try { r.socket && r.socket.destroy(); } catch (e) {} }
      hung.clear();
      return api;
    },
    count(method, p) { return log.filter((e) => e.method === method && (p instanceof RegExp ? p.test(e.path) : e.path.startsWith(p))).length; },
    last(method, p) { return log.filter((e) => e.method === method && (p instanceof RegExp ? p.test(e.path) : e.path.startsWith(p))).pop(); },
    // what is still open: a test asks for all zeros after close()
    pending() { return { timers: waits.size, sockets: sockets.size, upstream: ups.size, hung: hung.size, open: open.size, listening: server.listening }; },
    close() {
      closed = true;
      api.clear();
      for (const w of waits) { clearTimeout(w.t); w.ok(); }
      waits.clear();
      for (const u of ups) u.destroy();
      for (const s of sockets) s.destroy();
      agent.destroy();
      // the file is closed last, after the lines of the exchanges cut just now
      return new Promise((ok) => server.close(() => ok()))
        .then(() => open.size && new Promise((ok) => { drained = ok; }))
        .then(() => out && new Promise((ok) => out.end(ok)))
        .then(() => undefined);
    },
  };
  return api;
}

module.exports = { createFaultProxy, flipDleq, upstreamOf, pathForLog, CANNED };

if (require.main === module) {
  const args = process.argv.slice(2);
  const plain = [];
  let logFile = null;
  const start = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--log') logFile = args[++i];
    else if (args[i] === '--rule') start.push(args[++i]);
    else plain.push(args[i]);
  }
  const [listen, target, dir] = plain;
  if (!listen || !target || !dir || (args.includes('--log') && !logFile)) {
    console.error('usage: node tools/live/fault-proxy.js <listen-port> <mint-port|mint-url> <cert-dir> [--log <file>] [--rule \'<json>\' ...]');
    process.exit(2);
  }
  const p = createFaultProxy({ listen, target, certDir: dir, logFile, print: true });
  for (const j of start) {
    const r = JSON.parse(j);
    if (typeof r.path === 'string' && r.path[0] === '^') r.path = new RegExp(r.path);
    if (r.dleq) r.rewrite = flipDleq(r.dleq);
    p.add(r);
  }
  p.ready.then(() => console.error(p.url + ' -> ' + p.upstream.label + '  (control: ' + p.url + '/__fault)'));
  const stop = () => p.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
