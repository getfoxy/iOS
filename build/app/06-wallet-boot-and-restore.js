

  /* wallet wiring */

  // loads the wallet layer, then either reconnects or asks for a pairing scan
  bootWallet() {
    this.mirrorConsole();
    this.watchEdgeSwipe();
    // Tor comes first. Until it connects, or the person chooses to continue
    // unprotected, the native side refuses every mint call, price and address
    // lookup; the gate's screens only say why.
    this._gateThenBoot = () => {
      const G = window.FoxyGate;
      if (!G) return this.bootWalletNow();
      // The verifying screen is held open across the wallet search, so the
      // app's own SEARCHING FOR WALLET screen never gets a frame to itself.
      const done = () => {
        if (G.holdVerify) G.holdVerify(false);
        /* Home first, no screen of the gate's ever went up, so nothing told
         * the phone the page had the screen: the splash would sit over a
         * loaded home screen for the eight seconds of its backstop. */
        if (G.uncover && !G.visible()) G.uncover();
      };
      if (G.holdVerify) G.holdVerify(true);
      return G.check(() => this._gateThenBoot()).then(ok => {
        // Tor could not connect: that screen is up with RETRY and CONTINUE UNPROTECTED
        if (!ok) { this.setState({ walletSearching: false }); return done(); }
        // An already-connected wallet must not be booted again: reconnecting
        // lands on the home screen, which is why passing the gate mid-session
        // threw you off whatever screen you were on.
        const W = window.FoxyWallet;
        /* The price, started beside the mint rather than behind it.
         *
         * The launch screen waits for the balance, and the balance waits for
         * the price (refreshBalance). The price needs no mint — only a route,
         * which passing the gate has just proved — so it used to sit idle for
         * the whole of connect and then take its own two to ten seconds after
         * it. rate() shares a request already in flight, so the ask inside
         * refreshBalance joins this one rather than starting a second. */
        if (W && W.rate) W.rate().catch(() => {});
        if (W && W.connected) return done();
        return Promise.resolve(this.bootWalletNow()).catch(() => {}).then(done);
      }).catch(done);
    };
    if (this.props.startStatic) return;
    this.watchKeyboard();
    this.watchWake();
    this.armKeyboardPrimer();
    // the gate lives outside the runtime, so it has to ask for a render
    window.__foxyGateChanged = () => this.setState({ gateTick: Date.now() });
    const load = src => new Promise((ok, no) => {
      if (document.querySelector('script[src="' + src + '"]')) return ok();
      const el = document.createElement('script');
      el.src = src; el.onload = ok; el.onerror = () => no(new Error(src + ' did not load'));
      document.head.appendChild(el);
    });
    load('qrcode.js')
      // only present on the ecash build; the LNbits build has no such file and
      // must not fail because of it
      .then(() => load('cashu-ts.js').catch(() => {}))
      // no bip39.js: the words are made, shown and checked on the phone, never in this page
      .then(() => load('foxy-send-progress.js').catch(() => {}))
      // and its receiving counterpart: "verifying ecash" (FoxyReceiving)
      .then(() => load('foxy-receive-progress.js').catch(() => {}))
      // and the one for a token from a mint you do not use (FoxyMoving)
      .then(() => load('foxy-move-progress.js').catch(() => {}))
      .then(() => load('foxy-tor-gate.js').catch(() => {}))
      .then(() => load('foxy-wallet.js'))
      /* The seed comes in here, and nowhere earlier.
       *
       * bootWallet is what loads foxy-wallet.js, so nothing before this line
       * can ask the wallet for anything. An earlier version waited for the
       * wallet in componentDidMount and made bootWallet wait for that — a
       * circle, broken only by a timeout, after which the app booted with no
       * wallet, found no seed, and generated one over a real one. */
      .then(() => {
        const W = window.FoxyWallet;
        /* Redraw when the route changes, so the home banner is never a moment
         * behind what it is telling the person about their IP address. */
        if (W.onPrivacy) W.onPrivacy(() => {
          this.setState({ routeAt: Date.now() });
          this.sayBackOnline();
          this.connectForRealOnceOnline();
          this.claimWhenRouteReturns();
        });
        // A mint whose signatures do not match the keys it publishes is broken
        // or singling this wallet out. Said plainly, with nothing to retry.
        if (W.onMintTrouble) {
          W.onMintTrouble((t) => {
            if (t.badSignatures) { this.badSignatureCard(t.mint, t.where); return; }
            if (t.keysetsUnseen) {
              this.blockedCard('mintTrouble', {
                tone: 'warn',
                title: 'THIS MINT MAY BE MARKING THIS WALLET',
                reason: t.mint + ' gave this wallet signing keys it does not show to anyone else. '
                  + 'Ecash signed with them could be recognised wherever it is spent. '
                  + 'Your ecash is kept. Consider moving your balance to another mint.',
              });
              return;
            }
            this.blockedCard('mintTrouble', {
              tone: 'warn',
              title: 'THIS MINT FAILED A SIGNATURE CHECK',
              reason: t.mint + ' issued ' + t.invalid + ' proof' + (t.invalid === 1 ? '' : 's')
                + ' whose signature does not match the keys it publishes. The ecash is kept, '
                + 'but a mint doing this may be marking this wallet. Consider moving your balance to another mint.',
            });
          });
        }
        // Ecash a payment found spent elsewhere was taken out of the balance: said.
        if (W.onSpentElsewhere) {
          W.onSpentElsewhere((r) => {
            this.toast(this.group(r.sats) + ' sats of your ecash had already been spent elsewhere, '
              + 'so they are no longer in your balance.', true);
            this.refreshBalance();
            this.offerQuarantine();
          });
        }
        // A paid invoice that will not claim is said, not only logged.
        if (W.onClaimTrouble) W.onClaimTrouble((hit) => this.showStuckInvoice(hit));
        /* The one question the wallet cannot answer for itself: both phones are
         * offline and a payment has arrived that nothing here can settle. The
         * card returns the person's answer, and no handler at all means no — so
         * a build without this line takes no money on trust rather than taking
         * it silently. */
        if (W.onOfflineOffer) W.onOfflineOffer((info) => this.offlineRiskCard(info));
        if (W.onChangeStuck) W.onChangeStuck((info) => this.changeStuckCard(info));
        if (W.onChangeMaking) W.onChangeMaking((info) => this.changeMaking(info));
        if (W.onTrustLost) W.onTrustLost((info) => this.trustLostCard(info));
        if (W.onTrustSettled) W.onTrustSettled((info) => this.trustSettled(info));
        // the launch screen has gone: the tap may listen now (26d-tap.js)
        if (!this._gateDownHeard) {
          this._gateDownHeard = true;
          window.addEventListener('foxy-gate-down', () => {
            if (this.syncTap) this.syncTap();
            // and the camera may come back to a scan screen (syncPreview)
            if (this.syncPreview) this.syncPreview();
          });
          window.addEventListener('foxy-gate-up', () => { if (this.syncPreview) this.syncPreview(); });
        }
        if (W.onLateClaim) W.onLateClaim((info) => this.moneyIsSafe(info));
        /* A payment Foxy was closed in the middle of making. The mint had made
         * it, so it is rebuilt from what was written down and put on its own
         * entry — but it never reached the other phone, and the person has to
         * be told or it sits in history as a payment that looks sent. */
        if (W.onSendRebuilt) W.onSendRebuilt((info) => {
          this.refreshBalance();
          if (this.loadHistory) this.loadHistory();
          if (info && info.change) return;
          this.toast('A payment was cut short when Foxy closed. It is in your history, ready to hand over.', true);
        });
        /* A payment taken at a payer's mint and not home yet, looked at by
         * the wallet on a launch or a connection: landed, on its way, to be
         * asked about, or sent back (26d-tap.js `carryOutcome`). */
        if (W.onCarry) W.onCarry((r) => { if (this.carryOutcome) this.carryOutcome(r, {}); });
        // a crossing of this phone's own, finished late: the sats are at the mint it paid toward
        if (W.onMoveFinished) W.onMoveFinished((info) => {
          this._seenTx = this._seenTx || {};
          if (info && info.quote) this._seenTx[info.quote] = true;
          this.refreshBalance();
          if (this.loadHistory) this.loadHistory();
          const at = this.mintNameOf ? (this.mintNameOf(info && info.to) || 'the other mint') : 'the other mint';
          this.toast(this.group(Math.round(Number(info && info.sats) || 0)) + ' sats you moved have arrived at ' + at + '.');
        });
        /* Ecash another phone refused and did not send back, settled now
         * that there is a route: safe again, or found redeemed. */
        if (W.onAtRisk) W.onAtRisk((info) => {
          this.refreshBalance();
          if (this.loadHistory) this.loadHistory();
          const sats = this.group(Math.round(Number(info && info.sats) || 0));
          if (info && info.state === 'taken') {
            this.blockedCard('atRiskTaken', {
              tone: 'warn',
              title: 'THEY TOOK THE PAYMENT',
              reason: 'A payment they refused was redeemed afterwards: ' + sats + ' sats. Its entry in your history now says paid.',
              chip: 'If they are sending it back, they will show you a code to scan. If they were paid a second time for it, that is theirs to give back.',
            });
          } else if (info && info.state === 'refunded') {
            this.toast('The ' + sats + ' sats they refused came back, locked to this phone.');
          } else if (info && info.state === 'safe') {
            this.toast('The ' + sats + ' sats they refused are safe again.');
          }
        });
        // a payment somebody refused, swapped back into the wallet by itself
        if (W.onTakenBack) W.onTakenBack((info) => {
          this.refreshBalance();
          if (this.loadHistory) this.loadHistory();
          this.toast('The ' + this.group(Math.round(Number(info && info.sats) || 0)) + ' sats they did not take are back in your wallet.');
        });
        // back on a network and caught up: fill the small-change pool again
        W._putAway = (on) => this.putAway(on);
        /* The lock at boot (18-lifecycle-and-chart.js) runs before the wallet
         * is on the page, and with no wallet it cannot know a PIN is set: a
         * phone killed and reopened came up on its last screen with no PIN
         * asked, while a return from the background asked it. Asked here
         * instead, once, now that the wallet can say. */
        if (!this._lockedOnce && this.pinLock) this.pinLock();
        if (W.onCaughtUp) W.onCaughtUp(() => {
          console.log('[foxy] small change: connected and caught up; checking the pool');
          this.refreshBalance();
          if (this.tidyChangeLater) this.tidyChangeLater();
        });
        // the phone turned over: the invoice screen follows (syncFlip)
        if (W.onTurned) W.onTurned((on) => this.setState({ upsideDown: !!on }));
        /* The paying phone's price, for a request this phone made in dollars.
         * Nothing has moved: the card is a person agreeing to a number, and
         * only their ACCEPT sends the request back in sats. */
        if (W.onTapQuote) W.onTapQuote((text) => this.tapPriceOffered(text));
        // the payer says it has paid this screen's invoice over Lightning (26d-tap.js)
        if (W.onTapPaid) W.onTapPaid((info) => this.tapPaidNotice(info));
        // A mint that has stopped answering, once a session per mint (11-mint-risk.js).
        if (W.onMintDown) W.onMintDown((mint) => this.mintDownNotice(mint));
        if (W.stuckInvoices) {
          // ones left over from an earlier launch, once the first sweep has had its go
          setTimeout(() => W.stuckInvoices().forEach(hit => this.showStuckInvoice(hit)), 15000);
        }
        /* No screen in this page shows the words any more: the phone's own
         * screens hide them from a recording and warn after a screenshot. */
        if (W.captureCheck) W.captureCheck();
        /* The native side says when Foxy returns, and for how long it was away.
         * watchWake registers for that when it first runs, which can be before
         * this script had loaded, and then the registration silently never
         * happened: every return reached the app only through page events,
         * which carry no time away, so the confirming screen never showed at
         * once after a long absence. Registering again here is harmless. */
        if (W.onResume && this._onWake) W.onResume(this._onWake);
        /* After the lock, not beside it. The seed lives in a keychain item that
         * needs Face ID or the passcode; read while the lock screen is up, it
         * asked for its own Face ID on top of the lock's. Read after a Face ID
         * unlock, the unlock's approval covers it. */
        /* Home first, the home screen is what is drawn, and the phone's
         * cover comes off it now rather than at its own four seconds. With
         * the lock up, the lock says so itself (pinLock, 10-pin.js). */
        const G0 = window.FoxyGate;
        if (G0 && G0.isHomeFirst && G0.isHomeFirst() && !this._pinLocked && !G0.visible() && G0.uncover) G0.uncover();
        return this.pinUnlocked().then(() => {
          /* One screen from here to a loaded balance: Tor, the mint, then the
           * balance. It used to come down once the mint answered, so the home
           * screen showed before its balance had loaded. */
          const G = window.FoxyGate;
          if (G && G.holdVerify) G.holdVerify(true);
          if (G && G.showLaunch) G.showLaunch();
          /* The seed read is the Face ID prompt, so the fox starts running
           * here — through the asking, not after it. */
          if (G && G.introStart) G.introStart();
          return W.seedReady ? W.seedReady() : null;
        });
      })
      .then(r => {
        /* Face ID is behind us — the seed read is what asks for it — so the
         * intro can run now. Starting it earlier meant the fox was halfway
         * through his stretch while the prompt was still up. It runs whether the seed was read or not: a phone that
         * refused is a screen the person is looking at either way. */
        const G = window.FoxyGate;
        if (G && G.introGo) G.introGo();
        return r;
      })
      .then(() => this._gateThenBoot())
      .catch(e => {
        console.warn('[wallet]', e);
        // nothing else is coming to take the launch screen down
        const G = window.FoxyGate;
        if (G && G.introGo) G.introGo();
        if (G && G.holdVerify) G.holdVerify(false);
        if (G && G.visible && G.visible() && G.hide) G.hide();
        this.setState({ walletErr: String(e && e.message || e) });
      });
  }

  /* Everything past the gate: runs once Tor is up or the person chose to
   * continue. Resolves once the balance has loaded, the mint has failed three
   * times, or 45 seconds have passed; the launch screen stays up until then. */
  bootWalletNow() {
    const W = window.FoxyWallet;
    const saved = W.saved();
    const G = window.FoxyGate;
    if (G && G.launchStage) {
      const url = (saved && saved.url) || W.defaultMint;
      /* The step is named for the log's sake, not the screen's: the launch
       * screen shows one title and never says which mint this is. */
      G.launchStage('mint', 60, 92);
    }
    return new Promise(settled => {
      this.settleLaunch();                       // an earlier boot's wait ends here
      this._launchSettled = settled;
      // a mint that neither answers nor refuses does not hold the screen for good
      this._launchCapT = setTimeout(() => this.settleLaunch(), 45000);
      // A saved mint is used as saved; only a fresh install takes the default.
      // Falling back from one to the other would hide the balance held at the
      // saved mint, which is exactly what per-mint storage exists to prevent.
      /* Home first, the wallet is built from what is on file, at once, and
       * the mint is spoken to behind the home screen. */
      const fromFile = !!(G && G.isHomeFirst && G.isHomeFirst());
      this.retryConnect(saved && saved.url ? undefined : W.defaultMint, 0, fromFile);
    });
  }

  /* Back from the background: a private connection set up again, as at
   * launch, and the home screen only once the balance has loaded. Tor went
   * off the network as Foxy left, and the native side is setting it up now;
   * nothing is tried on the connection from before. The same screen as
   * launch: CONNECTING TO TOR, then Loading your balance. */
  setUpAfterReturn() {
    const G = window.FoxyGate;
    const W = window.FoxyWallet;
    if (!G || !W) return null;
    // never got as far as a wallet: that is launch, and launch's boot does it
    if (!W.connected) return this._gateThenBoot ? this._gateThenBoot() : null;
    if (this._returning) return this._returning;
    const run = this.pinUnlocked().then(() => {
      /* Back with the connection Foxy left with: nothing to set up, so no
       * screen about setting it up.
       *
       * The native side keeps Tor on the network for a few seconds after Foxy
       * is put away, and up to twenty while a payment is with the mint, so a
       * glance at another app comes back to a circuit that never went down
       * ("nothing to set up", TorService.resumed). The launch screen went up
       * over it all the same and played its ending: a second and a half of
       * SECURING YOUR CONNECTION after one second away, with SEND's camera
       * dark behind it. Asked of the phone now, not read from what the page
       * last heard: a circuit taken down while Foxy was away says so here. */
      const asked = W.refreshPrivacy ? W.refreshPrivacy().catch(() => null) : Promise.resolve(null);
      return asked.then(() => {
        if (G.connected && G.connected() && !G.visible()) {
          console.log('[foxy] back with the connection still up; no connection screen');
          // and the phone's cover over the return comes off now, not after its four seconds
          if (G.uncover) G.uncover();
          return 'quiet';
        }
        G.holdVerify(true);
        G.showLaunch();
        const checked = G.check(() => this.setUpAfterReturn());
        /* Working offline, the launch screen does not go up either, and the
         * cover was left to its four seconds on every return. Whatever the
         * reason, a return that puts up nothing says so. */
        if (G.uncover && !G.visible()) G.uncover();
        return checked;
      });
    }).then(ok => {
      // CANNOT CONNECT or Orbot is on screen; clearing it runs this again
      if (!ok) { G.holdVerify(false); return; }
      // with no screen up there is none to move along, and none to let go of
      const quiet = ok === 'quiet';
      if (!quiet) G.launchStage('balance', 60, 100);
      this.listenWallet();
      this.loadHistory();
      const swept = W.resumeSweeps ? W.resumeSweeps().catch(() => {}) : null;
      return Promise.race([
        Promise.resolve(this.resumeLoad()).catch(() => {}),
        new Promise(r => setTimeout(r, 20000)),
      ]).then(() => {
        if (!quiet) G.holdVerify(false);
        // paid while away, or a melt that settled: the balance again once swept
        if (swept) swept.then(() => this.refreshBalance());
      });
    }).catch(() => { G.holdVerify(false); })
      .then(() => { this._returning = null; });
    this._returning = run;
    return run;
  }

  /* The launch screen may come down: the balance loaded, or the mint would not. */
  settleLaunch() {
    clearTimeout(this._launchCapT);
    const settled = this._launchSettled;
    this._launchSettled = null;
    if (settled) settled();
  }

  // two scans: address, then admin key. The admin key covers invoices too.
  /* What to call this mint in a sentence.
   *
   * mintHost() gives an address — mint.minibits.cash/Bitcoin — which is right
   * for a list and wrong for prose. This gives the name: Minibits.
   *
   * Derived rather than tabulated, so a mint nobody has heard of still gets a
   * reasonable name. The table is only for the ones where capitalising the
   * first letter reads wrong. */
  MINT_NAMES = { westernbtc: 'WesternBTC', minibits: 'Minibits', coinos: 'Coinos',
                 macadamia: 'Macadamia' };

  mintName() {
    return this.mintNameOf(this.mintHost());
  }

  /* A mint's short name from its address: its own in MINT_NAMES, else the
   * first label after "mint.". */
  mintNameOf(url) {
    const host = String(url || '').replace(/^https?:\/\//, '');
    if (!host) return '';
    const domain = host.split('/')[0].replace(/^mint\./i, '');
    const label = domain.split('.')[0].toLowerCase();
    return this.MINT_NAMES[label] || (label.charAt(0).toUpperCase() + label.slice(1));
  }

  mintHost() {
    const W = window.FoxyWallet;
    return (W && W.mintHost && W.mintHost()) || '';
  }

  /* Working offline, and the connection came back.
   *
   * The choice is surrendered by the wallet itself the moment Tor is really up
   * (`_privacy`), and the banner turns from OFFLINE to TOR with it. That is a
   * quiet change on a screen somebody may not be looking at, and they have been
   * living without a connection — so it is said out loud, once. */
  sayBackOnline() {
    const W = window.FoxyWallet;
    const p = (W && W.privacy && W.privacy()) || {};
    const offline = !!p.offline;
    const secure = p.tor === 'up' && p.network !== 'none';
    /* Said out loud only when the phone had really been without a network.
     * Every session starts offline now and is online a few seconds later,
     * and a toast for that is noise: the banner turning is the news. */
    if (offline && p.network === 'none') this._offlineDark = true;
    if (this._wasOffline && !offline && secure) {
      if (this._offlineDark) this.toast('Back online \u2014 connected over Tor');
      this._offlineDark = false;
      // and anything that was waiting on a route can go now
      this.refreshBalance();
      this.loadHistory();
    }
    this._wasOffline = offline;
    /* The price line is asked for once at launch and once when the wallet is
     * ready. Offline, both are refused, and nothing asked again — so a phone
     * that came online later showed the price with no line under it. Asked on every route change that has a route; `loadSeries`
     * answers at once when the line is already there or on its way. */
    if (secure && !offline && !((this.state.series || {})[this.state.range])) {
      this.loadSeries(this.state.range);
    }
  }

  /* Money waiting on a route, the moment there is one.
   *
   * Everything that claims what is waiting hangs off `connect()`: its sweep
   * chain runs `claimUnclaimed` on a launch or a mint switch. Neither happens
   * when a network comes back mid-session — so a payment taken on trust while
   * both phones were offline sat in history as AT RISK with wifi in the room,
   * and the red ring turned until the app was restarted (the circuit came up
   * and nothing was claimed after it).
   *
   * That row is the one that matters most: it is the only money in Foxy that
   * somebody else can still take away, and every second it stays unswapped is a
   * second they can. Asked on every route change, which is cheap — the claim
   * answers at once when the list is empty — and guarded so a flapping route
   * cannot stack them. */
  claimWhenRouteReturns() {
    const W = window.FoxyWallet;
    if (!W || !W.claimUnclaimed || !W.connected) return;
    const p = (W.privacy && W.privacy()) || {};
    if (!(p.tor === 'up' || p.unprotected)) return;
    if (p.network === 'none') return;
    /* And what was left between two mints, which needs a route just as much:
     * a crossing to claim, a payment to bring home, a refusal to take back. */
    if (!this._crossingsOnRoute && W.crossingsWaiting && W.crossingsWaiting()) {
      this._crossingsOnRoute = true;
      console.log('[foxy] a route came back and something is waiting between two mints');
      W.catchUpCrossings().then(() => {
        this._crossingsOnRoute = false;
        this.refreshBalance(); this.loadHistory();
      }, () => { this._crossingsOnRoute = false; });
    }
    if (this._claimingOnRoute) return;
    const waiting = (() => {
      try { return (W.trustedWaiting && W.trustedWaiting().length) || W.unclaimedSats() > 0; }
      catch (e) { return false; }
    })();
    if (!waiting) return;
    this._claimingOnRoute = true;
    console.log('[foxy] a route came back and something is waiting to be swapped in');
    W.claimUnclaimed().then((took) => {
      this._claimingOnRoute = false;
      if (took) { this.refreshBalance(); this.loadHistory(); }
    }, () => { this._claimingOnRoute = false; });
  }

  /* A wallet built with no route was built from what the mint said last time:  /* A wallet built with no route was built from what the mint said last time:
   * its keysets may have rotated since, nothing paid while the phone was away
   * has been claimed, and no sweep has run. So the moment there is a route,
   * connect again for real — once, and only for such a wallet.
   *
   * Without this the phone works perfectly offline and then stays offline-shaped
   * for the rest of the launch: a route appears, the banner says so, and the
   * wallet is still the one assembled from storage. */
  connectForRealOnceOnline() {
    const W = window.FoxyWallet;
    if (!W || !W.fromCache || !W.fromCache()) return;
    const p = (W.privacy && W.privacy()) || {};
    if (!(p.tor === 'up' || p.unprotected)) return;
    if (this._catchUpConnect) return;
    if (p.network === 'none') return;
    this._catchUpConnect = true;
    const url = W.mintUrl;
    console.log('[foxy] a route is up and this wallet came from storage \u2014 connecting to', url, 'for real');
    /* Behind whatever the person is doing. This went through `retryConnect`,
     * whose `walletReady` puts the home screen up and empties the back stack:
     * right for a launch, and a jump out of RECEIVE or a payment for somebody
     * who had started one in the seconds before the mint answered. Every
     * launch is such a wallet now, so the catch-up only connects, and then
     * refreshes what is shown. A failure changes nothing (`connect` keeps the
     * wallet it had) and is tried again: 3s, 6s, 12s, then every 30s. */
    const again = (attempt) => {
      W.connect(url).then(() => {
        this.refreshBalance();
        this.loadHistory();
        this.offerQuarantine();
      }, (e) => {
        console.warn('[foxy] the connect behind the home screen failed, attempt', attempt + 1, '\u2014', W.reason(e));
        const still = W.fromCache && W.fromCache();
        if (!still) return;
        clearTimeout(this._catchUpT);
        this._catchUpT = setTimeout(() => again(attempt + 1), Math.min(3000 * Math.pow(2, attempt), 30000));
      });
    };
    again(0);
  }

  /* There is no screen to park on any more, so a mint that will not load is
   * simply tried again — 3s, 6s, 12s, then every 30s. A mint that is briefly
   * down recovers without the person doing anything. */
  retryConnect(url, attempt, fromFile) {
    const W = window.FoxyWallet;
    clearTimeout(this._reconnectT);
    return W.connect(url, null, null, fromFile ? { fromCache: true } : undefined).then(w => {
      const balance = this.walletReady(w);
      /* The mint is not asked about every proof held, here or on a return: the
       * same list each launch let it know this wallet over any exit. Ecash
       * spent elsewhere is found when a payment picks it (onSpentElsewhere). */
      this.offerQuarantine();
      if (fromFile) {
        /* Home first: the sats are local and the last price is on file, so
         * there is nothing to hold the home screen back for. It waited for the
         * price walk, up to twelve seconds behind the phone's splash now that
         * no connection screen stands there. And the mint is spoken to for
         * real the moment there is a route, which may be now. */
        this.settleLaunch();
        this.connectForRealOnceOnline();
        // the balance is on its way to the screen by itself; a price that would not load is not a failed connect
        Promise.resolve(balance).catch(() => {});
        return null;
      }
      if (!this._launchSettled) return;
      const G = window.FoxyGate;
      if (G && G.launchStage) G.launchStage('balance', 92, 100);
      // the price can walk every source; 20 seconds at most, as on a return
      return Promise.race([
        Promise.resolve(balance).catch(() => {}),
        new Promise(r => setTimeout(r, 20000)),
      ]).then(() => this.settleLaunch());
    }).catch(e => {
      const why = W.reason(e);
      console.warn('[foxy] connect failed, attempt', attempt + 1, '\u2014', why);
      /* Hold the searching screen through the first two tries.
       *
       * A failed connect says nothing about the balance — the proofs are in
       * local storage and are still there. Announcing "no wallet" on attempt
       * one turned an ordinary Tor retry into an alarming screen, while the
       * retry quietly succeeded a few seconds later. */
      if (attempt >= 2) {
        this.setState({ walletSearching: false, walletErr: why });
        this.settleLaunch();                     // the home screen, with the error, rather than waiting on
      }
      if (attempt === 2) this.toast(why, true);
      const wait = Math.min(3000 * Math.pow(2, attempt), 30000);
      this._reconnectT = setTimeout(() => this.retryConnect(url, attempt + 1, fromFile), wait);
    });
  }

  /* Every mint the app knows to look at. The switch screen's list and this
   * one are the same set; if one grows the other should. */
  /* The mints on offer: the ones shipped with the app, then anything this
   * device has connected to since — a QR scan puts a mint here, which is what
   * makes it reachable again after switching away. */
  DEFAULT_MINTS = [
    { url: 'https://mint.minibits.cash/Bitcoin', name: 'Minibits mint',
      host: 'mint.minibits.cash', tint: '#4E7BE8' },
    /* Coinos was here and was taken out for being unreliable. A phone that has used it still lists it, from its own
     * record of the mints it has connected to. */
    { url: 'https://mint.westernbtc.com', name: 'WesternBTC',
      host: 'mint.westernbtc.com', tint: '#C9822F' },
    { url: 'https://mint.macadamia.cash', name: 'macadamia Mint',
      host: 'mint.macadamia.cash', tint: '#8A5A2B' },
    /* Test mints. The ecash they issue is backed by nothing and is worthless
     * by design — they exist so the money paths can be exercised without
     * spending anything. Named so that is unmistakable, and last in the list.
     *
     * The fee-charging one is not redundant: Foxy's fee handling has only ever
     * run against a mint that charges none. */
    { url: 'https://nofee.testnut.cashu.space', name: 'TEST MINT \u00b7 fake money',
      host: 'nofee.testnut.cashu.space', tint: '#6B6B6B', test: true },
    { url: 'https://testnut.cashu.space', name: 'TEST MINT \u00b7 fake money, with fees',
      host: 'testnut.cashu.space', tint: '#6B6B6B', test: true },
  ];

  allMints() {
    const strip = u => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    /** @type {{ url: string, name: string, host: string, tint: string, logo?: string, test?: boolean }[]} */
    const out = this.DEFAULT_MINTS.slice();
    const known = out.map(m => strip(m.url));
    const W = window.FoxyWallet;
    const seen = (W && W.mints) ? W.mints() : [];
    seen.forEach(url => {
      if (known.indexOf(strip(url)) >= 0) return;
      known.push(strip(url));
      // a mint nobody shipped: no logo, and its host stands in for a name
      out.push({ url: url, name: strip(url), host: strip(url), logo: '', tint: '#5A5A5A' });
    });
    return out;
  }

  knownMints() {
    return this.allMints().map(m => m.url);
  }

  /* Rows land one at a time rather than all at the end — a mint can take five
   * seconds, and six of them behind a single spinner is a long silence.
   *
   * The words are typed on the phone's own screen and never reach this page;
   * the phone answers with a candidate that holds them, and that is what is
   * scanned. A retry scans the same candidate, or this wallet's own seed once
   * the candidate was adopted. Cancelled: nothing happens. */
  runSeedScan(onlyFailed) {
    const W = window.FoxyWallet;
    if (this.state.rsBusy) return;
    if (onlyFailed) return this.scanSeedRows(true, this.state.rsCandidate ? { candidate: this.state.rsCandidate } : null);
    if (this._rsEntering) return;
    this._rsEntering = true;
    return Promise.resolve().then(() => W.enterSeedNative()).then(candidate => {
      this._rsEntering = false;
      this.scanCandidate(candidate);
    }, e => {
      this._rsEntering = false;
      this.setState({ rsErr: W.reason(e) });
    });
  }

  /* RESTORE from the menu: the phone's RESTORE A WALLET screen over home, and
   * the restore screen only once there are words to look for balances with.
   * Cancelled, nothing changes and home is where it was. */
  restoreFromMenu() {
    const W = window.FoxyWallet;
    if (!W || !W.enterSeedNative || this.state.rsBusy || this._rsEntering) return;
    this._rsEntering = true;
    return Promise.resolve().then(() => W.enterSeedNative()).then(candidate => {
      this._rsEntering = false;
      if (!candidate) return;
      this.setState(p => ({
        screen: 'importSeed', stack: p.stack.concat([p.screen]),
        rsRows: [], rsErr: '', rsBusy: false, rsKept: '',
      }));
      this.scanCandidate(candidate);
    }, e => {
      this._rsEntering = false;
      this.toast(W.reason(e), true);
    });
  }

  /* Words entered on the phone's screen, as a candidate: look for balances. */
  scanCandidate(candidate) {
    if (!candidate) return;
    this._rsCandidates = this._rsCandidates || new Set();
    this._rsCandidates.add(candidate);
    this.setState({ rsCandidate: candidate });
    this.forgetRestoreCandidates(candidate);     // an earlier one, never adopted
    this.scanSeedRows(false, { candidate: candidate });
  }

  /* The scan itself, of this wallet's seed (null) or a candidate. */
  scanSeedRows(onlyFailed, words) {
    const W = window.FoxyWallet;
    const urls = onlyFailed
      // a partial row — a keyset that did not answer — is asked again too
      ? (this.state.rsRows || []).filter(r => r.state === 'failed' || r.partial).map(r => r.url)
      : this.knownMints();
    if (!urls.length) return;

    this.setState(p => ({
      rsBusy: true, rsErr: '', rsKept: '', rsAdopted: false,
      rsRows: onlyFailed ? (p.rsRows || []).filter(r => r.state !== 'failed' && !r.partial) : [],
    }));

    this._rsScanning = true;
    W.scanSeed(words, urls, row => {
      // The seed may already have been adopted while this was still running —
      // a mint that answers now still belongs to it, so it is written here
      // rather than being dropped when the screen goes away.
      if (this.state.rsAdopted && row.state === 'done' && (row.sats > 0 || this.rowUnits(row).length)) {
        /* Merged, not overwritten. The words were adopted a moment ago, so
         * the pile at this mint may still hold proofs from the seed they
         * replaced. An overwrite with no words counted those as rebuildable
         * and dropped them — recoverable only with the old words. A merge
         * keeps everything; a spent proof kept here goes at the next
         * reconcile.
         *
         * adoptScan runs in the wallet's proof lock and answers with a
         * promise, so the balance is read after it lands, and a failure is
         * logged rather than lost in a try that could never see it. */
        Promise.resolve().then(() => W.adoptScan([row], { merge: true })).then(() => {
          console.log('[foxy] late arrival kept:', row.host, row.sats, 'sats');
          if (window.FoxyWallet.mintHost() === row.host) this.refreshBalance();
        }).catch(e => console.warn('[foxy] late arrival not kept:', row.host, W.reason(e)));
      }
      this.setState(p => {
        const rows = (p.rsRows || []).slice();
        const at = rows.map(r => r.url).indexOf(row.url);
        if (at >= 0) rows[at] = row; else rows.push(row);
        return { rsRows: rows };
      });
    }).then(() => {
      this.setState({ rsBusy: false });
      this.seedScanEnded();
    }).catch(e => {
      this.setState({ rsBusy: false, rsErr: W.reason(e) });
      this.seedScanEnded();
    });
  }

  /* A candidate left to forget while its scan was running goes now, unless
   * the restore screen still has it as the words to adopt. */
  seedScanEnded() {
    this._rsScanning = false;
    if (!this._rsForgetLater) return;
    this._rsForgetLater = false;
    const restoring = this.state.screen === 'importSeed' || this.state.screen === 'rsConfirm';
    this.forgetRestoreCandidates(restoring ? this.state.rsCandidate : null);
  }

  /* Words typed on the phone for RESTORE stay there under their candidate
   * until forgotten: when the restore screens are left, after a candidate was
   * adopted (it is the phone's seed by then), and when new words replace it.
   * Never while a scan may still be asking with it — that waits for the scan to
   * end (seedScanEnded), so a mint answering late is still restored. `keep`
   * names one to leave. */
  forgetRestoreCandidates(keep) {
    const W = window.FoxyWallet;
    if (!this._rsCandidates || !this._rsCandidates.size || !W || !W.forgetSeedCandidate) return;
    if (this._rsScanning) { this._rsForgetLater = true; return; }
    this._rsCandidates.forEach(id => {
      if (id === keep) return;
      this._rsCandidates.delete(id);
      Promise.resolve().then(() => W.forgetSeedCandidate(id))
        .catch(e => console.warn('[foxy] the phone did not forget restore words:', W.reason(e)));
    });
  }

  /* A row was tapped. Nothing is written yet — this only stages the choice
   * and shows what it would cost. */
  pickRestoreMint(row) {
    if (!row || row.state !== 'done') return;
    this.setState(p => ({
      screen: 'rsConfirm',
      stack: p.stack.concat([p.screen]),
      rsPick: row, rsPickErr: '', rsBusy: false,
    }));
  }

  /* Confirmed. The entered phrase becomes this device's seed and EVERY mint
   * that answered is written, not just the one tapped — the tap decides where
   * you land, not what is kept. Anything still being scanned is picked up by
   * runSeedScan as it arrives. */
  adoptRestoreMint() {
    const W = window.FoxyWallet;
    const row = this.state.rsPick;
    if (!row || this.state.rsBusy2) return;
    // the candidate of words typed on the phone, which the phone adopts first
    const candidate = this.state.rsCandidate || null;
    const found = (this.state.rsRows || []).filter(r => r.state === 'done' && (r.sats > 0 || this.rowUnits(r).length > 0));
    const keep = found.length ? found : [row];

    // landing on the chosen mint is a switch like any other
    if (this.refuseSwitchWhileBusy()) return;

    this.setState({ rsBusy2: true, rsPickErr: '' });
    const total = keep.reduce((n, r) => n + r.sats, 0);

    /* Adopt, wait, and only then connect.
     *
     * adoptScan runs in the wallet's proof lock and answers with a promise.
     * This used to call it inside a try and connect straight away: a refusal
     * arrived as a rejection the try never saw, rsPickErr stayed empty, and
     * the app went on to the mint as if the words had been written. */
    Promise.resolve().then(() =>
      // the seed goes in once, with the first write
      W.adoptScan(keep, candidate ? { overwrite: true, candidate: candidate } : { overwrite: true })
    ).then(() => {
      console.log('[foxy] adopted', keep.length, 'mints,', total, 'sats');
      return W.connect(row.url);
    }).then(w => {
      // rsAdopted keeps the scan writing as later mints answer; the rows are
      // left alone so a scan in flight still has somewhere to land
      this.setState({ rsBusy2: false, rsPick: null, rsAdopted: true });
      // the adopted words are the phone's seed now; their candidate goes once no scan needs it
      if (candidate) {
        this.setState({ rsCandidate: null });
        this.forgetRestoreCandidates(null);
      }
      this.walletReady({ name: (w && w.name) || row.host });
      // other units are named in their own, never added to the sat total
      const inUnits = keep.reduce((a, r) => a.concat(this.rowUnits(r)), []);
      this.toast((keep.length > 1
        ? 'Restored ' + this.group(total) + ' sats across ' + keep.length + ' mints'
        : 'Restored on ' + row.host)
        + (inUnits.length ? ', and ' + inUnits.map(u => this.unitMoney(u.amount, u.unit)).join(' + ') + ' in other units' : ''));
    }).catch(e => {
      this.setState({ rsBusy2: false, rsPickErr: W.reason(e) });
    });
  }
