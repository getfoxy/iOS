'use strict';
/* tap-scenarios.js — what two phones do when one taps to pay the other, at
 * mints modelled on two real ones (below), with the connection cut and the
 * app killed part-way.
 *
 *   sh tools/live/mint-pair.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/tap-scenarios.js [only ...]
 *
 * `only` is any of: same, cross, faults (default: all three).
 *
 * The other live suites each take one money path and push on it. This one
 * takes the payment a person actually makes — two Foxys held together — and
 * runs it the way the app would, on the rail the app would pick
 * (26d-tap.js `tapOfferOf` and what follows it):
 *
 *   same mint                          ecash over the link (`payRequest`)
 *     payer online                       locked to the receiver
 *     payer offline                      plain, from pieces on hand; anything
 *                                        over comes back locked to the payer
 *   another mint
 *     both online                        the receiver's Lightning invoice
 *     payer online, receiver offline     the payer moves the money to their
 *                                        mint and pays from there
 *     payer offline, receiver online     the receiver quotes the way home,
 *                                        takes it at the payer's mint and
 *                                        melts it home
 *   both offline                       refused, by design
 *
 * The mints are CDK at the versions and fees of mint.macadamia.cash (0.18.1,
 * 150 ppk) and mint.minibits.cash (0.17.7, no fee) — mint-pair.sh. The fee is
 * the point: every bug found there was the difference between the two.
 *
 * What it cannot do is the radio. The link here is a model of it (as in
 * tests/change-leg.js): messages cross while it is up and fail the way
 * CoreBluetooth fails them when it is not. Each page is the real wallet on a
 * mocked phone, talking to a real mint.
 *
 * For every scenario the questions are: did the receiver get what
 * it asked for, what did it cost the payer, is anything left in between, and
 * do both phones' entries add up to what they hold. Fake money only. */
const H = require('./harness');

setTimeout(() => { console.log('WATCHDOG 1500s'); process.exit(2); }, 1500000).unref();

const MAC = 'https://127.0.0.1:8473';       // macadamia-like: charges 150 ppk
const MB = 'https://127.0.0.1:8474';        // minibits-like: charges nothing
const NAME = { [MAC]: 'macadamia', [MB]: 'minibits' };
const canon = (u) => String(u || '').replace(/\/+$/, '');
const only = process.argv.slice(2);
const want = (k) => !only.length || only.indexOf(k) >= 0;
// FOXY_TAP_ONLY=F3,F11 runs only those fault scenarios; FOXY_TAP_DEBUG=1 prints what each wallet said
const pickF = (id) => !process.env.FOXY_TAP_ONLY || process.env.FOXY_TAP_ONLY.split(',').indexOf(id) >= 0;
const DEBUG = process.env.FOXY_TAP_DEBUG === '1';

const R = { pass: 0, fail: 0, table: [], failed: [] };
let SCEN = '';
const ok = (name, good, detail) => {
  console.log((good ? '  OK    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (good) R.pass++; else { R.fail++; R.failed.push(SCEN + ': ' + name + (detail ? ' — ' + detail : '')); }
};
const title = (s) => { SCEN = s; console.log('\n' + s); };

/* ---- a phone: a keychain and a counter file that outlive the page ------ */
function newPhone(name, home) {
  return { name, home, keychain: { words: '' }, native: null, b: null, W: null, offline: false,
           link: null, answers: [], faults: [], killedAt: null, stored: null, owed: 0, changes: [] };
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

/* One mint request's fate. Offline, nothing leaves. Otherwise the first fault
 * that matches decides: 'before' (never reaches the mint), 'after' (the mint
 * does it and the answer is lost), and with `kill` the app dies at that
 * moment — before the request leaves, or with it on its way. */
function netFor(p) {
  return (m, path) => {
    if (p.offline) return 'before';
    for (const f of p.faults) {
      if (f.used && f.once !== false) continue;
      if (f.method && f.method !== m.method) continue;
      if (f.mint && canon(m.url).indexOf(canon(f.mint)) !== 0) continue;
      if (!f.path.test(path)) continue;
      f.used = true;
      f.hits = (f.hits || 0) + 1;
      if (f.kill) kill(p, f.label || (f.fate + ' ' + path));
      return f.fate;
    }
    return 'ok';
  };
}

/* The tap link's messages, between this page and the one at the other end. */
function bridgeFor(p) {
  return (m, reply) => {
    const L = p.link;
    switch (m.action) {
      case 'inboxAnswer': {
        /* As the phone passes it on (FoxyBridge+Delivery.swift
         * `handleInboxAnswer`): 200, 409 and 422 only, anything else sent as
         * 422. Left out, this file showed a 504 the page said reaching the
         * payer, which on a phone it never would. */
        const asked = Number(m.status);
        const status = [200, 409, 422].indexOf(asked) >= 0 ? asked : 422;
        p.answers.push({ status, text: String(m.text || '').slice(0, 300) });
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
        // answered when the payer says it kept it, or seven seconds on (FoxyBridge+Tap.swift handleTapChange)
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
          }
        }
        reply(m.id, 'ok'); return true;
      }
      case 'tapSend': {
        if (!L || !L.up || L.cutBeforeM5) {
          if (L) { L.up = false; L.log.push('link down before M5'); }
          reply(m.id, null, 'That phone is no longer connected.'); return true;
        }
        const rx = L.receiver;
        if (!rx.b || rx.b.life.dead) { reply(m.id, null, 'That phone is no longer connected.'); return true; }
        L.log.push('M5 payment');
        const began = rx.answers.length;
        const body = String(m.body || '');
        setTimeout(() => { try { rx.W._requestPaid(body, 'wire', 'tap'); } catch (e) {} }, 0);
        const until = Date.now() + 25000;
        const wait = setInterval(() => {
          if (rx.answers.length > began) {
            clearInterval(wait);
            const last = rx.answers[rx.answers.length - 1];
            if (L.cutBeforeM6) {
              L.up = false; L.log.push('link down before M6 reached the payer');
              return reply(m.id, null, 'That phone is no longer connected.');
            }
            /* M6 as the receiver's phone seals it (TapLink.swift `sealResult`):
             * JSON with a code, which `tapSend` reads as settled (200),
             * unconfirmed (409, 504, or no code) or refused (anything else).
             * A bare 'settled' here read as unconfirmed, and an error as a
             * lost link, so every tap in this file was one nobody confirmed
             * (found by tools/live/offline-cross-scenarios.js). */
            return reply(m.id, JSON.stringify(last.status === 200 ? { v: 2, ok: true, code: 200 }
              : { v: 2, ok: false, code: last.status, why: String(last.text || '').slice(0, 160) }));
          }
          if ((rx.b && rx.b.life.dead) || !L.up) {
            clearInterval(wait);
            L.log.push('the receiver went away with the payment in flight');
            return reply(m.id, null, 'That phone is no longer connected.');
          }
          // the receiver's own give-up, twenty-five seconds on (TapLink `resultWait`): it says 504
          if (Date.now() > until) {
            clearInterval(wait);
            L.log.push('M6 504 (the receiver gave up waiting on its own page)');
            reply(m.id, JSON.stringify({ v: 2, ok: false, code: 504, why: 'Their phone did not answer in time.' }));
          }
        }, 5);
        return true;
      }
      default:
        reply(m.id, null, 'not in this test'); return true;
    }
  };
}

/* Open the app on this phone: a fresh page over what the last one wrote. */
async function launch(p, o) {
  const opts = o || {};
  p.b = H.boot({ keychain: p.keychain, phone: p.native || undefined, storage: p.stored || undefined,
                 net: netFor(p), bridge: bridgeFor(p) });
  p.native = p.b.phone;
  p.W = p.b.W;
  // ten seconds on a phone; the local mints answer in a fraction of one
  p.W._refundWaitMs = 2500;
  p.killedAt = null;
  p.said = p.said || [];
  p.pages = (p.pages || []).concat([p.b]);
  /* What the app does when change arrives (15-paid-wake-keyboard.js): check
   * it against what is owed, swap it in with a route or write it down
   * without one, and say which over the link. */
  p.W.onTapChange((token) => {
    const W = p.W;
    const bits = W.tokenInfo ? W.tokenInfo(token) : null;
    const sats = bits ? (bits.proofs || []).reduce((a, pr) => a + Number(pr.amount || 0), 0) : 0;
    const act = () => {
      const chk = W.checkChange ? W.checkChange(token, p.owed) : { ok: true, signed: true };
      if (!chk.ok) { p.changes.push({ sats, refused: chk.why }); W.tapChangeKept(false); return; }
      const kept = (how) => {
        p.changes.push({ sats, how });
        // `changeArrived` (26d-tap.js): the payment's own entry is told what its change is worth here
        const net = W.changeNet ? W.changeNet(token) : sats;
        try { if (p.lastHash && W.changeSettled) W.changeSettled(p.lastHash, net); } catch (e) {}
        return W.tapChangeKept(true);
      };
      if (!p.offline) {
        W.receiveToken(token, { hash: 'tap-change-' + Date.now() }).then(() => kept('swapped in'), () => {
          if (!chk.signed) return W.tapChangeKept(false);
          try { W.keepChange(token, sats); return kept('written down'); } catch (x) { return W.tapChangeKept(false); }
        }).catch(() => {});
        return;
      }
      if (!chk.signed) { W.tapChangeKept(false); return; }
      try { W.keepChange(token, sats); kept('written down, offline'); } catch (e) { W.tapChangeKept(false); }
    };
    // `owed` is what the send reported, which lands a tick after M6
    setTimeout(act, 30);
  });
  if (p.offline) goOffline(p.W);
  await p.W.seedReady();
  await p.W.connect(opts.at || p.home, null, null, { remember: true });
  return p;
}

/* Killed, as iOS kills it. What it wrote is kept for the next launch. */
function kill(p, why) {
  if (!p.b || p.b.life.dead) return;
  p.stored = p.b.kill();
  if (DEBUG) {
    let recs = [];
    try { recs = JSON.parse(p.stored['foxy.cashu.swaps'] || '[]'); } catch (e) {}
    recs.forEach((r) => console.log('         [' + p.name + ' killed, ' + why + '] swap record: ' + JSON.stringify(Object.assign({}, r, {
      inputs: (r.inputs || []).length + ' inputs, ' + (r.inputs || []).reduce((a, x) => a + Number(x.amount || 0), 0) + ' sats',
      locked: r.locked ? (Array.isArray(r.locked) ? r.locked.length + ' locked' : r.locked) : undefined,
    })).slice(0, 700)));
    if (!recs.length) console.log('         [' + p.name + ' killed, ' + why + '] no swap record written down');
  }
  p.killedAt = why || 'killed';
  if (p.link) { p.link.up = false; p.link.log.push(p.name + ' killed: ' + p.killedAt); }
}

/* Opened again, and what the app runs on every launch and reconnect
 * (06-wallet-boot-and-restore.js): the sweeps, then anything that arrived and
 * was never claimed. */
async function reopen(p, o) {
  if (p.b && !p.b.life.dead) p.stored = p.b.kill();
  p.faults = [];
  await launch(p, o);
  if (!p.offline) await catchUp(p);
  return p;
}
async function catchUp(p) {
  try { await p.W.resumeSweeps(); } catch (e) {}
  try { await p.W.claimUnclaimed(); } catch (e) {}
  // a melt or a mint quote the fake Lightning has not finished with yet
  for (let i = 0; i < 12; i++) {
    const waiting = (p.W.pendingMelts ? p.W.pendingMelts().length : 0)
      + (p.W.pendingQuotes ? (p.W.pendingQuotes() || []).length : 0)
      + (p.W.pendingMove && p.W.pendingMove() ? 1 : 0);
    if (!waiting) break;
    await H.sleep(1500);
    try { await p.W.resumeSweeps(); } catch (e) {}
  }
  // a claim made late may have started a payment home on a timer: waited for here
  await H.sleep(50);
  if (p.W.crossingsWaiting && p.W.crossingsWaiting()) { try { await p.W.catchUpCrossings(); } catch (e) {} }
}
const setOffline = (p, off) => { p.offline = !!off; if (p.W) (off ? goOffline : goOnline)(p.W); };

/* ---- the books -------------------------------------------------------- */
const pileAt = (p, mint) => p.W.balanceAt(canon(mint));
function limbo(p) {
  const W = p.W;
  return {
    unclaimed: Math.round(Number(W.unclaimedSats && W.unclaimedSats()) || 0),
    held: Math.round(Number(W.heldSats && W.heldSats()) || 0),
    recovering: Math.round(Number(W.recoveringSats && W.recoveringSats()) || 0),
    melts: W.pendingMelts ? W.pendingMelts().length : 0,
    move: W.pendingMove && W.pendingMove() ? 1 : 0,
  };
}
const limboSats = (l) => l.unclaimed + l.held + l.recovering;
const calm = (l) => !l.unclaimed && !l.held && !l.recovering && !l.melts && !l.move;

/* The history card's arithmetic (16-history-lists.js `histAudit`), one mint at
 * a time: what the entries say this phone should hold there. */
async function entriesAt(p, mint) {
  const m = canon(mint);
  const rows = await p.W.transactions(500);
  let sum = 0;
  rows.forEach((e) => {
    if (!e || canon(e.mint) !== m) return;
    if (e.unit && e.unit !== 'sat') return;
    if (e.state === 'failed' || e.failed || e.atRisk) return;
    const changeRow = e.dir === 'in' && (e.changeRow || /^(tap|req)-change-/.test(String(e.hash || '')));
    if (changeRow) return;
    if (e.dir === 'in') { if (e.state === 'pending' && !e.settled) return; sum += Number(e.sats) || 0; return; }
    const owedBack = e.changeState === 'owed' ? (Number(e.changeSats) || 0) : 0;
    sum -= (Number(e.sats) || 0) + Math.max(0, Number(e.feeSats) || 0) + owedBack;
  });
  return sum;
}
async function books(p) {
  const out = [];
  for (const mint of [MAC, MB]) {
    // less the fees no entry could carry, which the card counts too (`topUpFeeSats`, this mint only)
    const loose = (canon(p.W.mintUrl) === canon(mint) && p.W.topUpFeeSats) ? Math.round(Number(p.W.topUpFeeSats()) || 0) : 0;
    const says = (await entriesAt(p, mint)) - loose;
    const holds = pileAt(p, mint);
    out.push({ mint: NAME[mint], says, holds, off: says - holds });
  }
  return out;
}
const booksLine = (bk) => bk.filter((x) => x.says || x.holds)
  .map((x) => x.mint + ' ' + x.holds + (x.off ? ' (entries say ' + x.says + ')' : '')).join(', ') || 'nothing';

async function snapshotOf(T) {
  const s = {};
  for (const p of [T.P, T.R]) {
    s[p.name] = { mac: pileAt(p, MAC), mb: pileAt(p, MB) };
  }
  return s;
}

/* Two phones, each funded at its own mint, with a link between them. */
async function pair(payerMint, rxMint, o) {
  const opts = o || {};
  const P = newPhone('payer', payerMint);
  const Rx = newPhone('receiver', rxMint);
  await launch(P);
  await H.mintAndClaim(P.W, opts.fund || 4000);
  await P.W.primeLocks();
  await launch(Rx);
  if (opts.rxFund !== 0) await H.mintAndClaim(Rx.W, opts.rxFund || 1000);
  await Rx.W.primeLocks();
  /* A payer that has been used: the small-change pool is made, as it is on a
   * phone that has been put away once since its first receive. */
  if (opts.pool !== false) { for (let i = 0; i < 8; i++) { const r = await P.W.tidyChange().catch(() => null); if (!r || r.skipped) break; } }
  const L = { up: true, log: [], payer: P, receiver: Rx, owed: false };
  P.link = L; Rx.link = L;
  const T = { P, R: Rx, L };
  T.start = await snapshotOf(T);
  return T;
}
const relink = (T) => { T.L.up = true; T.L.owed = false; T.L.cutBeforeM5 = false; T.L.cutBeforeM6 = false; T.L.log.length = 0; };

/* ---- the three ways a tap is paid -------------------------------------- */

/* Same mint: the request goes over the link and ecash comes back down it
 * (07-history-tokens-mints.js `makeTokenForRequest`). */
async function tapEcash(T, sats) {
  const { P, R: Rx } = T;
  const text = Rx.W.paymentRequest(sats, { purpose: 'receive' });
  const ask = P.W.decodeRequest(text) || {};
  // `asks`: what an up-to-date receiver's offer says (`ask: 1`), so the payer asks before it makes anything
  const req = Object.assign({}, ask, { sats, unit: 'sat', viaTap: true, theirRoute: !Rx.offline, asks: true });
  const lack = P.W.sendShortfall ? P.W.sendShortfall(sats, { locked: !!(ask.lockTo && !P.offline) }) : null;
  const t0 = Date.now();
  // changeComesBack: only from a receiver with a route
  const res = await P.W.payRequest(req, null, { overpayOk: !Rx.offline })
    .then((r) => ({ made: r }), (e) => ({ err: (e && e.message) || String(e), e }));
  if (res.made) { P.lastHash = res.made.hash; P.owed = Math.round(Number(res.made.over) || 0); }
  return Object.assign(res, { ms: Date.now() - t0, lack, text });
}

/* Another mint, both with a route: the receiver's invoice, paid by Lightning. */
async function tapLightning(T, sats) {
  const { P, R: Rx } = T;
  const inv = await Rx.W.invoice(sats, '');
  const bolt = inv.invoice || inv.request || inv.bolt11 || inv.pr || inv.text;
  const t0 = Date.now();
  const res = await P.W.pay(bolt).then((r) => ({ paid: r }), (e) => ({ err: (e && e.message) || String(e) }));
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

const sum = (a) => a.reduce((x, y) => x + y, 0);
/* How many pieces a phone holds at a mint: what the mint will charge to spend them. */
function piecesAt(p, mint) {
  const host = canon(mint).replace(/^https?:\/\//, '');
  let n = 0;
  const w = p.b.w;
  for (let i = 0; i < w.localStorage.length; i++) {
    const k = w.localStorage.key(i);
    if (/^foxy\.cashu\.proofs\./.test(k) && k.indexOf(host) >= 0) n += JSON.parse(w.localStorage.getItem(k) || '[]').length;
  }
  return n;
}

/* What the mint says of each pile: sats the app counts that are already spent.
 *
 * The app never asks this by itself any more (`reconcile`, 17-backup.js: it
 * tells the mint too much), so a pile can go on counting money that has gone
 * until a payment picks it. A test can ask, and has to: "the payer is down
 * nothing" means nothing if what it holds is spent. Every mint the phone
 * holds anything at, then back to where it was. */
async function phantom(p) {
  if (p.offline) return 0;
  const was = canon(p.W.mintUrl);
  let gone = 0;
  for (const mint of [MAC, MB]) {
    if (!(pileAt(p, mint) > 0)) continue;
    try {
      if (canon(p.W.mintUrl) !== canon(mint)) await p.W.connect(mint, null, null, { remember: true });
      const before = pileAt(p, mint);
      await p.W.reconcile();
      gone += Math.max(0, before - pileAt(p, mint));
    } catch (e) {}
  }
  if (was && canon(p.W.mintUrl) !== was) { try { await p.W.connect(was, null, null, { remember: true }); } catch (e) {} }
  return gone;
}

/* What a scenario left, measured against where it started. */
async function outcome(T, label, sats, extra) {
  const { P, R: Rx } = T;
  // before anything is corrected: do the entries match what the app shows
  const bpShown = await books(P), brShown = await books(Rx);
  const ghostP = await phantom(P), ghostR = await phantom(Rx);
  const now = await snapshotOf(T);
  const d = (who, k) => now[who][k] - T.start[who][k];
  const rxGot = d('receiver', 'mac') + d('receiver', 'mb');
  const payerPaid = -(d('payer', 'mac') + d('payer', 'mb'));
  const lp = limbo(P), lr = limbo(Rx);
  const bp = bpShown, br = brShown;
  if (DEBUG) {
    for (const p of [P, Rx]) {
      const rows = await p.W.transactions(50);
      console.log('         ' + p.name + ' entries: ' + rows.map((e) => (e.dir === 'in' ? '+' : '-') + e.sats
        + (e.feeSats ? 'f' + e.feeSats : '') + (e.grossSats ? 'g' + e.grossSats : '') + (e.changeSats ? 'c' + e.changeSats : '')
        + (e.changeState ? '(' + e.changeState + ')' : '') + (e.state && e.state !== 'success' ? '[' + e.state + ']' : '')
        + '<' + String(e.hash || '').slice(0, 10) + '>').join(' '));
    }
  }
  const row = Object.assign({
    label, asked: sats, rxGot, payerPaid, cost: payerPaid - rxGot, ghostP, ghostR,
    payerLimbo: limboSats(lp), rxLimbo: limboSats(lr),
    payerOff: sum(bp.map((x) => Math.abs(x.off))), rxOff: sum(br.map((x) => Math.abs(x.off))),
    calm: calm(lp) && calm(lr),
  }, extra || {});
  R.table.push(row);
  T.start = now;
  return { row, lp, lr, bp, br };
}
/* The four questions, asked the same way every time. */
function verdict(o, sats, expect) {
  const e = expect || {};
  const r = o.row;
  if (e.rxGot !== undefined) {
    ok('the receiver holds what it asked for', r.rxGot === e.rxGot, 'asked ' + sats + ', up by ' + r.rxGot);
  }
  if (e.maxCost !== undefined) {
    ok('and it cost the payer no more than ' + e.maxCost + ' on top', r.cost >= 0 && r.cost <= e.maxCost,
       'the payer is down ' + r.payerPaid + ', the receiver up ' + r.rxGot + ': ' + r.cost + ' to the mints');
  }
  ok('neither phone was showing ecash the mint says is spent', !r.ghostP && !r.ghostR,
     'payer ' + r.ghostP + ' sats, receiver ' + r.ghostR + ' sats shown as held and already spent');
  ok('nothing is left in between', r.calm && !r.payerLimbo && !r.rxLimbo,
     'payer ' + JSON.stringify(o.lp) + ', receiver ' + JSON.stringify(o.lr));
  ok('the payer’s entries add up to what it holds', r.payerOff === 0, booksLine(o.bp));
  ok('and so do the receiver’s', r.rxOff === 0, booksLine(o.br));
}

/* ======================================================================= */
async function sameMint() {
  title('1. macadamia to macadamia, both online — ecash, locked to the receiver');
  {
    const T = await pair(MAC, MAC);
    for (const sats of [8, 100, 1181, 2047]) {
      relink(T);
      const t = await tapEcash(T, sats);
      ok(sats + ' sats: the card allows it and it is paid', !!t.made && (!t.lack || !t.lack.short),
         t.made ? t.ms + ' ms, ' + (t.made.lockedTo ? 'locked' : 'NOT locked') + ', ' + t.made.sats + ' sats left the payer'
                : t.err + ' ' + JSON.stringify(t.lack));
      await H.sleep(1200);
      await catchUp(T.R);
      ok(sats + ' sats: no change crossed and no code went up', T.L.log.indexOf('M7 change') < 0 && !T.P.changes.length,
         T.L.log.join(' | '));
      const o = await outcome(T, 'mac→mac online, ' + sats, sats, { rail: 'ecash, locked', ms: t.ms });
      /* What it costs at a mint that charges: the receiver's fee on the pieces
       * sent, and the payer's on the pieces it spent — one piece when a large
       * one is to hand, dozens when the pile is small change. */
      verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.01) + 6 });
    }
  }

  title('2. macadamia to macadamia, the payer offline — plain ecash from pieces on hand');
  {
    const T = await pair(MAC, MAC);
    setOffline(T.P, true);
    for (const sats of [8, 100, 1181]) {
      relink(T);
      T.P.changes.length = 0;
      const t = await tapEcash(T, sats);
      ok(sats + ' sats: paid with no connection on the payer', !!t.made,
         t.made ? t.ms + ' ms, ' + (t.made.swapped === false ? 'exact pieces, the mint not asked' : 'swapped')
                + (t.made.over ? ', ' + t.made.over + ' over, to come back' : '') : t.err);
      await H.sleep(2500);
      await catchUp(T.R);
      const o = await outcome(T, 'mac→mac payer offline, ' + sats, sats, { rail: 'ecash, plain', ms: t.ms,
        change: T.P.changes.map((c) => c.sats + (c.refused ? ' refused' : ' ' + c.how)).join('; ') });
      ok(sats + ' sats: the receiver is up by what it asked', o.row.rxGot === sats, 'up by ' + o.row.rxGot);
    }
    // the payer comes back: what it was handed as change is swapped in, and its sent tokens settle
    setOffline(T.P, false);
    await reopen(T.P);
    const o = await outcome(T, 'mac→mac payer offline: back online', 0, { rail: 'catch-up' });
    verdict(o, 0, {});
  }

  title('2b. macadamia to macadamia, the payer offline with no small change — it pays over, and the difference comes back down the link');
  {
    const T = await pair(MAC, MAC, { pool: false });
    setOffline(T.P, true);
    for (const sats of [100, 700]) {
      relink(T);
      T.P.changes.length = 0;
      const t = await tapEcash(T, sats);
      ok(sats + ' sats: paid by handing over more than was asked', !!t.made && t.made.over > 0,
         t.made ? t.made.sats + ' sats left the payer, ' + t.made.over + ' of it to come back' : t.err);
      await H.sleep(3500);
      await catchUp(T.R);
      const crossed = T.L.log.indexOf('M7 change') >= 0;
      const kept = T.P.changes.filter((c) => !c.refused);
      ok(sats + ' sats: the change crosses the link and the payer keeps it', crossed && kept.length === 1,
         T.L.log.join(' | ') + ' ; ' + JSON.stringify(T.P.changes));
      const o = await outcome(T, 'mac→mac payer offline, overpaid, ' + sats, sats, { rail: 'ecash, plain + change', ms: t.ms,
        change: T.P.changes.map((c) => c.sats + (c.refused ? ' refused: ' + c.refused : ' ' + c.how)).join('; ') });
      ok(sats + ' sats: the receiver keeps what it asked for, whatever making the change cost', o.row.rxGot === sats,
         'asked ' + sats + ', up by ' + o.row.rxGot + (t.made ? ' (handed ' + t.made.sats + ', ' + t.made.over + ' over)' : ''));
      ok(sats + ' sats: and its entries add up', o.row.rxOff === 0, booksLine(o.br));
    }
    setOffline(T.P, false);
    await reopen(T.P);
    const o = await outcome(T, 'mac→mac overpaid: payer back online', 0, { rail: 'catch-up' });
    verdict(o, 0, {});
  }

  title('3. macadamia to macadamia, the receiver offline — locked ecash, taken on the lock alone');
  {
    const T = await pair(MAC, MAC);
    setOffline(T.R, true);
    const sats = 500;
    const t = await tapEcash(T, sats);
    ok('paid, locked, to a receiver with no connection', !!t.made && !!t.made.lockedTo,
       t.made ? t.ms + ' ms' : t.err);
    await H.sleep(800);
    const mid = limbo(T.R);
    ok('the receiver says it was paid and holds it as its own, unswapped', T.R.answers.some((a) => a.status === 200) && mid.unclaimed >= sats,
       JSON.stringify(mid) + ' | ' + T.L.log.join(' | '));
    setOffline(T.R, false);
    await reopen(T.R);
    const o = await outcome(T, 'mac→mac receiver offline, ' + sats, sats, { rail: 'ecash, locked', ms: t.ms });
    verdict(o, sats, { rxGot: sats, maxCost: 6 });
  }

  title('4. macadamia to macadamia, both offline — refused, and nothing moves');
  {
    const T = await pair(MAC, MAC);
    setOffline(T.P, true); setOffline(T.R, true);
    const t = await tapEcash(T, 100);
    ok('the payment is refused', !t.made, t.made ? 'it went through' : t.err);
    const o = await outcome(T, 'mac→mac both offline', 100, { rail: 'refused' });
    ok('and neither phone’s money moved', o.row.rxGot === 0 && o.row.payerPaid === 0,
       'payer down ' + o.row.payerPaid + ', receiver up ' + o.row.rxGot);
    setOffline(T.P, false); setOffline(T.R, false);
    await reopen(T.P); await reopen(T.R);
    const o2 = await outcome(T, 'mac→mac both offline: back online', 0, { rail: 'catch-up' });
    verdict(o2, 0, {});
  }
}

/* ======================================================================= */
async function crossMint() {
  title('5. macadamia to minibits, both online — the receiver’s Lightning invoice');
  {
    const T = await pair(MAC, MB, { rxFund: 0 });
    for (const sats of [100, 1181]) {
      const t = await tapLightning(T, sats);
      ok(sats + ' sats: the invoice is paid from macadamia', !!t.paid && !t.paid.pending,
         t.paid ? t.ms + ' ms, fee ' + (t.paid.feeSats !== undefined ? t.paid.feeSats : '?') : t.err);
      const got = await claimInvoice(T.R, t.inv);
      ok(sats + ' sats: and the receiver’s invoice screen claims it', !!got, JSON.stringify(got));
      await catchUp(T.P);
      const o = await outcome(T, 'mac→minibits online, ' + sats, sats, { rail: 'lightning', ms: t.ms });
      verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.02) + 6 });
    }
  }

  title('6. macadamia to minibits, the payer offline — the receiver carries it home');
  {
    const T = await pair(MAC, MB, { rxFund: 0 });
    setOffline(T.P, true);
    const sats = 1000;
    const stuck = { mint: canon(MAC), have: pileAt(T.P, MAC), sats };
    const t0 = Date.now();
    const terms = await T.R.W.crossTerms(stuck, sats).catch((e) => ({ err: e.message }));
    ok('the receiver quotes the way home', terms && terms.net === sats && terms.ask > sats,
       terms.err || ('asking ' + terms.ask + ' so ' + terms.net + ' lands; ' + terms.feeSats + ' of fees'));
    if (terms && !terms.err) {
      const carryId = await T.R.W.carryBegin(terms);
      const text = T.R.W.paymentRequest(terms.ask, { purpose: 'carry:' + terms.from });
      const ask = T.P.W.decodeRequest(text) || {};
      const made = await T.P.W.payRequest(Object.assign({}, ask, { sats: terms.ask, unit: 'sat', viaTap: true, theirRoute: true, asks: true }),
        null, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ err: e.message }));
      if (made.made) { T.P.lastHash = made.made.hash; T.P.owed = Math.round(Number(made.made.over) || 0); }
      ok('the offline payer hands over the amount and the way home, at its own mint', !!made.made,
         made.made ? made.made.sats + ' sats left it' + (made.made.over ? ' (' + made.made.over + ' over, to come back)' : '') : made.err);
      await H.sleep(2500);
      const there = pileAt(T.R, MAC);
      const n = piecesAt(T.R, MAC);
      console.log('         link: ' + T.L.log.join(' | ') + (T.P.changes.length ? '; change ' + JSON.stringify(T.P.changes) : ''));
      console.log('         the plan allowed ' + (terms.plan.inPadSats || 0) + ' for spending the pieces at macadamia and ' + terms.plan.reserve
        + ' of route reserve; the receiver holds ' + there + ' there in ' + n + ' pieces, which cost ' + Math.ceil(n * 150 / 1000) + ' to spend');
      ok('the receiver has what it asked for at the payer\u2019s mint', there >= terms.ask, there + ' at macadamia, asked ' + terms.ask);
      // `carryHomeNow`: the wallet walks it home, says what became of it, and ends on its own mint
      const walked = await T.R.W.carryHome(carryId, terms.plan, () => {});
      const home = walked.state === 'home' ? { sats: walked.sats } : { err: walked.state + ': ' + (walked.why || '') };
      ok('and melts it home to minibits', home && home.sats >= sats, home && home.err ? home.err : JSON.stringify(home && { sats: home.sats }));
      ok('ending on its own mint, which is the mint it has saved', canon(T.R.W.mintUrl) === canon(MB), 'on ' + T.R.W.mintUrl);
      const ms = Date.now() - t0;
      if (home && !home.err) {
        await T.R.W.connect(MB);
        await catchUp(T.R);
        setOffline(T.P, false);
        await reopen(T.P);
        const o = await outcome(T, 'mac\u2192minibits payer offline, ' + sats, sats, { rail: 'ecash, carried home', ms });
        ok('the receiver ends up with the figure it asked for, at home', pileAt(T.R, MB) >= sats,
           pileAt(T.R, MB) + ' at minibits, ' + pileAt(T.R, MAC) + ' left at macadamia');
        verdict(o, sats, { maxCost: Math.ceil(sats * 0.03) + 12 });
      } else {
        /* The melt never left, so with real Lightning the invoice at home is
         * never paid. The fake backend settles every invoice by itself, so the
         * home mint must not be asked again here or it hands over money nobody
         * sent. What is true on a phone: the payment is the receiver's, at the
         * payer's mint, and stays there. */
        setOffline(T.P, false);
        await reopen(T.P);
        const now = await snapshotOf(T);
        T.start = now;
        R.table.push({ label: 'mac\u2192minibits payer offline, ' + sats, rail: 'ecash, NOT carried home', asked: sats,
          rxGot: there, payerPaid: made.made ? made.made.sats : 0, cost: (made.made ? made.made.sats : 0) - there, ms,
          calm: true, payerLimbo: 0, rxLimbo: 0, payerOff: 0, rxOff: 0,
          change: 'left at macadamia, nothing at minibits' });
        const bp = await books(T.P);
        ok('the payer\u2019s entries add up to what it holds', sum(bp.map((x) => Math.abs(x.off))) === 0, booksLine(bp));
      }
    }
  }

  title('7. macadamia to minibits, the receiver offline — the payer moves it there and pays from there');
  {
    const T = await pair(MAC, MB, { rxFund: 300 });
    setOffline(T.R, true);
    const sats = 500;
    const t0 = Date.now();
    const plan = await T.P.W.transferQuote(MAC, sats, { to: MB, land: true }).catch((e) => ({ err: e.message }));
    ok('the payer quotes the move to their mint', plan && plan.net === sats, plan.err || ('fee ' + plan.feeSats + ', moving ' + plan.moving));
    if (plan && !plan.err) {
      // `crossRun`: their mint is a visit, not saved as this phone's own
      const done = await T.P.W.moveRun(plan, () => {}, { visit: true }).catch((e) => ({ err: e.message }));
      ok('and makes it', done && done.sats >= sats, JSON.stringify(done && { sats: done.sats, err: done.err }));
      const t = await tapEcash(T, sats);
      ok('then pays the request there, locked to a receiver with no connection', !!t.made && !!t.made.lockedTo,
         t.made ? 'locked' : t.err);
      const ms = Date.now() - t0;
      await H.sleep(800);
      await T.P.W.connect(MAC);
      await catchUp(T.P);
      setOffline(T.R, false);
      await reopen(T.R);
      const o = await outcome(T, 'mac→minibits receiver offline, ' + sats, sats, { rail: 'moved, then ecash', ms });
      verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.03) + 12 });
    }
  }

  title('8. minibits to macadamia, both online — the other way, into the mint that charges');
  {
    const T = await pair(MB, MAC, { rxFund: 0 });
    const sats = 777;
    const t = await tapLightning(T, sats);
    ok('the invoice is paid from minibits', !!t.paid && !t.paid.pending, t.paid ? t.ms + ' ms' : t.err);
    const got = await claimInvoice(T.R, t.inv);
    ok('and claimed at macadamia', !!got, JSON.stringify(got));
    await catchUp(T.P);
    const o = await outcome(T, 'minibits→mac online, ' + sats, sats, { rail: 'lightning', ms: t.ms });
    verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.02) + 6 });
  }
}

/* ======================================================================= */
/* One fault, one payment, and then both apps opened again. */
async function faulted(label, setup, o) {
  const opts = o || {};
  title(label);
  const T = await pair(opts.payerMint || MAC, opts.rxMint || MAC, opts.pair || {});
  if (opts.payerOffline) setOffline(T.P, true);
  if (opts.rxOffline) setOffline(T.R, true);
  const sats = opts.sats || 300;
  setup(T);
  /* A payer killed part-way never hears back, and neither does this: the
   * promise it was waiting on died with the page. */
  const died = new Promise((done) => {
    const look = setInterval(() => {
      if (T.P.killedAt) { clearInterval(look); done({ err: 'the payer\u2019s app was killed (' + T.P.killedAt + ')', killed: true }); }
    }, 20);
    setTimeout(() => clearInterval(look), 120000).unref();
  });
  let t;
  if (opts.lightning) {
    const inv = await T.R.W.invoice(sats, '');
    T.inv = inv;
    const bolt = inv.invoice || inv.request || inv.bolt11 || inv.pr || inv.text;
    const t0 = Date.now();
    t = await Promise.race([died, T.P.W.pay(bolt).then((r) => ({ paid: r }), (e) => ({ err: (e && e.message) || String(e) }))]);
    t.ms = Date.now() - t0; t.inv = inv;
  } else {
    t = await Promise.race([died, tapEcash(T, sats)]);
  }
  // let whatever is in flight land at the mint, as it would with the app gone
  await H.sleep(opts.settle || 2500);
  const said = t.made ? (t.made.confirmed ? 'the payer was told it was taken' : 'the payer was told it was handed over and not confirmed')
    : t.paid ? (t.paid.pending ? 'the payer was told it is pending' : 'the payer was told it was paid')
    : (t.e && t.e.foxyRefused ? 'the payer was told THEY DID NOT TAKE IT: ' : 'the payer was told: ') + String(t.err || '').slice(0, 110);
  console.log('         ' + said + (T.P.killedAt ? ' [payer killed: ' + T.P.killedAt + ']' : '')
    + (T.R.killedAt ? ' [receiver killed: ' + T.R.killedAt + ']' : ''));
  console.log('         link: ' + (T.L.log.join(' | ') || 'nothing crossed'));
  return { T, t, sats };
}
/* Both apps opened again with a connection, and everything they do by
 * themselves done. */
async function bothBack(T, o) {
  const opts = o || {};
  setOffline(T.P, false); setOffline(T.R, false);
  await reopen(T.R, { at: opts.rxAt });
  await reopen(T.P);
  if (opts.inv) await claimInvoice(T.R, opts.inv, 20000);
  /* Pieces that went into a swap the mint never answered are held back until
   * the mint has been asked whether it made it, and not before the record is
   * twenty seconds old (15-receiving.js `recoverSwaps`). So: how much is held
   * on reopening, the wait a person would have, and the sweep again. */
  T.heldOnReopen = { payer: limbo(T.P).held, receiver: limbo(T.R).held };
  if (T.heldOnReopen.payer || T.heldOnReopen.receiver) {
    console.log('         held back on reopening: payer ' + T.heldOnReopen.payer + ', receiver ' + T.heldOnReopen.receiver
      + ' \u2014 waiting the twenty seconds the wallet waits');
    await H.sleep(23000);
    await catchUp(T.P); await catchUp(T.R);
  }
  await H.sleep(300);
  if (DEBUG) {
    for (const p of [T.P, T.R]) {
      console.log('         --- what the ' + p.name + '\u2019s wallet said, page by page');
      (p.pages || []).forEach((b, i) => {
        b.rec.lost.forEach((x) => console.log('         [' + i + '] LOST ANSWER ' + x.path + ' ' + x.status + ' ' + x.text));
        console.log('         [' + i + '] asked the mint: ' + JSON.stringify(b.rec.hits));
        const st = b.life.dead ? null : b.snapshot();
        if (st) console.log('         [' + i + '] written down: swaps ' + (st['foxy.cashu.swaps'] || '[]').length + ' chars, held '
          + (st['foxy.cashu.held'] || '{}').length + ' chars');
        b.rec.log.concat(b.rec.warn.map((x) => 'WARN ' + x)).filter((l) => /^WARN|swap|held|restor|token|change|melt|claim|request|locked|recover|pile|never/i.test(l))
          .slice(-18).forEach((l) => console.log('         [' + i + '] ' + String(l).slice(0, 230)));
      });
    }
  }
}

/* A token the payer still holds for a payment nobody took: whether the mint
 * says it is spent, and whether it can be taken back. */
async function payerToken(T) {
  const P = T.P;
  const rows = await P.W.transactions(50);
  const row = rows.find((e) => e.dir === 'out' && e.memo === 'ecash') || null;
  const tags = row && P.W.tagsFor ? P.W.tagsFor(row.hash) : null;
  const token = (tags && tags.token) || (row && row.token) || '';
  return { row, token };
}

async function faults() {
  /* ---- the payer's side -------------------------------------------------- */
  if (pickF('F1')) {
    const { T, t, sats } = await faulted('F1. same mint: the payer’s connection drops as its swap leaves — the mint never sees it',
      (T) => { T.P.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'before', once: false }); });
    ok('the payment is not made, and says so', !t.made, t.err);
    await bothBack(T);
    const o = await outcome(T, 'F1 payer: swap never left', sats, { rail: 'ecash' });
    ok('nobody’s money moved', o.row.rxGot === 0 && o.row.payerPaid === 0, 'payer down ' + o.row.payerPaid + ', receiver up ' + o.row.rxGot);
    verdict(o, sats, {});
  }
  if (pickF('F2')) {
    const { T, t, sats } = await faulted('F2. same mint: the mint makes the payer’s swap and the answer is lost',
      (T) => { T.P.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'after' }); });
    console.log('         ' + (t.made ? 'recovered by asking the mint for the outputs it signed, and sent' : 'not sent'));
    await bothBack(T);
    const o = await outcome(T, 'F2 payer: swap answer lost', sats, { rail: 'ecash' });
    ok('either it was paid in full or not at all', (o.row.rxGot === sats && !!t.made) || (o.row.rxGot === 0 && !t.made),
       'receiver up ' + o.row.rxGot + ', payer told ' + (t.made ? 'paid' : 'not paid'));
    verdict(o, sats, { maxCost: 6 });
  }
  for (const variant of [
    { id: 'F3', pool: true, what: 'paid from small change, so the swap makes the payment and nothing else' },
    { id: 'F3b', pool: false, what: 'paid from one large piece, so the swap makes the payment and the change' },
  ]) {
    if (!pickF(variant.id)) continue;
    const { T, t, sats } = await faulted(variant.id + '. same mint: the payer is killed with its swap on the way — the mint makes it, nobody hears ('
      + variant.what + ')',
      (T) => { T.P.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'after', kill: true, label: 'mid swap' }); },
      { settle: 1500, pair: { pool: variant.pool } });
    void t;
    const lost = (T.P.pages[0].rec.lost[0] || {});
    ok('the mint did make the swap', lost.status === 200 && /signatures/.test(lost.text || ''), lost.status + ' ' + String(lost.text || '').slice(0, 40));
    await bothBack(T);
    const asked = Object.assign({}, T.P.b.rec.hits);
    const o = await outcome(T, variant.id + ' payer killed mid swap', sats, { rail: 'ecash' });
    const tok = await payerToken(T);
    console.log('         reopened, the payer asked the mint: ' + JSON.stringify(asked));
    console.log('         the mint says ' + o.row.ghostP + ' sats the payer was showing are spent; payer really down '
      + o.row.payerPaid + ', receiver up ' + o.row.rxGot + '; a token to hand over: ' + !!tok.token);
    ok('the payment is not lost: the receiver has it, or the payer has it back, or holds the token to hand over',
       o.row.rxGot === sats || o.row.payerPaid <= 6 || !!tok.token,
       'the payer is down ' + o.row.payerPaid + ', the receiver is up ' + o.row.rxGot + ', and there is ' + (tok.token ? 'a' : 'no') + ' token');
    if (o.row.rxGot === 0 && tok.token) {
      const took = await T.R.W.receiveToken(tok.token).then((r) => r.sats, (e) => 'refused: ' + e.message);
      ok('and the token on the payer’s entry is one the receiver can take', took > 0, String(took));
      const o2 = await outcome(T, variant.id + ': token scanned later', sats, { rail: 'ecash' });
      verdict(o2, sats, {});
    } else {
      verdict(o, sats, {});
    }
  }
  if (pickF('F4')) {
    const { T, t, sats } = await faulted('F4. same mint: the link drops after the payer made the token, before it crossed',
      (T) => { T.L.cutBeforeM5 = true; });
    ok('the payer is told it did not arrive', !t.made, t.err);
    const tok = await payerToken(T);
    ok('and still has the token, on the payment’s own entry', !!tok.token,
       JSON.stringify(tok.row && { sats: tok.row.sats, state: tok.row.state, handed: tok.row.handed }));
    if (tok.token) {
      const took = await T.R.W.receiveToken(tok.token).then((r) => r.sats, (e) => 'refused: ' + e.message);
      ok('which the receiver can take by scanning it', took === sats, String(took));
    }
    await bothBack(T);
    const o = await outcome(T, 'F4 link down before the payment crossed', sats, { rail: 'ecash' });
    verdict(o, sats, { rxGot: sats, maxCost: 6 });
  }
  if (pickF('F5')) {
    const { T, t, sats } = await faulted('F5. same mint: the receiver takes it and the link drops before the payer hears',
      (T) => { T.L.cutBeforeM6 = true; });
    ok('the payer is told it did not arrive, although it did', !t.made, t.err);
    await bothBack(T);
    const o = await outcome(T, 'F5 answer lost on the link', sats, { rail: 'ecash' });
    const tok = await payerToken(T);
    ok('the receiver has it', o.row.rxGot === sats, 'up by ' + o.row.rxGot);
    ok('and the payer’s entry ends as paid, not as a token still to hand over', !!tok.row && tok.row.state !== 'failed',
       JSON.stringify(tok.row && { sats: tok.row.sats, state: tok.row.state, settled: tok.row.settled }));
    verdict(o, sats, { rxGot: sats, maxCost: 6 });
  }

  /* ---- the receiver's side ----------------------------------------------- */
  if (pickF('F6')) {
    const { T, t, sats } = await faulted('F6. same mint: the receiver’s connection drops as it swaps the payment in',
      (T) => { T.R.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'before', once: false }); });
    ok('the payer is told it was paid: locked ecash is the receiver’s the moment it arrives', !!t.made, t.err);
    const mid = limbo(T.R);
    ok('and the receiver holds it, written down, until it can swap', mid.unclaimed >= sats, JSON.stringify(mid));
    await bothBack(T);
    const o = await outcome(T, 'F6 receiver: swap never left', sats, { rail: 'ecash' });
    verdict(o, sats, { rxGot: sats, maxCost: 6 });
  }
  if (pickF('F7')) {
    const { T, t, sats } = await faulted('F7. same mint: the mint swaps the payment in for the receiver and the answer is lost',
      (T) => { T.R.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'after' }); });
    ok('the payer is told it was paid', !!t.made, t.err);
    await bothBack(T);
    const o = await outcome(T, 'F7 receiver: swap answer lost', sats, { rail: 'ecash' });
    verdict(o, sats, { rxGot: sats, maxCost: 6 });
  }
  if (pickF('F8')) {
    const { T, t, sats } = await faulted('F8. same mint: the receiver is killed the moment the payment arrives, before it swaps',
      (T) => { T.R.faults.push({ path: /\/v1\/(swap|checkstate)$/, method: 'POST', fate: 'before', kill: true, label: 'on arrival' }); });
    console.log('         ' + (t.made ? 'the payer heard yes before the receiver died' : 'the payer heard nothing'));
    await bothBack(T);
    const o = await outcome(T, 'F8 receiver killed on arrival', sats, { rail: 'ecash' });
    verdict(o, sats, { rxGot: sats, maxCost: 6 });
  }
  if (pickF('F9')) {
    const { T, t, sats } = await faulted('F9. same mint: the receiver is killed with its swap on the way — the mint makes it, nobody hears',
      (T) => { T.R.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'after', kill: true, label: 'mid swap' }); });
    void t;
    await bothBack(T);
    const o = await outcome(T, 'F9 receiver killed mid swap', sats, { rail: 'ecash' });
    verdict(o, sats, { rxGot: sats, maxCost: 6 });
  }
  if (pickF('F10')) {
    const { T, t, sats } = await faulted('F10. same mint, payer offline: plain ecash arrives and the receiver’s swap gets no answer',
      (T) => { T.R.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'before', once: false }); },
      { payerOffline: true, sats: 100 });
    const said = T.R.answers[T.R.answers.length - 1] || {};
    console.log('         the receiver answered ' + said.status + ': ' + String(said.text || '').slice(0, 140));
    const kept = limbo(T.R).unclaimed;
    ok('nobody knows yet whether the mint took it, so the receiver keeps what it wrote down and says so (409)',
       said.status === 409 && kept >= sats, 'answered ' + said.status + ', ' + kept + ' written down');
    ok('and the payer is told it was handed over and not confirmed, not that it failed',
       !!t.made && t.made.confirmed === false, t.made ? 'confirmed: ' + t.made.confirmed : String(t.err));
    await bothBack(T);
    const o = await outcome(T, 'F10 plain ecash, the receiver’s swap unanswered', sats, { rail: 'ecash, plain' });
    const tok = await payerToken(T);
    console.log('         in the end: payer down ' + o.row.payerPaid + ', receiver up ' + o.row.rxGot + '; the payer’s entry '
      + JSON.stringify(tok.row && { sats: tok.row.sats, state: tok.row.state, settled: tok.row.settled }));
    ok('it ends one way: the receiver has it and the payer’s entry is a payment made',
       o.row.rxGot === sats && !!tok.row && tok.row.state !== 'failed', 'receiver up ' + o.row.rxGot);
    verdict(o, sats, {});
  }
  if (pickF('F10c')) {
    const { T, t, sats } = await faulted('F10c. same mint, payer offline: plain ecash arrives and the receiver cannot reach the mint at all',
      (T) => { T.R.faults.push({ path: /./, fate: 'before', once: false }); },
      { payerOffline: true, sats: 100 });
    const said = T.R.answers[T.R.answers.length - 1] || {};
    const kept = limbo(T.R).unclaimed;
    console.log('         the receiver answered ' + said.status + ': ' + String(said.text || '').slice(0, 140) + '; written down: ' + kept);
    ok('what the receiver says and what it keeps agree: a no with nothing kept, or a not-yet with the payment written down',
       (said.status === 422 && kept === 0) || (said.status === 409 && kept >= sats),
       'answered ' + said.status + ', ' + kept + ' written down');
    ok('and the payer is told the same thing', said.status === 422 ? (!t.made && !!(t.e && t.e.foxyRefused)) : (!!t.made && t.made.confirmed === false),
       t.made ? 'handed over, confirmed ' + t.made.confirmed : String(t.err).slice(0, 90));
    await bothBack(T);
    const o = await outcome(T, 'F10c plain ecash, the receiver cannot reach the mint', sats, { rail: 'ecash, plain' });
    ok('a payer told no is not paid from; one told not-yet ends paid',
       said.status === 422 ? o.row.rxGot === 0 : o.row.rxGot === sats, 'receiver up ' + o.row.rxGot + ', payer down ' + o.row.payerPaid);
    verdict(o, sats, {});
  }
  if (pickF('F10b')) {
    const { T, t, sats } = await faulted('F10b. same mint, payer offline: plain ecash arrives and the mint refuses the receiver’s swap',
      (T) => { T.R.faults.push({ path: /\/v1\/swap$/, method: 'POST', fate: 'refuse', once: false }); },
      { payerOffline: true, sats: 100 });
    const said = T.R.answers[T.R.answers.length - 1] || {};
    console.log('         the receiver answered ' + said.status + ': ' + String(said.text || '').slice(0, 140));
    ok('the receiver says no (422) and keeps nothing', said.status === 422 && limbo(T.R).unclaimed === 0,
       'answered ' + said.status + ', ' + limbo(T.R).unclaimed + ' written down');
    ok('the payer is told they did not take it', !t.made && !!(t.e && t.e.foxyRefused), String(t.err).slice(0, 100));
    await bothBack(T);
    const tok = await payerToken(T);
    /* MONEY.md §15: nothing came back locked
     * to the payer, so the pieces went into its wallet again flagged at
     * risk, and were swapped for fresh ones on its first connection. There
     * is no token left on the entry to take back by hand. */
    const rowsP = await T.P.W.transactions(50);
    const refusedRow = rowsP.find((e) => e.dir === 'out' && /refused/.test(String(e.memo || ''))) || null;
    const safeNow = !!refusedRow && refusedRow.takenBack === true && refusedRow.highRisk === false && !(T.P.W.atRisk() || []).length;
    ok('and that was true: the ecash went back into the payer’s wallet at risk, and was made safe by itself once it had a route',
       !!(t.e && t.e.foxyAtRisk) && !tok.token && safeNow,
       refusedRow ? 'entry: ' + refusedRow.state + ', taken back ' + refusedRow.takenBack + '; still at risk: ' + (T.P.W.atRisk() || []).length : 'no refused entry');
    await catchUp(T.P);
    const o = await outcome(T, 'F10b plain ecash, the receiver’s swap refused', sats, { rail: 'ecash, plain' });
    ok('the receiver has nothing of it, and the payer is out only the fee for taking it back',
       o.row.rxGot === 0 && o.row.payerPaid >= 0 && o.row.payerPaid <= 3, 'payer down ' + o.row.payerPaid + ', receiver up ' + o.row.rxGot);
    verdict(o, sats, {});
  }

  /* ---- across mints ------------------------------------------------------ */
  if (pickF('F10d')) {
    title('F10d. carried home: the payer’s mint cannot be reached from the receiver when the plain ecash arrives');
    const T = await pair(MAC, MB, { rxFund: 0 });
    setOffline(T.P, true);
    const sats = 1000;
    const terms = await T.R.W.crossTerms({ mint: canon(MAC), have: pileAt(T.P, MAC), sats }, sats);
    const carryId = await T.R.W.carryBegin(terms);
    const text = T.R.W.paymentRequest(terms.ask, { purpose: 'carry:' + terms.from });
    const ask = T.P.W.decodeRequest(text) || {};
    T.R.faults.push({ mint: MAC, path: /\/v1\/(swap|checkstate)$/, method: 'POST', fate: 'before', once: false });
    const t = await T.P.W.payRequest(Object.assign({}, ask, { sats: terms.ask, unit: 'sat', viaTap: true, theirRoute: true, asks: true }),
      null, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ e, err: (e && e.message) || String(e) }));
    await H.sleep(800);
    const said = T.R.answers[T.R.answers.length - 1] || {};
    const kept = limbo(T.R).unclaimed;
    console.log('         the receiver answered ' + said.status + ': ' + String(said.text || '').slice(0, 120) + '; written down: ' + kept);
    ok('what the receiver says and what it keeps agree', (said.status === 422 && kept === 0) || (said.status === 409 && kept >= sats),
       'answered ' + said.status + ', ' + kept + ' written down');
    ok('and the payer is told the same thing', said.status === 422 ? (!t.made && !!(t.e && t.e.foxyRefused)) : (!!t.made && t.made.confirmed === false),
       t.made ? 'handed over, confirmed ' + t.made.confirmed : String(t.err).slice(0, 90));
    if (DEBUG) {
      T.R.b.rec.log.concat(T.R.b.rec.warn.map((x) => 'WARN ' + x)).filter((l) => /request|claim|swap|restore|kept|unclaimed|offline|taken|payer/i.test(l))
        .slice(-14).forEach((l) => console.log('         [rx] ' + String(l).slice(0, 260)));
      console.log('         [rx] swaps on file: ' + String(T.R.b.snapshot()['foxy.cashu.swaps'] || '').slice(0, 300));
    }
  }
  if (pickF('F11')) {
    const { T, t, sats } = await faulted('F11. across mints: the payer’s connection drops as the melt leaves',
      (T) => { T.P.faults.push({ path: /\/v1\/melt\/bolt11$/, method: 'POST', fate: 'before', once: false }); },
      { rxMint: MB, pair: { rxFund: 0 }, lightning: true });
    ok('the payer is not told it was paid', !t.paid || !!t.paid.pending, t.err || JSON.stringify(t.paid && { pending: t.paid.pending }));
    /* The payer's side only. The fake Lightning backend settles every
     * invoice by itself a second after it is made, paid or not, so what the
     * receiver's mint would hand over here is money nobody sent. */
    setOffline(T.P, false);
    await reopen(T.P);
    await H.sleep(1500); await catchUp(T.P);
    if (limbo(T.P).held) { await H.sleep(23000); await catchUp(T.P); }
    const bp = await books(T.P);
    const ghost = await phantom(T.P);
    const down = T.start.payer.mac - pileAt(T.P, MAC);
    const lp = limbo(T.P);
    console.log('         the payer is down ' + down + ' for a payment that never left; ' + JSON.stringify(lp));
    R.table.push({ label: 'F11 payer: melt never left', rail: 'lightning', asked: sats, rxGot: 0, payerPaid: down, cost: down,
      calm: calm(lp), payerLimbo: limboSats(lp), rxLimbo: 0, payerOff: sum(bp.map((x) => Math.abs(x.off))), rxOff: 0, ghostP: ghost, ghostR: 0 });
    ok('nothing is held back for it any more', calm(lp), JSON.stringify(lp));
    ok('what the attempt cost — the swap that split the pile for it — is on the payer’s entries',
       sum(bp.map((x) => Math.abs(x.off))) === 0, 'down ' + down + '; ' + booksLine(bp));
    ok('the payer was not showing ecash the mint says is spent', !ghost, ghost + ' sats');
  }
  if (pickF('F12')) {
    const { T, t, sats } = await faulted('F12. across mints: the mint pays the invoice and the payer never hears',
      (T) => { T.P.faults.push({ path: /\/v1\/melt\/bolt11$/, method: 'POST', fate: 'after' }); },
      { rxMint: MB, pair: { rxFund: 0 }, lightning: true, settle: 4000 });
    void t;
    await bothBack(T, { inv: T.inv });
    await catchUp(T.P);
    const o = await outcome(T, 'F12 payer: melt answer lost', sats, { rail: 'lightning' });
    verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.02) + 8 });
  }
  if (pickF('F13')) {
    const { T, t, sats } = await faulted('F13. across mints: the payer is killed with the melt on its way',
      (T) => { T.P.faults.push({ path: /\/v1\/melt\/bolt11$/, method: 'POST', fate: 'after', kill: true, label: 'mid melt' }); },
      { rxMint: MB, pair: { rxFund: 0 }, lightning: true, settle: 4000 });
    void t;
    await bothBack(T, { inv: T.inv });
    await catchUp(T.P);
    const o = await outcome(T, 'F13 payer killed mid melt', sats, { rail: 'lightning' });
    verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.02) + 8 });
  }
  if (pickF('F14')) {
    title('F14. across mints: the receiver is killed after the invoice is paid, before it claims');
    const T = await pair(MAC, MB, { rxFund: 0 });
    const sats = 300;
    const t = await tapLightning(T, sats);
    ok('the invoice is paid', !!t.paid, t.err);
    kill(T.R, 'before the claim');
    await bothBack(T);
    await H.sleep(1500); await catchUp(T.R);
    const o = await outcome(T, 'F14 receiver killed before the claim', sats, { rail: 'lightning' });
    verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.02) + 8 });
  }
  if (pickF('F15')) {
    title('F15. across mints: the receiver’s claim reaches the mint and the answer is lost, then it is killed');
    const T = await pair(MAC, MB, { rxFund: 0 });
    const sats = 300;
    T.R.faults.push({ path: /\/v1\/mint\/bolt11$/, method: 'POST', fate: 'after', kill: true, label: 'mid claim' });
    const t = await tapLightning(T, sats);
    ok('the invoice is paid', !!t.paid, t.err);
    T.R.W.claim(t.inv.hash).catch(() => {});
    await H.sleep(3000);
    await bothBack(T);
    await H.sleep(1000); await catchUp(T.R);
    const o = await outcome(T, 'F15 receiver killed mid claim', sats, { rail: 'lightning' });
    verdict(o, sats, { rxGot: sats, maxCost: Math.ceil(sats * 0.02) + 8 });
  }
  if (pickF('F16')) {
    title('F16. carried home: the receiver is killed after taking the payment at the payer’s mint, before the melt home');
    const T = await pair(MAC, MB, { rxFund: 0 });
    setOffline(T.P, true);
    const sats = 1000;
    const terms = await T.R.W.crossTerms({ mint: canon(MAC), have: pileAt(T.P, MAC), sats }, sats);
    const carryId = await T.R.W.carryBegin(terms);
    const text = T.R.W.paymentRequest(terms.ask, { purpose: 'carry:' + terms.from });
    const ask = T.P.W.decodeRequest(text) || {};
    const made = await T.P.W.payRequest(Object.assign({}, ask, { sats: terms.ask, unit: 'sat', viaTap: true, theirRoute: true, asks: true }),
      null, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ err: e.message }));
    ok('the payer hands it over', !!made.made, made.err);
    await H.sleep(2500);
    kill(T.R, 'before the melt home');
    await bothBack(T);
    const o = await outcome(T, 'F16 receiver killed before the melt home', sats, { rail: 'ecash, carried home' });
    console.log('         the receiver holds ' + pileAt(T.R, MAC) + ' at macadamia and ' + pileAt(T.R, MB) + ' at minibits');
    ok('the money is the receiver’s: nothing is stranded', o.row.rxGot >= sats, 'up by ' + o.row.rxGot);
    ok('and opened again, it was brought home without anyone doing anything', pileAt(T.R, MB) >= sats, pileAt(T.R, MB) + ' at minibits');
    verdict(o, sats, {});
  }
  if (pickF('F17')) {
    title('F17. carried home: the melt home reaches the mint, the answer is lost and the receiver is killed');
    const T = await pair(MAC, MB, { rxFund: 0 });
    setOffline(T.P, true);
    const sats = 1000;
    const terms = await T.R.W.crossTerms({ mint: canon(MAC), have: pileAt(T.P, MAC), sats }, sats);
    const carryId = await T.R.W.carryBegin(terms);
    const text = T.R.W.paymentRequest(terms.ask, { purpose: 'carry:' + terms.from });
    const ask = T.P.W.decodeRequest(text) || {};
    const made = await T.P.W.payRequest(Object.assign({}, ask, { sats: terms.ask, unit: 'sat', viaTap: true, theirRoute: true, asks: true }),
      null, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ err: e.message }));
    ok('the payer hands it over', !!made.made, made.err);
    await H.sleep(2500);
    T.R.faults.push({ path: /\/v1\/melt\/bolt11$/, method: 'POST', fate: 'after', kill: true, label: 'mid melt home' });
    T.R.W.carryHome(carryId, terms.plan, () => {}).catch(() => {});
    await H.sleep(5000);
    ok('the receiver died mid melt', !!T.R.killedAt, String(T.R.killedAt));
    await bothBack(T);
    await H.sleep(1500); await catchUp(T.R);
    const atHome = limbo(T.R);
    console.log('         opened again at its own mint: ' + pileAt(T.R, MB) + ' at minibits, and still waiting on ' + JSON.stringify(atHome));
    // the melt was made at the payer's mint, and it is asked about when the phone is next there
    await T.R.W.connect(MAC, null, null, { remember: true });
    await catchUp(T.R);
    console.log('         after visiting macadamia: waiting on ' + JSON.stringify(limbo(T.R)));
    await T.R.W.connect(MB, null, null, { remember: true });
    ok('the melt settles without the phone having to visit the payer’s mint', !atHome.melts, JSON.stringify(atHome));
    const o = await outcome(T, 'F17 receiver killed mid melt home', sats, { rail: 'ecash, carried home' });
    console.log('         the receiver holds ' + pileAt(T.R, MAC) + ' at macadamia and ' + pileAt(T.R, MB) + ' at minibits');
    ok('the payment landed at home', pileAt(T.R, MB) >= sats, pileAt(T.R, MB) + ' at minibits');
    verdict(o, sats, {});
  }
}

async function run() {
  console.log('macadamia-like ' + MAC + '   minibits-like ' + MB);
  if (want('same')) await sameMint();
  if (want('cross')) await crossMint();
  if (want('faults')) await faults();

  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  console.log('\n' + pad('scenario', 46) + pad('rail', 22) + pad('asked', 7) + pad('rx got', 8) + pad('payer', 7) + pad('cost', 6)
    + pad('ms', 7) + 'left over / books');
  R.table.forEach((r) => {
    console.log(pad(r.label, 46) + pad(r.rail || '', 22) + pad(r.asked, 7) + pad(r.rxGot, 8) + pad(r.payerPaid, 7) + pad(r.cost, 6)
      + pad(r.ms === undefined ? '' : r.ms, 7)
      + (r.calm && !r.payerLimbo && !r.rxLimbo ? 'clean' : 'IN BETWEEN payer ' + r.payerLimbo + ' rx ' + r.rxLimbo)
      + (r.payerOff || r.rxOff ? ', BOOKS OFF payer ' + r.payerOff + ' rx ' + r.rxOff : ', books add up')
      + (r.ghostP || r.ghostR ? ', SPENT ECASH SHOWN AS HELD payer ' + (r.ghostP || 0) + ' rx ' + (r.ghostR || 0) : '')
      + (r.change ? ', change: ' + r.change : ''));
  });
  if (R.failed.length) { console.log('\nfailed:'); R.failed.forEach((f) => console.log('  ' + f)); }
  console.log('\n' + (R.fail ? R.fail + ' tap-scenario check(s) failed, ' + R.pass + ' passed' : 'all ' + R.pass + ' tap-scenario checks pass'));
  process.exit(R.fail ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
