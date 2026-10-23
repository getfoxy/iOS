'use strict';
/* convert-on-return.js — sats paid to a dollars wallet, swapped into dollars
 * once they are in the pile.
 *
 *     node tests/convert-on-return.js
 *
 * Someone who chose to hold dollars can be paid in sats, by a payer who has
 * no dollars or is offline. The sats are this phone's the moment they land
 * (on their own row, in the pile once claimed); what is new is that Foxy then
 * swaps them into dollars at the mint, by the ordinary swap with its two
 * rows, and never twice, never sats that did not arrive, never during
 * put-away, and never at a rate a person would turn down.
 *
 * The wallet as it ships (loadReal: the bundled cashu-ts, the phone's seed),
 * a fake mint with sat and usd keysets and P2PK, and a stand-in for the app's
 * `convertOnReturn` with the guards the app keeps (put away, money moving, a
 * tap under way, no route). Every case ends with the books of every page
 * closing in both units (harness `books`, judged again at exit) and the
 * history card's two audits (lifted from the build) off by 0:
 *
 *   1  claimed on return, converted once: two swap rows, the record done, the
 *      payment's row saying so, and a second go doing nothing
 *   2  put away: nothing; on wake it converts
 *   3  hold both or bitcoin at arrival: no record; hold changed before return:
 *      kept, no swap
 *   4  a one-unit mint: no record; a payment claimed while visiting another
 *      mint is not converted there
 *   5  the mint leaves the payment PENDING: swapping, held, the card; the next
 *      sweeps finish it and the record settles done with no second swap
 *   6  the mint refuses: sats stay, no new rows, one word; the next launch
 *      tries again; after three it is failed for good
 *   7  too little after the fee: kept, no rows
 *   8  a rate more than 2% from the market: not run
 *   9  restarts: between claim and conversion, after a crash while quoting,
 *      with the swap still with the mint, and with the sats paid out and no
 *      dollars on record
 *   10 owed and then spent elsewhere: kept, never converted, the other sats
 *      whole
 *   11 a swap already with the mint: it waits
 *   12 a payment swapped in as it arrived (a payer offline, this phone
 *      online) is converted at once, with the terms on its row
 *   13 a mint with input fees: the swap pays its own fee out of the payment,
 *      never out of the person's other sats, and works with no other sats
 *   14 sats spent between claim and swap come out of the payment first: the
 *      person's own are never swapped; two payments both convert
 *   15 a plain payment whose claim is cut off is owed, claimed later, and
 *      swapped, with what was asked on its row
 *   16 a claim that landed before the page went is found and swapped once
 *   17 no current price: nothing tried and no try spent until there is one
 *   18 records that do not add up swap no more than they were kept as, or
 *      nothing
 *   19 a fee over a tenth: kept as too little, not tried again
 *   20 for sats, every answer of the rule is the one it always was; for dollars, its mirror
 *   21 the mirror: dollars paid to a phone that holds bitcoin, swapped into sats once
 *   22 held by the mint, then finished by the sweeps with no second swap
 *   23 refused (tried again later), a phone that holds both by then (kept), too little (kept)
 *   24 the person's own dollars are never swapped
 *   25 a dollar claim never moves a record of sats, nor a sat claim one of dollars
 *   26 the dollars paid out and no sats on record after a restart: failed, never again */
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const { loadReal, fakeMint, nativePhone, books, noBooks, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const OTHER = 'https://other.test';
const WORDS_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const HOUR = 3600 * 1000;

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) { if (fn()) return true; await wait(5); }
  return !!fn();
};
const read = (c, key, dflt) => { try { const v = JSON.parse(c.storage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; } };
const rows = (c) => read(c, 'foxy.cashu.log', []);
const recs = (c) => read(c, 'foxy.cashu.convert', []);
const recOf = (c, id) => recs(c).find((r) => r.id === id) || null;
const rowOf = (c, id) => rows(c).find((r) => r.hash === 'req-' + id) || {};
const swapRows = (c) => rows(c).filter((r) => r.swap);
const store = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const canon = (u) => String(u || '').replace(/\/+$/, '');

/* The history card's audits as the app does them (16-history-lists.js),
 * lifted out of build/foxy-app.js and run on a page's own wallet, as
 * tests/usd-tap.js has them. */
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function appMethod(sig) {
  const at = appSrc.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = appSrc.indexOf('{', at), depth = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appSrc.slice(at + 3, i + 1);
}
const auditMethods = new Function('return {' + ['histAudit() {', 'histAuditUsd() {', 'txTotalOut(t) {', 'arrivingBucket(unit) {',
  'arrivingNow() {', 'heldPill() {'].map(appMethod).join(',') + '}')();
async function appAudit(c, mint) {
  const W = c.W;
  const here = canon(mint || MINT);
  const items = rows(c).filter((t) => !t.mint || canon(t.mint) === here).map((t) => ({
    dir: t.dir, sats: t.sats, fee: t.feeSats, hash: t.hash, unit: t.unit, amount: t.amount, feeAmount: t.feeAmount,
    grossSats: t.grossSats, changeSats: t.changeSats, changeState: t.changeState, changeAmount: t.changeAmount,
    pending: !t.settled, failed: t.state === 'failed', atRisk: !!t.trusted && !t.settled && t.state !== 'failed',
  }));
  const a = Object.assign({
    state: { balSats: await W.balanceSats(), balUsdCents: W.balanceOf('usd'), history: [{ items }], historyComplete: true, fresh: false },
    twoUnitsOn: () => true, stageMoney: (n) => '₿ ' + n, unitFigure: (n, u) => (u === 'usd' ? '$ ' + (n / 100).toFixed(2) : '₿ ' + n),
    recoveringSats: () => Math.round(Number(W.recoveringSats()) || 0), topUpFeeSats: () => Math.round(Number(W.topUpFeeSats()) || 0),
  }, auditMethods);
  const had = global.window;
  global.window = { FoxyWallet: W };
  const quiet = console.log;
  console.log = () => {};
  try { return { sat: a.histAudit(), usd: a.histAuditUsd(), pill: a.heldPill() }; }
  finally { console.log = quiet; global.window = had; }
}

/* The books of a page, per mint and unit, against where they started, and
 * the app's two audits: every case ends on these. */
function booksMove(c, from) {
  const now = books(c);
  const out = {};
  new Set([...Object.keys(now), ...Object.keys(from || {})]).forEach((k) => {
    const a = now[k] || { off: 0 }, b = (from || {})[k] || { off: 0 };
    out[k] = a.off - b.off;
  });
  return out;
}
async function booksShut(c, name, from, mint) {
  const move = booksMove(c, from || {});
  const audit = await appAudit(c, mint);
  ok(Object.values(move).every((n) => n === 0) && audit.sat.off === 0 && audit.usd.off === 0,
    name + ': the books close in both units, and both audits are off by 0',
    JSON.stringify({ move, sat: audit.sat.off, usd: audit.usd.off }));
}

/* A page on one mint or more (by origin). `o.mints` shares another page's
 * mints; `o.phone` its counters and lock keys (a relaunch); `o.storage` what
 * it starts with. `ctx.deaf` is the suite's pretend airplane mode, and
 * `ctx.lose` (a RegExp of a path) loses the next such answer after the mint
 * has acted on it. */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  if (opts.phone) { phone.counters = opts.phone.counters; phone.locks = opts.phone.locks; }
  let mints = opts.mints || null;
  let ctx = null;
  const made = {};
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      switch (m.action) {
        case 'mintRequest': {
          if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
          const mint = mints[canon(new URL(m.url).origin)];
          if (!mint) return reply(w, m.id, null, 'no such mint in this test');
          const url = String(m.url || '');
          if (ctx.lose && ctx.lose.test(url)) { ctx.lose = null; mint.handle(m); return reply(w, m.id, null, 'The network connection was lost.'); }
          return reply(w, m.id, mint.handle(m));
        }
        case 'inboxAnswer':
          ctx.answers.push({ answer: m.answer, status: [200, 409, 422].indexOf(Number(m.status)) >= 0 ? Number(m.status) : 422,
                             text: String(m.text || '') });
          return reply(w, m.id, 'ok');
        case 'tapChangeDue': case 'tapAsking': case 'tapChangeKept':
          return reply(w, m.id, 'ok');
        default: {
          const got = phone.answer(w, m);
          if (!got) return reply(w, m.id, null, 'not in this test');
          return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
        }
      }
    },
    before: (w) => {
      phone.attach(w);
      if (!mints) {
        made.mintOpts = Object.assign({ units: ['sat', 'usd'], p2pk: true }, opts.mintOpts || {});
        mints = { [MINT]: fakeMint(w, made.mintOpts) };
        if (opts.other) mints[OTHER] = fakeMint(w, Object.assign({ units: ['sat', 'usd'], p2pk: true, fill: 9, quoteFrom: 5000 }, opts.other));
      }
    },
  });
  ctx.mints = mints;
  ctx.deaf = false;
  ctx.lose = null;
  ctx.answers = [];
  ctx.phone = phone;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._swapPollMs = 5;
  ctx.W._swapClaimWaitMs = 200;
  /* A current bitcoin price at the mint's own rate, as a phone that is online
   * has: the yardstick a swap's rate is judged by (`convertOne` waits without
   * one). `o.noPrice` leaves it out. */
  if (!opts.noPrice) { ctx.W._rate = 76900; ctx.W._rateAt = Date.now(); }
  return ctx;
}
const goOffline = (c) => {
  c.deaf = true;
  c.W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });
  c.W.setOffline(true);
};
const goOnline = (c) => {
  c.deaf = false;
  c.W.setOffline(false);
  c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
};
async function connected(o) {
  const c = page(o);
  await c.W.connect((o && o.at) || MINT, null, null, { remember: true });
  return c;
}
async function fund(c, amount, unit) {
  const inv = await c.W.invoice(amount, '', { unit: unit || 'sat' });
  return c.W.claim(inv.hash);
}

/* The app's `convertOnReturn` (26i-swap.js), stood in with the guards the
 * app keeps, and the words it says: the toast as a swap starts, the card for
 * one still with the mint, and the word for one that did not go, once per
 * payment. It asks again once while a payment in the pile has not been tried. */
function appOn(c) {
  const W = c.W;
  const app = { _putAway: false, _swapRun: null, _converting: null, _tapTalking: false,
                state: { screen: 'home', tapArmed: false }, toasts: [], cards: [], results: [], failedSaid: {}, calls: 0 };
  app.moneyBusy = () => !!app._swapRun;
  app.convertOnReturn = function () {
    app.calls += 1;
    if (c.deaf || !W.connected || W.fromCache()) return null;
    if (app._putAway || app.moneyBusy() || app._tapTalking || app.state.tapArmed || app._converting) return null;
    const run = W.convertOne((stage, rec) => {
      if (stage === 'start') app.toasts.push('You chose dollars, so Foxy is swapping the ₿ ' + rec.got + ' you were paid into dollars.');
    });
    app._swapRun = app._converting = run;
    return run.then((r) => {
      app._swapRun = app._converting = null;
      app.results.push(r);
      if (r && r.outcome === 'pending') {
        if (app.state.screen === 'home') app.cards.push({ kind: 'swapPending', title: 'SWAP STILL GOING THROUGH' });
        else app.toasts.push('The swap into dollars is still going through. Foxy finishes it by itself.');
      }
      if (r && r.outcome === 'failed' && !app.failedSaid[r.id]) {
        app.failedSaid[r.id] = true;
        app.toasts.push('Foxy could not swap the ₿ ' + r.rec.got + ' into dollars just now. It stays as bitcoin.');
      }
      if (W.convertsOwed().some((x) => x.state === 'claimed' && !x.tried)) setTimeout(() => app.convertOnReturn(), 20);
      return r;
    });
  };
  W.onConvertDue(() => app.convertOnReturn());
  return app;
}

/* A receiver holding dollars and a payer holding sats, at one mint. The
 * receiver has seen the mint (its keys on file) and primed its lock keys. */
async function pair(o) {
  const opts = o || {};
  const rx = await connected({ mintOpts: opts.mintOpts, other: opts.other });
  await rx.W.primeLocks();
  if (opts.rxSat) await fund(rx, opts.rxSat, 'sat');
  rx.W.setWalletChoice({ hold: opts.hold || 'dollars' });
  const payer = await connected({ mints: rx.mints, words: WORDS_B });
  await fund(payer, opts.payerSat || 30000, 'sat');
  return { rx, payer };
}

/* A payment of `sats` to a sat request of the receiver's, as it comes over a
 * tap: locked to the request's key when the receiver is offline (held), or
 * plain when it is online. `terms` are noted on the request first, as the
 * price talk does. Resolves the request id once the receiver has answered. */
let answerN = 0;
async function pay(t, sats, o) {
  const opts = o || {};
  // `kept`: the person picked bitcoin on CURRENCY for this receive (12-receive.js `recvPicked`)
  const text = t.rx.W.paymentRequest(sats, { unit: 'sat', purpose: 'receive', kept: opts.kept === true });
  const req = t.rx.W.decodeRequest(text) || {};
  if (opts.terms) t.rx.W.noteRequestTerms(req.id, opts.terms);
  const tok = await t.payer.W.sendToken(sats, opts.plain ? { unit: 'sat' } : { unit: 'sat', lockTo: req.lockTo });
  const ps = t.payer.W.tokenInfo(tok.token).proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C, dleq: p.dleq }));
  const name = 'a-' + (++answerN);
  await t.rx.W._requestPaid(JSON.stringify({ id: req.id, mint: MINT, unit: 'sat', proofs: ps }), name, 'tap');
  await until(() => t.rx.answers.some((a) => a.answer === name));
  const said = t.rx.answers.find((a) => a.answer === name) || {};
  return { id: req.id, status: said.status, text: said.text, req };
}
const terms = () => ({ usd: 500, rate: 84034, ageMs: 2 * HOUR, seenAt: Date.now() - 2 * HOUR, from: 'q1', convert: true });

// the receiver back online, with a wallet from the mint rather than the cache: what a return does
async function comeBack(c) {
  goOnline(c);
  await c.W.connect(MINT, null, null, { remember: true });
}

async function run() {
  console.log('foxy: sats paid to a dollars wallet, swapped into dollars on return\n');

  // ---- 1. claimed on return, converted once ----------------------------------------------
  {
    const t = await pair({ rxSat: 3000 });
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const told = [];
    t.rx.W.onRequestPaid((ev) => told.push(ev));
    const p = await pay(t, 6500, { terms: terms() });
    ok(p.status === 200, '1: an offline dollars wallet takes sats locked to it', JSON.stringify(p));
    const rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'owed' && rec.sats === 6500 && rec.got === 0 && rec.usd === 500 && canon(rec.mint) === MINT && rec.hash === 'req-' + p.id,
      '1: the payment is owed a swap, not in the pile yet', JSON.stringify(rec));
    const row = rowOf(t.rx, p.id);
    ok(row.sats === 6500 && row.usdAsked === 500 && row.askRate === 84034 && row.rate === 84034 && row.askAgeMs === 2 * HOUR
      && Math.abs(row.askSeenAt - (Date.now() - 2 * HOUR)) < 5000 && row.convert === 'owed',
      '1: its row: the sats, what was asked, the payer’s price as the row’s own, and owed', JSON.stringify(row));
    ok(told.length && told.every((e) => e.convert === true), '1: the screen is told, from the first word, that these convert', JSON.stringify(told.map((e) => e.stage + ':' + e.convert)));
    ok(t.rx.W.convertsOwed().length === 1 && t.rx.W.convertsOwed()[0].tried === false, '1: one owed, not tried');
    ok(await t.rx.W.convertOne() === null, '1: offline, nothing is tried');
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'done' && !app._converting);
    const done = recOf(t.rx, p.id) || {};
    const legs = swapRows(t.rx).filter((r) => r.swap === done.swap);
    const out = legs.find((r) => r.dir === 'out'), inn = legs.find((r) => r.dir === 'in');
    ok(done.state === 'done' && legs.length === 2 && out && (out.unit || 'sat') === 'sat' && inn && inn.unit === 'usd' && inn.amount === done.gotUsd,
      '1: claimed on return and swapped once: a bitcoin row out and a dollar row in, with one swap id', JSON.stringify({ done, legs }));
    ok(done.got === 6500 && done.tries === 1 && out.sats + out.feeSats <= 6500, '1: no more than the payment left', JSON.stringify({ got: done.got, out: out && out.sats, fee: out && out.feeSats }));
    const after = rowOf(t.rx, p.id);
    ok(after.convert === 'done' && after.convertUsd === done.gotUsd && after.convertSwap === done.swap && after.sats === 6500 && after.rate === 84034,
      '1: the payment’s row says swapped, into what; its sats and price unchanged', JSON.stringify(after));
    ok(app.toasts.length === 1 && /swapping the ₿ 6500 you were paid into dollars/.test(app.toasts[0]) && !app.cards.length,
      '1: one word as it starts, and no card', JSON.stringify(app.toasts));
    ok(t.rx.W.balanceOf('sat') === 3000 + 6500 - out.sats - out.feeSats && t.rx.W.balanceOf('usd') === done.gotUsd,
      '1: bitcoin less what the swap took, dollars what it gave', JSON.stringify({ sat: t.rx.W.balanceOf('sat'), usd: t.rx.W.balanceOf('usd') }));
    ok(await t.rx.W.convertOne() === null && swapRows(t.rx).length === 2, '1: a second go does nothing');
    ok(t.rx.W.convertsOwed().length === 0, '1: and nothing is owed');
    await booksShut(t.rx, '1', from);
  }

  // ---- 2. put away ------------------------------------------------------------------------
  {
    const t = await pair({});
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 4000);
    app._putAway = true;
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'claimed');
    await wait(100);
    ok((recOf(t.rx, p.id) || {}).state === 'claimed' && swapRows(t.rx).length === 0 && app.calls >= 1,
      '2: claimed while put away, and not swapped', JSON.stringify({ rec: recOf(t.rx, p.id), calls: app.calls }));
    app._putAway = false;
    await app.convertOnReturn();
    ok((recOf(t.rx, p.id) || {}).state === 'done' && swapRows(t.rx).length === 2, '2: on wake it is swapped', JSON.stringify(recOf(t.rx, p.id)));
    await booksShut(t.rx, '2', from);
  }

  // ---- 3. what the person holds -----------------------------------------------------------
  for (const hold of ['both', 'bitcoin']) {
    const t = await pair({ hold });
    const from = books(t.rx);
    appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 3000, { terms: terms() });
    ok(p.status === 200 && !recOf(t.rx, p.id) && !rowOf(t.rx, p.id).convert, '3: holding ' + hold + ' at arrival: no record', JSON.stringify(recOf(t.rx, p.id)));
    await comeBack(t.rx);
    await until(() => t.rx.W.balanceOf('sat') === 3000 && !Object.keys(read(t.rx, 'foxy.req.unclaimed', {})).length);
    await wait(50);
    ok(swapRows(t.rx).length === 0 && t.rx.W.balanceOf('sat') === 3000, '3: holding ' + hold + ': the sats stay sats');
    await booksShut(t.rx, '3 ' + hold, from);
  }
  {
    const t = await pair({});
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 3000);
    ok((recOf(t.rx, p.id) || {}).state === 'owed', '3: owed while holding dollars');
    t.rx.W.setWalletChoice({ hold: 'both' });
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'kept' && !app._converting);
    const rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'kept' && rec.why === 'hold' && swapRows(t.rx).length === 0 && rowOf(t.rx, p.id).convert === 'kept'
      && rowOf(t.rx, p.id).convertWhy === 'hold', '3: hold changed to both before return: kept as bitcoin, no swap', JSON.stringify(rec));
    await booksShut(t.rx, '3 changed', from);
  }

  // ---- 4. one unit, and another mint ------------------------------------------------------
  {
    const t = await pair({ mintOpts: { units: ['sat'] } });
    const from = books(t.rx);
    appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 3000);
    ok(p.status === 200 && !recOf(t.rx, p.id), '4: a mint with one unit: no record', JSON.stringify(recOf(t.rx, p.id)));
    await comeBack(t.rx);
    await until(() => t.rx.W.balanceOf('sat') === 3000 && !Object.keys(read(t.rx, 'foxy.req.unclaimed', {})).length);
    ok(swapRows(t.rx).length === 0, '4: and nothing swapped');
    await booksShut(t.rx, '4 one unit', from);
  }
  {
    // owed at the first mint; the phone moves to another and comes back online there
    const t = await pair({ other: {} });
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 3000);
    ok((recOf(t.rx, p.id) || {}).state === 'owed', '4: owed at the first mint');
    goOnline(t.rx);
    await t.rx.W.connect(OTHER, null, null, { remember: true });
    await until(() => (recOf(t.rx, p.id) || {}).state === 'claimed' && canon(t.rx.W.mintUrl || '') === OTHER, 4000);
    await wait(100);
    const rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'claimed' && canon(rec.mint) === MINT && swapRows(t.rx).length === 0,
      '4: claimed by a visit to its own mint, and not swapped from another', JSON.stringify({ rec, at: t.rx.W.mintUrl, calls: app.calls }));
    ok(await t.rx.W.convertOne() === null, '4: asked at the other mint, nothing happens');
    await t.rx.W.connect(MINT, null, null, { remember: true });
    await app.convertOnReturn();
    ok((recOf(t.rx, p.id) || {}).state === 'done' && swapRows(t.rx).length === 2, '4: back at its mint, it is swapped there');
    await booksShut(t.rx, '4 visit', {}, MINT);
  }

  // ---- 5. the mint leaves the payment PENDING ---------------------------------------------
  {
    const t = await pair({ mintOpts: { meltPending: true } });
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 5000);
    await comeBack(t.rx);
    await until(() => app.results.some((r) => r && r.outcome === 'pending'));
    const rec = recOf(t.rx, p.id) || {};
    const pill = (await appAudit(t.rx)).pill;
    ok(rec.state === 'swapping' && rec.swap && t.rx.W.unitSwapsPending().length === 1 && /^₿ \d+ pending with the mint$/.test(pill),
      '5: swapping, the swap with the mint, and home’s held pill names it', JSON.stringify({ rec, pill }));
    ok(app.cards.length === 1 && app.cards[0].kind === 'swapPending', '5: on home, the card for a swap still going through');
    ok(rowOf(t.rx, p.id).convert === 'swapping' && rowOf(t.rx, p.id).convertSwap === rec.swap, '5: the payment’s row says it is being swapped');
    ok(await t.rx.W.convertOne() === null, '5: asked again while it is with the mint: nothing');
    const hold = read(t.rx, 'foxy.cashu.melting', []).find((h) => h.swap === rec.swap);
    t.rx.mints[MINT].settleMelt(hold.quote, 'paid');
    await t.rx.W.sweepMelts();
    await t.rx.W.sweepQuotes();
    ok(t.rx.W.unitSwapsPending().length === 0, '5: the sweeps finish it');
    const r = await t.rx.W.convertOne();
    const done = recOf(t.rx, p.id) || {};
    const legs = swapRows(t.rx).filter((x) => x.swap === rec.swap);
    ok(r === null && done.state === 'done' && done.gotUsd > 0 && legs.length === 2 && swapRows(t.rx).length === 2,
      '5: and the record settles done from its rows, with no second swap', JSON.stringify({ r, done, n: swapRows(t.rx).length }));
    ok(rowOf(t.rx, p.id).convert === 'done' && rowOf(t.rx, p.id).convertUsd === done.gotUsd, '5: the row says swapped');
    await booksShut(t.rx, '5', from);
  }

  // ---- 6. the mint refuses the payment ----------------------------------------------------
  {
    const t = await pair({ mintOpts: { meltRefuse: true } });
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 5000);
    await comeBack(t.rx);
    await until(() => app.results.some((r) => r && r.outcome === 'failed'));
    let rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'claimed' && rec.tries === 1 && rec.why === 'mint' && swapRows(t.rx).length === 0 && t.rx.W.balanceOf('sat') === 5000,
      '6: refused: the sats stay, no new rows, tried again later', JSON.stringify(rec));
    ok(rowOf(t.rx, p.id).convert === 'failed' && app.toasts.filter((x) => /could not swap/.test(x)).length === 1,
      '6: the row says not swapped, and it is said once', JSON.stringify(app.toasts));
    ok(await t.rx.W.convertOne() === null && (recOf(t.rx, p.id) || {}).tries === 1, '6: a second go in the same launch does nothing');
    await booksShut(t.rx, '6 first', from);
    // the next launches, on the same storage, phone and mint
    let c = t.rx;
    for (const n of [2, 3]) {
      const next = page({ storage: store(c), phone: c.phone, mints: c.mints });
      next.booksFrom = from;
      noBooks(c, 'its storage went on in the next launch');
      await next.W.connect(MINT, null, null, { remember: true });
      const r = await next.W.convertOne();
      rec = recOf(next, p.id) || {};
      ok(r && r.outcome === 'failed' && rec.tries === n && rec.state === (n === 3 ? 'failed' : 'claimed'),
        '6: launch ' + n + ': tried again, ' + (n === 3 ? 'and that was the last' : 'and left for the next'), JSON.stringify(rec));
      c = next;
    }
    const last = page({ storage: store(c), phone: c.phone, mints: c.mints });
    last.booksFrom = from;
    noBooks(c, 'its storage went on in the next launch');
    await last.W.connect(MINT, null, null, { remember: true });
    ok(await last.W.convertOne() === null && (recOf(last, p.id) || {}).state === 'failed' && last.W.balanceOf('sat') === 5000,
      '6: after three it is failed for good, and the sats are bitcoin');
    await booksShut(last, '6 last', from);
  }

  // ---- 7. too little after the fee --------------------------------------------------------
  {
    const t = await pair({});
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 8);
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'kept' && !app._converting);
    const rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'kept' && rec.why === 'small' && swapRows(t.rx).length === 0 && rowOf(t.rx, p.id).convertWhy === 'small'
      && t.rx.W.balanceOf('sat') === 8, '7: too little to swap after the fee: kept as bitcoin, no rows', JSON.stringify(rec));
    await booksShut(t.rx, '7', from);
  }

  // ---- 8. a rate far from the market ------------------------------------------------------
  {
    const t = await pair({});
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 6000);
    // the market as this phone last saw it: the mint's 76,900 is 14% under it
    t.rx.W._rate = 90000; t.rx.W._rateAt = Date.now();
    await comeBack(t.rx);
    await until(() => app.results.length > 0);
    const rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'claimed' && rec.why === 'rate' && swapRows(t.rx).length === 0 && t.rx.W.balanceOf('sat') === 6000,
      '8: a rate more than 2% from the market is not run', JSON.stringify(rec));
    await booksShut(t.rx, '8', from);
  }

  // ---- 9. restarts ------------------------------------------------------------------------
  {
    // between claim and conversion: no app to ask, then a launch with one
    const t = await pair({});
    const from = books(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 5000);
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'claimed');
    const b = page({ storage: store(t.rx), phone: t.rx.phone, mints: t.rx.mints });
    b.booksFrom = from;
    noBooks(t.rx, 'its storage went on in the next launch');
    await b.W.connect(MINT, null, null, { remember: true });
    const app = appOn(b);
    await app.convertOnReturn();
    await wait(80);
    ok((recOf(b, p.id) || {}).state === 'done' && swapRows(b).length === 2, '9: claimed, then a relaunch: swapped exactly once',
      JSON.stringify({ rec: recOf(b, p.id), n: swapRows(b).length }));
    await booksShut(b, '9 claimed', from);

  }
  {
    // a crash while the rate was being asked for: a quote moves nothing
    const t = await pair({});
    const from = books(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 5000);
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'claimed');
    noBooks(t.rx, 'its storage went on in the next launch');
    const crashed = store(t.rx);
    const list = JSON.parse(crashed['foxy.cashu.convert']);
    list.forEach((r) => { if (r.id === p.id) { r.state = 'quoting'; r.tries = 1; r.triedAt = Date.now(); } });
    crashed['foxy.cashu.convert'] = JSON.stringify(list);
    const q = page({ storage: crashed, phone: t.rx.phone, mints: t.rx.mints });
    q.booksFrom = from;
    await q.W.connect(MINT, null, null, { remember: true });
    const qa = appOn(q);
    await qa.convertOnReturn();
    await wait(80);
    const qrec = recOf(q, p.id) || {};
    ok(qrec.state === 'done' && qrec.tries === 2 && swapRows(q).length === 2, '9: a crash while quoting: back to claimed, and swapped once',
      JSON.stringify({ rec: qrec, n: swapRows(q).length }));
    await booksShut(q, '9 quoting', from);
  }
  {
    // a crash with the swap still with the mint, and then the sats paid out with no dollars on record
    const t = await pair({ mintOpts: { meltPending: true } });
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 5000);
    await comeBack(t.rx);
    await until(() => app.results.some((r) => r && r.outcome === 'pending'));
    const swap = (recOf(t.rx, p.id) || {}).swap;
    const b = page({ storage: store(t.rx), phone: t.rx.phone, mints: t.rx.mints });
    b.booksFrom = from;
    noBooks(t.rx, 'its storage went on in the next launch');
    await b.W.connect(MINT, null, null, { remember: true });
    const ba = appOn(b);
    await ba.convertOnReturn();
    ok((recOf(b, p.id) || {}).state === 'swapping' && swapRows(b).length === 0 && b.W.unitSwapsPending().length === 1,
      '9: relaunched with the swap still with the mint: no second swap', JSON.stringify(recOf(b, p.id)));
    // the mint pays it, and the invoice for the dollars is lost from this phone's list (it lapsed)
    const hold = read(b, 'foxy.cashu.melting', []).find((h) => h.swap === swap);
    b.mints[MINT].settleMelt(hold.quote, 'paid');
    const lost = store(b);
    lost['foxy.cashu.quotes'] = JSON.stringify(JSON.parse(lost['foxy.cashu.quotes'] || '[]').filter((x) => x.swap !== swap));
    const c = page({ storage: lost, phone: b.phone, mints: b.mints });
    c.booksFrom = from;
    noBooks(b, 'its storage went on in the next launch');
    await c.W.connect(MINT, null, null, { remember: true });
    await until(() => swapRows(c).some((x) => x.swap === swap && x.dir === 'out'));
    const ca = appOn(c);
    await ca.convertOnReturn();
    const rec = recOf(c, p.id) || {};
    ok(rec.state === 'failed' && rec.why === 'paid, no dollars yet' && swapRows(c).length === 1 && rowOf(c, p.id).convert === 'failed',
      '9: the sats paid out and no dollars on record: failed, and never tried again', JSON.stringify({ rec, rows: swapRows(c).length }));
    ok(await c.W.convertOne() === null && swapRows(c).length === 1, '9: a second go does nothing');
    await booksShut(c, '9 paid out', from);
  }

  // ---- 10. owed, and then spent elsewhere -------------------------------------------------
  {
    const t = await pair({ rxSat: 2000 });
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 3000);
    // a copy of this phone claims it first
    const copy = page({ storage: store(t.rx), phone: t.rx.phone, mints: t.rx.mints });
    await copy.W.connect(MINT, null, null, { remember: true });
    await until(() => !Object.keys(read(copy, 'foxy.req.unclaimed', {})).length);
    await comeBack(t.rx);
    await until(() => !Object.keys(read(t.rx, 'foxy.req.unclaimed', {})).length);
    await wait(80);
    const gone = recOf(t.rx, p.id) || {};
    ok(gone.state === 'kept' && gone.why === 'spent' && swapRows(t.rx).length === 0 && app.calls === 0,
      '10: the mint says spent, by another: kept, never claimed, and nothing is asked', JSON.stringify({ rec: gone, calls: app.calls }));
    ok(rowOf(t.rx, p.id).convert === 'kept' && rowOf(t.rx, p.id).convertWhy === 'spent',
      '10: and its row stops saying it is to be swapped', JSON.stringify(rowOf(t.rx, p.id)));
    ok(await t.rx.W.convertOne() === null && t.rx.W.balanceOf('sat') === 2000 && swapRows(t.rx).length === 0,
      '10: never converted, and the person’s other sats are untouched', String(t.rx.W.balanceOf('sat')));
    noBooks(t.rx, 'a copy of its storage claimed the payment it had written down');
    noBooks(copy, 'opened over another page’s storage');
  }

  // ---- 11. a swap already with the mint ---------------------------------------------------
  {
    const t = await pair({});
    await fund(t.rx, 1500, 'usd');
    const from = books(t.rx);
    const app = appOn(t.rx);
    // SWAP by hand, its claim's answer lost: still with the mint
    t.rx.lose = /\/v1\/mint\/bolt11$/;
    const manual = await t.rx.W.swapUnits('usd', 'sat', 1000);
    ok(manual.state === 'pending' && t.rx.W.unitSwapsPending().length === 1, '11: a swap by hand is still with the mint', JSON.stringify(manual));
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 5000);
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'claimed');
    await wait(80);
    ok((recOf(t.rx, p.id) || {}).state === 'claimed' && swapRows(t.rx).filter((r) => r.swap !== manual.id).length === 0,
      '11: the conversion waits for it', JSON.stringify({ rec: recOf(t.rx, p.id), pending: t.rx.W.unitSwapsPending().length }));
    await t.rx.W.sweepQuotes();
    await until(() => t.rx.W.unitSwapsPending().length === 0);
    await app.convertOnReturn();
    ok((recOf(t.rx, p.id) || {}).state === 'done' && swapRows(t.rx).length === 4, '11: once it lands, the conversion goes',
      JSON.stringify({ rec: recOf(t.rx, p.id), n: swapRows(t.rx).length }));
    await booksShut(t.rx, '11', from);
  }

  // ---- 12. a payment swapped in as it arrived ---------------------------------------------
  {
    const t = await pair({});
    const from = books(t.rx);
    const app = appOn(t.rx);
    const p = await pay(t, 6000, { plain: true, terms: terms() });
    ok(p.status === 200, '12: plain ecash to an online dollars wallet is taken', JSON.stringify(p));
    await until(() => (recOf(t.rx, p.id) || {}).state === 'done' && !app._converting);
    const rec = recOf(t.rx, p.id) || {};
    const row = rowOf(t.rx, p.id);
    ok(rec.state === 'done' && rec.sats === 6000 && swapRows(t.rx).length === 2, '12: claimed from the start, and swapped at once', JSON.stringify(rec));
    ok(row.usdAsked === 500 && row.rate === 84034 && row.askRate === 84034 && row.askAgeMs === 2 * HOUR && row.convert === 'done' && row.sats === 6000,
      '12: its row carries what was asked and the payer’s price', JSON.stringify(row));
    await booksShut(t.rx, '12', from);
  }
  {
    // locked to this phone while it is online: told at once, claimed at once, then swapped
    const t = await pair({});
    const from = books(t.rx);
    const app = appOn(t.rx);
    const p = await pay(t, 4000, { terms: terms() });
    await until(() => (recOf(t.rx, p.id) || {}).state === 'done' && !app._converting);
    const row = rowOf(t.rx, p.id);
    ok((recOf(t.rx, p.id) || {}).state === 'done' && swapRows(t.rx).length === 2 && row.usdAsked === 500 && row.convert === 'done',
      '12: locked ecash to an online dollars wallet: owed, claimed and swapped once', JSON.stringify({ rec: recOf(t.rx, p.id), row }));
    await booksShut(t.rx, '12 locked online', from);
  }
  {
    // a sat request a dollars wallet made while its person picked bitcoin for this receive: not converted
    const t = await pair({});
    const from = books(t.rx);
    appOn(t.rx);
    ok((() => { try { t.rx.W.setWalletChoice({ recv: 'sat' }); return false; } catch (e) { return true; } })(),
      '12: no balance for receives is remembered any more: asking to keep one is refused');
    const p = await pay(t, 2000, { plain: true, kept: true });
    await until(() => t.rx.W.balanceOf('sat') === 2000);
    await wait(80);
    ok(!recOf(t.rx, p.id) && swapRows(t.rx).length === 0, '12: a receive the person picked bitcoin for stays bitcoin');
    const q = await pay(t, 2000, { plain: true, kept: true, terms: terms() });
    await until(() => (recOf(t.rx, q.id) || {}).state === 'done');
    ok((recOf(t.rx, q.id) || {}).state === 'done', '12: unless it was agreed for dollars');
    await booksShut(t.rx, '12 bitcoin pick', from);
  }

  // ---- 13. a mint that charges for the pieces a swap spends -------------------------------
  /* The swap's own fee comes out of the payment, not out of the person's
   * other sats: what leaves the pile is no more than what landed, whichever
   * way it came in, and the person's own sats are all still there after. */
  for (const mode of ['plain', 'held online', 'held offline']) {
    const t = await pair({ rxSat: 3000, mintOpts: { feePpk: 1000 } });
    const from = books(t.rx);
    const app = appOn(t.rx);
    app._putAway = true;
    if (mode === 'held offline') { goOffline(t.rx); await t.rx.W.connect(MINT, null, null, { remember: true }); }
    const before = t.rx.W.balanceOf('sat');
    const p = await pay(t, 6000, { plain: mode === 'plain', terms: terms() });
    if (mode === 'held offline') await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'claimed', 5000);
    const landed = t.rx.W.balanceOf('sat') - before;
    app._putAway = false;
    await app.convertOnReturn();
    await until(() => !app._converting);
    const rec = recOf(t.rx, p.id) || {};
    const out = swapRows(t.rx).find((x) => x.dir === 'out' && x.swap === rec.swap) || {};
    const spent = (out.sats || 0) + (out.feeSats || 0);
    ok(rec.state === 'done' && spent > 0 && spent <= landed && t.rx.W.balanceOf('sat') >= before,
      '13 ' + mode + ': at a mint with input fees the swap spends no more than landed, and the 3000 of the person’s own stay',
      JSON.stringify({ landed, spent, state: rec.state, why: rec.why, sat: t.rx.W.balanceOf('sat') }));
    await booksShut(t.rx, '13 ' + mode, from);
  }
  for (const ppk of [0, 100, 1000]) {
    // and with nothing else in the pile, the payment still pays its own swap
    const t = await pair({ mintOpts: { feePpk: ppk } });
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 6000, { terms: terms() });
    await comeBack(t.rx);
    await until(() => app.results.length > 0 && !app._converting, 8000);
    const rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'done' && rec.tries === 1 && app.toasts.length === 1 && !app.toasts.some((x) => /could not swap/.test(x)),
      '13 fee ' + ppk + ': a dollars wallet with no other sats has its payment swapped, with one word and no second',
      JSON.stringify({ rec, toasts: app.toasts }));
    await booksShut(t.rx, '13 fee ' + ppk, from);
  }

  // ---- 14. sats spent between the claim and the swap --------------------------------------
  for (const spend of [5000, 2000]) {
    const t = await pair({ rxSat: 3000 });
    const from = books(t.rx);
    const app = appOn(t.rx);
    app._putAway = true;
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 5000, { terms: terms() });
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'claimed');
    const sent = await t.rx.W.sendToken(spend, { unit: 'sat' });
    await t.payer.W.receiveToken(sent.token);
    const pile = t.rx.W.balanceOf('sat');
    app._putAway = false;
    await app.convertOnReturn();
    await until(() => !app._converting);
    const rec = recOf(t.rx, p.id) || {};
    const out = swapRows(t.rx).find((x) => x.dir === 'out' && x.swap === rec.swap) || {};
    const swapped = (out.sats || 0) + (out.feeSats || 0);
    if (spend === 5000) {
      ok(rec.state === 'kept' && rec.why === 'spent' && !swapped && t.rx.W.balanceOf('sat') === pile && rowOf(t.rx, p.id).convertWhy === 'spent',
        '14: the 5000 paid were spent before the swap: the person’s own 3000 are not swapped instead',
        JSON.stringify({ rec, swapped, pile, sat: t.rx.W.balanceOf('sat') }));
    } else {
      ok(rec.state === 'done' && swapped > 0 && swapped <= 3000 && t.rx.W.balanceOf('sat') >= 3000,
        '14: 2000 spent: no more than the 3000 left of the payment is swapped, and the person’s 3000 stay',
        JSON.stringify({ rec, swapped, sat: t.rx.W.balanceOf('sat') }));
    }
    await booksShut(t.rx, '14 spent ' + spend, from);
  }
  {
    // two payments waiting: each is swapped, from its own sats, and the person's stay
    const t = await pair({ rxSat: 3000 });
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p1 = await pay(t, 4000, { terms: terms() });
    const p2 = await pay(t, 2500, { terms: terms() });
    await comeBack(t.rx);
    await until(() => ['done', 'kept', 'failed'].indexOf((recOf(t.rx, p2.id) || {}).state) >= 0
      && ['done', 'kept', 'failed'].indexOf((recOf(t.rx, p1.id) || {}).state) >= 0 && !app._converting, 10000);
    const r1 = recOf(t.rx, p1.id) || {}, r2 = recOf(t.rx, p2.id) || {};
    ok(r1.state === 'done' && r2.state === 'done' && swapRows(t.rx).length === 4 && t.rx.W.balanceOf('sat') >= 3000,
      '14: two payments claimed together are both swapped, and the person’s own 3000 stay',
      JSON.stringify({ r1: r1.state + '/' + r1.why, r2: r2.state + '/' + r2.why, rows: swapRows(t.rx).length, sat: t.rx.W.balanceOf('sat') }));
    await booksShut(t.rx, '14 two', from);
  }

  // ---- 15. a plain payment whose claim is cut off -----------------------------------------
  {
    const t = await pair({});
    const from = books(t.rx);
    const app = appOn(t.rx);
    // the route drops just as the claim goes out: the payer is told it is not yet known
    t.rx.deaf = true;
    const p = await pay(t, 6000, { plain: true, terms: terms() });
    const owed = recOf(t.rx, p.id) || {};
    ok(p.status === 409 && owed.state === 'owed' && owed.ask && owed.ask.usdAsked === 500,
      '15: a plain claim cut off: unsure, and owed with what was asked kept on the record', JSON.stringify({ status: p.status, owed }));
    t.rx.deaf = false;
    await comeBack(t.rx);
    await t.rx.W.claimUnclaimed();
    await until(() => (recOf(t.rx, p.id) || {}).state === 'done' && !app._converting, 8000);
    const row = rowOf(t.rx, p.id);
    ok((recOf(t.rx, p.id) || {}).state === 'done' && swapRows(t.rx).length === 2 && row.usdAsked === 500 && row.rate === 84034 && row.convert === 'done',
      '15: claimed on a later connection, it is swapped, and its row says what was asked', JSON.stringify({ rec: recOf(t.rx, p.id), row }));
    await booksShut(t.rx, '15', from);
  }

  // ---- 16. claimed, and the page went before it said so -----------------------------------
  {
    const t = await pair({});
    const from = books(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 5000, { terms: terms() });
    const before = store(t.rx);
    const b = page({ storage: store(t.rx), phone: t.rx.phone, mints: t.rx.mints });
    b.booksFrom = from;
    noBooks(t.rx, 'storage went on');
    await b.W.connect(MINT, null, null, { remember: true });
    await until(() => !Object.keys(read(b, 'foxy.req.unclaimed', {})).length);
    // the claim landed and the page died before anything after it was written
    const crashed = store(b);
    crashed['foxy.req.unclaimed'] = before['foxy.req.unclaimed'];
    crashed['foxy.cashu.convert'] = before['foxy.cashu.convert'];
    const c = page({ storage: crashed, phone: b.phone, mints: b.mints });
    c.booksFrom = from;
    noBooks(b, 'storage went on');
    const app = appOn(c);
    await c.W.connect(MINT, null, null, { remember: true });
    await until(() => (recOf(c, p.id) || {}).state === 'done' && !app._converting, 8000);
    ok((recOf(c, p.id) || {}).state === 'done' && swapRows(c).length === 2 && rowOf(c, p.id).convert === 'done',
      '16: sats this phone claimed before dying are found in the pile and swapped, once', JSON.stringify({ rec: recOf(c, p.id), rows: swapRows(c).length }));
    await booksShut(c, '16', from);
  }

  // ---- 17. no current price to judge the rate by ------------------------------------------
  {
    const t = await pair({});
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 6000);
    t.rx.W._rate = 90000; t.rx.W._rateAt = Date.now() - 5 * 86400000;
    await comeBack(t.rx);
    await until(() => (recOf(t.rx, p.id) || {}).state === 'claimed');
    await wait(100);
    let rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'claimed' && !rec.tries && !rec.why && swapRows(t.rx).length === 0 && await t.rx.W.convertOne() === null,
      '17: a price five days old is no yardstick: nothing is tried, and no try is spent', JSON.stringify(rec));
    t.rx.W._rate = 76900; t.rx.W._rateAt = Date.now() - 2 * HOUR;
    ok(await t.rx.W.convertOne() === null && !(recOf(t.rx, p.id) || {}).tries, '17: nor two hours old');
    t.rx.W._rate = 76900; t.rx.W._rateAt = Date.now();
    await app.convertOnReturn();
    rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'done' && rec.tries === 1, '17: with a current one it is swapped, on its first try', JSON.stringify(rec));
    await booksShut(t.rx, '17', from);
  }

  // ---- 18. records that do not add up ------------------------------------------------------
  {
    const t = await pair({ rxSat: 9000 });
    const from = books(t.rx);
    goOffline(t.rx);
    const st = store(t.rx);
    const now = Date.now();
    const mk = (id, extra) => Object.assign({ id, hash: 'req-' + id, mint: MINT, at: now, state: 'claimed', sats: 1000, got: 1000,
      usd: 0, swap: '', tries: 0, triedAt: 0, gotUsd: 0, why: '' }, extra || {});
    st['foxy.cashu.convert'] = JSON.stringify([
      mk('huge', { got: 1e12, pileAt: 9000, seq: 1 }),
      mk('unsaid'),
    ]);
    const b = page({ storage: st, phone: t.rx.phone, mints: t.rx.mints });
    b.booksFrom = from;
    noBooks(t.rx, 'storage went on');
    await b.W.connect(MINT, null, null, { remember: true });
    for (let i = 0; i < 3; i++) await b.W.convertOne();
    const outs = swapRows(b).filter((x) => x.dir === 'out');
    const huge = recOf(b, 'huge') || {}, unsaid = recOf(b, 'unsaid') || {};
    ok(huge.state === 'done' && outs.length === 1 && outs[0].sats + outs[0].feeSats <= 1000,
      '18: a record saying it got far more than it was kept as swaps no more than it was kept as',
      JSON.stringify({ huge, outs: outs.map((o) => o.sats + o.feeSats) }));
    ok(unsaid.state === 'kept' && unsaid.why === 'spent', '18: one that does not say what the pile was is not swapped', JSON.stringify(unsaid));
    await booksShut(b, '18', from);
  }

  // ---- 19. a fee over a tenth --------------------------------------------------------------
  {
    const t = await pair({ mintOpts: { satFeeReserve: 400 } });
    const from = books(t.rx);
    const app = appOn(t.rx);
    goOffline(t.rx);
    await t.rx.W.connect(MINT, null, null, { remember: true });
    const p = await pay(t, 2000);
    await comeBack(t.rx);
    await until(() => app.results.length > 0 && !app._converting);
    const rec = recOf(t.rx, p.id) || {};
    ok(rec.state === 'kept' && rec.why === 'small' && rowOf(t.rx, p.id).convertWhy === 'small' && swapRows(t.rx).length === 0
      && !app.toasts.some((x) => /could not swap/.test(x)),
      '19: the mint’s fee is over a tenth of the payment: too little to swap, kept, not tried again', JSON.stringify({ rec, toasts: app.toasts }));
    await booksShut(t.rx, '19', from);
  }

  /* ---- the mirror: dollars paid to a phone that holds bitcoin, swapped into sats ----------
   *
   * A dollar card pays cents for a sats ask at a till with no route (tests/flashcard-usd.js
   * pins the tap and its record). Here the record is put where it would be, with the dollars
   * really in the pile, and the runner is held to the same rules in the other direction. */

  // ---- 20. sats are what they always were: the rule's answers, hold by kept by terms by purpose
  /* `kept` (the person picked this request's unit for this receive) stands where the remembered receive balance
   * stood: a pick of the unit that came keeps it, as a remembered `recv` of that unit did; no pick converts, as the
   * remembered unit set by the hold choice did. A `foxy.wallet.recv` an older build left behind changes nothing. */
  {
    const c = await connected({});
    const holds = ['dollars', 'bitcoin', 'both', ''];
    const keptOf = [true, false, undefined];
    const termsOf = [null, { convert: true }, { convert: false }];
    const purposes = ['receive', 'card', 'card-offline', 'change', 'split:1', 'carry:1'];
    const rule = (hold, kept, t, purpose) => hold === 'dollars' && !/^(split|carry):/.test(purpose) && purpose !== 'change' && purpose !== 'card'
      && (!!(t && t.convert === true) || kept !== true);
    const wrong = [];
    let asked = 0;
    for (const hold of holds) for (const kept of keptOf) for (const t of termsOf) for (const purpose of purposes) {
      if (hold) c.storage.setItem('foxy.wallet.hold', JSON.stringify(hold)); else c.storage.removeItem('foxy.wallet.hold');
      c.storage.setItem('foxy.wallet.recv', JSON.stringify(hold === 'dollars' ? 'sat' : 'usd'));
      const said = c.W._convertDue({ id: 'x', unit: 'sat', mint: MINT, purpose, terms: t, kept });
      asked += 1;
      if (said !== rule(hold, kept, t, purpose)) wrong.push({ hold, kept, t, purpose, said });
      // and the mirror: dollars convert only for a phone that holds bitcoin, by the same rules
      const usd = c.W._convertDue({ id: 'x', unit: 'usd', mint: MINT, purpose, terms: t, kept });
      const want = hold === 'bitcoin' && !/^(split|carry):/.test(purpose) && purpose !== 'change' && purpose !== 'card'
        && (!!(t && t.convert === true) || kept !== true);
      if (usd !== want) wrong.push({ unit: 'usd', hold, kept, t, purpose, said: usd });
    }
    ok(wrong.length === 0 && asked === 216, '20: for sats, every answer is the rule (a pick for this receive keeps the unit); for dollars, the mirror of it', JSON.stringify(wrong.slice(0, 4)));
    c.storage.removeItem('foxy.wallet.hold'); c.storage.removeItem('foxy.wallet.recv');
    ok(c.W._convertDue({ id: 'x', unit: 'usd', mint: OTHER, purpose: 'card-offline', terms: { convert: true } }) === false,
      '20: never at another mint than the one the phone is on');
  }

  /* A receiver that holds bitcoin with `cents` of dollars in its pile, and a record of them owed a swap into sats, as a
   * dollar card's payment kept offline and then claimed leaves it: `state` claimed (or owed), its entry the funding's. */
  async function mirror(o) {
    const opts = o || {};
    const c = await connected({ mintOpts: opts.mintOpts });
    c.W.setWalletChoice({ hold: opts.hold || 'bitcoin' });
    if (opts.other) await fund(c, opts.other, 'usd');
    const got = await fund(c, opts.cents || 592, 'usd');
    const hash = (got && got.hash) || (rows(c).filter((r) => r.unit === 'usd' && r.dir === 'in').slice(-1)[0] || {}).hash;
    const pile = sumOf(read(c, 'foxy.cashu.proofs.' + MINT + '@usd', []));
    const rec = { id: 'd1', hash: hash, mint: MINT, at: Date.now(), state: opts.state || 'claimed', from: 'usd', to: 'sat',
                  sats: opts.cents || 592, got: opts.state === 'owed' ? 0 : (opts.cents || 592), usd: 0, asked: 7000, ask: { satsAsked: 7000, askOwn: true },
                  pileAt: pile, seq: 1, swap: '', tries: 0, triedAt: 0, gotUsd: 0, gotTo: 0, why: '' };
    c.storage.setItem('foxy.cashu.convert', JSON.stringify([rec]));
    return { c, hash, from: books(c) };
  }
  const sumOf = (l) => (l || []).reduce((n, p) => n + (Number(p && p.amount) || 0), 0);

  // ---- 21. dollars into sats, once -------------------------------------------------------
  {
    const { c, hash, from } = await mirror({});
    const sat0 = c.W.balanceOf('sat'), usd0 = c.W.balanceOf('usd');
    const stages = [];
    const r = await c.W.convertOne((stage, rec, q) => stages.push({ stage, from: rec.from, to: rec.to, total: q && q.total }));
    const rec = recOf(c, 'd1') || {};
    const legs = swapRows(c).filter((x) => x.swap === rec.swap);
    const out = legs.find((x) => x.dir === 'out'), inn = legs.find((x) => x.dir === 'in');
    ok(r && r.outcome === 'done' && r.from.unit === 'usd' && r.to.unit === 'sat' && rec.state === 'done' && rec.gotTo === r.to.amount && rec.gotUsd === 0
      && legs.length === 2 && out && out.unit === 'usd' && inn && (inn.unit || 'sat') === 'sat' && inn.sats === rec.gotTo,
      '21: a phone that holds bitcoin swaps the dollars it was paid into sats: a dollar row out, a sat row in, one swap id', JSON.stringify({ r, rec, legs: legs.length }));
    ok(stages.length === 1 && stages[0].from === 'usd' && stages[0].to === 'sat', '21: the start of the swap names its units, for the words the screen says', JSON.stringify(stages));
    ok(c.W.balanceOf('sat') === sat0 + rec.gotTo && c.W.balanceOf('usd') === usd0 - out.amount - (out.feeAmount || 0) && out.amount + (out.feeAmount || 0) <= 592,
      '21: no more than the payment left the dollars', JSON.stringify({ sat: c.W.balanceOf('sat') - sat0, usd: usd0 - c.W.balanceOf('usd') }));
    const row = rows(c).find((x) => x.hash === hash) || {};
    ok(row.convert === 'done' && row.convertSats === rec.gotTo && row.convertUsd === undefined, '21: the payment’s row says swapped into sats', JSON.stringify(row));
    ok(await c.W.convertOne() === null && swapRows(c).length === 2, '21: a second go does nothing');
    ok(c.W.convertsOwed().length === 0, '21: nothing is owed any more');
    await booksShut(c, '21', from);
  }

  // ---- 22. held by the mint, then finished by the sweeps ---------------------------------
  {
    const { c, from } = await mirror({ mintOpts: { meltPending: true } });
    const r = await c.W.convertOne();
    const rec = recOf(c, 'd1') || {};
    ok(r && r.outcome === 'pending' && r.from.unit === 'usd' && rec.state === 'swapping' && c.W.unitSwapsPending().length === 1,
      '22: with the mint: swapping', JSON.stringify({ r, rec }));
    ok(c.W.convertsOwed()[0].from === 'usd' && c.W.convertsOwed()[0].to === 'sat', '22: and the list of what is owed says its units');
    const hold = read(c, 'foxy.cashu.melting', []).find((h) => h.swap === rec.swap);
    c.mints[MINT].settleMelt(hold.quote, 'paid');
    await c.W.sweepMelts();
    await c.W.sweepQuotes();
    const again = await c.W.convertOne();
    const done = recOf(c, 'd1') || {};
    ok(again === null && done.state === 'done' && done.gotTo > 0 && swapRows(c).length === 2, '22: and the record settles done from its rows, with no second swap', JSON.stringify(done));
    await booksShut(c, '22', from);
  }

  // ---- 23. refused, kept, too little -----------------------------------------------------
  {
    const t1 = await mirror({ mintOpts: { meltRefuse: true } });
    const r1 = await t1.c.W.convertOne();
    const rec1 = recOf(t1.c, 'd1') || {};
    ok(r1 && r1.outcome === 'failed' && rec1.state === 'claimed' && rec1.tries === 1 && swapRows(t1.c).length === 0 && t1.c.W.balanceOf('usd') === 592,
      '23: refused by the mint: the dollars stay, tried again next launch', JSON.stringify(rec1));
    await booksShut(t1.c, '23 refused', t1.from);
    const t2 = await mirror({});
    t2.c.W.setWalletChoice({ hold: 'both' });
    const r2 = await t2.c.W.convertOne();
    const rec2 = recOf(t2.c, 'd1') || {};
    ok(r2 && r2.outcome === 'kept' && rec2.state === 'kept' && rec2.why === 'hold' && swapRows(t2.c).length === 0,
      '23: a phone that holds both by the time it is back keeps the dollars', JSON.stringify(rec2));
    await booksShut(t2.c, '23 both', t2.from);
    const t3 = await mirror({ cents: 5, mintOpts: { usdFeePpk: 1000 } });
    const r3 = await t3.c.W.convertOne();
    const rec3 = recOf(t3.c, 'd1') || {};
    ok(r3 && r3.outcome === 'kept' && rec3.why === 'small' && swapRows(t3.c).length === 0, '23: five cents is too little to swap after the fee', JSON.stringify(rec3));
    await booksShut(t3.c, '23 small', t3.from);
  }

  // ---- 24. the person's own dollars are never swapped ------------------------------------
  {
    const { c, from } = await mirror({ other: 2000 });
    const usd0 = c.W.balanceOf('usd');
    const r = await c.W.convertOne();
    const out = swapRows(c).find((x) => x.dir === 'out') || {};
    ok(r && r.outcome === 'done' && out.amount + (out.feeAmount || 0) <= 592 && c.W.balanceOf('usd') >= usd0 - 592,
      '24: of a dollar pile with 2,000 of the person’s own, no more than the 592 paid is swapped', JSON.stringify({ out: out.amount, fee: out.feeAmount }));
    await booksShut(c, '24', from);
  }

  // ---- 25. a dollar claim moves only a dollar record, and a sat claim only a sat one -----
  {
    const t = await pair({ hold: 'bitcoin' });
    await fund(t.payer, 2000, 'usd');
    const rx = t.rx;
    const from = books(rx);
    const usdTok = await t.payer.W.sendToken(300, { unit: 'usd' });
    const satTok = await t.payer.W.sendToken(500, { unit: 'sat' });
    const at = Date.now();
    // a dollar row under a sat record's id, and a dollar row under a dollar record's: as two payments kept offline would be
    rx.storage.setItem('foxy.req.unclaimed', JSON.stringify({
      s1: { token: usdTok.token, at, amount: 300, unit: 'usd', mint: MINT },
      u2: { token: satTok.token, at, amount: 500, unit: 'sat', sats: 500, mint: MINT },
    }));
    rx.storage.setItem('foxy.cashu.convert', JSON.stringify([
      { id: 's1', hash: 'req-s1', mint: MINT, at, state: 'owed', sats: 300, got: 0, usd: 0, swap: '', tries: 0, triedAt: 0, gotUsd: 0, why: '' },
      { id: 'u2', hash: 'req-u2', mint: MINT, at, state: 'owed', from: 'usd', to: 'sat', sats: 500, got: 0, usd: 0, asked: 0, swap: '', tries: 0, triedAt: 0, gotUsd: 0, gotTo: 0, why: '' },
    ]));
    await rx.W.claimUnclaimed();
    await wait(80);
    const s1 = recOf(rx, 's1') || {}, u2 = recOf(rx, 'u2') || {};
    ok(s1.state === 'owed' && u2.state === 'owed' && !Object.keys(read(rx, 'foxy.req.unclaimed', {})).length,
      '25: dollars claimed under a record of sats, and sats under a record of dollars: neither record moves', JSON.stringify({ s1: s1.state, u2: u2.state }));
    noBooks(rx, 'rows planted under records of the other unit');
    void from;
  }

  // ---- 26. a record of dollars paid out with no sats on record, found after a restart ----
  {
    const { c, from } = await mirror({ mintOpts: { meltPending: true } });
    const r = await c.W.convertOne();
    const rec = recOf(c, 'd1') || {};
    // the sat leg's invoice lost from this phone's list (it lapsed), and the mint pays the melt
    const hold = read(c, 'foxy.cashu.melting', []).find((h) => h.swap === rec.swap);
    c.mints[MINT].settleMelt(hold.quote, 'paid');
    const lost = store(c);
    lost['foxy.cashu.quotes'] = JSON.stringify(JSON.parse(lost['foxy.cashu.quotes'] || '[]').filter((x) => x.swap !== rec.swap));
    const b = page({ storage: lost, phone: c.phone, mints: c.mints });
    b.booksFrom = from;
    noBooks(c, 'its storage went on in the next launch');
    await b.W.connect(MINT, null, null, { remember: true });
    await until(() => swapRows(b).some((x) => x.swap === rec.swap && x.dir === 'out'));
    await b.W.convertOne();
    const after = recOf(b, 'd1') || {};
    ok(r && r.outcome === 'pending' && after.state === 'failed' && after.why === 'paid, no bitcoin yet' && (await b.W.convertOne()) === null,
      '26: the dollars paid out and no sats on record: failed, and never tried again', JSON.stringify(after));
    await booksShut(b, '26', from);
  }
}

run().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
}, (e) => { console.log('THREW', (e && e.stack) || e); process.exit(1); });
