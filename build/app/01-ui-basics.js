


// every screen that runs inside the locked-down POS shell — the shell owns the bottom nav
// Status-template screens: a blocked action always says what did NOT happen
// `priceConfirm` and `crossConfirm` used to be cards: agreeing a bitcoin price,
// and agreeing to pay somebody at another mint. Both are a person looking at
// figures and deciding, which is what this shell is for.
// Kept as one plain array literal — a suite reads this line as JSON.
const CONFIRM_SCREENS = ['depConfirm', 'sendConfirm', 'reqOffer', 'trConfirm', 'ocConfirm', 'priceConfirm', 'crossConfirm', 'fcMoveConfirm', 'fcLimitConfirm', 'swapConfirm', 'fcXmConfirm', 'fcXlConfirm', 'fcOuConfirm', 'cidConfirm'];
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
    // (a figure a screen put on the keypad itself, which the first key replaces: 19-update-keypad-balance.js `press`)
    amountDefault: false,
    network: '',
    unit: 'USD',
    /* Two balances at one mint (dollars and bitcoin). `wallet` is the money
     * unit of the flow on screen, 'sat' or 'usd', and '' until the flow has
     * one; `unit` above is only the keypad's display. The dollars held are
     * `balUsdCents`, never `balUsd`, which is the sats' worth in dollars. */
    wallet: '', walletAuto: false, balUsdCents: null, histUnit: '',
    theme: 'dark',
    hidden: false, range: '1D', rangeOpen: false, open: { contact: true, account: false, login: false },
    priceCollapsed: false,
    // the few seconds the money card's shield pulses after the route turns to IP EXPOSED (`shieldWatch`)
    shieldPulse: false,
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

  /* Is a connection on its way? The home banner's SECURING YOUR CONNECTION:
   * the phone has a network, Tor is at work on a circuit (connecting, or
   * stuck for a while), and nobody has chosen to go without Tor. The wallet
   * answers from the very record the banner is drawn from (`routeComing`), so
   * the two cannot differ; this is only the ask.
   *
   * It is the other half of `offlineNow`, not the opposite. No network, or
   * a Tor that has stopped or given up, is offline and not coming: the
   * banner says OFFLINE - NO CONNECTION or CANNOT CONNECT, and what needs a
   * connection is refused at once. Coming is a state to wait out, for a few
   * seconds, by the step that needs it (the send confirmation holds its
   * button, `confirmSpec`) and not to refuse in. */
  connecting() {
    const W = window.FoxyWallet;
    return !!(W && W.routeComing && W.routeComing());
  }

  /* What a greyed-out control says when it is tapped anyway. A control that
   * looks dead and does nothing at all reads as a bug; one that says why reads
   * as a state. */
  offlineNo(what) {
    // there is no OFFLINE to tap while a connection is on its way: the banner says SECURING YOUR CONNECTION
    const coming = this.connecting();
    this.toast((what || 'That') + (coming ? ' needs a connection. One is on its way.'
                                           : ' needs a connection. Tap the banner to retry.'), true);
  }

  toast(msg, amber) {
    clearTimeout(this._toastT);
    this.setState({ toastMsg: msg, toastAmber: !!amber });
    this._toastT = setTimeout(() => this.setState({ toastMsg: '', toastAmber: false }), 2000);
  }

  // (HISTORY opens at the connected mint's, whichever it showed last: `histShown`, 16-history-lists.js)
  go(s) { this.setState(p => Object.assign({ screen: s, stack: p.stack.concat([p.screen]) }, s === 'history' ? { histMint: '' } : {})); }

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
      // nor a card's question of which mint to move to (26f-flashcard.js), nor the till's of which mint to run at (26m-till.js)
      fcPick: false, tillPick: false, tillSet: [],
      // nor a card's WITHDRAW TO (26n-card-withdraw-to.js), nor the till's lists of people and codes (26p-till-tips.js)
      wdPick: false, tillList: false, tillListBackTo: false,
      // nor SEND's BANK ACCOUNT (26q-bank.js), nor HISTORY's question of whose history to show (16-history-lists.js, `goHistMints`)
      bankPick: false, histPick: false,
      // nor a mint picked on an earlier card's WITHDRAW TO or TRANSFER TO (26n-card-withdraw-to.js, `fcListNext`)
      mintSel: '',
    }, extra || {}));
  }
  back() {
    /* the till being opened: back off DEFAULT MINT is its set list again; off the set list, the opening stops (26m-till.js,
     * `tillOpenBack`) */
    if (this.tillOpenBack && this.tillOpenBack()) return;
    // a card's set-up asking an amount: back is a step back in it, or out of it (26j-card-wheel.js, `fcSuAmountBack`)
    if (this.fcSuAmountBack && this.fcSuAmountBack()) return;
    // 24HR LIMIT from CARD LIMITS: NO PIN AMOUNT again (26j-card-wheel.js, `fcLimitTxBack`)
    if (this.fcLimitTxBack && this.fcLimitTxBack()) return;
    // NAME CARD: the welcome again, or the card's screen (26j-card-wheel.js, `fcNameBack`)
    if (this.fcNameBack && this.fcNameBack()) return;
    /* Back off the card's own screen, the edge swipe's way home among them: the card shown there is left behind, as HOME leaves it
     * (26f-flashcard.js `fcGoHome`), so nothing later reads it as the card in hand (`fcPinInfo`). Not on a screen above it, which
     * comes back to it. */
    const st = this.state || {};
    const stk = st.stack || [];
    const to = stk.length ? stk[stk.length - 1] : 'home';
    /* Back off TRANSFER's confirmation or its keypad: the quote visited the mint it lands at, and the arrow goes home to
     * the saved mint as `trCancel` does (09-melt-paste-switch.js `homeAgain`). Not while it runs. */
    if ((st.screen === 'trConfirm' || (st.screen === 'amount' && st.flow === 'transfer')) && !st.trBusy && this.homeAgain) this.homeAgain();
    if (st.screen === 'flashcard' && to !== 'flashcard' && stk.slice(0, -1).indexOf('flashcard') < 0) this._fcCard = null;
    /* Back off a request's offer, the edge swipe's way among them, is the X's way out (24-render-receive-and-send.js,
     * `requestSpec` `close`): the request goes with the offer, and a tap's other phone is told. It stayed in state, and
     * a payment queued behind the trip home went out after the person had left (`makeTokenForRequest`). Not while it
     * is being paid, collected or crossed for: each of those ends it itself. A queued pass tells the other phone
     * itself, when it is dropped at landing. */
    if (st.screen === 'reqOffer' && to !== 'reqOffer' && st.req && !st.reqBusy && !st.reqCollecting && !st.crossBusy && !st.reqSwapping) {
      const W = window.FoxyWallet;
      if (st.req.viaTap && this._payAfterHome !== st.req && W && W.tapQuote) {
        W.tapQuote(JSON.stringify({ gaveUp: 'The payer cancelled.' })).catch(() => {});
      }
      this.setState({ req: null, tapQuoteFor: '' });
    }
    this.setState(p => {
      const next = p.stack.length
        ? { screen: p.stack[p.stack.length - 1], stack: p.stack.slice(0, -1) }
        // nothing left to go back to: home, or in the till its SET AMOUNT (26m-till.js, `homeState`)
        : (this.homeState ? this.homeState() : { screen: 'home', stack: [] });
      return next;
    });
  }
  /* A screen opened from the menu goes back to the menu when it is left (21-render-values.js, `shut`).
   *
   * A row's tap shuts the drawer and arms `menuReturn`. The first screen that is not home marks it as away, and home
   * reached again after that, by back, CANCEL, DONE or the edge swipe, opens the drawer once and lets it go. A row whose
   * tap puts something over home instead (a stage such as MY CASHU ID, a card, a PIN pad) opens the drawer again when
   * that is closed (`menuReturnSoon`, from `hideStage`, a card's close and `pinDismiss`); one whose tap is an answer
   * that takes its time (a face, the phone's own words) hands its promise back, and the drawer opens when that is over
   * (`menuReturnSettle`). A tap that put nothing anywhere (a toast) leaves nothing armed (`menuReturnCheck`).
   *
   * What ends somewhere else lets it go without opening anything: a payment's PAID or SENT, a swap's SWAPPED, a token
   * shown, a bill collected (`ENDS` below), a swap that ends at home while the mint finishes it (26i-swap.js), a mint
   * switched to (09-melt-paste-switch.js `justSwitch`), what to hold chosen (10-pin.js `holdDone`), a link opened
   * (05-device-shell.js), and an open till, which has no home and no menu. */
  menuReturnArm() {
    let top = 0;
    try { const d = document.querySelector('[data-menu-drawer]'); top = d ? d.scrollTop : 0; } catch (e) { top = 0; }
    this.setState({ open0: false, menuReturn: { away: false, waits: false, top: top } });
  }

  // something of the page's own over home: a stage, a card or a PIN pad
  menuReturnUp() {
    try {
      if (document.getElementById('foxy-stage')) return true;
    } catch (e) { /* no page */ }
    return !!(this._blockedEl && this._blockedEl.parentNode) || !!(this._pinEl && this._pinEl.parentNode);
  }

  // the drawer again, scrolled to where it was left
  menuReturnOpen(m) {
    const top = (m && m.top) || 0;
    return () => {
      if (!top) return;
      try { const d = document.querySelector('[data-menu-drawer]'); if (d) d.scrollTop = top; } catch (e) { /* no page */ }
    };
  }

  // a row's answer is over: at home with nothing over it, the menu again; on a screen it led to, home will open it
  menuReturnSettle() {
    const m0 = this.state && this.state.menuReturn;
    this.setState(p => {
      const m = p.menuReturn;
      if (!m || m.away) return null;
      if (p.screen !== 'home') return { menuReturn: Object.assign({}, m, { away: true }) };
      /* Something still over home (a card the answer raised, ACCEPT TIPS?, a PIN pad): the answer is in, so it no longer
       * waits, and that card's close asks again (`menuReturnSoon`); a card shut with no answer leaves nothing armed. */
      if (this.menuReturnUp()) return { menuReturn: Object.assign({}, m, { waits: false }) };
      return { open0: true, menuReturn: null };
    }, this.menuReturnOpen(m0));
  }

  // a stage, card or pad closed: once whatever replaces it (if anything) is up, the same question
  menuReturnSoon() {
    const m = this.state && this.state.menuReturn;
    if (!m || m.away || m.waits) return;
    setTimeout(() => this.menuReturnSettle(), 0);
  }

  // the tick after a row's tap: nothing opened, no screen and nothing over home, so nothing is waiting to come back from
  menuReturnCheck() {
    this.setState(p => {
      const m = p.menuReturn;
      if (!m || m.away || m.waits || p.screen !== 'home' || this.menuReturnUp()) return null;
      return { menuReturn: null };
    });
  }

  // a row whose answer is a promise: it may take any time (the phone's own words being typed)
  menuReturnWaits() {
    this.setState(p => (p.menuReturn && !p.menuReturn.away ? { menuReturn: Object.assign({}, p.menuReturn, { waits: true }) } : null));
  }

  // a flow that ends somewhere else: nothing opens the menu after it
  menuReturnDrop() {
    if (this.state && this.state.menuReturn) this.setState({ menuReturn: null });
  }

  // after every update (19-update-keypad-balance.js, `componentDidUpdate`)
  menuReturnWatch() {
    const st = this.state || {};
    const m = st.menuReturn;
    if (!m) return;
    const ENDS = ['paid', 'sendDone', 'swapDone', 'tokenOut', 'spAllPaid'];
    /* PAID raised over another screen is put back on that screen when dismissed (`announcePayment`): over a screen the
     * menu opened it is not that screen's end, and the screen goes on waiting; over home it is a payment that came in, and
     * nothing opens the menu after it. */
    const back = this._returnTo;
    const paidOver = st.screen === 'paid' && back && back.screen !== 'home';
    if (st.till || (ENDS.indexOf(st.screen) >= 0 && !paidOver)) { this.setState({ menuReturn: null }); return; }
    if (st.screen !== 'home') {
      if (!m.away) this.setState({ menuReturn: Object.assign({}, m, { away: true }) });
      return;
    }
    if (m.away) this.setState({ open0: true, menuReturn: null }, this.menuReturnOpen(m));
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
      subInk: o.subInk || 'rgba(var(--ink-rgb),.45)',
      // a second line under the first, in its own ink (a swap's market price, in red)
      sub2: o.sub2 || '',
      sub2Shown: !!o.sub2,
      sub2Ink: o.sub2Ink || 'rgba(var(--ink-rgb),.45)',
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
       * squinted at. A figure that heads its screen (what a swap gives) asks
       * for its own `size`. */
      size: o.size || (o.big ? '88px' : '22px'),
    };
  }

  sendToText() {
    const s = this.state;
    if (s.recipientKind === 'email') return (s.recipient || '').toUpperCase();
    // an invoice River made for BANK ACCOUNT (26q-bank.js) says whose it is
    if (this.bankNow && this.bankNow() === 'river') return 'YOUR RIVER ACCOUNT \u00b7 ' + this.shortId(s.recipient || '');
    // an invoice is 200-odd characters and filled the screen; five each end is
    // enough to recognise it against what was pasted
    return this.shortId(s.recipient || '');
  }

  /** @typedef {{ label: string, go: () => void, filled?: boolean }} ConfirmSecondary */
  /** @typedef {{ title?: string, titleInk?: string, subtitle?: string, code?: string, amountLabel?: string,
   *    amount?: string, amountInk?: string, amountSub?: string, rows?: any[], warn?: string,
   *    chip?: string, secondary?: ConfirmSecondary, close?: () => void,
   *    cta?: string, ctaTone?: string, ctaBusy?: boolean,
   *    titleUp?: boolean, wallet?: { word: string, go: () => void, label?: string },
   *    diffLine?: ?{ text: string, amber: boolean, pct: number },
   *    stack?: Array<{ label: string, value: string, big?: boolean, small?: boolean, ink?: string, sub?: string }>,
   *    details?: Array<{ label: string, value: string, wide?: boolean }>, detailNote?: string,
   *    from?: ?{ word: string, go: ?(() => void) },
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
    // a card's limit, before it is set (26f-flashcard.js)
    if (s.screen === 'fcLimitConfirm') return this.fcLimitSpec();
    // a card at another mint paying this phone's invoice from there: what it pays, its fee in it (26f-flashcard.js)
    if (s.screen === 'fcXmConfirm') return this.fcXmSpec();
    // money from this phone onto a card at another mint: what goes on, what leaves, the fee (26f-flashcard.js)
    if (s.screen === 'fcXlConfirm') return this.fcXlSpec();
    // a dollar card asked for sats: the dollars it pays for them, at whose rate, before its second tap (26f-flashcard.js)
    if (s.screen === 'fcOuConfirm') return this.fcOuSpec();
    // dollars into bitcoin or back, at this mint (26i-swap.js)
    if (s.screen === 'swapConfirm') return this.swapSpec();
    // paying a contact's Cashu ID (26o-cashu-id.js)
    if (s.screen === 'cidConfirm') return this.cidSpec();
    // sendConfirm
    const W = window.FoxyWallet;
    // paid from another mint than this phone's, chosen on PAY FROM: that mint's quote and its own confirmation (26l-pay-from.js)
    if (s.screen === 'sendConfirm' && (s.recipientKind === 'invoice' || s.recipientKind === 'email')
        && this.pfAway && this.pfAway('send') && !(this.cardSendNow && this.cardSendNow())) return this.payAwaySpec();
    /* At a mint with two balances: the owner's CONFIRM PAYMENT, with its WALLET button. Not paying from a card, which holds
     * one kind of money and pays in it: that is the confirmation below, with FROM FLASHCARD and NEXT, and no WALLET button
     * (a dollar card's says the mint's price under its amount, since it pays a bitcoin invoice in dollars). */
    if (s.screen === 'sendConfirm' && (s.recipientKind === 'invoice' || s.recipientKind === 'email')
        && this.twoUnitsOn && this.twoUnitsOn() && !this.cardSendNow()) return this.confirmTwoSpec();
    /* Waiting on the connection, or on what it is for.
     *
     * A Lightning payment cannot be made, and its fee cannot be known, until
     * the route is up and the mint has answered (for an address, the address
     * first: `quoteSendFee`). Until then the button says CHECKING and does
     * nothing, and the FEE row says the same word: they are one state, and
     * both read it from here. A connection that is on its way comes first
     * (`connecting`: Foxy comes back from the background, or opens, working
     * offline for the few seconds Tor takes), then the question itself, out
     * (`quotingFee`) or about to go (`sendToAsk`).
     *
     * With no connection and none coming nothing is waited for: the fee
     * reads UNKNOWN, and SEND is there to be pressed, as it always was, to be
     * told so. */
    const asks = s.screen === 'sendConfirm' && (s.recipientKind === 'invoice' || s.recipientKind === 'email');
    const held = asks && (this.connecting() || !!s.quotingFee || this.sendToAsk());
    /* Paying from a card (SEND on the card's screen, 26f-flashcard.js): the same confirmation, with the card it is paid from
     * in a row of its own after NETWORK, held to what the card holds and not to this phone's balance, and NEXT, which reads
     * the payment off the card (`fcOutNext`). */
    const out = !!(this.fcOutMode && this.fcOutMode()) && !!s.fc;
    // (a card of software 1.23 that holds both: what it holds of the currency chosen to pay from, `fcUnit`, `fcHeld`)
    const cardHas = out ? (this.fcHeld ? this.fcHeld(s.fc, this.fcUnit()) : Math.max(0, Math.round(Number(s.fc.balance) || 0))) : 0;
    /* A dollar card pays by a melt of its dollars, quoted in cents (03-send.js, `quoteSendFee`): its card's figures, the fee
     * and the total are dollars, and nothing of a sats figure is set against what it holds. */
    const cardUsd = out && (this.fcUnit ? this.fcUnit() : s.fc.unit) === 'usd';
    const cfig = (n) => (cardUsd ? { main: this.unitFigure(n, 'usd'), sub: '' } : this.money(n));
    const rows = [
      this.cfRow('DELIVERED TO', this.sendToText()),
      // (from a card the FROM FLASHCARD row below says where it is paid from, and PAYING FROM BITCOIN would say otherwise)
      // (with a choice on PAY FROM, the mint and the balance at it: 26l-pay-from.js)
      out ? null : this.cfRow('PAYING FROM', (this.pfMany && this.pfMany('send')) ? this.pfLabel(this.pfHome(), 'sat') : (s.payFrom || 'BITCOIN'), { half: true }),
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
      /* Whose fee it is, in the design's words: a payment that leaves this mint
       * pays the mint's fees, and the payer pays them (C16). */
      /* (from a card, as designed: "~$ 0.01", with nothing under it, in a grid of four with NETWORK, FROM and ARRIVES) */
      this.cfRow('FEE', s.quotedFee != null
        ? (out ? '~' : 'UP TO ') + cfig(s.quotedFee).main
        : held ? 'CHECKING…' : 'UNKNOWN',
        out ? { half: true } : { half: true, sub: s.quotedFee != null ? cfig(s.quotedFee).sub : '', sub2: 'You pay the mint\u2019s fees' }),
    ].filter(Boolean);
    if (out) rows.splice(2, 0, this.cfRow('FROM', 'ECASHCARD', { half: true }));
    /* A dollar card paying a bitcoin invoice: the mint's own rate, read off its quote in dollars. It is said under the amount, as the price
     * every payment from a card is worked out at is, "(at $ 81,967 per bitcoin)" (the shell puts the brackets round it): the mint's for a
     * dollar card, this phone's for a bitcoin card (the design, where it was a RATE row). */
    const cardRate = (cardUsd && this._feeQuote && this._feeQuote.rate) ? Math.round(Number(this._feeQuote.rate.usdPerBtc) || 0) : 0;
    const atPrice = out ? (cardUsd ? cardRate : Math.round((this.px && this.px()) || 0)) : 0;
    const atLine = atPrice > 0 ? 'at $ ' + this.group(atPrice) + ' per bitcoin' : '';
    if ((s.note || '').trim()) rows.push(this.cfRow('NOTE', (s.note || '').trim()));
    /* The keeper's 1l (2026-11-06): a Lightning payment from this phone's balance, its figures stacked, RECEIVER GETS, FEE,
     * PAYING and RECEIVER, and PAYING FROM at the foot, which opens PAY FROM where there is a choice (`cfPayLook`). Not from
     * a card: its confirmation is its own. */
    const payBase = s.quotedAmt != null ? s.quotedAmt : this.sendSatsNow();
    /* What leaves is the sum `pay` refuses on (`payNeed`: the amount, the reserve and the mint's fee on the pieces it
     * spends), never less: at a mint that charges for its pieces the quote's fee alone said less than went. FEE is that
     * less the amount. */
    let payNeedSats = null;
    if (asks && !out && s.quotedFee != null) {
      payNeedSats = payBase + s.quotedFee;
      try {
        const pn = (W && W.payNeed) ? W.payNeed(payBase, s.quotedFee) : null;
        if (pn && pn.need != null && Number(pn.need) > payNeedSats) payNeedSats = Math.round(Number(pn.need));
      } catch (e) { /* the quote's own sum, then */ }
    }
    const payTotal = payNeedSats != null ? this.money(payNeedSats).main : '';
    const look = (sp) => {
      if (!asks || out || !this.cfPayLook) return sp;
      const many = !!(this.pfMany && this.pfMany('send'));
      return this.cfPayLook(sp, {
        gets: this.sendAmountText(),
        fee: payNeedSats != null ? this.money(payNeedSats - payBase).main : held ? 'CHECKING…' : 'UNKNOWN',
        paying: payTotal || (held ? 'CHECKING…' : sp.amount),
        receiver: this.sendToText(),
        word: this.pfLabel ? this.pfLabel(this.pfHome(), 'sat') : String(s.payFrom || 'BITCOIN'),
        go: many ? () => this.openWalletPick() : null,
      });
    };
    /* The code is not a row any more: it is above the amount, the same size,
     * in the accent — the same place and shape as on the receiver's screen, so
     * the two can be held side by side and compared at a glance rather than
     * read. See cfCode in the render values. */
    /* An invoice for more than the balance, before any fee: nothing to wait
     * for, and nothing the fee could change. The invoice alone fitting is not
     * the payment fitting, which is asked once the quote is in, below. */
    const shortOf = (() => {
      // (a dollar card holds cents, and an invoice names sats: the quote in dollars says whether it covers it, below)
      if (cardUsd) return 0;
      if (s.recipientKind !== 'invoice' || !s.recipient || !W || !W.amountOf) return 0;
      const need = W.amountOf(s.recipient) || 0;
      const have = out ? cardHas : (s.balSats || 0);
      return (need && need > have) ? need - have : 0;
    })();
    if (shortOf) {
      return look({
        title: 'CONFIRMATION', amountLabel: 'SENDING',
        amount: this.sendAmountText(),
        amountInk: '#FF5C5C',
        rows: rows,
        // (what this phone holds with the mint is no part of what a card holds: nothing is held back from a card)
        warn: this.heldBlocks(out ? 0 : shortOf) || (out ? 'More than the card holds \u2014 short by ' : 'More than your balance \u2014 short by ') + this.money(shortOf).main,
        cta: 'CLOSE', ctaTone: 'warn', go: () => this.back(),
      });
    }
    /* Typed in dollars: nothing can be sent until two price sources agree on
     * how many sats that is (checkSendPrice). */
    if (s.recipientKind !== 'invoice' && s.unit !== 'SATS' && s.sendPriceCheck !== 'agreed') {
      const failed = s.sendPriceCheck === 'failed';
      return look({
        title: 'CONFIRMATION', amountLabel: 'SENDING',
        amount: '$ ' + this.usd(val),
        amountSub: failed ? '' : 'Checking the price with two sources\u2026',
        rows: rows,
        warn: failed ? 'Two price sources did not agree on the price of bitcoin, so Foxy cannot work out the sats. Nothing was sent.' : '',
        cta: failed ? 'TRY AGAIN' : 'CHECKING THE PRICE\u2026', ctaTone: failed ? 'warn' : 'go',
        go: failed ? () => this.checkSendPrice() : () => {},
      });
    }
    /* Once the fee is quoted: can the balance cover the payment and its fee?
     *
     * The wallet answers with the very sum `pay` refuses on (the amount, the
     * mint's fee reserve, this mint's own fee for the split and its fee again
     * on the pieces the melt spends) against what is held at the mint it pays
     * from, in the words it refuses in (`payNeed`). The invoice alone fitting
     * is not the payment fitting: two invoices a few hundred sats under the
     * balance were offered a SEND button and refused a second later, on the
     * sending screen. So the button is held here and says why, and the way
     * out is back, to the amount screen. A render must not fail on the wallet
     * failing to say, and then SEND is there as it was: `pay` refuses. */
    let covers = null;
    try {
      /* From a card, the card pays: the amount and the fee, with the mint's fee on the pieces they are cut into, against what
       * the card holds (`cardOutTotal`, the very figure NEXT reads off it). */
      if (out && s.quotedFee != null && asks && W && W.cardOutTotal) {
        const total = cardUsd ? W.cardOutTotal(s.quotedAmt, s.quotedFee, 'usd')
          : W.cardOutTotal(s.quotedAmt != null ? s.quotedAmt : this.sendSatsNow(), s.quotedFee);
        covers = total > cardHas
          ? { ok: false, need: total, have: cardHas, why: 'The card holds ' + cfig(cardHas).main + '. This needs ' + cfig(total).main + ' with the mint\u2019s fees.' }
          : { ok: true };
      } else {
        covers = (s.quotedFee != null && asks && W && W.payNeed)
          ? W.payNeed(s.quotedAmt != null ? s.quotedAmt : this.sendSatsNow(), s.quotedFee) : null;
      }
    } catch (e) { covers = null; }
    // a dollar card's headline is what the invoice costs in dollars, at the mint's quote, once it has one
    const cardHead = (cardUsd && s.quotedAmt != null) ? cfig(s.quotedAmt).main : null;
    if (covers && !covers.ok) {
      return look({
        title: 'CONFIRMATION', amountLabel: 'SENDING',
        amount: cardHead || this.sendAmountText(),
        amountInk: '#FF5C5C',
        rows: rows,
        warn: this.heldBlocks(out ? 0 : covers.need - covers.have) || covers.why,
        cta: 'NOT ENOUGH', ctaTone: 'warn', go: () => {},
      });
    }
    const spec = {
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
       * the sending screen that the payment did not fit. While that is being
       * asked, or the connection it is asked over is on its way, the button
       * says CHECKING and does nothing, and the FEE row says the same. */
      // (PAY and what leaves, on the new confirmation: the keeper's 1l)
      cta: held ? 'CHECKING…' : (asks && !out) ? 'PAY ' + (payTotal || this.sendAmountText()) : 'SEND ' + this.sendAmountText(),
      ctaBusy: held,
      ctaTone: 'go',
      go: held ? () => {} : () => this.startSend(),
    };
    // from a card, NEXT, which reads the payment off the card (`fcOutNext`) before anything is paid
    if (out && !held) Object.assign(spec, { cta: 'NEXT', go: () => this.fcOutNext() });
    // a choice of balances on PAY FROM: its button, under the rows, to change it (26l-pay-from.js)
    if (!out && this.pfMany && this.pfMany('send')) spec.wallet = { label: 'PAY FROM', word: this.pfName(this.pfHome()), go: () => this.openWalletPick() };
    // a dollar card: the dollars it pays, and under them the sats the payee is paid
    if (cardHead) {
      const inv = (s.recipientKind === 'invoice' && s.recipient && W && W.amountOf) ? W.amountOf(s.recipient) : 0;
      Object.assign(spec, { amount: cardHead, amountSub: inv ? '₿ ' + this.group(inv) : '' });
    }
    // from a card: the price under the amount, where there is one
    if (out && atLine) spec.amountSub = atLine;
    return look(spec);
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

  /* ---- two balances: dollars and bitcoin at one mint -----------------------
   *
   * A mint may issue dollar ecash beside bitcoin. The wallet keeps each in its
   * own pile and never adds one to the other: an amount is sats, or cents for
   * dollars, and always says which. These are the screens' half of it: which
   * pills the home shows, which balance a flow pays from or into, and the
   * words for them.
   *
   * At a mint that issues only bitcoin, and with a wallet that knows nothing
   * of two balances, `twoUnitsOn` is false and nothing below changes a screen.
   * Every caller asks it the guarded way, because suites lift single methods
   * out of the app and run them on a stand-in that has none of these. */

  /* Does the mint this phone is on issue both? Read from memory every render,
   * and a render must not fail on it. */
  twoUnitsOn() {
    const W = window.FoxyWallet;
    try { return !!(W && W.twoUnits && W.twoUnits()); } catch (e) { return false; }
  }

  /* Paying from a card (SEND on the card's screen, 26f-flashcard.js `fcOutMode`)? A card holds one kind of money, so while
   * it pays, the send flow has the one balance whatever the mint issues: the card's. No CURRENCY question and no WALLET
   * button; a bitcoin card's payment is in sats, and a dollar card's is a melt of its dollars, with the mint's RATE row. */
  cardSendNow() {
    try { return !!(this.fcOutMode && this.fcOutMode()); } catch (e) { return false; }
  }

  /* What the person chose to hold at this mint: 'dollars', 'bitcoin', 'both', or '' never asked there. */
  walletChoiceNow() {
    const W = window.FoxyWallet;
    let c = null;
    try { c = (W && W.walletChoice) ? W.walletChoice() : null; } catch (e) { c = null; }
    return { hold: String((c && c.hold) || '') };
  }

  /* With one currency chosen here, what the other holds that is not a balance of its own: up to what it held as the
   * choice was made (the wallet's `holdKept`: what a swap of all of it left, too little for the mint after its fee,
   * lowered as it is spent). Home draws it as a line under the chosen balance, and a receive does not ask about it.
   * More than that is money that came since: its own pill again. { unit, amount }, or null. */
  holdLeftover() {
    if (!this.twoUnitsOn()) return null;
    const hold = this.walletChoiceNow().hold;
    const unit = hold === 'dollars' ? 'sat' : hold === 'bitcoin' ? 'usd' : '';
    if (!unit) return null;
    const W = window.FoxyWallet;
    let kept = 0;
    try { kept = (W && W.holdKept) ? Math.max(0, Math.round(Number(W.holdKept()) || 0)) : 0; } catch (e) { kept = 0; }
    const have = unit === 'usd' ? Math.round(Number(this.state.balUsdCents) || 0) : Math.round(Number(this.state.balSats) || 0);
    return have > 0 && have <= kept ? { unit: unit, amount: have } : null;
  }

  /* The balance a flow uses: the one picked for this payment; else, where home shows one balance, that one; else ''
   * (and the CURRENCY screen asks). Nothing is remembered from one payment to the next (the owner, 2026-10-22: with
   * more than one balance, each receive and send asks). Always 'sat' at a mint with one balance. `flow` is 'receive'
   * or 'send'. */
  walletNow(flow) {
    /* a till receives in its main, whatever this phone holds: its one currency, or the one chosen to come first in a till that
     * takes both, the keeper's as the one a cashier's code names (26m-till.js, `tillMain`) */
    if (flow === 'receive' && this.tillMain && this.tillMain()) return this.tillMain();
    if (!this.twoUnitsOn()) return 'sat';
    // a card pays in what it holds, whatever balance this phone's own sends use
    // (a card of software 1.23 that holds both: the currency chosen to pay from, `fcUnit`)
    if (flow === 'send' && this.cardSendNow()) return (this.state.fc && (this.fcUnit ? this.fcUnit() : this.state.fc.unit) === 'usd') ? 'usd' : 'sat';
    const s = this.state;
    if (s.wallet === 'usd' || s.wallet === 'sat') return s.wallet;
    const pills = this.homePills();
    return pills.length === 1 ? pills[0] : '';
  }

  /* A balance's name: DOLLARS or BITCOIN, never "Cash Balance". */
  unitWord(unit) { return unit === 'usd' ? 'DOLLARS' : 'BITCOIN'; }

  /* What a WALLET chip or button reads for a balance. */
  walletLabel(unit) { return unit === 'usd' ? 'USD' : 'BITCOIN'; }

  /* An amount in its own unit, as the screens write money: '$ 42.05' for
   * cents, '₿ 51,418' for sats. Never converted. */
  unitFigure(amount, unit) {
    const n = Math.round(Number(amount) || 0);
    const sign = n < 0 ? '−' : '';
    if (unit === 'usd') return sign + '$ ' + this.usd(Math.abs(n) / 100);
    return sign + '₿ ' + this.group(Math.abs(n));
  }

  /* What a balance holds at this mint, as the home shows it: cents for
   * dollars, sats for bitcoin. */
  unitBalance(unit) {
    if (unit === 'usd') return Math.max(0, Math.round(Number(this.state.balUsdCents) || 0));
    return Math.max(0, Math.round(Number(this.balNow().sats) || 0));
  }

  /* The keypad's figure in cents, for a dollar balance: dollars typed are exact ('5.00' is 500, no price in it); sats
   * typed are worth their cents at this phone's price (`unitPx`), and 0 with none. */
  centsTyped() {
    const v = parseFloat(this.state.amount) || 0;
    if (!(v > 0)) return 0;
    if (this.state.unit !== 'SATS') return Math.round(v * 100);
    const px = this.unitPx ? this.unitPx() : 0;
    return px > 0 ? Math.round(v / 1e8 * px * 100) : 0;
  }

  /* The price a figure typed in one unit is put into the other balance's at: this phone's (`px`), but none where the
   * wallet's last price is the one in use and is more than a day old (`priceTooOld`). 0 for none. */
  unitPx() {
    const p = Number(this.px && this.px()) || 0;
    if (!(p > 0)) return 0;
    const W = window.FoxyWallet;
    try {
      const lp = (W && W.lastPrice) ? W.lastPrice() : null;
      if (lp && Number(lp.rate) > 0 && Math.round(Number(lp.rate)) === Math.round(p) && W.priceTooOld && W.priceTooOld(lp.at)) return 0;
    } catch (e) { /* a price that cannot be dated is used as px gives it */ }
    return p;
  }

  /* The pills on home, top to bottom: dollars over bitcoin, or one of them.
   *
   * One at a mint with one balance. With two, what the person chose to hold
   * decides: Dollars or Bitcoin is one pill, Both (or not asked yet) is two,
   * and two stay even at nought so the screen never jumps. Money is never
   * hidden: a balance with something in it keeps its pill whatever was chosen,
   * under the one chosen, unless it is no more than was left there as the
   * choice was made (`holdLeftover`), which is a line under the chosen pill. */
  homePills() {
    if (!this.twoUnitsOn()) return ['sat'];
    const hold = this.walletChoiceNow().hold;
    const left = this.holdLeftover();
    const usd = (Number(this.state.balUsdCents) || 0) > 0 && !(left && left.unit === 'usd');
    const sat = (Number(this.state.balSats) || 0) > 0 && !(left && left.unit === 'sat');
    if (hold === 'dollars') return sat ? ['usd', 'sat'] : ['usd'];
    if (hold === 'bitcoin') return usd ? ['sat', 'usd'] : ['sat'];
    return ['usd', 'sat'];
  }

  /* The CURRENCY screen, for every payment at a mint with two balances.
   *
   * Called on every update. A receive's SET AMOUNT, or a send's SET AMOUNT or
   * CONFIRM PAYMENT, with no balance picked for this payment, is put behind
   * CURRENCY ("What do you want to receive?"). Nothing is remembered: the next
   * receive or send asks again. A home showing one balance (`homePills`) asks
   * nothing; a send asks only when both can pay (`payFromOnly`). */
  syncWalletAsk() {
    const s = this.state;
    const receiving = s.flow === 'receive' && s.screen === 'amount';
    const sending = s.flow === 'send' && (s.screen === 'amount'
      || (s.screen === 'sendConfirm' && (s.recipientKind === 'invoice' || s.recipientKind === 'email')));
    if (!receiving && !sending) return;
    // (a payment from a card is bitcoin only, and is not asked about)
    if (sending && this.cardSendNow()) return;
    if (!this.twoUnitsOn() || this.walletNow(receiving ? 'receive' : 'send')) return;
    /* A send asks only when both balances can pay it, as a card does (`payFromOnly`): where one alone can, it pays
     * with no question, and where neither can, the confirmation says NOT ENOUGH. Neither is remembered: nobody chose. */
    const only = sending && this.payFromOnly ? this.payFromOnly() : '';
    if (only) {
      const unit = only === 'usd' ? 'usd' : 'sat';
      console.log('[foxy] two balances: ' + (only === 'none' ? 'neither covers this send' : 'only ' + this.unitWord(unit).toLowerCase() + ' covers this send') + ', so nothing is asked');
      const patch = { wallet: unit, walletAuto: only !== 'none', walletTapped: false };
      // a dollar balance is typed in dollars, exactly (as `currencyPick`)
      if (unit === 'usd' && s.screen === 'amount' && s.unit !== 'USD') Object.assign(patch, { unit: 'USD', amount: '' });
      this.setState(patch);
      return;
    }
    console.log('[foxy] two balances: asking which one, before ' + s.screen);
    this.setState(p => ({ screen: 'currency', currencyFlow: receiving ? 'receive' : 'send', currencyNext: p.screen }));
  }

  /* Which of this phone's two balances can pay this send, by the card's rule (the owner, 2026-10-22: "phone should
   * behave like card"): the question is asked only when both can. 'usd' or 'sat' where that one alone can, 'none' where
   * neither can, and '' where the question is asked: both can, or one can and the other cannot be told yet. One that
   * cannot be told beside one that cannot pay is no question either: the only one that might pay is the one used, and
   * where it cannot after all the confirmation says NOT ENOUGH, as it would for either. */
  payFromOnly() {
    const s = this.state;
    // on SET AMOUNT nothing is typed yet: only an empty balance is known not to pay
    const sats = s.screen === 'amount' ? 0 : (this.sendSatsNow ? this.sendSatsNow() : 0);
    const usd = this.payFitNow('usd', sats), sat = this.payFitNow('sat', sats);
    if (usd === true && sat === true) return '';
    if (usd === false && sat === false) return 'none';
    if (usd === false) return 'sat';
    if (sat === false) return 'usd';
    return '';
  }

  /* Does `unit` cover `sats` with its fee? true, false, or null where it cannot be told. Its quote where it is in
   * (`quoteFits`); before it is, the wallet's own sum (`payNeed`) with the usual reserve (1%, at least 2 sats or a cent),
   * and for dollars the market price a tenth either way, since the mint's rate is not the market's. In between it is
   * null, and the question is asked as before, CHECKING on the confirmation after it, rather than guessed. */
  payFitNow(unit, sats) {
    const u = unit === 'usd' ? 'usd' : 'sat';
    if (u === 'usd' && this.state.balUsdCents == null) return null;
    if (!(this.unitBalance(u) > 0)) return false;
    if (!(sats > 0)) return null;
    const quoted = this.quoteFits(u);
    if (quoted !== null) return quoted;
    const W = window.FoxyWallet;
    const covers = (amount, reserve) => {
      try { const r = (W && W.payNeed) ? W.payNeed(amount, reserve, { unit: u }) : null; return r ? !!r.ok : null; }
      catch (e) { return null; }
    };
    if (u === 'sat') {
      if (covers(sats, Math.max(2, Math.ceil(sats / 100))) === true) return true;
      return covers(sats, 0) === false ? false : null;
    }
    const px = this.satUsd ? this.satUsd() : null;
    if (!px) return null;
    const cents = sats * px * 100;
    if (covers(Math.ceil(cents * 1.1), Math.max(1, Math.ceil(cents / 100))) === true) return true;
    return covers(Math.floor(cents * 0.9), 0) === false ? false : null;
  }

  /* A card on CURRENCY: the balance for this payment, and this one only. */
  /* Except setting up a Flashcard (`currencyFlow: 'card'`, 26f-flashcard.js `fcUnitAsk`): the pick is what that card will
   * hold, and nothing of this phone's own choice is written. Back to the card's screen, and on with the set-up. */
  currencyPick(unit) {
    const s = this.state;
    if (s.currencyFlow === 'card') {
      const then = this._fcUnitThen;
      this._fcUnitThen = null;
      // (BOTH, offered only where a card of software 1.23 is set up: `curBoth`)
      const picked = unit === 'usd' ? 'usd' : (unit === 'both' && s.curBoth) ? 'both' : 'sat';
      this.setState(p => ({ screen: p.currencyNext || 'flashcard', stack: p.stack.slice(0, -1), currencyFlow: '', curCard: null, curBoth: false }));
      if (then) then(picked);
      return;
    }
    const flow = s.currencyFlow === 'receive' ? 'receive' : 'send';
    const patch = { wallet: unit, walletAuto: false, walletTapped: false,
      screen: s.currencyNext || (flow === 'receive' ? 'amount' : 'sendConfirm') };
    // a dollar balance starts in dollars, exactly; the keypad's swap takes sats as well (`centsTyped`)
    if (unit === 'usd' && s.unit !== 'USD') Object.assign(patch, { unit: 'USD', amount: '' });
    this.setState(patch);
  }

  /* WALLET on CONFIRM PAYMENT: the two balances, with the one that cannot
   * cover this payment greyed (renderCurrency). With a choice of mints on PAY
   * FROM, its list again, the one paying ringed (26l-pay-from.js). */
  openWalletPick() {
    // a choice of mints: PAY FROM again, the source it is paid from ticked (26l-pay-from.js `pfReopen`)
    if (this.pfMany && this.pfMany('send') && this.pfReopen) { this.pfReopen(); return; }
    this.go('walletPick');
  }

  /* A balance picked on WALLET: this payment's. Picked by hand, so it is not
   * switched for the person again. */
  walletPickChoose(unit, why) {
    if (why) { this.toast(why, true); return; }
    this.setState({ wallet: unit, walletAuto: false, walletTapped: true });
    this.back();
  }

  /* The other balance, when the one in use cannot cover the payment and the
   * other can: "Bitcoin was chosen for you". Once. Not after a pick by hand. */
  autoWallet(fits) {
    const s = this.state;
    if (!this.twoUnitsOn() || s.walletTapped || this.cardSendNow()) return;
    const pick = this.walletNow('send') || 'sat';
    const other = pick === 'usd' ? 'sat' : 'usd';
    const mine = fits(pick), alt = fits(other);
    if (mine === false && alt === true) {
      console.log('[foxy] two balances: ' + this.unitWord(pick).toLowerCase() + ' cannot cover this, so '
        + this.unitWord(other).toLowerCase() + ' pays it');
      this.setState({ wallet: other, walletAuto: true });
      this.toast(other === 'sat' ? 'Bitcoin was chosen for you' : 'Dollars were chosen for you');
    }
  }

  /* Does a balance cover what the confirmation has been quoted, on the
   * wallet's own sum (`payNeed`)? true, false, or null where nothing is known. */
  quoteFits(unit) {
    const W = window.FoxyWallet;
    const q = (this.state.feeQ || {})[unit];
    if (!q || !W || !W.payNeed) return null;
    try { const r = W.payNeed(q.amount, q.feeReserve, { unit: unit }); return r ? !!r.ok : null; }
    catch (e) { return null; }
  }

  /* CONFIRM PAYMENT at a mint with two balances, as designed.
   *
   * TOTAL on top, the fee in it, in the balance that pays. Then plain rows: TO,
   * AMOUNT, FEE INCLUDED, NETWORK, and RATE when dollars pay a bitcoin invoice
   * (the mint's own rate, from its quote). The WALLET button is last: it says
   * which balance pays and opens the choice. Waiting and refusing are as in
   * `confirmSpec`: CHECKING while the fee is asked, NOT ENOUGH on the wallet's
   * own sum, the two price sources for an amount typed in dollars. The fee
   * asked about is that of the balance on the WALLET button: CHECKING lets
   * go once its quote is in and it covers the payment, whatever the other's
   * is doing (03-send.js, `feeWaits`). */
  confirmTwoSpec() {
    const s = this.state;
    const W = window.FoxyWallet;
    const wallet = this.walletNow('send') || 'sat';
    const other = wallet === 'usd' ? 'sat' : 'usd';
    const held = this.connecting() || this.sendToAsk() || (this._feeQuotes ? this.feeWaits(wallet) : !!s.quotingFee);
    const q = (s.feeQ || {})[wallet] || null;
    // the sats the payee is paid: the invoice's own, or what was agreed for an address
    const asked = (s.recipientKind === 'invoice' && s.recipient && W && W.amountOf)
      ? (W.amountOf(String(s.recipient)) || 0) : this.typedSats();
    const bracket = (t) => (t ? '(' + t + ')' : '');
    const fig = (n) => (wallet === 'usd' ? { main: this.unitFigure(n, 'usd'), sub: '' } : this.money(n));
    let total = q ? Math.round(Number(q.amount) || 0) + Math.round(Number(q.feeReserve) || 0) : null;
    // what leaves is the sum `pay` refuses on (`payNeed`), never less: the reserve and the mint's fee on the pieces it spends
    if (q && total != null && W && W.payNeed) {
      try {
        const pn = W.payNeed(q.amount, q.feeReserve, { unit: wallet });
        if (pn && pn.need != null && Number(pn.need) > total) total = Math.round(Number(pn.need));
      } catch (e) { /* the quote's own sum, then */ }
    }
    const rows = [
      this.cfRow('TO', this.sendToText()),
      this.cfRow('AMOUNT', q ? fig(q.amount).main : this.sendAmountText(), {
        // dollars paying bitcoin: what the payee is paid, in sats, under it
        sub: wallet === 'usd' ? (asked ? bracket('₿ ' + this.group(asked)) : '') : bracket(q ? fig(q.amount).sub : ''),
      }),
      this.cfRow('FEE INCLUDED', q ? fig(q.feeReserve).main : held ? 'CHECKING…' : 'UNKNOWN',
        { sub: (q && wallet === 'sat') ? bracket(fig(q.feeReserve).sub) : '', sub2: 'You pay the mint\u2019s fees' }),
      this.cfRow('NETWORK', 'LIGHTNING'),
    ];
    // a choice of mints on PAY FROM: which mint and which balance, and the button that changes it says PAY FROM (26l-pay-from.js)
    const many = !!(this.pfMany && this.pfMany('send'));
    if (many) rows.push(this.cfRow('PAYING FROM', this.pfLabel(this.pfHome(), wallet)));
    const rate = q && q.rate ? Math.round(Number(q.rate.usdPerBtc) || 0) : 0;
    if (wallet === 'usd' && rate > 0) {
      const who = String(this.mintName() || 'the mint');
      rows.push(this.cfRow('RATE', '₿ 1 = $ ' + this.group(rate) + ' · '
        + who + (/s$/i.test(who) ? '’' : '’s') + ' rate'));
    }
    if ((s.note || '').trim()) rows.push(this.cfRow('NOTE', (s.note || '').trim()));
    /* Dollars paying a bitcoin invoice that came over a tap with the asker's
     * price on it: how far the mint's dollars are from what their price makes
     * of the sats (26k-price-line.js). The dollars are the big number, as the
     * unit that pays; the mint's rate is the one they are worked out at. */
    const askRate = (wallet === 'usd' && s.askRateFor && s.askRateFor === s.recipient) ? Number(s.askRate) || 0 : 0;
    const diffLine = (askRate > 0 && rate > 0 && asked > 0 && this.priceDiffLine)
      ? this.priceDiffLine({ askUnit: 'sat', askAmount: asked, payUnit: 'usd', askerRate: askRate,
                             askerAgeMs: Math.max(0, Date.now() - (Number(s.askRateAt) || Date.now())), payerRate: rate, payerAgeMs: 0,
                             ownWord: 'the mint\u2019s', slackCents: 1 })
      : null;
    const base = {
      // (CONFIRMATION, as the keeper drew 1l on 2026-11-06)
      title: 'CONFIRMATION', titleUp: true, amountLabel: 'TOTAL', rows: rows, diffLine: diffLine,
      wallet: Object.assign({ word: this.walletLabel(wallet), go: () => this.openWalletPick() }, many ? { label: 'PAY FROM' } : {}),
      close: () => this.setState({ screen: 'home', stack: [] }),
      // the figure in ink, as drawn; red only when it cannot be paid
      amountInk: 'var(--ink)',
    };
    /* The keeper's 1l (2026-11-06): the same figures stacked, in the balance that pays (the sats the payee is paid under
     * RECEIVER GETS where dollars pay), and PAYING FROM's pill naming the mint and the balance, which opens the choice
     * between them, or PAY FROM where other mints could pay too (`openWalletPick`). */
    const look = (sp) => (!this.cfPayLook ? sp : this.cfPayLook(sp, {
      gets: q ? fig(q.amount).main : this.sendAmountText(),
      getsSub: (wallet === 'usd' && asked) ? '₿ ' + this.group(asked) : '',
      fee: (q && total != null) ? fig(total - Math.round(Number(q.amount) || 0)).main : held ? 'CHECKING…' : 'UNKNOWN',
      paying: total != null ? fig(total).main : held ? 'CHECKING…' : sp.amount,
      receiver: this.sendToText(),
      word: this.pfLabel ? this.pfLabel(this.pfHome ? this.pfHome() : '', wallet) : this.walletLabel(wallet),
      go: () => this.openWalletPick(),
    }));
    /* Typed in dollars to an address: the address is asked in sats, so two
     * price sources agree on them first (checkSendPrice), whichever balance
     * then pays. */
    if (s.recipientKind !== 'invoice' && s.unit !== 'SATS' && s.sendPriceCheck !== 'agreed') {
      const failed = s.sendPriceCheck === 'failed';
      const val = parseFloat(s.amount) || 0;
      return look(Object.assign(base, {
        amount: '$ ' + this.usd(val),
        amountSub: failed ? '' : 'Checking the price with two sources…',
        warn: failed ? 'Two price sources did not agree on the price of bitcoin, so Foxy cannot work out the sats. Nothing was sent.' : '',
        cta: failed ? 'TRY AGAIN' : 'CHECKING THE PRICE…', ctaTone: failed ? 'warn' : 'go',
        go: failed ? () => this.checkSendPrice() : () => {},
      }));
    }
    const fits = this.quoteFits(wallet);
    // short, with the other balance's quote still to come: CHECKING, since that one may pay it (`autoWallet`)
    if (fits === false && !this.feeWaits(wallet)) {
      const both = this.quoteFits(other) !== true;
      const W2 = window.FoxyWallet;
      let why = '';
      try { why = (W2 && W2.payNeed && q) ? String((W2.payNeed(q.amount, q.feeReserve, { unit: wallet }) || {}).why || '') : ''; } catch (e) { why = ''; }
      return look(Object.assign(base, {
        amount: total != null ? fig(total).main : this.sendAmountText(),
        amountSub: (total != null && wallet === 'sat') ? fig(total).sub : '',
        amountInk: '#FF5C5C',
        warn: both
          ? 'Neither balance covers this. You hold ' + this.unitFigure(this.unitBalance('usd'), 'usd')
            + ' and ' + this.unitFigure(this.unitBalance('sat'), 'sat') + '.'
          : (wallet === 'sat' && this.heldBlocks && q ? this.heldBlocks(total - this.unitBalance('sat')) : '') || why
            || 'More than your ' + this.unitWord(wallet).toLowerCase() + '.',
        cta: 'NOT ENOUGH', ctaTone: 'warn', go: () => {},
      }));
    }
    return look(Object.assign(base, {
      amount: total != null ? fig(total).main : this.sendAmountText(),
      amountSub: (total != null && wallet === 'sat') ? fig(total).sub : '',
      // PAY and what leaves (the keeper's 1l)
      cta: held ? 'CHECKING…' : 'PAY' + (total != null ? ' ' + fig(total).main : ''),
      ctaBusy: held,
      ctaTone: 'go',
      go: held ? () => {} : () => this.startSend(),
    }));
  }
