
  // ---- account levels ----









  // verification is one-time: once verified we never ask again, we just do the thing.
  // external bank still has to be linked, and a withdraw resumes once it is.


  // a scanned invoice with no amount drops you into the same keypad as receive
  openTx(t) {
    this.setState(p => ({ screen: 'txDetail', stack: p.stack.concat([p.screen]), tx: t }));
    this.receiptCheck(t);
  }

  /* A payment locked to the phone that asked for it, looked at: the mint is
   * asked whether its pieces were spent, and by whose signature
   * (`lockedReceipt`). Once, as the screen opens; the answer is kept on the
   * payment's record, and the screen is drawn again when it changes anything.
   * Only where there is something to ask about and a way to ask. */
  receiptCheck(t) {
    const W = window.FoxyWallet;
    if (!t || t.dir !== 'out' || !t.hash || !W || !W.lockedReceipt || !W.auditTrail) return;
    if (this.offlineNow && this.offlineNow()) return;
    const rec = (W.auditTrail(t.hash) || [])[0];
    if (!rec || !rec.lockedTo || rec.slim || rec.spent || !(rec.inputs || []).length) return;
    W.lockedReceipt(t.hash).then((got) => {
      if (got && this.state.screen === 'txDetail' && this.state.tx && this.state.tx.hash === t.hash) {
        this.setState({ txReceiptAt: got.at });
      }
    }, () => {});
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

  /* The sats being sent, as the keypad and the price check settle them: what
   * was typed in sats, or what two price sources agreed a typed dollar amount
   * comes to (`checkSendPrice`). Nought until that is known. */
  typedSats() {
    return this.state.unit === 'SATS' ? this.wantedSats() : (this.state.sendSats || 0);
  }

  /* And the sats this payment sends: an invoice's own amount, which the payee
   * signed, else what was typed. */
  sendSatsNow() {
    const W = window.FoxyWallet;
    const s = this.state;
    const own = (s.recipientKind === 'invoice' && s.recipient && W && W.amountOf) ? W.amountOf(String(s.recipient)) : 0;
    return own || this.typedSats();
  }

  /* What the send confirmation asks of the network before it offers SEND, or
   * null when it asks nothing.
   *
   *   an invoice ............ { key, inv }         the mint's fee quote on it
   *   a lightning address ... { key, addr, sats }  an invoice from the address
   *                           for these sats, then the fee quote on that
   *
   * `key` names the question, so another invoice, another address or another
   * amount is a new one. An invoice that names no amount cannot be quoted
   * without one (`pay` quotes it with the amount typed, at SEND), so it asks
   * nothing; an address waits for its amount, which typed in dollars is not
   * known until two price sources have agreed on it (`checkSendPrice`). */
  sendAsk() {
    const W = window.FoxyWallet;
    const s = this.state;
    const raw = String(s.recipient || '');
    if (!W || !raw) return null;
    if (s.recipientKind === 'invoice') return (W.amountOf && W.amountOf(raw)) ? { key: raw, inv: raw } : null;
    const addr = raw.trim().replace(/^lightning:/i, '');
    if (s.recipientKind === 'email' && W.lookupLnurl && W.classify && W.classify(addr) === 'lnurl') {
      const sats = this.typedSats();
      return sats > 0 ? { key: addr + '|' + sats, addr: addr, sats: sats } : null;
    }
    return null;
  }

  /* Is there a question this confirmation has yet to ask? Yes from the moment
   * a route is there until `quoteSendFee` has started it, so the button never
   * reads SEND in between. Not without a route: that is no question, and the
   * fee reads UNKNOWN. */
  sendToAsk() {
    const W = window.FoxyWallet;
    const ask = this.sendAsk();
    return !!(ask && W && W.quoteFee && !this.offlineNow() && this._quotedFor !== ask.key);
  }

  /* Ask what this payment would cost. Commits to nothing.
   *
   * For an invoice that is the mint's quote on it. A lightning address has no
   * invoice yet, so the address is asked for one first (`lookupLnurl`) and the
   * quote is asked on what it gave: SEND pays that very invoice, with that
   * quote (`startSendNow`). While this is out the button says CHECKING, and
   * once the quote is in the sum the wallet will refuse on is compared with
   * the balance before the button is live (`confirmSpec`).
   *
   * Over a route only. A connection that is on its way is waited for, and
   * this is called on every update (`syncSend`), the route coming being one
   * of them, so it starts by itself the moment the route is up and the person
   * presses nothing. With none coming there is nothing to ask, and the fee
   * reads UNKNOWN as it always did when no quote was possible.
   *
   * An answer that does not come, or comes empty, ends the question: the fee
   * reads UNKNOWN and SEND does the whole of it as it did before the screen
   * asked anything, the address looked up again at that point. */
  quoteSendFee() {
    const W = window.FoxyWallet;
    const s = this.state;
    if (!W || !W.quoteFee) return;
    const ask = this.sendAsk();
    const target = ask ? ask.key : String(s.recipient || '');
    if (!target || this._quotedFor === target) return;

    /* Clear first, quote second.
     *
     * An earlier version only cleared when there was an invoice to quote. A
     * lightning address has none until LNURL resolves it, so that path kept
     * the previous payment's fee on screen — a 200-sat payment that cost 1,
     * then a 9,862-sat payment still showing 1 when it cost 15.
     *
     * Where no quote is possible the row says UNKNOWN, which is true.
     *
     * sendFee is written when a payment succeeds and was never cleared, and
     * the FEE row reads it before the quote. So a second payment showed the
     * first one's fee — a same-mint payment costing 0, followed by a
     * cross-mint one that actually cost 29, still displayed 0. A stale number
     * stated confidently is worse than UNKNOWN. */
    /* At a mint with two balances both are quoted, in parallel (a melt
     * quote is free), so the confirmation can say what each would cost and
     * pay from the one that covers it (`autoWallet`). Each is taken as it
     * lands (`feeQuoteIn`), so the button waits on the balance that pays and
     * not on the other. From a card, the one quote, in what the card holds
     * (`cardSendNow`): a dollar card's in dollars. */
    const cardOut = !!(this.cardSendNow && this.cardSendNow());
    const two = !!(this.twoUnitsOn && this.twoUnitsOn() && W.quoteFeeBoth) && !cardOut;
    // (a card of software 1.23 that holds both: the currency chosen to pay from, 26f-flashcard.js `fcUnit`)
    const cardUnit = (cardOut && this.state.fc && (this.fcUnit ? this.fcUnit() : this.state.fc.unit) === 'usd') ? 'usd' : '';
    const clear = (more) => {
      this._feeQuote = null;
      this._found = null;
      // a question of two balances, and what was dropped of one, belongs to that question alone (a card's, say, has neither)
      this._feeQuotes = null;
      this._feeDropped = null;
      this.setState(Object.assign({ quotedFee: null, quotedAmt: null, sendFee: null }, two ? { feeQ: null } : {}, more));
    };
    if (!ask) {
      this._quotedFor = target;
      clear({ quotingFee: false });
      return;
    }
    if (this.offlineNow()) {
      // not asked yet, so not marked: cleared the once, and asked when the route is up
      if (this._feeClearedFor !== target) { this._feeClearedFor = target; clear({ quotingFee: false }); }
      return;
    }
    this._quotedFor = target;
    this._feeClearedFor = null;
    // an answer to an older question is nothing to this one
    const run = this._askRun = (this._askRun || 0) + 1;
    const stale = () => run !== this._askRun;
    clear({ quotingFee: true });
    // which balances' quotes have landed for this question: none yet (`feeQuoteIn`, `feeWaits`)
    if (two) this._feeQuotes = {};
    // not called on this turn: a wallet that refuses at once (no route after all) must not throw out of an update
    Promise.resolve().then(() => (ask.addr ? W.lookupLnurl(ask.addr, ask.sats) : { pr: ask.inv })).then(found => {
      if (stale()) return null;
      // kept for SEND: the address is not asked again for this payment (`payLnurl`, opts.found)
      if (ask.addr) this._found = found;
      // a quote not yet in when PAY is pressed is asked no more (`feeQuotesLeft`): `stale` stops its askings again
      return two ? W.quoteFeeBoth(found.pr, (unit, q) => stale() || this.feeQuoteIn(unit, q), stale)
        : cardUnit ? W.quoteFee(found.pr, { unit: cardUnit }) : W.quoteFee(found.pr);
    }).then(q => {
      if (stale()) return;
      if (two) { this.feeQuotesIn(q || {}); return; }
      // kept whole for SEND: a fresh quote for this invoice is not asked for twice (`pay`, opts.quote)
      this._feeQuote = q && q.quote ? q : null;
      this.setState({ quotingFee: false, quotedFee: q ? q.feeReserve : null, quotedAmt: q ? q.amount : null });
    }).catch(e => {
      if (stale()) return;
      console.warn('[foxy] the send confirmation could not ask what the payment costs:', W.reason ? W.reason(e) : e);
      this.setState({ quotingFee: false });
      // and no balance is left waiting on a quote that will not come
      if (two) this.feeQuotesIn({});
    });
  }

  /* Both balances' quotes for this payment, once both are in: what a wallet
   * that does not tell them one at a time says, and the last word of one that
   * does. Each is taken as if it had just landed (`feeQuoteIn`), and one
   * taken already is not taken twice. */
  feeQuotesIn(both) {
    const b = both || {};
    this.feeQuoteIn('sat', b.sat);
    this.feeQuoteIn('usd', b.usd);
  }

  /* One balance's quote for this payment, as it lands (`quoteFeeBoth`): kept
   * whole for SEND (`pay` reuses the quote of the balance that pays), and in
   * state without the wallet object for the screen (`feeQ`). The sat one is
   * also what the confirmation's sat sums read, as at a mint with one
   * balance. `q` is null where the mint gave none; a balance whose quote has
   * not landed has none kept at all (undefined).
   *
   * The button waits on the balance that pays, not on both. A launch asked
   * the two quotes on two fresh circuits; the sats one answered in two
   * seconds and the dollars one in nearly nine, and SEND waited on dollars
   * nobody had chosen. So CHECKING lets go as soon as the balance that pays
   * has a quote it covers (`feeWaits`), and the other's fills in behind it
   * for WALLET's picker, taking nothing away. Only when the balance that pays
   * cannot cover it is the other's waited for, and then the payment is
   * switched to the other where that one covers it (`autoWallet`), as it was
   * when both were waited for. A balance the mint gave no quote for is not
   * switched away from, as before: its fee reads UNKNOWN, and a quote that
   * did not come (a circuit that went nowhere for twenty seconds) says
   * nothing about what the balance holds. */
  feeQuoteIn(unit, q) {
    const u = unit === 'usd' ? 'usd' : 'sat';
    const kept = this._feeQuotes || {};
    if (kept[u] !== undefined) return;
    this._feeQuotes = Object.assign({}, kept, { [u]: q || null });
    const slim = q ? { unit: q.unit || u, amount: q.amount, feeReserve: q.feeReserve, rate: q.rate || null, bolt11: q.bolt11 || '' } : null;
    const patch = { feeQ: Object.assign({ sat: null, usd: null }, this.state.feeQ || {}, { [u]: slim }) };
    if (u === 'sat') {
      this._feeQuote = q && q.quote ? q : null;
      Object.assign(patch, { quotedFee: q ? q.feeReserve : null, quotedAmt: q ? q.amount : null });
    }
    this.setState(patch);
    // the button was let go already: this one is only for the picker
    if (!this.state.quotingFee) return;
    const pick = this.walletNow('send') || 'sat';
    if (this.feeWaits(pick)) return;
    this.setState({ quotingFee: false });
    const all = this._feeQuotes;
    // both in: the other pays where the balance on WALLET is short and the other covers it
    if (all.sat !== undefined && all.usd !== undefined) this.autoWallet(x => this.quoteFits(x));
  }

  /* Whether CONFIRM PAYMENT still waits on a fee quote before `unit` can
   * pay: its own quote not in yet, or in and short while the other balance's
   * is still to come. Not where the mint gave it none: nothing switches on
   * that (`feeQuoteIn`), so the other's is nothing to wait for. Nothing waits
   * once both are in, or where no question of two balances is out. */
  feeWaits(unit) {
    const k = this._feeQuotes;
    if (!k) return false;
    const u = unit === 'usd' ? 'usd' : 'sat';
    if (k[u] === undefined) return true;
    if (k[u] === null || this.quoteFits(u) !== false) return false;
    return k[u === 'usd' ? 'sat' : 'usd'] === undefined;
  }

  /* PAY pressed, at a mint with two balances: the question is over. The
   * other balance's quote, if it is still on its way, is dropped as it lands
   * (an answer to an older question, `quoteSendFee`): never paid with, shown
   * or kept for the next payment, and not asked again on another circuit
   * beside the payment (`quoteFee`, `opts.stop`). It is marked as not given,
   * so nothing waits on it while the payment goes, and remembered as dropped:
   * a send that does not go brings the person back to the confirmation, and
   * there it is asked again (`feeQuotesAgain`). Left as not given, WALLET
   * would offer it as if it covered the payment, and PAY would pay it with no
   * figure ever shown. */
  feeQuotesLeft() {
    const k = this._feeQuotes;
    if (!k) return;
    this._askRun = (this._askRun || 0) + 1;
    const was = this._feeDropped || [];
    this._feeDropped = ['sat', 'usd'].filter(u => k[u] === undefined || was.indexOf(u) >= 0);
    this._feeQuotes = { sat: k.sat === undefined ? null : k.sat, usd: k.usd === undefined ? null : k.usd };
  }

  /* Back on CONFIRM PAYMENT after a send that did not go (`toConfirm`: no
   * connection, Tor reconnecting, the mint refusing), with a balance whose
   * quote was dropped at PAY (`feeQuotesLeft`): that balance is asked again,
   * it alone. The quote that was paid with is kept, for TRY AGAIN. Until the
   * new one is in, that balance waits (CHECKING) if it is picked, and WALLET
   * greys it once it is in and short, as before PAY.
   *
   * Called on every update (`syncSend`), so it is asked once the
   * confirmation is showing again and there is a route, and not before. A
   * new question asks both itself (`quoteSendFee`): a payment to an address,
   * whose invoice was for that one attempt, and one whose price moved. */
  feeQuotesAgain() {
    const left = this._feeDropped;
    if (!left || !left.length) return;
    const W = window.FoxyWallet;
    const k = this._feeQuotes;
    const ask = this.sendAsk();
    if (this.state.screen !== 'sendConfirm' || !k || !ask || this._quotedFor !== ask.key) return;
    if (!W || !W.quoteFee || this.connecting() || this.offlineNow()) return;
    const found = this._found;
    const inv = ask.inv || ((found && found.addr === ask.addr && found.sats === ask.sats) ? found.pr : '');
    this._feeDropped = null;
    if (!inv) return;
    const run = this._askRun;
    const stale = () => run !== this._askRun;
    const kept = Object.assign({}, k);
    left.forEach(u => { delete kept[u]; });
    this._feeQuotes = kept;
    console.log('[foxy] two balances: back on the confirmation, asking again for the ' + left.join(' and ') + ' quote dropped at PAY');
    left.forEach(u => {
      Promise.resolve().then(() => W.quoteFee(inv, { unit: u, stop: stale })).then(q => q, () => null)
        .then(q => { if (!stale()) this.feeQuoteIn(u, q); });
    });
  }

  /* The send confirmation, kept up with the route. Called on every update
   * (componentDidUpdate), and the route coming or going is an update of its
   * own (`onPrivacy` → `routeAt`).
   *
   * While a connection is on its way the confirmation holds its button
   * (CHECKING, `confirmSpec`); what it is waiting for is asked by itself once
   * the route is up (`quoteSendFee`). It remembers that it waited, so that a
   * connection which then does not come, Tor having given up or the network
   * gone, is told at once, in the card a payment gets with no connection
   * (`notOnlineCard`), with the confirmation left under it as it is after any
   * send that is refused. A route that did come says nothing.
   *
   * The dollar price check (`checkSendPrice`) is not among the things waited
   * for: working offline puts the keypad in sats (`syncUnit`), so a payment
   * reaches this screen in dollars only with a route. */
  syncSend() {
    /* First, at a mint with two balances: the CURRENCY screen before a flow's
     * first amount or confirmation, when none is remembered (01-ui-basics.js). */
    if (this.syncWalletAsk) this.syncWalletAsk();
    const s = this.state;
    if (s.screen !== 'sendConfirm') {
      this._sendWaited = null;
      return;
    }
    const key = String(s.recipient || '');
    // a Lightning payment, an invoice or an address: the others (on chain) need a connection their own way
    const lightning = s.recipientKind === 'invoice' || s.recipientKind === 'email';
    if (lightning && this.connecting()) {
      this._sendWaited = key;
    } else if (this._sendWaited === key) {
      this._sendWaited = null;
      if (lightning && this.offlineNow()) this.notOnlineCard();
    }
    this.quoteSendFee();
    this.feeQuotesAgain();
  }

  /* A payment that needs a connection, when there is none and none is coming:
   * told in the card a scanned invoice gets (`acceptTarget`), in the same
   * words for an invoice, and for a lightning address in words that fit it. */
  notOnlineCard() {
    if (this.state.recipientKind === 'invoice') { this.offlineInvoiceCard(); return; }
    this.blockedCard('offlineAddress', {
      tone: 'warn',
      title: 'YOU\u2019RE OFFLINE',
      reason: 'A Lightning address can only be paid with a connection. '
        + 'Ask them for a Cashu request, or reconnect.',
    });
  }

  /* Back to the send confirmation from the sending screen.
   *
   * startSend pushes the confirmation onto the screen stack as it moves to
   * the sending screen. Coming back by setting the screen alone left that
   * entry behind: the stack ended with the confirmation while the
   * confirmation was showing, so the first press of its back arrow popped the
   * entry and changed nothing on screen, and only the second press left.
   * Every return from a send that did not happen comes through here, which
   * drops the entry the sending screen pushed, so one press leaves as it did
   * before SEND. Every trailing entry goes, so a send tried twice does not
   * leave two. */
  toConfirm() {
    this.setState(p => {
      const stack = p.stack.slice();
      while (stack.length && stack[stack.length - 1] === 'sendConfirm') stack.pop();
      return { screen: 'sendConfirm', stack: stack, sendPhase: null, sendSlow: false };
    });
  }

  /* Back to the amount screen from the send confirmation, or from the sending
   * screen over it, with the stack discipline of `toConfirm`: the entry the
   * sending screen pushed goes, every trailing one of it, so nothing of the
   * confirmation is left behind to be gone back to as if it were another
   * screen. A payment that came with its own amount has no amount screen, and
   * this is the screen it came from. */
  toAmount() {
    this.setState(p => {
      const stack = (p.stack || []).slice();
      while (stack.length && stack[stack.length - 1] === 'sendConfirm') stack.pop();
      return { screen: stack.length ? stack.pop() : 'home', stack: stack, sendPhase: null, sendSlow: false };
    });
  }

  startSend() {
    const onchain = this.state.recipientKind === 'address';
    // the quote the confirmation showed is the one paid with; any other still on its way is dropped
    this.feeQuotesLeft();
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
            this.toConfirm();
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
                  this.toConfirm();
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

  /* `o`: a payment from a card (26f-flashcard.js, `fcOutPay`): `held`, the card's pieces held for it, which are what it is paid
   * with and nothing else; `card`, the card; and the invoice (`found`, for an address) and the fee quote the card was charged
   * for. Any way it is not made, with the pieces still held, they go back to the card (`fcOutBack`) and there is no TRY AGAIN:
   * the card has been charged, and paying again is NEXT again, a new tap. */
  startSendNow(to, o) {
    const W = window.FoxyWallet;
    const P = window.FoxyProgress;
    const card = (o && o.held) ? o : null;
    // an invoice already held in a payment is not paid a second time
    const inv = String(to || '').trim().replace(/^lightning:/i, '');
    const want = inv.toLowerCase();
    // an invoice read from an uppercase QR is the same invoice; a lightning
    // address gets a fresh invoice every time, so it is matched by the address
    if (W && W.pendingMelts && W.pendingMelts().some(m => m && (
      (m.bolt11 && m.bolt11.toLowerCase() === want) || (m.payee && m.payee === want)))) {
      this.showPayPending();
      if (card) this.fcOutBack(card, null);
      return;
    }
    /* One send at a time. The 150-second backstop below ends the wait, not
     * the payment: the wallet call keeps running, and a second send started
     * then queued behind it and paid again. */
    if (this._sendRun) {
      this.showPayPending();
      if (card) this.fcOutBack(card, null);
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
    const typed = this.typedSats();
    /* Which balance pays, at a mint with two: the one on the confirmation's
     * WALLET button. Its own quote is reused (never the other's), and the
     * figures of the payment are kept for the sending screen. */
    const two = !card && !!(this.twoUnitsOn && this.twoUnitsOn());
    const unit = two ? (this.walletNow('send') || 'sat') : 'sat';
    const quotes = this._feeQuotes || {};
    const unitQuote = (bolt11) => (two && quotes[unit] && quotes[unit].bolt11 === bolt11 ? quotes[unit] : null);
    const askedSats = (W.amountOf && W.amountOf(to)) || typed;
    const sq = two ? (this.state.feeQ || {})[unit] : null;
    this._lastPay = null;
    this._paying = two ? { unit: unit, amount: sq ? sq.amount : 0, fee: sq ? sq.feeReserve : 0, asked: unit === 'usd' ? askedSats : 0 } : null;
    /* And what the confirmation has asked already. For an address that is the
     * invoice it gave and the fee quote on it, paid as they stand while they
     * are fresh (`payLnurl`); an address the screen could not look up, or one
     * it was not asked about, is looked up here, as it was before. */
    const asked = this.sendAsk();
    const found = card ? (card.found || null) : (asked && asked.addr && this._found && this._found.addr === asked.addr && this._found.sats === asked.sats)
      ? this._found : null;
    // a card's own quote; at a mint with two balances, the quote of the balance that pays
    const kept = card ? (card.quote || null)
      : two ? (found ? unitQuote(found.pr) : null)
      : (found && this._feeQuote && this._feeQuote.bolt11 === found.pr) ? this._feeQuote : null;
    /* An address's invoice is for one attempt. A payment that goes must not be
     * paid with the same invoice again the next time this address and amount
     * are chosen, and one that fails is asked about afresh when the person is
     * back on the confirmation. */
    if (found) { this._found = null; this._quotedFor = null; }
    // from a card: its held pieces, by name, and the card (an entry that says it was paid from the card)
    const fromCard = card ? { held: card.held, card: card.card } : {};
    // at a mint with two balances: the balance that pays; from a dollar card, its dollars (a bitcoin card's pays in sats, as ever)
    const inUnit = two ? { unit: unit } : (card && card.unit === 'usd') ? { unit: 'usd' } : {};
    const invQuote = card ? kept
      : two ? unitQuote(to)
      : (this._feeQuote && this._feeQuote.bolt11 === to) ? this._feeQuote : null;
    const run = W.classify(to) === 'lnurl'
      ? W.payLnurl(to, card ? (found ? found.sats : typed) : typed, '', onStage,
                   (found || card) ? Object.assign({ found: found, quote: kept }, fromCard, inUnit) : (two ? inUnit : undefined))
      : W.pay(to, onStage, Object.assign(W.amountOf(to) ? {} : { sats: typed },
                                         invQuote ? { quote: invQuote } : {}, inUnit, fromCard));
    this._sendRun = run;
    const settled = () => { if (this._sendRun === run) this._sendRun = null; };
    run.then(settled, settled);
    /* From a card, and the wait below given up on as pending: a payment that then fails after all, with the card's pieces still
     * held, puts them back to the card as one that failed at once does. */
    if (card) {
      run.then(null, (e) => {
        if (card.pendingShown && !card.done && !(e && e.pending) && this.fcOutStillHeld(card)) this.fcOutBack(card, e);
      });
    }
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
        if (card) card.pendingShown = true;
        if (P) P.end();
        W.tag(r.hash, { to: to, note: (this.state.note || '').trim() });
        this.showPayPending();
        return;
      }
      console.log('[foxy] send complete');
      W.tag(r.hash, { to: to, note: (this.state.note || '').trim() });
      // from a card: what is left of the card's flow (change it is still owed) once the payment is made
      if (card) this.fcOutSettled(card, true);
      // an invoice a tap offered: the other phone is told, over the link that is still open
      if (this.tapPaidByLightning) this.tapPaidByLightning(to);
      /* Which balance paid, in its own unit, for the sending screen; and,
       * unless Foxy picked it for the person, remembered for the next send. */
      if (two) {
        const paidIn = (r && r.unit) || unit;
        this._lastPay = { unit: paidIn, amount: r.amount != null ? r.amount : askedSats, fee: r.fee != null ? r.fee : (r.feeSats || 0),
          asked: paidIn === 'usd' ? askedSats : 0 };
        if (!this.state.walletAuto) this.rememberWallet('send', paidIn);
      }

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
      /* The mint's price for a dollar payment moved past the one confirmed.
       * The wallet stopped before anything moved (`pay`, e.repriced), so
       * this is not a failure: back to CONFIRM PAYMENT, which asks the mint
       * again and shows the new TOTAL to be confirmed. */
      if (e && e.repriced) {
        console.warn('[foxy] send: the price moved, asking again:', W.reason ? W.reason(e) : e);
        if (P) P.end();
        this.toConfirm();
        this._quotedFor = null;
        this.toast('The price moved. Check the new total.', true);
        this.quoteSendFee();
        return;
      }
      const m = String((e && e.message) || '');
      console.error('[foxy] send failed:', e);
      if (P) P.end();
      /* From a card: unless the payment may still be going (its melt is held, and is settled as any is), the card's pieces are
       * still held for it, and they go back to the card, said as NOT PAID; never TRY AGAIN. */
      if (card && !(e && e.pending) && this.fcOutStillHeld(card)) {
        if (this.state.screen === 'sendDone' || this.state.sendPhase) this.toConfirm();
        this.fcOutBack(card, e);
        return;
      }
      if (card) this.fcOutSettled(card, false);
      // stopped by the person before it was made: they are home already
      if (e && e.foxyStopped) return;
      // held, not failed: the pending card, never TRY AGAIN
      if (e && e.pending) { if (card) card.pendingShown = true; this.showPayPending(); return; }
      // before the classification below, which would call "invalid" a refusal and offer TRY AGAIN
      if (this.isBadSignatures(e)) {
        this.badSignatureCard(null, 'pay', () => {
          if (this.state.screen === 'sendDone' || this.state.sendPhase) this.toConfirm();
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
        this.toConfirm();
      }

      // not enough money needs a different amount, not another attempt
      /* From a card, another attempt is NEXT again, a new tap of the card (`fcOutNext`): never `startSend`, which pays from
       * this phone's own balance under a confirmation that says FROM FLASHCARD. */
      const again = (kind === 'sendFail') ? null : card ? () => this.fcOutNext() : () => this.startSend();

      /* CLOSE must not strand you on the sending screen.
       *
       * blockedCard leaves you where you were, which is right when a failure
       * arrives over the home screen. Here the progress overlay has gone, the
       * payment did not happen, and that screen has nothing on it — closing
       * left no way out. Back to the confirmation, where the buttons are.
       *
       * Except for a balance that does not cover the payment and its fee: the
       * confirmation would only say the same again (it holds its button for
       * exactly this, NOT ENOUGH), so the card, whichever way it is closed,
       * goes to the amount screen. It has no TRY AGAIN; its one button names
       * where it goes, and the closing does it (`toAmount`). */
      /* The title only where this card has its own: a title of undefined here wiped the kind's own (`blockedCard` lays this
       * over it), and a card with no title is not shown at all, so every failure but the mint's refusal said nothing. */
      this.blockedCard(kind, Object.assign(kind === 'mintRefused' ? { title: 'THE MINT SAID NO' } : {}, {
        reason: W.reason(e),
        retry: again ? 'TRY AGAIN' : 'CHANGE AMOUNT',
        back: again ? '' : 'amount',
        go: again || (() => {}),
        onClose: () => {
          if (kind === 'sendFail') {
            if (this.state.screen === 'sendDone' || this.state.screen === 'sendConfirm' || this.state.sendPhase) this.toAmount();
            return;
          }
          /* Back to the send confirmation — 'sendConfirm', not 'confirm'.
           *
           * 'confirm' is the receive invoice screen. Sending someone there
           * after a failed payment is worse than the dead end it replaced. */
          if (this.state.screen === 'sendDone' || this.state.sendPhase) {
            this.toConfirm();
          }
        },
      }));
    });
  }
