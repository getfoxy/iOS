'use strict';
/* offline-cross-scenarios.js — offline and cross-mint payments that the other
 * live suites have never run, at the same pair of mints tap-scenarios.js uses.
 *
 *   sh tools/live/mint-pair.sh up          (and pending-mint.sh up for `pend-payer`)
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/offline-cross-scenarios.js [id ...]
 *
 * With no argument every scenario runs; an argument is a scenario id, or the
 * start of one (`carry` runs every carry-home scenario). FOXY_OCX_DEBUG=1
 * prints each phone's entries beside the checks.
 *
 *   rev-po rev-ro                 the reverse crossings, into the mint that charges
 *   rx-lost payer-restore         a phone lost before it came online; the words
 *   replay-off replay-claimed     the same locked ecash handed over again
 *   multi-rx                      one offline payer, three receivers
 *   fwd-locked fwd-kill fwd-refuse fwd-cut
 *                                 paying out of ecash still locked to the payer
 *   rx-many                       three payers, one offline receiver, a claim cut
 *   ln-drop                       the payer's route lost between quote and payment
 *   carry-drop carry-wake carry-twice
 *                                 the receiver carrying it home, cut part-way
 *   move-cut move-twice move-fail the payer moving it there, cut part-way
 *   over-cut                      an over-payment for a tap, shown as a code instead
 *   edge-ln edge-move edge-carry  just enough, and a sat short, on each rail
 *   pend-payer                    the payer's mint leaves the melt PENDING
 *   one-side-a one-side-b         a mint only one of the two can reach
 *
 * tap-scenarios.js covers the plain cases of every rail and one fault at each
 * step. This file starts where it stops:
 *
 *   the reverse crossings        minibits to macadamia, each side offline in turn
 *   a phone that is lost         a receiver holding locked ecash it never swapped,
 *                                and a payer that paid offline, each restored from
 *                                their twelve words on a new phone
 *   the same ecash twice         a locked token handed over again, to a receiver
 *                                that is offline, before and after it claimed it
 *   chains with no connection    one offline payer and three receivers; an offline
 *                                phone paying with ecash that is still locked to
 *                                it; three payers and one offline receiver
 *   the route going mid-payment  not a kill: the radio goes and comes back
 *   a crossing cut in the middle after the Lightning payment and before the claim,
 *                                and what the next crossing does to it
 *   the edges                    just enough and one sat short, on each rail
 *   a mint only one side reaches
 *
 * What differs from tap-scenarios.js, on purpose:
 *
 *   The link's answer is what the phone sends. M6 is `{"v":2,"ok":true,"code":200}`
 *   or `{"ok":false,"code":422,"why":…}` (TapLink.swift `sealResult`), and
 *   `tapSend` reads exactly that: a refusal is a refusal with its words, 409 and
 *   504 are "nobody confirmed". Change handed back is answered when the payer
 *   says it kept it (M8), not when the bytes have gone (FoxyBridge+Tap.swift).
 *
 *   An app opened again connects to the mint it was last on, as the app does
 *   (06-wallet-boot-and-restore.js: `retryConnect(saved ? undefined : default)`),
 *   not to the mint the test thinks of as home. Every `connect` a rail makes is
 *   the call the app makes, with the app's arguments, so what is saved as "the
 *   mint this phone is on" is what the app would have saved.
 *
 * For every scenario the questions are: did the receiver get what
 * it asked for, what did it cost the payer and is that on its entries, is
 * anything left in between once both apps are open again with a connection,
 * do both phones' entries add up — and the mint is asked whether what each
 * phone shows is still spendable. And what each person was TOLD at the time.
 *
 * Fake money only. The fake Lightning backend settles every invoice by itself
 * a second after it is made, paid or not; where that would hand a phone money
 * nobody sent, the scenario says so and keeps it out of the sums. */
const H = require('./harness');

const WATCHDOG_S = Number(process.env.FOXY_OCX_WATCHDOG_S) || 3300;
let FINISHED = false;
setTimeout(() => { console.log('\nWATCHDOG ' + WATCHDOG_S + 's: the run did not finish'); process.exit(2); }, WATCHDOG_S * 1000).unref();
// a promise nobody will ever resolve empties the event loop and node leaves with 0: that is not a pass
process.on('exit', (code) => {
  if (!FINISHED && code === 0) { console.log('\nENDED EARLY: the run stopped before its summary'); process.exitCode = 3; }
});
process.on('unhandledRejection', () => {});

const MAC = 'https://127.0.0.1:8473';       // macadamia-like: cdk-mintd 0.18.1, 150 ppk
const MB = 'https://127.0.0.1:8474';        // minibits-like: cdk-mintd 0.17.7, no fee
const PEND = 'https://127.0.0.1:8445';      // Nutshell whose melts stay PENDING, 100 ppk
/* Real mints, with real money: only the `real-` scenarios at the foot of
 * this file, and only when the run is started with FOXY_LIVE_REAL=1
 * (tools/live/production.md has the rules). Reached through Tor, as the app
 * reaches them. Three by default, and every pair of them is crossed both
 * ways; FOXY_REAL_MINTS names another set, the first being the one the money
 * comes in at and goes out from.
 *
 * FOXY_REAL_DRY=1 is a rehearsal: the same scenarios against the fake-money
 * mints on this Mac, with wallets kept in a temporary folder, so a change to
 * them is run for nothing before it is run for money. */
const REAL_DRY = process.env.FOXY_REAL_DRY === '1';
const REAL = process.env.FOXY_LIVE_REAL === '1' || REAL_DRY;
const REAL_URLS = (REAL_DRY ? [MB, 'https://127.0.0.1:8444', MAC]
  : (process.env.FOXY_REAL_MINTS || 'https://mint.minibits.cash/Bitcoin,https://forge.flashapp.me,https://mint.macadamia.cash').split(','))
  .map((u) => String(u).trim().replace(/\/+$/, '')).filter(Boolean);
const REAL_NAMES = REAL_DRY ? ['minibits-like', 'forge-like', 'macadamia-like']
  : REAL_URLS.map((u) => new URL(u).hostname.replace(/^mint\./, '').split('.')[0]);
// a mint that charges for every piece spent: figures there are a sat or two either side
const REAL_CHARGES = {};
REAL_URLS.forEach((u, i) => { REAL_CHARGES[u] = REAL_DRY ? i > 0 : /macadamia/.test(u); });
const RA = REAL_URLS[0];
const ALL = REAL ? REAL_URLS : [MAC, MB, PEND];
const NAME = {};
if (REAL) REAL_URLS.forEach((u, i) => { NAME[u] = REAL_NAMES[i]; });
else { NAME[MAC] = 'macadamia'; NAME[MB] = 'minibits'; NAME[PEND] = 'pending-mint'; }
const canon = (u) => String(u || '').replace(/\/+$/, '');
const nameOf = (u) => NAME[canon(u)] || canon(u).replace(/^https?:\/\//, '');
const only = process.argv.slice(2);
const DEBUG = process.env.FOXY_OCX_DEBUG === '1';

const R = { pass: 0, fail: 0, table: [], failed: [], scen: [], notes: [] };
let SCEN = '';
const ok = (name, good, detail) => {
  console.log((good ? '  OK    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (good) R.pass++; else { R.fail++; R.failed.push(SCEN + ': ' + name + (detail ? ' — ' + detail : '')); }
  return !!good;
};
const say = (s) => console.log('         ' + s);
/* A check that fails only by a finding already written up (tap-scenarios.js)
 * is said as that and is not this suite's failure: it must not
 * hide a new one behind it, and it must not be reported twice either.
 *   K3  when change is made the receiver ends a few sats short at 150 ppk
 *   K4  the payer's entries are a sat out for every change it kept
 *   K5  an offline payer's plain ecash that the receiver cannot swap in is
 *       answered 422 and yet kept, and claimed when the mint answers */
const KNOWN = { K3: 'known: making change costs the receiver a few sats at 150 ppk',
                K4: 'known: the payer\u2019s entries are a sat out per change kept',
                K5: 'known: plain ecash the receiver could not swap is answered 422, kept, and claimed later' };
const okOrKnown = (name, good, knownAs, isKnown, detail) => {
  if (good || !isKnown) return ok(name, good, detail);
  console.log('  KNOWN ' + name + ' \u2014 ' + detail + ' [' + KNOWN[knownAs] + ']');
  R.known = (R.known || 0) + 1;
  return false;
};
/* Something seen that is not a pass or a fail of the wallet: the fake backend's
 * doing, or a figure the report wants. Listed again at the end. */
const note = (s) => { console.log('  NOTE  ' + s); R.notes.push(SCEN + ': ' + s); };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const amt = (p) => Number(String(p && p.amount)) || 0;

const SCENARIOS = [];
// a `real-` scenario runs only against the real mints, and nothing else does
const scenario = (id, title, fn, o) => { if (REAL === /^real-/.test(id)) SCENARIOS.push({ id, title, fn, timeout: (o && o.timeout) || 240000 }); };

/* ---- the real mints: the way there, and wallets that outlive the run ---- */
const fsR = require('fs'), pathR = require('path'), osR = require('os');
const { execFile: execFileR } = require('child_process');
const REAL_DIR = REAL_DRY ? (process.env.FOXY_REAL_DRY_DIR || pathR.join(osR.tmpdir(), 'foxy-real-rehearsal'))
  : pathR.join(osR.homedir(), '.foxy-live', 'real-pair');
/* Tor's SOCKS port, from a running Foxy: FOXY_REAL_SOCKS, or the last one a
 * simulator's diary names (FOXY_REAL_TOR_DIARY), read each time because the
 * port changes whenever that Foxy sets its connection up again. */
function realSocks() {
  const diary = process.env.FOXY_REAL_TOR_DIARY;
  if (diary) {
    try {
      const all = fsR.readFileSync(diary, 'utf8');
      const at = all.lastIndexOf('tor: SOCKS on 127.0.0.1:');
      if (at >= 0) { const m = /127\.0\.0\.1:(\d+)/.exec(all.slice(at, at + 60)); if (m) return m[1]; }
    } catch (e) {}
  }
  return process.env.FOXY_REAL_SOCKS || '';
}
const realStats = { asked: 0, failed: 0, ms: [] };
function realSend(m) {
  return new Promise((ok, no) => {
    const port = realSocks();
    if (!port) return no(new Error('no Tor: set FOXY_REAL_TOR_DIARY or FOXY_REAL_SOCKS'));
    const args = ['-sS', '--max-time', '75', '--socks5-hostname', '127.0.0.1:' + port, '-X', m.method,
                  '-H', 'content-type: application/json', '-H', 'accept: application/json', '-w', '\n%{http_code}'];
    /* A circuit to each job, as the phone gives one (Route.swift): Tor keeps
     * streams apart by the name they sign in with. A request with no job of
     * its own gets a circuit of its own, which is also what makes "asked once
     * more on another circuit" true here (22-screen-lock.js, a 429). */
    const label = /^[0-9a-f]{16,64}$/.test(String(m.circuit || '')) ? String(m.circuit)
      : require('crypto').randomBytes(16).toString('hex');
    args.push('--proxy-user', label + ':foxy');
    if (m.method !== 'GET') args.push('--data-binary', '@-');
    args.push(m.url);
    const t0 = Date.now();
    realStats.asked++;
    const child = execFileR('curl', args, { maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
      realStats.ms.push(Date.now() - t0);
      if (err) { realStats.failed++; return no(new Error(String(errOut || err.message).trim().split('\n').pop().slice(0, 160))); }
      const cut = out.lastIndexOf('\n');
      ok({ status: Number(out.slice(cut + 1)) || 0, text: out.slice(0, cut) });
    });
    if (m.method !== 'GET') { child.stdin.write(String(m.body || '')); child.stdin.end(); }
  });
}
const REAL_OPTS = (REAL && !REAL_DRY) ? { hosts: REAL_URLS.map((u) => new URL(u).hostname), send: realSend } : undefined;
/* What a phone is, written down: its words, its counters, its lock index and
 * everything the page stored. Enough to open it again in another run, which
 * is the whole of the safety here: a run that dies has lost nothing that was
 * saved, and the next one starts with the catch-up the app runs on launch. */
function realSave(p) {
  if (!REAL || !p || !p.persist || !p.b) return;
  try {
    const words = (p.keychain && p.keychain.words) || '';
    if (!words) return;
    const storage = p.b.life.dead ? (p.stored || {}) : p.b.snapshot();
    if (!storage || !Object.keys(storage).length) return;
    const data = { name: p.name, home: p.home, words, saved: new Date().toISOString(),
                   counters: Object.fromEntries((p.native && p.native.counters.get(words)) || new Map()),
                   locks: (p.native && p.native.locks.get(words)) || 0, imported: !!(p.native && p.native.imported), storage };
    fsR.mkdirSync(REAL_DIR, { recursive: true, mode: 0o700 });
    const file = pathR.join(REAL_DIR, p.name + '.json');
    fsR.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
    fsR.renameSync(file + '.tmp', file);
  } catch (e) { console.log('  NOTE  could not save ' + p.name + ': ' + e.message); }
}
const realPhones = [];
if (REAL) setInterval(() => realPhones.forEach(realSave), 1500).unref();
async function realPhone(S, name, home) {
  const p = newPhone(S, name, home);
  p.persist = true;
  try {
    const d = JSON.parse(fsR.readFileSync(pathR.join(REAL_DIR, name + '.json'), 'utf8'));
    p.keychain = { words: d.words };
    p.native = { keychain: p.keychain, counters: new Map([[d.words, new Map(Object.entries(d.counters || {}))]]),
                 locks: new Map([[d.words, d.locks || 0]]), imported: !!d.imported };
    p.stored = d.storage;
  } catch (e) {}
  for (let i = realPhones.length - 1; i >= 0; i--) if (realPhones[i].name === name) realPhones.splice(i, 1);
  realPhones.push(p);
  await launch(p);
  // what the app runs on every launch: anything a run before this one left half done
  await catchUp(p);
  await p.W.primeLocks().catch(() => 0);
  realSave(p);
  return p;
}

/* ---- a phone: a keychain and a counter file that outlive the page ------ */
function newPhone(S, name, home) {
  const p = { name, home: canon(home), keychain: { words: '' }, native: null, b: null, W: null, offline: false,
              link: null, answers: [], events: [], faults: [], killedAt: null, stored: null, owed: 0,
              changeDue: false, lastHash: '', changes: [], pages: [], wokeAt: '', carried: [], tookBack: [], carriedPay: null, atRiskSaid: [] };
  if (S) S.phones.push(p);
  return p;
}

const goOffline = (W) => {
  W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false,
               transport: 'direct', network: 'none' });
  W.setOffline(true);
};
const goOnline = (W) => {
  W.setOffline(false);
  W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
};
const setOffline = (p, off) => {
  p.offline = !!off;
  if (p.W && p.b && !p.b.life.dead) (off ? goOffline : goOnline)(p.W);
};

/* One mint request's fate. Offline, nothing leaves. Otherwise the first fault
 * that matches decides: 'before' (never reaches the mint), 'after' (the mint
 * does it and the answer is lost), 'ok' (it goes through, and `then` runs —
 * a way to make something happen at that moment). `kill` ends the app there.
 * `mint` keeps a fault to one mint, which is how a mint is unreachable for
 * this phone alone. `skip` lets that many matching requests through first. */
function netFor(p) {
  return (m, path) => {
    const fate = fateOf(p, m, path);
    // `p.trace = []` records every request and what became of it, for working out a failure
    if (p.trace) p.trace.push(m.method + ' ' + nameOf(String(m.url).split('/v1/')[0]) + ' ' + path + ' -> ' + fate);
    return fate;
  };
}
function fateOf(p, m, path) {
  if (p.offline) return 'before';
  for (const f of p.faults) {
    if (f.used && f.once !== false) continue;
    if (f.method && f.method !== m.method) continue;
    if (f.mint && canon(m.url).indexOf(canon(f.mint)) !== 0) continue;
    if (!f.path.test(path)) continue;
    if (f.skip > 0) { f.skip -= 1; continue; }
    f.used = true;
    f.hits = (f.hits || 0) + 1;
    if (f.kill) kill(p, f.label || ((f.fate || 'ok') + ' ' + path));
    if (f.then) { try { f.then(m, path); } catch (e) {} }
    return f.fate || 'ok';
  }
  return 'ok';
}

/* The tap link's messages, between this page and the one at the other end.
 * `p.link` is the link this phone is on now: { up, payer, receiver, log }. */
let wireSeq = 0;
function bridgeFor(p) {
  return (m, reply) => {
    const L = p.link;
    switch (m.action) {
      case 'inboxAnswer': {
        // handleInboxAnswer: anything but 200, 409 and 422 is sent as 422
        const asked = Number(m.status);
        const status = [200, 409, 422].indexOf(asked) >= 0 ? asked : 422;
        p.answers.push({ status, text: String(m.text || '').slice(0, 300), wire: String(m.answer || '') });
        if (L) L.log.push('M6 ' + status);
        reply(m.id, 'ok'); return true;
      }
      case 'tapChangeDue':
        if (L) { L.owed = true; L.log.push('change owed'); }
        reply(m.id, 'ok'); return true;
      case 'tapAsking':
        reply(m.id, 'ok'); return true;
      /* M10 and M11: the price talk, and the question asked before a payment
       * (`askFirst`). Carried to the page at the other end while the link is
       * up, as TapLink carries them. */
      case 'tapQuote': {
        const to = L && L.receiver;
        if (!L || !L.up || !to || !to.b || to.b.life.dead) { reply(m.id, null, 'That phone is no longer connected.'); return true; }
        L.log.push('M10');
        setTimeout(() => { if (to.b && !to.b.life.dead) to.W._tapQuote(String(m.body || '')); }, 0);
        reply(m.id, 'ok'); return true;
      }
      case 'tapTerms': {
        const to = L && L.payer;
        if (!L || !L.up || !to || !to.b || to.b.life.dead) { reply(m.id, null, 'That phone is no longer connected.'); return true; }
        L.log.push('M11');
        setTimeout(() => { if (to.b && !to.b.life.dead) to.W._tapTerms(String(m.body || '')); }, 0);
        reply(m.id, 'ok'); return true;
      }
      case 'tapChange': {
        if (!L || !L.up || !L.payer.b || L.payer.b.life.dead) {
          reply(m.id, null, 'That phone is no longer connected.'); return true;
        }
        L.log.push('M7 change');
        // answered when the payer says it kept it, or seven seconds on (handleTapChange)
        const cw = { id: m.id, reply, done: false };
        L.changeWait = cw;
        setTimeout(() => { try { L.payer.W._tapChange(String(m.body || '')); } catch (e) {} }, 0);
        setTimeout(() => {
          if (cw.done) return;
          cw.done = true;
          reply(m.id, null, 'The payer’s phone did not say it kept the change.');
        }, 7000).unref();
        return true;
      }
      case 'tapChangeKept': {
        if (L) {
          L.log.push('M8 kept=' + !!m.kept);
          const cw = L.changeWait;
          if (cw && !cw.done) {
            cw.done = true;
            if (m.kept) { L.owed = false; cw.reply(cw.id, 'ok'); }
            else cw.reply(cw.id, null, 'The payer’s phone did not say it kept the change.');
          } else if (cw && m.kept && L.receiver.b && !L.receiver.b.life.dead) {
            try { L.receiver.W._tapChangeKeptLate(); } catch (e) {}
          }
        }
        reply(m.id, 'ok'); return true;
      }
      case 'tapSend': {
        if (p.killOnSend) { const why = p.killOnSend; p.killOnSend = null; kill(p, why); return true; }
        if (!L || !L.up || L.cutBeforeM5) {
          if (L) { L.up = false; L.log.push('link down before M5'); }
          reply(m.id, null, 'That phone is no longer connected.'); return true;
        }
        const rx = L.receiver;
        if (!rx.b || rx.b.life.dead) { reply(m.id, null, 'That phone is no longer connected.'); return true; }
        L.log.push('M5 payment');
        const began = rx.answers.length;
        const body = String(m.body || '');
        L.lastBody = body;
        const wire = 'wire-' + (++wireSeq);
        setTimeout(() => { try { rx.W._requestPaid(body, wire, 'tap'); } catch (e) {} }, 0);
        const t0 = Date.now();
        const wait = setInterval(() => {
          if (rx.answers.length > began) {
            clearInterval(wait);
            const last = rx.answers[rx.answers.length - 1];
            if (L.cutBeforeM6) {
              L.up = false; L.log.push('link down before M6 reached the payer');
              return reply(m.id, null, 'That phone is no longer connected.');
            }
            // M6 as the receiver's phone seals it (TapLink.swift sealResult)
            return reply(m.id, JSON.stringify(last.status === 200 ? { v: 2, ok: true, code: 200 }
              : { v: 2, ok: false, code: last.status, why: String(last.text || '').slice(0, 160) }));
          }
          if ((rx.b && rx.b.life.dead) || !L.up) {
            clearInterval(wait);
            L.log.push('the receiver went away with the payment in flight');
            return reply(m.id, null, 'That phone is no longer connected.');
          }
          // the receiver's own give-up, twenty-five seconds (TapLink.resultWait)
          if (Date.now() - t0 > 25000) {
            clearInterval(wait);
            L.log.push('M6 504, the receiver’s page never answered');
            return reply(m.id, JSON.stringify({ v: 2, ok: false, code: 504, why: 'Their wallet did not answer in time.' }));
          }
        }, 5);
        return true;
      }
      default:
        reply(m.id, null, 'not in this test'); return true;
    }
  };
}
/* Two phones held together: a fresh link, as a fresh tap is. */
function linkUp(P, Rx) {
  const L = { up: true, log: [], payer: P, receiver: Rx, owed: false };
  P.link = L; Rx.link = L;
  return L;
}

/* Open the app on this phone: a fresh page over what the last one wrote.
 *
 * The first launch is a fresh install and is given its mint. Every later one
 * connects to the mint the wallet saved, which is what the app does — and is
 * the whole of the difference between "the phone woke up at home" and "the
 * test put it there". `o.at` overrides, for a person switching mints by hand.
 * `o.connect: false` leaves it unconnected (a restore types words first). */
async function launch(p, o) {
  const opts = o || {};
  const first = !p.native;
  p.b = H.boot({ keychain: p.keychain, phone: p.native || undefined, storage: p.stored || undefined,
                 net: netFor(p), bridge: bridgeFor(p), real: REAL_OPTS });
  p.native = p.b.phone;
  p.keychain = p.b.keychain;
  p.W = p.b.W;
  p.killedAt = null;
  p.pages.push(p.b);
  p.W.onRequestPaid((ev) => {
    p.events.push({ stage: ev.stage, sats: ev.sats, id: ev.id, purpose: ev.purpose, refused: ev.refused || '' });
  });
  // 06-wallet-boot-and-restore.js: what became of a payment being brought home, and a refusal taken back
  // ten seconds on a phone; the local mints answer in a fraction of one
  p.W._refundWaitMs = 2500;
  if (p.W.onAtRisk) p.W.onAtRisk((r) => { p.atRiskSaid.push(r); });
  if (p.W.onCarry) p.W.onCarry((r) => { p.carried.push(r); });
  if (p.W.onTakenBack) p.W.onTakenBack((info) => { p.tookBack.push(info); });
  if (p.W.onChangeStuck) p.W.onChangeStuck((info) => { p.stuck = info; });
  /* What the app does when change arrives (15-paid-wake-keyboard.js): check
   * it against what is owed, swap it in with a route or write it down
   * without one, tell the other phone which, and finish the payment's own
   * entry with what the change is worth here (`changeArrived`). */
  p.W.onTapChange((token) => {
    const W = p.W;
    const bits = W.tokenInfo ? W.tokenInfo(token) : null;
    const sats = bits ? (bits.proofs || []).reduce((a, pr) => a + amt(pr), 0) : 0;
    const act = () => {
      const carried = p.carriedPay && Date.now() < p.carriedPay.until ? p.carriedPay : null;
      const refund = !(p.owed > 0) && !!carried;
      const chk = W.checkChange ? W.checkChange(token, p.owed || (carried ? carried.sats : 0)) : { ok: true, signed: true };
      if (!chk.ok) { p.changes.push({ sats, refused: chk.why }); W.tapChangeKept(false); return; }
      const net = W.changeNet ? W.changeNet(token) : sats;
      const kept = (how) => {
        p.changes.push({ sats, net, how, refund });
        const told = W.tapChangeKept(true);
        if (refund) {
          p.carriedPay = null;
          try { if (carried.hash && W.changeSettled) W.changeSettled(carried.hash, net, { refund: true }); } catch (e) {}
        }
        if (p.changeDue) {
          p.changeDue = false; p.owed = 0;
          try { if (p.lastHash && W.changeSettled) W.changeSettled(p.lastHash, net); } catch (e) {}
        }
        return told;
      };
      if (!p.offline) {
        W.receiveToken(token, { hash: 'tap-change-' + Date.now() }).then(() => kept('swapped in'), () => {
          if (!chk.signed) return W.tapChangeKept(false);
          try { W.keepChange(token, sats); return kept('written down, waiting to settle'); } catch (x) { return W.tapChangeKept(false); }
        }).catch(() => {});
        return;
      }
      if (!chk.signed) { W.tapChangeKept(false); return; }
      try { W.keepChange(token, sats); kept('written down, offline'); } catch (e) { W.tapChangeKept(false); }
    };
    // what is owed is known once the send has reported, a tick after M6
    setTimeout(act, 30);
  });
  if (p.offline) goOffline(p.W);
  await p.W.seedReady();
  if (opts.connect === false) return p;
  if (opts.at) await p.W.connect(opts.at);
  else if (first) await p.W.connect(p.home, null, null, { remember: true });
  else await p.W.connect();
  p.wokeAt = canon(p.W.mintUrl);
  return p;
}

/* Killed, as iOS kills it. What it wrote is kept for the next launch. */
function kill(p, why) {
  if (!p.b || p.b.life.dead) return;
  p.stored = p.b.kill();
  p.killedAt = why || 'killed';
  if (p.link) { p.link.up = false; p.link.log.push(p.name + ' killed: ' + p.killedAt); }
}

/* Opened again, and what the app runs on every launch and reconnect
 * (06-wallet-boot-and-restore.js): the sweeps, then anything that arrived and
 * was never claimed. `o.faults` are in force from the first request. */
async function reopen(p, o) {
  const opts = o || {};
  if (p.b && !p.b.life.dead) p.stored = p.b.kill();
  p.faults = opts.faults || [];
  await launch(p, opts);
  if (!p.offline && opts.catchUp !== false) await catchUp(p);
  return p;
}
async function catchUp(p) {
  try { await p.W.resumeSweeps(); } catch (e) {}
  try { await p.W.claimUnclaimed(); } catch (e) {}
  /* A melt or a quote at this mint that the fake Lightning has not finished
   * with yet: asked again, as the app's own pollers would, until it settles
   * or two rounds running change nothing. */
  let was = '', same = 0;
  for (let i = 0; i < 8; i++) {
    const here = canon(p.W.mintUrl);
    const melts = store(p, 'foxy.cashu.melting', []).filter((e) => !e.mint || canon(e.mint) === here).length;
    const move = store(p, 'foxy.cashu.move', null);
    const quotes = ((p.W.pendingQuotes && p.W.pendingQuotes()) || []).length;
    const waiting = melts + quotes + (move && canon(move.to) === here ? 1 : 0);
    if (!waiting) break;
    const sig = [melts, quotes, move ? move.quote : '', pileAll(p)].join('|');
    same = sig === was ? same + 1 : 0;
    was = sig;
    if (same >= 2) break;
    await H.sleep(1500);
    try { await p.W.resumeSweeps(); } catch (e) {}
  }
  // a claim made late may have started a payment home on a timer: waited for here
  await H.sleep(50);
  if (p.W.crossingsWaiting && p.W.crossingsWaiting()) { try { await p.W.catchUpCrossings(); } catch (e) {} }
}

/* ---- what a phone has written down ------------------------------------- */
function store(p, key, dflt) {
  try {
    const raw = (p.b && !p.b.life.dead) ? p.b.w.localStorage.getItem(key) : (p.stored || {})[key];
    let v = raw ? JSON.parse(raw) : null;
    // the crossing notes are a list now; the oldest is what the single slot held
    if (key === 'foxy.cashu.move' && Array.isArray(v)) v = v.length ? v[0] : null;
    return v === null || v === undefined ? dflt : v;
  } catch (e) { return dflt; }
}
/* Every crossing note, and every payment still to be brought home. */
function moveNotes(p) {
  try {
    const raw = (p.b && !p.b.life.dead) ? p.b.w.localStorage.getItem('foxy.cashu.move') : (p.stored || {})['foxy.cashu.move'];
    const v = raw ? JSON.parse(raw) : null;
    return !v ? [] : Array.isArray(v) ? v : [v];
  } catch (e) { return []; }
}
const carryJobs = (p) => store(p, 'foxy.cashu.carry', []) || [];
const pileAt = (p, mint) => p.W.balanceAt(canon(mint));
const pileAll = (p) => sum(ALL.map((m) => pileAt(p, m)));
function piecesAt(p, mint) {
  return store(p, 'foxy.cashu.proofs.' + canon(mint), []).length;
}
/* Everything that is neither in a pile nor gone: at every mint, not only the
 * one the phone is on (the wallet's own `heldSats` answers for one mint). */
function limbo(p) {
  const held = store(p, 'foxy.cashu.held', {});
  const melts = store(p, 'foxy.cashu.melting', []);
  const swaps = store(p, 'foxy.cashu.swaps', []);
  return {
    unclaimed: Math.round(Number(p.W.unclaimedSats && p.W.unclaimedSats()) || 0),
    held: sum(Object.keys(held).map((id) => sum(((held[id] && held[id].proofs) || []).map(amt)))),
    recovering: Math.round(Number(p.W.recoveringSats && p.W.recoveringSats()) || 0),
    melts: melts.length,
    meltSats: sum(melts.map((e) => sum((e.proofs || []).map(amt)))),
    move: moveNotes(p).length,
    carry: carryJobs(p).length,
    swapRecords: swaps.filter((r) => !(r && r.locked && r.locked.length)).length,
  };
}
const limboSats = (l) => l.unclaimed + l.held + l.recovering + l.meltSats;
const calm = (l) => !l.unclaimed && !l.held && !l.recovering && !l.melts && !l.move && !l.carry;
const limboLine = (l) => JSON.stringify(l);

/* The history card's arithmetic (16-history-lists.js `histAudit`), one mint at
 * a time: what the entries say this phone should hold there. */
async function entriesAt(p, mint) {
  const m = canon(mint);
  const rows = await p.W.transactions(500);
  let total = 0;
  rows.forEach((e) => {
    if (!e || canon(e.mint) !== m) return;
    if (e.unit && e.unit !== 'sat') return;
    if (e.state === 'failed' || e.failed || e.atRisk) return;
    const changeRow = e.dir === 'in' && (e.changeRow || /^(tap|req)-change-/.test(String(e.hash || '')));
    if (changeRow) return;
    if (e.dir === 'in') { if (e.state === 'pending' && !e.settled) return; total += Number(e.sats) || 0; return; }
    const owedBack = e.changeState === 'owed' ? (Number(e.changeSats) || 0) : 0;
    total -= (Number(e.sats) || 0) + Math.max(0, Number(e.feeSats) || 0) + owedBack;
  });
  return total;
}
async function books(p) {
  const out = [];
  for (const mint of ALL) {
    const says = await entriesAt(p, mint);
    const holds = pileAt(p, mint);
    out.push({ mint: NAME[mint], says, holds, off: says - holds });
  }
  return out;
}
const booksOff = (bk) => sum(bk.map((x) => Math.abs(x.off)));
const booksLine = (bk) => bk.filter((x) => x.says || x.holds)
  .map((x) => x.mint + ' ' + x.holds + (x.off ? ' (entries say ' + x.says + ')' : '')).join(', ') || 'nothing';
async function entriesLine(p, n) {
  const rows = await p.W.transactions(n || 30);
  return rows.map((e) => (e.dir === 'in' ? '+' : '-') + e.sats
    + (e.feeSats ? ' fee ' + e.feeSats : '') + (e.changeSats ? ' change ' + e.changeSats : '')
    + (e.changeState ? ' (' + e.changeState + ')' : '') + (e.state && e.state !== 'success' ? ' [' + e.state + ']' : '')
    + ' @' + nameOf(e.mint) + ' <' + String(e.hash || '').slice(0, 12) + '>').join(' ; ') || 'none';
}

/* What the mint says of each pile: sats the app counts that are already spent.
 * The app never asks this by itself (`reconcile`, 17-backup.js), so a test has
 * to. Every mint the phone holds anything at, then back to where it was. */
async function phantom(p) {
  if (p.offline || !p.b || p.b.life.dead) return 0;
  const was = canon(p.W.mintUrl);
  let gone = 0;
  for (const mint of ALL) {
    if (!(pileAt(p, mint) > 0)) continue;
    try {
      if (canon(p.W.mintUrl) !== canon(mint)) await p.W.connect(mint, null, null, { remember: false });
      const before = pileAt(p, mint);
      await p.W.reconcile();
      gone += Math.max(0, before - pileAt(p, mint));
    } catch (e) {}
  }
  if (was && canon(p.W.mintUrl) !== was) { try { await p.W.connect(was, null, null, { remember: false }); } catch (e) {} }
  return gone;
}

/* A phone, opened for the first time, funded at its own mint. `pool` makes
 * the small-change pool, as on a phone that has been put away once since its
 * first receive. */
async function phone(S, name, home, o) {
  const opts = o || {};
  const p = newPhone(S, name, home);
  await launch(p);
  if (opts.fund > 0) await H.mintAndClaim(p.W, opts.fund);
  await p.W.primeLocks();
  if (opts.pool) { for (let i = 0; i < 8; i++) { const r = await p.W.tidyChange().catch(() => null); if (!r || r.skipped) break; } }
  return p;
}
/* A little already held at another mint, as on a phone that has been paid
 * there before. */
async function seedAt(p, mint, sats) {
  const was = canon(p.W.mintUrl);
  await p.W.connect(mint, null, null, { remember: true });
  await H.mintAndClaim(p.W, sats);
  await p.W.connect(was, null, null, { remember: true });
}
/* The same words on a new phone: typed on it, scanned at `urls`, adopted. */
async function restoreOnNewPhone(S, name, words, urls, home) {
  const p = newPhone(S, name, home);
  await launch(p, { connect: false });
  const { rows, adopt } = await H.restoreWords(p.b, words, urls);
  const adopted = await adopt();
  await p.W.connect(home, null, null, { remember: true });
  p.wokeAt = canon(p.W.mintUrl);
  await p.W.primeLocks();
  return { p, rows, adopted };
}

/* Where a pair of phones stood, and what a scenario left against that. */
function snapshot(phones) {
  const s = {};
  phones.forEach((p) => { s[p.name] = pileAll(p); });
  return s;
}
async function outcome(S, P, Rx, label, sats, extra) {
  // FOXY_OCX_DEBUG=2: what each wallet said, for reading a failure
  if (process.env.FOXY_OCX_DEBUG === '2') {
    for (const p of [P, Rx]) {
      (p.b.rec.log.concat(p.b.rec.warn.map((x) => 'WARN ' + x))).slice(-40)
        .filter((l) => !/small change: no|too long for a QR|took \d+ ms/.test(l))
        .forEach((l) => console.log('         [' + p.name + '] ' + String(l).slice(0, 250)));
    }
  }
  const bp = await books(P), br = await books(Rx);
  const ghostP = await phantom(P), ghostR = await phantom(Rx);
  const now = snapshot([P, Rx]);
  const start = S.start || {};
  const rxGot = now[Rx.name] - (start[Rx.name] || 0);
  const payerPaid = (start[P.name] || 0) - now[P.name];
  const lp = limbo(P), lr = limbo(Rx);
  if (DEBUG) { say(P.name + ' entries: ' + await entriesLine(P)); say(Rx.name + ' entries: ' + await entriesLine(Rx)); }
  const row = Object.assign({
    id: S.id, label, asked: sats, rxGot, payerPaid, cost: payerPaid - rxGot, ghostP, ghostR,
    payerLimbo: limboSats(lp), rxLimbo: limboSats(lr),
    payerOff: booksOff(bp), rxOff: booksOff(br), calm: calm(lp) && calm(lr),
    // each change a payer kept is a sat out of its entries (K4)
    payerChanges: P.changes.filter((c) => !c.refused).length,
  }, extra || {});
  R.table.push(row);
  S.start = Object.assign({}, start, now);
  return { row, lp, lr, bp, br };
}
/* The questions, asked the same way every time. */
function verdict(o, sats, expect) {
  const e = expect || {};
  const r = o.row;
  if (e.rxGot !== undefined) ok('the receiver holds what it asked for', r.rxGot === e.rxGot, 'asked ' + sats + ', up by ' + r.rxGot);
  if (e.maxCost !== undefined) {
    ok('and it cost the payer no more than ' + e.maxCost + ' on top', r.cost >= 0 && r.cost <= e.maxCost,
       'the payer is down ' + r.payerPaid + ', the receiver up ' + r.rxGot + ': ' + r.cost + ' to the mints');
  }
  ok('neither phone was showing ecash the mint says is spent', !r.ghostP && !r.ghostR,
     'payer ' + r.ghostP + ' sats, receiver ' + r.ghostR + ' sats shown as held and already spent');
  ok('nothing is left in between', r.calm && !r.payerLimbo && !r.rxLimbo,
     'payer ' + limboLine(o.lp) + ', receiver ' + limboLine(o.lr));
  okOrKnown('the payer’s entries add up to what it holds', r.payerOff === 0, 'K4', r.payerOff <= (r.payerChanges || 0), booksLine(o.bp));
  ok('and so do the receiver’s', r.rxOff === 0, booksLine(o.br));
}
/* One phone on its own: asked the mint, looked for anything in between, added
 * up the entries. For scenarios with more than two phones. */
async function audit(p, o) {
  const opts = o || {};
  const bk = await books(p);
  const ghost = await phantom(p);
  const l = limbo(p);
  const clean = !ghost && calm(l) && !limboSats(l);
  // `changes`: how many times this phone kept change, each of which is a sat out (K4)
  okOrKnown(p.name + ': nothing shown is spent, nothing is in between, and the entries add up',
     clean && booksOff(bk) === 0, 'K4', clean && booksOff(bk) <= (opts.changes || 0),
     (ghost ? ghost + ' sats shown as held and already spent; ' : '') + limboLine(l) + '; ' + booksLine(bk));
  return { bk, ghost, l };
}
function diary(p, re, n) {
  if (!DEBUG) return;
  (p.pages || []).forEach((b, i) => {
    b.rec.log.concat(b.rec.warn.map((x) => 'WARN ' + x)).filter((l) => (re || /./).test(l))
      .slice(-(n || 14)).forEach((l) => say('[' + p.name + ' page ' + i + '] ' + String(l).slice(0, 240)));
  });
}
const told = (p, since) => p.events.slice(since || 0).map((e) => e.stage + (e.refused ? ' (' + e.refused.slice(0, 60) + ')' : '')).join(', ') || 'nothing';

/* ---- the rails, as the app runs them ------------------------------------ */

/* What the payer's app does once a request has been paid straight to whoever
 * asked (07-history-tokens-mints.js `requestDelivered`): the change, if any, is
 * expected; the payment is marked as having crossed a tap; and a payment that
 * was confirmed, or is locked to them, is settled and its token put away
 * under `kept` — still there to show, no longer offered for taking back. */
function afterDelivered(P, req, r) {
  const W = P.W;
  try { W.tag(r.hash, { inflight: false }); } catch (e) {}
  if (Number(r.over) > 0) { P.owed = Math.round(Number(r.over)); P.lastHash = r.hash; P.changeDue = true; }
  if (P.carriedPay && !P.carriedPay.hash && r.hash) P.carriedPay.hash = r.hash;
  if (req && req.viaTap) { try { W.tag(r.hash, { handed: 'tap' }); } catch (e) {} }
  if (r.confirmed || r.lockedTo) {
    try { W.settleTx(r.hash); } catch (e) {}
    try { W.forgetClaimedToken(r.hash); } catch (e) {}
    try { if (W.lastTokenHash && W.lastTokenHash() === r.hash) W.clearLastToken(); } catch (e) {}
  }
}

/* A request paid over the link with ecash (`makeTokenForRequest`, the `direct`
 * branch). `o.text` is a request already made (the carry-home's, at the
 * payer's mint); otherwise the receiver makes one for `sats` where it stands.
 * `theirRoute` is what the receiver said of itself in its tap offer.
 *
 * Resolves { made } with what `payRequest` resolved, or { err, token, refused }
 * — `token` is the payment as a token when one was made and not delivered,
 * which the app puts on the token screen, and `refused` says the receiver
 * heard it and said no in words. `said` is what the payer's screen says. */
async function tapEcash(P, Rx, sats, o) {
  const opts = o || {};
  const L = linkUp(P, Rx);
  if (opts.cutBeforeM5) L.cutBeforeM5 = true;
  if (opts.cutBeforeM6) L.cutBeforeM6 = true;
  const text = opts.text || Rx.W.paymentRequest(sats, { purpose: opts.purpose || 'receive' });
  const ask = P.W.decodeRequest(text) || {};
  const theirRoute = opts.theirRoute !== undefined ? opts.theirRoute : !Rx.offline;
  // `asks`: what an up-to-date receiver's offer says (`ask: 1`), so the payer asks before it makes anything
  const req = Object.assign({}, ask, { sats: sats, unit: 'sat', viaTap: true, theirRoute: theirRoute, asks: opts.asks !== false });
  const evAt = Rx.events.length, ansAt = Rx.answers.length;
  const t0 = Date.now();
  // changeComesBack: only from a receiver with a route
  let res = await P.W.payRequest(req, null, { overpayOk: theirRoute === true })
    .then((r) => ({ made: r }), (e) => ({ err: (e && e.message) || String(e), e }));
  // the over-pay card, where the change cannot come back: the test answers it
  if (res.e && res.e.foxyNeedsOverpay && opts.overpayYes) {
    res.askedOverpay = res.e.foxyNeedsOverpay;
    res = Object.assign(await P.W.payRequest(req, null, { overpayOk: true })
      .then((r) => ({ made: r }), (e) => ({ err: (e && e.message) || String(e), e })), { askedOverpay: res.askedOverpay });
  }
  if (res.made) {
    afterDelivered(P, req, res.made);
    res.said = 'paid' + (res.made.confirmed ? '' : ' (nobody confirmed it)');
  } else {
    const made = res.e && res.e.foxyToken;
    if (made) {
      try { P.W.tag(made.hash, { inflight: false }); } catch (e) {}
      res.token = made.token; res.tokenHash = made.hash; res.tokenSats = made.sats;
      res.refused = !!(res.e && res.e.foxyRefused);
      res.said = res.refused ? 'THEY DID NOT TAKE IT: ' + res.err + ' — your ' + made.sats + ' sats are still yours'
        : 'It did not reach them (' + res.err + '). Show them this token instead.';
    } else if (res.e && res.e.foxyAtRisk) {
      /* MONEY.md §15: refused, and nothing came back locked to
       * the payer. The pieces are in its wallet again, flagged; there is no
       * token on the entry any more. */
      res.refused = true;
      res.atRisk = res.e.foxyAtRisk;
      res.said = 'HIGH RISK: they refused it (' + res.err + ') and sent nothing back — ' + res.atRisk.sats
        + ' sats are in the wallet again, at risk';
    } else if (res.e && res.e.foxyRefunded) {
      res.refused = true;
      res.refunded = res.e.foxyRefunded;
      res.said = 'THEY DID NOT TAKE IT: ' + res.err + ' — ' + res.refunded.sats + ' sats came back, locked to this phone';
    } else {
      res.said = 'not made: ' + res.err;
    }
  }
  return Object.assign(res, { ms: Date.now() - t0, text, req, L, rxTold: () => told(Rx, evAt),
                              rxAnswers: () => Rx.answers.slice(ansAt) });
}
/* The proofs a payment carried over the link, by their secrets. */
function secretsOf(body) {
  try { return (JSON.parse(String(body || '')).proofs || []).map((pr) => String(pr.secret)); } catch (e) { return []; }
}

/* Another mint, both with a route: the receiver's invoice, paid by Lightning. */
async function tapLightning(P, Rx, sats) {
  const inv = await Rx.W.invoice(sats, '');
  const bolt = inv.invoice || inv.request || inv.bolt11 || inv.pr || inv.text;
  const t0 = Date.now();
  const res = await P.W.pay(bolt).then((r) => ({ paid: r }), (e) => ({ err: (e && e.message) || String(e), e }));
  return Object.assign(res, { ms: Date.now() - t0, inv, bolt });
}
/* The receiver's side of that: its invoice screen watching for the payment. */
async function claimInvoice(p, inv, ms) {
  const end = Date.now() + (ms || 30000);
  for (;;) {
    try { const r = await p.W.claim(inv.hash); if (r && (r.sats > 0 || r.settled || r.claimed)) return r; } catch (e) {}
    try { await p.W.sweepQuotes(); } catch (e) {}
    const rows = await p.W.transactions(50);
    if (rows.some((e) => e.dir === 'in' && e.hash === inv.hash && e.state !== 'pending')) return { swept: true };
    if (Date.now() > end) return null;
    await H.sleep(1000);
  }
}
/* An invoice straight from a mint, with no wallet behind it: something for a
 * payer to pay that nobody's books have to carry. */
async function bareInvoice(mint, sats) {
  const r = await fetch(canon(mint) + '/v1/mint/quote/bolt11', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: sats, unit: 'sat' }),
  });
  const j = await r.json();
  if (!j.request) throw new Error('no invoice from ' + mint + ': ' + JSON.stringify(j).slice(0, 120));
  return { request: j.request, quote: j.quote };
}

/* The payer has no route and is at another mint; the receiver has one.
 *
 * `carryAsk` is M10 and M11 (26d-tap.js `tapStuckAtMint`, `tapCarryHome`): the
 * payer says which mint it is stuck at and what it holds there, the receiver
 * quotes the way home, goes to the payer's mint and asks there for the amount
 * plus the cost. `carryNow` is `carryHomeNow`: the melt home, and on a failure
 * the card and the walk back to its own mint. */
async function carryAsk(P, Rx, sats, o) {
  const opts = o || {};
  const home = canon(Rx.W.mintUrl);
  const offer = Rx.W.paymentRequest(sats, { purpose: 'receive' });
  const read = P.W.decodeRequest(offer) || {};
  const stuck = P.W.stuckAtMint(read);
  if (!stuck) return { err: 'the payer has nothing to say: it is not stuck at another mint', home };
  const said = Object.assign({ id: String(read.id || ''), sats: sats }, stuck, opts.have !== undefined ? { have: opts.have } : {});
  let terms;
  try { terms = await Rx.W.crossTerms(said, sats); }
  catch (e) {
    // `tapCarryHome`'s catch: home again, and the payer is told why
    if (canon(Rx.W.mintUrl) !== home) { try { await Rx.W.connect(home); } catch (x) {} }
    return { err: (e && e.message) || String(e), e, said, home };
  }
  // `tapCarryHome`: the job is written down, then the visit, which is not saved as the phone's mint
  let id = '';
  try { id = await Rx.W.carryBegin(terms); }
  catch (e) { return { err: (e && e.message) || String(e), e, said, home, terms: null }; }
  const text = Rx.W.paymentRequest(terms.ask, { purpose: 'carry:' + terms.from });
  if (!text) { await Rx.W.carryEnd(id); return { err: 'the receiver could not make a request at their mint', said, home }; }
  // the payer, agreeing to the terms: a refund may come back over this link (`tapStuckAtMint`)
  P.carriedPay = { sats: terms.ask, hash: '', until: Date.now() + 300000 };
  return { terms, text, home, said, id };
}
/* What `carryOutcome` puts on the receiver's screen for each ending. */
function carrySaid(r, c) {
  const st = String((r && r.state) || '');
  const homeName = nameOf(c.home);
  if (st === 'home') return 'PAYMENT RECEIVED, ' + Math.round(Number(r.sats) || 0) + ' sats at ' + homeName;
  if (st === 'moving') return 'ON ITS WAY TO YOUR MINT — it has left their mint for ' + homeName + ', and Foxy collects it by itself. Not received until it is at ' + homeName + '.';
  if (st === 'waiting') return 'ON ITS WAY TO YOUR MINT — their mint has not said it is done; held until it says either way.';
  if (st === 'short') return 'IT COSTS MORE TO BRING HOME — ' + r.lands + ' sats would arrive, not ' + r.net + '. BRING ' + r.lands + ' HOME / SEND IT BACK';
  if (st === 'refunded') return (r.handed ? 'NOT RECEIVED — sent back to the payer over the link. ' : 'Not received. Send it back — a code for the payer to scan. ') + String(r.why || '');
  if (st === 'retry') return 'NOT HOME YET — the payment is at their mint and has not reached ' + homeName + ' yet. ' + String(r.why || '') + ' Foxy tries again when it can reach both mints. TRY AGAIN / SEND IT BACK';
  if (st === 'stuck') return 'PAID, STILL AT THEIR MINT — it could not be brought home or sent back. ' + String(r.why || '') + ' — Move it whenever you like, from the mint screen.';
  return 'nothing to carry (' + st + ')';
}
async function carryNow(Rx, c, o) {
  const from = canon(Rx.W.mintUrl);
  const heldThere = pileAt(Rx, from);
  // `carryHomeNow`: the wallet does the walk and says what became of it; it never rejects, and ends at home
  const r = await Rx.W.carryHome(c.id, (o && o.fresh) ? null : c.terms.plan, () => {}, o && o.less ? { less: true } : undefined);
  const out = { r, state: r.state, heldThere, said: carrySaid(r, c) };
  if (r.state === 'home') out.done = r.done || { sats: r.sats };
  else out.err = r.why || r.state;
  return out;
}
/* The receiver gives up waiting on a carry-home offer nobody paid: two minutes
 * on, the app goes home (`_carryHomeT`). */
async function carryGiveUp(Rx, c) {
  if (c && c.id && Rx.W.carryEnd) { try { await Rx.W.carryEnd(c.id); } catch (e) {} }
  if (canon(Rx.W.mintUrl) !== c.home) { try { await Rx.W.connect(c.home); } catch (e) {} }
}

/* The receiver has no route and is at another mint; the payer has one.
 *
 * `tapCrossMint` and `crossRun`: quote the move with the far mint's fee padded
 * in, make it, pay their request there locked to them, and go home. A failed
 * move sends the wallet back to its own mint and raises COULD NOT REACH THEIR
 * MINT (`crossFailed`); a payment that fails after the move leaves it where the
 * money now is. `o.text` reuses a request (a second tap at the same offer). */
const CROSS_FAILED_CHIP = 'Nothing was sent, and your sats are where they were.';
async function crossPay(P, Rx, sats, o) {
  const opts = o || {};
  const mine = canon(P.W.mintUrl);
  const theirs = canon(Rx.W.mintUrl);
  const text = opts.text || Rx.W.paymentRequest(sats, { purpose: 'receive' });
  /* `tapPayFromThere`: a crossing of this phone's own that is paid for and
   * not yet claimed is finished first, and sats already at their mint pay
   * the request with no second Lightning payment. */
  if (P.W.pendingMoves && P.W.pendingMoves().length) { try { await P.W.finishMove(); } catch (e) {} }
  const heldThere = pileAt(P, theirs);
  if (heldThere >= sats && opts.fromThere !== false) {
    await P.W.connect(theirs, null, null, { remember: false });
    const sf = P.W.sendShortfall(sats, { locked: true });
    if (sf && !sf.short) {
      const t = await tapEcash(P, Rx, sats, { text: text, theirRoute: false });
      if (canon(P.W.mintUrl) !== mine) { try { await P.W.connect(mine); } catch (e) {} }
      return { stage: 'pay', fromThere: true, heldThere, t, text, mine, theirs, err: t.made ? '' : t.err, said: t.said };
    }
    await P.W.connect(mine);
  }
  let plan;
  try { plan = await P.W.transferQuote(mine, sats, { to: theirs, land: true }); }
  catch (e) {
    if (canon(P.W.mintUrl) !== mine) { try { await P.W.connect(mine); } catch (x) {} }
    return { stage: 'quote', err: (e && e.message) || String(e), e, text, mine, theirs,
             said: 'COULD NOT REACH THEIR MINT — ' + ((e && e.message) || e) + ' — ' + CROSS_FAILED_CHIP };
  }
  if (opts.afterQuote) await opts.afterQuote(plan);
  /* The fee card is up and a person reads it before PAY. It matters here for a
   * reason of the test mints' own: their fake Lightning marks an invoice paid a
   * second after it is made, by itself, and a melt at the minibits-like mint
   * answers at once — so a crossing run with no pause reaches the far mint
   * before its invoice reads as paid, and the claim is refused "Quote not
   * paid" with the melt already made. `readMs: 0` asks for exactly that, where
   * a scenario wants a far mint that has not caught up with the payment. */
  await H.sleep(opts.readMs === undefined ? 1500 : opts.readMs);
  if (opts.beforeMove) await opts.beforeMove(plan);
  try {
    await P.W.connect(mine);
    // `crossRun`: their mint is a visit, not saved as this phone's own
    await P.W.moveRun(plan, () => {}, { visit: true });
  } catch (e) {
    const why = P.W.reason ? P.W.reason(e) : String((e && e.message) || e);
    if (canon(P.W.mintUrl) !== mine) { try { await P.W.connect(mine); } catch (x) {} }
    // `crossFailed`: what is true of the money
    const said = e && e.movePaid
      ? 'YOUR SATS ARE ON THEIR WAY — The sats left your mint for ' + nameOf(theirs) + ', and it has not handed them over yet. Foxy collects them by itself. They have not been paid.'
      : e && e.pending
        ? 'THE MOVE MAY STILL GO THROUGH — Foxy is holding the sats until the mint says either way. They have not been paid.'
        : 'COULD NOT REACH THEIR MINT — ' + why + ' — ' + CROSS_FAILED_CHIP;
    return { stage: 'move', err: why, e, plan, text, mine, theirs, said };
  }
  if (opts.afterMove) await opts.afterMove(plan);
  const t = await tapEcash(P, Rx, sats, { text: text, theirRoute: false });
  // `crossComeHome`: home whichever way the payment ended
  if (canon(P.W.mintUrl) !== mine) { try { await P.W.connect(mine); } catch (e) {} }
  return { stage: 'pay', plan, t, text, mine, theirs, err: t.made ? '' : t.err, said: t.said };
}

/* The route comes back in the middle of a session, with no relaunch. What the
 * app does then (06-wallet-boot-and-restore.js): a wallet that was built from
 * storage connects for real (`connectForRealOnceOnline`), anything waiting is
 * claimed (`claimWhenRouteReturns`), and while part of the balance is held
 * for a swap that got no answer the mint is asked every three seconds
 * (`watchHeld`). It does not run the launch's sweeps. */
async function routeBack(p) {
  setOffline(p, false);
  if (p.W.fromCache && p.W.fromCache()) { try { await p.W.connect(p.W.mintUrl); } catch (e) {} }
  if (p.W.unclaimedSats() > 0) { try { await p.W.claimUnclaimed(); } catch (e) {} }
  // and what was left between two mints (`claimWhenRouteReturns`)
  if (p.W.crossingsWaiting && p.W.crossingsWaiting()) { try { await p.W.catchUpCrossings(); } catch (e) {} }
  for (let i = 0; i < 10 && p.W.heldSats() > 0; i++) {
    await H.sleep(3000);
    try { await p.W.recoverSwaps(); } catch (e) {}
  }
}

/* ======================================================================= */
/* The crossings tap-scenarios.js runs one way only, run the other way: out of
 * the mint that charges nothing and INTO the one that charges 150 ppk.        */

scenario('rev-po', 'minibits to macadamia, the payer offline — the receiver carries it home into the mint that charges', async (S) => {
  const P = await phone(S, 'payer', MB, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
  setOffline(P, true);
  for (const sats of [100, 1000]) {
    S.start = snapshot([P, Rx]);
    const homeBefore = pileAt(Rx, MAC), thereBefore = pileAt(Rx, MB);
    const t0 = Date.now();
    const c = await carryAsk(P, Rx, sats);
    if (!ok(sats + ' sats: the receiver quotes the way home', !!c.terms && c.terms.net === sats && c.terms.ask > sats,
            c.err || ('asking ' + c.terms.ask + ' at ' + nameOf(c.terms.from) + ' so ' + c.terms.net + ' lands; ' + c.terms.feeSats + ' of fees'))) continue;
    const t = await tapEcash(P, Rx, c.terms.ask, { text: c.text, theirRoute: true });
    ok(sats + ' sats: the offline payer hands over the amount and the way home, at its own mint', !!t.made,
       t.made ? t.made.sats + ' sats left it' + (t.made.over ? ' (' + t.made.over + ' over, to come back)' : '') + '; told: ' + t.said : t.said);
    if (!t.made) { await carryGiveUp(Rx, c); continue; }
    await H.sleep(t.made.over ? 3000 : 600);
    const there = pileAt(Rx, MB) - thereBefore;
    ok(sats + ' sats: the receiver has what it asked for at the payer’s mint', there >= c.terms.ask,
       there + ' more at minibits in ' + piecesAt(Rx, MB) + ' pieces, asked ' + c.terms.ask + '; it was told: ' + t.rxTold());
    const h = await carryNow(Rx, c);
    ok(sats + ' sats: and melts it home to macadamia', !!h.done && h.done.sats >= sats, h.said);
    ok(sats + ' sats: the receiver ends back on its own mint', canon(Rx.W.mintUrl) === MAC, 'on ' + nameOf(Rx.W.mintUrl));
    await catchUp(Rx);
    const o = await outcome(S, P, Rx, 'minibits→mac payer offline, ' + sats, sats, { rail: 'ecash, carried home', ms: Date.now() - t0 });
    ok(sats + ' sats: the figure it asked for is what landed at home', pileAt(Rx, MAC) - homeBefore === sats,
       (pileAt(Rx, MAC) - homeBefore) + ' more at macadamia, ' + (pileAt(Rx, MB) - thereBefore) + ' left at minibits');
    ok(sats + ' sats: the payer paid what it agreed to and no more', o.row.payerPaid >= c.terms.ask && o.row.payerPaid <= c.terms.ask + 1,
       'agreed ' + c.terms.ask + ', down ' + o.row.payerPaid);
    ok(sats + ' sats: and the receiver’s entries add up at both mints', o.row.rxOff === 0, booksLine(o.br));
  }
  setOffline(P, false);
  await reopen(P);
  await reopen(Rx);
  ok('opened again, the receiver wakes on its own mint', Rx.wokeAt === MAC, 'on ' + nameOf(Rx.wokeAt));
  const o = await outcome(S, P, Rx, 'minibits→mac payer offline: both reopened', 0, { rail: 'catch-up' });
  verdict(o, 0, {});
});

scenario('rev-ro', 'minibits to macadamia, the receiver offline — the payer moves it into the mint that charges and pays from there', async (S) => {
  const P = await phone(S, 'payer', MB, { fund: 9000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 300 });
  setOffline(Rx, true);
  let asked = 0;
  // 2047 and 4095 are every bit set: the most pieces an amount can be, so the most the far mint charges
  for (const sats of [100, 500, 1181, 2047, 4095]) {
    S.start = snapshot([P, Rx]);
    const macBefore = pileAt(P, MAC);
    const t0 = Date.now();
    const x = await crossPay(P, Rx, sats);
    ok(sats + ' sats: the payer quotes the move, makes it, and pays the request there locked to them',
       x.stage === 'pay' && !!x.t.made && !!x.t.made.lockedTo,
       x.stage === 'pay' && x.t.made ? 'moved ' + x.plan.moving + ' (' + x.plan.padSats + ' of it padding), fee up to ' + x.plan.feeSats
         + '; ' + x.t.made.sats + ' sats left it at macadamia; told: ' + x.said
       : 'stopped at the ' + x.stage + ': ' + x.said);
    if (x.stage === 'pay' && x.t.made) asked += sats;
    ok(sats + ' sats: the payer ends back on its own mint', canon(P.W.mintUrl) === MB, 'on ' + nameOf(P.W.mintUrl));
    const left = pileAt(P, MAC) - macBefore;
    say('the crossing left ' + left + ' sats of the payer’s at macadamia in ' + piecesAt(P, MAC) + ' pieces; the receiver was told: '
      + (x.t ? x.t.rxTold() : 'nothing') + '; in ' + (Date.now() - t0) + ' ms');
    const mid = limbo(Rx);
    ok(sats + ' sats: the offline receiver holds it as its own, unswapped', x.stage === 'pay' && !!x.t.made && mid.unclaimed >= asked,
       limboLine(mid));
    await catchUp(P);
    const bp = await books(P);
    ok(sats + ' sats: the payer’s entries add up at both mints', booksOff(bp) === 0, booksLine(bp));
    R.table.push({ id: S.id, label: 'minibits→mac receiver offline, ' + sats, rail: 'moved, then ecash', asked: sats,
      rxGot: x.stage === 'pay' && x.t.made ? sats : 0, payerPaid: S.start[P.name] - pileAll(P),
      cost: S.start[P.name] - pileAll(P) - (x.stage === 'pay' && x.t.made ? sats : 0), ms: Date.now() - t0,
      calm: true, payerLimbo: 0, rxLimbo: 0, payerOff: booksOff(bp), rxOff: 0,
      change: left + ' left at macadamia' });
  }
  S.start = snapshot([P, Rx]);
  const before = pileAt(Rx, MAC);
  setOffline(Rx, false);
  await reopen(Rx);
  await reopen(P);
  ok('opened again, the payer wakes on its own mint', P.wokeAt === MB, 'on ' + nameOf(P.wokeAt));
  const o = await outcome(S, P, Rx, 'minibits→mac receiver offline: receiver back online', asked, { rail: 'catch-up', cost: '' });
  ok('the receiver, online again, holds every figure it asked for', pileAt(Rx, MAC) - before === asked,
     'asked ' + asked + ' in all, up by ' + (pileAt(Rx, MAC) - before));
  verdict(o, asked, {});
});

/* ======================================================================= */
/* A phone that is lost before it ever comes online, and the twelve words.    */

scenario('rx-lost', 'same mint: an offline receiver takes locked ecash, then loses the phone — the words on a new one', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 1000 });
  const sats = 500;
  const startRx = pileAt(Rx, MAC), startP = pileAt(P, MAC);
  setOffline(Rx, true);
  const t = await tapEcash(P, Rx, sats);
  ok('paid, locked, to a receiver with no connection', !!t.made && !!t.made.lockedTo, t.said + '; the receiver was told: ' + t.rxTold());
  if (!t.made) return;
  await H.sleep(400);
  const held = limbo(Rx);
  ok('the receiver counts it as its own, unswapped', held.unclaimed >= sats, limboLine(held));
  const shown = await Rx.W.balanceSats();
  say('the receiver’s screen shows ' + shown + ' sats: ' + startRx + ' it had and ' + held.unclaimed + ' that only this phone has written down');

  // the phone is gone: its storage with it. The words are on paper.
  const words = Rx.keychain.words;
  kill(Rx, 'the phone is lost');
  const N = await restoreOnNewPhone(S, 'receiver (new phone)', words, [MAC], MAC);
  const Rn = N.p;
  const found = (N.rows[0] && N.rows[0].sats) || 0;
  ok('the words find what the old phone had swapped in', found === startRx && pileAt(Rn, MAC) === startRx,
     'the scan found ' + found + ', the new phone holds ' + pileAt(Rn, MAC) + ', the old one had ' + startRx + ' in its pile');
  const gone = limbo(Rn).unclaimed === 0 && pileAt(Rn, MAC) === startRx;
  say('the ' + sats + ' sat payment the old phone showed as received is ' + (gone ? 'NOT on the new phone' : 'on the new phone')
    + ': the payer made those pieces, so no walk of the receiver’s seed can find them');
  /* Is it gone for good? The pieces are locked to a key the receiver’s words
   * derive, and the payer’s entry still carries the token (`kept`, once a
   * locked payment is settled). */
  const tags = P.W.tagsFor(t.made.hash) || {};
  const kept = String(tags.kept || tags.token || '');
  ok('the payer’s entry still carries the payment, to show again', !!kept,
     kept ? 'a token of ' + ((P.W.tokenInfo(kept) || {}).sats) + ' sats under `' + (tags.kept ? 'kept' : 'token') + '`' : JSON.stringify(Object.keys(tags)));
  if (!kept) return;
  const back = await P.W.reclaimToken(kept).then((r) => 'TOOK IT BACK: ' + r.sats, (e) => 'refused: ' + e.message);
  ok('and the payer cannot take it back itself', /^refused/.test(back), back.slice(0, 110));
  const took = await Rn.W.receiveToken(kept).then((r) => r, (e) => ({ err: e.message }));
  ok('scanned on the new phone it is taken: the lock’s key comes from the words', !took.err && took.sats === sats,
     took.err ? took.err : 'took ' + took.sats + ' sats; the phone was asked for ' + Rn.native.asks.filter((a) => a.action === 'p2pkPubkeys').length
       + ' batch(es) of lock keys to find it');
  await catchUp(Rn);
  ok('the new phone holds what the old one had and the payment', pileAt(Rn, MAC) === startRx + sats, pileAt(Rn, MAC) + ' at macadamia');
  const again = await Rn.W.receiveToken(kept).then((r) => 'TOOK ' + r.sats, (e) => 'refused: ' + e.message);
  ok('and the same token a second time is refused', /^refused/.test(again), again.slice(0, 100));
  await catchUp(P);
  const ghost = await phantom(Rn), ghostP = await phantom(P);
  ok('neither phone shows ecash the mint says is spent', !ghost && !ghostP, 'new phone ' + ghost + ', payer ' + ghostP);
  const bp = await books(P), br = await books(Rn);
  ok('the payer’s entries add up', booksOff(bp) === 0, booksLine(bp));
  /* The new phone has no history: a restore writes none. Its entries can only
   * speak for what happened on it. */
  const rows = await Rn.W.transactions(50);
  say('the new phone’s history: ' + (await entriesLine(Rn)) + ' — ' + rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies') + ' for '
    + pileAt(Rn, MAC) + ' sats held; ' + booksLine(br));
  ok('nothing is left in between on either phone', calm(limbo(P)) && calm(limbo(Rn)), limboLine(limbo(P)) + ' / ' + limboLine(limbo(Rn)));
  R.table.push({ id: S.id, label: 'mac→mac receiver offline, phone lost, ' + sats, rail: 'ecash, locked; words', asked: sats,
    rxGot: pileAt(Rn, MAC) - startRx, payerPaid: startP - pileAt(P, MAC), cost: startP - pileAt(P, MAC) - (pileAt(Rn, MAC) - startRx),
    calm: calm(limbo(P)) && calm(limbo(Rn)), payerLimbo: 0, rxLimbo: 0, payerOff: booksOff(bp), rxOff: 0,
    change: 'restored phone: entries say ' + sum(br.map((x) => x.says)) + ', holds ' + sum(br.map((x) => x.holds)) });
});

scenario('payer-restore', 'same mint: a payer pays offline, then restores its words on a new phone before it ever comes online', async (S) => {
  /* (a) from exact pieces: nothing is owed either way */
  {
    const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
    const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
    setOffline(P, true);
    let paid = 0;
    for (const sats of [100, 37]) {
      const t = await tapEcash(P, Rx, sats);
      ok('(a) ' + sats + ' sats paid offline from exact pieces', !!t.made && t.made.swapped === false && !t.made.over,
         t.made ? t.made.sats + ' sats left it, the mint not asked; told: ' + t.said : t.said);
      if (t.made) paid += sats;
      await H.sleep(500);
    }
    ok('(a) the receiver swapped them in', pileAt(Rx, MAC) === paid, pileAt(Rx, MAC) + ' of ' + paid);
    const oldPile = pileAt(P, MAC);
    const words = P.keychain.words;
    kill(P, 'the phone is lost, never having been online since it paid');
    const N = await restoreOnNewPhone(S, 'payer (new phone)', words, [MAC], MAC);
    const Pn = N.p;
    ok('(a) the words find exactly what the old phone still held: the pieces it paid with are counted as spent',
       pileAt(Pn, MAC) === oldPile && !N.rows[0].partial,
       'old phone ' + oldPile + ', scan ' + N.rows[0].sats + ', new phone ' + pileAt(Pn, MAC) + (N.rows[0].partial ? ' (partial scan)' : ''));
    const ghost = await phantom(Pn);
    ok('(a) and the mint agrees every piece of it is unspent', !ghost, ghost + ' sats spent');
    const t2 = await tapEcash(Pn, Rx, 64);
    await H.sleep(800); await catchUp(Rx); await catchUp(Pn);
    ok('(a) the restored phone can pay: its counters are where the mint’s are', !!t2.made && pileAt(Rx, MAC) === paid + 64,
       t2.said + '; receiver holds ' + pileAt(Rx, MAC));
    const br = await books(Rx);
    ok('(a) the receiver’s entries add up', booksOff(br) === 0, booksLine(br));
    const bn = await books(Pn);
    say('(a) the restored payer’s history: ' + (await entriesLine(Pn)) + '; ' + booksLine(bn));
    ok('(a) nothing is left in between', calm(limbo(Pn)) && calm(limbo(Rx)), limboLine(limbo(Pn)) + ' / ' + limboLine(limbo(Rx)));
    R.table.push({ id: S.id, label: '(a) exact pieces, then the words', rail: 'ecash, plain; words', asked: paid + 64,
      rxGot: pileAt(Rx, MAC), payerPaid: 4000 - pileAt(Pn, MAC), cost: 4000 - pileAt(Pn, MAC) - pileAt(Rx, MAC),
      calm: true, payerLimbo: 0, rxLimbo: 0, payerOff: 0, rxOff: booksOff(br),
      change: 'restored phone: entries say ' + sum(bn.map((x) => x.says)) + ', holds ' + sum(bn.map((x) => x.holds)) });
  }
  /* (b) paying over, with the change handed back locked and written down
   *     offline: the change is on the lost phone and nowhere the words reach */
  {
    const P = await phone(S, 'payer', MAC, { fund: 4000, pool: false });
    const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
    setOffline(P, true);
    const sats = 700;
    const t = await tapEcash(P, Rx, sats);
    ok('(b) ' + sats + ' sats paid offline by handing over more', !!t.made && t.made.over > 0,
       t.made ? t.made.sats + ' left it, ' + t.made.over + ' to come back; told: ' + t.said : t.said);
    if (!t.made) return;
    await H.sleep(3500);
    const kept = P.changes.filter((c) => !c.refused);
    const change = limbo(P).unclaimed;
    ok('(b) the change crossed the link and the offline payer wrote it down', kept.length === 1 && change > 0,
       t.L.log.join(' | ') + '; ' + JSON.stringify(P.changes) + '; ' + limboLine(limbo(P)));
    const oldPile = pileAt(P, MAC);
    const words = P.keychain.words;
    kill(P, 'the phone is lost with change it never swapped in');
    const N = await restoreOnNewPhone(S, 'payer (new phone)', words, [MAC], MAC);
    const Pn = N.p;
    ok('(b) the words find the pile', pileAt(Pn, MAC) === oldPile, 'old ' + oldPile + ', new ' + pileAt(Pn, MAC));
    ok('(b) the change the old phone had written down is not on the new one (the receiver made those pieces)',
       limbo(Pn).unclaimed === 0, limboLine(limbo(Pn)));
    // the receiver's entry for the payment carries the change token, to show
    const rrows = await Rx.W.transactions(20);
    const entry = rrows.find((e) => e.dir === 'in' && /^req-/.test(String(e.hash || '')));
    const rtags = entry ? (Rx.W.tagsFor(entry.hash) || {}) : {};
    const ctok = String(rtags.changeToken || rtags.token || '');
    ok('(b) the receiver’s entry for the payment still carries the change, to show again', !!ctok,
       entry ? JSON.stringify({ sats: entry.sats, changeSats: entry.changeSats, changeState: entry.changeState, has: Object.keys(rtags) }) : 'no entry');
    if (ctok) {
      const took = await Pn.W.receiveToken(ctok).then((r) => r, (e) => ({ err: e.message }));
      ok('(b) scanned on the new phone the change is taken: its lock is a key the words derive', !took.err && took.sats > 0,
         took.err || ('took ' + took.sats + ' of the ' + change + ' the old phone was holding'));
    }
    await catchUp(Pn); await catchUp(Rx);
    const down = 4000 - pileAt(Pn, MAC);
    ok('(b) in the end the payer is down the payment and the fees, not the change', down >= sats && down <= sats + 12,
       'down ' + down + ' for a ' + sats + ' sat payment; the receiver holds ' + pileAt(Rx, MAC));
    const ghost = await phantom(Pn), ghostR = await phantom(Rx);
    ok('(b) neither phone shows ecash the mint says is spent', !ghost && !ghostR, 'payer ' + ghost + ', receiver ' + ghostR);
    const br = await books(Rx);
    say('(b) the receiver holds ' + pileAt(Rx, MAC) + ' for a ' + sats + ' sat payment; ' + booksLine(br) + ' [2 short when change is made, and a sat out, are known]');
    R.table.push({ id: S.id, label: '(b) paid over, change on the lost phone', rail: 'ecash, plain + change; words', asked: sats,
      rxGot: pileAt(Rx, MAC), payerPaid: down, cost: down - pileAt(Rx, MAC),
      calm: calm(limbo(Pn)) && calm(limbo(Rx)), payerLimbo: limboSats(limbo(Pn)), rxLimbo: limboSats(limbo(Rx)), payerOff: 0, rxOff: booksOff(br) });
  }
});

/* ======================================================================= */
/* The same ecash handed over twice.                                          */

scenario('replay-off', 'same mint: one locked payment handed three ways again to a receiver that is still offline', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
  S.start = snapshot([P, Rx]);
  setOffline(Rx, true);
  const sats = 300;
  const t = await tapEcash(P, Rx, sats);
  ok('paid, locked, to a receiver with no connection', !!t.made && !!t.made.lockedTo, t.said);
  if (!t.made) return;
  await H.sleep(300);
  const once = limbo(Rx).unclaimed;
  const rowsOnce = (await Rx.W.transactions(50)).filter((e) => e.dir === 'in').length;
  const body = t.L.lastBody;

  // 1. the very same message again, over a link that is still up
  const a0 = Rx.answers.length;
  Rx.W._requestPaid(body, 'wire-replay-1', 'tap');
  await H.sleep(400);
  const a1 = Rx.answers.slice(a0)[0] || {};
  ok('1. the same message a second time is refused', a1.status && a1.status !== 200, a1.status + ' ' + String(a1.text || '').slice(0, 90));

  // 2. the payer shows the payment as a code and the receiver scans it
  const tags = P.W.tagsFor(t.made.hash) || {};
  const tok = String(tags.kept || tags.token || '');
  const scan = await Rx.W.receiveToken(tok).then((r) => 'TAKEN: ' + JSON.stringify({ sats: r.sats, kept: r.kept }), (e) => 'refused: ' + e.message);
  ok('2. the same payment shown as a code and scanned is refused', /^refused/.test(scan), scan.slice(0, 120));

  // 3. the same pieces dressed as the answer to a fresh request from the receiver
  const fresh = Rx.W.paymentRequest(sats, { purpose: 'receive' });
  const freshId = (P.W.decodeRequest(fresh) || {}).id;
  let forged = '';
  try { const j = JSON.parse(body); j.id = freshId; forged = JSON.stringify(j); } catch (e) {}
  const b0 = Rx.answers.length;
  Rx.W._requestPaid(forged, 'wire-replay-3', 'tap');
  await H.sleep(400);
  const b1 = Rx.answers.slice(b0)[0] || {};
  ok('3. the same pieces sent as the answer to a new request are refused', b1.status && b1.status !== 200, b1.status + ' ' + String(b1.text || '').slice(0, 90));

  const after = limbo(Rx).unclaimed;
  const rowsAfter = (await Rx.W.transactions(50)).filter((e) => e.dir === 'in').length;
  ok('the offline receiver still counts one payment, once', after === once && rowsAfter === rowsOnce,
     'waiting ' + after + ' (was ' + once + '), ' + rowsAfter + ' entr' + (rowsAfter === 1 ? 'y' : 'ies') + ' in (was ' + rowsOnce + ')');
  setOffline(Rx, false);
  await reopen(Rx);
  await catchUp(P);
  const o = await outcome(S, P, Rx, 'mac→mac receiver offline, replayed x3, ' + sats, sats, { rail: 'ecash, locked' });
  verdict(o, sats, { rxGot: sats, maxCost: 6 });
});

scenario('replay-claimed', 'same mint: a payment the receiver claimed online is shown to it again as a code while it is offline', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
  S.start = snapshot([P, Rx]);
  const sats = 300;
  const t = await tapEcash(P, Rx, sats);
  ok('paid over the link, both online', !!t.made, t.said);
  if (!t.made) return;
  await H.sleep(1200);
  await catchUp(Rx);
  ok('the receiver has swapped it in', pileAt(Rx, MAC) === sats && limbo(Rx).unclaimed === 0, pileAt(Rx, MAC) + ' in the pile, ' + limboLine(limbo(Rx)));
  const tags = P.W.tagsFor(t.made.hash) || {};
  const tok = String(tags.kept || tags.token || '');
  ok('the payer’s entry still carries the token, to show (`kept`)', !!tok, Object.keys(tags).join(','));
  if (!tok) return;

  // later, with no connection: the same token, shown as a code and scanned
  setOffline(Rx, true);
  const shownBefore = await Rx.W.balanceSats();
  const scan = await Rx.W.receiveToken(tok).then((r) => ({ taken: r }), (e) => ({ refused: e.message }));
  const shownAfter = await Rx.W.balanceSats();
  const rows = (await Rx.W.transactions(50)).filter((e) => e.dir === 'in');
  ok('scanned offline, ecash this phone has already spent is refused', !!scan.refused,
     scan.refused ? scan.refused.slice(0, 110)
       : 'TAKEN as received: ' + JSON.stringify({ sats: scan.taken.sats, kept: scan.taken.kept, hash: scan.taken.hash })
         + '; the balance on screen went ' + shownBefore + ' → ' + shownAfter + '; ' + rows.length + ' receive entries: '
         + rows.map((e) => '+' + e.sats + ' ' + (e.state || '') + (e.settled ? ' settled' : '')).join(', '));
  ok('and the offline receiver is not shown money it does not have', shownAfter === shownBefore,
     'the screen shows ' + shownAfter + ', the receiver really has ' + sats);
  // a second showing of it
  const scan2 = await Rx.W.receiveToken(tok).then((r) => 'TAKEN again: ' + r.sats, (e) => 'refused: ' + e.message);
  say('scanned a second time while still offline: ' + scan2.slice(0, 110));

  /* And one the receiver took by scanning it while it had a connection, whose
   * entry is named after the clock and not after the request: shown again
   * offline. (Taken first by a scan with NO connection, the entry is named
   * after the pieces and the second showing is caught.) */
  setOffline(Rx, false);
  const made = await P.W.sendToken(120, { unit: 'sat', lockTo: (P.W.decodeRequest(Rx.W.paymentRequest(120, { purpose: 'receive' })) || {}).lockTo });
  const first = await Rx.W.receiveToken(made.token).then((r) => r.sats, (e) => 'refused: ' + e.message);
  setOffline(Rx, true);
  const before3 = await Rx.W.balanceSats();
  const scan3 = await Rx.W.receiveToken(made.token).then((r) => 'TAKEN as received: ' + r.sats + ' sats, kept ' + !!r.kept, (e) => 'refused: ' + e.message);
  ok('a locked token scanned and swapped in online, scanned again offline, is refused', first === 120 && /^refused/.test(scan3),
     'first scan took ' + first + '; the second, offline: ' + scan3.slice(0, 100) + '; the screen went ' + before3 + ' \u2192 ' + (await Rx.W.balanceSats()));

  // back online: what the mint makes of it, and what is left on the books
  setOffline(Rx, false);
  await reopen(Rx);
  await catchUp(P);
  const o = await outcome(S, P, Rx, 'mac→mac, claimed, then replayed offline, ' + (sats + 120), sats + 120, { rail: 'ecash, locked' });
  say('back online: the receiver holds ' + pileAt(Rx, MAC) + '; its entries: ' + await entriesLine(Rx));
  verdict(o, sats + 120, { rxGot: sats + 120, maxCost: 10 });
});

/* ======================================================================= */
/* Chains of payments with no connection in between.                          */

scenario('multi-rx', 'same mint: one offline payer pays three receivers in a row, then comes online', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const rxs = [];
  for (const n of ['receiver A', 'receiver B', 'receiver C']) rxs.push(await phone(S, n, MAC, { fund: 0 }));
  const startP = pileAt(P, MAC);
  setOffline(P, true);
  const want = [64, 250, 1181];
  const seen = {};
  let reused = 0, paid = 0, left = 0;
  const overAt = [];
  for (let i = 0; i < 3; i++) {
    const Rx = rxs[i], sats = want[i];
    const t = await tapEcash(P, Rx, sats);
    overAt[i] = !!(t.made && (t.made.over > 0 || t.made.dust > 0));
    ok(Rx.name + ', ' + sats + ' sats: paid with no connection on the payer', !!t.made,
       t.made ? t.made.sats + ' sats left it' + (t.made.swapped === false ? ', the mint not asked' : '')
         + (t.made.over ? ', ' + t.made.over + ' over, to come back' : '') + '; told: ' + t.said : t.said);
    if (!t.made) continue;
    paid += sats; left += t.made.sats - (t.made.over || 0);
    secretsOf(t.L.lastBody).forEach((s) => { if (seen[s]) reused++; seen[s] = true; });
    await H.sleep(t.made.over ? 3200 : 600);
  }
  ok('no piece went to two receivers', reused === 0, Object.keys(seen).length + ' pieces handed over in all, ' + reused + ' of them twice');
  for (let i = 0; i < 3; i++) {
    await catchUp(rxs[i]);
    // exactly, or a sat or two over where the payer paid over by too little to be worth sending back (`changeFor`)
    const heldI = pileAt(rxs[i], MAC);
    ok(rxs[i].name + ' holds what it asked for', heldI === want[i] || (overAt[i] && heldI > want[i] && heldI <= want[i] + 2),
       'asked ' + want[i] + ', holds ' + heldI);
  }
  const mid = limbo(P);
  say('still offline, the payer holds ' + pileAt(P, MAC) + ' in its pile and ' + mid.unclaimed + ' waiting as change; down '
    + (startP - pileAt(P, MAC) - mid.unclaimed) + ' for ' + paid + ' paid');
  setOffline(P, false);
  await reopen(P);
  const down = startP - pileAt(P, MAC);
  ok('online again, the payer is down what it paid and the receivers’ fees, no more', down >= paid && down <= paid + 12,
     'paid ' + paid + ', down ' + down);
  await audit(P, { changes: P.changes.filter((c) => !c.refused).length });
  for (const Rx of rxs) await audit(Rx);
  R.table.push({ id: S.id, label: 'mac→mac payer offline, three receivers', rail: 'ecash, plain', asked: paid,
    rxGot: sum(rxs.map((r) => pileAt(r, MAC))), payerPaid: down, cost: down - sum(rxs.map((r) => pileAt(r, MAC))),
    calm: calm(limbo(P)), payerLimbo: limboSats(limbo(P)), rxLimbo: 0, payerOff: booksOff(await books(P)), rxOff: 0 });
});

/* B was paid while it had no connection, so everything it holds is ecash
 * still locked to it, in the unclaimed store and not in the pile. It pays C
 * out of that (19-bill-split.js `forwardLocked`, the `withLocked` branch of
 * `sendToken`): the pieces are signed here and handed on as they are. */
async function lockedOnly(S, amounts) {
  const A = await phone(S, 'first payer', MAC, { fund: 4000, pool: true });
  const B = await phone(S, 'middle phone', MAC, { fund: 0 });
  const C = await phone(S, 'last receiver', MAC, { fund: 0 });
  setOffline(B, true);
  const got = [];
  for (const sats of amounts) {
    const t = await tapEcash(A, B, sats);
    got.push({ sats, t });
    await H.sleep(300);
  }
  return { A, B, C, got };
}

scenario('fwd-locked', 'same mint: an offline phone holding only ecash locked to itself pays an online receiver with it', async (S) => {
  const { A, B, C, got } = await lockedOnly(S, [600, 300]);
  ok('the middle phone was paid twice while offline, locked', got.every((g) => g.t.made && g.t.made.lockedTo),
     got.map((g) => g.sats + ': ' + g.t.said).join('; '));
  const waiting0 = limbo(B).unclaimed;
  ok('it holds that as ecash only it can spend, and nothing in its pile', waiting0 >= 900 && pileAt(B, MAC) === 0,
     waiting0 + ' waiting, pile ' + pileAt(B, MAC) + '; the screen shows ' + await B.W.balanceSats());

  const pay = [400, 200];
  let paid = 0, handed = 0, short = 0;
  for (const sats of pay) {
    const before = limbo(B).unclaimed;
    const heldC = pileAt(C, MAC);
    const t = await tapEcash(B, C, sats);
    ok(sats + ' sats: paid out of ecash still locked to the payer, with no connection', !!t.made,
       t.made ? t.made.sats + ' sats left it' + (t.made.over ? ', ' + t.made.over + ' over, to come back' : '') + '; told: ' + t.said
         + '; the receiver was told: ' + t.rxTold() : t.said);
    if (!t.made) continue;
    await H.sleep(t.made.over ? 3200 : 900);
    await catchUp(C);
    paid += sats; handed += t.made.sats - (t.made.over || 0);
    const lockedIn = secretsOf(t.L.lastBody).filter((s) => /^\s*\[\s*"P2PK"/.test(s)).length;
    const up = pileAt(C, MAC) - heldC;
    // exactly, or a sat or two over where making the change cost less than the payer allowed for (`settleChangeMade`)
    okOrKnown(sats + ' sats: the receiver swapped the signed pieces in and holds the figure it asked for',
       up === sats || (t.made.over > 0 && up > sats && up <= sats + 2), 'K3',
       t.made.over > 0 && sats - up > 0 && sats - up <= 4,
       'up by ' + up + ', asked ' + sats + '; ' + lockedIn + ' of ' + secretsOf(t.L.lastBody).length + ' pieces arrived locked and signed');
    short += sats - up;
    say('the middle phone had ' + before + ' waiting, now ' + limbo(B).unclaimed + (B.changes.length ? '; change ' + JSON.stringify(B.changes) : ''));
  }
  const shown = await B.W.balanceSats();
  ok('still offline, the middle phone’s screen shows what it took less what it handed on', shown === limbo(B).unclaimed + pileAt(B, MAC)
     && shown <= waiting0 - paid, 'shows ' + shown + '; took ' + waiting0 + ', paid ' + paid);
  setOffline(B, false);
  await reopen(B);
  await catchUp(A); await catchUp(C);
  const end = pileAt(B, MAC);
  ok('online again, it holds what it took less what it paid, and no more than the fees are gone',
     end <= 900 - paid && end >= 900 - paid - 14, 'took 900, paid ' + paid + ', holds ' + end);
  await audit(B, { changes: B.changes.filter((c) => !c.refused).length });
  await audit(C);
  await audit(A);
  R.table.push({ id: S.id, label: 'mac→mac from ecash locked to the payer', rail: 'ecash, locked, handed on', asked: paid,
    rxGot: pileAt(C, MAC), payerPaid: 900 - end, cost: 900 - end - pileAt(C, MAC),
    calm: calm(limbo(B)), payerLimbo: limboSats(limbo(B)), rxLimbo: 0, payerOff: booksOff(await books(B)), rxOff: booksOff(await books(C)) });
});

/* The same payment stopped half-way: it needs pieces of two payments, each
 * signed with its own key from the phone, and the app dies — or the phone
 * will not give the key — between the first signature and the second. */
for (const how of [
  { id: 'fwd-kill', what: 'the app is killed between the two signatures', kill: true },
  { id: 'fwd-refuse', what: 'the phone will not give the second key', kill: false },
]) {
  scenario(how.id, 'same mint: paying out of two locked payments, and ' + how.what, async (S) => {
    const { A, B, C, got } = await lockedOnly(S, [300, 300]);
    ok('the middle phone holds two locked payments and nothing else', got.every((g) => g.t.made) && pileAt(B, MAC) === 0,
       limboLine(limbo(B)));
    const waiting0 = limbo(B).unclaimed;
    const tokens0 = Object.keys(store(B, 'foxy.req.unclaimed', {})).length;
    let keys = 0;
    B.native.hooks.refuse = (m) => {
      if (m.action !== 'p2pkKey' && m.action !== 'p2pkPubkeys') return null;
      if (m.action === 'p2pkKey') keys += 1;
      if (keys < 2) return null;
      if (how.kill) { kill(B, 'between the two signatures'); return 'gone'; }
      return 'The seed could not be read.';
    };
    const sats = 450;
    const died = new Promise((done) => {
      const look = setInterval(() => { if (B.killedAt) { clearInterval(look); done({ err: 'the app was killed (' + B.killedAt + ')', killed: true, said: 'nothing: the app was killed' }); } }, 20);
      setTimeout(() => clearInterval(look), 60000).unref();
    });
    const t = await Promise.race([died, tapEcash(B, C, sats)]);
    ok('the payment is not made', !t.made, t.said);
    await H.sleep(500);
    ok('and nothing reached the receiver', pileAt(C, MAC) === 0 && limbo(C).unclaimed === 0, 'receiver holds ' + pileAt(C, MAC));
    if (how.kill) { await reopen(B); } else { B.native.hooks.refuse = null; }
    const waiting1 = limbo(B).unclaimed;
    const handedList = store(B, 'foxy.req.handedon', []);
    const rows1 = store(B, 'foxy.req.unclaimed', {});
    const tokenOnFile = store(B, 'foxy.cashu.outtoken', null);
    say('before: ' + waiting0 + ' sats waiting in ' + tokens0 + ' payments. After: ' + waiting1 + ' waiting in ' + Object.keys(rows1).length
      + '; ' + handedList.length + ' piece(s) written down as handed on; a token on file for it: ' + !!(tokenOnFile && tokenOnFile.token)
      + '; history: ' + await entriesLine(B));
    ok('the middle phone still shows all of what it was paid: nothing left it', waiting1 === waiting0,
       'was ' + waiting0 + ', now ' + waiting1 + ': ' + (waiting0 - waiting1) + ' sats are in no pile, no waiting payment and no token');
    // the person tries again
    const t2 = await tapEcash(B, C, sats);
    await H.sleep(t2.made && t2.made.over ? 3200 : 900);
    await catchUp(C);
    ok('trying again, the payment is made out of what it holds', !!t2.made && pileAt(C, MAC) === sats,
       (t2.made ? 'paid; ' : t2.said + '; ') + 'the receiver holds ' + pileAt(C, MAC));
    setOffline(B, false);
    await reopen(B);
    await catchUp(A); await catchUp(C);
    const end = pileAt(B, MAC), gotC = pileAt(C, MAC);
    ok('online again, the middle phone and the receiver hold between them what was paid in, less fees',
       end + gotC <= 600 && end + gotC >= 600 - 14, 'paid in 600; middle phone ' + end + ', receiver ' + gotC + ': ' + (600 - end - gotC) + ' gone');
    await audit(B);
    await audit(C);
    R.table.push({ id: S.id, label: 'paying from two locked payments, ' + (how.kill ? 'killed' : 'key refused') + ' half-way', rail: 'ecash, locked, handed on', asked: sats,
      rxGot: gotC, payerPaid: 600 - end, cost: 600 - end - gotC,
      calm: calm(limbo(B)), payerLimbo: limboSats(limbo(B)), rxLimbo: 0, payerOff: booksOff(await books(B)), rxOff: booksOff(await books(C)) });
    /* Is what went missing really gone? The pieces are still unspent at the
     * mint, locked to the middle phone; the only copy left is the first
     * payer's own (`kept`). */
    if (600 - end - gotC > 14) {
      const tried = [];
      let back = 0, pieces = 0;
      for (const g of got) {
        const tg = A.W.tagsFor(g.t.made.hash) || {};
        const tok = String(tg.kept || tg.token || '');
        if (!tok) { tried.push('no token on the first payer’s entry'); continue; }
        const r = await B.W.receiveToken(tok).then((x) => 'took ' + x.sats, (e) => 'refused: ' + e.message);
        tried.push(String(r).slice(0, 60));
        // and piece by piece, which no screen in the app does
        const info = A.W.tokenInfo(tok) || {};
        for (const pr of (info.proofs || [])) {
          const one = B.b.w.CashuTS.getEncodedToken({ mint: info.mint, proofs: [pr], unit: 'sat' });
          const got1 = await B.W.receiveToken(one).then((x) => x.sats, () => 0);
          if (got1 > 0) { back += got1; pieces += 1; }
        }
      }
      note('the ' + (600 - end - gotC) + ' sats that went missing: the first payer’s own copies of the two payments, scanned whole on the middle phone: '
        + tried.join(' | ') + '. Taken apart by the test and scanned one piece at a time: ' + back + ' sats came back in ' + pieces
        + ' piece(s) — so the ecash is unspent and still the middle phone’s, and nothing in the app can reach it');
    }
  });
}

scenario('fwd-cut', 'same mint: paying out of locked ecash, killed with the signed token made and not yet handed over', async (S) => {
  const { A, B, C, got } = await lockedOnly(S, [600]);
  ok('the middle phone holds one locked payment and nothing else', got.every((g) => g.t.made) && pileAt(B, MAC) === 0, limboLine(limbo(B)));
  const sats = 250;
  B.killOnSend = 'as the signed token leaves for the link';
  const died = new Promise((done) => {
    const look = setInterval(() => { if (B.killedAt) { clearInterval(look); done({ err: 'the app was killed (' + B.killedAt + ')', killed: true, said: 'nothing: the app was killed' }); } }, 20);
    setTimeout(() => clearInterval(look), 60000).unref();
  });
  const t = await Promise.race([died, tapEcash(B, C, sats)]);
  ok('the app died with the payment made and not delivered', !!t.killed, t.said);
  await reopen(B);       // still offline
  const rows = await B.W.transactions(20);
  const out = rows.find((e) => e.dir === 'out');
  const tags = out ? (B.W.tagsFor(out.hash) || {}) : {};
  const tok = String(tags.token || '');
  const last = B.W.lastToken && B.W.lastToken();
  ok('opened again, the payment is on its own entry as a token to hand over', !!tok,
     out ? JSON.stringify({ sats: out.sats, state: out.state, changeSats: out.changeSats, changeState: out.changeState, tags: Object.keys(tags) })
       + '; last token on file: ' + !!(last && last.token) : 'no entry for it at all');
  const shown = await B.W.balanceSats();
  say('the middle phone’s screen shows ' + shown + ' (' + limbo(B).unclaimed + ' waiting); it took 600');
  if (tok) {
    const took = await C.W.receiveToken(tok).then((r) => r.sats, (e) => 'refused: ' + e.message);
    ok('shown as a code, the receiver takes it', typeof took === 'number' && took >= sats, String(took).slice(0, 100));
  }
  setOffline(B, false);
  await reopen(B);
  await H.sleep(1500);
  await catchUp(C);
  /* The token names a key for its change (`over-cut`), so
   * the receiver makes the difference and shows it; the middle phone scans it. */
  const cRow = (await C.W.transactions(5)).find((e) => e.dir === 'in' && e.changeSats > 0) || null;
  const cTags = cRow ? (C.W.tagsFor(cRow.hash) || {}) : {};
  if (cTags.changeToken) {
    const back = await B.W.receiveToken(cTags.changeToken).then((r) => 'kept ' + r.sats, (e) => 'refused: ' + e.message);
    ok('the difference comes back to the middle phone as a code it scans', /^kept /.test(back), back);
  }
  const end = pileAt(B, MAC), gotC = pileAt(C, MAC);
  ok('online again, nothing but fees is gone', end + gotC <= 600 && end + gotC >= 600 - 14,
     'paid in 600; middle phone ' + end + ', receiver ' + gotC + ': ' + (600 - end - gotC) + ' gone');
  say('the middle phone’s entries: ' + await entriesLine(B));
  await audit(B);
  R.table.push({ id: S.id, label: 'paying from locked ecash, killed before the hand-over', rail: 'ecash, locked, handed on', asked: sats,
    rxGot: gotC, payerPaid: 600 - end, cost: 600 - end - gotC, calm: calm(limbo(B)), payerLimbo: limboSats(limbo(B)), rxLimbo: 0,
    payerOff: booksOff(await books(B)), rxOff: booksOff(await books(C)) });
});

scenario('rx-many', 'same mint: an offline receiver takes locked payments from three payers, and one claim is cut when it comes online', async (S) => {
  const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
  const payers = [];
  for (const n of ['payer A', 'payer B', 'payer C']) payers.push(await phone(S, n, MAC, { fund: 1500, pool: true }));
  setOffline(Rx, true);
  const want = [200, 350, 125];
  let asked = 0;
  for (let i = 0; i < 3; i++) {
    const t = await tapEcash(payers[i], Rx, want[i]);
    ok(payers[i].name + ', ' + want[i] + ' sats: paid, locked, to the offline receiver', !!t.made && !!t.made.lockedTo, t.said + '; receiver told: ' + t.rxTold());
    if (t.made) asked += want[i];
    await H.sleep(200);
  }
  const mid = limbo(Rx);
  ok('the receiver holds all three, unswapped', mid.unclaimed >= asked, limboLine(mid) + '; the screen shows ' + await Rx.W.balanceSats());
  /* Online again, and the first of its swaps reaches the mint and the answer
   * is lost; then, on the same launch, the next one never leaves at all. */
  setOffline(Rx, false);
  await reopen(Rx, { faults: [
    { path: /\/v1\/swap$/, method: 'POST', fate: 'after', label: 'first claim: answer lost' },
    { path: /\/v1\/swap$/, method: 'POST', fate: 'before', label: 'second claim: never left' },
  ] });
  const lost = (Rx.b.rec.lost[0] || {});
  const after1 = limbo(Rx);
  say('first launch online: holds ' + pileAt(Rx, MAC) + ' in the pile, ' + limboLine(after1) + '; the screen shows ' + await Rx.W.balanceSats()
    + '; the mint answered the lost swap ' + (lost.status || '?'));
  ok('the screen never shows less than the three payments while the claims are sorted out',
     (await Rx.W.balanceSats()) + after1.held >= asked - 6, 'shows ' + await Rx.W.balanceSats() + ', held back ' + after1.held + ', asked ' + asked);
  Rx.faults = [];
  await catchUp(Rx);
  if (limbo(Rx).held || limbo(Rx).swapRecords) {
    say('held back: ' + limboLine(limbo(Rx)) + ' — waiting the twenty seconds the wallet waits');
    await H.sleep(23000);
    await catchUp(Rx);
  }
  await reopen(Rx);
  ok('in the end it holds every figure it asked for', pileAt(Rx, MAC) === asked, 'asked ' + asked + ', holds ' + pileAt(Rx, MAC));
  say('entries: ' + await entriesLine(Rx));
  await audit(Rx);
  for (const p of payers) { await catchUp(p); await audit(p); }
  R.table.push({ id: S.id, label: 'three payers, one offline receiver, a claim cut', rail: 'ecash, locked', asked: asked,
    rxGot: pileAt(Rx, MAC), payerPaid: sum(payers.map((p) => 1500 - pileAt(p, MAC))), cost: sum(payers.map((p) => 1500 - pileAt(p, MAC))) - pileAt(Rx, MAC),
    calm: calm(limbo(Rx)), payerLimbo: 0, rxLimbo: limboSats(limbo(Rx)), payerOff: 0, rxOff: booksOff(await books(Rx)) });
}, { timeout: 300000 });

/* ======================================================================= */
/* The route going, or the app dying, in the middle of a crossing.            */

scenario('ln-drop', 'across mints, by Lightning: the payer loses its route between the quote and the payment, and it comes back', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MB, { fund: 0 });
  const startP = pileAt(P, MAC);
  const sats = 300;
  // an invoice at their mint with no wallet behind it: the fake backend will "pay" it whatever happens here
  const inv = await bareInvoice(MB, sats);
  // the fee quote is answered; the route goes as the payment's own split leaves
  P.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'before', label: 'route lost', then: () => setOffline(P, true) });
  const t1 = await P.W.pay(inv.request).then((r) => ({ paid: r }), (e) => ({ err: (e && e.message) || String(e), e }));
  ok('the payer is not told it was paid', !t1.paid, t1.paid ? 'TOLD PAID: ' + JSON.stringify(t1.paid) : 'told: ' + t1.err);
  const mid = limbo(P);
  say('with no route: pile ' + pileAt(P, MAC) + ' of ' + startP + ', ' + limboLine(mid) + '; the screen shows ' + await P.W.balanceSats()
    + '; the mint was asked ' + JSON.stringify(P.b.rec.hits));
  ok('nothing was handed to the mint for it', !mid.melts, limboLine(mid));
  // the route comes back, in the same session
  P.faults = [];
  const t0 = Date.now();
  await routeBack(P);
  const back = limbo(P);
  ok('with the route back and no relaunch, everything it held is in its balance again', pileAt(P, MAC) === startP && calm(back),
     'pile ' + pileAt(P, MAC) + ' of ' + startP + ', ' + limboLine(back) + ', ' + Math.round((Date.now() - t0) / 1000) + ' s after the route came back');
  const bp0 = await books(P);
  ok('and the attempt cost it nothing its entries do not show', booksOff(bp0) === 0, booksLine(bp0));
  // and then it pays, for real
  S.start = snapshot([P, Rx]);
  const t = await tapLightning(P, Rx, sats);
  ok('paid again, the invoice is paid', !!t.paid && !t.paid.pending, t.paid ? t.ms + ' ms' : t.err);
  const got = await claimInvoice(Rx, t.inv);
  ok('and the receiver’s invoice screen claims it', !!got, JSON.stringify(got));
  await catchUp(P);
  const o = await outcome(S, P, Rx, 'mac→minibits, route lost at the split, then paid', sats, { rail: 'lightning', ms: t.ms });
  verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.02) + 6 });
});

/* The carry-home rail up to the moment the payer's ecash is the receiver's,
 * at the payer's mint. A little is already held there by the receiver, as in
 * tap-scenarios F16: without it the walk home fails for want of a few sats
 * (known), and what happens when it is cut could not be seen at all. */
async function carried(S, sats, o) {
  const opts = o || {};
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MB, { fund: 0 });
  await seedAt(Rx, MAC, opts.seed === undefined ? 64 : opts.seed);
  setOffline(P, true);
  S.start = snapshot([P, Rx]);
  const c = await carryAsk(P, Rx, sats);
  if (!c.terms) return { P, Rx, c, err: c.err };
  const t = await tapEcash(P, Rx, c.terms.ask, { text: c.text, theirRoute: true });
  await H.sleep(t.made && t.made.over ? 3200 : 700);
  return { P, Rx, c, t };
}
const HOME_UNPAID = () => ({ mint: MB, path: /\/v1\/mint\/bolt11$/, method: 'POST', fate: 'before', once: false, label: 'the home mint cannot be asked to issue' });

scenario('carry-drop', 'carried home: the receiver loses its route after taking the payment, before the melt home, and gets it back', async (S) => {
  const sats = 1000;
  const { P, Rx, c, t, err } = await carried(S, sats);
  if (!ok('the payer hands it over and the receiver takes it at the payer’s mint', !err && !!t.made && pileAt(Rx, MAC) >= c.terms.ask,
          err || (t.said + '; the receiver holds ' + pileAt(Rx, MAC) + ' at macadamia, asked ' + c.terms.ask + '; told: ' + t.rxTold()))) return;
  setOffline(Rx, true);
  const h = await carryNow(Rx, c);
  ok('the melt home is not made, and the receiver is told the payment is not home yet', h.state === 'retry' && /NOT HOME YET/.test(h.said), h.said.slice(0, 200));
  ok('which is true: it holds the payment at their mint, whole', pileAt(Rx, MAC) >= c.terms.ask && !limbo(Rx).melts,
     pileAt(Rx, MAC) + ' at macadamia, ' + limboLine(limbo(Rx)));
  ok('and it is back on its own mint', canon(Rx.W.mintUrl) === MB, 'on ' + nameOf(Rx.W.mintUrl));
  ok('no note of a crossing is left behind for a Lightning payment that never left', !moveNotes(Rx).length,
     moveNotes(Rx).length ? JSON.stringify(moveNotes(Rx).map((n) => n.amount)) : 'none');
  const job = carryJobs(Rx)[0];
  ok('the payment is still written down as one to bring home', !!job && job.state === 'paid', job ? job.state + ', ' + job.kept + ' kept' : 'no job');
  // the route comes back in the same sitting: nobody presses anything
  await routeBack(Rx);
  await catchUp(Rx);
  ok('with the route back, it is brought home without the person doing anything', pileAt(Rx, MB) >= sats && !carryJobs(Rx).length,
     pileAt(Rx, MB) + ' at minibits, ' + pileAt(Rx, MAC) + ' at macadamia; ' + limboLine(limbo(Rx)));
  ok('and the receiver is told it has arrived, once', Rx.carried.filter((r) => r.state === 'home').length === 1,
     JSON.stringify(Rx.carried.map((r) => r.state)));
  ok('still on its own mint, and that is the mint it has saved', canon(Rx.W.mintUrl) === MB && canon(store(Rx, 'foxy.cashu.mint', '')) === MB,
     'on ' + nameOf(Rx.W.mintUrl) + ', saved ' + nameOf(store(Rx, 'foxy.cashu.mint', '')));
  setOffline(P, false);
  await reopen(P);
  await reopen(Rx);
  ok('opened again, the receiver wakes on its own mint', Rx.wokeAt === MB, 'on ' + nameOf(Rx.wokeAt));
  const o = await outcome(S, P, Rx, 'mac→minibits payer offline, receiver’s route lost before the melt', sats, { rail: 'ecash, carried home late' });
  verdict(o, sats, { maxCost: Math.ceil(sats * 0.03) + 14 });
}, { timeout: 300000 });

scenario('carry-wake', 'carried home: the receiver’s app is killed part-way, and opens again where the app would open it', async (S) => {
  /* (a) killed with the payment taken and the melt home not started */
  {
    const sats = 1000;
    const { P, Rx, c, t, err } = await carried(S, sats);
    if (ok('(a) the payer hands it over and the receiver takes it at the payer’s mint', !err && !!t.made, err || t.said)) {
      kill(Rx, 'before the melt home');
      setOffline(P, false);
      await reopen(P);
      await reopen(Rx);
      ok('(a) opened again, the receiver’s app is on its own mint', Rx.wokeAt === MB, 'it opens on ' + nameOf(Rx.wokeAt));
      ok('(a) and the payment is brought home without the person doing anything', pileAt(Rx, MB) >= sats && !carryJobs(Rx).length,
         pileAt(Rx, MB) + ' at minibits, ' + pileAt(Rx, MAC) + ' at macadamia; ' + limboLine(limbo(Rx)) + '; told: ' + JSON.stringify(Rx.carried.map((r) => r.state)));
      ok('(a) it is still on its own mint afterwards', canon(Rx.W.mintUrl) === MB && canon(store(Rx, 'foxy.cashu.mint', '')) === MB, 'on ' + nameOf(Rx.W.mintUrl));
      const o = await outcome(S, P, Rx, '(a) receiver killed before the melt home, reopened as the app does', sats, { rail: 'ecash, carried home' });
      ok('(a) the payment is the receiver’s, whole', o.row.rxGot >= sats, 'up by ' + o.row.rxGot);
      verdict(o, sats, {});
    }
  }
  /* (b) killed with the melt home on its way: the mint pays it, nobody hears */
  {
    const sats = 1000;
    const { P, Rx, c, t, err } = await carried(S, sats);
    if (ok('(b) the payer hands it over and the receiver takes it at the payer’s mint', !err && !!t.made, err || t.said)) {
      Rx.faults.push({ path: /\/v1\/melt\/bolt11$/, method: 'POST', fate: 'after', kill: true, label: 'mid melt home' });
      Rx.W.carryHome(c.id, c.terms.plan, () => {}).catch(() => {});
      for (let i = 0; i < 40 && !Rx.killedAt; i++) await H.sleep(250);
      ok('(b) the receiver died with the melt home at the mint', !!Rx.killedAt, String(Rx.killedAt));
      await H.sleep(2500);
      setOffline(P, false);
      await reopen(P);
      await reopen(Rx);
      await H.sleep(1500); await catchUp(Rx);
      ok('(b) opened again, the receiver’s app is on its own mint', Rx.wokeAt === MB, 'it opens on ' + nameOf(Rx.wokeAt));
      const l1 = limbo(Rx);
      const landed = pileAt(Rx, MB);
      ok('(b) and the payment has landed at home without the person doing anything', landed >= sats && !l1.move && !l1.carry,
         landed + ' at minibits, ' + pileAt(Rx, MAC) + ' at macadamia; ' + limboLine(l1));
      ok('(b) and the receiver is told it has arrived, once', Rx.carried.filter((r) => r.state === 'home').length === 1, JSON.stringify(Rx.carried.map((r) => r.state)));
      // launched a second time, as a person would: nothing more happens
      await reopen(Rx);
      ok('(b) opened a second time, nothing changes', pileAt(Rx, MB) === landed && Rx.wokeAt === MB, pileAt(Rx, MB) + ' at minibits, on ' + nameOf(Rx.wokeAt));
      const o = await outcome(S, P, Rx, '(b) receiver killed mid melt home, reopened as the app does', sats, { rail: 'ecash, carried home' });
      verdict(o, sats, {});
    }
  }
}, { timeout: 300000 });

scenario('carry-twice', 'carried home twice in one sitting: the first claim at home fails after the melt, and the next payment is carried', async (S) => {
  const first = 1000, second = 300;
  const { P, Rx, c, t, err } = await carried(S, first);
  if (!ok('first payment: handed over and taken at the payer’s mint', !err && !!t.made, err || t.said)) return;
  const thereBefore = pileAt(Rx, MAC);
  // the melt home is made; the home mint cannot be reached for the claim
  Rx.faults = [HOME_UNPAID()];
  const h1 = await carryNow(Rx, c);
  const melted = (Rx.b.rec.hits['POST /v1/melt/bolt11'] || 0) > 0 && pileAt(Rx, MAC) < thereBefore;
  ok('first payment: the melt at the payer’s mint is made and the claim at home is not', h1.state === 'moving' && melted,
     h1.state + '; macadamia pile ' + thereBefore + ' → ' + pileAt(Rx, MAC) + '; home ' + pileAt(Rx, MB) + '; ' + limboLine(limbo(Rx)));
  const note1 = store(Rx, 'foxy.cashu.move', null);
  ok('first payment: a note says where the money went', !!note1 && !!note1.quote, note1 ? note1.amount + ' sats to ' + nameOf(note1.to) : 'no note');
  ok('first payment: what the receiver is told says where the money is', /ON ITS WAY TO YOUR MINT/.test(h1.said) && !/STILL AT THEIR MINT|RECEIVED,/.test(h1.said),
     'told “' + h1.said.slice(0, 150) + '”');
  ok('first payment: the receiver is back on its own mint', canon(Rx.W.mintUrl) === MB, 'on ' + nameOf(Rx.W.mintUrl));
  // the same sitting, the next customer: the home mint answers again
  Rx.faults = [];
  const c2 = await carryAsk(P, Rx, second);
  if (!ok('second payment: the receiver quotes the way home', !!c2.terms, c2.err || ('asking ' + c2.terms.ask))) return;
  const t2 = await tapEcash(P, Rx, c2.terms.ask, { text: c2.text, theirRoute: true });
  await H.sleep(t2.made && t2.made.over ? 3200 : 700);
  const h2 = await carryNow(Rx, c2);
  ok('second payment: handed over, taken and carried home', !!t2.made && !!h2.done, t2.made ? h2.said : t2.said);
  const notes = moveNotes(Rx);
  ok('the first payment is not forgotten by the second crossing: its note is there, or it is already home',
     notes.some((n) => n.quote === note1.quote) || pileAt(Rx, MB) >= first + second,
     notes.length ? notes.length + ' note(s): ' + notes.map((n) => n.amount + ' sats').join(', ') : 'no notes; ' + pileAt(Rx, MB) + ' at home');
  setOffline(P, false);
  await reopen(P);
  await reopen(Rx);
  const home = pileAt(Rx, MB);
  ok('both apps opened again: the receiver holds both payments at home', home >= first + second,
     home + ' at minibits for ' + (first + second) + ' asked; ' + pileAt(Rx, MAC) + ' at macadamia; ' + limboLine(limbo(Rx)));
  ok('and it was told of each arriving, once', Rx.carried.filter((r) => r.state === 'home').length === 1 && !!h2.done,
     'by the wallet: ' + JSON.stringify(Rx.carried.map((r) => r.state + (r.late ? ' (late)' : ''))) + '; the second at the time');
  const o = await outcome(S, P, Rx, 'mac→minibits carried home twice, first claim cut', first + second, { rail: 'ecash, carried home' });
  ok('the payer paid for both', o.row.payerPaid >= c.terms.ask + c2.terms.ask, 'down ' + o.row.payerPaid);
  verdict(o, first + second, {});
}, { timeout: 300000 });

/* ======================================================================= */
/* The payer-moves rail, cut after the Lightning payment.                     */

/* A far mint that has not caught up with the payment: the melt is made and
 * answered, and the claim at their mint is refused "Quote not paid". Here it
 * is the test mints' own lag (see `crossPay`), and it is a refusal a real mint
 * can give for the moment between its node being paid and its quote saying
 * so; a far mint that cannot be reached for the claim leaves the same state. */
async function moveCut(S, sats) {
  const P = await phone(S, 'payer', MB, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 300 });
  setOffline(Rx, true);
  S.start = snapshot([P, Rx]);
  const start = pileAt(P, MB);
  /* The far mint cannot be asked to issue once the Lightning payment is
   * made. It was the test mints' own lag that cut it here ("Quote not paid"
   * for a second after the melt), and the wallet now waits that out
   * (`moveRun`); a far mint that cannot be reached for the claim
   * leaves the same state, and no amount of waiting helps. */
  const x = await crossPay(P, Rx, sats, {
    beforeMove: async () => { P.faults.push({ mint: MAC, path: /\/v1\/mint\/bolt11$/, method: 'POST', fate: 'before', once: false, label: 'their mint cannot be asked to issue' }); },
  });
  P.faults = [];
  return { P, Rx, x, start };
}

scenario('move-cut', 'receiver offline at another mint: the payer’s move is paid and the claim at their mint cannot be made', async (S) => {
  const sats = 500;
  const { P, Rx, x, start } = await moveCut(S, sats);
  const cut = x.stage === 'move' && !!(x.e && x.e.movePaid);
  if (!ok('the Lightning payment is made and the claim at the far mint is not', cut && pileAt(P, MB) < start,
          'stopped at the ' + x.stage + ': ' + String(x.err || 'it went through') + '; the payer’s pile ' + start + ' → ' + pileAt(P, MB))) return;
  const gone = start - pileAt(P, MB);
  const moveNote = store(P, 'foxy.cashu.move', null);
  ok('the payer is told the truth about its money', /ON THEIR WAY/.test(x.said) && !/Nothing was sent/.test(x.said),
     'told “' + x.said + '” — ' + gone + ' sats have left its mint');
  ok('the payer is back on its own mint', canon(P.W.mintUrl) === MB, 'on ' + nameOf(P.W.mintUrl));
  ok('and a note says where the money went', !!moveNote && canon(moveNote.to) === MAC, moveNote ? moveNote.amount + ' sats to ' + nameOf(moveNote.to) : 'no note');
  say('history: ' + await entriesLine(P));
  // opened again: everything the app does by itself
  await reopen(P);
  const l1 = limbo(P);
  ok('opened again, the app finishes the move by itself, from its own mint', !l1.move && pileAt(P, MAC) >= sats && P.wokeAt === MB && canon(P.W.mintUrl) === MB,
     'woke on ' + nameOf(P.wokeAt) + ', now on ' + nameOf(P.W.mintUrl) + '; ' + pileAt(P, MAC) + ' at macadamia, ' + pileAt(P, MB) + ' at minibits; ' + limboLine(l1));
  await reopen(P);
  ok('opened a second time, nothing more is claimed', pileAt(P, MAC) >= sats && pileAt(P, MAC) <= sats + 12 && !limbo(P).move, pileAt(P, MAC) + ' at macadamia');
  const bp = await books(P);
  ok('and the payer’s entries add up at both mints', booksOff(bp) === 0, booksLine(bp));
  R.table.push({ id: S.id, label: 'minibits→mac receiver offline, claim cut after the melt', rail: 'moved, not paid', asked: sats,
    rxGot: 0, payerPaid: gone, cost: gone - pileAt(P, MAC), calm: calm(limbo(P)), payerLimbo: 0, rxLimbo: 0, payerOff: booksOff(bp), rxOff: 0,
    change: pileAt(P, MAC) + ' of the payer’s at macadamia, claimed by itself' });
});

scenario('move-twice', 'receiver offline at another mint: the claim cannot be made after the melt, and the person taps to pay again', async (S) => {
  const sats = 500;
  const { P, Rx, x, start } = await moveCut(S, sats);
  const cut = x.stage === 'move' && !!(x.e && x.e.movePaid);
  if (!ok('the Lightning payment is made and the claim at the far mint is not', cut && pileAt(P, MB) < start,
          'stopped at the ' + x.stage + ': ' + String(x.err || 'it went through'))) return;
  const first = store(P, 'foxy.cashu.move', null);
  const gone1 = start - pileAt(P, MB);
  say('told: “' + x.said + '”; ' + gone1 + ' sats have left the payer’s mint');
  // the person holds the phones together again: the same offer
  const x2 = await crossPay(P, Rx, sats, { text: x.text });
  ok('tapped again, the payment is made', x2.stage === 'pay' && !!x2.t.made, x2.stage === 'pay' ? x2.said : 'stopped at the ' + x2.stage + ': ' + x2.said);
  ok('and it is paid out of what the first move sent, with no second Lightning payment', x2.fromThere === true,
     x2.fromThere ? 'paid from the ' + x2.heldThere + ' sats already at ' + nameOf(x2.theirs) : 'a second move was made: ' + (x2.plan ? x2.plan.moving : '?') + ' sats');
  await catchUp(P);
  ok('the first crossing is finished and its note is gone', !moveNotes(P).length && !!first, limboLine(limbo(P)));
  setOffline(Rx, false);
  await reopen(Rx);
  await reopen(P);
  const o = await outcome(S, P, Rx, 'minibits→mac receiver offline, claim cut, tapped again', sats, { rail: 'moved once, then ecash' });
  ok('the receiver holds what it asked for', o.row.rxGot === sats, 'asked ' + sats + ', up by ' + o.row.rxGot);
  ok('and it cost the payer one payment and its fees', o.row.cost >= 0 && o.row.cost <= Math.ceil(sats * 0.03) + 14,
     'the payer is down ' + o.row.payerPaid + ' for a ' + sats + ' sat payment: ' + o.row.cost + ' beyond what the receiver got');
  verdict(o, sats, {});
});

scenario('move-fail', 'receiver offline at another mint: the move lands and the payment’s own swap never leaves', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MB, { fund: 300 });
  setOffline(Rx, true);
  S.start = snapshot([P, Rx]);
  const startMac = pileAt(P, MAC);
  const sats = 500;
  const x = await crossPay(P, Rx, sats, {
    afterMove: async () => { P.faults.push({ mint: MB, path: /\/v1\/swap$/, method: 'POST', fate: 'before', once: false, label: 'their mint cannot be reached for the swap' }); },
  });
  ok('the move is made and the payment is not', x.stage === 'pay' && !x.t.made, 'stage ' + x.stage + '; told: ' + x.said);
  const there = pileAt(P, MB), l0 = limbo(P);
  ok('the money is the payer’s, at the receiver’s mint: in its pile or held for the swap that got no answer',
     there + l0.held >= sats && startMac - pileAt(P, MAC) > 0, there + ' in the pile at minibits, ' + limboLine(l0) + '; macadamia ' + startMac + ' → ' + pileAt(P, MAC));
  ok('the payer ends on its own mint, and that is the mint it has saved', canon(P.W.mintUrl) === MAC && canon(store(P, 'foxy.cashu.mint', '')) === MAC,
     'on ' + nameOf(P.W.mintUrl) + ', saved ' + nameOf(store(P, 'foxy.cashu.mint', '')));
  // the app is opened again
  P.faults = [];
  await reopen(P);
  ok('opened again, the payer’s app is on its own mint', P.wokeAt === MAC, 'it opens on ' + nameOf(P.wokeAt));
  if (limbo(P).held) { say('held back: ' + limboLine(limbo(P)) + ' — waiting the twenty seconds the wallet waits'); await H.sleep(23000); await catchUp(P); }
  ok('nothing is lost: what left its own mint is at theirs, less the crossing’s fees', pileAt(P, MB) >= sats && calm(limbo(P)),
     pileAt(P, MB) + ' at minibits; ' + limboLine(limbo(P)));
  // the phones are held together again: it is paid out of what is already at their mint
  const x2 = await crossPay(P, Rx, sats);
  ok('tapped again, the payment is made, locked to them', x2.stage === 'pay' && !!x2.t.made && !!x2.t.made.lockedTo, x2.said);
  ok('out of what the move had already sent, with no second Lightning payment', x2.fromThere === true,
     x2.fromThere ? 'paid from the ' + x2.heldThere + ' sats already at ' + nameOf(x2.theirs) : 'a second move was made');
  ok('and the payer is home again', canon(P.W.mintUrl) === MAC, 'on ' + nameOf(P.W.mintUrl));
  await catchUp(P);
  setOffline(Rx, false);
  await reopen(Rx);
  const o = await outcome(S, P, Rx, 'mac→minibits receiver offline, swap cut after the move', sats, { rail: 'moved, then ecash' });
  verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.03) + 14 });
}, { timeout: 300000 });

scenario('over-cut', 'same mint: an offline payer pays over for a tap, the link drops, and the payment is shown as a code instead', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: false });
  const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
  setOffline(P, true);
  S.start = snapshot([P, Rx]);
  const sats = 300;
  const t = await tapEcash(P, Rx, sats, { cutBeforeM5: true });
  ok('the payment is made and does not cross', !t.made && !!t.token, t.said);
  if (!t.token) return;
  const info = P.W.tokenInfo(t.token) || {};
  const over = (info.sats || 0) - sats;
  const noteIn = P.W.changeNoteOf ? P.W.changeNoteOf(t.token) : null;
  say('the token on the payer’s screen is ' + info.sats + ' sats for a ' + sats + ' sat payment (' + over + ' over); it names '
    + (noteIn ? 'a key for the change' : 'NO key for its change') + '; the payer’s entry: ' + await entriesLine(P, 1));
  // RECEIVER NEEDS TO SCAN: the receiver scans it
  const took = await Rx.W.receiveToken(t.token).then((r) => r, (e) => ({ err: e.message }));
  ok('the receiver scans it and takes it', !took.err, took.err || ('took ' + took.sats + ', change due back ' + (took.changeDue || 0)));
  /* `receiveToken` makes the change itself (99-proof-lock-and-export.js), not
   * waited for; it ends on the payment's own entry, as a code for the payer. */
  await H.sleep(1500);
  await catchUp(Rx);
  const kept = pileAt(Rx, MAC);
  const rxTags = (took.hash && Rx.W.tagsFor) ? (Rx.W.tagsFor(took.hash) || {}) : {};
  const changeBits = rxTags.changeToken ? Rx.W.tokenInfo(rxTags.changeToken) : null;
  const changeSats = changeBits ? sum((changeBits.proofs || []).map(amt)) : 0;
  /* Exactly, or a sat or two over where making the change cost less than
   * was allowed for (`settleChangeMade`). And a sat or two UNDER where it
   * cost more: which pieces the claim came back as decides how many go into
   * the swap that makes the change, and at 150 ppk a seventh piece is a
   * second sat of fee. That is K3, charged to the payment's own entry; it
   * came out 299 in two full runs of four and 300 in the others, with the
   * books adding up each time. */
  okOrKnown('the receiver keeps what it asked for, and the rest is on its way back to the payer', kept >= sats && kept <= sats + 2 && changeSats > 0,
     'K3', kept >= sats - 2 && kept < sats && changeSats > 0,
     'asked ' + sats + ', holds ' + kept + '; change made for the payer: ' + (changeSats || 'none'));
  // the payer scans the change off the receiver's screen, still with no connection
  const gotBack = rxTags.changeToken
    ? await P.W.receiveToken(rxTags.changeToken).then((r) => 'kept ' + r.sats, (e) => 'refused: ' + e.message) : 'no code to scan';
  ok('the payer takes its change from the code the receiver shows', /^kept /.test(gotBack), gotBack);
  setOffline(P, false);
  await reopen(P);
  const o = await outcome(S, P, Rx, 'mac→mac payer offline, paid over, link cut, scanned', sats, { rail: 'ecash, plain, as a code' });
  ok('the payer is down what it meant to pay, not the piece it paid with', o.row.payerPaid <= sats + 8,
     'meant ' + sats + ', down ' + o.row.payerPaid + '; its entry: ' + await entriesLine(P, 1));
  verdict(o, sats, {});
});

/* ======================================================================= */
/* Just enough, and one sat short, on each of the three cross-mint rails.     */

/* "needs N … you hold M": the two figures a refusal names, when it names two. */
function needHold(msg) {
  const m = /needs?\s+(\d+)\s+sats[^.]*?you hold\s+(\d+)/i.exec(String(msg || ''))
    || /costs up to\s+(\d+)[^.]*?you hold\s+(\d+)/i.exec(String(msg || ''));
  return m ? { need: Number(m[1]), hold: Number(m[2]) } : null;
}

scenario('edge-ln', 'across mints, by Lightning: the largest invoice a pile can pay, and the refusals above it', async (S) => {
  for (const side of [{ from: MAC, to: MB, hold: 600 }, { from: MB, to: MAC, hold: 600 }]) {
    const tag = nameOf(side.from) + '→' + nameOf(side.to);
    const P = await phone(S, 'payer at ' + nameOf(side.from), side.from, { fund: side.hold });
    const have = pileAt(P, side.from), pieces = piecesAt(P, side.from);
    let paidAt = 0, tries = 0, moved = 0, odd = [];
    const said = [];
    for (let a = have; a >= have - 40 && !paidAt; a--) {
      tries++;
      const inv = await bareInvoice(side.to, a);
      // what the send screen shows: the wallet's own words for the failure (`reason`)
      const r = await P.W.pay(inv.request).then((x) => ({ paid: x }), (e) => ({ err: P.W.reason ? P.W.reason(e) : ((e && e.message) || String(e)), e }));
      if (r.paid && !r.paid.pending) { paidAt = a; break; }
      const l = limbo(P);
      if (pileAt(P, side.from) !== have || !calm(l)) { moved++; said.push(a + ': MOVED — pile ' + pileAt(P, side.from) + ', ' + limboLine(l)); break; }
      const nh = needHold(r.err);
      if (!said.length || said[said.length - 1].replace(/^\d+: /, '').replace(/\d+/g, '#') !== String(r.err).replace(/\d+/g, '#')) said.push(a + ': ' + r.err);
      // a refusal that names what is needed must name more than is held
      if (nh && nh.need <= nh.hold) odd.push(a + ' sats: “' + r.err + '”');
      if (!nh && !/not enough|fee|hold/i.test(r.err)) odd.push(a + ' sats: “' + r.err + '”');
    }
    say(tag + ': holding ' + have + ' in ' + pieces + ' pieces; refusals, as the amount came down: ' + said.join(' | '));
    ok(tag + ': every invoice too large for the pile is refused with nothing moved', !moved, moved ? said[said.length - 1] : tries - 1 + ' refused, pile untouched each time');
    ok(tag + ': the largest invoice it can pay is paid', paidAt > 0, paidAt ? paidAt + ' of ' + have + ' held; left with ' + pileAt(P, side.from) : 'nothing from ' + have + ' down to ' + (have - 40) + ' went through');
    ok(tag + ': a refusal for want of sats names a need larger than what is held', !odd.length,
       odd.length ? odd.length + ' did not, e.g. ' + odd[0] : 'each did');
    await catchUp(P);
    const bp = await books(P);
    ok(tag + ': the payer’s entries add up', booksOff(bp) === 0, booksLine(bp));
    R.table.push({ id: S.id, label: tag + ' the most ' + have + ' can pay', rail: 'lightning', asked: paidAt, rxGot: paidAt,
      payerPaid: have - pileAt(P, side.from), cost: have - pileAt(P, side.from) - paidAt, calm: calm(limbo(P)), payerLimbo: limboSats(limbo(P)), rxLimbo: 0,
      payerOff: booksOff(bp), rxOff: 0 });
  }
}, { timeout: 300000 });

scenario('edge-move', 'receiver offline at another mint: the largest amount a pile can move and pay, and the refusal above it', async (S) => {
  for (const side of [{ from: MAC, to: MB, hold: 600 }, { from: MB, to: MAC, hold: 600 }]) {
    const tag = nameOf(side.from) + '→' + nameOf(side.to);
    const P = await phone(S, 'payer at ' + nameOf(side.from), side.from, { fund: side.hold });
    const Rx = await phone(S, 'receiver at ' + nameOf(side.to), side.to, { fund: 0 });
    setOffline(Rx, true);
    S.start = snapshot([P, Rx]);
    const have = pileAt(P, side.from);
    let most = 0, refusal = null;
    for (let want = have; want >= have - 60 && !most; want--) {
      const q = await P.W.transferQuote(side.from, want, { to: side.to, land: true }).then((p) => ({ plan: p }), (e) => ({ err: e.message, e }));
      if (q.plan) most = want; else refusal = { want, err: q.err, fits: q.e && q.e.foxyFits };
    }
    if (!ok(tag + ': some amount under ' + have + ' can be quoted', most > 0, most ? most + ' is the most the quote allows' : 'nothing down to ' + (have - 60))) continue;
    ok(tag + ': one sat more is refused with both figures and nothing moved', !!refusal && !!needHold(refusal.err) && pileAt(P, side.from) === have && !limbo(P).move,
       refusal ? (refusal.want + ' sats: “' + refusal.err + '”; it offers ' + refusal.fits) : 'no refusal seen');
    if (refusal && refusal.fits > 0) {
      const again = await P.W.transferQuote(side.from, refusal.fits, { to: side.to, land: true }).then(() => 'quotes', (e) => 'refused: ' + e.message);
      ok(tag + ': the amount the refusal offers instead is one the quote then allows', again === 'quotes', refusal.fits + ' sats: ' + again);
    }
    // PAY, at the most the quote allows
    const x = await crossPay(P, Rx, most);
    ok(tag + ': at the most the quote allows, the move is made and the payment follows', x.stage === 'pay' && !!x.t.made,
       x.stage === 'pay' && x.t.made ? 'moved ' + x.plan.moving + ', paid ' + most + ' locked; told: ' + x.said : 'stopped at the ' + x.stage + ': ' + x.said);
    const stuck = limbo(P);
    if (!(x.stage === 'pay' && x.t.made)) {
      say(tag + ': the payer holds ' + pileAt(P, side.from) + ' at its own mint and ' + pileAt(P, side.to) + ' at theirs, on ' + nameOf(P.W.mintUrl) + '; ' + limboLine(stuck));
    }
    await catchUp(P);
    setOffline(Rx, false);
    await reopen(Rx);
    const o = await outcome(S, P, Rx, tag + ' receiver offline, the most ' + have + ' can pay', most, { rail: 'moved, then ecash' });
    ok(tag + ': the receiver holds what it asked for', o.row.rxGot === most, 'asked ' + most + ', up by ' + o.row.rxGot);
    ok(tag + ': nothing is left in between and both add up', o.row.calm && !o.row.payerOff && !o.row.rxOff,
       limboLine(o.lp) + ' / ' + limboLine(o.lr) + '; ' + booksLine(o.bp) + ' / ' + booksLine(o.br));
  }
}, { timeout: 300000 });

scenario('edge-carry', 'payer offline at the mint that charges: holding one sat less than the receiver asks, exactly that, and enough', async (S) => {
  const sats = 500;
  const Rx = await phone(S, 'receiver', MB, { fund: 0 });
  // what the receiver will ask, worked out the way it will be: the quote does not depend on who pays
  const probe = await Rx.W.crossTerms({ mint: MAC, have: 0, sats: sats }, sats);
  const ask = probe.ask;
  say('bringing ' + sats + ' home from macadamia is asked at ' + ask + ' (' + probe.feeSats + ' of fees)');

  // one sat short of what will be asked
  const P1 = await phone(S, 'payer holding ' + (ask - 1), MAC, { fund: ask - 1 });
  setOffline(P1, true);
  const c1 = await carryAsk(P1, Rx, sats);
  ok('one sat short: the receiver says so, with the figures, and asks for nothing', !c1.terms && /costs \d+ on top, and they hold \d+/.test(String(c1.err)),
     c1.terms ? 'it quoted ' + c1.terms.ask : c1.err);
  ok('one sat short: nothing moved, and the receiver is on its own mint', pileAt(P1, MAC) === ask - 1 && canon(Rx.W.mintUrl) === MB && calm(limbo(Rx)),
     'payer ' + pileAt(P1, MAC) + ', receiver on ' + nameOf(Rx.W.mintUrl));

  /* Exactly the figure. The receiver's fee for taking the pieces is the
   * payer's too, so a pile of exactly the ask cannot pay it; the payer says
   * what it can hand over, not what it holds, and the two checks agree. */
  const P2 = await phone(S, 'payer holding ' + ask, MAC, { fund: ask });
  setOffline(P2, true);
  const says = P2.W.stuckAtMint(P2.W.decodeRequest(Rx.W.paymentRequest(sats, { purpose: 'receive' })) || {});
  const c2 = await carryAsk(P2, Rx, sats);
  ok('exactly the figure: the payer says what it can hand over, which is less than it holds', !!says && says.have < ask,
     says ? 'holds ' + ask + ', says ' + says.have : 'it said nothing');
  ok('exactly the figure: the receiver refuses with the figures before anything is asked or moved', !c2.terms && /costs \d+ on top, and they hold \d+/.test(String(c2.err))
     && pileAt(P2, MAC) === ask && canon(Rx.W.mintUrl) === MB && calm(limbo(Rx)), c2.terms ? 'it quoted ' + c2.terms.ask : c2.err);

  // the least that pays: one sat at a time, until the receiver's check lets it through — and then the payer's must
  let paid = null;
  for (let more = 1; more <= 8 && !paid; more++) {
    const P3 = await phone(S, 'payer holding ' + (ask + more), MAC, { fund: ask + more });
    setOffline(P3, true);
    S.start = snapshot([P3, Rx]);
    const c3 = await carryAsk(P3, Rx, sats);
    if (!c3.terms) continue;
    const t3 = await tapEcash(P3, Rx, c3.terms.ask, { text: c3.text, theirRoute: true });
    ok('holding ' + (ask + more) + ': what the receiver’s check lets through, the payer can pay', !!t3.made,
       t3.made ? t3.made.sats + ' left it' + (t3.made.over ? ', ' + t3.made.over + ' over' : '') : t3.said);
    if (!t3.made) { await carryGiveUp(Rx, c3); break; }
    await H.sleep(t3.made.over ? 3200 : 800);
    const h3 = await carryNow(Rx, c3);
    ok('and it is brought home: the figure asked for lands', h3.state === 'home' && pileAt(Rx, MB) >= sats, h3.said + '; ' + pileAt(Rx, MB) + ' at minibits');
    paid = { P3, more, c3 };
  }
  ok('some amount within eight sats of the ask pays', !!paid, paid ? 'holding ' + (ask + paid.more) : 'none did');
  if (paid) {
    setOffline(paid.P3, false);
    await reopen(paid.P3);
    const o = await outcome(S, paid.P3, Rx, 'mac→minibits payer offline at the edge', sats, { rail: 'ecash, carried home' });
    verdict(o, sats, {});
  }
}, { timeout: 300000 });

/* ======================================================================= */
scenario('pend-payer', 'across mints, by Lightning, from a mint whose melts stay PENDING: what each is told, and the app opened again', async (S) => {
  const up = await fetch(PEND + '/v1/info').then((r) => r.ok, () => false);
  if (!up) { note('no pending-mode mint at ' + PEND + ' (sh tools/live/pending-mint.sh up): not run'); return; }
  const P = await phone(S, 'payer', PEND, { fund: 2000 });
  const Rx = await phone(S, 'receiver', MB, { fund: 0 });
  S.start = snapshot([P, Rx]);
  const start = pileAt(P, PEND);
  const sats = 300;
  const t = await tapLightning(P, Rx, sats);
  const pending = !!((t.paid && t.paid.pending) || (t.e && t.e.pending));
  ok('the payer is told the payment is pending: not paid, and not failed', pending,
     t.paid ? JSON.stringify(t.paid) : 'told: ' + t.err);
  const l0 = limbo(P);
  ok('the ecash for it is held, written down, and out of the balance', l0.melts === 1 && l0.meltSats >= sats && pileAt(P, PEND) <= start - sats,
     'pile ' + start + ' → ' + pileAt(P, PEND) + '; ' + limboLine(l0) + '; the screen shows ' + await P.W.balanceSats());
  ok('pile and hold together are what it started with, less the split’s fee', pileAt(P, PEND) + l0.meltSats >= start - 4 && pileAt(P, PEND) + l0.meltSats <= start,
     pileAt(P, PEND) + ' + ' + l0.meltSats + ' = ' + (pileAt(P, PEND) + l0.meltSats) + ' of ' + start);
  const got = await claimInvoice(Rx, t.inv, 8000);
  note('the receiver’s invoice ' + (got ? 'was claimed: ' + pileAt(Rx, MB) + ' sats' : 'was not claimed')
    + ' — the fake Lightning at its mint marks every invoice paid by itself, so this says nothing about a payment that is really pending');
  // the same invoice again while the first try is pending
  const again = await P.W.pay(t.bolt).then((r) => 'went again: ' + JSON.stringify(r), (e) => 'refused: ' + e.message);
  const l1 = limbo(P);
  ok('paying the same invoice again while it is pending does not hold a second lot of ecash', l1.melts === 1 && l1.meltSats === l0.meltSats,
     again.slice(0, 140) + '; ' + limboLine(l1));
  // the app is opened again, twice
  await reopen(P);
  await reopen(P);
  const l2 = limbo(P);
  ok('opened again, the hold is still there and the ecash has not been given back or lost', l2.melts === 1 && l2.meltSats === l0.meltSats
     && pileAt(P, PEND) + l2.meltSats >= start - 4, 'pile ' + pileAt(P, PEND) + '; ' + limboLine(l2));
  const ghost = await phantom(P);
  ok('and nothing in its pile is spent', !ghost, ghost + ' sats');
  const bp = await books(P);
  const says = bp.find((x) => x.mint === NAME[PEND]);
  say('entries say ' + says.says + ' at the pending mint, the pile is ' + says.holds + ' and ' + l2.meltSats + ' is held for the payment: '
    + (says.says - says.holds - l2.meltSats) + ' unaccounted (the split’s fee, which is written when the payment settles)');
  R.table.push({ id: S.id, label: 'pending-mint→minibits, melt stays pending', rail: 'lightning, pending', asked: sats, rxGot: 0,
    payerPaid: start - pileAt(P, PEND), cost: start - pileAt(P, PEND), calm: false, payerLimbo: limboSats(l2), rxLimbo: 0,
    payerOff: Math.abs(says.says - says.holds - l2.meltSats), rxOff: 0, change: 'held for a payment the mint calls pending' });
}, { timeout: 200000 });

/* ======================================================================= */
/* A mint only one of the two can reach.                                      */

scenario('one-side-a', 'receiver offline at another mint, and its mint cannot be reached from the payer', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MB, { fund: 300 });
  setOffline(Rx, true);
  S.start = snapshot([P, Rx]);
  const start = pileAt(P, MAC);
  P.faults.push({ mint: MB, path: /./, fate: 'before', once: false, label: 'their mint is unreachable from here' });
  const x = await crossPay(P, Rx, 500);
  ok('the crossing stops at the quote', x.stage === 'quote', 'stage ' + x.stage + '; told: “' + x.said + '”');
  ok('and this time what it is told is true: nothing was sent', pileAt(P, MAC) === start && calm(limbo(P)), 'pile ' + pileAt(P, MAC) + '; ' + limboLine(limbo(P)));
  ok('the payer is still on its own mint', canon(P.W.mintUrl) === MAC, 'on ' + nameOf(P.W.mintUrl));
  P.faults = [];
  /* A person tapping again, not the next line of a script: a question about a
   * mint's keys that is still on its way is shared rather than asked twice
   * (`keyRequestInFlight`), so a retry in the same millisecond as the failure
   * is handed the failure. Half a second is any human retry. */
  await H.sleep(500);
  const x2 = await crossPay(P, Rx, 500, { text: x.text });
  ok('reachable again, the same tap is paid', x2.stage === 'pay' && !!x2.t.made, x2.said);
  await catchUp(P);
  setOffline(Rx, false);
  await reopen(Rx);
  const o = await outcome(S, P, Rx, 'mac→minibits receiver offline, their mint unreachable, then reachable', 500, { rail: 'moved, then ecash' });
  verdict(o, 500, { rxGot: 500, maxCost: 29 });
});

scenario('one-side-b', 'carried home, and the payer’s mint cannot be reached from the receiver when the ecash arrives', async (S) => {
  const sats = 1000;
  const P = await phone(S, 'payer', MAC, { fund: 4000, pool: true });
  const Rx = await phone(S, 'receiver', MB, { fund: 0 });
  await seedAt(Rx, MAC, 64);
  setOffline(P, true);
  S.start = snapshot([P, Rx]);
  const c = await carryAsk(P, Rx, sats);
  if (!ok('the receiver quotes the way home and goes to the payer’s mint', !!c.terms, c.err || ('asks ' + c.terms.ask))) return;
  Rx.faults.push({ mint: MAC, path: /\/v1\/(swap|checkstate)$/, method: 'POST', fate: 'before', once: false, label: 'the payer’s mint is unreachable from here' });
  const t = await tapEcash(P, Rx, c.terms.ask, { text: c.text, theirRoute: true });
  await H.sleep(600);
  const ans = t.rxAnswers()[0] || {};
  const l0 = limbo(Rx);
  ok('the receiver cannot swap the plain ecash in: it says it does not know yet, and keeps what it wrote down',
     ans.status === 409 && l0.unclaimed > 0, 'answered ' + ans.status + ': ' + String(ans.text || '').slice(0, 120) + '; ' + limboLine(l0));
  say('the payer is told: “' + t.said + '”; the receiver: ' + t.rxTold());
  // nothing comes of the offer: two minutes on the receiver goes home (`_carryHomeT`)
  await carryGiveUp(Rx, c);
  ok('the receiver goes back to its own mint, with the payment still written down as one to carry', canon(Rx.W.mintUrl) === MB && carryJobs(Rx).length === 1,
     'on ' + nameOf(Rx.W.mintUrl) + '; ' + JSON.stringify(carryJobs(Rx).map((j) => j.state)));
  // later: the payer's mint answers again, and the receiver's app is opened
  Rx.faults = [];
  await reopen(Rx);
  const woke = Rx.wokeAt;
  const after = canon(Rx.W.mintUrl);
  const saved = canon(store(Rx, 'foxy.cashu.mint', ''));
  ok('opened again at its own mint, the receiver’s wallet stays on its own mint', woke === MB && after === MB && saved === MB,
     'it opened on ' + nameOf(woke) + ', and after the launch’s own sweeps it is on ' + nameOf(after) + ' (saved: ' + nameOf(saved) + ')');
  ok('the payment the receiver took in the end is brought home, as one taken at the time would have been', pileAt(Rx, MB) >= sats && !carryJobs(Rx).length,
     pileAt(Rx, MB) + ' at minibits, ' + pileAt(Rx, MAC) + ' at macadamia; ' + limboLine(limbo(Rx)) + '; told: ' + JSON.stringify(Rx.carried.map((r) => r.state)));
  await reopen(Rx);
  ok('and the next launch opens on its own mint', Rx.wokeAt === MB, 'it opens on ' + nameOf(Rx.wokeAt));
  setOffline(P, false);
  await reopen(P);
  const o = await outcome(S, P, Rx, 'mac→minibits payer offline, payer’s mint unreachable at the swap', sats, { rail: 'ecash, claimed late, carried home' });
  ok('it ended one way: the receiver has it and the payer paid it', o.row.rxGot >= sats && o.row.payerPaid >= sats,
     'payer down ' + o.row.payerPaid + ', receiver up ' + o.row.rxGot);
  verdict(o, sats, {});
});

/* ======================================================================= */
/* ======================================================================= */
/* A payment that cannot be brought home goes back to the payer.              */

const MELT_REFUSED = () => ({ mint: MAC, path: /\/v1\/melt\/bolt11$/, method: 'POST', fate: 'refuse', once: false, label: 'the payer’s mint will not pay the invoice home' });

for (const how of [{ id: 'carry-refund', what: 'the phones are still together', cut: false },
                   { id: 'carry-refund-code', what: 'the payer has walked off', cut: true }]) {
  scenario(how.id, 'carried home: the payer’s mint refuses the payment home twice, it is sent back, and ' + how.what, async (S) => {
    const sats = 1000;
    const { P, Rx, c, t, err } = await carried(S, sats);
    if (!ok('the payer hands it over and the receiver takes it at the payer’s mint', !err && !!t.made, err || t.said)) return;
    const seedThere = pileAt(Rx, MAC) - c.terms.ask;
    if (how.cut) t.L.up = false;
    Rx.faults = [MELT_REFUSED()];
    const h = await carryNow(Rx, c);
    Rx.faults = [];
    ok('the melt home is refused twice and the payment is sent back, not kept', h.state === 'refunded', h.state + ': ' + h.said.slice(0, 160));
    ok('the receiver is told it was not received', /not received/i.test(h.said) && !/RECEIVED,/.test(h.said), h.said.slice(0, 120));
    ok('and it is back on its own mint with nothing left to carry', canon(Rx.W.mintUrl) === MB && !carryJobs(Rx).length && !moveNotes(Rx).length,
       'on ' + nameOf(Rx.W.mintUrl) + '; ' + limboLine(limbo(Rx)));
    const leftThere = pileAt(Rx, MAC) - seedThere;
    ok('it kept nothing of the payment but what was too small to send', leftThere >= 0 && leftThere <= 6 && pileAt(Rx, MB) === 0,
       leftThere + ' of it left at macadamia, ' + pileAt(Rx, MB) + ' at minibits');
    const token = h.r.token;
    if (!how.cut) {
      ok('it crossed the link, and the payer kept it', h.r.handed === true && P.changes.some((x) => x.refund && !x.refused),
         'handed: ' + h.r.handed + '; the payer: ' + JSON.stringify(P.changes));
    } else {
      ok('the link is gone, so it is a code on the payment’s own entry for the payer to scan', h.r.handed === false && !!Rx.stuck && Rx.stuck.refund === true
         && String((Rx.W.tagsFor(h.r.hash) || {}).token || '') === token, 'handed: ' + h.r.handed + '; card: ' + (Rx.stuck ? 'raised for ' + Rx.stuck.sats : 'none'));
    }
    // the refund is locked to the payer: the receiver cannot take it back
    const own = await Rx.W.connect(MAC).then(() => Rx.W.receiveToken(token)).then(() => 'took it', (e) => 'refused: ' + e.message);
    await Rx.W.connect(MB);
    ok('the receiver cannot spend what it sent back', /^refused/.test(own), own.slice(0, 110));
    // the payer gets a route: over the link it is already written down; as a code, the payer scans it
    setOffline(P, false);
    await reopen(P);
    if (how.cut) {
      const got = await P.W.receiveToken(token).then((r) => 'took ' + r.sats, (e) => 'refused: ' + e.message);
      ok('the payer scans the code and has it back', /^took/.test(got), got);
    }
    await catchUp(P);
    await reopen(Rx);
    const o = await outcome(S, P, Rx, 'mac→minibits carried, melt home refused, sent back' + (how.cut ? ' as a code' : ' over the link'), sats, { rail: 'ecash, refunded' });
    ok('the payer has its payment back, less the mint’s fees for the trip', o.row.payerPaid >= 0 && o.row.payerPaid <= 12, 'down ' + o.row.payerPaid);
    ok('and the receiver is up by no more than the dust', o.row.rxGot >= 0 && o.row.rxGot <= 6, 'up ' + o.row.rxGot);
    verdict(o, sats, {});
  }, { timeout: 300000 });
}

scenario('carry-short', 'carried home after a relaunch, and the way home now costs more than the payer paid for', async (S) => {
  for (const choice of ['less', 'back']) {
    const sats = 1000;
    const { P, Rx, c, t, err } = await carried(S, sats);
    if (!ok(choice + ': the payer hands it over and the receiver takes it at the payer’s mint', !err && !!t.made, err || t.said)) continue;
    kill(Rx, 'before the melt home');
    /* The price of the way home has gone up since it was agreed. The test
     * mints' fees do not move, so the job is made to have asked for more than
     * what was paid can bring: the same comparison, from the other side. */
    const jobs = JSON.parse(Rx.stored['foxy.cashu.carry'] || '[]');
    jobs[0].net = jobs[0].kept - 3;
    Rx.stored['foxy.cashu.carry'] = JSON.stringify(jobs);
    await reopen(Rx);
    const asked = Rx.carried.filter((r) => r.state === 'short').pop();
    ok(choice + ': opened again, the wallet does not bring it home by itself: the person is asked', !!asked && asked.lands < asked.net && pileAt(Rx, MB) === 0,
       asked ? carrySaid(asked, c) : 'told: ' + JSON.stringify(Rx.carried.map((r) => r.state)) + '; ' + pileAt(Rx, MB) + ' at home');
    ok(choice + ': on its own mint, with the payment still written down', canon(Rx.W.mintUrl) === MB && carryJobs(Rx).length === 1, 'on ' + nameOf(Rx.W.mintUrl));
    if (!asked) continue;
    if (choice === 'less') {
      const r = await Rx.W.carryHome(asked.job.id, null, () => {}, { less: true });
      ok('less: BRING IT HOME lands what fits', r.state === 'home' && pileAt(Rx, MB) >= asked.lands && !carryJobs(Rx).length,
         r.state + ': ' + pileAt(Rx, MB) + ' at minibits for ' + asked.lands + ' offered');
    } else {
      const r = await Rx.W.carryRefund(asked.job.id);
      ok('back: SEND IT BACK makes a refund locked to the payer, as a code', r.state === 'refunded' && !!r.token && !carryJobs(Rx).length && pileAt(Rx, MB) === 0,
         r.state + (r.why ? ': ' + r.why : ''));
      setOffline(P, false);
      await reopen(P);
      const got = r.token ? await P.W.receiveToken(r.token).then((x) => 'took ' + x.sats, (e) => 'refused: ' + e.message) : 'no token';
      ok('back: the payer scans it and has it back', /^took/.test(got), got);
    }
    ok(choice + ': the receiver ends on its own mint', canon(Rx.W.mintUrl) === MB, 'on ' + nameOf(Rx.W.mintUrl));
    setOffline(P, false);
    await reopen(P);
    await reopen(Rx);
    const o = await outcome(S, P, Rx, 'mac→minibits carried after a relaunch, dearer way home: ' + (choice === 'less' ? 'brought home less' : 'sent back'), sats, { rail: 'ecash, ' + (choice === 'less' ? 'carried home' : 'refunded') });
    verdict(o, sats, {});
  }
}, { timeout: 300000 });

/* ======================================================================= */
/* A payment the receiver refused is taken back by itself.                    */

scenario('take-back', 'same mint: an offline payer’s payment is refused after it crossed, nothing comes back, and the payer gets a route', async (S) => {
  const SWAP_REFUSED = () => ({ mint: MAC, path: /\/v1\/swap$/, method: 'POST', fate: 'refuse', once: false, label: 'the mint will not swap it in' });
  // the ecash the receiver was shown, as a code it could redeem
  const shownTo = (p, t) => {
    let proofs = [];
    try { proofs = JSON.parse(String(t.L.lastBody || '')).proofs || []; } catch (e) {}
    return proofs.length ? p.b.w.CashuTS.getEncodedToken({ mint: canon(MAC), proofs: proofs, unit: 'sat' }) : '';
  };
  const refusedRow = async (p) => (await p.W.transactions(50)).find((e) => e.dir === 'out' && /refused/.test(String(e.memo || ''))) || null;
  /* A refusal with no locked refund (MONEY.md §15) is HIGH RISK: the
   * pieces go back into the payer's wallet at once,
   * counted and flagged, and are swapped for fresh ones on its first
   * connection. The receiver here cannot refund: its mint will not swap. */
  /* (a) an honest refusal: the receiver kept nothing */
  {
    const sats = 300;
    const P = await phone(S, 'payer', MAC, { fund: 2000, pool: true });
    const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
    setOffline(P, true);
    S.start = snapshot([P, Rx]);
    const had = pileAt(P, MAC);
    Rx.faults = [SWAP_REFUSED()];
    const t = await tapEcash(P, Rx, sats, { theirRoute: true });
    Rx.faults = [];
    ok('(a) the receiver hears it and says no, nothing comes back, and the payer is told it is HIGH RISK', !t.made && t.refused === true && !!t.atRisk && t.atRisk.onEntry === false, t.said.slice(0, 170));
    const shown0 = await P.W.balanceSats();
    const row0 = await refusedRow(P);
    ok('(a) the pieces that crossed are in the payer’s wallet again, counted and flagged', pileAt(P, MAC) === had && shown0 === had && P.W.atRiskSats() >= sats
       && !!row0 && row0.highRisk === true,
       'pile ' + pileAt(P, MAC) + ' of ' + had + ', shown ' + shown0 + ', at risk ' + P.W.atRiskSats() + '; entry ' + (row0 ? row0.state + (row0.highRisk ? ', high risk' : '') : 'missing'));
    const seen = shownTo(Rx, t);
    setOffline(P, false);
    await reopen(P);
    const row1 = await refusedRow(P);
    ok('(a) with a route, they are swapped for fresh ones without the person doing anything', P.W.atRiskSats() === 0 && pileAt(P, MAC) >= had - 4
       && P.atRiskSaid.filter((r) => r && r.state === 'safe').length === 1 && !!row1 && row1.highRisk === false && row1.takenBack === true,
       'said ' + JSON.stringify(P.atRiskSaid.map((r) => r && r.state)) + '; pile ' + pileAt(P, MAC) + '; still at risk ' + P.W.atRiskSats());
    await reopen(P);
    ok('(a) opened again, nothing is done twice', P.atRiskSaid.filter((r) => r && r.state === 'safe').length === 1 && P.W.atRiskSats() === 0, JSON.stringify(P.atRiskSaid.map((r) => r && r.state)));
    const stale = await Rx.W.receiveToken(seen).then(() => 'took it', (e) => 'refused: ' + e.message);
    ok('(a) the pieces the receiver saw are worth nothing now', !!seen && /^refused/.test(stale), stale.slice(0, 100));
    const o = await outcome(S, P, Rx, 'mac→mac payer offline, refused, made safe by itself', sats, { rail: 'ecash, refused' });
    ok('(a) nobody was paid, and it cost the payer no more than the mint’s fee for the swap', o.row.rxGot === 0 && o.row.payerPaid >= 0 && o.row.payerPaid <= 4, 'payer down ' + o.row.payerPaid + ', receiver up ' + o.row.rxGot);
    verdict(o, sats, {});
  }
  /* (b) a dishonest one: it says no, and redeems the pieces after the payer has gone */
  {
    const sats = 300;
    const P = await phone(S, 'payer', MAC, { fund: 2000, pool: true });
    const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
    setOffline(P, true);
    S.start = snapshot([P, Rx]);
    Rx.faults = [SWAP_REFUSED()];
    const t = await tapEcash(P, Rx, sats, { theirRoute: true });
    Rx.faults = [];
    if (ok('(b) the receiver says no and sends nothing back', !t.made && t.refused === true && !!t.atRisk, t.said.slice(0, 150))) {
      const stole = await Rx.W.receiveToken(shownTo(Rx, t)).then((r) => 'took ' + r.sats, (e) => 'refused: ' + e.message);
      ok('(b) and then redeems what it was shown: nothing stops that', /^took/.test(stole), stole);
      setOffline(P, false);
      await reopen(P);
      const rows = await P.W.transactions(50);
      const row = rows.find((e) => e.dir === 'out' && e.taken === true) || rows.find((e) => e.dir === 'out' && /refused/.test(String(e.memo || ''))) || {};
      ok('(b) with a route, the payer’s phone finds out: nothing comes back, the entry says paid, and the person is told',
         P.W.atRiskSats() === 0 && row.settled === true && row.state === 'success' && row.taken === true
         && P.atRiskSaid.some((r) => r && r.state === 'taken'),
         'said ' + JSON.stringify(P.atRiskSaid.map((r) => r && r.state)) + '; entry ' + row.state + (row.settled ? ', settled' : '') + (row.taken ? ', taken' : ''));
      const o = await outcome(S, P, Rx, 'mac→mac payer offline, refused in words and redeemed anyway', sats, { rail: 'ecash, taken' });
      ok('(b) the receiver has the payment and the payer is down by it', o.row.rxGot >= sats - 2 && o.row.payerPaid >= sats, 'payer down ' + o.row.payerPaid + ', receiver up ' + o.row.rxGot);
      verdict(o, sats, {});
    }
  }
}, { timeout: 300000 });

/* ======================================================================= */
/* A cheat's payment to a receiver with no route, against a real mint.        */

scenario('dup-proof', 'same mint: an online payer sends an offline receiver one locked payment with every proof named twice', async (S) => {
  const P = await phone(S, 'payer', MAC, { fund: 2000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
  setOffline(Rx, true);
  S.start = snapshot([P, Rx]);
  const sats = 400;
  const text = Rx.W.paymentRequest(sats, { purpose: 'receive' });
  const ask = P.W.decodeRequest(text) || {};
  // half the amount and a little for the fee, locked to the receiver as an honest payment would be
  const half = await P.W.sendToken(sats / 2 + 4, { unit: 'sat', lockTo: ask.lockTo });
  const one = P.W.tokenInfo(half.token).proofs.map((pr) => Object.assign({ id: pr.id, amount: amt(pr), secret: pr.secret, C: pr.C }, pr.dleq ? { dleq: pr.dleq } : {}));
  const body = JSON.stringify({ id: ask.id, mint: canon(MAC), unit: 'sat', proofs: one.concat(one) });
  const evAt = Rx.events.length, ansAt = Rx.answers.length;
  Rx.W._requestPaid(body, 'wire-dup', 'tap');
  await H.sleep(1500);
  const ans = Rx.answers.slice(ansAt)[0] || {};
  const shown0 = await Rx.W.balanceSats();
  ok('the receiver refuses a payment whose proofs are each named twice', ans.status !== 200 && shown0 === 0,
     'the payer spent ' + sum(one.map((p) => p.amount)) + ' sats of ecash; the receiver answered ' + ans.status + ' and was told: ' + told(Rx, evAt)
       + '; its screen shows ' + shown0 + ' for a request of ' + sats);
  // the receiver finds a route: what the mint makes of it
  setOffline(Rx, false);
  await routeBack(Rx);
  await catchUp(Rx);
  await reopen(Rx);
  const held = pileAt(Rx, MAC), shown = await Rx.W.balanceSats(), l = limbo(Rx);
  const ghost = await phantom(Rx);
  say('with a route: the receiver holds ' + held + ' the mint honours, and its screen shows ' + shown + '; ' + limboLine(l) + '; shown and already spent: ' + ghost);
  ok('with a route, the receiver’s screen shows only what the mint honours', shown === held && !l.unclaimed, 'shows ' + shown + ', holds ' + held + ', ' + l.unclaimed + ' still written down as waiting');
  const bk = await books(Rx);
  ok('and its entries add up to what it holds', booksOff(bk) === 0, booksLine(bk));
  await catchUp(P);
  R.table.push({ id: S.id, label: 'a locked payment with every proof twice, to an offline receiver', rail: 'ecash, locked', asked: sats,
    rxGot: held, payerPaid: 2000 - pileAt(P, MAC), cost: 2000 - pileAt(P, MAC) - held, calm: calm(l), payerLimbo: 0, rxLimbo: limboSats(l),
    payerOff: 0, rxOff: booksOff(bk), change: 'the receiver said PAID ' + sats + ' offline' });
});

/* ======================================================================= */
/* A long sitting with no connection.                                         */

function sittingAmounts(n, lo, hi, seed) {
  const out = []; let x = seed || 7;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out.push(lo + (x % (hi - lo))); }
  return out;
}
const storedChars = (p) => { const snap = p.b.snapshot(); return sum(Object.keys(snap).map((k) => k.length + String(snap[k] || '').length)); };

scenario('soak-rx', 'same mint: a receiver takes forty locked payments in one sitting with no connection, is killed part-way, pays out of them, then comes online', async (S) => {
  const N = 40;
  const P = await phone(S, 'payer', MAC, { fund: 45000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
  const C = await phone(S, 'supplier', MAC, { fund: 0 });
  setOffline(Rx, true);
  S.start = snapshot([P, Rx]);
  const amounts = sittingAmounts(N, 21, 1500, 7);
  let took = 0, n = 0, slowest = 0, paidOut = 0, leftRx = 0;
  const refused = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    if (i === 15) {
      const before = await Rx.W.balanceSats();
      kill(Rx, 'part-way through the sitting');
      await reopen(Rx, { catchUp: false });
      const after = await Rx.W.balanceSats();
      ok('killed after fifteen and opened again with no connection, it shows what it showed before', after === before && after >= took && after <= took + 2 * i,
         'showed ' + before + ', shows ' + after + ', took ' + took + ' [the screen counts what is waiting before the mint’s fee for claiming it, about a sat a payment: known]');
    }
    if (i === 28) {
      // it pays a supplier out of what it has taken, still with no connection
      const want = 900;
      const out = await tapEcash(Rx, C, want);
      ok('after twenty-eight, it pays ' + want + ' out of ecash still locked to it', !!out.made, out.made ? out.made.sats + ' left it' + (out.made.over ? ', ' + out.made.over + ' over, to come back' : '') : out.said);
      if (out.made) { paidOut = want; leftRx = out.made.sats - (out.made.over || 0); }
      await H.sleep(out.made && out.made.over ? 3200 : 900);
    }
    const s0 = Date.now();
    const t = await tapEcash(P, Rx, amounts[i]);
    slowest = Math.max(slowest, Date.now() - s0);
    if (t.made && t.made.lockedTo) { took += amounts[i]; n += 1; } else refused.push((i + 1) + ' (' + amounts[i] + '): ' + t.said);
    await H.sleep(120);
  }
  const sitting = Date.now() - t0;
  ok('all forty are taken, locked, with no connection on the receiver', n === N, n + ' of ' + N + ' in ' + Math.round(sitting / 1000) + 's, the slowest ' + slowest + 'ms'
     + (refused.length ? '; not taken: ' + refused.slice(0, 4).join(' | ') : ''));
  const mid = limbo(Rx);
  const shown = await Rx.W.balanceSats();
  const rows = (await Rx.W.transactions(500)).length;
  const locks = Object.keys(store(Rx, 'foxy.req.lockkeys', {}) || {}).length;
  const waiting = Object.keys(store(Rx, 'foxy.req.unclaimed', {}) || {}).length;
  const chars = storedChars(Rx);
  say('end of the sitting: took ' + took + ', paid out ' + paidOut + '; the screen shows ' + shown + '; ' + waiting + ' payments written down, ' + locks + ' lock rows, '
    + rows + ' history rows; the page’s storage holds ' + Math.round(chars / 1024) + ' thousand characters');
  ok('the screen shows what it took less what it paid out, and the claim fees still to come', shown >= took - paidOut - 12 && shown <= took - paidOut + 2 * N,
     'shows ' + shown + ', took ' + took + ', paid out ' + paidOut + ': ' + (shown - (took - paidOut)) + ' over until it is claimed');
  ok('what it wrote down is well inside what a page may store', chars < 2000000, Math.round(chars / 1024) + ' thousand characters of a limit near 2,500 thousand');
  // one connection, and everything is claimed
  const c0 = Date.now();
  setOffline(Rx, false);
  await routeBack(Rx);
  await catchUp(Rx);
  if (limbo(Rx).held) { await H.sleep(23000); await catchUp(Rx); }
  const claimMs = Date.now() - c0;
  const end = limbo(Rx);
  ok('with a route, every payment is claimed and nothing is left waiting', calm(end) && !limboSats(end), limboLine(end) + '; ' + Math.round(claimMs / 1000) + 's to claim them all');
  const holds = pileAt(Rx, MAC);
  ok('it holds what it took less what it paid out and the mint’s fees', holds <= took - paidOut + 6 && holds >= took - paidOut - 40,
     'holds ' + holds + '; took ' + took + ', paid out ' + paidOut + ' (' + leftRx + ' left it)');
  await reopen(Rx);
  await audit(Rx, { changes: 1 });
  await catchUp(P);
  await audit(P);
  ok('the supplier holds what it asked for', pileAt(C, MAC) >= paidOut && pileAt(C, MAC) <= paidOut + 2, pileAt(C, MAC) + ' for ' + paidOut);
  R.table.push({ id: S.id, label: 'forty locked payments to an offline receiver', rail: 'ecash, locked', asked: took, rxGot: holds + pileAt(C, MAC),
    payerPaid: 45000 - pileAt(P, MAC), cost: 45000 - pileAt(P, MAC) - holds - pileAt(C, MAC), ms: sitting, calm: calm(end), payerLimbo: 0, rxLimbo: limboSats(end),
    payerOff: 0, rxOff: booksOff(await books(Rx)), change: Math.round(claimMs / 1000) + 's to claim all on reconnect' });
}, { timeout: 900000 });

scenario('soak-payer', 'same mint: a payer makes thirty payments in one sitting with no connection, is killed part-way, then comes online', async (S) => {
  const N = 30;
  const P = await phone(S, 'payer', MAC, { fund: 12000, pool: true });
  const Rx = await phone(S, 'receiver', MAC, { fund: 0 });
  setOffline(P, true);
  S.start = snapshot([P, Rx]);
  const amounts = sittingAmounts(N, 5, 600, 11);
  let paid = 0, n = 0, overs = 0, exact = 0, slowest = 0;
  const refused = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    if (i === 12) {
      const before = await P.W.balanceSats();
      kill(P, 'part-way through the sitting');
      await reopen(P, { catchUp: false });
      const after = await P.W.balanceSats();
      ok('killed after twelve and opened again with no connection, the payer shows what it had', after === before, 'showed ' + before + ', shows ' + after);
    }
    const s0 = Date.now();
    const t = await tapEcash(P, Rx, amounts[i]);
    slowest = Math.max(slowest, Date.now() - s0);
    if (t.made) { paid += amounts[i]; n += 1; if (t.made.over) overs += 1; else exact += 1; }
    else refused.push((i + 1) + ' (' + amounts[i] + '): ' + t.said.slice(0, 110));
    await H.sleep(t.made && t.made.over ? 3200 : 300);
  }
  const sitting = Date.now() - t0;
  ok('all thirty are paid with no connection on the payer', n === N, n + ' of ' + N + ' in ' + Math.round(sitting / 1000) + 's (' + exact + ' from exact pieces, ' + overs
     + ' paid over with change back), the slowest ' + slowest + 'ms' + (refused.length ? '; not paid: ' + refused.slice(0, 4).join(' | ') : ''));
  const kept = P.changes.filter((c) => !c.refused).length, lost = P.changes.filter((c) => c.refused).length;
  say('change: ' + kept + ' came back over the link and were kept, ' + lost + ' were refused by the payer’s phone; '
    + limbo(P).unclaimed + ' sats of change written down, waiting; the payer’s screen shows ' + await P.W.balanceSats());
  ok('every overpayment’s change came back over the link, or was too small to send', kept + lost >= 0 && lost === 0, kept + ' kept of ' + overs + ' paid over; ' + lost + ' refused');
  const rxHolds = pileAt(Rx, MAC);
  ok('the receiver holds what it asked for across the sitting', rxHolds >= paid && rxHolds <= paid + 2 * n, 'asked ' + paid + ', holds ' + rxHolds);
  setOffline(P, false);
  await routeBack(P);
  await catchUp(P);
  if (limbo(P).held) { await H.sleep(23000); await catchUp(P); }
  await reopen(P);
  const end = limbo(P);
  if (end.unclaimed) {
    const rowsLeft = store(P, 'foxy.req.unclaimed', {}) || {};
    Object.keys(rowsLeft).forEach((id) => {
      const info = P.W.tokenInfo(rowsLeft[id].token) || {};
      say('still written down: ' + id + ', ' + rowsLeft[id].sats + ' sats in pieces of ' + JSON.stringify((info.proofs || []).map(amt))
        + (rowsLeft[id].whole ? ' (the rest of a payment of ' + rowsLeft[id].whole + ')' : '') + (rowsLeft[id].stranded ? ', stranded' : ''));
    });
    P.b.rec.warn.concat(P.b.rec.log).filter((l) => /unclaimed|claimed late|still|nothing to take|too small/i.test(l)).slice(-6)
      .forEach((l) => say('[payer] ' + String(l).slice(0, 230)));
  }
  ok('online again, the payer’s change is claimed and nothing is left waiting', calm(end) && !limboSats(end), limboLine(end));
  const down = 12000 - pileAt(P, MAC);
  ok('the sitting cost the payer what it paid and the mint’s fees, no more', down >= paid && down - rxHolds <= 3 * n, 'paid ' + paid + ', down ' + down + ', the receiver up ' + rxHolds + ': ' + (down - rxHolds) + ' to the mint');
  /* A payment that was refused: where its ecash is now. It is not in the
   * pile and not written down as waiting, so nothing above counts it. */
  const meta = store(P, 'foxy.txmeta', {}) || {};
  const left = Object.keys(meta).filter((h) => meta[h] && typeof meta[h].token === 'string' && meta[h].token);
  let strandedSats = 0;
  for (const h of left) {
    const info = P.W.tokenInfo(meta[h].token) || {};
    const pieces = info.proofs || [];
    const lockedN = pieces.filter((pr) => /^\s*\[\s*"P2PK"/.test(String(pr.secret))).length;
    const worth = sum(pieces.map(amt));
    strandedSats += worth;
    const back = await P.W.reclaimToken(meta[h].token).then((r) => 'took back ' + r.sats, (e) => 'refused: ' + String(e.message).slice(0, 90));
    say('still on an entry after the payer came online: ' + worth + ' sats in ' + pieces.length + ' pieces, ' + lockedN + ' of them locked to the payer itself; marked refused: '
      + (meta[h].refused === true) + ', taken back: ' + (meta[h].takenBack === true) + '; RECLAIM now says: ' + back);
    // and the other door: the token pasted into RECEIVE, as any token can be
    const pasted = /^took/.test(back) ? 'not needed' : await P.W.receiveToken(meta[h].token).then((r) => 'took ' + r.sats, (e) => 'refused: ' + String(e.message).slice(0, 110));
    say('pasted into RECEIVE instead: ' + pasted + '; the pile is now ' + pileAt(P, MAC));
  }
  ok('no refused payment is left on an entry, out of the balance, once the payer has a route', left.length === 0,
     left.length ? left.length + ' token(s), ' + strandedSats + ' sats' : 'none');
  await audit(P, { changes: kept });
  await catchUp(Rx);
  await audit(Rx);
  R.table.push({ id: S.id, label: 'thirty payments from an offline payer', rail: 'ecash, plain', asked: paid, rxGot: rxHolds, payerPaid: down, cost: down - rxHolds, ms: sitting,
    calm: calm(end), payerLimbo: limboSats(end), rxLimbo: 0, payerOff: booksOff(await books(P)), rxOff: booksOff(await books(Rx)),
    change: exact + ' exact, ' + overs + ' with change' });
}, { timeout: 900000 });

/* ======================================================================= */
/* Real mints, with real money (FOXY_LIVE_REAL=1; production.md).             */
/*                                                                           */
/* The same rails as above, with nothing faked: a real Lightning payment from */
/* one mint's node to another's, real fees, real waits. One wallet at each    */
/* mint, kept between runs (~/.foxy-live/real-pair/), and every pair of mints */
/* crossed both ways. Whatever a run leaves is still theirs in the next one.  */
/* `real-open` puts a token in at the first mint; `real-return` brings        */
/* everything back there and writes it out as one token.                      */
/*                                                                           */
/*   FOXY_REAL_AMOUNTS=10000      the amount each rail moves (a list, for     */
/*                                real-ln; the others take the first)         */
/*   FOXY_REAL_KEEP=1             real-return gathers it and writes no token  */

const realWallets = async (S) => {
  const ws = [];
  for (let i = 0; i < REAL_URLS.length; i++) {
    ws.push(await realPhone(S, String.fromCharCode(97 + i) + '-' + nameOf(REAL_URLS[i]), REAL_URLS[i]));
  }
  return ws;
};
/* Who pays whom, in an order that keeps the money moving: round the ring one
 * way and then back the other, so whoever is about to pay has just been
 * paid. Three mints is six crossings; two is two. */
const realRing = (ws) => {
  const n = ws.length, out = [];
  if (n < 2) return out;
  for (let i = 0; i < n; i++) out.push([ws[i], ws[(i + 1) % n]]);
  if (n === 2) return out;
  for (let i = 0; i < n; i++) out.push([ws[(n - i) % n], ws[(n - i - 1 + n) % n]]);
  return out;
};
const realLine = (p) => p.name + ' holds ' + ALL.map((m) => pileAt(p, m) + ' at ' + nameOf(m)).join(', ')
  + (limboSats(limbo(p)) ? ', and ' + limboSats(limbo(p)) + ' in between' : '');
const realAmounts = (dflt) => (process.env.FOXY_REAL_AMOUNTS ? process.env.FOXY_REAL_AMOUNTS.split(',').map(Number).filter((n) => n > 0) : dflt);
const realMs = () => { const a = realStats.ms.slice().sort((x, y) => x - y); return a.length ? 'median ' + a[Math.floor(a.length / 2)] + ' ms, slowest ' + a[a.length - 1] + ' ms' : 'none'; };
const realTor = () => (REAL_DRY ? 'a rehearsal: no Tor, fake money' : realStats.asked + ' requests through Tor, ' + realStats.failed + ' failed; ' + realMs());
// sats either side of a figure where one of these mints charges for the pieces spent
const realLax = (...ps) => (ps.some((p) => REAL_CHARGES[canon(p.home)]) ? 3 : 0);
/* What this wallet can pay of `want` out of what it holds at its own mint,
 * leaving room for the mint's reserve and `pad` more: the amount asked, or
 * the most that fits. 0 when that would be under half.
 *
 * Two and a half per cent is allowed for, 2 sats at least. Minibits and
 * forge reserve one (mint survey); cdk-mintd's own default is
 * two, which is what the rehearsal's mints keep, and a mint not yet asked
 * may keep either. A payment that still does not fit says by how much, and
 * `real-ln` takes that off and asks once more. */
const realFit = (p, want, pad) => {
  const have = pileAt(p, p.home);
  const extra = (pad || 0) + (REAL_CHARGES[canon(p.home)] ? 6 : 0);
  const need = (n) => n + Math.max(2, Math.ceil(n * 0.025)) + extra;
  if (have >= need(want)) return want;
  let fit = Math.floor((have - extra - 2) / 1.025);
  while (fit > 0 && need(fit) > have) fit--;
  return fit >= Math.max(1, Math.floor(want / 2)) ? fit : 0;
};
const realTag = (P, Rx, sats, want) => nameOf(P.home) + '→' + nameOf(Rx.home) + ' ' + sats + (sats !== want ? ' (of ' + want + ', what it could afford)' : '');

scenario('real-open', 'every wallet opened, what each holds, and a token put in if one is waiting', async (S) => {
  const ws = await realWallets(S);
  const A = ws[0];
  const f = pathR.join(REAL_DIR, 'fund.txt');
  if (fsR.existsSync(f)) {
    const token = fsR.readFileSync(f, 'utf8').trim();
    const before = pileAt(A, RA);
    const r = await A.W.receiveToken(token).then((x) => x, (e) => ({ err: e.message }));
    if (ok('the token waiting in fund.txt is taken at ' + nameOf(RA), !r.err && pileAt(A, RA) > before, r.err || ('took ' + r.sats + ' sats'))) {
      realSave(A);
      fsR.renameSync(f, f + '.used-' + Date.now());
    }
  } else if (REAL_DRY && pileAt(A, RA) === 0) {
    await H.mintAndClaim(A.W, Number(process.env.FOXY_REAL_DRY_FUND) || 20000);
    realSave(A);
  }
  ok('each opens on its own mint', ws.every((p) => canon(p.W.mintUrl) === p.home), ws.map((p) => p.name + ' on ' + nameOf(p.W.mintUrl)).join(', '));
  ws.forEach((p) => say(realLine(p)));
  for (const p of ws) await audit(p);
  say(realTor());
}, { timeout: 900000 });

scenario('real-same', 'one mint, two wallets: paid online, paid by an offline payer with change back, and taken by an offline receiver', async (S) => {
  const A = await realPhone(S, 'a-' + nameOf(RA), RA);
  const C = await realPhone(S, 's-' + nameOf(RA), RA);
  const want = realAmounts([60])[0];
  const at = nameOf(RA);
  // 1. both online: ecash locked to the receiver, answered over the link
  let sats = Math.min(want, pileAt(A, RA) - 3);
  if (sats < Math.max(1, Math.floor(want / 2))) { note(at + ': not run, ' + A.name + ' holds ' + pileAt(A, RA)); return; }
  S.start = snapshot([A, C]);
  let t0 = Date.now();
  let t = await tapEcash(A, C, sats);
  ok(at + ' ' + sats + ', both online: paid with ecash locked to the receiver', !!t.made && !!t.made.lockedTo, t.made ? 'in ' + (Date.now() - t0) + ' ms' : t.said);
  if (!t.made) return;
  await H.sleep(1500);
  await catchUp(C); await catchUp(A);
  let o = await outcome(S, A, C, at + '→' + at + ' online ' + sats, sats, { rail: 'ecash, locked', ms: Date.now() - t0 });
  ok(at + ' ' + sats + ', both online: the receiver has exactly that, and it cost the payer nothing more', o.row.rxGot === sats && o.row.cost >= 0 && o.row.cost <= realLax(A),
     'receiver up ' + o.row.rxGot + ', payer down ' + o.row.payerPaid);
  verdict(o, sats, {});
  // 2. the payer has no connection and no exact pieces: it pays over, and the change comes back over the link
  const part = Math.min(pileAt(C, RA) - 1, Math.floor(pileAt(C, RA) / 3) + 7);
  if (part > 0) {
    setOffline(C, true);
    S.start = snapshot([C, A]);
    t0 = Date.now();
    t = await tapEcash(C, A, part, { theirRoute: true });
    ok(at + ' ' + part + ', payer offline: handed over out of the pieces it holds', !!t.made,
       t.made ? t.made.sats + ' sats left it' + (t.made.over ? ' (' + t.made.over + ' over, to come back)' : ', exactly') : t.said);
    if (t.made) {
      await H.sleep(t.made.over ? 7000 : 1500);
      await catchUp(A);
      setOffline(C, false);
      await routeBack(C);
      await catchUp(C);
      o = await outcome(S, C, A, at + '→' + at + ' payer offline ' + part, part, { rail: t.made.over ? 'ecash, change back' : 'ecash, exact', ms: Date.now() - t0 });
      ok(at + ' ' + part + ', payer offline: the receiver has exactly what it asked for', o.row.rxGot === part, 'up by ' + o.row.rxGot);
      ok(at + ' ' + part + ', payer offline: and the payer is down by that and no more, its change in hand', o.row.payerPaid >= part && o.row.payerPaid <= part + 2 + realLax(A),
         'down ' + o.row.payerPaid + (t.made.over ? '; change kept: ' + JSON.stringify(C.changes.filter((c) => !c.refused).map((c) => c.sats)) : ''));
      verdict(o, part, {});
    } else { setOffline(C, false); await routeBack(C); }
  }
  // 3. the receiver has no connection: locked ecash, shown as waiting, claimed when it has one
  const half = Math.floor(pileAt(C, RA) / 2);
  if (half > 0) {
    setOffline(A, true);
    S.start = snapshot([C, A]);
    t0 = Date.now();
    t = await tapEcash(C, A, half);
    ok(at + ' ' + half + ', receiver offline: paid with ecash locked to it', !!t.made && !!t.made.lockedTo, t.made ? 'told: ' + t.rxTold() : t.said);
    await H.sleep(400);
    if (t.made) ok(at + ' ' + half + ', receiver offline: it shows the payment as waiting', A.W.unclaimedSats() >= half, A.W.unclaimedSats() + ' waiting');
    await routeBack(A);
    await catchUp(A); await catchUp(C);
    if (t.made) {
      o = await outcome(S, C, A, at + '→' + at + ' receiver offline ' + half, half, { rail: 'ecash, locked, claimed later', ms: Date.now() - t0 });
      ok(at + ' ' + half + ', receiver offline: with a connection, it has exactly that', o.row.rxGot === half, 'up by ' + o.row.rxGot);
      verdict(o, half, {});
    }
  }
  // and the second wallet hands back what it still holds, so nothing stays in it
  const left = pileAt(C, RA);
  if (left > 0) {
    const out = await C.W.sendToken(left, { unit: 'sat' }).then((x) => x, (e) => ({ err: e.message }));
    const r = out.token ? await A.W.receiveToken(out.token).then((x) => x, (e) => ({ err: e.message })) : { err: out.err };
    ok('the second wallet hands back the ' + left + ' it still holds', !r.err, r.err || ('' + r.sats));
    try { if (out.hash) { C.W.settleTx(out.hash); C.W.forgetClaimedToken(out.hash); } } catch (e) {}
  }
  await catchUp(A); await catchUp(C);
  for (const p of [A, C]) await audit(p);
  say(realLine(A)); say(realLine(C));
}, { timeout: 1500000 });

scenario('real-ln', 'by Lightning, each mint paying an invoice of each other mint', async (S) => {
  const ws = await realWallets(S);
  for (const [P, Rx] of realRing(ws)) {
    for (const want of realAmounts([300, 21, 5, 1])) {
      let sats = realFit(P, want, 0);
      if (!sats) { note(nameOf(P.home) + '→' + nameOf(Rx.home) + ' ' + want + ': not run, ' + P.name + ' holds ' + pileAt(P, P.home)); continue; }
      S.start = snapshot([P, Rx]);
      let t0 = Date.now();
      let t = await tapLightning(P, Rx, sats).catch((e) => ({ err: (e && e.message) || String(e) }));
      /* Refused for want of the reserve, with the two figures: nothing was
       * spent, so the same payment is made for that much less. (The invoice
       * the first try asked for is simply never paid.) */
      const short = !t.paid ? needHold(t.err) : null;
      if (short && short.need > short.hold && sats - (short.need - short.hold) - 2 >= Math.max(1, Math.floor(want / 2))) {
        say(nameOf(P.home) + '→' + nameOf(Rx.home) + ' ' + sats + ' needs ' + short.need + ' and ' + P.name + ' holds ' + short.hold + ': asked again for ' + (sats - (short.need - short.hold) - 2));
        sats = sats - (short.need - short.hold) - 2;
        await catchUp(Rx);
        S.start = snapshot([P, Rx]);
        t0 = Date.now();
        t = await tapLightning(P, Rx, sats).catch((e) => ({ err: (e && e.message) || String(e) }));
      }
      const label = realTag(P, Rx, sats, want);
      const ms = Date.now() - t0;
      if (!ok(label + ': the other mint’s invoice is paid', !!t.paid && !t.paid.pending,
              t.paid ? 'in ' + ms + ' ms, fee ' + t.paid.feeSats + (t.paid.pending ? ', still PENDING' : '') : t.err)) {
        await catchUp(P); await catchUp(Rx);
        const o0 = await outcome(S, P, Rx, label + ' (not paid)', sats, { rail: 'lightning', ms });
        ok(label + ': and a payment that did not go cost nothing and left nothing behind', o0.row.payerPaid === 0 && o0.row.calm && !o0.row.payerLimbo, 'payer down ' + o0.row.payerPaid + '; ' + limboLine(o0.lp));
        continue;
      }
      const c0 = Date.now();
      const c = await claimInvoice(Rx, t.inv, 120000);
      ok(label + ': the receiver’s mint knows, and the receiver claims it', !!c, c ? 'in ' + (Date.now() - c0) + ' ms' : 'not claimable after 120 s');
      await catchUp(P);
      const o = await outcome(S, P, Rx, label, sats, { rail: 'lightning', ms });
      ok(label + ': the receiver has exactly what its invoice asked', o.row.rxGot === sats, 'up by ' + o.row.rxGot);
      ok(label + ': and the payer paid that and a fee, with the unused reserve back', o.row.cost >= 0 && o.row.cost <= Math.max(5, Math.ceil(sats * 0.025)) + realLax(P),
         'down ' + o.row.payerPaid + ': ' + o.row.cost + ' to the mints and the route');
      verdict(o, sats, {});
    }
  }
  say(realTor());
}, { timeout: 3000000 });

scenario('real-cross', 'the receiver has no connection and is at another mint: the payer moves the sats there and pays locked ecash', async (S) => {
  const ws = await realWallets(S);
  for (const [P, Rx] of realRing(ws)) {
    const want = realAmounts([60])[0];
    const sats = realFit(P, want, 12);
    if (!sats) { note(nameOf(P.home) + '→' + nameOf(Rx.home) + ' ' + want + ': not run, ' + P.name + ' holds ' + pileAt(P, P.home)); continue; }
    const label = realTag(P, Rx, sats, want);
    const thereBefore = pileAt(P, Rx.home);
    setOffline(Rx, true);
    S.start = snapshot([P, Rx]);
    const t0 = Date.now();
    const x = await crossPay(P, Rx, sats, { readMs: 0, fromThere: false });
    ok(label + ': moved to their mint and paid there, locked to them', x.stage === 'pay' && !!(x.t && x.t.made) && !!x.t.made.lockedTo,
       x.t && x.t.made ? 'in ' + (Date.now() - t0) + ' ms; the move quoted ' + (x.plan ? x.plan.feeSats + ' of fees' : 'nothing: paid from what was already there') : 'stopped at the ' + x.stage + ': ' + (x.said || x.err));
    ok(label + ': the payer ends on its own mint', canon(P.W.mintUrl) === P.home, 'on ' + nameOf(P.W.mintUrl));
    await H.sleep(400);
    ok(label + ': the receiver, still offline, shows it as waiting', Rx.W.unclaimedSats() >= sats - realLax(Rx), Rx.W.unclaimedSats() + ' waiting; told: ' + (x.t ? x.t.rxTold() : ''));
    await routeBack(Rx);
    await catchUp(Rx);
    await catchUp(P);
    const o = await outcome(S, P, Rx, label, sats, { rail: 'move + ecash, locked', ms: Date.now() - t0 });
    ok(label + ': with a route, the receiver has what it asked for at its own mint', Math.abs(o.row.rxGot - sats) <= realLax(P, Rx) && pileAt(Rx, Rx.home) >= sats - realLax(P, Rx), 'up by ' + o.row.rxGot);
    ok(label + ': and it cost the payer the move’s fees and no more', o.row.cost >= 0 && o.row.cost <= Math.max(12, Math.ceil(sats * 0.025)) + 2 * realLax(P, Rx),
       'down ' + o.row.payerPaid + ': ' + o.row.cost + ' on top; ' + (pileAt(P, Rx.home) - thereBefore) + ' of its own left at ' + nameOf(Rx.home) + ' by this crossing');
    verdict(o, sats, {});
  }
  say(realTor());
}, { timeout: 3000000 });

scenario('real-carry', 'the payer has no connection: the receiver takes the payment at the payer’s mint and brings it home by Lightning', async (S) => {
  const ws = await realWallets(S);
  for (const [P, Rx] of realRing(ws)) {
    const want = realAmounts([60])[0];
    const sats = realFit(P, want, 15);
    if (!sats) { note(nameOf(P.home) + '→' + nameOf(Rx.home) + ' ' + want + ': not run, ' + P.name + ' holds ' + pileAt(P, P.home)); continue; }
    const label = realTag(P, Rx, sats, want);
    setOffline(P, true);
    S.start = snapshot([P, Rx]);
    const homeBefore = pileAt(Rx, Rx.home), thereBefore = pileAt(Rx, P.home);
    const t0 = Date.now();
    const c = await carryAsk(P, Rx, sats);
    if (!ok(label + ': the receiver quotes the way home', !!c.terms && c.terms.net === sats && c.terms.ask >= sats,
            c.err || ('asking ' + c.terms.ask + ' at ' + nameOf(c.terms.from) + ' so ' + c.terms.net + ' lands; ' + c.terms.feeSats + ' of fees'))) {
      if (canon(Rx.W.mintUrl) !== Rx.home) { try { await Rx.W.connect(Rx.home); } catch (e) {} }
      setOffline(P, false); await routeBack(P);
      continue;
    }
    const t = await tapEcash(P, Rx, c.terms.ask, { text: c.text, theirRoute: true });
    ok(label + ': the offline payer hands over the amount and the way home, at its own mint', !!t.made,
       t.made ? t.made.sats + ' sats left it' + (t.made.over ? ' (' + t.made.over + ' over, to come back)' : '') : t.said);
    if (!t.made) { await carryGiveUp(Rx, c); setOffline(P, false); await routeBack(P); continue; }
    await H.sleep(t.made.over ? 7000 : 1500);
    const h = await carryNow(Rx, c);
    ok(label + ': and the receiver melts it home', !!h.done && h.done.sats >= sats, h.said);
    ok(label + ': the receiver ends on its own mint', canon(Rx.W.mintUrl) === Rx.home, 'on ' + nameOf(Rx.W.mintUrl));
    await catchUp(Rx);
    setOffline(P, false);
    await routeBack(P);
    await catchUp(P);
    const o = await outcome(S, P, Rx, label, sats, { rail: 'ecash, carried home', ms: Date.now() - t0 });
    ok(label + ': the figure it asked for is what landed at home', pileAt(Rx, Rx.home) - homeBefore >= sats,
       (pileAt(Rx, Rx.home) - homeBefore) + ' more at ' + nameOf(Rx.home) + ', ' + (pileAt(Rx, P.home) - thereBefore) + ' left at ' + nameOf(P.home) + ' by this payment');
    ok(label + ': the payer paid what it agreed to and no more', o.row.payerPaid >= c.terms.ask && o.row.payerPaid <= c.terms.ask + 2 + realLax(P),
       'agreed ' + c.terms.ask + ' (' + (c.terms.ask - sats) + ' over the ' + sats + ' for the way home), down ' + o.row.payerPaid);
    verdict(o, sats, {});
  }
  say(realTor());
}, { timeout: 3000000 });

scenario('real-token', 'a token from another mint, pasted in: claimed where it is, then moved home', async (S) => {
  const ws = await realWallets(S);
  for (const [P, Rx] of realRing(ws)) {
    const want = realAmounts([50])[0];
    const sats = Math.min(want, pileAt(P, P.home) - 3 - (REAL_CHARGES[P.home] ? 6 : 0));
    const label = 'a ' + nameOf(P.home) + ' token into the ' + nameOf(Rx.home) + ' wallet, ' + sats;
    if (sats < Math.max(1, Math.floor(want / 2))) { note('a ' + nameOf(P.home) + ' token into the ' + nameOf(Rx.home) + ' wallet, ' + want + ': not run, ' + P.name + ' holds ' + pileAt(P, P.home)); continue; }
    S.start = snapshot([P, Rx]);
    const thereBefore = pileAt(Rx, P.home);
    const t0 = Date.now();
    const made = await P.W.sendToken(sats, { unit: 'sat' }).then((x) => x, (e) => ({ err: e.message }));
    if (!ok(label + ': the token is made', !!made.token, made.err || '')) continue;
    const info = Rx.W.tokenInfo(made.token) || {};
    const plan = await Rx.W.sweepQuote(info.mint, sats).then((x) => x, (e) => ({ err: (e && e.message) || String(e) }));
    ok(label + ': the way home is priced before anything is taken', !plan.err, plan.err || ('fees up to ' + plan.feeSats));
    const took = await Rx.W.receiveToken(made.token).then((x) => x, (e) => ({ err: e.message }));
    ok(label + ': it is claimed at its own mint first', !took.err, took.err || ('took ' + took.sats + ' at ' + took.host));
    if (!plan.err && !took.err) {
      const moved = await Rx.W.moveRun(plan, () => {}).then((x) => x || {}, (e) => ({ err: Rx.W.reason ? Rx.W.reason(e) : e.message }));
      ok(label + ': and moved home by Lightning', !moved.err, moved.err || ('in ' + (Date.now() - t0) + ' ms'));
    }
    if (canon(Rx.W.mintUrl) !== Rx.home) { try { await Rx.W.connect(Rx.home, null, null, { remember: true }); } catch (e) {} }
    try { P.W.settleTx(made.hash); P.W.forgetClaimedToken(made.hash); } catch (e) {}
    await catchUp(Rx);
    await catchUp(P);
    const o = await outcome(S, P, Rx, label, sats, { rail: 'token, swept home', ms: Date.now() - t0 });
    ok(label + ': the receiver is up by the token less the way home', o.row.rxGot > 0 && o.row.rxGot <= sats && sats - o.row.rxGot <= Math.max(12, Math.ceil(sats * 0.025)) + 2 * realLax(P, Rx),
       'up by ' + o.row.rxGot + ' in all; ' + (pileAt(Rx, P.home) - thereBefore) + ' of it left at ' + nameOf(P.home));
    verdict(o, sats, {});
  }
  say(realTor());
}, { timeout: 3000000 });

scenario('real-return', 'everything back to the first mint, and out as one token', async (S) => {
  const ws = await realWallets(S);
  const A = ws[0];
  const others = ws.slice(1);
  // a second wallet at the first mint, if a run made one
  if (fsR.existsSync(pathR.join(REAL_DIR, 's-' + nameOf(RA) + '.json'))) others.push(await realPhone(S, 's-' + nameOf(RA), RA));
  ws.concat(others.filter((p) => ws.indexOf(p) < 0)).forEach((p) => say(realLine(p)));
  // 1. what anybody else holds at the first mint is handed to the first wallet as a token: no fee, no Lightning
  for (const p of others) {
    const here = pileAt(p, RA);
    if (!(here > 0)) continue;
    const was = canon(p.W.mintUrl);
    if (was !== RA) await p.W.connect(RA, null, null, { remember: false });
    const t = await p.W.sendToken(here, { unit: 'sat' }).then((x) => x, (e) => ({ err: e.message }));
    if (was !== RA) await p.W.connect(was, null, null, { remember: true });
    const r = t.token ? await A.W.receiveToken(t.token).then((x) => x, (e) => ({ err: e.message })) : { err: t.err };
    ok(p.name + ': its ' + here + ' sats at ' + nameOf(RA) + ' are handed to the first wallet', !r.err, r.err || ('' + r.sats));
    try { if (t.hash) { p.W.settleTx(t.hash); p.W.forgetClaimedToken(t.hash); } } catch (e) {}
  }
  // 2. what each holds at a mint that is not its own goes home, as a pasted token's would
  for (const p of ws) {
    for (const away of ALL) {
      if (away === p.home || (p !== A && away === RA)) continue;
      const have = pileAt(p, away);
      if (have < 20) continue;
      const plan = await p.W.sweepQuote(away, have).then((x) => x, (e) => ({ err: (e && e.message) || String(e) }));
      if (plan.err) { say(p.name + ': ' + have + ' at ' + nameOf(away) + ' stays there: ' + plan.err); continue; }
      /* Quoted while still on its own mint, then run from the mint the sats
       * are at, as the app does for change left behind
       * (07-history-tokens-mints.js): run from home it would try to pay out
       * of the wrong pile, which is what the rehearsal caught. */
      const r = await p.W.connect(away).then(() => p.W.moveRun(plan, () => {}))
        .then((x) => x || {}, (e) => ({ err: p.W.reason ? p.W.reason(e) : e.message }));
      if (canon(p.W.mintUrl) !== p.home) { try { await p.W.connect(p.home, null, null, { remember: true }); } catch (e) {} }
      ok(p.name + ': the ' + have + ' it held at ' + nameOf(away) + ' is moved home', !r.err,
         r.err || ((r.sats || 0) + ' landed' + (r.leftBehind ? ', ' + r.leftBehind + ' still there' : '')));
      await catchUp(p);
    }
  }
  // 3. every other wallet pays the first all it can by Lightning, in smaller parts if the whole will not go
  for (const p of ws.slice(1)) {
    let part = 0;
    for (let i = 0; i < 8; i++) {
      const have = pileAt(p, p.home);
      if (have < 20) break;
      const most = Math.floor((have - 2 - (REAL_CHARGES[p.home] ? 8 : 0)) / 1.025);
      const sats = part ? Math.min(part, most) : most;
      if (!(sats > 0)) break;
      S.start = snapshot([p, A]);
      const t = await tapLightning(p, A, sats).catch((e) => ({ err: (e && e.message) || String(e) }));
      if (t.paid && !t.paid.pending) {
        const c = await claimInvoice(A, t.inv, 120000);
        await catchUp(p);
        ok(p.name + ' pays the first wallet ' + sats + ' by Lightning', !!c, 'fee ' + t.paid.feeSats);
      } else {
        say(p.name + ' paying ' + sats + ' back: ' + (t.err || 'still pending'));
        await catchUp(p);
        part = Math.max(20, Math.floor(sats / 2));
      }
    }
  }
  for (const p of ws) await catchUp(p);
  ws.concat(others.filter((p) => ws.indexOf(p) < 0)).forEach((p) => say(realLine(p)));
  for (const p of ws) await audit(p);
  const all = pileAt(A, RA);
  if (all > 0 && process.env.FOXY_REAL_KEEP !== '1') {
    const out = await A.W.sendToken(all, { unit: 'sat' }).then((x) => x, (e) => ({ err: e.message }));
    if (ok('the first wallet’s ' + all + ' sats are written out as one token', !!out.token, out.err || '')) {
      const file = pathR.join(REAL_DIR, 'return-token.txt');
      fsR.writeFileSync(file, out.token + '\n', { mode: 0o600 });
      realSave(A);
      say(out.sats + ' sats, in ' + file.replace(osR.homedir(), '~'));
    }
  } else if (all > 0) {
    say('kept in the first wallet: ' + all + ' sats at ' + nameOf(RA) + ' (FOXY_REAL_KEEP=1)');
  }
  say('left behind: ' + ws.map(realLine).join('; '));
  say(realTor());
}, { timeout: 3000000 });

async function runOne(sc) {
  SCEN = sc.id;
  console.log('\n' + sc.id + '. ' + sc.title);
  const S = { id: sc.id, phones: [], start: {} };
  const p0 = R.pass, f0 = R.fail, t0 = Date.now();
  let timer;
  const late = new Promise((_, no) => {
    timer = setTimeout(() => no(new Error('the scenario did not finish in ' + (sc.timeout / 1000) + ' s')), sc.timeout);
  });
  try { await Promise.race([sc.fn(S), late]); }
  catch (e) {
    ok('the scenario ran to its end', false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
    if (DEBUG) S.phones.forEach((p) => diary(p, /./, 20));
  }
  clearTimeout(timer);
  // every page it opened is closed: no poller of one scenario runs under the next
  S.phones.forEach((p) => { try { if (p.b && !p.b.life.dead) { realSave(p); p.stored = p.b.kill(); realSave(p); } } catch (e) {} });
  R.scen.push({ id: sc.id, title: sc.title, pass: R.pass - p0, fail: R.fail - f0, s: Math.round((Date.now() - t0) / 1000) });
}

async function run() {
  const picked = SCENARIOS.filter((sc) => !only.length || only.some((k) => sc.id === k || sc.id.indexOf(k) === 0));
  if (!picked.length) { console.log('no scenario matches ' + only.join(' ') + '; there are: ' + SCENARIOS.map((s) => s.id).join(' ')); FINISHED = true; process.exit(2); }
  console.log(REAL_DRY ? 'A REHEARSAL of the real-mint scenarios, with fake money: ' + REAL_URLS.map((u) => nameOf(u) + ' ' + u).join('   ')
    : REAL ? 'REAL MINTS, REAL MONEY: ' + REAL_URLS.map((u) => nameOf(u) + ' ' + u).join('   ') + '   through Tor at 127.0.0.1:' + realSocks()
    : 'macadamia-like ' + MAC + '   minibits-like ' + MB + '   pending ' + PEND);
  console.log('wallet: ' + (process.env.FOXY_WALLET_FILE || 'Web/foxy-wallet.js'));
  for (const sc of picked) await runOne(sc);

  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  if (R.table.length) {
    console.log('\n' + pad('scenario', 15) + pad('payment', 50) + pad('rail', 22) + pad('asked', 7) + pad('rx got', 8) + pad('payer', 7) + pad('cost', 6)
      + pad('ms', 7) + 'left over / books');
    R.table.forEach((r) => {
      console.log(pad(r.id || '', 15) + pad(r.label, 50) + pad(r.rail || '', 22) + pad(r.asked, 7) + pad(r.rxGot, 8) + pad(r.payerPaid, 7) + pad(r.cost, 6)
        + pad(r.ms === undefined ? '' : r.ms, 7)
        + (r.calm && !r.payerLimbo && !r.rxLimbo ? 'clean' : 'IN BETWEEN payer ' + r.payerLimbo + ' rx ' + r.rxLimbo)
        + (r.payerOff || r.rxOff ? ', BOOKS OFF payer ' + r.payerOff + ' rx ' + r.rxOff : ', books add up')
        + (r.ghostP || r.ghostR ? ', SPENT ECASH SHOWN AS HELD payer ' + (r.ghostP || 0) + ' rx ' + (r.ghostR || 0) : '')
        + (r.change ? ', ' + r.change : ''));
    });
  }
  console.log('\n' + pad('scenario', 15) + pad('checks', 16) + pad('s', 6) + 'what');
  R.scen.forEach((s) => {
    console.log(pad(s.id, 15) + pad(s.fail ? s.fail + ' FAIL, ' + s.pass + ' ok' : 'all ' + s.pass + ' ok', 16) + pad(s.s, 6) + s.title);
  });
  if (R.notes.length) { console.log('\nnotes:'); R.notes.forEach((n) => console.log('  ' + n)); }
  if (R.failed.length) { console.log('\nfailed:'); R.failed.forEach((f) => console.log('  ' + f)); }
  console.log('\n' + H.phoneReport());
  console.log('\n' + (R.fail ? R.fail + ' offline/cross-mint check(s) failed, ' + R.pass + ' passed'
    : 'all ' + R.pass + ' offline/cross-mint checks pass')
    + (R.known ? '; ' + R.known + ' more came out as findings already written up, and are not counted' : ''));
  FINISHED = true;
  process.exit(R.fail ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); FINISHED = true; process.exit(1); });
