'use strict';
/* paste-flows.js — send, receive and paste, end to end at a real mint.
 *
 *     NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *       node tools/live/paste-flows.js [cdk|nutshell]
 *
 * The paths a person actually takes with a token in their hand, which the
 * other live scripts cover only in pieces: a token made and taken back, a
 * token taken twice, a token taken by two pastes at once, a Cashu payment
 * request carrying the amount that was typed, and a token from a mint this
 * wallet does not use.
 *
 * Written after a receive screen showed "pay any amount" for a
 * request the person had typed $1 into: the request was built from the
 * Lightning invoice's amount rather than the keypad's, so a rail switched
 * before the invoice landed made an amountless request and cached it.
 */
const H = require('./harness');

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

async function wallet(url, fund) {
  const b = H.boot({ keychain: { words: '' }, quiet: true });
  await b.W.seedReady();
  await b.W.connect(url);
  if (fund) await H.mintAndClaim(b.W, fund);
  return b;
}

(async () => {
  const key = process.argv[2] || 'cdk';
  const M = H.MINTS[key];
  await H.mintNames([key]);        // the version that answers, not the image tag
  console.log('=== ' + M.name + ' at ' + M.https);

  const A = await wallet(M.https, 2000);
  const B = await wallet(M.https, 0);

  // ---- a token there and back ------------------------------------------
  {
    const made = await A.W.sendToken(300);
    const before = await B.W.balanceSats();
    const got = await B.W.receiveToken(made.token);
    const after = await B.W.balanceSats();
    check('a token made by one wallet is taken by another',
      after - before === got.sats && got.sats > 0, made.sats + ' sent, ' + got.sats + ' taken');
    check('the same token cannot be taken twice',
      await A.W.receiveToken(made.token).then(() => false, (e) => /already spent/i.test(e.message)),
      'refused on the second attempt');
  }

  // ---- two pastes of one token, at once ---------------------------------
  {
    const made = await A.W.sendToken(120);
    const before = await B.W.balanceSats();
    const both = await Promise.allSettled([B.W.receiveToken(made.token), B.W.receiveToken(made.token)]);
    const took = both.filter((r) => r.status === 'fulfilled');
    const after = await B.W.balanceSats();
    check('two pastes at once take it exactly once', took.length === 1,
      took.length + ' of 2 succeeded');
    check('and the balance moves by one token, not two',
      after - before === (took[0] && took[0].value.sats), before + ' -> ' + after);
  }

  // ---- the amount survives into a Cashu payment request ------------------
  {
    const want = 750;
    const text = A.W.paymentRequest(want, { purpose: 'receive' });
    check('a payment request is made for a figure', !!text, text ? text.slice(0, 22) + '…' : 'nothing');
    const read = A.W.decodeRequest(text);
    check('the request carries the amount that was asked for', read && read.sats === want,
      'asked ' + want + ', request says ' + (read ? read.sats : 'unreadable'));
    check('and it names this mint and a way to deliver', read && read.mints.length > 0,
      read ? read.mints.join(',') + ' | transports ' + JSON.stringify(read.transports) : '-');
    const none = A.W.paymentRequest(0, { purpose: 'receive' });
    const readNone = none ? A.W.decodeRequest(none) : null;
    check('and a request made for nothing carries no amount',
      !readNone || readNone.sats === 0,
      'request says ' + (readNone ? readNone.sats : 'no request'));
  }

  // ---- a token from a mint this wallet does not use ----------------------
  {
    const O = H.MINTS[H.other(key)];
    const C = await wallet(O.https, 400);
    const made = await C.W.sendToken(150);
    const info = B.W.tokenInfo(made.token);
    check('a token from another mint reads without connecting to it',
      !!info && info.sats === made.sats && info.mint === O.https,
      info ? info.sats + ' sat from ' + info.mint : 'unreadable');
    check('and its proofs are all there', !!info && info.proofs.length > 0,
      info ? info.proofs.length + ' proofs' : '-');
  }

  // ---- what the mint says about a token we just spent --------------------
  {
    const made = await A.W.sendToken(90);
    await B.W.receiveToken(made.token);
    const info = B.W.tokenInfo(made.token);
    const w = B.W.walletFor ? B.W.walletFor(info.mint) : null;
    check('a spent token still reads as a token (it is the mint that says no)',
      !!info && info.sats === made.sats, info ? info.sats + ' sat' : 'unreadable');
  }

  console.log('');
  console.log(R.fail ? R.fail + ' FAILED of ' + (R.pass + R.fail) : 'all ' + R.pass + ' checks pass');
  process.exit(R.fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', (e && e.message) || e); process.exit(1); });
