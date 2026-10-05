
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
      console.log('[foxy] token claimed:', r.sats, 'sats', onItsScreen ? '(on its screen)' : '(a note)');
      if (onItsScreen) {
        this.announcePayment({ dir: 'out', sats: r.sats, hash: 'tokenclaim-' + r.hash, to: 'ecash', tokenHash: r.hash });
      } else {
        this.toast('Your ecash token for ' + this.group(r.sats) + ' sats was redeemed');
      }
    }).catch(() => {
      this._claimNext[r.hash] = Date.now() + this.claimWait('later');
    }).then(() => this.claimWatchTick());
  }

  /* The ECASH TOKEN screen's QR code, animated for a token of more than two
   * proofs (FoxyWallet.tokenQrAnimates): one code for such a token was too
   * dense for some cameras. Frames of at most 200 bytes at error
   * correction L, a new one every 200 ms, the same UR frames cashu.me shows, so
   * cashu.me and Foxy read them (06-animated-qr.js). The code is drawn as large
   * as the screen allows, so bigger frames stay easy to read and a token takes
   * fewer of them (fewer frames scan faster). Each frame is drawn straight into the image, not
   * through a render; renderToken shows the latest one. */
  /* The frames carry heavy error correction, because something is drawn on
   * top of them.
   *
   * Every QR in Foxy has the badge in its middle, and the badge covers modules
   * the reader needs. A frame at 'L' can lose 7% of its codewords; the badge
   * was taking 12% of them, and a blot in one place is worse than that figure
   * suggests because it destroys whole codewords in a few blocks rather than
   * one here and there. So the animated codes — tokens, and requests too dense
   * for one code — could not be read at all, while a Lightning invoice beside
   * them scanned first time, because an invoice is a single code at 'M'.
   *
   * 'Q' is 25%, and it costs a fragment this size 65 modules against 53 — 3.3
   * points each in that box, still above the 3 that phone cameras want.
   * tests/qr-readable.js holds both ends of that: what the badge covers, and
   * what the level allows. */
  TOKEN_QR = { fragment: 200, everyMs: 200, ecc: 'Q' };

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
    const frames = W.animatedQr(text, this.TOKEN_QR.fragment);
    const run = { text: text, src: '', timer: 0 };
    const tick = () => {
      const src = W.qr(frames.next(), { ecc: this.TOKEN_QR.ecc });
      if (!src) return;
      run.src = src;
      const img = document.querySelector('[data-req-qr]');
      if (img && img.getAttribute('src') !== src) img.setAttribute('src', src);
    };
    this._reqQr = run;
    tick();
    run.timer = setInterval(tick, this.TOKEN_QR.everyMs);
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
      if (this.moneyBusy() || this.movingMints() || this._changeDueAt) { this.tidyChangeLater(more); return; }
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
        tokenOut: r.token, tokenOutSats: r.sats, tokenOutHash: r.hash, tokenForPayee: true,
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
        if (r.switched) { this.walletReady({ name: r.host }); this.toast('Now on ' + r.host); }
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
        tokenOut: r.token, tokenOutSats: r.sats, tokenOutHash: r.hash, tokenForPayee: false,
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
    /* A request just opened is not one being paid.
     *
     * `reqBusy` is what makes the button say PAYING…, and a route that leaves
     * it set — a payment abandoned part way, a screen left — carried it into
     * the next request, which arrived already claiming to be paying and could
     * not be tapped. Nothing has been asked of the
     * wallet at this point, so it is false by definition. */
    this.setState({ reqBusy: false });
    if (!req) { this.toast('That request could not be read.', true); return; }
    if (req.unit && req.unit !== 'sat') {
      this.toast('That request asks for ' + this.unitLabel(req.unit) + ' ecash. Foxy can only send sats as ecash.', true);
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
    if (W.asksInDollars && W.asksInDollars(req)) {
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
    if (req.mints.length && !req.mints.some(holdsAt)) {
      this.toast('That request wants a mint you hold nothing at.', true);
    }
    this.setState(p => ({ screen: 'reqOffer', stack: p.stack.concat([p.screen]), req: req,
      // a note left on an earlier send is not this payment's note
      note: '', noteDraft: '' }));
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
    this.stageScreen('needScan', {
      title: 'Receiver<br>needs to scan', qr: made.token,
      /* What is being paid, not what it is being paid with; and where the
       * rest is coming back, how to collect it. */
      amount: this.stageMoney(Math.max(0, Number(made.sats) - (Number(made.over) || 0))),
      body: (made.changeAsked && Number(made.over) > 0)
        ? 'Ask the receiver to scan this QR code. Their phone will then show a code for your <strong>'
          + this.stageMoney(made.over) + '</strong> change: scan it to collect.'
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
          scanWhy: due ? 'SCAN FOR YOUR ' + this.stageMoney(made.over).toUpperCase() + ' CHANGE' : '',
        }));
        if (this.claimWatchTick) setTimeout(() => this.claimWatchTick(), 0);
      },
    });
  }

  /* Mint it at the mint the request names, switching there if needed. */
  /* `go.overpayOk` is the person's answer to the over-pay card, threaded rather
   * than stashed: this function's work is asynchronous, so a flag on `this`
   * would be cleared before the send reads it. */
  makeTokenForRequest(go) {
    const W = window.FoxyWallet;
    const req = this.state.req;
    if (!req || this.state.reqBusy) return;
    const want = String(req.mints[0] || '').replace(/\/+$/, '');
    const here = W.mintHost && ('https://' + W.mintHost()) === want;
    // making it somewhere else switches mints, which waits for any payment
    if (want && !here && this.refuseSwitchWhileBusy()) return;

    /* A payment request names its own mint, and this used to connect to it on
     * one tap. Tokens from an attacker-chosen mint are worthless, and the
     * request only has to be scanned to get here.
     *
     * So a mint this device has never used gets named in full first, with
     * connecting as the deliberate action. One already on the list goes
     * through — it has been accepted before. */
    if (want && !here && !this._reqMintOk) {
      const known = (W.mints ? W.mints() : []).some(m =>
        String(m.id || m).replace(/\/+$/, '') === want);
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
          go: () => { this._reqMintOk = want; this.makeTokenForRequest(go); },
        });
        return;
      }
    }
    this._reqMintOk = null;
    this.setState({ reqBusy: true });

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
    const direct = !!(reachable && req.sats > 0);
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
      this.setState(p => ({
        screen: 'sendDone', stack: p.stack.concat([p.screen]), sendPhase: 'in',
        flow: 'send', recipientKind: 'ecash', amount: String(req.sats), unit: 'SATS',
        /* Who this one goes to, not who the last one went to: the address of
         * an earlier send was still in state, so a tap said it was sending to
         * it. A tap goes to the code on both screens. */
        recipient: (req.viaTap && p.tapCode) ? String(p.tapCode) : '',
      }));
    } else {
      this.showMelt('Making the token\u2026');
    }
    const ready = (want && !here) ? W.connect(want) : Promise.resolve(null);
    /* Agreed before it is asked, where the change comes straight back. The
     * question was being skipped already, but only after the send had refused
     * once for want of an answer — so the screen went to sending, back to the
     * offer and to sending again, and where the receiver had named no address
     * the card came up anyway, telling a payer whose change was on its way
     * back that the other phone would keep it. */
    const overOk = !!(go && go.overpayOk) || (direct && this.changeComesBack(req));
    ready.then(() => direct
      ? W.payRequest(req, null, { overpayOk: overOk })
      /* Locked to them when they asked for it and this phone can: a token shown
       * on a screen is one anybody's camera can take, and a receiver with no
       * route can only accept ecash locked to it. It went out plain, so the
       * lock a scanned request asked for was dropped without a word. */
      /* And with no route, made from what is on hand: an amount the pieces
       * cannot make exactly is covered and the difference is change, which is
       * the person's to agree to first. It used to fall through to a swap and
       * say "this needs a connection" about a payment that needed none. */
      : W.sendToken(req.sats, (req.lockTo && !(this.offlineNow && this.offlineNow()))
          ? { unit: req.unit || 'sat', lockTo: req.lockTo }
          : ((this.offlineNow && this.offlineNow())
            ? { unit: req.unit || 'sat', cover: true, overpayOk: !!(go && go.overpayOk) }
            : { unit: req.unit || 'sat' }))).then(r => {
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
        this._crossMovedTo = null;
        this.requestDelivered(req, r);
        this.crossComeHome();
        return;
      }
      this.setState({
        reqBusy: false, req: null, tokenCopied: false,
        tokenOut: r.token, tokenOutSats: r.sats, tokenOutHash: r.hash, tokenForPayee: true,
        screen: 'tokenOut', stack: [],
      });
      this.needScanStage(r);
      this.refreshBalance();
      this.watchToken(r.sats, r.hash, r.swapped === false);
      this.tidyChangeLater();
    }).catch(e => {
      this.hideMelt();
      // off the sending animation, whichever way this ends: it is not sending
      this.setState({ reqBusy: false, sendPhase: null });
      // stopped by the person before it was made: nothing to report, and they are home already
      if (e && e.foxyStopped) return;
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
          this.makeTokenForRequest({ overpayOk: true });
          return;
        }
        this.overpayCard(Object.assign({}, e.foxyNeedsOverpay,
                                       { changeComesBack: false })).then((yes) => {
          if (!yes) { this.setState({ req: null, sendPhase: null, screen: 'home', stack: [] }); return; }
          this.makeTokenForRequest({ overpayOk: true });
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
        if (this._crossCameFrom) this.crossComeHome();
        this.refreshBalance();
        this.loadHistory();
        if (e.foxyAskedNo) {
          console.warn('[foxy] the payment was not made: they said no before anything was sent:', W.reason(e));
          this.blockedCard('theyRefused', {
            tone: 'warn',
            title: 'THEY CANNOT TAKE IT',
            reason: W.reason(e),
            chip: 'Nothing was sent. Your sats are where they were.',
          });
          return;
        }
        if (e.foxyRefunded) {
          const back = e.foxyRefunded;
          this.blockedCard('theyRefused', back.short ? {
            tone: 'warn',
            title: 'THEY DID NOT TAKE IT',
            reason: W.reason(e) + ' They sent back ' + this.group(back.sats) + ' of the ' + this.group(back.paid) + ' sats.',
            chip: this.group(back.paid - back.sats) + ' sats were not returned.',
          } : {
            tone: 'warn',
            title: 'THEY DID NOT TAKE IT',
            reason: W.reason(e),
            chip: 'Your ' + this.group(back.sats) + ' sats came back, locked to this phone. Nothing is at risk.',
          });
          return;
        }
        /* With a route the wallet has already dealt with it (`afterRefusal`):
         * the pieces are swapped, or the phone that said no had redeemed
         * them first. Neither is a risk still standing. */
        if (e.foxyAtRisk.safe) {
          this.blockedCard('theyRefused', {
            tone: 'warn',
            title: 'THEY DID NOT TAKE IT',
            reason: 'They refused this payment and sent nothing back. Foxy has swapped your ecash for new pieces, so the copy they saw is worth nothing.',
            chip: 'Your ' + this.group(e.foxyAtRisk.sats) + ' sats are in your wallet. Nothing is at risk. They said: ' + W.reason(e),
          });
          return;
        }
        if (e.foxyAtRisk.taken) {
          this.blockedCard('theyRefused', {
            tone: 'warn',
            title: 'THEY TOOK THE PAYMENT',
            reason: 'They said no, and your ecash has been redeemed all the same: ' + this.group(e.foxyAtRisk.sats) + ' sats. Its entry in your history says paid.',
            chip: 'Do not pay again. If they are sending it back, they will show you a code to scan. They said: ' + W.reason(e),
          });
          return;
        }
        this.blockedCard('theyRefused', {
          tone: 'warn',
          title: 'HIGH RISK',
          reason: 'They refused this payment and did not send it back locked to you. They have seen your ecash and can still redeem it. '
            + 'Do not pay again until you are online.',
          chip: this.group(e.foxyAtRisk.sats) + ' sats are in your wallet again, at risk until Foxy has a connection. They said: ' + W.reason(e),
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
        if (this._crossCameFrom) this.crossComeHome();
        /* Told to the other phone while the link is still there, so it does
         * not sit waiting for a payment that is not coming. It rides M10,
         * as the other things a payer says before the money do. */
        if (req && req.viaTap && W.tapQuote) {
          W.tapQuote(JSON.stringify({ gaveUp: String(W.reason(e) || 'The payment was not made.') })).catch(() => {});
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
        const movedTo = this._crossMovedTo;
        this._crossMovedTo = null;
        /* And home, whichever way it ended. It stayed at their mint "on
         * purpose" after a failure, showing a balance the person had never
         * seen at a mint they had not chosen; the card below says where the
         * sats are, and the mint list shows them. */
        if (this._crossCameFrom) this.crossComeHome();
        this.blockedCard('theyRefused', {
          tone: 'warn',
          title: 'THEY DID NOT TAKE IT',
          reason: W.reason(e),
          /* True of plain ecash, and not of ecash locked to them: nothing
           * this phone holds opens that, so "still yours" promised a way
           * back that does not exist. It is theirs to take, and the token
           * is how they take it. */
          chip: made.lockedTo
            ? 'HIGH RISK: these ' + this.group(made.sats) + ' sats are locked to them, so only they can take them and you cannot take them back. Show them the token to finish.'
            : (e.foxyAtRisk && e.foxyAtRisk.onEntry)
            ? 'HIGH RISK: they have seen these ' + this.group(made.sats) + ' sats and can still redeem them. Foxy takes them back when it has a connection.'
            : 'Your ' + this.group(made.sats) + ' sats are still yours'
              + (movedTo ? ', and they are now at ' + (this.mintNameOf(movedTo)
                  || String(movedTo).replace(/^https?:\/\//, '')) + '.' : '.'),
          retry: 'SHOW THEM A TOKEN',
          go: () => this.setState({
            tokenCopied: false, tokenOut: made.token, tokenOutSats: made.sats,
            tokenOutHash: made.hash, tokenForPayee: true, screen: 'tokenOut', stack: [],
          }),
          shut: { label: 'CLOSE', tap: () => this.setState({ screen: 'home', stack: [] }) },
        });
        return;
      }
      // made but not delivered: the token screen, to show them instead
      try { if (W.tag) W.tag(made.hash, { inflight: false }); } catch (x) {}
      this._seenTx = this._seenTx || {};
      this._seenTx[made.hash] = true;
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
      this.toast('It did not reach them (' + W.reason(e) + '). Show them this token instead.', true);
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
  crossComeHome() {
    const W = window.FoxyWallet;
    const back = this._crossCameFrom;
    this._crossCameFrom = null;
    if (!back || !W || String(W.mintUrl || '').replace(/\/+$/, '') === back) return;
    console.log('[foxy] back to ' + back + ', the mint this phone was on before the crossing');
    W.connect(back).then(() => { this.refreshBalance(); this.loadHistory(); },
                         () => {});
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
    /* Over-paid, so the receiver owes change back over this link. It has to
     * swap at the mint to make it, which takes seconds — and the payer was
     * letting the link go the moment the person got back to home, one second
     * before the change was ready. */
    if (r && Number(r.over) > 0) this.expectChange(Number(r.over), r.hash);
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
    if (confirmed || (r && r.lockedTo)) {
      W.settleTx(r.hash);
      if (W.forgetClaimedToken) W.forgetClaimedToken(r.hash);
      if (W.lastTokenHash && W.lastTokenHash() === r.hash) W.clearLastToken();
      if (!confirmed) {
        console.log('[foxy] a locked payment was handed over and nobody confirmed it;'
          + ' settled anyway, because it is not this phone\u2019s to take back');
      }
    } else {
      this.watchToken(r.sats, r.hash, false);
    }
    this.refreshBalance();
    this.loadHistory();
    this.tidyChangeLater();
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
  newMintKeep() {
    const W = window.FoxyWallet;
    const info = this.state.nmInfo;
    if (!info || this.state.nmBusy) return;
    // claiming at the token's mint switches there
    if (this.refuseSwitchWhileBusy()) return;
    const name = this.mintNameOf(info.mint);
    /* Kept at its own mint, and the wallet back on yours afterwards: keeping a
     * token there is not choosing that mint to use. */
    const home = String(W.mintUrl || '');
    this.setState({ nmBusy: true, nmErr: '', nmStage: 'Keeping it at ' + name + '\u2026' });
    this.showMelt('Keeping it at ' + name + '\u2026');
    W.receiveToken(this.state.nmToken).then(r => {
      const back = (r.switched && home) ? W.connect(home).then(() => true, () => false) : Promise.resolve(false);
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
    this.announcePayment({ dir: 'in', sats: r.sats, force: true, to: 'ecash',
                           hash: r.hash || ('kept-' + Date.now()) });
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
    if (!r || !r.unit || r.unit === 'sat') return;
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
    if (!this.movingUp('VERIFYING ECASH', info.mint)) {
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
      this.movingDown();
      this.setState({ nmPlan: plan, nmStage: '' });
    }).catch(e => {
      this.movingDown();
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
    if (!this.movingUp('MOVING ECASH TO YOUR MINT', this.state.nmInfo && this.state.nmInfo.mint)) {
      this.showMelt('Moving to your mint\u2026');
    }
    this._quiet = true;
    this._hushUntil = Date.now() + 120000;
    this.expectOwnSpend();
    // what history holds before any of this, so the entries the sweep creates
    // can be marked as already seen rather than announced one by one later
    W.transactions(50).then(list => {
      this._sweepBefore = new Set(list.map(x => x.hash));
    }).catch(() => { this._sweepBefore = null; });

    W.receiveToken(this.state.nmToken).then(r => {
      return W.moveRun(plan, () => {}).then(done => this.hushSweepEntries().then(() => done)).then(done => {
        /* The move's own history entries are marked seen, and taken out of the
         * confirmation queue, before anything reloads history. walletReady ran
         * first, queued the claim at this mint as a payment received, and it
         * showed as a second confirmation when the move's own was dismissed. */
        this.movingDown();
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
        this.movingDown();
        this._quiet = false;
        this.setState({
          nmBusy: false, nmStage: '',
          nmErr: W.reason(e) + ' The sats are safe at ' + r.host + '.',
        });
        this.walletReady({ name: r.host });
      });
    }).catch(e => {
      this.movingDown();
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
    return W.transactions(50).then(list => {
      this._seenTx = this._seenTx || {};
      let n = 0;
      const mine = {};
      list.forEach(x => {
        if (before && before.has(x.hash)) return;
        this._seenTx[x.hash] = true;
        mine[x.hash] = true;
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
    this.expectOwnSpend();
    // one extra pass only: the second move leaves its own change, and chasing
    // that forever would spend more on quotes than it recovers
    if (this._chasingChange) { return; }
    /* Collecting the change connects to the source mint. If a payment started
     * while the first move ran, that switch would pull it onto the wrong mint,
     * so the change stays where it is — still spendable there — and the
     * confirmation reports what landed. Checked before this pass marks itself
     * busy, or it would always refuse. */
    if (this.moneyBusy()) {
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
    this.showMelt('Moving to your mint\u2026');
    this._quiet = true;

    const done = (extra, note) => {
      this.hideMelt();
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
      .then(plan => W.connect(from).then(() => W.moveRun(plan, () => {})))
      .then(r => this.hushSweepEntries()
        .then(() => done(r.sats, 'moved ' + r.sats + ', ' + (r.leftBehind || 0) + ' still left')))
      .catch(e => {
        // the quote refused, which means the fee is more than the change
        // no banner: dust staying put is not news, and the log has it
        console.log('[foxy] change left where it is:', (e && e.message) || e);
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
        if (r.switched) this.toast('Now on ' + r.host);
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
        // no banner: the pill counting up is the confirmation. A switched mint
        // is worth saying out loud, though — the wallet moved under them.
        if (r.switched) this.toast('Now on ' + r.host);
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
      this.walletReady({ name: r.host });
      this.toast('Took back ' + this.group(r.sats) + ' sats');
      this.loadHistory();
    }).catch(e => {
      this.hideMelt();
      this.setState({ txReclaiming: false });
      this.toast(W.reason(e), true);
    });
  }
