'use strict';
/* away-claim.js — what a person starts while a late claim has the wallet at
 * another mint.
 *
 *     node tests/away-claim.js
 *
 * Ecash that arrived from another mint and was never claimed is claimed at
 * that mint (`claimUnclaimed`), and for those seconds the wallet is that
 * mint's: `wallet`, `mintUrl`, the pile. A phone log showed what that costs.
 * A bill begun five seconds after a route came back, with two payments to
 * claim elsewhere, was filed against the mint being visited; its quotes were
 * asked of a mint that had never issued them; and the tap offer named the
 * wrong mint.
 *
 * Two mints of cashu-ts's own crypto and the wallet as it ships, with one
 * mint made slow so the visit lasts long enough to start things in:
 *
 *   - a request, an invoice, a fee quote and a token started during the
 *     visit are made at the phone's own mint, after it is home;
 *   - the claim the visit is for is not held up by any of that;
 *   - an invoice says which mint issued it, so a bill saved while the wallet
 *     is elsewhere is still filed against its own mint;
 *   - a mint chosen during the visit is the mint the phone ends on;
 *   - a walk with nothing to claim elsewhere holds nothing up.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const HOME = 'https://home.test';
const THEIR = 'https://their.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 5000);
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 1)); }
  return !!fn();
};
const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const read = (c, key, dflt) => { try { const v = JSON.parse(c.storage.getItem(key)); return v === null ? dflt : v; } catch (e) { return dflt; } };
const canon = (u) => String(u || '').replace(/\/+$/, '');
const at = (m) => canon(new URL(m.url).origin);

/* A page on two mints. `slow(m)` is how long one mint request takes to be
 * answered, in milliseconds. The link carries a payment to the receiver. */
let pageMints = null;
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  const answers = [];
  let ctx = null;
  const reply = (w, id, text, err, ms) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), ms || 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      const L = ctx.link;
      switch (m.action) {
        case 'mintRequest': {
          if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
          const mint = ctx.mints[at(m)];
          if (!mint) return reply(w, m.id, null, 'no such mint in this test');
          ctx.hits.push(m.method + ' ' + at(m) + new URL(m.url).pathname);
          return reply(w, m.id, mint.handle(m), undefined, ctx.slow ? Number(ctx.slow(m)) || 0 : 0);
        }
        case 'inboxAnswer':
          answers.push({ status: [200, 409, 422].indexOf(Number(m.status)) >= 0 ? Number(m.status) : 422, text: String(m.text || '') });
          return reply(w, m.id, 'ok');
        case 'tapChangeDue': case 'tapAsking':
          return reply(w, m.id, 'ok');
        case 'tapSend': {
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          setTimeout(() => L.receiver.W._requestPaid(String(m.body || ''), 'wire', 'tap'), 0);
          const began = L.receiver.answers.length;
          const wait = setInterval(() => {
            const said = L.receiver.answers;
            if (said.length <= began) return;
            clearInterval(wait);
            const last = said[said.length - 1];
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
      pageMints = opts.mints || {
        [HOME]: fakeMint(w, { p2pk: true, fill: 7 }),
        [THEIR]: fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 5000 }),
      };
    },
  });
  ctx.mints = pageMints;
  ctx.hits = [];
  ctx.answers = answers;
  ctx.deaf = !!opts.deaf;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
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
async function fund(c, where, sats) {
  await c.W.connect(where, null, null, { remember: true });
  const inv = await c.W.invoice(sats, '');
  await c.W.claim(inv.hash);
}

/* A phone whose own mint is `HOME`, holding `sats` paid to it at `paidAt`
 * while it had no route and not yet claimed, now back on its own mint and
 * still offline. `seed` is the page that funded the payer, for its mints. */
async function withOneWaiting(paidAt, sats) {
  const seed = page();
  await fund(seed, paidAt, 2000);
  const rx = page({ mints: seed.mints, words: OTHER_WORDS });
  await fund(rx, HOME, 3000);
  if (paidAt !== HOME) await rx.W.connect(paidAt, null, null, { remember: true });
  await rx.W.primeLocks();
  goOffline(rx);
  const payer = page({ mints: seed.mints, storage: dump(seed) });
  await payer.W.connect(paidAt, null, null, { remember: true });
  await payer.W.primeLocks();
  const L = { up: true, payer, receiver: rx };
  payer.link = L; rx.link = L;
  const ask = rx.W.decodeRequest(rx.W.paymentRequest(sats, { purpose: 'receive' })) || {};
  const paid = await payer.W.payRequest(Object.assign({}, ask, { sats: sats, unit: 'sat', viaTap: true, theirRoute: false }), () => {}, { overpayOk: true })
    .then((r) => ({ made: r }), (e) => ({ err: e.message }));
  await settle();
  L.up = false;
  // the person goes back to their own mint, still with no route
  if (paidAt !== HOME) await rx.W.connect(HOME, null, null, { remember: true });
  return { rx, seed, paid };
}
const savedMint = (c) => canon(read(c, 'foxy.cashu.mint', ''));
const since = (c, from, what) => c.hits.slice(from).filter((h) => h === what).length;

async function run() {
  /* ---- 1: what is started during the visit is done at home -------------- */
  {
    const t = await withOneWaiting(THEIR, 300);
    const rx = t.rx, W = rx.W;
    ok(!!t.paid.made && W.unclaimedSats(THEIR) === 300 && canon(W.mintUrl) === HOME && savedMint(rx) === HOME,
       'a payment taken at another mint with no route waits there, and the phone is back on its own mint',
       t.paid.err || W.unclaimedSats(THEIR) + ' waiting at their mint, phone on ' + canon(W.mintUrl));
    // an invoice to be quoted for, made by somebody else at the other mint
    const bill = await t.seed.W.invoice(150, '');
    // the other mint is slow, as a mint over Tor is: the visit lasts
    rx.slow = (m) => (at(m) === THEIR ? 30 : 0);
    goOnline(rx);
    await W.connect(HOME, null, null, { remember: true });
    const walk = W.claimUnclaimed();
    const there = await until(() => W.awayClaiming() && canon(W.mintUrl) === THEIR);
    ok(there, 'the late claim takes the wallet to the mint the payment is at', 'away ' + W.awayClaiming() + ', on ' + canon(W.mintUrl));

    const from = rx.hits.length;
    const asked = W.paymentRequest(120, { purpose: 'receive' });
    ok(asked === '', 'no request is made that would name the mint being visited', asked ? 'one was made' : '');
    let invEarly = false, tokEarly = false, feeEarly = false;
    const invP = W.invoice(700, '').then((r) => { invEarly = W.awayClaiming(); return r; });
    const feeP = W.quoteFee(bill.bolt11).then((r) => { feeEarly = W.awayClaiming(); return r; }, (e) => ({ err: e.message }));
    const tokP = W.sendToken(200).then((r) => { tokEarly = W.awayClaiming(); return r; }, (e) => ({ err: e.message }));
    const balP = W.whenHome().then(() => W.balanceSats().then((n) => ({ n: n, on: canon(W.mintUrl), here: W.balanceAt(HOME) })));

    const took = await walk.then((n) => n, (e) => 'failed: ' + e.message);
    ok(took === 300 && W.balanceAt(THEIR) === 300 && W.unclaimedSats() === 0,
       'the claim the visit was for is made, and is not held up by what waits behind it', took + ' taken, ' + W.balanceAt(THEIR) + ' at their mint');
    ok(canon(W.mintUrl) === HOME && !W.awayClaiming() && savedMint(rx) === HOME, 'and the phone is home again', canon(W.mintUrl));

    const inv = await invP, fee = await feeP, tok = await tokP, bal = await balP;
    ok(canon(inv.mint) === HOME && !invEarly
       && since(rx, from, 'POST ' + HOME + '/v1/mint/quote/bolt11') === 1 && since(rx, from, 'POST ' + THEIR + '/v1/mint/quote/bolt11') === 0,
       'an invoice asked for during the visit is made at the phone’s own mint, once it is home',
       'made at ' + canon(inv.mint) + '; ' + since(rx, from, 'POST ' + THEIR + '/v1/mint/quote/bolt11') + ' asked of their mint');
    ok(!!fee && !fee.err && !feeEarly
       && since(rx, from, 'POST ' + HOME + '/v1/melt/quote/bolt11') >= 1 && since(rx, from, 'POST ' + THEIR + '/v1/melt/quote/bolt11') === 0,
       'a fee is quoted by the mint that would pay, not the one being visited', fee && fee.err ? fee.err : '');
    const made = tok && tok.token ? W.tokenInfo(tok.token) : null;
    ok(!!made && canon(made.mint) === HOME && made.amount === 200 && !tokEarly,
       'a token made during the visit is this mint’s ecash, from this mint’s pile', tok && tok.err ? tok.err : (made ? canon(made.mint) : 'none'));
    ok(bal.on === HOME && bal.n === bal.here && bal.n >= 2800, 'a balance read for the screen waits, and is this mint’s', bal.n + ' read on ' + bal.on + ', ' + bal.here + ' held there');
    const now = W.decodeRequest(W.paymentRequest(120, { purpose: 'receive' })) || {};
    ok(JSON.stringify(now).indexOf(HOME) >= 0 && JSON.stringify(now).indexOf(THEIR) < 0, 'and a request made after it names the phone’s own mint');
  }

  /* ---- 2: a bill is filed against the mint its invoices came from -------- */
  {
    const t = await withOneWaiting(THEIR, 300);
    const rx = t.rx, W = rx.W;
    /* The invoice is asked for at home and answered late; the visit begins
     * in between and is still on when the answer comes. */
    rx.slow = (m) => {
      const path = new URL(m.url).pathname;
      if (at(m) === HOME) return (m.method === 'POST' && /\/v1\/mint\/quote\/bolt11$/.test(path)) ? 150 : 0;
      return /\/v1\/swap$/.test(path) ? 400 : 10;
    };
    goOnline(rx);
    await W.connect(HOME, null, null, { remember: true });
    let savedOn = '';
    const filed = W.invoice(400, '').then((inv) => {
      savedOn = canon(W.mintUrl);
      // as the collecting screen files it (spMakeInvoices)
      return W.splitSave({ ways: 2, total: 800, at: Date.now(), mint: inv.mint || undefined,
        rows: [{ hash: inv.hash, bolt11: inv.bolt11, sats: inv.sats, label: 'Split 2 of 2', paid: false }] });
    });
    const walk = W.claimUnclaimed();
    await filed;
    ok(savedOn === THEIR, 'the bill’s invoice comes back while the wallet is at the other mint', 'saved while on ' + savedOn);
    ok(canon((W.splitRecord() || {}).mint) === HOME, 'and the bill is filed against the mint that issued it', String((W.splitRecord() || {}).mint));
    await walk;
    rx.slow = null;
    const from = rx.hits.length;
    await W.splitReconcile();
    const row = ((W.splitRecord() || {}).rows || [])[0] || {};
    ok(since(rx, from, 'GET ' + HOME + '/v1/mint/quote/bolt11/' + row.hash) >= 1,
       'so the check on return asks that mint about it', since(rx, from, 'GET ' + HOME + '/v1/mint/quote/bolt11/' + row.hash) + ' question(s)');
    await settle();
    if (W.splitClear) W.splitClear();
  }

  /* ---- 3: a mint chosen during the visit is where the phone ends -------- */
  {
    const t = await withOneWaiting(THEIR, 300);
    const rx = t.rx, W = rx.W;
    rx.slow = (m) => (at(m) === THEIR ? 30 : 0);
    goOnline(rx);
    await W.connect(HOME, null, null, { remember: true });
    const walk = W.claimUnclaimed();
    await until(() => W.awayClaiming() && canon(W.mintUrl) === THEIR);
    const chosen = W.connect(THEIR, null, null, { remember: true });
    await walk;
    await chosen;
    await settle();
    ok(canon(W.mintUrl) === THEIR && savedMint(rx) === THEIR,
       'the phone is on the mint that was chosen, and that is the one saved as its own', 'on ' + canon(W.mintUrl) + ', saved ' + savedMint(rx));
  }

  /* ---- 4: nothing elsewhere, nothing held up ---------------------------- */
  {
    const t = await withOneWaiting(HOME, 300);
    const rx = t.rx, W = rx.W;
    rx.slow = () => 20;
    goOnline(rx);
    await W.connect(HOME, null, null, { remember: true });
    let away = false;
    const watch = setInterval(() => { if (W.awayClaiming()) away = true; }, 1);
    const walk = W.claimUnclaimed();
    const inv = await W.invoice(250, '');
    const during = !!(await Promise.race([walk.then(() => false), Promise.resolve(true)]));
    const took = await walk;
    clearInterval(watch);
    ok(!away && canon(inv.mint) === HOME, 'a payment waiting at the phone’s own mint is claimed with nothing made to wait', 'away seen: ' + away);
    ok(during && took === 300 && W.unclaimedSats() === 0, 'and an invoice asked for meanwhile is answered before the walk is over', took + ' taken');
  }

  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall away-claim checks pass');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
