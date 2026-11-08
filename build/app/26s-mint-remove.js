  /* ---- removing a mint from the list ----------------------------------------
   *
   * The keeper's words (2026-11-07): a pencil at the top right of SWITCH MINT turns on a bin by each mint; a bin asks where
   * the balance goes, the fee is confirmed, and the mint leaves the list.
   *
   *   pencil ............ edit mode (`mrEdit`): a bin on each tile, the pencil a tick that leaves it; a tile tapped switches
   *                       nothing; leaving the screen leaves edit mode (`mrBack`, `goSwitchMint`)
   *   bin, no balance ... REMOVE <MINT>? (`mrAskEmpty`), and it is removed (`mrRemoveNow`)
   *   bin, a balance .... TO WHICH MINT? (TRANSFER's "to" step, `mrMint` set), then TRANSFER's confirmation with the fee for all
   *                       of it (`mrPickTo`: the whole pile quoted, stepped down to what the fee leaves room for), then the
   *                       move; a mint holding sats and dollars moves the sats first and then the dollars, one confirmation
   *                       each; what a move's fee hands back as change is moved again while a quote says it fits, two more
   *                       moves at most (`mrNextLeg`). What a quote proves cannot move (less than the fee, under a mint's
   *                       smallest invoice) stays in its pile at that mint until the mint is added again (the keeper's
   *                       rule, 2026-11-07: `mrDust`); the one-line question names it, and REMOVE removes the mint, every
   *                       refusal asked again first (`mrDrop`). Any other error is TRANSFER's: TRY AGAIN or CANCEL, nothing
   *                       removed.
   *   ADD A MINT ........ on TO WHICH MINT?, the mint added is the destination (`mrAddTo`, through `justSwitch`)
   *   sent tokens ....... one sent from there and not claimed does not hold it; it stays on its note, said (`mrSentLine`)
   *   refusals .......... the only mint on the list, money still arriving or on its way there (the wallet's
   *                       `mintRemoveHolds`), something else moving money now (`mrRefusal`)
   *
   * Removed is the wallet's `removeMint`: off the list, not chosen, and hidden, so a shipped mint stays off until it is chosen
   * again through the gate (09-melt-paste-switch.js `mintOnPhone`). Its history rows stay, and HISTORY's mint list still offers
   * it (27-render-mints-restore-backup.js, `mrRemovedMints`). */

  // the pencil, and the tick that ends it
  mrEditToggle() { this.setState(p => ({ mrEdit: !p.mrEdit })); }

  /* Back off SWITCH MINT, off its TO WHICH MINT? while a removal asks it, or off the removal's confirmation. From the
   * confirmation: TO WHICH MINT? again, a tile there a destination as before (the mint added there let go, `mrUndoAdd`), home
   * where a quote visited another mint. From TO WHICH MINT?: the list in edit mode again, the removal ended. Off the list,
   * edit mode ends. True where the step was undone here. */
  mrBack() {
    const s = this.state || {};
    // after a move has landed, back from the next confirmation ends the removal as CANCEL does, the mint still on the list
    if (s.screen === 'trConfirm' && s.mrMint && !s.trBusy && (s.mrLegs || []).length) { this.trCancel(); return true; }
    if (s.screen === 'trConfirm' && s.mrMint && !s.trBusy) {
      this.mrUndoAdd();
      this.setState(p => ({ trStep: 'to', trTo: '', mrTo: '', trPlan: null, trFee: null, trErr: '', trSats: 0,
        screen: (p.stack || []).length ? p.stack[p.stack.length - 1] : 'switchMint', stack: (p.stack || []).slice(0, -1) }));
      if (this.homeAgain) this.homeAgain();
      return true;
    }
    if (s.screen !== 'switchMint') return false;
    if (s.mrMint && s.trStep === 'to') {
      this.mrUndoAdd();
      // the question was opened over the list in edit mode (`mrMoveStart`, through `goSwitchMint`): that list again
      this.setState(p => ({ mrMint: '', trStep: '', trFrom: '', trTo: '', trUnit: 'sat', mrEdit: true,
        screen: (p.stack || []).length ? p.stack[p.stack.length - 1] : 'switchMint', stack: (p.stack || []).slice(0, -1) }));
      if (this.homeAgain) this.homeAgain();
      return true;
    }
    if (s.mrEdit) this.setState({ mrEdit: false });
    return false;
  }

  /* A mint added at TO WHICH MINT? (`mrAddTo`) and the removal not carried out to it: not chosen, and off the list again
   * (hidden again where it had been removed before), so a dropped removal adds no mint. Nothing where none was added, or
   * once money landed there. */
  mrUndoAdd() {
    const W = window.FoxyWallet;
    const a = this._mrAdded;
    this._mrAdded = null;
    if (!a || !W || !W.unchooseMint) return;
    // after the trip home the way out starts (a quote visited it, and the phone is let go of only once it is off it)
    const go = () => {
      if (W.unchooseMint(a.url, { hide: a.wasHidden })) console.log('[foxy] remove: ' + this.mintNameOf(a.url) + ', added for it, let go again');
    };
    Promise.resolve().then(() => this._homeGoing || this._trQuoteGoing || null).then(go, go);
  }

  /* What is at a mint in the units a move can carry: { sat, usd }, and `other` (a unit Foxy does not move). */
  mrHeld(url) {
    const pile = this.mintPile(url);
    const held = this.trHeldAt(url);
    const other = (pile.units || []).filter(b => b && b.unit !== 'usd' && b.unit !== 'sat' && Number(b.amount) > 0).length;
    return { sat: held.sat, usd: held.usd, other: other };
  }

  mrName(url) { return (this.mintNameOf(url) || 'that mint').toUpperCase(); }

  mrSame(a, b) {
    const W = window.FoxyWallet;
    const c = (u) => ((W && W.canonicalMint) ? String(W.canonicalMint(u) || '') : String(u || '').trim().replace(/\/+$/, ''));
    return !!c(a) && c(a) === c(b);
  }

  /* Why a mint cannot be removed now, in plain words, or ''. */
  mrRefusal(url) {
    const W = window.FoxyWallet;
    const name = this.mintNameOf(url) || 'That mint';
    const others = this.allMints().filter(m => !this.mrSame(m.url, url));
    if (!others.length) return name + ' is the only mint on your list. Add another mint before removing it.';
    if (this.moneyBusy && this.moneyBusy()) return 'Something else is moving money right now. Try again in a moment.';
    const holds = (W && W.mintRemoveHolds) ? W.mintRemoveHolds(url) : [];
    if (holds.length) return name + ' stays on your list for now. ' + holds.join(' ');
    if (this.mrHeld(url).other) return name + ' holds money in a currency Foxy cannot move. Spend it there first.';
    return '';
  }

  mrRefuse(why) {
    this.blockedCard('mintRemove', { tone: 'warn', title: 'NOT REMOVED', reason: why, chip: 'Nothing was moved or removed.' });
  }

  // a bin
  mrTrash(url) {
    const no = this.mrRefusal(url);
    if (no) { console.log('[foxy] remove ' + this.mintNameOf(url) + ': refused (' + no + ')'); this.mrRefuse(no); return; }
    const held = this.mrHeld(url);
    if (!(held.sat > 0) && !(held.usd > 0)) { this.mrAskEmpty(url); return; }
    this.mrMoveStart(url);
  }

  /* The mint the phone goes to when the one it is on is removed: the one picked, else the first other mint on the phone. */
  mrNextMint(url, picked) {
    if (picked && !this.mrSame(picked, url)) return picked;
    const others = this.allMints().filter(m => !this.mrSame(m.url, url));
    const own = others.filter(m => this.mintOnPhone(m.url));
    return ((own[0] || others[0]) || {}).url || '';
  }

  // is the phone on it, or saved on it
  mrOnIt(url) {
    const W = window.FoxyWallet;
    const saved = (W && W.saved && W.saved()) || {};
    return this.mrSame(W && W.mintUrl, url) || this.mrSame(saved.url, url);
  }

  /* Nothing there, or nothing that can be moved: one line, and it goes. What a quote proved cannot be moved is named, with the
   * reason it gave (`mrDustWhy`), and stays at the mint until it is added again. CANCEL ends a removal under way as
   * TRANSFER's CANCEL does, nothing removed. */
  mrAskEmpty(url, picked) {
    const onIt = this.mrOnIt(url);
    const next = onIt ? this.mrNextMint(url, picked) : '';
    const left = this.mrLeftText(url);
    const name = this.mintNameOf(url) || 'that mint';
    const whys = Object.keys(this.state.mrDustWhy || {}).map(k => this.state.mrDustWhy[k]);
    const floored = Object.keys(this.state.mrFloorAt || {}).length;
    const why = whys.indexOf('floor') >= 0 ? ' It is less than the smallest amount '
      + (floored > 1 ? 'any of your other mints' : (this.mintNameOf(picked) || 'the other mint')) + ' takes.'
      : whys.indexOf('fee') >= 0 ? ' It is less than the fee to move it.' : '';
    const lines = [left ? left + ' stays at ' + this.mrName(url) + ' until you add it again.' + why : '',
      this.mrSentLine(url),
      onIt ? 'Foxy moves to ' + (this.mintNameOf(next) || 'another mint') + '.' : '', left ? '' : 'Its history stays on this phone.'];
    this.blockedCard('mintRemove', {
      tone: 'ask',
      title: 'REMOVE ' + this.mrName(url) + '?',
      reason: lines.filter(Boolean).join(' '),
      retry: 'REMOVE', go: () => this.mrRemoveLeaving(url, next),
      shut: { label: 'CANCEL', tap: () => { if (this.state.mrMint) this.trCancel(); } },
    });
    console.log('[foxy] remove ' + name + ': asked' + (left ? ', ' + left + ' too little to move' : ''));
  }

  /* Off the list now: the phone moved off it first where it is on it (`next`, past the gate where that mint is not the
   * phone's yet), or back to its own mint where a quote visited another. */
  mrRemoveNow(url, next, n) {
    const W = window.FoxyWallet;
    /* Money still moving is waited for first, ten seconds at most, and nothing moves the phone meanwhile; then every refusal
     * is asked again before the phone leaves the mint, and refused, it stays where it is. */
    const tries = n || 0;
    if (this.moneyBusy && this.moneyBusy() && tries < 40) { setTimeout(() => this.mrRemoveNow(url, next, tries + 1), 250); return; }
    const no = this.mrRefusal(url);
    // refused: home as TRANSFER's CANCEL goes, where a quote visited the other mint; the phone saved where it was
    if (no) { this.mrRefuse(no); if (this.homeAgain) this.homeAgain(); return; }
    if (!this.mrOnIt(url)) {
      Promise.resolve(this.homeAgain ? this.homeAgain() : null).then(() => this.mrDrop(url), () => this.mrDrop(url));
      return;
    }
    const to = this.mrNextMint(url, next);
    if (!to) { this.mrRefuse(this.mrRefusal(url) || 'There is no other mint to move to.'); return; }
    const go = () => W.connect(to).then(() => { this.walletReady && this.walletReady({ name: this.mintNameOf(to) }); this.mrDrop(url); },
      (e) => { this.toast(W.reason(e), true); });
    if (this.mintGate) this.mintGate(to, go, 'To add this mint.'); else go();
  }

  /* Off the list (the wallet's `removeMint`). Anything left there stays in its pile, and the notice says where it shows:
   * HISTORY's mint list, under REMOVED, until the mint is added again. */
  mrDrop(url, n) {
    const W = window.FoxyWallet;
    /* Every refusal asked again right before it goes (an invoice made, a till opened, a code made while the question sat):
     * money still moving is waited for, ten seconds at most, and then refuses like the rest. Refused, nothing is removed. */
    const tries = n || 0;
    if (this.moneyBusy && this.moneyBusy() && tries < 40) { setTimeout(() => this.mrDrop(url, tries + 1), 250); return; }
    const no = this.mrRefusal(url);
    if (no) {
      console.log('[foxy] remove ' + this.mintNameOf(url) + ': refused at the last step (' + no + ')');
      this.setState({ mrMint: '', mrLegs: [], mrDustWhy: {} });
      this.mrRefuse(no);
      return;
    }
    try { W.removeMint(url); } catch (e) { this.toast(W.reason(e), true); return; }
    this._mrAdded = null;
    this.setState({ mrMint: '', mrLegs: [], mrDustWhy: {} });
    const left = this.mrLeftText(url);
    const sent = this.mrSentLine(url);
    if (left || sent) {
      this.blockedCard('mintRemoved', {
        tone: 'ask', title: this.mrName(url) + ' REMOVED',
        reason: [left ? left + ' stays at ' + this.mrName(url) + ' until you add it again. HISTORY still lists it with its mints.' : '', sent]
          .filter(Boolean).join(' '),
      });
    } else this.toast(this.mintNameOf(url) + ' is off your list.');
    if (this.refreshBalance) this.refreshBalance();
    if (this.loadHistory) this.loadHistory();
  }

  /* A balance: TO WHICH MINT?, TRANSFER's own "to" step, its list the other mints. The sats first where it holds both. */
  mrMoveStart(url) {
    const W = window.FoxyWallet;
    if (!W || !W.transferQuote) return;
    if (this.refuseSwitchWhileBusy()) return;
    this._trWas = W.mintUrl || '';
    this._mrTries = 0;
    this._mrAdded = null;
    const held = this.mrHeld(url);
    this.goSwitchMint({
      mrMint: url, mrEdit: false, mrTo: '', mrLegs: [], mrDustWhy: {},
      trStep: 'to', trFrom: url, trTo: '', trUnit: held.sat > 0 ? 'sat' : 'usd', trSats: 0, trPlan: null, trFee: null, trErr: '',
    });
  }

  /* The mint it goes to, past the gate (`trPick`): TRANSFER's confirmation for all of it, no keypad. In sats, the whole pile
   * is asked and the quote's own answer (`foxyFits`) gives what the fee leaves room for; in dollars, the sats the pile comes
   * to at the phone's price as a first guess, then at the mint's own rate from that quote (`mrQuoted`), stepped down in
   * proportion where it does not fit (`mrQuoteShort`). */
  mrPickTo(mint) {
    const s = this.state;
    const held = this.mrHeld(s.mrMint);
    const dollars = s.trUnit === 'usd';
    let sats = held.sat;
    if (dollars) {
      const px = this.px ? Number(this.px()) || 0 : 0;
      if (!(px > 0)) { this.toast('Foxy has no bitcoin price yet to move dollars at. Try again in a moment.', true); return; }
      sats = Math.floor(held.usd / 100 / px * 1e8);
    }
    this._mrTries = 0;
    this.setState(p => ({
      trTo: mint, mrTo: mint, trStep: '',
      screen: 'trConfirm', stack: p.screen === 'trConfirm' ? p.stack : p.stack.concat([p.screen]),
      trSats: sats, trPlan: null, trFee: null, trErr: '', trFits: 0, cfMore: '',
    }));
    if (!(sats > 0)) { this.mrDust('fee'); return; }
    this.mrWhenFree(() => this.quoteTransfer());
  }

  /* After a move, the next one's quote waits for the wallet to let go of what the last held (`moneyBusy`): a few seconds at
   * most, and dropped if the removal was left meanwhile. */
  mrWhenFree(go, n) {
    const tries = n || 0;
    if (!this.state.mrMint) return;
    if (!(this.moneyBusy && this.moneyBusy()) || tries >= 40) { go(); return; }
    setTimeout(() => this.mrWhenFree(go, tries + 1), 250);
  }

  /* A quote for all of it refused for want of room for the fee: asked again for what fits (four times at most). What the
   * quote proves cannot move (nothing fits beside the fee, or under the far mint's smallest invoice): too little to move
   * (`mrDust`). Any other refusal is TRANSFER's error, with TRY AGAIN and CANCEL. True where it was handled here. */
  mrQuoteShort(e) {
    const s = this.state;
    if (!s.mrMint || !e || e.left) return false;
    const fits = Number(e.foxyFits) || 0;
    const need = Number(e.foxyNeed) || 0, have = Number(e.foxyHave) || 0;
    /* The far mint will invoice a larger figure but not this one: under its smallest invoice (the wallet's probe, `foxyFloor`).
     * Change after a move goes to another mint on the phone that takes it, if one does (each asked in turn); under every
     * one's smallest invoice it is too little to move. On the first move a floor is TRANSFER's error, and the keeper's pick
     * is not changed. */
    const floor = !!(e && e.foxyFloor) || /so it is the amount/.test(String((e && e.message) || ''));
    // only change is dust by a floor: the first move's refusal is TRANSFER's error, the pile is not too little to move
    if (floor && !(s.mrLegs || []).length) return false;
    if (floor) {
      this.setState({ trQuoting: false });
      const tried = Object.assign({}, s.mrFloorAt || {}, { [String(s.trTo || '').replace(/\/+$/, '')]: true });
      const other = (s.mrLegs || []).length ? this.allMints().find(m => !this.mrSame(m.url, s.mrMint) && !tried[String(m.url).replace(/\/+$/, '')]
        && this.mintOnPhone(m.url)) : null;
      this.setState({ mrFloorAt: tried });
      if (other) {
        console.log('[foxy] remove: ' + this.mintNameOf(s.trTo) + ' will not take so little; asking ' + this.mintNameOf(other.url));
        this.mrPickTo(other.url);
        return true;
      }
      this.mrDust('floor');
      return true;
    }
    /* Only an answer about the fee says anything about what fits (`foxyFits`, set by the wallet's quote with the figures);
     * any other refusal (a mint not reached, its Lightning down, a quote that failed) proves nothing: TRANSFER's error. */
    if (e.foxyFits === undefined) return false;
    let less = 0;
    if (s.trUnit !== 'usd') less = fits > 0 && fits < s.trSats ? fits : 0;
    else if (need > 0 && have > 0 && need > have) less = Math.min(s.trSats - 1, Math.floor(s.trSats * have / need) - 1);
    this._mrTries = (this._mrTries || 0) + 1;
    if (less > 0 && this._mrTries <= 4) {
      this.setState({ trQuoting: false });
      this.trMoveLess(less);
      return true;
    }
    // stepped down four times and still short: not proved too little, TRANSFER's error
    if (less > 0) return false;
    this.setState({ trQuoting: false });
    this.mrDust('fee');
    return true;
  }

  /* A removal's dollars quoted: what leaves (`gross`) should be the pile, less no more than the mint's own fee on it. The
   * first figure was the phone's price; the quote carries the mint's, so a pile left short by the difference is quoted again
   * at it, three times at most. True where it asked again. */
  mrQuoted(plan) {
    const s = this.state;
    if (!s.mrMint || s.trUnit !== 'usd' || !plan || plan.unit !== 'usd') return false;
    const have = this.mrHeld(s.mrMint).usd;
    const gross = Math.round(Number(plan.gross) || 0);
    const slack = Math.max(1, Math.round(Number(plan.feeUnit) || 0));
    this._mrUp = this._mrUp || 0;
    if (!(gross > 0) || have - gross <= slack || this._mrUp >= 3) return false;
    const up = Math.floor(s.trSats * have / gross);
    if (!(up > s.trSats)) return false;
    this._mrUp += 1;
    console.log('[foxy] remove: the dollars quoted at the mint\u2019s rate leave ' + (have - gross) + ' behind; asking for ' + up + ' sats');
    this.setState({ trQuoting: false });
    this.trMoveLess(up);
    return true;
  }

  /* What a quote proved cannot move, in the unit being moved (`why`: 'fee' or 'floor'): it stays, said with its reason, and
   * the removal goes on to the other balance, or asks its one line (`mrNextLeg`). */
  mrDust(why) {
    const s = this.state;
    if (!s.mrMint) return;
    const unit = s.trUnit === 'usd' ? 'usd' : 'sat';
    this.setState({ mrDustWhy: Object.assign({}, s.mrDustWhy || {}, { [unit]: why || 'fee' }) });
    this.mrNextLeg();
  }

  /* What comes next in a removal: a balance still to move (the sats before the dollars), or what came back as change while a
   * quote may still move it (three moves of each at most), each with its own confirmation; then, with something left that
   * cannot move, the one-line question (`mrAskEmpty`); with nothing left, the mint off the list (`mrFinish`). */
  mrNextLeg() {
    const s = this.state;
    const url = s.mrMint;
    if (!url) return;
    const held = this.mrHeld(url);
    const legs = s.mrLegs || [];
    const dust = s.mrDustWhy || {};
    const count = (u) => legs.filter(x => x === u).length;
    const unit = ['sat', 'usd'].find(u => held[u] > 0 && !dust[u] && count(u) < 3);
    if (unit) {
      console.log('[foxy] remove ' + this.mintNameOf(url) + ': ' + (count(unit) ? 'what came back as change' : unit === 'usd' ? 'the dollars' : 'the sats') + ' next');
      this._mrUp = 0;
      this.setState({ trUnit: unit, trFrom: url, mrFloorAt: {} });
      this.mrPickTo(s.mrTo);
      return;
    }
    if (held.sat > 0 || held.usd > 0) { this.mrAskEmpty(url, s.mrTo || ''); return; }
    this.mrFinish(url);
  }

  // what stays at a mint, in words ('₿ 12', '₿ 12 and $0.01'), or '' for nothing
  mrLeftText(url) {
    const held = this.mrHeld(url);
    return [held.sat > 0 ? this.money(held.sat).main : '', held.usd > 0 ? this.unitFigure(held.usd, 'usd') : ''].filter(Boolean).join(' and ');
  }

  /* A token sent from the mint and not claimed (the keeper, 2026-11-07: "let it through"): it does not hold the mint on the
   * list, and stays on its note as any sent token does; said, with its figure, before the mint goes. '' for none. */
  mrSentLine(url) {
    const W = window.FoxyWallet;
    const t = (W && W.mintUnclaimedSent) ? W.mintUnclaimedSent(url) : { count: 0, sat: 0, usd: 0 };
    if (!(t.count > 0)) return '';
    const fig = [t.sat > 0 ? this.money(t.sat).main : '', t.usd > 0 ? this.unitFigure(t.usd, 'usd') : ''].filter(Boolean).join(' and ');
    return t.count === 1 ? 'A token of ' + fig + ' you sent is still unclaimed; it stays on its note.'
      : t.count + ' tokens of ' + fig + ' you sent are still unclaimed; they stay on their notes.';
  }

  /* ADD A MINT on a removal's TO WHICH MINT? (the keeper, 2026-11-07: "yes make it the destination"): the mint added is where
   * the money goes. Its gate was passed by the tile (`typeMintGated`) or the scan (`mintGate`), so it is chosen and not asked
   * again; the confirmation and the move follow as for any mint on the list. */
  mrAddTo(url) {
    const W = window.FoxyWallet;
    const u = String(url || '').trim().replace(/\/+$/, '');
    const bad = W && W.mintProblem && W.mintProblem(u);
    if (bad) { this.toast(bad, true); return; }
    if (this.mrSame(u, this.state.mrMint)) { this.toast('That is the mint being removed. Pick another.', true); return; }
    this.mrUndoAdd();
    /* What this add changes, so a dropped removal undoes only that: nothing for a mint already on the list or already
     * chosen (its address typed again), else the choice and the place on the list, hidden again where it had been. */
    const listed = this.allMints().some(m => this.mrSame(m.url, u));
    const chosen = !!(W && W.mintChosen && W.mintChosen(u));
    this._mrAdded = (listed || chosen) ? null : { url: u, wasHidden: !!(W && W.mintHidden && W.mintHidden(u)) };
    if (W && W.chooseMint) W.chooseMint(u);
    console.log('[foxy] remove ' + this.mintNameOf(this.state.mrMint) + ': to ' + this.mintNameOf(u) + ', added now');
    this.trPickTo(u);
  }

  mrRemoveLeaving(url, picked) {
    const to = picked || this.state.mrTo || '';
    if (this.state.screen === 'trConfirm' || this.state.mrMint) {
      this.setState({ screen: 'home', stack: [], trPlan: null, trStep: '', trErr: '', trBusy: false, mrMint: '', mrEdit: false });
    }
    const left = this.mrLeftText(url);
    if (left) console.log('[foxy] remove ' + this.mintNameOf(url) + ': ' + left + ' stays there, too little to move');
    this.mrRemoveNow(url, to);
  }

  /* A move of a removal landed: money is at the mint it went to, so a mint added for it stays; then what comes next
   * (`mrNextLeg`). */
  mrMoved() {
    const s = this.state;
    const url = s.mrMint;
    if (!url) return;
    this._mrAdded = null;
    this.setState({ mrLegs: (s.mrLegs || []).concat([s.trUnit === 'usd' ? 'usd' : 'sat']) });
    this.mrNextLeg();
  }

  /* The phone where it belongs (the mint it was on, unless that was the one removed, when the move left it at the mint the
   * money went to), and the mint off the list. */
  mrFinish(url) {
    const was = this._trWas;
    const W = window.FoxyWallet;
    const back = was && !this.mrSame(was, url) && !this.mrSame(W.mintUrl, was) && this.connectBack ? this.connectBack(was) : null;
    Promise.resolve(back).then(() => this.mrDrop(url), (e) => {
      // not back where it was: it is at the mint the money went to, which is the phone's now
      console.warn('[foxy] remove: back to ' + this.mintNameOf(was) + ' failed: ' + W.reason(e));
      this.mrDrop(url);
    });
  }

  /* The mints removed that HISTORY can still show, each as the list draws a mint (`allMints`). */
  mrRemovedMints() {
    const W = window.FoxyWallet;
    const hidden = (W && W.mintsHidden) ? W.mintsHidden() : [];
    const strip = u => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return hidden.map(u => {
      const shipped = (this.DEFAULT_MINTS || []).find(m => this.mrSame(m.url, u));
      return shipped || { url: u, name: strip(u), host: strip(u), logo: '', tint: '#5A5A5A' };
    });
  }

  // under the confirmation's figures, while a removal moves its money
  mrConfirmLine() {
    const s = this.state;
    if (!s.mrMint) return '';
    const held = this.mrHeld(s.mrMint);
    const name = this.mintNameOf(s.mrMint) || 'that mint';
    const next = s.trUnit === 'sat' && held.usd > 0 && (s.mrLegs || []).indexOf('usd') < 0 ? ' Its dollars move next.' : '';
    const sent = this.mrSentLine(s.mrMint);
    const again = (s.mrLegs || []).indexOf(s.trUnit === 'usd' ? 'usd' : 'sat') >= 0;
    const back = again ? (s.trUnit === 'usd' ? this.unitFigure(held.usd, 'usd') : this.money(held.sat).main) + ' came back as change. ' : '';
    return back + 'All of it moves, then ' + name + ' leaves your list.' + next
      + ' Change the fee hands back stays at ' + name + ' until you add it again.' + (sent ? ' ' + sent : '');
  }
