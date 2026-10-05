
  /* Every screen change, written to the log.
   *
   * Nothing recorded where the person had actually been. A screen that opened
   * when another should have, or one that never appeared at all, could only be
   * reported in words afterwards and then hunted for in the code — the switch
   * screen that showed transfer instead, the collecting screen that never
   * marked a payer paid. A log naming the screens
   * in order, with the few flags that decide which one is drawn, turns that
   * into something a device log answers by itself.
   *
   * What it does NOT carry: amounts, invoices, tokens, mint hosts, contacts.
   * The screen's name, how long it was up, how deep the back stack is, and
   * whichever of the flow flags are set. Those flags are the ones that have
   * actually caused a wrong screen, and none of them is anyone's money.
   *
   * Debug builds only, like every console line (13-console-and-qr.js). */
  noteScreen(prevState) {
    const s = this.state;
    const now = Date.now();
    const held = this._screenAt ? now - this._screenAt : 0;
    this._screenAt = now;
    const flags = [];
    const add = (name, v) => { if (v) flags.push(name + '=' + v); };
    add('flow', s.flow);
    add('rail', s.recvRail);
    add('trStep', s.trStep);
    add('spStep', s.spStep);
    add('card', this._blockedKind);
    if (s.invoiceIsAddress) flags.push('onchain');
    if (this._riding) flags.push('riding');
    /* The sending screen is never the last screen. Eight seconds on it with
     * nothing settled and it says so and offers a way off: a payer whose app
     * had been put away mid-tap came back to SENDING, waited fifteen seconds
     * with nothing to press, and killed Foxy. One
     * timer, started on arriving and cleared on leaving. */
    // paid: the top-up starts while the confirmation is still up
    if (s.screen === 'paid' && this.tidyChangeNow) this.tidyChangeNow();
    clearTimeout(this._sendSlowT);
    if (s.screen === 'sendDone') {
      this._sendSlowT = setTimeout(() => {
        const now = this.state;
        if (now.screen === 'sendDone' && (now.sendPhase || 'in') === 'in') this.setState({ sendSlow: true });
      }, 13000);
    } else if (s.sendSlow || s.sendPct) {
      this.setState({ sendSlow: false, sendPct: 0 });
    }
    console.log('[foxy] screen ' + (prevState.screen || '?') + ' \u2192 ' + s.screen
      + ' after ' + held + 'ms, back stack ' + ((s.stack && s.stack.length) || 0)
      + (flags.length ? ' | ' + flags.join(' ') : ''));
  }

  /* Home is the end of a receive, however it was reached.
   *
   * The invoice watch was stopped by the ways out that remembered to:
   * the close button, a new invoice, a crossing. A request paid by tap
   * goes confirm, paid, home and passes none of them, and neither does
   * plain Back — so the watch went on asking about an invoice nobody
   * would pay, and `moneyBusy` read it as money in flight: "Wait for the
   * payment to finish before switching mints", about a payment that had
   * finished thirty seconds before.
   * The quote stays on file and the sweep claims it if it is ever paid. */
  endReceiveAtHome() {
    /* And an invoice still being asked for is let go when it answers.
     *
     * Back out of the invoice screen within a second, before the mint has
     * answered, and there is no watch to stop yet. The answer then came a
     * moment later, to a screen that was no longer there, and started one:
     * switching mints was refused for "a payment in progress" that was an
     * invoice nobody had ever seen, until home was reached a second time. The
     * request is marked as an older one here, whether or not anything is
     * being watched, so its answer is dropped (`openReceiveNow`). */
    this._invoiceRun = (this._invoiceRun || 0) + 1;
    if (!this._watching && !this._stopWatch) return;
    console.log('[foxy] receive: home, so the invoice watch stops; the sweep has the quote');
    this.stopReceive();
  }

  componentDidUpdate(prevProps, prevState) {
    // every screen the person is actually shown, in order
    if (prevState && prevState.screen !== this.state.screen) {
      this.noteScreen(prevState);
      // landing on a token's own screen: ask the mint about it at once
      if (this.state.screen === 'tokenOut') this.tokenWatchNow();
      if (this.state.screen === 'home') this.endReceiveAtHome();
      // a code somebody was asked to scan goes with the token it belonged to
      if (prevState.screen === 'tokenOut' && this.hideStage) this.hideStage('needScan');
      // a receive's amount screen: the road to the mint is opened while the amount is typed
      if (this.state.screen === 'amount' && this.state.flow === 'receive') {
        const Ww = window.FoxyWallet;
        if (Ww && Ww.warmMint && !(this.offlineNow && this.offlineNow())) Ww.warmMint();
      }
      // the camera opened for a reason says it only while it is open
      if (prevState.screen === 'sendScan' && this.state.scanWhy) this.setState({ scanWhy: '' });
    }
    // the token screen's QR code animates while it is open (syncTokenQr)
    this.syncTokenQr();
    // and the receive screen's, where a request with two transports on it is
    // too dense for one static code on a small phone (07-history-tokens-mints.js)
    this.syncReqQr();
    // the agreed price is forgotten once its screen has gone, and not before
    // (24-render-receive-and-send.js)
    if (this.state.screen !== 'priceConfirm' && (this.state.priceQ || this.state.priceSaid)) {
      this.setState({ priceQ: null, priceSaid: false });
    }
    // words typed on the phone for restore are forgotten there, however the
    // restore screens are left — Back, a card's CLOSE, or anything else
    const restoring = s => s === 'importSeed' || s === 'rsConfirm';
    if (prevState && restoring(prevState.screen) && !restoring(this.state.screen)
        && this._rsCandidates && this._rsCandidates.size) {
      if (this.state.rsCandidate) this.setState({ rsCandidate: null });
      this.forgetRestoreCandidates(null);
    }
    /* A payment typed in dollars is fixed in sats as its confirmation opens,
     * and that is what is shown and sent (sendAmountText, startSendNow). */
    if (this.state.screen === 'sendConfirm' && (!prevState || prevState.screen !== 'sendConfirm')) {
      const typed = this.state.recipientKind !== 'invoice' && this.state.unit !== 'SATS';
      if (typed) this.checkSendPrice();
      else if (this.state.sendSats || this.state.sendPriceCheck) this.setState({ sendSats: null, sendPriceCheck: null });
    }
    // the send confirmation needs a fee before the person decides, not after
    if (this.state.screen === 'sendConfirm') this.quoteSendFee();
    this.syncUnit();
    this.syncQueue();
    this.syncSlide();
    this.syncPreview();
    this.syncInbox();
    this.syncTap();
    this.syncClaim();
    this.syncAwake();
    this.syncShake();
    this.syncFlip();
    this.syncAccent();
    this.pushToNative();
    this.syncHaptics();
    /* The ride is what home opens with, every time it is opened.
     *
     * The price panel is part of the shell and its marker outlives a trip to
     * another screen, so the element's own ref fires once and never again —
     * arriving back at home has to say so itself. The first real price series
     * can also land after the screen is already up, which is the second case
     * here. */
    this.syncSnow();
    this.markerStayGone();
    const home = this.state.screen === 'home';
    if (this._marker && home && this._wasHome === false) {
      this._rolled = this.riderShow();
    } else if (this._marker && home && !this._rolled) {
      this._rolled = this.riderShow();
    }
    this._wasHome = home;
  }

  press(ch) {
    /* Dollars are typed cents first, the way a card terminal takes them:
     * 5 is $0.05, 50 is $0.50, 500 is $5.00. The amount is still kept as a
     * decimal string ("5.00"), so everything that reads it (wantedSats, the
     * deep links, toggleUnit) goes on reading it. "00" appends two zeros in
     * either unit; it replaced the decimal point, which this entry has no
     * use for. */
    this.setState(p => {
      let a = p.amount;
      if (p.unit !== 'SATS') {
        let d = a.replace('.', '').replace(/^0+/, '');
        if (ch === 'del') d = d.slice(0, -1);
        else if (/^[0-9]+$/.test(ch)) { if (d.length + ch.length > 9) return { amount: a }; d += ch; }
        else return { amount: a };
        d = d.replace(/^0+/, '');
        if (d === '') return { amount: '' };
        d = d.padStart(3, '0');
        return { amount: d.slice(0, -2) + '.' + d.slice(-2) };
      }
      if (ch === 'del') return { amount: a.slice(0, -1) };
      if (!/^[0-9]+$/.test(ch)) return { amount: a };
      if (a === '0' || a === '') { if (ch === '00') return { amount: a }; return { amount: ch }; }
      if (a.length + ch.length > 9) return { amount: a };
      return { amount: a + ch };
    });
  }

  toggleUnit() {
    /* No price, no conversion — the same rule wantedSats() follows.
     *
     * px() answers null until a price has landed, and dividing by it made the
     * amount the string "Infinity", which then went on into the send and
     * receive flows as a figure. The other direction was quieter and just as
     * wrong: it multiplied by null and wrote "0.00" over what was typed. */
    /* Offline, asking to be paid has no other unit to swap to: this phone is
     * refusing to convert, which is the whole of why it is asking in dollars
     * (`dollarsOnly`). The control is not on screen either; this is the half
     * that holds if anything else reaches it. */
    if (this.dollarsOnly()) {
      this.toast('Offline, Foxy asks in dollars \u2014 the paying phone works out the sats.', true);
      return;
    }
    const px = this.px();
    if (!px) { this.toast('No bitcoin price yet \u2014 amounts stay in ' + this.state.unit + '.', true); return; }
    this.setState(p => {
      const v = parseFloat(p.amount) || 0;
      if (p.unit === 'USD') return { unit: 'SATS', amount: v ? String(Math.round(v / px * 1e8)) : '' };
      return { unit: 'USD', amount: v ? (v / 1e8 * px).toFixed(2) : '' };
    });
  }

  group(n) {
    if (n == null || !isFinite(n)) return '···';
    return Number(n).toLocaleString('en-US');
  }

  // ---- balance credit animation ----
  // dismissing a payment confirmation lands you on home, where the pill counts up from the
  // old balance to the new one. The committed balance is state; the count-up is a lerp
  // from animFrom → committed, so an interrupted animation still ends on the right number.
  balNow() {
    const s = this.state;
    const to = { usd: s.balUsd, sats: s.balSats };
    if (to.sats == null) return to;
    if (!s.animFrom) return to;
    const t = s.animT || 0;
    const e = 1 - Math.pow(1 - t, 3);
    return {
      usd: s.animFrom.usd + (to.usd - s.animFrom.usd) * e,
      sats: Math.round(s.animFrom.sats + (to.sats - s.animFrom.sats) * e),
    };
  }

  /* Count from the balance before the change to whatever the wallet says now.
   *
   * moveBalance() reads the typed amount to work out the size of the move,
   * which is fine for the prototype's flows and useless for a real one: by the
   * time a confirmation is dismissed the keypad has been cleared, and an ecash
   * token never had an amount typed at all. So it bailed before animating.
   * This asks the wallet instead and needs no amount.
   */
  settleAnimate(lane) {
    // Without a snapshot there is nothing to count from: the pill already
    // holds the new figure, so the animation would run from a number to
    // itself — and worse, it cancels one that is still playing. A second
    // caller arriving a moment later is what made the count-up vanish.
    const from = this._preSettle;
    if (!from) return;
    this._preSettle = null;
    clearInterval(this._balT);
    const ok = this.animateToLive(from, lane || 'btc');
    console.log('[foxy] balance animation: from', from.sats, '| wallet asked:', ok);
    if (!ok) this.runBalanceAnim();
  }

  // shared by the receive invoice and the scan confirm
  openNote() {
    const s = this.state;
    this.setState({ noteOpen: true, noteDraft: s.note || '', kbShift: !(s.note || '').length, kbSymbols: false });
  }

  // native keyboards need the focus to land after the screen transition, so retry a few times.
  // the ref identity is stable (see renderVals) and detach is treated as transient — a ref swap
  // must never cancel a pending focus, or the mount render burst eats every attempt.
  autoFocus(key, el) {
    if (this.props.startStatic) return;
    const flagK = '_af_' + key, timerK = '_afT_' + key, nodeK = '_afN_' + key;
    if (el) {
      if (this[flagK] && this[nodeK] === el) return;
      this[nodeK] = el;
      this[flagK] = true;
      (this[timerK] || []).forEach(clearTimeout);
      try { el.focus({ preventScroll: true }); } catch (e) {}
    Promise.resolve().then(() => { const n = this[nodeK]; if (n && document.contains(n) && document.activeElement !== n) { try { n.focus({ preventScroll: true }); } catch (e) {} } });
    this[timerK] = [60, 200, 420, 700].map(ms => setTimeout(() => {
        const n = this[nodeK];
        if (n && document.contains(n) && document.activeElement !== n) {
          try { n.focus({ preventScroll: true }); } catch (e) {}
        }
      }, ms));
      return;
    }
    // only give up once the node has genuinely left the document
    setTimeout(() => {
      const n = this[nodeK];
      if (n && !document.contains(n)) {
        (this[timerK] || []).forEach(clearTimeout);
        this[timerK] = null; this[flagK] = false; this[nodeK] = null;
      }
    }, 500);
  }


  // sign 1 = money in (received), -1 = money out (sent) — same count animation either way
  runBalanceAnim() {
    const start = Date.now(), DUR = 1150;
    clearInterval(this._balT);
    this._balT = setInterval(() => {
      const t = Math.min((Date.now() - start) / DUR, 1);
      this.setState({ animT: t });
      if (t >= 1) { clearInterval(this._balT); this.setState({ animFrom: null, animLane: null }); }
    }, 40);
  }

  // called on settlement, never on submit — the balance must not move before the money does.
  // home-screen money art: one graphic per denomination with a count, not one per unit
  display() {
    const a = this.state.amount;
    if (a === '') return '0.00';
    const dot = a.indexOf('.');
    if (this.state.unit !== 'SATS') {
      const whole = (dot < 0 ? a : a.slice(0, dot)) || '0';
      const cents = dot < 0 ? '' : a.slice(dot + 1);
      return this.group(whole) + '.' + (cents + '00').slice(0, 2);
    }
    if (dot < 0) return this.group(a);
    return this.group(a.slice(0, dot) || 0) + '.' + a.slice(dot + 1);
  }

  // Sat Symbol (satsymbol.com) — one vertical stem crossed by three evenly
  // spaced horizontals, square ends. Open, unrestricted use per the project.
  // a storm of small bolts sweeping top-right to bottom-left, all inside ~1s
  boltField(active) {
    const R = React.createElement;
    const rnd = n => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
    const bolts = [];
    // 96 of these was three times what the screen can show at once, and each
    // one is a filtered <img> on its own layer. The spread is by t, so fewer
    // bolts cover the same width rather than crowding into part of it.
    for (let i = 0; i < 32; i++) {
      const t = i / 31;
      bolts.push(R('img', {
        key: 'blt' + i,
        src: (window.__resources && window.__resources.bolt) || 'assets/bolt-on-dark.svg', alt: '',
        style: {
          position: 'absolute',
          left: (18 + t * 100 + (rnd(i) - 0.5) * 14) + '%',
          top: (-72 + rnd(i + 40) * 62) + '%',
          height: 24 + Math.round(rnd(i + 80) * 44), width: 'auto', opacity: 0,
          filter: 'drop-shadow(0 0 13px rgba(255,242,4,.9))',
          animation: active ? 'boltRain ' + (450 + Math.round(rnd(i + 120) * 192)) + 'ms cubic-bezier(.45,0,.85,.55) both' : 'none',
          animationDelay: Math.round(Math.pow(rnd(i + 160), 1.7) * 300) + 'ms',
        },
      }));
    }
    return R('div', { style: { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' } }, bolts);
  }

  satCoinEl(i, phase, fill, count, D, label, tint) {
    const R = React.createElement;
    const partial = fill != null;
    const t = tint || { sand: 'linear-gradient(150deg,#FFE9A8 0%,#F7C24E 26%,#E19420 62%,#B96B0D 100%)', rim: 'rgba(255,214,150,.62)' };
    const pct = partial ? fill : 100;
    const rnd = n => { const x = Math.sin((i + 1) * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
    // droplet count derives from the molten band's area so a shallow coin gets
    // fewer drops instead of a solid blob; ~50% coverage keeps each one legible
    const bandArea = Math.PI * (D / 2) * (D / 2) * (pct / 100);
    const avgDrop = Math.PI * Math.pow(D * 0.041 / 2, 2);
    const byArea = Math.round(bandArea / Math.max(avgDrop, 1) * 0.5);
    // droplets are only legible on a reasonably large coin — below that, and on
    // dense receipts, the pool fill alone carries the effect
    const budget = Math.floor(620 / Math.max(count, 1));
    // only the ragged partial coin melts in; whole coins land already solid gold
    const grainN = (!partial || D < 40 || count > 40) ? 0 : Math.max(8, Math.min(byArea, budget, 24));
    const inDelay = 120 + i * this.step(count, 26, 4300);
    const dropMs = 300, dropGap = Math.max(9, 1000 / grainN);
    // the pool only rises as fast as the droplets land in it
    const fillDelay = grainN ? inDelay + dropMs * 0.72 : inDelay;
    const fillMs = grainN ? Math.max(420, Math.round(dropGap * (grainN - 1) + dropMs)) : 620;
    const fillSteps = grainN ? Math.min(grainN, 40) : 1;
    const grains = [];
    for (let g = 0; g < grainN; g++) { // eslint-disable-line
      const sz = Math.max(2.5, +(D * (0.03 + rnd(g) * 0.024)).toFixed(1));
      // each droplet lands on the pool surface as it stands when that droplet arrives
      const level = Math.max(pct * ((g + 1) / grainN) - 4, 2);
      grains.push(R('div', {
        key: 'g' + g + phase,
        style: {
          position: 'absolute', left: (8 + rnd(g + 40) * 78) + '%',
          bottom: 'calc(' + level + '% - ' + Math.round(sz * 0.45) + 'px)',
          width: sz, height: sz, borderRadius: '50%',
          background: 'radial-gradient(circle at 34% 28%,#FFF3CE 0%,#F7C24E 44%,#D08616 100%)',
          boxShadow: '0 1px 2px rgba(90,45,2,.45)',
          animation: (phase === 'out' ? 'grainOut .4s ease-in both' : 'dropMelt ' + dropMs + 'ms cubic-bezier(.4,.05,.6,1) both'),
          animationDelay: (phase === 'out' ? (g % 24) * 9 : Math.round(inDelay + g * dropGap)) + 'ms',
        },
      }));
    }
    return R('div', {
      key: 's' + i + phase,
      style: {
        position: 'relative', width: D, height: D, borderRadius: '50%', boxSizing: 'border-box', flex: 'none',
        border: partial ? '2px dashed rgba(242,163,66,.8)' : '2.5px solid ' + t.rim,
        background: partial ? 'rgba(220,127,28,.1)' : 'radial-gradient(circle at 32% 26%,rgba(255,255,255,.28),rgba(255,255,255,0) 58%), #7A4409',
        boxShadow: partial ? 'none' : '0 5px 12px rgba(0,0,0,.36)',
        overflow: 'hidden', isolation: 'isolate', WebkitMaskImage: '-webkit-radial-gradient(white, black)',
        animation: (phase === 'out' ? 'coinOut .46s' : 'coinIn .44s') + ' cubic-bezier(.2,.9,.25,1) both',
        animationDelay: (phase === 'out' ? (count - 1 - i) * this.step(count, 11) : i * this.step(count, 34)) + 'ms',
      },
    }, [
      R('div', {
        key: 'sand',
        style: {
          position: 'absolute', left: 0, right: 0, bottom: 0, height: pct + '%',
          background: t.sand,
          boxShadow: 'inset 0 2px 5px rgba(255,255,255,.5), inset 0 -3px 0 rgba(90,45,2,.42)',
          transformOrigin: 'bottom',
          animation: phase === 'out' ? 'sandFall .42s ease-in both' : (partial ? 'sandRise ' + fillMs + 'ms steps(' + fillSteps + ', end) both' : 'none'),
          animationDelay: (phase === 'out' ? i * 10 : fillDelay) + 'ms',
        },
      }),
      R('div', {
        key: 'shine',
        style: {
          position: 'absolute', left: '-40%', top: 0, width: '55%', height: '100%',
          background: 'linear-gradient(100deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.5) 50%,rgba(255,255,255,0) 100%)',
          transform: 'skewX(-16deg)', pointerEvents: 'none', opacity: partial ? 0.35 : 1,
          animation: (phase === 'out' || count > 40) ? 'none' : 'goldSheen 1.15s ease-out both',
          animationDelay: (fillDelay + fillMs) + 'ms',
        },
      }),
      R('div', {
        key: 'ridge',
        style: (function () {
          const teeth = Math.max(20, Math.min(46, Math.round(D * 0.62)));
          const a = 180 / teeth;
          const mask = 'radial-gradient(circle at 50% 50%, transparent 0 ' + (partial ? 84 : 79) + '%, #000 ' + (partial ? 86 : 82) + '%, #000 100%)';
          return {
            position: 'absolute', inset: 0, borderRadius: '50%', pointerEvents: 'none',
            background: 'repeating-conic-gradient(from 0deg, rgba(255,240,200,.62) 0deg ' + a + 'deg, rgba(112,60,4,.5) ' + a + 'deg ' + (a * 2) + 'deg)',
            WebkitMaskImage: mask, maskImage: mask, opacity: partial ? 0.4 : 0.85,
            mixBlendMode: 'overlay',
          };
        })(),
      }),
      R('div', { key: 'gr', style: { position: 'absolute', inset: 0 } }, grains),
      R('div', {
        key: 'gl',
        style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: partial ? 0.5 : 0.62 },
      }, R('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: Math.max(1, Math.round(D * 0.03)),
          fontSize: Math.max(6, Math.round(D * (((label || '10K').length >= 4) ? 0.21 : (label || '10K').length === 3 ? 0.25 : 0.3))),
          fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1,
          color: partial ? 'rgba(var(--ink-rgb),.85)' : (tint && tint.ink) || '#5C3208', fontFamily: 'Figtree,system-ui,sans-serif',
        },
      }, [R('span', { key: 'btc', style: { fontWeight: 700 } }, '\u20BF'), R('span', { key: 'v' }, label || '10K')])),
    ]);
  }

  // 10 coins (100k sats) pile up like poker chips; piles then tile the space
  // the whole payout must land inside 5s no matter how many pieces there are
  step(total, base, budget) {
    return Math.min(base, (budget || 4400) / Math.max((total || 1) - 1, 1));
  }

  // the stack sizes itself to whatever height the container actually has, so coins never clip
  fitStack(build) {
    const R = React.createElement;
    if (!this._FitStack) {
      this._FitStack = function (props) {
        const ref = React.useRef(null);
        const [h, setH] = React.useState(0);
        React.useEffect(() => {
          const el = ref.current;
          if (!el) return;
          const read = () => setH(el.clientHeight);
          read();
          if (typeof ResizeObserver === 'undefined') return;
          const ro = new ResizeObserver(read);
          ro.observe(el);
          return () => ro.disconnect();
        }, []);
        return R('div', { ref: ref, style: { width: '100%', height: '100%' } }, h > 20 ? props.build(h - 2) : null);
      };
    }
    return R(this._FitStack, { build: build });
  }

  satsStack(sats, phase, avail) {
    const R = React.createElement;
    phase = phase || 'in';
    const AW = 322, AH = avail || 452, G = 10;
    const SAND = 'linear-gradient(150deg,#FFE9A8 0%,#F7C24E 26%,#E19420 62%,#B96B0D 100%)';
    // rims alternate black/white by denomination rank so adjacent tiers read apart at a glance
    const DENOMS = [
      { v: 100000000, l: '100M', s: 1, sand: SAND, rim: '#0B0B0B', ink: '#0B0B0B' },
      { v: 10000000, l: '10M', s: 0.94, sand: SAND, rim: '#0B0B0B', ink: '#0B0B0B' },
      { v: 1000000, l: '1M', s: 0.88, sand: SAND, rim: '#0B0B0B', ink: '#0B0B0B' },
      { v: 100000, l: '100K', s: 0.8, sand: SAND, rim: '#0B0B0B', ink: '#0B0B0B' },
      { v: 10000, l: '10K', s: 0.72, sand: SAND, rim: '#0B0B0B', ink: '#0B0B0B' },
      { v: 5000, l: '5K', s: 0.64, sand: SAND, rim: '#0B0B0B', ink: '#0B0B0B' },
      { v: 1000, l: '1K', s: 0.56, sand: SAND, rim: '#0B0B0B', ink: '#0B0B0B' },
    ];
    // greedy denomination break-down; anything under 1K rides on a partial 1K coin
    let rest = Math.max(0, Math.round(sats));
    const groups = [];
    DENOMS.forEach(d => {
      const k = Math.floor(rest / d.v);
      rest -= k * d.v;
      if (k > 0) groups.push({ d: d, n: k });
    });
    const partialFill = rest > 0 ? +(rest / 1000 * 100).toFixed(1) : null;
    const nCoins = groups.reduce((a, g) => a + g.n, 0) + (partialFill != null ? 1 : 0);
    if (!nCoins) return null;
    // each denomination fans out left to right, the way loose change does
    const lift = 0.62;
    const measure = base => {
      const lanes = [];
      groups.forEach(g => {
        const dia = Math.max(12, Math.round(base * g.d.s));
        const st = Math.max(4, Math.round(dia * lift));
        const maxN = Math.max(1, Math.floor((AW - dia) / st) + 1);
        // split an overflowing denomination into even lanes (8 → 4+4, never 6+2)
        const laneCount = Math.ceil(g.n / maxN);
        let left = g.n;
        for (let i = 0; i < laneCount; i++) {
          const n = Math.ceil(left / (laneCount - i));
          lanes.push({ d: g.d, n: n, dia: dia, st: st, w: dia + st * (n - 1) });
          left -= n;
        }
      });
      if (partialFill != null) {
        const pd = DENOMS[DENOMS.length - 1];
        const dia = Math.max(12, Math.round(base * pd.s));
        lanes.push({ d: pd, n: 1, dia: dia, st: 0, w: dia, partial: true });
      }
      // best-fit packing so small tiers tuck in beside big ones instead of stranding a row
      const rows = [];
      lanes.forEach(l => {
        /** @type {{ w: number, h: number, lanes: any[] } | null} */
        let best = null;
        let bestLeft = Infinity;
        rows.forEach(r => {
          const leftOver = AW - (r.w + G + l.w);
          if (leftOver >= 0 && leftOver < bestLeft) { best = r; bestLeft = leftOver; }
        });
        if (!best) { rows.push({ w: l.w, h: l.dia, lanes: [l] }); return; }
        best.w += G + l.w; best.h = Math.max(best.h, l.dia); best.lanes.push(l);
      });
      return { rows: rows, total: rows.reduce((a, r) => a + r.h, 0) + Math.max(rows.length - 1, 0) * G };
    };
    let m = measure(30);
    for (let b = 116; b >= 16; b -= 2) { m = measure(b); if (m.total <= AH) break; }
    let seq = 0;
    const rowEls = m.rows.map((row, ri) => R('div', {
      key: 'srow' + ri,
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: G, flex: 'none', height: row.h },
    }, row.lanes.map((l, li) => {
      const coins = [];
      for (let k = 0; k < l.n; k++) {
        coins.push(R('div', {
          key: 'sl' + k,
          style: { position: 'absolute', left: k * l.st, top: 0, zIndex: k },
        }, this.satCoinEl(seq, phase, l.partial ? partialFill : null, nCoins, l.dia, l.d.l, l.d)));
        seq++;
      }
      return R('div', {
        key: 'lane' + ri + '-' + li,
        style: { position: 'relative', flex: 'none', width: l.w, height: l.dia },
      }, coins);
    })));
    return R('div', {
      style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: G },
    }, rowEls);
  }

  syncAccent() {
    const a = ACC_OF(this.state.accent);
    const r = document.documentElement.style;
    r.setProperty('--acc', a.acc);
    r.setProperty('--acc-lt', a.lt);
    r.setProperty('--acc-dk', a.dk);
    r.setProperty('--acc-rgb', a.rgb);
    this.syncStatusBar();
  }

  // the device's own status bar is painted by iOS, not us — these metas are the only lever.
  // 'default' gives black glyphs (light mode); 'black-translucent' gives white (dark mode).
  syncStatusBar() {
    const light = (this.props.startTheme || this.state.theme) === 'light';
    const want = light ? 'default' : 'black-translucent';
    const bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (bar && bar.getAttribute('content') !== want) bar.setAttribute('content', want);
    const tc = document.querySelector('meta[name="theme-color"]');
    const col = light ? '#FAFAF8' : '#050505';
    if (tc && tc.getAttribute('content') !== col) tc.setAttribute('content', col);
  }
