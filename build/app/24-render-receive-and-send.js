
  /* confirm: the receive screen — the invoice, its QR, what it asks for. */
  /** @param {RenderContext} c */
  renderReceive(c) {
    const { s, sc, val, landed, invSats, sats } = c;
    const usd = invSats ? (invSats / 1e8) * this.px()
      : (s.unit === 'SATS' ? landed / 1e8 * this.px() : landed);
    const cashu = s.recvRail === 'CASHU';
    const onchain = s.recvRail === 'ON-CHAIN';
    // the same screen test as renderVals: no request unless this screen is up
    const creq = () => (sc === 'confirm'
      ? this.railRequest(s.invoiceIsAddress ? 0 : window.FoxyWallet.amountOf(s.invoice)) : '');
    /* On chain the code is an address, with the amount only as a hint: it can
     * be paid with anything, and under the mint's floor it is lost. */
    const ocSats = () => (s.invoiceIsAddress ? 0 : (window.FoxyWallet.amountOf(s.invoice) || 0));
    const ocCode = () => {
      if (sc !== 'confirm' || !onchain) return '';
      const address = this.ocReceiveAddress();
      return address ? window.FoxyWallet.bip21(address, ocSats()) : '';
    };
    const recvReady = () => !!(s.recvVia === 'wire' || s.network === 'BANK WIRE'
      || (onchain ? ocCode() : cashu ? creq() : s.invoice));
    return {
      isConfirm: sc === 'confirm',
      /* COPY and SHARE wait for the code. Until the rail on screen has
       * something real behind its QR — the invoice, the request, the address —
       * there is nothing to copy or share, and they are greyed and do nothing. */
      recvReadyDim: recvReady() ? '1' : '0.35',
      invoiceCopy: () => {
        if (!recvReady()) return;
        const wire = s.recvVia === 'wire' || s.network === 'BANK WIRE';
        if (!wire && onchain && ocCode()) {
          this.toast(this.copyText(ocCode()) ? 'Address Copied' : 'Could not copy');
          return;
        }
        if (!wire && cashu && creq()) {
          /* Device-only, like a token. A Cashu request of Foxy's names the
           * onion address this phone is listening on, and the general
           * pasteboard syncs to every Apple device the person owns (audit
           * finding 6). Nothing about where this phone can be reached belongs
           * on someone's iPad. */
          this.toast(this.copySecret(creq()) ? 'Request Copied' : 'Could not copy');
          return;
        }
        if (!wire && s.invoice) {
          this.toast(this.copyText(s.invoice) ? 'Invoice Copied' : 'Could not copy');
          return;
        }
        this.toast(wire ? 'Info Copied' : 'Nothing to copy yet');
      },
      /* A payer has tapped and is looking at this screen for the four digits
       * to match against their own. Above the amount, the same size as it and
       * in the accent, because it is the thing being checked at that moment —
       * not a caption under a QR code. The QR stays
       * exactly as it was: somebody else may still be scanning it. */
      /* Offline, the figure is the dollars asked for and there is no sat line
       * under it. This phone has refused to convert — its price may be hours
       * old — so a sat figure here would be a conversion it is not making, and
       * a wrong one: the sats are whatever the paying phone's current price
       * makes of the amount, which is the number this phone is then asked to
       * agree to (`dollarsOnly`, `priceTermsCard`). */
      confirmAmount: val <= 0 ? 'ANY AMOUNT'
        : this.dollarsOnly() ? '$ ' + this.usd(val)
        : s.asset === 'BITCOIN' ? this.money(sats).main : '$ ' + this.usd(usd),
      confirmAlt: this.dollarsOnly() ? '' : s.asset === 'BITCOIN' ? this.money(sats).sub : '',
      showSats: s.asset === 'BITCOIN' && val > 0 && !this.dollarsOnly(),
      confirmTitle: onchain ? 'RECEIVE ON CHAIN' : 'RECEIVE INVOICE',
      confirmNetwork: onchain ? 'ON-CHAIN' : cashu ? 'CASHU' : (s.network || 'LIGHTNING'),
      // the middle of the QR says which it is: the bolt, ecash, or a coin
      qrBolt: !cashu && !onchain,
      qrEcash: cashu,
      qrChain: onchain,
      /* The code shares the screen with the mint's floor on this network — and
       * on a short phone it has to give way.
       *
       * It was a flat 300px, which is right on a 15 Pro Max and 36pt too tall
       * on an iPhone XS: the four buttons under it kept their circles and lost
       * their labels off the bottom of the screen. The XS
       * is the oldest phone Foxy will ever run on — iOS 17 needs an A12 — so
       * it is the floor to fit, and the SE is shorter still.
       *
       * A viewport-height cap leaves every tall phone exactly as it was and
       * shrinks the code on the ones that cannot afford it; the box also
       * shrinks under flex pressure (`flex:0 1 auto` in the markup), so a
       * screen shorter than any of these still gets a whole row of buttons
       * rather than half of one. A QR that is smaller still scans.
       *
       * The cap is a `max-width`/`max-height` pair rather than the `min()`
       * that says the same thing in one value: the snapshot renderer drops a
       * declaration it cannot parse, and `min()` is one of them, so writing it
       * that way would have left every receive snapshot with no size at all
       * and nothing to catch the next phone that does not fit. */
      qrBoxW: onchain ? '252px' : '300px',
      qrBoxCap: onchain ? '30vh' : '34vh',
      // what the network costs the person to know, under the code
      recvNote: onchain ? this.ocReceiveNote() : '',
      recvNoteShown: onchain,
      recvNoteInk: 'rgba(var(--ink-rgb),.55)',
      /* No network to pick offline: Cashu is the only one this phone can offer
       * by itself, so the chooser says why rather than listing two rails that
       * cannot be made. */
      pickNetwork: () => {
        if (this.offlineNow()) { this.offlineNo('Choosing a network'); return; }
        this.chooseRail(onchain ? 'ON-CHAIN' : cashu ? 'CASHU' : 'LIGHTNING',
          rail => this.setState({ recvRail: rail }));
      },
      // the pill goes grey with it, so it does not look tappable
      networkPillDim: this.offlineNow() ? '0.45' : '1',
      openNote: () => this.editSendNote(),
      shareQr: () => {
        if (!recvReady()) return;
        const inv = onchain ? ocCode() : cashu ? creq() : s.invoice;
        if (!inv) { this.toast('Nothing to share yet.', true); return; }
        if (!window.FoxyWallet.share(inv)) this.toast('Sharing is only available in the app.', true);
      },
      closeToHome: () => this.closeReceive(),
      // tap to pay: a payer's phone connected, and this is the code it shows
      tapCodeShown: sc === 'confirm' && !!s.tapShownCode && !s.tapCardOff,
      tapShownCode: s.tapShownCode || '',
      hideTapCode: () => this.tapDropPayer(),
      /* TAP, and this time it does something.
       *
       * There was no button here for a day. That was right while the payer was
       * the phone on the air: this screen was already listening, so a button
       * would have explained itself and nothing else, and a control nobody
       * presses is only in the way.
       *
       * The roles are the other way round now (TapLink.swift). This phone is
       * the one that advertises, and a receive screen that did it by itself
       * would be a till standing on the air for as long as it was open. So the
       * press is the arming, and nothing goes out without it.
       *
       * It lights up while it is on the air, and goes back to plain once a
       * payer is found — pressing it again then is the next customer, which
       * the bridge answers with a fresh service UUID and fresh keys. */
      tapArm: () => this.tapArm(),
      /* On the air, and saying so over the code somebody was about to scan.
       *
       * A QR and an orange card cannot both be the instruction. Once TAP is
       * pressed the instruction is "hold your phone here", so the card covers
       * the code until a payer arrives — and then the same card becomes the
       * four digits, which is the next thing to look at.
       * The X lifts it and the QR is back, ready to be scanned instead. */
      tapArmedShown: sc === 'confirm' && !!s.tapArmed && !s.tapShownCode && !s.tapCardOff,
      /* What it is actually doing. It said HOLD A PHONE HERE whatever was
       * happening underneath, including when the radio had been refused and
       * the phone was not on the air at all (26d-tap.js). */
      tapArmedHint: s.tapRecvStage === 'connecting' ? 'CONNECTING\u2026'
        : s.tapNotYet ? String(s.tapNotYet).toUpperCase()
        : 'HOLD A PHONE HERE',
      /* The label never changes. It is TAP, the way SCAN is SCAN — a button
        * that renames itself is a button somebody has to read twice. What says this phone is on the air is the accent, which
        * it shares with the card over the QR, and the card itself. */
      /* Greyed with the radio off, denied or missing: pressing it then says
       * "Enable Bluetooth to use tap to pay.". */
      tapArmBg: ['off', 'denied', 'unsupported'].indexOf(s.tapRecvStage) >= 0 ? 'rgba(var(--ink-rgb),.18)'
        : s.tapArmed ? 'var(--acc)' : 'var(--ink)',
      tapArmInk: ['off', 'denied', 'unsupported'].indexOf(s.tapRecvStage) >= 0 ? 'rgba(var(--ink-rgb),.45)'
        : '#050505',
      /* CARD: a FLASHcard payment, which is planned and not built. The
       * button is where TAP was; TAP is the emblem in the middle of the QR. */
      cardPay: () => this.toast('FLASHcard payments are coming.'),
      scanToReceive: () => this.scanTokenToReceive(),
    };
  }

  /* paid: the confirmation after money moves. A Lightning send ends here. */
  /** @param {RenderContext} c */
  renderPaid(c) {
    const { s, sc, sats } = c;
    return {
      isPaid: sc === 'paid',
      /* Outgoing shows what left the wallet; incoming shows what arrived.
       *
       * This screen is the one a Lightning send lands on — "WITHDRAWAL SENT" —
       * and it showed the amount while the balance fell by amount plus fee. */
      paidHeadline: this.money(sats + (s.payOut ? (this._lastFee || 0) : 0)).main,
      paidHeadlineSub: this.money(sats + (s.payOut ? (this._lastFee || 0) : 0)).sub,
      /* What the total is made of. Only outgoing, and only when there is a
       * fee — "SENT 102 / FEE 0" says nothing the headline did not. */
      paidBreakdown: !!s.payOut && (this._lastFee || 0) > 0,
      paidSentAmt: this.money(sats).main,
      paidFeeAmt: this.money(this._lastFee || 0).main,
      paidAddedTo: s.payOut ? this.paidTargetLabel()
        : (s.asset === 'BITCOIN' ? 'Bitcoin Balance' : 'Cash Balance'),
      paidStack: this.fitStack(H => this.satsStack(sats, s.recv && s.recv.live, H)),
      paidBolts: this.boltField((s.recv && s.recv.live) === 'in'),
      paidBoltFlash: (s.recv && s.recv.live) === 'in' ? 'boltFlash 1s cubic-bezier(.3,0,.5,1) both' : 'none',
      paidChromeAnim: (s.recv && s.recv.live) === 'out' ? 'chromeOut .23s cubic-bezier(.4,0,.7,.4) 60ms both' : 'none',
      paidBg: (s.recv && s.recv.live) === 'out' ? '#050505'
        : (s.recvResolved ? "var(--acc)" : 'var(--bg)'),
      paidGrid: ((s.recv && s.recv.live) === 'out') ? 'rgba(var(--ink-rgb),.05)' : (s.recvResolved ? 'transparent' : 'rgba(var(--ink-rgb),.05)'),
      paidInk: s.recvResolved ? '#050505' : 'var(--ink)',
      paidInkDim: s.recvResolved ? 'rgba(5,5,5,.5)' : 'rgba(var(--ink-rgb),.5)',
      paidBadgeBg: s.recvResolved ? '#050505' : 'var(--acc)',
      paidTitle: s.paidSays || (s.payOut ? 'WITHDRAWAL SENT' : 'PAYMENT RECEIVED'),
      paidAddedLabel: s.payOut ? 'SENT TO' : 'ADDED TO',
      paidBadgeTick: s.recvResolved ? 'var(--acc)' : CTA_INK(s),
      paidLive: (s.recv && s.recv.live) !== 'gone',
      dismissPaid: () => {
        this.setState(p => ({ recv: Object.assign({}, p.recv, { live: 'out' }) }));
        setTimeout(() => {
          // counts to whatever the wallet holds now, in either direction
          this.settleAnimate('btc');
          // back to whatever the confirmation interrupted, when it interrupted
          // something. Cleared either way so it cannot leak into the next one.
          const back = this._returnTo;
          this._returnTo = null;
          if (back) {
            setTimeout(() => this.setState({ screen: back.screen, stack: back.stack }), 0);
          }
          this.paidDismissed();
          this.setState({ screen: 'home', stack: [], amount: '', asset: '', network: '', unit: 'USD', payOut: false, recv: Object.assign({}, this.state.recv, { live: 'gone' }) });
        }, 450);
      },
    };
  }

  /* sendHow, sendType, sendScan: the ways to pay someone.
   *
   * There is no tap screen any more. It existed to be the payer's arming
   * gesture, and the payer no longer arms anything: this phone listens from
   * home and from here, and the merchant's press is what puts a payment on the
   * air (TapLink.swift). */
  /** @param {RenderContext} c */
  renderSend(c) {
    const { s, sc, emailOk } = c;
    /* Offline, two of these four cannot work and the other two can.
     *
     * TYPE and CONTACTS both end in a Lightning address, which has to be
     * resolved and then paid — network, twice over. SCAN and PASTE can carry a
     * Cashu payment request, which a phone with the right pieces already held
     * can answer without asking the mint anything (19-bill-split.js), so they
     * stay live. MAKE ECASH is the same send and stays live too.
     *
     * Greyed rather than hidden: a control that disappears leaves somebody
     * hunting for a feature they used yesterday, and the row of four is a shape
     * people learn. Dimmed, still tappable, and it says why. */
    const off = this.offlineNow();
    return {
      isSendHow: sc === 'sendHow', isSendType: sc === 'sendType', isSendScan: sc === 'sendScan',
      pickType: () => {
        if (off) { this.offlineNo('Typing an address'); return; }
        this.setState(p => ({
          screen: 'sendType', stack: p.stack.concat([p.screen]), flow: 'send',
          asset: 'DOLLARS', recipientKind: 'email', unit: 'USD', amount: '',
        }));
      },
      pickPaste: () => {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText()
            .then(t => this.acceptTarget(t))
            .catch(() => this.toast('Could not read the clipboard. Try scan.', true));
          return;
        }
        this.toast('Paste is not available here. Use scan.', true);
      },
      camOn: !!s.camOk, camOff: !s.camOk,
      scanHint: !s.camOk ? 'CAMERA IS OFF' : (s.scanWhy || 'HOLD STEADY'),
      /* The viewfinder is not a button.
       *
       * It holds a live camera that reads codes on its own — tapping it used
       * to open the full-screen scanner on top, which froze the preview
       * underneath and did nothing the preview was not already doing. Its
       * twin on the scan screen was disarmed earlier; this is the one on the
       * send screen. */
      howTap: () => {},
      scanTap: () => {},
      emailDraft: s.emailDraft || '',
      onEmail: e => this.setState({ emailDraft: e.target.value }),
      // a disabled CTA goes grey rather than a dimmed accent
      emailActSh: emailOk ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -2px 0 rgba(0,0,0,.16),0 5px 12px rgba(var(--acc-rgb),.3)' : 'none',
      emailSh: emailOk ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(var(--acc-rgb),.34)' : 'none',
      emailAnim: emailOk ? 'shineLoop 3.4s cubic-bezier(.32,0,.28,1) 3s infinite' : 'none',
      emailBg: emailOk ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      emailInk: emailOk ? CTA_INK(s) : 'rgba(var(--ink-rgb),.4)',
      emailNext: () => { if (emailOk) this.setState(p => ({ screen: 'amount', stack: p.stack.concat([p.screen]), recipient: (p.emailDraft || '').trim() })); },
      // TYPE, CONTACTS and PASTE are always on this screen. The markup still
      // asks, so the flags stay; what it asked — clHide over the fork's hide-*
      // props, which nothing here sets — is gone (finding 19).
      clTypeOn: true, clContactsOn: true, clPasteOn: true,
      // and offline the two that need a network are dimmed, not removed
      clTypeDim: off ? '0.38' : '1',
      clContactsDim: off ? '0.38' : '1',
      goMakeEcash: () => this.setState(p => ({
        screen: 'amount', stack: p.stack.concat([p.screen]),
        flow: 'send', tokenMode: true, asset: 'BITCOIN',
        // dollars, like receive's pad; the toggle swaps to sats
        amount: '', unit: 'USD', recipient: '', recipientKind: '',
        note: '', noteDraft: '',
      })),
    };
  }

  /* sendDone: the sending overlay and what it settles into. */
  /** @param {RenderContext} c */
  renderSent(c) {
    const { s, sc, sats } = c;
    const sendPhase = s.sendPhase || 'in';
    return {
      isSendDone: sc === 'sendDone',
      // eight seconds in and still sending: say so, and offer the way off
      sendSlowShown: sc === 'sendDone' && !!s.sendSlow && (sendPhase === 'in'),
      sendStopWaiting: () => {
        /* Still behind something else — the change top-up, usually — means
         * the payment has not begun, and it is dropped rather than made later
         * (`giveUpWaiting`). One already with the mint or the other phone
         * cannot be taken back, and is left to finish. */
        const W = window.FoxyWallet;
        const holder = W && W.proofLockHolder && W.proofLockHolder();
        const notBegun = !!holder && !/^(sendToken|pay|payLnurl)$/.test(String(holder.what || ''));
        if (W && W.giveUpWaiting) W.giveUpWaiting();
        console.log(notBegun
          ? '[foxy] sending: the person stopped waiting before the payment was made; dropped'
          : '[foxy] sending: the person stopped waiting; the payment is in history, unconfirmed');
        // `sendPhase` left at 'in' kept this phone from listening for a tap
        this.setState({ screen: 'home', stack: [], sendSlow: false, sendPhase: null });
        this.toast(notBegun ? 'Stopped. The payment was not made.' : 'Still being confirmed. It is in History.', false);
      },
      sentTitle: 'PAYMENT SENT',
      sendingNow: sendPhase === 'in' || sendPhase === 'onchain',
      sentDone: sendPhase === 'done' || sendPhase === 'settled',
      onchainSending: sendPhase === 'onchain',
      etaClock: Math.floor((s.etaLeft == null ? 600 : s.etaLeft) / 60) + ':' + String((s.etaLeft == null ? 600 : s.etaLeft) % 60).padStart(2, '0'),
      copyTracking: () => {},
      // with how far it has got, when it is big enough to take a while
      pendingLabel: s.recvPending ? 'PAYMENT PENDING'
        : (Number(s.sendPct) > 0 && Number(s.sendPct) < 100 ? 'SENDING ' + Math.round(s.sendPct) + '%'
          // waiting behind the change top-up says so, not SENDING to nobody
          : (this.sendBehindChange() ? 'FINISHING CHANGE' : 'SENDING')),
      trackLabel: s.recvPending ? 'VIEW PENDING TRANSACTION' : 'COPY TRACKING INFO',
      dismissOnchain: () => (s.recvPending ? this.dismissPending() : this.dismissOnchain()),
      /* What left the wallet, not what the recipient got.
       *
       * This said "9,862 withdrawn" after a payment that moved 9,877. The
       * amount and the fee are both real, and the one worth showing on a
       * confirmation is the one the balance actually fell by. */
      /* What left the wallet, read from a key nothing else clears. */
      sentHeadline: this.money(sats + (this._lastFee || 0)).main,
      // the dollar figure, matching the received screen
      /* asset is never set on the live send path — it exists only in the
       * preview fixtures — so branching on it left this blank. */
      sentHeadlineSub: this.money(sats + (this._lastFee || 0)).sub,
      /* What the total is made of.
       *
       * The headline is what left the wallet. Someone who typed 500 and sees
       * 502 needs the other two numbers, or the difference looks like an
       * error. Hidden when the fee is zero, because 500 and 0 on two lines
       * says nothing the headline did not. */
      sentBreakdown: (this._lastFee || 0) > 0,
      sentSentAmt: this.money(sats).main,
      sentFeeAmt: this.money(this._lastFee || 0).main,
      // the money stays on screen through the strike and past it — DONE clears it
      sentStack: this.fitStack(H => this.satsStack(sats, 'in', H)),
      sentToLabel: s.recvPending ? 'DELIVERING TO'
        : (sendPhase === 'done' || sendPhase === 'settled') ? 'DELIVERED TO' : 'SENDING TO',
      sentTo: s.recipientKind === 'email' ? (s.recipient || '').toUpperCase() : this.shortId(s.recipient || ''),
      sentBg: (sendPhase === 'done' || sendPhase === 'settled')
        ? "var(--acc)" : 'var(--bg)',
      sentGrid: (sendPhase === 'done' || sendPhase === 'settled') ? 'transparent' : 'rgba(var(--ink-rgb),.05)',
      sentInk: (sendPhase === 'done' || sendPhase === 'settled') ? '#050505' : 'var(--ink)',
      sentInkDim: (sendPhase === 'done' || sendPhase === 'settled') ? 'rgba(5,5,5,.5)' : 'rgba(var(--ink-rgb),.38)',
      sentBolts: this.boltField(sendPhase === 'done'),
      sentBoltFlash: sendPhase === 'done' ? 'boltFlash 1s cubic-bezier(.3,0,.5,1) both' : 'none',
      // dismissing the sent / pending screen: chrome lifts away, then home lands
      sentExitAnim: s.sendExit ? 'chromeOut .4s cubic-bezier(.4,0,.7,.4) both' : 'none',
      sentHome: () => {
        if (s.sendExit) return;
        this.setState({ sendExit: true });
        setTimeout(() => {
          this.settleAnimate('btc');
          this.setState({
            screen: 'home', stack: [], amount: '', asset: '', network: '', unit: 'USD',
            flow: 'receive', recipient: '', emailDraft: '', sendPhase: null, sendExit: false,
          });
        }, 380);
      },
    };
  }

  /* tokenOut: a generated ecash token. */
  /** @param {RenderContext} c */
  renderToken(c) {
    const { s, sc } = c;
    return {
      isTokenOut: sc === 'tokenOut',
      // made to pay someone at this mint instead of by Lightning (payThisMintWithToken)
      tokenForPayee: !!s.tokenForPayee,
      tokenAmount: (() => {
        const n = s.tokenOutSats
          || ((window.FoxyWallet && window.FoxyWallet.lastToken() || {}).sats) || 0;
        return this.money(n).main;
      })(),
      tokenAlt: (() => {
        const n = s.tokenOutSats
          || ((window.FoxyWallet && window.FoxyWallet.lastToken() || {}).sats) || 0;
        return this.money(n).sub;
      })(),
      tokenShowAlt: true,
      // only when the mint actually charged for the swap
      tokenHasFee: !!s.tokenOutFee,
      tokenFee: this.money(s.tokenOutFee || 0).main,
      // falls back to what is on file, so navigating away cannot lose it
      tokenOutQr: (() => {
        /* Only on its own screen. It was drawn on every render of every
         * screen, from the last token on file — thirty times in half a
         * minute for a 3,149-character token nobody was looking at, each one
         * a code too long to make. */
        if (sc !== 'tokenOut') return '';
        const tk = s.tokenOut
          || ((window.FoxyWallet && window.FoxyWallet.lastToken() || {}).token);
        // an animated code's latest frame (syncTokenQr), so a render does not put the dense one back
        if (tk && this._tokQr && this._tokQr.token === tk && this._tokQr.src) return this._tokQr.src;
        return tk ? window.FoxyWallet.qr(tk) : '';
      })(),
      // one word: 'COPY TOKEN' is wide enough to wrap NFC onto its own row
      tokenOutCta: s.tokenCopied ? 'COPIED' : 'COPY',
      tokenOutShare: () => window.FoxyWallet.share(
        this.state.tokenOut
        || ((window.FoxyWallet && window.FoxyWallet.lastToken() || {}).token) || ''),
      tokenNote: () => this.editTokenNote(),
      tokenOutCopy: () => {
        const ok = this.copySecret(this.state.tokenOut || '');
        this.setState({ tokenCopied: ok });
        if (!ok) this.toast('Could not copy.', true);
      },
      tokenOutDone: () => {
        window.FoxyWallet.clearLastToken();
        this.setState({ screen: 'home', stack: [], tokenOut: '', tokenCopied: false, tokenForPayee: false });
        // a watch not kept ends with its screen; a kept one goes on elsewhere
        setTimeout(() => this.claimWatchTick(), 0);
        this.settleAnimate('btc');
      },
    };
  }

  /* reqOffer: a scanned payment request, on the same shell a Lightning send
   * is confirmed on (confirmSpec). Foxy delivers it where
   * the request asks — its phone over Tor, or Nostr — or makes a token to
   * show when it names nowhere Foxy can reach (07-request-delivery.js). */
  /* THEIR BITCOIN PRICE, for a receiver with no route.
   *
   * It was a card, and a card is for something that went wrong. This is a
   * person looking at two figures and deciding — which is exactly what the
   * confirmation shell is for, and what every other decision about money in
   * Foxy uses.
   *
   * The order is: what is being offered, then the price behind it,
   * then how that price compares with the last one this phone saw, then the
   * question. The comparison is worked out here, from what this phone knows,
   * so a payer cannot dress it up (`readQuote`).
   */
  priceSpec() {
    const q = this.state.priceQ || {};
    /* Answered, and still here.
     *
     * A yes is followed by whatever that yes set in motion — a mint quote, a
     * swap — and over Tor on a phone with no route that can take the whole 25
     * seconds before it gives up. This screen stays up for it. It used to clear
     * the figures the moment the answer went, so what the person watched for
     * those seconds was this same screen showing "AMOUNT OFFERED ₿ 0", "THE
     * PAYER'S BITCOIN PRICE OF $0" and "this phone has never seen a bitcoin
     * price" — the question they had just answered, asked again with nothing in
     * it.
     *
     * So the figures stay, and the screen says it is working. */
    const said = !!this.state.priceSaid;
    const sats = Math.round(Number(q.sats) || 0);
    const usd = Number(q.usd) || 0;
    const theirs = Math.round(Number(q.theirRate) || 0);
    const pct = (q.differsPct == null) ? null : Number(q.differsPct);
    const ago = this.agoWords ? this.agoWords(Number(q.myRateAgeMs) || 0) : '';
    /* Under a tenth of a percent is the same price as far as anybody reading
     * this is concerned, and "0.0% higher" reads as a warning about nothing. */
    const near = pct != null && Math.abs(pct) < 0.1;
    /* The copy, the same screen from either side.
     *
     * What it says, in order: that the price has moved since this phone was
     * last online, what it is now, by how much it moved, and what that does to
     * the sats — which is the part a person can weigh. A dollar amount at a
     * higher price is fewer sats and at a lower one is more, whichever way the
     * money is going, so the direction is the opposite of the difference.
     *
     * The amount stays at the top. It is not in the copy, and it is what is
     * being agreed to. */
    const paying = q.side === 'pay';
    const verb = paying ? 'pay' : 'receive';
    const doing = paying ? 'paying' : 'receiving';
    const size = pct == null ? '' : (Math.abs(pct) < 1 ? Math.abs(pct).toFixed(1) : String(Math.round(Math.abs(pct))));
    /* The layout: the price is the big figure, because
     * the price is what is being agreed; then the difference, what it does to
     * the sats, and the question, each on its own line down the middle. */
    const intro = pct == null
      ? 'What you ' + verb + ' is based on the Bitcoin price. This phone has no earlier price to compare it with.'
      : near
      ? 'What you ' + verb + ' is based on the Bitcoin price, which is the same as when you were last online.'
      : 'What you ' + verb + ' is based on the Bitcoin price, which has changed since you were last online.';
    const difference = pct == null ? '\u2014' : near ? '0%' : (pct > 0 ? '+' : '\u2212') + size + '%';
    const result = pct == null ? 'There is nothing to compare it with.'
      : near ? 'You are ' + doing + ' the same in terms of sats.'
      : 'You are ' + doing + ' ' + size + '% ' + (pct > 0 ? 'less' : 'more') + ' in terms of sats.';
    return {
      title: 'BITCOIN PRICE',
      subtitle: intro,
      amountLabel: 'CURRENT BITCOIN PRICE',
      amount: '$ ' + this.group(theirs),
      amountSub: '',
      // the question is the buttons; a row asking it again was one too many
      rows: [
        this.cfRow('DIFFERENCE', difference),
        this.cfRow('RESULT', result),
      ].concat(said ? [this.cfRow('YOU AGREED TO THIS PRICE', 'Working out the rest with their phone\u2026')] : []),
      // answered: there is nothing left to reject, and the tap leg owns what happens next
      secondary: said ? null : { label: 'NO, CANCEL', go: () => this.priceAnswer(false) },
      close: said ? null : () => this.priceAnswer(false),
      cta: said ? 'WORKING\u2026' : 'YES, CONTINUE',
      ctaTone: 'go',
      ctaBusy: said,
      go: () => { if (!said) this.priceAnswer(true); },
    };
  }

  /* The one answer, whichever control gave it. Resolves the promise the tap
   * leg is waiting on and leaves the screen it came from. */
  priceAnswer(yes) {
    const say = this._priceSay;
    this._priceSay = null;
    /* Home only when the answer ends it. A yes is followed by a confirmation —
     * the payer's, or this phone's own — and dropping to home in between is a
     * flash of the wrong screen on the way to the right one ("it should go straight to confirmation and not show home in
     * between"). The screen the answer leads to sets itself. */
    /* The figures are kept on a yes, because this screen is still the one
     * showing while the answer is acted on (`priceSpec`). They are dropped
     * when the screen actually leaves, in `syncPriceQ`. */
    /* A receiver that says yes goes back to the screen it was asked on: the
     * invoice, with the four digits. That is what there is to look at while
     * the payer decides — whether the code on their phone is this one — and
     * WORKING… over a spinner showed neither. A payer
     * that says yes is a moment from its own confirmation and stays put. */
    const paying = !!(this.state.priceQ && this.state.priceQ.side === 'pay');
    if (yes && !paying) {
      this.setState(p => (p.stack && p.stack.length
        ? { screen: p.stack[p.stack.length - 1], stack: p.stack.slice(0, -1), priceSaid: false }
        : { priceSaid: true }));
    } else if (yes) this.setState({ priceSaid: true });
    else this.setState({ screen: 'home', stack: [], priceQ: null, priceSaid: false });
    if (typeof say === 'function') say(!!yes);
  }

  /* THEY USE ANOTHER MINT, and the only button that sends.
   *
   * This used to be a card, and agreeing to it opened the ordinary
   * confirmation, which then had to be sent — so the person agreed to a fee and
   * was then asked to agree to the payment, twice for one decision ("when they agree to the use of another mint that should be the
   * last thing they need to do").
   *
   * So it IS the confirmation. Everything it needs is already known — the
   * amount, what the receiver gets, what the crossing costs — and pressing PAY
   * moves the money and makes the payment, in that order, with nothing else to
   * press.
   */
  crossSpec() {
    const c = this.state.crossQ || {};
    const net = Math.round(Number(c.net) || 0);
    /* `fee` is null until the two mints have answered. Until then there is no
     * total to agree to, so the button says what it is doing and does nothing —
     * a button that could be pressed then would be agreeing to a number Foxy
     * has not worked out yet. */
    const known = c.fee != null && isFinite(Number(c.fee));
    const waiting = !known;
    const fee = known ? Math.max(0, Math.round(Number(c.fee))) : 0;
    const total = net + fee;
    const px = this.px();
    const d = (n) => (px ? ' (\u20bf ' + this.group(n) + ')' : '');
    const m = (n) => (px ? '$ ' + this.usd((n / 1e8) * px) : '\u20bf ' + this.group(n));
    return {
      title: 'THEY USE ANOTHER MINT',
      amountLabel: 'TOTAL PAYMENT',
      amount: waiting ? m(net) + ' + fee' : m(total),
      amountSub: (!waiting && px) ? '\u20bf ' + this.group(total) : '',
      /* The four digits of the phone this is going to, first and large, as on
       * every other confirmation a tap opens. It is the one check that the
       * money is going where the person thinks, and this screen sends it. */
      code: this.state.tapCode || '',
      rows: [
        this.cfRow('RECEIVER GETS', m(net), { sub: d(net).trim() }),
        this.cfRow('SWAP FEE', waiting ? 'WORKING IT OUT…' : m(fee),
          { sub: waiting ? '' : d(fee).trim(), ink: 'var(--btc-ink)' }),
        this.cfRow('THEIR MINT', String(c.them || '').toUpperCase(), { half: true }),
        this.cfRow('PAYING FROM', String(c.mine || '').toUpperCase(), { half: true }),
      ].concat(this.peerRateRow()),
      secondary: { label: 'CANCEL', go: () => this.crossAnswer(false) },
      close: () => this.crossAnswer(false),
      cta: waiting ? 'WORKING OUT THE FEE…'
        : 'PAY ' + m(total),
      ctaTone: 'go',
      ctaBusy: waiting || !!this.state.crossBusy,
      go: () => { if (!waiting) this.crossAnswer(true); },
    };
  }

  crossAnswer(yes) {
    if (this.state.crossBusy) return;
    const say = this._crossSay;
    if (!yes) {
      this._crossSay = null;
      /* Said to the phone in hand, or it reads the leaving as a payment lost
       * in flight and offers to scan. */
      const W = window.FoxyWallet;
      if (this.state.tapCode && W && W.tapQuote) {
        W.tapQuote(JSON.stringify({ gaveUp: 'The payer cancelled.' })).catch(() => {});
      }
      this.setState({ screen: 'home', stack: [], crossQ: null });
      if (typeof say === 'function') say(false);
      return;
    }
    /* The button stays where it is and says what it is doing: the move is a
     * real Lightning payment and takes seconds, and a screen that vanished
     * would leave the person wondering whether they had pressed it. */
    this.setState({ crossBusy: true });
    this._crossSay = null;
    if (typeof say === 'function') say(true);
  }

  /* Whose bitcoin price the dollar figures on this screen are in.
   *
   * Nothing at all when they are this phone's own, which is the normal case. A
   * phone with no route is converting at the price the phone it is tapping
   * gave it — fresher than its own and the one this payment is agreed at — and
   * that is worth saying rather than leaving somebody to wonder why the dollars
   * moved.
   */
  peerRateRow() {
    const label = this.peerRateLabel();
    if (!label) return [];
    return [this.cfRow('BITCOIN PRICE', '$ ' + this.group(Math.round(this.peerRate())),
                       { sub: 'theirs, not this phone\u2019s', ink: 'var(--btc-ink)' })];
  }

  requestSpec() {
    const s = this.state;
    const req = s.req;
    /* The open Bluetooth link is a delivery too.
     *
     * `delivery` comes from the transports the request names, and an offline
     * receiver names none — so this screen told the person it would GENERATE
     * ECASH TOKEN and that it would arrive WHEN THEY TAKE IT, while showing the
     * four-digit code of the phone it was about to be handed straight to. It
     * sends; it should say send. */
    const d = req && req.sats > 0
      ? (req.delivery || (req.viaTap ? { kind: 'tap' } : null)) : null;
    const onion = !!(d && d.kind === 'onion');
    const sats = req ? req.sats : 0;
    const mint = req && req.mints[0] ? String(req.mints[0]).replace(/^https?:\/\//, '') : 'any mint';
    /* Paid by tap: the phone it goes to is the one being held against this
     * one, and the four digits are what says so. They are the thing to check
     * before sending, so they are the value of this row rather than a note
     * under it, in the accent so the eye finds them. */
    const byTap = !!(req && req.viaTap && s.tapCode);
    const W = window.FoxyWallet;
    // locked exactly when the send will be (makeTokenForRequest): a key named, and a route
    const lack = (sats > 0 && W && W.sendShortfall)
      ? W.sendShortfall(sats, { locked: !!(req && req.lockTo && !(this.offlineNow && this.offlineNow())) }) : null;
    const to = byTap ? s.tapCode
      : d ? (onion ? 'THEIR PHONE, OVER TOR'
             : d.kind === 'tap' ? 'THE PHONE IN YOUR HAND' : 'THEIR NOSTR INBOX, OVER TOR')
      : (req && !req.transports.length) ? 'A TOKEN TO SHOW THEM' : 'A TOKEN YOU SEND THEM';
    const rows = (byTap ? [] : [this.cfRow('DELIVERED TO', to)]).concat([
      this.cfRow('PAYING FROM', (this.mintName() || 'THIS MINT').toUpperCase(), { half: true }),
      this.cfRow('NETWORK', 'CASHU', { half: true }),
      // not in the accent: the accent on this screen belongs to the code, and
      // two orange things is one too many to look at
      this.cfRow('ARRIVES', d ? 'IN SECONDS' : 'WHEN THEY TAKE IT',
        { ink: d ? 'var(--ink)' : 'var(--btc-ink)', half: true }),
      this.cfRow('FEE', lack && lack.fee > 0 ? this.money(lack.fee).main : this.px() ? '$ 0.00' : '\u20bf 0', { half: true }),
    ]).concat(this.peerRateRow());
    /* Short with the fee counted, as the send itself counts it. The balance
     * alone let a 980-sat request through on a phone holding 979, to be
     * refused after SEND. */
    const shortBy = lack && lack.short ? lack.need - lack.have : Math.max(0, sats - (s.balSats || 0));
    const short = shortBy > 0;
    if (short) {
      return {
        title: 'CONFIRMATION', amountLabel: 'SENDING', code: byTap ? s.tapCode : '',
        amount: this.money(sats).main, amountSub: this.money(sats).sub, amountInk: '#FF5C5C', rows: rows,
        warn: this.heldBlocks(shortBy)
          || 'More than your balance \u2014 short by ' + this.money(shortBy).main
             + (lack && lack.fee > 0 ? ' with the fee' : ''),
        cta: 'CLOSE', ctaTone: 'warn', go: () => this.setState({ screen: 'home', stack: [], req: null }),
      };
    }
    return {
      title: 'CONFIRMATION',
      code: byTap ? s.tapCode : '',
      amountLabel: 'SENDING',
      amount: sats ? this.money(sats).main : 'ANY AMOUNT',
      amountSub: sats ? this.money(sats).sub : '',
      rows: rows,
      /* The same pair the Lightning confirmation has: the note where the
       * second button goes, and the X at the top to back out. */
      secondary: { label: (s.note || '').trim() ? 'EDIT NOTE' : 'ADD A NOTE',
        go: () => this.editSendNote(), filled: !!(s.note || '').trim() },
      close: () => {
        /* Backing out of a request that came over a tap: the other phone is
         * told, so its screen does not offer to scan a payment that is not
         * coming. */
        const W = window.FoxyWallet;
        if (req && req.viaTap && W && W.tapQuote) {
          W.tapQuote(JSON.stringify({ gaveUp: 'The payer cancelled.' })).catch(() => {});
        }
        this.setState({ screen: 'home', stack: [], req: null, note: '', noteDraft: '' });
      },
      /* SEND over the link in your hand, PAY over Tor. Not one word for both:
       * over Tor it really is a payment going somewhere, and on a tap the two
       * phones are touching and the thing being done is handing it over. What
       * it must never say is GENERATE ECASH TOKEN, which is what it said while
       * showing the code of the phone it was about to send to. */
      cta: s.reqBusy ? (d ? (d.kind === 'tap' ? 'SENDING\u2026' : 'PAYING\u2026') : 'MAKING\u2026')
        : d ? (d.kind === 'tap' ? 'SEND ' : 'PAY ') + this.money(sats).main
        : 'GENERATE ECASH TOKEN',
      ctaTone: 'go',
      ctaBusy: !!s.reqBusy,
      go: () => this.makeTokenForRequest(),
    };
  }
