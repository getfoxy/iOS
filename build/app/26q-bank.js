  /* ---- BANK ACCOUNT: the Foxy balance traded for dollars at an exchange the person already uses ---------------------
   *
   * The wallet's half is build/wallet/08f-bank.js. Nothing here needs an account of Foxy's at the exchange: the person's
   * own account is paid by Lightning, and the exchange turns it into dollars by their setting there.
   *
   *   SEND > BANK ACCOUNT ........ the SWITCH MINT list, titled BANK ACCOUNT (`bankList`, `bankPick`): STRIKE, RIVER,
   *                                CASH APP.
   *   STRIKE ..................... ALREADY HAVE AN ACCOUNT WITH STRIKE? (`bankHaveAsk`): NO opens the exchange's site; YES
   *                                asks the username on the TYPE screen's look ('bankAsk'), the domain shown after the
   *                                field, with PASTE; CHECK looks it up over Tor (`bankCheck`) and says found or not; a
   *                                name found is kept, and NEXT is SET AMOUNT for that address.
   *   RIVER, CASH APP ............ the same screen with no field: OPEN RIVER (CASH APP) and PASTE; an invoice pasted goes where any
   *                                pasted invoice goes (`acceptTarget`): the confirmation with its own amount, SET AMOUNT
   *                                for one with none.
   *   paying ..................... the send of a Lightning address or an invoice, unchanged: SET AMOUNT in dollars first,
   *                                PAY FROM, the confirmation, `payLnurl` / `pay`. The payment is marked as this exchange's
   *                                (`bank`) while its recipient is the one chosen here (`bankNow`).
   *   done ....................... the sent screen says what to do in the exchange, with OPEN STRIKE / RIVER / CASH APP.
   *   next time .................. BANK ACCOUNT goes straight to SET AMOUNT for the address kept (River, Cash App: to
   *                                its paste screen), with CHANGE EXCHANGE back to the list.
   *   history .................... "To Strike", "To River", "To Cash App". */

  BANK_NAMES = { strike: 'Strike', river: 'River', cashapp: 'Cash App' };

  bankName(ex) { return this.BANK_NAMES[ex] || 'the exchange'; }

  // the exchange whose payment this is: only while the recipient on screen is the one BANK ACCOUNT chose
  bankNow() {
    const s = this.state || {};
    const b = s.bank;
    if (!b || !b.ex || !b.to) return '';
    const to = String(s.recipient || '').trim().replace(/^lightning:/i, '').toLowerCase();
    return to && to === String(b.to).toLowerCase() ? String(b.ex) : '';
  }

  // the exchanges paid by an invoice pasted each time (no Lightning address): River and Cash App
  bankByInvoice(ex) { return ex === 'river' || ex === 'cashapp'; }

  // "YOUR RIVER ACCOUNT" for an invoice made in River or Cash App for BANK ACCOUNT, else ''
  bankOwn() {
    const ex = this.bankNow();
    return this.bankByInvoice(ex) ? 'YOUR ' + this.bankName(ex).toUpperCase() + ' ACCOUNT' : '';
  }

  /* SEND > BANK ACCOUNT: the address kept, straight to SET AMOUNT; River or Cash App kept, its paste screen; otherwise the list. */
  bankStart() {
    if (this.offlineNow()) { this.offlineNo('Sending to a bank account'); return; }
    const W = window.FoxyWallet;
    const saved = W && W.bankSaved ? W.bankSaved() : null;
    if (saved && saved.addr) { this.bankAmount(saved.ex, saved.addr, true); return; }
    if (saved && this.bankByInvoice(saved.ex)) { this.bankAskOpen(saved.ex, true); return; }
    this.bankList();
  }

  // the list, through the one way into it, which clears every other question it can be asking
  bankList() { this.goSwitchMint({ bankPick: true }); }

  /* The rows, in the list's own look (27-render-mints-restore-backup.js): each exchange with its site under its name, or
   * the address kept there. */
  bankRows() {
    const W = window.FoxyWallet;
    const saved = W && W.bankSaved ? W.bankSaved() : null;
    const list = W && W.bankExchanges ? W.bankExchanges() : [];
    const logos = { strike: 'gd-strike.jpg', river: 'gd-river.jpg', cashapp: 'gd-cashapp.jpg' };
    const tints = { strike: '#1C1C1E', river: '#1E3A5F', cashapp: '#00A83E' };
    return list.map((x) => {
      const mine = !!saved && saved.ex === x.key;
      return {
        name: String(x.name).toUpperCase(), host: mine && saved.addr ? saved.addr : x.domain,
        dim: '1', down: false, downText: '', initial: String(x.name).slice(0, 1).toUpperCase(), tint: tints[x.key] || '#5A5A5A',
        logo: logos[x.key] ? "url('" + logos[x.key] + "')" : 'none',
        here: false, notHere: true, text: '', ink: 'var(--acc-ink)', busy: false,
        bg: 'var(--surface)', border: 'rgba(var(--ink-rgb),.12)',
        tap: () => this.bankPick(x.key),
      };
    });
  }

  /* A row tapped. River, Cash App: its paste screen. Strike: whether there is an account there already. */
  bankPick(ex) {
    if (this.bankByInvoice(ex)) { this.bankAskOpen(ex, false); return; }
    this.bankHaveAsk(ex);
  }

  bankHaveAsk(ex) {
    const name = this.bankName(ex);
    this.blockedCard('bankHave', {
      tone: 'ask', title: 'ALREADY HAVE AN ACCOUNT WITH ' + name.toUpperCase() + '?',
      reason: 'Foxy pays your ' + name + ' account by its username. ' + name + ' turns it into dollars.',
      retry: 'YES', go: () => this.bankAskOpen(ex, false),
      shut: { label: 'NO', pill: true, tap: () => this.bankNoAccount(ex) },
    });
  }

  // NO: the exchange's site, to make an account there and come back
  bankNoAccount(ex) {
    const W = window.FoxyWallet;
    if (W && W.bankOpen) Promise.resolve(W.bankOpen(ex)).catch(() => {});
    this.toast('Make an account with ' + this.bankName(ex) + ', then come back to BANK ACCOUNT.');
  }

  /* The username screen, or the paste screen of River or Cash App. `short`: reached from BANK ACCOUNT with River kept, so CHANGE EXCHANGE
   * is offered on it. */
  bankAskOpen(ex, short) {
    this.setState(p => ({
      screen: 'bankAsk', stack: p.screen === 'bankAsk' ? p.stack : p.stack.concat([p.screen]),
      bankEx: ex, bankShort: !!short, bankDraft: '', bankLook: null,
    }));
  }

  bankType(e) {
    this.setState({ bankDraft: String((e && e.target && e.target.value) || ''), bankLook: null });
  }

  /* The screen's big button: OPEN RIVER or OPEN CASH APP; for an address, CHECK until the name typed is found, then NEXT. */
  bankGo() {
    const s = this.state;
    const ex = s.bankEx;
    const W = window.FoxyWallet;
    if (this.bankByInvoice(ex)) { if (W && W.bankOpen) Promise.resolve(W.bankOpen(ex)).catch(() => {}); return; }
    const look = s.bankLook;
    const user = W && W.bankUser ? W.bankUser(ex, s.bankDraft) : '';
    if (look && look.user && look.user === user && look.state === 'found') {
      this.bankAmount(ex, look.addr, false);
      return;
    }
    if (look && look.state === 'checking') return;
    this.bankCheck();
  }

  /* The username looked up over Tor (`bankLookup`): found or not found. A name found is kept. */
  bankCheck(pasted) {
    const s = this.state;
    const ex = s.bankEx;
    const W = window.FoxyWallet;
    if (!W || !W.bankLookup) return;
    const draft = pasted != null ? String(pasted) : String(s.bankDraft || '');
    const user = W.bankUser ? W.bankUser(ex, draft) : '';
    if (!draft.trim()) { this.toast('Type your ' + this.bankName(ex) + ' username first.', true); return; }
    if (!user) { this.setState({ bankLook: { state: 'bad', user: '', addr: '', why: '' } }); return; }
    if (this.offlineNow()) { this.offlineNo('Checking a username'); return; }
    const run = (this._bankRun = (this._bankRun || 0) + 1);
    this.setState({ bankLook: { state: 'checking', user, addr: '', why: '' } });
    Promise.resolve(W.bankLookup(ex, draft)).then((r) => {
      if (this._bankRun !== run) return;
      if (r && r.state === 'found' && W.bankSave) W.bankSave(ex, r.user);
      this.setState({ bankLook: r || { state: 'failed', user, addr: '', why: '' } });
    }).catch((e) => {
      if (this._bankRun !== run) return;
      this.setState({ bankLook: { state: 'failed', user, addr: '', why: W.reason ? W.reason(e) : String((e && e.message) || e) } });
    });
  }

  /* PASTE, by Apple's button over it (`syncPreview`) or the page's own: a username into the field, checked at once; for
   * River or Cash App, the invoice, on to where any pasted invoice goes. */
  bankPasted(text) {
    const W = window.FoxyWallet;
    const ex = this.state.bankEx;
    const t = String(text || '').trim().replace(/^lightning:/i, '');
    if (!W) return;
    if (this.bankByInvoice(ex)) {
      if (!t || !W.classify || W.classify(t) !== 'invoice') {
        this.setState({ bankLook: { state: 'bad', user: '', addr: '', why: '' } });
        return;
      }
      if (W.bankSave) W.bankSave(ex);
      this.setState({ bank: { ex, to: t }, bankShort: false, bankLook: null });
      this.acceptTarget(t);
      return;
    }
    const user = W.bankUser ? W.bankUser(ex, t) : '';
    this.setState({ bankDraft: user || t, bankLook: null });
    this.bankCheck(user || t);
  }

  bankPaste() {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((t) => this.bankPasted(t)).catch(() => this.toast('Could not read the clipboard.', true));
      return;
    }
    this.toast('Paste is not available here.', true);
  }

  /* SET AMOUNT for the address chosen, dollars first, as a Lightning address any other way is paid (`acceptTarget`). */
  bankAmount(ex, addr, short) {
    this.setState(p => ({
      screen: 'amount', stack: p.stack.concat([p.screen]), flow: 'send',
      asset: 'BITCOIN', network: 'LIGHTNING', recipientKind: 'email', recipient: String(addr),
      unit: 'USD', amount: '', payFrom: 'BITCOIN', tokenMode: false,
      bank: { ex, to: String(addr) }, bankShort: !!short,
    }));
  }

  // CHANGE EXCHANGE, under NEXT on SET AMOUNT or on a paste screen: the list again
  bankChange() {
    this.setState({ bankShort: false });
    this.bankList();
  }

  // SET AMOUNT's question, for a payment to an exchange
  bankAmountQuestion() {
    const ex = this.bankNow();
    return 'How much to send to your ' + this.bankName(ex) + ' account?';
  }

  /* What the sent screen says, once it is sent: what to do in the exchange so it arrives as dollars, and its button. */
  bankDoneSays(ex) {
    if (ex === 'strike') return 'Sent to your Strike account. In Strike, set Receive currency to Cash so it arrives as dollars.';
    if (ex === 'cashapp') return 'Sent to your Cash App. Turn on Receive Lightning as dollars in Cash App so it arrives as dollars. '
      + 'Cash App allows $999 over Lightning every 7 days and is not available in New York.';
    if (ex === 'river') return 'Sent to your River account. Open River to withdraw it to your bank.';
    return '';
  }

  /** @param {RenderContext} c */
  renderBank(c) {
    const { s, sc } = c;
    const on = sc === 'bankAsk';
    const ex = on ? String(s.bankEx || '') : '';
    const W = window.FoxyWallet;
    const name = this.bankName(ex);
    const river = this.bankByInvoice(ex);
    const domain = ex === 'strike' ? 'strike.me' : '';
    const look = on ? s.bankLook : null;
    const user = on && !river && W && W.bankUser ? W.bankUser(ex, s.bankDraft) : '';
    const typed = !!String((on && s.bankDraft) || '').trim();
    const checking = !!look && look.state === 'checking';
    const ready = !!look && !!look.user && look.user === user && look.state === 'found';
    const status = !look ? ''
      : look.state === 'checking' ? 'Checking with ' + name + '…'
      : look.state === 'found' ? look.addr + ' — found'
      : look.state === 'missing' ? look.addr + ' — not found, check the spelling'
      : look.state === 'bad' ? (river ? 'That is not a Lightning invoice. In ' + name + ', copy the Lightning invoice, then paste it here.'
        : 'That is not a ' + name + ' username.')
      : 'Could not reach ' + name + ' to check it. Try again.';
    const statusInk = !look ? 'rgba(var(--ink-rgb),.55)'
      : look.state === 'found' ? 'var(--acc-ink)'
      : look.state === 'checking' ? 'rgba(var(--ink-rgb),.6)' : '#FF5C5C';
    const lit = river || (typed && !checking);
    // the sent screen's line and button, for a payment BANK ACCOUNT chose, once it is sent
    const sendPhase = s.sendPhase || 'in';
    const done = sc === 'sendDone' && (sendPhase === 'done' || sendPhase === 'settled');
    const sentEx = done ? this.bankNow() : '';
    return {
      isBankAsk: on,
      bkTitle: name.toUpperCase(),
      bkQuestion: ex === 'cashapp' ? 'Open Cash App, tap Money, then Bitcoin, then Receive, turn on Lightning, copy the invoice, then come back and paste it here.'
        : river ? 'Open River, choose Receive bitcoin, Use Lightning, copy the invoice, then come back and paste it here.'
        : 'What is your ' + name + ' username?',
      bkByName: on && !river,
      bkLabel: (name + ' username').toUpperCase(),
      bkDraft: on ? String(s.bankDraft || '') : '',
      bkPlaceholder: 'username',
      bkDomain: domain ? '@' + domain : '',
      onBankType: (e) => this.bankType(e),
      bkStatus: status,
      bkStatusInk: statusInk,
      bkCta: river ? 'OPEN ' + name.toUpperCase() : checking ? 'CHECKING…' : ready ? 'NEXT' : 'CHECK',
      bkGo: () => this.bankGo(),
      bkPaste: () => this.bankPaste(),
      bkChangeShown: on && !!s.bankShort,
      bkChange: () => this.bankChange(),
      // as SEND > TYPE's NEXT: the accent once there is something to do, grey until then
      bkActSh: lit ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -2px 0 rgba(0,0,0,.16),0 5px 12px rgba(var(--acc-rgb),.3)' : 'none',
      bkSh: lit ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(var(--acc-rgb),.34)' : 'none',
      bkAnim: lit ? 'shineLoop 3.4s cubic-bezier(.32,0,.28,1) 3s infinite' : 'none',
      bkBg: lit ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      bkInk: lit ? CTA_INK(s) : 'rgba(var(--ink-rgb),.4)',
      sentBankShown: !!sentEx,
      sentBankSays: sentEx ? this.bankDoneSays(sentEx) : '',
      sentBankCta: sentEx ? 'OPEN ' + this.bankName(sentEx).toUpperCase() : '',
      sentBankGo: () => { const x = this.bankNow(); if (x && W && W.bankOpen) Promise.resolve(W.bankOpen(x)).catch(() => {}); },
    };
  }

  // SET AMOUNT reached from BANK ACCOUNT straight to the address kept: it offers CHANGE EXCHANGE (23-render-home-and-amount.js)
  bankShortHere() {
    const s = this.state || {};
    return s.screen === 'amount' && s.flow === 'send' && !!s.bankShort && !!this.bankNow();
  }
