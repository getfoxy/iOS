  /* ---- the card tap screens ----------------------------------------------------
   *
   * One family of full screens for every card tap, from the keeper's 2026-11-06 design (screens 1a to 1g), and
   * only the words change from one flow to the next. Each is a ground, a title of 34px spaced out, the amount at
   * 76px under it, then three dots, a paragraph or a chip where the screen has one, and its pills at the foot.
   * The status bar is the phone's own, and the NFC sheet is iOS's: neither is drawn here.
   *
   *   1a  WAITING        light blue   the sheet is up and no card is in contact: TAP TO PAY, TAP TO LOAD, and so
   *                                   on by flow (FC_TAP_FLOWS), with the arrow over the top of the screen and
   *                                   TAP CARD BEHIND THE TOP; ENTER PIN while the pad is up over it
   *   1b  GETTING READY  light blue   the phone is making what it will write, before any sheet (`fcAddRun`)
   *   1c  IN CONTACT     orange       the card is being read or is signing: PAYING, RECEIVING, READING, ...
   *   1d  CHECKING       teal         the card has signed and been let go, and the mint is asked: CHECKING for a
   *                                   payment, CHARGING for a load, VERIFYING for a read; STILL ... once the wait
   *                                   the CHECKING screen makes has run out (`fcChecking`, which is drawn so too)
   *   1e  TAP AGAIN      yellow       a load whose card was not read: the money still waits to go onto it
   *                                   (26f-flashcard.js, `fcStillWaiting`); TAP CARD and LATER
   *   1f  TAP AGAIN      yellow       a payment whose card was not read: nothing has been paid (`fcFailed`'s
   *                                   `gone`); TAP CARD and CANCEL
   *   1g  CARD LOST      red          the instant the phone's link says the card has gone mid-tap; it stays until
   *                                   the card is found again (1c), the card turns out to have signed and the mint
   *                                   is asked (1d), or the tap ends, when the flow says what happened (1e, 1f)
   *
   * What the screen behind the sheet says, by where the tap has got to (`fcTapLook`, the key kept on `data-look`):
   *
   *   hold      1a  the flow's TAP TO ...      waiting for the first contact
   *   keep      1c  the flow's contact word    in contact, the card being asked
   *   verify    1c  the same                   the card has signed and is still there: the mint is asked, and
   *                                            change is fetched or written
   *   remove    1d  the flow's checking word   the card has signed and nothing more is wanted of it, while the
   *                                            phone's sheet may still be showing (until it has gone or a second
   *                                            and a half after the card signed, whichever is first)
   *   checking  1d  the same                   and then, while the mint has not answered
   *   still     1d  STILL and the same         the wait the CHECKING screen makes (`fcChecking`) has run out
   *   change    1a  TAP FOR CHANGE             the card has signed and its change waits for the next tap;
   *             1g  CARD LOST                  or contact broke before the change went on
   *   again     1g  CARD LOST                  contact broke part way, and the same sheet asks again;
   *             1a  the flow's TAP TO ...      or a tap that begins again with nothing asked of the card yet
   *   pin       1a  ENTER PIN                  the sheet ended asking for the PIN; the pad is up
   *
   * The sheet's own line is the wallet's and 26f's (FC_STEPS, fcProgressText); nothing of it is repeated here.
   * A person who asks for less motion has the dots and the arrow still (build/markup.html, `[data-look]` and
   * `[data-tp-move]`).
   */
  // each screen's ground, ink, and the colours of its paragraph, its chip and its filled pill
  FC_TAP_SCREENS = {
    '1a': { bg: 'linear-gradient(180deg,#D6EEF4 0%,#BFE3EC 60%,#A9D6E2 100%)', ink: '#0F2A33' },
    '1b': { bg: 'linear-gradient(180deg,#D6EEF4 0%,#BFE3EC 60%,#A9D6E2 100%)', ink: '#0F2A33' },
    '1c': { bg: 'linear-gradient(180deg,#FF9A5C 0%,#EB6A2E 60%,#D9561C 100%)', ink: '#1A0A02' },
    '1d': { bg: 'linear-gradient(180deg,#1A3C47 0%,#0F2A33 60%,#081C22 100%)', ink: '#F2FAFC' },
    '1e': { bg: 'linear-gradient(180deg,#FFE7A8 0%,#F6C453 60%,#EDB236 100%)', ink: '#2A1A00', words: '#3D2A05', chip: 'rgba(42,26,0,.1)', solid: '#2A1A00', solidInk: '#FFE7A8' },
    '1f': { bg: 'linear-gradient(180deg,#FFE7A8 0%,#F6C453 60%,#EDB236 100%)', ink: '#2A1A00', words: '#3D2A05', chip: 'rgba(42,26,0,.1)', solid: '#2A1A00', solidInk: '#FFE7A8' },
    '1g': { bg: 'linear-gradient(180deg,#E8503F 0%,#D93A2B 60%,#B82A1E 100%)', ink: '#FFFFFF', words: '#FFE9E5', chip: 'rgba(255,255,255,.16)', solid: '#FFFFFF', solidInk: '#B82A1E' },
  };
  /* The words of each flow: what 1a asks for, what 1c says while the card is in contact, and what 1d says while the mint is
   * asked. A tap names its flow (`fcTap`'s `o.flow`); one that names none is a payment's where it is paying (`o.paying`),
   * the change's where it is a payment's second tap (`o.look`), and plain TAP CARD otherwise. */
  FC_TAP_FLOWS = {
    pay: { tap: 'TAP TO PAY', contact: 'PAYING', check: 'CHECKING' },
    load: { tap: 'TAP TO LOAD', contact: 'RECEIVING', check: 'CHARGING' },
    change: { tap: 'TAP FOR CHANGE', contact: 'RECEIVING', check: 'CHARGING' },
    read: { tap: 'TAP TO READ', contact: 'READING', check: 'VERIFYING' },
    withdraw: { tap: 'TAP TO WITHDRAW', contact: 'WITHDRAWING', check: 'CHECKING' },
    swap: { tap: 'TAP TO SWAP', contact: 'SWAPPING', check: 'CHECKING' },
    move: { tap: 'TAP TO MOVE', contact: 'MOVING', check: 'CHECKING' },
    renew: { tap: 'TAP TO RENEW', contact: 'RENEWING', check: 'CHECKING' },
    reset: { tap: 'TAP TO RESET', contact: 'RESETTING', check: 'CHECKING' },
    setup: { tap: 'TAP TO SET UP', contact: 'SETTING UP', check: 'CHECKING' },
    pin: { tap: 'TAP TO SET PIN', contact: 'WRITING', check: 'CHECKING' },
    limit: { tap: 'TAP TO SET LIMIT', contact: 'WRITING', check: 'CHECKING' },
    rate: { tap: 'TAP TO SET RATE', contact: 'WRITING', check: 'CHECKING' },
    write: { tap: 'TAP CARD', contact: 'WRITING', check: 'CHECKING' },
    card: { tap: 'TAP CARD', contact: 'READING', check: 'CHECKING' },
  };
  FC_TAP_WORDS = {
    lost: 'The card moved away too soon. Hold it still behind the top of the phone.',
    load: 'The card wasn’t read. This money is still waiting to go onto it.',
    back: 'The card wasn’t read. This money is still waiting to go back onto it.',
    pay: 'The card wasn’t read. Nothing has been paid yet.',
  };
  FC_TAP_CHIPS = { shield: 'Your money is still on your card.', lock: 'Only this card can receive it.' };
  FC_TAP_ICONS = {
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"></path><path d="M9 12l2 2 4-4"></path>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>',
  };
  // the body's padding at the top of the screen: the usual one, and the one a screen with the card's picture on it has (the arrow's words above it)
  FC_TAP_PAD = 'calc(max(54px, env(safe-area-inset-top)) + min(130px, 15vh)) 36px 0';
  FC_TAP_PAD_CARD = 'calc(max(54px, env(safe-area-inset-top)) + 64px) 36px 0';
  // the card's height on these screens: as tall as the screen leaves room for, and never under 160px or over 360px
  FC_TAP_CARD_H = 'clamp(160px, calc(100vh - 540px), 360px)';
  // how long REMOVE is said after the card has signed, if the sheet has not been seen to go before then
  FC_TAP_REMOVE_MS = 1500;
  // the steps that mean the card is in the field, whether or not the phone has said so
  FC_TAP_CONTACT = { reading: 1, signing: 1, writing: 1, resetting: 1, mint: 1, change: 1 };

  /* What this tap knows of the card so far. It lives on the tap's own options (`_fcTapO.t`), so a tap that begins
   * has none of the one before. `o.lost` and `o.wrote` are said by whatever begins a tap that follows a card leaving
   * (and by the flows as it leaves): taken once into the state. */
  fcTapState() {
    const o = this._fcTapO || (this._fcTapO = {});
    if (!o.t) {
      o.t = {
        connected: false, since: 0,
        // something has been asked of the card, or the card has been found: CANCEL goes
        touched: false,
        // the card has signed (a payment's second tap, and a put back, begin so)
        signed: o.look === 'receive' || !!o.putBack,
        // the card is let go and nothing more is wanted of it; when it was, when the sheet was seen to go, and the look kept once the mint has answered
        gone: false, goneAt: 0, sheetGoneAt: 0, kept: '',
        lost: false, wrote: false,
        // the sheet ended asking for the PIN; and the tap that follows the pad
        pin: false, pinAgain: !!o.pinAgain,
        design: '',
        // CLOSE took the screen down (`fcTapClose`); and a tap that takes up one the card left part way, some of it signed already
        closed: false, resumed: !!o.lost && !!o.paying,
        // the change has been asked for in this tap (TAP FOR CHANGE): the card in contact after it is receiving
        forChange: false,
      };
    }
    const t = o.t;
    if (o.lost) { t.lost = true; t.connected = false; o.lost = false; }
    if (o.wrote) { t.wrote = true; o.wrote = false; }
    return t;
  }

  /* Contact: the card is in the field. `again` is a connection the phone reported, which starts the count afresh. */
  fcContact(again) {
    const t = this.fcTapState();
    if (t.gone || t.pin) return;
    if (again || !t.connected) { t.connected = true; t.since = Date.now(); }
    t.lost = false;
    t.touched = true;
  }

  /* The card left, and the same sheet is about to ask for it again. */
  fcTapLost() {
    const t = this.fcTapState();
    if (t.gone || t.pin) return;
    /* Only a card that was in the field can be lost. The phone's link says `lost` too when iOS ends a sheet no card came near
     * (its own Cancel, its minute run out), and that is no card lost: the screen stays as it was, and the tap ends silent. */
    if (!t.connected && !t.touched) return;
    t.lost = true;
    t.connected = false;
    if (this.stageUp('card')) this.fcTapDraw();
  }

  /* The sheet ended asking for the PIN: the pad comes up over this, and the tap that follows it asks for the card again (1a). */
  fcTapPin() {
    const t = this.fcTapState();
    t.pin = true;
    t.connected = false;
    if (this.stageUp('card')) this.fcTapDraw();
  }

  /* A card read at this tap has said which design it is (`info.design` of a step, `design` of a progress report). */
  fcTapSeen(code) {
    this.fcTapState().design = this.fcDesignOf({ design: code });
    if (this.stageUp('card')) this.fcTapDraw();
  }

  /* The phone's sheet has gone: the app has the screen back (the native side tells the page of every return, with no time away when the app only
   * lost focus for a sheet: 15-paid-wake-keyboard.js, `watchWake`). Only a card that has been let go can have its sheet go; REMOVE gives way to CHECKING
   * then, if the clock has not done it already. */
  fcSheetGone() {
    // the app comes back to the screen for many reasons; with no tap begun there is nothing for a sheet to have been in
    if (!(this._fcTapO && this._fcTapO.t)) return;
    const t = this.fcTapState();
    if (!t.gone || t.sheetGoneAt) return;
    t.sheetGoneAt = Date.now();
    if (this.stageUp('card')) this.fcTapDraw();
  }

  /* The wait for the mint's word, in milliseconds: the one the CHECKING card makes before it says STILL CHECKING (`fcChecking`): the first asking, and the rest
   * of a dozen at their pace. */
  fcCheckWait() {
    return this.FC_CHECK_FIRST_MS + (this.FC_CHECK_ASKS - 1) * this.FC_CHECK_EVERY_MS;
  }

  /* When a card that was let go stops being REMOVE: the sheet has gone, or the clock has run out, whichever is first. Nought for a tap that is not waiting on the
   * mint (it has answered: the look is kept as it was, `kept`). */
  fcCheckingFrom(t) {
    if (!t.gone || !t.goneAt || t.kept) return 0;
    const byClock = t.goneAt + this.FC_TAP_REMOVE_MS;
    return t.sheetGoneAt ? Math.min(t.sheetGoneAt, byClock) : byClock;
  }

  /* Which of REMOVE, CHECKING and STILL CHECKING a card that was let go is on. */
  fcGoneKey(t) {
    if (t.kept) return t.kept;
    const from = this.fcCheckingFrom(t);
    const now = Date.now();
    if (!from || now < from) return 'remove';
    return now - from >= this.fcCheckWait() ? 'still' : 'checking';
  }

  /* Milliseconds until the screen changes by itself, with no step or event to change it: REMOVE to CHECKING, CHECKING to STILL CHECKING. Nought when it will not. */
  fcTapDue(key) {
    const from = this.fcCheckingFrom(this.fcTapState());
    if (!from) return 0;
    const now = Date.now();
    if (key === 'remove') return Math.max(1, from - now);
    if (key === 'checking') return Math.max(1, from + this.fcCheckWait() - now);
    return 0;
  }

  /* What the phone's own link reports (`FoxyWallet.onCard`): the card found, the card lost. */
  fcTapEvent(ev) {
    if (!ev || !this.stageUp('card')) return;
    if (ev.stage === 'seen') { this.fcTapSeen(ev.design); return; }
    if (ev.stage === 'connected') {
      this.fcContact(true);
      this.fcTapDraw();
    } else if (ev.stage === 'lost') {
      this.fcTapLost();
    }
  }

  /* Which screen this is, from where the tap has got to: the key (`data-look`), the screen of the family it is drawn as
   * (`data-scheme`), whether the arrow and TAP CARD BEHIND THE TOP are up (`data-loop`), and whether CANCEL is. */
  fcTapLook() {
    const o = this._fcTapO || {};
    const t = this.fcTapState();
    let key;
    if (t.pin) key = 'pin';
    else if (t.gone) key = this.fcGoneKey(t);
    else if (t.connected) key = t.signed ? 'verify' : 'keep';
    // contact broke: before any of the change went on it is the change that is asked for, and otherwise it is the tap
    else if (t.lost) key = (t.signed && !t.wrote) ? 'change' : 'again';
    else if (o.putBack) key = 'again';
    else if (t.signed) key = 'change';
    // the tap that follows the PIN pad: nothing has been asked of the card yet, and it was asked before
    else if (t.pinAgain) key = 'again';
    else key = 'hold';
    // (the change asked for: from then on the card in contact is receiving it)
    if (key === 'change') t.forChange = true;
    const screen = (key === 'keep' || key === 'verify') ? '1c'
      : (key === 'remove' || key === 'checking' || key === 'still') ? '1d'
      : ((key === 'again' || key === 'change') && t.lost) ? '1g' : '1a';
    return {
      key, scheme: screen,
      // the card is wanted, and the arrow over the top says where
      loop: screen === '1a' && key !== 'pin',
      // nothing has been asked of the card: the one way out is here (after that, finishing is)
      cancel: !t.touched && !t.connected && (key === 'hold' || key === 'again' || key === 'change'),
    };
  }

  // the words of the flow this tap is (FC_TAP_FLOWS)
  fcTapFlow() {
    const o = this._fcTapO || {};
    const F = this.FC_TAP_FLOWS;
    return F[String(o.flow || '')] || (o.look === 'receive' ? F.change : o.paying ? F.pay : F.card);
  }

  /* What the screen shows for a look: its screen, title, amount, the dots, the paragraph and chip of a card lost, and its pills. */
  fcTapSpec(k) {
    const o = this._fcTapO || {};
    const t = this.fcTapState();
    const f = this.fcTapFlow();
    const spec = { screen: k.scheme, amount: o.amount || '', amountSub: o.amountSub || '', hint: k.loop, dots: '', words: '', chip: null, solid: null, plain: null };
    const close = { label: 'CLOSE', go: () => this.fcTapClose() };
    // a read shows the card turning while it is asked for (TAP TO READ) and while it is read (READING); not CARD LOST, the PIN or the check
    spec.card = String(o.flow || '') === 'read' && (k.scheme === '1a' || k.scheme === '1c') && k.key !== 'pin';
    if (k.scheme === '1g') {
      spec.title = 'CARD LOST';
      spec.words = this.FC_TAP_WORDS.lost;
      /* Money the card was to receive waits for it alone; a card that has not signed still holds its own. A payment taken up
       * again after the card left part way (`o.lost` as it began) has some of it signed already: neither is said then. */
      const receiving = f === this.FC_TAP_FLOWS.load || f === this.FC_TAP_FLOWS.change || t.signed;
      spec.chip = receiving ? { icon: 'lock', text: this.FC_TAP_CHIPS.lock } : t.resumed ? null : { icon: 'shield', text: this.FC_TAP_CHIPS.shield };
      spec.solid = { label: 'TRY AGAIN', go: () => this.fcTapRetry() };
      spec.plain = { label: 'CANCEL', go: () => { const W = this.fcW(); if (W) W.cardStop(); } };
      return spec;
    }
    if (k.key === 'pin') { spec.title = 'ENTER PIN'; return spec; }
    if (k.scheme === '1a') {
      spec.title = k.key === 'change' ? this.FC_TAP_FLOWS.change.tap : f.tap;
      // the session ends as cancelled, and that is what takes this screen down
      if (k.cancel) spec.plain = { label: 'CANCEL', go: () => { const W = this.fcW(); if (W) W.cardStop(); } };
      return spec;
    }
    spec.dots = 'fast';
    spec.plain = close;
    spec.title = k.scheme === '1c' ? (t.forChange ? this.FC_TAP_FLOWS.change.contact : f.contact) : (k.key === 'still' ? 'STILL ' : '') + f.check;
    return spec;
  }

  /* CLOSE on 1c and 1d: this screen goes, and the tap goes on under the phone's sheet (or, the card let go, at the mint) to its
   * end, which is said as it always is; nothing of it draws this screen again. */
  fcTapClose() {
    this.fcTapState().closed = true;
    this.hideStage('card');
  }

  /* TRY AGAIN on CARD LOST: the same sheet is asking for the card already, and the screen says so again (1a). */
  fcTapRetry() {
    const t = this.fcTapState();
    t.lost = false;
    if (this.stageUp('card')) this.fcTapDraw();
  }

  /* ---- one screen of the family, made and filled ------------------------------------------------------------------- */

  /* The screen's parts, made once: the arrow and its words at the top, the title, the amount and what goes under it, and
   * two pills at the foot (the filled one over the outlined one). `fcFamilyFill` changes them in place. */
  fcFamilyBuild(kind) {
    this.hideStage();
    const root = document.createElement('div');
    root.id = 'foxy-stage';
    root.setAttribute('data-stage', kind);
    root.setAttribute('data-tp', '1');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483300;overflow:hidden;box-sizing:border-box;'
      + "font-family:Sora,system-ui,sans-serif;-webkit-font-smoothing:antialiased;animation:foxyIn .18s ease";
    const fig = "font-family:Figtree,Sora,system-ui,sans-serif";
    root.innerHTML =
      // the arrow bobbing up to the top of the phone, where the card goes
      '<div data-tp-hint style="position:absolute;left:0;right:0;top:0;height:110px;overflow:hidden;pointer-events:none">'
      + '<div style="position:absolute;left:0;right:0;top:max(28px, env(safe-area-inset-top));display:flex;flex-direction:column;align-items:center;gap:2px">'
      + '<svg data-tp-move viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="animation:tpArrow 1.2s ease-in-out infinite"><path d="M6 14l6-6 6 6"></path></svg>'
      + '<span style="' + fig + ';font-weight:700;font-size:15px;letter-spacing:.08em">TAP CARD BEHIND THE TOP</span></div></div>'
      + '<div data-tp-body style="position:absolute;left:0;right:0;top:0;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;'
      + 'box-sizing:border-box;padding:' + this.FC_TAP_PAD + '">'
      // the card's picture, turning, where the flow is a read (`fcFamilyFill`, spec.card)
      + '<div data-tp-art style="display:none;flex:none"></div>'
      + '<h1 style="margin:0;font-weight:800;font-size:34px;line-height:1.05;letter-spacing:.1em;white-space:nowrap"></h1>'
      + '<div data-tap-amount style="font-weight:800;font-size:76px;line-height:1;letter-spacing:-.04em;white-space:nowrap"></div>'
      + '<div data-tap-amount-sub style="margin-top:-4px;' + fig + ';font-weight:600;font-size:19px;opacity:.6"></div>'
      + '<p data-tp-words style="margin:22px 0 0;' + fig + ';font-weight:500;font-size:19px;line-height:1.45;text-wrap:balance"></p>'
      + '<div data-tp-chip style="margin-top:6px;display:flex;align-items:center;gap:10px;padding:12px 18px;border-radius:999px;' + fig + ';font-weight:700;font-size:15px">'
      + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"></svg><span></span></div>'
      + '<div data-tp-dots style="margin-top:22px;display:flex;gap:10px">'
      + '<span data-tp-move></span><span data-tp-move></span><span data-tp-move></span></div>'
      + '</div>';
    const foot = document.createElement('div');
    foot.setAttribute('data-tp-foot', '1');
    foot.style.cssText = 'position:absolute;left:0;right:0;bottom:0;padding:0 24px max(40px, calc(env(safe-area-inset-bottom) + 16px));display:flex;flex-direction:column;gap:12px';
    const pill = (solid) => {
      const b = document.createElement('div');
      b.style.cssText = 'height:58px;border-radius:999px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;'
        + 'font-family:Sora,system-ui,sans-serif;font-weight:800;font-size:17px;letter-spacing:.08em;cursor:pointer;'
        + (solid ? '' : 'border:2px solid currentColor');
      b.setAttribute(solid ? 'data-tp-solid' : 'data-stage-button', '1');
      b.addEventListener('click', () => { const go = /** @type {any} */ (b)._go; if (typeof go === 'function') go(); });
      foot.appendChild(b);
      return b;
    };
    pill(true);
    pill(false);
    root.appendChild(foot);
    document.body.appendChild(root);
    return root;
  }

  /* Fill the screen for `spec` (`fcTapSpec`'s shape): its ground and ink, the words, the dots' pace, and the pills. */
  fcFamilyFill(root, spec) {
    const S = this.FC_TAP_SCREENS[spec.screen] || this.FC_TAP_SCREENS['1a'];
    const q = (sel) => /** @type {HTMLElement | null} */ (root.querySelector(sel));
    root.setAttribute('data-scheme', spec.screen);
    root.style.background = S.bg;
    root.style.color = S.ink;
    const shown = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };
    const hint = q('[data-tp-hint]');
    shown(hint, !!spec.hint);
    this.fcFamilyTitle(root, String(spec.title || ''));
    /* The card's picture, turning, on a screen of a read (TAP TO READ, READING): put in once and kept, so it is not set back to the
     * front by each look, and taken out where a look has none (CARD LOST, VERIFYING). */
    const art = q('[data-tp-art]');
    if (art) {
      const on = !!spec.card;
      if (on && !art.firstChild) {
        art.innerHTML = this.fcCardStageHtml(this.FC_TAP_CARD_H);
        this._fcSpinA = 0;
        if (this._fcSpin) this._fcSpin.a = 0;
      }
      if (!on && art.firstChild) art.innerHTML = '';
      art.style.display = on ? '' : 'none';
      const body = q('[data-tp-body]');
      if (body) body.style.padding = on ? this.FC_TAP_PAD_CARD : this.FC_TAP_PAD;
      if (on && this.fcSpinOn) this.fcSpinOn();
    }
    const amount = q('[data-tap-amount]');
    if (amount) { amount.textContent = spec.amount || ''; shown(amount, !!spec.amount); }
    const sub = q('[data-tap-amount-sub]');
    if (sub) { sub.textContent = spec.amountSub || ''; shown(sub, !!spec.amountSub); }
    const words = q('[data-tp-words]');
    if (words) { words.textContent = spec.words || ''; words.style.color = S.words || S.ink; shown(words, !!spec.words); }
    const chip = q('[data-tp-chip]');
    if (chip) {
      const c = spec.chip;
      shown(chip, !!c);
      chip.style.background = S.chip || 'transparent';
      if (c) {
        const svg = chip.querySelector('svg');
        const icon = this.FC_TAP_ICONS[c.icon] || '';
        if (svg && svg.getAttribute('data-icon') !== c.icon) { svg.innerHTML = icon; svg.setAttribute('data-icon', c.icon); }
        const span = chip.querySelector('span');
        if (span) span.textContent = c.text;
      }
    }
    const dots = q('[data-tp-dots]');
    if (dots) {
      shown(dots, !!spec.dots);
      const pace = spec.dots === 'fast' ? [0.8, 0.12] : [1.2, 0.18];
      Array.from(dots.children).forEach((d, i) => {
        const el = /** @type {HTMLElement} */ (d);
        el.style.cssText = 'width:12px;height:12px;border-radius:50%;background:currentColor;'
          + (spec.dots ? 'animation:tpDot ' + pace[0] + 's ease-in-out ' + (i * pace[1]).toFixed(2) + 's infinite' : '');
      });
    }
    const pill = (el, b, solid) => {
      if (!el) return;
      /** @type {any} */ (el)._go = b ? b.go : null;
      el.textContent = b ? b.label : '';
      el.style.display = b ? 'flex' : 'none';
      el.style.visibility = b ? 'visible' : 'hidden';
      if (solid) { el.style.background = S.solid || '#0A0A0A'; el.style.color = S.solidInk || '#FFFFFF'; }
    };
    pill(q('[data-tp-solid]'), spec.solid, true);
    pill(q('[data-stage-button]'), spec.plain, false);
  }

  /* The title on one line: 34px, smaller only where a phone is too narrow for it. */
  fcFamilyTitle(root, text) {
    const h = /** @type {HTMLElement | null} */ (root.querySelector('h1'));
    if (!h) return;
    if (h.textContent !== text) h.textContent = text;
    try {
      h.style.fontSize = '34px';
      const col = h.parentElement;
      const room = col ? col.clientWidth - 48 : 0;
      const need = h.scrollWidth;
      if (room > 0 && need > room) h.style.fontSize = Math.max(18, Math.floor(340 * room / need) / 10) + 'px';
    } catch (e) { /* no layout to measure */ }
  }

  /* A screen of the family that is not the one behind the sheet: GETTING READY (1b), CHECKING (1d), TAP AGAIN (1e, 1f). `kind`
   * names it, so whatever put it up can take down its own and nothing else's; a pill pressed takes it down first, and a wait
   * (`forMs`) takes it down by itself when it outlives what it waited for, as every stage does. */
  fcFamilyScreen(kind, spec, forMs) {
    const root = this.fcFamilyBuild(kind);
    const wrap = (b) => (b ? { label: b.label, go: () => { this.hideStage(kind); if (typeof b.go === 'function') b.go(); } } : null);
    this.fcFamilyFill(root, Object.assign({}, spec, { solid: wrap(spec.solid), plain: wrap(spec.plain) }));
    if (forMs > 0) this._stageT = setTimeout(() => this.hideStage(kind), forMs);
    if (this.syncPreview) this.syncPreview();
    console.log('[foxy] screen: ' + kind + ', ' + String(spec.title || '').toLowerCase());
    return root;
  }

  /* ---- the screen behind the sheet ---------------------------------------------------------------------------------- */

  /* Made once for a tap and kept: what changes is filled in place, so the dots do not start again when only the title moves. */
  fcTapBuild() {
    const root = this.fcFamilyBuild('card');
    root.setAttribute('data-look', 'hold');
    // the rule every stage keeps: one that outlives what it waited for hides a working app
    this._stageT = setTimeout(() => this.hideStage('card'), 120000);
    return root;
  }

  /* Draw the screen for where the tap has got to: made if it is not up, and otherwise changed in place. A screen CLOSE took
   * down is not drawn again for the same tap. */
  fcTapDraw() {
    const t = this.fcTapState();
    if (t.closed) return;
    const k = this.fcTapLook();
    let root = document.getElementById('foxy-stage');
    const fresh = !(root && root.getAttribute('data-stage') === 'card' && root.getAttribute('data-look'));
    if (fresh) root = this.fcTapBuild();
    if (!root) return;
    const was = root.getAttribute('data-look');
    root.setAttribute('data-look', k.key);
    root.setAttribute('data-loop', k.loop ? '1' : '0');
    this.fcFamilyFill(root, this.fcTapSpec(k));
    if (fresh || was !== k.key) console.log('[foxy] screen: card, ' + k.key + ' (' + k.scheme + ')');
    if (fresh && this.syncPreview) this.syncPreview();
    /* A look that comes of time alone is drawn when it is due, and the timer goes with the screen (`hideStage`). */
    clearTimeout(this._fcLookT);
    this._fcLookT = null;
    const due = this.fcTapDue(k.key);
    if (due > 0) {
      this._fcLookT = setTimeout(() => {
        this._fcLookT = null;
        if (this.stageUp('card')) this.fcTapDraw();
      }, due);
    }
  }
