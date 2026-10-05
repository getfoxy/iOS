'use strict';
/* fault-proxy.js — tls-proxy.js with faults, per request path. Fake money only.
 *
 * In process (tools/live/faults.js):
 *
 *   const { createFaultProxy, flipDleq } = require('./fault-proxy');
 *   const p = createFaultProxy({ listen: 8453, target: 3338, certDir: 'build/live-tls' });
 *   await p.ready;
 *   p.add({ method: 'POST', path: '/v1/swap', action: 'drop-after', times: 1 });
 *
 * `target` is a port on this Mac, or a mint somewhere else — a URL string, or
 * { host, port, protocol }. The remote form exists because a mint that speaks
 * NUT-30 is not one that runs on this Mac: the local Docker mints were built
 * for the Lightning paths, and the on-chain section of faults.js needs a mint
 * that will quote and pay on chain with fake money (testnut.cashu.space). The
 * proxy then talks https upstream, with that host in the Host header and in
 * the TLS handshake, while still listening on 127.0.0.1 behind the local
 * certificate the wallet already trusts.
 *
 *   createFaultProxy({ listen: 8455, target: 'https://testnut.cashu.space', certDir: 'build/live-tls' });
 *
 * Standalone, with a control endpoint on the same port (127.0.0.1 only):
 *
 *   node tools/live/fault-proxy.js 8453 3338 build/live-tls
 *   node tools/live/fault-proxy.js 8455 https://testnut.cashu.space build/live-tls
 *   curl --cacert build/live-tls/cert.pem -X POST https://127.0.0.1:8453/__fault \
 *        -d '{"method":"POST","path":"/v1/swap","action":"drop-after","times":1}'
 *   curl --cacert build/live-tls/cert.pem https://127.0.0.1:8453/__fault          # rules + request log
 *   curl --cacert build/live-tls/cert.pem -X DELETE https://127.0.0.1:8453/__fault # clear
 *
 * A rule: { method?, path: '/prefix' | RegExp (or '^regex' over HTTP), times (default 1, -1 forever),
 *           action, status?, body?, ms?, rewrite? (fn), dleq? ('e'|'s', over HTTP) }
 * Actions:
 *   drop-before   close the connection without forwarding (the mint never sees it)
 *   drop-after    forward, let the mint answer, then close without replying
 *   status        answer `status` (500) with `body` without forwarding
 *   hang          never answer (the connection stays open until the proxy closes)
 *   delay-before  wait `ms`, then forward
 *   delay-after   forward at once, hold the mint's answer for `ms`
 *   rewrite       forward, then pass the JSON answer through `rewrite(json)`
 * `when: 200` on an after-action (drop-after, delay-after, rewrite): only an
 * answer with that status is faulted; any other passes and the rule keeps its turn.
 * The first rule that matches and has times left is used. */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const readAll = (stream) => new Promise((ok, no) => {
  const parts = [];
  stream.on('data', (c) => parts.push(c));
  stream.on('end', () => ok(Buffer.concat(parts)));
  stream.on('error', no);
});

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
 * URL or { host, port, protocol } is a mint elsewhere, reached over https.
 * The Host header is written from the same place, so a shared host that routes
 * by name (testnut sits behind one) sees the name it expects. */
function upstreamOf(target) {
  let host = '127.0.0.1', port = Number(target), protocol = 'http:';
  if (target && typeof target === 'object') {
    host = target.host || host;
    protocol = target.protocol || 'https:';
    port = Number(target.port) || (protocol === 'https:' ? 443 : 80);
  } else if (/^https?:\/\//.test(String(target))) {
    const u = new URL(String(target));
    host = u.hostname;
    protocol = u.protocol;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  }
  const bare = (protocol === 'https:' && port === 443) || (protocol === 'http:' && port === 80);
  return { host, port, protocol, hostHeader: host + (bare ? '' : ':' + port),
    label: protocol + '//' + host + (bare ? '' : ':' + port) };
}

function createFaultProxy(opts) {
  const { listen, target, certDir } = opts;
  const upstream = upstreamOf(target);
  const rules = [];
  const log = [];
  const sockets = new Set();
  const hung = new Set();

  function matches(rule, method, p) {
    if (rule.method && rule.method !== method) return false;
    if (rule.path instanceof RegExp) return rule.path.test(p);
    return p === rule.path || p.startsWith(rule.path);
  }
  function take(method, p) {
    for (const r of rules) {
      if (r.times === 0) continue;
      if (!matches(r, method, p)) continue;
      if (r.times > 0) r.times--;
      r.used = (r.used || 0) + 1;
      return r;
    }
    return null;
  }
  function forward(req, body) {
    return new Promise((ok, no) => {
      const wire = upstream.protocol === 'https:' ? https : http;
      const up = wire.request({
        host: upstream.host, port: upstream.port, method: req.method, path: req.url,
        // the name in the handshake, not the one the client dialled (127.0.0.1)
        servername: upstream.protocol === 'https:' ? upstream.host : undefined,
        // identity: a gzipped answer cannot be read or rewritten
        headers: { ...req.headers, host: upstream.hostHeader, 'accept-encoding': 'identity' },
      }, (r) => readAll(r).then((b) => ok({ status: r.statusCode, headers: r.headers, body: b }), no));
      up.on('error', no);
      up.end(body);
    });
  }
  function control(req, res, body) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET') {
      return send(200, { rules: rules.map((r) => ({ ...r, path: String(r.path), rewrite: r.rewrite ? 'fn' : undefined })), log });
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

  const server = https.createServer({
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
  }, async (req, res) => {
    const p = new URL(req.url, 'https://proxy').pathname;
    let body;
    try { body = await readAll(req); } catch (e) { return; }
    if (p === '/__fault') return control(req, res, body);
    const rule = take(req.method, p);
    const entry = { at: Date.now(), method: req.method, path: p, action: rule ? rule.action : 'pass' };
    log.push(entry);
    if (rule && rule.onHit) { try { rule.onHit(entry); } catch (e) {} }
    const act = rule && rule.action;
    if (act === 'drop-before') { req.socket.destroy(); return; }
    if (act === 'hang') { hung.add(res); return; }
    if (act === 'status') {
      res.writeHead(rule.status || 500, { 'content-type': 'application/json' });
      res.end(rule.body || JSON.stringify({ detail: 'fault proxy: ' + (rule.status || 500) }));
      entry.status = rule.status || 500;
      return;
    }
    if (act === 'delay-before') await sleep(rule.ms || 0);
    let up;
    try { up = await forward(req, body); } catch (e) {
      entry.status = 502;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: upstream.label + ' unreachable: ' + e.message }));
      return;
    }
    entry.upstream = up.status;
    entry.upstreamBody = up.body.toString().slice(0, 400);
    entry.requestBody = body.toString().slice(0, 600);
    let act2 = act;
    if (rule && rule.when && up.status !== rule.when && /-after$|^rewrite$/.test(act)) {
      if (rule.times >= 0) rule.times++;   // not this one: the rule keeps its turn
      entry.action = 'pass (status ' + up.status + ')';
      act2 = null;
    }
    if (act2 === 'drop-after') { req.socket.destroy(); return; }
    if (act2 === 'delay-after') await sleep(rule.ms || 0);
    let out = up.body;
    if (act2 === 'rewrite' && up.status === 200) {
      try {
        out = Buffer.from(JSON.stringify(rule.rewrite(JSON.parse(up.body.toString()))));
        entry.rewritten = true;
      } catch (e) { entry.rewriteError = e.message; }
    }
    if (req.socket.destroyed) { entry.clientGone = true; return; }
    const headers = { ...up.headers };
    delete headers['transfer-encoding'];
    headers['content-length'] = out.length;
    res.writeHead(up.status, headers);
    res.end(out);
    entry.status = up.status;
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('secureConnection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const api = {
    server, rules, log, upstream,
    ready: new Promise((ok, no) => { server.once('error', no); server.listen(Number(listen), '127.0.0.1', ok); }),
    url: 'https://127.0.0.1:' + listen,
    add(rule) { rules.push({ times: 1, ...rule }); return api; },
    clear() {
      rules.length = 0;
      for (const r of hung) { try { r.socket && r.socket.destroy(); } catch (e) {} }
      hung.clear();
      return api;
    },
    count(method, p) { return log.filter((e) => e.method === method && (p instanceof RegExp ? p.test(e.path) : e.path.startsWith(p))).length; },
    last(method, p) { return log.filter((e) => e.method === method && (p instanceof RegExp ? p.test(e.path) : e.path.startsWith(p))).pop(); },
    close() {
      api.clear();
      for (const s of sockets) s.destroy();
      return new Promise((ok) => server.close(() => ok()));
    },
  };
  return api;
}

module.exports = { createFaultProxy, flipDleq, upstreamOf };

if (require.main === module) {
  const [listen, target, dir] = process.argv.slice(2);
  if (!listen || !target || !dir) {
    console.error('usage: node tools/live/fault-proxy.js <listen-port> <mint-port|mint-url> <cert-dir>');
    process.exit(2);
  }
  const p = createFaultProxy({ listen, target, certDir: dir });
  p.ready.then(() => console.log(p.url + ' -> ' + p.upstream.label + '  (control: ' + p.url + '/__fault)'));
}
