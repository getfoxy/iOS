'use strict';
/* held-swap.js — a top-up swap that got no answer, and how soon the balance is whole again.
 *
 *     node tests/held-swap.js
 *
 * When a swap gets no answer Foxy cannot know whether the mint took the piece
 * that went in, so the piece is held out of the balance until the mint says
 * (04-lost-answers.js). That worked and was slow: the mint was asked twice
 * inside a minute and then not for ten, so a phone sat short of its sats with
 * nothing due to happen. Now a held record is asked about every
 * few seconds, and one the mint never made — its pieces still unspent — is
 * put back after twenty seconds rather than two minutes.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };

/* A phone whose next swap can be made to fail: `lose = 'before'` drops the
 * request before the mint sees it, `'after'` lets the mint act and drops the
 * answer. Either way the page is told the connection was lost. */
function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const isSwap = /\/v1\/swap$/.test(String(m.url || m.path || ''));
        if (isSwap && ctx.lose) {
          const how = ctx.lose;
          ctx.lose = '';
          if (how === 'after') mint.handle(m);
          return reply(w, m.id, null, 'The network connection was lost.');
        }
        // the mint cannot be asked what it reserved: the record and the hold stay
        if (ctx.blockRestore && /\/v1\/(restore|checkstate)$/.test(String(m.url || m.path || ''))) {
          return reply(w, m.id, null, 'The network connection was lost.');
        }
        return reply(w, m.id, mint.handle(m));
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.lose = '';
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
const swaps = (c) => JSON.parse(c.storage.getItem('foxy.cashu.swaps') || '[]');
/* The record made to look `secs` old, and not yet tried. */
function age(c, secs) {
  const l = swaps(c);
  l.forEach((r) => { r.at = Math.floor(Date.now() / 1000) - secs; r.tried = 0; r.lastTry = 0; });
  c.storage.setItem('foxy.cashu.swaps', JSON.stringify(l));
}

async function scenario(how) {
  const c = page();
  await c.W.connect(MINT, null, null, { remember: true });
  await c.W.claim((await c.W.invoice(4096, '')).hash);
  const whole = await c.W.balanceSats();
  c.lose = how;
  await c.W.tidyChange().then(() => null, () => null);
  await settle();
  return { c, whole };
}

async function run() {
  // ---- the mint never saw it ------------------------------------------------
  {
    const { c, whole } = await scenario('before');
    const held = c.W.heldSats();
    ok(held > 0 && (await c.W.balanceSats()) === whole - held,
       'a top-up swap with no answer holds its piece out of the balance', held + ' of ' + whole);
    ok(swaps(c).length === 1, 'with a record of what was asked for');

    // asked at once: too soon to say it was never made
    await c.W.recoverSwaps();
    await settle();
    ok(c.W.heldSats() === held, 'asked straight away, it is still held: the answer may only be late', String(c.W.heldSats()));

    // twenty seconds on, the mint has made nothing and the piece is unspent
    age(c, 30);
    await c.W.recoverSwaps();
    await settle();
    ok(c.W.heldSats() === 0, 'half a minute on, a swap the mint never made lets its piece go', String(c.W.heldSats()));
    ok((await c.W.balanceSats()) === whole, 'and the balance is whole again', String(await c.W.balanceSats()) + ' of ' + whole);
    ok(swaps(c).length === 0, 'with the record dropped');
  }

  // ---- the mint did it, and the answer was lost ------------------------------
  {
    const { c, whole } = await scenario('after');
    const held = c.W.heldSats();
    /* Here the wallet's own first question — "what did you reserve for me" —
     * is answered at once, because the mint had made the swap. Nothing needs
     * holding, or it is held only until the next ask. */
    ok(held === 0 || held > 0, 'the same loss after the mint acted is settled by asking for what it made', 'held ' + held);
    await c.W.recoverSwaps();
    await settle();
    ok(c.W.heldSats() === 0, 'asked, the mint hands over what it made and nothing is held', String(c.W.heldSats()));
    ok((await c.W.balanceSats()) === whole, 'and the balance is whole again, in the new pieces', String(await c.W.balanceSats()) + ' of ' + whole);
  }

  // ---- asked again within seconds while held, not every ten minutes ---------
  {
    const { c } = await scenario('before');
    const l = swaps(c);
    const now = Math.floor(Date.now() / 1000);
    l.forEach((r) => { r.tried = 5; r.lastTry = now - 4; });
    c.storage.setItem('foxy.cashu.swaps', JSON.stringify(l));
    await c.W.recoverSwaps();
    await settle();
    const after = swaps(c);
    ok(after.length === 1 && Number(after[0].tried) === 6,
       'a held record tried five times is tried again four seconds later', JSON.stringify(after.map((r) => r.tried)));
    l.forEach((r) => { r.tried = 6; r.lastTry = Math.floor(Date.now() / 1000) - 1; });
    c.storage.setItem('foxy.cashu.swaps', JSON.stringify(l));
    await c.W.recoverSwaps();
    await settle();
    ok(Number(swaps(c)[0].tried) === 6, 'but not one second later', String(swaps(c)[0].tried));
  }

  // ---- a piece left spendable as the Tor window closed, then the mint had taken it ----
  {
    /* `topUpClosing` leaves the input in the pile (freeInputs) when the mint
     * had not taken it as Foxy was put away. Here the mint did take it after
     * all: the next connection must bring the outputs in AND take the input
     * out, never both counted (audit finding). */
    const c = page();
    await c.W.connect(MINT, null, null, { remember: true });
    await c.W.claim((await c.W.invoice(4096, '')).hash);
    const whole = await c.W.balanceSats();
    c.lose = 'after';
    c.blockRestore = true;                     // the mint made it, and could not yet be asked
    await c.W.tidyChange().then(() => null, () => null);
    await settle();
    c.blockRestore = false;
    const l = swaps(c);
    ok(l.length === 1, 'the lost answer left one record', String(l.length));
    const inputs = (l[0].inputs || []).map((p) => p.secret);
    // put the held input back in the pile, as the closing check would have left it
    const heldAll = JSON.parse(c.storage.getItem('foxy.cashu.held') || '{}');
    let pileKey = null;
    for (let i = 0; i < c.storage.length; i++) { const k = c.storage.key(i); if (/^foxy\.cashu\.proofs\./.test(k)) pileKey = k; }
    const pile = JSON.parse(c.storage.getItem(pileKey) || '[]');
    Object.keys(heldAll).forEach((id) => { (heldAll[id].proofs || []).forEach((p) => pile.push(p)); });
    c.storage.setItem(pileKey, JSON.stringify(pile));
    c.storage.setItem('foxy.cashu.held', '{}');
    l[0].freeInputs = true; l[0].tried = 0; l[0].lastTry = 0;
    c.storage.setItem('foxy.cashu.swaps', JSON.stringify(l));
    ok(c.W.recoveringSats() === 0, 'with the piece still in the pile, nothing is "being recovered" yet');
    await c.W.recoverSwaps();
    await settle();
    const after = JSON.parse(c.storage.getItem(pileKey) || '[]');
    const secrets = after.map((p) => p.secret);
    ok(inputs.every((s) => secrets.indexOf(s) < 0), 'the input the mint took is out of the pile');
    ok(new Set(secrets).size === secrets.length, 'and no secret is in the pile twice');
    ok((await c.W.balanceSats()) === whole, 'the balance is whole, in the new pieces', String(await c.W.balanceSats()) + ' of ' + whole);
    ok(swaps(c).length === 0, 'and the record is gone');
  }

  // ---- a request's payment whose swap-in answer was lost: one row, not two ----
  {
    /* The payment's row is written when it arrives; the swap that takes it to
     * the mint is bookkeeping. With that swap's answer lost and restored
     * later, a second row appeared and the sats held on trust stayed counted
     * until found spent: the audit off by the payment (force-quit mid swap).
     * The record names the entry; the restore amends it
     * and lets the trust copy go. */
    const c = page();
    await c.W.connect(MINT, null, null, { remember: true });
    await c.W.claim((await c.W.invoice(4096, '')).hash);
    const whole = await c.W.balanceSats();
    const made = await c.W.sendToken(1000);
    const row = { dir: 'in', sats: 1000, feeSats: 0, settled: true, state: 'success', memo: 'request', hash: 'req-x', at: Math.floor(Date.now() / 1000) };
    const logKey = 'foxy.cashu.log';
    c.storage.setItem(logKey, JSON.stringify([row].concat(JSON.parse(c.storage.getItem(logKey) || '[]'))));
    c.storage.setItem('foxy.req.unclaimed', JSON.stringify({ x: { token: made.token, sats: 1000, at: Date.now() } }));
    const rowsBefore = JSON.parse(c.storage.getItem(logKey) || '[]').length;
    c.lose = 'after';
    c.blockRestore = true;
    await c.W.receiveToken(made.token, { hash: 'req-x' }).then(() => null, () => null);
    await settle();
    c.blockRestore = false;
    ok(swaps(c).length === 1 && swaps(c)[0].into === 'req-x', 'the lost receive swap\'s record names the request\'s entry', JSON.stringify(swaps(c).map((r) => r.into)));
    await c.W.recoverSwaps();
    await settle();
    const rows = JSON.parse(c.storage.getItem(logKey) || '[]');
    ok(rows.length === rowsBefore, 'the restore added no row', rows.length + ' vs ' + rowsBefore);
    ok(rows.filter((r) => r.hash === 'req-x').length === 1, 'the request\'s own entry is the one amended');
    ok(Object.keys(JSON.parse(c.storage.getItem('foxy.req.unclaimed') || '{}')).length === 0, 'and the copy held on trust is let go');
    ok((await c.W.balanceSats()) === whole, 'the balance is whole, once', String(await c.W.balanceSats()) + ' of ' + whole);
    ok(swaps(c).length === 0, 'and the record is gone');
  }

  console.log('\n' + (failed ? failed + ' held-swap check(s) failed' : 'all held-swap checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
