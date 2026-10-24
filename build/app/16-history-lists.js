
  // one row per contact, for the template's loops
  contactRows() {
    const s = this.state;
    const list = (s.contacts || [])
      .slice()
      .sort((a, b) => String(a.name || a.handle)
        .localeCompare(String(b.name || b.handle), undefined, { sensitivity: 'base' }));
    return list.map(c => ({
      name: c.name || c.handle,
      handle: c.handle,
      ini: String(c.name || c.handle).charAt(0).toUpperCase(),
      tint: c.tint || 'var(--acc)',
      tap: () => this.setState(p => ({
        screen: 'amount',
        stack: p.stack.concat([p.screen]),
        flow: 'send',
        recipient: c.handle,
        recipientKind: 'email',
        asset: 'BITCOIN',
        network: 'LIGHTNING',
        payFrom: 'BITCOIN',
        amount: '',
        unit: 'USD',
        // which balance pays is asked again (`syncWalletAsk`)
        wallet: '', walletAuto: false, walletTapped: false, feeQ: null,
      })),
    }));
  }

  // on launch, offer whatever payable thing is already on the clipboard
  /* ---- history and contacts ---- */

  /* What actually left the wallet for this transaction.
   *
   * A send of 500 that cost 2 in fees moved 502. Showing 500 means a week of
   * history cannot be reconciled against the balance, and nothing in the list
   * explains the difference.
   *
   * Incoming is unchanged: the mint's fee came out before the money arrived,
   * so the credited amount is already the true one. */
  /* The audit's arithmetic, in one place: the history screen draws it and
   * the HISTORY button rings for it, and the two must not disagree.
   *
   * Walked back from the balance now, newest first: a receive is taken off on
   * the way down and a send, with its fee, put back. Rows that moved nothing
   * yet — pending, failed, at risk, a bill still being collected, another
   * unit's ecash — carry the balance through unchanged. A payment whose
   * change has not come back cost its gross so far. */
  /* Part of the balance is with the mint and cannot be spent this minute.
   *
   * A swap that got no answer has its pieces held back until the mint says
   * whether it was made (04-lost-answers.js). The balance drops by that much
   * and a payment can only use the rest, with nothing on the screen to say
   * why — a phone showed only a small part of its balance for two minutes
   * while a top-up cut off by the network was being asked about. Said where
   * a person is about to pay: under the amount, and on the confirmation. ''
   * when nothing is held. */
  heldNote() {
    const W = window.FoxyWallet;
    const held = Math.round(Number(W && W.heldSats && W.heldSats()) || 0);
    if (!(held > 0)) return '';
    return this.stageMoney(held) + ' of your balance is currently pending with the mint. '
      + 'Please wait a minute and try again.';
  }

  /// The same, short, for under the balance on home. '' when nothing is held.
  heldPill() {
    const W = window.FoxyWallet;
    const held = Math.round(Number(W && W.heldSats && W.heldSats()) || 0);
    if (held > 0) return this.stageMoney(held) + ' pending with the mint';
    /* A swap between balances the mint has not finished: what it took, in the
     * balance it came from ("$ 10.00 pending with the mint"), until the wallet
     * finishes it (26i-swap.js). Read first, so a dollar leg is not named twice. */
    if (this.twoUnitsOn && this.twoUnitsOn() && W && W.unitSwapsPending) {
      let swaps = [];
      try { swaps = W.unitSwapsPending() || []; } catch (e) { swaps = []; }
      const sum = { usd: 0, sat: 0 };
      swaps.forEach(r => { const u = r && r.from && r.from.unit === 'sat' ? 'sat' : 'usd'; sum[u] += Math.max(0, Math.round(Number(r && r.from && r.from.amount) || 0)); });
      const parts = ['usd', 'sat'].filter(u => sum[u] > 0).map(u => this.unitFigure(sum[u], u));
      if (parts.length) return parts.join(' and ') + ' pending with the mint';
    }
    /* Dollars held the same way, at a mint with two balances: a swap the mint
     * has not finished, named in dollars. */
    if (this.twoUnitsOn && this.twoUnitsOn() && W && W.heldIn) {
      let cents = 0;
      try { cents = Math.round(Number(W.heldIn('usd')) || 0); } catch (e) { cents = 0; }
      if (cents > 0) return this.unitFigure(cents, 'usd') + ' pending with the mint';
    }
    const back = this.recoveringSats();
    if (back > 0) return this.stageMoney(back) + ' being recovered from the mint';
    /* A payment taken and still being swapped in at the mint: in the balance
     * already, and said here for the seconds until the swap lands
     * (`W.arrivingIn`). Dollars by their own figure, at a mint with two. */
    const arriving = this.arrivingNow ? this.arrivingNow() : { sat: 0, usd: 0 };
    const coming = [];
    if (arriving.usd > 0) coming.push(this.unitFigure(arriving.usd, 'usd'));
    if (arriving.sat > 0) coming.push(this.stageMoney(arriving.sat));
    return coming.length ? coming.join(' and ') + ' arriving from the mint' : '';
  }

  /* Money arriving at this mint, per unit: taken (PAID) and still being swapped
   * in. { sat, usd }, each 0 when nothing is; dollars only at a mint with two. */
  arrivingNow() {
    const W = window.FoxyWallet;
    const of = (u) => { try { return Math.max(0, Math.round(Number(W && W.arrivingIn && W.arrivingIn(u)) || 0)); } catch (e) { return 0; } };
    return { sat: of('sat'), usd: this.twoUnitsOn && this.twoUnitsOn() ? of('usd') : 0 };
  }

  /* The audit's bucket for money arriving, in one unit: the hashes of the
   * entries it belongs to, and its share of the balance. Both are set aside
   * together, so a payment being swapped in neither counts nor reads as
   * missing (`W.arriving`). */
  arrivingBucket(unit) {
    const W = window.FoxyWallet;
    let list = [];
    try { list = (W && W.arriving) ? (W.arriving(unit) || []) : []; } catch (e) { list = []; }
    const byHash = new Map();
    let amount = 0;
    list.forEach(a => {
      const n = Math.max(0, Math.round(Number(a && a.amount) || 0));
      amount += n;
      const h = String((a && a.hash) || '');
      if (h) byHash.set(h, (byHash.get(h) || 0) + n);
    });
    return { byHash, amount, count: list.length };
  }

  /// Fees the top-up swaps have cost at this mint, which no history row shows. 0 when none.
  topUpFeeSats() {
    const W = window.FoxyWallet;
    return Math.round(Number(W && W.topUpFeeSats && W.topUpFeeSats()) || 0);
  }

  /// Sats a swap took after Foxy was put away, still to be collected (recoveringSats). 0 when none.
  recoveringSats() {
    const W = window.FoxyWallet;
    return Math.round(Number(W && W.recoveringSats && W.recoveringSats()) || 0);
  }

  /* Why a payment that is `shortBy` sats over the balance cannot go: because
   * that much is held back with the mint, when it is — or '' when it is
   * simply more than this phone has, held or not. It is a block, the same as
   * MORE THAN YOUR BALANCE is: the amount goes red, there is no button that
   * sends, and the words say to wait, not to pay less. */
  heldBlocks(shortBy) {
    const W = window.FoxyWallet;
    const held = Math.round(Number(W && W.heldSats && W.heldSats()) || 0);
    const short = Math.round(Number(shortBy) || 0);
    return (held > 0 && short > 0 && short <= held) ? this.heldNote() : '';
  }

  /* The books of one balance: `histAudit` for bitcoin, as it always was, and
   * `histAuditUsd` for dollars. At a mint with two balances each adds up on its
   * own, in its own unit: dollars walked back from the dollar balance in cents
   * with the rows' own `amount` and `feeAmount`, bitcoin from the sats with
   * `sats` and the fee. A row of the other unit carries the balance through
   * untouched. */
  histAuditIn(unit) {
    return unit === 'usd' ? this.histAuditUsd() : this.histAudit();
  }

  histAudit() {
    const s = this.state;
    const balOf = new Map();
    // the payments a notice on the card is about, and what to call each
    const flagged = new Map();
    const balNow = Math.round(Number(s.balSats) || 0);
    /* Money arriving: a payment taken and still being swapped in. It is in the
     * balance and its entry is in the list, but neither is settled yet, so
     * both are set aside here, together: a payment that is three seconds from
     * landing is not a payment missing (the audit read "balance 0, off by
     * -1216" behind PAID for those seconds). */
    const arriving = this.arrivingBucket ? this.arrivingBucket('sat') : { byHash: new Map(), amount: 0, count: 0 };
    let run = balNow, dueChange = 0, dueCount = 0, toShow = null, toShowSats = 0, toShowCount = 0;
    const seen = { in: 0, out: 0, inSats: 0, outSats: 0, skipped: 0, skippedSats: 0, arriving: 0, arrivingSats: 0 };
    (s.fresh ? [] : (s.history || [])).forEach(g => g.items.forEach(t => {
      balOf.set(t, run);
      /* Its entry goes with the money, and by the money's figure: in the
       * arriving bucket, neither counted by its own figure nor "not counted". */
      const coming = t.dir === 'in' ? arriving.byHash.get(String(t.hash || '')) : undefined;
      if (coming !== undefined) {
        run -= coming;
        seen.arriving += 1; seen.arrivingSats += coming;
        return;
      }
      /* Change that came back over the link has a row of its own, and the
       * payment it is the rest of is already shown at its net. Counting both
       * counted the change twice: a 2,366 sat payment with 1 sat of change
       * was -2,365 and +1, and the card said DOES NOT ADD UP by that one sat
       * for the rest of the wallet's life. The row stays
       * in the list; it is the payment that carries the arithmetic. */
      const changeRow = t.dir === 'in' && (!!t.changeRow || /^(tap|req)-change-/.test(String(t.hash || '')));
      /* Pending means two different things. A receive that is pending has not
       * arrived: nothing moved. A payment that is pending has left — its
       * pieces are out of the balance — and is only waiting to be confirmed.
       * Skipping both left a payment whose answer never came (the payer was
       * put away mid-tap) out of the sum, and the card said DOES NOT ADD UP
       * by exactly that payment. */
      const waitingIn = !!t.pending && t.dir === 'in';
      const moved = !changeRow && !waitingIn && !t.failed && !t.atRisk && !t.split && !(t.unit && t.unit !== 'sat');
      const owedBack = t.dir !== 'in' && t.changeState === 'owed' ? (Number(t.changeSats) || 0) : 0;
      if (owedBack > 0 || (t.dir !== 'in' && t.changeState === 'never came' && Number(t.changeSats) > 0)) {
        dueChange += Number(t.changeSats) || 0;
        dueCount += 1;
      }
      if (owedBack > 0 || (t.dir !== 'in' && t.changeState === 'never came' && Number(t.changeSats) > 0)) flagged.set(t, 'Change not collected');
      // change made here for a payer and still here, as a code on its payment
      if (t.dir === 'in' && t.changeState === 'not handed' && Number(t.changeSats) > 0 && t.token) {
        flagged.set(t, 'Change to hand over');
        if (!toShow) toShow = t;
        toShowSats += Number(t.changeSats) || 0;
        toShowCount += 1;
      }
      if (moved) {
        const by = t.dir === 'in' ? (Number(t.sats) || 0) : this.txTotalOut(t) + owedBack;
        run += t.dir === 'in' ? -by : by;
        if (t.dir === 'in') { seen.in += 1; seen.inSats += by; } else { seen.out += 1; seen.outSats += by; }
      } else {
        seen.skipped += 1; seen.skippedSats += Number(t.sats) || 0;
      }
    }));
    const whole = !!s.historyComplete && !s.fresh && (s.history || []).length > 0;
    /* Less what is held back for a swap the mint has not answered. Those
     * sats are out of the balance on purpose until the mint says whether the
     * swap was made, and the card names them — so they are accounted for, not
     * missing. A top-up cut off by a network that dropped held 32,768 back
     * for two minutes, and for those two minutes the card and the red ring
     * said DOES NOT ADD UP about money Foxy knew the whereabouts of. */
    const W0 = window.FoxyWallet;
    const held = Math.round(Number(W0 && W0.heldSats && W0.heldSats()) || 0);
    // and what a swap took after Foxy was put away, to be collected on the next connection
    const back = this.recoveringSats ? this.recoveringSats() : 0;
    // and the fees the top-ups cost at this mint, which no row carries
    const fees = this.topUpFeeSats ? this.topUpFeeSats() : 0;
    // and money arriving whose entry is not written yet (it is written when it lands): in the balance, set aside
    run -= Math.max(0, arriving.amount - seen.arrivingSats);
    const off = whole ? Math.round(run) + held + back + fees : 0;
    /* Said in the log when it changes, with what it was worked out from: a
     * card that says DOES NOT ADD UP and a diary that cannot say why is a
     * report nobody can act on. */
    const sig = [balNow, off, dueChange, toShowCount, seen.in, seen.out, seen.skipped, arriving.amount].join('|');
    if (whole && sig !== this._auditSig) {
      this._auditSig = sig;
      console.log('[foxy] audit: balance ' + balNow + ', off by ' + off + '; ' + seen.in + ' in for ' + seen.inSats
        + ', ' + seen.out + ' out for ' + seen.outSats + ', ' + seen.skipped + ' not counted (' + seen.skippedSats
        + ' sats: pending, failed, at risk, a bill, another unit); arriving ' + arriving.amount + ' ('
        + arriving.count + ' being swapped in, ' + seen.arriving + ' with an entry); change due here ' + dueChange
        + ', change to hand over ' + toShowSats);
      /* And when it does not add up, the rows it was worked out from, newest
       * first: which way, how much, the fee, and what kind of row. Amounts are
       * already in this log; this puts them in one place, in order. */
      if (off !== 0) {
        const rows = [];
        (s.history || []).forEach(g => g.items.forEach(t => {
          rows.push((t.dir === 'in' ? '+' : '-') + (Number(t.sats) || 0)
            + (Number(t.fee || t.feeSats) > 0 ? 'f' + Number(t.fee || t.feeSats) : '')
            + (Number(t.grossSats) > 0 ? 'g' + Number(t.grossSats) : '')
            + (Number(t.changeSats) > 0 ? 'c' + Number(t.changeSats) : '')
            + (t.changeState ? '(' + t.changeState + ')' : '')
            + (t.pending ? 'P' : '') + (t.failed ? 'F' : '') + (t.atRisk ? 'R' : '') + (t.split ? 'S' : '')
            + (t.memo === 'opening' ? 'O' : '') + (t.changeRow ? 'C' : '') + (Number(t.sats) < 10 ? '<' + String(t.hash || '').slice(0, 14) + '>' : ''));
        }));
        for (let i = 0; i < rows.length; i += 20) console.log('[foxy] audit rows ' + i + ': ' + rows.slice(i, i + 20).join(' '));
      }
    }
    return { balOf, balNow, run, whole, off, held, arriving: arriving.amount, dueChange, dueCount, toShow, toShowSats, toShowCount, flagged };
  }

  histAuditUsd() {
    const s = this.state;
    const W0 = window.FoxyWallet;
    const balOf = new Map();
    const balNow = Math.max(0, Math.round(Number(s.balUsdCents) || 0));
    // dollars arriving, set aside with their entries as in the bitcoin books (`histAudit`)
    const arriving = this.arrivingBucket ? this.arrivingBucket('usd') : { byHash: new Map(), amount: 0, count: 0 };
    let run = balNow, arrivingSeen = 0;
    (s.fresh ? [] : (s.history || [])).forEach(g => g.items.forEach(t => {
      balOf.set(t, run);
      if (t.unit !== 'usd') return;
      const coming = t.dir === 'in' ? arriving.byHash.get(String(t.hash || '')) : undefined;
      if (coming !== undefined) { run -= coming; arrivingSeen += coming; return; }
      /* Change that came back over the link has a row of its own, and the
       * payment it is the rest of is already shown at its net: the payment
       * carries the arithmetic, as in the bitcoin books (`histAudit`). */
      const changeRow = t.dir === 'in' && (!!t.changeRow || /^(tap|req)-change-/.test(String(t.hash || '')));
      const moved = !changeRow && !(t.pending && t.dir === 'in') && !t.failed && !t.atRisk && !t.split;
      if (!moved) return;
      // change still owed on a payment that went out whole: out of the balance until it comes back
      const owedBack = t.dir !== 'in' && t.changeState === 'owed' ? Math.max(0, Math.round(Number(t.changeAmount) || 0)) : 0;
      const by = t.dir === 'in' ? Math.round(Number(t.amount) || 0)
        : Math.round(Number(t.amount) || 0) + Math.max(0, Math.round(Number(t.feeAmount) || 0)) + owedBack;
      run += t.dir === 'in' ? -by : by;
    }));
    const whole = !!s.historyComplete && !s.fresh && (s.history || []).length > 0;
    let held = 0, back = 0;
    try { held = Math.round(Number(W0 && W0.heldIn && W0.heldIn('usd')) || 0); } catch (e) { held = 0; }
    try { back = Math.round(Number(W0 && W0.recoveringIn && W0.recoveringIn('usd')) || 0); } catch (e) { back = 0; }
    const off = whole ? Math.round(run) - Math.max(0, arriving.amount - arrivingSeen) + held + back : 0;
    const sig = [balNow, off, arriving.amount].join('|');
    if (whole && sig !== this._auditSigUsd) {
      this._auditSigUsd = sig;
      console.log('[foxy] audit (dollars): balance ' + balNow + ' cents, off by ' + off + '; arriving ' + arriving.amount + ' cents');
    }
    return { balOf, balNow, run, whole, off, held, back, arriving: arriving.amount, dueChange: 0, dueCount: 0, toShow: null, toShowSats: 0,
      toShowCount: 0, flagged: new Map() };
  }

  txTotalOut(t) {
    const sats = Number((t && t.sats) || 0);
    if (!t || t.dir === 'in') return sats;
    return sats + Math.max(0, Number(t.fee || t.feeSats || 0));
  }

  txWhen(t) {
    const v = t.at;
    if (!v) return new Date();
    if (typeof v === 'number') return new Date(v * (v > 1e11 ? 1 : 1000));
    const d = new Date(v);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  /* When, as the phone's own clock would say it.
   *
   * The time of day, in the phone's time zone; and once a payment is more
   * than twenty-four hours old, the date in front of it, two digits for the
   * month and two for the day: `2:45 PM`, then `10/03 2:45 PM`. It was "3h
   * ago", which has to be worked back to a time by whoever reads it and is
   * wrong the moment the screen has been open a while. A year is added only
   * when it is not this one. */
  txLabel(d, now) {
    if (now - d < 86400000) return this.txClock(d);
    return this.txDay(d, now) + ' ' + this.txClock(d);
  }
  /* The date and the time, always: the detail screen has the room. */
  txStamp(d, now) {
    return this.txDay(d, now || new Date()) + ' ' + this.txClock(d);
  }
  txDay(d, now) {
    const two = (n) => (n < 10 ? '0' : '') + n;
    return two(d.getMonth() + 1) + '/' + two(d.getDate())
      + (d.getFullYear() !== now.getFullYear() ? '/' + two(d.getFullYear() % 100) : '');
  }
  /* Twelve hours or twenty-four, as the phone is set. The phone says which
   * (`__foxyClock24`, FoxyWebView.swift): the page's own locale knows the
   * region's habit and not the switch in Settings. */
  txClock(d) {
    const pref = typeof window !== 'undefined' ? /** @type {any} */ (window).__foxyClock24 : undefined;
    const h = d.getHours(), m = d.getMinutes();
    const mm = (m < 10 ? '0' : '') + m;
    if (pref === true) return (h < 10 ? '0' : '') + h + ':' + mm;
    if (pref === false) return ((h % 12) || 12) + ':' + mm + (h < 12 ? ' AM' : ' PM');
    try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return ((h % 12) || 12) + ':' + mm + (h < 12 ? ' AM' : ' PM'); }
  }

  // (a card's payment taken while this phone was offline is from a card as well, settled or not)
  CARD_MEMOS = { 'card': 'From a card', 'to card': 'To card', 'from card': 'From card', 'card, not completed': 'Card, not completed', 'paid from card': 'Paid from card',
                 'card, offline': 'From a card', 'card, offline \u2014 not settled': 'From a card' };

  // the same with the card's name after them (NAME CARD, 26j-card-wheel.js): "To Lunch card"
  CARD_NAMED = { 'card': 'From ', 'to card': 'To ', 'from card': 'From ', 'card, not completed': 'Not completed: ', 'paid from card': 'Paid from ',
                 'card, offline': 'From ', 'card, offline \u2014 not settled': 'From ' };

  // the name this phone gave the card an entry is for (the wallet's `cardName`), or ''
  txCardName(t) {
    const W = window.FoxyWallet;
    const key = String((t && (t.card || t.fromCard)) || '');
    try { return (key && W && typeof W.cardName === 'function') ? String(W.cardName(key) || '') : ''; } catch (e) { return ''; }
  }

  // best guess at who the other side was: a lightning address if one shows up
  // in the payment's metadata, otherwise the memo, otherwise the rail
  txWho(t) {
    const hay = (t.memo || '') + ' ' + JSON.stringify(t.extra || {});
    const m = hay.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    if (m) return m[0];
    // the row clearing history leaves behind: the balance that was there
    if (t.memo === 'opening') return 'Balance carried forward';
    // the wallet's own words for money that moved by a card (08a-flashcard.js), with the card's name where this phone gave it one
    if (this.CARD_MEMOS[t.memo]) {
      const named = this.txCardName(t);
      return named ? (this.CARD_NAMED[t.memo] || 'From ') + named : this.CARD_MEMOS[t.memo];
    }
    if (t.memo && t.memo.trim() && t.memo !== 'Foxy') return t.memo.trim();
    return t.dir === 'in' ? 'Received' : 'Sent';
  }

  loadHistory() {
    const W = window.FoxyWallet;
    if (!W || !W.connected) return;
    // nor the history, which is read mint by mint (`refreshBalance`)
    if (W.awayClaiming && W.awayClaiming()) {
      if (!this._histWhenHome) {
        this._histWhenHome = W.whenHome().then(() => { this._histWhenHome = null; this.loadHistory(); });
      }
      return;
    }
    // change made and never handed over belongs on its payment's entry
    W._onHistoryChanged = () => { clearTimeout(this._histAgainT); this._histAgainT = setTimeout(() => this.loadHistory(), 50); };
    // change that was being shown as a code has been taken: the screen showing it comes down
    W._onChangeTaken = () => { if (this.hideStage) this.hideStage('changeStuck'); this.refreshBalance(); };
    /* While a payment here still shows change to hand over, ask again every
     * fifteen seconds whether it has been taken — the mint is the only one
     * who can say a payer scanned it. One timer, renewed here and nowhere
     * else, and not renewed once nothing is owed or Foxy is not in front. */
    clearTimeout(this._owedPollT);
    try {
      const owing = (this.state.history || []).some(g => g.items.some(t => t.dir === 'in' && t.changeState === 'not handed'));
      if (owing && !document.hidden) this._owedPollT = setTimeout(() => this.loadHistory(), 15000);
    } catch (e) {}
    try { if (W.repairOwedChange) W.repairOwedChange(); } catch (e) {}
    // and entries from before prices were kept stop moving with bitcoin
    try { if (W.stampRates) W.stampRates(); } catch (e) {}
    W.transactions(500).then(all => {
      // One mint at a time: a balance belongs to a mint, so its history should
      // too. Entries written before mints were recorded carry none, and show
      // everywhere rather than vanishing.
      const here = String(W.mintUrl || '').replace(/\/+$/, '');
      const list = all.filter(x => !x.mint || x.mint === here);

      // history already showing money in counts, so the prompt survives a
      // relaunch rather than waiting for the next payment
      if (all.some(x => x.dir === 'in')) this.setState({ everReceived: true });
      const now = new Date();
      const yest = new Date(now.getTime() - 86400000);
      const buckets = { TODAY: [], YESTERDAY: [], EARLIER: [] };
      const seen = {};

      list.forEach(t => {
        const d = this.txWhen(t);
        const key = d.toDateString() === now.toDateString() ? 'TODAY'
          : d.toDateString() === yest.toDateString() ? 'YESTERDAY' : 'EARLIER';
        const meta = W.tagsFor(t.hash) || {};
        /* The take-back of a lost card (RESTORE LOST CARD, `lost`) is in home's list, the one list it can be in, and says what it
         * was: "From card" alone read as a card tapped here. */
        const who = t.lost ? (this.txCardName(t) ? 'Taken back from ' + this.txCardName(t) : 'Taken back from a lost card') : (meta.to || this.txWho(t));
        buckets[key].push({
          name: who,
          /* The detail screen gets the whole address where there is one.
           *
           * `who` is elided to seventeen characters for the tile, which is all
           * the room a row has. The detail screen has a line that wraps, and an
           * address a person cannot read in full cannot be checked against a
           * block explorer — which is the only reason to look at it there. On chain writes `address`; every other rail
           * has no such field and falls back to what it always showed. */
          party: meta.address || who,
          note: meta.note || '',
          hash: t.hash,
          // the card an entry is for (26f-flashcard.js), so one card's entries can be shown on their own
          card: t.card || '',
          // a payment made from a card (SEND on the card's screen): which card, for the line that says so
          fromCard: t.fromCard || '',
          // the take-back of a lost card, which home keeps (26-render-history-and-contacts.js `renderHistory`)
          lost: !!t.lost,
          // and what the wallet called it, which is what a card's own list names it by
          memo: t.memo || '',
          dir: t.dir,
          sats: t.sats,
          fee: t.feeSats,
          // another unit's ecash: its own amount and fee, never shown as sats
          unit: t.unit && t.unit !== 'sat' ? t.unit : '',
          amount: t.amount,
          feeAmount: t.feeAmount,
          // the mint it was at, and for one leg of a swap between balances: the swap, and the mint's rate then
          mint: t.mint || '',
          kind: t.kind || '',
          swap: t.swap || '',
          mintRate: t.mintRate || null,
          rail: 'Lightning',
          time: this.txLabel(d, now),
          // the same moment with its date, for the detail screen
          stamp: this.txStamp(d, now),
          /* A token this wallet sent is pending (amber) until it is known to be
           * redeemed: its text is kept until then (forgetClaimedToken). */
          pending: !t.settled || (t.dir === 'out' && meta.to === 'ecash' && !!meta.token),
          failed: t.state === 'failed',
          /* Taken on trust while both phones were offline, and not swapped in
           * yet: the payer can still spend their copy back. Read off the log
           * entry the arrival wrote, and true only while it is still waiting —
           * the claim settles the same entry, and a settled one is ordinary
           * money (20-helpers.js, `trusted`). */
          atRisk: !!t.trusted && !t.settled && t.state !== 'failed',
          /* Paid by a card while this phone was offline: received and counted, and the mint has still to swap what the
           * card signed over (08a-flashcard.js, `cardKeepSigned`). Nobody else can take it, so it is amber and not red;
           * `cardKept` is how it ended where it did not settle (spent, retired, unwound), and `cardDate` the date it must
           * settle by (0: none). */
          cardWaits: t.cardKept === 'waiting' && t.state !== 'failed',
          cardKept: t.cardKept || '',
          cardDate: Number(t.cardDate) || 0,
          // 'signature' where the mint refused the card's signature, which is said as that
          cardWhy: t.cardWhy || '',
          /* Refused over the link with nothing sent back, or locked to a
           * phone that then refused it: seen by them, not safe yet. */
          highRisk: !!t.highRisk,
          /* An over-payment and its change are one transaction, and the list
           * shows the net. These carry the other two figures through to the
           * detail screen, which is where a person looks when a payment did not
           * match what they expected — and what they send in a report about it. Absent on every ordinary payment. */
          grossSats: Number(t.grossSats) || 0,
          changeSats: Number(t.changeSats) || 0,
          // the same two on a row in another unit (dollars): its own names, in cents, never in the sat ones
          grossAmount: Number(t.grossAmount) || 0,
          changeAmount: Number(t.changeAmount) || 0,
          changeState: t.changeState || '',
          // dollars per bitcoin when this settled; its dollar figures come from this and nothing else
          rate: Number(t.rate) || 0,
          token: meta.token || '',
          // the same text after it was claimed, kept to be shown; and the change this phone made for a payer
          kept: meta.kept || '',
          changeToken: meta.changeToken || '',
          // change that came back for a payment: a row of its own, already netted on that payment
          changeRow: !!meta.change || /^(tap|req)-change-/.test(String(t.hash || '')),
          /* This payment crossed a Bluetooth link. Its token may be shown again
           * to the same person; it may not be taken back. */
          handedByTap: meta.handed === 'tap',
          /* The mint's word for where the money went on chain: `txid:vout` from
           * the NUT-30 melt quote, kept as the transaction id alone. Empty
           * until the mint has broadcast — it answers `outpoint: null` before
           * that — and empty for every other rail. */
          txid: meta.txid || '',
          /* A Lightning payment's preimage, when the mint gave one: the proof
           * that the invoice was paid, for the detail screen. */
          preimage: t.preimage || '',
          // and on a receive, the payment hash of the invoice this phone made
          payHash: t.payHash || '',
          /* Sats paid for dollars asked for: the dollars asked (cents), the
           * payer's price and how old it was, and how the swap into dollars
           * went (20-helpers.js, `termsFields`; 16b-two-balances.js,
           * `convertOne`). For reading only; the books never look at them. */
          usdAsked: Number(t.usdAsked) || 0,
          // and the mirror, on a dollar row: the sats asked of a dollar card, whose price, and what the swap into bitcoin gave
          satsAsked: Number(t.satsAsked) || 0,
          askOwn: !!t.askOwn,
          convertSats: t.convertSats == null ? null : Number(t.convertSats),
          askRate: Number(t.askRate) || 0,
          askAgeMs: t.askAgeMs == null ? null : Number(t.askAgeMs),
          askSeenAt: Number(t.askSeenAt) || 0,
          convert: t.convert || '',
          convertSwap: t.convertSwap || '',
          convertUsd: t.convertUsd == null ? null : Number(t.convertUsd),
          convertWhy: t.convertWhy || '',
        });
        // Anyone address-shaped is saved to the book on sight, once.
        //
        // Contacts used to be the book plus whatever history happened to
        // contain, recomputed on every load — so clearing history also
        // cleared half the contact list. Writing them through means the two
        // are independent: clear history and the names stay; clear contacts
        // and history does not put them back.
        if (who.indexOf('@') > 0 && !seen[who.toLowerCase()]) {
          seen[who.toLowerCase()] = true;
          if (W.remember && !this._contactsCleared) W.remember(who, who.split('@')[0]);
        }
      });

      // a bill still being collected sits at the top, above settled payments.
      // Reconcile first: these transactions are exactly what tells us a share
      // has landed, and a watch may have died without noticing.
      if (W.splitReconcile && !this._spReconciling) {
        this._spReconciling = true;
        W.splitReconcile().then(n => {
          this._spReconciling = false;
          /* Always, not only when this run marked something: the collecting
           * screen's tally is a copy of the ledger's, and this is where the
           * two are put back together whoever settled the row (spSyncPaid). */
          this.spSyncPaid();
          if (n) { this.refreshBalance(); this.loadHistory(); }
        }).catch(() => { this._spReconciling = false; });
      }
      const sp = W.splitPending && W.splitPending();
      // a finished split is kept until its screen is dismissed; it does not
      // belong in history claiming 0 of 3 still owed
      if (sp && !sp.done) {
        const owed = sp.rows.filter(r => !r.paid).length;
        buckets.TODAY.unshift({
          name: 'Split \u2014 ' + owed + ' of ' + sp.rows.length + ' still owed',
          party: 'Split the bill',
          note: '',
          hash: 'split-pending',
          dir: 'in',
          sats: sp.rows.filter(r => !r.paid).reduce((a, r) => a + (r.sats || 0), 0),
          fee: 0,
          rail: 'Lightning',
          time: 'Collecting',
          pending: true,
          split: true,
          token: '',
        });
      }

      /* A card's restore asked before its date (26f-flashcard.js `fcRestoreRows`): pending at the top, as a bill being collected is,
       * and in no balance until the wallet takes it back on its date, when the take-back's own entry is its row. */
      if (this.fcRestoreRows) this.fcRestoreRows(here).forEach(r => buckets.TODAY.unshift(r));

      const history = ['TODAY', 'YESTERDAY', 'EARLIER']
        .map(label => ({ label: label, items: buckets[label] }))
        .filter(g => g.items.length);

      // saved addresses first, then anything the payments implied
      const book = (W.book() || []).map(c => ({
        name: c.name, handle: c.handle,
        tint: 'var(--acc)',
      }));
      // the book is the whole list now; remember() above has written to it
      const merged = W.book().map((c, i) => ({
        name: c.name, handle: c.handle,
        tint: ['var(--acc)', '#5B45D0', '#0E9E93', '#D4409A', '#2E7CF6', '#E0602E'][i % 6],
      }));

      // Everything settled that has not been announced yet. Incoming ones queue
      // up and are shown one at a time, each waiting for its own dismissal, so
      // coming back to four payments means four confirmations in order rather
      // than one screen standing in for all of them.
      /* A mint switch is not a wave of arrivals.
       *
       * _seenTx is seeded by the first history load, and everything after is
       * a new arrival. Switching mints loads a different mint's transactions,
       * none of which are in _seenTx — so all of them were announced. Eight
       * confirmation screens in a row, each waiting to be dismissed.
       *
       * The seed belongs to a mint. The first load on a mint seeds quietly,
       * however many mints came before it. */
      const W0 = window.FoxyWallet;
      const mintNow = (W0 && W0.mintHost && W0.mintHost()) || '';
      if (this._seededFor !== mintNow) {
        this._seenSeeded = false;
        this._seededFor = mintNow;
      }

      const fresh = [];
      // the card payments that pay a share of the bill being collected, which its own screens report (`splitCardEntries`)
      const shareCards = this.splitCardEntries();
      list.forEach(t => {
        /* Money written down and not yet swapped in, which the person has
         * already been shown.
         *
         * An offline receive tells them at the moment it arrives — the amount
         * is on screen, and the row goes into history as PENDING, which is
         * true. Settling it later changes nothing they need to act on: the
         * ecash was locked to this phone from the start, their own twelve words
         * open it, and `forwardLocked` lets them spend it before it settles.
         * Nothing was ever at risk and nothing was ever unavailable.
         *
         * Skipped outright, the pending row was never marked seen — so the
         * moment the route came back, settling it read as a brand-new payment
         * and threw a confirmation screen over whatever they were doing. Three
         * of them in nine seconds, for payments they had already been told
         * about. Marked as seen on the way past, the settle is the
         * bookkeeping it always was.
         *
         * A payment that arrives while the app is closed is not this: it is
         * never pending on a screen anybody is looking at, so it lands settled,
         * has never been seen, and is announced exactly as before. */
        if (!t.settled) { this.txIsNew(t.hash); return; }
        // the balance carried forward past a cleared history is not a payment
        if (t.memo === 'opening') { this.txIsNew(t.hash); return; }
        /* Change handed back to somebody who over-paid is the tail of a payment
         * that has already been confirmed, not a payment of its own. It was
         * announced as one: 3 sats sold, a confirmation for 4, and then a
         * second for 1 sat withdrawn. It is still
         * in the list, where it belongs; it just does not interrupt anybody. */
        const tags = W.tagsFor(t.hash) || {};
        if (tags.change) { this.txIsNew(t.hash); return; }
        /* Money moved between this phone and a card somebody was holding to
         * it: a top-up, a withdrawal, a renewal, a lost card taken back. The
         * FLASHCARD screens say how each went, at the moment it did, and a
         * confirmation screen a second later would say it twice. A payment
         * taken from a card is not this: it is tagged apart and announced like
         * any other. */
        if (tags.to === 'card') { this.txIsNew(t.hash); return; }
        /* A card's payment of a share of a split bill, which the bill's row
         * names: the bill's own screens report it, as they report a share paid
         * over the tap, so it is not announced as well, however late it
         * settles. A bill that has been stopped names none, and then it is
         * announced like any other payment. */
        if (shareCards[t.hash]) { this.txIsNew(t.hash); return; }
        /* Still on its way to somebody. The entry exists because the token
         * does; the payment has not happened yet, and announcing it is how the
         * payer came to see a confirmation of withdrawal while the receiver was
         * still reading a card. `requestDelivered` clears
         * the mark and announces it at the moment it is true. */
        if (tags.inflight) return;
        /* Another unit's receive is confirmed where it was taken; this screen
         * counts sats. Except dollars at a mint with two balances, which this
         * screen shows as dollars; and never a leg of a swap between them,
         * which its own screen reports. */
        const usdHere = t.unit === 'usd' && !!(this.twoUnitsOn && this.twoUnitsOn());
        if (t.kind === 'swap') { this.txIsNew(t.hash); return; }
        if (this.txIsNew(t.hash) && (!(t.unit && t.unit !== 'sat') || usdHere)) fresh.push(t);
      });
      this._seenSeeded = true;

      // oldest first: they arrived in that order, so they should be shown in it.
      // Sent payments queue too — one you made from elsewhere deserves the same
      // confirmation as one that arrived.
      if (fresh.length) {
        this._paidQueue = (this._paidQueue || []).concat(fresh.slice().reverse());
        this.nextPaidScreen();
      }

      this.setState({
        book: W.book(),
        history: history,
        // five hundred is the most kept; fewer means this is every entry there is
        historyComplete: all.length < 500,
        txs: buckets.TODAY.concat(buckets.YESTERDAY).slice(0, 3).map(t => ({
          name: t.name, dir: t.dir, sats: t.sats, time: t.time, rail: 'LIGHTNING', fee: t.fee || 0,
          // what the detail screen names the network by
          hash: t.hash, memo: t.memo,
        })),
        contacts: merged,
      });
    }).catch(() => {});
  }
