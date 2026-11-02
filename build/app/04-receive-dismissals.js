
  // an on-chain receive can't settle while you watch: close drops you home, then the
  // pending screen surfaces once the sender has broadcast
  closeReceive() {
    this.stopReceive();
    clearTimeout(this._slideWait);
    if (this._unlisten) this._unlisten();
    if (window.FoxyWallet) { window.FoxyWallet.stopPreview(); window.FoxyWallet.stopPasteButton(); }
    clearTimeout(this._sendA); clearTimeout(this._sendB); clearInterval(this._eta);
    // home, or in the till its SET AMOUNT, for the next customer (26m-till.js, `homeState`)
    this.setState(Object.assign({ noteOpen: false }, (this.homeState ? this.homeState() : { screen: 'home', stack: [] })));
  }

  // leaving the pending receive: the confirmation lands a beat after the home screen does
  dismissPending() {
    if (this.state.sendExit) return;
    clearInterval(this._eta);
    clearTimeout(this._sendA); clearTimeout(this._sendB);
    this.setState({ sendExit: true });
    // when the PAID below lands: a till whose code has run out waits for it before it leaves (26m-till.js, `tillMidPayment`)
    this._paidDueAt = Date.now() + 1600;
    setTimeout(() => {
      this.setState(Object.assign({ recvPending: false, sendExit: false }, (this.homeState ? this.homeState() : { screen: 'home', stack: [] })));
      // (the one way onto the screen that says no figure of its own: the keypad's stands, not one an earlier screen left behind)
      this._sendA = setTimeout(() => this.setState(p => ({
        screen: 'paid', recvResolved: true, recv: Object.assign({}, p.recv, { live: 'in' }), paidAmount: null,
      })), 1000);
    }, 380);
  }

  // leaving the on-chain screen: the confirmation lands a beat after the home screen does
  dismissOnchain() {
    if (this.state.sendExit) return;
    clearInterval(this._eta);
    clearTimeout(this._sendA); clearTimeout(this._sendB);
    this.setState({ sendExit: true });
    setTimeout(() => {
      this.setState(Object.assign({ sendExit: false }, (this.homeState ? this.homeState() : { screen: 'home', stack: [] })));
      this._sendA = setTimeout(() => this.setState({ screen: 'sendDone', sendPhase: 'done' }), 1000);
      this._sendB = setTimeout(() => this.setState({ sendPhase: 'settled' }), 2700);
    }, 380);
  }
