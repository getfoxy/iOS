  /* ---- FLASHCARD: a card that holds ecash ----------------------------------
   *
   * The screens over the wallet's card functions (build/wallet/08a-flashcard.js
   * and 21a-flashcard.js). Two places use them:
   *
   *   the receive screen's CARD button   somebody pays this phone with their
   *                                      card: its PIN on this phone's pad,
   *                                      a tap, paid or not;
   *   MENU > FLASHCARD                   a holder's own card: what it holds,
   *                                      money on and off it, its PIN and its
   *                                      limit, and the cards this phone can
   *                                      take back if they are lost.
   *
   * The daily limit is the most the card signs for in one day. The card keeps
   * its own clock, counts the whole worth of every piece it signs against the
   * day it falls in, and starts the count again by itself when the day is over.
   * A card has none until its owner sets one; only the phone that holds the
   * words the card was set up with, the owner, can set, change or remove it,
   * change the card's PIN, or add funds without the PIN.
   *
   * A card of software 1.15 and on takes its clock from the newest Bitcoin
   * block header it has been shown (build/wallet/08b-block-headers.js): no one
   * can show it a block from a time that has not come, so no terminal can walk
   * its day forward, and a screen of ours says the block its clock reads
   * (CLOCK, under its limits). The phone's own time is only a note the card
   * writes in its log and receipts, and the log shows it beside the block's.
   * An older card is told the time by the phone that taps it, under a signature
   * whose key is built into the app (build/wallet/08a-flashcard.js,
   * CARD_TIME_KEY): there the limit bounds an honest receiver and the holder's
   * own overspending, and nothing is said anywhere on these screens about
   * stopping an attacker.
   *
   * Three things here are not this app's to draw. The sheet that slides up
   * while the phone looks for a card is the phone's own, and one line of text
   * on it is ours (`link.say`). The page behind it cannot be touched while it
   * is up. And a card is let go as soon as it has signed: its sheet ends with
   * "Done. Remove the card.", and a screen of ours says that the mint is being
   * asked for as long as that takes (the card's part is seconds; the mint's is
   * as long as Tor).
   *
   * A card's PIN is not Foxy's PIN. It is typed on the same pad because that
   * is the pad a person already knows; it is held in a variable for the length
   * of one flow, passed to the card, and never stored.
   *
   * A card of software 1.16 and on need not have one. It is set up with NO PIN
   * under the pad that asks for it, and a PIN can be added to it later (ADD
   * PIN, in CHANGE PIN's place). A card with a PIN has a third limit, the NO
   * PIN LIMIT: how much it signs for in a day without the PIN. At a till the
   * card is tapped first, with no PIN asked for: a card with none, or one
   * whose no PIN limit covers the payment, pays in that tap; any other ends
   * the tap asking for its PIN, and the pad comes up for a second tap. A card
   * of an older software always needs it, and is asked the same way.
   */

  /* A tap, step by step: the heading on our screen, and the line on the
   * phone's sheet. The wallet names the steps as it reaches them. */
  FC_STEPS = {
    hold: ['HOLD THE CARD<br>TO THE TOP OF THE PHONE', 'Hold the card to the top of the phone'],
    reading: ['READING<br>THE CARD', 'Reading the card'],
    signing: ['KEEP THE CARD<br>THERE', 'Keep the card there'],
    mint: ['KEEP THE CARD<br>THERE', 'Keep the card there: asking the mint'],
    change: ['PUTTING CHANGE<br>BACK ON THE CARD', 'Putting change back on the card'],
    /* The card has signed and been let go, and these are said on our screen
     * alone (`fcTap`'s `on`). A payment at a till has screens of its own for
     * all of this (FC_LOOKS); these are every other tap's. */
    checking: ['VERIFYING<br>WITH THE MINT', ''],
    making: ['MAKING<br>THE CHANGE', ''],
    writing: ['WRITING<br>TO THE CARD', 'Keep the card there: writing to it'],
    done: ['REMOVE<br>THE CARD', 'Done. Remove the card.'],
  };
  /* ---- the three screens of a card payment ---------------------------------
   *
   * Drawn from the design's own markup, as the loaders are (26e-loaders.js):
   * TAP TO VERIFY while the card is held and signs, VERIFYING CARD while the
   * mint is asked and the change is made, TAP TO CONFIRM from the moment the
   * card is asked for again until its change is back on it. Then the
   * payment's own confirmation. What the app changes: the phone's sheet is the
   * phone's own (the design draws one for reference), the texture is the fur
   * already in the bundle (snow-fur.jpg, the same picture), and the amount is
   * the payment's.
   *
   * Everything is in the top half, above where the phone's sheet comes up. The
   * sheet dims what is behind it; that is the phone's doing and no app can
   * turn it off, so the ground is light and the ink dark, which is what still
   * reads under it. The words do not change as the card works: the sheet says
   * each step, and this screen says the one thing to do.
   *
   * `tapAgain` and `confirmAgain` are the same two with TAP AGAIN on them, for
   * a card that left part way through that tap: up from the moment it is lost
   * (the sheet is asking for it again by then) until the tap is finished.
   *
   * `back` is TAP TO CONFIRM's ground for the one other thing a second tap of
   * a payment can be: a payment the mint refused, going back on the card.
   * Their keyframes are in the page's stylesheet (build/markup.html). */
  FC_LOOKS = {
    tap: { ground: '#BFE3EC', ink: '#0F2A33', sub: '#1E4450', title: 'Tap to verify', line: 'Tap for a few seconds...', ask: true },
    verify: { ground: '#BFE3EC', ink: '#0F2A33', sub: '#1E4450', title: 'Verifying card', line: 'This may take a few seconds...',
              chip: 'linear-gradient(135deg,#E6F4F8,#8FB9C6)' },
    confirm: { ground: '#EB6A2E', ink: '#1A0A04', sub: '#2E1206', title: 'Tap to confirm', line: 'Tap for a few seconds...', ask: true, fur: true, tick: true },
    tapAgain: { ground: '#BFE3EC', ink: '#0F2A33', sub: '#1E4450', title: 'Tap again', line: 'The last tap didn\u2019t finish...', ask: true },
    confirmAgain: { ground: '#EB6A2E', ink: '#1A0A04', sub: '#2E1206', title: 'Tap again', line: 'The last tap didn\u2019t finish...', ask: true, fur: true, tick: true },
    back: { ground: '#EB6A2E', ink: '#1A0A04', sub: '#2E1206', title: 'Tap to put back', line: 'The payment did not go through.', ask: true, fur: true },
  };
  // which of them a step of the tap is said with (`receive`: the card asked for again, before it is found)
  FC_LOOK_OF = { hold: 'tap', reading: 'tap', signing: 'tap', mint: 'tap', checking: 'verify', making: 'verify', change: 'verify',
                 receive: 'confirm', writing: 'confirm' };
  FC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // how near its date a card's own phone starts saying RENEW
  FC_RENEW_DAYS = 30;
  // the longest a payment's confirmation waits for its change to be taken
  FC_HOLD_MS = 150000;
  /* Cards are cash, for now.
   *
   * The card and the wallet can do more: a card set up as recoverable names a
   * key of the phone that loaded it, and that phone can take its money back
   * a year later if the card is lost or blocked. It is switched off here, in
   * the one place that offers it: a new card is set up as cash with nothing
   * asked, the list of cards this phone could take back is not shown, and
   * with no list there is no screen for a card that has not been tapped.
   * True brings all three back as they were (tests/flashcard-screens.js runs
   * both ways). A card set up as recoverable by anything else still reads
   * and pays as what it is. */
  FC_RECOVERABLE = false;

  fcW() {
    const W = window.FoxyWallet;
    return (W && W.cardSession) ? W : null;
  }

  /* A card has no name. The last four characters of its key tell two apart. */
  fcName(key) { return 'CARD ··' + String(key || '').slice(-4).toUpperCase(); }

  fcSats(n) { return '₿' + this.group(Math.round(Number(n) || 0)); }

  /* An amount for a button or a sentence: dollars where this phone has a
   * price to say them at, the sats where it has not, and the sats too for an
   * amount under half a cent, which in dollars would read as nothing. */
  fcPrice(n) {
    const sats = Math.round(Number(n) || 0);
    const usd = (sats / 1e8) * ((this.px && this.px()) || 0);
    return usd >= 0.005 ? '$' + this.usd(usd) : this.fcSats(sats);
  }

  /* The same with the sats after it: "$1.28 (₿1,499)". */
  fcBoth(n) {
    const sats = Math.round(Number(n) || 0);
    const usd = (sats / 1e8) * ((this.px && this.px()) || 0);
    return usd >= 0.005 ? '$' + this.usd(usd) + ' (' + this.fcSats(sats) + ')' : this.fcSats(sats);
  }

  /* A piece's date, as a day. Written out here and not left to the phone's
   * region, so the same card reads the same on every phone. */
  fcDay(secs) {
    const d = new Date((Number(secs) || 0) * 1000);
    return d.getDate() + ' ' + this.FC_MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* FLASHCARD in the menu asks for the card at once: the phone's own sheet
   * comes up with no screen of ours to read first. A card tapped, and the
   * screen is that card. The sheet dismissed, and the person is where they
   * were: there is no screen for no card.
   *
   * Except where cards can be taken back (FC_RECOVERABLE): a lost card
   * cannot be tapped, so the screen with no card on it is opened first and
   * stays when the sheet goes, with the cards this phone loaded listed on it. */
  goFlashcard() {
    // a card read on an earlier visit is not shown again: it may be somebody else's
    this._fcCard = null;
    if (this.FC_RECOVERABLE) {
      this.setState(p => ({ fc: null, screen: 'flashcard', stack: p.stack.concat([p.screen]) }));
      this.fcRead();
      return;
    }
    if (this.state.fc) this.setState({ fc: null });
    this.fcRead(true);
  }

  /* ---- one tap ------------------------------------------------------------
   *
   * `o`: amount (a heading under the title) and body, for the screen behind
   * the sheet, and `warm`, for a tap that goes on to the mint (the road to it
   * is opened as the sheet opens). `fn(link, on)` is what to do with the card;
   * `on(step)` moves both screens on, and after the card is let go
   * (`link.released`) only ours. Resolves and rejects as `fn` does, with our
   * screen down either way. */
  fcTap(o, fn) {
    const W = this.fcW();
    if (!W) return Promise.reject(new Error('The wallet is not ready.'));
    this._fcTapO = o || {};
    this.fcStage('hold');
    /* What the phone's own link says is happening, as it says it: the card
     * found ("Scanning. Hold still."), each line put on the sheet, the card
     * lost. The screen behind the sheet shows the same line. */
    if (W.onCard) W.onCard((ev) => { if (ev && ev.text && ev.stage !== 'end') this.fcLine(ev.text); });
    const over = () => { if (W.onCard) W.onCard(null); this.hideStage('card'); };
    return W.cardSession((o && o.sheet) || this.FC_STEPS.hold[1], (link) => {
      const on = (step, info) => {
        const words = this.FC_STEPS[step];
        if (!words) return;
        // the card has been let go and the sheet is gone: nothing to say on it, and "remove the card" has been said
        if (link.released && step === 'done') return;
        this.fcStage(step);
        if (!link.released) link.say(words[1]);
        const paying = !!(this._fcTapO && this._fcTapO.paying);
        /* The card's part is over. The mint's work can take as long as Tor does
         * (this screen is not the sheet, which iOS ends after a minute), and what
         * is said under the heading is what a person who has taken the card away
         * needs to hear. */
        /* The card has signed and something is coming back to it in this sheet (`info.change`: its change, or a payment held
         * for another amount): the page asks for three buzzes, so that whoever holds the card would know a second tap is
         * coming. iOS plays no haptic of an app's while its own sheet is up, so they are not felt today; the sheet's words
         * ("Paid. Keep the card here for your change.", 08a-flashcard.js `cardLetGo`) are what says it. Nothing else in the
         * app asks for three. */
        if ((step === 'checking' || step === 'mint') && info && info.change) this.fcChangeBuzz();
        if (step === 'checking') {
          clearTimeout(this._stageT);
          this._stageT = setTimeout(() => this.hideStage('card'), 180000);
          this.fcLine('You can remove the card.');
          /* The card has signed for a payment: its PAYMENT RECEIVED waits from
           * here, before the mint has said paid, until its change is back on
           * the card or is left for later. Held as this payment's and no
           * other's (`info.hash`, its entry). */
          if (paying) this.fcHoldConfirm(info && info.hash);
        }
        if (step === 'making') {
          this.fcLine('The payment is made.');
          if (paying) this.fcHoldConfirm(info && info.hash);
        }
      };
      /* Which piece, of how many: said on the sheet and on the screen at once,
       * before the card is asked, so the line is up for as long as it works on
       * that piece and a person keeps holding. */
      const progress = (p) => {
        const text = this.fcProgressText(p);
        if (!text) return;
        this.fcLine(text);
        link.say(text);
      };
      on('reading');
      return fn(link, on, progress);
      // a tap that goes on to the mint opens the road to it as the sheet opens, not when the card has signed
    }, { warm: !!(o && o.warm), again: (o && typeof o.again === 'function') ? (e) => {
      const line = o.again(e);
      /* The card left and the same sheet is about to ask for it again: a
       * payment's screen says TAP AGAIN from now until this tap is finished. */
      if (line && this._fcTapO && this._fcTapO.look) { this._fcTapO.lost = true; this.fcStage('lost'); }
      return line;
    } : null }).then((r) => { over(); return r; },
            (e) => { over(); throw e; });
  }

  /* "Signing piece 3 of 9", "Writing 2 of 4": the words for one step of a
   * card's work, or '' for a step with none. */
  fcProgressText(p) {
    /* A card made to wait by its own limit on one tap (08a-flashcard.js,
     * `cardWaitSigns`): how long is left, counted down as the card says. */
    if (p && p.step === 'waiting') {
      // how long it will be is the card's to know and it does not say (that would say what its limit is): how long it has been
      const s = Math.max(1, Math.round(Number(p.seconds) || 0));
      // a card of software 1.12 waits a limit's worth for the change it makes, within the limit as well as over it
      if (p.making) return 'The card is making change. Keep holding (' + s + ' s)';
      /* A card before 1.12 waits by what its pieces come to. A small payment made
       * with a piece worth much more than the price is not over anybody's
       * limit, and was being told it was: it is the piece that is. */
      if (p.want > 0 && p.sum >= 2 * p.want) return 'Paying from a larger piece. Keep holding (' + s + ' s)';
      // a card of 1.13 slows a second payment signed in one time in the field, limit or no limit (08a-flashcard.js, `cardPaid`)
      if (p.second) return 'A second payment in one tap. Keep holding (' + s + ' s)';
      return 'Over the card\u2019s per tap limit. Keep holding (' + s + ' s)';
    }
    // the card is owed change that no till has handed back, and the mint is being asked for it (08a-flashcard.js, `cardOwnerChange`)
    if (p && p.step === 'fetching') return 'Asking the mint for the change this card is owed. Keep holding';
    const i = Math.round(Number(p && p.i)), n = Math.round(Number(p && p.n));
    if (!(i > 0 && n > 0)) return '';
    // a card that signs once for a payment has no pieces to count
    if (p.step === 'signing') return p.all ? 'Signing' : 'Signing piece ' + i + ' of ' + n;
    if (p.step === 'writing') return 'Writing ' + i + ' of ' + n;
    /* The card makes its change a piece at a time, about half a second each over NFC, between the pieces being
     * named and the signature: said before each, so that the sheet is never quiet for seconds and the card is not
     * taken away (08a-flashcard.js, `cardSignGroup`). */
    if (p.step === 'change') return 'The card is making change \u00b7 piece ' + i + ' of ' + n + '. Keep holding.';
    return '';
  }

  /* Three buzzes, 0.15 s apart (Foxy/Bridge/FoxyBridge.swift, "triple"), silent: change is coming back to the card, so
   * there is a second tap to make. The page asks for them as the card is let go. Not felt while the phone's own NFC
   * sheet is up, which it is at that moment: iOS keeps its haptics to itself under its sheet. Kept for the day it does
   * not, and for a sheet that is already down. */
  fcChangeBuzz() {
    this.haptic && this.haptic('triple', true);
  }

  /* The line under the heading on the card's screen: what the card is doing
   * now. Made the first time it is needed, above the dots. */
  fcLine(text) {
    if (!this.stageUp('card')) return;
    const up = document.getElementById('foxy-stage');
    // a payment's screens say one thing each and leave the steps to the sheet (FC_LOOKS)
    if (up && up.getAttribute('data-look')) return;
    const h = up && up.querySelector('h1');
    if (!h || !h.parentElement) return;
    let line = /** @type {HTMLElement | null} */ (up.querySelector('[data-stage-line]'));
    if (!line) {
      line = document.createElement('p');
      line.setAttribute('data-stage-line', '1');
      line.style.cssText = 'margin:0;max-width:300px;text-align:center;font-family:Sora,system-ui,sans-serif;'
        + 'font-weight:800;font-size:19px;line-height:1.3;letter-spacing:.01em;color:#13333C';
      const col = h.parentElement;
      const dots = Array.from(col.children).filter((el) => el.querySelector && el.querySelector('span'))[0];
      col.insertBefore(line, dots || null);
    }
    line.textContent = String(text);
  }

  fcStage(step) {
    const words = this.FC_STEPS[step] || this.FC_STEPS.hold;
    const o = this._fcTapO || {};
    if (o.look) { this.fcLookStage(step); return; }
    if (!this.stageUp('card')) {
      this.stageScreen('card', {
        art: 'card', title: words[0], amount: o.amount || '', body: o.body || '',
        dots: true, forMs: 120000, button: 'CANCEL', keep: true,
        // the session ends as cancelled, and that is what takes this screen down
        go: () => { const W = this.fcW(); if (W) W.cardStop(); },
      });
    }
    const up = document.getElementById('foxy-stage');
    if (!up) return;
    const h = up.querySelector('h1');
    if (h) h.innerHTML = words[0];
    /* CANCEL is offered only while nothing has been asked of the card. After
     * that the way to stop is to finish: a card pulled away half-way has
     * signed for some of its money, and getting that back to it is a second
     * tap nobody needed. */
    const b = /** @type {HTMLElement | null} */ (up.querySelector('[data-stage-button]'));
    if (b) b.style.visibility = step === 'hold' ? 'visible' : 'hidden';
  }

  /* One of a payment's screens (FC_LOOKS), for this step of its tap. Drawn
   * again only when the step is said with a different one, so a card that
   * signs piece after piece, or is written to, does not make the screen blink.
   * `o.look` is 'pay' (the payment's own tap: the three in turn) or 'receive'
   * (a tap that only takes the change: TAP TO CONFIRM throughout). */
  fcLookStage(step) {
    const o = this._fcTapO || {};
    const was = document.getElementById('foxy-stage');
    const cur = (was && was.getAttribute('data-stage') === 'card' && was.getAttribute('data-look')) || '';
    // a step that names no screen of its own (`done`, `lost`) keeps the one that is up
    let name = o.look === 'receive' ? 'confirm' : (this.FC_LOOK_OF[step] || cur.replace(/Again$/, '') || 'tap');
    // signed: whatever was lost on the way is behind it, and the change's tap starts as TAP TO CONFIRM
    if (name === 'verify') o.lost = false;
    if (name === 'confirm' && o.putBack) name = 'back';
    // the card left part way through this tap (`fcTap`'s `again`, and the taps that take one up): TAP AGAIN
    if (o.lost && (name === 'tap' || name === 'confirm')) name += 'Again';
    if (cur !== name) {
      this.hideStage();
      const k = this.FC_LOOKS[name];
      const root = document.createElement('div');
      root.id = 'foxy-stage';
      root.setAttribute('data-stage', 'card');
      root.setAttribute('data-look', name);
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483300;display:flex;flex-direction:column;overflow:hidden;'
        + 'box-sizing:border-box;padding-top:env(safe-area-inset-top);background:' + k.ground + ';color:' + k.ink + ';'
        + 'font-family:Sora,system-ui,sans-serif;-webkit-font-smoothing:antialiased;animation:foxyIn .18s ease';
      root.innerHTML = this.fcLookHtml(name, o.amount || '');
      /* CANCEL, where the phone's sheet would be: under it on a phone, whose
       * sheet has its own, and the way out wherever there is no sheet. */
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;z-index:1;margin-top:auto;padding:20px 24px calc(44px + env(safe-area-inset-bottom))';
      const b = document.createElement('div');
      b.style.cssText = 'width:100%;height:60px;border-radius:18px;box-sizing:border-box;border:2px solid ' + k.ink + ';'
        + 'background:rgba(255,255,255,.35);font-family:Sora,system-ui,sans-serif;font-weight:800;font-size:17px;'
        + 'letter-spacing:.04em;text-transform:uppercase;color:' + k.ink + ';display:flex;align-items:center;'
        + 'justify-content:center;cursor:pointer';
      b.textContent = 'CANCEL';
      b.setAttribute('data-stage-button', '1');
      // the session ends as cancelled, and that is what takes this screen down
      b.addEventListener('click', () => { const W = this.fcW(); if (W) W.cardStop(); });
      wrap.appendChild(b);
      root.appendChild(wrap);
      document.body.appendChild(root);
      if (this.syncPreview) this.syncPreview();
      console.log('[foxy] screen: card, ' + name);
      // the rule every stage keeps: one that outlives what it waited for hides a working app
      this._stageT = setTimeout(() => this.hideStage('card'), name === 'verify' ? 180000 : 120000);
    }
    // offered only while nothing has been asked of the card, as on every card tap (`fcStage`)
    const up = document.getElementById('foxy-stage');
    const btn = /** @type {HTMLElement | null} */ (up && up.querySelector('[data-stage-button]'));
    if (btn) btn.style.visibility = step === 'hold' ? 'visible' : 'hidden';
  }

  /* The markup of one of them: the card (an outline to be tapped, with the
   * arrows flying into its mark, or the card itself with a spinner while the
   * mint is asked), then the heading, the line and the amount. */
  fcLookHtml(name, amount) {
    const k = this.FC_LOOKS[name] || this.FC_LOOKS.tap;
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const BLUE = '#0A84FF';
    // six arrows, one landing every 1.3 s, each on a path of its own (named whole, so the build can find each)
    const arrows = !k.ask ? '' : ['animation:cvHit0 7.8s linear 0s infinite', 'animation:cvHit1 7.8s linear 1.3s infinite',
      'animation:cvHit2 7.8s linear 2.6s infinite', 'animation:cvHit3 7.8s linear 3.9s infinite',
      'animation:cvHit4 7.8s linear 5.2s infinite', 'animation:cvHit5 7.8s linear 6.5s infinite'].map((fly) =>
      '<svg viewBox="0 0 32 40" width="26" height="32" fill="none" stroke="' + BLUE + '" stroke-width="4" stroke-linecap="round" '
      + 'stroke-linejoin="round" style="position:absolute;z-index:1;left:50%;top:50%;margin:-16px 0 0 -13px;opacity:0;'
      + fly + '">'
      + '<path d="M5 14 L16 3 L27 14"></path><path d="M16 4 L16 37"></path></svg>').join('');
    const shape = 'position:relative;width:345px;max-width:calc(100% - 30px);aspect-ratio:1.586;border-radius:16px;overflow:hidden;';
    const name23 = 'position:absolute;left:24px;top:20px;font-weight:800;font-size:23px;color:';
    const chip = 'position:absolute;left:24px;top:82px;width:54px;height:42px;border-radius:9px;';
    const corner = k.tick
      ? '<div style="position:absolute;right:20px;bottom:18px;width:44px;height:44px;border-radius:50%;background:#BFE3EC;display:flex;'
        + 'align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#0F2A33" '
        + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg></div>'
      : '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="' + k.ink + '" stroke-width="2.2" stroke-linecap="round" '
        + 'style="position:absolute;right:20px;bottom:18px"><path d="M8 8.5a5 5 0 0 1 0 7"></path><path d="M11.5 6a8.5 8.5 0 0 1 0 12"></path>'
        + '<path d="M15 3.5a12 12 0 0 1 0 17"></path></svg>';
    const card = k.ask
      ? '<div style="' + shape + 'background:transparent;border:3px dashed ' + k.ink + ';box-sizing:border-box;'
        + 'animation:cvTap 1.3s ease-out 3.2s infinite">'
        + '<div style="position:absolute;left:50%;top:50%;width:60px;height:60px;margin:-30px 0 0 -30px;'
        + 'animation:cvBounce 1.3s ease-out 3.2s infinite"><svg viewBox="0 0 40 40" width="60" height="60" fill="none" stroke="' + BLUE + '" '
        + 'stroke-width="3.5" stroke-linecap="round"><circle cx="20" cy="20" r="16.5"></circle>'
        + '<path d="M13.5 13.5l13 13M26.5 13.5l-13 13"></path></svg></div>'
        + '<div style="' + name23 + k.ink + '">FLASHcard</div>'
        + '<div style="' + chip + 'border:2.5px dashed ' + k.ink + ';box-sizing:border-box"></div>'
        + corner + '</div>'
      : '<div style="' + shape + 'background:' + k.ink + ';box-shadow:0 20px 40px rgba(15,42,51,.35)">'
        + '<div style="' + name23 + k.ground + '">FLASHcard</div>'
        + '<div style="' + chip + 'background:' + k.chip + '"></div>'
        + '<div style="position:absolute;right:22px;bottom:20px;width:58px;height:58px;border-radius:50%;'
        + 'border:5px solid rgba(191,227,236,.22);border-top-color:' + k.ground + ';box-sizing:border-box;'
        + 'animation:cvSpin .9s linear infinite"></div></div>';
    return (k.fur ? '<div style="position:absolute;inset:0;background-image:url(snow-fur.jpg);background-size:cover;'
        + 'mix-blend-mode:soft-light;opacity:.5;pointer-events:none"></div>' : '')
      + '<div style="position:relative;flex:0 0 auto;height:224px;margin-top:8px;display:flex;align-items:center;justify-content:center">'
      + arrows + card + '</div>'
      + '<div style="position:relative;padding:22px 32px 0;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center">'
      + '<h1 style="margin:0;font-weight:800;font-size:31px;line-height:1.05;white-space:nowrap;letter-spacing:-.01em;'
      + 'text-transform:uppercase">' + esc(k.title) + '</h1>'
      + '<p data-stage-line="1" style="margin:0;font-family:Figtree,Sora,system-ui,sans-serif;font-weight:500;font-size:19px;'
      + 'line-height:1.45;color:' + k.sub + ';text-wrap:pretty">' + esc(k.line) + '</p>'
      + (amount ? '<div style="margin-top:6px;font-weight:800;font-size:42px;letter-spacing:-.02em">' + esc(amount) + '</div>' : '')
      + '</div>';
  }

  /* A card's PIN, on the pad the lock uses. `o`: title, subtitle, warn, and
   * `cta`, what the button says: it names the thing the PIN is for ("PAY
   * $0.43"), and it cannot be pressed until four digits are in. The way out
   * is a back button at the top left, where every screen's is; `o.onBack`
   * runs after it. `o.second` is an answer that is not a PIN, under the
   * button: `{ label, go }` (NO PIN, when a card is set up). */
  fcAskPin(o, then) {
    const opt = o || {};
    this.pinOverlay({
      title: opt.title || 'CARD PIN',
      subtitle: opt.subtitle || '',
      warn: opt.warn || '',
      cta: opt.cta || 'NEXT',
      gate: true,
      second: opt.second || null,
      back: () => { if (opt.onBack) opt.onBack(); },
      onSubmit: (pin) => { this.pinDismiss(); then(pin); },
    });
  }

  /* Whether the card on screen has no PIN (software 1.16 and on can be set up without one). */
  fcHasNoPin() {
    const fc = this.state.fc;
    return !!(fc && fc.setUp && !fc.pinSet);
  }

  /* The card's PIN, asked for on the pad; or, for a card that has none, nothing is asked and `then` is
   * called with an empty PIN, which the wallet takes as none. */
  fcPinOr(o, then) {
    if (this.fcHasNoPin()) { then(''); return; }
    this.fcAskPin(o, then);
  }

  /* An amount for a card, typed where every other amount in Foxy is typed:
   * the SET AMOUNT screen, with its dollars first, its swap to sats, its 00
   * key, the back button at the top and NEXT at the bottom. `flow` says which
   * question is being asked ('cardAdd', 'cardWd', 'cardLimit'); NEXT comes
   * back through `fcAmountNext`. */
  fcAmount(flow) {
    this.setState(p => ({
      // one keypad at a time: asked from another card question's keypad, this takes its place
      screen: 'amount', stack: p.screen === 'amount' ? p.stack : p.stack.concat([p.screen]), flow,
      // dollars, as the receive flow starts; sats where there is no price to say dollars at
      amount: '', unit: this.px() ? 'USD' : 'SATS',
      asset: '', network: '', note: '', noteDraft: '', recipient: '', recipientKind: '',
    }));
  }

  fcAmountNext() {
    const flow = String(this.state.flow);
    const fc = this.state.fc;
    const sats = this.wantedSats();
    if (!fc) { this.back(); return; }
    if (!(sats > 0)) { this.toast('Type an amount first.', true); return; }
    /* In sats, whatever the screen was typed in. The line under the figure
     * says the same thing in red, but it is worked out in dollars and has
     * nothing to say with no price. */
    const have = Math.floor(this.balNow().sats || 0);
    if (flow === 'cardAdd' && sats > have) { this.toast('You have ' + this.fcBoth(have) + '.', true); return; }
    if (flow === 'cardWd' && sats > fc.balance) { this.toast('The card holds ' + this.fcBoth(fc.balance) + '.', true); return; }
    /* The PIN pad goes up over the keypad, which stays where it is: back
     * from the pad is back to the amount, still typed. The keypad is left
     * only when the PIN has been given (`fcLeaveAmount`). */
    if (flow === 'cardAdd') this.fcAddPin(sats);
    else if (flow === 'cardWd') this.fcWithdrawPin(sats);
    // a limit typed in dollars is kept in dollars (`fcLimitRun`): the card holds sats, and the price moves
    else if (flow === 'cardLimit') this.fcLimitConfirm(sats, this.state.unit === 'USD' ? Number(this.state.amount) || 0 : 0);
  }

  /* Off the keypad and back to the card's own screen, once an amount has
   * been taken from it. */
  fcLeaveAmount() {
    if (this.state.screen !== 'amount' || !/^card/.test(String(this.state.flow))) return;
    this.setState(p => ({
      screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1),
      flow: 'receive', amount: '', unit: 'USD',
    }));
  }

  /* ---- what went wrong, as a card --------------------------------------------
   *
   * Every refusal the wallet or the card can give, by its kind, in the words
   * of the screen list. `o.again` is what TRY AGAIN does, where trying again
   * can work; `o.taken` says whether "nothing was taken" is a true thing to
   * add (it is for a payment and a withdrawal, and means nothing for a read).
   */
  fcFailed(e, o) {
    const opt = o || {};
    const kind = String((e && e.card) || '');
    const said = String((e && e.message) || 'That did not work.');
    const safe = opt.taken ? ' Nothing was taken.' : '';
    const again = opt.again ? { retry: 'TRY AGAIN', go: opt.again, shut: { label: 'CANCEL' } } : {};
    console.log('[foxy] card: ' + (kind || 'failed') + ' — ' + said);
    // their own cancel, or no card held up: the screen they were on is the answer
    if (kind === 'cancelled') return;
    if (kind === 'waiting') { this.fcChecking(e && e.id, opt); return; }
    const cards = {
      'wrong-pin': () => Object.assign({ tone: 'warn', title: 'WRONG PIN',
        reason: ((e.tries === 1) ? '1 try left.' : (e.tries + ' tries left.')) + safe,
        // the last one is said for what it is: the card blocks itself for good
        chip: e.tries === 1 ? 'One more wrong PIN blocks this card for good.' : '' }, again),
      'blocked': () => ({ title: 'CARD BLOCKED',
        reason: 'Too many wrong PINs. This card can no longer pay until its owner sets a new PIN on it.' }),
      'not-enough': () => ({ tone: 'warn', title: 'NOT ENOUGH ON THE CARD',
        reason: 'It holds ' + this.fcSats(e.balance) + '.' + safe }),
      'other-mint': () => ({ tone: 'warn', title: 'A DIFFERENT MINT', reason: said }),
      'renew': () => ({ tone: 'warn', title: 'CARD NEEDS RENEWING',
        reason: 'Its owner must renew it with their own phone before it can pay.' }),
      'past-date': () => ({ tone: 'warn', title: 'ITS DATE HAS PASSED',
        reason: 'This phone can take this card’s money back with no card.',
        chip: 'FLASHCARD › CARDS YOU LOADED' }),
      'empty': () => ({ tone: 'warn', title: 'NO MONEY ON THIS CARD',
        reason: 'It has not been set up, or nothing has been put on it.' }),
      'not-a-card': () => ({ title: 'NOT A FOXY CARD', reason: said }),
      'no-route': () => Object.assign({ tone: 'warn', title: opt.taken ? 'NOT PAID' : 'NO CONNECTION',
        reason: 'The mint could not be reached.' + safe }, again),
      /* A till, and the card's day has too little left for this payment: said
       * before the PIN was sent, in the amounts a person reads, with when the
       * day turns. */
      'limit': () => ({ tone: 'warn', title: 'OVER THE CARD’S DAILY LIMIT',
        reason: (e.left !== undefined ? this.fcLimitRefusal(e) : said) + safe }),
      /* The same for the limit on one tap: said before the PIN was sent, with
       * what to do about it, which is to charge it in parts. */
      'tap-limit': () => ({ tone: 'warn', title: 'OVER THE CARD’S PER TAP LIMIT',
        reason: (e.left !== undefined ? this.fcTapRefusal(e) : said) + safe }),
      /* A card topped up near the end of its year holds money of two dates,
       * and one signature is for one of them: said before the PIN was sent,
       * with the most it can pay at once. */
      'two-dates': () => ({ tone: 'warn', title: 'TAKE IT IN TWO PARTS',
        reason: 'This card’s money was put on it at two different times, and one payment can use only one of them. The most it can pay at once is '
          + this.fcSats(e.most) + '.' + safe }),
      /* A card whose money is in more pieces than it signs for in one go:
       * said before the PIN was sent, with the most it can pay at once, where
       * that is known; and as the card's own refusal where it is the card
       * that said so. */
      'too-many': () => ({ tone: 'warn', title: 'TAKE IT IN PARTS',
        reason: (e.most > 0 ? 'This card can pay ' + this.fcSats(e.most) + ' at once. Its money is in more pieces than it signs for in one go.'
          : 'That is more pieces than the card signs for at once.') + safe }),
      'old-card': () => ({ tone: 'warn', title: 'NOT ON THIS CARD',
        reason: /limit on one tap/.test(said) ? 'This card’s software has no per tap limit. Its daily limit can still be set.' : said }),
      // software 1.16: a card with no PIN has no limit for payments without one; a card that has a PIN cannot be given another
      'no-pin': () => ({ tone: 'warn', title: 'THIS CARD HAS NO PIN', reason: said }),
      'has-pin': () => ({ tone: 'warn', title: 'THIS CARD HAS A PIN', reason: said }),
      // a PIN is wanted where none was given (the card's word at a tap that was not a payment's)
      'pin-needed': () => ({ tone: 'warn', title: 'THE CARD WANTS ITS PIN', reason: said + safe }),
      'not-owner': () => ({ tone: 'warn', title: 'NOT THIS PHONE’S CARD',
        reason: 'This phone does not hold the seed phrase this card was set up with, so it cannot change the card’s PIN or limit.',
        chip: 'Restore that seed phrase in Foxy, on this phone or another, to do it.' }),
      'no-owner': () => ({ tone: 'warn', title: 'THIS CARD HAS NO OWNER', reason: said }),
      'set-up': () => ({ tone: 'warn', title: 'THIS CARD HAS AN OWNER', reason: said }),
      'no-owner-key': () => ({ tone: 'warn', title: 'NO SEED PHRASE', reason: said }),
      'wrong-signer': () => ({ title: 'NOT A FOXY CARD', reason: said }),
      'no-time': () => ({ tone: 'warn', title: 'THE CARD HAS NO TIME', reason: said }),
      'no-time-source': () => ({ tone: 'warn', title: 'NO TIME TO TELL THE CARD', reason: said }),
      'gone': () => Object.assign({ tone: 'warn', title: 'THE CARD LEFT TOO SOON',
        reason: 'Hold it still until the phone says to remove it.' + safe }, again),
      /* The card left part-way through signing: nothing moved, and what it did
       * sign goes back on it at its next tap (with no PIN), or, where the mint
       * has not answered yet, once it has. Said by what the person was doing. */
      /* Not made yet (no route to the mint): there is nothing to write, and a
       * TAP CARD here only found "nothing was waiting for this card". */
      'interrupted': () => Object.assign({ tone: 'warn', title: opt.paying ? 'NOT PAID' : 'THE CARD LEFT TOO SOON',
        reason: 'The card was taken away too soon. ' + (opt.paying ? 'Nothing was paid. ' : 'Nothing was taken. ')
          + (e.made === false
            ? 'What it signed for is made ready to go back on it once this phone reaches the mint, and the card\u2019s next tap here puts it back.'
            : 'Tap it again to put back the ' + this.fcSats(e.owed) + ' it signed for. No PIN is needed.'),
        chip: 'Hold it still until the phone says to remove it.' },
        e.made === false ? { shut: { label: 'OK' } } : { retry: 'TAP CARD', go: () => this.fcWriteAsk({}), shut: { label: 'LATER' } }),
      'spent': () => ({ title: opt.taken ? 'NOT PAID' : 'ALREADY SPENT',
        reason: 'The mint says this card’s money was already spent.' }),
      'no-nfc': () => ({ tone: 'warn', title: 'NO CARD READER', reason: 'This phone cannot read a card.' }),
      'full': () => ({ tone: 'warn', title: 'THE CARD IS FULL', reason: said }),
      // offline, only an exact set of the card's pieces can be taken: said before the PIN, so nothing was taken
      'inexact': () => ({ tone: 'warn', title: 'NO CHANGE WHILE OFFLINE', reason: said + safe }),
      'bad-pieces': () => ({ tone: 'warn', title: 'THE CARD’S PIECES ARE NOT GOOD', reason: said }),
      /* The mint refused after the card had signed. The card burned the pieces
       * when it signed, so it has to be tapped again to have them put back (the
       * next tap clears the places and loads the same pieces). Its day stays
       * charged: only the owner's phone can give a day back. */
      // put back in the same sheet already: said, with nothing more to do
      'putback': () => (e.putBackDone > 0) ? ({ tone: 'warn', title: opt.paying ? 'PAYMENT FAILED' : 'NOT TAKEN OFF',
        reason: 'The mint refused it. ' + this.fcSats(e.putBackDone) + ' is back on the card.',
        chip: e.limited ? 'The card\u2019s daily limit stays used for it.' : '' }) : ({ tone: 'warn', title: opt.paying ? 'PAYMENT FAILED' : 'NOT TAKEN OFF',
        reason: 'The mint refused it, and the card had already signed for it. Tap the card again to put ' + this.fcSats(e.owed) + ' back on it.',
        chip: e.limited ? 'The card’s daily limit stays used for it.' : '',
        retry: 'TAP CARD', go: () => this.fcWriteAsk({}), shut: { label: 'LATER' } }),
      'misfit': () => ({ tone: 'warn', title: 'NOT AT THIS MINT', reason: said, chip: 'Nothing was taken.' }),
      'misfit-kept': () => ({ tone: 'warn', title: 'KEPT FOR THE CARD', reason: said }),
      'locked': () => ({ tone: 'warn', title: 'THE CARD IS LOCKED', reason: 'Nothing more can be written to it. It can still pay.' }),
      'too-soon': () => ({ tone: 'warn', title: 'NOT YET',
        reason: e.date ? 'This card can be taken back after ' + this.fcDay(e.date) + '.' : said }),
      'nothing': () => ({ tone: 'warn', title: 'NOTHING WAS LEFT ON IT', reason: said }),
    };
    const spec = (cards[kind] || (() => ({ tone: 'warn', title: 'THAT DID NOT WORK', reason: said + safe })))();
    this.haptic && this.haptic('error');
    this.blockedCard('fc-' + (kind || 'failed'), spec);
  }

  /* A time as a person reads it on a card's day: "3:40 PM" for today, and
   * with the day after it for any other. Written out here and not left to the
   * phone's region, as fcDay is. */
  fcWhen(secs) {
    const d = new Date((Number(secs) || 0) * 1000);
    const h = d.getHours();
    const clock = ((h % 12) || 12) + ':' + ('0' + d.getMinutes()).slice(-2) + (h < 12 ? ' AM' : ' PM');
    const t = new Date();
    return (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate())
      ? clock : clock + ', ' + this.fcDay(secs);
  }

  /* What a till is told when the card's day cannot cover the payment: how much
   * the card can still spend today and when its day turns. `e.left`, `e.turns`
   * and `e.limit` are the card's own, read before the PIN was sent. */
  /* Why a payment was over the limit on one tap: what the tap has left where
   * some of it is used (a tap is ten seconds to the card), or the limit. */
  fcTapRefusal(e) {
    // a card whose limit on one tap is waited for: said as the wait it would be, and what can be taken instead
    // the card does not say what its limit is to a till: only that this was too long to hold it for
    if (e.paced && e.hidden) return 'To pay this the card would have to be held longer than a tap lasts. It has a per tap limit: take it in smaller parts.';
    if (e.paced) {
      return 'To pay this the card would have to be held for ' + e.wait + ' seconds, which is longer than a tap lasts. Its per tap limit is '
        + this.fcBoth(e.limit) + ': take ' + this.fcBoth(e.left) + ' or less at a time.';
    }
    if (e.turns > 0 && e.left < e.limit) {
      return 'The card has ' + this.fcBoth(e.left) + ' left in this tap. Tap it again in ten seconds.';
    }
    return 'The card pays at most ' + this.fcBoth(e.limit || e.left) + ' in one tap, and this payment is more than that. Charge it in parts, a tap for each.';
  }

  fcLimitRefusal(e) {
    if (e.turns > 0 && e.left < e.limit) {
      return 'The card can still spend ' + this.fcBoth(e.left) + ' today. Its day turns at ' + this.fcWhen(e.turns) + '.';
    }
    return 'The card can spend ' + this.fcBoth(e.limit || e.left) + ' in a day, and this payment is more than that.';
  }

  /* The card has signed and the mint has not answered.
   *
   * The one state in which nobody knows yet: the card has marked its pieces
   * spent, and whether they became this phone's is the mint's to say. Asked
   * again every five seconds, a dozen times, and never past this screen: the
   * wallet asks again by itself whenever it connects, and the payment is in
   * HISTORY when it lands. */
  fcChecking(id, o) {
    const W = this.fcW();
    const opt = o || {};
    let tries = 0;
    clearTimeout(this._fcCheckT);
    this.stageScreen('cardChecking', {
      art: 'card', title: 'CHECKING',
      body: 'The card has signed and the mint has not answered yet.',
      dots: true, forMs: 70000, button: 'CLOSE',
      go: () => clearTimeout(this._fcCheckT),
    });
    const settled = (how, row) => {
      clearTimeout(this._fcCheckT);
      this.hideStage('cardChecking');
      if (how === 'paid') {
        this.fcMoved(opt);
        // the mint's answer came late, and the change it made waits for the card's second tap (RECEIVE)
        if (opt.paying && row && row.change > 0 && !row.refund) this.fcReceiveNow(row.change, row.sats);
        return;
      }
      if (how === 'spent') { this.fcFailed({ card: 'spent' }, { taken: opt.taken }); return; }
      if (how === 'putback') { this.fcFailed({ card: 'putback', owed: row && row.owed, limited: row && row.limited }, opt); return; }
      if (how === 'bad') { this.fcFailed({ card: 'bad-pieces', message: 'The card gave pieces the mint did not sign. Nothing was paid.' }, opt); return; }
      this.blockedCard('fc-still', { tone: 'warn', title: 'STILL CHECKING',
        reason: 'The mint has not answered. Foxy keeps asking, and this will be in HISTORY when it does.',
        chip: opt.paying ? 'It is not paid until then.' : '' });
    };
    const ask = () => {
      // closed, or timed out: the asking stops with the screen
      if (!this.stageUp('cardChecking')) return;
      W.cardSettle().then((rows) => {
        if (!this.stageUp('cardChecking')) return;
        const mine = (rows || []).filter(r => r.id === id)[0];
        if (mine && mine.state === 'paid') return settled('paid', mine);
        if (mine && mine.state === 'spent') return settled('spent');
        if (mine && mine.state === 'putback') return settled('putback', mine);
        if (mine && mine.state === 'bad') return settled('bad');
        if (!mine) {
          // answered by the wallet's own asking, between two of ours: the entry says which way
          return W.transactions(50).then((list) => settled((list || []).some(t => t.hash === id) ? 'paid' : 'spent'));
        }
        tries += 1;
        if (tries >= 12) return settled('waiting');
        this._fcCheckT = setTimeout(ask, 5000);
        return null;
      }, () => settled('waiting'));
    };
    this._fcCheckT = setTimeout(ask, 3000);
  }

  /* Money has moved by a card and the screens catch up. A payment is
   * announced by the history pass like any other; a holder's own move is said
   * by the flow that made it (16-history-lists.js keeps the pass quiet). */
  fcMoved(o) {
    const opt = o || {};
    if (opt.paying && this.state.screen === 'confirm') this.closeReceive();
    if (opt.paying && this.noteReceived) this.noteReceived();
    this.refreshBalance();
    this.loadHistory();
    if (opt.paying && this.tidyChangeNow) this.tidyChangeNow();
    if (!opt.paying && opt.done) opt.done();
  }

  /* ---- being paid by a card (the receive screen's CARD button) -------------- */

  payByCard() {
    const W = this.fcW();
    if (!W) return;
    const s = this.state;
    const sats = (!s.invoiceIsAddress && W.amountOf && W.amountOf(s.invoice)) || this.wantedSats();
    if (!(sats > 0)) { this.toast('Enter an amount first.', true); return; }
    /* No route to the mint: the mint cannot say paid. The card may still be taken,
     * as plain ecash is on trust, if the person says so, in front of the amount,
     * before the PIN is asked for (the HIGH RISK card: until this phone is online,
     * whoever gave it can still spend it). Only an exact set of the card's pieces
     * is taken then, which the tap finds out before the PIN is sent. */
    if (W.cardOnline && !W.cardOnline() && W.cardOffline && W.cardOffline()) {
      W.cardOfflineAsk(sats).then((yes) => { if (yes) this.fcPayStart(sats, true); });
      return;
    }
    if (this.offlineNow()) { this.offlineNo('A card payment'); return; }
    this.fcPayStart(sats);
  }

  /* The CARD button: the sheet comes up and the card is tapped at once, with no PIN asked for first. A card
   * with no PIN, or one whose no PIN limit covers the payment, pays in this tap. Any other says so (the sheet
   * ends with "Enter the card\u2019s PIN"; software before 1.16 always does), and the PIN pad comes up for a
   * second tap (`fcPayAsk`, from the rejection in `fcPayRun`). `trusted`: the person has said yes to taking
   * it with no route. */
  fcPayStart(sats, trusted) {
    this.fcPayRun(sats, '', trusted);
  }

  /* The card's PIN, for the second tap: asked for after the card has said it wants one, or after a wrong
   * one. TAP AGAIN pays with it. */
  fcPayAsk(sats, trusted, resuming) {
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To pay ' + this.fcBoth(sats) + '. The card\u2019s owner types its PIN here.',
      cta: 'TAP AGAIN',
    }, (pin) => this.fcPayRun(sats, pin, trusted, resuming));
  }

  /* A card payment is two taps, and is said as two every time, so a person
   * learns one way of paying: SEND (the card signs no more than two pieces and
   * is let go), VERIFY (this screen, while the mint swaps them), RECEIVE (the
   * change goes back on, with no PIN) and COMPLETE. Paid exactly, there is
   * nothing to receive, and the payment is complete at once. Taken on trust
   * with no route, it is one tap: only an exact set is taken then. */
  /* `resuming`: the same payment, taken up again after the card left part way
   * through: the card signs only what it had not (08a-flashcard.js, `cardHeld`). */
  fcPayRun(sats, pin, trusted, resuming) {
    const W = this.fcW();
    // (after a try with no PIN, trying again is the same: the card says whether it wants one)
    const opt = { paying: true, taken: true, again: () => (pin ? this.fcPayAsk(sats, trusted) : this.fcPayStart(sats, trusted)) };
    /* A new payment: a confirmation still held for the one before (its change
     * tap never ended in anything this screen heard of) is not this one's, and
     * is not raised over it. It is in HISTORY. */
    if (!resuming) this.fcDropConfirm();
    this.fcTap({ amount: this.fcPrice(sats), look: 'pay', lost: !!resuming,
                 sheet: resuming ? 'Hold the card here again to finish paying' : '', warm: !trusted, paying: true,
                 /* the card left part way through: the same sheet asks for it again, and the payment is taken up in it */
                 again: (e) => (e && e.card === 'interrupted' && e.resumable) ? 'Hold the card here again to finish paying'
                   : (e && e.card === 'gone') ? 'Hold the card here again' : '' },
               (link, on, progress) => {
                 /* A tap to feel the moment the card has signed and may be lifted: the
                  * phone's own sheet takes about three seconds to go after it is told
                  * to, and nothing on it says the card's part is over. Its own kind,
                  * and silent: the payment's buzz and sound are for PAYMENT RECEIVED. */
                 let felt = false;
                 const onPay = (step, info) => {
                   // (with change coming it is three buzzes instead, which the tap's own step handler gives: `fcChangeBuzz`)
                   if (!felt && (step === 'checking' || step === 'mint')) { felt = true; if (!(info && info.change)) this.haptic && this.haptic('tap', true); }
                   on(step, info);
                 };
                 return W.cardPay(link, { sats, pin, on: onPay, progress, trusted: !!trusted, keepSheet: !trusted })
                   .then((r) => this.fcChangeInSheet(link, on, progress, r, pin), (e) => this.fcPutBackInSheet(link, on, progress, e, pin));
               })
      .then((r) => {
        this.haptic && this.haptic('success');
        /* Taken on trust: kept, and not paid. The mint has not been asked, so
         * nothing here says paid; it settles when this phone is online. */
        if (r && r.trusted) { this.fcTrusted(r); return; }
        const ch = r && r.change;
        const receiving = !!(ch && !ch.written && !ch.unmade && ch.sats > 0);
        // the change went back in the same sheet: the payment is whole, and its PAYMENT RECEIVED goes up now
        if (ch && ch.written && ch.sats > 0) this.fcReleaseConfirm('the change is back on the card');
        // no change to take after all (too small, or not made): the confirmation is not held for it
        else if (!receiving) this.fcReleaseConfirm('no change to take');
        this.fcMoved(opt);
        /* Made, and not written back in that sheet (it was dismissed, or the
         * phone's minute ran out): the second tap is asked for at once, with
         * TAP TO CONFIRM up from now until it is over, so the till is never
         * looking at its home screen between a payment and its change. */
        if (receiving) this.fcReceiveNow(ch.sats, sats);
        // not made: this phone tries again when it connects, and says so
        if (ch && ch.unmade && ch.sats > 0) this.fcChangeLater(ch.sats, sats);
        /* A payment of this card's held for another amount was let go as this
         * one finished: its pieces go back on at the same second tap. */
        const back = r && r.letGo && r.letGo.made ? Math.round(Number(r.letGo.sats) || 0) : 0;
        if (back > 0 && !(ch && !ch.written && !ch.unmade && ch.sats > 0)) this.fcReceiveNow(back, sats);
        // a piece the card signed as it was taken away, whose answer never came: said, quietly
        if (r && r.torn > 0) this.toast(this.fcSats(r.torn) + ' the card signed as it was taken away never reached this phone.', true);
      }, (e) => {
        // not paid: nothing of this payment's is held back (a hold begun as the mint was asked is let go)
        this.fcDropConfirm();
        /* The card wants its PIN for this payment (it has one and no no PIN limit covers it, or its software
         * always asks): the sheet ended saying so, nothing was signed or taken, and the pad comes up. */
        if (e && e.card === 'pin-needed' && !pin) { this.fcPayAsk(sats, trusted, resuming); return; }
        /* The card left part way through signing, and the sheet that looked for
         * it again was dismissed: what it signed is held, said with TAP CARD.
         * Where the phone could not keep the sheet up (an older one), a new
         * sheet comes up by itself instead, once iOS has taken the last down. */
        if (e && e.card === 'interrupted' && e.resumable) {
          if (e.sheetClosed) this.fcHeldCard(sats, pin, trusted); else this.fcResumeNow(sats, pin, trusted);
          return;
        }
        // taken up, and the card could not make the rest: what it signed goes back, and why is said
        if (e && e.card === 'not-enough' && e.still > 0) { this.fcShortHeld(e, sats); return; }
        // that tap read no card, or the card left before signing anything more: the hold stands, said with TAP CARD
        if (resuming && e && (e.card === 'cancelled' || e.card === 'gone')) { this.fcHeldCard(sats, pin, trusted); return; }
        this.fcFailed(e, opt);
      });
  }

  /* The sheet again, a moment after the one the card left: iOS refuses a
   * reading session started on the heels of the last. The PIN typed for this
   * payment is used again, as it is for every tap of the one payment. And a
   * settling once the hold could be stale, so one nobody came back for goes
   * back to the card even with Foxy left open. */
  fcResumeNow(sats, pin, trusted) {
    clearTimeout(this._fcResumeT);
    this._fcResumeT = setTimeout(() => this.fcPayRun(sats, pin, trusted, true), 2500);
    // TAP AGAIN stays up through the pause, with nothing to press
    this._fcTapO = { look: 'pay', amount: this.fcPrice(sats), paying: true, lost: true };
    this.fcStage('reading');
    this.fcHeldClock();
  }

  /* A payment taken up again that the card could not finish: it holds too
   * little for the rest (often because a piece it signed as it was taken away
   * never arrived). What it signed for the payment is given back; the tap that
   * puts it on is one press away. */
  fcShortHeld(e, sats) {
    const back = e.letGo && e.letGo.made ? Math.round(Number(e.letGo.sats) || 0) : 0;
    this.fcReleaseConfirm('the payment was not finished');
    this.blockedCard('fc-short', Object.assign({
      tone: 'warn', title: 'NOT PAID',
      reason: 'The card holds ' + this.fcSats(e.balance) + ', and ' + this.fcSats(e.still) + ' of ' + this.fcSats(sats) + ' was still to pay.'
        + (e.torn > 0 ? ' ' + this.fcSats(e.torn) + ' it signed as it was taken away never reached this phone, and cannot be spent.' : '')
        + (back > 0 ? ' What it signed for this payment goes back on it: tap it to put it back.' : ' What it signed for this payment goes back on it once this phone reaches the mint.'),
    }, back > 0 ? { retry: 'TAP CARD', go: () => this.fcWriteAsk({ sheet: 'Hold the card here to put back what it signed' }), shut: { label: 'LATER' } }
                : { shut: { label: 'OK' } }));
  }

  fcHeldClock() {
    const W = this.fcW();
    clearTimeout(this._fcHeldT);
    this._fcHeldT = setTimeout(() => { if (W && W.cardSettle) W.cardSettle().then(null, () => {}); }, 185000);
  }

  /* Held, and the tap to finish read no card: said, with the tap again, and
   * CANCEL, which gives back what the card signed (`fcLetGo`). */
  fcHeldCard(sats, pin, trusted) {
    this.fcHeldClock();
    this.blockedCard('fc-held', {
      tone: 'warn', title: 'NOT PAID YET',
      reason: 'The card was taken away before it had signed for all of ' + this.fcSats(sats) + '. Tap it again to finish paying.',
      chip: 'Nothing is paid until then. CANCEL puts back what it signed.',
      retry: 'TAP CARD', go: () => this.fcPayRun(sats, pin, trusted, true),
      shut: { label: 'CANCEL', tap: () => this.fcLetGo() },
    });
  }

  /* The payment is given up: what the card signed for it is made into pieces
   * for the card again, and the sheet comes up by itself to put them back. With
   * no route to the mint they are made once there is one, and said so. */
  fcLetGo() {
    const W = this.fcW();
    if (!W || !W.cardHeldLetGo) return;
    W.cardHeldLetGo().then((r) => {
      if (r && r.made && r.sats > 0) { this.fcReceiveNow(r.sats, 0, { putBack: true }); return; }
      if (r && r.sats > 0) {
        this.blockedCard('fc-let-go', {
          tone: 'warn', title: 'NOT PAID',
          reason: 'What the card signed goes back on it once this phone reaches the mint, and the card\u2019s next tap here puts it back.',
          shut: { label: 'OK' },
        });
        return;
      }
      /* A card that signs once for a payment, taken away as it signed: whether
       * it signed is the card's to say, at its next tap here. */
      if (W.cardAskedOpen && W.cardAskedOpen() > 0) {
        this.blockedCard('fc-let-go', {
          tone: 'warn', title: 'NOT PAID',
          reason: 'If the card signed as it was taken away, its next tap on this phone finds that out and puts the money back on it.',
          shut: { label: 'OK' },
        });
      }
    }, () => {});
  }

  fcTrusted(r) {
    this.blockedCard('fc-trusted', {
      tone: 'warn', title: 'TAKEN ON TRUST',
      reason: this.fcSats(r.sats) + ' was taken from the card, but this phone is offline, so the mint has not been asked. '
        + 'It is not paid until this phone is online and the mint has swapped it. Until then it waits in HISTORY, pending.',
      chip: 'Whoever gave it can still spend it until then.',
      shut: { label: 'OK', tap: () => { if (this.state.screen === 'confirm') this.closeReceive(); } },
    });
    // the pending entry is in HISTORY now, and the balance counts what is waiting
    this.refreshBalance();
    this.loadHistory();
  }

  /* The change for a payment could not be made (the mint did not make it):
   * the payment stands, and this phone makes the change when it next
   * connects, after which a tap of the card here receives it. */
  fcChangeLater(sats, paid) {
    const p = Math.round(Number(paid) || 0);
    this.blockedCard('fc-change-later', {
      tone: 'warn', title: 'CHANGE NOT MADE YET',
      reason: (p > 0 ? 'Paid ' + this.fcSats(p) + '. ' : '') + 'The mint did not make its ' + this.fcSats(sats)
        + ' of change. This phone tries again whenever it connects, and then a tap of the card here receives it.',
      chip: 'It is owed to that card and no other.',
      shut: { label: 'OK' },
    });
  }

  /* The second tap of a payment, asked for as soon as the mint has said paid:
   * the phone's sheet comes up by itself for the card again, with nothing to
   * press first. PIN, tap, remove the card, wait, tap again. A sheet that ends
   * with no card read (cancelled, timed out, Foxy put away) leaves TAP TO
   * RECEIVE up instead, so the change is never left without a way to it. A
   * moment's pause first: iOS refuses a reading session started on the heels
   * of the last one. */
  fcReceiveNow(sats, paid, o) {
    const p = Math.round(Number(paid) || 0);
    const n = Math.round(Number(sats) || 0);
    const putBack = !!(o && o.putBack);
    clearTimeout(this._fcReceiveT);
    // TAP TO CONFIRM from now, through the pause and the tap, with nothing to press until the sheet is up
    if (!putBack) { this._fcTapO = this.fcReceiveLook(p, n); this.fcStage('receive'); }
    this._fcReceiveT = setTimeout(() => {
      const W = this.fcW();
      // written meanwhile (or never owed here): nothing to ask for, and nothing to hold a confirmation for
      if (!W || !this.fcOwedAfterPaying()) {
        this.hideStage('card');
        this.fcReleaseConfirm('nothing is waiting for the card');
        return;
      }
      this.fcWriteRun('', { change: true, receive: !putBack, paid: p, sats: n,
                            sheet: putBack ? 'Hold the card here to put back what it signed' : '' });
    }, 2500);
  }

  /* What TAP TO CONFIRM is drawn with for a tap that only takes change: the
   * amount of the payment it is the second tap of, or of the change where
   * this phone did not take the payment. */
  fcReceiveLook(paid, sats) {
    return { look: 'receive', amount: this.fcPrice(paid > 0 ? paid : sats) };
  }

  /* The second tap of a payment: RECEIVE. `paid` is what was paid, where
   * this phone was the till; a holder's own withdrawal with change has none. */
  fcChangeWaiting(sats, paid) {
    const p = Math.round(Number(paid) || 0);
    this.blockedCard('fc-change', {
      tone: 'warn', title: 'TAP TO RECEIVE',
      reason: (p > 0 ? 'Paid ' + this.fcSats(p) + '. ' : 'The money is off the card. ')
        + 'Tap the card again to receive its ' + this.fcSats(sats) + ' of change. No PIN is needed.',
      chip: (p > 0 ? 'Tap 2 of 2. ' : '') + 'The change is kept for that card and no other.',
      retry: 'TAP CARD', go: () => this.fcWriteAsk({ paid: p, receive: true }),
      shut: { label: 'LATER', tap: () => this.fcReleaseConfirm('the change is left for later') },
    });
  }

  /* ---- what this phone owes cards -------------------------------------------
   *
   * Pieces made for a card and not on it yet: a top-up whose tap was cut
   * short, a payer's change, something a card signed for and was not paid.
   * They are locked to that card, so only it can spend them, and they go on
   * at the next tap with its PIN. */
  fcOwed() {
    const W = this.fcW();
    const by = {};
    ((W && W.cardOwed()) || []).forEach((r) => { by[r.card] = (by[r.card] || 0) + (Number(r.sats) || 0); });
    return Object.keys(by).map(key => ({ key, sats: by[key] }));
  }

  fcWriteAsk(o) {
    const opt = o || {};
    /* Money moved for a card waits at the mint it was moved to, and can only
     * be written from there: said here, with the way to get there, and not
     * found out at the tap. */
    const W = this.fcW();
    const here = String((W && W.mintUrl) || '').replace(/\/+$/, '');
    const away = ((W && W.cardOwed()) || []).filter(r => r.mint && here && r.mint !== here)[0];
    if (away && !opt.here) {
      this.blockedCard('fc-other-mint', {
        tone: 'warn', title: 'A DIFFERENT MINT',
        reason: 'That money is at ' + this.mintNameOf(away.mint) + '. Switch this phone to it, then tap the card.',
        retry: 'SWITCH MINT', go: () => this.goSwitchMint(), shut: { label: 'CANCEL' },
      });
      return;
    }
    /* The card on screen is this phone's own: it loads it with its own proof and
     * no PIN. Any other card is written to as a till writes change, with its PIN. */
    const fc = this.state.fc;
    if (fc && fc.ownedHere && this.state.screen === 'flashcard' && !opt.pin) { this.fcWriteRun('', Object.assign({}, opt, { owner: true })); return; }
    /* What is owed is a payment's change, or pieces a card signed for a payment
     * that was not made: the card has just paid, and lets the tap after a payment
     * put pieces on with no PIN. Tapped first without one; a card that asks for
     * it after all is given it on the next tap. */
    if (!opt.pin && this.fcOwedAfterPaying()) { this.fcWriteRun('', Object.assign({}, opt, { change: true })); return; }
    const owed = this.fcOwed().reduce((n, r) => n + r.sats, 0);
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: owed > 0 ? 'To put ' + this.fcBoth(owed) + ' on the card.' : 'To write to the card.',
      cta: owed > 0 ? 'PUT ' + this.fcPrice(owed) + ' ON CARD' : 'WRITE TO CARD',
      // backed out of: a payment's confirmation held for this goes up
      onBack: () => this.fcReleaseConfirm('the change was not taken'),
    }, (pin) => this.fcWriteRun(pin, opt));
  }

  /* Whether what this phone owes cards came of a payment: change, a refund of
   * what a card signed and left with, or a payment the mint refused put back. */
  fcOwedAfterPaying() {
    const W = this.fcW();
    return ((W && W.cardOwed()) || []).some((r) => r && (r.kind === 'change' || r.kind === 'refund' || r.kind === 'putback'));
  }

  /* `opt.owner`: this phone's own proof that it owns the card, and no PIN.
   * `opt.change`: the tap after a payment, which needs none either. */
  fcWriteRun(pin, o) {
    const W = this.fcW();
    const opt = o || {};
    const how = opt.owner ? { owner: true } : opt.change ? { change: true } : { pin };
    const looks = opt.receive ? this.fcReceiveLook(Math.round(Number(opt.paid) || 0), Math.round(Number(opt.sats) || 0)) : {};
    this.fcTap({ amount: looks.amount || (opt.sats ? this.stageMoney(opt.sats) : ''), look: looks.look || '', lost: !!opt.lost,
                 sheet: opt.sheet || (opt.receive ? 'Hold the card here again for its change' : ''),
                 // what went on stays on: the same sheet asks for the card again for the rest
                 again: (e) => (e && e.card === 'gone') ? 'Hold the card here again for the rest' : '' },
               (link, on, progress) => { on('writing'); return W.cardWrite(link, Object.assign({ progress }, how)); })
      .then((r) => this.fcWrote(r, opt),
            /* Not the owner after all (another card was tapped), or not the tap
             * after a payment after all: the PIN is what writes then. */
            (e) => ((opt.owner && e && e.card === 'not-owner') || (opt.change && e && e.card === 'pin-needed'))
              ? this.fcWriteAsk(Object.assign({}, opt, { pin: true, owner: false, change: false }))
              : (e && e.card === 'cancelled')
                ? this.fcStillWaiting(opt)
                /* The card left after some pieces went on: the sheet again by
                 * itself for the rest. A tap of it that reads no card says what
                 * is still waiting. Where nothing went on, the card says so and
                 * waits to be asked, so a card that keeps leaving is not asked forever. */
                // the sheet asked for the card again and was dismissed: what is still waiting is said, with TAP CARD
                : (e && e.card === 'gone' && e.sheetClosed)
                  ? this.fcStillWaiting(opt)
                : (e && e.card === 'gone' && e.wrote > 0)
                  ? this.fcWriteAgain(opt)
                  : (this.fcReleaseConfirm('the change tap failed'), this.fcFailed(e, { again: () => this.fcWriteAsk(opt) })));
  }

  /* RECEIVE in the same sheet as SEND.
   *
   * The card has signed and may be taken away; the sheet stayed up saying so
   * (`keepSheet`, 08a-flashcard.js) while the mint answered and the change was
   * made. Now the same sheet asks for the card again and puts the change on,
   * with no PIN, and ends saying the change is back. A second sheet opened for
   * this was refused by iOS as often as not, and the person was left a card to
   * press. Never throws: whatever is not done here (the sheet dismissed, or
   * timed out at iOS's minute, or a card that wants its PIN) is left on the
   * result unwritten, and the screen takes it from there. */
  fcChangeInSheet(link, on, progress, r, pin) {
    const W = this.fcW();
    const ch = r && r.change;
    if (!W || !link || link.released || typeof link.again !== 'function' || !(ch && !ch.written && !ch.unmade && ch.sats > 0)) return Promise.resolve(r);
    let tries = 0;
    // TAP TO CONFIRM from the moment the card is asked for, and not only once it is found
    const once = (line) => { this.fcStage('receive'); return ask(line); };
    // and TAP AGAIN once the card has left part way through being written to
    const lost = () => { if (this._fcTapO) this._fcTapO.lost = true; };
    /* With no PIN, as the card allows the one tap after a payment. A card that
     * left part way through has used that tap up, and wants its PIN for the
     * rest: it is given the one typed for this payment, as every tap of the
     * one payment is (`fcResumeNow`), and nobody is asked for it twice. */
    const put = (withPin) => W.cardWrite(link, withPin ? { pin, progress } : { change: true, progress })
      .then(null, (e) => { if (!withPin && pin && e && e.card === 'pin-needed') return put(true); throw e; });
    const ask = (line) => link.again(line).then(() => {
      on('writing');
      return put(false).then((w) => {
        if (w && w.left > 0 && w.sats > 0 && tries < 3) { tries += 1; lost(); return once('Hold the card here again for the rest of its change'); }
        // written when nothing made for this payment is still owed to a card
        const still = ((W.cardOwed && W.cardOwed()) || []).some((x) => x && r && x.forHash === r.hash);
        ch.written = !!(w && !(w.left > 0) && !still);
        if (ch.written) link.doneText = 'Done. ' + this.fcSats(ch.sats) + ' of change is back on the card.';
        return r;
      }, (e) => {
        // taken away while it was written: what went on stays on, and the same sheet asks again
        if (e && e.card === 'gone' && tries < 3) { tries += 1; lost(); return once('Hold the card here again for its change'); }
        return r;
      });
    }, () => r);
    return once('Tap the card again for its change');
  }

  /* The mint refused a payment after the card had signed, with the sheet still
   * up (`keepSheet`): what is still good goes back on the card in the same
   * sheet, and the payment's failure is said once it is back. Always rejects
   * with the payment's own error; `putBackDone` says it went back, and
   * `sheetText` ends the sheet calmly. */
  fcPutBackInSheet(link, on, progress, e, pin) {
    const W = this.fcW();
    if (!W || !e || e.card !== 'putback' || !(e.owed > 0) || !link || link.released || typeof link.again !== 'function') return Promise.reject(e);
    let tries = 0;
    // the same ground as a payment's second tap, saying what this one is for
    if (this._fcTapO) this._fcTapO.putBack = true;
    const once = (line) => { this.fcStage('receive'); return ask(line); };
    // with the payment's own PIN where the card has used up its tap without one (`fcChangeInSheet`)
    const put = (withPin) => W.cardWrite(link, withPin ? { pin, progress } : { change: true, progress })
      .then(null, (x) => { if (!withPin && pin && x && x.card === 'pin-needed') return put(true); throw x; });
    const ask = (line) => link.again(line).then(() => {
      on('writing');
      return put(false).then((w) => {
        if (w && w.left > 0 && w.sats > 0 && tries < 3) { tries += 1; return once('Hold the card here again for the rest'); }
        if (w && w.back > 0 && !(w.left > 0)) {
          e.putBackDone = w.back;
          e.sheetText = 'The payment did not go through. ' + this.fcSats(w.back) + ' is back on the card.';
        }
        throw e;
      }, (x) => {
        if (x && x.card === 'gone' && tries < 3) { tries += 1; return once('Hold the card here again'); }
        throw e;
      });
    }, () => { throw e; });
    return once('The payment did not go through. Tap the card to put it back');
  }

  /* A card payment's PAYMENT RECEIVED (announcePayment, 12-receive.js) waits
   * while its change is made and taken: it came up the moment the payment
   * landed, with the payer still to tap for their change, and read as if it
   * were over. It goes up when the change is back on the card, when the
   * change is left for later, when nothing is owed for the payment any more
   * however that came about, or after two and a half minutes whatever
   * happens, so it is never lost.
   *
   * `hash` is the payment's entry: only its confirmation is held. A hold that
   * held whatever came kept one payment's confirmation through the next
   * payment, and raised it, with its amount, when that one's change went back. */
  fcHoldConfirm(hash) {
    this._holdConfirmUntil = Date.now() + this.FC_HOLD_MS;
    this._holdConfirmFor = String(hash || '');
    clearTimeout(this._holdConfirmT);
    this._holdConfirmT = setTimeout(() => this.fcReleaseConfirm('the change tap took too long'), this.FC_HOLD_MS);
  }

  fcReleaseConfirm(why) {
    if (this.releaseHeldConfirm) { this.releaseHeldConfirm(why); return; }
    clearTimeout(this._holdConfirmT);
    this._holdConfirmUntil = 0;
    this._holdConfirmFor = '';
  }

  /* The hold let go with nothing raised: for a payment that was not made, and
   * for one left over when the next payment begins. */
  fcDropConfirm() {
    if (this._heldConfirm) console.log('[foxy] confirmation: a held one is dropped, not raised; it is in HISTORY');
    this._heldConfirm = null;
    clearTimeout(this._holdConfirmT);
    this._holdConfirmUntil = 0;
    this._holdConfirmFor = '';
  }

  /* Whether anything made for a card after a payment is still to go back on
   * one; and the confirmation let go when nothing is. Asked after every tap
   * that could have written it, whatever that tap came to: the change of a
   * payment went back on a tap that ended as cancelled, nothing said so, and
   * its PAYMENT RECEIVED never came. */
  fcConfirmIfSettled(why) {
    if (this.fcOwedAfterPaying()) return false;
    this.fcReleaseConfirm(why || 'nothing is waiting for the card');
    return true;
  }

  fcWriteAgain(o) {
    clearTimeout(this._fcResumeT);
    this._fcResumeT = setTimeout(() => this.fcWriteAsk(Object.assign({}, o, { sheet: 'Hold the card here again for the rest', lost: true })), 2500);
    // a payment's second tap, which the card left part way through: TAP AGAIN stays up through the pause
    if (o && o.receive) {
      this._fcTapO = Object.assign(this.fcReceiveLook(Math.round(Number(o.paid) || 0), Math.round(Number(o.sats) || 0)), { lost: true });
      this.fcStage('receive');
    }
  }

  /* A write tap that closed with no card read (the sheet went without a tap,
   * or was cancelled): what is still waiting is said again, with the tap to
   * try once more, instead of nothing. A person who has just been told to tap
   * for their change must not be left wondering whether anything happened. */
  fcStillWaiting(opt) {
    const owed = this.fcOwed().reduce((n, r) => n + r.sats, 0);
    // it all went on after all, in a tap that ended as if it had not: the payment is whole
    if (!(owed > 0)) { this.fcReleaseConfirm('nothing is waiting for the card'); return; }
    const after = this.fcOwedAfterPaying();
    this.blockedCard('fc-change', {
      tone: 'warn', title: after ? 'TAP TO RECEIVE' : 'TAP THE CARD AGAIN',
      reason: 'The card was not read. ' + this.fcSats(owed) + ' is still waiting to go ' + (after ? 'back on it.' : 'onto it.') + (after ? ' No PIN is needed.' : ''),
      chip: 'It is kept for that card and no other.',
      retry: 'TAP CARD', go: () => this.fcWriteAsk(opt),
      shut: { label: 'LATER', tap: () => this.fcReleaseConfirm('the change is left for later') },
    });
  }

  fcWrote(r, o) {
    // a card that was at another mint and has been moved by this write is told so, below
    const was = String((this.state.fc && this.state.fc.mint) || '').replace(/\/+$/, '');
    this.fcShow(r.card);
    const now = String((r.card && r.card.record && r.card.record.mint) || '').replace(/\/+$/, '');
    const moved = !!(was && now && was !== now);
    this.refreshBalance();
    this.loadHistory();
    /* Cut short with some of it written: the sheet comes up again by itself
     * for the rest (a tap of it that reads no card says what is still waiting,
     * `fcStillWaiting`). Not where nothing went on: that would ask forever. */
    if (r.left > 0 && r.why !== 'full' && r.sats > 0) { this.fcWriteAgain(o); return; }
    if (r.left > 0) {
      this.blockedCard('fc-more', {
        tone: 'warn', title: r.why === 'full' ? 'THE CARD IS FULL' : 'TAP THE CARD AGAIN',
        reason: (r.sats > 0 ? this.fcSats(r.sats) + ' went on. ' : '')
          + (r.why === 'full' ? 'There is no room for the rest. Take some money off it first.' : 'The rest is still waiting for it.'),
        retry: 'TAP CARD', go: () => this.fcWriteAsk(o),
        shut: { label: 'LATER', tap: () => this.fcReleaseConfirm('the rest is left for later') },
      });
      return;
    }
    /* Nothing made after a payment is waiting for a card any more: that
     * payment's confirmation is not held for it, whatever this tap put on.
     * (A payment's change says so itself, below.) */
    if (!(r.change > 0 && r.change + (r.refund || 0) === r.sats)) this.fcConfirmIfSettled('nothing is waiting for the card');
    if (!(r.sats > 0)) {
      /* Nothing was owed to the card that was tapped. Where something is
       * still owed, it is owed to another card, and saying so is the only way
       * the person finds out they picked up the wrong one. */
      const owed = this.fcOwed();
      this.blockedCard('fc-none', {
        tone: 'warn', title: owed.length ? 'A DIFFERENT CARD' : 'NOTHING TO WRITE',
        reason: owed.length
          ? 'Nothing was waiting for this card. ' + this.fcSats(owed[0].sats) + ' is waiting for ' + this.fcName(owed[0].key) + '.'
          : 'Nothing was waiting for this card.',
      });
      return;
    }
    this.haptic && this.haptic('success');
    /* A payment the mint refused, put back: said as that, with what else went on in the same tap. */
    if (r.back > 0) {
      this.blockedCard('fc-put-back', {
        tone: 'ask', title: 'PUT BACK ON THE CARD',
        reason: this.fcSats(r.back) + ' is back on the card. The payment was not made.'
          + (r.sats > r.back ? ' ' + this.fcSats(r.sats - r.back) + ' more went on.' : '')
          + (this.state.screen === 'flashcard' ? ' It now holds ' + this.fcSats(r.card.balance) + '.' : ''),
        shut: { label: 'DONE' },
      });
      return;
    }
    /* The second tap of a payment: its change is back on the card, and the
     * payment is COMPLETE. */
    /* The change of a payment, back on the card: said in passing, and the
     * payment's own PAYMENT RECEIVED, held until now, goes up at once. It was
     * a COMPLETE card with DONE, and the confirmation waited on the press,
     * which did not always come. */
    if (r.change > 0 && r.change + (r.refund || 0) === r.sats) {
      this.toast(this.fcSats(r.change) + ' of change is back on the card'
        + (r.refund > 0 ? ', and ' + this.fcSats(r.refund) + ' from a payment that was not finished' : '') + '.');
      this.fcReleaseConfirm('the change is back on the card');
      return;
    }
    /* What a card signed for a payment that was not made, back on it: said
     * as that, and not as money put on it. */
    if (r.refund > 0 && r.refund === r.sats) {
      this.blockedCard('fc-refunded', {
        tone: 'ask', title: 'BACK ON THE CARD',
        reason: this.fcSats(r.refund) + ' is back on the card. The payment was not made.'
          + (this.state.screen === 'flashcard' ? ' It now holds ' + this.fcSats(r.card.balance) + '.' : ''),
        shut: { label: 'DONE' },
      });
      return;
    }
    /* What it now holds is said to its holder, on the FLASHCARD screen. A
     * till putting a payer's change back says the change and nothing else. */
    this.blockedCard('fc-on', {
      tone: 'ask', title: 'ON THE CARD',
      reason: this.fcSats(r.sats) + ' went onto the card.'
        + (this.state.screen === 'flashcard' ? ' It now holds ' + this.fcSats(r.card.balance) + '.' : '')
        + (moved ? ' The card is now at ' + this.mintNameOf(now) + '.' : '')
        // an amount of too many pieces is rounded up, so the card has fewer to sign for and is quicker to use
        + ((o && o.rounded > 0) ? ' ' + this.fcSats(o.rounded) + ' more than you asked for, so the card holds fewer pieces and is quicker to use.' : ''),
      shut: { label: 'DONE' },
    });
  }

  /* ---- MENU > FLASHCARD: reading a card ---------------------------------- */

  /* `open`: the card's screen is opened by what is read (the menu's way in).
   *
   * The owner's read also looks into the change the card has made for itself and no till has handed
   * back (`change`, 08a-flashcard.js `cardOwnerChange`): fetched from the mint, and put on the card
   * in this tap when there is any, with the sheet saying so. */
  fcRead(open) {
    const W = this.fcW();
    if (!W) return;
    // with the price, so that a limit this phone set in dollars is kept at those dollars (08a-flashcard.js, `cardLook`)
    this.fcTap({}, (link, on, progress) => W.cardLook(link, { mine: true, price: (this.px && this.px()) || 0, change: true, on, progress })
      .then((card) => {
        if (card && card.owes && card.owes.wrote > 0) link.doneText = 'Done. ' + this.fcSats(card.owes.wrote) + ' of change is back on the card.';
        return card;
      }))
      .then((card) => {
        this.fcShow(card, open);
        // change a till never handed over has been fetched and put on: said in passing, as change put back always is
        if (card && card.owes && card.owes.wrote > 0) { this.haptic && this.haptic('success'); this.refreshBalance(); this.loadHistory(); }
      }, (e) => this.fcFailed(e, { again: () => this.fcRead(open) }));
  }

  /* What a card said, kept for the screen. Only on the FLASHCARD screen, or
   * on the way to it (`open`): a payer's card read at the till is not left
   * on show in the menu. */
  fcShow(card, open) {
    if (!card || !card.key) return;
    if (this.state.screen !== 'flashcard') {
      if (!open) return;
      this.setState(p => ({ screen: 'flashcard', stack: p.stack.concat([p.screen]) }));
    }
    const W = this.fcW();
    const dates = (card.pieces || []).map(x => x.date).filter(Boolean);
    this._fcCard = card;
    this.setState({ fc: {
      key: card.key, balance: card.balance, count: (card.pieces || []).length,
      room: card.info.empty + card.info.spent,
      pin: card.info.pin, locked: !!card.info.locked, hasRecord: !!card.info.hasRecord,
      /* software 1.16 and on: the PIN is optional. `setUp`: the card has its record (and, before 1.16, a PIN); `pinSet`: it has a PIN (a blocked one does);
       * `noPinKnown`: its software can be without one and has the no PIN limit; `noPin`: that limit and what is left of it today (`known`, `set`, `limit`, `left`) */
      setUp: !!card.info.setUp, pinSet: !!card.info.pinSet, noPinKnown: !!card.info.noPinKnown, noPin: card.noPin || null,
      limit: (card.record && card.record.limit) || 0,
      day: card.day || null,
      // the limit on one tap: { known, limited, limit, left, turns }; `known` false on a card whose software has none
      tap: card.tap || null,
      // the card's own log, where this phone is its owner and the card keeps one: counts, the last eight taps, what is new
      log: card.log || null,
      // its receipts, as this phone has them: { count, list, fresh }; and how far its clock is ahead of this phone's, in seconds
      receipts: card.receipts || null,
      // (for a card before 1.15 only: a card of 1.15 and on is ahead of this phone's newest block header at most, which no screen says)
      clockAhead: (card.info && card.info.headers) ? 0 : Math.round(Number(card.clockAhead) || 0),
      // a card of software 1.15 and on keeps its time by Bitcoin block headers: the block its clock reads (the hash of the last it was shown, and the time in it)
      headers: !!(card.info && card.info.headers),
      clock: (card.info && card.info.headers) ? { hash: String(card.info.headerHash || ''), short: (W && card.info.headerHash) ? W.headerShort(card.info.headerHash) : '', time: Number(card.info.now) || 0 } : null,
      owner: !!(card.info && card.info.owner),
      // whether this phone is its owner, which the card was asked (a till does not ask)
      ownedHere: card.mine === true,
      mint: (card.record && card.record.mint) || '',
      recoverable: !!(card.record && card.record.refundKey),
      mine: !!(W && W.cardIsMine(card)),
      first: dates.length ? Math.min.apply(null, dates) : 0,
      last: dates.length ? Math.max.apply(null, dates) : 0,
      check: (card.pieces || []).length ? 'asking' : 'none',
      // the design it is drawn in: what the card says, or what this phone wrote down for it (`FoxyWallet.cardLook`)
      design: String(card.design || ''),
      // what it holds in pieces larger than its limit on one tap, as its owner read it: a till holds longer for those
      above: card.mine === true ? this.fcAbove(card, (card.tap && card.tap.limited) ? card.tap.limit : 0) : 0,
      // the change it made for itself that no till has handed back, as its owner's read left it (08a-flashcard.js, `cardOwnerChange`)
      owes: (card.owes && card.owes.parts && card.owes.parts.length) ? { sats: card.owes.sats, parts: card.owes.parts } : null,
    } });
    this.fcOwesLater(card);
    if ((card.pieces || []).length) this.fcCheck(card);
    // ecash found for this card is asked of the mint, and the line about it redrawn if any of it was not owed after all
    if (W && W.cardOwedCheck) W.cardOwedCheck(card).then((gone) => { if (gone) this.forceUpdate(); }, () => {});
  }

  /* What the line under the balance says of the change the card is owed (`fc.owes`), by where it stands. */
  FC_OWES = {
    put: 'FETCHED AND PUT ON',
    fetched: 'FETCHED, WAITING TO GO ON',
    fetching: 'BEING FETCHED',
    unmade: 'NOT YET MADE BY THE TILL',
    offline: 'NO CONNECTION TO FETCH IT',
    away: 'AT ANOTHER MINT',
    silent: 'THE MINT DID NOT ANSWER',
    stuck: 'CANNOT BE FINISHED',
  };

  /* The mint was still being asked for the card's change when its owner's tap went on: when it has answered, the line
   * says where that stands (what was fetched is owed to the card and goes on at the next tap), if it is the card on show. */
  fcOwesLater(card) {
    const later = card && card.owes && card.owes.later;
    if (!later || typeof later.then !== 'function') return;
    later.then((o) => {
      if (!o || !o.parts || !this.state.fc || this.state.fc.key !== card.key || this._fcCard !== card) return;
      this.setState({ fc: Object.assign({}, this.state.fc, { owes: { sats: o.sats, parts: o.parts } }) });
    }, () => {});
  }

  /* The mint's word on what the card says it holds. A card is a list of
   * pieces and a promise not to sign twice; whether the pieces are still good
   * is something only the mint knows. */
  fcCheck(card) {
    const W = this.fcW();
    /* A card read the short way (after a write or a limit set, say) lists no
     * nonces, so there is nothing to put to the mint: what the screen says of
     * the mint's word is what the card's own screen found when it was opened,
     * reading the card whole, and it stands. */
    if (card.bare) return;
    /* With the mint's word goes when it was given: now, or, where the mint
     * could not be asked, when this phone last had it for these same pieces
     * (`cardCheckedAt`). The screen says that under its title. */
    const put = (check, at) => {
      if (!this.state.fc || this.state.fc.key !== card.key || this._fcCard !== card) return;
      this.setState({ fc: Object.assign({}, this.state.fc, { check, checkedAt: Number(at) || 0 }) });
    };
    const before = () => { try { return W.cardCheckedAt ? W.cardCheckedAt(card) : 0; } catch (e) { return 0; } };
    W.cardCheck(card).then((r) => put(r.spent > 0 ? { spent: r.spent } : 'ok', r.spent > 0 ? 0 : (r.at || Date.now())),
                           (e) => put((e && e.card) === 'other-mint' ? 'other' : 'off', before()));
  }

  /* How long ago, as a title says it: "Just Now", "2 Hours Ago" (`agoWords`,
   * with its words capitalised). */
  fcAgo(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n < 90 * 1000) return 'Just Now';
    return String(this.agoWords(n)).replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  /* Whether money can be moved on or off the card that is on screen, said
   * before any pad is raised. */
  fcReady(doing) {
    const fc = this.state.fc;
    if (!fc || !this._fcCard) return false;
    if (this.offlineNow()) { this.offlineNo(doing); return false; }
    const W = this.fcW();
    const here = (W && W.mintHost && W.mintHost()) || '';
    const there = String(fc.mint || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (there && here && there !== String(here).replace(/^https?:\/\//, '').replace(/\/+$/, '')) {
      this.fcOtherMint(doing);
      return false;
    }
    return true;
  }

  /* The card is at another mint than this phone. What can be done about it
   * depends on what is on it:
   *
   *   anything, and the only way is to take it all off first (a card's money is
   *   at one mint, and the record cannot change under it): ADD FUNDS says so, in
   *   those words, with nothing to press but CLOSE; the other things a card does
   *   offer to move the phone to the card's mint, as ever;
   *   nothing, on its owner's phone: SWITCH TO <this phone's mint> goes straight
   *   to the amount, and the card's record is rewritten in the same tap that
   *   writes the funds (`fcAddRun`, the owner's proof, no PIN; its PIN, its
   *   owner, its limit and its time key stay as they are);
   *   nothing, on any other phone: only the phone that set the card up can
   *   change its record, and the card says so. */
  fcOtherMint(doing) {
    const fc = this.state.fc;
    const adding = doing === 'Adding funds';
    const at = this.mintNameOf(fc.mint), here = this.mintName();
    if (adding && fc.count > 0) {
      this.blockedCard('fc-other-mint', {
        tone: 'warn', title: 'A DIFFERENT MINT',
        reason: 'You need to withdraw all funds on the card before you can switch mints.',
      });
      return;
    }
    if (adding && fc.ownedHere && fc.owner) {
      this.blockedCard('fc-other-mint', {
        tone: 'warn', title: 'A DIFFERENT MINT',
        reason: 'This card holds nothing, and is set up at ' + at + '. This phone is at ' + here + '.',
        retry: 'SWITCH TO ' + String(here).toUpperCase(), go: () => this.fcAmount('cardAdd'), shut: { label: 'CANCEL' },
      });
      return;
    }
    if (adding) {
      this.blockedCard('fc-other-mint', {
        tone: 'warn', title: 'A DIFFERENT MINT',
        reason: 'This card holds nothing, and is set up at ' + at + '. This phone is at ' + here
          + '. Only the phone that set the card up can switch it to another mint: use that phone to do it.',
      });
      return;
    }
    this.blockedCard('fc-other-mint', {
      tone: 'warn', title: 'A DIFFERENT MINT',
      reason: 'This card’s money is at ' + at + '. This phone is at ' + here + '.',
      retry: 'SWITCH MINT', go: () => this.goSwitchMint(), shut: { label: 'CANCEL' },
    });
  }

  /* ---- a new card ----------------------------------------------------------
   * A PIN, typed twice (or NO PIN, under the pad, for a card of software 1.16 and on); then whether a lost card's money can come back (while
   * FC_RECOVERABLE offers it); then one tap that writes the PIN, the record and,
   * last, the owner; then home. Nothing is read between the PIN and the tap and
   * nothing after it (a notice that this phone becomes the owner, and one that
   * the card is cash, were two screens before a card that holds nothing; what
   * they said is in docs/CARD.md). No limit is asked for or suggested: a new
   * card has none, and one is set later from CHANGE LIMIT. The PIN is typed
   * here, once, and never again to add funds. The mint is this phone's, shown
   * and not chosen. */
  fcSetUp() {
    const fc = this.state.fc;
    if (!fc) return;
    // a card of software 1.16 and on may be without a PIN: NO PIN under the pad is one tap, and home
    const second = (fc.noPinKnown && !fc.pinSet) ? { label: 'NO PIN', go: () => this.fcSetUpNoPin() } : null;
    // no mint is asked: the card is told this phone's mint and given a key from this phone's words
    const first = (warn) => this.fcAskPin({
      title: 'CHOOSE A PIN',
      subtitle: 'Four to eight digits. The card asks for it every time it pays.',
      warn: warn || '',
      second,
    }, (a) => this.fcAskPin({
      title: 'TYPE IT AGAIN',
      subtitle: 'So a mistyped digit does not become the card’s PIN.',
    }, (b) => {
      if (a !== b) { first('Those did not match. Start again.'); return; }
      if (this.FC_RECOVERABLE) this.fcSetUpKind(a); else this.fcSetUpRun(a, false);
    }));
    first('');
  }

  fcSetUpNoPin() {
    if (this.FC_RECOVERABLE) this.fcSetUpKind(''); else this.fcSetUpRun('', false);
  }

  fcSetUpRun(pin, recoverable) {
    const W = this.fcW();
    this.fcTap({ body: 'Setting it up at ' + this.mintName() + '.' }, (link, on) => { on('writing'); return W.cardSetUp(link, { pin, recoverable, design: this.FC_SETUP_DESIGN }); })
      .then((card) => {
        this.fcShow(card);
        this.haptic && this.haptic('success');
        // set up, and home, said in a line: the card's screen, with ADD FUNDS on it, is a tap away under FLASHCARD
        this.setState({ screen: 'home', stack: [] });
        this.toast('The card is set up.');
      }, (e) => this.fcFailed(e, { again: () => this.fcSetUpRun(pin, recoverable) }));
  }

  fcSetUpKind(pin) {
    this.blockedCard('fc-kind', {
      tone: 'ask', title: 'IF THE CARD IS LOST',
      reason: 'RECOVERABLE: this phone can take the money back after a year.\n'
        + 'LIKE CASH: lose the card and the money is gone. Choose it for a gift.',
      chip: 'Its money will be at ' + this.mintName() + '.',
      retry: 'RECOVERABLE', go: () => this.fcSetUpRun(pin, true),
      shut: { label: 'LIKE CASH', tap: () => this.fcSetUpRun(pin, false) },
    });
  }

  /* ---- add funds ------------------------------------------------------------
   * The amount, the card's PIN, then the mint, then the card: the pieces are
   * made before the tap, so the card is held for as long as writing takes and
   * no longer. A tap that fails leaves them owed to the card. */
  fcAdd() {
    if (!this.fcReady('Adding funds')) return;
    this.fcAmount('cardAdd');
  }

  /* The owner's phone adds funds with its own proof and no PIN: the PIN was
   * typed once, at set-up. Any other phone, with the card's PIN, adds them as a
   * till writes change. The daily limit is not touched by putting money on. */
  fcAddPin(sats) {
    const fc = this.state.fc;
    if (fc && fc.ownedHere) { this.fcLeaveAmount(); this.fcAddRun(sats, '', true); return; }
    this.fcAddAskPin(sats);
  }

  fcAddAskPin(sats) {
    // (a card with no PIN is loaded by whoever holds it: nothing to ask)
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: 'To add ' + this.fcBoth(sats) + ' to the card.',
      cta: 'ADD ' + this.fcPrice(sats) + ' TO CARD',
    }, (pin) => { this.fcLeaveAmount(); this.fcAddRun(sats, pin, false); });
  }

  fcAddRun(sats, pin, owner) {
    const W = this.fcW();
    const card = this._fcCard;
    this.stageScreen('cardReady', {
      art: 'card', title: 'GETTING<br>IT READY', amount: this.stageMoney(sats),
      body: 'Keep the card nearby. You will be asked to tap it in a moment.',
      dots: true, forMs: 90000, button: 'CLOSE',
    });
    /* A card that holds nothing and is at another mint than this phone's is told
     * its new mint in the tap that writes the funds (the owner's proof; `fcOtherMint`
     * only offers this to its owner): the money is made for the mint this phone is at. */
    const there = String((card && card.record && card.record.mint) || '').replace(/\/+$/, '');
    const here = String(W.mintUrl || '').replace(/\/+$/, '');
    const moving = !!(there && here && there !== here && !((card.pieces || []).length));
    W.cardPrepare(card, sats, { moving }).then((made) => {
      // said by this flow, so not announced as a payment sent (16-history-lists.js)
      if (made && made.hash) this.txIsNew(made.hash);
      this.hideStage('cardReady');
      this.fcWriteRun(pin, { sats: made.sats, owner: !!owner, asked: sats, rounded: Number(made.rounded) || 0 });
    }, (e) => {
      this.hideStage('cardReady');
      this.fcFailed(e, {});
    });
  }

  /* ---- withdraw --------------------------------------------------------------
   * An amount on the keypad, or ALL OF IT, which is the button under its
   * NEXT (23-render-home-and-amount.js). */
  fcWithdraw() {
    if (!this.fcReady('Withdrawing')) return;
    const fc = this.state.fc;
    if (!(fc.balance > 0)) { this.toast('There is nothing on this card.', true); return; }
    this.fcAmount('cardWd');
  }

  fcWithdrawPin(sats) {
    const fc = this.state.fc;
    if (!fc) return;
    this.fcPinOr({
      title: 'ENTER PIN TO WITHDRAW',
      subtitle: (sats ? this.fcBoth(sats) : 'Everything') + ' from the card to this phone.',
      cta: sats ? 'WITHDRAW ' + this.fcPrice(sats) : 'WITHDRAW ALL',
    }, (p) => { this.fcLeaveAmount(); this.fcWithdrawRun(sats, p); });
  }

  /* `before`: what earlier taps of this same withdrawal took off the card
   * (a tap cut short keeps what the card signed, and the next takes the rest).
   * The PIN is held for the length of the withdrawal, as for one tap: the
   * card that says TAP CARD for the rest is still this flow, and LATER ends it. */
  /* `again`: { rest } where this is the sheet come up by itself for the rest of
   * a withdrawal cut short; a tap of it that reads no card puts the TAP CARD
   * card up instead. */
  fcWithdrawRun(sats, pin, before, again) {
    const W = this.fcW();
    const prior = Math.round(Number(before) || 0);
    /* What came off in this tap's sheet, as it is cut short and taken up again
     * in the same sheet (`again` below), and what is still to take. */
    let took = prior, ask = sats;
    const counted = new Set();
    const absorb = (e) => {
      if (!e || e.card !== 'partial' || counted.has(e)) return;
      counted.add(e);
      took += Math.round(Number(e.sats) || 0);
      if (e.hash) this.txIsNew(e.hash);
      ask = sats ? Math.round(Number(e.left) || 0) : 0;
    };
    const partCard = (got, rest) => this.blockedCard('fc-part', {
      tone: 'warn', title: 'TAP THE CARD AGAIN',
      reason: this.fcSats(got) + ' came off the card into this phone before it was taken away. Tap it again for the rest'
        + (rest > 0 ? ', ' + this.fcSats(rest) + '.' : '.'),
      chip: 'Hold it still until the phone says to remove it.',
      retry: 'TAP CARD', go: () => this.fcWithdrawRun(sats ? rest : 0, pin, got),
      shut: { label: 'LATER' },
    });
    const said = (r) => {
      // the card as it reads now, where the tap lasted long enough to read it; otherwise its screen goes
      if (r && r.card) this.fcShow(r.card); else this.fcGone();
      this.haptic && this.haptic('success');
      const got = took + Math.round(Number(r && r.sats) || 0);
      this.blockedCard('fc-out', {
        tone: 'ask', title: 'IN YOUR WALLET',
        reason: (got > 0 ? this.fcSats(got) : 'The money') + ' from the card is in this phone now.',
        shut: { label: 'DONE' },
      });
    };
    const opt = { taken: true, again: () => this.fcWithdraw(), done: () => said(null) };
    this.fcTap({ amount: sats ? this.stageMoney(sats) : '', warm: true, sheet: again ? 'Hold the card here again for the rest' : '',
                 again: (e) => {
                   if (e && e.card === 'partial' && Number(e.left) > 0) { absorb(e); return 'Hold the card here again for the rest'; }
                   return (e && e.card === 'gone') ? 'Hold the card here again' : '';
                 } },
               (link, on, progress) => W.cardWithdraw(link, ask ? { pin, sats: ask, on, progress, keepSheet: true } : { pin, on, progress, keepSheet: true })
                 .then((r) => this.fcChangeInSheet(link, on, progress, r, pin)))
      .then((r) => {
        if (r && r.hash) this.txIsNew(r.hash);
        this.fcMoved({});
        said(r);
        const ch = r && r.change;
        if (ch && !ch.written && !ch.unmade && ch.sats > 0) this.fcChangeWaiting(ch.sats);
      }, (e) => {
        absorb(e);
        /* The sheet looked for the card again and was dismissed, or a sheet for
         * the rest read no card: the TAP CARD card, with what came off so far. */
        if (took > prior || (again && e && (e.card === 'cancelled' || e.card === 'gone'))) {
          if (e && (e.sheetClosed || e.card === 'cancelled' || e.card === 'gone')) {
            this.fcMoved({});
            this.fcGone();
            partCard(took, sats ? ask : 0);
            return;
          }
        }
        if (!(e && e.card === 'partial')) { this.fcFailed(e, opt); return; }
        /* Cut short where the phone could not keep the sheet up (an older one):
         * a new sheet comes up by itself for the rest, once iOS has taken the
         * last down, with the PIN already given. */
        this.fcMoved({});
        this.fcGone();
        this.haptic && this.haptic('warning');
        // nothing left on the card to take: the withdrawal is whole
        if (!(Math.round(Number(e.left) || 0) > 0)) { said({ sats: 0 }); return; }
        clearTimeout(this._fcResumeT);
        this._fcResumeT = setTimeout(() => this.fcWithdrawRun(sats ? ask : 0, pin, took, { rest: ask }), 2500);
      });
  }

  /* What the screen knew of the card is out of date and is not shown as if it
   * were current: the next thing to do with the card is to tap it. */
  fcGone() {
    this._fcCard = null;
    if (this.state.fc) this.setState({ fc: null });
    // with no list of cards to show, the screen with no card on it is not one to be left on
    if (!this.FC_RECOVERABLE && this.state.screen === 'flashcard') this.back();
  }

  /* ---- its PIN, its limit, its date ------------------------------------------ */

  /* CHANGE PIN, and UNBLOCK, which is the same: the owner's phone sets a new PIN
   * with its proof. The old PIN is not asked for, because this phone does not
   * know it and a blocked or forgotten PIN is the case that needs this. */
  fcChangePin() {
    const fc = this.state.fc;
    if (!fc) return;
    const W = this.fcW();
    // said before anything is asked
    if (!fc.owner) { this.fcFailed({ card: 'no-owner', message: 'This card has no owner, so its PIN cannot be changed.' }); return; }
    if (fc.ownedHere === false) { this.fcFailed({ card: 'not-owner' }); return; }
    const was = fc.pin === 'blocked';
    const fresh = (warn) => this.fcAskPin({
      title: 'NEW PIN', subtitle: 'Four to eight digits.', warn: warn || '',
    }, (a) => this.fcAskPin({ title: 'NEW PIN AGAIN', subtitle: 'So a mistyped digit does not become the card’s PIN.' }, (b) => {
      if (a !== b) { fresh('Those did not match. Start again.'); return; }
      this.fcTap({}, (link, on) => { on('writing'); return W.cardChangePin(link, { newPin: a }); })
        .then(() => {
          this.haptic && this.haptic('success');
          this.blockedCard('fc-pin', { tone: 'ask', title: was ? 'CARD UNBLOCKED' : 'PIN CHANGED', reason: 'The card asks for the new one from now on.', shut: { label: 'DONE' } });
          // what the screen knew of the card is out of date: a blocked card is not blocked now
          if (was && this.state.fc) this.setState({ fc: Object.assign({}, this.state.fc, { pin: 'set' }) });
        }, (e) => this.fcFailed(e, { again: () => this.fcChangePin() }));
    }));
    fresh('');
  }

  /* ADD PIN, in CHANGE PIN's place on a card that has none: the owner's phone gives it one, as at set-up (a PIN, typed
   * twice, and one tap). The card then asks for it for every payment until a no PIN limit is set. */
  fcPinAdd() {
    const fc = this.state.fc;
    if (!fc) return;
    const W = this.fcW();
    if (!fc.owner) { this.fcFailed({ card: 'no-owner', message: 'This card has no owner, so a PIN cannot be added to it.' }); return; }
    if (fc.ownedHere === false) { this.fcFailed({ card: 'not-owner' }); return; }
    const fresh = (warn) => this.fcAskPin({
      title: 'CHOOSE A PIN', subtitle: 'A card with no PIN is cash to whoever holds it. Four to eight digits.', warn: warn || '',
    }, (a) => this.fcAskPin({ title: 'TYPE IT AGAIN', subtitle: 'So a mistyped digit does not become the card’s PIN.' }, (b) => {
      if (a !== b) { fresh('Those did not match. Start again.'); return; }
      this.fcTap({}, (link, on) => { on('writing'); return W.cardAddPin(link, { pin: a }); })
        .then((card) => {
          this.fcShow(card);
          this.haptic && this.haptic('success');
          this.toast('PIN added. Every payment asks for it until you set a no-PIN limit.');
        }, (e) => this.fcFailed(e, { again: () => this.fcPinAdd() }));
    }));
    fresh('');
  }

  /* Whether the card on show waits by the rule of software 1.13 (`cardWaitSigns`), which the words on its limit screens
   * say: a card read as the one before it (a card that signs once, of format 4, and is not 1.13 yet: the rule of 1.12 is
   * its words) has the old rule's words. Anything else, and a card not read yet, has the newest. */
  fcShaped() {
    const c = this._fcCard;
    return !(c && c.info && c.info.format === 4 && c.info.shaped === false);
  }

  /* ---- the daily limit ---------------------------------------------------------
   *
   * The most the card signs for in one day. CHANGE LIMIT asks for it in three
   * steps, and the owner's phone sets it with its proof and
   * no PIN:
   *
   *   a warning       what a daily limit is, and who can change it
   *   an amount       the keypad every amount is typed on, dollars first, with
   *                   NO LIMIT as the way to remove one
   *   a confirmation  the amount again, and what it means
   *
   * `fcLimitAsk(done)` runs them and calls `done(sats)` with the screens that
   * were opened for them gone: `sats` is 0 for NO LIMIT.
   *
   * A card has a second limit, on ONE TAP, asked for by the same three steps
   * in its own words (`tap`): for the card that makes its own change the first
   * step is HOW TAP LIMIT WORKS (26g-tap-limit-explainer.js), the rule played
   * out, and for the card of 1.12 a warning in its own words.
   *
   * A card of software 1.16 and on that has a PIN has a third, the NO PIN
   * LIMIT (`tap` is 'nopin'): the most it signs for in a day without its PIN,
   * asked for in the same three steps; none (NO LIMIT under the keypad) is 0,
   * and every payment then asks for the PIN. */
  fcLimitAsk(done, tap) {
    const np = tap === 'nopin';
    this._fcLimitDone = done;
    this._fcLimitTap = tap === true;
    this._fcLimitNoPin = np;
    if (tap === true && this.fcShaped()) {
      this.fcTapLimitExplainer({ go: () => this.fcAmount('cardLimit'), cancel: () => { this._fcLimitDone = null; } });
      return;
    }
    this.blockedCard('fc-limit-warn', np ? {
      tone: 'warn', title: 'SET NO PIN LIMIT',
      reason: 'A no PIN limit is the most this card will pay in one day without its PIN. Over it, the PIN is asked for the whole payment. Only payments made without the PIN count against it. Anyone holding the card can spend this much a day without the PIN.\n\n'
        + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.\n\n'
        + 'If you lose the seed phrase for this Foxy app, the PIN and the limits on this card can never be changed.\n\n'
        + 'Do you wish to continue?',
      retry: 'CONTINUE', go: () => this.fcAmount('cardLimit'),
      shut: { label: 'CANCEL', tap: () => { this._fcLimitDone = null; } },
    } : tap ? {
      tone: 'warn', title: 'SET PER TAP LIMIT',
      reason: 'A per tap limit is the most this card pays in one tap straight away, when it pays exactly. A payment that makes change holds the card 3 seconds; one over the limit, 3 seconds for every limit\u2019s worth of what leaves the card. Lift the card and the payment stops, with nothing taken.\n\n'
        + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.\n\n'
        + 'If you lose the seed phrase for this Foxy app, the PIN and the limits on this card can never be changed.\n\n'
        + 'Do you wish to continue?',
      retry: 'CONTINUE', go: () => this.fcAmount('cardLimit'),
      shut: { label: 'CANCEL', tap: () => { this._fcLimitDone = null; } },
    } : {
      tone: 'warn', title: 'SET DAILY LIMIT',
      reason: 'A daily limit is the most this card will spend in one day. It starts again by itself each day.\n\n'
        + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.\n\n'
        + 'If you lose the seed phrase for this Foxy app, the PIN and the limit on this card can never be changed.\n\n'
        + 'Do you wish to continue?',
      retry: 'CONTINUE', go: () => this.fcAmount('cardLimit'),
      shut: { label: 'CANCEL', tap: () => { this._fcLimitDone = null; } },
    });
  }

  /* What the keypad asks, for whichever limit is being set (23-render-home-and-amount.js). */
  fcLimitQuestion() {
    if (this._fcLimitNoPin) return 'What is the most this card should pay in a day without its PIN?';
    return this._fcLimitTap ? 'What is the most this card should pay in one tap straight away?' : 'What would you like the daily limit to be?';
  }

  /* After NEXT on the keypad, or NO LIMIT under it: the confirmation, over it. */
  fcLimitConfirm(sats, usd) {
    this.setState(p => ({ screen: 'fcLimitConfirm', stack: p.stack.concat([p.screen]),
                          fcLimit: { sats: Math.max(0, Math.round(Number(sats) || 0)), usd: Math.max(0, Number(usd) || 0) } }));
  }

  /* The confirmation shell's contents (confirmSpec). */
  fcLimitSpec() {
    const sats = ((this.state.fcLimit || {}).sats) || 0;
    const secondary = { label: 'CANCEL', go: () => this.fcLimitCancel() };
    if (this._fcLimitNoPin) {
      return !(sats > 0) ? {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE REMOVING THIS CARD\u2019S NO PIN LIMIT.',
        amount: 'NO LIMIT', amountSub: '', rows: [],
        warn: 'Every payment will ask for the PIN.',
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      } : {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE APPLYING A NO PIN LIMIT OF:',
        amount: this.money(sats).main, amountSub: this.money(sats).sub, rows: [],
        warn: 'This card will pay up to this much a day without its PIN. Over it, the PIN is asked for the whole payment. '
          + (((this.state.fcLimit || {}).usd > 0) ? 'It is kept at this many dollars: this phone sets the card again when the price has moved. ' : '')
          + 'Only this phone, or a phone restored from its seed phrase, can change or remove it.',
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      };
    }
    if (this._fcLimitTap) {
      return !(sats > 0) ? {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE REMOVING THIS CARD\u2019S PER TAP LIMIT.',
        amount: 'NO LIMIT', amountSub: '', rows: [],
        warn: 'One tap will be able to pay as much as the card holds straight away' + (((this.state.fc || {}).limit || 0) > 0 ? ', up to its daily limit.' : '.'),
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      } : {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE APPLYING A PER TAP LIMIT OF:',
        amount: this.money(sats).main, amountSub: this.money(sats).sub, rows: [],
        warn: (this.fcShaped()
          ? 'This card will pay up to this straight away, change or no change. Over it, the card has to be held about 5 seconds, and 2 seconds more for every limit\u2019s worth beyond that. '
          : 'This card will pay up to this straight away when it pays exactly. With change, or over the limit, it has to be held 3 seconds for every limit\u2019s worth. ')
          + (((this.state.fcLimit || {}).usd > 0) ? 'It is kept at this many dollars: this phone sets the card again when the price has moved. ' : '')
          + (this.fcAbove(this._fcCard, sats) > 0 ? 'It holds ' + this.fcPrice(this.fcAbove(this._fcCard, sats)) + ' in pieces larger than that: with your PIN they are recut under the new limit in the same tap. ' : '')
          + 'Only this phone, or a phone restored from its seed phrase, can change or remove it.',
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      };
    }
    if (!(sats > 0)) {
      return {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE REMOVING THIS CARD’S DAILY LIMIT.',
        amount: 'NO LIMIT', amountSub: '', rows: [],
        warn: 'It will be able to spend everything on it.',
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      };
    }
    return {
      title: 'CONFIRMATION', amountLabel: 'YOU ARE APPLYING A DAILY LIMIT OF:',
      amount: this.money(sats).main, amountSub: this.money(sats).sub, rows: [],
      /* The two sentences go under the amount, in this order. They are set as
       * `warn` because the shell's subtitle sits above the amount, and would read first. */
      warn: 'This card will spend no more than this in one day. The limit starts again by itself each day. '
        + 'Only this phone, or a phone restored from its seed phrase, can change or remove it.',
      secondary, cta: 'CONFIRM', ctaTone: 'go',
      go: () => this.fcLimitConfirmed(),
    };
  }

  /* Off the confirmation and the keypad under it, to where the flow began. */
  fcLimitLeave() {
    this.setState(p => {
      const at = p.screen === 'fcLimitConfirm' ? 2 : p.screen === 'amount' ? 1 : 0;
      const back = p.stack.length >= at ? p.stack[p.stack.length - at] : 'flashcard';
      return at ? { screen: back, stack: p.stack.slice(0, -at), fcLimit: null, flow: 'receive', amount: '', unit: 'USD' } : { fcLimit: null };
    });
  }

  fcLimitCancel() {
    this._fcLimitDone = null;
    this.fcLimitLeave();
  }

  fcLimitConfirmed() {
    const sats = ((this.state.fcLimit || {}).sats) || 0;
    const usd = ((this.state.fcLimit || {}).usd) || 0;
    const done = this._fcLimitDone;
    this._fcLimitDone = null;
    this.fcLimitLeave();
    /* A limit on one tap, lower than pieces the card holds: with the PIN the
     * card's money is recut under it in the same tap (the wallet's
     * cardSetLimit), so the PIN is asked first. Zero is a choice: NO LIMIT. */
    if (done && this._fcLimitTap && sats > 0 && this.fcAbove(this._fcCard, sats) > 0) {
      this.fcPinOr({ title: 'CARD PIN', subtitle: 'To recut its money under the new limit' }, (pin) => done(sats, usd, pin));
      return;
    }
    if (done) done(sats, usd);
  }

  /* What a card holds in pieces larger than `limit`: the pieces a till holds
   * longer for. Only a card cut deep is cut to a limit; 0 for any other. */
  fcAbove(card, limit) {
    if (!card || !card.info || !card.info.wide || !card.info.many || !(limit > 0)) return 0;
    return (card.pieces || []).reduce((n, x) => (Number(x.amount) > limit ? n + Number(x.amount) : n), 0);
  }

  /* ---- the card's own log -----------------------------------------------------
   *
   * Kept by the card and written by nothing else: every tap in which it signed
   * for anything, or refused to because a limit was reached (08a-flashcard.js,
   * `cardLogOf`). The card cannot know a price, so it cannot say a payment was
   * too much; it says what it signed for and when, and the person judges. What
   * it can say by itself is that a terminal asked for more than its limit
   * three times or more inside ten seconds, which a terminal that keeps to the
   * limits never does once: that tap is marked. */
  fcLogCard() {
    const fc = this.state.fc || {};
    const log = fc.log;
    if (!log || !log.last) return;
    /* A card of software 1.15 and on cannot be told a false time: its clock is block headers, which no one can make for a time
     * that has not come, so nothing here speaks of one (`fc.headers`). A mark the card counted that this phone cannot find in
     * its eight taps is, for such a card, a run of refusals that has left the ring. */
    const blocks = !!fc.headers;
    const refusals = log.last.some((x) => x.tamper) || (blocks && !!log.since && log.since.tampers > 0);
    const counted = !blocks && !log.last.some((x) => x.tamper) && !!log.since && log.since.tampers > 0;
    const clock = !blocks && (log.last.some((x) => x.clock) || fc.clockAhead > 0 || counted);
    const marked = refusals || clock;
    const n = (count, one, many) => count + ' ' + (count === 1 ? one : many);
    /* When a tap was. A card of 1.15 and on writes the time its terminal told it beside the time in the newest block header it
     * had: the phone's own, to the second, with the block's beside it. A card before it has the one time, its own clock. */
    const when = (x) => {
      if (!blocks) return this.fcWhen(x.time);
      const block = x.time > 0 ? 'block ' + this.fcWhen(x.time) : 'no block yet';
      return x.told > 0 ? this.fcWhen(x.told) + ' (' + block + ')' : block;
    };
    // in dollars, at the price now: the card keeps sats and knows no price
    const line = (x) => {
      const said = [];
      const put = x.loaded > 0 || x.loads > 0;
      // what it signed for (which is the pieces, and may be more than the price), unless the tap only put money on
      if (x.sats > 0 || x.pieces > 0 || !put) said.push(this.fcPrice(x.sats) + (x.pieces ? ', ' + n(x.pieces, 'piece', 'pieces') : ''));
      if (put) said.push(this.fcPrice(x.loaded) + ' put on');
      if (x.noPin) said.push('no PIN');
      if (x.waited) said.push('over the per tap limit');
      if (x.refused) said.push(x.refused + ' refused');
      return when(x) + ': ' + said.join(', ')
        + (x.tamper ? ' — TAMPER' : '') + (x.clock ? ' — TOLD A FALSE TIME' : '');
    };
    const since = (log.since && (log.since.taps > 0 || log.since.refused > 0))
      ? 'Since this phone last looked: ' + n(log.since.taps, 'tap', 'taps') + ', ' + this.fcPrice(log.since.sats) + ' signed for'
        + (log.since.refused > 0 ? ', ' + log.since.refused + ' refused' : '') + '.\n\n'
      : '';
    const ahead = fc.clockAhead > 0
      ? 'This card’s clock is ' + this.fcSpan(fc.clockAhead) + ' ahead of this phone’s: it has been told a time that had not come. Its daily limit cannot be relied on.\n\n'
      : '';
    const receipts = fc.receipts && fc.receipts.count > 0
      ? '\n\nReceipts kept on this phone: ' + fc.receipts.list.length + ' of ' + n(fc.receipts.count, 'payment', 'payments')
        + '. Each names the swap its money went into, which can be matched to the wallet that took it.'
      : '';
    this.blockedCard('fc-log', Object.assign({
      long: true,
      tone: marked ? 'warn' : 'ask', title: marked ? 'TAMPER ON THIS CARD' : 'THIS CARD’S OWN LOG',
      reason: (refusals ? 'A terminal asked this card for more than its limit allows, three times or more ' + (blocks ? 'before its clock moved on' : 'within ten seconds') + '. The card refused each time and wrote it down.\n\n' : '')
        + ((!blocks && (log.last.some((x) => x.clock) || counted)) ? 'A terminal told this card the time twice in one tap, more than two minutes apart. No phone’s clock does that: it is how a daily limit is got round.\n\n' : '')
        + (blocks ? 'This card keeps its time by Bitcoin blocks, which no terminal can set. Each tap is shown at the time the phone that tapped it told the card, with the block the card had beside it.\n\n' : '')
        + ahead
        + 'Kept by the card itself. No phone or terminal can change it.\n\n' + since
        + log.last.map(line).join('\n')
        + '\n\nIn all: ' + n(log.taps, 'tap', 'taps') + ', ' + this.fcPrice(log.sats) + ' signed for, ' + log.refused + ' refused.'
        + (((this.px && this.px()) || 0) > 0 ? '\n\nIn dollars at the price now.' : '')
        + receipts,
      shut: { label: 'CLOSE' },
    }, receipts ? { retry: 'COPY RECEIPTS', go: () => this.fcCopyReceipts() } : {}));
  }

  /* A length of time in words, for how far a clock is out. */
  fcSpan(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 5400) return Math.max(1, Math.round(s / 60)) + ' minutes';
    if (s < 172800) return Math.round(s / 3600) + ' hours';
    return Math.round(s / 86400) + ' days';
  }

  /* The card's receipts as text, for whoever has to be shown them: the card,
   * and for each payment its number, when (the card's clock, in UTC), what
   * the pieces were worth in sats, the hash of what the card signed, and the
   * first output of the swap it went into. */
  fcCopyReceipts() {
    const fc = this.state.fc || {};
    const W = this.fcW();
    const list = (W && W.cardReceipts) ? W.cardReceipts(fc.key) : [];
    if (!list.length) { this.toast('No receipts to copy.', true); return; }
    const iso = (secs) => new Date(secs * 1000).toISOString().replace('.000Z', 'Z');
    /* A card of software 1.15 and on writes two times in a receipt: the one its terminal told it (the phone's own clock, a note the
     * card trusts for nothing) and the time in the newest block header the card had (its own clock). A card before it has the one, which
     * was told it under a signature: it goes in the first column, and the second has none. */
    const blocks = list.some((r) => r.told !== undefined);
    const text = (blocks
      ? ['Foxy card receipts', 'card ' + fc.key, 'payment, time (UTC, as the phone that tapped it told the card), block time (UTC, the card’s clock), sats, sha256 of the message signed, first output (B_)']
        .concat(list.map((r) => '#' + r.n + ', ' + (r.told !== undefined ? (r.told > 0 ? iso(r.told) : '-') : iso(r.time)) + ', '
          + (r.told !== undefined ? (r.time > 0 ? 'block ' + iso(r.time) : '-') : '-') + ', ' + r.sats + ', ' + r.hash + ', ' + r.out))
      : ['Foxy card receipts', 'card ' + fc.key, 'payment, time (UTC, by the card’s clock), sats, sha256 of the message signed, first output (B_)']
        .concat(list.map((r) => '#' + r.n + ', ' + iso(r.time) + ', ' + r.sats + ', ' + r.hash + ', ' + r.out)))
      .join('\n');
    const copied = this.copySecret ? this.copySecret(text) : false;
    this.toast(copied ? 'Receipts copied.' : 'Could not copy the receipts.', !copied);
  }

  /* CHANGE LIMIT. */
  fcSetLimit() {
    const fc = this.state.fc;
    if (!fc) return;
    // said before anything is asked: a card with no owner has nobody to set its limit, and another phone's card is not this one's to
    if (!fc.owner) { this.fcFailed({ card: 'no-owner', message: 'This card has no owner, so its limit cannot be changed.' }); return; }
    if (fc.ownedHere === false) { this.fcFailed({ card: 'not-owner' }); return; }
    /* Which of the two. A card whose software has no limit on one tap (an
     * older one) has the one limit, and is asked for it as it always was. */
    if (!(fc.tap && fc.tap.known)) { this.fcLimitAsk((sats) => this.fcLimitRun(sats)); return; }
    // the question and the two, each a button: what each limit is comes on its own screen
    // and a third for a card that has a PIN and a software that has the no PIN limit (1.16 and on)
    const np = !!(fc.pinSet && fc.noPinKnown && fc.pin !== 'blocked');
    this.blockedCard('fc-limit-which', Object.assign({
      tone: 'ask', title: 'CHANGE CARD LIMITS',
      reason: 'Which limit would you like to add or change?',
      retry: 'PER TAP LIMIT', go: () => this.fcLimitAsk((sats, usd, pin) => this.fcLimitRun(sats, true, usd, pin), true),
      shut: { label: 'DAILY LIMIT', pill: true, tap: () => this.fcLimitAsk((sats) => this.fcLimitRun(sats)) },
      also: { label: 'CANCEL' },
    }, np ? { pills: [{ label: 'NO PIN LIMIT', tap: () => this.fcLimitAsk((sats, usd) => this.fcLimitRun(sats, 'nopin', usd), 'nopin') }] } : {}));
  }

  /* One tap that sets the limit with this phone's proof that it is the owner. No PIN is asked, unless the card holds
   * pieces larger than a new limit on one tap (`pin`): then its money is recut under the limit in the same tap. */
  fcLimitRun(sats, tap, usd, pin) {
    const W = this.fcW();
    // 'nopin': the no PIN limit (software 1.16 and on), whose dollars are kept like the limit on one tap's
    const np = tap === 'nopin';
    this.fcTap({}, (link, on, progress) => {
      on('writing');
      return W.cardSetLimit(link, np ? { sats, noPin: true, usd, on, progress } : { sats, tap: !!tap, usd: tap ? usd : 0, pin, on, progress });
    })
      .then((card) => {
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.toast((np ? 'No PIN limit ' : tap ? 'Per tap limit ' : 'Daily limit ') + (sats > 0 ? 'set.' : 'removed.') + (card && card.recut ? ' The card\u2019s money is recut under it.' : ''));
      }, (e) => this.fcFailed(e, { again: () => this.fcLimitRun(sats, tap, usd, pin) }));
  }

  /* ---- its mint -------------------------------------------------------------
   *
   * SWITCH MINT moves the card, and its money with it, to another mint:
   *
   *   which mint            the app's own list of mints, asked "TO WHICH MINT?"
   *   what it costs         the confirmation screen every move has: what
   *                         moves, about what arrives, the most the fee can be
   *   the PIN, and a tap    everything comes off the card into this phone
   *   the crossing          by Lightning, with no card: it takes longer than
   *                         a card can be held, and the phone's own card sheet
   *                         gives up after a minute
   *   a second tap          the card is told its new mint, and the money is
   *                         written onto it
   *
   * The money pays for its own crossing (`cardMoveQuote`): this phone's own
   * balance is not dipped into, and what stays behind is the part of the
   * Lightning fee's reserve that was not used, in this phone at the old mint.
   * Cut short anywhere, the money is in this phone and the card is empty and
   * still good. A card with nothing on it needs none of this: one tap.
   *
   * The phone is taken to the other mint for as long as this lasts and put
   * back when it ends, however it ends (`fcMoveEnd`). */
  fcSwitchMint() {
    const fc = this.state.fc;
    const W = this.fcW();
    if (!fc || !this._fcCard || !W) return;
    if (this.offlineNow()) { this.offlineNo('Moving a card to another mint'); return; }
    // a move connects to another mint, and waits like every switch for money that is already moving
    if (this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return;
    if (this.fcOwed().some(r => r.key === fc.key)) {
      this.blockedCard('fc-owed-first', {
        tone: 'warn', title: 'PUT IT ON FIRST',
        reason: 'Money is waiting to go onto this card. Put it on, then move the card.',
        retry: 'TAP CARD', go: () => this.fcWriteAsk({}), shut: { label: 'CANCEL' },
      });
      return;
    }
    /* Whichever mint this phone is at. The money comes off the card at the
     * card's own mint, and this phone is taken there for as long as the move
     * lasts (`fcMoveQuote`) and put back after (`fcMoveEnd`). It was refused
     * from any other mint with a card whose button opened this phone's own
     * list of mints: a person at the mint they wanted the card moved to was
     * sent to switch away from it, and round again. */
    // through the one way into that list, which clears every other question it can be asking
    this.goSwitchMint({ fcPick: true });
  }

  /* A mint tapped on that list. */
  fcSwitchPick(url) {
    const fc = this.state.fc;
    const W = this.fcW();
    const to = String(url || '').replace(/\/+$/, '');
    if (!this.state.fcPick) return;
    if (!fc || !W || !to) { this.setState({ fcPick: false }); this.back(); return; }
    this._fcMoveWas = String(W.mintUrl || '').replace(/\/+$/, '');
    if (!(fc.balance > 0)) {
      // nothing to move: off the list, and the card is told its new mint in one tap, with this phone's proof that it owns it
      this.setState(p => ({ fcPick: false, screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1) }));
      this.fcRepointRun(to);
      return;
    }
    // the confirmation takes the list's place: back from it is the card's own screen
    this.setState({
      fcPick: false, screen: 'fcMoveConfirm',
      fcMove: { from: String(fc.mint || '').replace(/\/+$/, ''), to, sats: fc.balance, plan: null, fee: null, lands: 0, err: '', busy: false },
    });
    this.fcMoveQuote();
  }

  fcRepointRun(to) {
    const W = this.fcW();
    const end = () => this.fcMoveEnd();
    Promise.resolve()
      .then(() => (String(W.mintUrl || '').replace(/\/+$/, '') === to ? null : W.connect(to, null, null, { remember: false })))
      .then(() => this.fcTap({}, (link, on) => { on('writing'); return W.cardRepoint(link); }))
      .then((card) => {
        this.fcShow(card);
        end();
        this.haptic && this.haptic('success');
        this.blockedCard('fc-moved', { tone: 'ask', title: 'MOVED', reason: 'This card is now at ' + this.mintNameOf(to) + '.', shut: { label: 'DONE' } });
      }, (e) => { end(); this.fcFailed(e, { again: () => this.fcSwitchMint() }); });
  }

  /* About what it will cost, asked of both mints before the card is touched.
   * Nothing is spent by asking. */
  fcMoveQuote() {
    const W = this.fcW();
    const m = this.state.fcMove;
    if (!W || !m) return;
    const put = (more) => { if (this.state.fcMove) this.setState({ fcMove: Object.assign({}, this.state.fcMove, more) }); };
    put({ quoting: true, err: '' });
    // to the card's mint first, where this phone is not there already: a visit, not a change of this phone's own mint
    const bare = (u) => String(u || '').replace(/\/+$/, '');
    this._fcVisit = Promise.resolve()
      .then(() => (bare(W.mintUrl) === bare(m.from) ? null : W.connect(m.from, null, null, { remember: false })));
    this._fcVisit.then(() => W.cardMoveQuote(m.from, m.to, m.sats, { quoteOnly: true, pieces: (this.state.fc || {}).count })).then((plan) => {
      // what leaves the card, less what lands, is the most the crossing can cost
      put({ quoting: false, plan, lands: plan.net, fee: Math.max(0, m.sats - plan.net) });
    }, (e) => {
      put({ quoting: false, plan: null, fee: null, err: (e && e.card === 'too-little') ? String(e.message) : W.reason(e) });
    });
  }

  /* The confirmation screen's contents (confirmSpec), in the transfer's own shape. */
  fcMoveSpec() {
    const m = this.state.fcMove || { sats: 0 };
    const rows = [
      this.cfRow('MOVING TO', (this.mintNameOf(m.to) || '').toUpperCase()),
      this.cfRow('FROM', (this.mintNameOf(m.from) || '').toUpperCase(), { half: true }),
      this.cfRow('NETWORK', 'LIGHTNING', { half: true }),
      this.cfRow('ARRIVES ON THE CARD', m.err ? 'UNKNOWN' : m.fee == null ? 'CHECKING\u2026' : 'ABOUT ' + this.money(m.lands).main, { ink: 'var(--acc)', half: true }),
      this.cfRow('FEE', m.err ? 'UNKNOWN' : m.fee == null ? 'CHECKING\u2026' : 'UP TO ' + this.money(m.fee).main, { half: true }),
    ];
    const cancel = { label: 'CANCEL', go: () => this.fcMoveCancel() };
    if (m.err) {
      return {
        title: 'CONFIRMATION', amountLabel: 'MOVING THIS CARD',
        amount: this.money(m.sats).main, amountSub: this.money(m.sats).sub, amountInk: '#FF5C5C', rows,
        warn: m.err, cta: 'TRY AGAIN', ctaTone: 'warn', go: () => this.fcMoveQuote(), secondary: cancel,
      };
    }
    return {
      title: 'CONFIRMATION', amountLabel: 'MOVING THIS CARD',
      amount: this.money(m.sats).main, amountSub: this.money(m.sats).sub, rows,
      subtitle: m.fee == null ? '' : 'The card is tapped twice: once to take the money off, once to put it back.',
      secondary: cancel,
      cta: m.busy ? 'MOVING\u2026' : m.fee == null ? 'CHECKING THE FEE\u2026' : 'MOVE ' + this.money(m.sats).main,
      ctaTone: 'go', ctaBusy: !!m.busy || m.fee == null,
      go: () => { if (m.fee != null && !m.busy) this.fcMoveGo(); },
    };
  }

  /* CANCEL on the confirmation: nothing has moved, and the phone goes back to the mint it was at. */
  fcMoveCancel() {
    this.fcMoveEnd(null);
  }

  fcMoveGo() {
    const m = this.state.fcMove;
    if (!m || m.fee == null || m.busy) return;
    if (this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return;
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: 'To move ' + this.fcBoth(m.sats) + ' to ' + this.mintNameOf(m.to) + '.',
      cta: 'MOVE ' + this.fcPrice(m.sats),
    }, (pin) => this.fcMoveOff(pin));
  }

  /* The first tap: everything off the card, into this phone. */
  fcMoveOff(pin) {
    const W = this.fcW();
    const m = this.state.fcMove;
    if (!m) return;
    const busy = (on) => { if (this.state.fcMove) this.setState({ fcMove: Object.assign({}, this.state.fcMove, { busy: on }) }); };
    busy(true);
    /* One thing was asked for, and it writes four entries: off the card, out
     * of one mint, into the other, onto the card. None is a payment to
     * announce. Quiet from here, as a crossing made for a tap is
     * (26d-tap.js), and every entry it wrote is marked seen when it ends
     * (`fcMoveEnd`): the crossing asks for its quote again when it pays, so
     * the entries cannot be named in advance. */
    this._quiet = true;
    this._fcQuiet = true;
    W.transactions(50).then((list) => { this._sweepBefore = new Set(list.map(x => x.hash)); },
                            () => { this._sweepBefore = null; });
    this.fcTap({ amount: this.stageMoney(m.sats), body: 'The first of two taps: the money comes off the card.', warm: true },
      (link, on) => W.cardWithdraw(link, { pin, on, hold: true }))
      .then((r) => {
        if (r && r.hash) this.txIsNew(r.hash);
        this.fcMoveAcross(r);
      }, (e) => { busy(false); this.fcLoud(); this.fcFailed(e, { taken: true, again: () => this.fcMoveGo() }); });
  }

  /* The quiet a move began is ended, with what it wrote marked as seen. */
  fcLoud() {
    if (!this._fcQuiet) return;
    this._fcQuiet = false;
    const loud = () => { this._quiet = false; };
    (this.hushSweepEntries ? this.hushSweepEntries() : Promise.resolve()).then(loud, loud);
  }

  /* The crossing, with no card: a plan the money itself pays for, the move,
   * and what landed made into pieces for the card at the far mint. */
  fcMoveAcross(off) {
    const W = this.fcW();
    const m = this.state.fcMove;
    const to = this.mintNameOf(m.to);
    const card = off.card || this._fcCard;
    let crossed = false;
    this.showMelt('Moving your sats to ' + to + '\u2026', 0, { sats: off.sats, mint: to });
    W.cardMoveQuote(m.from, m.to, off.sats).then((plan) => {
      /* More than was agreed to, by more than a sat or two of rounding: asked
       * again, with the money safe in this phone meanwhile. */
      const fee = Math.max(0, off.sats - plan.net);
      if (fee > m.fee + 2) { const e = /** @type {any} */ (new Error('fee')); e.fcFee = fee; throw e; }
      if (this.hushMove) this.hushMove(plan);
      return W.moveRun(plan, () => {}, { visit: true });
    }).then((done) => {
      crossed = true;
      return W.cardMoveLoad(card, done.sats);
    }).then((made) => {
      if (made && made.hash) this.txIsNew(made.hash);
      this.hideMelt();
      this.fcMoveOn(made);
    }, (e) => {
      this.hideMelt();
      /* Not moved, or moved and too little to put on a card. Either way the
       * money is this phone's, at a mint it can be seen at, and the card is
       * empty. Said with where it is. */
      const where = this.mintNameOf(crossed ? m.to : m.from);
      this.fcMoveEnd(off.card);
      this.blockedCard('fc-move-failed', {
        tone: 'warn', title: crossed ? 'NOT PUT ON THE CARD' : 'NOT MOVED',
        reason: (e && e.fcFee) ? 'The fee is now up to ' + this.fcSats(e.fcFee) + ', more than was shown.'
          : (e && e.card) ? String(e.message) : W.reason(e),
        chip: 'The money is in this phone, at ' + where + '. The card is empty.',
      });
    });
  }

  /* The second tap: the card is told its new mint, and the money goes on, both
   * with this phone's proof that it owns the card: no PIN is asked again. */
  fcMoveOn(made) {
    const W = this.fcW();
    const m = this.state.fcMove;
    const to = this.mintNameOf(m.to);
    this.fcTap({ amount: this.stageMoney(made.sats), body: 'The second tap: the money goes back on, at ' + to + '.' },
      (link, on) => { on('writing'); return W.cardWrite(link, { owner: true }); })
      .then((r) => {
        this.fcMoveEnd(r.card);
        if (r.left > 0 || !(r.sats > 0)) { this.fcWrote(r, {}); return; }
        this.haptic && this.haptic('success');
        this.blockedCard('fc-moved', {
          tone: 'ask', title: 'MOVED',
          reason: 'This card is now at ' + to + ' and holds ' + this.fcBoth(r.card.balance) + '.',
          shut: { label: 'DONE' },
        });
      }, (e) => {
        /* The money is at the new mint, made for this card and waiting for
         * it. Tapped again now, or later from the line on the card's screen. */
        if (e && (e.card === 'cancelled' || e.card === 'gone')) {
          this.blockedCard('fc-move-tap', {
            tone: 'warn', title: 'TAP THE CARD AGAIN',
            reason: this.fcBoth(made.sats) + ' is at ' + to + ', waiting to go onto this card.',
            retry: 'TAP CARD', go: () => this.fcMoveOn(made),
            shut: { label: 'LATER', tap: () => this.fcMoveEnd(null) },
          });
          return;
        }
        this.fcMoveEnd(null);
        this.fcFailed(e, {});
      });
  }

  /* The end of a move, however it went: the confirmation gives way to the
   * card's screen (showing `card` where there is one to show), and the phone
   * goes back to the mint it was at. */
  fcMoveEnd(card) {
    const W = this.fcW();
    const was = this._fcMoveWas;
    this._fcMoveWas = '';
    if (this.state.screen === 'fcMoveConfirm') {
      this.setState(p => ({ fcMove: null, screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1) }));
    } else if (this.state.fcMove) {
      this.setState({ fcMove: null });
    }
    if (card) this.fcShow(card);
    this.fcLoud();
    const home = () => { this.refreshBalance(); this.loadHistory(); };
    // after a visit that is still being made (CANCEL pressed while it was): put back from where that leaves it
    const visit = this._fcVisit || Promise.resolve();
    this._fcVisit = null;
    const put = () => {
      if (W && was && String(W.mintUrl || '').replace(/\/+$/, '') !== was) W.connect(was).then(home, home);
      else home();
    };
    visit.then(put, put);
  }

  /* Everything off the card and on again, which is the only way its pieces
   * get a new date: the date is part of each piece. */
  fcRenew() {
    if (!this.fcReady('Renewing a card')) return;
    const W = this.fcW();
    const fc = this.state.fc;
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: 'To renew ' + this.fcBoth(fc.balance) + ' for another year.',
      cta: 'RENEW',
    }, (pin) => this.fcTap({ amount: this.stageMoney(fc.balance), body: 'This takes longer than a payment. Keep the card there.', warm: true },
      (link, on, progress) => W.cardRenew(link, { pin, on, progress }))
      .then((r) => {
        (r.hashes || []).forEach(h => this.txIsNew(h));
        this.fcWrote(r, {});
      }, (e) => {
        ((e && e.hashes) || []).forEach(h => this.txIsNew(h));
        this.refreshBalance();
        this.loadHistory();
        this.fcFailed(e, { again: () => this.fcRenew() });
      }));
  }

  /* ---- a lost card ---------------------------------------------------------- */
  fcRowCard(row) {
    const name = this.fcName(row.key);
    if (row.takenBack) {
      this.blockedCard('fc-row', { tone: 'ask', title: name, reason: 'Its money was taken back to this phone.' });
      return;
    }
    if (!row.due) {
      this.blockedCard('fc-row', {
        tone: 'ask', title: name,
        reason: (row.sats ? this.fcSats(row.sats) + ' when this phone last saw it. ' : 'Empty when this phone last saw it. ')
          + (row.date ? 'If it is lost or blocked, this phone can take its money back after ' + this.fcDay(row.date) + '.' : ''),
      });
      return;
    }
    this.blockedCard('fc-row', {
      tone: 'warn', title: 'TAKE IT BACK?',
      reason: this.fcSats(row.sats) + ' was on ' + name + ' when this phone last saw it. '
        + 'Use this only if the card is lost or blocked.',
      chip: 'The card will be empty.',
      retry: 'TAKE IT BACK', go: () => this.fcTakeBack(row.key),
      shut: { label: 'CANCEL' },
    });
  }

  fcTakeBack(key) {
    const W = this.fcW();
    if (this.offlineNow()) { this.offlineNo('Taking a card back'); return; }
    this.stageScreen('cardBack', { art: 'card', title: 'TAKING<br>IT BACK', body: 'Asking the mint what is left on it.',
                                   dots: true, forMs: 90000, button: 'CLOSE' });
    W.cardTakeBack(key).then((r) => {
      this.hideStage('cardBack');
      if (r && r.hash) this.txIsNew(r.hash);
      this.refreshBalance();
      this.loadHistory();
      this.forceUpdate();
      if (!(r.sats > 0)) {
        this.blockedCard('fc-back', { tone: 'warn', title: 'NOTHING WAS LEFT ON IT', reason: 'Everything this phone put on that card has been spent.' });
        return;
      }
      this.haptic && this.haptic('success');
      this.blockedCard('fc-back', {
        tone: 'ask', title: 'BACK IN YOUR WALLET',
        reason: this.fcSats(r.sats) + ' from the card is in this phone now.'
          + (r.later > 0 ? ' ' + this.fcSats(r.later) + ' more can be taken back later.' : ''),
        shut: { label: 'DONE' },
      });
    }, (e) => {
      this.hideStage('cardBack');
      if ((e && e.card) === 'other-mint') {
        this.blockedCard('fc-other-mint', { tone: 'warn', title: 'A DIFFERENT MINT', reason: String(e.message || ''),
          retry: 'SWITCH MINT', go: () => this.goSwitchMint(), shut: { label: 'CANCEL' } });
        return;
      }
      this.fcFailed(e, { again: () => this.fcTakeBack(key) });
    });
  }

  /* The designs a card's face can be drawn in, each by a code of three
   * characters (capital letters and digits).
   *
   * A card maker takes a code nobody has taken and adds its drawing; the
   * codes taken are listed here and in docs/CARD-DESIGNS.md of the card
   * repository (https://github.com/getfoxy/card), so that anybody can see which are. FL1 is the first
   * Flash design, and the one design drawn so far (build/markup.html, the
   * card on the FLASHCARD screen). A card does not yet say which design it
   * is, so a card is drawn as the design this phone wrote down for it when it
   * set it up (FC_SETUP_DESIGN), and FC_DESIGN where it wrote none. */
  FC_DESIGNS = {
    FL1: { name: 'Flash, first design', by: 'Flash' },
    FX1: { name: 'Foxy, first design', by: 'Foxy' },
  };
  FC_DESIGN = 'FL1';
  /* The design this phone gives the cards it sets up, written on its own file
   * for each (the card itself does not yet carry one): a card of this phone's
   * is drawn as Foxy's, and a card read at it as a till as Flash's. */
  FC_SETUP_DESIGN = 'FX1';

  /* The design to draw a card in: the one it names, where it names one this
   * build can draw, and FC_DESIGN otherwise. */
  fcDesignOf(card) {
    const code = String((card && card.design) || '').toUpperCase();
    return (/^[A-Z0-9]{3}$/.test(code) && this.FC_DESIGNS[code]) ? code : this.FC_DESIGN;
  }

  /* What has been done with this card, as this phone knows it: the history
   * screen, with only the entries that name it. A card keeps no list of its
   * own, so a payment it made at somebody else's phone is not here. */
  fcHistory() {
    const fc = this.state.fc;
    if (!fc || !fc.key) return;
    this.setState(p => ({ screen: 'history', stack: p.stack.concat([p.screen]), histCard: fc.key, histFilter: 'all' }));
    this.loadHistory();
  }

  /* flashcard: the card that was tapped, or the invitation to tap one. */
  /** @param {RenderContext} c */
  renderFlashcard(c) {
    const { s, sc } = c;
    const on = sc === 'flashcard';
    const W = on ? this.fcW() : null;
    const fc = (on && s.fc) || null;
    const now = Math.floor(Date.now() / 1000);
    const DIM = 'rgba(var(--ink-rgb),.55)';
    const AMBER = '#F7931A';
    const RED = '#FF5C5C';

    /* What this phone owes cards, first and in the warning colour: it is the
     * one thing on this screen that is waiting on the person. */
    const notes = !on ? [] : this.fcOwed().map(r => ({
      // the card on screen is "this card"; any other is named, since its name is shown nowhere else
      text: this.fcSats(r.sats) + ' is waiting to go onto '
        + ((fc && fc.key === r.key) ? 'this card. Press here, then tap it.' : this.fcName(r.key) + '. Press here, then tap that card.'),
      tap: () => this.fcWriteAsk({}),
    }));

    /* The card's own log, which only the card writes, is on this screen only
     * when the card has something to accuse: a tap it marked (a terminal
     * asked for more than its limit, three times or more inside ten seconds)
     * or a false time it was told. What else the card did is in this phone's
     * history, which has it already; the log itself opens from the mark. */
    const log = fc && fc.log;
    if (on && log && log.last && log.last.length) {
      const marked = log.last.filter((x) => x.tamper);
      const tried = marked.reduce((n, x) => n + (Number(x.refused) || 0), 0);
      // a false time: the card saw it (told twice in a tap, far apart), or this phone does (the card's clock is ahead of its own)
      // (a mark made in a tap that signed for nothing is in the card's count of marked things and in no entry: new since this phone last looked)
      // A card of software 1.15 and on cannot be told a false time (its clock is block headers): the same mark, with no tap to show it, is a run of refusals.
      const blocks = !!fc.headers;
      const lost = !marked.length && !!log.since && log.since.tampers > 0;
      const falseTime = !blocks && (log.last.some((x) => x.clock) || fc.clockAhead > 0 || lost);
      if (marked.length || falseTime || (blocks && lost)) {
        notes.push({
          text: marked.length
            ? 'TAMPER: a terminal tried ' + tried + ' times to take more than this card\u2019s limit. Press here.'
            : falseTime ? 'TAMPER: this card has been told a false time. Press here.'
            : 'TAMPER: a terminal tried to take more than this card\u2019s limit, again and again. Press here.',
          tap: () => this.fcLogCard(),
        });
      }
    }

    const rows = (!W || fc || !this.FC_RECOVERABLE) ? [] : W.cardsList().map(r => ({
      name: this.fcName(r.key),
      sub: r.takenBack ? 'Taken back'
        : r.sats ? this.fcSats(r.sats) + ' when last seen' : 'Empty when last seen',
      // only what can be done; the date it waits for is said when the row is opened
      text: (!r.takenBack && r.due && r.sats > 0) ? 'TAKE BACK' : '',
      ink: (r.due && r.sats > 0 && !r.takenBack) ? 'var(--acc-ink)' : DIM,
      tap: () => this.fcRowCard(r),
    }));

    // (software 1.16 and on can be set up without a PIN: `setUp` is a record, and before 1.16 a PIN as well)
    const fresh = !!fc && !fc.setUp && fc.pin !== 'blocked';
    const blocked = !!fc && fc.pin === 'blocked';
    // the owner's phone is offered UNBLOCK on a blocked card, which is CHANGE PIN
    const unblock = blocked && !!fc.ownedHere;
    // the card's day: the daily limit, what is left today, and when the day turns
    const day = (fc && fc.hasRecord && fc.day) || null;
    const limited = !!(day && day.limited);
    const tapped = !!(fc && fc.tap && fc.tap.limited);
    const usable = !!fc && !!fc.setUp && fc.pin !== 'blocked';
    // a card that has no PIN is offered ADD PIN where a card that has one is offered CHANGE PIN
    const addable = !!fc && !!fc.setUp && !fc.pinSet && !!fc.noPinKnown;
    // what a card with a PIN pays without it in a day: the no PIN limit and what is left of it today
    const noPin = (fc && fc.setUp && fc.pinSet && fc.noPin && fc.noPin.known && fc.noPin.set) ? fc.noPin : null;
    const near = !!fc && fc.mine && fc.first > 0 && fc.first - now < this.FC_RENEW_DAYS * 86400;
    const past = near && fc.first <= now;

    /* One line on the card's own face, for what is true of the card itself
     * and is not the ordinary state: blocked, new, locked, or holding pieces
     * the mint says are spent. How fresh the mint's word is, is said once,
     * under the screen's title (`verified`, below); it was said here as well.
     * The card is drawn dark whatever the app's theme, so its inks are its
     * own. */
    const ON_CARD = 'rgba(255,255,255,.46)';
    const check = !fc ? ['', ON_CARD]
      : blocked ? ['Blocked', RED]
      : (fc.check && fc.check.spent) ? ['The mint says ' + this.fcSats(fc.check.spent) + ' is already spent', RED]
      : (fc.pin === 'none' && !fc.setUp) ? ['No PIN yet', AMBER]
      : !fc.hasRecord ? ['Not finished', AMBER]
      : fc.locked ? ['Locked', AMBER]
      : ['', ON_CARD];

    /* The card's mint and what it holds are in the pill, as home's are, and
     * under what it holds how much of its limit is left. CHANGE LIMIT is where
     * it is changed. */
    // a card in the last month before its date: said where the money waiting for a card is said, and renewed from there
    if (on && fc && near && !past && fc.balance > 0) {
      notes.push({ text: 'This card must be renewed by ' + this.fcDay(fc.first) + '. Press here, then tap it.', tap: () => this.fcRenew() });
    }

    /* The two smaller things to do with a card, in home's SCAN and PASTE
     * slots under ADD FUNDS and WITHDRAW: a lock for its PIN, a dial for its
     * limit. Both are the owner's: only the phone that holds the words the card
     * was set up with can do either. */
    const links = !usable ? [] : [
      { label: addable ? 'ADD PIN' : 'CHANGE PIN', ink: 'var(--ink)', tap: () => (addable ? this.fcPinAdd() : this.fcChangePin()), spin: 'rotate(180deg)',
        path: 'M6.4 10.4V7.6a5.6 5.6 0 0 1 11.2 0v2.8M5.2 10.4h13.6a1.4 1.4 0 0 1 1.4 1.4v7.4a1.4 1.4 0 0 1-1.4 1.4H5.2a1.4 1.4 0 0 1-1.4-1.4v-7.4a1.4 1.4 0 0 1 1.4-1.4Z' },
      { label: 'CHANGE LIMIT', ink: 'var(--ink)', tap: () => this.fcSetLimit(), spin: 'none',
        path: 'M4.6 16.8a8.2 8.2 0 1 1 14.8 0M12 13.6l3.7-4.4M12 14.6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z' },
    ];

    /* Under the title: how fresh the mint's word on this card is. Just now,
     * where it has just been asked; how long ago, on a phone that cannot ask
     * and has asked before about these same pieces; not verified, where it
     * never has, or where the mint says some of it is spent. A card with
     * nothing on it has nothing a mint could dispute. */
    const DIMMED = 'rgba(var(--ink-rgb),.62)';
    const nowMs = Date.now();
    const verified = (!fc || fresh || blocked || !fc.hasRecord) ? ['', DIMMED]
      : fc.check === 'asking' ? ['Verifying\u2026', DIMMED]
      : (fc.check && fc.check.spent) ? ['Not Verified', RED]
      : (fc.check === 'ok' || !(fc.count > 0)) ? ['Verified ' + this.fcAgo(fc.checkedAt ? nowMs - fc.checkedAt : 0), DIMMED]
      : fc.checkedAt ? ['Verified ' + this.fcAgo(nowMs - fc.checkedAt), DIMMED]
      : ['Not Verified', AMBER];

    /* Under the limits: the change this card made for itself that no till has handed back (software 1.12), what it comes to and
     * where it stands, one line for each state it is in. Dollars first and the sats after, as the balance is. */
    const owes = (on && fc && fc.owes && fc.owes.parts) || [];

    const px = this.px ? this.px() : 0;
    return {
      isFlashcard: on,
      fcVerified: verified[0], fcVerifiedInk: verified[1], fcVerifiedShown: !!verified[0],
      // which design the card on screen is drawn in (FC_DESIGNS)
      fcDesign: this.fcDesignOf(fc),
      // a card that has been read says what it is on its own face
      fcSub: fc ? '' : 'Ecash on a card, spent with a tap and a PIN.',
      fcNone: on && !fc,
      fcHas: !!fc,
      fcNotes: notes,
      fcHasRows: rows.length > 0,
      fcRows: rows,
      /* Dollars first and the sats under them, as on home. With no price to
       * say dollars at, the sats are the figure and there is no second line. */
      /* Home's own pill, for a card that has a mint: the mint by the name this
       * phone knows it by, and what the card holds. */
      fcPill: !!fc && !!fc.hasRecord,
      fcPillMint: (fc && fc.hasRecord) ? String(this.mintNameOf(fc.mint) || '') : '',
      fcPillLetter: (fc && fc.hasRecord) ? (String(this.mintNameOf(fc.mint) || '?').slice(0, 1).toUpperCase() || '?') : '',
      fcBalance: !fc ? '' : px > 0 ? '$ ' + this.usd((fc.balance / 1e8) * px) : '\u20bf ' + this.group(fc.balance),
      fcShowAlt: !!fc && px > 0,
      fcBalanceAlt: (fc && px > 0) ? '\u20bf ' + this.group(fc.balance) : '',
      /* How much of its limit the card has left, under what it holds, in
       * dollars first as the balance is. A card that has none left says so. */
      fcLimitShown: !!fc && !!fc.hasRecord && fc.pin !== 'blocked',
      fcLimitLine: !(fc && fc.hasRecord) ? ''
        : (limited && tapped) ? 'PER TAP ' + this.fcPrice(fc.tap.limit) + ' \u00b7 DAILY ' + this.fcPrice(day.limit)
        : tapped ? 'PER TAP LIMIT ' + this.fcPrice(fc.tap.limit)
        // another phone's card says its daily limit and keeps its per tap limit to its owner: it is not said to have none
        : (fc.tap && fc.tap.paced && fc.ownedHere !== true) ? (limited ? 'DAILY LIMIT ' + this.fcPrice(day.limit) : 'NO DAILY LIMIT')
        // only a no PIN limit: it is the one thing to say (with another limit it has its own line below)
        : (noPin && !limited) ? 'NO PIN UP TO ' + this.fcPrice(noPin.limit)
        : limited ? 'DAILY LIMIT ' + this.fcPrice(day.limit) : 'NO LIMIT',
      // under the balance, where there is a limit: what the day has left, and when it turns
      fcDayShown: !!fc && !!fc.hasRecord && fc.pin !== 'blocked' && limited,
      fcDayLeft: limited ? 'LEFT TODAY ' + (day.left > 0 || !px ? this.fcPrice(day.left) : '$0.00') : '',
      // under it, for a card with a PIN that pays some of a day without it: how much, and what is left of it today
      fcNoPinShown: !!fc && !!fc.hasRecord && fc.pin !== 'blocked' && !!noPin,
      fcNoPinLine: noPin ? 'NO PIN UP TO ' + this.fcPrice(noPin.limit) + ' \u00b7 LEFT TODAY ' + (noPin.left > 0 || !px ? this.fcPrice(noPin.left) : '$0.00') : '',
      // a card of 1.15 and on with a limit and no block yet has a day with no start: it begins with the first block the card is shown
      fcDayTurns: limited ? (day.turns > 0 ? 'THE DAY TURNS AT ' + this.fcWhen(day.turns).toUpperCase()
        : day.onTrust ? 'THE DAY BEGINS WITH THE CARD\u2019S FIRST BLOCK' : 'A NEW DAY BEGINS WITH THE NEXT PAYMENT') : '',
      /* Under the limits, for a card whose clock is Bitcoin block headers (software 1.15 and on): the block it reads its time from, as
       * the hash of the last header it was shown (the eight digits after its zeros) and the time in it; or that it has been shown none. */
      fcClockShown: !!fc && !!fc.hasRecord && fc.pin !== 'blocked' && !!fc.headers,
      fcClockLine: !(fc && fc.headers) ? ''
        : (fc.clock && fc.clock.short && fc.clock.time > 0) ? 'CLOCK \u00b7 block ' + fc.clock.short + '\u2026 \u00b7 ' + this.fcWhen(fc.clock.time).toUpperCase()
        : 'CLOCK \u00b7 NO BLOCK YET',
      // under the limits, where the card holds pieces larger than its limit on one tap
      fcAboveShown: !!fc && !!fc.hasRecord && fc.pin !== 'blocked' && (fc.above || 0) > 0,
      fcAboveLine: (fc && fc.above > 0) ? this.fcPrice(fc.above).toUpperCase() + ' IN PIECES ABOVE THE LIMIT \u00b7 A TILL HOLDS LONGER FOR THOSE' : '',
      // and under those, the change it is owed
      fcOwesShown: !!fc && !!fc.hasRecord && fc.pin !== 'blocked' && owes.length > 0,
      fcOwesLines: owes.map((p) => ({ text: 'CHANGE OWED TO THIS CARD \u00b7 ' + this.fcBoth(p.sats) + ' \u2014 ' + (this.FC_OWES[p.state] || '') })),
      fcCheck: check[0], fcCheckInk: check[1],
      fcHasCheck: !!check[0],
      // what has been done with this card, on this phone: only for a card that is one (it has a key and a record)
      fcHistoryVis: (fc && fc.hasRecord) ? 'visible' : 'hidden',
      fcHistory: () => this.fcHistory(),
      fcNew: fresh,
      fcNewLine: (fc && fc.pin === 'set' && !fc.hasRecord)
        ? 'Its set-up was cut short. Finish it to put money on it.'
        : 'This card is new. Set it up to put money on it.',
      fcBlocked: blocked,
      fcUnblock: unblock,
      fcUnblockTap: () => this.fcChangePin(),
      /* A blocked card's money: gone, where the card is cash; the loader's to
       * take back, where it is not (and here, where this phone can). */
      fcBlockedLine: (fc && fc.ownedHere)
        ? 'Too many wrong PINs. This phone can unblock the card by giving it a new PIN.'
        : (fc && fc.owner)
        ? 'Too many wrong PINs. Only the phone that owns this card can unblock it, with a new PIN.'
        : (fc && !fc.recoverable)
        ? 'Too many wrong PINs. This card is cash, so what is on it cannot be got back.'
        : (fc && fc.mine && this.FC_RECOVERABLE)
        ? 'Too many wrong PINs. This phone can take its money back after its date, from CARDS YOU LOADED.'
        : 'Too many wrong PINs. Only the phone that loaded it can take its money back, after its date.',
      fcUsable: usable,
      fcLinks: links,
      fcTap: () => this.fcRead(),
      fcAdd: () => this.fcAdd(),
      fcWithdraw: () => this.fcWithdraw(),
      fcSetUp: () => this.fcSetUp(),
    };
  }

