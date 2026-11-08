  /* ---- tips at the till, and CASHIER CODES as a list --------------------------------------------------------------------
   *
   * The wallet's half is 08f-till-tips.js. Here, every screen one the app has:
   *
   *   ACCEPT TIPS? .......... a card (`blockedCard`), YES / NO, after the till's opening steps (the lock, the mints, the
   *                           default mint, the default currency) and for each new CASHIER CODE, the till's answer first.
   *   TIPS GO TO ............ a card: MYSELF, ONE PERSON, GROUP.
   *   ONE PERSON ............ the SWITCH MINT list (`tillList` 'person'): the Cashu ID contacts, PASTE A CASHU ID (a card
   *                           with a field) and SCAN A CASHU ID; an ID that is not a contact is named first, on the
   *                           contacts' own NAME THIS CONTACT? card, and kept as one.
   *   GROUP ................. the same list (`tillList` 'group'): up to eight rows, each a Cashu ID and its share, ADD and
   *                           SAVE, SAVE grey until the shares add up to 100%. A row tapped asks its share on a card with a
   *                           field, or REMOVE. A row added takes what is left of the 100%.
   *   the tip buttons ....... $1, $2, $5 and OTHER under the amount on the till's receive screen, where its tips are on: the
   *                           request and invoice are live at the amount typed; a tip re-makes them for the total, the same
   *                           tip again takes it off, and OTHER asks the tip on SET AMOUNT. One payment for the total.
   *   CASHIER CODES ......... the list again (`tillList` 'codes'): the live codes, each a row with its label, mints, currency,
   *                           tips and when it ends; ADD A CASHIER makes another (its own tips asked); a row shows its QR
   *                           again with END THIS CODE; ended and run-out codes under PAST, with when they ran and how they
   *                           ended. No totals of any kind.
   *
   * `state.till.tips` is the keeper's answer, { on, to, ids } as the wallet keeps it; a cashier's code says only whether its
   * till offers tips (`pass.tips`). `state.tillTip`, while a tip is on the receive screen: { cents, num, den, base, pick },
   * the tip in cents, the share of the payment that is tip as num/den in the keypad's unit, and the amount typed before it. */

  TILL_TIP_PICKS = [100, 200, 500];
  TILL_GROUP_MAX = 8;

  // ---- whether this till offers tips ----

  /** Whether the till open on this phone offers tips: the keeper's answer, or the cashier's code. */
  tillTipsOn() {
    const t = this.state && this.state.till;
    if (!t) return false;
    if (t.role === 'cashier') return !!(t.pass && t.pass.tips === true);
    return !!(t.tips && t.tips.on);
  }

  // what an answer says, in a few words: for the rows of the codes' list and the opening toast
  tillTipsWords(tips) {
    const t = tips || {};
    if (!t.on) return 'No tips';
    if (t.to === 'self') return 'Tips to you';
    const names = (t.names || (t.ids || []).map((r) => r.name)).filter(Boolean);
    if (t.to === 'one') return 'Tips to ' + (names[0] || 'one person');
    return 'Tips split ' + names.length + ' ways';
  }

  // ---- the questions: ACCEPT TIPS?, TIPS GO TO, ONE PERSON, GROUP ----

  /* Asks for an answer, the till's `def` first where it had one, and gives it to `done`; `cancel` where the person walks away
   * (taps outside a card, or backs off the first). */
  tillTipsAsk(def, done, cancel) {
    const d = def && def.on ? def : null;
    this._tillTipsFlow = { def: d, done: typeof done === 'function' ? done : () => {}, cancel: typeof cancel === 'function' ? cancel : () => {} };
    this.tillTipsAskYes();
  }

  // a card that calls `cancel` where it closes with no answer
  tillTipsCard(kind, spec) {
    let answered = false;
    const mark = (fn) => (...a) => { answered = true; if (fn) fn(...a); };
    const flow = this._tillTipsFlow;
    const over = Object.assign({}, spec, {
      go: spec.go ? mark(spec.go) : undefined,
      shut: spec.shut ? Object.assign({}, spec.shut, { tap: mark(spec.shut.tap) }) : undefined,
      pills: (spec.pills || []).map((p) => Object.assign({}, p, { tap: mark(p.tap) })),
      onClose: () => setTimeout(() => {
        if (answered || this._tillTipsFlow !== flow || !flow) return;
        this._tillTipsFlow = null;
        console.log('[foxy] till: the tips question was left unanswered');
        flow.cancel();
      }, 0),
    });
    this.blockedCard(kind, over);
  }

  tillTipsAskYes() {
    const f = this._tillTipsFlow;
    if (!f) return;
    this.tillTipsCard('tillTipsAsk', {
      tone: 'ask', title: 'ACCEPT TIPS?',
      reason: 'Payers see $1, $2, $5 and OTHER beside the amount. The tip is part of the one payment.',
      chip: f.def ? 'Now: ' + this.tillTipsWords(f.def) : '',
      retry: 'YES', go: () => this.tillTipsAskTo(),
      shut: { label: 'NO', pill: true, tap: () => this.tillTipsDone({ on: false, to: 'self', ids: [] }) },
    });
  }

  tillTipsAskTo() {
    const f = this._tillTipsFlow;
    if (!f) return;
    this.tillTipsCard('tillTipsTo', {
      tone: 'ask', title: 'TIPS GO TO',
      reason: 'You, one person, or a group of up to 8 who share each tip by the percentages you set.',
      pills: [
        { label: 'MYSELF', tap: () => this.tillTipsDone({ on: true, to: 'self', ids: [] }) },
        { label: 'ONE PERSON', tap: () => this.tillPersonOpen('one') },
        { label: 'GROUP', tap: () => this.tillGroupOpen() },
      ],
      pillsFirst: true,
      shut: { label: 'BACK', tap: () => this.tillTipsAskYes() },
    });
  }

  // an answer: checked by the wallet where it can be, then handed on
  tillTipsDone(tips) {
    const W = window.FoxyWallet;
    const f = this._tillTipsFlow;
    if (!f) return false;
    const why = (W && W.tillTipsProblem) ? W.tillTipsProblem(tips) : '';
    if (why) { this.toast(why, true); return false; }
    this._tillTipsFlow = null;
    // off ONE PERSON or GROUP, where the answer was given there (CASHIER CODES, under them, stays)
    if (this.state.tillList === 'person' || this.state.tillList === 'group') this.tillListLeave();
    f.done(tips);
    return true;
  }

  // the list screen (SWITCH MINT's) in one of the till's modes, pushed once and then changed in place
  /* (from CASHIER CODES, whose ADD A CASHIER asks who a code's tips go to, the list comes back to the codes after: `tillListBackTo`) */
  tillListGo(mode, extra) {
    if (this.state.screen === 'switchMint' && this.state.tillList) {
      const back = this.state.tillList === 'codes' ? { tillListBackTo: 'codes' } : {};
      this.setState(Object.assign({ tillList: mode }, back, extra || {}));
      return;
    }
    this.goSwitchMint(Object.assign({ tillList: mode }, extra || {}));
  }

  // off the list, back to the screen under it
  tillListLeave() {
    if (this.state.screen === 'switchMint' && this.state.tillListBackTo && this.state.tillList !== this.state.tillListBackTo) {
      this.setState((p) => ({ tillList: p.tillListBackTo, tillListBackTo: false }));
      return;
    }
    if (this.state.screen !== 'switchMint' || !this.state.tillList) { if (this.state.tillList) this.setState({ tillList: false }); return; }
    this.setState((p) => ({ screen: (p.stack || []).length ? p.stack[p.stack.length - 1] : 'home', stack: (p.stack || []).slice(0, -1), tillList: false }));
  }

  /* ONE PERSON (`for` 'one'), or a row to ADD to the group (`for` 'group'): the contacts that are Cashu IDs, and the two ways in
   * for one that is not. */
  tillPersonOpen(forWhat) {
    this.tillListGo('person', { tillPersonFor: forWhat === 'group' ? 'group' : 'one' });
  }

  // the Cashu ID contacts, those in the group already left out
  tillPersonRows() {
    const W = window.FoxyWallet;
    let list = [];
    try { list = (W && W.cashuIdContacts) ? W.cashuIdContacts() : []; } catch (e) { list = []; }
    const inGroup = this.state.tillPersonFor === 'group' ? (this.state.tillGroup || []).map((r) => r.id) : [];
    return (Array.isArray(list) ? list : []).filter((c) => c && c.cid && inGroup.indexOf(c.cid.id) < 0)
      .map((c) => ({ id: c.cid.id, nostr: c.cid.nostr, name: String(c.name || 'Cashu ID') }));
  }

  // a person picked, a contact or an ID just named: the answer for ONE PERSON, or a row of the group
  tillPersonPick(p) {
    if (!p || !p.id) return;
    if (this.state.tillPersonFor === 'group') {
      const rows = (this.state.tillGroup || []).filter((r) => r.id !== p.id);
      if (rows.length >= this.TILL_GROUP_MAX) { this.toast('A group is ' + this.TILL_GROUP_MAX + ' Cashu IDs at most.', true); return; }
      // what is left of the 100%, so the last one added makes it whole
      const left = Math.max(0, 100 - rows.reduce((n, r) => n + (Number(r.pct) || 0), 0));
      this.setState({ tillList: 'group', tillGroup: rows.concat([{ id: p.id, nostr: p.nostr, name: p.name, pct: left }]) });
      return;
    }
    this.tillTipsDone({ on: true, to: 'one', ids: [{ id: p.id, nostr: p.nostr, name: p.name, pct: 100 }] });
  }

  // PASTE A CASHU ID: a card with a field to paste it into
  tillIdPaste() { this.cidPasteCard('tillIdPaste', (text) => this.tillIdRead(text)); }

  // SCAN A CASHU ID: the camera
  tillIdScan() {
    const W = window.FoxyWallet;
    if (!W || !W.scan) return;
    Promise.resolve(W.scan('Scan a Cashu ID')).then((text) => { if (String(text || '').trim()) this.tillIdRead(text); }).catch(() => {});
  }

  /* An ID pasted or scanned: refused in the contacts' own words; this phone's own is MYSELF; a contact is picked by its name; any
   * other is named first (NAME THIS CONTACT?, as a contact added by paste is) and kept as a contact, then picked. */
  tillIdRead(text) {
    const W = window.FoxyWallet;
    const t = String(text || '').trim();
    if (!W || !W.cashuIdCheck) return;
    Promise.resolve(W.cashuIdCheck(t)).then((r) => {
      if (r.own) {
        this.blockedCard('cidOwn', {
          tone: 'warn', title: 'THIS IS YOUR CASHU ID',
          reason: 'Tips to you need no Cashu ID: pick MYSELF instead.',
        });
        return;
      }
      if (r.name) { this.tillPersonPick({ id: r.id, nostr: r.nostr, name: r.name }); return; }
      this.blockedCard('cidName', {
        tone: 'ask', title: 'NAME THIS CONTACT?',
        reason: 'A Cashu ID from another Foxy. Give it a name: its tips say who they went to.',
        field: { value: '', placeholder: 'Name', max: 40 },
        retry: 'SAVE', go: (name) => this.tillIdKeep(t, name),
        shut: { label: 'CANCEL' },
      });
    }).catch((e) => {
      this.blockedCard('cidBad', {
        tone: 'warn', title: 'THAT WON’T WORK',
        reason: (W.reason ? W.reason(e) : String((e && e.message) || e)) || 'That is not a Cashu ID.',
        chip: 'Ask them to share it again.',
      });
    });
  }

  // named: kept as a contact (`cashuIdAdd`), then picked; with no name, asked again
  tillIdKeep(text, name) {
    const W = window.FoxyWallet;
    const clean = String(name || '').trim();
    if (!clean) { this.toast('Give it a name first.', true); this.tillIdRead(text); return; }
    Promise.resolve(W.cashuIdAdd(text, clean)).then((c) => {
      this.setState({ contacts: (W.book && W.book()) || this.state.contacts });
      const cid = (c && c.cid) || {};
      this.tillPersonPick({ id: cid.id, nostr: cid.nostr, name: (c && c.name) || clean });
    }).catch((e) => this.toast(W.reason ? W.reason(e) : String((e && e.message) || e), true));
  }

  // GROUP: the list, from the answer before where it was a group
  tillGroupOpen() {
    const f = this._tillTipsFlow;
    const def = f && f.def && f.def.to === 'group' ? (f.def.ids || []).map((r) => Object.assign({}, r)) : [];
    this.tillListGo('group', { tillGroup: def });
  }

  // the shares added up, and whether SAVE can be pressed
  tillGroupSum() { return (this.state.tillGroup || []).reduce((n, r) => n + (Number(r.pct) || 0), 0); }
  tillGroupReady() {
    const g = this.state.tillGroup || [];
    return g.length > 0 && g.length <= this.TILL_GROUP_MAX && this.tillGroupSum() === 100 && g.every((r) => Number(r.pct) >= 1);
  }

  // a row tapped: its share, typed, or REMOVE
  tillGroupRow(id) {
    const row = (this.state.tillGroup || []).find((r) => r.id === id);
    if (!row) return;
    this.blockedCard('tillGroupRow', {
      tone: 'ask', title: String(row.name || 'CASHU ID').toUpperCase(),
      reason: 'Its share of every tip, in whole percent. The shares add up to 100%.',
      field: { value: String(Number(row.pct) || ''), placeholder: '%', max: 3 },
      retry: 'SET', go: (v) => this.tillGroupPct(id, v),
      pills: [{ label: 'REMOVE', tap: () => this.setState((p) => ({ tillGroup: (p.tillGroup || []).filter((r) => r.id !== id) })) }],
      shut: { label: 'CANCEL' },
    });
  }

  tillGroupPct(id, v) {
    const n = Number(String(v || '').replace(/[%\s]/g, ''));
    if (!(Math.floor(n) === n && n >= 1 && n <= 100)) { this.toast('A share is a whole percent from 1 to 100.', true); return; }
    this.setState((p) => ({ tillGroup: (p.tillGroup || []).map((r) => (r.id === id ? Object.assign({}, r, { pct: n }) : r)) }));
  }

  tillGroupSave() {
    if (!this.tillGroupReady()) {
      const g = this.state.tillGroup || [];
      this.toast(g.length ? 'The shares add up to ' + this.tillGroupSum() + '%. Make them 100%.' : 'Add someone first.', true);
      return;
    }
    this.tillTipsDone({ on: true, to: 'group', ids: (this.state.tillGroup || []).map((r) => ({ id: r.id, nostr: r.nostr, name: r.name, pct: Number(r.pct) })) });
  }

  /* The round back button on the till's lists (01-ui-basics.js `back`, through `tillOpenBack`): off a person picked for the group,
   * the group; off ONE PERSON or GROUP, TIPS GO TO again; off the codes, the till. True where it was handled. */
  tillListBack() {
    const s = this.state || {};
    if (s.screen !== 'switchMint' || !s.tillList) return false;
    if (s.tillList === 'person' && s.tillPersonFor === 'group') { this.setState({ tillList: 'group' }); return true; }
    if (s.tillList === 'person' || s.tillList === 'group') {
      this.tillListLeave();
      if (this._tillTipsFlow) this.tillTipsAskTo();
      return true;
    }
    this.tillListLeave();
    return true;
  }

  /* What the list draws in the till's modes (27-render-mints-restore-backup.js, `renderMints`): its title, the line under it,
   * its rows in the mint rows' shape, the PAST rows, and its two buttons. Null outside them. */
  tillListVals(row0) {
    const s = this.state || {};
    const mode = s.tillList;
    if (!mode) return null;
    const plainRow = (o) => Object.assign({
      dim: '1', down: false, downText: '', tint: 'var(--acc)', logo: 'none', here: false, notHere: true,
      ink: 'rgba(var(--ink-rgb),.55)', busy: false, bg: 'var(--surface)', border: 'rgba(var(--ink-rgb),.12)',
    }, o, { initial: String(o.name || '?').slice(0, 1).toUpperCase() });
    if (mode === 'person') {
      const rows = this.tillPersonRows().map((p) => plainRow({ name: p.name, host: 'Cashu ID', text: '', tap: () => this.tillPersonPick(p) }));
      return {
        title: s.tillPersonFor === 'group' ? 'ADD TO THE GROUP' : 'TIPS GO TO',
        line: rows.length ? 'Pick a contact, or paste or scan their Cashu ID.' : 'No Cashu ID contacts yet. Paste or scan one.',
        rows, past: [],
        add: { shown: true, label: 'PASTE A CASHU ID', tap: () => this.tillIdPaste() },
        next: { shown: true, on: true, label: 'SCAN A CASHU ID', tap: () => this.tillIdScan() },
      };
    }
    if (mode === 'group') {
      const g = s.tillGroup || [];
      const sum = this.tillGroupSum();
      const rows = g.map((r) => plainRow({ name: r.name, host: 'Cashu ID', text: (Number(r.pct) || 0) + '%',
        ink: Number(r.pct) >= 1 ? 'var(--acc-ink)' : 'var(--bad)', tap: () => this.tillGroupRow(r.id) }));
      return {
        title: 'GROUP',
        line: g.length ? 'The shares add up to ' + sum + '% of 100%. Tap one to change it.' : 'Up to ' + this.TILL_GROUP_MAX + ' Cashu IDs, each with its share of every tip.',
        rows, past: [],
        add: { shown: g.length < this.TILL_GROUP_MAX, label: 'ADD', tap: () => this.tillPersonOpen('group') },
        next: { shown: true, on: this.tillGroupReady(), label: 'SAVE', tap: () => this.tillGroupSave() },
      };
    }
    // 'codes'
    const W = window.FoxyWallet;
    let list = { live: [], past: [] };
    try { list = (W && W.tillPassList) ? W.tillPassList() : list; } catch (e) { list = { live: [], past: [] }; }
    const cur = (v) => (v.unit === 'both' ? 'dollars or bitcoin' : v.unit === 'usd' ? 'dollars' : 'bitcoin');
    const where = (v) => {
      const m = (v.mints || []).filter(Boolean);
      return m.length ? this.mintNameOf(m[0]) + (m.length > 1 ? ' +' + (m.length - 1) : '') : '';
    };
    const name = (v, i) => v.label || 'Cashier code ' + (i + 1);
    const live = (list.live || []).map((v, i) => plainRow({
      name: name(v, i), host: [where(v), cur(v), this.tillTipsWords(v.tips), 'Ends ' + this.tillExpiresText(v.exp)].filter(Boolean).join(' · '),
      text: 'LIVE', ink: 'var(--ok-ink)', tap: () => this.tillCodeOpen(v, name(v, i)),
    }));
    const past = (list.past || []).map((v) => plainRow({
      name: v.label || 'Cashier code', dim: '0.7',
      host: [where(v), cur(v), this.tillTipsWords(v.tips),
        this.tillExpiresText(Math.floor(v.made / 1000)) + ' – ' + this.tillExpiresText(Math.floor(v.until / 1000))].filter(Boolean).join(' · '),
      text: v.how === 'ended' ? 'ENDED' : 'EXPIRED', tap: () => {},
    }));
    return {
      title: 'CASHIER CODES',
      line: live.length ? 'Each cashier scans a code of their own. Money they take is locked to this phone and sent here.'
        : 'No code is live. ADD A CASHIER makes one for another Foxy to scan.',
      rows: live, past,
      add: { shown: false, label: '', tap: () => {} },
      next: { shown: true, on: true, label: 'ADD A CASHIER', tap: () => this.tillCodeAdd() },
    };
  }

  // ---- CASHIER CODES ----

  // the keeper's code button on the till's SET AMOUNT, past the lock: the list
  tillCodesShow() { this.tillListGo('codes'); }

  // a live code tapped: its QR again, with END THIS CODE
  tillCodeOpen(v, label) {
    if (!v || !v.text) return;
    this.stageScreen('tillPass', {
      art: '', title: 'CASHIER CODE', qr: String(v.text),
      body: String(label || 'Cashier code') + ' · ' + this.tillTipsWords(v.tips)
        + '<br>Expires ' + this.tillExpiresText(v.exp),
      above: 'END THIS CODE',
      aboveGo: () => this.tillCodeEndAsk(v, label),
      button: 'DONE',
    });
  }

  tillCodeEndAsk(v, label) {
    const W = window.FoxyWallet;
    this.blockedCard('tillCodeEnd', {
      tone: 'ask', title: 'END THIS CODE?',
      reason: String(label || 'This code') + ' comes off the list. A cashier already working by it is not told, and anything they still send is taken here.',
      retry: 'END', go: () => {
        this.hideStage('tillPass');
        const done = !!(W && W.tillPassEnd && W.tillPassEnd(v.id));
        this.setState({ menuTick: (this.state.menuTick || 0) + 1 });
        this.toast(done ? 'Ended' : 'That code has ended already');
      },
      shut: { label: 'BACK' },
    });
  }

  /* ADD A CASHIER: a name for its row, then its tips (the till's answer first), then the code. */
  tillCodeAdd() {
    this.blockedCard('tillCodeName', {
      tone: 'ask', title: 'NAME THIS CODE?',
      reason: 'So you can tell your cashiers’ codes apart. Only this phone sees it.',
      field: { value: '', placeholder: 'Cashier', max: 24 },
      retry: 'NEXT', go: (label) => {
        const till = this.state.till || {};
        this.tillTipsAsk(till.tips, (tips) => this.tillPassShow({ fresh: true, tips: tips, label: String(label || '').trim() }), () => {});
      },
      shut: { label: 'CANCEL' },
    });
  }

  // ---- the keeper's answer as the till opens ----

  /* The till's opening, once its mints and currency are known (`tillAtMints`, `tillAskMain`): ACCEPT TIPS?, the answer kept with
   * the till (`tillTipsSet`), then the till. Walked away from, no till: the wallet's record let go and the phone home from a visit
   * to the default, as back off DEFAULT CURRENCY does. */
  tillTipsThen(o, moved) {
    const W = window.FoxyWallet;
    this.tillTipsAsk(null, (tips) => {
      try { if (W && W.tillTipsSet) W.tillTipsSet(tips); }
      catch (e) { this.toast(W.reason ? W.reason(e) : String((e && e.message) || e), true); return; }
      this.tillStart(Object.assign({}, o, { tips }));
    }, () => {
      console.log('[foxy] till: no answer to ACCEPT TIPS?; no till');
      Promise.resolve(W && W.tillKeeperClose ? W.tillKeeperClose() : null)
        .then((b) => { if (moved || (b && b.moved)) this.walletReady({ name: this.mintHost() }); }, () => {});
    });
  }

  // ---- the tip buttons on the till's receive screen ----

  // the tip on screen, or null
  tillTipNow() {
    const s = this.state || {};
    const t = s.tillTip;
    return s.till && t && Number(t.den) > 0 && Number(t.num) > 0 ? t : null;
  }

  // the part of `n` (sats or cents, whichever unit `n` is in) that is the tip: rounded down, never more than `n`
  tillTipPartOf(n) {
    const t = this.tillTipNow();
    const v = Math.floor(Number(n) || 0);
    if (!t || !(v > 0)) return 0;
    return Math.min(v, Math.floor(v * Number(t.num) / Number(t.den)));
  }

  // a cashier's request or invoice: the tip part named for the wallet to tell the keeper (`tillTip`), {} otherwise
  tillTipOpt(n) {
    if (!(this.tillRole && this.tillRole() === 'cashier')) return {};
    const k = this.tillTipPartOf(n);
    return k > 0 ? { tillTip: k } : {};
  }

  // what a cashier's request is kept under, beside its amount: one with a tip is never handed out for one without
  tillTipKey() {
    const t = this.tillTipNow();
    return t && this.tillRole && this.tillRole() === 'cashier' ? '|tip' + t.num + '/' + t.den : '';
  }

  /* A tip button: the amount becomes the total, typed in the keypad's own unit, and the request and invoice are made again for
   * it. The same button again takes the tip off. `which` is 100, 200, 500 or 'other'. */
  tillTipPick(cents, which) {
    const s = this.state;
    const cur = s.tillTip;
    const base = cur ? String(cur.base) : String(s.amount || '');
    if (cur && cur.pick === which && which !== 'other') {
      this.setState({ amount: base, tillTip: null });
      console.log('[foxy] till: the tip is off');
      this.tillTipRemake();
      return;
    }
    const c = Math.round(Number(cents) || 0);
    if (!(c > 0)) { this.setState({ amount: base, tillTip: null }); this.tillTipRemake(); return; }
    let amount, num, den;
    if (s.unit === 'SATS') {
      const px = this.px ? this.px() : 0;
      if (!(px > 0)) { this.toast('A tip in dollars needs the price, and there is none yet.', true); return; }
      const b = Math.round(parseFloat(base) || 0);
      num = Math.round(c / 100 / px * 1e8);
      den = b + num;
      amount = String(den);
    } else {
      const b = Math.round((parseFloat(base) || 0) * 100);
      num = c;
      den = b + c;
      amount = den % 100 ? (den / 100).toFixed(2) : String(den / 100);
    }
    if (!(num > 0) || !(den > 0)) return;
    this.setState({ amount, tillTip: { cents: c, num, den, base, pick: which } });
    console.log('[foxy] till: a tip of $' + (c / 100).toFixed(2) + ' added');
    this.tillTipRemake();
  }

  /* The receive screen's invoice made again for the amount now on it. Its Cashu request follows the amount by itself (kept per
   * amount, `railRequest`), and a tap offers what is on screen when the phones meet. */
  tillTipRemake() {
    if (this.state.screen !== 'confirm') return;
    this.openReceive();
  }

  // OTHER: SET AMOUNT for the tip, dollars first, the sale's amount kept to come back to
  tillTipOther() {
    const s = this.state;
    const cur = s.tillTip;
    this._tillTipStash = { amount: cur ? String(cur.base) : String(s.amount || ''), unit: s.unit, tip: cur || null };
    this.setState((p) => ({ screen: 'amount', stack: p.stack.concat([p.screen]), flow: 'tillTip', amount: '', unit: 'USD', tillTip: null }));
  }

  // NEXT on the tip's SET AMOUNT (or its back, with `cents` null): the sale's amount again, with the tip typed on it
  tillTipOtherSet(cents) {
    const st = this._tillTipStash || { amount: '', unit: 'USD', tip: null };
    this._tillTipStash = null;
    this.setState((p) => ({
      screen: (p.stack || []).length ? p.stack[p.stack.length - 1] : 'confirm', stack: (p.stack || []).slice(0, -1),
      flow: 'receive', amount: st.amount, unit: st.unit, tillTip: null,
    }));
    if (cents == null) {
      // back: the tip as it was before OTHER
      if (st.tip) setTimeout(() => this.tillTipPick(st.tip.cents, st.tip.pick), 0);
      return;
    }
    setTimeout(() => this.tillTipPick(cents, 'other'), 0);
  }

  // what the receive screen draws for the tips (24-render-receive-and-send.js)
  tillTipVals(sc) {
    const s = this.state || {};
    const shown = sc === 'confirm' && !!s.till && this.tillTipsOn() && !s.invoiceIsAddress && (parseFloat(s.amount) || 0) > 0;
    const t = this.tillTipNow();
    const chip = (label, which, cents) => {
      const on = !!t && t.pick === which;
      return {
        label: which === 'other' && on ? '$' + (t.cents / 100).toFixed(2) : label,
        bg: on ? 'var(--acc)' : 'var(--chip)', ink: on ? 'var(--acc-ink)' : 'var(--ink)',
        border: on ? 'rgba(var(--acc-rgb),.75)' : 'rgba(var(--ink-rgb),.14)',
        tap: () => (which === 'other' ? (on ? this.tillTipPick(0, 'other') : this.tillTipOther()) : this.tillTipPick(cents, which)),
      };
    };
    /* Folded first: one outlined ADD A TIP in the row's place, which opens the row; a tip chosen keeps it open, and the next
     * sale starts folded again (`tillTipSync`). */
    const open = shown && (!!s.tillTipOpen || !!t);
    return {
      tipRowShown: open,
      tipAddShown: shown && !open,
      tipAdd: () => this.setState({ tillTipOpen: true }),
      tipChips: open ? this.TILL_TIP_PICKS.map((c) => chip('$' + c / 100, c, c)).concat([chip('OTHER', 'other', 0)]) : [],
      tipLine: open && t ? 'Includes a $' + (t.cents / 100).toFixed(2) + ' tip' : open ? 'TIP' : '',
    };
  }

  /* After every render in the till (`syncTill`): the tip on the receive screen is remembered while it is up, since a payment to a
   * request closes that screen before PAID says so; back to the till's SET AMOUNT from it, the amount typed comes back without the
   * tip; and the keeper's PAID passes the tip part on (`tillTipTaken`). */
  tillTipSync(prev) {
    const s = this.state || {};
    const p = prev || {};
    if (!s.till) { this._tillTipDue = null; return; }
    // the tip buttons fold again for the next sale: at the till's SET AMOUNT, or PAID
    if (s.tillTipOpen && ((s.screen === 'amount' && s.flow === 'receive') || s.screen === 'paid')) this.setState({ tillTipOpen: false });
    if (s.screen === 'confirm') {
      const t = this.tillTipNow();
      this._tillTipDue = t ? { t: Object.assign({}, t), at: Date.now() } : null;
    }
    if (p.screen === 'confirm' && s.screen === 'amount' && s.flow === 'receive' && s.tillTip) {
      this.setState({ amount: String(s.tillTip.base), tillTip: null });
      this._tillTipDue = null;
      return;
    }
    if (p.screen !== 'paid' && s.screen === 'paid') this.tillTipPaid();
  }

  // PAID in the keeper's own till: the tip part of what came, to the wallet to pass on; a cashier's goes with its delivery
  tillTipPaid() {
    const W = window.FoxyWallet;
    const s = this.state || {};
    const due = this._tillTipDue;
    this._tillTipDue = null;
    if (!due || Date.now() - due.at > 15 * 60 * 1000) return;
    if (!(this.tillRole && this.tillRole() === 'keeper') || !W || !W.tillTipTaken) return;
    const unit = s.paidUnit === 'usd' ? 'usd' : 'sat';
    const came = Math.floor(Number(s.paidAmount) || 0);
    const tip = Math.min(came, Math.floor(came * Number(due.t.num) / Number(due.t.den)));
    if (!(tip > 0)) return;
    const tips = (s.till && s.till.tips) || {};
    Promise.resolve(W.tillTipTaken({ amount: tip, unit, hash: String(s.paidHash || ''), mint: W.mintUrl })).then((r) => {
      if (r && r.jobs > 0) this.toast('Tip ' + this.unitFigure(tip, unit) + ' · ' + this.tillTipsWords(tips).replace(/^Tips /, 'goes '));
    }, (e) => console.warn('[foxy] till: the tip could not be passed on:', (e && e.message) || e));
  }

  /* A history row's tip, itemized beside its sale as two figures: "sale $10.00 · tip $2.00" (the row's amount is the two
   * together), so a sale that was mostly tip is plain at a glance; and where a tip could not be passed on, that it stayed here. */
  tillTipRowText(t) {
    if (!t || !(Number(t.tillTip) > 0)) return '';
    const unit = t.tillTipUnit === 'usd' ? 'usd' : 'sat';
    const total = Number(t.unit ? t.amount : t.sats);
    const sale = total >= Number(t.tillTip) ? total - Number(t.tillTip) : NaN;
    let words = (isFinite(sale) ? 'sale ' + this.unitFigure(sale, unit) + ' · ' : '') + 'tip ' + this.unitFigure(Number(t.tillTip), unit);
    if (Array.isArray(t.tillTipFailed) && t.tillTipFailed.length) words += ' · not sent to ' + t.tillTipFailed.join(', ') + ', kept';
    return words;
  }
