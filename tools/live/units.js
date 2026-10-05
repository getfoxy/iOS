'use strict';
/* units.js — Foxy and usd ecash at a real mint, fake money.
 *
 *     NODE_EXTRA_CA_CERTS=<cert-dir>/cert.pem FOXY_LIVE_LOCAL=1 \
 *       node tools/live/units.js https://127.0.0.1:<port> [out.json]
 *
 * Needs a Nutshell with a usd unit, for example on ports of its own:
 *
 *   docker run -d --name foxy-units-nutshell --platform linux/amd64 \
 *     -p 127.0.0.1:3349:3338 -e MINT_BACKEND_BOLT11_SAT=FakeWallet \
 *     -e MINT_BACKEND_BOLT11_USD=FakeWallet \
 *     -e "MINT_DERIVATION_PATH_LIST=[\"m/0'/0'/0'\",\"m/0'/2'/0'\"]" \
 *     -e MINT_INPUT_FEE_PPK=0 -e MINT_LISTEN_HOST=0.0.0.0 \
 *     -e MINT_LISTEN_PORT=3338 -e MINT_PRIVATE_KEY=TEST_PRIVATE_KEY_UNITS \
 *     cashubtc/nutshell:0.20.3 poetry run mint
 *
 * The usd backend alone is not enough: Nutshell advertises usd but issues no
 * usd keyset until a derivation path for it (m/0'/2'/…, 2 being usd) is
 * listed. Input fees are 0 so every figure below is exact.
 *   node tools/live/tls-proxy.js 8454 3349 <cert-dir>     (cert as in local-mint.sh)
 *
 * What it checks, with the current Web/foxy-wallet.js:
 *   1. another wallet (cashu-ts itself) mints sats AND usd under Foxy's words
 *   2. a fresh Foxy restores those words: the sats as before, the usd into the
 *      usd pile, never added to the sats
 *   3. a usd token from a stranger: tokenInfo reads it in cents, receiveToken
 *      swaps it into the usd pile
 *   4. reconcile sees the usd pile; sending usd is refused; a sat token still sends
 *   5. a second restore from the words finds the received usd too — the
 *      counters Foxy used for the usd swap were derived and kept per keyset
 *
 * Mint requests from Foxy go through a mocked bridge straight from this
 * machine, not over Tor. Fake money only: testnut, or a mint on this Mac with
 * FOXY_LIVE_LOCAL=1. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const H = require('./harness');
const MINT = process.argv[2];
const OUT = process.argv[3] || '';
H.fakeMoneyOnly(MINT);
const log = (...a) => console.log('[live]', ...a);
setTimeout(() => { log('WATCHDOG 300s'); process.exit(2); }, 300000).unref();

/* A wallet on its own phone (harness.js): the phone keeps the seed and the
 * counters, and the page gets only secrets. FOXY_LIVE_VERBOSE=1 shows its log. */
function boot(keychain) {
  return H.boot({ keychain: keychain || { words: '' }, quiet: !process.env.FOXY_LIVE_VERBOSE });
}

/* Mint `amount` in `unit` with cashu-ts directly — "another wallet". */
async function mintWith(CT, unit, amount, seed) {
  const opts = seed ? { unit, bip39seed: seed, secretsPolicy: 'deterministic' } : { unit };
  const wal = new CT.Wallet(MINT, opts);
  await wal.loadMint();
  const q = await wal.createMintQuoteBolt11(amount);
  for (let i = 0; i < 30; i++) {
    const st = await wal.checkMintQuoteBolt11(q.quote);
    if (String(st.state).toUpperCase() === 'PAID') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return wal.mintProofsBolt11(amount, q.quote);
}

const sum = (ps) => ps.reduce((a, p) => a + Number(p.amount), 0);

(async () => {
  const res = { mint: MINT, checks: [] };
  const check = (label, ok, detail) => {
    res.checks.push({ label, ok: !!ok, detail });
    log((ok ? 'OK    ' : 'FAIL  ') + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));
  };
  try {
    // a Foxy whose phone makes the words
    const bA = boot();
    const wA = bA.w;
    await bA.W.seedReady();
    await bA.W.connect(MINT);
    const words = bA.keychain.words;
    // "another wallet" with the same words: its seed made here by the phone's own bip39, never by the page
    const seed = bA.phone.toSeed(words);

    // 1. another wallet with the same words mints 300 sats and $1.50
    const keysets = await (await fetch(MINT + '/v1/keysets')).json();
    res.units = [...new Set(keysets.keysets.map((k) => k.unit))];
    check('the mint offers sat and usd', res.units.includes('sat') && res.units.includes('usd'), res.units);
    const satProofs = await mintWith(wA.CashuTS, 'sat', 300, seed);
    const usdProofs = await mintWith(wA.CashuTS, 'usd', 150, seed);
    check('another wallet minted 300 sats and 150 usd cents under the words', sum(satProofs) === 300 && sum(usdProofs) === 150,
      { sat: sum(satProofs), usd: sum(usdProofs) });

    // 2. a fresh Foxy restores the words, typed on its phone
    const bB = boot();
    const wB = bB.w;
    const W = bB.W;
    await W.seedReady();
    const { rows, adopt } = await H.restoreWords(bB, words, [MINT]);
    const row = rows[0] || {};
    check('restore finds the sats exactly as before', row.state === 'done' && row.sats === 300, { state: row.state, sats: row.sats, why: row.why });
    check('restore finds the usd in its own unit', row.units && row.units.usd && row.units.usd.amount === 150,
      row.units && Object.fromEntries(Object.entries(row.units).map(([u, v]) => [u, v.amount])));
    await adopt({ overwrite: true });
    await W.connect(MINT);
    check('the usd is filed in the usd pile, apart from the sats',
      W.balanceIn(MINT, 'usd') === 150 && (await W.balanceSats()) === 300 &&
      !!wB.localStorage.getItem('foxy.cashu.proofs.' + MINT + '@usd'), W.balances());

    // 3. a usd token from a stranger (random secrets)
    const stranger = await mintWith(wA.CashuTS, 'usd', 75, null);
    const token = wA.CashuTS.getEncodedToken({ mint: MINT, proofs: stranger, unit: 'usd' });
    const info = W.tokenInfo(token);
    check('tokenInfo reads the usd token in cents and not as sats',
      info && info.unit === 'usd' && info.amount === 75 && info.sats === null, info && { unit: info.unit, amount: info.amount, sats: info.sats });
    const got = await W.receiveToken(token);
    check('receiveToken swaps it into the usd pile', got.unit === 'usd' && got.amount === 75 && W.balanceIn(MINT, 'usd') === 225,
      { got: { unit: got.unit, amount: got.amount }, usd: W.balanceIn(MINT, 'usd'), sats: await W.balanceSats() });
    let spentBack = false;
    try { await W.receiveToken(token); } catch (e) { spentBack = /spent|already/i.test(e.message); res.secondReceive = e.message; }
    check('the same usd token cannot be received twice', spentBack, res.secondReceive);

    // 4. reconcile, sending usd, sending sats
    const rec = await W.reconcile();
    check('reconcile checks the usd pile and keeps it', rec.units && rec.units.usd && rec.units.usd.after === 225 && rec.spent === 0,
      rec);
    let refused = '';
    try { await W.sendToken(10, { unit: 'usd' }); } catch (e) { refused = e.message; }
    check('sending usd ecash is refused', /only send sats/.test(refused), refused);
    const sent = await W.sendToken(20);
    check('a sat token still sends', sent.sats === 20 && (await W.balanceSats()) === 280, { sats: sent.sats, left: await W.balanceSats() });

    // 5. restore again: the usd Foxy swapped for is derived from the words too
    const again = (await H.scanFresh(words, [MINT]))[0] || {};
    check('a second restore finds 300 sats (280 + the unclaimed 20) and 225 usd cents',
      again.sats === 300 && again.units && again.units.usd && again.units.usd.amount === 225,
      { sats: again.sats, usd: again.units && again.units.usd && again.units.usd.amount, partial: again.partial });
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
