'use strict';
/* crossings.js — money between two mints, and what is left when a step fails.
 *
 *     node tests/crossings.js
 *
 * Two mints of cashu-ts's own crypto and the wallet as it ships. Each block is
 * something tools/live/offline-cross-scenarios.js found against real mints,
 * held here without Docker:
 *
 *   - a second crossing wrote over the note of an unfinished one, and the
 *     first payment's quote was forgotten;
 *   - a crossing was finished only while the phone sat on the mint the money
 *     had gone to, which is where the app has just left;
 *   - a note was left for a Lightning payment that never went;
 *   - the quote for a crossing allowed an amount the payment then refused;
 *   - a receiver that went to a payer's mint to take a payment saved that
 *     mint as its own, and nothing remembered the payment was to come home;
 *   - a payment that could not be brought home stayed at a mint the receiver
 *     never chose: it goes back to the payer now, locked to the payer;
 *   - a payment the receiver refused sat behind a button on the payer's phone
 *     until somebody pressed it.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, noBooks } = require('./harness');

const HOME = 'https://home.test';
const THEIR = 'https://their.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };
const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const read = (c, key, dflt) => { try { const v = JSON.parse(c.storage.getItem(key)); return v === null ? dflt : v; } catch (e) { return dflt; } };
const history = (c) => read(c, 'foxy.cashu.log', []);
const canon = (u) => String(u || '').replace(/\/+$/, '');

/* A page on two mints. `fate(m)` decides one mint request: 'lost' (no answer
 * comes), 'refuse' (the mint says no), anything else lets it through. The
 * link, when there is one, carries M5 to the receiver and M7 back. */
function page(o) {
  const opts = o || {};
  const phone = opts.phone || nativePhone({ words: opts.words || PHONE_WORDS });
  const answers = [];
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      const L = ctx.link;
      switch (m.action) {
        case 'mintRequest': {
          if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
          const fate = ctx.fate ? ctx.fate(m) : '';
          if (fate === 'lost') return reply(w, m.id, null, 'The network connection was lost.');
          if (fate === 'refuse') return reply(w, m.id, '400\n' + JSON.stringify({ detail: 'This mint will not do that.', code: 11000 }));
          const mint = ctx.mints[canon(new URL(m.url).origin)];
          if (!mint) return reply(w, m.id, null, 'no such mint in this test');
          ctx.hits.push(m.method + ' ' + canon(new URL(m.url).origin) + new URL(m.url).pathname);
          return reply(w, m.id, mint.handle(m));
        }
        case 'inboxAnswer':
          answers.push({ status: [200, 409, 422].indexOf(Number(m.status)) >= 0 ? Number(m.status) : 422, text: String(m.text || '') });
          return reply(w, m.id, 'ok');
        case 'tapChangeDue': case 'tapAsking':
          return reply(w, m.id, 'ok');
        case 'tapChange':
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M7');
          setTimeout(() => L.payer.W._tapChange(String(m.body || '')), 0);
          L.m7 = { w, id: m.id };
          return null;
        case 'tapChangeKept':
          if (L && L.m7) { const a = L.m7; L.m7 = null; L.log.push('M8 ' + !!m.kept);
            if (m.kept) L.receiver.window.FoxyWallet._scanResult(a.id, 'ok'); else L.receiver.window.FoxyWallet._scanResult(a.id, null, 'They could not keep it.'); }
          return reply(w, m.id, 'ok');
        case 'tapSend': {
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M5');
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
      ctx_mints = opts.mints || {
        [HOME]: fakeMint(w, { p2pk: true, fill: 7 }),
        [THEIR]: fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 5000, feePpk: opts.feePpk }),
      };
    },
  });
  ctx.mints = ctx_mints;
  ctx.phone = phone;
  ctx.hits = [];
  ctx.answers = answers;
  ctx.deaf = !!opts.deaf;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
let ctx_mints = null;

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
async function fund(c, at, sats) {
  await c.W.connect(at, null, null, { remember: true });
  const inv = await c.W.invoice(sats, '');
  await c.W.claim(inv.hash);
}
const notes = (c) => { const v = read(c, 'foxy.cashu.move', null); return !v ? [] : Array.isArray(v) ? v : [v]; };
const jobs = (c) => read(c, 'foxy.cashu.carry', []) || [];
const claimCut = (mint) => (m) => (canon(new URL(m.url).origin) === mint && /\/v1\/mint\/bolt11$/.test(m.url) && m.method === 'POST') ? 'lost' : '';
const meltRefused = (mint) => (m) => (canon(new URL(m.url).origin) === mint && /\/v1\/melt\/bolt11$/.test(m.url) && m.method === 'POST') ? 'refuse' : '';

async function run() {
  /* ---- 1: two crossings, two notes, finished from anywhere --------------- */
  {
    const p = page();
    await fund(p, HOME, 2000);
    const W = p.W;
    p.fate = claimCut(THEIR);
    const plan1 = await W.transferQuote(HOME, 300, { to: THEIR, land: true });
    const e1 = await W.moveRun(plan1, () => {}, { visit: true }).then(() => null, (e) => e);
    ok(!!e1 && e1.movePaid === true && !e1.pending, 'a crossing whose claim cannot be made says the payment was made', e1 ? String(e1.message).slice(0, 60) : 'it went through');
    ok(notes(p).length === 1 && notes(p)[0].quote === plan1.mintQuote.quote && notes(p)[0].request === plan1.mintQuote.request,
       'and its note is on file, naming the quote and the invoice', JSON.stringify(notes(p).map((n) => n.amount)));
    ok(canon(p.storage.getItem('foxy.cashu.mint') && JSON.parse(p.storage.getItem('foxy.cashu.mint'))) === HOME,
       'the visit to their mint is not saved as this phone’s own', String(p.storage.getItem('foxy.cashu.mint')));
    await W.connect(HOME, null, null, { remember: false });
    const plan2 = await W.transferQuote(HOME, 200, { to: THEIR, land: true });
    const e2 = await W.moveRun(plan2, () => {}, { visit: true }).then(() => null, (e) => e);
    const two = notes(p);
    ok(!!e2 && e2.movePaid && two.length === 2 && two[0].quote === plan1.mintQuote.quote && two[1].quote === plan2.mintQuote.quote,
       'a second crossing adds its note and leaves the first one’s alone', two.length + ' note(s)');
    ok(W.pendingMoves().length === 2 && W.pendingMove().quote === plan1.mintQuote.quote && W.crossingsWaiting(), 'both are reported as pending, the oldest first');
    // home, and the far mint answers again: both are claimed from here
    await W.connect(HOME, null, null, { remember: false });
    await settle();
    p.fate = null;
    const before = p.hits.length;
    const [a, b] = await Promise.all([W.finishMove(), W.finishMove()]);
    const claims = p.hits.slice(before).filter((h) => h === 'POST ' + THEIR + '/v1/mint/bolt11').length;
    ok(W.balanceAt(THEIR) === plan1.moving + plan2.moving && !notes(p).length, 'both are finished from the phone’s own mint, with a wallet made for the other',
       W.balanceAt(THEIR) + ' at their mint for ' + (plan1.moving + plan2.moving) + '; ' + notes(p).length + ' note(s) left');
    ok(claims === 2 && a === b, 'two callers share one walk: each quote is claimed once', claims + ' claims');
    ok(canon(W.mintUrl) === HOME, 'and the phone is still on its own mint', W.mintUrl);
    const landed = history(p).filter((e) => e.dir === 'in' && e.memo === 'mint switch');
    ok(landed.length === 2 && landed.every((e) => canon(e.mint) === THEIR), 'their entries name the mint the sats landed at, not the one the phone was on',
       JSON.stringify(landed.map((e) => e.mint)));
  }

  /* ---- 2: a note written by an older Foxy is a list of one ---------------- */
  {
    const p = page({ storage: { 'foxy.cashu.move': JSON.stringify({ to: THEIR, from: HOME, quote: 'q-old', amount: 8, lock: null, at: 1 }) } });
    await p.W.connect(HOME, null, null, { remember: true });
    ok(p.W.pendingMoves().length === 1 && p.W.pendingMove().quote === 'q-old', 'a single note from before is read as a list of one');
  }

  /* ---- 3: no note for a Lightning payment that never went ---------------- */
  {
    const p = page();
    await fund(p, HOME, 1000);
    const W = p.W;
    const held0 = W.balanceAt(HOME);
    p.fate = meltRefused(HOME);
    const plan = await W.transferQuote(HOME, 300, { to: THEIR, land: true });
    const e = await W.moveRun(plan, () => {}, { visit: true }).then(() => null, (x) => x);
    ok(!!e && e.definite === true && !e.movePaid, 'a melt the mint refuses fails the crossing as not sent', e ? String(e.message).slice(0, 60) : 'it went through');
    ok(!notes(p).length && !W.crossingsWaiting(), 'and leaves no note behind', notes(p).length + ' note(s)');
    ok(W.balanceAt(HOME) === held0 && canon(W.mintUrl) === HOME, 'the sats are where they were, and so is the phone', W.balanceAt(HOME) + ' of ' + held0);
    // a melt that got no answer may still be going through: held, and its note kept for the sweep
    p.fate = (m) => (/\/v1\/melt\/(quote\/)?bolt11/.test(m.url) && (m.method === 'POST' && /\/v1\/melt\/bolt11$/.test(m.url) || m.method === 'GET')) ? 'lost' : '';
    const plan2 = await W.transferQuote(HOME, 300, { to: THEIR, land: true });
    const e2 = await W.moveRun(plan2, () => {}, { visit: true }).then(() => null, (x) => x);
    ok(!!e2 && e2.pending === true && !e2.movePaid && notes(p).length === 1, 'a melt that got no answer is held, and its note is kept for as long as the hold is',
       e2 ? String(e2.message).slice(0, 50) + '; ' + notes(p).length + ' note(s)' : 'it went through');
  }

  /* ---- 4: the quote and the payment do one sum (a mint that charges) ----- */
  {
    const p = page({ feePpk: 150 });
    await fund(p, THEIR, 600);
    const W = p.W;
    const have = W.balanceAt(THEIR);
    let most = 0, refusal = null;
    for (let want = have; want >= have - 60 && !most; want--) {
      const q = await W.transferQuote(THEIR, want, { to: HOME, land: true }).then((plan) => ({ plan }), (e) => ({ e }));
      if (q.plan) most = want; else refusal = { want, e: q.e };
    }
    ok(most > 0 && !!refusal && /costs up to \d+ with the fee, and you hold \d+/.test(refusal.e.message), 'the largest amount a pile can move is found, and one more is refused with both figures',
       most + ' of ' + have + '; ' + (refusal ? refusal.e.message : ''));
    ok(refusal && refusal.e.foxyFits === most, 'the amount the refusal offers is the one the quote then allows', refusal ? 'offers ' + refusal.e.foxyFits + ', allows ' + most : '');
    const plan = await W.transferQuote(THEIR, most, { to: HOME, land: true });
    const done = await W.moveRun(plan, () => {}, { visit: true }).then((d) => d, (e) => ({ err: e.message }));
    ok(!done.err && done.sats === plan.moving, 'and the payment the quote allowed is one the mint takes', done.err || (done.sats + ' landed'));
    // an offline payer at a mint that charges says what it can hand over, which is less than it holds
    {
      const q = page({ feePpk: 150 });
      await fund(q, THEIR, 600);
      const held = q.W.balanceAt(THEIR);
      goOffline(q);
      const says = q.W.stuckAtMint({ id: 'x', mints: [HOME], sats: 100 });
      ok(!!says && says.have < held && says.have >= held - 4 && canon(says.mint) === THEIR, 'a payer with no route says what it can hand over, less the fee on its pieces',
         says ? 'holds ' + held + ', says ' + says.have : 'it said nothing');
    }
    // pay's own refusal names a need larger than what is held
    const inv = await W.connect(HOME).then(() => W.invoice(5000, ''));
    await W.connect(THEIR);
    const no = await W.pay(inv.invoice || inv.request || inv.bolt11).then(() => null, (e) => e.message);
    const m = /needs (\d+) sats[^.]*you hold (\d+)/.exec(String(no));
    ok(!!m && Number(m[1]) > Number(m[2]), 'a payment the pile cannot make is refused with a need larger than what is held', String(no));
  }

  /* ---- 5: a payment taken at the payer's mint is brought home ------------ */
  const carry = async (o) => {
    const opts = o || {};
    const seed = page();
    await fund(seed, THEIR, 3000);
    const shared = seed.mints;
    const rx = page({ mints: shared, words: OTHER_WORDS });
    await rx.W.connect(HOME, null, null, { remember: true });
    await rx.W.primeLocks();
    const payer = page({ mints: shared, storage: dump(seed) });
    await payer.W.connect(THEIR, null, null, { remember: true });
    await payer.W.primeLocks();
    goOffline(payer);
    const L = { up: true, log: [], payer, receiver: rx };
    payer.link = L; rx.link = L;
    payer.changes = [];
    payer.W.onTapChange((token) => {
      // the app's handler: owed is what was paid when the payment was one to be carried home
      const chk = payer.W.checkChange(token, payer.carried || 0);
      payer.changes.push({ ok: chk.ok, why: chk.why, sats: chk.sats });
      if (!chk.ok) { payer.W.tapChangeKept(false); return; }
      try {
        payer.W.keepChange(token, chk.sats);
        /* As the app tells them apart (15-paid-wake-keyboard.js): with a payment
         * being carried and no change owed on it, what arrives is the payment
         * coming back, on top of any change that already had. */
        const row = history(payer).filter((e) => e.hash === payer.lastHash)[0] || {};
        const refund = !!payer.carried && row.changeState !== 'owed';
        if (payer.lastHash) payer.W.changeSettled(payer.lastHash, payer.W.changeNet(token), refund ? { refund: true } : undefined);
        payer.W.tapChangeKept(true);
      }
      catch (e) { payer.W.tapChangeKept(false); }
    });
    rx.told = [];
    rx.W.onCarry((r) => rx.told.push(r));
    rx.W.onChangeStuck((info) => { rx.stuck = info; });
    const sats = 300;
    const offer = rx.W.decodeRequest(rx.W.paymentRequest(sats, { purpose: 'receive' })) || {};
    const stuck = payer.W.stuckAtMint(offer);
    const terms = await rx.W.crossTerms(Object.assign({ id: String(offer.id || ''), sats }, stuck), sats);
    const id = await rx.W.carryBegin(terms);
    const visiting = canon(rx.W.mintUrl), saved = canon(JSON.parse(rx.storage.getItem('foxy.cashu.mint')));
    const text = rx.W.paymentRequest(terms.ask, { purpose: 'carry:' + terms.from });
    payer.carried = terms.ask;
    const paid = await payer.W.payRequest(Object.assign({}, payer.W.decodeRequest(text), { sats: terms.ask, unit: 'sat', viaTap: true, theirRoute: true }),
      () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ err: e.message }));
    if (paid.made) payer.lastHash = paid.made.hash;
    await settle();
    return { rx, payer, L, terms, id, paid, visiting, saved, sats, stuck };
  };
  {
    const t = await carry();
    ok(t.visiting === THEIR && t.saved === HOME, 'the receiver goes to the payer’s mint, and its own stays the mint it has saved', 'on ' + t.visiting + ', saved ' + t.saved);
    const job = jobs(t.rx)[0] || {};
    ok(!!t.paid.made && job.state === 'paid' && job.kept >= t.terms.ask && /^0[23][0-9a-f]{64}$/.test(String(job.payerKey)) && job.hash === 'req-' + job.reqId,
       'the payment is written on its job: taken, how much, its entry, and the key to send it back to', t.paid.err || JSON.stringify({ state: job.state, kept: job.kept }));
    const r = await t.rx.W.carryHome(t.id, t.terms.plan, () => {});
    ok(r.state === 'home' && t.rx.W.balanceAt(HOME) >= t.sats && canon(t.rx.W.mintUrl) === HOME && !jobs(t.rx).length && !notes(t.rx).length,
       'it is brought home: the figure asked for lands, the phone is on its own mint, and nothing is left written down',
       r.state + ': ' + t.rx.W.balanceAt(HOME) + ' at home; ' + (r.why || ''));
  }
  /* killed at the payer's mint with the payment taken: opened again, it opens at home and brings it home itself */
  {
    const t = await carry();
    /* A new page is a new realm, and the phone's cached seed belongs to the old
     * one: a fresh phone on the same keychain, with the counters and lock
     * indexes the first had (tools/live/harness.js does the same). */
    const phone2 = nativePhone({ keychain: t.rx.phone.keychain, migration: false });
    phone2.counters = t.rx.phone.counters;
    phone2.locks = t.rx.phone.locks;
    phone2.imported = t.rx.phone.imported;
    const again = page({ mints: t.rx.mints, phone: phone2, storage: dump(t.rx) });
    again.told = [];
    again.W.onCarry((r) => again.told.push(r));
    await again.W.connect();
    const woke = canon(again.W.mintUrl);
    await again.W.resumeSweeps();
    await settle();
    ok(woke === HOME, 'killed over there and opened again, the receiver opens on its own mint', woke);
    ok(again.W.balanceAt(HOME) >= t.sats && !jobs(again).length && again.told.filter((r) => r.state === 'home').length === 1,
       'and brings the payment home without being asked, saying so once', again.W.balanceAt(HOME) + ' at home; told ' + JSON.stringify(again.told.map((r) => r.state)));
    await again.W.resumeSweeps();
    ok(again.told.filter((r) => r.state === 'home').length === 1 && again.W.balanceAt(HOME) < 2 * t.sats, 'a second pass brings nothing more');
  }
  /* the way home is paid for and not yet claimed: it is on its way, and finishing the crossing finishes the payment */
  {
    const t = await carry();
    t.rx.fate = claimCut(HOME);
    const r = await t.rx.W.carryHome(t.id, t.terms.plan, () => {});
    ok(r.state === 'moving' && canon(t.rx.W.mintUrl) === HOME && jobs(t.rx).length === 1 && notes(t.rx).length === 1,
       'a claim at home that cannot be made leaves the payment on its way, not received and not at their mint', r.state);
    t.rx.fate = null;
    await t.rx.W.catchUpCrossings();
    ok(t.rx.W.balanceAt(HOME) >= t.sats && !jobs(t.rx).length && t.rx.told.some((x) => x.state === 'home' && x.late),
       'and the claim, made later, is the payment arriving', t.rx.W.balanceAt(HOME) + ' at home; told ' + JSON.stringify(t.rx.told.map((x) => x.state)));
  }
  /* the payer's mint will not pay the invoice home, twice: the payment goes back, locked to the payer */
  for (const cut of [false, true]) {
    const t = await carry();
    const thereBefore = t.rx.W.balanceAt(THEIR);
    if (cut) t.L.up = false;
    t.rx.fate = meltRefused(THEIR);
    const r = await t.rx.W.carryHome(t.id, t.terms.plan, () => {});
    t.rx.fate = null;
    const how = cut ? 'with the link gone' : 'over the link';
    ok(r.state === 'refunded' && !!r.token && r.handed === !cut, 'refused twice, the payment is sent back ' + how, r.state + (r.why ? ': ' + String(r.why).slice(0, 60) : ''));
    const row = history(t.rx).filter((e) => e.hash === r.hash)[0] || {};
    ok(row.refund === true && row.sats <= 3 && canon(t.rx.W.mintUrl) === HOME && !jobs(t.rx).length && t.rx.W.balanceAt(HOME) === 0,
       'its entry stops saying it was received, and the receiver is home with nothing left to carry', 'entry ' + row.sats + ' sats, ' + row.changeState);
    ok(t.rx.W.balanceAt(THEIR) <= thereBefore - t.terms.ask + 3, 'nothing of the payment stays with the receiver but what was too small to send',
       (t.rx.W.balanceAt(THEIR) - (thereBefore - t.terms.ask)) + ' left');
    const bits = t.rx.W.tokenInfo(r.token);
    ok((bits.proofs || []).every((pr) => String(pr.secret).indexOf(String((jobs(t.rx)[0] || {}).payerKey || '')) >= 0 && String(pr.secret).charAt(0) === '['),
       'what goes back is locked');
    if (!cut) {
      const last = t.payer.changes[t.payer.changes.length - 1] || {};
      ok(last.ok === true && last.sats >= t.sats, 'the payer’s phone checks it as it checks change, and keeps it', JSON.stringify(t.payer.changes));
    } else {
      ok(!!t.rx.stuck && t.rx.stuck.refund === true && t.rx.stuck.token === r.token && (t.rx.W.tagsFor(r.hash) || {}).token === r.token,
         'it is raised as a code, and is on the payment’s own entry', t.rx.stuck ? 'card for ' + t.rx.stuck.sats : 'no card');
    }
    const mine = await t.rx.W.connect(THEIR).then(() => t.rx.W.receiveToken(r.token)).then(() => 'took it', (e) => 'refused');
    ok(mine === 'refused', 'the receiver cannot spend what it sent back');
    goOnline(t.payer);
    await t.payer.W.connect(THEIR, null, null, { remember: true });
    if (cut) await t.payer.W.receiveToken(r.token);
    else await t.payer.W.claimUnclaimed();
    await settle();
    ok(t.payer.W.balanceAt(THEIR) >= 3000 - 6, 'and the payer, online again, has it back less the mint’s fees', t.payer.W.balanceAt(THEIR) + ' of 3000');
  }
  /* the money is no longer at their mint: nothing is carried */
  {
    const t = await carry();
    const all = read(t.rx, 'foxy.cashu.carry', []);
    all[0].kept = 99999;
    t.rx.storage.setItem('foxy.cashu.carry', JSON.stringify(all));
    await t.rx.W.connect(HOME, null, null, { remember: false });
    await t.rx.W.carryResume();
    ok(!jobs(t.rx).length && t.rx.W.balanceAt(HOME) === 0 && !notes(t.rx).length, 'a job whose sats are no longer at their mint is dropped, and nothing else there is moved');
  }
  /* Asked twice for one payment: the link dropped while
   * the fee was being worked out, the payer came back, and there were two
   * jobs. The payment was written on one and the walk home started on the
   * other, which a failed walk then marked paid — and which went on asking to
   * be brought home, out of whatever else the phone held at that mint. */
  {
    const t = await carry();
    const spare = await t.rx.W.carryBegin(t.terms);
    ok(jobs(t.rx).length === 2 && spare !== t.id, 'asked twice, there are two jobs and one payment', jobs(t.rx).map((j) => j.state + ':' + (j.kept || 0)).join(' '));
    const r = await t.rx.W.carryHome(spare, t.terms.plan, () => {});
    ok(r.state === 'home' && r.job && r.job.id === t.id && t.rx.W.balanceAt(HOME) >= t.sats && !jobs(t.rx).length && canon(t.rx.W.mintUrl) === HOME,
       'the walk asked for by the spare’s name brings the paid one home, and neither is left written down',
       r.state + ': ' + t.rx.W.balanceAt(HOME) + ' at home, ' + jobs(t.rx).length + ' jobs');
    await t.rx.W.carryResume();
    ok(t.rx.W.balanceAt(HOME) < 2 * t.sats && !t.rx.told.some((x) => x.state === 'short' || x.state === 'stuck'), 'and nothing is brought, or asked about, a second time',
       JSON.stringify(t.rx.told.map((x) => x.state)));
  }
  {
    // with no paid one, a spare is nothing to walk
    const t = await carry();
    await t.rx.W.carryHome(t.id, t.terms.plan, () => {});
    const spare = await t.rx.W.carryBegin(t.terms);
    const r = await t.rx.W.carryHome(spare, t.terms.plan, () => {});
    ok(r.state === 'none' && !jobs(t.rx).length && canon(t.rx.W.mintUrl) === HOME, 'a job nothing was paid to is not walked: it goes, and the phone goes home', r.state + ', ' + jobs(t.rx).length + ' jobs');
  }
  {
    /* The job as the build before this one left it: marked paid, with no
     * payment on it, and sats of the phone's own at that mint for it to take. */
    const t = await carry();
    await t.rx.W.carryHome(t.id, t.terms.plan, () => {});
    await fund(t.rx, THEIR, 1000);
    await t.rx.W.connect(HOME, null, null, { remember: true });
    const there = t.rx.W.balanceAt(THEIR), home = t.rx.W.balanceAt(HOME);
    const ghost = { id: 'cghost', home: HOME, from: THEIR, net: t.sats, ask: t.terms.ask, at: Date.now(), state: 'paid' };
    t.rx.storage.setItem('foxy.cashu.carry', JSON.stringify([ghost]));
    t.rx.told.length = 0;
    await t.rx.W.carryResume();
    ok(!jobs(t.rx).length && !t.rx.told.length && t.rx.W.balanceAt(THEIR) === there && t.rx.W.balanceAt(HOME) === home,
       'a job marked paid with nothing paid to it is forgotten: nothing is said, and nothing of the phone’s own is moved',
       'told ' + JSON.stringify(t.rx.told.map((x) => x.state)) + '; ' + t.rx.W.balanceAt(THEIR) + ' there, was ' + there);
    t.rx.storage.setItem('foxy.cashu.carry', JSON.stringify([ghost]));
    const back = await t.rx.W.carryRefund('cghost');
    ok(back.state === 'none' && !jobs(t.rx).length && t.rx.W.balanceAt(THEIR) === there, 'SEND IT BACK on such a job sends nothing, and it is gone', back.state);
    t.rx.storage.setItem('foxy.cashu.carry', JSON.stringify([ghost]));
    const less = await t.rx.W.carryHome('cghost', null, () => {}, { less: true });
    ok(less.state === 'none' && !jobs(t.rx).length && t.rx.W.balanceAt(THEIR) === there && t.rx.W.balanceAt(HOME) === home,
       'and BRING IT HOME on it brings nothing', less.state + '; ' + t.rx.W.balanceAt(THEIR) + ' there');
  }
  /* it cannot come home and there is no key to send it back to: said once, and that is the end of the job */
  {
    const t = await carry();
    const all = read(t.rx, 'foxy.cashu.carry', []);
    delete all[0].payerKey;
    t.rx.storage.setItem('foxy.cashu.carry', JSON.stringify(all));
    const there = t.rx.W.balanceAt(THEIR);
    t.rx.fate = meltRefused(THEIR);
    const r = await t.rx.W.carryHome(t.id, t.terms.plan, () => {});
    t.rx.fate = null;
    ok(r.state === 'stuck' && /sent nothing to send it back to/.test(String(r.why)) && !jobs(t.rx).length && canon(t.rx.W.mintUrl) === HOME,
       'a payment that cannot be brought home or sent back is stuck, says why, and its job ends', r.state + ': ' + String(r.why).slice(-60));
    ok(t.rx.W.balanceAt(THEIR) >= there - 3, 'the sats are the receiver’s, at the payer’s mint', t.rx.W.balanceAt(THEIR) + ' of ' + there);
    t.rx.told.length = 0;
    await t.rx.W.carryResume();
    await t.rx.W.carryResume();
    ok(!t.rx.told.length, 'and it is not said again on every later pass', JSON.stringify(t.rx.told.map((x) => x.state)));
  }

  /* every job is in somebody's hands: a pass that looks at none takes the phone nowhere */
  {
    const t = await carry();
    const mh = t.rx.window.webkit.messageHandlers.foxy;
    const post = mh.postMessage.bind(mh);
    let held = null;
    // the walk's first question to a mint is kept back, so the walk is under way and going nowhere
    mh.postMessage = (m) => { if (m.action === 'mintRequest' && !held) { held = m; return null; } return post(m); };
    const walking = t.rx.W.carryHome(t.id, t.terms.plan, () => {});
    for (let i = 0; i < 400 && !held; i++) await new Promise((r) => setTimeout(r, 0));
    const at = canon(t.rx.W.mintUrl), hits = t.rx.hits.length;
    const passed = await t.rx.W.carryResume();
    ok(!!held && at === THEIR && Array.isArray(passed) && !passed.length
       && canon(t.rx.W.mintUrl) === THEIR && t.rx.hits.length === hits,
       'a pass that finds its only job already being walked looks at nothing, and does not take the phone home from under the walk',
       'at ' + at + ' before, ' + canon(t.rx.W.mintUrl) + ' after; ' + (t.rx.hits.length - hits) + ' question(s) asked of a mint');
    mh.postMessage = post;
    if (held) post(held);
    await walking.then(null, () => null);
    ok(canon(t.rx.W.mintUrl) === HOME && !jobs(t.rx).length && t.rx.W.balanceAt(HOME) >= t.sats,
       'and the walk it left alone brings the payment home', canon(t.rx.W.mintUrl) + ', ' + t.rx.W.balanceAt(HOME) + ' at home');
  }

  /* ---- 6: a refusal with nothing sent back leaves the ecash at risk ---------
   *
   * The receiver hears the payment and says no, and no refund locked to the
   * payer follows (MONEY.md §15). The pieces it saw are the
   * payer's still: they go back in the wallet, counted, spendable and
   * flagged, and are swapped for fresh ones on the first connection — or
   * found redeemed, which is how a payer finds out. */
  const refusedTap = async () => {
    const seed = page();
    await fund(seed, THEIR, 2000);
    const shared = seed.mints;
    const rx = page({ mints: shared, words: OTHER_WORDS });
    await rx.W.connect(THEIR, null, null, { remember: true });
    await rx.W.primeLocks();
    const payer = page({ mints: shared, storage: dump(seed) });
    await payer.W.connect(THEIR, null, null, { remember: true });
    await payer.W.primeLocks();
    payer.W._refundWaitMs = 300;
    goOffline(payer);
    const L = { up: true, log: [], payer, receiver: rx };
    payer.link = L; rx.link = L;
    payer.said = [];
    payer.W.onAtRisk((info) => payer.said.push(info));
    rx.fate = (m) => (/\/v1\/swap$/.test(m.url) ? 'refuse' : '');
    const ask = rx.W.decodeRequest(rx.W.paymentRequest(300, { purpose: 'receive' })) || {};
    const e = await payer.W.payRequest(Object.assign({}, ask, { sats: 300, unit: 'sat', viaTap: true, theirRoute: true }), () => {}, { overpayOk: true })
      .then(() => null, (x) => x);
    rx.fate = null;
    await settle();
    const row = () => history(payer).filter((x) => x.dir === 'out' && /refused|taken/.test(String(x.memo)))[0] || {};
    return { rx, payer, e, row };
  };
  {
    const t = await refusedTap();
    const flagged = t.payer.W.atRisk();
    ok(!!t.e && t.e.foxyRefused === true && !!t.e.foxyAtRisk && !t.e.foxyToken && flagged.length === 1 && flagged[0].sats >= 300,
       'a payment the receiver hears and refuses, with nothing sent back, is flagged at risk', t.e ? String(t.e.message).slice(0, 60) + '; ' + JSON.stringify(flagged.map((g) => g.sats)) : 'it was taken');
    ok(t.payer.W.balanceAt(THEIR) === 2000 && t.row().state === 'failed' && t.row().highRisk === true,
       'its pieces are in the balance again, and its entry says refused and HIGH RISK', t.payer.W.balanceAt(THEIR) + ' held; entry ' + t.row().state);
    ok((await t.payer.W.settleAtRisk()).length === 0 && t.payer.W.atRiskSats() >= 300, 'with no route nothing is asked, and the flag stays');
    // spendable all the same: an exact payment out of the whole pile, flagged pieces included
    const spend = await t.payer.W.sendToken(2000 - 1, { unit: 'sat', cover: true, overpayOk: true }).then((r) => r, (x) => ({ err: x.message }));
    ok(!!spend.token || /exact|cover|change/i.test(String(spend.err)), 'flagged ecash is not held back from a payment', spend.err || 'a token was made');
  }
  {
    const t = await refusedTap();
    goOnline(t.payer);
    await t.payer.W.connect(THEIR, null, null, { remember: true });
    await settle(800);
    ok(t.payer.said.filter((x) => x.state === 'safe').length === 1 && t.payer.W.balanceAt(THEIR) === 2000 && !t.payer.W.atRisk().length
       && t.row().highRisk === false && t.row().takenBack === true,
       'with a route it is swapped for fresh pieces by itself, once, and the flag goes', JSON.stringify(t.payer.said.map((x) => x.state)) + '; holds ' + t.payer.W.balanceAt(THEIR));
    await t.payer.W.settleAtRisk();
    ok(t.payer.said.length === 1, 'and not a second time');
    const made = t.e && t.e.foxyToken;
    ok(!made, 'no token is left on the entry to take back by hand');
  }
  {
    // it said no, and redeems what it was shown once the payer has gone
    const t = await refusedTap();
    const flagged = t.payer.W.atRisk()[0];
    const pieces = t.payer.window.JSON.parse(t.payer.storage.getItem('foxy.cashu.proofs.' + THEIR)).filter((pr) => {
      const all = t.payer.window.JSON.parse(t.payer.storage.getItem('foxy.cashu.atrisk'))[flagged.hash].secrets; return all.indexOf(pr.secret) >= 0; });
    const stolen = t.rx.window.CashuTS.getEncodedToken({ mint: THEIR, unit: 'sat', proofs: pieces });
    const took = await t.rx.W.receiveToken(stolen).then((r) => 'took ' + r.sats, (x) => 'refused: ' + x.message);
    ok(/^took/.test(took), 'a receiver that says no can still redeem what it was shown: nothing stops that', took);
    goOnline(t.payer);
    await t.payer.W.connect(THEIR, null, null, { remember: true });
    await settle(800);
    ok(t.payer.said.filter((x) => x.state === 'taken').length === 1 && t.payer.W.balanceAt(THEIR) === 2000 - flagged.sats && !t.payer.W.atRisk().length
       && t.row().state === 'success' && t.row().settled === true && t.row().taken === true,
       'the payer finds out on its next connection: the pieces leave its balance and the entry says paid',
       JSON.stringify(t.payer.said.map((x) => x.state)) + '; holds ' + t.payer.W.balanceAt(THEIR) + '; entry ' + t.row().state);
  }

  /* ---- 7: paying out of ecash locked to this phone, at a mint that charges --
   *
   * Not a crossing, and here because this file has a mint that charges. An
   * offline payer made a payment of whole locked payments and a few loose
   * pieces, and added the receiver's fee for the loose pieces only: ten
   * locked and four loose paid 1 sat of fee where 3 were due, landed 2 short
   * and was refused (`soak-payer`). */
  {
    const p = page({ feePpk: 150 });
    await fund(p, THEIR, 1000);
    const W = p.W;
    await W.primeLocks();
    const mine = W.decodeRequest(W.paymentRequest(1, { purpose: 'receive' })) || {};
    const a = await W.sendToken(40, { unit: 'sat', lockTo: mine.lockTo });
    const b = await W.sendToken(23, { unit: 'sat', lockTo: mine.lockTo });
    const fee = (n) => Math.ceil((n * 150) / 1000);
    const lockedN = W.tokenInfo(a.token).proofs.length + W.tokenInfo(b.token).proofs.length;
    // loose pieces of 4, 2, 1 and 1, and nothing else in the pile
    const key = 'foxy.cashu.proofs.' + THEIR;
    const loose = await W.sendToken(8, { unit: 'sat' });
    const small = await W.sendToken(8, { unit: 'sat' });
    const bits = W.tokenInfo(loose.token).proofs.concat(W.tokenInfo(small.token).proofs);
    goOffline(p);
    // written down for what they hold: a locked send carries the receiver's fee on its own pieces
    const worth = (t) => W.tokenInfo(t).proofs.reduce((n, pr) => n + Number(String(pr.amount)), 0);
    const rowsSum = worth(a.token) + worth(b.token);
    W.keepChange(a.token, worth(a.token));
    W.keepChange(b.token, worth(b.token));
    const pile = [];
    [4, 2, 1, 1].forEach((want) => {
      const all = JSON.parse(p.storage.getItem(key) || '[]').concat(bits);
      const hit = all.filter((pr) => Number(String(pr.amount)) === want && !pile.some((q) => q.secret === pr.secret))[0];
      if (hit) pile.push(hit);
    });
    p.storage.setItem(key, JSON.stringify(pile));
    // the locked payments were written into the waiting store by hand with no arrival entries, and the pile was replaced
    noBooks(p, 'its waiting payments and its pile are written by hand');
    const held = pile.reduce((n, pr) => n + Number(String(pr.amount)), 0);
    // one sat more than the locked payments hold: the pile adds that, and the fee on all of it
    const want = rowsSum + 1;
    const made = await W.sendToken(want, { unit: 'sat', cover: true, overpayOk: true }).then((r) => r, (e) => ({ err: e.message }));
    const out = made.token ? W.tokenInfo(made.token).proofs : [];
    const total = out.reduce((n, pr) => n + Number(String(pr.amount)), 0);
    const lockedOut = out.filter((pr) => String(pr.secret).charAt(0) === '[').length;
    ok(held === 8 && !made.err && lockedOut === lockedN && out.length > lockedN,
       'an offline payment is made of whole locked payments and loose pieces beside them',
       made.err || (out.length + ' pieces, ' + lockedOut + ' locked; ' + held + ' loose sats on hand'));
    ok(!made.err && total - fee(out.length) === want, 'and it covers the receiver’s fee on every piece in it, locked or loose, to the sat',
       made.err || ('asked ' + want + ', sent ' + total + ' in ' + out.length + ' pieces: ' + (total - fee(out.length)) + ' after a fee of ' + fee(out.length)));
    ok(!made.err && total - fee(out.length) - want === Number(made.over || 0), 'and what it says is over is what is over',
       made.err || ('over ' + made.over + ', really ' + (total - fee(out.length) - want)));
    /* And the pile afterwards: the loose pieces that went are out of it, and
     * the ones that did not go are still in it. Nothing above looks at what
     * was left behind, so a pile that kept what it sent, or kept only what it
     * sent, passed. */
    const after = JSON.parse(p.storage.getItem(key) || '[]');
    const went = {};
    out.forEach((pr) => { went[pr.secret] = true; });
    const looseOut = pile.filter((pr) => went[pr.secret]);
    const sumOf = (l) => l.reduce((n, pr) => n + Number(String(pr.amount)), 0);
    ok(!made.err && looseOut.length > 0 && !after.some((pr) => went[pr.secret])
       && sumOf(after) === held - sumOf(looseOut) && after.length === pile.length - looseOut.length,
       'and the pile holds the loose pieces that stayed, and none that went',
       made.err || (sumOf(looseOut) + ' of ' + held + ' loose sats went; ' + sumOf(after) + ' are still in the pile'));
  }

  /* ---- 8: what waits at one mint is that mint's, and is asked about there ---
   *
   * A phone took sats offline at one mint and its home screen at another
   * showed them, as a balance that was not all spendable. And a receiver,
   * away at a payer's mint, asked that mint about its own mint's invoice
   * every three seconds. */
  {
    const seed = page();
    await fund(seed, THEIR, 2000);
    const rx = page({ mints: seed.mints, words: OTHER_WORDS });
    await rx.W.connect(HOME, null, null, { remember: true });
    await rx.W.connect(THEIR, null, null, { remember: true });
    await rx.W.primeLocks();
    goOffline(rx);
    const payer = page({ mints: seed.mints, storage: dump(seed) });
    await payer.W.connect(THEIR, null, null, { remember: true });
    await payer.W.primeLocks();
    const L = { up: true, log: [], payer, receiver: rx };
    payer.link = L; rx.link = L;
    const ask = rx.W.decodeRequest(rx.W.paymentRequest(300, { purpose: 'receive' })) || {};
    const paid = await payer.W.payRequest(Object.assign({}, ask, { sats: 300, unit: 'sat', viaTap: true, theirRoute: false }), () => {}, { overpayOk: true })
      .then((r) => ({ made: r }), (e) => ({ err: e.message }));
    await settle();
    const at = async () => await rx.W.balanceSats();
    ok(!!paid.made && rx.W.unclaimedSats() === 300 && (await at()) === 300, 'a payment taken offline waits, and is in the balance of the mint it is at',
       paid.err || rx.W.unclaimedSats() + ' waiting, ' + (await at()) + ' shown');
    await rx.W.connect(HOME, null, null, { remember: false });
    ok((await at()) === 0 && rx.W.unclaimedSats(HOME) === 0, 'at another mint it is not in the balance: what shows there is what can be spent there',
       (await at()) + ' shown at ' + canon(rx.W.mintUrl) + ', ' + rx.W.balanceAt(HOME) + ' held');
    ok(rx.W.unclaimedSats(THEIR) === 300 && rx.W.unclaimedSats() === 300, 'it is still counted at its own mint, and in all that is waiting');
    await rx.W.connect(THEIR, null, null, { remember: false });
    ok((await at()) === 300, 'and back at its own mint it shows again', String(await at()));
    // a row kept before the mint was written on it is read from its token
    const rows = read(rx, 'foxy.req.unclaimed', {});
    Object.keys(rows).forEach((k) => { delete rows[k].mint; });
    rx.storage.setItem('foxy.req.unclaimed', JSON.stringify(rows));
    ok(rx.W.unclaimedSats(HOME) === 0 && rx.W.unclaimedSats(THEIR) === 300, 'a row written by an older Foxy is placed by the mint in its token');
  }
  {
    const p = page();
    // this mint's invoices stay unpaid: the fake one pays every invoice the moment it is made
    const mintHome = p.mints[HOME], answer = mintHome.handle;
    mintHome.handle = (m) => {
      const out = answer(m);
      return (typeof out === 'string' && /\/v1\/mint\/quote\/bolt11/.test(m.url)) ? out.replace('"state":"PAID"', '"state":"UNPAID"') : out;
    };
    await p.W.connect(THEIR, null, null, { remember: true });
    await p.W.connect(HOME, null, null, { remember: true });
    const inv = await p.W.invoice(500, '');
    const about = (mint) => p.hits.filter((h) => h.indexOf(mint + '/v1/mint/quote/bolt11/' + inv.hash) >= 0).length;
    const stop = p.W.watch(inv.hash, () => {}, { pollMs: 5 });
    await settle(300);
    ok(about(HOME) > 0, 'an invoice on screen is asked about at the mint that made it', about(HOME) + ' questions');
    await p.W.connect(THEIR, null, null, { remember: false });
    await settle(50);
    p.hits.length = 0;
    await settle(600);
    ok(about(THEIR) === 0 && about(HOME) === 0, 'away at another mint, that mint is not asked about it, and nor is its own',
       about(THEIR) + ' there, ' + about(HOME) + ' at home');
    const e = await p.W.claim(inv.hash).then(() => null, (x) => x);
    ok(!!e && e.foxyElsewhere === true && e.noCounters === true && /another mint/.test(e.message)
       && !p.hits.some((h) => /POST .*\/v1\/mint\/bolt11$/.test(h)),
       'nor is it claimed there: nothing is asked, and no counter is spent', e ? e.message.slice(0, 70) : 'it was claimed');
    ok(!(read(p, 'foxy.cashu.quotes', []).filter((q) => q.quote === inv.hash)[0] || {}).unclaimed, 'and that is not filed as trouble with the invoice');
    await p.W.connect(HOME, null, null, { remember: false });
    p.hits.length = 0;
    await settle(300);
    ok(about(HOME) > 0, 'home again, it is asked about again', about(HOME) + ' questions');
    stop();
  }

  /* ---- 9: ecash this phone took, offered to it again ----------------------
   *
   * A payment landed and its "paid" never reached the payer, who showed the
   * same payment as a code. Scanned by the phone that had the money, the mint
   * says spent. The refusal is marked as this phone's own doing, so the
   * screen can say YOU ALREADY HAVE THIS PAYMENT; its wording is unchanged,
   * because the claims that read "already spent" to drop a row still must. */
  {
    const seed = page();
    await fund(seed, HOME, 2000);
    const rx = page({ mints: seed.mints, words: OTHER_WORDS });
    await rx.W.connect(HOME, null, null, { remember: true });
    const made = await seed.W.sendToken(300, { unit: 'sat' });
    const first = await rx.W.receiveToken(made.token).then((r) => r, (e) => ({ err: e.message }));
    const again = await rx.W.receiveToken(made.token).then(() => null, (e) => e);
    ok(!first.err && !!again && again.foxyMine === true && again.foxyTakenSats === first.sats && Date.now() - again.foxyTakenAt < 60000,
       'a token this phone swapped in, offered again, is refused and marked as its own', first.err || (again ? JSON.stringify({ mine: again.foxyMine, sats: again.foxyTakenSats }) : 'it was taken twice'));
    ok(!!again && /already spent|nothing to take/i.test(again.message), 'the refusal keeps its wording, which the late claims read', again ? again.message : '');
    const kept = rx.storage.getItem('foxy.cashu.taken') || '';
    const secrets = (seed.W.tokenInfo(made.token).proofs || []).map((pr) => String(pr.secret));
    const rows = read(rx, 'foxy.cashu.taken', []);
    ok(rows.length === 1 && Object.keys(rows[0]).sort().join() === 'at,f,sats' && secrets.length > 0 && !secrets.some((x) => kept.indexOf(x) >= 0),
       'what is remembered is a fingerprint, an amount and a time, and no secret', kept.slice(0, 80));
    // somebody else's doing is not this phone's
    const other = page({ mints: seed.mints, words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' });
    await other.W.connect(HOME, null, null, { remember: true });
    const second = await seed.W.sendToken(200, { unit: 'sat' });
    await other.W.receiveToken(second.token);
    const theirs = await rx.W.receiveToken(second.token).then(() => null, (e) => e);
    ok(!!theirs && !theirs.foxyMine && /already spent|nothing to take/i.test(theirs.message), 'a token somebody else took is refused without the mark', theirs ? String(theirs.message).slice(0, 60) : 'it was taken');
    ok(rx.W.balanceAt(HOME) === first.sats, 'and the balance holds it once', rx.W.balanceAt(HOME) + ' of ' + first.sats);
  }
  {
    // the tap's own road: paid over the link, taken, then the same payment scanned as a code
    const seed = page();
    await fund(seed, THEIR, 2000);
    const rx = page({ mints: seed.mints, words: OTHER_WORDS });
    await rx.W.connect(THEIR, null, null, { remember: true });
    await rx.W.primeLocks();
    const payer = page({ mints: seed.mints, storage: dump(seed) });
    await payer.W.connect(THEIR, null, null, { remember: true });
    await payer.W.primeLocks();
    const L = { up: true, log: [], payer, receiver: rx };
    payer.link = L; rx.link = L;
    let body = '';
    const heard = rx.W._requestPaid;
    rx.W._requestPaid = function (b) { body = String(b); return heard.apply(this, arguments); };
    const ask = rx.W.decodeRequest(rx.W.paymentRequest(300, { purpose: 'receive' })) || {};
    const paid = await payer.W.payRequest(Object.assign({}, ask, { sats: 300, unit: 'sat', viaTap: true, theirRoute: true }), () => {}, { overpayOk: true })
      .then((r) => ({ made: r }), (e) => ({ err: e.message }));
    await settle(800);
    let code = '';
    try { const j = JSON.parse(body); code = rx.window.CashuTS.getEncodedToken({ mint: j.mint, proofs: j.proofs, unit: j.unit || 'sat' }); } catch (e) {}
    const had = rx.W.balanceAt(THEIR);
    const again = code ? await rx.W.receiveToken(code).then(() => null, (e) => e) : null;
    ok(!!paid.made && had >= 300 && !!again && again.foxyMine === true && rx.W.balanceAt(THEIR) === had,
       'a payment taken over the link, then scanned as a code by the same phone, is marked as already its own and adds nothing',
       paid.err || (again ? 'mine ' + again.foxyMine + ', ' + rx.W.balanceAt(THEIR) + ' held' : 'no code, or it was taken twice'));
  }

  console.log(failed ? '\n' + failed + ' crossing check(s) failed' : '\nall crossing checks pass');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
