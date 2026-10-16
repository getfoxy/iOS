  /* ERRORS and LOGS: what Foxy has been doing, so it can be handed over.
   *
   * One screen, three ways to look. ALL is everything, which is what a hard
   * question usually needs: the screens visited, the mint requests, Tor's
   * state, the timings. ERRORS is the short list — the lines that read as
   * trouble. CONNECTION is the connection diary (`flIsDiary`): each mint
   * request's time out and back, its circuit and outcome, the asks on another
   * circuit, the network's changes, Foxy going to the background and coming
   * back, and Tor's own lines — what a mint's operator needs to read a slow
   * request from this side.
   *
   * The lines come from the phone (FoxyWallet.fieldLog → FieldLog.swift), in
   * every build, and are redacted there rather than here: tokens, invoices,
   * payment requests, onion addresses, nostr keys and long hex are gone before
   * the page sees them, so this screen cannot copy out what it never had. Mint
   * hosts and sat amounts stay, because without them a report cannot be
   * answered — and the screen says that in as many words before anyone copies.
   *
   * Nothing is sent anywhere. There is no reporting in Foxy and this does not
   * add any: the lines are memory on the phone, and the only way out is the
   * person tapping COPY and choosing where to paste it.
   */
  goFieldLog(onlyBad) {
    const view = onlyBad ? 'bad' : 'all';
    this.setState(p => ({
      screen: 'fieldLog', stack: p.stack.concat([p.screen]),
      flLines: null, flView: view, flCopied: false,
    }));
    this.loadFieldLog(view);
  }

  /* Another way to look, from the row under the title: the same screen, the
   * lines read again, and COPY then copies what is shown. */
  flShow(view) {
    if (this.state.flView === view && this.state.flLines !== null) return;
    this.setState({ flLines: null, flView: view, flCopied: false });
    this.loadFieldLog(view);
  }

  /* The connection diary's lines, by what they start with or say. Matched
   * anywhere in the line, as FieldLog's own kept lines are: the page's reach
   * the log wrapped ("[foxy-js] +195ms [log] [foxy] …"), and last run's carry
   * "last run · " in front. */
  flIsDiary(text) {
    const t = String(text || '');
    return [
      /* each mint request (NetDiary.swift), and one that never left and was sent again.
       * Not Route.start's "[foxy] route:" refusal: a mint request it refuses has
       * its own net: line saying so, and one refusal is not shown twice. */
      '[foxy] net:', '[foxy] mint request to',
      // the network, the app's comings and goings, and Tor
      '[foxy] network:', '[foxy] app:', '[foxy] wake:', '[foxy] tor', '[foxy] orbot:',
      '[foxy] tunnel:', '[foxy] simulator: pretend airplane mode',
      // the asks on another circuit (askedAgain, statesOf, nativeRequest's 429 and lock retries)
      'on another circuit', 'mint busy (lock), asked again',
    ].some(k => t.indexOf(k) >= 0);
  }

  loadFieldLog(view) {
    const W = window.FoxyWallet;
    // only the newest question's answer is shown: a tap on another view overtakes the one before
    const ask = (this._flAsk = (this._flAsk || 0) + 1);
    const show = (lines) => { if (ask === this._flAsk) this.setState({ flLines: lines }); };
    if (!W || !W.fieldLog) { show([]); return; }
    W.fieldLog(view === 'bad').then(lines => {
      const all = lines || [];
      const kept = view === 'net' ? all.filter(l => this.flIsDiary(l && l.text)) : all;
      // newest first: what just went wrong is what someone is looking for
      show(kept.slice().reverse());
    }, () => show([]));
  }

  /* One line as it is copied and shown: the time, then the text.
   *
   * A time of day rather than a stamp — someone reading their own log is
   * matching it against "it went wrong just after I tapped send", not against
   * another clock. */
  flStamp(at) {
    const d = new Date(Number(at) || 0);
    const two = n => (n < 10 ? '0' : '') + n;
    return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  flText() {
    const lines = this.state.flLines || [];
    const view = this.state.flView;
    const head = 'Foxy ' + (view === 'bad' ? 'errors' : view === 'net' ? 'connection diary' : 'log') + ', '
      + lines.length + ' line' + (lines.length === 1 ? '' : 's')
      + ', newest first. Tokens, invoices, payment requests, onion addresses and '
      + 'keys are already removed; mint hosts and amounts are not.';
    // back to oldest first for reading: a log is a story
    const body = lines.slice().reverse()
      .map(l => this.flStamp(l.at) + '  ' + String(l.text || '')).join('\n');
    return head + '\n\n' + body + '\n';
  }

  copyFieldLog() {
    const lines = this.state.flLines || [];
    if (!lines.length) { this.toast('There is nothing to copy yet.', true); return; }
    /* Device-only and short-lived, like every other copy Foxy makes: the log
     * names mint hosts and amounts, and that is not for every Mac and iPad
     * signed into the same account (copySecret). */
    if (this.copySecret(this.flText())) this.setState({ flCopied: true });
    else this.toast('Could not copy', true);
  }

  /* SHARE, beside COPY ALL, because a log is not a thing to paste.
   *
   * COPY ALL was the only way out of this screen, and it puts two thousand
   * lines on the clipboard for somebody to paste into a message. That is fine
   * for a line or two and hopeless for a session: long pastes are truncated by
   * some apps, the clipboard expires, and nobody scrolls it to check.
   *
   * The share sheet hands the same text to Files, Mail, AirDrop — whatever the
   * person already uses — as one thing they can attach. It matters most on a
   * Release build, where this screen is the only record that exists: `print` is
   * silent, `DebugLog` is not compiled in, and a tester who cannot get the log
   * off the phone has no way to be believed. */
  shareFieldLog() {
    const W = window.FoxyWallet;
    const lines = this.state.flLines || [];
    if (!lines.length) { this.toast('There is nothing to share yet.', true); return; }
    if (!W || !W.share || !W.share(this.flText())) {
      this.toast('Sharing is only available in the app.', true);
    }
  }

  clearFieldLog() {
    const W = window.FoxyWallet;
    this.blockedCard('clearLog', {
      tone: 'ask',
      title: 'CLEAR THE LOG?',
      reason: 'Everything Foxy remembers about what it has been doing is forgotten. '
        + 'It starts again from here. Nothing about your money changes.',
      retry: 'CLEAR IT',
      go: () => {
        if (!W || !W.clearFieldLog) return;
        W.clearFieldLog().then(() => {
          this.setState({ flLines: [], flCopied: false });
          this.toast('The log was cleared');
        });
      },
      shut: { label: 'KEEP IT' },
    });
  }
