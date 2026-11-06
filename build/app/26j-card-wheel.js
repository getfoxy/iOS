  /* ---- a card's set-up: its questions, in order, and their amounts ----------------------------------------------------
   *
   * The owner's set-up of a card (software 1.21 and on, which holds no money without a PIN), in his own order:
   *
   *   CREATE A PIN       the PIN pad every card PIN is typed on (`fcAskPin`), four to eight digits
   *   RE-ENTER PIN       the same again; two that differ start it again
   *   CURRENCY           what the card holds, on the CURRENCY screen (`fcUnitAsk`), at a mint with two balances; at a mint
   *                      with one, nothing is asked and the card holds bitcoin. Its rows are FC_SETUP_UNITS, and on a card of
   *                      software 1.23 a third, BOTH. DOLLARS or BITCOIN there is this phone's promise to offer only that one
   *                      when it adds to the card (kept beside the card's row, 08a-flashcard.js `cardHoldNote`); BOTH sets the
   *                      card up in dollars, the owner's dollars first, and ADD FUNDS asks which every time. The card itself is
   *                      told nothing of it: it takes either currency whatever was chosen
   *   NO PIN AMOUNT      SET AMOUNT for the most one payment may be without the PIN: this phone's own rule, kept on this phone
   *                      (the wallet's `cardSetNoPinTx`); the card has no such figure, and the phone asks for the PIN above it at
   *                      a tap it reads (`cardNeedsPin`)
   *   24HR LIMIT         SET AMOUNT for the most the card pays in 24 hours without the PIN: the card's own allowance
   *   SPEND PER SECOND   "Do you want to limit how much the card pays each second?" YES or NO; YES opens MAX PER SECOND
   *                      (`fcSpeedOpen`): six figures a second to choose from, and the figure itself to type another on SET AMOUNT
   *
   * The card holds one limit on a payment, L, which it pays at once, and waits about a second for each further L (software 1.25:
   * every payment waits a floor of three askings, about 2.4 s into the tap, then two more, about 1.2 s, for each limit's worth after
   * the first; it has no clock, it counts the phone's askings). So a rate of R a second is L = R (FC_SPEED_SECS, one), and a card's limit is said as L a
   * second wherever it is shown (`fcSpeedText`): $5 a second is a limit of $5. A card before 1.25 waits about three seconds a limit,
   * and what the screens say a payment takes on one is worked out by its software (`fcHoldSecs`).
   *
   * The amounts are typed on the SET AMOUNT screen every amount is typed on (`fcAmount`, flows 'cardSuNoPinTx', 'cardSuNoPin' and 'cardSuTap'),
   * in the card's own money: a dollar card's in dollars and nothing else; a bitcoin card's in dollars first, with the screen's
   * own swap to sats (sats alone where this phone has no price, which is also where the rate is typed rather than chosen). What
   * the card is sent is what it takes, whichever is typed: cents for a dollar card, sats for a bitcoin card.
   *   the tap            one tap writes all of it (`fcSetUpStepsRun`), with Keep holding on the sheet while the card holds
   *
   * The same steps set a card up for somebody else, from SEND > FLASHCARD on a new card (`fcSendSetUp`): the holder types the
   * PIN on this phone, and the words say it is theirs; what the card holds is what is being sent, so CURRENCY is not asked; and
   * the tap writes no owner and no key of this phone's, then the money under the holder's PIN.
   *
   * The way back is the round back button of the pad and of SET AMOUNT: one step back (from SET AMOUNT, to its question; from
   * NO PIN AMOUNT, to CURRENCY where it was asked; from 24HR LIMIT, to NO PIN AMOUNT), and from the first, to where the set-up began. A question's card goes when
   * it is tapped beside, and the set-up with it.
   *
   * A card set up for its holder (`other`) is not asked NO PIN AMOUNT: the rule would be kept on this phone, which is not the one the
   * holder's card pays at, so it would hold nowhere; its first amount is 24HR LIMIT, whose back button leaves the set-up.
   *
   * NO PIN AMOUNT comes up filled in at $5.00 and 24HR LIMIT at $20.00 (FC_SU_NOPIN_DEFAULT_CENTS) where it is typed in dollars,
   * or the figure chosen before where the step is come back to; the first key typed replaces it (`amountDefault`). */

  /* What a card can hold, as the set-up's CURRENCY step offers it, in order. */
  FC_SETUP_UNITS = ['usd', 'sat'];

  /* The set-up's steps from the first. `o`: { other, unit, run, keepPin } — `other` for a card set up for somebody else (`fcSendSetUp`), `keepPin` for one of those taken up again on a card that keeps its PIN (asked once),
   * `unit` the card's where it is not asked, `run(choice)` what the tap does with { pin, unit, noPin, tapLimit, noPinUsd, tapUsd,
   * noPinTx, noPinTxUsd, noPinTxUnit } (this phone's own set-up when none is given). */
  fcSetUpSteps(o) {
    this._fcSu = Object.assign({ pin: '', unit: '', noPin: 0, tapLimit: 0, noPinUsd: 0, tapUsd: 0, noPinTx: 0, noPinTxUsd: 0 }, o || {});
    this.fcSuPin('');
  }

  fcSuPin(warn) {
    const su = this._fcSu;
    if (!su) return;
    /* A set-up for the holder taken up again on a card that has its record (`keepPin`): the card keeps the PIN it was given, so the
     * holder types it once, as on every card PIN pad. */
    if (su.keepPin) {
      this.fcAskPin({
        title: 'CARD PIN',
        subtitle: 'This card’s set-up was cut short. The person who holds it types their PIN to finish it.',
        warn: warn || '',
        onBack: () => { this._fcSu = null; this.fcNameAgain(); },
      }, (a) => { su.pin = a; this.fcSuUnit(); });
      return;
    }
    this.fcAskPin({
      title: 'CREATE A PIN',
      subtitle: '4 to 8 digits',
      warn: warn || '',
      onBack: () => { this._fcSu = null; this.fcNameAgain(); },
    }, (a) => this.fcAskPin({
      title: 'RE-ENTER PIN',
      subtitle: 'Type it again',
      onBack: () => this.fcSuPin(''),
    }, (b) => {
      if (a !== b) { this.fcSuPin('Those did not match. Start again.'); return; }
      su.pin = a;
      this.fcSuUnit();
    }));
  }

  // CURRENCY: asked only where this phone's mint has two balances, and never for a card set up for somebody else
  fcSuUnit() {
    const su = this._fcSu;
    if (!su) return;
    if (!su.other && !su.unit && this.twoUnitsOn && this.twoUnitsOn()) {
      const fc = this.state.fc;
      this.fcUnitAsk((unit) => { su.unit = unit; this.fcSuNoPin(); }, null, !!(fc && fc.v123));
      return;
    }
    this.fcSuNoPin();
  }

  /* The unit the card will hold, for its two amounts: what was chosen, or bitcoin. (BOTH is set up in dollars: dollars.) */
  fcSuUnitNow() {
    const su = this._fcSu;
    return (su && (su.unit === 'usd' || su.unit === 'both')) ? 'usd' : 'sat';
  }

  /* The amounts are asked straight away, with no question first (the design's rule): NO PIN AMOUNT on SET AMOUNT (one payment), then
   * 24HR LIMIT (the card's allowance), then the rate on MAX PER SECOND; SKIP under NEXT on each (`fcSuSkip`) sets none. */
  fcSuNoPin() {
    if (!this._fcSu) return;
    // (not for a card set up for its holder: see above)
    if (this._fcSu.other) { this.fcSuAmount('noPin'); return; }
    this.fcSuAmount('noPinTx');
  }

  fcSuNoPinDay() {
    if (!this._fcSu) return;
    this.fcSuAmount('noPin');
  }

  fcSuTap() {
    if (!this._fcSu) return;
    this.fcSuAmount('tap');
  }

  /* SET AMOUNT for one of the three (`which`: 'noPinTx', 'noPin' or 'tap'), in the card's unit, as LIMITS opens it (`fcAmount`): empty, dollars
   * first, NEXT to go on (`fcSuAmountNext`), SKIP for none (`fcSuSkip`), the round back button a step back (`fcSuAmountBack`).
   * Whatever screen the set-up was asked over (the card's own, or SEND's keypad for a card set up for somebody else) is put back as
   * it was when the amount is left either way. */
  FC_SU_FLOWS = { noPinTx: 'cardSuNoPinTx', noPin: 'cardSuNoPin', tap: 'cardSuTap' };
  /* (the limit on a payment is asked as a rate on MAX PER SECOND, `fcSpeedOpen`, where the card's figures can be said in dollars; on
   * SET AMOUNT in sats otherwise, a bitcoin card with no price, and from that screen when its figure is tapped, `other`) */
  fcSuAmount(which, other) {
    const su = this._fcSu;
    if (!su) return;
    const s = this.state;
    if (!su.was) su.was = { screen: s.screen, stack: s.stack, flow: s.flow, amount: s.amount, unit: s.unit };
    su.ask = which;
    // (the rate typed: whether it was reached from MAX PER SECOND, which its back button returns to)
    su.fromSpeed = which === 'tap' && !!other;
    if (which === 'tap' && !other && this.fcSpeedChoosable(this.fcSuUnitNow())) { this.fcSpeedOpen('su', this.fcSuUnitNow(), this.FC_SPEED_FIRST); return; }
    this.fcAmount(this.FC_SU_FLOWS[which]);
    if (which !== 'tap') this.fcSuPrefill(su, which);
  }

  /* What NO PIN AMOUNT and 24HR LIMIT show before anything is typed: the figure chosen before, where the step is come back to (from
   * the next step's back button), in the unit it was typed in; else $20.00 where dollars are typed. A bitcoin card with no price types
   * sats, and is given no figure (there are no dollars to say it in). Marked the default: the first key typed starts from nothing
   * (19-update-keypad-balance.js, `press`), so $20.00 is not what a 5 is typed after. */
  FC_SU_NOPIN_DEFAULT_CENTS = { noPinTx: 500, noPin: 2000 };
  fcSuPrefill(su, which) {
    const s = this.state;
    const tx = which === 'noPinTx';
    const n = tx ? su.noPinTx : su.noPin;
    const nUsd = tx ? su.noPinTxUsd : su.noPinUsd;
    let amount = '';
    let unit = s.unit;
    if (n > 0) {
      if (this.fcSuUnitNow() === 'usd') amount = (n / 100).toFixed(2);
      else if (s.unit === 'USD' && nUsd > 0) amount = Number(nUsd).toFixed(2);
      else { amount = String(Math.round(n)); unit = 'SATS'; }
    } else if (s.unit === 'USD') {
      amount = (this.FC_SU_NOPIN_DEFAULT_CENTS[tx ? 'noPinTx' : 'noPin'] / 100).toFixed(2);
    }
    if (amount) this.setState({ amount, unit, amountDefault: true });
  }

  // which of the three SET AMOUNT is asking for, while it is up: 'noPinTx', 'noPin', 'tap', or ''
  fcSuAsking() {
    const s = this.state;
    if (!this._fcSu || s.screen !== 'amount') return '';
    return s.flow === 'cardSuNoPinTx' ? 'noPinTx' : s.flow === 'cardSuNoPin' ? 'noPin' : s.flow === 'cardSuTap' ? 'tap' : '';
  }

  // off SET AMOUNT, to the screen the set-up was asked over
  fcSuLeave() {
    const su = this._fcSu;
    const was = su && su.was;
    if (su) su.was = null;
    if (was) this.setState({ screen: was.screen, stack: was.stack, flow: was.flow, amount: was.amount, unit: was.unit, amountDefault: false });
  }

  /* NEXT: the figure in the card's unit (`fcTyped`: cents for a dollar card, sats for a bitcoin card) and, for a bitcoin card typed in
   * dollars, those dollars (as LIMITS keeps them, `fcAmountNext`); then the next step. Nothing typed is refused, as LIMITS refuses it. */
  /* (the limit on a payment is typed as a rate, so what the card is sent is one second of it: FC_SPEED_SECS) */
  fcSuAmountNext() {
    const su = this._fcSu;
    const which = this.fcSuAsking();
    if (!su || !which) return;
    const amount = this.fcTyped();
    if (!(amount > 0)) { this.toast('Type an amount first.', true); return; }
    const usd = this.fcSuUnitNow() === 'usd' ? 0 : this.state.unit === 'USD' ? Number(this.state.amount) || 0 : 0;
    const k = this.FC_SPEED_SECS;
    if (which === 'tap') { su.tapLimit = amount * k; su.tapUsd = usd * k; } else if (which === 'noPinTx') { su.noPinTx = amount; su.noPinTxUsd = usd; } else { su.noPin = amount; su.noPinUsd = usd; }
    this.fcSuLeave();
    if (which === 'tap') this.fcSuGo(); else if (which === 'noPinTx') this.fcSuNoPinDay(); else this.fcSuTap();
  }

  /* SKIP under NEXT: none of it. No rule on one payment, and on to 24HR LIMIT; no allowance without the PIN, and on to the rate; no
   * limit on a payment, and on to the tap. */
  fcSuSkip(which) {
    const su = this._fcSu;
    const w = which || this.fcSuAsking();
    if (!su || !w) return;
    this.fcSuLeave();
    if (w === 'tap') { su.tapLimit = 0; su.tapUsd = 0; this.fcSuGo(); } else if (w === 'noPinTx') { su.noPinTx = 0; su.noPinTxUsd = 0; this.fcSuNoPinDay(); } else { su.noPin = 0; su.noPinUsd = 0; this.fcSuTap(); }
  }

  /* The round back button on SET AMOUNT (01-ui-basics.js, `back`), a step back: off NO PIN AMOUNT, CURRENCY again where it was asked
   * (the choice open once more), and otherwise out of the set-up to the screen it was asked over, with nothing written; off 24HR LIMIT,
   * NO PIN AMOUNT; off the rate typed, MAX PER SECOND where it came from there, 24HR LIMIT otherwise. True where it was the set-up's. */
  /* (and on MAX PER SECOND, while the set-up asks it: 24HR LIMIT, `fcSpeedBack`) */
  fcSuAmountBack() {
    if (this._fcSu && this.state.screen === 'fcSpeed' && this.state.fcSpeed && this.state.fcSpeed.mode === 'su') { this.fcSpeedBack(); return true; }
    const which = this.fcSuAsking();
    if (!which) return false;
    const su = this._fcSu;
    if (which === 'noPin' && !su.other) {
      this.fcSuLeave();
      this.fcSuNoPin();
      return true;
    }
    // (the first amount asked: NO PIN AMOUNT, or 24HR LIMIT for a card set up for its holder)
    if (which === 'noPinTx' || which === 'noPin') {
      this.fcSuLeave();
      // the step before was CURRENCY (asked only of the owner's own card, at a mint with two balances): that question again, not the start
      if (su.unit && !su.other && this.twoUnitsOn && this.twoUnitsOn()) { su.unit = ''; this.fcSuUnit(); return true; }
      this._fcSu = null;
      return true;
    }
    if (su.fromSpeed && this.state.fcSpeed && this.state.fcSpeed.mode === 'su') {
      // (SET AMOUNT was opened over MAX PER SECOND, `fcAmount`: off it, back to that screen, at the rate it showed)
      su.fromSpeed = false;
      this.setState(p => ({ screen: 'fcSpeed', stack: p.stack.slice(0, -1),
                            flow: su.was ? su.was.flow : p.flow, amount: su.was ? su.was.amount : p.amount, unit: su.was ? su.was.unit : p.unit }));
      return true;
    }
    this.fcSuLeave();
    this.fcSuNoPinDay();
    return true;
  }

  /* The second amount's words, by the card's software as CARD LIMITS says them (26f-flashcard.js, `fcLimitQuestion`): 24HR LIMIT and its
   * 24 hours on a card of 1.25, whose allowance is a 24-hour total; NO PIN LIMIT and "before it asks for its PIN" on 1.21 to 1.24, whose
   * allowance the PIN fills again. A card not read yet (SEND's set-up for a holder has none on show) is taken as the newest. */
  fcSuDayWords() {
    const fc = this.state.fc;
    const refill = !!(fc && fc.pinFirst && !fc.noPinDay && fc.noPinKnown);
    return refill ? { title: 'NO PIN LIMIT', question: 'What is the most this card should pay by tap alone before it asks for its PIN?' }
      : { title: '24HR LIMIT', question: 'What is the most this card should pay in 24 hours without asking for your PIN?' };
  }

  /* The line under the amount on SET AMOUNT for the rate: "It will take N seconds to pay $X." for the limit it makes (one second of
   * what is typed), in the unit it is typed in; '' for the other, and before anything is typed. */
  fcSuAmountLine() {
    if (this.fcSuAsking() !== 'tap') return '';
    return this.fcWaitLine(this.fcTyped() * this.FC_SPEED_SECS, this.fcSuUnitNow(), this.state.unit === 'SATS' ? 'sat' : 'usd');
  }

  /* "It will take 6 seconds to pay $40.00.": what a payment of four limits' worth waits on the card's software (`fcHoldSecs`). A
   * round figure above the limit, so that the line says something. In the unit the figure was chosen in (`as`): "₿ 40,000" for a
   * bitcoin card's limit chosen in sats. */
  FC_WAIT_EXAMPLE = 4;
  fcWaitLine(limit, unit, as) {
    if (!(limit > 0)) return '';
    const units = this.FC_WAIT_EXAMPLE;
    const pay = (unit !== 'usd' && as === 'sat') ? '₿ ' + this.group(Math.round(limit * units)) : this.fcPrice(limit * units, unit);
    return 'It will take ' + this.fcHoldSecs(units) + ' seconds to pay ' + pay + '.';
  }

  /* Whether the card on show is of software 1.25 or later, whose wait is a second a limit (a card not read yet is taken as the
   * newest, as `fcShaped` takes it). */
  fcCard125() {
    const c = this._fcCard;
    const v = String((c && c.info && c.info.version) || '').split('.');
    if (!v[0]) return true;
    return Number(v[0]) > 1 || (Number(v[0]) === 1 && Number(v[1]) >= 25);
  }

  /* How long a payment of `n` limits' worth holds the card, in whole seconds, by the card's software. 1.25 waits by a floor:
   * every payment answers "not yet" three times before it signs, about 2.4 s from the card being found on a J3R180 (a wait is
   * 579 ms), and each limit's worth past the first adds two more waits, about 1.2 s: 2.4 + 1.2 × (n − 1), the floor said even
   * within the limit. A card before it signs a payment within its limit at once and waits about three seconds for each limit's
   * worth after: 3 × (n − 1). */
  FC_HOLD = { floor: 2.4, each: 1.2, eachBefore: 3 };
  fcHoldSecs(n) {
    const k = Math.max(1, Math.round(Number(n) || 0));
    const H = this.FC_HOLD;
    if (this.fcCard125()) return Math.round(H.floor + H.each * (k - 1));
    return H.eachBefore * (k - 1);
  }

  // the end of the questions: the tap
  fcSuGo() {
    const su = this._fcSu;
    if (!su) return;
    const noPinTxUnit = this.fcSuUnitNow();
    this._fcSu = null;
    const choice = { pin: su.pin, unit: su.unit, noPin: su.noPin, tapLimit: su.tapLimit, noPinUsd: su.noPinUsd, tapUsd: su.tapUsd,
                     noPinTx: su.noPinTx || 0, noPinTxUsd: su.noPinTxUsd || 0, noPinTxUnit };
    if (typeof su.run === 'function') { su.run(choice); return; }
    this.fcSetUpStepsRun(choice);
  }

  /* The owner's set-up, in one tap: the PIN, the record, the holder's numbers, and this phone as the owner, the card holding while
   * it is claimed (08a-flashcard.js, `cardHoldOn`). */
  fcSetUpStepsRun(c) {
    const W = this.fcW();
    if (!W) return;
    // (and the price: a card of software 1.23 keeps its numbers in cents and is given its rate at it, 08a-flashcard.js `cardSetUpCents`)
    const how = /** @type {any} */ ({ pin: c.pin, recoverable: true, design: this.FC_SETUP_DESIGN, tapLimit: c.tapLimit, noPin: c.noPin,
                                      tapUsd: c.tapUsd, noPinUsd: c.noPinUsd, price: (this.fcRatePrice ? this.fcRatePrice() : (this.px && this.px()) || 0) });
    /* (a card of 1.23: BOTH is a dollar record, and what was chosen is kept on this phone as `hold`, which the card is never told) */
    if (c.unit) how.unit = c.unit === 'both' ? 'usd' : c.unit;
    const fc = this.state.fc;
    if (fc && fc.v123 && c.unit) how.hold = c.unit;
    this.fcTap({ flow: 'setup' }, (link, on) => { on('writing'); how.onHold = () => on('writing'); return W.cardSetUp(link, how); })
      .then((card) => {
        this.fcNameSettle(card && card.key);
        this.fcNoPinTxKeep(card && card.key, c);
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.toast(c.unit === 'both' ? 'The card is set up. It holds dollars and bitcoin.' : c.unit === 'usd' ? 'The card is set up. It holds dollars.' : 'The card is set up.');
      }, (e) => this.fcFailed(e, { again: () => this.fcSetUpStepsRun(c), pinAgain: () => this.fcSuPinAgain(c, (c2) => this.fcSetUpStepsRun(c2)) }));
  }

  /* NO PIN AMOUNT, once the card is set up: this phone's own rule for it, kept on this phone (the wallet's `cardSetNoPinTx`), none where
   * it was skipped. The card is told nothing of it. */
  fcNoPinTxKeep(key, c) {
    const W = this.fcW ? this.fcW() : null;
    if (!key || !c || !W || !W.cardSetNoPinTx) return;
    try { W.cardSetNoPinTx(key, Number(c.noPinTx) || 0, c.noPinTxUnit === 'usd' ? 'usd' : 'sat', Number(c.noPinTxUsd) || 0); } catch (e) { console.warn('[foxy] card: its no PIN amount could not be kept on this phone'); }
  }

  /* TRY AGAIN after the card refused the PIN the set-up's tap was run with (a card that keeps one): the pad once more, and the tap
   * again with the new PIN and everything else as chosen (`c`, the choice `fcSuGo` made), never the same PIN at the card twice. */
  fcSuPinAgain(c, then) {
    this.fcAskPin({ title: 'CARD PIN', subtitle: 'The card refused that PIN. Type it again.' }, (a) => then(Object.assign({}, c, { pin: a })));
  }

  /* ---- MAX PER SECOND -------------------------------------------------------------------------------------------
   *
   * The limit on a payment, asked as how fast the card pays (the design): the figure a second, big, six of them to choose
   * from, and why a card has a limit. A rate R is the limit L = FC_SPEED_SECS × R, one second of it (the card pays L at once and,
   * from software 1.25, waits a second for each further L), sent to the card as every limit is: cents for a dollar card; sats for a bitcoin card, at this
   * phone's price, with the dollars kept so that this phone sets the card again when the price has moved. Asked by the set-up
   * (`mode` 'su', `fcSuAmount`) and by CARD LIMITS (`mode` 'limit', `fcLimitAmount`) for a card that waits for its limit (`paced`);
   * a figure that is none of the six is typed on SET AMOUNT, by tapping the figure (`fcSpeedOther`), where it is a figure a second
   * too. A bitcoin card with no price has nothing to say dollars at, and is asked on SET AMOUNT in sats straight away. */
  FC_SPEED_CHIPS = [1, 2, 5, 10, 25, 50];
  FC_SPEED_SECS = 1;
  FC_SPEED_FIRST = 5;

  // whether a rate in dollars can be turned into a card's limit in `unit`: a dollar card's always, a bitcoin card's where there is a price
  fcSpeedChoosable(unit) {
    return unit === 'usd' || ((this.px && this.px()) || 0) > 0;
  }

  // the limit a rate of `r` dollars a second makes, in `unit`: cents, or sats at this phone's price (0 with none)
  fcSpeedLimit(r, unit) {
    const k = this.FC_SPEED_SECS;
    if (unit === 'usd') return Math.round(r * k * 100);
    const px = (this.px && this.px()) || 0;
    return px > 0 ? Math.round(r * k / px * 1e8) : 0;
  }

  /* A limit `n` in `unit` as the dollars a second it makes: exact for cents, and for the dollars a bitcoin card's limit was set at
   * (`usd`); at this phone's price otherwise; 0 where there is none. */
  fcSpeedDollars(n, unit, usd) {
    const k = this.FC_SPEED_SECS;
    if (!(n > 0)) return 0;
    if (unit === 'usd') return n / 100 / k;
    if (usd > 0) return usd / k;
    const px = (this.px && this.px()) || 0;
    return px > 0 ? (n / 1e8) * px / k : 0;
  }

  // the chip a rate is, within a hundredth of it (a bitcoin card's limit is whole sats, and follows the price), or 0
  fcSpeedChip(r) {
    return this.FC_SPEED_CHIPS.filter((x) => Math.abs(r - x) <= x / 100)[0] || 0;
  }

  /* A limit said as its rate: "$5" where it is a chip, "$1.67" where it is not, "₿100" for a bitcoin card with no dollars to say it in. */
  fcSpeedText(n, unit, usd) {
    const r = this.fcSpeedDollars(n, unit, usd);
    if (r >= 0.005) { const c = this.fcSpeedChip(r); return '$' + (c ? String(c) : this.usd(r)); }
    return '₿' + this.group(Math.round((Number(n) || 0) / this.FC_SPEED_SECS));
  }

  // the dollars this phone set a bitcoin card's limit on a payment at (the wallet's `cardPaceUsd`), or 0
  fcKeptUsd(fc) {
    const W = this.fcW ? this.fcW() : null;
    if (!fc || !fc.key || fc.unit === 'usd' || fc.cents || !W || !W.cardPaceUsd) return 0;
    return Number(W.cardPaceUsd(fc.key)) || 0;
  }

  // whether the card on show waits for its limit on a payment, rather than refusing past it: its limit is a rate
  fcPacedNow() {
    const fc = this.state.fc;
    return !!(fc && fc.tap && fc.tap.paced);
  }

  // the unit a card's limits are kept in: cents for a dollar card and for a card of 1.23 (both its currencies), sats otherwise
  fcLimitKeptUnit(fc) {
    return (fc && (fc.cents || fc.unit === 'usd')) ? 'usd' : 'sat';
  }

  fcSpeedOpen(mode, unit, r) {
    this.setState(p => ({ screen: 'fcSpeed', stack: p.screen === 'fcSpeed' ? p.stack : p.stack.concat([p.screen]),
                          fcSpeed: { mode: mode === 'su' ? 'su' : 'limit', unit: unit === 'usd' ? 'usd' : 'sat', r: Number(r) || this.FC_SPEED_FIRST } }));
  }

  fcSpeedPick(r) {
    this.setState(p => ({ fcSpeed: Object.assign({}, p.fcSpeed, { r }) }));
  }

  // NEXT: the limit the rate makes, to the set-up's tap or to the limit's confirmation
  fcSpeedNext() {
    const fs = this.state.fcSpeed;
    if (!fs) return;
    const limit = this.fcSpeedLimit(fs.r, fs.unit);
    if (!(limit > 0)) { this.toast('Choose an amount first.', true); return; }
    const usd = fs.unit === 'usd' ? 0 : fs.r * this.FC_SPEED_SECS;
    if (fs.mode === 'su') {
      const su = this._fcSu;
      if (!su) return;
      su.tapLimit = limit;
      su.tapUsd = usd;
      this.fcSuLeave();
      this.fcSuGo();
      return;
    }
    this.fcLimitConfirm(limit, usd);
  }

  // the figure tapped: another rate, typed on SET AMOUNT (with NO LIMIT under it on LIMITS)
  fcSpeedOther() {
    const fs = this.state.fcSpeed;
    if (!fs) return;
    if (fs.mode === 'su') { this.fcSuAmount('tap', true); return; }
    this.fcAmount('cardLimit');
  }

  // its round back button: the set-up's 24HR LIMIT again, or the card's screen
  fcSpeedBack() {
    const fs = this.state.fcSpeed;
    if (fs && fs.mode === 'su' && this._fcSu) { this.fcSuLeave(); this.fcSuNoPinDay(); return; }
    this.fcLimitCancel();
  }

  // the plain button under NEXT: SKIP in the set-up (no limit, on to the tap), NO LIMIT on LIMITS (the limit removed, its confirmation)
  fcSpeedAlt() {
    const fs = this.state.fcSpeed;
    if (!fs) return;
    if (fs.mode === 'su') { this.fcSuSkip('tap'); return; }
    this.fcLimitConfirm(0);
  }

  /* CONTINUE on a limit's first step (`fcLimitAsk`): the rate, for the limit on a payment of a card that waits for it; SET AMOUNT for
   * any other limit, and for that one where it cannot be said in dollars. */
  fcLimitAmount() {
    // (the no PIN limit: NO PIN AMOUNT first, this phone's rule on one payment, then the card's 24HR LIMIT, `fcLimitTxNext`)
    if (this._fcLimitNoPin) { this.fcLimitTxOpen(); return; }
    if (this._fcLimitTap && this.fcPacedNow() && this.fcSpeedChoosable(this.fcLimitUnit())) {
      const fc = this.state.fc;
      const now = (fc.tap && fc.tap.limited) ? this.fcSpeedChip(this.fcSpeedDollars(fc.tap.limit, this.fcLimitKeptUnit(fc), this.fcKeptUsd(fc))) : 0;
      this.fcSpeedOpen('limit', this.fcLimitUnit(), now || this.FC_SPEED_FIRST);
      return;
    }
    this.fcAmount('cardLimit');
  }

  /* NO PIN AMOUNT from CARD LIMITS' NO PIN LIMIT: SET AMOUNT (flow 'cardLimitTx'), with the figure chosen a moment ago (come back to
   * from 24HR LIMIT), else the rule this phone keeps for the card, filled in, NO LIMIT under NEXT for none; NEXT or NO LIMIT goes on to 24HR LIMIT (the allowance, flow 'cardLimit'), whose back button
   * comes back here. The figure is held (`_fcLimitTxPick`) until the card has taken its allowance, and kept on this phone then
   * (`fcLimitRun`). */
  fcLimitTxOpen() {
    const pick = this._fcLimitTxPick;
    this._fcLimitTxPick = null;
    this.fcAmount('cardLimitTx');
    const fc = this.state.fc;
    const W = this.fcW ? this.fcW() : null;
    const kept = (pick && pick.n > 0) ? pick : (fc && fc.key && W && W.cardNoPinTx) ? W.cardNoPinTx(fc.key) : null;
    if (!kept || kept.unit !== this.fcLimitUnit()) return;
    if (kept.unit === 'usd') this.setState({ amount: (kept.n / 100).toFixed(2), unit: 'USD' });
    else if (this.state.unit === 'USD' && kept.usd > 0) this.setState({ amount: Number(kept.usd).toFixed(2), unit: 'USD' });
    else this.setState({ amount: String(kept.n), unit: 'SATS' });
  }

  // NEXT on NO PIN AMOUNT (`n` in the limit's unit, 0 for NO LIMIT): held, and 24HR LIMIT
  fcLimitTxNext(n, usd) {
    this._fcLimitTxPick = { n: Math.max(0, Math.round(Number(n) || 0)), unit: this.fcLimitUnit(), usd: Math.max(0, Number(usd) || 0) };
    this.fcAmount('cardLimit');
  }

  // the round back button on 24HR LIMIT, from CARD LIMITS: NO PIN AMOUNT again (true where it was that)
  fcLimitTxBack() {
    const s = this.state;
    if (s.screen !== 'amount' || s.flow !== 'cardLimit' || !this._fcLimitNoPin || !this._fcLimitTxPick) return false;
    this.fcLimitTxOpen();
    return true;
  }

  /* ---- CARD LIMITS ------------------------------------------------------------------------------------------------------
   *
   * LIMITS in the card's menu (`fcSetLimit`): the card's picture and a row for each limit its owner can change, with what it is now.
   * PER SECOND LIMIT (PER TAP LIMIT on a card that refuses past its limit rather than waiting) and, on a card with a PIN whose
   * software has it, NO PIN LIMIT. A row opens that limit's own steps (`fcLimitAsk`) from the card's screen; CLOSE and the round
   * back button go back to it. */
  fcLimitsOpen() {
    this.setState(p => ({ screen: 'fcLimits', stack: p.screen === 'fcLimits' ? p.stack : p.stack.concat([p.screen]), open0: false }));
  }

  fcLimitsLeave() {
    if (this.state.screen !== 'fcLimits') return;
    this.setState(p => ({ screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1) }));
  }

  // the rows: { key, label, sub, value, unit, tap }
  fcLimitRows() {
    const fc = this.state.fc;
    if (!fc) return [];
    const LU = this.fcLimitKeptUnit(fc);
    const whole = (t) => String(t).replace(/\.00$/, '');
    const tap = fc.tap || {};
    const rows = [tap.paced ? {
      key: 'tap', label: 'PER SECOND LIMIT', sub: 'How fast the card can pay',
      value: tap.limited ? this.fcSpeedText(tap.limit, LU, this.fcKeptUsd(fc)) : 'NO LIMIT', unit: tap.limited ? 'per sec' : '',
    } : {
      key: 'tap', label: 'PER TAP LIMIT', sub: 'Most it pays in one tap',
      value: tap.limited ? whole(this.fcPrice(tap.limit, LU)) : 'NO LIMIT', unit: tap.limited ? 'per tap' : '',
    }];
    if (fc.pinSet && fc.noPinKnown && fc.pin !== 'blocked') {
      const n = (fc.noPin && fc.noPin.known && fc.noPin.set) ? Number(fc.noPin.limit) || 0 : 0;
      // (before 1.21 the allowance is a day's; from 1.21 the PIN fills it again)
      rows.push({ key: 'nopin', label: 'NO PIN LIMIT', sub: 'Most it pays without a PIN',
        value: n > 0 ? whole(this.fcPrice(n, LU)) : 'NONE', unit: n > 0 ? (fc.pinFirst ? 'per tap' : 'a day') : '' });
    }
    return rows.map((r) => Object.assign(r, { unitShown: !!r.unit, tap: () => this.fcLimitsGo(r.key) }));
  }

  fcLimitsGo(which) {
    this.fcLimitsLeave();
    if (which === 'nopin') {
      this.fcLimitAsk((sats, usd) => {
        const tx = this._fcLimitTxPick;
        this._fcLimitTxPick = null;
        this.fcLimitRun(sats, 'nopin', usd, undefined, undefined, tx);
      }, 'nopin');
    }
    else this.fcLimitAsk((sats, usd, pin) => this.fcLimitRun(sats, true, usd, pin), true);
  }

  /* ---- NAME CARD ----------------------------------------------------------------------------------------------------------
   *
   * The card's name, on this phone only (the wallet's `cardName`, kept on the card's row; the card is told nothing): asked first in the
   * set-up, right after SET UP CARD on the welcome (`fcWelcomeSetUp`), for this phone's card and for one set up for its holder from SEND
   * > FLASHCARD alike; and again from RENAME CARD in the card's menu (`fcRename`), with the name it has filled in. The screen is SEND >
   * TYPE's: the one field, the keyboard up and the field focused on arrival, NEXT under it, grey until something is typed. In the set-up
   * SKIP under NEXT goes on with no name; NEXT goes on with the name, which is kept once the card is set up (`fcNameSettle`). The round
   * back button is the welcome again, or the card's screen from RENAME CARD. A name is cut at FC_NAME_MAX characters and trimmed;
   * a card with none is called what it always was (26f-flashcard.js `fcName`, and FLASHCARD over its screen). */
  FC_NAME_MAX = 24;

  // `mode` 'su' (the set-up's step, `then` its next) or 'rename'; `key` the card's, where it is known
  fcNameOpen(mode, key, then, draft) {
    this._fcNameThen = typeof then === 'function' ? then : null;
    if (mode === 'su') this._fcNameSu = null;
    this.setState(p => ({ screen: 'fcName', stack: p.screen === 'fcName' ? p.stack : p.stack.concat([p.screen]),
                          fcNaming: { mode: mode === 'rename' ? 'rename' : 'su', key: String(key || '') },
                          fcNameDraft: this.fcNameCut(draft || '') }));
  }

  // what may be typed: no more than FC_NAME_MAX characters (as they are seen, not as they are stored)
  fcNameCut(v) {
    return Array.from(String(v || '')).slice(0, this.FC_NAME_MAX).join('');
  }

  // the name as it is kept: trimmed, and cut
  fcNameClean(v) {
    return this.fcNameCut(String(v || '').trim()).trim();
  }

  // the name this phone keeps for a card, or ''
  fcNameKept(key) {
    const W = /** @type {any} */ (window).FoxyWallet;
    return (key && W && typeof W.cardName === 'function') ? String(W.cardName(key) || '') : '';
  }

  fcNameType(e) {
    this.setState({ fcNameDraft: this.fcNameCut(e && e.target ? e.target.value : '') });
  }

  // off NAME CARD, to the screen under it
  fcNameLeave() {
    this._fcNameThen = null;
    this.setState(p => ({ screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1), fcNaming: null }));
  }

  /* NEXT: with a name only. From RENAME CARD, kept at once and the card's screen again; in the set-up, held for the card being set up
   * and on to its next step. */
  fcNameNext() {
    const n = this.state.fcNaming;
    if (!n || this.state.screen !== 'fcName') return;
    const name = this.fcNameClean(this.state.fcNameDraft);
    if (!name) { this.toast('Type a name first.', true); return; }
    if (n.mode === 'rename') {
      const W = /** @type {any} */ (window).FoxyWallet;
      try { if (W && W.cardSetName) W.cardSetName(n.key, name); } catch (e) { this.toast('The name could not be saved on this phone.', true); return; }
      this.fcNameLeave();
      return;
    }
    this.fcNameGoOn(name);
  }

  // SKIP under NEXT, in the set-up: no name, and on
  fcNameSkip() {
    const n = this.state.fcNaming;
    if (!n || n.mode !== 'su' || this.state.screen !== 'fcName') return;
    this.fcNameGoOn('');
  }

  fcNameGoOn(name) {
    const n = this.state.fcNaming;
    const then = this._fcNameThen;
    this._fcNameSu = { name, key: (n && n.key) || '', then };
    this.fcNameLeave();
    if (then) then();
  }

  // the round back button on NAME CARD (01-ui-basics.js, `back`): the welcome, or the card's screen; true where it was this screen's
  fcNameBack() {
    if (this.state.screen !== 'fcName') return false;
    if (this.state.fcNaming && this.state.fcNaming.mode === 'su') this._fcNameSu = null;
    this.fcNameLeave();
    return true;
  }

  // back off the set-up's first PIN: NAME CARD again, with what was typed there, where the set-up began on it
  fcNameAgain() {
    const su = this._fcNameSu;
    if (!su || typeof su.then !== 'function') return;
    this._fcNameSu = null;
    this.fcNameOpen('su', su.key, su.then, su.name);
  }

  /* The set-up's tap has set the card up: the name typed for it is kept (nothing where SKIP was pressed, or where it was typed for
   * another card). */
  fcNameSettle(key) {
    const su = this._fcNameSu;
    this._fcNameSu = null;
    if (!su || !su.name || !key || (su.key && su.key !== key)) return;
    const W = /** @type {any} */ (window).FoxyWallet;
    try { if (W && W.cardSetName) W.cardSetName(key, su.name); } catch (e) { console.warn('[foxy] card: its name could not be kept on this phone'); }
  }

  // RENAME CARD, in the card's menu, for a card this phone set up or claimed (the wallet's `cardKnownHere`)
  fcRename() {
    const fc = this.state.fc;
    if (!fc || !fc.key) return;
    this.fcNameOpen('rename', fc.key, null, this.fcNameKept(fc.key));
  }

  /** @param {RenderContext} c */
  renderCardName(c) {
    const { s, sc } = c;
    const on = sc === 'fcName';
    const n = (on && s.fcNaming) || null;
    const ok = on && !!this.fcNameClean(s.fcNameDraft);
    return {
      isFcName: on,
      fnTitle: n && n.mode === 'rename' ? 'RENAME CARD' : 'NAME CARD',
      fnDraft: on ? String(s.fcNameDraft || '') : '',
      onFnType: (e) => this.fcNameType(e),
      fnSkipShown: !!n && n.mode === 'su',
      fnSkip: () => this.fcNameSkip(),
      fnNext: () => this.fcNameNext(),
      // NEXT, as SEND > TYPE's: the accent once there is a name, grey until then
      fnActSh: ok ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -2px 0 rgba(0,0,0,.16),0 5px 12px rgba(var(--acc-rgb),.3)' : 'none',
      fnSh: ok ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(var(--acc-rgb),.34)' : 'none',
      fnAnim: ok ? 'shineLoop 3.4s cubic-bezier(.32,0,.28,1) 3s infinite' : 'none',
      fnBg: ok ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      fnInk: ok ? CTA_INK(s) : 'rgba(var(--ink-rgb),.4)',
    };
  }

  /* ---- WELCOME TO YOUR FOXY CARD ------------------------------------------------------------------------------------------
   *
   * What a new card is met with, the one way into its set-up: its picture, SET UP CARD and CANCEL. Drawn over the
   * card's screen for a card read there that this phone can set up (`fcWelcomeCard`; a set-up this phone began for a card's holder is
   * finished by sending it money, and is not offered), and as a screen of its own, 'fcWelcome', for a new card met by SEND > FLASHCARD
   * (`fcWelcomeSend`), whose SET UP CARD sets it up for its holder with the money being sent (`fcSendSetUp`). CANCEL is HOME from the card's
   * screen, and SEND's keypad from SEND. Restoring a lost card is home's MENU's (`fcRestoreLost`). */
  fcWelcomeCard(s) {
    const fc = s && s.fc;
    return !!fc && !fc.setUp && fc.pin !== 'blocked' && !(fc.forHolder && fc.pinSet);
  }

  fcWelcomeSend(sats, unit, alt, info) {
    this.setState(p => ({ screen: 'fcWelcome', stack: p.screen === 'fcWelcome' ? p.stack : p.stack.concat([p.screen]),
                          fcWelcome: { sats, unit, alt: alt || null, info: info || null } }));
  }

  /* SET UP CARD: NAME CARD first (`fcNameOpen`), then the set-up's own steps, for this phone's card or for the holder's. */
  fcWelcomeSetUp() {
    const w = this.state.screen === 'fcWelcome' ? this.state.fcWelcome : null;
    const fc = this.state.fc;
    const key = w ? String((w.info && w.info.key) || '') : String((fc && fc.key) || '');
    this.fcNameOpen('su', key, () => {
      if (w) { this.fcSendSetUp(w.sats, w.unit, w.alt, w.info); return; }
      this.fcSetUp();
    });
  }

  fcWelcomeCancel() {
    this._fcNameSu = null;
    if (this.state.screen === 'fcWelcome') {
      this.setState(p => ({ screen: p.stack.length ? p.stack[p.stack.length - 1] : 'home', stack: p.stack.slice(0, -1), fcWelcome: null }));
      return;
    }
    this.fcGoHome();
  }

  /* ---- the welcome's card, turning -----------------------------------------------------------------------------------------
   *
   * On WELCOME TO YOUR FOXY CARD the card's picture stands on a turntable (build/markup.html, `data-card-stage="1"`): it turns slowly
   * about its upright axis by itself, a dark back with the Foxy mark coming round behind it, and a finger dragged across it turns it
   * by hand, as the card's page on the site does (half a degree a point dragged, and the turn let go of carries on and slows). While
   * it is held, and for a moment after, it does not turn by itself. Where the phone asks for less motion it never turns by itself,
   * and a finger still turns it, with nothing carried on. One loop, started when the welcome is drawn and stopped once it has not
   * been on screen for a second; the touches are heard on the document, since the screen's markup binds clicks only. */
  FC_SPIN = { auto: 24, perPx: 0.57, keep: 0.94, rest: 1600, gone: 60 };
  fcSpinOn() {
    // (a static preview, a review page, shows the card still, as such pages run no loops)
    if (this._fcSpin || typeof document === 'undefined' || typeof window === 'undefined' || (this.props && this.props.startStatic)) return;
    const doc = /** @type {any} */ (document);
    const win = /** @type {any} */ (window);
    const K = this.FC_SPIN;
    const sp = /** @type {any} */ ({ a: 0, vel: 0, drag: null, held: 0, last: Date.now(), miss: 0, stop: null });
    this._fcSpin = sp;
    const still = () => { try { return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } };
    const spinEl = () => doc.querySelector('[data-card-stage="1"] [data-card-spin]');
    const paint = () => { const el = spinEl(); if (el) el.style.transform = 'rotateY(' + sp.a.toFixed(2) + 'deg)'; };
    const onStage = (e) => !!(e && e.target && e.target.closest && e.target.closest('[data-card-stage="1"]'));
    const xOf = (e) => Number((e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX) || 0;
    // (touch events only where there are no pointer events, so that one finger is not heard twice)
    const mine = (e) => !(String(e.type).indexOf('touch') === 0 && win.PointerEvent);
    // (one finger at a time, by its pointer id where there is one: a second finger does not make the card jump)
    const idOf = (e) => (e.pointerId === undefined ? null : e.pointerId);
    const down = (e) => { if (!mine(e) || !onStage(e) || sp.drag) return; sp.drag = { x: xOf(e), id: idOf(e) }; sp.vel = 0; sp.held = Date.now(); };
    const move = (e) => {
      if (!sp.drag || !mine(e) || sp.drag.id !== idOf(e)) return;
      const x = xOf(e);
      const d = (x - sp.drag.x) * K.perPx;
      sp.drag.x = x;
      sp.a += d;
      sp.vel = d;
      sp.held = Date.now();
      paint();
      if (e.cancelable && String(e.type) === 'touchmove') e.preventDefault();
    };
    const up = (e) => { if (!sp.drag || !mine(e) || sp.drag.id !== idOf(e)) return; sp.drag = null; sp.held = Date.now(); if (still()) sp.vel = 0; };
    const kinds = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up],
                   ['touchstart', down], ['touchmove', move], ['touchend', up], ['touchcancel', up]];
    kinds.forEach(([k, f]) => doc.addEventListener(k, f, k === 'touchmove' ? { passive: false } : true));
    const next = (f) => (win.requestAnimationFrame ? win.requestAnimationFrame(f) : setTimeout(f, 16));
    const stop = () => {
      kinds.forEach(([k, f]) => doc.removeEventListener(k, f, k === 'touchmove' ? { passive: false } : true));
      if (this._fcSpin === sp) this._fcSpin = null;
    };
    sp.stop = stop;
    const tick = () => {
      if (this._fcSpin !== sp) return;
      const now = Date.now();
      const dt = Math.min(0.05, Math.max(0, (now - sp.last) / 1000));
      sp.last = now;
      if (!spinEl()) { sp.miss += 1; if (sp.miss > K.gone) { stop(); return; } next(tick); return; }
      sp.miss = 0;
      const was = sp.a;
      if (!sp.drag) {
        if (Math.abs(sp.vel) > 0.02 && !still()) { sp.a += sp.vel; sp.vel *= K.keep; }
        else { sp.vel = 0; if (!still() && now - sp.held > K.rest) sp.a += K.auto * dt; }
      }
      sp.a %= 360;
      // (painted only when it has turned: under Reduce Motion a card at rest is not drawn again every frame)
      if (sp.a !== was) paint();
      next(tick);
    };
    next(tick);
  }

  /* The bindings of the three (build/markup.html): the welcome and CARD LIMITS share one block, the card's picture between a title
   * and what can be done (`isFcPanel`); MAX PER SECOND is its own (`isFcSpeed`). And RESTORE CARD, home's RESTORE LOST CARD
   * (`isFcRestore`, 26f-flashcard.js `fcRestoreLost`): CARD LIMITS' back button and title, and a row for each card (`fcLostRows`). */
  /** @param {RenderContext} c */
  renderCardScreens(c) {
    const { s, sc } = c;
    const sendWelcome = sc === 'fcWelcome';
    const welcome = sendWelcome || (sc === 'flashcard' && this.fcWelcomeCard(s));
    const limits = sc === 'fcLimits';
    const fc = (!sendWelcome && s.fc) || null;
    const w = sendWelcome ? (s.fcWelcome || {}) : null;
    const line = w ? ((w.info && w.info.keepPin) ? 'Its set-up was cut short. The person who holds it finishes it here.'
      : 'Set it up for the person who holds it. The money goes on in the same tap.')
      : (fc && fc.pin === 'set' && !fc.hasRecord) ? 'Its set-up was cut short. Finish it to put money on it.' : '';
    const fs = sc === 'fcSpeed' ? (s.fcSpeed || null) : null;
    const r = fs ? Number(fs.r) || 0 : 0;
    // (the welcome's card turns, by itself and by hand: `fcSpinOn`)
    if (welcome) this.fcSpinOn();
    return {
      isFcPanel: welcome || limits,
      fpWelcome: welcome,
      fpLimits: limits,
      // (the picture's turntable: on the welcome only; CARD LIMITS' picture stands still)
      fpSpin: welcome ? '1' : '',
      fpPersp: welcome ? '1100px' : 'none',
      // (a new card names no design yet: it is met in the one this phone will give it, upright as on the card's screen)
      fpDesign: welcome && !(fc && fc.design) ? this.FC_SETUP_DESIGN : this.fcDesignOf(fc),
      // (the welcome's picture with more room round it, CARD LIMITS' a little wider for its rows)
      fpGap: welcome ? '40px' : '28px',
      // (the card stands upright: as tall as the welcome leaves room for, and shorter on CARD LIMITS, whose rows sit under it)
      fpCardH: welcome ? 'clamp(200px,calc(100vh - 470px),440px)' : 'clamp(160px,calc(100vh - 560px),300px)',
      fpSide: welcome ? '16px' : '20px',
      fpLine: line,
      fpLineShown: !!line,
      fpSetUp: () => this.fcWelcomeSetUp(),
      fpCancel: () => this.fcWelcomeCancel(),
      fpRows: limits ? this.fcLimitRows() : [],
      fpBack: () => this.fcLimitsLeave(),
      isFcSpeed: !!fs,
      fsFigure: String(r),
      fsChips: !fs ? [] : this.FC_SPEED_CHIPS.map((x) => ({
        label: '$' + x,
        bg: x === r ? 'var(--acc)' : 'var(--surface)',
        edge: x === r ? 'var(--acc)' : 'rgba(var(--ink-rgb),.1)',
        ink: x === r ? '#fff' : 'var(--ink)',
        tap: () => this.fcSpeedPick(x),
      })),
      fsNext: () => this.fcSpeedNext(),
      fsOther: () => this.fcSpeedOther(),
      fsBack: () => this.fcSpeedBack(),
      fsAltLabel: fs && fs.mode === 'su' ? 'SKIP' : 'NO LIMIT',
      fsAlt: () => this.fcSpeedAlt(),
      isFcRestore: sc === 'fcRestore',
      frRows: sc === 'fcRestore' ? this.fcLostRows() : [],
      frBack: () => this.back(),
    };
  }
