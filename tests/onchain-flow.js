'use strict';
/* onchain-flow.js — the NUT-30 state machine, against a mint that does as it is told.
 *
 *     node tests/onchain-flow.js
 *
 * build/wallet/16a-onchain.js moves real Bitcoin and had no unit test at all:
 * it was proved by hand in the simulator, and that one run found
 * a helper called with the wrong argument shape — a thing a stubbed mint would
 * have caught in a second. The Lightning melt has a fault-injection harness;
 * this is the on-chain one.
 *
 * What is pinned here is the money, and the three traps the file's own header
 * names:
 *
 *   - an address is not an invoice. It has no amount and no expiry, so the
 *     record on disk is the only thing that knows a payment is still coming.
 *   - anything under the mint's floor is LOST, not refused, so onchainFloor
 *     raises a mint's own figure to Foxy's.
 *   - a payout answers PENDING when the mint takes the ecash and PAID only
 *     when the transaction confirms. Between those two the proofs exist
 *     nowhere but in K.onchain.out, so every path out of the melt is checked
 *     for where they ended up: back in the pile, held on the record, or gone
 *     because the payment really happened. A path that loses them loses money.
 *
 * The mint is a stub, as everywhere in tests/: it answers, it does not decide.
 * No real mint is contacted and no real money moves.
 */
const { load, proof } = require('./harness');

const MINT = 'https://m.test';
const OTHER = 'https://other.test';
const K = {
  proofs: 'foxy.cashu.proofs.' + MINT,
  onchain: 'foxy.cashu.onchain',
  out: 'foxy.cashu.onchain.out',
  log: 'foxy.cashu.log',
  swaps: 'foxy.cashu.swaps',
  tags: 'foxy.txmeta',
};
const DAY = 86400000;

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));
/* A behaviour this suite asks for and does not get, recorded rather than
 * dropped: `broken` is true while the wallet is still wrong, and the line
 * turns into a FAIL the day it comes right, so the check gets promoted instead
 * of quietly going back to sleep. Used here for one thing only — the on-chain
 * refund, which currently returns no ecash at all (tests/onchain-faults.js has
 * the mechanism and the reproduction). */
const losing = (name, broken, detail) => results.push(broken
  ? 'MONEY  ' + name + '  — ' + detail
  : 'FAIL  ' + name + '  — the money comes back now; make it a plain check');
const sum = (list) => (list || []).reduce((n, p) => n + Number(p.amount || 0), 0);
const said = (e) => String((e && e.message) || e || '');

/* A mint's /v1/info, with the onchain method sitting beside bolt11 in each
 * group — the wallet has to pick it out, not take the first method it sees. */
function info(mintMethod, meltMethod, extra) {
  const group = (m) => ({
    methods: [{ method: 'bolt11', unit: 'sat' }]
      .concat(m ? [Object.assign({ method: 'onchain', unit: 'sat' }, m)] : []),
    disabled: false,
  });
  return { name: 'stub', nuts: Object.assign({
    4: group(mintMethod), 5: group(meltMethod), 20: { supported: true },
  }, extra || {}) };
}

/* Everything the stub answers, read when the call is made so one page can walk
 * a flow and change the mint's mind between steps. */
function box(over) {
  return Object.assign({
    info: info({ min_amount: 10000, max_amount: 1000000, options: { confirmations: 3 } },
               { min_amount: 10000, max_amount: 1000000 }),
    infoAsks: 0,
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    quoteId: 'oc-mint-1',
    seen: { amount_paid: 0, amount_issued: 0 },
    claimAsked: [],                 // [amount, quote-as-passed, privkey] of every mintProofsOnchain
    feeOptions: [{ fee_index: 0, fee_reserve: 500, estimated_blocks: 1 }],
    meltQuoteId: 'oc-melt-1',
    meltAsked: [],
    melt: { state: 'PENDING', change: [] },
    meltThrows: null,
    follow: { state: 'PENDING', outpoint: '' },
    inputFee: 0,                    // what the mint charges to swap this pile (NUT-02)
    splitFee: 0,                    // what the split actually consumes
    sendAsked: [],
    checked: [],                    // secrets the wallet asked the mint about (checkProofsStates)
    onMelt: null,                   // the test's chance to look at disk mid-melt
  }, over || {});
}

function cashuFor(m) {
  class Wallet {
    constructor(url) {
      this.mintUrl = typeof url === 'string' ? url : (url && url.mintUrl);
      this.keysetId = '00b4cd27d8861a44';
      this.on = { countersReserved: () => () => {} };
    }
    loadMint() { return Promise.resolve(); }
    getKeySets() { return Promise.resolve([{ id: this.keysetId, unit: 'sat' }]); }
    getMintInfo() { return { isSupported: () => ({ supported: true }) }; }
    checkProofsStates(ps) {
      // what the refund asked about, so a check that never reaches the mint is visible
      m.checked = m.checked.concat((ps || []).map(p => p && p.secret));
      return Promise.resolve((ps || []).map(() => ({ state: 'UNSPENT' })));
    }
    checkMintQuoteBolt11() { return Promise.resolve({ state: 'UNPAID' }); }
    getFeesForProofs() { return m.inputFee; }
    // present so quoteLock() offers a NUT-20 key; never called on this path
    createLockedMintQuote() { return Promise.reject(new Error('not this path')); }

    createMintQuoteOnchain(pubkey) {
      if (!m.address) return Promise.resolve({ quote: m.quoteId, request: '', pubkey: pubkey });
      return Promise.resolve({ quote: m.quoteId, request: m.address, pubkey: pubkey,
        amount_paid: 0, amount_issued: 0, unit: 'sat' });
    }
    checkMintQuoteOnchain(id) {
      return Promise.resolve(Object.assign({ quote: id, request: m.address, unit: 'sat' }, m.seen));
    }
    mintProofsOnchain(amount, quote, privkey) {
      m.claimAsked.push({ amount: amount, quote: quote, privkey: privkey });
      return Promise.resolve([proof(amount)]);
    }

    createMeltQuoteOnchain(address, amount) {
      return Promise.resolve({ quote: m.meltQuoteId, request: address, amount: amount,
        unit: 'sat', state: 'UNPAID', expiry: 1800000000, fee_options: m.feeOptions });
    }
    send(amount, have) {
      m.sendAsked.push({ amount: amount, have: sum(have) });
      const keep = sum(have) - amount - m.splitFee;
      return Promise.resolve({ send: [proof(amount)], keep: keep > 0 ? [proof(keep)] : [] });
    }
    meltProofsOnchain(quote, spending, feeIndex) {
      m.meltAsked.push({ quote: quote, spending: spending, feeIndex: feeIndex });
      if (m.onMelt) m.onMelt();
      if (m.meltThrows) return Promise.reject(new Error(m.meltThrows));
      return Promise.resolve(m.melt);
    }
    checkMeltQuoteOnchain(id) { return Promise.resolve(Object.assign({ quote: id }, m.follow)); }
  }
  let keys = 0;
  return {
    Wallet, Mint: Wallet, getDecodedToken: t => t, getEncodedToken: t => t,
    // enough of NUT-20 for quoteLock(): a fresh key per quote, as the mint expects
    createRandomSecretKey: () => new Uint8Array(32).fill(++keys & 255),
    getPubKeyFromPrivKey: (sk) => new Uint8Array(33).fill(sk[0]),
  };
}

/* A page on that mint, connected, with the bridge answering /v1/info — which
 * is how onchainLimits reaches the mint, through FoxyWallet.nativeRequest. */
async function page(over, at) {
  const m = box(over);
  const ctx = load({
    cashu: cashuFor(m),
    bridge: (win, msg) => {
      if (msg.action !== 'mintRequest') return;
      let text = '200\n{}';
      if (/\/v1\/info$/.test(String(msg.url))) {
        m.infoAsks += 1;
        text = '200\n' + JSON.stringify(m.info);
      }
      setTimeout(() => win.FoxyWallet._scanResult(msg.id, text, null), 0);
    },
  });
  await ctx.W.connect(at || MINT, { remember: true });
  const read = (key, fallback) => JSON.parse(ctx.storage.getItem(key) || fallback);
  return {
    W: ctx.W, m: m, storage: ctx.storage, read: read,
    write: (key, text) => ctx.storage.setItem(key, text),
    pile: () => sum(read(K.proofs, '[]')),
    out: (quote) => read(K.out, '[]').filter(r => r.quote === quote)[0] || null,
    entry: (hash) => read(K.log, '[]').filter(e => e.hash === hash)[0] || null,
    /* A clean slate between two runs through the same page: the stub keeps no
     * state of its own, so only storage has to go back. */
    reset: (sats) => {
      [K.out, K.onchain, K.log, K.swaps, K.tags].forEach(k => ctx.storage.removeItem(k));
      ctx.storage.setItem(K.proofs, JSON.stringify(sats ? [proof(sats)] : []));
      m.meltAsked = []; m.sendAsked = []; m.meltThrows = null; m.onMelt = null;
    },
  };
}

/* ---- what the mint will do on chain ------------------------------------- */

async function limits() {
  const p = await page({});

  const both = await p.W.onchainLimits();
  check('a mint that does both gives both halves',
    !!(both && both.receive && both.send), JSON.stringify(both));
  check('the receive floor is raised to Foxy’s own, whatever the mint says',
    both.receive.min === 10000, JSON.stringify(both.receive));
  check('the confirmations come off the method’s options',
    both.receive.confirmations === 3, JSON.stringify(both.receive));
  check('the ceilings are the mint’s own',
    both.receive.max === 1000000 && both.send.max === 1000000, JSON.stringify(both));
  check('the send floor is the mint’s, not raised',
    both.send.min === 10000, JSON.stringify(both.send));

  const asked = p.m.infoAsks;
  await p.W.onchainLimits();
  check('the answer is cached, so the screens may ask as often as they like',
    p.m.infoAsks === asked, 'asked ' + p.m.infoAsks + ' times, was ' + asked);

  /* A mint whose floor is above Foxy's keeps its own: the floor is a maximum
   * of the two, because either one being ignored loses the payment. */
  p.m.info = info({ min_amount: 25000, max_amount: 500000 }, null);
  await p.W.connect(MINT + '/b', { remember: false });
  const high = await p.W.onchainLimits();
  check('a different mint URL is asked afresh, not served the first one’s answer',
    p.m.infoAsks === asked + 1, 'asked ' + p.m.infoAsks + ' times');
  check('a mint floor above Foxy’s stands', high.receive.min === 25000, JSON.stringify(high.receive));
  check('a mint that takes on chain but will not pay out has no send half',
    high.send === null, JSON.stringify(high.send));
  check('and no confirmations advertised reads as none, not NaN',
    high.receive.confirmations === 0, JSON.stringify(high.receive));

  // NUT-5 lists onchain but the whole group is switched off
  const off = info({ min_amount: 10000 }, { min_amount: 10000 });
  off.nuts[5].disabled = true;
  p.m.info = off;
  await p.W.connect(MINT + '/c', { remember: false });
  const disabled = await p.W.onchainLimits();
  check('a disabled group is no method at all', disabled.send === null, JSON.stringify(disabled));

  p.m.info = info(null, null);
  await p.W.connect(MINT + '/d', { remember: false });
  const none = await p.W.onchainLimits();
  check('a mint with no onchain method anywhere gives null', none === null, JSON.stringify(none));
}

/* ---- an address, and claiming what lands on it -------------------------- */

async function receiving() {
  const p = await page({});

  const made = await p.W.onchainAddress();
  check('the address comes back with its quote and its mint',
    made.address === p.m.address && made.quote === 'oc-mint-1' && made.mint === MINT,
    JSON.stringify(made));
  const rec = p.read(K.onchain, '[]')[0];
  check('the record on disk carries the quote, the address and the mint',
    !!rec && rec.quote === 'oc-mint-1' && rec.address === p.m.address && rec.mint === MINT,
    JSON.stringify(rec));
  check('and the NUT-20 key, without which the mint never releases the ecash',
    !!rec && /^[0-9a-f]{64}$/.test(String(rec.privkey)), JSON.stringify(rec && rec.privkey));
  check('the whole quote is kept, because the claim signs NUT-20 from it',
    !!(rec && rec.answer && rec.answer.quote === 'oc-mint-1'), JSON.stringify(rec && rec.answer));
  check('onchainWatching finds it, so a restart still knows to ask',
    p.W.onchainWatching().length === 1 && p.W.onchainWatching()[0].quote === 'oc-mint-1',
    JSON.stringify(p.W.onchainWatching()));

  /* How often it is asked about. A brand new address is asked about on every
   * pass; one nobody funded in a day is asked about once an hour. It is never
   * dropped — an address stays watched for a week — but the two-minute cadence
   * for all of them cost a phone 130 circuits on a single address in an
   * afternoon, and that was the phone's whole connection. */
  check('a new address is due to be asked about at once',
    p.W.onchainDue().length === 1, JSON.stringify(p.W.onchainDue()));
  p.W.onchainAsked(['oc-mint-1']);
  check('and not again on the very next pass, having just been asked',
    p.W.onchainDue().length === 1,
    'under half an hour old it is still asked every pass');

  {
    // the same address, a day old and asked about a minute ago
    const day = p.read(K.onchain, '[]').map(r => Object.assign({}, r, {
      at: Date.now() - 26 * 3600000, checked: Date.now() - 60000,
    }));
    p.write(K.onchain, JSON.stringify(day));
    check('a day-old address asked a minute ago waits',
      p.W.onchainDue().length === 0, JSON.stringify(p.W.onchainDue()));
    p.write(K.onchain, JSON.stringify(day.map(r =>
      Object.assign({}, r, { checked: Date.now() - 3700000 }))));
    check('and is asked again an hour on, so nothing is ever abandoned',
      p.W.onchainDue().length === 1, JSON.stringify(p.W.onchainDue()));
    p.write(K.onchain, JSON.stringify(p.read(K.onchain, '[]').map(r =>
      Object.assign({}, r, { at: rec.at, checked: 0 }))));
  }

  // nothing has confirmed yet
  p.m.seen = { amount_paid: 0, amount_issued: 0 };
  const seen = await p.W.onchainSeen('oc-mint-1');
  check('onchainSeen reports the address and what the mint counts',
    seen.address === p.m.address && seen.paid === 0 && seen.issued === 0, JSON.stringify(seen));
  check('nothing confirmed claims nothing', (await p.W.onchainClaim('oc-mint-1')).sats === 0, 'it claimed something');
  check('and nothing was asked of the mint', p.m.claimAsked.length === 0, JSON.stringify(p.m.claimAsked));

  /* 30,000 in, 10,000 already issued: only the difference is claimable, and
   * only what has CONFIRMED counts — amount_paid is the mint's confirmed
   * figure, not what it has seen in the mempool. */
  p.m.seen = { amount_paid: 30000, amount_issued: 10000 };
  const got = (await p.W.onchainClaim('oc-mint-1')).sats;
  check('a claim takes what has confirmed and is not yet issued', got === 20000, String(got));
  check('the proofs land in the pile', p.pile() === 20000, String(p.pile()));
  check('the claim is handed the mint’s quote object, not its id',
    p.m.claimAsked.length === 1 && typeof p.m.claimAsked[0].quote === 'object'
      && p.m.claimAsked[0].quote.quote === 'oc-mint-1',
    JSON.stringify(p.m.claimAsked[0] && typeof p.m.claimAsked[0].quote));
  check('and the quote’s own key, so the NUT-20 signature is the right one',
    p.m.claimAsked[0].privkey === rec.privkey, String(p.m.claimAsked[0].privkey));
  const inLog = p.entry('onchain-oc-mint-1-10000');
  check('history gains a settled ON-CHAIN receipt',
    !!inLog && inLog.dir === 'in' && inLog.sats === 20000 && inLog.settled === true
      && inLog.network === 'ON-CHAIN', JSON.stringify(inLog));
  check('and it is tagged, since history names the counterparty from the tags',
    p.read(K.tags, '{}')['onchain-oc-mint-1-10000'].to === 'on chain',
    JSON.stringify(p.read(K.tags, '{}')));

  /* More than the mint will issue in one go. The rest stays credited at the
   * mint and the next pass takes it: a claim capped at the ceiling must not
   * make the remainder unreachable. */
  p.m.seen = { amount_paid: 3000000, amount_issued: 0 };
  const capped = (await p.W.onchainClaim('oc-mint-1')).sats;
  check('a claim is capped at the mint’s ceiling', capped === 1000000, String(capped));
  p.m.seen = { amount_paid: 3000000, amount_issued: 1000000 };
  const next = (await p.W.onchainClaim('oc-mint-1')).sats;
  check('and the rest is still there for the next pass', next === 1000000, String(next));

  let unknown = '';
  try { await p.W.onchainClaim('never-made'); } catch (e) { unknown = said(e); }
  check('a quote this device never made is refused',
    /not made on this device/.test(unknown), unknown || 'it was allowed');

  /* An address made at another mint. Claiming it here would derive secrets on
   * this mint's keyset for another mint's quote. */
  p.storage.setItem(K.onchain, JSON.stringify(
    [{ quote: 'elsewhere', address: 'bc1qelsewhere', mint: OTHER, at: Date.now(), issued: 0 }]));
  let wrongMint = '';
  try { await p.W.onchainClaim('elsewhere'); } catch (e) { wrongMint = said(e); }
  check('an address made at another mint is refused here',
    /belongs to other\.test/.test(wrongMint), wrongMint || 'it was allowed');

  // the mint answered with no address at all: an error, and nothing written down
  p.storage.removeItem(K.onchain);
  p.m.address = '';
  let noAddress = '';
  try { await p.W.onchainAddress(); } catch (e) { noAddress = said(e); }
  check('a mint that gives no address is an error',
    /did not give an address/.test(noAddress), noAddress || 'it was allowed');
  check('and nothing is written down for an address that does not exist',
    p.read(K.onchain, '[]').length === 0, JSON.stringify(p.read(K.onchain, '[]')));
}

/* ---- watching: which records belong to this screen ---------------------- */

async function watching() {
  const p = await page({});
  const now = Date.now();
  p.storage.setItem(K.onchain, JSON.stringify([
    { quote: 'fresh', mint: MINT, at: now - DAY, issued: 0 },
    { quote: 'old', mint: MINT, at: now - 8 * DAY, issued: 0 },
    { quote: 'edge', mint: MINT, at: now - 6 * DAY, issued: 0 },
    { quote: 'theirs', mint: OTHER, at: now, issued: 0 },
  ]));
  const watched = p.W.onchainWatching().map(r => r.quote).sort();
  check('watching is this mint’s addresses only',
    watched.indexOf('theirs') < 0, JSON.stringify(watched));
  check('and only those inside the seven-day window Foxy sets itself',
    JSON.stringify(watched) === JSON.stringify(['edge', 'fresh']), JSON.stringify(watched));

  p.storage.setItem(K.out, JSON.stringify([
    { quote: 'pending', mint: MINT, state: 'PENDING', sats: 1 },
    { quote: 'done', mint: MINT, state: 'PAID', sats: 2 },
    { quote: 'unknown', mint: MINT, state: 'UNKNOWN', sats: 3 },
    { quote: 'theirs', mint: OTHER, state: 'PENDING', sats: 4 },
  ]));
  const sending = p.W.onchainSending().map(r => r.quote).sort();
  check('sending is this mint’s payouts that have not confirmed',
    JSON.stringify(sending) === JSON.stringify(['pending', 'unknown']), JSON.stringify(sending));

  /* `onchainForget` used to sit here, exported with no caller — the audit's
   * finding 19 pattern, and it deleted the key a payment to that address would
   * need to be claimed. Addresses now leave the list only by falling out of the
   * watch window, which is what this pins. */
  check('an address list keeps every address inside the watch window',
    p.read(K.onchain, '[]').length === 4, JSON.stringify(p.read(K.onchain, '[]').map(r => r.quote)));
}

/* ---- the fee quote ------------------------------------------------------ */

async function quoting() {
  const p = await page({});

  /* Out of order on purpose, and with a tie on blocks: fewest blocks first,
   * then cheapest, because the screen offers options[0] by default. */
  p.m.feeOptions = [
    { fee_index: 2, fee_reserve: 100, estimated_blocks: 6 },
    { fee_index: 0, fee_reserve: 500, estimated_blocks: 1 },
    { fee_index: 1, fee_reserve: 300, estimated_blocks: 1 },
  ];
  const plan = await p.W.onchainQuote('bc1qpayee', 50000);
  check('the options come back fewest blocks first, then cheapest',
    JSON.stringify(plan.options.map(o => o.index)) === JSON.stringify([1, 0, 2]),
    JSON.stringify(plan.options));
  check('each option carries its fee and its wait',
    plan.options[0].fee === 300 && plan.options[0].blocks === 1, JSON.stringify(plan.options[0]));
  check('the plan keeps the mint’s own quote, which is what the melt is given',
    !!plan.quote && plan.quote.fee_options === p.m.feeOptions && plan.id === 'oc-melt-1',
    JSON.stringify(plan.id));
  check('and the address and amount it is for',
    plan.address === 'bc1qpayee' && plan.sats === 50000, JSON.stringify([plan.address, plan.sats]));

  /* cashu-ts hands some amounts back as Amount objects, and Number() on one of
   * those is NaN — a fee reserve read as NaN sizes the split wrongly. */
  p.m.feeOptions = [{ fee_index: 0, fee_reserve: { toString: () => '250' }, estimated_blocks: 2 }];
  const wrapped = await p.W.onchainQuote('bc1qpayee', 50000);
  check('a fee reserve wrapped as an Amount object reads as its number',
    wrapped.options[0].fee === 250, JSON.stringify(wrapped.options[0]));

  p.m.feeOptions = [];
  let noFee = '';
  try { await p.W.onchainQuote('bc1qpayee', 50000); } catch (e) { noFee = said(e); }
  check('a quote with no fee option at all is an error',
    /offered no fee/.test(noFee), noFee || 'it was allowed');

  let empty = '';
  try { await p.W.onchainQuote('   ', 50000); } catch (e) { empty = said(e); }
  check('an empty address is refused', /No address to pay/.test(empty), empty || 'it was allowed');

  let zero = '';
  try { await p.W.onchainQuote('bc1qpayee', 0); } catch (e) { zero = said(e); }
  check('a zero amount is refused', /above zero/.test(zero), zero || 'it was allowed');
}

/* ---- paying: every way out of the melt ---------------------------------- */

/* A real bech32 address, forty-two characters.
 *
 * Everything else here pays `bc1qpayee`, which is nine — under the twenty
 * `shortAddress` needs before it elides anything. So no test in this file has
 * ever exercised the elision, and the detail screen shipped for weeks showing
 * `bc1qxy2kgd…v8f2sg` with no way to recover the rest. */
const LONG_ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

/* The plan the screens hand onchainPay, as onchainQuote builds it. */
function planFor(m, sats, fee, address) {
  const to = address || 'bc1qpayee';
  return {
    quote: { quote: m.meltQuoteId, request: to, amount: sats, fee_options: m.feeOptions },
    id: m.meltQuoteId, address: to, sats: sats,
    options: [{ index: 0, fee: fee, blocks: 1 }], expiry: null,
  };
}

/* What is written down about where the money went, and how. */
async function receipt() {
  const p = await page({ splitFee: 2 });
  p.reset(60000);
  const TXID = 'd4e5f6a7b8c90123456789abcdef0123456789abcdef0123456789abcdef0123';
  p.m.melt = { state: 'PENDING', change: [], outpoint: TXID + ':0' };
  const sent = await p.W.onchainPay(planFor(p.m, 50000, 1000, LONG_ADDRESS), 0);

  const tags = p.read(K.tags, '{}')['onchain-oc-melt-1'] || {};
  check('the whole address is written down, all forty-two characters',
    tags.address === LONG_ADDRESS, JSON.stringify(tags.address));
  check('and the elided form is kept beside it for the tile',
    tags.to && tags.to !== LONG_ADDRESS && tags.to.indexOf('\u2026') > 0,
    JSON.stringify(tags.to));
  /* The point of the long address: with `bc1qpayee` these two are the same
   * string and this test would pass while proving nothing. */
  check('the elision actually fired, which it never did on bc1qpayee',
    tags.to.length < LONG_ADDRESS.length, tags.to.length + ' of ' + LONG_ADDRESS.length);
  check('the mint\u2019s outpoint reaches the caller, for the app to keep',
    sent.outpoint === TXID + ':0', JSON.stringify(sent.outpoint));
}

async function paying() {
  const p = await page({ splitFee: 2 });
  const plan = () => planFor(p.m, 50000, 1000);

  /* The happy path. 60,000 held, 50,000 out with a 1,000 fee reserve: the
   * split hands over 51,000, the mint charges 2 for it, and 8,998 stays. */
  p.reset(60000);
  let onDisk = null;
  p.m.onMelt = () => { onDisk = { out: p.read(K.out, '[]'), pile: p.pile() }; };
  p.m.melt = { state: 'PENDING', change: [proof(400)] };
  const sent = await p.W.onchainPay(plan(), 0);
  check('the split asks for the amount and the fee reserve together',
    p.m.sendAsked.length === 1 && p.m.sendAsked[0].amount === 51000,
    JSON.stringify(p.m.sendAsked));
  check('the record is written BEFORE the melt, with the proofs in it',
    !!onDisk && onDisk.out.length === 1 && sum(onDisk.out[0].proofs) === 51000,
    JSON.stringify(onDisk && onDisk.out));
  check('and it says SENDING while the mint has not answered',
    !!onDisk && onDisk.out[0].state === 'SENDING', JSON.stringify(onDisk && onDisk.out[0].state));
  check('the pile is down to the change the split kept',
    !!onDisk && onDisk.pile === 8998, String(onDisk && onDisk.pile));
  check('the melt is handed the mint’s quote object and the chosen fee index',
    p.m.meltAsked.length === 1 && typeof p.m.meltAsked[0].quote === 'object'
      && p.m.meltAsked[0].quote.quote === 'oc-melt-1' && p.m.meltAsked[0].feeIndex === 0,
    JSON.stringify(p.m.meltAsked.length));
  check('PENDING resolves: the ecash is gone, the transaction is not confirmed',
    sent.state === 'PENDING' && sent.sats === 50000 && sent.quote === 'oc-melt-1',
    JSON.stringify(sent));
  check('the fee charged is the reserve less the change, plus the split’s own',
    sent.feeSats === 602, String(sent.feeSats));
  check('the unspent reserve comes back to the pile', p.pile() === 8998 + 400, String(p.pile()));
  const pendingEntry = p.entry('onchain-oc-melt-1');
  check('history holds a pending entry, not a settled one',
    !!pendingEntry && pendingEntry.state === 'pending' && pendingEntry.settled === false
      && pendingEntry.sats === 50000 && pendingEntry.feeSats === 602, JSON.stringify(pendingEntry));
  check('the payment is tagged with the address it went to',
    !!p.read(K.tags, '{}')['onchain-oc-melt-1'], JSON.stringify(p.read(K.tags, '{}')));
  /* PENDING is not the end. The mint can still fail to broadcast, and
   * onchainFollow's only way to give the ecash back is these proofs. */
  check('a PENDING payout keeps its proofs on the record',
    sum(p.out('oc-melt-1').proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  check('and it is still listed as sending', p.W.onchainSending().length === 1,
    JSON.stringify(p.W.onchainSending()));

  // PAID on the spot: the transaction confirmed before the call returned
  p.reset(60000);
  p.m.melt = { state: 'PAID', change: [], outpoint: 'abc:0' };
  const paid = await p.W.onchainPay(plan(), 0);
  check('PAID settles the history entry at once',
    (p.entry('onchain-oc-melt-1') || {}).settled === true
      && (p.entry('onchain-oc-melt-1') || {}).state === 'success',
    JSON.stringify(p.entry('onchain-oc-melt-1')));
  check('and the outpoint is carried back', paid.outpoint === 'abc:0', JSON.stringify(paid));
  check('a PAID payout holds no proofs: they are truly spent',
    (p.out('oc-melt-1').proofs || []).length === 0, JSON.stringify(p.out('oc-melt-1')));
  check('and it is no longer sending', p.W.onchainSending().length === 0,
    JSON.stringify(p.W.onchainSending()));

  // the mint refused it outright
  for (const state of ['UNPAID', 'FAILED']) {
    p.reset(60000);
    p.m.melt = { state: state };
    let refused = '';
    try { await p.W.onchainPay(plan(), 0); } catch (e) { refused = said(e); }
    check(state + ' rejects rather than resolving quietly',
      /did not take that payment/.test(refused), refused || 'it resolved');
    check(state + ' puts the ecash back in the pile',
      p.pile() === 60000 - 2, String(p.pile()));
    check(state + ' forgets the record, so nothing follows a payment that never was',
      p.out('oc-melt-1') === null, JSON.stringify(p.out('oc-melt-1')));
    check(state + ' marks the history entry failed',
      (p.entry('onchain-oc-melt-1') || {}).state === 'failed',
      JSON.stringify(p.entry('onchain-oc-melt-1')));
  }

  /* No state in the answer at all. That is not a refusal: the mint may well
   * have taken the ecash, so the payment stands and the proofs stay where
   * onchainFollow can find them. */
  p.reset(60000);
  p.m.melt = { change: [] };
  const silent = await p.W.onchainPay(plan(), 0);
  check('an answer with no state is UNKNOWN, not paid and not failed',
    silent.state === 'UNKNOWN', JSON.stringify(silent));
  check('an UNKNOWN payout keeps its proofs, or the money has nowhere to come back from',
    sum((p.out('oc-melt-1') || {}).proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  check('UNKNOWN is held in history, not settled and not failed',
    (p.entry('onchain-oc-melt-1') || {}).state === 'pending'
      && (p.entry('onchain-oc-melt-1') || {}).settled === false,
    JSON.stringify(p.entry('onchain-oc-melt-1')));

  // no answer at all: a timeout is not a refusal either
  p.reset(60000);
  p.m.meltThrows = 'the mint did not answer within 60s.';
  let threw = '';
  try { await p.W.onchainPay(plan(), 0); } catch (e) { threw = said(e); }
  check('a melt that throws rejects with the mint’s own words',
    /did not answer/.test(threw), threw || 'it resolved');
  check('and leaves the record holding the proofs, because the mint may still have taken them',
    sum((p.out('oc-melt-1') || {}).proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  check('marked UNKNOWN for onchainFollow to settle',
    (p.out('oc-melt-1') || {}).state === 'UNKNOWN', JSON.stringify(p.out('oc-melt-1')));
  check('the proofs are not in the pile as well: they are held, once',
    p.pile() === 8998, String(p.pile()));

  // not enough, counting the fee reserve: refused before anything moves
  p.reset(40000);
  p.m.meltThrows = null;
  let short = '';
  try { await p.W.onchainPay(plan(), 0); } catch (e) { short = said(e); }
  check('an amount the balance cannot cover with its fee is refused',
    /Not enough ecash/.test(short), short || 'it was allowed');
  check('and nothing moved: no split, no record, the pile as it was',
    p.m.sendAsked.length === 0 && p.read(K.out, '[]').length === 0 && p.pile() === 40000,
    JSON.stringify({ sends: p.m.sendAsked.length, pile: p.pile() }));

  /* The mint's own swap fee counts too: 51,000 held against 51,000 owed is
   * not enough when the split itself costs something. */
  p.reset(51000);
  p.m.inputFee = 5;
  let byFive = '';
  try { await p.W.onchainPay(plan(), 0); } catch (e) { byFive = said(e); }
  check('the mint’s input fee is counted before the split is attempted',
    /Not enough ecash/.test(byFive) && p.m.sendAsked.length === 0, byFive || 'it was allowed');
  p.m.inputFee = 0;

  // a fee index the quote never offered
  p.reset(60000);
  let noSuchFee = '';
  try { await p.W.onchainPay(plan(), 7); } catch (e) { noSuchFee = said(e); }
  check('a fee index this quote does not offer is refused',
    /not one this quote offers/.test(noSuchFee), noSuchFee || 'it was allowed');
  check('and that too moves nothing',
    p.m.sendAsked.length === 0 && p.pile() === 60000, String(p.pile()));

  let noPlan = '';
  try { await p.W.onchainPay(null, 0); } catch (e) { noPlan = said(e); }
  check('no quote at all is refused', /No quote to pay/.test(noPlan), noPlan || 'it was allowed');
}

/* ---- following a payout to its end -------------------------------------- */

async function following() {
  const p = await page({});
  /* `old` puts the record's clock back, rather than the test sleeping: UNPAID
   * is only the mint's verdict once the melt cannot still be in flight. */
  const held = (old) => [{ quote: 'oc-melt-1', address: 'bc1qpayee', sats: 50000, feeSats: 600,
    splitFee: 2, proofs: [proof(51000)], at: Date.now() - (old || 0), mint: MINT, state: 'PENDING' }];
  const WAITED = 3 * 60000;
  const entry = () => [{ hash: 'onchain-oc-melt-1', dir: 'out', sats: 50000, feeSats: 600,
    settled: false, state: 'pending', mint: MINT, at: 1 }];

  p.reset(8998);
  p.storage.setItem(K.out, JSON.stringify(held()));
  p.storage.setItem(K.log, JSON.stringify(entry()));
  p.m.follow = { state: 'PAID', outpoint: 'txid:1' };
  const confirmed = await p.W.onchainFollow('oc-melt-1');
  check('PAID comes back with the outpoint and what was sent',
    confirmed.state === 'PAID' && confirmed.sats === 50000 && confirmed.outpoint === 'txid:1',
    JSON.stringify(confirmed));
  check('PAID settles the history entry',
    (p.entry('onchain-oc-melt-1') || {}).settled === true, JSON.stringify(p.entry('onchain-oc-melt-1')));
  check('PAID clears the held proofs, since they are spent for good',
    (p.out('oc-melt-1').proofs || []).length === 0, JSON.stringify(p.out('oc-melt-1')));
  check('and the balance does not move: the money left when the mint took it',
    p.pile() === 8998, String(p.pile()));

  /* The mint never took it. This is the only way back for a payment whose melt
   * was interrupted, and it must happen exactly once — but not immediately.
   *
   * A melt whose answer never arrived may be reaching the mint at this moment,
   * and the mint reads UNPAID until it lands. So UNPAID is not a verdict until
   * the record is old enough that nothing can still be in flight; handed back
   * at once, the ecash was spendable while the payout could still go through,
   * and if it did it was gone twice with no record left. FAILED is different:
   * it is the mint's verdict on a payment it tried, and needs no wait. */
  p.reset(8998);
  p.storage.setItem(K.out, JSON.stringify(held()));        // made a moment ago
  p.storage.setItem(K.log, JSON.stringify(entry()));
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  const soon = await p.W.onchainFollow('oc-melt-1');
  check('a payout made moments ago reading UNPAID is still pending, not refused',
    soon.state === 'PENDING' && soon.sats === 50000, JSON.stringify(soon));
  check('its proofs stay on the record while the melt could still land',
    sum((p.out('oc-melt-1') || {}).proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  check('the pile is not given ecash that may yet be spent', p.pile() === 8998, String(p.pile()));
  check('history is not marked failed on a payment that may still go',
    (p.entry('onchain-oc-melt-1') || {}).state === 'pending',
    JSON.stringify(p.entry('onchain-oc-melt-1')));
  check('and it stays on the watch list to be asked again',
    p.W.onchainSending().length === 1, JSON.stringify(p.W.onchainSending()));

  // UNPAID once the wait is over, and FAILED whether or not it is
  for (const [state, old] of [['UNPAID', WAITED], ['FAILED', 0]]) {
    p.reset(8998);
    p.storage.setItem(K.out, JSON.stringify(held(old)));
    p.storage.setItem(K.log, JSON.stringify(entry()));
    p.m.follow = { state: state, outpoint: '' };
    const back = await p.W.onchainFollow('oc-melt-1');
    check(state + ' reports what was at stake', back.sats === 50000 && back.state === state,
      JSON.stringify(back));
    check(state + ' marks the history entry failed and done',
      (p.entry('onchain-oc-melt-1') || {}).state === 'failed'
        && (p.entry('onchain-oc-melt-1') || {}).settled === true,
      JSON.stringify(p.entry('onchain-oc-melt-1')));
    check(state + ' forgets the record', p.out('oc-melt-1') === null,
      JSON.stringify(p.out('oc-melt-1')));
    /* The ecash comes back. It briefly did not: the unspent check went through
     * `liveUnheld`, which drops whatever `everyHeldProof()` names — and that
     * reads this very record, so every proof was its own reason to be dropped
     * and the record was then deleted. The check is against the pile and the
     * mint now (16a-onchain.js), and this line is what would catch it again. */
    check(state + ' puts the held proofs back in the pile',
      p.pile() === 8998 + 51000, String(p.pile()));
    check(state + ' asked the mint whether they were still unspent',
      p.m.checked.length > 0, JSON.stringify(p.m.checked.length));
    const again = await p.W.onchainFollow('oc-melt-1');
    check(state + ' acts once, however often it is asked',
      p.pile() === 8998 + 51000 && again.sats === 0, String(p.pile()));
  }

  // still on its way: nothing changes hands
  p.reset(8998);
  p.storage.setItem(K.out, JSON.stringify(held()));
  p.m.follow = { state: 'PENDING', outpoint: '' };
  await p.W.onchainFollow('oc-melt-1');
  check('PENDING leaves the proofs held and the pile alone',
    p.pile() === 8998 && sum(p.out('oc-melt-1').proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));

  // a quote with no record at all — a cleared install, a forgotten payment
  p.reset(8998);
  p.m.follow = { state: 'PAID', outpoint: 'txid:2' };
  const orphan = await p.W.onchainFollow('nothing-here');
  check('a quote with no record answers rather than crashing',
    orphan.state === 'PAID' && orphan.sats === 0, JSON.stringify(orphan));
}

async function run() {
  await limits();
  await receiving();
  await watching();
  await quoting();
  await paying();
  await following();
  await receipt();

  /* ---- the network sheet, under the mint's floor --------------------------
   *
   * On chain below the floor the payment is swallowed rather than refused, so the
   * network used to be listed like any other and refuse on the tap, with the
   * reason in a toast — the person chose a network, watched the sheet close, and
   * read why two seconds later somewhere else. It is greyed with the number under
   * its name instead. */
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
    check('the sheet decides it, rather than the tap refusing it',
      /const barred = o\.rail === 'ON-CHAIN' && this\.ocReceiveBlocked\(sats\)/.test(src));
    check('greyed, with the minimum under its name',
      /off: barred, offWhy: barred \? this\.ocFloorShort\(\) : ''/.test(src));
    check('and the tap no longer refuses or toasts',
      /tap: \(\) => pick\(o\.rail\)/.test(src)
      && !/this\.toast\(this\.ocFloorSays\(\), true\)/.test(src),
      'the sheet is where the answer belongs');
    check('a greyed row is not a control: it does nothing and the sheet stays open',
      /row\.addEventListener\('click', \(\) => \{ if \(off\) return;/.test(src));
    check('and a network this amount cannot use cannot be made the default',
      /makeDefault: \(!barred && W && W\.defaultRail\)/.test(src));
    check('the short form is the number, which is what fits on that line',
      /return 'Minimum \\u20bf ' \+ this\.group\(floor\)/.test(src));
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  const money = results.filter(r => r.startsWith('MONEY'));
  if (failed) { console.log('\n' + failed + ' on-chain check(s) failed'); process.exit(1); }
  // the last line is the only one check-all.sh prints, so it carries the worst of it
  console.log('\nall ' + results.length + ' on-chain flow checks pass'
    + (money.length ? ' — but ' + money.length + ' MONEY-LOSING regressions are pinned, not '
        + 'fixed: the on-chain refund returns no ecash at all' : ''));
  // jsdom leaves its timers running, and the wallet's background checks with them
  process.exit(0);
}

run().catch(e => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
