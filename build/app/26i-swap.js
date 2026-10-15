  /* ---- SWAP: dollars into bitcoin, or bitcoin into dollars, at this mint ----
   *
   * Four screens, the way a payment goes:
   *
   *   swap         which way: the FROM pill over the TO pill, with a round ⇅
   *                on the seam that turns them round, and NEXT
   *   amount       SET AMOUNT with flow 'swap': "How much to swap?", typed in
   *                the FROM balance's own unit (cents, or sats), and ALL OF IT
   *   swapConfirm  the CONFIRM PAYMENT layout: TOTAL, then FROM, YOU GET, RATE
   *                with how long the mint holds it, FEE INCLUDED, and SWAP
   *   swapDone     SWAPPED: what left and what arrived, each in its own colour
   *
   * The wallet does the money (16b-two-balances.js): `swapQuote` asks the mint
   * for its rate (an invoice in the TO unit, and what paying it from the FROM
   * unit costs), and `swapRun` pays one with the other. Nothing moves until
   * SWAP. A quote lives a minute at most, so the confirmation counts down and
   * asks again when it runs out, and the button then reads CONFIRM NEW RATE so
   * a tap meant for the old rate is not taken for the new one.
   *
   * A swap the mint has not finished is not lost: the wallet holds what it
   * spent until the mint says, and finishes it on the next connection. The
   * card SWAP STILL GOING THROUGH says so, and home's held pill names the
   * amount until it is done.
   *
   * At a mint with one balance none of this is reachable: home has no SWAP
   * button and the menu no SWAP row. */

  /* How long before the mint's own expiry the rate stops being offered. The
   * wallet refuses to run a quote with under fifteen seconds left (the mint
   * has to answer two requests in that time), so the countdown on screen is
   * the time left to tap, not the time left on the mint's clock. */
  SWAP_MARGIN_MS = 15000;

  /* New rates asked for by themselves while the confirmation sits untouched.
   * After that it waits for a tap: a screen left open on a table must not ask
   * the mint for a rate every minute for ever. */
  SWAP_REQUOTES = 3;

  /* SWAP, from home's button or the menu's row (swapStart). Starts from the
   * balance that has something in it: dollars when both do, as drawn. */
  goSwap() {
    if (this.offlineNow()) { this.toast('Swapping needs the mint.', true); return; }
    if (!this.twoUnitsOn()) { this.toast('This mint issues only bitcoin, so there is nothing to swap with.', true); return; }
    const from = this.unitBalance('usd') > 0 || !(this.unitBalance('sat') > 0) ? 'usd' : 'sat';
    console.log('[foxy] swap: opened, from ' + this.unitWord(from).toLowerCase());
    this.setState(p => ({
      screen: 'swap', stack: p.stack.concat([p.screen]),
      swapFrom: from, swapTo: from === 'usd' ? 'sat' : 'usd',
      swapQuote: null, swapNewRate: false, swapAmount: 0, swapAll: false,
      swapErr: '', swapErrAmount: false, swapQuoting: false, swapBusy: false, swapResult: null,
      swapRequotes: 0, swapLapsed: false,
    }));
  }

  /* The ⇅ on the seam: the other way round. */
  swapFlip() {
    this.setState(p => ({ swapFrom: p.swapTo === 'sat' ? 'sat' : 'usd', swapTo: p.swapFrom === 'sat' ? 'sat' : 'usd' }));
  }

  /* The swap's two units, as they stand: never the same one. */
  swapUnits() {
    const from = this.state.swapFrom === 'sat' ? 'sat' : 'usd';
    return { from: from, to: from === 'usd' ? 'sat' : 'usd' };
  }

  /* NEXT on the swap screen: SET AMOUNT, typed in the balance that leaves. */
  swapToAmount() {
    if (this.offlineNow()) { this.toast('Swapping needs the mint.', true); return; }
    const { from } = this.swapUnits();
    if (!(this.unitBalance(from) > 0)) {
      this.toast('You have no ' + this.unitWord(from).toLowerCase() + ' to swap.', true);
      return;
    }
    this.setState(p => ({
      screen: 'amount', stack: p.stack.concat([p.screen]), flow: 'swap',
      unit: from === 'usd' ? 'USD' : 'SATS', amount: '', asset: '',
      note: '', noteDraft: '', recipient: '', recipientKind: '',
    }));
  }

  /* What is typed on SET AMOUNT for a swap, in the FROM unit: cents exactly
   * for dollars, sats for bitcoin. */
  swapTyped() {
    const { from } = this.swapUnits();
    if (from === 'usd') return this.centsTyped();
    const v = parseFloat(this.state.amount) || 0;
    return v > 0 ? Math.round(v) : 0;
  }

  /* NEXT on SET AMOUNT (or ALL OF IT): the confirmation, and the rate asked. */
  swapNext(all) {
    if (this.offlineNow()) { this.toast('Swapping needs the mint.', true); return; }
    const { from } = this.swapUnits();
    const have = this.unitBalance(from);
    const amount = all ? have : this.swapTyped();
    if (!(amount > 0)) { this.toast('Type an amount first.', true); return; }
    if (amount > have) {
      this.toast('That is more than your ' + this.unitWord(from).toLowerCase() + ': you hold '
        + this.unitFigure(have, from) + '.', true);
      return;
    }
    this.setState(p => ({
      screen: 'swapConfirm', stack: p.stack.concat([p.screen]),
      swapAmount: amount, swapAll: !!all, swapQuote: null, swapNewRate: false,
      swapErr: '', swapErrAmount: false, swapRequotes: 0, swapLapsed: false,
    }));
    // the amount handed over, not read back from state the same moment it was set
    this.swapAsk(false, amount, !!all);
  }

  /* The mint's rate for this swap. `again` is a rate asked for because the
   * last one ran out: the rows change under the person, so the button says
   * CONFIRM NEW RATE until it is pressed. Nothing moves by asking. */
  swapAsk(again, amountGiven, allGiven) {
    const W = window.FoxyWallet;
    const s = this.state;
    // a swap being run is not asked about again; a newer question replaces an older one (`run`)
    if (!W || !W.swapQuote || s.swapBusy || this._swapRun) return;
    const { from, to } = this.swapUnits();
    const amount = amountGiven != null ? amountGiven : (s.swapAmount || 0);
    const all = allGiven != null ? allGiven : !!s.swapAll;
    const run = (this._swapAskRun = (this._swapAskRun || 0) + 1);
    this.setState({ swapQuoting: true, swapErr: '', swapErrAmount: false, swapLapsed: false });
    W.swapQuote(from, to, amount, all ? { all: true } : {}).then(q => {
      // an answer for an older question is dropped; one for a screen that has gone only ends the wait
      if (run !== this._swapAskRun) return;
      if (this.state.screen !== 'swapConfirm') { this.setState({ swapQuoting: false }); return; }
      console.log('[foxy] swap: quoted ' + this.unitFigure(q.total, from) + ' for ' + this.unitFigure(q.get, to)
        + (again ? ' (a new rate)' : ''));
      this._swapQuotedAt = Date.now();
      this.setState({ swapQuoting: false, swapQuote: q, swapNewRate: !!again });
      this.swapClock();
    }).catch(e => {
      if (run !== this._swapAskRun) return;
      const why = W.reason ? W.reason(e) : String((e && e.message) || e);
      console.warn('[foxy] swap: no rate:', why);
      // an amount the mint will not swap is changed on the keypad; anything else is asked again
      const amountWrong = /too little|more than your|above zero/i.test(why);
      this.setState({ swapQuoting: false, swapQuote: null, swapErr: why, swapErrAmount: amountWrong });
    });
  }

  /* Seconds the rate on screen can still be taken, or 0. */
  swapLeft() {
    const q = this.state.swapQuote;
    if (!q || !(Number(q.expiresAt) > 0)) return 0;
    return Math.max(0, Math.floor((Number(q.expiresAt) - this.SWAP_MARGIN_MS - Date.now()) / 1000));
  }

  /* The countdown under RATE, ticking once a second while the confirmation is
   * up, and a new rate when it runs out. It stops by itself as soon as the
   * screen has gone: no clock outlives the screen it is for. */
  swapClock() {
    if (this._swapClockT) return;
    this._swapClockT = setInterval(() => {
      const s = this.state;
      if (s.screen !== 'swapConfirm') {
        clearInterval(this._swapClockT);
        this._swapClockT = null;
        return;
      }
      if (!s.swapQuote || s.swapQuoting || s.swapBusy) return;
      if (this.swapLeft() > 0) { this.setState({ swapTick: Date.now() }); return; }
      if ((s.swapRequotes || 0) >= this.SWAP_REQUOTES) {
        // left alone too long: wait for a tap rather than keep asking
        if (!s.swapLapsed) {
          console.log('[foxy] swap: the rate ran out with nobody looking; waiting for a tap');
          this.setState({ swapLapsed: true, swapQuote: null });
        }
        return;
      }
      console.log('[foxy] swap: the rate ran out, so a new one is asked for');
      this.setState({ swapRequotes: (s.swapRequotes || 0) + 1 });
      this.swapAsk(true);
    }, 1000);
  }

  /* SWAP (or CONFIRM NEW RATE): the swap, at the rate on screen. */
  swapGo() {
    const W = window.FoxyWallet;
    const s = this.state;
    const q = s.swapQuote;
    if (!q || s.swapBusy || s.swapQuoting || this._swapRun) return;
    if (this.offlineNow()) { this.toast('Swapping needs the mint.', true); return; }
    /* A new rate has only just replaced the old one: a tap in that moment was
     * meant for the old rate, so it is not taken for the new one. */
    if (s.swapNewRate && Date.now() - (this._swapQuotedAt || 0) < 1500) return;
    if (this.swapLeft() <= 0) { this.swapAsk(true); return; }
    // and the same question every payment asks: nothing else is moving money
    if (this.moneyBusy()) {
      this.toast('Something else is moving money right now. Try again in a moment.', true);
      return;
    }
    const { from, to } = this.swapUnits();
    // the balances before, for the count-up on home once the screen is dismissed
    this._preSettle = this.balNow();
    this.setState({ swapBusy: true, swapNewRate: false, swapErr: '', swapErrAmount: false });
    this.showMelt('Swapping ' + this.unitWord(from).toLowerCase() + ' into ' + this.unitWord(to).toLowerCase() + '…', 120000);
    console.log('[foxy] swap: running ' + this.unitFigure(q.total, from) + ' into ' + this.unitFigure(q.get, to));
    this._swapRun = W.swapRun(q, (stage) => console.log('[foxy] swap: ' + stage)).then(r => {
      this._swapRun = null;
      this.hideMelt();
      this.refreshBalance();
      this.loadHistory();
      if (r && r.state === 'done') {
        this.setState({ swapBusy: false, swapResult: r, screen: 'swapDone', stack: [] });
        return;
      }
      if (r && r.state === 'pending') { this.swapStillGoing(r); return; }
      // the mint would not take the payment: it is back in the balance, and nothing moved
      this._preSettle = null;
      this.setState({ swapBusy: false, swapQuote: null,
        swapErr: 'The mint did not make this swap. Nothing moved, and your ' + this.unitWord(from).toLowerCase()
          + ' are where they were.' });
    }).catch(e => {
      this._swapRun = null;
      this.hideMelt();
      this._preSettle = null;
      const why = W.reason ? W.reason(e) : String((e && e.message) || e);
      console.warn('[foxy] swap: did not run:', why);
      this.refreshBalance();
      if (e && e.expired) {
        // the rate ran out between the screen and the mint: a new one, said as one
        this.setState({ swapBusy: false, swapQuote: null });
        this.swapAsk(true);
        return;
      }
      if (e && e.offline) {
        this.setState({ swapBusy: false });
        this.toast('Swapping needs the mint.', true);
        return;
      }
      this.setState({ swapBusy: false, swapQuote: null, swapErr: why });
    });
  }

  /* One half paid and the other not answered yet: the card, and home, where
   * the held pill names what is with the mint until the wallet finishes it. */
  swapStillGoing(r) {
    const from = (r && r.from) || {};
    const fig = this.unitFigure(Number(from.amount) || 0, from.unit === 'sat' ? 'sat' : 'usd');
    this._preSettle = null;
    this.setState({ swapBusy: false, swapQuote: null, screen: 'home', stack: [] });
    this.blockedCard('swapPending', {
      tone: 'warn',
      title: 'SWAP STILL GOING THROUGH',
      reason: 'The mint has your ' + fig + ' and has not finished the swap yet. Foxy finishes it by itself '
        + 'the next time the mint answers.',
      chip: 'Nothing is lost. Your balance shows it as pending with the mint until then.',
    });
  }

  /* SWAPPED, dismissed: home, and both pills count to their new figures. */
  swapDoneClose() {
    this.setState({ screen: 'home', stack: [], swapResult: null, swapQuote: null });
    this.settleAnimate('both');
  }

  /* The wallet keeps a swap's rate as dollars per bitcoin; a row may carry it
   * as a number or as { usdPerBtc }. */
  swapRateOf(r) {
    const n = (r && typeof r === 'object') ? Number(r.usdPerBtc) : Number(r);
    return n > 0 ? n : 0;
  }

  /* "₿ 1 = $ 81,786", the way the rows say a rate. */
  swapRateText(n) { return '₿ 1 = $ ' + this.group(Math.round(n)); }

  /* "Forge's rate": whose rate it is, by the mint's own name. */
  swapRateWho() {
    const who = String(this.mintName() || 'the mint');
    return who + (/s$/i.test(who) ? '’' : '’s') + ' rate';
  }

  /* The ink a balance's figure is drawn in on a dark screen: frost for
   * dollars, fur for bitcoin. */
  swapInk(unit) { return unit === 'usd' ? '#D6EEF7' : '#F2742B'; }

  /* What a swap of what is typed would give, roughly, at the mint's last rate
   * (or the market's): the line under the keypad's figure. '' with no rate. */
  swapEstimate() {
    const W = window.FoxyWallet;
    const { from, to } = this.swapUnits();
    const n = this.swapTyped();
    if (!(n > 0)) return '';
    let rate = 0;
    try { rate = this.swapRateOf(W && W.mintRate ? W.mintRate() : null); } catch (e) { rate = 0; }
    if (!(rate > 0) && this.satUsd()) rate = this.satUsd() * 1e8;
    if (!(rate > 0)) return '';
    const got = from === 'usd' ? Math.floor(n / 100 / rate * 1e8) : Math.floor(n * rate / 1e8 * 100);
    return '≈ ' + this.unitFigure(got, to);
  }

  /* The confirmation's contents (confirmSpec): the owner's CONFIRM PAYMENT
   * layout with the swap's rows, and no NETWORK row, since a swap never
   * leaves the mint. */
  /** @returns {ConfirmSpec} */
  swapSpec() {
    const s = this.state;
    const { from, to } = this.swapUnits();
    const q = s.swapQuote;
    const fig = (n, u) => this.unitFigure(n, u);
    const base = {
      title: 'SWAP', titleUp: true, amountLabel: 'TOTAL', amountInk: 'var(--ink)',
      close: () => this.setState({ screen: 'home', stack: [] }),
    };
    if (!q) {
      const typed = fig(s.swapAmount || 0, from);
      const rows = [
        this.cfRow('FROM ' + this.unitWord(from), typed),
        this.cfRow('YOU GET', s.swapQuoting ? 'CHECKING…' : 'UNKNOWN', { ink: this.swapInk(to) }),
        this.cfRow('RATE', s.swapQuoting ? 'CHECKING…' : 'UNKNOWN'),
        this.cfRow('FEE INCLUDED', s.swapQuoting ? 'CHECKING…' : 'UNKNOWN'),
      ];
      if (s.swapQuoting) {
        return Object.assign(base, { amount: typed, rows: rows,
          cta: 'CHECKING THE RATE…', ctaBusy: true, ctaTone: 'go', go: () => {} });
      }
      if (s.swapLapsed) {
        return Object.assign(base, { amount: typed, rows: rows,
          chip: 'The rate ran out. Nothing moved.',
          cta: 'GET A NEW RATE', ctaTone: 'go',
          go: () => { this.setState({ swapRequotes: 0 }); this.swapAsk(true); } });
      }
      return Object.assign(base, { amount: typed, amountInk: '#FF5C5C', rows: rows,
        warn: s.swapErr || 'The mint has not given a rate yet.',
        cta: s.swapErrAmount ? 'CHANGE AMOUNT' : 'TRY AGAIN', ctaTone: 'warn',
        go: () => { if (s.swapErrAmount) this.back(); else this.swapAsk(false); } });
    }
    const rate = this.swapRateOf(q.rate);
    const left = this.swapLeft();
    const clock = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    const market = this.swapRateOf(q.market);
    const rows = [
      this.cfRow('FROM ' + this.unitWord(from), fig(q.amount, from)),
      this.cfRow('YOU GET', fig(q.get, to), { ink: this.swapInk(to) }),
      this.cfRow('RATE', rate > 0 ? this.swapRateText(rate) + ' · ' + this.swapRateWho() : this.swapRateWho(), {
        sub: 'Rate held for ' + clock,
        // far from the market price: the market's, in red, under the mint's
        sub2: (q.spreadWarn && market > 0) ? 'Market ' + this.swapRateText(market) : '',
        sub2Ink: '#FF5C5C',
      }),
      this.cfRow('FEE INCLUDED', fig(q.fee, from)),
    ];
    return Object.assign(base, {
      amount: fig(q.total, from),
      rows: rows,
      warn: s.swapErr || '',
      cta: s.swapBusy ? 'SWAPPING…' : s.swapNewRate ? 'CONFIRM NEW RATE' : 'SWAP',
      ctaBusy: !!s.swapBusy,
      // green, as PAY is drawn: money moves when it is pressed
      ctaTone: 'money',
      go: () => this.swapGo(),
    });
  }

  /* The SWAP screen and SWAPPED, for the template. */
  /** @param {RenderContext} c */
  renderSwap(c) {
    const { s, sc } = c;
    const LOOK = {
      usd: { bg: 'radial-gradient(circle at 18% 30%,rgba(255,255,255,.07) 0 1.2px,transparent 1.2px),'
        + 'radial-gradient(circle at 62% 70%,rgba(255,255,255,.06) 0 1.2px,transparent 1.2px),linear-gradient(160deg,#D6EEF7,#B9DCEA)',
        ink: '#10161B', inkRgb: '16,22,27', blend: 'normal', sym: '$' },
      sat: { bg: "linear-gradient(160deg,rgba(255,255,255,.18) 0%,rgba(255,255,255,0) 45%,rgba(0,0,0,.22) 100%),"
        + "url('foxy-fur.webp') center/150% auto no-repeat,linear-gradient(160deg,#F2742B,#D9561A)",
        ink: '#FFFFFF', inkRgb: '255,255,255', blend: 'normal,soft-light,normal', sym: '₿' },
    };
    const on = sc === 'swap' || sc === 'swapDone';
    const { from, to } = this.swapUnits();
    const pill = (label, u, text) => Object.assign({}, LOOK[u], {
      label: label, name: this.unitWord(u), text: text,
    });
    const rows = sc === 'swap' ? [
      pill('FROM', from, s.hidden ? '••••••' : this.unitFigure(this.unitBalance(from), from)),
      pill('TO', to, s.hidden ? '••••••' : this.unitFigure(this.unitBalance(to), to)),
    ] : [];
    const r = s.swapResult || null;
    const done = (sc === 'swapDone' && r) ? [
      pill('FROM', r.from && r.from.unit === 'sat' ? 'sat' : 'usd',
        '−' + this.unitFigure(Math.abs(Number(r.from && r.from.amount) || 0), r.from && r.from.unit === 'sat' ? 'sat' : 'usd')),
      pill('TO', r.to && r.to.unit === 'sat' ? 'sat' : 'usd',
        '+' + this.unitFigure(Math.abs(Number(r.to && r.to.amount) || 0), r.to && r.to.unit === 'sat' ? 'sat' : 'usd')),
    ] : [];
    const rate = r ? this.swapRateOf(r.rate) : 0;
    const feeUnit = r && r.from && r.from.unit === 'sat' ? 'sat' : 'usd';
    const FUR_CTA = "radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),rgba(255,240,220,0) 62%),"
      + "linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,rgba(194,74,27,.78)),url('foxy-fur.webp')";
    const canGo = sc === 'swap' && !this.offlineNow() && this.unitBalance(from) > 0;
    return {
      isSwap: sc === 'swap',
      swapRows: rows,
      swapFlipGo: () => this.swapFlip(),
      swapBackGo: () => this.back(),
      swapCloseGo: () => this.setState({ screen: 'home', stack: [] }),
      swapNextGo: () => this.swapToAmount(),
      swapFoot: !on ? '' : this.offlineNow() ? 'Swapping needs the mint.'
        : 'At ' + this.swapRateWho() + '. You see the rate and the fee before anything moves.',
      swapNextBg: canGo ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      swapNextFur: canGo ? FUR_CTA : 'none,none,none',
      swapNextInk: canGo ? '#fff' : 'rgba(var(--ink-rgb),.4)',
      swapNextSh: canGo ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(var(--acc-rgb),.34)' : 'none',
      isSwapDone: sc === 'swapDone',
      swapDoneRows: done,
      swapDoneNote: !r ? '' : 'Fee ' + this.unitFigure(Math.max(0, Number(r.fee) || 0), feeUnit)
        + (rate > 0 ? ' · ' + this.swapRateText(rate) : ''),
      swapDoneGo: () => this.swapDoneClose(),
    };
  }
