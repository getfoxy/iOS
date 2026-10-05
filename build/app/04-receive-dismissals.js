
  // an on-chain receive can't settle while you watch: close drops you home, then the
  // pending screen surfaces once the sender has broadcast
  closeReceive() {
    this.stopReceive();
    clearTimeout(this._slideWait);
    if (this._unlisten) this._unlisten();
    if (window.FoxyWallet) { window.FoxyWallet.stopPreview(); window.FoxyWallet.stopPasteButton(); }
    clearTimeout(this._sendA); clearTimeout(this._sendB); clearInterval(this._eta);
    this.setState({ screen: 'home', stack: [], noteOpen: false });
  }

  // leaving the pending receive: the confirmation lands a beat after the home screen does
  dismissPending() {
    if (this.state.sendExit) return;
    clearInterval(this._eta);
    clearTimeout(this._sendA); clearTimeout(this._sendB);
    this.setState({ sendExit: true });
    setTimeout(() => {
      this.setState({ screen: 'home', stack: [], recvPending: false, sendExit: false });
      this._sendA = setTimeout(() => this.setState(p => ({
        screen: 'paid', recvResolved: true, recv: Object.assign({}, p.recv, { live: 'in' }),
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
      this.setState({ screen: 'home', stack: [], sendExit: false });
      this._sendA = setTimeout(() => this.setState({ screen: 'sendDone', sendPhase: 'done' }), 1000);
      this._sendB = setTimeout(() => this.setState({ sendPhase: 'settled' }), 2700);
    }, 380);
  }
