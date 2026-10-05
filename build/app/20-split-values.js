
  shellRef = React.createRef();
  // ---- Split a bill ----
  // Self-contained: every state key is sp-prefixed and every hole is sp-namespaced, so
  // nothing here can collide with an existing screen. The flow ends by handing off to
  // the app's own send scanner.
  spMoney(c) { return '$ ' + this.usd(c / 100); }
  spCents() { return parseInt(this.state.spAmt || '0', 10); }
  spWaysN() { return this.state.spWays || 4; }
  spOthers() { return this.spWaysN() - 1; }

  spEven() {
    const n = this.spWaysN(), base = Math.floor(this.spCents() / n), a = [];
    for (let i = 0; i < n; i++) a.push(base);
    a[0] += this.spCents() - base * n;
    return a;
  }

  spSharesArr() {
    const v = this.state.spShares;
    return (v && v.length === this.spWaysN()) ? v.slice() : this.spEven();
  }

  spSlots() {
    const a = (this.state.spAssigns || []).slice();
    while (a.length < this.spOthers()) a.push({ type: 'qr' });
    return a.slice(0, this.spOthers());
  }

  spPaidArr() {
    const p = (this.state.spPaid || []).slice();
    while (p.length < this.spOthers()) p.push(false);
    return p.slice(0, this.spOthers());
  }

  spNextUnpaid() {
    const p = this.spPaidArr();
    for (let i = 0; i < p.length; i++) if (!p[i]) return i;
    return -1;
  }

  spInitials(n) {
    return n.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  }

  splitVals(s, sc) {
    const sh = this.spSharesArr();
    const slots = this.spSlots();
    const paid = this.spPaidArr();
    const paidCount = paid.filter(Boolean).length;
    const nu = this.spNextUnpaid();
    const cur = slots[s.spIdx || 0] || { type: 'qr' };
    const isQrSlot = cur.type !== 'contact';
    const idx = s.spIdx || 0;
    const lastPayer = idx >= this.spOthers() - 1;
    const diff = this.spCents() - sh.reduce((a, b) => a + b, 0);
    const v = {
      spIsAmount: sc === 'spAmount', spIsWays: sc === 'spWays', spIsShares: sc === 'spShares',
      spIsPayer: sc === 'spPayer', spIsAssign: sc === 'spAssign',
      spIsWaiting: sc === 'spWaiting', spIsAllPaid: sc === 'spAllPaid',

      goSplit: () => this.setState(p => ({
        screen: 'spAmount', stack: p.stack.concat([p.screen]),
        spAmt: '0', spWays: 4, spIdx: 0, spAssigns: [], spPaid: [], spShares: null, spInvoices: [],
        // the network this person asked to start on (FoxyWallet.defaultRail);
        // on-chain is not a way to collect a share, so it is not one here
        spRail: (window.FoxyWallet && window.FoxyWallet.defaultRail
          && window.FoxyWallet.defaultRail() === 'CASHU') ? 'CASHU' : 'LIGHTNING',
        spEditIdx: -1, spEditBuf: '', spCopied: -1, spShared: -1, spFromWaiting: false,
      })),
      spBack: () => {
        if (sc === 'spPayer' && s.spFromWaiting) return this.setState({ screen: 'spWaiting', spFromWaiting: false });
        if (sc === 'spPayer' && idx > 0) return this.setState({ spIdx: idx - 1 });
        if (sc === 'spAssign') return this.setState({ screen: 'spPayer' });
        this.back();
      },
      spRestartPhone: () => this.setState({ screen: 'home', stack: [] }),

      spAmtDisp: this.spMoney(this.spCents()),
      spAmtInk: this.spCents() > 0 ? 'var(--ink)' : 'rgba(var(--ink-rgb),.3)',
      spCollectedDisp: this.spMoney(sh.slice(1).reduce((a, b) => a + b, 0)),
      spYourShareDisp: this.spMoney(sh[0]),
      spOthersCount: this.spOthers() + (this.spOthers() === 1 ? ' PERSON' : ' PEOPLE'),
    };

    /* The pad, in the same eleven cells as the send/receive pad — so 0 and the
     * delete key stay in the same two columns on both — but counting in cents:
     * 5 then 0 is $0.50 here.
     *
     * Which is why there is no decimal point: on a pad whose decimal point is
     * always in the number there is nothing for it to do. Its cell holds "00",
     * two zeros at once, the same as the send/receive pad since that one went
     * cents-first too. On an empty amount "00" types nothing, like "0".
     */
    const SP_PAD = ['1','2','3','4','5','6','7','8','9','00','0'];
    v.spKeys = SP_PAD.map(l => ({
      label: l,
      tap: () => {
        const n = ((s.spAmt || '0') === '0' ? '' : s.spAmt) + l;
        if (n === '00') return;
        if (n.length > 9) return;
        this.setState({ spAmt: n, spShares: null });
      },
    }));
    v.spDel = () => this.setState({ spAmt: (s.spAmt || '0').length > 1 ? s.spAmt.slice(0, -1) : '0', spShares: null });
    /* Any bill, however small.
     *
     * There used to be a flat $2.00 floor here. It was never the real
     * constraint — it was a round number standing in for one. What actually
     * has to hold is that every payer ends up owing something: spEven() floors
     * the division, so a penny split eight ways gives one person 1c and seven
     * people nothing, and Foxy would go on to make invoices for $0.00.
     *
     * That constraint needs the number of ways, which is chosen on the NEXT
     * screen, so it is enforced there (spWaysNext) where the figure exists.
     * Here the only question is whether an amount was typed at all. */
    const amtOk = this.spCents() > 0;
    v.spAmtBtnBg = amtOk ? 'var(--acc)' : 'var(--chip)';
    v.spAmtBtnInk = amtOk ? '#fff' : 'rgba(var(--ink-rgb),.28)';
    v.spAmtBtnSh = amtOk ? 'inset 0 2px 0 rgba(255,255,255,.34),inset 0 -3px 0 rgba(0,0,0,.22),0 10px 20px rgba(0,0,0,.34)' : 'none';
    v.spAmtBtnAnim = amtOk ? 'shineLoop 4.6s ease-in-out 3s infinite' : 'none';
    /* A grey NEXT that says nothing is a wall: a bill that would not go
     * anywhere just failed silently, and attempts were lost to it. The button
     * still refuses, and now it
     * says why. The screen has no room of its own for the reason — every other
     * word on it is fixed markup — so it is said on the tap. */
    v.spAmtNext = () => {
      if (!amtOk) { this.toast('Type an amount first.', true); return; }
      this.go('spWays');
    };

    v.spWayOpts = [2,3,4,5,6,7,8].map(n => {
      const on = this.spWaysN() === n;
      return {
        n: n, bg: on ? 'var(--acc)' : 'var(--surface)',
        border: on ? 'var(--acc)' : 'rgba(var(--ink-rgb),.12)',
        fg: on ? '#fff' : 'var(--ink)',
        sh: on ? 'inset 0 2px 0 rgba(255,255,255,.3),0 8px 16px rgba(0,0,0,.3)' : 'none',
        pick: () => this.setState({ spWays: n, spIdx: 0, spAssigns: [], spPaid: [], spShares: null }),
      };
    });
    /* The floor that is real, checked where the numbers both exist.
     *
     * spEven() floors the division, so a bill smaller than the number of ways
     * leaves somebody owing $0.00 — and Foxy would then make them an invoice
     * for nothing. Splitting 3 cents four ways is the smallest case that bites.
     * The shares screen refuses a $0.00 share too (spSharesNext), but by then
     * the person has walked past two screens to be told; this says it at the
     * moment the number of ways is chosen. */
    v.spWaysNext = () => {
      if (this.spCents() < this.spWaysN()) {
        this.toast(this.spMoney(this.spCents()) + ' does not divide '
          + this.spWaysN() + ' ways.', true);
        return;
      }
      this.go('spShares');
    };

    v.spSharesSub = this.spWaysN() + ' payers';
    const order = [];
    for (let i = 1; i < sh.length; i++) order.push(i);
    order.push(0);
    v.spShareRows = order.map(i => {
      const isLeader = i === 0;
      const sl = !isLeader ? slots[i - 1] : null;
      const isC = sl && sl.type === 'contact';
      const off = s.spShares != null && sh[i] !== this.spEven()[i];
      return {
        name: isLeader ? 'You' : (isC ? sl.name : 'Payer ' + (i + 1)),
        sub: isLeader ? 'The rest of the bill' : (off ? 'Custom amount' : 'Even share'),
        subInk: off ? 'var(--acc-ink)' : 'rgba(var(--ink-rgb),.42)',
        ini: isLeader ? 'YOU' : (isC ? sl.ini : String(i + 1)),
        avBg: isLeader ? 'rgba(var(--acc-rgb),.18)' : (isC ? 'var(--acc)' : 'var(--chip)'),
        avInk: isLeader ? 'var(--acc-ink)' : (isC ? '#fff' : 'rgba(var(--ink-rgb),.55)'),
        avRadius: (isC || isLeader) ? '50%' : '14px',
        amt: this.spMoney(sh[i]), amtInk: 'var(--ink)',
        rowCursor: isLeader ? 'default' : 'pointer',
        boxBg: isLeader ? 'transparent' : (off ? 'rgba(var(--acc-rgb),.12)' : 'var(--chip)'),
        boxBorder: isLeader ? 'transparent' : (off ? 'rgba(var(--acc-rgb),.5)' : 'transparent'),
        edit: () => { if (!isLeader) this.setState({ spEditIdx: i, spEditBuf: '0' }); },
      };
    });
    v.spBalShown = diff !== 0;
    v.spBalLabel = diff > 0 ? 'STILL TO ALLOCATE' : 'OVER THE BILL BY';
    v.spBalAmt = this.spMoney(Math.abs(diff));
    v.spBalInk = '#FF5C5C';
    const shOk = diff === 0 && sh.every(x => x > 0);
    v.spShNextBg = shOk ? 'var(--acc)' : 'var(--chip)';
    v.spShNextInk = shOk ? '#fff' : 'rgba(var(--ink-rgb),.28)';
    v.spShNextSh = shOk ? 'inset 0 2px 0 rgba(255,255,255,.34),inset 0 -3px 0 rgba(0,0,0,.22),0 10px 20px rgba(0,0,0,.34)' : 'none';
    v.spShNextAnim = shOk ? 'shineLoop 4.6s ease-in-out 3s infinite' : 'none';
    /* Grey here has two causes and the screen only shows one of them: the
     * red balance line covers shares that do not add up, and says nothing
     * about a share left at $0.00. Both are said on the tap that is refused.
     */
    v.spSharesNext = () => {
      if (!shOk) {
        this.toast(diff !== 0
          ? 'The shares have to add up to the bill.'
          : 'Every share needs an amount.', true);
        return;
      }
      this.setState(p => ({ screen: 'spPayer', spIdx: 0, stack: p.stack.concat([p.screen]) }));
      this.spStart();
    };

    v.spEditOpen = (s.spEditIdx != null && s.spEditIdx >= 0);
    const eSlot = s.spEditIdx > 0 ? slots[s.spEditIdx - 1] : null;
    v.spEditName = s.spEditIdx === 0 ? 'YOUR SHARE'
      : (eSlot && eSlot.type === 'contact' ? eSlot.name : 'PAYER ' + ((s.spEditIdx || 0) + 1));
    v.spEditDisp = this.spMoney(parseInt(s.spEditBuf || '0', 10));
    // the same eleven cells, the same cents, the same blank where a decimal
    // point used to be drawn and ignored
    v.spEditKeys = SP_PAD.map(l => ({
      label: l,
      tap: () => {
        const n = ((s.spEditBuf || '0') === '0' ? '' : s.spEditBuf) + l;
        if (n === '00' || n.length > 9) return;
        this.setState({ spEditBuf: n });
      },
    }));
    v.spEditDel = () => this.setState({ spEditBuf: (s.spEditBuf || '0').length > 1 ? s.spEditBuf.slice(0, -1) : '0' });
    v.spEditCancel = () => this.setState({ spEditIdx: -1, spEditBuf: '' });
    v.spEditStop = (e) => { if (e && e.stopPropagation) e.stopPropagation(); };
    v.spEditDone = () => {
      const a = this.spSharesArr();
      a[s.spEditIdx] = parseInt(s.spEditBuf || '0', 10);
      if (s.spEditIdx !== 0) a[0] = this.spCents() - a.slice(1).reduce((x, y) => x + y, 0);
      this.setState({ spShares: a, spEditIdx: -1, spEditBuf: '' });
    };

    v.spPayerStep = s.spFromWaiting ? 'COLLECTING' : (idx + 1) + ' OF ' + this.spOthers();
    v.spPayerTitle = 'PAYER ' + (idx + 2);
    v.spPayerSub = isQrSlot ? 'Scan, Tap or Share' : 'Assigned to a contact';
    v.spPayerIsQr = isQrSlot;
    v.spPayerIsContact = !isQrSlot;
    v.spPayerAmtDisp = this.spMoney(sh[idx + 1]);
    v.spAssignedName = cur.name || '';
    v.spAssignedHandle = cur.handle || '';
    v.spAssignedIni = cur.ini || '';
    const spInvoice = (s.spInvoices || [])[idx] || '';
    // CASHU: a payment request for this share (railRequest), taken back with SCAN
    const spCashu = s.spRail === 'CASHU' && /^sp/.test(String(s.screen || ''));
    const spInv = (spCashu && spInvoice && window.FoxyWallet)
      ? this.railRequest(window.FoxyWallet.amountOf(spInvoice), 'split:' + idx) : spInvoice;
    v.spNetwork = spCashu ? 'CASHU' : 'LIGHTNING';
    v.spQrBolt = !spCashu;
    v.spQrEcash = spCashu;
    v.spQrBolt = !spCashu;
    v.spQrEcash = spCashu;
    v.spPickNetwork = () => this.chooseRail(v.spNetwork, rail => this.setState({ spRail: rail }));
    // error correction H, because the template lays a badge over the middle
    v.spQrSrc = (spInv && window.FoxyWallet)
      ? window.FoxyWallet.qr(spInv, { ecc: 'H' })
      : this.qrLoadingSrc();
    v.spInvoiceReady = !!spInv;
    /* The four digits, over this share's QR, exactly as the receive invoice
     * screen shows them (tapCodeShown). The code arrived and the screen did
     * not draw it: `tapCodeShown` is gated on the confirm screen and its card
     * lives in that screen's markup, so a split payer screen agreed a key,
     * logged "the code is on screen" and showed nothing. The payer was
     * holding four digits to compare against
     * a screen that had none. */
    v.spTapCodeShown = s.screen === 'spPayer' && !!s.tapShownCode && !s.tapCardOff;
    v.spTapCode = s.tapShownCode || '';
    v.spHideTapCode = () => this.setState({ tapCardOff: true });
    v.spDiscard = () => this.spDiscard();
    v.spCopyLabel = s.spCopied === idx ? 'COPIED' : 'COPY';
    v.spShareLabel = s.spShared === idx ? 'SHARED' : 'SHARE';
    v.spCopyInv = () => {
      if (!spInv) { this.toast('That invoice is still being made.', true); return; }
      // a share's code can be a payment request naming this phone's onion
      // address, so it is copied device-only like a token (finding 6)
      if (this.copySecret(spInv)) this.setState({ spCopied: idx, spShared: -1 });
      else this.toast('Could not copy', true);
    };
    v.spShareInv = () => this.setState({ spShared: idx, spCopied: -1 });
    v.spScanToken = () => this.spScanToken(idx);
    /* TAP, on a share. The same press as on the receive screen: it is what
     * puts this phone on the air, and nothing here advertises without it
     * (24-render-receive-and-send.js, TapLink.swift). Each share is its own
     * payment, so each press is its own receiver with its own service UUID —
     * two people paying one bill are not two payments from one number. */
    v.spTapArm = () => this.tapArm();
    v.spTapArmedShown = s.screen === 'spPayer' && !!s.tapArmed && !s.tapShownCode && !s.tapCardOff;
    v.spTapArmedHint = s.tapRecvStage === 'connecting' ? 'CONNECTING\u2026' : 'HOLD A PHONE HERE';
    // the label never changes; the accent is what says it is on the air
    v.spTapArmBg = s.tapArmed ? 'var(--acc)' : 'var(--ink)';
    v.spTapArmInk = s.tapArmed ? '#fff' : 'var(--bg)';
    v.spTapArmLabel = 'TAP';
    v.spEditPayerAmt = () => this.setState({ spEditIdx: idx + 1, spEditBuf: '0' });
    v.spAssignBtnLabel = isQrSlot ? 'ASSIGN TO A CONTACT' : 'CHANGE CONTACT';
    v.spOpenAssign = () => this.setState({ screen: 'spAssign' });
    v.spCloseAssign = () => this.setState({ screen: 'spPayer' });
    v.spPayerNextLabel = s.spFromWaiting ? 'SAVE AND CLOSE' : (lastPayer ? 'NEXT' : 'NEXT PAYER');
    /* The code belongs to the share that was just paid, and the next share is
     * a new tap. Left up, it covered the new QR with the last payer's digits
     * and the screen could not be used at all — the code card is drawn over the
     * QR, so a stale one blocks the very thing the next payer has to scan or
     * tap. The same goes for stepping back to a share from
     * the waiting list. */
    v.spPayerNext = () => {
      if (s.spFromWaiting) {
        return this.setState({ screen: 'spWaiting', spFromWaiting: false, spCopied: -1, spShared: -1,
                               tapShownCode: '', tapRecvStage: '' });
      }
      if (lastPayer) return this.go('spWaiting');
      this.setState({ spIdx: idx + 1, spCopied: -1, spShared: -1,
                      tapShownCode: '', tapRecvStage: '' });
    };

    const taken = slots.filter(x => x.type === 'contact').map(x => x.handle);
    v.spContactList = (this.state.contacts || []).map(c => {
      const isTaken = taken.indexOf(c.handle) >= 0 && cur.handle !== c.handle;
      return {
        name: c.name, sub: c.handle, ini: this.spInitials(c.name), taken: isTaken,
        op: isTaken ? '0.4' : '1',
        avBg: cur.handle === c.handle ? 'var(--acc)' : 'var(--chip)',
        avInk: cur.handle === c.handle ? '#fff' : 'rgba(var(--ink-rgb),.6)',
        tap: () => {
          if (isTaken) return;
          const a = this.spSlots();
          a[idx] = { type: 'contact', name: c.name, handle: c.handle, ini: this.spInitials(c.name) };
          this.setState({ spAssigns: a, screen: 'spPayer' });
        },
      };
    });

    const left = this.spOthers() - paidCount;
    v.spWaitTitle = left === 0 ? 'ALL PAID' : 'COLLECTING';
    v.spWaitSub = left === 0 ? 'Everyone has paid you.' : 'Waiting for ' + left + (left === 1 ? ' payment' : ' payments');
    v.spWaitPct = Math.round((paidCount / this.spOthers()) * 100) + '%';
    v.spWaitFrac = paidCount + '/' + this.spOthers();
    v.spWaitFoot = left === 0 ? 'Ready to pay the bill' : 'Live \u00b7 updates as they pay';
    v.spAdvanceLabel = left === 1 ? 'DEMO \u00b7 RECEIVE THE LAST PAYMENT' : 'DEMO \u00b7 RECEIVE NEXT PAYMENT';
    v.spAdvancePayment = () => {
      const p = this.spPaidArr(), i = this.spNextUnpaid();
      if (i < 0) return;
      p[i] = true;
      const done = p.filter(Boolean).length >= this.spOthers();
      if (done) this.haptic('success');
      this.setState({ spPaid: p, screen: done ? 'spAllPaid' : 'spWaiting' });
    };
    v.spWaitRows = slots.map((sl, i) => {
      const isC = sl.type === 'contact';
      const done = paid[i];
      return {
        name: isC ? sl.name : 'Payer ' + (i + 2),
        ini: isC ? sl.ini : String(i + 2),
        pending: !done,
        avBg: done ? 'var(--acc)' : 'var(--chip)',
        avInk: done ? '#fff' : 'rgba(var(--ink-rgb),.55)',
        avRadius: isC ? '50%' : '14px',
        status: done ? 'RECEIVED' : 'PENDING',
        chipBg: done ? 'rgba(var(--acc-rgb),.18)' : 'rgba(var(--ink-rgb),.08)',
        chipInk: done ? 'var(--acc-ink)' : 'rgba(var(--ink-rgb),.5)',
        amt: this.spMoney(sh[i + 1]), amtInk: 'var(--ink)',
        rowCursor: done ? 'default' : 'pointer',
        open: () => { if (!done) this.setState({ screen: 'spPayer', spIdx: i, spFromWaiting: true, spCopied: -1, spShared: -1 }); },
      };
    });

    v.spPaidBolts = this.boltField(sc === 'spAllPaid');
    v.spPaidBoltFlash = sc === 'spAllPaid' ? 'boltFlash 1s cubic-bezier(.3,0,.5,1) both' : 'none';
    v.spPayBill = () => this.goSendScanFromSplit();
    return v;
  }

  // hand off to the app's own send flow, exactly as the home SEND button does —
  // one enabled rail opens the camera, otherwise the rail list
  /* Leaving the all-paid screen ends the split.
   *
   * The record is kept past the last payment so the screen can show what was
   * collected — deleting it there is what left every amount at $0.00.
   *
   * It used to hand off to the send flow, on the assumption that collecting
   * a bill is followed by paying it. That is a guess about what someone wants
   * next, and a wrong one often enough: the money has arrived, and home is
   * where they can see it. */
  goSendScanFromSplit() {
    const W = window.FoxyWallet;
    if (W && W.splitClear) W.splitClear();
    this.setState({
      screen: 'home', stack: [], flow: '',
      amount: '', asset: '', unit: 'USD', recipient: '', emailDraft: '',
      spPaid: [],
    });
  }
