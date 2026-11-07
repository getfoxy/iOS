  /* ---- a card's WITHDRAW TO: which of this phone's mints all of it lands at -------------------------------------------
   *
   * WITHDRAW, ALL OF IT, on a phone that uses more than one mint (2026-11-03: "it should ask me which mint I want to withdraw it to,
   * showing the cheapest first"). Before anything comes off the card, the SWITCH MINT list, as the till's set list is drawn on it,
   * titled WITHDRAW TO: the card's own mint first, at NO FEE, where the money comes off as it always has; then each other mint this
   * phone uses (`tillMints`), with what the crossing there costs, asked of both mints the way a transfer between this phone's mints
   * is (`transferQuote`, `quoteOnly`: an invoice at the far mint and the card's mint's fee quote for it, nothing paid), the cheapest
   * first as the answers come in. A phone with one mint is asked nothing.
   *
   * Picked, the withdrawal runs as before, into this phone at the card's mint (`fcWithdrawRun`), and what came off then crosses by
   * Lightning to the mint picked (`fcWdCross`: `transferQuote` again, for what is in hand now, and `moveRun` as a visit), and the phone
   * comes back to the card's mint. A crossing that does not go leaves the money in this phone at the card's mint, and says so.
   * A dollar card's money crosses from the dollars as a transfer from dollars does (14-moving-between-mints.js), landing as bitcoin. */

  /* The question, where there is one to ask: true when the list is up (`go` runs once a mint is picked), false where there is
   * nothing to ask (one mint, no route, nothing on the card) and the withdrawal goes on to the card's own mint. */
  fcWdToAsk(go) {
    const W = this.fcW ? this.fcW() : window.FoxyWallet;
    const fc = this.state.fc;
    if (!W || !fc || !W.transferQuote) return false;
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const card = String(fc.mint || W.mintUrl || '').replace(/\/+$/, '');
    const others = (this.tillMints ? this.tillMints() : []).filter((m) => strip(m.url) !== strip(card));
    if (!others.length || this.offlineNow()) return false;
    const unit = this.fcUnit ? this.fcUnit() : 'sat';
    const amount = this.fcHeld ? this.fcHeld(fc, unit) : Math.round(Number(fc.balance) || 0);
    if (!(amount > 0)) return false;
    const run = (this._fcWdRun || 0) + 1;
    this._fcWdRun = run;
    this._fcWd = { run, go, unit, amount, card };
    const quotes = {};
    others.forEach((m) => { quotes[String(m.url).replace(/\/+$/, '')] = { state: 'asking' }; });
    console.log('[foxy] card: WITHDRAW TO, ' + (others.length + 1) + ' mints; asking ' + others.length + ' what the crossing costs');
    // through the one way into that list, which clears every other question it can be asking
    this.goSwitchMint({ wdPick: true, wdQuotes: quotes });
    others.forEach((m) => this.fcWdQuote(String(m.url).replace(/\/+$/, ''), run));
    return true;
  }

  /* What the card's money comes to in sats, for the far mint's invoice: sats as they are, cents at this phone's price. */
  fcWdLand(n, unit) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (unit !== 'usd') return v;
    const px = (this.px && this.px()) || 0;
    return px > 0 ? Math.floor(v / 100 / px * 1e8) : 0;
  }

  /* One other mint asked what the crossing there costs (`transferQuote`, nothing paid). Its row says it when it answers. */
  fcWdQuote(to, run) {
    const W = window.FoxyWallet;
    const w = this._fcWd;
    if (!W || !w || w.run !== run) return;
    const put = (q) => {
      if (!this._fcWd || this._fcWd.run !== run) return;
      this.setState((p) => ({ wdQuotes: Object.assign({}, p.wdQuotes || {}, { [to]: q }) }));
    };
    const land = this.fcWdLand(w.amount, w.unit);
    if (!(land > 0)) { put({ state: 'no', why: 'There is no price to work out what the dollars come to.' }); return; }
    Promise.resolve()
      .then(() => W.transferQuote(w.card, land, Object.assign({ to, quoteOnly: true }, w.unit === 'usd' ? { unit: 'usd' } : {})))
      .then((plan) => {
        // the fee in the card's own unit: sats over what lands, or the dollar quote's cents over what the invoice cost
        const fee = w.unit === 'usd' ? Math.max(0, Math.round(Number(plan.feeUnit) || 0)) : Math.max(0, Math.round(Number(plan.feeSats) || 0));
        const px = (this.px && this.px()) || 0;
        const rank = w.unit === 'usd' ? (px > 0 ? Math.round(fee / 100 / px * 1e8) : fee * 1000) : fee;
        console.log('[foxy] card: ' + (w.move ? 'TRANSFER TO ' : 'WITHDRAW TO ') + String(to).replace(/^https?:\/\//, '') + ' costs about ' + this.unitFigure(fee, w.unit));
        put({ state: 'ok', fee, rank });
      }, (e) => {
        put({ state: 'no', why: (W.reason ? W.reason(e) : String((e && e.message) || e)) });
      });
  }

  // the line under the title
  fcWdLine() {
    const w = this._fcWd;
    const fc = this.state.fc;
    const at = this.mintNameOf((w && w.card) || (fc && fc.mint) || '');
    return 'This card is at ' + at + '. Other mints cost a Lightning fee.';
  }

  /* The rows, in the list's tiles (`row`, 27-render-mints-restore-backup.js): the card's mint first with no line under its rule, then
   * the others the cheapest first, those still being asked after them, and those that cannot be reached last, greyed. Under each
   * other's rule what the crossing costs (FEE $0.05), CALCULATING… while it is asked, or NOT AVAILABLE. A tap picks one, the
   * tick on it (`fcWdSel`); NEXT takes it (`fcListNext`). Nothing picked, the card's own mint is. */
  fcWdRows(row) {
    const w = this._fcWd;
    if (!w) return [];
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const quotes = this.state.wdQuotes || {};
    const all = this.allMints ? this.allMints() : [];
    const used = this.tillMints ? this.tillMints() : all;
    const sel = strip(this.state.mintSel || w.card);
    const cardRow = all.find((m) => strip(m.url) === strip(w.card)) || { url: w.card, name: this.mintNameOf(w.card), host: strip(w.card), logo: '', tint: '#5A5A5A' };
    const q = (m) => quotes[String(m.url).replace(/\/+$/, '')] || { state: 'asking' };
    const order = (m) => { const x = q(m); return x.state === 'ok' ? 0 : x.state === 'asking' ? 1 : 2; };
    const others = used.filter((m) => strip(m.url) !== strip(w.card)).sort((a, b) => {
      const d = order(a) - order(b);
      if (d) return d;
      return order(a) === 0 ? (q(a).rank - q(b).rank) : 0;
    });
    const none = { lineBal: false, lineWait: false, lineFee: false, fee: '', feeNote: '', feeNoteShown: false, wait: '' };
    return [Object.assign(row(cardRow, sel === strip(w.card)), none, { text: 'NO FEE', tap: () => this.fcWdSel(cardRow.url) })]
      .concat(others.map((m) => {
        const base = row(m, sel === strip(m.url));
        return Object.assign(base, this.fcFeeLine(q(m), w.unit, base), { tap: () => this.fcWdSel(m.url) });
      }));
  }

  /* The line under a tile's rule on a card's WITHDRAW TO and TRANSFER TO, from that mint's answer (`wdQuotes`): FEE $0.05 once it
   * has answered, CALCULATING… while it is asked, NOT AVAILABLE (greyed) where it could not be, and nothing where it was not asked.
   * The fee in dollars first: cents as they are, sats at this phone's price, or in sats where there is none. A dollar card's money
   * lands as bitcoin, said smaller after the fee so the line fits a small phone; not where it stays dollars (`keepsDollars`: a card's
   * TRANSFER to a mint that issues dollars, 08a-flashcard.js `cardTransferQuote`). */
  fcFeeLine(x, unit, base, keepsDollars) {
    const none = { lineBal: false, lineWait: false, lineFee: false, fee: '', feeNote: '', feeNoteShown: false, wait: '', text: '' };
    if (!x) return none;
    const px = (this.px && this.px()) || 0;
    const dol = (v) => (v > 0 && v < 0.005 ? '< $0.01' : '$' + (this.usd ? this.usd(v) : v.toFixed(2)));
    const fee = Math.round(Number(x.fee) || 0);
    const words = !(fee > 0) ? 'NO FEE'
      : 'FEE ' + (unit === 'usd' ? dol(fee / 100) : px > 0 ? dol(fee / 1e8 * px) : this.unitFigure(fee, 'sat'));
    const note = (unit === 'usd' && !keepsDollars) ? 'AS BITCOIN' : '';
    if (x.state === 'ok') {
      return Object.assign(none, { lineFee: true, fee: words, feeNote: note, feeNoteShown: !!note, text: words + (note ? ' \u00b7 ' + note : ''),
        ink: 'var(--acc-ink)' });
    }
    const wait = x.state === 'asking' ? 'CALCULATING\u2026' : 'NOT AVAILABLE';
    return Object.assign(none, { lineWait: true, wait, text: wait, ink: 'rgba(var(--ink-rgb),.45)',
      dim: x.state === 'no' ? '0.4' : ((base && base.dim) || '1') });
  }

  /* A card's TRANSFER: the list of mints, TRANSFER TO, each other mint asked what the move there costs as WITHDRAW TO asks
   * (`fcWdQuote`, an invoice there and the card's mint's quote for it, nothing paid), CALCULATING… meanwhile and NOT AVAILABLE
   * where it does not answer. A card with nothing on it moves for nothing and asks nothing, and nothing is asked offline. Only the
   * mints this phone uses are asked (`tillMints`, as WITHDRAW TO asks): a quote is not made at a mint it has never used. */
  fcMoveAsk() {
    const W = window.FoxyWallet;
    const fc = this.state.fc;
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const card = String((fc && fc.mint) || (W && W.mintUrl) || '').replace(/\/+$/, '');
    // the unit and the amount the move itself will take (26f-flashcard.js, `fcSwitchPick`)
    const u0 = fc && fc.unit === 'usd' ? 'usd' : 'sat';
    const unit = (fc && fc.bal && !(fc.bal[u0] > 0) && fc.bal[u0 === 'usd' ? 'sat' : 'usd'] > 0) ? (u0 === 'usd' ? 'sat' : 'usd') : u0;
    const amount = Math.max(0, Math.round(Number(fc ? (fc.bal ? fc.bal[unit] : fc.balance) : 0) || 0));
    const others = (this.tillMints ? this.tillMints() : []).filter((m) => strip(m.url) !== strip(card));
    const ask = !!(W && W.transferQuote) && amount > 0 && others.length > 0 && !this.offlineNow();
    const quotes = {};
    let run = 0;
    if (ask) {
      run = (this._fcWdRun || 0) + 1;
      this._fcWdRun = run;
      this._fcWd = { run, go: null, unit, amount, card, move: true };
      others.forEach((m) => { quotes[String(m.url).replace(/\/+$/, '')] = { state: 'asking' }; });
      console.log('[foxy] card: TRANSFER TO, asking ' + others.length + ' mints what the move costs');
    }
    // through the one way into that list, which clears every other question it can be asking
    this.goSwitchMint({ fcPick: true, wdQuotes: quotes });
    if (ask) others.forEach((m) => this.fcWdQuote(String(m.url).replace(/\/+$/, ''), run));
  }

  /* TRANSFER TO's tiles (27-render-mints-restore-backup.js, `row`): the card's own mint first, ticked while no other is picked, with no
   * line; then every other, its fee under the rule (`fcFeeLine`). A tap picks one (`mintSel`), except one that did not answer, which
   * says why; NEXT moves the card (`fcListNext`). */
  fcMoveRows(row) {
    const W = window.FoxyWallet;
    const s = this.state;
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const all = this.allMints ? this.allMints() : [];
    const at = strip(s.fc && s.fc.mint);
    const sel = s.mintSel ? strip(s.mintSel) : at;
    const quotes = s.wdQuotes || {};
    const own = all.find((m) => strip(m.url) === at) || { url: String((s.fc && s.fc.mint) || ''), name: this.mintNameOf(s.fc && s.fc.mint), host: at, logo: '', tint: '#5A5A5A' };
    return [own].concat(all.filter((m) => strip(m.url) !== at)).map((m) => {
      const r = row(m, strip(m.url) === sel);
      const mine = strip(m.url) === at;
      const x = mine ? null : quotes[String(m.url).replace(/\/+$/, '')];
      const pick = () => {
        if (x && x.state === 'no') { this.toast(String(x.why || (this.mintNameOf(m.url) + ' cannot be reached now.')), true); return; }
        this.setState({ mintSel: mine ? '' : String(m.url).replace(/\/+$/, '') });
      };
      // a dollar card moved to a mint known to issue dollars stays dollars there: no AS BITCOIN under it
      let units = [];
      try { units = (W && typeof W.mintUnits === 'function') ? (W.mintUnits(m.url) || []) : []; } catch (e) { units = []; }
      return Object.assign(r, this.fcFeeLine(x, (this._fcWd && this._fcWd.unit) || 'sat', r, units.indexOf('usd') >= 0),
        { tap: this.mintReachable(m.url) ? pick : r.tap });
    });
  }

  /* A tile tapped on WITHDRAW TO: the card's own mint, or one whose crossing has been priced, is picked (the tick moves to it); one
   * still being asked, or that cannot be reached, says so and is not. */
  fcWdSel(url) {
    const w = this._fcWd;
    if (!w || !this.state.wdPick) return;
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const own = strip(url) === strip(w.card);
    const x = own ? { state: 'ok' } : ((this.state.wdQuotes || {})[String(url).replace(/\/+$/, '')] || { state: 'asking' });
    if (x.state === 'asking') { this.toast('Still asking ' + this.mintNameOf(url) + ' what it costs.', true); return; }
    if (x.state === 'no') { this.toast(String(x.why || (this.mintNameOf(url) + ' cannot be reached now.')), true); return; }
    this.setState({ mintSel: own ? '' : String(url).replace(/\/+$/, '') });
  }

  /* NEXT under a card's WITHDRAW TO and TRANSFER TO: on with the mint picked. WITHDRAW TO always has one (the card's own, until
   * another is picked); TRANSFER TO needs another mint than the card's. */
  fcListNextOn() {
    const s = this.state;
    if (s.wdPick) return !!this._fcWd;
    if (!s.fcPick) return false;
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return !!s.mintSel && strip(s.mintSel) !== strip(s.fc && s.fc.mint);
  }

  fcListNext() {
    const s = this.state;
    if (s.wdPick) {
      const w = this._fcWd;
      if (w) this.fcWdPick(s.mintSel || w.card);
      return;
    }
    if (!s.fcPick) return;
    if (!this.fcListNextOn()) {
      this.toast('This card is at ' + this.mintNameOf(s.fc && s.fc.mint) + '. Pick the mint to move it to.', true);
      return;
    }
    this.fcSwitchPick(s.mintSel);
  }

  /* NEXT with a mint picked (`fcListNext`): the card's own mint, or one whose crossing has been priced. Off the list, and on to the
   * PIN (`go`). */
  fcWdPick(url) {
    const w = this._fcWd;
    if (!w || !this.state.wdPick) return;
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const own = strip(url) === strip(w.card);
    const x = own ? { state: 'ok' } : ((this.state.wdQuotes || {})[String(url).replace(/\/+$/, '')] || { state: 'asking' });
    if (x.state === 'asking') { this.toast('Still asking ' + this.mintNameOf(url) + ' what it costs.', true); return; }
    if (x.state === 'no') { this.toast(String(x.why || (this.mintNameOf(url) + ' cannot be reached now.')), true); return; }
    this._fcWdTo = own ? '' : String(url).replace(/\/+$/, '');
    this._fcWdFee = own ? 0 : Math.round(Number(x.fee) || 0);
    console.log('[foxy] card: WITHDRAW TO ' + strip(url) + (own ? ', the card’s own mint' : ', a crossing of about ' + this.unitFigure(this._fcWdFee, w.unit)));
    const go = w.go;
    this.setState((p) => ({ wdPick: false, wdQuotes: {}, mintSel: '', screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1) }));
    if (go) go();
  }

  /* After the withdrawal: what came off (`got`, in `unit`) crosses to the mint picked, and the phone comes back to the card's mint.
   * Nothing where the card's own mint was picked. The crossing is quoted again for what is in hand, a little under where the fee
   * came out higher than the list said. */
  fcWdCross(got, unit) {
    const W = window.FoxyWallet;
    const to = this._fcWdTo;
    const w = /** @type {any} */ (this._fcWd || {});
    this._fcWdTo = '';
    if (!W || !to || !(got > 0)) return;
    const from = String(w.card || W.mintUrl || '').replace(/\/+$/, '');
    const name = this.mintNameOf(to);
    const u = unit === 'usd' ? 'usd' : 'sat';
    const how = u === 'usd' ? { to, unit: 'usd' } : { to };
    const fee0 = Math.max(0, Math.round(Number(this._fcWdFee) || 0));
    // the fox, the figure following the quote and the move's own stages (26r-fox-wait.js); the melt loader where it cannot be drawn
    const fox = !!(this.foxUp && this.foxUp('wdMove', 'move', { forMs: this.MELT_PATIENCE_MS }));
    if (!fox) this.showMelt('Moving it to ' + name + '…', 0, { mint: name });
    const ask = (n, left) => {
      if (!(n > 0)) return Promise.reject(new Error('What came off the card is too little to cross: the fees would take it all.'));
      return W.transferQuote(from, n, how).then(null, (e) => {
        if (!(left > 0)) throw e;
        const fits = Math.round(Number(e && e.foxyFits) || 0);
        if (u === 'sat' && fits > 0 && fits < n) return ask(fits, left - 1);
        if (e && /costs up to/.test(String(e.message || ''))) return ask(Math.floor(n * 0.97), left - 1);
        throw e;
      });
    };
    const first = this.fcWdLand(Math.max(0, got - fee0), u);
    console.log('[foxy] card: WITHDRAW TO ' + String(to).replace(/^https?:\/\//, '') + ': ' + this.unitFigure(got, u) + ' off the card cross from '
      + String(from).replace(/^https?:\/\//, ''));
    ask(first, 3)
      .then((plan) => {
        if (fox) this.foxStep('wdMove', 'answered');
        return W.moveRun(plan, fox ? this.foxHears('wdMove') : () => {}, { visit: true });
      })
      .then((done) => {
        // saved there again only where the person chose it (09-melt-paste-switch.js `connectBack`)
        const back = String(W.mintUrl || '').replace(/\/+$/, '') !== from ? (this.connectBack ? this.connectBack(from) : W.connect(from)).then(null, () => null) : Promise.resolve();
        return back.then(() => done);
      })
      .then((done) => {
        if (fox) this.foxEnd('wdMove', true); else this.hideMelt();
        this.refreshBalance();
        this.loadHistory();
        const sats = Math.round(Number(done && done.sats) || 0);
        this.toast('Moved ' + this.unitFigure(sats, 'sat') + ' to ' + name + '.');
      }, (e) => {
        if (fox) this.foxEnd('wdMove', false); else this.hideMelt();
        this.refreshBalance();
        // back at the card's mint, unless the crossing was paid and its claim is still being made where the phone is
        if (String(W.mintUrl || '').replace(/\/+$/, '') !== from && !(e && e.movePaid)) (this.connectBack ? this.connectBack(from) : W.connect(from)).then(null, () => null);
        const why = W.reason ? W.reason(e) : String((e && e.message) || e);
        this.toast(e && e.movePaid
          ? 'It was paid to ' + name + ' and is still being collected there: ' + why
          : 'It is in this phone at ' + this.mintNameOf(from) + ', not moved to ' + name + ': ' + why, true);
      });
  }
