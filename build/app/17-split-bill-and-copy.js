
  /* ---- split the check ---- */

  // one real invoice per payer, watched from the moment they are made
  spStart() {
    const W = window.FoxyWallet;
    if (!W || !W.connected) { this.toast('No wallet connected.', true); return; }

    // Same guard as sending. Asking the mint for invoices tells it someone is
    // collecting, so it waits for Tor like every other request.
    const G = window.FoxyGate;
    if (G && G.quiet) {
      return G.quiet().then(ok => {
        if (!ok) { this.toast('Tor is reconnecting. Try again in a moment.', true); return; }
        console.log('[foxy] split invoices |', G.stamp());
        this.spMakeInvoices();
      });
    }
    return this.spMakeInvoices();
  }

  spMakeInvoices() {
    const W = window.FoxyWallet;
    const sh = this.spSharesArr();
    const n = this.spOthers();
    const px = this.px();
    if (!px) { this.showPriceError(); return; }

    this.spStopWatch();
    this.setState({ spInvoices: [], spPaid: [], spErr: '' });

    const jobs = [];
    for (let i = 0; i < n; i++) {
      const sats = Math.round((sh[i + 1] / 100) / px * 1e8);
      jobs.push(W.invoice(sats, 'Split ' + (i + 2) + ' of ' + this.spWaysN(), W.expiry.split));
    }

    Promise.all(jobs).then(list => {
      // a share already paid by tap while these were being made stays paid
      const paidBy = (this.state.spPaid || []).slice();
      // on disk before anything else: these are payable invoices in other
      // people's hands, and losing track of them is the whole problem
      W.splitSave({
        ways: this.spWaysN(),
        total: this.state.spTotal,
        at: Date.now(),
        /* The mint that issued these, as the invoices say it. `splitSave`
         * used to fill this in from wherever the wallet was at the moment of
         * saving, and a late claim had it at another mint for those seconds:
         * the bill was filed against a mint that had never heard of its
         * quotes, and the check on return refused to ask the one that had. */
        mint: (list[0] && list[0].mint) || undefined,
        rows: list.map((inv, k) => ({
          hash: inv.hash, bolt11: inv.bolt11, sats: inv.sats,
          label: 'Split ' + (k + 2) + ' of ' + this.spWaysN(), paid: !!paidBy[k],
        })),
      });
      // the collecting screen is the confirmation for these — mark them known
      // so neither the socket nor the history sweep announces them separately
      this._seenTx = this._seenTx || {};
      list.forEach(inv => { this._seenTx[inv.hash] = true; });
      this.setState({ spInvoices: list.map(x => x.bolt11) });
      // an hour, as resumeSplitNow watches them: the second of two timeoutMs
      // keys, the first of which (the invoice's own expiry) never took effect
      this._spWatching = list.map(inv => inv.hash).join(',');
      this._spWatchedAt = Date.now();
      this._spStops = list.map((inv, i) => paidBy[i] ? (() => {})
        : W.watch(inv.hash, () => { this.spMarkPaid(i, inv.hash); this.spPaidOnScreen(i); }, { timeoutMs: 3600000 }));
      // and watched again before that hour is up: a bill on a table outlasts it
      this.splitWatchLater();
    }).catch(e => {
      this.setState({ spErr: W.reason(e) });
      this.toast(W.reason(e), true);
    });
  }

  /* One payer's share in sats, by the same sum the invoices are made with, so
   * a request made before the invoice asks for the same figure. */
  spShareSats(idx) {
    const sh = this.spSharesArr();
    const px = this.px();
    const cents = Number(sh[(Number(idx) || 0) + 1]) || 0;
    if (!px || !(cents > 0)) return 0;
    return Math.round((cents / 100) / px * 1e8);
  }

  spMarkPaid(i, hash) {
    const W = window.FoxyWallet;
    if (hash) W.splitMarkPaid(hash);
    /* And its invoice stops being asked about. A share paid in ecash leaves a
     * Lightning invoice nobody will ever pay, and its watcher went on asking
     * the mint every second and a half, over Tor, for an hour — under every
     * payment made after it. */
    this.spStopOne(i, hash);
    const n = this.spOthers();
    this.setState(p => {
      const paid = (p.spPaid || []).slice();
      while (paid.length < n) paid.push(false);
      paid[i] = true;
      const done = paid.slice(0, n).every(Boolean);
      return { spPaid: paid, screen: done && p.screen === 'spWaiting' ? 'spAllPaid' : p.screen };
    });
    if (this.haptic) this.haptic('success');
    this.refreshBalance();
    this.loadHistory();
  }

  /* A share paid over the tap while its QR was up: on to the next payer.
   *
   * The screen stayed on the paid share, its code card came down, and the
   * radio re-armed for the same share — the next person had to be stepped to
   * by hand. Only from the payer screen showing that very
   * share; a share opened from the waiting list goes back there instead
   * (requestPaidHere). With every share paid it is EVERYONE HAS PAID. */
  spAdvanceAfterPaid(idx, how) {
    const s = this.state;
    if (s.screen !== 'spPayer' || Number(s.spIdx || 0) !== Number(idx)) return;
    const n = this.spOthers();
    const paid = this.spPaidArr();
    let next = -1;
    for (let i = 0; i < n; i++) if (!paid[i]) { next = i; break; }
    // a fresh screen arms afresh
    this._tapPaidHere = false;
    console.log('[foxy] split: share ' + (idx + 1) + ' paid ' + (how || 'by tap') + '; '
      + (next < 0 ? 'everyone has paid' : 'on to payer ' + (next + 1)));
    this.setState(next < 0
      ? { screen: 'spAllPaid', spFromWaiting: false, spCopied: -1, spShared: -1, tapShownCode: '', tapRecvStage: '' }
      : { spIdx: next, spFromWaiting: false, spCopied: -1, spShared: -1, tapShownCode: '', tapRecvStage: '' });
  }

  /* What the ledger says has landed, into the screen's own tally.
   *
   * spPaid is the only thing the collecting screen draws its ticks from, and
   * until now only the per-invoice watcher wrote it (spMarkPaid). But a share
   * can settle by a different path entirely: splitReconcile, which every
   * history load runs, asks the mint about any row the ledger cannot answer
   * and claims one the mint reports PAID. When that got there first — as it
   * does whenever the watcher is late, has timed out, or lost its circuit —
   * the money was in the balance and in history, the ledger row said paid,
   * and the screen the person was actually looking at still read PENDING,
   * 0 of 3, for as long as they left it open.
   *
   * So the screen no longer depends on which path settled a share. Nothing is
   * set here that the ledger does not already say, and a tally that has not
   * moved sets no state at all rather than drawing the screen again on every
   * history load. */
  spSyncPaid() {
    const W = window.FoxyWallet;
    /* The record whether or not it is finished (`splitRecord`). It was
     * `splitPending`, which answers nothing once every row is paid: the last
     * share settled by the sweep was the one share this could never tick. */
    const led = W && (W.splitRecord ? W.splitRecord() : (W.splitPending && W.splitPending()));
    if (!led || !led.rows) return;
    const n = this.spOthers();
    const paid = this.spPaidArr();
    /* A finished record stays on file until its all-paid screen is dismissed,
     * so it may be an earlier bill's. Only the bill this screen is collecting
     * ticks anything: its rows are these invoices. */
    const finished = led.rows.every(r => r.paid);
    const mine = this.state.spInvoices || [];
    const here = (r, i) => !finished || (!!r.bolt11 && r.bolt11 === mine[i]);
    const landed = [];
    led.rows.slice(0, n).forEach((r, i) => { if (r.paid && !paid[i] && here(r, i)) { paid[i] = true; landed.push(i); } });
    if (!landed.length) return;
    const done = paid.every(Boolean);
    this.setState(p => ({
      spPaid: paid,
      // the all-paid screen belongs to the person still watching it collect
      screen: done && p.screen === 'spWaiting' ? 'spAllPaid' : p.screen,
    }));
    if (done && this.haptic) this.haptic('success');
    landed.forEach(i => this.spPaidOnScreen(i));
  }

  /* A share paid by its invoice while its own screen was up: the screen says
   * so, as it does for a share paid over the tap (`spAdvanceAfterPaid`).
   *
   * It did nothing. The tally was marked and the payer's code stayed where it
   * was, so the person holding the phone saw no sign of the payment until
   * they went to the list. Back to the list when the share was opened from
   * it, otherwise on to the next payer; with every share paid it is EVERYONE
   * HAS PAID. */
  spPaidOnScreen(idx) {
    const s = this.state;
    if (s.screen !== 'spPayer' || Number(s.spIdx || 0) !== Number(idx)) return;
    if (s.spFromWaiting) { this.setState({ screen: 'spWaiting', spFromWaiting: false }); return; }
    this.spAdvanceAfterPaid(idx, 'by its invoice');
  }

  /* Pick up a bill left half-collected.
   *
   * Rewatches only the invoices nobody has paid yet. The watchers are the
   * point: without them a payment lands at the mint and this wallet never
   * claims it.
   */
  /* Stop collecting a bill, from the collecting screen's basket.
   *
   * The record is what makes a bill show as still being collected; removing
   * it is the whole of stopping. What it is NOT is a refund or a cancellation
   * of anything at the mint: a share already paid is in history and stays
   * there, and a share paid after this still reaches the wallet, because the
   * invoice stays on the pending list the quote sweep checks on every connect
   * and return (15-receiving.js). It simply stops having a screen of its own.
   *
   * Asked first, because a half-collected bill cannot be brought back: the
   * rows, the names and who has paid are only in this record. */
  spDiscard() {
    const W = window.FoxyWallet;
    const s = (W && W.splitPending) ? W.splitPending() : null;
    const open = s && s.rows ? s.rows.filter(r => !r.paid).length : 0;
    this.blockedCard('splitDiscard', {
      tone: 'warn',
      title: 'STOP COLLECTING THIS BILL?',
      reason: open
        ? open + ' share' + (open === 1 ? '' : 's') + ' still owed. This screen goes away and the bill '
          + 'stops being tracked. Shares already paid stay in your history, and if someone pays '
          + 'their share later it still reaches your wallet \u2014 you just will not see it here.'
        : 'This screen goes away. Everything collected stays in your history.',
      retry: 'STOP COLLECTING',
      go: () => this.spDiscardNow(),
      shut: { label: 'KEEP COLLECTING' },
    });
  }

  spDiscardNow() {
    const W = window.FoxyWallet;
    clearTimeout(this._spResumeT);
    this._spWatching = null;
    this._spWatchedAt = 0;
    if (W && W.splitClear) W.splitClear();
    console.log('[foxy] the bill being collected was stopped by hand');
    this.setState({
      screen: 'home', stack: [], flow: '',
      amount: '', asset: '', unit: 'USD', recipient: '', emailDraft: '',
      spPaid: [], spInvoices: [], spAssigns: [], spShares: null, spErr: '',
    });
  }

  resumeSplit(force) {
    const W = window.FoxyWallet;
    // between mints, or before the wallet script is up: come back to it, since
    // an unwatched share is a payment that lands at the mint and stays there
    if (!W) { this.splitWatchLater(); return; }
    // Settle what the watcher missed before deciding what to watch. This asks
    // the mint for anything the ledger cannot answer, so it is async; the
    // rest runs once it knows.
    const go = W.splitReconcile ? W.splitReconcile() : Promise.resolve(0);
    go.then(() => this.resumeSplitNow(force)).catch(() => this.resumeSplitNow(force));
  }

  /* Watch the open shares again, before the watchers time out.
   *
   * W.watch gives up after an hour (timeoutMs below), and nothing re-armed it:
   * a bill left collecting on the table stopped being watched at the hour mark
   * and every share paid after that landed at the mint unclaimed. The same
   * shape as the on-chain watcher that stopped asking — a timer that ends
   * without leaving another behind. Well
   * inside the hour, so a watch is always replaced rather than mourned. */
  SPLIT_REWATCH_MS = 1500000;

  splitWatchLater() {
    clearTimeout(this._spResumeT);
    /* Forced: this timer is the whole reason the watchers outlive the hour
     * they are given, so its pass always arms a new set. The wake and
     * mint-connect passes are the ones that must not. */
    this._spResumeT = setTimeout(() => this.resumeSplit(true), this.SPLIT_REWATCH_MS);
  }

  resumeSplitNow(force) {
    const W = window.FoxyWallet;
    clearTimeout(this._spResumeT);
    // the wallet cannot say yet whether a bill is open: come back to it
    if (!W || !W.splitPending) { this.splitWatchLater(); return; }
    const s = W.splitPending();
    /* No bill half-collected needs no timer: one cannot appear on its own,
     * since spStart both makes the invoices and watches them. */
    if (!s) return;
    if (s.done) {
      // settled while the app was away; nothing to collect
      console.log('[foxy] the pending split is already settled');
      return;
    }
    // shares still owed: stay watched past the hour the watchers last
    this.splitWatchLater();
    const open = s.rows.filter(r => !r.paid);
    console.log('[foxy] resuming split:', open.length, 'of', s.rows.length, 'still owed');
    /* Same as when the split was created: the collecting screen is the
     * confirmation for these, so nothing else should announce them. Without
     * this the history sweep saw three unknown arrivals on every pass and
     * raised a confirmation for each, over and over. */
    this._seenTx = this._seenTx || {};
    s.rows.forEach(r => { if (r.hash) this._seenTx[r.hash] = true; });
    /* Already watching exactly these shares, and nowhere near the hour a
     * watcher lasts: leave them running.
     *
     * A watcher's own back-off is measured from when it was armed — one ask
     * every two seconds for the first two minutes, then ten, then thirty
     * (FoxyWallet.watch). Re-arming restarted that clock, and this runs on
     * every return to the foreground and every mint connect, so each return
     * put every open share back into the two-second phase. Nine returns in
     * five minutes on a phone held three invoices there the whole time: 165
     * mint requests over Tor in seven minutes for one bill on a table, each
     * its own circuit round trip (seen in a device log).
     *
     * The hour is still covered and nothing stops asking: splitWatchLater
     * above has already set the next pass at SPLIT_REWATCH_MS, well inside
     * it, and that pass passes force — it exists to replace the watchers and
     * always does. A share being paid changes which shares are open, which
     * arms a new set here too. A wake after a long sleep, where the watchers
     * may have run out while the app was away, ages out of the test below. */
    const want = open.map(r => r.hash).join(',');
    if (!force && this._spStops && this._spStops.length && this._spWatching === want
        && Date.now() - (this._spWatchedAt || 0) < this.SPLIT_REWATCH_MS) {
      console.log('[foxy] split: the open shares are already watched');
      return;
    }
    this.spStopWatch();
    this._spWatching = want;
    this._spWatchedAt = Date.now();
    this._spStops = open.map(r => W.watch(r.hash, () => {
      W.splitMarkPaid(r.hash);
      this.refreshBalance();
      this.loadHistory();
    }, { timeoutMs: 3600000 }));
  }

  /* Back into the collecting screen from the history row. */
  openPendingSplit() {
    const W = window.FoxyWallet;
    const s = W.splitPending && W.splitPending();
    if (!s) { this.toast('That split is settled.'); this.loadHistory(); return; }
    this.setState(p => ({
      screen: 'spWaiting',
      stack: p.stack.concat([p.screen]),
      spWays: String(s.ways),
      spTotal: s.total,
      spInvoices: s.rows.map(r => r.bolt11),
      spPaid: s.rows.map(r => !!r.paid),
    }));
  }

  /* A payer on Foxy can hand over ecash instead of paying their invoice: the
   * collector taps SCAN on that payer's screen and scans the token. A token
   * from this wallet's mint for exactly the share is taken and the payer
   * marked paid; anything else is refused and stays the payer's, with why. */
  spScanToken(idx) {
    const W = window.FoxyWallet;
    if (!W || !W.scan) return;
    const split = W.splitPending && W.splitPending();
    const row = split && split.rows && split.rows[idx];
    if (!row) { this.toast('That share\u2019s invoice is still being made.', true); return; }
    if (row.paid) { this.toast('That share is already paid.', true); return; }
    W.scan('Scan an ecash token').then(text => {
      const t = String(text || '').trim();
      if (W.classify(t) !== 'token') { this.toast('That QR is not a Cashu token.', true); return; }
      const info = W.tokenInfo(t);
      const here = String(W.mintUrl || '').replace(/\/+$/, '');
      if (!info || String(info.mint || '').replace(/\/+$/, '') !== here) {
        this.toast('That token is from ' + this.mintNameOf(info && info.mint) + '. Ask for one from '
          + this.mintName() + ', or for the invoice to be paid.', true);
        return;
      }
      if ((info.unit && info.unit !== 'sat') || Number(info.sats) !== Number(row.sats)) {
        this.toast('That token is for ' + this.group(info.sats) + ' sats; this share is '
          + this.group(row.sats) + ' sats.', true);
        return;
      }
      this.showMelt('Receiving ecash\u2026');
      return W.receiveToken(t).then(() => {
        this.hideMelt();
        this.spMarkPaid(idx, row.hash);
        if (this.state.spFromWaiting) this.setState({ screen: 'spWaiting', spFromWaiting: false });
      });
    }).catch(e => { this.hideMelt(); this.claimFailed(e, () => this.spScanToken(idx)); });
  }

  /* One share's watcher, found by its invoice where that is known (the rows a
   * resumed split watches are only the open ones, so their positions are not
   * the shares' own) and by position otherwise. */
  spStopOne(i, hash) {
    const stops = this._spStops || [];
    const hashes = String(this._spWatching || '').split(',');
    let at = hash ? hashes.indexOf(String(hash)) : -1;
    if (at < 0 && !hash && hashes.length === this.spOthers()) at = i;
    if (at < 0 || typeof stops[at] !== 'function') return;
    try { stops[at](); } catch (e) {}
    stops[at] = () => {};
    console.log('[foxy] split: share ' + (i + 1) + ' is paid; its invoice is no longer watched');
  }

  spStopWatch() {
    (this._spStops || []).forEach(f => { try { f(); } catch (e) {} });
    this._spStops = [];
    // stopped on purpose, so the next pass arms rather than recognising these
    this._spWatching = null;
    this._spWatchedAt = 0;
  }

  /* Copy something that is money.
   *
   * A token is spendable by whoever holds the text, and the general
   * pasteboard has no expiry and syncs to every paired Apple device. The
   * native side can mark a copy device-only and short-lived; the web API
   * cannot. Falls back to the ordinary path off-device. */
  copySecret(text) {
    const str = String(text || '');
    if (!str) return false;
    const mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
    if (mh) {
      try {
        mh.postMessage({ id: 'copy-' + Date.now(), action: 'copy', text: str, sensitive: true });
        return true;
      } catch (e) {}
    }
    return this.copyText(str);
  }

  copyText(text) {
    const str = String(text || '');
    if (!str) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(str);
        return true;
      }
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, str.length);   // iOS ignores select() on its own
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
