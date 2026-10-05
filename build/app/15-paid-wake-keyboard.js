
  // Who a sent payment went to: the address if there was one, otherwise the
  // invoice shortened at both ends. LNbits keeps no counterparty, so this comes
  // from what we tagged at send time or from the address still in state.
  paidTargetLabel() {
    const W = window.FoxyWallet;
    const to = String(this.state.paidTo || this.state.recipient || '').trim();
    if (to && W) {
      const kind = W.classify(to);
      if (kind === 'lnurl') return to;
      if (kind === 'invoice') return to.slice(0, 5) + '\u2026' + to.slice(-5);
    }
    return to || '\u2014';
  }

  // Show the next queued payment, if the screen is free to take one.
  //
  // Nothing is dequeued until its confirmation is actually dismissed, so an
  // interruption cannot swallow a payment: whatever was showing stays showing.
  SPLIT_SCREENS = ['spAmount', 'spWays', 'spShares', 'spPayer', 'spAssign', 'spWaiting', 'spAllPaid'];

  /* Whatever is in the queue, something is coming back for it.
   *
   * Every way out of nextPaidScreen with payments still queued used to depend
   * on somebody else calling it again — a dismissal, a render leaving a split,
   * or a history pass that happened to find something new. When none of those
   * came the queue stood still and the arrivals behind it were never shown;
   * the twenty-second give-up below could not fire either, since nothing was
   * there to notice the time had passed. It is the same shape as the on-chain
   * watcher that stopped asking: an exit with no timer behind it. The money is
   * credited by loadHistory either way — what is lost here is the
   * confirmation, not the payment. The poll ends of its own accord, because an
   * empty queue arms nothing. */
  QUEUE_RETRY_MS = 2000;

  queueLater() {
    clearTimeout(this._queueT);
    this._queueT = setTimeout(() => this.nextPaidScreen(), this.QUEUE_RETRY_MS);
  }

  nextPaidScreen() {
    const queue = this._paidQueue || [];
    if (!queue.length) return;
    if (this.state.screen === 'paid') { this.queueLater(); return; }   // one at a time
    // a split has its own running tally and its own all-paid screen; a
    // confirmation per payer would talk over it. They wait in the queue.
    if (this.SPLIT_SCREENS.indexOf(this.state.screen) >= 0) { this.queueLater(); return; }

    const next = queue[0];

    /* Change is never announced, so it never waits its turn either. It was
     * being handed to `announcePayment`, which declines it, and then sat at
     * the head of the queue for twenty seconds being "announced" — with the
     * real payment behind it. Three of them in a row held a received payment's
     * confirmation back for seventy seconds. Out of the queue at once, and on
     * to the next. */
    if (/^(req-)?(tap-)?change-/.test(String(next.hash || ''))) {
      queue.shift();
      console.log('[foxy] confirmation: change swapped in, not announced');
      this.nextPaidScreen();
      return;
    }

    /* Announce once, whatever happens next.
     *
     * Draining is paidDismissed's job, which means the queue only empties if
     * the confirmation reaches the screen and is dismissed. When it did not
     * stick — seen on device with a split open — this announced the same
     * payment every tick, forever. Marking it here breaks that loop without
     * needing to know why the screen failed to hold. */
    if (next.said) {
      // announced but never dismissed: let it go rather than block the rest
      if (Date.now() - next.said > 20000) {
        queue.shift();
        console.log('[foxy] confirmation never landed, dropped it');
        this.nextPaidScreen();
        return;
      }
      // announced and still waiting on its screen: come back and time it out
      this.queueLater();
      return;
    }
    next.said = Date.now();

    this.announcePayment({
      dir: next.dir || 'in', sats: next.sats, hash: next.hash, to: next.party || '',
    });
    // the confirmation may not have landed; this is what notices
    this.queueLater();
  }

  // called when a confirmation is dismissed
  /* How long home waits before Apple's paste control is laid over its PASTE
   * button again, once a payment confirmation has been dismissed.
   *
   * The control is a native view placed on top of the page, and it hands the
   * clipboard straight to acceptTarget — which for a Lightning invoice opens
   * the send flow. A confirmation is dismissed with a tap low on the screen,
   * which is where that control lands; a person dismissed a receive and found
   * an invoice from their clipboard already being sent. Nothing
   * was pasted by the app: the tap that closed one screen arrived on a button
   * that had not been there when their finger went down.
   *
   * So home settles first. The page's own PASTE is untouched and still one tap
   * — this is only the native control, and only for a moment. */
  PASTE_SETTLE_MS = 700;

  paidDismissed() {
    if (this._paidQueue && this._paidQueue.length) this._paidQueue.shift();
    /* Nothing measures or places a native view over the page until this is
     * past (syncPreview waits on it and comes back by itself). */
    this._slideUntil = Math.max(this._slideUntil || 0, Date.now() + this.PASTE_SETTLE_MS);
    if (this.syncPreview) this.syncPreview();
    // let the home screen land before the next one arrives
    clearTimeout(this._queueT);
    this._queueT = setTimeout(() => {
      this.nextPaidScreen();
      /* And once the confirmations are done, the one card that asks rather
       * than reports: how this wallet should be protected now that there is
       * something in it (offerSecureFoxy, 10-pin.js). Behind nextPaidScreen so
       * it never lands on top of a payment still being shown, and it is due at
       * most once. */
      if (!(this._paidQueue && this._paidQueue.length)) this.offerSecureFoxy();
    }, 520);
  }

  // every payment on the wallet surfaces, however it was made
  listenWallet() {
    const W = window.FoxyWallet;
    if (!W || !W.listen) return;
    if (this._unlisten) this._unlisten();
    // payments sent straight to this phone's requests, over Tor (12-receive.js)
    if (!this._requestPaidHooked && W.onRequestPaid) {
      this._requestPaidHooked = true;
      W.onRequestPaid(ev => this.requestPaidHere(ev));
    }
    // tap to pay, both sides (26d-tap.js)
    if (!this._tapHooked && W.onTap) {
      this._tapHooked = true;
      W.onTap(ev => this.tapHeard(ev));
      /* Change coming back, when this phone overpaid because it could not make the
       * amount exactly. Taken the way any ecash is taken, and only then is the
       * receiver told — `tapChangeKept` is what becomes M8, and the receiver holds
       * the link open until it comes. Told `false` on a failure rather than
       * nothing, because the other phone is waiting and "we could not keep it" is
       * something it can act on where silence is only a timeout. */
      if (W.onTapChange) {
        W.onTapChange(token => {
          /* Change is locked to a key only this phone holds, so it is already
           * ours the moment it arrives — the receiver cannot take it back. What is
           * left is whether it can be swapped in now.
           *
           * Offline it cannot: `receiveToken` is a swap. And offline is exactly
           * when change happens, because a payer who could swap would have paid
           * the exact amount. So with no route it is written into the store a
           * locked payment waits in, and the claim that runs on any screen money
           * could leave from takes it when there is one. Either way it is kept,
           * and only then is the receiver told — the ack is what lets them stop
           * holding the link open. */
          const changeHash = 'tap-change-' + Date.now();
          const bits = W.tokenInfo ? W.tokenInfo(token) : null;
          const sats = bits ? (bits.proofs || []).reduce((a, pr) => a + Number(pr.amount || 0), 0) : 0;
          /* Checked before it is believed: owed, no more than owed, this mint,
           * and locked to a key this phone asked for (W.checkChange). M7 is
           * the other phone's word, and it used to be kept as it came. A
           * refusal is told, so the receiver shows the change as a code
           * instead of thinking it delivered. */
          /* Or a refund: a payment the receiver was to carry to its own mint
           * and could not, sent back whole. Owed, then, is what was paid. */
          const carried = this._carriedPay && Date.now() < this._carriedPay.until ? this._carriedPay : null;
          const refund = !(Number(this._changeOwedSats) > 0) && !!carried;
          const owed = Math.round(Number(this._changeOwedSats) || (carried ? carried.sats : 0) || 0);
          const chk = W.checkChange ? W.checkChange(token, owed) : { ok: true, signed: true };
          if (!chk.ok) {
            console.warn('[foxy] change refused: ' + chk.why + ' (' + sats + ' sats arrived, ' + owed + ' owed)');
            W.tapChangeKept(false);
            return;
          }
          /* What it is worth here: the token less this mint's fee for taking
           * it. The receiver adds that fee to the token so the change arrives
           * whole, and settling the entry with the token's own figure counted
           * it as money that came back: a sat out for every change kept at a
           * mint that charges (tools/live/tap-scenarios.js 2b). */
          const net = W.changeNet ? W.changeNet(token) : sats;
          const kept = (how) => {
            // the link was being held open for exactly this; it may go now
            /* Change coming back belongs to the payment it came from: its own
             * entry is finished with the figures, and no second row appears for
             * money coming back. The entry `receiveToken`
             * wrote for the swap is marked so it does not interrupt either. */
            /* The receiver is told first, and the link is held a moment for it.
             *
             * `changeArrived` lets the link go, and it ran before the word that
             * the change was kept went out: the link closed, the word was never
             * sent, and the receiver — who had handed the change over — was told
             * it still owed it. */
            this._ackHold = Date.now() + 700;
            const told = W.tapChangeKept(true);
            setTimeout(() => this.syncTap(), 750);
            this.changeArrived(net);
            if (refund) {
              // the payment's own entry says it came back, as it does for change
              this._carriedPay = null;
              // on top of any change that had already come back for it
              try { if (carried.hash && W.changeSettled) W.changeSettled(carried.hash, net, { refund: true }); } catch (e) {}
              /* All of it, or it is not the payment coming back. The check
               * above has a ceiling and no floor: 10 sats locked to this
               * phone passed it for a payment of 310, and the card said the
               * payment had come back. A sat or two short is the mint's fee
               * for making the refund; more than that is said as it is. */
              const short = refund && net < carried.sats - Math.max(6, Math.ceil(carried.sats / 100));
              this.blockedCard('refunded', short ? {
                tone: 'warn',
                title: 'ONLY PART CAME BACK',
                reason: 'They could not bring your payment to their own mint, and sent back '
                  + this.group(net) + ' of the ' + this.group(carried.sats) + ' sats you paid.',
                chip: this.group(carried.sats - net) + ' sats were not returned.',
              } : {
                tone: 'warn',
                title: 'YOUR PAYMENT CAME BACK',
                reason: 'They could not bring it to their own mint, so they sent it back.',
                chip: this.group(net) + ' sats are yours again. They were not paid.',
              });
            }
            try { if (W.tag) W.tag(changeHash, { change: true }); } catch (e) {}
            /* Not announced. The payment said what it cost; change coming back
             * is that payment finishing, and a toast about it is a second
             * event for the person to make sense of. */
            console.log('[foxy] change kept: ' + sats + ' sats' + how);
            this.refreshBalance();
            this.loadHistory();
            return told;
          };
          if (!this.offlineNow()) {
            W.receiveToken(token, { hash: changeHash })
              .then(() => kept(''), e => {
                /* The swap failed but the ecash is still locked to this phone, so
                 * it is kept rather than dropped and claimed on the next try. */
                console.warn('[foxy] change could not be swapped in yet:', e && e.message);
                // kept without the swap only when the mint's signature on it verifies here
                if (!chk.signed) {
                  console.warn('[foxy] change refused: the mint would not swap it and its signatures do not verify');
                  return W.tapChangeKept(false);
                }
                try { W.keepChange(token, sats); return kept(', waiting to settle'); }
                catch (x) { return W.tapChangeKept(false); }
              }).catch(() => {});
            return;
          }
          // offline there is no swap to settle it, so the signature has to verify here
          if (!chk.signed) {
            console.warn('[foxy] change refused: offline, and its signatures cannot be checked here');
            W.tapChangeKept(false);
            return;
          }
          try { W.keepChange(token, sats); kept(', waiting for a connection'); }
          catch (e) {
            console.warn('[foxy] the change could not be written down:', e && e.message);
            this.toast('Change arrived but could not be saved.', true);
            W.tapChangeKept(false);
          }
        });
      }
    }
    this._unlisten = W.listen(ev => {
      this.loadHistory();
      if (!this.txIsNew(ev.hash)) return;
      const tag = W.tagsFor(ev.hash) || {};
      this.announcePayment(Object.assign({}, ev, { to: tag.to || '' }));
    });
  }

  // coming back from the background: the socket died while suspended, so the
  // history sweep is the only thing that will notice what happened meanwhile
  watchWake() {
    if (this._onWake) return;
    this._onWake = (away) => {
      this._putAway = false;
      // a top-up still owed waits for the next put-away; nothing runs in the foreground
      const W = window.FoxyWallet;
      // the native side says how long Foxy was really in the background
      if (typeof away === 'number') {
        // Face ID and Control Center take focus without the background: Foxy never left
        if (away < 1) return;
        console.log('[foxy] wake:', away + 's in the background');
        // A phone handed over while Foxy was in the background: lock first.
        this.pinLock();
        /* The one Face ID of this visit: once past the lock, whose Face ID
         * unlock covers it, the seed is read now rather than when a payment
         * first needs it (FoxyWallet.openSeedForVisit). */
        this.pinUnlocked().then(() => W && W.openSeedForVisit && W.openSeedForVisit());
        // then a private connection set up again, as at launch (06-wallet-boot-and-restore.js)
        this.setUpAfterReturn();
        // a token still waiting to be redeemed is asked about again, after a wait
        this.claimWatchResume();
        /* A bill still being collected: its watchers were suspended with the
         * app and give up after an hour, and a share paid with nobody
         * watching lands at the mint unclaimed. resumeSplit settles what was
         * missed and watches what is still owed. */
        this.resumeSplit();
        /* The one-time .onion a payment request names: the native side ended
         * it as Foxy left (FoxyWebView.appEnteredBackground), so a request
         * still on screen would otherwise name an address nobody answers. */
        this.inboxWake();
        /* On chain settles in blocks, so a return after any real time away is
         * the likeliest moment for a deposit to have confirmed — and the timer
         * that would have asked was suspended with the app. */
        this.onchainAsk();
        this.onchainWatchLater();
        this.tidyChangeLater();
        /* Coming back is arriving at the home screen too, and the launch cover
         * is up again over it while Tor comes back — so the ride waits for it
         * to come down rather than playing behind it. */
        this.riderWhenSeen();
        return;
      }
      // a browser, with no native side and no Tor: history and sweeps, nothing to set up
      const now = Date.now();
      if (this._wakeAt && now - this._wakeAt < 3000) return;
      this._wakeAt = now;
      this.listenWallet();
      this.loadHistory();
      if (W && W.resumeSweeps) W.resumeSweeps().then(() => this.refreshBalance()).catch(() => {});
    };

    // the native side is the reliable signal: a suspended web view does not
    // always fire visibilitychange when iOS wakes it
    if (window.FoxyWallet && window.FoxyWallet.onResume) {
      window.FoxyWallet.onResume(this._onWake);
    }
    /* In the app the native side reports every return, and a page event is not
     * one: the first tap after launch gives the web view focus, and that ran a
     * whole confirming check — LOADING YOUR BALANCE over the home screen. Page
     * events stand in only where there is no native side, in a browser. */
    const native = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy);
    if (native) return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._onWake();
    });
    window.addEventListener('focus', this._onWake);
    window.addEventListener('pageshow', this._onWake);
  }

  /* A return's last step before the home screen: the balances, and the price
   * unless one is already on its way.
   *
   * refreshBalance waits on the price. Through a bridge the check's own fresh
   * price could still be walking its sources after the mint had answered, and
   * the check sat on it with the balances already loaded — 2.6 seconds in one
   * obfs4 trial, and up to the walk's whole 30. A price in flight is not
   * waited on now: the balance shows with the last price, and again with the
   * new one when it lands. */
  resumeLoad() {
    const W = window.FoxyWallet;
    const pending = W && W.rateInFlight ? W.rateInFlight() : null;
    const balance = Promise.resolve(this.refreshBalance());
    if (pending) pending.then(() => this.refreshBalance(), () => {});
    return Promise.all([pending ? null : balance]);
  }

  // lift the note sheet clear of the keyboard
  /* Let iOS know a keyboard is wanted, before anything asks for one.
   *
   * The keyboard does not come up for a programmatic focus() until the web
   * view's content view is first responder. Tapping a div does not do it;
   * tapping a text field does. So one invisible field takes focus and gives it
   * straight back, inside the first real touch — the only moment iOS allows a
   * focus to count. After that every focus() we make behaves like a second one.
   *
   * Distinct from the export's own primeKeyboard(), which focuses a ref that
   * only exists on a screen this build no longer has.
   */
  armKeyboardPrimer() {
    if (this._primerArmed || this.props.startStatic) return;
    this._primerArmed = true;

    let own = null;
    const target = () => {
      if (this._primerEl) return this._primerEl;
      if (own) return own;
      own = document.createElement('input');
      own.type = 'text';
      own.tabIndex = -1;
      own.setAttribute('aria-hidden', 'true');
      // has to be laid out to hold focus, so: transparent, one pixel, behind
      // everything, and ignoring taps of its own
      own.style.cssText =
        'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;' +
        'padding:0;margin:0;background:transparent;color:transparent;' +
        'pointer-events:none;z-index:-1';
      document.body.appendChild(own);
      return own;
    };

    const prime = () => {
      document.removeEventListener('touchstart', prime, true);
      document.removeEventListener('pointerdown', prime, true);
      const el = target();
      try {
        el.focus({ preventScroll: true });
        el.blur();
        console.log('[foxy] keyboard primed on first touch');
      } catch (e) {}
      setTimeout(() => { if (own && own.parentNode) own.remove(); }, 600);
    };

    // capture, so a handler that stops propagation cannot swallow it
    document.addEventListener('touchstart', prime, true);
    document.addEventListener('pointerdown', prime, true);
  }

  watchKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', gap + 'px');
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  }

  // Animate to the balance LNbits actually holds.
  //
  // The prototype's own moveBalance adds the payment to the previous figure,
  // which drifts the moment a fee or a rounding difference appears. Asking
  // first means the count-up ends on the real number every time.
  animateToLive(from, lane) {
    const W = window.FoxyWallet;
    if (!W || !W.connected) return false;
    const start = from || this.balNow();
    Promise.all([W.balanceSats(), W.rate().catch(() => null)]).then(([sats, rate]) => {
      const px = rate || this.px();
      this.setState({
        balSats: sats,
        balUsd: (sats / 1e8) * px,
        satUsd: px / 1e8,
        animFrom: start,
        animT: 0,
        animLane: lane || 'btc',
      });
      this.runBalanceAnim();
    }).catch(() => {});
    return true;
  }

  // leaving a split screen releases anything that queued up while it ran
  syncQueue() {
    const inSplit = this.SPLIT_SCREENS.indexOf(this.state.screen) >= 0;
    if (this._wasSplit && !inSplit) {
      clearTimeout(this._queueT);
      this._queueT = setTimeout(() => this.nextPaidScreen(), 420);
    }
    this._wasSplit = inSplit;
  }

  // Slide the screens.
  //
  // Direction comes from the navigation stack rather than from each call site:
  // the app pushes the previous screen onto `stack` when it goes forward and
  // pops it coming back, so a longer stack means forward and a shorter one
  // means back. Screens that swap without touching the stack don't animate,
  // which is right — those are replacements, not navigation.
  syncSlide() {
    const s = this.state;
    const prev = this._nav;
    const len = (s.stack || []).length;

    if (!prev) { this._nav = { screen: s.screen, len: len }; return; }
    if (prev.screen === s.screen) { this._nav = { screen: s.screen, len: len }; return; }

    const dir = len > prev.len ? 'foxyPushIn' : len < prev.len ? 'foxyPopIn' : null;
    this._nav = { screen: s.screen, len: len };
    if (!dir) return;

    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (e) {}

    const el = /** @type {HTMLElement | null} */ (document.querySelector('[data-foxy-theme]'));
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;                    // forces the animation to restart
    el.style.animation = dir + ' .26s cubic-bezier(.32,.72,0,1) both';
    // anything measuring the page has to wait: while this runs, every element's
    // position is offset by the slide
    this._slideUntil = Date.now() + 300;
  }

  // the send screen's QR pane holds a live camera, not a picture of one
  /* Whether the page's own PASTE is what is on top across its whole face:
   * the middle and four points near the corners. Anything else there — a
   * card, a loader, a drawer, another screen — and Apple's control stays off. */
  pasteUncovered(el, box) {
    if (typeof document === 'undefined' || !document.elementFromPoint) return true;
    const at = [[.5, .5], [.1, .2], [.9, .2], [.1, .8], [.9, .8]];
    return at.every(([fx, fy]) => {
      const top = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy);
      return !!top && (top === el || el.contains(top));
    });
  }

  syncPreview() {
    const W = window.FoxyWallet;
    if (!W || !W.startPreview) return;
    const sc = this.state.screen;
    /* Not under a card, or while an invoice is being checked: the camera is a
     * native view over the page, and it covered the top of PAYING ANOTHER …
     * USER, and read the same invoice again behind it. */
    /* Nor while what it read is being taken, or under a screen drawn over the
     * app. The scan screen is still the screen while a token is verified, so
     * the camera came straight back up and sat across VERIFYING ECASH, live,
     * for the four seconds the claim took. */
    /* Nor under the gate. Back from the background on a scan screen, the
     * camera sat live across SECURING YOUR CONNECTION: the gate is drawn on
     * the page and the pane is above it. */
    const R = window.FoxyReceiving, M = window.FoxyMoving, G = window.FoxyGate;
    const gated = !!(G && G.visible && G.visible());
    const covered = gated || !!this._takingToken
      || !!(R && R.visible && R.visible()) || !!(M && M.visible && M.visible())
      || !!(typeof document !== 'undefined' && document.getElementById('foxy-stage'));
    const wants = (sc === 'sendHow' || sc === 'sendScan') && !this._blockedEl && !this._checkingInvoice
      && !covered;
    /* Apple's paste button also sits over home's PASTE, so a token or an
     * invoice on the clipboard is one tap from home. */
    /* Nor under a screen drawn over the page. Apple's paste control is a
     * native view above the web view: with YOUR MONEY IS SAFE, YOU OWE THE
     * PAYER CHANGE or CONNECTING TO INVOICE up over home, it sat invisibly
     * across the right half of their button and ate the taps (in one
     * measurement the control sat at 193,663, 159x82, and the button at
     * 674–734). */
    const overlaid = covered || !!(typeof document !== 'undefined'
      && (document.getElementById('foxy-connecting') || document.getElementById('foxy-stage')));
    const wantsPaste = wants || (sc === 'home' && !this._blockedEl && !this.state.open0 && !overlaid);

    // A screen mid-slide is translated across the viewport, so measuring it now
    // would put the camera and the paste button wherever the animation happens
    // to be. Wait for it to land, then measure.
    const left = (this._slideUntil || 0) - Date.now();
    if ((wants || wantsPaste) && left > 0) {
      clearTimeout(this._slideWait);
      this._slideWait = setTimeout(() => this.syncPreview(), left + 20);
      return;
    }

    if (!wantsPaste && this._pasteOn) { this._pasteOn = false; W.stopPasteButton(); }
    if (!wants) {
      if (this._previewOn) { this._previewOn = false; W.stopPreview(); }
      /* A scan screen with no camera on it, and why. Once per reason. */
      const scanning = sc === 'sendHow' || sc === 'sendScan';
      const why = !scanning ? '' : this._blockedEl ? 'a card is up'
        : gated ? 'the connection screen is up'
        : covered ? 'what it read is being taken' : 'an invoice is being checked';
      if (why !== (this._noCameraWhy || '')) {
        this._noCameraWhy = why;
        if (why) console.log('[foxy] scan: ' + sc + ' has no camera because ' + why);
      }
    } else {
      this._noCameraWhy = '';
    }

    // Apple's paste button, laid over the page's own, so one tap is enough
    let pasteEl = wantsPaste ? document.querySelector('[data-foxy-paste="1"]') : null;
    /* A button measured mid-slide is off the screen, and the phone refuses to
     * put Apple's control there — the page's own paste then answers the tap,
     * and iOS asks again with its own bubble (seen in a phone log: refused at
     * x -288). Measured again in a moment instead. */
    const box = pasteEl && pasteEl.getBoundingClientRect();
    /* And only where the page's PASTE is the thing a finger would land on.
     *
     * The list of overlays above is a list, and every screen drawn over home
     * since it was written had to remember to be on it. GET DOLLARS was not:
     * Apple's control sat over the right half of its CLOSE and answered the
     * tap with a paste prompt. So were the Tor
     * gate's CONTINUE UNPROTECTED, the melt overlay and the PIN pad. Asking
     * the page what is actually on top at the button covers all of them and
     * whatever comes next. */
    if (pasteEl && box && !this.pasteUncovered(pasteEl, box)) {
      if (this._pasteOn) { this._pasteOn = false; W.stopPasteButton(); }
      pasteEl = null;
    }
    if (box && (box.left < 0 || box.width < 30)) {
      clearTimeout(this._slideWait);
      this._slideWait = setTimeout(() => this.syncPreview(), 120);
      pasteEl = null;
    }
    const pasteKey = pasteEl ? sc + ':' + Math.round(box.top) + ':' + Math.round(box.left) : '';
    if (pasteEl && (!this._pasteOn || this._pasteKey !== pasteKey)) {
      if (this._pasteOn) W.stopPasteButton();
      this._pasteKey = pasteKey;
      this._pasteOn = W.startPasteButton(pasteEl, text => this.acceptTarget(text));
    }
    if (!wants) return;

    // the pane is laid out by the template, so measure it rather than guess
    const el = document.querySelector('[data-qr-vignette]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const key = sc + ':' + Math.round(r.top) + ':' + Math.round(r.height);
    if (this._previewOn && this._previewKey === key) return;

    this._previewKey = key;
    /* Refused by the native side — measured mid-slide, off the screen — it
     * is forgotten and measured again in a moment, rather than believed to be
     * up: a refusal that stayed silent left the scan screen with no camera
     * until it was left and re-entered. */
    W._onPreviewRefused = (why) => {
      console.warn('[foxy] scan: the camera pane was refused (' + why + '); measuring again');
      this._previewOn = false;
      this._previewKey = '';
      clearTimeout(this._slideWait);
      this._slideWait = setTimeout(() => this.syncPreview(), 150);
    };
    this._previewOn = W.startPreview(el, text => {
      if (!this._previewOn) {
        console.log('[foxy] scan: a code came after the camera had been let go; ignored');
        return;
      }
      this._previewOn = false;
      W.stopPreview();
      let kind = '?';
      try { kind = W.classify(String(text || '').trim().replace(/^lightning:/i, '')); } catch (e) {}
      console.log('[foxy] scan: read ' + String(text || '').length + ' chars, a ' + kind);
      this.acceptTarget(text);
    });
    if (!this._previewOn) {
      console.warn('[foxy] scan: the camera pane could not be started ('
        + Math.round(r.width) + 'x' + Math.round(r.height) + ')');
    }
  }
