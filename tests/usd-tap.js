'use strict';
/* usd-tap.js — two phones at one mint paying each other in dollars, by tap,
 * with one of them offline: the wallet's half.
 *
 *     node tests/usd-tap.js
 *
 * A mint that issues sat and usd keysets (Forge does) holds a dollar balance
 * beside the bitcoin one. A tap carried bitcoin only; this is the same tap in
 * dollars, by the same rules a sat tap keeps:
 *
 *   - a request names its unit, and is paid in that unit or not at all;
 *   - one of the two phones must be online at the tap (both offline is
 *     refused, as for sats; the switch that would ask HIGH RISK instead is off
 *     as Foxy ships, and is driven on here to keep that road unit-correct);
 *   - an offline receiver takes only ecash locked to it, signed by the mint
 *     (DLEQ), checked against the dollar keyset it keeps for the mint;
 *   - an offline payer pays from what it holds in the request's unit, and is
 *     told NEEDS THE MINT, before anything moves, when that is not enough;
 *   - what is kept offline is counted in dollars, swapped in when there is a
 *     route, and never added to sats;
 *   - no bitcoin price is asked for anywhere.
 *
 * Two pages share one fake mint with a usd keyset and P2PK (harness.js
 * `fakeMint` with `units` and `p2pk`), and one link between them that
 * carries what the radio carries (M5 the payment, M6 the answer, M7 change,
 * M10/M11 the question asked first). "Offline" is the suite's own pretend
 * airplane mode: no route, and the mint refuses to answer that page. Every
 * page's books are judged per unit as the suite ends (harness.js). */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, rebook, noBooks } = require('./harness');

const MINT = 'https://m.test';
const SAT_PILE = 'foxy.cashu.proofs.' + MINT;
const USD_PILE = SAT_PILE + '@usd';
const WORDS_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const WORDS_C = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

let failed = 0, passed = 0;
// every page the suite made, for the questions asked of all of them at the end (no price asked for)
const everyPage = [];
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return !!fn();
};
const pile = (c, key) => JSON.parse(c.storage.getItem(key) || '[]');
const sum = (l) => (l || []).reduce((a, p) => a + Number(p.amount || 0), 0);
const history = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
const kept = (c) => JSON.parse(c.storage.getItem('foxy.req.unclaimed') || '{}');
const lockRows = (c) => JSON.parse(c.storage.getItem('foxy.req.lockkeys') || '{}');
const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const why = async (fn) => { try { await fn(); return ''; } catch (e) { return String((e && e.message) || e); } };
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* The history card's audit as the app does it (16-history-lists.js), lifted out of
 * build/foxy-app.js and run against a page's own wallet: the balance as
 * `refreshBalance` reads it, and the entries as `loadHistory` maps them. */
const appSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
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
async function appAudit(c) {
  const W = c.W;
  const items = history(c).filter((t) => !t.mint || String(t.mint).replace(/\/+$/, '') === MINT).map((t) => ({
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

/* The link between two phones, as change-leg.js has it, with the question
 * asked first (M10, `tapQuote`) and its answer (M11, `tapTerms`) as well. */
function link() {
  const L = { up: true, log: [], payer: null, receiver: null };
  L.down = (w) => { if (L.up) { L.up = false; L.log.push('down: ' + w); } };
  return L;
}

/* A page at the shared mint. `o.mint` shares a mint; `o.phone` reuses a
 * phone's counters and lock keys (a relaunch); `o.storage` what it starts
 * with. `ctx.deaf` makes the mint unreachable from this page (pretend
 * airplane mode with goOffline); `ctx.lose` (a RegExp of a path) loses the
 * next such answer after the mint acted on it; `ctx.never` the same, with no
 * answer ever (a page killed with the swap at the mint). */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  if (opts.phone) { phone.counters = opts.phone.counters; phone.locks = opts.phone.locks; }
  let mint = opts.mint || null;
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      const L = ctx.link;
      ctx.actions.push(m.action);
      switch (m.action) {
        case 'mintRequest': {
          const url = String(m.url || '');
          if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
          // `ctx.hold` (a RegExp of a path): the request waits, unanswered and not yet at the mint, until `ctx.held` is called
          // (`.go()` lets it reach the mint and be answered; `.refuse(text)` answers it without the mint ever seeing it)
          if (ctx.hold && ctx.hold.test(url)) {
            ctx.held.push({ go: () => reply(w, m.id, mint.handle(m)), refuse: (text) => reply(w, m.id, text) });
            return null;
          }
          if (ctx.never && ctx.never.test(url)) { ctx.never = null; mint.handle(m); return null; }
          if (ctx.lose && ctx.lose.test(url)) { ctx.lose = null; mint.handle(m); return reply(w, m.id, null, 'The network connection was lost.'); }
          // `ctx.onMint(url)`: told of each answer as it leaves the mint (a route lost just after a swap)
          const said = mint.handle(m);
          if (typeof ctx.onMint === 'function') ctx.onMint(url);
          return reply(w, m.id, said);
        }
        case 'inboxAnswer':
          ctx.answers.push({ answer: m.answer, status: [200, 409, 422].indexOf(Number(m.status)) >= 0 ? Number(m.status) : 422,
                             text: String(m.text || '') });
          return reply(w, m.id, 'ok');
        case 'tapChangeDue': return reply(w, m.id, 'ok');
        case 'tapAsking': return reply(w, m.id, 'ok');
        case 'tapChangeKept':
          if (L) L.log.push('M8 kept=' + !!m.kept);
          return reply(w, m.id, 'ok');
        case 'tapQuote':
          // M10: the payer asks first; the receiver's wallet answers by itself
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M10');
          setTimeout(() => L.receiver.W._tapQuote(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapTerms':
          ctx.terms.push(String(m.body || ''));
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M11');
          setTimeout(() => L.payer.W._tapTerms(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapChange':
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M7');
          setTimeout(() => L.payer.W._tapChange(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapSend': {
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M5');
          L.lastBody = String(m.body || '');
          const began = L.receiver.answers.length;
          setTimeout(() => L.receiver.W._requestPaid(String(m.body || ''), 'wire', 'tap'), 0);
          const gaveUp = Date.now() + 30000;
          const wait = setInterval(() => {
            const said = L.receiver.answers;
            if (said.length <= began && Date.now() > gaveUp) { clearInterval(wait); reply(w, m.id, null, 'That phone is no longer connected.'); return; }
            if (said.length <= began) return;
            clearInterval(wait);
            const last = said[said.length - 1];
            L.log.push('M6 ' + last.status);
            reply(w, m.id, JSON.stringify(last.status === 200 ? { v: 2, ok: true, code: 200 }
              : { v: 2, ok: false, code: last.status, why: String(last.text || '').slice(0, 160) }));
          }, 1);
          return null;
        }
        default: {
          const got = phone.answer(w, m);
          if (!got) return reply(w, m.id, null, 'not in this test');
          return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
        }
      }
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, Object.assign({ units: ['sat', 'usd'], p2pk: true }, opts.mintOpts || {}));
    },
  });
  ctx.deaf = false;
  ctx.hold = null;
  ctx.held = [];
  ctx.lose = null;
  ctx.never = null;
  ctx.answers = [];
  ctx.actions = [];
  ctx.terms = [];
  ctx.phone = phone;
  ctx.mint = mint;
  everyPage.push(ctx);
  // every way the wallet has of asking for a bitcoin price, watched: a dollar tap asks none of them
  ctx.priceAsked = [];
  ['rate', '_rateFetch', 'quoteFor', 'agreedRate'].forEach((name) => {
    const real = ctx.W[name];
    if (typeof real !== 'function') return;
    ctx.W[name] = function () { ctx.priceAsked.push(name); return real.apply(this, arguments); };
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._askWaitMs = 4000;
  ctx.W._refundWaitMs = 300;
  ctx.W._swapPollMs = 5;
  ctx.W._swapClaimWaitMs = 200;
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
  await c.W.connect(MINT, null, null, { remember: true });
  return c;
}
async function fund(c, amount, unit) {
  const inv = await c.W.invoice(amount, '', { unit: unit || 'sat' });
  return c.W.claim(inv.hash);
}

/* The app's change handler (15-paid-wake-keyboard.js), as a payer runs it,
 * in the payment's unit: checked, kept (offline: written down), told, and
 * the payment's own entry finished with what it is worth here. */
function payerTakesChange(payer, unit) {
  payer.changes = [];
  payer.W.onTapChange((token) => {
    const bits = payer.W.tokenInfo(token);
    const amount = bits ? bits.amount : 0;
    const chk = payer.W.checkChange(token, payer.owed || 0, unit);
    payer.changes.push({ amount, chk });
    if (!chk.ok) { payer.W.tapChangeKept(false); return; }
    const net = payer.W.changeNet(token);
    const after = () => {
      if (payer.lastHash) payer.W.changeSettled(payer.lastHash, net);
      payer.W.tapChangeKept(true);
    };
    if (payer.deaf) {
      try { payer.W.keepChange(token, amount); after(); } catch (e) { payer.W.tapChangeKept(false); }
      return;
    }
    payer.W.receiveToken(token, { hash: 'tap-change-' + Date.now() }).then(after, () => {
      try { payer.W.keepChange(token, amount); after(); } catch (e) { payer.W.tapChangeKept(false); }
    });
  });
}

/* A receiver at the mint, and a payer, wired over one link. `rxOffline` and
 * `payerOffline` put either in pretend airplane mode after it has seen the
 * mint once (its keys on file, as a phone that has used Forge has). */
async function pair(o) {
  const opts = o || {};
  const rx = await connected({ mintOpts: opts.mintOpts });
  const shared = rx.mint;
  await rx.W.primeLocks();
  if (opts.rxUsd) await fund(rx, opts.rxUsd, 'usd');
  const payer = await connected({ mint: shared, words: WORDS_B });
  for (const amount of (opts.payerUsd || [])) await fund(payer, amount, 'usd');
  if (opts.payerSat) await fund(payer, opts.payerSat, 'sat');
  await payer.W.primeLocks();
  if (opts.rxOffline) { goOffline(rx); await rx.W.connect(MINT, null, null, { remember: true }); }
  if (opts.payerOffline) { goOffline(payer); await payer.W.connect(MINT, null, null, { remember: true }); }
  const L = link();
  L.payer = payer; L.receiver = rx;
  payer.link = L; rx.link = L;
  return { rx, payer, L, shared };
}

// the request as the payer's tap reads it off the offer (26d-tap.js `tapOfferOf`)
const tapReq = (t, text, extra) => Object.assign({}, t.payer.W.decodeRequest(text) || {},
  { viaTap: true, theirRoute: !t.rx.deaf, asks: true }, extra || {});
const pay = (t, req, opts) => t.payer.W.payRequest(req, () => {}, opts || {})
  .then((made) => ({ made }), (e) => ({ e, why: String((e && e.message) || e) }));

async function run() {
  // ---- 1. a request names its unit -----------------------------------------------
  {
    const t = await pair({});
    const text = t.rx.W.paymentRequest(200, { unit: 'usd', purpose: 'receive' });
    const r = t.rx.W.decodeRequest(text) || {};
    ok(r.unit === 'usd' && r.amount === 200 && r.sats === null && !!r.lockTo,
      'a dollar request is in cents, with its lock', JSON.stringify({ unit: r.unit, amount: r.amount, sats: r.sats, lock: !!r.lockTo }));
    ok(!r.usd && !/foxy1 usd=/.test(String(r.description || '')), 'and carries no dollar marker: the amount is the dollars');
    const open = JSON.parse(t.rx.storage.getItem('foxy.req.open') || '{}')[r.id] || {};
    ok(open.unit === 'usd' && open.amount === 200 && open.sats === 0, 'the open request says its unit, and 0 sats', JSON.stringify(open));
    const row = lockRows(t.rx)[r.id] || {};
    ok(row.unit === 'usd' && row.amount === 200 && row.pub === r.lockTo, 'its lock row says the unit it was made for', JSON.stringify(row));
    const satReq = t.rx.W.decodeRequest(t.rx.W.paymentRequest(21, { purpose: 'receive' })) || {};
    ok(satReq.unit === 'sat' && satReq.sats === 21 && (lockRows(t.rx)[satReq.id] || {}).unit === 'sat', 'a sat request is as it was');
    ok(t.rx.W.paymentRequest(200, { unit: 'usd', usd: 200 }) === '', 'a dollar request with a dollar marker too is not made: one amount per request');
    ok(t.rx.W.paymentRequest(200, { unit: 'eur' }) === '', 'nor one in a unit Foxy does not ask in');
    const one = await connected({ mintOpts: { units: ['sat'], p2pk: true } });
    ok(one.W.paymentRequest(200, { unit: 'usd' }) === '', 'nor a dollar request at a mint that issues no dollars');
  }

  // ---- 2. R1: both online, dollars locked to the receiver -----------------------------
  {
    const t = await pair({ payerUsd: [1000], payerSat: 500 });
    const text = t.rx.W.paymentRequest(200, { unit: 'usd', purpose: 'receive' });
    const told = [];
    t.rx.W.onRequestPaid((ev) => told.push(ev));
    const satBefore = t.payer.W.balanceOf('sat');
    const r = await pay(t, tapReq(t, text));
    ok(!!r.made && r.made.unit === 'usd' && r.made.amount === 200 && !!r.made.lockedTo, 'both online: paid in dollars, locked to the receiver', r.why);
    await settle(300);
    ok(t.L.log.indexOf('M10') >= 0 && t.L.log.indexOf('M5') > t.L.log.indexOf('M11'), 'asked first, then paid', t.L.log.join(' | '));
    ok(t.payer.W.balanceOf('usd') === 800 && t.payer.W.balanceOf('sat') === satBefore, 'the payer is out $ 2.00 from dollars alone',
      t.payer.W.balanceOf('usd') + ' / ' + t.payer.W.balanceOf('sat'));
    await until(() => sum(pile(t.rx, USD_PILE)) === 200);
    ok(sum(pile(t.rx, USD_PILE)) === 200 && t.rx.W.balanceOf('usd') === 200 && t.rx.W.balanceOf('sat') === 0,
      'the receiver has $ 2.00 in its dollar pile, and no sats', sum(pile(t.rx, USD_PILE)) + ' / ' + t.rx.W.balanceOf('sat'));
    const rows = history(t.rx).filter((e) => e.dir === 'in' && /^req-/.test(e.hash));
    ok(rows.length === 1 && rows[0].unit === 'usd' && rows[0].amount === 200 && rows[0].sats === 0, 'one entry, in dollars', JSON.stringify(rows));
    const paid = told.filter((e) => e.stage === 'paid')[0] || {};
    ok(paid.unit === 'usd' && paid.amount === 200 && paid.sats === 0, 'the screen is told $ 2.00, and 0 sats', JSON.stringify(paid));
    const out = history(t.payer).filter((e) => e.dir === 'out')[0] || {};
    ok(out.unit === 'usd' && out.amount === 200, 'the payer\'s entry is in dollars', JSON.stringify(out));
  }

  // ---- 3. R2: the receiver offline -------------------------------------------------
  {
    const t = await pair({ payerUsd: [1000], rxOffline: true });
    const text = t.rx.W.paymentRequest(200, { unit: 'usd', purpose: 'receive' });
    const req = tapReq(t, text);
    ok(!!req.lockTo, 'an offline receiver still asks for a lock');
    const r = await pay(t, req);
    ok(!!r.made && r.made.unit === 'usd' && !!r.made.lockedTo, 'the online payer pays locked dollars', r.why);
    await settle(300);
    const answer = t.rx.answers[t.rx.answers.length - 1] || {};
    ok(answer.status === 200, 'the offline receiver answers 200 at once', JSON.stringify(answer));
    const rows = Object.values(kept(t.rx));
    ok(rows.length === 1 && rows[0].unit === 'usd' && rows[0].amount === 200 && rows[0].sats === undefined,
      'it is kept, in dollars', JSON.stringify(rows.map((x) => ({ unit: x.unit, amount: x.amount, sats: x.sats }))));
    ok(t.rx.W.keptIn('usd') === 200 && t.rx.W.unclaimedSats() === 0 && t.rx.W.balanceOf('usd') === 200 && t.rx.W.balanceOf('sat') === 0,
      'counted in the dollar balance, never in sats', JSON.stringify({ kept: t.rx.W.keptIn('usd'), sats: t.rx.W.unclaimedSats(), usd: t.rx.W.balanceOf('usd') }));
    const entry = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    ok(entry.unit === 'usd' && entry.amount === 200 && entry.state === 'success', 'its entry is a dollar payment, settled', JSON.stringify(entry));
    // back online: swapped in, the same entry finished
    const late = [];
    t.rx.W.onLateClaim((ev) => late.push(ev));
    goOnline(t.rx);
    await t.rx.W.claimUnclaimed();
    ok(Object.keys(kept(t.rx)).length === 0 && t.rx.W.keptIn('usd') === 0 && sum(pile(t.rx, USD_PILE)) === 200,
      'with a route it is swapped into the dollar pile', JSON.stringify({ kept: kept(t.rx), pile: sum(pile(t.rx, USD_PILE)) }));
    const after = history(t.rx).filter((e) => /^req-/.test(e.hash));
    ok(after.length === 1 && after[0].amount === 200 && after[0].unit === 'usd', 'the same entry, amended in cents', JSON.stringify(after));
    ok(late.length === 1 && late[0].unit === 'usd' && late[0].amount === 200 && late[0].sats === 0, 'the late claim is said in dollars', JSON.stringify(late));
    ok(!lockRows(t.rx)[req.id], 'and the request\'s lock row is gone');
    ok(t.payer.actions.indexOf('price') < 0 && t.rx.actions.indexOf('price') < 0, 'no bitcoin price was asked for by either phone');
  }

  // ---- 4. R3: the payer offline, exact dollar pieces; then over, with change -----------
  {
    const t = await pair({ payerUsd: [128, 64, 8], payerOffline: true });
    const text = t.rx.W.paymentRequest(200, { unit: 'usd', purpose: 'receive' });
    const req = tapReq(t, text);
    const r = await pay(t, req);
    ok(!!r.made && r.made.unit === 'usd' && !r.made.lockedTo && !r.made.swapped && r.made.over === 0,
      'an offline payer pays exact dollar pieces as they are', r.why || JSON.stringify(r.made && { over: r.made.over }));
    await until(() => sum(pile(t.rx, USD_PILE)) === 200);
    ok(sum(pile(t.rx, USD_PILE)) === 200 && t.payer.W.balanceOf('usd') === 0, 'the online receiver swapped it in; the payer holds none',
      sum(pile(t.rx, USD_PILE)) + ' / ' + t.payer.W.balanceOf('usd'));
    ok(t.L.log.indexOf('M10') >= 0, 'it asked first with no route as well', t.L.log.join(' | '));
  }
  {
    const t = await pair({ payerUsd: [256], payerOffline: true });
    payerTakesChange(t.payer, 'usd');
    const text = t.rx.W.paymentRequest(200, { unit: 'usd', purpose: 'receive' });
    const needs = await caught(() => t.payer.W.payRequest(tapReq(t, text), () => {}));
    ok(needs && needs.foxyNeedsOverpay && needs.foxyNeedsOverpay.unit === 'usd' && needs.foxyNeedsOverpay.over === 56,
      'no exact pieces: the person is asked first, with the figures in cents', JSON.stringify(needs && needs.foxyNeedsOverpay));
    ok(t.payer.W.balanceOf('usd') === 256, 'and nothing moved while they were asked');
    t.payer.owed = 56;
    const r = await pay(t, tapReq(t, text), { overpayOk: true });
    ok(!!r.made && r.made.over === 56 && r.made.amount === 256, 'they agree: $ 2.56 for $ 2.00, $ 0.56 to come back', r.why);
    if (r.made) t.payer.lastHash = r.made.hash;
    await until(() => (t.payer.changes || []).length > 0 && t.L.log.some((l) => /^M8/.test(l)));
    const ch = (t.payer.changes || [])[0] || {};
    ok(ch.amount === 56 && ch.chk && ch.chk.ok && ch.chk.unit === 'usd', 'the change comes back over the link, in dollars, and passes the check', JSON.stringify(ch));
    ok(t.payer.W.keptIn('usd') === 56 && t.payer.W.balanceOf('usd') === 56 && t.payer.W.unclaimedSats() === 0,
      'the offline payer keeps it in dollars until it has a route', JSON.stringify({ kept: t.payer.W.keptIn('usd') }));
    const out = history(t.payer).filter((e) => e.dir === 'out')[0] || {};
    ok(out.unit === 'usd' && out.amount === 200 && out.grossAmount === 256 && out.changeAmount === 56 && out.changeState === 'came back'
      && out.grossSats === undefined, 'its entry is the net, in cents, with what moved and what came back', JSON.stringify(out));
    const rrow = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    ok(rrow.unit === 'usd' && rrow.amount === 200 && rrow.changeAmount === 56 && rrow.changeState === 'given back',
      'the receiver kept $ 2.00 and says the change went back', JSON.stringify(rrow));
    ok(sum(pile(t.rx, USD_PILE)) === 200, 'and holds exactly that', String(sum(pile(t.rx, USD_PILE))));
    // the change of the wrong unit, or more than owed, is refused
    const satChange = await t.rx.W.sendToken(5, { unit: 'sat', lockTo: G, purpose: 'change' }).catch(() => null);
    ok(!satChange || /not dollars/.test(t.payer.W.checkChange(satChange.token, 56, 'usd').why), 'change in sats for a dollar payment is refused: "it is not dollars"');
    goOnline(t.payer);
    await t.payer.W.claimUnclaimed();
    ok(t.payer.W.keptIn('usd') === 0 && sum(pile(t.payer, USD_PILE)) === 56, 'with a route the change is swapped into the dollar pile',
      String(sum(pile(t.payer, USD_PILE))));
    noBooks(t.rx, 'it made a stray sat token locked to nobody it knows');
  }

  // ---- 5. R3 from dollars that arrived locked: handed on, whole and in part -----------
  {
    // P takes $ 3.00 offline from Q, then pays R from it, still offline
    const q = await connected({ words: WORDS_C });
    const shared = q.mint;
    await fund(q, 1000, 'usd');
    await fund(q, 100, 'sat');
    const p = await connected({ mint: shared });
    await p.W.primeLocks();
    const r = await connected({ mint: shared, words: WORDS_B });
    await r.W.primeLocks();
    goOffline(p); await p.W.connect(MINT, null, null, { remember: true });
    const usdAsk = p.W.decodeRequest(p.W.paymentRequest(300, { unit: 'usd' })) || {};
    const satAsk = p.W.decodeRequest(p.W.paymentRequest(50, { unit: 'sat' })) || {};
    const L1 = link(); L1.payer = q; L1.receiver = p; q.link = L1; p.link = L1;
    const one = await q.W.payRequest(Object.assign({}, usdAsk, { viaTap: true, theirRoute: false, asks: true }), () => {}).catch((e) => ({ e }));
    const two = await q.W.payRequest(Object.assign({}, satAsk, { viaTap: true, theirRoute: false, asks: true }), () => {}).catch((e) => ({ e }));
    await settle(300);
    ok(one && one.token && two && two.token && p.W.keptIn('usd') === 300 && p.W.unclaimedSats() === 50,
      'P, offline, holds $ 3.00 and 50 sats kept, each in its own unit', JSON.stringify({ usd: p.W.keptIn('usd'), sat: p.W.unclaimedSats(), e: one.e && one.e.message }));
    // P pays R $ 0.40 out of the dollar row, piece by piece
    const L2 = link(); L2.payer = p; L2.receiver = r; p.link = L2; r.link = L2;
    const rAsk = r.W.paymentRequest(40, { unit: 'usd' });
    const t = { rx: r, payer: p };
    const out = await pay(t, tapReq(t, rAsk));
    await until(() => sum(pile(r, USD_PILE)) === 40);
    ok(!!out.made && out.made.amount === 40 && sum(pile(r, USD_PILE)) === 40, 'P pays R $ 0.40 with pieces of the dollars it was paid', out.why);
    ok(p.W.keptIn('usd') === 260 && p.W.unclaimedSats() === 50, 'its dollar row shrinks to $ 2.60; the sat row is untouched',
      JSON.stringify({ usd: p.W.keptIn('usd'), sat: p.W.unclaimedSats() }));
    const rowsP = Object.values(kept(p)).filter((x) => x.unit === 'usd');
    ok(rowsP.length === 1 && rowsP[0].whole === 300, 'the row remembers what it was worth whole', JSON.stringify(rowsP.map((x) => ({ amount: x.amount, whole: x.whole }))));
    // the same pieces cannot go out twice
    const again = await why(() => p.W.forwardLocked(one.token));
    ok(/already been handed on/.test(again), 'what was handed on cannot be handed on again', again);
    // back online, P's rows are swapped in each into its own pile
    goOnline(p);
    await p.W.claimUnclaimed();
    ok(sum(pile(p, USD_PILE)) === 260 && sum(pile(p, SAT_PILE)) === 50 && p.W.keptIn('usd') === 0,
      'with a route the rest is swapped in, dollars into dollars and sats into sats', sum(pile(p, USD_PILE)) + ' / ' + sum(pile(p, SAT_PILE)));
    const entry = history(p).filter((e) => e.hash === 'req-' + usdAsk.id)[0] || {};
    ok(entry.unit === 'usd' && entry.amount === 300, 'and the payment it arrived as still says $ 3.00', JSON.stringify(entry));
  }

  // ---- 6. R5 / R6: offline, and not enough of the request's unit -----------------------
  {
    const t = await pair({ payerSat: 5000, payerOffline: true });
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    const swapsBefore = t.payer.storage.getItem('foxy.cashu.swaps');
    const e = await caught(() => t.payer.W.payRequest(tapReq(t, text), () => {}));
    ok(e && e.foxyNeedsMint && e.foxyNeedsMint.title === 'NEEDS THE MINT'
      && e.message === 'This request is in dollars. You hold no dollars here, and paying it from bitcoin needs the mint.',
      'no dollars offline: NEEDS THE MINT, in words', e && e.message);
    ok(t.L.log.length === 0 && t.payer.W.balanceOf('sat') === 5000 && t.payer.storage.getItem('foxy.cashu.swaps') === swapsBefore,
      'before anything was asked or moved', t.L.log.join(' | '));
  }
  {
    const t = await pair({ payerUsd: [100], payerOffline: true });
    const e = await caught(() => t.payer.W.payRequest(tapReq(t, t.rx.W.paymentRequest(200, { unit: 'usd' })), () => {}));
    ok(e && e.foxyNeedsMint && /this needs \$ 2\.00 and you hold \$ 1\.00\./.test(e.message), 'too few dollars: the dollar sum, NEEDS THE MINT', e && e.message);
    const e2 = await caught(() => t.payer.W.payRequest(tapReq(t, t.rx.W.paymentRequest(50, { unit: 'sat' })), () => {}));
    ok(e2 && e2.foxyNeedsMint && e2.message === 'This request is in bitcoin. You hold no bitcoin here, and paying it from dollars needs the mint.',
      'and the mirror: a sat request, dollars only', e2 && e2.message);
    ok(t.payer.W.balanceOf('usd') === 100 && t.L.log.length === 0, 'nothing moved');
  }

  // ---- 7. R4: both offline -------------------------------------------------------------
  {
    const t = await pair({ payerUsd: [128, 64, 8], rxOffline: true, payerOffline: true });
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    const r = await pay(t, tapReq(t, text));
    ok(r.why === 'You are both offline, so nothing here could settle this payment. One of you needs a connection.',
      'both offline: refused, in the words sats are', r.why);
    ok(t.L.log.length === 0 && t.payer.W.balanceOf('usd') === 200, 'and nothing moved');
  }
  {
    // the switch on, in the suites only: HIGH RISK in dollars, then the payer spends it back
    const t = await pair({ payerUsd: [128, 64, 8], rxOffline: true, payerOffline: true });
    t.rx.W._offlineToOffline(true); t.payer.W._offlineToOffline(true);
    const cards = [], lost = [];
    t.rx.W.onOfflineOffer((info) => { cards.push(info); return Promise.resolve(true); });
    t.rx.W.onTrustLost((info) => lost.push(info));
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    // not asked first: an offline receiver answers that question "locked only", for sats as well (`answerIntent`)
    const r = await pay(t, tapReq(t, text, { asks: false }));
    await settle(300);
    ok(!!r.made && cards.length === 1 && cards[0].unit === 'usd' && cards[0].amount === 200 && cards[0].sats === 0,
      'the HIGH RISK card is asked in dollars', JSON.stringify({ cards, why: r.why }));
    const row = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    ok(row.unit === 'usd' && row.amount === 200 && row.state === 'pending' && row.trusted === true, 'a PENDING dollar row, taken on trust', JSON.stringify(row));
    ok(t.rx.W.keptIn('usd') === 200 && t.rx.W.trustedWaitingSats() === 0 && t.rx.W.trustedWaiting()[0].unit === 'usd',
      'kept in dollars, and never counted as sats taken on trust');
    // the payer gets a route and takes its token back
    goOnline(t.payer);
    await t.payer.W.reclaimToken(r.made ? r.made.token : '').catch(() => {});
    goOnline(t.rx);
    await t.rx.W.claimUnclaimed();
    const failedRow = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    ok(lost.length === 1 && lost[0].unit === 'usd' && lost[0].amount === 200 && lost[0].sats === 0, 'the person is told, in dollars', JSON.stringify(lost));
    ok(failedRow.state === 'failed' && failedRow.unit === 'usd' && /taken back/.test(failedRow.memo), 'and the row says taken back, in dollars', JSON.stringify(failedRow));
    ok(t.rx.W.keptIn('usd') === 0, 'nothing is counted for it any more');
  }

  // ---- 8. mixed units --------------------------------------------------------------------
  {
    const t = await pair({ payerUsd: [1000], payerSat: 1000 });
    const usdReq = t.rx.W.decodeRequest(t.rx.W.paymentRequest(16, { unit: 'usd' })) || {};
    const satTok = await t.payer.W.sendToken(16, { unit: 'sat' });
    const ps = t.payer.W.tokenInfo(satTok.token).proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C }));
    await t.rx.W._requestPaid(JSON.stringify({ id: usdReq.id, mint: MINT, unit: 'usd', proofs: ps }), 'm-1');
    await until(() => t.rx.answers.some((a) => a.answer === 'm-1'));
    const a1 = t.rx.answers.find((a) => a.answer === 'm-1') || {};
    ok(a1.status === 422 && a1.text === 'That payment is not in dollars.', 'sat pieces called dollars, to a dollar request: "not in dollars"', JSON.stringify(a1));
    await t.rx.W._requestPaid(JSON.stringify({ id: usdReq.id, mint: MINT, unit: 'sat', proofs: ps }), 'm-2');
    await until(() => t.rx.answers.some((a) => a.answer === 'm-2'));
    const a2 = t.rx.answers.find((a) => a.answer === 'm-2') || {};
    ok(a2.status === 422 && a2.text === 'That payment is not in dollars.', 'and sats sent as sats to a dollar request: the same', JSON.stringify(a2));
    ok(t.rx.W.balanceOf('usd') === 0 && t.rx.W.balanceOf('sat') === 0, 'nothing taken');
    await t.payer.W.reclaimToken(satTok.token);
  }
  {
    // the scan door, offline: dollar ecash locked to a sat request's key
    const t = await pair({ payerUsd: [1000], rxOffline: true });
    const satReq = t.rx.W.decodeRequest(t.rx.W.paymentRequest(50, { unit: 'sat' })) || {};
    const tok = await t.payer.W.sendToken(50, { unit: 'usd', lockTo: satReq.lockTo });
    const said = await why(() => t.rx.W.receiveToken(tok.token));
    ok(said === 'That ecash is in dollars and the request was for bitcoin, so it was not taken. It is still theirs.',
      'dollars locked to a sat request are refused offline, in words', said);
    ok(t.rx.W.keptIn('usd') === 0 && t.rx.W.unclaimedSats() === 0, 'and nothing is kept');
    noBooks(t.payer, 'a locked token left with a phone that would not take it');
  }

  // ---- 9. the DLEQ, against the dollar keyset kept for the mint --------------------------
  {
    const t = await pair({ payerUsd: [1000], rxOffline: true });
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { unit: 'usd' })) || {};
    const tok = await t.payer.W.sendToken(100, { unit: 'usd', lockTo: ask.lockTo });
    const proofs = t.payer.W.tokenInfo(tok.token).proofs;
    ok(proofs.every((p) => p.dleq), 'the payer\'s locked dollars carry their DLEQ');
    const forged = proofs.map((p) => Object.assign({}, p, { dleq: Object.assign({}, p.dleq, { s: p.dleq.s.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }) }));
    await t.rx.W._requestPaid(JSON.stringify({ id: ask.id, mint: MINT, unit: 'usd', proofs: forged }), 'f-1');
    await until(() => t.rx.answers.some((a) => a.answer === 'f-1'));
    const a = t.rx.answers.find((x) => x.answer === 'f-1') || {};
    ok(a.status === 422 && /signatures do not match/.test(a.text) && t.rx.W.keptIn('usd') === 0, 'a forged dollar DLEQ is refused offline', JSON.stringify(a));
    // an intent naming a keyset this phone does not hold is a no
    t.rx.link = { up: true, log: [], payer: t.payer, receiver: t.rx };
    t.payer.link = t.rx.link;
    const no = await t.payer.W.askFirst(Object.assign({}, ask, { unit: 'usd', amount: 100 }), { locked: true }).then((x) => x);
    ok(no.go === true, 'an intent on the dollar keyset it holds is a go', JSON.stringify(no));
    // what the receiver answers other intents, by itself (M11)
    const answerTo = async (intend) => {
      const before = t.rx.terms.length;
      t.rx.W._tapQuote(JSON.stringify({ intend: Object.assign({ id: ask.id, mint: MINT, locked: true }, intend) }));
      await until(() => t.rx.terms.length > before);
      return JSON.parse(t.rx.terms[t.rx.terms.length - 1] || '{}');
    };
    const usdKeyset = t.shared.usdId, satKeyset = t.shared.id;
    const a1 = await answerTo({ unit: 'sat', amount: 100, sats: 100, keyset: satKeyset });
    ok(a1.go === false && a1.why === 'That payment would be in bitcoin; the request is for dollars.', 'an intent in bitcoin for a dollar request: no, in words', JSON.stringify(a1));
    const a2 = await answerTo({ unit: 'usd', amount: 75, keyset: usdKeyset });
    ok(a2.go === false && a2.why === 'That payment would be $ 0.75; the request is for $ 1.00.', 'short in dollars: no, in dollars', JSON.stringify(a2));
    const a3 = await answerTo({ unit: 'usd', amount: 100, keyset: '00' + 'f'.repeat(14) });
    ok(a3.go === false && /cannot check ecash from that keyset/.test(a3.why), 'a keyset it holds no keys for: no', JSON.stringify(a3));
    const a4 = await answerTo({ unit: 'usd', amount: 100, keyset: satKeyset });
    ok(a4.go === false && /cannot check ecash from that keyset/.test(a4.why), 'the sat keyset named for a dollar payment: no', JSON.stringify(a4));
    const a5 = await answerTo({ unit: 'usd', amount: 100, keyset: usdKeyset, locked: false });
    ok(a5.go === false && /only take ecash locked to it/.test(a5.why), 'unlocked, offline: no, as for sats', JSON.stringify(a5));
    const a6 = await answerTo({ unit: 'usd', amount: 100, keyset: usdKeyset });
    ok(a6.go === true, 'and the right one: go', JSON.stringify(a6));
    // a cold launch with no route: the keys come from the copy kept for the mint
    const carried = dump(t.rx);
    const cold = page({ storage: carried, mint: t.shared, phone: t.rx.phone });
    goOffline(cold);
    await cold.W.connect(MINT, null, null, { remember: true });
    const good = proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C, dleq: p.dleq }));
    await cold.W._requestPaid(JSON.stringify({ id: ask.id, mint: MINT, unit: 'usd', proofs: good }), 'c-1');
    await until(() => cold.answers.some((x) => x.answer === 'c-1'));
    const c1 = cold.answers.find((x) => x.answer === 'c-1') || {};
    ok(c1.status === 200 && cold.W.keptIn('usd') === 100, 'after a cold launch offline, a good dollar DLEQ verifies from the kept keys', JSON.stringify(c1));
    noBooks(t.rx, 'its storage went on in another page');
    goOnline(cold);
    await cold.W.claimUnclaimed();
    ok(sum(pile(cold, USD_PILE)) === 100, 'and is swapped in when there is a route');
    noBooks(cold, 'opened over another page\'s storage');
  }

  // ---- 10. the same ecash by two doors -----------------------------------------------------
  {
    const t = await pair({ payerUsd: [1000], rxOffline: true });
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { unit: 'usd' })) || {};
    const tok = await t.payer.W.sendToken(100, { unit: 'usd', lockTo: ask.lockTo });
    const got = await t.rx.W.receiveToken(tok.token);
    ok(got && got.kept && got.unit === 'usd' && got.amount === 100 && got.sats === 0, 'scanned offline: kept in dollars', JSON.stringify(got));
    const ps = t.payer.W.tokenInfo(tok.token).proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C, dleq: p.dleq }));
    await t.rx.W._requestPaid(JSON.stringify({ id: ask.id, mint: MINT, unit: 'usd', proofs: ps }), 'd-1');
    await until(() => t.rx.answers.some((a) => a.answer === 'd-1'));
    const a = t.rx.answers.find((x) => x.answer === 'd-1') || {};
    ok(a.status === 409 && t.rx.W.keptIn('usd') === 100, 'then tapped: 409, and taken once', JSON.stringify(a));
    ok(history(t.rx).filter((e) => e.dir === 'in').length === 1, 'one entry');
    goOnline(t.rx);
    await t.rx.W.claimUnclaimed();
  }

  // ---- 11. a refusal after the payment crossed: at risk, in dollars -----------------------
  {
    const t = await pair({ payerUsd: [128, 64, 8], payerOffline: true });
    const atRisk = [];
    t.payer.W.onAtRisk((ev) => atRisk.push(ev));
    const ask = t.rx.W.paymentRequest(200, { unit: 'usd' });
    const req = tapReq(t, ask, { asks: false });
    // a request the receiver does not have open, and no mint it can reach to send the payment back
    t.rx.deaf = true;
    const r = await pay(t, Object.assign({}, req, { id: 'ffffffff' }));
    ok(r.e && r.e.foxyAtRisk && r.e.foxyAtRisk.unit === 'usd' && r.e.foxyAtRisk.amount === 200 && r.e.foxyAtRisk.sats === 0,
      'refused after it crossed: the dollars are back, at risk, said in dollars', JSON.stringify(r.e && { risk: r.e.foxyAtRisk, why: r.why }));
    ok(t.payer.W.atRiskIn('usd') === 200 && t.payer.W.atRiskSats() === 0 && sum(pile(t.payer, USD_PILE)) === 200,
      'flagged in the dollar pile, never as sats', JSON.stringify({ usd: t.payer.W.atRiskIn('usd'), sat: t.payer.W.atRiskSats() }));
    goOnline(t.payer);
    await t.payer.W.settleAtRisk();
    ok(atRisk.length === 1 && atRisk[0].state === 'safe' && atRisk[0].unit === 'usd' && atRisk[0].amount === 200,
      'with a route they are swapped for pieces nobody has seen, in dollars', JSON.stringify(atRisk));
    ok(t.payer.W.atRiskIn('usd') === 0 && sum(pile(t.payer, USD_PILE)) === 200, 'and the flag is gone', String(sum(pile(t.payer, USD_PILE))));
  }
  {
    // the other ending: the phone that said no redeemed them meanwhile
    const t = await pair({ payerUsd: [128, 64, 8], payerOffline: true });
    const atRisk = [];
    t.payer.W.onAtRisk((ev) => atRisk.push(ev));
    const req = tapReq(t, t.rx.W.paymentRequest(200, { unit: 'usd' }), { asks: false, id: 'eeeeeeee' });
    t.rx.deaf = true;
    const r = await pay(t, req);
    t.rx.deaf = false;
    // the payment as it crossed the link (M5), as the phone that said no still holds it
    const body = JSON.parse(t.L.lastBody || '{}');
    const token = t.rx.window.CashuTS.getEncodedToken({ mint: MINT, unit: body.unit, proofs: body.proofs || [] });
    void r;
    await t.rx.W.receiveToken(token);
    goOnline(t.payer);
    await t.payer.W.settleAtRisk();
    ok(atRisk.length === 1 && atRisk[0].state === 'taken' && atRisk[0].unit === 'usd' && atRisk[0].amount === 200,
      'redeemed after the refusal: said taken, in dollars', JSON.stringify(atRisk));
    const row = history(t.payer).filter((e) => e.dir === 'out')[0] || {};
    ok(row.unit === 'usd' && row.amount === 200 && /taken after a refusal/.test(row.memo) && sum(pile(t.payer, USD_PILE)) === 0,
      'and the payer\'s entry says paid, in dollars', JSON.stringify(row));
  }

  // ---- 12. a locked dollar payment whose answer was lost, or that Foxy was killed in -------
  {
    const t = await pair({ payerUsd: [1000], rxOffline: true });
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    t.payer.lose = /\/v1\/swap$/;
    const r = await pay(t, tapReq(t, text));
    await settle(300);
    ok(!!r.made && r.made.unit === 'usd' && t.rx.W.keptIn('usd') === 200, 'a lost answer is found at the mint, and the payment goes on', r.why);
    ok(t.payer.W.balanceOf('usd') === 800, 'the payer is out exactly $ 2.00', String(t.payer.W.balanceOf('usd')));
    goOnline(t.rx);
    await t.rx.W.claimUnclaimed();
  }
  {
    const payer = await connected({ words: WORDS_B });
    await fund(payer, 1000, 'usd');
    const rxKey = payer.W._lockPubOf('2'.repeat(64));
    payer.never = /\/v1\/swap$/;
    payer.W.sendToken(200, { unit: 'usd', lockTo: rxKey }).catch(() => {});
    await settle(200);
    const carried = dump(payer);
    noBooks(payer, 'killed with a swap at the mint');
    const again = page({ storage: carried, mint: payer.mint, phone: payer.phone, words: WORDS_B });
    const rebuilt = [];
    again.W.onSendRebuilt((ev) => rebuilt.push(ev));
    await again.W.connect(MINT, null, null, { remember: true });
    await again.W.recoverSwaps();
    await settle(200);
    const row = history(again).filter((e) => e.dir === 'out')[0] || {};
    const tag = row.hash ? again.W.tagsFor(row.hash) : {};
    ok(row.unit === 'usd' && row.amount === 200 && tag.interrupted === true && typeof tag.token === 'string',
      'killed in a locked dollar payment: rebuilt on reopening, on a dollar entry with its token', JSON.stringify(row));
    const info = tag.token ? again.W.tokenInfo(tag.token) : null;
    ok(info && info.unit === 'usd' && info.amount === 200, 'the token is the dollars that left', JSON.stringify(info && { unit: info.unit, amount: info.amount }));
    ok(again.W.balanceOf('usd') === 800, 'and nothing else was lost', String(again.W.balanceOf('usd')));
  }

  // ---- 13. the sweep's failures -------------------------------------------------------------
  {
    const t = await pair({ payerUsd: [1000], rxOffline: true });
    const r = await pay(t, tapReq(t, t.rx.W.paymentRequest(150, { unit: 'usd' })));
    await settle(200);
    ok(!!r.made && t.rx.W.keptIn('usd') === 150, 'a dollar payment is kept offline', r.why);
    // a route, but the mint does not answer: the row stays
    goOnline(t.rx);
    t.rx.deaf = true;
    await t.rx.W.claimUnclaimed();
    ok(t.rx.W.keptIn('usd') === 150, 'a claim that could not reach the mint keeps its row');
    // another phone with the same words takes it first: spent, so the row goes
    t.rx.deaf = false;
    const twin = page({ mint: t.shared, phone: t.rx.phone });
    await twin.W.connect(MINT, null, null, { remember: true });
    const row = Object.values(kept(t.rx))[0];
    await twin.W.receiveToken(row.token);
    noBooks(twin, 'took a payment another page kept');
    await t.rx.W.claimUnclaimed();
    ok(t.rx.W.keptIn('usd') === 0, 'a claim the mint says is spent drops its row');
    noBooks(t.rx, 'its payment was taken by the twin');
  }
  {
    // a dollar row nothing here can open: stranded, still counted in dollars only
    const c = await connected({});
    await fund(c, 300, 'usd');
    const tok = await c.W.sendToken(100, { unit: 'usd', lockTo: G });
    noBooks(c, 'a row put in behind the wallet\'s back');
    const all = kept(c);
    all['strand-1'] = { token: tok.token, at: Date.now(), amount: 100, unit: 'usd', mint: MINT };
    c.storage.setItem('foxy.req.unclaimed', JSON.stringify(all));
    await c.W.claimUnclaimed();
    const row = kept(c)['strand-1'] || {};
    ok(row.stranded === true && c.W.keptIn('usd') === 100 && c.W.unclaimedSats() === 0,
      'a dollar row locked to a key this seed does not hold is stranded, and counted in dollars only', JSON.stringify(row));
  }

  // ---- 14. a row from before units: read as sats ----------------------------------------------
  {
    const c = await connected({});
    await fund(c, 64, 'sat');
    const tok = await c.W.sendToken(32, { unit: 'sat' });
    noBooks(c, 'a row put in behind the wallet\'s back');
    c.storage.setItem('foxy.req.unclaimed', JSON.stringify({ old: { token: tok.token, at: Date.now(), sats: 32 } }));
    ok(c.W.unclaimedSats() === 32 && c.W.keptIn('usd') === 0 && c.W.keptIn('sat') === 32, 'a kept row with no unit is sats, as it always was');
  }


  /* ---- review: the money, case by case, with the stub two-unit mint ----------------------
   *
   * What the cases above leave open: a mint that charges for dollar pieces
   * and not for sats; phones that were closed and opened again with no
   * route; a dollar row and a sat row of the same size side by side; a sweep
   * whose answer is lost; a short payment sent back in its own unit; a
   * receiver that loses its route between taking an over-payment and making
   * the change. Every page is judged per unit as the suite ends. */

  // ---- 15. a mint that charges for dollar pieces, and not for sats -------------------------
  {
    const fees = { usdFeePpk: 400 };
    const t = await pair({ payerUsd: [1000], payerSat: 300, rxOffline: true, mintOpts: fees });
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    const satBefore = t.payer.W.balanceOf('sat');
    const r = await pay(t, tapReq(t, text));
    await settle(300);
    const ans = t.rx.answers[t.rx.answers.length - 1] || {};
    ok(!!r.made && ans.status === 200, 'at a mint with a dollar fee: the offline receiver takes locked dollars', r.why || JSON.stringify(ans));
    const kRow = Object.values(kept(t.rx))[0] || {};
    const entry = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    ok(kRow.unit === 'usd' && entry.unit === 'usd' && entry.amount === 200,
      'kept in dollars, and the entry is what was asked: the payer covered the fee for taking it', JSON.stringify({ row: kRow.amount, entry: entry.amount }));
    ok(t.payer.W.balanceOf('sat') === satBefore && t.rx.W.balanceOf('sat') === 0, 'no sat moved, on either phone, for a dollar fee');
    goOnline(t.rx);
    await t.rx.W.claimUnclaimed();
    const after = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    ok(t.rx.W.keptIn('usd') === 0 && sum(pile(t.rx, USD_PILE)) === after.amount && after.amount >= 200,
      'swapped in: the dollar pile is what the entry says, at least $ 2.00', JSON.stringify({ pile: sum(pile(t.rx, USD_PILE)), entry: after.amount }));
  }
  {
    // the offline payer over-pays at that mint: both phones do the same sum for the change, in cents
    const fees = { usdFeePpk: 400 };
    const t = await pair({ payerUsd: [256], rxUsd: 0, payerOffline: true, mintOpts: fees });
    payerTakesChange(t.payer, 'usd');
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    const r = await pay(t, tapReq(t, text), { overpayOk: true });
    ok(!!r.made && r.made.unit === 'usd' && r.made.amount === 256, 'at a fee mint, an offline payer with one piece pays $ 2.56 for $ 2.00', r.why);
    if (r.made) { t.payer.lastHash = r.made.hash; t.payer.owed = r.made.over; }
    await until(() => (t.payer.changes || []).length > 0 && t.L.log.some((l) => /^M8/.test(l)));
    await settle(200);
    const ch = (t.payer.changes || [])[0] || {};
    ok(ch.chk && ch.chk.ok && ch.chk.unit === 'usd' && ch.amount > 0 && ch.amount <= 56,
      'change comes back in dollars, no more than was paid over', JSON.stringify(ch));
    const rrow = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    /* What it cost to make the change beyond what was allowed for lands on the
     * receiver's entry as a fee, and what it cost less stays on it, as for
     * sats at the same mint (a sat run of this case keeps 197 to 201 of 200
     * too, by the pieces the pile happens to hold): the entry and the pile
     * agree, in cents. */
    ok(rrow.unit === 'usd' && sum(pile(t.rx, USD_PILE)) === rrow.amount
      && rrow.amount >= 200 - 8 && rrow.grossAmount === 256 && rrow.changeAmount === 55 && rrow.grossSats === undefined && rrow.changeSats === undefined,
      'the receiver\'s pile is its entry, with its figures in cents', JSON.stringify({ entry: rrow, pile: sum(pile(t.rx, USD_PILE)) }));
    ok(sum(pile(t.rx, SAT_PILE)) === 0 && t.payer.W.unclaimedSats() === 0, 'and nothing of it is anywhere in sats');
  }

  {
    // an offline payer at that mint whose pieces make $ 2.00 exactly: the receiver's fee for taking them is the payer's
    const fees = { usdFeePpk: 400 };
    const t = await pair({ payerUsd: [128, 64, 8, 4, 2, 1], payerOffline: true, mintOpts: fees });
    payerTakesChange(t.payer, 'usd');
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    let r = await pay(t, tapReq(t, text));
    if (r.e && r.e.foxyNeedsOverpay) {
      ok(r.e.foxyNeedsOverpay.unit === 'usd' && r.e.foxyNeedsOverpay.asked === 200, 'no pieces make $ 2.00 and the fee: the person is asked, in cents', JSON.stringify(r.e.foxyNeedsOverpay));
      r = await pay(t, tapReq(t, text), { overpayOk: true });
    }
    if (r.made) { t.payer.lastHash = r.made.hash; t.payer.owed = r.made.over; }
    await settle(600);
    const ans = t.rx.answers[t.rx.answers.length - 1] || {};
    const rrow = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    ok(!!r.made && ans.status === 200 && rrow.unit === 'usd' && sum(pile(t.rx, USD_PILE)) === rrow.amount && rrow.amount >= 200 - 8,
      'paid at a fee mint with no route: taken, in dollars, the pile is the entry', r.why || JSON.stringify({ ans, rrow, pile: sum(pile(t.rx, USD_PILE)) }));
    ok(t.payer.W.balanceOf('sat') === 0 && t.rx.W.balanceOf('sat') === 0, 'and no sat anywhere');
  }

  // ---- 16. two phones that were closed and opened again, with no route --------------------
  {
    // the payer: dollars in its pile and dollars it was paid locked, opened cold in airplane mode
    const q = await connected({ words: WORDS_C });
    const shared = q.mint;
    await fund(q, 1000, 'usd');
    const p = await connected({ mint: shared });
    await fund(p, 100, 'usd');   // 64 + 32 + 4
    await p.W.primeLocks();
    const r = await connected({ mint: shared, words: WORDS_B });
    await r.W.primeLocks();
    goOffline(p); await p.W.connect(MINT, null, null, { remember: true });
    const ask = p.W.decodeRequest(p.W.paymentRequest(300, { unit: 'usd' })) || {};
    const L1 = link(); L1.payer = q; L1.receiver = p; q.link = L1; p.link = L1;
    const paid = await q.W.payRequest(Object.assign({}, ask, { viaTap: true, theirRoute: false, asks: true }), () => {}).catch((e) => ({ e }));
    await settle(300);
    ok(paid && paid.token && p.W.keptIn('usd') === 300, 'P, offline, kept $ 3.00 locked to it', paid && paid.e && paid.e.message);
    const carried = dump(p);
    noBooks(p, 'its storage goes on in another page');
    const cold = page({ storage: carried, mint: shared, phone: p.phone });
    goOffline(cold);
    await cold.W.connect(MINT, null, null, { remember: true });
    ok(cold.W.balanceOf('usd') === 400 && cold.W.keptIn('usd') === 300 && cold.W.balanceOf('sat') === 0,
      'opened again with no route: $ 4.00 in all, $ 3.00 of it kept, and no sats', JSON.stringify({ usd: cold.W.balanceOf('usd'), kept: cold.W.keptIn('usd') }));
    // exact from the pile, with no route since it was opened
    const L2 = link(); L2.payer = cold; L2.receiver = r; cold.link = L2; r.link = L2;
    const t2 = { rx: r, payer: cold };
    const a = await pay(t2, tapReq(t2, r.W.paymentRequest(68, { unit: 'usd' })));
    await until(() => sum(pile(r, USD_PILE)) === 68);
    ok(!!a.made && a.made.unit === 'usd' && !a.made.swapped && sum(pile(r, USD_PILE)) === 68,
      'a phone opened offline pays exact dollar pieces from its pile', a.why);
    // and from what it was paid locked, signed on with no route
    const b = await pay(t2, tapReq(t2, r.W.paymentRequest(300, { unit: 'usd' })));
    await until(() => sum(pile(r, USD_PILE)) === 368);
    ok(!!b.made && b.made.amount === 300 && sum(pile(r, USD_PILE)) === 368 && cold.W.keptIn('usd') === 0,
      'and hands on the dollars it was paid locked, whole', b.why || JSON.stringify({ r: sum(pile(r, USD_PILE)), kept: cold.W.keptIn('usd') }));
    ok(cold.W.balanceOf('usd') === 32 && cold.W.balanceOf('sat') === 0, 'leaving $ 0.32, in dollars only', String(cold.W.balanceOf('usd')));
    goOnline(cold);
    await cold.W.claimUnclaimed();
    noBooks(cold, 'opened over another page\'s storage');
  }
  {
    // the receiver opened cold with no route, and an over-payment in dollars: kept, never asked to make change
    const t = await pair({ payerUsd: [256] });
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(200, { unit: 'usd' })) || {};
    const carried = dump(t.rx);
    noBooks(t.rx, 'its storage goes on in another page');
    const cold = page({ storage: carried, mint: t.shared, phone: t.rx.phone });
    goOffline(cold);
    await cold.W.connect(MINT, null, null, { remember: true });
    t.L.receiver = cold; cold.link = t.L;
    const r = await pay({ rx: cold, payer: t.payer }, Object.assign({}, ask, { viaTap: true, theirRoute: false, asks: true }));
    await settle(300);
    const ans = cold.answers[cold.answers.length - 1] || {};
    ok(!!r.made && ans.status === 200 && cold.W.keptIn('usd') === 200 && cold.W.unclaimedSats() === 0,
      'a receiver opened offline takes locked dollars, checked against the keys it kept', r.why || JSON.stringify(ans));
    goOnline(cold);
    await cold.W.claimUnclaimed();
    ok(sum(pile(cold, USD_PILE)) === 200 && sum(pile(cold, SAT_PILE)) === 0, 'and swaps them into dollars when it has a route');
    noBooks(cold, 'opened over another page\'s storage');
  }

  // ---- 17. a dollar row and a sat row of the same size -------------------------------------
  {
    const q = await connected({ words: WORDS_C });
    const shared = q.mint;
    await fund(q, 1000, 'usd');
    await fund(q, 1000, 'sat');
    const p = await connected({ mint: shared });
    await p.W.primeLocks();
    const r = await connected({ mint: shared, words: WORDS_B });
    await r.W.primeLocks();
    goOffline(p); await p.W.connect(MINT, null, null, { remember: true });
    const usdAsk = p.W.decodeRequest(p.W.paymentRequest(44, { unit: 'usd' })) || {};
    const satAsk = p.W.decodeRequest(p.W.paymentRequest(44, { unit: 'sat' })) || {};
    const L1 = link(); L1.payer = q; L1.receiver = p; q.link = L1; p.link = L1;
    await q.W.payRequest(Object.assign({}, usdAsk, { viaTap: true, theirRoute: false, asks: true }), () => {}).catch(() => {});
    await q.W.payRequest(Object.assign({}, satAsk, { viaTap: true, theirRoute: false, asks: true }), () => {}).catch(() => {});
    await settle(300);
    ok(p.W.keptIn('usd') === 44 && p.W.unclaimedSats() === 44, 'P holds 44 cents and 44 sats, kept, and no pile');
    const L2 = link(); L2.payer = p; L2.receiver = r; p.link = L2; r.link = L2;
    const t = { rx: r, payer: p };
    const a = await pay(t, tapReq(t, r.W.paymentRequest(44, { unit: 'sat' })));
    await until(() => sum(pile(r, SAT_PILE)) === 44);
    ok(!!a.made && a.made.unit !== 'usd' && sum(pile(r, SAT_PILE)) === 44 && sum(pile(r, USD_PILE)) === 0,
      'a sat request of the same size is paid from the sat row', a.why);
    ok(p.W.keptIn('usd') === 44 && p.W.unclaimedSats() === 0, 'and the dollar row is untouched', JSON.stringify({ usd: p.W.keptIn('usd'), sat: p.W.unclaimedSats() }));
    const e = await caught(() => p.W.payRequest(tapReq(t, r.W.paymentRequest(44, { unit: 'sat' })), () => {}));
    ok(e && e.foxyNeedsMint && e.foxyNeedsMint.unit === 'sat', 'a second sat request: NEEDS THE MINT, the dollars are not spent for it', e && e.message);
    const b = await pay(t, tapReq(t, r.W.paymentRequest(44, { unit: 'usd' })));
    await until(() => sum(pile(r, USD_PILE)) === 44);
    ok(!!b.made && b.made.unit === 'usd' && sum(pile(r, USD_PILE)) === 44 && sum(pile(r, SAT_PILE)) === 44,
      'and a dollar request of the same size from the dollar row, into the receiver\'s dollars', b.why);
    goOnline(p);
    await p.W.claimUnclaimed();
  }

  // ---- 18. a sweep whose answer is lost, and a phone killed in one -------------------------
  {
    const t = await pair({ payerUsd: [1000], rxOffline: true });
    const r = await pay(t, tapReq(t, t.rx.W.paymentRequest(200, { unit: 'usd' })));
    await settle(200);
    ok(!!r.made && t.rx.W.keptIn('usd') === 200, 'kept offline in dollars', r.why);
    goOnline(t.rx);
    t.rx.lose = /\/v1\/swap$/;
    await t.rx.W.claimUnclaimed().catch(() => {});
    await settle(300);
    await t.rx.W.recoverSwaps().catch(() => {});
    await t.rx.W.claimUnclaimed().catch(() => {});
    await settle(300);
    const rows = history(t.rx).filter((e) => e.dir === 'in');
    ok(sum(pile(t.rx, USD_PILE)) === 200 && t.rx.W.keptIn('usd') === 0 && t.rx.W.balanceOf('usd') === 200,
      'the swap made and its answer lost: $ 2.00 in the dollar pile once, and the row gone',
      JSON.stringify({ pile: sum(pile(t.rx, USD_PILE)), kept: t.rx.W.keptIn('usd'), bal: t.rx.W.balanceOf('usd') }));
    ok(rows.length === 1 && rows[0].unit === 'usd' && rows[0].amount === 200 && sum(pile(t.rx, SAT_PILE)) === 0,
      'one entry, in dollars, and no sats', JSON.stringify(rows));
  }
  {
    const t = await pair({ payerUsd: [1000], rxOffline: true });
    const r = await pay(t, tapReq(t, t.rx.W.paymentRequest(150, { unit: 'usd' })));
    await settle(200);
    ok(!!r.made && t.rx.W.keptIn('usd') === 150, 'kept offline in dollars', r.why);
    goOnline(t.rx);
    t.rx.never = /\/v1\/swap$/;
    t.rx.W.claimUnclaimed().catch(() => {});
    await settle(200);
    const carried = dump(t.rx);
    noBooks(t.rx, 'killed in the sweep; its storage goes on in another page');
    const again = page({ storage: carried, mint: t.shared, phone: t.rx.phone });
    await again.W.connect(MINT, null, null, { remember: true });
    await again.W.recoverSwaps().catch(() => {});
    await settle(200);
    ok(again.W.balanceOf('usd') <= 150, 'opened again after a sweep killed at the mint: never counted twice',
      JSON.stringify({ bal: again.W.balanceOf('usd'), pile: sum(pile(again, USD_PILE)), kept: again.W.keptIn('usd') }));
    await again.W.claimUnclaimed().catch(() => {});
    await settle(300);
    ok(sum(pile(again, USD_PILE)) === 150 && again.W.keptIn('usd') === 0 && again.W.balanceOf('usd') === 150 && sum(pile(again, SAT_PILE)) === 0,
      'and once swept: $ 1.50 in the dollar pile, once', JSON.stringify({ pile: sum(pile(again, USD_PILE)), kept: again.W.keptIn('usd') }));
    const rows = history(again).filter((e) => e.dir === 'in');
    ok(rows.length === 1 && rows[0].unit === 'usd' && rows[0].amount === 150, 'one entry, in dollars', JSON.stringify(rows));
    noBooks(again, 'opened over another page\'s storage');
  }

  // ---- 19. a short dollar payment, sent back in dollars ------------------------------------
  {
    const t = await pair({ payerUsd: [128, 16, 8], payerSat: 200, payerOffline: true });
    payerTakesChange(t.payer, 'usd');
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    const satRx = t.rx.W.balanceOf('sat');
    // a payer that read the request as $ 1.52 (an older phone, or a wrong one): not asked first
    const r = await pay(t, tapReq(t, text, { amount: 152, asks: false }));
    await settle(500);
    ok(r.e && r.e.foxyRefunded && r.e.foxyRefunded.unit === 'usd' && r.e.foxyRefunded.sats === 0,
      'refused as short, and sent back locked to the payer, in dollars', JSON.stringify(r.e && { refunded: r.e.foxyRefunded, risk: r.e.foxyAtRisk, why: r.why }));
    ok(t.rx.W.balanceOf('usd') === 0 && t.rx.W.balanceOf('sat') === satRx && t.rx.W.keptIn('usd') === 0,
      'the receiver keeps none of it, in either unit', JSON.stringify({ usd: t.rx.W.balanceOf('usd'), sat: t.rx.W.balanceOf('sat') }));
    ok(t.payer.W.keptIn('usd') > 0 && t.payer.W.keptIn('usd') <= 152 && t.payer.W.unclaimedSats() === 0 && t.payer.W.balanceOf('sat') === 200,
      'the offline payer keeps the refund in dollars; its sats are as they were', JSON.stringify({ kept: t.payer.W.keptIn('usd'), sat: t.payer.W.balanceOf('sat') }));
    goOnline(t.payer);
    await t.payer.W.claimUnclaimed();
    ok(sum(pile(t.payer, USD_PILE)) === t.payer.W.balanceOf('usd') && t.payer.W.keptIn('usd') === 0 && sum(pile(t.payer, SAT_PILE)) === 200,
      'swapped back into its dollars', String(sum(pile(t.payer, USD_PILE))));
  }

  // ---- 20. the receiver loses its route between taking an over-payment and the change -------
  {
    const t = await pair({ payerUsd: [256], payerOffline: true });
    const text = t.rx.W.paymentRequest(200, { unit: 'usd' });
    let swaps = 0;
    t.rx.onMint = (url) => { if (/\/v1\/swap$/.test(url) && ++swaps === 1) setTimeout(() => goOffline(t.rx), 0); };
    const r = await pay(t, tapReq(t, text), { overpayOk: true });
    await settle(600);
    t.rx.onMint = null;
    ok(!!r.made && r.made.over === 56, 'an offline payer over-pays $ 0.56 to an online receiver', r.why);
    const rrow = history(t.rx).filter((e) => /^req-/.test(e.hash))[0] || {};
    ok(sum(pile(t.rx, USD_PILE)) === 256 && rrow.unit === 'usd' && rrow.amount === 256,
      'no route for the change: the receiver holds the lot, and its entry says so', JSON.stringify({ pile: sum(pile(t.rx, USD_PILE)), entry: rrow }));
    ok(t.rx.W.balanceOf('usd') === 256 && t.rx.W.balanceOf('sat') === 0, 'counted once, in dollars', String(t.rx.W.balanceOf('usd')));
    goOnline(t.rx);
  }

  // ---- 22. dollars handed on from a kept row, refused, and taken back ---------------------
  {
    const q = await connected({ words: WORDS_C });
    const shared = q.mint;
    await fund(q, 1000, 'usd');
    const p = await connected({ mint: shared });
    await p.W.primeLocks();
    const r = await connected({ mint: shared, words: WORDS_B });
    await r.W.primeLocks();
    goOffline(p); await p.W.connect(MINT, null, null, { remember: true });
    const ask = p.W.decodeRequest(p.W.paymentRequest(300, { unit: 'usd' })) || {};
    const L1 = link(); L1.payer = q; L1.receiver = p; q.link = L1; p.link = L1;
    await q.W.payRequest(Object.assign({}, ask, { viaTap: true, theirRoute: false, asks: true }), () => {}).catch(() => {});
    await settle(300);
    ok(p.W.keptIn('usd') === 300, 'P kept $ 3.00 locked to it, offline');
    const taken = [];
    p.W.onTakenBack((ev) => taken.push(ev));
    const L2 = link(); L2.payer = p; L2.receiver = r; p.link = L2; r.link = L2;
    const t = { rx: r, payer: p };
    // a request R no longer has open: refused after it crossed, and R cannot spend pieces locked to P
    const req = tapReq(t, r.W.paymentRequest(300, { unit: 'usd' }), { asks: false, id: 'dddddddd' });
    const out = await pay(t, req);
    ok(out.e && out.e.foxyAtRisk && out.e.foxyAtRisk.onEntry === true && out.e.foxyAtRisk.unit === 'usd' && out.e.foxyAtRisk.amount === 300,
      'refused: the signed-on dollars stay on the payment\'s entry, said in dollars', JSON.stringify(out.e && out.e.foxyAtRisk) + ' ' + out.why);
    ok(p.W.balanceOf('usd') === 0 && p.W.balanceOf('sat') === 0 && sum(pile(r, USD_PILE)) === 0, 'nothing is counted for them meanwhile, in either unit',
      JSON.stringify({ usd: p.W.balanceOf('usd'), sat: p.W.balanceOf('sat') }));
    goOnline(p);
    await p.W.takeBackRefused();
    await settle(200);
    ok(sum(pile(p, USD_PILE)) === 300 && sum(pile(p, SAT_PILE)) === 0 && p.W.balanceOf('usd') === 300,
      'with a route they are taken back into the dollar pile', JSON.stringify({ usd: sum(pile(p, USD_PILE)), sat: sum(pile(p, SAT_PILE)) }));
    ok(taken.length === 1 && taken[0].unit === 'usd' && taken[0].amount === 300 && taken[0].sats === 0, 'and the person is told in dollars', JSON.stringify(taken));
  }

  // ---- 23. dollars taken on trust (the switch on), and the payer does not spend them back ----
  {
    const t = await pair({ payerUsd: [128, 64, 8], rxOffline: true, payerOffline: true });
    t.rx.W._offlineToOffline(true); t.payer.W._offlineToOffline(true);
    const settled = [];
    t.rx.W.onOfflineOffer(() => Promise.resolve(true));
    t.rx.W.onTrustSettled((ev) => settled.push(ev));
    const r = await pay(t, tapReq(t, t.rx.W.paymentRequest(200, { unit: 'usd' }), { asks: false }));
    await settle(300);
    ok(!!r.made && t.rx.W.keptIn('usd') === 200 && t.rx.W.balanceOf('sat') === 0, 'taken on trust, in dollars', r.why);
    goOnline(t.rx);
    await t.rx.W.claimUnclaimed();
    const row = history(t.rx).filter((e) => /^req-/.test(e.hash));
    ok(sum(pile(t.rx, USD_PILE)) === 200 && t.rx.W.keptIn('usd') === 0 && sum(pile(t.rx, SAT_PILE)) === 0,
      'with a route it is swapped into the dollar pile', String(sum(pile(t.rx, USD_PILE))));
    ok(row.length === 1 && row[0].unit === 'usd' && row[0].amount === 200 && row[0].state === 'success' && row[0].settled === true,
      'the PENDING dollar row is now a payment, settled, in cents', JSON.stringify(row));
    ok(settled.length === 1 && settled[0].unit === 'usd' && settled[0].amount === 200 && settled[0].sats === 0, 'and the person is told so, in dollars', JSON.stringify(settled));
    // the payer's dollars are gone for good: its own entry, in dollars
    const out = history(t.payer).filter((e) => e.dir === 'out')[0] || {};
    ok(out.unit === 'usd' && out.amount === 200 && t.payer.W.balanceOf('usd') === 0, 'the payer\'s entry is $ 2.00, in dollars', JSON.stringify(out));
  }

  // ---- 24. dollar change that did not come over the link, scanned with no route -------------
  {
    const t = await pair({ payerUsd: [256], payerOffline: true });
    // no change handler on the payer: what came over the link is not kept, as when it was put away
    const r = await pay(t, tapReq(t, t.rx.W.paymentRequest(200, { unit: 'usd' })), { overpayOk: true });
    await settle(400);
    ok(!!r.made && r.made.over === 56, 'an offline payer over-pays $ 0.56', r.why);
    const rrow = history(t.rx).filter((e) => /^req-/.test(e.hash) && e.changeAmount > 0)[0] || {};
    const code = (t.rx.W.tagsFor(rrow.hash) || {}).changeToken || '';
    const info = code ? t.payer.W.tokenInfo(code) : null;
    ok(!!info && info.unit === 'usd', 'the receiver made the change in dollars', JSON.stringify(info && { unit: info.unit, amount: info.amount }));
    const got = code ? await t.payer.W.receiveToken(code).then((x) => x, (e) => ({ why: String(e && e.message) })) : {};
    ok(got && got.kept === true && got.unit === 'usd' && t.payer.W.keptIn('usd') === info.amount && t.payer.W.unclaimedSats() === 0,
      'the payer, offline, scans it: kept in dollars, locked to the key it gave for that change', JSON.stringify(got));
    goOnline(t.payer);
    await t.payer.W.claimUnclaimed();
    ok(sum(pile(t.payer, USD_PILE)) === (info ? info.amount : -1) && sum(pile(t.payer, SAT_PILE)) === 0, 'and swapped into its dollars with a route');
    noBooks(t.payer, 'the change was taken by a scan the app would file against its payment');
  }

  // ---- 25. no bitcoin price, anywhere in this suite ----------------------------------------------
  ok(everyPage.every((c) => c.actions.indexOf('price') < 0 && !c.priceAsked.length), 'no page in this suite asked for a bitcoin price',
    everyPage.map((c, i) => (c.actions.indexOf('price') >= 0 || c.priceAsked.length ? i + ':' + c.priceAsked.join('/') : '')).filter(Boolean).join(','));

  // ---- 26. money arriving: from PAID until the swap lands, in sats and in dollars -------------
  /* A phone in testing showed a balance of nought behind PAID, and an audit a
   * whole payment out ("balance 0, off by -1216"), for the seconds the proof
   * check and the swap took. The swap is held here at the mint's door, so
   * those seconds last as long as the test needs. */
  for (const unit of ['sat', 'usd']) {
    const say = (n) => (unit === 'usd' ? '$ ' + (n / 100).toFixed(2) : n + ' sats');
    const balance = async (c) => (unit === 'usd' ? c.W.balanceOf('usd') : c.W.balanceSats());
    const PILE = unit === 'usd' ? USD_PILE : SAT_PILE;
    const amount = unit === 'usd' ? 1216 : 1216;
    // paid, and held between PAID and the swap; then the swap lands
    {
      const t = await pair(unit === 'usd' ? { payerUsd: [2000] } : { payerSat: 2000 });
      const told = [];
      t.rx.W.onRequestPaid((ev) => told.push(ev.stage));
      let arrivingSaid = 0;
      t.rx.W._onArriving = () => { arrivingSaid += 1; };
      t.rx.hold = /\/v1\/swap$/;
      const r = pay(t, tapReq(t, t.rx.W.paymentRequest(amount, { unit, purpose: 'receive' })));
      await until(() => told.indexOf('paid') >= 0 && t.rx.held.length > 0, 4000);
      ok(told.indexOf('paid') >= 0 && t.rx.held.length === 1 && sum(pile(t.rx, PILE)) === 0, unit + ': PAID is shown, and the swap is at the mint\'s door',
        JSON.stringify({ told, held: t.rx.held.length }));
      ok(t.rx.W.arrivingIn(unit) === amount && t.rx.W.keptIn(unit) === 0, unit + ': ' + say(amount) + ' is arriving, and not counted as kept as well',
        JSON.stringify({ arriving: t.rx.W.arrivingIn(unit), kept: t.rx.W.keptIn(unit) }));
      ok(await balance(t.rx) === amount, unit + ': the balance behind PAID is the payment, not nought', String(await balance(t.rx)));
      ok((unit === 'usd' ? t.rx.W.balanceOf('sat') : t.rx.W.balanceOf('usd')) === 0, unit + ': and nothing in the other unit');
      const mid = await appAudit(t.rx);
      const book = unit === 'usd' ? mid.usd : mid.sat;
      ok(book.whole && book.off === 0 && book.arriving === amount, unit + ': the audit is off by 0, with the payment in its arriving bucket', JSON.stringify({ off: book.off, arriving: book.arriving }));
      ok(/arriving from the mint/.test(mid.pill) && mid.pill.indexOf(unit === 'usd' ? '$ 12.16' : '₿ 1216') >= 0, unit + ': home says it is arriving', mid.pill);
      ok(arrivingSaid >= 1, unit + ': and the screens are told (the balance is read again)', String(arrivingSaid));
      t.rx.hold = null;
      t.rx.held.splice(0).forEach((one) => one.go());
      await r;
      await until(() => sum(pile(t.rx, PILE)) === amount && !Object.keys(kept(t.rx)).length);
      ok(sum(pile(t.rx, PILE)) === amount && t.rx.W.arrivingIn(unit) === 0 && t.rx.W.keptIn(unit) === 0 && await balance(t.rx) === amount,
        unit + ': the swap lands: in the pile, nothing arriving, nothing kept, the balance the same', JSON.stringify({ pile: sum(pile(t.rx, PILE)), arriving: t.rx.W.arrivingIn(unit), kept: t.rx.W.keptIn(unit) }));
      const end = await appAudit(t.rx);
      const book2 = unit === 'usd' ? end.usd : end.sat;
      ok(book2.off === 0 && book2.arriving === 0 && !/arriving/.test(end.pill), unit + ': and the audit is off by 0 with nothing arriving', JSON.stringify({ off: book2.off, pill: end.pill }));
    }
    // the swap fails: back to kept, as before, and the audit still 0
    {
      const t = await pair(unit === 'usd' ? { payerUsd: [2000] } : { payerSat: 2000 });
      const told = [];
      t.rx.W.onRequestPaid((ev) => told.push(ev.stage));
      t.rx.hold = /\/v1\/swap$/;
      const r = pay(t, tapReq(t, t.rx.W.paymentRequest(amount, { unit, purpose: 'receive' })));
      await until(() => told.indexOf('paid') >= 0 && t.rx.held.length > 0, 4000);
      await r;
      ok(t.rx.W.arrivingIn(unit) === amount && t.rx.W.keptIn(unit) === 0, unit + ': arriving while the swap is out', String(t.rx.W.arrivingIn(unit)));
      t.rx.hold = null;
      t.rx.held.splice(0).forEach((one) => one.refuse('400\n' + JSON.stringify({ code: 11000, detail: 'Transaction is not valid.' })));
      await until(() => t.rx.W.arrivingIn(unit) === 0);
      await settle(100);
      ok(t.rx.W.arrivingIn(unit) === 0 && t.rx.W.keptIn(unit) === amount && Object.keys(kept(t.rx)).length === 1 && sum(pile(t.rx, PILE)) === 0,
        unit + ': the mint refuses the swap: nothing arriving, the payment kept as before', JSON.stringify({ arriving: t.rx.W.arrivingIn(unit), kept: t.rx.W.keptIn(unit) }));
      ok(await balance(t.rx) === amount, unit + ': and still in the balance, as kept', String(await balance(t.rx)));
      const after = await appAudit(t.rx);
      const book = unit === 'usd' ? after.usd : after.sat;
      ok(book.off === 0 && book.arriving === 0 && !/arriving/.test(after.pill), unit + ': the audit is off by 0', JSON.stringify({ off: book.off, pill: after.pill }));
      // and the next claim takes it, the same entry finished
      await t.rx.W.claimUnclaimed();
      ok(sum(pile(t.rx, PILE)) === amount && t.rx.W.keptIn(unit) === 0 && t.rx.W.arrivingIn(unit) === 0, unit + ': the next claim swaps it in',
        JSON.stringify({ pile: sum(pile(t.rx, PILE)), kept: t.rx.W.keptIn(unit) }));
      ok((await appAudit(t.rx))[unit === 'usd' ? 'usd' : 'sat'].off === 0, unit + ': and the audit is still 0');
    }
    // killed between PAID and the swap: nothing arriving on the next launch, the payment back in kept
    {
      const t = await pair(unit === 'usd' ? { payerUsd: [2000] } : { payerSat: 2000 });
      const told = [];
      t.rx.W.onRequestPaid((ev) => told.push(ev.stage));
      t.rx.hold = /\/v1\/swap$/;
      const r = pay(t, tapReq(t, t.rx.W.paymentRequest(amount, { unit, purpose: 'receive' })));
      await until(() => told.indexOf('paid') >= 0 && t.rx.held.length > 0, 4000);
      await r;
      ok(t.rx.W.arrivingIn(unit) === amount, unit + ': arriving as the page is killed', String(t.rx.W.arrivingIn(unit)));
      // what was on disk at that moment is what the next launch starts with; the killed page's request never reaches the mint
      const disk = dump(t.rx);
      noBooks(t.rx, 'killed with its swap out');
      const again = page({ storage: disk, mint: t.shared, phone: t.rx.phone });
      // opened with no route first, so what it starts with can be read before the claim on connect takes it
      goOffline(again);
      await again.W.connect(MINT, null, null, { remember: true });
      await settle(200);
      ok(again.W.arrivingIn(unit) === 0 && again.W.keptIn(unit) === amount && sum(pile(again, PILE)) === 0,
        unit + ': on the next launch nothing is arriving, and the payment is kept', JSON.stringify({ arriving: again.W.arrivingIn(unit), kept: again.W.keptIn(unit) }));
      ok(await balance(again) === amount, unit + ': the balance is the payment', String(await balance(again)));
      ok((await appAudit(again))[unit === 'usd' ? 'usd' : 'sat'].off === 0, unit + ': and the audit is 0');
      goOnline(again);
      await again.W.claimUnclaimed();
      // judged from here: it was opened on a payment kept, which its books do not hold as a pile
      rebook(again);
      ok(sum(pile(again, PILE)) === amount && again.W.keptIn(unit) === 0 && again.W.arrivingIn(unit) === 0 && await balance(again) === amount,
        unit + ': the claim on connect swaps it in', JSON.stringify({ pile: sum(pile(again, PILE)), kept: again.W.keptIn(unit) }));
      ok((await appAudit(again))[unit === 'usd' ? 'usd' : 'sat'].off === 0, unit + ': the audit is 0 after the swap');
    }
  }

  // ---- 27. money arriving, met by a second claim and by a busy mint ----------------------------
  /* Two things that can happen to a payment while it is arriving. A claim that
   * walks the kept list (a send's syncClaim, a route coming back) can reach the
   * same payment and swap it as well: the money is one payment however many
   * claims are swapping it, and it lands once. And the mint can answer the swap
   * "failed to acquire database lock": the swap is asked again, and the money is
   * arriving the whole time, never kept and arriving at once. */
  for (const unit of ['sat', 'usd']) {
    const balance = async (c) => (unit === 'usd' ? c.W.balanceOf('usd') : c.W.balanceSats());
    const PILE = unit === 'usd' ? USD_PILE : SAT_PILE;
    const amount = 640;
    const book = async (c) => (await appAudit(c))[unit === 'usd' ? 'usd' : 'sat'];
    // a second claim while the first is out
    {
      const t = await pair(unit === 'usd' ? { payerUsd: [2000] } : { payerSat: 2000 });
      const told = [];
      t.rx.W.onRequestPaid((ev) => told.push(ev.stage));
      t.rx.hold = /\/v1\/swap$/;
      const r = pay(t, tapReq(t, t.rx.W.paymentRequest(amount, { unit, purpose: 'receive' })));
      await until(() => told.indexOf('paid') >= 0 && t.rx.held.length > 0, 4000);
      await r;
      let walkDone = false;
      const walk = t.rx.W.claimUnclaimed().then((x) => x, (e) => ({ err: String((e && e.message) || e) })).then((x) => { walkDone = true; return x; });
      // the walk either reaches the mint's door too, or waits behind the swap already out
      await until(() => t.rx.held.length >= 2 || walkDone, 1500);
      const atDoor = t.rx.held.length;
      ok(t.rx.W.arrivingIn(unit) === amount && t.rx.W.keptIn(unit) === 0 && await balance(t.rx) === amount,
        unit + ': a second claim under way, and the payment counted once', JSON.stringify({ atDoor, arriving: t.rx.W.arrivingIn(unit), kept: t.rx.W.keptIn(unit), balance: await balance(t.rx) }));
      ok((await book(t.rx)).off === 0, unit + ': the audit is off by 0 with both claims under way');
      t.rx.hold = null;
      // the last to reach the door goes first, so the request's own swap is the one that meets its proofs spent
      while (t.rx.held.length) t.rx.held.splice(-1)[0].go();
      await walk;
      await settle(300);
      while (t.rx.held.length) t.rx.held.splice(-1)[0].go();
      await settle(300);
      ok(sum(pile(t.rx, PILE)) === amount && t.rx.W.arrivingIn(unit) === 0 && t.rx.W.keptIn(unit) === 0 && !Object.keys(kept(t.rx)).length
        && await balance(t.rx) === amount, unit + ': both claims done: the payment in the pile once, nothing arriving, nothing kept',
        JSON.stringify({ atDoor, pile: sum(pile(t.rx, PILE)), arriving: t.rx.W.arrivingIn(unit), kept: t.rx.W.keptIn(unit), rows: Object.keys(kept(t.rx)).length }));
      ok((await book(t.rx)).off === 0, unit + ': the audit is off by 0 at the end');
    }
    // the mint too busy to take its lock, while the payment arrives
    {
      const t = await pair(unit === 'usd' ? { payerUsd: [2000] } : { payerSat: 2000 });
      t.rx.W._lockPause = [5, 15];
      const told = [];
      t.rx.W.onRequestPaid((ev) => told.push(ev.stage));
      t.rx.hold = /\/v1\/swap$/;
      const r = pay(t, tapReq(t, t.rx.W.paymentRequest(amount, { unit, purpose: 'receive' })));
      await until(() => told.indexOf('paid') >= 0 && t.rx.held.length > 0, 4000);
      await r;
      t.rx.held.splice(0)[0].refuse('400\n' + JSON.stringify({ detail: 'failed to acquire database lock', code: 0 }));
      await until(() => t.rx.held.length > 0, 3000);
      ok(t.rx.held.length === 1 && t.rx.W.arrivingIn(unit) === amount && t.rx.W.keptIn(unit) === 0 && await balance(t.rx) === amount,
        unit + ': refused as busy, asked again, and arriving all the while', JSON.stringify({ held: t.rx.held.length, arriving: t.rx.W.arrivingIn(unit), kept: t.rx.W.keptIn(unit) }));
      ok((await book(t.rx)).off === 0, unit + ': the audit is off by 0 while it is asked again');
      t.rx.hold = null;
      t.rx.held.splice(0)[0].go();
      await until(() => sum(pile(t.rx, PILE)) === amount && !Object.keys(kept(t.rx)).length);
      ok(sum(pile(t.rx, PILE)) === amount && t.rx.W.arrivingIn(unit) === 0 && await balance(t.rx) === amount && t.rx.W._lockAsked === 1,
        unit + ': the second asking lands it, once', JSON.stringify({ pile: sum(pile(t.rx, PILE)), arriving: t.rx.W.arrivingIn(unit), asked: t.rx.W._lockAsked }));
      ok((await book(t.rx)).off === 0, unit + ': and the audit is off by 0');
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

// ended when the cases are, so a timer a page left behind does not hold the suite open (the books are judged on exit)
run().catch((e) => { console.log('THREW', e && e.stack || e); process.exitCode = 1; })
  .then(() => setTimeout(() => process.exit(), 50));
