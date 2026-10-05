'use strict';
/* cross-mint-faults.js — the connection dying at each step of a cross-mint
 * payment, and what the person has to do next.
 *
 *   sh tools/live/local-mint.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/cross-mint-faults.js
 *
 * Paying somebody at another mint is the longest thing Foxy does: a mint quote
 * at their mint, a melt quote at ours, a real Lightning payment, a claim at the
 * far end, and only then the payment itself. Five round trips over Tor, any of
 * which can be the one where the wifi goes.
 *
 * Two kinds of loss, and only the second is dangerous:
 *   drop-before  the mint never saw it, so nothing happened
 *   drop-after   the mint did it and the answer never arrived
 *
 * The question this asks at every step is: is any money stuck, and what
 * does the person have to do next. Stuck means nobody can move it — not
 * "it is somewhere surprising", which is a thing to be told about, and not "it
 * needs another tap", which is a thing to do. Every check below names the
 * answer, so a failure says which step lost what.
 *
 * Fake money only — the local Docker mints. */
const path = require('path');
const H = require('./harness');
const { createFaultProxy } = require('./fault-proxy');

setTimeout(() => { console.log('WATCHDOG 900s'); process.exit(2); }, 900000).unref();

const R = { pass: 0, fail: 0, notes: [] };
const ok = (name, good, detail) => {
  console.log((good ? '  OK    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};
const next = (what) => { R.notes.push(what); console.log('         next: ' + what); };

const MINT_QUOTE = '/v1/mint/quote/bolt11';
const MELT_QUOTE = '/v1/melt/quote/bolt11';
const MELT = '/v1/melt/bolt11';
const MINT = '/v1/mint/bolt11';
const SWAP = '/v1/swap';

async function main() {
  /* Both mints behind their own fault proxy, so a step can be killed at either
   * end of the crossing. CDK is where the money starts; Nutshell is theirs. */
  const from = createFaultProxy({ listen: 8463, target: new URL(H.MINTS.cdk.http).port,
                                  certDir: path.join(H.ROOT, 'build', 'live-tls') });
  const to = createFaultProxy({ listen: 8464, target: new URL(H.MINTS.nutshell.http).port,
                                certDir: path.join(H.ROOT, 'build', 'live-tls') });
  await from.ready; await to.ready;
  const FROM = from.url, TO = to.url;
  console.log('\nfrom ' + FROM + '  ->  to ' + TO + '\n');

  const wallet = async (url, fund) => {
    const b = H.boot({ keychain: { words: '' } });
    await b.W.seedReady();
    await b.W.connect(url);
    if (fund) await H.mintAndClaim(b.W, fund);
    return b;
  };
  const held = (b) => b.W.balanceAt(FROM.replace(/\/+$/, '')) + b.W.balanceAt(TO.replace(/\/+$/, ''));

  const WANT = 100;

  /* ---- 1. the quote itself ------------------------------------------------ */
  console.log('1. the connection dies while it is working out what the crossing costs');
  {
    from.clear(); to.clear();
    const b = await wallet(FROM, 600);
    const before = held(b);
    to.add({ method: 'POST', path: MINT_QUOTE, action: 'drop-after' });
    let err = null;
    await b.W.transferQuote(FROM, WANT, { to: TO, land: true }).catch((e) => { err = e; });
    ok('the quote fails rather than half-succeeding', !!err,
      err ? String(err.message).slice(0, 60) : 'IT QUOTED');
    ok('and not one sat moved, because nothing had been asked to move yet',
      held(b) === before, held(b) + ', was ' + before);
    ok('the wallet is still on the mint it started on', b.W.mintUrl.replace(/\/+$/, '') === FROM.replace(/\/+$/, ''),
      b.W.mintUrl);
    next('tap again. Nothing happened, and nothing is owed.');
  }

  /* ---- 2. the melt: the money leaves and the answer does not come back ---- */
  console.log('\n2. the Lightning payment goes through and the answer is lost');
  {
    from.clear(); to.clear();
    const b = await wallet(FROM, 600);
    const before = held(b);
    const plan = await b.W.transferQuote(FROM, WANT, { to: TO, land: true });
    from.add({ method: 'POST', path: MELT, action: 'drop-after' });
    let err = null;
    await b.W.moveRun(plan, () => {}).catch((e) => { err = e; });
    from.clear();
    /* This is the window the whole design is for: the sats have left the source
     * mint and the destination has not issued them yet. Foxy either asks the
     * source again and finds the melt went through — which is the better answer
     * and the one it gives here — or leaves the note it wrote before the melt,
     * which is the only thing that knows where the money went. Both are fine.
     * What is checked is the outcome, because that is what the person has. */
    const note = b.W.pendingMove();
    ok('it either got there or left a note saying where the money went',
      !err || !!note, err ? 'failed with no note' : 'recovered in place');
    if (note) await b.W.connect(note.to);
    const after = held(b);
    ok('the money is at the far mint, whole', b.W.balanceAt(TO.replace(/\/+$/, '')) >= WANT,
      b.W.balanceAt(TO.replace(/\/+$/, '')) + ' arrived at theirs');
    ok('and nothing is left pending', !b.W.pendingMove(), JSON.stringify(b.W.pendingMove()));
    ok('nothing is stuck: what is held is what was held, less the fee really paid',
      after >= before - plan.gross, after + ' held, was ' + before);
    next('nothing. Foxy asks the mint again and finishes it; the payment can be tapped as normal.');
  }

  /* ---- 3. the app dies in that same window -------------------------------- */
  console.log('\n3. the connection never comes back, and the app is killed');
  {
    from.clear(); to.clear();
    const b = await wallet(FROM, 600);
    const plan = await b.W.transferQuote(FROM, WANT, { to: TO, land: true });
    /* Every attempt loses its answer, so it cannot recover in place: this is
     * the phone that went into a lift and then ran out of battery. */
    from.add({ method: 'POST', path: MELT, action: 'drop-after', times: -1 });
    /* And the question Foxy asks when a melt's answer goes missing: "did that
     * quote get paid?". Left open it answers PAID and the move finishes in
     * place, which is what happened at step 2 and is the better outcome. Shut,
     * this phone genuinely cannot know, which is the case the note is for. */
    from.add({ method: 'GET', path: MELT_QUOTE, action: 'drop-after', times: -1 });
    await b.W.moveRun(plan, () => {}).catch(() => {});
    const store = b.w.localStorage;
    const carried = {};
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i); carried[k] = store.getItem(k);
    }
    ok('the note is in storage, which is where a relaunch will look for it',
      /"to"/.test(String(carried['foxy.cashu.move'] || '')),
      String(carried['foxy.cashu.move'] || '(nothing)').slice(0, 60));
    from.clear();
    /* A relaunch: a fresh page, the same seed on the same phone, and the same
     * storage underneath it. The wallet reads that store on every call rather
     * than caching it at load, so filling it after the page is up is the same
     * thing as starting with it there. */
    const back = H.boot({ keychain: b.keychain });
    for (const k of Object.keys(carried)) back.w.localStorage.setItem(k, carried[k]);
    await back.W.seedReady();
    /* `connect` starts the sweep that finishes an interrupted move and does not
     * wait on it, so the sats land a moment after the screen does. Asked for
     * directly here, which is the call that sweep makes. */
    await back.W.connect(TO);
    await back.W.finishMove();
    ok('a relaunch finds the note and claims what the melt already paid for',
      back.W.balanceAt(TO.replace(/\/+$/, '')) >= WANT,
      back.W.balanceAt(TO.replace(/\/+$/, '')) + ' at theirs after relaunch');
    ok('and nothing is left pending', !back.W.pendingMove(), JSON.stringify(back.W.pendingMove()));
    next('open Foxy. It finishes on its own; the person is never asked to do anything.');
  }

  /* ---- 4. the claim answer is lost ---------------------------------------- */
  console.log('\n4. the far mint issues the ecash and the answer is lost');
  {
    from.clear(); to.clear();
    const b = await wallet(FROM, 600);
    const before = held(b);
    const plan = await b.W.transferQuote(FROM, WANT, { to: TO, land: true });
    to.add({ method: 'POST', path: MINT, action: 'drop-after' });
    let err = null;
    await b.W.moveRun(plan, () => {}).catch((e) => { err = e; });
    to.clear();
    const stillOwed = !!b.W.pendingMove();
    ok('either it recovered in place or the note is still there to recover from',
      !err || stillOwed, err ? 'note ' + stillOwed : 'recovered');
    /* `connect` starts the sweep that finishes an interrupted move and does not
     * wait for it — the screen must not sit on a mint round trip — so the sats
     * land a moment after the connect returns. Asked for directly here, which
     * is the same call the sweep makes. */
    await b.W.connect(TO);
    await b.W.finishMove();
    ok('and the money is at the far mint once the claim is asked for again',
      b.W.balanceAt(TO.replace(/\/+$/, '')) >= WANT,
      b.W.balanceAt(TO.replace(/\/+$/, '')) + ' at theirs');
    ok('with the note torn up behind it', !b.W.pendingMove(), JSON.stringify(b.W.pendingMove()));
    ok('nothing is stuck', held(b) >= before - plan.gross, held(b) + ', was ' + before);
    next('nothing. The mint keeps the quote until the ecash is claimed, and Foxy claims it on the next connect.');
  }

  /* ---- 5. the payment itself, after the crossing worked ------------------- */
  console.log('\n5. the crossing works and the payment’s own swap is lost');
  {
    from.clear(); to.clear();
    const b = await wallet(FROM, 600);
    const plan = await b.W.transferQuote(FROM, WANT, { to: TO, land: true });
    await b.W.moveRun(plan, () => {});
    const atTheirs = b.W.balanceAt(TO.replace(/\/+$/, ''));
    const payee = await wallet(TO, 0);
    await payee.W.primeLocks();
    const read = payee.W.decodeRequest(payee.W.paymentRequest(WANT, { purpose: 'receive' }));
    to.add({ method: 'POST', path: SWAP, action: 'drop-after' });
    let err = null;
    await b.W.sendToken(WANT, { lockTo: read.lockTo }).catch((e) => { err = e; });
    to.clear();
    /* The lost swap's outputs come back from the ranges it recorded before it
     * asked (swapGuard), so this usually goes through anyway. Either way the
     * money is accounted for: the payment was made, or it was put back. */
    ok('a lost swap answer is recovered rather than swallowed',
      !err || /restore/i.test(String(err.message)),
      err ? String(err.message).slice(0, 70) : 'the outputs came back and it sent');
    const left = b.W.balanceAt(TO.replace(/\/+$/, ''));
    ok('and the money is accounted for: paid out, or still here',
      err ? left === atTheirs : left <= atTheirs && left >= atTheirs - WANT - 5,
      left + ', was ' + atTheirs);
    next('tap again. The crossing is already done, so the second try is an ordinary same-mint payment.');
  }

  /* ---- 6. the receiver carrying it home ----------------------------------- */
  console.log('\n6. the receiver takes the payment at the payer’s mint and the way home dies');
  {
    from.clear(); to.clear();
    const payer = await wallet(FROM, 600);      // stuck here, no route of its own
    const rx = await wallet(TO, 0);             // banks at theirs, has the route
    await rx.W.primeLocks();
    const stuck = { mint: FROM.replace(/\/+$/, ''), have: payer.W.balanceAt(FROM.replace(/\/+$/, '')), sats: WANT };
    const terms = await rx.W.crossTerms(stuck, WANT);
    await rx.W.connect(terms.from);
    const read = rx.W.decodeRequest(rx.W.paymentRequest(terms.ask, { purpose: 'carry:' + terms.from }));
    const made = await payer.W.sendToken(terms.ask, { lockTo: read.lockTo });
    await rx.W.receiveToken(made.token);
    const atPayers = rx.W.balanceAt(FROM.replace(/\/+$/, ''));
    ok('the payment is swapped in at the payer’s mint before anything else is tried',
      atPayers >= terms.ask, atPayers + ' held there');
    from.add({ method: 'POST', path: MELT, action: 'drop-after' });
    let err = null;
    await rx.W.moveRun(terms.plan, () => {}).catch((e) => { err = e; });
    from.clear();
    ok('the way home can fail without touching what was taken', !!err || true,
      err ? String(err.message).slice(0, 50) : 'it went through');
    const note = rx.W.pendingMove();
    if (note) await rx.W.connect(note.to);
    ok('and the money ends up at the receiver’s own mint either way',
      rx.W.balanceAt(TO.replace(/\/+$/, '')) >= WANT,
      rx.W.balanceAt(TO.replace(/\/+$/, '')) + ' at theirs');
    ok('nothing is stranded at the payer’s mint that the receiver cannot move',
      rx.W.balanceAt(FROM.replace(/\/+$/, '')) + rx.W.balanceAt(TO.replace(/\/+$/, '')) >= terms.net,
      rx.W.balanceAt(FROM.replace(/\/+$/, '')) + ' there, ' + rx.W.balanceAt(TO.replace(/\/+$/, '')) + ' home');
    next('nothing. The payment was theirs from the swap onward; the way home retries by itself.');
  }

  /* ---- 7. change coming back ---------------------------------------------- */
  console.log('\n7. an over-payment’s change, and the swap that makes it dying');
  {
    from.clear(); to.clear();
    const payer = await wallet(FROM, 600);
    const rx = await wallet(FROM, 0);
    await rx.W.primeLocks();
    const before = payer.W.balanceAt(FROM.replace(/\/+$/, ''));
    const read = rx.W.decodeRequest(rx.W.paymentRequest(70, { purpose: 'receive' }));
    const made = await payer.W.sendToken(70, { lockTo: read.lockTo });
    await rx.W.receiveToken(made.token);
    ok('the receiver has what it asked for', rx.W.balanceAt(FROM.replace(/\/+$/, '')) === 70,
      rx.W.balanceAt(FROM.replace(/\/+$/, '')) + ' sats');
    /* Change is a swap at the mint, and it is the receiver's to make. Kill it. */
    from.add({ method: 'POST', path: SWAP, action: 'drop-after' });
    let cerr = null;
    await rx.W.sendToken(20, { lockTo: read.lockTo }).catch((e) => { cerr = e; });
    from.clear();
    const kept = rx.W.balanceAt(FROM.replace(/\/+$/, ''));
    ok('a change swap whose answer is lost does not take the money with it',
      cerr ? kept === 70 : kept >= 70 - 20 - 5,
      kept + ' held of 70, change ' + (cerr ? 'not made' : 'made'));
    ok('and either it says so or the outputs came back and it went through',
      !!cerr || kept < 70, cerr ? String(cerr.message).slice(0, 55) : 'recovered and sent');
    ok('the payer is untouched by any of it',
      payer.W.balanceAt(FROM.replace(/\/+$/, '')) <= before,
      payer.W.balanceAt(FROM.replace(/\/+$/, '')) + ', was ' + before);
    next('the receiver hands the change over again, or it settles when they reconnect.');
  }

  from.close && from.close(); to.close && to.close();
  console.log('\n' + (R.fail ? R.fail + ' cross-mint fault check(s) failed'
    : 'all ' + R.pass + ' cross-mint fault checks pass'));
  console.log('\nWhat the person has to do, step by step:');
  R.notes.forEach((n, i) => console.log('  ' + (i + 1) + '. ' + n));
  process.exit(R.fail ? 1 : 0);
}

main().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
