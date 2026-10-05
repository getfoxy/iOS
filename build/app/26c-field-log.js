  /* ERRORS and LOGS: what Foxy has been doing, so it can be handed over.
   *
   * One screen, two ways in. ERRORS is the short list — the lines that read as
   * trouble — and LOGS is everything, which is what a hard question usually
   * needs: the screens visited, the mint requests, Tor's state, the timings.
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
    this.setState(p => ({
      screen: 'fieldLog', stack: p.stack.concat([p.screen]),
      flLines: null, flBad: !!onlyBad, flCopied: false,
    }));
    this.loadFieldLog(!!onlyBad);
  }

  loadFieldLog(onlyBad) {
    const W = window.FoxyWallet;
    if (!W || !W.fieldLog) { this.setState({ flLines: [] }); return; }
    W.fieldLog(onlyBad).then(lines => {
      // newest first: what just went wrong is what someone is looking for
      this.setState({ flLines: (lines || []).slice().reverse() });
    }, () => this.setState({ flLines: [] }));
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
    const head = 'Foxy ' + (this.state.flBad ? 'errors' : 'log') + ', '
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
