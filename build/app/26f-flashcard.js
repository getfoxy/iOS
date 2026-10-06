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
   * Three things here are not this app's to draw. The sheet that slides up
   * while the phone looks for a card is the phone's own, and one line of text
   * on it is ours (`link.say`). The page behind it cannot be touched while it
   * is up. And a card has to stay on the phone while the mint is asked, so the
   * screen behind the sheet says what is happening for as long as that takes.
   *
   * A card's PIN is not Foxy's PIN. It is typed on the same pad because that
   * is the pad a person already knows; it is held in a variable for the length
   * of one flow, passed to the card, and never stored.
   */

  /* A tap, step by step: the heading on our screen, and the line on the
   * phone's sheet. The wallet names the steps as it reaches them. */
  FC_STEPS = {
    hold: ['HOLD THE CARD<br>TO THE TOP OF THE PHONE', 'Hold the card to the top of the phone'],
    reading: ['READING<br>THE CARD', 'Reading the card'],
    signing: ['KEEP THE CARD<br>THERE', 'Keep the card there'],
    mint: ['KEEP THE CARD<br>THERE', 'Keep the card there: asking the mint'],
    change: ['PUTTING CHANGE<br>BACK ON THE CARD', 'Putting change back on the card'],
    writing: ['WRITING<br>TO THE CARD', 'Keep the card there: writing to it'],
    done: ['REMOVE<br>THE CARD', 'Done'],
  };
  FC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // how near its date a card's own phone starts saying RENEW
  FC_RENEW_DAYS = 30;
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
   * the sheet. `fn(link, on)` is what to do with the card; `on(step)` moves
   * both screens on. Resolves and rejects as `fn` does, with our screen down
   * either way. */
  fcTap(o, fn) {
    const W = this.fcW();
    if (!W) return Promise.reject(new Error('The wallet is not ready.'));
    this._fcTapO = o || {};
    this.fcStage('hold');
    return W.cardSession(this.FC_STEPS.hold[1], (link) => {
      const on = (step) => {
        const words = this.FC_STEPS[step];
        if (!words) return;
        this.fcStage(step);
        link.say(words[1]);
      };
      on('reading');
      return fn(link, on);
    }).then((r) => { this.hideStage('card'); return r; },
            (e) => { this.hideStage('card'); throw e; });
  }

  fcStage(step) {
    const words = this.FC_STEPS[step] || this.FC_STEPS.hold;
    const o = this._fcTapO || {};
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

  /* A card's PIN, on the pad the lock uses. `o`: title, subtitle, warn, and
   * `cta`, what the button says: it names the thing the PIN is for ("PAY
   * $0.43"), and it cannot be pressed until four digits are in. The way out
   * is a back button at the top left, where every screen's is; `o.onBack`
   * runs after it. */
  fcAskPin(o, then) {
    const opt = o || {};
    this.pinOverlay({
      title: opt.title || 'CARD PIN',
      subtitle: opt.subtitle || '',
      warn: opt.warn || '',
      cta: opt.cta || 'NEXT',
      gate: true,
      back: () => { if (opt.onBack) opt.onBack(); },
      onSubmit: (pin) => { this.pinDismiss(); then(pin); },
    });
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
    else if (flow === 'cardLimit') this.fcLimitPin(sats);
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
        reason: 'Too many wrong PINs. This card can no longer pay.' }),
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
      'over-limit': () => ({ tone: 'warn', title: 'OVER THE CARD’S LIMIT', reason: said + safe }),
      'gone': () => Object.assign({ tone: 'warn', title: 'THE CARD LEFT TOO SOON',
        reason: 'Hold it still until the phone says to remove it.' + safe }, again),
      'interrupted': () => ({ tone: 'warn', title: 'THE CARD LEFT TOO SOON', reason: said,
        retry: 'TAP CARD', go: () => this.fcWriteAsk({}), shut: { label: 'LATER' } }),
      'spent': () => ({ title: opt.taken ? 'NOT PAID' : 'ALREADY SPENT',
        reason: 'The mint says this card’s money was already spent.' }),
      'no-nfc': () => ({ tone: 'warn', title: 'NO CARD READER', reason: 'This phone cannot read a card.' }),
      'full': () => ({ tone: 'warn', title: 'THE CARD IS FULL', reason: said }),
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
    const settled = (how) => {
      clearTimeout(this._fcCheckT);
      this.hideStage('cardChecking');
      if (how === 'paid') { this.fcMoved(opt); return; }
      if (how === 'spent') { this.fcFailed({ card: 'spent' }, { taken: opt.taken }); return; }
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
        if (mine && mine.state === 'paid') return settled('paid');
        if (mine && mine.state === 'spent') return settled('spent');
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
    if (this.offlineNow()) { this.offlineNo('A card payment'); return; }
    this.fcPayAsk(sats);
  }

  fcPayAsk(sats) {
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To pay ' + this.fcBoth(sats) + '. The card\u2019s owner types its PIN here.',
      cta: 'PAY ' + this.fcPrice(sats),
    }, (pin) => this.fcPayRun(sats, pin));
  }

  fcPayRun(sats, pin) {
    const W = this.fcW();
    const opt = { paying: true, taken: true, again: () => this.fcPayAsk(sats) };
    this.fcTap({ amount: this.stageMoney(sats) }, (link, on) => W.cardPay(link, { sats, pin, on }))
      .then((r) => {
        this.haptic && this.haptic('success');
        this.fcMoved(opt);
        const ch = r && r.change;
        // made, and the card left before it was written back: it waits here for the card
        if (ch && !ch.written && !ch.unmade && ch.sats > 0) this.fcChangeWaiting(ch.sats);
      }, (e) => this.fcFailed(e, opt));
  }

  fcChangeWaiting(sats) {
    this.blockedCard('fc-change', {
      tone: 'warn', title: 'TAP THE CARD AGAIN',
      reason: 'The payment is made. ' + this.fcSats(sats) + ' of change is waiting to go back on the card.',
      chip: 'It is kept for that card and no other.',
      retry: 'TAP CARD', go: () => this.fcWriteAsk({}),
      shut: { label: 'LATER' },
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
    const owed = this.fcOwed().reduce((n, r) => n + r.sats, 0);
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: owed > 0 ? 'To put ' + this.fcBoth(owed) + ' on the card.' : 'To write to the card.',
      cta: owed > 0 ? 'PUT ' + this.fcPrice(owed) + ' ON CARD' : 'WRITE TO CARD',
    }, (pin) => this.fcWriteRun(pin, opt));
  }

  fcWriteRun(pin, o) {
    const W = this.fcW();
    const opt = o || {};
    this.fcTap({ amount: opt.sats ? this.stageMoney(opt.sats) : '' }, (link, on) => { on('writing'); return W.cardWrite(link, { pin }); })
      .then((r) => this.fcWrote(r, opt),
            (e) => this.fcFailed(e, { again: () => this.fcWriteAsk(opt) }));
  }

  fcWrote(r, o) {
    this.fcShow(r.card);
    this.refreshBalance();
    this.loadHistory();
    if (r.left > 0) {
      this.blockedCard('fc-more', {
        tone: 'warn', title: r.why === 'full' ? 'THE CARD IS FULL' : 'TAP THE CARD AGAIN',
        reason: (r.sats > 0 ? this.fcSats(r.sats) + ' went on. ' : '')
          + (r.why === 'full' ? 'There is no room for the rest. Take some money off it first.' : 'The rest is still waiting for it.'),
        retry: 'TAP CARD', go: () => this.fcWriteAsk(o), shut: { label: 'LATER' },
      });
      return;
    }
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
    /* What it now holds is said to its holder, on the FLASHCARD screen. A
     * till putting a payer's change back says the change and nothing else. */
    this.blockedCard('fc-on', {
      tone: 'ask', title: 'ON THE CARD',
      reason: this.fcSats(r.sats) + ' went onto the card.'
        + (this.state.screen === 'flashcard' ? ' It now holds ' + this.fcSats(r.card.balance) + '.' : ''),
      shut: { label: 'DONE' },
    });
  }

  /* ---- MENU > FLASHCARD: reading a card ---------------------------------- */

  /* `open`: the card's screen is opened by what is read (the menu's way in). */
  fcRead(open) {
    const W = this.fcW();
    if (!W) return;
    this.fcTap({}, (link) => W.cardLook(link))
      .then((card) => this.fcShow(card, open), (e) => this.fcFailed(e, { again: () => this.fcRead(open) }));
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
      limit: (card.record && card.record.limit) || 0,
      mint: (card.record && card.record.mint) || '',
      recoverable: !!(card.record && card.record.refundKey),
      mine: !!(W && W.cardIsMine(card)),
      first: dates.length ? Math.min.apply(null, dates) : 0,
      last: dates.length ? Math.max.apply(null, dates) : 0,
      check: (card.pieces || []).length ? 'asking' : 'none',
    } });
    if ((card.pieces || []).length) this.fcCheck(card);
    // ecash found for this card is asked of the mint, and the line about it redrawn if any of it was not owed after all
    if (W && W.cardOwedCheck) W.cardOwedCheck(card).then((gone) => { if (gone) this.forceUpdate(); }, () => {});
  }

  /* The mint's word on what the card says it holds. A card is a list of
   * pieces and a promise not to sign twice; whether the pieces are still good
   * is something only the mint knows. */
  fcCheck(card) {
    const W = this.fcW();
    const put = (check) => {
      if (!this.state.fc || this.state.fc.key !== card.key || this._fcCard !== card) return;
      this.setState({ fc: Object.assign({}, this.state.fc, { check }) });
    };
    W.cardCheck(card).then((r) => put(r.spent > 0 ? { spent: r.spent } : 'ok'),
                           (e) => put((e && e.card) === 'other-mint' ? 'other' : 'off'));
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
      this.blockedCard('fc-other-mint', {
        tone: 'warn', title: 'A DIFFERENT MINT',
        reason: 'This card’s money is at ' + this.mintNameOf(fc.mint) + '. This phone is at ' + this.mintName() + '.',
        retry: 'SWITCH MINT', go: () => this.goSwitchMint(), shut: { label: 'CANCEL' },
      });
      return false;
    }
    return true;
  }

  /* ---- a new card ----------------------------------------------------------
   * A PIN, typed twice; then whether a lost card's money can come back; then
   * one tap that writes both. The mint is this phone's, shown and not chosen. */
  fcSetUp() {
    if (!this.state.fc) return;
    // no mint is asked: the card is told this phone's mint and given a key from this phone's words
    const first = (warn) => this.fcAskPin({
      title: 'CHOOSE A PIN',
      subtitle: 'Four to eight digits. The card asks for it every time it pays.',
      warn: warn || '',
    }, (a) => this.fcAskPin({
      title: 'TYPE IT AGAIN',
      subtitle: 'So a mistyped digit does not become the card’s PIN.',
    }, (b) => {
      if (a !== b) { first('Those did not match. Start again.'); return; }
      // cash, with nothing asked; or the one choice, where there is one to make
      if (this.FC_RECOVERABLE) this.fcSetUpKind(a); else this.fcSetUpRun(a, false);
    }));
    first('');
  }

  fcSetUpRun(pin, recoverable) {
    const W = this.fcW();
    this.fcTap({ body: 'Setting it up at ' + this.mintName() + '.' }, (link, on) => { on('writing'); return W.cardSetUp(link, { pin, recoverable }); })
      .then((card) => {
        this.fcShow(card);
        this.haptic && this.haptic('success');
        /* What cash means, said once, where the card becomes one: there is
         * nobody to ask for it back. Its PIN is part of that. The card
         * blocks itself for good after three wrong ones in a row, and what
         * is on a blocked cash card can be spent by nobody. */
        this.blockedCard('fc-ready', {
          tone: 'ask', title: 'THE CARD IS READY',
          reason: recoverable
            ? 'It holds nothing yet. What you put on it can be taken back by this phone a year later, if the card is lost.'
            : 'It holds nothing yet. It is cash: whoever has the card and its PIN has the money.',
          chip: recoverable ? '' : 'Lose the card, forget its PIN, or type it wrong three times in a row, and the money on it is gone.',
          retry: 'ADD FUNDS', go: () => this.fcAdd(), shut: { label: 'LATER' },
        });
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

  fcAddPin(sats) {
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To add ' + this.fcBoth(sats) + ' to the card.',
      cta: 'ADD ' + this.fcPrice(sats) + ' TO CARD',
    }, (pin) => { this.fcLeaveAmount(); this.fcAddRun(sats, pin); });
  }

  fcAddRun(sats, pin) {
    const W = this.fcW();
    const card = this._fcCard;
    this.stageScreen('cardReady', {
      art: 'card', title: 'GETTING<br>IT READY', amount: this.stageMoney(sats),
      body: 'Keep the card nearby. You will be asked to tap it in a moment.',
      dots: true, forMs: 90000, button: 'CLOSE',
    });
    W.cardPrepare(card, sats).then((made) => {
      // said by this flow, so not announced as a payment sent (16-history-lists.js)
      if (made && made.hash) this.txIsNew(made.hash);
      this.hideStage('cardReady');
      this.fcWriteRun(pin, { sats: made.sats });
    }, (e) => {
      this.hideStage('cardReady');
      this.fcFailed(e, {});
    });
  }

  /* A card's limit is the card's, and holds for its owner too: it is the
   * most one typing of the PIN may spend, whoever types it. So emptying or
   * renewing a card that holds more than its limit is refused by the card.
   * Said here, before the PIN, with the way round it: take the limit off. */
  fcOverLimit(sats) {
    const fc = this.state.fc;
    if (!fc || !fc.limit || !(sats > fc.limit)) return false;
    this.blockedCard('fc-limit', {
      tone: 'warn', title: 'OVER THE CARD\u2019S LIMIT',
      reason: 'One PIN entry can spend ' + this.fcBoth(fc.limit) + ' of this card. Take the limit off first, or move less.',
      retry: 'SET LIMIT', go: () => this.fcSetLimit(), shut: { label: 'CANCEL' },
    });
    return true;
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
    if (!fc || this.fcOverLimit(sats || fc.balance)) return;
    this.fcAskPin({
      title: 'ENTER PIN TO WITHDRAW',
      subtitle: (sats ? this.fcBoth(sats) : 'Everything') + ' from the card to this phone.',
      cta: sats ? 'WITHDRAW ' + this.fcPrice(sats) : 'WITHDRAW ALL',
    }, (p) => { this.fcLeaveAmount(); this.fcWithdrawRun(sats, p); });
  }

  fcWithdrawRun(sats, pin) {
    const W = this.fcW();
    const said = (r) => {
      // the card as it reads now, where the tap lasted long enough to read it; otherwise its screen goes
      if (r && r.card) this.fcShow(r.card); else this.fcGone();
      this.haptic && this.haptic('success');
      this.blockedCard('fc-out', {
        tone: 'ask', title: 'IN YOUR WALLET',
        reason: (r && r.sats ? this.fcSats(r.sats) : 'The money') + ' from the card is in this phone now.',
        shut: { label: 'DONE' },
      });
    };
    const opt = { taken: true, again: () => this.fcWithdraw(), done: () => said(null) };
    this.fcTap({ amount: sats ? this.stageMoney(sats) : '' }, (link, on) => W.cardWithdraw(link, sats ? { pin, sats, on } : { pin, on }))
      .then((r) => {
        if (r && r.hash) this.txIsNew(r.hash);
        this.fcMoved({});
        said(r);
        const ch = r && r.change;
        if (ch && !ch.written && !ch.unmade && ch.sats > 0) this.fcChangeWaiting(ch.sats);
      }, (e) => this.fcFailed(e, opt));
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
  fcChangePin() {
    if (!this.state.fc) return;
    const W = this.fcW();
    const fresh = (old, warn) => this.fcAskPin({
      title: 'NEW PIN', subtitle: 'Four to eight digits.', warn: warn || '',
    }, (a) => this.fcAskPin({ title: 'NEW PIN AGAIN', subtitle: 'So a mistyped digit does not become the card’s PIN.' }, (b) => {
      if (a !== b) { fresh(old, 'Those did not match. Start again.'); return; }
      this.fcTap({}, (link, on) => { on('writing'); return W.cardChangePin(link, { pin: old, newPin: a }); })
        .then(() => {
          this.haptic && this.haptic('success');
          this.blockedCard('fc-pin', { tone: 'ask', title: 'PIN CHANGED', reason: 'The card asks for the new one from now on.', shut: { label: 'DONE' } });
        }, (e) => this.fcFailed(e, { again: () => this.fcChangePin() }));
    }));
    this.fcAskPin({ title: 'CURRENT PIN', subtitle: 'The card’s PIN as it is now.' }, (old) => fresh(old, ''));
  }

  /* An amount on the keypad, or NO LIMIT, the button under its NEXT. */
  fcSetLimit() {
    if (!this.state.fc) return;
    this.fcAmount('cardLimit');
  }

  fcLimitPin(sats) {
    const W = this.fcW();
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: sats ? 'To let one PIN entry spend up to ' + this.fcBoth(sats) + '.' : 'To take the limit off.',
      cta: sats ? 'SET LIMIT' : 'REMOVE LIMIT',
    }, (pin) => {
      this.fcLeaveAmount();
      this.fcTap({}, (link, on) => { on('writing'); return W.cardSetLimit(link, { pin, sats }); })
        .then((card) => {
          this.fcShow(card);
          this.toast(sats ? 'Limit set.' : 'No limit.');
        }, (e) => this.fcFailed(e, { again: () => this.fcSetLimit() }));
    });
  }

  /* Everything off the card and on again, which is the only way its pieces
   * get a new date: the date is part of each piece. */
  fcRenew() {
    if (!this.fcReady('Renewing a card')) return;
    const W = this.fcW();
    const fc = this.state.fc;
    if (this.fcOverLimit(fc.balance)) return;
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To renew ' + this.fcBoth(fc.balance) + ' for another year.',
      cta: 'RENEW',
    }, (pin) => this.fcTap({ amount: this.stageMoney(fc.balance), body: 'This takes longer than a payment. Keep the card there.' },
      (link, on) => W.cardRenew(link, { pin, on }))
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

    const rows = (!W || fc || !this.FC_RECOVERABLE) ? [] : W.cardsList().map(r => ({
      name: this.fcName(r.key),
      sub: r.takenBack ? 'Taken back'
        : r.sats ? this.fcSats(r.sats) + ' when last seen' : 'Empty when last seen',
      // only what can be done; the date it waits for is said when the row is opened
      text: (!r.takenBack && r.due && r.sats > 0) ? 'TAKE BACK' : '',
      ink: (r.due && r.sats > 0 && !r.takenBack) ? 'var(--acc-ink)' : DIM,
      tap: () => this.fcRowCard(r),
    }));

    const fresh = !!fc && (fc.pin === 'none' || !fc.hasRecord) && fc.pin !== 'blocked';
    const blocked = !!fc && fc.pin === 'blocked';
    const usable = !!fc && fc.pin === 'set' && fc.hasRecord;
    const near = !!fc && fc.mine && fc.first > 0 && fc.first - now < this.FC_RENEW_DAYS * 86400;
    const past = near && fc.first <= now;

    /* One line of status, engraved at the card's top right. The card's own
     * state comes first where it is not the ordinary one (a card that is
     * blocked, new, or locked), and otherwise the mint's word on what it says
     * it holds. The card is drawn dark whatever the app's theme, so its inks
     * are its own. */
    const ON_CARD = 'rgba(255,255,255,.46)';
    const word = !fc ? ''
      : fc.check === 'asking' ? 'Checking with the mint\u2026'
      : fc.check === 'ok' ? 'Checked with the mint'
      : fc.check === 'off' ? 'Not checked: no connection'
      : fc.check === 'other' ? 'Not checked: another mint'
      : '';
    const check = !fc ? ['', ON_CARD]
      : blocked ? ['Blocked', RED]
      : (fc.check && fc.check.spent) ? ['The mint says ' + this.fcSats(fc.check.spent) + ' is already spent', RED]
      : fc.pin === 'none' ? ['No PIN yet', AMBER]
      : !fc.hasRecord ? ['Not finished', AMBER]
      : fc.locked ? ['Locked' + (word ? ' \u00b7 ' + word : ''), AMBER]
      : [word, (fc.check === 'off' || fc.check === 'other') ? AMBER : ON_CARD];

    const facts = [];
    if (fc && fc.hasRecord) {
      // its address, as the card has it: a name made from it would read the same for a look-alike
      facts.push({ label: 'Mint', value: String(fc.mint).replace(/^https?:\/\//, ''), ink: 'var(--ink)' });
      facts.push({ label: 'Holds', value: fc.count + ' piece' + (fc.count === 1 ? '' : 's') + ' · ' + fc.room + ' place' + (fc.room === 1 ? '' : 's') + ' free', ink: 'var(--ink)' });
      facts.push(!fc.recoverable
        ? { label: 'If lost', value: 'Not recoverable: this card is cash', ink: 'var(--ink)' }
        : past ? { label: 'If lost', value: 'Its date has passed. Take it back from CARDS YOU LOADED.', ink: RED }
        : near ? { label: 'If lost', value: 'Renew by ' + this.fcDay(fc.first), ink: AMBER }
        : fc.mine ? { label: 'If lost', value: fc.last ? 'This phone can take it back after ' + this.fcDay(fc.last) : 'This phone can take it back, a year after it is loaded', ink: 'var(--ink)' }
        : { label: 'If lost', value: 'The phone that loaded it can take it back' + (fc.last ? ' after ' + this.fcDay(fc.last) : ''), ink: 'var(--ink)' });
      facts.push({ label: 'Limit', value: fc.limit ? 'One PIN entry can spend ' + this.fcSats(fc.limit) : 'No limit', ink: 'var(--ink)' });
    }

    /* The smaller things to do with a card, as round buttons like home's:
     * a lock for its PIN, a dial for its limit, and, in its last month, the
     * arrow that goes round for RENEW. */
    const links = !usable ? [] : [
      { label: 'CHANGE PIN', ink: 'var(--ink)', says: 'var(--ink)', tap: () => this.fcChangePin(),
        path: 'M6.4 10.4V7.6a5.6 5.6 0 0 1 11.2 0v2.8M5.2 10.4h13.6a1.4 1.4 0 0 1 1.4 1.4v7.4a1.4 1.4 0 0 1-1.4 1.4H5.2a1.4 1.4 0 0 1-1.4-1.4v-7.4a1.4 1.4 0 0 1 1.4-1.4Z' },
      { label: 'SET LIMIT', ink: 'var(--ink)', says: 'var(--ink)', tap: () => this.fcSetLimit(),
        path: 'M4.6 16.8a8.2 8.2 0 1 1 14.8 0M12 13.6l3.7-4.4M12 14.6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z' },
    ].concat((near && !past && fc.balance > 0) ? [{ label: 'RENEW', ink: AMBER, says: AMBER, tap: () => this.fcRenew(),
        path: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.4 4.6v4.2h4.2M12 7.6V12l3 1.8' }] : []);

    const px = this.px ? this.px() : 0;
    return {
      isFlashcard: on,
      // a card that has been read says what it is on its own face
      fcSub: fc ? '' : 'Ecash on a card, spent with a tap and a PIN.',
      fcNone: on && !fc,
      fcHas: !!fc,
      fcNotes: notes,
      fcHasRows: rows.length > 0,
      fcRows: rows,
      /* Dollars first and the sats under them, as on home. With no price to
       * say dollars at, the sats are the figure and there is no second line. */
      fcBalance: !fc ? '' : px > 0 ? '$ ' + this.usd((fc.balance / 1e8) * px) : '\u20bf ' + this.group(fc.balance),
      fcShowAlt: !!fc && px > 0,
      fcBalanceAlt: (fc && px > 0) ? '\u20bf ' + this.group(fc.balance) : '',
      fcCheck: check[0], fcCheckInk: check[1],
      fcHasCheck: !!check[0],
      fcFacts: facts,
      fcNew: fresh,
      fcNewLine: (fc && fc.pin === 'set' && !fc.hasRecord)
        ? 'Its set-up was cut short. Finish it to put money on it.'
        : 'This card is new. Give it a PIN to put money on it.',
      fcBlocked: blocked,
      /* A blocked card's money: gone, where the card is cash; the loader's to
       * take back, where it is not (and here, where this phone can). */
      fcBlockedLine: (fc && !fc.recoverable)
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

