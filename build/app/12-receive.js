
  // sats for whatever is on the keypad, at the live price
  wantedSats() {
    const s = this.state;
    const val = parseFloat(s.amount) || 0;
    if (s.unit === 'SATS') return Math.round(val);
    const px = this.px();
    if (!px) return 0;          // no price, no conversion
    return Math.round(val / px * 1e8);
  }

  // real invoice for the receive screen, then wait for it to be paid
  openReceive() {
    const W = window.FoxyWallet;
    this.stopReceive();
    this.setState({ invoice: '', invoiceHash: '', invoiceErr: '' });
    if (!W || !W.connected) { this.setState({ invoiceErr: 'No wallet connected.' }); return; }

    // Requesting an invoice is a mint call like any other, so Tor is
    // checked first and the work happens in its own method. Calling back into
    // openReceive() re-entered this guard and the check looped forever.
    const G = window.FoxyGate;
    if (G && G.quiet) {
      return G.quiet().then(ok => {
        if (!ok) { this.setState({ invoiceErr: 'Tor is reconnecting. Try again in a moment.' }); return; }
        console.log('[foxy] receive invoice |', G.stamp());
        this.openReceiveNow();
      });
    }
    return this.openReceiveNow();
  }

  /* How a receive is paid: LIGHTNING (the invoice) or CASHU (a payment
   * request a Cashu wallet answers with a token, taken with SCAN). The request
   * is made once for an amount, mint and purpose and kept, so its id does not
   * change with every render.
   *
   * It names this phone's onion address, so a payer on Foxy sends the payment
   * straight here over Tor (07-request-delivery.js, OnionInbox.swift) and
   * nothing needs scanning. The address is made first, which is why this is
   * '' for a moment; without Tor (Orbot) the request goes without one and SCAN
   * takes the token as before. `purpose` is 'receive' or 'split:<payer>'. */
  /* `usdCents` instead of a sat amount, for a phone with no route: the request
   * names dollars and leaves the conversion to the phone that has a current
   * price (`dollarsOnly`, `asksInDollars`). The two are alternatives — a
   * request carries one amount — so the cache key holds both. */
  railRequest(sats, purpose, usdCents) {
    const W = window.FoxyWallet;
    if (!W || !W.paymentRequest) return '';
    const why = purpose || 'receive';
    const cents = Math.round(Number(usdCents) || 0);
    const key = W.mintUrl + '|' + (Number(sats) || 0) + '|' + why + '|$' + cents;
    this._creqs = this._creqs || {};
    const have = this._creqs[key];
    if (have && have.making) return '';
    /* Made once and kept. It used to be remade whenever the open address
     * changed, which fought syncInbox: each made a new address for the other
     * to close (seen in a phone log). Leaving the screen clears these. */
    if (have) return have.text;
    this._creqs[key] = { making: true };
    // `ways` is { onion, nostr }, either of which may be missing
    const make = ways => {
      const text = W.paymentRequest(cents > 0 ? 0 : sats,
        { deliverTo: ways, purpose: why, usd: cents > 0 ? cents : 0 });
      this._creqs[key] = { text: text, inbox: ways };
      this.setState({ creqMade: Date.now() });
      return text;
    };
    /* The key the payer locks the ecash to is derived from the seed by the
     * phone, and `paymentRequest` is synchronous, so it can only take one the
     * phone derived earlier. Primed here, beside the address, because this is
     * the one moment before the code goes on screen when there is time to wait.
     * Without this the first request of a page load would go out unlocked.
     *
     * It never rejects — no key means an unlocked request, which is what every
     * request was before requests were locked — so nothing here has to handle
     * a failure.
     * The address is what decides when the code appears, as it did before. */
    const primed = W.primeLocks ? W.primeLocks() : Promise.resolve(0);
    /* No route, no address, and no waiting to find that out.
     *
     * `openInbox` is a bridge call with a twenty-five second timeout, and an
     * offline phone cannot publish an onion address at all — so it waited out
     * the whole twenty-five and then made the request without one. That is
     * invisible on the receive screen, which simply shows its code a little
     * late. It is not invisible in a tap: the receiver agreed a price, and the
     * request it agreed to went back twenty-five seconds later, by which time
     * the payer's link was gone and the payment never happened.
     *
     * Offline the answer is known, so it is given at once. */
    const opening = this.offlineNow()
      ? Promise.reject(new Error('this phone has no route, so it has no address to give'))
      : (this._inboxOpening || (W.openInbox ? W.openInbox() : Promise.reject(new Error('no inbox'))));
    this._inboxOpening = opening;
    const both = opening.then(ways => {
      this._inboxOpening = null;
      this._inboxUrl = ways;
      return ways;
    }, () => {
      this._inboxOpening = null;
      return null;
    });
    /* Kept so a caller that cannot make do with '' can wait for it
     * (`railRequestReady`). The row is replaced by `make`, which is why this is
     * set on the one that is here now and read only while `making` is true. */
    const ready = Promise.all([both, primed]).then(([ways]) => make(ways), () => make(null));
    this._creqs[key].ready = ready;
    return '';
  }

  /* The same request, for a caller that has to have it.
   *
   * `railRequest` answers '' for an amount it has not made one for yet, because
   * the screen that calls it renders many times a second and simply shows
   * nothing until the code exists. A caller with one shot cannot do that: the
   * receiver agreeing a price has to send the agreed request *now*, and reading
   * '' once made it tell the payer it had been refused — ACCEPT reported a
   * rejection.
   *
   * Resolves to the text, or to '' when it genuinely could not be made.
   */
  railRequestReady(sats, purpose, usdCents) {
    const W = window.FoxyWallet;
    const now = this.railRequest(sats, purpose, usdCents);
    if (now) return Promise.resolve(now);
    if (!W || !W.paymentRequest) return Promise.resolve('');
    const key = W.mintUrl + '|' + (Number(sats) || 0) + '|' + (purpose || 'receive')
      + '|$' + Math.round(Number(usdCents) || 0);
    const have = (this._creqs || {})[key];
    if (have && have.ready) return have.ready.then(t => t || '', () => '');
    /* No row and no promise: `railRequest` refused it outright. */
    return Promise.resolve(have ? (have.text || '') : '');
  }

  /* A request for a phone that is right here, made now.
   *
   * The one the receive screen shows names an onion address, so somebody who
   * scans the code and walks away can still pay it — and publishing that
   * address takes Tor several seconds. A tap needs none of that: the payment
   * comes straight back over the Bluetooth link that carried the offer
   * (`viaTap`), so the request can be made synchronously and offered the
   * instant the phones touch.
   *
   * That is what was making a tap wait on the Lightning invoice and the onion
   * address, neither of which another Foxy at the same mint needs ("a tap from another foxy device on the same mint should pass
   * data immediately"). The invoice still goes in the offer when it arrives,
   * for the wallets that do need one.
   *
   * Kept per amount, like `railRequest`, so the id does not change with every
   * render; cleared with the rest when the screen goes.
   */
  tapOnlyRequest(sats, purpose) {
    const W = window.FoxyWallet;
    if (!W || !W.paymentRequest) return '';
    const n = Math.max(0, Math.round(Number(sats) || 0));
    // a share of a split names itself, which is how `forgetRequests` tells them apart
    const key = 'tap|' + W.mintUrl + '|' + n + (purpose ? '|' + purpose + '|' : '');
    this._creqs = this._creqs || {};
    const have = this._creqs[key];
    if (have && have.text) return have.text;
    /* The lock pool is filled in the background: a request that goes out
     * unlocked is what every request was before requests were locked, and
     * waiting for a key here would put back the delay this exists to remove. */
    if (W.primeLocks) { try { W.primeLocks(); } catch (e) {} }
    const text = W.paymentRequest(n, { purpose: purpose || 'receive' });
    if (!text) return '';
    this._creqs[key] = { text: text };
    return text;
  }

  /* Whether a request for this amount is still being made: the moment between
   * the receive screen opening and its onion address answering. railRequest
   * returns '' both while it is waiting and when it will never come, and the
   * tap offer has to tell those apart (26d-tap.js). */
  railRequestPending(sats, purpose, usdCents) {
    const W = window.FoxyWallet;
    if (!W || !W.paymentRequest) return false;
    const key = W.mintUrl + '|' + (Number(sats) || 0) + '|' + (purpose || 'receive')
      + '|$' + Math.round(Number(usdCents) || 0);
    const have = (this._creqs || {})[key];
    return !!(have && have.making);
  }

  /* The Cashu payment request behind the receive screen's QR, or '' while
   * there is not yet one worth showing.
   *
   * '' is what leaves the loading animation on the QR (21-render-values), and
   * that is the point: a code goes on screen only once it carries the figure
   * the person asked for. A figure typed in dollars is 0 sats until the price
   * lands, and a receive reopened from history has only its invoice to read
   * the figure back out of. In both cases the QR waits, rather than showing a
   * request for no amount — which the payer's wallet offers as "pay any
   * amount", and which they may well scan before the real code replaces it.
   *
   * Someone who typed nothing is asking for anything, and that request is made
   * and shown as it always was. */
  cashuRequest() {
    const W = window.FoxyWallet;
    if (!W) return '';
    const s = this.state;
    if (s.invoiceIsAddress) return this.railRequest(0);
    /* Offline, the amount typed is dollars and stays dollars all the way into
     * the request. Converting it here at a price hours old is the one thing
     * this whole leg exists to avoid. */
    if (this.dollarsOnly()) {
      const cents = Math.round((parseFloat(s.amount) || 0) * 100);
      if (cents > 0) return this.railRequest(0, 'receive', cents);
      return this.railRequest(0);
    }
    const sats = this.wantedSats() || W.amountOf(s.invoice) || 0;
    if (sats > 0) return this.railRequest(sats);
    if ((parseFloat(s.amount) || 0) > 0) return '';   // typed, not converted yet
    return this.railRequest(0);
  }

  /* The onion address is open through a receive and a split, and closed on the
   * way out. It is opened at the keypad rather than when the QR appears: Tor
   * takes half a minute or so to publish an address, and until it is published
   * a payer cannot reach it (the payer's Foxy waited 25 s; seen in a phone
   * log). Nobody is told the address until a request names it.
   *
   * Called on every update, so it must not flap: leaving and coming back would
   * otherwise make a new address every render. */
  /* Foxy left the foreground, so the native side ended the address
   * (FoxyBridge+Delivery.closeInboxForBackground). What the page holds about it
   * is now stale: the URL, and every payment request built around that URL. Let
   * them go, and the next render opens a fresh address and writes a fresh
   * request naming it. */
  inboxWake() {
    this._inboxUrl = null;
    this._inboxOpening = null;
    this._inboxLeftAt = 0;
    this._creqs = {};
    this.syncInbox();
  }

  /* A request is for one payment, so one that has been answered is let go.
   *
   * They are kept per amount so a code does not change with every render, and
   * nothing took them out again once they were paid. The wallet closes a paid
   * request and drops its lock key, so the next person asked for the same
   * amount was handed a request this phone no longer knew: "That payment
   * answers no request open here", after the payer had moved its sats across
   * mints to make it, and ecash locked to a key with no row (1,198 sats asked
   * twice; and 1,201 twice).
   *
   * A split's other shares are kept: they are separate requests, still owed,
   * and their codes may be on somebody's screen. `paid` names the share that
   * has been answered, or nothing for an ordinary receive. */
  forgetRequests(paid) {
    const all = this._creqs || {};
    const keys = Object.keys(all);
    if (!keys.length) return;
    const kept = {};
    let let_go = 0;
    keys.forEach(k => {
      const share = /\|(split:\d+)\|/.exec(k);
      if (share && share[1] !== paid) kept[k] = all[k]; else let_go += 1;
    });
    this._creqs = kept;
    if (let_go) console.log('[foxy] receive: ' + let_go + ' request(s) let go; the next is made fresh');
  }

  syncInbox() {
    const W = window.FoxyWallet;
    const s = this.state;
    const screen = String(s.screen || '');
    const inReceive = (screen === 'amount' || screen === 'confirm') && s.flow === 'receive';
    /* And the two screens that are a tap still being talked about. They are not
     * receive screens, so this read them as leaving and closed the address a
     * payment may be on its way to — the same seam that took the Bluetooth
     * radio down under the price screen (26d-tap.js). */
    const talking = !!this._tapTalking;
    const wants = inReceive || talking || /^sp/.test(screen);
    if (wants) {
      this._inboxLeftAt = 0;
      /* A failure waits a beat before it is asked again.
       *
       * This runs on every render, and with no route `openInbox` rejects in
       * milliseconds — so a receive screen sitting offline asked for an onion
       * address over and over, and the phone built and tore down an inbox each
       * time: eleven "onion inbox closed" in fourteen seconds, none of which
       * could ever have opened. The screen is unchanged; what changes is how
       * often it asks while the answer is no.
       * A route arriving does not have to wait for this: the gate's own
       * reconnect re-renders, and four seconds is shorter than the connect. */
      const rested = !this._inboxFailedAt || Date.now() - this._inboxFailedAt > 4000;
      if (!this._inboxUrl && !this._inboxOpening && rested && W && W.openInbox) {
        const opening = W.openInbox();
        this._inboxOpening = opening;
        opening.then(url => { this._inboxOpening = null; this._inboxFailedAt = 0; this._inboxUrl = url; },
          () => { this._inboxOpening = null; this._inboxFailedAt = Date.now(); });
      }
      return;
    }
    /* No address, and the requests go all the same.
     *
     * They were only ever let go below, beside the address they named — and a
     * phone with no route has no address, so it returned here and kept every
     * request it had made for as long as the page lived (forgetRequests). */
    if (!this._inboxUrl && !this._inboxOpening && this.forgetRequests) this.forgetRequests();
    if (!this._inboxUrl || this._inboxOpening) return;
    // a beat before closing, so a screen change in two steps does not churn
    this._inboxLeftAt = this._inboxLeftAt || Date.now();
    if (Date.now() - this._inboxLeftAt < 1500) {
      clearTimeout(this._inboxWait);
      this._inboxWait = setTimeout(() => this.syncInbox(), 1600);
      return;
    }
    /* The address goes on answering for a minute and a half if a request
     * naming it was ever put on screen.
     *
     * A payment can be crossing to it. The tap that falls back to the onion is
     * exactly that: the receiver changes screen, the Bluetooth link drops, and
     * the payer — who is still minting the token — posts to the address about
     * half a second after this closes it. Closed, that post spends two minutes
     * finding out the service is gone, because the descriptor is still cached
     * where it was published (120893 ms, then 130714 ms). Held open, it
     * arrives in seconds.
     *
     * `_creqs` is empty unless a request naming this address was actually
     * built and shown, so an address nobody was ever given is dropped at once.
     * It costs nothing to wait: the phone hands the next screen a fresh warm
     * address immediately (warmSpare), and backgrounding still closes
     * everything outright. */
    const shown = Object.keys(this._creqs || {}).length > 0;
    this._inboxUrl = null;
    this._creqs = {};
    if (W && W.closeInbox) W.closeInbox(shown ? 90 : 0);
  }

  /* A payment for one of this phone's requests, sent straight here over Tor. */
  requestPaidHere(ev) {
    const W = window.FoxyWallet;
    // the wait is over, whichever way it went
    if (this.hideStage) this.hideStage('waitPayer');
    const split = /^split:(\d+)$/.exec(String(ev.purpose || ''));
    const onIt = split ? /^sp/.test(String(this.state.screen || '')) : this.state.screen === 'confirm';
    if (ev.stage === 'arrived') {
      // it is all here: the percentage's screen gives way to the ordinary one
      clearTimeout(this._recvProgT);
      if (this._recvProg && !onIt) this.hideMelt();
      this._recvProg = false;
      if (onIt) this.showMelt('Receiving ecash\u2026', 0, { sats: ev && ev.sats });
      /* A payment has landed on this screen: it does not go back on the air.
       * It did — the request was let go and a fresh one armed while the claim
       * was still at the mint — and the payer, home again, linked to it a
       * second time. Cleared when the screen is left. */
      this._tapPaidHere = true;
      return;
    }
    this.hideMelt();
    if (ev.stage === 'failed') this._tapPaidHere = false;
    /* And the conversation is over, whichever way it went.
     *
     * The hold is taken when a decision is put to a person and kept through the
     * answer AND the payment that answer was about — because `tapTerms`
     * resolving means the write is queued, not delivered, and because after
     * sending the terms this phone is waiting for exactly this (26d-tap.js).
     * This is where it ends. */
    if (this.tapTalking) this.tapTalking(false);
    /* The tap is over either way, so the screen stops claiming one.
     *
     * `tapArmed` means "this screen has a tap going" and is what keeps the
     * receiver alive through a payment (26d-tap.js). A payment that has landed
     * — taken or refused — is the end of it, and the next customer is a fresh
     * press, because one receiver is one payment's worth of radio. The four
     * digits stay up; they are what the person looks at next. */
    if (this.state.tapArmed) this.setState({ tapArmed: false });
    /* Answered, so the request it answered is not offered again. Whichever way
     * it went: a refused payment's request may be closed too, and a fresh one
     * costs nothing. */
    if (this.forgetRequests) this.forgetRequests(split ? 'split:' + split[1] : '');
    if (ev.stage !== 'paid') {
      if (onIt) this.toast('A payment arrived but could not be redeemed. Ask them to try again.', true);
      return;
    }
    /* A share of a split is reported by the split's own screens — the row
     * turns green on COLLECTING and EVERYONE HAS PAID sums them up — so its
     * history entry must not also queue a confirmation of its own. It did:
     * dismissing EVERYONE HAS PAID dropped the person on home and then played
     * one payment screen per share, back to back, for money they had just been
     * told about (three in a row).
     *
     * Marked seen before the history pass runs, because that pass is what
     * queues them and it is one line below. */
    if (split && ev.id) this.txIsNew('req-' + ev.id);
    /* Nor one that is still to be carried home: it is announced when it has
     * landed at this phone's own mint, and not before (`carryHomeNow`). */
    const carrying = /^carry:/.test(String(ev.purpose || '')) && !!this.carryHomeNow;
    if (carrying && ev.id) this.txIsNew('req-' + ev.id);
    this.refreshBalance();
    this.loadHistory();
    /* A payment taken at somebody else's mint, on their behalf, because they
     * had no route to move it themselves. It is this phone's money now — the
     * swap has come back, which is the whole of the risk — and what is left is
     * melting it home. Ordinary work, and a failure leaves it safe where it is
     * (26d-tap.js). */
    if (/^carry:/.test(String(ev.purpose || '')) && this.carryHomeNow) {
      this.carryHomeNow();
      return;
    }
    if (split) {
      const idx = Number(split[1]);
      const pending = W.splitPending && W.splitPending();
      const row = pending && pending.rows && pending.rows[idx];
      if (row && !row.paid) {
        this.spMarkPaid(idx, row.hash);
        if (this.state.spFromWaiting) this.setState({ screen: 'spWaiting', spFromWaiting: false });
      } else if (!pending && !(this.state.spInvoices || []).length) {
        /* Paid by tap before the share's invoice was made, so there is no row
         * yet: the tally is marked, and the rows are written as paid when
         * they arrive (`spMakeInvoices`). */
        this.spMarkPaid(idx, '');
      }
      // and the screen moves on to the next payer (17-split-bill-and-copy.js)
      setTimeout(() => this.spAdvanceAfterPaid(idx), 0);
      return;
    }
    // as a scanned token: the invoice screen closes, and the history pass announces it
    if (this.state.screen === 'confirm') this.closeReceive();
    this.noteReceived();
    /* And small change is made from it. Only a send armed this, so a wallet
     * that had just been paid 8,357 sats in five pieces sat online for twenty
     * seconds making none, went offline, and paid 8,192 for a 1,194-sat
     * payment. */
    if (this.tidyChangeNow) this.tidyChangeNow();
  }

  /* The choice of LIGHTNING or CASHU, as a sheet over the screen. */
  /* The sheet the NETWORK button and the speed picker both raise: a title and
   * a few rows, one of them ticked. */
  /* `rows` is an array, or a function returning one — which is how a sheet
   * that can be changed from inside itself redraws without closing. */
  chooseFrom(title, rows) {
    document.querySelectorAll('[data-foxy-rail-sheet]').forEach(n => n.remove());
    const root = document.createElement('div');
    root.setAttribute('data-foxy-rail-sheet', '1');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483300;background:rgba(0,0,0,.6);display:flex;'
      + 'flex-direction:column;justify-content:flex-end;font-family:SatSymbol,Sora,system-ui,sans-serif;animation:foxyIn .16s ease';
    const card = document.createElement('div');
    card.style.cssText = 'background:#141518;border-radius:28px 28px 0 0;padding:26px 22px calc(26px + env(safe-area-inset-bottom));'
      + 'display:flex;flex-direction:column;gap:12px';
    const head = document.createElement('div');
    head.style.cssText = 'font-size:22px;font-weight:800;letter-spacing:-0.022em;color:#F5F1EC;text-align:center;margin-bottom:4px';
    head.textContent = title;
    card.appendChild(head);
    const close = () => root.remove();
    const draw = () => {
    while (card.children.length > 1) card.removeChild(card.lastChild);
    (typeof rows === 'function' ? rows() : rows).forEach(o => {
      const on = !!o.on;
      /* A network this amount cannot use is shown and not offered.
       *
       * It used to be listed like any other and refuse on the tap, with the
       * reason in a toast — so the person chose a network, watched the sheet
       * close, and read why two seconds later somewhere else. Greyed with the
       * reason under its name, the answer is in front of them before they
       * reach for it. */
      const off = !!o.off;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:14px;padding:14px 18px;border-radius:20px;'
        + 'cursor:' + (off ? 'default' : 'pointer') + ';opacity:' + (off ? '0.45' : '1') + ';'
        + 'background:' + (on ? 'rgba(242,128,46,.14)' : '#1C1C1E') + ';border:1.5px solid ' + (on ? '#F2802E' : 'rgba(255,255,255,.1)');
      /* A block, not a column of flex items: the pill below sits in the
       * description's own text flow, and a float inside a flex container is
       * ignored. */
      const text = document.createElement('div');
      text.style.cssText = 'flex:1;min-width:0';
      const name = document.createElement('div');
      name.style.cssText = 'font-size:18px;font-weight:800;color:#F5F1EC;margin-bottom:3px';
      name.textContent = o.label;
      text.appendChild(name);
      let sub = null;
      if (o.sub) {
        sub = document.createElement('div');
        // flow-root so the floated pill is inside it rather than hanging out
        sub.style.cssText = 'font-size:16px;font-weight:500;line-height:1.35;'
          + 'color:rgba(245,241,236,.6);display:flow-root';
        sub.textContent = o.sub;
        text.appendChild(sub);
      }
      /* Two different questions in one sheet: the tick is which network this
       * screen is on, the pill is which one every receive starts on. The
       * pill answers in place — setting a default is not choosing a network,
       * so the sheet stays open.
       *
       * It floats at the end of the description rather than taking a column
       * of its own. A column squeezed every line of the description into what
       * was left beside the widest word on the pill; floated last, the first
       * lines run the full width of the card and only the last one wraps
       * around it, with the pill sitting at the foot of the row on the right. */
      if (o.isDefault || o.makeDefault) {
        const isDef = !!o.isDefault;
        const pill = document.createElement('div');
        pill.style.cssText = 'float:right;margin:2px 0 0 12px;padding:6px 11px;border-radius:13px;'
          + 'font-size:13px;font-weight:800;letter-spacing:0.06em;white-space:nowrap;'
          + (isDef
            ? 'background:rgba(191,227,236,.16);color:#BFE3EC;border:1.5px solid rgba(191,227,236,.5)'
            : 'background:transparent;color:rgba(245,241,236,.45);border:1.5px solid rgba(255,255,255,.14);cursor:pointer');
        pill.textContent = isDef ? 'DEFAULT' : 'SET DEFAULT';
        if (!isDef && o.makeDefault) {
          pill.addEventListener('click', (e) => {
            e.stopPropagation();
            o.makeDefault();
            draw();
          });
        }
        // last in the description's flow, so it lands on its last line
        (sub || text).appendChild(pill);
      }
      if (off && o.offWhy) {
        const why = document.createElement('div');
        why.style.cssText = 'margin-top:5px;font-size:15px;font-weight:700;color:#F7931A;display:flow-root';
        why.textContent = o.offWhy;
        text.appendChild(why);
      }
      row.appendChild(text);
      if (on) {
        const tick = document.createElement('div');
        tick.style.cssText = 'flex:none;font-size:20px;font-weight:800;color:#F2802E;line-height:1.2';
        tick.textContent = '\u2713';
        row.appendChild(tick);
      }
      // a greyed row is not a control: the sheet stays open and nothing happens
      row.addEventListener('click', () => { if (off) return; close(); if (!on && o.tap) o.tap(); });
      card.appendChild(row);
    });
    };
    draw();
    root.appendChild(card);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    document.body.appendChild(root);
  }

  /* LIGHTNING, CASHU, and ON-CHAIN where the mint does it (26b-onchain.js). */
  chooseRail(current, pick) {
    const rails = [
      { rail: 'LIGHTNING', sub: 'Any Lightning wallet pays the invoice.' },
      { rail: 'CASHU', sub: 'A Cashu wallet answers with a token for this amount. Tap SCAN to take it.' },
    ];
    if (this.ocCan('receive')) {
      rails.push({ rail: 'ON-CHAIN', sub: 'An ordinary Bitcoin payment to an address this mint watches.' });
    }
    const W = window.FoxyWallet;
    this.chooseFrom('NETWORK', () => rails.map(o => {
      /* Under the mint's floor an on-chain payment is swallowed rather than
       * refused, so that network is greyed with the reason rather than offered
       * and then refused. */
      const sats = this.state.invoiceIsAddress ? 0
        : (window.FoxyWallet.amountOf(this.state.invoice) || 0);
      const barred = o.rail === 'ON-CHAIN' && this.ocReceiveBlocked(sats);
      return {
        label: o.rail, sub: o.sub, on: o.rail === current,
        off: barred, offWhy: barred ? this.ocFloorShort() : '',
        isDefault: !!(W && W.defaultRail && W.defaultRail() === o.rail),
        // a network this amount cannot use is not one to start every receive on
        makeDefault: (!barred && W && W.defaultRail) ? () => {
          W.defaultRail(o.rail);
          this.toast(o.rail + ' is now the default.');
        } : null,
        tap: () => pick(o.rail),
      };
    }));
  }

  openReceiveNow() {
    const W = window.FoxyWallet;
    const sats = this.wantedSats();
    /* The network this person asked every receive to start on, which used to
     * be Lightning whatever they chose (FoxyWallet.defaultRail). On-chain is
     * refused under the mint's floor, where the payment would be swallowed
     * rather than refused, so that falls back rather than opening on a
     * network this amount cannot use. */
    let rail = (W && W.defaultRail) ? W.defaultRail() : 'LIGHTNING';
    if (rail === 'ON-CHAIN' && (!this.ocCan('receive') || this.ocReceiveBlocked(sats))) rail = 'LIGHTNING';
    /* Offline there is one network, and it is Cashu.
     *
     * A Lightning invoice is the mint's to make and an on-chain address is the
     * mint's to give, so neither exists without a route. A Cashu payment request
     * is this phone's own: the amount, the unit, the mint it will accept and a
     * lock key the phone derives from the seed. `railRequest` already copes with
     * `openInbox` failing by making the request with no transport at all, which
     * is exactly right here — the payer is an inch away and the offer crosses
     * Bluetooth, not an onion. */
    if (this.offlineNow()) rail = 'CASHU';
    this.setState({ recvRail: rail });
    if (sats < 1) {
      /* SKIP on the amount screen: show the address so they choose the amount.
       * Not reachable while the keypad hides SKIP (`hideSkip`, home screen
       * redesign) and NEXT stays dead at zero; kept because it is
       * the fallback that comes back with SKIP, not because anything reaches
       * it today. */
      const addr = W.myAddress();
      this.setState({ invoice: addr, invoiceHash: '', invoiceIsAddress: true });
      return;
    }
    this.setState({ invoiceIsAddress: false });

    /* And offline, no invoice is asked for at all.
     *
     * The screen used to ask for one whatever the rail, because on Lightning it
     * is the QR and on Cashu it costs nothing. Offline it costs everything: the
     * request cannot be made, the three tries are spent, and the person is put
     * back on the screen they came from with an error — so opening RECEIVE while
     * offline would bounce them straight out of it. The Cashu request drives the
     * code on this screen (`creq`), and a payment arriving over Bluetooth is
     * announced through `_requestPaid`, not through an invoice's watch, so
     * nothing here needs one. */
    if (this.offlineNow()) {
      this.setState({ invoice: '', invoiceHash: '', invoiceErr: '' });
      console.log('[foxy] receive: offline, so a Cashu request and no invoice');
      return;
    }

    // the person's note or nothing: 'Foxy' on every invoice told the payer and the mint which wallet made it
    const memo = (this.state.note || '').trim();

    /* Three tries, not one.
     *
     * A first request to a mint failing is ordinary over a tunnel — the logs
     * are full of calls taking two and three seconds, and of a mint answering
     * 400 before working on the retry. Reporting failure two seconds in was
     * reporting the first stumble as the outcome. */
    /* A failure that never left the phone does not spend one of the three.
     *
     * The three tries are for a mint that stumbles. They were being spent on a
     * network that was shut: backgrounding the receive screen takes Tor off the
     * air on purpose, so every request made between then and the next circuit
     * fails without asking the mint anything. On a phone all three went
     * that way inside 100 seconds — two while the app was suspended, and the
     * third two seconds after it woke, with Tor still at "setting up" — and the
     * person was told "Foxy is still connecting to Tor" as the final answer to
     * a receive they had asked for once.
     *
     * `neverSent` is the wallet's own name for that class, the same list the
     * NUT-13 counters use. When it is one of those, wait for the gate to go
     * quiet instead — `FoxyGate.quiet` already waits for a circuit that was up
     * before — and try again without having used a try. Bounded, because a
     * radio that never comes back must still end in an answer rather than a
     * screen that waits for ever. */
    const G = window.FoxyGate;
    const WAITS = 3;
    const attempt = (n, waits) => W.invoice(sats, memo).catch(e => {
      const closed = !!(W.neverSent && W.neverSent(e));
      if (closed && waits < WAITS && G && G.quiet) {
        console.warn('[foxy] invoice: the request never left \u2014 waiting for Tor'
          + ' rather than spending a try (' + (waits + 1) + ' of ' + WAITS + ')');
        return G.quiet().then(ok => {
          if (!ok) throw e;
          return attempt(n, waits + 1);
        });
      }
      if (n >= 3) throw e;
      console.warn('[foxy] invoice attempt', n, 'failed \u2014', W.reason(e), '\u2014 retrying');
      return new Promise(ok => setTimeout(ok, n * 1500)).then(() => attempt(n + 1, waits));
    });

    /* This request, and no earlier one.
     *
     * Asking the mint for an invoice takes a while over Tor, and in that while
     * the person can change the amount and ask again. Both answers came back,
     * both armed a watch, and only the second was remembered — so the first
     * kept asking the mint about an invoice nobody was looking at until it
     * expired. Two of them were still running fifteen minutes on, once every
     * ten seconds, each on its own circuit, on a phone with poor connectivity,
     * the least able to carry it. */
    const mine = (this._invoiceRun = (this._invoiceRun || 0) + 1);

    attempt(1, 0).then(inv => {
      if (mine !== this._invoiceRun) {
        console.log('[foxy] invoice: an older request answered late; letting it go');
        return;
      }
      W.tag(inv.hash, { note: memo });
      // the note belonged to this invoice, not the next one
      this.setState({ invoice: inv.bolt11, invoiceHash: inv.hash, note: '', noteDraft: '' });
      // the watch polls and claims at whichever mint is connected, so a mint
      // switch waits until it has paid, expired or been stopped (moneyBusy)
      // whatever was being watched before, stop watching it
      this.stopReceive();
      this._watching = true;
      this._stopWatch = W.watch(inv.hash, paid => {
        if (mine !== this._invoiceRun) return;
        this._watching = false;
        // the payer said so first, and the mint has now agreed (tapPaidNotice)
        this._tapPaidNote = 0;
        if (this.hideStage) this.hideStage('paidCheck');
        this.haptic && this.haptic('success');
        this.setState(p => ({
          screen: 'paid',
          stack: p.stack.concat([p.screen]),
          recvResolved: true,
          recv: Object.assign({}, p.recv, { live: 'in' }),
        }));
        this.noteReceived();
        // The confirmation is already on screen; the history sweep must not
        // announce the same payment a second time when it catches up.
        this._seenTx = this._seenTx || {};
        this._seenTx[inv.hash] = true;
        // hold the figure from before the money landed, so dismissing the
        // confirmation has something to count up from
        if (this._preSettle == null) this._preSettle = this.balNow();
        this.refreshBalance();
      }, {
        timeoutMs: inv.expiresIn * 1000,
        onExpired: () => { this._watching = false; this.setState({ invoiceErr: 'This invoice expired.' }); },
      });
    }).catch(e => {
      if (mine !== this._invoiceRun) return;
      // invoiceErr is not rendered anywhere on that screen, so a failure here
      // used to be completely silent: no code, no message, nothing to copy.
      console.error('[foxy] invoice failed after 3 tries:', e);
      /* Back to where they came from, not onward to a screen they cannot
       * read. netLost renders black in this build, so it stranded people —
       * worse than the silence it was added to fix. The reason still surfaces,
       * in the toast and in the log. */
      this.setState(p => ({
        invoiceErr: W.reason(e),
        blockedWhy: W.reason(e),
        screen: (p.stack && p.stack.length) ? p.stack[p.stack.length - 1] : 'home',
        stack: (p.stack && p.stack.length) ? p.stack.slice(0, -1) : [],
      }));
      this.toast(W.reason(e), true);
    });
  }

  stopReceive() {
    if (this._stopWatch) { this._stopWatch(); this._stopWatch = null; }
    this._watching = false;
  }

  // A page loaded from a file is not a secure context, so navigator.clipboard
  // is usually missing in the web view. The old execCommand path still works,
  // and it has to run inside the tap that triggered it.
  /* ---- sending ---- */

  // anything payable: a bolt11 invoice, a lightning address, or an lnurl code
  acceptTarget(text) {
    const W = window.FoxyWallet;
    const t = String(text || '').trim().replace(/^lightning:/i, '');
    const kind = W.classify(t);

    if (kind === 'lnurl') {
      W.remember(t);                       // LNbits will not recall this later
      this.setState({ book: W.book() });
      // no amount is carried, so go to the keypad with the payee already set
      this.setState(p => ({
        screen: 'amount',
        stack: p.stack.concat([p.screen]),
        flow: 'send',
        asset: 'BITCOIN',
        network: 'LIGHTNING',
        recipientKind: 'email',
        recipient: t,
        unit: 'USD',
        amount: '',
        payFrom: 'BITCOIN',
      }));
      return true;
    }

    /* An address: paid on chain, if the mint does that. The amount comes with
     * it when the code is a bitcoin: URI. */
    if (kind === 'address') { this.payOnchain(t); return true; }

    // A bearer token is not something to pay TO — it is money handed to you,
    // so take it rather than calling it a bad address.
    if (kind === 'token') { this.takeTokenFromPaste(t); return true; }
    if (kind === 'request') { this.openRequest(t); return true; }
    if (kind === 'fedimint') {
      this.toast('That is a Fedimint invite, not a Cashu token.', true); return false;
    }
    if (kind === 'bolt12') {
      this.toast('That is a BOLT12 offer, which mints cannot pay yet.', true); return false;
    }
    if (kind === 'nostr') {
      this.toast('That is a nostr identity, not something to pay.', true); return false;
    }
    if (/^0[23][0-9a-f]{64}$/i.test(t)) {
      this.toast('That is a public key. Ask them for an invoice or a token.', true);
      return false;
    }

    if (kind !== 'invoice') {
      // 'badAddress' is navigated to but never defined, so setting it renders
      // an empty screen. Say what is wrong and stay put.
      this.toast('That is not an invoice, an address or a token.', true);
      return false;
    }

    const sats = W.amountOf(t);
    if (!sats) {
      /* An invoice that names no amount: ask for one, the way an LNURL does.
       *
       * This used to be turned away — "LNbits needs the amount at pay time,
       * which is a different call" — which was true of LNbits and has not been
       * true since Foxy paid through a mint. NUT-05 carries an `amount_msat`
       * beside the request for exactly this, and a zero-amount invoice is what
       * a "pay me what you like" link hands you, so refusing them refused an
       * ordinary way of being asked for money.
       *
       * Straight to the keypad with the invoice already set, and the same
       * screens after it. If the mint will not do it, `pay` says so by name
       * rather than the person finding out here. */
      this.setState(p => ({
        screen: 'amount',
        stack: p.stack.concat([p.screen]),
        flow: 'send',
        asset: 'BITCOIN',
        network: 'LIGHTNING',
        recipientKind: 'invoice',
        recipient: t,
        unit: 'USD',
        amount: '',
        payFrom: 'BITCOIN',
      }));
      return true;
    }
    /* No route, and an invoice. Lightning cannot be paid from here, but an
     * invoice this phone's own mint made names somebody who takes this mint's
     * ecash, and a token needs no connection to make: they scan it off this
     * screen. Anybody else's invoice is said no to now,
     * rather than after a confirmation screen and a wait. */
    if (this.offlineNow && this.offlineNow()) {
      if (W.invoiceFromThisMint && W.invoiceFromThisMint(t)) {
        console.log('[foxy] offline, and the invoice is from this mint: paying it with a token');
        this.payThisMintWithToken(sats);
      } else {
        console.log('[foxy] offline, and the invoice is not known to be from this mint: refused');
        this.blockedCard('offlineInvoice', {
          tone: 'warn',
          title: 'YOU\u2019RE OFFLINE',
          reason: 'A Lightning invoice can only be paid offline when it comes from your own mint. '
            + 'Ask them for a Cashu request, or reconnect.',
        });
      }
      return true;
    }
    const overLightning = () => this.setState(p => ({
      screen: 'sendConfirm',
      stack: p.stack.concat([p.screen]),
      flow: 'send',
      asset: 'BITCOIN',
      network: 'LIGHTNING',
      recipientKind: 'invoice',
      recipient: t,
      unit: 'SATS',
      amount: String(sats),
      payFrom: 'BITCOIN',
    }));

    /* The mint this wallet pays from made this invoice: paying it by Lightning
     * shows that mint both sides. Offer a token instead (payThisMintWithToken).
     * A fraction of a sat is paid by Lightning, which can carry it. */
    const msat = W.msatOf ? W.msatOf(t) : null;
    const offer = () => {
      const name = (this.mintName() || 'mint').toUpperCase();
      this.blockedCard('sameMintInvoice', {
        tone: 'warn',
        title: 'PAYING ANOTHER ' + name + ' USER',
        reason: 'This payment could have the ultimate privacy. But it requires you to make it over Cashu instead of Lightning.',
        retry: 'USE CASHU',
        go: () => this.payThisMintWithToken(sats),
        shut: { label: 'CONTINUE OVER LIGHTNING', tap: overLightning },
      });
    };
    if (!W.invoiceFromThisMint || msat == null || msat % 1000 !== 0) { overLightning(); return true; }
    if (W.invoiceFromThisMint(t)) { offer(); return true; }
    /* The mint's node not known yet (no invoice from it on this phone, and the
     * check after connecting not done): asked now, so the answer does not
     * depend on which invoice came first. */
    if (W.mintNodeKnown && !W.mintNodeKnown() && W.learnThisMintNode) {
      this._checkingInvoice = true;
      this.showMelt('Checking the invoice\u2026');
      W.learnThisMintNode().catch(() => null).then(() => {
        this._checkingInvoice = false;
        this.hideMelt();
        if (W.invoiceFromThisMint(t)) offer(); else overLightning();
      });
      return true;
    }
    overLightning();
    return true;
  }

  // Has this payment already been announced? The socket and the history sweep
  // both call here, so whichever notices a payment first wins and the other
  // stays quiet. On the very first load everything is marked seen without
  // announcing, or opening the app would replay your whole history at you.
  txIsNew(hash) {
    if (!hash) return false;
    this._seenTx = this._seenTx || {};
    if (this._seenTx[hash]) return false;
    this._seenTx[hash] = true;
    return !!this._seenSeeded;
  }

  // the confirmation screen, from either path
  announcePayment(ev) {
    const W = window.FoxyWallet;
    this.refreshBalance();

    /* Change is never a payment received. It is the rest of a payment this
     * phone made, and it was counted when it came back; swapping it in later
     * is bookkeeping. It was announced as ₿ 29 RECEIVED when the phone next
     * found a network, a minute after the 3-sat payment it belonged to. */
    if (!ev.force && /^(req-)?(tap-)?change-/.test(String(ev.hash || ''))) {
      console.log('[foxy] confirmation: change swapped in, not announced');
      return;
    }

    // A sweep is three transactions — claimed at their mint, melted out of it,
    // credited at yours — and announcing each turns one action into three
    // confirmations. They are all real, but only the last figure means
    // anything, so the sweep silences them and reports once itself.
    // A sweep writes several entries and the history pass finds them on its
    // own schedule — seconds after the fact, which is why marking the entries
    // it had already written was not enough. Nothing announces during a sweep
    // or shortly after it, except the sweep's own confirmation, which says so.
    if (!ev.force && (this._quiet || Date.now() < (this._hushUntil || 0))) {
      console.log('[foxy] confirmation held back:', ev.dir, ev.sats);
      return;
    }

    // a banner over the app you are already looking at is just noise
    const away = document.visibilityState !== 'visible';

    const out = ev.dir !== 'in';
    if (away) {
      /* No amount in the body.
       *
       * This renders on the lock screen and stays in notification history, so
       * "+1,234 sats" showed the activity to anyone who glanced at the phone.
       * The app shows the number when it is opened, which is the right place
       * for it. */
      W.notify(out ? 'sent' : 'received');
    }
    this.haptic && this.haptic('success');

    // This confirmation was not asked for: it arrived while the app was on
    // some other screen. Dismissing it should put that screen back rather
    // than dropping the person on home, which loses whatever they were doing.
    // The invoice screen and the send flow are excluded — those ARE this
    // payment, and going home from them is right.
    /* Every confirmation screen is its own payment's: dismissing a transfer's
     * success used to put the confirmation back, still offering to move the
     * sats again. */
    const own = ['paid', 'sendDone', 'confirm', 'amount', 'tokenOut'].concat(CONFIRM_SCREENS);
    /* A token screen is this payment's own only when it shows the token that
     * was redeemed. Another token's confirmation over it went home on DONE and
     * lost the token screen. */
    const otherToken = this.state.screen === 'tokenOut' && ev.tokenHash
      && ev.tokenHash !== this.state.tokenOutHash;
    if (own.indexOf(this.state.screen) < 0 || otherToken) {
      this._returnTo = { screen: this.state.screen, stack: (this.state.stack || []).slice() };
      console.log('[foxy] confirmation interrupted', this.state.screen);
    } else {
      this._returnTo = null;
    }

    /* Which entry raised it. A confirmation came up thirty milliseconds after
     * a refused payment's token screen opened and nothing said what it was
     * confirming. */
    console.log('[foxy] confirmation: ' + (out ? 'out' : 'in') + ', entry '
      + String(ev.hash || ev.tokenHash || '?').slice(0, 12) + (ev.force ? ', forced' : '')
      + ', raised over ' + this.state.screen);
    /* Held while change for it is being made: the change card comes first
     * and DONE raises this (changeMaking, changeStuckCard). Taking a fresh
     * confirmation down when the card arrived still flashed PAYMENT RECEIVED
     * for the second the swap took. */
    /* A card payment's hold names its payment (fcHoldConfirm, 26f-flashcard.js):
     * another payment's confirmation is not held by it. */
    const heldFor = String(this._holdConfirmFor || '');
    if (!ev.again && Date.now() < (this._holdConfirmUntil || 0)
        && (!heldFor || heldFor === String(ev.hash || ev.tokenHash || ''))) {
      console.log('[foxy] confirmation: held behind the change being made');
      this._heldConfirm = ev;
      return;
    }
    this._heldConfirm = null;
    // the confirmation screen already knows how to word a payment going out
    this.setState(p => ({
      screen: 'paid',
      stack: p.screen === 'paid' ? p.stack : p.stack.concat([p.screen]),
      recvResolved: true,
      // its own heading, where the ordinary one would say the wrong thing
      paidSays: ev.says || '',
      payOut: out,
      paidTo: ev.to || (out ? p.recipient : ''),
      asset: 'BITCOIN',
      unit: 'SATS',
      amount: String(ev.sats),
      recv: Object.assign({}, p.recv, { live: 'in' }),
    }));
  }
