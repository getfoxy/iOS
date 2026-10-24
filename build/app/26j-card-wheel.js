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
   *   SMALL AMOUNTS      "Do you want to pay small amounts without entering your PIN?" YES or NO; YES opens SET AMOUNT for
   *                      how much (the no-PIN allowance), titled NO PIN AMOUNT?
   *   SPEND PER SECOND   "Do you want to limit how much the card pays each second?" YES or NO; YES opens MAX SPEND PER SECOND
   *                      (`fcSpeedOpen`): six figures a second to choose from, and the figure itself to type another on SET AMOUNT
   *
   * The card holds one limit on a payment, L, which it pays at once, and waits about three seconds for each further L (it has no
   * clock: it counts the phone's askings). So a rate of R a second is L = 3 × R, and a card's limit is said as L / 3 a second
   * wherever it is shown (`fcSpeedText`): $5 a second is a limit of $15.
   *
   * The amounts are typed on the SET AMOUNT screen every amount is typed on (`fcAmount`, flows 'cardSuNoPin' and 'cardSuTap'),
   * in the card's own money: a dollar card's in dollars and nothing else; a bitcoin card's in dollars first, with the screen's
   * own swap to sats (sats alone where this phone has no price, which is also where the rate is typed rather than chosen). What
   * the card is sent is what it takes, whichever is typed: cents for a dollar card, sats for a bitcoin card.
   *   the tap            one tap writes all of it (`fcSetUpStepsRun`), with Keep holding on the sheet while the card holds
   *
   * The same steps set a card up for somebody else, from SEND > FLASHCARD on a new card (`fcSendSetUp`): the holder types the
   * PIN on this phone, and the words say it is theirs; what the card holds is what is being sent, so CURRENCY is not asked; and
   * the tap writes no owner and no key of this phone's, then the money under the holder's PIN.
   *
   * The way back is the round back button of the pad and of SET AMOUNT: one step back (from SET AMOUNT, to its question), and
   * from the first, to where the set-up began. A question's card goes when it is tapped beside, and the set-up with it. */

  /* What a card can hold, as the set-up's CURRENCY step offers it, in order. */
  FC_SETUP_UNITS = ['usd', 'sat'];

  /* The set-up's steps from the first. `o`: { other, unit, run, keepPin } — `other` for a card set up for somebody else (`fcSendSetUp`), `keepPin` for one of those taken up again on a card that keeps its PIN (asked once),
   * `unit` the card's where it is not asked, `run(choice)` what the tap does with { pin, unit, noPin, tapLimit, noPinUsd, tapUsd }
   * (the owner's set-up when none is given). */
  fcSetUpSteps(o) {
    this._fcSu = Object.assign({ pin: '', unit: '', noPin: 0, tapLimit: 0, noPinUsd: 0, tapUsd: 0 }, o || {});
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
      subtitle: su.other
        ? 'This card is new. The person who holds it types the PIN they want, four to eight digits: it is their PIN, and the card stays theirs, not this phone’s.'
        : 'Four to eight digits. The card asks for it when it pays.',
      warn: warn || '',
      onBack: () => { this._fcSu = null; this.fcNameAgain(); },
    }, (a) => this.fcAskPin({
      title: 'RE-ENTER PIN',
      subtitle: su.other ? 'The person who holds the card types the same PIN again.' : 'The same PIN again.',
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

  /* The two amounts are asked straight away, with no question first (the owner's rule): NO PIN AMOUNT? on SET AMOUNT, then the rate on
   * MAX SPEND PER SECOND; SKIP under NEXT on each (`fcSuSkip`) sets none. */
  fcSuNoPin() {
    if (!this._fcSu) return;
    this.fcSuAmount('noPin');
  }

  fcSuTap() {
    if (!this._fcSu) return;
    this.fcSuAmount('tap');
  }

  /* SET AMOUNT for one of the two (`which`: 'noPin' or 'tap'), in the card's unit, as LIMITS opens it (`fcAmount`): empty, dollars
   * first, NEXT to go on (`fcSuAmountNext`), SKIP for none (`fcSuSkip`), the round back button a step back (`fcSuAmountBack`).
   * Whatever screen the set-up was asked over (the card's own, or SEND's keypad for a card set up for somebody else) is put back as
   * it was when the amount is left either way. */
  FC_SU_FLOWS = { noPin: 'cardSuNoPin', tap: 'cardSuTap' };
  /* (the limit on a payment is asked as a rate on MAX SPEND PER SECOND, `fcSpeedOpen`, where the card's figures can be said in dollars; on
   * SET AMOUNT in sats otherwise, a bitcoin card with no price, and from that screen when its figure is tapped, `other`) */
  fcSuAmount(which, other) {
    const su = this._fcSu;
    if (!su) return;
    const s = this.state;
    if (!su.was) su.was = { screen: s.screen, stack: s.stack, flow: s.flow, amount: s.amount, unit: s.unit };
    su.ask = which;
    // (the rate typed: whether it was reached from MAX SPEND PER SECOND, which its back button returns to)
    su.fromSpeed = which === 'tap' && !!other;
    if (which === 'tap' && !other && this.fcSpeedChoosable(this.fcSuUnitNow())) { this.fcSpeedOpen('su', this.fcSuUnitNow(), this.FC_SPEED_FIRST); return; }
    this.fcAmount(this.FC_SU_FLOWS[which]);
  }

  // which of the two SET AMOUNT is asking for, while it is up: 'noPin', 'tap', or ''
  fcSuAsking() {
    const s = this.state;
    if (!this._fcSu || s.screen !== 'amount') return '';
    return s.flow === 'cardSuNoPin' ? 'noPin' : s.flow === 'cardSuTap' ? 'tap' : '';
  }

  // off SET AMOUNT, to the screen the set-up was asked over
  fcSuLeave() {
    const su = this._fcSu;
    const was = su && su.was;
    if (su) su.was = null;
    if (was) this.setState({ screen: was.screen, stack: was.stack, flow: was.flow, amount: was.amount, unit: was.unit });
  }

  /* NEXT: the figure in the card's unit (`fcTyped`: cents for a dollar card, sats for a bitcoin card) and, for a bitcoin card typed in
   * dollars, those dollars (as LIMITS keeps them, `fcAmountNext`); then the next step. Nothing typed is refused, as LIMITS refuses it. */
  /* (the limit on a payment is typed as a rate, so what the card is sent is three seconds of it: FC_SPEED_SECS) */
  fcSuAmountNext() {
    const su = this._fcSu;
    const which = this.fcSuAsking();
    if (!su || !which) return;
    const amount = this.fcTyped();
    if (!(amount > 0)) { this.toast('Type an amount first.', true); return; }
    const usd = this.fcSuUnitNow() === 'usd' ? 0 : this.state.unit === 'USD' ? Number(this.state.amount) || 0 : 0;
    const k = this.FC_SPEED_SECS;
    if (which === 'tap') { su.tapLimit = amount * k; su.tapUsd = usd * k; } else { su.noPin = amount; su.noPinUsd = usd; }
    this.fcSuLeave();
    if (which === 'tap') this.fcSuGo(); else this.fcSuTap();
  }

  /* SKIP under NEXT: none of it. No allowance without the PIN, and on to the rate; no limit on a payment, and on to the tap. */
  fcSuSkip(which) {
    const su = this._fcSu;
    const w = which || this.fcSuAsking();
    if (!su || !w) return;
    this.fcSuLeave();
    if (w === 'tap') { su.tapLimit = 0; su.tapUsd = 0; this.fcSuGo(); } else { su.noPin = 0; su.noPinUsd = 0; this.fcSuTap(); }
  }

  /* The round back button on SET AMOUNT (01-ui-basics.js, `back`), a step back: off NO PIN AMOUNT?, out of the set-up to the screen it
   * was asked over, with nothing written; off the rate typed, MAX SPEND PER SECOND where it came from there, NO PIN AMOUNT? otherwise.
   * True where it was the set-up's. */
  /* (and on MAX SPEND PER SECOND, while the set-up asks it: NO PIN AMOUNT?, `fcSpeedBack`) */
  fcSuAmountBack() {
    if (this._fcSu && this.state.screen === 'fcSpeed' && this.state.fcSpeed && this.state.fcSpeed.mode === 'su') { this.fcSpeedBack(); return true; }
    const which = this.fcSuAsking();
    if (!which) return false;
    const su = this._fcSu;
    if (which === 'noPin') { this.fcSuLeave(); this._fcSu = null; return true; }
    if (su.fromSpeed && this.state.fcSpeed && this.state.fcSpeed.mode === 'su') {
      // (SET AMOUNT was opened over MAX SPEND PER SECOND, `fcAmount`: off it, back to that screen, at the rate it showed)
      su.fromSpeed = false;
      this.setState(p => ({ screen: 'fcSpeed', stack: p.stack.slice(0, -1),
                            flow: su.was ? su.was.flow : p.flow, amount: su.was ? su.was.amount : p.amount, unit: su.was ? su.was.unit : p.unit }));
      return true;
    }
    this.fcSuLeave();
    this.fcSuNoPin();
    return true;
  }

  /* The line under the amount on SET AMOUNT for the rate: "It will take N seconds to pay $X." for the limit it makes (three seconds of
   * what is typed), in the unit it is typed in; '' for the other, and before anything is typed. */
  fcSuAmountLine() {
    if (this.fcSuAsking() !== 'tap') return '';
    return this.fcWaitLine(this.fcTyped() * this.FC_SPEED_SECS, this.fcSuUnitNow(), this.state.unit === 'SATS' ? 'sat' : 'usd');
  }

  /* "It will take 13 seconds to pay $40.00.": what a payment of four limits' worth waits, by the app's own seconds (`fcWaitSecs`)
   * for the askings of the card's software (`fcWaitOver`, `fcWaitMore`): the first limit's worth over, and two more after it. A
   * round figure above the limit, so that the line says something. In the unit the figure was chosen in (`as`): "₿ 40,000" for a
   * bitcoin card's limit chosen in sats. */
  FC_WAIT_EXAMPLE = 4;
  fcWaitLine(limit, unit, as) {
    if (!(limit > 0)) return '';
    const units = this.FC_WAIT_EXAMPLE;
    const askings = this.fcWaitOver() + this.fcWaitMore() * (units - 2);
    const pay = (unit !== 'usd' && as === 'sat') ? '₿ ' + this.group(Math.round(limit * units)) : this.fcPrice(limit * units, unit);
    return 'It will take ' + this.fcWaitSecs(askings) + ' seconds to pay ' + pay + '.';
  }

  // the end of the questions: the tap
  fcSuGo() {
    const su = this._fcSu;
    if (!su) return;
    this._fcSu = null;
    const choice = { pin: su.pin, unit: su.unit, noPin: su.noPin, tapLimit: su.tapLimit, noPinUsd: su.noPinUsd, tapUsd: su.tapUsd };
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
    this.fcTap({}, (link, on) => { on('writing'); how.onHold = () => on('writing'); return W.cardSetUp(link, how); })
      .then((card) => {
        this.fcNameSettle(card && card.key);
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.toast(c.unit === 'both' ? 'The card is set up. It holds dollars and bitcoin.' : c.unit === 'usd' ? 'The card is set up. It holds dollars.' : 'The card is set up.');
      }, (e) => this.fcFailed(e, { again: () => this.fcSetUpStepsRun(c) }));
  }

  /* ---- MAX SPEND PER SECOND -------------------------------------------------------------------------------------------
   *
   * The limit on a payment, asked as how fast the card pays (the owner's design): the figure a second, big, six of them to choose
   * from, and why a card has a limit. A rate R is the limit L = FC_SPEED_SECS × R (the card pays L at once and waits about three
   * seconds for each further L), sent to the card as every limit is: cents for a dollar card; sats for a bitcoin card, at this
   * phone's price, with the dollars kept so that this phone sets the card again when the price has moved. Asked by the set-up
   * (`mode` 'su', `fcSuAmount`) and by CARD LIMITS (`mode` 'limit', `fcLimitAmount`) for a card that waits for its limit (`paced`);
   * a figure that is none of the six is typed on SET AMOUNT, by tapping the figure (`fcSpeedOther`), where it is a figure a second
   * too. A bitcoin card with no price has nothing to say dollars at, and is asked on SET AMOUNT in sats straight away. */
  FC_SPEED_CHIPS = [1, 2, 5, 10, 25, 50];
  FC_SPEED_SECS = 3;
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

  // its round back button: the set-up's NO PIN AMOUNT? again, or the card's screen
  fcSpeedBack() {
    const fs = this.state.fcSpeed;
    if (fs && fs.mode === 'su' && this._fcSu) { this.fcSuLeave(); this.fcSuNoPin(); return; }
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
    if (this._fcLimitTap && this.fcPacedNow() && this.fcSpeedChoosable(this.fcLimitUnit())) {
      const fc = this.state.fc;
      const now = (fc.tap && fc.tap.limited) ? this.fcSpeedChip(this.fcSpeedDollars(fc.tap.limit, this.fcLimitKeptUnit(fc), this.fcKeptUsd(fc))) : 0;
      this.fcSpeedOpen('limit', this.fcLimitUnit(), now || this.FC_SPEED_FIRST);
      return;
    }
    this.fcAmount('cardLimit');
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
    if (which === 'nopin') this.fcLimitAsk((sats, usd) => this.fcLimitRun(sats, 'nopin', usd), 'nopin');
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

  /* ---- WELCOME TO YOUR CASHU CARD ------------------------------------------------------------------------------------------
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

  /* The bindings of the three (build/markup.html): the welcome and CARD LIMITS share one block, the card's picture between a title
   * and what can be done (`isFcPanel`); MAX SPEND PER SECOND is its own (`isFcSpeed`). */
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
    return {
      isFcPanel: welcome || limits,
      fpWelcome: welcome,
      fpLimits: limits,
      fpDesign: this.fcDesignOf(fc),
      // (the welcome's picture with more room round it, CARD LIMITS' a little wider for its rows)
      fpGap: welcome ? '40px' : '28px',
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
    };
  }
