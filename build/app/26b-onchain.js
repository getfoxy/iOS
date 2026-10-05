  /* ---- on chain (NUT-30) ---------------------------------------------------
   *
   * Receiving: ON-CHAIN is one of the receive screen's networks. The mint gives
   * an address, the QR carries it with the amount as a BIP-21 hint, and the
   * ecash is issued once the payment has the mint's confirmations. The floor
   * matters: under it a payment is lost rather than refused (16a-onchain.js).
   *
   * Sending: a scanned or pasted address (with its amount, when it carries one)
   * goes to the same confirmation a Lightning send uses, with the mint's fee
   * options — each a fee and a rough wait — to choose from. A payout is not
   * done when it leaves: the mint broadcasts and it is followed until the mint
   * says it confirmed.
   */

  /* What this mint does on chain, kept in state so the screens can ask. */
  onchainAsk() {
    const W = window.FoxyWallet;
    if (!W || !W.onchainLimits || this._ocAsked === W.mintUrl) return;
    this._ocAsked = W.mintUrl;
    W.onchainLimits().then(limits => this.setState({ ocLimits: limits || null }), () => {});
  }

  ocCan(which) {
    const limits = this.state.ocLimits;
    return !!(limits && limits[which]);
  }

  // MARK: receiving

  /* The receive screen's ON-CHAIN network: an address for this wallet, made
   * once per visit and kept while the screen is up. */
  ocReceiveAddress() {
    const W = window.FoxyWallet;
    if (!W || !W.onchainAddress) return '';
    if (this._ocAddr && this._ocAddr.mint === W.mintUrl) return this._ocAddr.address;
    if (this._ocMaking) return '';
    this._ocMaking = true;
    W.onchainAddress().then(made => {
      this._ocMaking = false;
      this._ocAddr = made;
      this.setState({ ocMade: Date.now() });
      this.onchainWatchLater();
    }, e => {
      this._ocMaking = false;
      this.setState({ ocErr: W.reason(e) });
      this.toast(W.reason(e), true);
    });
    return '';
  }

  /* What the receive screen shows under the QR on this network. */
  ocReceiveNote() {
    const limits = this.state.ocLimits;
    const floor = limits && limits.receive ? limits.receive.min : 0;
    const blocks = limits && limits.receive ? limits.receive.confirmations : 0;
    if (!floor) return 'This mint takes ordinary Bitcoin payments.';
    return 'Send at least ' + this.group(floor) + ' sats. Less than that is lost, not returned. '
      + (blocks ? 'Your ecash arrives after ' + blocks + ' confirmations.' : '');
  }

  /* Why a small amount cannot be asked for on chain. */
  /* The same fact in the space a greyed row has for it. The long form explains
   * why and belongs where there is room; a row under a network's name has one
   * line, and what a person needs there is the number. */
  ocFloorShort() {
    const limits = this.state.ocLimits;
    const floor = limits && limits.receive ? limits.receive.min : 0;
    return 'Minimum \u20bf ' + this.group(floor);
  }

  ocFloorSays() {
    const limits = this.state.ocLimits;
    const floor = limits && limits.receive ? limits.receive.min : 0;
    return 'On chain this mint takes ' + this.group(floor) + ' sats or more. '
      + 'Anything less is swallowed, not returned.';
  }

  /* Below the floor the address is worth nothing, so the screen says so rather
   * than showing a QR that eats the money. */
  ocReceiveBlocked(sats) {
    const limits = this.state.ocLimits;
    const floor = limits && limits.receive ? limits.receive.min : 0;
    return !!(floor && sats && sats < floor);
  }

  // MARK: sending

  /* A scanned or pasted address. With an amount it goes straight to the
   * confirmation; without one, to the keypad. */
  payOnchain(text) {
    const W = window.FoxyWallet;
    const read = W.readAddress ? W.readAddress(text) : null;
    if (!read) { this.toast('That is not a Bitcoin address Foxy can read.', true); return; }
    this.onchainAsk();
    const limits = this.state.ocLimits;
    if (limits && !limits.send) {
      this.toast(this.mintName() + ' does not send on chain. Move your sats to a mint that does.', true);
      return;
    }
    this.setState(p => ({
      ocTo: read.address, ocSats: read.sats || 0, ocPlan: null, ocErr: '', ocFee: null,
      screen: read.sats ? 'ocConfirm' : 'amount',
      stack: p.stack.concat([p.screen]),
      flow: read.sats ? p.flow : 'onchain',
      /* Dollars on the keypad, as every other amount screen opens — while
       * there is a price to turn them into sats with. */
      asset: 'BITCOIN', unit: (!read.sats && this.satUsd() > 0) ? 'USD' : 'SATS', amount: '',
      recipient: read.address, recipientKind: 'address',
    }));
    if (read.sats) this.ocQuote();
  }

  /* The keypad's NEXT during an on-chain send. */
  ocNext() {
    const sats = this.amountInSats();
    if (!(sats > 0)) { this.toast('Enter an amount first', true); return; }
    /* More than is here is refused at the keypad, before the mint is asked
     * for a fee: the confirmation said so only after its quote, a screen
     * later. The fee comes on top and is still
     * checked there. */
    if (sats > (this.state.balSats || 0)) { this.toast('That is more than your balance.', true); return; }
    const limits = this.state.ocLimits;
    const floor = limits && limits.send ? limits.send.min : 0;
    const ceiling = limits && limits.send ? limits.send.max : 0;
    if (floor && sats < floor) {
      this.toast('This mint sends at least ' + this.group(floor) + ' sats on chain.', true);
      return;
    }
    if (ceiling && sats > ceiling) {
      this.toast('This mint sends at most ' + this.group(ceiling) + ' sats on chain.', true);
      return;
    }
    this.setState(p => ({ screen: 'ocConfirm', stack: p.stack.concat([p.screen]), ocSats: sats,
      ocPlan: null, ocFee: null, ocErr: '' }));
    this.ocQuote();
  }

  /* The mint's fees for this payment. Nothing is spent by asking, and a
   * mistyped address is refused here, before any ecash moves. */
  ocQuote() {
    const W = window.FoxyWallet;
    const { ocTo, ocSats } = this.state;
    if (!ocTo || !(ocSats > 0)) return;
    this.setState({ ocQuoting: true, ocErr: '' });
    W.onchainQuote(ocTo, ocSats).then(plan => {
      this.setState({
        ocQuoting: false, ocPlan: plan, ocErr: '',
        // the quickest by default; the person can pick another
        ocFee: plan.options.length ? plan.options[0].index : null,
      });
    }, e => {
      this.setState({ ocQuoting: false, ocErr: W.reason(e) });
    });
  }

  /* The fee sheet, when the mint offers more than one. */
  ocPickFee() {
    const plan = this.state.ocPlan;
    if (!plan || plan.options.length < 2) return;
    this.chooseFrom('SPEED', plan.options.map(o => ({
      label: this.ocFeeLabel(o),
      on: o.index === this.state.ocFee,
      tap: () => this.setState({ ocFee: o.index }),
    })));
  }

  ocFeeLabel(option) {
    const blocks = option.blocks;
    const when = !blocks ? 'NEXT BLOCK'
      : blocks === 1 ? 'ABOUT 10 MINUTES'
      : blocks <= 6 ? 'ABOUT ' + blocks + ' BLOCKS'
      : 'ABOUT ' + Math.round(blocks / 6) + ' HOURS';
    return when + ' · ' + this.money(option.fee).main;
  }

  /* Hand it over. The mint takes the ecash and broadcasts; the confirmation
   * screen says it is on its way, and the watcher marks it done. */
  /* The transaction id out of a NUT-30 outpoint, or ''.
   *
   * The mint answers `txid:vout` once it has broadcast, and `null` before that.
   * This is the only explorer-searchable thing in an on-chain payout: PAYMENT ID
   * is the mint's own melt quote id with `onchain-` in front of it, which no
   * explorer has ever heard of. The wallet has
   * been resolving the outpoint all along (16a-onchain.js) and the app threw it
   * away every time.
   *
   * Checked rather than trusted: 64 hex characters, or nothing. It remains the
   * mint's claim — Foxy does not verify that this transaction pays the address
   * that was asked for, and a receipt is not a proof. */
  ocTxidOf(outpoint) {
    const txid = String(outpoint || '').split(':')[0].trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(txid) ? txid : '';
  }

  ocPay() {
    const W = window.FoxyWallet;
    const { ocPlan, ocFee } = this.state;
    if (!ocPlan || ocFee == null || this.state.ocBusy) return;
    this.setState({ ocBusy: true });
    this.showMelt('Handing it to the mint…');
    W.onchainPay(ocPlan, ocFee, stage => {
      if (stage === 'paying') this.meltSays('Sending it on chain…');
    }).then(done => {
      this.hideMelt();
      this.setState({ ocBusy: false, ocPlan: null, ocTo: '', ocSats: 0 });
      this.refreshBalance();
      this.loadHistory();
      this.onchainWatchLater();
      /* PENDING is what an on-chain payout looks like when it has gone: the
       * mint holds the transaction and the confirmation screen says so. An
       * answer with no state at all is different — the ecash has left and
       * nobody knows whether the mint took it — and saying SENT for that is
       * the mistake finding 9 is about, so it gets the same pending screen a
       * Lightning payment in flight gets. */
      const txid = this.ocTxidOf(done.outpoint);
      if (txid) W.tag('onchain-' + done.quote, { txid: txid });
      if (done.state === 'UNKNOWN') { this.showPayPending(); return; }
      this.announcePayment({ dir: 'out', sats: done.sats, hash: 'onchain-' + done.quote,
        to: 'a bitcoin address', force: true });
    }, e => {
      this.hideMelt();
      this.setState({ ocBusy: false, ocErr: W.reason(e) });
      this.toast(W.reason(e), true);
    });
  }

  /* The confirmation screen (confirmSpec), the same shell a Lightning send
   * uses, with the fee and the wait it buys. */
  onchainSpec() {
    const s = this.state;
    const plan = s.ocPlan;
    const pick = plan ? plan.options.filter(o => o.index === s.ocFee)[0] : null;
    const short = String(s.ocTo || '');
    const rows = [
      this.cfRow('DELIVERED TO', short.slice(0, 12) + '…' + short.slice(-8)),
      this.cfRow('PAYING FROM', (this.mintName() || 'THIS MINT').toUpperCase(), { half: true }),
      this.cfRow('NETWORK', 'ON-CHAIN', { half: true }),
      this.cfRow('ARRIVES', pick ? this.ocFeeLabel(pick).split(' · ')[0] : 'CHECKING…',
        { ink: 'var(--btc-ink)', half: true }),
      this.cfRow('FEE', s.ocErr ? 'UNKNOWN' : pick ? 'UP TO ' + this.money(pick.fee).main : 'CHECKING…',
        { half: true }),
    ];
    /* More than is here: said before the mint is asked to take it, the way a
     * payment request that overruns the balance is. */
    const owed = s.ocSats + (pick ? pick.fee : 0);
    if (pick && owed > (s.balSats || 0)) {
      return {
        title: 'CONFIRMATION', amountLabel: 'SENDING',
        amount: this.money(s.ocSats).main, amountSub: this.money(s.ocSats).sub, amountInk: '#FF5C5C', rows: rows,
        warn: this.heldBlocks(owed - (s.balSats || 0))
          || 'More than your balance — short by ' + this.money(owed - (s.balSats || 0)).main
          + ' with the fee',
        cta: 'CLOSE', ctaTone: 'warn', go: () => this.ocCancel(),
      };
    }
    if (s.ocErr) {
      return {
        title: 'CONFIRMATION', amountLabel: 'SENDING',
        amount: this.money(s.ocSats).main, amountSub: this.money(s.ocSats).sub, amountInk: '#FF5C5C', rows: rows,
        warn: s.ocErr,
        secondary: { label: 'CANCEL', go: () => this.ocCancel() },
        cta: 'TRY AGAIN', ctaTone: 'warn', go: () => this.ocQuote(),
      };
    }
    const many = !!(plan && plan.options.length > 1);
    return {
      title: 'CONFIRMATION',
      amountLabel: 'SENDING',
      amount: this.money(s.ocSats).main,
      amountSub: this.money(s.ocSats).sub,
      rows: rows,
      chip: 'A payment on chain is not instant. It is done when it confirms.',
      secondary: many
        ? { label: 'CHANGE THE SPEED', go: () => this.ocPickFee(), filled: true }
        : { label: 'CANCEL', go: () => this.ocCancel() },
      cta: s.ocBusy ? 'SENDING…' : pick ? 'SEND ' + this.money(s.ocSats).main : 'CHECKING THE FEE…',
      ctaTone: 'go',
      ctaBusy: !!s.ocBusy || !pick,
      go: () => { if (pick && !s.ocBusy) this.ocPay(); },
    };
  }

  ocCancel() {
    this.setState({ screen: 'home', stack: [], ocPlan: null, ocTo: '', ocSats: 0, ocErr: '' });
  }

  // MARK: watching

  /* Addresses waiting on a payment, and payouts waiting on a block. Asked on
   * launch, on return, and every few minutes while the app is open: on-chain
   * settlement is bounded by blocks, so there is nothing to gain by asking
   * more often than that. */
  onchainWatchLater(ms) {
    clearTimeout(this._ocWatchT);
    /* Soon when there is something to ask about.
     *
     * A phone is open for seconds at a time: in testing, a launch was in the
     * background again seventeen seconds later, where the first pass waited
     * twenty — and nothing on chain was asked
     * about for the rest of the day. An address or a payout on file gets a few
     * seconds; an empty wallet can wait, since nothing can arrive for it
     * without this app making it first. */
    const W = window.FoxyWallet;
    let wait = ms;
    if (wait === undefined) {
      let waiting = 0;
      try {
        const due = W && W.connected && (W.onchainDue || W.onchainWatching);
        waiting = (due ? due.call(W).length : 0)
          + (W && W.connected && W.onchainSending ? W.onchainSending().length : 0);
      } catch (e) { waiting = 0; }
      wait = waiting ? 3000 : 20000;
    }
    this._ocWatchT = setTimeout(() => this.onchainWatch(), wait);
  }

  /* The loop must outlive a pass that does nothing.
   *
   * Every early return here used to leave no timer behind, so one pass with
   * the wallet between mints, or with nothing yet to watch, ended the watching
   * for the rest of the session — and nothing re-armed it except a launch, a
   * new address or a payout. On a phone that goes in and out of a pocket that
   * is most of the time: a deposit confirmed at the mint and Foxy never asked
   * again (on a device: an address made, asked about seven minutes later, and
   * never again in the 27 minutes the app kept running). So every path out of
   * this sets the next one. */
  onchainWatch() {
    const W = window.FoxyWallet;
    clearTimeout(this._ocWatchT);
    const again = ms => { this._ocWatchT = setTimeout(() => this.onchainWatch(), ms); };
    // no wallet yet, or between mints: ask again soon rather than never
    if (!W || !W.onchainWatching || !W.connected) { again(20000); return; }
    // only those due this pass: an address a week old is not asked about every
    // two minutes (onchainDue)
    const waiting = W.onchainDue ? W.onchainDue() : W.onchainWatching();
    if (waiting.length && W.onchainAsked) W.onchainAsked(waiting.map(r => r.quote));
    const sending = W.onchainSending ? W.onchainSending() : [];
    if (!waiting.length && !sending.length) { again(120000); return; }

    // one at a time: every claim reserves counters, and two at once derive the same secrets
    const claims = waiting.reduce((chain, record) => chain.then(() => W.onchainClaim(record.quote)
      .then(got => {
        if (!got || !got.sats) return;
        this.refreshBalance();
        this.loadHistory();
        // the hash the wallet logged, so the confirmation and the entry are one thing
        this.announcePayment({ dir: 'in', sats: got.sats, hash: got.hash, to: 'on chain' });
      }, () => {})), Promise.resolve());

    claims.then(() => sending.reduce((chain, record) => chain.then(() => W.onchainFollow(record.quote)
      .then(answer => {
        /* Before the PAID test, because a payment that is still PENDING is
         * exactly the one whose outpoint has only just appeared: the mint
         * answers `null` until it broadcasts, so the melt above almost never
         * has it and this pass is where it arrives. */
        const txid = this.ocTxidOf(answer.outpoint);
        if (txid) W.tag('onchain-' + record.quote, { txid: txid });
        if (answer.state === 'PAID') {
          this.loadHistory();
          this.toast('Your ' + this.group(record.sats) + ' sat payment confirmed on chain');
          return;
        }
        // refused or never sent: the ecash has been put back (onchainFollow)
        if (answer.state === 'UNPAID' || answer.state === 'FAILED') {
          this.refreshBalance();
          this.loadHistory();
          this.toast('That on-chain payment did not go. Your ' + this.group(record.sats)
            + ' sats are back.', true);
        }
      }, () => {})), Promise.resolve()))
      .then(() => again(120000), () => again(120000));
  }

