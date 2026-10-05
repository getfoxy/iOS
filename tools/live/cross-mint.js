'use strict';
/* cross-mint.js — paying somebody at another mint, against two real mints.
 *
 *   sh tools/live/local-mint.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/cross-mint.js
 *
 * Ecash is only worth what its own mint will honour, so a request at a mint
 * this wallet does not use cannot be answered out of this pile. What Foxy does
 * instead depends on which phone has the route, and both halves move real money
 * through real Lightning-shaped quotes at two different mint implementations.
 *
 *  A. THE PAYER HAS THE ROUTE (`tapCrossMint`). It quotes a move to their mint,
 *     shows the fee, melts, claims at the far end and pays from there. The
 *     figure they asked for is what lands: the far mint's own fee for spending
 *     what it issues is padded into the move and the payer carries it, along
 *     with the routing fee (`transferQuote` with `land`).
 *
 *  B. THE RECEIVER HAS IT (`crossTerms`, `carryHomeNow`). The payer is offline
 *     and stuck at its own mint, so the receiver quotes what bringing the money
 *     home will cost, asks for the amount plus that, takes the payment at the
 *     payer's mint, swaps it in — the moment nothing can go wrong any more —
 *     and melts it home.
 *
 * Both were first built and tested only against stub mints, whose fee
 * schedules are whatever the test says they are. These are CDK's and
 * Nutshell's own.
 *
 * Not covered here, and it cannot be: the two messages the phones exchange to
 * agree all this (M10/M11) ride a Bluetooth link, which needs two devices. This
 * is everything from the agreement onwards.
 *
 * Fake money only — the local Docker mints. */
const H = require('./harness');

setTimeout(() => { console.log('WATCHDOG 900s'); process.exit(2); }, 900000).unref();

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? '  OK    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};

async function wallet(url, fund) {
  const b = H.boot({ keychain: { words: '' } });
  await b.W.seedReady();
  await b.W.connect(url);
  if (fund) await H.mintAndClaim(b.W, fund);
  return b;
}

/* What each mint charges to spend a piece, straight from its keyset. The
 * padding exists for exactly this number and the two mints need not agree. */
async function inputFee(b, url) {
  try {
    const w = b.W._walletFor ? b.W._walletFor(url) : null;
    if (w && w.getFeesForKeyset) return w.getFeesForKeyset(1, w.keysetId);
  } catch (e) {}
  return null;
}

async function run() {
  const CDK = H.MINTS.cdk.https;
  const NUT = H.MINTS.nutshell.https;
  const names = await H.mintNames(['cdk', 'nutshell']);
  console.log('\n' + names.cdk + '  <->  ' + names.nutshell + '\n');

  /* ---- A. the payer has the route ---------------------------------------- */
  console.log('A. the payer has the route — it moves the money and pays from there');
  {
    const payer = await wallet(CDK, 2000);
    const startCdk = payer.W.balanceAt(CDK.replace(/\/+$/, ''));
    ok('the payer starts with money at its own mint and none at theirs',
      startCdk >= 1000 && payer.W.balanceAt(NUT.replace(/\/+$/, '')) === 0,
      startCdk + ' at CDK, ' + payer.W.balanceAt(NUT.replace(/\/+$/, '')) + ' at Nutshell');

    const WANT = 100;
    const plan = await payer.W.transferQuote(CDK, WANT, { to: NUT, land: true });
    ok('it quotes the move without connecting anywhere',
      payer.W.mintUrl.replace(/\/+$/, '') === CDK.replace(/\/+$/, ''),
      'still on ' + payer.W.mintUrl);
    ok('the figure they asked for is what the plan says will land',
      plan.net === WANT, 'net ' + plan.net);
    ok('and the far mint is asked for that plus whatever it charges to spend it',
      plan.moving >= WANT && plan.moving === WANT + plan.padSats,
      'issuing ' + plan.moving + ' (' + plan.padSats + ' of padding)');
    ok('the fee is real, and it is the payer’s', plan.feeSats > 0,
      plan.feeSats + ' sats over the ' + WANT);
    ok('and the whole cost is the amount plus that fee',
      plan.gross === WANT + plan.feeSats, plan.gross + ' = ' + WANT + ' + ' + plan.feeSats);

    await payer.W.connect(CDK);
    const before = payer.W.balanceAt(CDK.replace(/\/+$/, ''));
    const done = await payer.W.moveRun(plan, () => {});
    ok('the melt and the claim both go through at real mints',
      done && done.sats >= WANT, JSON.stringify(done && { sats: done.sats, mint: done.mint }));
    ok('and the wallet is left at their mint, which is where the payment is made from',
      payer.W.mintUrl.replace(/\/+$/, '') === NUT.replace(/\/+$/, ''), payer.W.mintUrl);

    const landed = payer.W.balanceAt(NUT.replace(/\/+$/, ''));
    ok('at least the figure asked for is there, so paying it cannot come up short',
      landed >= WANT, landed + ' at Nutshell, needed ' + WANT);
    const spentAtCdk = before - payer.W.balanceAt(CDK.replace(/\/+$/, ''));
    ok('and no more left the payer’s mint than the quote said it would',
      spentAtCdk <= plan.gross, spentAtCdk + ' left CDK, quoted at most ' + plan.gross);

    /* The payment itself, now an ordinary same-mint one. */
    const payee = await wallet(NUT, 0);
    await payee.W.primeLocks();
    const creq = payee.W.paymentRequest(WANT, { purpose: 'receive' });
    const read = payee.W.decodeRequest(creq);
    /* `sats` here is what leaves the payer's pile, which is the figure plus
     * the mint's own charge for spending the pieces. That charge is the
     * payer's too — the rule is that the receiver gets the number they named
     * and everything else is carried by the person paying. */
    const made = await payer.W.sendToken(WANT, { lockTo: read.lockTo });
    ok('the payment carries the figure they asked for, locked to them',
      made.sats >= WANT, made.sats + ' sats left the payer for a ' + WANT + '-sat payment');
    const took = await payee.W.receiveToken(made.token);
    ok('and they end up holding that figure, not that figure less a fee',
      took.sats === WANT && payee.W.balanceAt(NUT.replace(/\/+$/, '')) === WANT,
      'they hold ' + payee.W.balanceAt(NUT.replace(/\/+$/, '')));
    ok('so every sat of the crossing was the payer\u2019s, and none of it theirs',
      payee.W.balanceAt(NUT.replace(/\/+$/, '')) === WANT,
      WANT + ' asked, ' + WANT + ' received');
  }

  /* ---- B. the receiver has the route -------------------------------------- */
  console.log('\nB. the payer is offline and stuck — the receiver carries it home');
  {
    const payer = await wallet(NUT, 2000);      // stuck at Nutshell, no route
    const rx = await wallet(CDK, 0);            // online, banks at CDK
    await rx.W.primeLocks();

    const WANT = 100;
    const stuck = { mint: NUT.replace(/\/+$/, ''),
                    have: payer.W.balanceAt(NUT.replace(/\/+$/, '')), sats: WANT };
    const terms = await rx.W.crossTerms(stuck, WANT);
    ok('the receiver quotes the way home from two real mints',
      terms && terms.net === WANT && terms.ask > WANT,
      'asking ' + (terms && terms.ask) + ' so ' + (terms && terms.net) + ' lands');
    ok('and every sat of the difference is the payer’s to pay',
      terms.ask - terms.net === terms.feeSats, terms.feeSats + ' sats of fees');
    ok('the request goes out at the payer’s mint, not the receiver’s',
      terms.from === NUT.replace(/\/+$/, '') && terms.to === CDK.replace(/\/+$/, ''),
      terms.from + ' -> ' + terms.to);

    /* The receiver goes to the payer's mint to be paid there. */
    await rx.W.connect(terms.from);
    const creq = rx.W.paymentRequest(terms.ask, { purpose: 'carry:' + terms.from });
    const read = rx.W.decodeRequest(creq);
    ok('and it carries a lock only the receiver can open',
      /^0[23][0-9a-f]{64}$/i.test(String(read.lockTo || '')), String(read.lockTo || '').slice(0, 18));

    const made = await payer.W.sendToken(terms.ask, { lockTo: read.lockTo });
    ok('the payer pays the total, out of the mint it is stuck at',
      made.sats >= terms.ask,
      made.sats + ' sats left it for a ' + terms.ask + '-sat request');

    const took = await rx.W.receiveToken(made.token);
    ok('the receiver swaps it in at the payer’s mint — nothing can go wrong after this',
      took.sats === terms.ask && rx.W.balanceAt(terms.from) === terms.ask,
      'holding ' + rx.W.balanceAt(terms.from) + ' at Nutshell');

    const home = await rx.W.moveRun(terms.plan, () => {});
    ok('and melts it home to its own mint', home && home.sats >= WANT,
      JSON.stringify(home && { sats: home.sats, mint: home.mint }));
    const landed = rx.W.balanceAt(CDK.replace(/\/+$/, ''));
    ok('the receiver ends up with the figure it asked for, and the payer paid the way',
      landed >= WANT, landed + ' at CDK, asked for ' + WANT);
    ok('which is the whole of what it asked for, with the crossing paid by the payer',
      landed === WANT, landed + ' at CDK for a ' + WANT + '-sat request');
  }

  console.log('\n' + (R.fail ? R.fail + ' cross-mint check(s) failed' : 'all ' + R.pass + ' cross-mint checks pass'));
  process.exit(R.fail ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
