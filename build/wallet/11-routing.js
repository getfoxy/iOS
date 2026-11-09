    /* ---- where traffic goes ------------------------------------------- */

    /* Every change, from the native side; and the answer to the calls below. */
    _privacy: function (p) {
      var next = (p && typeof p === 'object') ? p : {};
      var wasUp = privacy.tor === 'up';
      var wasOpen = routeOpen();
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
          && (!!privacy.offlineChosen
              || !(String(next.tor || 'connecting') === 'up'
                   && String(next.network || 'unknown') !== 'none')),
        /* The holder's own choice, as against the automatic one home-first makes
         * while Tor is still coming up. Only the automatic one is given up when
         * Tor is really up; this one stays until the holder undoes it. */
        offlineChosen: !!privacy.offlineChosen && !!privacy.offline,
      };
      // for the connection diary: the moment the route opens or shuts
      noteRouteChange(wasOpen);
      /* The route went from open to shut: Tor drops the circuits it had, the spare's among them (and the phone lets go of the
       * connection it kept for it, Route.dropWarm). Kept, it was handed to the next job on the route's return as ready, and that
       * job rode a circuit Tor no longer had; let go, the return opens a new one. */
      if (wasOpen && !routeOpen()) { dropSpare(); cidListenGone(); }
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
      /* A quote sweep held for want of a route runs now that there is one.
       * After this push has been told to everyone, not inside it. */
      if (quoteSweepHeld && routeOpen()) {
        Promise.resolve().then(function () { return FoxyWallet._sweepHeldNow(); });
      }
      /* Tor has just come up on a wallet that was connected for real already (it went offline and came back in one
       * session): the payments that waited for a route are claimed now, a card's payment kept offline among them
       * (`claimUnclaimed`, which posts it). A connect does this itself, so a wallet built from storage is left to it.
       * Without this they waited for the next launch or return, and their entries spun all that while. */
      // a route that goes again before the claim's moment leaves no timer behind
      if (claimOnReturnT && !(privacy.tor === 'up' && routeOpen())) { clearTimeout(claimOnReturnT); claimOnReturnT = null; }
      if (!wasUp && privacy.tor === 'up' && wallet && !wallet.foxyFromCache) {
        clearTimeout(claimOnReturnT);
        claimOnReturnT = setTimeout(function () {
          claimOnReturnT = null;
          if (!routeOpen()) return;
          // the first claim is somebody's wait (a till's, a payer's): on the circuit kept ready, when it is free
          Promise.resolve().then(function () { return FoxyWallet.claimUnclaimed({ now: true }); }).then(null, function (e) {
            console.warn('[foxy] the payments waiting for a route, on its return:', e && e.message);
          });
        }, 1500);
      }
      /* Tor has just come up: a circuit is made ready for whatever comes next (`warmSpare`). At once on a wallet
       * that was connected for real, which is a return: the first job a person starts then takes this circuit
       * while it is still being opened (`takeSpare`), rather than asking Tor for a new one a second behind it.
       * A wallet built from storage is left to its connect, which opens one itself. */
      if (!wasUp && privacy.tor === 'up') {
        if (wallet && !wallet.foxyFromCache) warmSpare(); else warmSpareSoon();
      }
      // and the newest Bitcoin block header is fetched for the cards, if the one kept is old (08b-block-headers.js)
      if (!wasUp && privacy.tor === 'up') headerLater();
      // and what a cashier took and could not send with no route goes now (08d-till.js), not at its next minute
      if (!wasUp && privacy.tor === 'up' && routeOpen()) { tillOnRoute(); cidOnRoute(); tipOnRoute(); }
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
               offlineChosen: !!privacy.offlineChosen, network: privacy.network };
    },

    /* The person chose to carry on with no network, or to stop doing so.
     *
     * Page-side only: there is nothing to ask the native side, because nothing
     * is being turned on — `Route.start` already refuses without Tor and keeps
     * refusing. This only tells the gate to come down and the screens to say so.
     * Deliberately not `setUnprotected`, which asks iOS to draw a destructive
     * alert because that one really does put traffic on the open internet. */
    setOffline: function (on, chosen) {
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
      /* The holder's own choice (`chosen`) is the exception, and it sticks.
       *
       * A phone had WORK OFFLINE chosen while Tor was up, and twenty seconds
       * later took a payment to the mint over a connection that carried nothing:
       * the choice had been refused, or given up on the next push, because Tor
       * said `up`. What the holder asked for stands until they undo it, and the
       * banner says so. The automatic offline of home-first (no `chosen`) is the
       * one that still yields to a route. */
      privacy.offline = !!on && (!!chosen || !reallyUp);
      /* Sticky only where it used to be refused: chosen with Tor really up. Chosen while Tor is still coming (the gate's PROCEED
       * OFFLINE) is the old choice, given up when Tor is up, as the gate's scenarios pin. */
      privacy.offlineChosen = !!on && !!chosen && reallyUp;
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
    // may a mint be asked anything right now (`routeOpen`): for a screen whose words depend on it
    routeOpen: function () { return routeOpen(); },
    // and, where it may not, the words a step refused for it says (`assertRoute`): '' with a route
    routeWords: function () {
      try { assertRoute(); return ''; } catch (e) { return String((e && e.message) || ''); }
    },
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

    /* A person's switch (SWITCH MINT): it lands at once and the mint is asked behind it, even with no keys on file
     * (`connect`'s `lazy` and `emptyNow`). Resolves { id, name, balanceSats, pending, noKeys }. */
    switchTo: function (url, opts) {
      return FoxyWallet.connect(url, null, null, Object.assign({}, opts || {}, { lazy: true, emptyNow: true }));
    },

    /* Why a switch to this mint would wait for the mint instead of landing at once from the keys on file, or '' when
     * it lands at once (`lazyWaitWhy`): no route, no keys on file, keys the store could not keep. For the page's line
     * naming the path a switch took (09-melt-paste-switch.js, `justSwitch`). */
    switchWaits: function (url) {
      return lazyWaitWhy(canonicalMint(url || ''));
    },

    /* The mint switched to that has not answered yet, or null: { url, host, since, noKeys, failed }. `failed` is why it
     * did not answer when it was asked ('' while it is being asked); the phone is on it all the same. For the shield. */
    connectPending: function () {
      var c = mintPendingNow();
      return c ? { url: c.url, host: hostOf(c.url), since: c.since, noKeys: !!c.noKeys, failed: String(c.failed || '') } : null;
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
      /* The mint a visit switched to and that has not answered, asked again by somebody who did not say whether to keep it
       * (the page's `connectForRealOnceOnline`): still a visit. Kept, it became the phone's own mint behind a till, and its
       * connect ran the sweeps a visit leaves alone (review, p2). */
      var pv = mintPendingNow();
      if (pv && pv.visit && canonicalMint(url || '') === pv.url && !(opts && 'remember' in opts)) {
        opts = Object.assign({}, opts || {}, { remember: false });
      }
      /* Nor a person's switch (`switchTo`, `emptyNow`) behind a late claim's walk: the walk stops where it is and does
       * not come home over it (20-helpers.js, `walkOvertaken`), so the switch lands at once rather than showing
       * CONNECTING for as long as the walk is away. A card's visit is still waited for: it is in the middle of a card's
       * money (`cardAway`). */
      var walkOnly = !!claimingLate && !cardAway;
      var pastWalk = !!(opts && ((opts.emptyNow && opts.lazy) || opts._pastWalk));
      if (claimAway && !(opts && opts.remember === false) && !(pastWalk && walkOnly)) {
        var self = this, args = arguments;
        return homeFirst(function () { return FoxyWallet.connect.apply(self, args); });
      }
      var u = canonicalMint(url || load(K.mint, '') || '');
      var bad = mintUrlProblem(u);
      if (bad) return Promise.reject(new Error(bad));
      if (!window.CashuTS) {
        return Promise.reject(new Error('cashu-ts.js did not load. It must sit in this same folder.'));
      }
      /* Lands at once and asks the mint behind it (`opts.lazy`): a person's switch, and a till's visit.
       *
       * With the mint's keysets on file the wallet is built from them, as an offline launch builds it, and is the
       * wallet from now: `mintUrl` moves, the mint is saved as this phone's unless `remember` is false, and this
       * resolves { pending: true } with the pile's balance readable. The mint is then connected to for real in the
       * background (`_confirm`), and when it answers that wallet takes over, the sweeps a connect runs run, and the
       * page hears it (`onMintConnected`). Until then what needs the live mint is refused in the words for it
       * (`need`) or waits for it (`routeSoon`), and what is local goes on (02-dleq-lock-holds-imports.js,
       * `mintPending`). A mint that does not answer leaves the phone where it switched to, from the keys on file,
       * which is the offline state, and the app connects again for real when it can (`connectForRealOnceOnline`).
       *
       * With no keysets on file nothing can be built: a lazy connect is then the connect it always was, waited for,
       * unless the switch asks to land anyway (`opts.emptyNow`, SWITCH MINT's), and then the phone is at that mint
       * with no wallet, making nothing, until the keys come; a mint that does not answer then puts back the mint it
       * was on (there is no offline state to leave it in). With no route the lazy connect is the offline one. */
      if (opts && opts.lazy && !opts._confirm) {
        var lazyKeys = mintCacheFor(u);
        if (lazyKeys && typeof window.CashuTS.Wallet.prototype.loadMintFromCache !== 'function') lazyKeys = null;
        /* Keys this launch could not write down are older than what the mint last said (`mintCacheUnkept`): the live
         * path, waited for, with the reason said. */
        var unkept = !!mintCacheUnkept[u];
        if (unkept) lazyKeys = null;
        var plain = Object.assign({}, opts);
        delete plain.lazy;
        delete plain.emptyNow;
        // its own building and its confirmation are the person's switch too, and do not wait behind a walk either
        if (opts.emptyNow) plain._pastWalk = true;
        if (!routeOpen() || unkept || (!lazyKeys && !opts.emptyNow)) {
          // every fall-through says why, as the page's line for the switch does (`lazyWaitWhy`)
          console.log('[foxy] switch: ' + hostOf(u) + ' waits for the mint: ' + (lazyWaitWhy(u) || 'no keys on file'));
          return FoxyWallet.connect(u, null, null, plain);
        }
        var nameOf = function () { return u.replace(/^https?:\/\//, ''); };
        // already here and answered for real: nothing to switch, and nothing to ask again
        if (wallet && !wallet.foxyFromCache && canonicalMint(mintUrl || '') === u && !mintPendingNow()) {
          if (plain.remember !== false) { save(K.mint, u); chooseMint(u); }
          return Promise.resolve({ id: u, name: nameOf(), balanceSats: sumProofs(proofs()), pending: false });
        }
        var gen = ++mintPendingGen;
        var c = /** @type {any} */ ({ url: u, gen: gen, w: null, since: Date.now(), noKeys: !lazyKeys,
                                     visit: plain.remember === false, before: wallet, beforeUrl: mintUrl });
        var adopted = lazyKeys
          ? FoxyWallet.connect(u, null, null, Object.assign({}, plain, { fromCache: true }))
          : Promise.resolve(null);
        return adopted.then(function () {
          // another switch was made while this one was being built: that one is the phone's
          if (gen !== mintPendingGen) return { id: u, name: nameOf(), balanceSats: 0, pending: true, superseded: true };
          if (lazyKeys) {
            c.w = wallet;
          } else {
            // what was in hand is let go, and the old mint's ready circuit with it
            if (mintPending) mintPendingSettle(mintPending, false, '', { superseded: true });
            wallet = null;
            mintUrl = u;
            dropSpare();
          }
          mintPending = c;
          mintPendingLast = null;
          console.log('[foxy] switch: on ' + hostOf(u) + ' at once, '
            + (lazyKeys ? 'from the keys on file' : 'with no keys on file, so nothing is made there yet')
            + '; asking it behind the screen');
          // behind the answer, so the page has drawn the switch before anything it hears of the mint
          setTimeout(function () {
            if (mintPending !== c) return;
            var failed = function (why) {
              if (mintPending !== c) return;
              if (c.noKeys && !wallet && canonicalMint(mintUrl || '') === u) {
                wallet = c.before || null;
                mintUrl = c.before ? c.beforeUrl : mintUrl;
                mintPendingSettle(c, false, why, { back: !!c.before });
                return;
              }
              mintPendingFail(c, why);
            };
            if (!routeOpen()) {
              var off = '';
              try { assertRoute(); } catch (eR) { off = (eR && eR.message) || String(eR); }
              failed(off || 'no route');
              return;
            }
            FoxyWallet.connect(u, null, null, Object.assign({}, plain, { _confirm: c })).then(function (r) {
              if (r && r.stale) return;
              // a route that went while it was asked: rebuilt from the keys on file again, which is not an answer
              if (mintPending === c && !c.failed && mintPendingNow()) failed('the mint did not answer');
            }, function (e) {
              failed(FoxyWallet.reason ? FoxyWallet.reason(e) : ((e && e.message) || String(e)));
            });
          }, 0);
          return { id: u, name: nameOf(), balanceSats: sumProofs(proofs()), pending: true, noKeys: !lazyKeys, gen: gen };
        }, function (e) {
          // its building was overtaken by a later switch, which refused it (`foxyMovedOn`): that one is the phone's
          if (gen !== mintPendingGen) return { id: u, name: nameOf(), balanceSats: 0, pending: true, superseded: true };
          throw e;
        });
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
      // switches made from here on (`mintPendingGen`): one that lands elsewhere first is the person's last word
      var gen0 = mintPendingGen;

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
       * than no deadline at all. Its three public reads go on one circuit
       * made for this connect (`loadMintOnOne`). */
      var ready = cached
        ? Promise.resolve().then(function () { w.loadMintFromCache(cached.info, cached.keys); })
        : withTimeout(loadMintOnOne(w, !!(opts && opts.sessionInfo), 30000), 30000, hostOf(u));
      return ready.then(function () {
        /* A lazy switch's own confirmation (`_confirm`), arriving after the phone had gone elsewhere: let go, and
         * the wallet in hand stays. */
        if (opts && opts._confirm && (mintPending !== opts._confirm || !mintPendingNow())) {
          console.log('[foxy] switch: ' + hostOf(u) + ' answered after the phone had moved on; let go');
          return { id: u, name: u.replace(/^https?:\/\//, ''), balanceSats: sumProofs(proofs()), stale: true };
        }
        /* Any other connect that was under way when the person switched elsewhere: it does not take the phone back.
         * Refused rather than answered, so whatever asked for it (a card's visit, a till's) does not go on as though it
         * were at its mint (review, p1). */
        if (!(opts && opts._confirm) && mintPendingGen !== gen0 && canonicalMint(mintUrl || '') !== u) {
          var mv = /** @type {any} */ (new Error('The phone moved to ' + hostOf(mintUrl) + ' while ' + hostOf(u) + ' was being connected to.'));
          mv.foxyMovedOn = true;
          mv.unsent = true;
          throw mv;
        }
        wallet = w;
        mintUrl = u;
        // a switch still waiting on its mint hears that this connect has landed (`mintPendingReplaced`)
        mintPendingReplaced(w, u, !!cached);
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
        // the phone's own mint from now, and so one the person chose (`mintsChosen`); a visit is neither
        if (!opts || opts.remember !== false) { save(K.mint, u); chooseMint(u); }
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
        /* A card's visit to its own mint (08a-flashcard.js, `cardVisit`) sweeps nothing on the way there: what it is for is said
         * by whoever made it, and what is left at that mint is settled by `cardAwayLeft`, which asks for exactly that. */
        if (opts && opts.noSweep) {
          return { id: u, name: u.replace(/^https?:\/\//, ''), balanceSats: sumProofs(proofs()) };
        }
        /* Money this sweep made owed to a card that is not here (a payment's change, or a payment that never went), for the
         * app to say: the launch's own word on it came before the sweep had made it. Read off the list before and after,
         * because more than one step makes it (the held melts' sweep gives a card's holds back too). */
        var owedOut = function () {
          var ids = {};
          try {
            FoxyWallet.cardOwed().forEach(function (r) { if (r && r.out) ids[r.id] = Math.max(0, Math.round(Number(r.sats) || 0)); });
          } catch (e) { /* no card list: nothing to say */ }
          return ids;
        };
        var owedBefore = owedOut();
        /* The Cashu ID's: what its inbox read before this connect is taken now, not at the end of the catch-up below
         * (`cidOnConnect`). Not on a visit. */
        if (!opts || opts.remember !== false) cidOnConnect();
        /* Anything paid while the app was away is still sitting at the mint;
         * then any melt whose outcome was never learned, and any swap whose
         * answer was lost after the mint made it. One after another, each after
         * a pause, not all in the second the wallet connects (sweepPause). */
        // this mint's invoices; the other mints' are walked once all of this is done (below)
        FoxyWallet.sweepQuotes({ awayLater: true })
          .then(sweepPause).then(function () { return FoxyWallet.sweepMelts(); })
          .then(sweepPause).then(function () { return FoxyWallet.recoverSwaps(); })
          // a store short of room: sent tokens the mint says are claimed let go from their notes (`tidySentTokens`)
          .then(function () { return tidySentTokens().then(null, function () { return 0; }); })
          .then(sweepPause).then(function () { return FoxyWallet.claimUnclaimed(); })
          // and a till's: what a cashier still has to send, and what a keeper kept for this mint (08d-till.js)
          .then(function () { tillCatchUp(); cidCatchUp(); tipOnRoute(); })
          // and a card's pieces it signed for while the mint was not answering (08a-flashcard.js)
          .then(function () { return FoxyWallet.cardTaken().length ? FoxyWallet.cardSettle() : null; })
          // and change due to a card that could not be made when it paid
          .then(function () { return FoxyWallet.cardDue().length ? FoxyWallet.cardDueRetry() : null; })
          // and a card's payment out of this phone that never went: what it paid goes back to it (08a-flashcard.js, `cardOutsLeft`)
          .then(function () { return FoxyWallet.cardOutHeld().length ? FoxyWallet.cardOutsLeft() : null; })
          .catch(function () {})
          /* And what was left between two mints: a crossing paid and not
           * claimed, a payment taken at a payer's mint and not yet home, a
           * payment somebody refused. Not on a visit — these are what a
           * visit is made by. */
          .then(function () {
            if (opts && opts.remember === false) return null;
            return FoxyWallet.crossingsWaiting() ? FoxyWallet.catchUpCrossings() : null;
          })
          /* And what a card at another mint left there when it paid this phone from it (a payment out of its hold that never
           * went, a signature whose answer was lost): settled at that mint, on a visit, and this phone home again
           * (08a-flashcard.js, `cardAwayLeft`). Not on a visit, nor on the way home from one. */
          .then(function () {
            if (opts && opts.remember === false) return null;
            return FoxyWallet.cardAwayLeft().then(null, function () { return null; });
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
              var owedNow = owedOut(), cardOwed = 0;
              Object.keys(owedNow).forEach(function (id) { if (!(id in owedBefore)) cardOwed += owedNow[id]; });
              try { FoxyWallet._onCaughtUp({ cardOwed: cardOwed }); } catch (x) {}
            }
          })
          /* And card loads kept at this mint that the mint may say are spent (08a-flashcard.js, `cardLoadsSpent`): started
           * here and waited for by nothing, on a circuit of its own, at most once an hour a mint. */
          .then(function () { try { cardLoadsSpent(w, u).then(null, function () { return 0; }); } catch (x) {} })
          /* Then the invoices this phone made at other mints (`_sweepAway`): after, not in front, so a mint that does not
           * answer holds back none of the above. */
          .then(function () { return FoxyWallet._sweepAway(); })
          .catch(function () {});
        /* Sent tokens are not asked about here. Every connect used to ask the
         * mint about each one still on file: the sender's own exit asking after
         * proofs the receiver then redeems told the mint who paid whom. A
         * token is asked about only while its screen is open (watchToken). */
        return {
          id: u,
          name: u.replace(/^https?:\/\//, ''),
          balanceSats: sumProofs(proofs()),
          // how many of the mint's info, keysets and keys came from this session's answers (`loadMintOnOne`), for a crossing's log
          fromSession: Number(w.foxyLoadCached) || 0,
        };
      }).catch(function (e) {
        // what the mint said about itself is not trusted past a connect that failed: the next one asks (`INFO_TTL_MS`)
        if (!cached) forgetMintInfo(u);
        // a connect overtaken by a switch, or whose wallet has since been replaced, puts nothing back over the one in hand
        if ((e && e.foxyMovedOn) || (wallet !== before && wallet !== w)) throw e;
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

