
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
    // (not a removed mint's: HISTORY's mint list shows those, 26s-mint-remove.js)
    const list = W.balances().filter(b => b.unit !== 'sat' && !(W.mintHidden && W.mintHidden(b.mint)));
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
  /* And the trip home while its connect is out (`_homeGoing`): a switch made
   * under it is undone, or undoes it, whichever lands last. */
  moneyBusy() {
    const W = window.FoxyWallet;
    return !!((W && W.proofLockDepth && W.proofLockDepth() > 0)
      || this._sendRun || this._watching || this._chasingChange
      || this.state.nmBusy || this.state.reqBusy || this.state.reqSwapping || this._swapRun || this._homeGoing || this._trQuoteGoing);
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
      || this._sendRun || this._chasingChange || this._swapRun);
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
    if (this._swapRun) why.push('a swap between balances is running');
    if (this._homeGoing) why.push('the phone is on its way home');
    if (this._trQuoteGoing) why.push('a transfer is being quoted at its mint');
    return why.join('; ') || 'nothing';
  }

  /* Is the only thing in the way a background sweep holding the proof lock? A claim walked in from another mint, a
   * held melt settled, change tidied: each lets go within seconds, and a switch refused for one said "a payment is in
   * progress" to somebody who had made none (2026-11-03, `_onchainClaimAwayWith` for 3 s). A person's own payment
   * (`own` below), or anything else moving money, is not a sweep. */
  sweepHoldsLock() {
    const W = window.FoxyWallet;
    const held = W && W.proofLockHolder && W.proofLockHolder();
    if (!held || !held.what) return false;
    // what a person starts holds it under these names (99-proof-lock-and-export.js): not a sweep
    const own = ['pay', 'sendToken', 'receiveToken', 'reclaimToken', 'onchainPay', 'importProofs', 'adoptScan'];
    if (own.indexOf(String(held.what)) >= 0) return false;
    return !(this._sendRun || this._chasingChange || this.state.nmBusy || this.state.reqBusy || this._swapRun || this._homeGoing
      || this._trQuoteGoing);
  }

  /* Waits up to five seconds for such a sweep, the row showing it was tapped, then goes on (`go`), which refuses as
   * before if the lock is still held. True when it is waiting. */
  switchAfterSweep(url, go) {
    if (!this.sweepHoldsLock()) return false;
    const W = window.FoxyWallet;
    const held = W.proofLockHolder() || {};
    console.log('[foxy] mint switch: waiting up to 5s for ' + held.what + ' (a background sweep) to let go of the proof lock');
    this.setState({ switchBusy: true, mintBusy: String(url).replace(/\/+$/, '') });
    const t0 = Date.now();
    clearTimeout(this._switchSweepT);
    const poll = () => {
      if (this.sweepHoldsLock() && Date.now() - t0 < 5000) {
        this._switchSweepT = setTimeout(poll, 150);
        return;
      }
      this._switchSweepT = null;
      if (!this.sweepHoldsLock()) console.log('[foxy] mint switch: the sweep let go after ' + Math.round((Date.now() - t0) / 100) / 10 + 's');
      this.setState({ switchBusy: false, mintBusy: '' });
      go();
    };
    this._switchSweepT = setTimeout(poll, 150);
    return true;
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
  /* At once (`switchTo`): the wallet is built from the mint's keys on file, so home is drawn straight away from what
   * is on the phone (the pile, the history), the drawer closes, and the shield says CONNECTING TO the mint until it
   * answers (`shieldVals`). "Now on" is said when it has answered (`mintConnected`), not at the tap: the switch has
   * shown itself already, and the toast is the word that the mint is there. A wallet with no `switchTo` connects and
   * waits, as it always did. */
  justSwitch(url, waited) {
    const W = window.FoxyWallet;
    const host = String(url).replace(/^https?:\/\//, '');
    if (this.state.switchBusy) return;
    // ADD A MINT on a removal's TO WHICH MINT?: the mint added is where the money goes, not a switch (26s-mint-remove.js `mrAddTo`)
    if (this.state.mrMint && this.state.trStep === 'to' && this.mrAddTo) { this.mrAddTo(url); return; }
    // a background sweep holding the proof lock is waited for, a few seconds, rather than refused (`switchAfterSweep`)
    if (!waited && this.switchAfterSweep(url, () => this.justSwitch(url, true))) return;
    // a payment or claim in progress finishes at the mint it started on
    if (this.refuseSwitchWhileBusy()) return;
    // a choice waiting on a swap at this mint is not carried to another (10-pin.js, `holdSwapWatchStop`)
    if (this.holdSwapWatchStop) this.holdSwapWatchStop();
    // Connecting takes a second or two over Tor, and until now the row gave no
    // sign it had been tapped at all.
    this.setState({ switchBusy: true, mintBusy: String(url).replace(/\/+$/, '') });
    // an earlier switch's "Now on" is not this one's to say (`mintConnected` matches by the switch, review 7)
    this._switchSay = null;
    const back = this.state.mintReturn;
    // asked before connecting, which adds it to the list
    const usedBefore = !!(W.mintUsedBefore && W.mintUsedBefore(url));
    const lazy = typeof W.switchTo === 'function';
    /* Which path this switch took, in one line: the phone that "still showed connecting" on 2026-11-03 left nothing to
     * say whether it had landed at once or was waiting on the mint, nor why. */
    const waits = !lazy ? 'no switchTo in the wallet' : (typeof W.switchWaits === 'function' ? String(W.switchWaits(url) || '') : '');
    console.log('[foxy] switch: ' + host + (waits ? ' \u2014 waiting for the mint: ' + waits : ' \u2014 at once (switchTo)'));
    (lazy ? W.switchTo(url) : W.connect(url)).then(w => {
      // a mint switched to is where the person wanted to go: home, not the menu again (01-ui-basics.js `menuReturnWatch`)
      if (this.menuReturnDrop) this.menuReturnDrop();
      this.setState({ switchBusy: false, mintBusy: '', mintReturn: '' });
      this.walletReady({ name: (w && w.name) || host });
      // came from history, so go back to it — now showing this mint
      if (back === 'history') {
        this.setState({ screen: 'history', stack: ['home'], histMint: '' });
        this.loadHistory();
      }
      /* Still being asked: what waits for its answer is said when it comes (`mintConnected`), this switch's own
       * toast and a first visit's seed check among them. */
      if (w && w.pending) {
        this._switchSay = { url: String(url).replace(/\/+$/, ''), host, firstTime: !usedBefore, gen: w.gen };
        return;
      }
      this.toast('Now on ' + host);
      if (!usedBefore) this.sweepNewMint(url, host);
    }).catch(e => {
      this.setState({ switchBusy: false, mintBusy: '' });
      this.toast(W.reason(e), true);
    });
  }

  /* A mint switched to at once has answered, or has not (the wallet's `onMintConnected`): { url, ok, why, back }.
   *
   * Answered: the balance and history are read again from the wallet that answered, the shield's ring stops, the
   * switch's "Now on" is said, and a mint new to this phone has its seed check. Not: the phone stays on it, from the
   * keys on file, and the shield says it is not answering; it is asked again behind the screen, as a launch's wallet
   * from storage is (`connectForRealOnceOnline`). A switch with no keys on file goes back where it was (`back`). */
  mintConnected(ev) {
    const W = window.FoxyWallet;
    const e = ev || {};
    const strip = u => String(u || '').replace(/\/+$/, '');
    /* This switch's own answer, by the switch (`gen`), not by its mint: going back to a mint and away again is two
     * switches. Kept through NOT ANSWERING, so "Now on" is said once when it does answer. */
    const own = this._switchSay;
    const say = own && (own.gen != null || e.gen != null ? own.gen === e.gen : strip(own.url) === strip(e.url)) ? own : null;
    if (say && (e.ok || e.back)) this._switchSay = null;
    const host = String(e.url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.setState({ routeAt: Date.now() });
    if (e.ok) {
      this.refreshBalance();
      this.loadHistory();
      this.offerQuarantine();
      // the mint's own keys now: sats a dollars wallet was paid can be swapped into dollars
      if (this.convertOnReturn) this.convertOnReturn();
      if (say) {
        this.toast('Now on ' + host);
        if (say.firstTime) this.sweepNewMint(say.url, host);
      }
      return;
    }
    if (e.back) {
      // with no keys on file there was nothing to stay on: home, on the mint it was on
      this.walletReady({ name: this.mintHost() });
      this.toast('Could not reach ' + host + ' (' + (e.why || 'no answer') + '). Still on ' + this.mintHost() + '.', true);
      // the wallet put back may be one from the keys on file, itself still to be connected to for real
      if (W && W.fromCache && W.fromCache()) { clearTimeout(this._catchUpT); this._catchUpConnect = false; this.connectForRealOnceOnline(); }
      return;
    }
    this.refreshBalance();
    if ((say && !say.toldDown) || (!say && this.onMint(e.url))) this.toast(host + ' is not answering yet. Foxy keeps trying.', true);
    if (say) say.toldDown = true;
    // and is asked again for real, behind whatever the person is doing
    clearTimeout(this._catchUpT);
    this._catchUpConnect = false;
    if (W && W.fromCache && W.fromCache()) this.connectForRealOnceOnline();
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
        // a payment or claim in progress refuses the switch: said before the lock is asked, not after it is passed
        if (this.refuseSwitchWhileBusy()) return;
        // a mint new to this phone past the lock first; one the person chose is a switch, and free (`mintGate`)
        if (this.mintGate) this.mintGate(u, () => this.justSwitch(u), 'To add this mint.');
        else this.justSwitch(u);
      })
      .catch(e => this.toast(W.reason(e), true));
  }

  /* ADD A MINT's tile: the address sheet (08-mint-entry-and-notes.js, `typeMint`), past the lock first (`mintGate`). Nothing
   * is typed yet, so the tile always asks where a lock is set; the connect the sheet's ADD starts asks nothing more. */
  typeMintGated() {
    if (this.mintGate) this.mintGate('', () => this.typeMint(), 'To add a mint.');
    else this.typeMint();
  }

  /* A tile on the mint list: a switch. A mint the person chose is free; one only visited (a crossing, PAY FROM, MOVE TO
   * YOUR MINT put it on the list, so the money there shows) is added by this tap, and asks the lock first (`mintGate`). */
  mintTileTap(url) {
    if (this.mintGate) this.mintGate(url, () => this.justSwitch(url), 'To add this mint.');
    else this.justSwitch(url);
  }

  /* Back to a mint the phone was on, after a step that took it elsewhere (a crossing, a transfer dropped, a move that
   * failed): saved as the phone's own again only where the person chose it (the wallet's `mintChosen`). A mint only
   * visited is gone back to as a visit, so going back never chooses it with nothing asked. */
  connectBack(url) {
    const W = window.FoxyWallet;
    const chosen = !W.mintChosen || W.mintChosen(url);
    return chosen ? W.connect(url) : W.connect(url, null, null, { remember: false });
  }

  /* Home again after a flow that visited another mint: the live mint back to the one this phone belongs on (the wallet's
   * `homeMint`: an open till's, else the saved one), through `connectBack`, where the two differ. Nothing to do where they
   * agree, nor while a crossing's own way home is owed (`_crossCameFrom`, `crossComeHome`). Returns the trip, or null.
   *
   * The trip is the phone's way home (`_homeGoing`) until it lands, so a switch or a move asked meanwhile waits for it
   * (`moneyBusy`): a connect home landing under a claim at another mint made the move after it pay from home. A TRANSFER
   * quote's connect still out (`_trQuoteGoing`) is waited for first, so its late landing does not take the phone back. */
  homeAgain() {
    const W = window.FoxyWallet;
    if (!W || this._crossCameFrom || this._homeGoing) return null;
    const bare = (u) => String(u || '').replace(/\/+$/, '');
    const homeNow = () => (W.homeMint ? W.homeMint() : ((W.saved && W.saved()) || {}).url);
    const quoting = this._trQuoteGoing;
    if (!quoting) {
      const home0 = homeNow();
      if (!home0 || bare(W.mintUrl) === bare(home0)) return null;
    }
    let trip = null;
    const landed = () => { if (this._homeGoing === trip) this._homeGoing = null; };
    trip = Promise.resolve(quoting).then(null, () => null).then(() => {
      const home = homeNow();
      if (!home || bare(W.mintUrl) === bare(home)) return null;
      return this.connectBack ? this.connectBack(home) : W.connect(home);
    }).then(() => { landed(); if (this.refreshBalance) this.refreshBalance(); }, () => { landed(); });
    this._homeGoing = trip;
    return trip;
  }

  /* A mint on this phone, never asked about: one of the shipped mints (`DEFAULT_MINTS`, chosen by the app and not by
   * whoever holds the phone), or one the person chose, which the wallet keeps (`mintChosen`: the phone's own mint, every
   * mint it was saved on, every one passed through this gate). A mint only visited is not on it, though its tile shows.
   * Compared as the wallet writes a mint (`canonicalMint`). */
  mintOnPhone(url) {
    const W = window.FoxyWallet;
    const canon = (u) => ((W && W.canonicalMint) ? String(W.canonicalMint(u) || '')
      : String(u || '').trim().replace(/\/+$/, ''));
    const want = canon(url);
    if (!want) return false;
    // a shipped mint the keeper removed is not, until it is chosen again (26s-mint-remove.js; the wallet's `mintHidden`)
    if ((this.DEFAULT_MINTS || []).some(m => canon(m.url) === want) && !(W && W.mintHidden && W.mintHidden(url))
      && !(W && W.mintReturned && W.mintReturned(url))) return true;
    return !!(W && W.mintChosen && W.mintChosen(url));
  }

  /* Adding a mint to this phone asks the lock it has: Face ID where FACE ID LOCK is on, else the PIN pad where SET PIN is on,
   * as the till's own gate asks (26m-till.js, `lockAsk`). With no lock nothing is asked. A mint already on this phone is
   * never asked about: switching between its mints stays free. `url` is the mint, or '' where it is not known yet (ADD A
   * MINT's address sheet, which is asked before it opens). Asked once per add: what `then` starts (the connect, the claim)
   * asks nothing more. Given up, nothing is added and the person stays where they were. */
  mintGate(url, then, why, o) {
    const W = window.FoxyWallet;
    const then1 = typeof then === 'function' ? then : () => {};
    /* Passed (or no lock to pass, or a mint on the phone already): the person chose this mint, and it is free from now
     * (`mintChosen`); a shipped mint never used is recorded too, so the claim or connect that follows saves the phone
     * there (the wallet takes money at a mint not chosen as a visit). Not where the step still has a way back (`o.choose`
     * false: a TRANSFER TO, whose quote can be dropped): there the step's own end chooses it, the connect that saves the
     * phone there. */
    const choose = !(o && o.choose === false);
    const go = () => { if (choose && url && W && W.chooseMint) W.chooseMint(url); then1(); };
    if (url && this.mintOnPhone(url)) { go(); return; }
    const pinSet = !!(W && W.pinIsSet && W.pinIsSet());
    const face = !!(W && W.faceLock && W.faceLock() && W.biometric);
    if (!W || !W.screenLocked || !W.screenLocked() || (!pinSet && !face) || !this.lockAsk) { go(); return; }
    const host = String(url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    console.log('[foxy] adding a mint' + (host ? ' (' + host + ')' : '') + ': the lock first');
    return this.lockAsk(go, why || 'To add a mint.', () => {
      console.log('[foxy] adding a mint: the lock was given up; nothing added');
      // a pad over a screen a menu row opened: that row's way back, as the till's gate does (01-ui-basics.js `menuReturnSettle`)
      if (this.menuReturnSettle) this.menuReturnSettle();
    });
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
    /* Home, unless the till is open: a mint answering again is not a way out of it, and the screen it is on stays
     * (26m-till.js). */
    this.setState(Object.assign({
      walletLive: true,
      walletSearching: false,
      walletErr: '',
    }, this.state.till ? {} : {
      screen: 'home',
      stack: [],
    }));
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
    // and last, at a mint with two balances, what to hold (10-pin.js)
    setTimeout(() => { if (this.offerHoldChoice) this.offerHoldChoice(); }, 1300);
    // and money a card is owed from a payment it made from this phone, until a tap puts it on (26f-flashcard.js)
    setTimeout(() => { if (this.fcMoneyWaiting) this.fcMoneyWaiting(); }, 1500);
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
    /* The till (26m-till.js): once a launch, past the lock, a cashier's till that was open when Foxy was closed comes back
     * (`tillResume`). Its inbox and outbox the wallet asks itself at every connect. */
    if (this.tillResume && !this._tillResumed) {
      this._tillResumed = true;
      this.pinUnlocked().then(() => this.tillResume()).catch(() => {});
    }
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
          /* Pieces a refusal flagged come back into the pile here when the swap
           * that was to make them safe got no answer, after the connect's own
           * settle had found nothing to settle. */
          if (W.atRisk && W.atRisk().length && W.settleAtRisk) W.settleAtRisk().then(() => this.refreshBalance(), () => {});
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
    // and the dollars, at a mint that issues them: their own figure, in cents, never added to the sats
    if (this.refreshUsd) this.refreshUsd();
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

  /* The dollar balance at this mint, in cents (`balUsdCents`), read from the
   * wallet's own pile. It needs no price: a dollar is a dollar. Cleared at a
   * mint with no dollars, so a switch does not carry one mint's dollars to
   * another's home screen. */
  refreshUsd() {
    const W = window.FoxyWallet;
    if (!(this.twoUnitsOn && this.twoUnitsOn()) || !W || !W.balanceOf) {
      if (this.state.balUsdCents != null) this.setState({ balUsdCents: null });
      return;
    }
    let cents = 0;
    try { cents = Math.max(0, Math.round(Number(W.balanceOf('usd')) || 0)); } catch (e) { return; }
    if (cents !== this.state.balUsdCents) this.setState({ balUsdCents: cents });
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
   * the price is current.
   *
   * Given an age (`ms`), the same words for that age: another phone's price,
   * or this phone's as it was when a payment was agreed. Nothing under three
   * minutes, as on home, and no `livePrice` question: the age is a fact about
   * that figure, not about whether this screen has a price of its own. */
  priceAgeWords(ms) {
    if (arguments.length) {
      const n = Number(ms);
      if (!isFinite(n) || n < PRICE_STANDS_MS) return '';
      return this.agoWords(n).toUpperCase();
    }
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
  /* Offline, asking to be paid into bitcoin with a dollar figure typed: the
   * request asks in dollars.
   *
   * This phone cannot convert honestly — its price may be hours old — so it
   * does not convert that figure. It names a price in the money the price is
   * named in, and the phone with a current rate says what that makes in sats
   * and offers it back (`tapQuote`); nothing is paid until this phone agrees
   * to that number. Showing sats beside the dollars here would be showing a
   * conversion this phone is refusing to make.
   *
   * No longer a lock: the keypad's swap is there offline as online (the owner,
   * 2026-10-22: "setting an amount should always allow a dollar amount or the
   * user to switch to enter a sat amount"), and sats typed are asked as sats.
   * A receive into the dollar balance is not this: it is asked in dollars as
   * its own unit (`wantedAmount`). With no price ever seen there is nothing to
   * type dollars against, and the keypad stays in sats (`syncUnit`). */
  dollarsOnly() {
    const s = this.state;
    if (!(this.offlineNow() && s.flow === 'receive' && s.unit === 'USD' && this.satUsd())) return false;
    return !(this.twoUnitsOn && this.twoUnitsOn() && this.walletNow && this.walletNow('receive') === 'usd');
  }

  syncUnit() {
    /* A dollar balance is typed in dollars, exactly, online or not and with a
     * price or without one: there is nothing to convert. */
    const s0 = this.state;
    /* A swap's keypad starts in dollars when its SET AMOUNT opens
     * (`swapToAmount`), and the ⇅ is the person's from then on: nothing here
     * moves it back. Typed in the unit the swap does not leave, the figure is
     * converted at the swap's price (`swapTyped`), and this keypad offers
     * the other unit only with a market price seen, so with none it goes
     * back to the unit that leaves, where nothing needs converting
     * (26i-swap.js). */
    if (s0.flow === 'swap' && s0.screen === 'amount') {
      const exact = s0.swapFrom === 'sat' ? 'SATS' : 'USD';
      if (s0.unit !== exact && !this.px()) {
        console.log('[foxy] no price, so the swap is typed in the balance it leaves');
        this.setState({ unit: exact, amount: '' });
      }
      return;
    }
    /* The dollar balance's own unit is dollars, exact. Sats may be typed for
     * it too, and are put into cents at this phone's price (`centsTyped`), but
     * only where that price can be used (`unitPx`, a day at most) and, for a
     * send, only with a route: offline a send moves no money at a stale price.
     * Otherwise the keypad goes back to dollars. Not a payment to an address:
     * that is asked in sats, so dollars typed there convert, and its ⇅ works
     * as it always did. */
    if ((s0.flow === 'receive' || s0.flow === 'send') && (s0.screen === 'amount' || s0.screen === 'confirm')
        && !(s0.flow === 'send' && s0.recipientKind === 'email')
        && this.walletNow && this.walletNow(s0.flow === 'receive' ? 'receive' : 'send') === 'usd') {
      if (s0.unit === 'SATS' && (!this.unitPx() || (s0.flow === 'send' && this.offlineNow()))) {
        console.log('[foxy] the dollar balance: no price to put sats into dollars, so the keypad is in dollars');
        const c = this.centsTyped();
        this.setState({ unit: 'USD', amount: c > 0 ? (c / 100).toFixed(2) : '' });
      }
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
