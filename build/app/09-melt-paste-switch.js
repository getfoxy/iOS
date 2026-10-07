
  /* The melt animation, for the waits that are long enough to look broken.
   *
   * Claiming at an unfamiliar mint means loading its keysets and swapping,
   * which over Tor is several seconds of nothing. The clipboard read plus a
   * claim is shorter but still long enough to feel stuck.
   */
  /* How long the overlay stays up with nobody taking it down. Long enough for
   * the short waits; callers whose work can run longer pass their own. */
  MELT_PATIENCE_MS = 45000;

  /* `o.sats` and `o.mint` are the two figures on the bill, and `o.onCancel` is
   * the only thing that puts a CANCEL under it — a button that cannot stop what
   * it is over would be worse than none, and most of these waits are a swap the
   * mint has already begun. */
  showMelt(label, patience, o) {
    const opts = o || {};
    this.hideMelt();
    const W = window.FoxyWallet;
    const root = document.createElement('div');
    root.id = 'foxy-melt';
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483400;'
      + 'display:flex;flex-direction:column;animation:foxyIn .18s ease';

    /* The heading is the caller's own words, which are already what this wait
     * is. The export's dots animate under it and say "still going", so the
     * ellipsis those words end with is dropped rather than shown twice. */
    const title = String(label || 'Verifying ecash').replace(/[\u2026.]+\s*$/, '');
    const sats = Number(opts.sats) > 0 ? this.group(Math.round(opts.sats)) : '';
    const mintName = String(opts.mint || (this.mintNameOf && this.mintNameOf(W && W.mintUrl)) || '');
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    root.innerHTML = this.loaderVerifying()
      .replace('{{TITLE}}', esc(title))
      .replace('{{SATS}}', esc(sats))
      .replace('{{MINT}}', esc(mintName.toUpperCase()))
      .replace('{{CANCEL}}', '');

    /* The caption the old overlay carried, kept: `meltSays` writes to it while
     * a wait goes on, and several callers do. Under the dots, quiet. */
    const cap = document.createElement('div');
    cap.id = 'foxy-melt-label';
    cap.style.cssText = 'display:none';
    root.appendChild(cap);

    if (typeof opts.onCancel === 'function') {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:2;'
        + 'padding:0 24px calc(44px + env(safe-area-inset-bottom))';
      const b = document.createElement('div');
      b.style.cssText = 'width:100%;height:60px;border-radius:18px;'
        + 'border:2px solid rgba(19,51,60,.85);background:rgba(255,255,255,.35);'
        + "font-family:Sora,system-ui,sans-serif;font-weight:800;font-size:17px;"
        + 'letter-spacing:.08em;color:#13333C;display:flex;align-items:center;'
        + 'justify-content:center;cursor:pointer';
      b.textContent = 'CANCEL';
      b.addEventListener('click', () => { this.hideMelt(); opts.onCancel(); });
      wrap.appendChild(b);
      root.appendChild(wrap);
    }

    document.body.appendChild(root);
    this._meltEl = root;

    /* A loader that outlives its task is worse than none: it hides a working
     * screen. So the overlay comes off by itself and whatever is underneath
     * can be used.
     *
     * But a backstop shorter than the work it covers is its own bug: it takes
     * the overlay off in the MIDDLE of a payment, so the screen goes live
     * while sats are still moving, and the hideMelt that ends the payment
     * finds nothing to hide. Delivering to an onion address retries for 90
     * seconds (ONION_REACH_MS) inside a 130-second bridge call, and at a flat
     * 45 seconds that is exactly what happened on a device (four `onion post
     * failed`, and `melt overlay timed out` among them). So the caller says
     * how long its work can take, and 45 seconds is only the default for the
     * short ones. */
    clearTimeout(this._meltT);
    this._meltT = setTimeout(() => {
      if (document.getElementById('foxy-melt')) {
        console.warn('[foxy] melt overlay timed out after', Math.round((patience || this.MELT_PATIENCE_MS) / 1000) + 's');
        this.hideMelt();
      }
    }, patience || this.MELT_PATIENCE_MS);
  }

  /* A title and a line above the animation, without restarting it. */
  meltHeading(title, line) {
    const root = document.getElementById('foxy-melt');
    if (!root) return;
    let head = document.getElementById('foxy-melt-head');
    if (!head) {
      head = document.createElement('div');
      head.id = 'foxy-melt-head';
      head.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 30px 10px;'
        + 'text-align:center;font-family:SatSymbol,Sora,system-ui,sans-serif';
      const t = document.createElement('div');
      t.style.cssText = 'font-size:22px;font-weight:800;letter-spacing:-0.022em;color:#F5F1EC';
      const l = document.createElement('div');
      l.style.cssText = 'font-size:18px;font-weight:500;line-height:1.4;color:rgba(245,241,236,.62);'
        + 'max-width:320px;text-wrap:pretty';
      head.appendChild(t);
      head.appendChild(l);
      root.insertBefore(head, root.firstChild);
    }
    head.children[0].textContent = title || '';
    head.children[1].textContent = line || '';
  }

  /* Change the line without restarting the animation. */
  meltSays(label) {
    const cap = document.getElementById('foxy-melt-label');
    if (cap) {
      cap.textContent = label;
      cap.style.display = label ? '' : 'none';
    }
  }

  hideMelt() {
    clearTimeout(this._meltT);
    const old = document.getElementById('foxy-melt');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    this._meltEl = null;
  }

  /* Read a bearer token off the clipboard and take it.
   *
   * Only while the amount is empty — the token says what it is worth. If it
   * was issued by another mint the wallet connects there, because ecash is
   * only good at the mint that signed it, and the toast names the mint so
   * that is never a surprise.
   */
  /* One token claim at a time, however it was started.
   *
   * There are two doors to taking a pasted token — the PASTE button on the
   * amount screen, and a token recognised in whatever was pasted or scanned
   * somewhere else — and they guarded themselves separately or not at all.
   * The button held a flag for a flat 1.5 seconds; a claim is a swap over
   * Tor and takes 4 to 6. So the flag was long gone while the claim was
   * still running, and the other door had no flag in the first place.
   *
   * Both now take this, and it is held until the claim actually finishes
   * rather than until a timer says it probably has. That matters more than
   * it sounds: two claims of one token race at the mint, the loser is told
   * "already spent", and the person is looking at a wallet that says their
   * money was taken twice and arrived once.
   *
   * The backstop is only for a promise that never settles at all, and is set
   * far beyond any real claim so it can never fire during one. */
  TOKEN_CLAIM_MAX_MS = 90000;

  takingToken(run) {
    if (this._takingToken) {
      console.log('[foxy] a token is already being taken \u2014 ignored');
      return false;
    }
    this._takingToken = true;
    clearTimeout(this._takingT);
    this._takingT = setTimeout(() => {
      if (!this._takingToken) return;
      console.warn('[foxy] a token claim never finished \u2014 letting the next one through');
      this._takingToken = false;
    }, this.TOKEN_CLAIM_MAX_MS);
    const free = () => { clearTimeout(this._takingT); this._takingToken = false; };
    let out;
    try { out = run(); } catch (e) { free(); throw e; }
    if (out && typeof out.then === 'function') out.then(free, free);
    else free();          // it decided not to claim anything after all
    return true;
  }

  pasteEcashToken() {
    const W = window.FoxyWallet;
    // one at a time, and only from the screen that offers it — a share sheet
    // closing was enough to fire this a second time
    console.log('[foxy] paste ecash tapped | screen', this.state.screen,
                '| amount', JSON.stringify(this.state.amount || ''));
    if (this.state.screen !== 'amount') {
      console.log('[foxy] paste ignored: not on the amount screen');
      return;
    }
    if (parseFloat(this.state.amount) > 0) {
      console.log('[foxy] paste ignored: an amount is entered');
      this.toast('Clear the amount first \u2014 a token carries its own', true);
      return;
    }
    if (!W || !W.clipboard) return;
    this.takingToken(() => {
    this.showMelt('Reading the clipboard\u2026');
    return W.clipboard().then(text => {
      const t = String(text || '').trim();
      console.log('[foxy] clipboard:', t.length, 'chars, starts',
                  JSON.stringify(t.slice(0, 24)), '| classify', W.classify(t));
      if (!t) { this.toast('Nothing on the clipboard.', true); return; }
      if (W.classify(t) !== 'token') {
        this.hideMelt();
        console.log('[foxy] clipboard rejected:', t.length, 'chars, starts',
                    JSON.stringify(t.slice(0, 24)));
        this.toast('That is not a Cashu token.', true);
        return;
      }
      if (this.offerNewMint(t)) return;
      if (this.tokenSwitchRefused(t)) { this.hideMelt(); return; }
      const info = W.tokenInfo(t);
      // the figure before the claim, for the count-up
      this._preSettle = this.balNow();
      if (info && info.mint) {
        console.log('[foxy] token for', info.unit && info.unit !== 'sat' ? this.unitMoney(info.amount, info.unit) : this.group(info.sats) + ' sats', 'from', info.mint);
      }
      return W.receiveToken(t).then(r => {
        this.hideMelt();
        this.walletReady({ name: r.host });
        this.tookToken(r);
        this.settleAnimate('btc');
        this.noteReceived();
        // no banner: the pill counting up is the confirmation. A switched mint
        // is worth saying out loud, though — the wallet moved under them.
        if (r.switched) this.toast('Now on ' + r.host);
      });
    }).catch(e => { this.hideMelt(); this.claimFailed(e, null); });
    });
  }

  /* What is filed under a mint, read straight from storage. No network: the
   * proofs are the balance, and they are already here. */
  mintPile(url) {
    let sats = 0;
    try {
      const raw = localStorage.getItem('foxy.cashu.proofs.' + url);
      sats = raw ? JSON.parse(raw).reduce((n, p) => n + Number(p.amount || 0), 0) : 0;
    } catch (e) {}
    // other units at this mint, each in its own: '1,200 sats + $1.23'
    const units = this.otherUnitsAt(url);
    const parts = (sats > 0 ? [this.group(sats) + ' sats'] : []).concat(units.map(b => this.unitMoney(b.amount, b.unit)));
    return {
      sats: sats,
      units: units,
      text: parts.join(' + '),
      ink: (sats > 0 || units.length) ? 'var(--acc-ink)' : 'rgba(var(--ink-rgb),.35)',
    };
  }

  /* Balances at a mint in units other than sats: [{ mint, unit, amount }].
   * Never added to a sat figure. Empty without a wallet (the static preview). */
  otherUnitsAt(url) {
    const W = window.FoxyWallet;
    if (!W || typeof W.balances !== 'function') return [];
    const strip = u => String(u || '').replace(/\/+$/, '');
    return W.balances().filter(b => b.unit !== 'sat' && strip(b.mint) === strip(url));
  }

  /* An amount in its own unit: '$1.23', '€0.50', '5 msat'. */
  unitMoney(amount, unit) {
    const W = window.FoxyWallet;
    if (W && W.formatAmount) return W.formatAmount(amount, unit);
    return String(amount) + ' ' + unit;
  }

  /* 'USD', 'EUR', or the unit's code in capitals. */
  unitLabel(unit) {
    const W = window.FoxyWallet;
    return (W && W.unitName) ? W.unitName(unit) : String(unit || '').toUpperCase();
  }

  /* A scan row's other units with something in them: [{ unit, amount }]. */
  rowUnits(row) {
    const u = (row && row.units) || {};
    return Object.keys(u).sort().filter(k => u[k] && u[k].amount > 0).map(k => ({ unit: k, amount: u[k].amount }));
  }

  /* A scan row's findings in every unit: '1,200 sats + $1.23'. */
  rowAmounts(row) {
    return (row && row.sats > 0 ? [this.group(row.sats) + ' sats'] : [])
      .concat(this.rowUnits(row).map(b => this.unitMoney(b.amount, b.unit))).join(' + ');
  }

  /* Every balance in a unit other than sats, anywhere, as one line:
   * 'Also $1.23 in USD ecash at mint.example.com.' Empty when there is none. */
  otherUnitsLine() {
    const W = window.FoxyWallet;
    if (!W || typeof W.balances !== 'function') return '';
    const list = W.balances().filter(b => b.unit !== 'sat');
    if (!list.length) return '';
    return 'Also ' + list.map(b => this.unitMoney(b.amount, b.unit) + ' in ' + this.unitLabel(b.unit)
      + ' ecash at ' + String(b.mint).replace(/^https?:\/\//, '')).join(', ') + '.';
  }

  /* Is money moving right now?
   *
   * The proof lock alone missed stages that run outside it: a Lightning
   * address being looked up before there is an invoice to pay, a send still
   * running after its screen stopped waiting, an invoice being watched (the
   * watch polls and claims at whichever mint is connected), a token being
   * claimed and moved home, and the change collected after that. Switching
   * mints during any of them pointed the rest of the operation at the wrong
   * mint. */
  moneyBusy() {
    const W = window.FoxyWallet;
    return !!((W && W.proofLockDepth && W.proofLockDepth() > 0)
      || this._sendRun || this._watching || this._chasingChange
      || this.state.nmBusy || this.state.reqBusy);
  }

  /* Every mint switch a person starts asks here first. The wallet's own
   * connects — at launch, or a move's second leg — do not: they are part of
   * the operation in progress, not a second one. */
  /* Money actually in flight, as against a screen doing its job.
   *
   * `moneyBusy` is the right question for a person switching mints by hand: a
   * receive screen watching for a payment, or a request being made, are both
   * reasons to make them wait. It is the wrong question for work that IS the
   * payment — carrying a cross-mint payment home runs on the receive screen,
   * with that screen watching, so asking `moneyBusy` refused every single
   * attempt: "This phone is busy moving money", five times in four minutes,
   * for money it was itself trying to move.
   *
   * What genuinely conflicts is a swap or a melt already under way, because
   * those hold the proof lock and a mint switch under them loses track of
   * which mint the money is at. */
  moneyMoving() {
    const W = window.FoxyWallet;
    return !!((W && W.proofLockDepth && W.proofLockDepth() > 0)
      || this._sendRun || this._chasingChange);
  }

  /* Which of them it was, for the diary. `moneyBusy` is six questions and the
   * refusal named none of them, so "a payment is in progress" could not be
   * told apart from an invoice nobody was looking at. */
  busyWhy() {
    const W = window.FoxyWallet;
    const why = [];
    const held = W && W.proofLockHolder && W.proofLockHolder();
    if (held) why.push('the proof lock, held by ' + held.what + ' for ' + Math.round(held.ms / 1000) + 's');
    else if (W && W.proofLockDepth && W.proofLockDepth() > 0) why.push('the proof lock');
    if (this._sendRun) why.push('a send is running');
    if (this._watching) why.push('an invoice is being watched');
    if (this._chasingChange) why.push('change is being chased');
    if (this.state.nmBusy) why.push('a new mint is being set up');
    if (this.state.reqBusy) why.push('a request is being paid');
    return why.join('; ') || 'nothing';
  }

  refuseSwitchWhileBusy() {
    /* An invoice nobody has paid is let go, not waited for.
     *
     * A watched invoice used to count as a payment in progress, and it is
     * not one: nothing has moved, and there is nothing to finish. It stopped
     * a person switching mints until they found their way back to the
     * invoice and closed it. The watch ends here. The invoice stays on file
     * with its key, and if somebody pays it after all, it is collected the
     * next time this phone is on that mint (the sweep). What still waits is
     * money that is really moving: a swap, a payment, a token being claimed. */
    if (this._watching || this._stopWatch) {
      console.log('[foxy] mint switch: an unpaid invoice is let go; it stays on file and is collected if it is paid');
      this._invoiceRun = (this._invoiceRun || 0) + 1;
      this.stopReceive();
    }
    if (!this.moneyBusy()) return false;
    console.log('[foxy] mint switch refused: a payment is in progress (' + this.busyWhy()
      + '), on ' + this.state.screen);
    this.toast('Wait for the payment to finish before switching mints.', true);
    return true;
  }

  /* Claiming a token from another mint switches the wallet there, so it waits
   * like any other switch. A token from this mint switches nothing and goes
   * through; the wallet queues it behind the proof lock. */
  tokenSwitchRefused(text) {
    const W = window.FoxyWallet;
    const info = (W && W.tokenInfo) ? W.tokenInfo(text) : null;
    const strip = u => String(u || '').replace(/\/+$/, '');
    if (!info || !info.mint || strip(info.mint) === strip(W.mintUrl)) return false;
    return this.refuseSwitchWhileBusy();
  }

  /* Point the wallet at another mint. Nothing moves — each mint's proofs stay
   * filed under it, so switching back brings that balance into view again. */
  justSwitch(url) {
    const W = window.FoxyWallet;
    const host = String(url).replace(/^https?:\/\//, '');
    if (this.state.switchBusy) return;
    // a payment or claim in progress finishes at the mint it started on
    if (this.refuseSwitchWhileBusy()) return;
    // Connecting takes a second or two over Tor, and until now the row gave no
    // sign it had been tapped at all.
    this.setState({ switchBusy: true, mintBusy: String(url).replace(/\/+$/, '') });
    const back = this.state.mintReturn;
    // asked before connecting, which adds it to the list
    const usedBefore = !!(W.mintUsedBefore && W.mintUsedBefore(url));
    W.connect(url).then(w => {
      this.setState({ switchBusy: false, mintBusy: '', mintReturn: '' });
      this.walletReady({ name: (w && w.name) || host });
      // came from history, so go back to it — now showing this mint
      if (back === 'history') {
        this.setState({ screen: 'history', stack: ['home'] });
        this.loadHistory();
      }
      this.toast('Now on ' + host);
      if (!usedBefore) this.sweepNewMint(url, host);
    }).catch(e => {
      this.setState({ switchBusy: false, mintBusy: '' });
      this.toast(W.reason(e), true);
    });
  }

  /* Nothing filed under this mint — so ask it what it has signed for our seed
   * before concluding the balance is zero. Runs after the switch rather than
   * blocking it: a restore is seconds of round trips, and the screen should
   * not wait on it. Anything found is merged, never overwritten.
   *
   * Only for a mint this device has never used (justSwitch asks). A restore
   * sends every output this seed ever had signed there, so the mint learns this
   * wallet's whole history with it; on a mint Foxy has used, and emptied, that
   * was handed over on every switch back. The RESTORE screen still scans any
   * mint the person picks (MINT-PRIVACY.md C9). */
  sweepNewMint(url, host) {
    const W = window.FoxyWallet;
    if (!W || !W.scanSeed) return;
    if (this.mintPile(url).sats > 0) return;       // already know this one
    if (this._sweeping === url) return;
    this._sweeping = url;

    console.log('[foxy] nothing filed for', host, '\u2014 checking the seed');
    // this wallet's own seed is scanned with no words: they stay on the phone
    W.scanSeed(null, [url]).then(rows => {
      this._sweeping = null;
      const row = (rows || [])[0];
      if (!row || row.state !== 'done' || !(row.sats > 0 || this.rowUnits(row).length > 0)) return;
      // adoptScan waits its turn in the proof lock, so the balance is read and
      // the find announced only once the proofs are actually filed
      return Promise.resolve(W.adoptScan([row], { merge: true })).then((res) => {
        /* What was added, not what the scan saw. A scan also sees proofs a
         * payment or a sent token holds; those are not filed, and a toast of
         * the scan's total announced them as found (audit finding W1). */
        const sats = ((res && res.kept) || []).reduce((n, k) => n + (k.added || 0), 0);
        const units = {};
        ((res && res.units) || []).forEach(u => { if (u.added > 0) units[u.unit] = { amount: u.added }; });
        if (!(sats > 0 || Object.keys(units).length)) {
          console.log('[foxy] nothing new at', host, 'under this seed');
          return;
        }
        console.log('[foxy] found', sats, 'sats at', host, 'under this seed');
        if (W.mintHost() === host) this.refreshBalance();
        this.toast('Found ' + this.rowAmounts({ sats, units }) + ' at ' + host);
      });
    }).catch(e => {
      this._sweeping = null;
      console.warn('[foxy] seed check at', host, 'failed:', (e && e.message) || e);
    });
  }

  /* Is this the mint we are on? Compared without the scheme or a trailing
   * slash, since the same mint gets written both ways. */
  onMint(url) {
    const strip = u => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return !!this.mintHost() && strip(url) === strip(this.mintHost());
  }

  /* Any mint that is not on the list. The scan is the same native one the
   * connect screen uses. */
  scanOtherMint() {
    const W = window.FoxyWallet;
    W.scan('Scan the mint address')
      .then(url => {
        // the same validation the typed path gets, before anything acts on it
        const u = String(url || '').trim();
        const bad = W.mintProblem && W.mintProblem(u);
        if (bad) { this.toast(bad, true); return; }
        this.justSwitch(u);
      })
      .catch(e => this.toast(W.reason(e), true));
  }

  /* Tell them who holds the bitcoin, once per mint.
   *
   * Cashu is custodial: the mint holds the sats and the wallet holds claims
   * on them. Nothing in this app said so, and a balance on screen looks the
   * same either way. Shown before any money exists, and remembered — this is
   * a thing to understand once, not a warning to dismiss daily. */
  /* Is the wallet pointed at a mint that issues worthless ecash? */
  onTestMint() {
    const host = (this.mintHost() || '').toLowerCase();
    return host.indexOf('testnut.cashu.space') >= 0;
  }

  custodyNotice() {
    const W = window.FoxyWallet;
    if (this.onTestMint()) {
      this.blockedCard('testmint', {
        tone: 'warn',
        title: 'THIS IS A TEST MINT',
        reason: 'Ecash from this mint is backed by nothing and is worth nothing. '
          + 'It exists so the app can be tested without spending real money. '
          + 'Do not send anything here expecting to get it back.',
      });
      return;
    }
    const host = this.mintName() || 'this mint';
    let told = {};
    try { told = JSON.parse(localStorage.getItem('foxy.custody.told') || '{}'); } catch (e) {}
    if (told[host]) return;
    told[host] = true;
    try { localStorage.setItem('foxy.custody.told', JSON.stringify(told)); } catch (e) {}

    this.blockedCard('custody', {
      tone: 'warn',
      title: 'THE MINT HOLDS YOUR BITCOIN',
      reason: 'Ecash in this wallet is issued by ' + host + '. You are trusting '
        + 'that mint to back it with bitcoin until you move your money to '
        + 'another bitcoin lightning wallet. If it goes offline or refuses to '
        + 'pay out, there is no one to appeal to. Hold only what you can '
        + 'afford to lose.',
    });
  }

  /* No passcode on the phone. The rule is Face ID, else the passcode, and
   * with neither Foxy goes ahead on its alerts and warns.
   * Shown at launch until turned off: with no passcode, anyone holding the phone
   * can open the seed screen, replace the seed or delete it. */
  passcodeNotice() {
    const W = window.FoxyWallet;
    if (!W || !W.phoneHasPasscode || W.phoneHasPasscode() !== false) return;
    try { if (localStorage.getItem('foxy.nopasscode.off') === '1') return; } catch (e) {}
    this.blockedCard('nopasscode', {
      tone: 'warn',
      title: 'THIS IPHONE HAS NO PASSCODE',
      reason: 'Anyone who picks up this iPhone can open Foxy, see your twelve words, and replace or '
        + 'delete them. Face ID or a passcode is what normally asks first, and this phone has neither.',
      chip: 'Set one in Settings, under Face ID & Passcode.',
      also: { label: 'DON\u2019T SHOW AGAIN', tap: () => { try { localStorage.setItem('foxy.nopasscode.off', '1'); } catch (e) {} } },
    });
  }

  walletReady(w) {
    this.setState({
      walletLive: true,
      walletSearching: false,
      walletErr: '',
      screen: 'home',
      stack: [],
    });
    /* The heartbeat first, before anything that can throw.
     *
     * This pair is how an arrival nobody watched for reaches the screen at
     * all, and it used to be armed on the last line of this method — behind
     * eight calls out to the wallet and the notices, any one of which throwing
     * would take the balance and history with it for the rest of the session,
     * on a mint switch as much as on a launch. Nothing re-armed it either: the
     * same shape as the on-chain watcher that stopped asking. Armed here it
     * does not depend on the rest of this method finishing. */
    clearInterval(this._refreshT);
    this._refreshT = setInterval(() => { this.refreshBalance(); this.loadHistory(); }, 15000);
    // The mount-time fetch runs before Tor is up and is refused. Now that
    // the gate is through, ask for the price line.
    this.loadSeries(this.state.range);
    /* Lock keys, made now where nothing stands in front of the seed. They
     * come from the seed, and were only asked for when a request was made —
     * too late for that request, which went out unlocked, and a payer sends
     * unlocked ecash to a request that names no lock ("arrived 5 pieces, 0
     * locked"). Not where the seed
     * is behind Face ID: reading it is a prompt, and a launch does not ask. */
    const W = window.FoxyWallet;
    if (W && W.seedProtection && W.primeLocks && !this._locksPrimed) {
      this._locksPrimed = true;
      W.seedProtection().then((m) => {
        if (m && m.mode === 'none') return W.primeLocks();
        this._locksPrimed = false;
        return null;
      }).catch(() => { this._locksPrimed = false; });
    }
    // and, the first time on any mint, say who is holding the money
    setTimeout(() => this.custodyNotice(), 900);
    // and, where there is no passcode, that nothing but an alert guards the seed
    setTimeout(() => this.passcodeNotice(), 1000);
    // the concentration nudge waits past those, for a later refresh
    this._readyAt = Date.now();
    // A mint switch that paid but died before claiming leaves the money at the
    // new mint. This is where it gets picked up.
    if (window.FoxyWallet && window.FoxyWallet.finishMove) {
      window.FoxyWallet.finishMove().then(sats => { if (sats) this.refreshBalance(); });
    }
    /* A token made but never marked as handed over is money sitting in a
     * string: said once for each such token. The mint is not asked whether it
     * was claimed. That question, from this wallet at every launch, told the
     * mint which wallet had sent what the receiver redeemed; it is asked only
     * while the token's screen is open. */
    const out = window.FoxyWallet.lastToken && window.FoxyWallet.lastToken();
    if (out && out.token && !out.reminded) {
      setTimeout(() => {
        if (window.FoxyWallet.noteTokenReminded) window.FoxyWallet.noteTokenReminded();
        this.toast('An ecash token you made for ' + this.group(out.sats) +
          ' sats may not have been claimed yet');
      }, 1500);
    }
    // what this mint does on chain, and anything waiting on a block (26b-onchain.js)
    this.onchainAsk();
    this.onchainWatchLater();
    this.resumeSplit();
    // tokens made to pay someone, still waiting to be redeemed
    this.claimWatchResume();
    // and small change on hand for the next token
    this.tidyChangeLater();
    // the first balance, which a launch waits on before showing this screen
    const balance = this.refreshBalance();
    this.loadHistory();
    this.listenWallet();
    // NOT checking the clipboard on launch: reading it makes iOS put up its
    // "allow paste?" prompt every time the app opens. The paste button uses
    // UIPasteControl, which needs no prompt, so paste stays one tap away.
    return balance;
  }

  /* The sats first, and the price when it comes.
   *
   * These used to be awaited together, and the launch waits on this — so the
   * screen stayed up for as long as a price fetch took. On a phone Tor was
   * back in about two seconds and the wait ran to ten, with "price source
   * failed … timed out" filling the gap (seen in a device log). The
   * balance is local and instant; the price is a network call over Tor, and
   * the launch waits for both (see below).
   *
   * whatever LNbits says, verbatim — never arithmetic on the old figure */
  /* While part of the balance is held for a swap that got no answer, the mint
   * is asked every three seconds what became of it. One
   * timer, started wherever the balance is read; it stops by itself when
   * nothing is held, and does nothing with Foxy out of sight or with no
   * route — the wallet's own connect asks then. */
  watchHeld() {
    const W = window.FoxyWallet;
    if (!W || !W.heldSats || !W.recoverSwaps || this._heldT) return;
    if (!(W.heldSats() > 0)) return;
    const again = () => {
      this._heldT = null;
      if (!(W.heldSats() > 0)) return;
      const idle = (typeof document !== 'undefined' && document.hidden) || (this.offlineNow && this.offlineNow());
      const go = idle ? Promise.resolve() : W.recoverSwaps().then(() => {
        if (!(W.heldSats() > 0)) {
          console.log('[foxy] the sats held for a swap are settled; the balance has them again');
          this.refreshBalance();
          if (this.loadHistory) this.loadHistory();
        }
      }, () => {});
      go.then(() => { if (W.heldSats() > 0 && !this._heldT) this._heldT = setTimeout(again, 3000); });
    };
    this._heldT = setTimeout(again, 3000);
  }

  refreshBalance() {
    const W = window.FoxyWallet;
    if (!W || !W.connected) return Promise.resolve();
    /* Not while a late claim has the wallet at another mint (`awayClaiming`):
     * the balance read then is that mint's, and it went on the home screen
     * under this one's name. Read when the phone is home, once. */
    if (W.awayClaiming && W.awayClaiming()) {
      if (!this._balWhenHome) {
        this._balWhenHome = W.whenHome().then(() => { this._balWhenHome = null; return this.refreshBalance(); });
      }
      return this._balWhenHome;
    }
    if (this.watchHeld) this.watchHeld();
    // the figure that is actually the person's, which is local and instant
    /* With the change that is on its way back. An over-payment leaves the
     * wallet whole and its change returns seconds later, and for those seconds
     * the balance showed the payment as if it had cost all of it: a small
     * figure where thousands of sats were held. Counted while it is awaited,
     * and dropped if it never comes. */
    const owed = () => (this._changeDueAt && Date.now() < this._changeDueAt)
      ? Math.max(0, Math.round(Number(this._changeOwedSats) || 0)) : 0;
    const known = W.balanceSats().then(n => {
      const all = n + owed();
      this.setState({ balSats: all });
      return all;
    });
    /* Both halves, and the launch waits for both.
     *
     * For a time it waited only for the sats, because the price sources were
     * timing out for eight seconds after a circuit that had taken two and the
     * launch screen sat there for all of it. Waiting is the better choice: a
     * home screen that opens with no dollar figure and fills one in a moment
     * later is worse than a launch screen that is honest about still working.
     *
     * It cannot hang on it. The rate's own walk has a deadline — twelve seconds
     * direct, thirty through a bridge — and the catch below turns a refusal
     * into a value, so this settles whether or not a price was found. What the
     * launch waits for is the answer, not a number. */
    this._priced = Promise.all([known, W.rate().catch(e => e)]).then(([sats, rate]) => {
      // A made-up price is worse than none: it shows a dollar figure that is
      // simply wrong, and there is no way to tell from the screen. So there is
      // no fallback number anywhere — if the price cannot be fetched, the
      // dollar amounts go blank and a retry appears.
      const ok = typeof rate === 'number' && isFinite(rate) && rate > 0;
      if (!ok) {
        /* A price from the last three minutes still stands. A single failed
         * refresh put NO BITCOIN PRICE up, and the next one, a second or two
         * later, took it down again. A real price that
         * recent is not a made-up one. */
        const last = W._rate, age = Date.now() - (W._rateAt || 0);
        /* And offline, at any age.
         *
         * Three minutes is the window for a fetch that failed once and will
         * succeed in a moment. With no route there is no next fetch, so that
         * window put NO BITCOIN PRICE on an offline phone for the rest of the
         * session — and a blank where the price was tells somebody less than a
         * figure that says how old it is. Every screen that shows it shows its
         * age (`priceAgo`), and nothing converts a send at it. */
        if (last && (age < PRICE_STANDS_MS || this.offlineNow())) {
          this.setState({ balSats: sats, balUsd: (sats / 1e8) * last, satUsd: last / 1e8,
            livePrice: last, priceErr: false });
          return;
        }
        this.setState({ balSats: sats, priceErr: true });
        // with no recent price, one more try before saying so: at launch the
        // first request often goes out before Tor's circuits are ready
        this._priceMissAt = this._priceMissAt || Date.now();
        if (Date.now() - this._priceMissAt < PRICE_GRACE_MS) {
          clearTimeout(this._priceRetryT);
          this._priceRetryT = setTimeout(() => this.refreshBalance(), PRICE_GRACE_MS);
          return;
        }
        this.showPriceError();
        return;
      }
      this._priceMissAt = 0;
      clearTimeout(this._priceRetryT);
      this.setState({
        balSats: sats,
        balUsd: (sats / 1e8) * rate,
        satUsd: rate / 1e8,
        livePrice: rate,
        priceErr: false,
      });
      // a working price re-arms the card for the next real failure
      this._priceOff = false;
      this.hidePriceError();
      // a large balance at one mint, at most once in 30 days (11-mint-risk.js)
      this.spreadNudge();
    }).catch(() => {});
    return this._priced;
  }

  /* How long ago the price on screen was fetched, or '' while it is current.
   *
   * Read from the wallet's own stamp rather than from state, because that is the
   * one place it is really recorded (`_rateAt`), and nothing copies it. '' under
   * PRICE_STANDS_MS, which is the window refreshBalance already treats as a real
   * price rather than a stale one — saying "1M AGO" about a figure the app itself
   * considers current would be noise.
   *
   * Coarse on purpose: a person wants to know whether this is minutes or hours
   * old, and a number that ticks every second on a figure that is not moving
   * reads as though something is happening. */
  priceAgo() {
    const W = window.FoxyWallet;
    const at = (W && Number(W._rateAt)) || 0;
    if (!at || !this.state.livePrice) return '';
    const ms = Date.now() - at;
    if (ms < PRICE_STANDS_MS) return '';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return mins + 'M AGO';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'H AGO';
    return Math.floor(hours / 24) + 'D AGO';
  }

  /* The age as the home screen says it: "37 MINUTES AGO", and nothing while
   * the price is current. */
  priceAgeWords() {
    if (!this.priceAgo()) return '';
    const W = window.FoxyWallet;
    return this.agoWords(Date.now() - ((W && Number(W._rateAt)) || 0)).toUpperCase();
  }

  /* The same age, in the words a sentence needs: "2 hours ago".
   *
   * `priceAgo` is a label — "2H AGO", shouted, and empty while the price is
   * current — and a card that says "That is 2% more than the price this phone
   * last saw, " needs the rest of the sentence whatever the age is. Coarse in
   * the same way and for the same reason. */
  agoWords(ms) {
    const n = Number(ms) || 0;
    if (n < 90 * 1000) return 'a moment ago';
    const mins = Math.floor(n / 60000);
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
    const days = Math.floor(hours / 24);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }

  /* No price means no dollars, so the keypad goes back to sats.
   *
   * `satUsd()` answers null until a price lands, and every conversion then gives
   * zero: `amountInSats` cannot turn a typed dollar figure into sats, and
   * `renderContext`'s cap becomes zero so every figure reads as more than the
   * balance. A keypad left in USD is therefore one that cannot send anything at
   * all — and offline that is permanent, which is exactly the state an offline
   * payer has to be able to spend from (the price sources all timed out for
   * minutes at a stretch).
   *
   * `toggleUnit` already refuses to go the other way without a price; this is the
   * half that was missing, for somebody already in dollars when the price went.
   * It does nothing at all while there is one. */
  /* Offline, asking to be paid is in dollars and only in dollars.
   *
   * This phone cannot convert honestly — its price may be hours old — so it
   * does not convert at all. It names a price in the money the price is named
   * in, and the phone with a current rate says what that makes in sats and
   * offers it back (`tapQuote`); nothing is paid until this phone agrees to
   * that number. Showing sats beside the dollars here would be showing a
   * conversion this phone is refusing to make.
   *
   * Only where the conversion is actually possible. With no price ever seen
   * there is nothing to type dollars against, and the keypad stays in sats —
   * `syncUnit` and `toggleUnit` both already hold that line. */
  dollarsOnly() {
    return !!(this.offlineNow() && this.state.flow === 'receive' && this.satUsd());
  }

  syncUnit() {
    if (this.dollarsOnly() && this.state.unit !== 'USD') {
      console.log('[foxy] offline and asking to be paid, so the keypad is in dollars');
      /* The figure is converted, not relabelled. Switching the unit under a
       * typed number turns 2,100 sats into $2,100 — the same digits standing
       * for eighty thousand times the money. `toggleUnit` converts for exactly
       * this reason and so does this; the price is the one this phone last saw,
       * which is the price the person is naming their amount in anyway. */
      const px = this.px();
      this.setState(p => {
        const v = parseFloat(p.amount) || 0;
        return { unit: 'USD', amount: (v && px) ? (v / 1e8 * px).toFixed(2) : '' };
      });
      return;
    }
    if (this.state.unit !== 'USD') return;
    /* Offline, a stale price may be shown but must not decide how much money
     * moves. The figure on the home screen carries its age and is there to be
     * read; a send converts at it silently, and a rate hours old converting a
     * typed dollar amount into sats is a real mis-send. Sats are exact and need
     * no rate at all. */
    /* Sending, yes. Asking to be paid, no.
     *
     * The two carry the risk in opposite directions. A send converts silently
     * and a rate hours old is a real mis-send, so a send stays in sats, which
     * are exact and need no rate. Asking for a dollar amount is the person
     * naming a price, they are the one who carries a stale one, and Foxy says
     * so under the figure (`priceWarn`) rather than taking the choice away. */
    if (this.offlineNow() && this.state.flow !== 'receive') {
      console.log('[foxy] offline, so the keypad is in sats');
      this.setState({ unit: 'SATS' });
      return;
    }
    if (this.satUsd()) return;
    console.log('[foxy] no price, so the keypad goes back to sats');
    this.setState({ unit: 'SATS' });
  }

  // dollars per bitcoin, and per sat. Null when there is no live price —
  // callers must handle that rather than fall back to a guess.
  /* Dollars per bitcoin. Their price where this phone has no route of its own.
   *
   * A phone working offline converts at whatever it last saw, which can be
   * hours old. In a tap with a phone that IS online, that phone's price is both
   * fresher and the one this payment is being agreed at — so it is the one to
   * convert with, and `peerRateLabel` is what says on screen whose it is. It never becomes this wallet's own price: `_rate` is
   * untouched, and a route coming back puts this phone's own figure in front
   * again. */
  peerRate() {
    if (!this.offlineNow()) return 0;
    const n = Number(this.state.peerRate) || 0;
    return n > 0 ? n : 0;
  }

  /* Whose price the figures on screen are in, when it is not this phone's. */
  peerRateLabel() {
    const n = this.peerRate();
    if (!n) return '';
    return 'At their bitcoin price, $ ' + this.group(Math.round(n));
  }

  px() {
    const theirs = this.peerRate();
    if (theirs) return theirs;
    const r = this.state.satUsd;
    if (r) return r * 1e8;
    return this.state.livePrice || null;
  }

  satUsd() {
    if (this.state.satUsd) return this.state.satUsd;
    return this.state.livePrice ? this.state.livePrice / 1e8 : null;
  }
