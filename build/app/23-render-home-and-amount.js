
  /* home: the balances, the price chart, RECEIVE and SEND, the backup prompt. */
  /** @param {RenderContext} c */
  renderHome(c) {
    const { s, sc, chart } = c;
    const bal = this.balNow();
    const crediting = s.animFrom ? s.animLane : null;
    return {
      isHome: sc === 'home',
      // SEND opens the ways to pay — scan, type, contacts, paste. This asked
      // clSend() whether only one of them was left, to skip the screen and go
      // straight to the scanner; the fork's hide-* props that could take the
      // others away are gone, so all four are always there (finding 19).
      goSend: () => this.setState(p => ({
        screen: 'sendHow', stack: p.stack.concat([p.screen]), flow: 'send',
        amount: '', asset: '', unit: 'USD', recipient: '', emailDraft: '',
        note: '', noteDraft: '',
      })),
      // home's SCAN: straight to the scanner, which is how a payment request,
      // an invoice or a token gets in
      goScan: () => this.setState(p => ({
        screen: 'sendScan', stack: p.stack.concat([p.screen]), flow: 'send',
        amount: '', asset: '', unit: 'USD', recipient: '', emailDraft: '',
        note: '', noteDraft: '',
      })),
      goReceive: () => this.setState(p => ({
        screen: 'amount', stack: p.stack.concat([p.screen]), flow: 'receive',
        asset: '', network: '', amount: '', unit: 'USD',
        note: '', noteDraft: '',
        // these belong to sending; left set, they decide what the receive
        // invoice screen displays instead of the amount just typed
        recipient: '', recipientKind: '',
      })),
      bkBadge: false,
      bkAskAgain: (e) => { e.stopPropagation(); this.setState({ bkAsk: true }); },
      goRecovery: () => this.setState(p => ({ screen: 'bkStart', stack: p.stack.concat([p.screen]) })),
      chartPath: chart ? chart.d : '',
      /* The same line, closed to the bottom of the box: a wash under the
       * price, which the snow-fox design uses to give it weight. It ends where the drawing does — past both edges — so the
       * wash bleeds off the screen with it. */
      chartFill: chart ? chart.d + ' L462 92 L-60 92 Z' : '',
      /* Sats held for a swap the mint has not answered are out of the
       * balance, and a balance that has simply dropped looks like money gone.
       * The pill under it says where they are until they are back. */
      deltaText: this.heldPill() || (chart ? chart.t : ''),
      deltaShown: !!this.heldPill() || !!chart, markerDisplay: chart ? 'block' : 'none',
      /* Once per visit to this screen, not once per session: the ride is what
       * the home screen opens with. The element is made
       * when the screen is drawn and let go when it is left, so this fires on
       * arrival, and `_rolled` only stops it restarting on every render while
       * the screen is up. A ride that cannot start yet — no line drawn — parks
       * instead, and the balance pass starts it when the series lands. */
      /* A tap anywhere on the price line's panel runs the ride again, for
       * anyone who missed it. He is off the right of the
       * screen the rest of the time, so there is nothing else to aim at. */
      markerTap: this._markerTap || (this._markerTap = e => {
        if (e && e.stopPropagation) e.stopPropagation();
        this.markerRoll();
      }),
      markerRef: this._markerRef || (this._markerRef = el => {
        this._marker = el;
        if (!el) { this._rolled = false; cancelAnimationFrame(this._mraf); return; }
        if (!this._rolled) {
          this._rolled = this.riderShow();
          // the element was made while this screen is up: an arrival already
          this._wasHome = this.state.screen === 'home';
        }
      }),
      priceText: s.livePrice
        ? '$ ' + Math.round(s.livePrice).toLocaleString('en-US')
        : '\u2014',
      /* The label carries the price's age once it has one.
       *
       * `livePrice` is never cleared, so a price that stopped refreshing goes on
       * being shown — and dollar figures go on being computed from it — with
       * nothing on screen to say how old it is. That is the exact thing the
       * comment in refreshBalance warns against: "a dollar figure that is simply
       * wrong, and there is no way to tell from the screen". Offline it can be
       * hours.
       *
       * So the age goes where the eye already is, in the one label both the
       * collapsed pill and the open chart share. Under three minutes it says
       * nothing, because that is the window the app already treats as current. */
      priceLabel: 'BITCOIN PRICE',
      /* The age on its own line under the price, in red:
       * beside the label it read as part of the title. */
      priceAge: this.priceAgeWords(),
      priceAgeShown: !!this.priceAgeWords(),
      markerTop: chart ? (chart.y / 92 * 100).toFixed(1) + '%' : '50%',
      toggleRange: () => this.setState(p => ({ rangeOpen: !p.rangeOpen })),
      fiatDisplay: s.hidden ? '••••••' : this.usd(bal.usd),
      fiatSub: s.hidden ? '' : 'USD',
      /* Dollars on the big line and the sats under it. The
       * names are from when it was the other way up. With no price the sats
       * take the big line alone, rather than a dollar figure nobody can stand
       * behind. */
      satsDisplay: s.hidden ? '••••••'
        : bal.sats == null ? '···'
        : this.satUsd() ? '$ ' + this.usd(bal.sats * this.satUsd())
        : '₿ ' + this.group(bal.sats),
      satsSub: s.hidden ? ''
        : bal.sats == null ? 'Loading balance…'
        : !this.satUsd() ? ''
        : '₿ ' + this.group(bal.sats),
      /* Money landing still lights the pill up, in the snow-fox design's own
       * frost rather than the accent — the orange is kept
       * for the price line, which is the one warm thing on the screen. */
      balGlowUsd: crediting === 'usd'
        ? '0 0 0 2.5px rgba(255,255,255,.6),0 0 38px rgba(207,224,236,.8)'
        : '0 0 26px rgba(207,224,236,.24)',
      balGlowBtc: crediting === 'btc'
        ? '0 0 0 2.5px rgba(255,255,255,.6),0 0 38px rgba(247,147,26,.85)'
        : '0 0 26px rgba(207,224,236,.24)',
      // an open eye while hidden (tap to show), struck through while showing
      hideIconPath: s.hidden
        ? 'M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z'
          + 'M12 14.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4'
        : 'm3.5 3.5 17 17M10.6 6.2A9.4 9.4 0 0 1 12 6c5 0 8.5 6 8.5 6'
          + 'a15 15 0 0 1-2.2 3M6.3 8A15.4 15.4 0 0 0 3.5 12s3.5 6 8.5 6'
          + 'a9 9 0 0 0 3.2-.6',
      showLimitsCta: !!s.priceCollapsed,
      homeTxs: [].map(t => ({
        name: s.hidden ? '••••••••' : t.name,
        initial: s.hidden ? '•' : t.name.slice(0, 1).toUpperCase(),
        time: s.hidden ? '•••••' : t.time,
        tileBg: s.hidden ? 'rgba(var(--ink-rgb),.16)' : (t.dir === 'in' ? 'var(--acc)' : 'rgba(var(--ink-rgb),.16)'),
        stroke: s.hidden ? 'rgba(var(--ink-rgb),.14)' : (t.dir === 'in' ? 'rgba(var(--acc-rgb),.7)' : 'rgba(229,72,77,.7)'),
        amtColor: s.hidden ? 'rgba(var(--ink-rgb),.55)' : (t.dir === 'in' ? 'var(--acc-ink)' : 'rgba(var(--ink-rgb),.8)'),
        amtText: s.hidden ? '••••••' : (t.dir === 'in' ? '+' : '−') + '₿ ' + this.txTotalOut(t).toLocaleString(),
        open: () => this.openTx(t),
      })),
      // shown from the first payment in until the phrase is verified
      showCtaBackup: !!(window.FoxyWallet && window.FoxyWallet.backedUp
        && !window.FoxyWallet.backedUp())
        && !!s.everReceived
        && !s.dismissedBackup,
      dismissBackup: (e) => { e.stopPropagation(); this.setState({ dismissedBackup: true }); },
      pillH: s.priceCollapsed ? 73 : 68,
      // The pill toggles too, and this button sits inside it — without
      // stopping the event here, one tap fires both handlers and the balance
      // hides and shows again in the same frame.
      toggleHide: (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        this.setState(p => ({ hidden: !p.hidden }));
      },
      /* The mint this balance is at, in the pill: its first letter in the
       * accent on black where the bitcoin sign was, with its name under it. */
      pillLetter: (this.mintName() || '?').slice(0, 1).toUpperCase(),
      pillMintName: this.mintName() || '',
      /* Two halves, either side of the line at 100px: the mint on the left
       * goes to the mints, the balance on the right goes to history. Hiding
       * stays on the eye, which is what that icon means. */
      togglePill: (e) => {
        let x = 0;
        try {
          const box = e && e.currentTarget && e.currentTarget.getBoundingClientRect
            ? e.currentTarget.getBoundingClientRect() : null;
          x = box ? (Number(e.clientX) || 0) - box.left : 0;
        } catch (x2) { x = 0; }
        if (x > 100) this.go('history'); else this.goSwitchMint();
      },
      priceCollapsed: !!s.priceCollapsed, priceExpanded: !s.priceCollapsed,
      /* The banner is the one thing on the home screen that says how Foxy
       * reaches the world, and it said it in three words. Tapping it says the
       * rest.
       *
       * It used to be fixed markup: "Secure Tor Connection" was on the home
       * screen whenever the home screen was, whatever the route underneath it
       * was doing. Someone who tapped past the gate to continue unprotected
       * was told their connection was secure while their IP address was in
       * the clear. Now it is drawn from the route and
       * says only what is true of it: blue and secure when Tor is carrying
       * everything, red and plain about it when nothing is, and nothing at
       * all while Tor is still connecting — there is no claim to make yet,
       * and the gate is already saying so. */
      ...this.torBannerVals(),
      /* The banner's tap. Offline it is the way back — which is the whole of
       * what TAP TO RETRY promises, so it must do that and not open a card
       * explaining what Tor is to somebody who has already read it once and
       * chosen to go without. Every other state has nothing a tap could change,
       * so it keeps the explainer. */
      torBanner: () => {
        if (this.torBannerVals().torBannerOffline) {
          if (window.FoxyGate && window.FoxyGate.leaveOffline) window.FoxyGate.leaveOffline();
          this.toast('Looking for Tor again\u2026');
          return;
        }
        this.blockedCard('torConnection', {
          tone: 'ask',
          title: 'TOR CONNECTION',
          reason: 'Tor is a privacy network that hides your IP address while you use Foxy.',
        });
      },
      toggleCollapse: () => this.setState(p => ({ priceCollapsed: !p.priceCollapsed })),
      chevronRot: s.priceCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
      priceFlex: s.priceCollapsed ? '0 0 auto' : '1 1 0%',
      priceTopPad: s.priceCollapsed ? 2 : 4,
      moneyFlex: (s.priceCollapsed || s.priceRemoved) ? '1 1 0%' : '0 0 auto',
      showPriceSection: !s.priceRemoved,
    };
  }

  /* The home banner's three states, from the route as it is right now.
   *
   * Secure is the strict reading: Tor up AND not continuing unprotected.
   * Anything short of that is not a secure connection and must not be
   * described as one. Red is for the one state where the person is actually
   * exposed and might not know it; while Tor is merely connecting the banner
   * is absent, because nothing has been claimed and nothing has leaked. */
  torBannerVals() {
    const W = window.FoxyWallet;
    const p = (W && W.privacy) ? W.privacy() : null;
    /* Chosen first, and a claim about the connection needs a connection.
     *
     * `secure` was Tor saying "up" and nothing else — not whether there was a
     * network under it, and not whether the person had chosen to work offline.
     * Tor reports bootstrap 100% from a state it cannot use: the phone loses
     * wifi, every request times out, the path monitor says none, and the
     * control port still says done. So the home screen told somebody who had
     * deliberately gone offline, on a phone that could not reach a mint, that
     * they had a Secure Tor Connection.
     *
     * This is the one banner whose whole job is to make a claim about the
     * connection, so it now asks what the rest of the app asks: a route is Tor
     * up AND a network under it, which is `setOffline`'s own test. And working
     * offline is a state the person chose and stays in, so it outranks every
     * reading of a route they have told Foxy not to use. */
    const chosen = !!p && !!p.offline;
    const live = !!p && p.tor === 'up' && p.network !== 'none';
    /* Exposure is the louder claim and outranks the choice: somebody whose
     * traffic is leaving unprotected needs telling whatever mode they think
     * they are in. Offline outranks everything below that. */
    const secure = live && !p.unprotected && !chosen;
    const off = !!p && !secure && !!p.unprotected;
    /* Working offline says so, and offers the way back.
     *
     * While Tor is merely connecting the banner is absent, and rightly: nothing
     * has been claimed and nothing has leaked. Offline is not that. It is a state
     * the person chose and stays in, in which most of the app will refuse them,
     * so a home screen that made no claim at all would be the same screen as a
     * healthy one. It is not red either — nothing is exposed, nothing is being
     * sent — so it takes the same amber the tunnels use, and its own tap. */
    const offline = chosen && !p.unprotected;
    /* Not on Foxy's Tor, but behind a tunnel they chose: say which, rather
     * than calling it exposure. Orbot is named because it is not a VPN like
     * the others — it IS Tor, so somebody on it is still on Tor, just not on
     * Foxy's own.
     *
     * Read from the route every time, never remembered: switch the tunnel off
     * and the banner turns red on its own, with no tap and no memory of what
     * was answered. */
    const viaOrbot = off && !!p.orbot && p.orbot !== 'none';
    const viaVpn = off && !viaOrbot && !!p.vpn;
    const exposed = off && !viaOrbot && !viaVpn;
    /* Working offline, and the radios have come back.
     *
     * "OFFLINE — TAP TO RETRY" is right for a phone with nothing to try; it is
     * wrong for one sitting next to the wifi it just rejoined, where the tap is
     * likely to work and the person has no way of knowing that from Foxy. The
     * path monitor knows, so the banner says so — carefully: a network is not a
     * Tor circuit, and "may be" is the whole of what this can honestly claim. It is the same tap either way. */
    const mayWork = offline && !!p && p.network && p.network !== 'none' && p.network !== 'unknown';
    return {
      torBannerShown: secure || off || offline,
      torBannerText: mayWork ? 'CONNECTION MAY BE AVAILABLE'
        : offline ? 'OFFLINE \u2014 TAP TO RETRY'
        : exposed ? 'IP Address Exposed'
        : viaOrbot ? 'Connected Via Orbot'
        : viaVpn ? 'Connected To Your VPN' : 'Secure Tor Connection',
      torBannerBg: offline ? '#E6D8A8' : exposed ? '#FF5C5C'
        : (viaOrbot || viaVpn) ? '#E6D8A8' : '#BFE3EC',
      torBannerInk: offline ? '#3A2F0B' : exposed ? '#3A0B0B'
        : (viaOrbot || viaVpn) ? '#3A2F0B' : '#123642',
      // read by the banner's tap, which is the way back out of offline
      torBannerOffline: offline,
    };
  }
  /* amount: the keypad, for sending, receiving and making a token. */
  /** @param {RenderContext} c */
  renderAmount(c) {
    const { s, sc, sendOver, val } = c;
    const sendHeld = /** @type {any} */ (c).sendHeld || '';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'].map(k => ({
      label: k, size: '30px', tap: () => this.press(k),
    }));
    return {
      isAmount: sc === 'amount',
      nextFur: (val > 0 && !sendOver)
        ? "radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),"
          + "rgba(255,240,220,0) 62%),"
          + "linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,"
          + "rgba(194,74,27,.78)),url('foxy-fur.webp')"
        : 'none,none,none',
      _amtOverStash: (this._amtOver = !!sendOver) ? 1 : 0,
      nextSh: (val > 0 && !sendOver) ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(var(--acc-rgb),.34)' : 'none',
      nextBg: (val > 0 && !sendOver) ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      nextInk: (val > 0 && !sendOver) ? CTA_INK(s) : 'rgba(var(--ink-rgb),.4)',
      /* Offline, a dollar amount is converted at whatever price this phone was
       * last told, which may be hours old. The person naming the amount is the
       * one who carries that, so it is said under the figure, in the age's own
       * words, rather than left to a chip on another screen. Only where it is true: with a route, or in sats, there is
       * nothing to warn about. */
      /* And, when the amount is over the balance only because part of it is
       * held back with the mint, that — the block's own words (heldBlocks).
       * It goes first: it is why this payment cannot go. */
      priceWarn: sendHeld ? sendHeld
        : (this.offlineNow() && s.unit === 'USD' && this.satUsd())
        ? 'WARNING: This is based on the price of Bitcoin '
          + (this.priceAgo() ? this.priceAgo().toLowerCase() : 'from a moment ago') + '.'
        : '',
      priceWarnShown: (sendHeld
        || (this.offlineNow() && s.unit === 'USD' && this.satUsd())) ? '1' : '0',
      amountTitle: 'SET AMOUNT',
      amountSubtitle: s.flow === 'onchain'
        ? 'How much to send on chain?'
        : s.flow === 'transfer'
        // what is at the mint it leaves, so the amount is typed against it
        ? 'From ' + (this.mintNameOf(s.trFrom) || 'that mint') + ' \u00b7 \u20bf '
          + this.group(this.trFromSats()) + ' there'
        : s.flow === 'deposit' ? 'How much do you want to deposit?'
        : s.flow === 'cardAdd' ? 'How much to add to your card?'
        : s.flow === 'cardWd' ? 'How much to withdraw?'
        : s.flow === 'receive' ? 'How much to receive?'
        : 'How much to send?',
      hideSkip: true,
      next: () => {
        if (this.state.flow === 'transfer') { this.trNext(); return; }
        if (this.state.flow === 'onchain') { if (!sendOver) this.ocNext(); return; }
        /* Over the balance already has its own line under the amount
         * (sendOverLabel), so the refusal is explained on screen and a toast
         * would only repeat it. Nothing said why a NEXT at zero did nothing,
         * which is the same wall the split screen's minimum was. */
        if (sendOver) return;
        if (val <= 0) { this.toast('Type an amount first.', true); return; }
        /* One wallet holding one asset, so there is nothing to pick: a send
         * goes straight to its confirmation, anything else opens a Lightning
         * invoice.
         *
         * This used to ask clOneWallet() and clAsset() — true and 'BITCOIN'
         * since the fork's other wallets went — and fall through to a
         * `payFrom` or `asset` picker when they said otherwise. Neither screen
         * renders anything. Receiving went the same way through clGoRail,
         * whose one rail with a screen of its own is Lightning; the receive
         * screen's NETWORK chip is what chooses Cashu or on chain from there
         * (finding 19). The same two paths, said plainly. */
        if (this.state.flow === 'send') {
          this.setState(p => ({ payFrom: 'BITCOIN', screen: 'sendConfirm', stack: p.stack.concat([p.screen]) }));
        } else {
          this.setState({ asset: 'BITCOIN' });
          this.renderVals().pickLightning();
        }
      },
      pickLightning: () => { this.setState(p => ({ network: 'LIGHTNING', depositVia: '', screen: 'confirm', stack: p.stack.concat([p.screen]) })); this.openReceive(); },
      keys: keys, del: () => this.press('del'),
      amountDisplay: s.unit === 'SATS' ? '₿ ' + (s.amount === '' ? '0' : this.display()) : '$ ' + this.display(),
      /* The other unit, under the one being typed.
       *
       * Built from the keypad rather than from any screen's own figure — an
       * earlier definition took its number from elsewhere and sat stale while
       * this one changed. No price means no line, which is the same rule
       * wantedSats follows rather than inventing a rate. */
      amountSub: (() => {
        /* Offline, asking to be paid, there is no second figure: this phone is
         * not converting, so it has no sats to show. The payer's phone says
         * what the amount makes and this phone agrees to it or does not
         * (`dollarsOnly`). */
        if (this.dollarsOnly()) return '';
        const px = this.satUsd();
        if (!px) return '';
        const sats = this.wantedSats() || 0;
        return s.unit === 'SATS'
          ? '$ ' + this.usd(sats * px)
          : '₿ ' + this.group(sats);
      })(),
      /* Hidden, not removed: it is a 46px circle above the keypad, and taking
       * it out of the flow moves every key under the thumb mid-entry — the
       * same reason PASTE ECASH is hidden rather than dropped. */
      swapVis: this.dollarsOnly() ? 'hidden' : 'visible',
      swapPE: this.dollarsOnly() ? 'none' : 'auto',
      toggleUnit: () => this.toggleUnit(),
      // a token carries its own amount, so the two are alternatives
      // gone entirely once there is an amount, back when the field is cleared:
      // a token carries its own value, so the two cannot both be true
      // hidden rather than removed: taking it out of the flow moves the keypad
      // and the amount under the user's thumb mid-entry
      // receiving only: there is nothing to paste into a payment you are making
      pasteSlot: false,
      // NEXT sits on the same line as home's menu button either way — the
      // paste button below it is 56px plus a 10px gap, so the padding absorbs
      // the difference when it is not there
      // NEXT sits where SHARE does on the receive invoice screen
      amtPad: s.flow !== 'send' ? '7px 28px 26px' : '7px 28px 70px',
      pasteVis: parseFloat(s.amount) > 0 ? 'hidden' : 'visible',
      pastePE: parseFloat(s.amount) > 0 ? 'none' : 'auto',
      ecashInk: !(parseFloat(s.amount) > 0) ? 'var(--ink)' : 'rgba(var(--ink-rgb),.3)',
      ecashBorder: !(parseFloat(s.amount) > 0)
        ? 'rgba(var(--acc-rgb),.6)' : 'rgba(var(--ink-rgb),.12)',
      ecashCur: !(parseFloat(s.amount) > 0) ? 'pointer' : 'default',
      scanEcash: () => this.scanEcashToken(),
      // tokenMode is not cleared on the way out of the send flow, so it has to
      // be read together with the flow — otherwise generating once leaves the
      // wrong button on the receive screen
      // Token mode has no recipient by definition, so a recipient is what ends
      // it. Keying on the flow alone left an lnurl send showing GENERATE
      // ECASH TOKEN, because that is a send too.
      tokenMode: !!s.tokenMode && s.flow === 'send' && !s.recipient,
      notTokenMode: !(s.tokenMode && s.flow === 'send' && !s.recipient),
      makeCta: s.makeBusy ? 'MAKING\u2026' : 'GENERATE ECASH TOKEN',
      makeInk: parseFloat(s.amount) > 0 ? 'var(--ink)' : 'rgba(var(--ink-rgb),.3)',
      makeBorder: parseFloat(s.amount) > 0
        ? 'rgba(var(--acc-rgb),.6)' : 'rgba(var(--ink-rgb),.12)',
      makeCur: parseFloat(s.amount) > 0 ? 'pointer' : 'default',
      makeEcash: () => this.makeEcashToken(),
      pasteEcash: () => this.pasteEcashToken(),
      nextAnim: (val > 0 && !sendOver) ? 'shineLoopFur 3.4s cubic-bezier(.32,0,.28,1) 3s infinite' : 'none',
      amountInk: sendOver ? '#FF5C5C' : 'var(--acc)',
      sendOverShown: sendOver ? '1' : '0',
      sendOverLabel: sendHeld ? 'PENDING WITH THE MINT' : 'MORE THAN YOUR BALANCE',
    };
  }
