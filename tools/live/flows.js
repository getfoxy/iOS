'use strict';
/* flows.js — Foxy's money paths end to end against each local mint.
 *
 *   sh tools/live/local-mint.sh up
 *   sh tools/live/pending-mint.sh up        # for Nutshell's pending melt
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/flows.js [cdk|nutshell|all]
 *
 * Steps, each OK/FAIL, exit 1 on any FAIL:
 *  1. mint with a NUT-20 signed quote: the quote carries Foxy's key at the mint,
 *     an unsigned claim is refused, Foxy's signed claim gets the ecash
 *  2. swap with the 100 ppk input fee: a token, fees accounted to the sat
 *  3. receive the token back (fee taken), a second receive refused
 *  4. pay invoices from the same mint and from the other mint: fee reserve, change
 *  5. a melt that stays PENDING: CDK's fake wallet reads the outcome from the
 *     invoice description (an invoice from the Nutshell mint with a JSON memo);
 *     Nutshell's needs a mint configured for it (pending-mint.sh)
 *  6. import a backup (importProofs): a token, a legacy JSON backup, a repeat
 *     refused, a token with a broken DLEQ refused
 *  7. restore from the words in a fresh wallet; balances compared */
const H = require('./harness');

const which = process.argv[2] || 'all';
const keys = which === 'all' ? ['cdk', 'nutshell'] : [which];
const PENDING_NUTSHELL = process.env.FOXY_PENDING_MINT || 'https://127.0.0.1:8445';
setTimeout(() => { console.log('WATCHDOG 900s'); process.exit(2); }, 900000).unref();

const getJson = async (u, body) => (await fetch(u, body ? {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)).json();

async function wallet(url, fund) {
  const b = H.boot({ keychain: { words: '' } });
  await b.W.seedReady();
  await b.W.connect(url);
  if (fund) await H.mintAndClaim(b.W, fund);
  return b;
}

async function run(key) {
  const M = H.MINTS[key];
  const O = H.MINTS[H.other(key)];
  const R = H.reporter('flows ' + key);
  await H.mintNames([key]);        // the version that answers, not the image tag
  R.log('=== ' + M.name + ' at ' + M.https);
  const ks = await getJson(M.http + '/v1/keysets');
  const ppk = (ks.keysets.find((k) => k.active && k.unit === 'sat') || {}).input_fee_ppk;
  R.check('mint charges input fees', ppk === 100, 'input_fee_ppk ' + ppk);

  const A = await wallet(M.https);
  const W = A.W;
  const tokens = [];

  await R.step('1. mint with a NUT-20 signed quote', async () => {
    const inv = await W.invoice(500, '');
    const stored = JSON.parse(A.w.localStorage.getItem('foxy.cashu.quotes') || '[]').find((q) => q.quote === inv.hash);
    if (!stored || !stored.pubkey || !stored.privkey) throw new Error('quote stored without a NUT-20 key');
    let q = await getJson(M.http + '/v1/mint/quote/bolt11/' + inv.hash);
    if (q.pubkey !== stored.pubkey) throw new Error('the mint\'s quote has pubkey ' + q.pubkey + ', Foxy stored ' + stored.pubkey);
    await H.waitFor(async () => (q = await getJson(M.http + '/v1/mint/quote/bolt11/' + inv.hash)).state === 'PAID', 30000);
    if (q.state !== 'PAID') throw new Error('fake wallet did not pay: ' + q.state);
    // anyone else, without the key: must be refused
    const raw = new A.w.CashuTS.Wallet(M.https);
    await raw.loadMint();
    let refused = null;
    try { await raw.mintProofsBolt11(500, inv.hash); } catch (e) { refused = e; }
    if (!refused) throw new Error('the mint issued a locked quote to an unsigned request');
    const got = await W.claim(inv.hash);
    if (got !== 500) throw new Error('claimed ' + got);
    return 'quote locked to ' + stored.pubkey.slice(0, 16) + '…; unsigned claim refused (' + (refused.code || '') + ' ' +
      String(refused.message).slice(0, 70) + '); signed claim got ' + got;
  });

  await R.step('2. swap with input fees (a 100-sat token)', async () => {
    const before = await W.balanceSats();
    const nBefore = H.pile(A.w).length;
    const t = await W.sendToken(100);
    tokens.push(t);
    const after = await W.balanceSats();
    const nTok = W.tokenInfo(t.token).proofs.length;
    const swapFee = before - after - t.sats;
    if (t.sats !== 100 + H.feeFor(nTok, ppk)) throw new Error('token ' + t.sats + ' sat in ' + nTok + ' proofs: expected 100 + receiver fee ' + H.feeFor(nTok, ppk));
    if (!(swapFee >= 1 && swapFee <= H.feeFor(nBefore, ppk))) throw new Error('swap cost ' + swapFee + ' with ' + nBefore + ' proofs held');
    return before + ' -> ' + after + ': token ' + t.sats + ' (100 + ' + H.feeFor(nTok, ppk) + ' for its ' + nTok + ' proofs), swap fee ' + swapFee;
  });

  await R.step('3. receive the token back', async () => {
    const t = tokens.pop();
    const n = W.tokenInfo(t.token).proofs.length;
    const before = await W.balanceSats();
    const r = await W.receiveToken(t.token);
    const after = await W.balanceSats();
    if (r.sats !== t.sats - H.feeFor(n, ppk) || after - before !== r.sats) {
      throw new Error('received ' + r.sats + ' of ' + t.sats + ' (' + n + ' proofs), balance +' + (after - before));
    }
    let again = null;
    try { await W.receiveToken(t.token); } catch (e) { again = e; }
    if (!again) throw new Error('the same token was received twice');
    return 'got ' + r.sats + ' of ' + t.sats + ' (fee ' + H.feeFor(n, ppk) + '); second receive refused: ' + String(again.message).slice(0, 60);
  });

  async function payStep(label, bolt, amount) {
    await R.step(label, async () => {
      const mq = await getJson(M.http + '/v1/melt/quote/bolt11', { request: bolt, unit: 'sat' });
      const before = await W.balanceSats();
      const n = H.pile(A.w).length;
      const r = await W.pay(bolt);
      const after = await W.balanceSats();
      const drop = before - after;
      if (r.pending) throw new Error('left pending');
      if (W.pendingMelts().length) throw new Error('a melt is still held');
      /* Foxy's feeSats is everything the payment cost beyond its amount (meltFee,
       * 3bcdee6): the Lightning fee plus the input fees of the split's swap and
       * the melt's own inputs. This step used to read it as the Lightning fee
       * alone and fail it for being above the reserve. So: the balance fell by
       * exactly amount + feeSats, and feeSats is at most the reserve plus both
       * input fees. */
      const maxInputFees = 2 * H.feeFor(n, ppk);
      if (drop !== amount + r.feeSats) {
        throw new Error('balance fell ' + drop + ' for ' + amount + ' + fee ' + r.feeSats);
      }
      if (r.feeSats > Number(mq.fee_reserve) + maxInputFees) {
        throw new Error('fee ' + r.feeSats + ' above the reserve ' + mq.fee_reserve + ' plus input fees of at most ' + maxInputFees);
      }
      return 'fee reserve ' + mq.fee_reserve + ', fee ' + r.feeSats + ' (Lightning and input fees); balance ' + before + ' -> ' + after;
    });
  }
  await payStep('4a. pay an invoice from the same mint', await H.rawInvoice(M.http, 21), 21);
  await payStep('4b. pay an invoice from the other mint (fee reserve, change)', await H.rawInvoice(O.http, 100), 100);

  await R.step('5. a melt that stays PENDING', async () => {
    let url, bolt;
    if (key === 'cdk') {
      url = M.https;
      bolt = await H.rawInvoice(O.http, 20, H.CDK_PENDING);
    } else {
      try { await fetch(PENDING_NUTSHELL + '/v1/info'); } catch (e) {
        throw new Error('no pending-mode Nutshell at ' + PENDING_NUTSHELL + ' (sh tools/live/pending-mint.sh up)');
      }
      url = PENDING_NUTSHELL;
      bolt = await H.rawInvoice(H.MINTS.cdk.http, 20);
    }
    const P = await wallet(url, 100);
    const before = await P.W.balanceSats();
    let r, err;
    try { r = await P.W.pay(bolt); } catch (e) { err = e; }
    const held = P.W.pendingMelts();
    const after = await P.W.balanceSats();
    if (err && !err.pending) throw new Error('pay failed outright: ' + err.message);
    if (!err && !(r && r.pending)) throw new Error('reported as paid: ' + JSON.stringify(r));
    if (held.length !== 1) throw new Error(held.length + ' melts held');
    const heldSats = held[0].proofs.reduce((a, p) => a + Number(p.amount), 0);
    const splitFee = before - after - heldSats;   // the split's swap, not part of the hold
    if (splitFee < 0 || splitFee > 2) throw new Error('balance fell ' + (before - after) + ', held ' + heldSats);
    const settled = await P.W.sweepMelts();
    const stillHeld = P.W.pendingMelts().length;
    if (settled.length || stillHeld !== 1) throw new Error('the sweep settled a pending melt: ' + JSON.stringify(settled));
    return (err ? 'pay said: ' + err.message.slice(0, 50) : 'pay returned pending') + '; ' + heldSats +
      ' sat held, sweep leaves it held; ' + P.rec.log.filter((l) => /held melt/.test(l)).slice(-1)[0];
  });

  const B = await wallet(M.https);
  await R.step('6. import a backup (importProofs)', async () => {
    const t1 = await W.sendToken(50);
    const n1 = W.tokenInfo(t1.token).proofs.length;
    const got1 = await B.W.importProofs(t1.token);
    if (got1 !== t1.sats - H.feeFor(n1, ppk)) throw new Error('token import got ' + got1 + ' of ' + t1.sats);
    let again = null;
    try { await B.W.importProofs(t1.token); } catch (e) { again = e; }
    const againOk = again ? /spent/i.test(again.message) : false;
    const t2 = await W.sendToken(30);
    const info = W.tokenInfo(t2.token);
    const legacy = JSON.stringify({ mint: M.https, proofs: info.proofs });
    const got2 = await B.W.importProofs(legacy);
    if (got2 !== t2.sats - H.feeFor(info.proofs.length, ppk)) throw new Error('JSON import got ' + got2 + ' of ' + t2.sats);
    // a broken DLEQ, if the token carries DLEQs
    const t3 = await W.sendToken(10);
    tokens.push(t3);
    const d = { proofs: W.tokenInfo(t3.token).proofs };
    let dleqNote = 'token carries no DLEQ';
    if (d.proofs[0] && d.proofs[0].dleq) {
      const bad = JSON.parse(JSON.stringify(d.proofs, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
      const e = bad[0].dleq.e;
      bad[0].dleq.e = e.slice(0, -1) + (e.slice(-1) === '0' ? '1' : '0');
      let refused = null;
      try { await B.W.importProofs(JSON.stringify({ mint: M.https, proofs: bad })); } catch (x) { refused = x; }
      if (!refused || !/signatures do not match/i.test(refused.message)) throw new Error('broken DLEQ not refused: ' + (refused && refused.message));
      dleqNote = 'broken DLEQ refused before the mint was asked';
    }
    if (!againOk) throw new Error('a repeat import was not refused as spent: ' + (again && again.message));
    return 'token ' + t1.sats + ' -> ' + got1 + ', JSON backup ' + t2.sats + ' -> ' + got2 + ', repeat refused, ' + dleqNote;
  });

  await R.step('7. restore from the words in a fresh wallet', async () => {
    const out = [];
    for (const [label, X, outstanding] of [['A', A, tokens.reduce((a, t) => a + t.sats, 0)], ['B', B, 0]]) {
      const bal = await X.W.balanceSats();
      const F = H.boot({ keychain: { words: '' } });
      await F.W.seedReady();
      // typed on the phone and adopted by candidate (harness.js)
      const { rows, adopt } = await H.restoreWords(F, X.keychain.words, [M.https]);
      await adopt();
      await F.W.connect(M.https);
      const restored = await F.W.balanceSats();
      if (rows[0].sats !== bal + outstanding || restored !== rows[0].sats) {
        throw new Error('wallet ' + label + ': balance ' + bal + ' + outstanding ' + outstanding + ', scan ' + rows[0].sats + ', adopted ' + restored);
      }
      const t = await F.W.sendToken(5);
      await F.W.receiveToken(t.token);
      out.push(label + ' ' + bal + (outstanding ? ' + ' + outstanding + ' outstanding' : '') + ' = restored ' + restored);
    }
    return out.join('; ') + '; restored wallets spend';
  });
  return R.failed();
}

(async () => {
  let failures = 0;
  for (const key of keys) {
    try { failures += (await run(key)).length; } catch (e) {
      failures++;
      console.log('[flows ' + key + '] FAIL  run — ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
    }
  }
  console.log(H.phoneReport());
  if (H.nativeStats.wordsAsked || H.nativeStats.pageSeedDerivations || H.nativeStats.tooFarAhead) failures++;
  console.log(failures ? failures + ' FAILED' : 'all steps OK');
  process.exit(failures ? 1 : 0);
})();
