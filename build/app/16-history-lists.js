
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
    const back = this.recoveringSats();
    return back > 0 ? this.stageMoney(back) + ' being recovered from the mint' : '';
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

  histAudit() {
    const s = this.state;
    const balOf = new Map();
    // the payments a notice on the card is about, and what to call each
    const flagged = new Map();
    const balNow = Math.round(Number(s.balSats) || 0);
    let run = balNow, dueChange = 0, dueCount = 0, toShow = null, toShowSats = 0, toShowCount = 0;
    const seen = { in: 0, out: 0, inSats: 0, outSats: 0, skipped: 0, skippedSats: 0 };
    (s.fresh ? [] : (s.history || [])).forEach(g => g.items.forEach(t => {
      balOf.set(t, run);
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
    const off = whole ? Math.round(run) + held + back + fees : 0;
    /* Said in the log when it changes, with what it was worked out from: a
     * card that says DOES NOT ADD UP and a diary that cannot say why is a
     * report nobody can act on. */
    const sig = [balNow, off, dueChange, toShowCount, seen.in, seen.out, seen.skipped].join('|');
    if (whole && sig !== this._auditSig) {
      this._auditSig = sig;
      console.log('[foxy] audit: balance ' + balNow + ', off by ' + off + '; ' + seen.in + ' in for ' + seen.inSats
        + ', ' + seen.out + ' out for ' + seen.outSats + ', ' + seen.skipped + ' not counted (' + seen.skippedSats
        + ' sats: pending, failed, at risk, a bill, another unit); change due here ' + dueChange
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
    return { balOf, balNow, run, whole, off, held, dueChange, dueCount, toShow, toShowSats, toShowCount, flagged };
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

  CARD_MEMOS = { 'card': 'From a card', 'to card': 'To card', 'from card': 'From card', 'card, not completed': 'Card, not completed' };

  // best guess at who the other side was: a lightning address if one shows up
  // in the payment's metadata, otherwise the memo, otherwise the rail
  txWho(t) {
    const hay = (t.memo || '') + ' ' + JSON.stringify(t.extra || {});
    const m = hay.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    if (m) return m[0];
    // the row clearing history leaves behind: the balance that was there
    if (t.memo === 'opening') return 'Balance carried forward';
    // the wallet's own words for money that moved by a card (08a-flashcard.js)
    if (this.CARD_MEMOS[t.memo]) return this.CARD_MEMOS[t.memo];
    if (t.memo && t.memo.trim() && t.memo !== 'Foxy') return t.memo.trim();
    return t.dir === 'in' ? 'Received' : 'Sent';
  }

  loadHistory() {
    const W = window.FoxyWallet;
    if (!W || !W.connected) return;
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
        const who = meta.to || this.txWho(t);
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
          dir: t.dir,
          sats: t.sats,
          fee: t.feeSats,
          // another unit's ecash: its own amount and fee, never shown as sats
          unit: t.unit && t.unit !== 'sat' ? t.unit : '',
          amount: t.amount,
          feeAmount: t.feeAmount,
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
          /* Refused over the link with nothing sent back, or locked to a
           * phone that then refused it: seen by them, not safe yet. */
          highRisk: !!t.highRisk,
          /* An over-payment and its change are one transaction, and the list
           * shows the net. These carry the other two figures through to the
           * detail screen, which is where a person looks when a payment did not
           * match what they expected — and what they send in a report about it. Absent on every ordinary payment. */
          grossSats: Number(t.grossSats) || 0,
          changeSats: Number(t.changeSats) || 0,
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
        /* Still on its way to somebody. The entry exists because the token
         * does; the payment has not happened yet, and announcing it is how the
         * payer came to see a confirmation of withdrawal while the receiver was
         * still reading a card. `requestDelivered` clears
         * the mark and announces it at the moment it is true. */
        if (tags.inflight) return;
        // another unit's receive is confirmed where it was taken; this screen counts sats
        if (this.txIsNew(t.hash) && !(t.unit && t.unit !== 'sat')) fresh.push(t);
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
