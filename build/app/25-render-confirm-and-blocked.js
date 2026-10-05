
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
      cfCtaBg: cf.ctaTone === 'warn' ? '#F7931A' : 'var(--acc)',
      cfCtaInk: cf.ctaTone === 'warn' ? '#2b1e05' : CTA_INK(s),
      cfCtaGlow: cf.ctaTone === 'warn' ? 'rgba(247,147,26,.3)' : 'rgba(var(--acc-rgb),.32)',
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
