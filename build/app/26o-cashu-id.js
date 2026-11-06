  /* ---- the Cashu ID: MY CASHU ID, a contact added by paste, a contact paid ---------------------------------------------
   *
   * The wallet's half is 08e-cashu-id.js and docs/CASHU-ID.md. Here:
   *
   *   MY CASHU ID (the menu, and home's round button at the top left)
   *                                the stage screen that shows a code to be scanned (`stageScreen`), with SHARE above DONE,
   *                                the share sheet the app uses for a token; the ID string is the code.
   *   a pasted or scanned ID ..... NAME THIS CONTACT?, a card with a field (`blockedCard` `field`); your own is said to be
   *                                yours, a mistyped one is refused ("That is not a Cashu ID.").
   *   paying one ................. CONTACTS (from SEND or the menu) → SET AMOUNT → the confirmation, which says once that the money
   *                                comes back after thirty days if it is not collected → sent over Nostr.
   *   money at another mint ...... PAID AT ANOTHER MINT, a card with three answers (`cidOfferCard`): BRING IT HOME (its fee
   *                                under it, or why it cannot be done), KEEP IT THERE, and SEND IT BACK where the payer proved
   *                                who it is; a tick remembers the answer for that mint. Not answered, it is a row in HISTORY
   *                                (`cidWaitingRows`) that opens the card again; SETTINGS > OTHER MINTS lists and forgets the
   *                                remembered answers (`cidChoicesCard`).
   *   paid to the ID key itself .. PAID TO YOUR ID KEY (`cidBareCard`): LEAVE IT, the default, or TAKE IT ANYWAY, which has
   *                                the ID key itself sign for that one delivery.
   *
   * The payment is made at the mint this phone is on, from the balance the keypad is in (dollars first, as a send is). */

  /* MY CASHU ID: the code, once the phone has given its two keys. Opening it is what makes this phone listen for payments
   * to it (`cashuIdShown`): an ID nobody was shown has nothing to listen for. */
  cidShow() {
    const W = window.FoxyWallet;
    if (!W || !W.cashuIdMine) { this.toast('This Foxy has no Cashu ID.', true); return; }
    const run = (this._cidShowRun = (this._cidShowRun || 0) + 1);
    this.stageScreen('cashuId', { art: '', title: 'MY CASHU ID', body: 'Reading it from your seed', dots: true, button: 'CANCEL',
      go: () => { if (this._cidShowRun === run) this._cidShowRun = 0; } });
    Promise.resolve(W.cashuIdMine()).then((mine) => {
      if (this._cidShowRun !== run) return;
      if (!mine || !mine.text) throw new Error('No Cashu ID was read.');
      this.cidShowCode(mine.text);
      if (W.cashuIdShown) Promise.resolve(W.cashuIdShown()).catch(() => {});
    }).catch((e) => {
      if (this._cidShowRun !== run) return;
      this._cidShowRun = 0;
      this.hideStage('cashuId');
      this.blockedCard('cidNone', { title: 'NO CASHU ID', reason: (W.reason ? W.reason(e) : String((e && e.message) || e)) });
    });
  }

  /* The screen itself, for an ID string in hand (and for tests/render-snapshots.js). */
  cidShowCode(text) {
    const W = window.FoxyWallet;
    this.stageScreen('cashuId', {
      art: '', title: 'MY CASHU ID', qr: String(text),
      body: 'Another Foxy scans or pastes this to add you to their contacts and pay you. Each payment is locked to a new key only you can open.',
      above: 'SHARE',
      aboveGo: () => { if (!W || !W.share || !W.share(String(text))) this.toast('Sharing is not available here.', true); },
      button: 'DONE',
    });
  }

  /* PAID TO YOUR ID KEY: a delivery locked to the ID key itself, unblinded, which the phone does not sign for by itself
   * (08e-cashu-id.js `cidBare`). LEAVE IT, the default, drops it with nothing said; TAKE IT ANYWAY has the ID key sign for
   * this delivery alone and takes it. Closed with neither, it is asked again the next time Foxy reads it. */
  cidBareCard(v) {
    if (!v || !v.key) return;
    const W = window.FoxyWallet;
    const who = v.name || 'Someone';
    const leave = () => { if (W && W.cashuIdUnblinded) Promise.resolve(W.cashuIdUnblinded(v.key, false)).catch(() => {}); };
    const take = () => {
      if (!W || !W.cashuIdUnblinded) return;
      this.showMelt('Taking it\u2026');
      Promise.resolve(W.cashuIdUnblinded(v.key, true)).then((r) => {
        this.hideMelt();
        if (this.refreshBalance) this.refreshBalance();
        this.loadHistory();
        const st = String((r && r.state) || '');
        if (st === 'taken') this.toast('Taken. The mint can link this payment to your Cashu ID.');
        else if (st === 'gone' || st === 'seen') this.toast('That payment is no longer waiting.', true);
        else this.toast(String((r && r.why) || '') || 'That did not work.', true);
      }).catch((e) => {
        this.hideMelt();
        this.toast(W.reason ? W.reason(e) : String((e && e.message) || e), true);
      });
    };
    this.blockedCard('cidBare-' + v.key, {
      tone: 'warn', title: 'PAID TO YOUR ID KEY',
      reason: who + ' paid you without blinding the key. Taking it would let the mint link your payments together.',
      retry: 'LEAVE IT', go: leave,
      shut: { label: 'TAKE IT ANYWAY', pill: true, tap: take },
    });
  }

  /* A card with a field to paste a Cashu ID into, NEXT handing the text to `read`; CANCEL shuts it. Shared with the till's
   * (26p-till-tips.js, `tillIdPaste`) so the two stay the same card. */
  cidPasteCard(kind, read) {
    this.blockedCard(kind, {
      tone: 'ask', title: 'PASTE A CASHU ID',
      reason: 'The Cashu ID they shared from MY CASHU ID. It starts foxyid1.',
      field: { value: '', placeholder: 'foxyid1…', max: 400 },
      retry: 'NEXT', go: (text) => read(text),
      shut: { label: 'CANCEL' },
    });
  }

  /* ADD A CASHU ID and SCAN A CASHU ID, on the empty CONTACTS: the ID is read as a pasted or scanned one
   * is (`cidAddAsk`), which goes on to NAME THIS CONTACT?. */
  cidPasteAsk() { this.cidPasteCard('cidPaste', (text) => this.cidAddAsk(text)); }

  cidScanAsk() {
    const W = window.FoxyWallet;
    if (!W || !W.scan) return;
    Promise.resolve(W.scan('Scan a Cashu ID')).then((text) => { if (String(text || '').trim()) this.cidAddAsk(text); }).catch(() => {});
  }

  /* A Cashu ID scanned or pasted (`acceptTarget`): NAME THIS CONTACT?, or why not. */
  cidAddAsk(text) {
    const W = window.FoxyWallet;
    if (!W || !W.cashuIdCheck) return false;
    const t = String(text || '').trim();
    Promise.resolve(W.cashuIdCheck(t)).then((r) => {
      if (r.own) {
        this.blockedCard('cidOwn', {
          tone: 'warn', title: 'THIS IS YOUR CASHU ID',
          reason: 'Share it with someone else so they can add you and pay you.',
        });
        return;
      }
      this.cidNameAsk(t, r.name || '');
    }).catch((e) => {
      this.blockedCard('cidBad', {
        tone: 'warn', title: 'THAT WON’T WORK',
        reason: (W.reason ? W.reason(e) : String((e && e.message) || e)) || 'That is not a Cashu ID.',
        chip: 'Ask them to share it again.',
      });
    });
    return true;
  }

  /* The name card: a field, SAVE and CANCEL. An ID already a contact starts from its name, and saving renames it. */
  cidNameAsk(text, known) {
    this.blockedCard('cidName', {
      tone: 'ask', title: 'NAME THIS CONTACT?',
      reason: known ? 'You have this Cashu ID as ' + known + '. A new name replaces it.'
        : 'A Cashu ID from another Foxy. Give it a name to find it in your contacts.',
      field: { value: known || '', placeholder: 'Name', max: 40 },
      retry: 'SAVE',
      go: (name) => this.cidAddGo(text, name),
      shut: { label: 'CANCEL' },
    });
  }

  cidAddGo(text, name) {
    const W = window.FoxyWallet;
    const clean = String(name || '').trim();
    if (!clean) { this.toast('Give it a name first.', true); this.cidNameAsk(text, ''); return; }
    Promise.resolve(W.cashuIdAdd(text, clean)).then((c) => {
      this.setState({ contacts: (W.book && W.book()) || this.state.contacts });
      this.toast((c && c.name ? c.name : clean) + ' is in your contacts');
    }).catch((e) => this.toast(W.reason ? W.reason(e) : String((e && e.message) || e), true));
  }

  /* A contact that is a Cashu ID, tapped: SET AMOUNT for it, dollars first. */
  cidPayStart(c) {
    if (this.offlineNow && this.offlineNow()) { this.offlineNo('Paying a contact'); return; }
    this.setState(p => ({
      screen: 'amount', stack: p.stack.concat([p.screen]), flow: 'send',
      recipient: String(c.handle || ''), recipientKind: 'cashuid', recipientName: String(c.name || 'Cashu ID'),
      asset: '', network: '', amount: '', unit: 'USD', ctSearch: false,
      wallet: '', walletAuto: false, walletTapped: false, feeQ: null, cidBusy: false, cidErr: '',
    }));
  }

  // what the keypad says above the amount for a contact being paid
  cidAmountQuestion() { return 'How much to send to ' + (this.state.recipientName || 'them') + '?'; }

  /* NEXT on SET AMOUNT: in the balance the keypad is in (cents for dollars), and on to the confirmation. */
  cidNext() {
    const usd = !!(this.usdKeypad && this.usdKeypad());
    const amount = usd ? this.centsTyped() : this.wantedSats();
    if (!(amount > 0)) { this.toast('Type an amount first.', true); return; }
    this.setState(p => ({ screen: 'cidConfirm', stack: p.stack.concat([p.screen]), cidAmount: amount, cidUnit: usd ? 'usd' : 'sat', cidBusy: false, cidErr: '' }));
  }

  // the days a payment waits for its contact, from the wallet
  cidDays() {
    const W = window.FoxyWallet;
    const s = W && W.cashuIdLockSeconds ? Number(W.cashuIdLockSeconds()) : 30 * 86400;
    return Math.max(1, Math.round(s / 86400));
  }

  /* The confirmation (confirmSpec): to whom, from where, how it goes, and once, what happens if it is not collected. */
  cidSpec() {
    const s = this.state;
    const unit = s.cidUnit === 'usd' ? 'usd' : 'sat';
    const amount = Math.round(Number(s.cidAmount) || 0);
    const figure = unit === 'usd' ? { main: this.unitFigure(amount, 'usd'), sub: '' } : this.money(amount);
    const name = String(s.recipientName || 'them');
    const W = window.FoxyWallet;
    const at = (this.mintNameOf && W ? this.mintNameOf(W.mintUrl) : '') || 'THIS MINT';
    const days = this.cidDays();
    const rows = [
      this.cfRow('TO', name.toUpperCase()),
      this.cfRow('PAYING FROM', String(at).toUpperCase() + (unit === 'usd' ? ' · DOLLARS' : ''), { half: true }),
      this.cfRow('NETWORK', 'CASHU ID', { half: true }),
      // not a promise of when: their phone has to be listening, and the relays have to keep it (CASHU-ID.md)
      this.cfRow('GOES BY', 'NOSTR, SENT DAILY', { ink: 'var(--acc)', half: true }),
    ];
    if ((s.note || '').trim()) rows.push(this.cfRow('NOTE', (s.note || '').trim()));
    const back = { label: 'CANCEL', go: () => this.setState({ screen: 'home', stack: [], cidBusy: false, cidErr: '' }) };
    /* The keeper's 1m (2026-11-06), with the contact's name where a Lightning payment names its invoice: RECEIVER GETS, FEE
     * (this mint's for making the locked pieces, as the wallet counts it), PAYING, RECEIVER, and PAYING FROM's pill, which
     * opens nothing: a contact is paid from this mint. CANCEL is the X. */
    let fee = 0;
    try {
      const lack = (W && W.sendShortfall && amount > 0) ? W.sendShortfall(amount, { unit: unit, locked: true }) : null;
      fee = lack ? Math.max(0, Math.round(Number(lack.fee) || 0)) : 0;
    } catch (e) { fee = 0; }
    const fig = (n) => (unit === 'usd' ? this.unitFigure(n, 'usd') : this.money(n).main);
    const look = (sp) => (!this.cfPayLook ? sp : this.cfPayLook(Object.assign(sp, { close: back.go }), {
      gets: figure.main, fee: fig(fee), paying: fig(amount + fee), receiver: name.toUpperCase(),
      word: String(at).toUpperCase() + ' · ' + this.unitWord(unit), go: null,
    }));
    if (s.cidErr) {
      return look({
        title: 'CONFIRMATION', amountLabel: 'SENDING', amount: figure.main, amountSub: figure.sub, amountInk: '#FF5C5C', rows: rows,
        warn: s.cidErr, cta: 'TRY AGAIN', ctaTone: 'warn', go: () => this.cidSend(), secondary: back,
      });
    }
    return look({
      title: 'CONFIRMATION', amountLabel: 'SENDING', amount: figure.main, amountSub: figure.sub,
      // a copy goes to the seed's own recovery key once a relay has it (08e-cashu-id.js), so the words find it too
      subtitle: 'If ' + name + ' has not collected it in ' + days + ' days it comes back to you, here or wherever your words are restored.',
      rows: rows, secondary: back,
      // PAY, as every confirmation's button says (the keeper, 2026-11-06)
      cta: s.cidBusy ? 'SENDING…' : 'PAY ' + fig(amount + fee), ctaTone: 'go', ctaBusy: !!s.cidBusy,
      go: () => { if (!this.state.cidBusy) this.cidSend(); },
    });
  }

  /* SEND: locked to their one-time key and handed to the relays. A payment no relay took yet is in the outbox, and goes
   * as soon as one does; it is said so, and it is still this phone's money until they collect it or it comes back. */
  cidSend() {
    const W = window.FoxyWallet;
    const s = this.state;
    if (!W || !W.cashuIdPay || s.cidBusy) return;
    const name = String(s.recipientName || 'them');
    const unit = s.cidUnit === 'usd' ? 'usd' : 'sat';
    const amount = Math.round(Number(s.cidAmount) || 0);
    this.setState({ cidBusy: true, cidErr: '' });
    this.showMelt('Sending to ' + name + '…');
    Promise.resolve(W.cashuIdPay(String(s.recipient || ''), amount, { unit: unit, name: name, note: (s.note || '').trim() })).then((r) => {
      this.hideMelt();
      this.setState({ cidBusy: false, cidErr: '', note: '', noteDraft: '' });
      this._seenTx = this._seenTx || {};
      if (r && r.hash) this._seenTx[r.hash] = true;
      this.loadHistory();
      this.announcePayment({ dir: 'out', sats: unit === 'sat' ? amount : 0, unit: unit, amount: amount, hash: (r && r.hash) || 'cid-' + Date.now(), to: name, force: true });
      if (r && !r.sent) this.toast('It goes to ' + name + ' as soon as a relay will take it.', true);
    }).catch((e) => {
      this.hideMelt();
      this.setState({ cidBusy: false, cidErr: W.reason ? W.reason(e) : String((e && e.message) || e) });
    });
  }

  // an amount as the card says it: "3 sats", "1 sat", "$0.04"
  cidMoney(n, unit) {
    const v = Math.round(Number(n) || 0);
    if (unit === 'usd') return '$' + this.usd(v / 100);
    return this.group(v) + (v === 1 ? ' sat' : ' sats');
  }

  /* Payments to this ID at a mint this phone does not use, waiting for their receiver (08e-cashu-id.js, `cidForeign`): rows
   * for HISTORY, pending and in no balance, "From <name>", "At <mint> · tap to decide". Tapped, the card again. One not
   * answered goes back to its payer a day before its locktime. */
  cidWaitingRows() {
    const W = window.FoxyWallet;
    let list = [];
    try { list = (W && W.cashuIdWaiting) ? W.cashuIdWaiting() : []; } catch (e) { list = []; }
    const now = new Date();
    return list.map((o) => {
      const at = (this.mintNameOf && this.mintNameOf(o.mint)) || o.host || 'another mint';
      const usd = o.unit === 'usd';
      const row = {
        name: 'From ' + (o.name || 'a Cashu ID'), party: 'From ' + (o.name || 'a Cashu ID'), note: '',
        hash: 'cid-waiting-' + o.key, dir: 'in', sats: usd ? 0 : Math.round(Number(o.amount) || 0), fee: 0, rail: 'Cashu ID',
        time: this.txLabel ? this.txLabel(new Date(Number(o.at) || Date.now()), now) : '', atMs: Number(o.at) || 0,
        pending: true, cidWait: true, cidKey: o.key, cidLine: 'At ' + at + ' \u00b7 tap to decide', mint: o.mint, token: '',
      };
      if (usd) Object.assign(row, { unit: 'usd', amount: Math.round(Number(o.amount) || 0) });
      return row;
    });
  }

  /* A waiting row in HISTORY, tapped: its card again, as it was quoted. */
  cidOfferOpen(t) {
    const W = window.FoxyWallet;
    let list = [];
    try { list = (W && W.cashuIdWaiting) ? W.cashuIdWaiting() : []; } catch (e) { list = []; }
    const v = list.find((o) => o.key === (t && t.cidKey));
    if (!v) { this.toast('That payment is no longer waiting.', true); this.loadHistory(); return; }
    this.cidOfferCard(v);
  }

  /* PAID AT ANOTHER MINT: what came, where, and the three answers (08e-cashu-id.js `cidForeign`). BRING IT HOME carries the
   * fee it was quoted at under it, and what it lands as where that is another unit; too small, or a way home that could
   * not be quoted, it is grey with the reason. SEND IT BACK only where the payer proved who it is and this phone knows where
   * to send it. The tick remembers the answer for that mint. Closed with no answer, it waits in HISTORY. */
  cidOfferCard(v) {
    if (!v || !v.key) return;
    const unit = v.unit === 'usd' ? 'usd' : 'sat';
    const at = (this.mintNameOf && this.mintNameOf(v.mint)) || v.host || 'another mint';
    const who = v.name || 'A Cashu ID';
    let reason = who + ' sent you ' + this.cidMoney(v.amount, unit) + ' at ' + at + ', a mint you don\u2019t use.';
    if (v.others > 0) {
      reason += '\n' + (v.others === 1 ? 'One more payment waits there' : v.others + ' more payments wait there')
        + ', ' + this.cidMoney(v.total, unit) + ' in all: BRING IT HOME brings them together.';
    }
    const off = !(v.lands > 0);
    const lands = v.toUnit && v.toUnit !== unit ? ' \u00b7 lands as ' + this.cidMoney(v.lands, v.toUnit) : '';
    const answer = (choice) => (always) => this.cidDecideGo(v, choice, !!always);
    this.blockedCard('cidOffer-' + v.key, {
      tone: 'ask', title: 'PAID AT ANOTHER MINT', reason: reason,
      tick: { label: 'Always do this for ' + at },
      retry: 'BRING IT HOME', go: (words, always) => this.cidDecideGo(v, 'home', !!always),
      retryOff: off, retryNote: off ? (v.why || 'It cannot be brought home now.') : 'fee about ' + this.cidMoney(v.fee, unit) + lands,
      shut: { label: 'KEEP IT THERE', pill: true, tap: answer('keep') },
      pills: v.back ? [{ label: 'SEND IT BACK', tap: answer('back') }] : [],
      also: { label: 'DECIDE LATER' },
    });
  }

  /* The answer, given to the wallet (`cashuIdDecide`), and what became of it said. */
  cidDecideGo(v, choice, always) {
    const W = window.FoxyWallet;
    if (!W || !W.cashuIdDecide) return;
    const at = (this.mintNameOf && this.mintNameOf(v.mint)) || v.host || 'that mint';
    const who = v.name || 'them';
    this.showMelt(choice === 'home' ? 'Bringing it home\u2026' : choice === 'back' ? 'Sending it back to ' + who + '\u2026' : 'Taking it at ' + at + '\u2026');
    Promise.resolve(W.cashuIdDecide(v.key, choice, always)).then((r) => {
      this.hideMelt();
      if (this.refreshBalance) this.refreshBalance();
      this.loadHistory();
      const st = String((r && r.state) || '');
      const why = String((r && r.why) || '');
      if (st === 'taken' && choice === 'home') this.toast('It came home from ' + at + '.');
      else if (st === 'away') this.toast('It is yours at ' + at + ' and on its way home. Foxy finishes it when it can.', true);
      else if (st === 'there' && choice === 'back') this.toast('It could not be sent back' + (why ? ' (' + why + ')' : '') + '. It is yours at ' + at + '.', true);
      else if (st === 'there' || st === 'taken') this.toast('Kept at ' + at + '. It is one of your mints now.');
      else if (st === 'back') this.toast('Sent back to ' + who + '.');
      else if (st === 'gone' || st === 'seen') this.toast('That payment is no longer waiting.', true);
      else this.toast(why || 'That did not work. It is still waiting.', true);
    }).catch((e) => {
      this.hideMelt();
      this.toast(W.reason ? W.reason(e) : String((e && e.message) || e), true);
    });
  }

  /* SETTINGS > OTHER MINTS, only while an answer is remembered: the row (21-render-values.js). */
  cidChoiceRows(icon, shut) {
    const W = window.FoxyWallet;
    let list = [];
    try { list = (W && W.cashuIdChoices) ? W.cashuIdChoices() : []; } catch (e) { list = []; }
    if (!list.length) return [];
    return [{ label: 'OTHER MINTS', path: icon, tap: shut(() => this.cidChoicesCard()) }];
  }

  /* The remembered answers, one button each, tapped to forget: the next payment at that mint asks again. */
  cidChoicesCard() {
    const W = window.FoxyWallet;
    let list = [];
    try { list = (W && W.cashuIdChoices) ? W.cashuIdChoices() : []; } catch (e) { list = []; }
    if (!list.length) { this.toast('Nothing is remembered for other mints.'); return; }
    const said = { home: 'BRING IT HOME', keep: 'KEEP IT THERE', back: 'SEND IT BACK' };
    const forget = (host) => {
      W.cashuIdChoiceClear(host);
      this.toast(host ? host + ' asks again next time' : 'Every mint asks again next time');
      this.setState({ menuTick: (this.state.menuTick || 0) + 1 });
    };
    this.blockedCard('cidChoices', {
      tone: 'ask', title: 'OTHER MINTS',
      reason: 'What Foxy does by itself with a payment to your Cashu ID at a mint you don\u2019t use. Tap one to forget it: the next payment there asks again.',
      pills: list.map((c) => ({ label: c.host + ' \u00b7 ' + (said[c.choice] || c.choice), tap: () => forget(c.host) })),
      pillsFirst: true,
      also: list.length > 1 ? { label: 'FORGET ALL', tap: () => forget('') } : null,
    });
  }

  /* A payment to this phone's Cashu ID that every check on the phone has passed, while the mint swaps it: said at once,
   * as arriving and never as received. The money is not counted until the swap lands, and PAYMENT RECEIVED follows
   * then (`_onCashuIdPaid`). Three to six seconds sooner than that, which is the mint's check and swap over Tor. */
  cidArrivingSaid(v) {
    const unit = v && v.unit === 'usd' ? 'usd' : 'sat';
    const amount = Math.max(0, Math.round(Number(v && v.amount) || 0));
    if (!amount) return;
    const who = String((v && v.name) || '').trim();
    this.toast(this.stageMoney(amount, unit) + (who ? ' from ' + who : '') + ' is arriving');
  }

  /* On every return to the foreground (`inboxWake`): the phone closed the Cashu ID's inbox as Foxy went away. */
  cidWake() {
    const W = window.FoxyWallet;
    if (!W) return;
    // a payment taken in: the balance and the history read again, which raise PAYMENT RECEIVED as for any payment
    W._onCashuIdPaid = () => { this.refreshBalance(); this.loadHistory(); };
    // one checked on this phone and being swapped at the mint: said at once, as arriving (`cidArrivingSaid`)
    W._onCashuIdArriving = (v) => this.cidArrivingSaid(v);
    // a payment at a mint this phone does not use, waiting for an answer: the card, and its row in HISTORY
    W._onCashuIdOffer = (v) => { this.loadHistory(); this.cidOfferCard(v); };
    // a payment locked to the ID key itself, unblinded: asked, never signed for by itself
    W._onCashuIdUnblinded = (v) => this.cidBareCard(v);
    // (the listening opened again waits while a card's sheet is up: `cardAfter`)
    const listen = () => {
      try { if (W.cashuIdListen) Promise.resolve(W.cashuIdListen()).catch(() => {}); } catch (e) {}
      try { if (W.cashuIdDeliver) Promise.resolve(W.cashuIdDeliver()).catch(() => {}); } catch (e) {}
    };
    if (W.cardAfter) W.cardAfter(listen); else listen();
  }
