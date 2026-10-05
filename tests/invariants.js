/* invariants.js — two things that must be true after any operation.
 *
 * Not examples. An example test asserts what you expected; an invariant
 * asserts a relationship, and fails on things nobody thought to check. Four of
 * the sixteen bugs found in one early session would have failed the first of these on
 * the operation that introduced them.
 *
 *     node tests/run.js
 *
 * WHY THESE ARE TEST-TIME AND NOT RUNTIME ASSERTIONS
 *
 * The balance can legitimately change with no history entry: proofs spent in
 * another wallet are dropped by reconcile, and that is correct. So the
 * relationship only holds while this wallet is the only actor — which a test
 * controls and an app cannot.
 */
'use strict';

/* 1. THE LEDGER BALANCES
 *
 * Sum every history entry and you get the change in balance. Incoming credits
 * what arrived; outgoing costs the amount plus its fee. Anything else means
 * the app is showing a number that does not describe what happened — which is
 * what "history says -500, balance fell 502" was.
 *
 * Proofs held against a melt in flight are out of the balance and not yet in
 * history, so they are counted separately rather than ignored.
 */
async function ledgerBalances(W, before, after) {
  const moved = after.balance - before.balance;

  const fresh = after.log.filter(
    t => !before.log.some(b => b.hash === t.hash && b.settled === t.settled));

  let expected = 0;
  for (const t of fresh) {
    const sats = Number(t.sats) || 0;
    const fee = Math.max(0, Number(t.feeSats) || 0);
    expected += t.dir === 'in' ? sats : -(sats + fee);
  }

  // sats parked against a melt whose outcome is unknown have left the balance
  // and have no settled history entry yet
  const heldNow = before.held - after.held;
  expected += heldNow;

  if (moved !== expected) {
    return ('the ledger does not balance: balance moved ' + moved
      + ' but history accounts for ' + expected
      + ' (' + fresh.length + ' new entr' + (fresh.length === 1 ? 'y' : 'ies')
      + ', held changed by ' + (after.held - before.held) + ')');
  }
  return null;
}

/* 2. A SECRET NEVER CARRIES TWO SIGNATURES
 *
 * Borrowed from nutshell's ProofBox. The same secret appearing with a
 * different C means something rebuilt a proof rather than carrying it, and the
 * amounts can still add up while that is true — so the ledger check above
 * cannot see it.
 */
function makeProofBox() {
  const seen = new Map();
  return {
    add(proofs) {
      for (const p of proofs || []) {
        if (!p || !p.secret) continue;
        const had = seen.get(p.secret);
        if (had && had.C !== p.C) {
          return 'secret ' + String(p.secret).slice(0, 12)
            + '… carries two different signatures';
        }
        if (!had) seen.set(p.secret, p);
      }
      return null;
    },
    size: () => seen.size,
  };
}

/* A snapshot of everything the invariants compare. */
async function snapshot(W) {
  const [balance, log] = await Promise.all([
    W.balanceSats(),
    W.transactions(200),
  ]);
  const held = (W.pendingMelts() || [])
    .reduce((n, e) => n + (Number(e.amount) || 0), 0);
  return { balance, log: log || [], held };
}

module.exports = { ledgerBalances, makeProofBox, snapshot };
