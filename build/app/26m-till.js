  /* ---- the till: point of sale -----------------------------------------------
   *
   * A phone put into the till can only RECEIVE and look at the HISTORY of this session. Everything else (send, cards, the
   * menu, the balance, scan and paste on the amount screen, the home screen) is out of reach until the till is closed.
   *
   * Two roles, in `state.till` ({ role, since, pass }), which the app does not save:
   *
   *   keeper   the phone whose money it is. It opens the till from SETTINGS > POINT OF SALE behind the lock it already has
   *            (Face ID or the PIN), and closes it behind the same lock, so a phone handed across a counter cannot be
   *            walked out of the till. It receives into its own wallet as ever. A relaunch ends it: the lock, then home.
   *   cashier  another Foxy, which scanned the keeper's CASHIER CODE. Every payment it takes is locked to the keeper's key
   *            and sent to the keeper over Nostr (the wallet's `tillJoin`, `tillOutboxAdd`, `tillDeliver`); this phone
   *            never holds it. Its own money is hidden and untouched. It leaves with no PIN, and by itself when the code
   *            runs out. Its till survives a relaunch, after the ordinary lock (`tillResume`).
   *
   * Every screen is one the app already has: SET AMOUNT, the receive screen, PAID, HISTORY, the cards, the PIN pad and the
   * stage screen that shows a code. The one rule that holds it together is that every road home ends at the till's SET
   * AMOUNT instead (`homeState`), and a home reached some other way is turned into it (`syncTill`). */

  // the screens a till has: its SET AMOUNT, the receive screen, PAID and HISTORY (`syncTill`)
  TILL_SCREENS = ['amount', 'confirm', 'paid', 'history'];

  /** 'keeper', 'cashier', or '' outside the till. */
  tillRole() {
    const t = this.state && this.state.till;
    return t && (t.role === 'keeper' || t.role === 'cashier') ? t.role : '';
  }

  /** The cashier's pass ({ id, mint, unit, lock, to, exp }), or null for a keeper and outside the till. */
  tillPassNow() {
    const t = this.state && this.state.till;
    return (t && t.role === 'cashier' && t.pass) ? t.pass : null;
  }

  /* The cashier's unit, which every receive is asked in: the keeper's, written into the code. '' otherwise, so a keeper's
   * till asks which balance as home's RECEIVE does (`walletNow`). */
  tillUnit() {
    const p = this.tillPassNow();
    return p ? (p.unit === 'usd' ? 'usd' : 'sat') : '';
  }

  /* The lock every cashier payment goes to: the keeper's key, from the code. '' for a keeper and outside the till, where
   * a request takes its lock from this phone's own pool as ever. */
  tillLockFor() {
    const p = this.tillPassNow();
    return (p && /^0[23][0-9a-f]{64}$/.test(String(p.lock || ''))) ? String(p.lock) : '';
  }

  /* The till's SET AMOUNT with nothing above it: the till's home. What reads `screen === 'home'` as "idle" reads this too
   * (the tap's release, the edge swipe, the end of a receive, 19-update-keypad-balance.js). */
  tillIdle() {
    const s = this.state || {};
    return !!s.till && s.screen === 'amount' && s.flow === 'receive' && !((s.stack || []).length);
  }

  /* Where a road home ends: home, or in the till its SET AMOUNT, set up as home's RECEIVE sets it up (23-render-home-and-amount.js,
   * `goReceive`). `till` is the till about to be, for the step that opens one; the one in state otherwise. A cashier's
   * receive is in the keeper's unit, picked for it (`tillUnit`), so no question about this phone's own balances is put. */
  homeState(till) {
    const t = till === undefined ? (this.state && this.state.till) : till;
    if (!t) return { screen: 'home', stack: [] };
    const unit = (t.role === 'cashier' && t.pass) ? (t.pass.unit === 'usd' ? 'usd' : 'sat') : '';
    return {
      screen: 'amount', stack: [], flow: 'receive', amount: '', unit: 'USD',
      asset: '', network: '', note: '', noteDraft: '', recipient: '', recipientKind: '',
      wallet: unit, walletAuto: false, walletTapped: false,
    };
  }

  /* The lock in front of opening the till, closing it and showing a cashier code: Face ID where FACE / FINGER LOCK is on,
   * else the PIN pad, as the launch's lock asks (10-pin.js, `pinLock`). A phone with no lock is told to set one first: a till
   * anybody can close is a phone anybody can walk off into SEND with. `why` is the pad's line under its title. */
  tillGate(then, why) {
    const W = window.FoxyWallet;
    const go = typeof then === 'function' ? then : () => {};
    const pinSet = !!(W && W.pinIsSet && W.pinIsSet());
    const face = !!(W && W.faceLock && W.faceLock() && W.biometric);
    if (!W || !W.screenLocked || !W.screenLocked() || (!pinSet && !face)) {
      this.blockedCard('tillNoLock', {
        tone: 'warn', title: 'SET A LOCK FIRST',
        reason: 'The till opens and closes behind Face ID or a PIN, so a phone handed to someone else cannot leave it.',
        chip: 'SETTINGS > SET PIN or FACE / FINGER LOCK.',
      });
      return;
    }
    const pad = () => {
      if (!pinSet) return;
      this.pinOverlay({
        title: 'ENTER YOUR PIN',
        subtitle: why || 'To go on.',
        cta: 'CONTINUE',
        onCancel: () => {},
        onSubmit: (pin, warn) => {
          // the lock's own count of tries and its wait, as every PIN this app asks
          const r = this.pinTry(pin);
          if (!r.ok) { warn(r.message); return; }
          this.pinDismiss();
          go();
        },
      });
    };
    if (!face) { pad(); return; }
    /* With no PIN the phone's own passcode may stand in for the face, as at launch; and a phone that cannot check either is
     * let through, which is no worse than the phone itself (`pinLock`). With a PIN, a face that will not scan falls to it. */
    Promise.resolve(W.biometric(String(why || 'Foxy').replace(/\.$/, ''), !pinSet)).then((answer) => {
      if (answer === 'yes' || (answer === 'unavailable' && !pinSet)) {
        if (answer === 'yes' && W.pinTriesClear) W.pinTriesClear();
        go();
        return;
      }
      pad();
    }, () => pad());
  }

  // POINT OF SALE, past the lock: this phone's own till, on SET AMOUNT as home's RECEIVE opens it
  tillStart() {
    const till = { role: 'keeper', since: Date.now() };
    console.log('[foxy] till: opened on this phone');
    // the requests made before it are let go, so none from before is shown in the till (`forgetRequests`)
    if (this.forgetRequests) this.forgetRequests();
    this.setState(Object.assign({ till: till, open0: false, menuSettingsOpen: false }, this.homeState(till)));
  }

  /* The X on the till's SET AMOUNT. The keeper's is behind the lock; the cashier's asks only whether, since the money it
   * took is the keeper's and goes to them whether this phone stays or not. */
  tillClose() {
    const W = window.FoxyWallet;
    if (this.tillRole() === 'keeper') { this.tillGate(() => this.tillEnd(), 'To close the till.'); return; }
    if (this.tillRole() !== 'cashier') { this.tillEnd(); return; }
    this.blockedCard('tillLeave', {
      tone: 'ask', title: 'LEAVE THE TILL?',
      reason: 'Money already taken is still sent to the keeper.',
      retry: 'LEAVE',
      go: () => this.tillLeaveNow(''),
      shut: { label: 'BACK' },
    });
  }

  /* A cashier out of the till: the wallet lets the code go and goes back to this phone's own mint (`tillLeave`), keeping
   * what is still to be sent to the keeper, which goes out by itself. `said` is a word for the toast, or ''. */
  tillLeaveNow(said) {
    const W = window.FoxyWallet;
    // one leave at a time: the minute's clock and the end of a payment can both come to it (`tillRunOutGo`)
    if (this._tillLeaving) return this._tillLeaving;
    /* The mint the till was worked at, from the code, and not the one the wallet is on now: a code run out is noticed by the
     * wallet on its own clock too (`tillCashier`), which goes home before this runs, and a comparison with where it is now
     * said nothing had changed, so the cashier's home came back with no balance asked of its own mint (review, expiry). */
    const pass = this.tillPassNow();
    const was = String((pass && pass.mint) || (W && W.mintUrl) || '');
    const run = Promise.resolve(W && W.tillLeave ? W.tillLeave() : null).then(() => {
      this.tillEnd();
      if (said) this.toast(said);
      // back at this phone's own mint: what a switch says, as SWITCH says it (09-melt-paste-switch.js, `justSwitch`)
      if (W && was && !this.onMint(was)) this.walletReady({ name: this.mintHost() });
    }, (e) => {
      // out of the till all the same: the outbox stays with the wallet and goes out by itself
      console.warn('[foxy] till: leaving, the way back to this phone\u2019s mint failed:', (e && e.message) || e);
      this.tillEnd();
      // why it left comes first; the banner says the mint could not be reached
      this.toast(said || ((W && W.reason) ? W.reason(e) : 'Could not reach your mint.'), !said);
    });
    this._tillLeaving = run;
    const done = () => { if (this._tillLeaving === run) this._tillLeaving = null; };
    run.then(done, done);
    return run;
  }

  // out of the till, either role: home, with this phone's own balance and history again
  tillEnd() {
    clearInterval(this._tillTickT);
    this._tillTickT = null;
    clearTimeout(this._tillRunOutT);
    this._tillRunOutT = null;
    this._tillRunOut = false;
    this._tillRunOutSaid = false;
    if (this.state.till) console.log('[foxy] till: closed');
    // and a request locked to a keeper is never shown again once the till is closed (12-receive.js, `forgetRequests`)
    if (this.forgetRequests) this.forgetRequests();
    this.setState({ till: null, screen: 'home', stack: [], amount: '', flow: '', wallet: '', walletAuto: false, walletTapped: false });
    this.loadHistory();
    this.refreshBalance();
  }

  // when a cashier code runs out, in the words the clock on the phone would use: "Mon, 2:45 PM"
  tillExpiresText(exp) {
    const n = Number(exp) || 0;
    if (!n) return '';
    const d = new Date(n * (n > 1e11 ? 1 : 1000));
    let day = '';
    try { day = d.toLocaleDateString('en-US', { weekday: 'short' }); } catch (e) { day = ''; }
    return (day ? day + ', ' : '') + this.txClock(d);
  }

  /* CASHIER CODE, past the lock: a code for another Foxy to scan, made by the wallet (`tillPassMake`: a lock key from the seed,
   * a Nostr key the phone keeps in the Keychain, 72 hours). Shown on the stage screen that shows a code to be scanned, with
   * DONE, as the change card's code is (26e-loaders.js, `stageScreen`). */
  tillPassShow() {
    const W = window.FoxyWallet;
    if (!W || !W.tillPassMake) { this.toast('This Foxy cannot make a cashier code.', true); return; }
    const run = (this._tillPassRun = (this._tillPassRun || 0) + 1);
    this.stageScreen('tillPass', {
      art: '', title: 'CASHIER CODE', body: 'Making the code', dots: true, button: 'CANCEL',
      go: () => { if (this._tillPassRun === run) this._tillPassRun = 0; },
    });
    Promise.resolve(W.tillPassMake()).then((p) => {
      if (this._tillPassRun !== run) return;
      if (!p || !p.text) throw new Error('No code was made.');
      this.stageScreen('tillPass', {
        art: '', title: 'CASHIER CODE', qr: String(p.text),
        body: 'Scan with Foxy. Money they take is locked to this phone and sent here.'
          + (p.exp ? '<br>Expires ' + this.tillExpiresText(p.exp) : ''),
        button: 'DONE',
      });
    }).catch((e) => {
      if (this._tillPassRun !== run) return;
      this._tillPassRun = 0;
      this.hideStage('tillPass');
      this.blockedCard('tillPassFailed', {
        title: 'NO CASHIER CODE',
        reason: (W.reason ? W.reason(e) : String((e && e.message) || e)),
        chip: 'Nothing was made.',
      });
    });
  }

  /* A cashier code, scanned or pasted (`acceptTarget`): what it is, before anything changes. A code that has run out, or that
   * is not one, is said no to; so is this phone's own, which it cannot work for itself. */
  tillJoinAsk(text) {
    const W = window.FoxyWallet;
    const pass = (W && W.tillDecode) ? W.tillDecode(String(text || '')) : null;
    if (!pass) {
      this.blockedCard('tillBadCode', {
        tone: 'warn', title: 'THAT CODE WON’T WORK',
        // the wallet's own sentence for what is wrong with it (run out, or not one), where it has one (`tillProblem`)
        reason: (W && W.tillProblem && W.tillProblem(String(text || ''))) || 'This cashier code has run out, or it is not one Foxy can read.',
        chip: 'Ask for a new CASHIER CODE.',
      });
      return false;
    }
    let own = false;
    try { own = !!(W.tillPasses && (W.tillPasses() || []).some((p) => p && p.id === pass.id)); } catch (e) { own = false; }
    if (own) {
      this.blockedCard('tillOwnCode', {
        tone: 'warn', title: 'THIS PHONE’S OWN CODE',
        reason: 'A cashier code is for another phone to scan. To take payments on this one, open SETTINGS > POINT OF SALE.',
      });
      return false;
    }
    const host = String(pass.mint || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.blockedCard('tillJoin', {
      tone: 'ask', title: 'WORK THE TILL?',
      reason: host + '\nMoney you take is locked to the keeper and sent to them. This phone never holds it.'
        + '\nYour own money is hidden until you leave.',
      chip: 'Expires ' + this.tillExpiresText(pass.exp),
      retry: 'START',
      go: () => this.tillJoinGo(pass),
      shut: { label: 'BACK' },
    });
    return true;
  }

  /* START: onto the keeper's mint (the wallet remembers this phone's own to come back to), then the till. The connecting
   * screen is the one a payment's connection shows; a cancel there leaves the till again once the mint has answered. */
  tillJoinGo(pass) {
    const W = window.FoxyWallet;
    if (!W || !W.tillJoin) { this.toast('This Foxy cannot work a till.', true); return; }
    // a payment or a claim under way finishes at the mint it started on (`refuseSwitchWhileBusy`)
    if (!this.onMint(pass.mint) && this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return;
    let cancelled = false;
    this.stageScreen('tillJoin', {
      art: '', title: 'CONNECTING', body: String(pass.mint || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      dots: true, button: 'CANCEL', go: () => { cancelled = true; },
    });
    Promise.resolve(W.tillJoin(pass)).then((joined) => {
      this.hideStage('tillJoin');
      if (cancelled) {
        console.log('[foxy] till: cancelled while connecting; leaving again');
        return Promise.resolve(W.tillLeave ? W.tillLeave() : null).then(() => this.refreshBalance(), () => {});
      }
      // the wallet's answer, { pass, since }: the session is from when it was joined
      const till = { role: 'cashier', since: Number(joined && joined.since) || Date.now(), pass: (joined && joined.pass) || pass };
      console.log('[foxy] till: working the till for a keeper at ' + String(pass.mint).replace(/^https?:\/\//, ''));
      // a request this phone made for itself is never shown in the till (12-receive.js, `forgetRequests`)
      if (this.forgetRequests) this.forgetRequests();
      // (its outbox and inbox are the wallet's to ask at the connect: 08d-till.js)
      this.setState(Object.assign({ till: till, open0: false, menuSettingsOpen: false }, this.homeState(till)));
      this.loadHistory();
      return null;
    }).catch((e) => {
      this.hideStage('tillJoin');
      console.warn('[foxy] till: could not join:', (e && e.message) || e);
      // nothing half done: the wallet's row goes, and this phone is where it was
      if (W.tillLeave) Promise.resolve(W.tillLeave()).catch(() => {});
      if (!cancelled) this.toast(W.reason ? W.reason(e) : 'Could not reach that mint.', true);
    });
  }

  /* Once a minute while this phone is a cashier: a code that has run out takes it out of the till, with a word. The wallet
   * answers null once `exp` has passed, and leaves for this phone's own mint itself (`tillCashier`). One timer, which
   * `syncTill` starts and stops with the role, so none outlives the till.
   *
   * Not in the middle of a payment (`tillMidPayment`): the receive screen up, PAID, a token being taken. Then the code's own
   * date decides, and the wallet is not asked, since its asking is itself what takes the phone home, and a payer half way
   * through paying would find the till gone under them. The leave waits for the screen to be left (`syncTill`). */
  tillTick() {
    const W = window.FoxyWallet;
    if (this.tillRole() !== 'cashier') { clearInterval(this._tillTickT); this._tillTickT = null; return Promise.resolve(false); }
    const pass = this.tillPassNow();
    const ran = !!pass && Number(pass.exp) > 0 && Date.now() / 1000 >= Number(pass.exp);
    if (this._tillRunOut || (ran && this.tillMidPayment())) {
      this._tillRunOut = true;
      return this.tillRunOutGo();
    }
    let asked = null;
    try { asked = (W && W.tillCashier) ? W.tillCashier() : null; } catch (e) { asked = null; }
    return Promise.resolve(asked).then((row) => {
      if (row && !ran) return false;
      if (this.tillRole() !== 'cashier') return false;
      this._tillRunOut = true;
      return this.tillRunOutGo();
    }, () => false);
  }

  /* A payment under way on a cashier's phone: anything but the till's SET AMOUNT or its HISTORY with nothing up over it (a
   * stage screen such as PAYMENT RECEIVED, the wait over a token being taken), or the second between a pending receive's
   * DISMISS and its PAID (04-receive-dismissals.js, `dismissPending`, which says when that PAID is due). */
  tillMidPayment() {
    const s = this.state || {};
    const still = (this.tillIdle() || (s.screen === 'history' && !!s.till)) && !s.sendExit;
    if (!still) return true;
    if (Date.now() < (Number(this._paidDueAt) || 0)) return true;
    if (this.stageUp && this.stageUp()) return true;
    return !!document.getElementById('foxy-melt');
  }

  /* The code has run out: out of the till now, or, in the middle of a payment, as soon as it is over. Answers whether it left. */
  tillRunOutGo() {
    clearTimeout(this._tillRunOutT);
    this._tillRunOutT = null;
    if (this.tillRole() !== 'cashier') { this._tillRunOut = false; return Promise.resolve(false); }
    if (this.tillMidPayment()) {
      if (!this._tillRunOutSaid) {
        this._tillRunOutSaid = true;
        console.log('[foxy] till: the cashier code has run out; leaving once the payment on screen is over');
      }
      /* Looked at again a moment from now as well as at every render (`syncTill`): a PAID that is still to land, and a stage
       * screen going down, render nothing of their own to say they are over. */
      this._tillRunOutT = setTimeout(() => this.tillRunOutGo(), Math.max(1000, (Number(this._paidDueAt) || 0) - Date.now() + 50));
      return Promise.resolve(false);
    }
    this._tillRunOutSaid = false;
    console.log('[foxy] till: the cashier code has run out');
    return this.tillLeaveNow('The cashier code has expired').then(() => true);
  }

  /* At launch, past the lock: a cashier's till comes back, on the keeper's mint, until it runs out or is left. A keeper's
   * never does (it is not saved). */
  tillResume() {
    const W = window.FoxyWallet;
    if (!W || !W.tillCashier || this.state.till) return Promise.resolve(false);
    let asked = null;
    try { asked = W.tillCashier(); } catch (e) { asked = null; }
    return Promise.resolve(asked).then((row) => {
      const pass = row && row.pass;
      if (!pass || !pass.mint || this.state.till) return false;
      const enter = () => {
        const till = { role: 'cashier', since: Number(row.since) || Date.now(), pass: pass };
        console.log('[foxy] till: back in the till after a relaunch');
        if (this.forgetRequests) this.forgetRequests();
        this.setState(Object.assign({ till: till, open0: false }, this.homeState(till)));
        this.loadHistory();
        return true;
      };
      if (this.onMint(pass.mint)) return enter();
      return Promise.resolve(W.tillJoin ? W.tillJoin(pass) : null).then(enter, (e) => {
        console.warn('[foxy] till: could not get back to the keeper\u2019s mint:', (e && e.message) || e);
        return false;
      });
    }, () => false);
  }

  /* The till's two jobs with the network on every return to the foreground (12-receive.js, `inboxWake`): the keeper's inbox
   * for the codes it has out (`tillListen`), which the phone closed as Foxy went away, and whatever a cashier took that has
   * not reached its keeper yet (`tillDeliver`). The wallet asks both itself at every connect, and making a code opens its
   * inbox, so the return is the one moment left to this. */
  tillWake() {
    const W = window.FoxyWallet;
    if (!W) return;
    try { if (W.tillListen) Promise.resolve(W.tillListen()).catch(() => {}); } catch (e) {}
    try { if (W.tillDeliver) Promise.resolve(W.tillDeliver()).catch(() => {}); } catch (e) {}
  }

  /* What a scan or a paste is, in the till (`acceptTarget`): a token is taken (a cashier's to its keeper, `tillTokenIn`); a
   * cashier code is for outside the till; everything else is a way to pay, and the till does not pay. */
  tillAccept(text, kind) {
    if (kind === 'token') {
      if (this.tillRole() === 'cashier') this.tillTokenIn(text);
      else this.takeTokenFromPaste(text);
      return true;
    }
    if (kind === 'till') { this.toast('Leave the till first.', true); return false; }
    this.toast('The till only receives. Ask them to pay this till’s code.', true);
    return false;
  }

  /* A token taken at a cashier's till: never into this phone's pile. The wallet takes it only locked to the keeper's key,
   * signed by the mint and unspent, and sends it on (`tillTakeToken`); the confirmation is the history's, as a scanned
   * token's is (`announceTaken`). */
  tillTokenIn(text) {
    const W = window.FoxyWallet;
    if (!W || !W.tillTakeToken) { this.toast('This till cannot take a token.', true); return; }
    if (this.state.screen === 'confirm') this.closeReceive();
    this.showMelt('Receiving ecash…');
    Promise.resolve(W.tillTakeToken(String(text || '').trim())).then((r) => {
      this.hideMelt();
      this.announceTaken(r);
      this.loadHistory();
    }).catch((e) => {
      this.hideMelt();
      this.blockedCard('tillTokenRefused', {
        title: 'NOT TAKEN',
        reason: W.reason ? W.reason(e) : String((e && e.message) || e),
        chip: 'Nothing was taken.',
      });
    });
  }

  // SCAN on a cashier's receive screen: the camera, then the till's own way in for a token (`tillTokenIn`)
  tillScanToken() {
    const W = window.FoxyWallet;
    if (!W || !W.scan) return;
    Promise.resolve(W.scan('Scan an ecash token')).then((text) => {
      const t = String(text || '').trim();
      if (W.classify(t) !== 'token') { this.toast('That QR is not a Cashu token.', true); return; }
      this.tillTokenIn(t);
    }).catch(() => {});
  }

  /* After every render, while the till is open (19-update-keypad-balance.js, `componentDidUpdate`):
   *
   *   - home is never shown: a road home this file did not reach still says `screen: 'home'` (a card's CLOSE, a flow's own
   *     ending), and it is turned into the till's SET AMOUNT here, before the next frame;
   *   - the cashier's expiry clock runs, and only while it is a cashier (`tillTick`);
   *   - PAID on a cashier's phone says where the money went, which is to the keeper, not into a balance here. */
  syncTill(prevState) {
    const s = this.state || {};
    const cashier = !!s.till && s.till.role === 'cashier';
    if (cashier && !this._tillTickT) this._tillTickT = setInterval(() => this.tillTick(), 60000);
    if (!cashier && this._tillTickT) { clearInterval(this._tillTickT); this._tillTickT = null; }
    if (!s.till) return;
    if (s.screen === 'home') {
      console.log('[foxy] till: a way home ended at the till instead');
      this.setState(Object.assign({ open0: false, menuSettingsOpen: false }, this.homeState()));
      return;
    }
    // nor the menu, which is home's and has SEND, the cards and SETTINGS in it, whatever opened it
    if (s.open0) { this.setState({ open0: false, menuSettingsOpen: false }); return; }
    /* Nor any screen the till has none of: a card's (LOAD and SEND are on it), SEND's, the menu's. Whatever reached one, a road
     * this file has not heard of, it is the till's SET AMOUNT before the next frame (and SET AMOUNT only for a receive: a
     * card's amounts are typed on it too, 26f-flashcard.js `fcAmount`). A keeper's receive paid by a card at
     * another mint shows the charge first (26f-flashcard.js, `fcXmBegin`), and that is the one more a keeper's till has. */
    const kept = this.TILL_SCREENS.indexOf(s.screen) >= 0 && (s.screen !== 'amount' || s.flow === 'receive');
    if (!kept && !(s.till.role === 'keeper' && s.screen === 'fcXmConfirm')) {
      console.log('[foxy] till: ' + s.screen + ' is not a screen the till has; back to its SET AMOUNT');
      this.setState(this.homeState());
      return;
    }
    // a code that ran out in the middle of a payment: out of the till once it is over (`tillTick`)
    if (cashier && this._tillRunOut && !this._tillLeaving && !this.tillMidPayment()) this.tillRunOutGo();
    if (cashier && s.screen === 'paid' && !s.paidPlace && !s.payOut) {
      this.setState({ paidPlace: { label: 'SENT TO', to: 'THE KEEPER' } });
    }
  }

  /* HISTORY in the till: this session's money in, and nothing else. Rows from `since` on, received only; a cashier's only
   * the till's own (`till`), each saying whether it has reached the keeper yet. No running balance, no books, no tabs and
   * no filters, and a row opens nothing: its detail screen has COPY TOKEN, SHOW QR and REDEEM on it. Returns every key
   * `renderHistory` does, so the screen is the same screen. */
  /** @param {RenderContext} c */
  tillHistory(c) {
    const { s, sc } = c;
    const t0 = Number(s.till && s.till.since) || 0;
    const cashier = this.tillRole() === 'cashier';
    const ok = 'var(--ok)', amber = 'var(--btc-ink)';
    const groups = (s.fresh ? [] : (s.history || [])).map((g) => ({
      label: g.label,
      items: (g.items || []).filter((t) => t && t.dir === 'in' && !t.split && !t.changeRow
        && (Number(t.atMs) || 0) >= t0 && (!cashier || t.till)).map((t) => {
        const waiting = cashier ? !t.tillSent : !!t.pending;
        const rail = cashier ? (t.tillSent ? 'SENT TO KEEPER' : 'SENDING…') : (t.pending ? 'Pending' : '');
        return {
          name: (t.note && String(t.note).trim()) || t.name || 'Received',
          initial: String(t.name || 'R').slice(0, 1).toUpperCase(),
          cardBg: 'var(--surface)', cardEdge: '1.5px', cardSpin: 'none',
          tileBg: waiting ? amber : ok,
          stroke: waiting ? amber : 'rgba(var(--ok-rgb),.7)',
          amtColor: 'var(--ok-ink)',
          amtText: '+' + (t.unit ? this.unitMoney(t.amount, t.unit)
            : this.money(this.txTotalOut(t), this.txFiat(t, this.txTotalOut(t))).main),
          amtSub: t.unit ? this.unitLabel(t.unit) + ' ecash' : this.money(this.txTotalOut(t), this.txFiat(t, this.txTotalOut(t))).sub,
          balText: '',
          line2: rail || t.time,
          line3: rail ? t.time : '',
          line2Color: rail ? (waiting ? amber : 'rgba(var(--ink-rgb),.5)') : 'rgba(var(--ink-rgb),.45)',
          line2Weight: rail ? '600' : '500',
          open: () => {},
        };
      }),
    })).filter((g) => g.items.length);
    const none = () => {};
    return {
      historyEmptySub: 'Payments taken in this session show up here.',
      isHistory: sc === 'history',
      histTitle: 'THIS SESSION',
      histClearVis: 'hidden',
      historyMint: (window.FoxyWallet && window.FoxyWallet.mintHost && window.FoxyWallet.mintHost()) || 'MINT',
      goSwitchFromHistory: none,
      histScrollRef: this._refHist || (this._refHist = (el) => this.histRef(el)),
      goHistory: () => this.go('history'),
      histFilterShown: false,
      fAllBg: 'transparent', fAllFg: 'rgba(var(--ink-rgb),.5)',
      fInBg: 'transparent', fInFg: 'rgba(var(--ink-rgb),.5)',
      fOutBg: 'transparent', fOutFg: 'rgba(var(--ink-rgb),.5)',
      filterAll: none, filterIn: none, filterOut: none,
      historyGroups: groups,
      histTabsShown: false,
      histTabs: [],
      historyEmpty: groups.length === 0,
      histAuditShown: false,
      histAuditTitle: '',
      histAuditBody: '',
      histAuditAction: false,
      histAuditCta: '',
      histAuditGo: none,
      histAuditInk: 'var(--btc-ink)',
      histAuditEdge: 'rgba(var(--ink-rgb),.12)',
    };
  }
