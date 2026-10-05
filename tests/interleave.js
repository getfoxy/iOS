'use strict';
/* interleave.js — the money operations, run against each other and against
 * failures, in schedules nobody wrote by hand.
 *
 *     node tests/interleave.js
 *     node tests/interleave.js --seed 12345      one schedule again
 *     node tests/interleave.js --rounds 200      more of them
 *
 * WHY THIS EXISTS
 *
 * run.js asks whether an operation does what it should. This asks whether any
 * ORDER of them can leave the books wrong. Four of the review's findings were
 * of that kind — reconcile overwriting a payment's write, a melt settling while
 * proofs were being returned, an import landing mid-swap — and each was found
 * by a person imagining an interleaving. A reviewer, human or model, reading
 * this code cannot enumerate those orders reliably; a machine can, and the
 * relationships below decide the verdict without anyone having to predict what
 * the right answer was.
 *
 * WHAT IT COVERS
 *
 * Every money path the proof lock wraps, on two mints at once:
 *
 *   - Lightning: claim, pay, sendToken, receiveToken, sweepMelts, reconcile,
 *     importProofs, recoverSwaps, unquarantine;
 *   - on chain (NUT-30, build/wallet/16a-onchain.js): an address, what the
 *     mint has seen paid to it, the claim, a payout and the follow that
 *     settles or refunds it — a payout can be mid-flight while a claim lands;
 *   - a transfer from the other mint (transferQuote then moveRun), which
 *     changes the connected mint under whatever else is running;
 *   - a payment a stranger posted to this phone's onion inbox (_requestPaid),
 *     which redeems proofs the page never asked for.
 *
 * WHAT A ROUND IS
 *
 * A funded wallet on the page as it ships (cashu-ts, NUT-13 secrets from the
 * mocked phone, harness.js's fakeMint at two mints, both settling on chain),
 * then a random schedule of those operations, started in overlapping pairs so
 * they must queue behind each other, with a fault or a storage failure armed
 * part-way. After each step:
 *
 *   - the money is all there (books(), below): every sat the mints have
 *     signed for is either held somewhere this wallet knows of — a pile, a
 *     melt in flight, an on-chain payout's record, quarantine, a token handed
 *     over — or taken by a mint. Nothing counted twice, and nothing lost;
 *   - the ledger balances (invariants.js): balance moved by what history says,
 *     with sats held against a routing payment counted separately;
 *   - no secret carries two signatures (invariants.js's proof box);
 *   - the proof lock was never held twice (proofLockDepth() never above 1);
 *   - nothing the mint signed for us was dropped silently: a write that fails
 *     must throw, not return.
 *
 * A failure prints the seed and the schedule, and that seed replays it exactly.
 *
 * FAULTS use the vocabulary of tools/live/fault-proxy.js, so a failure here and
 * one against a real mint are described the same way: drop-after (the mint
 * acted, the answer never arrived), status (a refusal), delay-after, and
 * storage-full (the phone's store refuses a write, which must throw). A fault
 * path is matched by prefix, so /v1/melt covers the on-chain melt as well.
 *
 * A CONFIRMED PAYOUT'S FEE IS WATCHED HERE
 *
 * Nothing about the balance moves when a payout confirms, so the ledger check
 * cannot see its fee go wrong; this can. `onchainFollow`, seeing PAID, may
 * raise the history fee to everything the record held beyond the amount —
 * which is right when the melt's answer was lost and its change went with it,
 * and wrong when the melt answered and the change is already back in the pile.
 * It was the second for a day: a payout that cost 12 sats settled at 24
 * (fixed by looking at whether the record already carries a fee).
 * A run that sees a confirmed payout's fee rise at all now fails.
 */
process.env.TZ = 'UTC';
const { loadReal, fakeMint, nativePhone, noBooks } = require('./harness');
const { ledgerBalances, makeProofBox, snapshot } = require('./invariants');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const ROUNDS = arg('rounds', 80);
const ONE_SEED = process.argv.indexOf('--seed') >= 0 ? arg('seed', 1) : null;
// the whole set of schedules, which is the only run that can speak for the pin below
const FULL = ONE_SEED === null && process.argv.indexOf('--rounds') < 0;

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MINT = 'https://m.test';
// the mint a transfer moves ecash from: another mint's proofs are worthless here
const OTHER = 'https://m2.test';
// BOLT 11's example invoice at 2500n — 250 sat. The fake mint reads the amount and pretends to route.
const INVOICE = 'lnbc2500n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm';
// an address to pay out to. The mint takes any it is given; a person's typing is fuzz-parsers.js's job.
const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
// a payment confirming on chain, above the mint's floor, and a payout at that
// floor — nothing smaller is worth a transaction, and the mint refuses it
const CONFIRMED = 16384;
const PAYOUT = 16384;
// what the wallet starts with: enough for a payout at the floor, and ecash at
// the other mint for a transfer to bring across
const FUNDS = 65536;
const FUNDS_OTHER = 4096;

/* A seeded random source, so a failing round replays from its seed alone
 * (fuzz-parsers.js does the same). */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const pick = (rnd, list) => list[Math.floor(rnd() * list.length) % list.length];
const tick = () => new Promise((r) => setTimeout(r, 0));
const sats = (list) => (list || []).reduce((n, p) => n + (Number(p && p.amount) || 0), 0);

/* The page as it ships, with a fake mint at each of two hosts behind the
 * bridge and the phone's seed. `faults` is consulted for every mint request;
 * `kill` for every write.
 *
 * Built here rather than imported: run.js's equivalent lives inside a block and
 * is not exported, and copying 40 lines is cheaper than restructuring a suite
 * of 182 passing tests. */
function page() {
  const phone = nativePhone({ words: WORDS });
  const faults = [];
  const writes = { n: 0, failAt: null, failed: 0 };
  const mints = {};
  const inbox = { answers: [], n: 0 };
  /* Bridge messages asked and not yet answered. A check run while one is out
   * would see ecash that has left the pile and not yet arrived anywhere, so
   * the round waits for this to fall to nothing first (settle). */
  const out = { busy: 0 };
  const answer = (w, id, text, err) => setTimeout(() => {
    out.busy -= 1;
    w.FoxyWallet._scanResult(id, text, err);
  }, 0);

  const ctx = loadReal({
    bridge: (w, m) => {
      out.busy += 1;
      if (m.action === 'inboxAnswer') {
        // what the payer of a request is told (Foxy/Network/OnionInbox.swift)
        inbox.answers.push({ answer: String(m.answer), status: Number(m.status), text: String(m.text || '') });
        return answer(w, m.id, 'ok');
      }
      if (m.action !== 'mintRequest') {
        const got = phone.answer(w, m);
        if (!got) return answer(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => answer(w, m.id, r[0], r[1]));
      }
      const url = new URL(m.url);
      const mint = mints[url.origin];
      if (!mint) return answer(w, m.id, null, 'no mint at ' + url.origin);
      const rule = faults.find((f) => f.times !== 0 && url.pathname.indexOf(f.path) === 0);
      if (rule) {
        rule.times -= 1;
        rule.hits = (rule.hits || 0) + 1;
        // drop-after: the mint really acts, and the answer is lost on the way back.
        // This is the dangerous one — the wallet must not assume nothing happened.
        if (rule.action === 'drop-after') {
          mint.handle(m);
          rule.acted = true;
          return answer(w, m.id, null, 'The network connection was lost.');
        }
        if (rule.action === 'status') return answer(w, m.id, '500\n{"detail":"the mint is unwell"}');
        if (rule.action === 'delay-after') {
          const said = mint.handle(m);
          return setTimeout(() => answer(w, m.id, said), rule.ms || 5);
        }
      }
      return answer(w, m.id, mint.handle(m));
    },
    before: (w) => {
      phone.attach(w);
      /* Two mints, each with its own keyset (fill) so neither can honour the
       * other's ecash, and both settling on chain. */
      mints[new URL(MINT).origin] = fakeMint(w, { onchain: true });
      mints[new URL(OTHER).origin] = fakeMint(w, { fill: 8, onchain: true, quoteFrom: 1000 });
      /* The storage seam. save() in build/wallet/01-storage-and-piles.js writes
       * through this; mustSave() turns a refusal into a throw. Overriding the
       * prototype is what jsdom honours — overriding the instance's setItem
       * silently does nothing. */
      const real = w.Storage.prototype.setItem;
      w.Storage.prototype.setItem = function (k, v) {
        writes.n += 1;
        if (writes.failAt !== null && writes.n >= writes.failAt) {
          writes.failed += 1;
          throw new Error('QuotaExceededError');
        }
        return real.call(this, k, v);
      };
    },
  });
  return Object.assign(ctx, {
    phone, faults, writes, inbox, mints, out,
    at: (url) => mints[new URL(url).origin],
    read: (key, fallback) => {
      try { return JSON.parse(ctx.storage.getItem(key) || fallback); } catch (e) { return JSON.parse(fallback); }
    },
    /* A step is over when nothing is on its way to the phone or a mint and the
     * proof lock is free. Without this the money check would read the pile in
     * the middle of a swap, where ecash is legitimately nowhere. */
    settle: async () => {
      const depth = () => (ctx.W.proofLockDepth ? ctx.W.proofLockDepth() : 0);
      for (let i = 0; i < 300; i++) {
        // twice over: a lock let go on one tick is often taken again on the next
        if (!out.busy && !depth()) {
          await tick();
          if (!out.busy && !depth()) return true;
        }
        await tick();
      }
      return false;
    },
  });
}

/* WHERE THE MONEY IS
 *
 * Every proof this wallet knows of, and where it is kept: the piles (one per
 * mint, and per unit), the melts still routing, an on-chain payout's record,
 * quarantine, and the tokens made and handed over. everyHeldProof() and
 * spokenForSecrets() in the wallet are the same idea between them; this reads
 * the same places off the disk, so a hold the wallet has stopped looking at is
 * still counted here. */
function holdings(P) {
  const out = [];
  const add = (where, list) => (list || []).forEach((p) => { if (p && p.secret) out.push({ where, proof: p }); });
  for (let i = 0; i < P.storage.length; i++) {
    const key = P.storage.key(i);
    if (/^foxy\.cashu\.proofs/.test(key)) add(key, P.read(key, '[]'));
  }
  P.read('foxy.cashu.melting', '[]').forEach((m) => add('a melt in flight', m && m.proofs));
  P.read('foxy.cashu.onchain.out', '[]').forEach((m) => add('an on-chain payout', m && m.proofs));
  P.read('foxy.cashu.quarantine', '[]').forEach((e) => add('quarantine', [e && e.proof ? e.proof : e]));
  P.W._sentTokens().forEach((e) => {
    let info = null;
    try { info = P.W.tokenInfo(e.token); } catch (x) {}
    add('a token handed over', info && info.proofs);
  });
  return out;
}

/* THE MONEY IS ALL THERE
 *
 * A mint's books say how much ecash it has signed for and how much it has
 * taken back; the difference is what it still honours. Every sat of that
 * should be held somewhere above — and each secret in exactly one place, or
 * the same money is being shown twice.
 *
 * Returns { ours, live, twice }: what the wallet holds that no mint has taken,
 * what the mints still honour, and the first secret found in two places.
 */
function books(P) {
  const spent = new Set();
  let live = 0;
  Object.keys(P.mints).forEach((origin) => {
    const mint = P.mints[origin];
    live += mint.issuedSats() - mint.takenSats();
    mint.spentSecrets.forEach((s) => spent.add(s));
  });
  const seen = new Map();
  let ours = 0, twice = null;
  for (const h of holdings(P)) {
    const secret = String(h.proof.secret);
    if (seen.has(secret)) {
      if (!twice) {
        twice = 'secret ' + secret.slice(0, 12) + '… is held in two places at once: '
          + seen.get(secret) + ' and ' + h.where;
      }
      continue;
    }
    seen.set(secret, h.where);
    // a proof a mint has already taken is not money; reconcile is what clears it
    if (!spent.has(secret)) ours += Number(h.proof.amount) || 0;
  }
  return { ours, live, twice };
}

/* Sats out of the balance that history does not yet account for.
 *
 * invariants.js counts the proofs held against a routing melt. An on-chain
 * payout is the other one, and it is not the same shape: its history entry is
 * written BEFORE the melt, so what is unaccounted for is only the part of the
 * hold the entry does not name — the fee reserve, until the mint's answer says
 * what it really cost and returns the rest. Once the mint has answered
 * (`feeSats` on the record) the change is back in the pile and nothing is
 * outstanding. */
function onchainHeld(P) {
  const log = P.read('foxy.cashu.log', '[]');
  let held = 0;
  P.read('foxy.cashu.onchain.out', '[]').forEach((r) => {
    if (!r || !(r.proofs || []).length) return;
    if (r.feeSats !== undefined && r.state !== 'UNKNOWN' && r.state !== 'SENDING') return;
    const entry = log.filter((e) => e && e.hash === 'onchain-' + r.quote)[0];
    if (!entry) return;
    held += Math.max(0, sats(r.proofs) - (Number(entry.sats) || 0) - (Number(entry.feeSats) || 0));
  });
  return held;
}

/* What the invariants compare, with the two corrections this suite owns.
 *
 * The first is the on-chain hold above. The second is settlement: invariants.js
 * treats an entry as new when its hash or its settled flag has changed, which
 * is right for a payment whose entry is written when it settles and wrong for
 * an on-chain payout, whose entry is written before the melt and settles days
 * later when the transaction confirms. Left alone, the ledger charged the
 * payment twice — once when the money left, once when the mint said PAID.
 * Nothing about the balance moves at that moment, so the flag is held still. */
async function look(P) {
  const shot = await snapshot(P.W);
  shot.held += onchainHeld(P);
  shot.log = shot.log.map((e) => (e && /^onchain-/.test(String(e.hash)) && e.dir === 'out'
    ? Object.assign({}, e, { settled: false })
    : e));
  return shot;
}

/* Every operation the proof lock wraps that a schedule can start on its own.
 * claimQuote, adoptScan, recoverIssued and reclaimToken need a quote, a scan or
 * a token in hand, so they arrive through the ones below rather than directly;
 * so does an on-chain claim, which needs an address and a payment to it, and a
 * payout's follow, which needs a payout.
 *
 * dedupeProofs stood here until it was deleted from the wallet
 * for want of a caller: nothing in build/ reached it, so the lock now wraps
 * seventeen functions rather than eighteen. */
function operations(P) {
  const W = P.W;
  /* The address most recently made, or a new one. An on-chain claim cannot be
   * started without one, the way claimQuote cannot be started without a quote. */
  const address = async () => {
    const last = P.chain[P.chain.length - 1];
    if (last) return last;
    const made = await W.onchainAddress();
    P.chain.push(made);
    return made;
  };
  return [
    ['sendToken', async () => { const t = await W.sendToken(8); return t && t.token; }],
    ['receiveToken', async (last) => { if (last) await W.receiveToken(last); }],
    ['pay', () => W.pay(INVOICE)],
    ['reconcile', () => W.reconcile()],
    ['importProofs', () => W.importProofs(JSON.stringify({ proofs: [] }))],
    ['sweepMelts', () => W.sweepMelts()],
    ['recoverSwaps', () => W.recoverSwaps()],
    ['unquarantine', () => W.unquarantine()],
    ['claim', async () => { const inv = await W.invoice(32, ''); return W.claim(inv.hash); }],

    ['onchainAddress', async () => { P.chain.push(await W.onchainAddress()); }],
    ['onchainSeen', async () => { const a = await address(); await W.onchainSeen(a.quote); }],
    ['onchainClaim', async () => {
      const a = await address();
      // the payment confirms: three blocks deep, as this mint counts them
      P.at(a.mint).onchainCredit(a.quote, CONFIRMED);
      await W.onchainClaim(a.quote);
    }],
    ['onchainPay', async () => {
      // the fee options in turn, taken before the first await so the schedule decides it
      const turn = P.turn.fee++;
      const plan = await W.onchainQuote(ADDRESS, PAYOUT);
      const fee = plan.options[turn % plan.options.length];
      await W.onchainPay(plan, fee.index);
    }],
    ['onchainFollow', async () => {
      const turn = P.turn.follow++;
      const out = W.onchainSending();
      if (!out.length) return;
      const r = out[0];
      const before = P.read('foxy.cashu.log', '[]').filter((e) => e && e.hash === 'onchain-' + r.quote)[0];
      const knew = r.feeSats !== undefined ? Number(r.feeSats) || 0 : null;
      /* What the world did with the payout, one of three ways round: the
       * transaction confirmed, nothing has happened yet, or the mint never
       * took it and the record is old enough for that to be a verdict (the
       * two-minute wait in 16a-onchain.js — the only way to reach it without
       * a test that sleeps for two minutes). */
      if (turn % 3 === 0) P.at(r.mint).onchainConfirm(r.quote);
      if (turn % 3 === 2) backdate(P, r.quote);
      const said = await W.onchainFollow(r.quote);
      const state = String((said && said.state) || '');
      if (state === 'UNPAID' || state === 'FAILED') P.step.refunded = true;
      /* The pinned fee (see the header): a payout that confirms has its
       * history fee raised to the whole hold, change and all, even though the
       * melt already said what it cost. Counted here — the ledger check cannot
       * see it, because nothing about the balance moves when a payout
       * confirms, so this is the only thing watching it. */
      if (state === 'PAID' && knew !== null && before) {
        const now = P.read('foxy.cashu.log', '[]').filter((e) => e && e.hash === 'onchain-' + r.quote)[0];
        const was = Number(before.feeSats) || 0, raised = Number(now && now.feeSats) || 0;
        if (raised > was) P.pins.push({ sats: Number(before.sats) || 0, was: was, now: raised });
      }
    }],

    ['transfer', async () => {
      /* From the other mint to this one: an invoice here, a melt there, a
       * claim here (build/wallet/14-moving-between-mints.js). The connected
       * mint changes under whatever else is running, which is the point of
       * having it in the schedule; it is put back afterwards however it went. */
      const plan = await W.transferQuote(OTHER, 256);
      P.step.moved = true;
      await W.connect(OTHER);
      try {
        await W.moveRun(plan, () => {});
      } finally {
        if (W.mintHost() !== new URL(MINT).host) await W.connect(MINT).catch(() => {});
      }
    }],

    ['requestPaid', async () => {
      /* A payment posted to this phone's onion inbox by someone else
       * (build/wallet/20-helpers.js _requestPaid). The proofs are real ecash
       * at this mint — a token this wallet made, which is what a payer's
       * wallet would send — and the wallet must redeem them exactly once. */
      const request = W.paymentRequest(16, { purpose: 'receive' });
      if (!request) return;
      const id = (W.decodeRequest(request) || {}).id;
      const made = await W.sendToken(16);
      const info = W.tokenInfo(made && made.token);
      if (!id || !info || !info.proofs.length) return;
      const key = 'inbox-' + (P.inbox.n++);
      W._requestPaid(JSON.stringify({
        id: id, mint: String(info.mint || '').replace(/\/+$/, ''), unit: 'sat',
        proofs: info.proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C })),
      }), key);
      // the payer is always answered; waiting for it keeps the redemption inside the step
      for (let i = 0; i < 300 && !P.inbox.answers.some((a) => a.answer === key); i++) await tick();
    }],
  ];
}

/* A payout's record made three minutes ago. The wallet holds the ecash of a
 * payment the mint reads as UNPAID until the record is two minutes old, in
 * case the melt is still on its way (W4); nothing else can reach the refund. */
function backdate(P, quote) {
  try {
    const list = P.read('foxy.cashu.onchain.out', '[]');
    list.forEach((r) => { if (r && r.quote === quote) r.at = Date.now() - 180000; });
    P.storage.setItem('foxy.cashu.onchain.out', JSON.stringify(list));
  } catch (e) { /* the store is refusing writes this round; the follow still runs */ }
}

const FAULTS = [
  { path: '/v1/swap', action: 'drop-after', times: 1 },
  { path: '/v1/melt', action: 'drop-after', times: 1 },
  { path: '/v1/mint', action: 'drop-after', times: 1 },
  { path: '/v1/swap', action: 'status', times: 1 },
  { path: '/v1/checkstate', action: 'status', times: 1 },
  { path: '/v1/melt', action: 'delay-after', times: 1, ms: 8 },
  { path: '/v1/swap', action: 'delay-after', times: 1, ms: 8 },
  { path: '/v1/melt/onchain', action: 'status', times: 1 },
  { path: '/v1/mint/onchain', action: 'drop-after', times: 1 },
];

async function round(seed) {
  const rnd = random(seed);
  const P = Object.assign(page(), {
    chain: [],                    // the on-chain addresses made this round
    turn: { fee: 0, follow: 0 },  // fee options and outcomes taken in turn, not at random
    pins: [],                     // payouts whose history fee the pinned bug raised
    /* Two things the ledger check cannot follow, set by the operation that
     * does them and cleared at the end of the step: unlike a refused write,
     * neither leaves the following steps unreadable. */
    step: { moved: false, refunded: false },
  });
  const W = P.W;
  const schedule = [];
  const say = (s) => schedule.push(s);

  await W.seedReady();
  // ecash at the other mint first, for a transfer to bring across
  await W.connect(OTHER);
  await W.claim((await W.invoice(FUNDS_OTHER, '')).hash);
  await W.connect(MINT);
  await W.claim((await W.invoice(FUNDS, '')).hash);

  const box = makeProofBox();
  let before = await look(P);
  let depthSeen = 0;
  const watchDepth = setInterval(() => {
    const d = W.proofLockDepth ? W.proofLockDepth() : 0;
    if (d > depthSeen) depthSeen = d;
  }, 1);

  // one fault, armed before the schedule runs
  if (rnd() < 0.8) {
    const f = Object.assign({}, pick(rnd, FAULTS));
    P.faults.push(f);
    say('fault ' + f.action + ' ' + f.path);
  }
  // a storage failure part-way through, sometimes
  if (rnd() < 0.3) {
    P.writes.failAt = P.writes.n + 2 + Math.floor(rnd() * 8);
    say('storage-full at write ' + P.writes.failAt);
  }

  const ops = operations(P);
  let carried = null;
  /* Set when the wallet correctly refuses in a way that breaks a check's
   * premise (see the step loop). Once on, that check is no longer asserted for
   * this round, and the schedule records why. */
  let lostRecord = false, restored = false, ledgerOff = false, moneyOff = false;
  const STEPS = 8;
  for (let i = 0; i < STEPS; i++) {
    // two at once: they must queue on the proof lock rather than interleave
    const [nameA, runA] = pick(rnd, ops);
    const [nameB, runB] = pick(rnd, ops);
    say(nameA + '|' + nameB);
    const both = await Promise.allSettled([runA(carried), runB(carried)]);
    for (const r of both) if (r.status === 'fulfilled' && typeof r.value === 'string') carried = r.value;

    /* A rejection is allowed — a lost answer or a full store must fail loudly.
     * What is not allowed is a rejection that is neither: that means an
     * operation threw for a reason nothing modelled.
     *
     * Told apart by the properties the wallet sets, not by matching its prose:
     * mustSave() marks a refused write `storageFull`, and `unsent` when nothing
     * reached the mint. The two remaining cases are recognised by what they
     * are, and both are the wallet being right out loud — a quote whose record
     * a refused write lost ("not on this device"), and a swap whose answer was
     * dropped after the mint made it, which the seed put back.
     */
    for (const r of both) {
      if (r.status !== 'rejected') continue;
      const e = r.reason || {};
      const text = String(e.message || '');
      if (e.storageFull) continue;                                  // 01-storage-and-piles.js mustSave
      if (/is not on this device/.test(text)) { lostRecord = true; continue; }   // 15-receiving.js
      if (/already swapped the ecash/.test(text)) { restored = true; continue; } // 04-lost-answers.js
      if (/connection was lost|mint is unwell|already spent|not enough/i.test(text)) continue;
      // the money ran out where an operation needs some: a refusal, not a fault
      if (/you hold|costs up to|smaller than the fee|Not enough ecash/i.test(text)) continue;
      // an address or a payout belongs to the mint it was made at, and a transfer
      // can leave another one connected under the operation that follows it
      if (/belongs to|was not made on this device|That address was not/i.test(text)) continue;
      clearInterval(watchDepth);
      return { seed, schedule, problem: 'an operation failed for an unmodelled reason: ' + text };
    }

    /* Nothing on its way to a mint or the phone, and the lock free: the checks
     * below read the disk, and mid-flight ecash is legitimately in neither the
     * pile nor anywhere else. A page that never comes to rest is a finding of
     * its own — 640 steps of it have never failed to — so it is not quietly
     * skipped over. */
    if (!(await P.settle())) {
      clearInterval(watchDepth);
      return { seed, schedule, problem: 'the page never came to rest: something is still asking the mint or holding the proof lock' };
    }

    /* THE MONEY IS ALL THERE, AND WHEN IT CANNOT BE ASSERTED
     *
     * Two of the armed failures really do put ecash beyond the wallet's reach
     * for the rest of the round: an answer dropped after the mint acted leaves
     * signatures nobody received (a seed restore is what gets those back), and
     * a refused write can lose the note of a hold that was made. Neither is
     * the wallet being wrong, so the total is only compared where it means
     * something — but a secret in two places at once is wrong however the
     * round went, and that half is always asserted.
     */
    const dropped = P.faults.some((f) => f.acted);
    const money = books(P);
    if (money.twice) { clearInterval(watchDepth); return { seed, schedule, problem: money.twice }; }
    if ((dropped || P.writes.failed) && !moneyOff) {
      say('(money check off: ' + (dropped ? 'the mint acted on an answer that was lost' : 'storage refused a write') + ')');
      moneyOff = true;
    }
    if (!moneyOff && money.ours !== money.live) {
      clearInterval(watchDepth);
      return { seed, schedule, problem: 'the money does not add up: the mints still honour ' + money.live
        + ' sats and the wallet knows of ' + money.ours + ' (' + (money.live - money.ours) + ' unaccounted for)' };
    }

    /* THE LEDGER CHECK, AND WHEN IT IS OFF
     *
     * invariants.js says plainly that its relationship holds only while this
     * wallet is the only actor. A refused write and a seed restore both break
     * that: proofs leave the pile while the history line that explains them
     * cannot be written, and a restore puts sats back that no entry describes.
     * Both are the wallet behaving correctly, so asserting through them would
     * fail on right answers.
     *
     * Two more belong to the newer paths. A transfer moves money between two
     * mints while the balance is only ever this mint's, so the relationship
     * has nothing to say about it; and a refunded on-chain payout puts its
     * entry back in the reckoning as failed, which the sum in invariants.js
     * counts a second time rather than reversing.
     *
     * The step that caused it is still checked — the money, the proof box and
     * the lock hold whatever storage does — and the round says so, because a
     * check that quietly stops checking reads like a passing one. */
    const after = await look(P);
    if (P.writes.failed) { if (!ledgerOff) say('(ledger check off: storage refused a write)'); ledgerOff = true; }
    if (lostRecord && !ledgerOff) { say('(ledger check off: a refused write lost a quote record)'); ledgerOff = true; }
    if (restored && !ledgerOff) { say('(ledger check off: the seed put a lost swap back)'); ledgerOff = true; }
    let stepOff = '';
    if (P.step.moved) stepOff = 'a transfer moved money between mints';
    if (P.step.refunded) stepOff = 'an on-chain payout was refunded';
    if (stepOff) say('(ledger check off for this step: ' + stepOff + ')');
    // and the harness's own question as the suite ends (harness.js, "the books") is off with it, for the same reason
    if (ledgerOff) noBooks(P, 'a write was refused, or the seed put a lost swap back');
    const ledger = (ledgerOff || stepOff) ? null : await ledgerBalances(W, before, after);
    if (ledger) { clearInterval(watchDepth); return { seed, schedule, problem: ledger }; }
    const pile = [];
    for (let k = 0; k < P.storage.length; k++) {
      const key = P.storage.key(k);
      if (/^foxy\.cashu\.proofs\./.test(key)) pile.push(...JSON.parse(P.storage.getItem(key) || '[]'));
    }
    const doubled = box.add(pile);
    if (doubled) { clearInterval(watchDepth); return { seed, schedule, problem: doubled }; }
    before = after;
    P.step.moved = false;
    P.step.refunded = false;
  }

  clearInterval(watchDepth);
  if (depthSeen > 1) return { seed, schedule, problem: 'the proof lock was held ' + depthSeen + ' deep' };

  // a write that failed must have been refused loudly, never swallowed
  if (P.writes.failed && P.writes.failAt !== null) {
    const balance = await W.balanceSats();
    if (!(balance >= 0)) return { seed, schedule, problem: 'balance is not a number after a refused write' };
  }
  return { seed, schedule, problem: null, pins: P.pins };
}

(async () => {
  const seeds = ONE_SEED !== null ? [ONE_SEED]
    : Array.from({ length: ROUNDS }, (_, i) => 1000 + i * 7919);
  let failed = 0;
  const pins = [];
  const began = Date.now();
  for (const seed of seeds) {
    let out = null;
    try {
      out = await round(seed);
    } catch (e) {
      out = { seed, schedule: ['threw before the checks'], problem: 'threw: ' + (e && e.stack || e) };
    }
    if (out && out.pins) pins.push(...out.pins);
    if (out && out.problem) {
      failed += 1;
      console.log('FAIL  seed ' + out.seed);
      console.log('      ' + out.problem);
      console.log('      schedule: ' + out.schedule.join(' → '));
      console.log('      replay:   node tests/interleave.js --seed ' + out.seed);
    }
  }
  console.log('');
  console.log(failed
    ? failed + ' of ' + seeds.length + ' schedules failed'
    : 'all ' + seeds.length + ' schedules keep the books ('
      + Math.round((Date.now() - began) / 1000) + 's)');
  /* A confirmed payout's fee must not move: the melt already said what it
   * cost, and the correction for a lost answer must not touch one that
   * arrived (see this file's header). */
  if (pins.length) {
    const one = pins[0];
    console.log('FAIL  ' + pins.length + ' confirmed on-chain payout' + (pins.length === 1 ? '' : 's')
      + ' had the history fee raised on settling (one of them: ' + one.sats + ' sats cost ' + one.was
      + ', shown as ' + one.now + ') — see this file’s header');
    failed = failed || 1;
  }
  process.exit(failed ? 1 : 0);
})();
