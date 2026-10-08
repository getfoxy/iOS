  /* ---- payment requests paid straight to whoever asked ---------------------
   *
   * A Cashu payment request (NUT-18) may say where the payer's wallet sends the
   * ecash: a POST of the payment to a URL, or a Nostr message. Without either,
   * the payer shows a token and it is scanned back, two scans for one payment.
   *
   * Foxy's own requests name an onion address on the requesting phone, open
   * only while the request is on screen (Foxy/Network/OnionInbox.swift). Paying
   * one, Foxy posts the payment there through Tor (OnionPost.swift). The payment
   * is NUT-18's: { id, memo, mint, unit, proofs }.
   *
   * What arrives is only a claim of payment. It is redeemed at the mint, like a
   * scanned token, and nothing is counted until the mint has swapped it. */

  /* Requests this wallet made and still answers: id -> { sats, mint, at, purpose }.
   *
   * Written down, not just held. It was memory only, and iOS reloads this page
   * whenever it feels like it — on an eviction, on a relaunch, on a WebView
   * restart. A payer who has the request in hand then arrives at a wallet that
   * has forgotten issuing it and is told "That payment answers no request open
   * here", while the key that opens their ecash is sitting in LOCK_KEYS where
   * it always was. The money is fine and nobody can move it until they try
   * again.
   *
   * The hour is unchanged and so is every check the record feeds: this only
   * stops the record vanishing inside that hour. A request answered after a
   * reload is a request the person made, on the phone they made it on, and the
   * door still has to be open for the payment to arrive at all. */
  var OPEN_REQUESTS = 'foxy.req.open';
  var OPEN_REQUEST_MS = 60 * 60 * 1000;
  var openRequests = (function () {
    try {
      var was = JSON.parse(window.localStorage.getItem(OPEN_REQUESTS) || '{}') || {};
      var now = Date.now(), live = {};
      Object.keys(was).forEach(function (k) {
        var r = was[k];
        if (r && typeof r === 'object' && Number(r.at) > 0 && now - Number(r.at) <= OPEN_REQUEST_MS
            && typeof r.mint === 'string') live[k] = r;
      });
      return live;
    } catch (e) { return {}; }
  })();

  /* Losing the write is not worth ending a receive over: the request is in
   * memory either way, and the only thing at stake is whether it survives a
   * reload. */
  function saveOpenRequests() {
    try { window.localStorage.setItem(OPEN_REQUESTS, JSON.stringify(openRequests)); } catch (e) {}
  }

  /* Paid, or given up on. Both halves — memory and store. */
  function dropOpenRequest(id) {
    if (!(id in openRequests)) return;
    delete openRequests[id];
    saveOpenRequests();
  }

  /* The key a payer's ecash is locked to, kept where it survives the app.
   *
   * `openRequests` is memory only, which is fine for the rest of what it holds
   * — but not for this. The redeem can fail, and the token then waits on the
   * unclaimed list for the next connect; a force-quit in between would leave
   * proofs only this key can spend and no key to spend them with: money nobody
   * can move, ever. Written before the request goes out, read when the payment
   * lands, and dropped once it is claimed.
   *
   * Old ones are swept on the way past. A key whose request was never paid is
   * worth nothing to anybody, but there is no reason to keep it. */
  /* A row holds no key at all: `{ i, pub }`, the index the
   * phone derived the key at and the public half it put in the request.
   *
   * The key used to be a random one made in the page, which is fine right up to
   * the moment the phone is gone. The twelve words rebuild every proof the seed
   * made and rebuild nothing whatever of a random key, so ecash locked to one,
   * on a phone that is lost, is money nobody can ever move — and the person
   * holding the words has no way of knowing it was ever there. NUT-13
   * standardises a path for these keys, m/129373'/10'/0'/0'/{index}, and the
   * phone walks it (Foxy/Keychain/P2PK.swift): the seed is not in this
   * page, so the derivation is native's and the page asks for
   * the private half only when there is ecash in front of it to open.
   *
   * Be straight about what that buys. A restore cannot *find* ecash locked to
   * these keys by walking anything — those proofs were minted by the payer,
   * from the payer's blinding factors, so NUT-09's restore never sees them.
   * What it buys is that a token already in hand — one that arrived and was
   * never claimed, one pasted in later, one copied off a dead phone — opens
   * from the twelve words on any device. `lockKeyMatching` does not even need
   * the index: it walks the path and compares public keys.
   *
   * ROWS FROM BEFORE HOLD REAL MONEY AND MUST WORK FOR EVER. They are
   * `{ key, at }`, a random private key in hex. There is no migration step and
   * there can never be one: a random key has no index to convert it to. Both
   * shapes are read here, for good. */
  var LOCK_KEYS = 'foxy.req.lockkeys';
  /* Nothing is swept by age.
   *
   * It was seven days, counted from when the key was written and never checked
   * against `unclaimed()` — so a payment that arrived and was still waiting
   * lost the only key that opens it. And "locked to someone else's key" is not
   * "already spent", so nothing dropped the unclaimed entry either:
   * `unclaimedSats` went on counting money nobody could move, for ever.
   * Nothing bounds when a payment arrives, so nothing about a
   * clock can bound when its key stops being needed.
   *
   * CDK never expires a lock key and neither does this. The cap is on how many
   * rows there are, oldest first, and it never takes one whose payment is still
   * waiting. */
  var LOCK_KEYS_MAX = 500;

  function lockKeys() {
    try { return JSON.parse(window.localStorage.getItem(LOCK_KEYS) || '{}') || {}; }
    catch (e) { return {}; }
  }

  /* A row's public key, whichever shape it is. A derived row carries it; a row
   * from before carries the private key, and the public half is derived from it
   * here, which is the same arithmetic the payer's wallet did. '' for a row this
   * build cannot read at all. */
  function lockPubOf(one) {
    if (!one || typeof one !== 'object') return '';
    if (typeof one.pub === 'string' && /^0[23][0-9a-f]{64}$/i.test(one.pub)) return one.pub.toLowerCase();
    if (typeof one.key !== 'string' || !/^[0-9a-f]{64}$/i.test(one.key)) return '';
    try { return hexOf(window.CashuTS.getPubKeyFromPrivKey(bytesOfHex(one.key))).toLowerCase(); }
    catch (e) { return ''; }
  }

  function keepLockKey(id, row) {
    if (!id || !row) return;
    var all = lockKeys();
    all[id] = row;
    var ids = Object.keys(all);
    if (ids.length > LOCK_KEYS_MAX) {
      var waiting = unclaimed();
      /* By the key, not only by the id. A payment kept from a scan waits
       * under the fingerprint of its pieces, not under the id of the request
       * whose key it is locked to, so its row was not spared: for a row from
       * before, a random key, that was the only copy, and the payment was
       * stranded for good. Every key a waiting payment names is read from
       * the payment itself. */
      var named = [];
      Object.keys(waiting).forEach(function (wid) {
        var tok = null;
        try { tok = FoxyWallet.tokenInfo((waiting[wid] || {}).token); } catch (eTok) { tok = null; }
        ((tok && tok.proofs) || []).forEach(function (pr) {
          var keys = null;
          try { keys = spendableBy(pr); } catch (eKeys) { keys = null; }
          (keys || []).forEach(function (key) { named.push(key); });
        });
      });
      var spared = function (k) {
        if (k === id || (k in waiting)) return true;
        if (!named.length) return false;
        var pub = lockPubOf(all[k]);
        return !!pub && named.some(function (key) { return sameLockKey(key, pub); });
      };
      ids.filter(function (k) { return !spared(k); })
        .sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); })
        .slice(0, ids.length - LOCK_KEYS_MAX)
        .forEach(function (k) { delete all[k]; });
    }
    /* mustSave, because this row is how the ecash paid to this request is found
     * again quickly.
     *
     * It was a bare try that threw the refusal away, so a full store still let
     * the request go out carrying the lock — and a request naming a public key
     * whose private half is written nowhere destroys whatever is paid to it.
     * Not at the far end, either: the payer's wallet swaps its good proofs into
     * proofs locked to that key *before* it delivers anything, so the money is
     * gone the moment they pay, and the token they are handed back when the
     * claim fails is a token nobody on earth can spend. W6 again:
     * a write that does not land is an error. `paymentRequest` catches this and
     * sends the request unlocked, which is what every request was before
     * requests were locked and is money that still arrives.
     *
     * The derived key softens that — the seed can rebuild the key whether this
     * row lands or not, so a lost row is a slow lookup rather than a loss — but
     * the rule stands. A row is what ties a payment to the request it answers,
     * and "the seed can find it by scanning" is not a thing to lean on while
     * somebody is standing there waiting to be paid. */
    mustSave(LOCK_KEYS, all);
  }

  /* ---- the pool of primed locks --------------------------------------------
   *
   * `paymentRequest` is synchronous — the receive screen builds a QR code in the
   * middle of a render — and deriving a key is a round trip to the phone. So the
   * phone is asked ahead of time for a handful of public keys, and a request
   * takes one off the front.
   *
   * An empty pool means the request goes out UNLOCKED. Never a random key: a
   * random key is the bug this whole change exists to remove, and quietly
   * falling back to one would put it back on the very path that is hardest to
   * notice. Unlocked is what every request was before requests were locked,
   * and it is money that still arrives. */
  var LOCK_POOL = 'foxy.req.lockpool';
  var LOCK_POOL_WANT = 8;
  /* How long the receive screen waits for a first fill before showing a code
   * without a lock on it (`primeLocks`). The phone derives eight keys in
   * microseconds; what this covers is a keychain read that is slow, or one
   * behind a Face ID prompt somebody is not answering. */
  var LOCK_PRIME_WAIT = 8000;
  var lockPriming = null;

  /* Rows this build can use: an index and the public key the phone derived. */
  function lockPool() {
    var raw;
    try { raw = JSON.parse(window.localStorage.getItem(LOCK_POOL) || '[]'); }
    catch (e) { return []; }
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (x) {
      return x && typeof x === 'object' && Number.isInteger(x.i) && x.i >= 0
        && typeof x.pub === 'string' && /^0[23][0-9a-f]{64}$/i.test(x.pub);
    });
  }

  /* Thrown away with the seed they came from (clearNativeSecrets).
   *
   * A pool entry is a public key and nothing else, so nothing checks it on the
   * way into a request — that is what makes a stale one dangerous rather than
   * merely useless. `save`, not `mustSave`: a refusal here is logged loudly and
   * the entries are dropped from memory's point of view by the epoch anyway,
   * but there is nothing to throw to. The next prime overwrites the key. */
  function dropLockPool() {
    lockPoolChecked = false;
    if (!lockPool().length) return;
    console.log('[foxy] the seed changed; the primed lock keys go with it');
    if (!save(LOCK_POOL, [])) {
      console.error('[foxy] the primed lock keys of the old seed could not be dropped;'
        + ' requests are sent unlocked until they can be');
      lockPoolStale = true;
    }
  }

  /* Whether the pool on disk is this seed's, asked of the phone once a launch.
   *
   * The latch above lives in memory. One refused write at a seed change, then
   * a relaunch, and the old seed's keys were handed out again: the request
   * went out locked to a key the new seed cannot derive, the payment to it
   * was kept, and the claim found nothing to open it with. The pool carries
   * no mark of its seed, so the first entry is put to the phone: the key it
   * derives at that index is the pool's, or the pool is not this seed's and
   * goes. A phone that cannot answer leaves the pool as it is; a wrong one
   * costs nothing but the indices. */
  var lockPoolChecked = false;

  function lockPoolOfThisSeed(pool) {
    if (lockPoolChecked || !pool.length) { lockPoolChecked = true; return Promise.resolve(true); }
    var first = pool[0];
    if (!Number.isInteger(first.i) || first.i < 0) return Promise.resolve(true);
    return nativeJson('p2pkPubkeys', { start: first.i, count: 1 }, 60000).then(function (j) {
      var keys = (j && j.pubkeys) || [];
      var theirs = String(keys[0] || '').toLowerCase();
      lockPoolChecked = true;
      if (!/^0[23][0-9a-f]{64}$/.test(theirs)) return true;
      if (theirs === String(first.pub || '').toLowerCase()) return true;
      console.warn('[foxy] the primed lock keys are another seed\u2019s; they go, and this seed\u2019s are made');
      if (!save(LOCK_POOL, [])) { lockPoolStale = true; return false; }
      lockPoolStale = false;
      return false;
    }, function () { return true; });
  }

  /* Set when the write above failed. Belt and braces: `takeLockKey` hands out
   * nothing while it stands, so a request cannot carry a key from a seed that
   * is gone even if the store refuses every write. */
  var lockPoolStale = false;

  /* Fills the pool, one request at a time. Resolves with how many are in it —
   * never rejects, because every caller's answer to "no locks" is the same: send
   * the request without one. */
  function primeLockPool() {
    if (lockPriming) return lockPriming;
    var run = lockPoolOfThisSeed(lockPool()).then(function () {
      var have = lockPool();
      if (have.length >= LOCK_POOL_WANT) return have.length;
      var want = LOCK_POOL_WANT - have.length;
      return nativeJson('p2pkReserve', { count: want }, 60000).then(function (j) {
      var start = j && j.start, keys = (j && j.pubkeys) || [];
      if (!Number.isInteger(start) || start < 0 || !Array.isArray(keys) || keys.length !== want) {
        throw new Error('the phone’s lock keys were not for what was asked');
      }
      /* Read again rather than from `have`: a request may have taken one while
       * the phone was answering, and writing `have` back would hand that index
       * to a second request. */
      var pool = lockPool();
      for (var i = 0; i < keys.length; i++) {
        if (!/^0[23][0-9a-f]{64}$/i.test(String(keys[i]))) throw new Error('the phone’s lock keys were not for what was asked');
        pool.push({ i: start + i, pub: String(keys[i]).toLowerCase() });
      }
      /* `save`, not `mustSave`. A refusal here loses the indices the phone has
       * already moved past, which costs nothing — indices are free — and leaves
       * the pool as it was, which means the next request goes out unlocked. */
      if (!save(LOCK_POOL, pool)) {
        console.warn('[foxy] the primed lock keys could not be kept; requests go out unlocked until a write lands');
        return lockPool().length;
      }
      // these are this seed's, so the pool is usable again
      lockPoolStale = false;
      return pool.length;
    }, function (e) {
      console.warn('[foxy] the phone did not derive lock keys for payment requests:', (e && e.message) || e);
      return lockPool().length;
    });
    });
    lockPriming = run;
    function done() { if (lockPriming === run) lockPriming = null; }
    run.then(done, done);
    return run;
  }

  /* One primed lock, filed against `id`, or '' when there is none.
   *
   * The order matters and is the opposite of what it looks like it should be.
   * The pool is written FIRST, so an index can only ever be lost, never handed
   * to two requests — two requests carrying one lock would tie two payments
   * together at the mint, which is most of what the lock is for. Then the row.
   * If the row does not land, the request carries no lock and one index is
   * wasted; if the pool write does not land, nothing is taken at all. */
  function takeLockKey(id) {
    // nor before the phone has confirmed, this launch, whose keys the pool holds (`lockPoolOfThisSeed`)
    if (lockPoolStale || !lockPoolChecked) return '';
    var pool = lockPool();
    if (!pool.length) return '';
    var one = pool.shift();
    mustSave(LOCK_POOL, pool);
    keepLockKey(id, { i: one.i, pub: one.pub, at: Date.now() });
    return one.pub;
  }

  /* The public key this phone put in a request, without asking the phone for
   * anything: a derived row carries it, and a row from before derives it from
   * the key it holds. */
  /* A key for change on this payment to be locked to, kept under the request's own
   * id so `lockKeyMatching` finds it when the change arrives. '' when the pool is
   * empty, and then no change is asked for rather than an unlocked one accepted. */
  /* How a token's note names the key its change is to be locked to. */
  var CHANGE_NOTE = 'foxy:change:';

  function changeKeyFor(id) {
    if (!id) return '';
    var already = lockPubFor('change-' + id);
    if (already) return already;
    return takeLockKey('change-' + id);
  }

  function lockPubFor(id) {
    return lockPubOf(lockKeys()[id]);
  }

  /* The private key for a request's lock, from the phone, or '' when this phone
   * never asked for one. Rejects only when the phone refuses.
   *
   * The public key the phone answers with is compared against the one the row
   * kept. That is the check that catches a row written under a seed which has
   * since been replaced: the index still exists, the phone still derives a key
   * at it, and it is a different key, which would fail at the mint with the
   * proofs already spent. */
  function lockPrivkey(id) {
    var one = lockKeys()[id];
    if (!one || typeof one !== 'object') return Promise.resolve('');
    // a row from before the derived keys: the key itself, and no phone involved
    if (typeof one.key === 'string' && /^[0-9a-f]{64}$/i.test(one.key)) return Promise.resolve(one.key);
    var pub = lockPubOf(one);
    if (!Number.isInteger(one.i) || one.i < 0 || !pub) return Promise.resolve('');
    return nativeJson('p2pkKey', { index: one.i }, 60000).then(function (j) {
      var got = String((j && j.privkey) || '');
      if (!/^[0-9a-f]{64}$/i.test(got)) throw new Error('the phone’s lock key was not a key');
      if (String((j && j.pubkey) || '').toLowerCase() !== pub) {
        throw new Error('the phone derives a different key at index ' + one.i
          + ' than the one this request went out with; the seed is not the seed that made it');
      }
      return got.toLowerCase();
    });
  }

  /* Ecash that arrived and has not been claimed yet, written down before
   * anything is attempted with it.
   *
   * A payment delivered to this phone exists, for a moment, only as a string in
   * a local variable. If the claim fails — no network, the app closing, a timer
   * that died — that string goes and the money with it: the payer has already
   * let go of its copy, and proofs nobody holds are proofs nobody can spend.
   * 25 sats went that way once while a delayed redeem sat in a
   * setTimeout. Written first, tried second, cleared only once it is really in
   * the wallet, and retried on the next launch. */
  var UNCLAIMED = 'foxy.req.unclaimed';

  function unclaimed() {
    try { return JSON.parse(window.localStorage.getItem(UNCLAIMED) || '{}') || {}; }
    catch (e) { return {}; }
  }

  /* `trusted` marks the one kind of arrival this phone has not settled and
   * cannot settle: unlocked ecash taken while both phones were offline, on the
   * person's word that they trust the payer. Everything else here is either
   * locked to this phone or already swapped, so a failed claim is a hiccup. For
   * a trusted row a failed claim is the payer having taken their money back, and
   * the person who accepted it has to be told (claimUnclaimed). */
  /* The row already holding any of this token's pieces, or ''.
   *
   * By the pieces, not by the token's text or the name it was kept under: the
   * same change came over the link and was kept as `change-…`, and sixteen
   * seconds later was scanned off the other phone's screen and kept again as
   * `scan-…` — one payment, two rows, and a history that never
   * added up again. Offline there is no mint to say it
   * has seen these before, so this phone has to. */
  function heldAlready(token) {
    var tok = null;
    try { tok = FoxyWallet.tokenInfo(token); } catch (e) { tok = null; }
    if (!tok || !tok.proofs || !tok.proofs.length) return '';
    var mine = {};
    tok.proofs.forEach(function (pr) { if (pr && pr.secret) mine[String(pr.secret)] = true; });
    var all = unclaimed();
    var hit = Object.keys(all).filter(function (id) {
      var row = all[id];
      if (!row || typeof row.token !== 'string') return false;
      var have = null;
      try { have = FoxyWallet.tokenInfo(row.token); } catch (e) { have = null; }
      return !!have && (have.proofs || []).some(function (pr) { return mine[String(pr.secret)]; });
    })[0];
    return hit || '';
  }

  function keepUnclaimed(id, token, sats, trusted, plain) {
    if (!id || !token) return;
    var all = unclaimed();
    all[id] = { token: token, at: Date.now(), sats: Number(sats) || 0 };
    // which mint it is at, for the balance of that mint and no other (`unclaimedSats`)
    var at = unclaimedMint({ token: token });
    if (at) all[id].mint = at;
    if (trusted) all[id].trusted = true;
    // taken at another mint to be carried home: claimed as it is, not cut into small change
    if (plain) all[id].plain = true;
    /* mustSave, and `_requestPaid` refuses the payment when it throws.
     *
     * The comment above this store is the whole reason it exists, and the write
     * it describes used to swallow its own refusal. With the store
     * full the payer was still answered 200, the sats were still written into
     * history and counted in the balance, and the only copy of the token was
     * still handed to a setTimeout — the loss that comment describes reached
     * through a full store instead of a backgrounded app. Refused, the payer
     * keeps their ecash and can pay again when there is room. */
    mustSave(UNCLAIMED, all);
  }

  /* Ecash that arrived and that no seed on this phone can open: still written
   * down, no longer counted as money in flight.
   *
   * `settling()` refuses a restore of different words while anything is waiting
   * here, because this seed is what opens it. A stranded entry is not waiting
   * for anything, and left counted it would refuse every restore for ever —
   * exactly the trap the locked-send carve-out was written for.
   * The token stays on disk: if the seed that opens it comes back, the next
   * connect claims it and the entry goes the ordinary way. */
  function strandUnclaimed(id) {
    var all = unclaimed();
    if (!all[id] || all[id].stranded) return;
    all[id].stranded = true;
    if (!save(UNCLAIMED, all)) {
      console.warn('[foxy] a payment nothing here can open could not be marked as stranded;'
        + ' it goes on holding the seed until a write lands');
    }
  }

  /* Whether a payment is still waiting on this wallet. `unclaimedSats` counts a
   * stranded one — it is on the books either way, and the person can see it —
   * but `settling()` does not hold the seed for it. */
  function unclaimedWaiting() {
    var all = unclaimed(), ids = Object.keys(all), n = 0;
    for (var i = 0; i < ids.length; i++) if (!(all[ids[i]] && all[ids[i]].stranded)) n += 1;
    return n;
  }

  /* Sats that have arrived but are not swapped into this wallet's own secrets
   * yet. Counted as held, because they are: locked to a key only this phone
   * has, so the payer cannot take them back and nobody else can spend them.
   * What is left is a swap, and the swap is what waits. */
  /* Ecash that has arrived, is locked to this phone, and can be handed straight
   * on without a swap (`forwardLocked`).
   *
   * This is the answer to the question an offline market stall asks: money taken
   * this morning goes to the unclaimed store, counted in the balance and locked
   * to this phone — and a send reads the spendable pile, which that money is not
   * in. So it could not be spent until there was a route, however much of it had
   * arrived.
   *
   * NUT-11 with SIG_INPUTS is what makes it possible: a signature over the
   * inputs authorises the spend and says nothing about who creates the outputs,
   * so a proof this phone signs is one anybody can swap. Handing it on is
   * therefore a real payment, not an IOU.
   *
   * Each row is atomic here. A row is one token and `forwardLocked` signs it
   * whole, so a selection either uses all of a row or none of it. Rows already
   * handed on, rows for another mint, and rows nothing here can open are left
   * out: `[{ id, sats, token }]`, largest first. */
  function lockedPieces() {
    var at = String(mintUrl || '').replace(/\/+$/, '');
    if (!at) return [];
    var all = unclaimed();
    var out = [];
    Object.keys(all).forEach(function (id) {
      var row = all[id];
      if (!row || row.stranded || typeof row.token !== 'string' || !(row.sats > 0)) return;
      var tok = null;
      try { tok = FoxyWallet.tokenInfo(row.token); } catch (e) { tok = null; }
      if (!tok || !tok.proofs || !tok.proofs.length) return;
      if (String(tok.mint || '').replace(/\/+$/, '') !== at) return;
      // locked, and locked whole: a mixed token cannot be handed on
      if (lockedProofs(tok.proofs).length !== tok.proofs.length) return;
      try { if (window.CashuTS && window.CashuTS.isP2PKSigAll
                && window.CashuTS.isP2PKSigAll(tok.proofs)) return; } catch (e) {}
      // and not already signed out once
      if (tok.proofs.some(function (pr) { return handedOn(pr.secret); })) return;
      // `proofs`: the pieces themselves, for the receiver's fee on them (`exactWithLocked`)
      out.push({ id: id, sats: Number(row.sats) || 0, token: row.token, proofs: tok.proofs });
    });
    return out.sort(function (a, b) { return b.sats - a.sats; });
  }

  /* The same ecash, piece by piece.
   *
   * A row was all or nothing only because this code signed a token whole. The
   * lock is on each piece — NUT-11 puts the key in the piece's own secret and
   * the signature beside it — so a piece can be signed and handed on without
   * the others. That is what lets an offline phone holding one $10 payment
   * pay $3 with its own pieces instead of handing over all ten and waiting
   * for seven to come back.
   *
   * `[{ proof, row }]`: every piece of every row `lockedPieces` would offer,
   * and of a row that has already given some up — less any piece this phone
   * has signed away, which is the one thing that must never go out twice. */
  function lockedProofsFlat() {
    var at = String(mintUrl || '').replace(/\/+$/, '');
    if (!at) return [];
    var all = unclaimed();
    var out = [];
    Object.keys(all).forEach(function (id) {
      var row = all[id];
      if (!row || row.stranded || typeof row.token !== 'string' || !(row.sats > 0)) return;
      var tok = null;
      try { tok = FoxyWallet.tokenInfo(row.token); } catch (e) { tok = null; }
      if (!tok || !tok.proofs || !tok.proofs.length) return;
      if (String(tok.mint || '').replace(/\/+$/, '') !== at) return;
      if (lockedProofs(tok.proofs).length !== tok.proofs.length) return;
      try { if (window.CashuTS && window.CashuTS.isP2PKSigAll
                && window.CashuTS.isP2PKSigAll(tok.proofs)) return; } catch (e) {}
      tok.proofs.forEach(function (pr) {
        if (!pr || !pr.secret || !(satsOf(pr.amount) > 0) || handedOn(pr.secret)) return;
        out.push({ proof: pr, row: id });
      });
    });
    return out;
  }

  /* These pieces have been signed away: off the rows they came from.
   *
   * A row that gave up every piece goes; one that gave up some is written
   * again with what is left, and remembers what it was worth whole so the
   * payment's entry in history can still say what arrived (`whole`). By the
   * pieces' secrets, not by the token's text, so it finds them whether the
   * row was handed on whole or in part. */
  function takeFromUnclaimed(proofs) {
    var gone = {};
    (proofs || []).forEach(function (pr) { if (pr && pr.secret) gone[String(pr.secret)] = true; });
    var all = unclaimed();
    var changed = false;
    Object.keys(all).forEach(function (id) {
      var row = all[id];
      if (!row || typeof row.token !== 'string') return;
      var tok = null;
      try { tok = FoxyWallet.tokenInfo(row.token); } catch (e) { tok = null; }
      if (!tok || !tok.proofs || !tok.proofs.length) return;
      var keep = tok.proofs.filter(function (pr) { return !gone[String(pr.secret)]; });
      if (keep.length === tok.proofs.length) return;
      changed = true;
      if (!keep.length) { delete all[id]; return; }
      if (!(row.whole > 0)) row.whole = Number(row.sats) || 0;
      row.token = window.CashuTS.getEncodedToken({ mint: tok.mint, proofs: keep, unit: 'sat' });
      row.sats = sumProofs(keep);
    });
    if (changed && !save(UNCLAIMED, all)) {
      console.warn('[foxy] could not take handed-on ecash off its row; the claim will leave those pieces out');
    }
    return changed;
  }

  /* A row's token without anything this phone has already signed away. A row
   * that could not be rewritten when its pieces went still names them, and
   * swapping it whole would be refused as already spent — and the row dropped,
   * with whatever it still held. '' when nothing is left. */
  function withoutHandedOn(text) {
    var tok = null;
    try { tok = FoxyWallet.tokenInfo(text); } catch (e) { tok = null; }
    if (!tok || !tok.proofs || !tok.proofs.length) return String(text || '');
    var keep = tok.proofs.filter(function (pr) { return !handedOn(pr.secret); });
    if (keep.length === tok.proofs.length) return String(text || '');
    if (!keep.length) return '';
    return window.CashuTS.getEncodedToken({ mint: tok.mint, proofs: keep, unit: 'sat' });
  }

  /* The mint a waiting payment is at: written on the row, and read from the
   * token for a row kept before that was. Remembered by the token, since a
   * balance is asked for many times a second and a token does not change. */
  var unclaimedMints = {};
  function unclaimedMint(row) {
    if (!row) return '';
    if (typeof row.mint === 'string' && row.mint) return canonicalMint(row.mint);
    var text = typeof row.token === 'string' ? row.token : '';
    if (!text) return '';
    if (unclaimedMints[text] !== undefined) return unclaimedMints[text];
    var at = '';
    try { at = canonicalMint(String((FoxyWallet.tokenInfo(text) || {}).mint || '')); } catch (e) { at = ''; }
    unclaimedMints[text] = at;
    return at;
  }

  /* What is waiting, in all — or, given a mint, what is waiting at that mint.
   *
   * The balance on screen is one mint's, and it added everything waiting at
   * every mint: 81 sats taken offline at one mint showed as part of the
   * balance at another, where 34 were all that could be spent. Another
   * phone showed 580 sats of one mint on another. A row whose mint
   * cannot be read is counted where the phone is, as it always was. */
  function unclaimedSats(at) {
    var all = unclaimed(), ids = Object.keys(all), total = 0;
    var here = at ? canonicalMint(String(at)) : '';
    for (var i = 0; i < ids.length; i++) {
      var n = all[ids[i]] && all[ids[i]].sats;
      if (!(typeof n === 'number' && n > 0)) continue;
      if (here) {
        var m = unclaimedMint(all[ids[i]]);
        if (m && m !== here) continue;
      }
      total += n;
    }
    return total;
  }

  /* `save`, not `mustSave`, and a refusal only logged: this runs *after* the
   * proofs are in the pile, which inverts the rule above. A throw here would
   * turn a receive that worked into a failure — the claim's rejection answers
   * the payer 422 — for money the mint has already handed over. What a refused
   * drop costs is a stale entry: `unclaimedSats` counts it twice until a write
   * lands, and `claimUnclaimed` tries a token the mint has taken and drops it
   * on "already spent". `save` rather than a bare try, so a store a newer Foxy
   * wrote is still left alone (storageNewer). */
  /* Secrets this phone has signed and given away.
   *
   * Signing a locked proof makes it spendable by whoever holds the signature, so
   * handing the same one to two people is a double-spend with this phone's name on
   * it — the second person loses. The list is the guard, and it is `mustSave` for
   * the same reason the unclaimed store is: a note that does not land would let
   * exactly that happen.
   *
   * Bounded, because it grows for ever otherwise. Two hundred is far more than a
   * phone hands on between swaps, and an entry that falls off the end names a
   * proof the mint has long since marked spent — so a repeat is refused by the
   * mint rather than here, which is a worse message but not a worse outcome. */
  var HANDED = 'foxy.req.handedon';

  function handedList() {
    try { var l = JSON.parse(window.localStorage.getItem(HANDED) || '[]'); return Array.isArray(l) ? l : []; }
    catch (e) { return []; }
  }

  function handedOn(secret) {
    return handedList().indexOf(String(secret || '')) >= 0;
  }

  function rememberHandedOn(proofs) {
    var all = handedList();
    (proofs || []).forEach(function (pr) {
      var sec = String((pr && pr.secret) || '');
      if (sec && all.indexOf(sec) < 0) all.push(sec);
    });
    mustSave(HANDED, all.slice(-200));
  }

  /* The unclaimed row holding exactly this token, gone.
   *
   * `dropUnclaimed` wants the request id, and whoever hands a token on has the
   * token rather than the id — a payment that arrived and was never claimed can be
   * pasted in long after nobody remembers which request it belonged to. */
  function dropUnclaimedByToken(text) {
    var want = String(text || '');
    var all = unclaimed();
    var hit = Object.keys(all).filter(function (id) { return all[id] && all[id].token === want; });
    if (!hit.length) return false;
    hit.forEach(function (id) { delete all[id]; });
    if (!save(UNCLAIMED, all)) {
      console.warn('[foxy] could not clear the unclaimed row for ecash handed on');
    }
    return true;
  }

  /* Change, when somebody paid more than they were asked for.
   *
   * It happens because a payer with no route cannot swap: they can only hand over
   * pieces they already hold, so an amount their pile cannot make exactly is paid
   * by handing over more. The difference comes back here.
   *
   * Only over Bluetooth, and only while that link is open. An onion payment has no
   * link to answer on — by the time this runs the payer may be anywhere — and a
   * payer who could reach an onion could have swapped to the exact amount in the
   * first place, so the case does not arise.
   *
   * It lives here rather than beside `_requestPaid` because `openRequests` does,
   * and what was asked for is the whole question.
   *
   * Nothing here throws into the caller and nothing is awaited by it. The payment
   * has been taken and answered 200 by the time this runs, and a failure to hand
   * change back must not unwind that. When it fails the payer is owed, which is a
   * thing two people standing together can settle; a payment that half-happened is
   * not. The change token is written into history by `sendToken` either way, so an
   * undelivered one is on the token screen rather than lost. */
  /* How much of this payment is change going straight back out: 0 for every
   * ordinary one.
   *
   * Asked by `changeBack`, which hands it over, and by `_requestPaid`, which has
   * to know what this phone is actually keeping before it writes the entry and
   * tells the screen. Both used the gross and the receiver was shown 4 sats for a
   * 3-sat sale, on both phones. One function, so the figure on the
   * screen and the money that stays can never disagree. */
  /* What the mint adds to a token of `sats` so the phone that takes it is not
   * out of pocket for taking it (cashu-ts `includeFees`): the fee on the
   * pieces the amount is cut into, and on the pieces that fee is cut into. */
  function tokenFeeFor(w, sats) {
    var bits = function (n) { return String(Math.max(0, Math.round(n)).toString(2)).split('1').length - 1; };
    var n = Math.round(Number(sats) || 0);
    if (!(n > 0)) return 0;
    var fee = feeForInputs(w, bits(n));
    for (var i = 0; i < 8 && fee > 0; i++) {
      if (feeForInputs(w, bits(n) + bits(fee)) <= fee) break;
      fee += 1;
    }
    return fee;
  }

  /* How much change goes back, of `owed` sats paid over what was asked.
   *
   * All of it at a mint that charges nothing. At one that does, making the
   * change spends a piece and the token carries the fee for taking it, and
   * both come out of the change: the person who paid over pays for getting
   * it back, and the receiver keeps exactly what it asked for. Nought when
   * that leaves nothing — an overpayment of a sat or two at 150 ppk — and
   * then no change is made at all: sending it would cost more than it is.
   *
   * Both phones ask this, of the same mint's fees, and get the same answer:
   * the payer knows from it whether change is coming, so nothing has to
   * cross the link to say none is. */
  function changeFor(w, owed) {
    var n = Math.round(Number(owed) || 0);
    if (!(n > 0) || !w) return 0;
    var spend = feeForInputs(w, 1);
    for (var x = n - spend; x > 0; x--) {
      if (x + tokenFeeFor(w, x) + spend <= n) return x;
    }
    return 0;
  }

  /* The same, for the phone that is about to make it: what goes back given
   * the pieces it would actually spend making it.
   *
   * `changeFor` is the sum both phones can do, and it counts one piece
   * spent. A receiver whose pile is small change spends several, and the
   * difference came out of what it had asked for: 300 asked, 299 kept
   * (offline-cross-scenarios.js `over-cut`). So the amount is taken down
   * until what leaves — the change, the fee it carries and the fee on the
   * pieces that go in — is no more than what was paid over. It never says
   * nought where `changeFor` says something: the payer is waiting for it,
   * and then the difference is this phone's, on its entry. */
  function changeFromPile(w, owed) {
    var most = changeFor(w, owed);
    if (!(most > 0)) return 0;
    var n = Math.round(Number(owed) || 0);
    var pile = [];
    try { pile = proofs(mintOf(w)).filter(function (p) { return p && p.secret && !lockedTo(p); }); } catch (e) { pile = []; }
    var bits = function (v) { return String(Math.max(0, v).toString(2)).split('1').length - 1; };
    for (var x = most; x > 0; x--) {
      var out = x + tokenFeeFor(w, x);
      var spend = null;
      // one piece that covers it, as a locked send takes when it can (`sendToken`, oneIn)
      var slack = feeForInputs(w, bits(x) + 4);
      for (var i = 0; i < pile.length && spend === null; i++) {
        if (satsOf(pile[i].amount) - swapFeeFor(w, [pile[i]]) >= x + slack) spend = swapFeeFor(w, [pile[i]]);
      }
      if (spend === null) {
        try {
          var sel = w.selectProofsToSend(pile, out, true);
          var picked = (sel && sel.send) || [];
          if (picked.length) spend = swapFeeFor(w, picked);
        } catch (e2) { spend = null; }
      }
      if (spend === null) return most;
      if (out + spend <= n) return x;
    }
    return most;
  }

  /* ---- change on its way back, out of what this phone says it has --------
   *
   * An offline payer with no exact pieces pays with a larger one, and the
   * receiver hands the difference back. The entry is written at what stays
   * (`kept`) the moment the payment lands; the pieces say the whole of it until
   * the swap that makes the change has run, two to six seconds later. For
   * those seconds the balance was the payment plus its change, and the books
   * were out by the change: a phone paid 100 with a 128 piece showed the 28
   * it was about to give away, and DOES NOT ADD UP to anybody who opened the
   * history card just then.
   *
   * So what is going back is set aside from the start. Held by the payment's
   * own entry, in memory only: a page that dies in those seconds comes back
   * holding the lot, which is the truth, and the change's own record puts it
   * right (`repairOwedChange`, the swap record's `pay`). Let go at the instant
   * the pieces leave the pile (`sendToken`), or when no change is going to be
   * made after all and this phone keeps the lot. */
  var changeLeaving = {};

  function holdChange(hash, sats, at) {
    var n = Math.round(Number(sats) || 0);
    if (!hash || !(n > 0)) return;
    changeLeaving[hash] = { sats: n, mint: canonicalMint(String(at || mintUrl || '')) };
  }

  /* Idempotent: every way out of making change calls it, and only one of
   * them is the one that had anything to let go. */
  function changeHoldOver(hash) {
    if (hash && changeLeaving[hash]) delete changeLeaving[hash];
  }

  function changeLeavingSats(at) {
    var here = at ? canonicalMint(String(at)) : '', total = 0;
    Object.keys(changeLeaving).forEach(function (k) {
      var one = changeLeaving[k];
      if (!here || !one.mint || one.mint === here) total += one.sats;
    });
    return total;
  }

  function changeOwed(p, over) {
    if (over !== 'tap') return 0;
    var asked = Number(p.asked);
    var paid = Number(p.sats) || 0;
    if (!(asked > 0) || !(paid > asked)) return 0;
    /* Only what will really go back. With no route there is nothing to swap
     * with, and with no key from the payer there is nothing to lock it to — in
     * both cases this phone keeps the lot and the entry should say so. */
    if (!routeOpen() || !p.changeTo) return 0;
    /* Less this mint's input fee on the pieces that came. A payer with no
     * route pays the amount plus that fee on purpose, so the receiver nets
     * what it asked (readPayment); treating the fee as an overpayment made
     * 8 sats of change for the 8 sats of fee, the receiver was 8 short, and
     * the payer was sent to scan a code for money it had meant to pay (seen
     * across mints). */
    var owed = Math.max(0, paid - asked - (Number(p.inFee) || 0));
    // too little to be worth sending back stays, and the entry says what stayed
    return changeFor(wallet, owed) > 0 ? owed : 0;
  }

  /* Change that was made and not handed over, kept on the payment it is the
   * rest of. `handed: 'tap'` is what takes RECLAIM off the entry: the token is
   * locked to the payer, so it is theirs to take and nobody's to take back. */
  function owedChangeOnEntry(hash, token) {
    try {
      FoxyWallet.tag(hash, { token: String(token || ''), handed: 'tap', owedChange: true });
      amendTx(hash, { changeState: 'not handed' });
    } catch (e) {
      console.warn('[foxy] the change could not be put on its payment\u2019s entry:', e && e.message);
    }
  }

  /* And the ones from before that was done: change made, tagged under a hash of
   * its own with no row, for a payment whose entry still says the change is on
   * its way. Matched by the amount and by the minute it was made in, which is
   * in the token's own hash. Run when history is read; it finds nothing on a
   * phone that has none. */
  function repairOwedChange() {
    var log = load(K.log, []);
    var meta = load('foxy.txmeta', {});
    var nowS = Math.floor(Date.now() / 1000);
    var fixed = 0;
    log.forEach(function (e) {
      if (!e || e.dir !== 'in' || !(Number(e.changeSats) > 0)) return;
      /* Anything not known to have been handed over. Nothing used to
       * record that it had been, so an entry from before says `making`, or
       * nothing, either way. A day's worth: a token shown again to the person
       * it is locked to costs nobody anything, and older than that it has
       * been claimed or it has been forgotten. */
      if (e.changeState && e.changeState !== 'making' && e.changeState !== 'owed') return;
      if (nowS - (Number(e.at) || 0) < 60) return;          // it may still be on its way
      if (nowS - (Number(e.at) || 0) > 86400) return;
      if (meta[e.hash] && meta[e.hash].token) return;
      var hit = Object.keys(meta).filter(function (h) {
        var m = meta[h];
        if (!m || !m.change || typeof m.token !== 'string' || !m.token) return false;
        var when = /^token-(\d{10,})/.exec(h);
        if (!when || Math.abs(Math.floor(Number(when[1]) / 1000) - Number(e.at)) > 120) return false;
        var info = null;
        try { info = FoxyWallet.tokenInfo(m.token); } catch (x) { info = null; }
        return !!info && satsOf(info.amount) === Math.round(Number(e.changeSats));
      })[0];
      if (!hit) return;
      owedChangeOnEntry(e.hash, meta[hit].token);
      fixed += 1;
    });
    if (fixed) console.log('[foxy] ' + fixed + ' payment(s) had change that was never handed over; it is on their entries now');
    try { recheckGivenBack(log, meta, nowS); } catch (x) {}
    try { recheckNotHanded(log, meta, nowS); } catch (x) {}
    try { fixed += settleCollectedChange(); } catch (x) {}
    return fixed;
  }

  /* Change this phone wrote down as given back before it could know.
   *
   * "Given back" used to be written when the bytes left, not when
   * the payer said it had kept them, and a payer that put Foxy away a second
   * and a half after paying never read them: change, locked to
   * a phone that did not have it, on a receiver that showed nothing more.
   *
   * So an entry that says given back without the payer's word is asked about.
   * The change token is still here under its own hash; the mint knows whether
   * anyone took it. Taken, the entry is marked as confirmed and not asked
   * about again. Not taken, it goes on the payment's entry as a code to show —
   * it is locked to the payer, so showing it costs nobody anything. A week's
   * worth, once per entry per launch, and only with a route. */
  var givenBackAsked = {};
  // the payment whose change was last put on its entry, for a payer that answers late
  var lastStuckHash = '';
  var notHandedAsked = {};

  /* Change that was on its entry as a code and has since been taken: by a
   * payer whose "kept" came after this phone stopped waiting, or by one that
   * scanned the code. The entry stops saying it is owed and the code comes
   * off it — a code for money already taken is a thing to stop showing. */
  function changeWasTaken(hash, how) {
    try {
      amendTx(hash, { changeState: 'given back', changeKept: true });
      FoxyWallet.tag(hash, { token: '', owedChange: false });
    } catch (x) {}
    console.log('[foxy] the change on a payment\u2019s entry has been taken (' + how + '); it is no longer owed');
    if (typeof FoxyWallet._onChangeTaken === 'function') {
      try { FoxyWallet._onChangeTaken(hash); } catch (x) {}
    }
    if (typeof FoxyWallet._onHistoryChanged === 'function') {
      try { FoxyWallet._onHistoryChanged(); } catch (x) {}
    }
  }

  /* Asked of the mint for every entry still showing a code, no more than once
   * every fifteen seconds each: the receiver has no other way to learn that a
   * payer scanned it. A payer collected its change and the receiver went on
   * saying it was owed. */
  function recheckNotHanded(log, meta, nowS) {
    if (!routeOpen()) return;
    log.forEach(function (e) {
      if (!e || e.dir !== 'in' || e.changeState !== 'not handed') return;
      var m = meta[e.hash];
      if (!m || typeof m.token !== 'string' || !m.token) return;
      if (nowS - (notHandedAsked[e.hash] || 0) < 15) return;
      notHandedAsked[e.hash] = nowS;
      var info = null;
      try { info = FoxyWallet.tokenInfo(m.token); } catch (x) { info = null; }
      if (!info || !info.proofs || !info.proofs.length) return;
      var proofs = info.proofs;
      var w;
      try { w = onCircuit(need(), 'change:' + e.hash); } catch (x) { return; }
      w.checkProofsStates(proofs).then(function (states) {
        var spent = states.filter(function (st) {
          return (st && (st.state || st.State)) === 'SPENT';
        }).length;
        if (spent === proofs.length) changeWasTaken(e.hash, 'the mint says so');
      }).catch(function () {});
    });
  }

  function tapChangeKeptLate() {
    if (!lastStuckHash) return;
    var hash = lastStuckHash;
    lastStuckHash = '';
    changeWasTaken(hash, 'the payer said so, late');
  }
  function recheckGivenBack(log, meta, nowS) {
    if (!routeOpen()) return;
    log.forEach(function (e) {
      if (!e || e.dir !== 'in' || !(Number(e.changeSats) > 0)) return;
      if (e.changeState !== 'given back' || e.changeKept) return;
      if (givenBackAsked[e.hash]) return;
      var age = nowS - (Number(e.at) || 0);
      if (age < 60 || age > 7 * 86400) return;
      var hit = Object.keys(meta).filter(function (h) {
        var m = meta[h];
        if (!m || !m.change || typeof m.token !== 'string' || !m.token) return false;
        var when = /^token-(\d{10,})/.exec(h);
        if (!when || Math.abs(Math.floor(Number(when[1]) / 1000) - Number(e.at)) > 120) return false;
        var info = null;
        try { info = FoxyWallet.tokenInfo(m.token); } catch (x) { info = null; }
        return !!info && satsOf(info.amount) === Math.round(Number(e.changeSats));
      })[0];
      if (!hit) return;
      givenBackAsked[e.hash] = true;
      var token = meta[hit].token;
      var info = FoxyWallet.tokenInfo(token);
      if (!info || !info.proofs || !info.proofs.length) return;
      var w;
      try { w = onCircuit(need(), 'change:' + e.hash); } catch (x) { givenBackAsked[e.hash] = false; return; }
      w.checkProofsStates(info.proofs).then(function (states) {
        var spent = states.filter(function (st) {
          return (st && (st.state || st.State)) === 'SPENT';
        }).length;
        if (info && spent === info.proofs.length) {
          amendTx(e.hash, { changeKept: true });
          return;
        }
        console.warn('[foxy] change of ' + e.changeSats + ' sats was written down as given back and the mint says '
          + 'nobody has taken it; it is on its payment\u2019s entry to be shown');
        owedChangeOnEntry(e.hash, token);
        if (typeof FoxyWallet._onHistoryChanged === 'function') {
          try { FoxyWallet._onHistoryChanged(); } catch (x) {}
        }
      }).catch(function () { givenBackAsked[e.hash] = false; });
    });
  }

  /* The payer's side of the same thing: change that never arrived, collected
   * later by scanning the receiver's code.
   *
   * Scanned, it comes in as a payment of its own. The payment it is the rest
   * of still says its change is owed, at its net figure — so the phone that
   * paid 23,606 and got 22,426 back as a separate row would count 1,180 out
   * and 22,426 in. The entry becomes its gross, which is what left, and says
   * the change was collected; the two rows then add up to what happened.
   * Matched by the amount, on the first later receive that nothing else has
   * claimed. */
  /// How far over the sats owed a change token may be: the fee the receiver pads for.
  function changeAllowance(owed) {
    return Math.max(4, Math.ceil((Number(owed) || 0) * 0.02));
  }

  function settleCollectedChange() {
    var log = load(K.log, []);
    var used = {};
    log.forEach(function (e) { if (e && e.changeFrom) used[e.changeFrom] = true; });
    var done = 0;
    log.forEach(function (e) {
      if (!e || e.dir !== 'out' || !(Number(e.changeSats) > 0)) return;
      if (e.changeState !== 'owed' && e.changeState !== 'never came') return;
      var want = Math.round(Number(e.changeSats));
      var near = function (n) { var s = Math.round(Number(n)); return s >= want - changeAllowance(want) && s <= want + changeAllowance(want); };
      /* A code that was scanned or pasted, and no other kind of receive.
       * Change collected later is the receiver's code taken in by hand, which
       * is filed as a token (`token-`) or, offline, as a scan (`req-scan-`).
       * Any later receive near the size used to do: a payment by tap or an
       * invoice of about the same amount was bound as "collected", and the
       * change that was in fact still owed stopped being pointed at. */
      var byCode = function (r) { return /^(token-|req-scan-)/.test(String(r.hash || '')); };
      var got = log.filter(function (r) {
        return r && r.dir === 'in' && r.hash !== e.hash && !used[r.hash] && !r.failed
          && byCode(r) && near(r.sats) && Number(r.at) >= Number(e.at)
          && Number(r.at) - Number(e.at) < 7 * 86400;
      })[0];
      if (!got) return;
      used[got.hash] = true;
      var gross = Number(e.grossSats) || (Number(e.sats) + want);
      amendTx(e.hash, { sats: gross, changeState: 'collected', changeFrom: got.hash });
      console.log('[foxy] the change for a payment was collected later, as a payment of its own: ' + want + ' sats');
      done += 1;
    });
    try { done += dropScannedTwice(); } catch (x) {}
    return done;
  }

  /* Change that came back over the link and was then scanned as well, from
   * before this phone could tell: the payment already says its change came
   * back, and the scan is a second row for the same sats. The duplicate was
   * refused by the mint on the next connection, so the balance is right and
   * the list is one row too long.
   *
   * Known by its pieces, and by nothing else. A scan's entry is named after
   * the pieces it held (`req-scan-` and their fingerprint), and the pieces of
   * change that came back are written down as it is checked (`checkChange`,
   * `changeSeenNote`). This matched by amount, to within the fee allowance,
   * inside a quarter of an hour: a real payment taken by code that happened to
   * be near the size of change that had just come back was written off as
   * that change, and written off again after every claim put it right, since
   * this runs on every reading of history. A scan from before the pieces were
   * written down is left as it is. */
  var CHANGE_SEEN = 'foxy.change.seen';

  function changeSeen() {
    var l = load(CHANGE_SEEN, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r.f === 'string'; }) : [];
  }

  function changeSeenNote(list) {
    var f = piecesFingerprint(list);
    if (!f) return;
    var l = changeSeen().filter(function (r) { return r.f !== f; });
    l.push({ f: f, at: Date.now() });
    // `save`, and a refusal ignored: this is only for tidying a list, and the change itself is kept elsewhere
    save(CHANGE_SEEN, l.slice(-100));
  }

  function dropScannedTwice() {
    var seen = {};
    changeSeen().forEach(function (r) { seen[r.f] = true; });
    if (!Object.keys(seen).length) return 0;
    var log = load(K.log, []);
    var done = 0;
    log.forEach(function (r) {
      if (!r || r.dir !== 'in' || r.state === 'failed') return;
      var m = /^req-scan-(.+)$/.exec(String(r.hash || ''));
      if (!m || !seen[m[1]]) return;
      amendTx(r.hash, { state: 'failed', settled: false, memo: 'the same change, scanned again' });
      console.log('[foxy] a scan of change that had already come back is no longer counted: '
        + Math.round(Number(r.sats) || 0) + ' sats');
      done += 1;
    });
    return done;
  }

  /* ---- a refusal has to cost the payer nothing --------------------------
   *
   * A payment over the link is ecash in the other phone's hands the moment
   * it crosses, and a refusal after that was only a word: the receiver kept
   * a copy and could redeem it once the payer had gone, and a payer that had
   * locked the ecash to the receiver could never take it back at all
   * (MONEY.md §15). Three things hold it now.
   *
   *   Asking first (`askFirst`, `answerIntent`). Before any ecash is made
   *   the payer says what it is about to send, and the receiver checks what
   *   it can check without seeing it: the request is open, the amount, the
   *   mint, and with no route that it will be locked and in a keyset it can
   *   verify. Every honest refusal happens there, with nothing sent.
   *
   *   A refund, not a word (`refundRefused`). A receiver with a route that
   *   still has to refuse ecash it has been handed takes it in and sends
   *   the whole of it back locked to the payer, which uses the payer's
   *   pieces up.
   *
   *   HIGH RISK otherwise (`atRiskAdd`). A refusal with no such refund
   *   inside ten seconds leaves the payer's ecash seen by another phone and
   *   not locked to anybody. It is this phone's still, so it is in the
   *   balance and can be spent — and it is flagged, and swapped for pieces
   *   nobody has seen on the first connection (`settleAtRisk`). */

  /* A refusal after which this phone holds ecash it could give back. */
  function refundable(e) { try { e.foxyRefundable = true; } catch (x) {} return e; }

  /* The receiver's answer to "I am about to pay this": { intent, go, why }.
   * Everything here is known without the ecash. */
  function answerIntent(x) {
    var id = (x && typeof x.id === 'string') ? x.id : '';
    var no = function (why) { return { intent: id, go: false, why: why }; };
    var open = id && Object.prototype.hasOwnProperty.call(openRequests, id) ? openRequests[id] : null;
    if (!open) return no('That request is no longer open here.');
    if (FoxyWallet._requestsBeingPaid && FoxyWallet._requestsBeingPaid[id]) return no('That request is being paid already.');
    var here = String(mintUrl || '').replace(/\/+$/, '');
    var at = typeof x.mint === 'string' ? x.mint.replace(/\/+$/, '') : '';
    if (!at || at !== here || at !== open.mint) {
      return no('This phone takes that payment at ' + hostOf(open.mint || here) + ', not at ' + (hostOf(at) || 'another mint') + '.');
    }
    var sats = Math.round(Number(x.sats) || 0);
    if (open.sats > 0 && sats < open.sats) {
      return no('That payment would be ' + sats + ' sats; the request is for ' + open.sats + '.');
    }
    if (!routeOpen()) {
      // with no route: only ecash locked to this request's own key, still unpaid, in a keyset this phone can check
      if (x.locked !== true) {
        return no('This phone is offline, so it can only take ecash locked to it. Try again when either phone is online.');
      }
      var pub = lockPubFor(id);
      if (!pub) return no('This phone is offline and has no key on file for that request. Show them a new request.');
      if (lockTaken(id)) return no('That request has already been paid on this phone. Show them a new request.');
      if (typeof x.keyset === 'string' && x.keyset && wallet && !keysetFor(wallet, x.keyset)) {
        return no('This phone is offline and cannot check ecash from that keyset. Try again when either phone is online.');
      }
    }
    return { intent: id, go: true };
  }

  /* A refund arriving over the link for a payment that was just refused:
   * { ok, why, short, signed, sats }. It has to be locked to the key this
   * phone made for that very payment, signed by the mint, each piece once,
   * and it is short when it is well under what was paid. */
  function checkRefund(token, reqId, paid) {
    var info = null;
    try { info = FoxyWallet.tokenInfo(token); } catch (e) {}
    var list = (info && info.proofs) || [];
    var sum = list.reduce(function (a, pr) { return a + (satsOf(pr && pr.amount) || 0); }, 0);
    var no = function (why) { return { ok: false, why: why, short: false, signed: false, sats: sum }; };
    if (!info || !list.length) return no('it could not be read');
    if (repeatedProof(list)) return no('it names the same ecash more than once');
    if (info.unit && String(info.unit) !== 'sat') return no('it is not sats');
    var here = wallet ? mintOf(wallet) : '';
    if (!here || canonicalMint(String(info.mint || '')) !== here) return no('it is from another mint');
    var row = lockKeys()['change-' + reqId];
    var pub = row ? lockPubOf(row) : '';
    if (!pub) return no('this phone made no key for that payment');
    if (!list.every(function (pr) { return onlyLockedTo(pr, pub); })) return no('it is not locked to the key this phone made for that payment');
    var want = Math.round(Number(paid) || 0);
    return { ok: true, why: '', signed: mintSigned(wallet, list), sats: sum,
             short: sum < want - Math.max(6, Math.ceil(want / 100)) };
  }

  /* ---- ecash at risk ----------------------------------------------------- */
  function atRiskAll() {
    var o = load(K.atRisk, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }
  /* Each refused payment whose pieces are still in the pile:
   * [{ hash, sats, at, req, mint, why, pieces }]. */
  function atRiskGroups() {
    var all = atRiskAll();
    var out = [];
    Object.keys(all).forEach(function (h) {
      var g = all[h];
      if (!g || !Array.isArray(g.secrets) || !g.mint) return;
      var want = {};
      g.secrets.forEach(function (sec) { want[String(sec)] = true; });
      var mine = proofs(g.mint).filter(function (pr) { return pr && want[pr.secret]; });
      if (!mine.length) return;
      out.push({ hash: h, sats: sumProofs(mine), at: Number(g.at) || 0, req: g.req || '', mint: g.mint,
                 why: g.why || '', pieces: mine });
    });
    return out;
  }
  function atRiskSats() {
    var here = canonicalMint(mintUrl || '');
    return atRiskGroups().reduce(function (n, g) { return n + (canonicalMint(g.mint) === here ? g.sats : 0); }, 0);
  }
  /* A payment the receiver heard and refused, with nothing sent back: its
   * pieces go into the pile again, flagged. Only plain pieces; a token with
   * ecash locked to this phone in it stays on its entry and is taken back
   * whole (`takeBackToken`). Resolves the sats flagged. */
  /** @returns {Promise<any>} */
  function atRiskAdd(made, reqId, why) {
    return withProofs('atRisk', function () {
      var info = FoxyWallet.tokenInfo(made.token);
      var list = usableProofs((info && info.proofs) || []).map(function (pr) {
        var keep = { id: pr.id, amount: satsOf(pr.amount), secret: pr.secret, C: pr.C };
        if (pr.dleq) keep.dleq = pr.dleq;
        return keep;
      });
      if (!list.length || lockedProofs(list).length) return Promise.resolve(0);
      var at = canonicalMint(String((info && info.mint) || mintUrl || ''));
      var all = atRiskAll();
      all[made.hash] = { secrets: list.map(function (pr) { return pr.secret; }), sats: sumProofs(list),
                         at: Date.now(), req: reqId || '', mint: at, why: String(why || '').slice(0, 200) };
      // the flag first, and it must land: unflagged in the pile they would be ordinary money
      mustSave(K.atRisk, all);
      addOwnProofs(list, at, wallet, undefined, true);
      try {
        amendTx(made.hash, { state: 'failed', settled: false, highRisk: true, memo: 'ecash, refused' });
        FoxyWallet.tag(made.hash, { refused: false, atRisk: true });
        /* Its text is no longer a second way to the same pieces — and is
         * not kept to be shown either. `forgetClaimedToken` puts a claimed
         * token's text aside under `kept`, for a payee who says it never
         * came; here nobody was paid and the pieces are in this wallet's
         * pile, so that text would be live ecash offered under SHARE TOKEN
         * with the word CLAIMED over it. */
        FoxyWallet.forgetClaimedToken(made.token);
        FoxyWallet.tag(made.hash, { kept: '' });
      } catch (e) { console.warn('[foxy] a refused payment could not be marked on its entry:', e && e.message); }
      console.warn('[foxy] a payment was refused and nothing was sent back: ' + sumProofs(list)
        + ' sats are in the wallet again, at risk until they are swapped');
      return Promise.resolve(sumProofs(list));
    });
  }
  /* The refund for one came after all (over the link late, or as a code):
   * the receiver made it out of these very pieces, so they are spent. */
  /* `how`: 'change' when the refund was kept as change is (its own row is
   * not counted, so the payment's entry becomes what it cost); 'row' when it
   * was taken in as a payment of its own (its row is counted, so the entry
   * stays the whole payment). */
  /** @returns {Promise<any>} */
  function atRiskRefunded(hash, net, how) {
    return withProofs('atRisk', function () {
      var all = atRiskAll();
      var g = all[hash];
      if (!g) return Promise.resolve(false);
      var gone = {};
      (g.secrets || []).forEach(function (sec) { gone[String(sec)] = true; });
      var pile = proofs(g.mint);
      var keep = pile.filter(function (pr) { return !(pr && gone[pr.secret]); });
      if (keep.length !== pile.length) setProofs(keep, g.mint, wallet);
      delete all[hash];
      save(K.atRisk, all);
      try {
        // the pieces left after all: the entry is a payment again, and the refund is what came of it
        // (and not taken, if the mint had said the pieces were spent before the refund was seen)
        amendTx(hash, { state: 'success', settled: true, highRisk: false, refunded: true, taken: false,
                        memo: 'ecash, refused and returned' });
        if (how === 'change') FoxyWallet.changeSettled(hash, Math.round(Number(net) || 0));
        FoxyWallet.tag(hash, { atRisk: false, refunded: true });
      } catch (e) {}
      console.log('[foxy] the refund for a refused payment arrived; its pieces are no longer counted');
      return Promise.resolve(true);
    });
  }
  /* The at-risk payment a token is the refund of, by the key it is locked
   * to: '' when it is not one. */
  function atRiskRefundOf(token) {
    var info = null;
    try { info = FoxyWallet.tokenInfo(token); } catch (e) {}
    var list = (info && info.proofs) || [];
    if (!list.length) return '';
    var rows = lockKeys();
    var all = atRiskAll(), hit = '';
    Object.keys(all).forEach(function (h) {
      var g = all[h];
      var row = g && g.req ? rows['change-' + g.req] : null;
      var pub = row ? lockPubOf(row) : '';
      if (pub && list.every(function (pr) { return onlyLockedTo(pr, pub); })) hit = h;
    });
    return hit;
  }

  /* How long a payer waits, after hearing no, for its ecash to come back
   * locked to it. A refund is a swap or two at the mint and a message. */
  var REFUND_WAIT_MS = 10000;

  /* Resolves { net, sats, short } when the refund for `made` arrives inside
   * the wait, null when it does not. `_tapChange` is where it arrives. */
  function waitRefund(reqId, made, paid) {
    return new Promise(function (resolve) {
      var done = false;
      /** @type {any} */
      var wait = { req: reqId, hash: made.hash, token: made.token, paid: paid, done: null };
      var t = setTimeout(function () { wait.done(null); }, Number(FoxyWallet._refundWaitMs) || REFUND_WAIT_MS);
      wait.done = function (v) {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (FoxyWallet._refundWait === wait) FoxyWallet._refundWait = null;
        resolve(v);
      };
      FoxyWallet._refundWait = wait;
    });
  }

  /* A token that came back over the link: is it the refund of a refused
   * payment, and if so keep it. True when this dealt with it; false leaves
   * it to the app's own change handler. */
  function refundArrived(text) {
    var wait = FoxyWallet._refundWait;
    var lateHash = wait ? '' : atRiskRefundOf(text);
    if (!wait && !lateHash) return false;
    var late = lateHash ? (atRiskAll()[lateHash] || {}) : null;
    var reqId = wait ? wait.req : late.req;
    var paid = wait ? wait.paid : late.sats;
    var chk = checkRefund(text, reqId, paid);
    if (!chk.ok) {
      // while a refund is being waited for, anything else is refused out loud; otherwise it may be ordinary change
      if (!wait) return false;
      console.warn('[foxy] what came back after the refusal was not taken: ' + chk.why);
      FoxyWallet.tapChangeKept(false).catch(function () {});
      return true;
    }
    var net = FoxyWallet.changeNet(text);
    var hash = wait ? wait.hash : lateHash;
    var kept = function (how) {
      FoxyWallet.tapChangeKept(true).catch(function () {});
      console.log('[foxy] a refused payment came back, locked to this phone: ' + chk.sats + ' sats' + how
        + (chk.short ? ' — less than the ' + paid + ' that was paid' : ''));
      if (wait) {
        try {
          amendTx(hash, { settled: true, state: 'success', refunded: true, memo: 'ecash, refused and returned' });
          FoxyWallet.changeSettled(hash, net);
          FoxyWallet.tag(hash, { refunded: true, refused: false, inflight: false });
          FoxyWallet.forgetClaimedToken(wait.token);
        } catch (x) { console.warn('[foxy] the refund could not be written on its entry:', x && x.message); }
        wait.done({ net: net, sats: chk.sats, short: chk.short });
        return;
      }
      atRiskRefunded(hash, net, 'change').then(function () {
        if (typeof FoxyWallet._onAtRisk === 'function') {
          try { FoxyWallet._onAtRisk({ state: 'refunded', hash: hash, sats: net }); } catch (x) {}
        }
      }, function () {});
    };
    var no = function (why) {
      console.warn('[foxy] the refund could not be kept: ' + why);
      FoxyWallet.tapChangeKept(false).catch(function () {});
    };
    var changeHash = 'tap-change-' + Date.now();
    if (routeOpen()) {
      FoxyWallet.receiveToken(text, { hash: changeHash }).then(function () {
        try { FoxyWallet.tag(changeHash, { change: true }); } catch (x) {}
        kept('');
      }, function (e) {
        // locked to this phone and signed by the mint: kept as it is, and claimed on the next try
        if (!chk.signed) return no('the mint would not swap it and its signatures do not verify');
        try { keepChange(text, chk.sats); kept(', written down to settle later'); } catch (x) { no(String((x && x.message) || x)); }
      });
    } else {
      if (!chk.signed) { no('this phone is offline and cannot check its signatures'); return true; }
      try { keepChange(text, chk.sats); kept(', written down with no route'); } catch (x) { no(String((x && x.message) || x)); }
    }
    return true;
  }

  /* What a refusal over the link becomes, on the phone that paid. Always
   * rejects, with the error marked for the screen:
   *
   *   foxyRefunded { sats, short, paid }   it came back, locked to this phone
   *   foxyAtRisk   { sats, onEntry }       it did not: in the wallet again and
   *                                        flagged, or still on its entry
   *   foxyLockedRefusal                    it was locked to them: only they
   *                                        can take it, and nothing comes back */
  function afterRefusal(req, made, e) {
    var info = null;
    try { info = FoxyWallet.tokenInfo(made.token); } catch (x) {}
    var list = (info && info.proofs) || [];
    var paid = list.reduce(function (a, pr) { return a + (satsOf(pr && pr.amount) || 0); }, 0);
    if (made.lockedTo) {
      try { FoxyWallet.tag(made.hash, { refusedLocked: true }); amendTx(made.hash, { highRisk: true }); } catch (x) {}
      e.foxyLockedRefusal = true;
      return Promise.reject(carryToken(e, made));
    }
    var onEntry = function () {
      try { FoxyWallet.tag(made.hash, { refused: true }); amendTx(made.hash, { highRisk: true }); } catch (x) {}
      e.foxyAtRisk = { sats: paid, onEntry: true };
      return Promise.reject(carryToken(e, made));
    };
    // some of it locked to this phone and signed on: it stays on its entry, and is taken back whole
    if (lockedProofs(list).length) return onEntry();
    var waited = (req && req.viaTap && req.id) ? waitRefund(req.id, made, paid) : Promise.resolve(null);
    return waited.then(function (back) {
      if (back) {
        e.foxyRefunded = { sats: back.net, short: !!back.short, paid: paid };
        throw e;
      }
      return atRiskAdd(made, req && req.id, e && e.message).then(function (sats) {
        if (!(sats > 0)) return onEntry();
        e.foxyAtRisk = { sats: sats, onEntry: false };
        /* With a route there is nothing to wait for: the pieces are swapped
         * now, while the person is still looking at the screen. They were
         * left for "the first connection", and a payer that already had one
         * was told its ecash was at risk until Foxy had a connection, with
         * nothing run until its next. The card says
         * which it turned out to be: `safe`, or `taken` when the phone that
         * said no had already redeemed them. */
        if (!routeOpen() || !FoxyWallet._settleAtRiskOnce) throw e;
        return FoxyWallet._settleAtRiskOnce().then(function (out) {
          (out || []).forEach(function (r) {
            if (!r || r.hash !== made.hash) return;
            if (r.state === 'safe') { e.foxyAtRisk.safe = true; e.foxyAtRisk.sats = r.sats; }
            if (r.state === 'taken') { e.foxyAtRisk.taken = true; e.foxyAtRisk.sats = r.sats; }
          });
        }, function (x) {
          console.warn('[foxy] the refused pieces could not be swapped just now; on the next connection:', x && x.message);
        }).then(function () { throw e; });
      }, function (x) {
        console.warn('[foxy] the refused pieces could not go back in the wallet; they stay on the payment’s entry:', x && x.message);
        return onEntry();
      });
    });
  }

  /* The receiver's half: a payment it has to refuse, sent back.
   *
   * Only where this phone ends up holding good ecash it will not keep — the
   * request it answers is closed, it is short, it names a piece twice — and
   * only with a route, a key from the payer, and plain pieces this mint
   * signed. It is taken in, which is what uses the payer's pieces up, and the
   * whole of it goes back locked to the payer by the road change takes
   * (`carryBack`): over the link, or as a code if the link has gone. A job
   * is written between the two swaps, so a phone killed there sends it back
   * when it is next opened. */
  function refundRefused(body, e) {
    try {
      if (!e || !e.foxyRefundable || !routeOpen() || !wallet) return false;
      var j = parseBody(String(body || ''));
      if (!j || typeof j !== 'object') return false;
      var at = typeof j.mint === 'string' ? canonicalMint(j.mint) : '';
      if (!at || at !== mintOf(wallet)) return false;
      var key = (typeof j.changeTo === 'string' && /^0[23][0-9a-f]{64}$/i.test(j.changeTo)) ? j.changeTo.toLowerCase() : '';
      if (!key) return false;
      var seen = {};
      var list = usableProofs(Array.isArray(j.proofs) ? j.proofs : []).filter(function (pr) {
        if (seen[pr.secret]) return false;
        seen[pr.secret] = true;
        return true;
      });
      if (!list.length || list.length > 500 || lockedProofs(list).length) return false;
      if (dleqAudit(wallet, list).invalid) return false;
      var token = window.CashuTS.getEncodedToken({ mint: at, unit: 'sat', proofs: list });
      var id = typeof j.id === 'string' ? j.id.slice(0, 64) : '';
      var hash = 'req-refused-' + (id || Date.now().toString(36)) + '-' + Date.now().toString(36);
      console.log('[foxy] a payment this phone will not keep is being sent back to the payer, locked to them');
      if (FoxyWallet.tapChangeDue) FoxyWallet.tapChangeDue();
      FoxyWallet.receiveToken(token, { hash: hash, plain: true, memo: 'ecash, refused' }).then(function (r) {
        var job = { id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), kind: 'refusal',
                    home: at, from: at, net: 0, ask: (r && r.sats) || 0, at: Date.now(), state: 'paid',
                    reqId: id, hash: hash, payerKey: key, kept: (r && r.sats) || 0, paidAt: Date.now() };
        putCarryJob(job);
        carryBusy[job.id] = true;
        var free = function () { delete carryBusy[job.id]; };
        var sent = carryBack(job, String((e && e.message) || 'refused'));
        sent.then(free, free);
        return sent;
      }).then(function (out) {
        console.log('[foxy] the refused payment: ' + ((out && out.state) || 'not sent back')
          + (out && out.handed ? ', handed over the link' : out && out.state === 'refunded' ? ', as a code to scan' : ''));
      }, function (x) {
        console.warn('[foxy] a refused payment could not be taken in to send back:', x && x.message);
      });
      return true;
    } catch (x) {
      console.warn('[foxy] the refund of a refused payment could not be started:', x && x.message);
      return false;
    }
  }

  function changeBack(p, over) {
    /* Whatever was set aside for this payment's change stays set aside only
     * while change is really being made: each way out below that makes none
     * lets it go, and this phone is seen to hold what it holds. */
    var stays = function () { changeHoldOver('req-' + p.id); };
    /* No change will be made after all, and the entry was written as if it
     * would be: it says what stays less the change, and this phone holds the
     * lot. Put right here, as the failure to make it already was below. The
     * route had only to drop between the payment landing and this running,
     * which on the path that swaps first is the whole length of the swap, and
     * history said 100 for good over a phone holding 128. Only where the entry
     * is still waiting on that change. */
    var keptTheLot = function () {
      stays();
      try {
        var row = load(K.log, []).filter(function (e) { return e && e.hash === 'req-' + p.id; })[0];
        var waiting = row && Number(row.changeSats) > 0
          && (!row.changeState || row.changeState === 'making');
        if (waiting && FoxyWallet.changeSettled) FoxyWallet.changeSettled('req-' + p.id, 0);
      } catch (eRow) { console.warn('[foxy] the entry could not be put right for change that was not made:', eRow && eRow.message); }
    };
    if (over !== 'tap') { stays(); return; }
    var asked = Number(p.asked);
    var paid = Number(p.sats) || 0;
    if (!(asked > 0) || !(paid > asked)) { stays(); return; }
    /* The same sum `changeOwed` does, fee and all. This one was left at
     * paid less asked, so at a mint that charges a fee every payment from
     * another Foxy "overpaid" by exactly that fee: the entry said no change
     * was owed, this made change anyway out of the receiver's own money, the
     * payer refused it over the link as change nobody owed it, and the
     * receiver put a code up to be scanned for one or two sats — every time. */
    var owed = Math.max(0, paid - asked - (Number(p.inFee) || 0));
    if (!(owed > 0)) { stays(); return; }
    /* Less what it costs to make and to take, which is the payer's
     * (`changeFor`). When that leaves nothing, nothing is made: the payer's
     * phone has done the same sum and is not waiting. */
    var back = changeFromPile(wallet, owed);
    if (!(back > 0)) {
      console.log('[foxy] they paid ' + owed + ' sats over, which is too little to send back at this mint; it stays with the payment');
      keptTheLot();
      return;
    }
    if (!routeOpen()) {
      console.warn('[foxy] they overpaid by ' + owed + ' sats and this phone has no route to make change');
      keptTheLot();
      return;
    }
    /* Locked to the payer, or not sent at all.
     *
     * Unlocked change is a race, and it is the payer who cannot watch it: they
     * overpaid because they have no route, so they have no mint to settle it at
     * either. They could not even take it — `receiveToken` is a swap. Locked to
     * the key they sent, it is theirs alone and waits until they have a route.
     *
     * A payer who sent no key gets no change, and is owed instead. That is a
     * worse outcome for them and a plain one; handing back money neither phone
     * can account for is worse than both. */
    if (!p.changeTo) {
      console.warn('[foxy] they overpaid by ' + owed + ' sats and sent no key to lock change to; they are owed');
      keptTheLot();
      return;
    }
    console.log('[foxy] they overpaid by ' + owed + ' sats; making change locked to them');
    /* Before the swap, not after it. The link's own teardown is two seconds and
     * the mint took three and a half, so the guard that keeps the link alive
     * was being set after the link had gone. */
    if (FoxyWallet.tapChangeDue) FoxyWallet.tapChangeDue();
    /* Timed, because the payer is holding a link open for exactly this and the
     * two clocks have to be compared to know whose fault a miss was. The first
     * one measured took 2,456 ms to make and arrived one second after the payer
     * had let go. */
    var began = Date.now();
    FoxyWallet.sendToken(back, { unit: 'sat', lockTo: p.changeTo, purpose: 'change',
                                 forHash: 'req-' + p.id, owed: owed }).then(function (made) {
      var madeIn = Date.now() - began;
      // let go as the pieces left the pile (`sendToken`); again here costs nothing
      stays();
      console.log('[foxy] change of ' + back + ' sats made in ' + madeIn + ' ms for the ' + owed
        + ' paid over; handing it back');
      /* On the payment it is the rest of, whatever happens next. It is locked
       * to the payer, so this phone cannot spend it — and a payer who says
       * the change never came can be shown it, to scan and take or to be
       * told it was already claimed. */
      try { FoxyWallet.tag('req-' + p.id, { changeToken: String(made.token || '') }); } catch (x) {}
      // what left for it against what was left over: the entry is what stayed
      settleChangeMade('req-' + p.id, owed, { sats: made.sats, fee: made.fee, back: back });
      return FoxyWallet.tapChange(made.token).then(function () {
        console.log('[foxy] change of ' + owed + ' sats handed back over bluetooth, '
          + (Date.now() - began) + ' ms after the payment was answered');
        // said on the entry, so nothing later takes it for change still owed
        // and only now: the bridge answers when the payer says it kept it
        try { amendTx('req-' + p.id, { changeState: 'given back', changeKept: true }); } catch (x) {}
      }, function (e) {
        console.warn('[foxy] change could not be handed over ' + (Date.now() - began)
          + ' ms after the payment was answered, and is on the payment\u2019s own entry: '
          + (e && e.message));
        /* Where somebody can find it. It was "on the token screen", which is
         * one slot that the next token made overwrites and that nothing in
         * history leads to — a person opened the payment it belonged to and
         * there was no token there to show. It is the
         * rest of that payment, so that payment's entry carries it. */
        owedChangeOnEntry('req-' + p.id, made.token);
        lastStuckHash = 'req-' + p.id;
        /* And said, now, while the two of them are still standing there. The
         * payer's phone gives up waiting after thirty seconds and the person
         * walks off owed; the only moment this can be put right face to face
         * is this one. */
        try {
          if (typeof FoxyWallet._onChangeStuck === 'function') {
            FoxyWallet._onChangeStuck({ sats: owed, token: made.token, hash: 'req-' + p.id,
                                        why: String((e && e.message) || ''), paid: paid, asked: asked });
          }
        } catch (x) { console.warn('[foxy] the change card could not be raised:', x && x.message); }
      });
    }, function (e) {
      console.warn('[foxy] change of ' + owed + ' sats could not be made after '
        + (Date.now() - began) + ' ms: ' + (e && e.message));
      /* The entry was written the moment the payment landed, and it recorded
       * the net — what this phone would keep once the change went back. The
       * change could not be made, so this phone kept the lot, and the entry has
       * to say so or history claims it was paid 2 while it holds 4.
       *
       * Only on a failure to MAKE it. A change token that was made and could
       * not be handed over is money that has already left this pile — it is
       * locked to the payer and sitting on the token screen — so the net stands.
       */
      // and what was set aside for it is this phone's after all
      stays();
      if (FoxyWallet.changeSettled) FoxyWallet.changeSettled('req-' + p.id, 0);
    });
  }

  /* ---- both phones offline: the person decides ---------------------------
   *
   * Unlocked ecash taken with no route is not settled and cannot be settled: the
   * payer keeps a copy, and until this phone can swap, nothing here can find out
   * whether they spent it again. That is not a risk software can price. It is a
   * question about the person standing there, so it is asked of the person
   * standing here — once, in front of the amount, before anything is written
   * down.
   *
   * No handler means no. A page that has not registered a card cannot have shown
   * one, and taking somebody's money on a question nobody was asked would be
   * worse than refusing it. So this is also exactly the behaviour Foxy had
   * before the card existed.
   *
   * Bluetooth only, and that is not a policy — it is arithmetic. A lock cannot
   * be made without a swap, so unlocked ecash proves the payer had no route
   * either; a payer with no route can reach no onion and no relay. Anything
   * arriving unlocked over one of those is not an offline payer, and the
   * question does not apply to it.
   *
   * Exact change or nothing. An offline receiver cannot make change — a locked
   * send is a swap — and paying change out of its own pile would mean a payer who
   * double-spends gets their money back AND keeps real change this phone paid
   * for. The loss would be the payment plus the change. Refused before the card,
   * so a person is never asked to trust a payment that could cost them more than
   * it is worth. */
  /* Off, for now.
   *
   * Everything below works and is tested — the card, the refusals that come
   * before it, the trusted row, the red ring, the telling when a payer takes it
   * back. What is not settled is what a person should be able to do afterwards:
   * a payer who has handed money over on trust can still spend it, and Foxy
   * removing its own RECLAIM button does not stop another wallet. That is a
   * design question, not a bug, and until it has an answer an offline phone
   * takes only ecash locked to it — which needs no trust from anybody.
   *
   * Left in place rather than torn out: one constant turns it back on, and the
   * suites still cover both sides of it. */
  var OFFLINE_TO_OFFLINE = false;

  /* Read everywhere, set only by the suites (`FoxyWallet._offlineToOffline`). */
  function offlineToOffline(on) {
    if (on !== undefined) OFFLINE_TO_OFFLINE = !!on;
    return OFFLINE_TO_OFFLINE;
  }

  function offlineOffer(p) {
    if (!offlineToOffline()) return Promise.resolve(false);
    var fn = FoxyWallet._onOfflineOffer;
    if (typeof fn !== 'function') return Promise.resolve(false);
    /* The payer is holding a link open with a clock on it. This tells their
     * phone a person is reading, so their wait stretches and their screen says
     * what it is waiting for rather than looking frozen. */
    if (FoxyWallet.tapAsking) {
      FoxyWallet.tapAsking().catch(function (e) {
        console.warn('[foxy] could not tell the payer a person is deciding:', e && e.message);
      });
    }
    var asked;
    try {
      asked = fn({ sats: p.sats, id: p.id, purpose: p.purpose, memo: p.memo });
    } catch (e) {
      console.error('[foxy] the offline risk card threw, so the payment is refused:', e && e.message);
      return Promise.resolve(false);
    }
    return Promise.resolve(asked).then(
      function (yes) { return yes === true; },
      function (e) {
        console.warn('[foxy] the offline risk card was not answered, so the payment is refused:',
                     e && e.message);
        return false;
      });
  }

  /* Change that arrived while this phone had no route to swap it in.
   *
   * It is locked to a key only this phone holds, so it is safe sitting there: the
   * receiver cannot take it back and nobody else can spend it. Written into the
   * same store a locked payment waits in, so the machinery that claims what is
   * waiting picks it up on its own the moment there is a route (`syncClaim`) —
   * there is no second sweep to write and no second thing to forget.
   *
   * Its own id, because the request's belongs to the payment that came in on it. */
  /* Change coming back over a link, before any of it is believed.
   *
   * It was kept as it arrived: "locked to a key only this phone holds, so it
   * is already ours". Nothing checked that. M7 is the other phone's word, and
   * a receiver — or anything that has done the handshake as one — could send a
   * token of any amount, locked to anybody or nobody, signed by no mint, at
   * any moment, and this phone wrote it into the unclaimed store, counted it
   * in the balance and rewrote what the payment had cost (an audit finding).
   *
   * So, before it is kept: it reads; it is this wallet's mint and sats; change
   * was owed, and this is no more than that; and every piece is locked to a
   * key this phone asked for. `signed` says whether the mint's signature on
   * every piece verifies here (NUT-12) — the caller needs that to keep it
   * without a swap, since a lock says who may spend a proof and nothing about
   * whether it is money (mintSigned). */
  function checkChange(token, owed) {
    var info = null;
    try { info = FoxyWallet.tokenInfo(token); } catch (e) {}
    var list = (info && info.proofs) || [];
    if (!info || !list.length) return { ok: false, why: 'it could not be read', signed: false, sats: 0 };
    // satsOf, not Number: a proof's amount is cashu-ts's own type, and coercing it is what v5 will refuse
    var sum = list.reduce(function (a, pr) { return a + (satsOf(pr && pr.amount) || 0); }, 0);
    var no = function (why) { return { ok: false, why: why, signed: false, sats: sum }; };
    // the same pieces twice would be taken for twice what they are (`repeatedProof`)
    if (repeatedProof(list)) return no('it names the same ecash more than once');
    if (info.unit && String(info.unit) !== 'sat') return no('it is not sats');
    var here = wallet ? mintOf(wallet) : '';
    if (!here || canonicalMint(String(info.mint || '')) !== here) return no('it is from another mint');
    if (!(Number(owed) > 0)) return no('no change was owed');
    /* A little over is the receiver paying this phone's fee. Change made at
     * the payer's mint for a crossing is padded by what the swap in will
     * cost here — 853 for 850 owed — and the exact rule refused it, so the
     * payer let the link go, waited thirty seconds for change that had
     * already come, and was sent to scan a code (seen across
     * mints). Over by more than the fee is still refused. */
    if (sum > Number(owed) + changeAllowance(owed)) return no('it is more than the ' + owed + ' sats owed');
    var rows = lockKeys(), pubs = [];
    Object.keys(rows).forEach(function (id) { var p = lockPubOf(rows[id]); if (p) pubs.push(p); });
    var locked = list.every(function (pr) {
      return pubs.some(function (pub) { return onlyLockedTo(pr, pub); });
    });
    if (!locked) return no('it is not locked to a key this phone asked for');
    // its pieces, so a later scan of the same change is known for what it is (`dropScannedTwice`)
    try { changeSeenNote(list); } catch (eSeen) {}
    return { ok: true, why: '', signed: mintSigned(wallet, list), sats: sum };
  }

  function keepChange(token, sats, forId) {
    // already here, by another road: kept is kept, and it is not kept twice
    var had = heldAlready(token);
    if (had) {
      console.log('[foxy] that change is already on this phone; not kept a second time');
      return had;
    }
    var id = 'change-' + (forId || String(Date.now()));
    keepUnclaimed(id, token, sats);
    console.log('[foxy] change kept for later: ' + sats + ' sats, locked to this phone');
    return id;
  }

  function dropUnclaimed(id) {
    var all = unclaimed();
    if (!(id in all)) return;
    delete all[id];
    if (!save(UNCLAIMED, all)) {
      console.warn('[foxy] the claimed payment could not be struck off the unclaimed list;'
        + ' it is counted twice until a write lands');
    }
  }

  /* The phone derives no public key past this index, and a walk asks for them in
   * batches of this size (Foxy/Keychain/P2PK.swift: lastScanned, mostScanned). */
  var LOCK_SCAN_TO = 20000;
  var LOCK_SCAN_STEP = 300;

  /* The key for a lock, found by the lock itself rather than by request id.
   *
   * A token that was handed over and then lost — the app closed before it was
   * claimed, a delivery that went nowhere — can be pasted in later, and by then
   * nobody knows which request it belonged to. The locks this phone asked for
   * are all in the store, so the one that matches is the one to use; and when
   * the store itself is gone, the seed still knows them.
   *
   * Resolves with the private key in hex, or '' for a clean no — a lock this
   * wallet's seed does not derive and no row names. `receiveToken` turns '' into
   * the refusal it always gave.
   *
   * It REJECTS when the phone could not answer. Those are different things and
   * the difference is a statement about somebody's money: "that token is locked
   * to someone else's key" is a hard, final thing to tell a person, and a
   * keychain that did not answer is no evidence for it at all. A rejection
   * carries its own words out through `receiveToken`, the payment stays on the
   * unclaimed list, and the next connect tries again. */
  function lockKeyMatching(pubkey, derive) {
    var want = String(pubkey || '').toLowerCase();
    if (!/^0[23][0-9a-f]{64}$/.test(want)) return Promise.resolve('');
    var all = lockKeys(), ids = Object.keys(all), named = '';
    for (var i = 0; i < ids.length && !named; i++) {
      var one = all[ids[i]];
      // a row from before: the key itself, compared the way it always was
      if (one && typeof one.key === 'string') {
        try { if (derive(one.key) === want) return Promise.resolve(one.key); } catch (e) {}
        continue;
      }
      if (lockPubOf(one) === want) named = ids[i];
    }
    /* A row names it: one request to the phone, and the walk below is not run.
     * If that index does not open it — the phone refused, the seed was replaced,
     * the row is malformed — the walk still runs, because a token in hand is
     * worth the slow road. A row resolving '' counts as "did not open it": only
     * a rejection used to fall through here, so the one row shape that resolves
     * empty sent a recoverable token away (found in review). */
    if (named) {
      return lockPrivkey(named).then(function (key) {
        return key || walkForLock(want);
      }, function (e) {
        console.warn('[foxy] the index this request kept did not open its lock (' + ((e && e.message) || e)
          + '); walking the seed for it instead');
        return walkForLock(want);
      });
    }
    return walkForLock(want);
  }

  function walkForLock(want) {
    /* No row names it — so walk the path.
     *
     * This is the case the derived key was written for. A restore on a new
     * phone has the twelve words and nothing else: the rows that knew which
     * index each request used were in the old phone's page storage and are
     * gone. The lock the token carries is the only thing left to go on, and
     * the phone can derive every public key on the path and say which index
     * matches. The private half then comes back for that index alone.
     *
     * It is a linear walk and it is not free: at 300 to a batch, a token whose
     * lock is not ours at all costs 67 round trips before it is refused. That
     * is the price of the refusal, not of a payment — a locked token that is
     * ours matches in the first batch or two, because indices start at 0 and
     * count up — and it is only ever paid for a token that carries a lock, so
     * an ordinary paste never touches it.
     *
     * The phone stops at 20,000. A wallet that has asked for twenty thousand
     * payment requests is not the wallet this was written for, and an unbounded
     * walk is an unbounded wait in front of somebody holding a token.
     *
     * A walk that could not finish throws, and does not answer ''. Both used to
     * come back the same way, so a phone that failed on the third batch of
     * sixty-seven told the person their money was somebody else's — with
     * sixty-four batches never looked at (found in review). */
    var found = '';
    var at = 0;
    function stopped(e) {
      var why = (e && e.message) || String(e);
      console.warn('[foxy] the phone stopped walking the lock keys:', why);
      throw new Error('This phone could not check whether that token is yours (' + why + '). Nothing was taken.');
    }
    function walk() {
      if (found || at >= LOCK_SCAN_TO) return Promise.resolve(found);
      var start = at, count = Math.min(LOCK_SCAN_STEP, LOCK_SCAN_TO - at);
      at += count;
      return nativeJson('p2pkPubkeys', { start: start, count: count }, 60000).then(function (j) {
        var keys = (j && j.pubkeys) || [];
        if (!Array.isArray(keys) || keys.length !== count) {
          return stopped(new Error('the phone’s lock keys were not for what was asked'));
        }
        for (var k = 0; k < keys.length; k++) {
          if (String(keys[k]).toLowerCase() !== want) continue;
          var index = start + k;
          console.log('[foxy] this token’s lock is this wallet’s own key, at index', index,
                      '— found by walking the seed, with no record of the request it belonged to');
          /* Its own rejection handler: a throw inside this one does not reach
           * the one on the batch below it, so without this it escaped the walk
           * and `receiveToken` rejected with the bridge's own words. */
          return nativeJson('p2pkKey', { index: index }, 60000).then(function (got) {
            var priv = String((got && got.privkey) || '');
            if (!/^[0-9a-f]{64}$/i.test(priv) || String((got && got.pubkey) || '').toLowerCase() !== want) {
              return stopped(new Error('the answer for index ' + index + ' was not that lock’s key'));
            }
            found = priv.toLowerCase();
            return found;
          }, stopped);
        }
        return walk();
      }, stopped);
    }
    return walk();
  }

  // `save`, for the reason dropUnclaimed gives: the money is already in.
  function dropLockKey(id) {
    var all = lockKeys();
    if (!(id in all)) return;
    delete all[id];
    save(LOCK_KEYS, all);
  }

  /* The request a lock belongs to, if it is one this phone still has open:
   * the id of its row, or ''.
   *
   * A key can always be found again by walking the seed (`walkForLock`), and
   * online that is all a claim needs — the mint says whether the ecash is
   * still good. Offline nobody says, and "this phone can open the lock" is
   * not "this phone has not been paid this already": a locked token can be
   * spent by nobody but this phone, which means the one phone that may
   * already have spent it is this one. A payer paid by tap, the receiver
   * swapped it in, and later — the receiver now offline — the same token
   * shown as a code was taken again and PAYMENT RECEIVED raised for ecash
   * that was already in the pile and already gone from the mint
   * (tools/live/offline-cross-scenarios.js `replay-claimed`).
   *
   * A row is written when a request is made and goes when it is paid. So a
   * row still here is a request not yet paid, and that — not the key — is
   * what an offline phone can take a locked payment on. */
  function lockRowFor(pub) {
    var want = String(pub || '').toLowerCase();
    if (!/^0[23][0-9a-f]{64}$/.test(want)) return '';
    var all = lockKeys(), ids = Object.keys(all);
    for (var i = 0; i < ids.length; i++) {
      if (lockPubOf(all[ids[i]]) === want) return ids[i];
    }
    return '';
  }
  /* Taken offline, on this row: a second payment to the same request is not
   * taken on it. The row stays, because the claim still wants its key. */
  function markLockTaken(id, what) {
    var all = lockKeys();
    if (!id || !all[id]) return;
    all[id].taken = String(what || '1');
    mustSave(LOCK_KEYS, all);
  }
  function lockTaken(id) {
    var one = lockKeys()[id];
    return (one && typeof one.taken === 'string') ? one.taken : '';
  }
  /* Paid, by whatever road: every row for these keys goes. `dropLockKey`
   * needs the request's id, and a token scanned in has none — its row was
   * left behind, and with it the right to take the same ecash again. */
  function dropLockKeysByPub(pubs) {
    var want = {};
    (pubs || []).forEach(function (k) { if (k) want[String(k).toLowerCase()] = true; });
    if (!Object.keys(want).length) return 0;
    var all = lockKeys(), ids = Object.keys(all), gone = 0;
    ids.forEach(function (id) {
      if (want[lockPubOf(all[id])]) { delete all[id]; gone += 1; }
    });
    if (gone) save(LOCK_KEYS, all);
    return gone;
  }
  function lockPubsOf(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (pr) {
      var k = String(lockedTo(pr) || '').toLowerCase();
      if (k && !seen[k]) { seen[k] = true; out.push(k); }
    });
    return out;
  }

  function noteOpenRequest(id, sats, mint, purpose) {
    var now = Date.now();
    Object.keys(openRequests).forEach(function (k) {
      if (now - openRequests[k].at > OPEN_REQUEST_MS) delete openRequests[k];
    });
    openRequests[id] = { sats: sats, mint: mint, at: now, purpose: purpose || 'receive' };
    saveOpenRequests();
  }

  /* The two rules every hand-over of ecash has to satisfy, in one place.
   *
   * They were true before this and enforced in three different functions, which
   * is how you end up with a fourth path that satisfies none of them. Written
   * down as one predicate, they can be argued about and tested:
   *
   *   NOTHING GETS STUCK. Whichever party has no route must end up holding
   *   ecash it can still do something with on its own — at a mint it uses, in a
   *   form its own twelve words reconstruct. A phone with no route cannot swap,
   *   cannot melt and cannot move mints, so ecash at somebody else's mint in
   *   its hands is money it can only watch.
   *
   *   NOBODY CAN DOUBLE SPEND, so long as one of the two is online. There are
   *   exactly two ways to get that. The payer has a route, in which case it
   *   swaps into proofs locked to the receiver and the copy it keeps is worth
   *   nothing to it. Or the receiver has a route, in which case it swaps the
   *   moment the ecash lands and the payer's copy is dead within the second.
   *   Neither with a route is neither of those, and it is the case this refuses.
   *
   *   AND IF EITHER IS UNSATISFIED, NOTHING MOVES. Not "moves and is refused at
   *   the far end" — the refusal happens before a proof is touched, because a
   *   swap that need not have happened is counters spent, a pile re-split, and
   *   a token in somebody's hand that has to be got rid of again.
   *
   * `receiverHasRoute` is what the request itself says: a receiver with a route
   * names somewhere to be paid — an onion address, a relay — and one without
   * can name neither. It is the payer's best knowledge and it is the right
   * knowledge, because that field is written by the receiver about itself.
   *
   * Answers `''` when the hand-over is sound, and the reason when it is not.
   */
  function handoverRefusal(o) {
    var payer = !!(o && o.payerHasRoute);
    /* Tri-state. `null` is "they did not say", which is an older Foxy or a
     * request that was scanned rather than tapped — and it is not "no". Guessed
     * from whether the request named an onion address, it read every online
     * receiver whose Tor had not published yet as an offline one, and refused
     * payments that would have settled in a second (tests/change-leg.js).
     * Unknown falls back to what Foxy did before this rule was written down:
     * make the payment and let the receiver, which knows, refuse it. */
    var receiver = (o && o.receiverHasRoute === null) ? null : !!(o && o.receiverHasRoute);
    var locked = !!(o && o.locked);
    var theirMint = !!(o && o.atTheirMint);

    /* Nothing to check against. The receiver knows its own state and is the one
     * that answers; this phone refusing on a silence would refuse every tap
     * from a build older than this field. */
    if (receiver === null) return '';

    /* RULE ONE — NOTHING GETS STUCK. Checked first and excused by nothing.
     *
     * A phone with no route cannot swap, cannot melt and cannot move mints, so
     * ecash from a mint it does not use is money it can only look at. There is
     * no arrangement between the two phones that makes that all right and no
     * switch that should be able to turn it off, which is why it is above the
     * one that has a switch rather than beside it. */
    if (receiver === false && !theirMint) {
      return 'They are offline and this ecash is not from their mint, so they could not '
        + 'do anything with it. Nothing was sent.';
    }

    /* RULE TWO — ONE OF THE TWO MUST BE ONLINE. No exceptions.
     *
     * The receiver has a route: it swaps the instant the ecash lands, and the
     * payer's copy is dead within the second. Or the payer has one: it swaps
     * into proofs locked to the receiver, and the copy it keeps is worthless
     * to it. Nobody online is neither of those.
     *
     * There is a third shape that survives the arithmetic — ecash locked to the
     * receiver, at the receiver's own mint, handed over with neither phone able
     * to reach anything. It takes a payer that swapped while it had a route and
     * lost it before delivering, and it is genuinely safe: the payer cannot
     * spend what it is holding. It is not allowed, because it is a scheme
     * nobody would set out to use and every case a wallet allows is a case it
     * has to keep right for ever. The rule that is easy to
     * say is the rule that is easy to hold: one of you must be online.
     *
     * The single exception has a switch and the switch is off as Foxy ships.
     * What it buys is a person accepting the risk knowingly (HIGH RISK,
     * `offlineOffer`); the receiver is the one who carries it, so the receiver
     * is the one asked. */
    if (receiver === true) return '';           // they settle it themselves
    if (!payer) {
      if (offlineToOffline()) return '';
      return 'You are both offline, so nothing here could settle this payment. '
        + 'One of you needs a connection.';
    }
    /* The payer has a route and the receiver does not, so this phone is the one
     * that has to make the payment safe, and a lock is how. */
    if (locked) return '';
    return 'They are offline, so ecash anyone could spend is not safe to hand them. '
      + 'Nothing was sent.';
  }

  /* An error the payer is told, with the HTTP status that goes with it. */
  function paymentRefused(status, text) {
    var e = /** @type {any} */ (new Error(text));
    e.foxyStatus = status;
    return e;
  }

  /* The payment a payer posted, read and checked against the request it
   * answers, or a throw with foxyStatus. `here` is the mint this wallet is on.
   * Nothing here touches the mint. */
  function readPayment(body, here) {
    var j = null;
    try { j = parseBody(String(body || '')); } catch (e) {}
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw paymentRefused(400, 'That is not a payment.');
    var id = typeof j.id === 'string' ? j.id : '';
    var open = id && Object.prototype.hasOwnProperty.call(openRequests, id) ? openRequests[id] : null;
    if (!open) throw refundable(paymentRefused(422, 'That payment answers no request open here.'));
    var mint = typeof j.mint === 'string' ? j.mint.replace(/\/+$/, '') : '';
    if (!mint || mint !== open.mint || mint !== String(here || '').replace(/\/+$/, '')) {
      throw paymentRefused(422, 'That payment is not at the mint the request named.');
    }
    if ((j.unit || 'sat') !== 'sat') throw paymentRefused(422, 'That payment is not in sats.');
    var proofs = Array.isArray(j.proofs) ? j.proofs : [];
    if (!proofs.length || proofs.length > 500) throw paymentRefused(422, 'That payment holds no usable proofs.');
    // each piece once, or the sum below counts ecash that is not there (`repeatedProof`)
    if (repeatedProof(proofs)) throw refundable(paymentRefused(422, 'That payment names the same ecash more than once.'));
    var sats = 0;
    for (var i = 0; i < proofs.length; i++) {
      var p = proofs[i];
      var amount = p && typeof p === 'object' ? Number(String(p.amount)) : NaN;
      if (!(amount > 0) || !isFinite(amount) || typeof p.secret !== 'string' || typeof p.C !== 'string' ||
          typeof p.id !== 'string') {
        throw paymentRefused(422, 'That payment holds a proof Foxy cannot read.');
      }
      sats += amount;
    }
    /* Net of what the mint keeps when these pieces are swapped in (NUT-18:
     * sum(proofs) minus the input fee must cover the amount). It was the gross
     * sum, so at a mint that charges per piece a payment could add up to the
     * amount and land short of it (an audit finding). Foxy's own payer covers
     * the fee; this is for payments from other wallets. */
    var inFee = 0;
    try { inFee = wallet ? swapFeeFor(wallet, proofs) : 0; } catch (e) { inFee = 0; }
    if (open.sats > 0 && sats - inFee < open.sats) {
      throw refundable(paymentRefused(422, 'That payment is ' + sats + ' sats'
        + (inFee > 0 ? ', ' + (sats - inFee) + ' after this mint\u2019s fee' : '')
        + '; the request was for ' + open.sats + '.'));
    }
    /* A key the payer wants change locked to, if they sent one. Checked for shape
     * here and nowhere else: a malformed one would be discovered at the mint with
     * the change already swapped, which is money made and lost in one step. */
    var changeTo = typeof j.changeTo === 'string' && /^0[23][0-9a-f]{64}$/i.test(j.changeTo)
      ? j.changeTo.toLowerCase() : '';
    return { id: id, mint: mint, proofs: proofs, sats: sats, inFee: inFee, purpose: open.purpose, asked: open.sats,
             changeTo: changeTo,
             /* The payer saying they over-paid on purpose and expect nothing
              * back. Only ever widens what is accepted — an over-payment
              * without it is refused exactly as it was. */
             overpaid: j.overpaid === true,
             memo: typeof j.memo === 'string' ? j.memo.slice(0, 200) : '' };
  }

  /* How the payer's wallet can deliver to a request, best first: 'onion' for
   * a POST to an onion address, 'nostr' for a NIP-17 message; null for none
   * Foxy speaks, when the token is shown instead. */
  function deliveryFor(transports) {
    var list = Array.isArray(transports) ? transports : [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i] || {};
      if (t.type === 'post' && typeof t.target === 'string' && /^http:\/\/[a-z2-7]{55}d\.onion\/[0-9a-f]{16,64}$/.test(t.target)) {
        return { kind: 'onion', target: t.target };
      }
    }
    for (var k = 0; k < list.length; k++) {
      var n = list[k] || {};
      var tags = Array.isArray(n.tags) ? n.tags : [];
      var nip17 = tags.some(function (g) { return Array.isArray(g) && g[0] === 'n' && g.indexOf('17') > 0; });
      if (n.type === 'nostr' && typeof n.target === 'string' && /^nprofile1[02-9ac-hj-np-z]+$/.test(n.target) && nip17) {
        return { kind: 'nostr', target: n.target };
      }
    }
    return null;
  }

  /* An error that carries the token made for a payment it could not deliver,
   * for the token screen to show instead. */
  /** @param {any} e @param {any} made */
  function carryToken(e, made) {
    e.foxyToken = made;
    return e;
  }

  /* A payment posted to an onion address, through Tor (OnionPost.swift).
   *
   * An address made a moment ago is not found at first: Tor publishes it over
   * the next half minute or so. So "could not be reached" is tried again.
   *
   * The receiver hands out an address published well before they showed it
   * (warmSpare, FoxyBridge+Delivery.swift), so most payments now reach one
   * first time. The retry is for the rest, and it is 1.5s rather than 4s: a
   * lookup that fails takes its own time, and waiting four more seconds on top
   * only added to it. Faster than this is not worth it — Tor holds on to a
   * failed lookup for a moment, so asking again immediately gets the same
   * answer back without troubling the directory. Nothing else is: once a payment has
   * been sent, a second copy is not, and a payment whose answer was lost is
   * left to the token's own claim watch, which sees it redeemed.
   *
   * The budget bounds the attempt, not only the gap between attempts.
   *
   * It was 90 s and was read only *between* tries, so one attempt was bounded
   * by nothing the page knew about: `OnionPost.send`'s own default of 120 s,
   * which is also Tor's `SocksTimeout`. In testing a tap that fell back to
   * the onion took 120893 ms and then 130714 ms — one ceiling, then two.
   * Now the remaining budget goes to the phone as the ceiling for that one
   * attempt, and the bridge is given it plus a little slack.
   *
   * 30 s, down from 90. A live rendezvous between two Foxys measured about
   * three seconds. A minute and a half was chosen for an address
   * that might not be published yet; the receiver's is warm before it is shown,
   * so what is left to wait for is a few lookups, and something that has not
   * answered in thirty seconds is not going to. The money is never lost either
   * way — the token is made first and the payer keeps it. */
  var ONION_REACH_MS = 30000;
  var ONION_RETRY_MS = 1500;
  var ONION_SLACK_MS = 5000;

  function deliverToOnion(target, body) {
    var started = Date.now();
    function attempt() {
      var left = Math.max(ONION_REACH_MS - (Date.now() - started), 3000);
      return bridgeAsk('onionPost', { url: target, body: body, timeout: left },
                       left + ONION_SLACK_MS).then(function (text) {
        var s = String(text || '');
        var nl = s.indexOf('\n');
        var code = Number(s.slice(0, nl)) || 0;
        if (code === 200) return true;
        var said = '';
        try { said = String((JSON.parse(s.slice(nl + 1)) || {}).error || ''); } catch (e) {}
        if (code === 404 || code === 410) throw new Error('That request is no longer open on their phone.');
        throw new Error(said ? 'Their wallet did not take the payment: ' + said.slice(0, 200)
          : 'Their wallet did not take the payment (' + code + ').');
      }, function (e) {
        console.warn('[foxy] delivering to their onion address:', (e && e.message) || e);
        if (/could not be reached/.test(String(e && e.message)) && Date.now() - started + ONION_RETRY_MS < ONION_REACH_MS) {
          return new Promise(function (r) { setTimeout(r, ONION_RETRY_MS); }).then(attempt);
        }
        throw e;
      });
    }
    return attempt();
  }

  /* A payment handed to the relays the request names, as a NIP-17 private
   * message (Foxy/Nostr). The phone does the wrapping and the sending; the page
   * only says what to send and to whom. One relay taking it is enough — the
   * receiver reads from all of theirs. */
  function deliverOverNostr(target, body) {
    return bridgeAsk('nostrSend', { target: target, body: body }, 40000).then(function (count) {
      console.log('[foxy] the payment reached', String(count), 'relay(s)');
      return true;
    });
  }

