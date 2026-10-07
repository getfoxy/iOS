  /* The seventeen functions that read-then-write the proof list, made mutually
   * exclusive. Wrapping here rather than editing nine bodies keeps the lock
   * visible in one place and each function's own code untouched.
   *
   * None of these calls another (checked), so none can wait on itself. The
   * callers that do call them — moveRun, sweepQuotes, splitReconcile,
   * payLnurl, finishMove — stay unwrapped and wait their turn on each call. */
  var HOME_FIRST = { pay: 1, sendToken: 1, receiveToken: 1, reclaimToken: 1, onchainPay: 1 };
  /* And these wait a few seconds for a route that is on its way (`routeSoon`),
   * because each takes a worse branch without one: a token scanned in the
   * first seconds of a session got the HIGH RISK card, a payment was refused
   * for want of a connection that was two seconds off, a send dropped to the
   * pieces on hand. With a route, or with none coming, nothing is waited
   * for. */
  var ROUTE_FIRST = { pay: 1, sendToken: 1, receiveToken: 1, reclaimToken: 1, onchainPay: 1 };
  ['claimQuote', 'claim', 'pay', 'reconcile', 'reclaimToken',
   'receiveToken', 'sendToken', 'importProofs', 'adoptScan',
   /* Settles held payments and puts proofs back: it ran outside the lock, and
    * could return proofs while a payment was spending them.
    *
    * The inner one, not `sweepMelts` itself. `sweepMelts` shares one walk
    * between everyone who asks (00-header-and-mint-errors.js, `sweeping`),
    * and that has to happen in front of the lock: wrapped the other way
    * round, a second caller waits for the first to finish and then runs
    * against a list the first already emptied. */
   '_sweepMeltsOnce',
   // add proofs restored from a lost claim's or a lost swap's counters
   // (the inner walk, one mint at a time: `recoverSwaps` calls it for each mint, as `sweepMelts` does)
   'recoverIssued', '_recoverSwapsOnce',
   // swaps the pieces of a refused payment for fresh ones, or takes spent ones out of the pile
   '_settleAtRiskOnce',
   // rewrites a pile; outside the lock, a payment waiting on the mint saved
   // its older copy over what it had just written. `dedupeProofs` stood beside
   // it here until it was deleted for want of a caller (finding 19)
   'unquarantine',
   // swaps a piece of the pile for small change
   'tidyChange',
   /* The on-chain paths read the pile, await the mint, then write it back —
    * the same read-then-write every name above is here for. Outside the lock,
    * ecash that arrived while a payout's split was in flight was wiped by the
    * setProofs that followed it, and a claim could drop sats the mint had
    * already issued (tests/onchain-faults.js). None of the three calls another,
    * so none waits on itself; the watcher chains them one at a time anyway. */
   'onchainPay', 'onchainClaim', 'onchainFollow'].forEach(function (name) {
    var inner = FoxyWallet[name];
    if (typeof inner !== 'function') return;
    FoxyWallet[name] = function () {
      var self = this, args = arguments;
      /* Read now, while the caller is still on the stack: the late-claim walk
       * marks its own call for exactly that long (`walkCalling`). */
      var own = walkCalling;
      /* A payment that found some of its ecash spent elsewhere has taken it out
       * of the pile and says so with foxyAgain (retryWithoutSpent): it is made
       * again from what is left, inside the same turn of the lock. At most
       * three times, each of which removed ecash. */
      var attempt = function (left) {
        // some of these answer synchronously (importProofs)
        return Promise.resolve().then(function () { return inner.apply(self, args); }).catch(function (e) {
          if (e && e.foxyAgain && left > 0) {
            e.foxyAgain = false;
            return attempt(left - 1);
          }
          throw e;
        });
      };
      var turn = function () {
        return withProofs(name, function () { return attempt(3); }).catch(function (e) {
          // invalid signatures, from whichever operation met them
          if (badSignatures(e)) {
            reportBadSignatures(hostOf(mintUrl || ''),
              name === 'claim' || name === 'claimQuote' ? 'claim' : name === 'pay' || name === 'sweepMelts' ? 'pay' : 'swap');
          }
          throw e;
        });
      };
      /* What a person starts waits for a late claim to bring the wallet home
       * (`claimAway`): in the gaps between that walk's claims the lock is
       * free and the wallet is somebody else's mint, and a payment made then
       * was made there, from that mint's pile.
       *
       * Only these. The sweeps a connect starts belong at whatever mint was
       * connected to, the visit's included, and are left to run there. Nor
       * the walk's own claim, which is what the visit is for; nor change
       * for an overpayment, which is made where the payment was just taken. */
      var changeBack = name === 'sendToken' && args[1] && args[1].purpose === 'change';
      var go = function () {
        if (!HOME_FIRST[name] || own || changeBack) return turn();
        return homeFirst(turn);
      };
      // not the walk's own claim, nor change being made: both only ever run with a route
      if (ROUTE_FIRST[name] && !own && !changeBack && FoxyWallet._routeWaitMs > 0 && routeComing()) {
        return routeSoon(FoxyWallet._routeWaitMs).then(go);
      }
      return go();
    };
  });

  /* Taking a token in, this wallet's own included, ends any watch on it
   * (dropTokenWatchesFor). */
  ['receiveToken', 'reclaimToken'].forEach(function (name) {
    var locked = FoxyWallet[name];
    if (typeof locked !== 'function') return;
    FoxyWallet[name] = function (text) {
      /* The refund of a refused payment, arriving late as a code: the
       * pieces it was made from are spent, and stop being counted. Known
       * before the token is taken, because taking it strikes its key off. */
      var refundOf = '';
      try { refundOf = name === 'receiveToken' ? atRiskRefundOf(text) : ''; } catch (e0) { refundOf = ''; }
      return locked.apply(this, arguments).then(function (r) {
        if (refundOf) {
          atRiskRefunded(refundOf, (r && r.sats) || 0, 'row').then(function () {
            if (typeof FoxyWallet._onAtRisk === 'function') {
              try { FoxyWallet._onAtRisk({ state: 'refunded', hash: refundOf, sats: (r && r.sats) || 0 }); } catch (x) {}
            }
          }, function () {});
        }
        try { dropTokenWatchesFor(text); } catch (e) {}
        // one of this wallet's own sent tokens, taken back: its entry is no longer waiting
        try { FoxyWallet.forgetClaimedToken(text); } catch (e) {}
        return r;
      });
    };
  });

  /* For the console and the tests: how many locked calls are running — 1 while
   * one runs, 0 between. It never counts callers still waiting: the count goes
   * up when a call starts, not when it joins the chain. This used to say
   * "queued or running", which it never measured. */
  FoxyWallet.proofLockDepth = function () { return proofDepth; };
  FoxyWallet.giveUpWaiting = function () { giveUpWaiting(); };
  // and who, for how long: null between calls (the diary's, 09-melt-paste-switch.js)
  FoxyWallet.proofLockHolder = function () {
    return proofDepth > 0 ? { what: proofHolder, ms: Date.now() - proofSince } : null;
  };

  /* The last price this phone was told, back off the disk (K.rate).
   *
   * It used to live only in `_rate`/`_rateAt`, so killing the app threw it away.
   * That is fine with a route — the next fetch is a second away — and useless
   * without one, which is exactly when there is no next fetch: a phone
   * relaunched in airplane mode came up with no price at all, twenty-two seconds
   * after being told 84,746.
   *
   * Restored, never trusted as current. `rate()` still serves it for only a
   * minute before asking again, and every screen that shows it shows its age.
   * A stored figure outside the sane band, or with no timestamp, is ignored:
   * this is a convenience, and a wrong price is worse than none. */
  (function lastPriceBack() {
    try {
      var kept = load(K.rate, null);
      if (!kept || typeof kept !== 'object') return;
      var n = Number(kept.rate);
      var at = Number(kept.at);
      if (!isFinite(n) || n < 5000 || n > 1000000) return;
      if (!isFinite(at) || at <= 0 || at > Date.now() + 86400000) return;
      FoxyWallet._rate = n;
      FoxyWallet._rateAt = at;
      console.log('[foxy] the last price this phone was told: '
        + Math.round(n) + ', ' + Math.round((Date.now() - at) / 1000) + 's ago');
    } catch (e) {}
  }());

  /* The hosts this wallet already used, told to the native side at load.
   *
   * The first request to a host Foxy has not used now waits for an Allow in an
   * iOS alert (HostApprovals). A wallet from before that would have been asked
   * about its own mint on the first launch, so its saved mint, every mint it has
   * connected to and its contacts' payment domains are carried over. The native
   * side accepts this once, the first time the version runs; after that it
   * changes nothing, so a script injected later cannot add a host this way.
   * Sent before anything asks a mint: messages reach the native side in order. */
  (function carryOverHosts() {
    var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
    if (!mh) return;
    var hosts = [];
    function add(u) {
      try { var h = new URL(String(u || '')).hostname; if (h) hosts.push(h); } catch (e) {}
    }
    add(load(K.mint, ''));
    (load(K.mints, []) || []).forEach(add);
    (load('foxy.contacts', []) || []).forEach(function (c) {
      var h = String((c && c.handle) || '').trim().replace(/^lightning:/i, '');
      var at = h.indexOf('@');
      if (at > 0) hosts.push(h.slice(at + 1));
      else if (/^lnurl1/i.test(h)) { try { add(FoxyWallet.decodeLnurl(h)); } catch (e) {} }
      else add(h);
    });
    bridgeAsk('hostsKnown', { hosts: hosts }, 5000).catch(function () {});
  }());

  /* And the change a token asked for, once the token is in. Here rather than
   * at each door a token comes through — the scan, the paste, the receive
   * screen's own scan — so none of them can forget it. Not waited for: the
   * payment is in, and the change is a second thing that follows it. */
  (function () {
    var take = FoxyWallet.receiveToken;
    FoxyWallet.receiveToken = function (text, opts) {
      return take.call(FoxyWallet, text, opts).then(function (r) {
        if (r && Number(r.changeDue) > 0) {
          try { FoxyWallet.changeForScanned(text, r); }
          catch (e) { console.warn('[foxy] change for a scanned token:', e && e.message); }
        }
        return r;
      });
    };
  }());

  window.FoxyWallet = FoxyWallet;
})();
