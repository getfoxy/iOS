'use strict';
/* faults.js — Foxy against a mint whose answers go wrong, checked against MONEY.md.
 *
 *   sh tools/live/local-mint.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/faults.js [cdk|nutshell|all]        # FOXY_FAULTS_SLOW=0 skips the >60s cases
 *
 * `onchain` is a run of its own and needs no Docker mint: it points the proxy
 * at a mint that speaks NUT-30 with fake money (testnut.cashu.space by
 * default, any fake-money mint as the second argument) and runs section (f)
 * alone. FOXY_LIVE_LOCAL=1 is still wanted there, because what the wallet
 * dials is the proxy on 127.0.0.1; the mint itself is checked by fakeMoneyOnly.
 *
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/faults.js onchain [https://mint]
 *
 * Each mint gets its own fault-proxy.js in this process (CDK 8453 -> 3338,
 * Nutshell 8454 -> 3339); `all` runs both mints at once in child processes.
 *  (a)  a token send's swap answer dropped after the mint processed it: its
 *       outputs back at once from the recorded ranges; (a2) a claim's, recovered
 *       once the quote reads ISSUED; (a3) a received token's, at once or by
 *       recoverSwaps when the restore fails first; (a4) a payment's split:
 *       outputs back, spent inputs out, no melt sent, and paying again works
 *  (b)  a melt's answer dropped after the mint paid: settled at once from the
 *       quote state, or held and settled by sweepMelts, change from counters
 *  (c)  500s and dropped connections on the mint-quote check
 *  (d)  a DLEQ `e`/`s` changed in a mint (claim) and a swap answer
 *  (e)  slow answers around Foxy's 20/30/65/90 s ceilings
 *  (f)  on chain (NUT-30): a payout's answer lost after and before the mint
 *       acted, 500s on the payout's state check, slow answers, a state Foxy
 *       cannot read, and an address quote's answer lost */
const path = require('path');
const { spawn } = require('child_process');
const H = require('./harness');
const { createFaultProxy, flipDleq } = require('./fault-proxy');

const which = process.argv[2] || 'all';
const SLOW = process.env.FOXY_FAULTS_SLOW !== '0';
const PORTS = { cdk: 8453, nutshell: 8454, onchain: 8455 };

/* The on-chain run stands apart: the mint is somewhere else (the local Docker
 * mints were brought up for the Lightning paths), so the proxy goes remote and
 * the mint is named rather than looked up in H.MINTS. */
const ONCHAIN = which === 'onchain';
const ONCHAIN_MINT = ONCHAIN ? String(process.argv[3] || 'https://testnut.cashu.space').replace(/\/+$/, '') : '';
if (ONCHAIN) H.fakeMoneyOnly(ONCHAIN_MINT);

if (which === 'all') {
  let left = 2, code = 0;
  for (const k of ['cdk', 'nutshell']) {
    const c = spawn(process.execPath, [__filename, k], { stdio: 'inherit', env: process.env });
    c.on('exit', (x) => { code = code || x; if (--left === 0) process.exit(code); });
  }
  return;
}

setTimeout(() => { console.log('WATCHDOG 1500s'); process.exit(2); }, 1500000).unref();
const M = ONCHAIN ? { name: 'the mint at ' + ONCHAIN_MINT, http: ONCHAIN_MINT } : H.MINTS[which];
const O = ONCHAIN ? null : H.MINTS[H.other(which)];
const R = H.reporter('faults ' + which);
const swapPath = '/v1/swap';
const quoteCheck = /^\/v1\/mint\/quote\/bolt11\/[^/]+$/;
const meltCheck = /^\/v1\/melt\/quote\/bolt11\/[^/]+$/;
const maxDelta = (a, b) => Math.max(0, ...Object.keys(b).map((k) => (b[k] || 0) - (a[k] || 0)));

let proxy, URL_;

async function fresh(fund) {
  const b = H.boot({ keychain: { words: '' } });
  await b.W.seedReady();
  await b.W.connect(URL_);
  if (fund) await H.mintAndClaim(b.W, fund);
  return b;
}
/* A restore of `words` in a wallet that never saw them: typed on another phone. */
async function scan(words) {
  const rows = await H.scanFresh(words, [URL_]);
  return rows[0] || {};
}
/* The new-mint sweep's path: this wallet's own seed scanned with no words, adopted with overwrite. */
async function restoreInPlace(b) {
  const rows = await b.W.scanSeed(null, [URL_]);
  await b.W.adoptScan(rows, { overwrite: true });
  return rows[0].sats;
}
const ONLY = (process.env.FOXY_FAULTS_ONLY || '').split(',').filter(Boolean);   // e.g. a2,d1
async function section(title, fn) {
  if (ONLY.length && !ONLY.some((k) => title.startsWith('(' + k + ')'))) return;
  R.log('--- ' + title);
  proxy.clear();
  proxy.log.length = 0;   // counts below are per section
  try { await fn(); } catch (e) { R.fail(title, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
  proxy.clear();
}

async function main() {
  proxy = createFaultProxy({
    listen: PORTS[which],
    // a mint on this Mac is a port, as it always was; the on-chain run names its own
    target: ONCHAIN ? ONCHAIN_MINT : new URL(M.http).port,
    certDir: path.join(H.ROOT, 'build', 'live-tls'),
  });
  await proxy.ready;
  URL_ = proxy.url;
  // the version that answers, not the image tag; the on-chain run names its mint itself
  if (!ONCHAIN) await H.mintNames([which]);
  R.log('=== ' + M.name + ' through ' + URL_);

  if (ONCHAIN) { await onchain(); return finish(); }

  await section('(a) swap answer dropped after the mint processed it', async () => {
    const b = await fresh(200);
    const { w, W } = b;
    const c0 = H.counters(b);
    const s0 = proxy.count('POST', swapPath);
    proxy.add({ method: 'POST', path: swapPath, action: 'drop-after' });
    let err = null;
    try { await W.sendToken(20); } catch (e) { err = e; }
    const last = proxy.last('POST', swapPath);
    /* The lost swap's outputs come back at once from the ranges it recorded
     * (swapGuard), matched against what the swap took. They used to come back
     * only from a seed restore, after reconcile had removed the spent inputs. */
    R.check('a: sendToken fails when the answer is lost, and says the ecash was restored', !!err && /restored/.test(err.message), err && err.message);
    R.check('a: the mint had processed the swap', last && last.upstream === 200, 'upstream ' + (last && last.upstream));
    R.check('a: one swap request, no blind retry', proxy.count('POST', swapPath) - s0 === 1, (proxy.count('POST', swapPath) - s0) + ' requests');
    const moved = maxDelta(c0, H.counters(b));
    R.check('a: counters reserved before the request went out', moved > 0, 'counters moved ' + moved);
    const cAfterDrop = H.counters(b);
    const balAtOnce = await W.balanceSats();
    const atOnce = await scan(b.keychain.words);
    const swapsLeft = JSON.parse(w.localStorage.getItem('foxy.cashu.swaps') || '[]');
    R.check('a: the outputs are back at once from the recorded ranges (balance = restore, no swap record left)',
      atOnce.sats === balAtOnce && balAtOnce >= 190 && !swapsLeft.length,
      'balance ' + balAtOnce + ', restore ' + atOnce.sats + ', swap records ' + swapsLeft.length + '; ' +
      (b.rec.log.filter((l) => /lost send swap/.test(l))[0] || 'no swap restore logged'));

    let next = null;
    try { next = await W.sendToken(20); } catch (e) { next = { error: e }; }
    R.check('a: the next token is made from the restored pile', !next.error, next.error ? next.error.message.slice(0, 80) : next.sats + ' sat');
    const outstanding = next.error ? 0 : next.sats;
    await W.reconcile();
    const afterReconcile = await W.balanceSats();
    const found = await scan(b.keychain.words);
    R.check('a: restore finds the balance and the unclaimed token, nothing more', found.sats === afterReconcile + outstanding,
      'after reconcile ' + afterReconcile + ' held locally, token ' + outstanding + ', restore finds ' + found.sats);
    /* A sent token still on file is spoken for: adopting the restore leaves its
     * proofs out (spokenForSecrets). Before, it took them back
     * into the balance while the token was still out there to be claimed. */
    const adopted = await restoreInPlace(b);
    R.check('a: adopting the restore leaves the unclaimed token out (balance = restore - token)', (await W.balanceSats()) === adopted - outstanding,
      'balance ' + (await W.balanceSats()) + ', restore ' + adopted + ', outstanding ' + outstanding);

    // the phone's counters put back behind the dropped swap's outputs: the next swap meets used outputs
    H.setCounters(b, c0);
    const warn0 = b.rec.warn.length;
    let t = null;
    try { t = await W.sendToken(10); } catch (e) { t = { error: e }; }
    const skips = b.rec.warn.slice(warn0).map((l) => (/moving the counters on by (\d+)/.exec(l) || [])[1]).filter(Boolean);
    R.check('a: with counters behind them, the next swap meets used outputs and recovers', !t.error && skips.length > 0,
      (t.error ? 'FAILED: ' + t.error.message : 'token ' + t.sats) + '; skips ' + (skips.join(',') || 'none') + '; mint said ' +
      (b.rec.mintSaid.slice(-1)[0] || '').slice(0, 90) + '; counters were ' + JSON.stringify(cAfterDrop));
    const bal = await W.balanceSats();
    const tokenSats = t.error ? 0 : t.sats;
    const final = await scan(b.keychain.words);
    R.check('a: final restore = balance + both outstanding tokens', final.sats === bal + tokenSats + outstanding,
      final.sats + ' vs ' + bal + ' + ' + tokenSats + ' + ' + outstanding);
  });

  await section('(a2) claim answer dropped after the mint issued', async () => {
    const b = await fresh(0);
    const { W } = b;
    // the answer that carries the signatures: at CDK the first signed claim is refused (20008) and retried
    proxy.add({ method: 'POST', path: '/v1/mint/bolt11', action: 'drop-after', when: 200 });
    const inv = await W.invoice(50, '');
    const errs = [];
    let paid = null;
    const stop = W.watch(inv.hash, (r) => { paid = r; }, { pollMs: 1000, onError: (e) => errs.push(e.message) });
    await H.waitFor(() => paid, 30000);
    await H.sleep(3000);
    stop();
    const claims = proxy.log.filter((e) => e.method === 'POST' && e.path === '/v1/mint/bolt11');
    const dropped = claims.find((e) => e.action === 'drop-after');
    const afterDrop = claims.slice(claims.indexOf(dropped) + 1);
    R.check('a2: mint issued, answer lost', dropped && dropped.upstream === 200, claims.map((e) => e.action + ' ' + e.upstream).join(', '));
    /* A lost claim answer is recovered from the ranges the claim recorded on
     * the invoice (recoverIssued), once the quote reads ISSUED. It used to be
     * dropped as "already claimed", and only a seed restore found the sats. */
    R.check('a2: the watch recovers the claim from its recorded ranges once the quote reads ISSUED; no second claim gets ecash',
      paid && paid.recovered && paid.sats === 50 && afterDrop.every((e) => e.upstream !== 200),
      'paid ' + JSON.stringify(paid) + '; after the drop: ' + (afterDrop.map((e) => e.upstream + ' ' + e.upstreamBody.slice(0, 60)).join(' | ') || 'no requests') +
      '; watch errors: ' + errs.map((e) => e.slice(0, 40)).join(' | '));
    R.log('a2: mint said ' + JSON.stringify(b.rec.mintSaid.map((m) => m.slice(0, 120))) + '; Foxy logged ' +
      JSON.stringify(b.rec.log.concat(b.rec.warn).filter((l) => /claim|counters|issued/.test(l)).map((l) => l.slice(0, 140))));
    R.check('a2: balance 50, nothing stuck, the invoice record gone', (await W.balanceSats()) === 50 && W.stuckInvoices().length === 0 && W.pendingQuotes().length === 0,
      'balance ' + (await W.balanceSats()) + ', stuck ' + W.stuckInvoices().length + ', quotes on file ' + W.pendingQuotes().length);
    await W.sweepQuotes();
    const found = await scan(b.keychain.words);
    R.check('a2: a sweep adds nothing more, and restore = balance', found.sats === 50 && (await W.balanceSats()) === 50,
      'balance ' + (await W.balanceSats()) + ', restore ' + found.sats);
    const log = JSON.parse(b.w.localStorage.getItem('foxy.cashu.log') || '[]').filter((e) => e.hash === inv.hash);
    R.check('a2: one history entry for the invoice', log.length === 1 && log[0].sats === 50, JSON.stringify(log));
  });

  /* A received token's swap answer lost: the outputs come back at once from
   * the ranges swapGuard recorded, matched against the token less its fee.
   * Then the same with the restore unreachable at first: the record stays and
   * recoverSwaps settles it on the next pass, once. */
  await section('(a3) receive swap answer dropped after the mint processed it', async () => {
    const sender = await fresh(100);
    const b = await fresh(0);
    const { w, W } = b;
    const swapsOf = () => JSON.parse(w.localStorage.getItem('foxy.cashu.swaps') || '[]');
    const t1 = await sender.W.sendToken(20);
    proxy.add({ method: 'POST', path: swapPath, action: 'drop-after' });
    const s0 = proxy.count('POST', swapPath);
    let r = null, err = null;
    try { r = await W.receiveToken(t1.token); } catch (e) { err = e; }
    const last = proxy.last('POST', swapPath);
    R.check('a3: the mint processed the receive swap and the answer was lost', last && last.action === 'drop-after' && last.upstream === 200,
      'upstream ' + (last && last.upstream) + ' ' + (last && last.action));
    R.check('a3: one swap request, no blind retry', proxy.count('POST', swapPath) - s0 === 1, (proxy.count('POST', swapPath) - s0) + ' requests');
    const bal = await W.balanceSats();
    R.check('a3: receiveToken resolves with the token less its fee, from the recorded ranges', r && r.sats > 0 && t1.sats - r.sats >= 0 &&
      t1.sats - r.sats <= 2 && bal === r.sats && !swapsOf().length,
      (err ? 'threw ' + err.message.slice(0, 80) : JSON.stringify(r)) + '; token ' + t1.sats + ', balance ' + bal + ', swap records ' + swapsOf().length +
      '; ' + (b.rec.log.concat(b.rec.warn).filter((l) => /lost receive swap/.test(l))[0] || 'no swap restore logged'));
    const found = await scan(b.keychain.words);
    R.check('a3: restore = balance', found.sats === bal, 'balance ' + bal + ', restore ' + found.sats);
    const ins = JSON.parse(w.localStorage.getItem('foxy.cashu.log') || '[]').filter((e) => e.dir === 'in' && /^token-/.test(e.hash));
    R.check('a3: one history entry', ins.length === 1 && ins[0].sats === bal, JSON.stringify(ins));
    let again = null;
    try { await W.receiveToken(t1.token); } catch (e) { again = e; }
    await W.recoverSwaps();
    R.check('a3: the same token again is refused, and a later recoverSwaps adds nothing', again && (await W.balanceSats()) === bal,
      (again ? again.message.slice(0, 80) : 'accepted twice') + '; balance ' + (await W.balanceSats()));

    const t2 = await sender.W.sendToken(10);
    proxy.add({ method: 'POST', path: swapPath, action: 'drop-after' });
    proxy.add({ method: 'POST', path: '/v1/restore', action: 'status', status: 500, times: -1 });
    let err2 = null;
    try { await W.receiveToken(t2.token); } catch (e) { err2 = e; }
    const kept = swapsOf();
    R.check('a3b: with the restore unreachable, the receive fails and its record stays, with the amount to check',
      err2 && kept.length === 1 && kept[0].kind === 'receive' && kept[0].expect > 0 && (await W.balanceSats()) === bal,
      (err2 ? err2.message.slice(0, 70) : 'no error') + '; records ' + JSON.stringify(kept.map((k) => ({ kind: k.kind, expect: k.expect, outputs: k.outputs }))));
    proxy.clear();
    const got = await W.recoverSwaps();
    const bal2 = await W.balanceSats();
    const found2 = await scan(b.keychain.words);
    R.check('a3b: recoverSwaps settles it: balance = restore, record gone', got.length === 1 && bal2 > bal && bal2 === found2.sats && !swapsOf().length,
      JSON.stringify(got) + '; balance ' + bal2 + ', restore ' + found2.sats + ', records ' + swapsOf().length);
    const again2 = await W.recoverSwaps();
    R.check('a3b: a second pass adds nothing', !again2.length && (await W.balanceSats()) === bal2, JSON.stringify(again2));
  });

  /* A payment's split answer lost: the split's outputs come back at once,
   * matched against the inputs the mint now calls SPENT less their fee, the
   * spent inputs leave the pile, no melt is sent, and paying again works. */
  await section('(a4) a payment\'s split answer dropped after the mint processed it', async () => {
    const { b, bolt } = await meltFixture();
    const { w, W } = b;
    const before = await W.balanceSats();
    proxy.add({ method: 'POST', path: swapPath, action: 'drop-after' });
    let r = null, err = null;
    try { r = await W.pay(bolt); } catch (e) { err = e; }
    const last = proxy.last('POST', swapPath);
    R.check('a4: the mint processed the split and the answer was lost', last && last.action === 'drop-after' && last.upstream === 200,
      'upstream ' + (last && last.upstream) + ' ' + (last && last.action));
    R.check('a4: pay fails, saying the ecash was restored and nothing was sent', !r && err && /restored/.test(err.message),
      err ? err.message.slice(0, 100) : JSON.stringify(r));
    R.check('a4: no melt request, nothing held', proxy.count('POST', '/v1/melt/bolt11') === 0 && W.pendingMelts().length === 0,
      proxy.count('POST', '/v1/melt/bolt11') + ' melts, ' + W.pendingMelts().length + ' held');
    const bal = await W.balanceSats();
    const found = await scan(b.keychain.words);
    const swaps = JSON.parse(w.localStorage.getItem('foxy.cashu.swaps') || '[]');
    R.check('a4: the split\'s outputs are back and its inputs gone: balance = restore, less only the split fee', found.sats === bal &&
      before - bal >= 0 && before - bal <= 2 && !swaps.length,
      'before ' + before + ', balance ' + bal + ', restore ' + found.sats + ', records ' + swaps.length + '; ' +
      (b.rec.log.concat(b.rec.warn).filter((l) => /lost split swap/.test(l))[0] || 'no swap restore logged'));
    let paid = null;
    err = null;
    try { paid = await W.pay(bolt); } catch (e) { err = e; }
    const bal2 = await W.balanceSats();
    const found2 = await scan(b.keychain.words);
    R.check('a4: paying the same invoice again goes through (balance = restore)', paid && !paid.pending && found2.sats === bal2 && bal - bal2 >= 50,
      (err ? 'threw ' + err.message.slice(0, 80) : JSON.stringify(paid)) + '; balance ' + bal + ' -> ' + bal2 + ', restore ' + found2.sats);
  });

  async function meltFixture() {
    const b = await fresh(300);
    const bolt = await H.rawInvoice(O.http, 50);
    const mq = await (await fetch(M.http + '/v1/melt/quote/bolt11', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: bolt, unit: 'sat' }) })).json();
    return { b, bolt, reserve: Number(mq.fee_reserve) };
  }

  await section('(b1) melt answer dropped, mint paid; settled from the quote state', async () => {
    const { b, bolt, reserve } = await meltFixture();
    const { W } = b;
    proxy.add({ method: 'POST', path: '/v1/melt/bolt11', action: 'drop-after' });
    let r = null, err = null;
    try { r = await W.pay(bolt); } catch (e) { err = e; }
    const m = proxy.last('POST', '/v1/melt/bolt11');
    R.check('b1: the mint paid', m && m.upstream === 200 && /"PAID"/.test(m.upstreamBody), 'upstream ' + (m && m.upstream) + ' ' + (m && m.upstreamBody.slice(0, 80)));
    R.check('b1: pay resolves as paid, nothing held', r && !r.pending && W.pendingMelts().length === 0,
      err ? 'threw: ' + err.message : JSON.stringify(r));
    const changeLog = b.rec.log.filter((l) => /melt change: restored/.test(l));
    const bal = await W.balanceSats();
    const found = await scan(b.keychain.words);
    R.check('b1: change recovered from the counters (balance = restore)', found.sats === bal,
      'fee reserve ' + reserve + ', fee ' + (r && r.feeSats) + ', ' + (changeLog[0] || 'no change restore logged') + '; balance ' + bal + ', restore ' + found.sats);
  });

  async function heldThenSwept(tag, checkRule) {
    const { b, bolt, reserve } = await meltFixture();
    const { W } = b;
    proxy.add({ method: 'POST', path: '/v1/melt/bolt11', action: 'drop-after' });
    proxy.add({ method: 'GET', path: meltCheck, ...checkRule, times: 1 });
    const before = await W.balanceSats();
    let r = null, err = null;
    try { r = await W.pay(bolt); } catch (e) { err = e; }
    const held = W.pendingMelts();
    const heldSats = held.reduce((a, h) => a + h.proofs.reduce((x, p) => x + Number(p.amount), 0), 0);
    R.check(tag + ': held as pending', ((err && err.pending) || (r && r.pending)) && held.length === 1,
      (err ? 'pay threw: ' + err.message.slice(0, 70) : 'pay returned ' + JSON.stringify(r)) + '; held ' + held.length + ' (' + heldSats + ' sat)');
    const fell = before - (await W.balanceSats());
    R.check(tag + ': balance excludes only the held proofs (and the split\'s swap fee)', fell >= heldSats && fell - heldSats <= 2,
      before + ' -> ' + (await W.balanceSats()) + ', held ' + heldSats + ', split fee ' + (fell - heldSats));
    proxy.clear();
    const settled = await W.sweepMelts();
    const bal = await W.balanceSats();
    const found = await scan(b.keychain.words);
    const changeLog = b.rec.log.filter((l) => /melt change: restored/.test(l));
    R.check(tag + ': sweepMelts settles it PAID', settled.length === 1 && settled[0].paid && W.pendingMelts().length === 0, JSON.stringify(settled));
    R.check(tag + ': change recovered by recoverMeltChange (balance = restore)', found.sats === bal,
      'fee reserve ' + reserve + '; ' + (changeLog[0] || 'no change restore logged') + '; balance ' + bal + ', restore ' + found.sats);
  }
  await section('(b2) melt answer dropped and the state check fails; sweep settles', () =>
    heldThenSwept('b2', { action: 'status', status: 500 }));

  await section('(c) 500s and dropped connections on the mint-quote check', async () => {
    const b = await fresh(0);
    const { W, rec } = b;
    proxy.add({ method: 'GET', path: quoteCheck, action: 'status', status: 500, times: 6 });
    proxy.add({ method: 'GET', path: quoteCheck, action: 'drop-before', times: 4 });
    const inv = await W.invoice(30, '');
    let claimed = null;
    const errs = [];
    const stop = W.watch(inv.hash, (r) => { claimed = r.sats; }, { pollMs: 1000, onError: (e) => errs.push(e.message) });
    await H.sleep(3000);
    await W.sweepQuotes();
    await H.sleep(2000);
    R.check('c: no "paid, not collected" while the check fails', W.stuckInvoices().length === 0 && rec.claimTrouble.length === 0,
      'stuck ' + W.stuckInvoices().length + ', onClaimTrouble ' + rec.claimTrouble.length);
    R.check('c: no claim attempted on a failed check', proxy.count('POST', '/v1/mint/bolt11') === 0 || claimed !== null,
      proxy.count('POST', '/v1/mint/bolt11') + ' claim requests during faults');
    await H.waitFor(() => claimed !== null, 45000);
    stop();
    const faulted = proxy.log.filter((e) => quoteCheck.test(e.path) && e.action !== 'pass').length;
    R.check('c: claimed once the check answers', claimed === 30 && errs.length === 0 && W.stuckInvoices().length === 0,
      faulted + ' checks faulted; claimed ' + claimed + '; watch errors ' + errs.length + '; stuck ' + W.stuckInvoices().length);
  });

  await section('(d1) broken DLEQ in the claim answer', async () => {
    const b = await fresh(0);
    const { W, rec } = b;
    proxy.add({ method: 'POST', path: '/v1/mint/bolt11', action: 'rewrite', rewrite: flipDleq('e'), times: -1 });
    const inv = await W.invoice(40, '');
    let err = null;
    const stop = W.watch(inv.hash, () => {}, { pollMs: 1000, onError: (e) => { err = err || e; } });
    await H.waitFor(() => err, 30000);
    stop();
    const hits = proxy.count('POST', '/v1/mint/bolt11');
    R.check('d1: cashu-ts refuses the signatures', err && /dleq/i.test(err.message) && proxy.last('POST', '/v1/mint/bolt11').rewritten,
      err ? err.message.slice(0, 80) : 'no error');
    const stuck = W.stuckInvoices();
    R.check('d1: stuckInvoices marks badSignatures', stuck.length === 1 && stuck[0].unclaimed.badSignatures === true, JSON.stringify(stuck.map((s) => s.unclaimed)));
    await W.sweepQuotes();
    let manual = null;
    try { await W.claim(inv.hash); } catch (e) { manual = e; }
    const stop2 = W.watch(inv.hash, () => {}, { pollMs: 1000, onError: () => {} });
    await H.sleep(5000);
    stop2();
    R.check('d1: never asked again (watch, sweep, manual claim)', proxy.count('POST', '/v1/mint/bolt11') === hits && manual,
      'claim requests ' + hits + ' until refused (' + proxy.log.filter((e) => e.path === '/v1/mint/bolt11').map((e) => e.upstream).join(',') +
      '), ' + proxy.count('POST', '/v1/mint/bolt11') + ' in all; manual claim: ' + (manual && manual.message.slice(0, 70)));
    const bad = rec.trouble.filter((t) => t.badSignatures);
    R.check('d1: reported once through onMintTrouble', bad.length === 1 && bad[0].where === 'claim', JSON.stringify(rec.trouble));
    const found = await scan(b.keychain.words);
    R.log('d1: balance ' + (await W.balanceSats()) + '; the mint did sign — a restore finds ' + found.sats + ' sat');
  });

  await section('(d2) broken DLEQ in a swap answer', async () => {
    const b = await fresh(100);
    const { W, rec } = b;
    proxy.add({ method: 'POST', path: swapPath, action: 'rewrite', rewrite: flipDleq('s') });
    const s0 = proxy.count('POST', swapPath);
    let err = null;
    try { await W.sendToken(10); } catch (e) { err = e; }
    R.check('d2: cashu-ts refuses the swap\'s signatures', err && /dleq/i.test(err.message), err ? err.message.slice(0, 80) : 'no error');
    R.check('d2: not retried', proxy.count('POST', swapPath) - s0 === 1, (proxy.count('POST', swapPath) - s0) + ' swap requests');
    const bad = rec.trouble.filter((t) => t.badSignatures);
    R.check('d2: reported once through onMintTrouble', bad.length === 1, JSON.stringify(rec.trouble));
    R.log('d2: stuckInvoices ' + W.stuckInvoices().length + ' (no invoice involved); balance ' + (await W.balanceSats()));
    await W.reconcile();
    const adopted = await restoreInPlace(b);
    R.check('d2: after reconcile and restore the balance matches the mint', (await W.balanceSats()) === adopted,
      'balance ' + (await W.balanceSats()) + ', restore ' + adopted);
  });

  await section('(e) slow answers', async () => {
    const { b, bolt } = await meltFixture();
    const { W } = b;
    proxy.add({ method: 'POST', path: '/v1/melt/quote/bolt11', action: 'delay-before', ms: 25000 });
    let r = null, err = null;
    const t0 = Date.now();
    try { r = await W.pay(bolt); } catch (e) { err = e; }
    R.check('e1: melt quote 25 s late (ceiling 30 s): the payment goes', r && !r.pending, (err ? err.message : JSON.stringify(r)) + ' in ' + Math.round((Date.now() - t0) / 1000) + 's');

    const bolt2 = await H.rawInvoice(O.http, 20);
    proxy.add({ method: 'POST', path: '/v1/melt/quote/bolt11', action: 'delay-before', ms: 35000 });
    const before = await W.balanceSats();
    err = null; r = null;
    try { r = await W.pay(bolt2); } catch (e) { err = e; }
    R.check('e2: melt quote 35 s late: refused cleanly, nothing held, balance unchanged',
      err && /did not answer within 30s/.test(err.message) && W.pendingMelts().length === 0 && (await W.balanceSats()) === before,
      err ? err.message : JSON.stringify(r));
    await H.sleep(6000);
    proxy.clear();

    await heldThenSwept('e3 (state check 25 s late, ceiling 20 s)', { action: 'delay-before', ms: 25000 });

    if (!SLOW) { R.skip('e4-e6', 'FOXY_FAULTS_SLOW=0'); return; }
    // the bridge's own ceiling: nativeRequest gives up after 65 s
    {
      const { b: c, bolt: bolt3 } = await meltFixture();
      proxy.add({ method: 'POST', path: '/v1/melt/bolt11', action: 'delay-after', ms: 70000 });
      err = null; r = null;
      const t1 = Date.now();
      try { r = await c.W.pay(bolt3); } catch (e) { err = e; }
      const bal = await c.W.balanceSats();
      const found = await scan(c.keychain.words);
      R.check('e4: melt answer 70 s late (bridge gives up at 65 s): settled from the quote state, change recovered',
        r && !r.pending && c.W.pendingMelts().length === 0 && found.sats === bal,
        (err ? 'threw ' + err.message.slice(0, 60) : JSON.stringify(r)) + ' after ' + Math.round((Date.now() - t1) / 1000) + 's; balance ' + bal + ', restore ' + found.sats);
    }
    proxy.clear();
    {
      const c = await fresh(100);
      proxy.add({ method: 'POST', path: swapPath, action: 'delay-after', ms: 70000 });
      err = null;
      try { await c.W.sendToken(10); } catch (e) { err = e; }
      await c.W.reconcile();
      const adopted = await restoreInPlace(c);
      R.check('e5: swap answer 70 s late: fails, and reconcile + restore bring the balance back', err && (await c.W.balanceSats()) === adopted,
        (err ? err.message.slice(0, 60) : 'no error') + '; balance ' + (await c.W.balanceSats()) + ', restore ' + adopted);
    }
    proxy.clear();
    {
      const c = await fresh(0);
      proxy.add({ method: 'GET', path: quoteCheck, action: 'hang', times: 1 });
      const inv = await c.W.invoice(25, '');
      let claimed = null;
      const stop = c.W.watch(inv.hash, (x) => { claimed = x.sats; }, { pollMs: 1000, onError: () => {} });
      await H.sleep(30000);
      const quiet = c.W.stuckInvoices().length === 0 && c.rec.claimTrouble.length === 0;
      await H.waitFor(() => claimed !== null, 60000);
      stop();
      R.check('e6: a quote check that hangs: no false alarm, claimed after the bridge gives up', quiet && claimed === 25,
        'stuck while hung: ' + (quiet ? 'none' : 'YES') + '; claimed ' + claimed);
    }
  });

  return finish();
}

/* (f) on chain (NUT-30).
 *
 * Every question here is the same one: where is the money now? On chain a
 * payout is not settled when the mint answers — the mint answers PENDING with
 * the transaction still to confirm — so the proofs handed over live on a
 * record of their own (K.onchainOut) until onchainFollow says what became of
 * them. That record is the only way back, and these are the incidents that
 * decide whether it does its job.
 *
 * The local Docker mints were brought up for the Lightning paths; a mint that
 * quotes and pays on chain with fake money is testnut.cashu.space, so the
 * proxy goes remote (fault-proxy.js) and this runs on its own. It is someone
 * else's machine: a handful of payments, no retry loops. */
async function onchain() {
  // a well-formed mainnet address (BIP-173's own example): a refusal here can
  // only ever be the mint's, never the address's
  const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const meltOut = '/v1/melt/onchain';
  const meltQuote = '/v1/melt/quote/onchain';
  const meltState = /^\/v1\/melt\/quote\/onchain\/[^/]+$/;
  const addrQuote = '/v1/mint/quote/onchain';
  const addrState = /^\/v1\/mint\/quote\/onchain\/[^/]+$/;

  const sats = (ps) => (ps || []).reduce((a, p) => a + Number(p.amount), 0);
  const outs = (w) => JSON.parse(w.localStorage.getItem('foxy.cashu.onchain.out') || '[]');
  const recOf = (w, q) => outs(w).filter((r) => r.quote === q)[0] || null;
  /* A payout no longer has a hold on any ecash: either the record is gone
   * (the mint never took it) or it stands at PAID with its proofs cleared,
   * which is how onchainFollow closes one off. */
  const letGo = (w, q) => {
    const r = recOf(w, q);
    return !r || (r.state === 'PAID' && !(r.proofs || []).length);
  };
  const entryOf = async (W, q) => (await W.transactions(20)).filter((t) => t.hash === 'onchain-' + q)[0] || null;
  /* Put a payout's clock back. UNPAID is not a verdict until the record is two
   * minutes old (W4, and the on-chain side too): a melt whose
   * answer never arrived may still be on its way, and the mint reads UNPAID
   * until it lands. Waiting two real minutes in a live suite is worse than
   * moving the stamp. */
  const age = (w, q, ms) => {
    const list = outs(w);
    list.forEach((r) => { if (r.quote === q) r.at = Date.now() - (ms || 130000); });
    w.localStorage.setItem('foxy.cashu.onchain.out', JSON.stringify(list));
  };
  /* How many of these proofs are back among the ones this wallet would spend.
   * A payout the mint may have made must leave none of them there. */
  const inPile = (w, ps) => {
    const have = new Set(H.pile(w).map((p) => p.secret));
    return (ps || []).filter((p) => have.has(p.secret)).length;
  };
  /* Ask the mint what became of a payout until it stops saying PENDING. Slow
   * on purpose: three seconds apart on a mint that is not ours. */
  const settledState = (W, q, ms) => H.waitFor(async () => {
    const a = await W.onchainFollow(q);
    return /^(PAID|FAILED|UNPAID)$/.test(a.state) ? a : null;
  }, ms || 120000, 3000);

  const limits = await (await fresh(0)).W.onchainLimits();
  if (!limits || !limits.send) {
    R.skip('(f) on chain', M.name + ' advertises no on-chain payouts: ' + JSON.stringify(limits));
    return;
  }
  R.log('(f) the mint on chain: ' + JSON.stringify(limits));
  const WANT = Math.max(Number(limits.send.min) || 0, 1000);
  const FUND = WANT + 1000;
  /* A wallet with sats and a payout quoted, ready to be interrupted. */
  async function payFixture() {
    const b = await fresh(FUND);
    const plan = await b.W.onchainQuote(ADDRESS, WANT);
    return { b, plan, pick: plan.options[0], funded: await b.W.balanceSats() };
  }

  await section('(f1) payout answer dropped after the mint acted', async () => {
    const { b, plan, pick, funded } = await payFixture();
    const { w, W } = b;
    proxy.add({ method: 'POST', path: meltOut, action: 'drop-after' });
    let err = null, out = null;
    try { out = await W.onchainPay(plan, pick.index); } catch (e) { err = e; }
    const m = proxy.last('POST', meltOut);
    R.check('f1: the mint took the ecash and the answer never arrived', m && m.upstream === 200 && /"(PENDING|PAID)"/.test(m.upstreamBody),
      'upstream ' + (m && m.upstream) + ' ' + (m && m.upstreamBody.slice(0, 80)));
    R.check('f1: onchainPay fails rather than claiming a payment it never heard confirmed', !out && !!err,
      err ? err.message.slice(0, 80) : JSON.stringify(out));
    R.check('f1: one melt request, no blind retry', proxy.count('POST', meltOut) === 1, proxy.count('POST', meltOut) + ' requests');

    /* The payout is real: the proofs are the mint's now. They must not be back
     * in the pile to be spent again, and the record must still hold them,
     * because onchainFollow's only way to hand them back is that copy. */
    const rec = recOf(w, plan.id);
    R.check('f1: the proofs are not back in the pile', rec && inPile(w, rec.proofs) === 0,
      rec ? inPile(w, rec.proofs) + ' of ' + rec.proofs.length + ' back' : 'no record at all');
    R.check('f1: the record still holds them, in a state it will not act on', rec && rec.state === 'UNKNOWN' && sats(rec.proofs) >= WANT + pick.fee,
      rec ? JSON.stringify({ state: rec.state, proofs: rec.proofs.length, sats: sats(rec.proofs), splitFee: rec.splitFee }) : 'no record');
    const bal = await W.balanceSats();
    const cost = funded - bal;
    const meltFee = rec ? sats(rec.proofs) - WANT - pick.fee : -1;
    R.check('f1: the balance fell by the payment, the quoted reserve and the mint’s input fees, and by nothing else',
      rec && cost === sats(rec.proofs) + rec.splitFee && meltFee >= 0 && meltFee <= 3,
      funded + ' - ' + bal + ' = ' + cost + ' for ' + WANT + ' + reserve ' + pick.fee +
      ' + melt input fee ' + meltFee + ' + split fee ' + (rec && rec.splitFee));

    proxy.clear();
    const end = await settledState(W, plan.id);
    R.check('f1: the mint confirms the payout it was never able to report', end && end.state === 'PAID', JSON.stringify(end));
    const after = await W.balanceSats();
    R.check('f1: settling it credits nothing and takes nothing more, and the hold is let go',
      after === bal && letGo(w, plan.id) && !W.onchainSending().some((r) => r.quote === plan.id),
      'balance ' + bal + ' -> ' + after + ', record ' + JSON.stringify(recOf(w, plan.id) &&
        { state: recOf(w, plan.id).state, proofs: (recOf(w, plan.id).proofs || []).length }));
    /* This section found logTx running only after the melt answered, so a
     * payout whose answer was lost was written to history nowhere: the sats
     * had left, and onchainFollow later settled an entry that did not exist.
     * Fixed in 16a-onchain.js by writing the entry
     * from the melt's error path too; this is the guard on it. */
    const entry = await entryOf(W, plan.id);
    R.check('f1: the payout is on the history screen, settled once the mint confirms it',
      !!entry && entry.settled === true && entry.state === 'success' && entry.sats === WANT, JSON.stringify(entry));
    /* KNOWN GAP: the entry written from the error path knows only the split's
     * fee — the mint's answer, which is where the rest of the fee is read
     * from, is the thing that was lost, and onchainFollow never corrects it.
     * So the history screen says this payout cost a sat when it cost 22. */
    R.check('f1: and the fee it shows is the fee that was really paid', entry && entry.feeSats === cost - WANT,
      'history says ' + (entry && entry.feeSats) + ', really ' + (cost - WANT) +
      ' — the entry recovered from a lost answer keeps only the split fee');
  });

  await section('(f2) payout answer dropped before the mint saw it', async () => {
    const { b, plan, pick, funded } = await payFixture();
    const { w, W } = b;
    proxy.add({ method: 'POST', path: meltOut, action: 'drop-before' });
    let err = null;
    try { await W.onchainPay(plan, pick.index); } catch (e) { err = e; }
    const m = proxy.last('POST', meltOut);
    R.check('f2: the request never reached the mint', m && m.action === 'drop-before' && m.upstream === undefined && !!err,
      JSON.stringify(m && { action: m.action, upstream: m.upstream }) + '; ' + (err ? err.message.slice(0, 60) : 'no error'));
    const rec = recOf(w, plan.id);
    const splitFee = rec ? rec.splitFee : 0;
    R.check('f2: the proofs are held, not spent and not given back on a guess', rec && inPile(w, rec.proofs) === 0 && rec.state === 'UNKNOWN',
      rec ? JSON.stringify({ state: rec.state, held: sats(rec.proofs) }) : 'no record');

    proxy.clear();
    /* The guard first: a payout this young is held even when the mint says
     * UNPAID, because a melt whose answer was lost may still be on its way. */
    const young = await W.onchainFollow(plan.id);
    const stillHeld = recOf(w, plan.id);
    R.check('f2: a payout minutes younger than the wait is held, whatever the mint says',
      young.state === 'PENDING' && !!stillHeld && sats(stillHeld.proofs) > 0
        && inPile(w, stillHeld.proofs) === 0,
      JSON.stringify(young) + '; ' + (stillHeld ? sats(stillHeld.proofs) + ' sats still held' : 'no record'));

    age(w, plan.id);
    const end = await settledState(W, plan.id, 30000);
    R.check('f2: the mint says UNPAID, because it never took it', end && end.state === 'UNPAID', JSON.stringify(end));
    const back = await W.balanceSats();
    /* Back to what was funded less the split's own fee: the split did happen at
     * the mint, and that sat is honestly gone. */
    R.check('f2: the proofs come back exactly once, less only the split’s fee', back === funded - splitFee && !recOf(w, plan.id),
      'funded ' + funded + ', back ' + back + ', split fee ' + splitFee);
    const again = await W.onchainFollow(plan.id);
    R.check('f2: asking again gives nothing back a second time', (await W.balanceSats()) === back && again.sats === 0,
      JSON.stringify(again) + '; balance ' + (await W.balanceSats()));
    /* The other half of the same fix: the entry written when the melt answer
     * was lost is the one onchainFollow turns failed once the mint says it
     * never took the payment. */
    const entry = await entryOf(W, plan.id);
    R.check('f2: the failed payout is marked failed on the history screen',
      !!entry && entry.state === 'failed' && entry.settled === true, JSON.stringify(entry));
  });

  await section('(f3) 500s and dropped connections on the payout’s state check', async () => {
    const { b, plan, pick } = await payFixture();
    const { w, W } = b;
    const out = await W.onchainPay(plan, pick.index);
    const bal = await W.balanceSats();
    R.check('f3: the payout went, and the mint holds it', out.state === 'PENDING' || out.state === 'PAID', JSON.stringify(out));
    const before = recOf(w, plan.id);
    proxy.add({ method: 'GET', path: meltState, action: 'status', status: 500, times: 3 });
    proxy.add({ method: 'GET', path: meltState, action: 'drop-before', times: 2 });
    const said = [];
    for (let i = 0; i < 5; i++) {
      try { said.push('resolved ' + JSON.stringify(await W.onchainFollow(plan.id))); }
      catch (e) { said.push('refused: ' + e.message.slice(0, 40)); }
      await H.sleep(500);
    }
    /* A check that cannot be made is not an answer. onchainFollow must conclude
     * nothing from it: the proofs stay on the record, and the entry stays out. */
    R.check('f3: every failed check is refused, never read as an answer', said.every((s) => /^refused/.test(s)), said.join(' | '));
    const after = recOf(w, plan.id);
    R.check('f3: the record is left exactly as it was', after && before && after.state === before.state &&
      sats(after.proofs) === sats(before.proofs) && (await W.balanceSats()) === bal,
      JSON.stringify(after && { state: after.state, held: sats(after.proofs) }) + ' was ' +
      JSON.stringify(before && { state: before.state, held: sats(before.proofs) }));
    proxy.clear();
    const end = await settledState(W, plan.id);
    const entry = await entryOf(W, plan.id);
    R.check('f3: the payment still settles once the check works again', end && end.state === 'PAID' && letGo(w, plan.id) &&
      !!entry && entry.settled && entry.state === 'success',
      JSON.stringify(end) + '; history ' + JSON.stringify(entry && { state: entry.state, settled: entry.settled }));
  });

  await section('(f4) slow answers', async () => {
    const b = await fresh(FUND);
    const { W } = b;
    const funded = await W.balanceSats();
    /* The fee quote is the one on-chain call with a ceiling of its own: 30 s. */
    proxy.add({ method: 'POST', path: meltQuote, action: 'delay-before', ms: 35000 });
    const t0 = Date.now();
    let err = null, late = null;
    try { late = await W.onchainQuote(ADDRESS, WANT); } catch (e) { err = e; }
    R.check('f4a: a fee quote 35 s late is refused at the ceiling, and nothing is spent by asking',
      !late && err && /did not answer within 30s/.test(err.message) && (await W.balanceSats()) === funded && !W.onchainSending().length,
      (err ? err.message : JSON.stringify(late)) + ' in ' + Math.round((Date.now() - t0) / 1000) + 's; balance ' + (await W.balanceSats()));
    await H.sleep(6000);
    proxy.clear();

    if (!SLOW) { R.skip('f4b', 'FOXY_FAULTS_SLOW=0'); return; }
    /* The melt has no ceiling of its own. What stops it is the bridge, which
     * gives up on any mintRequest after 65 s — so a payout against a mint that
     * simply never answers ends as a lost answer, which f1 has already pinned
     * as survivable. Worth saying plainly: without the bridge's timer this
     * call would wait as long as the mint cared to keep the socket open. */
    const { b: c, plan, pick } = await payFixture();
    proxy.add({ method: 'POST', path: meltOut, action: 'delay-after', ms: 70000 });
    const t1 = Date.now();
    let e2 = null, out = null;
    try { out = await c.W.onchainPay(plan, pick.index); } catch (e) { e2 = e; }
    const took = Math.round((Date.now() - t1) / 1000);
    const rec = recOf(c.w, plan.id);
    R.check('f4b: a payout answer 70 s late ends at the bridge’s 65 s, with the proofs still held',
      !out && !!e2 && took >= 60 && took <= 75 && rec && rec.state === 'UNKNOWN' && inPile(c.w, rec.proofs) === 0,
      (e2 ? e2.message.slice(0, 60) : JSON.stringify(out)) + ' after ' + took + 's; record ' +
      JSON.stringify(rec && { state: rec.state, held: sats(rec.proofs) }));
    proxy.clear();
    const end = await settledState(c.W, plan.id);
    R.check('f4b: and the mint’s own answer, whenever it comes, still settles it', end && end.state === 'PAID' && letGo(c.w, plan.id),
      JSON.stringify(end));
  });

  /* A payout answer with the state taken out, and one with a state nobody has
   * heard of. Neither may be read as paid; the money is with the mint either
   * way and the record has to survive to say so. */
  for (const [tag, what, rewrite] of [
    ['f5a', 'no state at all', (j) => { delete j.state; return j; }],
    ['f5b', 'a state Foxy has never heard of', (j) => { j.state = 'DRIFTING'; return j; }],
  ]) {
    await section('(' + tag + ') a payout answer rewritten to ' + what, async () => {
      const { b, plan, pick, funded } = await payFixture();
      const { w, W } = b;
      proxy.add({ method: 'POST', path: meltOut, action: 'rewrite', rewrite: rewrite });
      let err = null, out = null;
      try { out = await W.onchainPay(plan, pick.index); } catch (e) { err = e; }
      const m = proxy.last('POST', meltOut);
      R.check(tag + ': the mint acted and the answer came back changed', m && m.upstream === 200 && m.rewritten === true,
        JSON.stringify(m && { upstream: m.upstream, rewritten: m.rewritten }));
      /* cashu-ts refuses the answer outright, so Foxy never reaches its own
       * "no state means unknown" branch — it lands in the same place by the
       * other road: the melt threw, the proofs stay written down. */
      R.check(tag + ': it is never counted as paid', !out && !!err && (await W.balanceSats()) < funded,
        err ? err.message.slice(0, 70) : JSON.stringify(out));
      const rec = recOf(w, plan.id);
      R.check(tag + ': the payment is held, with the proofs still on the record', rec && rec.state === 'UNKNOWN' && inPile(w, rec.proofs) === 0,
        rec ? JSON.stringify({ state: rec.state, held: sats(rec.proofs) }) : 'no record');
      const entry = await entryOf(W, plan.id);
      R.check(tag + ': nothing on the history screen says it succeeded', !entry || (!entry.settled && entry.state !== 'success'),
        JSON.stringify(entry));
      proxy.clear();
      const end = await settledState(W, plan.id);
      R.check(tag + ': asking the mint is what settles it', end && end.state === 'PAID' && letGo(w, plan.id), JSON.stringify(end));
    });
  }

  await section('(f6) the address side', async () => {
    const b = await fresh(0);
    const { w, W } = b;
    proxy.add({ method: 'POST', path: addrQuote, action: 'drop-after' });
    let err = null, made = null;
    try { made = await W.onchainAddress(); } catch (e) { err = e; }
    const m = proxy.last('POST', addrQuote);
    R.check('f6: the mint made the address and the answer was lost', m && m.upstream === 200 && /"request"/.test(m.upstreamBody),
      'upstream ' + (m && m.upstream) + ' ' + (m && m.upstreamBody.slice(0, 90)));
    /* An address now exists at the mint that this phone has no record of. The
     * only safe outcome is that nobody was ever shown it: an address on screen
     * with no record behind it is money paid in that can never be claimed. */
    R.check('f6: onchainAddress fails and shows nobody an address', !made && !!err, err ? err.message.slice(0, 70) : JSON.stringify(made));
    const kept = JSON.parse(w.localStorage.getItem('foxy.cashu.onchain') || '[]');
    R.check('f6: and writes no record of it', !W.onchainWatching().length && !kept.length,
      W.onchainWatching().length + ' watched, ' + kept.length + ' addresses on file');
    proxy.clear();

    const ok = await W.onchainAddress();
    R.check('f6: the next address is made and kept', !!ok.address && W.onchainWatching().some((r) => r.quote === ok.quote), JSON.stringify(ok));
    proxy.add({ method: 'GET', path: addrState, action: 'status', status: 500, times: -1 });
    let seen = null, e2 = null, e3 = null;
    try { seen = await W.onchainSeen(ok.quote); } catch (e) { e2 = e; }
    try { await W.onchainClaim(ok.quote); } catch (e) { e3 = e; }
    const watched = W.onchainWatching().filter((r) => r.quote === ok.quote)[0];
    R.check('f6: a 500 while watching is refused, never read as "nothing has been paid"', !seen && !!e2 && !!e3,
      (e2 ? e2.message.slice(0, 40) : 'seen resolved ' + JSON.stringify(seen)) + ' | claim: ' + (e3 ? e3.message.slice(0, 40) : 'resolved'));
    R.check('f6: the address stays watched, with nothing issued against it', watched && watched.issued === 0 && watched.address === ok.address,
      JSON.stringify(watched && { issued: watched.issued, address: watched.address }));
    proxy.clear();
    const seen2 = await W.onchainSeen(ok.quote);
    const claimed = await W.onchainClaim(ok.quote);
    R.check('f6: once the check answers, the address reads as it should and claiming takes nothing',
      seen2.address === ok.address && seen2.paid === 0 && seen2.issued === 0 && claimed.sats === 0,
      JSON.stringify({ paid: seen2.paid, issued: seen2.issued }) + '; claimed ' + JSON.stringify(claimed));
  });
}

async function finish() {
  await proxy.close();
  R.log(H.phoneReport());
  if (H.nativeStats.wordsAsked || H.nativeStats.pageSeedDerivations || H.nativeStats.tooFarAhead) R.fail('the phone', 'a page asked for or used the words, or moved a counter too far ahead');
  const f = R.failed();
  R.log(f.length ? f.length + ' FAILED: ' + f.map((x) => x.label).join('; ') : 'all checks OK');
  process.exit(f.length ? 1 : 0);
}

main().catch((e) => { console.log('[faults ' + which + '] ERROR', e && e.stack); process.exit(1); });
