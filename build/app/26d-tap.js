  /* ---- tap to pay, over Bluetooth (TAP-TO-PAY.md) ------------------------ */

  /* Which side of tap to pay this screen is on, kept in step on every update:
   * a Lightning invoice on screen is advertised, and the TAP TO PAY screen
   * searches. Leaving either stops it. */
  /* What the screen in front of somebody can be paid by tap, if anything:
   * `{ inv, req, waiting }`, or null when this screen has nothing payable on
   * it. `waiting` means a request for it is being made and the offer should
   * hold rather than go out half.
   *
   * One place, because there are four screens and two rails and they kept
   * disagreeing. The receive invoice screen only went on the air on the
   * Lightning rail, so switching it to CASHU — where the QR is a payment
   * request and a tap is the better way to hand it over, not a worse one —
   * silently turned tap to pay off. And the split's payer
   * screen, which shows one share's code exactly as the receive screen shows
   * an invoice, was never on the air at all.
   *
   * ON-CHAIN is not here and cannot be: an address is not a thing a Foxy pays
   * over a Bluetooth link. Nor is a bank wire, nor a receive reopened from
   * history as a plain address. */
  tapOffering() {
    const W = window.FoxyWallet;
    if (!W) return null;
    const s = this.state;
    const cashu = (rail) => rail === 'CASHU';
    // a payment that has arrived and is being moved to this phone's mint: nothing more to be paid here
    if (this._carryingHome) return null;

    /* The amount screen of a receive, where the screen arms itself: on the
     * air with nothing to offer yet. A payer's phone needs about a second and
     * a half to open its quiet link and read which iPhone this is, and both
     * CONNECT TO PAY cards wait for that — so the link is given a head start
     * while the amount is still being typed, and the cards are up the moment
     * the invoice screen is. Nothing can be paid from
     * here: the offer is M4 and there is none until the next screen. With
     * AUTO TAP TO PAY off this screen has no TAP button and never arms. */
    if (s.screen === 'amount' && s.flow === 'receive') {
      return this.tapAutoArms() ? { inv: '', req: '', waiting: true } : null;
    }
    // the receive invoice screen
    if (s.screen === 'confirm' && s.flow === 'receive') {
      if (s.recvRail === 'ON-CHAIN' || s.invoiceIsAddress) return null;
      if (s.recvVia === 'wire' || s.network === 'BANK WIRE') return null;
      if (cashu(s.recvRail)) {
        /* The rail's own request, not one made beside it: the QR on screen and
         * the offer on the air have to be the same request, or a share paid by
         * tap settles a row the screen is not watching. */
        const req = this.cashuRequest();
        return req ? { inv: '', req: req, waiting: false } : { inv: '', req: '', waiting: true };
      }
      /* No invoice yet is *waiting*, not *no*.
       *
       * It used to be `null`, which meant this screen could not be tapped at
       * all — so pressing TAP in the second before the invoice was made
       * answered "Nothing to be paid yet" and did nothing.
       * That is the very second the press is most useful: the handshake needs
       * no offer, so the phones can be talking through it and the offer
       * follows (TapReceiver.offerSent). The refusals above are the real ones —
       * on chain, a wire, a plain address — and they stay `null`. */
      /* The ecash half does not wait for the invoice.
       *
       * A Lightning invoice is the mint's to make and takes seconds over Tor.
       * The Cashu request is this phone's own and needs nothing but the amount
       * the person typed — which is the same amount the invoice will be for.
       * So another Foxy at the same mint can be paid the instant the phones
       * touch, and the invoice arrives when it arrives, for the wallets that
       * actually need one.
       *
       * The request comes from `cashuRequest`, which prefers the typed figure
       * over the invoice's, so the two can never name different amounts. */
      const inv = W.classify(String(s.invoice || '')) === 'invoice' ? String(s.invoice) : '';
      /* Made here and now, with no onion address on it: the payment comes back
       * over the link that carried this (`tapOnlyRequest`). So another Foxy at
       * the same mint can be paid the moment the phones touch, and the invoice
       * joins the offer when the mint gets round to making it. */
      const want = this.wantedSats() || W.amountOf(inv) || 0;
      const req = this.tapOnlyRequest(want) || '';
      if (!inv && !req) return { inv: '', req: '', waiting: true };
      return { inv: inv, req: req, waiting: false };
    }

    /* The split's payer screen: one share, one code, held up to one phone.
     * The same screen the receive invoice screen is, for one person's part of
     * a bill, so it behaves the same way. Its request
     * carries `split:<idx>` as its purpose, which is what settles that row
     * when the payment lands (requestPaidHere). */
    if (s.screen === 'spPayer') {
      const idx = Number(s.spIdx) || 0;
      const inv = String((s.spInvoices || [])[idx] || '');
      const want = W.amountOf(inv) || (this.spShareSats ? this.spShareSats(idx) : 0);
      /* Offered the moment the phones touch, as the receive screen's is: a
       * request with no onion address on it, paid back over this link. It
       * waited on the share's Lightning invoice and then on the address,
       * neither of which another Foxy at this mint needs. */
      const quick = want > 0 ? (this.tapOnlyRequest(want, 'split:' + idx) || '') : '';
      // as above: a share whose code is still being made is waiting, not no
      if (!inv) return quick ? { inv: '', req: quick, waiting: false } : { inv: '', req: '', waiting: true };
      const req = this.railRequest(want, 'split:' + idx) || quick;
      if (cashu(s.spRail)) {
        return req ? { inv: '', req: req, waiting: false }
          : { inv: '', req: '', waiting: this.railRequestPending(want, 'split:' + idx) };
      }
      if (W.classify(inv) !== 'invoice') return { inv: '', req: '', waiting: true };
      return { inv: inv, req: req, waiting: !req && this.railRequestPending(want, 'split:' + idx) };
    }

    return null;
  }

  syncTap() {
    const W = window.FoxyWallet;
    if (!W || !W.tapReceive) return;
    const s = this.state;
    // the CONNECT TO PAY card follows the screen as well as the payer
    if (this.syncConnectRecv) this.syncConnectRecv();
    const asking = this.tapOffering();
    /* Being able to go on the air, and choosing to.
     *
     * `tapOffering` says this screen has something a payer could pay. It used
     * to be the whole condition, because the phone that advertised was the
     * payer's and this side only listened — listening emits nothing, so doing
     * it whenever an invoice was up cost nothing.
     *
     * The roles are the other way round now (TapLink.swift): this side is the
     * one on the air. A receive screen that advertised by itself would be a
     * till standing on the air for as long as it was open, which is exactly
     * the beacon the old arrangement existed to avoid. So the button is the
     * condition. Nothing broadcasts until somebody presses TAP, and it comes
     * off the air again the moment the screen goes or a payer is found. */
    const armed = !!(asking && s.tapArmed);
    const advertise = armed;
    const inv = (asking && asking.inv) || '';
    /* Both ways of being paid go over the air, and the payer picks.
     *
     * A payer on this same mint pays with ecash instead of Lightning: phone to
     * phone, no route, no fee, and the mint never sees a payment between two
     * of its own users. Only the payer knows which mint it is on, so the
     * choice is theirs to make and this side offers both.
     *
     * The request is '' for the moment it takes to open an onion address, and
     * appears on a later pass; `railRequest` then keeps it, so the offer
     * settles rather than churning.
     *
     * No *offer* goes out during that moment. An offer without the request
     * half is paid over Lightning — with a routing fee, and with the mint
     * shown both ends — by two phones sitting on the same mint that could have
     * paid each other directly. A payer quick enough to tap inside that window
     * got exactly that.
     *
     * The radio does. Nothing in the handshake needs the offer: it is M4, and
     * the four digits are settled at M3 from the transcript, which the offer is
     * not in. So the placeholder `{}` means "on the air, nothing to offer yet",
     * the phones talk and both screens show the code while the address is still
     * being published, and the real offer follows as M4 the moment there is one
     * (TapLink.offerSent). If the address never answers,
     * railRequest stops waiting and the invoice goes out alone, which is the
     * right fallback and not this case. */
    const req = (asking && asking.req) || '';
    const waiting = advertise && !req && asking.waiting;
    /* Current, not merely known: `priceAgo()` is '' only while the figure on
     * screen is one this app still treats as live. */
    const mine = (W.lastPrice && W.lastPrice()) || { rate: 0 };
    const fresh = (!this.offlineNow() && !this.priceAgo() && Number(mine.rate) > 0)
      ? Number(mine.rate) : 0;
    const offer = !advertise ? ''
      : waiting ? '{}'
      /* `up`: whether this phone has a route, said by the phone that knows.
       *
       * The payer has to know it to hold the hand-over rules up its own end —
       * an offline receiver may only be handed ecash locked to it, at its own
       * mint — and it was being guessed from whether the request named an onion
       * address. That guess is wrong in the common case: Tor takes half a
       * minute to publish one, and an online receiver on the CASHU rail may
       * name none at all, so a perfectly settleable payment looked like two
       * offline phones. A fact about this phone, stated by this phone.
       *
       * Absent on an older Foxy, and absent is not false: the payer falls back
       * to what it did before, which is to make the payment and let the
       * receiver refuse it. */
      : JSON.stringify({ v: 2, inv: inv || undefined, req: req || undefined,
                         up: !this.offlineNow(),
                         /* This phone answers "I am about to pay this" before
                          * any ecash is made (`askFirst`). Said here so a payer
                          * only asks a phone that will answer; an older Foxy
                          * says nothing and is paid as before. */
                         ask: 1,
                         /* And this phone's bitcoin price, when it is current.
                          *
                          * A phone with no route has a price that may be hours
                          * old, and in a tap it is trusting the other one's —
                          * so it should be able to SEE the other one's rather
                          * than convert at its own and hope. The payer already tells a receiver this
                          * in M10; this is the same fact in the other
                          * direction, so an offline payer learns it too.
                          *
                          * Only when it is current: an offer carrying a stale
                          * price would be worse than carrying none, because the
                          * phone reading it has no way to tell. */
                         rate: fresh > 0 ? Math.round(fresh) : undefined,
                         at: fresh > 0 ? Math.round(Date.now() / 1000) : undefined });
    /* An offer already given stands; one never given may still arrive.
     *
     * Swapping an offer under a payer breaks the digits they are comparing.
     * Sending the first one late does not — they are settled at M3, before any
     * offer exists — so the "nothing yet" placeholder is allowed to become the
     * real offer with a payer on the link, and only that. */
    const withAPayer = !!(s.tapShownCode || s.tapRecvStage === 'connecting');
    const firstOffer = this._tapOffer === '{}' && offer !== '{}';
    /* The invoice, sent after the offer when the offer went without it.
     *
     * An offer given stands, and it goes out the moment there is a request to
     * offer, which is before the mint has answered with an invoice. A payer
     * already touching got "no invoice", took that for a receiver with no
     * route, and moved its sats to this phone's mint to pay in ecash there:
     * a Lightning move, a swap and 51 seconds where paying the invoice was
     * one payment (across two mints: the offer went out, was read 0.4 s
     * later, and the invoice came in 3.1 s after the offer). The payer now
     * waits a few seconds for this, which rides the message the price talk
     * answers on (M11), so the offer itself is not swapped under anybody. */
    /* And not into a talk. It rides the message a question is answered on,
     * and a payer waiting on an answer read it as one: a payer with no
     * route, asking what bringing its sats home would cost, got an invoice
     * with no request in it and took that for "they could not take it" —
     * twice in three tries. The same for a payer waiting on a price to be
     * agreed. It goes when the talk is over, if it is still wanted then. */
    if (advertise && inv && withAPayer && !this._tapTalking && this._tapInvTold !== inv && this._tapOffer && this._tapOffer !== '{}') {
      let had = null;
      try { had = JSON.parse(this._tapOffer); } catch (e) { had = null; }
      if (had && !had.inv) {
        this._tapInvTold = inv;
        console.log('[foxy] tap: the invoice is in after the offer went; sending it to the payer on the link');
        if (W.tapTerms) W.tapTerms(JSON.stringify({ inv: inv })).catch(() => {});
      }
    }
    /* Except while this tap is still being talked about.
     *
     * `priceConfirm` and `crossConfirm` are part of a conversation already in
     * flight: the payer has sent a figure and is holding the link open waiting
     * for the answer. They are not receive screens, so everything below read
     * them as "the person left" and called `tapReceiveStop`, which retires the
     * receiver — and the answer, when it came, had nowhere to go. `sendTerms`
     * found no subscribed central and returned false, so an ACCEPT reached the
     * payer as silence.
     *
     * This is what a card used to buy for free — a card floats over the receive
     * screen and `screen` never changes. Turning the decision into a screen
     * took the radio down with it, so the screen has to say it is still in the
     * same tap. Nothing changes: not the offer, not the advertisement, not the
     * link. The clocks that end it are the link's own (TapLink: 90 seconds once
     * a person is being asked, 95 before the payer gives up). */
    /* A tap being talked about holds everything, and the SCREEN is not what
     * says so.
     *
     * Keying this on the screen was wrong twice. First because the decision
     * moved from a card (which leaves `screen` alone) to a screen, which read
     * as leaving. Then because naming the two new screens here was still not
     * enough: `priceAnswer` navigates home and *then* sends the terms, so the
     * update that matters arrives with `screen` already 'home' — the radio was
     * retired sixteen milliseconds before `tapTerms` was called, and the answer
     * had nowhere to go.
     *
     * So it is not a screen question at all. `_tapTalking` is set when a
     * decision is put to a person with a payer waiting, and cleared when the
     * answer has actually gone — by which time nothing else can race it. */
    if (this._tapTalking) return;
    if (!asking && s.tapArmed) this.setState({ tapArmed: false });
    /* The amount screen is on the air early, and says so: the payer's card
     * waits for NEXT. Told again when the screen moves on,
     * even if the offer itself is still the same "nothing yet". */
    const early = s.screen === 'amount';
    if (advertise && (!withAPayer || firstOffer) && (this._tapOffer !== offer || this._tapEarly !== early)) {
      this._tapEarly = early;
      /* Said out loud, because a missing request half is invisible: the offer
       * still works, the payer still pays, and the only sign that ecash was
       * never on the table is a Lightning payment where one was not wanted. */
      console.log('[foxy] tap: on the air, offering '
        + (waiting ? 'nothing yet — the request is still being made'
          : (inv ? 'an invoice' : 'no invoice')
            + (req ? ' and a request for ' + (W.mintUrl || '?') : ' only — no request yet')));
      const was = this._tapOffer;
      this._tapOffer = offer;
      // the code belongs to a payer, and only a swapped offer loses one
      if (was !== '{}' && (s.tapShownCode || s.tapRecvStage === 'connecting')) {
        this.setState({ tapShownCode: '', tapRecvStage: '' });
      }
      W.tapReceive(offer === '{}' ? '' : offer, early).then(() => {
        if (this.state.tapNotYet) this.setState({ tapNotYet: '' });
      }, (e) => {
        /* A refusal has to undo the optimism above, or nothing tries again.
         *
         * `_tapOffer` is set before the call, and the guard that decides to
         * advertise is `this._tapOffer !== offer` — so a refused tapReceive
         * left the phone off the air with the offer recorded as sent. Nothing
         * retried. The screen went on saying HOLD A PHONE HERE over a radio
         * that was not on, and the only way out was to press TAP again, which
         * clears `_tapOffer` by hand. That is the pressing-several-times that
         * was reported, and the refusal is usually "That payment is still
         * going through. A moment." — which passes on its own in a second or
         * two.
         *
         * So: forget the offer, say so on the screen, and let the next pass
         * try again. On a clock rather than at once, because syncTap runs on
         * every update and an immediate retry against a mint that is busy is a
         * loop. */
        console.warn('[foxy] tap: not advertising:', e.message);
        this._tapOffer = null;
        const why = (W.reason ? W.reason(e) : e.message) || '';
        if (this.state.tapNotYet !== why) this.setState({ tapNotYet: why });
        clearTimeout(this._tapRetryT);
        this._tapRetryT = setTimeout(() => {
          if (this.state.tapArmed) this.syncTap();
        }, 1200);
      });
    } else if (!advertise && this._tapOffer) {
      this._tapPaidHere = false;
      this._nearEdge = '';
      if (this.hideConnectRecv) this.hideConnectRecv();
      clearTimeout(this._tapRetryT);
      if (this.state.tapNotYet) this.setState({ tapNotYet: '' });
      this._tapOffer = null;
      /* `off` goes too. It was the receiver that said the radio was off, and
       * the receiver is being stopped: a stage that outlives it kept the next
       * invoice screen from arming at all — `syncTap` refuses to arm with the
       * radio off — so nothing ever asked the radio again, and the button
       * stayed grey with Bluetooth on until the app was killed. The next
       * screen arms afresh, and a receiver that
       * finds the radio still off says `off` again. */
      if (s.tapShownCode || s.tapRecvStage === 'connecting' || s.tapRecvStage === 'off') {
        this.setState({ tapShownCode: '', tapRecvStage: '' });
      }
      W.tapReceiveStop();
    }

    /* The search runs once per visit to this screen, and stops for good once
     * an offer is in.
     *
     * `tapPay` resolves, `_tapPaying` goes null, and this used to see "on the
     * tap screen with nothing running" and start again — a second later, while
     * the confirmation was still a beat away. Starting again tears down the
     * Bluetooth link to build a new one, and that link is what the payment was
     * about to go over: every ecash payment fell back to the onion with "that
     * phone is no longer connected", and took twelve to twenty-six seconds
     * instead.
     *
     * The link is left alone when the screen changes, too. The payer is on the
     * confirmation by then and the money still has to cross; the native side
     * lets it go by itself after three minutes if nobody pays. */
    /* Listening, from the screens a person pays from.
     *
     * This costs nothing to anybody: a central hears and says nothing, so a
     * phone doing this in a room full of merchants gives away nothing it could
     * be followed by. It is why the payer can be the one always ready, and why
     * paying needs no screen of its own — the merchant presses TAP, this phone
     * hears it, and the confirmation comes up.
     *
     * Home and the send screen, and nowhere else. Not while a payment is
     * already going out (`sendPhase`) or a request is being paid (`reqBusy`):
     * a second payment opening itself over the first is the one way this could
     * cost money rather than a moment. Not in the background either — Foxy has
     * no background modes and asks for none, so this stops with the
     * foreground. */
    /* `sendPhase === 'in'`, not any `sendPhase`.
     *
     * A completed send leaves it `'settled'`, and the paths that clear it are
     * ones a *successful* send never takes (03-send.js). So the first payment
     * of a launch turned listening off for the rest of the app's life: the
     * payer went on the air once and heard nothing for the next nine minutes
     * while the receiver pressed TAP six more times, each with its own
     * service UUID, every one of them inside a window the payer spent sitting
     * on home. What must stop a
     * listen is money actually on the wire, which is what `'in'` means. */
    /* And not under the launch screen. Home is the screen behind it from the
     * first frame, so the listen started there — and the first listen is what
     * makes iOS ask for Bluetooth. On a first launch that put a system alert
     * over SECURING YOUR CONNECTION, and Tor's control link went unanswered
     * for ten seconds behind it. Asked
     * once the connection is up and home is what the person is looking at. */
    const G = window.FoxyGate;
    const gateUp = !!(G && G.visible && G.visible());
    /* The receiver arms itself. An invoice with an amount
     * on screen goes on the air without a press, so two Foxys held together
     * pay with no button. What it gives away is a random UUID for the length
     * of an invoice instead of a tap, unattributable and never repeated — and
     * every invoice advertising means a sniffer who knows Foxy's shape can no
     * longer tell a tap from a QR receive. The payer's side is untouched: it
     * still never advertises. TAP-TO-PAY.md, "The screen is the whole of it".
     *
     * Not while a code is up, not while a payer is connecting, not with the
     * radio off, and not when the person has turned it off in the menu. */
    if (this.tapAutoArms() && asking && !s.tapArmed && !s.tapShownCode
        && s.tapRecvStage !== 'connecting' && ['off', 'denied', 'unsupported'].indexOf(s.tapRecvStage) < 0
        && !gateUp && !this._tapTalking && !this._tapPaidHere && !(this.tapPaidChecking && this.tapPaidChecking())) {
      console.log('[foxy] tap: armed by the screen');
      this._tapOffer = null;
      // the QR stays: the card that covers it is for a press (`tapAutoFresh` gives the first press that)
      this.setState({ tapArmed: true, tapCardOff: true, tapAutoFresh: true });
      return;
    }
    const listening = (s.screen === 'home' || s.screen === 'sendHow')
      && s.sendPhase !== 'in' && !s.reqBusy && !gateUp;
    /* And the marks are cleared only when there is no tap to protect.
     *
     * `_tapKeep` is what stops `syncTap` searching again under a live link —
     * the link the payment is about to cross. It used to be safe to clear both
     * on home, because a payer that had taken an offer was on its own tap
     * screen, never home. The payer lives on home now, so this ran in the same
     * update as the offer landing and tore the link down: the first tap fell
     * back to the onion with "that phone is no longer connected" and took
     * 7941 ms instead of 200. That is
     * the regression the comment above this describes, arriving by the other
     * door. `_tapKeep` is dropped when the payment is done with the link, so
     * waiting for it is exactly right. */
    if (s.screen !== 'home') this._tapAway = true;
    if (s.screen === 'home' && this._tapAway && s.sendPhase !== 'in' && !this.changeStillDue()) {
      /* Home again, with the payment over: the next tap may start.
       *
       * The marks cannot be cleared the moment the offer lands, because that
       * happens *on* home — the payer has no screen of its own any more — and
       * clearing them there tore down the link the payment was about to cross
       *. They cannot be left for ever either, or one tap ends
       * listening for the life of the app. So the release is "went away and
       * came back": `tapStartPay` navigates to the confirmation the instant an
       * offer lands, so a return to home is the payment being finished with. */
      this._tapAway = false;
      this._tapGot = false;
      this._tapKeep = false;
      /* And five seconds of not listening, when what ended was a payment.
       *
       * The receiver is very likely still on the air: an invoice paid over
       * Lightning is news its mint has to give it. Listening at once heard
       * it again and put CONNECT TO PAY up on both phones, for a payment
       * that was already made. */
      if (this._tapPaidAt) { this._tapPaidAt = 0; this._tapQuietUntil = Date.now() + 5000; }
    }
    const quietFor = (this._tapQuietUntil || 0) - Date.now();
    if (quietFor > 0 && !this._tapQuietT) {
      this._tapQuietT = setTimeout(() => { this._tapQuietT = null; this.syncTap(); }, quietFor + 30);
    }
    if (listening && quietFor <= 0 && !this._tapPaying && !this._tapGot) this.tapStartPay();
    else if (!listening && this._tapPaying && !this.changeStillDue()) {
      /* Not while change is owed.
       *
       * `listening` is false the moment the payment leaves — the payer is on
       * the confirmation screen, not home — so this fired about four seconds
       * before the receiver's change was ready and took the link with it. The
       * release on reaching home was guarded and this, which happens first, was
       * not. Both have to know. */
      this._tapPaying = null;
      this.hideTapNearby();
      this.tapBuzz(false);
      W.tapPayStop();
    }
    if (!listening && this._tapGot && !this._tapKeep) this._tapGot = false;
    /* And a backstop, for a tap that ended somewhere this does not know about.
     *
     * The release above is "went away from home and came back", which is how a
     * finished payment announces itself. Every path that ends a tap WITHOUT
     * going anywhere has to say so itself (`tapGaveNothing`), and the ones that
     * exist do — but a path added later would not, and the cost is a payer that
     * silently stops hearing taps until it is navigated away and back. So: sitting on home, nothing in flight, nothing owed,
     * and an offer that landed fifteen seconds ago and went nowhere, is a tap
     * that is over. A real one is off home inside a second. */
    /* Not while an answer is being waited for. The price talk happens on home
     * — the waiting screen is drawn over it — and a person reading two figures
     * on the other phone takes longer than fifteen seconds as often as not.
     * This let the link go under them: let go 26 seconds after the question,
     * and their YES two seconds later went to nobody. The wait has its own
     * clock, ninety seconds, and its own CANCEL. */
    const waitingOnAnswer = !!this._tapQuoteSeq || !!s.tapQuoteWait || !!this._tapTalking;
    if (listening && this._tapGot && !this._tapPaying && !this.changeStillDue() && !waitingOnAnswer
        && this._tapGotAt && Date.now() - this._tapGotAt > 15000) {
      this.tapGaveNothing('nothing came of it');
    }
  }

  /* ---- a payment by tap that the other phone has not seen yet ----------
   *
   * Ecash crosses the link and is answered on it, so both phones know at
   * once. An invoice paid over Lightning is not: the payer's mint pays the
   * receiver's, and the receiver hears from its own mint, on its own clock.
   * For those seconds the receiver is still on its invoice screen and on the
   * air, and the payer is home again and listening (CONNECT TO PAY on both,
   * for a payment already made).
   *
   * Three things, each of which is enough by itself:
   *   the payer says "paid" over the link, and the receiver asks its mint
   *     at once (`tapSayPaid`, `tapPaidNotice`);
   *   the payer does not listen for five seconds after a payment (`syncTap`);
   *   an offer this phone has already paid is said to be ALREADY PAID and is
   *     not paid again (`tapWasPaid`, in `tapStartPay`). */

  /* What names an offer: the end of its invoice, and its request's id. Kept
   * for a day, thirty at most, on this phone only. */
  tapPaidKeys(offer, req) {
    const keys = [];
    const inv = String((offer && offer.inv) || '');
    if (inv.length > 40) keys.push('i:' + inv.toLowerCase().slice(-24));
    const id = String((offer && offer.read && offer.read.id) || '');
    if (id) keys.push('r:' + id);
    const paid = String((req && req.id) || '');
    if (paid && paid !== id) keys.push('r:' + paid);
    return keys;
  }
  tapPaidList() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem('foxy.tap.paid') || '[]'); } catch (e) { list = []; }
    const since = Date.now() - 86400000;
    return (Array.isArray(list) ? list : []).filter(x => x && typeof x.k === 'string' && Number(x.at) > since);
  }
  tapMarkPaid(offer, req) {
    const keys = this.tapPaidKeys(offer, req);
    // home again from this, the phone does not listen for five seconds (syncTap)
    this._tapPaidAt = Date.now();
    if (!keys.length) return;
    const list = this.tapPaidList().filter(x => keys.indexOf(x.k) < 0);
    keys.forEach(k => list.push({ k: k, at: Date.now() }));
    try { localStorage.setItem('foxy.tap.paid', JSON.stringify(list.slice(-30))); } catch (e) {}
  }
  /* When this phone paid that offer, or 0. */
  tapWasPaid(offer) {
    const keys = this.tapPaidKeys(offer, null);
    if (!keys.length) return 0;
    const hit = this.tapPaidList().filter(x => keys.indexOf(x.k) >= 0).map(x => Number(x.at) || 0);
    return hit.length ? Math.max.apply(null, hit) : 0;
  }
  tapAgoWords(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 5 ? 'a moment ago' : s < 90 ? s + ' seconds ago' : s < 5400 ? Math.round(s / 60) + ' minutes ago' : Math.round(s / 3600) + ' hours ago';
  }
  /* The payer, telling the receiver its invoice is paid. Over the link the
   * tap made, if it is still there; said and forgotten if it is not, because
   * the receiver's mint will tell it anyway. Only which invoice: the end of
   * the invoice the receiver itself made. */
  tapSayPaid(inv) {
    const W = window.FoxyWallet;
    if (!W || !W.tapQuote || !inv) return;
    W.tapQuote(JSON.stringify({ paid: { tail: String(inv).toLowerCase().slice(-16) } })).then(
      () => console.log('[foxy] tap: told them the invoice is paid'),
      (e) => console.log('[foxy] tap: could not tell them the invoice is paid (' + ((e && e.message) || e) + '); their mint will'));
  }
  /* A Lightning send has finished (03-send.js). If the invoice was a tap's,
   * the other phone is told and the offer is remembered as paid. */
  tapPaidByLightning(inv) {
    const offer = this._tapOfferNow;
    const same = (a, b) => String(a || '').replace(/^lightning:/i, '').toLowerCase() === String(b || '').replace(/^lightning:/i, '').toLowerCase();
    if (!offer || !offer.inv || !same(offer.inv, inv)) return;
    this.tapMarkPaid(offer, null);
    this.tapSayPaid(inv);
  }
  /* The receiver's mint is asked every second for a while (`watchKick`). */
  tapWatchClosely(ms) {
    const W = window.FoxyWallet, s = this.state;
    if (!W || !W.watchKick || !s.invoiceHash || !this._watching) return false;
    return W.watchKick(s.invoiceHash, ms);
  }
  /* The payer has said this screen's invoice is paid, within the last twenty
   * seconds, and the mint has not agreed yet. */
  tapPaidChecking() {
    return !!this._tapPaidNote && Date.now() - this._tapPaidNote < 20000;
  }
  /* The receiver, hearing the payer say so (M10 `{ paid }`).
   *
   * Not believed: the payer's word moves no money. It is a reason to ask the
   * mint now instead of in ten seconds, and to stop offering the same invoice
   * to the phone that says it has paid it. The screen says what is happening
   * and goes to PAYMENT RECEIVED only when the mint says so; if the mint has
   * not seen it in twenty seconds the invoice is simply open again. */
  tapPaidNotice(info) {
    const s = this.state;
    const tail = String((info && info.tail) || '').toLowerCase();
    const mine = String(s.invoice || '').toLowerCase();
    const onScreen = s.screen === 'confirm' && s.flow === 'receive';
    if (!onScreen || tail.length < 12 || !mine || mine.slice(-tail.length) !== tail) {
      console.log('[foxy] tap: the payer says it paid an invoice that is not the one on this screen; nothing done');
      return;
    }
    if (this.tapPaidChecking()) return;
    console.log('[foxy] tap: the payer says this invoice is paid; asking the mint now');
    this._tapPaidNote = Date.now();
    clearTimeout(this._nearGoneT);
    this._nearEdge = '';
    if (this.hideConnectRecv) this.hideConnectRecv();
    this.tapWatchClosely(20000);
    this.waitingScreen('paidCheck', {
      art: 'phone', title: 'Confirming<br>payment', dots: true, forMs: 20000,
      body: 'The payer says this is paid. Foxy is asking your mint.',
      code: s.tapShownCode || '',
      button: 'CLOSE',
      go: () => {},
    });
    clearTimeout(this._tapPaidNoteT);
    this._tapPaidNoteT = setTimeout(() => {
      if (!this._tapPaidNote) return;          // the mint agreed, and the screen moved on
      this._tapPaidNote = 0;
      if (this.hideStage) this.hideStage('paidCheck');
      console.log('[foxy] tap: the mint has not seen that payment after 20s; the invoice is still open');
      this.toast('Your mint has not seen that payment yet. The invoice is still open.', true);
      this.syncTap();
    }, 20200);
  }

  /* A tap that produced no payment, so the next one may be heard.
   *
   * `_tapGot` and `_tapKeep` exist to stop `syncTap` searching again under a
   * link the payment is about to cross. When there is no payment there is no
   * link to protect, and holding them is just deafness. */
  tapGaveNothing(why) {
    this._pricedFor = null;      // the next tap agrees its own price
    this._crossReady = null;     // and asks its own crossing
    if (!this._tapGot && !this._tapKeep) return;
    console.log('[foxy] tap: letting that one go \u2014 ' + (why || 'nothing came of it'));
    this._tapGot = false;
    this._tapKeep = false;
    this._tapAway = false;
    this._tapGotAt = 0;
    this.syncTap();
  }

  /* Is this phone still owed change over a link it must not let go of?
   *
   * An offline payer with no exact pieces over-pays, and the receiver hands the
   * difference back over the same link — but it has to swap at the mint to make
   * it, and that takes seconds. The payer was finishing first: the payment
   * went, the person was back on home 1.6 seconds later, the link went with
   * them, and the receiver's change was ready a second after that and had
   * nowhere to go. One second.
   *
   * Bounded, because a link held for ever is a radio held for ever. Thirty
   * seconds is a swap over a cold circuit with room to spare; past it the change
   * is on the receiver's token screen, which is where an undelivered one lives
   * anyway. */
  CHANGE_WAIT_MS = 30000;

  changeStillDue() {
    // the change is here, and the receiver is being told so: the link stays for that
    if (this._ackHold && Date.now() < this._ackHold) return true;
    if (!this._changeDueAt) return false;
    if (Date.now() < this._changeDueAt) return true;
    console.log('[foxy] tap: no change arrived within '
      + Math.round(this.CHANGE_WAIT_MS / 1000) + 's; letting the link go');
    this._changeDueAt = 0;
    /* The payment's entry said what it would cost once the change came back.
     * It did not, so the entry becomes what it really cost. */
    const W = window.FoxyWallet;
    if (this._changeForHash && W && W.changeSettled) {
      W.changeSettled(this._changeForHash, 0);
      this._changeForHash = '';
      this.loadHistory();
    }
    /* Said, not only written down. The diary had "no change came back" and
     * the person had nothing: they had been shown a payment that worked. */
    const owed = Math.round(Number(this._changeOwedSats) || 0);
    this._changeOwedSats = 0;
    this.refreshBalance();               // it was counted while it was awaited
    const money = owed > 0 && this.stageMoney ? this.stageMoney(owed) : '';
    this.waitingScreen('changeNeverCame', {
      title: 'You are<br>owed change', amount: money,
      body: (money ? 'You are due <strong>' + money + '</strong> in change.<br>' : '')
        + 'Please scan the QR code on the receiver\u2019s screen.',
      button: 'SCAN',
      go: () => this.setState(p => ({ screen: 'sendScan', stack: p.stack.concat([p.screen]), flow: 'send' })),
    });
    return false;
  }

  /* Told by the send when the receiver owes change back, and cleared when it
   * arrives (onTapChange) or the wait runs out. */
  expectChange(sats, hash) {
    if (!(Number(sats) > 0)) return;
    this._changeDueAt = Date.now() + this.CHANGE_WAIT_MS;
    this._changeForHash = hash || '';
    this._changeOwedSats = Number(sats) || 0;
    console.log('[foxy] tap: ' + this.group(sats)
      + ' sats of change are owed, so the link is held open for it');
    /* And looked at again when the wait runs out, in case nothing else redraws:
     * `syncTap` only runs on a render, and a phone sitting on home has none. */
    clearTimeout(this._changeWaitT);
    this._changeWaitT = setTimeout(() => this.syncTap(), this.CHANGE_WAIT_MS + 250);
  }

  changeArrived(sats) {
    if (!this._changeDueAt) return;
    this._changeDueAt = 0;
    this._changeOwedSats = 0;
    /* One transaction, with the change inside it: the payment's own entry is
     * finished rather than a second row appearing for money coming back. */
    const W = window.FoxyWallet;
    if (this._changeForHash && W && W.changeSettled) {
      W.changeSettled(this._changeForHash, Number(sats) || 0);
      this._changeForHash = '';
    }
    clearTimeout(this._changeWaitT);
    console.log('[foxy] tap: the change arrived, so the link may go');
    this.refreshBalance();
    this.syncTap();
  }

  /* TAP, on a receive screen. This is what puts the phone on the air.
   *
   * Pressed again after a payment it is a new receiver, with a new service
   * UUID and new keys — the bridge does that, because reusing the old one
   * would put the same number back on the air and hand the next customer a
   * conversation the last payer's keys belong to (FoxyBridge+Tap.swift).
   * Here that is just: clear what the last payer left on screen, and ask. */
  /* Whether the invoice screen arms itself. On unless the person turned it
   * off (MENU > TAP ON PRESS); the press and the shake work either way. */
  tapAutoArms() {
    try { return localStorage.getItem('foxy.tap.auto') !== 'off'; } catch (e) { return true; }
  }

  tapAutoSet(on) {
    try { localStorage.setItem('foxy.tap.auto', on ? 'on' : 'off'); } catch (e) {}
    console.log('[foxy] tap: the invoice screen ' + (on ? 'arms itself' : 'arms on a press only'));
    if (!on && this.state.tapArmed && !this.state.tapShownCode) this.setState({ tapArmed: false });
    this.forceUpdate();
  }

  /* The X on the code card: that phone is let go, and this one goes back on
   * the air.
   *
   * It only hid the card. The handshake is open to anything in radio range
   * that speaks it (TAP-TO-PAY.md, "What it gives away"), and a phone that
   * links and then says nothing holds this receiver for as long as it likes:
   * one payer at a time, and the code card over the QR. A clock would drop a
   * real payer who is still reading their screen, so it is the person's call
   * instead — a code up and nobody paying is something they can see, and this
   * is the one press that answers it. If it keeps
   * happening, Bluetooth off, or AUTO TAP TO PAY off, ends it.
   *
   * Not while a payment or a price is in the middle of crossing: then X only
   * puts the card away, as it always did, and the link is left alone. */
  /* The receiver's CONNECT TO PAY card is up exactly when a payer has said it
   * is near AND this screen has a code for it to cover. Asked on every pass,
   * so it arrives with the invoice screen and leaves with it. */
  syncConnectRecv() {
    const s = this.state;
    const onCode = (s.screen === 'confirm' && s.flow === 'receive') || s.screen === 'spPayer';
    if (this._nearEdge && onCode && !s.tapShownCode && s.tapRecvStage !== 'connecting' && this.tapOffering()) {
      this.showConnectRecv(this._nearEdge);
    } else {
      this.hideConnectRecv();
    }
  }

  tapDropPayer() {
    const s = this.state;
    const W = window.FoxyWallet;
    const midway = !!this._tapTalking || !!this._tapPaidHere || s.tapRecvStage === 'connecting';
    if (!s.tapShownCode || midway || !W || !W.tapReceiveStop) {
      this.setState({ tapCardOff: true });
      return;
    }
    console.log('[foxy] tap: X on the code; that phone is let go and this one goes back on the air');
    this._tapOffer = null;
    W.tapReceiveStop();
    // `syncTap` arms the screen afresh (a new number, new keys) where it arms itself
    this.setState({ tapShownCode: '', tapArmed: false, tapRecvStage: '', tapCardOff: true, tapAutoFresh: false });
    this.toast('That phone was let go.');
  }

  tapArm() {
    /* With the radio off there is nothing to arm: the button is greyed and
     * says why. */
    if (['off', 'denied', 'unsupported'].indexOf(this.state.tapRecvStage) >= 0) {
      /* Refused once, iOS never asks again: the only way back is Foxy's own
       * page in Settings, and the button takes them there. */
      if (this.state.tapRecvStage === 'denied') {
        const W = window.FoxyWallet;
        this.blockedCard('bluetoothDenied', {
          tone: 'warn',
          title: 'BLUETOOTH NOT ALLOWED',
          reason: 'Tap to pay needs Bluetooth, and Foxy was not allowed to use it. Turn it on for Foxy in Settings.',
          retry: 'OPEN SETTINGS',
          go: () => { if (W && W.openSettings) W.openSettings(); },
        });
        return;
      }
      this.toast('Enable Bluetooth to use tap to pay.', true);
      return;
    }
    if (!this.tapOffering()) { this.toast('This cannot be paid by tap.', true); return; }
    const s = this.state;
    /* Pressed while the card is up, it is the card's X.
     *
     * The card covers the QR — TAP HERE, then the four digits — and the only
     * way to get the code back used to be a small X in its corner that nobody
     * found. The button that raised it puts it away. It
     * does not go off the air: that is the screen's doing, and after a payment
     * this phone has already stopped advertising by itself. */
    if (s.tapShownCode || (s.tapArmed && !s.tapCardOff)) {
      console.log('[foxy] tap: TAP pressed; the card goes away, the phone stays on the air');
      this.setState({ tapCardOff: true });
      return;
    }
    /* Armed by the screen, no code yet: the press brings the TAP HERE card up,
     * which is the one thing the screen does not do by itself. */
    if (s.tapArmed && s.tapCardOff && s.tapAutoFresh && s.tapRecvStage !== 'connecting') {
      console.log('[foxy] tap: TAP pressed; showing the card over the code');
      this.setState({ tapCardOff: false, tapAutoFresh: false });
      return;
    }
    /* Not while a payer is on the way in.
     *
     * Pressing TAP again is a NEW receiver: a new service UUID and new keys,
     * because reusing the old one would hand the next customer a conversation
     * the last payer's keys belong to. That is right after a payment and wrong
     * in the middle of one — and the two were indistinguishable here.
     *
     * What the person does is press TAP, see the prompt, press again when
     * nothing has happened yet (which only put the prompt away), and press a
     * third time — and that third press tore the radio down and put a
     * different number on the air while a payer was part way through its
     * handshake. So the payer found nothing where it had just been talking and
     * had to start over, which is the tapping-several-times this is named for. The press still brings the prompt back; it just does
     * not throw away the conversation it is waiting for.
     */
    if (s.tapRecvStage === 'connecting') {
      console.log('[foxy] tap: TAP pressed while a payer is connecting; keeping that link');
      this.setState({ tapCardOff: false });
      return;
    }
    console.log('[foxy] tap: TAP pressed; going on the air'
      + (s.tapArmed ? ' again, with a new number and new keys' : ''));
    this._tapOffer = null;
    this.haptic('tap');
    this.setState({ tapArmed: true, tapShownCode: '', tapCardOff: false, tapRecvStage: '' });
  }

  /* Shake to tap, armed for exactly as long as the receive invoice screen
   * has something a payer could pay, and synced from the same place the
   * screen is kept awake (TAP-TO-PAY.md). iOS recognises the shake; a
   * shake then presses TAP. Nothing goes over the air for it: it is a press. */
  syncShake() {
    const W = window.FoxyWallet;
    if (!W || !W.shakeSense) return;
    const s = this.state;
    const want = s.screen === 'confirm' && s.flow === 'receive' && !!this.tapOffering();
    if (want === !!this._shaking) return;
    this._shaking = want;
    W.shakeSense(want);
  }

  /* Screens somebody looks at without touching, so iOS must not dim them.
   *
   * A receive screen is held up for another phone to read or scan, and the
   * payer's tap screen is held next to it — neither gets a touch for as long
   * as it is doing its job, and the phone was locking part way through. The gate asks for itself (foxy-tor-gate.js): its
   * screen is up before this one exists. */
  /* The invoice screen the right way up for the person across the table.
   *
   * A receiver lays the phone down with its top towards the payer, and the
   * code and the amount were upside down to the one person who needed to
   * read them. The app stays in portrait as far as iOS is
   * concerned — every iPhone since the X refuses to rotate an app upside
   * down — and the page turns itself round instead, on the one screen where
   * it is wanted. Everything on it, the overlays included, goes with it. */
  syncFlip() {
    const s = this.state;
    /* Off: a phone lying top-down made the tap less
     * reliable — the marks and the edges to bring together stopped agreeing.
     * The screen stays as it is whichever way up the phone lies; the code
     * below is kept for when it comes back. */
    const FLIP = false;
    const want = FLIP && !!s.upsideDown && s.screen === 'confirm' && s.flow === 'receive';
    if (want === !!this._flipOn) return;
    this._flipOn = want;
    try {
      const root = document.documentElement;
      root.style.transform = want ? 'rotate(180deg)' : '';
      root.style.transformOrigin = want ? '50% 50%' : '';
      // the card is drawn for the way up the page is: again, now that it has turned
      if (this.hideConnectRecv) this.hideConnectRecv();
      if (this.syncConnectRecv) this.syncConnectRecv();
      console.log('[foxy] the invoice screen is ' + (want ? 'turned round for the phone lying top-down' : 'the right way up again'));
    } catch (e) {}
  }

  syncAwake() {
    const W = window.FoxyWallet;
    if (!W || !W.keepAwake) return;
    const s = this.state;
    /* And while a payment is actually going out.
     *
     * `sendPhase === 'in'` is money on the wire — a swap at the mint, then a
     * delivery over Bluetooth, an onion or a relay, and the delivery can take
     * tens of seconds if the first route fails. The screen was not held for
     * any of it, so iOS locked the phone part way through, and locking runs
     * `appEnteredBackground` → `TorService.backgrounded`, which zeroes the
     * SOCKS port: the next attempt came back `noTor` and the payment fell to
     * the token screen for no reason but the lock. Released as soon as the
     * phase ends, like every other. */
    /* And while a tap is being talked about.
     *
     * `priceConfirm` and `crossConfirm` are a person reading figures with a
     * payer holding a Bluetooth link open on the other side of the table. The
     * screen was allowed to sleep through exactly that — "screen kept awake:
     * no" at the moment the price screen came up — and a phone that locks takes
     * the link down with it, which is a second, independent way for the answer
     * to reach nobody.
     *
     * The link's own clocks are what end it: 90 seconds once a person is being
     * asked, 95 before the payer gives up. The screen has to outlast those. */
    const talking = !!this._tapTalking;
    const want = (s.screen === 'confirm' && s.flow === 'receive') || /^sp/.test(String(s.screen || ''))
      || talking || s.sendPhase === 'in';
    if (want === !!this._awake) return;
    this._awake = want;
    W.keepAwake(want);
  }

  /* Ecash that arrived and was never swapped in, swapped before it is needed.
   *
   * A payment locked to this phone counts in the balance the moment it lands,
   * because it is already this phone's money. The swap that puts it in the
   * pile can still fail — the mint unreachable, a write refused — and it then
   * waits on the unclaimed list. That is fine until somebody is paid and
   * spends it straight away: the balance counts it, the proofs are not in the
   * pile, and the send is refused for money the screen says is there.
   *
   * Every screen money can leave from, not only the confirmations — a token is
   * generated straight from SET AMOUNT with nothing in between. Done from the
   * screen rather than inside sendToken, where it belongs on paper: a claim is
   * itself a swap, and starting one from inside a send re-enters the wallet's
   * own swap machinery and hangs. Cheap to call: it returns at once when there
   * is nothing waiting, which is almost always. */
  syncClaim() {
    const W = window.FoxyWallet;
    if (!W || !W.claimUnclaimed) return;
    const s = this.state;
    const at = s.screen;
    const spending = CONFIRM_SCREENS.indexOf(at) >= 0
      || (at === 'amount' && s.flow === 'send')
      || at === 'sendHow';
    if (!spending) { this._claimedAt = null; return; }
    if (this._claimedAt === at) return;
    this._claimedAt = at;
    W.claimUnclaimed().catch(() => {});
  }

  /* A waiting screen, or the card it replaced where there is no screen to
   * draw (the suites lift these methods without the loaders). The diary line
   * is the card's own, so a log reads as it did. */
  waitingScreen(kind, o) {
    if (this.hideConnecting) this.hideConnecting();
    if (!this.stageScreen) { this.blockedCard(kind, { tone: 'ask', title: String(o.title).replace(/<br>/g, ' ').toUpperCase(), reason: o.body }); return; }
    console.log('[foxy] blocked: ' + kind + ' \u2014 ' + String(o.body || '').replace(/<[^>]+>/g, ' '));
    this.stageScreen(kind, o);
  }

  /* The receiver, with a payer linked and nothing to do but wait for them.
   *
   * The link is made, the offer has gone and the four digits are up; what
   * happens next happens on the other phone. `offline` is the payer saying it
   * has no route and is being asked to agree this phone's bitcoin price. */
  waitingForPayer(offline) {
    /* Only the price check. A payer who is simply deciding whether to press
     * SEND is waited for on the invoice screen, with the four digits, as it
     * always was. */
    if (!offline) { if (this.hideStage) this.hideStage('waitPayer'); return; }
    if (!this._tapOffer && !this.state.tapArmed) return;
    this.waitingScreen('waitPayer', {
      art: 'phone', title: 'Waiting<br>for payer', dots: true, forMs: 95000,
      body: 'This payer is offline and must agree to the current Bitcoin price before continuing.',
      code: this.state.tapShownCode || '',
      button: 'CANCEL',
      go: () => this.setState({ tapArmed: false, tapRecvStage: '' }),
    });
  }

  /* What the native side says as either side goes. */
  /* RECEIVING ECASH, with a percentage, while a large payment is still
   * arriving. Put up once and written to after that; taken down if nothing
   * more is heard for twenty seconds, which is a payer that went. The
   * payment landing puts up the ordinary receiving screen in its place. */
  tapReceiving(pct) {
    if (!this._recvProg || !document.getElementById('foxy-melt')) {
      this._recvProg = true;
      this.showMelt('Receiving ecash\u2026');
    }
    const h = document.querySelector('#foxy-melt h1');
    if (h) h.innerHTML = 'Receiving ecash<br>' + Math.max(0, Math.min(99, Math.round(pct))) + '%';
    clearTimeout(this._recvProgT);
    this._recvProgT = setTimeout(() => {
      if (!this._recvProg) return;
      this._recvProg = false;
      this.hideMelt();
    }, 20000);
  }

  tapHeard(ev) {
    /* How far a large payment has got across the link. Said by both radios
     * for anything that will take more than a moment, and shown where the
     * person is already looking: the payer's SENDING, and on the receiver a
     * RECEIVING ECASH screen over the code. */
    if (ev.side === 'pay' && ev.stage === 'sending') {
      if (this.state.sendPct !== ev.pct) this.setState({ sendPct: Number(ev.pct) || 0 });
      return;
    }
    if (ev.side === 'receive' && ev.stage === 'receiving') {
      this.tapReceiving(Number(ev.pct) || 0);
      return;
    }
    /* Shaken: the button is pressed, with every rule the button has. Only on
     * a receive screen with an offer, and only when not already on the air —
     * a shake never puts the code card away and never touches a payer that
     * is connecting; `tapArm` keeps both (TAP-TO-PAY.md). */
    if (ev.side === 'receive' && ev.stage === 'shake') {
      const s = this.state;
      const onScreen = s.screen === 'confirm' && s.flow === 'receive' && !!this.tapOffering();
      if (!onScreen || s.tapArmed || s.tapShownCode || s.tapRecvStage === 'connecting') {
        console.log('[foxy] tap: shake ignored \u2014 '
          + (!onScreen ? 'not on a receive screen with an offer' : 'already on the air'));
        return;
      }
      console.log('[foxy] tap: shaken; pressing TAP');
      this.tapArm();
      return;
    }
    if (ev.side === 'receive' && ev.stage === 'code' && this._tapOffer) {
      /* Armed stays true, and it is not about the radio.
       *
       * It was cleared here for a few minutes, on the reasoning that the radio
       * stops at the subscribe so the button should go plain. That reasoning
       * was about the wrong thing: `tapArmed` is what `syncTap` reads to decide
       * whether this screen wants a receiver at all, so clearing it tore the
       * receiver down the instant the code appeared — ten seconds before the
       * payer even tried to send, and long before `busy` could protect it. The
       * payment went into a link that was no longer there, `tapSend` timed out,
       * and it fell back to the onion.
       *
       * So it means "this screen has a tap going", from the press until the
       * payment is done or the screen goes. The accent says the same. */
      this.hideConnecting();          // the code is the link being made
      /* A payer has the offer. If it pays the invoice rather than the
       * request, nothing comes back over this link, so the mint is asked
       * every second for the next minute instead of every ten. */
      if (this.tapWatchClosely) this.tapWatchClosely(60000);
      this.setState({ tapShownCode: ev.code || '', tapCardOff: false });
      if (this._buzzRecv) this.tapBuzz(false);
      this.haptic('success');
      return;
    }
    /* The payer left with the link made and nothing answered. If they had
     * pressed SEND, their phone is now showing the payment as a code and the
     * way to finish is to scan it; if they had not, there is nothing to scan
     * and NOT NOW says so. This phone cannot tell which, so it offers both. */
    if (ev.side === 'receive' && ev.stage === 'gone') {
      // it may have paid the invoice and left: asked quickly for a while longer
      if (this.tapWatchClosely) this.tapWatchClosely(30000);
      if (this._buzzRecv) this.tapBuzz(false);
      const was = this.stageUp && this.stageUp('waitPayer');
      const talking = !!this._tapTalking;
      if (this.hideStage) this.hideStage('waitPayer');
      /* The conversation is over: the other phone has gone. The hold was left
       * set, so TAP did nothing for ninety seconds and this phone would not
       * listen as a payer either, until the app was put in the background and
       * brought back. The code and the arming go with it, so the next TAP is
       * a fresh receiver. */
      this.tapTalking(false);
      this.setState({ tapShownCode: '', tapArmed: false, tapRecvStage: '' });
      // they said why before leaving: nothing to scan, and the person has been told
      if (this._payerGaveUp) { this._payerGaveUp = false; return; }
      if ((was || talking) && this.stageScreen && !this.stageUp('changeStuck')) {
        console.log('[foxy] tap: the payer left before anything arrived; offering to scan');
        this.stageScreen('youScan', {
          title: 'You need<br>to scan',
          body: 'Scan the QR code on the payer\u2019s screen.',
          button: 'SCAN',
          go: () => { if (this.scanTokenToReceive) this.scanTokenToReceive(); },
          alt: 'NOT NOW',
        });
      }
      return;
    }
    /* A payer has said it is near, or has gone again (the third door). The
     * invoice screen shows CONNECT TO PAY where the QR is; the handshake
     * starting, or the code arriving, takes it down. */
    /* Remembered, not only drawn: a payer may say it is near while this phone
     * is still on the amount screen, where there is no code to cover, and the
     * card has to be there when the invoice screen arrives (syncConnectRecv). */
    if (ev.side === 'receive' && ev.stage === 'nearby') {
      // not for a payer that has just said it paid: the mint is being asked
      if (this.tapPaidChecking && this.tapPaidChecking()) return;
      clearTimeout(this._nearGoneT);
      this._nearEdge = ev.edge === 'left' ? 'left' : 'right';
      this.syncConnectRecv();
      return;
    }
    /* Gone, but not at once: a payer that drops its quiet link and opens
     * another is "far" for about a second, and the card went with it. It
     * waits two and a half seconds for the payer to come back first. */
    if (ev.side === 'receive' && ev.stage === 'far') {
      clearTimeout(this._nearGoneT);
      this._nearGoneT = setTimeout(() => { this._nearEdge = ''; this.hideConnectRecv(); }, 2500);
      return;
    }
    if (ev.side === 'receive' && (ev.stage === 'connecting' || ev.stage === 'code' || ev.stage === 'gone')) this.hideConnectRecv();
    if (ev.side === 'receive' && (ev.stage === 'off' || ev.stage === 'denied')) {
      this.setState({ tapRecvStage: ev.stage });
      return;
    }
    /* A payer has been picked and is being connected to. The code is a second
     * or two behind it, and until this the invoice screen showed nothing at
     * all while somebody held their phone against it. */
    if (ev.side === 'receive' && ev.stage === 'connecting' && this._tapOffer) {
      if (this.state.tapRecvStage !== 'connecting') {
        this.haptic('tap');
        // and the knock the payer's phone is making, for as long as it makes it
        if (!this._tapPaying) this.tapBuzz(true, true);
      }
      /* No screen for it here. The receiver's was up for an instant — the
       * code follows the subscribe by a tenth of a second — and a screen that
       * flashes is worse than none. The knock says contact
       * was made, and the four digits are what there is to look at. */
      this.setState({ tapRecvStage: 'connecting' });
      return;
    }
    // that one came to nothing; back to waiting for a payer
    if (ev.side === 'receive' && ev.stage === 'searching') {
      if (this._buzzRecv) this.tapBuzz(false);
      /* `off` too: the radio was switched back on and the receiver went on
       * the air by itself, so the button comes back with it. */
      if (this.state.tapRecvStage === 'connecting' || this.state.tapRecvStage === 'off') this.setState({ tapRecvStage: '' });
      if (this.hideStage) this.hideStage('waitPayer');
      return;
    }
    if (ev.side === 'pay' && this._tapPaying) {
      /* Contact made is contact made: it does not go back to SEARCHING.
       *
       * The native side drops a connection it could not finish and scans
       * again, which is right — but it was showing every step of that as a
       * new state, so holding the phones together read as HOLD CLOSER,
       * CONNECTING, SEARCHING, HOLD CLOSER, and then the confirmation anyway. Nothing about that flicker is useful to the
       * person holding the phone: they are already doing the one thing there
       * is to do. So once this says connecting, it keeps saying connecting.
       *
       * Unlatched after a while, because a phone that never connects must
       * eventually be allowed to say so rather than pretending for ever. */
      /* Nor may a later SEARCHING paper over it: the radio being off is the
       * answer until the radio says otherwise. */
      const settled = ['off', 'denied', 'unsupported'];
      if (settled.indexOf(this.state.tapStage) >= 0 && ev.stage === 'searching') return;
      const held = this.state.tapStage === 'connecting' || this.state.tapStage === 'linked';
      const goingBack = ev.stage === 'searching' || ev.stage === 'far' || ev.stage === 'nearby';
      if (held && goingBack && Date.now() < (this._tapHeldUntil || 0)) return;
      /* A receiver is near — within -60 dBm — but not touching. The payer's
       * screen says TAP TO PAY, tall, from the top edge down to the balance
       * pill, so the person knows to put the phones together. Only while listening from home or SEND, and it comes down
       * the moment the link is made, the receiver fades, or the screen moves. */
      if (ev.stage === 'nearby') {
        if (this._tapPaying && !held) this.showTapNearby(ev.edge);
        return;
      }
      if (ev.stage === 'far' || ev.stage === 'searching') this.hideTapNearby();
      /* The phone it was connecting to went away (the doors went, or the
       * link died). CONNECTING TO INVOICE stayed up through the twelve-second
       * hold meant for far/searching flicker, and CANCEL was the only way
       * off it. */
      if (ev.stage === 'gone') {
        this._tapHeldUntil = 0;
        this.tapBuzz(false);
        this.hideConnecting();
        return;
      }
      if (ev.stage === 'connecting') {
        this.hideTapNearby();
        this._tapHeldUntil = Date.now() + 12000;
        /* Contact, felt rather than shown. The payer is on home or on SEND and
         * there is no tap screen to change; what says something happened is
         * the phone in the hand, and then the confirmation a moment later. */
        if (!this._tapPaying) return;
        this.tapBuzz(true);
        this.haptic('tap');
        /* And something to look at. The buzz was the whole of what the payer
         * got — no screen changes at this point, because the phone is on home
         * or on SEND — so the seconds between contact and the confirmation
         * were a phone that had vibrated and done nothing.
         * Cancelling here costs nothing: the link is a handshake and no ecash
         * has been touched. */
        /* CANCEL lets the link go, and stays gone. It only hid the screen and
         * went back: the link stayed up, the next `connecting` event put the
         * screen straight back, and the person pressed a button that did
         * nothing. The payer is stopped —
         * `tapPay` rejects, and `syncTap` listens again from home — and for
         * a few seconds this link's events draw nothing. */
        if (Date.now() < (this._tapCancelUntil || 0)) return;
        this.showConnecting(() => {
          console.log('[foxy] tap: CANCEL on connecting; letting that link go');
          this._tapCancelUntil = Date.now() + 8000;
          this.tapBuzz(false);
          const W0 = window.FoxyWallet;
          if (W0 && W0.tapPayStop) W0.tapPayStop();
          this.back();
        });
        /* Contact that comes to nothing is let go of quietly.
         *
         * There is no screen to be stranded on any more, so this no longer
         * navigates — it stops the knocking and leaves a note. The listen
         * itself carries on: the phone is still on home, and the next merchant
         * to press TAP should still be heard. */
        clearTimeout(this._tapStranded);
        this._tapStranded = setTimeout(() => {
          if (this._tapGot) return;
          console.warn('[foxy] tap: connected but nothing came of it');
          this.tapBuzz(false);
          this._tapHeldUntil = 0;
          this.hideConnecting();
        }, 15000);
      }
      if (goingBack) this.tapBuzz(false);   // 'linked' keeps knocking: the screen has not changed yet
      this.setState({ tapStage: ev.stage });
    }
  }

  /* A knock every second while the two phones are talking, until the payer is
   * looking at the confirmation.
   *
   * The person is holding one phone against another and can see neither screen
   * properly, so the phone in their hand is the only thing that can say "still
   * working, keep it there". One buzz at the start said it once and then left
   * them guessing; this keeps saying it, and stops the moment there is
   * something to look at.
   *
   * Straight to the bridge rather than through `haptic`, which allows one buzz
   * of a kind every 1.2 seconds — right for events, wrong for a heartbeat.
   * Capped, so a tap that never finishes does not knock for ever. */
  /* Both phones, and together. The receiver knocks the
   * same way for the same seconds — `recv` — and the knocks fall on the
   * second by the clock rather than a second after each phone happened to
   * start, so two phones whose clocks agree knock in step with nothing passed
   * between them. The first is felt at once, because contact should be. */
  tapBuzz(on, recv) {
    if (this._buzz) { clearInterval(this._buzz); this._buzz = null; }
    if (this._buzzStart) { clearTimeout(this._buzzStart); this._buzzStart = null; }
    this._buzzRecv = false;
    if (!on) return;
    this._buzzRecv = !!recv;
    const bridge = (window.webkit || {}).messageHandlers;
    const one = () => {
      if (bridge && bridge.foxy) { try { bridge.foxy.postMessage({ haptic: 'pulse' }); return; } catch (e) {} }
      if (navigator.vibrate) navigator.vibrate(100);
    };
    one();
    const until = Date.now() + 30000;
    const alive = () => Date.now() <= until && (recv ? this._buzzRecv : !!this._tapPaying);
    const beat = () => { if (!alive()) { this.tapBuzz(false); return; } one(); };
    // to the next whole second, or the one after where that is too soon to feel as a second knock
    let wait = 1000 - (Date.now() % 1000);
    if (wait < 350) wait += 1000;
    this._buzzStart = setTimeout(() => {
      this._buzzStart = null;
      beat();
      if (alive()) this._buzz = setInterval(beat, 1000);
    }, wait);
  }

  tapStartPay() {
    const W = window.FoxyWallet;
    const run = {};
    this._tapPaying = run;
    this._tapSearchAt = Date.now();
    /* SEARCHING is a guess, and it must not overwrite an answer.
     *
     * The native side reports a Bluetooth that is off or not allowed as soon
     * as its manager wakes, which can be before this optimistic setState
     * lands — and then the screen said SEARCHING for ever while the radio was
     * switched off, telling somebody to hold their phone nearer when the
     * problem was Bluetooth. A stage that says why nothing
     * can happen stays. */
    this.setState(p => ({
      tapStage: ['off', 'denied', 'unsupported'].indexOf(p.tapStage) >= 0 ? p.tapStage : 'searching',
      nfcLinked: false, tapLinkCode: '',
    }));
    // still started, so the radio coming back on is noticed and reported
    W.tapPay().then(got => {
      if (this._tapPaying !== run) return;
      this._tapPaying = null;
      this.hideTapNearby();
      const offer = this.tapOfferOf(got.payload);
      if (!offer) {
        this.toast('That phone sent something Foxy could not read.', true);
        this.back();
        this.tapGaveNothing('their offer could not be read');
        return;
      }
      /* Already paid, by this phone, a moment ago.
       *
       * A payment over Lightning crosses no link, so the receiver learns of
       * it from its mint and is still on its invoice screen, on the air,
       * for as long as that takes. The payer got home, heard it again and
       * was offered the same invoice a second time. Said, and not paid again;
       * the other phone is told once
       * more, since its screen is what has not caught up. */
      const paidAt = this.tapWasPaid ? this.tapWasPaid(offer) : 0;
      if (paidAt) {
        console.log('[foxy] tap: that offer was paid from this phone ' + Math.round((Date.now() - paidAt) / 1000) + 's ago; not paying it again');
        if (offer.inv) this.tapSayPaid(offer.inv);
        this.hideConnecting();
        // long enough for their mint to tell them, so this is not said every few seconds
        this._tapQuietUntil = Date.now() + 15000;
        // and the link is let go once the word has had time to cross it
        setTimeout(() => { if (!this._tapPaying && !this._tapGot && W.tapPayStop) W.tapPayStop(); }, 1500);
        this.blockedCard('alreadyPaid', {
          tone: 'ask',
          title: 'ALREADY PAID',
          reason: 'You paid this ' + this.tapAgoWords(paidAt) + '. Their phone has not shown it yet.',
          chip: 'Nothing was sent again.',
        });
        return;
      }
      this._tapOfferNow = offer;           // what a payment that follows is paying (tapMarkPaid)
      this._tapGot = true;                 // do not go looking again: the link is the payment's
      this._tapKeep = true;
      this._tapGotAt = Date.now();         // and when, so a tap that goes nowhere can be let go
      clearTimeout(this._tapStranded);
      this.haptic('success');
      /* CONNECTING TO INVOICE stays up until there is something to put in its
       * place. It was taken down here, a beat before the confirmation opened,
       * so what the payer saw between the two was the home screen — for most
       * of a second, in the middle of paying somebody. It
       * comes down below, once the next screen is on. */
      this.setState({ nfcLinked: true, tapLinkCode: got.code, tapStage: 'linked' });
      /* A beat, then the confirmation opens itself.
       *
       * There is no tap screen to be on any more: this phone was listening
       * from home or from SEND, and what it heard is a merchant who pressed
       * TAP while the two phones were touching. The beat is so the haptic
       * lands before the screen moves, not a wait for anything.
       *
       * It still refuses to barge in on a payment already going out — the
       * listen is not running then (`syncTap`), and this checks again because
       * the offer can arrive in the same tick the person starts one. */
      setTimeout(() => {
        /* `'in'`, not any phase.
         *
         * This is meant to stop a second payment opening itself over one
         * already going out. Written as a truthiness test it also caught
         * `'settled'`, which is what every *finished* send leaves behind — so
         * the tap after the first payment of a launch buzzed, connected, and
         * then silently returned here rather than opening the confirmation.
         * The receiver's side was working perfectly, which is why it looked
         * like a payer bug and was.
         *
         * Same mistake as the listening gate above, in the same afternoon. A
         * phase that has ended is not a payment in flight. */
        const now = this.state;
        if (now.sendPhase === 'in' || now.reqBusy) {
          /* This tap is over and nothing came of it, so the marks that stop the
           * next one have to come off here.
           *
           * They are released by going away from home and coming back, which is
           * how a finished payment announces itself. A tap abandoned right here
           * never goes anywhere: the phone stays on home with `_tapGot` set, and
           * `syncTap` will not listen again for the life of the app — which is
           * a payer that cannot tap until they visit SEND and come back. */
          this.hideConnecting();
          this.tapGaveNothing('a payment was already going out');
          return;
        }
        /* Down once the screen under it has changed: a render is a frame
         * away, and taking this off first is the flash of home again. */
        setTimeout(() => this.hideConnecting(), 140);
        this.setState({ tapInvoice: offer.inv || '', tapCode: got.code });
        /* Same mint: pay with ecash and never mention Lightning.
         *
         * Paying a Lightning invoice made by the mint this phone pays from
         * shows that mint both sides of the payment, and costs a routing fee
         * to go out and come back to itself. The request goes straight to the
         * receiver's onion instead. The card that used to ask which way — USE
         * CASHU or CONTINUE OVER LIGHTNING — is for a stranger's invoice that
         * happens to share a mint; two Foxys held together are not that, and
         * the person should not be asked a question with one right answer. */
        /* They asked in dollars, so nothing is paid until they agree the
         * price. This phone has a current one; theirs may be hours old. It
         * says what its price is and what that makes of the amount, and waits
         * for the request to come back in sats (M10, M11). The sats never
         * leave here until that answer arrives. */
        /* The amount first, then the mint.
         *
         * They asked in dollars, so nothing is paid until they agree the price.
         * The mint question is answered after that and not before: a routing
         * fee cannot be quoted for an amount neither side has agreed to. */
        /* Across two mints, both phones online — or nothing (`tapOfflineCross`).
         * Before the price, because there is no price to agree for a payment
         * that is not going to be made. */
        if (this.tapOfflineCross && this.tapOfflineCross(offer)) return;
        if (offer.asksUsd) { this.tapQuoteTheirDollars(offer); return; }
        this.tapPayOffer(offer);
      }, 900);
    }, e => {
      if (this._tapPaying !== run) return;
      this._tapPaying = null;
      this.hideTapNearby();
      console.warn('[foxy] tap: search ended:', e.message);
      /* And then start listening again, because nothing else will.
       *
       * `tapPayStart` is asked with a 30 minute budget and answers with an
       * error when it runs out, which is what a payer sitting on home through a
       * long background does. `syncTap` is the only thing that starts a listen
       * and it runs from componentDidUpdate — on a state change, never on a
       * clock — so after the budget expired the phone stopped hearing taps
       * until some unrelated update happened to come along. On one
       * phone one did, 16 seconds later, because the price poll ticked; on a
       * phone whose price sources are all timing out, there is no such
       * luck.
       *
       * The delay backs off when the search failed at once — Bluetooth off or
       * not allowed rejects immediately, and re-arming that every second would
       * be a hot loop — and resets as soon as one listen has run a while, so a
       * budget that expires after half an hour is always picked straight up. */
      const lasted = Date.now() - (this._tapSearchAt || 0);
      if (lasted >= 30000) this._tapReArm = 1000;
      else this._tapReArm = Math.min((this._tapReArm || 1000) * 2, 60000);
      clearTimeout(this._tapReArmTimer);
      this._tapReArmTimer = setTimeout(() => {
        this._tapReArmTimer = null;
        if (!this._tapPaying) this.syncTap();
      }, this._tapReArm);
    });
  }

  /* What the other phone offered, and whether ecash can pay it.
   *
   * `sameMint` is this wallet's own mint being named by their request — the
   * one case where a token can go straight there and Lightning is pure loss.
   * Anything else is paid by the invoice, exactly as before. */
  tapOfferOf(text) {
    const W = window.FoxyWallet;
    let o = null;
    try { o = JSON.parse(String(text || '')); } catch (e) { return null; }
    if (!o || o.v !== 2) return null;
    const inv = typeof o.inv === 'string' && W.classify(o.inv) === 'invoice' ? o.inv : '';
    const req = typeof o.req === 'string' ? o.req : '';
    if (!inv && !req) return null;
    let sameMint = false;
    let theirs = [];
    if (req && W.decodeRequest) {
      const r = W.decodeRequest(req);
      theirs = (r && r.mints) || [];
      const mine = String(W.mintUrl || '').replace(/\/+$/, '');
      sameMint = !!(mine && theirs.some(m => String(m).replace(/\/+$/, '') === mine));
    }
    /* A request naming dollars and no sats: theirs to name, ours to convert.
     *
     * Not tied to the mint. A receiver with no route asks in dollars whoever
     * they bank with, and the mint is a separate question answered after the
     * amount is — you cannot quote a routing fee for an amount nobody has
     * agreed yet. An offer with an invoice on it is not this: the invoice
     * carries its own sat figure and paying it is one payment, not two. */
    const req0 = (req && W.decodeRequest) ? W.decodeRequest(req) : null;
    const asksUsd = !!(!inv && W.asksInDollars && W.asksInDollars(req0));
    console.log('[foxy] tap: they offered ' + (inv ? 'an invoice' : 'no invoice')
      + (req ? ' and a request for ' + (theirs.join(' ') || '(no mint named)') : ' and no request')
      + '; mine is ' + (W.mintUrl || '?')
      + ' — paying by ' + (sameMint ? 'ecash'
          : this.offlineNow() ? 'neither: no route here, so their invoice is no use'
          : 'lightning'));
    /* A request at a mint this phone could move money to: one mint named, and
     * it is not this one. Nothing about whether it is worth doing — that is the
     * quote's answer, and the fee card's. */
    const crossable = !sameMint && theirs.length === 1 && !!String(theirs[0] || '').trim();
    /* Tri-state on purpose: true, false, and "they did not say". An older Foxy
     * says nothing, and nothing must not read as offline. */
    const theirRoute = typeof o.up === 'boolean' ? o.up : null;
    /* Their bitcoin price, if they had a current one. A phone with no route of
     * its own is trusting this figure, so it is carried through to the screens
     * rather than quietly used for arithmetic. */
    const theirRate = Number(o.rate) > 0 ? Math.round(Number(o.rate)) : 0;
    const theirRateAt = Number(o.at) > 0 ? Math.round(Number(o.at)) * 1000 : 0;
    return { inv: inv, req: req, sameMint: sameMint, asksUsd: asksUsd, read: req0,
             mints: theirs, crossable: crossable, theirRoute: theirRoute,
             // whether they answer a question before the payment (`askFirst`)
             asks: o.ask === 1,
             theirRate: theirRate, theirRateAt: theirRateAt };
  }

  /* Between two mints, both phones must be online.
   *
   * Two ways round it existed. A payer with no route asked the receiver to
   * come to the payer's mint, take the ecash there and melt it home; a payer
   * with a route moved its sats to an offline receiver's mint and paid in
   * ecash there. Each is half a dozen questions of two mints over Tor while
   * two people hold their phones together, and each leaves money somewhere
   * nobody chose when a mint is slow: in testing, four tries to make one
   * payment, seven minutes to bring it home, and a card asking to bring it
   * home again for the rest of the session.
   *
   * So a tap across two mints is paid over Lightning by two phones that can
   * both reach their mints, and is otherwise refused here, before a price is
   * discussed or a fee is asked for. Both phones say why, in the same words:
   * this one on a card, theirs from the word sent on M10 (`tapPriceOffered`).
   *
   * `OFFLINE_CROSS` is the switch. The code for both ways is still below it
   * and still tested; turning this on is all it takes to have them back.
   *
   * "They did not say" is not offline: an older Foxy sends no `up`, and is
   * paid as before. Answers whether the tap was ended. */
  OFFLINE_CROSS = false;

  tapOfflineCross(offer) {
    const W = window.FoxyWallet;
    if (this.OFFLINE_CROSS || !offer || offer.sameMint) return false;
    const strip = (u) => String(u || '').replace(/\/+$/, '');
    const mine = strip(W.mintUrl);
    const theirs = strip((offer.mints || [])[0]);
    // a different mint is something their request says; with no mint named there is nothing to compare
    if (!mine || !theirs) return false;
    const meOff = this.offlineNow();
    const themOff = offer.theirRoute === false;
    if (!meOff && !themOff) return false;
    const name = (u) => this.mintNameOf(u) || strip(u).replace(/^https?:\/\//, '') || 'another mint';
    console.log('[foxy] tap: ' + (meOff && themOff ? 'neither phone has a' : meOff ? 'this phone has no' : 'their phone has no')
      + ' connection and the mints differ (' + mine + ' here, ' + theirs + ' there); not paid');
    /* Said to them, with this phone's mint, so their card can name both. The
     * words ride `gaveUp`, which an older Foxy shows as it stands. */
    const said = W.tapQuote ? W.tapQuote(JSON.stringify({
      gaveUp: 'Your payer uses a different mint. Both of you must be online to transact between mints.',
      why: 'offline-cross', mint: mine,
    })) : Promise.resolve();
    // the link is kept while the words leave: resolving means queued, not delivered
    said.catch(() => {}).then(() => setTimeout(() => this.tapGaveNothing('offline, and a different mint'), 1500));
    // and not heard again at once: they are very likely still on the air
    this._tapQuietUntil = Date.now() + 15000;
    this.hideConnecting();
    const held = W.balanceAt && W.balanceAt(theirs) > 0;
    this.blockedCard('offlineCross', {
      tone: 'warn',
      title: 'OFFLINE & DIFFERENT MINT',
      reason: 'Your receiver uses a different mint.\nBoth of you must be online to transact between mints.',
      chip: 'You use ' + name(mine) + ' while they use ' + name(theirs) + '.',
      // money already at their mint is a same-mint payment, one switch away
      retry: held ? 'CHOOSE A MINT' : '',
      go: held ? () => this.goSwitchMint() : null,
    });
    return true;
  }

  /* The receiver's half (M10 in, M11 out).
   *
   * This phone asked in dollars because it has no route and its own price may
   * be hours old. The payer has said what its price is and what that makes in
   * sats; a person here agrees to that number or does not, and only an ACCEPT
   * sends a request back — this time naming the sats, so the payment that
   * follows is the payment that was agreed.
   *
   * A DENY is sent, not left as silence: the payer is holding a link open and
   * "no" is something it can act on where a timeout is only a wait.
   */
  tapPriceOffered(text) {
    const W = window.FoxyWallet;
    /* Two things arrive on M10 and they are told apart by what is in them: a
     * price, or a mint the payer cannot leave. The first is a receiver with no
     * route being offered a conversion; the second is a payer with no route
     * asking this phone — which has one — to bring the money home. */
    let body = null;
    try { body = JSON.parse(String(text || '')); } catch (e) {}
    /* A third thing, and the smallest: the payer has no route and is reading
     * this phone's price. Nothing to answer; only something to say. */
    /* And the payer saying it cannot pay, before it goes. Without this the
     * receiver saw the payer leave and offered to scan a code the payer had
     * never made. */
    if (body && typeof body === 'object' && typeof body.gaveUp === 'string') {
      console.log('[foxy] tap: the payer could not pay \u2014 ' + body.gaveUp);
      this._payerGaveUp = true;
      this.waitingForPayer(false);
      this.tapTalking(false);
      // two mints and one of the phones offline: the same card the payer shows (`tapOfflineCross`)
      if (body.why === 'offline-cross') { this.offlineCrossCard(body.mint); return; }
      this.blockedCard('payerGaveUp', {
        tone: 'warn',
        title: 'THE PAYER COULD NOT PAY',
        reason: body.gaveUp.slice(0, 240),
      });
      return;
    }
    if (body && typeof body === 'object' && typeof body.deciding === 'boolean') {
      console.log(body.deciding
        ? '[foxy] tap: the payer is offline and is being asked to agree the price'
        : '[foxy] tap: the payer has answered about the price');
      this.waitingForPayer(body.deciding);
      if (this.OFFLINE_CROSS && body.deciding && body.ahead && body.ahead.mint) this.tapCarryAhead(body.ahead);
      return;
    }
    // anything else is a question for this phone, and its own screen
    if (this.hideStage) this.hideStage('waitPayer');
    if (body && typeof body === 'object' && body.mint && !(Number(body.rate) > 0)) {
      /* A payer with no route, at another mint, asking to have its sats
       * carried home. Not done any more (`tapOfflineCross`): a payer on this
       * build never asks, and one on an older build is told no, with the
       * reason, and both phones show it. */
      if (!this.OFFLINE_CROSS) {
        console.log('[foxy] tap: a payer with no connection asked to be carried from ' + body.mint + '; told that both must be online');
        if (W.tapTerms) {
          W.tapTerms(JSON.stringify({ no: true, why: 'Both of you must be online to transact between mints.' })).catch(() => {});
        }
        this._payerGaveUp = true;
        this.tapTalking(false);
        this.offlineCrossCard(body.mint);
        return;
      }
      this.tapCarryHome(body);
      return;
    }
    const q = W.readQuote ? W.readQuote(text) : null;
    if (!q) {
      console.warn('[foxy] tap: a price arrived that could not be read');
      if (W.tapTerms) W.tapTerms(JSON.stringify({ no: true })).catch(() => {});
      return;
    }
    console.log('[foxy] tap: they offer ' + q.sats + ' sats at $'
      + this.group(Math.round(q.theirRate)) + ' per bitcoin'
      + (q.differsPct == null ? '; this phone has no price to compare'
         : '; ' + q.differsPct.toFixed(1) + '% from the one this phone last saw'));
    /* From here until the answer has gone, this phone is in a conversation and
     * nothing may be torn down under it — not the radio, not the screen, not
     * the inbox. Set before the person is asked and cleared only once the
     * answer is actually on the wire (`syncTap`). */
    this.tapTalking(true);
    this.priceTermsCard(q).then(yes => {
      if (!yes) {
        console.log('[foxy] tap: the price was not accepted');
        /* This phone ended it, so the payer leaving is not news: without
         * this, the payer's going put YOU NEED TO SCAN over the screen after
         * the person had just said no. */
        this._payerGaveUp = true;
        const no = W.tapTerms ? W.tapTerms(JSON.stringify({ no: true })) : Promise.resolve();
        /* A refusal IS the end, but the write still has to leave before the
         * radio goes: `tapTerms` resolving means queued, not delivered. A
         * couple of seconds is more than the link needs and far less than the
         * clock that would otherwise hold it. */
        no.catch(() => {}).then(() => setTimeout(() => this.tapTalking(false), 2000));
        return;
      }
      /* The sats request is made now, not earlier: it is the agreed number, and
       * making it before the person agreed would be this phone doing the
       * conversion it has spent this whole leg refusing to do. `railRequest`
       * keeps it, so the QR on screen and this are the same request.
       *
       * Waited for, not read once. It answers '' for an amount it has not made
       * a request for yet — and the agreed sats are always a new amount, since
       * this screen asked in dollars — so reading it once sent the payer a
       * refusal for every ACCEPT. */
      this.railRequestReady(q.sats).then(req => {
          if (!req) {
          console.warn('[foxy] tap: the agreed request could not be made');
          const no = W.tapTerms ? W.tapTerms(JSON.stringify({ no: true })) : Promise.resolve();
          no.catch(() => {}).then(() => setTimeout(() => this.tapTalking(false), 2000));
          this.toast('Foxy could not make the request for that amount.', true);
          return;
        }
        console.log('[foxy] tap: the price was accepted; sending the request for ' + q.sats + ' sats');
        /* The hold STAYS. Sending the terms is not the end of the conversation,
         * it is the middle: the payment this phone just agreed to is what comes
         * next, over this same link.
         *
         * Released on the send, it was released four milliseconds after
         * `sendTerms` returned — and that return means the write is QUEUED, not
         * delivered. `syncTap` then found the screen back on home, retired the
         * receiver, and took the un-sent write with it. The answer was never
         * transmitted, and the payer sat there until it gave up (the answer
         * was sent, the hold freed four milliseconds later, and the payer gave
         * up a few seconds after).
         *
         * So the release belongs at the end of the conversation — the payment
         * arriving (`requestPaidHere`), the tap ending, or the clock. */
        W.tapTerms(JSON.stringify({ req: req, sats: q.sats })).catch((e) => {
          this.tapTalking(false);
          this.toast(W.reason ? W.reason(e) : 'That phone is no longer connected.', true);
        });
      });
    });
  }

  /* The amount is settled; now, how it is paid.
   *
   * Everything that has to happen before this — the price talk with a receiver
   * that asked in dollars — has happened, so `sats` is a number both phones
   * agree on and `offer.req` is the request that names it. From here it is one
   * question: can this phone's ecash answer that request, and if not, what else
   * is there.
   *
   * One place, because the price leg reaches it as well as the plain tap, and
   * having each work out the mint for itself is how the two ended up
   * disagreeing about which payments were possible.
   */
  tapPayOffer(offer, sats) {
    const W = window.FoxyWallet;
    /* Their price, where this phone has no current one of its own.
     *
     * A phone with no route is trusting the other one's bitcoin price for
     * every dollar figure it shows — so it should be showing THAT price, said
     * to be theirs, rather than converting at its own hours-old one and saying
     * nothing. Kept on state, never written into `_rate`:
     * this is a number somebody else vouched for, and the moment this phone has
     * a route again its own is the one that counts. */
    if (offer && offer.theirRate > 0 && this.offlineNow()) {
      this.setState({ peerRate: offer.theirRate, peerRateAt: offer.theirRateAt || Date.now() });
      console.log('[foxy] tap: they are online and their bitcoin price is $'
        + this.group(offer.theirRate) + '; showing theirs while this phone has none');
      /* And it is agreed, not merely displayed.
       *
       * Whoever has no route is trusting the other one's bitcoin price, and
       * that is a thing to say yes to rather than something to notice on a
       * confirmation screen. It is the same question the offline RECEIVER is
       * asked, from the other side ("offline user will
       * always confirm BTC PRICE difference").
       *
       * Once per tap: `_pricedFor` is the offer this phone has already agreed
       * a price for, so coming back through here — the mint question, a
       * crossing — does not ask again. */
      const want = Math.round(Number(sats) || Number(offer.read && offer.read.sats) || 0);
      if (want > 0 && this._pricedFor !== offer.req) {
        this._pricedFor = offer.req;
        this.tapAgreeTheirPrice(offer, want);
        return;
      }
    }
    /* An invoice is no use to a phone with no route.
     *
     * Every branch below was gated on `!offer.inv` — written for a receiver
     * with no route, which cannot make one. It reads the wrong way round when
     * it is the PAYER that has no route: an online receiver at another mint
     * offers an invoice, all the gates fall through, and the offline payer is
     * walked to a Lightning send screen that can only fail. It did, all the way
     * to "send failed: Foxy is working offline" (an offline payer at one mint
     * paying a receiver at another).
     *
     * Lightning needs a route, so with no route there is no invoice to speak
     * of. Dropped here, once, rather than tested for at four separate gates. */
    const offline = this.offlineNow();
    const inv = offline ? '' : offer.inv;
    /* Same mint: pay with ecash and never mention Lightning.
     *
     * Paying a Lightning invoice made by the mint this phone pays from shows
     * that mint both sides of the payment, and costs a routing fee to go out
     * and come back to itself. The request goes straight to the receiver
     * instead. The card that used to ask which way — USE CASHU or CONTINUE
     * OVER LIGHTNING — is for a stranger's invoice that happens to share a
     * mint; two Foxys held together are not that, and the person should not be
     * asked a question with one right answer. */
    if (offer.sameMint) { this.openRequest(offer.req, { viaTap: true, theirRoute: offer.theirRoute, asks: offer.asks }); return; }
    /* Their mint is not this phone's, and this phone has a route.
     *
     * Ecash is only ever worth what its own mint will honour, so a request at
     * another mint cannot be answered out of this pile — but the money can be
     * moved there, which is the transfer Foxy already does, and then the
     * request is an ordinary one. It costs a Lightning fee, so it is asked
     * about before anything moves.
     *
     * An offer with an invoice on it still goes the Lightning way below: that
     * is one payment where this is two, and the receiver made the invoice
     * precisely so a stranger could pay it. This is for the offer with no
     * invoice at all — a receiver with no route, which cannot make one — where
     * the choice is a transfer or nothing. */
    /* No invoice, and they say they have a route: it is on its way.
     *
     * "No invoice" was read as "a receiver with no route", which is who the
     * crossing below is for. A receiver that is online has asked its mint for
     * one and has not been answered yet. Paying that invoice is one Lightning
     * payment; the crossing is a move and then a swap at their mint. So it is
     * waited for, five seconds, and the crossing is what happens if it does
     * not come. Only with a route here: a payer without one cannot pay an
     * invoice at all, and goes on to ask them to carry it home. */
    if (!inv && offer.crossable && !offline && offer.theirRoute === true && !offer.invWaited) {
      this.tapAwaitInvoice(offer, sats);
      return;
    }
    if (!inv && offer.crossable && !offline) {
      this.tapCrossMint(offer, sats);
      return;
    }
    /* Their mint is not this phone's, and this phone has no route.
     *
     * Nothing can be moved from here: no melt, no transfer, not even a swap.
     * But they are the ones with a route — that is why they have an amount in
     * sats and an open link — so they can bring the money home themselves and
     * say what it costs. This phone says where it is stuck and what it holds
     * there; they answer with a request at *this* mint for the amount plus
     * their costs, which the person here agrees to or does not.
     *
     * The fees are the payer's, as they are everywhere on this path: the
     * receiver named an amount and gets that amount. */
    /* Not gated on their invoice either: whether they made one says nothing
     * about whether this phone can pay it, and this phone cannot. */
    const stuck = W.stuckAtMint ? W.stuckAtMint(offer.read) : null;
    if (offer.crossable && stuck) { this.tapStuckAtMint(offer, stuck, sats); return; }
    if (!inv) { this.tapWrongMint(offer); return; }
    if (!this.acceptTarget(inv)) return;
  }

  /* The offline payer agreeing the price it is about to pay at.
   *
   * The receiver asked in sats, because it has a route and its own price. This
   * phone has neither, so every dollar figure it is about to show comes from
   * the figure THEY sent — and the person should agree to that, not discover it. The same screen the offline receiver sees, asked from
   * the other side, so there is one place that question is put.
   *
   * The link is held across it like any other decision (`tapTalking`): the
   * payer is the one deciding here, but the receiver is still holding a link
   * open waiting for a payment.
   */
  tapAgreeTheirPrice(offer, sats) {
    const W = window.FoxyWallet;
    const mine = (W.lastPrice && W.lastPrice()) || { rate: null, ageMs: 0 };
    const theirs = Math.round(Number(offer.theirRate) || 0);
    const q = {
      sats: sats,
      usd: Math.round((sats / 1e8) * theirs * 100),
      theirRate: theirs,
      myRate: mine.rate || 0,
      myRateAgeMs: mine.rate ? mine.ageMs : 0,
      differsPct: mine.rate ? ((theirs - mine.rate) / mine.rate) * 100 : null,
      // which side of the payment this phone is on, for the screen's words
      side: 'pay',
    };
    console.log('[foxy] tap: their bitcoin price is $ ' + this.group(theirs)
      + (q.differsPct == null ? '; this phone has none to compare'
         : '; ' + q.differsPct.toFixed(1) + '% from the one this phone last saw'));
    this.tapTalking(true);
    /* And the receiver is told, so its screen can say who it is waiting on and
     * why. It rides M10, which is the one message a payer sends before the
     * money: a body with `deciding` and no price and no mint is this. */
    // the same price is agreed without asking, so there is no wait to announce
    const asked = !(q.differsPct != null && Math.abs(q.differsPct) < 0.1);
    /* And where this phone is stuck at another mint, that goes with it: the
     * fee for carrying the money home is theirs to work out, and it depends on
     * nothing the person here is deciding, so it is started now rather than
     * after their answer. */
    const stuckNow = (offer.crossable && W.stuckAtMint) ? W.stuckAtMint(offer.read) : null;
    const ahead = stuckNow ? { mint: stuckNow.mint, have: stuckNow.have, sats: sats } : null;
    if (asked && W.tapQuote) {
      W.tapQuote(JSON.stringify(ahead ? { deciding: true, ahead: ahead } : { deciding: true })).catch(() => {});
    }
    this.priceTermsCard(q).then(yes => {
      // and told when it is over, so their screen goes back to the invoice and its code
      if (asked && W.tapQuote) W.tapQuote(JSON.stringify({ deciding: false })).catch(() => {});
      if (!yes) {
        console.log('[foxy] tap: their price was not agreed; nothing was sent');
        /* Said to them, or their phone reads this leaving as a payment lost
         * in flight and puts YOU NEED TO SCAN up. And the link is kept up
         * while the words leave: the conversation flag stays set for a moment,
         * as the receiver's own refusal does, because `tapQuote` resolving
         * means queued, not delivered — the first cut let go at once and the
         * receiver never heard it. */
        const said = W.tapQuote ? W.tapQuote(JSON.stringify({ gaveUp: 'The payer did not agree the price.' })) : Promise.resolve();
        said.catch(() => {}).then(() => setTimeout(() => {
          this.tapTalking(false);
          this.tapGaveNothing('their price was not agreed');
        }, 1500));
        return;
      }
      this.tapTalking(false);
      /* On to the mint question, which is where this came from. `_pricedFor`
       * stops it looping back here. */
      this.tapPayOffer(offer, sats);
    });
  }

  /* Wait for an online receiver's invoice, then go on with or without it. */
  tapAwaitInvoice(offer, sats) {
    const W = window.FoxyWallet;
    let done = false;
    let t = null;
    const close = () => {
      clearTimeout(t);
      if (W.onTapTerms) W.onTapTerms(null);
      this.dismissCard('invWait');
      if (this.hideStage) this.hideStage('invWait');
    };
    const finish = (inv) => {
      if (done) return;
      done = true;
      close();
      console.log(inv ? '[foxy] tap: their invoice came after the offer; paying it over Lightning'
        : '[foxy] tap: no invoice in five seconds; moving the sats to their mint instead');
      this.tapPayOffer(Object.assign({}, offer, { invWaited: true }, inv ? { inv: inv } : {}), sats);
    };
    if (W.onTapTerms) {
      W.onTapTerms(text => {
        let said = null;
        try { said = JSON.parse(String(text || '')); } catch (e) { said = null; }
        if (said && typeof said.inv === 'string' && /^ln(bc|tb|bcrt)[0-9a-z]+$/i.test(said.inv)) finish(said.inv);
      });
    }
    console.log('[foxy] tap: they are online at another mint and their invoice is not in yet; waiting up to 5s for it');
    t = setTimeout(() => finish(''), 5000);
    this.waitingScreen('invWait', {
      art: 'mints', title: 'Getting<br>their invoice', dots: true, forMs: 6000,
      body: 'The receiver uses another mint. Waiting a moment for their Lightning invoice.',
      button: 'CANCEL',
      go: () => { if (done) return; done = true; close(); this.tapGaveNothing('cancelled'); this.back(); },
    });
  }

  /* Ask the two mints what a crossing costs, while somebody is still deciding.
   *
   * The answer to "same mint?" is known the moment the offer arrives, and the
   * fee for crossing depends only on the amount this phone has just offered —
   * neither waits on whether the person agrees the price. Asking now means the
   * screen after their YES is ready instead of starting a two-mint round trip.
   *
   * Kept as a promise rather than a plan, so the screen can wait on it if the
   * person answers faster than two mints do. A failure is kept too: it is the
   * same failure the screen would have shown, and re-asking would only make
   * them wait for it twice.
   */
  tapPreQuoteMint(offer, sats) {
    const W = window.FoxyWallet;
    this._crossReady = null;
    const want = Math.round(Number(sats) || 0);
    const theirs = String((offer && offer.mints || [])[0] || '').replace(/\/+$/, '');
    const mine = String(W.mintUrl || '').replace(/\/+$/, '');
    if (!want || !theirs || !mine || theirs === mine) return;      // nothing to cross
    if (offer.inv && !this.offlineNow()) return;                   // Lightning pays it
    if (this.offlineNow()) return;                                 // their side quotes this one
    if (!W.transferQuote) return;
    console.log('[foxy] tap: asking what crossing to ' + theirs + ' costs, while they decide');
    this._crossReady = {
      sats: want, to: theirs, from: mine,
      plan: W.transferQuote(mine, want, { to: theirs, land: true }),
    };
    // a rejection here is an answer the screen will use; it must not go unhandled
    this._crossReady.plan.catch(() => {});
  }

  /* Paying somebody at another mint, from the phone that has the route.
   *
   * Ecash is only ever worth what its own mint will honour, so proofs from this
   * phone's mint are no use to a receiver at another one. What is possible is
   * moving the money there first — the transfer Foxy already does: melt here,
   * pay the destination's mint quote, claim the ecash at the far end — and then
   * the request is an ordinary same-mint request and the payment is the
   * payment it always was.
   *
   * It is a real Lightning payment, so it costs a real routing fee, and the fee
   * is asked about before anything moves. At the moment the card is up nothing
   * has been melted and nothing has been sent: cancelling costs the person
   * nothing but the seconds spent quoting.
   *
   * The order is quote, ask, move, pay. Anything else either spends money on a
   * question nobody answered or asks a question with no number in it.
   *
   * `sats` is passed when the amount came from the price leg; a request that
   * names its own sat figure is read from the request.
   */
  tapCrossMint(offer, sats) {
    const W = window.FoxyWallet;
    const theirs = String((offer.mints || [])[0] || '').replace(/\/+$/, '');
    const mine = String(W.mintUrl || '').replace(/\/+$/, '');
    const want = Math.round(Number(sats) || Number(offer.read && offer.read.sats) || 0);
    if (!theirs || !mine || !(want > 0)) {
      console.log('[foxy] tap: no crossing \u2014 ' + (!theirs ? 'they named no mint' : !mine
        ? 'this phone has no mint connected' : 'no amount'));
      this.tapWrongMint(offer);
      return;
    }
    /* A mint this phone has never used is named in full and connected to
     * deliberately, exactly as a scanned request at a strange mint is
     * (makeTokenForRequest). Moving money to an attacker's mint destroys it
     * just as surely as making a token there. */
    /* No card first. The crossing's own confirmation names THEIR MINT and
     * moves nothing until PAY is pressed, and that is the deliberate act; a
     * warning card before CALCULATING FEE was a second screen saying the same
     * thing. */
    /* Money actually in flight stops this. An invoice being watched does not.
     *
     * `refuseSwitchWhileBusy` counts a watched invoice as busy, and rightly for
     * a mint switch the PERSON asked for: the live watch claims at whichever
     * mint is connected, so switching under it would claim at the wrong one.
     * But refusing the payment is the wrong way out — the person tapped to pay
     * somebody and got "Wait for the payment to finish before switching mints",
     * about an invoice of their own that has nothing to do with it.
     *
     * So the watch is stopped instead. Nothing is lost by that: the quote is
     * written down with the mint that issued it, and `sweepQuotes` claims it at
     * that mint on the next connect — which is exactly what it exists for. */
    /* Housekeeping is waited for, not refused for.
     *
     * The proof lock is also held by Foxy's own tidying — breaking a large
     * piece into small change, a claim catching up — which takes a second or
     * two and is nobody's payment. A crossing that arrived in that second was
     * turned away with "wait for the payment in progress", about a payment
     * that did not exist, and the receiver sat on its four digits until the
     * person gave up (held by tidyChange for 2s). The lock is a queue; this
     * joins it.
     *
     * A send of this phone's own, or change being chased, still refuses:
     * those are payments, and two at once is what the rule is for. */
    if (!this._sendRun && !this._chasingChange && this.moneyMoving() && !this._crossWaited) {
      const began = Date.now();
      console.log('[foxy] tap: the crossing waits for ' + (this.busyWhy ? this.busyWhy() : 'the wallet'));
      const look = () => {
        if (!this.moneyMoving()) {
          console.log('[foxy] tap: the wallet is free after ' + (Date.now() - began) + 'ms; crossing now');
          this._crossWaited = true;
          try { this.tapCrossMint(offer, want); } finally { this._crossWaited = false; }
          return;
        }
        if (Date.now() - began > 15000) {
          this._crossWaited = true;
          try { this.tapCrossMint(offer, want); } finally { this._crossWaited = false; }
          return;
        }
        setTimeout(look, 200);
      };
      setTimeout(look, 200);
      return;
    }
    if (this.moneyMoving()) {
      /* Said in the diary too. The payer's phone showed a toast and went home,
       * the receiver's sat on its four digits, and neither log had a word
       * about why nothing followed the handshake. */
      console.log('[foxy] tap: the crossing was refused, money is already moving ('
        + (this.busyWhy ? this.busyWhy() : '?') + ')');
      this.toast('Wait for the payment in progress to finish, then tap again.', true);
      this.back();
      return;
    }
    if (this._watching) {
      console.log('[foxy] tap: stopping the invoice watch for the crossing; the sweep will claim it');
      this.stopReceive();
    }
    this._crossMintOk = null;
    /* Sats of this phone's own already at their mint pay it, and nothing is
     * moved.
     *
     * A crossing is a Lightning payment and then the payment itself. When
     * the first is made and the second is not — their mint slow to hand the
     * sats over, a swap that never left — the sats are this phone's, at
     * their mint. Tapping again quoted and made a second move, paid a second
     * routing fee, and left the first lot sitting at a mint the person does
     * not use (tools/live/offline-cross-scenarios.js `move-twice`,
     * `move-fail`). A move that is paid and not yet collected is
     * collected first, and then what is there is what pays. */
    const settle = (W.pendingMoves && W.pendingMoves().length && W.finishMove)
      ? W.finishMove().then(() => null, () => null) : Promise.resolve(null);
    settle.then(() => {
      const there = W.balanceAt ? W.balanceAt(theirs) : 0;
      // enough on its face; whether it covers that mint's fee too is asked once there (`sendShortfall`)
      if (there >= want && W.sendShortfall) { this.tapPayFromThere(offer, want, theirs, mine, there); return; }
      this.tapCrossQuote(offer, want, theirs, mine);
    });
    return;
  }

  /* Paid out of what this phone already holds at their mint. The same
   * confirmation the crossing shows, with no fee on it; a visit, and home
   * again whichever way it ends (`crossComeHome`). */
  tapPayFromThere(offer, want, theirs, mine, there) {
    const W = window.FoxyWallet;
    console.log('[foxy] tap: ' + there + ' sats of this phone\u2019s are already at ' + theirs + '; paying from there, with no move');
    this.crossMintCard({ net: want, feeSats: 0 }, theirs, mine).then(yes => {
      if (!yes) { console.log('[foxy] tap: paying from ' + theirs + ' was not accepted'); return null; }
      return W.connect(theirs, null, null, { remember: false }).then(() => {
        const sf = W.sendShortfall(want, { locked: true });
        if (sf && sf.short) {
          // not enough there once its fee is counted: home, and the ordinary crossing
          console.log('[foxy] tap: what is at their mint does not cover it with the fee; moving the rest instead');
          return W.connect(mine).then(() => { this.setState({ crossBusy: false, crossQ: null }); this.back(); this.tapCrossQuote(offer, want, theirs, mine); });
        }
        this._crossMovedTo = null;
        this._crossCameFrom = mine;
        this.refreshBalance();
        const read = W.decodeRequest(offer.req);
        if (!read) throw new Error('Their request could not be read.');
        read.viaTap = true;
        if (typeof offer.theirRoute === 'boolean') read.theirRoute = offer.theirRoute;
        if (offer.asks) read.asks = true;
        this.setState({ req: read, reqBusy: false, crossBusy: false,
                        crossQ: null, note: '', noteDraft: '' });
        this.makeTokenForRequest();
        return null;
      });
    }).catch(e => this.crossFailed(e, mine));
  }

  /* Quote the move, ask, move, pay. */
  tapCrossQuote(offer, want, theirs, mine) {
    const W = window.FoxyWallet;
    /* The one asked for while they were deciding, if it is the same crossing.
     *
     * `tapPreQuoteMint` starts this the moment the price goes out, so by the
     * time somebody has agreed it the answer is usually already here and this
     * screen opens at once instead of after a two-mint round trip. Matched on
     * all three of amount, source and destination: anything else is a different
     * question and gets asked fresh. */
    const ready = this._crossReady;
    this._crossReady = null;
    const ahead = !!(ready && ready.sats === want && ready.to === theirs && ready.from === mine);
    if (ahead) console.log('[foxy] tap: the crossing was already quoted while they decided');
    /* No overlay: the screen itself opens now, on what is already known, and
     * the fee fills in when the two mints answer. An overlay over a screen
     * nobody can see yet is a wait with nothing in it. */
    const quoting = ahead ? ready.plan : W.transferQuote(mine, want, { to: theirs, land: true });
    quoting.catch(() => {});
    // CALCULATING FEE is `crossMintCard`'s to show, until the quote is in
    this.crossMintCard(quoting, theirs, mine).then(yes => {
      if (!yes) {
        console.log('[foxy] tap: the fee to reach ' + theirs + ' was not accepted');
        return;
      }
      return quoting.then(plan => this.crossRun(plan, offer, theirs, mine));
    }).catch(e => this.crossFailed(e, mine));
    return;
  }

  /* The crossing itself, once the fee has been agreed: melt there, claim
   * there, then pay from there. One press did all of it, which is the point —
   * the screen they agreed on IS this payment's confirmation. */
  /* A crossing's own two entries are not payments to announce.
   *
   * Moving sats between mints writes a melt at one and a claim at the other,
   * and the history pass announced the claim as money received: PAYMENT
   * RECEIVED over a card saying they had refused it, for sats this phone had
   * moved itself, and a second
   * confirmation after a payment carried home. Marked seen by the
   * ids the plan already holds, before the move writes them. */
  hushMove(plan) {
    this._seenTx = this._seenTx || {};
    ['mintQuote', 'meltQuote'].forEach(k => {
      const id = plan && plan[k] && plan[k].quote;
      if (id) this._seenTx[id] = true;
    });
  }

  crossRun(plan, offer, theirs, mine) {
    const W = window.FoxyWallet;
    /* Asked before the move, not after it. A move is a Lightning payment
     * and its fee; made for a request that is closed, or that the receiver
     * cannot take, it left the sats at a mint the person does not use. The
     * payment asks again when it is made; this is the one that saves the fee. */
    if (offer.asks && W.askFirst && !this._crossAsked) {
      const read0 = W.decodeRequest(offer.req);
      if (read0) {
        this._crossAsked = true;
        // their request names an amount and their mint; the payment will be locked when they have no route
        return W.askFirst(read0, { mint: theirs, locked: true }).then((a) => {
          if (!a || a.go !== true) {
            this._crossAsked = false;
            const eNo = /** @type {any} */ (new Error((a && a.why) || 'They cannot take this payment. Nothing was sent.'));
            eNo.foxyAskedNo = true;
            throw eNo;
          }
          return this.crossRun(plan, offer, theirs, mine);
        }).then((r) => { this._crossAsked = false; return r; }, (e) => { this._crossAsked = false; throw e; });
      }
    }
    this.hushMove(plan);
    this.showMelt('Moving your sats to ' + (this.mintNameOf(theirs) || 'their mint') + '\u2026',
                  0, { sats: plan.net, mint: this.mintNameOf(theirs) });
    /* On the mint the money leaves, which is where the melt has to run from —
     * the same step the transfer screen takes for the same reason. `moveRun`
     * connects to the destination itself once the invoice is paid, and leaves
     * this phone there, which is where the payment is made from anyway. */
    /* Quiet while it moves, and its entries marked seen before anything reads
     * history again. `hushMove` names the quotes the plan holds, and the move
     * makes its own at the moment it runs — so the melt was announced as
     * WITHDRAWAL SENT in the middle of a payment. The sweep's own way of
     * doing this, which goes by what is new in history rather than by a
     * name. */
    this._quiet = true;
    W.transactions(50).then(list => { this._sweepBefore = new Set(list.map(x => x.hash)); })
      .catch(() => { this._sweepBefore = null; });
    const loud = () => { this._quiet = false; };
    /* A visit: their mint is where this payment is made from, not where this
     * phone banks, and it is not saved as the phone's own. */
    return W.connect(mine).then(() => W.moveRun(plan, () => {}, { visit: true })).then((done) => {
      const quiet = this.hushSweepEntries ? this.hushSweepEntries() : Promise.resolve();
      return quiet.then(() => done, () => done);
    }).then(() => {
      loud();
      this.hideMelt();
      this.refreshBalance();
      console.log('[foxy] tap: the sats are at ' + theirs + '; paying their request now');
      /* From here the money is at their mint whatever happens next, and that is
       * worth knowing about: a failure now leaves the balance at a mint the
       * person was not on when they tapped (`theyRefused`'s chip). */
      this._crossMovedTo = theirs;
      /* And the mint to come home to once the payment is made: the crossing is
       * Foxy's business, the mint the person banks at is theirs. */
      this._crossCameFrom = mine;
      /* Paid straight from here, with no second confirmation: the screen they
       * agreed on is this payment's confirmation. */
      const read = W.decodeRequest(offer.req);
      if (!read) throw new Error('Their request could not be read.');
      read.viaTap = true;
      if (typeof offer.theirRoute === 'boolean') read.theirRoute = offer.theirRoute;
        if (offer.asks) read.asks = true;
      this.setState({ req: read, reqBusy: false, crossBusy: false,
                      crossQ: null, note: '', noteDraft: '' });
      this.makeTokenForRequest();
    });
  }

  /* Whatever went wrong, the wallet goes back to the mint it was on: a failed
   * quote never left it, and a failed move may have. */
  crossFailed(e, mine) {
    const W = window.FoxyWallet;
    this._quiet = false;
    this.hideMelt();
    if (W.mintUrl !== mine) W.connect(mine).then(() => this.refreshBalance(), () => {});
    const why = W.reason ? W.reason(e) : String((e && e.message) || e);
    console.warn('[foxy] tap: could not pay across mints:', why);
    this.setState({ crossBusy: false, crossQ: null });
    /* What is true of the money, which is not always "nothing was sent".
     *
     * A move is a Lightning payment and then a claim. With the payment made
     * and the claim refused or unreachable, this card said nothing had been
     * sent and the sats were where they were — while 507 of them had left
     * the mint for a 500-sat payment nobody received
     * (tools/live/offline-cross-scenarios.js `move-cut`). The move's own
     * error says which it was. */
    const theirs = this.mintNameOf(e && e.moveTo) || 'their mint';
    if (e && e.foxyAskedNo) {
      this.blockedCard('crossMint', {
        tone: 'warn',
        title: 'THEY CANNOT TAKE IT',
        reason: why,
        chip: 'Nothing was sent, and nothing was moved.',
      });
    } else if (e && e.movePaid) {
      this.blockedCard('crossMint', {
        tone: 'warn',
        title: 'YOUR SATS ARE ON THEIR WAY',
        reason: 'The sats left your mint for ' + theirs + ', and ' + theirs + ' has not handed them over yet. '
          + 'Foxy collects them by itself. They have not been paid.',
        chip: this.group(Math.round(Number(e.moveSats) || 0)) + ' sats will be yours at ' + theirs
          + '. Tap again once they are there.',
      });
    } else if (e && e.pending) {
      this.blockedCard('crossMint', {
        tone: 'warn',
        title: 'THE MOVE MAY STILL GO THROUGH',
        reason: 'Your mint has not said whether the payment to ' + theirs + ' went. Foxy is holding the sats until it says either way. '
          + 'They have not been paid.',
        chip: 'Nothing is lost. Wait for it to settle before paying again.',
      });
    } else {
      this.blockedCard('crossMint', {
        tone: 'warn',
        title: 'COULD NOT REACH THEIR MINT',
        reason: why,
        chip: 'Nothing was sent, and your sats are where they were.',
      });
    }
    this.back();
  }


  /* Whether a decision is being put to a person with a payer holding the link.
   *
   * While it is true, nothing that watches the screen may tear anything down:
   * not the Bluetooth radio, not the screen-awake lock, not the onion address
   * (`syncTap`, `syncAwake`, `syncInbox`). It is deliberately NOT a screen
   * test — the answer is sent after the screen has already gone back to home,
   * so any screen test loses the race.
   *
   * A clock ends it whatever happens, because a flag that holds the radio open
   * for ever is its own bug. Ninety-five seconds is the payer's own patience,
   * so by then there is nobody left to answer.
   */
  tapTalking(on) {
    clearTimeout(this._tapTalkT);
    if (!on) {
      if (!this._tapTalking) return;
      this._tapTalking = false;
      console.log('[foxy] tap: the answer has gone; the link is free again');
      this.syncTap();
      return;
    }
    this._tapTalking = true;
    /* And the payer is told to wait, because otherwise it will not.
     *
     * A payer gives up on the result after 25 seconds, which is right for a
     * swap over a cold circuit. It is wrong for everything this hold covers: a
     * person reading two bitcoin prices, and a carry-home quote that is allowed
     * 25 seconds of its own before it even fails. M9 moves the payer's clock to
     * 90, and until now only the offline-risk card sent one — so the price
     * screens and the carry-home ran the payer's patience out from under
     * themselves, and the payer sat on "waiting on their answer" until it gave
     * up.
     *
     * Harmless on a phone that is not the receiver: with no link to push it
     * down, the native side answers false and nothing happens. */
    const W = window.FoxyWallet;
    if (W && W.tapAsking) {
      W.tapAsking().catch(() => {});
    }
    this._tapTalkT = setTimeout(() => {
      if (!this._tapTalking) return;
      console.warn('[foxy] tap: nobody answered in time; letting the link go');
      this._tapTalking = false;
      if (this.hideStage) this.hideStage('waitPayer');
      this.syncTap();
    }, 95000);
  }


  /* The receiver's side of `tapOfflineCross`: the same card, from where
   * this phone stands. `theirMint` is the payer's, as the payer said it. */
  offlineCrossCard(theirMint) {
    const W = window.FoxyWallet;
    const strip = (u) => String(u || '').replace(/\/+$/, '');
    const name = (u) => this.mintNameOf(u) || strip(u).replace(/^https?:\/\//, '') || 'another mint';
    const theirs = strip(theirMint);
    this.blockedCard('offlineCross', {
      tone: 'warn',
      title: 'OFFLINE & DIFFERENT MINT',
      reason: 'Your payer uses a different mint.\nBoth of you must be online to transact between mints.',
      chip: 'You use ' + name(W.mintUrl) + ' while they use ' + (theirs ? name(theirs) : 'another mint') + '.',
    });
  }


  /* The receiver's half: they are stuck at another mint and this phone is not.
   *
   * They have no route, so the sats cannot leave their mint by their own hand.
   * This phone has one, so it can: take their ecash where it is, swap it in at
   * their mint — the moment there is no risk left in any of this — and then
   * melt it home. Every cost of doing that is quoted back to them and paid by
   * them, because the amount asked for is the amount that lands here.
   *
   * The request goes out naming *their* mint, so what they send is ecash they
   * already hold; this phone connects there to receive it, and goes home
   * afterwards. Nothing is claimed as paid until the swap at their mint has
   * come back, which is what makes "no risk" true rather than hopeful.
   */
  /* The fee for that, asked about early: the payer has said which mint it is
   * stuck at while its owner is still reading the price. A quote only — nothing
   * is connected to and nothing moves — kept for `tapCarryHome` to pick up. A
   * failure is dropped, and the real ask is made afresh. */
  tapCarryAhead(ahead) {
    const W = window.FoxyWallet;
    const want = Math.round(Number(ahead && ahead.sats) || 0)
      || Math.round(Number(this.wantedSats && this.wantedSats()) || 0);
    const from = String((ahead && ahead.mint) || '').replace(/\/+$/, '');
    if (!(want > 0) || !from || !W.crossTerms || this.offlineNow()) return;
    // asked already and still good (the link dropped and they are back): not asked of two mints again
    const live = this._carryAsk, had = this._carryAhead;
    if (live && live.from === from && live.want === want && Date.now() - live.at < 180000) return;
    if (had && had.from === from && had.want === want && Date.now() - had.at < 60000) return;
    console.log('[foxy] tap: working out the fee from ' + from + ' while they read the price');
    const held = { from: from, want: want, at: Date.now(),
                   terms: W.crossTerms({ mint: from, have: Number(ahead.have) || 0, sats: want }, want) };
    held.terms.catch(() => { if (this._carryAhead === held) this._carryAhead = null; });
    this._carryAhead = held;
  }

  tapCarryHome(said) {
    const W = window.FoxyWallet;
    const want = Math.round(Number(said && said.sats) || 0)
      || Math.round(Number(this.wantedSats && this.wantedSats()) || 0);
    const no = (why) => {
      console.warn('[foxy] tap: cannot carry it home:', why);
      const sent = W.tapTerms
        ? W.tapTerms(JSON.stringify({ no: true, why: why })) : Promise.resolve();
      sent.catch(() => {}).then(() => this.tapTalking(false));
    };
    if (!(want > 0)) { no('Foxy could not tell how much this is for.'); return; }
    if (this.offlineNow()) { no('This phone has no connection either, so nothing here can move it.'); return; }
    const mintSaid = String((said && said.mint) || '').replace(/\/+$/, '');
    /* One asking for one payment.
     *
     * The link can drop while the fee is being worked out, and the payer
     * touches again and asks the same thing. Each asking wrote a job down
     * and went to their mint, so one payment had two jobs: it was written
     * on the first, the walk home was started on the second, and the second
     * — with nothing paid to it — was left asking to be brought home for
     * good (IT COSTS MORE TO BRING HOME, ten times,
     * for a payment that had landed). Asked again for the same mint and
     * amount, the asking already under way answers: its terms go out on
     * whichever link is up when they are ready, and again if they have
     * already gone. Before the busy check, because the first asking is
     * itself what makes this phone busy. */
    const live = this._carryAsk;
    if (live && live.from === mintSaid && live.want === want && Date.now() - live.at < 180000) {
      console.log('[foxy] tap: this was asked a moment ago; '
        + (live.sent ? 'the same terms go out again' : 'its answer is still being worked out'));
      this.tapTalking(true);
      if (live.sent && W.tapTerms) W.tapTerms(live.sent).catch(() => {}).then(() => this.tapTalking(false));
      return;
    }
    /* `moneyMoving`, not `moneyBusy`: this runs on the receive screen, and
     * that screen is always watching for a payment. Asking the wider
     * question refused every carry-home for being the thing it was
     * (09-melt-paste-switch.js). */
    if (this.moneyMoving()) { no('This phone is busy moving money. Try again in a moment.'); return; }
    const home = String(W.mintUrl || '').replace(/\/+$/, '');
    const ask = { from: mintSaid, want: want, at: Date.now(), sent: '' };
    this._carryAsk = ask;
    // asked for something else since: that asking has the link, and this one says nothing more
    const SUPERSEDED = {};
    const mine = () => { if (this._carryAsk !== ask) throw SUPERSEDED; };
    let visit = null;
    this.tapTalking(true);
    // the quote started while they were deciding, where it is this one and fresh
    const early = this._carryAhead;
    this._carryAhead = null;
    const useEarly = !!(early && early.from === mintSaid && early.want === want
                        && Date.now() - early.at < 60000);
    if (useEarly) console.log('[foxy] tap: the fee was already being worked out');
    (useEarly ? early.terms.catch(() => W.crossTerms(said, want)) : W.crossTerms(said, want)).then(terms => {
      mine();
      /* The request is made at their mint, which means being on it: the payment
       * that answers it is ecash that mint issued, and it is checked against
       * whichever mint this wallet is on when it lands. Home again as soon as
       * the money is. */
      visit = { back: home, terms: terms, id: '' };
      this._carryHome = visit;
      /* Written down first, and the visit not saved as this phone's mint
       * (`carryBegin`): an app killed over there used to open on the payer's
       * mint, with the payment sitting at it and nothing to say it was to
       * come home. */
      const going = W.carryBegin ? W.carryBegin(terms).then(id => { visit.id = id; })
                                 : W.connect(terms.from);
      return going.then(() => {
        mine();
        // waited for, for the reason the price leg above gives
        return this.railRequestReady(terms.ask, 'carry:' + terms.from);
      }).then(req => {
        mine();
        if (!req) throw new Error('Foxy could not make a request at their mint.');
        console.log('[foxy] tap: asking ' + terms.ask + ' at ' + terms.from
                    + ' so ' + terms.net + ' lands at ' + home);
        /* And a clock on it, because being on somebody else's mint is not a
         * state to sit in.
         *
         * The terms go out and the person on the other phone decides. If they
         * say no, or put the phone in a pocket, nothing comes back at all —
         * there is no message for "I thought about it and stopped" — and this
         * phone would wait on their mint for ever, showing their mint's
         * balance, offering their mint's request to the next person who tapped.
         * Ninety seconds is the payer's own patience (`tapStuckAtMint`), so
         * this outlives it and then goes home. */
        clearTimeout(this._carryHomeT);
        this._carryHomeT = setTimeout(() => {
          if (this._carryHome !== visit) return;   // the payment arrived, or another asking has it; not this
          const gone = this._carryHome;
          this._carryHome = null;
          if (this._carryAsk === ask) this._carryAsk = null;
          console.log('[foxy] tap: nothing came of the cross-mint offer; going home to ' + home);
          if (W.carryEnd && gone.id) W.carryEnd(gone.id).then(() => this.refreshBalance(), () => {});
          else if (W.mintUrl !== home && home) W.connect(home).then(() => this.refreshBalance(), () => {});
        }, 120000);
        // kept, to be said again to a payer who lost the link and came back (above)
        ask.sent = JSON.stringify({ req: req, sats: terms.ask,
                                    net: terms.net, fee: terms.feeSats,
                                    at: terms.from });
        return W.tapTerms(ask.sent)
          .then((r) => { this.tapTalking(false); return r; });
      });
    }).catch(e => {
      const stale = e === SUPERSEDED || this._carryAsk !== ask;
      if (stale) {
        // its job goes, and the phone stays where the newer asking has taken it
        if (W.carryEnd && visit && visit.id) W.carryEnd(visit.id, true).catch(() => {});
        if (this._carryHome === visit) this._carryHome = null;
        return;
      }
      const why = W.reason ? W.reason(e) : String((e && e.message) || e);
      /* Back where this phone belongs, whatever went wrong: a quote that failed
       * never left it and a connect that half-worked may have. */
      const failed = visit;
      if (W.carryEnd && failed && failed.id) W.carryEnd(failed.id).then(() => this.refreshBalance(), () => {});
      else if (W.mintUrl !== home && home) W.connect(home).then(() => this.refreshBalance(), () => {});
      this._carryHome = null;
      this._carryAsk = null;
      clearTimeout(this._carryHomeT);
      no(why);
      this.toast(why, true);
    });
  }


  /* The payment they sent at their mint is in. Bring it home.
   *
   * Called once the swap has come back — the money is this phone's, at their
   * mint, and nothing about the rest of this can lose it. The melt home is
   * ordinary work from here, and a failure leaves the sats sitting at their
   * mint where the transfer screen can move them by hand.
   */
  carryHomeNow() {
    const W = window.FoxyWallet;
    const job = this._carryHome;
    this._carryHome = null;
    this._carryAsk = null;
    clearTimeout(this._carryHomeT);
    if (!job || !job.terms) return Promise.resolve();
    const home = job.back;
    console.log('[foxy] tap: their ecash is in; melting it home to ' + home);
    /* Not received until it is home.
     *
     * Their ecash has been swapped in at their mint, which is what makes it
     * this phone's and lets the payer be answered. It is not yet money at a
     * mint this person chose to trust, and until it is, showing PAYMENT
     * RECEIVED is calling something final that is not.
     * So the screen says it is being brought home, the entries this makes on
     * the way are kept quiet, and the confirmation is raised once — for what
     * landed, where it landed.
     *
     * If it cannot be brought home the card below says so: paid, and still at
     * their mint. */
    const from = String(W.mintUrl || '').replace(/\/+$/, '');
    const heldThere = (W.balanceAt && from) ? W.balanceAt(from) : 0;
    const paid = Math.round(Number(job.terms.ask) || Number(job.terms.sats) || 0);
    this._quiet = true;
    /* Off the air while it is brought home. The screen underneath is still
     * the invoice, so it armed itself again the moment the payer's link
     * closed and advertised the same request for the eighteen seconds the
     * move took: the payer, sent and dismissed, saw CONNECT TO PAY on its
     * home screen for a payment it had just made. */
    this._carryingHome = true;
    if (this.syncTap) this.syncTap();
    this._hushUntil = Date.now() + 120000;
    W.transactions(50).then(list => { this._sweepBefore = new Set(list.map(x => x.hash)); })
      .catch(() => { this._sweepBefore = null; });
    this.showMelt('Bringing the payment to your mint\u2026', 0,
                  { sats: Math.round(Number(job.terms.net) || 0), mint: this.mintNameOf(home) });
    this.hushMove(job.terms.plan);
    const settle = () => {
      this.hideMelt();
      this._quiet = false;
      this._carryingHome = false;
      this._hushUntil = Date.now() + 20000;
      if (this.syncTap) this.syncTap();
    };
    /* The wallet does the walk and says what became of it (`carryHome`): it
     * landed, it is on its way, it has to wait, it would cost more than was
     * paid for, or it went back to the payer. The phone is at its own mint
     * when the answer comes, whichever it is. */
    const walk = (W.carryHome && job.id)
      ? W.carryHome(job.id, job.terms.plan, () => {})
      : W.moveRun(job.terms.plan, () => {}).then(done => ({ state: 'home', sats: done && done.sats, done: done }),
          e => ({ state: 'stuck', why: W.reason ? W.reason(e) : String((e && e.message) || e) }));
    return walk.then((r) => {
      const quiet = (r && r.state === 'home' && this.hushSweepEntries) ? this.hushSweepEntries() : Promise.resolve();
      return quiet.then(() => r, () => r);
    }).then((r) => {
      settle();
      this.carryOutcome(r, { home: home, heldThere: heldThere, paid: paid, net: job.terms.net });
    }).catch(e => {
      settle();
      console.warn('[foxy] tap: bringing the payment home:', (e && e.message) || e);
      this.loadHistory();
    });
  }

  /* What became of a payment being brought home, said once.
   *
   * From the walk itself, and from the wallet when it is the one that found
   * out — a launch that finished one, a claim made late (`W.onCarry`). It is
   * received when it is at this phone's own mint and at no moment before:
   * until then it is money at a mint this person did not choose, and every
   * card here says which of those it is. */
  carryOutcome(r, ctx) {
    const W = window.FoxyWallet;
    const c = ctx || {};
    const job = (r && r.job) || {};
    const home = String(c.home || job.home || W.mintUrl || '').replace(/\/+$/, '');
    const homeName = this.mintNameOf(home) || 'your mint';
    const theirName = this.mintNameOf(job.from) || 'their mint';
    const state = String((r && r.state) || '');
    this.refreshBalance();
    this.loadHistory();
    // somebody else is already on it (the wallet, on a launch): it says what became of it
    if (state === 'busy' || state === 'none') return;
    if (state === 'home') {
      const landed = Math.round(Number(r.sats) || Number(c.net) || Number(job.net) || 0);
      console.log('[foxy] tap: the payment is home, ' + landed + ' sats at ' + home);
      // its own entry at home is the crossing's, and is not a second payment
      this._seenTx = this._seenTx || {};
      if (r.quote) this._seenTx[r.quote] = true;
      this.dismissCard('carryHome');
      this.noteReceived();
      this.announcePayment({ dir: 'in', sats: landed, force: true, to: 'ecash',
                             hash: 'carry-' + Date.now() });
      /* What THIS payment left at their mint, and nothing else. `leftBehind`
       * is everything held there, so a phone with a balance of its own at
       * that mint was told after every payment that thousands of sats had been
       * left behind by carrying home a dollar. What it held there before the
       * payment is taken off. */
      const done = r.done || {};
      const whole = Math.round(Number(done.leftBehind) || 0);
      const mine = Math.max(0, (Number(c.heldThere) || 0) - (Number(c.paid) || 0));
      const left = Math.max(0, whole - mine);
      const at = String(done.from || '').replace(/\/+$/, '');
      if (left > 0 && at && c.paid) this.saySatsLeftAt(left, at);
      return;
    }
    if (state === 'moving' || state === 'waiting') {
      console.log('[foxy] tap: the payment is on its way to ' + home + ' (' + state + ')');
      this.blockedCard('carryHome', {
        tone: 'ask',
        title: 'ON ITS WAY TO YOUR MINT',
        reason: state === 'moving'
          ? 'The payment has left ' + theirName + ' for ' + homeName + ', and ' + homeName
            + ' has not handed it over yet. Foxy collects it by itself.'
          : 'The payment is leaving ' + theirName + ' for ' + homeName + ', and their mint has not said it is done. '
            + 'Foxy is holding it until the mint says either way.',
        chip: 'It is not received until it is at ' + homeName + '. Nothing is lost.',
      });
      return;
    }
    if (state === 'short') {
      const lands = Math.round(Number(r.lands) || 0);
      const net = Math.round(Number(r.net) || Number(job.net) || 0);
      console.log('[foxy] tap: bringing it home would now land ' + lands + ' of ' + net + '; asking');
      this.blockedCard('carryHome', {
        tone: 'ask',
        title: 'IT COSTS MORE TO BRING HOME',
        reason: 'The payment is at ' + theirName + '. Bringing it to ' + homeName + ' now costs more than the payer paid for: '
          + this.group(lands) + ' sats would arrive, not ' + this.group(net) + '.',
        chip: 'It is not received until it is at ' + homeName + '.',
        retry: 'BRING ' + this.group(lands) + ' HOME',
        go: () => {
          this.showMelt('Bringing the payment to your mint\u2026', 0, { sats: lands, mint: homeName });
          W.carryHome(job.id, null, () => {}, { less: true }).then(x => { this.hideMelt(); this.carryOutcome(x, { home: home }); });
        },
        shut: { label: 'SEND IT BACK', tap: () => {
          this.showMelt('Sending the payment back\u2026');
          W.carryRefund(job.id).then(x => { this.hideMelt(); this.carryOutcome(x, { home: home }); });
        } },
      });
      return;
    }
    if (state === 'refunded') {
      console.log('[foxy] tap: the payment could not be brought home and went back to the payer'
        + (r.handed ? ' over the link' : ', as a code'));
      // not handed: the wallet has raised the code for the payer to scan (`changeStuckCard`)
      if (r.handed) {
        this.blockedCard('carryHome', {
          tone: 'warn',
          title: 'NOT RECEIVED',
          reason: 'The payment could not be brought to ' + homeName + ', so it was sent back to the payer. ' + String(r.why || ''),
          chip: 'They have it back. Nothing was received.',
        });
      }
      return;
    }
    if (state === 'retry') {
      console.warn('[foxy] tap: the payment is still at their mint, to be brought home later:', r.why);
      this.blockedCard('carryHome', {
        tone: 'warn',
        title: 'NOT HOME YET',
        reason: 'The payment is at ' + theirName + ' and has not reached ' + homeName + ' yet. ' + String(r.why || '')
          + ' Foxy tries again when it can reach both mints.',
        chip: 'It is not received until it is at ' + homeName + '.',
        retry: 'TRY AGAIN',
        go: () => {
          this.showMelt('Bringing the payment to your mint\u2026', 0, { sats: Math.round(Number(job.net) || 0), mint: homeName });
          W.carryHome(job.id, null, () => {}).then(x => { this.hideMelt(); this.carryOutcome(x, { home: home }); });
        },
        shut: job.payerKey ? { label: 'SEND IT BACK', tap: () => {
          this.showMelt('Sending the payment back\u2026');
          W.carryRefund(job.id).then(x => { this.hideMelt(); this.carryOutcome(x, { home: home }); });
        } } : { label: 'CLOSE' },
      });
      return;
    }
    if (state === 'stuck') {
      console.warn('[foxy] tap: the payment is at their mint and could not be sent back:', r.why);
      this.blockedCard('carryHome', {
        tone: 'warn',
        title: 'PAID, STILL AT THEIR MINT',
        reason: 'The payment is yours, at ' + theirName + '. It could not be brought to ' + homeName
          + ' and could not be sent back. ' + String(r.why || ''),
        chip: 'Move it whenever you like, from the mint screen.',
        retry: 'MOVE IT', go: () => this.goSwitchMint(),
        shut: { label: 'LEAVE IT' },
      });
    }
  }


  /* Money of this phone's own, at somebody else's mint.
   *
   * Carrying a payment home melts it out of the payer's mint, and a melt
   * reserves more than the route spends. What is left is this phone's, at a
   * mint its owner does not use, and the only way they would have known is the
   * diary. It is not a warning — nothing is wrong and nothing is at risk — so
   * it says the figure, names the mint, and offers the screen that moves it.
   */
  saySatsLeftAt(sats, mint) {
    const name = this.mintNameOf(mint) || String(mint).replace(/^https?:\/\//, '');
    console.log('[foxy] ' + sats + ' sats of yours are still at ' + mint);
    this.blockedCard('leftBehind', {
      tone: 'ask',
      title: 'SATS LEFT AT ' + name.toUpperCase(),
      reason: this.group(sats) + ' sats of yours are at ' + name + ', which is their mint, not '
        + (this.mintNameOf(window.FoxyWallet && window.FoxyWallet.mintUrl) || 'yours') + '. '
        + 'Bringing the payment home left it there, and it is yours to move whenever you like.',
      chip: 'Nothing is at risk. It spends at ' + name + ', or moves to your mint over Lightning.',
      retry: 'MOVE IT', go: () => this.goSwitchMint(),
      shut: { label: 'LEAVE IT' },
    });
  }


  /* The payer's half of the other cross-mint talk (M10 out, M11 back).
   *
   * This phone has no route and its sats are at a mint they do not use. It says
   * so — which mint, and how much is there — and waits for them to answer with
   * a request at this mint for the amount plus what bringing it home will cost
   * them. Nothing has left and nothing will until the person here agrees to
   * that figure.
   *
   * It is the same two messages the price talk uses, in the same directions and
   * for the same reason: a number one phone can work out, offered to the other
   * to agree to, with the money still where it was.
   */
  tapStuckAtMint(offer, stuck, sats) {
    const W = window.FoxyWallet;
    const want = Math.round(Number(sats) || Number(offer.read && offer.read.sats) || 0);
    const said = Object.assign({ id: String((offer.read && offer.read.id) || ''), sats: want }, stuck);
    const seq = (this._tapQuoteSeq = (this._tapQuoteSeq || 0) + 1);
    const done = (over) => {
      if (this._tapQuoteSeq !== seq) return false;
      this._tapQuoteSeq = 0;
      clearTimeout(this._tapQuoteT);
      if (W.onTapTerms) W.onTapTerms(null);
      this.dismissCard('priceSent');
      if (this.hideStage) this.hideStage('priceSent');
      // a talk that ended with no payment leaves nothing to protect
      if (over) { this._crossReady = null; this.tapGaveNothing(over); }
      return true;
    };
    if (W.onTapTerms) {
      W.onTapTerms(text => {
        let terms = null;
        try { terms = JSON.parse(String(text || '')); } catch (e) {}
        /* Their invoice, arriving late on this same message: not an answer.
         * A phone with no route has no use for it either way, and reading it
         * as "no" ended the talk the receiver was still working on. */
        if (terms && typeof terms.inv === 'string' && !terms.req && !terms.no && !terms.why) {
          console.log('[foxy] tap: their invoice came in while they work out the cost; still waiting for the answer');
          return;
        }
        if (!done()) return;
        if (!terms || !terms.req || !(Number(terms.sats) > 0)) {
          this.toast(terms && terms.why ? String(terms.why)
            : 'They could not take a payment from your mint. Nothing was sent.', true);
          this.back();
          this.tapGaveNothing('they could not take it');
          return;
        }
        /* The request is read BEFORE the figure is shown, and has to be for
         * that figure, at this phone's own mint.
         *
         * The fee screen showed what the other phone said (`terms.sats`) and
         * PAY then paid what its request asked for, which nothing compared:
         * a card for 1,028 sats sent 5,000, and that screen is the only
         * confirmation this payment has (tests/offline-hostile.js). A request
         * for any other amount, or at any other mint,
         * is not the offer on the screen, and is not paid. */
        const read = W.decodeRequest(String(terms.req));
        const shownSats = Math.round(Number(terms.sats) || 0);
        const reqSats = read ? Math.round(Number(read.sats) || 0) : 0;
        const reqMint = String(((read && read.mints) || [])[0] || '').replace(/\/+$/, '');
        const myMint = String(W.mintUrl || '').replace(/\/+$/, '');
        if (!read || reqSats !== shownSats || (reqMint && reqMint !== myMint)) {
          console.warn('[foxy] tap: their terms and their request do not agree ('
            + (read ? 'the request is for ' + reqSats + ' sats' + (reqMint && reqMint !== myMint ? ' at ' + reqMint : '') : 'the request could not be read')
            + ', the terms say ' + shownSats + '); nothing was sent');
          this.toast(!read ? 'Their request could not be read. Nothing was sent.'
            : 'Their request does not match the amount they quoted. Nothing was sent.', true);
          this.back();
          this.tapGaveNothing('their terms and their request did not agree');
          return;
        }
        this.crossFeeCard(terms, stuck, (offer.mints || [])[0]).then(yes => {
          if (!yes) return;            // `crossAnswer` has already left the screen
          console.log('[foxy] tap: paying ' + terms.sats + ' at ' + stuck.mint
                      + '; they carry it home and keep ' + (terms.net || want));
          /* Paid from here, with no second confirmation: the screen they just
           * agreed to IS this payment's confirmation. */
          read.viaTap = true;
          if (typeof offer.theirRoute === 'boolean') read.theirRoute = offer.theirRoute;
        if (offer.asks) read.asks = true;
          /* If they cannot bring it home, it comes back: the whole payment,
           * locked to this phone, over the link if it is still up. Noted so
           * that is taken as what it is and not refused as change nobody
           * owed (15-paid-wake-keyboard.js). */
          this._carriedPay = { sats: Math.round(Number(terms.sats) || 0), hash: '', until: Date.now() + 300000 };
          this.setState({ req: read, reqBusy: false, crossBusy: false, crossQ: null,
                          note: '', noteDraft: '' });
          this.makeTokenForRequest();
        });
      });
    }
    /* CALCULATING FEE, because that is what is happening: the fee is being
     * worked out, by their phone rather than this one, and which phone does
     * the arithmetic is not something the person paying needs to hold in
     * their head. */
    this.waitingScreen('priceSent', {
      art: 'mints', title: 'Calculating<br>fee', dots: true,
      body: 'The receiver uses another mint, wait while I calculate the fee to pay them.',
      button: 'CANCEL', go: () => { if (done('cancelled')) this.back(); },
    });
    console.log('[foxy] tap: stuck at ' + stuck.mint + ' with ' + stuck.have
                + ' sats and no route; asking them what bringing it home costs');
    this._tapQuoteT = setTimeout(() => {
      if (!done('they never answered')) return;
      this.toast('They did not answer. Nothing was sent.', true);
      this.back();
    }, 90000);
    W.tapQuote(JSON.stringify(said)).catch(e => {
      if (!done('the link went before this phone could ask')) return;
      this.toast(W.reason ? W.reason(e) : 'That phone is no longer connected.', true);
      this.back();
    });
  }

  /* They can only take ecash, and not at the mint this phone pays from.
   *
   * With a route on their side this never happens: there is an invoice, and the
   * invoice is what gets paid. It is the offline receive that lands here, where
   * the mint is the whole of the deal — the payment is proofs that mint issued,
   * handed over, and a mint that did not issue them will not take them.
   *
   * It said "a mint you hold nothing at", which is often untrue: `sameMint` is
   * only about the mint this wallet is *on*, and money sitting at their mint
   * under another tab is money that could pay this. Naming the mints, and
   * saying which of the two situations it is, is the difference between a wall
   * and an instruction.
   *
   * A card rather than a toast: two seconds is not long enough to read a mint
   * host, and nothing else on the screen says what went wrong.
   */
  tapWrongMint(offer) {
    const W = window.FoxyWallet;
    const theirs = (offer && offer.mints || []).map(m => String(m).replace(/\/+$/, ''));
    const name = (u) => this.mintNameOf(u) || String(u).replace(/^https?:\/\//, '') || 'their mint';
    const held = theirs.filter(m => W.balanceAt && W.balanceAt(m) > 0);
    const mine = this.mintNameOf(W.mintUrl) || String(W.mintUrl || '').replace(/^https?:\/\//, '');
    const asked = theirs.length ? name(theirs[0]) : 'their mint';
    this.tapGaveNothing('their mint is not one this phone can pay');
    this.blockedCard('wrongMint', {
      tone: 'warn',
      title: 'A DIFFERENT MINT',
      reason: held.length
        ? 'They can only be paid ecash from ' + asked + ', and Foxy is paying from '
          + (mine || 'another mint') + '. You do hold money at ' + name(held[0])
          + ' \u2014 switch to it and tap again.'
        : 'They can only be paid ecash from ' + asked + ', and you hold nothing there. '
          + 'Foxy is paying from ' + (mine || 'another mint') + '.',
      chip: held.length
        ? 'Nothing was sent.'
        : 'Nothing was sent. With a connection, Foxy could pay them over Lightning instead.',
      retry: held.length ? 'CHOOSE A MINT' : '',
      go: held.length ? () => this.goSwitchMint() : null,
    });
    console.log('[foxy] tap: they can only take ecash at ' + (theirs.join(' ') || '(no mint named)')
      + '; this phone pays from ' + (W.mintUrl || '?')
      + (held.length ? ' \u2014 but there is a balance at theirs' : ''));
    this.back();
  }

  /* The payer's half of the price talk (M10 out, M11 back).
   *
   * Nothing has left this phone and nothing will until they answer: the sats
   * are still here, the link is open, and what crosses is two numbers. A
   * refusal, a silence or a phone put away all end the same way — back where
   * the person was, with their money untouched.
   *
   * `personWait` on the link is 95 seconds. This is a little under it, so the
   * words on screen come from Foxy rather than from a link that went quiet. */
  tapQuoteTheirDollars(offer) {
    const W = window.FoxyWallet;
    const quote = W.quoteFor ? W.quoteFor(offer.read) : null;
    if (!quote) {
      /* No price, nothing honest to offer. Their request names no sats, so
       * this phone cannot pay it either — saying so beats a spinner. */
      this.tapGaveNothing('no bitcoin price to quote with');
      this.blockedCard('noPriceToQuote', {
        tone: 'warn',
        title: 'NO BITCOIN PRICE',
        reason: 'They asked for a dollar amount, and this phone has no bitcoin price to work out the sats from.',
        chip: 'Nothing was sent. Try again once Foxy has a price.',
      });
      this.back();
      return;
    }
    /* The mint question is worked out WHILE they are deciding.
     *
     * It used to wait for the answer, so agreeing a price was followed by
     * several more seconds of nothing while this phone asked two mints what a
     * crossing would cost. Those two questions do not depend on the answer at
     * all — the amount is the one this phone just offered, and the mints are
     * whatever they already are. So they are asked now, and the moment the
     * answer comes back the next screen is ready ("don't
     * wait for BTC price agreement to determine the mint").
     *
     * Nothing moves on it: a quote is two questions and a fee, and a refusal
     * throws it away unused. */
    this.tapPreQuoteMint(offer, quote.sats);
    const seq = (this._tapQuoteSeq = (this._tapQuoteSeq || 0) + 1);
    const done = (over) => {
      if (this._tapQuoteSeq !== seq) return false;
      this._tapQuoteSeq = 0;
      clearTimeout(this._tapQuoteT);
      if (W.onTapTerms) W.onTapTerms(null);
      this.dismissCard('priceSent');
      if (this.hideStage) this.hideStage('priceSent');
      // a talk that ended with no payment leaves nothing to protect
      if (over) this.tapGaveNothing(over);
      return true;
    };
    if (W.onTapTerms) {
      W.onTapTerms(text => {
        let said = null;
        try { said = JSON.parse(String(text || '')); } catch (e) {}
        // their invoice, arriving late on this same message: not their answer about the price
        if (said && typeof said.inv === 'string' && !said.req && !said.no && !said.why) {
          console.log('[foxy] tap: their invoice came in while they read the price; still waiting for the answer');
          return;
        }
        if (!done()) return;
        this.setState({ tapQuoteWait: false });
        if (!said || !said.req) {
          this.toast('They did not agree that price. Nothing was sent.', true);
          this.back();
          this.tapGaveNothing('they did not agree the price');
          return;
        }
        /* And it has to be for the sats this phone offered. The answer is
         * the other phone's word, and the crossing's fee screen shows the
         * figure it states: a request for more than was offered is not an
         * agreement to the offer, it is a different request. */
        const back = W.decodeRequest ? W.decodeRequest(String(said.req)) : null;
        const backSats = back ? Math.round(Number(back.sats) || 0) : 0;
        if (!back || backSats !== Math.round(Number(quote.sats) || 0)) {
          console.warn('[foxy] tap: they answered the price with a request for ' + backSats + ' sats, not the '
            + quote.sats + ' this phone offered; nothing was sent');
          this.toast('Their request does not match the amount this phone offered. Nothing was sent.', true);
          this.back();
          this.tapGaveNothing('their request was not for what was offered');
          return;
        }
        console.log('[foxy] tap: they agreed the price; the request is in sats now');
        /* The agreed request, on the offer it came from: the mints have not
         * changed — a receiver makes its request at its own mint either way —
         * so whether this is a same-mint payment or a transfer first is the
         * same question it was, now with a number in it. */
        this.tapPayOffer(Object.assign({}, offer, { req: String(said.req) }), backSats);
      });
    }
    /* Something on screen while they read.
     *
     * The wait is a person on the other phone looking at two numbers, which is
     * seconds at best, and a payer's phone with nothing on it reads as a broken
     * app — the same argument M9 exists for. CANCEL is real: nothing has left
     * this phone, so there is nothing to undo. */
    this.waitingScreen('priceSent', {
      art: 'phone', title: 'Waiting<br>for receiver', dots: true,
      body: 'This receiver is offline and must agree to the current Bitcoin price before continuing.',
      button: 'CANCEL', go: () => { if (done('cancelled')) this.back(); },
    });
    this.setState({ tapQuoteWait: true, tapQuoteSats: quote.sats, tapQuoteUsd: quote.usd });
    console.log('[foxy] tap: quoting ' + quote.sats + ' sats for $'
      + (quote.usd / 100).toFixed(2) + ' at $ ' + this.group(Math.round(quote.rate)) + ' per bitcoin');
    this._tapQuoteT = setTimeout(() => {
      if (!done('they never answered')) return;
      this.setState({ tapQuoteWait: false });
      this.toast('They did not answer about the price. Nothing was sent.', true);
      this.back();
    }, 90000);
    W.tapQuote(JSON.stringify(quote)).catch(e => {
      if (!done('the link went before the price could be sent')) return;
      this.setState({ tapQuoteWait: false });
      this.toast(W.reason ? W.reason(e) : 'That phone is no longer connected.', true);
      this.back();
    });
  }

  tapStatusText() {
    const s = this.state;
    switch (s.tapStage) {
      case 'far': return 'HOLD CLOSER';
      case 'nearby': return 'CONNECT TO PAY';
      /* Contact made is "connected" as far as the person holding the phone is
       * concerned: the two seconds between touching and having the offer are
       * Foxy's business, not theirs, and a CONNECTING that becomes CONNECTED is
       * two states where one will do. The code joins the
       * same word when it arrives, so nothing moves but the digits. */
      case 'connecting':
      case 'linked':
        /* One word, and only that word. The digits used to follow it here and
         * are on the confirmation a moment later, where they are big and next
         * to the amount — two places to read the same four numbers, one of
         * them while the phone is still being held against another phone. */
        return 'CONNECTED';
      case 'off': return 'TURN ON BLUETOOTH';
      case 'denied': return 'BLUETOOTH NOT ALLOWED';
      case 'unsupported': return 'NO BLUETOOTH';
      default: return 'SEARCHING';
    }
  }

  tapStatusHint() {
    switch (this.state.tapStage) {
      case 'off': return 'Turn Bluetooth on in Control Center.';
      case 'denied': return 'Allow Bluetooth for Foxy in Settings.';
      case 'unsupported': return 'This phone cannot do tap to pay.';
      case 'nearby': return 'A phone is close. Touch it to pay.';
      case 'connecting': return 'Hold still.';
      case 'linked': return 'Check the same code is on their screen.';
      default: return 'Hold your phone near theirs while their invoice is open.';
    }
  }
