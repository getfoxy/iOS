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
   *                      how much (the no-PIN allowance), as LIMITS on the card's screen does
   *   MAX PER TAP        "Do you want to set a max per tap?" YES or NO; YES opens SET AMOUNT for the limit on one payment,
   *                      with the line "It will take N seconds to pay $X." under the amount as it is typed
   *
   * Both amounts are typed on the SET AMOUNT screen every amount is typed on (`fcAmount`, flows 'cardSuNoPin' and 'cardSuTap'),
   * in the card's own money: a dollar card's in dollars and nothing else; a bitcoin card's in dollars first, with the screen's
   * own swap to sats (sats alone where this phone has no price). What the card is sent is what it takes, whichever is typed:
   * cents for a dollar card, sats for a bitcoin card.
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
        onBack: () => { this._fcSu = null; },
      }, (a) => { su.pin = a; this.fcSuUnit(); });
      return;
    }
    this.fcAskPin({
      title: 'CREATE A PIN',
      subtitle: su.other
        ? 'This card is new. The person who holds it types the PIN they want, four to eight digits: it is their PIN, and the card stays theirs, not this phone’s.'
        : 'Four to eight digits. The card asks for it when it pays.',
      warn: warn || '',
      onBack: () => { this._fcSu = null; },
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

  fcSuNoPin() {
    const su = this._fcSu;
    if (!su) return;
    this.blockedCard('fc-su-nopin', {
      tone: 'ask', title: 'SMALL AMOUNTS',
      reason: 'Do you want to pay small amounts without entering your PIN?',
      retry: 'YES', go: () => this.fcSuAmount('noPin'),
      shut: { label: 'NO', pill: true, tap: () => { su.noPin = 0; su.noPinUsd = 0; this.fcSuTap(); } },
    });
  }

  fcSuTap() {
    const su = this._fcSu;
    if (!su) return;
    this.blockedCard('fc-su-tap', {
      tone: 'ask', title: 'MAX PER TAP',
      reason: 'Do you want to set a max per tap?',
      retry: 'YES', go: () => this.fcSuAmount('tap'),
      shut: { label: 'NO', pill: true, tap: () => { su.tapLimit = 0; su.tapUsd = 0; this.fcSuGo(); } },
    });
  }

  /* SET AMOUNT for one of the two (`which`: 'noPin' or 'tap'), in the card's unit, as LIMITS opens it (`fcAmount`): empty, dollars
   * first, NEXT to go on (`fcSuAmountNext`), the round back button to the question again (`fcSuAmountBack`). Whatever screen the
   * set-up was asked over (the card's own, or SEND's keypad for a card set up for somebody else) is put back as it was when the
   * amount is left either way. */
  FC_SU_FLOWS = { noPin: 'cardSuNoPin', tap: 'cardSuTap' };
  fcSuAmount(which) {
    const su = this._fcSu;
    if (!su) return;
    const s = this.state;
    if (!su.was) su.was = { screen: s.screen, stack: s.stack, flow: s.flow, amount: s.amount, unit: s.unit };
    su.ask = which;
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
  fcSuAmountNext() {
    const su = this._fcSu;
    const which = this.fcSuAsking();
    if (!su || !which) return;
    const amount = this.fcTyped();
    if (!(amount > 0)) { this.toast('Type an amount first.', true); return; }
    const usd = this.fcSuUnitNow() === 'usd' ? 0 : this.state.unit === 'USD' ? Number(this.state.amount) || 0 : 0;
    if (which === 'tap') { su.tapLimit = amount; su.tapUsd = usd; } else { su.noPin = amount; su.noPinUsd = usd; }
    this.fcSuLeave();
    if (which === 'tap') this.fcSuGo(); else this.fcSuTap();
  }

  /* The round back button on SET AMOUNT (01-ui-basics.js, `back`): its question again. True where it was the set-up's. */
  fcSuAmountBack() {
    const which = this.fcSuAsking();
    if (!which) return false;
    this.fcSuLeave();
    if (which === 'tap') this.fcSuTap(); else this.fcSuNoPin();
    return true;
  }

  /* The line under the amount on SET AMOUNT for the max per tap: "It will take N seconds to pay $X." for what is typed, in the unit
   * it is typed in; '' for the other, and before anything is typed. */
  fcSuAmountLine() {
    if (this.fcSuAsking() !== 'tap') return '';
    return this.fcWaitLine(this.fcTyped(), this.fcSuUnitNow(), this.state.unit === 'SATS' ? 'sat' : 'usd');
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
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.toast(c.unit === 'both' ? 'The card is set up. It holds dollars and bitcoin.' : c.unit === 'usd' ? 'The card is set up. It holds dollars.' : 'The card is set up.');
      }, (e) => this.fcFailed(e, { again: () => this.fcSetUpStepsRun(c) }));
  }
