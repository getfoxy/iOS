'use strict';
/* swap-run.js — what a swap between units asks the mint once SWAP is pressed.
 *
 *     node tests/swap-run.js
 *
 * After the rate is held, a swap is a melt of the mint's own invoice from the FROM pile and the claim of that
 * invoice into the TO pile (build/wallet/16b-two-balances.js `swapRun`). Every request it sends over Tor is a round
 * trip, so this counts them, on a real wallet (loadReal: the bundled cashu-ts, the phone's seed) at the harness's
 * two-unit mint:
 *
 *   1  the happy path: no question about the invoice before its claim (`swapClaim` with `paidHere`), and no swap to
 *      cut the pile before the melt when the pieces the cut would spend go to the melt whole, the rest coming back
 *      as the melt's change (`meltAsIs`, 'change on the melt'); the blanks cashu-ts sends with it are the count
 *      `meltChangeFits` works from; the hold names the pieces sent; the change lands in the pile and the books close
 *   2  exact pieces: a pile that holds the melt's need to the sat pays with no cut and no change beyond the reserve's
 *   3  the pile cut first, exactly as before, where the change could not be carried (a stand-in answer), and for every
 *      payment that is not a swap between units, exact pieces or not
 *   4  the mint answering "quote not paid" to the claim: asked about, and claimed once it says paid; or left to the
 *      sweep, which claims it
 *   5  the claim's answer lost: the sweep reads ISSUED and restores the claim's own outputs (NUT-09)
 *   6  a piece spent elsewhere, met by the melt instead of the cut: the swap fails with nothing moved and the piece
 *      comes out of the pile
 *   7  `meltChangeFits` on its own: cashu-ts's count carries every sum, fewer blanks or a keyset with small pieces do not
 *   8  an invoice paid from outside is still asked about before its claim
 *   9  change on the melt only at a mint that says it does NUT-08 and runs Nutshell or CDK
 *  10  never more over than the need: a large piece is cut first
 *  11  a mint that kept part of the change: said, in the fee, and marked so it is paid its need exactly from then on,
 *      across a relaunch; measured against all it owed, the reserve with it
 *  12  paid over its need and left PENDING: the pill says all that is with the mint; the sweep checks the change too
 *  13  a slow "not paid": the half minute of asking starts once it has come
 *  14  "Mint quote already pending" to the claim: left to the sweep, which claims it once
 */
process.env.TZ = 'UTC';
const { loadReal, fakeMint, nativePhone, books, noBooks, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (fn()) return true; await wait(10); }
  return !!fn();
};
const rows = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
const held = (c) => JSON.parse(c.storage.getItem('foxy.cashu.melting') || '[]');
const pile = (c, unit) => {
  const out = [];
  for (let i = 0; i < c.storage.length; i++) {
    const k = c.storage.key(i);
    if (k && k.indexOf('foxy.cashu.proofs.') === 0 && (unit === 'usd' ? /@usd$|usd/.test(k) : !/usd/.test(k))) {
      out.push(...JSON.parse(c.storage.getItem(k) || '[]'));
    }
  }
  return out;
};
const sum = (list) => list.reduce((n, p) => n + Number(p.amount), 0);
const bitlen = (n) => (n <= 1 ? 0 : (n - 1).toString(2).length);

/* A page of the real wallet at the fake mint, as tests/two-balances-swap.js makes it, with every request to the mint
 * written down (`reqs`: "POST /v1/swap", "GET /v1/mint/quote/bolt11"), and ways to answer for the mint: `lose` (the
 * answer to a matching url lost after the mint acted), `notPaid` (the claim refused "quote not paid", that many
 * times), `refuseClaim` (the next claim refused with this body, after `refuseDelay` ms), `unpaidRead` (the quote read
 * as UNPAID while set) and `unpaidReads` (that many times), and `blanksKept` (a melt's blanks cut to that many before
 * the mint sees them: a mint that fills no more). The mint says it runs Nutshell and settles its own invoices at no
 * routing cost, as Nutshell does, unless `mintOpts` says otherwise. */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: PHONE_WORDS });
  if (opts.phone) { phone.counters = opts.phone.counters; phone.locks = opts.phone.locks; }
  let mint = opts.mint || null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || m.path || '');
        const p = new URL(url).pathname;
        const method = String(m.method || (m.body ? 'POST' : 'GET')).toUpperCase();
        ctx.reqs.push(method + ' ' + p.replace(/\/[0-9a-f]{32}$/, ''));
        if (p === '/v1/melt/bolt11' && ctx.onMelt) ctx.onMelt(JSON.parse(m.body || '{}'));
        if (p === '/v1/melt/bolt11' && ctx.blanksKept >= 0) {
          const b = JSON.parse(m.body || '{}');
          b.outputs = (b.outputs || []).slice(0, ctx.blanksKept);
          m = Object.assign({}, m, { body: JSON.stringify(b) });
        }
        if (p === '/v1/mint/bolt11' && ctx.notPaid > 0) {
          ctx.notPaid -= 1;
          return reply(w, m.id, '400\n' + JSON.stringify({ code: 20001, detail: 'quote not paid' }));
        }
        if (p === '/v1/mint/bolt11' && ctx.refuseClaim) {
          const body = ctx.refuseClaim;
          ctx.refuseClaim = null;
          return setTimeout(() => w.FoxyWallet._scanResult(m.id, '400\n' + JSON.stringify(body)), ctx.refuseDelay || 0);
        }
        if (ctx.lose && ctx.lose.test(url)) {
          ctx.lose = null;
          mint.handle(m);
          return reply(w, m.id, null, 'The network connection was lost.');
        }
        const said = mint.handle(m);
        const unpaidOnce = ctx.unpaidReads > 0 && p.indexOf('/v1/mint/quote/bolt11/') === 0;
        if (unpaidOnce) ctx.unpaidReads -= 1;
        if ((ctx.unpaidRead || unpaidOnce) && p.indexOf('/v1/mint/quote/bolt11/') === 0 && said.indexOf('200\n') === 0) {
          const q = JSON.parse(said.slice(4));
          q.state = 'UNPAID';
          return reply(w, m.id, '200\n' + JSON.stringify(q));
        }
        return reply(w, m.id, said);
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, Object.assign({ units: ['sat', 'usd'], version: 'Nutshell/0.20.3.1', internalFree: true }, opts.mintOpts || {}));
    },
  });
  ctx.reqs = [];
  ctx.lose = null;
  ctx.notPaid = 0;
  ctx.unpaidRead = false;
  ctx.unpaidReads = 0;
  ctx.refuseClaim = null;
  ctx.refuseDelay = 0;
  ctx.blanksKept = -1;
  ctx.phone = phone;
  ctx.mint = () => mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._swapPollMs = 5;
  ctx.W._swapClaimWaitMs = 200;
  ctx.logs = [];
  const log = ctx.window.console.log;
  ctx.window.console.log = function () {
    ctx.logs.push(Array.from(arguments).join(' '));
    return log.apply(this, arguments);
  };
  ctx.warns = [];
  const warn = ctx.window.console.warn;
  ctx.window.console.warn = function () {
    ctx.warns.push(Array.from(arguments).join(' '));
    return warn.apply(this, arguments);
  };
  return ctx;
}
async function fund(c, amount, unit) {
  const inv = await c.W.invoice(amount, '', { unit: unit || 'sat' });
  return c.W.claim(inv.hash);
}
function booksMove(c, from) {
  const now = books(c);
  const out = {};
  new Set([...Object.keys(now), ...Object.keys(from || {})]).forEach((k) => {
    const a = now[k] || { off: 0 }, b = (from || {})[k] || { off: 0 };
    out[k] = a.off - b.off;
  });
  return out;
}
const booksClose = (c, from) => Object.values(booksMove(c, from)).every((n) => n === 0);
// what was asked of the mint after `at` requests, without the price and key reads that come and go
const after = (c, at) => c.reqs.slice(at).filter((r) => !/\/v1\/(info|keys|keysets)/.test(r));
const count = (list, what) => list.filter((r) => r === what).length;
const GET_QUOTE = 'GET /v1/mint/quote/bolt11';
const POST_MINT = 'POST /v1/mint/bolt11';
const POST_SWAP = 'POST /v1/swap';
const POST_MELT = 'POST /v1/melt/bolt11';
const pathOf = (c) => {
  const line = c.logs.filter((l) => /^\[foxy\] melt .*: (exact pieces|change on the melt|shaped)/.test(l)).pop() || '';
  return (/: (exact pieces|change on the melt|shaped)/.exec(line) || [])[1] || '';
};
// one swap of `cents` dollars into bitcoin; the requests after the rate was held, and what the melt sent
async function swap(c, cents) {
  const q = await c.W.swapQuote('usd', 'sat', cents);
  const melt = { body: null, hold: null };
  c.onMelt = (body) => {
    melt.body = body;
    melt.hold = held(c).find((h) => h.quote === body.quote) || null;
  };
  const at = c.reqs.length;
  const res = await c.W.swapRun(q);
  c.onMelt = null;
  return { q, res, asked: after(c, at), melt, path: pathOf(c) };
}

(async () => {
  console.log('foxy swap: the requests after SWAP\n');

  // ---- 1. the happy path: no question before the claim, the change on the melt -----------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    const changeBefore = c.mint().change.length;
    const s = await swap(c, 1000);
    console.log('      asked after SWAP: ' + s.asked.join(', '));
    ok(s.res.state === 'done' && c.W.balanceOf('sat') === s.q.get, '1: the swap is done, the bitcoin in its pile', JSON.stringify(s.res));
    ok(count(s.asked, GET_QUOTE) === 0, '1: the invoice is not asked about before its claim', s.asked.join(', '));
    ok(count(s.asked, POST_SWAP) === 0, '1: no swap cuts the pile before the melt', s.asked.join(', '));
    ok(JSON.stringify(s.asked) === JSON.stringify([POST_MELT, POST_MINT]), '1: the melt and the claim, and nothing else', s.asked.join(', '));
    ok(s.path === 'change on the melt', '1: the log says the change came back on the melt', s.path);
    const ins = (s.melt.body && s.melt.body.inputs) || [];
    const amount = Number(String(s.q._melt.amount));
    ok(ins.length > 0 && sum(ins) > s.q.total, '1: the melt is paid with more than its need', sum(ins) + ' for ' + s.q.total);
    ok((s.melt.body.outputs || []).length === Math.max(bitlen(sum(ins) - amount), 1),
      '1: cashu-ts sends max(ceil(log2(inputs − amount)), 1) blanks, the count meltChangeFits works from',
      (s.melt.body.outputs || []).length + ' blanks for ' + (sum(ins) - amount));
    ok(!!s.melt.hold && JSON.stringify(s.melt.hold.proofs.map((p) => p.secret).sort()) === JSON.stringify(ins.map((p) => p.secret).sort())
      && s.melt.hold.splitFee === 0 && s.melt.hold.swap === s.q.id,
      '1: the hold, written before the melt went, names exactly the pieces sent, no split fee, and the swap', JSON.stringify(s.melt.hold && s.melt.hold.proofs.length));
    const back = c.mint().change.slice(changeBefore).reduce((n, x) => n + Number(x.amount), 0);
    // a mint's own invoice is settled inside the melt, at no routing cost: the whole reserve comes back too
    const owedBack = sum(ins) - amount;
    ok(back === owedBack, '1: the mint gave back all it owed: the pieces over the need and the reserve not used', back + ' of ' + owedBack);
    ok(c.warns.every((l) => !/gave back/.test(l)) && !c.storage.getItem('foxy.cashu.melt.short'), '1: nothing is said of the change, and the mint is not marked');
    ok(c.W.balanceOf('usd') === 1500 - sum(ins) + back && c.W.balanceOf('usd') === 1500 - s.res.from.amount,
      '1: the dollars left are the pile less what the swap cost, change and all', c.W.balanceOf('usd') + ' cents, spent ' + s.res.from.amount);
    ok(held(c).length === 0 && c.W.unitSwapsPending().length === 0 && c.W.heldIn('usd') === 0, '1: nothing is held, nothing pending');
    ok(rows(c).filter((r) => r.swap === s.q.id).length === 2, '1: a row on each side');
    ok(booksClose(c, from), '1: the books close in each unit', JSON.stringify(booksMove(c, from)));
  }

  // ---- 2. exact pieces ------------------------------------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const q = await c.W.swapQuote('usd', 'sat', 1000);
    // the pile then holds the melt's need exactly, in its own pieces
    await fund(c, q.total, 'usd');
    const from = books(c);
    c.onMelt = (body) => { c.meltBody = body; };
    const at = c.reqs.length;
    const res = await c.W.swapRun(q);
    const asked = after(c, at);
    console.log('      asked after SWAP: ' + asked.join(', '));
    ok(res.state === 'done' && pathOf(c) === 'exact pieces', '2: exact pieces, and the swap is done', pathOf(c));
    ok(JSON.stringify(asked) === JSON.stringify([POST_MELT, POST_MINT]), '2: the melt and the claim only', asked.join(', '));
    ok(sum(c.meltBody.inputs) === q.total, '2: the melt is paid with its need to the cent', sum(c.meltBody.inputs) + ' for ' + q.total);
    ok(c.W.balanceOf('usd') === 1500 + q.total - res.from.amount && booksClose(c, from), '2: the dollars and the books close',
      c.W.balanceOf('usd') + ' ' + JSON.stringify(booksMove(c, from)));
  }

  // ---- 3. the pile cut first, as before ---------------------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    // a library or a mint whose blanks would carry less than is owed back
    const fits = c.W._meltChangeFits;
    c.W._meltChangeFits = () => false;
    const s = await swap(c, 1000);
    c.W._meltChangeFits = fits;
    console.log('      asked after SWAP: ' + s.asked.join(', '));
    ok(s.res.state === 'done' && s.path === 'shaped', '3: change that could not come back: the pile is cut first', s.path);
    ok(JSON.stringify(s.asked) === JSON.stringify([POST_SWAP, POST_MELT, POST_MINT]), '3: the cut, the melt and the claim', s.asked.join(', '));
    ok(sum(s.melt.body.inputs) === s.q.total, '3: the melt is paid with its need exactly, as it always was', sum(s.melt.body.inputs) + ' for ' + s.q.total);
    ok(booksClose(c, from), '3: the books close in each unit', JSON.stringify(booksMove(c, from)));

    // a plain payment, sats, with no exact pieces: no change on the melt, so the cut as before
    const d = page();
    await d.W.connect(MINT, { remember: true });
    await fund(d, 1500, 'sat');
    const fromD = books(d);
    const inv = await d.W.invoice(700, '', { unit: 'sat' });
    d.onMelt = (body) => { d.meltBody = body; };
    const at = d.reqs.length;
    const paid = await d.W.pay(inv.bolt11);
    const asked = after(d, at);
    ok(paid && !paid.pending && pathOf(d) === 'shaped' && count(asked, POST_SWAP) === 1 && sum(d.meltBody.inputs) === 710,
      '3: a plain payment without exact pieces is cut first, to its need', pathOf(d) + ' ' + asked.join(', '));
    ok(booksClose(d, fromD), '3: and its books close', JSON.stringify(booksMove(d, fromD)));

    /* and with exact pieces it is cut all the same: only a swap between units pays as it is, so a payment, a move
     * between mints (which pays the same way) and an LNURL payment ask the mint exactly what they always did */
    const e = page();
    await e.W.connect(MINT, { remember: true });
    await fund(e, 710, 'sat');
    await fund(e, 300, 'sat');
    const fromE = books(e);
    const inv2 = await e.W.invoice(700, '', { unit: 'sat' });
    const atE = e.reqs.length;
    const paid2 = await e.W.pay(inv2.bolt11);
    const askedE = after(e, atE);
    ok(paid2 && !paid2.pending && pathOf(e) === 'shaped' && JSON.stringify(askedE) === JSON.stringify(['POST /v1/melt/quote/bolt11', POST_SWAP, POST_MELT]),
      '3: a plain payment, even with exact pieces, is its quote, the cut and the melt, as before', pathOf(e) + ' ' + askedE.join(', '));
    ok(e.W.balanceOf('sat') === 1010 - 700 - paid2.fee && booksClose(e, fromE), '3: and its books close',
      e.W.balanceOf('sat') + ' ' + JSON.stringify(booksMove(e, fromE)));
  }

  // ---- 4. "quote not paid" to the claim -------------------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    c.notPaid = 1;
    const s = await swap(c, 1000);
    console.log('      asked after SWAP: ' + s.asked.join(', '));
    ok(s.res.state === 'done' && c.W.balanceOf('sat') === s.q.get, '4: refused "not paid": the swap still ends done', JSON.stringify(s.res));
    ok(JSON.stringify(s.asked) === JSON.stringify([POST_MELT, POST_MINT, GET_QUOTE, POST_MINT]),
      '4: the claim, the question it then needs, and the claim again', s.asked.join(', '));
    ok(booksClose(c, from), '4: the books close in each unit', JSON.stringify(booksMove(c, from)));

    // the mint goes on saying so past the wait: left to the sweep, which claims it
    const d = page();
    await d.W.connect(MINT, { remember: true });
    await fund(d, 1500, 'usd');
    const fromD = books(d);
    d.notPaid = 1;
    d.unpaidRead = true;
    const t = await swap(d, 1000);
    ok(t.res.state === 'pending' && d.W.balanceOf('sat') === 0 && d.W.unitSwapsPending().length === 1,
      '4: still not paid when the wait ends: pending, with the swap on record', JSON.stringify(t.res));
    d.unpaidRead = false;
    await d.W.sweepQuotes();
    ok(d.W.balanceOf('sat') === t.q.get && d.W.unitSwapsPending().length === 0, '4: the sweep claims it', d.W.balanceOf('sat') + ' sats');
    ok(booksClose(d, fromD), '4: the books close in each unit', JSON.stringify(booksMove(d, fromD)));
  }

  // ---- 5. the claim's answer lost ---------------------------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    c.lose = /\/v1\/mint\/bolt11$/;
    const s = await swap(c, 1000);
    ok(s.res.state === 'pending' && c.W.balanceOf('sat') === 0, '5: the claim signed and its answer lost: pending', JSON.stringify(s.res));
    const rec = JSON.parse(c.storage.getItem('foxy.cashu.quotes') || '[]').find((r) => r.quote === s.q._mintQuote.quote) || {};
    ok((rec.outputs || []).length > 0, '5: the claim’s counter ranges were on the invoice before it went', JSON.stringify(rec.outputs));
    // the next launch: the same storage, the same phone, the same mint
    const b = page({ storage: (() => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; })(), phone: c.phone, mint: c.mint() });
    b.booksFrom = from;
    await b.W.connect(MINT, { remember: true });
    const fin = await until(() => b.W.balanceOf('sat') === s.q.get && b.W.unitSwapsPending().length === 0, 4000);
    ok(fin, '5: the next connect reads ISSUED and restores the claim’s outputs into the bitcoin pile', b.W.balanceOf('sat') + ' sats');
    ok(b.reqs.indexOf('POST /v1/restore') >= 0, '5: by a restore of its own ranges (NUT-09)', b.reqs.join(', '));
    ok(booksClose(b, from), '5: the books close in each unit', JSON.stringify(booksMove(b, from)));
  }

  // ---- 6. a piece spent elsewhere ---------------------------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    noBooks(c, 'a piece of its pile is spent at the mint by hand, with no entry');
    const big = pile(c, 'usd').find((p) => Number(p.amount) === 1024);
    // spent at the mint behind this page's back: a melt of a one-cent invoice, by hand
    const m = c.mint();
    const mq = JSON.parse(m.handle({ url: MINT + '/v1/mint/quote/bolt11', method: 'POST', body: JSON.stringify({ amount: 1, unit: 'usd' }) }).slice(4));
    const lq = JSON.parse(m.handle({ url: MINT + '/v1/melt/quote/bolt11', method: 'POST', body: JSON.stringify({ request: mq.request, unit: 'usd' }) }).slice(4));
    const spentNow = m.handle({ url: MINT + '/v1/melt/bolt11', method: 'POST', body: JSON.stringify({ quote: lq.quote, inputs: [big], outputs: [] }) });
    ok(/^200/.test(spentNow), '6: the 1,024-cent piece is spent elsewhere', spentNow.slice(0, 80));
    const s = await swap(c, 1000);
    ok(s.res.state === 'failed' && s.path === 'change on the melt', '6: the melt meets it and refuses: the swap fails', JSON.stringify(s.res) + ' ' + s.path);
    ok(!pile(c, 'usd').some((p) => p.secret === big.secret) && c.W.balanceOf('usd') === 476,
      '6: the spent piece is out of the pile, and every other piece back in it', c.W.balanceOf('usd') + ' cents');
    ok(held(c).length === 0 && c.W.unitSwapsPending().length === 0 && c.W.balanceOf('sat') === 0, '6: nothing held, nothing pending, nothing claimed');
    const again = await swap(c, 300);
    ok(again.res.state === 'done' && c.W.balanceOf('sat') === again.q.get, '6: a swap after it goes through', JSON.stringify(again.res));
  }

  // ---- 7. meltChangeFits on its own ------------------------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 100, 'sat');
    const W = c.W;
    const fake = (biggest) => {
      const keys = {};
      for (let a = 1; a <= biggest; a *= 2) keys[a] = '02' + '11'.repeat(32);
      return { keysetId: 'k', keyChain: { getKeyset: () => ({ hasKeys: true, keys }) } };
    };
    const w = fake(32768);
    let all = true, bad = '';
    for (let amount = 1; amount < 300 && all; amount += 7) {
      for (let inputs = amount; inputs < amount + 700; inputs++) {
        for (const reserve of [0, 1, 2, 10, 64]) {
          if (inputs - amount < reserve) continue;
          // inputs with nothing over them owe nothing back, and fit as well
          if (!W._meltChangeFits(w, inputs, amount, reserve, 0)) { all = false; bad = [inputs, amount, reserve].join('/'); break; }
        }
        if (!all) break;
      }
    }
    ok(all, '7: with the blanks cashu-ts sends, every sum a mint can owe back fits', bad);
    // the blanks NUT-08 suggests for the reserve alone, max(ceil(log2(reserve)), 1): 4 for a reserve of 10
    ok(W._meltChangeFits(w, 1010, 1000, 10, 0, 4) && !W._meltChangeFits(w, 1100, 1000, 10, 0, 4),
      '7: blanks sized by the reserve alone carry the reserve, and not 90 over the need');
    ok(!W._meltChangeFits(fake(8), 1100, 1000, 2, 0), '7: nor change larger than twice the keyset’s largest piece');
    ok(!W._meltChangeFits({ keysetId: 'none' }, 1100, 1000, 2, 0), '7: and a keyset whose pieces cannot be read answers no');
    ok(!W._meltChangeFits(w, 1000, 1001, 2, 0), '7: inputs short of the amount answer no');
  }

  // ---- 8. an invoice paid from outside --------------------------------------------------------------------------
  {
    const c = page({ mintOpts: { units: ['sat', 'usd'], quotesUnpaid: true } });
    await c.W.connect(MINT, { remember: true });
    const inv = await c.W.invoice(500, '', { unit: 'sat' });
    c.mint().payQuote(inv.hash);
    const at = c.reqs.length;
    await c.W.sweepQuotes();
    const asked = after(c, at);
    ok(c.W.balanceOf('sat') === 500 && asked.indexOf(GET_QUOTE) >= 0 && asked.indexOf(GET_QUOTE) < asked.indexOf(POST_MINT),
      '8: a Lightning deposit is asked about before it is claimed, as ever', asked.join(', '));
  }

  // ---- 9. only at a mint that says it hands the change back -------------------------------------------------------
  {
    // no NUT-08 in its info: it would ignore the blanks and keep all it was paid over the invoice
    const c = page({ mintOpts: { noNut8: true } });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    const s = await swap(c, 1000);
    ok(s.res.state === 'done' && s.path === 'shaped' && sum(s.melt.body.inputs) === s.q.total,
      '9: a mint without NUT-08 is paid its need exactly, the pile cut first', s.path + ', ' + sum(s.melt.body.inputs) + ' for ' + s.q.total);
    ok(booksClose(c, from), '9: and the books close', JSON.stringify(booksMove(c, from)));

    // NUT-08, but not an implementation whose filling of the blanks has been read
    const d = page({ mintOpts: { version: 'othermint/1.0' } });
    await d.W.connect(MINT, { remember: true });
    await fund(d, 1500, 'usd');
    const t2 = await swap(d, 1000);
    ok(t2.res.state === 'done' && t2.path === 'shaped' && sum(t2.melt.body.inputs) === t2.q.total,
      '9: a mint that names another implementation is paid its need exactly', t2.path);

    // CDK, as it names itself
    const e = page({ mintOpts: { version: 'cdk-mintd/0.18.1' } });
    await e.W.connect(MINT, { remember: true });
    await fund(e, 1500, 'usd');
    const t3 = await swap(e, 1000);
    ok(t3.res.state === 'done' && t3.path === 'change on the melt', '9: a CDK mint is paid as the pieces are', t3.path);
  }

  // ---- 10. never more over than the need ---------------------------------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 8192, 'usd');
    ok(pile(c, 'usd').length === 1, '10: the pile is one 8,192-cent piece', pile(c, 'usd').map((p) => p.amount).join(','));
    const from = books(c);
    const s = await swap(c, 1000);
    ok(s.res.state === 'done' && s.path === 'shaped' && sum(s.melt.body.inputs) === s.q.total,
      '10: a piece that would pay seven times the need over is cut first, not handed to the melt', s.path + ', ' + sum(s.melt.body.inputs));
    ok(booksClose(c, from), '10: and the books close', JSON.stringify(booksMove(c, from)));
  }

  // ---- 11. a mint that keeps part of the change -------------------------------------------------------------------
  {
    // it fills one blank only (as many as NUT-08 sizes for a reserve of two cents): the rest is kept
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    c.blanksKept = 1;
    const s = await swap(c, 1000);
    c.blanksKept = -1;
    const ins = sum(s.melt.body.inputs);
    const amount = Number(String(s.q._melt.amount));
    const lost = 1500 - c.W.balanceOf('usd') - amount;
    ok(s.res.state === 'done' && s.path === 'change on the melt' && lost > 0 && lost < s.q.total,
      '11: the first melt goes as it is, and the mint keeps some of the change: less than the need', s.path + ', ' + lost + ' cents kept of ' + (ins - amount));
    ok(c.warns.some((l) => /gave back .* of the .* it owed/.test(l)), '11: said, in the log', c.warns.join(' | '));
    ok(s.res.fee === lost && booksClose(c, from), '11: what it kept is in the swap’s fee, and the books close',
      s.res.fee + ' fee, ' + JSON.stringify(booksMove(c, from)));
    const marked = JSON.parse(c.storage.getItem('foxy.cashu.melt.short') || '{}');
    ok(Object.keys(marked).length === 1 && /m\.test/.test(Object.keys(marked)[0]), '11: the mint is marked, in storage', JSON.stringify(marked));
    await fund(c, 1500, 'usd');
    const again = await swap(c, 1000);
    ok(again.res.state === 'done' && again.path !== 'change on the melt' && sum(again.melt.body.inputs) === again.q.total,
      '11: the next swap there is paid its need exactly, never over it', again.path + ', ' + sum(again.melt.body.inputs) + ' for ' + again.q.total);
    /* A launch later, the mark is still read: a page with nothing in its storage but the mark, and the pile of 1, which
     * went as it was without it, is cut first. */
    const b = page({ storage: { 'foxy.cashu.melt.short': c.storage.getItem('foxy.cashu.melt.short') } });
    await b.W.connect(MINT, { remember: true });
    await fund(b, 1500, 'usd');
    const third = await swap(b, 1000);
    ok(third.res.state === 'done' && third.path === 'shaped' && sum(third.melt.body.inputs) === third.q.total,
      '11: and after a relaunch', third.path);

    /* A mint that charges for routing its own invoice keeps two cents of the reserve, all of it inside what the
     * reserve allowed: what it owed is the whole of the inputs over the invoice, so that is said and marked too. */
    const d = page({ mintOpts: { internalFree: false } });
    await d.W.connect(MINT, { remember: true });
    await fund(d, 1500, 'usd');
    const fromD = books(d);
    const t2 = await swap(d, 1000);
    ok(t2.res.state === 'done' && t2.path === 'change on the melt' && t2.res.fee === 2, '11: two cents kept within the reserve', t2.path + ' fee ' + t2.res.fee);
    ok(d.warns.some((l) => /gave back .* of the .* it owed/.test(l)) && !!d.storage.getItem('foxy.cashu.melt.short'),
      '11: measured against all it owed, not only what was paid over the need: said and marked', d.warns.join(' | '));
    ok(booksClose(d, fromD), '11: and the books close', JSON.stringify(booksMove(d, fromD)));
  }

  // ---- 12. paid over its need and left PENDING ---------------------------------------------------------------------
  {
    const c = page({ mintOpts: { meltPending: true } });
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    const s = await swap(c, 1000);
    const ins = sum(s.melt.body.inputs);
    const pill = c.W.unitSwapsPending();
    ok(s.res.state === 'pending' && s.path === 'change on the melt' && ins > s.q.total, '12: pending, paid over its need', s.path + ' ' + ins);
    ok(c.W.heldIn('usd') === ins && pill.length === 1 && pill[0].from.amount === ins,
      '12: the pill says all that is with the mint, not only the need', JSON.stringify(pill) + ' held ' + c.W.heldIn('usd'));
    ok(c.W.balanceOf('usd') + pill[0].from.amount === 1500, '12: the pile and the pill add up to what there was',
      c.W.balanceOf('usd') + ' + ' + pill[0].from.amount);
    ok(held(c)[0] && held(c)[0].changeOnMelt === true, '12: the hold says it was paid over its need');
    c.mint().settleMelt(s.melt.body.quote, 'paid');
    await c.W.sweepMelts();
    await c.W.sweepQuotes();
    const amount = Number(String(s.q._melt.amount));
    ok(c.W.balanceOf('usd') === 1500 - amount && c.W.balanceOf('sat') === s.q.get && c.W.unitSwapsPending().length === 0,
      '12: settled by the sweep with all the change, and the bitcoin claimed', c.W.balanceOf('usd') + ' ' + c.W.balanceOf('sat'));
    ok(!c.storage.getItem('foxy.cashu.melt.short'), '12: all came back, so the mint is not marked');
    ok(booksClose(c, from), '12: the books close', JSON.stringify(booksMove(c, from)));

    // the same with a mint that fills one blank: the sweep sees the change come back short, and marks the mint
    const d = page({ mintOpts: { meltPending: true } });
    await d.W.connect(MINT, { remember: true });
    await fund(d, 1500, 'usd');
    const fromD = books(d);
    d.blanksKept = 1;
    const t2 = await swap(d, 1000);
    d.blanksKept = -1;
    d.mint().settleMelt(t2.melt.body.quote, 'paid');
    await d.W.sweepMelts();
    await d.W.sweepQuotes();
    ok(t2.path === 'change on the melt' && !!d.storage.getItem('foxy.cashu.melt.short') && d.W.balanceOf('sat') === t2.q.get,
      '12: change short at the sweep: said and marked', d.warns.join(' | '));
    ok(booksClose(d, fromD), '12: and the books close', JSON.stringify(booksMove(d, fromD)));
  }

  // ---- 13. a slow "not paid": the half minute of asking starts after it -------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    // the refusal takes longer than the whole wait, and the first question after it still reads UNPAID
    c.refuseClaim = { code: 20001, detail: 'quote not paid' };
    c.refuseDelay = 300;
    c.unpaidReads = 1;
    const s = await swap(c, 1000);
    ok(s.res.state === 'done' && c.W.balanceOf('sat') === s.q.get, '13: still asked until paid, and claimed', JSON.stringify(s.res) + ' ' + s.asked.join(', '));
    ok(JSON.stringify(s.asked) === JSON.stringify([POST_MELT, POST_MINT, GET_QUOTE, GET_QUOTE, POST_MINT]),
      '13: the claim, two questions, the claim', s.asked.join(', '));
    ok(booksClose(c, from), '13: the books close', JSON.stringify(booksMove(c, from)));
  }

  // ---- 14. a refusal that is not "not paid": left to the sweep ----------------------------------------------------
  {
    const c = page();
    await c.W.connect(MINT, { remember: true });
    await fund(c, 1500, 'usd');
    const from = books(c);
    // Nutshell's answer while another claim of the same quote holds its lock
    c.refuseClaim = { code: 0, detail: 'Mint quote already pending' };
    const s = await swap(c, 1000);
    ok(s.res.state === 'pending' && c.W.balanceOf('sat') === 0 && c.W.unitSwapsPending().length === 1,
      '14: "Mint quote already pending": no asking, left pending for the sweep', JSON.stringify(s.res) + ' ' + s.asked.join(', '));
    ok(JSON.stringify(s.asked) === JSON.stringify([POST_MELT, POST_MINT]), '14: the melt and the one claim only', s.asked.join(', '));
    await c.W.sweepQuotes();
    await c.W.sweepQuotes();
    ok(c.W.balanceOf('sat') === s.q.get && c.W.unitSwapsPending().length === 0, '14: the sweep claims it, once', c.W.balanceOf('sat') + ' sats');
    ok(booksClose(c, from), '14: the books close', JSON.stringify(booksMove(c, from)));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
