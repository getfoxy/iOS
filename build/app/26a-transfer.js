  /* ---- moving money between the mints you already use ----------------------
   *
   * Five steps, the way a send goes: which mint it leaves, which mint it lands
   * at, how much, a confirmation with the fee, and the screen a payment ends on.
   *
   * The wallet already knows how to do this — it is what a sweep does when a
   * token comes from a mint you do not use: connect to the destination, quote
   * an invoice there, pay it from the source (14-moving-between-mints.js). The
   * fee is that invoice's routing reserve, which is why it is quoted before the
   * confirmation rather than guessed.
   */
  goTransfer() {
    if (!window.FoxyWallet || !window.FoxyWallet.transferQuote) return;
    /* Quoting connects to the destination, which makes this a mint switch like
     * any other, and the audit's finding 17 asks every one of them to wait for
     * money that is already moving. */
    if (this.refuseSwitchWhileBusy()) return;
    // the mint to come back to if the transfer is dropped (quoting connects
    // to the destination, and cancelling used to leave the wallet there)
    this._trWas = window.FoxyWallet.mintUrl || '';
    this.setState(p => ({
      screen: 'switchMint', stack: p.stack.concat([p.screen]),
      trStep: 'from', trFrom: '', trTo: '', trSats: 0, trPlan: null, trFee: null, trErr: '',
    }));
  }

  /* A mint tapped on the list while a transfer is being set up. */
  trPick(url) {
    const mint = String(url || '').replace(/\/+$/, '');
    /* Only while one is. The two steps were told apart by 'from' against
     * everything else, so called with no transfer in progress this fell into
     * the second step and began one nobody had asked for. The list only
     * routes a tap here while trStep is set, so this never fired — but it
     * read the flow's state from outside the flow, which is the same shape as
     * the bug above. */
    if (!this.state.trStep) return;
    if (this.state.trStep === 'from') {
      this.setState({ trFrom: mint, trStep: 'to' });
      return;
    }
    this.setState(p => ({
      trTo: mint, trStep: '',
      screen: 'amount', stack: p.stack.concat([p.screen]),
      flow: 'transfer', asset: 'BITCOIN', unit: 'SATS', amount: '',
      note: '', noteDraft: '', recipient: '', recipientKind: '',
    }));
  }

  /* What is at the mint the money leaves, for the keypad's line and its cap. */
  trFromSats() {
    return this.mintPile(this.state.trFrom).sats || 0;
  }

  trNext() {
    const sats = this.amountInSats();
    const have = this.trFromSats();
    if (!(sats > 0)) { this.toast('Enter an amount first', true); return; }
    if (sats > have) {
      this.toast('That is more than the ' + this.mintNameOf(this.state.trFrom) + ' balance.', true);
      return;
    }
    /* The amount typed is what lands at the other mint; the fee comes out of
     * the same pile on top of it. The exact fee is the
     * quote's to say, so the room for it is checked there. */
    this.setState(p => ({
      screen: 'trConfirm', stack: p.stack.concat([p.screen]),
      trSats: sats, trPlan: null, trFee: null, trErr: '', trFits: 0,
    }));
    this.quoteTransfer();
  }

  /* The fee, quoted before anything moves: an invoice at the destination and a
   * melt quote at the source. Nothing is spent by asking. */
  quoteTransfer() {
    const W = window.FoxyWallet;
    const { trFrom, trTo, trSats } = this.state;
    if (!W || !trFrom || !trTo || !(trSats > 0)) return;
    /* Asked again here, not only when the flow opened: between the two the
     * person picks two mints and types an amount, and a payment or a claim can
     * start in that window (finding 17). A quote is cheap to ask again, so
     * this waits on the confirmation screen rather than dropping the flow —
     * the watcher's own claims hold the lock for a moment at a time. */
    if (this.moneyBusy()) {
      this.setState({ trQuoting: false,
        trErr: 'Something else is moving money right now. Try again in a moment.' });
      return;
    }
    this.setState({ trQuoting: true, trErr: '', trFits: 0 });
    Promise.resolve()
      .then(() => (W.mintUrl === trTo ? null : W.connect(trTo)))
      .then(() => W.transferQuote(trFrom, trSats))
      .then(plan => {
        this.setState({ trQuoting: false, trPlan: plan, trFee: plan.feeSats });
      })
      .catch(e => {
        // what would have fitted, when the fee is the only thing in the way
        this.setState({ trQuoting: false, trErr: W.reason(e),
                        trFits: (e && e.foxyFits) || 0 });
      });
  }

  /* Move what the fee leaves room for, instead of the amount that did not fit.
   *
   * Straight back into the quote with the smaller figure: the screen is
   * already the confirmation, and there is nothing to go back to the keypad
   * for. */
  trMoveLess(sats) {
    if (!(sats > 0)) return;
    this.setState({ trSats: sats, trPlan: null, trFee: null, trErr: '', trFits: 0 });
    this.quoteTransfer();
  }

  /* Run it: the source pays the destination's invoice, and the destination
   * issues the ecash. An interrupted one is finished on the next launch
   * (FoxyWallet.finishMove). */
  runTransfer() {
    const W = window.FoxyWallet;
    const plan = this.state.trPlan;
    if (!plan || this.state.trBusy) return;
    // and once more before anything moves, for the same reason
    if (this.refuseSwitchWhileBusy()) return;
    const to = this.mintNameOf(this.state.trTo);
    this.setState({ trBusy: true });
    this.showMelt('Moving your sats to ' + to + '…', 0, { sats: this.state.trSats, mint: to });
    /* Back on the mint the money leaves: the quote was made while connected to
     * the destination, and moveRun pays from whichever wallet is connected —
     * run from the destination it found nothing to spend (seen in the
     * simulator). */
    W.connect(this.state.trFrom).then(() => W.moveRun(plan, () => {})).then(done => {
      this.hideMelt();
      this.setState({ trBusy: false, trPlan: null, trStep: '', trErr: '' });
      this.refreshBalance();
      this.loadHistory();
      this.announcePayment({
        dir: 'out', sats: done.sats || this.state.trSats,
        hash: 'move-' + (plan.mintQuote ? plan.mintQuote.quote : Date.now()),
        to: to, force: true,
      });
    }).catch(e => {
      this.hideMelt();
      this.setState({ trBusy: false, trErr: W.reason(e) });
      this.toast(W.reason(e), true);
    });
  }

  /* Dropped: back to the mint the wallet was on before the quote. */
  trCancel() {
    const W = window.FoxyWallet;
    const back = this._trWas;
    this.setState({ screen: 'home', stack: [], trPlan: null, trStep: '', trErr: '', trBusy: false });
    if (W && back && W.mintUrl !== back) W.connect(back).then(() => this.refreshBalance(), () => {});
  }

  /* The confirmation screen's contents (confirmSpec). */
  transferSpec() {
    const s = this.state;
    const sats = s.trSats || 0;
    const fee = s.trFee;
    const rows = [
      this.cfRow('LANDING AT', (this.mintNameOf(s.trTo) || '').toUpperCase()),
      this.cfRow('PAYING FROM', (this.mintNameOf(s.trFrom) || '').toUpperCase(), { half: true }),
      this.cfRow('NETWORK', 'LIGHTNING', { half: true }),
      this.cfRow('ARRIVES', 'IN A MOMENT', { ink: 'var(--acc)', half: true }),
      this.cfRow('FEE ON TOP', s.trErr ? 'UNKNOWN'
        : fee == null ? 'CHECKING…' : 'UP TO ' + this.money(fee).main, { half: true }),
    ];
    if (s.trErr) {
      /* Only the fee was in the way, and this is how much would go instead.
       * Asking again for the same amount would only be refused again, so that
       * is the button this replaces; CANCEL is still there. */
      const fits = s.trFits || 0;
      return {
        title: 'CONFIRMATION', amountLabel: 'MOVING',
        amount: this.money(sats).main, amountSub: this.money(sats).sub, amountInk: '#FF5C5C', rows: rows,
        warn: s.trErr,
        cta: fits > 0 ? 'MOVE ' + this.money(fits).main + ' INSTEAD' : 'TRY AGAIN',
        ctaTone: fits > 0 ? 'go' : 'warn',
        go: () => { if (fits > 0) this.trMoveLess(fits); else this.quoteTransfer(); },
        secondary: { label: 'CANCEL', go: () => this.trCancel() },
      };
    }
    return {
      title: 'CONFIRMATION',
      amountLabel: 'MOVING',
      amount: this.money(sats).main,
      subtitle: fee == null ? '' : 'Up to ' + this.money(sats + fee).main + ' leaves '
        + (this.mintNameOf(s.trFrom) || 'the other mint'),
      amountSub: this.money(sats).sub,
      rows: rows,
      secondary: { label: 'CANCEL', go: () => this.trCancel() },
      cta: s.trBusy ? 'MOVING…' : fee == null ? 'CHECKING THE FEE…' : 'MOVE ' + this.money(sats).main,
      ctaTone: 'go',
      ctaBusy: !!s.trBusy || fee == null,
      go: () => { if (fee != null && !s.trBusy) this.runTransfer(); },
    };
  }
