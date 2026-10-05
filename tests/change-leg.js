'use strict';
/* change-leg.js — the link a payment's change has to come back over.
 *
 *     node tests/change-leg.js
 *
 * Every failure of the change leg on glass has been a lifetime bug, not a money
 * bug. The proofs were right every time; the link was gone. Three of them, in
 * order, each found only by two people standing in a room:
 *
 *   - the receiver answered M6 and its own teardown fired two seconds later,
 *     while the swap that makes the change was still at the mint (3.4s). The
 *     guard that protects the link was set inside `sendChange`, which runs
 *     after the swap — so it was set after the link had gone;
 *   - the payer let go the moment the person got back to the home screen, one
 *     second before the change was ready;
 *   - and before either, the payer would not even make the payment, because an
 *     offline receiver names no transport and the open link was not counted as
 *     one.
 *
 * None of it is reachable from the money tests, because the money never moves
 * until the link has already decided. So this models the link: both pages, the
 * real message order, and the two clocks that actually killed it.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };

/* The link, as the radio really behaves.
 *
 * `up` is the BLE connection. The receiver's own teardown is armed when it
 * answers M6 and fires `teardownMs` later unless change has been declared owed
 * (`tapChangeDue`); without that the link is gone before the change is ready.
 * The payer can also let go, which loses the change the same way. Anything
 * sent over a link that is
 * down fails the way CoreBluetooth fails it: "no longer connected".
 */
function link(opts) {
  const o = opts || {};
  const L = {
    up: true, owed: false, asking: false, teardown: null,
    log: [],
    payer: null, receiver: null,          // the two pages, wired in below
    teardownMs: o.teardownMs === undefined ? 2000 : o.teardownMs,
  };
  L.down = (why) => {
    if (!L.up) return;
    L.up = false;
    L.log.push('down: ' + why);
    clearTimeout(L.teardown);
  };
  /* The receiver stops wanting the link the moment its screen changes, and the
   * real one waits two seconds before acting on that — unless change is owed. */
  L.receiverDone = () => {
    clearTimeout(L.teardown);
    L.teardown = setTimeout(() => {
      if (L.owed) { L.log.push('kept: change is owed'); return; }
      L.down('the receiver finished with it');
    }, L.teardownMs);
  };
  return L;
}

/* A page, with its bridge wired to the link. */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  const answers = [];
  let mint = null;
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      const L = ctx.link;
      switch (m.action) {
        case 'mintRequest':
          if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
          // a swap whose answer never comes, or that the mint will not make
          if (ctx.swapFate && String(m.url || '').indexOf('/v1/swap') >= 0) {
            if (ctx.swapFate === 'lost') return reply(w, m.id, null, 'The network connection was lost.');
            return reply(w, m.id, '400\n' + JSON.stringify({ detail: 'This mint is not taking swaps.', code: 11000 }));
          }
          /* The next swap this page asks for, held at the mint until the test lets it go. */
          if (ctx.holdSwap && String(m.url || '').indexOf('/v1/swap') >= 0) {
            const h = ctx.holdSwap;
            ctx.holdSwap = null;
            h.held = true;
            return h.until.then(() => reply(w, m.id, mint.handle(m)));
          }
          return reply(w, m.id, mint.handle(m));
        case 'inboxAnswer':
          // as the phone passes it on (`handleInboxAnswer`): 200, 409 and 422, anything else as 422
          answers.push({ status: [200, 409, 422].indexOf(Number(m.status)) >= 0 ? Number(m.status) : 422, text: String(m.text || '') });
          // M6, back down the link to the payer
          if (L) { L.log.push('M6 ' + m.status); L.receiverDone(); }
          return reply(w, m.id, 'ok');
        case 'tapChangeDue':
          if (L) { L.owed = true; L.log.push('change declared owed'); }
          return reply(w, m.id, 'ok');
        case 'tapAsking':
          if (L) { L.asking = true; L.log.push('asking'); }
          return reply(w, m.id, 'ok');
        case 'tapChange':
          // M7: money going back over the link, if it is still there
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M7 change');
          // what this phone's own entry for the payment says while the change is on its way
          ctx.atHandoff = history(ctx).filter((e) => e.dir === 'in' && /^req-/.test(String(e.hash || '')))[0] || null;
          setTimeout(() => L.payer && L.payer.W._tapChange(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapChangeKept':
          if (L) { L.log.push('M8 kept=' + !!m.kept); L.owed = false; L.down('the change was kept'); }
          return reply(w, m.id, 'ok');
        case 'tapSend': {
          // M5: the payment, over the link
          if (!L || !L.up) return reply(w, m.id, null, 'That phone is no longer connected.');
          L.log.push('M5 payment');
          setTimeout(() => L.receiver.W._requestPaid(String(m.body || ''), 'wire', 'tap'), 0);
          // the payer's answer comes when the receiver answers; poll for it
          const began = L.receiver.answers.length;
          const wait = setInterval(() => {
            const said = L.receiver.answers;
            if (said.length <= began) return;
            clearInterval(wait);
            const last = said[said.length - 1];
            // M6 as the receiver's phone seals it (TapLink.swift `sealResult`), which is what `tapSend` reads
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
    before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, { p2pk: true, feePpk: opts.feePpk }); },
  });
  ctx.deaf = !!opts.deaf;
  ctx.mint = mint;
  ctx.answers = answers;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
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
const dump = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const history = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');

/* An offline payer with no exact pieces, and an online receiver, wired together
 * over one link. `teardownMs` is how long the receiver's radio waits after M6. */
async function pair(opts) {
  const o = opts || {};
  const seed = page({ feePpk: o.feePpk });
  await seed.W.connect(MINT, null, null, { remember: true });
  const inv = await seed.W.invoice(3000, '');
  await seed.W.claim(inv.hash);
  const carried = dump(seed);
  const shared = seed.mint;

  const rx = page({ sharedMint: shared,
    words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
  await rx.W.connect(MINT, null, null, { remember: true });
  const rinv = await rx.W.invoice(2000, '');
  await rx.W.claim(rinv.hash);
  await rx.W.primeLocks();

  const payer = page({ storage: carried, sharedMint: shared });
  await payer.W.connect(MINT, null, null, { remember: true });
  payer.deaf = true;
  goOffline(payer.W);
  await payer.W.connect(MINT, null, null, { remember: true });

  const L = link({ teardownMs: o.teardownMs });
  L.payer = payer; L.receiver = rx;
  payer.link = L; rx.link = L;

  /* What the app does when change arrives (15-paid-wake-keyboard.js): keep it —
   * offline that means writing it down rather than swapping — then tell the
   * receiver, then finish the payment's own entry. The wallet has no handler of
   * its own, so without this the payer hears the change and does nothing with
   * it, which is not the app's behaviour and not what is being tested here. */
  payer.changes = [];
  payer.W.onTapChange((token) => {
    const bits = payer.W.tokenInfo(token);
    const sats = (bits.proofs || []).reduce((a, pr) => a + Number(pr.amount || 0), 0);
    payer.changes.push(sats);
    payer.lastChange = token;
    try {
      payer.W.keepChange(token, sats);
      // what it is worth here, as the app settles it: the token less this mint's fee for taking it
      if (payer.lastHash) payer.W.changeSettled(payer.lastHash, payer.W.changeNet ? payer.W.changeNet(token) : sats);
      payer.W.tapChangeKept(true);
    } catch (e) { payer.W.tapChangeKept(false); }
  });
  return { payer, rx, L };
}

async function run() {
  /* ---- 1: the whole leg, over one link ---------------------------------- */
  {
    const t = await pair();
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { purpose: 'receive' })) || {};
    const before = await t.payer.W.balanceSats();

    const paid = await t.payer.W.payRequest(Object.assign({}, ask, {
      sats: 100, unit: 'sat', viaTap: true,
    }), () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
    ok(!!paid.made, 'an offline payer with no exact pieces pays over the link',
       paid.made ? 'paid' : paid.why);
    /* And the token names the key its change is locked to. Over the link the
     * key rides beside the payment; shown as a code after the link dropped,
     * the token was all the receiver had and it named nothing, so the change
     * never came back (offline-cross-scenarios.js `over-cut`). */
    {
      const note = paid.made ? t.rx.W.changeNoteOf(paid.made.token) : null;
      ok(!!note && /^0[23][0-9a-f]{64}$/.test(note.changeTo) && note.asked === 100,
        'the token it paid with names the key for its change, and what was asked', JSON.stringify(note));
    }
    if (paid.made) t.payer.lastHash = paid.made.hash;
    ok(paid.made && paid.made.over === 28, 'over-paying by 28', JSON.stringify(paid.made && paid.made.over));

    await settle(900);
    /* What the app asks before it keeps any of it (W.checkChange, from an
     * audit): owed, no more than owed, this mint, and locked to a key
     * this phone asked for. M7 is the other phone's word. */
    {
      const tok = t.payer.lastChange;
      const good = tok ? t.payer.W.checkChange(tok, 28) : { ok: false, why: 'no change arrived' };
      ok(good.ok === true && good.sats === 28, 'the real change passes the check', JSON.stringify(good));
      const none = t.payer.W.checkChange(tok, 0);
      ok(none.ok === false && /no change was owed/.test(none.why), 'change nobody was owed is refused', none.why);
      /* A fee's worth over is the receiver padding for this phone's swap and is
       * kept (853 for 850 across mints); well over is refused. */
      const near = t.payer.W.checkChange(tok, 25);
      ok(near.ok === true && near.sats === 28, 'change a few sats over what was owed is kept: the receiver paid the fee', JSON.stringify(near));
      const more = t.payer.W.checkChange(tok, 20);
      ok(more.ok === false && /more than/.test(more.why), 'change well over what was owed is refused', more.why);
      // a token locked to somebody else's key (the generator point), and one locked to nobody
      const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
      const theirs = await t.rx.W.sendToken(5, { unit: 'sat', lockTo: G, purpose: 'change' }).catch((e) => ({ why: e.message }));
      const wrong = theirs.token ? t.payer.W.checkChange(theirs.token, 28) : { ok: null, why: theirs.why };
      ok(wrong.ok === false && /not locked to a key this phone asked for/.test(wrong.why),
         'change locked to somebody else is refused', wrong.why);
      const plain = await t.rx.W.sendToken(5, { unit: 'sat' }).catch((e) => ({ why: e.message }));
      const open = plain.token ? t.payer.W.checkChange(plain.token, 28) : { ok: null, why: plain.why };
      ok(open.ok === false && /not locked to a key this phone asked for/.test(open.why),
         'and so is change locked to nobody', open.why);
      const junk = t.payer.W.checkChange('cashuBnotatoken', 28);
      ok(junk.ok === false, 'and a token that does not read', junk.why);
    }
    ok(t.L.log.indexOf('change declared owed') >= 0,
       'the receiver declares the change owed before it goes to the mint',
       t.L.log.join(' | '));
    ok(t.L.log.indexOf('down: the receiver finished with it') < 0,
       'so its own teardown never takes the link', t.L.log.join(' | '));
    ok(t.L.log.indexOf('M7 change') >= 0, 'and the change goes back over it',
       t.L.log.join(' | '));
    ok(t.L.log.some((l) => l.indexOf('M8') === 0), 'and the payer says it kept it',
       t.L.log.join(' | '));

    const owed = t.L.log.indexOf('change declared owed');
    const tore = t.L.log.findIndex((l) => l.indexOf('down:') === 0);
    ok(owed >= 0 && (tore < 0 || tore > t.L.log.indexOf('M7 change')),
       'the link never went down before the change crossed it', t.L.log.join(' | '));

    ok(t.payer.changes.length === 1 && t.payer.changes[0] === 28,
       'the payer receives 28 sats of change', JSON.stringify(t.payer.changes));
    const after = await t.payer.W.balanceSats();
    ok(after === before - 100, 'and is out exactly what it paid',
       String(after) + ' vs ' + (before - 100));

    const entries = history(t.payer).filter((e) => e.dir === 'out');
    ok(entries.length === 1, 'with one transaction, not two', String(entries.length));
    ok(entries[0] && entries[0].sats === 100 && entries[0].grossSats === 128
       && entries[0].changeSats === 28 && entries[0].changeState === 'came back',
       'showing the net, with what moved and what came back kept on it',
       JSON.stringify(entries[0] && { sats: entries[0].sats, gross: entries[0].grossSats,
                                      change: entries[0].changeSats, state: entries[0].changeState }));

    /* The receiver's entry for the same payment says it was given back once
     * the payer has kept it, and holds the change itself: locked to the payer,
     * so a payer who says it never came can be shown it. */
    const rrow = history(t.rx).filter((e) => e.dir === 'in' && /^req-/.test(String(e.hash || '')))[0] || {};
    ok(rrow.sats === 100 && rrow.grossSats === 128 && rrow.changeSats === 28
       && rrow.changeState === 'given back' && rrow.changeKept === true,
       'the receiver\'s entry says what it kept and that the change was given back, once the payer has kept it',
       JSON.stringify({ sats: rrow.sats, gross: rrow.grossSats, change: rrow.changeSats, state: rrow.changeState, kept: rrow.changeKept }));
    const heldBack = rrow.hash ? t.rx.W.tagsFor(rrow.hash).changeToken : '';
    ok(typeof heldBack === 'string' && heldBack.length > 0 && heldBack === t.payer.lastChange,
       'the change the receiver made is kept on the payment\'s entry, the same token the payer was handed',
       typeof heldBack === 'string' ? heldBack.length + ' characters' : String(heldBack));
  }

  /* ---- 2: the receiver's teardown beats the mint ------------------------
   * Without the early declaration the receiver's own teardown beats the mint. */
  {
    const t = await pair({ teardownMs: 0 });
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { purpose: 'receive' })) || {};
    // the old behaviour: nothing tells the link that change is coming
    t.rx.W.tapChangeDue = () => Promise.resolve();
    await t.payer.W.payRequest(Object.assign({}, ask, { sats: 100, unit: 'sat', viaTap: true }),
      () => {}, { overpayOk: true }).catch(() => {});
    await settle(900);
    ok(t.L.log.indexOf('M7 change') < 0,
       'without the early word the change never crosses — which is the bug',
       t.L.log.join(' | '));
    ok(t.L.log.some((l) => l === 'down: the receiver finished with it'),
       'because the link is gone by the time the mint answers', t.L.log.join(' | '));
    /* The payer paid 128 for 100 and nothing came back. Its entry says what
     * was paid, and that the other 28 are still owed to it, not that they came. */
    const out = history(t.payer).filter((e) => e.dir === 'out')[0] || {};
    ok(out.sats === 100 && out.grossSats === 128 && out.changeSats === 28 && out.changeState === 'owed',
       'the payer\'s entry says what it paid and that 28 sats of change are still owed',
       JSON.stringify({ sats: out.sats, gross: out.grossSats, change: out.changeSats, state: out.changeState }));
  }

  /* ---- 3: a receiver that tears down instantly ---------------------------
   * The guard has to hold however fast the radio is. */
  {
    const t = await pair({ teardownMs: 0 });
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { purpose: 'receive' })) || {};
    await t.payer.W.payRequest(Object.assign({}, ask, { sats: 100, unit: 'sat', viaTap: true }),
      () => {}, { overpayOk: true }).catch(() => {});
    await settle(900);
    ok(t.L.log.indexOf('M7 change') >= 0,
       'the change still crosses a link whose receiver finished with it at once',
       t.L.log.join(' | '));
  }

  /* ---- 4: a mint that charges, and nobody owed anything -----------------
   * Two phones online at a mint with an input fee. The payer adds the
   * receiver's fee on purpose, so what arrives is more than what was asked by
   * exactly that fee. `changeBack` took that for an overpayment: change was
   * made out of the receiver's own money, the payer refused it as change it
   * was not owed, and a code went up to be scanned — on every payment, at
   * macadamia and never at Minibits. */
  {
    const payer = page({ feePpk: 1000 });
    await payer.W.connect(MINT, null, null, { remember: true });
    await payer.W.claim((await payer.W.invoice(3000, '')).hash);
    const rx = page({ sharedMint: payer.mint,
      words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
    await rx.W.connect(MINT, null, null, { remember: true });
    await rx.W.claim((await rx.W.invoice(2000, '')).hash);
    await rx.W.primeLocks();
    const L = link({});
    L.payer = payer; L.receiver = rx; payer.link = L; rx.link = L;
    payer.changes = [];
    payer.W.onTapChange((token) => { payer.changes.push(token); payer.W.tapChangeKept(false); });

    const rows = (c) => history(c).reduce((a, e) => a + (e.dir === 'in' ? Number(e.sats)
      : -(Number(e.sats) + (Number(e.feeSats) || 0))), 0);
    for (const want of [100, 9, 1181]) {
      const rxBefore = await rx.W.balanceSats();
      const ask = rx.W.decodeRequest(rx.W.paymentRequest(want, { purpose: 'receive' })) || {};
      const lack = payer.W.sendShortfall(want, { locked: !!ask.lockTo });
      const paid = await payer.W.payRequest(Object.assign({}, ask, { sats: want, unit: 'sat', viaTap: true }),
        () => {}, {}).then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
      ok(!!paid.made && lack && !lack.short, want + ' sats at a fee mint: the card allows it and it is paid',
         paid.made ? '' : paid.why + ' ' + JSON.stringify(lack));
      await settle(1500);
      const rxAfter = await rx.W.balanceSats();
      const row = history(rx).filter((e) => e.dir === 'in' && /^req-/.test(String(e.hash || '')))[0] || {};
      const said = JSON.stringify({ sats: row.sats, fee: row.feeSats, gross: row.grossSats, change: row.changeSats });
      /* Whether change is owed at all is the row's to say: at this fee the
       * payer's own rounding can land a sat over (9 asked arrives as 13 with
       * 3 of fee). What must hold either way is that change crosses exactly
       * when the entry says it was owed, and the entry is what stayed. */
      const crossed = L.log.indexOf('M7 change') >= 0;
      ok(crossed === (Number(row.changeSats) > 0), want + ' sats: change crosses only when the entry says it was owed',
         said + ' | ' + L.log.join(' | '));
      ok(Number(row.sats) === rxAfter - rxBefore, want + ' sats: the entry is what stayed on this phone',
         said + ', rose by ' + (rxAfter - rxBefore));
      if (want === 100) {
        ok(!crossed && rxAfter - rxBefore === 100,
           '100 sats: the fee the payer added is not taken for an overpayment, and the receiver nets 100',
           said + ', rose by ' + (rxAfter - rxBefore));
      }
      /* A new link for the next payment. The last one's teardown is still
       * on its two-second clock, and on a slow run it fired in the middle of
       * the next payment and took the link down under it. */
      clearTimeout(L.teardown);
      L.up = true; L.owed = false; L.log.length = 0;
      rx.answers.length = 0;
    }
    ok(rows(rx) === await rx.W.balanceSats(), 'the receiver\'s entries add up to its balance',
       rows(rx) + ' vs ' + await rx.W.balanceSats());
    ok(rows(payer) === await payer.W.balanceSats(), 'and so do the payer\'s, with each swap\'s fee on its entry',
       rows(payer) + ' vs ' + await payer.W.balanceSats());
  }

  /* ---- 5: who pays for change ------------------------------------------
   * The rule: the receiver keeps exactly what it asked
   * for, and the payer who paid over carries the cost of getting the
   * difference back. At a mint charging 150 ppk that cost is 2 sats — one to
   * spend a piece making the change, one carried in the token so the payer's
   * own swap is paid for — and before this it came out of the receiver: a
   * request for 100 left it 98 (tools/live/tap-scenarios.js 2b). */
  {
    const t = await pair({ feePpk: 150 });
    const rows = (c) => history(c).reduce((a, e) => {
      if (e.dir === 'in' && /^(tap|req)-change-/.test(String(e.hash || ''))) return a;
      return a + (e.dir === 'in' ? Number(e.sats) : -(Number(e.sats) + (Number(e.feeSats) || 0)));
    }, 0);
    const rxBefore = await t.rx.W.balanceSats();
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { purpose: 'receive' })) || {};
    const paid = await t.payer.W.payRequest(Object.assign({}, ask, { sats: 100, unit: 'sat', viaTap: true }),
      () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
    ok(!!paid.made && paid.made.over > 2, 'at a mint that charges, an offline payer pays over by more than change costs',
       paid.made ? paid.made.sats + ' handed, ' + paid.made.over + ' over' : paid.why);
    if (paid.made) t.payer.lastHash = paid.made.hash;
    await settle(1200);
    const rise = (await t.rx.W.balanceSats()) - rxBefore;
    ok(rise === 100, 'the receiver keeps exactly what it asked for', 'asked 100, up by ' + rise);
    const row = history(t.rx).filter((e) => e.dir === 'in' && /^req-/.test(String(e.hash || '')))[0] || {};
    ok(Number(row.sats) === 100, 'and its entry says so',
       JSON.stringify({ sats: row.sats, fee: row.feeSats, gross: row.grossSats, change: row.changeSats, cost: row.changeCost }));
    const back = t.payer.changes[0] || 0;
    ok(t.payer.changes.length === 1 && back > 0 && back < paid.made.over + 1,
       'the change that comes back is what was paid over less what it cost',
       back + ' in the token for ' + (paid.made && paid.made.over) + ' over');
    ok(rows(t.rx) === await t.rx.W.balanceSats(), 'the receiver\'s entries add up', rows(t.rx) + ' vs ' + await t.rx.W.balanceSats());
    // the payer comes back online and takes its change in
    goOnline(t.payer.W); t.payer.deaf = false;
    await t.payer.W.claimUnclaimed();
    ok(rows(t.payer) === await t.payer.W.balanceSats(), 'and the payer\'s do, once its change is swapped in',
       rows(t.payer) + ' vs ' + await t.payer.W.balanceSats());
  }

  /* ---- 6: paid over by too little to come back -------------------------
   * One sat over at 150 ppk would cost two to return. Nothing is made, the
   * payer is not left waiting for it, and each entry is what really moved. */
  {
    const t = await pair({ feePpk: 150 });
    const rxBefore = await t.rx.W.balanceSats();
    const payerBefore = await t.payer.W.balanceSats();
    // the payer holds 2048 512 256 128 32 16 8: 126 is covered by the 128, with 1 for the receiver's fee and 1 over
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(126, { purpose: 'receive' })) || {};
    const paid = await t.payer.W.payRequest(Object.assign({}, ask, { sats: 126, unit: 'sat', viaTap: true }),
      () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
    ok(!!paid.made && paid.made.over === 0 && paid.made.dust === 1,
       'a sat over is not change to wait for: the payer is told none is coming',
       paid.made ? JSON.stringify({ sats: paid.made.sats, over: paid.made.over, dust: paid.made.dust }) : paid.why);
    await settle(1200);
    ok(t.L.log.indexOf('M7 change') < 0 && t.L.log.indexOf('change declared owed') < 0 && !t.payer.changes.length,
       'and the receiver makes none', t.L.log.join(' | '));
    const rise = (await t.rx.W.balanceSats()) - rxBefore;
    const row = history(t.rx).filter((e) => e.dir === 'in' && /^req-/.test(String(e.hash || '')))[0] || {};
    ok(rise === 127 && Number(row.sats) === 127, 'the sat stays with the payment, and the entry says what stayed',
       'asked 126, up by ' + rise + ', entry ' + row.sats);
    const out = history(t.payer).filter((e) => e.dir === 'out')[0] || {};
    ok(payerBefore - (await t.payer.W.balanceSats()) === 128 && Number(out.sats) === 128 && !out.changeState,
       'the payer\'s entry is the whole of what left, with nothing marked as owed',
       JSON.stringify({ sats: out.sats, change: out.changeSats, state: out.changeState, dust: out.dustSats }));
  }

  /* ---- 7: a no that is true, and a not-yet that is said as one -----------
   * Plain ecash from an offline payer, and the receiver's swap does not come
   * back. It answered 422 — "they did not take it, your sats are still yours"
   * on the payer's screen — and kept the payment written down all the same,
   * to be claimed on the next connection (tools/live/tap-scenarios.js F10).
   * Whoever is told a payment failed pays again. */
  {
    const t = await pair();
    t.rx.swapFate = 'lost';
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(128, { purpose: 'receive' })) || {};
    const paid = await t.payer.W.payRequest(Object.assign({}, ask, { sats: 128, unit: 'sat', viaTap: true }),
      () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ e, why: (e && e.message) || String(e) }));
    await settle(600);
    const said = t.rx.answers[t.rx.answers.length - 1] || {};
    ok(said.status === 409 && t.rx.W.unclaimedSats() >= 128,
       'a swap that may have reached the mint: the receiver keeps what it wrote down and says it does not know yet',
       'answered ' + said.status + ', ' + t.rx.W.unclaimedSats() + ' written down');
    ok(!!paid.made && paid.made.confirmed === false,
       'and the payer hears "handed over, not confirmed", not that it failed', paid.made ? 'confirmed ' + paid.made.confirmed : paid.why);
    t.rx.swapFate = null;
    await t.rx.W.recoverSwaps(); await t.rx.W.claimUnclaimed();
    ok(t.rx.W.unclaimedSats() === 0 && (await t.rx.W.balanceSats()) === 2000 + 128,
       'it is taken when the mint can be asked', (await t.rx.W.balanceSats()) + ' held');
  }
  {
    const t = await pair();
    t.rx.swapFate = 'refuse';
    // the payer waits this long for its ecash to come back locked to it; ten seconds on a phone
    t.payer.W._refundWaitMs = 300;
    const had = await t.payer.W.balanceSats();
    const before = await t.rx.W.balanceSats();
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(128, { purpose: 'receive' })) || {};
    const paid = await t.payer.W.payRequest(Object.assign({}, ask, { sats: 128, unit: 'sat', viaTap: true }),
      () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ e, why: (e && e.message) || String(e) }));
    await settle(600);
    const said = t.rx.answers[t.rx.answers.length - 1] || {};
    ok(said.status === 422 && t.rx.W.unclaimedSats() === 0,
       'a swap the mint refused: the receiver says no and keeps nothing',
       'answered ' + said.status + ', ' + t.rx.W.unclaimedSats() + ' written down');
    /* Now (MONEY.md §15): nothing came back locked
     * to the payer, so the pieces the receiver saw are in the payer's wallet
     * again, counted and flagged at risk, not left behind a button. */
    ok(!paid.made && !!(paid.e && paid.e.foxyRefused) && !!(paid.e && paid.e.foxyAtRisk) && !paid.e.foxyToken,
       'the payer hears they did not take it, and that its ecash is at risk', paid.why);
    ok((await t.payer.W.balanceSats()) === had && t.payer.W.atRiskSats() >= 128,
       'the pieces are in its balance again, flagged', (await t.payer.W.balanceSats()) + ' held, ' + t.payer.W.atRiskSats() + ' at risk');
    t.rx.swapFate = null;
    await t.rx.W.recoverSwaps(); await t.rx.W.claimUnclaimed();
    ok((await t.rx.W.balanceSats()) === before, 'and that stays true: nothing is claimed later',
       (await t.rx.W.balanceSats()) + ' held, was ' + before);
  }

  /* ---- 8: what making change cost, on the entry it belongs to ----------
   * The cost of the change is worked out before its swap, and the swap can
   * land a sat either side of it. A sat cheaper than allowed for stays with
   * the payment, and the entry says so: it is what stayed on the phone, and
   * no more. At 300 ppk, 100 asked and 128 handed over, the change comes out
   * a sat cheaper. */
  {
    const t = await pair({ feePpk: 300 });
    const rowsOf = (x) => history(x).reduce((a, e) => {
      if (e.dir === 'in' && /^(tap|req)-change-/.test(String(e.hash || ''))) return a;
      return a + (e.dir === 'in' ? Number(e.sats) : -(Number(e.sats) + (Number(e.feeSats) || 0)));
    }, 0);
    const rxBefore = await t.rx.W.balanceSats();
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { purpose: 'receive' })) || {};
    const paid = await t.payer.W.payRequest(Object.assign({}, ask, { sats: 100, unit: 'sat', viaTap: true }),
      () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
    if (paid.made) t.payer.lastHash = paid.made.hash;
    await settle(1500);
    const rise = (await t.rx.W.balanceSats()) - rxBefore;
    const row = history(t.rx).filter((e) => e.dir === 'in' && /^req-/.test(String(e.hash || '')))[0] || {};
    const said = JSON.stringify({ sats: row.sats, fee: row.feeSats, dust: row.changeDust, change: row.changeSats,
                                  cost: row.changeCost }) + ', rose by ' + rise;
    ok(!!paid.made && Number(row.changeDust) === 1,
       'making the change came out a sat cheaper than allowed for, and the entry says so',
       paid.made ? said : paid.why);
    ok(Number(row.sats) === rise && rise === 101,
       'the sat stays with the payment: the entry is what stayed on the phone', said);
    ok(rowsOf(t.rx) === await t.rx.W.balanceSats(), 'so the receiver\'s entries add up to its balance',
       rowsOf(t.rx) + ' vs ' + await t.rx.W.balanceSats());
  }

  /* ---- 9: a payment that arrived locked, with a top-up in flight --------
   * Ecash locked to this phone is written down the moment it lands and
   * swapped in after, so the entry is there while the change is made and while
   * anything else the phone is doing at the mint finishes. A top-up swap that
   * lands in that gap puts its fee on the entry (the newest payment), and the
   * swap that then takes the payment in has to keep that charge rather than
   * write the entry afresh. Here the payer is online and hands over 128 for a
   * request of 100, locked, so the change goes back over the link as well. */
  {
    const t = await pair({ feePpk: 150 });
    goOnline(t.payer.W); t.payer.deaf = false;
    const rowOf = (c) => history(c).filter((e) => e.dir === 'in' && /^req-/.test(String(e.hash || '')))[0] || null;
    const rowsOf = (x) => history(x).reduce((a, e) => a + (e.dir === 'in' ? Number(e.sats) : -(Number(e.sats) + (Number(e.feeSats) || 0))), 0);
    const rxBefore = await t.rx.W.balanceSats();
    // the top-up is on its way to the mint, and held there while the payment arrives
    let letGo = null;
    const gate = { held: false, until: new Promise((r) => { letGo = r; }) };
    t.rx.holdSwap = gate;
    const topUp = t.rx.W.tidyChange();
    for (let i = 0; i < 100 && !gate.held; i++) await new Promise((r) => setTimeout(r, 20));
    const ask = t.rx.W.decodeRequest(t.rx.W.paymentRequest(100, { purpose: 'receive' })) || {};
    const paying = t.payer.W.payRequest(Object.assign({}, ask, { sats: 128, unit: 'sat', viaTap: true }),
      () => {}, { overpayOk: true }).then((r) => ({ made: r }), (e) => ({ why: (e && e.message) || String(e) }));
    for (let i = 0; i < 200 && !rowOf(t.rx); i++) await new Promise((r) => setTimeout(r, 20));
    letGo();
    const split = await topUp.then((r) => r, (e) => ({ skipped: (e && e.message) || String(e) }));
    const paid = await paying;
    await settle(1500);
    const rise = (await t.rx.W.balanceSats()) - rxBefore;
    const row = rowOf(t.rx) || {};
    const mid = t.rx.atHandoff || {};
    const said = JSON.stringify({ sats: row.sats, fee: row.feeSats, topUp: row.topUpFee, change: row.changeSats,
                                  state: row.changeState }) + ', rose by ' + rise;
    ok(!!paid.made && !split.skipped && Number(row.topUpFee) > 0 && row.changeSats === 28,
       'a payment locked to the receiver, with change owed, that a top-up lands in the middle of',
       paid.made ? said + ' ' + JSON.stringify(split) : paid.why);
    ok(mid.changeState === 'making' && mid.changeSats === 28,
       'while the change is on its way, the receiver\'s entry says it is being made',
       JSON.stringify({ state: mid.changeState, change: mid.changeSats }));
    ok(row.changeState === 'given back' && row.changeKept === true,
       'and once the payer has kept it, that it was given back', said);
    ok(Number(row.sats) === rise,
       'the top-up\'s fee is still on the entry once the payment is swapped in, and the entry is what stayed', said);
    ok(rowsOf(t.rx) === await t.rx.W.balanceSats(), 'so the receiver\'s entries add up to its balance',
       rowsOf(t.rx) + ' vs ' + await t.rx.W.balanceSats());
  }

  /* ---- 10: a token shown as a code, that paid over -----------------------
   * An offline payer with no exact pieces pays over and puts a key for the
   * difference in the token's note (the app asks for that when it is going to
   * show a code). Nobody is asked anything, because nothing is given away: the
   * receiver keeps what was asked, makes the rest locked to that key, and
   * shows it as a code to scan. */
  {
    const t = await pair();
    await t.payer.W.primeLocks();
    const made = await t.payer.W.sendToken(100, { cover: true, changeNote: true })
      .then((r) => r, (e) => ({ why: (e && e.message) || String(e) }));
    const note = made.token ? t.rx.W.changeNoteOf(made.token) : null;
    ok(!!made.token && made.over === 28 && made.changeAsked === true
       && !!note && /^0[23][0-9a-f]{64}$/.test(note.changeTo) && note.asked === 100,
       'a token that has to pay over is given a key for its change, with no question put to anybody',
       made.token ? JSON.stringify({ over: made.over, asked: made.changeAsked, note }) : made.why);
    const rxBefore = await t.rx.W.balanceSats();
    let shown = null;
    t.rx.W.onChangeStuck((x) => { shown = x; });
    const got = made.token ? await t.rx.W.receiveToken(made.token).then((r) => r, (e) => ({ why: e.message })) : {};
    await settle(1200);
    const rise = (await t.rx.W.balanceSats()) - rxBefore;
    const row = history(t.rx).filter((e) => e.dir === 'in' && e.hash === got.hash)[0] || {};
    ok(got.changeDue === 28 && rise === 100,
       'scanned by the receiver, it keeps what was asked and makes the 28 over as change',
       JSON.stringify({ due: got.changeDue, rose: rise, why: got.why }));
    ok(Number(row.sats) === 100 && row.grossSats === 128 && row.changeSats === 28,
       'and its entry says 100 for the payment, with the 128 that arrived and the 28 that went back beside it',
       JSON.stringify({ sats: row.sats, gross: row.grossSats, change: row.changeSats }));
    const back = shown && shown.token ? t.payer.W.checkChange(shown.token, 28) : { ok: false, why: 'no change was shown' };
    ok(!!shown && shown.sats === 28 && back.ok === true && back.sats === 28,
       'the change is shown as a code, locked to the key the payer named',
       JSON.stringify({ shown: shown && shown.sats, ok: back.ok, why: back.why }));
    const rows = history(t.rx).reduce((a, e) => a + (e.dir === 'in' ? Number(e.sats) : -(Number(e.sats) + (Number(e.feeSats) || 0))), 0);
    ok(rows === await t.rx.W.balanceSats(), 'and the receiver\'s entries add up to its balance',
       rows + ' vs ' + await t.rx.W.balanceSats());
  }

  /* ---- 11: change made and never put on its payment's entry --------------
   * Before the change was kept on the entry it was made, tagged under a hash
   * of its own, and a phone put away at that moment left the payment saying
   * the change was on its way for good. Found again when history is read, by
   * its amount and the minute it was made in, for as long as it can still be
   * of use: a day. */
  {
    const rx = page();
    await rx.W.connect(MINT, null, null, { remember: true });
    await rx.W.claim((await rx.W.invoice(2000, '')).hash);
    const px = page({ sharedMint: rx.mint,
      words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
    await px.W.connect(MINT, null, null, { remember: true });
    await px.W.primeLocks();
    const ask = px.W.decodeRequest(px.W.paymentRequest(300, { purpose: 'receive' })) || {};
    const lost = await rx.W.sendToken(300, { unit: 'sat', lockTo: ask.lockTo, purpose: 'change' })
      .then((r) => r, (e) => ({ why: (e && e.message) || String(e) }));
    const now = Math.floor(Date.now() / 1000);
    const written = (hash, age) => {
      const log = history(rx);
      log.unshift({ hash, dir: 'in', sats: 1180, grossSats: 1480, changeSats: 300, changeState: 'making',
                    at: now - age, settled: true, feeSats: 0 });
      rx.storage.setItem('foxy.cashu.log', JSON.stringify(log));
    };
    // a minute and a half old: past "it may still be on its way", well within a day
    written('req-lost-change', 90);
    // and older than a day: whatever was owed has been claimed or forgotten, and is left alone
    written('req-old-change', 90000);
    rx.W.repairOwedChange();
    await settle();
    const found = history(rx).filter((e) => e.hash === 'req-lost-change')[0] || {};
    ok(!!lost.token && found.changeState === 'not handed' && rx.W.tagsFor('req-lost-change').token === lost.token,
       'change that was made and never reached its payment\'s entry is found, and is on the entry to be shown',
       JSON.stringify({ state: found.changeState, why: lost.why }));
    const old = history(rx).filter((e) => e.hash === 'req-old-change')[0] || {};
    ok(old.changeState === 'making' && !rx.W.tagsFor('req-old-change').token,
       'a payment more than a day old is left as it was', JSON.stringify({ state: old.changeState }));
  }

  /* ---- 12: the fee a top-up swap costs -----------------------------------
   * Splitting a big piece into small ones costs a fee at a mint that charges
   * one. It is put on the newest payment at that mint that really moved
   * money, and every top-up adds to it. Not on a payment that failed, not on
   * an entry of nothing. A receive's amount drops by it. */
  {
    const t = page({ feePpk: 1000 });
    await t.W.connect(MINT, null, null, { remember: true });
    await t.W.claim((await t.W.invoice(3000, '')).hash);
    const funded = history(t)[0] || {};
    // newer than the receive: a payment that did not go through, and an entry of nothing
    const odd = [
      { hash: 'refused-ecash', dir: 'out', sats: 40, feeSats: 0, settled: false, state: 'failed', memo: 'ecash, refused', mint: MINT, at: funded.at },
      { hash: 'nothing-ecash', dir: 'in', sats: 0, feeSats: 0, settled: true, state: 'success', memo: 'ecash', mint: MINT, at: funded.at },
    ];
    t.storage.setItem('foxy.cashu.log', JSON.stringify(odd.concat(history(t))));
    const first = await t.W.tidyChange();
    const second = await t.W.tidyChange();
    const rowOf = (hash) => history(t).filter((e) => e.hash === hash)[0] || {};
    const got = rowOf(funded.hash);
    ok(!first.skipped && !second.skipped && got.feeSats === 2 && got.topUpFee === 2 && got.sats === 2998,
       'two top-ups at a fee mint: both fees are on the receive they followed, and its amount drops by them',
       JSON.stringify({ first, second, sats: got.sats, fee: got.feeSats, topUp: got.topUpFee }));
    const failed = rowOf('refused-ecash'), nil = rowOf('nothing-ecash');
    ok(!failed.feeSats && !failed.topUpFee && failed.sats === 40,
       'a payment that failed is not charged a fee it did not cost', JSON.stringify({ sats: failed.sats, fee: failed.feeSats, topUp: failed.topUpFee }));
    ok(!nil.feeSats && !nil.topUpFee && nil.sats === 0,
       'and neither is an entry of nothing', JSON.stringify({ sats: nil.sats, fee: nil.feeSats, topUp: nil.topUpFee }));
    ok(history(t).reduce((a, e) => a + (e.dir === 'in' ? Number(e.sats) : 0), 0) === await t.W.balanceSats(),
       'so what the receive says it kept is what the wallet holds', String(await t.W.balanceSats()));
  }

  console.log('\n' + (failed ? failed + ' change-leg check(s) failed'
    : 'all change-leg checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
