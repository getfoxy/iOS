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

  fcW() {
    const W = window.FoxyWallet;
    return (W && W.cardSession) ? W : null;
  }

  /* A card has no name. The last four characters of its key tell two apart. */
  fcName(key) { return 'CARD ··' + String(key || '').slice(-4).toUpperCase(); }

  fcSats(n) { return '₿' + this.group(Math.round(Number(n) || 0)); }

  /* A piece's date, as a day. Written out here and not left to the phone's
   * region, so the same card reads the same on every phone. */
  fcDay(secs) {
    const d = new Date((Number(secs) || 0) * 1000);
    return d.getDate() + ' ' + this.FC_MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  goFlashcard() {
    // a card read on an earlier visit is not shown again: it may be somebody else's
    this._fcCard = null;
    this.setState(p => ({ fc: null, screen: 'flashcard', stack: p.stack.concat([p.screen]) }));
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

  /* A card's PIN, on the pad the lock uses. `o`: title, subtitle, warn. */
  fcAskPin(o, then) {
    const opt = o || {};
    this.pinOverlay({
      title: opt.title || 'CARD PIN',
      subtitle: opt.subtitle || '',
      warn: opt.warn || '',
      cta: opt.cta || 'NEXT',
      onCancel: () => { if (opt.onCancel) opt.onCancel(); },
      onSubmit: (pin) => { this.pinDismiss(); then(pin); },
    });
  }

  /* An amount of sats, on the same pad. `o.most` is the most that can be
   * typed, with `o.mostSays` to say why not; `o.alt` a second answer. */
  fcAskSats(o, then) {
    const opt = o || {};
    this.pinOverlay({
      amount: true,
      title: opt.title || 'AMOUNT',
      subtitle: opt.subtitle || '',
      cta: opt.cta || 'NEXT',
      alt: opt.alt ? { label: opt.alt.label, tap: () => { this.pinDismiss(); opt.alt.tap(); } } : null,
      onCancel: () => {},
      onSubmit: (value, warn) => {
        const sats = Math.round(Number(value) || 0);
        if (opt.most != null && sats > opt.most) { warn(opt.mostSays || 'That is too much.'); return; }
        this.pinDismiss();
        then(sats);
      },
    });
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
        reason: ((e.tries === 1) ? '1 try left.' : (e.tries + ' tries left.')) + safe }, again),
      'blocked': () => ({ title: 'CARD BLOCKED',
        reason: 'Too many wrong PINs. Its owner can take the money back with their own phone.' }),
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
      subtitle: 'To pay ' + this.fcSats(sats) + '. The card’s owner types its PIN here.',
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
      subtitle: owed > 0 ? 'To put ' + this.fcSats(owed) + ' on the card.' : 'To write to the card.',
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

  fcRead() {
    const W = this.fcW();
    if (!W) return;
    this.fcTap({}, (link) => W.cardLook(link))
      .then((card) => this.fcShow(card), (e) => this.fcFailed(e, { again: () => this.fcRead() }));
  }

  /* What a card said, kept for the screen. Only on the FLASHCARD screen: a
   * payer's card read at the till is not left on show in the menu. */
  fcShow(card) {
    if (!card || !card.key || this.state.screen !== 'flashcard') return;
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
    if (this.offlineNow()) { this.offlineNo('Setting up a card'); return; }
    const first = (warn) => this.fcAskPin({
      title: 'CHOOSE A PIN',
      subtitle: 'Four to eight digits. The card asks for it every time it pays.',
      warn: warn || '',
    }, (a) => this.fcAskPin({
      title: 'TYPE IT AGAIN',
      subtitle: 'So a mistyped digit does not become the card’s PIN.',
    }, (b) => {
      if (a !== b) { first('Those did not match. Start again.'); return; }
      this.fcSetUpKind(a);
    }));
    first('');
  }

  fcSetUpKind(pin) {
    const run = (recoverable) => {
      const W = this.fcW();
      this.fcTap({ body: 'Setting it up at ' + this.mintName() + '.' }, (link, on) => { on('writing'); return W.cardSetUp(link, { pin, recoverable }); })
        .then((card) => {
          this.fcShow(card);
          this.haptic && this.haptic('success');
          this.blockedCard('fc-ready', {
            tone: 'ask', title: 'THE CARD IS READY',
            reason: recoverable
              ? 'It holds nothing yet. What you put on it can be taken back by this phone a year later, if the card is lost.'
              : 'It holds nothing yet. It is cash: whoever has the card and its PIN has the money.',
            retry: 'ADD FUNDS', go: () => this.fcAdd(), shut: { label: 'LATER' },
          });
        }, (e) => this.fcFailed(e, { again: () => this.fcSetUpKind(pin) }));
    };
    this.blockedCard('fc-kind', {
      tone: 'ask', title: 'IF THE CARD IS LOST',
      reason: 'RECOVERABLE: this phone can take the money back after a year.\n'
        + 'LIKE CASH: lose the card and the money is gone. Choose it for a gift.',
      chip: 'Its money will be at ' + this.mintName() + '.',
      retry: 'RECOVERABLE', go: () => run(true),
      shut: { label: 'LIKE CASH', tap: () => run(false) },
    });
  }

  /* ---- add funds ------------------------------------------------------------
   * The amount, the card's PIN, then the mint, then the card: the pieces are
   * made before the tap, so the card is held for as long as writing takes and
   * no longer. A tap that fails leaves them owed to the card. */
  fcAdd() {
    if (!this.fcReady('Adding funds')) return;
    const fc = this.state.fc;
    const have = Math.floor(this.balNow().sats || 0);
    this.fcAskSats({
      title: 'ADD FUNDS',
      subtitle: 'You have ' + this.fcSats(have) + '. The card has room for ' + fc.room + ' more piece' + (fc.room === 1 ? '' : 's') + '.',
      most: have, mostSays: 'You have ' + this.fcSats(have) + '.',
    }, (sats) => this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To add ' + this.fcSats(sats) + ' to the card.',
    }, (pin) => this.fcAddRun(sats, pin)));
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
      reason: 'One PIN entry can spend ' + this.fcSats(fc.limit) + ' of this card. Take the limit off first, or move less.',
      retry: 'SET LIMIT', go: () => this.fcSetLimit(), shut: { label: 'CANCEL' },
    });
    return true;
  }

  /* ---- withdraw ------------------------------------------------------------ */
  fcWithdraw() {
    if (!this.fcReady('Withdrawing')) return;
    const fc = this.state.fc;
    if (!(fc.balance > 0)) { this.toast('There is nothing on this card.', true); return; }
    const pin = (sats) => {
      if (this.fcOverLimit(sats || fc.balance)) return;
      this.fcAskPin({
        title: 'ENTER PIN TO WITHDRAW',
        subtitle: (sats ? this.fcSats(sats) : 'Everything') + ' from the card to this phone.',
      }, (p) => this.fcWithdrawRun(sats, p));
    };
    this.fcAskSats({
      title: 'WITHDRAW',
      subtitle: 'The card holds ' + this.fcSats(fc.balance) + '.',
      most: fc.balance, mostSays: 'The card holds ' + this.fcSats(fc.balance) + '.',
      alt: { label: 'ALL OF IT (' + this.fcSats(fc.balance) + ')', tap: () => pin(0) },
    }, (sats) => pin(sats));
  }

  fcWithdrawRun(sats, pin) {
    const W = this.fcW();
    const said = (r) => {
      this.fcGone();
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

  fcSetLimit() {
    const fc = this.state.fc;
    if (!fc) return;
    const W = this.fcW();
    const run = (sats) => this.fcAskPin({
      title: 'CARD PIN',
      subtitle: sats ? 'To let one PIN entry spend up to ' + this.fcSats(sats) + '.' : 'To take the limit off.',
    }, (pin) => this.fcTap({}, (link, on) => { on('writing'); return W.cardSetLimit(link, { pin, sats }); })
      .then((card) => {
        this.fcShow(card);
        this.toast(sats ? 'Limit set.' : 'No limit.');
      }, (e) => this.fcFailed(e, { again: () => this.fcSetLimit() })));
    this.fcAskSats({
      title: 'SET LIMIT',
      subtitle: 'The most a till can take for one typing of the PIN.'
        + (fc.limit ? ' Now ' + this.fcSats(fc.limit) + '.' : ''),
      alt: { label: 'NO LIMIT', tap: () => run(0) },
    }, (sats) => run(sats));
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
      subtitle: 'To renew ' + this.fcSats(fc.balance) + ' for another year.',
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
      text: this.fcSats(r.sats) + ' is waiting to go onto ' + this.fcName(r.key) + '. Tap the card to finish.',
      tap: () => this.fcWriteAsk({}),
    }));

    const rows = (!W || fc) ? [] : W.cardsList().map(r => ({
      name: this.fcName(r.key),
      sub: r.takenBack ? 'Taken back'
        : r.sats ? this.fcSats(r.sats) + ' when last seen' : 'Empty when last seen',
      text: r.takenBack ? '' : (r.due && r.sats > 0) ? 'TAKE BACK' : r.date ? 'after ' + this.fcDay(r.date) : '',
      ink: (r.due && r.sats > 0 && !r.takenBack) ? 'var(--acc-ink)' : DIM,
      tap: () => this.fcRowCard(r),
    }));

    const fresh = !!fc && (fc.pin === 'none' || !fc.hasRecord) && fc.pin !== 'blocked';
    const blocked = !!fc && fc.pin === 'blocked';
    const usable = !!fc && fc.pin === 'set' && fc.hasRecord;
    const near = !!fc && fc.mine && fc.first > 0 && fc.first - now < this.FC_RENEW_DAYS * 86400;
    const past = near && fc.first <= now;

    const chip = !fc ? ['', DIM, 'transparent']
      : blocked ? ['BLOCKED', RED, 'rgba(255,92,92,.14)']
      : fc.pin === 'none' ? ['NO PIN YET', AMBER, 'rgba(247,147,26,.14)']
      : !fc.hasRecord ? ['NOT FINISHED', AMBER, 'rgba(247,147,26,.14)']
      : fc.locked ? ['LOCKED', AMBER, 'rgba(247,147,26,.14)']
      : ['PIN SET', 'rgba(var(--ink-rgb),.7)', 'rgba(var(--ink-rgb),.08)'];

    const check = !fc ? ['', DIM]
      : fc.check === 'asking' ? ['Checking with the mint…', DIM]
      : fc.check === 'ok' ? ['Checked with the mint', DIM]
      : fc.check === 'off' ? ['Not checked: no connection', AMBER]
      : fc.check === 'other' ? ['Not checked: this phone is at another mint', AMBER]
      : (fc.check && fc.check.spent) ? ['The mint says ' + this.fcSats(fc.check.spent) + ' of this is already spent', RED]
      : ['', DIM];

    const facts = [];
    if (fc && fc.hasRecord) {
      // its address, as the card has it: a name made from it would read the same for a look-alike
      facts.push({ label: 'MINT', value: String(fc.mint).replace(/^https?:\/\//, ''), ink: 'var(--ink)' });
      facts.push({ label: 'HOLDS', value: fc.count + ' piece' + (fc.count === 1 ? '' : 's') + ' · ' + fc.room + ' place' + (fc.room === 1 ? '' : 's') + ' free', ink: 'var(--ink)' });
      facts.push(!fc.recoverable
        ? { label: 'IF LOST', value: 'Not recoverable: this card is cash', ink: 'var(--ink)' }
        : past ? { label: 'IF LOST', value: 'Its date has passed. Take it back from CARDS YOU LOADED.', ink: RED }
        : near ? { label: 'IF LOST', value: 'Renew by ' + this.fcDay(fc.first), ink: AMBER }
        : fc.mine ? { label: 'IF LOST', value: fc.last ? 'This phone can take it back after ' + this.fcDay(fc.last) : 'This phone can take it back, a year after it is loaded', ink: 'var(--ink)' }
        : { label: 'IF LOST', value: 'The phone that loaded it can take it back' + (fc.last ? ' after ' + this.fcDay(fc.last) : ''), ink: 'var(--ink)' });
      facts.push({ label: 'LIMIT', value: fc.limit ? 'One PIN entry can spend ' + this.fcSats(fc.limit) : 'No limit', ink: 'var(--ink)' });
    }

    const links = !usable ? [] : [
      { label: 'CHANGE PIN', ink: DIM, tap: () => this.fcChangePin() },
      { label: 'SET LIMIT', ink: DIM, tap: () => this.fcSetLimit() },
    ].concat((near && !past && fc.balance > 0) ? [{ label: 'RENEW', ink: AMBER, tap: () => this.fcRenew() }] : []);

    const px = this.px ? this.px() : 0;
    return {
      isFlashcard: on,
      fcSub: fc ? this.fcName(fc.key) + (fc.mine ? ' · this phone can take it back' : '')
        : 'Ecash on a card, spent with a tap and a PIN.',
      fcNone: on && !fc,
      fcHas: !!fc,
      fcNotes: notes,
      fcHasRows: rows.length > 0,
      fcRows: rows,
      fcBalance: fc ? '₿ ' + this.group(fc.balance) : '',
      fcShowAlt: !!fc && px > 0 && fc.balance > 0,
      fcBalanceAlt: (fc && px > 0) ? '$ ' + this.usd((fc.balance / 1e8) * px) : '',
      fcChip: chip[0], fcChipInk: chip[1], fcChipBg: chip[2],
      fcCheck: check[0], fcCheckInk: check[1],
      fcHasCheck: !!check[0],
      fcFacts: facts,
      fcNew: fresh,
      fcNewLine: (fc && fc.pin === 'set' && !fc.hasRecord)
        ? 'Its set-up was cut short. Finish it to put money on it.'
        : 'This card is new. Give it a PIN to put money on it.',
      fcBlocked: blocked,
      fcBlockedLine: (fc && fc.mine)
        ? 'Too many wrong PINs. This phone can take its money back after its date, from CARDS YOU LOADED.'
        : 'Too many wrong PINs. Only the phone that loaded it can take its money back.',
      fcUsable: usable,
      fcLinks: links,
      fcTap: () => this.fcRead(),
      fcTapLabel: fc ? 'TAP ANOTHER CARD' : 'TAP CARD',
      fcAdd: () => this.fcAdd(),
      fcWithdraw: () => this.fcWithdraw(),
      fcSetUp: () => this.fcSetUp(),
    };
  }

