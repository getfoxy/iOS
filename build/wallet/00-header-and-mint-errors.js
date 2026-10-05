/* foxy-wallet.js — ecash edition
 *
 * Same public surface as the LNbits version, so the screens and the patcher
 * do not change: connect / balanceSats / invoice / watch / pay / payLnurl /
 * transactions / rate / classify / amountOf / qr / book / tag / share / scan.
 *
 * Load order:
 *   <script src="qrcode.js"></script>
 *   <script src="cashu-ts.js"></script>          defines window.CashuTS
 *   <script src="foxy-wallet.js"></script>      this file, renamed
 *
 * WHAT IS DIFFERENT, AND IT MATTERS
 *
 * There is no account. Your balance is a pile of ecash proofs in localStorage
 * on this device, and no server holds a copy. The backup is the seed, the
 * twelve words: with the mint's records they rebuild every proof derived from
 * them (imported proofs are not). exportProofs() is a copy of the proofs held
 * now, not a backup.
 *
 * Receiving takes two steps. The mint issues a quote and an invoice; once the
 * invoice is paid, this wallet has to claim the proofs. The mint cannot do it
 * alone — the blinding secrets live here — so an unclaimed quote sits at the
 * mint until the app comes back. sweepQuotes() handles that on connect and on
 * resume, but a quote that expires first may be lost.
 *
 * The mint is custodian. Keep the balance small.
 */
(function () {
  'use strict';

  /* Storage versions.
   *
   * `foxy.schema` is how many of the steps below this device's storage has
   * been through. They run in order, before anything else touches storage,
   * and the number moves past a step only once it has finished — so a launch
   * that dies halfway runs the rest next time. Each step is also idempotent.
   * A shipped step is never edited: a change to storage is a new step at the
   * end.
   *
   * Storage from a newer Foxy — a number higher than this build has steps —
   * is left as it is. Nothing is migrated, the wallet's writes are refused and
   * no mint is contacted (assertRoute), so an older build installed over a
   * newer one cannot rewrite data in a shape it does not understand.
   *
   * Three moves are not steps, because they need what storage alone does not
   * have at launch. All are idempotent:
   *   the single proof pile moves under the first mint that connects
   *     (migrateProofs, which needs that mint's address)
   *   words an older install kept in localStorage go to the phone once it
   *     answers (migrateWordsOnce), and so do its counters (importCountersOnce)
   */
  var SCHEMA_KEY = 'foxy.schema';
  var SCHEMA_STEPS = [
    /* 1. flash.* -> foxy.*
     *
     * Every key was named after the app this was forked from. Renaming them
     * without moving the values would hide the seed and the proofs rather than
     * delete them: the app would find nothing, start empty, and the money would
     * sit in localStorage under names nothing reads. A value already under the
     * new name is kept. */
    function renameFlashKeys() {
      var old = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('flash.') === 0) old.push(k);
      }
      old.forEach(function (k) {
        var to = 'foxy.' + k.slice(6);
        if (localStorage.getItem(to) === null) {
          localStorage.setItem(to, /** @type {string} */ (localStorage.getItem(k)));   // k was just listed
        }
        localStorage.removeItem(k);
      });
      if (old.length) console.log('[foxy] moved', old.length, 'keys from flash.* to foxy.*');
    },
    /* 2. The removed P2PK scheme's refund-key counter, left on older installs. */
    function dropP2pkRefundCounter() {
      localStorage.removeItem('foxy.p2pk.refundn');
    },
  ];
  var SCHEMA = SCHEMA_STEPS.length;
  var storageNewer = false;
  var STORAGE_NEWER = 'This wallet was last used by a newer version of Foxy. ' +
    'Update Foxy to use it; this version will not change it.';

  (function migrateStorage() {
    try {
      var at = parseInt(localStorage.getItem(SCHEMA_KEY) || '0', 10) || 0;
      if (at > SCHEMA) {
        storageNewer = true;
        console.warn('[foxy] storage is at version', at, 'and this build knows', SCHEMA,
                     '— leaving it untouched and refusing writes');
        return;
      }
      for (var v = at; v < SCHEMA; v++) {
        SCHEMA_STEPS[v]();
        localStorage.setItem(SCHEMA_KEY, String(v + 1));
      }
    } catch (e) {
      console.warn('[foxy] storage migration failed; the rest runs next launch:', e);
    }
  }());

  var K = {
    mint: 'foxy.cashu.mint',
    proofs: 'foxy.cashu.proofs',
    quotes: 'foxy.cashu.quotes',     // issued but not yet claimed
    log: 'foxy.cashu.log',           // local history; a mint keeps none
    move: 'foxy.cashu.move',         // transfers between mints, mid-flight: a list
    carry: 'foxy.cashu.carry',       // payments taken at a payer's mint, to be brought home
    atRisk: 'foxy.cashu.atrisk',     // ecash another phone has seen and refused: in the pile, flagged, until swapped
    taken: 'foxy.cashu.taken',       // fingerprints of ecash this phone has swapped in, to say so when it is offered again
    mints: 'foxy.cashu.mints',       // every mint this device has connected to
    mintsUsed: 'foxy.cashu.mints.used', // the same, never pruned: a switch back to one is not scanned
    mintNodes: 'foxy.cashu.mint.nodes', // each mint's Lightning node, from invoices it made
    tokenWatch: 'foxy.cashu.token.watch', // tokens being watched until redeemed: Ys, amount, mint
    outtok: 'foxy.cashu.outtoken',   // a token made but not yet handed over
    backed: 'foxy.backed.up',        // the seed has been written down and verified
    split: 'foxy.split.pending',     // a bill being collected, across launches
    melting: 'foxy.cashu.melting',   // proofs handed to a melt that is still routing
    quarantine: 'foxy.cashu.quarantine',  // proofs the mint called spent that cannot be re-derived
    quotesOld: 'foxy.cashu.quotes.old',   // unpaid invoices past the list's cap, still swept
    imported: 'foxy.cashu.imported',      // secrets that arrived from elsewhere, so a restore cannot rebuild them
    audit: 'foxy.cashu.audit',            // what each payment consumed and produced, for working out what went wrong
    swaps: 'foxy.cashu.swaps',            // output counter ranges of swaps whose answer has not arrived
    held: 'foxy.cashu.held',
    topUpFees: 'foxy.cashu.topupfees',    // per mint, the input fees its top-up swaps have cost              // the inputs of those swaps, out of the pile until the mint says
    onchain: 'foxy.cashu.onchain',        // addresses to be paid into this wallet (NUT-30), and what has been issued
    onchainOut: 'foxy.cashu.onchain.out', // payments handed to the mint to broadcast, until they confirm
    reserves: 'foxy.cashu.reserves',      // what each mint held back as a routing reserve last time
    mintCache: 'foxy.cashu.mint.cache',   // each mint's keysets and info, so a phone with no route can still hold a wallet
    rate: 'foxy.price.last',              // the last bitcoin price this phone was told, and when
  };

  /* On chain (16a-onchain.js).
   *
   * The floor is Foxy's own as well as the mint's: below the mint's
   * `min_amount` a payment does not count towards the quote and cannot be got
   * back (NUT-30), and a mint that advertises a wrong figure — one advertising
   * 1 sat, under Bitcoin's own dust limit, has been seen in the wild — would
   * otherwise send someone's money nowhere. The watch window is Foxy's too:
   * this mint gives its addresses no expiry, so something has to bound them.
   */
  var ONCHAIN_OWN_FLOOR = 10000;
  var ONCHAIN_WATCH_DAYS = 7;

  /* Claims in flight, by quote id: everything that asks about the same invoice
   * at the same moment shares one answer (FoxyWallet.claim). */
  var claiming = {};

  /* How many times a paid quote is claimed automatically before Foxy stops
   * and leaves it to the person (noteClaimTrouble, `gaveUp`). */
  var CLAIM_TRIES_MAX = 10;

  /* The refusals that mean nothing left the phone.
   *
   * Every one of these is thrown or returned before a request is sent:
   * Route.refusal (Foxy/Network/Route.swift) when the native side has no
   * route, and assertRoute's two when the page knows there is none. Smoke
   * check 30d holds the first in step with the Swift.
   *
   * They matter because CLAIM_TRIES_MAX counts failures, and it counts them to
   * bound the counter ranges a mint is asked to sign and never does — a long
   * enough run of those hides later ecash from a restore. A claim that was
   * never sent reserved nothing and bought none of that harm, and ten of them
   * across badly-timed wakes would file a PAID invoice as given up and stop
   * asking for money sitting at the mint.
   *
   * Listed rather than guessed at, and the default is to count: an
   * unrecognised failure spends a try exactly as it always has. Getting this
   * list wrong can only be as bad as the behaviour before it. */
  /* Working offline, in the person's words rather than Tor's.
   *
   * Every refusal in offline mode used to say "Foxy is still connecting to Tor",
   * which is both wrong and unhelpful: nothing is connecting, because they asked
   * it not to. Named once here so the list below and `assertRoute` cannot drift
   * apart — a refusal missing from this list spends a NUT-13 counter and one of
   * the receive screen's three tries on a request that never left. */
  var OFFLINE_REFUSAL = 'Foxy is working offline. This needs a connection \u2014 tap OFFLINE to reconnect.';

  var NEVER_SENT = [
    'Foxy is not connected to Tor.',
    'Tor is reconnecting. Try again in a moment.',
    'Foxy is still connecting to Tor.',
    OFFLINE_REFUSAL,
  ];

  /* True only when this failure is known to have asked the mint nothing. */
  function neverSent(e) {
    if (!e || typeof e !== 'object') return false;
    if (e.noCounters) return true;                // tagged where it was thrown
    return NEVER_SENT.indexOf(String(e.message || '')) >= 0;
  }

  /* Quotes claimed a moment ago, by id, with when.
   *
   * A successful claim deletes its record, and the next thing to ask about that
   * quote then finds nothing on file and says "that invoice is not on this
   * device — restoring from your twelve words will find it". The money is
   * already in the balance; the sentence is frightening and wrong. `claim`
   * shares an answer between callers arriving at the same moment, but not
   * between one that has finished and one that starts just after — the split
   * reconcile asking about a row the screen's watcher has just collected, which
   * is what a phone showed twice in testing.
   *
   * Two minutes is long enough for any watcher or sweep still in flight, and
   * short enough that a quote genuinely gone reports itself honestly. */
  var CLAIMED_JUST_NOW_MS = 120000;
  var claimedJustNow = {};

  function noteClaimed(quoteId, sats) {
    claimedJustNow[quoteId] = { at: Date.now(), sats: Number(sats) || 0 };
    Object.keys(claimedJustNow).forEach(function (k) {
      if (Date.now() - claimedJustNow[k].at > CLAIMED_JUST_NOW_MS) delete claimedJustNow[k];
    });
  }

  function claimedMomentsAgo(quoteId) {
    var hit = claimedJustNow[quoteId];
    if (!hit) return null;
    if (Date.now() - hit.at > CLAIMED_JUST_NOW_MS) { delete claimedJustNow[quoteId]; return null; }
    return hit;
  }

  /* The most a mint will take in one array (NUT-06 `max_array_length`).
   *
   * CDK 0.18 and Nutshell 0.21 started advertising it; older mints do not, and
   * a mint may set it low. cashu-ts reads it and chunks its own checkstate and
   * batchRestore by it — but Foxy has two paths of its own that do not go
   * through cashu-ts: the restore walk, which batches by RESTORE_BATCH, and
   * the sent-token watch, which POSTs every one of a token's Ys to
   * /v1/checkstate itself. Either would be refused whole by a mint with a cap
   * below what Foxy sent, and a refused restore batch ends the walk.
   *
   * 500 is what cashu-ts falls back to for a mint that says nothing, so a mint
   * that has never advertised a cap behaves exactly as it did before. */
  function mintArrayCap(w) {
    var n = Number(w && w.maxArrayLength);
    return Number.isSafeInteger(n) && n > 0 ? n : 500;
  }

  /* `list` in pieces of at most `size`, each handed to `run` in turn, the
   * answers concatenated. One at a time: these go to a mint over Tor. */
  function inChunks(list, size, run) {
    var all = (Array.isArray(list) ? list : []).slice();
    var step = Math.max(1, Math.floor(size) || 1);
    if (all.length <= step) return Promise.resolve(run(all));
    var out = [];
    var chain = Promise.resolve();
    for (var i = 0; i < all.length; i += step) {
      (function (part) {
        chain = chain.then(function () {
          return Promise.resolve(run(part)).then(function (got) {
            out = out.concat(Array.isArray(got) ? got : []);
          });
        });
      }(all.slice(i, i + step)));
    }
    return chain.then(function () { return out; });
  }

  /* The bill reconcile in flight, if one is. splitReconcile asks the mint
   * about every unpaid row, and two callers reach it by different doors —
   * the history list (guarded) and resumeSplit (not) — so a screen opening
   * beside a resume ran the whole walk twice, a second or less apart. On a
   * phone in testing: three rows, two reconciles 0.745s apart, and
   * the same quote asked three times inside a second. Everyone asking now
   * shares the first walk, the way FoxyWallet.claim shares the first claim. */
  var reconciling = null;

  /* The melt sweep in flight, if one is.
   *
   * sweepMelts reads the held-melt list as it starts, so a second call that
   * arrives while the first is working finds the list already drained and
   * answers []. The proof lock does not help: it makes the second call WAIT
   * for the first and then run against an empty list, which is exactly the
   * wrong answer — the melts did settle, and its caller is told none did.
   * Everyone asking now shares the first walk and gets the same list back.
   *
   * This is why the lock wraps _sweepMeltsOnce and not sweepMelts: the
   * sharing has to happen before the waiting, or there is nothing left to
   * share by the time the second caller is let through. */
  var sweeping = null;

  /* The same for `finishMove`: the launch, the resume and the app each ask,
   * and two walks would each claim the same quote. */
  var finishing = null;
  /* And for the payments being brought home (`carryResume`), and the late
   * claims (`claimUnclaimed`): one walk each, shared. */
  var carrying = null;
  var claimingLate = null;
  /* Crossings this page is in the middle of, by quote, and payments being
   * brought home, by job. `finishMove` and `carryResume` leave them alone:
   * a connect in the middle of a move ran the catch-up, which claimed the
   * very quote the move was about to claim, and one of the two was refused
   * "quote already issued" (tests/interleave.js). In memory only, so a
   * relaunch finds none and finishes whatever was left. */
  var liveMove = {};
  var carryBusy = {};

  /* Proofs out of a mint's answer, as far as they can be used: a list, each
   * one with a keyset, a secret, a signature and a whole positive amount.
   * Anything else is dropped rather than stored. A mint's answer is untrusted
   * input like any other: `(answer.change || [])` let a bare string through
   * into the balance and threw inside sumProofs, in a success handler where
   * nothing could catch it (tests/onchain-faults.js). */
  /* Is any proof in the list there more than once?
   *
   * A payment is added up by its pieces, and a piece named twice was added
   * twice: 205 sats of real ecash, locked to an offline receiver and sent
   * with every proof repeated, read PAYMENT RECEIVED for a 400-sat request.
   * The lock was right and the mint's signature verified on every piece,
   * because every piece was the same piece. With a route the mint refuses
   * the whole swap for the repeat, so the receiver got nothing at all and
   * the 410 sat stayed on its screen as waiting, for ever
   * (tools/live/offline-cross-scenarios.js `dup-proof`, tests/offline-hostile.js).
   * The same repeat made 50 sats of change read as 100 to a
   * payer with no route. A mint refuses this in one line (NUT error 11007);
   * so does everything here that counts ecash without one to ask. */
  function repeatedProof(list) {
    var seen = Object.create(null);
    for (var i = 0; i < (list || []).length; i++) {
      var s = list[i] && list[i].secret;
      if (typeof s !== 'string') continue;
      if (seen[s]) return true;
      seen[s] = 1;
    }
    return false;
  }

  function usableProofs(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (p) {
      if (!p || typeof p !== 'object') return false;
      var amount = satsOf(p.amount);
      return isFinite(amount) && amount > 0 && Math.floor(amount) === amount
        && typeof p.secret === 'string' && !!p.secret
        && typeof p.C === 'string' && !!p.C
        && typeof p.id === 'string' && !!p.id;
    });
  }

  /* One on-chain payment out (K.onchainOut), changed in place or forgotten.
   * Kept here beside the other storage helpers: 16a-onchain.js is the body of
   * the wallet object and can hold no functions of its own. */
  function noteOnchainOut(quoteId, fields) {
    var list = load(K.onchainOut, []);
    list.forEach(function (r) { if (r.quote === quoteId) Object.assign(r, fields); });
    save(K.onchainOut, list);
  }

  function onchainForgetOut(quoteId) {
    save(K.onchainOut, load(K.onchainOut, []).filter(function (r) { return r.quote !== quoteId; }));
  }

  function onchainFloor(mintMin) {
    return Math.max(ONCHAIN_OWN_FLOOR, Math.round(Number(mintMin) || 0));
  }

  /* An amount from the mint as a number: cashu-ts hands some of them back as
   * Amount objects, and Number() on one of those is NaN. */
  /* A number from whatever cashu-ts calls an amount, without tripping over it.
   *
   * cashu-ts 4.11.0 backs amounts with `Amount`, a BigInt wrapper, and
   * `Number(amount)` goes through its `Symbol.toPrimitive` — which warns
   * "implicit numeric coercion is deprecated" and **throws in cashu-ts v5**.
   * The warning turned up once per payment in testing.
   * Every `satsOf(x.amount)` in the wallet now comes here.
   *
   * `toNumber()` first, because that is the method cashu-ts names as the
   * replacement and it is the one that will still exist. `toString()` next,
   * for an older Amount or anything else with a sensible text form: it asks
   * for the string hint, which is not deprecated. A plain number or bigint
   * falls through to `Number` as it always did. Anything unreadable is 0, not
   * NaN — a NaN loose in an amount is a silent wrong total. */
  function satsOf(value) {
    if (value == null) return 0;
    if (typeof value === 'object') {
      if (typeof value.toNumber === 'function') {
        try { var t = value.toNumber(); return isFinite(t) ? t : 0; } catch (e) {}
      }
      if (typeof value.toString === 'function') {
        var s = Number(value.toString());
        return isFinite(s) ? s : 0;
      }
      return 0;
    }
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  var wallet = null;
  var mintUrl = '';

  function hostOf(u) { return String(u || '').replace(/^https?:\/\//, ''); }

  /* A mint that has just turned a request away as too many (429), and for
   * how long Foxy goes easy on it.
   *
   * forge.flashapp.me allows a handful of requests a minute from one place.
   * A receive screen there asked about its invoice every two seconds while a
   * first-contact restore was also walking the seed, thirty-three requests in
   * a minute, and was turned away eleven times in the next (two simulators
   * in testing). Every one of those was asked again on a fresh circuit and
   * answered, so nothing was lost, but the right answer to "too many" is
   * fewer: for a minute after any 429, the things that ask on a clock ask a
   * mint no more than once in five seconds (`watch`). */
  var busyMints = {};
  function busyKey(u) { return hostOf(u).split('/')[0].toLowerCase(); }
  function noteMintBusy(u) { var k = busyKey(u); if (k) busyMints[k] = Date.now() + 60000; }
  function mintBusy(u) { var k = busyKey(u); return !!k && (busyMints[k] || 0) > Date.now(); }

  /* One spelling per mint.
   *
   * Mint URLs are storage keys. MINT.example.com, mint.example.com:443 and
   * mint.example.com/ are the same mint and were three separate balance
   * piles, and a "move to self" between two spellings paid real routing fees
   * to end up where it started. The scheme and host are case-insensitive by
   * definition; the path is not, so it is left alone apart from a trailing
   * slash. */
  function canonicalMint(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    var m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(s);
    if (!m) return s.replace(/\/+$/, '');
    var scheme = m[1].toLowerCase();
    var host = m[2].toLowerCase();
    var rest = (m[3] || '').replace(/\/+$/, '');
    var defaultPort = scheme === 'https' ? ':443' : ':80';
    if (host.slice(-defaultPort.length) === defaultPort) {
      host = host.slice(0, -defaultPort.length);
    }
    return scheme + '://' + host + rest;
  }

  /* What this mint charges to split a pile of proofs. Mints set an input fee
   * per thousand, and cashu-ts adds it on top of whatever you asked to send —
   * so a transfer sized to the last sat fails at the split with "not enough
   * funds available to send". The figure comes back wrapped; read it loosely. */
  /* Nothing in a transfer quote may hang. Over Tor a request can sit open for
   * minutes, and the screen it stalls has only a cancel button — so every step
   * gets a ceiling and says which one ran out. A quote left half-made at the
   * far mint is harmless: it is never paid, and it expires. */
  function withTimeout(promise, ms, label) {
    var started = Date.now();
    return Promise.race([
      Promise.resolve(promise).then(function (r) {
        console.log('[foxy] ' + label + ' took', Date.now() - started, 'ms');
        return r;
      }),
      new Promise(function (_, no) {
        setTimeout(function () {
          no(new Error(label + ' did not answer within ' + Math.round(ms / 1000) + 's.'));
        }, ms);
      })
    ]);
  }

  /* "Outputs have already been signed" (NUT error 10002).
   *
   * The mint has signed outputs at these counters before — after a restore
   * that set a counter low, or two wallet objects on one keyset. It refused
   * the whole request, so nothing changed at the mint. The counters move past
   * the used range and the request is made once more, as cashu.me does. There
   * was no handling at all: every swap at that mint failed until something
   * else happened to move the counters. */
  /* Every mint's way of saying these outputs are already used.
   *
   * Nutshell before 0.19: 10002, "outputs have already been signed before".
   * Nutshell now: 11003 "outputs already signed", 11004 "outputs are pending".
   * CDK — which Minibits' mint moved to — answers a swap on used counters with
   * 11008 "Duplicate outputs": its database refuses a blinded message it has
   * stored, signed or pending, and that is the code it sends. Foxy knew only
   * the first wording, so every swap at such a mint failed with "duplicate
   * outputs" and nothing moved the counters on. Seen on a device.
   *
   * A genuine duplicate inside one request would also say 11008. Retrying that
   * is safe: the mint refuses the whole request before signing anything. */
  var USED_OUTPUT_CODES = [10002, 11003, 11004, 11008];

  function alreadySigned(e) {
    var m = String((e && (e.message || e.detail)) || e || '');
    var code = Number(e && (e.code || (e.response && e.response.code)));
    return USED_OUTPUT_CODES.indexOf(code) >= 0
      || /outputs? (have )?already (been )?signed|blinded message is already signed|outputs are pending|duplicate outputs|duplicate key/i.test(m);
  }

  /* CDK's answer to a mint (claim) request on used counters: its database
   * error surfaces as 20006, "Invoice already paid or pending". Only on a
   * claim, and only while the mint still says the quote is PAID — on a melt
   * the same words can mean the invoice really was paid. */
  function mintSaysPaidOrPending(e) {
    var m = String((e && (e.message || e.detail)) || e || '');
    var code = Number(e && (e.code || (e.response && e.response.code)));
    return code === 20006 || /invoice already paid or pending/i.test(m);
  }

  /* How far counters may still be moved on, per keyset, this session.
   *
   * A restore stops after 300 unused counters in a row. One run of skips is
   * 160 at most, but a claim that kept failing on a PAID quote skipped again on
   * every try, past the 300, and ecash made after that gap could not be found
   * from the twelve words. Once a keyset's 160 are spent, the error stands. */
  var SKIP_BUDGET = 160;
  var skipsLeft = {};

  /* Resolves true once the counters have moved on; false when this session's
   * budget for the keyset is spent, and nothing moved. */
  function skipSignedCounters(w, by) {
    /* The keyset the outputs are made on. Every keyset the mint lists used to
     * move, pushing counters nothing was signed on past what a restore walks. */
    var ids = [];
    if (w.keysetId) {
      ids.push(w.keysetId);
    } else {
      try {
        var sets = (w.keyChain && w.keyChain.getKeysets) ? w.keyChain.getKeysets() : [];
        (sets || []).forEach(function (k) { if (k && k.id && ids.indexOf(k.id) < 0) ids.push(k.id); });
      } catch (e) {}
    }
    ids = ids.filter(function (id) {
      return (skipsLeft[id] === undefined ? SKIP_BUDGET : skipsLeft[id]) >= by;
    });
    if (!ids.length) {
      console.warn('[foxy] counters not moved on: this session has already moved them as far as a restore can follow');
      return Promise.resolve(false);
    }
    ids.forEach(function (id) {
      skipsLeft[id] = (skipsLeft[id] === undefined ? SKIP_BUDGET : skipsLeft[id]) - by;
    });
    /* The phone keeps the counters. Each moves on from where the phone has it,
     * and the phone never moves one down, so there is nothing to merge back
     * afterwards. */
    return sharedCounters.snapshot().then(function (now) {
      return ids.reduce(function (chain, id) {
        return chain.then(function () {
          return sharedCounters.advanceToAtLeast(id, (Number(now[String(id).toLowerCase()]) || 0) + by);
        });
      }, Promise.resolve());
    }).then(function () {
      console.warn('[foxy] counters moved on by', by, 'for', ids.length, 'keyset(s)');
      return true;
    });
  }

  /* Moved on 10, then 50, then 100, before giving up: 160 counters at most.
   * A single +10, as cashu.me and Minibits use, does not clear a longer run of
   * used counters, and the request failed again. 160 stays inside the 300
   * empty counters a restore walks past (three empty batches of 100), and
   * SKIP_BUDGET keeps it there across every attempt in a session, not only
   * within one. */
  var COUNTER_SKIPS = [10, 50, 100];

  // quotePaid: for a claim, resolves true while the mint still calls the quote PAID
  /** @param {(function(): *)=} quotePaid */
  function onceMoreIfSigned(w, label, run, quotePaid) {
    var tries = 0;
    function attempt() {
      return run().catch(function (e) {
        var used = alreadySigned(e)
          ? Promise.resolve(true)
          : (quotePaid && mintSaysPaidOrPending(e))
            ? Promise.resolve().then(quotePaid).then(function (paid) { return !!paid; }, function () { return false; })
            : Promise.resolve(false);
        return used.then(function (yes) {
          if (!yes || tries >= COUNTER_SKIPS.length) throw e;
          var by = COUNTER_SKIPS[tries++];
          console.warn('[foxy] ' + label + ': the mint has seen these outputs before (' +
            String((e && e.message) || e).slice(0, 60) + '); moving the counters on by ' + by + ' and trying again');
          return skipSignedCounters(w, by).then(function (moved) {
            if (!moved) throw e;
            return attempt();
          });
        });
      });
    }
    return attempt();
  }

  /* A mint's signatures that fail their DLEQ check (NUT-12).
   *
   * cashu-ts refuses them before anything is stored. Nothing should try again:
   * the same mint sends the same thing, and each attempt burns counters. The
   * person is told once per mint and operation, through onMintTrouble. */
  function badSignatures(e) {
    return /dleq verification failed|dleq proof invalid|signatures do not match the keys|sent invalid signatures/i
      .test(String((e && (e.message || e.detail)) || e || ''));
  }

  /* The mint saying these proofs are not its own: NUT error 10003, or this
   * wallet's own DLEQ check saying the same before the mint was asked. Ecash
   * refused for that is not money waiting to be swapped and never will be, so
   * it does not stay on a list the balance counts (audit N1). */
  function notIssued(e) {
    var code = Number(e && (e.code || (e.response && e.response.code)));
    if (code === 10003) return true;
    return /signatures do not match the keys|proofs? could not be verified/i
      .test(String((e && (e.message || e.detail)) || e || ''));
  }

  var badSigTold = {};
  function reportBadSignatures(host, where) {
    var key = host + '|' + where;
    if (badSigTold[key]) return;
    badSigTold[key] = true;
    console.error('[foxy] ' + host + ' sent signatures that do not verify (' + where + ')');
    if (typeof FoxyWallet._onMintTrouble === 'function') {
      try { FoxyWallet._onMintTrouble({ mint: host, badSignatures: true, where: where }); } catch (x) {}
    }
  }

  /* Paid, not collected: written on the invoice itself.
   *
   * A paid invoice whose claim fails used to leave only a log line while the
   * balance did not move. The reason, how many tries and since when go on the
   * invoice's record, so the app can show it, and a later launch still knows. */
  function noteClaimTrouble(quoteId, e) {
    // not trouble: the phone was on another mint, and nothing was asked (`_claimOnce`)
    if (e && e.foxyElsewhere) return;
    var bad = badSignatures(e);
    var now = Date.now();
    var hit = /** @type {any} */ (null);          // set inside the loop below
    [K.quotes, K.quotesOld].forEach(function (key) {
      var list = load(key, []);
      var changed = false;
      list.forEach(function (q) {
        if (!q || q.quote !== quoteId) return;
        var prev = q.unclaimed || {};
        /* A failure that reserved no counter range is not one of the ten.
         *
         * outputsRecorder marks those: a claim that never left the phone (no
         * Tor yet, on a wake), or one whose ranges the mint refused and gave
         * straight back. The ten exist to bound counters the mint never
         * signs; these bought none. Counting them meant ten badly-timed wakes
         * could file a PAID invoice as given up and stop asking for money
         * that is sitting at the mint. */
        var free = neverSent(e);
        var tries = (prev.tries || 0) + (free ? 0 : 1);
        // the mint answered no (a 4xx or a coded error): nothing was signed
        var refused = (prev.refused || 0) + (mintRefused(e) ? 1 : 0);
        var badly = bad || !!prev.badSignatures;
        q.unclaimed = {
          since: prev.since || now,
          at: now,
          tries: tries,
          refused: refused,
          reason: FoxyWallet.reason(e),
          badSignatures: badly,
          /* Why Foxy stopped asking on its own, or '' while it has not.
           *
           * Refusals were counted and silence was not, so a mint that took the
           * request and never answered was asked again on every connect and
           * every return, for ever. Each ask reserves a counter range the mint
           * never signs, and a long enough run of them hides later ecash from a
           * restore, which walks 300 counters before it gives up — the same
           * harm the refusal cap was added to prevent (audit W2),
           * arrived at by a path nothing was counting.
           *
           * CLAIM_TRIES_MAX is every attempt, however it failed. Ten claims
           * cost a few dozen counters at most, well inside what a restore
           * crosses, and ten automatic attempts across connects and resumes is
           * a long outage. The money stays at the mint and the card still
           * offers a try by hand. */
          gaveUp: badly ? 'signatures'
            : refused >= 3 ? 'refused'
            : tries >= CLAIM_TRIES_MAX ? 'silence'
            : '',
        };
        hit = { quote: q.quote, amount: q.amount, mint: q.mint, unclaimed: q.unclaimed };
        changed = true;
      });
      if (changed) save(key, list);
    });
    if (bad) reportBadSignatures(hostOf((hit && hit.mint) || mintUrl || ''), 'claim');
    if (hit && typeof FoxyWallet._onClaimTrouble === 'function') {
      try { FoxyWallet._onClaimTrouble(hit); } catch (x) {}
    }
    return hit;
  }

  function quoteStillPaid(w, quoteId) {
    return function () {
      return withTimeout(w.checkMintQuoteBolt11(quoteId), 20000, 'the invoice\u2019s state').then(function (q) {
        return String((q && q.state) || '').toUpperCase() === 'PAID';
      });
    };
  }

  /* Each proof's state at the mint, as 'UNSPENT' / 'PENDING' / 'SPENT'. */
  function statesOf(w, list) {
    /* Asked again, on a circuit of its own, when the first has said nothing
     * for six seconds. The check reads and changes nothing, so two of them
     * cost nothing — and the first request after a route comes back is the
     * one that waits on a circuit still being built: 21.7 seconds, in front
     * of money that was at risk until it answered. Whichever answers
     * first is the answer. */
    var asked = new Promise(function (ok, no) {
      var settled = false, second = false, failed = 0;
      var yes = function (r) { if (settled) return; settled = true; clearTimeout(again); ok(r); };
      var bad = function (e) {
        failed += 1;
        if (settled || (second && failed < 2)) return;
        settled = true; clearTimeout(again); no(e);
      };
      var again = setTimeout(function () {
        if (settled) return;
        second = true;
        console.log('[foxy] the mint\u2019s proof check has not answered in 6s; asking again on another circuit');
        var other;
        try { other = onCircuit(w, 'check-again:' + Date.now()); } catch (e) { other = null; }
        if (!other || !other.checkProofsStates) { second = false; return; }
        Promise.resolve().then(function () { return other.checkProofsStates(list); }).then(yes, bad);
      }, FoxyWallet._checkAgainMs || 6000);
      Promise.resolve().then(function () { return w.checkProofsStates(list); }).then(yes, bad);
    });
    return withTimeout(asked, 30000, 'the mint\u2019s proof check').then(function (states) {
      return (list || []).map(function (p, k) {
        return String((states[k] && (states[k].state || states[k].State)) || '').toUpperCase();
      });
    });
  }

  /* Before a token is swapped: is any of it spent, or being spent (NUT-07)?
   *
   * A swap reserves counters for its outputs before the mint is asked, and a
   * refusal signs none of them. A receive or a reclaim of a token that was
   * already spent used to swap straight away, and every try widened the run of
   * unsigned counters a restore has to look across (audit W5).
   * import already asked first. Resolves when the swap may go ahead; rejects
   * with `spentMessage` if any proof is SPENT, or says it is PENDING, having
   * reserved nothing.
   *
   * A check that fails — no answer, a timeout — is not a refusal. The swap goes
   * ahead as it did before and the mint decides: a receive should not fail
   * because a question about it did. An answer this cannot read is treated the
   * same way. */
  function refuseSpent(w, list, spentMessage) {
    var ask = (list || []).filter(function (p) { return p && p.secret; });
    if (!ask.length || !w || typeof w.checkProofsStates !== 'function') return Promise.resolve();
    return statesOf(w, ask).then(function (states) {
      if (states.indexOf('SPENT') >= 0) throw new Error(spentMessage);
      if (states.indexOf('PENDING') >= 0) {
        throw new Error('That token is being spent right now (the mint says it is pending), so it was not taken. ' +
          'Try again once it settles.');
      }
    }, function (e) {
      console.warn('[foxy] could not ask the mint whether that token is spent (' +
        String((e && e.message) || e).slice(0, 60) + '); swapping it anyway');
    });
  }

  function allUnspent(states) {
    return states.length > 0 && states.every(function (st) { return st === 'UNSPENT'; });
  }

  /* Proofs carrying a spending condition (NUT-10: P2PK, HTLC).
   *
   * Their secret is a JSON array naming the condition. Foxy holds no keys for
   * conditions — its own P2PK scheme was removed — so none of these can be
   * spent by this wallet, and asking the mint would only return its wording. */
  function lockedProofs(list) {
    return (list || []).filter(function (p) {
      var raw = p && p.secret;
      if (typeof raw !== 'string' || raw.charAt(0) !== '[') return false;
      try { var j = JSON.parse(raw); return Array.isArray(j) && typeof j[0] === 'string'; } catch (e) { return false; }
    });
  }

  var LOCKED = 'That token is locked to someone else\u2019s key, so this wallet cannot claim it.';

  /* A token locked to this phone that the sender can take back after a
   * time: why it was not taken, with the date. */
  function lockedUntilWords(proofs, online) {
    var at = 0;
    (proofs || []).forEach(function (pr) { var t = locktimeOf(pr); if (t > at) at = t; });
    var when = at > 0 ? new Date(at * 1000).toLocaleString() : 'a time this wallet could not read';
    if (at > 0 && at <= Math.floor(Date.now() / 1000)) {
      return 'The time lock on this ecash has passed, so the sender can take it back. It cannot be claimed here.';
    }
    return online
      ? 'This ecash can be taken back by the sender after ' + when
        + ', which is too soon to be safe. Ask them to send it without a time lock.'
      : 'This ecash can be taken back by the sender after ' + when
        + ', so it cannot be accepted offline. Take it when this phone is online.';
  }

  /* The key a P2PK-locked proof is locked to, or '' when it is not that kind.
   *
   * A locked proof's secret is ["P2PK", {nonce, data: <pubkey>, tags}]. Foxy
   * refuses locked proofs it has no key for, and always did; this is what tells
   * the two cases apart, so a token locked to a key this phone made for its own
   * payment request can be claimed while a stranger's is still turned away. */
  function lockedTo(proof) {
    var raw = proof && proof.secret;
    if (typeof raw !== 'string' || raw.charAt(0) !== '[') return '';
    try {
      var j = JSON.parse(raw);
      if (!Array.isArray(j) || j[0] !== 'P2PK') return '';
      var d = j[1] && j[1].data;
      return typeof d === 'string' ? d : '';
    } catch (e) { return ''; }
  }

  /* Who a proof can really be spent by, as NUT-11 counts it — not who its
   * `data` field names.
   *
   * `lockedTo` above reads `data` and stops there, which is the pubkey the
   * lock is written to and not the set of keys that can open it. NUT-11 puts
   * the rest in the tags, and every one of these passes a `data` test while
   * meaning something else entirely:
   *
   *   ["pubkeys", <payer>]          spendable by them as well as by us
   *   ["locktime", <past>]          no witness needed at all: anyone
   *   ["locktime", <past>], refund  theirs again once it passes
   *   ["n_sigs", 2] / SIG_ALL       not openable by our one signature
   *
   * cashu-ts works all of that out and ships the answer — this is its
   * `getP2PKExpectedWitnessPubkeys`, whose own documentation says "if no keys
   * are returned, the proof is unlocked or expired with no refund path". Foxy
   * had reimplemented the question and got it wrong, which is exactly what
   * CASHU-CONFORMANCE.md promises it does not do. Null means "cannot tell",
   * which is never treated as ours. */
  function spendableBy(proof) {
    var raw = proof && proof.secret;
    if (typeof raw !== 'string' || raw.charAt(0) !== '[') return null;
    /* P2PK and nothing else. This only looked at the leading bracket, and
     * `getP2PKExpectedWitnessPubkeys` reads a NUT-14 HTLC's `pubkeys` tag
     * happily — so an HTLC naming this phone was accepted as locked to us
     * alone, and spending it needs a preimage this wallet has not got.
     * The older `lockedTo` checked the kind; this lost it. */
    try {
      var j = JSON.parse(raw);
      if (!Array.isArray(j) || j[0] !== 'P2PK') return null;
      var keys = window.CashuTS.getP2PKExpectedWitnessPubkeys(raw);
      return Array.isArray(keys) ? keys : null;
    } catch (e) { return null; }
  }

  /* Whether a secret carries a locktime at all — in the future as much as the
   * past.
   *
   * `getP2PKExpectedWitnessPubkeys` answers a question about *now*: a locktime
   * an hour away is still active, so it names this phone alone and the lock
   * test passes. Every screen that shows the money as arrived hangs off that
   * test, and the mint has not necessarily taken the proofs yet — a payer sets
   * a locktime a minute out, taps, gets a settled confirmation and the sats
   * counted in the balance, and takes the money back when it expires. Face to
   * face, that is the window in which goods change hands.
   *
   * Foxy asks for no locktime and has no use for one. Any locktime is somebody
   * else's deadline on money this phone is being told is its own. */
  function hasLocktime(proof) {
    try {
      var j = JSON.parse(String((proof && proof.secret) || ''));
      var tags = j && j[1] && j[1].tags;
      return Array.isArray(tags) && tags.some(function (t) {
        return Array.isArray(t) && String(t[0]).toLowerCase() === 'locktime';
      });
    } catch (e) { return true; }
  }

  /* When a proof's locktime falls, in seconds since the epoch: 0 for none,
   * and -1 for one that cannot be read, which is treated as one that has. */
  function locktimeOf(proof) {
    try {
      var j = JSON.parse(String((proof && proof.secret) || ''));
      var tags = j && j[1] && j[1].tags;
      if (!Array.isArray(tags)) return 0;
      var at = 0;
      tags.forEach(function (t) {
        if (!Array.isArray(t) || String(t[0]).toLowerCase() !== 'locktime') return;
        var n = Number(t[1]);
        at = (Number.isFinite(n) && n > 0) ? n : -1;
      });
      return at;
    } catch (e) { return -1; }
  }

  /* How far out a locktime has to be for a token to be taken where the swap
   * follows at once. A day: the swap is seconds, and a phone whose clock is
   * wrong by hours still cannot be handed money that is about to be the
   * sender's again. Audit finding: cashu.me and Nutshell add a refund
   * locktime to a plain send, and every such token was refused whole. */
  var LOCKTIME_MARGIN_S = 86400;

  /* Whether a proof's locktime leaves room to swap it in now. */
  function locktimeFarEnough(proof, now) {
    var at = locktimeOf(proof);
    if (at === 0) return true;
    if (at < 0) return false;
    return at - Math.floor((now || Date.now()) / 1000) >= LOCKTIME_MARGIN_S;
  }

  /* NUT-11's own comparison: "keys are compared using their lowercase
   * x-coordinate (02 or 03 y-parity prefix ignored)". Exact string equality
   * refused a key of ours written the other way round. */
  function sameLockKey(a, b) {
    a = String(a || '').toLowerCase();
    b = String(b || '').toLowerCase();
    if (a.length === 66) a = a.slice(2);
    if (b.length === 66) b = b.slice(2);
    return !!a && a === b;
  }

  /* Locked to this key and to nobody else — the only shape worth calling ours.
   * Anything else is either a stranger's, or ours *and* somebody else's, and
   * the second is the dangerous one because it looks like the first.
   *
   * Being the only key that can sign is not enough to be able to spend it.
   * `["n_sigs","2"]` beside a single key wants two signatures from one key,
   * which NUT-11 says is malformed and the mint must refuse; `SIG_ALL` wants
   * the whole transaction signed, which Foxy has no path for. Both name us and
   * only us, so the key test passes and the money is unspendable — accepted as
   * settled and stuck for ever. cashu-ts already knows the rules, so it is
   * asked. */
  /* `opts.swapNow`: the swap follows at once, so a locktime still a day or
   * more away is no threat — the lock is gone with the swap. Anywhere the
   * proofs would be KEPT on the strength of the lock (offline, handed on, held
   * before the mint has answered) a locktime is refused as before. */
  function onlyLockedTo(proof, pub, opts) {
    var keys = spendableBy(proof);
    if (!keys || keys.length !== 1 || !sameLockKey(keys[0], pub)) return false;
    if (hasLocktime(proof)) {
      if (opts && opts.swapNow && locktimeFarEnough(proof)) {
        console.log('[foxy] a proof locked to this phone carries a locktime far enough out to swap it in now');
      } else {
        console.warn('[foxy] a proof locked to this phone carries a locktime, so it is not ours to keep');
        return false;
      }
    }
    try { window.CashuTS.verifyP2PKSpendingConditions({ secret: proof && proof.secret }); }
    catch (e) {
      console.warn('[foxy] a proof locked to this phone is one it could not spend:',
                   String((e && e.message) || e).slice(0, 90));
      return false;
    }
    return true;
  }

  /* Signed mint quotes (NUT-20).
   *
   * Without one, anyone who learns an invoice's quote id can claim the sats
   * once it is paid — the id is all the mint asks for. With a key on the quote
   * the mint also wants a signature over the outputs, and only this device
   * holds the key.
   *
   * A fresh random key for every quote, as Nutshell and cashu.me do: nothing
   * links one invoice to another, and no new derivation from the seed. The key
   * is stored with the quote, in the same write, before the invoice is shown —
   * a quote whose key was lost is money the mint will not release. (Losing both
   * together loses nothing a signed quote adds: the quote id is gone too.)
   * A mint that does not advertise NUT-20 gets an unsigned quote, as before. */
  /* Hex back to bytes, for the library calls that take no other shape. */
  function bytesOfHex(hex) {
    var text = String(hex || '');
    if (text.length % 2 || /[^0-9a-f]/i.test(text)) throw new Error('not hex');
    var out = new Uint8Array(text.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
    return out;
  }

  function hexOf(bytes) {
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function quoteLock(w) {
    try {
      var CT = window.CashuTS;
      if (!w || typeof w.createLockedMintQuote !== 'function') return null;
      if (!CT || !CT.createRandomSecretKey || !CT.getPubKeyFromPrivKey) return null;
      if (!w.getMintInfo().isSupported(20).supported) return null;
      var sk = CT.createRandomSecretKey();
      return { privkey: hexOf(sk), pubkey: hexOf(CT.getPubKeyFromPrivKey(sk)) };
    } catch (e) {
      return null;
    }
  }

  function createQuote(w, amount, memo, lock) {
    return (lock
      ? w.createLockedMintQuote(amount, lock.pubkey, memo || undefined)
      : w.createMintQuoteBolt11(amount, memo)).then(function (q) {
      // the invoice names the mint's node (05-paying-this-mint.js)
      try { learnMintNode(mintOf(w), q && q.request); } catch (e) {}
      return q;
    });
  }

  // `lock` is anything carrying { pubkey, privkey } — a stored invoice, a move note
  function mintQuoteProofs(w, amount, quoteId, lock) {
    return lock && lock.privkey && lock.pubkey
      ? w.mintProofsBolt11(amount, { quote: quoteId, pubkey: lock.pubkey }, { privkey: lock.privkey })
      : w.mintProofsBolt11(amount, quoteId);
  }

  /* What a mint charges to spend `count` pieces, without holding any yet.
   *
   * `swapFeeFor` needs the proofs in hand. This is for the fee on money that
   * has not arrived — padding a cross-mint payment so the amount asked for is
   * the amount that lands, where the pieces being padded for are the ones the
   * far mint has not issued yet. Zero at a mint that charges nothing, which is
   * most of them, and a ceiling everywhere else: over-padding leaves a few sats
   * at the far mint, which are still the payer's, and under-padding leaves the
   * receiver short, which is the thing that must not happen.
   */
  /* How many pieces an amount is, as a mint issues it: one per bit.
   *
   * A pile claimed fresh from a mint quote comes back in binary denominations,
   * so 50 sats is 32 + 16 + 2 — three pieces, not fifty and not sixty-four. It
   * is what a payment of that amount has to spend, give or take the margin a
   * caller adds, and it is the honest input to a fee estimate. */
  function piecesFor(n) {
    var v = Math.max(0, Math.round(Number(n) || 0));
    var bits = 0;
    while (v) { bits += v & 1; v = Math.floor(v / 2); }
    return bits;
  }

  function feeForInputs(w, count) {
    var n = NaN;
    var id = '';
    try {
      var ks = w.keysets || (w.keys && [w.keys]) || [];
      var one = (w.keysetId) || (ks[0] && (ks[0].id || ks[0]));
      id = String(one || '');
    } catch (e) {}
    try {
      var g = w.getFeesForKeyset(Math.max(1, Math.round(count) || 1), id);
      n = Number(g && g.toString ? g.toString() : g);
    } catch (e2) {}
    if (!isFinite(n) || n < 0) n = 0;
    return Math.ceil(n);
  }

  function swapFeeFor(w, list) {
    var n = NaN;
    try {
      var f = w.getFeesForProofs(list);
      n = Number(f && f.toString ? f.toString() : f);
    } catch (e) {}
    if (!isFinite(n)) {
      // Second route to the same number, in case the first is not on this
      // build of cashu-ts: the per-keyset fee for this many inputs.
      try {
        var g = w.getFeesForKeyset(list.length, list[0] && list[0].id);
        n = Number(g && g.toString ? g.toString() : g);
      } catch (e2) {}
    }
    if (!isFinite(n) || n < 0) n = 0;
    return Math.ceil(n);
  }

