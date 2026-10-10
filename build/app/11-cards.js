
  blockedCard(kind, over) {
    const spec = Object.assign({}, this.BLOCKED_INFO(kind) || {}, over || {});
    if (!spec.title) return;

    /* One card at a time, and none lost.
     *
     * A new card used to replace whatever card was open. On a simulator tour
     * "PAID, NOT COLLECTED YET" appeared and, four seconds later, the test-mint
     * card took its place — the stuck invoice was never seen. A card arriving
     * while another is open now waits, and shows when that one closes. The same
     * kind arriving again replaces the one waiting, so repeats do not pile up;
     * the same kind as the open card replaces it, as before. */
    if (this._blockedEl) {
      if (this._blockedKind !== kind) {
        this._cardQueue = (this._cardQueue || []).filter(c => c.kind !== kind);
        this._cardQueue.push({ kind, over });
        return;
      }
      this._blockedEl.remove();
    }
    this._blockedKind = kind;

    /* Three tones. Red is something that failed, amber something to be
     * careful of — and `ask` is neither: a card that offers a choice rather
     * than reporting trouble (SECURE FOXY). It borrows the iceberg blue the
     * home screen's Tor banner uses, so it reads as calm rather than as one
     * more thing that has gone wrong. */
    const warn = spec.tone === 'warn';
    const ask = spec.tone === 'ask';
    const accent = ask ? '#BFE3EC' : warn ? '#F7931A' : '#FF5C5C';
    const glowRgb = ask ? '191,227,236' : warn ? '247,147,26' : '255,92,92';

    const el = (style, html) => {
      const d = document.createElement('div');
      d.style.cssText = style;
      if (html) d.innerHTML = html;
      return d;
    };

    const root = el('position:fixed;inset:0;z-index:2147483400;background:rgba(0,0,0,.7);' +
      'display:flex;flex-direction:column;justify-content:flex-end;' +
      'font-family:SatSymbol,Sora,system-ui,sans-serif;animation:foxyIn .16s ease');

    const stage = el('position:relative;isolation:isolate');
    stage.appendChild(el('position:absolute;left:0;right:0;top:-290px;height:330px;' +
      'pointer-events:none;z-index:0;background:radial-gradient(ellipse 128% 100% at 50% 100%,' +
      'rgba(' + glowRgb + ',' + (ask ? '.30' : warn ? '.42' : '.38') + ') 0%,' +
      'rgba(' + glowRgb + ',' + (ask ? '.14' : warn ? '.20' : '.18') + ') 42%,rgba(0,0,0,0) 78%)'));

    const card = el('position:relative;z-index:1;background:#141518;' +
      'border-radius:28px 28px 0 0;padding:28px 26px calc(31px + env(safe-area-inset-bottom));' +
      'display:flex;flex-direction:column;align-items:center;' +
      'border-top:1px solid ' + accent + ';box-shadow:inset 0 2px 0 ' + accent);

    /* A shield for a card that is asking, not reporting: the × and the ! both
     * say something is wrong, and nothing is. */
    const shield = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
      + '<path d="M12 2.6 4.8 5.5v6c0 4.4 3 8.5 7.2 9.9 4.2-1.4 7.2-5.5 7.2-9.9v-6L12 2.6Z" '
      + 'stroke="' + accent + '" stroke-width="1.8" stroke-linejoin="round"/>'
      + '<path d="m8.8 11.9 2.3 2.3 4.1-4.5" stroke="' + accent + '" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    card.appendChild(el('width:64px;height:64px;border-radius:50%;' +
      'background:rgba(' + glowRgb + ',' + (ask ? '.13' : warn ? '.16' : '.14') + ');' +
      'display:flex;align-items:center;justify-content:center;font-size:34px;' +
      'font-weight:800;line-height:1;color:' + accent, ask ? shield : warn ? '!' : '\u00d7'));

    const title = el('font-size:22px;font-weight:800;letter-spacing:-0.022em;' +
      'color:#F5F1EC;text-align:center;margin-top:16px');
    title.textContent = spec.title;
    card.appendChild(title);

    // pre-line: a card can put its sentences on lines of their own (`tapOfflineCross`)
    /* `spec.long`: words that may be more than a screen holds (a card's log of
     * eight taps): they scroll inside the card, so its button stays in reach. */
    const reason = el('font-size:18px;font-weight:500;line-height:1.4;white-space:pre-line;' +
      'color:rgba(245,241,236,.62);text-align:center;margin-top:7px;max-width:310px'
      + (spec.long ? ';max-height:46vh;overflow-y:auto;-webkit-overflow-scrolling:touch' : ''));
    reason.textContent = spec.reason || '';
    card.appendChild(reason);

    if (spec.chip) {
      const chip = el('margin-top:14px;padding:10px 16px;border-radius:16px;' +
        'background:rgba(' + glowRgb + ',' + (ask ? '.12' : warn ? '.14' : '.12') + ');' +
        'font-size:16px;font-weight:700;color:' + accent + ';text-align:center;' +
        'white-space:pre-line;line-height:1.45');
      chip.textContent = spec.chip;
      card.appendChild(chip);
    }

    const stack = el('align-self:stretch;display:flex;flex-direction:column;gap:12px;margin-top:22px');

    const close = () => {
      root.remove();
      if (this._blockedEl === root) { this._blockedEl = null; this._blockedKind = null; }
      // the scan screen's camera, held back while the card was up, comes back
      if (this.syncPreview) setTimeout(() => this.syncPreview(), 0);
      if (spec.onClose) spec.onClose();
      // the next card that was waiting, once this one (and anything its close opened) is done
      setTimeout(() => {
        if (this._blockedEl || !(this._cardQueue || []).length) return;
        const next = this._cardQueue.shift();
        this.blockedCard(next.kind, next.over);
      }, 250);
    };

    // a card can navigate somewhere or run something; some failures are worth
    // retrying in place rather than going back a screen to do it
    if (spec.retry && (spec.back || spec.go)) {
      const go = el('height:60px;border-radius:30px;background:#F2802E;color:#fff;' +
        'display:flex;align-items:center;justify-content:center;font-size:20px;' +
        'font-weight:800;letter-spacing:0.02em;cursor:pointer');
      go.textContent = spec.retry;
      go.addEventListener('click', () => {
        close();
        if (spec.go) spec.go();
        else this.setState({ screen: spec.back });
      });
      stack.appendChild(go);
    }

    /* With nothing to retry, CLOSE is the only thing to do — so it takes the
     * primary treatment rather than sitting there as a grey afterthought. */
    const alone = !(spec.retry && (spec.back || spec.go));
    /* `shut.pill`: a second choice that is as much a choice as the first
     * (CHANGE CARD LIMITS' DAILY LIMIT under PER TAP LIMIT), drawn as a button
     * in the shape the confirmation's second button has, not as grey words. */
    const shut = alone
      ? el('height:60px;border-radius:30px;background:#F2802E;color:#fff;' +
           'display:flex;align-items:center;justify-content:center;font-size:20px;' +
           'font-weight:800;letter-spacing:0.02em;cursor:pointer')
      : (spec.shut && spec.shut.pill)
        ? el('height:60px;border-radius:30px;border:2px solid #2A2A2A;background:#101010;' +
             'box-shadow:0 8px 18px rgba(0,0,0,.6);box-sizing:border-box;' +
             'display:flex;align-items:center;justify-content:center;font-size:20px;' +
             'font-weight:800;letter-spacing:0.02em;color:#F5F1EC;cursor:pointer')
        : el('height:52px;display:flex;align-items:center;justify-content:center;' +
             'font-size:18px;font-weight:800;color:rgba(245,241,236,.55);cursor:pointer');
    /* A card can name its second choice and give it something to do
     * (PAYING ANOTHER … USER's CONTINUE OVER LIGHTNING). Tapping outside the
     * card still only closes it. */
    shut.textContent = (spec.shut && spec.shut.label) || 'CLOSE';
    shut.addEventListener('click', () => {
      close();
      if (spec.shut && spec.shut.tap) spec.shut.tap();
    });
    stack.appendChild(shut);

    /* A quieter third choice, for a card that can be turned off for good
     * (A LOT AT ONE MINT's "don't show this again"). */
    if (spec.also && spec.also.label) {
      const also = el('height:44px;display:flex;align-items:center;justify-content:center;' +
        'font-size:16px;font-weight:700;color:rgba(245,241,236,.4);cursor:pointer');
      also.textContent = spec.also.label;
      also.addEventListener('click', () => { close(); if (spec.also.tap) spec.also.tap(); });
      stack.appendChild(also);
    }

    card.appendChild(stack);
    stage.appendChild(card);
    root.appendChild(stage);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    document.body.appendChild(root);
    this._blockedEl = root;
    /* So a card that is waiting on something other than a person can be taken
     * down when that thing arrives (the payer's PRICE SENT, below). Every other
     * card is closed by a button, which is what `close` is for. */
    this._blockedClose = close;
    // a native camera preview would sit over the card
    if (this.syncPreview) this.syncPreview();
    console.log('[foxy] blocked:', kind, '\u2014', spec.reason || '');
  }

  /* Why a claim failed, and whether trying again could ever work.
   *
   * The mint's own wording is the signal. Already spent and P2PK-locked are
   * final: the token is not yours to claim and no number of attempts changes
   * that. Everything else is the mint not answering, where the token is still
   * good and retrying is the right move — so that is the only case that gets
   * a retry button.
   */
  /* A mint's signatures failed their check (NUT-12 DLEQ).
   *
   * The ecash it sent cannot be shown to be real, so it was not kept, and
   * nothing here offers to try again: the same mint would send the same thing,
   * and every attempt spends another request's worth of counters. */
  badSignatureCard(host, where, onClose) {
    const W = window.FoxyWallet;
    const name = host || (W && W.mintHost ? W.mintHost() : '') || 'This mint';
    const what = where === 'claim'
      ? 'The invoice was paid, but Foxy will not collect ecash it cannot verify, and will not ask this mint for it again.'
      : where === 'pay'
        ? 'The payment went through; the change it sent back could not be verified and was not kept.'
        : 'Nothing it sent back was kept.';
    this.blockedCard('mintTrouble', {
      tone: 'warn',
      title: 'THIS MINT SENT INVALID SIGNATURES',
      reason: name + ' sent signatures that do not match the keys it publishes. ' + what,
      chip: 'A mint doing this is broken or marking this wallet. Consider moving your balance to another mint.',
      retry: '', back: '',
      onClose: onClose || null,
    });
  }

  isBadSignatures(e) {
    return /dleq verification failed|dleq proof invalid|signatures do not match the keys|sent invalid signatures/i
      .test(String((e && (e.message || e.detail)) || e || ''));
  }

  /* Paid, not collected yet.
   *
   * The invoice was paid and the mint holds the ecash, but the claim keeps
   * failing — which used to be a line in a log, while the balance quietly did
   * not move. Once a session for each invoice, so a retry every few seconds
   * does not become a card every few seconds. */
  showStuckInvoice(hit) {
    if (!hit || !hit.quote || !hit.unclaimed) return;
    this._stuckShown = this._stuckShown || {};
    if (this._stuckShown[hit.quote]) return;
    this._stuckShown[hit.quote] = true;
    const u = hit.unclaimed;
    const host = String(hit.mint || '').replace(/^https?:\/\//, '') || 'the mint';
    const sats = this.group(Number(hit.amount) || 0);
    if (u.badSignatures) {
      this.blockedCard('stuckInvoice', {
        tone: 'warn',
        title: 'PAID, NOT COLLECTED',
        reason: sats + ' sats at ' + host + '. The mint sent invalid signatures for it, so Foxy will not collect it or ask again.',
        chip: 'Consider moving your balance to another mint.',
      });
      return;
    }
    /* Refused three times: Foxy stops asking on its own, since each try uses
     * counters the mint never signs and a long run of them hides later ecash
     * from a restore (audit finding W2). One more try is the person's. */
    if (u.refused >= 3) {
      this.blockedCard('stuckInvoice', {
        tone: 'warn',
        title: 'PAID, NOT COLLECTED',
        reason: sats + ' sats at ' + host + '. The mint refused to hand them over three times'
          + (u.reason ? ' (' + u.reason + ')' : '') + ', so Foxy stopped asking on its own.',
        chip: 'The money is still at the mint. Try again later, or ask the mint what is wrong.',
        retry: 'TRY AGAIN',
        go: () => {
          window.FoxyWallet.retryRefusedClaim(hit.quote).then(() => {
            this.toast('Collected ' + sats + ' sats');
            this.refreshBalance();
          }, e => this.claimFailed(e));
        },
      });
      return;
    }
    /* Asked and asked and never answered. Foxy stops for the same reason it
     * stops after three refusals: every try reserves counters the mint may
     * never sign, and a long run of them hides later ecash from a restore. */
    if (u.gaveUp === 'silence') {
      this.blockedCard('stuckInvoice', {
        tone: 'warn',
        title: 'PAID, NOT COLLECTED',
        reason: sats + ' sats at ' + host + '. Foxy asked for them ' + (u.tries || 10)
          + ' times and the mint never answered'
          + (u.reason ? ' (' + u.reason + ')' : '') + ', so it stopped asking on its own.',
        chip: 'The money is still at the mint. Try again when it is answering.',
        retry: 'TRY AGAIN',
        go: () => {
          window.FoxyWallet.retryRefusedClaim(hit.quote).then(() => {
            this.toast('Collected ' + sats + ' sats');
            this.refreshBalance();
          }, e => this.claimFailed(e));
        },
      });
      return;
    }
    this.blockedCard('stuckInvoice', {
      tone: 'warn',
      title: 'PAID, NOT COLLECTED YET',
      reason: sats + ' sats at ' + host + ' \u2014 retrying. ' + (u.reason || ''),
      chip: 'The money is at the mint, waiting for this phone. Keep Foxy installed until it arrives.',
    });
  }

  claimFailed(e, again) {
    const W = window.FoxyWallet;

    /* Classify on the RAW error, display the translated one.
     *
     * reason() rewrites errors for humans before returning them — "already
     * spent" becomes "Already claimed — somebody took this token." Matching
     * the translated text meant matching words that were no longer in it, so
     * everything landed in the network bucket. The friendly wording is kept
     * here as a fallback for when the raw message is not available. */
    const raw = String((e && (e.message || e.detail)) || e || '').toLowerCase();
    const why = (W && W.reason) ? W.reason(e) : String((e && e.message) || e);
    const low = (raw + ' ' + String(why)).toLowerCase();

    // your own tap on Cancel is not a failure worth a card
    if (/cancelled|canceled/.test(low)) return;

    // not a connection problem, and not one to try again
    if (this.isBadSignatures(e)) { this.badSignatureCard(null, 'swap'); return; }

    /* Each of these three is its own kind, not all `netLost`.
     *
     * The queue below deduplicates by kind: a card arriving while another is
     * open waits, and a waiting card of the same kind is dropped as a repeat.
     * All three claim failures shared one kind, so they counted as repeats of
     * each other — "LOCKED TO SOMEONE ELSE" arriving behind "CONNECTION LOST"
     * threw the connection card away, and the person was told the one thing
     * that happened to arrive last. They are different answers and they queue
     * as different answers. It also means the diary line names what happened
     * rather than saying netLost for a lock that has nothing to do with the
     * network. */
    /* Already here. The mint says spent and this phone is who spent it: a
     * payment that landed while its "paid" did not reach the payer, shown to
     * this phone again as a code. Not a warning, and nothing to do. The two
     * offline refusals of the same thing say it in the same card. */
    if ((e && e.foxyMine) || /already took that ecash|already has that ecash|already been paid this ecash/.test(low)) {
      const at = Number(e && e.foxyTakenAt) || 0;
      const sats = Math.round(Number(e && e.foxyTakenSats) || 0);
      const when = (at > 0 && this.tapAgoWords) ? ' ' + this.tapAgoWords(at) : '';
      this.blockedCard('tokenMine', {
        title: 'YOU ALREADY HAVE THIS PAYMENT',
        reason: 'This phone took this ecash' + when + '.'
          + (sats > 0 ? ' ' + this.group(sats) + ' sats, in your balance.' : ' It is in your balance.'),
        chip: 'Nothing more to do. It was not taken twice.',
        retry: '', back: '', tone: 'ask',
      });
      return;
    }

    if (/already spent|token already|already claimed|somebody took/.test(low)) {
      this.blockedCard('tokenSpent', {
        title: 'TOKEN ALREADY REDEEMED',
        reason: 'This token was claimed already \u2014 by someone else, or by this wallet.',
        chip: 'Nothing was taken from you.',
        retry: '', back: '', tone: 'warn',
      });
      return;
    }

    /* Not the offline refusal, which says "locked to it" about this phone and
     * was shown as LOCKED TO SOMEONE ELSE — about plain ecash with no lock on
     * it at all. */
    if (/p2pk|spend conditions|locked to/.test(low) && !/this phone is offline/.test(low)) {
      this.blockedCard('lockedElsewhere', {
        title: 'LOCKED TO SOMEONE ELSE',
        reason: 'This token is locked to a key this wallet does not hold, so it cannot be claimed here.',
        chip: 'Ask the sender for one that is not locked.',
        retry: '', back: '', tone: 'warn',
      });
      return;
    }


    this.blockedCard('mintUnreachable', {
      /* Amber, as it was while this shared netLost's row: nothing has failed
       * finally — the token is still good and the next attempt may work. */
      tone: 'warn',
      title: 'COULD NOT REACH THE MINT',
      reason: why,
      chip: 'The token is still good. Try again in a moment.',
      retry: again ? 'TRY AGAIN' : '', back: '',
      go: again || null,
    });
  }

  /* The same table the screens read, reachable from a method. */
  /* ---- both phones offline: the one question software cannot answer ------
   *
   * Unlocked ecash taken with no route is not settled and cannot be settled
   * here: the payer keeps a copy, and until this phone can swap, nothing on it
   * can find out whether they spent it again. Whether this particular payer
   * would is not a question about software, so it is put to the person holding
   * the phone, once, with the amount in front of them.
   *
   * Resolves true to take it and false for everything else — REJECT, a tap
   * outside the card, a card that could not be drawn. Never taking the money is
   * the safe failure: the payer keeps their own ecash and can offer it again to
   * either phone with a route.
   *
   * The dollar figure is this phone's own last price and says how old it is,
   * because offline it can be hours old and a stale figure presented as current
   * is its own small lie. Sats are the amount; dollars are the gloss. */
  offlineRiskCard(info) {
    const sats = Number(info && info.sats) || 0;
    const rate = this.satUsd ? this.satUsd() : 0;
    const W0 = window.FoxyWallet;
    const at = (W0 && Number(W0._rateAt)) || 0;
    const age = (at && this.agoWords) ? this.agoWords(Date.now() - at) : '';
    const worth = rate > 0 ? '$ ' + this.usd(sats * rate) : '';
    /* Three lines, dollars first: the amount, the sats
     * under it, and how old the price is that turned one into the other. */
    const chip = worth
      ? 'Amount ' + worth + '\n\u20bf ' + this.group(sats) + (age ? '\nPrice ' + age : '')
      : 'Amount \u20bf ' + this.group(sats);
    /* Nothing over it. A scanned token raises VERIFYING ECASH before anything
     * is known about it, and that screen sits above every card: the question
     * was asked underneath it, where nobody could see it or answer it, and the
     * person watched a verifying screen until they killed the app. */
    if (info && info.scanned && this.receivingDown) this.receivingDown();
    return new Promise((resolve) => {
      let done = false;
      const say = (yes) => { if (done) return; done = true; resolve(yes); };
      this.blockedCard('offlineRisk', {
        tone: 'warn',
        title: info && info.scanned ? 'HIGH RISK \u2014 YOU ARE OFFLINE'
          : 'HIGH RISK \u2014 YOU ARE BOTH OFFLINE',
        reason: info && info.scanned
          ? 'This ecash is not locked to you and this phone is offline, so nothing here can '
            + 'settle it. Until you get online, whoever gave it to you can still spend it. '
            + 'Continue only if you trust them. Otherwise connect first and take it then.'
          : 'You and whoever is paying you are both offline, so nothing here can settle '
          + 'this payment. Until you get online, they can technically take their money back. '
          + 'Continue only if you trust them. Otherwise connect first and take the payment then.',
        chip: chip,
        retry: 'CONTINUE', go: () => say(true),
        shut: { label: 'REJECT', tap: () => say(false) },
        /* A tap outside the card is a rejection, and it has to be, or the payer
         * waits on a promise nobody will ever settle.
         *
         * Deferred by a tick on purpose: `close()` runs `onClose` before it runs
         * the button's own handler, so a straight call here would answer "no"
         * for CONTINUE as well. A tick later, whichever button was pressed has
         * already spoken and `done` is set. */
        onClose: () => setTimeout(() => say(false), 0),
      });
      // a card that could not be drawn must not hold the payer's link open
      if (!this._blockedEl && !(this._cardQueue || []).some((c) => c.kind === 'offlineRisk')) say(false);
    });
  }

  /* Their change did not go back: say so, and put the way to fix it one press
   * away. It is locked to their phone, so showing it costs nothing and only
   * they can take it. */
  /* Change is about to be made for a scanned payment: the payment's
   * confirmation waits behind the change card (announcePayment). Bounded, so
   * a swap that fails or hangs does not swallow the confirmation. */
  changeMaking(info) {
    this._holdConfirmUntil = Date.now() + 12000;
    // whichever payment's confirmation comes in that time: a scanned payment's change is made as it lands
    this._holdConfirmFor = '';
    clearTimeout(this._holdConfirmT);
    this._holdConfirmT = setTimeout(() => this.releaseHeldConfirm('the change took too long'), 12000);
  }

  releaseHeldConfirm(why) {
    clearTimeout(this._holdConfirmT);
    this._holdConfirmUntil = 0;
    this._holdConfirmFor = '';
    const ev = this._heldConfirm;
    if (!ev) return;
    this._heldConfirm = null;
    console.log('[foxy] confirmation: released (' + why + ')');
    this.announcePayment(Object.assign({}, ev, { force: true, again: true }));
  }

  changeStuckCard(info) {
    const sats = Math.round(Number(info && info.sats) || 0);
    const token = String((info && info.token) || '');
    if (!(sats > 0) || !token) return;
    console.log('[foxy] change: ' + sats + ' sats could not be handed back; asking this phone to show it');
    if (!this.stageScreen) { this.releaseHeldConfirm('no stage screen'); this.showTokenCode(token, (info && info.hash) || ''); return; }
    /* The screen: the three amounts, the code, and one thing to do. It is also
     * on the payment's entry in history, so DONE loses nothing. The
     * confirmation, held while the change was made, follows DONE
     * (changeMaking). */
    if (info && info.refund) {
      /* The whole payment going back, because it could not be brought to
       * this phone's own mint. Not received, and the screen says so. */
      clearTimeout(this._holdConfirmT);
      this.stageScreen('changeStuck', {
        title: 'Not received.<br>Send it back', qr: token,
        rows: [{ label: 'GOING BACK', value: this.stageMoney(sats) }],
        body: 'The payment could not be brought to your mint, so it was not received. Ask the payer to scan this to take it back.',
        button: 'DONE',
        go: () => this.releaseHeldConfirm('the refund card was dismissed'),
      });
      return;
    }
    const paid = Math.round(Number(info && info.paid) || 0);
    const asked = Math.round(Number(info && info.asked) || (paid > sats ? paid - sats : 0));
    const rows = [{ label: 'CHANGE DUE', value: this.stageMoney(sats) }];
    if (asked > 0) rows.push({ label: 'AMOUNT CHARGED', value: this.stageMoney(asked) });
    if (paid > 0) rows.push({ label: 'AMOUNT RECEIVED', value: this.stageMoney(paid) });
    clearTimeout(this._holdConfirmT);
    this.stageScreen('changeStuck', {
      title: 'You owe the<br>payer change', qr: token, rows: rows,
      body: 'The payer sent more than you requested. Ask them to scan this to receive their change.',
      button: 'DONE',
      go: () => this.releaseHeldConfirm('the change card was dismissed'),
    });
  }

  /* A token as a code, with the token's own amount. An entry's amount is what
   * the payment came to, which for change owed is a different number: the code
   * for 1,190 sats of change said ₿ 13 above it. */
  showTokenCode(token, hash) {
    const W = window.FoxyWallet;
    let sats = 0;
    try {
      const info = W.tokenInfo(token);
      sats = info ? Math.round(info.sats != null ? info.sats : info.amount) || 0 : 0;
    } catch (e) { sats = 0; }
    this.setState(p => ({
      tokenCopied: false, tokenOut: token, tokenOutSats: sats,
      tokenOutHash: hash || '', tokenOutFee: 0, tokenForPayee: true,
      screen: 'tokenOut', stack: p.screen === 'tokenOut' ? p.stack : p.stack.concat([p.screen]),
    }));
  }

  /* Take a card down because what it was waiting for has happened.
   *
   * Only the named kind, and only if it is the one on screen: a card the person
   * is reading must not vanish because something else finished. A card of that
   * kind still queued is dropped too — showing it after the fact would be
   * telling somebody to wait for a thing that has already come. */
  dismissCard(kind) {
    this._cardQueue = (this._cardQueue || []).filter((c) => c.kind !== kind);
    if (this._blockedEl && this._blockedKind === kind && this._blockedClose) this._blockedClose();
  }

  /* Paying somebody at another mint costs a Lightning fee. Asked, never assumed.
   *
   * Ecash from this phone's mint is no use to them, so the sats have to be
   * moved to theirs first — a melt here and a mint quote there, which is a real
   * Lightning payment with a real routing fee. The person is paying that fee on
   * top of the amount, and a wallet does not spend somebody's money on a route
   * because the alternative was refusing.
   *
   * The fee is a ceiling, not a price: the reserve the route does not use comes
   * back as change, so the card says "up to". Asked before anything melts, so a
   * no costs nothing at all.
   *
   * Resolves true to move and pay. Everything else — CANCEL, a tap outside, a
   * card that could not be drawn — is false.
   */
  /* The other side of the same decision: they will carry the payment home, and
   * this is what it costs.
   *
   * This phone has no route, so its sats cannot leave the mint they are at. The
   * receiver does have one, and has quoted the way home. The figures are the
   * same three — what leaves, what they get, what the crossing costs — so it is
   * the same screen, and pressing PAY is the last thing there is to do.
   *
   * Resolves true to pay. CANCEL, the X, and a screen that could not be raised
   * are all false.
   */
  crossFeeCard(terms, stuck, theirMint) {
    const ask = Math.round(Number(terms && terms.sats) || 0);
    const net = Math.round(Number(terms && terms.net) || 0);
    const fee = Math.max(0, Number(terms && terms.fee) || (ask - net));
    const at = (terms && terms.at) || (stuck && stuck.mint);
    return new Promise((resolve) => {
      let done = false;
      this._crossSay = (yes) => { if (done) return; done = true; resolve(!!yes); };
      this.setState((p) => ({
        screen: 'crossConfirm', stack: p.stack.concat([p.screen]), crossBusy: false,
        crossQ: {
          net: net, fee: fee,
          /* Named, from the offer where the terms do not say: "THEIR MINT"
           * under the heading THEIR MINT told nobody anything. */
          them: this.mintNameOf((terms && terms.to) || theirMint)
            || String((terms && terms.to) || theirMint || 'their mint').replace(/^https?:\/\//, ''),
          mine: this.mintNameOf(at) || String(at || '').replace(/^https?:\/\//, ''),
        },
      }));
    });
  }

  /* Paying somebody at another mint: the fee, and the only button that sends.
   *
   * A screen, and THE confirmation for this payment. It was a card, and
   * agreeing to it opened the ordinary confirmation which then had to be sent —
   * so one decision was put to the person twice ("when they
   * agree to the use of another mint that should be the last thing they need to
   * do"). `crossSpec` lays it out and `crossAnswer` settles this.
   *
   * Resolves true to move and pay. CANCEL, the X, and a screen that could not
   * be raised are all false.
   */
  /* `plan` may be a promise: the screen opens on what is already known — the
   * amount, and both mints — and the fee fills in when the two mints answer.
   * Until then its button says so and does nothing. */
  crossMintCard(plan, theirMint, myMint) {
    if (plan && typeof plan.then === 'function') {
      /* Not until the fee is known. This opened at once on "0 + fee" and
       * WORKING IT OUT, a confirmation with nothing in it to confirm; what is
       * looked at while the two mints answer is CALCULATING FEE, and the
       * confirmation arrives whole. A quote that was asked
       * for ahead is here already, so that screen is only put up for a wait
       * long enough to see. */
      return new Promise((resolve, reject) => {
        let over = false, shown = false;
        const down = () => { if (shown && this.hideStage) this.hideStage('calcFee'); };
        const up = setTimeout(() => {
          if (over || !this.stageScreen) return;
          shown = true;
          this.stageScreen('calcFee', {
            art: 'mints', title: 'Calculating<br>fee', dots: true, forMs: 45000,
            body: 'The receiver uses another mint, wait while I calculate the fee to pay them.',
            button: 'CANCEL',
            go: () => { if (over) return; over = true; console.log('[foxy] crossing: cancelled while the fee was being worked out'); resolve(false); },
          });
        }, 120);
        plan.then((p) => {
          clearTimeout(up); down();
          if (over) return;
          over = true;
          this.crossMintCard(p, theirMint, myMint).then(resolve, reject);
        }, (e) => {
          clearTimeout(up); down();
          if (over) return;
          over = true;
          reject(e);
        });
      });
    }
    const net = Number(plan && plan.net) || Number(plan && plan.moving) || 0;
    const fee = plan ? Math.max(0, Number(plan.feeSats) || 0) : null;
    return new Promise((resolve) => {
      let done = false;
      this._crossSay = (yes) => { if (done) return; done = true; resolve(!!yes); };
      this.setState((p) => ({
        screen: 'crossConfirm', stack: p.stack.concat([p.screen]), crossBusy: false,
        crossQ: {
          net: net, fee: fee,
          them: this.mintNameOf(theirMint) || String(theirMint || '').replace(/^https?:\/\//, ''),
          mine: this.mintNameOf(myMint) || String(myMint || '').replace(/^https?:\/\//, ''),
        },
      }));
    });
  }

  /* The paying phone's price, for a person with no route to agree to.
   *
   * This phone asked in dollars because its own bitcoin price may be hours old
   * (`dollarsOnly`). The payer has a current one and has said what it is and
   * what that makes of the amount. Nothing has left them: the sats move only
   * once this card is accepted and the request goes back in sats (M11).
   *
   * The comparison is worked out here, from what this phone last saw, so a
   * payer cannot dress it up (`readQuote`). With no price ever seen there is
   * nothing to weigh it against, and the card says exactly that rather than
   * implying agreement.
   *
   * Resolves true to accept. Everything else — DENY, a tap outside, a card that
   * could not be drawn — is false, and false is the safe failure: nothing has
   * been asked of anybody and nothing has moved.
   */
  /* The paying phone's price, for a person with no route to agree to.
   *
   * A screen, not a card: it is a person weighing two figures and deciding,
   * which is what the confirmation shell is for, and a card is for something
   * that went wrong. `priceSpec` lays it out and
   * `priceAnswer` settles this promise, whichever control they use.
   *
   * Resolves true to accept. Everything else — NO REJECT, the X, a screen that
   * could not be raised — is false, and false is the safe failure: nothing has
   * been asked of anybody and nothing has moved.
   */
  priceTermsCard(q) {
    /* The same price is not a question. Under a tenth of a percent there is
     * nothing to weigh, so it is agreed without asking.
     * No earlier price at all is not "the same" and is still asked. */
    const pct = (q && q.differsPct != null) ? Number(q.differsPct) : null;
    if (pct != null && isFinite(pct) && Math.abs(pct) < 0.1) {
      console.log('[foxy] price: the same as this phone\u2019s, agreed without asking');
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let done = false;
      this._priceSay = (yes) => { if (done) return; done = true; resolve(!!yes); };
      this.setState((p) => ({ screen: 'priceConfirm', stack: p.stack.concat([p.screen]),
                              priceQ: q }));
    });
  }

  /* No exact change, so the amount cannot be paid without over-paying.
   *
   * Asked, never assumed. Where the receiver has a route the difference comes
   * straight back over the same link; where neither phone has one it cannot come
   * back at all, and the extra is a gift. A wallet does not give somebody's
   * money away because the arithmetic was convenient.
   *
   * Resolves true to send and false for everything else — the cancel, a tap
   * outside, a card that could not be drawn. Not sending is the safe failure:
   * nothing has been made and nothing has moved. */
  overpayCard(info) {
    const asked = Number(info && info.asked) || 0;
    const pay = Number(info && info.pay) || 0;
    const over = Number(info && info.over) || 0;
    const back = !!(info && info.changeComesBack);
    return new Promise((resolve) => {
      let done = false;
      const say = (yes) => { if (done) return; done = true; resolve(yes); };
      this.blockedCard('overpay', {
        tone: 'warn',
        title: 'YOU DON\u2019T HAVE EXACT CHANGE',
        reason: back
          ? 'The smallest you can make is ' + this.group(pay) + ' sats for a '
            + this.group(asked) + '-sat payment. They are online, so the extra '
            + this.group(over) + ' sats come straight back to you as change.'
          : (info && info.says)
          ? 'The smallest you can make is ' + this.group(pay) + ' sats for a '
            + this.group(asked) + '-sat payment. ' + info.says
          : 'The smallest you can make is ' + this.group(pay) + ' sats for a '
            + this.group(asked) + '-sat payment. You are both offline, so they '
            + 'cannot give you the extra ' + this.group(over) + ' sats back \u2014 they keep it.',
        chip: this.group(asked) + ' sats owed  \u00b7  ' + this.group(over) + ' sats over',
        retry: 'YES, SEND ' + this.money(pay).main, go: () => say(true),
        shut: { label: 'NO, CANCEL', tap: () => say(false) },
        // a tap outside is a cancel; deferred a tick so a button answers first
        onClose: () => setTimeout(() => say(false), 0),
      });
      if (!this._blockedEl && !(this._cardQueue || []).some((c) => c.kind === 'overpay')) say(false);
    });
  }

  /* A payment taken on trust while both phones were offline, and the payer spent
   * their copy back. Said plainly: this is money that was shown, counted, and is
   * now gone, and the person who chose to trust them has to hear it from Foxy
   * rather than work it out from a balance that quietly shrank. */
  /* A payment taken at risk has settled: its own confirmation, saying so. */
  trustSettled(info) {
    /* Said by YOUR MONEY IS SAFE, with everything else that was claimed
     * (`moneyIsSafe`). Its own confirmation was raised as a screen and lost at
     * once to the reconnect going on around it: nobody saw it. */
    this.loadHistory();
  }

  /* YOUR MONEY IS SAFE: what was waiting for a connection has been swapped in.
   *
   * One screen for all of it, with the total, because that is the question a
   * person coming back online has — is what I was paid really mine now — and
   * the answer is one figure, not a confirmation per payment. Drawn over everything rather than as a screen of the app, so
   * a reconnect changing screens under it cannot take it away. The total
   * grows while it is up and starts again once it has been dismissed. */
  moneyIsSafe(info) {
    const sats = Math.round(Number(info && info.sats) || 0);
    if (!(sats > 0)) return;
    /* Only what was at risk. Change, and payments locked to this phone, were
     * never anybody else's to spend: saying they are safe now says they were
     * not before, about money the person was never told was in question. They are swapped in and nothing is said. */
    if (!(info && info.trusted)) {
      this.refreshBalance();
      this.loadHistory();
      return;
    }
    this._safeTotal = (this._safeTotal || 0) + sats;
    this._safeCount = (this._safeCount || 0) + 1;
    console.log('[foxy] money is safe: ' + this._safeTotal + ' sats that were at risk are claimed, in '
      + this._safeCount + ' payment(s)');
    this.refreshBalance();
    this.loadHistory();
    if (!this.stageScreen) return;
    this.moneyIsSafeShow();
  }

  moneyIsSafeShow() {
    if (!(this._safeTotal > 0)) return;
    /* Not over another of these screens: a code somebody is scanning, or a
     * wait with the four digits on it, is not this one's to replace. It
     * waits its turn. */
    const up = document.getElementById('foxy-stage');
    if (up && up.getAttribute('data-stage') !== 'moneySafe') {
      clearTimeout(this._safeT);
      this._safeT = setTimeout(() => this.moneyIsSafeShow(), 2000);
      return;
    }
    const money = this.stageMoney(this._safeTotal);
    this.stageScreen('moneySafe', {
      title: 'Your money<br>is safe', amount: money,
      body: (this._safeCount === 1 ? 'The payment you accepted at risk has'
        : 'The ' + this._safeCount + ' payments you accepted at risk have')
        + ' been claimed.<br><strong>\u20bf ' + this.group(this._safeTotal)
        + '</strong> is now yours and nobody else can spend it.',
      button: 'DONE',
      go: () => { this._safeTotal = 0; this._safeCount = 0; },
    });
  }

  /* CLAIM NOW, on an at-risk payment's own screen: the same claim a connect
   * runs, asked for by hand, for the time it has not happened by itself. */
  claimAtRiskNow() {
    const W = window.FoxyWallet;
    if (!W || !W.claimUnclaimed || this.state.txClaiming) return;
    if (this.offlineNow()) {
      this.toast('This phone is offline. Connect first, then claim.', true);
      return;
    }
    console.log('[foxy] history: CLAIM NOW pressed on an at-risk payment');
    this.setState({ txClaiming: true });
    this.showMelt('Claiming\u2026');
    W.claimUnclaimed().then((took) => {
      this.hideMelt();
      this.setState({ txClaiming: false });
      this.refreshBalance();
      this.loadHistory();
      if (!(took > 0)) this.toast('Nothing could be claimed yet. Try again in a moment.', true);
      else if (this.state.screen === 'txDetail') this.back();
    }, (e) => {
      this.hideMelt();
      this.setState({ txClaiming: false });
      this.toast(W.reason ? W.reason(e) : 'That could not be claimed.', true);
    });
  }

  /* MAKE IT SAFE NOW, on a HIGH RISK payment's own screen: the swap a
   * connection runs by itself, asked for by hand. What became of it is said
   * by the wallet's own watcher (`W.onAtRisk`). */
  settleAtRiskNow() {
    const W = window.FoxyWallet;
    if (!W || !W.settleAtRisk || this.state.txClaiming) return;
    if (this.offlineNow()) {
      this.toast('This phone is offline. Connect first; it is made safe as soon as there is a connection.', true);
      return;
    }
    console.log('[foxy] history: MAKE IT SAFE NOW pressed on a high-risk payment');
    this.setState({ txClaiming: true });
    this.showMelt('Making it safe\u2026');
    const before = (W.atRisk ? W.atRisk() : []).length;
    Promise.resolve(W.takeBackRefused ? W.takeBackRefused() : 0).then(() => W.settleAtRisk()).then((out) => {
      this.hideMelt();
      this.setState({ txClaiming: false });
      this.refreshBalance();
      this.loadHistory();
      const left = (W.atRisk ? W.atRisk() : []).length;
      if (!(out && out.length) && left >= before) {
        this.toast(before ? 'It could not be checked yet. Try again in a moment.'
          : 'Nothing here can change that one: only the phone it was locked to can take it.', true);
      } else if (this.state.screen === 'txDetail') this.back();
    }, (e) => {
      this.hideMelt();
      this.setState({ txClaiming: false });
      this.toast(W.reason ? W.reason(e) : 'That could not be checked.', true);
    });
  }

  trustLostCard(info) {
    const sats = Number(info && info.sats) || 0;
    this.blockedCard('trustLost', {
      tone: 'bad',
      title: 'THEY TOOK THAT PAYMENT BACK',
      reason: 'The ' + this.group(sats) + ' sats you accepted while you were both offline had '
        + 'already been spent by the time this phone could check. The mint would not honour them, '
        + 'so they have come off your balance and the payment is marked failed in your history. '
        + 'Nothing else of yours is affected.',
    });
  }

  BLOCKED_INFO(kind) { return BLOCKED[kind]; }

  /* Shaped like BACK UP YOUR BITCOIN, because it is the same kind of thing:
   * something the app wants to tell you, not a system warning bolted to the
   * top of the screen.
   *
   * Plain DOM on document.body, so it does not depend on the design runtime
   * re-rendering — and therefore outside the theme scope, so every colour here
   * is literal rather than a var().
   */
  showPriceError() {
    // dismissed stays dismissed until a price loads and fails again, or this
    // would reappear on every refresh cycle and there would be no using the app
    if (this._priceOff) return;
    /* Not while working offline. Its TRY AGAIN calls `refreshBalance`, which
     * cannot succeed until there is a route, so offline the card is a loop with
     * no way out but NOT NOW — and it would sit over a person who already knows,
     * because they chose it and the banner says OFFLINE. Dollar amounts go blank
     * on their own; that is the honest part, and it needs no card. */
    if (this.offlineNow()) return;
    if (this._priceBar) { this._priceBar.style.display = 'flex'; return; }

    const el = (style, html) => {
      const d = document.createElement('div');
      d.style.cssText = style;
      if (html) d.innerHTML = html;
      return d;
    };

    const root = el('position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.7);' +
      'display:flex;flex-direction:column;justify-content:flex-end;' +
      'font-family:SatSymbol,Sora,system-ui,sans-serif;animation:foxyIn .16s ease');

    const stage = el('position:relative;isolation:isolate');
    stage.appendChild(el('position:absolute;left:0;right:0;top:-290px;height:330px;' +
      'pointer-events:none;z-index:0;background:radial-gradient(ellipse 128% 100% at 50% 100%,' +
      'rgba(242,128,46,.55) 0%,rgba(242,128,46,.26) 42%,rgba(242,128,46,0) 78%)'));

    const card = el('position:relative;z-index:1;background:#141518;' +
      'border-radius:28px 28px 0 0;padding:28px 26px calc(31px + env(safe-area-inset-bottom));' +
      'display:flex;flex-direction:column;align-items:center;' +
      'border-top:1px solid rgba(242,128,46,.5);box-shadow:inset 0 2px 0 rgba(242,128,46,.9)');

    card.appendChild(el('width:72px;height:72px;border-radius:50%;' +
      'background:linear-gradient(160deg,#fff,#F2EFE8);' +
      'box-shadow:0 9px 20px rgba(0,0,0,.24),inset 0 -3px 0 rgba(0,0,0,.1);' +
      'display:flex;align-items:center;justify-content:center;font-size:40px;' +
      'font-weight:400;line-height:1;color:#DC7F1C', '\u20BF'));

    const title = el('font-size:22px;font-weight:700;letter-spacing:-0.022em;' +
      'color:#F5F1EC;text-align:center;margin-top:16px');
    title.textContent = 'NO BITCOIN PRICE';
    card.appendChild(title);

    const body = el('font-size:18px;font-weight:500;line-height:1.4;' +
      'color:rgba(245,241,236,.62);text-align:center;margin-top:7px;max-width:300px');
    body.textContent = 'Your balance is safe. Dollar amounts stay hidden until a price loads.';
    card.appendChild(body);

    const stack = el('align-self:stretch;display:flex;flex-direction:column;gap:12px;margin-top:24px');

    const retry = el('height:60px;border-radius:30px;background:#F2802E;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;font-size:20px;' +
      'font-weight:800;letter-spacing:0.02em;cursor:pointer');
    retry.textContent = 'TRY AGAIN';
    retry.addEventListener('click', () => {
      if (retry.dataset.busy) return;
      retry.dataset.busy = '1';
      retry.textContent = 'TRYING\u2026';
      this.refreshBalance();
      setTimeout(() => { retry.dataset.busy = ''; retry.textContent = 'TRY AGAIN'; }, 2500);
    });
    stack.appendChild(retry);

    const later = el('height:52px;display:flex;align-items:center;justify-content:center;' +
      'font-size:18px;font-weight:800;color:rgba(245,241,236,.55);cursor:pointer');
    later.textContent = 'NOT NOW';
    later.addEventListener('click', () => {
      this._priceOff = true;
      this.hidePriceError();
    });
    stack.appendChild(later);

    card.appendChild(stack);
    stage.appendChild(card);
    root.appendChild(stage);
    // the backdrop dismisses too, same as the back-up card
    root.addEventListener('click', (e) => { if (e.target === root) later.click(); });
    document.body.appendChild(root);
    this._priceBar = root;
  }

  hidePriceError() {
    if (this._priceBar) this._priceBar.style.display = 'none';
  }
