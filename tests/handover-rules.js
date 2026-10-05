'use strict';
/* handover-rules.js — the two rules, and the refusal when they cannot both hold.
 *
 *     node tests/handover-rules.js
 *
 * Every hand-over of ecash in Foxy has to satisfy both of these, and they are
 * the design, not an aspiration:
 *
 *   NOTHING GETS STUCK. The party with no route must end up holding ecash it
 *   can still do something with alone — at a mint it uses, locked to a key its
 *   own twelve words rebuild. A phone with no route cannot swap, melt or move
 *   mints, so ecash at somebody else's mint in its hands is money it can only
 *   look at.
 *
 *   NOBODY CAN DOUBLE SPEND while either party is online. Two ways to get it,
 *   and only two: the payer has a route, swaps, and locks the proofs to the
 *   receiver, so its own copy is worthless; or the receiver has a route and
 *   swaps the instant the ecash lands, so the payer's copy dies within the
 *   second. Neither with a route is neither of those.
 *
 *   AND IF EITHER FAILS, NOTHING MOVES — checked before a proof is touched, not
 *   after a token has been made and handed to somebody who says no.
 *
 * `handoverRefusal` is where they are written; `payRequest` is where they are
 * asked. This drives both.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const OTHER = 'https://other.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

/* The predicate itself, lifted out of the shipped wallet and run directly:
 * every combination, not the handful a flow happens to reach. */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
function fn(sig) {
  const at = src.indexOf('\n  function ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 1, i + 1);
}
let allowBoth = false;
const rules = new Function('offlineToOffline',
  fn('handoverRefusal(o)') + '; return handoverRefusal;')(() => allowBoth);

const refusal = (o) => rules(o);
const moves = (o) => rules(o) === '';

/* A whole page of the shipped wallet, with a fake mint behind the bridge.
 * `ctx.deaf` is the mint going unreachable, which is what no route looks like
 * from inside the page. */
function page(o) {
  const opts = o || {};
  const ph = nativePhone({ words: opts.words || PHONE_WORDS });
  let m = null, c = null;
  const back = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  c = loadReal({
    bridge: (w, msg) => {
      if (msg.action === 'mintRequest') {
        if (c.deaf) return back(w, msg.id, null, 'The Internet connection appears to be offline');
        return back(w, msg.id, m.handle(msg));
      }
      const got = ph.answer(w, msg);
      if (!got) return back(w, msg.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => back(w, msg.id, r[0], r[1]));
    },
    before: (w) => { ph.attach(w); m = opts.sharedMint || fakeMint(w, { p2pk: true }); },
  });
  c.mint = m;
  c.W._nodeProbeDelay = [86400000, 86400000];
  return c;
}

async function run() {
  /* ---- the predicate, over every combination -------------------------------
   * Sixteen cases, and the answer to each is a sentence you can say out loud. */
  const all = [];
  for (const payerHasRoute of [true, false]) {
    for (const receiverHasRoute of [true, false, null]) {
      for (const locked of [true, false]) {
        for (const atTheirMint of [true, false]) {
          all.push({ payerHasRoute, receiverHasRoute, locked, atTheirMint });
        }
      }
    }
  }
  const say = (c) => (c.payerHasRoute ? 'payer online' : 'payer offline') + ', '
    + (c.receiverHasRoute === null ? 'receiver did not say'
       : c.receiverHasRoute ? 'receiver online' : 'receiver offline') + ', '
    + (c.locked ? 'locked' : 'unlocked') + ', '
    + (c.atTheirMint ? 'their mint' : 'another mint');

  // 1. neither online: never, whatever else is true
  const neither = all.filter((c) => !c.payerHasRoute && c.receiverHasRoute === false);
  /* Nothing moves with nobody online, and there is no arrangement of the other
   * two that changes it.
   *
   * One shape does survive the arithmetic: ecash already locked to the
   * receiver, at the receiver's own mint, which takes a payer that swapped
   * while it had a route and lost it before delivering. The payer cannot spend
   * what it is holding, so nothing can be raced, and the receiver opens it
   * whenever it reconnects. It is safe and it is not allowed — a scheme nobody
   * would set out to use, and every case a wallet allows is a case it has to
   * keep right for ever. One of you must be online, and
   * that is the whole of the rule. */
  ok(neither.every((c) => !moves(c)),
     'with neither online nothing moves, however the payment is dressed up',
     neither.filter(moves).map(say).join(' | ') || 'all four refused');
  /* And the words are about the route, not about a condition to go and satisfy —
   * except where the mint is wrong too, which rule one answers first and which
   * is the more useful thing to say. */
  ok(neither.filter((c) => c.atTheirMint).every((c) => /both offline/.test(refusal(c))),
     'and the refusal says so plainly rather than naming a condition to satisfy',
     neither.filter((c) => c.atTheirMint).map((c) => refusal(c).slice(0, 40)).join(' | '));

  // 2. the receiver online settles it, so the rest is its own business
  const rxUp = all.filter((c) => c.receiverHasRoute === true);
  ok(rxUp.every(moves),
     'a receiver with a route swaps at once, so unlocked and elsewhere are both fine',
     rxUp.filter((c) => !moves(c)).map(say).join(' | ') || 'all eight allowed');

  // a receiver that said nothing: never refused on that account alone
  const quietOnes = all.filter((c) => c.receiverHasRoute === null);
  ok(quietOnes.every(moves),
     'and one that said nothing is never refused for not saying',
     quietOnes.filter((c) => !moves(c)).map(say).join(' | ') || 'all eight allowed');

  // 3. the receiver offline: this phone has to make it safe, and both halves count
  ok(!moves({ payerHasRoute: true, receiverHasRoute: false, locked: false, atTheirMint: true }),
     'ecash anyone could spend is not handed to a phone that cannot swap it',
     refusal({ payerHasRoute: true, receiverHasRoute: false, locked: false, atTheirMint: true }));
  ok(!moves({ payerHasRoute: true, receiverHasRoute: false, locked: true, atTheirMint: false }),
     'and neither is ecash from a mint they cannot reach to use',
     refusal({ payerHasRoute: true, receiverHasRoute: false, locked: true, atTheirMint: false }));
  ok(moves({ payerHasRoute: true, receiverHasRoute: false, locked: true, atTheirMint: true }),
     'locked, and at their own mint, is the one shape that works for an offline receiver');

  // 4. the switch, and only for the case it is about
  allowBoth = true;
  ok(moves({ payerHasRoute: false, receiverHasRoute: false, locked: false, atTheirMint: true }),
     'the offline-to-offline switch opens that one case when it is turned on');
  ok(!moves({ payerHasRoute: true, receiverHasRoute: false, locked: false, atTheirMint: true }),
     'and opens nothing else: an offline receiver still gets no unlocked ecash');
  ok(!moves({ payerHasRoute: false, receiverHasRoute: false, locked: true, atTheirMint: false }),
     'nor does it open handing an offline phone ecash from a mint it cannot reach');
  allowBoth = false;
  ok(!moves({ payerHasRoute: false, receiverHasRoute: false, locked: true, atTheirMint: true }),
     'and with it off, even ecash already locked to them at their own mint waits for a route');
  allowBoth = false;

  /* ---- and through payRequest, where a real payment is refused -------------
   * The point is not only the answer but when it arrives: before anything is
   * made. A refusal after the swap costs counters, re-splits the pile and
   * leaves a token to get rid of. */
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  let deaf = false;
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        if (deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
        return reply(w, m.id, mint.handle(m));
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  const W = ctx.W;
  W._nodeProbeDelay = [86400000, 86400000];
  await W.connect(MINT, null, null, { remember: true });
  const inv = await W.invoice(512, '');
  await W.claim(inv.hash);
  const before = await W.balanceSats();
  const pile = () => {
    try { return JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.' + MINT) || '[]'); }
    catch (e) { return []; }
  };
  const pieces = pile().map((p) => p.secret).sort().join(',');

  /* A receiver that says it has no route. It says so in its tap offer
   * (`up: false`), which is the only honest source: an online receiver whose
   * Tor has not published an address yet names no transports either, and
   * guessing from that refused payments that would have settled in a second
   * (tests/change-leg.js). */
  deaf = true;
  W._privacy({ tor: 'connecting', progress: 0, everUp: false, transport: 'direct', network: 'none' });
  W.setOffline(true);
  let threw = null;
  await W.payRequest({ id: 'abc', sats: 21, mints: [MINT], transports: [],
                       viaTap: true, theirRoute: false },
                     null, {}).catch((e) => { threw = e; });
  ok(threw && /both offline/.test(String(threw.message)),
     'two offline phones: the payment is refused rather than made and handed over',
     String(threw && threw.message).slice(0, 80));
  const after = await W.balanceSats();
  ok(after === before, 'and the balance is untouched', after + ' was ' + before);
  ok(pile().length > 0 && pile().map((p) => p.secret).sort().join(',') === pieces,
     'and not one proof was re-split, which a refusal at the far end costs',
     pile().length + ' pieces');

  /* And the phone that said nothing at all — an older Foxy, or a request
   * scanned rather than tapped. Unknown is not "no": refusing on it would
   * refuse every tap from a build that predates the field, so the payment is
   * made and the receiver, which knows its own state, is the one that answers.
   * The proof that it got past the rules is the error: it is about change, not
   * about routes. */
  let quiet = null;
  await W.payRequest({ id: 'def', sats: 21, mints: [MINT], transports: [], viaTap: true },
                     null, {}).catch((e) => { quiet = e; });
  ok(quiet && !/offline/.test(String(quiet.message)),
     'a receiver that said nothing is asked, not assumed to be offline',
     String(quiet && quiet.message).slice(0, 70));

  /* ---- an offline receiver taking locked ecash ----------------------------
   *
   * This is the supported shape: the payer had a route, swapped, and locked the
   * proofs to the receiver, so the copy it keeps needs the receiver's signature
   * and is worth nothing to it. The receiver has no route, cannot swap, writes
   * it down, and swaps it when one comes back.
   *
   * What an offline receiver cannot do is ask the mint whether it has seen
   * these proofs before — so the one thing left to get wrong is taking the same
   * ecash twice, and it did (probe: 128 sats of pending money for
   * one payment of 64). */
  {
    const rx = page({});
    await rx.W.connect(MINT, null, null, { remember: true });
    await rx.W.primeLocks();
    const creq = rx.W.paymentRequest(64, { purpose: 'receive' });
    const read = rx.W.decodeRequest(creq);
    ok(/^0[23][0-9a-f]{64}$/i.test(String(read.lockTo || '')),
       'the receiver asks for a lock on a key its own seed makes',
       String(read.lockTo || '(none)').slice(0, 18));

    const tx = page({ sharedMint: rx.mint,
      words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
    await tx.W.connect(MINT, null, null, { remember: true });
    const inv2 = await tx.W.invoice(256, ''); await tx.W.claim(inv2.hash);
    // swapped while the payer still had a route: this is what makes it possible
    const made = await tx.W.sendToken(64, { lockTo: read.lockTo });

    const dark = (W) => {
      W._privacy({ tor: 'connecting', progress: 0, everUp: false, transport: 'direct', network: 'none' });
      W.setOffline(true);
    };
    // only the receiver goes dark: the payer swapped and locked while it had a route
    rx.deaf = true; dark(rx.W);

    // and the payer cannot spend what it is holding, route or no route
    const stolen = await tx.W.receiveToken(made.token).then(() => null, (e) => e);
    ok(stolen, 'the payer cannot take its own locked ecash back',
       stolen ? String(stolen.message).slice(0, 60) : 'IT TOOK IT');

    const first = await rx.W.receiveToken(made.token);
    ok(first && first.sats === 64 && first.kept === true,
       'an offline receiver takes ecash locked to it, and writes it down rather than swapping',
       JSON.stringify(first && { sats: first.sats, kept: first.kept }));
    ok(rx.W.unclaimedSats() === 64, 'and counts it once', String(rx.W.unclaimedSats()));

    /* The name a row gets, and the two things it has to do.
     *
     * Same pieces in any order is the same ecash: a token re-encoded with its
     * proofs shuffled must not read as a second payment. Different pieces is
     * different ecash, even for the same amount in the same second, which is
     * exactly what the clock-based name could not tell apart. */
    const fp = (secrets) => rx.W.piecesFingerprint(secrets.map((x) => ({ secret: x })));
    ok(fp(['a', 'b', 'c']) === fp(['c', 'a', 'b']),
       'the same pieces in a different order are the same ecash', fp(['a', 'b', 'c']));
    const many = {};
    for (let i = 0; i < 400; i++) many[fp(['s' + i, 't' + i])] = 1;
    ok(Object.keys(many).length === 400,
       'and four hundred different sets get four hundred different names',
       Object.keys(many).length + ' names');
    ok(fp([]) === fp([]) && typeof fp(['a']) === 'string' && fp(['a']).length <= 24,
       'it is short enough to be a storage key and steady on the empty case', fp(['a']));

    await new Promise((r) => setTimeout(r, 1100));   // past any clock-based id
    const again = await rx.W.receiveToken(made.token).then(() => null, (e) => e);
    ok(again && /already taken/.test(String(again.message)),
       'the same ecash handed over a second time is refused, not counted twice',
       again ? String(again.message).slice(0, 52) : 'IT TOOK IT TWICE');
    ok(rx.W.unclaimedSats() === 64,
       'so one payment stays one payment, on a phone that cannot ask the mint',
       String(rx.W.unclaimedSats()));
  }

  console.log('\n' + (failed ? failed + ' hand-over rule check(s) failed'
    : 'all hand-over rule checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
