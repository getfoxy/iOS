'use strict';
/* two-balances.js — dollars beside bitcoin at one mint, the wallet's half.
 *
 *     node tests/two-balances.js
 *
 * A mint that issues sat and usd keysets (Forge does) holds two balances: sats,
 * and dollars in cents. The rule this holds the wallet to: the unit lives in
 * the key of the pile and in every record, and a figure is never added across
 * units. Each check runs the page as it ships (loadReal: the bundled cashu-ts,
 * the phone's seed and counters) against the harness's mint with a usd keyset
 * (fakeMint `units`), at a fixed 76,900 dollars a bitcoin.
 *
 * What is checked, in the order of the plan's list:
 *   1  which units a mint issues, from the keysets, and from the copy kept
 *      for a launch with no route
 *   2  the choice of what to hold, and the two remembered starting units
 *   3  the pile guard: a piece goes only into its own unit's pile, and the
 *      record that would bring it back stays
 *   4  one token encoder, which refuses mixed units
 *   5  a usd payment request read in cents, and refused in words
 *   6  a usd invoice: its record, its expiry, and the mint's node not learned
 *   7  watched and claimed into the usd pile, said in its unit
 *   8  a usd invoice paid while the app was away, and a claim whose answer was
 *      lost, both found again into the usd pile
 *   9  fee quotes in each unit, both at once, and the sum a screen asks
 *   10 a Lightning invoice paid from dollars: change in cents, a row in cents
 *   11 a usd payment cut off mid-flight, settled later in its unit
 *   12 a usd token sent, taken by another phone, and not taken back twice;
 *      locked or offline usd refused in words
 *   13 the books of every page, per mint and unit (harness.js, at exit)
 *   and the swap between the two: quoted both ways, all of it, a rate that
 *   ran out, run with a row on each side, cut off after the payment, a
 *   payment left pending, a payment refused, a spread, no route, one unit.
 *   And what the first review added: a swap pays the melt it showed; a
 *   payment from dollars never takes more than the confirmation said; a swap
 *   cut off before its payment left is not pending for ever; a swap's invoice
 *   is kept while its payment routes past the invoice's minute; dollars, or
 *   dollar pieces labelled sat, taken offline or posted to a request never
 *   count as sats; and a restore of the words finds both units, apart. */
const { loadReal, fakeMint, nativePhone, books, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const SAT_PILE = 'foxy.cashu.proofs.' + MINT;
const USD_PILE = SAT_PILE + '@usd';
// a bolt11 from nobody in particular, for 2,000 sats: 20,000 nano-bitcoin
const FOREIGN = 'lnbc20000n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqxyzzy';

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const settle = async (n) => { for (let i = 0; i < (n || 200); i++) await new Promise((r) => setTimeout(r, 0)); };
const sum = (l) => (l || []).reduce((a, p) => a + Number(p.amount || 0), 0);
const pile = (c, key) => JSON.parse(c.storage.getItem(key) || '[]');
const rows = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
const store = (c) => { const o = {}; for (let i = 0; i < c.storage.length; i++) o[c.storage.key(i)] = c.storage.getItem(c.storage.key(i)); return o; };
const why = async (fn) => { try { await fn(); return ''; } catch (e) { return String((e && e.message) || e); } };
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
// waits for what a page does on its own (the sweeps a connect starts), up to two seconds
const until = async (fn, ms) => {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return !!fn();
};

/* A page at the mint. o.mintOpts go to fakeMint (units sat and usd unless said);
 * o.mint shares another page's mint; o.phone another page's phone (a relaunch);
 * o.storage what the page starts with. `ctx.lose` (a RegExp of a path) loses the
 * next answer to such a request after the mint has acted on it; `ctx.down`
 * refuses every request, as with no network. */
function page(o) {
  const opts = o || {};
  /* A page opened over what another wrote gets that page's phone as it was
   * after the kill: a fresh phone with the same counter file and lock keys
   * (reusing the object itself carries the old page's realm into cashu-ts). */
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  if (opts.phone) { phone.counters = opts.phone.counters; phone.locks = opts.phone.locks; }
  let mint = opts.mint || null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || m.path || '');
        if (ctx.down) return reply(w, m.id, null, 'The network connection was lost.');
        if (ctx.lose && ctx.lose.test(url)) {
          ctx.lose = null;
          mint.handle(m);
          return reply(w, m.id, null, 'The network connection was lost.');
        }
        ctx.asked.push(url);
        return reply(w, m.id, mint.handle(m));
      }
      // the answer a payment posted to this phone's inbox gets (`_requestPaid`)
      if (m.action === 'inboxAnswer') { ctx.inbox.push(m); return reply(w, m.id, JSON.stringify({ ok: true })); }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, Object.assign({ units: ['sat', 'usd'] }, opts.mintOpts || {}));
    },
  });
  ctx.lose = null;
  ctx.down = false;
  ctx.inbox = [];
  ctx.asked = [];
  ctx.phone = phone;
  ctx.mint = () => mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._swapPollMs = 5;
  ctx.W._swapClaimWaitMs = 200;
  return ctx;
}

async function connected(o) {
  const c = page(o);
  await c.W.connect(MINT, { remember: true });
  return c;
}

// money in, the way a person gets it: an invoice the stub mint pays as it is made
async function fund(c, amount, unit) {
  const inv = await c.W.invoice(amount, '', { unit: unit || 'sat' });
  return c.W.claim(inv.hash);
}

/* The books of one page, per mint and unit, against where they started. */
function booksMove(c, from) {
  const now = books(c);
  const out = {};
  new Set([...Object.keys(now), ...Object.keys(from || {})]).forEach((k) => {
    const a = now[k] || { says: 0, holds: 0, off: 0 }, b = (from || {})[k] || { says: 0, holds: 0, off: 0 };
    out[k] = a.off - b.off;
  });
  return out;
}
const booksClose = (c, from) => Object.values(booksMove(c, from)).every((n) => n === 0);

(async () => {
  console.log('foxy two balances: the wallet\n');

  // ---- 1. which units ------------------------------------------------------
  {
    const one = await connected({ mintOpts: { units: ['sat'] } });
    ok(JSON.stringify(one.W.mintUnits()) === '["sat"]' && one.W.twoUnits() === false,
      'a sat-only mint issues ["sat"], and is not a two-unit mint', JSON.stringify(one.W.mintUnits()));
    const two = await connected();
    ok(JSON.stringify(two.W.mintUnits()) === '["sat","usd"]' && two.W.twoUnits() === true,
      'a mint with a usd keyset issues ["sat","usd"]', JSON.stringify(two.W.mintUnits()));
    // the next launch, with no route: the kept copy of the keysets says it
    const later = page({ storage: store(two), phone: two.phone, mint: two.mint() });
    later.W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });
    ok(JSON.stringify(later.W.mintUnits(MINT)) === '["sat","usd"]' && later.W.twoUnits(MINT),
      'with no route and no wallet yet, the units come from the keysets kept for such a launch');
    const nobody = page({});
    ok(JSON.stringify(nobody.W.mintUnits('https://never.test')) === '[]' && !nobody.W.twoUnits('https://never.test'),
      'a mint nothing is known about gives []');
  }

  // ---- 2. the choice -------------------------------------------------------
  {
    const c = page({});
    const W = c.W;
    ok(JSON.stringify(W.walletChoice()) === JSON.stringify({ hold: '', recv: '', send: '' }), 'nothing chosen: all empty');
    W.setWalletChoice({ hold: 'dollars' });
    ok(JSON.stringify(W.walletChoice()) === JSON.stringify({ hold: 'dollars', recv: 'usd', send: 'usd' }), 'dollars sets both starting units to usd');
    W.setWalletChoice({ hold: 'bitcoin' });
    ok(JSON.stringify(W.walletChoice()) === JSON.stringify({ hold: 'bitcoin', recv: 'sat', send: 'sat' }), 'bitcoin sets both to sat');
    W.setWalletChoice({ hold: 'both' });
    ok(JSON.stringify(W.walletChoice()) === JSON.stringify({ hold: 'both', recv: '', send: '' }), 'both clears them, so each flow asks once');
    W.setWalletChoice({ recv: 'usd' });
    W.setWalletChoice({ send: 'sat' });
    ok(W.walletChoice().recv === 'usd' && W.walletChoice().send === 'sat' && W.walletChoice().hold === 'both',
      'a receive and a send remember a unit each');
    const said = await why(() => W.setWalletChoice({ hold: 'euros' }));
    const said2 = await why(() => W.setWalletChoice({ send: 'USD!' }));
    ok(said === 'Foxy does not know that choice.' && said2 === said && W.walletChoice().send === 'sat',
      'anything else is refused in words, and nothing is written', said + ' / ' + said2);
    ok(c.storage.getItem('foxy.wallet.hold') === '"both"', 'kept under foxy.wallet.hold');
  }

  // ---- 3. the pile guard ----------------------------------------------------
  {
    const c = await connected();
    const W = c.W;
    await fund(c, 300, 'usd');
    await fund(c, 1000, 'sat');
    const usdPiece = pile(c, USD_PILE)[0];
    const satPiece = pile(c, SAT_PILE)[0];
    ok(usdPiece && usdPiece.id === c.mint().usdId && satPiece && satPiece.id === c.mint().id,
      'each pile holds pieces of its own keyset');
    /* Set aside as if a reconcile had found them spent, with the wrong unit on
     * the record: a usd piece filed as sats. Putting it back must not reach the
     * sat pile, and the record that brings it back must stay. */
    c.storage.setItem('foxy.cashu.quarantine', JSON.stringify([{ mint: MINT, proof: usdPiece }]));
    c.storage.setItem(USD_PILE, JSON.stringify(pile(c, USD_PILE).filter((p) => p.secret !== usdPiece.secret)));
    const satBefore = sum(pile(c, SAT_PILE));
    const e = await caught(() => W.unquarantine());
    ok(e && e.wrongUnit === true && /Foxy kept USD ecash out of the sat balance; nothing was lost\./.test(e.message),
      'a usd piece on its way into the sat pile is refused, with wrongUnit', e && e.message);
    ok(sum(pile(c, SAT_PILE)) === satBefore, 'and the sat pile is as it was');
    ok(JSON.parse(c.storage.getItem('foxy.cashu.quarantine')).length === 1, 'and the record that would bring it back is kept');
    // the other way: a sat piece filed as usd
    c.storage.setItem('foxy.cashu.quarantine', JSON.stringify([{ mint: MINT, unit: 'usd', proof: satPiece }]));
    c.storage.setItem(SAT_PILE, JSON.stringify(pile(c, SAT_PILE).filter((p) => p.secret !== satPiece.secret)));
    const usdBefore = sum(pile(c, USD_PILE));
    const e2 = await caught(() => W.unquarantine());
    ok(e2 && e2.wrongUnit && /Foxy kept sat ecash out of the USD balance/.test(e2.message) && sum(pile(c, USD_PILE)) === usdBefore,
      'a sat piece on its way into the usd pile is refused', e2 && e2.message);
    // a keyset the mint does not name, into the usd pile
    const stranger = Object.assign({}, usdPiece, { id: '00ffffffffffffff', secret: 'f'.repeat(64) });
    c.storage.setItem('foxy.cashu.quarantine', JSON.stringify([{ mint: MINT, unit: 'usd', proof: stranger }]));
    const e3 = await caught(() => W.unquarantine());
    ok(e3 && e3.wrongUnit && /unrecognised ecash out of the USD balance/.test(e3.message), 'an unknown keyset is refused from the usd pile', e3 && e3.message);
    // put right, they go where they belong
    c.storage.setItem('foxy.cashu.quarantine', JSON.stringify([{ mint: MINT, proof: satPiece }, { mint: MINT, unit: 'usd', proof: usdPiece }]));
    const back = await W.unquarantine();
    ok(back.back === Number(satPiece.amount) && back.backUnits && back.backUnits.usd === Number(usdPiece.amount),
      'with the right units on them they go back, each to its own pile', JSON.stringify(back));
    require('./harness').noBooks(c, 'pieces moved behind the wallet’s back');
  }

  // ---- 4. one encoder --------------------------------------------------------
  {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'build', 'wallet');
    const sites = fs.readdirSync(dir).filter((f) => /\.js$/.test(f)).map((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return { f, n: (text.match(/getEncodedToken\(/g) || []).length };
    }).filter((x) => x.n);
    ok(sites.length === 1 && sites[0].f === '08c-units.js' && sites[0].n === 1,
      'every token is made by encodeToken: getEncodedToken is called in one place', JSON.stringify(sites));
    const text = fs.readFileSync(path.join(dir, '08c-units.js'), 'utf8');
    ok(/throw new Error\('No ecash to put in a token\.'\)/.test(text)
       && /'Those pieces are not all ' \+ unitName\(u\) \+ ' ecash, so no token was made\.'/.test(text),
      'and it refuses no pieces, and pieces of another unit, in words');
    const c = await connected();
    await fund(c, 200, 'usd');
    await fund(c, 64, 'sat');
    // a stray usd piece in the sat pile, put there behind the wallet's back
    c.storage.setItem(SAT_PILE, JSON.stringify(pile(c, SAT_PILE).concat(pile(c, USD_PILE))));
    const said = await why(() => c.W.exportProofs());
    ok(said === 'Those pieces are not all sat ecash, so no token was made.', 'a backup of mixed pieces is not made', said);
    require('./harness').noBooks(c, 'pieces moved behind the wallet’s back');
  }

  // ---- 5. a usd payment request ----------------------------------------------
  {
    const c = await connected();
    const CT = c.window.CashuTS;
    const creq = new CT.PaymentRequest([{ type: CT.PaymentRequestTransportType.POST, target: 'http://abc.onion/pay', tags: [] }],
      'ab12cd', 500, 'usd', [MINT], 'five dollars', true).toEncodedRequest();
    const r = c.W.decodeRequest(creq);
    ok(r && r.unit === 'usd' && r.amount === 500 && r.sats === null, 'a usd request is read in cents, with sats null', JSON.stringify(r && { unit: r.unit, amount: r.amount, sats: r.sats }));
    const sat = c.W.decodeRequest(new CT.PaymentRequest([], 'ab12ce', 21, 'sat', [MINT], '', true).toEncodedRequest());
    ok(sat && sat.unit === 'sat' && sat.amount === 21 && sat.sats === 21, 'a sat request is as it was, with amount beside sats');
    const said = await why(() => c.W.payRequest(r, () => {}));
    ok(said === 'That request asks for dollar ecash, which Foxy cannot pay yet.', 'paying it is refused in words', said);
    const said2 = await why(() => c.W.payRequest(Object.assign({}, r, { delivery: null, viaTap: true }), () => {}));
    ok(said2 === said, 'over a tap as well, before anything else is asked', said2);
  }

  // ---- 6, 7. a usd invoice, watched and claimed ------------------------------
  {
    // a real invoice, so its node can be read off it: the mint hands it out for every quote here
    const REAL = 'lnbc1p4ttszqpp5c6utwdk6cmla7kmz4nf89avnlyrzqrkhz0jx06hsltwmw9afwheqdqqcqzzs'
      + 'xqrrs0fppq9eka5xeg7p7sezkmmkc02cpffc2ekcdssp5hcpux550uxjsc3nj3qhvqa7rmz7hsp7yel3eveh3'
      + 'vg8awmve4fds9qxpqysgqtsd5g8er8mhnst3eres2455nxxm4kd44c4uwa3fvu8ueqsgf4vd5ft94jk8u54ahh'
      + 'vx9nmlz4r4z2w7yvcpd7nrk7d8yy489lfg5djspkrewuj';
    const c = await connected({ mintOpts: { units: ['sat', 'usd'], usdQuoteTtl: 60 } });
    const W = c.W;
    const realMint = c.mint();
    const inner = realMint.handle;
    realMint.handle = (m) => {
      const out = inner(m);
      if (/\/v1\/mint\/quote\/bolt11$/.test(new URL(m.url).pathname)) {
        const [code, body] = [out.slice(0, 3), JSON.parse(out.slice(4))];
        body.request = REAL;
        return code + '\n' + JSON.stringify(body);
      }
      return out;
    };
    const before = Date.now();
    const inv = await W.invoice(500, '', { unit: 'usd' });
    const rec = JSON.parse(c.storage.getItem('foxy.cashu.quotes'))[0];
    ok(inv.unit === 'usd' && inv.amount === 500 && inv.sats === 0 && inv.mint === MINT, 'a usd invoice says its unit and amount, and no sats', JSON.stringify({ unit: inv.unit, amount: inv.amount, sats: inv.sats }));
    ok(rec && rec.quote === inv.hash && rec.unit === 'usd' && rec.amount === 500, 'its record carries the unit (hard rule 3)', JSON.stringify(rec));
    ok(inv.expiresAt >= before + 55000 && inv.expiresAt <= Date.now() + 61000, 'and when it ends, sixty seconds on', String(inv.expiresAt - before));
    ok(!c.storage.getItem('foxy.cashu.mint.nodes') && W.invoiceFromThisMint(REAL) === false,
      'the node of a usd invoice is not taken for the mint’s own');
    ok(/^0[23][0-9a-f]{64}$/.test(String(W.invoiceSigner(REAL))), 'though the invoice names a node it could have been taken from');
    realMint.handle = inner;
    const rate = W.mintRate();
    ok(rate === null || rate.usdPerBtc > 0, 'a mint rate, if any, is a number of dollars');

    // 7: watched, and claimed into the usd pile
    const told = await new Promise((done) => {
      const t = setTimeout(() => done(null), 5000);
      W.invoice(250, '', { unit: 'usd' }).then((inv2) => {
        W.watch(inv2.hash, (paid) => { clearTimeout(t); done(paid); }, { pollMs: 5 });
      });
    });
    ok(told && told.unit === 'usd' && told.amount === 250 && told.sats === 0, 'the watch says the unit and the amount, and no sats', JSON.stringify(told));
    const claimed = rows(c).find((r) => r.unit === 'usd' && r.dir === 'in');
    ok(claimed && claimed.amount === 250 && claimed.sats === 0 && claimed.feeAmount === 0 && claimed.mint === MINT,
      'its row is in cents, with sats at 0', JSON.stringify(claimed));
    ok(sum(pile(c, USD_PILE)) === 250 && sum(pile(c, SAT_PILE)) === 0, 'the cents are in the usd pile and the sat pile is untouched');
    ok(W.balanceOf('usd') === 250 && W.balanceOf('sat') === 0 && (await W.balanceSats()) === 0, 'balanceOf reads each; balanceSats counts no cents');
    const quotes = JSON.parse(c.storage.getItem('foxy.cashu.quotes')).map((q) => q.quote);
    ok(quotes.indexOf(inv.hash) >= 0, 'the unpaid one stays on file for the sweep');
    const said = await why(() => W.invoice(0, '', { unit: 'usd' }));
    ok(said === 'Ask for an amount above zero.', 'nothing is refused in words', said);
  }

  // a one-unit mint asked for dollars
  {
    const c = await connected({ mintOpts: { units: ['sat'] } });
    const said = await why(() => c.W.invoice(100, '', { unit: 'usd' }));
    ok(said === 'm.test does not issue USD ecash.', 'a mint with no usd keyset is named', said);
    const said2 = await why(() => c.W.walletIn('eur!'));
    ok(said2 === 'Foxy does not know the unit eur!.', 'a unit that is not one is refused', said2);
  }

  // ---- 8. away, and a claim whose answer was lost ------------------------------
  {
    const a = await connected();
    // a sweep says what it claimed in its unit
    const inv0 = await a.W.invoice(50, '', { unit: 'usd' });
    const swept0 = await a.W.sweepQuotes();
    const zero = swept0.find((x) => x.quote === inv0.hash);
    ok(zero && zero.unit === 'usd' && zero.amount === 50 && zero.sats === 0, 'a sweep says what it claimed in its unit', JSON.stringify(swept0));
    const inv = await a.W.invoice(400, '', { unit: 'usd' });
    // the app is killed before the claim; the mint has the money
    const b = page({ storage: store(a), phone: a.phone, mint: a.mint() });
    await b.W.connect(MINT, { remember: true });
    const landed = await until(() => sum(pile(b, USD_PILE)) === 450);
    ok(landed && sum(pile(b, SAT_PILE)) === 0, 'a paid usd invoice is claimed on the next connect, into the usd pile', String(sum(pile(b, USD_PILE))));
    const row0 = rows(b).find((r) => r.hash === inv.hash);
    ok(row0 && row0.unit === 'usd' && row0.amount === 400 && row0.sats === 0, 'with its row in cents', JSON.stringify(row0));

    // the claim's answer lost after the mint signed
    const inv2 = await b.W.invoice(123, '', { unit: 'usd' });
    b.lose = /\/v1\/mint\/bolt11$/;
    const e = await caught(() => b.W.claim(inv2.hash));
    ok(!!e, 'the claim whose answer was lost fails', e && e.message);
    ok(sum(pile(b, USD_PILE)) === 450, 'and nothing is in the pile yet');
    const swept2 = await b.W.sweepQuotes();
    const two = swept2.find((x) => x.quote === inv2.hash);
    ok(two && two.recovered && two.unit === 'usd' && two.amount === 123, 'the sweep finds it ISSUED and restores it from its counters', JSON.stringify(swept2));
    ok(sum(pile(b, USD_PILE)) === 573 && sum(pile(b, SAT_PILE)) === 0, 'into the usd pile, not the sat one', String(sum(pile(b, USD_PILE))));
    const row = rows(b).find((r) => r.hash === inv2.hash);
    ok(row && row.unit === 'usd' && row.amount === 123 && row.sats === 0, 'with its row in cents', JSON.stringify(row));
  }

  // ---- 9, 10. fees, and a payment from dollars ---------------------------------
  {
    const c = await connected();
    const W = c.W;
    await fund(c, 1000, 'usd');
    await fund(c, 5000, 'sat');
    const from = books(c);
    const both = await W.quoteFeeBoth(FOREIGN);
    // 2,000 sats at 76,900 dollars a bitcoin is 153.8 cents, rounded up by the mint
    ok(both.sat && both.sat.unit === 'sat' && both.sat.amount === 2000 && both.sat.rate === null,
      'the sat quote is in sats', JSON.stringify(both.sat && { unit: both.sat.unit, amount: both.sat.amount, fee: both.sat.feeReserve }));
    ok(both.usd && both.usd.unit === 'usd' && both.usd.amount === 154 && both.usd.feeReserve === 2 && both.usd.msat === 2000000,
      'the usd quote is in cents, reserve and all', JSON.stringify(both.usd && { unit: both.usd.unit, amount: both.usd.amount, fee: both.usd.feeReserve }));
    ok(both.usd && both.usd.rate && Math.abs(both.usd.rate.usdPerBtc - 77000) < 100, 'and says the mint’s rate', JSON.stringify(both.usd && both.usd.rate));
    ok(W.mintRate() && Math.abs(W.mintRate().usdPerBtc - 77000) < 100 && W.mintRate().mint === MINT, 'kept in memory as the mint’s rate');
    const need = W.payNeed(both.usd.amount, both.usd.feeReserve, { unit: 'usd' });
    ok(need && need.ok && need.unit === 'usd' && need.have === 1000 && need.need === 156, 'the need is in cents against the usd pile', JSON.stringify(need));
    const short = W.payNeed(990, 20, { unit: 'usd' });
    ok(short && !short.ok && /needs \$ 10\.10 and you hold \$ 10\.00\./.test(short.why), 'and short, it is said in dollars', short && short.why);
    const satNeed = W.payNeed(2000, 10);
    ok(satNeed && satNeed.ok && satNeed.unit === 'sat' && satNeed.have === 5000, 'with no unit it is sats, as before');

    const paid = await W.pay(FOREIGN, () => {}, { unit: 'usd', quote: both.usd });
    ok(paid.unit === 'usd' && paid.amount === 154 && paid.fee === 2 && paid.feeSats === 0, 'paid from dollars: amount and fee in cents', JSON.stringify(paid));
    ok(sum(pile(c, USD_PILE)) === 844 && sum(pile(c, SAT_PILE)) === 5000, 'the usd pile pays, change and all; the sat pile is untouched',
      sum(pile(c, USD_PILE)) + ' / ' + sum(pile(c, SAT_PILE)));
    const row = rows(c).find((r) => r.dir === 'out');
    ok(row && row.unit === 'usd' && row.amount === 154 && row.feeAmount === 2 && row.sats === 0 && row.feeSats === 0 && row.mintRate > 0,
      'its row is in cents, with the mint’s rate', JSON.stringify(row));
    ok(booksClose(c, from), 'the books close in each unit', JSON.stringify(booksMove(c, from)));
    ok(!(c.mint().melts && Object.values(c.mint().melts).some((q) => q.unit === 'sat' && q.state === 'PAID')), 'and no sat melt was made');

    const short2 = await why(() => W.pay(FOREIGN.replace('20000n', '200000n'), () => {}, { unit: 'usd' }));
    ok(/needs \$ 15\.40 and you hold \$ 8\.44\.|needs \$ \d+\.\d\d and you hold \$ 8\.44\./.test(short2), 'more than the dollars is refused in dollars', short2);
    const none = await why(() => W.pay('lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq', () => {}, { unit: 'usd', sats: 10 }));
    ok(none === 'Paying an invoice with no amount from dollars is not possible. Ask for one with the amount on it.', 'an invoice with no amount is refused from dollars', none);
    // a sat quote handed in for a usd payment is not reused
    const before = c.asked.filter((u) => /melt\/quote/.test(u)).length;
    const satQ = await W.quoteFee(FOREIGN);
    await W.pay(FOREIGN, () => {}, { unit: 'usd', quote: satQ });
    ok(c.asked.filter((u) => /melt\/quote/.test(u)).length === before + 2, 'a sat quote is not reused for a payment from dollars');
  }

  // ---- 11. a usd payment cut off, settled later -------------------------------
  {
    const a = await connected({ mintOpts: { units: ['sat', 'usd'], meltPending: true } });
    await fund(a, 600, 'usd');
    const r = await a.W.pay(FOREIGN, () => {}, { unit: 'usd' });
    ok(r.pending === true && r.unit === 'usd', 'a melt the mint holds PENDING is pending', JSON.stringify(r));
    const hold = JSON.parse(a.storage.getItem('foxy.cashu.melting'))[0];
    ok(hold && hold.unit === 'usd' && hold.amount === 154 && sum(hold.proofs) === 156, 'its hold carries the unit (hard rule 3)', JSON.stringify(hold && { unit: hold.unit, amount: hold.amount }));
    ok(a.W.balanceOf('usd') === 444, 'its pieces are out of the usd balance', String(a.W.balanceOf('usd')));
    // the app is killed; the payment goes through while it is away
    a.mint().settleMelt(hold.quote, 'paid');
    const b = page({ storage: store(a), phone: a.phone, mint: a.mint() });
    await b.W.connect(MINT, { remember: true });
    // made with a payment in flight, so its books are judged here, whole, rather than from where it started
    require('./harness').noBooks(b, 'started with a payment in flight');
    const gone = await until(() => !JSON.parse(b.storage.getItem('foxy.cashu.melting') || '[]').length);
    ok(gone, 'the next connect settles it as paid');
    const bk = books(b);
    ok(bk[MINT + '@usd'] && bk[MINT + '@usd'].off === 0 && bk[MINT + '@usd'].holds === 444, 'and the usd books close once it has', JSON.stringify(bk));
    const row = rows(b).find((x) => x.hash === hold.quote);
    ok(row && row.unit === 'usd' && row.amount === 154 && row.sats === 0, 'and its row is in cents', JSON.stringify(row));
    ok(sum(pile(b, SAT_PILE)) === 0 && b.W.balanceOf('usd') === 444, 'nothing reached the sat pile');

    // refused: the pieces come back to the usd pile
    const c = await connected({ mintOpts: { units: ['sat', 'usd'], meltRefuse: true } });
    await fund(c, 600, 'usd');
    const said = await why(() => c.W.pay(FOREIGN, () => {}, { unit: 'usd' }));
    ok(/could not be routed|payment could not/.test(said) && c.W.balanceOf('usd') === 600 && sum(pile(c, SAT_PILE)) === 0,
      'a melt the mint refuses gives the cents back to the usd pile', said + ' / ' + c.W.balanceOf('usd'));
  }

  // ---- 12. a usd token -----------------------------------------------------------
  {
    const a = await connected();
    await fund(a, 700, 'usd');
    await fund(a, 300, 'sat');
    const from = books(a);
    const sent = await a.W.sendToken(250, { unit: 'usd' });
    ok(sent.unit === 'usd' && sent.amount === 250 && sent.sats === 0, 'a usd token is made, in cents', JSON.stringify({ unit: sent.unit, amount: sent.amount, sats: sent.sats }));
    const info = a.W.tokenInfo(sent.token);
    ok(info && info.unit === 'usd' && info.amount === 250 && info.sats === null, 'and reads as usd');
    const out = JSON.parse(a.storage.getItem('foxy.cashu.outtoken'));
    ok(out && out.unit === 'usd' && out.amount === 250, 'the token on file says its unit', JSON.stringify(out && { unit: out.unit, amount: out.amount }));
    ok(a.W.tagsFor(sent.hash).unit === 'usd', 'and so does its note');
    ok(a.W.balanceOf('usd') === 450 && a.W.balanceOf('sat') === 300, 'it came out of the usd pile alone');
    ok(booksClose(a, from), 'the books close in each unit', JSON.stringify(booksMove(a, from)));
    // another phone takes it
    const b = page({ mint: a.mint(), words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' });
    await b.W.connect(MINT, { remember: true });
    const got = await b.W.receiveToken(sent.token);
    ok(got.unit === 'usd' && got.amount === 250 && b.W.balanceOf('usd') === 250, 'another phone receives it into its usd pile', JSON.stringify(got));
    const said = await why(() => a.W.reclaimToken(sent.token));
    ok(/already spent/.test(said), 'and it cannot be taken back once taken', said);
    // one not taken can be
    const sent2 = await a.W.sendToken(100, { unit: 'usd' });
    const back = await a.W.reclaimToken(sent2.token);
    ok(back.unit === 'usd' && back.amount === 100 && back.sats === 0 && a.W.balanceOf('usd') === 450, 'a usd token not taken comes back to the usd pile', JSON.stringify(back));
    const words = 'Offline and locked payments are bitcoin only for now; nothing was sent.';
    ok(await why(() => a.W.sendToken(10, { unit: 'usd', lockTo: '02' + 'a'.repeat(64) })) === words, 'a locked usd token is refused in words');
    ok(await why(() => a.W.sendToken(10, { unit: 'usd', cover: true })) === words, 'and one that covers with change to come back');
    a.W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });
    a.W.setOffline(true);
    ok(await why(() => a.W.sendToken(10, { unit: 'usd' })) === words, 'and one with no route');
    ok(/only send sats/.test(await why(() => a.W.sendToken(10, { unit: 'eur' }))), 'another unit is refused as it always was');
    ok(a.W.balanceOf('usd') === 450, 'none of them moved anything');
  }

  // ---- the swap -----------------------------------------------------------------
  {
    const c = await connected();
    const W = c.W;
    await fund(c, 1000, 'usd');
    await fund(c, 20000, 'sat');
    const from = books(c);
    const q = await W.swapQuote('usd', 'sat', 500);
    // 500 cents at 76,900 is about 6,500 sats
    ok(q.state === 'quoted' && q.from === 'usd' && q.to === 'sat' && q.total <= 500 && q.total >= 490 && q.total === q.amount + q.fee,
      'dollars to bitcoin: what leaves is no more than asked, fee in', JSON.stringify(q));
    ok(q.get > 6300 && q.get < 6510 && q.fee === 2, 'what arrives is at the mint’s rate, in sats', q.get + ' sats, fee ' + q.fee);
    ok(Math.abs(q.rate.usdPerBtc - 76900) / 76900 < 0.01 && q.rate.by === 'm.test', 'the rate is the mint’s, named', JSON.stringify(q.rate));
    ok(q.expiresAt > Date.now() && q.expiresAt <= Date.now() + 60500, 'held for a minute at most');
    ok(!('_melt' in JSON.parse(JSON.stringify(q))), 'its insides are not copied with it');
    const stages = [];
    const run = await W.swapRun(q, (s) => stages.push(s));
    ok(run.state === 'done' && run.from.unit === 'usd' && run.to.unit === 'sat' && run.to.amount === q.get,
      'run: done, from dollars to bitcoin', JSON.stringify(run));
    ok(stages.join(',') === 'paying,paid,claiming,done', 'its stages', stages.join(','));
    ok(W.balanceOf('usd') === 1000 - run.from.amount && W.balanceOf('sat') === 20000 + q.get, 'both piles moved by their own figures',
      W.balanceOf('usd') + ' / ' + W.balanceOf('sat'));
    const legs = rows(c).filter((r) => r.kind === 'swap' && r.swap === q.id);
    const outLeg = legs.find((r) => r.dir === 'out'), inLeg = legs.find((r) => r.dir === 'in');
    ok(legs.length === 2 && outLeg.unit === 'usd' && outLeg.amount + outLeg.feeAmount === run.from.amount && !inLeg.unit && inLeg.sats === q.get,
      'two rows, one in each unit, both marked with the swap', JSON.stringify(legs.map((r) => ({ dir: r.dir, unit: r.unit, amount: r.amount, sats: r.sats }))));
    ok(outLeg.mintRate > 0 && inLeg.mintRate > 0, 'each with the mint’s rate');
    ok(booksClose(c, from), 'the books close in each unit', JSON.stringify(booksMove(c, from)));
    ok(W.unitSwapsPending().length === 0 && !JSON.parse(c.storage.getItem('foxy.cashu.unitswap') || '[]').length, 'and nothing is left pending');
    const again = await why(() => W.swapRun(q));
    ok(again === 'That swap has already gone.', 'a quote runs once', again);

    // the other way, all of it
    const from2 = books(c);
    const all = await W.swapQuote('sat', 'usd', 0, { all: true });
    ok(all.from === 'sat' && all.total <= W.balanceOf('sat') && all.total >= W.balanceOf('sat') - 300,
      'bitcoin to dollars, all of it: spends the whole balance to within the fee rounding', all.total + ' of ' + W.balanceOf('sat'));
    const r2 = await W.swapRun(all);
    ok(r2.state === 'done' && W.balanceOf('sat') < 400 && r2.to.unit === 'usd', 'and runs', JSON.stringify(r2) + ' left ' + W.balanceOf('sat'));
    ok(booksClose(c, from2), 'the books close again', JSON.stringify(booksMove(c, from2)));

    // refusals
    ok(await why(() => W.swapQuote('usd', 'usd', 10)) === 'Pick two different balances to swap.', 'the same unit twice is refused');
    ok(await why(() => W.swapQuote('usd', 'sat', 0)) === 'Ask for an amount above zero.', 'nothing is refused');
    const more = await why(() => W.swapQuote('usd', 'sat', 99999999));
    ok(/^That is more than your dollars: you hold \$ [\d,]+\.\d\d\.$/.test(more), 'more than the dollars is refused, with the balance', more);
    const moreSat = await why(() => W.swapQuote('sat', 'usd', 99999999));
    ok(/^That is more than your bitcoin: you hold ₿ [\d,]+\.$/.test(moreSat), 'more than the bitcoin too', moreSat);
    const tiny = await why(() => W.swapQuote('usd', 'sat', 2));
    ok(tiny === 'That is too little to swap after the mint’s fee.', 'too little after the fee', tiny);
    // a spread past two percent
    W._rate = 70000;
    const wide = await W.swapQuote('usd', 'sat', 300);
    ok(wide.market === 70000 && wide.spread > 0.02 && wide.spreadWarn === true, 'a rate more than 2 % against the person is flagged', JSON.stringify({ spread: wide.spread }));
    W._rate = 76900;
    const near = await W.swapQuote('usd', 'sat', 300);
    ok(near.spreadWarn === false, 'and one near the market is not', String(near.spread));
    W._rate = null;
    // no route
    W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });
    W.setOffline(true);
    const off = await caught(() => W.swapQuote('usd', 'sat', 100));
    ok(off && off.offline === true && off.message === 'Swapping needs the mint.', 'with no route: Swapping needs the mint.', off && off.message);
    const offRun = await caught(() => W.swapRun(near));
    ok(offRun && offRun.offline && offRun.message === 'Swapping needs the mint.', 'and a quote in hand is not run');
  }
  {
    const c = await connected({ mintOpts: { units: ['sat'] } });
    await fund(c, 1000, 'sat');
    const said = await why(() => c.W.swapQuote('sat', 'usd', 100));
    ok(said === 'm.test issues only bitcoin, so there is nothing to swap with.', 'a one-unit mint has nothing to swap with', said);
  }
  // a rate that runs out
  {
    const c = await connected({ mintOpts: { units: ['sat', 'usd'], usdQuoteTtl: 10 } });
    await fund(c, 5000, 'sat');
    const q = await c.W.swapQuote('sat', 'usd', 1000);
    ok(q.expiresAt <= Date.now() + 10500, 'a usd invoice that lives ten seconds holds the rate ten seconds');
    const e = await caught(() => c.W.swapRun(q));
    ok(e && e.expired === true && e.message === 'The rate has run out. Confirm the new rate.', 'with under fifteen seconds left it is refused, nothing moved', e && e.message);
    ok(c.W.balanceOf('sat') === 5000 && !c.storage.getItem('foxy.cashu.unitswap'), 'and nothing was written');
  }
  // cut off after the payment, before the claim
  {
    const a = await connected({ mintOpts: { units: ['sat', 'usd'], quotesUnpaid: true } });
    const pay = a.mint().payQuote;
    const inv = await a.W.invoice(3000);
    pay(inv.hash); await a.W.claim(inv.hash);
    const q = await a.W.swapQuote('sat', 'usd', 2000);
    a.lose = /\/v1\/mint\/bolt11$/;
    const r = await a.W.swapRun(q);
    ok(r.state === 'pending', 'a claim whose answer was lost leaves the swap pending', JSON.stringify(r));
    const pend = a.W.unitSwapsPending();
    ok(pend.length === 1 && pend[0].from.unit === 'sat' && pend[0].to.unit === 'usd' && pend[0].to.amount === q.get,
      'it is listed as still with the mint', JSON.stringify(pend));
    ok(a.W.balanceOf('usd') === 0, 'and the dollars are not in the balance yet');
    const b = page({ storage: store(a), phone: a.phone, mint: a.mint() });
    await b.W.connect(MINT, { remember: true });
    const fin = await until(() => b.W.balanceOf('usd') === q.get);
    ok(fin, 'the next connect finishes it into the usd pile', String(b.W.balanceOf('usd')));
    ok(b.W.unitSwapsPending().length === 0, 'and the swap is no longer pending');
    const legs = rows(b).filter((x) => x.swap === q.id);
    ok(legs.length === 2 && legs.some((x) => x.unit === 'usd' && x.dir === 'in' && x.kind === 'swap'), 'both its rows are there', JSON.stringify(legs.map((x) => x.dir + (x.unit || 'sat'))));
  }
  // a payment the mint leaves PENDING
  {
    const a = await connected({ mintOpts: { units: ['sat', 'usd'], meltPending: true, quotesUnpaid: true } });
    const inv = await a.W.invoice(900, '', { unit: 'usd' });
    a.mint().payQuote(inv.hash); await a.W.claim(inv.hash);
    const q = await a.W.swapQuote('usd', 'sat', 800);
    const r = await a.W.swapRun(q);
    ok(r.state === 'pending', 'a payment left PENDING leaves the swap pending', JSON.stringify(r));
    ok(a.W.heldIn('usd') === q.total && a.W.balanceOf('usd') === 900 - q.total, 'its dollars are held, not lost', a.W.heldIn('usd') + ' held');
    const hold = JSON.parse(a.storage.getItem('foxy.cashu.melting'))[0];
    ok(hold.swap === q.id && hold.unit === 'usd', 'the hold names the swap');
    a.mint().settleMelt(hold.quote, 'paid');
    const settled = await a.W.sweepMelts();
    ok(settled.length === 1 && settled[0].paid && settled[0].unit === 'usd', 'the melt sweep says the unit it settled', JSON.stringify(settled));
    await a.W.sweepQuotes();
    ok(a.W.balanceOf('sat') === q.get && a.W.unitSwapsPending().length === 0 && a.W.heldIn('usd') === 0,
      'once it pays, the sweeps finish both legs', a.W.balanceOf('sat') + ' sats');
    ok(rows(a).filter((x) => x.swap === q.id).length === 2, 'with a row on each side');
  }
  // a payment the mint refuses
  {
    const a = await connected({ mintOpts: { units: ['sat', 'usd'], meltRefuse: true } });
    await fund(a, 900, 'usd');
    const q = await a.W.swapQuote('usd', 'sat', 500);
    const r = await a.W.swapRun(q);
    ok(r.state === 'failed' && r.from.amount === 0, 'a refused payment fails the swap', JSON.stringify(r));
    ok(a.W.balanceOf('usd') === 900 && a.W.balanceOf('sat') === 0 && a.W.unitSwapsPending().length === 0, 'and the dollars are back');
    ok(!JSON.parse(a.storage.getItem('foxy.cashu.quotes') || '[]').some((x) => x.swap === q.id), 'its invoice is forgotten');
  }

  // ---- review: money -------------------------------------------------------------
  /* What the first review asked of the money, beyond the plan's list: that a
   * payment from dollars never takes more than the confirmation said, that a
   * swap pays the melt it showed, that a swap cut off before anything left is
   * not shown pending for ever, that dollars taken offline never count as
   * sats, and that a restore of the words finds both units. */

  // a swap whose melt quote ends soon after the rate was shown (a sixty-second
  // invoice's melt at Forge): it pays the melt it showed, or nothing at all
  {
    const c = await connected({ mintOpts: { units: ['sat', 'usd'], meltTtl: 25 } });
    await fund(c, 1000, 'usd');
    const from = books(c);
    const q = await c.W.swapQuote('usd', 'sat', 500);
    const meltsBefore = c.asked.filter((u) => /\/v1\/melt\/quote\/bolt11$/.test(u)).length;
    let r = null, e = null;
    try { r = await c.W.swapRun(q); } catch (x) { e = x; }
    const meltsAfter = c.asked.filter((u) => /\/v1\/melt\/quote\/bolt11$/.test(u)).length;
    ok(meltsAfter === meltsBefore, 'a swap never asks the mint a second price for its payment', (meltsAfter - meltsBefore) + ' more melt quote(s)');
    ok((r && r.state === 'done' && r.from.amount <= q.total) || (e && e.expired === true && c.W.balanceOf('usd') === 1000),
      'it pays at most the total it showed, or refuses with the rate run out and nothing moved',
      JSON.stringify(r || { why: e && e.message, usd: c.W.balanceOf('usd') }));
    ok(booksClose(c, from), 'the books close in each unit', JSON.stringify(booksMove(c, from)));
  }

  // a payment from dollars confirmed at one price and re-quoted at a dearer one
  {
    const c = await connected();
    await fund(c, 1000, 'usd');
    const from = books(c);
    const shown = await c.W.quoteFee(FOREIGN, { unit: 'usd' });
    const inner = c.mint().handle;
    c.mint().handle = (m) => {
      const out = inner(m);
      if (/\/v1\/melt\/quote\/bolt11$/.test(new URL(m.url).pathname)) {
        const body = JSON.parse(out.slice(4));
        if (body.unit === 'usd') { body.amount += 40; c.mint().melts[body.quote].amount += 40; }
        return out.slice(0, 3) + '\n' + JSON.stringify(body);
      }
      return out;
    };
    // the confirmation's quote has gone stale, so the payment asks again
    c.W._quoteReuseMs = 1;
    await new Promise((r) => setTimeout(r, 5));
    let paid = null, said = '';
    try { paid = await c.W.pay(FOREIGN, () => {}, { unit: 'usd', quote: shown }); } catch (x) { said = x.message; }
    c.mint().handle = inner;
    c.W._quoteReuseMs = 0;
    const most = shown.amount + shown.feeReserve;
    ok(!paid || (paid.amount + paid.fee) <= most,
      'a payment from dollars never takes more than the confirmation showed', paid ? JSON.stringify(paid) + ' against ' + most : said);
    ok(paid || (c.W.balanceOf('usd') === 1000 && /\$ 1\.96/.test(said)),
      'refused, it says the new price in dollars and nothing moved', said + ' / ' + c.W.balanceOf('usd'));
    ok(booksClose(c, from), 'the books close in each unit', JSON.stringify(booksMove(c, from)));
  }

  // a swap cut off before its payment left: not pending for ever
  {
    const a = await connected({ mintOpts: { units: ['sat', 'usd'], meltRefuse: true } });
    await fund(a, 900, 'usd');
    const q = await a.W.swapQuote('usd', 'sat', 500);
    // as swapRun writes them, then the app dies before the payment is held
    const rec = { id: q.id, at: Date.now(), mint: MINT, from: 'usd', to: 'sat', total: q.total, amount: q.amount, fee: q.fee,
                  get: q.get, rate: q.rate.usdPerBtc, mintQuote: 'q-never-paid', meltQuote: 'm-never-sent', state: 'paying' };
    a.storage.setItem('foxy.cashu.unitswap', JSON.stringify([rec]));
    const b = page({ storage: store(a), phone: a.phone, mint: a.mint() });
    await b.W.connect(MINT, { remember: true });
    ok(b.W.unitSwapsPending().length === 0, 'a swap whose payment never left is not pending after a relaunch',
      JSON.stringify(b.W.unitSwapsPending()));
    ok(b.W.heldIn('usd') === 0 && b.W.balanceOf('usd') === 900, 'and holds nothing back');
    // one with its payment still with the mint stays
    const c2 = await connected({ mintOpts: { units: ['sat', 'usd'], meltPending: true } });
    await fund(c2, 900, 'usd');
    const q2 = await c2.W.swapQuote('usd', 'sat', 500);
    const r2 = await c2.W.swapRun(q2);
    const d = page({ storage: store(c2), phone: c2.phone, mint: c2.mint() });
    require('./harness').noBooks(d, 'started with a payment in flight');
    await d.W.connect(MINT, { remember: true });
    ok(r2.state === 'pending' && d.W.unitSwapsPending().length === 1 && d.W.heldIn('usd') === q2.total,
      'a swap whose payment the mint still holds stays pending after a relaunch', JSON.stringify(d.W.unitSwapsPending()));
  }

  // a swap whose payment is still routing when its invoice's minute is up: the invoice is kept
  {
    const a = await connected({ mintOpts: { units: ['sat', 'usd'], meltPending: true, quotesUnpaid: true } });
    const inv = await a.W.invoice(20000, '', { unit: 'sat' });
    a.mint().payQuote(inv.hash); await a.W.claim(inv.hash);
    const from = books(a);
    const q = await a.W.swapQuote('sat', 'usd', 10000);
    const r = await a.W.swapRun(q);
    const mq = JSON.parse(a.storage.getItem('foxy.cashu.quotes')).find((x) => x.swap === q.id);
    // the invoice's sixty seconds pass while the payment routes
    a.mint().quotes[mq.quote].expiry = Math.floor(Date.now() / 1000) - 5;
    await a.W.sweepQuotes();
    const kept = JSON.parse(a.storage.getItem('foxy.cashu.quotes') || '[]').some((x) => x.quote === mq.quote);
    ok(r.state === 'pending' && kept, 'a swap’s invoice is not dropped as lapsed while its payment is still with the mint');
    const hold = JSON.parse(a.storage.getItem('foxy.cashu.melting'))[0];
    a.mint().settleMelt(hold.quote, 'paid');
    await a.W.sweepMelts();
    await a.W.sweepQuotes();
    ok(a.W.balanceOf('usd') === q.get && a.W.unitSwapsPending().length === 0, 'and once the payment lands, the dollars are claimed',
      a.W.balanceOf('usd') + ' of ' + q.get);
    ok(booksClose(a, from), 'the books close in each unit', JSON.stringify(booksMove(a, from)));
  }

  // dollars handed over while this phone has no route
  {
    const giver = await connected();
    await fund(giver, 500, 'usd');
    const tok = await giver.W.sendToken(300, { unit: 'usd' });
    const c = await connected({ mint: giver.mint(), words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' });
    await fund(c, 1000, 'sat');
    c.W._onOfflineOffer = () => Promise.resolve(true);
    c.W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });
    c.W.setOffline(true);
    const satBefore = c.W.balanceOf('sat');
    const said = await why(() => c.W.receiveToken(tok.token));
    ok(c.W.balanceOf('sat') === satBefore, 'dollar ecash taken offline never counts as sats', c.W.balanceOf('sat') + ' sats, was ' + satBefore + ' / ' + said);
    ok(!rows(c).some((x) => x.dir === 'in' && (!x.unit || x.unit === 'sat') && x.sats === 300), 'and is on no sat row');
    ok(/^This phone is offline, and dollars can only be taken with a connection\./.test(said), 'it is refused in words, and stays the giver’s', said);
    // dollar pieces in a token that says sat: refused offline too, never counted as sats
    const liar = giver.window.CashuTS.getEncodedToken({ mint: MINT, unit: 'sat', proofs: giver.W.tokenInfo(tok.token).proofs });
    const said2 = await why(() => c.W.receiveToken(liar));
    ok(c.W.balanceOf('sat') === satBefore && /says sats but holds another unit/.test(said2),
      'a token that says sat but holds dollar pieces is refused offline, by its keysets', c.W.balanceOf('sat') + ' / ' + said2);
    // and a payment posted to a request: pieces of the dollar keyset sent as "sat" are refused
    c.W.setOffline(false);
    c.W._privacy({ tor: 'on', progress: 100, everUp: true, unprotected: false, transport: 'tor', network: 'wifi' });
    if (c.W.primeLocks) await c.W.primeLocks().catch(() => {});
    const request = c.W.paymentRequest(16, { purpose: 'receive' });
    const reqId = request ? (c.W.decodeRequest(request) || {}).id : '';
    const cents = await giver.W.sendToken(16, { unit: 'usd' });
    const ps = giver.W.tokenInfo(cents.token).proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C }));
    await c.W._requestPaid(JSON.stringify({ id: reqId, mint: MINT, unit: 'sat', proofs: ps }), 'inbox-1');
    await until(() => c.inbox.some((a) => a.answer === 'inbox-1'));
    const answer = c.inbox.find((a) => a.answer === 'inbox-1') || {};
    ok(!!reqId && answer.status === 422 && /not in sats/.test(answer.text) && c.W.balanceOf('sat') === satBefore,
      'a request paid with dollar pieces called sats is refused, by their keysets', JSON.stringify({ reqId: !!reqId, status: answer.status, text: answer.text, sat: c.W.balanceOf('sat') }));
    // and a dollar token nobody has claimed is named in its unit before history forgets it
    const left = await giver.W.tokensNotClaimed();
    const mine = left.find((x) => x.hash === tok.hash);
    ok(mine && mine.unit === 'usd' && mine.amount === 300 && mine.sats === null, 'a sent dollar token not yet claimed is said in cents', JSON.stringify(left));
  }

  // a restore of the words finds the sats and the dollars, each in its own pile
  {
    const a = await connected();
    await fund(a, 300, 'usd');
    await fund(a, 1000, 'sat');
    await a.W.sendToken(120, { unit: 'usd' }).then((t) => a.W.reclaimToken(t.token));
    const want = { sat: a.W.balanceOf('sat'), usd: a.W.balanceOf('usd') };
    const b = page({ phone: a.phone, mint: a.mint() });
    await b.W.connect(MINT, { remember: true });
    const found = await b.W.scanSeed(undefined, [MINT]);
    const row = found[0] || {};
    ok(row.state === 'done' && row.units && row.units.usd && row.units.usd.amount === want.usd,
      'a scan finds the dollars, by their own keyset', JSON.stringify({ state: row.state, sats: row.sats, usd: row.units && row.units.usd && row.units.usd.amount }));
    await b.W.adoptScan(found, { overwrite: true });
    ok(b.W.balanceOf('usd') === want.usd && b.W.balanceOf('sat') === want.sat
       && pile(b, USD_PILE).every((p) => p.id === b.mint().usdId) && pile(b, SAT_PILE).every((p) => p.id === b.mint().id),
      'and adopting it puts each unit in its own pile', JSON.stringify({ sat: b.W.balanceOf('sat'), usd: b.W.balanceOf('usd'), want }));
    require('./harness').noBooks(b, 'a restore has no rows');
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  // the books of every page are asked once more as the process ends (harness.js)
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
})().catch((e) => { console.log('THREW', (e && e.stack) || e); process.exit(1); });
