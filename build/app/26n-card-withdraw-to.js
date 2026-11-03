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
        console.log('[foxy] card: WITHDRAW TO ' + String(to).replace(/^https?:\/\//, '') + ' costs about ' + this.unitFigure(fee, w.unit));
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
    return 'This card is at ' + at + '. Any other mint costs a crossing by Lightning.';
  }

  /* The rows, in the list's own look (`row`, 27-render-mints-restore-backup.js): the card's mint first at NO FEE, then the others
   * the cheapest first, those still being asked after them, and those that cannot be reached last, greyed. */
  fcWdRows(row) {
    const w = this._fcWd;
    if (!w) return [];
    const strip = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const quotes = this.state.wdQuotes || {};
    const all = this.allMints ? this.allMints() : [];
    const used = this.tillMints ? this.tillMints() : all;
    const cardRow = all.find((m) => strip(m.url) === strip(w.card)) || { url: w.card, name: this.mintNameOf(w.card), host: strip(w.card), logo: '', tint: '#5A5A5A' };
    const q = (m) => quotes[String(m.url).replace(/\/+$/, '')] || { state: 'asking' };
    const order = (m) => { const x = q(m); return x.state === 'ok' ? 0 : x.state === 'asking' ? 1 : 2; };
    const others = used.filter((m) => strip(m.url) !== strip(w.card)).sort((a, b) => {
      const d = order(a) - order(b);
      if (d) return d;
      return order(a) === 0 ? (q(a).rank - q(b).rank) : 0;
    });
    const asLands = w.unit === 'usd' ? ' · AS BITCOIN' : '';
    return [Object.assign(row(cardRow, true), { text: 'NO FEE', tap: () => this.fcWdPick(cardRow.url) })]
      .concat(others.map((m) => {
        const x = q(m);
        const base = row(m, false);
        const text = x.state === 'ok' ? 'FEE ABOUT ' + this.unitFigure(x.fee, w.unit) + asLands
          : x.state === 'asking' ? 'CALCULATING…' : 'NOT AVAILABLE';
        return Object.assign(base, {
          text,
          dim: x.state === 'no' ? '0.4' : base.dim,
          ink: x.state === 'ok' ? 'var(--acc-ink)' : 'rgba(var(--ink-rgb),.45)',
          tap: () => this.fcWdPick(m.url),
        });
      }));
  }

  /* A row tapped: the card's own mint, or one whose crossing has been priced. Off the list, and on to the PIN (`go`). */
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
    this.setState((p) => ({ wdPick: false, wdQuotes: {}, screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1) }));
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
    this.showMelt('Moving it to ' + name + '…', 0, { mint: name });
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
      .then((plan) => W.moveRun(plan, () => {}, { visit: true }))
      .then((done) => {
        const back = String(W.mintUrl || '').replace(/\/+$/, '') !== from ? W.connect(from).then(null, () => null) : Promise.resolve();
        return back.then(() => done);
      })
      .then((done) => {
        this.hideMelt();
        this.refreshBalance();
        this.loadHistory();
        const sats = Math.round(Number(done && done.sats) || 0);
        this.toast('Moved ' + this.unitFigure(sats, 'sat') + ' to ' + name + '.');
      }, (e) => {
        this.hideMelt();
        this.refreshBalance();
        // back at the card's mint, unless the crossing was paid and its claim is still being made where the phone is
        if (String(W.mintUrl || '').replace(/\/+$/, '') !== from && !(e && e.movePaid)) W.connect(from).then(null, () => null);
        const why = W.reason ? W.reason(e) : String((e && e.message) || e);
        this.toast(e && e.movePaid
          ? 'It was paid to ' + name + ' and is still being collected there: ' + why
          : 'It is in this phone at ' + this.mintNameOf(from) + ', not moved to ' + name + ': ' + why, true);
      });
  }
