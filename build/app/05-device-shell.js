
  // on a real phone (narrow + touch) drop the mockup bezel and run full-bleed
  isRealDevice() {
    try {
      return window.matchMedia('(max-width: 600px)').matches
        || window.matchMedia('(display-mode: standalone)').matches
        || (window.navigator.standalone === true);
    } catch (e) { return false; }
  }
  applyShell() {
    const bare = this.isRealDevice();
    const el = this.shellRef && this.shellRef.current;
    if (el) {
      el.style.padding = bare ? '0' : '28px';
      el.style.minHeight = bare ? '100dvh' : '100vh';
      el.style.alignItems = bare ? 'stretch' : 'center';
      el.style.background = bare ? '#050505' : '#111214';
    }
    if (bare !== this.state.bare) this.setState({ bare });
  }
  // one shared context, created lazily. iOS starts it suspended until a gesture, so it is
  // resumed on the first touch and every play attempt thereafter.
  audioCtx() {
    if (this._ac === null) return null;
    if (!this._ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { this._ac = null; return null; }
      try { this._ac = new Ctx(); } catch (e) { this._ac = null; return null; }
    }
    if (this._ac.state === 'suspended') { try { this._ac.resume(); } catch (e) {} }
    return this._ac;
  }

  // note: [frequency, startOffset, duration, peakGain, waveform]
  tone(notes) {
    const ac = this.audioCtx();
    if (!ac || ac.state !== 'running') return;
    const t0 = ac.currentTime;
    notes.forEach(n => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = n[4] || 'sine';
      osc.frequency.setValueAtTime(n[0], t0 + n[1]);
      // a ramp to zero rather than a hard stop, or the cut sounds like a click
      gain.gain.setValueAtTime(0.0001, t0 + n[1]);
      gain.gain.exponentialRampToValueAtTime(n[3], t0 + n[1] + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0 + n[1]);
      osc.stop(t0 + n[1] + n[2] + 0.02);
    });
  }

  sound(kind) {
    if (this.state.soundOff) return;   // hook for a future Settings toggle
    if (kind === 'success') {
      // rising major triad — the confirmation chime
      this.tone([[880, 0, 0.16, 0.16], [1174.66, 0.055, 0.16, 0.15], [1567.98, 0.11, 0.30, 0.13]]);
    } else if (kind === 'error') {
      // two low square blips falling away: the denial buzz
      this.tone([[196, 0, 0.13, 0.10, 'square'], [155, 0.115, 0.20, 0.09, 'square']]);
    } else {
      // popups: a soft, quiet tick so 29 cards never become noisy
      this.tone([[660, 0, 0.05, 0.035]]);
    }
  }

  haptic(kind, silent) {
    // The send path reaches a confirmation through two state changes a beat apart
    // (sendPhase done -> settled, and the dismissOnchain timers), so the same event can
    // ask to be felt twice. One buzz of a given kind per 1.2s.
    const now = Date.now();
    this._hapLast = this._hapLast || {};
    if (now - (this._hapLast[kind] || 0) < 1200) return;
    this._hapLast[kind] = now;

    if (!silent) this.sound(kind);
    const bridge = (window.webkit || {}).messageHandlers;
    if (bridge && bridge.foxy) {
      try { bridge.foxy.postMessage({ haptic: kind }); return; } catch (e) {}
    }
    // Android WebViews and desktop Chrome do support the web API
    if (navigator.vibrate) {
      navigator.vibrate(kind === 'success' ? [18, 60, 26] : kind === 'warning' ? [30, 80, 30] : 14);
    }
  }

  // every popup/sheet flag, so a card appearing can be felt without wiring each one
  POPUP_KEYS = ['noteOpen','bankRemoveOpen','ccOpen','mapAsk','bizHoursSheet','mapPlaceSheet','mapFilters',
    'acctSheetOpen','bkAsk','posRailSheet','rangeOpen','removeConfirmOpen','addConfirmOpen',
    'advSheet','biz','ctSearch','mapSearch','locating'];

  // Confirmations, errors and popups all buzz, each keyed so a re-render cannot repeat one.
  // Errors and popups are compared as sets: what matters is a flag going from off to ON.
  syncHaptics() {
    const s = this.state;
    if (this.props.startStatic || this.props.startScreen) return;   // review pages stay silent

    // ---- confirmations: one buzz on arrival ----
    // sendPhase walks in -> onchain -> done -> settled on the same screen; only the
    // settled/confirmed moment is a completion
    // sendPhase advances done -> settled on the same screen a beat apart, so keying on the
    // phase buzzed twice. One buzz per visit to the screen instead.
    const done = (s.screen === 'sendDone' && (s.sendPhase === 'done' || s.sendPhase === 'settled')) ? 'sendDone'
      : s.screen === 'paid' ? 'paid:' + (s.payOut ? 'out' : 'in')
      : '';
    if (done !== this._hapDone) {
      this._hapDone = done;
      if (done) this.haptic('success');
    }

    // ---- errors: the sharper double tap ----
    // _amtOver is stashed by renderVals, which owns the balance/limit maths
    const errs = [
      this._amtOver ? 'amt' : '',
      s.pinMismatch ? 'pin' : '',
      s.clWarnKey ? 'cl:' + s.clWarnKey : '',
      s.screen === 'feeTooLow' ? 'feeTooLow' : '',
      s.screen === 'sendFail' ? 'sendFail' : '',
    ].filter(Boolean).join('|');
    if (errs !== this._hapErr) {
      const before = this._hapErr || '';
      this._hapErr = errs;
      // only a NEW error, so clearing one never buzzes
      if (errs.split('|').filter(Boolean).some(e => before.indexOf(e) < 0)) this.haptic('error');
    }

    // ---- popups: a light tap as the card lands ----
    const open = this.POPUP_KEYS.filter(k => !!s[k])
      .concat((s.photoIdx !== null && s.photoIdx !== undefined) ? ['photo'] : []).join('|');
    if (open !== this._hapPop) {
      const before = this._hapPop || '';
      this._hapPop = open;
      if (open.split('|').filter(Boolean).some(k => before.indexOf(k) < 0)) this.haptic('tap');
    }
  }

  // widgets live in a separate process and cannot read the page, so the current accent,
  // currency and Lightning address are pushed to Swift, which stores them in the App Group.
  pushToNative() {
    const bridge = (window.webkit || {}).messageHandlers;
    if (!bridge || !bridge.foxy) return;
    const id = AC(this) || 'green';
    const a = ACC_OF(id);
    // Foxy has no lightning address. This used to build one against a
    // custodial service the project has no relationship with, and post it
    // to a widget target that does not exist.
    const payload = { username: (this.state.un || '').trim() };
    const key = JSON.stringify(payload);
    if (key === this._nativeKey) return;   // only on real change
    this._nativeKey = key;
    try { bridge.foxy.postMessage(payload); } catch (e) {}
  }

  /* Deep links: the Swift shell loads index.html#foxy=<target>, so a widget tap
   * lands on the right screen instead of wherever the app was left.
   *
   * A Debug build also registers a URL scheme, and turns `foxy://receive?amt=50&unit=sat`
   * into the same hash with its parameters (FoxyWebView.receiveDeepLink). Putting a
   * simulator on a screen with an amount already on it took a dozen taps; it now takes
   * one `xcrun simctl openurl` (DEVICE-TESTS.md, "Driving Foxy from outside").
   *
   * THE PARAMETERS ARE A DEBUG AFFORDANCE, AND NOTHING ELSE. A link that can put a
   * wallet on a send screen with an amount filled in is an attack surface, so it exists
   * in one build only, three times over: Release registers no scheme, the Swift that
   * receives one is compiled out, and the reads below are fenced behind window.FOXY_DEBUG
   * — set by a document-start script that itself sits inside #if DEBUG. A Release build
   * handed one of these hashes anyway opens the bare screen, as it always did.
   *
   * Every parameter is checked against what it is allowed to be and dropped when it is
   * not: an unknown key, a bad value and a missing one are all simply absent. Nothing
   * here throws — half a link should still land somewhere sensible.
   */
  applyDeepLink() {
    const hash = String(location.hash || '');
    const m = /[#&]foxy=([a-z]+)/i.exec(hash);
    if (!m) return false;
    const target = m[1].toLowerCase();
    const W = window.FoxyWallet;
    const go = (patch) => this.setState(Object.assign({ stack: [] }, patch));
    const done = () => {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      return true;
    };

    // '' unless this is a Debug build and the hash carries that key
    const raw = (name) => {
      if (!window.FOXY_DEBUG) return '';
      const p = new RegExp('[#&]' + name + '=([^&]*)', 'i').exec(hash);
      if (!p) return '';
      let v = p[1];
      try { v = decodeURIComponent(v); } catch (e) {}
      return v.trim();
    };
    /* An amount the keypad could have produced, in the unit being shown: digits, at
     * most two decimal places in dollars and none in sats, and more than nothing.
     * '' means "they did not say", which leaves the keypad empty as before. */
    const amountFor = (unit) => {
      const v = raw('amt');
      if (!/^[0-9]{1,9}(\.[0-9]{1,2})?$/.test(v)) return '';
      if (unit === 'SATS' && v.indexOf('.') >= 0) return '';
      if (!(parseFloat(v) > 0)) return '';
      return v.replace(/^0+(?=[0-9])/, '');
    };
    const unitOr = (fallback) => {
      const u = raw('unit').toUpperCase();
      if (u === 'SAT' || u === 'SATS') return 'SATS';
      if (u === 'USD') return 'USD';
      return fallback;
    };
    // the app's own names for the networks, matched ignoring the hyphen: onchain, ON-CHAIN
    const railIn = (rails) => {
      const r = raw('rail').toUpperCase().replace(/[^A-Z]/g, '');
      if (!r) return '';
      return rails.filter(x => x.replace(/[^A-Z]/g, '') === r)[0] || '';
    };

    /* `foxy://nfc` opened the payer's tap screen. There is no such screen:
     * this phone listens from home and from SEND, so home is where a link
     * that meant "get ready to tap" now goes. */
    if (target === 'nfc') { go({ screen: 'home' }); return done(); }
    if (target === 'home') { go({ screen: 'home' }); return done(); }
    if (target === 'send') { go({ screen: 'sendHow', flow: 'send' }); return done(); }

    if (target === 'receive') {
      const unit = unitOr('USD');
      const rail = railIn(['LIGHTNING', 'CASHU', 'ON-CHAIN']);
      /* A receive opens on the network this wallet defaults to, and openReceiveNow reads
       * that default when NEXT is pressed — so naming one here has to set the default,
       * or the screen would move back to Lightning one tap later. recvRail is set too,
       * so the NETWORK chip is already right on the way in. */
      if (rail && W && W.defaultRail) { try { W.defaultRail(rail); } catch (e) {} }
      go(Object.assign({
        screen: 'amount', flow: 'receive', asset: '', network: '',
        amount: amountFor(unit), unit: unit,
        note: '', noteDraft: '',
        // these belong to sending; left set, they decide what the receive screen shows
        recipient: '', recipientKind: '',
      }, rail ? { recvRail: rail } : {}));
      return done();
    }

    /* The one send-side screen with an amount on it that needs no payee: making an
     * ecash token (renderSend's goMakeEcash). Dollars, as that screen opens. */
    if (target === 'token') {
      const unit = unitOr('USD');
      go({
        screen: 'amount', flow: 'send', tokenMode: true, asset: 'BITCOIN',
        amount: amountFor(unit), unit: unit,
        recipient: '', recipientKind: '', note: '', noteDraft: '',
      });
      return done();
    }

    /* Splitting a bill. Its keypad counts in cents, the way it is typed — amt=200 is
     * the $2.00 that spAmtNext is the minimum for — and on chain is not a way to
     * collect a share, so it is not one here (goSplit). */
    if (target === 'split') {
      const cents = raw('amt');
      const rail = railIn(['LIGHTNING', 'CASHU']);
      go({
        screen: 'spAmount',
        spAmt: /^[0-9]{1,9}$/.test(cents) && parseInt(cents, 10) > 0
          ? String(parseInt(cents, 10)) : '0',
        spWays: 4, spIdx: 0, spAssigns: [], spPaid: [], spShares: null, spInvoices: [],
        spRail: rail || ((W && W.defaultRail && W.defaultRail() === 'CASHU') ? 'CASHU' : 'LIGHTNING'),
        spEditIdx: -1, spEditBuf: '', spCopied: -1, spShared: -1, spFromWaiting: false,
      });
      return done();
    }

    return false;
  }
