
  /* switchMint: the mint list. */
  /** @param {RenderContext} c */
  renderMints(c) {
    const { s, sc } = c;
    return {
      isSwitchMint: sc === 'switchMint',
      // adding a mint belongs to switching, not to picking one to move between
      mintPickers: !s.trStep && !s.fcPick,
      /* The same list does three jobs: switching, and the two steps of a
       * transfer between your own mints. */
      /* And a fourth, for a card: which mint it moves to (26f-flashcard.js).
       * `fcPick` says so, and like trStep it is named by whoever opens the
       * list and cleared by every other way in. */
      mintTitle: s.fcPick ? 'TO WHICH MINT?'
        : s.trStep === 'from' ? 'FROM WHICH MINT?'
        : s.trStep === 'to' ? 'TO WHICH MINT?' : 'SWITCH MINT',
      mintNowLine: s.fcPick ? 'This card is at ' + this.mintNameOf(s.fc && s.fc.mint) + '.'
        : s.trStep === 'from' ? 'Move money between the mints you use.'
        : s.trStep === 'to' ? 'Moving from ' + this.mintNameOf(s.trFrom) + '.'
        : 'Connected to ' + (this.mintHost() || 'no mint')
        // balances in other units, which no sat figure on this screen includes
        + (this.otherUnitsLine() ? '. ' + this.otherUnitsLine() : ''),
      /* The mint you are on comes first and looks different. It used to be
       * filtered out, which left the screen showing every mint except the one
       * that matters. */
      mintRows: (() => {
        const all = this.allMints();
        const row = (m, here) => {
          const pile = this.mintPile(m.url);
          const busy = s.mintBusy === m.url.replace(/\/+$/, '');
          // "not answering since 10:42", once the wallet counts it down (11-mint-risk.js)
          const downText = this.mintDownText(m.url);
          /* Working offline, a mint whose keysets are not on this phone cannot
           * be connected to. Greyed out, with the reason under its name, and a
           * tap says it rather than doing nothing. */
          const reach = this.mintReachable(m.url);
          return {
            name: m.name, host: m.host,
            dim: reach ? '1' : '0.4',
            down: !!downText, downText: downText,
            initial: m.name.slice(0, 1).toUpperCase(),
            tint: m.tint,
            logo: m.logo ? "url('" + m.logo + "')" : 'none',
            here: here, notHere: !here,
            text: busy ? 'CONNECTING\u2026' : pile.text,
            ink: (here || busy) ? 'var(--acc-ink)' : pile.ink,
            busy: busy,
            bg: here ? 'rgba(var(--acc-rgb),.12)' : 'var(--surface)',
            border: here ? 'rgba(var(--acc-rgb),.75)' : 'rgba(var(--ink-rgb),.12)',
            // tapping the one you are already on should do nothing at all
            tap: !reach ? (() => this.offlineNo('Switching to ' + m.name))
              : s.fcPick ? (() => this.fcSwitchPick(m.url))
              : s.trStep ? (() => this.trPick(m.url)) : here ? (() => {}) : (() => this.justSwitch(m.url)),
          };
        };
        if (s.fcPick) {
          // every mint but the one the card is at
          const at = String((s.fc && s.fc.mint) || '').replace(/\/+$/, '');
          return all.filter(m => m.url.replace(/\/+$/, '') !== at).map(m => row(m, false));
        }
        if (s.trStep === 'from') {
          // only mints with something at them can be moved from
          return all.filter(m => this.mintPile(m.url).sats > 0).map(m => row(m, false));
        }
        if (s.trStep === 'to') {
          const from = String(s.trFrom || '').replace(/\/+$/, '');
          return all.filter(m => m.url.replace(/\/+$/, '') !== from).map(m => row(m, false));
        }
        return all.filter(m => this.onMint(m.url)).map(m => row(m, true))
          .concat(all.filter(m => !this.onMint(m.url)).map(m => row(m, false)));
      })(),
      scanOtherMint: () => this.scanOtherMint(),
      typeOtherMint: () => this.typeMint(),
    };
  }

  /* newMint: a token from a mint this wallet has no balance at. */
  /** @param {RenderContext} c */
  renderNewMint(c) {
    const { s, sc } = c;
    const keepName = s.nmInfo ? this.mintNameOf(s.nmInfo.mint) : '';
    return {
      isNewMint: sc === 'newMint',
      nmSats: s.nmInfo ? (this.nmUnit() ? this.unitMoney(s.nmInfo.amount, s.nmInfo.unit) : this.group(s.nmInfo.sats) + ' sats') : '\u2014',
      nmHost: s.nmInfo ? String(s.nmInfo.mint).replace(/^https?:\/\//, '') : '',
      // a range, because the reserve and the margin usually come back
      nmFee: s.nmPlan
        ? (s.nmPlan.feeMin === s.nmPlan.feeMax
            ? this.group(s.nmPlan.feeMax) + ' sats'
            : 'between ' + this.group(s.nmPlan.feeMin) + ' \u2013 '
              + this.group(s.nmPlan.feeMax) + ' sats')
        : '\u2014',
      // the floor: the quote reserves for the worst case, and change comes back
      nmNetBig: this.nmUnit() ? this.unitMoney(s.nmInfo.amount, s.nmInfo.unit) : s.nmPlan ? 'at least ' + this.group(s.nmPlan.net) + ' sats' : '\u2014',
      // dollars under every figure, always — sats alone mean little to most
      nmSatsUsd: s.nmInfo ? (this.nmUnit() ? this.unitLabel(s.nmInfo.unit) + ' ecash' : '$ ' + this.usd(s.nmInfo.sats * this.satUsd())) : '\u2014',
      nmFeeUsd: s.nmPlan
        ? (s.nmPlan.feeMin === s.nmPlan.feeMax
            ? '$ ' + this.usd(s.nmPlan.feeMax * this.satUsd())
            : '$ ' + this.usd(s.nmPlan.feeMin * this.satUsd()) + ' \u2013 $'
              + this.usd(s.nmPlan.feeMax * this.satUsd()))
        : '\u2014',
      nmNetUsd: this.nmUnit() ? 'kept at that mint' : s.nmPlan ? '$ ' + this.usd(s.nmPlan.net * this.satUsd()) : '\u2014',
      // an error, a step or another unit's note; nothing otherwise
      nmNote: s.nmErr || s.nmStage || this.nmUnitNote() || '',
      nmNoteInk: s.nmErr ? '#FF5C5C' : 'rgba(var(--ink-rgb),.55)',
      nmRedeemCta: s.nmBusy ? 'WORKING\u2026'
        : s.nmTooSmall ? 'KEEP IT AT ' + keepName.toUpperCase()
        : (s.nmPlan || this.nmUnit()) ? 'REDEEM'
        : s.nmErr ? 'RETRY'
        : 'WAITING FOR THE FEE\u2026',
      // live when there is a plan to act on, and again when there is an error
      // to retry — dead only while it is actually waiting
      // a quieter way to keep a token of sats at its own mint, asked for, never assumed
      nmKeepShow: !!s.nmInfo && !this.nmUnit() && !s.nmTooSmall && !s.nmBusy,
      nmKeepLabel: 'Keep it at ' + keepName,
      nmKeep: () => this.newMintKeep(),
      nmGoBg: ((!!s.nmPlan || !!s.nmErr || this.nmUnit()) && !s.nmBusy)
        ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      nmGoImg: ((!!s.nmPlan || !!s.nmErr || this.nmUnit()) && !s.nmBusy)
        ? "radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),rgba(255,240,220,0) 62%),"
          + "linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,"
          + "rgba(194,74,27,.78)),url('foxy-fur.webp')"
        : 'none',
      nmGoInk: ((!!s.nmPlan || !!s.nmErr || this.nmUnit()) && !s.nmBusy) ? '#fff' : 'rgba(var(--ink-rgb),.4)',
      nmGoCur: ((!!s.nmPlan || !!s.nmErr || this.nmUnit()) && !s.nmBusy) ? 'pointer' : 'default',
      nmRedeem: () => ((this.nmUnit() || this.state.nmTooSmall) ? this.newMintKeep()
        : this.state.nmPlan ? this.newMintRedeem() : this.nmQuote()),
      nmReject: () => this.setState({ screen: 'home', stack: [], nmInfo: null, nmPlan: null, nmErr: '', nmTooSmall: false }),
    };
  }

  /* importSeed and rsConfirm: the twelve-word restore and what it found. */
  /** @param {RenderContext} c */
  renderRestore(c) {
    const { s, sc } = c;
    /* The twelve words are typed on the phone's own screen: no cells here,
     * and the button asks the phone for them, so it is always ready. */
    const ready = true;
    return {
      isImportSeed: sc === 'importSeed',
      /* Paste proofs back in.
       *
       * The seed covers the normal case. This is for when it does not: a mint
       * that refuses deterministic restore, a lost counter, proofs saved out
       * of a wallet that is now gone. importProofs takes either a cashuB
       * token or a raw proofs array, and reconcile drops anything already
       * spent — so a stale paste is safe, it just recovers less. */
      goImportSeed: () => this.setState(p => ({
        screen: 'importSeed', stack: p.stack.concat([p.screen]),
        rsRows: [], rsErr: '', rsBusy: false, rsKept: '',
      })),
      rsScan: () => this.runSeedScan(false),
      rsRetry: () => this.runSeedScan(true),
      rsSubtitle: 'Type the twelve words from your other wallet on the phone\u2019s own screen, then tap a mint.',
      rsScanCta: s.rsBusy ? 'LOOKING\u2026' : 'ENTER YOUR 12 WORDS',
      rsScanBg: ready ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      rsScanImg: ready
        ? "radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),rgba(255,240,220,0) 62%),"
          + "linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,"
          + "rgba(194,74,27,.78)),url('foxy-fur.webp')"
        : 'none',
      rsScanInk: ready ? '#fff' : 'rgba(var(--ink-rgb),.4)',
      rsScanCur: ready ? 'pointer' : 'default',
      rsScanSh: ready
        ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),'
          + '0 12px 24px rgba(var(--acc-rgb),.34)'
        : 'none',
      rsIdle: !s.rsBusy && !(s.rsRows || []).length,
      rsLooking: !!s.rsBusy,
      rsDone: !s.rsBusy && (s.rsRows || []).some(r => r.state === 'done'),
      // A mint holding something is the orange button; one that answered with
      // nothing is still selectable, just quiet about it.
      rsRows: (s.rsRows || []).map(r => {
        const live = r.state === 'done' && (r.sats > 0 || this.rowUnits(r).length > 0);
        const done = r.state === 'done';
        return {
          host: r.host,
          line: r.state === 'looking' ? '\u2026'
            : r.state === 'failed' ? 'no answer'
            : r.partial ? (live ? this.rowAmounts(r) + ' so far' : 'incomplete')
            : live ? this.rowAmounts(r) : 'nothing',
          bg: live
            ? 'linear-gradient(168deg,rgba(247,154,60,.92),rgba(232,98,42,.94) 48%,'
              + 'rgba(194,74,27,.96))'
            : 'var(--surface)',
          border: live ? 'rgba(255,255,255,.22)'
            : r.state === 'failed' ? 'rgba(255,92,92,.4)' : 'rgba(var(--ink-rgb),.12)',
          ink: live ? '#fff'
            : r.state === 'failed' ? '#FF5C5C' : 'rgba(var(--ink-rgb),.5)',
          sh: live ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -3px 0 rgba(0,0,0,.16),'
                     + '0 8px 18px rgba(var(--acc-rgb),.3)' : 'none',
          cursor: done ? 'pointer' : 'default',
          tap: () => this.pickRestoreMint(r),
        };
      }),
      isRsConfirm: sc === 'rsConfirm',
      rsPickHost: (s.rsPick && s.rsPick.host) || '',
      rsPickSats: s.rsPick ? (this.rowUnits(s.rsPick).length ? this.rowAmounts(s.rsPick) : this.group(s.rsPick.sats) + ' sats') : '\u2014',
      rsPickErr: s.rsPickErr || '',
      rsConfirmCta: s.rsBusy2 ? 'WORKING\u2026' : 'REPLACE AND RESTORE',
      rsConfirmGo: () => this.adoptRestoreMint(),
      rsConfirmCancel: () => this.setState({ screen: 'importSeed', rsPick: null, rsPickErr: '' }),
      rsShowSeedFirst: () => this.showSeed(),
      rsCanRetry: !s.rsBusy && (s.rsRows || []).some(r => r.state === 'failed' || r.partial),
      rsNote: s.rsErr || s.rsKept || '',
      rsNoteInk: s.rsErr ? '#FF5C5C' : 'rgba(var(--ink-rgb),.55)',
    };
  }

  /* bkStart, and the sheet that asks for a backup. The words themselves and
   * their quiz are the phone's screens, opened by showSeed. */
  /** @param {RenderContext} c */
  renderBackup(c) {
    const { s, sc } = c;
    return {
      // the sheet, raised the first time a payment lands
      bkAskOpen: !!s.bkAskOpen,
      // not now, and not again for a day (`backupAskedLately`)
      bkAskLater: () => this.setState({ bkAskOpen: false, bkAsk: false }),
      // The seed screen is an overlay, not a template screen: bkStart renders
      // blank, which is why this went nowhere. Close the card and open it.
      bkAskNow: () => { this.setState({ bkAskOpen: false, bkAsk: false }); this.showSeed(); },
      // ---- recovery phrase flow ----
      isBkStart: sc === 'bkStart',
      /* bkStart's button: the phone's own screen for the words, and its quiz.
       * The page's word grid and quiz are gone; the page never has the words. */
      goBkPhrase: () => this.showSeed(),
    };
  }
}
