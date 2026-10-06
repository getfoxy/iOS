
  /* ---- the render ------------------------------------------------------------
   *
   * The renderer (build/foxy-render.js) calls renderVals() on every render and
   * hands what it returns to the template: every {{ binding }} in
   * build/markup.html is a key of it. renderValsBase() gathers them from one
   * function per screen, in parts 22 to 28, and splitVals() in part 20;
   * renderVals() adds the home menu on top. renderContext() is what more than
   * one of those functions reads.
   *
   * tests/render-snapshots.js renders every screen, card and dialog and compares
   * the markup with what it was. */

  /** @typedef {ReturnType<Component["renderContext"]>} RenderContext */

  renderVals() {
    const v = /** @type {ReturnType<Component["renderValsBase"]> & {
      clearHistory: () => void, clearContacts: () => void, open0: boolean, rot0: string,
      toggleMenu: () => void, homeButtons: object[], menuItems: object[], menuAlert: string,
      mintHostLabel: string, qrSrc: string, pageHash: string,
      menuRingInk: string, menuRingInk2: string, menuRing: string,
      histRingInk: string, histRingInk2: string, histRing: string,
    }} */ (this.renderValsBase());
    /* Home's four buttons, icons only: SPLIT, CONTACTS, HISTORY, SETTINGS. SETTINGS
     * lays its own four, labelled, over the same places: RESTORE, BACKUP, the
     * PIN and CLOSE. Switching mints is the balance pill's,
     * and history's. */
    const MENU_ICON = {
      dollars: 'M12 3v18M16.6 7.6c-.8-1.4-2.5-2.1-4.6-2.1-2.5 0-4.2 1.2-4.2 3.1 0 4.6 9.2 2.1 9.2 6.7 0 2-1.9 3.2-4.7 3.2-2.3 0-4.1-.8-4.9-2.3',
      history: 'M12 7v5l3.5 2M12 3.5a8.5 8.5 0 1 0 8.5 8.5A8.5 8.5 0 0 0 12 3.5Z',
      hide: 'm3.5 3.5 17 17M10.6 6.2A9.4 9.4 0 0 1 12 6c5 0 8.5 6 8.5 6a15 15 0 0 1-2.2 3M6.3 8A15.4 15.4 0 0 0 3.5 12s3.5 6 8.5 6a9 9 0 0 0 3.2-.6',
      contacts: 'M15.5 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H7.4A3.4 3.4 0 0 0 4 18.4V20M9.75 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5M20 20v-1.6a3.4 3.4 0 0 0-2.6-3.3M15.4 4.2a3.4 3.4 0 0 1 0 6.6',
      split: 'M10.4 3.2H5.6v17.6l2-1.3 2 1.3 .8-.5M13.6 3.2h4.8v17.6l-2-1.3-2 1.3-.8-.5M12 2.2v3.2m0 2.4v3.2m0 2.4v3.2m0 2.4v1.4',
      support: 'M12 20.4S3.6 15.3 3.6 9.5A4.2 4.2 0 0 1 12 7.4a4.2 4.2 0 0 1 8.4 2.1c0 5.8-8.4 10.9-8.4 10.9z',
      backup: 'M12 3.5 4.8 6.6v5.1c0 4.4 3.1 7.8 7.2 8.8 4.1-1 7.2-4.4 7.2-8.8V6.6zM9 12l2.2 2.2L15.4 10',
      transfer: 'M4 8.5h13m0 0-3.4-3.4M17 8.5l-3.4 3.4M20 15.5H7m0 0 3.4-3.4M7 15.5l3.4 3.4',
      restore: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.4 4.6v4.2h4.2M12 7.6V12l3 1.8',
      lock: 'M6.4 10.4V7.6a5.6 5.6 0 0 1 11.2 0v2.8M5.2 10.4h13.6a1.4 1.4 0 0 1 1.4 1.4v7.4a1.4 1.4 0 0 1-1.4 1.4H5.2a1.4 1.4 0 0 1-1.4-1.4v-7.4a1.4 1.4 0 0 1 1.4-1.4Z',
      settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.2 13.4l1.8 1.4-1.9 3.3-2.1-.8a7.3 7.3 0 0 1-2 1.2l-.3 2.2h-3.8l-.3-2.2a7.3 7.3 0 0 1-2-1.2l-2.1.8-1.9-3.3 1.8-1.4a7.3 7.3 0 0 1 0-2.8L3.6 9.2l1.9-3.3 2.1.8a7.3 7.3 0 0 1 2-1.2l.3-2.2h3.8l.3 2.2a7.3 7.3 0 0 1 2 1.2l2.1-.8 1.9 3.3-1.8 1.4a7.3 7.3 0 0 1 0 2.8Z',
      close: 'M6 6l12 12M18 6L6 18',
      bars: 'M4 7h16M4 12h16M4 17h16',
      // a face in a frame: the corners of a viewfinder, two eyes and a smile
      faceid: 'M4 8.5v-3a1.5 1.5 0 0 1 1.5-1.5h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3'
        + 'M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3'
        + 'M9 9.8v1.6M15 9.8v1.6M9.2 14.8a3.6 3.6 0 0 0 5.6 0',
      switch: 'M7.5 4.5 4 8l3.5 3.5M4 8h12.5a3.5 3.5 0 0 1 0 7H15M16.5 19.5 20 16l-3.5-3.5',
      scan: 'M3.5 8.5v-3a2 2 0 0 1 2-2h3M15.5 3.5h3a2 2 0 0 1 2 2v3M20.5 15.5v3a2 2 0 0 1-2 2h-3M8.5 20.5h-3a2 2 0 0 1-2-2v-3M3.5 12h17',
      paste: 'M9 4.5h6M8.2 6.5H6.4A1.9 1.9 0 0 0 4.5 8.4v10.2a1.9 1.9 0 0 0 1.9 1.9h11.2a1.9 1.9 0 0 0 1.9-1.9V8.4a1.9 1.9 0 0 0-1.9-1.9h-1.8M8.6 3.5h6.8v3H8.6z',
      // the contactless mark: three arcs from a point off the left edge
      tap: 'M7.75 9A3.5 3.5 0 0 1 7.75 15M9.25 6.4A6.5 6.5 0 0 1 9.25 17.6M10.75 3.8A9.5 9.5 0 0 1 10.75 20.2',
      // a warning triangle with a bar and a dot
      errors: 'M12 4.2 3.2 19.2h17.6L12 4.2zM12 10v4M12 16.6v.6',
      // lines on a page, the last one short
      logs: 'M6 3.5h9l3.5 3.5v13.5H6zM15 3.5V7h3.5M9 11.5h6M9 14.5h6M9 17.5h3',
      // a payment card: its outline, the stripe across it, a short line of print
      card: 'M4.6 5.5h14.8a2.1 2.1 0 0 1 2.1 2.1v8.8a2.1 2.1 0 0 1-2.1 2.1H4.6a2.1 2.1 0 0 1-2.1-2.1V7.6a2.1 2.1 0 0 1 2.1-2.1ZM2.5 10h19M6 15h4',
      // three coins of different sizes: the pieces themselves, not a wallet
      change: 'M8.5 7.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM15.5 4.5a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM16.5 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    };
    const shut = (fn) => () => { this.setState({ open0: false }); if (fn) fn(); };
    // the mockup's balance pill: taller, with a soft orange halo that
    // brightens rather than appears when a payment lands
    // the price gave back its height, so the pill takes it
    v.pillH = this.state.priceCollapsed ? 124 : 120;
    /* The pill's resting glow. It was bitcoin orange around a bitcoin-orange
     * pill; the pill is frost now and so is this, except at the moment sats
     * land, which keeps its orange. */
    v.balGlowBtc = /rgba\(247,147,26,\.85\)/.test(v.balGlowBtc || '')
      ? v.balGlowBtc
      : '0 0 30px 2px rgba(207,224,236,.22)';
    v.clearHistory = () => this.askClear('history');
    v.clearContacts = () => this.askClear('contacts');
    v.open0 = !!this.state.open0;
    v.rot0 = this.state.open0 ? 'rotate(90deg)' : 'rotate(0deg)';
    v.toggleMenu = () => this.setState(p => ({ open0: !p.open0 }));
    /* SCAN and PASTE are the two ways money arrives at a phone, so they are on
     * home rather than a screen in. PASTE carries the marker
     * Apple's paste control is laid over (15-paid-wake-keyboard.js).
     *
     * There is no TAP here. There was, for a day, when the
     * payer was the phone on the air and a button was the only honest way to
     * say so — pressing it was the arming.
     *
     * The roles are the other way round now (TapLink.swift): the merchant's
     * phone advertises when they press TAP, and this one simply listens from
     * home and from SEND. Listening emits nothing, needs no permission from
     * the person holding the phone and has nothing to arm, so a button here
     * would do nothing but take up a third of the row. Holding this phone
     * against a merchant's still works; it just never needed asking for. */
    v.homeButtons = [
      // the fur turned around on SCAN; its icon and label are turned back
      { label: 'SCAN', path: MENU_ICON.scan, tap: v.goScan, spin: 'rotate(180deg)' },
      { label: 'PASTE', path: MENU_ICON.paste, tap: v.pickPaste, pasteHere: '1' },
    ].map(b => Object.assign({ pasteHere: '', spin: 'none' }, b));
    /* The menu drawer, from the right: everything that is not RECEIVE, SEND,
     * SCAN, PASTE or HISTORY. */
    /* A balance with no verified backup: the menu button and BACKUP glow red,
     * so the way to fix it is visible from home. */
    const unbacked = !!(window.FoxyWallet && window.FoxyWallet.backedUp
      && !window.FoxyWallet.backedUp() && (this.state.balSats || 0) > 0);
    v.menuAlert = unbacked ? 'alertGlow 10.4s ease-in-out infinite' : 'none';
    /* A red ring turning on the menu button, and on BACKUP inside it: words
     * that hold money and have never been written down and checked. The glow
     * above says something; a ring that is going says it is not finished. */
    const RED = '#FF5C5C';
    const backupRing = {
      ringInk: unbacked ? RED : 'transparent',
      ringInk2: unbacked ? 'rgba(255,92,92,.28)' : 'transparent',
      ring: unbacked ? 'foxyRing 1.15s linear infinite' : 'none',
    };
    v.menuRingInk = backupRing.ringInk;
    v.menuRingInk2 = backupRing.ringInk2;
    v.menuRing = backupRing.ring;

    /* And an amber one on the history button for money that is out there and
     * not yet finished: a payment the mint is still broadcasting, ecash handed
     * over that nobody has redeemed, or a bill still being collected. Every one
     * of them is a row in history, which is where the ring points. */
    const W21 = window.FoxyWallet;
    /* Every one of these is asked of the wallet on every render, and a render
     * that throws takes the whole screen with it — so each is read as "a list
     * if it gave me one, otherwise none". A stand-in wallet in the tests
     * answers undefined, and so does a real one before it has connected. */
    const someOf = (fn) => { try { const r = fn && fn(); return (r && r.length) || 0; } catch (e) { return 0; } };
    const splitOpen = () => {
      try { const sp = W21 && W21.splitPending && W21.splitPending(); return !!(sp && !sp.done); }
      catch (e) { return false; }
    };
    const waiting = !!(W21 && (
      someOf(W21.onchainSending) || someOf(W21.watchedTokens) || splitOpen()
    ));
    /* Red, not amber, and it wins.
     *
     * Every other thing this ring turns for is money in Foxy's own hands that
     * needs time: a broadcast, a redeem, a bill being collected. Nobody can take
     * those away. A payment taken on trust while both phones were offline is the
     * one kind that somebody else can still make disappear, and it is counted in
     * the balance while they can. A person glancing at the home screen should be
     * able to tell those two apart without opening anything.
     *
     * It stops turning the moment the payment is swapped in, because that is the
     * moment the risk ends — the claim drops the row. */
    /* And ecash another phone has seen and refused without sending it back
     * (`atRisk`): in the balance, spendable, and somebody else's to redeem
     * until this phone has swapped it. The same ring, for the same reason. */
    const atRisk = someOf(W21 && W21.trustedWaiting) || someOf(W21 && W21.atRisk);
    const AMBER = '#F7931A';
    const RISK_RED = '#FF5C5C';
    /* And for the audit: red while the balance and the payments disagree,
     * and red too while change is waiting to be scanned or shown. The card is on
     * the history screen; this is what says to go and look. */
    const AU = this.histAudit ? this.histAudit() : { whole: false, off: 0, dueChange: 0, toShowCount: 0 };
    /* Not at the first sign of it. The balance is read a moment before the
     * payment's row is — twelve seconds apart on an older phone after a tap
     * that fell back to a code — and for that long the two disagree about a payment
     * both are about to agree on. History is read again at once, and the ring
     * turns red only if they still disagree four seconds on. */
    if (AU.whole && AU.off !== 0) {
      if (!this._offSince) {
        this._offSince = Date.now();
        clearTimeout(this._offT);
        this._offT = setTimeout(() => {
          if (this.loadHistory) this.loadHistory();
          this._offT = setTimeout(() => this.setState({ menuTick: (this.state.menuTick || 0) + 1 }), 2800);
        }, 1400);
      }
    } else {
      this._offSince = 0;
      clearTimeout(this._offT);
    }
    const short = !!this._offSince && Date.now() - this._offSince >= 4000;
    const changeTodo = AU.dueChange > 0 || AU.toShowCount > 0;
    v.histRingInk = (atRisk || short || changeTodo) ? RISK_RED : waiting ? AMBER : 'transparent';
    v.histRingInk2 = (atRisk || short || changeTodo) ? 'rgba(255,92,92,.28)'
      : waiting ? 'rgba(247,147,26,.28)' : 'transparent';
    v.histRing = (atRisk || waiting || short || changeTodo) ? 'foxyRing 1.5s linear infinite' : 'none';
    /* The drawer, in this order:
     *
     *   BACKUP (only while the words are unverified — verified, it lives at
     *     the foot of SETTINGS)
     *   HIDE BALANCE · SPLIT A BILL · CONTACTS
     *   TRANSFER (only with money at more than one mint)
     *   SWITCH · YOUR CHANGE
     *   SETTINGS, which opens and closes in place:
     *     AUTO TAP TO PAY and USE FACE ID as switches, SET PIN, RESTORE,
     *     BACKUP, LOGS
     *
     * ERRORS is gone: it was the same log with a filter on it. Rows inside
     * SETTINGS are indented; a switch shows its state, so its label never has
     * to — which is what the REMOVE/STOP verbs were for. */
    const W22 = window.FoxyWallet;
    const verified = !!(W22 && W22.backedUp && W22.backedUp());
    const mintsWithMoney = (() => {
      try {
        const list = (W22 && W22.mints ? W22.mints() : []) || [];
        return list.filter(m => W22.balanceAt && W22.balanceAt(String((m && m.id) || m)) > 0).length;
      } catch (e) { return 0; }
    })();
    const settingsOpen = !!this.state.menuSettingsOpen;
    const tapAuto = this.tapAutoArms();
    const faceOn = !!(W22 && W22.secureChoice && W22.secureChoice() === 'device');
    const backupRow = { label: 'BACKUP', path: MENU_ICON.backup, tap: shut(() => this.showSeedOnPhone(false)),
      glow: unbacked ? 'alertGlow 10.4s ease-in-out infinite' : 'none',
      ringInk: backupRing.ringInk, ringInk2: backupRing.ringInk2, ring: backupRing.ring };
    const inSettings = (m) => Object.assign({ indent: '10px' }, m);
    const sw = (on) => ({ hasSwitch: true, swBg: on ? 'var(--acc)' : 'rgba(var(--ink-rgb),.22)', swX: on ? '18px' : '0px' });
    v.menuItems = /** @type {any[]} */ (verified ? [] : [backupRow]).concat([
      /* Hiding the balance moved here from the pill, where its button sat on
       * top of the figures. The label says what the tap
       * will do, so it reads the same whichever way round it is. */
      { label: this.state.hidden ? 'SHOW BALANCE' : 'HIDE BALANCE',
        path: MENU_ICON.hide, tap: shut(v.toggleHide) },
      { label: 'SPLIT A BILL', path: MENU_ICON.split, tap: shut(v.goSplit) },
      { label: 'CONTACTS', path: MENU_ICON.contacts, tap: shut(v.goContacts) },
    ]).concat(mintsWithMoney > 1 ? [
      { label: 'TRANSFER', path: MENU_ICON.transfer, tap: shut(() => this.goTransfer()) },
    ] : []).concat([
      { label: 'SWITCH', path: MENU_ICON.switch,
        tap: shut(() => this.goSwitchMint()) },
      /* What the pool actually holds, which decides whether this phone can pay an
       * exact amount at all — the one question an offline payer has and no other
       * screen answers. */
      { label: 'YOUR CHANGE', path: MENU_ICON.change, tap: shut(() => this.goChange()) },
      /* A card that holds ecash: what is on it, money on and off it, and the
       * cards this phone can take back (26f-flashcard.js). */
      { label: 'FLASHCARD', path: MENU_ICON.card, tap: shut(() => this.goFlashcard()) },
      /* Where bitcoin becomes dollars in a bank account: a list of companies
       * and nothing more. Foxy pays none of them itself. */
      { label: 'GET DOLLARS', path: MENU_ICON.dollars, tap: shut(() => this.showGetDollars()) },
      // opens and closes in place; the drawer stays
      { label: 'SETTINGS', path: MENU_ICON.settings, hasChev: true, chevRot: settingsOpen ? 'rotate(90deg)' : 'rotate(0deg)',
        tap: () => this.setState({ menuSettingsOpen: !settingsOpen }) },
    ]).concat(!settingsOpen ? [] : /** @type {any[]} */ ([
      /* Whether an invoice goes on the air by itself. A switch, and the
       * drawer stays open so it can be seen to move. */
      Object.assign({ label: 'AUTO TAP TO PAY', path: MENU_ICON.change,
        tap: () => { this.tapAutoSet(!tapAuto); this.setState({ menuTick: (this.state.menuTick || 0) + 1 }); } }, sw(tapAuto)),
      /* What stands in front of the wallet, changed after the SECURE FOXY card
       * has been and gone (10-pin.js). Pressing it answers `device`, which
       * locks the screen and keeps the seed where it already was; turning it
       * off is never one tap (confirmNoProtection). One row, two things, and
       * that is deliberate: this answer guards the seed AND locks the screen.
       * Nobody having answered reads as off, which is what `faceLock()` does
       * with it. */
      Object.assign({
        label: 'USE FACE ID',
        path: MENU_ICON.faceid,
        tap: shut(() => {
          const W = window.FoxyWallet;
          if (!W || !W.secureChoice) return;
          if (W.secureChoice() !== 'device') { this.chooseProtection('device'); return; }
          // taking a guard off is never one tap
          this.confirmNoProtection();
        }),
      }, sw(faceOn)),
      /* The label is the tap, not the state: SET, REMOVE — a verb cannot be
       * read as a state. */
      {
        label: (window.FoxyWallet && window.FoxyWallet.pinIsSet
          && window.FoxyWallet.pinIsSet()) ? 'REMOVE PIN' : 'SET PIN',
        path: MENU_ICON.lock,
        tap: shut(() => {
          const W = window.FoxyWallet;
          if (W.pinIsSet()) {
            // turning it off asks for it first, or it is not a lock
            this.pinOverlay({
              title: 'ENTER YOUR PIN',
              subtitle: 'To turn the lock off.',
              cta: 'TURN OFF',
              onCancel: () => {},
              onSubmit: (pin, warn) => {
                // the lock's own attempt count and wait: this used to check
                // the PIN directly, with neither
                const r = this.pinTry(pin);
                if (!r.ok) { warn(r.message); return; }
                W.pinClear();
                this.pinDismiss();
                this.toast('PIN removed');
              },
            });
            return;
          }
          this.pinSetup(() => {});
        }),
      },
      /* The phone's own screens, straight over home: no Foxy screen before
       * RESTORE A WALLET or after YOUR SEED PHRASE. */
      { label: 'RESTORE', path: MENU_ICON.restore, tap: shut(() => this.restoreFromMenu()) },
    ]).concat(verified ? [backupRow] : []).concat([
      /* Everything that happened, errors among them. Kept on the phone and
       * copied out by hand — there is no reporting of any kind behind it. */
      { label: 'LOGS', path: MENU_ICON.logs, tap: shut(() => this.goFieldLog(false)) },
    ]).map(inSettings)).map(m => Object.assign({ glow: 'none', ringInk: 'transparent',
      ringInk2: 'transparent', ring: 'none', indent: '0px', hasSwitch: false, swBg: 'transparent',
      swX: '0px', hasChev: false, chevRot: 'rotate(0deg)' }, m));
    /* The page's own hash, quiet at the foot of the drawer.
     *
     * The native side hashes the files it staged at launch and sets
     * window.__foxyPageHash before any of this script runs
     * (FoxyWebView.manifestHash). `python3 tools/page-hash.py` prints the same
     * string from the repository, so someone holding the phone can tell whether
     * it is running the page that was reviewed — which nothing here could show
     * before. Twelve characters is enough to compare by eye and short enough to
     * stay one line.
     *
     * Empty when the page is not in the app — the test harness, a browser — and
     * an empty div takes no height, so the drawer is unchanged there. */
    const pageHash = String(window.__foxyPageHash || '').replace(/[^0-9a-f]/g, '');
    v.pageHash = pageHash ? 'page ' + pageHash.slice(0, 12) : '';
    v.mintHostLabel = this.mintName() || 'the mint';
    // CASHU: the payment request for the same amount (railRequest), else the invoice
    /* Only while the receive screen is up. CASHU is remembered, so without the
     * screen test this made a request — and an onion address — on every render
     * of every screen, which syncInbox then closed: dozens of addresses a
     * minute, and the one in the QR already dead (seen in a phone log). */
    const onchainRail = this.state.screen === 'confirm' && this.state.recvRail === 'ON-CHAIN' && !!window.FoxyWallet;
    const onchainCode = onchainRail
      ? (this.ocReceiveAddress() ? window.FoxyWallet.bip21(this.ocReceiveAddress(),
        this.state.invoiceIsAddress ? 0 : window.FoxyWallet.amountOf(this.state.invoice)) : '') : '';
    const cashuRail = this.state.screen === 'confirm' && this.state.recvRail === 'CASHU' && !!window.FoxyWallet;
    /* The amount the person asked for, not the one read back out of the
     * Lightning invoice: a CASHU request made before the invoice had landed
     * was built for nothing and shown to the payer as "pay any amount". cashuRequest decides what there is to show, and
     * returns '' whenever the answer is "not yet" — which is what puts the
     * loading animation on the QR below. */
    const creq = cashuRail ? this.cashuRequest() : '';
    // CASHU while its request is being made: the loading code, not the invoice's
    /* A request being animated is drawn by `syncReqQr`, frame by frame, and
     * this must not draw over it.
     *
     * Both write to the same image: the animator sets `src` directly every
     * 200 ms, and a render would put the one dense static code back. They
     * fought, and the code on screen was a frame or the unreadable static one
     * depending on which wrote last — which is a code that scans once and then
     * never again. So while it animates, this shows
     * the animator's current frame, which is the same thing the token screen
     * does with `_tokQr`. */
    const dense = !!(creq && this.qrDense(creq));
    /* THIS request's frame, not whichever one the animator happens to hold.
     *
     * The token screen has always checked that (`_tokQr.token === tk`). This
     * did not — so a second request drew the PREVIOUS request's frames into its
     * image, for at least as long as it took the animator to notice, and a code
     * assembled from two different requests is a code that never assembles.
     * That is "it works once and then the QRs do not work again". */
    const frame = (this._reqQr && this._reqQr.text === creq && this._reqQr.src)
      ? this._reqQr.src : '';
    v.qrSrc = onchainCode ? window.FoxyWallet.qr(onchainCode)
      : onchainRail ? this.qrLoadingSrc()
      : (creq && dense) ? (frame || this.qrLoadingSrc())
      : creq ? window.FoxyWallet.qr(creq) : cashuRail ? this.qrLoadingSrc()
      : (this.state.invoice && window.FoxyWallet)
      ? window.FoxyWallet.qr(this.state.invoice)
      : this.qrLoadingSrc();
    this.noteQr(v.qrSrc, {
      rail: onchainCode ? 'on-chain' : cashuRail ? 'cashu' : 'lightning',
      from: onchainCode ? 'address' : creq ? 'request' : this.state.invoice ? 'invoice' : 'nothing',
      chars: String(onchainCode || creq || this.state.invoice || '').length,
      dense: dense, animating: !!(creq && dense && frame),
    });
    return v;
  }

  /* Every binding the markup reads, one screen at a time. A key belongs to the
   * screen whose markup binds it (build/app/README.md lists the functions); none
   * is defined twice, so the order below decides nothing. */
  renderValsBase() {
    const c = this.renderContext();
    return {
      ...this.renderShell(c),
      ...this.renderNote(c),
      ...this.renderHome(c),
      ...this.renderAmount(c),
      ...this.renderReceive(c),
      ...this.renderPaid(c),
      ...this.renderSend(c),
      ...this.renderSent(c),
      ...this.renderToken(c),
      ...this.renderConfirmShell(c),
      ...this.renderBlocked(c),
      ...this.renderHistory(c),
      ...this.renderTxDetail(c),
      ...this.renderContacts(c),
      ...this.renderMints(c),
      ...this.renderFlashcard(c),
      ...this.renderNewMint(c),
      ...this.renderRestore(c),
      ...this.renderBackup(c),
      ...this.splitVals(c.s, c.sc),
      ...this.renderFieldLog(c),
    };
  }

  /* fieldLog: the ERRORS and LOGS screen (28-field-log.js). */
  /** @param {RenderContext} c */
  renderFieldLog(c) {
    const { s, sc } = c;
    const lines = s.flLines;
    /* Drawn: the newest 1,500. The log holds 10,000 while Foxy is in testing,
     * and that many rows on one screen is a screen that will not scroll. COPY
     * ALL and SHARE still hand over every line. */
    const FL_SHOWN = 1500;
    const rows = (lines || []).slice(0, FL_SHOWN).map((l, i) => ({
      key: 'fl' + i,
      time: this.flStamp(l.at),
      text: String(l.text || ''),
      ink: l.bad ? '#FF5C5C' : 'var(--ink)',
    }));
    const pieces = (sc === 'change' && window.FoxyWallet && window.FoxyWallet.pieces)
      ? window.FoxyWallet.pieces() : [];
    const held = pieces.reduce((a, r) => a + r.count, 0);
    const worth = pieces.reduce((a, r) => a + (r.amount * r.count), 0);
    /* Short counts only denominations the pool is aiming for: a pile holding three
     * 4096s, which nothing targets, is not short of anything. `pieces` lists the
     * small tier even at none held, so a missing denomination is counted here
     * rather than silently absent. */
    const short = pieces.filter(r => r.want && r.count < r.want).length;
    return {
      isChange: sc === 'change',
      chRows: pieces.map(r => ({
        amount: this.group(r.amount),
        count: String(r.count),
        /* The target beside the count, or nothing where there is none: a bare
         * "of 12" against a denomination the pool does not keep would read as a
         * shortfall that is not one. */
        want: r.want ? 'of ' + r.want : '',
        /* Amber where the pool is short of its target, plain where it is met.
         * Never red: being short of small change is not a fault, it is a thing
         * that fixes itself the next time there is a route. */
        ink: (r.want && r.count < r.want) ? '#E6D8A8' : 'var(--ink)',
      })),
      chHasRows: pieces.length > 0,
      chTitle: 'YOUR CHANGE',
      chSub: !pieces.length ? 'No ecash on this phone yet.'
        : held + ' piece' + (held === 1 ? '' : 's') + ', worth \u20bf' + this.group(worth),
      /* Said plainly, because the number of pieces is the whole reason this
       * screen exists: it is what decides whether an exact amount can be paid
       * with no mint, and offline that is the only way to pay at all. */
      chNote: 'Foxy keeps small pieces on hand so it can pay an exact amount without'
        + ' asking the mint — which is the only way to pay with no connection. It tops'
        + ' them up by itself when it has one.',
      chShort: short > 0,
      isFieldLog: sc === 'fieldLog',
      flTitle: s.flBad ? 'ERRORS' : 'LOGS',
      flSub: lines === null ? 'Reading…'
        : !rows.length ? (s.flBad ? 'Nothing has gone wrong.' : 'Nothing recorded yet.')
        : (lines.length > FL_SHOWN
          ? lines.length + ' lines; the newest ' + FL_SHOWN + ' shown, SHARE sends them all'
          : rows.length + ' line' + (rows.length === 1 ? '' : 's') + ', newest first'),
      flRows: rows,
      flHasRows: rows.length > 0,
      /* Said before anything is copied, not after. Tokens and invoices are
       * already gone; what is left still says who you bank with. */
      flNote: 'Kept on this phone only — Foxy sends none of this anywhere. '
        + 'Tokens, invoices, payment requests and keys are already removed. '
        + 'Mint names and amounts are not, so paste it somewhere you trust.',
      flCopyLabel: s.flCopied ? 'COPIED' : 'COPY ALL',
      flCopy: () => this.copyFieldLog(),
      // the share sheet, because a session's worth of log is an attachment
      // rather than a paste — and on a Release build this screen is the only
      // record there is (26c-field-log.js)
      flShare: () => this.shareFieldLog(),
      flClear: () => this.clearFieldLog(),
      flBack: () => this.back(),
    };
  }

  /* What more than one screen's function reads, worked out once a render. */
  renderContext() {
    const s = this.state;
    const sc = s.screen;
    // the wallet you're paying from caps a send
    const balLive = this.balNow();
    // the fork could hide the bitcoin wallet; this one is the bitcoin wallet
    const btcAvailUsd = balLive.sats * this.satUsd();
    // on chain as well: its keypad took any figure and left the refusal to
    // the confirmation, a screen and a fee quote later
    /* A card's amounts are typed on the same keypad (26f-flashcard.js), and
     * two of them have a ceiling it can say under the figure: adding to a
     * card is out of this phone's balance, and withdrawing is out of what the
     * card holds. */
    const capped = s.flow === 'send' || s.flow === 'onchain' || s.flow === 'cardAdd' || s.flow === 'cardWd';
    const sendCapUsd = !capped ? 0
      : s.flow === 'cardWd' ? ((s.fc && s.fc.balance) || 0) * this.satUsd()
      : btcAvailUsd;
    const sendEnteredUsd = s.unit === 'SATS' ? (parseFloat(s.amount) || 0) * this.satUsd() : (parseFloat(s.amount) || 0);
    const SEND_DAY_LIMIT = Infinity; // this fork has no daily limit
    const overLimit = s.flow === 'send' && sendEnteredUsd > SEND_DAY_LIMIT + 0.005;
    const sendOver = capped && (sendEnteredUsd > sendCapUsd + 0.005 || overLimit);
    // handed to syncHaptics, which cannot repeat this balance/limit maths
    this._amtOver = false;
    // live series or nothing: a canned curve next to a real price is a lie
    const chart = (s.series || {})[s.range] || null;
    this._pts = chart ? chart.pts : null;
    const val = parseFloat(s.amount) || 0;
    const landed = val;
    // An invoice's own amount overrides the typed one — but only when paying
    // it. On a receive screen the typed amount IS the amount.
    const invSats = (s.flow === 'send' && s.recipientKind === 'invoice' && s.recipient && window.FoxyWallet)
      ? window.FoxyWallet.amountOf(s.recipient) : null;
    const sats = invSats || (s.unit === 'SATS' ? Math.round(landed) : Math.round(landed / this.px() * 1e8));
    const tx = s.tx || {};
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((s.emailDraft || '').trim());
    /* Over the balance only because part of it is with the mint: the same
     * block, with its own words. */
    const overBySats = (sendOver && this.satUsd() > 0)
      ? Math.ceil((sendEnteredUsd - sendCapUsd) / this.satUsd()) : 0;
    // what is held with the mint is this phone's balance; a card's is its own
    const sendHeld = (sendOver && !overLimit && this.heldBlocks && s.flow !== 'cardWd') ? this.heldBlocks(overBySats) : '';
    return { s, sc, balLive, btcAvailUsd, sendCapUsd, sendEnteredUsd, SEND_DAY_LIMIT, overLimit, sendOver, sendHeld, chart, val, landed, invSats, sats, tx, emailOk };
  }
