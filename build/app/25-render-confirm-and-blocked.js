
  /* depConfirm, sendConfirm: one shell, filled in by confirmSpec(). */
  /** @param {RenderContext} c */
  renderConfirmShell(c) {
    const { s, sc } = c;
    const cf = CONFIRM_SCREENS.indexOf(sc) >= 0 ? this.confirmSpec() : {};
    return {
      // ---- CONFIRM shell: title, amount, rows, cta. One block renders them all ----
      isConfirmShell: CONFIRM_SCREENS.indexOf(sc) >= 0,
      cfTitle: cf.title || '',
      cfTitleInk: cf.titleInk || 'var(--ink)',
      /* The title between the round buttons, level with them (CONFIRM PAYMENT
       * at a mint with two balances), or under them as everywhere else. */
      cfTitleUp: !!cf.titleUp,
      cfTitleDown: !cf.titleUp,
      // the WALLET button, last under the rows: which balance pays, and the way to change it
      cfWalletShown: !!cf.wallet,
      cfWalletWord: (cf.wallet || {}).word || '',
      cfWalletGo: (cf.wallet || {}).go || (() => {}),
      cfSubtitle: cf.subtitle || '',
      cfSubShown: cf.subtitle ? '1' : '0',
      /* The four digits the two people compare, above the amount and the same
       * size as it, matching where the receiver's screen shows them. Only for
       * the payment that actually came over the tap — `recipient` being the
       * very invoice that crossed the link is what says so. */
      /* Or any confirmation that names the code itself (`code`): on every
       * confirmation with four digits they are the first section, DELIVERED
       * TO, above the amount. */
      cfCodeUp: !!cf.code || !!(s.tapCode && s.tapInvoice && s.recipient === s.tapInvoice),
      cfCode: cf.code || s.tapCode || '',
      cfAmountLabel: cf.amountLabel || '',
      cfAmount: cf.amount || '',
      cfAmountInk: cf.amountInk || 'var(--acc)',
      cfAmountSub: cf.amountSub || '',
      cfAmountSubShown: !!cf.amountSub,
      cfRows: cf.rows || [],
      cfChipBg: cf.warn ? 'rgba(255,92,92,.14)' : 'rgba(var(--acc-rgb),.12)',
      cfChipInk: cf.warn ? '#FF5C5C' : 'var(--acc-ink)',
      // a check when things are fine, a bar and a dot when they are not
      cfChipIcon: cf.warn ? 'M12 6.6v7.4M12 17.4v.3' : 'M4.5 12.5 10 18 19.5 7',
      // the mint-origin line was removed; the element remains for cf.warn
      cfChip: cf.warn || cf.chip || '',
      // the origin line is a chip too, so it has to open the same gate
      cfChipShown: !!cf.warn || !!cf.chip,
      // the top-right X: the way out of a screen whose second button is a note
      cfCloseShown: !!cf.close,
      cfClose: cf.close || (() => {}),
      cfCloseHidden: !cf.close,
      cfSecondaryShown: !!cf.secondary,
      cfSecondaryLabel: (cf.secondary || {}).label || '',
      cfSecondary: (cf.secondary || {}).go || (() => {}),
      cfSecBg: 'var(--surface)',
      cfSecInk: 'var(--ink)',
      cfSecBorder: (cf.secondary || {}).filled ? '1.5px solid rgba(var(--acc-rgb),.7)' : '1.5px solid rgba(var(--ink-rgb),.16)',
      cfSecSh: 'inset 0 2px 0 rgba(255,255,255,.14),inset 0 -3px 0 rgba(0,0,0,.16),0 9px 18px rgba(0,0,0,.26)',
      cfCtaLabel: cf.cta || '',
      // a quote being asked for, or a payment underway: the button says so
      cfCtaBusy: !!cf.ctaBusy,
      /* 'money' is the owner's green, whatever the accent: money moves when it
       * is pressed (SWAP, 26i-swap.js). */
      cfCtaBg: cf.ctaTone === 'warn' ? '#F7931A' : cf.ctaTone === 'money' ? '#3AB54A' : 'var(--acc)',
      cfCtaInk: cf.ctaTone === 'warn' ? '#2b1e05' : cf.ctaTone === 'money' ? '#0B1A0E' : CTA_INK(s),
      cfCtaGlow: cf.ctaTone === 'warn' ? 'rgba(247,147,26,.3)' : cf.ctaTone === 'money' ? 'rgba(58,181,74,.32)' : 'rgba(var(--acc-rgb),.32)',
      cfGo: cf.go || (() => {}),
    };
  }

  /* The BLOCKED screens: an action that did not happen, and why. */
  /** @param {RenderContext} c */
  renderBlocked(c) {
    const { sc } = c;
    return {
      // ---- send: a failure state that fires before money moves ----
      // every blocked or reversed action lands here — the chip is part of the template
      isBlocked: !!BLOCKED[sc],
      blockedTitle: (BLOCKED[sc] || {}).title,
      blockedReason: (BLOCKED[sc] || {}).reason,
      blockedChip: (BLOCKED[sc] || {}).chip,
      blockedRetryLabel: (BLOCKED[sc] || {}).retry,
      blockedAmount: (BLOCKED[sc] || {}).showAmount ? this.sendAmountText() : '',
      blockedIsFail: (BLOCKED[sc] || {}).tone !== 'warn',
      blockedIsWarn: (BLOCKED[sc] || {}).tone === 'warn',
      blockedInk: (BLOCKED[sc] || {}).tone === 'warn' ? 'var(--btc-ink)' : '#FF5C5C',
      blockedGlyphBg: (BLOCKED[sc] || {}).tone === 'warn' ? 'rgba(247,147,26,.16)' : 'rgba(255,92,92,.14)',
      blockedRetry: () => this.setState({ screen: (BLOCKED[sc] || {}).back || 'amount' }),
      blockedClose: () => this.setState({ screen: 'home', stack: [], amount: '', asset: '', flow: 'receive', unit: 'USD' }),
    };
  }

  /* CURRENCY, WALLET, and the last step of setting up: the screens that say
   * which of two balances, at a mint that issues dollars and bitcoin.
   *
   *   currency    "What do you want to receive?" (or send): two big cards with
   *               what each balance holds. Asked once for each kind of flow.
   *   walletPick  "Pay $ 10.00 from": the same cards from CONFIRM PAYMENT's
   *               WALLET button, a balance that cannot cover it greyed and
   *               saying so.
   *   holdChoice  "WHAT DO YOU WANT TO HOLD?": Dollars, Bitcoin or Both, once,
   *               after every other first step.
   *
   * Frost is dollars, fur is bitcoin, slate is both: the home's own pills. */
  /** @param {RenderContext} c */
  renderCurrency(c) {
    const { s, sc } = c;
    const pick = sc === 'walletPick';
    const SHADOW = 'inset 0 2px 0 rgba(255,255,255,.35),inset 0 -4px 0 rgba(0,0,0,.18),0 10px 24px rgba(0,0,0,.3)';
    const LOOK = {
      usd: { bg: 'radial-gradient(circle at 18% 30%,rgba(255,255,255,.07) 0 1.2px,transparent 1.2px),'
        + 'radial-gradient(circle at 62% 70%,rgba(255,255,255,.06) 0 1.2px,transparent 1.2px),linear-gradient(160deg,#D6EEF7,#B9DCEA)',
        ink: '#10161B', inkRgb: '16,22,27', blend: 'normal', edge: 'rgba(255,255,255,.22)', badgeBg: '#FFFFFF', badgeInk: '#10161B', sym: '$' },
      sat: { bg: "linear-gradient(160deg,rgba(255,255,255,.18) 0%,rgba(255,255,255,0) 45%,rgba(0,0,0,.22) 100%),"
        + "url('foxy-fur.webp') center/150% auto no-repeat,linear-gradient(160deg,#F2742B,#D9561A)",
        ink: '#FFFFFF', inkRgb: '255,255,255', blend: 'normal,soft-light,normal', edge: 'rgba(255,255,255,.22)', badgeBg: '#FFF6EE', badgeInk: '#E8622A', sym: '₿' },
      grey: { bg: 'linear-gradient(160deg,#2A3034,#1C2124)', ink: 'rgba(255,255,255,.55)', inkRgb: '255,255,255',
        blend: 'normal', edge: 'rgba(255,255,255,.1)', badgeBg: 'rgba(255,255,255,.14)', badgeInk: 'rgba(255,255,255,.55)' },
    };
    const flow = s.currencyFlow === 'receive' ? 'receive' : 'send';
    const current = pick ? (this.walletNow('send') || 'sat') : '';
    const off = this.offlineNow();
    // on WALLET, a balance that cannot cover this payment is greyed, and says so
    const whyNot = (u) => {
      if (!pick) return '';
      if (off && u !== current) return 'NEEDS A CONNECTION';
      return this.quoteFits(u) === false ? 'NOT ENOUGH FOR ' + this.sendAmountText() : '';
    };
    const balanceText = (u) => {
      const n = this.unitBalance(u);
      if (u === 'usd') return this.unitFigure(n, 'usd');
      // bitcoin's dollar worth beside it, where there is a price, on the WALLET picker
      return this.unitFigure(n, 'sat') + (pick && this.satUsd() ? ' · $ ' + this.usd(n * this.satUsd()) : '');
    };
    const cards = (sc === 'currency' || pick) ? ['usd', 'sat'].map(u => {
      const tag = whyNot(u);
      const look = Object.assign({}, LOOK[u], tag ? LOOK.grey : {});
      const chosen = pick && u === current && !tag;
      return Object.assign(look, {
        sym: LOOK[u].sym,
        name: this.unitWord(u),
        balance: balanceText(u),
        tag: tag, tagShown: !!tag,
        shadow: tag ? 'none' : SHADOW,
        outline: chosen ? '3px solid rgba(255,255,255,.9)' : 'none',
        cursor: tag ? 'default' : 'pointer',
        tap: () => (pick ? this.walletPickChoose(u, tag ? (tag === 'NEEDS A CONNECTION'
          ? 'Your ' + this.unitWord(u).toLowerCase() + ' need a connection to pay this.'
          : 'Your ' + this.unitWord(u).toLowerCase() + ' cannot cover this payment.') : '') : this.currencyPick(u)),
      });
    }) : [];
    const neither = pick && this.quoteFits('usd') === false && this.quoteFits('sat') === false;
    const holding = s.holdPick || '';
    const HOLD = [
      { key: 'dollars', name: 'DOLLARS', sub: 'Steady. For spending.', look: LOOK.usd },
      { key: 'bitcoin', name: 'BITCOIN', sub: 'For saving.', look: LOOK.sat },
      { key: 'both', name: 'BOTH', sub: 'Two balances, one wallet.',
        look: { bg: 'linear-gradient(160deg,var(--slate-a),var(--slate-b))', ink: '#FFFFFF', inkRgb: '255,255,255',
          blend: 'normal', edge: 'var(--slate-edge)', sym: '$ ₿' } },
    ];
    const FUR_CTA = "radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),rgba(255,240,220,0) 62%),"
      + "linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,rgba(194,74,27,.78)),url('foxy-fur.webp')";
    return {
      isCurrency: sc === 'currency' || pick,
      curTitle: pick ? 'WALLET' : 'CURRENCY',
      curQuestion: pick ? 'Pay ' + this.sendAmountText() + ' from'
        : flow === 'receive' ? 'What do you want to receive?' : 'What do you want to send?',
      curCards: cards,
      curFoot: pick
        ? (neither ? 'Neither balance covers this. You hold ' + this.unitFigure(this.unitBalance('usd'), 'usd')
            + ' and ' + this.unitFigure(this.unitBalance('sat'), 'sat') + '.'
          : s.walletAuto ? this.unitWord(current).charAt(0) + this.unitWord(current).slice(1).toLowerCase()
            + ' was chosen for you: your ' + this.unitWord(current === 'usd' ? 'sat' : 'usd').toLowerCase()
            + ' cannot cover this one.'
          : 'The one you pick is remembered for your next payment.')
        : flow === 'receive' ? 'Asked once. After this, change it with the WALLET button on the invoice.'
        : 'Asked once. After this, change it with the WALLET button before you pay.',
      curBack: () => this.back(),
      curClose: () => this.setState({ screen: 'home', stack: [] }),
      isHoldChoice: sc === 'holdChoice',
      holdSub: 'Your mint keeps both. You can change this any time from the menu.',
      holdRows: HOLD.map(h => Object.assign({}, h.look, {
        name: h.name, sub: h.sub,
        outline: holding === h.key ? '3px solid rgba(255,255,255,.9)' : 'none',
        tap: () => this.setState({ holdPick: h.key }),
      })),
      holdBack: () => this.holdLater(),
      holdDone: () => this.holdDone(),
      holdDoneBg: holding ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      holdDoneFur: holding ? FUR_CTA : 'none,none,none',
      holdDoneInk: holding ? '#fff' : 'rgba(var(--ink-rgb),.4)',
      holdDoneSh: holding ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(var(--acc-rgb),.34)' : 'none',
    };
  }
