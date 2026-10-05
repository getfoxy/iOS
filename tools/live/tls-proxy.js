'use strict';
/* tls-proxy.js — HTTPS in front of a local mint, for the live tests.
 *
 *     node tools/live/tls-proxy.js <listen-port> <mint-port> <cert-dir>
 *
 * Foxy talks only to https (or .onion) mints, and a mint run in Docker for a
 * test speaks plain http. This sits on 127.0.0.1 with a self-signed
 * certificate (tools/live/local-mint.sh makes it) and passes every request
 * through unchanged. Node trusts the certificate through NODE_EXTRA_CA_CERTS. */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const [listen, target, dir] = process.argv.slice(2);
if (!listen || !target || !dir) {
  console.error('usage: node tools/live/tls-proxy.js <listen-port> <mint-port> <cert-dir>');
  process.exit(2);
}

const server = https.createServer({
  key: fs.readFileSync(path.join(dir, 'key.pem')),
  cert: fs.readFileSync(path.join(dir, 'cert.pem')),
}, (req, res) => {
  const up = http.request({
    host: '127.0.0.1', port: Number(target), method: req.method, path: req.url,
    headers: { ...req.headers, host: '127.0.0.1:' + target },
  }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'local mint unreachable: ' + e.message }));
  });
  req.pipe(up);
});
server.listen(Number(listen), '127.0.0.1', () => {
  console.log('https://127.0.0.1:' + listen + ' -> http://127.0.0.1:' + target);
});
