
  /* history: the transaction list and its filters. */
  /** @param {RenderContext} c */
  renderHistory(c) {
    const { s, sc } = c;
    const hf = s.histFilter || 'all';
    /* One card's entries, when this screen was opened from that card's own
     * (26f-flashcard.js): only then, read from where it was opened and not
     * from a flag left behind, so the ordinary history can never come up
     * filtered. */
    const ofCard = (sc === 'history' && s.histCard && (s.stack || [])[(s.stack || []).length - 1] === 'flashcard') ? String(s.histCard) : '';
    /* A running balance on every settled row: what the wallet held after that
     * payment, walked back from the balance now. The list is newest first, so
     * a receive is taken off on the way down and a send (with its fee) put
     * back. Rows that moved nothing yet — pending, failed, at risk, a bill
     * still being collected, another unit's ecash — carry the balance through
     * unchanged. So that a person can see the numbers add up, or where they
     * stop doing so ("$121.69 is wrong"). */
    const A = this.histAudit();
    const balOf = A.balOf, balNow = A.balNow, run = A.run;
    const dueChange = A.dueChange, dueCount = A.dueCount;
    /* The audit. Walked back through every entry, the balance before the
     * first one should be nothing: a wallet starts empty. Whatever is left is
     * money no payment here accounts for — a restore from the words, a swap
     * whose record was lost — and it is said in red so the person can go and
     * find out, rather than trusting a number. Only when
     * the list is the whole ledger; five hundred of more cannot be checked
     * to the start. Sats held back for a lost swap are outside the balance and are
     * named too. */
    const W1 = window.FoxyWallet;
    const held = Math.round(Number(W1 && W1.heldSats && W1.heldSats()) || 0);
    const whole = !!s.historyComplete && !s.fresh && (s.history || []).length > 0;
    const off = A.off;
    const money = (n) => this.stageMoney(Math.abs(n));
    let auditTitle = '', auditBody = '';
    if (whole && off !== 0) {
      auditTitle = 'DOES NOT ADD UP';
      auditBody = 'Your balance is ' + money(balNow) + '. The payments below account for '
        + money(balNow - off) + '. ' + money(off) + (off > 0 ? ' more is here than' : ' less is here than')
        + ' they explain. A restore from your words, or a swap whose record was lost, can do this.';
    } else if (whole) {
      auditTitle = 'ADDS UP';
      auditBody = 'Every sat of your ' + money(balNow) + ' is accounted for by the payments below.';
    } else if (!s.fresh && (s.history || []).length) {
      auditTitle = 'LAST 500 PAYMENTS';
      auditBody = 'Only the latest five hundred are kept, so the balance cannot be checked back to the start.';
    }
    if (held > 0) {
      auditBody += (auditBody ? ' ' : '') + money(held)
        + ' is held back for a swap the mint has not answered; it is not in the balance until it does.';
    }
    const fees = this.topUpFeeSats ? this.topUpFeeSats() : 0;
    if (fees > 0 && whole) {
      auditBody += (auditBody ? ' ' : '') + money(fees)
        + ' went to the mint in fees for making small change, or for a payment that did not go through.';
    }
    const back = this.recoveringSats ? this.recoveringSats() : 0;
    if (back > 0) {
      auditBody += (auditBody ? ' ' : '') + money(back)
        + ' is being recovered from the mint: it took that piece for a swap after Foxy was put away, and the new pieces are collected the next time Foxy is online.';
    }
    /* Change that never arrived, and what to do about it.
     *
     * The receiver made it and holds it as a code on that payment's entry; it
     * is locked to this phone, so only this phone can take it. The card says
     * so and opens the scanner, instead of leaving a red number and no way
     * on. */
    /* And the other side of it: change this phone made for a payer and could
     * not hand over. It is a code on that payment's entry, and the card
     * takes the person straight to it. */
    const showChange = !dueChange && A.toShowCount > 0;
    if (showChange) {
      if (auditTitle === 'ADDS UP') auditTitle = 'CHANGE TO HAND OVER';
      auditBody = money(A.toShowSats) + ' of change for ' + (A.toShowCount === 1 ? 'a payer' : A.toShowCount + ' payers')
        + ' was made and has not reached them. Show them its code to scan.'
        + (auditTitle === 'CHANGE TO HAND OVER' ? ' Everything else adds up.' : ' ' + auditBody);
    }
    const auditAction = dueChange > 0 || showChange;
    if (dueChange > 0) {
      if (auditTitle === 'ADDS UP') auditTitle = 'CHANGE NOT COLLECTED';
      auditBody = money(dueChange) + ' of change from ' + (dueCount === 1 ? 'a payment' : dueCount + ' payments')
        + ' has not reached this phone. Ask the receiver to open that payment in their history and show its code, then scan it.'
        + (auditTitle === 'CHANGE NOT COLLECTED' ? ' Everything else adds up.' : ' ' + auditBody);
    }
    const histGroups = (s.fresh ? [] : (s.history || [])).map(g => ({
      label: g.label,
      items: g.items.filter(t => (hf === 'all' || t.dir === hf) && (!ofCard || t.card === ofCard)).map(t => ({
        // HIDE only masks balances on the home screen — history stays readable
        /* The note, where the person wrote one: "Lunch" says more than
         * "ecash" or the first characters of an invoice. One line, as wide
         * as the card allows, cut with an ellipsis; the card is no taller for
         * it. */
        name: (t.note && String(t.note).trim()) || t.name,
        initial: t.name.slice(0, 1).toUpperCase(),
        /* The card's outline and its icon say how the payment stands: green
         * done (sent, received or redeemed), amber pending, red failed. The
         * amount says which way it went: green in, red out. */
        /* A payment taken on trust while both phones were offline is pending
         * like any other, and it is not like any other: the payer keeps a copy
         * and can spend it back until this phone can swap. So it says what it
         * is, in red rather than amber, instead of sitting in a list reading
         * "Pending" beside a broadcast nobody can undo.
         *
         * It stops the moment the claim lands, because the claim is what ends
         * the risk. Once it has, the row is an ordinary settled receive. */
        atRisk: !!t.atRisk,
        /* The payments the card's notice is about, picked out: red, with a
         * red edge that turns, so it is plain which row to open. */
        cardBg: A.flagged.has(t)
          ? 'linear-gradient(var(--surface),var(--surface)) padding-box,conic-gradient(from var(--fxa),#FF5C5C,rgba(255,92,92,.12) 40%,#FF5C5C) border-box'
          : 'var(--surface)',
        cardEdge: A.flagged.has(t) ? '2.5px' : '1.5px',
        cardSpin: A.flagged.has(t) ? 'foxyEdge 1.6s linear infinite' : 'none',
        metaRail: A.flagged.has(t) ? A.flagged.get(t) : t.highRisk ? 'HIGH RISK \u00b7 refused, not returned'
          : t.failed ? 'Failed' : t.atRisk ? 'AT RISK \u00b7 not settled'
          /* A payment that is "pending" has left: what is waiting is the other
           * side taking it. The word alone read as if nothing had happened
           * yet. */
          : t.pending ? (t.dir === 'in' ? 'Pending' : 'Sent \u00b7 not yet claimed') : '',
        metaTime: t.time,
        metaColor: (t.failed || t.atRisk || A.flagged.has(t)) ? 'var(--bad)'
          : t.pending ? 'var(--btc-ink)' : 'rgba(var(--ink-rgb),.5)',
        tileBg: (t.failed || t.atRisk || A.flagged.has(t)) ? 'var(--bad)' : t.pending ? 'var(--btc-ink)' : 'var(--ok)',
        stroke: A.flagged.has(t) ? 'transparent' : (t.failed || t.atRisk) ? 'rgba(var(--bad-rgb),.7)'
          : t.pending ? 'var(--btc-ink)' : 'rgba(var(--ok-rgb),.7)',
        amtColor: A.flagged.has(t) ? 'var(--bad)' : t.dir === 'in' ? 'var(--ok-ink)' : 'var(--bad)',
        /* Dollars, and the dollars of the day it settled: `fiat` is written on
         * the entry then and never worked out again, so yesterday's coffee
         * does not change price with bitcoin. */
        amtText: (t.dir === 'in' ? '+' : '−') + (t.unit ? this.unitMoney(t.amount, t.unit) : t.usd != null ? '$ ' + t.usd.toFixed(2) : this.money(this.txTotalOut(t), this.txFiat(t, this.txTotalOut(t))).main),
        amtSub: t.unit ? this.unitLabel(t.unit) + ' ecash' : t.usd != null ? 'Cash' : this.money(this.txTotalOut(t), this.txFiat(t, this.txTotalOut(t))).sub,
        // dollars at today's price, and the sats that actually add up
        // the wallet's running balance, which is not a card's: left off a card's own list
        balText: ofCard ? '' : 'BAL ' + (this.px()
          ? this.stageMoney(Math.max(0, balOf.get(t) || 0)) + ' \u00b7 \u20bf ' + this.group(Math.max(0, balOf.get(t) || 0))
          : '\u20bf ' + this.group(Math.max(0, balOf.get(t) || 0))),
        // the collecting screen, not a transaction detail, while a bill is open
        open: () => (t.split ? this.openPendingSplit() : this.openTx(t)),
      /* The card is three lines, each shared with a figure on the right: the
       * title beside the amount, so a note runs as far as the amount and no
       * further; then how the payment stands, where it has something to
       * say; then the time. A settled payment has nothing to say, so its
       * time moves up under the title. */
      })).map(r => Object.assign(r, {
        line2: r.metaRail || r.metaTime,
        line3: r.metaRail ? r.metaTime : '',
        line2Color: r.metaRail ? r.metaColor : 'rgba(var(--ink-rgb),.45)',
        line2Weight: r.metaRail ? '600' : '500',
      })),
    })).filter(g => g.items.length);
    return {
      historyEmptySub: ofCard ? 'Nothing has been done with this card on this phone yet.'
        : s.fresh ? 'Your transactions will show up here.' : 'No transactions match this filter.',
      isHistory: sc === 'history',
      histTitle: ofCard ? 'CARD HISTORY' : 'HISTORY',
      // clearing history is the whole wallet's, not one card's
      histClearVis: ofCard ? 'hidden' : 'visible',
      historyMint: (window.FoxyWallet && window.FoxyWallet.mintHost
        && window.FoxyWallet.mintHost()) || 'MINT',
      // switching from here comes back here, showing that mint's activity
      goSwitchFromHistory: () => this.goSwitchMint({ mintReturn: 'history' }),
      histScrollRef: this._refHist || (this._refHist = (el) => this.histRef(el)),
      goHistory: () => this.go('history'),
      fAllBg: hf === 'all' ? 'var(--acc)' : 'transparent',
      fAllFg: hf === 'all' ? CTA_INK(s) : 'rgba(var(--ink-rgb),.5)',
      fInBg: hf === 'in' ? 'var(--acc)' : 'transparent',
      fInFg: hf === 'in' ? CTA_INK(s) : 'rgba(var(--ink-rgb),.5)',
      fOutBg: hf === 'out' ? 'var(--acc)' : 'transparent',
      fOutFg: hf === 'out' ? CTA_INK(s) : 'rgba(var(--ink-rgb),.5)',
      filterAll: () => this.setState({ histFilter: 'all' }),
      filterIn: () => this.setState({ histFilter: 'in' }),
      filterOut: () => this.setState({ histFilter: 'out' }),
      historyGroups: histGroups,
      historyEmpty: histGroups.length === 0,
      histAuditShown: !!auditTitle && hf === 'all' && !ofCard,
      histAuditTitle: auditTitle,
      histAuditBody: auditBody,
      histAuditAction: auditAction && !!auditTitle && hf === 'all' && !ofCard,
      histAuditCta: showChange ? 'SHOW QR CODE' : 'SCAN CHANGE',
      histAuditGo: () => (showChange && A.toShow ? this.openTx(A.toShow)
        : this.setState(p => ({ screen: 'sendScan', stack: p.stack.concat([p.screen]), flow: 'send' }))),
      histAuditInk: (auditTitle === 'DOES NOT ADD UP' || auditAction) ? 'var(--bad)' : auditTitle === 'ADDS UP' ? 'var(--ok-ink)' : 'var(--btc-ink)',
      histAuditEdge: (auditTitle === 'DOES NOT ADD UP' || auditAction) ? 'rgba(var(--bad-rgb),.5)' : 'rgba(var(--ink-rgb),.12)',
    };
  }

  /* txDetail: one transaction — amounts, fee, mint, payment id, audit record. */
  /** @param {RenderContext} c */
  renderTxDetail(c) {
    const { s, sc, tx } = c;
    // the proofs this payment consumed and produced, if the record is still kept
    const audit = (window.FoxyWallet && window.FoxyWallet.auditTrail && tx.hash)
      ? window.FoxyWallet.auditTrail(tx.hash) : [];
    const txText = String((tx && (tx.token || (tx.dir === 'in' ? tx.changeToken : tx.kept))) || '');
    return {
      isTxDetail: sc === 'txDetail',
      /* SENT is what the recipient got; TOTAL is what left the wallet. The
       * difference is the fee, and the screen now shows all three rather than
       * two numbers that do not visibly relate. */
      txSentLabel: tx.dir === 'in' ? 'RECEIVED' : 'SENT',
      txSent: (tx.dir === 'in' ? '+' : '\u2212') + (tx.unit ? this.unitMoney(tx.amount, tx.unit) : this.money(tx.sats, this.txFiat(tx, tx.sats)).main),
      txTotal: (tx.dir === 'in' ? '+' : '\u2212') + (tx.unit ? this.unitMoney(tx.amount, tx.unit) : this.money(this.txTotalOut(tx), this.txFiat(tx, this.txTotalOut(tx))).main),
      txTotalAlt: tx.unit ? this.unitLabel(tx.unit) + ' ecash' : this.money(this.txTotalOut(tx), this.txFiat(tx, this.txTotalOut(tx))).sub,
      /* Which mint carried this. The screen said LIGHTNING and never said
       * whose — and the mint is the party that held the money. */
      txMint: (window.FoxyWallet && window.FoxyWallet.mintHost
        && window.FoxyWallet.mintHost()) || 'unknown',
      txPaymentId: tx.hash || '',
      txHasPaymentId: !!tx.hash,
      /* The one identifier on this screen an explorer can find.
       *
       * PAYMENT ID is the mint's melt quote id with `onchain-` in front — the
       * one pasted into mempool.space finds nothing, which is how this row
       * came to exist. The transaction id comes from the NUT-30
       * outpoint and is a real one. It appears only once the mint has broadcast,
       * and only on an on-chain payment; everything else has no such field and
       * the row stays away rather than showing an empty label.
       *
       * Tap to copy, because sixty-four characters is not something anybody
       * reads off a screen into another one. */
      txTxid: tx.txid || '',
      txHasTxid: !!tx.txid,
      txCopyTxid: () => {
        if (!tx.txid) return;
        this.toast(this.copyText(tx.txid) ? 'TXID Copied' : 'Could not copy');
      },
      /* The proof that a Lightning payment was made: its preimage, which only
       * somebody paid that invoice can know. Shown where the mint gave one;
       * a payment between two wallets at one mint has none. Tap to copy, as
       * the transaction id is. */
      txPreimage: tx.preimage || '',
      txHasPreimage: !!tx.preimage,
      txCopyPreimage: () => {
        if (!tx.preimage) return;
        this.toast(this.copyText(tx.preimage) ? 'Proof of payment copied' : 'Could not copy');
      },
      /* And on a Lightning receive, the payment hash of the invoice: what a
       * payer's proof of payment is held against. */
      txPayHash: tx.payHash || '',
      txHasPayHash: !!tx.payHash,
      txCopyPayHash: () => {
        if (!tx.payHash) return;
        this.toast(this.copyText(tx.payHash) ? 'Payment hash copied' : 'Could not copy');
      },
      /* What this payment consumed and produced: a count and a copy button.
       * The proofs themselves are hex, they are long, and the outputs of a
       * recent payment are live change with no business on screen. */
      txHasAudit: !!(audit && audit.length),
      /* A record older than the last hundred is a receipt: the counts, and the
       * public values of what left, with the pieces themselves let go. */
      txAuditLine: (audit && audit.length)
        ? (audit[0].slim ? Number(audit[0].ins) || 0
           : Math.max((audit[0].inputs || []).length, (audit[0].ys || []).length)) + ' proofs in  \u00b7  '
          + (audit[0].slim ? Number(audit[0].outs) || 0 : (audit[0].outputs || []).length) + ' proofs out'
        : '',
      /* A payment locked to the phone that asked for it, once the mint says
       * its pieces are spent: they could only be spent by that phone's key,
       * and the signature they were spent with is kept here. That is what
       * shows somebody else who took the payment. The pieces are spent, so
       * copying them hands over nothing. DELETE is the person's to press:
       * a receipt is also a record of who was paid. */
      txHasReceipt: !!(audit && audit[0] && audit[0].spent && (audit[0].inputs || []).length),
      txReceiptLine: (audit && audit[0] && audit[0].spent)
        ? 'Taken by the key it was locked to.' : '',
      txReceiptCta: s.txReceiptCopied ? 'COPIED' : 'COPY RECEIPT',
      txCopyReceipt: () => {
        const a = audit && audit[0];
        if (!a || !a.spent) return;
        const text = JSON.stringify({
          what: 'a Cashu payment locked to one key (NUT-11), and the signature its pieces were spent with (NUT-07)',
          mint: a.mint, paid: a.at, sats: a.sats, lockedTo: a.lockedTo, spentSeenAt: a.spent.at,
          proofs: (a.inputs || []).map((p, i) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C,
                                                    witness: a.spent.witness[i] })),
        });
        if (!this.copyText(text)) { this.toast('Could not copy', true); return; }
        this.setState({ txReceiptCopied: true });
        setTimeout(() => this.setState({ txReceiptCopied: false }), 1600);
      },
      txDeleteReceipt: () => {
        const W = window.FoxyWallet;
        if (!W || !W.forgetReceipt || !tx.hash) return;
        if (W.forgetReceipt(tx.hash)) { this.toast('Receipt deleted'); this.setState({ txReceiptAt: 0 }); }
      },
      txAuditCta: s.txAuditCopied ? 'COPIED' : 'COPY RECORD',
      txCopyAudit: () => {
        /* A record to share, not money. A proof's secret with its signature
         * spends it, and the outputs here can be live change. The copy keeps
         * amounts, keysets and a secret's first characters to match on. */
        const brief = p => ({ amount: p && p.amount, id: p && p.id,
          secret: String((p && p.secret) || '').slice(0, 8) + '\u2026' });
        const shareable = (audit || []).map(a => Object.assign({}, a, {
          inputs: (a.inputs || []).map(brief),
          outputs: (a.outputs || []).map(brief),
        }));
        const ok = this.copySecret(JSON.stringify(shareable, null, 2));
        this.setState({ txAuditCopied: ok });
        clearTimeout(this._auditT);
        this._auditT = setTimeout(() => this.setState({ txAuditCopied: false }), 2000);
      },
      /* A payment taken on trust says so where the word PENDING would be, and
       * then says what that means. "Pending" on its own is what a broadcast
       * says, and a broadcast cannot be taken away from anybody. */
      // FAILED before PENDING: a refused payment taken back is not settled, and is not waiting either
      txStatus: tx.highRisk ? 'HIGH RISK' : tx.atRisk ? 'AT RISK' : tx.failed ? 'FAILED' : tx.pending ? 'PENDING' : 'COMPLETE',
      txStatusInk: (tx.atRisk || tx.highRisk) ? 'var(--bad)' : 'var(--ink)',
      /* An over-payment and its change, which are one transaction.
       *
       * Offline with no exact pieces the payer covers the amount and the
       * receiver hands the difference back, so the list shows the net — and
       * this is where the arithmetic lives: what moved, what came back, what it
       * came to. Kept on the entry, so somebody reporting a payment that looked
       * wrong can send these three numbers rather than describe them. Nothing shows on an ordinary payment. */
      txHasChange: Number(tx.changeSats) > 0,
      txGross: (tx.dir === 'in' ? 'Received ' : 'Paid ')
        + this.money(Number(tx.grossSats) || 0, this.txFiat(tx, Number(tx.grossSats) || 0)).main,
      txChange: this.money(Number(tx.changeSats) || 0, this.txFiat(tx, Number(tx.changeSats) || 0)).main
        + (tx.changeState === 'never came' || tx.changeState === 'never sent' ? ' expected'
           : tx.changeState === 'not handed' ? ' owed to them'
           : tx.changeState === 'owed' || tx.changeState === 'making' ? ' due'
           : tx.changeState === 'collected' ? ' collected later'
           : tx.dir === 'in' ? ' given back' : ' back'),
      txChangeNet: (tx.dir === 'in' ? '+' : '\u2212') + this.money(tx.sats, this.txFiat(tx, tx.sats)).main,
      txChangeState: tx.changeState === 'never came' ? 'The change never arrived.'
        : tx.changeState === 'never sent' ? 'The change could not be sent, so it was all kept.'
        : (tx.changeState === 'not handed' && /^card/.test(String(tx.memo || '')))
          ? 'Their change was made and is waiting for their card. It is locked to that card: '
            + 'MENU \u203a FLASHCARD, and tap the card, to put it back.'
        : tx.changeState === 'not handed' ? 'Their change was made and could not be handed over. '
          + 'Show them the token below: it is locked to their phone, so only they can take it.'
        : tx.changeState === 'owed' ? 'Waiting for the change.'
        : tx.changeState === 'collected' ? 'The change was collected later, and is a payment of its own in this list.'
        : tx.changeState === 'making' ? 'Making the change.'
        : '',
      txChangeStateInk: (tx.changeState === 'never came' || tx.changeState === 'never sent'
                         || tx.changeState === 'not handed')
        ? 'var(--bad)' : 'rgba(var(--ink-rgb),.55)',
      txAtRisk: !!tx.atRisk || !!tx.highRisk,
      txClaimCta: s.txClaiming ? (tx.highRisk ? 'CHECKING\u2026' : 'CLAIMING\u2026') : tx.highRisk ? 'MAKE IT SAFE NOW' : 'CLAIM NOW',
      txClaimNow: () => (tx.highRisk ? this.settleAtRiskNow() : this.claimAtRiskNow()),
      txAtRiskLine: tx.atRisk
        ? 'You accepted this while you and the payer were both offline, so nothing here could '
          + 'settle it. It is counted in your balance, and until this phone is online the payer '
          + 'can still spend their copy and take it back. Connect to settle it.'
        : tx.highRisk
        ? 'They refused this payment and did not send it back locked to you. They have seen this '
          + 'ecash and can still redeem it. It is in your balance and you can spend it, and Foxy swaps '
          + 'it for ecash nobody has seen as soon as it has a connection.'
        : '',
      /* RECLAIM is a swap that takes a token's proofs back, and offering it is
       * only safe while this phone can find out whether anybody has taken them.
       * Offline it cannot: the receiver may be holding that very payment on
       * trust, unswapped, because they have no route either — and taking it back
       * is the double spend they agreed to risk, handed to them by a button.
       * The token is still on the screen to show
       * or copy; what goes is the offer to undo it. */
      // the token is still there to show or copy: handing it to the same person
      // again is not a double spend
      /* And it stays after it is claimed, and the change a
       * receiver made stays on the payment it was for: somebody who says the
       * money never reached them can be shown the very token, and their own
       * wallet tells them whether it was taken. What is shown is `txText`:
       * the unclaimed token, or the kept one, or — on a payment received —
       * the change made for the payer. */
      txHasToken: !!txText,
      txTokenTitle: tx.dir === 'in' ? 'PAYER CHANGE TOKENS' : (tx.token ? 'PAYMENT TOKEN' : 'PAYMENT TOKEN \u00b7 CLAIMED'),
      txTokenNote: tx.dir === 'in'
        ? (tx.token ? 'Not handed over yet. Locked to the payer\u2019s phone: only they can take it.'
                    : 'Locked to the payer\u2019s phone. If they say it never came, show them this: their wallet will take it, or say it was already claimed.')
        : (tx.token ? '' : 'Already claimed. Shown to whoever was paid, their wallet will say so.'),
      txTokenNoteShown: !(tx.dir !== 'in' && tx.token),
      /* Taking it back is. RECLAIM swaps the proofs away from whoever has them,
       * and on a payment that crossed a tap that is somebody holding it on
       * trust with no route to settle it — the mint will honour the swap and
       * they have no way to see it coming. Offline it is worse again: this
       * phone cannot even find out whether anybody took it. */
      txCanReclaim: !!tx.token && tx.dir !== 'in' && !tx.handedByTap && !this.offlineNow(),
      txReclaimCta: s.txReclaiming ? 'RECLAIMING\u2026' : 'RECLAIM THESE SATS',
      txReclaimInk: s.txReclaiming ? 'rgba(var(--ink-rgb),.4)' : 'var(--ink)',
      txReclaim: () => this.reclaimFromTx(tx.token),
      /* The same token as a code, for somebody standing there with a camera.
       * It is the token screen a send ends on, opened on this entry's token,
       * with the way back leading here. */
      txShowQr: () => {
        if (!txText) return;
        console.log('[foxy] history: showing an entry\u2019s token as a code');
        /* A token still unclaimed goes to the token screen, which watches for
         * it being taken. One already claimed, or change made for a payer, is
         * only shown: that screen would see "claimed" and close under the
         * person looking at it. */
        if (tx.token && tx.dir !== 'in') { this.showTokenCode(tx.token, tx.hash || ''); return; }
        if (this.stageScreen) {
          this.stageScreen('keptToken', {
            title: tx.dir === 'in' ? 'Payer<br>change' : 'Payment<br>token',
            qr: txText,
            body: tx.dir === 'in'
              ? 'The payer scans this to take their change. If it was already taken, their wallet will say so.'
              : 'Already claimed. Scanned by whoever was paid, their wallet will say so.',
            button: 'DONE', go: () => {},
          });
        }
      },
      txTokenCta: 'SHARE TOKEN',
      txCopyToken: () => {
        const W = window.FoxyWallet;
        if (!txText) return;
        if (!W || !W.share || !W.share(txText)) {
          const ok = this.copySecret(txText);
          this.toast(ok ? 'Copied.' : 'Could not share.', !ok);
        }
      },
      // an ecash transaction never touched lightning
      /* An ecash transfer is not Lightning.
       *
       * A token receive showed NETWORK: Lightning while its payment id read
       * token-1789157866360 — no Lightning was involved. The send side got
       * this right because its memo says 'ecash'; the receive side had
       * nothing to go on but the quote id, which is exactly the signal.
       *
       * An on-chain payment read Lightning the same way, with a bc1 address
       * under TO and onchain-01a0c093… under PAYMENT ID.
       * Nothing sets rail on those entries, so they fell through to the
       * default, and the id is the signal here too (16a-onchain.js). */
      /* And a request another Foxy paid, by tap or over Tor: its id starts
       * req-, and it showed as a Lightning payment on the receiver between
       * two phones at one mint. Change that
       * came back and ecash taken back are ecash the same way. */
      txNetwork: (tx.token || tx.memo === 'ecash'
        || /^(token-|req-|tap-change-|reclaim-)/.test(String(tx.hash || ''))) ? 'CASHU'
        : String(tx.hash || '').indexOf('onchain-') === 0 ? 'ON-CHAIN'
        : (tx.rail || 'LIGHTNING'),
      txPartyLabel: tx.dir === 'in' ? 'FROM' : 'TO',
      txParty: tx.party || tx.name || '—',
      txHasNote: !!tx.note,
      txNote: tx.note || '',
      // a note can be added to any payment, and changed
      txNoteCta: tx.note ? 'EDIT NOTE' : 'ADD A NOTE',
      txNoteEdit: () => this.editTxNote(),
      txFee: tx.unit ? this.unitMoney(tx.feeAmount || 0, tx.unit) : this.money(tx.fee == null ? 0 : tx.fee, this.txFiat(tx, tx.fee == null ? 0 : tx.fee)).main,
      txFeeAlt: tx.unit ? this.unitLabel(tx.unit) : this.money(tx.fee == null ? 0 : tx.fee, this.txFiat(tx, tx.fee == null ? 0 : tx.fee)).sub,
      txTime: tx.stamp || tx.time || '—',
    };
  }

  /* contacts: saved handles, and the search over them. */
  /** @param {RenderContext} c */
  renderContacts(c) {
    const { s, sc } = c;
    return {
      isContacts: sc === 'contacts',
      contactAll: this.contactRows(),
      contactLetter: (this.contactRows()[0] || {}).ini || '',
      contactRecents: this.contactRows().slice(0, 3),
      /* A contact is paid at a Lightning address, which offline can be neither
       * resolved nor paid. The list itself is local and could be shown, but a
       * screen of people none of whom can be paid is a worse answer than saying
       * so at the door. */
      goContacts: () => {
        if (this.offlineNow()) { this.offlineNo('Paying a contact'); return; }
        this.go('contacts');
      },
      openContactSearch: () => this.setState({ ctSearch: true, ctQuery: '' }),
      closeContactSearch: () => this.setState({ ctSearch: false, ctQuery: '' }),
      ctSearchOpen: !!s.ctSearch,
      ctQuery: s.ctQuery || '',
      /* Deliberate, not residue. Most people this app is for hold a Wallet
       * of Satoshi account, and a lightning address is easy to mistype in a
       * way that sends money to a stranger. This appends the domain to a
       * recipient being typed — it never claims to be the user's own
       * address, which is the thing the audit found and which stays gone. */
      ctQueryInput: (e) => this.setState({ ctQuery: e.target.value }),
      ctFocusRef: this._refCt || (this._refCt = (el) => this.autoFocus('ct', el)),
      ctEmpty: (s.ctQuery || '').trim().toLowerCase().length === 0,
      contactsEmpty: s.walletLive ? this.contactRows().length === 0 : !!s.fresh,
      contactsAny: s.walletLive ? this.contactRows().length > 0 : !s.fresh,
      ctResults: (function (qq) {
        if (!qq || s.fresh) return [];
        return (s.contacts || []).filter(c => c.name.toLowerCase().indexOf(qq) >= 0 || c.handle.toLowerCase().indexOf(qq) >= 0)
          .map(c => ({ name: c.name, handle: c.handle, initial: c.name.charAt(0), tint: c.tint }));
      })((s.ctQuery || '').trim().toLowerCase()),
      ctHasResults: (function (qq) {
        if (!qq || s.fresh) return false;
        return (s.contacts || []).some(c => c.name.toLowerCase().indexOf(qq) >= 0 || c.handle.toLowerCase().indexOf(qq) >= 0);
      })((s.ctQuery || '').trim().toLowerCase()),
      ctCount: (function (qq) {
        if (!qq) return '';
        const n = (s.contacts || []).filter(c => c.name.toLowerCase().indexOf(qq) >= 0 || c.handle.toLowerCase().indexOf(qq) >= 0).length;
        return n === 1 ? '1 MATCH' : n + ' MATCHES';
      })((s.ctQuery || '').trim().toLowerCase()),
      // a full handle nobody has saved still resolves — payable, flagged as not a contact
      ctStrangerShown: (function (qq) {
        if (qq.indexOf('@') < 0 || qq.length < 5) return false;
        return !(s.contacts || []).some(c => c.handle.toLowerCase() === qq);
      })((s.ctQuery || '').trim().toLowerCase()),
      ctStrangerHandle: (s.ctQuery || '').trim().toLowerCase(),
      ctStrangerInitial: (s.ctQuery || '').trim().toLowerCase().charAt(0).toUpperCase(),
      ctNoneShown: (function (qq) {
        if (!qq) return false;
        const hit = !s.fresh && (s.contacts || []).some(c => c.name.toLowerCase().indexOf(qq) >= 0 || c.handle.toLowerCase().indexOf(qq) >= 0);
        return !hit && qq.indexOf('@') < 0;
      })((s.ctQuery || '').trim().toLowerCase()),
      payContact: () => this.setState(p => {
        const qq = (p.ctQuery || '').trim().toLowerCase();
        const hit = (s.contacts || []).filter(c => c.name.toLowerCase().indexOf(qq) >= 0 || c.handle.toLowerCase().indexOf(qq) >= 0)[0];
        return {
          screen: 'amount', stack: p.stack.concat([p.screen]), flow: 'send',
          recipient: qq ? ((hit && hit.handle) || qq) : '',
          recipientKind: 'email', ctSearch: false,
          amount: '', unit: 'USD', asset: '',
        };
      }),
    };
  }
