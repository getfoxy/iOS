  /* ---- PAY FROM: which of this phone's balances a payment is made from -------
   *
   * Decided 2026-10-31: with enough at more than one mint, a payment shows
   * the balances that could make it before its confirmation, the cheapest
   * first and chosen, and one at the mint that asked for it as the cheapest.
   *
   * A source is one mint's pile in one unit: every mint's sats, and the
   * dollars of a mint that issues both. It is offered when it covers the
   * amount and the fee of the way it would pay. Two or more, and the screen is
   * shown (`renderCurrency`, its rows); one, and it pays with nothing asked;
   * none, and the confirmation says NOT ENOUGH as it always has. Two sources
   * are never put together for one payment.
   *
   * How a source pays, by what is being paid:
   *
   *   a Lightning invoice or address .. each source's own melt quote, asked
   *     with the phone left where it is (`quoteFeeAt`, or `quoteFee` at this
   *     mint); paid from another mint on a visit, and home again whichever
   *     way it ends (03-send.js `startSendNow`, `crossComeHome`).
   *   a Cashu request ................. the request's own mint, with no fee;
   *     another mint's sats by the crossing a tap makes (`transferQuote`).
   *   a tap at another mint ........... their mint's sats, with no fee; this
   *     phone's own mint and any other by the crossing (26d-tap.js).
   *   a bitcoin address ............... every mint's sats; the fee is asked
   *     after the choice, on a visit to the mint chosen (26b-onchain.js).
   *   a Cashu request, short in its unit .. the other balance at the mint this
   *     phone is on, by the SWAP screen's own swap there (`pfSwapSource`),
   *     made under the same PAY as the payment (`pfSwapThenPay`).
   *
   * Where every pile that could pay is at the mint this phone is on, nothing
   * here changes a screen: CURRENCY and WALLET ask between its two balances as
   * before. With no route only the request's own mint can pay, and nothing
   * crosses. A card is never a source: it pays from its own screen.
   *
   * Every mint that covers the amount is asked for a quote before anything is chosen, with the same invoice (or, for a
   * request, a mint quote at the request's mint for each crossing): mints that compared notes could tie the person's
   * holdings at them together. Left so on purpose until it is decided (attack 2026-11-01, P).
   *
   * State: `payFromFlow` ('send', 'req', 'tap', 'oc'), `payFromList` (the
   * tiles, cheapest first), `payFromPick` (the tile chosen), `payFromAsk` (the
   * question), and once chosen `payMint` and `payUnit` beside `wallet`, which
   * stays the unit `walletNow` reads at this mint. All cleared when the flow
   * ends (`pfTidy`). */

  /* A mint as the wallet writes one (`canonicalMint`): small letters in the scheme and host, no default port, no slash at
   * the end. Only the slash went before, so a request naming its mint in capitals was compared with `!==` against the
   * pile of the same mint and offered as somewhere else, with a crossing's fee. */
  pfMint(u) {
    const W = window.FoxyWallet;
    if (W && W.canonicalMint) return W.canonicalMint(u);
    const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(String(u || '').trim());
    if (!m) return String(u || '').trim().replace(/\/+$/, '');
    const scheme = m[1].toLowerCase();
    const port = scheme === 'https' ? ':443' : ':80';
    let host = m[2].toLowerCase();
    if (host.slice(-port.length) === port) host = host.slice(0, -port.length);
    // and no dot at the end of the name, as the wallet writes it
    host = host.replace(/\.+(?=(:\d+)?$)/, '');
    return scheme + '://' + host + (m[3] || '').replace(/\/+$/, '');
  }

  /* The mint this phone is on now. */
  pfHere() { const W = window.FoxyWallet; return this.pfMint(W && W.mintUrl); }

  /* The mint this phone was on when the question was asked, which a visit does not change. */
  pfHome() { return (this._pf && this._pf.home) || this.pfHere(); }

  pfKey(mint, unit) { return this.pfMint(mint) + '|' + (unit === 'usd' ? 'usd' : 'sat'); }

  /* A mint's name as a tile and a row write it. */
  pfName(mint) {
    const m = this.pfMint(mint);
    return String(this.mintNameOf(m) || m.replace(/^https?:\/\//, '') || 'THIS MINT').toUpperCase();
  }

  /* "FORGE · BITCOIN": the mint and the balance at it, for PAYING FROM. */
  pfLabel(mint, unit) { return this.pfName(mint) + ' · ' + this.unitWord(unit); }

  /* Every pile this phone holds something in, sats and dollars: [{ mint, unit, have }]. */
  pfPiles() {
    const W = window.FoxyWallet;
    let all = [];
    try { all = (W && W.balances) ? W.balances() : []; } catch (e) { all = []; }
    // a test mint's ecash is worth nothing: it is never a balance to pay from (decided)
    return (Array.isArray(all) ? all : []).filter((b) => b && (b.unit === 'sat' || b.unit === 'usd') && Number(b.amount) > 0
      && String(b.mint || '').toLowerCase().indexOf('testnut.cashu.space') < 0)
      .map((b) => ({ mint: this.pfMint(b.mint), unit: b.unit, have: Math.round(Number(b.amount) || 0) }));
  }

  /* Does `have` in `unit` cover `sats` on its face, before any fee? Dollars at this phone's price with a tenth to spare,
   * since a mint's rate is not the market's; with no price, any dollars at all, and the mint's quote says. */
  pfFace(have, unit, sats) {
    if (unit !== 'usd') return have >= sats;
    const r = this.satUsd ? Number(this.satUsd()) || 0 : 0;
    if (!(r > 0)) return have > 0;
    return have * 1.1 >= sats * r * 100;
  }

  /* A tile, before anything is known of what it costs: `ok` null while asked, true offered, false short. */
  pfEntry(src, more) {
    return Object.assign({ key: this.pfKey(src.mint, src.unit), mint: src.mint, unit: src.unit === 'usd' ? 'usd' : 'sat',
      have: src.have, cost: null, fee: null, ok: null, why: '', tag: '', note: '', rank: 0, pref: false }, more || {});
  }

  /* Cheapest first: those offered by what their fee is worth in sats, the one at the mint asked first among equals
   * (`pref`), then those still being asked, then those that cannot pay. */
  pfRanked(list) {
    const band = (e) => (e.ok === true ? 0 : e.ok === null ? 1 : 2);
    return list.map((e, i) => ({ e, i })).sort((a, b) => (band(a.e) - band(b.e))
      || (a.e.ok === true ? (a.e.rank - b.e.rank) || ((b.e.pref ? 1 : 0) - (a.e.pref ? 1 : 0)) : 0)
      || (a.i - b.i)).map((x) => x.e);
  }

  pfCheapest(list) {
    const first = (list || []).filter((e) => e.ok === true)[0];
    return first ? first.key : '';
  }

  pfList() { return this.state.payFromList || []; }

  pfFull(key) { return (this._pf && this._pf.full && this._pf.full[key]) || null; }

  /* The tile the payment was given to (`payMint`, `payUnit`). */
  pfChosen() {
    const s = this.state;
    if (!s.payMint) return null;
    const key = this.pfKey(s.payMint, s.payUnit);
    return this.pfList().filter((e) => e.key === key)[0] || null;
  }

  /* More than one source for this flow's payment that is not short: the confirmation offers PAY FROM to change it. */
  pfMany(flow) {
    const s = this.state;
    return s.payFromFlow === flow && this.pfList().filter((e) => e.ok !== false).length >= 2;
  }

  /* Is this flow's payment made from another mint than the one the phone was on when it was asked? */
  pfAway(flow) {
    const s = this.state;
    if (!s.payMint || (flow && s.payFromFlow !== flow)) return false;
    return this.pfMint(s.payMint) !== this.pfHome();
  }

  /* PAY FROM for `flow`, with the sources in `list`.
   *
   * `o.quote(entry)` asks what a source costs: a promise of { cost, fee, ok, why, tag, rank, full }, or nothing where the
   * entry says already. Every source is asked at once, and each tile fills in as its answer lands. `o.go(entry, shown)`
   * pays from the one chosen; `o.none()` is where none can pay after all; `o.cancel()` the way out. `o.show` puts the screen
   * up; without it there is one source, and the caller pays from it. */
  pfOpen(flow, list, o) {
    const run = (this._pfRun || 0) + 1;
    this._pfRun = run;
    this._pf = { flow: flow, run: run, home: this.pfHere(), full: {}, quote: o.quote || null, go: o.go,
      none: o.none || null, cancel: o.cancel || (() => this.setState({ screen: 'home', stack: [] })) };
    const ranked = this.pfRanked(list);
    const patch = Object.assign({ payFromFlow: flow, payFromList: ranked, payFromAsk: o.ask || '', payFromTapped: false,
      payFromReopen: false, payFromPick: this.pfCheapest(ranked) }, o.patch || {});
    console.log('[foxy] pay from: ' + list.length + ' balance' + (list.length === 1 ? '' : 's') + ' could pay this ('
      + list.map((e) => this.pfName(e.mint).toLowerCase() + ' ' + e.unit).join(', ') + ')' + (o.show ? '; asking which' : ''));
    if (o.show) this.setState((p) => Object.assign(patch, { screen: 'payFrom', stack: p.stack.concat([p.screen]) }));
    else this.setState(patch);
    list.forEach((e) => { if (e.ok === null) this.pfAsk(e, run); });
    this.pfSettled(run);
  }

  /* What one source costs, asked of its mint, and its tile filled in when the answer lands. */
  pfAsk(e, run) {
    const pf = this._pf;
    const W = window.FoxyWallet;
    if (!pf || !pf.quote) return;
    let asked = null;
    try { asked = pf.quote(e); } catch (x) { asked = Promise.reject(x); }
    if (!asked || typeof asked.then !== 'function') return;
    asked.then((r) => this.pfIn(run, e.key, r || { ok: false }), (x) => {
      const why = W && W.reason ? W.reason(x) : String((x && x.message) || x);
      const short = (x && x.foxyHave != null) || /not enough|isn.t enough|you hold|short/i.test(why);
      console.log('[foxy] pay from: ' + this.pfName(e.mint).toLowerCase() + ' ' + e.unit + ' cannot pay this: ' + why);
      this.pfIn(run, e.key, { ok: false, why: why, tag: short ? 'NOT ENOUGH' : 'NOT AVAILABLE' });
    });
  }

  /* One source's answer, as it lands. */
  pfIn(run, key, r) {
    const pf = this._pf;
    if (!pf || pf.run !== run || run !== this._pfRun) return;
    if (r.full) pf.full[key] = r.full;
    const list = this.pfList().map((e) => (e.key !== key ? e : Object.assign({}, e, {
      cost: r.cost != null ? r.cost : e.cost, fee: r.fee != null ? r.fee : e.fee,
      ok: r.ok === true, why: r.ok === true ? '' : String(r.why || ''),
      tag: r.ok === true ? '' : String(r.tag || 'NOT ENOUGH'), rank: r.rank != null ? r.rank : e.rank,
    })));
    const ranked = this.pfRanked(list);
    const s = this.state;
    const patch = { payFromList: ranked };
    // the cheapest stays chosen until the person picks one, and a pick that turned out short is no pick
    const picked = ranked.filter((e) => e.key === s.payFromPick)[0];
    if (!s.payFromTapped || !picked || picked.ok === false) patch.payFromPick = this.pfCheapest(ranked) || (picked && picked.ok !== false ? picked.key : '');
    this.setState(patch);
    this.pfSettled(run);
  }

  /* Every source answered, on a screen the person has not touched: with one offered after all it pays with nothing asked,
   * and with none the payment goes on as it would have with no question (`o.none`), to say NOT ENOUGH. */
  pfSettled(run) {
    const pf = this._pf;
    const s = this.state;
    if (!pf || pf.run !== run || s.screen !== 'payFrom' || s.payFromReopen || s.payFromTapped) return;
    const list = this.pfList();
    if (list.some((e) => e.ok === null)) return;
    const offered = list.filter((e) => e.ok === true);
    if (offered.length > 1) return;
    if (offered.length === 1) {
      console.log('[foxy] pay from: only ' + this.pfName(offered[0].mint).toLowerCase() + ' ' + offered[0].unit + ' covers it with its fee; paying from it');
      pf.go(offered[0], true);
      return;
    }
    console.log('[foxy] pay from: none of them covers it with its fee');
    if (pf.none) pf.none(); else pf.cancel();
  }

  /* A tile tapped: chosen, unless it cannot pay or is still being asked. */
  pfTap(key) {
    const e = this.pfList().filter((x) => x.key === key)[0];
    if (!e) return;
    if (e.ok === null) { this.toast('Still asking ' + this.pfName(e.mint) + ' what it costs.', true); return; }
    if (e.ok === false) { this.toast(e.why || 'That balance cannot cover this payment.', true); return; }
    this.setState({ payFromPick: key, payFromTapped: true });
  }

  /* NEXT: the payment, from the tile chosen. */
  pfNext() {
    const s = this.state;
    const e = this.pfList().filter((x) => x.key === s.payFromPick)[0];
    if (!e || e.ok !== true || !this._pf) return;
    console.log('[foxy] pay from: ' + this.pfName(e.mint).toLowerCase() + ' ' + e.unit + ' chosen');
    this._pf.go(e, true);
  }

  /* Back: to the confirmation when it was opened from there, and out of the payment when it came first. */
  pfBack() {
    if (this.state.payFromReopen || !this._pf) { this.back(); return; }
    this._pf.cancel();
  }

  pfClose() {
    if (this._pf) { this._pf.cancel(); return; }
    this.setState({ screen: 'home', stack: [] });
  }

  /* What a tile says it costs: the whole of it in its own unit, "no fee" where there is none. */
  pfCostText(e) {
    if (e.ok === null) return 'CALCULATING…';
    if (e.ok === false) return '';
    if (e.swap) return this.pfSwapText(e, this.pfFull(e.key));
    if (e.cost == null) return e.note || '';
    const fig = this.unitFigure(e.cost, e.unit);
    return 'Costs ' + fig + (Number(e.fee) === 0 ? ' · no fee' : '');
  }

  /* The tiles, in the CURRENCY screen's looks (`renderCurrency`): the one chosen in fur (orange), every other grey, whether
   * it is still being asked, offered or short (decided); its own sign in the badge; CHEAPEST on the first once every mint
   * has answered. */
  pfRows(LOOK, SHADOW) {
    const s = this.state;
    const list = this.pfList();
    const offered = list.filter((e) => e.ok === true);
    const known = list.every((e) => e.ok !== null) && offered.length > 1 && offered.every((e) => e.cost != null);
    const best = known ? offered[0].key : '';
    return list.map((e) => {
      const short = e.ok === false, asking = e.ok === null;
      const chosen = e.key === s.payFromPick && !short;
      const look = Object.assign({}, chosen ? LOOK.sat : LOOK.grey);
      return Object.assign(look, {
        key: e.key, sym: LOOK[e.unit === 'usd' ? 'usd' : 'sat'].sym, name: this.pfName(e.mint),
        unitLine: this.unitWord(e.unit) + ' · ' + this.unitFigure(e.have, e.unit),
        cost: this.pfCostText(e), costShown: !short,
        tag: short ? (e.tag || 'NOT ENOUGH') : '', tagShown: short,
        bestShown: e.key === best,
        outline: chosen ? '3px solid rgba(255,255,255,.9)' : 'none',
        shadow: short ? 'none' : SHADOW,
        cursor: (short || asking) ? 'default' : 'pointer',
        opacity: asking ? '.8' : '1',
        tap: () => this.pfTap(e.key),
      });
    });
  }

  pfFoot() {
    const s = this.state;
    const list = this.pfList();
    if (s.payFromFlow === 'oc') return 'One balance pays. Its mint says the fee on the next screen.';
    if (list.length && list.every((e) => e.ok === null)) return 'Asking each mint what it costs.';
    return 'One balance pays. The cheapest is first.';
  }

  /* NEXT's look: the accent while the tile chosen can pay, grey while it cannot be told. */
  pfNextOn() {
    const s = this.state;
    const e = this.pfList().filter((x) => x.key === s.payFromPick)[0];
    return !!(e && e.ok === true);
  }

  /* Called on every update (`syncSend`): a payment's choice let go once its flow is over, and a visit for a payout on
   * chain ended once its screens are left (`pfOcHome`). */
  pfTidy() {
    const s = this.state;
    const sc = s.screen;
    const SEND = ['payFrom', 'sendConfirm', 'sendDone', 'walletPick', 'currency'];
    if (SEND.indexOf(sc) < 0) this._pfFor = null;
    if (this._ocVisit && ['ocConfirm', 'payFrom'].indexOf(sc) < 0 && !s.ocBusy) this.pfOcHome();
    const f = s.payFromFlow;
    if (!f) return;
    const keep = { send: SEND, req: ['payFrom', 'reqOffer', 'sendDone', 'crossConfirm'], tap: ['payFrom'], oc: ['payFrom', 'ocConfirm'] };
    if ((keep[f] || []).indexOf(sc) >= 0) return;
    // a payment on its way keeps what it was made from until it ends
    if (f === 'send' && this._sendRun) return;
    if (f === 'req' && (s.reqBusy || s.reqSwapping)) return;
    if (f === 'oc' && s.ocBusy) return;
    this._pf = null;
    this._pfRun = (this._pfRun || 0) + 1;
    this.setState({ payFromFlow: '', payFromList: null, payFromPick: '', payFromAsk: '', payFromTapped: false, payFromReopen: false,
      payMint: '', payUnit: '' });
  }

  // ---- a Lightning payment ----

  /* PAY FROM before a Lightning payment's confirmation. Called on every update (`syncSend`), before anything else it
   * does: true where it has taken this update (the screen put up, or the one source chosen), and the rest waits for the
   * next. Once for each question (`sendAsk`'s key), with a route, and not for a payment from a card. Where every pile
   * that could pay is at this mint, nothing is done here, and CURRENCY and WALLET are as they were. */
  syncPayFrom() {
    this.pfTidy();
    const s = this.state;
    const W = window.FoxyWallet;
    if (s.screen !== 'sendConfirm' || !(s.recipientKind === 'invoice' || s.recipientKind === 'email')) return false;
    if (this.cardSendNow && this.cardSendNow()) return false;
    if (!W || !W.balances || !W.quoteFeeAt || !W.quoteFee || !W.payNeed) return false;
    if (this.offlineNow() || this.connecting()) return false;
    const ask = this.sendAsk();
    if (!ask || this._pfFor === ask.key) return false;
    this._pfFor = ask.key;
    const sats = ask.inv ? Math.round(Number(W.amountOf(ask.inv)) || 0) : Math.round(Number(ask.sats) || 0);
    if (!(sats > 0)) return false;
    const here = this.pfHere();
    // dollars only where the mint issues them
    const issues = (p) => p.unit === 'sat' || (p.mint === here ? this.twoUnitsOn() : !!(W.twoUnits && W.twoUnits(p.mint)));
    const piles = this.pfPiles().filter((p) => issues(p) && this.pfFace(p.have, p.unit, sats));
    if (!piles.some((p) => p.mint !== here)) return false;
    const list = piles.map((p) => this.pfEntry(p, { pref: p.mint === here }));
    const show = list.length > 1;
    const key = ask.key;
    const found = Promise.resolve().then(() => (ask.addr ? W.lookupLnurl(ask.addr, ask.sats) : { pr: ask.inv }));
    found.catch(() => {});
    const quote = (e) => found.then((f) => {
      // kept for SEND and the confirmation's own question: the address is not asked again for this payment
      if (ask.addr && this._pfFor === key) this._found = f;
      return e.mint === here ? this.pfQuoteHere(f.pr, e.unit) : W.quoteFeeAt(e.mint, f.pr, e.unit);
    }).then((q) => this.pfLnCost(e, q));
    const one = show ? null : list[0];
    this.pfOpen('send', list, {
      show: show, ask: 'Pay ' + this.sendAmountText() + ' from', quote: quote,
      go: (e, shown) => this.pfSendGo(e, shown),
      none: () => this.pfSendGo(null, true),
      cancel: () => this.setState({ screen: 'home', stack: [] }),
      // the one source, chosen in the same breath: the confirmation is drawn from it, and asks nothing of this mint
      patch: one ? { payMint: one.mint, payUnit: one.unit, wallet: one.unit, walletAuto: false, walletTapped: true } : null,
    });
    return true;
  }

  /* This mint's own quote for one of its balances, in the shape another mint's comes in (`quoteFeeAt`), and kept whole
   * for the confirmation (`pfPre`). */
  pfQuoteHere(pr, unit) {
    const W = window.FoxyWallet;
    return W.quoteFee(pr, { unit: unit }).then((q) => {
      if (!q) return null;
      const r = W.payNeed(q.amount, q.feeReserve, { unit: unit }) || {};
      return { mint: this.pfHere(), unit: unit, amount: q.amount, feeReserve: q.feeReserve, need: Number(r.need) || (q.amount + q.feeReserve),
        have: r.have, ok: r.ok !== false, why: r.why || '', rate: q.rate || null, quote: q, here: true };
    });
  }

  /* A melt quote as a tile reads it: the whole cost in the unit, the fee in it, and the fee in sats to rank by. */
  pfLnCost(e, q) {
    if (!q) return { ok: false, why: this.pfName(e.mint) + ' gave no price for this.', tag: 'NOT AVAILABLE' };
    const need = Math.round(Number(q.need) || 0);
    const fee = Math.max(0, need - Math.round(Number(q.amount) || 0));
    let rank = fee;
    if (e.unit === 'usd') {
      const btc = (q.rate && Number(q.rate.usdPerBtc)) || ((this.satUsd && Number(this.satUsd())) ? Number(this.satUsd()) * 1e8 : 0);
      rank = btc > 0 ? Math.round(fee / 100 / btc * 1e8) : fee * 1000;
    }
    return { cost: need, fee: fee, ok: !!q.ok, why: q.why || '', rank: rank, full: q };
  }

  /* This mint's quotes asked on PAY FROM for the invoice `pr`, by unit, for the confirmation to take rather than ask
   * again (03-send.js `quoteSendFee`). Only this mint's: another's was asked with no seed and is never paid with. */
  pfPre(pr) {
    const pf = this._pf;
    if (!pf || pf.flow !== 'send') return null;
    const out = {};
    ['sat', 'usd'].forEach((u) => {
      const f = pf.full[this.pfKey(pf.home, u)];
      if (f && f.here && f.quote && f.quote.bolt11 === pr) out[u] = f.quote;
    });
    return out;
  }

  /* A source chosen for a Lightning payment, or none (`o.none`: this mint's, as if nothing had been asked). Back to the
   * confirmation when the screen was up. */
  pfSendGo(e, shown) {
    const patch = e ? { payMint: e.mint, payUnit: e.unit, wallet: e.unit, walletAuto: false, walletTapped: true, payFromReopen: false }
      : { payMint: '', payUnit: '', payFromReopen: false };
    this.setState(patch);
    if (shown && this.state.screen === 'payFrom') this.back();
  }

  /* The source a Lightning payment is made from when it is another mint's (`startSendNow`): where, in what, the home it
   * comes back to, and the quote shown, which is handed to `pay` without the wallet that asked for it. Null for one made
   * here. */
  pfAwayNow() {
    if (!this.pfAway('send')) return null;
    const s = this.state;
    const e = this.pfChosen();
    const q = e ? this.pfFull(e.key) : null;
    return { mint: this.pfMint(s.payMint), unit: s.payUnit === 'usd' ? 'usd' : 'sat', home: this.pfHome(), q: q,
      shown: (b) => ((q && q.quote && q.quote.bolt11 === b) ? q.quote : null) };
  }

  /* After a payment from another mint was refused for a price that moved: that source asked again. */
  pfRequote() {
    const e = this.pfChosen();
    if (!e || !this._pf) return;
    this.setState({ payFromList: this.pfList().map((x) => (x.key === e.key ? Object.assign({}, x, { ok: null }) : x)) });
    this.pfAsk(Object.assign({}, e, { ok: null }), this._pf.run);
  }

  /* CONFIRM PAYMENT for a Lightning payment from another mint than this phone's: the same rows as at a mint with two
   * balances (`confirmTwoSpec`), in the unit of the pile that pays and from that mint's own quote, PAYING FROM naming
   * it, and PAY FROM to change it where there is a choice. PAY is a visit there (03-send.js `startSendNow`). */
  payAwaySpec() {
    const s = this.state;
    const unit = s.payUnit === 'usd' ? 'usd' : 'sat';
    const e = this.pfChosen();
    const q = e ? this.pfFull(e.key) : null;
    const asked = this.sendSatsNow();
    const bracket = (t) => (t ? '(' + t + ')' : '');
    const fig = (n) => (unit === 'usd' ? { main: this.unitFigure(n, 'usd'), sub: '' } : this.money(n));
    const asking = !e || e.ok === null;
    const total = q ? Math.round(Number(q.need) || 0) : null;
    const fee = q ? Math.max(0, total - Math.round(Number(q.amount) || 0)) : null;
    const rows = [
      this.cfRow('TO', this.sendToText()),
      this.cfRow('AMOUNT', q ? fig(q.amount).main : this.sendAmountText(), {
        sub: unit === 'usd' ? (asked ? bracket('₿ ' + this.group(asked)) : '') : bracket(q ? fig(q.amount).sub : ''),
      }),
      this.cfRow('FEE INCLUDED', q ? fig(fee).main : asking ? 'CHECKING…' : 'UNKNOWN',
        { sub: (q && unit === 'sat') ? bracket(fig(fee).sub) : '', sub2: 'You pay the mint’s fees' }),
      this.cfRow('NETWORK', 'LIGHTNING'),
      this.cfRow('PAYING FROM', this.pfLabel(s.payMint, unit)),
    ];
    const rate = q && q.rate ? Math.round(Number(q.rate.usdPerBtc) || 0) : 0;
    if (unit === 'usd' && rate > 0) {
      const who = String(this.mintNameOf(s.payMint) || 'the mint');
      rows.push(this.cfRow('RATE', '₿ 1 = $ ' + this.group(rate) + ' · ' + who + (/s$/i.test(who) ? '’' : '’s') + ' rate'));
    }
    if ((s.note || '').trim()) rows.push(this.cfRow('NOTE', (s.note || '').trim()));
    const base = {
      title: 'CONFIRM PAYMENT', titleUp: true, amountLabel: 'TOTAL', rows: rows,
      wallet: this.pfMany('send') ? { label: 'PAY FROM', word: this.pfName(s.payMint), go: () => this.openWalletPick() } : undefined,
      close: () => this.setState({ screen: 'home', stack: [] }),
      amountInk: 'var(--ink)',
      amount: total != null ? fig(total).main : this.sendAmountText(),
      amountSub: (total != null && unit === 'sat') ? fig(total).sub : '',
    };
    if (e && e.ok === false) {
      return Object.assign(base, {
        amountInk: '#FF5C5C',
        warn: e.why || 'More than your ' + this.unitWord(unit).toLowerCase() + ' at ' + this.pfName(s.payMint) + '.',
        cta: 'NOT ENOUGH', ctaTone: 'warn', go: () => {},
      });
    }
    const held = asking || this.connecting();
    return Object.assign(base, {
      cta: held ? 'CHECKING…' : 'PAY', ctaBusy: held, ctaTone: 'go',
      // a visit is a switch of mints, which waits for money already moving
      go: held ? () => {} : () => { if (this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return; this.startSend(); },
    });
  }

  // ---- a Cashu request ----

  /* PAY FROM before a request's confirmation (07-history-tokens-mints.js `openRequest`): the request's own mint with no
   * fee, first among equals, and every other mint's sats by the crossing, each quoted at once. Sats only: dollars do not
   * cross between mints, and a request in dollars is paid from the dollars at its own mint or not at all. Not with no
   * route, where only the request's own mint can pay. */
  pfRequest(req) {
    const W = window.FoxyWallet;
    if (!req || !W || !W.balances) return false;
    if (this.offlineNow()) return false;
    /* The other balance at this mint, where the request's own is short there and the other could cover what is missing:
     * a swap, then the payment, under one PAY (`pfSwapSource`). The only source a request in dollars can have besides its
     * own dollars, which do not cross between mints. */
    const swap = this.pfSwapSource ? this.pfSwapSource(req) : null;
    if (req.unit === 'usd' || !W.transferQuote) return swap ? this.pfReqOpen(req, [swap], '', this.unitFigure(swap.amt, 'usd')) : false;
    /* Every mint it names pays it as it stands, with no crossing (a till's, the default first); any other crosses into
     * the default, `want`. It read the first alone, and offered a crossing from a mint the request also takes. */
    const listed = this.reqMints(req).map((m) => this.pfMint(m));
    const want = listed[0] || '';
    const need = Math.round(Number(req.sats) || 0);
    if (!want || !(need > 0)) return swap ? this.pfReqOpen(req, [swap], '', this.money(need).main) : false;
    const here = this.pfHere();
    const piles = this.pfPiles().filter((p) => p.unit === 'sat' && p.have >= need);
    if (piles.length < (swap ? 1 : 2)) return swap ? this.pfReqOpen(req, piles.map((p) => this.pfEntry(p)).concat([swap]), want, this.money(need).main) : false;
    const list = piles.map((p) => {
      if (listed.indexOf(p.mint) < 0) return this.pfEntry(p);
      // at their mint: no fee, or where it is this phone's own, the mint's fee for the pieces (`sendShortfall`)
      let lack = null;
      try {
        lack = (p.mint === here && W.sendShortfall)
          ? W.sendShortfall(need, { locked: !!(req.lockTo && !this.offlineNow()) }) : null;
      } catch (x) { lack = null; }
      const fee = lack ? Math.max(0, Number(lack.fee) || 0) : 0;
      return this.pfEntry(p, { pref: true, cost: need + fee, fee: fee, rank: fee, ok: !(lack && lack.short),
        why: lack && lack.short ? String(lack.why || '') : '', tag: lack && lack.short ? 'NOT ENOUGH' : '' });
    });
    return this.pfReqOpen(req, swap ? list.concat([swap]) : list, want, this.money(need).main);
  }

  /* PAY FROM over a request's offer, with the sources in `list`: a crossing to `want` for another mint's sats, the swap at
   * this mint for the other balance (`swap` on the entry), and none asked for one already known. */
  pfReqOpen(req, list, want, fig) {
    const W = window.FoxyWallet;
    const need = Math.round(Number(req.sats) || 0);
    /* One invoice at the request's mint for every source asked (`landing`, this run's): each source's crossing used to
     * have the request's mint make an invoice of its own, and the one chosen pays the one they share. */
    const landing = {};
    const quote = (e) => (e.swap ? this.pfSwapQuote(e).then((q) => this.pfSwapCost(e, q))
      : W.transferQuote(e.mint, need, { to: want, land: true, landing: landing }).then((plan) => {
        const fee = Math.max(0, Math.round(Number(plan && plan.feeSats) || 0));
        return { cost: need + fee, fee: fee, ok: true, rank: fee, full: plan };
      }));
    const out = () => {
      if (req.viaTap && W.tapQuote) W.tapQuote(JSON.stringify({ gaveUp: 'The payer cancelled.' })).catch(() => {});
      this.setState({ screen: 'home', stack: [], req: null, note: '', noteDraft: '', tapQuoteFor: '' });
    };
    this.pfOpen('req', list, {
      show: true, ask: 'Pay ' + fig + ' from', quote: quote,
      go: (e, shown) => {
        this.setState({ payMint: e.mint, payUnit: e.unit, payFromReopen: false });
        if (shown && this.state.screen === 'payFrom') this.back();
      },
      none: () => {
        if (this.state.screen === 'payFrom') this.back();
        // the offer says NOT ENOUGH, and a payer that cannot cover it tells the phone it is touching (`tellPayerShort`)
        if (list.some((e) => e.swap) && this.tellPayerShort) this.tellPayerShort(req);
      },
      cancel: out,
    });
    return true;
  }

  /* The source chosen for this request on PAY FROM: its mint and, where it is another than the request's, the crossing's
   * plan, quoted there. Null where nothing was chosen. */
  pfReqSource(req) {
    const s = this.state;
    if (s.payFromFlow !== 'req' || !s.payMint || !req) return null;
    // a crossing only from a mint the request does not name: one it names pays it there (`pfRequest`)
    const listed = this.reqMints(req).map((m) => this.pfMint(m));
    const mint = this.pfMint(s.payMint);
    const unit = s.payUnit === 'usd' ? 'usd' : 'sat';
    // the other balance at this mint, swapped first (`pfSwapSource`): its entry and the swap's quote, and no crossing
    if (unit !== (req.unit === 'usd' ? 'usd' : 'sat')) {
      const e = this.pfList().filter((x) => x.key === this.pfKey(mint, unit) && x.swap)[0] || null;
      return { mint: mint, unit: unit, plan: null, swap: e ? { e: e, q: this.pfFull(e.key) } : null };
    }
    return { mint: mint, unit: unit, plan: (listed.length && listed.indexOf(mint) < 0) ? this.pfFull(this.pfKey(mint, 'sat')) : null };
  }

  /* For `makeTokenForRequest`: the crossing to make before the payment, when the source chosen is another mint than the
   * one the request names and there is a route to make it over. */
  /* Not once its sats have been moved there (`_crossMovedTo`, set by `crossMove`): a pass that comes back for the
   * over-payment question ran the same plan a second time, and only the far side refusing an invoice already paid
   * stopped a second melt. */
  pfReqCrossing(want) {
    const src = this.pfReqSource(this.state.req);
    if (!src || !src.plan || this.offlineNow() || this.pfMint(want) === src.mint) return null;
    if (this._crossMovedTo && this.pfMint(this._crossMovedTo) === this.pfMint(want)) return null;
    return { plan: src.plan, from: src.mint };
  }

  // ---- the other balance at the same mint ----

  /* Found short in the unit asked, with the other unit at hand (decided 2026-11-04): a request for sats at Forge, with
   * 3,190 sats there and $ 89.16 in dollars, said NOT ENOUGH, and the dollars had to be swapped by hand and the code
   * scanned again. Now the other balance at that mint is a source: the swap the SWAP screen makes (melt one unit, mint the
   * other, at that mint: 16b-two-balances.js `swapQuote`, `swapRun`), for what is missing and a little over, and then the
   * payment, under one PAY. Only at the mint this phone is on, where swaps are made, and where it issues both; only where
   * the request's own balance there is short with its fee (`sendShortfall`), and the other covers what is missing on its
   * face (the quote says for certain). Null where none. */
  pfSwapSource(req) {
    const W = window.FoxyWallet;
    if (!req || !W || !W.swapQuote || !W.swapRun || !W.sendShortfall || this.offlineNow()) return null;
    if (!(this.twoUnitsOn && this.twoUnitsOn()) || !this.requestHere(req)) return null;
    const unit = req.unit === 'usd' ? 'usd' : 'sat';
    const from = unit === 'usd' ? 'sat' : 'usd';
    const amt = unit === 'usd' ? Math.max(0, Math.round(Number(req.amount) || 0)) : Math.round(Number(req.sats) || 0);
    if (!(amt > 0)) return null;
    let lack = null;
    try {
      lack = W.sendShortfall(amt, Object.assign(unit === 'usd' ? { unit: 'usd' } : {}, { locked: !!(req.lockTo && !this.offlineNow()) }));
    } catch (x) { lack = null; }
    if (!lack || !lack.short) return null;
    const here = this.pfHere();
    const pile = this.pfPiles().filter((p) => p.mint === here && p.unit === from)[0];
    if (!pile) return null;
    // what is missing, with a little over: the pieces the swap brings may cost a piece more to spend
    const gap = Math.max(1, Math.round(Number(lack.need) || 0) - Math.round(Number(lack.have) || 0));
    const want = gap + (unit === 'sat' ? Math.max(2, Math.ceil(gap / 100)) : 1);
    const r = this.pfSwapRate();
    // on its face: the other balance is worth what is missing at this phone's price, with a tenth to spare (`pfFace`)
    const worth = r > 0 ? (from === 'usd' ? pile.have / 100 / r * 1e8 : pile.have * r / 1e8 * 100) : pile.have;
    if (r > 0 ? worth * 1.1 < want : !(pile.have > 0)) return null;
    return this.pfEntry(pile, { swap: true, toUnit: unit, want: want, amt: amt, pref: true });
  }

  /* Dollars a bitcoin is worth, as a swap at this mint is sized: the mint's last rate, else this phone's price. 0 with neither. */
  pfSwapRate() {
    const W = window.FoxyWallet;
    let r = 0;
    try { const m = W && W.mintRate ? W.mintRate(this.pfHere()) : null; r = Number(m && m.usdPerBtc) || 0; } catch (x) { r = 0; }
    if (!(r > 0)) r = (this.satUsd ? Number(this.satUsd()) || 0 : 0) * 1e8;
    return r > 0 ? r : 0;
  }

  /* The swap for a source of `pfSwapSource`: the SWAP screen's quote (`swapQuote`, an amount of the balance that leaves),
   * sized so that what arrives covers `e.want`; asked once more, larger, where the first brings too little. Refused as
   * NOT ENOUGH where that is more than the balance holds. */
  pfSwapQuote(e) {
    const W = window.FoxyWallet;
    const from = e.unit === 'usd' ? 'usd' : 'sat', to = e.toUnit === 'usd' ? 'usd' : 'sat';
    const r = this.pfSwapRate();
    const short = () => Object.assign(new Error('Your ' + this.unitWord(from).toLowerCase() + ' at ' + this.pfName(e.mint)
      + ' cannot cover the swap with its fee.'), { foxyHave: e.have });
    // a little over what arrives, for the mint's fee
    const size = (get) => (r > 0 ? Math.ceil((from === 'usd' ? get / 1e8 * r * 100 : get / 100 / r * 1e8) * 1.02) + 1 : e.have);
    const ask = (amount, n) => {
      if (amount > e.have) return Promise.reject(short());
      return W.swapQuote(from, to, amount).then((q) => {
        if (Number(q && q.get) >= e.want) return q;
        if (n >= 1 || !(Number(q && q.get) > 0)) throw short();
        return ask(Math.ceil(amount * e.want / Number(q.get)) + 1, n + 1);
      });
    };
    return ask(Math.min(e.have, Math.max(1, size(e.want))), 0);
  }

  /* A swap's quote as a tile reads it: what leaves, in its own unit, and the swap's cost as the SWAP screen counts it (what
   * leaves less what arrives, both at the quote's rate), in sats to rank by. */
  pfSwapCost(e, q) {
    const from = e.unit === 'usd' ? 'usd' : 'sat';
    const fee = this.pfSwapFee(q, from);
    const rate = this.swapRateOf ? this.swapRateOf(q && q.rate) : 0;
    const rank = from === 'usd' ? (rate > 0 ? Math.round(fee / 100 / rate * 1e8) : fee * 1000) : fee;
    return { cost: Math.round(Number(q.total) || 0), fee: fee, ok: true, rank: rank, full: q };
  }

  /* What a swap costs, in the unit that leaves: what leaves less what arrives, at the quote's rate (26i-swap.js `swapSpec`'s
   * FEE); the mint's fee alone with no rate to put the two in one unit. */
  pfSwapFee(q, from) {
    const rate = this.swapRateOf ? this.swapRateOf(q && q.rate) : 0;
    if (!q) return 0;
    if (!(rate > 0)) return Math.max(0, Math.round(Number(q.fee) || 0));
    const got = from === 'usd' ? Number(q.get) / 1e8 * rate * 100 : Number(q.get) / 100 / rate * 1e8;
    return Math.max(0, Math.round(Number(q.total) - got));
  }

  /* "From your dollars at FORGE, fee about $ 0.03": a swap's tile, and its row on the offer. */
  pfSwapText(e, q) {
    const from = e.unit === 'usd' ? 'usd' : 'sat';
    const word = from === 'usd' ? 'dollars' : 'sats';
    return 'From your ' + word + ' at ' + this.pfName(e.mint) + (q ? ', fee about ' + this.unitFigure(this.pfSwapFee(q, from), from) : '');
  }

  /* For `makeTokenForRequest`: the swap chosen for this request, while it has not been made. */
  pfReqSwap(req) {
    const src = this.pfReqSource(req);
    return (src && src.swap && src.swap.e && src.mint === this.pfHere()) ? src : null;
  }

  /* PAY on an offer paid from the other balance: the swap, then the payment, with nothing more asked
   * (`makeTokenForRequest`, `go.swapped`). The quote PAY FROM showed is used while it holds; one run out is asked again
   * first. A swap the mint has not finished is the SWAP screen's card, and nothing is paid; one it did not make says so,
   * and the offer stays. */
  pfSwapThenPay(req, src, go) {
    const W = window.FoxyWallet;
    const e = src.swap.e;
    const from = e.unit === 'usd' ? 'usd' : 'sat', to = e.toUnit === 'usd' ? 'usd' : 'sat';
    const held = (q) => !!(q && q.state === 'quoted' && Number(q.expiresAt) - Date.now() >= 20000);
    this.setState({ reqSwapping: true });
    this.showMelt('Swapping ' + this.unitWord(from).toLowerCase() + ' into ' + this.unitWord(to).toLowerCase() + '…', 120000);
    console.log('[foxy] request: paying it from ' + (from === 'usd' ? 'dollars' : 'sats') + ' at ' + this.pfName(e.mint).toLowerCase()
      + ', swapped first');
    const done = () => { this.hideMelt(); this.setState({ reqSwapping: false }); this.refreshBalance(); };
    Promise.resolve().then(() => (held(src.swap.q) ? src.swap.q : this.pfSwapQuote(e)))
      .then((q) => W.swapRun(q, (st) => console.log('[foxy] request: swap ' + st)))
      .then((r) => {
        done();
        if (this.loadHistory) this.loadHistory();
        if (r && r.state === 'done') {
          this.makeTokenForRequest(Object.assign({}, go || {}, { req: req, swapped: true }));
          return;
        }
        if (r && r.state === 'pending') {
          if (req.viaTap && W.tapQuote) W.tapQuote(JSON.stringify({ gaveUp: 'The payer cancelled.' })).catch(() => {});
          this.setState({ screen: 'home', stack: [], req: null, tapQuoteFor: '' });
          this.swapPendingCard(r);
          return;
        }
        this.toast('The mint did not make the swap. Nothing moved, and your ' + this.unitWord(from).toLowerCase() + ' are where they were.', true);
      })
      .catch((x) => {
        done();
        this.toast(W.reason ? W.reason(x) : String((x && x.message) || x), true);
      });
  }

  // ---- a tap from somebody at another mint ----

  /* PAY FROM where a tap at another mint is decided (26d-tap.js `tapCrossMint`): their mint's sats with no fee, first
   * among equals, and this phone's own mint and any other by the crossing, the one asked while they decided reused where it
   * is the same (`_crossReady`). With one source, false, and the tap goes on exactly as it did. */
  pfTapCross(offer, want, theirs, mine, there) {
    const W = window.FoxyWallet;
    if (!W || !W.balances || !W.transferQuote || this.offlineNow()) return false;
    const to = this.pfMint(theirs);
    const piles = this.pfPiles().filter((p) => p.unit === 'sat' && (p.mint === to ? there >= want : p.have >= want));
    if (piles.length < 2) return false;
    const ready = this._crossReady;
    const list = piles.map((p) => (p.mint === to
      ? this.pfEntry(p, { pref: true, cost: want, fee: 0, rank: 0, ok: true })
      : this.pfEntry(p)));
    const quote = (e) => {
      const same = !!(ready && ready.sats === want && ready.to === to && ready.from === e.mint);
      const plan = same ? ready.plan : W.transferQuote(e.mint, want, { to: to, land: true });
      return plan.then((p) => {
        const fee = Math.max(0, Math.round(Number(p && p.feeSats) || 0));
        return { cost: want + fee, fee: fee, ok: true, rank: fee, full: p };
      });
    };
    // off PAY FROM, and on as the tap would have gone: the crossing's own screen is its confirmation
    const leave = () => { if (this.state.screen === 'payFrom') this.back(); };
    this.pfOpen('tap', list, {
      show: true, ask: 'Pay ' + this.money(want).main + ' from', quote: quote,
      go: (e) => {
        const plan = this.pfFull(e.key);
        leave();
        if (e.mint === to) { this.tapPayFromThere(offer, want, theirs, mine, there); return; }
        if (plan) this._crossReady = { sats: want, to: to, from: e.mint, plan: Promise.resolve(plan) };
        this.tapCrossQuote(offer, want, theirs, mine, e.mint);
      },
      none: () => {
        leave();
        if (there >= want && W.sendShortfall) this.tapPayFromThere(offer, want, theirs, mine, there);
        else this.tapCrossQuote(offer, want, theirs, mine);
      },
      cancel: () => {
        if (W.tapQuote) W.tapQuote(JSON.stringify({ gaveUp: 'The payer cancelled.' })).catch(() => {});
        this.setState({ screen: 'home', stack: [] });
      },
    });
    return true;
  }

  // ---- a payout on chain ----

  /* PAY FROM before a payout's confirmation (26b-onchain.js `payOnchain`, `ocNext`): every mint's sats that cover the
   * amount. What a mint charges on chain is asked of it after it is chosen, once the phone is there, so every tile can be
   * chosen at once and says the fee comes next; this phone's own mint is first, as the one with no visit. True where it has
   * taken the payout on: the screen put up, or the one source at another mint gone to. */
  pfOnchain() {
    const s = this.state;
    const W = window.FoxyWallet;
    if (!W || !W.balances || !W.connect || (this.fcOutMode && this.fcOutMode()) || this.offlineNow()) return false;
    const sats = Math.round(Number(s.ocSats) || 0);
    if (!(sats > 0)) return false;
    const here = this.pfHere();
    const piles = this.pfPiles().filter((p) => p.unit === 'sat' && p.have >= sats);
    if (!piles.some((p) => p.mint !== here)) return false;
    const list = piles.map((p) => this.pfEntry(p, { ok: true, note: 'Fee on the next screen', rank: p.mint === here ? 0 : 1, pref: p.mint === here }));
    const show = list.length > 1;
    this.pfOpen('oc', list, {
      show: show, ask: 'Pay ' + this.money(sats).main + ' from',
      go: (e, shown) => this.pfOnchainGo(e, shown),
      cancel: () => this.ocCancel(),
    });
    if (!show) this.pfOnchainGo(list[0], false);
    return true;
  }

  /* A mint chosen for a payout: its quote asked here, or on a visit there (`_ocVisit`), home again when the payout has gone
   * or failed or the screens are left (`pfOcHome`). */
  /* Not while the phone is on its way home (`_homeGoing`): `here` is still the mint being visited, so it wrote that mint
   * as home under the trip and its ending saved it as the phone's own. Chosen again once the trip has landed or failed,
   * from wherever the phone is then, if the screen is still up. And no visit while money is moving here
   * (`refuseSwitchWhileBusy`): a visit is a mint switch. */
  pfOnchainGo(e, shown) {
    const W = window.FoxyWallet;
    if (shown && this.state.screen === 'payFrom') this.back();
    if (this._homeGoing) {
      if (this._ocAfterHome === e) return;
      this._ocAfterHome = e;
      const screen = this.state.screen;
      const to = this.state.ocTo;
      console.log('[foxy] pay from: the phone is on its way home; the payout follows once it is there');
      this.toast('Foxy is getting back to your mint. The payout follows.');
      const after = () => {
        if (this._ocAfterHome !== e) return;
        this._ocAfterHome = null;
        if (this.state.screen === screen && this.state.ocTo === to) this.pfOnchainGo(e, false);
      };
      this._homeGoing.then(after, after);
      return;
    }
    this._ocAfterHome = null;
    const here = this.pfHere();
    if (e.mint !== here && this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return;
    this.setState({ payMint: e.mint, payUnit: 'sat', payFromReopen: false });
    if (e.mint === here) { this.ocQuote(); return; }
    this._ocVisit = e.mint;
    /* Never over a home already set: a request payment's visit had written
     * home, and this wrote the mint being visited over it, so the phone ended
     * there and not home. */
    if (!this._crossCameFrom) this._crossCameFrom = here;
    this.setState({ ocPlan: null, ocFee: null, ocErr: '' });
    console.log('[foxy] pay from: visiting ' + this.pfName(e.mint).toLowerCase() + ' for its on-chain fee');
    W.connect(e.mint, null, null, { remember: false }).then(() => {
      if (this._ocVisit !== e.mint) return;
      this._ocAsked = null;
      this.onchainAsk();
      this.refreshBalance();
      this.ocQuote();
    }, (x) => {
      if (this._ocVisit !== e.mint) return;
      this.setState({ ocErr: W.reason ? W.reason(x) : String((x && x.message) || x) });
      this.pfOcHome();
    });
  }

  /* Home from a visit made for a payout on chain. */
  pfOcHome() {
    if (!this._ocVisit) return;
    this._ocVisit = null;
    this.crossComeHome();
  }
