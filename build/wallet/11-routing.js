    /* ---- where traffic goes ------------------------------------------- */

    /* Every change, from the native side; and the answer to the calls below. */
    _privacy: function (p) {
      var next = (p && typeof p === 'object') ? p : {};
      var wasUp = privacy.tor === 'up';
      privacy = {
        tor: String(next.tor || 'connecting'),
        progress: Number(next.progress) || 0,
        everUp: !!next.everUp,
        unprotected: !!next.unprotected,
        transport: String(next.transport || 'direct'),
        orbot: String(next.orbot || 'none'),
        firstSetup: !!next.firstSetup,
        /* Is a tunnel up right now (Route.swift asks the system every time).
         * This list is a whitelist — a field the native side sends and this
         * does not name is dropped here and never reaches the gate or the
         * banner, which is exactly what happened to `vpn` when it was added
         * everywhere else first. */
        vpn: !!next.vpn,
        orbotKey: !!next.orbotKey,
        /* wifi, cellular, wired, other, none, or unknown before the system has
         * answered. 'none' is the one that matters: there is no interface, so Tor
         * cannot connect through anything and nothing should pretend it might. */
        network: String(next.network || 'unknown'),
        /* Not from the native side, and not dropped by it either.
         *
         * Working offline is a choice the person made in the page, so nothing
         * Swift pushes carries it — and this function rebuilds the whole record
         * from what Swift sent, which would throw the choice away on the next
         * push. Carried forward explicitly, and surrendered the moment Tor is
         * really up, because at that point offline is a worse version of what
         * the person already has.
         *
         * "Really" is the whole of it: Tor's `up` outlives the interface, so a
         * push carrying a stale one threw the person's choice away while their
         * radios were off — the fourth place that believed it, after the gate,
         * `setOffline` and `routeOpen`. All four have to agree or
         * the screens and the wallet argue about what this phone can reach. */
        offline: !!privacy.offline
          && !(String(next.tor || 'connecting') === 'up'
               && String(next.network || 'unknown') !== 'none'),
      };
      if (window.FoxyGate && window.FoxyGate._changed) {
        try { window.FoxyGate._changed(FoxyWallet.privacy()); }
        catch (e) { console.error('[foxy] gate:', e && e.message); }
      }
      if (FoxyWallet._onPrivacy) {
        try { FoxyWallet._onPrivacy(FoxyWallet.privacy()); }
        catch (e) { console.error('[foxy] privacy watcher:', e && e.message); }
      }
      // whatever was waiting for a route that was on its way hears how that ended (`routeSoon`)
      routeChanged();
      // Tor has just come up: a circuit is made ready for whatever comes next (`warmSpare`)
      if (!wasUp && privacy.tor === 'up') warmSpareSoon();
      // and the newest Bitcoin block header is fetched for the cards, if the one kept is old (08b-block-headers.js)
      if (!wasUp && privacy.tor === 'up') headerLater();
      return FoxyWallet.privacy();
    },

    /* A copy, so nothing outside can change what the wallet believes. */
    /* A copy, so a caller cannot edit the wallet's own record.
     *
     * This names every field a second time, which means a field added to
     * `_privacy` and not to this one is silently dropped between the wallet
     * and everybody who reads it — which is what happened to `vpn`:
     * the native side sent it, `_privacy` was taught it, and the
     * gate still never saw it because the copy here left it behind. Both
     * lists, every time. */
    privacy: function () {
      return { tor: privacy.tor, progress: privacy.progress, everUp: privacy.everUp,
               unprotected: privacy.unprotected, transport: privacy.transport,
               orbot: privacy.orbot, firstSetup: privacy.firstSetup,
               vpn: privacy.vpn, orbotKey: privacy.orbotKey, offline: privacy.offline,
               network: privacy.network };
    },

    /* The person chose to carry on with no network, or to stop doing so.
     *
     * Page-side only: there is nothing to ask the native side, because nothing
     * is being turned on — `Route.start` already refuses without Tor and keeps
     * refusing. This only tells the gate to come down and the screens to say so.
     * Deliberately not `setUnprotected`, which asks iOS to draw a destructive
     * alert because that one really does put traffic on the open internet. */
    setOffline: function (on) {
      /* Refused only when there is a real route to refuse it for.
       *
       * This was `privacy.tor !== 'up'`, and Tor's `up` is a circuit Foxy built
       * that survives the interface going away for as long as its deadline takes
       * to notice. So with the radios off and a stale `up`, the gate said NO
       * CONNECTION, the person tapped PROCEED OFFLINE, and this said no — the
       * gate came down, the launch put it back, and round again about once a
       * second.
       *
       * The path monitor is the current answer to "can this phone reach
       * anything", so where the two disagree it wins here exactly as it wins in
       * the gate (`noNetwork`). */
      var reallyUp = privacy.tor === 'up' && privacy.network !== 'none';
      privacy.offline = !!on && !reallyUp;
      /* Choosing to work offline puts down the choice to work unprotected.
       *
       * They are opposite intents — one sends nothing, the other sends everything
       * in the clear — and a phone that holds both says the louder one on every
       * screen. A phone did exactly that: CONTINUE UNPROTECTED on the
       * failed screen, then PROCEED OFFLINE a second later, and the home screen
       * read IP ADDRESS EXPOSED while the radio was off.
       *
       * Only in this direction. Going unprotected does not clear offline, because
       * `unprotected` is answered in an iOS alert and that is the deliberate act;
       * this one is a page button and must not be able to undo it by accident. */
      if (privacy.offline && privacy.unprotected) {
        privacy.unprotected = false;
        console.log('[foxy] working offline, so the unprotected choice is put down');
        if (FoxyWallet.setUnprotected) {
          FoxyWallet.setUnprotected(false).catch(function (e) {
            console.warn('[foxy] could not clear unprotected natively:', e && e.message);
          });
        }
      }
      if (window.FoxyGate && window.FoxyGate._changed) {
        try { window.FoxyGate._changed(FoxyWallet.privacy()); }
        catch (e) { console.error('[foxy] gate:', e && e.message); }
      }
      if (FoxyWallet._onPrivacy) {
        try { FoxyWallet._onPrivacy(FoxyWallet.privacy()); }
        catch (e) { console.error('[foxy] privacy watcher:', e && e.message); }
      }
      console.log('[foxy] working offline: ' + (privacy.offline ? 'yes' : 'no'));
      routeChanged();
      return FoxyWallet.privacy();
    },

    /* A connection that is on its way, and the wait for it (`routeSoon`):
     * for the screens, which say SECURING YOUR CONNECTION while it is true
     * and hold a step a few seconds for it rather than take the offline way. */
    routeComing: function () { return routeComing(); },
    routeSoon: function (ms) {
      return routeSoon(ms === undefined ? FoxyWallet._routeWaitMs : ms);
    },
    // how long a money step waits for a route that is on its way; the suites set 0
    _routeWaitMs: ROUTE_WAIT_MS,

    refreshPrivacy: function () {
      return bridgeAsk('privacy', {}, 5000).then(applyPrivacy);
    },

    /* Ask Tor to try again. It keeps the daemon it has: there can only be one
     * per process. */
    torRetry: function () {
      return bridgeAsk('torRetry', {}, 5000).then(applyPrivacy);
    },

    /* The person's choice, for this session. Tor connecting clears it.
     * Turning it on waits on an iOS alert, so the deadline is a person's,
     * not a machine's. */
    /* ALLOW FOXY IN ORBOT: opens Orbot's approval screen for a key with bypass.
     * Orbot copies the key; the native side picks it up on return. */
    orbotRefresh: function () {
      return bridgeAsk('orbotRefresh', {}, 10000);
    },

    orbotAccess: function () {
      return bridgeAsk('orbotAccess', {}, 10000);
    },

    setUnprotected: function (on) {
      return bridgeAsk('unprotected', { on: on !== false }, on !== false ? 600000 : 5000).then(applyPrivacy);
    },

    /* Is the wallet in hand one that was rebuilt from the cache rather than
     * loaded from the mint? True until a connect with a route replaces it. */
    fromCache: function () {
      return !!(wallet && wallet.foxyFromCache);
    },

    /* Can this mint be connected to with no route? Only if it told this phone
     * its keysets at some point. The mint list asks, so a mint that cannot be
     * reached offline is greyed out rather than tapped and refused. */
    mintCached: function (url) {
      return !!mintCacheFor(canonicalMint(url || ''));
    },

    /* Is there anything to work offline WITH?
     *
     * Two things, and both have to have happened at least once on this phone:
     *
     *   its mint's keysets are on file, or there is no wallet at all — no
     *   balance, no mint to select, nothing spendable (mintCacheSave);
     *   and a bitcoin price has been fetched, or every dollar figure is blank
     *   and the keypad can only count sats (K.rate).
     *
     * Without them "work offline" is a door into an empty room, which is what
     * happened the first time: a phone launched in airplane mode
     * that had never connected, offered the choice, and took it.
     * So the choice is not offered until it means something. */
    offlineReady: function () {
      var at = canonicalMint(mintUrl || load(K.mint, '') || '');
      if (!at || !mintCacheFor(at)) return false;
      return !!(Number(FoxyWallet._rate) > 0 && Number(FoxyWallet._rateAt) > 0);
    },

    /* Point at a mint. Called with no argument it reuses the saved one.
     *
     * With no route this connects from what the mint said last time
     * (mintCacheSave): the keysets are all an offline wallet needs, and without
     * them there is no wallet, no balance and no mint to select. A mint never
     * connected to on this phone still refuses, with the same words as before —
     * there is nothing written down to connect from. */
    connect: function (url, _unusedInvoiceKey, _unusedAdminKey, opts) {
      // storage from a newer Foxy: nothing that could change it runs (see the header)
      if (storageNewer) throw new Error(STORAGE_NEWER);
      /* A mint somebody chose waits for a late claim to come home.
       *
       * That walk goes back to where it started when it is done (`claimAway`),
       * and a switch made while it was away was undone by that: the phone
       * on the old mint, with the new one saved as its own. Visits, which are
       * what the walk itself makes, do not wait. */
      if (claimAway && !(opts && opts.remember === false)) {
        var self = this, args = arguments;
        return homeFirst(function () { return FoxyWallet.connect.apply(self, args); });
      }
      var u = canonicalMint(url || load(K.mint, '') || '');
      var bad = mintUrlProblem(u);
      if (bad) return Promise.reject(new Error(bad));
      if (!window.CashuTS) {
        return Promise.reject(new Error('cashu-ts.js did not load. It must sit in this same folder.'));
      }
      /* Offline and a cache for this mint: connect from it. Offline and none:
       * the refusal assertRoute would have thrown anyway. */
      /* Or asked for from the cache, route or no route (`opts.fromCache`): a
       * launch shows the home screen from what is on file and speaks to the
       * mint afterwards, where it used to hold the screen for the mint's
       * answer over Tor, three to six seconds, whenever Tor happened to be up
       * first. Such a wallet is marked as one from the cache, and the app
       * connects for real behind it (`connectForRealOnceOnline`). */
      var cached = (routeOpen() && !(opts && opts.fromCache)) ? null : mintCacheFor(u);
      if (cached && typeof window.CashuTS.Wallet.prototype.loadMintFromCache !== 'function') cached = null;
      if (!cached) assertRoute();
      /* What is connected now, to put back if this does not come off.
       *
       * A failure used to leave `wallet = null`, which is right for a first
       * connect and wrong for every other: a phone that had been working
       * offline from its cache found a route, tried the mint for real, the mint
       * was slow, and the wallet it had been using was thrown away. Two
       * payments were then refused "No mint connected yet" by a phone that had
       * taken one a minute before. A connect
       * that fails changes nothing. */
      var before = wallet, beforeUrl = mintUrl;

      // deterministic secrets, so the seed alone can rebuild everything
      return connectSeed().then(function (seed) {
      /* newWallet() routes every call through the native side, which sends it
       * over Tor or refuses it — a dead daemon means a refused connection,
       * never a request going out in the clear. */
      /* `wopts`, not `opts`: this used to be called `opts` too, and shadowed the
       * caller's, so `remember: false` was read off the wallet's build options
       * and never once honoured. */
      var wopts = seed ? {
        bip39seed: seed,
        secretsPolicy: 'deterministic',
        // every wallet object reserves from the same stored counters; the
        // per-object write-back that used to follow could move one down
        counterSource: sharedCounters,
        // a mint that advertises NUT-12 must prove every signature; one that
        // left the proof out could sign this wallet with a key of its own
        requireSigDleq: true,
      } : {};
      var w = newWallet(u, wopts);
      /* A deadline, like every other call in this file.
       *
       * This had none, so a mint that accepted the connection and never
       * answered left the app on "connecting" for as long as anyone waited —
       * no error, no card, no way back. Seen on device: with embedded Tor on,
       * Minibits hung while two other mints connected normally.
       *
       * 30 seconds rather than the 20 used elsewhere: loadMint over Tor is
       * genuinely slow, and a deadline that fires on a working mint is worse
       * than no deadline at all. */
      var ready = cached
        ? Promise.resolve().then(function () { w.loadMintFromCache(cached.info, cached.keys); })
        : withTimeout(onCircuit(w).loadMint(), 30000, hostOf(u));
      return ready.then(function () {
        wallet = w;
        mintUrl = u;
        // the circuit kept ready was for the mint before this one
        dropSpare();
        warmSpareSoon();
        // a locked payment a page that is gone never heard back about: out of the balance until the mint says
        try { holdUnanswered(u); } catch (eh) { console.warn('[foxy] could not hold an unanswered payment\u2019s pieces:', eh && eh.message); }
        /* What this mint is and what it will take, once, on connect.
         *
         * Three things decide how Foxy talks to a mint and all three are the
         * mint's to choose: its software and version, the most it will accept
         * in one array (NUT-06 max_array_length, which CDK 0.18 and Nutshell
         * 0.21 began sending and which Foxy now clamps its restore batches and
         * its checkstate to), and which NUTs it claims. A report from a phone
         * is much easier to answer with these in it than without, and none of
         * them is anybody's money. */
        try {
          var info = w.mintInfo || (w.getMintInfo && w.getMintInfo());
          var nuts = info && info.nuts ? Object.keys(info.nuts).sort(function (a, b) {
            return Number(a) - Number(b);
          }).join(',') : '?';
          console.log('[foxy] mint', hostOf(u), '|', (info && info.version) || 'version not said',
                      '| max array', mintArrayCap(w), '| nuts', nuts);
        } catch (e) {
          console.log('[foxy] mint', hostOf(u), '\u2014 could not read what it says about itself');
        }
        migrateProofs();
        var firstTimeHere = rememberMint(u);
        if (!opts || opts.remember !== false) save(K.mint, u);
        /* Offline, everything below is a request. The wallet is built, the
         * balance is readable and locked ecash can be taken; nothing is swept
         * and nothing is probed until there is a route to do it over. */
        if (cached) {
          /* Marked, because this wallet has never spoken to its mint: the
           * keysets may have rotated, the sweeps have not run, and nothing paid
           * while the phone was away has been claimed. The app watches for a
           * route and connects again for real (fromCache). */
          try { w.foxyFromCache = true; } catch (e) {}
          console.log('[foxy] offline: ' + hostOf(u) + ' rebuilt from the keysets it gave us, '
                      + Math.max(0, Math.floor(Date.now() / 1000) - (cached.at || 0)) + 's ago');
          return {
            id: u,
            name: u.replace(/^https?:\/\//, ''),
            balanceSats: sumProofs(proofs()),
          };
        }
        /* What this mint just said, kept for a launch with no route. */
        mintCacheSave(u, w);
        checkKeysetsElsewhere(u, w, 0);
        if (firstTimeHere) probeMintNodeNow(u, w); else probeMintNode(u, w);
        /* Anything paid while the app was away is still sitting at the mint;
         * then any melt whose outcome was never learned, and any swap whose
         * answer was lost after the mint made it. One after another, each after
         * a pause, not all in the second the wallet connects (sweepPause). */
        FoxyWallet.sweepQuotes()
          .then(sweepPause).then(function () { return FoxyWallet.sweepMelts(); })
          .then(sweepPause).then(function () { return FoxyWallet.recoverSwaps(); })
          .then(sweepPause).then(function () { return FoxyWallet.claimUnclaimed(); })
          // and a card's pieces it signed for while the mint was not answering (08a-flashcard.js)
          .then(function () { return FoxyWallet.cardTaken().length ? FoxyWallet.cardSettle() : null; })
          // and change due to a card that could not be made when it paid
          .then(function () { return FoxyWallet.cardDue().length ? FoxyWallet.cardDueRetry() : null; })
          .catch(function () {})
          /* And what was left between two mints: a crossing paid and not
           * claimed, a payment taken at a payer's mint and not yet home, a
           * payment somebody refused. Not on a visit — these are what a
           * visit is made by. */
          .then(function () {
            if (opts && opts.remember === false) return null;
            return FoxyWallet.crossingsWaiting() ? FoxyWallet.catchUpCrossings() : null;
          })
          /* And then the page is told the wallet is connected and caught up,
           * whether or not anything was waiting. The small-change pool was
           * topped up only after a payment taken while online, so a phone
           * that spent its small pieces offline and then found a network
           * stayed short of them until somebody happened to pay it. After the claims,
           * because what was taken offline is
           * what there is to break. */
          .then(function () {
            if (typeof FoxyWallet._onCaughtUp === 'function') {
              try { FoxyWallet._onCaughtUp(); } catch (x) {}
            }
          });
        /* Sent tokens are not asked about here. Every connect used to ask the
         * mint about each one still on file: the sender's own exit asking after
         * proofs the receiver then redeems told the mint who paid whom. A
         * token is asked about only while its screen is open (watchToken). */
        return {
          id: u,
          name: u.replace(/^https?:\/\//, ''),
          balanceSats: sumProofs(proofs()),
        };
      }).catch(function (e) {
        wallet = before || null;
        if (before) {
          mintUrl = beforeUrl;
          console.warn('[foxy] connect to ' + hostOf(u) + ' failed; still on '
            + hostOf(beforeUrl) + ' as before');
        }
        throw e;
      });
      });
    },

