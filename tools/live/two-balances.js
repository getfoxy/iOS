'use strict';
/* two-balances.js — dollars beside bitcoin at a real mint, fake money.
 *
 *     NODE_EXTRA_CA_CERTS=<cert-dir>/cert.pem FOXY_LIVE_LOCAL=1 \
 *       node tools/live/two-balances.js https://127.0.0.1:<port> [out.json]
 *
 * Needs a Nutshell with a usd keyset and a sixty-second quote life, as Forge
 * answers, on ports of its own (not units.js's 3349/8454):
 *
 *   docker run -d --name foxy-twobal-nutshell --platform linux/amd64 \
 *     -p 127.0.0.1:3389:3338 -e MINT_BACKEND_BOLT11_SAT=FakeWallet \
 *     -e MINT_BACKEND_BOLT11_USD=FakeWallet \
 *     -e "MINT_DERIVATION_PATH_LIST=[\"m/0'/0'/0'\",\"m/0'/2'/0'\"]" \
 *     -e MINT_INPUT_FEE_PPK=0 -e MINT_QUOTE_TTL=60 -e MINT_LISTEN_HOST=0.0.0.0 \
 *     -e MINT_LISTEN_PORT=3338 -e MINT_PRIVATE_KEY=TEST_PRIVATE_KEY_TWOBAL \
 *     cashubtc/nutshell:0.20.3 poetry run mint
 *   node tools/live/tls-proxy.js 8484 3389 <cert-dir>
 *
 * Nutshell's FakeWallet prices a bitcoin at 1e8/1337 dollars ($74,794.31), takes
 * a fixed 2-cent reserve on a usd melt, and pays every invoice it made three
 * seconds after it is made (FAKEWALLET_BRR). So a swap's second leg is paid
 * whether or not its first leg paid it: this proves the units, the piles, the
 * rows and the books at a real mint, and tests/two-balances.js proves that one
 * leg pays the other.
 *
 * What it checks, with the current Web/foxy-wallet.js:
 *   L1 the mint's two keysets, as Foxy reads them
 *   L2 a usd invoice, paid by the mint's fake node, into the usd pile in cents
 *   L3 a sat invoice paid from dollars: amount and reserve in cents, change
 *      back into the usd pile, a row in cents
 *   L4 a usd token, received by a fresh Foxy, and refused when taken back
 *   L5 a restore of the words finds the sats and the dollars, apart
 *   L7 a usd quote paid and claimed after its sixty seconds still issues
 *      (Nutshell 0.20.3 stores no expiry on a mint quote; Forge's fork may
 *      differ, which is why this is pinned here)
 *   L8 the books, per unit, after each of the above
 *   and a swap each way, at the mint's rate, with the books per unit.
 * L6 (an unpaid usd quote lapsing) needs a mint that does not pay at all: the
 * same container with FAKEWALLET_BRR=false (FAKEWALLET_DELAY_INCOMING_PAYMENT
 * does not hold the payment back at 0.20.3), say on 3390 behind 8485. Give its
 * address after the first, or L6 says SKIP. L9 is tools/live/units.js, run on
 * its own.
 *
 * Mint requests go through a mocked bridge straight from this machine, not
 * over Tor. Fake money only: a mint on this Mac with FOXY_LIVE_LOCAL=1. */
const fs = require('fs');
const H = require('./harness');
const { books } = require('../../tests/harness');
const MINT = process.argv[2];
const OUT = process.argv[3] && !/^https?:/.test(process.argv[3]) ? process.argv[3] : '';
const SLOW = process.argv.slice(3).find((a) => /^https?:/.test(a)) || '';
H.fakeMoneyOnly(MINT);
if (SLOW) H.fakeMoneyOnly(SLOW);
const log = (...a) => console.log('[live]', ...a);
setTimeout(() => { log('WATCHDOG 600s'); process.exit(2); }, 600000).unref();

const boot = (o) => H.boot(Object.assign({ keychain: { words: '' }, quiet: !process.env.FOXY_LIVE_VERBOSE }, o || {}));
const sum = (ps) => ps.reduce((a, p) => a + Number(p.amount), 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pileOf = (b, unit) => JSON.parse(b.w.localStorage.getItem('foxy.cashu.proofs.' + MINT + (unit && unit !== 'sat' ? '@' + unit : '')) || '[]');
const rowsOf = (b) => JSON.parse(b.w.localStorage.getItem('foxy.cashu.log') || '[]');
// the books of one page at this mint, per unit: what its rows say less what it holds
const offOf = (b) => {
  const all = books({ storage: b.w.localStorage });
  return { sat: (all[MINT] || { off: 0 }).off, usd: (all[MINT + '@usd'] || { off: 0 }).off };
};

/* Paid by the mint's fake node within seconds; watched until claimed. */
function receive(W, amount, unit, ms) {
  return W.invoice(amount, '', { unit }).then((inv) => new Promise((ok, no) => {
    const t = setTimeout(() => { stop(); no(new Error('not claimed within ' + ((ms || 60000) / 1000) + 's')); }, ms || 60000);
    const stop = W.watch(inv.hash, (r) => { clearTimeout(t); ok({ inv, paid: r }); }, {
      pollMs: 1000, onError: (e) => { clearTimeout(t); stop(); no(e); },
    });
  }));
}

/* A sat invoice made by the mint for somebody else, for Foxy to pay. */
async function satInvoice(sats) {
  const r = await fetch(MINT + '/v1/mint/quote/bolt11', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: sats, unit: 'sat' }),
  });
  const j = await r.json();
  if (!j.request) throw new Error('no invoice: ' + JSON.stringify(j));
  return j.request;
}

(async () => {
  const res = { mint: MINT, checks: [] };
  const check = (label, ok, detail) => {
    res.checks.push({ label, ok: !!ok, detail });
    log((ok ? 'OK    ' : 'FAIL  ') + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));
  };
  const skip = (label, why) => { res.checks.push({ label, ok: true, skipped: why }); log('SKIP  ' + label + ' — ' + why); };
  try {
    const a = boot();
    const W = a.W;
    await W.seedReady();
    await W.connect(MINT);
    const words = a.keychain.words;

    // L1
    check('L1 Foxy reads both keysets: the mint issues sat and usd', JSON.stringify(W.mintUnits()) === '["sat","usd"]' && W.twoUnits(),
      W.mintUnits());

    // L2
    const t0 = Date.now();
    const got = await receive(W, 250, 'usd');
    check('L2 a usd invoice says sixty seconds', got.inv.expiresAt && got.inv.expiresAt - t0 <= 61000 && got.inv.expiresAt - t0 >= 50000,
      got.inv.expiresAt - t0);
    check('L2 paid and claimed: the watch says usd, 250 cents, no sats', got.paid.unit === 'usd' && got.paid.amount === 250 && got.paid.sats === 0, got.paid);
    check('L2 the cents are in the usd pile, exactly', sum(pileOf(a, 'usd')) === 250 && W.balanceOf('usd') === 250 && (await W.balanceSats()) === 0,
      { usd: sum(pileOf(a, 'usd')), sat: await W.balanceSats() });
    const rate = W.mintRate();
    check('L2 the mint’s rate is read off the quote, near FakeWallet’s $74,794', rate && Math.abs(rate.usdPerBtc - 74794.31) / 74794.31 < 0.01, rate);
    await receive(W, 2000, 'sat');
    check('L8 the books close per unit after receiving', JSON.stringify(offOf(a)) === '{"sat":0,"usd":0}', offOf(a));

    // L3
    const bolt11 = await satInvoice(500);
    const both = await W.quoteFeeBoth(bolt11);
    const want = Math.ceil(500 * 74794.31 / 1e6);
    check('L3 the usd quote of a 500-sat invoice is in cents, reserve 2', both.usd && both.usd.unit === 'usd' && Math.abs(both.usd.amount - want) <= 1 && both.usd.feeReserve === 2,
      both.usd && { amount: both.usd.amount, reserve: both.usd.feeReserve, want });
    check('L3 and the sat quote is in sats', both.sat && both.sat.unit === 'sat' && both.sat.amount === 500, both.sat && both.sat.amount);
    const need = W.payNeed(both.usd.amount, both.usd.feeReserve, { unit: 'usd' });
    check('L3 the need is in cents against the usd pile', need && need.ok && need.have === 250 && need.unit === 'usd', need);
    const paid = await W.pay(bolt11, () => {}, { unit: 'usd', quote: both.usd });
    const left = W.balanceOf('usd');
    check('L3 paid from dollars: the amount in cents, the fee no more than the reserve', paid.unit === 'usd' && paid.amount === both.usd.amount && paid.fee <= 2,
      paid);
    check('L3 what is left is the pile less amount and fee: the rest of the reserve came back', left === 250 - paid.amount - paid.fee && W.balanceOf('sat') === 2000,
      { left, sat: W.balanceOf('sat') });
    const row = rowsOf(a).find((r) => r.hash === paid.hash);
    check('L3 its row is in cents, sats at 0', row && row.unit === 'usd' && row.amount === paid.amount && row.feeAmount === paid.fee && row.sats === 0, row);
    check('L8 the books close per unit after paying from dollars', JSON.stringify(offOf(a)) === '{"sat":0,"usd":0}', offOf(a));

    // L4
    await receive(W, 300, 'usd');
    const sent = await W.sendToken(120, { unit: 'usd' });
    check('L4 a usd token is made in cents', sent.unit === 'usd' && sent.amount === 120 && W.tokenInfo(sent.token).unit === 'usd', { unit: sent.unit, amount: sent.amount });
    const b = boot();
    await b.W.seedReady();
    await b.W.connect(MINT);
    const took = await b.W.receiveToken(sent.token);
    check('L4 a fresh Foxy receives it into its usd pile', took.unit === 'usd' && took.amount === 120 && b.W.balanceOf('usd') === 120, took);
    let back = '';
    try { await W.reclaimToken(sent.token); } catch (e) { back = e.message; }
    check('L4 taking it back is refused as spent', /already spent/.test(back), back);
    check('L8 the books close per unit after a usd token', JSON.stringify(offOf(a)) === '{"sat":0,"usd":0}' && JSON.stringify(offOf(b)) === '{"sat":0,"usd":0}',
      { a: offOf(a), b: offOf(b) });

    // the swap, both ways
    const q1 = await W.swapQuote('usd', 'sat', 200);
    check('swap: dollars to bitcoin quoted at the mint’s rate, no more than asked', q1.total <= 200 && q1.get > 0
      && Math.abs(q1.rate.usdPerBtc - 74794.31) / 74794.31 < 0.03, { total: q1.total, get: q1.get, fee: q1.fee, rate: q1.rate });
    const satBefore = W.balanceOf('sat'), usdBefore = W.balanceOf('usd');
    const r1 = await W.swapRun(q1);
    check('swap: run, done', r1.state === 'done', r1);
    check('swap: each pile moved by its own figures', W.balanceOf('sat') === satBefore + q1.get && W.balanceOf('usd') === usdBefore - r1.from.amount,
      { sat: W.balanceOf('sat') - satBefore, usd: W.balanceOf('usd') - usdBefore });
    check('swap: a row on each side', rowsOf(a).filter((x) => x.swap === q1.id && x.kind === 'swap').length === 2);
    const q2 = await W.swapQuote('sat', 'usd', 1000);
    const r2 = await W.swapRun(q2);
    check('swap: bitcoin to dollars, done', r2.state === 'done' && r2.to.unit === 'usd' && r2.to.amount === q2.get, r2);
    check('L8 the books close per unit after two swaps', JSON.stringify(offOf(a)) === '{"sat":0,"usd":0}', offOf(a));
    check('swap: nothing left pending', W.unitSwapsPending().length === 0, W.unitSwapsPending());

    // L5
    const found = (await H.scanFresh(words, [MINT]))[0] || {};
    check('L5 a restore of the words finds the sats and the dollars apart',
      found.state === 'done' && found.sats === W.balanceOf('sat') && found.units && found.units.usd && found.units.usd.amount === W.balanceOf('usd'),
      { sats: found.sats, usd: found.units && found.units.usd && found.units.usd.amount, have: { sat: W.balanceOf('sat'), usd: W.balanceOf('usd') } });

    // L7: paid at once, claimed after its sixty seconds
    const late = await W.invoice(55, '', { unit: 'usd' });
    log('waiting 66 s for a usd quote to pass its expiry before it is claimed');
    await sleep(66000);
    let lateGot = 0, lateWhy = '';
    try { lateGot = await W.claim(late.hash); } catch (e) { lateWhy = e.message; }
    check('L7 a usd quote paid then claimed after its sixty seconds still issues (Nutshell 0.20.3 keeps no expiry)', lateGot === 55, lateWhy || lateGot);
    check('L8 the books close per unit at the end', JSON.stringify(offOf(a)) === '{"sat":0,"usd":0}', offOf(a));

    // L6
    if (!SLOW) {
      skip('L6 an unpaid usd quote lapses at sixty seconds and a new one is made', 'no slow mint given');
    } else {
      const s = boot();
      await s.W.seedReady();
      await s.W.connect(SLOW);
      const old = await s.W.invoice(30, '', { unit: 'usd' });
      log('waiting 63 s for an unpaid usd quote to lapse');
      await sleep(63000);
      check('L6 the old quote has lapsed', Date.now() > old.expiresAt, old.expiresAt);
      const fresh = await s.W.invoice(30, '', { unit: 'usd' });
      check('L6 a new one is made', fresh.hash !== old.hash && fresh.expiresAt > Date.now() + 50000);
      await s.W.sweepQuotes();
      const kept = JSON.parse(s.w.localStorage.getItem('foxy.cashu.quotes') || '[]').map((q) => q.quote);
      /* Kept five minutes past its end (15-receiving.js, `sweepQuotes`): a
       * payment on its way as the minute ran out is still settled by the mint. */
      check('L6 the sweep keeps the lapsed one for five minutes, and the new', kept.indexOf(old.hash) >= 0 && kept.indexOf(fresh.hash) >= 0, kept);
    }
  } catch (e) {
    res.error = String(e && (e.stack || e.message));
    log('ERROR', res.error.split('\n').slice(0, 4).join(' | '));
  }
  log(H.phoneReport());
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  const failed = res.error || res.checks.some((c) => !c.ok) || H.nativeStats.wordsAsked || H.nativeStats.pageSeedDerivations || H.nativeStats.tooFarAhead;
  log(failed ? 'SOME CHECKS FAILED' : 'all checks pass');
  process.exit(failed ? 1 : 0);
})();
