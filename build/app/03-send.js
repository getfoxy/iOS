
  // ---- account levels ----









  // verification is one-time: once verified we never ask again, we just do the thing.
  // external bank still has to be linked, and a withdraw resumes once it is.


  // a scanned invoice with no amount drops you into the same keypad as receive
  openTx(t) {
    this.setState(p => ({ screen: 'txDetail', stack: p.stack.concat([p.screen]), tx: t }));
  }

  /* What `sats` of this entry were worth in cents when it settled, or null
   * where the entry carries no price of its own. `rate` is dollars per
   * bitcoin, written once by the wallet (`logTx`) and never again. */
  txFiat(t, sats) {
    const rate = Number(t && t.rate) || 0;
    if (!(rate > 0)) return null;
    return Math.round((Math.round(Number(sats) || 0) / 1e8) * rate * 100);
  }

  /* An amount, dollars first.
   *
   * People using this are thinking in dollars, so dollars are the figure and
   * the sats are the line under it. Every screen that
   * shows money asks here, so the rule is in one place: `main` is dollars
   * where there is a price to say them at and the sats where there is not —
   * never a dollar figure invented from no price — and `sub` is the sats
   * whenever dollars took the top line.
   *
   * `fiatCents` is a dollar amount already fixed, which history entries carry
   * from the moment they settled. Given, it is used as it stands and the
   * price of bitcoin today has no say in it. */
  money(sats, fiatCents) {
    const n = Math.round(Number(sats) || 0);
    const btc = '\u20bf ' + this.group(n);
    const fixed = fiatCents != null && isFinite(Number(fiatCents));
    const rate = this.satUsd ? this.satUsd() : 0;
    if (!fixed && !rate) return { main: btc, sub: '', usd: null };
    const usd = fixed ? Number(fiatCents) / 100 : n * rate;
    /* Not "$0.00" for something that is not nothing: a one-sat fee is under a
     * cent and is still a fee. */
    const text = (n > 0 && usd < 0.005) ? '< $ 0.01' : '$ ' + this.usd(usd);
    return { main: text, sub: btc, usd: usd };
  }

  usd(v) {
    if (v == null || !isFinite(v)) return '···';
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // a pasted invoice is 200-odd characters; five each end fits on one line
  shortId(v) { return v.length > 14 ? v.slice(0, 5) + '…' + v.slice(-5) : v; }

  /* Ask the mint what this invoice would cost. Commits to nothing. */
  quoteSendFee() {
    const W = window.FoxyWallet;
    const s = this.state;
    if (!W || !W.quoteFee) return;
    const inv = s.recipientKind === 'invoice' ? s.recipient : null;
    const target = inv || s.recipient || '';
    if (!target || this._quotedFor === target) return;
    this._quotedFor = target;

    /* Clear first, quote second.
     *
     * An earlier version only cleared when there was an invoice to quote. A
     * lightning address has none until LNURL resolves it during the send, so
     * that path kept the previous payment's fee on screen — a 200-sat payment
     * that cost 1, then a 9,862-sat payment still showing 1 when it cost 15.
     *
     * Where no quote is possible the row says UNKNOWN, which is true. */
    if (!inv) {
      this.setState({ quotingFee: false, quotedFee: null, sendFee: null });
      return;
    }
    /* Clear the last payment's fee.
     *
     * sendFee is written when a payment succeeds and was never cleared, and
     * the FEE row reads it before the quote. So a second payment showed the
     * first one's fee — a same-mint payment costing 0, followed by a
     * cross-mint one that actually cost 29, still displayed 0. A stale number
     * stated confidently is worse than UNKNOWN. */
    this.setState({ quotingFee: true, quotedFee: null, sendFee: null });
    W.quoteFee(inv).then(q => {
      this.setState({ quotingFee: false, quotedFee: q ? q.feeReserve : null });
    }).catch(() => {
      /* Let the next render try again. This was set before the request and
       * never cleared, and componentDidUpdate's guard then returned on every
       * pass — so one failed quote, which over Tor is ordinary, left the
       * confirmation reading UNKNOWN for that invoice for the whole session. */
      this._quotedFor = null;
      this.setState({ quotingFee: false });
    });
  }

  startSend() {
    const onchain = this.state.recipientKind === 'address';
    this.setState(p => ({ screen: 'sendDone', stack: p.stack.concat([p.screen]), sendPhase: onchain ? 'onchain' : 'in', etaLeft: 600 }));
    clearTimeout(this._sendA); clearTimeout(this._sendB); clearInterval(this._eta);
    if (onchain) {
      /* On chain settles in about ten minutes: the screen holds a live
       * countdown. It stops at zero — it used to go on calling setState every
       * second for the life of the app, a render a second behind whatever
       * screen the person had moved on to (the timer sweep). */
      this._eta = setInterval(() => this.setState(p => {
        const left = Math.max((p.etaLeft || 0) - 1, 0);
        if (!left) clearInterval(this._eta);
        return { etaLeft: left };
      }), 1000);
      return;
    }
    const W = window.FoxyWallet;
    if (!W || !W.connected) {
      // a card over the confirmation, rather than a screen instead of it
      this.blockedCard('netLost', {
        /* Back to the confirmation, as the failure path below does.
         *
         * The sending screen's only buttons are gated on onchainSending and
         * sentDone, and neither is set while sendPhase is 'in' — so with no
         * onClose here, closing this card left the person on a SENDING screen
         * with no button at all, and the edge swipe deliberately refuses to go
         * back while a send is in flight. The only way out was relaunching. */
        onClose: () => {
          if (this.state.screen === 'sendDone' || this.state.sendPhase) {
            this.setState({ screen: 'sendConfirm', sendPhase: null });
          }
        },
      });
      return;
    }
    // a lightning address has to be resolved into an invoice first
    const to = String(this.state.recipient || '');
    console.log('[foxy] send starting to', to.slice(0, 24),
      '|', (window.FoxyGate && window.FoxyGate.stamp) ? window.FoxyGate.stamp() : 'no gate');

    // Tor can drop while the app sits open, and a melt is the one call that
    // tells the mint where money went. The native side refuses it without Tor
    // either way; this gives a reconnect a moment, and says so if it does not.
    const G = window.FoxyGate;
    if (G && G.recheck) {
      const fresh = G.recheck();
      if (fresh && fresh.then) {
        return fresh.then(ok => {
          if (!ok) {
            // not silent: a send that stops with nothing on screen reads as a hang
            console.log('[foxy] send stopped: Tor is reconnecting');
            this.blockedCard('netLost', {
              title: 'RECONNECTING TO TOR',
              reason: 'Foxy lost its Tor connection and is getting it back. Nothing was sent.',
              onClose: () => {
                if (this.state.screen === 'sendDone' || this.state.sendPhase) {
                  this.setState({ screen: 'sendConfirm', sendPhase: null });
                }
              },
              retry: 'TRY AGAIN', back: '',
              go: () => this.startSend(),
            });
            return;
          }
          this.startSendNow(to);
        });
      }
    }
    return this.startSendNow(to);
  }

  /* A payment still going through: said so, with no way to pay it again.
   *
   * A pending melt used to show the settled screen, and a held one fell
   * through to CONNECTION LOST with TRY AGAIN — an invitation to pay twice. */
  showPayPending() {
    const W = window.FoxyWallet;
    this.blockedCard('payPending', {
      tone: 'warn',
      title: 'PAYMENT PENDING',
      reason: 'This payment is still going through. Foxy is holding the ecash and '
        + 'will settle it when the mint answers. Do not pay this again.',
      onClose: () => {
        this.setState({ screen: 'home', stack: [], sendPhase: null });
        this.refreshBalance();
        this.loadHistory();
      },
    });
    /* Twice: at 30 s for a payment that settles quickly, and at 150 s, past the
     * two minutes before the sweep gives back a hold that reads UNPAID or
     * PENDING with its ecash untouched. */
    if (W && W.sweepMelts) {
      [30000, 150000].forEach(ms => setTimeout(() => {
        W.sweepMelts().then(() => this.refreshBalance()).catch(() => {});
      }, ms));
    }
  }

  /* A payment typed in dollars: its sats come from a price two sources agree
   * on, asked for as the confirmation opens. The first source to answer used
   * to decide alone, and its sats were what went. Until an agreed price is in,
   * the confirmation cannot send; if no two sources agree, it says so. */
  checkSendPrice() {
    const W = window.FoxyWallet;
    const val = parseFloat(this.state.amount) || 0;
    const run = this._priceCheck = (this._priceCheck || 0) + 1;
    this.setState({ sendSats: null, sendPriceCheck: 'checking' });
    if (!W || !W.agreedRate) { this.setState({ sendPriceCheck: 'failed' }); return; }
    W.agreedRate().then(px => {
      if (run !== this._priceCheck || this.state.screen !== 'sendConfirm') return;
      const sats = Math.round(val / px * 1e8);
      this.setState(sats > 0 ? { sendSats: sats, sendPriceCheck: 'agreed' } : { sendPriceCheck: 'failed' });
    }, e => {
      if (run !== this._priceCheck || this.state.screen !== 'sendConfirm') return;
      console.warn('[foxy] send price:', e && e.message);
      this.setState({ sendPriceCheck: 'failed' });
    });
  }

  startSendNow(to) {
    const W = window.FoxyWallet;
    const P = window.FoxyProgress;
    // an invoice already held in a payment is not paid a second time
    const inv = String(to || '').trim().replace(/^lightning:/i, '');
    const want = inv.toLowerCase();
    // an invoice read from an uppercase QR is the same invoice; a lightning
    // address gets a fresh invoice every time, so it is matched by the address
    if (W && W.pendingMelts && W.pendingMelts().some(m => m && (
      (m.bolt11 && m.bolt11.toLowerCase() === want) || (m.payee && m.payee === want)))) {
      this.showPayPending();
      return;
    }
    /* One send at a time. The 150-second backstop below ends the wait, not
     * the payment: the wallet call keeps running, and a second send started
     * then queued behind it and paid again. */
    if (this._sendRun) {
      this.showPayPending();
      return;
    }
    console.log('[foxy] overlay module:', P ? (P.complete ? 'has complete()' : 'OLD - no complete()') : 'NOT LOADED');
    if (P) P.begin();
    const onStage = n => { console.log('[foxy] stage', n); if (P) P.stage(n); };
    /* A send that never answers must still end.
     *
     * A lightning address with no timeout on its fetches left the app on
     * "sending" indefinitely: the overlay finished, nothing rejected, and
     * there was no card and no way back. The fetches have deadlines now, but
     * a promise that never settles must not be able to strand the screen —
     * whatever the reason. This is the backstop, well beyond any individual
     * call's own limit. */
    /* Sats for an invoice that names none. Worked out the same way an LNURL's
     * are: typed in sats it is what was typed, typed in dollars it is only the
     * figure two price sources agreed on (checkSendPrice). `pay` refuses the
     * pair if the invoice does carry an amount, so this is never a way to send
     * something other than what the payee asked for. */
    const typed = this.state.unit === 'SATS' ? this.wantedSats() : (this.state.sendSats || 0);
    const run = W.classify(to) === 'lnurl'
      ? W.payLnurl(to, typed, '', onStage)
      : W.pay(to, onStage, W.amountOf(to) ? undefined : { sats: typed });
    this._sendRun = run;
    const settled = () => { if (this._sendRun === run) this._sendRun = null; };
    run.then(settled, settled);
    const job = Promise.race([
      run,
      // pending, not failed: the payment may still be going, so no TRY AGAIN
      new Promise((_, no) => setTimeout(() => {
        const e = new Error('This is taking longer than it should. '
          + 'Check your history before trying again \u2014 it may have gone through.');
        /** @type {any} */ (e).pending = true;
        no(e);
      }, 150000)),
    ]);
    job.then(r => {
      if (r && r.pending) {
        console.log('[foxy] send pending');
        if (P) P.end();
        W.tag(r.hash, { to: to, note: (this.state.note || '').trim() });
        this.showPayPending();
        return;
      }
      console.log('[foxy] send complete');
      W.tag(r.hash, { to: to, note: (this.state.note || '').trim() });
      // an invoice a tap offered: the other phone is told, over the link that is still open
      if (this.tapPaidByLightning) this.tapPaidByLightning(to);

      const showDone = () => {
        console.log('[foxy] showDone: switching to the confirmation');
        // tear the overlay down here too — whatever happens inside the module,
        // nothing from the send should survive into the confirmation
        if (P && P.end) P.end();
        // Straight to 'settled', in ONE state change. Going 'done' first and
        // 'settled' a beat later rendered the confirmation twice: once bare,
        // then again with its white flash and falling bolts, which belong to
        // the settled phase.
        /* On the instance, not in state.
         *
         * The fee went into state twice and was lost both times — once
         * cleared by the confirmation's quote, once written to a key nothing
         * set because the script that added it died on an assertion before
         * writing. A field on the component is set here and read during the
         * render this setState triggers, and nothing else can touch it. */
        this._lastFee = Math.max(0, Number(r.feeSats || 0));
        this.setState({ sendPhase: 'settled', sendFee: r.feeSats, note: '', noteDraft: '' });
      };

      // Nothing heavy runs while the burst is playing. refreshBalance() and
      // loadHistory() both fetch and then re-render a large tree, and doing
      // that here blocked the main thread through the whole completion — the
      // overlay's writes landed in memory but nothing repainted until the
      // thread freed up, which is why the confirmation appeared to overtake
      // an animation the log said had already finished.
      const settleUp = () => {
        console.log('[foxy] settleUp: refreshing balance and history now');
        // The refresh runs behind the overlay, so the pill already holds the
        // new figure by the time the confirmation is dismissed — and a count-up
        // from the new number to the new number shows nothing. Keep the old
        // one so the animation has somewhere to start.
        if (this._preSettle == null) this._preSettle = this.balNow();
        this.refreshBalance();
        this.loadHistory();
        // and the small pieces this payment used are made again, now
        if (this.tidyChangeNow) this.tidyChangeNow();
      };

      if (P && P.complete) {
        // Refresh WHILE the overlay still covers the screen, not after the
        // confirmation has landed. Doing it afterwards re-rendered the
        // confirmation and replayed its flash and falling bolts, which read as
        // the green screen arriving a second time.
        P.whenFull(settleUp);
        P.complete(showDone, 500);
      } else {
        this._sendA = setTimeout(() => { showDone(); settleUp(); }, 400);
      }
    }).catch(e => {
      const m = String((e && e.message) || '');
      console.error('[foxy] send failed:', e);
      if (P) P.end();
      // stopped by the person before it was made: they are home already
      if (e && e.foxyStopped) return;
      // held, not failed: the pending card, never TRY AGAIN
      if (e && e.pending) { this.showPayPending(); return; }
      // before the classification below, which would call "invalid" a refusal and offer TRY AGAIN
      if (this.isBadSignatures(e)) {
        this.badSignatureCard(null, 'pay', () => {
          if (this.state.screen === 'sendDone' || this.state.sendPhase) this.setState({ screen: 'sendConfirm', sendPhase: null });
        });
        return;
      }

      /* A card over the confirmation, not a screen instead of it.
       *
       * These four used to be full screens and they render black in this
       * build, so a failed send stranded you. The classification is unchanged;
       * only where it lands is. */
      /* A refusal is not a connection problem.
       *
       * Anything unrecognised used to land on netLost — "CONNECTION LOST" —
       * so a mint declining an already-paid invoice showed a connection card
       * with "Invoice already paid" written under it. The message was right
       * and the title sent people to check their wifi.
       *
       * The mint answering "no" is its own category: it replied, clearly, and
       * the answer was no. */
      const refused = /already paid|already spent|expired|not paid|quote|invalid|unsupported/i.test(m)
        /* A mint that will not pay an amountless invoice is saying no, clearly,
         * and it landed on CONNECTION LOST — which blames the network for an
         * answer the mint gave in 22 ms. Anything naming the mint and what it
         * will not do belongs with the other refusals. */
        || /does not pay|names no amount|already names an amount/i.test(m);
      /* Saying no to "Allow Foxy to contact this address" is not a connection
       * problem, and CONNECTION LOST blamed the network for the person's own
       * answer. It is about the address. */
      const kind = /did not allow Foxy/i.test(m) ? 'badAddress'
        : /insufficient|balance|not enough/i.test(m) ? 'sendFail'
        : /route|path/i.test(m) ? 'lnNoRoute'
        : /address|lnurl|answer|receive payments/i.test(m) ? 'badAddress'
        : refused ? 'mintRefused'
        : 'netLost';

      /* Off the sending screen now, not when the card is closed. A card that
       * was queued behind another never showed, the screen sat on SENDING, and
       * `sendPhase` stayed 'in', which also stops this phone listening for a
       * tap. */
      if (this.state.screen === 'sendDone' || this.state.sendPhase) {
        this.setState({ screen: 'sendConfirm', sendPhase: null, sendSlow: false });
      }

      // not enough money needs a different amount, not another attempt
      const again = (kind === 'sendFail') ? null : () => this.startSend();

      /* CLOSE must not strand you on the sending screen.
       *
       * blockedCard leaves you where you were, which is right when a failure
       * arrives over the home screen. Here the progress overlay has gone, the
       * payment did not happen, and that screen has nothing on it — closing
       * left no way out. Back to the confirmation, where the buttons are. */
      this.blockedCard(kind, {
        title: kind === 'mintRefused' ? 'THE MINT SAID NO' : undefined,
        reason: W.reason(e),
        retry: again ? 'TRY AGAIN' : 'CHANGE AMOUNT',
        back: again ? '' : 'amount',
        go: again,
        onClose: () => {
          /* Back to the send confirmation — 'sendConfirm', not 'confirm'.
           *
           * 'confirm' is the receive invoice screen. Sending someone there
           * after a failed payment is worse than the dead end it replaced. */
          if (this.state.screen === 'sendDone' || this.state.sendPhase) {
            this.setState({ screen: 'sendConfirm', sendPhase: null });
          }
        },
      });
    });
  }
