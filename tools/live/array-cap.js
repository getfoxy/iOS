'use strict';
/* array-cap.js — a mint with a SMALL NUT-06 max_array_length, and the two
 * places Foxy chunks by it.
 *
 *   CDK_MAX_ARRAY=25 sh tools/live/local-mint.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/array-cap.js [https://127.0.0.1:8443]
 *
 * cashu-ts chunks its own /v1/checkstate and batchRestore by the cap. Foxy has
 * two paths that do not go through cashu-ts and so had to learn it separately
 * (00-header-and-mint-errors.js `mintArrayCap` / `inChunks`):
 *
 *   - the sent-token watch (20-helpers.js `tokenClaimState`), which POSTs one Y
 *     per proof in the token to /v1/checkstate itself. Over the cap the mint
 *     refuses the whole request, and the watch reads 'waiting' for ever on a
 *     token that was in fact redeemed;
 *   - the restore walk (13-restore.js, `Math.min(RESTORE_BATCH, mintArrayCap)`),
 *     whose batch of 100 outputs a small mint would refuse — and a refused
 *     batch ends the walk, which for a restore means ecash that is there and is
 *     not found.
 *
 * Until now neither had live coverage: every mint the suites ran against
 * advertised 1000 or nothing at all, so a token never had more proofs than the
 * cap and the chunking never fired. This script makes a mint say 25.
 *
 * It needs a pile of single-sat pieces, because a token only holds many proofs
 * when it is made of pieces already held (05-paying-this-mint.js `exactPieces`,
 * no swap): a swap-made token of any amount is a handful of powers of two.
 * So it mints 1 sat at a time, which is why it takes about a minute.
 *
 * Steps, each OK/FAIL, exit 1 on any FAIL:
 *  1. the mint advertises the small cap, and cashu-ts reads it
 *  2. a token with more proofs than the cap (made without a swap)
 *  3. the watch's /v1/checkstate goes out in chunks, none over the cap, every Y
 *     sent exactly once — and the answer is still 'waiting'
 *  4. a restore in a wallet that never saw the words finds everything, and its
 *     /v1/restore batches are none of them over the cap
 *  5. the token claimed elsewhere, and the chunked watch now reads 'claimed' */
const H = require('./harness');

const MINT = process.argv[2] || H.MINTS.cdk.https;
const HTTP = process.argv[3] || H.MINTS.cdk.http;
setTimeout(() => { console.log('WATCHDOG 900s'); process.exit(2); }, 900000).unref();

const R = H.reporter('array-cap');

/* Every request a wallet made, in order, with its body: boot's onMint hook. */
function recorder() {
  const seen = [];
  return { seen, hook: (r) => seen.push(r), of: (method, path) => seen.filter((r) => r.method === method && r.path === path) };
}

async function wallet(url, onMint) {
  const b = H.boot({ keychain: { words: '' }, onMint });
  await b.W.seedReady();
  await b.W.connect(url);
  return b;
}

(async () => {
  await H.mintNames(['cdk']);
  const info = await (await fetch(HTTP + '/v1/info')).json();
  const cap = Number(info.max_array_length);
  R.log('=== ' + H.MINTS.cdk.name + ' at ' + MINT + ', max_array_length ' + info.max_array_length);

  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > 100) {
    R.fail('1. the mint advertises a small max_array_length',
      'the mint says max_array_length ' + JSON.stringify(info.max_array_length) +
      ' — start it with a small cap: CDK_MAX_ARRAY=25 sh tools/live/local-mint.sh up');
    console.log(H.phoneReport());
    console.log('1 FAILED');
    process.exit(1);
  }

  const recA = recorder();
  const A = await wallet(MINT, recA.hook);

  await R.step('1. the mint advertises the small cap, and cashu-ts reads it', async () => {
    // the same reader Foxy's wallet is: cashu-ts's MintInfo, loaded from this mint
    const raw = new A.w.CashuTS.Wallet(MINT);
    await raw.loadMint();
    if (raw.maxArrayLength !== cap) throw new Error('cashu-ts read ' + raw.maxArrayLength + ', /v1/info says ' + cap);
    return '/v1/info max_array_length ' + cap + ', and the wallet’s maxArrayLength is ' + raw.maxArrayLength;
  });

  /* A pile of single-sat pieces, so the token can be made of held pieces. */
  const WANT = cap + 5;
  const PIECES = cap + 15;
  const t0 = Date.now();
  for (let i = 0; i < PIECES; i++) await H.mintAndClaim(A.W, 1);
  R.log(PIECES + ' single-sat claims in ' + Math.round((Date.now() - t0) / 1000) + 's');

  let tok = null, ys = 0;
  await R.step('2. a token with more proofs than the cap', async () => {
    const before = await A.W.balanceSats();
    tok = await A.W.sendToken(WANT);
    const n = A.W.tokenInfo(tok.token).proofs.length;
    ys = n;
    if (!(n > cap)) {
      throw new Error('the token holds ' + n + ' proofs and the cap is ' + cap +
        ' — nothing would chunk. Raise PIECES/WANT, or lower the mint’s cap.');
    }
    if (tok.swapped) throw new Error('the token was swapped for, so its proofs are powers of two, not the held pieces');
    return n + ' proofs (cap ' + cap + '), ' + tok.sats + ' sat; balance ' + before + ' -> ' + (await A.W.balanceSats());
  });

  await R.step('3. the sent-token watch chunks /v1/checkstate', async () => {
    if (!tok) throw new Error('no token');
    if (!A.W.watchTokenClaim(tok.hash)) throw new Error('the token could not be watched');
    const from = recA.seen.length;
    const state = await A.W.tokenClaimState(tok.hash);
    const reqs = recA.seen.slice(from).filter((r) => r.method === 'POST' && r.path === '/v1/checkstate');
    if (!reqs.length) throw new Error('the watch sent no /v1/checkstate');
    const sizes = reqs.map((r) => ((r.body && r.body.Ys) || []).length);
    const over = sizes.filter((n) => n > cap);
    if (over.length) throw new Error('a /v1/checkstate carried ' + over.join(',') + ' Ys, over the cap ' + cap);
    const sent = [].concat(...reqs.map((r) => (r.body && r.body.Ys) || []));
    const unique = new Set(sent);
    if (sent.length !== ys || unique.size !== ys) {
      throw new Error('the chunks carried ' + sent.length + ' Ys (' + unique.size + ' distinct) for a token of ' + ys + ' proofs');
    }
    if (sizes.length !== Math.ceil(ys / cap)) {
      throw new Error(sizes.length + ' requests for ' + ys + ' Ys at ' + cap + ' a request');
    }
    // the mint answered every chunk, so the watch has a real answer, not a swallowed refusal
    if (state !== 'waiting') throw new Error('the watch says ' + state + ' for a token nobody has claimed');
    if (A.rec.mintSaid.length) throw new Error('the mint refused something: ' + A.rec.mintSaid.slice(-1)[0]);
    return ys + ' Ys in ' + sizes.length + ' requests of ' + sizes.join('+') + ' (cap ' + cap + '); watch says ' + state;
  });

  await R.step('3b. the same request unchunked is refused by the mint', async () => {
    /* The chunking is load-bearing only if the whole-token request would have
     * failed. So: exactly what Foxy used to send — every Y of the token in one
     * POST — put to the mint directly. A mint that took it would mean this
     * script proves nothing. */
    const sent = [].concat(...recA.of('POST', '/v1/checkstate').map((r) => (r.body && r.body.Ys) || []));
    const Ys = [...new Set(sent)];
    if (Ys.length !== ys) throw new Error('only ' + Ys.length + ' distinct Ys recorded for a token of ' + ys);
    const r = await fetch(HTTP + '/v1/checkstate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Ys }),
    });
    const body = await r.text();
    if (r.status < 400) throw new Error('the mint took all ' + ys + ' Ys in one request (' + r.status + '), so nothing here is being tested');
    const half = await fetch(HTTP + '/v1/checkstate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Ys: Ys.slice(0, cap) }),
    });
    if (half.status >= 400) throw new Error('the mint refused a request of ' + cap + ' Ys too (' + half.status + '): the cap is not what refused it');
    return ys + ' Ys in one request: ' + r.status + ' ' + body.slice(0, 80) + '; ' + cap + ' Ys: ' + half.status;
  });

  await R.step('4. a restore finds everything, in batches the mint will take', async () => {
    const bal = await A.W.balanceSats();
    const recF = recorder();
    const F = H.boot({ keychain: { words: '' }, onMint: recF.hook });
    await F.W.seedReady();
    // typed on the phone and adopted by candidate (harness.js)
    const { rows, adopt } = await H.restoreWords(F, A.keychain.words, [MINT]);
    await adopt();
    await F.W.connect(MINT);
    const restored = await F.W.balanceSats();
    const want = bal + tok.sats;      // the token is still unspent, so a restore holds it too
    if (rows[0].sats !== want || restored !== want) {
      throw new Error('balance ' + bal + ' + token ' + tok.sats + ' = ' + want + ', scan found ' + rows[0].sats + ', adopted ' + restored);
    }
    if (rows[0].partial || rows[0].state === 'failed') {
      throw new Error('the scan came back partial or failed: ' + rows[0].state + ' ' + (rows[0].why || '') + ' ' + JSON.stringify(rows[0].missing || []));
    }
    const reqs = recF.of('POST', '/v1/restore');
    if (!reqs.length) throw new Error('the restore sent no /v1/restore');
    const sizes = reqs.map((r) => ((r.body && r.body.outputs) || []).length);
    const over = sizes.filter((n) => n > cap);
    if (over.length) throw new Error('a /v1/restore carried ' + over.join(',') + ' outputs, over the cap ' + cap);
    if (Math.max(...sizes) !== cap) {
      throw new Error('no restore batch reached the cap (' + sizes.join(',') + '): the walk may not have been cut by it at all');
    }
    if (F.rec.mintSaid.length) throw new Error('the mint refused something: ' + F.rec.mintSaid.slice(-1)[0]);
    return 'balance ' + bal + ' + token ' + tok.sats + ' = ' + restored + ' restored; ' +
      reqs.length + ' /v1/restore batches of ' + sizes.join(',') + ' (cap ' + cap + ')';
  });

  await R.step('5. the token claimed elsewhere, and the chunked watch sees it', async () => {
    const B = await wallet(MINT);
    const all = A.W.tokenInfo(tok.token).proofs;
    /* The whole token in one receive is more inputs than this mint takes — the
     * same 25 — so it is handed over in pieces the mint will accept. Worth
     * noticing rather than hiding: Foxy's exactPieces can build a token with
     * more proofs than the mint it came from will take as inputs. */
    let whole = null;
    try { await B.W.receiveToken(tok.token); } catch (e) { whole = e; }
    if (!whole) throw new Error('the mint took ' + all.length + ' inputs though it caps them at ' + cap);
    let got = 0;
    for (let i = 0; i < all.length; i += cap) {
      const part = A.w.CashuTS.getEncodedToken({ mint: tok.mint, proofs: all.slice(i, i + cap), unit: 'sat' });
      got += (await B.W.receiveToken(part)).sats;
    }
    const from = recA.seen.length;
    const state = await H.waitFor(async () => {
      const s = await A.W.tokenClaimState(tok.hash);
      return s === 'claimed' ? s : null;
    }, 30000, 2000);
    const reqs = recA.seen.slice(from).filter((r) => r.method === 'POST' && r.path === '/v1/checkstate');
    const sizes = reqs.map((r) => ((r.body && r.body.Ys) || []).length);
    if (sizes.some((n) => n > cap)) throw new Error('a /v1/checkstate carried ' + sizes.join(',') + ' Ys, over the cap ' + cap);
    if (state !== 'claimed') throw new Error('the watch still says ' + (await A.W.tokenClaimState(tok.hash)) + ' after the token was redeemed');
    return 'the whole token was refused (' + String(whole.message).slice(0, 60) + '), ' +
      Math.ceil(all.length / cap) + ' pieces received for ' + got + ' of ' + tok.sats +
      '; the watch reads claimed from ' + sizes.join('+') + ' Ys (cap ' + cap + ')';
  });

  console.log(H.phoneReport());
  let failures = R.failed().length;
  if (H.nativeStats.wordsAsked || H.nativeStats.pageSeedDerivations || H.nativeStats.tooFarAhead) failures++;
  console.log(failures ? failures + ' FAILED' : 'all steps OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log('[array-cap] FAIL  run — ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
  process.exit(1);
});
