
  /* Pull-to-refresh, by hand.
   *
   * There is no touch binding in the runtime, so the list is handed over as a
   * ref and the gesture is attached directly. Only fires when the list is
   * already at the top, so it never fights an ordinary scroll.
   */
  histRef(el) {
    if (!el || el === this._histEl) return;
    this._histEl = el;

    const bar = document.createElement('div');
    bar.style.cssText =
      'position:absolute;left:0;right:0;top:0;height:56px;display:flex;' +
      'align-items:center;justify-content:center;pointer-events:none;' +
      'font-family:SatSymbol,Sora,system-ui,sans-serif;font-size:15px;font-weight:800;' +
      'letter-spacing:.06em;color:rgba(255,255,255,.55);opacity:0;' +
      'transition:opacity .15s ease';
    bar.textContent = 'PULL TO REFRESH';
    el.style.position = el.style.position || 'relative';
    el.appendChild(bar);

    let y0 = null, pulled = 0, busy = false;
    const READY = 64;

    el.addEventListener('touchstart', e => {
      y0 = el.scrollTop <= 0 ? e.touches[0].clientY : null;
      pulled = 0;
    }, { passive: true });

    el.addEventListener('touchmove', e => {
      if (y0 === null || busy) return;
      pulled = e.touches[0].clientY - y0;
      if (pulled <= 0) { bar.style.opacity = '0'; el.style.transform = ''; return; }
      // resistance, so it feels like pulling against something
      const shift = Math.min(pulled * 0.4, 72);
      el.style.transform = 'translateY(' + shift + 'px)';
      bar.style.opacity = String(Math.min(shift / READY, 1));
      bar.textContent = shift >= READY * 0.9 ? 'RELEASE TO REFRESH' : 'PULL TO REFRESH';
    }, { passive: true });

    const finish = () => {
      if (y0 === null) return;
      const go = pulled * 0.4 >= READY * 0.9 && !busy;
      y0 = null; pulled = 0;
      el.style.transition = 'transform .22s cubic-bezier(.2,.9,.25,1)';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; }, 240);
      if (!go) { bar.style.opacity = '0'; return; }

      busy = true;
      bar.textContent = 'REFRESHING\u2026';
      bar.style.opacity = '1';
      // the mint is not asked about every proof held (see retryConnect)
      Promise.resolve(this.refreshBalance())
        .then(() => this.loadHistory())
        .catch(() => {})
        .then(() => {
          busy = false;
          bar.style.opacity = '0';
          bar.textContent = 'PULL TO REFRESH';
        });
    };
    el.addEventListener('touchend', finish, { passive: true });
    el.addEventListener('touchcancel', finish, { passive: true });
  }

  /* Hear when a token is redeemed, within seconds where that gives nothing away.
   *
   * The wallet keeps the watch (FoxyWallet.watchTokenClaim, 05-paying-this-mint.js)
   * and asks about the token's fingerprints alone, on a circuit of its own. The
   * timing is here, each wait random within its range:
   * - A token made with a swap: the first question 15 to 45 seconds after it,
   *   so the mint cannot tie the question, and the token, to that swap.
   * - A token made from pieces already held (no swap), or any token after a
   *   return from the background: the first question in 2 to 4 seconds. There
   *   is no swap in that moment for it to be tied to.
   * - After that, every 3 to 5 seconds for its first two minutes, 15 to 30
   *   seconds until ten, then 1 to 2 minutes, for a day; and 2 to 3 seconds
   *   again when Tor was not up to ask.
   * Every token is watched on every screen. A token redeemed while its ECASH
   * TOKEN screen is open gets the payment confirmation; anywhere else, a note
   * (a confirmation two hours later interrupted another
   * payment). */
  /* How long to wait before asking the mint again whether a sent token has
   * been redeemed. A range, not a figure: an exact cadence is a pattern at the
   * mint, and every wallet asking on the same beat is easier to tell apart.
   *
   * `watching` is for a token on its own screen. Someone standing there has
   * handed over a QR code and is waiting for one thing only, and until now
   * they waited for it on the same ladder as a token nobody is looking at:
   * three to five seconds between asks, and up to forty-five before the FIRST
   * ask on a token just made. So the person who redeemed it saw their money
   * arrive while the person who sent it watched a screen that had not caught
   * up. While they are looking, it is asked about roughly
   * once a second; the moment they leave, the ordinary ladder takes over. */
  CLAIM_WAITS = { watching: [900, 1500], first: [15000, 45000], quick: [2000, 4000],
    soon: [3000, 5000], later: [15000, 30000], rarely: [60000, 120000], offline: [2000, 3000] };

  claimWait(kind) {
    const [lo, hi] = this.CLAIM_WAITS[kind];
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  /* How long until the next question about a watch that has been running `age`
   * ms. `onScreen` is that token shown on the ECASH TOKEN screen right now. */
  claimWaitFor(age, onScreen) {
    if (onScreen) return this.claimWait('watching');
    return this.claimWait(age < 120000 ? 'soon' : age < 600000 ? 'later' : 'rarely');
  }

  /* This token is the one the ECASH TOKEN screen is showing. */
  tokenOnScreen(hash) {
    return this.state.screen === 'tokenOut' && !!hash && this.state.tokenOutHash === hash;
  }

  /* Opening a token's own screen: ask about it now, not on whatever the ladder
   * had scheduled — which for a token just made is up to 45 seconds away. */
  tokenWatchNow() {
    const hash = this.state.tokenOutHash;
    if (!hash) return;
    this._claimNext = this._claimNext || {};
    if (this._claimNext[hash] !== Infinity) this._claimNext[hash] = 0;   // not mid-question
    this.claimWatchTick();
  }

  watchToken(sats, hash, quick) {
    const W = window.FoxyWallet;
    if (!W || !W.watchTokenClaim || !hash) return;
    if (!W.watchTokenClaim(hash, { persist: true, quick: !!quick })) return;
    this._claimNext = this._claimNext || {};
    this._claimNext[hash] = Date.now() + this.claimWait(quick ? 'quick' : 'first');
    this.claimWatchTick();
  }

  /* After a return from the background: every watch is asked about within seconds. */
  claimWatchResume() {
    const W = window.FoxyWallet;
    this._claimNext = {};
    if (W && W.watchedTokens) {
      W.watchedTokens().forEach(r => { this._claimNext[r.hash] = Date.now() + this.claimWait('quick'); });
    }
    this.claimWatchTick();
  }

  claimWatchTick() {
    const W = window.FoxyWallet;
    clearTimeout(this._claimT);
    /* No wallet on the page yet: ask again rather than never.
     *
     * This is ticked from a screen as well as from a watch (the ECASH TOKEN
     * screen's DONE), and a tick that lands before the wallet script has
     * loaded used to return leaving no timer — the same shape as the on-chain
     * watcher's dead pass. */
    if (!W || !W.watchedTokens) {
      this._claimT = setTimeout(() => this.claimWatchTick(), 20000);
      return;
    }
    this._claimNext = this._claimNext || {};
    // a watch kept from before every token was watched on every screen
    W.watchedTokens().forEach(r => { if (!r.persist) W.dropTokenWatch(r.hash); });
    const live = W.watchedTokens();
    /* Nothing being watched needs no timer: unlike an on-chain deposit, a
     * watch cannot appear on its own — watchToken makes one and ticks, and a
     * return calls claimWatchResume. */
    if (!live.length) return;
    const now = Date.now();
    let soonest = Infinity;
    live.forEach(r => {
      if (this._claimNext[r.hash] == null) this._claimNext[r.hash] = now + this.claimWait(r.quick ? 'quick' : 'first');
      soonest = Math.min(soonest, this._claimNext[r.hash]);
    });
    this._claimT = setTimeout(() => this.claimWatchDue(), Math.max(0, soonest - now));
  }

  /* Every path out of this asks again.
   *
   * The token has already left this wallet; this loop is the only thing that
   * ever turns its history entry green and clears the text out of the notes.
   * The chain below re-ticks on both settlements, but a throw before the
   * chain is built — no wallet on the page, or a mint call that fails on the
   * spot rather than in a promise — used to end the watching for the rest of
   * the session, the way every early return in onchainWatch did. */
  claimWatchDue() {
    const W = window.FoxyWallet;
    if (!W || !W.watchedTokens) { this.claimWatchTick(); return; }
    const now = Date.now();
    this._claimNext = this._claimNext || {};
    const due = W.watchedTokens().filter(r => (this._claimNext[r.hash] || 0) <= now);
    // one question at a time, so two tokens are not asked about in the same second
    const r = due[0];
    if (!r) { this.claimWatchTick(); return; }
    this._claimNext[r.hash] = Infinity;
    // a mint call that throws where it stands still leaves the loop a timer
    let asked;
    try { asked = W.tokenClaimState(r.hash); } catch (e) { asked = Promise.reject(e); }
    Promise.resolve(asked).then(st => {
      if (st === 'offline') { this._claimNext[r.hash] = Date.now() + this.claimWait('offline'); return; }
      if (st !== 'claimed') {
        this._claimNext[r.hash] = Date.now()
          + this.claimWaitFor(Date.now() - (r.since || 0), this.tokenOnScreen(r.hash));
        return;
      }
      /* The watch may have ended while the question was out: the token taken
       * back into this wallet (dropTokenWatchesFor), whose own redemption is
       * the SPENT this answer reports. Seen on a phone: a token pasted back
       * in was noted as redeemed 130 ms later. */
      if (!W.watchedTokens().some(x => x.hash === r.hash)) { delete this._claimNext[r.hash]; return; }
      W.dropTokenWatch(r.hash);
      delete this._claimNext[r.hash];
      W.settleTx(r.hash);
      // claimed: its text has no reason to stay in the notes or the audit trail
      if (W.forgetClaimedToken) W.forgetClaimedToken(r.hash);
      if (W.lastTokenHash() === r.hash) W.clearLastToken();
      const onItsScreen = this.state.screen === 'tokenOut' && this.state.tokenOutHash === r.hash;
      if (this.state.tokenOutHash === r.hash) {
        this.setState({ tokenOut: '', tokenOutSats: 0, tokenCopied: false, tokenForPayee: false });
      }
      this.refreshBalance();
      this.loadHistory();
      // in the token's own unit: a dollar token's figure is its cents
      const usdTok = r.unit === 'usd';
      console.log('[foxy] token claimed:', usdTok ? r.amount + ' cents' : r.sats + ' sats', onItsScreen ? '(on its screen)' : '(a note)');
      if (onItsScreen) {
        this.announcePayment(usdTok
          ? { dir: 'out', sats: 0, unit: 'usd', amount: r.amount, hash: 'tokenclaim-' + r.hash, to: 'ecash', tokenHash: r.hash }
          : { dir: 'out', sats: r.sats, hash: 'tokenclaim-' + r.hash, to: 'ecash', tokenHash: r.hash });
      } else {
        this.toast('Your ecash token for ' + (usdTok ? this.moneyIn(r.amount, 'usd') : this.group(r.sats) + ' sats') + ' was redeemed');
      }
    }).catch(() => {
      this._claimNext[r.hash] = Date.now() + this.claimWait('later');
    }).then(() => this.claimWatchTick());
  }

  /* The ECASH TOKEN screen's QR code, animated for a token of more than two
   * proofs (FoxyWallet.tokenQrAnimates): one code for such a token was too
   * dense for some cameras. A new frame every 200 ms, the same UR frames
   * cashu.me shows, so cashu.me and Foxy read them (06-animated-qr.js). The
   * code is drawn as large as the screen allows. Each frame is drawn straight
   * into the image, not through a render; renderToken shows the latest one. */
  /* Nothing is drawn on a token's animated code, so its frames carry the
   * lightest error correction and two and a half times the data.
   *
   * Every code in Foxy had the badge in its middle, and the badge covers
   * modules a reader needs: a frame at 'L' can lose 7% of its codewords and
   * the badge took 12%, so the frames were raised to 'Q' to be read at all.
   * That paid for a picture with half of every frame. A frame that is missed
   * is made up by the ones after it (that is what the fountain is for), which
   * a still code has no way to do; so the badge stays on still codes and
   * comes off the ones that move (`tokenQrBadge`), and the frames go back to
   * 'L'. With the compact mode asked for (`FoxyWallet.qr`), a fragment of
   * 500 is 89 modules where one of 200 was 97: fewer frames, and each
   * drawn larger. tests/qr-readable.js holds both. */
  TOKEN_QR = { fragment: 500, everyMs: 200, ecc: 'L' };

  /* A request too dense for one code is animated too, and that code has the
   * TAP button in its middle, which is a control and stays. So these frames
   * keep the heavy correction the button needs.
   *
   * And are smaller. A fragment of 200 made a frame of 97 modules, which is
   * 2.3 points each in the 240-point box this screen has on the smallest
   * phone, under the 3 a camera wants; the test meant to hold that line
   * measured a frame less than half as long as a real one. At 150, in the
   * compact mode, a frame is 69 modules and 3.1 points. */
  REQ_QR = { fragment: 150, everyMs: 200, ecc: 'Q' };

  /* How much of a code the badge in its middle hides, as a fraction of the
   * width of the whole box. The markup draws it at 50 points inside 240. */
  QR_BADGE = 50 / 240;

  syncTokenQr() {
    const W = window.FoxyWallet;
    const shown = this.state.screen === 'tokenOut'
      ? (this.state.tokenOut || ((W && W.lastToken && W.lastToken()) || {}).token || '') : '';
    const animate = !!(shown && W && W.tokenQrAnimates && W.tokenQrAnimates(shown));
    if (this._tokQr && (!animate || this._tokQr.token !== shown)) {
      clearInterval(this._tokQr.timer);
      this._tokQr = null;
    }
    if (!animate || this._tokQr) return;
    const frames = W.animatedQr(shown, this.TOKEN_QR.fragment);
    const run = { token: shown, src: '', timer: 0 };
    const tick = () => {
      // error correction L: the fountain code already makes up for a frame missed
      const src = W.qr(frames.next(), { ecc: this.TOKEN_QR.ecc });
      if (!src) return;
      run.src = src;
      const img = document.querySelector('[data-token-qr]');
      if (img && img.getAttribute('src') !== src) img.setAttribute('src', src);
    };
    this._tokQr = run;
    tick();
    run.timer = setInterval(tick, this.TOKEN_QR.everyMs);
  }

  /* The receive screen's code, animated when one static code would be too dense
   * to read.
   *
   * `qrTooDense` has measured this for a while and nothing acted on it: a
   * request carrying both an onion address and a Nostr profile is 93 modules,
   * which is 2.6 points each in the box an iPhone XS gives it, and phone
   * cameras want about three — more at an angle or in poor light. So the code
   * was shown, and it was unreadable, and it was scanned again and again on
   * the small phone while the same code read fine on the big one.
   *
   * The same frames the token screen uses, for the same reason and read by the
   * same wallets. Only where the measurement says so: a request with a sat
   * amount and one transport is well inside the limit, and a code that stands
   * still is easier to scan than one that does not.
   */
  /* What went into the QR on screen, said once per change.
   *
   * Three reports in a row that "the QRs do not work" and nothing in the diary
   * could tell them apart: a code that was never drawn, one drawn from the
   * wrong text, one too dense to read, and one the camera simply could not see
   * all look identical afterwards. So the screen says what
   * it drew — the rail, where the text came from, how long it was, how many
   * modules that made, and whether it is animating.
   *
   * Once per change, never per render: this runs inside the render and a line
   * per frame would bury everything else.
   */
  noteQr(src, about) {
    const s = String(src || '');
    const key = (about.rail || '') + '|' + (about.from || '') + '|' + about.chars
      + '|' + (about.dense ? 'd' : '') + (about.animating ? 'a' : '') + '|' + s.length;
    if (this._qrSaid === key) return;
    this._qrSaid = key;
    /* The module count is the thing that decides whether a camera can read it:
     * the box is about 240 points across, so 93 modules is 2.6 points each and
     * 65 is 3.7. Most phone cameras want about three. */
    let modules = 0;
    try {
      const svg = decodeURIComponent(s.replace(/^data:image\/svg\+xml;utf8,/, ''));
      const m = /viewBox="0 0 (\d+)/.exec(svg);
      modules = m ? Number(m[1]) : 0;
    } catch (e) {}
    const loading = s && s === this.qrLoadingSrc();
    const kind = !s ? 'NOTHING'
      : loading ? 'the waiting animation, no code yet'
      : modules ? modules + ' modules' : 'a code';
    console.log('[foxy] qr: ' + about.rail + ' shows ' + kind
      + ' from ' + about.from + ' (' + about.chars + ' chars)'
      + (about.dense ? ', too dense for one' : '')
      + (about.animating ? ', animating' : ''));
  }

  /* Is one code too dense to read, asked once per request rather than per
   * render.
   *
   * `qrTooDense` encodes the whole code to count its modules, and the render
   * asked it on every pass — several times a second, on the phone least able
   * to afford it. The answer cannot change for a given request, so it is
   * remembered. One entry: the request on screen is the only one being asked
   * about.
   */
  qrDense(text) {
    const W = window.FoxyWallet;
    const t = String(text || '');
    if (!t || !W || !W.qrTooDense) return false;
    if (this._denseOf !== t) {
      this._denseOf = t;
      this._denseWas = !!W.qrTooDense(t);
    }
    return this._denseWas;
  }

  syncReqQr() {
    const W = window.FoxyWallet;
    const s = this.state;
    const on = s.screen === 'confirm' && s.flow === 'receive' && s.recvRail === 'CASHU';
    const text = on ? (this.cashuRequest() || '') : '';
    const animate = !!(text && this.qrDense(text));
    if (this._reqQr && (!animate || this._reqQr.text !== text)) {
      clearInterval(this._reqQr.timer);
      this._reqQr = null;
      /* And a render, so the right code comes back. Without it the image keeps
       * the last frame of the request before it — a code for the wrong amount,
       * or a fragment of one, which is what "it scanned once and never again"
       * looks like from the outside. */
      this.setState({ creqMade: Date.now() });
    }
    if (!animate || this._reqQr) return;
    console.log('[foxy] the request is too dense for one code on a small screen; animating it');
    const frames = W.animatedQr(text, this.REQ_QR.fragment);
    const run = { text: text, src: '', timer: 0 };
    const tick = () => {
      const src = W.qr(frames.next(), { ecc: this.REQ_QR.ecc });
      if (!src) return;
      run.src = src;
      const img = document.querySelector('[data-req-qr]');
      if (img && img.getAttribute('src') !== src) img.setAttribute('src', src);
    };
    this._reqQr = run;
    tick();
    run.timer = setInterval(tick, this.REQ_QR.everyMs);
  }

  /* Small change on hand, so most tokens need no swap and are heard about as
   * soon as they are redeemed (FoxyWallet.tidyChange). At a random moment 4
   * to 10 seconds after the wallet is ready or money has moved; not while
   * money is moving, and going looking at most once every twenty seconds. It
   * was 20 to 90 seconds and two minutes, and the pool was still nearly empty
   * after ten minutes of use. A pile that already has its
   * small change asks nothing. */
  TIDY_WAIT = [4000, 10000];

  /* And how long between one swap and the next while the pool is still short.
   *
   * Each run splits one piece, and a pool filling from scratch is twelve of each
   * of eight small denominations before the deep ones even begin. At the idle
   * pace above — twenty to ninety seconds, floored at two minutes, and only when
   * something re-armed it — that is far longer than anybody holds an app open,
   * so the pool was found half full when exact change was needed.
   *
   * So the wait is for going looking, not for making progress: once a swap has
   * worked and something is still short, the next follows in a few seconds and
   * keeps following until nothing is short or the mint says no. The spacing that
   * matters for not making a recognisable burst at the mint is still there — it
   * is random, and it is the gap between the runs themselves. */
  TIDY_AWAY_STOP = 12000;
  TIDY_MORE = [2500, 6000];

  /* A token from a mint this wallet does not use is being priced, or moved.
   *
   * moneyBusy() does not see this whole stretch: the fee is quoted, and then
   * nothing holds the proof lock while the person reads the screen and decides,
   * and the claim only takes it once they tap. A tidy armed earlier landed in
   * exactly that gap on a phone and spent fourteen seconds asking the mint
   * about change it turned out not to need — then the claim that followed took
   * six seconds to reconnect to a mint it had been connected to a moment
   * before (seen in a device log). A move between
   * mints is six round trips over Tor already; it does not share them with
   * housekeeping. */
  movingMints() {
    const s = this.state;
    return s.screen === 'newMint' || !!s.nmBusy;
  }

  /* `more` is a run that follows one that worked: it comes sooner and is not
   * held back by the two-minute floor, which exists to stop this going looking
   * over and over, not to stop it finishing what it started. */
  /* The phone says Foxy has been put away (FoxyWebView.appEnteredBackground).
   * A top-up still waiting its turn goes now, while Tor is held up for it. */
  /* The phone says Foxy has been put away (FoxyWebView.appEnteredBackground),
   * or back. Put away is the only time a top-up swap runs: never in front of
   * somebody who might be about to pay, and never behind a screen asking
   * them to wait. The phone keeps Tor on the network for
   * it, twenty seconds; no swap starts after twelve, and one still out at
   * eighteen has its piece checked and left spendable (`topUpClosing`). */
  putAway(on) {
    this._putAway = !!on;
    clearTimeout(this._closingT);
    if (!on) return;
    // a question waiting to be asked again on a new circuit is not asked from the background (the house rule for timers)
    try { const Wa = window.FoxyWallet; if (Wa && Wa._stopAskingAgain) Wa._stopAskingAgain(); } catch (e) {}
    // a card set-up's entries kept for a TRY AGAIN, its PIN among them, are not kept in the background (26j-card-wheel.js `fcSuForget`)
    if (this.fcSuForget) this.fcSuForget();
    this._putAwayAt = Date.now();
    if (this._tidyOwed || this._tidyT) this.tidyChangeLater(this._tidyMore);
    this._closingT = setTimeout(() => {
      const W = window.FoxyWallet;
      if (this._putAway && W && W._tidying && W.topUpClosing) W.topUpClosing().catch(() => {});
    }, 18000);
  }

  /// Whether a send is waiting its turn behind the change top-up.
  sendBehindChange() {
    const W = window.FoxyWallet;
    const h = W && W.proofLockHolder && W.proofLockHolder();
    return !!h && h.what === 'tidyChange' && (this.state.sendPhase || 'in') === 'in';
  }

  onConfirmation() {
    const s = this.state;
    return s.screen === 'paid' || (s.screen === 'sendDone' && (s.sendPhase === 'done' || s.sendPhase === 'settled'));
  }

  /* Straight after a payment, not seconds later. The wait before a top-up
   * was long enough for somebody to be paid, pocket the phone, and find no
   * change to give at the next payment. */
  /* A payment changes what there is to break. Nothing runs here: the top-up
   * waits for Foxy to be put away (putAway), and the "not twice in twenty
   * seconds" rule is set aside for it. */
  tidyChangeNow() {
    this._tidyOwed = true;
    this._tidyAt = 0;
  }



  tidyChangeLater(more) {
    const W = window.FoxyWallet;
    if (!W || !W.tidyChange) return;
    clearTimeout(this._tidyT);
    this._tidyT = null;
    if (!this._putAway) { this._tidyOwed = true; this._tidyMore = !!more; return; }
    this._tidyOwed = false;
    const [lo, hi] = more ? this.TIDY_MORE : this.TIDY_WAIT;
    /* Put away with a top-up still to do: it starts now, and the phone is told
     * so. The wait is for a person who is still here; one who has left gives
     * Foxy seconds, and Tor stays on the network only while `_tidying` says
     * there is something for it to carry (FoxyWebView.appEnteredBackground). */
    const away = true;
    this._tidyMore = !!more;
    W._tidying = true;
    this._tidyT = setTimeout(() => {
      this._tidyT = null;
      W._tidying = false;
      /* No new swap once Foxy has been away twelve seconds. The phone takes
       * Tor off the network at twenty, and a swap cut off there has its piece
       * held out of the balance until the phone is online again — which an
       * offline wallet may not be for a while. Eight seconds is room for the
       * last one to be answered. The rest is done on return (`_onWake`). */
      if (this._putAway && Date.now() - (this._putAwayAt || 0) > this.TIDY_AWAY_STOP) {
        console.log('[foxy] small change: away too long to start another swap; the rest on return');
        this._tidyOwed = true;
        return;
      }
      /* Nor while change is on its way back to this phone: the top-up would
       * hold the proof lock, the change would wait behind it, and the
       * receiver would not be told in time that it was kept. */
      // (and while a card's sheet is up: every command to the card rides the thread this would)
      if (this.moneyBusy() || this.movingMints() || this._changeDueAt || (W.cardSheetUp && W.cardSheetUp())) { this.tidyChangeLater(more); return; }
      // brought back meanwhile: the rest waits for the next put-away
      if (!this._putAway || this._tapTalking || this.state.tapArmed) {
        this.tidyChangeLater(more);
        return;
      }
      if (!more && Date.now() - (this._tidyAt || 0) < 20000) return;
      this._tidyAt = Date.now();
      W._tidying = true;
      W.tidyChange().then(r => {
        W._tidying = false;
        /* A swap that worked means there may be more to do, so the next one is
         * armed straight away. It stops on its own: `tidyChange` answers
         * `skipped` the moment the pool has what it wants, or there is no route,
         * or the piece it would need is not there. */
        if (r && r.split) {
          this.refreshBalance();
          this.tidyChangeLater(true);
          return;
        }
        if (r && r.skipped) console.log('[foxy] small change: ' + r.skipped);
      }).catch(() => { W._tidying = false; });
    }, away ? 400 : lo + Math.floor(Math.random() * (hi - lo + 1)));
  }

  /* An invoice made by the mint this wallet pays from: its payer and payee are
   * both that mint's users, and paying by Lightning shows the mint both. A
   * token instead leaves it amount and timing. The token screen says who it
   * is for, and the token is watched until it is redeemed. */
  payThisMintWithToken(sats, go) {
    const W = window.FoxyWallet;
    if (!(sats > 0) || this.state.makeBusy) return;
    /* A bitcoin token, from the bitcoin balance. Dollars cannot become one
     * without the mint, so a phone paying from dollars is told so. */
    if (this.twoUnitsOn && this.twoUnitsOn() && this.walletNow('send') === 'usd') {
      this.toast('Dollars need the mint. Pick BITCOIN to pay this with no connection.', true);
      return;
    }
    this.setState({ makeBusy: true });
    this.showMelt('Making the token\u2026', 0, { sats: sats });
    this._preSettle = this.balNow();
    /* With no route the token is made from the pieces on hand, covering the
     * amount where they cannot make it exactly — asked about first. */
    const off = !!(this.offlineNow && this.offlineNow());
    W.sendToken(sats, off ? { cover: true, changeNote: true, overpayOk: !!(go && go.overpayOk) } : undefined).then(r => {
      this.hideMelt();
      this._seenTx = this._seenTx || {};
      this._seenTx[r.hash] = true;
      this.setState({
        makeBusy: false, tokenCopied: false,
        tokenOut: r.token, tokenOutSats: r.sats, tokenOutHash: r.hash, tokenOutUnit: '', tokenForPayee: true,
        tokenOutFee: Math.max(0, sats - r.sats),
        screen: 'tokenOut', stack: [],
      });
      if (off) this.needScanStage(r);
      this.refreshBalance();
      this.watchToken(r.sats, r.hash, r.swapped === false);
      this.tidyChangeLater();
    }).catch(e => {
      this.hideMelt();
      this.setState({ makeBusy: false });
      if (e && e.foxyNeedsOverpay) {
        this.overpayCard(Object.assign({}, e.foxyNeedsOverpay, { changeComesBack: false,
          says: 'This phone is offline and cannot make change, so they keep the extra'
            + ' unless they hand it back.' })).then((yes) => {
          if (yes) this.payThisMintWithToken(sats, { overpayOk: true });
        });
        return;
      }
      if (this.isBadSignatures(e)) { this.badSignatureCard(null, 'swap'); return; }
      this.toast(W.reason(e), true);
    });
  }

  /* The receive screen's SCAN: someone paying this invoice may hand over a
   * token instead. Taken as any scanned token is; the invoice screen closes,
   * and the history pass says the payment arrived, as it does for an invoice. */
  scanTokenToReceive() {
    const W = window.FoxyWallet;
    if (!W || !W.scan) return;
    // a cashier's till takes a token for its keeper, never into this phone's pile (26m-till.js, `tillScanToken`)
    if (this.tillRole && this.tillRole() === 'cashier') { this.tillScanToken(); return; }
    W.scan('Scan an ecash token').then(text => {
      const t = String(text || '').trim();
      if (W.classify(t) !== 'token') {
        this.toast('That QR is not a Cashu token.', true);
        return;
      }
      this.closeReceive();
      this.showMelt('Receiving ecash\u2026');
      if (this.offerNewMint(t)) { this.hideMelt(); return; }
      if (this.tokenSwitchRefused(t)) { this.hideMelt(); return; }
      this._preSettle = this.balNow();
      return W.receiveToken(t).then(r => {
        this.hideMelt();
        if (r.switched) this.walletReady({ name: r.host });
        this.tookToken(r);
        this.announceTaken(r);
        this.refreshBalance();
        this.loadHistory();
        this.noteReceived();
        this.keptOfflineSaid(r);
      });
    }).catch(e => { this.hideMelt(); this.claimFailed(e, () => this.scanTokenToReceive()); });
  }

  /* Hand someone ecash directly. The amount on the keypad is what leaves;
   * the token screen shows it as a QR and a string. */
  makeEcashToken() {
    const W = window.FoxyWallet;
    /* From the balance that pays, at a mint with two: the one picked, or
     * the other where it cannot cover the amount (`keypadWallet`). A dollar
     * token is its cents, exactly; it cannot be made offline or locked. */
    if (this.twoUnitsOn && this.twoUnitsOn()) {
      if (this.keypadWallet) this.keypadWallet();
      if (this.walletNow('send') === 'usd') { this.makeUsdToken(); return; }
    }
    const sats = this.amountInSats();
    if (!(sats > 0)) {
      this.toast('Enter an amount first', true);
      return;
    }
    if (this.state.makeBusy) return;
    this.setState({ makeBusy: true });
    this.showMelt('Making the token\u2026');
    // the sats leave as soon as the token exists; hold the old figure so the
    // pill can count down when the screen is closed
    this._preSettle = this.balNow();
    // a plain token: Foxy never locks what it sends
    W.sendToken(sats).then(r => {
      this.hideMelt();
      // our own entry, not an incoming payment — the sweep must not announce
      // it over the top of the screen holding the token
      this._seenTx = this._seenTx || {};
      this._seenTx[r.hash] = true;
      this.setState({
        makeBusy: false, tokenCopied: false,
        tokenOut: r.token, tokenOutSats: r.sats, tokenOutHash: r.hash, tokenOutUnit: '', tokenForPayee: false,
        tokenOutFee: Math.max(0, sats - r.sats),
        screen: 'tokenOut', stack: [],
      });
      this.refreshBalance();
      this.watchToken(r.sats, r.hash, r.swapped === false);
      this.tidyChangeLater();
    }).catch(e => {
      this.hideMelt();
      this.setState({ makeBusy: false });
      if (this.isBadSignatures(e)) { this.badSignatureCard(null, 'swap'); return; }
      this.toast(W.reason(e), true);
    });
  }

  /* A dollar token: the cents typed, from the dollar balance. With a route
   * the mint makes it; offline it is made from dollar pieces on hand that make
   * the amount exactly (or dollars this phone was paid offline), and where they
   * cannot the wallet says so in words and nothing is sent. Offline the token
   * is shown as a code for the other phone to scan. */
  makeUsdToken() {
    const W = window.FoxyWallet;
    const cents = this.centsTyped();
    if (!(cents > 0)) { this.toast('Enter an amount first', true); return; }
    if (this.state.makeBusy) return;
    const off = !!this.offlineNow();
    this.setState({ makeBusy: true });
    this.showMelt('Making the token\u2026');
    this._preSettle = this.balNow();
    W.sendToken(cents, { unit: 'usd' }).then(r => {
      this.hideMelt();
      this._seenTx = this._seenTx || {};
      this._seenTx[r.hash] = true;
      const got = Math.round(Number(r.amount != null ? r.amount : cents) || 0);
      this.setState({
        makeBusy: false, tokenCopied: false,
        tokenOut: r.token, tokenOutSats: 0, tokenOutHash: r.hash, tokenForPayee: false,
        tokenOutUnit: 'usd', tokenOutAmount: got,
        tokenOutFee: Math.max(0, cents - got),
        screen: 'tokenOut', stack: [],
      });
      if (off) this.needScanStage(Object.assign({}, r, { unit: 'usd', amount: got }));
      this.refreshBalance();
    }).catch(e => {
      this.hideMelt();
      this.setState({ makeBusy: false });
      if (this.isBadSignatures(e)) { this.badSignatureCard(null, 'swap'); return; }
      this.toast(W.reason(e), true);
    });
  }

  /* Whatever is on the keypad, in sats, whichever unit it was typed in. */
  amountInSats() {
    const s = this.state;
    const v = parseFloat(s.amount) || 0;
    if (!v) return 0;
    if (s.unit === 'SATS') return Math.round(v);
    const px = this.px();
    if (!px) return 0;
    return Math.round((v / px) * 1e8);
  }

  /* A payment request. Nothing here can deliver over nostr, so the offer is
   * the honest one: make the token, hand it over yourself. */
  /* `opts.viaTap` when this request came over an open Bluetooth link, so the
   * payment can go back over it. Never inferred: a scanned request must not be
   * paid to whichever phone is connected. */
  openRequest(text, opts) {
    const W = window.FoxyWallet;
    const req = W.decodeRequest(text);
    if (req && opts && opts.viaTap) req.viaTap = true;
    /* Whether the phone that made this request has a route, as it said in its
     * tap offer. Carried on the request because that is what `payRequest`
     * reads, and it is the one fact the hand-over rules cannot be held up
     * without (`handoverRefusal`). */
    if (req && opts && typeof opts.theirRoute === 'boolean') req.theirRoute = opts.theirRoute;
    // and whether it answers a question before the payment (`askFirst`), from the same offer
    if (req && opts && opts.asks) req.asks = true;
    // and the till tag it gave with no route, for the payer's name to it (`payerTag`)
    if (req && opts && opts.theirTill) req.theirTill = String(opts.theirTill);
    /* Not while a request payment is still out (`_reqRun`, makeTokenForRequest).
     *
     * STOP WAITING leaves the sending screen and the payment runs on. This
     * cleared `reqBusy` unconditionally, so the same donation code scanned
     * again to "try again" was paid a second time while the first post was
     * still with the site, and a different request run beside it had its
     * visit pulled from under it when the first one came home. */
    /* A tap's other phone is told, and the toast says which payment is out
     * and how long it has: it was two seconds of "Wait for it", and the
     * phone that asked sat on its four digits until its own clock ran out. */
    if (this.reqRunLive ? this.reqRunLive() : this._reqRun) {
      console.log('[foxy] request: another request payment is still being delivered; this one waits');
      if (this.refuseForRun) this.refuseForRun(!!(opts && opts.viaTap));
      else this.toast('A payment is still being delivered. Wait for it.', true);
      return;
    }
    /* Nor over a request whose owed move is still being collected
     * (COLLECTING…, `_reqCollect`). Its pass comes back by itself and finds
     * another request on screen, so the one it was for was dropped with the
     * other phone of a tap told nothing, and PAY on the new one did nothing
     * while COLLECTING… was still set. A request left before it is opened
     * again is not held: its pass is dropped and says so. */
    if (this.state && this.state.reqCollecting && this._reqCollect && this.state.req === this._reqCollect) {
      console.log('[foxy] request: an owed move is still being collected for the request on screen; this one waits');
      if (opts && opts.viaTap && W.tapQuote) {
        W.tapQuote(JSON.stringify({ gaveUp: 'The payer is finishing another payment. Tap again in a moment.' })).catch(() => {});
      }
      this.toast('Foxy is collecting an earlier move. Wait for it.', true);
      return;
    }
    /* A request just opened is not one being paid.
     *
     * `reqBusy` is what makes the button say PAYING…, and a route that leaves
     * it set — a payment abandoned part way, a screen left — carried it into
     * the next request, which arrived already claiming to be paying and could
     * not be tapped. No request payment is alive (above), so a flag still
     * set is a stale one. */
    this.setState({ reqBusy: false });
    if (!req) { this.toast('That request could not be read.', true); return; }
    /* A request in dollars is paid in dollar ecash, from the dollar balance,
     * at the mint that issues it, with no price anywhere. Only at the mint this
     * phone is on, and only where that mint holds dollars: dollar ecash is not
     * moved between mints. */
    /* Or at another mint it names where this phone holds enough dollars (`reqHeldAt`), paid there on a visit
     * (`makeTokenForRequest`), as sats held at a mint a request names are. */
    if (req.unit === 'usd') {
      const awayUsd = !!(this.reqHeldAt && this.reqHeldAt(req) && !this.requestHere({ mints: [this.reqHeldAt(req)] }));
      if (!awayUsd && (!(this.twoUnitsOn && this.twoUnitsOn()) || !this.requestHere(req))) {
        this.toast('That request asks for dollar ecash at a mint where you hold no dollars.', true);
        return;
      }
    }
    if (req.unit && req.unit !== 'sat' && req.unit !== 'usd') {
      this.toast('That request asks for ' + this.unitLabel(req.unit) + ' ecash. Foxy sends only sats and dollars as ecash.', true);
      return;
    }
    /* A request that asks in dollars, scanned rather than tapped.
     *
     * A phone with no route asks in dollars and leaves the sats to whoever has
     * a current price. Over a tap the two phones then agree the figure; a code
     * read off a screen has nobody to agree it with, so nothing worked the
     * amount out at all — the offer opened on no amount and PAY answered "Ask
     * for an amount above zero".
     *
     * This phone's price makes the sats, and the screen shows both figures
     * before anything is paid. The receiver sees what arrived when they take
     * the token, which is where a scanned payment has always been agreed. */
    if (req.unit !== 'usd' && W.asksInDollars && W.asksInDollars(req)) {
      const q = W.quoteFor ? W.quoteFor(req) : null;
      if (!q) {
        console.log('[foxy] request: asks in dollars and this phone has no price to work it out with');
        this.toast('They asked in dollars, and this phone has no bitcoin price yet. Try again in a moment.', true);
        return;
      }
      req.sats = q.sats;
      console.log('[foxy] request: they asked for $' + (q.usd / 100).toFixed(2) + ', which is '
        + q.sats + ' sats at this phone\u2019s price of $ ' + this.group(Math.round(q.rate)));
    }
    /* What is held at a mint includes what arrived locked to this phone and is
     * waiting to be swapped in. A phone that had only been paid offline held
     * nothing in its pile, so it was told it held nothing at its own mint, a
     * moment before paying from exactly that. */
    // at that mint, not anywhere: what waits at one mint pays nothing at another
    const waitingAt = (u) => { try { return W.unclaimedSats ? W.unclaimedSats(u) : 0; } catch (e) { return 0; } };
    const holdsAt = (m) => {
      const u = String(m).replace(/\/+$/, '');
      return W.balanceAt(u) > 0 || waitingAt(u) > 0;
    };
    if (req.unit !== 'usd' && req.mints.length && !req.mints.some(holdsAt)) {
      this.toast('That request wants a mint you hold nothing at.', true);
    }
    /* The balance that pays is the request's unit: dollars for a request in
     * dollars, bitcoin for sats. For this payment only; home lets it go. */
    const unitPick = (this.twoUnitsOn && this.twoUnitsOn()) ? { wallet: req.unit === 'usd' ? 'usd' : 'sat', walletAuto: false } : {};
    this.setState(p => Object.assign({ screen: 'reqOffer', stack: p.stack.concat([p.screen]), req: req,
      // a note left on an earlier send is not this payment's note
      note: '', noteDraft: '' }, unitPick));
    /* With enough at more than one mint: which pays, before the offer (PAY FROM, 26l-pay-from.js), the request's own
     * mint first and chosen. Nothing is said to the phone in hand yet: this phone may hold enough elsewhere. */
    /* Paid at a mint it names where this phone holds enough, chosen before the offer (`opts.payAt`, a tap's ecash at
     * their mint: 26d-tap.js `tapPayHeld`): the source written as PAY FROM writes one, so the offer is judged and paid
     * there (`reqPayMint`, `pfReqSource`), and nothing more is asked. */
    if (opts && opts.payAt && this.reqMints(req).indexOf(this.reqCanon(opts.payAt)) >= 0) {
      this.setState({ payFromFlow: 'req', payFromList: [], payFromPick: '', payFromAsk: '', payFromTapped: false,
        payFromReopen: false, payMint: this.reqCanon(opts.payAt), payUnit: opts.payUnit === 'usd' ? 'usd' : 'sat' });
      return;
    }
    if (this.pfRequest && this.pfRequest(req)) return;
    // a payer that cannot cover it tells the phone it is touching, before the offer is looked at
    this.tellPayerShort(req);
  }

  /* Is the mint this request is paid at the one this phone is on, or does it
   * name none? Then what the wallet holds and charges here is what the payment
   * is made from, and the screen can judge it before the button is pressed
   * (`requestSpec`). A request for another mint is paid after connecting to
   * that mint (`makeTokenForRequest`), which this phone has not done. */
  /* Any of the mints it names: a till's request names every mint it takes, the default first, and ecash at any of
   * them pays it as it stands (review, payer-cross). */
  requestHere(req) {
    const W = window.FoxyWallet;
    const listed = this.reqMints(req);
    if (!listed.length) return true;
    const here = W && W.mintHost ? this.reqCanon('https://' + W.mintHost()) : '';
    return !!here && listed.indexOf(here) >= 0;
  }

  // a mint as the wallet writes one (`canonicalMint`), or with no slash at the end where the wallet is not there to ask
  reqCanon(u) {
    const W = window.FoxyWallet;
    return W && W.canonicalMint ? W.canonicalMint(u) : String(u || '').trim().replace(/\/+$/, '');
  }

  // the mints a request names, each once, as the wallet writes them, in the request's order
  reqMints(req) {
    const out = [];
    ((req && Array.isArray(req.mints)) ? req.mints : []).forEach((m) => {
      const c = this.reqCanon(m);
      if (c && out.indexOf(c) < 0) out.push(c);
    });
    return out;
  }

  /* The mint a request is paid at: the one chosen for it on PAY FROM where that is one it names; else one it names where
   * this phone holds enough in its unit (`reqHeldAt`: the phone's own first, else the one holding most); else the one the
   * phone is on, where it names that; else the first, its default, which a crossing goes to. A till of two mints was paid
   * at its first only, so a payer holding 1,000 at its second was offered a Lightning crossing into the first (review,
   * payer-cross); and a request naming the mint the phone is on was paid there even where the phone held too little
   * there and enough at another mint it names. '' where it names none. */
  reqPayMint(req) {
    const W = window.FoxyWallet;
    const listed = this.reqMints(req);
    if (!listed.length) return '';
    const s = this.state || {};
    const chosen = (s.payFromFlow === 'req' && s.payMint) ? this.reqCanon(s.payMint) : '';
    if (chosen && listed.indexOf(chosen) >= 0) return chosen;
    const held = this.reqHeldAt ? this.reqHeldAt(req) : '';
    if (held) return held;
    const here = W && W.mintHost ? this.reqCanon('https://' + W.mintHost()) : '';
    if (here && listed.indexOf(here) >= 0) return here;
    return listed[0];
  }

  /* A mint this request names where this phone holds enough to pay it in its own unit, on its face (sats for a request
   * in sats, dollars for one in dollars; the fee for the pieces is the mint's to say): the mint the phone is on where it
   * is one, else the one holding the most. Paid there in ecash, with no Lightning and no fee of Foxy's, on a visit where
   * it is not the phone's own (`makeTokenForRequest`). `amount`, where the request carries none of its own (sats agreed
   * over a tap). '' where none holds enough, or the request names no mint or no amount. */
  /* What a balance at `m` must hold over `need` in `unit` to cover it there on a visit: nothing at a mint whose keysets
   * on file charge nothing for its pieces (or that has none on file, judged on its face and told on the visit); at one
   * that charges, that fee for the pieces spent and the receiver's own swap, at the dearest of its keysets
   * (`pieceFeePpkAt`), counted for twice the pieces the amount makes and four more. Held at exactly the amount, it was
   * chosen, and the visit found it short and offered a crossing from home. */
  reqHeldMargin(m, need, unit) {
    const W = window.FoxyWallet;
    let f = 0;
    try { f = (W && W.pieceFeePpkAt) ? W.pieceFeePpkAt(m, unit === 'usd' ? 'usd' : 'sat') : 0; } catch (e) { f = 0; }
    if (!(f > 0)) return 0;
    let b = 0;
    let v = Math.max(0, Math.round(Number(need) || 0));
    while (v > 0) { b += v % 2; v = Math.floor(v / 2); }
    return Math.ceil(2 * (b + 4) * f / 1000);
  }

  reqHeldAt(req, amount) {
    const W = window.FoxyWallet;
    if (!req || !W) return '';
    const listed = this.reqMints(req);
    if (!listed.length) return '';
    const usd = req.unit === 'usd';
    if (req.unit && req.unit !== 'sat' && !usd) return '';
    const need = Math.round(Number(amount) || Number(usd ? req.amount : req.sats) || 0);
    if (!(need > 0)) return '';
    const have = (m) => {
      try {
        if (!usd) return W.balanceAt ? Math.round(Number(W.balanceAt(m)) || 0) : 0;
        return W.balanceOf ? Math.round(Number(W.balanceOf('usd', m)) || 0) : 0;
      } catch (e) { return 0; }
    };
    const unit = usd ? 'usd' : 'sat';
    const margin = (m) => (this.reqHeldMargin ? this.reqHeldMargin(m, need, unit) : 0);
    const free = (m) => { try { return !!(W.piecesFreeAt && W.piecesFreeAt(m, unit) === true); } catch (e) { return false; } };
    const here = W.mintHost ? this.reqCanon('https://' + W.mintHost()) : '';
    const held = listed.map((m) => ({ m: m, n: have(m) })).filter((x) => x.n >= need + margin(x.m));
    if (!held.length) return '';
    if (here && held.some((x) => x.m === here)) return here;
    /* A mint that charges nothing for its pieces before one that does or may, then the most held: the larger balance at a
     * mint that charges was given the ecash, and a free mint that covered it too was offered only as a melt, with a fee. */
    held.sort((a, b) => ((free(b.m) ? 1 : 0) - (free(a.m) ? 1 : 0)) || (b.n - a.n));
    return held[0].m;
  }

  /* A payer that cannot cover a payment over the link says so to the phone it
   * is touching.
   *
   * The offer screen holds its button at NOT ENOUGH for it (`requestSpec`), so
   * nothing the person presses would tell the other phone, which would sit on
   * its four digits until the link went. The word is the one a payment that
   * was not made already sends (`gaveUp`, `makeTokenForRequest`), carrying a
   * sentence with none of this phone's figures in it (`shortForReceiver`), so
   * the receiver shows a refusal as it shows one then and the
   * link's messages are the same ones, in the same order, only here: before
   * the question asked first (`askFirst`) that a payer who cannot pay never
   * asks. Asked of the wallet in the terms the screen asks it
   * (`sendShortfall`), once for each request. */
  tellPayerShort(req) {
    const W = window.FoxyWallet;
    const amount = (req ? (req.unit === 'usd' ? Math.max(0, Math.round(Number(req.amount) || 0)) : req.sats) : 0);
    if (!req || !req.viaTap || !(amount > 0) || !W || !W.sendShortfall || !W.tapQuote) return;
    if (!this.requestHere(req)) return;
    // paid at another mint it names, where this phone holds enough (`reqPayMint`): this mint's balance is not the question
    const paidAt = this.reqPayMint ? this.reqPayMint(req) : '';
    if (paidAt && !this.requestHere({ mints: [paidAt] })) return;
    let lack = null;
    try {
      const locked = !!(req.lockTo && !(this.offlineNow && this.offlineNow()));
      lack = req.unit === 'usd' ? W.sendShortfall(amount, { unit: 'usd', locked: locked })
        : W.sendShortfall(amount, { locked: locked });
    } catch (e) { lack = null; }
    if (!lack || !lack.short) return;
    const told = String(req.id || amount);
    if (this._shortTold === told) return;
    this._shortTold = told;
    console.log('[foxy] tap: this phone cannot cover the payment; telling the receiver before it promises anything');
    W.tapQuote(JSON.stringify({ gaveUp: this.shortForReceiver() })).catch(() => {});
  }

  /* What the phone being paid is told when this one cannot cover the payment:
   * that, and no figure. The wallet's own sentence says what the payment needs
   * and what this phone holds, which is for the person holding this phone and
   * for nobody across a counter from them. */
  shortForReceiver() { return 'The payer does not have enough to cover this payment.'; }

  /* A refusal's words as the other phone is given them: a balance that could
   * not cover the payment goes without its figures (`shortForReceiver`), and
   * anything else as the wallet said it. */
  saidToReceiver(why) {
    const said = String(why || '');
    return /balance isn\u2019t enough|balance isn't enough|not enough ecash/i.test(said) ? this.shortForReceiver() : said;
  }

  /* Does paying this request need a connection?
   *
   * What `makeTokenForRequest` does with a route that it cannot do without
   * one. A request that names somewhere to be paid (an onion address, a Nostr
   * inbox) is delivered there only over the route, and without it becomes a
   * token to show; one that asks for a lock has the lock made by a swap, and
   * without a route is paid unlocked; one for another mint connects to that
   * mint first, and without a route cannot be paid at all.
   *
   * Not one that came over the Bluetooth link in hand, which is paid over the
   * link, nor one that names none of these: a token to show them, from the
   * mint this phone is on, made from the pieces it holds. Those are not waited
   * on (`requestSpec`), because there is nothing for a connection to add. */
  requestNeedsRoute(req) {
    if (!req || req.viaTap) return false;
    const here = this.requestHere(req);
    return !!(req.delivery || req.lockTo || !here);
  }

  /* Will an over-payment's change come back by itself?
   *
   * Only from a phone with a route, because making change is a swap. It says
   * so in its tap offer (`theirRoute`), or shows it by naming somewhere to be
   * paid. A receiver on the ecash rail names nowhere and is online all the
   * same, which is why the transports alone were not the answer. */
  changeComesBack(req) {
    if (!req) return false;
    if (req.theirRoute === true) return true;
    if (req.theirRoute === false) return false;
    return !!(req.transports && req.transports.length);
  }

  /* RECEIVER NEEDS TO SCAN: the payment as a code, for the other phone's
   * camera, with SHARE for a receiver who is not in the room.
   *
   * DONE goes home. It used to leave the token screen underneath, so that it
   * could watch for the token being taken — but this screen is only shown
   * offline, where nothing can be watched, and what the person saw after
   * DONE was a token screen they had not asked for. When change is owed, DONE
   * opens the camera instead: the receiver's phone is showing the change code
   * by then, and the way to collect it is to scan it. */
  needScanStage(made) {
    if (!this.stageScreen || !made || !made.token) return;
    const W = window.FoxyWallet;
    const due = !!(made.changeAsked && Number(made.over) > 0);
    // in the token's own unit: a dollar token's figure is its cents, never a number of sats
    const mUnit = made.unit === 'usd' ? 'usd' : '';
    const mAmt = mUnit ? made.amount : made.sats;
    this.stageScreen('needScan', {
      title: 'Receiver<br>needs to scan', qr: made.token,
      /* What is being paid, not what it is being paid with; and where the
       * rest is coming back, how to collect it. */
      amount: this.stageMoney(Math.max(0, Number(mAmt) - (Number(made.over) || 0)), mUnit),
      body: (made.changeAsked && Number(made.over) > 0)
        ? 'Ask the receiver to scan this QR code. Their phone will then show a code for your <strong>'
          + this.stageMoney(made.over, mUnit) + '</strong> change: scan it to collect.'
        : 'Ask the receiver to scan this QR code to finalize the payment.',
      above: 'SHARE',
      aboveGo: () => {
        if (!W || !W.share || !W.share(made.token)) this.toast('Sharing is not available here.', true);
      },
      button: due ? 'SCAN FOR CHANGE' : 'DONE',
      go: () => {
        if (W && W.clearLastToken) W.clearLastToken();
        this.setState(p => ({
          screen: due ? 'sendScan' : 'home', stack: [], flow: due ? 'send' : p.flow,
          tokenOut: '', tokenCopied: false, tokenForPayee: false,
          scanWhy: due ? 'SCAN FOR YOUR ' + this.stageMoney(made.over, mUnit).toUpperCase() + ' CHANGE' : '',
        }));
        if (this.claimWatchTick) setTimeout(() => this.claimWatchTick(), 0);
      },
    });
  }

  /* Mint it at the mint the request names, switching there if needed. */
  /* `go.overpayOk` is the person's answer to the over-pay card, threaded rather
   * than stashed: this function's work is asynchronous, so a flag on `this`
   * would be cleared before the send reads it. */
  /* `go.req` is the request the first pass was for, carried through every
   * pass that comes back by itself (a move collected, a crossing, the over-pay
   * question). Each pass read `state.req` instead, which is whatever is on
   * screen by then: a second request opened while the first one's owed move
   * was being collected was paid with PAY never pressed, and the A DIFFERENT
   * MINT question was skipped for it. A pass whose request is no longer the
   * one on screen is dropped, and the phone comes home from any trip it made.
   * So is a pass queued behind the trip home whose offer was left before it
   * landed (`offerUp`), and its request with it. */
  makeTokenForRequest(go) {
    const W = window.FoxyWallet;
    const req = (go && go.req) || this.state.req;
    if (!req) return;
    if (go && go.req && (this.state.req !== go.req || (go.offerUp && this.state.screen !== 'reqOffer'))) {
      console.log('[foxy] request: the request on screen is not the one this pass was for; not paid');
      if (this._reqCollect === req) { this._reqCollect = null; this.setState({ reqCollecting: false }); }
      this._crossMovedTo = null;
      if (this.state.req === req) this.setState({ req: null });
      /* A tap's other phone is told the payment is not coming. It sat on its
       * four digits until its own clock ended. */
      if (req.viaTap && W && W.tapQuote) {
        W.tapQuote(JSON.stringify({ gaveUp: (this.state.req && this.state.req !== req) ? 'The payer opened another payment.' : 'The payer stopped this payment.' }))
          .catch(() => {});
      }
      if (this._crossCameFrom) this.crossComeHome();
      return;
    }
    // one request payment at a time, whatever the screens have since been told (`openRequest`)
    if (this.reqRunLive ? this.reqRunLive() : this._reqRun) {
      if (this.refuseForRun) this.refuseForRun(!!req.viaTap);
      else this.toast('A payment is still being delivered. Wait for it.', true);
      return;
    }
    if (this.state.reqBusy || this.state.reqSwapping) return;
    if (this.state.reqCollecting) {
      // PAY on a request other than the one whose move is being collected: said, not silent
      if (this._reqCollect && this._reqCollect !== req) this.toast('Foxy is collecting an earlier move. Wait for it.', true);
      return;
    }
    /* Not while the phone is on its way home (`_homeGoing`, `crossComeHome`).
     * The connect home lands whenever Tor brings it, and the wallet is
     * swapped the moment it does: a tap paid at the mint being visited, begun
     * while it was out, was made from home's pile for a request that names
     * the visited mint. Paid once the phone is home, from there, as any
     * request at another mint is. */
    if (this._homeGoing) {
      if (this._payAfterHome === req) return;
      this._payAfterHome = req;
      console.log('[foxy] request: the phone is on its way home; this payment follows once it is there');
      this.toast('Foxy is getting back to your mint. The payment follows.');
      /* Marked, so its connect to the request's mint is not remembered (`afterHome`): a token to show at the mint the
       * phone was visiting, queued here, went home and back and saved that mint as the phone's own. */
      /* And the offer it was asked from (`offerUp`): PAY under the trip and then BACK or the edge swipe left the offer
       * with `state.req` still set, and the payment went out seconds later from wherever the person had gone. As the
       * on-chain queues do, the pass is dropped when its screen is not up at landing (and a tap's phone told). */
      const offerUp = this.state.screen === 'reqOffer';
      const pass = Object.assign({}, go || {}, { req: req, afterHome: true, offerUp: offerUp });
      const after = () => {
        if (this._payAfterHome === req) this._payAfterHome = null;
        this.makeTokenForRequest(pass);
      };
      this._homeGoing.then(after, after);
      return;
    }
    // (the offer is asked about once, at landing: the passes after it come back from screens of their own)
    go = Object.assign({}, go || {}, { req: req, offerUp: false });
    /* The end of this payment, whichever way it ended: nothing moved for the
     * next payment to speak of, and home after a crossing or a visit.
     * `_crossMovedTo` was cleared on three endings of nine, so a later refusal
     * said its sats "are now at" a mint they never went to, and a later PAY
     * FROM choice of a crossing to that mint was skipped for a crossing from
     * somewhere else. */
    const crossDone = () => {
      this._crossMovedTo = null;
      if (this._crossCameFrom) this.crossComeHome();
    };
    /* The request's mint as the wallet writes a mint (`canonicalMint`): small
     * letters in the scheme and host, no default port, no slash at the end.
     * It lost only its slash before, so a request naming
     * https://MINT.minibits.cash/Bitcoin read as a stranger: A DIFFERENT MINT
     * about a mint the person uses, a balance there of 0 (the wallet files
     * it under its own spelling), a crossing with a Lightning fee though 1,500
     * sats were already there, and the question asked again after the sats
     * had moved. */
    const canon = (u) => {
      if (W && W.canonicalMint) return W.canonicalMint(u);
      const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(String(u || '').trim());
      if (!m) return String(u || '').trim().replace(/\/+$/, '');
      const scheme = m[1].toLowerCase();
      const port = scheme === 'https' ? ':443' : ':80';
      let host = m[2].toLowerCase();
      if (host.slice(-port.length) === port) host = host.slice(0, -port.length);
      // and no dot at the end of the name, which a resolver reads as the same host
      host = host.replace(/\.+(?=(:\d+)?$)/, '');
      return scheme + '://' + host + (m[3] || '').replace(/\/+$/, '');
    };
    // at any of the mints it names: the phone's own where it is one, else one holding enough, else the default (`reqPayMint`)
    const want = canon(this.reqPayMint(req));
    const here = !!(W.mintHost && canon('https://' + W.mintHost()) === want);
    // making it somewhere else switches mints, which waits for any payment
    if (want && !here && this.refuseSwitchWhileBusy()) return;
    /* Back from a step this function started itself (a crossing, a move
     * collected, the over-pay question): the mint was accepted on the first
     * pass, and is not asked about again. */
    const again = !!(go && (go.crossed || go.collected));

    /* A payment request names its own mint, and this used to connect to it on
     * one tap. Tokens from an attacker-chosen mint are worthless, and the
     * request only has to be scanned to get here.
     *
     * So a mint this device has never used gets named in full first, with
     * connecting as the deliberate action. One already on the list goes
     * through — it has been accepted before. */
    if (want && !here && !this._reqMintOk && !again) {
      /* On the list and chosen (09-melt-paste-switch.js `mintOnPhone`): a mint on the list from a visit only is asked
       * about here too, or a request with no delivery would save the phone on it with nothing asked. */
      const known = (W.mints ? W.mints() : []).some(m => canon(m.id || m) === want) && (!this.mintOnPhone || this.mintOnPhone(want));
      if (!known) {
        const host = want.replace(/^https?:\/\//, '');
        const mine = W.mintHost ? W.mintHost() : 'none';
        this.blockedCard('reqMint', {
          tone: 'warn',
          title: 'A DIFFERENT MINT',
          reason: 'This request wants ' + host + '. You are on ' + mine
            + '. Ecash from a mint you do not know may not be worth anything, '
            + 'and only that mint can redeem it.',
          retry: 'USE ' + host.toUpperCase().slice(0, 22),
          // a mint new to this phone, past the lock first (09-melt-paste-switch.js `mintGate`); the connect after asks nothing more
          go: () => {
            const use = () => { this._reqMintOk = want; this.makeTokenForRequest(go); };
            if (this.mintGate) this.mintGate(want, use, 'To use this mint.');
            else use();
          },
        });
        return;
      }
    }
    this._reqMintOk = null;
    /* Chosen on PAY FROM: the other balance at this mint (26l-pay-from.js `pfSwapSource`). The swap is made first, and this
     * pass comes back once it has landed (`go.swapped`), to pay from what it brought with nothing more asked. */
    const swapSrc = ((here || !want) && !(go && go.swapped) && this.pfReqSwap) ? this.pfReqSwap(req) : null;
    if (swapSrc) { this.pfSwapThenPay(req, swapSrc, go); return; }
    const need = Math.round(Number(req.sats) || 0);
    /* Chosen on PAY FROM (26l-pay-from.js): sats from another of this phone's mints than the one the request names, by
     * the crossing quoted there. The offer said what it costs, its FEE and PAYING FROM, so it is moved with no second
     * question, and the phone comes home after the payment (`crossMove`'s `home`) whichever way it goes. Not once a
     * move collected below has put enough there: that was this payment's crossing already. */
    const collectedEnough = !!(go && go.collected && W.balanceAt && W.balanceAt(want) >= need);
    const chosen = (want && !(go && go.crossed) && !collectedEnough && this.pfReqCrossing) ? this.pfReqCrossing(want) : null;
    /* Too little at the mint the request names, and enough at this phone's
     * own: the sats are moved there first, as a tap to somebody at another
     * mint moves them (26d-tap.js `tapCrossQuote`). A request scanned off a
     * donation page nearly always names a mint the person does not bank at,
     * and this used to switch there and refuse with "you hold 298" — the only
     * way to pay it was a transfer made by hand first. The screen is the
     * crossing's own confirmation: the amount, the fee, both mints, and PAY;
     * the payment follows from there with no second question
     * (`go.crossed`). Sats only: a move between mints is a Lightning payment,
     * and dollars do not cross one. Not with no route, where nothing moves. */
    /* `sats`, when what is short there is less than the whole: the fee that
     * mint charges on the pieces (`shortThere`). It moved the whole amount
     * again, a routing fee on 1,000 for 2 sats short and 1,000 more left at
     * their mint once home. What lands is added to what is held there, and
     * the payment is made from both. The screen still says what the receiver
     * gets and what the move costs. */
    /* The home this payment's own crossing wrote (`crossMove` writes one only where none was set), carried to the
     * pass that follows, so a token to show clears that and nothing another flow is holding. */
    const wrote = (had) => ((!had && this._crossCameFrom) ? { wroteHome: this._crossCameFrom } : {});
    const crossing = (mine, sats) => {
      const moving = (sats > 0 && sats < need) ? sats : need;
      console.log('[foxy] request: it is paid at ' + want + ', where this phone holds ' + W.balanceAt(want)
        + ' of the ' + need + ' sats with that mint\u2019s fee; offering to move ' + moving + ' from ' + mine);
      const quoting = W.transferQuote(mine, moving, { to: want, land: true });
      quoting.catch(() => {});
      const shown = moving === need ? quoting : quoting.then(p => Object.assign({}, p, { net: need }));
      shown.catch(() => {});
      this.crossMintCard(shown, want, mine).then(yes => {
        if (!yes) { console.log('[foxy] request: the move to ' + want + ' was not accepted'); return null; }
        const had = this._crossCameFrom;
        return quoting.then(plan => this.crossMove(plan, want, mine)).then(() => {
          console.log('[foxy] request: the sats are at ' + want + '; paying it now');
          this.setState({ crossBusy: false, crossQ: null });
          this.makeTokenForRequest(Object.assign({}, go || {}, { crossed: true }, wrote(had)));
        });
      }).catch(e => this.crossFailed(e, mine));
    };
    const canCross = !!(want && !here && req.unit !== 'usd' && !(go && go.crossed) && !(this.offlineNow && this.offlineNow())
        && W.balanceAt && W.transferQuote && this.crossMove);
    const mine = String(W.mintUrl || '').replace(/\/+$/, '');
    const crossNow = !!(canCross && need > 0 && mine && W.balanceAt(want) < need);
    /* A move to that mint that is paid and not yet collected is collected
     * first, as a tap does (26d-tap.js `tapCrossMint`, `move-twice`). PAY
     * pressed again under YOUR SATS ARE ON THEIR WAY quoted and made a second
     * move: a second routing fee and another lot off home, with the first
     * landing later. One still not collected after that is waited for, not
     * made again. Asked before either crossing: it stood after PAY FROM's,
     * which then made the second move from the mint chosen there. Only where
     * this payment would move sats, so a note that never settles does not
     * hold up a payment from what is already there. */
    const owed = () => (W.pendingMoves ? W.pendingMoves() : []).filter(n => canon(n && n.to) === want);
    if ((chosen || crossNow) && need > 0 && owed().length) {
      if (W.finishMove && !(go && go.collected)) {
        console.log('[foxy] request: a move to ' + want + ' is paid and not yet collected; collecting it first');
        /* Busy on the offer while it runs (COLLECTING…), so PAY is not live
         * under it: nothing on screen changed for up to 45 seconds, and PAY
         * still showed and could be pressed. */
        this._reqCollect = req;
        this.setState({ reqCollecting: true });
        W.finishMove().then(() => null, () => null).then(() => {
          if (this._reqCollect === req) { this._reqCollect = null; this.setState({ reqCollecting: false }); }
          this.makeTokenForRequest(Object.assign({}, go || {}, { collected: true }));
        });
        return;
      }
      const e = /** @type {any} */ (new Error('A move to that mint has not been collected yet.'));
      e.movePaid = true;
      e.moveTo = want;
      e.moveSats = owed().reduce((a, n) => a + (Math.round(Number(n.amount) || 0)), 0) || need;
      this.crossFailed(e, mine);
      return;
    }
    if (chosen && this.crossMove) {
      console.log('[foxy] request: paying it from ' + chosen.from + ', moving the sats to ' + want + ' first');
      /* Busy for the life of the move, as the crossing screen is (`crossBusy`): nothing said a crossing was out, so a
       * trip home owed was made in the middle of it (`homeWaitsFor`). */
      this.setState({ crossBusy: true });
      const had = this._crossCameFrom;
      this.crossMove(chosen.plan, want, chosen.from, mine).then(() => {
        this.setState({ crossBusy: false, crossQ: null });
        this.makeTokenForRequest(Object.assign({}, go || {}, { crossed: true }, wrote(had)));
      }).catch(e => this.crossFailed(e, mine));
      return;
    }
    if (crossNow) { crossing(mine); return; }
    /* A request that says where to deliver is paid there: onion, straight to
     * the requester's phone over Tor; nostr, an encrypted message through Tor
     * (07-request-delivery.js). The token is made either way, so a delivery
     * that fails leaves it on the token screen to show instead. */
    /* An open Bluetooth link is a way to deliver, and the best one there is.
     *
     * `delivery` comes from the transports the request names, and an offline
     * receiver names none — it cannot make an onion or reach a relay. So a
     * payment between two offline phones fell straight through to "show them a
     * token", and the person was handed a QR to scan while the two phones were
     * linked and the code was on both screens. The link
     * the offer arrived over is the answer, and `viaTap` is what says there is
     * one; `payRequest` has preferred it over the request's own transports
     * since the change leg was built. */
    /* Not over an onion or a relay from a phone with no route. A request read
     * off a screen names the receiver's address, and this phone cannot reach
     * it: the payment failed with "needs a connection" three times running,
     * when what it needed was to be shown as a code for the other phone to
     * scan. The tap is a link, not a route,
     * and still delivers. */
    const reachable = req.viaTap || (req.delivery && !(this.offlineNow && this.offlineNow()));
    // in the request's own unit: cents for dollars, sats for sats
    const usdReq = req.unit === 'usd';
    const amt = (req ? (req.unit === 'usd' ? Math.max(0, Math.round(Number(req.amount) || 0)) : req.sats) : 0);
    const direct = !!(reachable && amt > 0);
    /* A visit, when the payment goes straight to them: the mint the request
     * names is where this payment is made from, not where the person banks.
     * It was connected to and remembered, so a payment refused there left
     * home showing 298 sats at a mint the person had never chosen, with 2,591
     * of their own out of sight; `crossComeHome` brings the phone back once
     * the payment has gone through or failed, as it does after a tap, and
     * when it failed with a token made, too: the token's watch keeps the
     * token's own mint, so it runs from home. A token made to show, with no
     * visit, stays where it is made. */
    const visit = !!(want && !here && direct);
    this.setState({ reqBusy: true });
    /* This payment, alive until one of its endings below lets it go
     * (`endRun`). STOP WAITING leaves its screen and not the payment, so
     * `reqBusy` alone could not say whether one was still out (`openRequest`).
     * With what it is and where it goes, for the words a refusal says while
     * it is out (`refuseForRun`). */
    const site = (req.delivery && req.delivery.kind === 'https')
      ? String(req.delivery.target || '').replace(/^https?:\/\//i, '').split(/[/?#]/)[0] : '';
    const run = { id: String(req.id || ''), at: Date.now(), amount: amt, unit: usdReq ? 'usd' : 'sat', to: site };
    this._reqRun = run;
    const endRun = () => { if (this._reqRun === run) this._reqRun = null; };
    // let go as dead, or another payment's run in its place: nothing on screen is this one's any more
    const gone = () => !!(/** @type {any} */ (run).dead || (this._reqRun && this._reqRun !== run));

    /* Everything from here to the promise chain inside a try. The wallet's
     * connect refuses synchronously where it has no route and nothing on file
     * for the mint (working offline, or Tor reconnecting, at a mint never
     * used), and that throw left this function with the run token set: every
     * later request was refused "A payment is still being delivered", every
     * come-home waited for it, and `reqBusy` held every mint switch until the
     * app was restarted. Let go at once here, and said by the chain's own
     * ending below as any refusal is. */
    let ready = Promise.resolve(null);
    let overOk = false;
    // the home this pass wrote for its visit, if it wrote one (a token to show clears only that)
    let wroteHome = '';
    /* And the home a pass queued behind the trip home (`afterHome`) wrote, going out from home for a token to show
     * at the request's mint: kept by the token's ending, which brings the phone back (`homeAgain`). Nothing was
     * written, so the phone stayed at that mint for the rest of the session and the next receive was made there. */
    let afterHomeFrom = '';
    const homeAgain = () => { if (afterHomeFrom && this._crossCameFrom === afterHomeFrom) this.crossComeHome(); };
    try {
      /* A payment going out looks like a payment going out.
       *
       * Paying a request had the gold melting overlay, which is the wallet
       * turning ecash into something else — here nothing is being melted, the
       * money is simply leaving, and it should look the way a Lightning send
       * looks. Making a token to show somebody keeps the
       * overlay: that really is the wallet working, with no send to animate.
       *
       * The amount goes into state because the send screen reads it from there
       * (renderContext), and `recipientKind` is deliberately not 'invoice' —
       * that would send it looking for an amount inside a recipient there is
       * none of. */
      if (direct) {
        /* What the sending screen says came from where: this payment, in its
         * unit, and not the last Lightning payment's figures (`renderSent`). */
        this._lastPay = null;
        this._paying = (this.twoUnitsOn && this.twoUnitsOn())
          ? { unit: usdReq ? 'usd' : 'sat', amount: amt, fee: 0, asked: 0 } : null;
        this.setState(p => ({
          screen: 'sendDone', stack: p.stack.concat([p.screen]), sendPhase: 'in',
          flow: 'send', recipientKind: 'ecash',
          amount: usdReq ? (amt / 100).toFixed(2) : String(req.sats), unit: usdReq ? 'USD' : 'SATS',
          /* Who this one goes to, not who the last one went to: the address of
           * an earlier send was still in state, so a tap said it was sending to
           * it. A tap goes to the code on both screens. */
          recipient: (req.viaTap && p.tapCode) ? String(p.tapCode) : '',
        }));
      } else {
        this.showMelt('Making the token\u2026');
      }
      /* Never over a home already set: a pass that comes back here after a
       * crossing or a visit is still on that trip, and it used to write the
       * mint it was visiting as the one to come home to. */
      if (visit && !this._crossCameFrom) {
        wroteHome = String(W.mintUrl || '').replace(/\/+$/, '');
        this._crossCameFrom = wroteHome;
      }
      if (go && go.afterHome && want && !here && !visit && !this._crossCameFrom) {
        afterHomeFrom = String(W.mintUrl || '').replace(/\/+$/, '');
        this._crossCameFrom = afterHomeFrom;
      }
      ready = (want && !here) ? W.connect(want, null, null, (visit || (go && go.afterHome)) ? { remember: false } : undefined) : Promise.resolve(null);
      /* Agreed before it is asked, where the change comes straight back. The
       * question was being skipped already, but only after the send had refused
       * once for want of an answer — so the screen went to sending, back to the
       * offer and to sending again, and where the receiver had named no address
       * the card came up anyway, telling a payer whose change was on its way
       * back that the other phone would keep it. */
      overOk = !!(go && go.overpayOk) || (direct && this.changeComesBack(req));
    } catch (e0) {
      endRun();
      this.setState({ reqBusy: false });
      ready = Promise.reject(e0);
    }
    /* Enough there on its face, and short once that mint's fee for the
     * pieces is counted: the crossing, as a tap does (26d-tap.js
     * `tapPayFromThere`). The figures are known only once there. It used to
     * pay there and be refused "you hold 1,000" with no crossing offered. */
    const shortThere = () => {
      if (!visit || !canCross || !W.sendShortfall) return false;
      const sf = W.sendShortfall(need, { locked: !!(req.lockTo && !(this.offlineNow && this.offlineNow())) });
      return !!(sf && sf.short);
    };
    ready.then(() => {
      if (shortThere()) {
        const eShort = /** @type {any} */ (new Error('Not enough there once that mint\u2019s fee is counted.'));
        eShort.foxyShortThere = true;
        throw eShort;
      }
      return null;
    }).then(() => direct
      ? W.payRequest(req, null, { overpayOk: overOk })
      /* Locked to them when they asked for it and this phone can: a token shown
       * on a screen is one anybody's camera can take, and a receiver with no
       * route can only accept ecash locked to it. It went out plain, so the
       * lock a scanned request asked for was dropped without a word. */
      /* And with no route, made from what is on hand: an amount the pieces
       * cannot make exactly is covered and the difference is change, which is
       * the person's to agree to first. It used to fall through to a swap and
       * say "this needs a connection" about a payment that needed none. */
      : W.sendToken(amt, (req.lockTo && !(this.offlineNow && this.offlineNow()))
          ? { unit: req.unit || 'sat', lockTo: req.lockTo }
          : ((this.offlineNow && this.offlineNow())
            ? { unit: req.unit || 'sat', cover: true, overpayOk: !!(go && go.overpayOk) }
            : { unit: req.unit || 'sat' }))).then(r => {
      /* A run let go as dead (`reqRunLive`) that ends after all: the screen, `reqBusy`, `req` and the trip home are
       * another payment's by now. Its first answer, late, cleared the hold of the payment begun after it, with that
       * one still out. Only the books (`lateRunEnded`). */
      if (gone()) { endRun(); if (this.lateRunEnded) this.lateRunEnded(req, r, direct, null); return; }
      endRun();
      this.hideMelt();
      /* No fee on this path, and say so.
       *
       * `_lastFee` is written by the Lightning send and never cleared, so the
       * completion screen showed whatever the last routed payment had cost —
       * ₿3 on a mint-to-mint payment that cost nothing, while the transaction
       * record beside it correctly said ₿0. Ecash
       * to the same mint is free; a token handed over is free. */
      this._lastFee = 0;
      this._seenTx = this._seenTx || {};
      this._seenTx[r.hash] = true;
      const note = (this.state.note || '').trim();
      if (note) W.tag(r.hash, { note: note });
      if (direct) {
        this.requestDelivered(req, r);
        crossDone();
        return;
      }
      /* A token to show stays where it was made (see `visit`): the home this payment wrote is let go. Only that: a
       * trip home another flow is holding (a send from here, still out) was wiped, and the phone stayed at the mint
       * it was visiting for the rest of the session. */
      const ours = wroteHome || (go && go.wroteHome) || '';
      if (ours && this._crossCameFrom === ours) this._crossCameFrom = null;
      /* Nor anything moved for the next payment to speak of: a later refusal
       * said its sats "are now at" this mint, about sats that never moved. */
      this._crossMovedTo = null;
      if (usdReq) {
        // a dollar token: its cents on the token screen, never a number of sats
        const got = Math.round(Number(r.amount != null ? r.amount : amt) || 0);
        this.setState({
          reqBusy: false, req: null, tokenCopied: false,
          tokenOut: r.token, tokenOutSats: 0, tokenOutHash: r.hash, tokenOutUnit: 'usd', tokenOutAmount: got,
          tokenOutFee: 0, tokenForPayee: true, screen: 'tokenOut', stack: [],
        });
        this.needScanStage(Object.assign({}, r, { unit: 'usd', amount: got }));
        this.refreshBalance();
        homeAgain();
        return;
      }
      this.setState({
        reqBusy: false, req: null, tokenCopied: false,
        tokenOut: r.token, tokenOutSats: r.sats, tokenOutHash: r.hash, tokenOutUnit: '', tokenForPayee: true,
        screen: 'tokenOut', stack: [],
      });
      this.needScanStage(r);
      this.refreshBalance();
      this.watchToken(r.sats, r.hash, r.swapped === false);
      this.tidyChangeLater();
      homeAgain();
    }).catch(e => {
      if (gone()) { endRun(); if (this.lateRunEnded) this.lateRunEnded(req, null, direct, e); return; }
      endRun();
      this.hideMelt();
      // off the sending animation, whichever way this ends: it is not sending
      this.setState({ reqBusy: false, sendPhase: null });
      /* Where a crossing for this payment put the sats, read before any
       * ending below lets it go (`crossDone`): the refusal cards say so. */
      const movedTo = this._crossMovedTo;
      // stopped by the person before it was made: nothing to report, and they are home already
      if (e && e.foxyStopped) { crossDone(); return; }
      // short at their mint by its fee, found on the visit: home, and the crossing from there (`shortThere`)
      if (e && e.foxyShortThere) {
        const from = this._crossCameFrom;
        console.log('[foxy] request: what is held at ' + want + ' does not cover it with that mint\u2019s fee; offering the crossing instead');
        this.setState(p0 => ({ screen: p0.screen === 'sendDone' ? 'reqOffer' : p0.screen }));
        // only what is short, padded by that mint's fee for spending it (`crossing`)
        const sf = (() => { try { return W.sendShortfall(need, { locked: !!(req.lockTo && !(this.offlineNow && this.offlineNow())) }); } catch (x) { return null; } })();
        const held = W.balanceAt ? W.balanceAt(want) : 0;
        const lack = (sf && sf.need != null && sf.have != null)
          ? Math.round(Number(sf.need) - Number(sf.have))
          : Math.round(need + (Number(sf && sf.fee) || 0) - held);
        crossDone();
        if (from) crossing(from, lack > 0 ? lack : need);
        return;
      }
      /* Offline, in a unit this phone holds none (or too little) of here: it
       * needs the mint, and nothing was made (`unitHeldRefusal`). Said on a
       * card, and to the phone being paid in words with no figures. */
      if (e && e.foxyNeedsMint) {
        this.setState(p0 => ({ req: null, sendPhase: null, screen: p0.screen === 'sendDone' ? 'home' : p0.screen, stack: [] }));
        if (req && req.viaTap && W.tapQuote) {
          const word = usdReq ? 'dollars' : 'bitcoin';
          const said = /you hold no/i.test(W.reason(e))
            ? 'The payer holds no ' + word + ' here, and paying from ' + (usdReq ? 'bitcoin' : 'dollars') + ' needs the mint.'
            : this.shortForReceiver();
          W.tapQuote(JSON.stringify({ gaveUp: said })).catch(() => {});
        }
        console.warn('[foxy] the payment was not made: it needs the mint:', W.reason(e));
        crossDone();
        if (this.needsMintCard) this.needsMintCard(W.reason(e));
        return;
      }
      /* No exact change: ask, and go again with the answer. Nothing has been
       * made at this point — `sendToken` refuses before it touches a proof —
       * so a cancel leaves the pile exactly as it was. */
      if (e && e.foxyNeedsOverpay) {
        // off the sending screen while the question is up, back where they were
        this.setState(p0 => ({ reqBusy: false, sendPhase: null,
          screen: p0.screen === 'sendDone' ? 'reqOffer' : p0.screen }));
        /* Only where the extra is a gift.
         *
         * An offline receiver names no transports, so it cannot give change and
         * the difference is money the person is giving away — that is worth
         * stopping for. Where the receiver has a route the difference comes
         * straight back over the same link within seconds, and a card about it
         * is a question with one sensible answer asked in the middle of paying
         * somebody. Handled, not asked about. */
        const comesBack = this.changeComesBack(req);
        if (comesBack) {
          console.log('[foxy] no exact pieces, and the change comes straight back;'
            + ' paying ' + e.foxyNeedsOverpay.pay + ' for ' + e.foxyNeedsOverpay.asked);
          this.makeTokenForRequest(Object.assign({}, go || {}, { overpayOk: true }));
          return;
        }
        this.overpayCard(Object.assign({ unit: usdReq ? 'usd' : '' }, e.foxyNeedsOverpay,
                                       { changeComesBack: false })).then((yes) => {
          if (!yes) {
            this.setState({ req: null, sendPhase: null, screen: 'home', stack: [] });
            crossDone();
            return;
          }
          /* With `crossed` carried: a payment whose sats were moved here to make
           * it is not moved again. The second pass ran PAY FROM's crossing a
           * second time, and the far side's "already paid" was all that stopped
           * a second melt. */
          this.makeTokenForRequest(Object.assign({}, go || {}, { overpayOk: true }));
        });
        return;
      }
      /* They heard it and said no. Three endings, and the phone says which
       * (20-helpers.js `payRequest`, 07-request-delivery.js `afterRefusal`):
       * the ecash came back locked to this phone; it did not, and is in the
       * wallet again at risk; or the question asked first was answered no
       * and nothing was ever sent. */
      if (e && (e.foxyRefunded || (e.foxyAtRisk && !e.foxyAtRisk.onEntry) || (e.foxyAskedNo && !e.foxySilent))) {
        this.setState(p0 => ({ req: null, sendPhase: null, screen: p0.screen === 'sendDone' ? 'home' : p0.screen, stack: [] }));
        crossDone();
        this.refreshBalance();
        this.loadHistory();
        if (e.foxyAskedNo) {
          console.warn('[foxy] the payment was not made: they said no before anything was sent:', W.reason(e));
          /* Asked again after a crossing had moved the sats (a tap asks before
           * the move and `payRequest` asks once more): nothing was sent to
           * them, and the sats are at their mint now, not where they were. */
          const there = movedTo ? (this.mintNameOf(movedTo) || String(movedTo).replace(/^https?:\/\//, '')) : '';
          this.blockedCard('theyRefused', {
            tone: 'warn',
            title: 'THEY CANNOT TAKE IT',
            reason: W.reason(e),
            chip: there ? 'Nothing was sent. Your sats are at ' + there + ' now.'
              : usdReq ? 'Nothing was sent. Your dollars are where they were.' : 'Nothing was sent. Your sats are where they were.',
          });
          return;
        }
        if (e.foxyRefunded) {
          const back = e.foxyRefunded;
          /* In the payment's unit: dollars come back as dollars. The sat
           * sentences are as they always were. */
          if (back.unit === 'usd') {
            const m = (n) => this.moneyIn(n, 'usd');
            const got = Math.round(Number(back.amount) || 0);
            const paid = Math.round(Number(back.paidAmount != null ? back.paidAmount : back.paid) || 0);
            // a short refund: the pieces they did not spend came back as well (`afterRefusal`)
            const also = Math.max(0, Math.round(Number(back.recovered) || 0));
            this.blockedCard('theyRefused', back.short ? {
              tone: 'warn', title: 'THEY DID NOT TAKE IT',
              reason: W.reason(e) + ' They sent back ' + m(got) + ' of the ' + m(paid) + '.'
                + (also ? ' Foxy took back ' + m(also) + ' they had not spent.' : ''),
              chip: m(Math.max(0, paid - got - also)) + ' was not returned.',
            } : {
              tone: 'warn', title: 'THEY DID NOT TAKE IT', reason: W.reason(e),
              chip: 'Your ' + m(got) + ' came back, locked to this phone. Nothing is at risk.',
            });
            return;
          }
          const alsoSats = Math.max(0, Math.round(Number(back.recovered) || 0));
          this.blockedCard('theyRefused', back.short ? {
            tone: 'warn',
            title: 'THEY DID NOT TAKE IT',
            reason: W.reason(e) + ' They sent back ' + this.group(back.sats) + ' of the ' + this.group(back.paid) + ' sats.'
              + (alsoSats ? ' Foxy took back ' + this.group(alsoSats) + ' sats they had not spent.' : ''),
            chip: this.group(Math.max(0, back.paid - back.sats - alsoSats)) + ' sats were not returned.',
          } : {
            tone: 'warn',
            title: 'THEY DID NOT TAKE IT',
            reason: W.reason(e),
            chip: 'Your ' + this.group(back.sats) + ' sats came back, locked to this phone. Nothing is at risk.',
          });
          return;
        }
        // what was at risk, in its own unit ("$ 2.00" or "2,000 sats")
        const risk = e.foxyAtRisk || {};
        const riskSaid = risk.unit === 'usd' ? this.moneyIn(risk.amount, 'usd') : this.group(risk.sats) + ' sats';
        /* With a route the wallet has already dealt with it (`afterRefusal`):
         * the pieces are swapped, or the phone that said no had redeemed
         * them first. Neither is a risk still standing. */
        /* A website that answered anything but a 2xx (07-request-delivery.js
         * `deliverOverHttps`): its server has seen the pieces, so they are
         * taken back as a refusal's are, and the card says it was the site. */
        const site = !!e.foxyWebsite;
        if (e.foxyAtRisk.safe) {
          this.blockedCard('theyRefused', {
            tone: 'warn',
            title: 'THEY DID NOT TAKE IT',
            reason: site
              ? 'Their website did not take this payment. Foxy has swapped your ecash for new pieces, so the copy it saw is worth nothing.'
              : 'They refused this payment and sent nothing back. Foxy has swapped your ecash for new pieces, so the copy they saw is worth nothing.',
            chip: 'Your ' + riskSaid + (risk.unit === 'usd' ? ' is' : ' are') + ' in your wallet. Nothing is at risk. They said: ' + W.reason(e),
          });
          return;
        }
        if (e.foxyAtRisk.taken) {
          this.blockedCard('theyRefused', {
            tone: 'warn',
            title: 'THEY TOOK THE PAYMENT',
            reason: (site ? 'Their website said no, and' : 'They said no, and') + ' your ecash has been redeemed all the same: ' + riskSaid + '. Its entry in your history says paid.',
            chip: 'Do not pay again. If they are sending it back, they will show you a code to scan. They said: ' + W.reason(e),
          });
          return;
        }
        this.blockedCard('theyRefused', {
          tone: 'warn',
          title: 'HIGH RISK',
          reason: (site ? 'Their website did not take this payment, and it has seen your ecash and can still redeem it. '
            : 'They refused this payment and did not send it back locked to you. They have seen your ecash and can still redeem it. ')
            + 'Do not pay again until the red ring is gone.',
          /* Swapped at that mint, from wherever the phone is (`settleAtRisk`
           * settles every mint's). It said "until Foxy has a connection"
           * while connected, about pieces nothing was going to settle. */
          chip: riskSaid + (risk.unit === 'usd' ? ' is' : ' are') + ' in your wallet again, at risk until Foxy has swapped '
            + (risk.unit === 'usd' ? 'it' : 'them') + ' for new pieces. Foxy will keep trying. They said: ' + W.reason(e),
        });
        return;
      }
      const made = e && e.foxyToken;
      if (!made) {
        /* Said in the diary as well as on screen. A toast is two seconds and
         * then gone, so a payment that died between two phones standing
         * together left a log that read as if nothing had been attempted at all
         * — the screens went to sendDone and back to home in nineteen
         * milliseconds and nothing anywhere said why. */
        console.warn('[foxy] the payment was not made:', W.reason(e));
        // after a crossing, back to the mint this phone banks at
        crossDone();
        /* Told to the other phone while the link is still there, so it does
         * not sit waiting for a payment that is not coming. It rides M10,
         * as the other things a payer says before the money do. */
        if (req && req.viaTap && W.tapQuote) {
          W.tapQuote(JSON.stringify({ gaveUp: this.saidToReceiver(W.reason(e)) || 'The payment was not made.' })).catch(() => {});
        }
        this.setState(p => ({ screen: p.screen === 'sendDone' ? 'home' : p.screen, stack: [] }));
        this.toast(W.reason(e), true);
        return;
      }
      /* They heard it and said no, in words. That is not a delivery that failed,
       * and it must not be answered with a QR: the token screen says nothing
       * about why and asks the person to solve it with a camera. The token is
       * still theirs to hand over if they want to, and the card offers that. */
      if (e && e.foxyRefused) {
        /* Refused, so it is not on its way either — and the money is back in
         * this phone's hands as a token. The row is a real one now. */
        try { if (W.tag) W.tag(made.hash, { inflight: false }); } catch (x) {}
        this._seenTx = this._seenTx || {};
        this._seenTx[made.hash] = true;
        this.setState({ req: null, sendPhase: null });
        /* Its own kind: a refusal is not a lost connection, and the card
         * queue drops a waiting card that shares a kind with a new one. */
        /* And where the money is, when Foxy moved it to pay them.
         *
         * A cross-mint tap melts the sats to their mint before paying. If the
         * payment then fails the money is fine and it is theirs, but it is at a
         * mint they were not on when they tapped — which reads as money going
         * missing unless somebody says so (26d-tap.js, `tapCrossMint`). */
        // the token's own figure: dollars as dollars, sats as sats
        const madeUsd = made.unit === 'usd' || usdReq;
        const madeSaid = madeUsd ? 'dollars (' + this.moneyIn(made.amount != null ? made.amount : amt, 'usd') + ')'
          : this.group(made.sats) + ' sats';
        /* And home, whichever way it ended. It stayed at their mint "on
         * purpose" after a failure, showing a balance the person had never
         * seen at a mint they had not chosen; the card below says where the
         * sats are, and the mint list shows them. */
        crossDone();
        this.blockedCard('theyRefused', {
          tone: 'warn',
          title: 'THEY DID NOT TAKE IT',
          reason: W.reason(e),
          /* True of plain ecash, and not of ecash locked to them: nothing
           * this phone holds opens that, so "still yours" promised a way
           * back that does not exist. It is theirs to take, and the token
           * is how they take it. */
          chip: made.lockedTo
            ? 'HIGH RISK: these ' + madeSaid + ' are locked to them, so only they can take them and you cannot take them back. Show them the token to finish.'
            : (e.foxyAtRisk && e.foxyAtRisk.onEntry)
            ? 'HIGH RISK: they have seen these ' + madeSaid + ' and can still redeem them. Foxy takes them back when it has a connection.'
            : 'Your ' + madeSaid + ' are still yours'
              + (movedTo ? ', and they are now at ' + (this.mintNameOf(movedTo)
                  || String(movedTo).replace(/^https?:\/\//, '')) + '.' : '.'),
          retry: 'SHOW THEM A TOKEN',
          go: () => this.setState(madeUsd ? {
            tokenCopied: false, tokenOut: made.token, tokenOutSats: 0, tokenOutUnit: 'usd',
            tokenOutAmount: Math.round(Number(made.amount != null ? made.amount : amt) || 0), tokenOutFee: 0,
            tokenOutHash: made.hash, tokenForPayee: true, screen: 'tokenOut', stack: [],
          } : {
            tokenCopied: false, tokenOut: made.token, tokenOutSats: made.sats,
            tokenOutHash: made.hash, tokenForPayee: true, screen: 'tokenOut', stack: [],
          }),
          shut: { label: 'CLOSE', tap: () => this.setState({ screen: 'home', stack: [] }) },
        });
        return;
      }
      // made but not delivered: the token screen, to show them instead
      try { if (W.tag) W.tag(made.hash, { inflight: false }); } catch (x) {}
      /* And home, from a visit made to pay them. It stayed at their mint with
       * the person's own money out of sight, and the home it should have
       * gone back to was left set for whatever came next to act on. The
       * token's watch keeps the token's own mint, so it runs from home. */
      crossDone();
      /* A website that did not answer in time may have the payment: said so,
       * and the token's claim watch says which (`foxyMaybeSent`). */
      /* Nobody can show a website a token: after a post that failed, the token is kept and watched (below). */
      const toSite = !!(req && !req.viaTap && req.delivery && req.delivery.kind === 'https');
      const undelivered = (e && e.foxyMaybeSent) ? W.reason(e)
        : 'It did not reach ' + (toSite ? 'their website' : 'them') + ' (' + W.reason(e) + '). '
          + (toSite ? 'The token is kept; Foxy watches it.' : 'Show them this token instead.');
      this._seenTx = this._seenTx || {};
      this._seenTx[made.hash] = true;
      if (made.unit === 'usd' || usdReq) {
        const got = Math.round(Number(made.amount != null ? made.amount : amt) || 0);
        this.setState({
          req: null, tokenCopied: false, tokenOut: made.token, tokenOutSats: 0, tokenOutUnit: 'usd',
          tokenOutAmount: got, tokenOutFee: 0, tokenOutHash: made.hash, tokenForPayee: true,
          screen: 'tokenOut', stack: [],
        });
        this.needScanStage(Object.assign({}, made, { unit: 'usd', amount: got }));
        this.refreshBalance();
        /* Watched, as a sat token is below: "Foxy is checking" was said of a
         * dollar token posted to a website that did not answer, and nothing
         * checked (the claim watch reads a token in its own unit). */
        this.watchToken(0, made.hash, made.swapped === false);
        this.toast(undelivered, true);
        return;
      }
      this.setState({
        req: null, tokenCopied: false,
        tokenOut: made.token, tokenOutSats: made.sats, tokenOutHash: made.hash, tokenForPayee: true,
        screen: 'tokenOut', stack: [],
      });
      /* And over it, what to do about it. The token screen is for a token
       * somebody chose to make; this one was meant to cross by itself and did
       * not, and the person needs telling that the payment is not finished
       * until the other phone scans. DONE leaves
       * the token screen underneath, which watches for it being taken. */
      this.needScanStage(made);
      this.refreshBalance();
      this.watchToken(made.sats, made.hash, made.swapped === false);
      this.tidyChangeLater();
      this.toast(undelivered, true);
    });
  }

  /* A request paid straight to whoever asked.
   *
   * Forgetting the payer's copy turns on whether the receiver said in so many
   * words that it had written the payment down (`r.confirmed`, payRequest) —
   * not on which transport the request happened to name. It used to ask
   * `req.delivery.kind === 'onion'`, and every Foxy request names an onion even
   * when the money went over a Bluetooth tap. Tap's M6 said "ok" before the
   * receiving page had looked at the payment, so a receiver that refused a
   * moment later — its page reloaded, the mint no longer matching, a duplicate
   * — left this phone with the token text already deleted, the audit record's
   * inputs blanked and the last-token record dropped: a payment nobody had
   * taken and nobody could re-show.
   *
   * Unconfirmed is the Nostr case and is no worse than it ever was: a relay
   * took the message, or a tap came back 409 or unanswered. The token is
   * watched as any token is and history turns green when the mint reports the
   * proofs spent — and that watch is what forgets it, later and on evidence. */
  /* Back to the mint the person actually banks at, after a crossing.
   *
   * Paying somebody at another mint leaves this phone there, because that is
   * where the payment is made from. The person did not choose that mint and
   * does not keep their money at it: they tapped from one mint, paid somebody
   * at another, and came home to a tiny balance at the other with their own
   * nowhere in sight.
   *
   * Only after the payment has gone through, and only to the mint this phone
   * was on when the tap started. A failure leaves it where it is on purpose —
   * the change from the crossing is at the far mint and the refusal card says
   * so, and moving the person away from it would hide the thing they were just
   * told about.
   */
  /* Not while a request payment is still out (`_reqRun`): it is being made
   * from the mint the phone is on, and that payment's own ending comes home.
   * The first of two payments run side by side took the phone home from
   * under the second's visit mid-delivery. `_crossCameFrom` is kept for it.
   *
   * And a connect home that fails is tried once more two seconds on, then
   * said, and kept for the next route (`comeHomeOwed`). It was dropped: the
   * phone stayed at their mint for the rest of the session, and the next
   * receive was made there. */
  /* And not under anything else being made from the mint the phone is on: a
   * payout on chain quoted there (its confirmation, or the payout being handed
   * over), a send, a crossing, or a tap being paid (`homeWaitsFor`). A request
   * payment ending under an on-chain confirmation took the phone home from the
   * mint it was quoted at, and SEND then melted that mint's quote at home and
   * was refused. Each of those comes home itself when it ends, and anything
   * left waiting is taken home on the next update once nothing holds it
   * (`syncHome`). */
  /* And the trip home is a hold of its own while its connect is out
   * (`_homeGoing`, which resolves when it lands or fails). It held nothing:
   * the connect lands whenever Tor brings it and swaps the wallet the moment
   * it does, so a tap paid at the mint being visited, begun in those seconds,
   * was made from home's pile. Mint switches (`moneyBusy`), request payments
   * (`makeTokenForRequest`), a tap offer heard (26d-tap.js) and the receive
   * screens (12-receive.js) wait for it or refuse. A second trip is never
   * begun under one still out. */
  /* And the home it goes to stays written (`_crossCameFrom`) until the
   * connect lands. It was cleared before the connect, so for the whole trip
   * the slot was empty while the phone was still at the mint being visited,
   * and a flow begun then that writes home only where none is set (PAY FROM
   * on chain) wrote that mint as home, and its ending took the phone there
   * and saved it as the phone's own. Cleared on landing; a failure keeps it
   * for the second try, and the second failure hands it to `_homeOwed`. */
  crossComeHome() {
    const W = window.FoxyWallet;
    const back = this._crossCameFrom;
    if (!back || !W) { this._crossCameFrom = null; this._homeWaiting = false; this._homeOwed = null; return; }
    if (this._homeGoing) {
      console.log('[foxy] home waits: a trip home is already on its way');
      this._homeWaiting = true;
      return;
    }
    const waits = this.homeWaitsFor ? this.homeWaitsFor() : (this._reqRun ? 'a request payment is still out' : '');
    if (waits) {
      console.log('[foxy] home waits: ' + waits + '; the phone comes home when it ends');
      this._homeWaiting = true;
      return;
    }
    this._homeWaiting = false;
    if (String(W.mintUrl || '').replace(/\/+$/, '') === back) { this._crossCameFrom = null; this._homeOwed = null; return; }
    console.log('[foxy] back to ' + back + ', the mint this phone was on before the crossing');
    /* A connect that throws (no route and nothing on file for home) is a
     * connect that failed, said by the same ending, and not a throw out of
     * whatever called this (`syncHome` runs on every update). */
    const go = (again) => {
      let trip = null;
      const landed = () => { if (this._homeGoing === trip) this._homeGoing = null; };
      let connecting;
      // saved there again only where the person chose it (09-melt-paste-switch.js `connectBack`)
      try { connecting = this.connectBack ? this.connectBack(back) : W.connect(back); } catch (e0) { connecting = Promise.reject(e0); }
      trip = connecting.then(() => {
        landed();
        if (this._crossCameFrom === back) this._crossCameFrom = null;
        this._homeOwed = null;
        this.refreshBalance();
        this.loadHistory();
        // and what home does on chain: the limits on file were the visited mint's (26b-onchain.js `onchainAsk`)
        if (this.onchainAsk) this.onchainAsk();
      }, (e) => {
        landed();
        console.warn('[foxy] could not get back to ' + back + (again ? ' a second time' : '') + ':', W.reason ? W.reason(e) : (e && e.message));
        if (!again) {
          // kept for the second try, and for anything that comes home meanwhile
          if (!this._crossCameFrom) this._crossCameFrom = back;
          setTimeout(() => {
            if (this._crossCameFrom !== back || window.FoxyWallet !== W) return;
            /* Nor under a trip already out: anything that came home itself in the two seconds (a crossing's ending,
             * a payout's visit, a tap's) began one, and a second connect under it overwrote `_homeGoing`, so the
             * first trip's landing never let its own hold go. That trip ends in its own retry. */
            if (this._homeGoing) { this._homeWaiting = true; return; }
            // and not under whatever has begun meanwhile: it comes home itself when it ends
            if (this.homeWaitsFor ? this.homeWaitsFor() : this._reqRun) { this._homeWaiting = true; return; }
            if (String(W.mintUrl || '').replace(/\/+$/, '') === back) { this._crossCameFrom = null; return; }
            go(true);
          }, 2000);
          return;
        }
        if (this._crossCameFrom === back) this._crossCameFrom = null;
        this._homeOwed = back;
        const here = String(W.mintUrl || '').replace(/\/+$/, '');
        this.blockedCard('homeLost', {
          tone: 'warn',
          title: 'NOT BACK HOME YET',
          reason: 'Foxy could not get back to ' + (this.mintNameOf(back) || back.replace(/^https?:\/\//, ''))
            + '. You are on ' + (this.mintNameOf(here) || here.replace(/^https?:\/\//, '') || 'their mint')
            + ' until the next connection.',
        });
      });
      this._homeGoing = trip;
    };
    go(false);
  }

  /* The trip home owed by a come-home that could not connect (`crossComeHome`),
   * made on the next route. Not under a request payment, which comes home
   * itself when it ends, nor under anything else `crossComeHome` waits for.
   * It runs on every privacy push with Tor up, and after NOT BACK HOME YET the
   * person goes on working at the mint the phone is on: an on-chain
   * confirmation quoted there was moved home under it, and its SEND melted
   * that mint's quote at home and was refused. Kept for the next push. */
  comeHomeOwed() {
    const back = this._homeOwed;
    if (!back || this._crossCameFrom || this._homeGoing) return;
    const waits = this.homeWaitsFor ? this.homeWaitsFor() : (this._reqRun ? 'a request payment is still out' : '');
    if (waits) { console.log('[foxy] the trip home waits: ' + waits); return; }
    this._homeOwed = null;
    this._crossCameFrom = back;
    this.crossComeHome();
  }

  /* What the trip home waits for, in words for the diary, or '' for nothing.
   * Each of these is being made from the mint the phone is on now, and a
   * connect home under it points the rest of it at the wrong mint. */
  /* A trip home already under way is not in this list: `crossComeHome` and
   * `comeHomeOwed` ask `_homeGoing` themselves, and this is what that trip
   * waits for, which is never itself. */
  homeWaitsFor() {
    const s = this.state || {};
    const W = window.FoxyWallet;
    if (this.reqRunLive ? this.reqRunLive() : this._reqRun) return 'a request payment is still out';
    if (this._ocVisit) return 'a payout on chain from this mint is on screen';
    if (s.ocBusy) return 'a payout on chain is being handed over';
    // quoted here and not yet sent (its plan is let go when it is sent or left)
    if (s.screen === 'ocConfirm' && s.ocPlan) return 'an on-chain confirmation quoted at this mint is on screen';
    // and while its quote is being asked: the plan that comes back names this mint
    if (s.screen === 'ocConfirm' && s.ocQuoting) return 'an on-chain payout is being quoted at this mint';
    if (this._sendRun) return 'a send is running';
    /* A crossing in hand by any route: the crossing screen's, PAY FROM's (`crossBusy` in `makeTokenForRequest`), and
     * every move for the life of it (`_crossRun`, 26d-tap.js `crossMove`). PAY FROM's ran with neither, and a trip
     * home owed was made in the middle of its move. */
    if (s.crossBusy || this._crossRun) return 'a crossing is moving sats';
    if (s.screen === 'crossConfirm') return 'a crossing is being agreed';
    if (s.req && s.req.viaTap && s.screen === 'reqOffer') return 'a tap payment is on screen';
    /* A tap still live, on any screen: a decision put to the person with the other phone on the link (`_tapTalking`,
     * held from the price agreed until the payment arrives, 26d-tap.js `priceTermsCard`, with the screen already back
     * on home), or this phone's four digits shown to a payer (`tapShownCode`). It was asked in `syncHome` only, so a
     * route change (`comeHomeOwed`) or the trip's own second try took a receiver home with the agreed request naming
     * the mint it was on, and the payment was refused there. */
    if (this._tapTalking) return 'a tap is being talked over';
    if (s.tapShownCode) return 'a tap code is shown to a payer';
    /* An invoice of this mint being watched (`_watching`): the watch asks only at the mint that made it, so a trip home
     * under it left the payer paying a quote nobody was asking about. */
    if (this._watching) return 'an invoice is being watched';
    /* And one still being asked for on a receive screen (`_invMaking`, 12-receive.js `openReceive`), from the request
     * to the mint's answer: `_watching` is set only once it has answered, and over Tor that is longer than the trip's
     * two-second retry, so the invoice landed on a screen at home naming the mint visited. Three minutes at most, past
     * any answer (three tries and their waits). */
    if (this._invMaking && s.flow === 'receive' && s.screen !== 'home' && Date.now() - (Number(this._invMaking.at) || 0) < 180000) {
      return 'an invoice is being made at this mint';
    }
    /* A request at the mint the phone is on, up to be paid (its offer, or its sending screen): it is paid from here,
     * and a connect home under it made the payment from home's pile. */
    const canon = (u) => (W && W.canonicalMint ? W.canonicalMint(u) : String(u || '').replace(/\/+$/, ''));
    const here = W && W.mintUrl ? canon(W.mintUrl) : '';
    const reqAt = s.req && s.req.mints && s.req.mints.length ? s.req.mints.map(canon) : [];
    if (here && reqAt.indexOf(here) >= 0 && (s.screen === 'reqOffer' || s.screen === 'sendDone')) return 'a request at this mint is on screen to be paid';
    /* And a request of this phone's own, on show on a receive screen at the mint the phone is on: what is paid to it
     * is ecash of this mint, and the phone refuses a payment at a mint it is no longer on. Kept by the screen
     * (`railRequest`, `tapOnlyRequest`) and cleared when it goes. */
    /* On home too while a tap is live: an agreed request stays to be paid after the screen has gone back. */
    const tapLive = !!(this._tapTalking || s.tapShownCode);
    if (here && this._creqs && ((s.flow === 'receive' && s.screen !== 'home') || tapLive)) {
      const mu = String(W.mintUrl);
      const shown = Object.keys(this._creqs).some(k => (k.indexOf(mu + '|') === 0 || k.indexOf('tap|' + mu + '|') === 0)
        && this._creqs[k] && this._creqs[k].text);
      if (shown) return 'a request of this phone at this mint is on show';
    }
    /* And an on-chain address of this mint on a receive screen (`_ocAddr`, 26b-onchain.js `ocReceiveAddress`): no
     * request is made on that rail, so `_creqs` held nothing, and the address was remade at home under the payer. */
    if (here && s.flow === 'receive' && s.screen === 'confirm' && s.recvRail === 'ON-CHAIN'
        && this._ocAddr && canon(this._ocAddr.mint) === here) return 'an on-chain address of this mint is on show';
    /* And one being made for that screen (`_ocMaking`): it lands naming this mint, and a trip home under it remade it
     * at home, so the QR changed under the payer. */
    if (s.flow === 'receive' && s.screen === 'confirm' && s.recvRail === 'ON-CHAIN' && this._ocMaking) {
      return 'an on-chain address is being made here';
    }
    return '';
  }

  /* A come-home that waited (`crossComeHome`), made once nothing holds it.
   * Called on every update: most of what it waits for ends with a screen
   * change, and a payout's confirmation left with BACK, or a tap's offer
   * closed, ends with nothing else to call it. */
  /* Nothing while a tap is live: a decision put to the person with the other
   * phone on the link (`_tapTalking`), or this phone's four digits shown to a
   * payer (`tapShownCode`). A connect home under either points the payment at
   * the wrong mint, as payer or as receiver (tests/tap-held.js). Asked in
   * `homeWaitsFor`, so every trip home asks it. */
  syncHome() {
    if (!this._homeWaiting) return;
    if (!this._crossCameFrom) { this._homeWaiting = false; return; }
    if (this.homeWaitsFor()) return;
    this._homeWaiting = false;
    this.crossComeHome();
  }

  /* Whether a request payment is still out (`_reqRun`, makeTokenForRequest).
   *
   * One older than ten minutes is dead, whatever kept it, and is let go with
   * the hold it put on mint switches (`reqBusy`). Every way a run could be
   * left set without an ending is closed (the try around its start), so this
   * is a backstop only, and it has to be longer than the longest a payment
   * can take: a connect (30 s), a swap asked twice after a 429 (65 s each),
   * the post (65 s), a refusal's wait and swap-back, and over a tap the lock
   * keys and the link. It was 150 seconds, and the same website request
   * scanned again was paid a second time while the first post was still out.
   * A run let go here is marked dead, and its late ending touches nothing on
   * screen (`lateRunEnded`). */
  reqRunLive() {
    const run = /** @type {any} */ (this._reqRun);
    if (!run) return false;
    const age = Date.now() - (Number(run.at) || 0);
    if (age < 600000) return true;
    console.warn('[foxy] request: the payment begun ' + Math.round(age / 1000) + 's ago never ended; letting it go');
    run.dead = true;
    this._reqRun = null;
    if (this.state && this.state.reqBusy) this.setState({ reqBusy: false });
    return false;
  }

  /* Refused for a request payment still out, in words that say which one and
   * how long. A tap's other phone is told too, so it does not sit on its four
   * digits for a payment that is not coming. It was a two-second toast and
   * nothing to the other phone. */
  refuseForRun(viaTap) {
    const W = window.FoxyWallet;
    const run = /** @type {any} */ (this._reqRun || {});
    const n = Math.round(Number(run.amount) || 0);
    /* No promise of when: a payment can take minutes (`reqRunLive`), and "within about a minute" sent the person back
     * to scan the same code again before the first had ended. */
    const what = n > 0 ? (run.unit === 'usd' ? this.moneyIn(n, 'usd') : this.group(n) + ' sats') : '';
    const which = what ? what + (run.to ? ' to ' + run.to : '') : (run.to || '');
    const said = 'A payment is still being delivered' + (which ? ' (' + which + ')' : '') + '. Wait for it to end.';
    console.log('[foxy] refused: a request payment is still out (' + (run.id || '?') + ')' + (viaTap ? '; the other phone is told' : ''));
    if (viaTap && W && W.tapQuote) {
      W.tapQuote(JSON.stringify({ gaveUp: 'The payer is still finishing another payment.' })).catch(() => {});
    }
    if (viaTap && this.tapGaveNothing) this.tapGaveNothing('another payment is still going out');
    this.toast(said, true);
  }

  /* The late ending of a run let go as dead (`reqRunLive`). Nothing on screen
   * is its own: `reqBusy`, `req`, the sending screen and the trip home belong
   * to whatever was begun after it, so none of them is touched, no card is
   * raised and nothing comes home. What it made is still the person's money
   * and is booked as `requestDelivered` and the token's ending book it: on
   * its way no longer, settled where it cannot be taken back, watched where it
   * can, so its history row and RECLAIM are there. A refusal's ecash was
   * dealt with by the wallet (`afterRefusal`). */
  lateRunEnded(req, r, direct, e) {
    const W = window.FoxyWallet;
    console.warn('[foxy] request: a payment let go as dead has ended late (' + String((req && req.id) || '?') + ', '
      + (e ? 'not delivered: ' + (W && W.reason ? W.reason(e) : String((e && e.message) || e)) : 'made') + '); nothing on screen is changed for it');
    if (W && r && r.hash) {
      const hash = r.hash;
      this._seenTx = this._seenTx || {};
      this._seenTx[hash] = true;
      if (W.tag) { try { W.tag(hash, { inflight: false }); } catch (x) {} }
      const usd = r.unit === 'usd' || !!(req && req.unit === 'usd');
      if (direct) {
        if (req && req.viaTap && W.tag) { try { W.tag(hash, { handed: 'tap' }); } catch (x) {} }
        const website = !!(r.website || (req && !req.viaTap && req.delivery && req.delivery.kind === 'https'));
        if ((r.confirmed && !website) || r.lockedTo) {
          W.settleTx(hash);
          if (W.forgetClaimedToken) W.forgetClaimedToken(hash);
          if (W.lastTokenHash && W.lastTokenHash() === hash) W.clearLastToken();
        } else if (!usd || website) {
          this.watchToken(usd ? 0 : r.sats, hash, false);
          if (website && W.tag) { try { W.tag(hash, { site: true }); } catch (x) {} }
        }
      } else if (!usd) {
        this.watchToken(r.sats, hash, r.swapped === false);
      }
    }
    /* Made and not delivered (`foxyToken`): on its way no longer, and watched, as the live ending's token screen
     * does. It was left marked on its way and unwatched, so its row was never announced nor turned green when taken.
     * A refusal's is the wallet's (`afterRefusal`). */
    const made = e && !e.foxyRefused ? e.foxyToken : null;
    if (W && made && made.hash) {
      this._seenTx = this._seenTx || {};
      this._seenTx[made.hash] = true;
      if (W.tag) { try { W.tag(made.hash, { inflight: false }); } catch (x) {} }
      const usdMade = made.unit === 'usd' || !!(req && req.unit === 'usd');
      this.watchToken(usdMade ? 0 : made.sats, made.hash, made.swapped === false);
    }
    if (this.refreshBalance) this.refreshBalance();
    if (this.loadHistory) this.loadHistory();
  }

  requestDelivered(req, r) {
    const W = window.FoxyWallet;
    const confirmed = !!(r && r.confirmed);
    /* It has arrived somewhere, so it is no longer on its way: the history pass
     * may announce it, and this function does so itself below. Cleared first, so
     * a pass landing between here and `announcePayment` finds a finished
     * payment rather than a hidden one. */
    if (W.tag && r && r.hash) { try { W.tag(r.hash, { inflight: false }); } catch (e) {} }
    /* `sendPhase` as well as `reqBusy`, and this is the only place that ends
     * this path.
     *
     * A direct payment sets `sendPhase: 'in'` on its way to the sending screen
     * and the success branch above returns straight into here, so the two
     * places that clear it — the token branch and the `.catch` — are both
     * paths a successful tap never takes. It stayed `'in'` for the life of the
     * app, and `syncTap` reads it to decide whether this phone may listen for
     * a receiver: one tap paid, and no tap ever worked again (one payment,
     * then silence for the next 37 seconds on home).
     *
     * `'settled'` rather than null, which is what the Lightning send leaves
     * behind for the same moment (03-send.js). */
    this.setState({ reqBusy: false, req: null, sendPhase: 'settled' });
    // paid by tap: remembered, so the same offer heard again is not paid again (26d-tap.js)
    if (req && req.viaTap && this.tapMarkPaid) this.tapMarkPaid(this._tapOfferNow, req);
    /* A payment locked to them has a receipt to collect: the signature its
     * pieces are spent with, which the mint says once they have swapped it
     * in (`lockedReceipt`). A receiver with a route swaps at once, so a few
     * seconds on is when to ask; one without has not yet, and the payment's
     * own screen asks again whenever it is opened. */
    if (r && r.hash && r.lockedTo && W.lockedReceipt && !(this.offlineNow && this.offlineNow())) {
      const hash = r.hash;
      setTimeout(() => { try { W.lockedReceipt(hash); } catch (e) {} }, 8000);
    }
    /* Over-paid, so the receiver owes change back over this link. It has to
     * swap at the mint to make it, which takes seconds — and the payer was
     * letting the link go the moment the person got back to home, one second
     * before the change was ready. */
    // in the payment's unit: a dollar payment's change is dollars
    const rUnit = (r && r.unit === 'usd') || (req && req.unit === 'usd') ? 'usd' : '';
    if (r && Number(r.over) > 0) this.expectChange(Number(r.over), r.hash, rUnit);
    // a payment they are carrying home: the entry a refund would settle
    if (this._carriedPay && !this._carriedPay.hash && r && r.hash) this._carriedPay.hash = r.hash;
    /* A locked payment is done when it leaves, because the payer cannot ever
     * take it back: the proofs carry the receiver's key and nothing this phone
     * holds will open them. Shown as pending it reads as money still within
     * reach — the amber row invites a reclaim that cannot work — and the claim
     * watch then raises a note weeks later that reads as a second payment. Unconfirmed or not, there is nothing the payer can
     * do about it, so there is nothing to keep it open for.
     *
     * A delivery that failed outright never reaches here: it throws with the
     * token attached and the token screen shows it, which is the one case where
     * the payer still has something to hand over. */
    /* Marked as having crossed a tap, whatever became of the answer.
     *
     * The token itself is kept — an unconfirmed tap may genuinely not have
     * arrived, and forgetting it would lose the money outright, which is why the
     * branch below is unchanged. What the mark buys is the other half: this
     * payment is never offered back.
     *
     * RECLAIM takes a token's proofs back with a swap. On a payment that crossed
     * a tap the receiver may be holding it on trust and unswapped, because they
     * have no route — that is the whole of what they agreed to — and the mint
     * will honour the payer's swap. A payer did exactly that and the receiver
     * read `spent by the payer`. Foxy does not put that button in front of
     * anybody. The token is still there to
     * show or copy, which hands it to the same person again and is not a double
     * spend. */
    if (req && req.viaTap && W.tag) {
      try { W.tag(r.hash, { handed: 'tap' }); } catch (e) {}
    }
    /* A website's 2xx is not a Foxy's. A Foxy receiver swaps the pieces in
     * before it answers; a site answers 202 Accepted for "queued", or a
     * catch-all 200, and may never redeem them. So the payment is shown as
     * made and the token is kept and watched, as a shown token is, at its own
     * mint, until the mint says its pieces are spent: that watch settles the
     * entry. It was forgotten at once, and sats a site never took were out of
     * the wallet with nothing left to take them back with. */
    const website = !!(r && (r.website || (req && !req.viaTap && req.delivery && req.delivery.kind === 'https')));
    if ((confirmed && !website) || (r && r.lockedTo)) {
      W.settleTx(r.hash);
      if (W.forgetClaimedToken) W.forgetClaimedToken(r.hash);
      if (W.lastTokenHash && W.lastTokenHash() === r.hash) W.clearLastToken();
      if (!confirmed) {
        console.log('[foxy] a locked payment was handed over and nobody confirmed it;'
          + ' settled anyway, because it is not this phone\u2019s to take back');
      }
    } else if (!rUnit || website) {
      // a dollar token as well, for a website: the watch reads a token in its own unit
      this.watchToken(rUnit ? 0 : r.sats, r.hash, false);
      /* Marked as a website's, so its amber row says it was paid and is being
       * watched rather than "not yet claimed" beside a RECLAIM, for a site
       * that answered yes (16-history-lists.js `bySite`). */
      if (website && W.tag) { try { W.tag(r.hash, { site: true }); } catch (e) {} }
    }
    this.refreshBalance();
    this.loadHistory();
    this.tidyChangeLater();
    if (rUnit) {
      // dollars paid: the figure in cents, from the dollar balance, with no fee
      const cents = Math.round(Number(r.amount != null ? r.amount : (req ? (req.unit === 'usd' ? Math.max(0, Math.round(Number(req.amount) || 0)) : req.sats) : 0)) || 0);
      const paidCents = Math.max(0, cents - (Number(r.over) || 0));
      this._paying = null;
      this._lastPay = { unit: 'usd', amount: paidCents, fee: 0, asked: 0 };
      this.announcePayment({ dir: 'out', sats: 0, unit: 'usd', amount: paidCents, hash: 'request-' + r.hash, to: 'ecash', tokenHash: r.hash });
      return;
    }
    if (this._paying && this._paying.unit === 'sat') { this._lastPay = { unit: 'sat', amount: Number(r.sats) || 0, fee: 0, asked: 0 }; this._paying = null; }
    /* What was paid, not the piece it was paid with.
     *
     * With no exact pieces the payer covers the amount and the receiver hands
     * the difference straight back, so a 2-sat payment made with a 4-sat piece
     * is still a 2-sat payment. The receiver already says 2; the payer said 4.
     * `over` is 0 on every ordinary send, so this is r.sats everywhere else. */
    const paidOut = Math.max(0, Number(r.sats) - (Number(r.over) || 0));
    this.announcePayment({ dir: 'out', sats: paidOut, hash: 'request-' + r.hash, to: 'ecash', tokenHash: r.hash });
  }

  /* A token from a mint with nothing filed under it. Ask before adding a mint
   * to the wallet, since that is what claiming it does. */
  offerNewMint(text) {
    const W = window.FoxyWallet;
    const info = W.tokenInfo(text);
    if (!info) { this.toast('That token could not be read.', true); return false; }
    const mint = String(info.mint || '').replace(/\/+$/, '');
    const unit = info.unit || 'sat';
    /* The mint this phone belongs on (the wallet's `homeMint`) is its own too: a token from it is taken there, a plain
     * claim at a chosen mint, not moved anywhere. */
    const home = W.homeMint ? W.homeMint() : '';
    if (home && mint === String(home).replace(/\/+$/, '')) return false;
    /* Your mint is the one you are on. A token from any other goes through
     * MOVE TO YOUR MINT, whatever is held there: it used to be offered only
     * where nothing was, so the change a first move left at WesternBTC made
     * the next WesternBTC token switch the wallet there and claim it, with no
     * say. Moving it home is the main choice; keeping it
     * at its own mint is asked for, never assumed. */
    if (mint === String(W.mintUrl || '').replace(/\/+$/, '')) return false;

    /* No route, and ecash from a mint this phone is not on. Nothing about it
     * can be checked and it cannot be brought home, so it is refused at once
     * rather than after a screen that says it is being verified. Nothing is kept: the token is still theirs to show again. */
    if (this.offlineNow && this.offlineNow()) {
      console.log('[foxy] offline, and the token is from another mint: refused');
      this.receivingDown();
      this.blockedCard('offlineOtherMint', {
        tone: 'warn',
        title: 'HIGH RISK \u2014 YOU\u2019RE OFFLINE',
        reason: 'This ecash is from ' + (this.mintNameOf(mint) || 'another mint')
          + ', not your mint. Offline, Foxy cannot check it or bring it home, so it was not accepted. '
          + 'Reconnect and scan it again.',
      });
      return true;
    }

    this.setState(p => ({
      screen: 'newMint', stack: p.stack.concat([p.screen]),
      nmInfo: { sats: info.sats, mint: mint, unit: unit, amount: info.amount }, nmToken: text,
      nmPlan: null, nmErr: '', nmStage: '', nmBusy: false, nmTooSmall: false,
    }));
    setTimeout(() => this.nmQuote(), 60);
    return true;
  }

  /* Another unit's token from a mint with nothing filed: it cannot be moved
   * home (a move is a Lightning payment in sats), so redeeming keeps it at its
   * own mint, in its own unit. */
  newMintKeep(passed) {
    const W = window.FoxyWallet;
    const info = this.state.nmInfo;
    if (!info || this.state.nmBusy) return;
    // claiming at the token's mint switches there
    if (this.refuseSwitchWhileBusy()) return;
    /* Keeping it there adds that mint to this phone: past the lock first, where one is set and the mint is new to it
     * (09-melt-paste-switch.js `mintGate`). Given up, the token is still theirs and this screen stays. */
    if (!passed && this.mintGate) { this.mintGate(info.mint, () => this.newMintKeep(true), 'To keep it at a new mint.'); return; }
    const name = this.mintNameOf(info.mint);
    /* Kept at its own mint, and the wallet back on yours afterwards: keeping a
     * token there is not choosing that mint to use. */
    const home = String(W.mintUrl || '');
    this.setState({ nmBusy: true, nmErr: '', nmStage: 'Keeping it at ' + name + '\u2026' });
    this.showMelt('Keeping it at ' + name + '\u2026');
    W.receiveToken(this.state.nmToken).then(r => {
      const back = (r.switched && home) ? (this.connectBack ? this.connectBack(home) : W.connect(home)).then(() => true, () => false) : Promise.resolve(false);
      return back.then(returned => {
        this.hideMelt();
        this.setState({ nmBusy: false, nmStage: '', nmInfo: null, nmPlan: null, nmToken: '', nmTooSmall: false, screen: 'home', stack: [] });
        this.walletReady({ name: returned ? this.mintNameOf(home) : r.host });
        if (r.unit && r.unit !== 'sat') this.tookToken(r);
        else this.toast('Kept ' + this.group(r.sats || info.sats) + ' sats at ' + name);
      });
    }).catch(e => {
      this.hideMelt();
      this.setState({ nmBusy: false, nmStage: '', nmErr: W.reason(e) });
    });
  }

  /* Say what a token receive took, when it was not sats. A sat receive is
   * confirmed by the balance counting up; another unit does not move it. */
  /* Ecash kept with no route, and what the person is shown for it.
   *
   * Locked to this phone, it is received and gets the confirmation any
   * payment gets. Taken on trust, it is not — it says so in history, in red,
   * and gets its confirmation when it settles. */
  keptOfflineSaid(r) {
    if (!r || !r.kept || r.trusted) return;
    this._seenTx = this._seenTx || {};
    if (r.hash) this._seenTx[r.hash] = true;
    this.loadHistory();
    // dollars kept are announced as dollars: ADDED TO DOLLARS, the cents
    const usdKept = r.unit === 'usd';
    this.announcePayment(Object.assign({ dir: 'in', sats: usdKept ? 0 : r.sats, force: true, to: 'ecash',
                           hash: r.hash || ('kept-' + Date.now()) },
                         usdKept ? { unit: 'usd', amount: Math.round(Number(r.amount) || 0) } : {}));
  }

  /* PAYMENT RECEIVED for a token the person scanned or pasted themselves.
   *
   * It was left to the history pass, which announces every new entry — and
   * holds its tongue for two minutes after a move between mints, so a token
   * scanned 27 seconds after one was taken, counted, and never confirmed
   * (the log said "confirmation held back: in 800").
   * A person who just scanned a code is owed the screen, whatever else is
   * going on. Marked seen first, so the pass does not announce it twice. */
  announceTaken(r) {
    if (!r || r.kept || !r.hash || !(Number(r.sats) > 0)) return;
    if (r.unit && r.unit !== 'sat') return;
    this._seenTx = this._seenTx || {};
    if (this._seenTx[r.hash]) return;
    this._seenTx[r.hash] = true;
    this.announcePayment({ dir: 'in', sats: Number(r.sats), hash: r.hash, force: true });
  }

  tookToken(r) {
    // (dollars kept offline have their own confirmation: `keptOfflineSaid`)
    if (!r || !r.unit || r.unit === 'sat' || r.kept) return;
    this.toast('Received ' + this.unitMoney(r.amount, r.unit) + ' in ' + this.unitLabel(r.unit)
      + ' ecash at ' + r.host);
  }

  /* Is the new-mint screen showing a token in a unit other than sats? */
  nmUnit() {
    const i = this.state.nmInfo;
    return !!(i && i.unit && i.unit !== 'sat');
  }

  nmUnitNote() {
    if (!this.nmUnit()) return '';
    const i = this.state.nmInfo;
    const label = this.unitLabel(i.unit);
    return 'This is ' + label + ' ecash. Foxy cannot move it to your mint, so redeeming keeps it at '
      + String(i.mint).replace(/^https?:\/\//, '') + ' as ' + label + ' ecash. Reject and the token stays as it is.';
  }

  /* Price it while it is still a string, so rejecting costs nothing. */
  nmQuote() {
    const W = window.FoxyWallet;
    const info = this.state.nmInfo;
    if (!info) return;
    // nothing to price: another unit is kept where it is, not moved
    if (info.unit && info.unit !== 'sat') {
      this.setState({ nmPlan: null, nmStage: '', nmErr: '' });
      return;
    }
    this.setState({ nmStage: '', nmErr: '' });
    /* The two banks, with the move being priced between them (FoxyMoving).
     * The same picture carries on under MOVING ECASH TO YOUR MINT when they
     * say to go ahead. The melt loader is what a page
     * without that file falls back to. */
    // the fox while the fee is asked (26r-fox-wait.js); the two banks, or the melt loader, where it cannot be drawn
    const fox = !!(this.foxUp && this.foxUp('nmMove', 'fee', { forMs: this.MELT_PATIENCE_MS }));
    if (!fox && !this.movingUp('VERIFYING ECASH', info.mint)) {
      if (!document.getElementById('foxy-melt')) this.showMelt('');
      this.meltHeading(this.mintNameOf(info.mint).toUpperCase(),
        'This token is from a mint you don\u2019t use. Foxy is checking the fee to move it.');
      this.meltSays('');
    }

    // Tor's first request through a new circuit fails often enough that one
    // refusal means little. Try again after a moment before reporting it.
    const ask = (tries) => W.sweepQuote(info.mint, info.sats).catch(e => {
      // a fee larger than the token is an answer, not a failure to get one
      if (tries <= 0 || /more than the token is worth/i.test(String((e && e.message) || e))) throw e;
      console.log('[foxy] fee quote failed, retrying:', (e && e.message) || e);
      this.meltSays('Still checking\u2026');
      return new Promise(r => setTimeout(r, 2500)).then(() => ask(tries - 1));
    });

    ask(2).then(plan => {
      // the figures are on screen and REDEEM is live: nothing left to wait for
      if (fox) this.foxEnd('nmMove', true); else this.movingDown();
      this.setState({ nmPlan: plan, nmStage: '' });
    }).catch(e => {
      if (fox) this.foxEnd('nmMove', false); else this.movingDown();
      // too small to move: keeping it at its mint, or leaving it, is what is left
      const tooSmall = /more than the token is worth/i.test(String((e && e.message) || e));
      this.setState({ nmPlan: null, nmStage: '', nmErr: W.reason(e), nmTooSmall: tooSmall });
    });
  }

  /* Claim at the token's own mint, then pay it home.
   *
   * The claim is first and is never skipped: if the move fails the sats are
   * already yours at that mint rather than sitting in a string somebody else
   * holds a copy of.
   */
  newMintRedeem() {
    const W = window.FoxyWallet;
    const plan = this.state.nmPlan;
    if (!plan || this.state.nmBusy) return;
    // the claim and the move both connect to other mints
    if (this.refuseSwitchWhileBusy()) return;
    // one line for the whole move, claim and payment alike
    this.setState({ nmBusy: true, nmErr: '', nmStage: 'Moving to your mint\u2026' });
    // the same two banks again, now with the sats actually crossing between them
    // the fox, the claim and then the move's own stages (26r-fox-wait.js); the two banks, or the melt loader, where it cannot be drawn
    const fox = !!(this.foxUp && this.foxUp('nmMove', 'move', { forMs: 120000 }));
    if (!fox && !this.movingUp('MOVING ECASH TO YOUR MINT', this.state.nmInfo && this.state.nmInfo.mint)) {
      this.showMelt('Moving to your mint\u2026');
    }
    const down = (landed) => { if (fox) this.foxEnd('nmMove', landed); else this.movingDown(); };
    this._quiet = true;
    this._hushUntil = Date.now() + 120000;
    this.expectOwnSpend();
    // what history holds before any of this, so the entries the sweep creates
    // can be marked as already seen rather than announced one by one later
    W.transactions(50).then(list => {
      this._sweepBefore = new Set(list.map(x => x.hash));
    }).catch(() => { this._sweepBefore = null; });

    /* Claimed at their mint as a visit: the phone is not saved there, and the mint is not one the person chose (the
     * wallet's `mintsChosen`). The money there shows on the list, and adding that mint asks the lock (`mintGate`). Saved
     * there, a token from a stranger's mint, moved home, left that mint free to switch to with nothing asked. */
    W.receiveToken(this.state.nmToken, { visit: true }).then(r => {
      // claimed at their mint: the first mint has answered
      if (fox) this.foxStep('nmMove', 'answered');
      return W.moveRun(plan, fox ? this.foxHears('nmMove') : () => {}).then(done => this.hushSweepEntries().then(() => done)).then(done => {
        /* The move's own history entries are marked seen, and taken out of the
         * confirmation queue, before anything reloads history. walletReady ran
         * first, queued the claim at this mint as a payment received, and it
         * showed as a second confirmation when the move's own was dismissed. */
        // change left at the source: the fox stays up, near the end, for that second pass (`sweepChange`)
        if (!(fox && (done.leftBehind || 0) > 0)) down(true);
        this._quiet = false;
        // what landed, not what the token said before fees
        this._netLanded = done.sats;
        this.setState({ nmBusy: false, nmStage: '', nmInfo: null, nmPlan: null, nmToken: '' });
        this.walletReady({ name: done.name || plan.to.replace(/^https?:\/\//, '') });
        console.log('[foxy] sweep done:', done.sats, 'sats landed |',
                    'quoted at most', plan.feeMax, 'fee |',
                    (done.leftBehind || 0), 'left at the source');

        // A second pass for the change whenever it can pay for itself.
        //
        // This used to be a flat 60-sat threshold, which was a guess: 19 sats
        // of change is well worth moving at a cost of 3, and the guess left it
        // behind. Ask the mint what the move costs and let the answer decide —
        // sweepQuote refuses outright when the fee exceeds the amount, so a
        // failed quote IS the answer for dust.
        const left = done.leftBehind || 0;
        if (left > 0) {
          console.log('[foxy] change of', left, 'sats \u2014 asking what moving it costs');
          this.sweepChange(done.from, left, done.sats);
          return;
        }
        // stragglers can still arrive after this, so the window stays open a
        // little longer and closes itself
        this._hushUntil = Date.now() + 30000;
        this.noteReceived();
        this.announcePayment({
          dir: 'in', sats: done.sats, force: true,
          hash: 'sweep-' + Date.now(), to: 'ecash',
        });
      }).catch(e => {
        down(false);
        this._quiet = false;
        this.setState({
          nmBusy: false, nmStage: '',
          nmErr: W.reason(e) + ' The sats are safe at ' + r.host + '.',
        });
        /* Back home: the claim was a visit, and the session stays on no mint the person did not choose. The sats stay
         * at the token's mint and show on its tile. */
        const home = String(plan.to || '');
        if (home && W.mintUrl !== home) {
          (this.connectBack ? this.connectBack(home) : W.connect(home))
            .then(w => this.walletReady(w || { name: home.replace(/^https?:\/\//, '') }), () => this.walletReady({ name: r.host }));
        } else {
          this.walletReady({ name: r.host });
        }
      });
    }).catch(e => {
      down(false);
      this._quiet = false;
      this.setState({ nmBusy: false, nmStage: '', nmErr: W.reason(e) });
    });
  }

  /* Expect proofs to disappear, because we are about to spend them.
   *
   * reconcile runs on a timer and compares what the mint says is unspent
   * against what is filed here, so a melt this wallet performed shows up as a
   * discrepancy a few seconds later. The window stays open long enough to
   * cover the reconcile that follows, then closes on its own — a flag that
   * stayed set would hide a real loss.
   */
  expectOwnSpend(ms) {
    this._expectSpend = true;
    clearTimeout(this._expectT);
    this._expectT = setTimeout(() => {
      this._expectSpend = false;
      console.log('[foxy] watching for outside spends again');
    }, ms || 90000);
  }

  /* Mark every entry the sweep created as already announced.
   *
   * A sweep writes three: claimed at their mint, melted out of it, credited at
   * yours. All three are real and all three belong in history — but the person
   * did one thing, so they get one confirmation. The history sweep runs on its
   * own schedule, which is why silencing for a moment was not enough.
   */
  hushSweepEntries() {
    const W = window.FoxyWallet;
    const before = this._sweepBefore;
    this._sweepBefore = null;
    /* Only rows at the mint the phone is on (and the oldest rows, which name none). A payment the away walk claimed at
     * another mint meanwhile is written there too, and marked here it was never said: the hush had dropped its report,
     * and the dedupe dropped it once the hush was over. It is said when the hush ends (`sayHushedAway`). */
    const canonM = (u) => (W && W.canonicalMint ? W.canonicalMint(u) : String(u || '').replace(/\/+$/, ''));
    const here = canonM(W.mintUrl);
    return W.transactions(50).then(list => {
      this._seenTx = this._seenTx || {};
      let n = 0;
      const mine = {};
      list.forEach(x => {
        if (before && before.has(x.hash)) return;
        mine[x.hash] = true;
        if (x.mint && canonM(x.mint) !== here) return;
        this._seenTx[x.hash] = true;
        n++;
      });
      // and any a history pass already queued for a confirmation
      if (this._paidQueue && this._paidQueue.length) {
        this._paidQueue = this._paidQueue.filter(q => !(q && mine[q.hash]));
      }
      if (n) console.log('[foxy] sweep wrote', n, 'entries, none to announce');
    }).catch(() => {});
  }

  /* Move the change left at the source mint, then confirm the total.
   *
   * Runs quietly: the person asked for one transfer, not two, so the second
   * pass reports as part of the first. If it cannot be quoted or fails, the
   * change simply stays where it is and the confirmation says what landed.
   */
  sweepChange(from, left, already) {
    const W = window.FoxyWallet;
    // the mint the change is moved to, where the phone is now; gone back to if the move fails over there
    const dest = String(W.mintUrl || '');
    this.expectOwnSpend();
    // one extra pass only: the second move leaves its own change, and chasing
    // that forever would spend more on quotes than it recovers
    // the fox the move left up for this pass ends where this pass does not run (26r-fox-wait.js)
    const foxLeft = !!(this.foxOn && this.foxOn('nmMove'));
    if (this._chasingChange) { if (foxLeft) this.foxEnd('nmMove', true); return; }
    /* Collecting the change connects to the source mint. If a payment started
     * while the first move ran, that switch would pull it onto the wrong mint,
     * so the change stays where it is — still spendable there — and the
     * confirmation reports what landed. Checked before this pass marks itself
     * busy, or it would always refuse. */
    if (this.moneyBusy()) {
      if (foxLeft) this.foxEnd('nmMove', true);
      console.log('[foxy] change of', left, 'sats left at the source: a payment is in progress');
      this._quiet = false;
      this._hushUntil = Date.now() + 30000;
      this.announcePayment({
        dir: 'in', sats: already, force: true,
        hash: 'sweep-' + Date.now(), to: 'ecash',
      });
      return;
    }
    this._chasingChange = true;
    this._sweepBefore = null;
    // the same fox carrying on, or one of its own; the melt loader where it cannot be drawn
    const fox = foxLeft || !!(this.foxUp && this.foxUp('nmMove', 'move', { forMs: this.MELT_PATIENCE_MS }));
    if (!fox) this.showMelt('Moving to your mint\u2026');
    this._quiet = true;

    const done = (extra, note) => {
      // the money that came landed whether or not the change did: ALL SET
      if (fox) this.foxEnd('nmMove', true); else this.hideMelt();
      this._quiet = false;
      this._chasingChange = false;
      this.refreshBalance();
      this.loadHistory();
      if (note) console.log('[foxy] change:', note);
      this._hushUntil = Date.now() + 30000;
      this.announcePayment({
        dir: 'in', sats: already + (extra || 0), force: true,
        hash: 'sweep-' + Date.now(), to: 'ecash',
      });
    };

    // Quote FIRST, while this wallet is still on the destination mint.
    // Connecting to the source before quoting made sweepQuote read the source
    // as both ends and refuse with "already from this mint" — and left the app
    // sitting on the source mint's balance afterwards.
    W.sweepQuote(from, left)
      // the change's mint as a visit: the person did not choose it (the wallet's `mintChosen`); `moveRun` saves home
      .then(plan => W.connect(from, null, null, { remember: false }).then(() => W.moveRun(plan, fox ? this.foxHears('nmMove') : () => {})))
      .then(r => this.hushSweepEntries()
        .then(() => done(r.sats, 'moved ' + r.sats + ', ' + (r.leftBehind || 0) + ' still left')))
      .catch(e => {
        // the quote refused, which means the fee is more than the change
        // no banner: dust staying put is not news, and the log has it
        console.log('[foxy] change left where it is:', (e && e.message) || e);
        // a move that failed after the visit to the change's mint: home again, not left on that mint
        if (dest && W.mintUrl !== dest) (this.connectBack ? this.connectBack(dest) : W.connect(dest)).then(() => this.refreshBalance(), () => {});
        done(0, 'not worth moving');
      });
  }

  /* Somebody pasted ecash into the send box. It is still just a token. */
  takeTokenFromPaste(text) {
    const W = window.FoxyWallet;
    console.log('[foxy] token pasted into send |', String(text || '').length, 'chars');
    /* Guarded for as long as the claim runs (takingToken). This door had
     * nothing at all: a second paste while the first was still swapping
     * started a second claim of the same token. */
    this.takingToken(() => {
      if (this.offerNewMint(text)) return null;
      if (this.tokenSwitchRefused(text)) return null;
      this._preSettle = this.balNow();
      // something moving between the paste and the payment landing.
      // The full screen when it is there, the small loader when it is not.
      this.receivingUp('VERIFYING ECASH');
      return W.receiveToken(text).then(r => {
        this.receivingDown();
        this.walletReady({ name: r.host });
        this.tookToken(r);
        this.announceTaken(r);
        this.keptOfflineSaid(r);
        this.settleAnimate('btc');
        this.noteReceived();
      }).catch(e => {
        this.receivingDown();
        /* Retry with the token already in hand. It used to retry by calling
         * pasteEcashToken, which refuses to run anywhere but the amount
         * screen — and nothing reaching here is on it. So TRY AGAIN closed
         * the card and did nothing at all. */
        this.claimFailed(e, () => this.takeTokenFromPaste(text));
      });
    });
  }

  /* The verifying-ecash screen (Web/foxy-receive-progress.js), with the small
   * melt loader behind it for a page where that file did not load. */
  receivingUp(title) {
    /* Nothing is verified with no route, and a screen that says so is up
     * for an answer that is already known. */
    if (this.offlineNow && this.offlineNow()) return;
    const R = window.FoxyReceiving;
    /* What STOP WAITING on that screen does: back to home, and the next scan
     * is let through. The check itself is not stopped — nothing here can stop
     * a request already with the mint — and its answer still lands when it
     * comes. */
    /** @type {any} */ (window).__foxyStopWaiting = () => {
      console.log('[foxy] receiving: the person stopped waiting for the mint; the check goes on behind');
      clearTimeout(this._takingT);
      this._takingToken = false;
      this.setState({ screen: 'home', stack: [] });
      this.toast('Still checking with the mint.', false);
    };
    if (R && R.begin(title)) return;
    this.showMelt('Receiving ecash\u2026');
  }

  receivingDown() {
    const R = window.FoxyReceiving;
    if (R && R.visible()) { R.end(); return; }
    this.hideMelt();
  }

  /* The two-bank screen for a token from a mint this wallet does not use
   * (Web/foxy-move-progress.js). Already up, it keeps its animation and only
   * the words change — the move is priced and then made, and it is the same
   * move. Answers false when that file did not load, so the caller can fall
   * back to the melt loader.
   *
   * `from` is the token's mint; the other bank is the one you are on. */
  movingUp(title, from) {
    const M = window.FoxyMoving;
    if (!M) return false;
    if (M.visible()) return M.retitle(title);
    return M.begin(title, {
      from: this.mintNameOf(from) || 'THEIR MINT',
      to: this.mintName() || 'YOUR MINT',
    });
  }

  movingDown() {
    const M = window.FoxyMoving;
    if (M && M.visible()) { M.end(); return; }
    this.hideMelt();
  }

  /* The same thing through the camera. A token is often handed over as a QR,
   * and the string is too long to retype. */
  scanEcashToken() {
    const W = window.FoxyWallet;
    if (!W || !W.scan) return;
    W.scan('Scan an ecash token').then(text => {
      const t = String(text || '').trim();
      if (W.classify(t) !== 'token') {
        this.toast('That QR is not a Cashu token.', true);
        return;
      }
      this.receivingUp('VERIFYING ECASH');
      if (this.offerNewMint(t)) { this.receivingDown(); return; }
      if (this.tokenSwitchRefused(t)) { this.receivingDown(); return; }
      // the figure before the claim, for the count-up
      this._preSettle = this.balNow();
      return W.receiveToken(t).then(r => {
        this.receivingDown();
        this.walletReady({ name: r.host });
        this.tookToken(r);
        this.announceTaken(r);
        this.settleAnimate('btc');
        this.noteReceived();
        // no banner: the pill counting up is the confirmation, and a switched mint is not announced.
      });
    }).catch(e => { this.receivingDown(); this.claimFailed(e, () => this.scanEcashToken()); });
  }

  /* Pull back a token that never landed. Whoever swaps first wins, so this
   * fails cleanly if the other person already claimed it. */
  reclaimFromTx(token) {
    const W = window.FoxyWallet;
    if (!token || this.state.txReclaiming) return;
    this.setState({ txReclaiming: true });
    // the same animation a receive shows: a swap at the mint over Tor takes seconds
    this.showMelt('Taking back your sats\u2026');
    // whatever it is made of: a payment out of ecash locked to this phone is taken back too (`takeBackToken`)
    (W.takeBackToken ? W.takeBackToken(token) : W.reclaimToken(token)).then(r => {
      this.hideMelt();
      this.setState({ txReclaiming: false, screen: 'home', stack: [] });
      // taken back at another mint as a visit: home again, the session never left on it (`homeAgain`)
      const home = this.homeAgain ? this.homeAgain() : null;
      if (home) home.then(() => this.walletReady({ name: this.mintHost ? this.mintHost() : r.host }));
      else this.walletReady({ name: r.host });
      this.toast('Took back ' + this.group(r.sats) + ' sats');
      this.loadHistory();
    }).catch(e => {
      this.hideMelt();
      this.setState({ txReclaiming: false });
      this.toast(W.reason(e), true);
      if (this.homeAgain) this.homeAgain();
    });
  }
