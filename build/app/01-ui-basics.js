


// every screen that runs inside the locked-down POS shell — the shell owns the bottom nav
// Status-template screens: a blocked action always says what did NOT happen
// `priceConfirm` and `crossConfirm` used to be cards: agreeing a bitcoin price,
// and agreeing to pay somebody at another mint. Both are a person looking at
// figures and deciding, which is what this shell is for.
// Kept as one plain array literal — a suite reads this line as JSON.
const CONFIRM_SCREENS = ['depConfirm', 'sendConfirm', 'reqOffer', 'trConfirm', 'ocConfirm', 'priceConfirm', 'crossConfirm', 'fcMoveConfirm'];
// how long a fetched price still counts when a refresh fails, and how long a
// launch with no price waits before saying so (09-melt-paste-switch.js)
const PRICE_STANDS_MS = 3 * 60 * 1000;
const PRICE_GRACE_MS = 8000;

const BLOCKED = {
  sendFail:   { title: 'PAYMENT FAILED',   reason: 'The amount is more than your available balance.', chip: 'Your money never left your account.', retry: 'CHANGE AMOUNT', back: 'amount', showAmount: true },

  // ---- identity and sign-in ----

  // ---- money in ----

  // ---- money out ----
  mintRefused: { title: 'THE MINT SAID NO', tone: 'warn',
    reason: 'The mint would not carry out this payment.' },
  netLost:    { title: 'CONNECTION LOST',  reason: "We lost signal before this finished. We'll confirm the outcome once you're back online.", chip: 'Nothing is final until you reconnect.', retry: 'RETRY', back: 'amount', showAmount: true, tone: 'warn' },
  lnNoRoute:  { title: 'NO ROUTE FOUND',   reason: "We couldn't find a path to that wallet. It may be offline or short on capacity.", chip: 'Your money never left your account.', retry: 'TRY AGAIN', back: 'amount', showAmount: true },
  badAddress: { title: "THAT WON'T WORK",  reason: "This isn't a valid Lightning invoice or bitcoin address. Check it and paste it again.", chip: 'Nothing was sent.', retry: 'PASTE AGAIN', back: 'sendHow' },
};

const CTA_INK = s => '#fff';
// the host may pin these; local state is the fallback
const TH = c => c.props.startTheme || c.state.theme;
const AC = c => c.props.startAccent || c.state.accent;

const ACCENTS = [
  { id: 'foxy',   name: 'FOXY',        acc: '#E8622A', lt: '#F79A3C', dk: '#C24A1B', rgb: '232,98,42' },
  { id: 'green',  name: 'GREEN', acc: '#3AB54A', lt: '#5CD46C', dk: '#2C9A3B', rgb: '58,181,74' },
  { id: 'teal',   name: 'SEA',         acc: '#0E9E93', lt: '#3CC7BB', dk: '#0A7C73', rgb: '14,158,147' },
  { id: 'sky',    name: 'SKY',         acc: '#2E7CF6', lt: '#5C9BFF', dk: '#215FC4', rgb: '46,124,246' },
  { id: 'indigo', name: 'INDIGO',      acc: '#5B54E8', lt: '#8079FF', dk: '#4640BC', rgb: '91,84,232' },
  { id: 'violet', name: 'VIOLET',      acc: '#8B45D6', lt: '#AC72EC', dk: '#6E34AC', rgb: '139,69,214' },
  { id: 'rose',   name: 'ROSE',        acc: '#D4409A', lt: '#EE6FBB', dk: '#A82F79', rgb: '212,64,154' },
  { id: 'ember',  name: 'EMBER',       acc: '#E0602E', lt: '#F58A5C', dk: '#B44A22', rgb: '224,96,46' },
  { id: 'gold',   name: 'GOLD',        acc: '#D19A0E', lt: '#EDBB3C', dk: '#A87A0A', rgb: '209,154,14' },
];
const ACC_OF = (id) => ACCENTS.filter(a => a.id === id)[0] || ACCENTS[0];

// workbench seeds: enough state for a screen to render out of context

class Component extends DCLogic {
  /* The fork's workbench table of preset screens went with this state: two
   * dozen frames of someone else's demo data — a bank name, a card's last four,
   * a phone number, dollar balances — reachable only through a `startSeed` prop
   * nothing has ever set. Residue of the kind the audit's finding 13 is about,
   * kept alive only by the spreads that read it. */
  /* Screen state is a bag: most of it is set by the screens themselves as they
   * are opened, not listed here. The type says so plainly now — it used to be
   * widened by accident, through a spread of the workbench table that stood
   * where this comment does. */
  /** @type {Record<string, any>} */
  state = {
    ...(this.props.startOpen ? { [this.props.startOpen]: true } : {}),
    screen: this.props.startScreen || 'home',
    // true from the first paint, so the connect screen never flashes its
    // pairing prompt before the saved-wallet check has had a chance to run
    walletSearching: !this.props.startStatic,
    stack: [], mapFull: !!this.props.startFull,
    balUsd: this.props.startFresh ? 0 : null,
    balSats: this.props.startFresh ? 0 : null,
    noCardYet: !!this.props.startNoCard,
    camOk: !this.props.startNoCamera,
    baName: this.props.startBizName || '',
    baAddr: this.props.startBizAddr || '',
    bizReview: this.props.startBizReview || undefined,
    acctLevel: this.props.startLevel || undefined,
    // review frames: a verified or boosted account implies a number on file
    acctPh: this.props.startJm ? '+1 876 555 0143'
      : ((this.props.startLevel === 'verified' || this.props.startLevel === 'boosted') ? '+1 (876) 555-0143' : undefined),
    xCtaBtc: (this.props.startCashOnly && !this.props.startFresh) || undefined,
    asset: '',
    amount: '',
    network: '',
    unit: 'USD',
    theme: 'dark',
    hidden: false, range: '1D', rangeOpen: false, open: { contact: true, account: false, login: false },
    priceCollapsed: false,
    noteOpen: this.props.startPopup === 'noteOpen' || this.props.startOpen === 'noteOpen', note: '', noteDraft: '', kbShift: true, kbSymbols: false,
    priceRemoved: false, removeConfirmOpen: false, addConfirmOpen: false,
    ...(this.props.startOpen ? { [this.props.startOpen]: true } : {}),
    ...(this.props.startScreen ? { screen: this.props.startScreen } : {}),
  };

  /* Is this phone working offline, by the person's own choice?
   *
   * Read from the route every render, never remembered: `_privacy` surrenders the
   * choice the moment Tor is up, so a screen that cached this would go on greying
   * out controls that had started working again. The app already re-renders on
   * every privacy push (`onPrivacy` → `routeAt`), so reading it live costs
   * nothing.
   *
   * Not the same question as "is the route shut". Tor merely connecting is not
   * offline: the person has not chosen anything, the gate is up saying so, and
   * nothing should be greyed out on a screen they cannot see. */
  offlineNow() {
    const W = window.FoxyWallet;
    const p = (W && W.privacy) ? W.privacy() : null;
    return !!(p && p.offline);
  }

  /* What a greyed-out control says when it is tapped anyway. A control that
   * looks dead and does nothing at all reads as a bug; one that says why reads
   * as a state. */
  offlineNo(what) {
    this.toast((what || 'That') + ' needs a connection. Tap OFFLINE to reconnect.', true);
  }

  toast(msg, amber) {
    clearTimeout(this._toastT);
    this.setState({ toastMsg: msg, toastAmber: !!amber });
    this._toastT = setTimeout(() => this.setState({ toastMsg: '', toastAmber: false }), 2000);
  }

  go(s) { this.setState(p => ({ screen: s, stack: p.stack.concat([p.screen]) })); }

  /* The mint list, opened to switch mints.
   *
   * That one screen does three jobs, and trStep is the whole of what says
   * which: '' switches, 'from' and 'to' are the first two steps of a transfer
   * between your own mints (26a-transfer.js, 27-render-mints-restore-backup.js).
   * back() pops a screen and clears nothing, so a transfer dropped at "FROM
   * WHICH MINT?" left trStep set with no screen showing it: every later way
   * into the list — SWITCH, the balance pill, the mint warning, history —
   * opened it still asking which mint to move from, and tapping a mint began
   * a transfer nobody had asked for. There was no way back to switching short
   * of restarting Foxy.
   *
   * So the mode is never inherited: goTransfer names the job it wants, and
   * every other way in comes through here and names this one. */
  /* The pieces this phone is holding. Local, so it opens with no route — which is
   * the point: offline, whether an exact amount can be paid is the only question
   * that decides whether money can move at all. */
  goChange() { this.go('change'); }

  goSwitchMint(extra) {
    this.setState(p => Object.assign({
      screen: 'switchMint', stack: p.stack.concat([p.screen]),
      trStep: '', trFrom: '', trTo: '',
      // nor a card's question of which mint to move to (26f-flashcard.js)
      fcPick: false,
    }, extra || {}));
  }
  back() {
    this.setState(p => {
      const next = p.stack.length
        ? { screen: p.stack[p.stack.length - 1], stack: p.stack.slice(0, -1) }
        : { screen: 'home', stack: [] };
      return next;
    });
  }
  toggle(k) { this.setState(s => ({ open: Object.assign({}, s.open, { [k]: !s.open[k] }) })); }

  // a row: label, value, and the optional extras the shell reserves space for
  cfRow(label, value, opt) {
    const o = opt || {};
    return {
      label: label, value: value,
      ink: o.ink || 'var(--ink)',
      sub: o.sub || '',
      subH: o.sub ? '24px' : '0px',
      minH: o.reserve ? '69px' : '0px',
      shown: o.hidden ? '0' : '1',
      cursor: o.tap ? 'pointer' : 'default',
      tap: o.tap || (() => {}),
      badge: o.badge || '',
      basis: o.half ? '50%' : '100%',
      /* A row's value is 22px, which is right for a mint name and wrong for
       * four digits somebody is comparing against another phone held beside
       * this one. `big` matches the size the receiver shows them at, so the
       * two screens can be held together and read at a glance rather than
       * squinted at. */
      size: o.big ? '88px' : '22px',
    };
  }

  sendToText() {
    const s = this.state;
    if (s.recipientKind === 'email') return (s.recipient || '').toUpperCase();
    // an invoice is 200-odd characters and filled the screen; five each end is
    // enough to recognise it against what was pasted
    return this.shortId(s.recipient || '');
  }

  /** @typedef {{ label: string, go: () => void, filled?: boolean }} ConfirmSecondary */
  /** @typedef {{ title?: string, titleInk?: string, subtitle?: string, code?: string, amountLabel?: string,
   *    amount?: string, amountInk?: string, amountSub?: string, rows?: any[], warn?: string,
   *    chip?: string, secondary?: ConfirmSecondary, close?: () => void,
   *    cta?: string, ctaTone?: string, ctaBusy?: boolean,
   *    go?: () => void }} ConfirmSpec */
  /* What the confirmation shell shows (renderConfirmShell). */
  /** @returns {ConfirmSpec} */
  confirmSpec() {
    const s = this.state;
    const val = parseFloat(s.amount) || 0;
    // a scanned payment request reads like any other payment going out
    if (s.screen === 'reqOffer') return this.requestSpec();
    // moving money between your own mints (26a-transfer.js)
    if (s.screen === 'trConfirm') return this.transferSpec();
    // paying a Bitcoin address (26b-onchain.js)
    if (s.screen === 'ocConfirm') return this.onchainSpec();
    // a payer's bitcoin price, for a receiver with no route (26d-tap.js)
    if (s.screen === 'priceConfirm') return this.priceSpec();
    // paying somebody at another mint: the fee, and the only button that sends
    if (s.screen === 'crossConfirm') return this.crossSpec();
    // a card moved to another mint: what moves, what arrives, the fee (26f-flashcard.js)
    if (s.screen === 'fcMoveConfirm') return this.fcMoveSpec();
    // sendConfirm
    const rows = [
      this.cfRow('DELIVERED TO', this.sendToText()),
      this.cfRow('PAYING FROM', s.payFrom || 'BITCOIN', { half: true }),
      this.cfRow('NETWORK', s.recipientKind === 'address' ? 'ON-CHAIN' : 'LIGHTNING', { half: true }),
      this.cfRow('ARRIVES', s.recipientKind === 'address' ? '~10 MINUTES' : 'INSTANTLY',
        { ink: s.recipientKind === 'address' ? 'var(--btc-ink)' : 'var(--acc)', half: true }),
      /* The fee, quoted before the payment rather than reported after it.
       *
       * "up to" because the reserve is a ceiling: routing usually costs less
       * and the remainder comes back as change. Naming a number that is
       * normally an overstatement is better than UNKNOWN, which is what this
       * said until the money had already gone. */
      /* Only the quote. Never sendFee.
       *
       * sendFee is written when a payment succeeds. Reading it here put the
       * last payment's fee on the next payment's confirmation, three separate
       * times, each with a different patch. The value simply does not belong
       * on a screen shown before the payment — a quote or nothing. */
      this.cfRow('FEE', s.quotedFee != null
        ? 'UP TO ' + this.money(s.quotedFee).main
        : s.quotingFee ? 'CHECKING…' : 'UNKNOWN',
        { half: true, sub: s.quotedFee != null ? this.money(s.quotedFee).sub : '' }),
    ];
    if ((s.note || '').trim()) rows.push(this.cfRow('NOTE', (s.note || '').trim()));
    /* The code is not a row any more: it is above the amount, the same size,
     * in the accent — the same place and shape as on the receiver's screen, so
     * the two can be held side by side and compared at a glance rather than
     * read. See cfCode in the render values. */
    const feeDue = s.quotedFee != null ? Math.max(0, Math.round(Number(s.quotedFee) || 0)) : 0;
    const shortOf = (() => {
      const W = window.FoxyWallet;
      if (s.recipientKind !== 'invoice' || !s.recipient || !W || !W.amountOf) return 0;
      const need = W.amountOf(s.recipient) || 0;
      const have = s.balSats || 0;
      /* With the fee the mint will hold back for it, once that is known. The
       * invoice alone fitting is not the payment fitting: a mint takes the
       * amount and a reserve for routing, and gives back what it does not
       * use. Two invoices a few hundred sats under the balance were offered
       * a SEND button here and refused a second later on the sending screen
       * with "needs N including the fee reserve, and you hold M". The quote
       * is on this screen already. */
      const owed = need + feeDue;
      return (need && owed > have) ? owed - have : 0;
    })();
    if (shortOf) {
      return {
        title: 'CONFIRMATION', amountLabel: 'SENDING',
        amount: this.sendAmountText(),
        amountInk: '#FF5C5C',
        rows: rows,
        warn: this.heldBlocks(shortOf) || 'More than your balance \u2014 short by ' + this.money(shortOf).main
          + (feeDue > 0 ? ' with the fee' : ''),
        cta: 'CLOSE', ctaTone: 'warn', go: () => this.back(),
      };
    }
    /* Typed in dollars: nothing can be sent until two price sources agree on
     * how many sats that is (checkSendPrice). */
    if (s.recipientKind !== 'invoice' && s.unit !== 'SATS' && s.sendPriceCheck !== 'agreed') {
      const failed = s.sendPriceCheck === 'failed';
      return {
        title: 'CONFIRMATION', amountLabel: 'SENDING',
        amount: '$ ' + this.usd(val),
        amountSub: failed ? '' : 'Checking the price with two sources\u2026',
        rows: rows,
        warn: failed ? 'Two price sources did not agree on the price of bitcoin, so Foxy cannot work out the sats. Nothing was sent.' : '',
        cta: failed ? 'TRY AGAIN' : 'CHECKING THE PRICE\u2026', ctaTone: failed ? 'warn' : 'go',
        go: failed ? () => this.checkSendPrice() : () => {},
      };
    }
    return {
      title: 'CONFIRMATION', amountLabel: 'SENDING',
      amount: this.sendAmountText(),
      // the converted figure sits under the primary one
      amountSub: (() => {
        const W = window.FoxyWallet;
        const inv = (s.recipientKind === 'invoice' && s.recipient && W)
          ? W.amountOf(s.recipient) : null;
        const v = parseFloat(this.state.amount) || 0;
        const st = inv || (this.state.unit === 'SATS' ? Math.round(v) : Math.round(v / this.px() * 1e8));
        if (inv || this.state.unit === 'SATS') return this.money(st).sub;
        // typed in dollars: the sats that will leave, and the price they were
        // worked out from, so a wrong price shows on the screen
        const sats = s.sendSats || st;
        return sats ? '\u20bf ' + this.group(sats) + ' at $ ' + this.group(Math.round(v / sats * 1e8)) + ' per bitcoin' : '';
      })(),
      rows: rows,
      // the DOM sheet, not openNote's template editor — that one renders on
      // top of this screen rather than replacing it, so both headers draw
      secondary: { label: (s.note || '').trim() ? 'EDIT NOTE' : 'ADD A NOTE', go: () => this.editSendNote(), filled: !!(s.note || '').trim() },
      /* Not until the fee is known. The balance check above needs it, and
       * the screen offered SEND for the second or two the mint took to say
       * what it would hold back — long enough to press it and find out on
       * the sending screen that the payment did not fit. While it is being
       * asked, the button says so and does nothing. */
      cta: (s.recipientKind === 'invoice' && s.quotingFee) ? 'CHECKING FEE\u2026' : 'SEND ' + this.sendAmountText(),
      ctaBusy: s.recipientKind === 'invoice' && !!s.quotingFee,
      ctaTone: 'go',
      go: (s.recipientKind === 'invoice' && s.quotingFee) ? () => {} : () => this.startSend(),
    };
  }

  /* Which of your mints issued this invoice, if any, and what you hold there.
   * Cheap: the decode is local, the lookup is a map in storage. */
  sendAmountText() {
    const s = this.state, W = window.FoxyWallet;
    // the invoice is the only figure that will actually leave the wallet
    const invSats = (s.recipientKind === 'invoice' && s.recipient && W)
      ? W.amountOf(s.recipient) : null;
    if (invSats) return this.money(invSats).main;
    const v = parseFloat(s.amount) || 0;
    if (s.unit === 'SATS') return this.money(Math.round(v)).main;
    /* Typed in dollars: the sats are what leaves, so they are the headline,
     * fixed when the confirmation opened (sendSats) and sent exactly. The
     * headline used to read "$20.00" while a wrong price, or one that changed
     * before the tap, decided how many sats went. */
    /* And the dollars are the headline again, with those
     * sats and their price on the line under it — still fixed, still sent
     * exactly, and still on the screen. */
    return '$ ' + this.usd(v);
  }
  // the daily card limit: $2,500 to start, $5,000 once an ID clears
  /* The note the screen in front of you is actually about.
   *
   * state.note belongs to a send or receive flow. The ecash token screen's
   * note belongs to the token and lives on its tag, written by editTokenNote
   * and read back with tagsFor. Reading state.note there showed a note left
   * over from an unrelated invoice.
   */
  noteShown() {
    const s = this.state;
    // the screen is 'tokenOut'; compared as 'tokenout' this never matched, and the
    // token screen showed the send's note instead of the token's own
    if (s.screen !== 'tokenOut') return s.note || '';
    const W = window.FoxyWallet;
    const out = (W && W.lastToken && W.lastToken()) || {};
    if (!out.hash || !W || !W.tagsFor) return '';
    return (W.tagsFor(out.hash) || {}).note || '';
  }
