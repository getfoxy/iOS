/* p2pk-round-trip.js — ecash locked to a key, made and then claimed.
 *
 * The guard tests in run.js say which locked tokens are refused. This one runs
 * the other half: a payment request that asks for a lock, a token made against
 * it, and that token claimed with the key the request kept. Real cashu-ts and
 * the harness's mint, so the secrets, the swap and the token are the real
 * shapes rather than stubs.
 *
 * What it does NOT prove: that a mint honours the lock. The harness's mint
 * checks no signature on an input (tests/harness.js), which is fine — whether
 * a signature verifies is the mint's business and cashu-ts's, not Foxy's. What
 * is Foxy's is that the lock goes on, travels in the request, comes back, and
 * is opened with the right key and only that key.
 *
 * The key is not a random one. It is derived from the seed at
 * NUT-13's P2PK path, m/129373'/10'/0'/0'/{index}, by the phone — because a
 * random key is a key the twelve words cannot rebuild, and ecash locked to one,
 * on a phone that is lost, is money nobody can ever move. So this also runs the
 * case that whole change exists for: a token in hand, no record at all of the
 * request it answered, and the twelve words opening it anyway.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, p2pkParent, p2pkAt } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, what) => {
  console.log((good ? 'ok   ' : 'FAIL ') + what);
  if (!good) failed += 1;
};

/* `mint` and `phone` let a second page join the first one's mint and words,
 * which is what a restore on another device looks like from here. */
function page(opts) {
  const o = opts || {};
  const phone = o.phone || nativePhone({ words: PHONE_WORDS });
  const refuse = { keys: null };
  let mint = o.mint || null;
  const answer = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return answer(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return answer(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => answer(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, { p2pk: true });
      // a store that refuses one key, so a single write can be made to fail
      const real = w.Storage.prototype.setItem;
      w.Storage.prototype.setItem = function (k, v) {
        if (refuse.keys && refuse.keys.test(String(k))) throw new Error('QuotaExceededError');
        return real.call(this, k, v);
      };
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return Object.assign(ctx, { refuse, phone, mint: () => mint });
}

async function run() {
  const ctx = page();
  const W = ctx.W;
  await W.connect(MINT, { remember: true });
  /* The keys are the phone's now, and `paymentRequest` is synchronous, so it
   * can only take one the phone derived earlier. The app does this in
   * `railRequest`, beside opening the onion address; a test does it here. */
  ok((await W.primeLocks()) > 0, 'the phone derived lock keys for the requests to come');

  /* Sats to work with. The harness's mint pays its own quotes the moment they
   * are made, so claiming one is the whole of funding. */
  const inv = await W.invoice(400, '');
  await W.claim(inv.hash);
  const bal = await W.balanceSats();
  ok(bal >= 400, "the wallet has sats to send (" + bal + ")");

  // ---- the request carries a lock -----------------------------------------
  const req = W.paymentRequest(21, { purpose: 'receive' });
  ok(!!req && /^creq/.test(req), 'a payment request was made');
  const read = W.decodeRequest(req);
  ok(!!read, 'and reads back');
  ok(/^0[23][0-9a-f]{64}$/i.test(read.lockTo || ''),
    'it names a key to lock the ecash to :: ' + String(read.lockTo).slice(0, 12) + '…');

  // a second request gets its own key: one key for every payment, never shared
  const other = W.decodeRequest(W.paymentRequest(21, { purpose: 'receive' }));
  ok(other.lockTo && other.lockTo !== read.lockTo, 'a second request gets its own key');

  // ---- and the key is the seed's, at NUT-13's path -------------------------
  {
    /* The change this whole file's second half exists for. A random key is a
     * key the twelve words cannot rebuild; this one is
     * m/129373'/10'/0'/0'/{index}, derived by the phone, and the row keeps the
     * index rather than the key.
     *
     * Compared against a derivation written separately in tests/harness.js from
     * node's own crypto — not the phone mock's copy of the answer, and not the
     * Swift's. Two implementations agreeing is worth something; one agreeing
     * with itself is not. */
    const rows = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}');
    const row = rows[read.id] || {};
    ok(Number.isInteger(row.i) && row.i >= 0, 'the row keeps the index the key was derived at (' + row.i + ')');
    ok(!('key' in row), 'and no private key is written into the page at all');
    ok(row.pub === read.lockTo, 'the public key in the row is the one the request carries');
    const own = p2pkAt(p2pkParent(ctx.window.FoxyBip39.mnemonicToSeedSync(PHONE_WORDS)), row.i);
    ok(own.pub === read.lockTo,
      'and it is what m/129373\'/10\'/0\'/0\'/' + row.i + ' gives, derived here from the words');
    // hardened would be a wallet perfectly consistent with itself and with nothing else
    const hardened = p2pkAt(p2pkParent(ctx.window.FoxyBip39.mnemonicToSeedSync(PHONE_WORDS)), row.i + 0x80000000);
    ok(hardened.pub !== read.lockTo, 'the last level is a normal BIP-32 child, not a hardened one');
    const second = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}')[other.id] || {};
    ok(second.i === row.i + 1, 'the index counts up, one key per request (' + row.i + ' -> ' + second.i + ')');
  }

  // ---- a token made against it is locked ----------------------------------
  const made = await W.sendToken(21, { unit: 'sat', lockTo: read.lockTo });
  const info = W.tokenInfo(made.token);
  ok(!!info && info.proofs.length > 0, 'a token was made');
  const locks = info.proofs.map((p) => {
    try { const j = JSON.parse(p.secret); return Array.isArray(j) && j[0] === 'P2PK' ? j[1].data : ''; }
    catch (e) { return ''; }
  });
  ok(locks.every((l) => l === read.lockTo),
    'every proof in it is locked to that key (' + locks.length + ' proof(s))');

  // ---- and only the right key opens it ------------------------------------
  let refused = null;
  try { await W.receiveToken(made.token, { unlockWith: 'ab'.repeat(32) }); } catch (e) { refused = e; }
  ok(refused && /locked to/.test(refused.message), 'named the wrong key, it is refused');

  /* A lock nobody here asked for stays refused — that is the whole guard. */
  const strangers = W.tokenInfo(made.token);
  const alien = {
    mint: strangers.mint, unit: 'sat',
    // a nonce of its own for each: one secret on every proof is one proof named many times, refused for that
    proofs: strangers.proofs.map((pr, i) => ({
      ...pr, secret: JSON.stringify(['P2PK', { nonce: 'ee' + i, data: '02' + 'e'.repeat(64), tags: [] }]) })),
  };
  refused = null;
  try { await W.receiveToken(ctx.window.CashuTS.getEncodedToken(alien)); } catch (e) { refused = e; }
  ok(refused && /locked to/.test(refused.message), 'a lock this phone never asked for is refused');

  /* The private half of this request's lock, derived here from the words rather
   * than read out of the page — because the page does not hold it any more.
   * Used below as a key that really does open the token, which is itself a check
   * that this file's derivation and the phone's are the same derivation. */
  const priv = (() => {
    const row = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}')[read.id] || {};
    return p2pkAt(p2pkParent(ctx.window.FoxyBip39.mnemonicToSeedSync(PHONE_WORDS)), row.i).priv;
  })();
  ok(/^[0-9a-f]{64}$/.test(priv || ''), 'the words give the private half of that request’s lock');

  /* Named or not, this phone can open its own lock. Finding it by the lock
   * rather than by request id is what lets a payment that arrived and was
   * never claimed be pasted in later and still be money. */
  const asked = (action) => ctx.phone.asks.filter((m) => m.action === action).length;
  const keysAsked = asked('p2pkKey'), walksAsked = asked('p2pkPubkeys');
  const got = await W.receiveToken(made.token);
  ok(!!got && got.sats > 0,
    'and with no key named, the phone finds its own and claims it (' + (got && got.sats) + ' sats)');
  /* By the row, not by walking the seed. The row keeps the index, so the phone
   * is asked for that one key. The walk is the slow road — up to sixty-seven
   * round trips on a phone — and it is also what hides a row lookup that has
   * stopped working: the claim still succeeds, only a minute later, and
   * nothing here would say so. */
  ok(asked('p2pkKey') === keysAsked + 1 && asked('p2pkPubkeys') === walksAsked,
    'the row named the index: one key asked of the phone, and the seed not walked ('
    + (asked('p2pkKey') - keysAsked) + ' key, ' + (asked('p2pkPubkeys') - walksAsked) + ' walk batches)');

  // ---- a lock that is ours and somebody else's too --------------------------
  {
    /* `lockedTo` read the secret's `data` field and stopped there, so every
     * shape below — each of which lets the payer, or anyone, spend the same
     * proof — was accepted as locked to this phone alone.
     * NUT-11 puts the rest in the tags, and cashu-ts works it out. */
    const theirs = '03' + 'cd'.repeat(32);
    const past = String(Math.floor(Date.now() / 1000) - 3600);
    const soon = String(Math.floor(Date.now() / 1000) + 3600);
    const bad = {
      'a key of ours beside the payer\u2019s': [['pubkeys', theirs]],
      'a locktime already past, and no refund': [['locktime', past]],
      'a locktime already past, with a refund to them': [['locktime', past], ['refund', theirs]],
      'two signatures wanted, and we have one': [['n_sigs', '2'], ['pubkeys', theirs]],
      /* These two name this phone and nobody else, so the key test passes —
       * and neither can this wallet ever spend. NUT-11 says a request for more
       * signatures than there are keys is malformed; SIG_ALL wants the whole
       * transaction signed, which Foxy has no path for. Accepted, they would
       * be counted as settled and stuck for ever. */
      'two signatures wanted from our one key': [['n_sigs', '2']],
      'the whole transaction to be signed': [['sigflag', 'SIG_ALL']],
      /* A locktime in the *future* is still active, so the key test passes and
       * the delayed swap was held on the strength of it — and the payer takes
       * the money back when it expires. Foxy asks for no locktime
       * and has no use for one. */
      'a locktime still to come, and no refund': [['locktime', soon]],
      'a locktime still to come, with a refund to them': [['locktime', soon], ['refund', theirs]],
    };
    /* An HTLC naming this phone is not a P2PK lock, and needs a preimage this
     * wallet has not got. `spendableBy` looked only at the leading bracket. */
    bad['a hash lock, whoever it names'] = null;
    for (const [what, tags] of Object.entries(bad)) {
      const info = W.tokenInfo(made.token);
      const kind = tags === null ? 'HTLC' : 'P2PK';
      const body = tags === null
        ? { nonce: 'aa', data: 'ab'.repeat(32), tags: [['pubkeys', read.lockTo]] }
        : { nonce: 'aa', data: read.lockTo, tags: tags };
      const token = ctx.window.CashuTS.getEncodedToken({
        mint: info.mint, unit: 'sat',
        proofs: info.proofs.map((pr, i) => ({ ...pr, secret: JSON.stringify([kind, Object.assign({}, body, { nonce: 'aa' + i })]) })),
      });
      let no = null;
      try { await W.receiveToken(token, { unlockWith: priv }); } catch (e) { no = e; }
      ok(no && /locked to|taken back by the sender|time lock on this ecash has passed/.test(no.message), 'refused: ' + what);
    }
  }

  /* ---- a locktime far enough out is fine where the swap follows at once ----
   *
   * cashu.me and Nutshell put a refund locktime on a plain send, and Foxy
   * refused every such token as somebody else's (audit finding). Online
   * the swap is seconds and the lock goes with it, so a locktime a day or
   * more away is taken. Offline it is refused, in words that say when. */
  {
    const theirs = '03' + 'cd'.repeat(32);
    const far = Math.floor(Date.now() / 1000) + 3 * 86400;
    const req = W.decodeRequest(W.paymentRequest(23, { purpose: 'receive' })) || {};
    const timed = await W.sendToken(23, { unit: 'sat', lockTo: req.lockTo, lockUntil: far, refundTo: theirs });
    const bits = W.tokenInfo(timed.token);
    ok(bits.proofs.every((pr) => /locktime/.test(pr.secret) && /refund/.test(pr.secret)),
      'a token with a refund locktime three days out was made');
    const was = await W.balanceSats();
    const got = await W.receiveToken(timed.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(got && got.sats === 23 && !got.kept, 'online, it is swapped in at once', JSON.stringify(got));
    ok((await W.balanceSats()) === was + 23, 'and counted after the swap');

    const req2 = W.decodeRequest(W.paymentRequest(29, { purpose: 'receive' })) || {};
    const timed2 = await W.sendToken(29, { unit: 'sat', lockTo: req2.lockTo, lockUntil: far, refundTo: theirs });
    W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    const before = await W.balanceSats();
    const off = await W.receiveToken(timed2.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(off && !off.kept && /taken back by the sender/.test(String(off.why)) && /offline/.test(String(off.why)),
      'offline, it is refused and the words say the sender can take it back', JSON.stringify(off));
    ok((await W.balanceSats()) === before, 'and nothing was counted');
    W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    const late = await W.receiveToken(timed2.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(late && late.sats === 29, 'and taken once online', JSON.stringify(late));
  }

  // ---- locked ecash is swapped at once too ---------------------------------
  {
    /* Nothing waits. A payment locked to this phone used to be held back
     * between thirty seconds and three minutes before its swap, so the mint
     * would not see it land right after the payer's. The delay was removed:
     * every way it went wrong cost money or looked like it had,
     * and one correlation at the mint did not pay for that.
     *
     * The test turns no clock. It flushes the microtask queue and nothing
     * else, so a swap that had gone back to waiting on a timer would leave the
     * token sitting on the unclaimed list and fail here. */
    const request = W.paymentRequest(31, { purpose: 'receive' });
    const read = W.decodeRequest(request) || {};
    ok(!!read.lockTo, 'a request asked for a lock');
    const paid = await W.sendToken(31, { unit: 'sat', lockTo: read.lockTo });
    const bits = W.tokenInfo(paid.token);
    ok(bits.proofs.every((pr) => pr.secret.charAt(0) === '['),
      'and the payment that answered it really is locked');
    const before = await W.balanceSats();

    W._requestPaid(JSON.stringify({
      id: read.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
      proofs: bits.proofs.map((pr) => ({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C })),
    }), 'inbox-locked-now');
    for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0));

    ok(ctx.storage.getItem('foxy.req.unclaimed') === '{}',
      'locked ecash is swapped in without waiting, not left on a timer');
    ok(!JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}')[read.id],
      'and the key that opened it is dropped with it');
    ok((await W.balanceSats()) === before + 31,
      'the sats are in the balance (' + (await W.balanceSats()) + ' vs ' + (before + 31) + ')');

    /* Spendable, not merely counted. Before the removal this was the whole of
     * the risk: the balance said the money was there and the proofs were not
     * in the pile, so a send straight afterwards was refused. */
    const spend = await W.sendToken(before + 31, { unit: 'sat' });
    ok(!!spend && spend.sats === before + 31,
      'and every one of them can be spent at once (' + (spend && spend.sats) + ' sats)');
    await W.receiveToken(spend.token);
  }

  // ---- a lock asked for, and a payment that carries none ---------------------
  {
    /* Unlocked proofs are a race: anyone holding a copy can spend them, so
     * nothing is said until the mint has taken them. The branch was chosen by
     * *did we ask for a lock*, so a payer answering with ordinary proofs got a
     * settled history entry and the sats in the balance while the proofs were
     * still theirs to spend back. It reads the proofs now. */
    const request = W.paymentRequest(23, { purpose: 'receive' });
    const id = (W.decodeRequest(request) || {}).id;
    ok(!!(W.decodeRequest(request) || {}).lockTo, 'the request asked for a lock');
    const plain = await W.sendToken(23, { unit: 'sat' });          // no lockTo
    const bits = W.tokenInfo(plain.token);
    const before = await W.balanceSats();

    W._requestPaid(JSON.stringify({
      id: id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
      proofs: bits.proofs.map((pr) => ({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C })),
    }), 'inbox-unlocked');
    for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0));

    const waiting = JSON.parse(ctx.storage.getItem('foxy.req.unclaimed') || '{}');
    ok(!waiting[id], 'unlocked ecash is taken at the mint before anything is said');
    ok((await W.balanceSats()) === before + 23,
      'and it is in the balance because it was taken, not because it was counted');
  }

  // ---- ecash that arrived and was never claimed ----------------------------
  {
    /* The failure that lost 25 sats: a payment delivered, held only in a
     * variable, and then nothing. Written down before it is touched, it is
     * still money on the next connect. */
    const unclaimedKey = 'foxy.req.unclaimed';
    const spare = await W.sendToken(13, { unit: 'sat' });
    const store = {};
    store['req-late'] = { token: spare.token, at: Date.now() };
    ctx.storage.setItem(unclaimedKey, JSON.stringify(store));
    const before = await W.balanceSats();
    const took = await W.claimUnclaimed();
    ok(took === 13, 'a payment left unclaimed is claimed on the next connect (' + took + ' sats)');
    ok((await W.balanceSats()) === before + 13, 'and the sats are in the balance');
    ok(ctx.storage.getItem(unclaimedKey) === '{}', 'and it is not left to be claimed twice');
  }

  // ---- arrived and waiting counts as held ----------------------------------
  {
    /* A swap can fail and leave the token on the unclaimed list, so what is
     * waiting has to be in the balance — otherwise somebody who was just paid
     * looks at their phone and sees nothing. */
    const key = 'foxy.req.unclaimed';
    const spare = await W.sendToken(9, { unit: 'sat' });
    const before = await W.balanceSats();
    ctx.storage.setItem(key, JSON.stringify({ 'req-waiting': { token: spare.token, at: Date.now(), sats: 9 } }));
    ok((await W.balanceSats()) === before + 9,
      'ecash that has arrived but is not swapped yet is counted as held');
    await W.claimUnclaimed();
    ok((await W.balanceSats()) === before + 9,
      'and the total does not move when it is finally swapped in');
    ok(ctx.storage.getItem(key) === '{}', 'and it stops being counted twice');
  }

  // ---- in history the moment it lands --------------------------------------
  {
    /* What the receiving phone shows all hangs off the history entry: the
     * confirmation screen is raised by the history pass finding a new one,
     * and the list is the log. Written only by the swap, both waited on the
     * mint: the payer's phone said done and the receiver's went to home with
     * nothing on it.
     *
     * So the arrival writes it, and the swap finishes that entry rather than
     * adding a second one for the same money. */
    const request = W.paymentRequest(19, { purpose: 'receive' });
    const id = (W.decodeRequest(request) || {}).id;
    ok(!!id, 'a request to be paid was made');
    const paid = await W.sendToken(19, { unit: 'sat', lockTo: W.decodeRequest(request).lockTo });
    const bits = W.tokenInfo(paid.token);
    const mine = (list) => list.filter((t) => t.hash === 'req-' + id);

    W._requestPaid(JSON.stringify({
      id: id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
      proofs: bits.proofs.map((pr) => ({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C })),
    }), 'inbox-history');
    for (let i = 0; i < 200 && !mine(await W.transactions(50)).length; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const atOnce = mine(await W.transactions(50));
    ok(atOnce.length === 1, 'the money is in history the moment it arrives');
    ok(atOnce[0] && atOnce[0].dir === 'in' && atOnce[0].sats === 19 && atOnce[0].settled === true,
      'as a settled receive for what arrived (' + (atOnce[0] && atOnce[0].sats) + ' sats)');

    // and the swap, whenever it happens, finishes that entry
    await W.claimUnclaimed();
    const after = mine(await W.transactions(50));
    ok(after.length === 1, 'and the swap finishes it rather than writing it twice');
    ok(after[0].at === atOnce[0].at, 'keeping the time the money actually arrived');
  }

  // ---- spending right after being paid ------------------------------------
  {
    /* Paid, the swap failed, then spending. The balance counts what is
     * waiting, so the proofs have to be reachable before a send is made. The
     * page claims on its way to any screen money can leave from (syncClaim);
     * this is the wallet half of it — once claimed, the sats really are
     * spendable. */
    const key = 'foxy.req.unclaimed';
    const spare = await W.sendToken(40, { unit: 'sat' });
    const before = await W.balanceSats();
    ctx.storage.setItem(key, JSON.stringify({ 'req-soon': { token: spare.token, at: Date.now(), sats: 40 } }));
    ok((await W.balanceSats()) === before + 40, 'the sats that arrived are counted');
    await W.claimUnclaimed();
    const spend = await W.sendToken(before + 20, { unit: 'sat' });
    ok(!!spend && spend.sats === before + 20,
      'and once claimed they can be spent straight away (' + (spend && spend.sats) + ' sats)');
    ok(ctx.storage.getItem(key) === '{}', 'the waiting list is clear afterwards');
  }

  // ---- a key that cannot be kept means no lock -----------------------------
  {
    /* The lock goes into the request only once its private half is on disk.
     * The write used to come after, and swallowed its refusal, so a full store
     * sent out a request naming a key this phone could not open — and the
     * payer's money is destroyed by paying it, because their wallet swaps into
     * proofs locked to that key before it delivers anything. */
    ctx.refuse.keys = /^foxy\.req\.lockkeys$/;
    const text = W.paymentRequest(19, { purpose: 'receive' });
    ctx.refuse.keys = null;
    ok(!!text, 'a request is still made when the key cannot be kept');
    const read2 = W.decodeRequest(text) || {};
    ok(!read2.lockTo, 'and it names no lock :: ' + String(read2.lockTo || '(none)'));
    const kept = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}');
    ok(!kept[read2.id], 'and no key was left behind for it');

    // and it is still a request that can be paid, the way every one was before
    const paid = await W.sendToken(19, { unit: 'sat' });
    const bits2 = W.tokenInfo(paid.token);
    const was2 = await W.balanceSats();
    W._requestPaid(JSON.stringify({
      id: read2.id, mint: String(bits2.mint || '').replace(/\/+$/, ''), unit: 'sat',
      proofs: bits2.proofs.map((pr) => ({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C })),
    }), 'inbox-unlocked-req');
    for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0));
    ok((await W.balanceSats()) === was2 + 19,
      'and money paid to it still arrives (' + (await W.balanceSats()) + ' vs ' + (was2 + 19) + ')');
  }

  // ---- a mint that cannot do it gets no lock -------------------------------
  {
    const plainCtx = (() => {
      const phone = nativePhone({ words: PHONE_WORDS });
      let m = null;
      const answer = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
      return loadReal({
        bridge: (w, msg) => {
          if (msg.action === 'mintRequest') return answer(w, msg.id, m.handle(msg));
          const got = phone.answer(w, msg);
          if (!got) return answer(w, msg.id, null, 'not in this test');
          return Promise.resolve(got).then((r) => answer(w, msg.id, r[0], r[1]));
        },
        before: (w) => { phone.attach(w); m = fakeMint(w); },   // no p2pk
      });
    })();
    await plainCtx.W.connect(MINT, { remember: true });
    // keys primed, so the absence of a lock is the mint's doing and not an empty pool
    ok((await plainCtx.W.primeLocks()) > 0, 'with keys ready to use');
    const noLock = plainCtx.W.decodeRequest(plainCtx.W.paymentRequest(21, { purpose: 'receive' }));
    ok(!noLock.lockTo,
      'a mint that does not do NUT-11 gets a request with no lock on it');
    ok(JSON.parse(plainCtx.storage.getItem('foxy.req.lockpool') || '[]').length > 0,
      'and no index is spent on it');
  }

  // ---- an unlocked request still works ------------------------------------
  await W.primeLocks();
  const plainReq = W.decodeRequest(W.paymentRequest(11, { purpose: 'receive', lock: false }));
  ok(!plainReq.lockTo, 'a request made without a lock names no key');
  const plain = await W.sendToken(11, { unit: 'sat' });
  const plainInfo = W.tokenInfo(plain.token);
  ok(plainInfo.proofs.every((p) => p.secret.charAt(0) !== '['),
    'and a token made without one carries no spending condition');
  const back = await W.receiveToken(plain.token);
  ok(!!back && back.sats > 0, 'which is claimed as it always was');

  // ---- no primed key means no lock, and never a random one -----------------
  {
    /* An empty pool has to mean an unlocked request. The tempting thing is to
     * fall back to `createRandomSecretKey`, which is what this used to do all
     * the time — and a random key is the bug: nothing rebuilds it, so ecash
     * locked to one on a phone that is lost is gone for ever. Unlocked is the
     * honest answer, and it is money that still arrives. */
    ctx.storage.setItem('foxy.req.lockpool', '[]');
    const bare = W.decodeRequest(W.paymentRequest(7, { purpose: 'receive' })) || {};
    ok(!bare.lockTo, 'with nothing primed the request goes out unlocked :: ' + String(bare.lockTo || '(none)'));
    const row = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}')[bare.id];
    ok(!row, 'and no row is written for a lock that is not there');
    // the refill runs behind it, so the next one is locked again
    await W.primeLocks();
    const after = W.decodeRequest(W.paymentRequest(7, { purpose: 'receive' })) || {};
    ok(!!after.lockTo, 'and once the pool is filled again the next request is locked');
  }

  // ---- THE POINT: a token in hand, and no record of the request ------------
  {
    /* This is what the derived key is for, and nothing else is.
     *
     * Be clear about what a restore can and cannot do. It cannot FIND ecash
     * locked to one of these keys: those proofs were minted by the payer, from
     * the payer's blinding factors, so NUT-09's restore — which asks the mint
     * about blinded messages this seed can rebuild — never sees them. What it
     * can do is open a token already in hand. That is not a corner: it is the
     * payment that arrived while the app was being force-quit, the token a
     * delivery could not hand over, the copy someone kept.
     *
     * With a random key this was impossible. The key lived in one page's
     * localStorage and nowhere else; lose the phone and the ecash was money
     * nobody on earth could move, with no sign that it had ever existed. */
    const request = W.decodeRequest(W.paymentRequest(17, { purpose: 'receive' }));
    ok(!!request.lockTo, 'a request that asks for a lock');
    const paid = await W.sendToken(17, { unit: 'sat', lockTo: request.lockTo });

    // the row goes, as it would with the phone it was written on
    ctx.storage.removeItem('foxy.req.lockkeys');
    ctx.phone.relaunch();                      // a new app session: nothing served
    const opened = await W.receiveToken(paid.token);
    ok(!!opened && opened.sats === 17,
      'a token whose row is gone is still opened, by walking the seed for its lock ('
      + (opened && opened.sats) + ' sats)');
  }

  // ---- and on a phone that has only the twelve words ----------------------
  {
    /* The real shape of it: another device, the same words typed in, the same
     * mint, and a token that arrived on a phone that no longer exists. The
     * second page has its own storage — no rows, no pool — and the second
     * phone's own lock index starts at zero, so nothing but the words connects
     * the two.
     *
     * The index is pushed past 300 first, on purpose. Inside 300 of the new
     * phone's own index the key would be handed over without any walk at all,
     * and the walk is the half that has to work. */
    await W.claim((await W.invoice(200, '')).hash);
    // the pool holds low indices already; emptied, the next prime starts at 480
    ctx.storage.setItem('foxy.req.lockpool', '[]');
    ctx.phone.locks.set(PHONE_WORDS, 480);
    await W.primeLocks();
    const far = W.decodeRequest(W.paymentRequest(23, { purpose: 'receive' }));
    ok(!!far.lockTo, 'a request whose key is at an index past the window');
    const row = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}')[far.id] || {};
    ok(row.i >= 480, 'at index ' + row.i);
    const sent = await W.sendToken(23, { unit: 'sat', lockTo: far.lockTo });

    /* The other device starts where a restore from the words would leave
     * it: its counters past the ones this phone has used. Without that the
     * two phones hand the mint the same deterministic outputs, which is what
     * a restore walk exists to prevent, and a receive that now shapes a
     * hundred outputs at once (shapeOutputs) meets that sooner than the
     * counter-skip ladder can step past. */
    const freshPhone = nativePhone({ words: PHONE_WORDS });
    const usedCounters = ctx.phone.counters.get(PHONE_WORDS);
    if (usedCounters) freshPhone.counters.set(PHONE_WORDS, new Map(usedCounters));
    const fresh = page({ phone: freshPhone, mint: ctx.mint() });
    await fresh.W.connect(MINT, { remember: true });
    ok(fresh.phone.locks.get(PHONE_WORDS) === undefined, 'the restored phone has no lock index of its own');
    ok(fresh.storage.getItem('foxy.req.lockkeys') === null, 'and the page holds no rows at all');
    const taken = await fresh.W.receiveToken(sent.token);
    ok(!!taken && taken.sats === 23,
      'and the twelve words alone open it on the other device (' + (taken && taken.sats) + ' sats)');
  }

  // ---- a row whose seed has been replaced ---------------------------------
  {
    /* The one thing an index cannot say is which seed it belonged to. A row
     * left behind by a seed that has since been replaced still names a real
     * index, and the phone still derives a key there — a different key. Spent
     * with it, the swap fails at the mint with the proofs already gone.
     *
     * So the public key comes back with the private one and is compared with
     * the row's. There is no migration step for this and there cannot be one:
     * that is what the comparison is for. */
    const request = W.decodeRequest(W.paymentRequest(5, { purpose: 'receive' }));
    const paid = await W.sendToken(5, { unit: 'sat', lockTo: request.lockTo });
    const rows = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}');
    // the index kept, the public key of a seed that is no longer here
    rows[request.id] = { i: rows[request.id].i, pub: '02' + 'b'.repeat(64), at: Date.now() };
    ctx.storage.setItem('foxy.req.lockkeys', JSON.stringify(rows));
    let no = null;
    try { await W.receiveToken(paid.token, { hash: 'req-' + request.id }); } catch (e) { no = e; }
    ok(!no, 'a row whose public key does not match is ignored, and the lock is found by walking'
      + (no ? ' — ' + String(no.message).slice(0, 90) : ''));
  }

  // ---- and a row that names the lock, where this seed derives another key ---
  {
    /* The comparison itself. The row above was made not to match the token, so
     * the phone was never asked about it; this one names the token's own lock
     * and an index the phone answers for. What the phone derives there is a
     * key of this seed, which is not the key the ecash is locked to. Handed
     * back and used, it signs a swap no mint would take. So it opens nothing,
     * and the ecash is still there for the key that does. */
    const raw = ctx.window.CashuTS.createRandomSecretKey();
    const theirs = Buffer.from(ctx.window.CashuTS.getPubKeyFromPrivKey(raw)).toString('hex');
    const paid = await W.sendToken(5, { unit: 'sat', lockTo: theirs });
    const rows = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}');
    const index = Object.keys(rows).map((k) => rows[k].i).filter((i) => Number.isInteger(i))[0];
    rows['another-seed'] = { i: index, pub: theirs, at: Date.now() };
    ctx.storage.setItem('foxy.req.lockkeys', JSON.stringify(rows));
    let took = null, no = null;
    try { took = await W.receiveToken(paid.token); } catch (e) { no = e; }
    ok(!took && !!no && /locked to/.test(String(no.message)),
      'a row naming a lock this seed derives another key for opens nothing with the phone\u2019s key'
      + (took ? ' — took ' + took.sats + ' sats' : no ? '' : ' — no refusal'));
    const rows2 = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}');
    delete rows2['another-seed'];
    ctx.storage.setItem('foxy.req.lockkeys', JSON.stringify(rows2));
    const back = await W.receiveToken(paid.token, { unlockWith: Buffer.from(raw).toString('hex') });
    ok(!!back && back.sats === 5, 'and the ecash was not touched: its own key still takes it (' + (back && back.sats) + ' sats)');
  }

  // ---- rows from before hold real money and go on working -----------------
  {
    /* There is no schema step here and there can never be one: a random key has
     * no index to convert it to. A row written by a build from before is
     * `{ key, at }`, and it has to keep opening what it opens for ever. */
    const raw = ctx.window.CashuTS.createRandomSecretKey();
    const pub = Buffer.from(ctx.window.CashuTS.getPubKeyFromPrivKey(raw)).toString('hex');
    const key = Buffer.from(raw).toString('hex');
    const old = await W.sendToken(6, { unit: 'sat', lockTo: pub });
    const rows = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}');
    rows['old-request'] = { key: key, at: Date.now() };
    ctx.storage.setItem('foxy.req.lockkeys', JSON.stringify(rows));
    const back2 = await W.receiveToken(old.token);
    ok(!!back2 && back2.sats === 6,
      'a row from before the derived keys still opens its own ecash (' + (back2 && back2.sats) + ' sats)');
  }

  // ---- the lock index is its own file, not an entry in the counters -------
  {
    /* `CounterStore.parse` refuses the whole counter file if a key is not a
     * keyset id, so a `"p2pk"` entry there would make an older Foxy installed
     * over this one refuse the file and hand out no counter at all — a wallet
     * that cannot make an output. Its own file, and both go aside together when
     * the seed changes. */
    const counters = ctx.phone.countersNow();
    ok(Object.keys(counters).every((k) => /^(00[0-9a-f]{14}|01[0-9a-f]{64})$/.test(k)),
      'the counter file holds keyset ids only :: ' + Object.keys(counters).join(' '));
    ok((ctx.phone.locks.get(PHONE_WORDS) || 0) > 0, 'and the lock index is kept apart from them');
  }

  // ---- a row that names the lock but cannot say where -----------------------
  {
    /* `lockPrivkey` answers '' for a row that has a public key and no index —
     * and only a *rejection* used to fall through to the walk, so that one row
     * shape sent a perfectly recoverable token away. */
    await W.primeLocks();
    const request = W.decodeRequest(W.paymentRequest(8, { purpose: 'receive' }));
    const paid = await W.sendToken(8, { unit: 'sat', lockTo: request.lockTo });
    const rows = JSON.parse(ctx.storage.getItem('foxy.req.lockkeys') || '{}');
    rows[request.id] = { pub: request.lockTo, at: Date.now() };     // no index
    ctx.storage.setItem('foxy.req.lockkeys', JSON.stringify(rows));
    const got = await W.receiveToken(paid.token);
    ok(!!got && got.sats === 8,
      'a row with the right lock and no index falls through to the walk (' + (got && got.sats) + ' sats)');
  }

  // ---- a phone that cannot answer is not "somebody else's key" -------------
  {
    /* The walk used to answer '' for a phone that failed halfway, and '' means
     * "not ours" — so a keychain that did not answer told the person their money
     * belonged to somebody else, with sixty-four of sixty-seven batches never
     * looked at. It is a hard, final thing to say and there was no evidence for
     * it. Now the walk throws and the payment stays on the unclaimed list. */
    await W.primeLocks();
    const request = W.decodeRequest(W.paymentRequest(12, { purpose: 'receive' }));
    const paid = await W.sendToken(12, { unit: 'sat', lockTo: request.lockTo });
    ctx.storage.removeItem('foxy.req.lockkeys');       // no row: it has to walk
    ctx.phone.relaunch();
    ctx.phone.hooks.refuse = (m) => (m.action === 'p2pkPubkeys' ? 'the keychain did not answer' : null);
    let no = null;
    try { await W.receiveToken(paid.token); } catch (e) { no = e; }
    ctx.phone.hooks.refuse = null;
    ok(no && !/locked to/.test(no.message),
      'a phone that could not walk does not call it somebody else’s key :: ' + String(no && no.message).slice(0, 60));
    ok(no && /could not check/.test(no.message), 'it says it could not check');
    // and with the phone answering again, the same token is claimed
    const got = await W.receiveToken(paid.token);
    ok(!!got && got.sats === 12, 'and the next try takes it (' + (got && got.sats) + ' sats)');
  }

  // ---- a payment nothing here can open stops holding the seed --------------
  {
    /* `settling()` refuses a restore of different words while anything is
     * waiting on the unclaimed list, because this seed is what opens it. An
     * entry this seed CANNOT open is not waiting for anything, and left counted
     * it would refuse every restore until the app was reinstalled — the trap the
     * locked-send carve-out was written for, by another road. */
    const key = 'foxy.req.unclaimed';
    const spare = await W.sendToken(5, { unit: 'sat' });
    const bits = W.tokenInfo(spare.token);
    const alien = ctx.window.CashuTS.getEncodedToken({
      mint: bits.mint, unit: 'sat',
      proofs: bits.proofs.map((pr, i) => ({
        ...pr, secret: JSON.stringify(['P2PK', { nonce: 'dd' + i, data: '02' + 'd'.repeat(64), tags: [] }]) })),
    });
    ctx.storage.setItem(key, JSON.stringify({ 'req-stranded': { token: alien, at: Date.now(), sats: 5 } }));
    await W.claimUnclaimed();
    const left = JSON.parse(ctx.storage.getItem(key) || '{}');
    ok(!!left['req-stranded'], 'the token stays on disk, in case the seed that opens it comes back');
    ok(left['req-stranded'].stranded === true, 'and is marked as stranded rather than waiting');
    ctx.storage.removeItem(key);
  }

  /* Ecash that has arrived and is not swapped in blocks a seed replace — its
   * key is this seed's — and a stranded entry does not. That is `settling()`,
   * and it is tested where the other two records are, through the adopt path:
   * tests/run.js, "L10 new words are not adopted while a payment or swap is
   * still settling". */

  // ---- LAST: the primed keys go with the seed -----------------------------
  {
    /* The one that would have destroyed money, found in review on the day this
     * was written. The phone sets `foxy-p2pk.json` aside when the seed changes,
     * so its index restarts at 0 and no index will ever derive the primed keys
     * again — but the pool is in the page, and nothing here was clearing it. The
     * next eight requests would have gone out locked to keys this wallet could
     * not open, and a payer's wallet swaps into proofs locked to the key before
     * it delivers anything: each of those payments is destroyed by being made.
     *
     * This replaces the seed, so it is the last thing in the file. */
    await W.primeLocks();
    const before = JSON.parse(ctx.storage.getItem('foxy.req.lockpool') || '[]');
    ok(before.length > 0, 'keys are primed under the seed in use (' + before.length + ')');
    ctx.phone.hooks.wipe = () => true;
    const was = ctx.phone.keychain.words;
    ok((await W.seedForget()) === 'replaced', 'the phone replaced the seed');
    ok(ctx.phone.keychain.words !== was, 'and holds different words now');
    ok(JSON.parse(ctx.storage.getItem('foxy.req.lockpool') || '[]').length === 0,
      'the primed keys of the seed that is gone go with it');
    const stale = W.decodeRequest(W.paymentRequest(3, { purpose: 'receive' })) || {};
    ok(!stale.lockTo, 'a request made before the next prime goes out unlocked, not locked to a key nothing can open');
    await W.primeLocks();
    const fresh = W.decodeRequest(W.paymentRequest(3, { purpose: 'receive' })) || {};
    ok(!!fresh.lockTo && !before.some((x) => x.pub === fresh.lockTo),
      'and once primed again it locks to a key the new seed derives');
  }
}

run().then(() => {
  console.log(failed ? '\n' + failed + ' failed' : '\nall p2pk round-trip checks pass');
  process.exit(failed ? 1 : 0);
}, (e) => { console.log('THREW', e && e.stack || e); process.exit(1); });
