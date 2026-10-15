'use strict';
/* crowd.js — a crowd at one mint, or at two with crossings between them: N
 * people testing it at the same time, sending and receiving back and forth,
 * every request over Tor.
 *
 *   node tools/live/crowd.js [--people 20] [--rounds 10] [--fund 100] [--socks 53114]
 *                            [--min 1 --max 25] [--stagger 0] [--token <file>]
 *                            [--cross 0.5] [--burst 1,2,4,8,16,32,64,100 --repeat 1] <mint A> [<mint B>]
 *
 * Each person is a wallet page of its own (harness.boot): its own phone, its
 * own seed, its own Tor circuit. A person signs in to Tor's SOCKS port with a
 * name of its own for the whole run, and Tor keeps different names on
 * different circuits, so each person reaches the mint from an exit of its own,
 * as twenty phones would. A request that has to be asked again goes out on a
 * fresh circuit, and the person stays on that one: a 429 is asked once more by
 * the page itself (Web/foxy-wallet.js, "asking once more on another circuit"),
 * and if the mint still says no, the whole step waits and is tried again.
 *
 * With two mints, people alternate: even numbers bank at A, odd at B.
 *
 *   1. Funding. Person 0 is the funder, at A. It asks A for one invoice for
 *      people x fund sats and a little over for the fees, prints the invoice,
 *      and waits for it to be paid (testnut pays its own invoices within
 *      seconds; at a real mint a person pays it). --token <file> funds it with
 *      a Cashu token at A instead, such as the one an earlier run swept out;
 *      one token a line. Each take goes out on its own exit, paced; a take that
 *      fails on its exit is tried on two more. A token still not taken is kept
 *      in untaken-<run>.tokens and the run goes on with what came in.
 *      With two mints the funder first crosses the B people's half to person 1
 *      (the first person at B), the way the app pays somebody at another mint,
 *      and that first crossing is reported on its own; person 1 then shares it
 *      out at B as tokens. If the crossing cannot be made and nothing left A,
 *      person 1 is funded by a second invoice at B instead, the run says so
 *      loudly, and no round makes a crossing. Then the funder sends everyone
 *      at A a token of fund sats and everyone takes it.
 *   2. Rounds. Every person at once sends a random whole amount between --min
 *      and --max sats to a random other person; then everyone takes what
 *      arrived. --stagger waits up to that many ms before each send. With two
 *      mints, --cross (0.5 by default) is the share of sends that go to
 *      somebody at the other mint. A send at the same mint is a token, as with
 *      one mint. A crossing is what the app does for a payer with a route
 *      (build/app/26d-tap.js, `tapCrossQuote` and `crossRun`): the payer quotes
 *      the move with the figure to land (`transferQuote` with `land`), connects
 *      to its own mint, moves the money to the receiver's (`moveRun`, a visit),
 *      pays there with a token (`sendToken`), and goes home; the receiver takes
 *      the token at its own mint.
 *   3. The end. Everyone sends everything back to the funder at A: the B people
 *      cross back (and anyone holding sats at B crosses them), then whatever
 *      anyone holds at A goes to the funder as a token. Everything left at A
 *      (the sweep token, piles too small to send, tokens nobody took) is written
 *      to leftover-<run>.tokens, one a line, ready for the next run's --token.
 *      The books must add up
 *      to the sat: what came in = everyone's balance at A and at B + every fee
 *      paid at A + every fee paid at B + what the crossings cost in Lightning
 *      fees, counted twice over — as each wallet's own books count them (a
 *      send's or receive's swap fee, and a crossing's fee as its history entry
 *      shows it), and as the mints charged them (inputs less outputs of every
 *      swap, inputs less amount less change of every melt). Then the funder's
 *      balance at A is swept out to a Cashu token in the run's folder: the
 *      backup is a token, not the seed (production.md).
 *
 * --burst replaces the rounds with a ramp of bursts at one mint: for each size,
 * that many people send a token one after another, and then every receiver
 * takes its token at the same instant, so the mint sees exactly that many
 * swaps at once. Each burst reports how many were taken, how many the mint
 * refused for its own lock ("failed to acquire database lock", "database is
 * locked"), the median, 90th percentile and longest take, and the swaps a
 * second; a refused take is offered again alone afterwards, which must go
 * (the refusal is before any write). --repeat runs the ramp that many times.
 * The share-out and the sweep go one at a time in burst mode, so the only
 * bursts are the measured ones. One mint only.
 *
 * The report is printed at the end and written as JSON beside the run's state:
 * each mint, its version and fee; same-mint sends and crossings kept apart,
 * each with the count, median, 90th percentile and longest time of the whole
 * step and of each kind of request over Tor, and its failures by kind; every
 * crossing's fee as the payer's books show it, and how much of it was
 * Lightning; the first crossing on its own; each round's wall time; the 429s
 * and what their retries did; the circuits and exits used; each person's
 * balance at each mint before the sweep; the books line.
 *
 * Fake money by default: testnut (https://testnut.cashu.space or one of its
 * names). Nothing here reaches a mint by fetch from this Mac: every request is
 * curl through the SOCKS port (harness.js, o.via), and the end says how many
 * went each way. A mint on this Mac cannot be reached over Tor and is refused,
 * unless --local is given with FOXY_LIVE_LOCAL=1: then both mints must be on
 * this Mac (tools/live/mint-pair.sh), curl goes to them straight with the
 * pair's certificate and not through Tor, and every line that would speak of
 * Tor says "local" instead. That is for proving the crowd's own logic, and
 * the crossings, when no second fake-money mint answers over Tor.
 *
 * Real money, for later, started by the owner and never by a script:
 *   FOXY_LIVE_REAL=1 node tools/live/crowd.js --people 20 https://forge.flashapp.me https://mint.minibits.cash/Bitcoin
 * The same run, with the rules of production.md: the state (each person's
 * counters, and what they hold at each mint as a token) under
 * ~/.foxy-live/crowd/<date>/, outside this repository and outside iCloud; the
 * balance reported at the start and the end; a person pays the one invoice at
 * A; the funder's balance swept to a token written there; and when the money
 * runs out, it says so and stops. No words are ever written down or printed;
 * a crash strands what was in play, and the state file's tokens are what is
 * left to claim it with. Both mints must be real, or both fake: a mix is
 * refused.
 *
 * Tor's SOCKS port is a running Foxy's (the simulator's): --socks, or
 * FOXY_REAL_SOCKS, or 53114. The run refuses to start unless that port says
 * "IsTor":true at check.torproject.org, as mint-survey.py does.
 * FOXY_CROWD_DEBUG=1 says, for a send that failed, the amounts of the pieces held. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const H = require('./harness');

process.on('unhandledRejection', () => {});

/* ---- the command line --------------------------------------------------- */
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const PEOPLE = Math.round(Number(opt('people', 20)));
const ROUNDS = Math.round(Number(opt('rounds', 10)));
const FUND = Math.round(Number(opt('fund', 100)));
const SOCKS = String(opt('socks', process.env.FOXY_REAL_SOCKS || '53114'));
const MIN = Math.round(Number(opt('min', 1)));
const MAX = Math.round(Number(opt('max', 25)));
const STAGGER = Math.round(Number(opt('stagger', 0)));
const TOKEN_FILE = opt('token', '');
const CROSS_ARG = opt('cross', null);
const BURST = String(opt('burst', '')).split(',').map((x) => Math.round(Number(x))).filter((n) => n >= 1);
const REPEAT = Math.round(Number(opt('repeat', 1)));
const BATCH = Math.round(Number(opt('batch', 8)));     // people brought up at once: a Tor on a phone cannot build 100 circuits in one go
const SPREAD = Math.round(Number(opt('spread', 20)));  // ms between a burst's starts: real at the mint, kind to the one SOCKS port
const PACE = Math.round(Number(opt('pace', 3200)));    // burst mode: ms between the share-out's and the sweep's one-at-a-time steps, under a mint's per-address limit
const LOCAL = flag('local');
/* A mint's URL as the wallet keys it (canonicalMint in Web/foxy-wallet.js):
 * scheme and host in lower case, no default port, no trailing slash. */
function canon(u) {
  const s = String(u || '').trim();
  const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(s);
  if (!m) return s.replace(/\/+$/, '');
  const scheme = m[1].toLowerCase();
  let host = m[2].toLowerCase();
  if (host.endsWith(scheme === 'https' ? ':443' : ':80')) host = host.replace(/:\d+$/, '');
  return scheme + '://' + host + (m[3] || '').replace(/\/+$/, '');
}
const MINT = canon(argv[0]);
const MINT_B = canon(argv[1] || '');
const TWO = !!MINT_B;
const URL_OF = { A: MINT, B: MINT_B };
const LETTERS = TWO ? ['A', 'B'] : ['A'];
const CROSS = TWO ? (CROSS_ARG == null ? 0.5 : Number(CROSS_ARG)) : 0;
const usage = 'usage: node tools/live/crowd.js [--people 20] [--rounds 10] [--fund 100] [--socks 53114] '
  + '[--min 1 --max 25] [--stagger 0] [--token <file>] [--cross 0.5] [--burst 1,2,4,8 --repeat 1 --spread 20 --pace 3200] [--batch 8] [--local] <mint A> [<mint B>]';
if (!MINT || !/^https:\/\//.test(MINT) || (TWO && !/^https:\/\//.test(MINT_B)) || argv.length > 2) { console.log(usage); process.exit(1); }
if (BURST.length && TWO) { console.log('FAIL  --burst is for one mint'); process.exit(1); }
if (!(REPEAT >= 1) || !(BATCH >= 1) || !(SPREAD >= 0) || !(PACE >= 0)) { console.log(usage); process.exit(1); }
/* At most BATCH of fn in flight over the list: bringing a crowd up is not a burst. */
const batched = async (list, fn) => {
  const out = new Array(list.length); let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(BATCH, list.length) }, worker));
  return out;
};
/* In burst mode the share-out and the sweep go one at a time, so the only
 * bursts at the mint are the measured ones. */
const allOf = async (list, fn) => {
  if (!BURST.length) return Promise.all(list.map(fn));
  const out = [];
  for (let i = 0; i < list.length; i++) { if (PACE && i) await sleep(PACE); out.push(await fn(list[i], i)); }
  return out;
};
if (!(PEOPLE >= 2) || !(ROUNDS >= 0) || !(FUND >= 1) || !(MIN >= 1) || !(MAX >= MIN) || !(STAGGER >= 0) || !/^\d+$/.test(SOCKS)
    || !(CROSS >= 0 && CROSS <= 1) || (TWO && MINT === MINT_B) || (TWO && PEOPLE < 2)) {
  console.log('bad arguments: at least 2 people, a fund of 1 sat or more, 1 <= min <= max, 0 <= cross <= 1, two different mints\n' + usage);
  process.exit(1);
}
if (!TWO && CROSS_ARG != null && Number(CROSS_ARG) > 0) {
  console.log('--cross needs a second mint: with one mint every send is at that mint\n' + usage);
  process.exit(1);
}

/* Fake money unless the owner started it for real money, and then only the
 * mints named on the command line. Both fake or both real: a run that mixed
 * them would move fake money's books into real money's. */
const HOST = new URL(MINT).hostname;
const HOST_B = TWO ? new URL(MINT_B).hostname : '';
const isFake = (u) => { try { H.fakeMoneyOnly(u); return true; } catch (e) { return false; } };
const FAKE = isFake(MINT) && (!TWO || isFake(MINT_B));
const ANY_FAKE = isFake(MINT) || (TWO && isFake(MINT_B));
if (!FAKE && ANY_FAKE) {
  console.log('FAIL  one mint is fake money and the other real: both fake (testnut) or both real (FOXY_LIVE_REAL=1)');
  process.exit(1);
}
const REAL = !FAKE && process.env.FOXY_LIVE_REAL === '1';
if (!FAKE && !REAL) {
  console.log('FAIL  ' + [MINT, MINT_B].filter(Boolean).join(' and ') + ' are real-money mints: only with FOXY_LIVE_REAL=1, started by the owner (tools/live/production.md)');
  process.exit(1);
}
const isLocal = (h) => h === '127.0.0.1' || h === 'localhost';
const anyLocal = isLocal(HOST) || (TWO && isLocal(HOST_B));
if (LOCAL && (!FAKE || process.env.FOXY_LIVE_LOCAL !== '1' || !isLocal(HOST) || (TWO && !isLocal(HOST_B)))) {
  console.log('FAIL  --local is for mints on this Mac only (tools/live/mint-pair.sh), with FOXY_LIVE_LOCAL=1');
  process.exit(1);
}
if (FAKE && anyLocal && !LOCAL) {
  console.log('FAIL  a mint on this Mac cannot be reached through Tor; use a testnut (or --local, which leaves Tor out)');
  process.exit(1);
}
const LOCAL_CA = path.join(H.ROOT, 'build', 'live-tls', 'cert.pem');
const WAY = LOCAL ? 'straight to this Mac (local, not over Tor)' : 'over Tor at 127.0.0.1:' + SOCKS;

const WATCHDOG_S = Number(process.env.FOXY_CROWD_WATCHDOG_S) || 5400;
setTimeout(() => { console.log('\nWATCHDOG ' + WATCHDOG_S + 's: the run did not finish'); finish(2); }, WATCHDOG_S * 1000).unref();

/* Where the run's state and report go. Real money: ~/.foxy-live/crowd/<date>/,
 * outside the repository and outside iCloud. Fake money: the system's temp folder. */
const STAMP = new Date().toISOString();
const DAY = STAMP.slice(0, 10);
const RUN = STAMP.slice(11, 19).replace(/:/g, '');
const DIR = REAL ? path.join(os.homedir(), '.foxy-live', 'crowd', DAY)
  : path.join(os.tmpdir(), 'foxy-crowd-dry', DAY);
const STATE_FILE = path.join(DIR, 'state-' + RUN + '.json');
const REPORT_FILE = path.join(DIR, 'report-' + RUN + '.json');
const SWEEP_FILE = path.join(DIR, 'sweep-' + RUN + '.token');
const UNTAKEN_FILE = path.join(DIR, 'untaken-' + RUN + '.tokens');
const LEFTOVER_FILE = path.join(DIR, 'leftover-' + RUN + '.tokens');

const sleep = H.sleep;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const fmt = (n) => Number(n).toLocaleString('en-US');
const label = () => crypto.randomBytes(16).toString('hex');
let failures = 0;
const ok = (good, what, detail) => {
  console.log((good ? 'OK    ' : 'FAIL  ') + what + (detail ? ' — ' + detail : ''));
  if (!good) failures++;
  return !!good;
};
const say = (s) => console.log('      ' + s);

/* Which mint a URL is at, by letter. A request's URL is the mint's own with a
 * path after it; a mint at a path of its own (minibits' /Bitcoin) still
 * matches only itself. */
function letterOf(u) {
  const c = canon(u);
  for (const k of LETTERS) if (c === URL_OF[k] || c.startsWith(URL_OF[k] + '/')) return k;
  return '?';
}

/* ---- the counts --------------------------------------------------------- */
/* Same-mint sends and crossings are kept apart: `group` is 'same-mint' or
 * 'crossing', and is what the person was doing when the request went out. */
const GROUPS = ['same-mint', 'crossing'];
const S = {
  times: {},            // group -> kind -> [ms] of every request answered, over Tor
  wallet: {},           // group -> step -> [ms] of the whole wallet step
  failed: {},           // group -> 'http 500', 'curl 97', 'timeout' -> count
  curl: 0,              // curl calls made
  answered: 0,
  busy: 0,              // 429s
  retry429: 0, retry429Ok: 0, retry429Busy: 0, retry429Failed: 0,
  retryNet: 0, retryNetOk: 0, retryNetFailed: 0,
  stepRetries: 0, tokenRetries: 0, stepRetriesOk: 0, stepRetriesFailed: 0,
  walletFailed: {},     // group -> what a wallet said when a step failed, by its words
  offeredThenRefused: [], // amounts sendShortfall passed and sendToken refused (sendTo)
  circuits: new Set(),  // every SOCKS name that carried a request
  /* What the mints charged, per mint: a swap's inputs less its outputs, a
   * melt's inputs less the amount less the change, split into the inputs'
   * fee by the keyset's rule and the Lightning fee that is the rest. */
  mint: {},             // letter -> { swapFees, swaps, meltInputFees, melts, lnFees, meltsUnread, issued }
  meltQuotes: {},       // melt quote id -> { amount, request }, from the quote and its answer
  melts: {},            // invoice paid -> { at, quote, inputFee, lnFee, amount, change }
  feeByKeyset: {},      // keyset -> sats of input fee its pieces owed by the mint's rule (NUT-02)
  feeRuleOff: 0,        // swaps whose inputs less outputs was not the rule's fee
  pageFetch: {},        // a page's own fetch, refused: host -> count
  rounds: [],
  crossings: [],        // one row per crossing tried, made or not
};
for (const k of LETTERS) S.mint[k] = { swapFees: 0, swaps: 0, meltInputFees: 0, melts: 0, lnFees: 0, meltsUnread: 0, issued: 0 };
const push = (o, k, v) => { (o[k] = o[k] || []).push(v); };
const bump = (o, k, n) => { o[k] = (o[k] || 0) + (n || 1); };
const sub = (o, g) => (o[g] = o[g] || {});
function stats(list) {
  const a = (list || []).slice().sort((x, y) => x - y);
  if (!a.length) return { count: 0, median: null, p90: null, max: null };
  const at = (q) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
  return { count: a.length, median: at(0.5), p90: at(0.9), max: a[a.length - 1] };
}

/* What a mint request is, for the table. A swap is named by what the person
 * was doing when it went out. With two mints, the mint it went to is named. */
function kindOf(p, m) {
  const u = new URL(m.url).pathname.replace(/^\/.*?(?=\/v1\/)/, '').replace(/\/[0-9a-z_-]{20,}$/i, '/:id');
  let k;
  if (m.method === 'POST' && u === '/v1/mint/quote/bolt11') k = 'quote';
  else if (m.method === 'GET' && u === '/v1/mint/quote/bolt11/:id') k = 'quote check';
  else if (m.method === 'POST' && u === '/v1/mint/bolt11') k = 'mint';
  else if (m.method === 'POST' && u === '/v1/melt/quote/bolt11') k = 'melt quote';
  else if (m.method === 'GET' && u === '/v1/melt/quote/bolt11/:id') k = 'melt quote check';
  else if (m.method === 'POST' && u === '/v1/melt/bolt11') k = 'melt';
  else if (m.method === 'POST' && u === '/v1/swap') k = p && p.doing ? p.doing + '/swap' : 'swap (other)';
  else if (m.method === 'POST' && u === '/v1/checkstate') k = 'checkstate';
  else if (m.method === 'POST' && u === '/v1/restore') k = 'restore';
  else if (m.method === 'GET' && /^\/v1\/(info|keysets|keys)(\/:id)?$/.test(u)) k = 'info/keys';
  else k = m.method + ' ' + u;
  return TWO ? k + ' @' + letterOf(m.url) : k;
}

/* ---- the way there: curl through Tor's SOCKS port ----------------------- */
/* Failures that left before the request reached the mint, safe to ask again
 * whatever it was: the proxy unreachable (5, 7), a name not resolved (6), the
 * TLS handshake (35), SOCKS refusing the stream (97, an exit that could not
 * connect). A timeout, a broken send or answer (28, 52, 55, 56) may have reached the
 * mint, so only a GET is asked again after one; a POST hands the page the
 * lost answer, and the page's own recovery does what the app would do. */
const BEFORE_IT_LEFT = new Set([5, 6, 7, 35, 97]);
const LOST_ON_THE_WAY = new Set([28, 52, 55, 56]);
const BUDGET_MS = 60000;   // inside the page's own 65 s for one request
const KEYSET_PPK = {};      // keyset id -> input_fee_ppk, from both mints' /v1/keysets at the start

function curl(m, name, maxMs) {
  return new Promise((ok) => {
    const args = ['-sS', '--max-time', String(Math.max(5, Math.floor(maxMs / 1000)))];
    // --local goes straight, not over Tor: only ever to this Mac
    if (LOCAL && !isLocal(new URL(m.url).hostname)) return ok({ err: true, code: 0, ms: 0, why: 'refused: --local reaches only this Mac, not ' + new URL(m.url).hostname });
    if (LOCAL) args.push('--cacert', LOCAL_CA);
    else args.push('--socks5-hostname', '127.0.0.1:' + SOCKS, '--proxy-user', name + ':foxy');
    // HTTP/1.1: over Tor, HTTP/2 broke mid-answer ("Error in the HTTP2 framing layer", curl 16)
    args.push('--http1.1',
      '-X', m.method, '-H', 'content-type: application/json', '-H', 'accept: application/json',
      '-w', '\n%{http_code}');
    if (m.method !== 'GET') args.push('--data-binary', '@-');
    args.push(m.url);
    S.curl++;
    S.circuits.add(name);
    const t0 = Date.now();
    const child = execFile('curl', args, { maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
      const ms = Date.now() - t0;
      if (err) {
        const code = typeof err.code === 'number' ? err.code : 0;
        return ok({ err: true, code, ms, why: String(errOut || err.message).trim().split('\n').pop().slice(0, 160) });
      }
      const cut = out.lastIndexOf('\n');
      ok({ status: Number(out.slice(cut + 1)) || 0, text: out.slice(0, cut), ms });
    });
    if (m.method !== 'GET') { child.stdin.write(String(m.body || '')); child.stdin.end(); }
  });
}

/* The input fee a set of pieces owes by the mint's rule (NUT-02): each piece
 * its keyset's input_fee_ppk, the total rounded up. Split back to the keysets
 * by their share, so the report can say which keyset's fees they were. */
function ruleFee(inputs) {
  const ppk = {};
  let total = 0;
  for (const x of inputs || []) {
    const f = KEYSET_PPK[x.id];
    if (f == null) { bump(ppk, '?' + String(x.id).slice(0, 12)); continue; }
    ppk[x.id] = (ppk[x.id] || 0) + f;
    total += f;
  }
  const fee = Math.ceil(total / 1000);
  const ids = Object.keys(ppk);
  const known = ids.filter((id) => id[0] !== '?');
  return { fee, total, ppk, known, unknown: ids.length - known.length };
}
function creditKeysets(r) {
  let given = 0;
  r.known.forEach((id, i) => {
    const part = i === r.known.length - 1 ? r.fee - given : Math.floor(r.fee * r.ppk[id] / (r.total || 1));
    given += part;
    // added, not bumped: bump counts a 0 as 1, and a mint that charges nothing would be credited a sat a swap
    S.feeByKeyset[id.slice(0, 16)] = (S.feeByKeyset[id.slice(0, 16)] || 0) + part;
  });
}

/* What a mint charged, read off a request it answered with 200. */
function countCharge(m, r, kind) {
  const at = letterOf(m.url);
  const C = S.mint[at];
  if (!C) return;
  try {
    const b = JSON.parse(m.body || '{}');
    const ins = sum((b.inputs || []).map((x) => Number(x.amount) || 0));
    if (/swap/.test(kind)) {
      const outs = sum((b.outputs || []).map((x) => Number(x.amount) || 0));
      C.swapFees += ins - outs;
      C.swaps++;
      const rule = ruleFee(b.inputs);
      creditKeysets(rule);
      // an input of a keyset the mint did not list, or a swap that took more or less than the rule
      if (ins - outs !== rule.fee || rule.unknown) S.feeRuleOff++;
    } else if (/^melt quote(?! check)/.test(kind)) {
      const a = JSON.parse(r.text || '{}');
      if (a && a.quote) S.meltQuotes[a.quote] = { amount: Number(a.amount) || 0, request: b.request || a.request || '' };
    } else if (/^melt(?! quote)/.test(kind)) {
      const a = JSON.parse(r.text || '{}');
      const rule = ruleFee(b.inputs);
      const q = S.meltQuotes[b.quote];
      const amount = q ? q.amount : null;
      C.melts++;
      if (amount == null || String(a.state || '').toUpperCase() !== 'PAID') {
        // not paid yet, or a quote this run never saw answered: the Lightning fee cannot be read here
        C.meltsUnread++;
        return;
      }
      const change = sum((a.change || []).map((x) => Number(x.amount) || 0));
      creditKeysets(rule);
      C.meltInputFees += rule.fee;
      const ln = ins - rule.fee - amount - change;
      C.lnFees += ln;
      // by the invoice it paid: a crossing knows its invoice, and pay() asks for a melt quote of its own
      S.melts[q.request || b.quote] = { at, quote: b.quote, inputFee: rule.fee, lnFee: ln, amount, change };
    } else if (/^mint(?! quote)/.test(kind)) {
      C.issued += sum((b.outputs || []).map((x) => Number(x.amount) || 0));
    }
  } catch (e) {}
}

/* A person's sender: what harness.boot calls for every mint request the page
 * makes (o.via for testnut, o.real.send for a real mint). */
function senderFor(p) {
  return async (m) => {
    const kind = kindOf(p, m);
    const group = p.group || 'same-mint';
    const key = m.method + ' ' + m.url + ' ' + (m.body || '');
    // the page asking once more after a 429: on a fresh circuit, and the person stays there
    const after429 = p.refused.has(key);
    const fresh = (code) => { if (code === 7 || p.fresh >= 3) return; p.fresh++; p.circuit = label(); };
    if (after429) { p.refused.delete(key); fresh(0); S.retry429++; }
    const end = Date.now() + BUDGET_MS;
    let r = await curl(m, p.circuit, BUDGET_MS);
    if (r.err) {
      const safe = BEFORE_IT_LEFT.has(r.code) || (m.method === 'GET' && LOST_ON_THE_WAY.has(r.code));
      bump(sub(S.failed, group), r.code === 28 ? 'timeout' : 'curl ' + r.code);
      fresh(r.code);
      if (safe && r.code !== 7 && end - Date.now() >= 10000) {
        S.retryNet++;
        r = await curl(m, p.circuit, end - Date.now());
        if (r.err) {
          S.retryNetFailed++;
          bump(sub(S.failed, group), r.code === 28 ? 'timeout' : 'curl ' + r.code);
          fresh(r.code);
        } else if (r.status !== 429 && r.status < 500) S.retryNetOk++;
        else S.retryNetFailed++;
      }
      if (r.err) throw new Error('curl ' + r.code + ': ' + r.why);
    }
    S.answered++;
    push(sub(S.times, group), kind, r.ms);
    if (r.status >= 400) bump(sub(S.failed, group), 'http ' + r.status + ' ' + kind);
    if (r.status === 429) { S.busy++; p.seen429++; p.refused.add(key); }
    if (after429) {
      if (r.status === 429) S.retry429Busy++;
      else if (r.status < 400) S.retry429Ok++;
      else S.retry429Failed++;
    }
    // what the mint charged
    if (r.status === 200) countCharge(m, r, kind.replace(/ @[AB?]$/, ''));
    return { status: r.status, text: r.text };
  };
}

/* A request of the run's own, not a page's: the Tor check, an exit, the
 * mint's info. Over Tor like the rest, on the person's circuit when one is
 * named, and asked again on a fresh circuit (three times in all) when the exit
 * fails it: an exit that answers with nothing is common, and it is a GET. */
async function ask(url, p) {
  let last = '';
  for (let i = 0; i < 3; i++) {
    const r = await curl({ method: 'GET', url }, p ? p.circuit : label(), 45000);
    if (!r.err && r.status === 200) return JSON.parse(r.text);
    last = r.err ? 'curl ' + r.code + ': ' + r.why : 'HTTP ' + r.status + ' from ' + url;
    bump(sub(S.failed, 'same-mint'), r.err ? (r.code === 28 ? 'timeout' : 'curl ' + r.code) : 'http ' + r.status);
    if (p && r.code !== 7 && p.fresh < 3) { p.fresh++; p.circuit = label(); }
  }
  throw new Error(last);
}

/* ---- the people --------------------------------------------------------- */
const people = [];
function person(n) {
  const home = TWO && n % 2 === 1 ? 'B' : 'A';
  const p = { n, name: 'person ' + n, home, circuit: label(), fresh: 0, refused: new Set(), seen429: 0, doing: '', group: 'same-mint',
              exit: '', b: null, W: null, feesAt: { A: 0, B: 0 }, crossFees: 0, sent: 0, got: 0 };
  const way = senderFor(p);
  // o.via in both cases: with real money too, a fake-money host the page names goes by curl, never fetch
  const o = { keychain: { words: '' }, via: way };
  if (REAL) o.real = { hosts: [HOST, HOST_B].filter(Boolean), send: way };
  p.b = H.boot(o);
  p.W = p.b.W;
  /* The page's own fetch (a price, a Lightning address: not a mint's) would
   * leave from this Mac without Tor. Refused, and counted. */
  p.b.w.fetch = (u) => { bump(S.pageFetch, (() => { try { return new URL(String(u && u.url || u)).hostname; } catch (e) { return '?'; } })());
                         return Promise.reject(new Error('no fetch from this Mac: everything goes over Tor')); };
  return p;
}
const atHome = (k) => people.filter((p) => p.home === k);

/* One wallet step, as the person would take it: if the mint turned it away as
 * too many (a 429, already asked once more on another circuit by the page),
 * wait and try the step again, twice at most. `once`: a step that must never
 * be run twice (a move: its melt may have gone), whatever the mint said. */
async function step(p, what, fn, quietIf, once) {
  for (let attempt = 1; ; attempt++) {
    const mark = p.seen429;
    p.doing = what;
    const group = p.group || 'same-mint';
    const t0 = Date.now();
    try {
      const v = await fn();
      push(sub(S.wallet, group), what, Date.now() - t0);
      if (attempt > 1) S.stepRetriesOk++;
      return { ok: true, v };
    } catch (e) {
      const why = String((e && e.message) || e).split('\n')[0].slice(0, 120);
      if (!once && p.seen429 > mark && attempt < 3) {
        S.stepRetries++;
        await sleep(attempt * 10000 + Math.floor(Math.random() * 3000));
        continue;
      }
      if (attempt > 1) S.stepRetriesFailed++;
      // a refusal the caller deals with itself is not counted as a failure here
      if (quietIf && quietIf.test(why)) return { ok: false, why, quiet: true, e };
      bump(sub(S.walletFailed, group), what + ': ' + why);
      return { ok: false, why, e };
    } finally { p.doing = ''; }
  }
}

/* The proofs a person holds at one mint, and their sum. */
function pileAt(p, k) {
  try { return JSON.parse(p.b.w.localStorage.getItem('foxy.cashu.proofs.' + URL_OF[k]) || '[]'); } catch (e) { return []; }
}
const balAt = (p, k) => Number(p.W.balanceAt(URL_OF[k])) || 0;
const hereOf = (p) => letterOf(p.W.mintUrl || '');

/* The most a person can send in one token: the amount whose token the pieces
 * held can make, the receiver's fee on them included (sendShortfall). At the
 * mint the person is connected to. */
function sendable(p, want) {
  for (let a = want; a >= 1; a--) {
    const s = p.W.sendShortfall(a);
    if (s && !s.short) return a;
  }
  return 0;
}
const balance = (p) => p.W.balanceSats();
/* Input fees the top-up swaps cost at a mint, which no history row shows
 * (topUpFeeSats): read for every mint, not only the one connected. */
function topUpsAt(p, k) {
  try {
    const all = JSON.parse(p.b.w.localStorage.getItem('foxy.cashu.topupfees') || '{}');
    let n = 0;
    for (const u of Object.keys(all)) if (letterOf(u) === k) n += Math.max(0, Math.round(Number(all[u]) || 0));
    return n;
  } catch (e) { return 0; }
}

/* A token of `sats` from p, at the mint p is connected to. Returns what happened.
 *
 * The wallet can say yes to an amount and then refuse it. `sendShortfall`
 * (what the confirmation asks) passes an amount the pieces held make exactly;
 * `sendToken` then swaps those pieces anyway when there are more than 24 of
 * them (a token of fewer pieces), and the swap's own fees no longer fit:
 * cashu-ts refuses with "Not enough funds available to send", locally, before
 * the mint is asked. A crowd of small payments piles up small pieces, so it
 * meets this. Counted (offeredThenRefused, with the amount and the pieces) and
 * then stepped down a sat at a time, ten at most, as a person would retry with
 * less: the run's figures must not stop at the wallet's own disagreement. */
const NOT_ENOUGH = /Not enough funds available to send/;
async function sendTo(p, sats, what) {
  const doing = what || 'send';
  const at = hereOf(p);
  let s = await step(p, doing, () => p.W.sendToken(sats), NOT_ENOUGH);
  for (let less = 1; !s.ok && s.quiet && less <= 10 && sats - less >= 1; less++) {
    if (less === 1) S.offeredThenRefused.push({ person: p.n, at, sats, pieces: pileAt(p, at).length, balance: await balance(p) });
    s = await step(p, doing, () => p.W.sendToken(sats - less), NOT_ENOUGH);
    if (s.ok) S.offeredThenRefused[S.offeredThenRefused.length - 1].went = sats - less;
  }
  if (!s.ok && s.quiet) bump(sub(S.walletFailed, p.group), doing + ': ' + s.why);
  if (!s.ok && process.env.FOXY_CROWD_DEBUG === '1') {
    const pr = pileAt(p, at);
    say('DEBUG ' + p.name + ' ' + doing + ' ' + sats + ' at ' + at + ' failed: ' + s.why + '; pile ' + pr.map((x) => x.amount + '@' + String(x.id).slice(0, 6)).join(',')
      + '; balance ' + (await balance(p)) + '; shortfall ' + JSON.stringify(p.W.sendShortfall(sats))
      + '; warn ' + p.b.rec.warn.slice(-3).join(' | '));
  }
  if (!s.ok) return { ok: false, why: s.why };
  const fee = Number(s.v.fee) || 0;
  p.feesAt[at] += fee;
  p.sent += s.v.sats;
  return { ok: true, token: s.v.token, sats: s.v.sats, fee, mint: at };
}
async function take(q, t) {
  const before = q.group;
  q.group = t.cross ? 'crossing' : 'same-mint';
  const r = await step(q, 'receive', () => q.W.receiveToken(t.token));
  q.group = before;
  if (!r.ok) return { ok: false, why: r.why };
  const got = Number(r.v && r.v.sats) || 0;
  q.feesAt[t.mint || 'A'] += Math.max(0, t.sats - got);
  q.got += got;
  t.taken = true;
  return { ok: true, got };
}

/* ---- a crossing --------------------------------------------------------- */
/* p pays q, who banks at the other mint, as the app does for a payer with a
 * route (build/app/26d-tap.js, `tapCrossQuote` then `crossRun`):
 *
 *   the quote   transferQuote(mine, want, { to: theirs, land: true }): the far
 *               mint's invoice for the figure plus its own fee to spend it,
 *               and our mint's melt quote for that invoice;
 *   the move    connect(mine), then moveRun(plan, …, { visit: true }): the
 *               melt here, the claim there, and the phone left there;
 *   the pay     a token of the figure, out of what landed (sendToken);
 *   home        connect(mine) again.
 *
 * The receiver then takes the token at its own mint (take, in the round).
 * A quote that says the payer holds too little is stepped down to what it
 * says fits, as the confirmation would offer; nothing fits is a skip, not a
 * failure. `o.moveOnly`: only the move, to the payer's own pile at the other
 * mint (the sweep bringing sats home), with no padding and no payment.
 * `o.from` / `o.to`: mints other than p's home and q's. Never throws. */
const SHORT = /costs up to .* and you hold/;
async function cross(p, q, want, o) {
  const opts = o || {};
  const from = opts.from || p.home;
  const to = opts.to || (q ? q.home : (from === 'A' ? 'B' : 'A'));
  const back = opts.back || p.home;
  const was = p.group;
  p.group = 'crossing';
  const t0 = Date.now();
  const row = { phase: opts.phase || '', payer: p.n, payee: q ? q.n : null, from, to, asked: want,
                moveOnly: !!opts.moveOnly, ok: false };
  S.crossings.push(row);
  // the whole step's time is taken once the payer is home again (below)
  const done = (r) => r;
  try {
    // the quote, stepped down to what fits
    let amount = want;
    let plan = null;
    for (let i = 0; i < 6 && amount >= 1; i++) {
      const s = await step(p, 'cross: quote', () => p.W.transferQuote(URL_OF[from], amount, { to: URL_OF[to], land: !opts.moveOnly }), SHORT);
      if (s.ok) { plan = s.v; break; }
      const fits = Number(s.e && s.e.foxyFits);
      if (s.quiet && fits >= 1 && fits < amount) { amount = fits; continue; }
      if (s.quiet) { row.skipped = 'too little to cross: ' + s.why; return done({ ok: false, skip: true, why: s.why }); }
      row.failedAt = 'quote'; row.why = s.why;
      return done({ ok: false, why: s.why, stage: 'quote' });
    }
    if (!plan) { row.skipped = 'too little to cross'; return done({ ok: false, skip: true, why: 'too little to cross' }); }
    row.amount = amount;
    row.quotedFee = plan.feeSats;
    row.padSats = plan.padSats;
    row.moving = plan.moving;
    // the move: connected to the mint the money leaves, then melt there and claim at theirs
    const m = await step(p, 'cross: move', () => p.W.connect(URL_OF[from]).then(() => p.W.moveRun(plan, () => {}, { visit: true })), null, true);
    /* The crossing's row in the payer's history: the melt of the far mint's
     * invoice. moveRun pays it through pay(), which asks for a melt quote of
     * its own, so it is found by the invoice and not by the plan's quote. */
    const inv = plan.mintQuote && plan.mintQuote.request;
    const tx = inv ? ((await p.W.transactions(500)) || []).find((e) => e && e.dir === 'out' && e.bolt11 === inv) : null;
    row.bookFee = tx ? Number(tx.feeSats) || 0 : null;
    if (tx) p.crossFees += row.bookFee;
    const melt = inv ? S.melts[inv] : null;
    if (melt) { row.lnFee = melt.lnFee; row.meltInputFee = melt.inputFee; row.change = melt.change; }
    if (!m.ok) {
      row.failedAt = 'move'; row.why = m.why;
      row.movePaid = !!(m.e && m.e.movePaid);
      row.pending = !!(m.e && m.e.pending);
      /* Paid here and not claimed there: the note is on file and finishMove
       * claims it from wherever the phone is, which is what the app does on
       * the next connection. Asked now, so the books can close. */
      if (row.movePaid) {
        try { await p.W.connect(URL_OF[to], null, null, { remember: false }); await p.W.finishMove(); } catch (e) {}
        row.claimedLater = !p.W.pendingMove();
      }
      return done({ ok: false, why: m.why, stage: 'move', movePaid: row.movePaid, pending: row.pending });
    }
    row.landed = Number(m.v && m.v.sats) || 0;
    if (opts.moveOnly) {
      row.ok = true;
      return done({ ok: true, moved: row.landed, mint: to });
    }
    // the pay, out of what landed, at their mint
    const can = sendable(p, amount);
    if (can < amount) {
      row.failedAt = 'pay'; row.why = 'the move landed ' + row.landed + ' and only ' + can + ' of ' + amount + ' can be sent';
      bump(sub(S.walletFailed, 'crossing'), 'cross: pay: the move landed too little to pay the figure');
      return done({ ok: false, why: row.why, stage: 'pay' });
    }
    const s = await sendTo(p, amount, 'cross: pay');
    if (!s.ok) { row.failedAt = 'pay'; row.why = s.why; return done({ ok: false, why: s.why, stage: 'pay' }); }
    row.payFee = s.fee;
    row.paid = s.sats;
    row.ok = true;
    return done(Object.assign(s, { cross: true }));
  } finally {
    // home, whatever happened: the crossing is Foxy's business, the mint the person banks at is theirs
    if (canon(p.W.mintUrl || '') !== URL_OF[back]) {
      const h = await step(p, 'cross: home', () => p.W.connect(URL_OF[back]), null, true);
      if (!h.ok) row.homeFailed = h.why;
    }
    row.ms = Date.now() - t0;
    if (row.ok) push(sub(S.wallet, 'crossing'), opts.moveOnly ? 'move home (whole step)' : 'cross (whole step)', row.ms);
    p.group = was;
  }
}

/* ---- the state, written as the run goes --------------------------------- */
/* Each person's counters and what they hold at each mint, as a token, and
 * every token in flight: enough to claim the money back if the run dies, with
 * no words. */
const inFlight = [];
let phase = 'start', funded = 0;
/* A token's face, read by the page's own decoder; null when it cannot read it. */
function faceOf(p, t) {
  try { const d = p.b.w.CashuTS.getDecodedToken(t); return sum((d.proofs || []).map((x) => Number(x.amount) || 0)); } catch (e) { return null; }
}
const untakenFromFile = [];   // tokens from --token the funder could not take: never funded, kept for the next run
function heldToken(p, k) {
  try {
    const pr = pileAt(p, k);
    if (!pr.length) return '';
    return p.b.w.CashuTS.getEncodedToken({ mint: URL_OF[k], proofs: pr, unit: 'sat' });
  } catch (e) { return ''; }
}
function saveState() {
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const data = { mint: MINT, mintB: MINT_B || undefined, real: REAL, started: STAMP, saved: new Date().toISOString(), phase, funded,
      people: people.map((p) => {
        const holds = {};
        for (const k of LETTERS) holds[k] = heldToken(p, k);
        let pending = null;
        try { pending = p.W.pendingMove(); } catch (e) {}
        return { name: p.name, home: p.home, counters: H.counters(p.b), holds,
                 crossingNotClaimed: pending ? { to: pending.to, quote: pending.quote, amount: pending.amount } : undefined };
      }),
      tokensInFlight: inFlight.filter((t) => !t.taken).map((t) => ({ from: t.from, to: t.to, mint: URL_OF[t.mint || 'A'], sats: t.sats, token: t.token })) };
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { say('could not save the state: ' + e.message); }
}

/* ---- the end ------------------------------------------------------------ */
const R = { mint: MINT, mintB: MINT_B || null, real: REAL, local: LOCAL, started: STAMP, people: PEOPLE, rounds: ROUNDS, bursts: BURST.length ? BURST : null, repeat: REPEAT, spread: SPREAD, pace: PACE, batch: BATCH, fund: FUND,
            min: MIN, max: MAX, stagger: STAGGER, cross: CROSS, socks: LOCAL ? null : SOCKS, mints: {} };
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  if (people.length) saveState();
  R.ended = new Date().toISOString();
  R.exitCode = code;
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(R, null, 2), { mode: 0o600 });
    console.log('report: ' + REPORT_FILE);
    console.log('state:  ' + STATE_FILE);
  } catch (e) { console.log('could not write the report: ' + e.message); }
  process.exit(code);
}

function crossingFees(all) {
  // a crossing the quote said would not fit was not tried: the sweep asks of every last few sats at B
  const rows = all.filter((c) => !c.skipped);
  const made = rows.filter((c) => c.ok);
  const book = made.map((c) => c.bookFee).filter((x) => x != null);
  const ln = made.map((c) => c.lnFee).filter((x) => x != null);
  const flat = {};
  for (const f of book) bump(flat, String(f));
  return { made: made.length, tried: rows.length, tooSmall: all.length - rows.length, bookFees: book, bookTotal: sum(book), lnTotal: sum(ln),
           byFee: flat, quotedTotal: sum(made.map((c) => Number(c.quotedFee) || 0)),
           payFees: sum(made.map((c) => Number(c.payFee) || 0)) };
}

function report() {
  R.requests = {}; R.walletSteps = {};
  for (const g of GROUPS) {
    R.requests[g] = {}; R.walletSteps[g] = {};
    for (const k of Object.keys(S.times[g] || {}).sort()) R.requests[g][k] = stats(S.times[g][k]);
    for (const k of Object.keys(S.wallet[g] || {}).sort()) R.walletSteps[g][k] = stats(S.wallet[g][k]);
  }
  R.roundsRun = S.rounds;
  R.failures = { byKind: S.failed, wallet: S.walletFailed };
  R.busy = { refused429: S.busy, askedAgainOnAnotherCircuit: S.retry429, thenAnswered: S.retry429Ok,
             thenRefusedAgain: S.retry429Busy, thenOtherError: S.retry429Failed,
             stepsWaitedAndTriedAgain: S.stepRetries, ofWhichSucceeded: S.stepRetriesOk, ofWhichFailed: S.stepRetriesFailed };
  R.network = { curlCalls: S.curl, answered: S.answered, askedAgainAfterFailure: S.retryNet,
                thenAnswered: S.retryNetOk, thenFailed: S.retryNetFailed, circuits: S.circuits.size,
                exitsAtStart: [...new Set(people.map((p) => p.exit).filter(Boolean))].length,
                pageRequests: Object.assign({}, H.netStats), pageFetchRefused: S.pageFetch };
  R.phone = Object.assign({}, H.nativeStats);
  R.offeredThenRefused = S.offeredThenRefused;
  R.crossings = S.crossings;
  R.crossingFees = crossingFees(S.crossings.filter((c) => !c.moveOnly));
  R.mintCharges = S.mint;

  const ms = (v) => (v == null ? '-' : fmt(v));
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  const line = (k, s) => console.log('  ' + pad(k, 30) + lpad(s.count, 7) + lpad(ms(s.median), 9) + lpad(ms(s.p90), 9) + lpad(ms(s.max), 9));
  console.log('\n---- the report ----');
  for (const k of LETTERS) {
    const m = R.mints[k] || {};
    console.log('mint ' + k + ': ' + URL_OF[k] + ' — ' + m.name + ', ' + m.version + ', input fee ' + m.feePpk + ' ppk (sat keyset ' + m.keyset + ')');
  }
  console.log(PEOPLE + ' people' + (TWO ? ' (' + atHome('A').length + ' at A, ' + atHome('B').length + ' at B)' : '') + ', '
    + ROUNDS + ' rounds, ' + FUND + ' sats each, ' + MIN + '-' + MAX + ' sats a send'
    + (TWO ? ', ' + Math.round(CROSS * 100) + '% of sends cross' : '')
    + (STAGGER ? ', up to ' + STAGGER + ' ms stagger' : '') + ', ' + WAY);
  if (R.fallback) console.log('NO CROSSINGS: ' + R.fallback);
  for (const g of GROUPS) {
    if (!TWO && g === 'crossing') continue;
    const steps = R.walletSteps[g], reqs = R.requests[g];
    if (!Object.keys(steps).length && !Object.keys(reqs).length) { console.log('\n' + g + ': none'); continue; }
    console.log('\n' + pad(g + ' (ms)', 32) + lpad('count', 7) + lpad('median', 9) + lpad('p90', 9) + lpad('max', 9));
    for (const k of Object.keys(steps)) line(k + (/whole step/.test(k) ? '' : ' (step)'), steps[k]);
    for (const k of Object.keys(reqs)) line(k, reqs[k]);
    console.log('  failures by kind: ' + (Object.keys(S.failed[g] || {}).length ? JSON.stringify(S.failed[g]) : 'none'));
    if (Object.keys(S.walletFailed[g] || {}).length) console.log('  wallet steps that failed: ' + JSON.stringify(S.walletFailed[g]));
  }
  if (R.burstRows && R.burstRows.length) {
    console.log('\nbursts (every take a swap at the mint, all at the same instant; again = refused takes that went when offered alone):');
    console.log('  ' + pad('size', 8) + lpad('tried', 6) + lpad('ok', 5) + lpad('lock', 6) + lpad('other', 7) + lpad('again', 7) + lpad('median', 9) + lpad('p90', 8) + lpad('max', 8) + lpad('swaps/s', 9));
    for (const r of R.burstRows) console.log('  ' + pad(String(r.size) + (REPEAT > 1 ? ' /' + r.repeat : ''), 8) + lpad(String(r.tried), 6) + lpad(String(r.ok), 5)
      + lpad(String(r.lock), 6) + lpad(String(r.other), 7) + lpad(String(r.retriedOk), 7) + lpad(fmt(r.medianMs), 9) + lpad(fmt(r.p90Ms), 8) + lpad(fmt(r.maxMs), 8) + lpad(String(r.perSecond), 9));
    const lw = R.burstRows.map((r) => r.lockWhy && r.lockWhy[0]).find(Boolean);
    if (lw) console.log('  the lock refusal, as the mint words it: ' + lw);
  }
  console.log('\nrounds:');
  for (const r of S.rounds) {
    console.log('  ' + pad(r.name, 9) + lpad(fmt(r.ms), 8) + ' ms  sends ' + r.sent + '/' + r.sends
      + (TWO ? ' (' + (r.crossed || 0) + ' crossings of ' + (r.crossTried || 0) + ')' : '')
      + (r.skipped ? ' (' + r.skipped + ' had too little)' : '') + ', receives ' + r.received + '/' + r.receives);
  }
  if (S.offeredThenRefused.length) {
    console.log('offered, then refused (sendShortfall yes, sendToken "Not enough funds"): ' + S.offeredThenRefused.length + ' — '
      + S.offeredThenRefused.slice(0, 8).map((x) => x.sats + ' of ' + x.balance + ' in ' + x.pieces + ' pieces'
        + (x.went ? ', ' + x.went + ' went' : ', nothing went')).join('; ') + (S.offeredThenRefused.length > 8 ? '; …' : ''));
  }
  if (TWO) {
    const f = R.crossingFees;
    console.log('crossings: ' + f.made + ' made of ' + f.tried + ' tried' + (f.tooSmall ? ' (and ' + f.tooSmall + ' too small to cross for the fee, not tried)' : '') + '; the fee each, as the payer’s books show it: '
      + (f.bookFees.length ? Object.keys(f.byFee).sort((a, b) => a - b).map((k) => f.byFee[k] + ' x ' + k + ' sats').join(', ') : 'none')
      + '; ' + f.bookTotal + ' in all, of which ' + f.lnTotal + ' Lightning (quoted at most ' + f.quotedTotal
      + '), and ' + f.payFees + ' more for the payments made at the far mint');
    if (R.firstCrossing) console.log('first crossing (funding): ' + R.firstCrossing.line);
    for (const k of LETTERS) {
      const c = S.mint[k];
      console.log('mint ' + k + ' charged: ' + c.swapFees + ' over ' + c.swaps + ' swaps, ' + c.meltInputFees + ' in melt input fees and '
        + c.lnFees + ' Lightning over ' + c.melts + ' melts' + (c.meltsUnread ? ' (' + c.meltsUnread + ' not read)' : '') + ', issued ' + c.issued);
    }
  }
  console.log('429s: ' + S.busy + '; asked again on another circuit ' + S.retry429 + ' (answered ' + S.retry429Ok
    + ', refused again ' + S.retry429Busy + ', other error ' + S.retry429Failed + '); steps waited and tried again '
    + S.stepRetries + ' (' + S.stepRetriesOk + ' succeeded, ' + S.stepRetriesFailed + ' failed)');
  console.log('network: ' + S.curl + ' curl calls ' + (LOCAL ? 'straight to this Mac' : 'through SOCKS') + ', ' + S.answered + ' answered; asked again after a failure '
    + S.retryNet + ' (' + S.retryNetOk + ' answered, ' + S.retryNetFailed + ' not)');
  if (!LOCAL) console.log('circuits used: ' + S.circuits.size + '; exits at the start: ' + R.network.exitsAtStart + ' for ' + PEOPLE + ' people');
  console.log('page requests by way: ' + JSON.stringify(H.netStats));
  if (R.balancesBeforeSweep) console.log('balances before the sweep: ' + R.balancesBeforeSweep.map((b, i) => i + ':' + LETTERS.map((k) => (TWO ? k : '') + b[k]).join('/')).join(' '));
  if (R.books) console.log('books: ' + R.books.line);
}

/* ---- funding by invoice ------------------------------------------------- */
async function fundByInvoice(p, want, what) {
  let inv;
  try { inv = await p.W.invoice(want, ''); } catch (e) { ok(false, 'an invoice for ' + want + ' sats at ' + p.home, e.message); return 0; }
  console.log('invoice for ' + fmt(want) + ' sats at ' + (TWO ? 'mint ' + p.home + ' ' : '') + '(' + what + ')');
  console.log('  quote ' + inv.hash);
  console.log('  ' + inv.bolt11);
  if (REAL) say('waiting for a person to pay it (30 minutes at most)');
  return new Promise((done) => {
    const limit = REAL ? 1800000 : 180000;
    const t = setTimeout(() => { stop(); done(0); }, limit);
    const stop = p.W.watch(inv.hash, (r) => { clearTimeout(t); done(Number(r.sats) || 0); },
      { pollMs: REAL ? 5000 : 3000, timeoutMs: limit, onError: () => {} });
  });
}

/* ---- the run ------------------------------------------------------------ */
(async () => {
  console.log('crowd: ' + PEOPLE + ' people at ' + MINT + (TWO ? ' and ' + MINT_B : '') + (REAL ? ' — REAL MONEY' : ' (fake money)') + ', ' + WAY);

  // Tor, or nothing
  if (LOCAL) {
    say('local: both mints are on this Mac, and nothing goes over Tor');
  } else {
    let tor;
    try { tor = await ask('https://check.torproject.org/api/ip'); } catch (e) { tor = { error: e.message }; }
    if (!ok(tor && tor.IsTor === true, 'Tor is up on 127.0.0.1:' + SOCKS, tor && tor.error ? tor.error : 'exit ' + (tor && tor.IP))) {
      say('refusing to run: nothing may go out except through Tor');
      return finish(1);
    }
  }

  // each mint, as it describes itself
  for (const k of LETTERS) {
    const url = URL_OF[k];
    const named = TWO ? 'mint ' + k + ' answers ' : 'the mint answers ';
    try {
      const info = await ask(url + '/v1/info');
      const ks = await ask(url + '/v1/keysets');
      const sat = (ks.keysets || []).filter((x) => x.unit === 'sat' && x.active);
      const m = R.mints[k] = {
        url, name: info.name || new URL(url).hostname, version: info.version || '?',
        feePpk: sat.length ? sat.map((x) => x.input_fee_ppk || 0).join('/') : '?',
        keyset: sat.length ? sat.map((x) => x.id.slice(0, 12)).join(',') : '?', keysets: ks.keysets,
      };
      for (const x of ks.keysets || []) KEYSET_PPK[x.id] = Number(x.input_fee_ppk) || 0;
      if (k === 'A') { R.mintName = m.name; R.mintVersion = m.version; R.feePpk = m.feePpk; R.keyset = m.keyset; R.keysets = m.keysets; }
      ok(sat.length > 0, named + (LOCAL ? 'here' : 'over Tor'), url + ': ' + m.name + ', ' + m.version + ', input fee ' + m.feePpk + ' ppk');
    } catch (e) {
      ok(false, named + (LOCAL ? 'here' : 'over Tor'), url + ': ' + e.message
        + (/curl 97: .*\(4\)/.test(e.message) ? ' (Tor’s exits could not reach it: the name does not resolve, or the host is down)' : ''));
      return finish(1);
    }
  }

  // the people, each on a circuit of their own, each connected to the mint it banks at
  for (let i = 0; i < PEOPLE; i++) people.push(person(i));
  if (!LOCAL) {
    await batched(people, async (p) => {
      try { p.exit = String((await ask('https://check.torproject.org/api/ip', p)).IP || ''); } catch (e) {}
    });
    const exits = new Set(people.map((p) => p.exit).filter(Boolean));
    ok(exits.size >= Math.min(PEOPLE, 2), PEOPLE + ' people on ' + exits.size + ' Tor exits', [...exits].length > 6 ? '' : [...exits].join(', '));
  }
  // BATCH at a time, and a second try for a person whose first connection timed out on the way up
  const conn = await batched(people, async (p) => {
    for (let tries = 0; ; tries++) {
      try { await p.W.seedReady(); await p.W.connect(URL_OF[p.home]); return true; }
      catch (e) { if (tries >= 1) return String(e.message || e).slice(0, 100); await sleep(1000); }
    }
  });
  const notIn = conn.filter((c) => c !== true);
  if (!ok(!notIn.length, 'every person connected' + (TWO ? ' to the mint they bank at (' + atHome('A').length + ' at A, ' + atHome('B').length + ' at B)' : '')
    + ', each with a seed on its own phone', notIn.length ? notIn.join('; ') : '')) return finish(1);
  setInterval(saveState, 3000).unref();
  saveState();

  /* ---- 1. funding ---- */
  phase = 'funding';
  const F = people[0];
  const groupA = atHome('A'), groupB = atHome('B');
  const headroom = 3 * PEOPLE + 10;
  // the first crossing's fee, which the funder pays: generous, since what is left over comes home at the end
  const crossHead = TWO ? Math.max(10, Math.ceil(groupB.length * FUND * 0.02)) + 3 * groupB.length : 0;
  let fundedA = 0, fundedB = 0;
  if (TOKEN_FILE) {
    // one token, or one per line: a run's sweep and the tokens it never took can fund the next
    const toks = fs.readFileSync(TOKEN_FILE, 'utf8').split('\n').map((x) => x.trim()).filter((x) => /^cashu[AB]/.test(x));
    if (!ok(toks.length > 0, 'the token file holds a token', TOKEN_FILE)) return finish(1);
    let tookN = 0; const whyNot = [];
    for (const t of toks) {
      if (tookN || untakenFromFile.length) { F.circuit = label(); await sleep(PACE); }   // each token from another exit, paced
      let r = null;
      // a take that fails on its exit (a timeout, a broken circuit) is tried again on another; one the mint
      // calls spent or pending is not: asking again would not change the answer
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) { F.circuit = label(); await sleep(PACE); S.tokenRetries++; }
        r = await step(F, 'receive', () => F.W.receiveToken(t));
        if (r.ok || /already been spent|is pending/.test(r.why)) break;
      }
      if (r.ok) { fundedA += Number(r.v.sats) || 0; tookN++; }
      else { whyNot.push(r.why); untakenFromFile.push({ token: t, sats: faceOf(F, t), why: r.why }); }
    }
    if (!ok(tookN > 0, 'the funder took the token' + (toks.length > 1 ? 's' : '') + ' in ' + TOKEN_FILE, tookN + ' of ' + toks.length + ', ' + fmt(fundedA) + ' sats' + (whyNot.length ? '; ' + whyNot.slice(0, 3).join('; ') : ''))) return finish(1);
    if (untakenFromFile.length) {
      // the run goes on with what came in; what did not is kept for the next run, and never counted as funded
      const left = sum(untakenFromFile.map((x) => x.sats || 0));
      fs.writeFileSync(UNTAKEN_FILE, untakenFromFile.map((x) => x.token).join('\n') + '\n', { mode: 0o600 });
      say(untakenFromFile.length + ' token' + (untakenFromFile.length > 1 ? 's' : '') + ' not taken (' + fmt(left) + ' sats, '
        + (S.tokenRetries ? S.tokenRetries + ' more tries on other exits' : 'no retry') + '): kept in ' + UNTAKEN_FILE + ' — ' + whyNot.slice(0, 3).join('; '));
      R.untakenFromFile = { count: untakenFromFile.length, sats: left, file: UNTAKEN_FILE, why: whyNot };
    }
  } else {
    const want = PEOPLE * FUND + headroom + crossHead;
    fundedA = await fundByInvoice(F, want, PEOPLE + ' x ' + FUND + ' + ' + headroom + ' for fees'
      + (crossHead ? ' + ' + crossHead + ' for the crossing to B' : ''));
    if (!ok(fundedA > 0, 'the invoice was paid and claimed', fundedA ? fmt(fundedA) + ' sats' : 'nothing was paid in')) {
      say('the wallet is empty: stopping');
      return finish(1);
    }
  }
  funded = fundedA;
  R.funded = funded;
  console.log('balance at the start: ' + fmt(await balance(F)) + ' sats with the funder, ' + fmt(funded) + ' came in');
  if (funded - crossHead < PEOPLE * FUND) {
    const each = Math.floor((funded - crossHead) / PEOPLE) - 3;
    if (each < MIN) { say('too little to share out (' + funded + ' sats for ' + PEOPLE + ' people): the wallet is as good as empty, stopping'); return finish(1); }
    say('shares cut to ' + each + ' sats each for the ' + funded + ' sats there are');
  }
  const share = Math.min(FUND, Math.floor((funded - crossHead) / PEOPLE) - 3);
  let crossOn = TWO && CROSS > 0;
  const fundRows = [];

  if (TWO) {
    /* The B people's half, crossed to person 1 in one go, as the app would
     * pay somebody at another mint. Reported on its own. */
    const P1 = people[1];
    const half = share * groupB.length;
    const t0x = Date.now();
    const c = await cross(F, P1, half, { phase: 'funding' });
    let took = null;
    if (c.ok) {
      inFlight.push(Object.assign(c, { from: 0, to: 1 }));
      took = await take(P1, c);
    }
    const row = S.crossings.find((x) => x.phase === 'funding') || {};
    R.firstCrossing = Object.assign({}, row, { took: took && took.ok, msWithReceive: Date.now() - t0x });
    R.firstCrossing.line = c.ok
      ? half + ' sats A -> B, ' + fmt(R.firstCrossing.msWithReceive) + ' ms with the receive (' + fmt(row.ms) + ' ms the payer’s step); '
        + 'fee ' + row.bookFee + ' in the payer’s books (' + (row.lnFee == null ? '?' : row.lnFee) + ' Lightning, '
        + (row.meltInputFee == null ? '?' : row.meltInputFee) + ' melt input fee), quoted at most ' + row.quotedFee
        + ', padding ' + row.padSats + '; ' + (took && took.ok ? took.got + ' taken at B' : 'NOT taken at B')
      : 'not made, at the ' + (row.failedAt || '?') + ': ' + (c.why || '?');
    ok(c.ok && took && took.ok, 'the funder crossed the B half to person 1, as the app pays somebody at another mint', R.firstCrossing.line);
    if (!c.ok) {
      if (c.movePaid || c.pending || row.claimedLater === false) {
        say('the money left A and did not arrive cleanly at B: no fallback, stopping (the state file has what is held)');
        return finish(1);
      }
      /* Nothing left A. The fallback: person 1 is funded by an invoice at B,
       * and no round makes a crossing. */
      R.fallback = 'the crossing from A to B could not be made (' + (row.failedAt || '?') + ': ' + (c.why || '?')
        + '); person 1 was funded by a second invoice at B, and the rounds made no crossings';
      console.log('FALLBACK: ' + R.fallback);
      crossOn = false;
      fundedB = await fundByInvoice(P1, half + 3 * groupB.length + 10, groupB.length + ' x ' + share + ' + fees, the fallback');
      if (!ok(fundedB > 0, 'the fallback invoice at B was paid and claimed', fundedB ? fmt(fundedB) + ' sats' : 'nothing was paid in')) return finish(1);
      funded += fundedB;
      R.funded = funded;
      R.fundedB = fundedB;
    }
    // person 1 shares it out at B
    const t0b = Date.now();
    const outB = await Promise.all(groupB.slice(1).map(async (q) => {
      const s = await sendTo(P1, share);
      if (s.ok) inFlight.push(Object.assign(s, { from: 1, to: q.n }));
      else say(P1.name + ' could not send ' + share + ' sats at B to ' + q.name + ': ' + s.why);
      return s.ok ? s : null;
    }));
    saveState();
    const inB = await Promise.all(outB.map(async (s) => {
      if (!s) return { ok: false };
      const r = await take(people[s.to], s);
      if (!r.ok) say(people[s.to].name + ' could not take ' + s.sats + ' sats at B from ' + P1.name + ' (the token is in the state file): ' + r.why);
      return r;
    }));
    const nB = inB.filter((x) => x.ok).length;
    ok(nB === groupB.length - 1, 'person 1 shared out ' + share + ' sats at B to each of ' + (groupB.length - 1),
       nB + ' taken, ' + fmt(Date.now() - t0b) + ' ms');
    fundRows.push({ sends: groupB.length - 1, sent: outB.filter(Boolean).length, received: nB, ms: Date.now() - t0b });
  }
  const t0f = Date.now();
  const sharesOut = await allOf(groupA.slice(1), async (q) => {
    if (BURST.length) F.circuit = label();   // the funder's hundred sends, each from another exit
    const s = await sendTo(F, share);
    if (s.ok) inFlight.push(Object.assign(s, { from: 0, to: q.n }));
    else say(F.name + ' could not send ' + share + ' sats' + (TWO ? ' at A' : '') + ' to ' + q.name + ': ' + s.why);
    return s.ok ? s : null;
  });
  saveState();
  const sharesIn = await allOf(sharesOut, async (s) => {
    if (!s) return { ok: false };
    const r = await take(people[s.to], s);
    if (!r.ok) say(people[s.to].name + ' could not take ' + s.sats + ' sats from ' + F.name + ' (the token is in the state file): ' + r.why);
    return r;
  });
  const fundedAll = sharesIn.filter((x) => x.ok).length;
  ok(fundedAll === groupA.length - 1, 'the funder shared out ' + share + ' sats' + (TWO ? ' at A' : '') + ' to each of ' + (groupA.length - 1),
     fundedAll + ' taken, ' + fmt(Date.now() - t0f) + ' ms');
  fundRows.push({ sends: groupA.length - 1, sent: sharesOut.filter(Boolean).length, received: fundedAll, ms: Date.now() - t0f });
  S.rounds.push({ name: 'funding', ms: sum(fundRows.map((x) => x.ms)), sends: sum(fundRows.map((x) => x.sends)),
                  sent: sum(fundRows.map((x) => x.sent)), receives: sum(fundRows.map((x) => x.sent)),
                  received: sum(fundRows.map((x) => x.received)), skipped: 0,
                  crossed: TWO && R.firstCrossing && R.firstCrossing.ok ? 1 : 0, crossTried: TWO ? 1 : 0 });
  saveState();

  /* ---- 2b. bursts: a ramp of simultaneous swaps at the mint ---- */
  async function bursts() {
    R.burstRows = [];
    const LOCKY = /failed to acquire database lock|database is locked|lock timeout|could not obtain lock/i;
    const pct = (a, q) => { if (!a.length) return 0; const z = a.slice().sort((x, y) => x - y); return z[Math.min(z.length - 1, Math.floor(q * z.length))]; };
    for (let rep = 1; rep <= REPEAT; rep++) {
      for (const size of BURST) {
        const chosen = people.filter((p) => balAt(p, 'A') >= MAX + 1).slice(0, size);
        if (chosen.length < size) say('burst of ' + size + ': only ' + chosen.length + ' people hold enough; using them');
        if (!chosen.length) { say('burst of ' + size + ': nobody holds enough, skipped'); continue; }
        // the sends, one after another: a token for each take
        const tokens = [];
        for (let i = 0; i < chosen.length; i++) {
          const p = chosen[i];
          const q = chosen.length > 1 ? chosen[(i + 1) % chosen.length] : people.find((x) => x !== p);
          const want = MIN + Math.floor(Math.random() * (MAX - MIN + 1));
          const amount = sendable(p, want);
          if (!amount) continue;
          const s = await sendTo(p, amount);
          if (!s.ok) { say(p.name + ' could not send ' + amount + ' sats for the burst: ' + s.why); continue; }
          const t = Object.assign(s, { from: p.n, to: q.n });
          inFlight.push(t);
          tokens.push(t);
        }
        saveState();
        // the burst: every take at the same instant
        const t0 = Date.now();
        const starts = [];
        const res = await Promise.all(tokens.map(async (t, i) => {
          if (SPREAD && i) await sleep(SPREAD * i);
          const st = Date.now(); starts.push(st);
          const g = await take(people[t.to], t);
          return { ok: g.ok, why: g.why || '', ms: Date.now() - st, t };
        }));
        const burstMs = Date.now() - t0;
        const okRes = res.filter((r) => r.ok);
        const lock = res.filter((r) => !r.ok && LOCKY.test(r.why));
        const other = res.filter((r) => !r.ok && !LOCKY.test(r.why));
        // the refused, offered again one at a time: nothing was spent, so they must go
        let retriedOk = 0;
        for (const r of res.filter((x) => !x.ok)) {
          await sleep(300);
          const g = await take(people[r.t.to], r.t);
          if (g.ok) retriedOk++;
          else say('burst of ' + size + ': ' + people[r.t.to].name + ' could not take ' + r.t.sats + ' sats even alone: ' + g.why);
        }
        const row = { repeat: rep, size, tried: tokens.length, ok: okRes.length, lock: lock.length, other: other.length, retriedOk,
                      medianMs: pct(okRes.map((r) => r.ms), 0.5), p90Ms: pct(okRes.map((r) => r.ms), 0.9),
                      maxMs: res.length ? Math.max(...res.map((r) => r.ms)) : 0, burstMs,
                      spreadMs: starts.length ? Math.max(...starts) - Math.min(...starts) : 0,
                      perSecond: burstMs ? Math.round(okRes.length * 10000 / burstMs) / 10 : 0,
                      otherWhy: other.slice(0, 3).map((r) => r.why.slice(0, 160)),
                      lockWhy: lock.slice(0, 1).map((r) => r.why.slice(0, 200)) };
        R.burstRows.push(row);
        saveState();
        console.log('burst ' + String(size).padStart(3) + (REPEAT > 1 ? ' (' + rep + ')' : '') + ': ' + row.tried + ' swaps at once, ' + row.ok + ' ok, '
          + row.lock + ' refused by the lock, ' + row.other + ' other; median ' + fmt(row.medianMs) + ' ms, p90 ' + fmt(row.p90Ms) + ' ms, max ' + fmt(row.maxMs)
          + ' ms; ' + row.perSecond + ' swaps/s over ' + fmt(burstMs) + ' ms'
          + (row.lock + row.other ? '; offered again alone: ' + retriedOk + ' of ' + (row.lock + row.other) + ' taken' : ''));
        for (const w of row.otherWhy) say('  other: ' + w);
      }
    }
    const tried = R.burstRows.reduce((a, r) => a + r.tried, 0);
    S.rounds.push({ name: 'bursts', ms: R.burstRows.reduce((a, r) => a + r.burstMs, 0), sends: tried, sent: tried, skipped: 0,
                    receives: tried, received: R.burstRows.reduce((a, r) => a + r.ok + r.retriedOk, 0), crossed: 0, crossTried: 0 });
  }

  /* ---- 2. rounds ---- */
  phase = 'rounds';
  if (BURST.length) await bursts();
  for (let r = 1; r <= (BURST.length ? 0 : ROUNDS); r++) {
    const t0 = Date.now();
    let skipped = 0, crossTried = 0;
    const sends = await Promise.all(people.map(async (p) => {
      if (STAGGER) await sleep(Math.floor(Math.random() * STAGGER));
      const same = people.filter((q) => q !== p && q.home === p.home);
      const other = crossOn ? people.filter((q) => q.home !== p.home) : [];
      const crossing = other.length > 0 && (!same.length || Math.random() < CROSS);
      const pool = crossing ? other : same;
      if (!pool.length) { skipped++; return null; }
      const q = pool[Math.floor(Math.random() * pool.length)];
      const want = MIN + Math.floor(Math.random() * (MAX - MIN + 1));
      if (!crossing) {
        const amount = sendable(p, want);
        if (!amount) { skipped++; return null; }
        const s = await sendTo(p, amount);
        if (!s.ok) return { failed: true, line: p.name + ' could not send ' + amount + ' sats' + (TWO ? ' at ' + p.home : '') + ' to ' + q.name + ': ' + s.why };
        const t = Object.assign(s, { from: p.n, to: q.n });
        inFlight.push(t);
        return t;
      }
      crossTried++;
      const c = await cross(p, q, want, { phase: 'round ' + r });
      if (c.skip) { crossTried--; skipped++; return null; }
      if (!c.ok) {
        const row = S.crossings.filter((x) => x.payer === p.n && x.phase === 'round ' + r).pop() || {};
        return { failed: true, cross: true, line: p.name + ' could not cross ' + (row.amount || want) + ' sats ' + p.home + ' -> ' + q.home + ' to ' + q.name
          + ', at the ' + (c.stage || '?') + ': ' + c.why
          + (c.movePaid ? ' (' + (row.moving || '?') + ' sats left ' + p.home + (row.claimedLater ? ' and are with ' + p.name + ' at ' + q.home + ', to be swept home' : ' and are NOT yet claimed at ' + q.home) + ')' : '')
          + (c.pending ? ' (the melt may still be going through: the ecash is held)' : '') };
      }
      const t = Object.assign(c, { from: p.n, to: q.n });
      inFlight.push(t);
      return t;
    }));
    saveState();
    const made = sends.filter((s) => s && !s.failed);
    const lostTakes = [];
    const got = await Promise.all(people.map(async (q) => {
      let n = 0;
      for (const t of made.filter((x) => x.to === q.n)) {
        const g = await take(q, t);
        if (g.ok) n++;
        else lostTakes.push(q.name + ' could not take ' + t.sats + ' sats' + (t.cross ? ' (a crossing)' : '') + ' at ' + (t.mint || 'A') + ' from person ' + t.from + ': ' + g.why);
      }
      return n;
    }));
    const crossed = made.filter((t) => t.cross).length;
    const row = { name: 'round ' + r, ms: Date.now() - t0, sends: PEOPLE, sent: made.length, skipped,
                  receives: made.length, received: sum(got), crossed, crossTried };
    S.rounds.push(row);
    saveState();
    const held = sum(people.map((p) => sum(LETTERS.map((k) => balAt(p, k)))));
    console.log('round ' + r + ': ' + fmt(row.ms) + ' ms, ' + row.sent + ' of ' + PEOPLE + ' sent'
      + (TWO ? ' (' + crossed + ' crossings of ' + crossTried + ' tried)' : '')
      + (skipped ? ' (' + skipped + ' had too little)' : '') + ', ' + row.received + ' of ' + row.receives
      + ' received; ' + fmt(held) + ' sats held by everyone, ' + S.busy + ' 429s so far');
    if (row.sent + skipped < PEOPLE) {
      ok(false, 'round ' + r + ': every send that could be made was made', (PEOPLE - row.sent - skipped) + ' failed');
      for (const f of sends.filter((x) => x && x.failed)) say(f.line);
    }
    if (row.received < row.receives) {
      ok(false, 'round ' + r + ': every token was taken in its round', (row.receives - row.received) + ' not taken (tried again before the sweep)');
      for (const l of lostTakes) say(l);
    }
    if (held === 0) { say('everyone is empty: stopping the rounds'); break; }
  }

  /* ---- 3. the end ---- */
  phase = 'sweep';
  R.balancesBeforeSweep = people.map((p) => { const b = {}; for (const k of LETTERS) b[k] = balAt(p, k); return b; });
  /* A crossing paid at one mint and not yet claimed at the other (a move that
   * failed half way): claimed now, as the app does on its next connection
   * (finishMove), so the sweep brings it home. One left unclaimed stays in the
   * books as such and in the state file, and is named. */
  for (const p of people) {
    let n = null;
    try { n = p.W.pendingMove(); } catch (e) {}
    if (!n) continue;
    const f = await step(p, 'cross: finish', () => p.W.finishMove(), null, true);
    let still = null;
    try { still = p.W.pendingMove(); } catch (e) {}
    say(p.name + ': a crossing of ' + n.amount + ' sats to ' + letterOf(n.to) + ' not yet claimed — '
      + (still ? 'STILL NOT CLAIMED (' + (f.ok ? 'the mint has not issued it' : f.why) + '; quote in the state file)' : 'claimed now, ' + (f.v || 0) + ' sats'));
  }
  // a token never taken is taken now, before the sweep
  const late = inFlight.filter((t) => !t.taken);
  for (const t of late) await take(people[t.to], t);
  if (late.length) say(late.length + ' token(s) not taken in their round taken now: ' + late.filter((t) => t.taken).length);
  /* A send that fails here loses nothing: the pieces stay in that person's
   * wallet (and, as a token, in the state file), the books count them as left
   * with others, and the person is named. Sats at B cross to the funder at A,
   * the payer moving them and paying from A; then what is held at A goes to
   * the funder as a token. A sum too small to cross for its fee stays at B. */
  let sweepFailed = 0;
  const sweepWhy = [];
  const tooSmall = [];
  const back = await allOf(people.slice(1), async (p) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      let moved = false;
      const atB = TWO ? balAt(p, 'B') : 0;
      if (atB > 0) {
        const c = await cross(p, F, atB, { phase: 'sweep', from: 'B', to: 'A', back: 'A' });
        if (c.ok) { inFlight.push(Object.assign(c, { from: p.n, to: 0 })); out.push(c); moved = true; }
        else if (c.skip) tooSmall.push(p.name + ' ' + atB + ' at B');
        else { sweepFailed++; sweepWhy.push(p.name + ' (' + atB + ' sats at B): the crossing failed at the ' + c.stage + ': ' + c.why); }
      }
      if (canon(p.W.mintUrl || '') !== MINT) {
        const h = await step(p, 'connect', () => p.W.connect(MINT), null, true);
        if (!h.ok) { sweepFailed++; sweepWhy.push(p.name + ': could not connect to A: ' + h.why); break; }
      }
      const bal = await balance(p);
      const amount = bal > 0 ? sendable(p, bal) : 0;
      if (amount) {
        const s = await sendTo(p, amount);
        if (!s.ok) { sweepFailed++; sweepWhy.push(p.name + ' (' + bal + ' sats at A): ' + s.why); break; }
        inFlight.push(Object.assign(s, { from: p.n, to: 0 }));
        out.push(s);
        moved = true;
      }
      if (!moved) break;
    }
    return out;
  });
  // the funder's own sats at B (padding left from its crossing) come home too, a move and no payment
  if (TWO && balAt(F, 'B') > 0) {
    const atB = balAt(F, 'B');
    const c = await cross(F, null, atB, { phase: 'sweep', from: 'B', to: 'A', back: 'A', moveOnly: true });
    if (c.skip) tooSmall.push(F.name + ' ' + atB + ' at B');
    else if (!c.ok) { sweepFailed++; sweepWhy.push(F.name + ' (' + atB + ' sats at B): the move home failed at the ' + c.stage + ': ' + c.why); }
  }
  if (canon(F.W.mintUrl || '') !== MINT) await step(F, 'connect', () => F.W.connect(MINT), null, true);
  saveState();
  const backTokens = [].concat(...back);
  let backIn = 0;
  for (const t of backTokens) {
    F.circuit = label();   // the funder takes everyone's balance back, each from another exit
    if (BURST.length) await sleep(PACE);
    const r = await take(F, t);
    if (r.ok) backIn++;
    else sweepWhy.push('the funder could not take ' + t.sats + ' sats from person ' + t.from + ' (the token is in the state file): ' + r.why);
  }
  ok(backIn === backTokens.length && !sweepFailed, 'everyone sent their balance back to the funder' + (TWO ? ' at A' : ''),
     backTokens.length + ' tokens sent' + (TWO ? ' (' + backTokens.filter((t) => t.cross).length + ' of them crossings from B)' : '')
     + ', ' + backIn + ' taken' + (sweepFailed ? ', ' + sweepFailed + ' could not send' : ''));
  for (const w of sweepWhy) say(w);
  if (tooSmall.length) say('too little to cross home for its fee, left at B: ' + tooSmall.join(', '));
  R.sweepFailures = sweepWhy;
  R.leftAtBTooSmall = tooSmall;
  saveState();

  /* The books: what came in = everyone's balance at A and at B + every fee
   * paid at A + at B + the crossings' Lightning fees, to the sat. Counted the
   * wallets' way (a send's swap, a receive's swap, top-ups, and each
   * crossing's fee as its history entry shows it) and the mints' way (what
   * each swap and melt the mints answered took), and the two must agree. */
  const bals = people.map((p) => { const b = {}; for (const k of LETTERS) b[k] = balAt(p, k); return b; });
  const fb = bals[0].A;
  const heldAt = {};
  for (const k of LETTERS) heldAt[k] = sum(bals.map((b) => b[k]));
  const leftWithOthers = sum(bals.map((b, i) => sum(LETTERS.map((k) => b[k])) - (i === 0 ? fb : 0)));
  const feesAt = {};
  for (const k of LETTERS) feesAt[k] = sum(people.map((p) => p.feesAt[k] + topUpsAt(p, k)));
  const crossBook = sum(people.map((p) => p.crossFees));
  const walletFees = sum(LETTERS.map((k) => feesAt[k])) + crossBook;
  const mintAt = {};
  for (const k of LETTERS) mintAt[k] = S.mint[k].swapFees + S.mint[k].meltInputFees;
  const lnFees = sum(LETTERS.map((k) => S.mint[k].lnFees));
  const mintFees = sum(LETTERS.map((k) => mintAt[k])) + lnFees;
  const unread = sum(LETTERS.map((k) => S.mint[k].meltsUnread));
  const untaken = sum(inFlight.filter((t) => !t.taken).map((t) => t.sats));
  // a crossing paid at one mint and not yet claimed at the other: the note's amount, still owed to its payer
  const inMoves = sum(people.map((p) => { try { const n = p.W.pendingMove(); return n ? Number(n.amount) || 0 : 0; } catch (e) { return 0; } }));
  const off = funded - (sum(LETTERS.map((k) => heldAt[k])) + walletFees + untaken + inMoves);
  const offMint = funded - (sum(LETTERS.map((k) => heldAt[k])) + mintFees + untaken + inMoves);
  let line;
  if (!TWO) {
    line = fmt(funded) + ' in = ' + fmt(fb) + ' with the funder'
      + (leftWithOthers ? ' + ' + leftWithOthers + ' left with others (too small to send)' : '')
      + ' + ' + fmt(walletFees) + ' in fees (as the wallets count them; the mint charged ' + fmt(S.mint.A.swapFees) + ' over ' + S.mint.A.swaps + ' swaps)'
      + (untaken ? ' + ' + untaken + ' in tokens never taken' : '')
      + (off ? ' — OFF BY ' + off : ' — adds up');
  } else {
    line = fmt(funded) + ' in' + (fundedB ? ' (' + fundedA + ' at A, ' + fundedB + ' at B)' : '') + ' = '
      + fmt(heldAt.A) + ' held at A (' + fmt(fb) + ' with the funder) + ' + fmt(heldAt.B) + ' held at B'
      + ' + ' + mintAt.A + ' in fees at A + ' + mintAt.B + ' in fees at B + ' + lnFees + ' Lightning for ' + S.crossings.filter((c) => c.ok).length + ' crossings'
      + (untaken ? ' + ' + untaken + ' in tokens never taken' : '')
      + (inMoves ? ' + ' + inMoves + ' in crossings not yet claimed' : '')
      + (offMint ? ' — OFF BY ' + offMint : ' — adds up')
      + '; the wallets’ own books: ' + feesAt.A + ' at A + ' + feesAt.B + ' at B + ' + crossBook + ' for the crossings = ' + walletFees
      + (off ? ' — OFF BY ' + off : ' — adds up');
  }
  const byKeyset = sum(Object.values(S.feeByKeyset));
  const inputFees = sum(LETTERS.map((k) => mintAt[k]));
  R.books = { funded, fundedA, fundedB, funder: fb, heldAt, leftWithOthers, feesAt, crossBook, walletFees, mintAt, lnFees, mintFees,
              mintCharges: S.mint, feeByKeyset: S.feeByKeyset, swapsOffTheRule: S.feeRuleOff, meltsNotRead: unread,
              untaken, inMoves, off, offMint, line };
  ok(off === 0 && offMint === 0 && untaken === 0 && inMoves === 0 && !unread, 'the books add up to the sat', line);
  ok(walletFees === mintFees, 'the wallets’ fees are what the mint' + (TWO ? 's' : '') + ' charged', walletFees + ' and ' + mintFees);
  ok(byKeyset === inputFees && S.feeRuleOff === 0, 'every swap' + (TWO ? ' and melt' : '') + ' paid its inputs’ keysets’ fee' + (TWO ? '' : ' and no more'),
     'by keyset ' + JSON.stringify(S.feeByKeyset) + ' = ' + byKeyset + ', charged ' + inputFees
     + (S.feeRuleOff ? ', ' + S.feeRuleOff + ' swap(s) off the rule' : ''));

  /* The funder's balance at A swept out to a token, in the run's folder. */
  phase = 'swept';
  if (canon(F.W.mintUrl || '') !== MINT) await step(F, 'connect', () => F.W.connect(MINT), null, true);
  const all = fb > 0 ? sendable(F, fb) : 0;
  const feesBeforeSweep = F.feesAt.A;
  if (all) {
    const s = await sendTo(F, all);
    if (ok(s.ok, 'the funder’s balance' + (TWO ? ' at A' : '') + ' swept to a token', s.ok ? s.sats + ' sats in ' + SWEEP_FILE : s.why)) {
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(SWEEP_FILE, s.token + '\n', { mode: 0o600 });
      R.sweep = { sats: s.sats, mint: MINT, file: SWEEP_FILE };
    }
  }
  R.balanceAtEnd = balAt(F, 'A');
  if (TWO) R.balanceAtEndB = balAt(F, 'B');
  if (R.sweep) {
    const fee = fb - R.sweep.sats - R.balanceAtEnd;
    R.sweep.feeSats = fee;
    ok(fee >= 0 && fee === F.feesAt.A - feesBeforeSweep, 'the sweep adds up', fmt(fb) + ' = ' + fmt(R.sweep.sats) + ' in the token + ' + fee + ' to the mint for the swap + ' + R.balanceAtEnd + ' left');
  }
  console.log('balance at the end: ' + fmt(R.balanceAtEnd) + ' sats in the funder’s wallet' + (TWO ? ' at A, ' + fmt(R.balanceAtEndB) + ' at B' : '')
    + (R.sweep ? ', ' + fmt(R.sweep.sats) + ' sats in the token' : ''));

  /* Everything at A that the next run can take, one token a line: the sweep
   * token (or the funder's pile as it stands when the sweep could not swap),
   * what others still hold at A, the tokens in flight nobody took, and the
   * tokens from --token the funder could not take. Money at B is not in it:
   * the funder takes at A. */
  const leftover = [];
  if (R.sweep) leftover.push({ sats: R.sweep.sats, token: fs.readFileSync(SWEEP_FILE, 'utf8').trim(), what: 'the sweep' });
  else if (balAt(F, 'A') > 0) leftover.push({ sats: balAt(F, 'A'), token: heldToken(F, 'A'), what: 'the funder’s pile, unswapped' });
  for (let i = 1; i < people.length; i++) if (balAt(people[i], 'A') > 0) leftover.push({ sats: balAt(people[i], 'A'), token: heldToken(people[i], 'A'), what: 'person ' + i + '’s pile' });
  for (const t of inFlight) if (!t.taken && (t.mint || 'A') === 'A') leftover.push({ sats: t.sats, token: t.token, what: 'in flight, never taken' });
  for (const x of untakenFromFile) leftover.push({ sats: x.sats || 0, token: x.token, what: 'from the token file, not taken' });
  const leftoverOk = leftover.filter((x) => x.token);
  if (leftoverOk.length) {
    fs.writeFileSync(LEFTOVER_FILE, leftoverOk.map((x) => x.token).join('\n') + '\n', { mode: 0o600 });
    R.leftover = { sats: sum(leftoverOk.map((x) => x.sats)), tokens: leftoverOk.length, file: LEFTOVER_FILE, parts: leftoverOk.map((x) => ({ sats: x.sats, what: x.what })) };
    say('left over at A for the next run: ' + fmt(R.leftover.sats) + ' sats in ' + leftoverOk.length + ' token' + (leftoverOk.length > 1 ? 's' : '') + ' — ' + LEFTOVER_FILE
      + ' (' + leftoverOk.map((x) => x.sats + ' ' + x.what).join(', ') + ')');
  }
  if (TWO && heldAt.B > 0) say('left at B: ' + fmt(heldAt.B) + ' sats (in the state file, not in the leftover file)');

  ok(H.netStats.fetch === 0, 'no mint request went out by fetch from this Mac',
     H.netStats.fetch + ' by fetch, ' + (H.netStats.via + H.netStats.real) + ' by curl ' + (LOCAL ? 'straight to this Mac' : 'through SOCKS 127.0.0.1:' + SOCKS)
     + '; a page’s own fetch refused ' + sum(Object.values(S.pageFetch)) + ' time(s)'
     + (Object.keys(S.pageFetch).length ? ' ' + JSON.stringify(S.pageFetch) : ''));
  const phoneClean = H.nativeStats.wordsAsked === 0 && H.nativeStats.pageSeedDerivations === 0 && H.nativeStats.tooFarAhead === 0;
  ok(phoneClean, 'no page asked for the words or moved a counter too far', H.phoneReport());
  report();
  if (process.env.FOXY_CROWD_DEBUG === '1') {
    const said = {};
    for (const p of people) for (const x of p.b.rec.mintSaid) bump(said, x.replace(/[0-9a-f-]{20,}/gi, ':id').slice(0, 140));
    say('DEBUG what the mints refused: ' + JSON.stringify(said));
  }
  console.log('\n' + (failures ? 'FAIL  ' + failures + ' check(s) failed' : 'OK    the crowd ran and the books add up'));
  finish(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL  the run stopped: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); finish(1); });
