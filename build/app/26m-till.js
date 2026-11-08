  /* ---- the till: point of sale -----------------------------------------------
   *
   * A phone put into the till can only RECEIVE and look at the HISTORY of this session. Everything else (send, cards, the
   * menu, the balance, scan and paste on the amount screen, the home screen) is out of reach until the till is closed.
   *
   * Two roles, in `state.till` ({ role, since, pass } for a cashier, { role, since, unit, main, mint, mints } for a keeper: `mint`
   * the default of the mints the till takes, `unit` what it takes: 'sat', 'usd' or 'both', and `main` the one its QR invoice is
   * made in and a payment from a mint it does not take lands in), which the app does not save:
   *
   *   keeper   the phone whose money it is. It opens the till from SETTINGS > POINT OF SALE behind the lock it already has
   *            (Face ID or the PIN), and closes it behind the same lock, so a phone handed across a counter cannot be
   *            walked out of the till. It receives into its own wallet as ever. A relaunch ends it: the lock, then home.
   *   cashier  another Foxy, which scanned the keeper's CASHIER CODE. Every payment it takes is locked to the keeper's key
   *            and sent to the keeper over Nostr (the wallet's `tillJoin`, `tillOutboxAdd`, `tillDeliver`); this phone
   *            never holds it. Its own money is hidden and untouched. It leaves with no PIN, and by itself when the code
   *            runs out. Its till survives a relaunch, after the ordinary lock (`tillResume`).
   *
   * Every screen is one the app already has: SET AMOUNT, the receive screen, PAID, HISTORY, the cards, the PIN pad, the
   * stage screen that shows a code, and CURRENCY once, as the till opens, for the main currency of a till that takes both
   * (`tillAskMain`). The one rule that holds it together is that every road home ends at the till's SET AMOUNT instead
   * (`homeState`), and a home reached some other way is turned into it (`syncTill`). */

  // the screens a till has: its SET AMOUNT, the receive screen, PAID and HISTORY (`syncTill`)
  TILL_SCREENS = ['amount', 'confirm', 'paid', 'history'];

  /** 'keeper', 'cashier', or '' outside the till. */
  tillRole() {
    const t = this.state && this.state.till;
    return t && (t.role === 'keeper' || t.role === 'cashier') ? t.role : '';
  }

  /** The cashier's pass ({ id, mint, mints, unit, lock, to, exp }), or null for a keeper and outside the till. */
  tillPassNow() {
    const t = this.state && this.state.till;
    return (t && t.role === 'cashier' && t.pass) ? t.pass : null;
  }

  /* What a till takes: 'sat', 'usd' or 'both'. The keeper's is what it holds at the default mint, as it chose when it set
   * the wallet up (`tillUnitAt`); a cashier's is the code's, which carries the keeper's. '' outside the till. */
  tillTakes(till) {
    const t = till === undefined ? (this.state && this.state.till) : till;
    if (!t) return '';
    const u = t.role === 'cashier' ? (t.pass ? t.pass.unit : '') : t.unit;
    return u === 'usd' || u === 'sat' || u === 'both' ? u : '';
  }

  /* The till's one currency, where it takes one, which every receive is in and nothing asks about. '' outside the till, and
   * in a till that takes both, whose receives are in its main (`tillMain`) and take either. */
  tillUnit() {
    const u = this.tillTakes();
    return u === 'usd' || u === 'sat' ? u : '';
  }

  /* A till that takes dollars and bitcoin both. Nothing asks at a receive: the receive is in the till's main, and a tap is
   * offered a request in each, of which the payer pays the one it holds (12-receive.js, `tillTwinRequest`). */
  tillBoth() {
    return this.tillTakes() === 'both';
  }

  /* The currency a till's receives are in: its one, or in a till that takes both the main the keeper chose as it opened
   * (`tillAskMain`), which a cashier's code carries (a code from before it did is in sats). Its QR invoice is made in it, and
   * a payment from a mint the till does not take crosses into it. '' outside the till. */
  tillMain(till) {
    const t = till === undefined ? (this.state && this.state.till) : till;
    const takes = this.tillTakes(t);
    if (takes !== 'both') return takes;
    const m = t.role === 'cashier' ? (t.pass && t.pass.main) : t.main;
    return m === 'usd' ? 'usd' : 'sat';
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
   * `goReceive`). `till` is the till about to be, for the step that opens one; the one in state otherwise. Every receive is in
   * the till's main (`tillMain`), picked for it, so no question about this phone's own balances is put. The keypad starts in
   * dollars whatever the main is, with its swap to sats as ever: the price is what was typed. */
  homeState(till) {
    const t = till === undefined ? (this.state && this.state.till) : till;
    if (!t) return { screen: 'home', stack: [] };
    return {
      screen: 'amount', stack: [], flow: 'receive', amount: '', unit: 'USD',
      asset: '', network: '', note: '', noteDraft: '', recipient: '', recipientKind: '',
      wallet: this.tillMain(t), walletAuto: false, walletTapped: false,
      // and no tip: each sale starts without one (26p-till-tips.js)
      tillTip: null, tillTipOpen: false,
    };
  }

  /* The lock in front of opening the till, closing it and showing a cashier code: Face ID where FACE ID LOCK is on,
   * else the PIN pad, as the launch's lock asks (10-pin.js, `pinLock`). A phone with no lock is told to set one first: a till
   * anybody can close is a phone anybody can walk off into SEND with. `why` is the pad's line under its title. The card
   * sets one there: CREATE PIN is SET PIN's set-up and USE FACE ID is FACE ID LOCK's (10-pin.js, `pinSetup`,
   * `chooseProtection`), and a lock set through either goes straight on to what it stood in front of (POS mode, from the
   * menu's POINT OF SALE), the lock just set being the person's own proof. Given up, nothing opens. */
  tillGate(then, why) {
    const W = window.FoxyWallet;
    const go = typeof then === 'function' ? then : () => {};
    const pinSet = !!(W && W.pinIsSet && W.pinIsSet());
    const face = !!(W && W.faceLock && W.faceLock() && W.biometric);
    if (!W || !W.screenLocked || !W.screenLocked() || (!pinSet && !face)) {
      // a lock being set here ends at the till, or at home where it is given up: not the menu again
      const setting = () => { if (this.menuReturnDrop) this.menuReturnDrop(); };
      const pills = [];
      if (W && W.setSeedProtection) {
        pills.push({ label: 'USE FACE ID', tap: () => {
          setting();
          this.chooseProtection('device', (done) => { if (done) go(); });
        } });
      }
      this.blockedCard('tillNoLock', Object.assign({
        tone: 'warn', title: 'SET A LOCK FIRST',
        reason: 'The till opens and closes behind Face ID or a PIN, so a phone handed to someone else cannot leave it.',
        pills: pills, pillsFirst: true,
        shut: { label: 'CANCEL' },
      }, W && W.pinSet ? {
        retry: 'CREATE PIN',
        go: () => {
          setting();
          this.pinSetup((done) => { if (done && W.pinIsSet && W.pinIsSet()) go(); });
        },
      } : {}));
      return;
    }
    // given up from the menu's POINT OF SALE: the menu again (01-ui-basics.js `menuReturnSettle`)
    return this.lockAsk(go, why, () => { if (this.menuReturnSettle) this.menuReturnSettle(); });
  }

  /* The lock asked in front of one step (`tillGate`, and adding a mint, 09-melt-paste-switch.js `mintGate`): Face ID where FACE
   * ID LOCK is on, else the PIN pad, as the launch's lock asks (10-pin.js, `pinLock`). `go` runs once it is passed; `cancelled`
   * when the pad is given up. The caller has checked there is a lock. */
  lockAsk(go, why, cancelled) {
    const W = window.FoxyWallet;
    const pinSet = !!(W && W.pinIsSet && W.pinIsSet());
    const face = !!(W && W.faceLock && W.faceLock() && W.biometric);
    const pad = () => {
      if (!pinSet) return;
      this.pinOverlay({
        title: 'ENTER YOUR PIN',
        subtitle: why || 'To go on.',
        cta: 'CONTINUE',
        onCancel: () => { if (cancelled) cancelled(); },
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
     * let through, which is no worse than the phone itself (`pinLock`). With a PIN, a face that will not scan falls to it.
     * The answer's promise is handed back: the menu's POINT OF SALE waits on it (21-render-values.js, `shut`). */
    return Promise.resolve(W.biometric(String(why || 'Foxy').replace(/\.$/, ''), !pinSet)).then((answer) => {
      if (answer === 'yes' || (answer === 'unavailable' && !pinSet)) {
        if (answer === 'yes' && W.pinTriesClear) W.pinTriesClear();
        go();
        return;
      }
      pad();
    }, () => pad());
  }

  /* POINT OF SALE, past the lock: which mints the till takes, where this phone uses more than one (the SWITCH MINT list, asked
   * as `tillPick` 'set': tick every mint, NEXT), then the default among them (`tillPick` 'default'), then the till. The till
   * takes what the keeper said it holds when it set the wallet up, at the default (`tillUnitAt`); where that is both, one
   * question more, DEFAULT CURRENCY (`tillAskMain`): the one the QR invoice is made in and a payment from a mint the till does
   * not take lands in. A payment at a mint of the set stays at that mint; one from any other crosses into the default, the
   * payer paying the crossing, which is the payer's own screen's to show. One set, one default, one currency or both, and
   * one main, for the whole session: the cashier code carries them all. */
  tillOpen() {
    const W = window.FoxyWallet;
    const mints = this.tillMints();
    if (mints.length > 1) {
      // the mint this phone is on ticked at first: a till at one mint is still one tap away
      this.goSwitchMint({ tillPick: 'set', tillSet: mints.filter((m) => this.onMint(m.url)).map((m) => m.url) });
      return;
    }
    const one = mints.length ? mints[0].url : ((W && W.mintUrl) || this.mintHost() || '');
    this.tillAtMints([one], one);
  }

  /* The mints a till could take: the ones this phone uses (the wallet's list, the shipped list left out unless money is at one)
   * and the one it is on, as SWITCH MINT shows them (06-wallet-boot-and-restore.js `allMints`). */
  tillMints() {
    const W = window.FoxyWallet;
    let used = [];
    try { used = (W && W.mints) ? W.mints() : []; } catch (e) { used = []; }
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const usedSet = {};
    (Array.isArray(used) ? used : []).forEach((u) => { usedSet[strip(u)] = true; });
    const all = this.allMints ? this.allMints() : [];
    return all.filter((m) => this.onMint(m.url) || usedSet[strip(m.url)] || this.mintPile(m.url).sats > 0 || (this.mintPile(m.url).units || []).length > 0);
  }

  // whether `url` is ticked on the set list (compared without the scheme or a trailing slash, as `onMint` compares)
  tillTicked(url) {
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return ((this.state && this.state.tillSet) || []).some((u) => strip(u) === strip(url));
  }

  // the ticked mints, in the list's own order (the one this phone is on first)
  tillSetNow() {
    return this.tillMints().filter((m) => this.tillTicked(m.url)).map((m) => m.url);
  }

  // a row of the set list tapped: ticked, or not
  tillSetToggle(url) {
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.setState((p) => {
      const set = p.tillSet || [];
      const had = set.some((u) => strip(u) === strip(url));
      return { tillSet: had ? set.filter((u) => strip(u) !== strip(url)) : set.concat([url]) };
    });
  }

  /* NEXT under the set list: grey, and nothing, with none ticked; with one, that one is the default and nothing is asked;
   * with more, DEFAULT MINT asks which, on the same list. */
  tillSetNext() {
    const set = this.tillSetNow();
    if (!set.length) return;
    if (set.length === 1) { this.tillMintPick(set[0]); return; }
    this.setState({ tillPick: 'default' });
  }

  // the default picked (or the one mint ticked): off the list, and on to the till at the ticked set
  tillMintPick(url) {
    const set = this.tillSetNow();
    this.setState((p) => ({ screen: (p.stack || []).length ? p.stack[p.stack.length - 1] : 'home', stack: (p.stack || []).slice(0, -1), tillPick: false, tillSet: [] }));
    this.tillAtMints(set.length ? set : [url], url);
  }

  /* The till at the mints in `set`, `def` the default among them: the wallet told of the set (`tillKeeperOpen`, which checks
   * every mint takes a lock and visits the default where it is not the mint this phone is on, keeping the way home), then
   * the till, in what the keeper holds at the default (`tillUnitAt`). An opening that fails opens no till. A till at the one mint this phone is on is told to the
   * wallet too, with nothing on screen while it is: the wallet's record of the till is what a cashier code reads its mints
   * from, and one left by an earlier till (an app killed in it) handed this till's cashiers that till's mints
   * (review, stale-keeper). */
  tillAtMints(set, def) {
    const W = window.FoxyWallet;
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const list = (set || []).filter((u, i, a) => !!u && a.findIndex((x) => strip(x) === strip(u)) === i);
    if (!list.some((u) => strip(u) === strip(def))) list.unshift(def);
    // the default first, which is the order every request names them in (`tillMintsNow`)
    const ordered = [def].concat(list.filter((u) => strip(u) !== strip(def)));
    const away = !this.onMint(def);
    if (!W || !W.tillKeeperOpen) {
      const unit = this.tillUnitAt(def);
      if (unit === 'both') { this.tillAskMain(def, ordered, false); return; }
      // and last, ACCEPT TIPS? (26p-till-tips.js)
      this.tillTipsThen({ unit: unit, mint: def, mints: ordered }, false);
      return;
    }
    // a payment or a claim under way finishes at the mint it started on (`refuseSwitchWhileBusy`)
    if (away && this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return;
    let cancelled = false;
    // nothing to wait on worth a screen at the one mint the phone is on
    const staged = away || list.length > 1;
    if (staged) {
      this.stageScreen('tillOpen', {
        art: '', title: 'POINT OF SALE', body: 'Opening the till at ' + this.mintNameOf(def), dots: true, button: 'CANCEL',
        go: () => { cancelled = true; },
      });
    }
    Promise.resolve(W.tillKeeperOpen(list, def)).then((r) => {
      if (staged) this.hideStage('tillOpen');
      const moved = away || !!(r && r.moved);
      if (cancelled) {
        Promise.resolve(W.tillKeeperClose ? W.tillKeeperClose() : null).then((b) => { if (moved || (b && b.moved)) this.walletReady({ name: this.mintHost() }); }, () => {});
        return;
      }
      if (moved) this.walletReady({ name: this.mintHost() });
      const unit = this.tillUnitAt(def);
      if (unit === 'both') { this.tillAskMain(def, ordered, moved); return; }
      this.tillTipsThen({ unit: unit, mint: def, mints: ordered }, moved);
    }, (e) => {
      if (staged) this.hideStage('tillOpen');
      if (cancelled) return;
      this.blockedCard('tillOpenFailed', { title: 'NO TILL', reason: (W.reason ? W.reason(e) : String((e && e.message) || e)), chip: 'This phone is where it was.' });
    });
  }

  /* What the till takes at its default mint, `def`: what the keeper chose to hold when it set the wallet up (`walletChoiceNow`),
   * of what that mint issues. Dollars for 'dollars', sats for 'bitcoin', and both for 'both' at a mint that issues both;
   * sats where nothing was chosen, or the mint issues one (dollars only at a mint that issued no sats). A choice the mint
   * cannot meet falls to what it does issue. The mint's own keys on file say what it issues, and the connected mint's flag
   * as well where the phone is on it: the keys were read a moment after a visit and said one unit, at a mint that issues
   * both. Never asked: the keeper said it once, at set-up. */
  tillUnitAt(def) {
    const W = window.FoxyWallet;
    let have = [];
    try { have = (W && W.mintUnits) ? W.mintUnits(def) : []; } catch (e) { have = []; }
    if (!Array.isArray(have)) have = [];
    const here = !!(this.onMint && this.onMint(def)) && !!(this.twoUnitsOn && this.twoUnitsOn());
    const usd = have.indexOf('usd') >= 0 || here;
    const sat = have.indexOf('sat') >= 0 || here || !have.length;
    if (!usd) return 'sat';
    if (!sat) return 'usd';
    const hold = this.walletChoiceNow ? this.walletChoiceNow().hold : '';
    return hold === 'dollars' ? 'usd' : hold === 'both' ? 'both' : 'sat';
  }

  /* DEFAULT CURRENCY, for a till that takes both (`tillUnitAt`): asked once, as it opens, after DEFAULT MINT, on the CURRENCY
   * screen the cards ask on (26f-flashcard.js, `fcPickUnit`), with what this phone holds of each at the default and nothing
   * greyed: either can be the main. The answer is the till's `main`; it takes both all the same. The wallet's visit to the
   * default is already made (`moved`), and stands while it is asked. */
  tillAskMain(def, mints, moved) {
    this._tillMainAsk = { def: def, moved: !!moved };
    this.fcPickUnit({
      question: 'WHICH DO YOU PREFER TO RECEIVE?',
      foot: 'The QR invoice is made in it, and a payment from a mint you did not pick lands in it. A tap pays in either.',
      bal: null, short: { usd: '', sat: '' }, why: '',
    }, (u) => {
      this._tillMainAsk = null;
      this.tillTipsThen({ unit: 'both', main: u === 'usd' ? 'usd' : 'sat', mint: def, mints: mints }, !!moved);
    });
  }

  /* The round back button while the till is being opened (01-ui-basics.js, `back`): off DEFAULT MINT, the set list again with
   * its ticks; off the set list, the list is left as any screen is; off DEFAULT CURRENCY, the opening stops: no till, the
   * wallet's record of it let go and the phone home from a visit to the default (`tillKeeperClose`), and the screen it was
   * opened from, as back off any question. True where it was handled here. */
  tillOpenBack() {
    const s = this.state || {};
    // the tips' lists and CASHIER CODES (26p-till-tips.js, `tillListBack`)
    if (this.tillListBack && this.tillListBack()) return true;
    // off ACCEPT TIPS?: the question walked away from (26p-till-tips.js, `tillTipsCancel`)
    if (s.screen === 'tillTips') { if (!(this.tillTipsCancel && this.tillTipsCancel())) this.setState((p) => ({ screen: (p.stack || []).length ? p.stack[p.stack.length - 1] : 'home', stack: (p.stack || []).slice(0, -1) })); return true; }
    // the tip's own SET AMOUNT: back to the receive screen, the tip as it was
    if (s.screen === 'amount' && s.flow === 'tillTip' && this.tillTipOtherSet) { this.tillTipOtherSet(null); return true; }
    if (s.screen === 'switchMint' && s.tillPick === 'default') { this.setState({ tillPick: 'set' }); return true; }
    if (s.screen === 'switchMint' && s.tillPick) { this.setState({ tillPick: false, tillSet: [] }); return false; }
    if (s.screen === 'currency' && s.currencyFlow === 'card' && this._tillMainAsk && !s.till) {
      const W = window.FoxyWallet;
      const was = this._tillMainAsk;
      this._tillMainAsk = null;
      this._fcUnitThen = null;
      this.setState({ currencyFlow: '', curCard: null, curBoth: false });
      console.log('[foxy] till: back off DEFAULT CURRENCY; no till');
      Promise.resolve(W && W.tillKeeperClose ? W.tillKeeperClose() : null)
        .then((b) => { if (was.moved || (b && b.moved)) this.walletReady({ name: this.mintHost() }); }, () => {});
      return false;
    }
    return false;
  }

  /* The till itself, on SET AMOUNT as home's RECEIVE opens it, in what it takes (`o.unit`: 'sat', 'usd' or 'both'), with its
   * main (`o.main`, for both: sats where none is named), at the mints chosen (`o.mints`, `o.mint` the default, where the phone
   * now is). A till opened with none named is at the mint the phone is on. */
  tillStart(o) {
    const W = window.FoxyWallet;
    const unit = o && (o.unit === 'usd' || o.unit === 'both') ? o.unit : 'sat';
    const main = unit === 'both' ? (o && o.main === 'usd' ? 'usd' : 'sat') : unit;
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const def = String((o && o.mint) || (W && W.mintUrl) || this.mintHost() || '');
    const named = (o && Array.isArray(o.mints)) ? o.mints.filter((u) => !!u) : [];
    const mints = [def].concat(named.filter((u, i) => strip(u) !== strip(def) && named.findIndex((x) => strip(x) === strip(u)) === i));
    // and its tips, as ACCEPT TIPS? was answered (26p-till-tips.js): { on, to, ids }, off where nothing was asked
    const tips = o && o.tips && o.tips.on ? o.tips : { on: false, to: 'self', ids: [] };
    const till = { role: 'keeper', since: Date.now(), unit: unit, main: main, mint: def, mints: mints, tips: tips };
    console.log('[foxy] till: opened on this phone, in ' + unit + (unit === 'both' ? ' (' + main + ' first)' : '') + ' at ' + strip(def)
      + (mints.length > 1 ? ' and ' + (mints.length - 1) + ' more mint' + (mints.length > 2 ? 's' : '') : ''));
    // the requests made before it are let go, so none from before is shown in the till (`forgetRequests`)
    if (this.forgetRequests) this.forgetRequests();
    this.setState(Object.assign({ till: till, open0: false }, this.homeState(till)));
    /* The rows at the till's mints are read once now and marked seen, not raised: a mint the phone had not been on this session
     * has a whole past that is not this session's (16-history-lists.js). */
    this._seenSeeded = false;
    this._seededFor = this.mintHost();
    this.loadHistory();
  }

  /* The mints a till's requests name, the default first: the keeper's set, or the one a cashier's code carries (a code from
   * before codes carried a set names its one mint). [] outside the till. */
  tillMintsNow() {
    const t = this.state && this.state.till;
    if (!t) return [];
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const src = t.role === 'cashier' ? (t.pass || null) : t.role === 'keeper' ? t : null;
    if (!src || !src.mint) return [];
    const list = (Array.isArray(src.mints) && src.mints.length ? src.mints : [src.mint]).filter((u) => !!u);
    return [String(src.mint)].concat(list.filter((u, i) => strip(u) !== strip(src.mint) && list.findIndex((x) => strip(x) === strip(u)) === i).map(String));
  }

  /* A line on the till's SET AMOUNT for a till at more than one mint: the default, which is where it is, and how many more it
   * takes. '' for a till at one mint, which says nothing as it never did. */
  tillWhereLine() {
    const m = this.tillMintsNow();
    if (m.length < 2) return '';
    const more = m.length - 1;
    return 'At ' + this.mintNameOf(m[0]) + ' and ' + more + ' more mint' + (more > 1 ? 's' : '');
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
    const wasKeeper = !!(this.state.till && this.state.till.role === 'keeper');
    if (this.state.till) console.log('[foxy] till: closed');
    // and a request locked to a keeper is never shown again once the till is closed (12-receive.js, `forgetRequests`)
    if (this.forgetRequests) this.forgetRequests();
    this.setState({ till: null, screen: 'home', stack: [], amount: '', flow: '', wallet: '', walletAuto: false, walletTapped: false });
    this.loadHistory();
    this.refreshBalance();
    // a keeper's till run at another of its mints: home to its own, said as a switch is said
    const W = window.FoxyWallet;
    if (wasKeeper && W && W.tillKeeperClose) {
      Promise.resolve(W.tillKeeperClose()).then((r) => { if (r && r.moved) this.walletReady({ name: this.mintHost() }); }, () => {});
    }
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
  /* `extra`: what the codes' list's ADD A CASHIER asks for (26p-till-tips.js `tillCodeAdd`): { fresh, tips, label }, so a code
   * is made beside those live, with tips of its own. */
  tillPassShow(extra) {
    const W = window.FoxyWallet;
    if (!W || !W.tillPassMake) { this.toast('This Foxy cannot make a cashier code.', true); return; }
    const run = (this._tillPassRun = (this._tillPassRun || 0) + 1);
    this.stageScreen('tillPass', {
      art: '', title: 'CASHIER CODE', body: 'Making the code', dots: true, button: 'CANCEL',
      go: () => { if (this._tillPassRun === run) this._tillPassRun = 0; },
    });
    /* In what the till takes where one is open ('sat', 'usd' or 'both': `s.till.unit`), at the till's mints, the default
     * first: the screen's own till, not whatever the wallet has on record. The wallet's own default otherwise. */
    const keeper = this.tillRole() === 'keeper';
    const unit = keeper ? this.tillTakes() : '';
    const mints = keeper ? this.tillMintsNow() : [];
    // (and a till in both, its main: the code carries it, so a cashier's QR invoice is in it too)
    const main = keeper && unit === 'both' ? this.tillMain() : '';
    const more = extra && typeof extra === 'object' ? extra : null;
    const ask = unit || mints.length || more ? Object.assign(unit ? { unit } : {}, main ? { main } : {}, mints.length ? { mints } : {}, more || {}) : undefined;
    Promise.resolve(W.tillPassMake(ask)).then((p) => {
      if (this._tillPassRun !== run) return;
      if (!p || !p.text) throw new Error('No code was made.');
      this.stageScreen('tillPass', {
        art: '', title: 'CASHIER CODE', qr: String(p.text),
        body: 'Scan with Foxy. Money they take is locked to this phone and sent here.'
          + (more && this.tillTipsWords ? '<br>' + this.tillTipsWords(more.tips) : '')
          + (p.exp ? '<br>Expires ' + this.tillExpiresText(p.exp) : ''),
        button: 'DONE',
      });
      // the codes' list, under it, has one more row (26p-till-tips.js)
      if (more) this.setState({ menuTick: (this.state.menuTick || 0) + 1 });
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
  tillJoinGo(pass, passed) {
    const W = window.FoxyWallet;
    if (!W || !W.tillJoin) { this.toast('This Foxy cannot work a till.', true); return; }
    // a payment or a claim under way finishes at the mint it started on (`refuseSwitchWhileBusy`)
    if (!this.onMint(pass.mint) && this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return;
    /* Working the till puts the keeper's mint on this phone's list: where it is new here, past this phone's own lock first
     * (09-melt-paste-switch.js `mintGate`). Given up, nothing is joined. */
    if (!passed && this.mintGate) { this.mintGate(pass.mint, () => this.tillJoinGo(pass, true), 'To work a till at a new mint.'); return; }
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
      this.setState(Object.assign({ till: till, open0: false }, this.homeState(till)));
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
      else if (this.tillAwayToken(text)) this.tillTakeAway(text);
      else this.takeTokenFromPaste(text);
      return true;
    }
    if (kind === 'till') { this.toast('Leave the till first.', true); return false; }
    this.toast('The till only receives. Ask them to pay this till’s code.', true);
    return false;
  }

  /* Whether a token scanned at a keeper's till is at another of the till's mints than the one the phone is on: taken
   * there, where it stays (`tillTakeAway`). It went to the paste's way in, which offered to switch the phone to that mint
   * or move the money to this one, when the till takes that mint as it stands (review). */
  tillAwayToken(text) {
    const W = window.FoxyWallet;
    if (this.tillRole() !== 'keeper' || !W || !W.tokenInfo) return false;
    let info = null;
    try { info = W.tokenInfo(text); } catch (e) { info = null; }
    if (!info || !info.mint) return false;
    const canon = (u) => (W.canonicalMint ? W.canonicalMint(u) : String(u || '').replace(/\/+$/, ''));
    const at = canon(info.mint);
    return at !== canon(W.mintUrl) && this.tillMintsNow().some((m) => canon(m) === at);
  }

  /* A token at another of the till's mints, taken there by the wallet without the phone moving (`receiveToken` with
   * `opts.away`), the money staying at that mint; the confirmation as a paste's. */
  tillTakeAway(text) {
    const W = window.FoxyWallet;
    this.takingToken(() => {
      this._preSettle = this.balNow();
      this.receivingUp('VERIFYING ECASH');
      return W.receiveToken(text, { away: true }).then((r) => {
        this.receivingDown();
        this.tookToken(r);
        this.announceTaken(r);
        this.keptOfflineSaid(r);
        this.settleAnimate('btc');
        this.noteReceived();
      }).catch((e) => {
        this.receivingDown();
        this.claimFailed(e, () => this.tillTakeAway(text));
      });
    });
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
      /* Short of its request: the running total so far against the price, so the cashier asks for the rest (the request
       * stays open, and the token that brings the total to the price closes it). */
      if (r && r.short && Number(r.asked) > 0) {
        const u = r.unit === 'usd' ? 'usd' : 'sat';
        this.toast(this.unitFigure(Number(r.soFar) || 0, u) + ' of ' + this.unitFigure(Number(r.asked), u) + ' so far');
      }
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
      this.setState(Object.assign({ open0: false }, this.homeState()));
      return;
    }
    // nor the menu, which is home's and has SEND, the cards and SETTINGS in it, whatever opened it
    if (s.open0) { this.setState({ open0: false }); return; }
    /* Nor any screen the till has none of: a card's (LOAD and SEND are on it), SEND's, the menu's. Whatever reached one, a road
     * this file has not heard of, it is the till's SET AMOUNT before the next frame (and SET AMOUNT only for a receive: a
     * card's amounts are typed on it too, 26f-flashcard.js `fcAmount`). A keeper's receive paid by a card at
     * another mint shows the charge first (26f-flashcard.js, `fcXmBegin`), and that is the one more a keeper's till has.
     * And in either role a card paying in its other currency (dollars for a bitcoin invoice) shows the total the holder
     * agrees to first (`fcOtherAgree`, `fcOuConfirm`): the payer pays the fee and sees it. Thrown out, no card could pay a
     * till across currencies (review, card-in-till); its TAP CARD and its back return to the till's receive screen. */
    // (and the till's own lists, CASHIER CODES among them, the tip's SET AMOUNT, and ACCEPT TIPS? while it asks: 26p-till-tips.js)
    const kept = (this.TILL_SCREENS.indexOf(s.screen) >= 0 && (s.screen !== 'amount' || s.flow === 'receive' || s.flow === 'tillTip'))
      || (s.screen === 'switchMint' && !!s.tillList) || (s.screen === 'tillTips' && !!this._tillTipsFlow);
    if (!kept && !(s.till.role === 'keeper' && s.screen === 'fcXmConfirm') && s.screen !== 'fcOuConfirm') {
      console.log('[foxy] till: ' + s.screen + ' is not a screen the till has; back to its SET AMOUNT');
      this.setState(this.homeState());
      return;
    }
    // a tip on the receive screen, and the keeper's PAID passing it on (26p-till-tips.js)
    if (this.tillTipSync) this.tillTipSync(prevState);
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
    /* A till at more than one mint: a row taken at a mint other than the default says which, after its time, since that
     * money stays at the mint it was taken at. */
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const tillMints = this.tillMintsNow ? this.tillMintsNow() : [];
    const where = (t) => (tillMints.length > 1 && t.mint && strip(t.mint) !== strip(tillMints[0]) ? ' \u00b7 ' + this.mintNameOf(t.mint) : '');
    const groups = (s.fresh ? [] : (s.history || [])).map((g) => ({
      label: g.label,
      /* (and on the keeper's, a tip passed on, "Tip to <name>", out: 26p-till-tips.js) */
      items: (g.items || []).filter((t) => t && (t.dir === 'in' || (!cashier && t.dir === 'out' && !!t.tillTipTo)) && !t.split && !t.changeRow
        && (Number(t.atMs) || 0) >= t0 && (!cashier || t.till)).map((t) => {
        const tipOut = t.dir === 'out';
        const waiting = cashier ? !t.tillSent : !!t.pending && !tipOut;
        // a sale's tip, said beside where it stands (`tillTipRowText`)
        const tipWords = this.tillTipRowText ? this.tillTipRowText(t) : '';
        const rail = cashier ? (t.tillSent ? 'SENT TO KEEPER' : 'SENDING…') : (t.pending && !tipOut ? 'Pending' : '');
        if (tipOut) {
          return {
            name: 'Tip to ' + t.tillTipTo, initial: String(t.tillTipTo || 'T').slice(0, 1).toUpperCase(),
            cardBg: 'var(--surface)', cardEdge: '1.5px', cardSpin: 'none', tileBg: 'rgba(var(--ink-rgb),.35)', stroke: 'rgba(var(--ink-rgb),.35)',
            amtColor: 'rgba(var(--ink-rgb),.7)',
            amtText: '−' + (t.unit ? this.unitMoney(t.amount, t.unit) : this.money(this.txTotalOut(t), this.txFiat(t, this.txTotalOut(t))).main),
            amtSub: t.unit ? this.unitLabel(t.unit) + ' ecash' : this.money(this.txTotalOut(t), this.txFiat(t, this.txTotalOut(t))).sub,
            balText: '', line2: t.time, line3: '', line2Color: 'rgba(var(--ink-rgb),.45)', line2Weight: '500', open: () => {},
          };
        }
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
          line2: rail || (t.time + where(t) + (tipWords ? ' · ' + tipWords : '')),
          line3: rail ? t.time + where(t) + (tipWords ? ' · ' + tipWords : '') : '',
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
      // a session is the till's own, at every mint it takes: no chevron to another mint's (26-render-history-and-contacts.js)
      histMintPick: false,
      histTitlePlain: true,
      histMintGo: none,
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
      histAuditTop: false,
      histAuditEnd: false,
      histAuditTitle: '',
      histAuditBody: '',
      histAuditAction: false,
      histAuditCta: '',
      histAuditGo: none,
      histAuditInk: 'var(--btc-ink)',
      histAuditEdge: 'rgba(var(--ink-rgb),.12)',
    };
  }
