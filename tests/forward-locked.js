'use strict';
/* forward-locked.js — handing on ecash locked to this phone, without a mint.
 *
 *     node tests/forward-locked.js
 *
 * A P2PK proof is spent by whoever submits it with a witness that verifies. With
 * SIG_INPUTS — which is cashu-ts's default and the only flag Foxy ever writes —
 * the signature authorises the spend and says nothing about who creates the
 * outputs. So a phone can sign ecash locked to itself and give it away, and the
 * next person redeems it. Signing is local: the key comes from the seed, no mint
 * is asked anything, and it works with no route at all.
 *
 * Why it exists. Locked ecash waits in `foxy.req.unclaimed` until there is a route
 * to swap it in, and the balance counts it meanwhile — "a balance that counts
 * unswapped sats has to be able to spend them" (20-helpers.js). Offline it could
 * not, which was the one place the balance lied, and it made offline change a
 * one-way ratchet: every payment taken in locked ecash was money that could not go
 * out again until the phone found a network.
 *
 * What this cannot prove: that CDK or Nutshell accept a proof signed by one wallet
 * and submitted by another. The harness mint verifies with cashu-ts's own verifier,
 * which catches every mistake a wallet can make by itself but shares code with the
 * signer. The real-mint leg wants tools/live, and Docker was down when this was
 * written.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

let mint = null;
/* Every mint request this wallet makes, so a refusal can be pinned to the phone
 * rather than to the mint. A forged witness is refused either way — the mint
 * enforces P2PK now — so "it failed" proves nothing about the local check. */
function phoneAt(words) {
  const seen = [];
  const phone = nativePhone({ words });
  const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') { seen.push(String(m.url || m.path || '')); return reply(w, m.id, mint.handle(m)); }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); if (!mint) mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.seen = seen;
  return ctx;
}

async function run() {
  /* Two wallets on one mint with different words: the hand-on has to cross a real
   * seed boundary or it proves nothing. */
  const A = phoneAt(PHONE_WORDS);
  const C = phoneAt(OTHER_WORDS);
  await A.W.connect(MINT, { remember: true });
  await C.W.connect(MINT, { remember: true });
  ok((await A.W.primeLocks()) > 0, 'A derived lock keys');
  ok((await C.W.primeLocks()) > 0, 'C derived lock keys');
  await A.W.claim((await A.W.invoice(500, '')).hash);
  await C.W.claim((await C.W.invoice(200, '')).hash);

  // ecash locked to A, as a payer would have handed it over
  const askA = A.W.decodeRequest(A.W.paymentRequest(31, { purpose: 'receive' })) || {};
  ok(!!askA.lockTo, 'A asked for a lock');
  const lockedToA = await A.W.sendToken(31, { unit: 'sat', lockTo: askA.lockTo });
  ok(A.W.tokenInfo(lockedToA.token).proofs.every((pr) => pr.secret.charAt(0) === '['),
    'and the ecash really is locked');

  // ---- A signs it and hands it on -----------------------------------------
  const fwd = await A.W.forwardLocked(lockedToA.token);
  ok(fwd.sats === 31, 'A hands on the whole amount', String(fwd.sats));
  const bits = A.W.tokenInfo(fwd.token);
  ok(bits.proofs.every((pr) => !!pr.witness), 'every proof carries a witness');
  ok(bits.proofs.every((pr) => pr.secret.charAt(0) === '['),
    'and is still locked to A — the lock is not removed, it is signed for');

  // ---- and C, a different seed, redeems it at the mint ---------------------
  const before = await C.W.balanceSats();
  await C.W.receiveToken(fwd.token, { hash: 'forwarded-1' });
  const after = await C.W.balanceSats();
  ok(after === before + 31, 'C redeems it although the lock names A',
    before + ' -> ' + after);

  // ---- and it cannot be handed on twice -----------------------------------
  let twice = '';
  try { await A.W.forwardLocked(lockedToA.token); } catch (e) { twice = e.message; }
  ok(/already been handed on/i.test(twice),
    'the same ecash cannot be signed away a second time', twice);

  // ---- what it refuses ----------------------------------------------------
  const plain = await A.W.sendToken(7, { unit: 'sat' });
  let bare = '';
  try { await A.W.forwardLocked(plain.token); } catch (e) { bare = e.message; }
  ok(/not locked/i.test(bare), 'unlocked ecash is not something to sign', bare);

  const askC = C.W.decodeRequest(C.W.paymentRequest(11, { purpose: 'receive' })) || {};
  ok(!!askC.lockTo, 'C asked for a lock too');
  const lockedToC = await C.W.sendToken(11, { unit: 'sat', lockTo: askC.lockTo });
  let theirs = '';
  try { await A.W.forwardLocked(lockedToC.token); } catch (e) { theirs = e.message; }
  ok(/locked to someone else/i.test(theirs),
    "A cannot sign away ecash locked to C's key", theirs);

  // ---- and an unsigned locked token is still refused, as it always was ----
  let stranger = '';
  try { await A.W.receiveToken(lockedToC.token, { hash: 'not-mine' }); } catch (e) { stranger = e.message; }
  ok(/locked to someone else/i.test(stranger),
    'taking a stranger’s unsigned locked ecash is refused exactly as before', stranger);

  /* ---- a witness that does not verify is not a witness --------------------
   *
   * "Has a signature" and "has a signature that works" are different claims, and
   * only one is worth anything. A forwarded token with its signature altered must
   * be refused — otherwise anybody could put any bytes in a witness and spend
   * somebody else's lock. */
  const forged = (() => {
    const t = A.W.tokenInfo(fwd.token);
    const copy = t.proofs.map((pr) => Object.assign({}, pr));
    const sigs = JSON.parse(copy[0].witness).signatures;
    const first = String(sigs[0]);
    // one hex digit turned: the shape survives, the signature does not
    sigs[0] = (first[0] === 'a' ? 'b' : 'a') + first.slice(1);
    copy[0].witness = JSON.stringify({ signatures: sigs });
    return A.window.CashuTS.getEncodedToken({
      mint: String(t.mint || '').replace(/\/+$/, ''), proofs: copy, unit: 'sat',
    });
  })();
  const markC = C.seen.length;
  let bogus = '';
  try { await C.W.receiveToken(forged, { hash: 'forged' }); } catch (e) { bogus = e.message; }
  ok(!!bogus, 'a witness that does not verify is refused', bogus || 'ACCEPTED');
  /* And refused here, before the mint is troubled with it. The mint would refuse
   * it too, so this is what says the phone checked rather than guessed. */
  const swapsTried = C.seen.slice(markC).filter((u) => /swap/.test(u)).length;
  ok(swapsTried === 0 && C.seen.length > 0, 'and refused on this phone, without asking the mint',
    swapsTried + ' swap(s) of ' + C.seen.length + ' request(s) seen');

  /* ---- what an offline payer actually sends: signed locked ecash AND plain
   *      pieces, in one token ------------------------------------------------
   *
   * This is not an edge case, it is the ordinary output of a payer with no
   * route: `exactWithLocked` makes the amount out of whole rows that arrived
   * locked to it earlier, signed on the way out, plus loose pieces from its own
   * pile. Both of the receiver's tests used to demand that EVERY proof in the
   * token be locked, so a token holding one of each failed both and was refused
   * whole — the payer answered 422 having already handed over ecash only it
   * could unlock, the receiver unable to claim it. Thousands of sats stuck at
   * both ends.
   */
  const askA2 = A.W.decodeRequest(A.W.paymentRequest(13, { purpose: 'receive' })) || {};
  const lockedToA2 = await A.W.sendToken(13, { unit: 'sat', lockTo: askA2.lockTo });
  const fwd2 = await A.W.forwardLocked(lockedToA2.token);
  const loose = await A.W.sendToken(9, { unit: 'sat' });
  const mixed = (() => {
    const a = A.W.tokenInfo(fwd2.token);
    const b = A.W.tokenInfo(loose.token);
    return A.window.CashuTS.getEncodedToken({
      mint: String(a.mint || '').replace(/\/+$/, ''),
      proofs: a.proofs.concat(b.proofs), unit: 'sat',
    });
  })();
  {
    const info = A.W.tokenInfo(mixed);
    const lockedCount = info.proofs.filter((pr) => pr.secret.charAt(0) === '[').length;
    ok(lockedCount > 0 && lockedCount < info.proofs.length,
      'the token really does hold both kinds',
      lockedCount + ' locked of ' + info.proofs.length);
  }
  const was = await C.W.balanceSats();
  const mixedTook = await C.W.receiveToken(mixed, { hash: 'mixed-1' })
    .then(() => '', (e) => e.message);
  ok(!mixedTook, 'a token of signed locked ecash and plain pieces is claimed, not refused',
    mixedTook || 'taken');
  ok((await C.W.balanceSats()) === was + 22, 'and all 22 sats of it land',
    was + ' -> ' + (await C.W.balanceSats()));

  /* And the widening stops there: one proof locked to a stranger with no
   * witness still poisons the token, however many plain ones sit beside it. */
  const badMix = (() => {
    const a = A.W.tokenInfo(lockedToC.token);      // locked to C, unsigned, not ours
    const b = A.W.tokenInfo(loose.token);
    return A.window.CashuTS.getEncodedToken({
      mint: String(a.mint || '').replace(/\/+$/, ''),
      proofs: a.proofs.concat(b.proofs), unit: 'sat',
    });
  })();
  let poisoned = '';
  try { await A.W.receiveToken(badMix, { hash: 'bad-mix' }); } catch (e) { poisoned = e.message; }
  ok(/locked to someone else/i.test(poisoned),
    'but one unsigned stranger lock still refuses the whole token', poisoned || 'ACCEPTED');

  // ---- a wallet still claims its own locked ecash normally ----------------
  const mine = await C.W.receiveToken(lockedToC.token, { hash: 'c-own' }).then(() => 'ok', (e) => e.message);
  ok(mine === 'ok', 'and a wallet still claims ecash locked to itself', String(mine));

  // ---- paid while offline, and paying out of it while still offline -------
  /* A newly installed phone was paid thousands of sats with no route, tried to
   * pay some of them, and was told it held nothing: the send looked only at
   * the pile, and everything it had was waiting to be swapped in. */
  {
    const E = phoneAt('letter advice cage absurd amount doctor acoustic avoid letter advice cage above');
    await E.W.connect(MINT, { remember: true });
    ok((await E.W.primeLocks()) > 0, 'E derived lock keys');
    const askE = E.W.decodeRequest(E.W.paymentRequest(40, { purpose: 'receive' })) || {};
    const forE = await A.W.sendToken(40, { unit: 'sat', lockTo: askE.lockTo });
    const plain = await A.W.sendToken(16, { unit: 'sat' });
    E.W._privacy({ tor: 'connecting', progress: 10, everUp: true, network: 'none' });
    const kept = await E.W.receiveToken(forE.token).then((r) => r, (e) => e);
    ok(kept && kept.kept === true, 'E, offline, keeps ecash locked to it', kept && kept.message);

    const none = await E.W.sendToken(500, { unit: 'sat', cover: true, overpayOk: true }).then(() => 'made', (e) => e.message);
    ok(/you hold 40/.test(none), 'what it holds counts the payment that is waiting', none);

    const ask = await E.W.sendToken(10, { unit: 'sat', cover: true }).then(() => null, (e) => e);
    /* 40 arrived as a 32 and an 8. It used to be handed on whole, 30 over; the
     * 32 alone covers 10, so that is what goes and the 8 stays. */
    ok(ask && ask.foxyNeedsOverpay && ask.foxyNeedsOverpay.pay === 32 && ask.foxyNeedsOverpay.over === 22,
      'with no exact change it offers the least of the waiting payment that covers it, and says what comes back',
      ask ? JSON.stringify(ask.foxyNeedsOverpay || ask.message) : 'MADE');
    const paid = await E.W.sendToken(10, { unit: 'sat', cover: true, overpayOk: true }).then((r) => r, (e) => e);
    const outE = paid && paid.token ? E.W.tokenInfo(paid.token).proofs : [];
    ok(outE.reduce((n, pr) => n + Number(pr.amount), 0) === 32 && paid.over === 22,
      'and pays with that piece, 22 over', paid && paid.message ? paid.message : 'over ' + (paid && paid.over));
    ok((await E.W.balanceSats()) === 8, 'the other piece of that payment is still E’s', String(await E.W.balanceSats()));
    const took = await A.W.receiveToken(paid.token, { hash: 'from-e' }).then(() => 'ok', (e) => e.message);
    ok(took === 'ok', 'and the phone it was handed to can claim it', took);

    // ---- plain ecash scanned with no route: the person is asked ----------
    const refused = await E.W.receiveToken(plain.token).then(() => 'TAKEN', (e) => e.message);
    ok(/offline, so it can only take ecash locked to it/.test(refused),
      'with no card to ask, plain ecash is refused offline as it always was', refused);
    let asked = null;
    E.W.onOfflineOffer((info) => { asked = info; return Promise.resolve(false); });
    const no = await E.W.receiveToken(plain.token).then(() => 'TAKEN', (e) => e.message);
    ok(asked && asked.scanned === true && asked.sats === 16 && /not taken/.test(no),
      'with one, the person is asked, and REJECT takes nothing', no);
    E.W.onOfflineOffer(() => Promise.resolve(true));
    const yes = await E.W.receiveToken(plain.token).then((r) => r, (e) => e);
    ok(yes && yes.kept === true && yes.trusted === true, 'CONTINUE keeps it, marked as taken on trust',
      yes && yes.message);
    const twice = await E.W.receiveToken(plain.token).then(() => 'TAKEN', (e) => e.message);
    ok(/already taken/.test(twice), 'and the same ecash cannot be taken twice', twice);
  }

  // ---- a locked piece in the pile never leaves in a plain token -----------
  /* MAKE ECASH on a phone made a token that phone itself then refused as
   * locked to a key it did not hold: a locked piece
   * was in the pile, and a send picks from the pile without looking. */
  {
    const askC = C.W.decodeRequest(C.W.paymentRequest(8, { purpose: 'receive' })) || {};
    const forC = await A.W.sendToken(8, { unit: 'sat', lockTo: askC.lockTo });
    const stray = A.W.tokenInfo(forC.token).proofs;
    const key = 'foxy.cashu.proofs.' + MINT;
    const pile = JSON.parse(A.storage.getItem(key) || '[]');
    const before = pile.reduce((n, p) => n + Number(p.amount), 0);
    A.storage.setItem(key, JSON.stringify(pile.concat(stray)));
    const made = await A.W.sendToken(before, { unit: 'sat' }).then((r) => r, (e) => e);
    const out = made && made.token ? A.W.tokenInfo(made.token).proofs : [];
    ok(out.length > 0 && out.every((pr) => pr.secret.charAt(0) !== '['),
      'a token made from the pile holds no locked piece', made && made.message ? made.message : out.length + ' piece(s)');
    const after = JSON.parse(A.storage.getItem(key) || '[]');
    ok(stray.every((pr) => after.some((q) => q.secret === pr.secret)),
      'and the locked piece is still where it was, untouched');
  }

  /* Signed, and nothing written (`defer`). A payment out of several locked
   * payments signs them one after another, and each used to be struck off as
   * it was signed, before the token that carries it existed: killed, or
   * refused the second key, the pieces signed first were in no pile, no
   * waiting payment and no token (offline-cross-scenarios.js `fwd-kill`,
   * `fwd-refuse`). */
  {
    await A.W.claim((await A.W.invoice(100, '')).hash);
    const askD = A.W.decodeRequest(A.W.paymentRequest(17, { purpose: 'receive' })) || {};
    const lockedD = await A.W.sendToken(17, { unit: 'sat', lockTo: askD.lockTo });
    const handed0 = A.storage.getItem('foxy.req.handedon');
    const held = await A.W.forwardLocked(lockedD.token, { defer: true });
    ok(held.sats === 17 && Array.isArray(held.signed) && held.signed.every((pr) => !!pr.witness),
      'asked to defer, it signs and hands back what it signed', String(held.sats));
    ok(A.storage.getItem('foxy.req.handedon') === handed0, 'and writes nothing down: the pieces are not struck off');
    const now = await A.W.forwardLocked(lockedD.token).then((r) => r, (e) => ({ why: e.message }));
    ok(now.sats === 17, 'so the same ecash can still be handed on, once, when the caller means it', JSON.stringify(now).slice(0, 80));
  }

  console.log('\n' + (failed ? failed + ' forward-locked check(s) failed'
    : 'all forward-locked checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
