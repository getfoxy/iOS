'use strict';
/* onchain-faults.js — the NUT-30 money paths, against a mint that goes wrong.
 *
 *     node tests/onchain-faults.js
 *
 * tests/onchain-flow.js is the sibling of this file: it walks the same state
 * machine against a mint that does as it is told. This one breaks things. The
 * Lightning melt has had tools/live/faults.js for a while — a proxy that drops
 * the answer after the mint has acted, returns 500s, and hangs — because that
 * is where money goes missing. Until now nothing did the same to the on-chain
 * path, and the one bug found there by hand is exactly of that family:
 * onchainPay cleared the proofs off its own record when the mint answered
 * PENDING, so a payout that later came back UNPAID had nothing to give back.
 *
 * What is checked, everywhere, is WHERE THE MONEY IS — not what a call
 * returned. The on-chain path is held to the Lightning path's invariant
 * (16-sending.js, holdMelt/sweepMelts): after any fault the sats are either in
 * the pile, or on a record that can still get them back, and never in both.
 * `places()` below is that invariant written out, and every scenario ends by
 * asking it.
 *
 * The faults pinned here, each one a way an answer can go wrong:
 *
 *   - lost after the mint acted (the melt ran, the call rejected)
 *   - lost before it acted (the mint never saw it)
 *   - the process dying between the record and the melt, and between the melt
 *     and the answer — done by taking the whole of localStorage mid-melt and
 *     starting a second page from it, which is what a killed app is
 *   - a state check that itself fails: a 500, a network throw, a body that is
 *     not a quote, a state Foxy has never heard of
 *   - a melt answer whose change is unusable
 *   - two watchers racing on one quote, and a watcher landing in the middle of
 *     a payment's split — the on-chain paths hold the proof lock
 *     (99-proof-lock-and-export.js), and what is checked is that the second
 *     one waits its turn rather than writing the pile inside the first one's
 *     read-then-write window
 *   - the route down, which is when a poller must not reach the mint at all
 *   - the receive side: a claim whose answer is lost after the mint signed the
 *     outputs, the rebuilding of that ecash from the counters it burnt, and a
 *     mint that has issued more than Foxy knew
 *   - an address quote the mint has forgotten
 *
 * Every scenario races a five-second clock (`within`). Nothing here does real
 * work, so a scenario that takes longer is not slow, it is stuck — one money
 * path waiting on a lock another holds — and a suite that hangs on CI has to
 * be killed by hand and reports nothing at all. A stuck scenario fails and the
 * rest still run.
 *
 * A check named `known` is an expected failure: the wallet is wrong today, the
 * check records what it does, and it turns into a FAIL the day the behaviour
 * changes — so a fix cannot land unnoticed and a regression cannot hide. Each
 * one names the file and line it is about.
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
  quotes: 'foxy.cashu.quotes',
  quotesOld: 'foxy.cashu.quotes.old',
  move: 'foxy.cashu.move',
  swaps: 'foxy.cashu.swaps',
  log: 'foxy.cashu.log',
  tags: 'foxy.txmeta',
};
const DAY = 86400000;

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));
/* An expected failure. `broken` is true while the wallet still does the wrong
 * thing; `detail` says what it does and where. When it stops being true the
 * line turns into a FAIL, because the check then needs promoting to a plain
 * one — an expected failure that quietly starts passing is how a suite goes
 * back to sleep. */
const known = (name, broken, detail) => results.push(broken
  ? 'known  ' + name + '  — ' + detail
  : 'FAIL  ' + name + '  — this behaves now; make it a plain check');
/* The same, for a shortcoming that LOSES SATS rather than merely reading
 * wrongly. It is kept out of the failure count for the same reason `known` is
 * — a suite nobody can make green stops being run — but it is counted
 * separately and named in the last line, which is the only line check-all.sh
 * prints. A green run that is destroying money still has to say so. */
const losing = (name, broken, detail) => results.push(broken
  ? 'MONEY  ' + name + '  — ' + detail
  : 'FAIL  ' + name + '  — the money comes back now; make it a plain check');
const sum = (list) => (list || []).reduce((n, p) => n + Number(p.amount || 0), 0);
const said = (e) => String((e && e.message) || e || '');

/* A scenario that hangs must fail, not hang.
 *
 * The on-chain paths are inside the proof lock (99-proof-lock-and-export.js),
 * so a future change that makes one of them wait on another — or a test that
 * calls one from inside a stub the outer call is awaiting — stops resolving
 * rather than returning a wrong answer. A suite that hangs on CI says nothing
 * at all and has to be killed by hand, so every scenario races a clock and a
 * scenario that loses says so as a FAIL, with the others still run. */
const DEADLOCK = { deadlocked: true };
function within(seconds, name, work) {
  let timer = null;
  const clock = new Promise((r) => { timer = setTimeout(() => r(DEADLOCK), seconds * 1000); });
  return Promise.race([Promise.resolve().then(work), clock]).then((out) => {
    clearTimeout(timer);
    if (out === DEADLOCK) {
      check(name + ' finishes', false,
        'deadlocked: nothing resolved in ' + seconds + 's. Something inside it is waiting on a '
        + 'lock its own caller holds — see the proof lock’s list in 99-proof-lock-and-export.js');
    }
    return out;
  }, (e) => { clearTimeout(timer); throw e; });
}

/* A mint's /v1/info, with the onchain method beside bolt11 in each group. */
function info(mintMethod, meltMethod) {
  const group = (m) => ({
    methods: [{ method: 'bolt11', unit: 'sat' }]
      .concat(m ? [Object.assign({ method: 'onchain', unit: 'sat' }, m)] : []),
    disabled: false,
  });
  return { name: 'stub', nuts: {
    4: group(mintMethod), 5: group(meltMethod), 20: { supported: true },
  } };
}

/* Everything the stub answers, read when the call is made, plus the faults.
 * onchain-flow.js's box with the ways of going wrong added: each `*Throws` is
 * an answer that never arrives, and `tookIt` records that the mint acted even
 * when it did not say so — which is the whole point of this suite. */
function box(over) {
  return Object.assign({
    info: info({ min_amount: 10000, max_amount: 1000000, options: { confirmations: 3 } },
               { min_amount: 10000, max_amount: 1000000 }),
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    quoteId: 'oc-mint-1',
    seen: { amount_paid: 0, amount_issued: 0 },
    seenFor: {},                    // quote id -> its own answer
    seenThrowsFor: {},              // quote id -> the mint's refusal for that one
    claimAsked: [],
    claimThrows: null,              // the claim's answer never arrives
    claimSigns: false,              // ...but the mint reserved counters and signed first
    reserved: [],                   // the counter-reservation listeners cashu-ts would fire
    counter: 40,                    // where the next reservation starts
    feeOptions: [{ fee_index: 0, fee_reserve: 500, estimated_blocks: 1 }],
    meltQuoteId: 'oc-melt-1',
    meltAsked: [],
    melt: { state: 'PENDING', change: [] },
    meltThrows: null,
    tookIt: false,                  // the melt body ran: the mint has the ecash
    follow: { state: 'PENDING', outpoint: '' },
    followThrows: null,
    followBody: undefined,          // a body that is not a quote at all
    inputFee: 0,
    splitFee: 0,
    sendAsked: [],
    onMelt: null,                   // the test's chance to look at disk mid-melt
    onSend: null,                   // ...and to start something else mid-split
    onSendDone: null,               // ...and to look again just before the split answers
    restorable: [],                 // [{ keysetId, start, count, proofs }] the mint would hand back
    restoreAsked: [],
    spent: [],                      // secrets the mint has already taken (NUT-07)
    statesAsked: 0,                 // how often the mint was asked about proof states
    statesAskedAbout: [],
  }, over || {});
}

function cashuFor(m) {
  class Wallet {
    constructor(url) {
      this.mintUrl = typeof url === 'string' ? url : (url && url.mintUrl);
      this.keysetId = '00b4cd27d8861a44';
      /* The real cashu-ts fires this as it reserves counters, BEFORE the
       * request leaves — which is how the wallet knows what a lost answer
       * burnt. The stub keeps the listeners so a fault can fire them. */
      this.on = { countersReserved: (fn) => {
        m.reserved.push(fn);
        return () => { m.reserved = m.reserved.filter((x) => x !== fn); };
      } };
    }
    loadMint() { return Promise.resolve(); }
    getKeySets() { return Promise.resolve([{ id: this.keysetId, unit: 'sat' }]); }
    getMintInfo() { return { isSupported: () => ({ supported: true }) }; }
    /* NUT-07. `m.spent` is the secrets the mint has already taken — what a
     * refund must not hand back, and what liveUnheld exists to find. */
    checkProofsStates(ps) {
      m.statesAsked += 1;
      (ps || []).forEach(p => m.statesAskedAbout.push(p && p.secret));
      return Promise.resolve((ps || []).map(
        (p) => ({ state: m.spent.indexOf(p && p.secret) >= 0 ? 'SPENT' : 'UNSPENT' })));
    }
    checkMintQuoteBolt11() { return Promise.resolve({ state: 'UNPAID' }); }
    getFeesForProofs() { return m.inputFee; }
    createLockedMintQuote() { return Promise.reject(new Error('not this path')); }

    createMintQuoteOnchain(pubkey) {
      return Promise.resolve({ quote: m.quoteId, request: m.address, pubkey: pubkey,
        amount_paid: 0, amount_issued: 0, unit: 'sat' });
    }
    checkMintQuoteOnchain(id) {
      if (m.seenThrowsFor[id]) return Promise.reject(new Error(m.seenThrowsFor[id]));
      const seen = m.seenFor[id] || m.seen;
      return Promise.resolve(Object.assign({ quote: id, request: m.address, unit: 'sat' }, seen));
    }
    mintProofsOnchain(amount, quote, privkey) {
      m.claimAsked.push({ amount: amount, quote: quote, privkey: privkey });
      // the mint signed: the counters for these outputs are burnt either way
      if (m.claimSigns) {
        const range = { keysetId: this.keysetId, start: m.counter, count: 4 };
        m.counter += 4;
        // how many listeners the wallet had on the reservation when it signed,
        // so a check about what was recorded cannot pass because nobody looked
        m.watchers = m.reserved.length;
        m.reserved.slice().forEach((fn) => fn(range));
      }
      if (m.claimThrows) return Promise.reject(new Error(m.claimThrows));
      return Promise.resolve([proof(amount)]);
    }

    createMeltQuoteOnchain(address, amount) {
      return Promise.resolve({ quote: m.meltQuoteId, request: address, amount: amount,
        unit: 'sat', state: 'UNPAID', expiry: 1800000000, fee_options: m.feeOptions });
    }
    /* The split. `onSend` is the window a second money path can start in — it
     * is CALLED, never awaited, because the on-chain paths hold the proof lock
     * and awaiting one from in here would be waiting on the lock the split's
     * own caller holds. What it starts is left to run; the test awaits it
     * afterwards. The answer comes back on a macrotask so that everything
     * already queued as a microtask has run first: without the lock the second
     * path would then certainly have written the pile before this split's
     * `setProofs` lands, which is the race being pinned. */
    send(amount, have) {
      m.sendAsked.push({ amount: amount, have: sum(have) });
      const keep = sum(have) - amount - m.splitFee;
      if (m.onSend) m.onSend();
      return new Promise((resolve) => setTimeout(() => {
        // the last look at disk before the split answers: whatever onSend
        // started has had every microtask it could want by now
        if (m.onSendDone) m.onSendDone();
        resolve({ send: [proof(amount)], keep: keep > 0 ? [proof(keep)] : [] });
      }, 0));
    }

    /* NUT-09. What the mint signed for a counter range, for rebuilding ecash
     * whose answer never arrived. */
    restore(start, count, opts) {
      const id = String((opts && opts.keysetId) || '');
      m.restoreAsked.push({ start: start, count: count, keysetId: id });
      const row = m.restorable.filter(r => r.keysetId === id
        && start < r.start + r.count && r.start < start + count)[0];
      return Promise.resolve({ proofs: (row && row.proofs) || [] });
    }
    meltProofsOnchain(quote, spending, feeIndex) {
      m.meltAsked.push({ quote: quote, spending: spending, feeIndex: feeIndex });
      /* The mint has the ecash from here on, whatever it manages to say about
       * it: a rejection below is a lost answer, not a refusal. */
      m.tookIt = true;
      if (m.onMelt) m.onMelt();
      if (m.meltThrows) return Promise.reject(new Error(m.meltThrows));
      return Promise.resolve(m.melt);
    }
    checkMeltQuoteOnchain(id) {
      if (m.followThrows) return Promise.reject(m.followThrows);
      if (m.followBody !== undefined) return Promise.resolve(m.followBody);
      return Promise.resolve(Object.assign({ quote: id }, m.follow));
    }
  }
  let keys = 0;
  return {
    Wallet, Mint: Wallet, getDecodedToken: t => t, getEncodedToken: t => t,
    createRandomSecretKey: () => new Uint8Array(32).fill(++keys & 255),
    getPubKeyFromPrivKey: (sk) => new Uint8Array(33).fill(sk[0]),
  };
}

/* Everything in a page's storage, as load()'s `storage` takes it: this is what
 * survives the app being killed, and the only thing that does. */
function snapshot(storage) {
  const out = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    out[key] = storage.getItem(key);
  }
  return out;
}

/* A page on that mint, connected, with the bridge answering /v1/info.
 *
 * `was` is a storage snapshot to start from — a page that opens onto an
 * install that already had records on it, which is the only way to test a
 * process that died. The sweeps are pushed ten minutes out so that background
 * work cannot land in the middle of a scenario: what is being timed here is
 * the fault, not the sweep.
 */
async function page(over, was) {
  const m = box(over);
  const ctx = load({
    cashu: cashuFor(m),
    storage: was || undefined,
    sweepPause: [600000, 600000],
    keysetCheckDelay: [600000, 600000],
    bridge: (win, msg) => {
      if (msg.action !== 'mintRequest') return;
      let text = '200\n{}';
      if (/\/v1\/info$/.test(String(msg.url))) text = '200\n' + JSON.stringify(m.info);
      setTimeout(() => win.FoxyWallet._scanResult(msg.id, text, null), 0);
    },
  });
  await ctx.W.connect(MINT, { remember: true });
  const read = (key, fallback) => JSON.parse(ctx.storage.getItem(key) || fallback);
  const p = {
    W: ctx.W, m: m, storage: ctx.storage, read: read,
    pile: () => sum(read(K.proofs, '[]')),
    piled: () => read(K.proofs, '[]'),
    out: (quote) => read(K.out, '[]').filter(r => r.quote === quote)[0] || null,
    addr: (quote) => read(K.onchain, '[]').filter(r => r.quote === quote)[0] || null,
    entry: (hash) => read(K.log, '[]').filter(e => e.hash === hash)[0] || null,
    snapshot: () => snapshot(ctx.storage),
    /* Put a payout's clock back, rather than sleeping: UNPAID is only a
     * verdict once the record is old enough that the melt cannot still be on
     * its way (ONCHAIN_UNPAID_WAIT, mirrored from the Lightning side's W4). */
    age: (quote, ms) => {
      const list = read(K.out, '[]');
      list.forEach(r => { if (r.quote === quote) r.at = Date.now() - ms; });
      ctx.storage.setItem(K.out, JSON.stringify(list));
    },
    reset: (sats) => {
      [K.out, K.onchain, K.log, K.swaps, K.tags, K.quotes, K.quotesOld, K.move]
        .forEach(k => ctx.storage.removeItem(k));
      ctx.storage.setItem(K.proofs, JSON.stringify(sats ? [proof(sats)] : []));
      m.meltAsked = []; m.sendAsked = []; m.claimAsked = []; m.restoreAsked = [];
      m.meltThrows = null; m.claimThrows = null; m.followThrows = null;
      m.followBody = undefined; m.onMelt = null; m.onSend = null; m.onSendDone = null;
      m.tookIt = false; m.restorable = []; m.spent = [];
      m.statesAsked = 0; m.statesAskedAbout = [];
    },
  };
  return p;
}

/* ---- where the money is ------------------------------------------------- */

/* Every proof this install knows about, and everywhere it is sitting. The
 * invariant: one place each. In the pile means spendable; on a record means
 * handed to a melt that has not been settled, and the record is what gives it
 * back. In both means the same sats counted twice, and in neither means they
 * are gone. */
function places(p) {
  const at = {};
  const note = (list, where) => (Array.isArray(list) ? list : []).forEach((x) => {
    if (!x || !x.secret) return;
    (at[x.secret] = at[x.secret] || []).push(where);
  });
  note(p.read(K.proofs, '[]'), 'pile');
  p.read(K.out, '[]').forEach(r => note(r.proofs, 'out:' + r.quote));
  return at;
}

/* The secrets in more than one place, which must always be none. */
function twice(p) {
  const at = places(p);
  return Object.keys(at).filter(s => at[s].length > 1);
}

/* Every counter range this install has on record, from all four places a lost
 * answer's outputs can be written (04-lost-answers.js noteQuoteOutputs, and
 * the swap records). A claim whose answer was lost must leave its range in one
 * of them, or the ecash the mint signed is reachable only by a full seed
 * restore. */
function rangesOnRecord(p) {
  const out = [];
  const take = (r) => (r && Array.isArray(r.outputs) ? r.outputs : []).forEach(x => out.push(x));
  [K.quotes, K.quotesOld, K.onchain, K.swaps].forEach(key => p.read(key, '[]').forEach(take));
  take(p.read(K.move, 'null'));
  return out;
}

/* The plan the screens hand onchainPay, as onchainQuote builds it. */
function planFor(m, sats, fee) {
  return {
    quote: { quote: m.meltQuoteId, request: 'bc1qpayee', amount: sats, fee_options: m.feeOptions },
    id: m.meltQuoteId, address: 'bc1qpayee', sats: sats,
    options: [{ index: 0, fee: fee, blocks: 1 }], expiry: null,
  };
}

/* A payout in flight, written as onchainPay writes it, and its history line. */
const heldRecord = (over) => Object.assign({
  quote: 'oc-melt-1', address: 'bc1qpayee', sats: 50000, feeSats: 0, splitFee: 2,
  proofs: [proof(51000)], at: Date.now(), mint: MINT, state: 'PENDING',
}, over || {});
const heldEntry = () => ({ hash: 'onchain-oc-melt-1', dir: 'out', sats: 50000, feeSats: 602,
  settled: false, state: 'pending', mint: MINT, network: 'ON-CHAIN', at: 1 });
/* Older than the wait UNPAID is held for. A payout the watcher is following is
 * normally minutes old, so this is the ordinary case, not the exotic one. */
const OLD = 3 * 60000;
const agedRecord = (over) => heldRecord(Object.assign({ at: Date.now() - OLD }, over || {}));

/* ---- 1 and 2: the melt answer is lost -----------------------------------
 *
 * The call rejects after the mint has acted. That is not a refusal and must
 * never be read as one: the mint may hold the ecash, so the proofs stay on the
 * record and the mint is asked afterwards what became of them. Both endings
 * are walked here with the real onchainPay in front of the real onchainFollow,
 * which is the pairing that matters — onchain-flow.js checks each half on its
 * own, against records built by hand.
 */
async function lostMeltAnswer() {
  const p = await page({ splitFee: 2 });
  const plan = () => planFor(p.m, 50000, 1000);

  /* 60,000 held. The split hands the melt 51,000 and the mint charges 2 sats
   * for making it, so 8,998 is left in the pile before the melt is sent. */
  p.reset(60000);
  p.m.meltThrows = 'the mint did not answer within 60s.';
  let lost = '';
  try { await p.W.onchainPay(plan(), 0); } catch (e) { lost = said(e); }
  check('a melt whose answer never arrives rejects with the mint’s own words',
    /did not answer/.test(lost), lost || 'it resolved');
  check('the mint did act: this is a lost answer, not a refusal',
    p.m.tookIt && p.m.meltAsked.length === 1, JSON.stringify(p.m.meltAsked.length));
  check('the record keeps the proofs, which are now the only way back',
    sum((p.out('oc-melt-1') || {}).proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  check('the pile does not have them as well',
    p.pile() === 8998, String(p.pile()));
  check('so no proof is in two places at once', twice(p).length === 0, JSON.stringify(twice(p)));
  check('the record is marked UNKNOWN, for the follow to settle',
    (p.out('oc-melt-1') || {}).state === 'UNKNOWN', JSON.stringify(p.out('oc-melt-1')));
  check('and it is listed as sending, so the watcher will ask',
    p.W.onchainSending().length === 1, JSON.stringify(p.W.onchainSending()));
  /* 51,000 sats have left the pile and nobody yet knows whether the mint took
   * them. That is precisely a payment in progress, and history has to say so —
   * without an entry there is nothing for onchainFollow to settle or to mark
   * failed, and the balance falls with the screen silent. */
  const pendingLine = p.entry('onchain-oc-melt-1');
  check('a lost melt answer still writes a pending line in history',
    !!pendingLine && pendingLine.state === 'pending' && pendingLine.settled === false
      && pendingLine.sats === 50000 && pendingLine.network === 'ON-CHAIN', JSON.stringify(pendingLine));
  check('charging only what is certainly gone: the split’s fee, not the reserve',
    pendingLine.feeSats === 2, String(pendingLine.feeSats));
  check('and it is tagged, so history can name where the money went',
    !!p.read(K.tags, '{}')['onchain-oc-melt-1'], JSON.stringify(p.read(K.tags, '{}')));

  /* The mint had it after all, and the transaction confirmed. The ecash is
   * spent: the proofs come off the record and must NOT reappear in the pile. */
  p.m.follow = { state: 'PAID', outpoint: 'txid:9' };
  const settled = await p.W.onchainFollow('oc-melt-1');
  check('a later follow reading PAID says so', settled.state === 'PAID' && settled.sats === 50000,
    JSON.stringify(settled));
  check('PAID clears the held proofs', (p.out('oc-melt-1').proofs || []).length === 0,
    JSON.stringify(p.out('oc-melt-1')));
  check('and does not add them back to the pile: they are truly spent',
    p.pile() === 8998, String(p.pile()));
  check('the payout stops being followed once it has confirmed',
    p.W.onchainSending().length === 0, JSON.stringify(p.W.onchainSending()));
  check('and nothing is in two places after it', twice(p).length === 0, JSON.stringify(twice(p)));
  const settledLine = p.entry('onchain-oc-melt-1');
  check('the pending line written when the answer was lost is settled by the follow',
    !!settledLine && settledLine.settled === true && settledLine.state === 'success',
    JSON.stringify(settledLine));
  check('and there is exactly one line for that payment, not one per attempt',
    p.read(K.log, '[]').filter(e => e.hash === 'onchain-oc-melt-1').length === 1,
    JSON.stringify(p.read(K.log, '[]').map(e => e.hash)));
  /* What it really cost. The entry written from the melt's error path could
   * only know the split's 2 sats: the mint's change, and with it the fee, went
   * missing with the answer. The proofs held are what went to the mint and
   * none of it came back, so the whole 51,000 less the 50,000 sent is fee. */
  check('and history is corrected to what the payment really cost',
    settledLine.feeSats === 1002, String(settledLine.feeSats));
  const beforeAgain = JSON.stringify(p.entry('onchain-oc-melt-1'));
  await p.W.onchainFollow('oc-melt-1');
  check('following it again does not raise the fee a second time',
    JSON.stringify(p.entry('onchain-oc-melt-1')) === beforeAgain,
    beforeAgain + ' became ' + JSON.stringify(p.entry('onchain-oc-melt-1')));

  /* The same fault, the other ending: the mint never received it.
   *
   * UNPAID is not a verdict while the melt could still be on its way. A melt
   * whose answer was lost may be arriving at the mint at this moment, and the
   * mint reads UNPAID until it lands — so a payout handed back at once was
   * spendable while it could still go through, and if it did it was gone twice
   * with no record left to reconcile from. */
  p.reset(60000);
  p.m.meltThrows = 'the connection was lost.';
  try { await p.W.onchainPay(plan(), 0); } catch (e) {}
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  const tooSoon = await p.W.onchainFollow('oc-melt-1');
  check('a payout seconds old reading UNPAID is still pending, not refused',
    tooSoon.state === 'PENDING' && tooSoon.sats === 50000, JSON.stringify(tooSoon));
  check('its ecash stays on the record while the melt could still land',
    sum((p.out('oc-melt-1') || {}).proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  check('the pile is not given ecash that may yet be spent',
    p.pile() === 8998, String(p.pile()));
  check('history is not marked failed on a payment that may still go',
    p.entry('onchain-oc-melt-1').state === 'pending' && p.entry('onchain-oc-melt-1').settled === false,
    JSON.stringify(p.entry('onchain-oc-melt-1')));
  check('and it stays on the watch list to be asked again',
    p.W.onchainSending().length === 1, JSON.stringify(p.W.onchainSending()));
  check('nothing is in two places while it is held', twice(p).length === 0, JSON.stringify(twice(p)));

  // past the wait, the mint's UNPAID is its verdict and the payout is given up
  p.age('oc-melt-1', OLD);
  const back = await p.W.onchainFollow('oc-melt-1');
  check('past the wait a follow reading UNPAID reports what was at stake',
    back.state === 'UNPAID' && back.sats === 50000, JSON.stringify(back));
  check('the record is forgotten, so nothing follows a payment that never was',
    p.out('oc-melt-1') === null, JSON.stringify(p.out('oc-melt-1')));
  const failedLine = p.entry('onchain-oc-melt-1');
  check('a payout the mint never took is marked failed and done in history',
    !!failedLine && failedLine.state === 'failed' && failedLine.settled === true,
    JSON.stringify(failedLine));
  check('and its line says what was attempted, so the sats coming back are explained',
    failedLine.sats === 50000 && failedLine.dir === 'out', JSON.stringify(failedLine));
  /* The 2 sats the split cost stay gone, and should: the mint made that swap
   * whatever became of the melt afterwards. The other 51,000 must come back. */
  /* Fixed the day it was written: the unspent check went through `liveUnheld`,
   * which drops whatever `everyHeldProof()` names — and that reads the very
   * record being refunded, so every proof was its own reason to be dropped, the
   * mint was never asked, and the record was then deleted. It is checked
   * against the pile and the mint now. */
  check('the 51,000 sats of a payout the mint never took go back to the pile',
    p.pile() === 8998 + 51000,
    String(p.pile()) + '; the mint was asked about '
    + JSON.stringify(p.m.statesAskedAbout.length) + ' proofs');
  check('and nothing is held twice afterwards', twice(p).length === 0, JSON.stringify(twice(p)));
  const afterOnce = p.pile();
  const again = await p.W.onchainFollow('oc-melt-1');
  check('asking a second time changes nothing: a refund happens at most once',
    p.pile() === afterOnce && again.sats === 0, String(p.pile()));
  const third = await Promise.all([p.W.onchainFollow('oc-melt-1'), p.W.onchainFollow('oc-melt-1')]);
  check('nor does asking twice at once', p.pile() === afterOnce,
    String(p.pile()) + ' ' + JSON.stringify(third.map(r => r.sats)));
}

/* ---- 3 and 4: the process dies mid-payment ------------------------------
 *
 * The truest form of this fault is not a hand-built record: it is the whole of
 * localStorage as it stood at that instant, opened by a second page. Anything
 * the first page held in memory is gone, exactly as it is when iOS kills the
 * app. The snapshot is taken inside the melt — after the record was written,
 * while the mint has not answered — which is the window both scenarios live
 * in.
 */
async function killedMidPayment() {
  const p = await page({ splitFee: 2 });
  p.reset(60000);
  let mid = null;
  p.m.onMelt = () => { mid = p.snapshot(); };
  p.m.meltThrows = 'killed';               // the first page never gets to act on an answer
  try { await p.W.onchainPay(planFor(p.m, 50000, 1000), 0); } catch (e) {}
  check('a snapshot was taken with the mint mid-melt', !!mid, 'nothing was captured');

  /* Died between the record being written and the melt being sent. The mint
   * never saw it, so every sat must come back. */
  const dead = await page({ splitFee: 2, follow: { state: 'UNPAID', outpoint: '' } }, mid);
  check('a restarted app finds the payout waiting on the mint',
    dead.W.onchainSending().length === 1 && dead.W.onchainSending()[0].quote === 'oc-melt-1',
    JSON.stringify(dead.W.onchainSending()));
  check('with its proofs still on it, which is the only copy that exists',
    sum(dead.out('oc-melt-1').proofs) === 51000, JSON.stringify(dead.out('oc-melt-1')));
  check('and the pile as the split left it, not holding them as well',
    dead.pile() === 8998, String(dead.pile()));
  check('the record says SENDING: the melt had not been answered when the app died',
    dead.out('oc-melt-1').state === 'SENDING', JSON.stringify(dead.out('oc-melt-1').state));
  check('nothing is in two places on the restarted app',
    twice(dead).length === 0, JSON.stringify(twice(dead)));
  /* The record carries the time the payment was made, and it survives the
   * kill — so an app restarted straight away still waits before giving the
   * payout up, and one restarted later does not. */
  const straightAway = await dead.W.onchainFollow('oc-melt-1');
  check('an app restarted at once holds the payout rather than refunding it',
    straightAway.state === 'PENDING' && dead.pile() === 8998
      && sum(dead.out('oc-melt-1').proofs) === 51000, JSON.stringify(straightAway));
  dead.age('oc-melt-1', OLD);
  const recovered = await dead.W.onchainFollow('oc-melt-1');
  check('past the wait the payout is given up and the record goes with it',
    recovered.state === 'UNPAID' && dead.out('oc-melt-1') === null,
    JSON.stringify(dead.out('oc-melt-1')));
  // the killed-app case is where the refund matters most: the record was the
  // only thing anywhere that knew those proofs existed
  check('a payout killed before it was sent gets its ecash back',
    dead.pile() === 8998 + 51000, String(dead.pile()));
  check('and nothing is in two places whatever it did', twice(dead).length === 0,
    JSON.stringify(twice(dead)));

  /* Died between the melt and the answer: the same record, but this time the
   * mint did take it and the transaction confirmed. Nothing may be counted
   * twice — the sats left when the mint took them. */
  const late = await page({ splitFee: 2, follow: { state: 'PAID', outpoint: 'txid:7' } }, mid);
  const before = late.pile();
  const done = await late.W.onchainFollow('oc-melt-1');
  check('a restarted app reading PAID settles the payment', done.state === 'PAID',
    JSON.stringify(done));
  check('the pile does not move: the sats went when the mint took them',
    late.pile() === before && before === 8998, String(late.pile()));
  check('the proofs come off the record, since they are spent',
    (late.out('oc-melt-1').proofs || []).length === 0, JSON.stringify(late.out('oc-melt-1')));
  check('nothing is double counted after a restart',
    twice(late).length === 0, JSON.stringify(twice(late)));
  check('and it stops being followed', late.W.onchainSending().length === 0,
    JSON.stringify(late.W.onchainSending()));
  /* History, after a kill. The record with the proofs on it is written BEFORE
   * the melt precisely because the app can die there; the history line is not
   * — it is written when an answer, or a rejection, comes back. So a process
   * killed in that window leaves the balance 51,000 sats lower with nothing in
   * history to explain it, and onchainFollow's settle, fail and fee-correction
   * paths all act on an entry that was never written. */
  /* Fixed: the pending entry is written beside the record, before
   * the melt, for the same reason the record is. It used to be written in the
   * melt's error handler, so the one window it was for — a process killed with
   * no answer and no rejection — had no line in history at all. */
  check('a payout is in history from the moment its ecash leaves the pile',
    !!late.entry('onchain-oc-melt-1'), JSON.stringify(late.entry('onchain-oc-melt-1')));
  check('the money is still right after the kill, whatever history says',
    late.pile() === 8998 && (late.out('oc-melt-1').proofs || []).length === 0
      && twice(late).length === 0, String(late.pile()));
  /* The line written before the melt is what the follow then finishes: without
   * it there was nothing to mark, and the balance came back with no account of
   * where it had been. */
  check('the killed payout the mint never took is marked failed in history, not left silent',
    !!dead.entry('onchain-oc-melt-1') && dead.entry('onchain-oc-melt-1').state === 'failed'
      && dead.entry('onchain-oc-melt-1').settled === true,
    JSON.stringify(dead.entry('onchain-oc-melt-1')));

  /* A killed app must also not lose the proofs to the record cap. 30 payouts
   * are kept; the 31st pushes the oldest off the end — and the oldest is the
   * one that has been waiting longest, which is exactly the one still holding
   * its proofs. */
  const capped = await page({ splitFee: 2 });
  capped.reset(60000);
  const old = [];
  for (let i = 0; i < 29; i++) {
    old.push(heldRecord({ quote: 'done-' + i, proofs: [], state: 'PAID', at: Date.now() - i * 1000 }));
  }
  // the oldest of all: a payout the mint has never resolved, with its ecash on it
  old.push(heldRecord({ quote: 'oldest-pending', proofs: [proof(7000)], state: 'PENDING',
    sats: 6500, at: Date.now() - 30 * DAY }));
  capped.storage.setItem(K.out, JSON.stringify(old));
  await capped.W.onchainPay(planFor(capped.m, 50000, 1000), 0);
  check('a new payout does not push an unresolved one off the end of the record list',
    !!capped.out('oldest-pending'),
    'the oldest record was trimmed: ' + JSON.stringify(capped.read(K.out, '[]').map(r => r.quote)));
  check('and the ecash on it is still there, because that record is its only copy',
    sum((capped.out('oldest-pending') || {}).proofs) === 7000,
    JSON.stringify(capped.out('oldest-pending')));
  check('the new payout is on the list too, with its own proofs',
    sum((capped.out('oc-melt-1') || {}).proofs) === 51000, JSON.stringify(capped.out('oc-melt-1')));
  check('the settled records are what gets trimmed instead',
    capped.read(K.out, '[]').length === 30
      && capped.read(K.out, '[]').filter(r => (r.proofs || []).length).length === 2,
    JSON.stringify(capped.read(K.out, '[]').length));
  check('and nothing is held twice after the trim',
    twice(capped).length === 0, JSON.stringify(twice(capped)));

  /* The cap must never win over the money. Thirty-one payouts all still
   * holding their ecash keep thirty-one records: a list slightly over its cap
   * is a cosmetic problem, and dropping one is 51,000 sats. */
  const crowded = await page({ splitFee: 2 });
  crowded.reset(60000);
  const all = [];
  for (let i = 0; i < 30; i++) {
    all.push(heldRecord({ quote: 'waiting-' + i, proofs: [proof(1000)], state: 'PENDING',
      sats: 900, at: Date.now() - i * 1000 }));
  }
  crowded.storage.setItem(K.out, JSON.stringify(all));
  await crowded.W.onchainPay(planFor(crowded.m, 50000, 1000), 0);
  check('thirty-one payouts that all hold ecash keep thirty-one records',
    crowded.read(K.out, '[]').length === 31, String(crowded.read(K.out, '[]').length));
  check('and every sat of it is still on record',
    crowded.read(K.out, '[]').reduce((n, r) => n + sum(r.proofs), 0) === 30 * 1000 + 51000,
    String(crowded.read(K.out, '[]').reduce((n, r) => n + sum(r.proofs), 0)));
}

/* ---- 5: the state check itself fails -------------------------------------
 *
 * onchainFollow is what the watcher runs every two minutes (26b-onchain.js
 * onchainWatch). When the mint cannot answer, or answers nonsense, it must
 * conclude nothing: leave the record and its proofs alone, reject rather than
 * throw where the watcher would be left half way through its chain, and let
 * the next pass try again.
 */
async function followFaults() {
  const p = await page({});
  const fresh = () => {
    p.reset(8998);
    p.storage.setItem(K.out, JSON.stringify([heldRecord()]));
    p.storage.setItem(K.log, JSON.stringify([heldEntry()]));
  };
  const untouched = (why) => {
    check(why + ': the proofs stay on the record',
      sum((p.out('oc-melt-1') || {}).proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
    check(why + ': the pile does not move',
      p.pile() === 8998, String(p.pile()));
    check(why + ': the history entry is neither settled nor failed',
      p.entry('onchain-oc-melt-1').settled === false
        && p.entry('onchain-oc-melt-1').state === 'pending', JSON.stringify(p.entry('onchain-oc-melt-1')));
    check(why + ': and it is still listed as sending, so the next pass asks again',
      p.W.onchainSending().length === 1, JSON.stringify(p.W.onchainSending()));
    check(why + ': nothing is held twice', twice(p).length === 0, JSON.stringify(twice(p)));
  };

  // a 500 from the mint
  fresh();
  p.m.followThrows = new Error('HTTP 500 from the mint.');
  let five = '';
  try { await p.W.onchainFollow('oc-melt-1'); } catch (e) { five = said(e); }
  check('a 500 on the state check rejects rather than concluding anything',
    /500/.test(five), five || 'it resolved');
  untouched('a 500');

  // the connection went away: a bare network error, no message worth showing
  fresh();
  p.m.followThrows = new TypeError('Load failed');
  let net = '';
  try { await p.W.onchainFollow('oc-melt-1'); } catch (e) { net = said(e); }
  check('a network throw rejects, and the error is the one the network gave',
    /Load failed/.test(net), net || 'it resolved');
  untouched('a network throw');

  /* The watcher hands onchainFollow's promise to .then(ok, fail) — a
   * synchronous throw would escape that and stop the whole chain, leaving
   * every later record unasked. */
  fresh();
  p.m.followThrows = new Error('HTTP 502');
  let sync = false;
  try {
    const pending = p.W.onchainFollow('oc-melt-1');
    pending.catch(() => {});
    check('a failing state check hands back a promise, not a throw',
      !!pending && typeof pending.then === 'function', String(pending));
    await pending.catch(() => {});
  } catch (e) { sync = true; }
  check('so the watcher’s chain is never broken by one bad record', !sync, 'it threw synchronously');
  p.m.followThrows = null;

  // a body that is not a quote at all
  fresh();
  p.m.followBody = null;
  let nothing = '';
  try { await p.W.onchainFollow('oc-melt-1'); } catch (e) { nothing = said(e); }
  check('an empty body rejects rather than being read as a state',
    !!nothing, 'it resolved: ' + nothing);
  untouched('an empty body');

  // a body with no state in it
  fresh();
  p.m.followBody = { quote: 'oc-melt-1' };
  const blank = await p.W.onchainFollow('oc-melt-1');
  check('a body with no state concludes nothing about the payment',
    blank.state === '' && blank.sats === 50000, JSON.stringify(blank));
  check('a stateless answer leaves the proofs on the record',
    sum(p.out('oc-melt-1').proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  check('and the pile alone', p.pile() === 8998, String(p.pile()));
  check('and the entry unsettled', p.entry('onchain-oc-melt-1').settled === false,
    JSON.stringify(p.entry('onchain-oc-melt-1')));
  check('and still sending, so the next pass asks again',
    p.W.onchainSending().length === 1, JSON.stringify(p.W.onchainSending()));
  /* Fixed: an answer with no state says nothing, and writing it over
   * the record replaced what the mint last said with an empty string. */
  check('a stateless answer leaves the last state Foxy knew on the record',
    p.out('oc-melt-1').state === 'PENDING', JSON.stringify(p.out('oc-melt-1').state));
  p.m.followBody = undefined;

  /* A state this Foxy has never heard of. Holding is the only safe reading:
   * it is not PAID, so the payment is not done, and it is not UNPAID, so the
   * ecash may well be spent and must not be handed back. */
  fresh();
  p.m.follow = { state: 'SWEPT', outpoint: '' };
  const odd = await p.W.onchainFollow('oc-melt-1');
  check('a state Foxy has never heard of is reported as it came',
    odd.state === 'SWEPT', JSON.stringify(odd));
  check('an unknown state does not settle the payment',
    p.entry('onchain-oc-melt-1').settled === false, JSON.stringify(p.entry('onchain-oc-melt-1')));
  check('an unknown state does not hand the ecash back either',
    p.pile() === 8998, String(p.pile()));
  check('the proofs are held, so a later UNPAID can still return them',
    sum(p.out('oc-melt-1').proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  check('and the payout stays on the watch list',
    p.W.onchainSending().length === 1, JSON.stringify(p.W.onchainSending()));
  check('an unknown state leaves nothing in two places', twice(p).length === 0, JSON.stringify(twice(p)));

  // lower case is the same state: mints have sent both
  fresh();
  p.age('oc-melt-1', OLD);
  p.m.follow = { state: 'unpaid', outpoint: '' };
  await p.W.onchainFollow('oc-melt-1');
  check('a lower-case state is the state it spells: the payout is given up',
    p.out('oc-melt-1') === null, JSON.stringify(p.out('oc-melt-1')));
  check('and a lower-case unpaid is marked failed like any other',
    p.entry('onchain-oc-melt-1').state === 'failed', JSON.stringify(p.entry('onchain-oc-melt-1')));

  /* A quote with no record — a cleared install, or a record already settled by
   * another pass. Nothing to conclude and nothing to crash on. */
  fresh();
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  const orphan = await p.W.onchainFollow('never-heard-of');
  check('a quote with no record answers rather than crashing',
    orphan.sats === 0 && orphan.state === 'UNPAID', JSON.stringify(orphan));
  check('and touches nothing', p.pile() === 8998 && sum(p.out('oc-melt-1').proofs) === 51000,
    String(p.pile()));
}

/* ---- 6: a melt answer whose change cannot be used ------------------------
 *
 * The change is what is left of the fee reserve. A mint that sends something
 * else in its place must not be able to stop the payment settling, corrupt the
 * pile, or make the fee come out as a figure that is not a number.
 */
async function badChange() {
  const p = await page({ splitFee: 2 });
  const plan = () => planFor(p.m, 50000, 1000);
  const junkInPile = () => p.piled().filter(x => !x || typeof x !== 'object' || !x.secret);

  /* Change of every unusable shape, each of which must settle the payment, put
   * nothing but ecash in the pile, and charge the whole reserve as the fee —
   * because none of the reserve came back in a form that can be spent. */
  const shapes = [
    ['a string', 'nope'],
    ['an object', { proofs: [] }],
    ['a number', 7],
    ['null in the field', null],
    ['a list of nothing', [null, undefined, 0, 'x']],
    ['a proof with a nonsense amount', [{ amount: 'lots', secret: 'a'.repeat(64),
      C: '02' + 'b'.repeat(64), id: '00b4cd27d8861a44' }]],
    ['a proof with a fractional amount', [{ amount: 1.5, secret: 'a'.repeat(64),
      C: '02' + 'b'.repeat(64), id: '00b4cd27d8861a44' }]],
    ['a proof with a negative amount', [{ amount: -100000, secret: 'a'.repeat(64),
      C: '02' + 'b'.repeat(64), id: '00b4cd27d8861a44' }]],
    ['a hollow proof', [{}]],
    ['a proof with no secret', [{ amount: 400, C: '02' + 'b'.repeat(64), id: '00b4cd27d8861a44' }]],
  ];
  for (const [what, change] of shapes) {
    p.reset(60000);
    p.m.melt = { state: 'PENDING', change: change };
    let settled = null;
    let threw = '';
    try { settled = await p.W.onchainPay(plan(), 0); } catch (e) { threw = said(e); }
    check('change as ' + what + ' does not stop the payment settling',
      !!settled && settled.state === 'PENDING' && settled.sats === 50000, threw || JSON.stringify(settled));
    check('change as ' + what + ' puts nothing but ecash in the pile',
      junkInPile().length === 0 && p.pile() === 8998, JSON.stringify(p.piled()));
    check('change as ' + what + ' gives a fee that is a number, and not negative',
      isFinite((settled || {}).feeSats) && settled.feeSats === 1002, String((settled || {}).feeSats));
    check('change as ' + what + ' logs that same fee to history',
      p.entry('onchain-oc-melt-1').feeSats === 1002, JSON.stringify(p.entry('onchain-oc-melt-1')));
    check('change as ' + what + ' keeps the ecash on the record for the follow',
      sum((p.out('oc-melt-1') || {}).proofs) === 51000, JSON.stringify(p.out('oc-melt-1')));
  }

  /* Usable change beside unusable, in one answer: the good proof is banked and
   * only the bad one is dropped. Dropping the whole list would throw away real
   * ecash the mint had already signed. */
  p.reset(60000);
  p.m.melt = { state: 'PENDING', change: [{}, proof(400), { amount: 'lots' }] };
  const mixed = await p.W.onchainPay(plan(), 0);
  check('usable change is banked even when unusable change came with it',
    p.pile() === 8998 + 400, String(p.pile()));
  check('and the fee counts only what actually came back',
    mixed.feeSats === 602, String(mixed.feeSats));
  check('with nothing but ecash in the pile', junkInPile().length === 0, JSON.stringify(p.piled()));

  /* More change than the reserve. The mint is wrong, but the fee must not come
   * out negative: a negative fee reads as a refund in history and in the
   * totals. */
  p.reset(60000);
  p.m.melt = { state: 'PENDING', change: [proof(60000)] };
  const generous = await p.W.onchainPay(plan(), 0);
  check('change larger than the reserve does not make the fee negative',
    generous.feeSats === 2 && generous.feeSats >= 0, String(generous.feeSats));
  check('and the history entry’s fee is not negative either',
    p.entry('onchain-oc-melt-1').feeSats >= 0, JSON.stringify(p.entry('onchain-oc-melt-1')));

  // change alongside a PAID answer: settled, spent, and the change banked
  p.reset(60000);
  p.m.melt = { state: 'PAID', change: [proof(400)], outpoint: 'abc:1' };
  const paid = await p.W.onchainPay(plan(), 0);
  check('a PAID answer with usable change banks it and settles',
    paid.state === 'PAID' && p.pile() === 8998 + 400, String(p.pile()));
  check('and holds no proofs, because they are spent',
    (p.out('oc-melt-1').proofs || []).length === 0, JSON.stringify(p.out('oc-melt-1')));
  check('nothing is in two places after any of that', twice(p).length === 0, JSON.stringify(twice(p)));
}

/* ---- 7: two watchers, and a watcher landing mid-payment ------------------
 *
 * onchainWatch fires on launch, on return and every two minutes, and the app
 * can start a payment at any moment in between. Both races are real.
 */
async function racing() {
  const p = await page({ splitFee: 2 });

  /* The same quote followed twice at once, on a record old enough for UNPAID
   * to be the mint's verdict. Whatever the lock does with the two, a payout is
   * given up once and its ecash handed back once. */
  p.reset(8998);
  p.storage.setItem(K.out, JSON.stringify([agedRecord()]));
  p.storage.setItem(K.log, JSON.stringify([heldEntry()]));
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  const pair = await Promise.all([
    p.W.onchainFollow('oc-melt-1'),
    p.W.onchainFollow('oc-melt-1'),
  ]);
  check('only one of two follows racing gives the payout up; the other finds it gone',
    pair.filter(r => r.sats === 50000).length === 1, JSON.stringify(pair.map(r => r.sats)));
  check('the record is forgotten once', p.out('oc-melt-1') === null,
    JSON.stringify(p.read(K.out, '[]')));
  /* "At most once", not "exactly once": whether a refund returns the ecash at
   * all is the refund's business, pinned in its own scenario. What racing must
   * never do is return it twice, and that is what this says — a check that
   * stays right on both sides of the refund being fixed. */
  check('two follows racing on one quote return the ecash at most once',
    p.pile() === 8998 || p.pile() === 8998 + 51000, String(p.pile()));
  check('and nothing is in two places', twice(p).length === 0, JSON.stringify(twice(p)));
  check('history is marked failed exactly once, not once per racer',
    p.read(K.log, '[]').filter(e => e.hash === 'onchain-oc-melt-1' && e.state === 'failed').length === 1,
    JSON.stringify(p.read(K.log, '[]')));

  /* Five at once, which is what a watcher resumed repeatedly does — and FAILED,
   * which is the mint's verdict on a payment it tried and so needs no wait. */
  p.reset(8998);
  p.storage.setItem(K.out, JSON.stringify([heldRecord()]));   // seconds old on purpose
  p.m.follow = { state: 'FAILED', outpoint: '' };
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => p.W.onchainFollow('oc-melt-1')));
  check('FAILED is given up at once, however young the payout: the mint tried and it did not go',
    p.out('oc-melt-1') === null && five.filter(r => r.state === 'FAILED').length === 5,
    JSON.stringify(five.map(r => r.state)));
  check('and exactly one of the five claims to have done it',
    five.filter(r => r.sats === 50000).length === 1, JSON.stringify(five.map(r => r.sats)));
  check('five follows racing return the ecash at most once',
    p.pile() === 8998 || p.pile() === 8998 + 51000, String(p.pile()));

  /* A follow that STARTS while a payment's split is in flight.
   *
   * onchainPay reads the pile, awaits the split, then writes back what the
   * split kept. Anything else that writes the pile inside that window used to
   * be wiped by that write: onchainPay, onchainClaim and onchainFollow now sit
   * in the proof lock (99-proof-lock-and-export.js), so the second call waits
   * its turn instead of landing in the middle. It is STARTED here, not awaited
   * — awaiting it from inside the split would be waiting on the lock the split's
   * own caller holds, which is a deadlock, not a race. The stub answers the
   * split on a macrotask, so everything already queued has run first: without
   * the lock the follow would certainly have written the pile before the
   * split's setProofs landed, and 7,000 sats would be gone. */
  p.reset(60000);
  p.storage.setItem(K.out, JSON.stringify([
    agedRecord({ quote: 'oc-melt-other', sats: 6500, proofs: [proof(7000)] }),
  ]));
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  let midFollow = null;
  let pileMidSplit = -1;
  p.m.onSend = () => { midFollow = p.W.onchainFollow('oc-melt-other'); midFollow.catch(() => {}); };
  p.m.onSendDone = () => { pileMidSplit = p.pile(); };
  const paidWhileFollowing = await p.W.onchainPay(planFor(p.m, 50000, 1000), 0);
  p.m.onSend = null; p.m.onSendDone = null;
  check('a follow really was started while the payment was splitting', !!midFollow,
    'the split window never fired');
  /* The discriminator. By the end of the split's window the follow has had
   * every microtask it could want: if it were free to run it would already
   * have put its 7,000 sats in the pile, and the setProofs that follows would
   * then wipe them. Holding at 60,000 is the lock doing its job. */
  check('the follow changed nothing while the payment held the proof lock',
    pileMidSplit === 60000, String(pileMidSplit));
  const returned = await midFollow;
  check('the payment went through', paidWhileFollowing.state === 'PENDING'
    && p.m.meltAsked.length === 1, JSON.stringify(paidWhileFollowing));
  check('and the follow, waiting its turn, gave its payout up',
    returned.state === 'UNPAID' && returned.sats === 6500, JSON.stringify(returned));
  check('the payment’s own ecash is on its record, not in the pile as well',
    sum((p.out('oc-melt-1') || {}).proofs) === 51000 && twice(p).length === 0,
    JSON.stringify(twice(p)));
  check('and the followed payout is forgotten', p.out('oc-melt-other') === null,
    JSON.stringify(p.read(K.out, '[]').map(r => r.quote)));
  check('whatever the follow returned is not wiped by the payment’s own write',
    p.pile() === 8998 || p.pile() === 8998 + 7000, String(p.pile()));

  /* The same window with a claim rather than a follow. The watcher claims
   * every address before it follows any payout, so this is the likelier of the
   * two: an on-chain payment arriving while the person sends one. */
  p.reset(60000);
  p.storage.setItem(K.onchain, JSON.stringify([{ quote: 'oc-mint-1', address: p.m.address,
    at: Date.now(), mint: MINT, answer: { quote: 'oc-mint-1' }, privkey: 'ab'.repeat(32), issued: 0 }]));
  p.m.seen = { amount_paid: 30000, amount_issued: 0 };
  let midClaim = null;
  let pileMidClaim = -1;
  p.m.onSend = () => { midClaim = p.W.onchainClaim('oc-mint-1'); midClaim.catch(() => {}); };
  p.m.onSendDone = () => { pileMidClaim = p.pile(); };
  await p.W.onchainPay(planFor(p.m, 50000, 1000), 0);
  p.m.onSend = null; p.m.onSendDone = null;
  check('a claim really was started while the payment was splitting', !!midClaim,
    'the split window never fired');
  check('the claim changed nothing while the payment held the proof lock',
    pileMidClaim === 60000, String(pileMidClaim));
  check('and it had not reached the mint for its ecash either',
    p.m.claimAsked.length === 0, JSON.stringify(p.m.claimAsked));
  const claimed = await midClaim;
  check('the claim, waiting its turn, took what the mint had confirmed',
    claimed.sats === 30000, JSON.stringify(claimed));
  check('ecash claimed on chain survives a payment that was splitting at the time',
    p.pile() === 8998 + 30000, String(p.pile()));
  check('the claim is recorded as taken at the mint’s end',
    (p.addr('oc-mint-1') || {}).issued === 30000, JSON.stringify(p.addr('oc-mint-1')));
  check('and history agrees with the pile about the sats arriving',
    !!p.entry('onchain-oc-mint-1-0') && p.entry('onchain-oc-mint-1-0').sats === 30000,
    JSON.stringify(p.read(K.log, '[]').map(e => e.hash)));
  check('with nothing in two places at the end of it', twice(p).length === 0, JSON.stringify(twice(p)));

  /* Three at once on one pile, which is what a watcher resuming beside a
   * payment looks like: a payout being made, a payout coming back and a claim
   * landing. Every sat has to be accounted for, whatever order they take. */
  p.reset(60000);
  p.storage.setItem(K.out, JSON.stringify([
    heldRecord({ quote: 'oc-melt-other', sats: 6500, proofs: [proof(7000)] }),
  ]));
  p.storage.setItem(K.onchain, JSON.stringify([{ quote: 'oc-mint-1', address: p.m.address,
    at: Date.now(), mint: MINT, answer: { quote: 'oc-mint-1' }, privkey: 'ab'.repeat(32), issued: 0 }]));
  p.m.seen = { amount_paid: 30000, amount_issued: 0 };
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  const started = [];
  p.m.onSend = () => {
    started.push(p.W.onchainFollow('oc-melt-other'), p.W.onchainClaim('oc-mint-1'));
    started.forEach(x => x.catch(() => {}));
  };
  await p.W.onchainPay(planFor(p.m, 50000, 1000), 0);
  p.m.onSend = null;
  await Promise.all(started);
  check('a payment, a given-up payout and a claim at once all land',
    p.pile() === 8998 + 30000 || p.pile() === 8998 + 7000 + 30000, String(p.pile()));
  check('the claim’s ecash in particular is not wiped by the payment’s write',
    p.pile() >= 8998 + 30000, String(p.pile()));
  check('and the payment being made still holds its own ecash, once',
    sum((p.out('oc-melt-1') || {}).proofs) === 51000 && twice(p).length === 0,
    JSON.stringify(twice(p)));
}

/* ---- the refund itself ---------------------------------------------------
 *
 * The one place on this path where new code can lose money: handing a payout's
 * ecash back. Two guards stand in front of it, both taken from the Lightning
 * side's W4.
 *
 *   - UNPAID is not a verdict until the record is old enough that the melt
 *     cannot still be in flight. A melt whose answer was lost may be reaching
 *     the mint at this moment, and the mint reads UNPAID until it lands, so
 *     ecash handed back at once was spendable while the payout could still go
 *     through. FAILED is the mint's verdict on a payment it tried and needs no
 *     wait.
 *   - What goes back is only what is still unspent and held nowhere else.
 *
 * The second guard as it stands does not do that. It is written here as it
 * ought to behave, with the sats it currently destroys recorded as MONEY
 * lines: see the report, and 04-lost-answers.js liveUnheld against
 * 02-dleq-lock-holds-imports.js everyHeldProof.
 */
async function refundGuards() {
  const p = await page({});
  const set = (record, entry) => {
    p.reset(8998);
    p.storage.setItem(K.out, JSON.stringify([record]));
    p.storage.setItem(K.log, JSON.stringify([entry || heldEntry()]));
  };

  /* The wait, at its edges. A minute is too soon; three minutes is not. */
  for (const [how, ms, verdict] of [
    ['seconds', 2000, false], ['a minute', 60000, false],
    ['three minutes', OLD, true], ['a day', 86400000, true],
  ]) {
    set(heldRecord({ at: Date.now() - ms }));
    p.m.follow = { state: 'UNPAID', outpoint: '' };
    const r = await p.W.onchainFollow('oc-melt-1');
    check('a payout ' + how + ' old reading UNPAID is ' + (verdict ? 'given up' : 'still held'),
      (r.state === 'UNPAID') === verdict && (r.state === 'PENDING') === !verdict, JSON.stringify(r));
    check('a payout ' + how + ' old ' + (verdict ? 'loses' : 'keeps') + ' its record',
      (p.out('oc-melt-1') === null) === verdict, JSON.stringify(p.out('oc-melt-1')));
    check('a payout ' + how + ' old is ' + (verdict ? '' : 'not ') + 'marked failed in history',
      (p.entry('onchain-oc-melt-1').state === 'failed') === verdict,
      JSON.stringify(p.entry('onchain-oc-melt-1')));
    if (!verdict) {
      check('a payout ' + how + ' old still holds its 51,000 sats',
        sum(p.out('oc-melt-1').proofs) === 51000 && p.pile() === 8998, String(p.pile()));
      check('and is still asked about on the next pass',
        p.W.onchainSending().length === 1, JSON.stringify(p.W.onchainSending()));
    }
    check('a payout ' + how + ' old leaves nothing in two places',
      twice(p).length === 0, JSON.stringify(twice(p)));
  }

  /* FAILED needs no wait: the mint tried the payment and says it did not go. */
  set(heldRecord({ at: Date.now() - 1000 }));
  p.m.follow = { state: 'FAILED', outpoint: '' };
  const failed = await p.W.onchainFollow('oc-melt-1');
  check('FAILED is a verdict at once, however young the payout',
    failed.state === 'FAILED' && p.out('oc-melt-1') === null, JSON.stringify(failed));
  check('and FAILED marks the entry failed and done',
    p.entry('onchain-oc-melt-1').state === 'failed'
      && p.entry('onchain-oc-melt-1').settled === true, JSON.stringify(p.entry('onchain-oc-melt-1')));
  check('FAILED gives the payout’s 51,000 sats back at once',
    p.pile() === 8998 + 51000, String(p.pile()));

  /* The mint was asked, wasn't it? The whole point of the second guard is to
   * ask the mint which of the held proofs are still unspent. A refund that
   * never opens that conversation cannot be filtering on the answer. */
  set(agedRecord());
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  await p.W.onchainFollow('oc-melt-1');
  check('a refund asks the mint whether the proofs it is returning are still unspent',
    p.m.statesAsked > 0, 'checkProofsStates calls: ' + p.m.statesAsked);

  /* And when it does ask: proofs the mint has since taken must not come back.
   * A payout whose melt actually landed while Foxy thought it had not leaves
   * exactly this — the mint holds some of them, and putting those in the pile
   * makes a balance that cannot be spent. */
  const keptSecret = proof(20000);
  const goneSecret = proof(31000);
  set(agedRecord({ proofs: [keptSecret, goneSecret] }));
  p.m.spent = [goneSecret.secret];
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  await p.W.onchainFollow('oc-melt-1');
  check('only the unspent half of a part-spent payout comes back',
    p.pile() === 8998 + keptSecret.amount,
    String(p.pile()) + ', expected ' + (8998 + keptSecret.amount));
  check('a part-spent payout never puts a proof the mint has taken into the pile',
    p.piled().filter(x => x.secret === goneSecret.secret).length === 0, JSON.stringify(p.piled()));
  check('and leaves nothing in two places', twice(p).length === 0, JSON.stringify(twice(p)));

  /* A record whose proofs were already handed back — the app died between the
   * pile being written and the record being forgotten. The second pass must
   * add nothing: this is the case liveUnheld is genuinely needed for. */
  const twiceOver = proof(51000);
  p.reset(0);
  p.storage.setItem(K.proofs, JSON.stringify([proof(8998), twiceOver]));
  p.storage.setItem(K.out, JSON.stringify([agedRecord({ proofs: [twiceOver] })]));
  p.storage.setItem(K.log, JSON.stringify([heldEntry()]));
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  await p.W.onchainFollow('oc-melt-1');
  check('a payout whose ecash is already in the pile does not add it a second time',
    p.pile() === 8998 + 51000, String(p.pile()));
  check('and the record is cleared, so it is not tried again',
    p.out('oc-melt-1') === null, JSON.stringify(p.out('oc-melt-1')));
  check('with the proof in the pile once and only once',
    p.piled().filter(x => x.secret === twiceOver.secret).length === 1, JSON.stringify(p.piled()));

  /* A record with no timestamp at all. There is no such record today — every
   * one is written with `at` — but if there were, the safe reading of an
   * unknown age is the same as the young one: hold. */
  set(heldRecord({ at: undefined }));
  p.m.follow = { state: 'UNPAID', outpoint: '' };
  const undated = await p.W.onchainFollow('oc-melt-1');
  /* An unknown age holds, rather than being read as 1970 and given up at once:
   * the wait is a safety margin, so the direction to fail in is keeping the
   * ecash. Every record onchainPay writes has an `at`; this is the guard on
   * the field being missing. */
  check('a payout with no timestamp is held, an unknown age being the doubtful one',
    undated.state === 'PENDING', JSON.stringify(undated));
}

/* ---- the route: no poller reaches the mint off Tor -----------------------
 *
 * Every on-chain call checks the route before it opens a connection. The two
 * the watcher runs on a timer matter most: they fire on their own, without
 * anybody tapping anything, so an unchecked one would reach a mint over the
 * open internet while the app believed it was protected.
 */
async function routeClosed() {
  const p = await page({});
  p.reset(8998);
  p.storage.setItem(K.out, JSON.stringify([heldRecord()]));
  p.storage.setItem(K.onchain, JSON.stringify([{ quote: 'oc-mint-1', address: p.m.address,
    at: Date.now(), mint: MINT, answer: { quote: 'oc-mint-1' }, privkey: 'ab'.repeat(32), issued: 0 }]));
  p.m.seen = { amount_paid: 30000, amount_issued: 0 };
  const asked = p.m.claimAsked.length;

  p.W._privacy({ tor: 'connecting', progress: 10, everUp: false, unprotected: false });
  for (const [name, run] of [
    ['onchainFollow', () => p.W.onchainFollow('oc-melt-1')],
    ['onchainSeen', () => p.W.onchainSeen('oc-mint-1')],
    ['onchainClaim', () => p.W.onchainClaim('oc-mint-1')],
    ['onchainPay', () => p.W.onchainPay(planFor(p.m, 50000, 1000), 0)],
  ]) {
    let refused = '';
    try { await run(); } catch (e) { refused = said(e); }
    check(name + ' refuses to reach the mint while there is no route',
      !!refused, 'it went ahead anyway');
  }
  check('and nothing was asked of the mint with the route down',
    p.m.claimAsked.length === asked && p.m.sendAsked.length === 0,
    JSON.stringify([p.m.claimAsked.length, p.m.sendAsked.length]));
  check('nor was any money moved while it was down',
    p.pile() === 8998 && sum(p.out('oc-melt-1').proofs) === 51000, String(p.pile()));

  // and with Tor up again they work, so the refusal was the route and not something else
  p.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false });
  const open = await p.W.onchainSeen('oc-mint-1');
  check('with the route open again the same call reaches the mint',
    open.paid === 30000, JSON.stringify(open));
}

/* ---- 8: the receive side ------------------------------------------------
 *
 * A claim reserves counters and the mint signs against them. If the answer is
 * lost the ecash exists — the mint has issued it and counted it — and the only
 * things that can find it again are the counter ranges the claim recorded.
 */
async function claimFaults() {
  const p = await page({});

  p.reset(0);
  const made = await p.W.onchainAddress();
  check('an address is made and written down', !!made.address && !!p.addr(made.quote),
    JSON.stringify(made));

  /* The mint signed and then the answer was lost. The pile must not gain
   * anything, the record must not claim sats it never got, and the burnt
   * counters must be written down somewhere. */
  p.m.seen = { amount_paid: 30000, amount_issued: 0 };
  p.m.claimSigns = true;
  p.m.claimThrows = 'the mint did not answer within 60s.';
  let lostClaim = '';
  try { await p.W.onchainClaim('oc-mint-1'); } catch (e) { lostClaim = said(e); }
  check('a claim whose answer is lost rejects with the mint’s own words',
    /did not answer/.test(lostClaim), lostClaim || 'it resolved');
  check('the mint was asked for exactly what was confirmed and unissued',
    p.m.claimAsked.length === 1 && p.m.claimAsked[0].amount === 30000,
    JSON.stringify(p.m.claimAsked));
  check('nothing is added to the pile for a claim that did not answer',
    p.pile() === 0, String(p.pile()));
  check('and the record does not say those sats were issued to this wallet',
    p.addr('oc-mint-1').issued === 0, JSON.stringify(p.addr('oc-mint-1')));
  check('no history line is written for ecash that never arrived',
    p.read(K.log, '[]').length === 0, JSON.stringify(p.read(K.log, '[]')));
  /* The claim WAS listening when the mint reserved the counters, so what
   * follows is about where that reservation was written, not about whether
   * anybody was watching for it. */
  check('the claim was watching the counter reservation when the mint signed',
    p.m.watchers >= 1, String(p.m.watchers));
  /* The ranges are the only trace of ecash the mint signed and this page never
   * saw. They go on the address's own record, which is the one place that
   * knows about an on-chain quote. */
  const burnt = rangesOnRecord(p);
  check('the counters a lost claim burnt are written down on the address’s record',
    burnt.length === 1 && burnt[0].count === 4 && burnt[0].keysetId === '00b4cd27d8861a44',
    JSON.stringify(burnt));
  check('and the mint they were reserved at is written with them',
    p.addr('oc-mint-1').outputsMint === MINT, JSON.stringify(p.addr('oc-mint-1').outputsMint));

  /* Asking again takes only what is genuinely left — and rebuilds what the
   * mint says it issued but this wallet never received. The mint counts the
   * lost claim as issued, so `paid − issued` is nothing to claim; the sats are
   * in signatures on the counters above. */
  p.m.claimThrows = null;
  p.m.claimSigns = false;
  p.m.seen = { amount_paid: 30000, amount_issued: 30000 };
  const lostEcash = [proof(20000), proof(10000)];
  p.m.restorable = [{ keysetId: '00b4cd27d8861a44', start: 40, count: 4, proofs: lostEcash }];
  const rebuilt = await p.W.onchainClaim('oc-mint-1');
  check('the next claim asks the mint what it signed on those counters',
    p.m.restoreAsked.length >= 1 && p.m.restoreAsked[0].keysetId === '00b4cd27d8861a44',
    JSON.stringify(p.m.restoreAsked));
  check('and the ecash of the lost answer is rebuilt into the pile',
    p.pile() === 30000, String(p.pile()));
  check('with a history line of its own, so the sats are explained',
    !!p.entry('onchain-oc-mint-1-lost-0')
      && p.entry('onchain-oc-mint-1-lost-0').sats === 30000
      && p.entry('onchain-oc-mint-1-lost-0').settled === true,
    JSON.stringify(p.read(K.log, '[]').map(e => e.hash)));
  check('and it is tagged like any other arrival',
    !!p.read(K.tags, '{}')['onchain-oc-mint-1-lost-0'], JSON.stringify(p.read(K.tags, '{}')));
  check('the record now agrees with the mint about what has been issued',
    p.addr('oc-mint-1').issued === 30000, JSON.stringify(p.addr('oc-mint-1')));
  check('nothing new was claimed, because there was nothing left to claim',
    p.m.claimAsked.length === 1, JSON.stringify(p.m.claimAsked.length));
  /* Fixed: a pass that rebuilt 30,000 sats used to resolve 0, and
   * the watcher's `!got.sats` early return left the screen stale. */
  check('a rebuilt claim tells its caller how many sats it recovered',
    rebuilt.sats === 30000 && /lost/.test(String(rebuilt.hash)), JSON.stringify(rebuilt));

  /* Rebuilding must be idempotent: liveUnheld keeps a proof already in the
   * pile out of it, so a second pass adds nothing and logs nothing. */
  const afterRebuild = p.pile();
  const lines = p.read(K.log, '[]').length;
  await p.W.onchainClaim('oc-mint-1');
  check('rebuilding twice adds the same ecash only once',
    p.pile() === afterRebuild, String(p.pile()));
  check('and writes no second history line for it',
    p.read(K.log, '[]').length === lines, String(p.read(K.log, '[]').length));

  /* A mint that cannot answer the restore leaves the record alone, so the next
   * pass can try again rather than marking it caught up. */
  p.reset(0);
  p.storage.setItem(K.onchain, JSON.stringify([{ quote: 'oc-mint-1', address: p.m.address,
    at: Date.now(), mint: MINT, answer: { quote: 'oc-mint-1' }, privkey: 'ab'.repeat(32), issued: 0,
    outputs: [{ keysetId: '00b4cd27d8861a44', start: 60, count: 4 }], outputsMint: MINT }]));
  p.m.seen = { amount_paid: 30000, amount_issued: 30000 };
  p.m.restorable = [];                      // the mint signed nothing there, as far as it will say
  const emptyRestore = await p.W.onchainClaim('oc-mint-1');
  check('a restore that finds nothing claims nothing and does not crash',
    emptyRestore.sats === 0 && p.pile() === 0, JSON.stringify(emptyRestore));
  check('and leaves the record behind for the next pass to try again',
    p.addr('oc-mint-1').issued === 0, JSON.stringify(p.addr('oc-mint-1')));
  check('writing no history line for ecash it did not find',
    p.read(K.log, '[]').length === 0, JSON.stringify(p.read(K.log, '[]')));

  // and one more payment lands on the same address: only the new part is claimable
  p.reset(0);
  p.storage.setItem(K.onchain, JSON.stringify([{ quote: 'oc-mint-1', address: p.m.address,
    at: Date.now(), mint: MINT, answer: { quote: 'oc-mint-1' }, privkey: 'ab'.repeat(32),
    issued: 30000 }]));
  p.m.seen = { amount_paid: 45000, amount_issued: 30000 };
  const rest = await p.W.onchainClaim('oc-mint-1');
  check('a later payment to the same address claims only what is new',
    rest.sats === 15000 && p.pile() === 15000, JSON.stringify(rest));
  check('and the entry is keyed by what the mint had issued before it',
    !!p.entry('onchain-oc-mint-1-30000'), JSON.stringify(p.read(K.log, '[]').map(e => e.hash)));
  check('the record follows the mint’s own figure, not Foxy’s idea of it',
    p.addr('oc-mint-1').issued === 45000, JSON.stringify(p.addr('oc-mint-1')));

  /* The mint says it has issued more than it has been paid. Somebody else's
   * claim, a lost answer counted at the mint, or a mint that is simply wrong:
   * whatever it is, the amount asked for must never go below zero. */
  p.m.seen = { amount_paid: 30000, amount_issued: 50000 };
  const asked = p.m.claimAsked.length;
  const negative = await p.W.onchainClaim('oc-mint-1');
  check('a mint that has issued more than it was paid claims nothing, not a negative amount',
    negative.sats === 0, JSON.stringify(negative));
  check('and nothing is asked of the mint at all',
    p.m.claimAsked.length === asked, JSON.stringify(p.m.claimAsked.length));
  check('the pile does not move on a claim of nothing', p.pile() === 15000, String(p.pile()));

  // amounts that are not numbers read as nothing, never as NaN
  p.m.seen = { amount_paid: 'lots', amount_issued: null };
  const wordy = await p.W.onchainClaim('oc-mint-1');
  check('amounts that are not numbers claim nothing rather than NaN',
    wordy.sats === 0 && p.pile() === 15000, JSON.stringify(wordy));

  /* The ceiling, with the mint's issued figure moving under it. A claim capped
   * at the ceiling must leave the rest reachable, not strand it. */
  p.reset(0);
  p.storage.setItem(K.onchain, JSON.stringify([{ quote: 'oc-mint-1', address: p.m.address,
    at: Date.now(), mint: MINT, answer: { quote: 'oc-mint-1' }, privkey: 'ab'.repeat(32), issued: 0 }]));
  p.m.seen = { amount_paid: 2500000, amount_issued: 0 };
  const first = await p.W.onchainClaim('oc-mint-1');
  p.m.seen = { amount_paid: 2500000, amount_issued: 1000000 };
  const second = await p.W.onchainClaim('oc-mint-1');
  p.m.seen = { amount_paid: 2500000, amount_issued: 2000000 };
  const third = await p.W.onchainClaim('oc-mint-1');
  check('a claim over the ceiling comes in passes, and none of it is stranded',
    first.sats === 1000000 && second.sats === 1000000 && third.sats === 500000,
    JSON.stringify([first.sats, second.sats, third.sats]));
  check('and the whole payment ends up in the pile', p.pile() === 2500000, String(p.pile()));
  check('each pass has its own history entry, keyed by what was issued before it',
    !!p.entry('onchain-oc-mint-1-0') && !!p.entry('onchain-oc-mint-1-1000000')
      && !!p.entry('onchain-oc-mint-1-2000000'),
    JSON.stringify(p.read(K.log, '[]').map(e => e.hash)));
}

/* ---- 9: an address quote the mint has forgotten -------------------------
 *
 * Mints prune. A quote that 404s can never be claimed again, and the watcher
 * asks about every address it is still watching on every pass.
 */
async function forgottenQuote() {
  const p = await page({});
  p.reset(0);
  p.storage.setItem(K.onchain, JSON.stringify([
    { quote: 'gone', address: 'bc1qgone', at: Date.now(), mint: MINT,
      answer: { quote: 'gone' }, privkey: 'ab'.repeat(32), issued: 0 },
    { quote: 'here', address: p.m.address, at: Date.now(), mint: MINT,
      answer: { quote: 'here' }, privkey: 'cd'.repeat(32), issued: 0 },
  ]));
  p.m.seenThrowsFor.gone = 'HTTP 404: the mint has no quote gone.';
  p.m.seenFor.here = { amount_paid: 30000, amount_issued: 0 };

  let seenSaid = '';
  try { await p.W.onchainSeen('gone'); } catch (e) { seenSaid = said(e); }
  check('onchainSeen on a forgotten quote fails with the mint’s own words',
    /404/.test(seenSaid), seenSaid || 'it resolved');

  let claimSaid = '';
  let syncThrow = false;
  try {
    const pending = p.W.onchainClaim('gone');
    check('onchainClaim on a forgotten quote hands back a promise, not a throw',
      !!pending && typeof pending.then === 'function', String(pending));
    await pending;
  } catch (e) { claimSaid = said(e); if (!claimSaid) syncThrow = true; }
  check('onchainClaim on a forgotten quote fails cleanly', /404/.test(claimSaid),
    claimSaid || 'it resolved');
  check('and not by throwing where the watcher could not catch it', !syncThrow, 'it threw');
  check('nothing is written for a quote the mint has forgotten',
    p.pile() === 0 && p.addr('gone').issued === 0 && p.read(K.log, '[]').length === 0,
    JSON.stringify([p.pile(), p.addr('gone')]));
  check('and nothing was asked of the mint beyond the state check',
    p.m.claimAsked.length === 0, JSON.stringify(p.m.claimAsked));

  /* The watcher walks its addresses one at a time, catching each failure
   * (26b-onchain.js onchainWatch). One that 404s must not stop the rest: the
   * address after it is the one with money on it. */
  const watched = p.W.onchainWatching();
  const got = [];
  await watched.reduce((chain, record) => chain.then(() => p.W.onchainClaim(record.quote)
    .then(r => { got.push(r.sats); }, () => { got.push('failed'); })), Promise.resolve());
  check('a forgotten quote does not stop the watcher claiming the next address',
    JSON.stringify(got) === JSON.stringify(['failed', 30000]), JSON.stringify(got));
  check('and the ecash on the good address lands in the pile', p.pile() === 30000, String(p.pile()));

  /* Nothing marks a 404 as hopeless, so the only bound on asking forever is
   * the watch window Foxy sets itself. A record outside it is dropped from the
   * list, which is what stops the watcher spinning on a dead quote for good. */
  check('a forgotten quote is still watched while it is inside the window',
    p.W.onchainWatching().filter(r => r.quote === 'gone').length === 1,
    JSON.stringify(p.W.onchainWatching().map(r => r.quote)));
  const old = p.read(K.onchain, '[]');
  old.forEach(r => { if (r.quote === 'gone') r.at = Date.now() - 8 * DAY; });
  p.storage.setItem(K.onchain, JSON.stringify(old));
  check('and past the window it drops off the list, so the watcher stops asking',
    p.W.onchainWatching().filter(r => r.quote === 'gone').length === 0,
    JSON.stringify(p.W.onchainWatching().map(r => r.quote)));
  check('while the address that still works stays on it',
    p.W.onchainWatching().filter(r => r.quote === 'here').length === 1,
    JSON.stringify(p.W.onchainWatching().map(r => r.quote)));
  // both records stay on file: falling out of the watch window is what drops
  // an address, and nothing else can (`onchainForget` was removed with it)
  check('and the one past the window is still on file, just not watched',
    p.read(K.onchain, '[]').length === 2,
    JSON.stringify(p.read(K.onchain, '[]').map(r => r.quote)));

  /* An address made at another mint, asked about while connected here: the
   * claim must refuse rather than derive this mint's secrets for it. */
  p.storage.setItem(K.onchain, JSON.stringify([{ quote: 'theirs', address: 'bc1qtheirs',
    at: Date.now(), mint: OTHER, answer: { quote: 'theirs' }, privkey: 'ef'.repeat(32), issued: 0 }]));
  let elsewhere = '';
  try { await p.W.onchainClaim('theirs'); } catch (e) { elsewhere = said(e); }
  check('an address from another mint is refused, not claimed here',
    /belongs to other\.test/.test(elsewhere), elsewhere || 'it was allowed');
  check('and it is not watched at this mint either',
    p.W.onchainWatching().length === 0, JSON.stringify(p.W.onchainWatching()));
}

async function run() {
  /* Each scenario races a five-second clock. Nothing here does real work, so a
   * scenario that takes longer is not slow, it is stuck — and a stuck suite
   * has to be killed by hand and says nothing. The others still run. */
  for (const [name, scenario] of [
    ['lost melt answers', lostMeltAnswer],
    ['a process killed mid-payment', killedMidPayment],
    ['a failing state check', followFaults],
    ['unusable change', badChange],
    ['racing money paths', racing],
    ['the refund guards', refundGuards],
    ['the route closed', routeClosed],
    ['a claim whose answer was lost', claimFaults],
    ['a quote the mint has forgotten', forgottenQuote],
  ]) {
    await within(5, name, scenario);
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  const expected = results.filter(r => r.startsWith('known')).length;
  const money = results.filter(r => r.startsWith('MONEY'));
  if (failed) { console.log('\n' + failed + ' on-chain fault check(s) failed'); process.exit(1); }
  if (money.length) {
    console.log('\n' + money.length + ' of these are sats being DESTROYED, not misreported:');
    money.forEach(r => console.log('  ' + r));
  }
  /* The last line is the only one check-all.sh prints, so it has to carry the
   * worst of what the run found. */
  console.log('\nall ' + results.length + ' on-chain fault checks pass, ' + expected
    + ' expected failures'
    + (money.length ? ' — and ' + money.length + ' MONEY-LOSING regressions pinned, '
        + 'see the MONEY lines: the on-chain refund returns nothing' : ''));
  // jsdom leaves its timers running, and the wallet's background checks with them
  process.exit(0);
}

run().catch(e => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
