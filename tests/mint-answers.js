'use strict';
/* mint-answers.js — what the wallet does with three answers a mint may give.
 *
 *     node tests/mint-answers.js
 *
 * 1. A mint quote whose amount is not the one asked (NUT-04's `amount`): within a
 *    unit of rounding the quote's own amount is what is minted; further than that
 *    the invoice is refused before it is shown (00-header-and-mint-errors.js,
 *    `createQuote`, `mintAmountOf`).
 * 2. A mint that rotated its keys refuses outputs on the keyset it retired (NUT
 *    error 12002): the wallet reads its keysets once more and sets the request
 *    out again on the active one, once (`onceMoreIfSigned`, `keysetRefused`).
 * 3. A version 3 token naming two mints: what the token reader does with it,
 *    pinned, so that no money is dropped without a word.
 *
 * Pages on harness.js's fake mints.
 */
const H = require('./harness');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = H;

const MINT = 'https://m.test';
const ODD = 'https://odd.test';
const ROUND = 'https://round.test';
const SPIN = 'https://spin.test';
const OTHER = 'https://other.test';

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};

const mints = {};
function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  const asked = [];
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || '');
        asked.push({ url, body: String(m.body || '') });
        const at = url.indexOf('odd.test') >= 0 ? mints.odd : url.indexOf('round.test') >= 0 ? mints.round
          : url.indexOf('spin.test') >= 0 ? mints.spin : url.indexOf('other.test') >= 0 ? mints.other : mints.main;
        return setTimeout(() => w.FoxyWallet._scanResult(m.id, at.handle(m)), 0);
      }
      const got = phone.answer(w, m);
      if (!got) return setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'not in this test'), 0);
      return Promise.resolve(got).then((r) => setTimeout(() => w.FoxyWallet._scanResult(m.id, r[0], r[1]), 0));
    },
    before: (w) => {
      phone.attach(w);
      if (!mints.main) mints.main = fakeMint(w, {});
      // a quote fifty sats over what was asked: not rounding
      if (!mints.odd) mints.odd = fakeMint(w, { fill: 21, quoteFrom: 10000, quoteAmountOff: 50 });
      // a quote one over: rounding, and what is minted
      if (!mints.round) mints.round = fakeMint(w, { fill: 23, quoteFrom: 20000, quoteAmountOff: 1 });
      if (!mints.spin) mints.spin = fakeMint(w, { fill: 25, quoteFrom: 30000 });
      if (!mints.other) mints.other = fakeMint(w, { fill: 27, quoteFrom: 40000 });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.asked = asked;
  return ctx;
}
const balance = async (ctx) => Number(await ctx.W.balanceSats()) || 0;

async function run() {
  /* ---- 1. the quote's own amount ------------------------------------------ */
  {
    const P = page();
    await P.W.connect(ODD, { remember: true });
    let no = '';
    try { await P.W.invoice(100, ''); } catch (e) { no = e.message; }
    ok(/invoice for 150, not the 100 asked for|amount does not match/i.test(no), 'a quote for 150 when 100 was asked is refused', no);
    ok(!(JSON.parse(P.storage.getItem('foxy.cashu.quotes') || '[]') || []).length, 'and nothing is written down to be claimed');

    const R = page();
    await R.W.connect(ROUND, { remember: true });
    let inv = null, rno = '';
    try { inv = await R.W.invoice(100, ''); } catch (e) { rno = e.message; }
    const rec = (JSON.parse(R.storage.getItem('foxy.cashu.quotes') || '[]') || [])[0] || {};
    if (inv) {
      ok(rec.amount === 100 && rec.quoted === 101, 'a quote one over what was asked (rounding) is kept, with its own amount', JSON.stringify({ amount: rec.amount, quoted: rec.quoted }));
      const got = await R.W.claim(inv.hash);
      ok((await balance(R)) === 101, 'and its claim mints the quote’s 101, which the mint signs, not the 100 asked', JSON.stringify(got));
    } else {
      /* cashu-ts 4.11 refuses any quote that is not for what it asked ("Mint quote amount does not match") before the
       * wallet sees it, so the rounding branch above is the wallet's own check behind it: pinned as the library's no */
      ok(/amount does not match/i.test(rno) && !(JSON.parse(R.storage.getItem('foxy.cashu.quotes') || '[]') || []).length,
        'the library itself refuses a quote one over what was asked, and nothing is written down', rno);
    }
  }

  /* ---- 2. a mint that rotated its keys ------------------------------------- */
  {
    const P = page();
    await P.W.connect(SPIN, { remember: true });
    await P.W.claim((await P.W.invoice(500, '')).hash);
    ok((await balance(P)) === 500, 'the wallet holds 500 at a mint');
    const old = mints.spin.keysetId();
    const fresh = mints.spin.rotate();
    ok(fresh !== old && mints.spin.retiredIds().indexOf(old) >= 0, 'the mint rotates its keys: the old keyset inactive, a new one active');
    const keysetsBefore = P.asked.filter((x) => /\/v1\/keysets$/.test(x.url)).length;
    const swapsBefore = P.asked.filter((x) => /\/v1\/swap$/.test(x.url)).length;
    let sent = null, sno = '';
    try { sent = await P.W.sendToken(120, { unit: 'sat' }); } catch (e) { sno = e.message; }
    const swaps = P.asked.filter((x) => /\/v1\/swap$/.test(x.url)).slice(swapsBefore);
    const outIds = (s) => { try { return (JSON.parse(s.body).outputs || []).map((o) => o.id); } catch (e) { return []; } };
    ok(!!sent && /^cashu/.test(sent.token), 'a send after the rotation goes', sno);
    ok(swaps.length >= 1 && outIds(swaps[swaps.length - 1]).every((id) => id === fresh),
      'its outputs are on the new keyset', JSON.stringify(swaps.map(outIds)));
    ok(P.asked.filter((x) => /\/v1\/keysets$/.test(x.url)).length > keysetsBefore, 'after the mint’s keysets were read again');
    ok((await balance(P)) === 380, 'and the books add up: 380 left', String(await balance(P)));
    // a receive, after a second rotation, is set out again once and lands
    const token = sent.token;
    const Q = page();
    await Q.W.connect(SPIN, { remember: true });
    mints.spin.rotate();
    const qBefore = Q.asked.filter((x) => /\/v1\/swap$/.test(x.url)).length;
    let rno = '';
    try { await Q.W.receiveToken(token); } catch (e) { rno = e.message; }
    const qSwaps = Q.asked.filter((x) => /\/v1\/swap$/.test(x.url)).length - qBefore;
    ok(!rno && (await balance(Q)) === 120, 'a receive after a rotation is taken in, its outputs on the active keyset', rno || String(await balance(Q)));
    ok(qSwaps === 2, 'with one refusal and one more try, no more', String(qSwaps));
    // a mint that refuses the keyset every time: the second refusal is the answer
    const Z = page();
    await Z.W.connect(OTHER, { remember: true });
    await Z.W.claim((await Z.W.invoice(200, '')).hash);
    const zBefore = Z.asked.filter((x) => /\/v1\/swap$/.test(x.url)).length;
    mints.other.handle = ((orig) => (m) => (/\/v1\/swap$/.test(String(m.url || ''))
      ? '400\n' + JSON.stringify({ code: 12002, detail: 'Keyset is inactive, cannot sign messages' }) : orig(m)))(mints.other.handle);
    let zno = '';
    try { await Z.W.sendToken(50, { unit: 'sat' }); } catch (e) { zno = e.message; }
    const zSwaps = Z.asked.filter((x) => /\/v1\/swap$/.test(x.url)).length - zBefore;
    ok(!!zno && zSwaps === 2 && (await balance(Z)) === 200, 'a mint that refuses the keyset again: tried once more, then refused as before, nothing lost',
      zSwaps + ' swaps; ' + zno.slice(0, 80));
  }

  /* ---- 3. a version 3 token naming two mints ------------------------------- */
  {
    const A = page();
    await A.W.connect(MINT, { remember: true });
    await A.W.claim((await A.W.invoice(300, '')).hash);
    const B = page();
    await B.W.connect(OTHER, { remember: true });
    const one = await A.W.sendToken(40, { unit: 'sat' });
    const p1 = A.W.tokenInfo(one.token).proofs.map((p) => ({ id: p.id, amount: Number(p.amount), secret: p.secret, C: p.C }));
    // pieces of a second mint, made up (the reader must say something about them either way)
    const p2 = [{ id: '00' + 'ab'.repeat(7), amount: 8, secret: 'deadbeef'.repeat(8), C: '02' + '11'.repeat(32) }];
    const v3 = 'cashuA' + Buffer.from(JSON.stringify({ token: [{ mint: MINT, proofs: p1 }, { mint: OTHER, proofs: p2 }], unit: 'sat' })).toString('base64url');
    let info = null, ino = '';
    try { info = A.W.tokenInfo(v3); } catch (e) { ino = e.message; }
    const C = page();
    await C.W.connect(MINT, { remember: true });
    let took = null, tno = '';
    try { took = await C.W.receiveToken(v3); } catch (e) { tno = e.message; }
    const held = await balance(C);
    if (took) {
      // taken: then every sat it names must be accounted for, never the first mint's alone in silence
      ok(false, 'a two-mint token was taken (' + held + ' sats), which drops the second mint’s ' + 8 + ' unless said', JSON.stringify(info && info.mint));
    } else {
      ok(!!tno && held === 0, 'a version 3 token naming two mints is refused whole, nothing taken', tno);
      // cashu-ts's reader refuses a token of more than one entry ("Multi entry token are not supported"): read as no token at all
      ok(info === null && !ino, 'the reader reads it as no token (cashu-ts: more than one entry is not supported), so nothing of it is listed');
      ok(tno === 'That is not a Cashu token.', 'and a paste of it says so: That is not a Cashu token.', tno);
    }
    void B;
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
