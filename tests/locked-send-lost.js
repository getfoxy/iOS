'use strict';
/* locked-send-lost.js — a locked send whose answer never comes back.
 *
 *     node tests/locked-send-lost.js
 *
 * The dangerous shape, and the one that cost real money on paper: the mint
 * swaps, and the answer is lost on the way home. For an ordinary send that is
 * survivable — the outputs are derived from the seed, the recorder kept their
 * counter ranges, and a restore brings them back. For a **locked** send it was
 * not. A P2PK output's secret is the spending condition, not a NUT-13 secret,
 * so cashu-ts reserves no counter for it and no seed can ever rebuild it. The
 * inputs were spent, the outputs had existed only in memory, and the payment
 * was gone: 21 sats on a reproduction, with the change stranded
 * behind a record that could never be matched.
 *
 * So the outputs are written down before the request leaves, and a lost answer
 * asks the mint for the signatures it made — NUT-09's restore takes blinded
 * messages, not only counter ranges. This asks the question the fix exists for:
 * after the answer is lost, is the money still there?
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, what) => {
  console.log((good ? 'ok   ' : 'FAIL ') + what);
  if (!good) failed += 1;
};

/* The bridge drops the answer to the first swap once `drop` is armed, after
 * letting the mint act on it — which is what makes it dangerous. */
function page(state, o) {
  const opts = o || {};
  /* A page opened over what another wrote gets that page's phone as it is
   * after the app was killed: the same keychain and the same counter file. */
  const phone = nativePhone({ words: PHONE_WORDS });
  if (opts.phone) { phone.counters = opts.phone.counters; phone.locks = opts.phone.locks; }
  let mint = opts.mint || null;
  let ctx = null;
  const answer = (w, id, text, err) => setTimeout(() => { if (!state.dead) w.FoxyWallet._scanResult(id, text, err); }, 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      // killed: nothing this page asks is answered again
      if (state.dead) return null;
      if (m.action === 'mintRequest') {
        const path = String(m.url || '');
        if (ctx && ctx.deaf) return answer(w, m.id, null, 'The Internet connection appears to be offline.');
        /* A mint that remembers the payment's own signatures and none of the
         * change's: `restoreOnly` is the set of blinded messages it answers for. */
        if (ctx && ctx.restoreOnly && path.indexOf('/v1/restore') >= 0) {
          const raw = mint.handle(m);
          const cut = raw.indexOf('\n');
          const body = JSON.parse(raw.slice(cut + 1));
          const keep = (body.outputs || []).map((o) => ctx.restoreOnly.has(o.B_));
          body.outputs = (body.outputs || []).filter((_, i) => keep[i]);
          body.signatures = (body.signatures || []).filter((_, i) => keep[i]);
          return answer(w, m.id, raw.slice(0, cut + 1) + JSON.stringify(body));
        }
        if (state.kill && path.indexOf('/v1/swap') >= 0) {
          if (state.acts) { mint.handle(m); state.acted = true; }   // the mint swaps, or never sees it
          state.dead = true;
          return null;
        }
        if (state.drop && path.indexOf('/v1/swap') >= 0) {
          state.drop = false;
          state.acted = true;
          mint.handle(m);                       // the mint really swaps
          return answer(w, m.id, null, 'The network connection was lost.');
        }
        return answer(w, m.id, mint.handle(m));
      }
      const got = phone.answer(w, m);
      if (!got) return answer(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => answer(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); if (!mint) mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.mint = mint;
  ctx.phone = phone;
  return ctx;
}

async function run() {
  const state = { drop: false, acted: false };
  const ctx = page(state);
  const W = ctx.W;
  await W.connect(MINT, { remember: true });

  const inv = await W.invoice(400, '');
  await W.claim(inv.hash);
  const before = await W.balanceSats();
  ok(before >= 400, 'the wallet has sats to send (' + before + ')');

  /* The lock key is derived from the seed by the phone now, and
   * `paymentRequest` is synchronous, so a request can only carry one the phone
   * derived earlier. The app primes them in `railRequest`. */
  await W.primeLocks();
  const req = W.decodeRequest(W.paymentRequest(21, { purpose: 'receive' }));
  ok(!!(req && req.lockTo), 'a request that asks for a lock');

  // ---- the answer is lost, after the mint has acted ------------------------
  state.drop = true;
  let made = null, threw = null;
  try { made = await W.sendToken(21, { unit: 'sat', lockTo: req.lockTo }); }
  catch (e) { threw = e; }
  ok(state.acted, 'the mint swapped, and the answer was lost on the way back');

  ok(!threw, 'the send does not fail' + (threw ? ' — ' + String(threw.message).slice(0, 90) : ''));
  ok(!!(made && made.token), 'a token comes back' + (made ? ' (' + made.sats + ' sats)' : ''));

  // the money: the token is the payment, the rest is still in the wallet
  const after = await W.balanceSats();
  const info = made && W.tokenInfo(made.token);
  const sent = info ? info.proofs.reduce((a, p) => a + Number(p.amount), 0) : 0;
  ok(sent >= 21, 'the token holds what was asked for (' + sent + ' sats)');
  ok(after + sent + (made ? made.fee || 0 : 0) >= before - 2,
    'and nothing else went missing: ' + before + ' -> ' + after + ' held + ' + sent + ' in the token');
  /* And nothing is counted twice. The swap's inputs are spent, so they are
   * out of the pile; a pile that kept them passed the line above, which only
   * asks whether anything is missing. */
  ok(after + sent <= before,
    'and what the swap spent is out of the pile: ' + after + ' held + ' + sent + ' in the token is no more than ' + before);

  // and it is a real locked token, claimable by the phone that asked
  let got = null;
  try { got = await W.receiveToken(made.token); } catch (e) { got = e; }
  ok(got && got.sats >= 21, 'the rebuilt token is claimable by the key the request kept ('
    + (got && got.sats) + ')');

  // ---- nothing is left behind ---------------------------------------------
  const swaps = JSON.parse(ctx.storage.getItem('foxy.cashu.swaps') || '[]');
  ok(!swaps.length, 'no orphan swap record is left to block a restore ('
    + swaps.length + ')');

  // ---- and again with nothing left over ------------------------------------
  {
    /* The case that destroyed the whole payment. A locked send reserves a
     * counter only for its change, so a send the pile can make exactly
     * reserves none — and `writeSwap` kept a record only when there were
     * ranges, so the locked rows went with it and a lost answer had nothing to
     * restore from. It is the common case, not the edge:
     * `tidyChange` keeps small pieces on hand so ordinary amounts can be made
     * exactly. */
    const state2 = { drop: false, acted: false };
    const ctx2 = page(state2);
    const W2 = ctx2.W;
    await W2.connect(MINT, { remember: true });
    /* 400 comes back as 256 + 128 + 16, so a send of 128 is one whole piece:
     * cashu-ts selects it alone, the swap has no change and reserves no
     * counter. That is the shape this case exists for. */
    const inv2 = await W2.invoice(400, '');
    await W2.claim(inv2.hash);
    const before2 = await W2.balanceSats();
    await W2.primeLocks();
    const req2 = W2.decodeRequest(W2.paymentRequest(128, { purpose: 'receive' }));

    state2.drop = true;
    let made2 = null, threw2 = null;
    try { made2 = await W2.sendToken(128, { unit: 'sat', lockTo: req2.lockTo }); }
    catch (e) { threw2 = e; }
    ok(state2.acted, 'the mint swapped an exact amount, and the answer was lost');
    ok(!threw2 && !!(made2 && made2.token),
      'a send with no change to reserve a counter for still comes back'
      + (threw2 ? ' — ' + String(threw2.message).slice(0, 80) : ''));
    const bits2 = made2 && W2.tokenInfo(made2.token);
    const sent2 = bits2 ? bits2.proofs.reduce((a, p) => a + Number(p.amount), 0) : 0;
    ok(sent2 === 128, 'and holds the whole amount (' + sent2 + ')');
    ok((await W2.balanceSats()) + sent2 >= before2 - 2,
      'with nothing else missing: ' + before2 + ' -> ' + (await W2.balanceSats())
      + ' held + ' + sent2 + ' in the token');
    ok((await W2.balanceSats()) + sent2 <= before2,
      'and the piece that paid it is out of the pile (' + (await W2.balanceSats()) + ' held)');
  }

  // ---- the app killed with the swap at the mint ----------------------------
  /* Everything above has a page that is still there when the answer is lost,
   * and its own guard asks the mint. A page that is KILLED in that second has
   * nobody left to ask: what survives is what was written down — the swap
   * record, the pile, the phone's keychain and counter file — and the next
   * launch has to finish it from those. It did not. `recoverSwaps` walked
   * counter ranges and a locked payment has none, so with exact pieces in the
   * mint was asked nothing, the pile went on showing pieces the mint had
   * spent, and after two minutes the record was dropped as "never made" with
   * the payment inside it (tools/live/tap-scenarios.js F3: 303
   * sats gone on a 300-sat payment, 512 where one large piece went in). */
  const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
  const swapsOf = (c) => JSON.parse(c.storage.getItem('foxy.cashu.swaps') || '[]');
  const rowsOf = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
  /* A wallet with 400 sats, then killed part-way through a locked send of
   * `sats`. `acts` is whether the swap reached the mint before the app died. */
  async function killedMidSend(sats, acts) {
    const st = { kill: false, dead: false, acted: false, acts: acts };
    const a = page(st);
    await a.W.connect(MINT, { remember: true });
    await a.W.claim((await a.W.invoice(400, '')).hash);
    const before = await a.W.balanceSats();
    await a.W.primeLocks();
    const req = a.W.decodeRequest(a.W.paymentRequest(sats, { purpose: 'receive' }));
    st.kill = true;
    a.W.sendToken(sats, { unit: 'sat', lockTo: req.lockTo }).then(() => {}, () => {});
    for (let i = 0; i < 400 && !st.dead; i++) await new Promise((r) => setTimeout(r, 5));
    const kept = dump(a);
    // opened again: a new page over what the last one wrote, on the same phone
    const b = page({ kill: false, dead: false }, { storage: kept, mint: a.mint, phone: a.phone });
    return { a, b, st, before, kept };
  }

  {
    /* 400 is 256 + 128 + 16, so 128 is one whole piece: no change, no counter. */
    const t = await killedMidSend(128, true);
    ok(t.st.dead && t.st.acted, 'killed with an exact locked send at the mint, which made it');
    const rec = JSON.parse(t.kept['foxy.cashu.swaps'] || '[]')[0] || {};
    ok(rec.kind === 'send' && (rec.locked || []).length > 0 && !(rec.outputs || []).length,
      'what was written down names the locked outputs and no counter range');
    const W = t.b.W;
    await W.connect(MINT, { remember: true });
    ok(W.heldSats() === 128 && (await W.balanceSats()) === t.before - 128,
      'opened again, the pieces that went into it are out of the balance until the mint is asked ('
      + W.heldSats() + ' held, ' + (await W.balanceSats()) + ' shown)');
    await W.recoverSwaps();
    const out = rowsOf(t.b).filter((e) => e.dir === 'out');
    const tags = out[0] ? W.tagsFor(out[0].hash) : null;
    ok(out.length === 1 && Number(out[0].sats) === 128 && !!(tags && tags.token),
      'the payment is rebuilt onto an entry of its own, with its token (' + JSON.stringify(out.map((e) => e.sats)) + ')');
    ok(W.heldSats() === 0 && !swapsOf(t.b).length && (await W.balanceSats()) === t.before - 128,
      'nothing is held any more, the record is gone, and the balance is what is left ('
      + (await W.balanceSats()) + ' of ' + t.before + ')');
    await W.recoverSwaps();
    ok(rowsOf(t.b).filter((e) => e.dir === 'out').length === 1, 'a second sweep writes no second entry');
    const got = tags && tags.token ? await W.receiveToken(tags.token).catch((e) => ({ why: e.message })) : null;
    ok(got && got.sats === 128, 'and the token is the payment: the key it was locked to takes it ('
      + (got && (got.sats || got.why)) + ')');
  }
  {
    /* 21 out of 400 takes one piece in and makes change: a range and locked rows. */
    const t = await killedMidSend(21, true);
    const rec = JSON.parse(t.kept['foxy.cashu.swaps'] || '[]')[0] || {};
    ok(t.st.acted && (rec.locked || []).length > 0 && (rec.outputs || []).length > 0,
      'killed with a locked send that makes change at the mint: the record names both');
    const W = t.b.W;
    await W.connect(MINT, { remember: true });
    const held = W.heldSats();
    await W.recoverSwaps();
    const out = rowsOf(t.b).filter((e) => e.dir === 'out');
    const tags = out[0] ? W.tagsFor(out[0].hash) : null;
    const bits = tags && tags.token ? W.tokenInfo(tags.token) : null;
    const sent = bits ? bits.proofs.reduce((x, pr) => x + Number(pr.amount), 0) : 0;
    ok(held > 0 && sent === 21 && (await W.balanceSats()) === t.before - 21 && !W.heldSats() && !swapsOf(t.b).length,
      'the payment and its change both come back: ' + sent + ' in the token, ' + (await W.balanceSats()) + ' of '
      + t.before + ' held, ' + held + ' had been set aside');
  }
  {
    /* The payment is back but its change is not: the mint answers for the locked
     * outputs and has nothing to say for the counter range. Both halves or
     * neither. Writing the payment alone would drop the record, and with it the
     * only note that the change was ever owed. */
    const t = await killedMidSend(21, true);
    const rec = JSON.parse(t.kept['foxy.cashu.swaps'] || '[]')[0] || {};
    const W = t.b.W;
    await W.connect(MINT, { remember: true });
    t.b.restoreOnly = new Set((rec.locked || []).map((r) => r.B_));
    await W.recoverSwaps();
    ok(!rowsOf(t.b).some((e) => e.dir === 'out') && swapsOf(t.b).length === 1,
      'a payment found without its change is not written, and its record is kept ('
      + rowsOf(t.b).filter((e) => e.dir === 'out').length + ' entries, ' + swapsOf(t.b).length + ' record)');
    ok(W.heldSats() > 0 && (await W.balanceSats()) < t.before,
      'and the pieces that went in stay out of the balance meanwhile (' + W.heldSats() + ' held)');
    t.b.restoreOnly = null;
    await W.recoverSwaps();
    const out = rowsOf(t.b).filter((e) => e.dir === 'out');
    ok(out.length === 1 && Number(out[0].sats) === 21 && !swapsOf(t.b).length && !W.heldSats()
       && (await W.balanceSats()) === t.before - 21,
      'once the mint answers for the change as well, both are written ('
      + (await W.balanceSats()) + ' of ' + t.before + ')');
  }
  {
    const t = await killedMidSend(128, false);
    ok(t.st.dead && !t.st.acted, 'killed before the swap reached the mint');
    const W = t.b.W;
    await W.connect(MINT, { remember: true });
    const held = W.heldSats();
    await W.recoverSwaps();
    ok(held === 128 && W.heldSats() === 0 && !swapsOf(t.b).length
       && (await W.balanceSats()) === t.before && !rowsOf(t.b).some((e) => e.dir === 'out'),
      'the mint says the pieces are unspent, so they are back and nothing is written (' + (await W.balanceSats()) + ' of ' + t.before + ')');
  }
  {
    /* Opened again with no connection: nothing can be asked, so nothing is
     * shown that might be gone, and nothing is dropped. */
    const t = await killedMidSend(128, true);
    const W = t.b.W;
    W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });
    W.setOffline(true);
    t.b.deaf = true;
    await W.connect(MINT, { remember: true });
    await W.recoverSwaps();
    ok(W.heldSats() === 128 && swapsOf(t.b).length === 1 && (await W.balanceSats()) === t.before - 128,
      'opened with no connection, the pieces are held and the record waits (' + W.heldSats() + ' held)');
    W.setOffline(false);
    W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    t.b.deaf = false;
    await W.recoverSwaps();
    ok(rowsOf(t.b).filter((e) => e.dir === 'out').length === 1 && !W.heldSats() && !swapsOf(t.b).length,
      'and with one again the payment is rebuilt');
  }

  console.log('');
  console.log(failed ? failed + ' locked-send check(s) failed' : 'all locked-send checks pass');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
