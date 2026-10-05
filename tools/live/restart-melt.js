'use strict';
/* restart-melt.js — the mint restarted while a melt is in flight.
 *
 *   sh tools/live/local-mint.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/restart-melt.js
 *
 * faults.js drops a melt's ANSWER with the proxy; the mint itself stays up and
 * keeps its quote. That is not the same as losing the mint. CDK 0.17.6/0.17.7
 * changed melt saga recovery — the one part of a mint restart a wallet can
 * see — and no suite had ever restarted one, so what a wallet meets when the
 * mint comes back was untested against a real mint.
 *
 * Here the melt request goes out and, a fraction of a second later, the CDK
 * container is restarted under it (`docker restart foxy-cdk`). Foxy gets no
 * answer, and its state check cannot reach the mint either. What must follow
 * (MONEY.md; build/wallet/16-sending.js, 15-receiving.js `_sweepMeltsOnce`,
 * 04-lost-answers.js `mintRefused`):
 *
 *   - the proofs are HELD, not handed back. A dropped connection is not the
 *     mint refusing: the melt may have arrived, and giving the ecash back
 *     would let it be spent twice. Only a refusal the mint actually sent (a
 *     4xx or a coded error) proves the melt never landed;
 *   - a quote reading UNPAID after the restart does not release the hold
 *     either, while the hold is under two minutes old: a melt still on its way
 *     reads UNPAID too;
 *   - once the mint is back and has said either way, sweepMelts settles it —
 *     PAID with the change restored from the melt's counters, UNPAID or FAILED
 *     with the ecash back, past the age gate;
 *   - and at the end the balance is exactly what a restore from the words
 *     finds, which is the only check that nothing was lost or double-counted.
 *
 * Which of those happens is the mint's to decide, and CDK 0.18.1 has been seen
 * to decide all three ways from the same kill, so the script reports the branch
 * it took rather than pinning one. The third is the interesting one: when CDK's
 * recovery "cannot prove payment failure" it leaves the quote and the input
 * proofs PENDING for good, and then the right answer is that the ecash stays
 * held — checked here by asking the mint whether it really is still holding the
 * inputs, because a hold kept over inputs the mint has released would be a bug
 * of its own.
 *
 * Steps, each OK/FAIL, exit 1 on any FAIL. It takes a few minutes: the age
 * gate is two minutes of real time and is waited out rather than faked. */
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const H = require('./harness');

const CONTAINER = process.env.FOXY_CDK_CONTAINER || 'foxy-cdk';
const RESTART_AFTER_MS = Number(process.env.FOXY_RESTART_AFTER_MS || 0);
const AMOUNT = 50;
setTimeout(() => { console.log('WATCHDOG 900s'); process.exit(2); }, 900000).unref();

const R = H.reporter('restart-melt');
const M = H.MINTS.cdk;
const O = H.MINTS.nutshell;

// both streams: cdk-mintd's own lines (the saga recovery among them) go to stderr
const docker = (args) => new Promise((ok, no) => execFile('docker', args, { timeout: 120000, maxBuffer: 8e6 },
  (e, out, err) => (e ? no(new Error('docker ' + args.join(' ') + ': ' + (err || e.message))) : ok(String(out) + String(err || '')))));

/* `docker restart` through the CLI loses this race: the melt is answered in
 * well under the time the CLI takes to start, so the container was always
 * killed after a completed payment, never during one. The same call straight
 * down Docker's own socket goes out in a millisecond or two — and `t=0` means
 * SIGKILL rather than a graceful stop, which is what leaves the mint with a
 * melt saga to recover on the way back up. */
const SOCK = [process.env.DOCKER_HOST_SOCK, process.env.HOME + '/.docker/run/docker.sock', '/var/run/docker.sock']
  .filter(Boolean).find((p) => { try { return fs.statSync(p).isSocket(); } catch (e) { return false; } });
function restartContainer() {
  if (!SOCK) return docker(['restart', '-t', '0', CONTAINER]).then(() => 'docker restart (no socket found)');
  return new Promise((ok, no) => {
    const req = http.request({ socketPath: SOCK, method: 'POST', path: '/containers/' + CONTAINER + '/restart?t=0' },
      (res) => { res.resume(); res.on('end', () => (res.statusCode < 300 ? ok('socket ' + res.statusCode) : no(new Error('docker socket said ' + res.statusCode)))); });
    req.on('error', no);
    req.end();
  });
}

const getJson = async (u) => (await fetch(u)).json();

(async () => {
  await H.mintNames();
  R.log('=== ' + M.name + ' at ' + M.https + ', invoice from ' + O.name);

  await docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]).catch(() => {
    throw new Error('no container named ' + CONTAINER + ' (sh tools/live/local-mint.sh up)');
  });

  /* The restart is fired from the request hook, so it lands while the melt is
   * actually in flight rather than at some guessed moment. A short delay first,
   * so the mint has the request and its fake wallet has begun paying. */
  let restarted = null;
  const seen = [];
  const b = H.boot({ keychain: { words: '' }, onMint: (r) => {
    seen.push(r.method + ' ' + r.path);
    if (!restarted && r.method === 'POST' && r.path === '/v1/melt/bolt11') {
      restarted = new Promise((ok) => setTimeout(() => {
        const t = Date.now();
        ok(restartContainer().then((how) => how + ' in ' + Math.round(Date.now() - t) + 'ms').catch((e) => String(e.message)));
      }, RESTART_AFTER_MS));
    }
  } });
  await b.W.seedReady();
  await b.W.connect(M.https);
  await H.mintAndClaim(b.W, 300);
  const W = b.W;

  const bolt = await H.rawInvoice(O.http, AMOUNT);
  const mq = await (await fetch(M.http + '/v1/melt/quote/bolt11', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: bolt, unit: 'sat' }) })).json();
  const reserve = Number(mq.fee_reserve);
  const before = await W.balanceSats();

  let paid = null, err = null;
  await R.step('1. the melt goes out and the mint is restarted under it', async () => {
    const t = Date.now();
    try { paid = await W.pay(bolt); } catch (e) { err = e; }
    if (!restarted) throw new Error('no /v1/melt/bolt11 was seen, so nothing was restarted: ' + seen.join(', '));
    const took = await restarted;
    return 'pay took ' + Math.round((Date.now() - t) / 1000) + 's, the restart went out by ' + took + '; ' +
      (err ? 'pay threw: ' + String(err.message).slice(0, 70) : 'pay returned ' + JSON.stringify(paid));
  });

  let held = [], heldSats = 0;
  await R.step('2. the ecash is held, not handed back', async () => {
    held = W.pendingMelts();
    heldSats = held.reduce((a, h) => a + h.proofs.reduce((x, p) => x + Number(p.amount), 0), 0);
    if (err && !err.pending) throw new Error('pay failed outright rather than holding: ' + err.message);
    if (!err && !(paid && paid.pending)) {
      /* A mint that answered before the restart landed is a legitimate outcome
       * of the race, but it is not the case this script exists to test. */
      throw new Error('the melt completed before the restart landed (' + JSON.stringify(paid) +
        ') — raise FOXY_RESTART_AFTER_MS or lower it so the restart catches the request');
    }
    if (held.length !== 1) throw new Error(held.length + ' melts held');
    const after = await W.balanceSats();
    const fell = before - after;
    if (fell < heldSats || fell - heldSats > 2) {
      throw new Error('balance fell ' + fell + ' for a hold of ' + heldSats + ' (a split swap may cost 1-2)');
    }
    return heldSats + ' sat held for a ' + AMOUNT + ' sat payment (fee reserve ' + reserve +
      '); balance ' + before + ' -> ' + after + ', split fee ' + (fell - heldSats);
  });

  let sagaLog = '';
  await R.step('3. the mint comes back, and says what it did with the quote', async () => {
    const up = await H.waitFor(async () => {
      try { return (await getJson(M.http + '/v1/info')).version || null; } catch (e) { return null; }
    }, 120000, 1000);
    if (!up) throw new Error('the mint did not come back within 120s');
    // what the mint made of the melt it was killed in the middle of
    sagaLog = (await docker(['logs', '--tail', '400', CONTAINER]).catch(() => ''))
      .split('\n').filter((l) => /saga/i.test(l)).slice(-2)
      .map((l) => l.replace(/^\S+\s+INFO\s+/, '').trim()).join(' | ');
    const q = await getJson(M.http + '/v1/melt/quote/bolt11/' + held[0].quote);
    return 'mint back as ' + up + '; the quote reads ' + q.state + '; ' + (sagaLog || 'no saga line in the log');
  });

  const stateNow = async () => String((await getJson(M.http + '/v1/melt/quote/bolt11/' + held[0].quote)).state || '').toUpperCase();

  let outcome = '';
  await R.step('4. sweepMelts settles it, and only when it is allowed to', async () => {
    const state = await stateNow();
    const ageAt = () => Math.floor(Date.now() / 1000) - Number(held[0].at || 0);
    if (state === 'PAID') {
      const settled = await W.sweepMelts();
      if (!(settled.length === 1 && settled[0].paid)) throw new Error('the quote reads PAID and the sweep returned ' + JSON.stringify(settled));
      if (W.pendingMelts().length) throw new Error('the hold survived a settled melt');
      outcome = 'PAID';
      const changeLog = b.rec.log.filter((l) => /melt change: restored/.test(l));
      return 'quote PAID: settled as paid at once, ' + (changeLog[0] || 'no change restore logged');
    }
    if (state === 'UNPAID' || state === 'PENDING') {
      /* The age gate. The mint never told this wallet anything — the
       * connection died — so a quote reading UNPAID now is not proof the melt
       * never landed, and the hold must survive until nothing can still be in
       * flight. Two minutes, from build/wallet/15-receiving.js. */
      const early = await W.sweepMelts();
      const stillHeld = W.pendingMelts().length;
      if (early.length || stillHeld !== 1) {
        throw new Error('the quote reads ' + state + ' and the hold is ' + ageAt() +
          's old, but the sweep gave it back: ' + JSON.stringify(early));
      }
      R.log('    the quote reads ' + state + ' and the hold is ' + ageAt() + 's old — left held, as it must be');
      const wait = Math.max(0, 121 - ageAt());
      R.log('    waiting ' + wait + 's for the two-minute age gate');
      await H.sleep(wait * 1000);
      const late = await W.sweepMelts();
      const after = await stateNow();
      if (after === 'PAID') {
        if (!(late.length === 1 && late[0].paid)) throw new Error('the quote turned PAID and the sweep returned ' + JSON.stringify(late));
        outcome = 'PAID late';
        return 'quote ' + state + ' then PAID: held through the gate, settled as paid at ' + ageAt() + 's';
      }
      if (!late.length && after === 'PENDING') {
        /* The third thing CDK's recovery can decide: it cannot prove the
         * payment failed (payment_status=UNKNOWN), so the quote and the input
         * proofs stay PENDING for good. Foxy's PENDING branch gives the ecash
         * back only when every input reads UNSPENT at the mint — the mint is
         * still holding these, so the hold must stay. Handing them back here
         * would be the double-spend the rule exists to prevent, so the check
         * is not "the sweep settled it" but "the mint really is still holding
         * the inputs". */
        const raw = new b.w.CashuTS.Wallet(M.https);
        await raw.loadMint();
        const states = (await raw.checkProofsStates(held[0].proofs)).map((s) => String(s.state).toUpperCase());
        if (states.every((s) => s === 'UNSPENT')) {
          throw new Error('every input reads UNSPENT at the mint and the hold is ' + ageAt() +
            's old, but the sweep left ' + heldSats + ' sat held');
        }
        if (W.pendingMelts().length !== 1) throw new Error('the hold went somewhere: ' + JSON.stringify(W.pendingMelts()));
        outcome = 'still held (the mint still holds the inputs)';
        return 'quote PENDING past the gate and the mint still holds the inputs (' +
          [...new Set(states)].join(',') + ') — the ' + heldSats + ' sat stay held, which is the only safe answer';
      }
      if (!(late.length === 1 && late[0].paid === false)) {
        throw new Error('past the gate the quote reads ' + after + ' and the sweep returned ' + JSON.stringify(late));
      }
      if (W.pendingMelts().length) throw new Error('the hold survived a settled melt');
      outcome = 'returned';
      return 'quote ' + state + ' throughout: held for ' + ageAt() + 's, then ' + heldSats + ' sat given back';
    }
    if (state === 'FAILED') {
      const settled = await W.sweepMelts();
      if (!(settled.length === 1 && settled[0].paid === false)) throw new Error('the quote reads FAILED and the sweep returned ' + JSON.stringify(settled));
      outcome = 'returned';
      return 'quote FAILED: ' + heldSats + ' sat given back at once';
    }
    throw new Error('the quote reads ' + state + ', which this script does not know what to do with');
  });

  await R.step('5. the balance is what a restore from the words finds', async () => {
    const bal = await W.balanceSats();
    const rows = await H.scanFresh(b.keychain.words, [M.https]);
    if (rows[0].sats !== bal) {
      throw new Error('balance ' + bal + ', a restore from the words finds ' + rows[0].sats +
        ' (' + outcome + '); ' + (rows[0].partial ? 'the scan was partial' : ''));
    }
    // and it spends: nothing left in a state the mint will refuse
    const t = await W.sendToken(5);
    const back = await W.receiveToken(t.token);
    if (!(back.sats > 0)) throw new Error('the restored balance could not be spent');
    const cost = before - bal;
    return 'balance ' + bal + ' = restore ' + rows[0].sats + '; the melt (' + outcome + ') cost ' + cost +
      ' of ' + before + ', and the balance spends';
  });

  await R.step('6. no held melt and no trouble left behind', async () => {
    // a melt the mint is still holding the inputs for stays held on purpose (step 4)
    if (W.pendingMelts().length && !/still held/.test(outcome)) {
      throw new Error(W.pendingMelts().length + ' melts still held');
    }
    // the 502s are the restart itself, through tls-proxy.js; anything else is the mint complaining
    const bad = b.rec.mintSaid.filter((s) => !/^502 .*local mint unreachable/.test(s));
    const melts = seen.filter((s) => s === 'POST /v1/melt/bolt11').length;
    if (melts !== 1) throw new Error(melts + ' melt requests went out — a melt was retried blind');
    return 'one melt request, no hold left; the mint’s complaints: ' + (bad.length ? bad.slice(0, 2).join(' / ') : 'none');
  });

  console.log(H.phoneReport());
  let failures = R.failed().length;
  if (H.nativeStats.wordsAsked || H.nativeStats.pageSeedDerivations || H.nativeStats.tooFarAhead) failures++;
  console.log(failures ? failures + ' FAILED' : 'all steps OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log('[restart-melt] FAIL  run — ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | '));
  process.exit(1);
});
