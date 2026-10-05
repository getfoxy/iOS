'use strict';
/* onchain.js — NUT-30 end to end against a real mint, with fake money.
 *
 *   node tools/live/onchain.js                       # testnut.cashu.space
 *   node tools/live/onchain.js https://nofee.testnut.cashu.space
 *
 * The Lightning paths have `flows.js` and a fault harness; the on-chain ones
 * had nothing but a hand-run in the simulator, which is how a helper called
 * with the wrong argument shape reached a device. This asks a real
 * mint the questions the wallet asks, in the order the wallet asks them, and
 * checks what comes back against what the screens rely on:
 *
 *   - what the mint says it will do on chain, per direction, from its own
 *     /v1/info rather than from a guess;
 *   - an address to be paid into, which is a quote and not an invoice: no
 *     amount, no expiry, and asking about it twice is free;
 *   - a payout quoted with its fee options, paid, and then followed from
 *     PENDING to PAID — the state machine the history screen colours by.
 *
 * Fake-money mints only (harness.fakeMoneyOnly). A payout here goes nowhere
 * real: the test mint's chain is as pretend as its Lightning. What is being
 * tested is Foxy's half of the conversation.
 */
const H = require('./harness');

const MINT = process.argv[2] || 'https://testnut.cashu.space';
// a well-formed mainnet address (BIP-173's own example), so the mint's refusal
// can only ever be about the mint, never about the address
const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

H.fakeMoneyOnly(MINT);
const r = H.reporter('on-chain');
setTimeout(() => { r.log('WATCHDOG 400s'); process.exit(2); }, 400000).unref();

async function main() {
  const { W } = H.boot({ keychain: { words: '' } });
  await W.connect(MINT, { remember: true });
  r.ok('connected', MINT);

  // ---- what this mint will do, and in which direction ----------------------
  const limits = await W.onchainLimits();
  if (!limits) {
    r.skip('this mint does not speak NUT-30', MINT + ' advertises no onchain method');
    return done();
  }
  r.ok('the mint answers what it does on chain', JSON.stringify(limits));
  r.check('the answer names the two directions separately',
    Object.prototype.hasOwnProperty.call(limits, 'receive')
      && Object.prototype.hasOwnProperty.call(limits, 'send'),
    JSON.stringify(limits));
  if (limits.receive) {
    r.check('the floor Foxy shows is at least the mint’s own',
      limits.receive.min > 0, 'min ' + limits.receive.min);
    r.check('the mint says how many confirmations it waits for',
      Number.isFinite(limits.receive.confirmations), String(limits.receive.confirmations));
  }

  // ---- receiving: an address is a quote, not an invoice --------------------
  if (limits.receive) {
    const made = await W.onchainAddress();
    r.check('the mint gives an address to be paid into',
      typeof made.address === 'string' && made.address.length > 20 && !!made.quote,
      made.address + ' (quote ' + String(made.quote).slice(0, 8) + '…)');
    /* A fake-money mint settles on regtest or signet, and Foxy's reader is
     * mainnet only on purpose: an address it cannot pay is one the mint would
     * refuse anyway. So this asks only that the two agree about the network. */
    const mainnet = /^(bc1|[13])/.test(made.address);
    r.check('Foxy reads the address exactly when it is one it could pay',
      !!W.readAddress(made.address) === mainnet,
      made.address + (mainnet ? '' : ' (this mint settles off mainnet)'));
    r.check('the QR carries it with the amount as a hint',
      W.bip21(made.address, 20000) === 'bitcoin:' + made.address + '?amount=0.0002',
      W.bip21(made.address, 20000));

    const seen = await W.onchainSeen(made.quote);
    r.check('nothing has been paid to it yet, and nothing issued',
      seen.paid === 0 && seen.issued === 0, JSON.stringify({ paid: seen.paid, issued: seen.issued }));
    const claimed = await W.onchainClaim(made.quote);
    r.check('claiming an address nobody has paid takes nothing', claimed.sats === 0,
      JSON.stringify(claimed));

    /* The same quote asked about twice: an address is payable any number of
     * times, so nothing about asking may change it. */
    const again = await W.onchainSeen(made.quote);
    r.check('asking again says the same thing', again.address === seen.address, again.address);
    r.check('the address is watched until it is claimed or times out',
      W.onchainWatching().some((x) => x.quote === made.quote), 'not in the watch list');
  } else {
    r.skip('receiving on chain', 'this mint takes no on-chain payments');
  }

  // ---- sending: quote, pay, and follow it to PAID --------------------------
  if (!limits.send) {
    r.skip('sending on chain', 'this mint makes no on-chain payouts');
    return done();
  }

  const want = Math.max(limits.send.min || 0, 1000);
  const fund = want + Math.max(2000, Math.ceil(want / 4));
  await H.mintAndClaim(W, fund);
  r.ok('funded with fake sats', String(fund));

  const plan = await W.onchainQuote(ADDRESS, want);
  r.check('the mint quotes the payout', plan.sats === want && !!plan.id,
    JSON.stringify({ sats: plan.sats, options: plan.options.length }));
  r.check('every fee option names a fee and a wait',
    plan.options.length > 0 && plan.options.every((o) => Number.isFinite(o.fee)
      && Number.isFinite(o.blocks) && Number.isInteger(o.index)),
    JSON.stringify(plan.options));
  r.check('the options come back quickest first',
    plan.options.every((o, i) => i === 0 || plan.options[i - 1].blocks <= o.blocks),
    JSON.stringify(plan.options.map((o) => o.blocks)));

  /* A fee index the quote does not offer must be refused before any ecash
   * moves: the sheet on the confirmation screen sends one of these. */
  const bogus = Math.max(...plan.options.map((o) => o.index)) + 7;
  let refused = '';
  try { await W.onchainPay(plan, bogus); } catch (e) { refused = e.message; }
  r.check('a fee the quote does not offer is refused', /not one this quote offers/.test(refused),
    refused || 'it was accepted');

  const before = await W.balanceSats();
  const out = await W.onchainPay(plan, plan.options[0].index);
  r.check('the mint takes the ecash and says what state the payout is in',
    out.sats === want && ['PENDING', 'PAID', 'UNKNOWN'].indexOf(out.state) >= 0,
    JSON.stringify({ sats: out.sats, fee: out.feeSats, state: out.state }));
  const after = await W.balanceSats();
  r.check('the amount and the fee left the wallet, and no more',
    before - after === want + out.feeSats, before + ' − ' + after + ' for ' + want + ' + ' + out.feeSats);

  /* PENDING is not PAID. The history screen holds the entry amber until the
   * mint says the transaction confirmed, and this is the poll behind that. */
  const entry = (await W.transactions(20)).find((t) => t.hash === 'onchain-' + out.quote);
  r.check('history holds the payout until it confirms',
    !!entry && (out.state === 'PAID' ? entry.settled : !entry.settled),
    JSON.stringify(entry && { state: entry.state, settled: entry.settled }));

  const end = await H.waitFor(async () => {
    const answer = await W.onchainFollow(out.quote);
    return answer.state === 'PAID' || answer.state === 'FAILED' || answer.state === 'UNPAID'
      ? answer : null;
  }, 120000, 3000);
  if (!end) {
    r.check('the payout reaches a settled state within two minutes', false,
      'still pending; a mint with a real chain behind it may simply be slower');
  } else if (end.state === 'PAID') {
    r.ok('the payout confirmed', JSON.stringify(end));
    const settled = (await W.transactions(20)).find((t) => t.hash === 'onchain-' + out.quote);
    r.check('history turns it done once the mint confirms it',
      !!settled && settled.settled && settled.state === 'success',
      JSON.stringify(settled && { state: settled.state, settled: settled.settled }));
    r.check('it is no longer one of the payments on their way out',
      !W.onchainSending().some((x) => x.quote === out.quote), 'still listed as sending');
  } else {
    /* The mint refused it after taking it: the ecash must be back, because
     * onchainFollow is the only thing that can put it there. */
    const back = await W.balanceSats();
    r.check('a payout the mint did not make gives the ecash back',
      back >= after + want, 'balance ' + back + ', was ' + after);
  }

  return done();
}

function done() {
  H.phoneReport();
  const failed = r.failed();
  console.log('\n[on-chain] ' + (r.rows.length - failed.length) + ' of ' + r.rows.length + ' checks pass');
  if (failed.length) { failed.forEach((f) => console.log('  FAIL ' + f.label)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { r.fail('the run itself', String((e && e.stack) || e)); done(); });
