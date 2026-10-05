'use strict';
/* used-counters.js — Foxy at a mint that has already seen its counters.
 *
 *     NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *       node tools/live/used-counters.js https://127.0.0.1:8443 [out.json]
 *
 * What happened on a phone at a CDK mint: the wallet's
 * counters were behind what the mint had seen, so making ecash failed with
 * "Duplicate outputs" and a paid invoice never claimed. This puts a wallet in
 * that state on purpose — counters moved back past outputs the mint has signed
 * — before each of a swap, a receive and a signed (NUT-20) claim, and checks
 * each one gets through, then restores the words and compares.
 *
 * The current Web/foxy-wallet.js, or FOXY_WALLET_FILE to run an older one as a
 * control. Fake money only: testnut, or a mint on this Mac with
 * FOXY_LIVE_LOCAL=1 (tools/live/local-mint.sh). Mint requests go straight from
 * this machine through a mocked bridge, not over Tor. */
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const MINT = process.argv[2];
const OUT = process.argv[3] || '';
const WALLET = process.env.FOXY_WALLET_FILE || path.join(H.ROOT, 'Web', 'foxy-wallet.js');
H.fakeMoneyOnly(MINT);
const log = (...a) => console.log('[live]', ...a);
setTimeout(() => { log('WATCHDOG 300s'); process.exit(2); }, 300000).unref();

/* The wallet on its own phone (harness.js). b.rec.mintSaid is every refusal, as
 * the mint sent it, and b.rec.warn Foxy's own warnings. The counters are the
 * phone's: moving them back is done on the mocked phone, as a counter file
 * restored from an older backup would be. */
const b = H.boot({ keychain: { words: '' }, quiet: false });
const mintSaid = b.rec.mintSaid;
const foxySaid = b.rec.warn;
const counters = () => H.counters(b);

async function mintAndClaim(W, sats) {
  const inv = await W.invoice(sats, '');
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('not claimed within 90s')), 90000);
    W.watch(inv.hash, (r) => { clearTimeout(t); ok(r.sats); }, {
      pollMs: 2000, onError: (e) => { clearTimeout(t); no(e); },
    });
  });
}

(async () => {
  const res = { mint: MINT, wallet: path.relative(H.ROOT, WALLET), steps: [] };
  const W = b.W;
  try {
    await W.seedReady();
    await W.connect(MINT);
    res.words = b.keychain.words;
    res.claimed = await mintAndClaim(W, 200);
    log('claimed', res.claimed, 'sats');

    // two tokens: their outputs are signed at the mint, and show how many counters an operation uses
    const before = counters();
    const t1 = await W.sendToken(8);
    const t2 = await W.sendToken(8);
    const after = counters();
    const used = Math.max(...Object.keys(after).map((k) => after[k] - (before[k] || 0)));
    log('two tokens used', used, 'counters');

    /* Every step starts from the counters as they were before the two tokens.
     * Everything signed since — the tokens, and each earlier step, wherever its
     * skips took it — lies ahead, so every step meets used counters, and later
     * steps need more than one skip to get past them. */
    const step = async (label, run) => {
      const markMint = mintSaid.length, markFoxy = foxySaid.length;
      const now = counters();
      H.setCounters(b, before);
      const row = { label, movedBack: Math.max(...Object.keys(now).map((k) => now[k] - (before[k] || 0))) };
      try { row.result = await run(); row.ok = true; } catch (e) { row.ok = false; row.error = e.message; }
      row.mintSaid = mintSaid.slice(markMint);
      row.skips = foxySaid.slice(markFoxy).map((l) => (/moving the counters on by (\d+)/.exec(l) || [])[1]).filter(Boolean).map(Number);
      res.steps.push(row);
      log((row.ok ? 'OK    ' : 'FAIL  ') + label + ' — mint said: ' + (row.mintSaid.map((m) => m.replace(/\s+/g, ' ')).join(' | ') || 'nothing')
        + ' — Foxy skipped: ' + (row.skips.join(', ') || 'none') + (row.ok ? '' : ' — ' + row.error));
    };

    const unclaimed = [t2];
    await step('make ecash (swap) on used counters', async () => { const t3 = await W.sendToken(5); unclaimed.push(t3); return t3.sats; });
    await step('receive a token (swap) on used counters', async () => (await W.receiveToken(t1.token)).sats);
    await step('claim a paid signed invoice on used counters', async () => mintAndClaim(W, 20));

    res.balance = await W.balanceSats();
    res.unclaimed = unclaimed.map((t) => t.sats);
    const expected = res.balance + res.unclaimed.reduce((a, b) => a + b, 0);
    const rows = await H.scanFresh(res.words, [MINT]);
    res.restore = { state: rows[0] && rows[0].state, sats: rows[0] && rows[0].sats, expected };
    // a token's sats are its proofs; the unclaimed ones are still ours at the mint, so a restore finds them
    res.restoreMatches = res.restore.sats === expected;
    log('balance', res.balance, '+ unclaimed tokens', res.unclaimed.join(' + '), '=', expected,
      '; restore from the words found', res.restore.sats, '(' + res.restore.state + ')', res.restoreMatches ? '— matches' : '— DOES NOT MATCH');
  } catch (e) {
    res.error = String(e && (e.stack || e.message));
    log('ERROR', res.error.split('\n').slice(0, 3).join(' | '));
  }
  log(H.phoneReport());
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  const failed = res.error || res.steps.some((s) => !s.ok) || !res.restoreMatches
    || H.nativeStats.wordsAsked || H.nativeStats.pageSeedDerivations || H.nativeStats.tooFarAhead;
  log(failed ? 'SOME STEPS FAILED' : 'all steps got through');
  process.exit(failed ? 1 : 0);
})();
