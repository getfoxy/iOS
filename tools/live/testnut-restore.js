'use strict';
/* testnut-restore.js — a live end-to-end run on a fake-money test mint:
 * first-connect seed, claim, send a token, pay, then restore from the words and
 * compare. Reaches testnut.cashu.space directly from this machine, not over Tor.
 * Refuses any mint that is not a testnut. */
// A "phone": current Web/foxy-wallet.js with the mocked phone (harness.js, an
// empty keychain, every mint request carried out with fetch), so connect() has
// the phone make the seed. Fake-money test mints only.
// usage: node tools/live/testnut-restore.js https://nofee.testnut.cashu.space build/live-nofee.json
const fs = require('fs');
const H = require('./harness');
const MINT = process.argv[2];
const OUT = process.argv[3];
if (!/testnut\.cashu\.space$/.test(new URL(MINT).host)) throw new Error('test mints only');
const log = (...a) => console.log('[phone]', ...a);
setTimeout(() => { log('WATCHDOG 400s'); process.exit(2); }, 400000).unref();

/* A wallet on a phone with an empty keychain, recording how each cashu-ts Wallet is built. */
function boot() {
  const b = H.boot({ keychain: { words: '' } });
  const CT = b.w.CashuTS, built = [];
  const ns = {}; for (const k of Object.keys(CT)) ns[k] = CT[k];
  ns.Wallet = class extends CT.Wallet { constructor(u, o) { super(u, o); built.push(o || {}); } };
  b.w.CashuTS = ns;
  return Object.assign(b, { built });
}

async function mintAndClaim(W, sats) {
  const inv = await W.invoice(sats, 'phone-live');
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('not paid within 120s')), 120000);
    W.watch(inv.hash, r => { clearTimeout(t); ok(r.sats); }, { pollMs: 2000, onError: e => log('watch err', e && e.message) });
  });
}

(async () => {
  const res = { mint: MINT };
  try {
    const b = boot();
    const W = b.W;
    await W.seedReady();
    log('phone before connect:', b.keychain.words ? 'has a seed' : 'no seed');
    await W.connect(MINT);
    const opts = b.built[b.built.length - 1];
    res.firstConnect = { seedCreated: b.phone.asks.filter((a) => a.action === 'seedCreate').length,
      builtWithPlaceholder: !!opts.bip39seed && !!opts.outputDataCreator, policy: opts.secretsPolicy,
      words: b.keychain.words.split(' ').length };
    log('first connect:', JSON.stringify(res.firstConnect));
    res.words = b.keychain.words;

    res.claimed = await mintAndClaim(W, 100);
    log('claimed', res.claimed);
    const t = await W.sendToken(21);
    res.token = t.token; res.tokenPrefix = t.token.slice(0, 6);
    log('sent token', t.sats, 'sats', res.tokenPrefix);
    try {
      // a melt: pays an invoice from the same (fake-wallet) mint, so NUT-08 blank
      // outputs reserve counters that are only partly signed
      const q = await W.invoice(10, 'melt target');
      const paid = await W.pay(q.request || q.bolt11 || q.pr);
      res.melt = { ok: true, feeSats: paid && paid.feeSats };
      log('melt ok', JSON.stringify(paid));
    } catch (e) { res.melt = { ok: false, why: e.message }; log('melt skipped:', e.message); }
    res.balance = await W.balanceSats();
    res.counters = H.counters(b);
    log('balance', res.balance, 'counters', JSON.stringify(res.counters));

    // Foxy restoring the words in a wallet that never saw them: typed on another phone
    const rows = await H.scanFresh(res.words, [MINT]);
    const row = rows[0] || {};
    res.foxyRestore = { state: row.state, sats: row.sats, count: row.count, counters: row.counters, why: row.why };
    log('Foxy restore:', JSON.stringify(res.foxyRestore));
  } catch (e) {
    res.error = String(e && (e.stack || e.message));
    log('ERROR', res.error.split('\n').slice(0, 3).join(' | '));
  }
  log(H.phoneReport());
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  process.exit(res.error ? 1 : 0);
})();
