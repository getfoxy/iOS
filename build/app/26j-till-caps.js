  /* ---- what this phone takes offline before it settles ---------------------
   *
   * The owner's till caps (2026-10-16): $50 from one payer, $300 held in all,
   * with a prompt at half of that. The wallet keeps and applies them
   * (07-request-delivery.js, `tillCaps`, `tillRefusal`); these are the screens'
   * half: two rows in SETTINGS, the amount typed on SET AMOUNT as every amount
   * is, and the notice on the receive screen. */

  /* The two SETTINGS rows, in the drawer's own row style: the figure in
   * dollars, sats under it. A tap opens SET AMOUNT for it. `path` is the
   * row's icon and `shut` the drawer's own closing (21-render-values.js). */
  tillCapRows(path, shut) {
    const W = window.FoxyWallet;
    let caps = null;
    try { caps = (W && W.tillCaps) ? W.tillCaps() : null; } catch (e) { caps = null; }
    if (!caps) return [];
    // with no price the dollar figure alone, which needs none (`tillCaps`)
    const row = (label, which, sats, cents) => {
      const m = sats > 0 ? this.money(sats) : cents > 0 ? { main: this.unitFigure(cents, 'usd'), sub: '' } : { main: '', sub: '' };
      return { label, path, value: m.main, valueSub: m.sub,
        tap: shut ? shut(() => this.tillCapAsk(which)) : () => this.tillCapAsk(which) };
    };
    return [
      row('OFFLINE, ONE PAYER', 'payer', caps.payerSats, caps.payerCents),
      row('OFFLINE, IN ALL', 'hold', caps.holdSats, caps.holdCents),
    ];
  }

  // SET AMOUNT for one of them, dollars first as every amount is typed
  tillCapAsk(which) {
    this.setState(p => ({
      screen: 'amount', stack: p.stack.concat([p.screen]), flow: 'tillCap', tillCapWhich: which === 'payer' ? 'payer' : 'hold',
      amount: '', unit: this.px() ? 'USD' : 'SATS',
      asset: '', network: '', note: '', noteDraft: '', recipient: '', recipientKind: '',
    }));
  }

  tillCapQuestion() {
    return this.state.tillCapWhich === 'payer'
      ? 'How much may one payer hand you while you are offline?'
      : 'How much may you hold while offline before it settles?';
  }

  /* The default, as SET AMOUNT's second answer: the owner's figure in dollars,
   * which follows the price until a figure is set. */
  tillCapDefaultLabel() {
    return 'USE THE DEFAULT (' + (this.state.tillCapWhich === 'payer' ? '$ 50.00' : '$ 300.00') + ')';
  }

  // NEXT on SET AMOUNT: kept in sats (`wantedSats` turns typed dollars into sats at this phone's price); 0 is the default
  tillCapSet(sats) {
    const W = window.FoxyWallet;
    const which = this.state.tillCapWhich === 'payer' ? 'payer' : 'hold';
    if (!(sats >= 0) || !W || !W.setTillCap) return;
    let caps = null;
    try { caps = W.setTillCap(which, sats); }
    catch (e) { this.toast('That could not be kept. Try again.', true); return; }
    const now = which === 'payer' ? caps.payerSats : caps.holdSats;
    this.setState(p => ({
      screen: p.stack.length ? p.stack[p.stack.length - 1] : 'home', stack: p.stack.slice(0, -1),
      flow: 'receive', amount: '', unit: 'USD', menuTick: (p.menuTick || 0) + 1,
    }));
    this.toast(now > 0 ? 'Set to ' + this.money(now).main : 'Set to the default');
  }

  /* The receive screen's notice, with no route: '' under half the cap, the
   * prompt at it, and the same words made firm at the cap. In the amber the
   * amount screen's price warning uses. */
  tillNoticeText() {
    const W = window.FoxyWallet;
    if (!(this.offlineNow && this.offlineNow())) return '';
    let n = null;
    try { n = (W && W.tillNotice) ? W.tillNotice() : null; } catch (e) { n = null; }
    if (!n || !n.level) return '';
    const held = n.heldCents > 0 ? this.unitFigure(n.heldCents, 'usd') : this.unitFigure(n.heldSats, 'sat');
    return n.level === 'full'
      ? 'You are holding ' + held + ' of payments that are not settled yet. Connect to settle them before you take more.'
      : 'You are holding ' + held + ' of payments that are not settled yet. Connect to settle them.';
  }
